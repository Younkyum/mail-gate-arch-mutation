/**
 * `events.ts` — 웹훅 페이로드는 **식별자와 시각뿐**이다. 외부 표면(B5·PII)을 형식 검사로 닫는다.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  LEGACY_EVENT_TYPES,
  MAX_RECIPIENT_POSITIONS,
  WEBHOOK_EVENT_TYPES,
  WebhookPayloadError,
  approvalExpiredEvent,
  approvalResolvedEvent,
  messageBouncedEvent,
  messageComplainedEvent,
  messageDeliveredEvent,
  messageReceivedEvent,
  messageSentEvent,
  recipientPositions,
} from '../../../src/webhooks/events';

const AGENT = randomBytes(16).toString('hex');
const AT = new Date('2026-09-23T01:02:03.004Z');

describe('웹훅 이벤트 — 닫힌 직렬화', () => {
  it('같은 사건의 dedupeKey 는 같고 eventId 는 enqueue 마다 새로 난다', () => {
    const input = { agentId: AGENT, approvalId: randomUUID(), expiredAt: AT, messageIds: [] };
    const a = approvalExpiredEvent(input);
    const b = approvalExpiredEvent(input);
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.eventId).not.toBe(b.eventId);
  });

  it.each([
    ['DID 를 agent_id 로 (B5)', { agentId: `did:web:atmark.ai:agents:${AGENT}` }],
    ['주소를 agent_id 로', { agentId: 'owner@example.com' }],
    ['주소를 message_id 로', { messageIds: ['victim@example.com'] }],
    ['제목을 approval_id 로', { approvalId: '3분기 정산 내역' }],
    ['decision 이 approved|rejected 밖', { decision: 'auto' as 'approved' }],
  ])('형식 밖의 값은 빌더를 통과하지 못한다: %s', (_label, override) => {
    expect(() =>
      approvalResolvedEvent({
        agentId: AGENT,
        approvalId: randomUUID(),
        decision: 'approved',
        resolvedAt: AT,
        messageIds: [],
        ...override,
      }),
    ).toThrow(WebhookPayloadError);
  });

  it('통과한 본문에는 주소 형태도 DID 도 없다', () => {
    const bodies = [
      approvalResolvedEvent({ agentId: AGENT, approvalId: randomUUID(), decision: 'rejected', resolvedAt: AT, messageIds: [randomUUID()] }).body,
      approvalExpiredEvent({ agentId: AGENT, approvalId: randomUUID(), expiredAt: AT, messageIds: [randomUUID()] }).body,
      messageSentEvent({ agentId: AGENT, messageId: randomUUID(), sentAt: AT }).body,
    ];
    for (const body of bodies) {
      expect(body).not.toContain('@');
      expect(body).not.toContain('did:');
    }
  });
});

/**
 * 페이로드 바이트 골든. 옛 4종(AC-A4-7)은 A4 빌더를 더하기 **전의** 출력이다 — 봉투·키 순서·`api_version`·dedupe 키 모양이 한 글자라도
 * 바뀌면 기존 수신측의 서명 검증·파서가 깨진다. A4 세 종(AC-A4-2)도 같은 방식으로 고정한다 — 주소·제목·본문·진단 문장 자리가 없다.
 */
describe('AC-A4-7 · AC-A4-2 골든 — 바이트 불변', () => {
  const AGENT_ID = '0123456789abcdef0123456789abcdef';
  const EVENT_ID = '11111111-2222-4333-8444-555555555555';
  const APPROVAL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const M1 = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const M2 = '10203040-5060-4708-8090-a0b0c0d0e0f0';
  const THREAD = 'cafebabe-dead-4eef-8bad-f00dfeedface';
  const SES_KEY = 'ab'.repeat(32);
  const outcome = { agentId: AGENT_ID, messageId: M1, sesDedupeKey: SES_KEY, occurredAt: AT, recipientPositions: [0, 2] };

  it.each([
    [
      'approval.resolved',
      () => approvalResolvedEvent({ agentId: AGENT_ID, approvalId: APPROVAL, decision: 'approved', resolvedAt: AT, messageIds: [M1, M2] }, EVENT_ID),
      'approval.resolved:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      '{"id":"11111111-2222-4333-8444-555555555555","type":"approval.resolved","api_version":"2026-09-23","created_at":"2026-09-23T01:02:03.004Z","agent_id":"0123456789abcdef0123456789abcdef","data":{"approval_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","decision":"approved","resolved_at":"2026-09-23T01:02:03.004Z","message_ids":["0f0e0d0c-0b0a-4908-8706-050403020100","10203040-5060-4708-8090-a0b0c0d0e0f0"]}}',
    ],
    [
      'approval.expired',
      () => approvalExpiredEvent({ agentId: AGENT_ID, approvalId: APPROVAL, expiredAt: AT, messageIds: [M1] }, EVENT_ID),
      'approval.expired:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      '{"id":"11111111-2222-4333-8444-555555555555","type":"approval.expired","api_version":"2026-09-23","created_at":"2026-09-23T01:02:03.004Z","agent_id":"0123456789abcdef0123456789abcdef","data":{"approval_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","expired_at":"2026-09-23T01:02:03.004Z","message_ids":["0f0e0d0c-0b0a-4908-8706-050403020100"]}}',
    ],
    [
      'message.sent',
      () => messageSentEvent({ agentId: AGENT_ID, messageId: M1, sentAt: AT }, EVENT_ID),
      'message.sent:0f0e0d0c-0b0a-4908-8706-050403020100',
      '{"id":"11111111-2222-4333-8444-555555555555","type":"message.sent","api_version":"2026-09-23","created_at":"2026-09-23T01:02:03.004Z","agent_id":"0123456789abcdef0123456789abcdef","data":{"message_id":"0f0e0d0c-0b0a-4908-8706-050403020100","sent_at":"2026-09-23T01:02:03.004Z"}}',
    ],
    [
      'message.received',
      () => messageReceivedEvent({ agentId: AGENT_ID, inboundMessageId: M2, threadId: THREAD, receivedAt: AT }, EVENT_ID),
      'message.received:10203040-5060-4708-8090-a0b0c0d0e0f0',
      '{"id":"11111111-2222-4333-8444-555555555555","type":"message.received","api_version":"2026-09-23","created_at":"2026-09-23T01:02:03.004Z","agent_id":"0123456789abcdef0123456789abcdef","data":{"message_id":"10203040-5060-4708-8090-a0b0c0d0e0f0","thread_id":"cafebabe-dead-4eef-8bad-f00dfeedface","received_at":"2026-09-23T01:02:03.004Z"}}',
    ],
    [
      'message.delivered',
      () => messageDeliveredEvent(outcome, EVENT_ID),
      `message.delivered:${SES_KEY}`,
      '{"id":"11111111-2222-4333-8444-555555555555","type":"message.delivered","api_version":"2026-09-23","created_at":"2026-09-23T01:02:03.004Z","agent_id":"0123456789abcdef0123456789abcdef","data":{"message_id":"0f0e0d0c-0b0a-4908-8706-050403020100","delivered_at":"2026-09-23T01:02:03.004Z","recipient_positions":[0,2]}}',
    ],
    [
      'message.bounced',
      () => messageBouncedEvent({ ...outcome, bounceType: 'permanent' }, EVENT_ID),
      `message.bounced:${SES_KEY}`,
      '{"id":"11111111-2222-4333-8444-555555555555","type":"message.bounced","api_version":"2026-09-23","created_at":"2026-09-23T01:02:03.004Z","agent_id":"0123456789abcdef0123456789abcdef","data":{"message_id":"0f0e0d0c-0b0a-4908-8706-050403020100","bounced_at":"2026-09-23T01:02:03.004Z","recipient_positions":[0,2],"bounce_type":"permanent"}}',
    ],
    [
      'message.complained',
      () => messageComplainedEvent(outcome, EVENT_ID),
      `message.complained:${SES_KEY}`,
      '{"id":"11111111-2222-4333-8444-555555555555","type":"message.complained","api_version":"2026-09-23","created_at":"2026-09-23T01:02:03.004Z","agent_id":"0123456789abcdef0123456789abcdef","data":{"message_id":"0f0e0d0c-0b0a-4908-8706-050403020100","complained_at":"2026-09-23T01:02:03.004Z","recipient_positions":[0,2]}}',
    ],
  ] as const)('%s — dedupeKey·body 가 골든과 바이트 단위로 같다', (type, build, dedupeKey, body) => {
    const event = build();
    expect(event.type).toBe(type);
    expect(event.eventId).toBe(EVENT_ID);
    expect(event.dedupeKey).toBe(dedupeKey);
    expect(event.body).toBe(body);
  });
});

/** 메일 기본기 1차 A4 — 발송 결과 세 종(D4 a · D9 b). */
describe('A4 발송 결과 이벤트 — delivered · bounced · complained', () => {
  const SES_KEY = 'ab'.repeat(32);
  const base = () => ({ agentId: AGENT, messageId: randomUUID(), sesDedupeKey: SES_KEY, occurredAt: AT, recipientPositions: [0, 2] });

  it('종류는 옛 4종 + 새 3종 = 7이고, 옛 4종이 구독 없는 엔드포인트의 기본이다', () => {
    expect([...LEGACY_EVENT_TYPES]).toEqual(['approval.resolved', 'approval.expired', 'message.sent', 'message.received']);
    expect([...WEBHOOK_EVENT_TYPES]).toEqual([...LEGACY_EVENT_TYPES, 'message.delivered', 'message.bounced', 'message.complained']);
  });

  it.each([
    ['주소를 message_id 로', { messageId: 'victim@example.com' }],
    ['ses 키 모양이 아니다', { sesDedupeKey: 'victim@example.com' }],
    ['위치가 음수', { recipientPositions: [-1] }],
    ['위치가 정수가 아니다', { recipientPositions: [1.5] }],
    ['위치가 정렬되지 않았다', { recipientPositions: [2, 1] }],
    ['위치가 중복', { recipientPositions: [1, 1] }],
    ['위치가 상한 초과', { recipientPositions: Array.from({ length: MAX_RECIPIENT_POSITIONS + 1 }, (_v, i) => i) }],
    ['유효하지 않은 시각', { occurredAt: new Date(Number.NaN) }],
  ])('형식 밖의 값은 빌더를 통과하지 못한다: %s', (_label, override) => {
    expect(() => messageDeliveredEvent({ ...base(), ...override })).toThrow(WebhookPayloadError);
  });

  it('bounce_type 은 닫힌 셋(permanent|transient|undetermined)이다', () => {
    expect(() => messageBouncedEvent({ ...base(), bounceType: 'Permanent' as 'permanent' })).toThrow(WebhookPayloadError);
  });
});

describe('A4 recipient_positions — 소문자·코드포인트 정렬 배열의 위치(D4 a)', () => {
  it('수신자 전원을 소문자로 맞춰 코드포인트 순으로 정렬한 배열의 위치(0부터)다', () => {
    // 정렬 뒤: ['amy@x.io', 'bob@x.io', 'zed@x.io'] — 이벤트 쪽 대문자도 소문자로 맞춰 찾는다.
    const all = ['zed@x.io', 'amy@x.io', 'bob@x.io'];
    expect(recipientPositions(all, ['ZED@X.IO'])).toEqual([2]);
    expect(recipientPositions(all, ['bob@x.io', 'amy@x.io'])).toEqual([0, 1]);
  });

  it('코드포인트 순이다 — 로캘 정렬이 아니다(대문자·숫자·점·하이픈이 ASCII 순으로 온다)', () => {
    const all = ['b@x.io', 'a-b@x.io', 'a.b@x.io', 'a0@x.io'];
    // '-'(0x2d) < '.'(0x2e) < '0'(0x30) < 'b'(0x62)
    expect(recipientPositions(all, ['a-b@x.io', 'a.b@x.io', 'a0@x.io', 'b@x.io'])).toEqual([0, 1, 2, 3]);
    expect(recipientPositions(all, ['b@x.io'])).toEqual([3]);
  });

  it('찾지 못한 주소는 생략하고, 중복 없이 오름차순이며, 상한 50 이다', () => {
    expect(recipientPositions(['a@x.io'], ['stranger@y.io'])).toEqual([]);
    expect(recipientPositions(['a@x.io', 'b@x.io'], ['b@x.io', 'b@x.io', 'nobody@x.io'])).toEqual([1]);
    const many = Array.from({ length: 80 }, (_v, i) => `u${String(i).padStart(3, '0')}@x.io`);
    const positions = recipientPositions(many, many);
    expect(positions).toHaveLength(MAX_RECIPIENT_POSITIONS);
    expect(positions).toEqual(Array.from({ length: MAX_RECIPIENT_POSITIONS }, (_v, i) => i));
  });
});
