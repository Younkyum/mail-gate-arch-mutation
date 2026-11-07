/**
 * src/realtime/events.ts — 실시간 이벤트의 **닫힌 직렬화**. 웹훅 빌더(`src/webhooks/events.ts`)와 같은 규율: 모든 문자열 입력은 uuid · hex32 · 닫힌
 * 열거 중 하나로 검증되고 시각은 `Date` 에서만 만든다 — 주소 · 제목 · 본문을 담은 값은 빌더를 **통과할 수 없다.**
 */

import { createHash } from 'node:crypto';

import { REALTIME_API_VERSION, REALTIME_MAX_FRAME_BYTES, type RealtimeEventType } from './contract';

export class RealtimePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealtimePayloadError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_ID_PATTERN = /^[0-9a-f]{32}$/;
const RISK_LEVELS = ['none', 'risk', 'block'] as const;
type RealtimeRiskLevel = (typeof RISK_LEVELS)[number];
const MAX_MESSAGE_IDS = 100;
/**
 * 프레임에 싣는 `message_ids` 상한(V-E-03) — uuid 100개면 프레임이 4096바이트를 넘는다. 50개까지 싣고 `message_count`(전체 수) · `truncated` 를 함께 —
 * 나머지는 `GET /v1/approvals/{id}` 가 준다.
 */
const REALTIME_APPROVAL_MESSAGE_IDS_IN_FRAME = 50;

/**
 * **결정적 이벤트 id**(적대 검증 E3-I-003) — (종류, 대상 id)에서 유도한 uuid 모양(sha256 앞 16바이트 · 버전 8 · 변형 10). 같은 메일이 두 번 밀려도(재전달 ·
 * 늦은 판정) 같은 id 라 클라이언트가 `id`(또는 `dedupe_key`)로 지운다. 연결이 달라도 같다.
 */
export function realtimeEventId(type: RealtimeEventType, entityId: string): string {
  const bytes = createHash('sha256').update(`atmark.realtime:${type}:${entityId}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw new RealtimePayloadError(`${field} 는 정규형 uuid 여야 한다`);
  return value;
}

function agentId(value: string): string {
  if (!AGENT_ID_PATTERN.test(value)) throw new RealtimePayloadError('agent_id 는 hex 32자여야 한다');
  return value;
}

function iso(value: Date, field: string): string {
  if (Number.isNaN(value.getTime())) throw new RealtimePayloadError(`${field} 가 유효한 시각이 아니다`);
  return value.toISOString();
}

/** 보낼 준비가 된 이벤트 — `frame` 이 소켓에 나가는 바이트(UTF-8 JSON 한 줄). */
export interface RealtimeEvent {
  readonly eventId: string;
  readonly type: RealtimeEventType;
  readonly agentId: string;
  readonly frame: string;
}

function envelope(
  type: RealtimeEventType,
  agent: string,
  createdAt: Date,
  data: Readonly<Record<string, unknown>>,
  eventId: string,
  dedupeKey: string,
): RealtimeEvent {
  const frame = JSON.stringify({
    id: eventId,
    type,
    api_version: REALTIME_API_VERSION,
    created_at: iso(createdAt, 'created_at'),
    agent_id: agent,
    dedupe_key: dedupeKey,
    data,
  });
  if (Buffer.byteLength(frame, 'utf8') > REALTIME_MAX_FRAME_BYTES) throw new RealtimePayloadError('실시간 프레임이 너무 크다');
  return { eventId, type, agentId: agent, frame };
}

interface RealtimeMessageReceivedInput {
  readonly agentId: string;
  readonly inboundMessageId: string;
  readonly threadId: string;
  readonly receivedAt: Date;
  readonly riskLevel: string | null;
}

/** `message.received` — id · 스레드 · 받은 시각 · 위험 등급만. 등급이 모르는 값이면 `block` 으로 읽는다(fail closed — 에이전트에게 더 조심하라는 쪽). */
export function realtimeMessageReceived(input: RealtimeMessageReceivedInput, now: Date): RealtimeEvent {
  const messageId = uuid(input.inboundMessageId, 'message_id');
  const level: RealtimeRiskLevel =
    input.riskLevel === null ? 'none' : (RISK_LEVELS as readonly string[]).includes(input.riskLevel) ? (input.riskLevel as RealtimeRiskLevel) : 'block';
  return envelope(
    'message.received',
    agentId(input.agentId),
    now,
    {
      message_id: messageId,
      thread_id: uuid(input.threadId, 'thread_id'),
      received_at: iso(input.receivedAt, 'received_at'),
      risk: { level },
    },
    realtimeEventId('message.received', messageId),
    `message.received:${messageId}`,
  );
}

interface RealtimeApprovalResolvedInput {
  readonly agentId: string;
  readonly approvalId: string;
  readonly decision: string;
  readonly resolvedAt: Date;
  readonly messageIds: readonly string[];
}

export function realtimeApprovalResolved(input: RealtimeApprovalResolvedInput, now: Date): RealtimeEvent {
  if (input.decision !== 'approved' && input.decision !== 'rejected') throw new RealtimePayloadError('decision 은 approved|rejected 다');
  if (input.messageIds.length > MAX_MESSAGE_IDS) throw new RealtimePayloadError('message_ids 가 너무 많다');
  const approvalId = uuid(input.approvalId, 'approval_id');
  const ids = input.messageIds.map((id) => uuid(id, 'message_ids[]'));
  return envelope(
    'approval.resolved',
    agentId(input.agentId),
    now,
    {
      approval_id: approvalId,
      decision: input.decision,
      resolved_at: iso(input.resolvedAt, 'resolved_at'),
      message_ids: ids.slice(0, REALTIME_APPROVAL_MESSAGE_IDS_IN_FRAME),
      message_count: ids.length,
      truncated: ids.length > REALTIME_APPROVAL_MESSAGE_IDS_IN_FRAME,
    },
    realtimeEventId('approval.resolved', approvalId),
    `approval.resolved:${approvalId}`,
  );
}
