/**
 * 웹훅 **전달 목록·재전송**(메일 기본기 A4, `.omc/plans/mail-basics.md` §4 A4).
 *
 *   `GET  /v1/agents/{agentId}/webhook-deliveries?status=&cursor=&limit=`     — 전달 목록(`messages:read`). 본문·URL 없음.
 *   `POST /v1/agents/{agentId}/webhook-deliveries/{deliveryId}/redeliver`     — 재전송(`webhooks:manage`). 새 전달 행을 만든다. 본문 없음.
 *
 * MCP 도구 `list_webhook_deliveries`·`redeliver_webhook` 이 이 두 함수를 그대로 부른다(2026-09-30 확대 — `src/mcp/tools.ts`).
 *
 * **목록은 본문·URL·dedupe 키를 싣지 않는다.** 본문은 이벤트 id 로 이미 받은(받을) 것이고 URL 은 엔드포인트 목록에 있다 — 레코드 타입
 * (`WebhookDeliveryRecord`)에 그 자리가 없다. 삭제된 엔드포인트의 전달도 보인다(기록이다).
 *
 * **재전송 규칙**(저장소 `redeliverWebhookDelivery` + DB 가드 트리거):
 *   - 대상은 `dead` 인 행이다(pending 은 아직 시도 중, delivered 는 이미 받았다) → 아니면 409 `delivery_not_dead`.
 *   - 엔드포인트가 켜져 있어야 한다 → 409 `webhook_endpoint_deleted`.
 *   - 가족(루트 + 재전송)에 목적지 거부류(`blocked_destination`·`invalid_url`·`endpoint_disabled`)로 죽은 행이 없어야 한다 → 409
 *     `redelivery_destination_rejected`. 다시 보내면 SSRF 탐침을 반복해 줄 뿐이다.
 *   - 가족에 이미 `delivered` 인 행이 있으면(앞선 재전송이 성공했다) → 409 `delivery_already_delivered`(코드 리뷰 L13).
 *   - 새 행의 `redelivery_of` 는 **루트**다 — 재전송 행을 지정해도 루트로 귀속된다(사슬이 없다). 루트당 3회가 천장 → 409 `redelivery_limit`.
 *   - 에이전트 하나의 재전송은 1시간 100건까지다 → 429 `redelivery_rate_limited`(보안 L5).
 *   - 새 행은 루트와 같은 `event_id`·body 를 쓴다(수신측은 같은 id 로 멱등 처리한다). 메트릭 `webhookRedelivered`.
 *
 * 권한(ADR-0013 2026-09-30 개정): 목록 `messages:read` · 재전송 `webhooks:manage`(외부로 HTTP 를 다시 내보내는 행동). 옛 토큰은 2026-12-31 까지
 * `messages:send` 로도 재전송할 수 있다 — 판정은 등록·삭제와 같은 `webhooks/management.ts` `authorizeWebhookManage` 하나다.
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 행을 읽거나 outbox 행 하나를 쓸 뿐 메일도 HTTP 도 보내지 않는다(전달은
 * webhook-dispatcher 워커). 관문을 import 하지 않는다.
 */

import type { Pool } from 'pg';

import type { AgentId } from '../../db/schema';
import {
  listWebhookDeliveries,
  MAX_REDELIVERIES_PER_AGENT_HOURLY,
  MAX_REDELIVERIES_PER_ROOT,
  redeliverWebhookDelivery,
  WEBHOOK_DELIVERY_STATUSES,
  type WebhookDeliveryRecord,
} from '../../db/repositories/webhook-store';
import type { AgentTokenStore } from '../../identity/agent-token';
import { countMetric, METRIC_NAMES } from '../../observability/metrics';
import { authorizeWebhookManage, decodeDeliveryCursor, encodeDeliveryCursor } from '../../webhooks/management';
import { authenticateRequest, authorizeRequest, claimedAgentOfPath, targetAgentOf } from '../auth';
import { errorResponse, jsonResponse, pageLimitOf, pageOf, queryOf, UUID_PATTERN, type ApiRequest, type ApiResponse } from '../http';
import { manageForbidden } from './webhook-endpoints';

export interface WebhookDeliveryRouteDependencies {
  readonly tokens: AgentTokenStore;
  /** 풀 — 재전송은 대상 확인과 새 행 INSERT 를 한 트랜잭션에서 한다(`webhook-store.ts` 의 연산). */
  readonly db: Pool;
  readonly now: () => Date;
}

const DEFAULT_WEBHOOK_DELIVERY_PAGE_SIZE = 20;
const MAX_WEBHOOK_DELIVERY_PAGE_SIZE = 100;


type Preamble =
  | { readonly kind: 'ok'; readonly agentId: AgentId }
  | { readonly kind: 'error'; readonly response: ApiResponse };

/** 형식 → 인증 → 인가(대상은 경로). `webhook-endpoints.ts` 와 같은 순서다. 목록은 `messages:read`, 재전송은 웹훅 관리 판정. */
async function preamble(
  deps: WebhookDeliveryRouteDependencies,
  request: ApiRequest,
  agentIdRaw: string,
  access: 'list' | 'redeliver',
): Promise<Preamble> {
  // `me` = 토큰의 에이전트(`auth.claimedAgentOfPath`). id 를 적었으면 형식(400) · 인가는 오늘과 같다.
  const claimed = claimedAgentOfPath(agentIdRaw);
  if (claimed.kind === 'error') return claimed;
  const now = deps.now();
  const authentication = await authenticateRequest(deps.tokens, request, now);
  if (authentication.kind === 'error') return authentication;
  const agentId = targetAgentOf(authentication.principal, claimed.agentId);
  if (access === 'list') {
    const forbidden = authorizeRequest(authentication.principal, 'messages:read', agentId);
    if (forbidden !== null) return { kind: 'error', response: forbidden };
    return { kind: 'ok', agentId };
  }
  const decision = authorizeWebhookManage(authentication.principal, agentId, 'redeliver', now);
  if (decision.kind === 'denied') return { kind: 'error', response: manageForbidden(decision.reason) };
  return { kind: 'ok', agentId };
}

// 커서 — (created_at 에포크 마이크로초, id) 의 불투명 인코딩. 콘솔 전달 목록과 같은 함수다(`webhooks/management.ts`).
export { decodeDeliveryCursor, encodeDeliveryCursor } from '../../webhooks/management';

function deliveryBody(delivery: WebhookDeliveryRecord): Record<string, unknown> {
  return {
    id: delivery.id,
    event_id: delivery.eventId,
    event_type: delivery.eventType,
    endpoint_id: delivery.endpointId,
    status: delivery.status,
    attempt_count: delivery.attemptCount,
    last_error: delivery.lastError,
    last_http_status: delivery.lastHttpStatus,
    redelivery_of: delivery.redeliveryOf,
    created_at: delivery.createdAt.toISOString(),
    // pending 일 때만 뜻이 있다(다음 시도 또는 임대 만료 시각). 종단 행에는 싣지 않는다.
    next_attempt_at: delivery.status === 'pending' ? delivery.nextAttemptAt.toISOString() : null,
    delivered_at: delivery.deliveredAt?.toISOString() ?? null,
    dead_at: delivery.deadAt?.toISOString() ?? null,
  };
}

export async function handleListWebhookDeliveries(
  deps: WebhookDeliveryRouteDependencies,
  request: ApiRequest,
  params: { readonly agentId: string },
): Promise<ApiResponse> {
  const paged = pageLimitOf(request, DEFAULT_WEBHOOK_DELIVERY_PAGE_SIZE, MAX_WEBHOOK_DELIVERY_PAGE_SIZE);
  if (paged.kind === 'error') return paged.response;
  const { limit } = paged;
  const statusRaw = queryOf(request, 'status');
  const status = WEBHOOK_DELIVERY_STATUSES.find((candidate) => candidate === statusRaw) ?? null;
  if (statusRaw !== null && status === null) {
    return errorResponse(400, 'invalid_request', `status must be one of: ${WEBHOOK_DELIVERY_STATUSES.join(', ')}.`);
  }
  const cursorRaw = queryOf(request, 'cursor');
  const cursor = cursorRaw === null ? null : decodeDeliveryCursor(cursorRaw);
  if (cursorRaw !== null && cursor === null) return errorResponse(400, 'invalid_request', 'cursor is not valid.');

  const pre = await preamble(deps, request, params.agentId, 'list');
  if (pre.kind === 'error') return pre.response;

  const rows = await listWebhookDeliveries(deps.db, pre.agentId, { limit: limit + 1, cursor, status });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeDeliveryCursor({ createdMicros: last.createdMicros, id: last.id }));
  return jsonResponse(200, {
    agent_id: pre.agentId,
    deliveries: page.map(deliveryBody),
    next_cursor: nextCursor,
  });
}

export async function handleRedeliverWebhookDelivery(
  deps: WebhookDeliveryRouteDependencies,
  request: ApiRequest,
  params: { readonly agentId: string; readonly deliveryId: string },
): Promise<ApiResponse> {
  const pre = await preamble(deps, request, params.agentId, 'redeliver');
  if (pre.kind === 'error') return pre.response;
  if (!UUID_PATTERN.test(params.deliveryId)) return errorResponse(400, 'invalid_request', 'delivery id must be a lowercase uuid.');

  const result = await redeliverWebhookDelivery(deps.db, pre.agentId, params.deliveryId, deps.now());
  switch (result.kind) {
    case 'not_found':
      return errorResponse(404, 'not_found', 'Webhook delivery not found.');
    case 'not_dead':
      return errorResponse(409, 'delivery_not_dead', 'Only dead deliveries can be redelivered. Pending deliveries are still being retried, and delivered ones were already received.');
    case 'endpoint_disabled':
      return errorResponse(409, 'webhook_endpoint_deleted', 'Deliveries to a deleted endpoint cannot be redelivered.');
    case 'destination_rejected':
      return errorResponse(
        409,
        'redelivery_destination_rejected',
        'Deliveries that failed because the destination was rejected (blocked_destination, invalid_url, endpoint_disabled) cannot be redelivered. Register a new endpoint with a corrected URL.',
      );
    case 'already_delivered':
      return errorResponse(409, 'delivery_already_delivered', 'This delivery (or a redelivery of it) was already received, so it is not sent again.');
    case 'limit_reached':
      return errorResponse(409, 'redelivery_limit', `A delivery can be redelivered at most ${String(MAX_REDELIVERIES_PER_ROOT)} times.`);
    case 'agent_rate_limited':
      return errorResponse(
        429,
        'redelivery_rate_limited',
        `An agent can redeliver at most ${String(MAX_REDELIVERIES_PER_AGENT_HOURLY)} deliveries per hour. Try again later.`,
      );
    case 'redelivered':
      countMetric(METRIC_NAMES.webhookRedelivered);
      return jsonResponse(201, {
        id: result.deliveryId,
        agent_id: pre.agentId,
        redelivery_of: result.redeliveryOf,
        event_id: result.eventId,
        status: 'pending',
        redeliveries_used: result.ordinal,
        redeliveries_max: MAX_REDELIVERIES_PER_ROOT,
      });
  }
}
