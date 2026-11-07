/**
 * src/admin/routes/session.ts — 소유자 로그인·세션 (계약: `POST /api/login` · `login/verify` · `logout` · `GET me`).
 *
 * **이 파일은 메일을 보내지 않는다.** 로그인 요청은 `owner_login_links` 에 행을 적을 뿐이고(`admin/session.ts`), 메일은
 * 전용 Lambda `atmark-login-mailer` 의 로그인 워커가 보낸다(ADR-0006). 커밋 뒤 그 Lambda 를 깨울 뿐이다(`kickLoginMailer`). 이 파일이 알림기·관문·전송단을 import 하는 날은 admin
 * Lambda(콘솔 입구)가 발송 주체가 된 날이다 — Layer C(`NON_SENDING_ENTRYPOINTS`)와 `admin-separation` arch 테스트가 막는다.
 */

import { audited, bodyField, clientIpUnavailable, kickLoginMailer, logSecurityEvent, objectBody, sessionOf, type AdminCall } from '../context';
import { displayName } from '../display';
import { planSummaryOp } from '../ops/plan';
import {
  clearLoginBrowserCookie,
  clearSessionCookie,
  errorResponse,
  jsonResponse,
  langCookie,
  LOGIN_BROWSER_COOKIE,
  loginBrowserCookie,
  sessionCookie,
  SITE_ORIGIN,
  type AdminResponse,
} from '../http';
import { SUPPORTED_MAIL_LOCALES } from '../../i18n/locales';
import { isLang } from '../ui/i18n';
import {
  createMemberOrganization,
  csrfTokenOf,
  LOGIN_BROWSER_TTL_MS,
  mailLocaleOf,
  membershipsOf,
  organizationOf,
  requestLogin,
  revokeAllSessions,
  revokeSession,
  SESSION_TTL_MS,
  setMailLocale,
  switchOrganization,
  userEmailOf,
  verifyLogin,
  type MembershipView,
  type SwitchOutcome,
} from '../session';

/**
 * 폼의 화면 언어(`lang: 'ko'|'en'`, 선택) → 콘솔 언어 쿠키. 홈(atmark.ai)의 영어 폼으로 요청한 사람이 메일 링크로 콘솔 착지에
 * 오면 영어 화면을 보게 한다(US-003 — 콘솔 호스트의 쿠키는 홈이 직접 적을 수 없다). 주소와 무관한 입력이라 열거와 무관하다.
 */
export function formLangCookies(body: unknown): string[] {
  const lang = bodyField(body, 'lang');
  return isLang(lang) ? [langCookie(lang)] : [];
}

/** `POST /api/login {email, lang?}` → **항상** 202 `{ok:true}`(요청자 상한만 429 — 주소와 무관). */
export async function handleLoginRequest(call: AdminCall): Promise<AdminResponse> {
  const sourceIp = call.request.sourceIp;
  if (sourceIp === null) return clientIpUnavailable(call.request);
  const outcome = await requestLogin(call.deps.pool, call.deps.loginKeys, {
    email: bodyField(call.request.body, 'email'),
    sourceIp,
    browserNonce: call.request.cookies[LOGIN_BROWSER_COOKIE],
  });
  if (outcome.kind === 'rate_limited') {
    return errorResponse(429, 'rate_limited', '로그인 요청이 너무 잦다 — 잠시 뒤 다시 시도하라.');
  }
  // 커밋 뒤 · 일치 여부와 무관하게(열거 방지 — `kickLoginMailer`).
  await kickLoginMailer(call.deps);
  return jsonResponse(202, { ok: true }, [loginBrowserCookie(outcome.nonce, LOGIN_BROWSER_TTL_MS / 1000), ...formLangCookies(call.request.body)]);
}

/**
 * `POST /api/login/verify {code}`(메일의 6자리) → 200 + 세션 쿠키 + `{csrf, next}` / 401 `login_code_invalid`(틀림·만료·5회 초과·없는 주소를
 * 가리지 않는다). 옛 메일 링크의 `{token}` 만 오면 410 `login_link_retired`(2026-10-10 링크 로그인 삭제 — 토큰을 보지 않는다).
 * 논스 쿠키가 **아예 없는** 브라우저만 `login_browser_missing` 으로 따로 말한다 — 요청한 쪽이 이미 아는 사실이고, 코드·DB 를
 * 보기 전에 내린 판단이라 아무것도 새지 않는다(`admin/session.ts`). 틀린 코드가 IP 당 시간당 30회(`security/login-limits.ts`)면 그 IP 의 코드 verify 는
 * 429 `rate_limited`(주소와 무관 — 다른 IP 의 실패는 세지 않는다). 홈(atmark.ai)의 로그인 화면도 코드를 여기로 보낸다(교차 출처 —
 * `CROSS_SITE_AUTH_PATHS`).
 */
export async function handleLoginVerify(call: AdminCall): Promise<AdminResponse> {
  const sourceIp = call.request.sourceIp;
  if (sourceIp === null) return clientIpUnavailable(call.request);
  const outcome = await verifyLogin(call.deps.pool, call.deps.loginKeys, {
    token: bodyField(call.request.body, 'token'),
    code: bodyField(call.request.body, 'code'),
    browserNonce: call.request.cookies[LOGIN_BROWSER_COOKIE],
    sourceIp,
    now: call.deps.now(),
  });
  if (outcome.kind === 'link_retired') {
    logSecurityEvent('login_link_retired', call.request.path, call.request.requestId, null);
    return errorResponse(410, 'login_link_retired', '로그인 링크는 더 쓰지 않는다 — 로그인을 요청하고 메일의 6자리 코드를 입력하라.');
  }
  if (outcome.kind === 'rate_limited') {
    // IP 당 틀린 코드 상한(시간당 30회, `login_code_attempts`) — 주소와 무관하므로 열거 신호가 아니다.
    return errorResponse(429, 'rate_limited', '코드 확인이 너무 잦다 — 잠시 뒤 다시 시도하라.');
  }
  if (outcome.kind === 'browser_missing') {
    logSecurityEvent('login_browser_missing', call.request.path, call.request.requestId, null);
    return errorResponse(
      401,
      'login_browser_missing',
      '이 브라우저는 로그인을 요청한 브라우저가 아니다 — 로그인을 요청한 그 브라우저에 코드를 입력하라.',
    );
  }
  if (outcome.kind === 'rejected') {
    logSecurityEvent('login_code_invalid', call.request.path, call.request.requestId, null);
    return errorResponse(
      401,
      'login_code_invalid',
      '코드가 맞지 않다 — 틀렸거나, 만료됐거나, 이미 썼거나, 이 브라우저가 요청한 코드가 아니다. 5번 틀리면 로그인을 다시 요청하라.',
    );
  }
  if (outcome.kind === 'member_limit') {
    // 초대 수락이 조직 멤버 상한에 걸렸다 — 코드·결속이 맞은 뒤에만 나오므로 열거 신호가 아니다. 코드는 소비되지 않았다.
    return errorResponse(409, 'member_limit', '이 조직은 멤버 수 상한에 닿았다 — 조직 owner 에게 알려라. 코드는 쓰이지 않았다.');
  }
  // 홈(atmark.ai) 출처의 코드 verify 에는 CSRF 토큰을 싣지 않는다 — 홈은 곧장 콘솔로 이동하고, 콘솔은 `/api/me` 로 다시 읽는다(`CROSS_SITE_AUTH_PATHS`).
  const body = call.request.headers['origin'] === SITE_ORIGIN ? { next: outcome.next } : { csrf: outcome.csrf, next: outcome.next };
  return jsonResponse(200, body, [sessionCookie(outcome.token, SESSION_TTL_MS / 1000), clearLoginBrowserCookie()]);
}

/** `POST /api/logout` → 204 · 세션 폐기 · 쿠키 삭제. 폐기와 감사는 한 트랜잭션. */
export async function handleLogout(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  await audited(call.deps.pool, session, 'session.logout', (tx) => revokeSession(tx, session), () => null);
  return jsonResponse(204, null, [clearSessionCookie()]);
}

/**
 * `POST /api/logout-all` → 204 · **이 사용자의 살아 있는 세션 전부**(모든 조직 · 다른 기기·브라우저 포함) 폐기 · 이 브라우저의 쿠키 삭제.
 * 세션이 샌 것 같을 때 누르는 버튼이다(다른 멤버의 세션을 끊는 것은 멤버 제거). 폐기와 감사는 한 트랜잭션.
 */
export async function handleLogoutAll(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  await audited(call.deps.pool, session, 'session.logout_all', (tx) => revokeAllSessions(tx, session.userId), () => null);
  return jsonResponse(204, null, [clearSessionCookie()]);
}

/** 조직 한 줄 — `/api/me`·전환·새 조직 응답이 같은 모양. */
function organizationView(view: MembershipView): Record<string, unknown> {
  return { id: view.organizationId, name: displayName(view.name), role: view.role, reviewStatus: view.reviewStatus };
}

/**
 * `GET /api/session/hint` → `{signedIn}` (계약: `http.ts` `SESSION_HINT_PATH`). 라우터가 `optional` 로 이미 세션을 풀었다 — 여기서는
 * 그 결과를 불리언 하나로만 낸다. 쿠키를 다시 싣지도(늘리지도) 않고, DB 에 쓰지도 않는다.
 */
export function handleSessionHint(call: AdminCall): Promise<AdminResponse> {
  return Promise.resolve(jsonResponse(200, { signedIn: call.session !== null }));
}

/**
 * `GET /api/me` → `{user:{id,email}, organization:{id,name,ownerEmail,reviewStatus,role}, orgKillSwitch:{ownerPaused, platformFrozen, active},
 * memberships:[{organizationId,name,role,reviewStatus}], csrf}`.
 *   - `reviewStatus` — 운영자 검토 상태(`pending_review`·`active`·`rejected`, `signup-contract.md` §0). 셀프 가입 조직은
 *     `pending_review` 로 태어나고, 활성 전에는 관문이 외부 발송을 막는다 — 화면은 배너로 알린다.
 *   - `role` — 이 조직에서의 역할(매 요청 멤버십에서 읽은 값). 화면은 역할에 맞춰 버튼을 숨기되 최종 권한은 서버(403 `forbidden_role`).
 *   - `ownerPaused` — 조직 정지(`owner_paused`). admin 이 켜고 owner 가 푼다.
 *   - `platformFrozen` — 운영자·abuse 알람이 건 플랫폼 동결(`abuse_freeze`). **운영자만** 푼다 — 콘솔에는 해제 경로가 없다.
 *   - `active` — 둘 중 하나라도(= Stage 0 이 조직 단위로 막고 있다). 옛 응답 모양과의 호환.
 *   - `memberships` — 이 사용자의 살아 있는 멤버십 전부(조직 스위처). 다른 사용자의 것은 고를 수 없다.
 * 정지 시각은 저장하지 않는다(불리언) — 감사(`owner_actions` `kill_switch.org.*`)가 그 기록이다.
 */
export async function handleMe(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const organization = await organizationOf(call.deps.pool, session.organizationId);
  const email = await userEmailOf(call.deps.pool, session.userId);
  if (organization === null || email === null || call.sessionToken === null) return errorResponse(401, 'unauthenticated', '세션이 없다.');
  const memberships = await membershipsOf(call.deps.pool, session.userId);
  // 요금제 요약(ADR-0011) — 에이전트 수의 분모(비활성 제외 한도)와 한도 초과 배너. 싼 조회만 — 24시간 수신자 합 같은 자세한 것은 설정이
  // `GET /api/plan` 으로 읽는다(`/api/me` 는 화면마다 불린다).
  const plan = await planSummaryOp(call.deps.pool, session.organizationId, call.deps.now());
  return jsonResponse(200, {
    user: { id: session.userId, email },
    organization: {
      id: organization.id,
      name: displayName(organization.name),
      ownerEmail: organization.ownerEmail,
      reviewStatus: organization.reviewStatus,
      role: session.role,
    },
    orgKillSwitch: {
      ownerPaused: organization.ownerPaused,
      platformFrozen: organization.abuseFreeze,
      active: organization.ownerPaused || organization.abuseFreeze,
    },
    memberships: memberships.map((membership) => ({
      organizationId: membership.organizationId,
      name: displayName(membership.name),
      role: membership.role,
      reviewStatus: membership.reviewStatus,
    })),
    plan: { code: plan.code, basis: plan.basis, maxAgents: plan.maxAgents, overLimit: plan.overLimit },
    csrf: csrfTokenOf(call.sessionToken),
  });
}

/**
 * `GET /api/me/preferences` → `{mailLocale, chosen, supported}` — 이 사용자의 시스템 메일 언어(로그인 코드 · 승인 요청 · 알림 메일). 고르지 않았으면
 * 기본값('en')과 `chosen:false`. 멤버(역할 무관) — 본인 것만 읽는다(입력으로 사용자를 고를 수 없다).
 */
export async function handleGetPreferences(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const { mailLocale, chosen } = await mailLocaleOf(call.deps.pool, session.userId);
  return jsonResponse(200, { mailLocale, chosen, supported: SUPPORTED_MAIL_LOCALES });
}

/**
 * `PATCH /api/me/preferences {mailLocale}` → 200 `{mailLocale, chosen:true, supported}` / 400 `invalid_mail_locale`. 본인 행 한 칸만 바꾼다
 * (조직 · 역할과 무관 — owner 와 member 가 각자 고른다). 다음 메일부터(모아 둔 알림도 보내는 순간의 설정으로) 그 언어로 간다.
 */
export async function handlePatchPreferences(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const mailLocale = await setMailLocale(call.deps.pool, session.userId, objectBody(call.request.body)['mailLocale']);
  return jsonResponse(200, { mailLocale, chosen: true, supported: SUPPORTED_MAIL_LOCALES });
}

/** 전환 결과 → 응답. 새 세션이면 쿠키(남은 수명)와 새 CSRF, 같은 조직이면 지금 CSRF 그대로. */
function switchResponse(call: AdminCall, outcome: SwitchOutcome, status: 200 | 201): AdminResponse {
  if (outcome.kind === 'session_gone') return errorResponse(401, 'unauthenticated', '세션이 끝났다 — 다시 로그인하라.', [clearSessionCookie()]);
  if (outcome.kind === 'same') {
    return jsonResponse(200, { csrf: call.sessionToken === null ? null : csrfTokenOf(call.sessionToken), organization: organizationView(outcome.organization) });
  }
  const { switched } = outcome;
  return jsonResponse(status, { csrf: switched.csrf, organization: organizationView(switched.organization) }, [
    sessionCookie(switched.token, switched.maxAgeSeconds),
  ]);
}

/**
 * `POST /api/session/org {organizationId}` → 200 `{csrf, organization:{id,name,role,reviewStatus}}` + **새 세션 쿠키**. 멤버십이 없으면
 * 404 `organization_not_found`. 옛 세션은 폐기된다 — 다른 탭은 401(쿠키가 바뀌었다) 또는 403 `csrf_mismatch`(옛 CSRF)로 닫힌 채 실패하고,
 * 콘솔이 `/api/me` 를 다시 읽는다. 만료는 옛 세션의 만료를 물려받는다(전환으로 연장되지 않는다). 같은 조직이면 200 no-op.
 * 전환·새 조직 합쳐 사용자당 10분 30회를 넘으면 429 `rate_limited`(`SESSION_SWITCHES_PER_USER`).
 */
export async function handleSwitchOrganization(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const outcome = await switchOrganization(call.deps.pool, session, objectBody(call.request.body)['organizationId']);
  return switchResponse(call, outcome, 200);
}

/**
 * `POST /api/organizations {name}` → 201 `{csrf, organization}` + 새 세션 쿠키(새 조직으로 전환). 새 조직은 `pending_review`(운영자
 * 검토 뒤 외부 발송)이고 이 사용자가 주 소유자(owner)다. 400 `invalid_organization_name` · 409 `org_limit`(owner 5 · 하루 2 · 전역 검토 대기).
 */
export async function handleCreateOrganization(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const outcome = await createMemberOrganization(call.deps.pool, session, objectBody(call.request.body)['name']);
  return switchResponse(call, outcome, 201);
}
