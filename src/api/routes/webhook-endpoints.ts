/**
 * `POST /v1/agents/{id}/webhook-endpoints` — 웹훅 엔드포인트 등록 (계획 §3.4 1조).
 * `GET  /v1/agents/{id}/webhook-endpoints` — 등록된 엔드포인트 목록. **시크릿이 없다.**
 * `DELETE /v1/agents/{id}/webhook-endpoints/{endpointId}` — 소프트 삭제(메일 기본기 A4).
 * `POST /v1/agents/{id}/webhook-endpoints/{endpointId}/rotate-secret` — 시크릿 회전(2026-09-30). 새 시크릿 + 직전 시크릿 24시간 유예.
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 메일을 보내지 않는다 — 등록은 행 하나를 쓰고, 웹훅
 * HTTP 는 디스패처 워커(`workers/webhook-dispatcher`)가 outbox 에서 꺼내 보낸다.
 *
 * ---------------------------------------------------------------------------
 * ## 시크릿은 **등록·회전 응답에서만** 나간다
 * ---------------------------------------------------------------------------
 *
 * 시크릿은 저장하지 않는다 — 마스터 키에서 `(endpoint id, kid, version)` 으로 파생한다
 * (`webhooks/signing.ts`). 그러므로 "한 번만" 은 저장 방식이 아니라 **표면의 규율**이다: 목록 응답의 모양
 * (`WebhookEndpointRecord`)에 시크릿 자리가 없고, 재조회 경로가 없다. 분실하면 회전한다(새 버전 → 다른 시크릿 · 옛 것은 24시간 유예)
 * — 또는 새 엔드포인트를 등록한다. 목록·로그·오류 응답 어디에도 `whsec_` 가 실리지 않는다 — 테스트가 그것을 본다.
 *
 * ---------------------------------------------------------------------------
 * ## 권한 — 목록 `messages:read` · 등록·삭제·회전 `webhooks:manage`
 * ---------------------------------------------------------------------------
 *
 * 등록은 이벤트를 바깥 URL 로 내보내는 경로를 새로 여는 쓰기라 읽기 토큰으로 할 수 없다(ADR-0013 2026-09-30 개정 — 예전에는 `messages:read`
 * 였다). 판정은 `webhooks/management.ts` `authorizeWebhookManage` 하나다 — 옛 토큰은 2026-12-31 까지 `messages:send` 로도 통과하고 그때마다
 * 구조화 로그가 남는다 — 단, 그 권한 전에 발급된 토큰만 · 등록은 `messages:read` 도 · 회전은 전환 경로 없음(보안 M3). 목록은 `messages:read` —
 * 웹훅이 싣는 것은 폴링으로 얻는 식별자·시각뿐이다. `webhooks:manage` 가 없는 토큰의 목록은 URL 을 가린다(`url_masked: true`, 보안 L3).
 * 등록·삭제는 구조화 info 로그 한 줄(`webhook.endpoint_registered`·`webhook.endpoint_deleted` — 엔드포인트 id · URL 호스트, 보안 L2).
 *
 * ---------------------------------------------------------------------------
 * ## 구독(opt-in) · 재등록 상한 (메일 기본기 A4)
 * ---------------------------------------------------------------------------
 *
 * 본문 `{url, event_types?}`. `event_types` 를 생략하면 옛 4종(`LEGACY_EVENT_TYPES`)만 받는다 — 기존 수신측은 아무것도 바뀌지 않는다. 새 종류
 * (`message.delivered`·`bounced`·`complained`)는 적은 엔드포인트만 받는다. 구독은 등록 뒤 바꿀 수 없다(DB 불변) — 바꾸려면 새로 등록한다.
 * 등록·삭제를 되풀이해 시크릿·팬아웃을 굴리지 못하게 **24시간 10회**(비활성 포함)까지만 등록한다(DB 바닥 20, 202609260115). 회전은
 * 엔드포인트당 **24시간 10회**(429 `webhook_rotation_rate_limited`). 상한·잠금·파생은 콘솔과 같은 연산(`webhooks/management.ts`)이다.
 *
 * ---------------------------------------------------------------------------
 * ## 인증 헤더(선택, 202610141400)
 * ---------------------------------------------------------------------------
 *
 * 본문 `authorization`(헤더 값 전체 — `Bearer <token>` 등)을 주면 모든 전달에 `Authorization` 헤더로 실린다 — 수신측 게이트웨이 통과용이고 서명을
 * 대신하지 않는다(`webhooks/authorization.ts`). 규칙을 어기면 400 `invalid_authorization`(값은 싣지 않는다). 봉인은 INSERT 전에 하고 같은 트랜잭션에
 * 적는다. **에이전트 토큰은 등록 때만** 줄 수 있다 — 바꾸거나 지우는 것은 콘솔(소유자)뿐이다(DB 함수가 앱 롤의 나중 쓰기를 `not_allowed` 로 막는다).
 * 응답·목록에는 `has_authorization` 과 `authorization_hint`(방식 + 끝 4글자)만 — 값은 어디에도 다시 나가지 않는다.
 *
 * **URL 검사는 두 번이다.** 여기(`insertWebhookEndpoint` 안의 정적 검사)와 전달 때마다(DNS 해석 뒤 IP
 * 검사, `webhooks/destination.ts`). 등록 시점의 DNS 는 전달 시점의 DNS 가 아니므로 여기서는 해석하지 않는다.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type { AgentId, WebhookEndpointEventTypes } from '../../db/schema';
import { disableWebhookEndpoint, listWebhookEndpoints, type WebhookEndpointRecord } from '../../db/repositories/webhook-store';
import type { AgentPrincipal, AgentTokenCapability, AgentTokenStore } from '../../identity/agent-token';
import { log } from '../../observability/logger';
import { activeKey, type HmacKeyring } from '../../security/hmac-keyring';
import {
  parseWebhookAuthorization,
  sealWebhookAuthorization,
  webhookAuthorizationRejectionDetail,
  type WebhookAuthorizationRejection,
} from '../../webhooks/authorization';
import { checkWebhookUrl } from '../../webhooks/destination';
import { WEBHOOK_EVENT_TYPES } from '../../webhooks/events';
import {
  authorizeWebhookManage,
  deriveEndpointSecret,
  maskWebhookUrl,
  MAX_WEBHOOK_REGISTRATIONS_PER_DAY,
  MAX_WEBHOOK_ROTATIONS_PER_DAY,
  parseEventTypes,
  registerWebhookEndpoint,
  supersedeWebhookSecret,
  subscribedTypes,
  webhookUrlHost,
  type WebhookManageAction,
  type WebhookRegistrationAuthorization,
} from '../../webhooks/management';
import { authenticateRequest, authorizeRequest, claimedAgentOfPath, targetAgentOf } from '../auth';
import { errorResponse, isJsonObject, jsonResponse, UUID_PATTERN, type ApiRequest, type ApiResponse } from '../http';

// 상한 상수는 콘솔과 같은 연산 모듈에 있다 — 옛 import 경로(테스트·요금제 대조)를 그대로 둔다.
export { MAX_WEBHOOK_ENDPOINTS_PER_AGENT, MAX_WEBHOOK_REGISTRATIONS_PER_DAY, MAX_WEBHOOK_ROTATIONS_PER_DAY } from '../../webhooks/management';

export interface WebhookEndpointRouteDependencies {
  readonly tokens: AgentTokenStore;
  /** 풀 — 등록은 상한 검사와 INSERT 를 한 트랜잭션(에이전트 잠금 아래)에서 한다. */
  readonly db: Pool;
  /** 웹훅 시크릿 마스터 키 묶음(`WEBHOOK_SECRET_KEYS_ENV`). 새 엔드포인트·새 버전은 활성 kid 로 파생한다. */
  readonly keyring: HmacKeyring;
  readonly now: () => Date;
}


type Preamble =
  | { readonly kind: 'ok'; readonly agentId: AgentId; readonly principal: AgentPrincipal }
  | { readonly kind: 'error'; readonly response: ApiResponse };

/**
 * 형식 → 인증 → 인가(대상은 경로 — `me` 면 토큰의 에이전트). 대상이 경로에 있으므로 **읽기 전에** 남의 것을 거른다. `access` — 목록은 권한 이름(`messages:read`),
 * 등록·삭제·회전은 관리 행위(`webhooks:manage` 판정 — 파일 머리말).
 */
async function preamble(
  deps: WebhookEndpointRouteDependencies,
  request: ApiRequest,
  agentIdRaw: string,
  access: { readonly capability: AgentTokenCapability } | { readonly manage: WebhookManageAction },
): Promise<Preamble> {
  // `me` = 토큰의 에이전트(`auth.claimedAgentOfPath`). id 를 적었으면 형식(400) · 인가는 오늘과 같다.
  const claimed = claimedAgentOfPath(agentIdRaw);
  if (claimed.kind === 'error') return claimed;
  const now = deps.now();
  const authentication = await authenticateRequest(deps.tokens, request, now);
  if (authentication.kind === 'error') return authentication;
  const agentId = targetAgentOf(authentication.principal, claimed.agentId);
  if ('capability' in access) {
    const forbidden = authorizeRequest(authentication.principal, access.capability, agentId);
    if (forbidden !== null) return { kind: 'error', response: forbidden };
    return { kind: 'ok', agentId, principal: authentication.principal };
  }
  const decision = authorizeWebhookManage(authentication.principal, agentId, access.manage, now);
  if (decision.kind === 'denied') return { kind: 'error', response: manageForbidden(decision.reason) };
  return { kind: 'ok', agentId, principal: authentication.principal };
}

/** 403 — `authorizeRequest` 와 **같은 모양**(`detail` = 사유 이름 그대로). 필요한 권한 이름은 문서가 말한다. */
export function manageForbidden(reason: 'not_own_agent' | 'capability_not_granted'): ApiResponse {
  return errorResponse(403, 'forbidden', reason);
}

interface RegistrationBody {
  readonly url: string;
  readonly eventTypes: WebhookEndpointEventTypes;
  /** 인증 헤더 값(규칙을 지난 것) — 없으면 `null`. */
  readonly authorization: string | null;
}

const REGISTRATION_KEYS: ReadonlySet<string> = new Set(['url', 'event_types', 'authorization']);

/**
 * 본문은 `{ "url": "https://..." }` 에 선택 `event_types` · `authorization` 뿐이다. 모르는 필드는 받지 않는다(시크릿을 고르게 두지 않는다).
 * 인증 헤더 값이 규칙을 어기면 그 사유(값 없이)를 따로 돌려준다.
 */
function parseRegistration(body: unknown): RegistrationBody | { readonly authorizationRejected: WebhookAuthorizationRejection } | null {
  if (!isJsonObject(body)) return null;
  const source = body;
  if (Object.keys(source).some((key) => !REGISTRATION_KEYS.has(key))) return null;
  const url = source['url'];
  if (typeof url !== 'string' || url === '') return null;
  const eventTypes = parseEventTypes(source['event_types']);
  if (eventTypes === 'invalid') return null;
  const authorization = parseWebhookAuthorization(source['authorization']);
  if (authorization.kind === 'invalid') return { authorizationRejected: authorization.reason };
  return { url, eventTypes, authorization: authorization.kind === 'value' ? authorization.value : null };
}

/**
 * 목록·회전 응답의 엔드포인트 모양 — 시크릿·kid 없음. 유예가 끝난 직전 시크릿은 `null` 로 보인다. `masked` 면 `url` 이 가린 값이고
 * `url_masked: true` 다(보안 L3 — `webhooks:manage` 가 없는 토큰의 목록).
 */
function endpointBody(endpoint: WebhookEndpointRecord, now: Date, masked = false): Record<string, unknown> {
  const previous = endpoint.previousSecret;
  return {
    id: endpoint.id,
    url: masked ? maskWebhookUrl(endpoint.url) : endpoint.url,
    url_masked: masked,
    event_types: subscribedTypes(endpoint.eventTypes),
    created_at: endpoint.createdAt.toISOString(),
    secret_version: endpoint.secretVersion,
    secret_rotated_at: endpoint.secretRotatedAt?.toISOString() ?? null,
    previous_secret_valid_until: previous !== null && previous.validUntil.getTime() > now.getTime() ? previous.validUntil.toISOString() : null,
    ...authorizationFields(endpoint),
  };
}

/** 인증 헤더의 보이는 모양 — 있음 · 힌트뿐(값은 어디에도 다시 나가지 않는다). */
function authorizationFields(endpoint: WebhookEndpointRecord): { readonly has_authorization: boolean; readonly authorization_hint: string | null } {
  return { has_authorization: endpoint.authorizationHint !== null, authorization_hint: endpoint.authorizationHint };
}

export async function handleRegisterWebhookEndpoint(
  deps: WebhookEndpointRouteDependencies,
  request: ApiRequest,
  params: { readonly agentId: string },
): Promise<ApiResponse> {
  const pre = await preamble(deps, request, params.agentId, { manage: 'register' });
  if (pre.kind === 'error') return pre.response;

  const parsed = parseRegistration(request.body);
  if (parsed === null) {
    return errorResponse(
      400,
      'invalid_request',
      `The body must be {"url": "https://...", "event_types"?: [...], "authorization"?: "..."}. event_types, if given, is a non-empty array of: ${WEBHOOK_EVENT_TYPES.join(', ')}.`,
    );
  }
  if ('authorizationRejected' in parsed) {
    return errorResponse(400, 'invalid_authorization', webhookAuthorizationRejectionDetail(parsed.authorizationRejected));
  }

  // 인증 헤더는 INSERT 전에 봉인한다 — 저장될 정규화 URL 에 묶는다(디스패처가 같은 문자열로 연다).
  // 엔드포인트 id 도 INSERT 전에 만든다 — 봉인 AAD 에 들어간다(보안 리뷰 L2: 봉인값을 다른 · 다시 만든 엔드포인트로 옮기면 열리지 않는다).
  const endpointId = randomUUID();
  let authorization: WebhookRegistrationAuthorization | null = null;
  if (parsed.authorization !== null) {
    const checked = checkWebhookUrl(parsed.url);
    if (checked.kind === 'rejected') return errorResponse(400, 'invalid_webhook_url', checked.reason);
    const url = checked.url.href;
    authorization = { endpointId, url, sealed: sealWebhookAuthorization(deps.keyring, { agentId: pre.agentId, endpointId, generation: 1, url }, parsed.authorization) };
  }

  const { kid } = activeKey(deps.keyring);
  const registered = await registerWebhookEndpoint(
    deps.db,
    { agentId: pre.agentId, url: parsed.url, eventTypes: parsed.eventTypes, kid, via: 'api', authorization, endpointId },
    deps.now(),
  );
  if (registered.kind === 'limit') {
    return errorResponse(409, 'webhook_endpoint_limit', `Your plan allows at most ${String(registered.limit)} active webhook endpoints per agent.`);
  }
  if (registered.kind === 'registration_limit') {
    return errorResponse(
      409,
      'webhook_endpoint_registration_limit',
      `An agent can register at most ${String(MAX_WEBHOOK_REGISTRATIONS_PER_DAY)} webhook endpoints per 24 hours, including deleted ones.`,
    );
  }
  if (registered.kind === 'rejected') return errorResponse(400, 'invalid_webhook_url', registered.reason);
  // 삭제한 에이전트(202610131000) — 인증이 이미 401 로 막지만(토큰을 폐기된 것으로 읽는다) 인증과 등록 사이에 삭제가 커밋된 경합의 답.
  if (registered.kind === 'agent_deleted') return errorResponse(403, 'agent_not_active', 'This agent was deleted.');

  // ★ **이 응답과 회전 응답이 시크릿이 나가는 유일한 자리다.**
  const { endpoint } = registered;
  const secret = deriveEndpointSecret(deps.keyring, endpoint);
  // 보안 L2 — 등록 사실 한 줄(값 없이: 엔드포인트 id · URL 호스트만 — 경로·쿼리·시크릿 없음).
  log('info', 'webhook.endpoint_registered', {
    agent_id: pre.agentId,
    route_id: 'webhooks:register:api',
    outcome: 'registered',
    detail: `endpoint:${endpoint.id} host:${webhookUrlHost(endpoint.url)}`,
  });
  return jsonResponse(201, {
    id: endpoint.id,
    agent_id: pre.agentId,
    url: endpoint.url,
    event_types: subscribedTypes(endpoint.eventTypes),
    ...authorizationFields(endpoint),
    secret,
    secret_notice: 'This secret cannot be retrieved again. If you lose it, rotate the secret or register a new endpoint.',
  });
}

/**
 * `DELETE /v1/agents/{agentId}/webhook-endpoints/{endpointId}` — 엔드포인트 **소프트 삭제**(메일 기본기 A4, `webhooks:manage`).
 *
 * `disabled_at` 을 한 번 찍는다(쓰기 1회 — 되살리는 길은 없다, 다시 받으려면 새로 등록한다). 삭제 뒤 그 엔드포인트로 가는 **새 전달은 0행**이다
 * (적재가 켜진 엔드포인트만 고른다). 이미 적힌 pending 전달은 디스패처가 `endpoint_disabled` 로 dead 처리한다 — 지운 URL 로 더 나가지 않는다.
 * 없는 id · 남의 에이전트 것 · 이미 지운 것은 모두 같은 404 다(존재를 알리지 않는다).
 */
export async function handleDeleteWebhookEndpoint(
  deps: WebhookEndpointRouteDependencies,
  request: ApiRequest,
  params: { readonly agentId: string; readonly endpointId: string },
): Promise<ApiResponse> {
  const pre = await preamble(deps, request, params.agentId, { manage: 'delete' });
  if (pre.kind === 'error') return pre.response;
  if (!UUID_PATTERN.test(params.endpointId)) {
    return errorResponse(400, 'invalid_request', 'endpoint id must be a lowercase uuid.');
  }
  const disabledAt = await disableWebhookEndpoint(deps.db, pre.agentId, params.endpointId);
  if (disabledAt === null) return errorResponse(404, 'not_found', 'Webhook endpoint not found.');
  log('info', 'webhook.endpoint_deleted', {
    agent_id: pre.agentId,
    route_id: 'webhooks:delete:api',
    outcome: 'deleted',
    detail: `endpoint:${params.endpointId}`,
  });
  return jsonResponse(200, {
    id: params.endpointId,
    agent_id: pre.agentId,
    deleted_at: disabledAt.toISOString(),
  });
}

/**
 * `POST /v1/agents/{agentId}/webhook-endpoints/{endpointId}/rotate-secret` — 시크릿 회전(`webhooks:manage`) → 200
 * `{endpoint, secret, previous_valid_until}`. 본문 없음. 직전 시크릿은 `previous_valid_until` 까지 유효하고, 그동안 모든 전달에 서명이 둘 실린다
 * (`webhook-signature: v1,<새> v1,<옛>`). 없는 id · 남의 것 · 지운 것 → 404. 엔드포인트당 24시간 10회 → 429.
 */
export async function handleRotateWebhookSecret(
  deps: WebhookEndpointRouteDependencies,
  request: ApiRequest,
  params: { readonly agentId: string; readonly endpointId: string },
): Promise<ApiResponse> {
  const pre = await preamble(deps, request, params.agentId, { manage: 'rotate' });
  if (pre.kind === 'error') return pre.response;
  if (!UUID_PATTERN.test(params.endpointId)) {
    return errorResponse(400, 'invalid_request', 'endpoint id must be a lowercase uuid.');
  }
  const { kid } = activeKey(deps.keyring);
  const rotated = await supersedeWebhookSecret(deps.db, { agentId: pre.agentId, endpointId: params.endpointId, kid, via: 'api' });
  if (rotated.kind === 'not_found') return errorResponse(404, 'not_found', 'Webhook endpoint not found.');
  if (rotated.kind === 'rate_limited') {
    return errorResponse(
      429,
      'webhook_rotation_rate_limited',
      `A webhook endpoint's secret can be rotated at most ${String(MAX_WEBHOOK_ROTATIONS_PER_DAY)} times per 24 hours. Try again later.`,
    );
  }
  return jsonResponse(200, {
    endpoint: endpointBody(rotated.endpoint, deps.now()),
    secret: deriveEndpointSecret(deps.keyring, rotated.endpoint),
    previous_valid_until: rotated.previousValidUntil.toISOString(),
    secret_notice:
      'This secret cannot be retrieved again. Until previous_valid_until, each delivery carries signatures from both the new and the previous secret.',
  });
}

export async function handleListWebhookEndpoints(
  deps: WebhookEndpointRouteDependencies,
  request: ApiRequest,
  params: { readonly agentId: string },
): Promise<ApiResponse> {
  const pre = await preamble(deps, request, params.agentId, { capability: 'messages:read' });
  if (pre.kind === 'error') return pre.response;

  const endpoints = await listWebhookEndpoints(deps.db, pre.agentId);
  const now = deps.now();
  // 보안 L3 — URL 전체는 웹훅을 관리할 수 있는 토큰에만. 읽기 토큰(옛 토큰 포함)은 가린 값(경로·쿼리에 수신측 토큰이 있을 수 있다).
  const masked = !pre.principal.capabilities.includes('webhooks:manage');
  return jsonResponse(200, {
    agent_id: pre.agentId,
    // 시크릿·kid 를 싣지 않는다 — 레코드 타입에 시크릿이 없고, kid 는 서버의 키 운용 사정이다. 버전은 회전 여부를 알리는 번호일 뿐이다.
    endpoints: endpoints.map((endpoint) => endpointBody(endpoint, now, masked)),
  });
}
