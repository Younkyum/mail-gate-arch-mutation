/**
 * src/admin/routes/webhooks.ts — 콘솔 **웹훅 관리**(진윤겸 2026-09-30 승인 — ADR-0013 2026-09-30 개정). 에이전트 API 와 **같은 연산**을 부른다
 * (`webhooks/management.ts` · `db/repositories/webhook-store.ts`) — 한도·잠금·URL 검사·재전송 규칙이 표면마다 갈라지지 않게.
 *
 *   GET    /api/agents/{agentId}/webhooks?status=active|all          → `{items, limits, availableEventTypes}` (기본: 지운 것 제외)
 *   POST   /api/agents/{agentId}/webhooks {url, eventTypes?}          → 201 `{item, secret}` — **시크릿은 이 응답 한 번**
 *   DELETE /api/agents/{agentId}/webhooks/{webhookId}                 → 200 `{item}`
 *   POST   /api/agents/{agentId}/webhooks/{webhookId}/rotate          → 200 `{item, secret, previousValidUntil}` — **새 시크릿은 이 응답 한 번**
 *   POST   /api/agents/{agentId}/webhooks/{webhookId}/authorization {authorization} → 200 `{item}` — 인증 헤더 설정·교체
 *   DELETE /api/agents/{agentId}/webhooks/{webhookId}/authorization   → 200 `{item}` — 인증 헤더 지우기
 *   GET    /api/agents/{agentId}/webhooks/deliveries?cursor=&webhookId= → `{items, nextCursor}`
 *   POST   /api/agents/{agentId}/webhooks/deliveries/{deliveryId}/redeliver → 202 `{item}`
 *
 * 역할은 라우트 표가 막는다(읽기 member · 쓰기 admin 이상). member 세션의 목록은 `url` 이 가린 값이고 `urlMasked: true`(보안 L3 —
 * `maskWebhookUrl`). 이 파일은 세션 조직 범위 검사 · 본문 해석 · 감사 · 응답 모양만 한다.
 *
 * **시크릿(보안 M1).** admin λ 는 웹훅 키링을 갖지 않는다. 등록·회전은 ① api λ 에 활성 kid 를 묻고(`deps.webhookSecrets.activeKid` — 실패하면 아무것도
 * 쓰지 않고 503) ② 행위 + 감사를 한 트랜잭션으로 커밋한 뒤 ③ api λ 에 "방금 만든 행" 의 시크릿을 받는다(`issue` — api λ 가 60초 안의 콘솔 행인지
 * DB 에서 다시 보고 그 버전을 **한 번만** 내준다 — 재검토 L-1; 그래서 ③ 은 등록·회전마다 정확히 한 번 부르고 재시도하지 않는다). ③ 이 실패하면 행위는 이미 커밋됐으므로 503 `webhook_secret_unavailable` 에 `item` 을 함께 싣는다 — 화면은 목록을 다시 읽고, 시크릿은
 * 교체로 새로 받는다. 발급기가 없으면(설정 없음) 등록·회전은 쓰기 전에 503 이다(보안 L4 — 기동은 막지 않는다).
 *
 * **감사(보안 L2).** 쓰기마다 owner_actions 한 행(`agent.webhook.*`, 대상 = 에이전트 id — 에이전트 로그 필터에 그대로 걸린다) + 같은 트랜잭션의 상세
 * 한 행(`webhook_owner_action_details` — 엔드포인트 id · URL 호스트 · 재전송의 전달 id 둘). 회전은 원장(`webhook_secret_rotations`, 경로 console)에도
 * 남는다. 거부(한도·없음)는 감사하지 않는다 — 아무것도 바뀌지 않았다.
 * 오류 코드는 에이전트 API 와 같다(`invalid_webhook_url` 400 · `webhook_endpoint_limit`·`webhook_endpoint_registration_limit` 409 ·
 * `webhook_rotation_rate_limited` 429 · 재전송 409/429 다섯). 없는 대상은 `webhook_not_found`·`delivery_not_found`(404 — 다른 조직과 구별 없음).
 * 시크릿·kid 는 목록 어디에도 없다 — 버전 번호만.
 *
 * **인증 헤더(선택, 202610141400 — `webhooks/authorization.ts`).** 추가 본문의 `authorization` 또는 설정 라우트(POST …/authorization)로 받은 값은 콘솔 λ 가
 * 저장하지 않는다: **쓰기 전에** api λ 에 봉인을 맡기고(`deps.webhookSecrets.sealAuthorization` — 콘솔 λ 는 키 묶음이 없다) 봉인값만 등록·설정과
 * 같은 트랜잭션에 적는다. 봉인기가 없으면 503 `webhooks_unavailable`(아무것도 쓰지 않는다). 규칙 위반은 400 `invalid_authorization`. 목록에는
 * `hasAuthorization` · `authorizationHint`(방식 + 끝 4글자)뿐이다. 설정·지우기는 감사 `agent.webhook.authorization_set`·`_clear`(값 없이 —
 * 상세는 엔드포인트 id · URL 호스트). 지울 값이 없으면 감사 없이 200 이다.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import {
  clearWebhookEndpointAuthorization,
  disableWebhookEndpoint,
  findWebhookDelivery,
  findWebhookEndpoint,
  latestWebhookDeliveries,
  listWebhookDeliveries,
  listWebhookEndpoints,
  MAX_REDELIVERIES_PER_AGENT_HOURLY,
  MAX_REDELIVERIES_PER_ROOT,
  redeliverWebhookDelivery,
  setWebhookEndpointAuthorization,
  type RedeliveryResult,
  type WebhookDeliveryRecord,
  type WebhookEndpointRecord,
} from '../../db/repositories/webhook-store';
import type { AgentId } from '../../db/schema';
import { log } from '../../observability/logger';
import { countMetric, METRIC_NAMES } from '../../observability/metrics';
import { parseWebhookAuthorization, type SealedWebhookAuthorization } from '../../webhooks/authorization';
import { WEBHOOK_EVENT_TYPES } from '../../webhooks/events';
import {
  canonicalWebhookUrl,
  decodeDeliveryCursor,
  deliveryDisplayStatus,
  deliveryLastAttemptAt,
  encodeDeliveryCursor,
  maskWebhookUrl,
  MAX_WEBHOOK_REGISTRATIONS_PER_DAY,
  MAX_WEBHOOK_ROTATIONS_PER_DAY,
  parseEventTypes,
  registerWebhookEndpoint,
  subscribedTypes,
  supersedeWebhookSecret,
  webhookEndpointLimits,
  webhookUrlHost,
  type WebhookDeliveryDisplayStatus,
  type WebhookRegistrationAuthorization,
} from '../../webhooks/management';
import { audited, objectBody, rejectUnknownKeys, requireAgentInOrganization, sessionOf, type AdminCall } from '../context';
import { errorResponse, jsonResponse, type AdminResponse } from '../http';
import { agentDeleted, requireLiveAgent } from '../ops/addresses';
import { AdminInputError, notFound, UUID_PATTERN } from '../ops/errors';

/** 콘솔 전달 목록 한 쪽의 크기 — 에이전트 API 의 기본값과 같다. */
const ADMIN_WEBHOOK_DELIVERY_PAGE_SIZE = 20;

/** 엔드포인트 상태 — 지금 저장소가 만드는 것은 `active`·`deleted` 둘이다. `disabled` 는 자동 비활성(후속)을 위한 자리다(계약에 있다). */
type AdminWebhookStatus = 'active' | 'disabled' | 'deleted';

export interface AdminWebhookItem {
  readonly id: string;
  /** 전체 URL — member 세션의 목록에서는 가린 값(`https://host/…끝4글자`). */
  readonly url: string;
  /** `url` 이 가린 값인가(member 세션의 목록만 true). */
  readonly urlMasked: boolean;
  readonly eventTypes: readonly string[];
  readonly createdAt: string;
  readonly status: AdminWebhookStatus;
  readonly secretVersion: number;
  readonly rotatedAt: string | null;
  /** 직전 시크릿의 유예 끝 — 유예가 끝났거나 회전한 적 없으면 `null`. */
  readonly previousValidUntil: string | null;
  /** 인증 헤더가 있는가 — 값은 어디에도 다시 나가지 않는다. */
  readonly hasAuthorization: boolean;
  /** 인증 헤더 힌트(방식 + 끝 4글자 — 예 `Bearer …wxyz`). 없으면 `null`. */
  readonly authorizationHint: string | null;
  readonly lastDelivery: { readonly status: WebhookDeliveryDisplayStatus; readonly at: string; readonly httpStatus: number | null } | null;
}

export interface AdminWebhookDeliveryItem {
  readonly id: string;
  readonly webhookId: string;
  readonly eventType: string;
  readonly status: WebhookDeliveryDisplayStatus;
  readonly attempts: number;
  readonly httpStatus: number | null;
  readonly createdAt: string;
  readonly lastAttemptAt: string | null;
  readonly deliveredAt: string | null;
}

function webhookItem(endpoint: WebhookEndpointRecord, latest: WebhookDeliveryRecord | undefined, now: Date, masked = false): AdminWebhookItem {
  const previous = endpoint.previousSecret;
  return {
    id: endpoint.id,
    url: masked ? maskWebhookUrl(endpoint.url) : endpoint.url,
    urlMasked: masked,
    eventTypes: [...subscribedTypes(endpoint.eventTypes)],
    createdAt: endpoint.createdAt.toISOString(),
    status: endpoint.disabledAt === null ? 'active' : 'deleted',
    secretVersion: endpoint.secretVersion,
    rotatedAt: endpoint.secretRotatedAt?.toISOString() ?? null,
    previousValidUntil: previous !== null && previous.validUntil.getTime() > now.getTime() ? previous.validUntil.toISOString() : null,
    hasAuthorization: endpoint.authorizationHint !== null,
    authorizationHint: endpoint.authorizationHint,
    lastDelivery:
      latest === undefined
        ? null
        : {
            status: deliveryDisplayStatus(latest),
            at: (deliveryLastAttemptAt(latest) ?? latest.createdAt).toISOString(),
            httpStatus: latest.lastHttpStatus,
          },
  };
}

function deliveryItem(delivery: WebhookDeliveryRecord): AdminWebhookDeliveryItem {
  return {
    id: delivery.id,
    webhookId: delivery.endpointId,
    eventType: delivery.eventType,
    status: deliveryDisplayStatus(delivery),
    attempts: delivery.attemptCount,
    httpStatus: delivery.lastHttpStatus,
    createdAt: delivery.createdAt.toISOString(),
    lastAttemptAt: deliveryLastAttemptAt(delivery)?.toISOString() ?? null,
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
  };
}

function webhookNotFound(): AdminInputError {
  return notFound('웹훅이 없다.', 'webhook_not_found');
}

function deliveryNotFound(): AdminInputError {
  return notFound('웹훅 전달이 없다.', 'delivery_not_found');
}

/** 새 시크릿을 받을 길(api λ)이 없거나 막혔다 — 등록·회전만 503. */
function keysUnavailable(): AdminResponse {
  return errorResponse(503, 'webhooks_unavailable', '웹훅 비밀값을 만들 수 없어 등록·교체를 할 수 없다. 잠시 뒤 다시 시도하라.');
}

/** 지금 활성 kid — 발급기가 없거나 묻기가 실패하면 `null`(쓰기 전에 503). */
async function activeKidOf(secrets: AdminCall['deps']['webhookSecrets']): Promise<string | null> {
  if (secrets === undefined) return null;
  try {
    return await secrets.activeKid();
  } catch {
    return null;
  }
}

/** 커밋 뒤 시크릿을 받지 못했다 — 행위는 됐다(`item`). 화면은 목록을 다시 읽고, 시크릿은 교체로 새로 받는다. */
function secretMissing(item: AdminWebhookItem, error: unknown, agentId: AgentId): AdminResponse {
  log('warn', 'webhook.console_secret_unavailable', {
    agent_id: agentId,
    route_id: 'admin:webhooks',
    outcome: 'secret_unavailable',
    error_kind: error instanceof Error ? ((error as { reason?: string }).reason ?? error.name) : typeof error,
  });
  return jsonResponse(503, {
    error: 'webhook_secret_unavailable',
    detail: '웹훅은 저장됐지만 비밀값을 받지 못했다. 잠시 뒤 비밀값 교체로 새 값을 받는다.',
    item,
  });
}

/**
 * 인증 헤더 값 → 봉인값(쓰기 **전에** — 실패하면 아무것도 쓰지 않는다). 규칙 위반은 400 `invalid_authorization`(값 없이), 봉인기가 없거나 실패하면
 * 503 응답. api λ 가 정규화한 URL 이 `url` 과 다르면 503 이다(디스패처가 열지 못할 값을 적지 않는다).
 */
async function sealForConsole(
  secrets: AdminCall['deps']['webhookSecrets'],
  target: {
    readonly agentId: AgentId;
    readonly organizationId: string;
    readonly endpointId: string;
    readonly url: string;
    readonly purpose: 'register' | 'replace';
  },
  value: string,
): Promise<SealedWebhookAuthorization | AdminResponse> {
  const { agentId, url } = target;
  const seal = secrets?.sealAuthorization;
  if (seal === undefined) return keysUnavailable();
  let result: Awaited<ReturnType<typeof seal>>;
  try {
    result = await seal(target, value);
  } catch (error) {
    const reason = (error as { reason?: unknown } | null)?.reason;
    if (reason === 'invalid_authorization') throw invalidAuthorization();
    // api λ 가 대상을 다시 보고 거절했다(보안 리뷰 L3 — 지웠거나 · 다른 에이전트 · 다른 URL 의 것) — 없는 웹훅과 같은 404.
    if (reason === 'not_eligible') throw webhookNotFound();
    if (reason === 'invalid_url') throw new AdminInputError('등록할 수 없는 URL 이다. 공개 https 주소여야 한다.', 'invalid_webhook_url');
    log('warn', 'webhook.console_authorization_unavailable', {
      agent_id: agentId,
      route_id: 'admin:webhooks',
      outcome: 'seal_unavailable',
      error_kind: typeof reason === 'string' ? reason : error instanceof Error ? error.name : typeof error,
    });
    return keysUnavailable();
  }
  if (result.url !== url) return keysUnavailable();
  return { kid: result.kid, sealed: result.sealed, hint: result.hint, generation: result.generation };
}

function invalidAuthorization(): AdminInputError {
  return new AdminInputError(
    '인증 헤더 값은 인쇄 가능한 ASCII 1–2048자다(줄바꿈·탭·제어 문자 없이, "Authorization:" 이름 없이).',
    'invalid_authorization',
  );
}

/** 본문의 `authorization` — 생략·null 은 `null`, 규칙 위반은 400. */
function authorizationOf(raw: unknown): string | null {
  const parsed = parseWebhookAuthorization(raw);
  if (parsed.kind === 'invalid') throw invalidAuthorization();
  return parsed.kind === 'value' ? parsed.value : null;
}

/** 감사 상세 한 행(보안 L2) — 감사 행과 같은 트랜잭션. URL 은 호스트만. */
async function recordWebhookDetail(
  tx: Pool,
  ownerActionId: string,
  detail: { readonly endpointId: string; readonly url: string; readonly deliveryId?: string; readonly newDeliveryId?: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO webhook_owner_action_details (owner_action_id, endpoint_id, url_host, delivery_id, new_delivery_id)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid)`,
    [ownerActionId, detail.endpointId, webhookUrlHost(detail.url), detail.deliveryId ?? null, detail.newDeliveryId ?? null],
  );
}

/** `GET /api/agents/{agentId}/webhooks?status=active|all` → `{items, limits, availableEventTypes}` */
export async function handleListWebhooks(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const scope = call.request.query['status'] ?? 'active';
  if (scope !== 'active' && scope !== 'all') throw new AdminInputError("status 는 'active' | 'all' 이다.", 'invalid_status');
  const now = call.deps.now();
  const endpoints = await listWebhookEndpoints(call.deps.pool, agentId, { includeDeleted: scope === 'all' });
  const latest = await latestWebhookDeliveries(call.deps.pool, agentId);
  const limits = await webhookEndpointLimits(call.deps.pool, agentId, now);
  // 보안 L3 — URL 전체는 owner·admin 만(허용 목록 — 역할이 늘어도 기본은 가린다). 그 밖은 가린 값(경로·쿼리에 수신측 토큰이 있을 수 있다).
  const masked = !(session.role === 'owner' || session.role === 'admin');
  return jsonResponse(200, {
    items: endpoints.map((endpoint) => webhookItem(endpoint, latest.get(endpoint.id), now, masked)),
    limits,
    availableEventTypes: [...WEBHOOK_EVENT_TYPES],
  });
}

const CREATE_KEYS: ReadonlySet<string> = new Set(['url', 'eventTypes', 'authorization']);

/** `POST /api/agents/{agentId}/webhooks {url, eventTypes?}` → 201 `{item, secret}` — **시크릿은 이 응답 한 번뿐**. */
export async function handleCreateWebhook(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const body = objectBody(call.request.body);
  rejectUnknownKeys(body, CREATE_KEYS);
  const url = body['url'];
  if (typeof url !== 'string' || url.trim() === '') throw new AdminInputError('url(https 주소)이 필요하다.', 'invalid_webhook_url');
  const eventTypes = parseEventTypes(body['eventTypes']);
  if (eventTypes === 'invalid') {
    throw new AdminInputError(`eventTypes 는 비어 있지 않은 배열이고 원소는 ${WEBHOOK_EVENT_TYPES.join(' · ')} 중 하나다.`, 'invalid_event_types');
  }
  const authorizationValue = authorizationOf(body['authorization']);
  const secrets = call.deps.webhookSecrets;
  const kid = await activeKidOf(secrets);
  if (secrets === undefined || kid === null) return keysUnavailable();

  // 인증 헤더는 쓰기 전에 봉인한다(api λ). 저장될 정규화 URL 에 묶는다.
  // 새 엔드포인트 id 는 여기서 만든다 — 봉인 AAD 에 들어간다(보안 리뷰 L2).
  const endpointId = randomUUID();
  let authorization: WebhookRegistrationAuthorization | null = null;
  if (authorizationValue !== null) {
    const canonical = canonicalWebhookUrl(url.trim());
    if (canonical === null) throw new AdminInputError('등록할 수 없는 URL 이다. 공개 https 주소여야 한다.', 'invalid_webhook_url');
    const sealed = await sealForConsole(
      secrets,
      { agentId, organizationId: session.organizationId, endpointId, url: canonical, purpose: 'register' },
      authorizationValue,
    );
    if (!('sealed' in sealed)) return sealed;
    authorization = { endpointId, url: canonical, sealed };
  }

  const now = call.deps.now();
  const registered = await audited(
    call.deps.pool,
    session,
    'agent.webhook.create',
    // 삭제한 에이전트에는 웹훅을 새로 걸지 않는다(409 `agent_deleted` — 삭제가 웹훅을 끈 뜻이 사라진다).
    async (tx) => {
      await requireLiveAgent(tx, agentId);
      return registerWebhookEndpoint(tx, { agentId, url: url.trim(), eventTypes, kid, via: 'console', authorization, endpointId }, now);
    },
    (result) => (result.kind === 'registered' ? agentId : undefined),
    (tx, ownerActionId, result) =>
      result.kind === 'registered' ? recordWebhookDetail(tx, ownerActionId, { endpointId: result.endpoint.id, url: result.endpoint.url }) : Promise.resolve(),
  );
  switch (registered.kind) {
    case 'limit':
      throw new AdminInputError(`요금제의 에이전트당 활성 웹훅은 ${String(registered.limit)}개까지다.`, 'webhook_endpoint_limit', 409);
    case 'registration_limit':
      throw new AdminInputError(
        `에이전트당 웹훅 등록은 24시간에 ${String(MAX_WEBHOOK_REGISTRATIONS_PER_DAY)}번까지다(지운 것 포함).`,
        'webhook_endpoint_registration_limit',
        409,
      );
    case 'rejected':
      throw new AdminInputError(`등록할 수 없는 URL 이다(${registered.reason}). 공개 https 주소여야 한다.`, 'invalid_webhook_url');
    case 'agent_deleted':
      throw agentDeleted();
    case 'registered': {
      const item = webhookItem(registered.endpoint, undefined, now);
      try {
        return jsonResponse(201, { item, secret: await secrets.issue(agentId, registered.endpoint.id) });
      } catch (error) {
        return secretMissing(item, error, agentId);
      }
    }
  }
}

/** `DELETE /api/agents/{agentId}/webhooks/{webhookId}` → `{item}` — 소프트 삭제(되살릴 수 없다). 이미 지운 것 · 없는 것은 404. */
export async function handleDeleteWebhook(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const webhookId = call.params['webhookId'] ?? '';
  if (!UUID_PATTERN.test(webhookId)) throw webhookNotFound();
  const deleted = await audited(
    call.deps.pool,
    session,
    'agent.webhook.delete',
    async (tx) => {
      const disabledAt = await disableWebhookEndpoint(tx, agentId, webhookId);
      return disabledAt === null ? null : await findWebhookEndpoint(tx, agentId, webhookId);
    },
    (endpoint) => (endpoint === null ? undefined : agentId),
    (tx, ownerActionId, endpoint) => (endpoint === null ? Promise.resolve() : recordWebhookDetail(tx, ownerActionId, { endpointId: endpoint.id, url: endpoint.url })),
  );
  if (deleted === null) throw webhookNotFound();
  const latest = await latestWebhookDeliveries(call.deps.pool, agentId);
  return jsonResponse(200, { item: webhookItem(deleted, latest.get(webhookId), call.deps.now()) });
}

/** `POST /api/agents/{agentId}/webhooks/{webhookId}/rotate` → `{item, secret, previousValidUntil}` — **새 시크릿은 이 응답 한 번뿐**. */
export async function handleRotateWebhook(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const webhookId = call.params['webhookId'] ?? '';
  if (!UUID_PATTERN.test(webhookId)) throw webhookNotFound();
  if (call.request.body !== undefined && Object.keys(objectBody(call.request.body)).length > 0) {
    throw new AdminInputError('본문을 받지 않는다.', 'invalid_body');
  }
  const secrets = call.deps.webhookSecrets;
  const kid = await activeKidOf(secrets);
  if (secrets === undefined || kid === null) return keysUnavailable();
  const rotated = await audited(
    call.deps.pool,
    session,
    'agent.webhook.rotate',
    (tx) => supersedeWebhookSecret(tx, { agentId, endpointId: webhookId, kid, via: 'console' }),
    (result) => (result.kind === 'rotated' ? agentId : undefined),
    (tx, ownerActionId, result) =>
      result.kind === 'rotated' ? recordWebhookDetail(tx, ownerActionId, { endpointId: result.endpoint.id, url: result.endpoint.url }) : Promise.resolve(),
  );
  if (rotated.kind === 'not_found') throw webhookNotFound();
  if (rotated.kind === 'rate_limited') {
    throw new AdminInputError(
      `웹훅 하나의 시크릿은 24시간에 ${String(MAX_WEBHOOK_ROTATIONS_PER_DAY)}번까지 바꿀 수 있다.`,
      'webhook_rotation_rate_limited',
      429,
    );
  }
  const latest = await latestWebhookDeliveries(call.deps.pool, agentId);
  const item = webhookItem(rotated.endpoint, latest.get(webhookId), call.deps.now());
  try {
    const secret = await secrets.issue(agentId, webhookId);
    return jsonResponse(200, { item, secret, previousValidUntil: rotated.previousValidUntil.toISOString() });
  } catch (error) {
    return secretMissing(item, error, agentId);
  }
}

const AUTHORIZATION_KEYS: ReadonlySet<string> = new Set(['authorization']);

/**
 * `POST /api/agents/{agentId}/webhooks/{webhookId}/authorization {authorization}` → `{item}` — 인증 헤더 설정·교체. 봉인은 쓰기 전(api λ), 설정과
 * 감사는 한 트랜잭션. 지운 웹훅 · 없는 웹훅은 404.
 */
export async function handleSetWebhookAuthorization(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const webhookId = call.params['webhookId'] ?? '';
  if (!UUID_PATTERN.test(webhookId)) throw webhookNotFound();
  const body = objectBody(call.request.body);
  rejectUnknownKeys(body, AUTHORIZATION_KEYS);
  const value = authorizationOf(body['authorization']);
  if (value === null) throw invalidAuthorization();
  const endpoint = await findWebhookEndpoint(call.deps.pool, agentId, webhookId);
  if (endpoint === null || endpoint.disabledAt !== null) throw webhookNotFound();
  const sealed = await sealForConsole(
    call.deps.webhookSecrets,
    { agentId, organizationId: session.organizationId, endpointId: endpoint.id, url: endpoint.url, purpose: 'replace' },
    value,
  );
  if (!('sealed' in sealed)) return sealed;
  const written = await audited(
    call.deps.pool,
    session,
    'agent.webhook.authorization_set',
    async (tx) => {
      const outcome = await setWebhookEndpointAuthorization(tx, { agentId, endpointId: webhookId, ...sealed, via: 'console' });
      return { outcome, endpoint: outcome === 'set' ? await findWebhookEndpoint(tx, agentId, webhookId) : null };
    },
    ({ endpoint }) => (endpoint === null ? undefined : agentId),
    (tx, ownerActionId, { endpoint }) =>
      endpoint === null ? Promise.resolve() : recordWebhookDetail(tx, ownerActionId, { endpointId: endpoint.id, url: endpoint.url }),
  );
  // 봉인과 저장 사이에 다른 설정 · 지우기가 끼었다(세대가 지나갔다 — 재검증 L2). 아무것도 바뀌지 않았다 — 다시 시도하면 된다.
  if (written.outcome === 'stale') {
    throw new AdminInputError('그 사이 인증 헤더가 바뀌었다. 새로고침한 뒤 다시 시도하라.', 'webhook_authorization_stale', 409);
  }
  if (written.endpoint === null) throw webhookNotFound();
  const latest = await latestWebhookDeliveries(call.deps.pool, agentId);
  return jsonResponse(200, { item: webhookItem(written.endpoint, latest.get(webhookId), call.deps.now()) });
}

/** `DELETE /api/agents/{agentId}/webhooks/{webhookId}/authorization` → `{item}` — 인증 헤더 지우기. 지울 값이 없으면 감사 없이 200. */
export async function handleClearWebhookAuthorization(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const webhookId = call.params['webhookId'] ?? '';
  if (!UUID_PATTERN.test(webhookId)) throw webhookNotFound();
  const outcome = await audited(
    call.deps.pool,
    session,
    'agent.webhook.authorization_clear',
    async (tx) => {
      const result = await clearWebhookEndpointAuthorization(tx, agentId, webhookId, 'console');
      return { result, endpoint: result === 'not_found' ? null : await findWebhookEndpoint(tx, agentId, webhookId) };
    },
    ({ result }) => (result === 'cleared' ? agentId : undefined),
    (tx, ownerActionId, { result, endpoint }) =>
      result === 'cleared' && endpoint !== null ? recordWebhookDetail(tx, ownerActionId, { endpointId: endpoint.id, url: endpoint.url }) : Promise.resolve(),
  );
  if (outcome.endpoint === null) throw webhookNotFound();
  const latest = await latestWebhookDeliveries(call.deps.pool, agentId);
  return jsonResponse(200, { item: webhookItem(outcome.endpoint, latest.get(webhookId), call.deps.now()) });
}

/** `GET /api/agents/{agentId}/webhooks/deliveries?cursor=&webhookId=` → `{items, nextCursor}` — 최신순. 지운 웹훅의 전달도 보인다. */
export async function handleListWebhookDeliveries(call: AdminCall): Promise<AdminResponse> {
  const agentId = await requireAgentInOrganization(call.deps.pool, sessionOf(call), call.params['agentId']);
  const cursorRaw = call.request.query['cursor'];
  const cursor = cursorRaw === undefined || cursorRaw === '' ? null : decodeDeliveryCursor(cursorRaw);
  if (cursorRaw !== undefined && cursorRaw !== '' && cursor === null) throw new AdminInputError('cursor 가 올바르지 않다.', 'invalid_cursor');
  const webhookRaw = call.request.query['webhookId'];
  const endpointId = webhookRaw === undefined || webhookRaw === '' ? null : webhookRaw;
  if (endpointId !== null && !UUID_PATTERN.test(endpointId)) throw webhookNotFound();
  const limit = ADMIN_WEBHOOK_DELIVERY_PAGE_SIZE;
  const rows = await listWebhookDeliveries(call.deps.pool, agentId, { limit: limit + 1, cursor, status: null, endpointId });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return jsonResponse(200, {
    items: page.map(deliveryItem),
    nextCursor: rows.length > limit && last !== undefined ? encodeDeliveryCursor({ createdMicros: last.createdMicros, id: last.id }) : null,
  });
}

/** 재전송 거부 → 에이전트 API 와 같은 코드. */
function redeliveryRejection(result: Exclude<RedeliveryResult, { readonly kind: 'redelivered' }>): AdminInputError {
  switch (result.kind) {
    case 'not_found':
      return deliveryNotFound();
    case 'not_dead':
      return new AdminInputError('실패로 끝난(dead) 전달만 다시 보낼 수 있다.', 'delivery_not_dead', 409);
    case 'endpoint_disabled':
      return new AdminInputError('지운 웹훅으로 가는 전달은 다시 보낼 수 없다.', 'webhook_endpoint_deleted', 409);
    case 'destination_rejected':
      return new AdminInputError('목적지가 거부돼 끝난 전달이다. URL 을 고쳐 새 웹훅을 등록하라.', 'redelivery_destination_rejected', 409);
    case 'already_delivered':
      return new AdminInputError('이 전달(또는 그 재전송)은 이미 받았다.', 'delivery_already_delivered', 409);
    case 'limit_reached':
      return new AdminInputError(`한 전달은 ${String(MAX_REDELIVERIES_PER_ROOT)}번까지 다시 보낼 수 있다.`, 'redelivery_limit', 409);
    case 'agent_rate_limited':
      return new AdminInputError(
        `에이전트당 재전송은 1시간에 ${String(MAX_REDELIVERIES_PER_AGENT_HOURLY)}건까지다. 잠시 뒤 다시 시도하라.`,
        'redelivery_rate_limited',
        429,
      );
  }
}

/** `POST /api/agents/{agentId}/webhooks/deliveries/{deliveryId}/redeliver` → 202 `{item}` — 새 전달 행(같은 이벤트 id·본문, pending). */
export async function handleRedeliverWebhook(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const deliveryId = call.params['deliveryId'] ?? '';
  if (!UUID_PATTERN.test(deliveryId)) throw deliveryNotFound();
  const now = call.deps.now();
  const outcome = await audited(
    call.deps.pool,
    session,
    'agent.webhook.redeliver',
    async (tx) => {
      const result = await redeliverWebhookDelivery(tx, agentId, deliveryId, now);
      if (result.kind !== 'redelivered') return { result, created: null, endpoint: null };
      const created = await findWebhookDelivery(tx, agentId, result.deliveryId);
      const endpoint = created === null ? null : await findWebhookEndpoint(tx, agentId, created.endpointId);
      return { result, created, endpoint };
    },
    ({ result }) => (result.kind === 'redelivered' ? agentId : undefined),
    (tx, ownerActionId, { result, endpoint }) =>
      result.kind === 'redelivered' && endpoint !== null
        ? recordWebhookDetail(tx, ownerActionId, { endpointId: endpoint.id, url: endpoint.url, deliveryId, newDeliveryId: result.deliveryId })
        : Promise.resolve(),
  );
  if (outcome.result.kind !== 'redelivered') throw redeliveryRejection(outcome.result);
  countMetric(METRIC_NAMES.webhookRedelivered);
  if (outcome.created === null) throw deliveryNotFound();
  return jsonResponse(202, { item: deliveryItem(outcome.created) });
}
