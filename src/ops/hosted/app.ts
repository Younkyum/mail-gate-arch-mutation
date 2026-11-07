/**
 * src/ops/hosted/app.ts — `ops.atmark.ai` 의 라우터(`.omc/plans/ops-console.md` §3.4~§3.7 · P1).
 *
 *   GET  /                          정적 페이지(해시 CSP · trusted types · 데이터 없음)
 *   POST /api/auth/request          {email}         → 항상 202(열거 방지). 논스 쿠키 · login-mailer 깨우기
 *   POST /api/auth/verify           {code}          → 로그인이면 세션 쿠키 + CSRF, 접근 요청이면 결과 한 단어, 틀리면 401 `code_invalid`
 *   POST /api/auth/step-up          {action, org|operator} → {targetRef}  (코드는 메일로)
 *   POST /api/auth/step-up/verify   {code}          → {action, targetRef}
 *   POST /api/auth/logout           {all?}
 *   GET  /api/session · /api/dashboard · /api/board(주간 운영판, 202610010900) · /api/review · /api/orgs · /api/orgs/:id · /api/audit · /api/catalog · /api/operators
 *   POST /api/orgs/:id/review       {decision: activate|reject, confirm, ack?}
 *   POST /api/operators/:id/decision {decision: approve|deny, confirm}
 *   POST /api/operators/:id/revoke  {confirm}
 *   GET  /api/waitlist?status=      대기자 명단(202609301520)
 *   POST /api/waitlist/:id/invite · /api/waitlist/:id/remove {confirm: 주소} · POST /api/waitlist/invite-oldest {n, confirm: n}
 *
 * 순서: Host(421) → 경로 정규형(아니면 404 — 인증 라우트 스로틀을 `//`·끝 `/` 로 우회하지 못하게) → 출처 → (세션 뒤 변경이면) CSRF →
 *   **`ops_session_touch`(첫 DB 문장)** → 확인 입력(틀리면 definer 호출 0 · 422) → definer.
 * CSRF 헤더는 **세션 뒤 변경 요청만** 본다. 세션 전 두 경로(`/api/auth/request` · `/api/auth/verify`)는 CSRF 헤더가 없다 — 정확한 `Origin` 과
 * 논스 쿠키(`__Host-` · SameSite=Strict · 결속 HMAC)가 막는다. 로그아웃은 CSRF 를 보되 touch 없이 definer 가 해시로 판정한다(닫혀 있어도 된다).
 * P1 에는 요금제 · 동결 · 정지 쓰기가 없다(라우트 자체가 없다). step-up 은 DB 가 집행한다 — 없으면 definer 가 403 `step_up_required`.
 * 로그에는 식별자 · 주소 · IP 를 싣지 않는다(N6). 메트릭 차원은 닫힌 유니온(`src/ops/metrics.ts`).
 */

import type { Pool } from 'pg';

import { ORGANIZATION_ID_PATTERN } from '../../admin/ops/agents';
import { AdminInputError } from '../../admin/ops/errors';
import { log } from '../../observability/logger';
import { OPS_ACTIONS, OPS_COOKIES, OPS_LIMITS, OPS_ROUTES, OPS_STEP_UP, type OpsAction } from '../contract';
import { buildOpsPage, HOSTED_PAGE_CONFIG, type OpsPage } from '../console/page';
import { requireAddressConfirmation, requireConfirmation, requireInviteCount, requireWaitlistEntryId } from '../console/reads';
import { countOpsMetric, OPS_METRIC_NAMES, OPS_WRITE_FAILURE_CODES, type OpsWriteFailureCode } from '../metrics';
import {
  loginVerify,
  mapDbError,
  OpsBackend,
  OpsError,
  requestCode,
  revokeSession,
  touchSession,
  type VerifiedSession,
} from './backend';
import {
  checkHost,
  checkOrigin,
  clearLoginCookie,
  clearSessionCookie,
  csrfHeader,
  errorResult,
  header,
  htmlResult,
  jsonResult,
  loginCookie,
  parseCookies,
  readJsonBody,
  sessionCookie,
  textResult,
  type OpsHttpEvent,
  type OpsHttpResult,
} from './http';
import { randomToken, sessionHash, TOKEN_PATTERN, type OpsKeys } from './keys';

export interface HostedDeps {
  /** `atmark_ops` 풀(λ 당 `OPS_POOL_MAX`). */
  readonly pool: Pool;
  readonly keys: OpsKeys;
  /** login-mailer 깨우기(비동기 · 실패는 삼킨다 — 다음 틱이 보낸다). */
  readonly kickMailer: () => Promise<void>;
  readonly now: () => Date;
}

let cachedPage: OpsPage | undefined;
function page(): OpsPage {
  cachedPage ??= buildOpsPage(HOSTED_PAGE_CONFIG);
  return cachedPage;
}

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,60}$/;
const CODE_PATTERN = /^\d{6}$/;
const UUID_PATTERN = ORGANIZATION_ID_PATTERN;

const SESSION_MAX_AGE = OPS_LIMITS.sessionAbsoluteH * 60 * 60;
const LOGIN_MAX_AGE = OPS_LIMITS.challengeTtlMin * 60;

/** 요청 처리 중 쌓이는 Set-Cookie. */
type Cookies = string[];

function failure(error: unknown, cookies: Cookies = []): OpsHttpResult {
  if (error instanceof AdminInputError) return errorResult(error.status, error.code, error.message, cookies);
  const mapped = mapDbError(error);
  if (mapped.code === 'session_invalid') cookies.push(clearSessionCookie());
  if (mapped.status >= 500) {
    log('warn', 'ops.request_failed', { route_id: 'ops', error_code: mapped.code, http_status: mapped.status, error_kind: error instanceof Error ? error.name : typeof error });
  }
  return errorResult(mapped.status, mapped.code, mapped.message, cookies);
}

function writeFailureCode(code: string): OpsWriteFailureCode {
  return (OPS_WRITE_FAILURE_CODES as readonly string[]).includes(code) ? (code as OpsWriteFailureCode) : 'internal';
}

/** 쓰기 실패 메트릭(차원은 닫힌 코드). step-up 이 없어 막힌 것은 따로 센다. */
function countWriteFailure(error: unknown): void {
  if (!(error instanceof OpsError)) return;
  countOpsMetric(OPS_METRIC_NAMES.writeFailed, { code: writeFailureCode(error.code) });
  if (error.code === 'step_up_required') countOpsMetric(OPS_METRIC_NAMES.stepUpRequired);
}

/**
 * 요청자 IP(API Gateway `sourceIp` — 헤더는 믿지 않는다). 없거나 비면 `null` — `/api/` 요청은 503 `client_ip_unavailable` 로 닫는다(재확인 I-3):
 * `'unknown'` 한 값으로 모든 요청자의 상한·실패 기록(`clientKey`)을 한 버킷에 몰지 않는다.
 */
function clientIpOf(event: OpsHttpEvent): string | null {
  const ip = event.requestContext.http.sourceIp?.trim() ?? '';
  return ip === '' ? null : ip;
}

function userAgent(event: OpsHttpEvent): string {
  return header(event, 'user-agent') ?? event.requestContext.http.userAgent ?? '';
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value.trim() : '';
}

function langOf(body: Record<string, unknown>, event: OpsHttpEvent): 'ko' | 'en' {
  const asked = body['lang'];
  if (asked === 'en' || asked === 'ko') return asked;
  return /^en\b/i.test(header(event, 'accept-language') ?? '') ? 'en' : 'ko';
}

// ---------------------------------------------------------------------------
// 세션 전
// ---------------------------------------------------------------------------

/** 로그인 · step-up 코드가 틀렸다(모양 · 만료 · 불일치를 가르지 않는다). */
function codeInvalid(): OpsHttpResult {
  countOpsMetric(OPS_METRIC_NAMES.codeInvalid);
  return errorResult(401, 'code_invalid', '코드가 맞지 않거나 만료됐습니다. 코드를 다시 받으세요.');
}

async function authRequest(deps: HostedDeps, event: OpsHttpEvent, ip: string, body: Record<string, unknown>, cookies: Record<string, string>): Promise<OpsHttpResult> {
  const email = stringField(body, 'email').toLowerCase().normalize('NFC');
  const existing = cookies[OPS_COOKIES.login];
  const nonce = existing !== undefined && TOKEN_PATTERN.test(existing) ? existing : randomToken();
  const set = [loginCookie(nonce, LOGIN_MAX_AGE)];
  // 모양이 틀린 주소도 같은 202 — 응답으로 무엇도 가르지 않는다. DB 에는 보내지 않는다.
  if (email.length <= 254 && EMAIL_PATTERN.test(email)) {
    try {
      await requestCode(deps.pool, { email, binding: deps.keys.binding(nonce), clientKey: deps.keys.clientKey(ip), lang: langOf(body, event) });
    } catch (error) {
      const mapped = mapDbError(error);
      if (mapped.code === 'rate_limited') countOpsMetric(OPS_METRIC_NAMES.codeRateLimited);
      return failure(mapped, set);
    }
    countOpsMetric(OPS_METRIC_NAMES.codeRequested);
    await deps.kickMailer();
  }
  return jsonResult(202, { sent: true }, set);
}

async function authVerify(deps: HostedDeps, event: OpsHttpEvent, ip: string, body: Record<string, unknown>, cookies: Record<string, string>): Promise<OpsHttpResult> {
  const code = stringField(body, 'code');
  const nonce = cookies[OPS_COOKIES.login];
  if (nonce === undefined || !TOKEN_PATTERN.test(nonce) || !CODE_PATTERN.test(code)) return codeInvalid();
  const token = randomToken();
  let outcome;
  try {
    outcome = await loginVerify(deps.pool, {
      binding: deps.keys.binding(nonce),
      clientKey: deps.keys.clientKey(ip),
      code,
      sessionHash: sessionHash(token),
      uaHash: deps.keys.uaHash(userAgent(event)),
    });
  } catch (error) {
    return failure(error);
  }
  if (outcome === 'invalid') return codeInvalid();
  if (outcome === 'session') {
    countOpsMetric(OPS_METRIC_NAMES.loginOk);
    return jsonResult(200, { outcome, csrf: deps.keys.csrf(token) }, [sessionCookie(token, SESSION_MAX_AGE), clearLoginCookie()]);
  }
  // 접근 요청 — 알람 #29 는 새로 requested 가 됐을 때만 센다(I-9).
  if (outcome === 'requested') countOpsMetric(OPS_METRIC_NAMES.accessRequested);
  return jsonResult(200, { outcome }, [clearLoginCookie()]);
}

// ---------------------------------------------------------------------------
// 세션 뒤
// ---------------------------------------------------------------------------

function requireOrgId(raw: string | undefined): string {
  if (raw === undefined || !UUID_PATTERN.test(raw)) throw new AdminInputError('조직 id 형식이 맞지 않습니다.', 'invalid_organization');
  return raw.toLowerCase();
}

function requireOperatorId(raw: string | undefined): string {
  if (raw === undefined || !UUID_PATTERN.test(raw)) throw new AdminInputError('운영자 id 형식이 맞지 않습니다.', 'invalid_operator');
  return raw.toLowerCase();
}

async function orgReview(backend: OpsBackend, id: string | undefined, body: Record<string, unknown>): Promise<OpsHttpResult> {
  const org = requireOrgId(id);
  const decision = body['decision'];
  if (decision !== 'activate' && decision !== 'reject') throw new AdminInputError('decision 은 activate 또는 reject 입니다.', 'invalid_decision');
  requireConfirmation(body, await backend.confirmOrganization(org), decision === 'reject' ? 'irreversible' : 'name');
  const action: OpsAction = decision === 'activate' ? 'org.activate' : 'org.reject';
  try {
    const outcome = decision === 'activate' ? await backend.activate(org) : await backend.reject(org);
    countOpsMetric(OPS_METRIC_NAMES.privilegedAction, { action });
    return jsonResult(200, { outcome });
  } catch (error) {
    countWriteFailure(error);
    throw error;
  }
}

/**
 * 대기자 명단 쓰기(202609301520) — 확인 입력 = 대상 주소(한 항목) · 초대할 수(N 명). 틀리면 422(정의 함수를 부르지 않는다). step-up 없음(초대는 받은 사람이
 * 가입해야 효과가 있고 · 지운 사람은 다시 등록할 수 있다). 성공은 특권 행위 메트릭(`privileged_action{action=waitlist.*}` — 알람 #33 의 메트릭)으로, 실패는
 * `write_failed` + `ops_record_failure`(행위 칸 = `waitlist.*`)로 센다. 감사 원장은 `waitlist_events`.
 */
async function waitlistWrite(backend: OpsBackend, id: string | undefined, sub: string | undefined, body: Record<string, unknown>): Promise<OpsHttpResult> {
  try {
    if (id === 'invite-oldest' && sub === undefined) {
      const invited = await backend.waitlistInviteOldest(requireInviteCount(body));
      countOpsMetric(OPS_METRIC_NAMES.privilegedAction, { action: 'waitlist.invite_oldest' });
      return jsonResult(200, { waitlist: { invited } });
    }
    if (id !== undefined && (sub === 'invite' || sub === 'remove')) {
      const entry = requireWaitlistEntryId(id);
      requireAddressConfirmation(body, await backend.waitlistEntryEmail(entry));
      const waitlist = sub === 'invite' ? await backend.waitlistInvite(entry) : await backend.waitlistRemove(entry);
      countOpsMetric(OPS_METRIC_NAMES.privilegedAction, { action: sub === 'invite' ? 'waitlist.invite' : 'waitlist.remove' });
      return jsonResult(200, { waitlist });
    }
  } catch (error) {
    countWriteFailure(error);
    throw error;
  }
  return errorResult(404, 'not_found', '없는 경로입니다.');
}

async function operatorWrite(backend: OpsBackend, id: string | undefined, sub: 'decision' | 'revoke', body: Record<string, unknown>): Promise<OpsHttpResult> {
  const target = requireOperatorId(id);
  let decision: 'approve' | 'deny' | null = null;
  if (sub === 'decision') {
    const raw = body['decision'];
    if (raw !== 'approve' && raw !== 'deny') throw new AdminInputError('decision 은 approve 또는 deny 입니다.', 'invalid_decision');
    decision = raw;
  }
  const row = await backend.operator(target);
  if (row === null) throw new AdminInputError('운영자를 찾을 수 없습니다.', 'operator_not_found', 404);
  requireAddressConfirmation(body, row.email);
  try {
    const result = decision === null ? await backend.revokeOperator(target) : await backend.decideOperator(target, decision);
    countOpsMetric(decision === null ? OPS_METRIC_NAMES.operatorRevoked : OPS_METRIC_NAMES.operatorDecided);
    return jsonResult(200, { operatorId: target, result });
  } catch (error) {
    countWriteFailure(error);
    throw error;
  }
}

async function stepUp(deps: HostedDeps, backend: OpsBackend, body: Record<string, unknown>): Promise<OpsHttpResult> {
  const action = body['action'];
  if (typeof action !== 'string' || !(OPS_ACTIONS as readonly string[]).includes(action) || OPS_STEP_UP[action as OpsAction] === 'none') {
    throw new AdminInputError('본인 확인 대상이 아닌 작업입니다.', 'invalid_action');
  }
  const kind = action as OpsAction;
  const org = kind.startsWith('org.') ? requireOrgId(stringField(body, 'org')) : null;
  const operator = kind.startsWith('operator.') ? requireOperatorId(stringField(body, 'operator')) : null;
  const targetRef = await backend.requestStepUp(kind, org, operator);
  await deps.kickMailer();
  return jsonResult(200, { action: kind, targetRef });
}

async function stepUpVerify(backend: OpsBackend, body: Record<string, unknown>): Promise<OpsHttpResult> {
  const code = stringField(body, 'code');
  if (!CODE_PATTERN.test(code)) return codeInvalid();
  const result = await backend.verifyStepUp(code);
  if (result.outcome !== 'ok') return codeInvalid();
  return jsonResult(200, { action: result.action, targetRef: result.targetRef });
}

async function sessionInfo(deps: HostedDeps, backend: OpsBackend, token: string): Promise<OpsHttpResult> {
  const pending = await backend.pendingOperators();
  const s = backend.session;
  return jsonResult(200, {
    email: s.email,
    operatorId: s.operatorId,
    expiresAt: s.expiresAt.toISOString(),
    csrf: deps.keys.csrf(token),
    pendingOperators: pending,
    idleMinutes: OPS_LIMITS.sessionIdleMin,
    maxHours: OPS_LIMITS.sessionAbsoluteH,
  });
}

async function authed(
  deps: HostedDeps,
  event: OpsHttpEvent,
  ip: string,
  method: string,
  parts: readonly string[],
  body: Record<string, unknown> | null,
  cookies: Record<string, string>,
): Promise<OpsHttpResult> {
  const token = cookies[OPS_COOKIES.session];
  if (token === undefined || !TOKEN_PATTERN.test(token)) return errorResult(401, 'session_invalid', '다시 로그인하세요.', token === undefined ? [] : [clearSessionCookie()]);
  const mutation = method === 'POST';
  if (mutation && !deps.keys.csrfMatches(token, csrfHeader(event))) return errorResult(403, 'csrf_mismatch', '다시 로그인하세요.');
  if (mutation && body === null) return errorResult(400, 'invalid_body', '요청 형식이 맞지 않습니다.');
  const hash = sessionHash(token);
  const clientKey = deps.keys.clientKey(ip);
  const [head, id, sub] = parts;

  // 로그아웃은 콘솔이 닫혀 있어도 된다 — touch(닫혀 있으면 503) 없이 definer 가 해시로 판정한다.
  if (mutation && head === 'auth' && id === 'logout' && sub === undefined) {
    const n = await revokeSession(deps.pool, hash, body?.['all'] === true);
    if (n > 0) countOpsMetric(OPS_METRIC_NAMES.sessionRevoked, { reason: body?.['all'] === true ? 'logout_all' : 'logout' });
    return jsonResult(200, { revoked: n }, [clearSessionCookie()]);
  }

  // ★ 첫 DB 문장.
  const session: VerifiedSession | null = await touchSession(deps.pool, { sessionHash: hash, uaHash: deps.keys.uaHash(userAgent(event)), clientKey });
  if (session === null) return errorResult(401, 'session_invalid', '다시 로그인하세요.', [clearSessionCookie()]);
  const backend = OpsBackend.of(deps.pool, session);
  const now = deps.now();
  const query = new URLSearchParams(event.rawQueryString ?? '');

  if (method === 'GET') {
    if (head === 'session' && id === undefined) return sessionInfo(deps, backend, token);
    if (head === 'dashboard' && id === undefined) return toJson(await backend.dashboard(now));
    if (head === 'board' && id === undefined) return toJson(await backend.board(now));
    if (head === 'review' && id === undefined) return toJson(await backend.reviewQueue());
    if (head === 'catalog' && id === undefined) return toJson(backend.catalog());
    if (head === 'audit' && id === undefined) return toJson(await backend.audit(query));
    if (head === 'orgs' && id === undefined) return toJson(await backend.organizations(query, now));
    if (head === 'orgs' && id !== undefined && sub === undefined) return toJson(await backend.organization(requireOrgId(id), now));
    if (head === 'operators' && id === undefined) return jsonResult(200, await backend.operators());
    if (head === 'waitlist' && id === undefined) return toJson(await backend.waitlist(query, now));
    return errorResult(404, 'not_found', '없는 경로입니다.');
  }
  const b = body ?? {};
  if (head === 'auth' && id === 'step-up' && sub === undefined) return stepUp(deps, backend, b);
  if (head === 'auth' && id === 'step-up' && sub === 'verify') return stepUpVerify(backend, b);
  if (head === 'orgs' && sub === 'review' && parts.length === 3) return orgReview(backend, id, b);
  if (head === 'operators' && (sub === 'decision' || sub === 'revoke') && parts.length === 3) return operatorWrite(backend, id, sub, b);
  if (head === 'waitlist' && parts.length <= 3) return waitlistWrite(backend, id, sub, b);
  return errorResult(404, 'not_found', '없는 경로입니다.');
}

function toJson(result: { readonly status: number; readonly body: unknown }): OpsHttpResult {
  return jsonResult(result.status, result.body);
}

/** 한 요청. 예외는 여기서 응답이 된다(λ 는 던지지 않는다). */
export async function handleOpsRequest(deps: HostedDeps, event: OpsHttpEvent): Promise<OpsHttpResult> {
  const host = checkHost(event);
  if (!host.ok) return textResult(host.status, host.code);
  const method = event.requestContext.http.method.toUpperCase();
  const path = event.rawPath;
  // 정규형만 받는다(SEC-Info2) — `/api//auth/request` · `/api/auth/request/` 같은 모양은 스로틀 버킷이 다른 `$default` 로 가므로 404.
  if (path !== `/${path.split('/').filter((part) => part !== '').join('/')}`) return path.startsWith('/api/') ? errorResult(404, 'not_found', '없는 경로입니다.') : textResult(404, 'not_found');
  const navigation = method === 'GET' && path === '/';
  const origin = checkOrigin(event, navigation);
  if (!origin.ok) return path.startsWith('/api/') ? errorResult(origin.status, origin.code, '허용하지 않는 출처입니다.') : textResult(origin.status, origin.code);

  if (navigation) {
    const built = page();
    return htmlResult(built.html, built.csp);
  }
  if (!path.startsWith('/api/')) return textResult(404, 'not_found');
  if (method !== 'GET' && method !== 'POST') return errorResult(405, 'method_not_allowed', '허용하지 않는 메서드입니다.');

  // 모든 API 는 요청자 키(상한 · 실패 기록 · 세션 touch)를 쓴다 — IP 가 없으면 DB 전에 닫는다(값 없이 오류 로그 한 줄).
  const ip = clientIpOf(event);
  if (ip === null) {
    log('error', 'ops.client_ip_missing', { route_id: 'ops', error_code: 'client_ip_unavailable' });
    return errorResult(503, 'client_ip_unavailable', '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.');
  }
  const cookies = parseCookies(event);
  const body = method === 'POST' ? readJsonBody(event) : null;
  try {
    if (method === 'POST' && path === OPS_ROUTES.request) {
      return body === null ? errorResult(400, 'invalid_body', '요청 형식이 맞지 않습니다.') : await authRequest(deps, event, ip, body, cookies);
    }
    if (method === 'POST' && path === OPS_ROUTES.verify) {
      return body === null ? errorResult(400, 'invalid_body', '요청 형식이 맞지 않습니다.') : await authVerify(deps, event, ip, body, cookies);
    }
    const parts = path.split('/').filter((part) => part !== '').slice(1);
    return await authed(deps, event, ip, method, parts, body, cookies);
  } catch (error) {
    return failure(error);
  }
}

/** 조립이 안 된 상태(비밀 자리표시 · 표 없음) — Host 검문 뒤 모든 요청에 503. */
export function unavailableResult(event: OpsHttpEvent): OpsHttpResult {
  const host = checkHost(event);
  if (!host.ok) return textResult(host.status, host.code);
  return event.rawPath.startsWith('/api/') ? errorResult(503, 'ops_unavailable', '운영 콘솔을 지금 쓸 수 없습니다. 잠시 뒤 다시 시도하세요.') : textResult(503, 'ops_unavailable');
}
