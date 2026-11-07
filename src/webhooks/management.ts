/**
 * src/webhooks/management.ts — 웹훅 **관리 연산**(등록 · 시크릿 회전 · 한도 보기 · 권한 판정 · 콘솔 시크릿 발급 · URL 가림). 에이전트 API
 * (`api/routes/webhook-endpoints.ts`·`webhook-deliveries.ts` — MCP 도구도 그 라우트를 부른다)와 콘솔(`admin/routes/webhooks.ts`)이 **같은 함수**를
 * 부른다 — 표면마다 규칙을 다시 쓰면 한쪽만 고쳐진다(ADR-0013 개정). DB 쓰기는 전부 정의자 함수다(등록 · 회전 · 재전송 · 삭제).
 *
 * ---------------------------------------------------------------------------
 * ## 권한 — `webhooks:manage` (에이전트 토큰 표면만)
 * ---------------------------------------------------------------------------
 *
 * 등록 · 삭제 · 시크릿 회전 · 재전송은 `webhooks:manage` 를 요구한다(`authorizeWebhookManage`). 등록은 이벤트를 **바깥 URL 로 내보내는 경로를
 * 새로 연다** — 읽기 토큰이 할 수 있으면 읽기만 주려던 토큰이 수신지를 연다. 목록 · 전달 목록은 `messages:read`.
 *
 * **전환 경로(2026-12-31 까지, 보안 M3):** `webhooks:manage` 가 생기기 **전에 발급된** 토큰(`webhooksLegacyEligible` — DB 의 불변 칸)만
 * `messages:send` 로 등록·삭제·재전송을 할 수 있다. 등록은 `messages:read` 도 함께 있어야 한다(예전 등록 권한). **회전은 전환 경로가 없다**
 * (새 행위라 지킬 옛 자동화가 없다). 그 길로 통과할 때마다 구조화 로그 `webhook.legacy_capability`(warn). 끝은
 * `LEGACY_WEBHOOK_MANAGE_UNTIL`(2027-01-01T00:00:00Z, 배타) — 코드가 시각으로 닫는다. 콘솔 토큰 교체(한 개·전부)는 새 토큰 행이라 자격을 **물려받지
 * 않는다** — 교체한 토큰으로 웹훅을 다루려면 `webhooks:manage` 를 골라 발급한다(ADR-0013 개정). 새 MCP 도구에는 이 경로가 없다.
 * 콘솔은 토큰이 아니라 세션 역할(owner·admin 쓰기 · member 읽기)로 가른다 — 이 판정을 부르지 않는다.
 *
 * ---------------------------------------------------------------------------
 * ## 시크릿 회전 · 발급
 * ---------------------------------------------------------------------------
 *
 * 시크릿은 저장하지 않고 `(endpoint id, kid, version)` 으로 파생한다(`signing.ts`). 회전 = 정의자 함수가 버전을 올리고 직전 `(kid, version)` 을
 * **24시간 유예**로 남긴다(디스패처가 유예 동안 새·옛 둘 다로 서명). 엔드포인트당 24시간 10회. 새 시크릿은 **등록·회전 응답에서만** 나간다.
 * **콘솔(admin λ)은 키링이 없다**(보안 M1): 등록·회전을 커밋한 뒤 api λ 를 내부 이벤트로 불러(`runtime/internal-api-event.ts`) 시크릿을 받는다.
 * api λ 는 `issueConsoleWebhookSecret` 으로 "60초 안에 콘솔이 등록·회전한 행" 인지 DB 에서 다시 확인한 뒤에만 파생한다. 콘솔은 새 행의 kid 를
 * 모르므로 같은 내부 호출로 활성 kid 를 먼저 묻는다(kid 는 비밀이 아니다).
 *
 * ---------------------------------------------------------------------------
 * ## URL 가림(보안 L3)
 * ---------------------------------------------------------------------------
 *
 * `maskWebhookUrl` — `scheme://host[:port]/…` + 경로 끝 4글자(쿼리·프래그먼트 없음). 경로가 `/` 뿐이면 `scheme://host/`. 에이전트 API 목록은
 * `webhooks:manage` 가 없는 토큰에, 콘솔은 member 세션에 이 값을 같은 칸(`url`)으로 준다.
 */

import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../db/client';
import { loadAgentEntitlements } from '../db/repositories/entitlements';
import {
  consoleWebhookSecretRef,
  countRecentWebhookRegistrations,
  findWebhookEndpoint,
  insertWebhookEndpoint,
  listWebhookEndpoints,
  setWebhookEndpointAuthorization,
  supersedeWebhookEndpointSecret,
  WebhookEndpointRejectedError,
  type WebhookDeliveryCursor,
  type WebhookDeliveryRecord,
  type WebhookEndpointRecord,
  type WebhookRotationVia,
} from '../db/repositories/webhook-store';
import type { AgentId, WebhookEndpointEventTypes } from '../db/schema';
import { authorizeAgentToken, type AgentPrincipal } from '../identity/agent-token';
import { log } from '../observability/logger';
import type { HmacKeyring } from '../security/hmac-keyring';
import type { SealedWebhookAuthorization } from './authorization';
import { checkWebhookUrl, type WebhookUrlRejection } from './destination';
import { LEGACY_EVENT_TYPES, UUID_PATTERN, WEBHOOK_EVENT_TYPES, type WebhookEventType } from './events';
import { deriveWebhookSecret } from './signing';

/**
 * 에이전트당 활성 엔드포인트 **코드 천장**. 이벤트 하나가 엔드포인트 수만큼 outbox 행이 되므로(팬아웃) 무한이면
 * 한 에이전트가 outbox 를 부풀릴 수 있다. 요금제(`webhook_endpoints_per_agent_max`, ADR-0011)가 이 안에서 조인다.
 * 상한 검사와 INSERT 는 **한 트랜잭션 · 에이전트 advisory 잠금**(`webhook_endpoints_active:<agent>`) 아래라 동시 등록이 겹쳐도 넘지 않는다.
 * DB 트리거 `webhook_endpoints_active_limit`(202609250300)이 같은 잠금 키로 이 천장 10 을 한 번 더 막는다.
 */
export const MAX_WEBHOOK_ENDPOINTS_PER_AGENT = 10;

/**
 * 에이전트당 **24시간 등록 수** 상한(비활성 포함 — 메일 기본기 A4 재등록 상한). 활성 천장과 따로 센다: 등록·삭제를 되풀이하면 활성 수는
 * 늘지 않지만 새 시크릿·새 목적지가 계속 생긴다. 같은 잠금 아래에서 센다. DB 트리거 `webhook_endpoints_registration_ceiling` 이 바닥 20 을 지킨다.
 */
export const MAX_WEBHOOK_REGISTRATIONS_PER_DAY = 10;

/** 엔드포인트당 24시간 회전 수. DB 함수 `rotate_webhook_endpoint_secret` 의 상수와 같다(202609301410). */
export const MAX_WEBHOOK_ROTATIONS_PER_DAY = 10;

/** 옛 토큰의 `messages:send` 로 웹훅을 관리하는 전환 경로의 끝(배타) — 2026-12-31(UTC) 이 마지막 날이다. */
export const LEGACY_WEBHOOK_MANAGE_UNTIL = new Date('2027-01-01T00:00:00.000Z');

/** 웹훅 관리 행위 — 로그·판정의 이름. */
export type WebhookManageAction = 'register' | 'delete' | 'rotate' | 'redeliver';

export type WebhookManageAuthorization =
  | { readonly kind: 'authorized'; readonly via: 'webhooks:manage' | 'legacy_messages_send' }
  | { readonly kind: 'denied'; readonly reason: 'not_own_agent' | 'capability_not_granted' };

/** 전환 경로가 받는 행위 — 회전은 없다(보안 M3 — 새 행위라 지킬 옛 자동화가 없다). */
const LEGACY_ACTIONS: ReadonlySet<WebhookManageAction> = new Set<WebhookManageAction>(['register', 'delete', 'redeliver']);

/**
 * 에이전트 토큰의 웹훅 관리 판정(머리말 "권한"). 소유 검사가 먼저다(`authorizeAgentToken` 과 같은 순서). 전환 경로 조건 — 전부 참이어야 한다:
 * 일몰 전 · 회전이 아님 · 토큰이 `webhooks:manage` 전에 발급됨(`webhooksLegacyEligible`) · `messages:send` · 등록이면 `messages:read` 도.
 * 통과하면 로그 한 줄.
 */
export function authorizeWebhookManage(
  principal: AgentPrincipal,
  targetAgentId: AgentId,
  action: WebhookManageAction,
  now: Date,
): WebhookManageAuthorization {
  const primary = authorizeAgentToken(principal, 'webhooks:manage', targetAgentId);
  if (primary.kind === 'authorized') return { kind: 'authorized', via: 'webhooks:manage' };
  if (primary.reason === 'not_own_agent') return { kind: 'denied', reason: 'not_own_agent' };
  const legacy =
    now.getTime() < LEGACY_WEBHOOK_MANAGE_UNTIL.getTime() &&
    LEGACY_ACTIONS.has(action) &&
    principal.webhooksLegacyEligible === true &&
    principal.capabilities.includes('messages:send') &&
    (action !== 'register' || principal.capabilities.includes('messages:read'));
  if (!legacy) return { kind: 'denied', reason: 'capability_not_granted' };
  log('warn', 'webhook.legacy_capability', {
    agent_id: targetAgentId,
    route_id: `webhooks:${action}`,
    outcome: 'allowed_legacy',
    reason: 'messages:send',
    detail: `token issued ${principal.issuedAt?.toISOString() ?? 'unknown'}; webhooks:manage required after ${LEGACY_WEBHOOK_MANAGE_UNTIL.toISOString()}`,
  });
  return { kind: 'authorized', via: 'legacy_messages_send' };
}

/**
 * 웹훅 URL 가림(머리말 "URL 가림"). 모양이 URL 이 아니면(저장소가 막으므로 없어야 한다) 호스트 없이 `…` 만.
 * 예: `https://hooks.example.com/v1/atmark?token=x` → `https://hooks.example.com/…mark`.
 */
export function maskWebhookUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '…';
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  const path = parsed.pathname;
  if (path === '' || path === '/') return `${origin}/`;
  return `${origin}/…${path.slice(-4)}`;
}

/** URL 호스트(포트 포함, 소문자) — 감사 상세·로그에 싣는 유일한 URL 조각(경로·쿼리에는 토큰이 있을 수 있다). */
export function webhookUrlHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return 'invalid';
  }
}

// ---------------------------------------------------------------------------
// 구독
// ---------------------------------------------------------------------------

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>(WEBHOOK_EVENT_TYPES);

/**
 * 구독 입력 → 저장할 값. 생략(`undefined`)은 `null`(옛 4종). 주면 비어 있지 않은 배열이고 원소는 전부 알려진 종류다 — 중복은 없애고
 * **정의 순서**(`WEBHOOK_EVENT_TYPES`)로 정렬한다(같은 구독이 같은 값이 되게). 틀리면 `'invalid'`.
 */
export function parseEventTypes(raw: unknown): WebhookEndpointEventTypes | 'invalid' {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > WEBHOOK_EVENT_TYPES.length * 2) return 'invalid';
  const wanted = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string' || !KNOWN_EVENT_TYPES.has(value)) return 'invalid';
    wanted.add(value);
  }
  return WEBHOOK_EVENT_TYPES.filter((type) => wanted.has(type));
}

/** 응답의 구독 — `null`(옛 4종)을 실제 목록으로 풀어 보인다. 수신측이 "무엇을 받는가" 를 추측하지 않게. */
export function subscribedTypes(eventTypes: WebhookEndpointEventTypes): readonly WebhookEventType[] {
  return eventTypes ?? LEGACY_EVENT_TYPES;
}

// ---------------------------------------------------------------------------
// 등록
// ---------------------------------------------------------------------------

/**
 * 저장소가 적을 **정규화된** URL(`checkWebhookUrl(...).url.href`) — 인증 헤더 봉인의 AAD 는 이 문자열이어야 디스패처가 연다. 거부면 `null`.
 */
export function canonicalWebhookUrl(url: string): string | null {
  const checked = checkWebhookUrl(url);
  return checked.kind === 'rejected' ? null : checked.url.href;
}

/**
 * 등록과 함께 적을 인증 헤더 — `(agentId, endpointId, url)` 로 봉인한 값. `endpointId` 는 등록이 쓸 새 id(`input.endpointId`), `url` 은
 * `canonicalWebhookUrl` 의 값이어야 한다(등록이 둘 다 대조한다 — 다르면 디스패처가 열지 못한다).
 */
export interface WebhookRegistrationAuthorization {
  readonly endpointId: string;
  readonly url: string;
  readonly sealed: SealedWebhookAuthorization;
}

export type WebhookRegistration =
  | { readonly kind: 'registered'; readonly endpoint: WebhookEndpointRecord }
  | { readonly kind: 'limit'; readonly limit: number }
  | { readonly kind: 'registration_limit' }
  | { readonly kind: 'rejected'; readonly reason: WebhookUrlRejection }
  /** 삭제한 에이전트(`disabled`, 202610131000) — 웹훅을 새로 걸지 않는다. DB 트리거 `webhook_endpoints_reject_disabled_agent` 가 한 번 더 막는다. */
  | { readonly kind: 'agent_deleted' };

/**
 * 등록 — 상한 = min(천장, 요금제)(행이 없는 조직은 Free — fail-closed, ADR-0011). 세기와 INSERT 가 한 트랜잭션 · 에이전트 잠금 아래다(동시 등록
 * N 개가 모두 "아직 한 자리" 를 보고 넘지 않게). 잠금 키는 DB 트리거와 같다. `db` 가 이미 트랜잭션에 묶인 풀(콘솔의 `audited`)이면 세이브포인트다.
 * 시크릿은 여기서 만들지 않는다 — 에이전트 API 는 `deriveEndpointSecret`, 콘솔은 api λ 의 `issueConsoleWebhookSecret` 로 받는다. `kid` 는 새 행을
 * 파생할 활성 kid, `via` 는 등록 표면(호출 롤과 맞아야 한다 — 정의자 함수가 본다).
 */
export async function registerWebhookEndpoint(
  db: Pool,
  input: {
    readonly agentId: AgentId;
    readonly url: string;
    readonly eventTypes: WebhookEndpointEventTypes;
    readonly kid: string;
    readonly via: WebhookRotationVia;
    /** 인증 헤더(선택, 202610141400) — **INSERT 와 같은 트랜잭션**에서 적는다(헤더 없이 나가는 틈이 없다). 봉인은 호출자가 먼저 한다. */
    readonly authorization?: WebhookRegistrationAuthorization | null;
    /** 새 엔드포인트 id(앱이 만든 uuid — 봉인 AAD 와 같아야 한다). 생략하면 저장소가 만든다(인증 헤더가 없을 때만). */
    readonly endpointId?: string;
  },
  now: Date,
): Promise<WebhookRegistration> {
  const { agentId, kid } = input;
  const authorization = input.authorization ?? null;
  // 봉인한 URL 이 저장될 URL 과 다르면 디스패처가 열지 못한다 — 쓰기 전에 프로그램 오류로 멈춘다.
  if (authorization !== null && authorization.url !== canonicalWebhookUrl(input.url)) {
    throw new Error('인증 헤더를 봉인한 URL 이 등록할 URL 과 다르다');
  }
  if (authorization !== null && authorization.endpointId !== input.endpointId) {
    throw new Error('인증 헤더를 봉인한 엔드포인트 id 가 등록할 id 와 다르다');
  }
  if (authorization !== null && authorization.sealed.generation !== 1) {
    throw new Error('새 엔드포인트의 인증 헤더는 세대 1 로 봉인한다');
  }
  const result = await withTransaction(db, async (client): Promise<WebhookRegistration | { readonly kind: 'inserted'; readonly id: string }> => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('webhook_endpoints_active:' || $1::text, 0))`, [agentId]);
    const status = await client.query<{ status: string }>('SELECT status::text AS status FROM agents WHERE id = $1', [agentId]);
    if (status.rows[0]?.status === 'disabled') return { kind: 'agent_deleted' };
    const limit = await activeEndpointLimit(client, agentId, now);
    const existing = await listWebhookEndpoints(client, agentId);
    if (existing.length >= limit) return { kind: 'limit', limit };
    // 재등록 상한(비활성 포함) — 활성 한도 뒤에 본다: 활성이 가득 찬 경우의 답(`webhook_endpoint_limit`)이 먼저다.
    if ((await countRecentWebhookRegistrations(client, agentId)) >= MAX_WEBHOOK_REGISTRATIONS_PER_DAY) return { kind: 'registration_limit' };
    let id: string;
    try {
      id = await insertWebhookEndpoint(client, {
        agentId,
        url: input.url,
        secretKid: kid,
        eventTypes: input.eventTypes,
        via: input.via,
        ...(input.endpointId === undefined ? {} : { id: input.endpointId }),
      });
    } catch (error) {
      if (error instanceof WebhookEndpointRejectedError) return { kind: 'rejected', reason: error.reason };
      throw error;
    }
    if (authorization !== null) {
      const written = await setWebhookEndpointAuthorization(client, { agentId, endpointId: id, ...authorization.sealed, via: input.via });
      // 같은 트랜잭션의 새 행이다 — `set` 이 아니면 프로그램 오류(던져서 등록째 되돌린다).
      if (written !== 'set') throw new Error(`등록과 함께 인증 헤더를 적지 못했다: ${written}`);
    }
    return { kind: 'inserted', id };
  });
  if (result.kind !== 'inserted') return result;
  const endpoint = await findWebhookEndpoint(db, agentId, result.id);
  if (endpoint === null) throw new Error('방금 등록한 웹훅 엔드포인트를 읽지 못했다');
  return { kind: 'registered', endpoint };
}

/** 행의 지금 시크릿 — 에이전트 API(키링을 가진 api λ)만 부른다. kid 가 묶음에 없으면 던진다. */
export function deriveEndpointSecret(keyring: HmacKeyring, endpoint: Pick<WebhookEndpointRecord, 'id' | 'secretKid' | 'secretVersion'>): string {
  return deriveWebhookSecret(keyring, { endpointId: endpoint.id, kid: endpoint.secretKid, version: endpoint.secretVersion });
}

/**
 * 콘솔 시크릿 발급(보안 M1 — api λ 의 내부 이벤트만 부른다). 콘솔이 **60초 안에** 등록했거나 콘솔 회전으로 지금 버전이 된 켜진 행일 때만 파생한다
 * (DB 정의자 함수 `console_webhook_secret_ref` 가 판정). 그 밖은 `null` — 콘솔 λ 가 탈취돼도 옛 엔드포인트의 시크릿은 받을 수 없다.
 * **버전당 한 번**(재검토 L-1) — 함수가 `(엔드포인트, 버전)` 을 선점하므로 같은 버전의 두 번째 호출도 `null` 이다(60초 창 안의 재조회 차단).
 * 그래서 콘솔은 등록·회전 한 번에 이것을 **정확히 한 번** 부르고 재시도하지 않는다 — 선점 뒤 응답을 잃으면 교체로 새 버전을 받는다.
 */
export async function issueConsoleWebhookSecret(
  db: Queryable,
  keyring: HmacKeyring,
  agentId: AgentId,
  endpointId: string,
): Promise<string | null> {
  const ref = await consoleWebhookSecretRef(db, agentId, endpointId);
  if (ref === null) return null;
  return deriveWebhookSecret(keyring, { endpointId, kid: ref.kid, version: ref.version });
}

async function activeEndpointLimit(db: Queryable, agentId: AgentId, now: Date): Promise<number> {
  const entitlements = await loadAgentEntitlements(db, agentId, now);
  return Math.min(MAX_WEBHOOK_ENDPOINTS_PER_AGENT, entitlements?.webhookEndpointsPerAgentMax ?? 0);
}

export interface WebhookEndpointLimits {
  readonly active: number;
  readonly activeMax: number;
  readonly registrationsToday: number;
  readonly registrationsMax: number;
}

/** 콘솔 화면의 한도 — 등록 연산이 보는 것과 같은 값(활성 수 · min(천장, 요금제) · 최근 24시간 등록 · 재등록 상한). */
export async function webhookEndpointLimits(db: Queryable, agentId: AgentId, now: Date): Promise<WebhookEndpointLimits> {
  // 차례로 — `db` 가 트랜잭션 커넥션 하나일 수 있다(한 커넥션에 겹친 쿼리를 걸지 않는다).
  const active = (await listWebhookEndpoints(db, agentId)).length;
  const activeMax = await activeEndpointLimit(db, agentId, now);
  const registrationsToday = await countRecentWebhookRegistrations(db, agentId);
  return { active, activeMax, registrationsToday, registrationsMax: MAX_WEBHOOK_REGISTRATIONS_PER_DAY };
}

// ---------------------------------------------------------------------------
// 시크릿 회전
// ---------------------------------------------------------------------------

export type WebhookSecretRotation =
  | { readonly kind: 'rotated'; readonly endpoint: WebhookEndpointRecord; readonly previousValidUntil: Date }
  /** 없거나 · 다른 에이전트의 것이거나 · 지웠다 — 같은 404(존재를 알리지 않는다). */
  | { readonly kind: 'not_found' }
  | { readonly kind: 'rate_limited' };

/**
 * 시크릿 회전(머리말). 새 버전은 `kid`(활성 kid)로 파생된다. 새 시크릿은 여기서 만들지 않는다(`deriveEndpointSecret` ·
 * `issueConsoleWebhookSecret`) — 로그·원장에는 버전만 남는다.
 */
export async function supersedeWebhookSecret(
  db: Pool,
  input: { readonly agentId: AgentId; readonly endpointId: string; readonly kid: string; readonly via: WebhookRotationVia },
): Promise<WebhookSecretRotation> {
  const rotated = await supersedeWebhookEndpointSecret(db, input.agentId, input.endpointId, input.kid, input.via);
  if (rotated.kind !== 'rotated') {
    if (rotated.kind === 'rate_limited') {
      log('warn', 'webhook.secret_rotation_rejected', { agent_id: input.agentId, route_id: `webhooks:rotate:${input.via}`, outcome: 'rate_limited' });
    }
    return rotated;
  }
  const endpoint = await findWebhookEndpoint(db, input.agentId, input.endpointId);
  if (endpoint === null) throw new Error('방금 회전한 웹훅 엔드포인트를 읽지 못했다');
  log('info', 'webhook.secret_rotated', {
    agent_id: input.agentId,
    route_id: `webhooks:rotate:${input.via}`,
    outcome: 'rotated',
    detail: `endpoint:${input.endpointId} version:${String(rotated.version)}`,
  });
  return { kind: 'rotated', endpoint, previousValidUntil: rotated.previousValidUntil };
}

// ---------------------------------------------------------------------------
// 전달 표시 상태
// ---------------------------------------------------------------------------

/**
 * 화면의 전달 상태 — 저장 상태 셋(`pending`·`delivered`·`dead`)에 `failed` 를 더한다: 시도가 실패해 **재시도를 기다리는** pending
 * (`last_error` 가 있다). 첫 시도 전(또는 시도 중)의 pending 은 `pending` 이다.
 */
export type WebhookDeliveryDisplayStatus = 'pending' | 'delivered' | 'failed' | 'dead';

export function deliveryDisplayStatus(delivery: WebhookDeliveryRecord): WebhookDeliveryDisplayStatus {
  if (delivery.status === 'pending') return delivery.lastError === null ? 'pending' : 'failed';
  return delivery.status;
}

/** 마지막 시도 시각 — 칸(202609301410)이 없던 옛 행은 종단 시각으로 대신한다. 시도 전이면 `null`. */
export function deliveryLastAttemptAt(delivery: WebhookDeliveryRecord): Date | null {
  return delivery.lastAttemptAt ?? delivery.deliveredAt ?? delivery.deadAt;
}

// ---------------------------------------------------------------------------
// 전달 목록 커서 — (created_at 에포크 마이크로초, id) 의 불투명 인코딩(에이전트 API · 콘솔 같은 모양)
// ---------------------------------------------------------------------------

export function encodeDeliveryCursor(cursor: WebhookDeliveryCursor): string {
  return Buffer.from(`${cursor.createdMicros}|${cursor.id}`, 'utf8').toString('base64url');
}

/** 모양이 틀리면 `null`(호출자가 400). */
export function decodeDeliveryCursor(value: string): WebhookDeliveryCursor | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) return null;
  const [micros, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (micros === undefined || id === undefined || rest.length > 0) return null;
  if (!/^[1-9][0-9]{0,17}$/.test(micros) || !UUID_PATTERN.test(id)) return null;
  return { createdMicros: micros, id };
}
