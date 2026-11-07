/**
 * `POST /v1/drafts/{id}/send` — 초안을 보낸다 (`OUTBOUND_ROUTES.draft_send`, 묶음 B).
 *
 * **새 우회로가 아니다.** 초안은 `send`·`reply` 와 **같은** 앞(`prepareOutbound`·`prepareReplyOutbound` — 멱등 · 첨부 검증 · 발신 DLP) · 관문
 * (`dispatch` — 이 파일 안에 보인다, Layer C) · 뒤(`finalizeOutbound`)를 지난다. 다른 것은 내용의 출처뿐이다: 요청 본문이 아니라 **초안 행 + 본문 객체**
 * (`storage/draft-content-store.ts`)다. 답장 초안(`in_reply_to`)은 회신 라우트와 같은 기본값 · 같은 복사 비교(`copyTargetsOf`)로 그 메일의 권한용 스레드에
 * 답한다 — 스레드 회신인지는 관문의 로더가 DB 에서 다시 정한다.
 *
 * **순서**(`route-context.ts` 와 같다): ① `Idempotency-Key`(필수 — Layer D 가 자동 검사) → ② 인증 → ③ 본문(`agent_id` — 생략하면 토큰의 에이전트, 본문 자체도 생략할 수 있다) →
 * ④ 인가(`messages:send`) → 초안 → 관문.
 *
 * **보낸 초안은 굳는다.** 관문에 닿기 전에 초안에 키를 건다(`claimSend` — 그 뒤로 내용 · 버리기가 막힌다, DB 트리거). 관문이 평가한 시도(보냄 · 거부 ·
 * 승인 대기 · 실패)는 메시지 id 가 초안에 적힌다 — 그 초안은 다시 보낼 수 없다(같은 키의 재호출은 첫 결과의 재생). 관문 앞에서 멈춘 시도(모자란 초안 ·
 * 첨부 거부 · 다른 요청에 쓴 키)는 키를 놓는다 — 고쳐서 다시 보낸다. 다른 키로 보낸 초안은 409 `draft_already_sent`.
 */

import { dispatch, type OutboundTransport } from '../../policy/gate';
import { isOutboundRecipientAddress } from '../../policy/contact-rules';
import { replyThreading } from '../../mail/mime/build';
import type { DraftRow, DraftStore } from '../../db/repositories/draft-store';
import type { ReplyTargetLookup } from '../../db/repositories/reply-target-store';
import { isAgentId, toAgentId, type AgentId } from '../../db/schema';
import { log } from '../../observability/logger';
import { countMetric, METRIC_NAMES } from '../../observability/metrics';
import type { InboundArtifactReader } from '../../storage/inbound-artifact-store';
import type { DraftContentStore } from '../../storage/draft-content-store';
import { errorResponse, isJsonObject, jsonResponse, UUID_PATTERN, type ApiResponse } from '../http';
import { INVALID_RECIPIENT, invalidRecipientDetail, toApiResponse } from '../outbound-http';
import {
  finalizeOutbound,
  gateDependenciesFor,
  prepareOutbound,
  prepareReplyOutbound,
  type OutboundOutcome,
  type OutboundSendRequest,
  type PreparedOutbound,
} from '../outbound-service';
import { preflightWith, type BodyParser, type OutboundRouteDependencies } from '../route-context';
import type { ApiRequest } from '../http';
import { copyTargetsOf, replySubject } from './reply';
import { draftNotFound, draftStatus, draftContentExpired, loadContent } from './drafts';

/** 매니페스트의 `id` 와 **같은 문자열이어야 한다** — 관문이 그 값으로 대조한다. */
const DRAFT_SEND_ROUTE_ID = 'draft_send';

export interface DraftSendRouteDependencies extends OutboundRouteDependencies {
  /** 전송단 — 주입받는다(`send.ts` 와 같다 — Layer B). */
  readonly transport: OutboundTransport;
  readonly drafts: DraftStore;
  readonly draftContent: DraftContentStore;
  /** 답장 초안의 대상(회신 라우트와 같은 조회 — 권한을 주지 않는다). */
  readonly replyTargets: ReplyTargetLookup;
  /** 수신자를 바꾼 답장의 원문 읽기(복사 비교 — `reply.ts` 와 같다). */
  readonly artifacts: InboundArtifactReader;
}

interface DraftSendBody {
  readonly agentId: AgentId;
  readonly traceId: string | null;
  /** Stage 5 의 예산 판정에 더하는 비용(`POST /v1/messages` 의 `cost_cents` 와 같다). */
  readonly costCents: number;
}

const parseDraftSendBody: BodyParser<DraftSendBody> = (body) => {
  const source = isJsonObject(body) ? body : null;
  if (source === null) return { kind: 'error', response: errorResponse(400, 'invalid_request', 'The request body must be a JSON object.') };
  const unknown = Object.keys(source).find((key) => key !== 'agent_id' && key !== 'trace_id' && key !== 'cost_cents');
  if (unknown !== undefined) {
    return {
      kind: 'error',
      response: errorResponse(400, 'invalid_request', `Unknown field: ${unknown.slice(0, 40)}. The draft is sent as saved — change it with PATCH /v1/drafts/{id} first.`),
    };
  }
  const agentId = source['agent_id'];
  if (typeof agentId !== 'string' || !isAgentId(agentId)) {
    return { kind: 'error', response: errorResponse(400, 'invalid_request', 'agent_id must be 32 lowercase hex characters.') };
  }
  const trace = source['trace_id'];
  if (trace !== undefined && trace !== null && (typeof trace !== 'string' || trace.length > 200)) {
    return { kind: 'error', response: errorResponse(400, 'invalid_request', 'trace_id must be a string of at most 200 characters.') };
  }
  const cost = source['cost_cents'];
  if (cost !== undefined && (typeof cost !== 'number' || !Number.isInteger(cost) || cost < 0)) {
    // 음수 비용은 Stage 5 의 부등호를 뒤집는다(`outbound-http.ts` 와 같은 이유).
    return { kind: 'error', response: errorResponse(400, 'invalid_request', 'cost_cents must be a non-negative integer.') };
  }
  return {
    kind: 'ok',
    value: {
      agentId: toAgentId(agentId),
      traceId: typeof trace === 'string' && trace.trim() !== '' ? trace.trim() : null,
      costCents: typeof cost === 'number' ? cost : 0,
    },
  };
};

/** 관문 앞에서 끝난 요청 — `route-context.observeRejection` 과 같은 축. */
function rejectBeforeGate(response: ApiResponse): ApiResponse {
  const code = response.body['error'];
  countMetric(METRIC_NAMES.preflightRejected, { route_id: DRAFT_SEND_ROUTE_ID });
  log('warn', 'api.preflight_rejected', {
    route_id: DRAFT_SEND_ROUTE_ID,
    http_status: response.status,
    error_code: typeof code === 'string' ? code : null,
  });
  return response;
}

function incomplete(what: string): ApiResponse {
  return errorResponse(400, 'draft_incomplete', `This draft cannot be sent yet: ${what} Update it with PATCH /v1/drafts/{id}.`);
}

/** 관문 앞의 준비 — 초안에서 발송 요청을 만든다. 응답이면 관문 앞에서 끝난다(키를 놓는다). */
async function prepareDraft(
  deps: DraftSendRouteDependencies,
  draft: DraftRow,
  body: DraftSendBody,
  idempotencyKey: string,
): Promise<PreparedOutbound | ApiResponse> {
  const content = await loadContent(deps.draftContent, draft);
  if (content === null) return draftContentExpired();
  const base = {
    routeId: DRAFT_SEND_ROUTE_ID,
    agentId: body.agentId,
    idempotencyKey,
    text: content.text,
    html: content.html,
    isThreadReply: false as const,
    traceId: body.traceId,
    costCents: body.costCents,
    ...(draft.attachmentIds.length === 0 ? {} : { attachmentIds: draft.attachmentIds }),
  };

  if (draft.inReplyTo === null) {
    if (draft.fromAddress === null) return incomplete('from is missing.');
    if (draft.recipients.length === 0) return incomplete('to has no recipients.');
    if (draft.subject === null) return incomplete('subject is missing.');
    const request: OutboundSendRequest = { ...base, fromAddress: draft.fromAddress, recipients: draft.recipients, subject: draft.subject };
    return prepareOutbound(deps.service, request);
  }

  // 답장 초안 — 회신 라우트와 같은 확인 · 기본값(`reply.ts`).
  const target = await deps.replyTargets.find(body.agentId, draft.inReplyTo);
  if (target === null || target.quarantined) return errorResponse(404, 'message_not_found', `No received email matches in_reply_to=${draft.inReplyTo}.`);
  if (draft.recipients.length === 0 && !isOutboundRecipientAddress(target.fromAddress)) {
    return errorResponse(400, INVALID_RECIPIENT, invalidRecipientDetail([target.fromAddress]));
  }
  const fromAddress = draft.fromAddress ?? target.defaultFromAddress ?? null;
  if (fromAddress === null) return incomplete('from is missing and this email has no default sending address.');
  const subject = draft.subject ?? replySubject(target.subject);
  if (subject === null) return incomplete('the received email has no subject, so subject is required.');
  const recipients = draft.recipients.length > 0 ? draft.recipients : [target.fromAddress];
  const copyTargets = await copyTargetsOf(deps, target, recipients);
  return prepareReplyOutbound(
    deps.service,
    { ...base, fromAddress, recipients, subject, ...(copyTargets.length === 0 ? {} : { copyTargets }) },
    {
      threadId: target.threadId,
      inboundMessageId: target.inboundMessageId,
      threading: replyThreading(target.messageIdHeader, target.inReplyTo === null ? [] : [target.inReplyTo]),
    },
  );
}

/** 결과에 메시지 행이 있는가 — 관문이 평가했거나(보냄 · 거부 · 승인 대기 · 실패) 같은 키의 첫 결과를 재생했다. */
function messageIdOf(outcome: OutboundOutcome): string | null {
  switch (outcome.kind) {
    case 'sent':
    case 'denied':
    case 'pending_approval':
    case 'failed':
      return outcome.messageId;
    case 'replayed':
      return outcome.message.id;
    case 'conflict':
    case 'invalid':
    case 'attachment_rejected':
      return null;
  }
}

function withDraft(response: ApiResponse, draftId: string, status: string): ApiResponse {
  return jsonResponse(response.status, { ...response.body, draft_id: draftId, draft_status: status });
}

export async function handleSendDraft(
  deps: DraftSendRouteDependencies,
  request: ApiRequest,
  params: { readonly draftId: string },
): Promise<ApiResponse> {
  // 본문이 없으면 `{}` — 보낼 것은 초안에 다 있고, `agent_id` 는 생략하면 토큰의 에이전트다(`preflightWith`).
  const pre = await preflightWith(deps, request.body === undefined ? { ...request, body: {} } : request, DRAFT_SEND_ROUTE_ID, parseDraftSendBody);
  if (pre.kind === 'error') return pre.response;
  const body = pre.body;
  if (!UUID_PATTERN.test(params.draftId)) return rejectBeforeGate(errorResponse(400, 'invalid_request', 'draft id must be a lowercase uuid.'));

  const claim = await deps.drafts.claimSend(body.agentId, params.draftId, pre.idempotencyKey);
  if (claim.kind === 'not_found') return rejectBeforeGate(draftNotFound(params.draftId));
  if (claim.kind === 'unavailable') {
    const status = draftStatus(claim.row);
    if (status === 'sent') {
      return rejectBeforeGate({
        status: 409,
        body: {
          error: 'draft_already_sent',
          detail: 'This draft was already sent with a different Idempotency-Key. Retry with that key to get its result; a draft is sent at most once.',
          message_id: claim.row.sentMessageId,
          draft_id: claim.row.id,
        },
      });
    }
    if (status === 'discarded') return rejectBeforeGate(errorResponse(409, 'draft_discarded', 'This draft was discarded and cannot be sent.'));
    return rejectBeforeGate(
      errorResponse(409, 'draft_send_in_progress', 'This draft is already being sent with a different Idempotency-Key. Retry with that key to get its result.'),
    );
  }

  const draft = claim.row;
  let prepared: PreparedOutbound | ApiResponse;
  try {
    prepared = await prepareDraft(deps, draft, body, pre.idempotencyKey);
  } catch (error) {
    // 준비가 던지면(저장소 장애) 키를 놓는다 — 메시지 행이 생겼다면 같은 키의 재시도가 재생으로 이어 준다.
    await deps.drafts.releaseClaim(body.agentId, draft.id, pre.idempotencyKey).catch(() => undefined);
    throw error;
  }
  if (!('kind' in prepared)) {
    await deps.drafts.releaseClaim(body.agentId, draft.id, pre.idempotencyKey);
    return withDraft(rejectBeforeGate(prepared), draft.id, 'active');
  }

  const outcome =
    prepared.kind === 'settled'
      ? prepared.outcome
      : await finalizeOutbound(deps.service, prepared, await dispatch(gateDependenciesFor(deps.service, deps.transport), prepared.dispatchRequest));

  const messageId = messageIdOf(outcome);
  if (messageId === null) {
    await deps.drafts.releaseClaim(body.agentId, draft.id, pre.idempotencyKey);
    return withDraft(toApiResponse(outcome), draft.id, 'active');
  }
  const sent = await deps.drafts.markSent(body.agentId, draft.id, pre.idempotencyKey, messageId);
  return withDraft(toApiResponse(outcome), draft.id, sent === null ? 'sending' : 'sent');
}
