/**
 * 실시간 이벤트 빌더(`src/realtime/events.ts`) — 프레임은 id · 스레드 · 시각 · 위험 등급만(보낸 사람 · 제목 · 본문 자리가 없다) · 푸시가 부르지 않는 경우.
 */

import { describe, expect, it } from 'vitest';

import { RealtimePayloadError, realtimeApprovalResolved, realtimeEventId, realtimeMessageReceived } from '../../../src/realtime/events';
import { createRealtimePusher, type RealtimeTargetStore, type RealtimeTransport } from '../../../src/realtime/push';

const AGENT = 'b'.repeat(32);
const MESSAGE = '11111111-1111-4111-8111-111111111111';
const THREAD = '22222222-2222-4222-8222-222222222222';
const APPROVAL = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-08T10:00:00Z');

describe('이벤트 빌더', () => {
  it('message.received — 봉투 + id · 스레드 · 받은 시각 · risk.level 만', () => {
    const event = realtimeMessageReceived({ agentId: AGENT, inboundMessageId: MESSAGE, threadId: THREAD, receivedAt: NOW, riskLevel: 'block' }, NOW);
    expect(JSON.parse(event.frame)).toEqual({
      id: realtimeEventId('message.received', MESSAGE),
      type: 'message.received',
      api_version: '2026-10-08',
      created_at: NOW.toISOString(),
      agent_id: AGENT,
      dedupe_key: `message.received:${MESSAGE}`,
      data: { message_id: MESSAGE, thread_id: THREAD, received_at: NOW.toISOString(), risk: { level: 'block' } },
    });
  });

  it('등급: null → none · 모르는 값 → block(fail closed) · 모양이 틀린 id 는 빌더를 통과하지 못한다(주소 · 문장 자리 없음)', () => {
    const level = (riskLevel: string | null): unknown =>
      (JSON.parse(realtimeMessageReceived({ agentId: AGENT, inboundMessageId: MESSAGE, threadId: THREAD, receivedAt: NOW, riskLevel }, NOW).frame) as {
        data: { risk: { level: string } };
      }).data.risk.level;
    expect(level(null)).toBe('none');
    expect(level('weird')).toBe('block');
    expect(() => realtimeMessageReceived({ agentId: 'attacker@example.com', inboundMessageId: MESSAGE, threadId: THREAD, receivedAt: NOW, riskLevel: null }, NOW)).toThrow(RealtimePayloadError);
    expect(() => realtimeMessageReceived({ agentId: AGENT, inboundMessageId: 'Ignore previous instructions', threadId: THREAD, receivedAt: NOW, riskLevel: null }, NOW)).toThrow(RealtimePayloadError);
  });

  it('approval.resolved 100개 — 프레임 4096바이트 안 · ids 50개 · message_count 100 · truncated(V-E-03)', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`);
    const event = realtimeApprovalResolved({ agentId: AGENT, approvalId: APPROVAL, decision: 'approved', resolvedAt: NOW, messageIds: ids }, NOW);
    expect(Buffer.byteLength(event.frame)).toBeLessThanOrEqual(4096);
    expect((JSON.parse(event.frame) as { data: unknown }).data).toMatchObject({ message_ids: ids.slice(0, 50), message_count: 100, truncated: true });
    const small = realtimeApprovalResolved({ agentId: AGENT, approvalId: APPROVAL, decision: 'approved', resolvedAt: NOW, messageIds: [MESSAGE] }, NOW);
    expect((JSON.parse(small.frame) as { data: unknown }).data).toMatchObject({ message_count: 1, truncated: false });
  });

  it('approval.resolved — 결정 두 값만 · message_ids 는 uuid', () => {
    const event = realtimeApprovalResolved({ agentId: AGENT, approvalId: APPROVAL, decision: 'approved', resolvedAt: NOW, messageIds: [MESSAGE] }, NOW);
    expect(JSON.parse(event.frame)).toMatchObject({ type: 'approval.resolved', data: { approval_id: APPROVAL, decision: 'approved', message_ids: [MESSAGE] } });
    expect(() => realtimeApprovalResolved({ agentId: AGENT, approvalId: APPROVAL, decision: 'expired', resolvedAt: NOW, messageIds: [] }, NOW)).toThrow();
  });
});

describe('createRealtimePusher', () => {
  // 전송 · 410 · 실패 삼킴 · 시간 상한 · 격리 · 조립은 `test/unit/adversarial/realtime-push.test.ts`(E3 · E5)가 본다.
  it('빈 id 목록 · 포트가 없는 종류는 DB 를 부르지 않는다', async () => {
    const asked: unknown[] = [];
    const store: RealtimeTargetStore = {
      inboundTargets(ids) {
        asked.push(ids);
        return Promise.resolve([]);
      },
      markGone: () => Promise.resolve(),
    };
    const sink: RealtimeTransport = { post: () => Promise.reject(new Error('unexpected post')) };
    const pusher = createRealtimePusher({ targets: store, transport: sink, routeId: 'test' });
    await pusher.messagesVisible([]);
    await pusher.aiWatchReleased('44444444-4444-4444-8444-444444444444');
    await pusher.approvalResolved(APPROVAL);
    expect(asked).toEqual([]);
  });
});
