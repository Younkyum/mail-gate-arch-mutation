/**
 * 예약 발송 **조회·취소**(메일 기본기 A3 · D2 확대, `.omc/plans/mail-basics.md` §4 A3).
 *
 *   `GET  /v1/messages/scheduled?agent_id=&status=&cursor=&limit=` — 목록(`messages:read`)
 *   `GET  /v1/messages/scheduled/{scheduleId}`                    — 단건 + 본문 객체의 `subject`(`messages:read`)
 *   `POST /v1/messages/scheduled/{scheduleId}/cancel`             — 취소, 본문 `{reason_code, note?}`(`messages:send`)
 *
 * 에이전트에게 돌려주는 칸은 `scheduleView` 하나가 고른다. 취소 메모(`cancel_note`)는 **소유자에게만** 보인다(콘솔 `type=scheduled`) — 에이전트
 * 응답과 구조화 로그에는 없다. 남의 예약 id 는 없는 id 와 같은 404 다(존재를 알리지 않는다). 권한(토큰 capability)이 없으면 403.
 *
 * 계약:
 *   - **취소 경로(`channel`)는 인자다 — 헤더로 받지 않는다.** 라우터 표가 `'http'`, `mcpDependenciesOf` 가 `'mcp'` 를 리터럴로 넘긴다
 *     (arch `mcp-adapter` ⑤ 가 그 리터럴을 본다). 행의 `cancelled_via` 가 이 값이다.
 *   - 취소는 한 트랜잭션 `FOR UPDATE` 이고 판정 순서는 계획 표 그대로다: 이미 `cancelled` → 200 `replayed` · `dispatched` → 409
 *     `schedule_already_dispatched` · 임대 중 또는 `scheduled:{id}` 발송행 → 409 `schedule_in_flight` · `agent_cancellable=false`
 *     → 403 `schedule_not_agent_cancellable` · 최근 1시간 에이전트 취소(http·mcp 합)가 `AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT` 이상 → 429
 *     `cancel_rate_limited` · 그 밖 → `cancelled`. `reason_code`(`CANCEL_REASON_CODES`)가 없으면 400.
 *   - **403·429 보호는 경로를 가리지 않는다**(1차 수정 리드 결정, 보안 M1). 두 경로 모두 에이전트 토큰이다 — MCP 로만 막으면 같은 토큰을
 *     쥔 에이전트가 HTTP 로 우회한다. 우회는 소유자 콘솔뿐이다.
 *   - 취소마다 로그 `ALARM_LOG_EVENTS.scheduledCancelled` 한 줄(note 는 싣지 않는다)과 메트릭 `scheduledCancelled`(차원 `route_id` = 경로).
 *     보호에 막히면(403·429) 로그 `ALARM_LOG_EVENTS.scheduledCancelRejected {agent_id, route_id, outcome}` 한 줄 — 상한을 넘으려는 시도가
 *     주입의 신호다(코드 리뷰 M7-a).
 *   - 단건 조회에서 본문 객체가 없거나 읽을 수 없으면 `subject: null` 로 내려 주고 경고 로그를 남긴다(행이 진실이다 — 코드 리뷰 L5).
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 조회와 취소(행 하나를 종단으로 닫기)뿐이고 관문을 import 하지 않는다. 예약 **생성**
 * (`scheduled-messages.ts`)은 여전히 MCP 폐포 밖이다.
 */

import type {
  ScheduledListCursor,
  ScheduledSendRecord,
  ScheduledSendStore,
} from '../../db/repositories/scheduled-send-store';
import {
  CANCEL_REASON_CODES,
  AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT,
  MAX_CANCEL_NOTE_LENGTH,
  SCHEDULED_SEND_STATUSES,
  type CancelReasonCode,
  type ScheduledCancelChannel,
  type ScheduledSendStatus,
} from '../../db/schema';
import type { AgentTokenStore } from '../../identity/agent-token';
import { log } from '../../observability/logger';
import { ALARM_LOG_EVENTS, countMetric, METRIC_NAMES } from '../../observability/metrics';
import { ObjectNotFoundError } from '../../storage/object-store';
import { ScheduledContentCorruptError, type ScheduledContentStore } from '../../storage/scheduled-content-store';
import { authorizeAgentRequest, claimedAgentOfQuery } from '../auth';
import { errorResponse, isJsonObject, jsonResponse, pageLimitOf, pageOf, queryOf, UUID_PATTERN, type ApiRequest, type ApiResponse } from '../http';

export interface ScheduledQueryRouteDependencies {
  readonly tokens: AgentTokenStore;
  /** 예약 저장소 — 생성 라우트와 같은 저장소다. */
  readonly schedules: ScheduledSendStore;
  /** 예약 본문 객체(S3) — 단건 조회의 `subject`. */
  readonly content: ScheduledContentStore;
  readonly now: () => Date;
}

const DEFAULT_SCHEDULED_PAGE_SIZE = 20;
/** MCP `list_scheduled` 의 `limit` 상한(50)과 같다. */
const MAX_SCHEDULED_PAGE_SIZE = 50;

/**
 * 메모에 둘 수 없는 글자 — C0·C1 제어문자와 줄·문단 구분자. DB CHECK(`!~ '[[:cntrl:]]'`)보다 넓게 잡아 DB 가 거부하기 전에 400 으로 돌려준다
 * (로케일에 따라 `[[:cntrl:]]` 가 U+2028·2029 를 포함한다).
 */
const NOTE_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export function encodeScheduledCursor(cursor: ScheduledListCursor): string {
  return Buffer.from(`${cursor.sendAt.toISOString()}|${cursor.id}`, 'utf8').toString('base64url');
}

/** 모양이 틀리면 `null`(호출자가 400). */
export function decodeScheduledCursor(value: string): ScheduledListCursor | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) return null;
  const [at, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (at === undefined || id === undefined || rest.length > 0 || !UUID_PATTERN.test(id)) return null;
  const sendAt = new Date(at);
  if (Number.isNaN(sendAt.getTime()) || sendAt.toISOString() !== at) return null;
  return { sendAt, id };
}

/** 에이전트에게 보이는 예약 한 건. **칸을 하나씩 고른다** — 행을 펼치지 않는다(메모가 새어 나가지 않게). */
function scheduleView(record: ScheduledSendRecord): Record<string, unknown> {
  return {
    schedule_id: record.id,
    status: record.status,
    send_at: record.sendAt.toISOString(),
    recipient_count: record.recipients.length,
    recipients: record.recipients,
    from_address: record.fromAddress,
    created_at: record.createdAt.toISOString(),
    agent_cancellable: record.agentCancellable,
    cancelled_at: record.cancelledAt === null ? null : record.cancelledAt.toISOString(),
    cancel_reason_code: record.cancelReasonCode,
    cancelled_via: record.cancelledVia,
    dispatch_outcome: record.dispatchOutcome,
    message_id: record.messageId,
  };
}

function scheduleNotFound(scheduleId: string): ApiResponse {
  return errorResponse(404, 'schedule_not_found', `No schedule with schedule_id=${scheduleId}.`);
}

export async function handleListScheduledMessages(deps: ScheduledQueryRouteDependencies, request: ApiRequest): Promise<ApiResponse> {
  // `agent_id` 생략 = 토큰의 에이전트(`auth.claimedAgentOfQuery`). 적었으면 형식 검사(400)는 인증 전, 인가는 그 값으로.
  const claimed = claimedAgentOfQuery(request);
  if (claimed.kind === 'error') return claimed.response;
  const statusRaw = queryOf(request, 'status');
  if (statusRaw !== null && !(SCHEDULED_SEND_STATUSES as readonly string[]).includes(statusRaw)) {
    return errorResponse(400, 'invalid_request', `status must be one of: ${SCHEDULED_SEND_STATUSES.join(', ')}.`);
  }
  const paged = pageLimitOf(request, DEFAULT_SCHEDULED_PAGE_SIZE, MAX_SCHEDULED_PAGE_SIZE);
  if (paged.kind === 'error') return paged.response;
  const { limit } = paged;
  const cursorRaw = queryOf(request, 'cursor');
  const cursor = cursorRaw === null ? null : decodeScheduledCursor(cursorRaw);
  if (cursorRaw !== null && cursor === null) return errorResponse(400, 'invalid_request', 'cursor is not valid.');

  const access = await authorizeAgentRequest(deps.tokens, request, deps.now(), 'messages:read', claimed.agentId);
  if (access.kind === 'error') return access.response;
  const { agentId } = access;

  const rows = await deps.schedules.listForAgent(agentId, {
    status: statusRaw as ScheduledSendStatus | null,
    cursor,
    limit: limit + 1,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeScheduledCursor({ sendAt: last.sendAt, id: last.id }));
  return jsonResponse(200, {
    schedules: page.map(scheduleView),
    next_cursor: nextCursor,
  });
}

export async function handleGetScheduledMessage(
  deps: ScheduledQueryRouteDependencies,
  request: ApiRequest,
  params: { readonly scheduleId: string },
): Promise<ApiResponse> {
  if (!UUID_PATTERN.test(params.scheduleId)) return errorResponse(400, 'invalid_request', 'schedule id must be a lowercase uuid.');
  // 권한은 자기 에이전트 기준으로 먼저 본다 — 대상은 "그 에이전트의 예약" 으로만 찾으므로 남의 id 는 아래에서 404 가 된다.
  const access = await authorizeAgentRequest(deps.tokens, request, deps.now(), 'messages:read', null);
  if (access.kind === 'error') return access.response;

  const record = await deps.schedules.findForAgent(params.scheduleId, access.agentId);
  if (record === null) return scheduleNotFound(params.scheduleId);
  return jsonResponse(200, { ...scheduleView(record), subject: await subjectOf(deps.content, record) });
}

/**
 * 본문 객체의 제목. 객체가 없거나(`ObjectNotFoundError`) 모양이 깨졌으면(`ScheduledContentCorruptError`) `null` 과 경고 한 줄 — 조회는 행이
 * 진실이고 제목은 덧붙이는 칸이라 500 으로 목록·취소 흐름을 막지 않는다(코드 리뷰 L5). 그 밖의 오류(저장소 장애)는 그대로 던진다.
 */
async function subjectOf(content: ScheduledContentStore, record: ScheduledSendRecord): Promise<string | null> {
  try {
    return (await content.load(record.id)).subject;
  } catch (error) {
    if (!(error instanceof ObjectNotFoundError) && !(error instanceof ScheduledContentCorruptError)) throw error;
    log('warn', 'scheduled.content_unreadable', { agent_id: record.agentId, detail: record.id, error_kind: error.name });
    return null;
  }
}

type CancelBody =
  | { readonly kind: 'ok'; readonly reasonCode: CancelReasonCode; readonly note: string | null }
  | { readonly kind: 'error'; readonly response: ApiResponse };

function parseCancelBody(raw: unknown): CancelBody {
  const invalid = (detail: string): CancelBody => ({ kind: 'error', response: errorResponse(400, 'invalid_request', detail) });
  if (!isJsonObject(raw)) return invalid('The body must be a JSON object: {reason_code, note?}.');
  const body = raw;
  const reasonCode = body['reason_code'];
  if (typeof reasonCode !== 'string' || !(CANCEL_REASON_CODES as readonly string[]).includes(reasonCode)) {
    return invalid(`reason_code is required and must be one of: ${CANCEL_REASON_CODES.join(', ')}.`);
  }
  const noteRaw = body['note'];
  if (noteRaw === undefined || noteRaw === null) return { kind: 'ok', reasonCode: reasonCode as CancelReasonCode, note: null };
  if (typeof noteRaw !== 'string') return invalid('note must be a string.');
  if (NOTE_FORBIDDEN.test(noteRaw)) return invalid('note must not contain control characters or line breaks.');
  const note = noteRaw.trim();
  // DB 의 char_length 와 같은 단위(코드 포인트)로 센다.
  if ([...note].length > MAX_CANCEL_NOTE_LENGTH) return invalid(`note must be at most ${String(MAX_CANCEL_NOTE_LENGTH)} characters.`);
  return { kind: 'ok', reasonCode: reasonCode as CancelReasonCode, note: note === '' ? null : note };
}

export async function handleCancelScheduledMessage(
  deps: ScheduledQueryRouteDependencies,
  request: ApiRequest,
  params: { readonly scheduleId: string },
  channel: ScheduledCancelChannel,
): Promise<ApiResponse> {
  if (!UUID_PATTERN.test(params.scheduleId)) return errorResponse(400, 'invalid_request', 'schedule id must be a lowercase uuid.');
  const now = deps.now();
  const access = await authorizeAgentRequest(deps.tokens, request, now, 'messages:send', null);
  if (access.kind === 'error') return access.response;
  const { agentId } = access;
  const body = parseCancelBody(request.body);
  if (body.kind === 'error') return body.response;

  const outcome = await deps.schedules.cancel({
    id: params.scheduleId,
    agentId,
    channel,
    reasonCode: body.reasonCode,
    note: body.note,
    now,
    agentHourlyLimit: AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT,
  });
  if (outcome.kind === 'not_agent_cancellable' || outcome.kind === 'rate_limited') {
    // 알람 규칙(`atmark-scheduled-cancels-by-agent`)은 이 거부 줄만 센다(성공·콘솔 취소는 세지 않는다). schedule id·사유·note 는 싣지 않는다.
    log('info', ALARM_LOG_EVENTS.scheduledCancelRejected, { agent_id: agentId, route_id: channel, outcome: outcome.kind });
  }
  switch (outcome.kind) {
    case 'not_found':
      return scheduleNotFound(params.scheduleId);
    case 'replayed':
      return jsonResponse(200, { ...scheduleView(outcome.record), replayed: true });
    case 'already_dispatched':
      return errorResponse(409, 'schedule_already_dispatched', 'This scheduled email was already sent and cannot be recalled.');
    case 'in_flight':
      return errorResponse(409, 'schedule_in_flight', 'This scheduled email is being sent right now. Check its status again shortly.');
    case 'not_agent_cancellable':
      return errorResponse(403, 'schedule_not_agent_cancellable', 'This schedule cannot be cancelled with an agent token. Ask the owner.');
    case 'rate_limited':
      return errorResponse(
        429,
        'cancel_rate_limited',
        `An agent token can cancel at most ${String(AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT)} schedules per hour (API and MCP combined). Ask the owner.`,
      );
    case 'cancelled':
      // 알람(Contributor Insights `atmark-scheduled-cancels-agent-hourly`)이 이 줄을 센다. 메모는 싣지 않는다(완화 ①).
      log('info', ALARM_LOG_EVENTS.scheduledCancelled, {
        agent_id: agentId,
        route_id: channel,
        reason: body.reasonCode,
        detail: params.scheduleId,
      });
      countMetric(METRIC_NAMES.scheduledCancelled, { route_id: channel });
      return jsonResponse(200, { ...scheduleView(outcome.record), replayed: false });
  }
}
