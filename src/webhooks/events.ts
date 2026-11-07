/**
 * src/webhooks/events.ts — 웹훅 이벤트 3종의 **닫힌 직렬화** (계획 §3.4 1조).
 *
 * *"에이전트는 폴링하지 않는다 — `approval.resolved` / `message.sent` webhook 을 받는다."*
 * + `approval.expired` (§3.4 4조, AC-d3).
 *
 * ---------------------------------------------------------------------------
 * ## 페이로드에 무엇을 싣는가 — **식별자와 시각뿐이다**
 * ---------------------------------------------------------------------------
 *
 * 웹훅은 **외부 표면**이다. URL 은 에이전트 소유자가 적은 문자열이고, 오타 하나면 남의
 * 서버다. 수신측의 요청 로그·APM·에러 트래커로 페이로드 전체가 복제된다 — 우리 통제
 * 밖의 리텐션이다. 그래서:
 *
 *   - **수신자 주소·제목·본문을 싣지 않는다.** "에이전트 소유자 자신의 데이터" 라는 논거는
 *     절반만 맞다: 제목·본문은 소유자의 것이지만 **수신자 주소는 제3자의 PII** 다. 그리고
 *     소유자의 것이라도 그가 이미 가진 것이다 — 에이전트가 요청을 만들었고 `message_id` 로
 *     인증된 API(`GET /v1/messages/{id}`)에서 다시 읽을 수 있다. 싣는 이득은 조회 1회를
 *     아끼는 것이고, 잃는 것은 주소가 통제 밖 로그에 눌러앉는 것이다. ("thin event" —
 *     Stripe 가 v2 이벤트에서 택한 방향과 같다.)
 *   - **DID·passport 를 싣지 않는다** (B5, ADR-0002: `published` 가 아닌 passport 의 DID 는
 *     어떤 외부 표면에도 직렬화하지 않는다). `agent_id` 는 싣는다 — 불투명 hex 32 이고
 *     에이전트가 자기 요청에 이미 쓰는 키다. DID 는 이 파일이 **표현할 자리가 없다.**
 *   - 에이전트가 넘긴 `idempotency_key` 도 싣지 않는다 — 형식이 자유라 누가 거기에 주소를
 *     넣었는지 우리는 모른다.
 *
 * **집행은 문장이 아니라 형식 검사다.** 빌더의 모든 문자열 입력은 uuid·hex32·고정 열거
 * 중 하나로 검증되고, 시각은 `Date` 에서만 만든다. 그러므로 `@`·`did:` 를 담은 값은
 * 빌더를 **통과할 수 없다.** 임의 객체를 받는 빌더가 없다는 것이 이 파일의 요점이다.
 *
 * ---------------------------------------------------------------------------
 * ## 중복 수신 — 수신자는 같은 이벤트를 여러 번 받는다
 * ---------------------------------------------------------------------------
 *
 * 전달은 at-least-once 다(outbox + 재시도; 2xx 응답이 유실되면 재전송된다). 그래서
 * 봉투의 `id` 가 **이벤트 id** 이고, 재시도는 같은 `id` 와 같은 바이트를 싣는다.
 * 수신측은 `id` 로 멱등 처리한다. 생산 쪽 중복(스위퍼가 두 번 돌아 `approval.expired` 를
 * 두 번 enqueue)은 `dedupeKey` 가 outbox 의 유니크 인덱스에서 죽인다 — AC-d3 의 "1회".
 */

import { randomUUID } from 'node:crypto';

export type WebhookEventType =
  | 'approval.resolved'
  | 'approval.expired'
  | 'message.sent'
  | 'message.received'
  | 'message.delivered'
  | 'message.bounced'
  | 'message.complained';

/**
 * 옛 4종 — 구독을 지정하지 않은 엔드포인트(`webhook_endpoints.event_types IS NULL`)가 받는 집합이다. 이 넷의 페이로드 바이트는 바뀌지 않는다
 * (메일 기본기 1차 AC-A4-7 골든).
 */
export const LEGACY_EVENT_TYPES = [
  'approval.resolved',
  'approval.expired',
  'message.sent',
  // P3c — 수신(202609230300). 격리 메일은 발화하지 않는다(그 마이그레이션 머리말).
  'message.received',
] as const satisfies readonly WebhookEventType[];

/**
 * 전 종류. 뒤의 셋은 **엔드포인트별 opt-in** 이다(`event_types` 에 적은 엔드포인트만 — 자동 발화하면 기존 수신측이 모르는 `type` 을 받는다).
 * 격리 이벤트는 없다(D9 b — 에이전트는 격리 개수만 본다).
 */
export const WEBHOOK_EVENT_TYPES = [
  ...LEGACY_EVENT_TYPES,
  'message.delivered',
  'message.bounced',
  'message.complained',
] as const satisfies readonly WebhookEventType[];

/** outbox 에 들어갈 준비가 된 이벤트 하나. `body` 는 서명 대상이므로 **바이트가 고정**된다. */
export interface WebhookEvent {
  readonly eventId: string;
  readonly type: WebhookEventType;
  readonly agentId: string;
  /** 생산 쪽 멱등 키. `<type>:<대상 id>` — 같은 사건의 두 번째 enqueue 는 무시된다. */
  readonly dedupeKey: string;
  /** JSON 문자열. jsonb 로 저장하지 않는다(키 순서가 바뀌면 재시도마다 다른 바이트가 된다). */
  readonly body: string;
}

export class WebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookPayloadError';
  }
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_ID_PATTERN = /^[0-9a-f]{32}$/;

/** 배치 승인(전환 공지)이 20건이다. 여유를 두되 무한은 아니다 — 본문 크기가 outbox CHECK 에 걸린다. */
const MAX_MESSAGE_IDS = 100;

function uuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw new WebhookPayloadError(`${field} 는 정규형 uuid 여야 한다`);
  return value;
}

function agentId(value: string): string {
  if (!AGENT_ID_PATTERN.test(value)) throw new WebhookPayloadError('agent_id 는 hex 32자여야 한다');
  return value;
}

function iso(value: Date, field: string): string {
  if (Number.isNaN(value.getTime())) throw new WebhookPayloadError(`${field} 가 유효한 시각이 아니다`);
  return value.toISOString();
}

function messageIds(values: readonly string[]): string[] {
  if (values.length > MAX_MESSAGE_IDS) throw new WebhookPayloadError('message_ids 가 너무 많다');
  return values.map((value) => uuid(value, 'message_ids[]'));
}

/**
 * 봉투. 키 순서는 이 객체 리터럴이 정한다 — 서명 대상이 결정적이어야 테스트가 바이트를 본다.
 * `api_version` 은 수신측이 형태 변경을 감지할 수 있게 한다(바꾸면 올린다).
 */
function envelope(
  type: WebhookEventType,
  agent: string,
  createdAt: Date,
  dedupeKey: string,
  data: Readonly<Record<string, string | readonly string[] | readonly number[]>>,
  eventId: string,
): WebhookEvent {
  const body = JSON.stringify({
    id: eventId,
    type,
    api_version: '2026-09-23',
    created_at: iso(createdAt, 'created_at'),
    agent_id: agent,
    data,
  });
  return { eventId, type, agentId: agent, dedupeKey, body };
}

export interface ApprovalResolvedInput {
  readonly agentId: string;
  readonly approvalId: string;
  readonly decision: 'approved' | 'rejected';
  readonly resolvedAt: Date;
  /** 이 승인이 풀어 준(또는 막은) 메시지들. 배치 승인이면 여럿이다. */
  readonly messageIds: readonly string[];
}

export function approvalResolvedEvent(input: ApprovalResolvedInput, eventId: string = randomUUID()): WebhookEvent {
  const approvalId = uuid(input.approvalId, 'approval_id');
  if (input.decision !== 'approved' && input.decision !== 'rejected') {
    throw new WebhookPayloadError('decision 은 approved|rejected 다');
  }
  return envelope(
    'approval.resolved',
    agentId(input.agentId),
    input.resolvedAt,
    `approval.resolved:${approvalId}`,
    {
      approval_id: approvalId,
      decision: input.decision,
      resolved_at: iso(input.resolvedAt, 'resolved_at'),
      message_ids: messageIds(input.messageIds),
    },
    uuid(eventId, 'event_id'),
  );
}

export interface ApprovalExpiredInput {
  readonly agentId: string;
  readonly approvalId: string;
  readonly expiredAt: Date;
  readonly messageIds: readonly string[];
}

export function approvalExpiredEvent(input: ApprovalExpiredInput, eventId: string = randomUUID()): WebhookEvent {
  const approvalId = uuid(input.approvalId, 'approval_id');
  return envelope(
    'approval.expired',
    agentId(input.agentId),
    input.expiredAt,
    `approval.expired:${approvalId}`,
    {
      approval_id: approvalId,
      expired_at: iso(input.expiredAt, 'expired_at'),
      message_ids: messageIds(input.messageIds),
    },
    uuid(eventId, 'event_id'),
  );
}

export interface MessageSentInput {
  readonly agentId: string;
  readonly messageId: string;
  readonly sentAt: Date;
}

export function messageSentEvent(input: MessageSentInput, eventId: string = randomUUID()): WebhookEvent {
  const messageId = uuid(input.messageId, 'message_id');
  return envelope(
    'message.sent',
    agentId(input.agentId),
    input.sentAt,
    `message.sent:${messageId}`,
    { message_id: messageId, sent_at: iso(input.sentAt, 'sent_at') },
    uuid(eventId, 'event_id'),
  );
}

export interface MessageReceivedInput {
  readonly agentId: string;
  /** `inbound_messages.id`. */
  readonly inboundMessageId: string;
  /** 권한용 스레드(`inbound_messages.thread_id`) — 식별자다. 표시용 스레드는 싣지 않는다. */
  readonly threadId: string;
  readonly receivedAt: Date;
}

/**
 * `message.received` (P3c). **보낸 사람·제목·본문·첨부 파일명을 싣지 않는다** — 이 파일 머리말의 규율
 * 그대로다. 게다가 수신 메일의 그 값들은 **외부인이 쓴 문자열**이다: 웹훅 수신측 로그에 공격자 텍스트를
 * 복제해 넣는 경로를 우리가 열 이유가 없다. 에이전트는 id 로 `GET /v1/messages/inbound/{id}` 를 부른다.
 *
 * 호출자(`inbound-store.ts` recordMessage)는 **격리되지 않은 행에만** 이 빌더를 부른다.
 */
export function messageReceivedEvent(input: MessageReceivedInput, eventId: string = randomUUID()): WebhookEvent {
  const messageId = uuid(input.inboundMessageId, 'message_id');
  return envelope(
    'message.received',
    agentId(input.agentId),
    input.receivedAt,
    `message.received:${messageId}`,
    {
      message_id: messageId,
      thread_id: uuid(input.threadId, 'thread_id'),
      received_at: iso(input.receivedAt, 'received_at'),
    },
    uuid(eventId, 'event_id'),
  );
}

// ---------------------------------------------------------------------------
// 발송 결과 세 종 (메일 기본기 1차 A4 · D4 a) — opt-in 구독자에게만 간다
// ---------------------------------------------------------------------------
//
// 원천은 SES 이벤트(`ses_events`)다. ses-events 소비자가 기록과 같은 트랜잭션의 savepoint 안에서 적재한다
// (`db/repositories/ses-event-store.ts`). **수신자 주소는 싣지 않는다** — 제3자 PII 다(이 파일 머리말). 대신 "몇 번째 수신자인가" 를
// 싣는다: 그 메일의 수신자 전원(`outbound_recipients`, 소문자)을 **JS 코드포인트 순**으로 정렬한 배열의 위치(0부터)다. 에이전트는 자기가
// 보낸 수신자 목록을 같은 규칙으로 정렬해 위치를 주소로 되돌린다. 주소를 해시로 싣지 않는 이유: 수신자 수가 작아 해시는 사전 대입으로
// 곧장 풀린다 — 보호하는 척만 한다.

/** SES `bounceType`(`Permanent`·`Transient`·`Undetermined`)의 닫힌 소문자 판. 모르는 값은 `undetermined` 로 접는다(파서 몫). */
export type BounceType = 'permanent' | 'transient' | 'undetermined';

const BOUNCE_TYPES: readonly BounceType[] = ['permanent', 'transient', 'undetermined'];

/** `recipient_positions` 길이 상한. 메일 한 통의 수신자 천장(`MAX_RECIPIENTS_PER_MESSAGE` = 50)과 같다. */
export const MAX_RECIPIENT_POSITIONS = 50;

/** 위치 값의 바닥 검사 상한(배타). 수신자 천장보다 넉넉하다 — 넘는 값은 정렬 목록에서 나올 수 없는 값이다. */
const MAX_RECIPIENT_INDEX = 100;

/** 정렬 규칙 — 코드포인트(UTF-16 코드 단위) 사전순. `localeCompare` 는 로캘마다 다르므로 쓰지 않는다(에이전트가 같은 순서를 재현해야 한다). */
function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * **`recipient_positions` 계산**(순수). `messageRecipients` = 그 메일의 수신자 전원(`outbound_recipients.address`), `eventRecipients` = SES
 * 이벤트가 적은 수신자(파서가 소문자·공백 제거). 둘 다 소문자로 맞춘 뒤, 전원을 코드포인트 순으로 정렬한 배열에서 이벤트 수신자의 위치를
 * 찾는다. **찾지 못한 주소는 생략**하고, 결과는 오름차순·중복 없음·최대 `MAX_RECIPIENT_POSITIONS` 개다.
 */
export function recipientPositions(messageRecipients: readonly string[], eventRecipients: readonly string[]): number[] {
  const sorted = [...new Set(messageRecipients.map((address) => address.toLowerCase()))].sort(compareCodePoints);
  const index = new Map(sorted.map((address, position) => [address, position] as const));
  const positions = new Set<number>();
  for (const recipient of eventRecipients) {
    const position = index.get(recipient.toLowerCase());
    if (position !== undefined) positions.add(position);
  }
  return [...positions].sort((a, b) => a - b).slice(0, MAX_RECIPIENT_POSITIONS);
}

function positionsOf(values: readonly number[]): number[] {
  if (values.length > MAX_RECIPIENT_POSITIONS) throw new WebhookPayloadError('recipient_positions 가 너무 많다');
  let previous = -1;
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || value >= MAX_RECIPIENT_INDEX) {
      throw new WebhookPayloadError('recipient_positions[] 는 0 이상 정수여야 한다');
    }
    if (value <= previous) throw new WebhookPayloadError('recipient_positions 는 오름차순·중복 없음이어야 한다');
    previous = value;
  }
  return [...values];
}

/** `ses_events.dedupe_key` — 이벤트 본문 sha256 hex. 한 SES 사건 = 웹훅 한 건(`<type>:<이 값>`). */
const SES_DEDUPE_KEY_PATTERN = /^[0-9a-f]{64}$/;

function sesDedupeKey(value: string): string {
  if (!SES_DEDUPE_KEY_PATTERN.test(value)) throw new WebhookPayloadError('ses dedupe key 는 hex 64자여야 한다');
  return value;
}

/** 세 빌더의 공통 입력. `sesDedupeKey` 는 `ses_events.dedupe_key`(재전달이 같은 값을 낸다 → 웹훅도 1회). */
export interface MessageOutcomeInput {
  readonly agentId: string;
  /** 우리 `messages.id`(outbound). */
  readonly messageId: string;
  readonly sesDedupeKey: string;
  /** SES 이벤트 시각(`delivery.timestamp` 등). */
  readonly occurredAt: Date;
  /** `recipientPositions()` 의 결과. */
  readonly recipientPositions: readonly number[];
}

/** 세 빌더의 공통 몸통. data 키 순서 = `message_id` · `<동사>_at` · `recipient_positions` · (`extra`) — 바이트 고정. */
function outcomeEvent(
  type: 'message.delivered' | 'message.bounced' | 'message.complained',
  atKey: string,
  input: MessageOutcomeInput,
  eventId: string,
  extra: Readonly<Record<string, string>> = {},
): WebhookEvent {
  return envelope(
    type,
    agentId(input.agentId),
    input.occurredAt,
    `${type}:${sesDedupeKey(input.sesDedupeKey)}`,
    {
      message_id: uuid(input.messageId, 'message_id'),
      [atKey]: iso(input.occurredAt, atKey),
      recipient_positions: positionsOf(input.recipientPositions),
      ...extra,
    },
    uuid(eventId, 'event_id'),
  );
}

/** `message.delivered` — 수신측 MTA 가 받았다. */
export function messageDeliveredEvent(input: MessageOutcomeInput, eventId: string = randomUUID()): WebhookEvent {
  return outcomeEvent('message.delivered', 'delivered_at', input, eventId);
}

export interface MessageBouncedInput extends MessageOutcomeInput {
  readonly bounceType: BounceType;
}

/** `message.bounced` — `bounce_type`(닫힌 셋)을 더한다. 반송 사유 문장(진단 코드)은 싣지 않는다. */
export function messageBouncedEvent(input: MessageBouncedInput, eventId: string = randomUUID()): WebhookEvent {
  if (!BOUNCE_TYPES.includes(input.bounceType)) throw new WebhookPayloadError('bounce_type 은 permanent|transient|undetermined 다');
  return outcomeEvent('message.bounced', 'bounced_at', input, eventId, { bounce_type: input.bounceType });
}

/** `message.complained` — 수신자가 스팸 신고했다. 신고 종류·UA 는 싣지 않는다. */
export function messageComplainedEvent(input: MessageOutcomeInput, eventId: string = randomUUID()): WebhookEvent {
  return outcomeEvent('message.complained', 'complained_at', input, eventId);
}
