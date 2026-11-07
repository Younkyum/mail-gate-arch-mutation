/**
 * `POST /v1/messages/scheduled` — 예약 발송 **생성** (P3c). 보내는 것은 `workers/scheduled-sender` 다.
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다 — 판단 기록.** 이 라우트는 행 하나와 본문 객체 하나를 쓸 뿐
 * 메일을 내보내지 않는다. 발송 경로는 워커(`OUTBOUND_ROUTES.scheduled_send`, kind: 'worker')이고, 그 워커가
 * **발송 시점에** 관문을 지난다(Layer D 매트릭스가 그 워커를 구동한다). 이 라우트를 `OUTBOUND_ROUTES` 에 넣으면
 * 관문 평가가 **예약 시점에** 한 번 더 생기고, 그 판정은 발송 때 다시 평가돼야 하므로 audit 에 뜻 없는 행이
 * 쌓이거나(두 번 평가) — 더 나쁘게는 — 누군가 "이미 평가했다" 며 워커에서 평가를 빼는 날이 온다(계획 프리모템의
 * 그 사고). 평가 지점은 하나, 발송 시점이다.
 *
 * 그래도 **`Idempotency-Key` 는 요구한다**(§4.5-1 의 정신 — 에이전트 SDK 의 재시도가 예약을 둘로 만들면 메일이
 * 두 통 나간다). 매니페스트의 http 순회(Layer D)는 이 파일을 모르므로 이 파일의 테스트가 그 400 을 따로 단언한다.
 *
 * 순서는 발송 라우트와 같다: ① 키 → ② 인증 → ③ 본문 → ④ 인가(본문의 `agent_id`) → 예약.
 * 본문 객체를 **먼저** 쓰고 행을 만든다 — 행이 있으면 본문도 있다(반대 순서면 본문 없는 예약이 생긴다).
 *
 * `agent_cancellable`(선택, 기본 true — 메일 기본기 A3 완화 ④): `false` 면 이 예약은 에이전트 토큰으로 취소할 수 없다 — HTTP `POST …/cancel` 과 MCP `cancel_scheduled` 모두 403 이고, 우회는 소유자 콘솔뿐이다.
 * **생성 때만** 정하고 DB 가 불변으로 지킨다. 요청 해시에는 `false` 일 때만 들어간다 — 기본값 요청의 해시는 이 칸이 생기기 전과 같다.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { AgentTokenStore } from '../../identity/agent-token';
import type { ScheduledSendRecord, ScheduledSendStore } from '../../db/repositories/scheduled-send-store';
import type { ScheduledContentStore } from '../../storage/scheduled-content-store';
import { authenticateRequest, authorizeRequest, bodyWithDefaultAgent } from '../auth';
import { errorResponse, jsonResponse, requireIdempotencyKey, type ApiRequest, type ApiResponse } from '../http';
import { parseSendBody, rejectAttachmentsOn } from '../outbound-http';
import { pinScheduledRisk, type OutboundServiceDependencies } from '../outbound-service';

export interface ScheduledMessageRouteDependencies {
  readonly tokens: AgentTokenStore;
  readonly schedules: ScheduledSendStore;
  readonly content: ScheduledContentStore;
  readonly now: () => Date;
  /**
   * 예약 생성 때 위험을 고정할 재료(ADR-0016 리뷰 H1 — 발송 서비스의 위험 신호 포트 · 발신 DLP). 필수다 — 없으면 예약이 오염 창을 넘는 우회로가 된다.
   */
  readonly risk: Pick<OutboundServiceDependencies, 'riskSignals' | 'dlp' | 'now'>;
}

/** 예약 가능한 가장 먼 미래. 더 멀면 그 사이 정책·주소가 바뀔 여지만 커지고, 에이전트의 의도는 낡는다. */
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 3600 * 1000;
/** 과거 시각 허용 오차(시계 차이). 이보다 과거면 "예약" 이 아니라 즉시 발송이다 — `POST /v1/messages` 를 쓰라. */
const SCHEDULE_PAST_SKEW_MS = 60 * 1000;

function scheduledBody(record: ScheduledSendRecord, replayed: boolean): Record<string, unknown> {
  return {
    status: record.status,
    schedule_id: record.id,
    send_at: record.sendAt.toISOString(),
    replayed,
    agent_cancellable: record.agentCancellable,
    // 재생(같은 키로 다시 POST)이면 그사이 취소됐을 수 있다 — `status`·`cancelled_at` 으로 알린다(코드 리뷰 L6).
    cancelled_at: record.cancelledAt === null ? null : record.cancelledAt.toISOString(),
    dispatch_outcome: record.dispatchOutcome,
    message_id: record.messageId,
    detail: 'The policy check runs at send time. If the policy changes before then, the decision at send time applies.',
  };
}

export async function handleCreateScheduledMessage(
  deps: ScheduledMessageRouteDependencies,
  request: ApiRequest,
): Promise<ApiResponse> {
  const key = requireIdempotencyKey(request);
  if (key.kind === 'error') return key.response;

  const now = deps.now();
  const authentication = await authenticateRequest(deps.tokens, request, now);
  if (authentication.kind === 'error') return authentication.response;

  // 첨부는 새 메일·답장만(D8) — 예약 발송은 본문만 저장한다.
  const attachmentsHere = rejectAttachmentsOn('scheduled emails', request.body);
  if (attachmentsHere !== null) return attachmentsHere;
  const body = parseSendBody(bodyWithDefaultAgent(request.body, authentication.principal));
  if (body.kind === 'error') return body.response;
  const forbidden = authorizeRequest(authentication.principal, 'messages:send', body.value.agentId);
  if (forbidden !== null) return forbidden;

  const sendAtRaw = (request.body as Record<string, unknown>)['send_at'];
  const sendAt = typeof sendAtRaw === 'string' ? new Date(sendAtRaw) : null;
  if (sendAt === null || Number.isNaN(sendAt.getTime())) {
    return errorResponse(400, 'invalid_request', 'send_at (an ISO 8601 time) is required.');
  }
  if (sendAt.getTime() < now.getTime() - SCHEDULE_PAST_SKEW_MS) {
    return errorResponse(400, 'invalid_request', 'send_at is in the past. To send now, use POST /v1/messages.');
  }
  if (sendAt.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) {
    return errorResponse(400, 'invalid_request', 'send_at must be within 30 days.');
  }
  if (body.value.subject.trim() === '') return errorResponse(400, 'invalid_request', 'subject must not be empty.');
  const agentCancellableRaw = (request.body as Record<string, unknown>)['agent_cancellable'];
  if (agentCancellableRaw !== undefined && typeof agentCancellableRaw !== 'boolean') {
    return errorResponse(400, 'invalid_request', 'agent_cancellable must be true or false.');
  }
  const agentCancellable = agentCancellableRaw ?? true;

  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        fromAddress: body.value.fromAddress,
        recipients: [...body.value.recipients].sort(),
        subject: body.value.subject,
        text: body.value.text,
        html: body.value.html,
        sendAt: sendAt.toISOString(),
        costCents: body.value.costCents,
        ...(agentCancellable ? {} : { agentCancellable: false }),
      }),
      'utf8',
    )
    .digest('hex');

  // ADR-0016 리뷰 H1 — 만들 때의 오염 맥락·DLP 계열을 행에 고정한다(발송 때 그때의 판정과 합친다 — 미뤄서 우회하지 못하게).
  const risk = await pinScheduledRisk(deps.risk, {
    routeId: 'scheduled_send',
    agentId: body.value.agentId,
    traceId: body.value.traceId,
    recipients: body.value.recipients,
    subject: body.value.subject,
    text: body.value.text,
    html: body.value.html,
  });

  const id = randomUUID();
  await deps.content.put(id, { subject: body.value.subject, text: body.value.text, html: body.value.html });
  const outcome = await deps.schedules.create({
    id,
    agentId: body.value.agentId,
    idempotencyKey: key.key,
    requestHash,
    fromAddress: body.value.fromAddress,
    recipients: body.value.recipients,
    sendAt,
    contentStorageKey: deps.content.keyFor(id),
    traceId: body.value.traceId,
    costCents: body.value.costCents,
    agentCancellable,
    risk,
  });

  if (outcome.kind === 'existing') {
    if (outcome.record.requestHash !== requestHash) {
      return jsonResponse(409, {
        error: 'idempotency_key_reused',
        detail: 'This Idempotency-Key was already used for a different schedule request.',
        schedule_id: outcome.record.id,
      });
    }
    return jsonResponse(202, scheduledBody(outcome.record, true));
  }
  return jsonResponse(202, scheduledBody(outcome.record, false));
}
