/**
 * AC-0 활동 분모(AC-b5)와 KST 달력 — 순수 계산.
 *
 * 분모가 막으려는 것은 "아무 일도 안 한 7일" 과 "대표에게 보고만 한 7일" 이 개입 0 으로 통과하는 것이다
 * (§3.2 V1). 그래서 **내부 주소(대표·에이전트 도메인)는 어느 분모도 채우지 못한다**를 각각 고정한다.
 */

import { describe, expect, it } from 'vitest';

import {
  AC0_ACTIVITY_THRESHOLDS,
  computeAc0Activity,
  countPerDay,
  DAY_MS,
  formatKst,
  kstDayStart,
  kstMidnightAfter,
  kstMidnightAtOrAfter,
  kstMidnightOf,
  type ActivityFacts,
  type ThreadMessageFact,
} from '../../../src/observability/ac0-metrics';

const START = kstMidnightOf('2026-10-08') as Date;
const WINDOW = { start: START, end: new Date(START.getTime() + 7 * DAY_MS) };
const inside = (hours: number): Date => new Date(START.getTime() + hours * 3_600_000);
const before = new Date(START.getTime() - 1);

const OWNER = 'jinyounkyum@gmail.com';
const isInternal = (address: string): boolean => address.endsWith('@atmark.ai') || address === OWNER;

function facts(overrides: Partial<ActivityFacts>): ActivityFacts {
  return {
    window: WINDOW,
    sentMessages: [],
    recipientFirstSent: [],
    threadMessages: [],
    isInternal,
    contactKey: (address) => address,
    ...overrides,
  };
}

function conversation(threadId: string, directions: readonly ('outbound' | 'inbound')[], from = 'bob@vendor.kr'): ThreadMessageFact[] {
  return directions.map((direction, index) => ({
    threadId,
    direction,
    occurredAt: inside(1 + index),
    automated: false,
    inboundFrom: direction === 'inbound' ? from : null,
  }));
}

describe('KST 달력', () => {
  it('kstMidnightOf 는 KST 자정(= 전날 15:00 UTC)', () => {
    expect(kstMidnightOf('2026-10-08')?.toISOString()).toBe('2026-10-07T15:00:00.000Z');
    expect(kstMidnightOf('2026-02-30')).toBeNull();
    expect(kstMidnightOf('20261008')).toBeNull();
  });

  it('14:59:59Z 는 전날, 15:00Z 는 다음 날', () => {
    const boundary = new Date('2026-10-07T15:00:00.000Z');
    expect(kstDayStart(new Date(boundary.getTime() - 1)).toISOString()).toBe('2026-10-06T15:00:00.000Z');
    expect(kstDayStart(boundary).toISOString()).toBe('2026-10-07T15:00:00.000Z');
    expect(kstMidnightAtOrAfter(boundary)).toEqual(boundary);
    expect(kstMidnightAfter(boundary).toISOString()).toBe('2026-10-08T15:00:00.000Z');
    expect(formatKst(boundary)).toBe('2026-10-08 00:00 KST');
  });

  it('countPerDay — 빈 날은 0, 범위 밖은 버린다', () => {
    expect(countPerDay(START, [before, inside(1), inside(2), inside(30), inside(24 * 9)], 3)).toEqual([2, 1, 0]);
  });
});

describe('AC-b5 활동 분모', () => {
  it('문턱 값은 계획 §3.2 V1 그대로', () => {
    expect(AC0_ACTIVITY_THRESHOLDS).toEqual({ newExternalContacts: 5, outboundSuccess: 30, multiTurnThreads: 3 });
  });

  it('활동 0 → 세 항목 전부 미달', () => {
    const activity = computeAc0Activity(facts({}));
    expect(activity.satisfied).toBe(false);
    expect(activity.shortfalls).toHaveLength(3);
  });

  it('신규 외부 상대: 창 안의 첫 발송만, 내부 주소 제외, 창 이전 첫 발송은 신규가 아니다', () => {
    const activity = computeAc0Activity(
      facts({
        recipientFirstSent: [
          { address: 'a@x.kr', firstSentAt: inside(1) },
          { address: 'b@x.kr', firstSentAt: inside(2) },
          { address: 'old@x.kr', firstSentAt: before },
          { address: OWNER, firstSentAt: inside(3) },
          { address: 'other-agent@atmark.ai', firstSentAt: inside(3) },
          { address: 'late@x.kr', firstSentAt: WINDOW.end },
        ],
      }),
    );
    expect(activity.newExternalContacts).toBe(2);
  });

  it('outbound 성공: 외부 수신자가 1명 이상인 발송만 — 대표에게만 보낸 30통은 0', () => {
    const toOwner = Array.from({ length: 30 }, (_, index) => ({ sentAt: inside(index), recipients: [OWNER] }));
    expect(computeAc0Activity(facts({ sentMessages: toOwner })).outboundSuccess).toBe(0);
    const mixed = [
      { sentAt: inside(1), recipients: [OWNER, 'a@x.kr'] },
      { sentAt: inside(2), recipients: [] },
      { sentAt: before, recipients: ['a@x.kr'] },
    ];
    expect(computeAc0Activity(facts({ sentMessages: mixed })).outboundSuccess).toBe(1);
  });

  it('3턴 스레드: out·in·out 은 3턴, out·out·out 은 1턴, 자동응답은 턴이 아니다', () => {
    const autoReply: ThreadMessageFact[] = conversation('t3', ['outbound', 'inbound', 'outbound']).map((message) =>
      message.direction === 'inbound' ? { ...message, automated: true } : message,
    );
    const activity = computeAc0Activity(
      facts({
        threadMessages: [
          ...conversation('t1', ['outbound', 'inbound', 'outbound']),
          ...conversation('t2', ['outbound', 'outbound', 'outbound']),
          ...autoReply,
        ],
      }),
    );
    expect(activity.multiTurnThreads).toBe(1);
  });

  it('3턴 스레드: 대표(내부)와 주고받은 스레드는 세지 않는다', () => {
    const activity = computeAc0Activity(facts({ threadMessages: conversation('t1', ['outbound', 'inbound', 'outbound'], OWNER) }));
    expect(activity.multiTurnThreads).toBe(0);
  });

  it('3턴 스레드: 창 밖의 메시지는 턴에 들지 않는다(창 이전에 진행된 대화 + 한 통 ≠ 이 주의 대화)', () => {
    const [first, second, third] = conversation('t1', ['outbound', 'inbound', 'outbound']);
    const activity = computeAc0Activity(
      facts({
        threadMessages: [
          { ...(first as ThreadMessageFact), occurredAt: before },
          { ...(second as ThreadMessageFact), occurredAt: before },
          third as ThreadMessageFact,
        ],
      }),
    );
    expect(activity.multiTurnThreads).toBe(0);
  });

  it('세 문턱을 모두 채우면 satisfied', () => {
    const activity = computeAc0Activity(
      facts({
        recipientFirstSent: ['a', 'b', 'c', 'd', 'e'].map((name, index) => ({ address: `${name}@x.kr`, firstSentAt: inside(index) })),
        sentMessages: Array.from({ length: 30 }, (_, index) => ({ sentAt: inside(index), recipients: ['a@x.kr'] })),
        threadMessages: [
          ...conversation('t1', ['outbound', 'inbound', 'outbound']),
          ...conversation('t2', ['inbound', 'outbound', 'inbound']),
          ...conversation('t3', ['outbound', 'inbound', 'outbound', 'inbound']),
        ],
      }),
    );
    expect(activity).toMatchObject({ newExternalContacts: 5, outboundSuccess: 30, multiTurnThreads: 3, satisfied: true, shortfalls: [] });
  });
});
