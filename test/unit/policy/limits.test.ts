/**
 * Stage 4 — 한도와 **워밍업 캡** (계획 §3.3, r5 R22).
 *
 * 이 파일이 특별한 이유: 워밍업 표는 **평판을 지키는 유일한 제동장치**다.
 * SES 계정 한도는 50,000통/일이고 샌드박스는 2026-09-22 에 46초 만에 풀렸다.
 * 표의 한 행이 조용히 바뀌거나 일차 계산이 하루 밀리면 **아무 테스트도 빨간불이 되지 않은 채**
 * 상한이 올라간다. 그래서 여기서는 표 자체를 값으로 단언하고, 구간 경계를 전수로 돈다.
 */

import { describe, expect, it } from 'vitest';
import { evaluate } from '../../../src/policy/engine';
import {
  WARMUP_DAILY_CAPS,
  WARMUP_DAY_ZERO_CAP,
  WARMUP_STEADY_STATE_DAILY_CAP,
  warmupDailyCap,
  warmupDayIndex,
} from '../../../src/policy/rules/limits';
import { basePolicy, contextWith, policyWith, SENDING_STARTED_AT } from './fixtures';

/** `sendingStartedAt` 기준 N 일차의 시각(UTC 정오). */
function dayN(n: number): Date {
  return new Date(SENDING_STARTED_AT.getTime() + (n - 1) * 86_400_000 + 12 * 3_600_000);
}

describe('워밍업 표 — 계획 §3.3 의 코드 대응물', () => {
  it('표가 계획과 글자 그대로 같다 — 이 단언을 고치는 것은 평판 리스크를 고치는 것이다', () => {
    expect(WARMUP_DAILY_CAPS).toEqual([
      { throughDay: 3, cap: 20 },
      { throughDay: 6, cap: 50 },
      { throughDay: 9, cap: 100 },
      { throughDay: 12, cap: 200 },
      { throughDay: 15, cap: 400 },
    ]);
    expect(WARMUP_STEADY_STATE_DAILY_CAP).toBe(1000);
  });

  it('캡은 단조 증가한다 — 램프가 중간에 내려가면 표가 깨진 것이다', () => {
    const caps = [...WARMUP_DAILY_CAPS.map((step) => step.cap), WARMUP_STEADY_STATE_DAILY_CAP];
    for (let i = 1; i < caps.length; i += 1) {
      expect(caps[i]).toBeGreaterThan(caps[i - 1] as number);
    }
  });

  it('구간 경계 전수 — Day 1~17 의 캡', () => {
    const expected: readonly (readonly [number, number])[] = [
      [1, 20], [2, 20], [3, 20],
      [4, 50], [5, 50], [6, 50],
      [7, 100], [8, 100], [9, 100],
      [10, 200], [11, 200], [12, 200],
      [13, 400], [14, 400], [15, 400],
      [16, 1000], [17, 1000],
    ];
    for (const [day, cap] of expected) {
      expect(warmupDailyCap(dayN(day), SENDING_STARTED_AT)).toBe(cap);
    }
  });
});

describe('워밍업 일차 계산', () => {
  it('기준일 당일이 Day 1 이다 (§3.3 M7 — 기준일은 최초 발송 성공일)', () => {
    expect(warmupDayIndex(dayN(1), SENDING_STARTED_AT)).toBe(1);
  });

  it('UTC 자정 경계로 넘어간다 — 로컬 타임존에 따라 캡이 달라지면 안 된다', () => {
    const lastMomentOfDay1 = new Date(SENDING_STARTED_AT.getTime() + 86_399_999);
    const firstMomentOfDay2 = new Date(SENDING_STARTED_AT.getTime() + 86_400_000);
    expect(warmupDayIndex(lastMomentOfDay1, SENDING_STARTED_AT)).toBe(1);
    expect(warmupDayIndex(firstMomentOfDay2, SENDING_STARTED_AT)).toBe(2);
  });

  it('sending_started_at 이 null 이면 첫 구간 캡을 적용한다 — 기준일 부재가 캡 부재가 아니다', () => {
    expect(warmupDayIndex(dayN(1), null)).toBeNull();
    expect(warmupDailyCap(dayN(1), null)).toBe(WARMUP_DAY_ZERO_CAP);
    expect(WARMUP_DAY_ZERO_CAP).toBe(20);
  });

  it('기준일이 미래여도 상한이 올라가지 않는다 (시계 역행 방어)', () => {
    const past = new Date(SENDING_STARTED_AT.getTime() - 10 * 86_400_000);
    expect(warmupDayIndex(past, SENDING_STARTED_AT)).toBe(1);
    expect(warmupDailyCap(past, SENDING_STARTED_AT)).toBe(20);
  });
});

describe('Stage 4 — 워밍업 캡 집행', () => {
  it('AC-c2: 워밍업 6일차에 51번째 발송이 warmup_daily_cap 으로 차단된다', () => {
    const ctx = contextWith({
      now: dayN(6),
      counters: { orgRecipientsLastDay: 50 },
    });
    const decision = evaluate(ctx, basePolicy);

    expect(decision.verdict).toBe('denied');
    expect(decision.reasons).toContain('warmup_daily_cap');
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('같은 6일차의 50번째 발송은 통과한다 — 경계가 정확히 캡 위에 있다', () => {
    const decision = evaluate(contextWith({ now: dayN(6), counters: { orgRecipientsLastDay: 49 } }), basePolicy);
    expect(decision.verdict).toBe('allowed');
  });

  it('캡의 눈금은 **수신자 수**다 — 수신자 3명짜리 한 통이 캡을 3만큼 먹는다', () => {
    // 이 케이스가 눈금을 못 박는다. 캡을 메시지 수로 읽으면 18 + "1통" 이므로 통과하고,
    // 그 해석 아래에서는 Day 1 캡 20 이 `MAX_RECIPIENTS_PER_MESSAGE = 50` 과 곱해져
    // 실제로는 하루 1,000 수신자를 허용한다. SES 평판은 수신자 단위로 계산된다.
    const recipients = ['a@example.com', 'b@example.com', 'c@example.com'];
    const decision = evaluate(
      contextWith({ now: dayN(1), attempt: { recipients }, counters: { orgRecipientsLastDay: 18 } }),
      policyWith({ allowlist: recipients }),
    );

    expect(decision.verdict).toBe('denied');
    expect(decision.reasons).toContain('warmup_daily_cap');
  });

  it('같은 수신자 3명이라도 캡에 여유가 있으면 통과한다 — 경계는 캡 위에 정확히 있다', () => {
    const recipients = ['a@example.com', 'b@example.com', 'c@example.com'];
    const decision = evaluate(
      contextWith({ now: dayN(1), attempt: { recipients }, counters: { orgRecipientsLastDay: 17 } }),
      policyWith({ allowlist: recipients }),
    );

    expect(decision.verdict).toBe('allowed');
  });

  it('캡은 **조직 전체** 기준이다 — 에이전트를 늘려도 우회되지 않는다', () => {
    // 에이전트 카운터는 0 이지만 조직 카운터가 캡에 도달했다.
    const decision = evaluate(
      contextWith({ now: dayN(1), counters: { agentLastDay: 0, orgRecipientsLastDay: 20 } }),
      basePolicy,
    );
    expect(decision.reasons).toContain('warmup_daily_cap');
  });

  it('정책 jsonb 로는 캡을 올릴 수 없다 — 한도를 무한대로 열어도 캡이 이긴다', () => {
    const decision = evaluate(
      contextWith({ now: dayN(1), counters: { orgRecipientsLastDay: 100 } }),
      policyWith({ limits: { perMinute: 1e9, perHour: 1e9, perDay: 1e9 } }),
    );
    expect(decision.verdict).toBe('denied');
    expect(decision.reasons).toEqual(['warmup_daily_cap']);
  });
});

describe('Stage 4 — 분·시·일 한도', () => {
  // 일일 한도의 retry_after 는 다음 UTC 자정까지 — 픽스처 NOW 는 12:00:00Z 라 12시간.
  it.each([
    ['rate_limit_per_minute', { agentLastMinute: 10 }, 60],
    ['rate_limit_per_hour', { agentLastHour: 100 }, 3600],
    ['rate_limit_per_day', { agentLastDay: 500 }, 12 * 3600],
  ] as const)('%s + retry_after', (reason, counters, retryAfter) => {
    const decision = evaluate(contextWith({ counters }), basePolicy);
    expect(decision.reasons).toContain(reason);
    expect(decision.retryAfterSeconds).toBe(retryAfter);
  });

  it('한도에 **도달**하면 막는다 — `>` 로 쓰면 N+1 통째가 나간다', () => {
    expect(evaluate(contextWith({ counters: { agentLastMinute: 9 } }), basePolicy).verdict).toBe('allowed');
    expect(evaluate(contextWith({ counters: { agentLastMinute: 10 } }), basePolicy).verdict).toBe('denied');
  });

  it('메시지당 수신자 수 한도 → recipients_per_message', () => {
    const recipients = Array.from({ length: 11 }, (_unused, index) => `r${index}@example.com`);
    const decision = evaluate(
      contextWith({ attempt: { recipients } }),
      policyWith({ allowlist: recipients }),
    );
    expect(decision.reasons).toContain('recipients_per_message');
  });

  it('여러 축에 동시에 걸리면 retry_after 는 **가장 긴 것**이다', () => {
    const decision = evaluate(
      contextWith({ counters: { agentLastMinute: 10, agentLastHour: 100 } }),
      basePolicy,
    );
    expect(decision.reasons).toEqual(['rate_limit_per_minute', 'rate_limit_per_hour']);
    expect(decision.retryAfterSeconds).toBe(3600);
  });
});
