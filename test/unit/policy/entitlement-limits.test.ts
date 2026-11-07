/**
 * Stage 4 × 요금제(ADR-0011) — **요금제는 조이기만 한다.** 각 축 = min(정책, 엔타이틀먼트) · 조직 하루 = min(워밍업, 요금제).
 * 되돌림 방지: 각 `min()` 을 지우면(정책 값만 보면) 아래 단언 하나가 빨개진다 — 정책은 넓게, 요금제는 좁게 둔다.
 */

import { describe, expect, it } from 'vitest';

import { evaluate } from '../../../src/policy/engine';
import { evaluateLimits, organizationDailyCap, WARMUP_DAY_ZERO_CAP, WARMUP_STEADY_STATE_DAILY_CAP } from '../../../src/policy/rules/limits';
import { DENY_REASON_PERSISTENCE } from '../../../src/policy/release-deferral';
import { entitlementsOf } from '../../support/entitlements';
import { baseContext, contextWith, NOW, policyWith } from './fixtures';

const FREE = entitlementsOf('free');
const WIDE = policyWith({ limits: { perMinute: 9999, perHour: 100_000, perDay: 10_000, recipientsPerMessage: 50 } });

function limitReasons(ctx: Parameters<typeof evaluateLimits>[0], policy = WIDE): readonly string[] {
  return evaluateLimits(ctx, policy)?.reasons ?? [];
}

describe('Stage 4 — 요금제 클램프', () => {
  it('per_minute = min(정책, 요금제): Free 5 에서 막힌다(정책은 9999)', () => {
    const at = (n: number) => limitReasons(contextWith({ organization: { entitlements: FREE }, counters: { agentLastMinute: n } }));
    expect(at(4)).toEqual([]);
    expect(at(5)).toEqual(['rate_limit_per_minute']);
    // beta 는 정책 값이 묶는다(요금제가 넓어도 정책을 넘지 않는다).
    expect(limitReasons(contextWith({ counters: { agentLastMinute: 5 } }), policyWith({ limits: { perMinute: 5 } }))).toEqual(['rate_limit_per_minute']);
  });

  it('per_day = min(정책, 요금제): Free 100', () => {
    expect(limitReasons(contextWith({ organization: { entitlements: FREE }, counters: { agentLastDay: 99 } }))).toEqual([]);
    expect(limitReasons(contextWith({ organization: { entitlements: FREE }, counters: { agentLastDay: 100 } }))).toEqual(['rate_limit_per_day']);
  });

  it('메시지당 수신자 = min(정책, 요금제): Free 10', () => {
    const recipients = (n: number) => Array.from({ length: n }, (_unused, index) => `r${String(index)}@example.com`);
    expect(limitReasons(contextWith({ organization: { entitlements: FREE }, attempt: { recipients: recipients(10) } }))).toEqual([]);
    // 정책(50) 안인데 요금제(10)만 넘었다 — 요금제 사유(일시적). 정책이 묶으면 영구 사유.
    expect(limitReasons(contextWith({ organization: { entitlements: FREE }, attempt: { recipients: recipients(11) } }))).toEqual(['plan_recipients_per_message']);
    expect(
      limitReasons(contextWith({ organization: { entitlements: FREE }, attempt: { recipients: recipients(11) } }), policyWith({ limits: { recipientsPerMessage: 10 } })),
    ).toEqual(['recipients_per_message']);
    expect(limitReasons(contextWith({ attempt: { recipients: recipients(11) } }), policyWith({ limits: { recipientsPerMessage: 10 } }))).toEqual(['recipients_per_message']);
    // 절대 천장(50)을 넘으면 어떤 요금제로도 풀리지 않는다 — 정책이 넓어도 영구.
    expect(limitReasons(contextWith({ attempt: { recipients: recipients(51) } }), policyWith({ limits: { recipientsPerMessage: 10_000 } }))).toEqual([
      'recipients_per_message',
    ]);
  });

  it('요금제가 묶은 메시지당 수신자는 릴리스에서 일시적 · 정책이 묶은 것은 영구(ADR-0011 §9 — 강등이 승인된 봉투를 죽이지 않는다)', () => {
    expect(DENY_REASON_PERSISTENCE.plan_recipients_per_message).toEqual(DENY_REASON_PERSISTENCE.plan_daily_cap);
    expect(DENY_REASON_PERSISTENCE.recipients_per_message).not.toEqual(DENY_REASON_PERSISTENCE.plan_recipients_per_message);
  });

  it('조직 하루: 요금제가 워밍업보다 작으면 plan_daily_cap(업그레이드 안내 가능) — 워밍업과 사유가 다르다', () => {
    const ctx = contextWith({ organization: { entitlements: FREE }, counters: { orgRecipientsLastDay: 100 } });
    const denial = evaluateLimits(ctx, WIDE);
    expect(denial?.reasons).toEqual(['plan_daily_cap']);
    expect(denial?.retryAfterSeconds).toBeGreaterThan(0);
    expect(limitReasons(contextWith({ organization: { entitlements: FREE }, counters: { orgRecipientsLastDay: 99 } }))).toEqual([]);
  });

  it('조직 하루: 워밍업이 요금제보다 작으면 warmup_daily_cap — 요금제가 워밍업을 넘기지 못한다(R22)', () => {
    const early = contextWith({ organization: { sendingStartedAt: null }, counters: { orgRecipientsLastDay: WARMUP_DAY_ZERO_CAP } });
    expect(limitReasons(early)).toEqual(['warmup_daily_cap']);
    // beta(1000) = 정상상태 워밍업(1000) — 같으면 워밍업이 묶는다(업그레이드로 풀리지 않는다).
    expect(limitReasons(contextWith({ counters: { orgRecipientsLastDay: WARMUP_STEADY_STATE_DAILY_CAP } }))).toEqual(['warmup_daily_cap']);
  });

  it('둘 다 넘으면 warmup_daily_cap — 업그레이드로 풀리지 않는 쪽이 사유다', () => {
    const early = contextWith({ organization: { entitlements: FREE, sendingStartedAt: null }, counters: { orgRecipientsLastDay: 100 } });
    expect(limitReasons(early)).toEqual(['warmup_daily_cap']);
    // 워밍업(20) 안 · 요금제(Free 100)는 워밍업보다 커서 묶지 않는다.
    expect(limitReasons(contextWith({ organization: { entitlements: FREE, sendingStartedAt: null }, counters: { orgRecipientsLastDay: 19 } }))).toEqual([]);
  });

  it('organizationDailyCap — min 과 사유', () => {
    expect(organizationDailyCap(NOW, baseContext.organization.sendingStartedAt, 100)).toEqual({ cap: 100, reason: 'plan_daily_cap' });
    expect(organizationDailyCap(NOW, null, 100)).toEqual({ cap: WARMUP_DAY_ZERO_CAP, reason: 'warmup_daily_cap' });
    expect(organizationDailyCap(NOW, baseContext.organization.sendingStartedAt, 5000)).toEqual({ cap: WARMUP_STEADY_STATE_DAILY_CAP, reason: 'warmup_daily_cap' });
  });

  it('plan_daily_cap 은 릴리스에서 일시적(워밍업과 같다)', () => {
    expect(DENY_REASON_PERSISTENCE.plan_daily_cap).toEqual(DENY_REASON_PERSISTENCE.warmup_daily_cap);
  });

  it('엔진 전체: Free 조직의 101번째 수신자는 plan_daily_cap 으로 거부', () => {
    const decision = evaluate(contextWith({ organization: { entitlements: FREE }, counters: { orgRecipientsLastDay: 100 } }), WIDE);
    expect(decision.verdict).toBe('denied');
    expect(decision.reasons).toEqual(['plan_daily_cap']);
  });
});
