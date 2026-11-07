/**
 * 공급자 결과 → 엔타이틀먼트 쓰기 결정(`decideProviderEntitlement`, 계획 §3-3 · 진윤겸 결정 D-3 보완). DB 없음 — 순수 함수의 표와 속성.
 *
 *   ① 필수 행(§3-3.8): beta 행 + pro 활성 → noop(`operator_row_held`) · 운영자 덮어쓰기 행 + 갱신 이벤트 → noop · 넘긴 행 + 이벤트 → 쓰기 ·
 *      넘긴 행 + reconcile → noop · 유예 만료된 beta 행 + pro 활성 → 쓰기 · 같은 입력 두 번 → 두 번째 noop · 입력 순서를 섞어도 같은 출력.
 *   ② 후보 고르기: active·trialing · past_due 유예 14일 · paused·canceled 는 후보 아님 · 최고 순위 · 모르는 가격 noop.
 *   ③ 출처별 규칙: 행 없음 · provider 행(강등 포함) · 운영자 행 위의 해지(noop) · reconcile 은 운영자 행을 덮지 않는다.
 *   ④ 원인: provider_event · reconcile · grace_expired.
 */

import { describe, expect, it } from 'vitest';

import { PROVIDER_GRACE_DAYS } from '../../../src/billing/constants';
import { PLAN_CATALOG, type PaidPlanCode, type PlanCode } from '../../../src/billing/plans';
import type { ProviderSubscriptionStatus } from '../../../src/billing/provider';
import {
  decideProviderEntitlement,
  type DecisionRow,
  type DecisionSubscription,
  type DecisionTrigger,
  type EntitlementDecision,
} from '../../../src/billing/sync-decision';
import type { OrgEntitlementsControlRow } from '../../../src/db/schema';
import { entitlementRow } from '../../support/entitlements';

const NOW = new Date('2026-10-10T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function sub(status: ProviderSubscriptionStatus, planCode: PaidPlanCode | null, pastDueSince: Date | null = null): DecisionSubscription {
  return { status, planCode, pastDueSince };
}

function row(plan: PlanCode, source: 'default' | 'operator' | 'provider', overrides: Partial<OrgEntitlementsControlRow> = {}): DecisionRow {
  return { ...entitlementRow(plan, { source }), provider_override_allowed: false, ...overrides };
}

function decide(subscriptions: readonly DecisionSubscription[], current: DecisionRow | null, trigger: DecisionTrigger = 'event', now = NOW): EntitlementDecision {
  return decideProviderEntitlement({ subscriptions, row: current, now, trigger });
}

/** 결정대로 쓴 뒤의 행(같은 입력을 두 번 넣는 속성용). */
function applied(before: DecisionRow | null, decision: EntitlementDecision): DecisionRow | null {
  if (decision.kind === 'noop') return before;
  const { planCode, limits, graceUntil } = decision.write;
  return {
    ...entitlementRow(planCode, { source: 'provider', grace_until: graceUntil }),
    max_agents: limits.maxAgents,
    provider_override_allowed: false,
  };
}

describe('① 필수 행(계획 §3-3.8)', () => {
  it('beta 행 + pro 활성 → noop(operator_row_held) — pro 가 beta 의 하루 발송 한도를 넘지 못한다(순위는 같아도 지배 못 함)', () => {
    for (const source of ['default', 'operator'] as const) {
      expect(decide([sub('active', 'pro')], row('beta', source))).toEqual({ kind: 'noop', desired: 'pro', reason: 'operator_row_held' });
    }
    // team · scale 도 beta 를 지배하지 못한다 — beta 기간에는 결제가 beta 행을 덮지 않는다.
    expect(decide([sub('active', 'scale')], row('beta', 'operator'))).toMatchObject({ kind: 'noop', reason: 'operator_row_held' });
  });

  it('운영자 덮어쓰기 행 + 갱신 이벤트 → noop — 운영자가 올려 준 칸(에이전트 20)을 결제 갱신이 되돌리지 않는다', () => {
    const override = row('pro', 'operator', { cause: 'operator', max_agents: 20 });
    expect(decide([sub('active', 'pro')], override)).toEqual({ kind: 'noop', desired: 'pro', reason: 'operator_row_held' });
    expect(decide([sub('active', 'pro')], override, 'operator_sync')).toMatchObject({ kind: 'noop', reason: 'operator_row_held' });
  });

  it('넘긴 행(provider_override_allowed) + 이벤트 → 쓰기 · + operator_sync → 쓰기 · + reconcile → noop', () => {
    const released = row('pro', 'operator', { cause: 'operator', max_agents: 20, provider_override_allowed: true });
    expect(decide([sub('active', 'pro')], released)).toEqual({
      kind: 'write',
      desired: 'pro',
      write: { planCode: 'pro', limits: PLAN_CATALOG.pro, graceUntil: null, cause: 'provider_event' },
    });
    expect(decide([sub('active', 'pro')], released, 'operator_sync')).toMatchObject({ kind: 'write', write: { cause: 'reconcile' } });
    expect(decide([sub('active', 'pro')], released, 'reconcile')).toEqual({ kind: 'noop', desired: 'pro', reason: 'reconcile_operator_row' });
    // 넘긴 행이면 해지(free)도 쓴다 — 운영자가 공급자에게 넘긴 행이다.
    expect(decide([sub('canceled', 'pro')], released)).toMatchObject({ kind: 'write', write: { planCode: 'free', limits: PLAN_CATALOG.free } });
  });

  it.each([
    ['운영자 pro(카탈로그 그대로) 넘김 + pro 활성', row('pro', 'operator', { cause: 'operator', provider_override_allowed: true }), [sub('active', 'pro')], 'pro'],
    ['운영자 free 넘김 + 구독 없음', row('free', 'operator', { cause: 'operator', provider_override_allowed: true }), [], 'free'],
    ['운영자 free 넘김 + 해지된 team 구독만', row('free', 'operator', { cause: 'operator', provider_override_allowed: true }), [sub('canceled', 'team')], 'free'],
  ] as const)('M-1 넘긴 행이 원하는 값과 같아도 → 쓰기(%s) · reconcile 은 여전히 noop', (_name, released, subscriptions, plan) => {
    for (const trigger of ['event', 'operator_sync'] as const) {
      expect(decide(subscriptions, released, trigger), trigger).toMatchObject({ kind: 'write', desired: plan, write: { planCode: plan, limits: PLAN_CATALOG[plan] } });
    }
    expect(decide(subscriptions, released, 'reconcile')).toEqual({ kind: 'noop', desired: plan, reason: 'reconcile_operator_row' });
    // 쓰고 나면 provider 행 — 같은 입력의 두 번째는 noop.
    const first = decide(subscriptions, released);
    expect(decide(subscriptions, applied(released, first))).toMatchObject({ kind: 'noop', reason: 'unchanged' });
  });

  it('유예 만료된 beta 행(적용 한도 = free) + pro 활성 → 쓰기', () => {
    const expired = row('beta', 'operator', { cause: 'review', grace_until: new Date(NOW.getTime() - DAY) });
    expect(decide([sub('active', 'pro')], expired)).toEqual({
      kind: 'write',
      desired: 'pro',
      write: { planCode: 'pro', limits: PLAN_CATALOG.pro, graceUntil: null, cause: 'provider_event' },
    });
  });

  it('같은 입력 두 번 → 두 번째 noop(unchanged) — 버전이 한 번만 오른다', () => {
    const cases: Array<[readonly DecisionSubscription[], DecisionRow | null]> = [
      [[sub('active', 'team')], null],
      [[sub('past_due', 'pro', new Date(NOW.getTime() - 3 * DAY))], row('pro', 'provider')],
      [[sub('canceled', 'pro')], row('pro', 'provider')],
      [[sub('active', 'scale')], row('free', 'default')],
    ];
    for (const [subscriptions, current] of cases) {
      const first = decide(subscriptions, current);
      expect(first.kind).toBe('write');
      expect(decide(subscriptions, applied(current, first))).toMatchObject({ kind: 'noop', reason: 'unchanged' });
    }
  });

  it('입력 순서를 섞어도 같은 출력(속성 — 모든 순열)', () => {
    const subscriptions = [
      sub('active', 'pro'),
      sub('past_due', 'team', new Date(NOW.getTime() - 2 * DAY)),
      sub('past_due', 'team', new Date(NOW.getTime() - 5 * DAY)),
      sub('canceled', 'scale'),
      sub('paused', 'scale'),
      sub('trialing', 'pro'),
    ];
    const permutations = (items: readonly DecisionSubscription[]): DecisionSubscription[][] =>
      items.length <= 1 ? [[...items]] : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
    for (const current of [null, row('free', 'provider'), row('beta', 'operator'), row('pro', 'operator', { provider_override_allowed: true })]) {
      for (const trigger of ['event', 'reconcile', 'operator_sync'] as const) {
        const expected = decide(subscriptions, current, trigger);
        for (const order of permutations(subscriptions)) expect(decide(order, current, trigger)).toEqual(expected);
      }
    }
    // 유예가 남은 team 둘 중 늦게 끝나는 쪽(2일 전 시작 → 12일 남음).
    expect(decide(subscriptions, null)).toMatchObject({
      kind: 'write',
      write: { planCode: 'team', graceUntil: new Date(NOW.getTime() - 2 * DAY + PROVIDER_GRACE_DAYS * DAY) },
    });
  });
});

describe('② 후보 고르기', () => {
  it('active · trialing → 그 요금제 · paused · canceled → 후보 아님(free)', () => {
    expect(decide([sub('trialing', 'team')], null)).toMatchObject({ kind: 'write', desired: 'team' });
    expect(decide([sub('paused', 'team')], row('team', 'provider'))).toMatchObject({ kind: 'write', desired: 'free', write: { planCode: 'free' } });
    expect(decide([sub('canceled', 'team')], row('team', 'provider'))).toMatchObject({ kind: 'write', desired: 'free' });
    expect(decide([], row('pro', 'provider'))).toMatchObject({ kind: 'write', desired: 'free' });
  });

  it('past_due — 유예(past_due_since + 14일)가 남으면 그 요금제 + grace_until · 경계에서 끝난다 · 기준이 없으면 끝난 것으로', () => {
    const since = new Date(NOW.getTime() - 13 * DAY);
    expect(decide([sub('past_due', 'pro', since)], null)).toEqual({
      kind: 'write',
      desired: 'pro',
      write: { planCode: 'pro', limits: PLAN_CATALOG.pro, graceUntil: new Date(since.getTime() + PROVIDER_GRACE_DAYS * DAY), cause: 'provider_event' },
    });
    const exact = new Date(NOW.getTime() - PROVIDER_GRACE_DAYS * DAY);
    expect(decide([sub('past_due', 'pro', exact)], row('pro', 'provider'))).toMatchObject({ kind: 'write', desired: 'free' });
    expect(decide([sub('past_due', 'pro', null)], row('pro', 'provider'))).toMatchObject({ kind: 'write', desired: 'free' });
  });

  it('여러 구독 → PLAN_RANK 최고 · 같은 순위면 유예 없는 쪽', () => {
    expect(decide([sub('active', 'pro'), sub('active', 'scale'), sub('trialing', 'team')], null)).toMatchObject({ desired: 'scale' });
    expect(decide([sub('past_due', 'team', new Date(NOW.getTime() - DAY)), sub('active', 'team')], null)).toMatchObject({
      kind: 'write',
      write: { planCode: 'team', graceUntil: null },
    });
  });

  it('모르는 가격(planCode null)이 canceled 아닌 구독에 있으면 noop(unknown_price) — "구독 없음" 으로 강등하지 않는다', () => {
    for (const status of ['active', 'trialing', 'past_due', 'paused'] as const) {
      expect(decide([sub(status, null), sub('active', 'pro')], row('pro', 'provider')), status).toEqual({ kind: 'noop', desired: null, reason: 'unknown_price' });
    }
    // 해지된 구독의 모르는 가격은 결정에 들어가지 않는다.
    expect(decide([sub('canceled', null), sub('active', 'pro')], null)).toMatchObject({ kind: 'write', desired: 'pro' });
  });
});

describe('③ 출처별 쓰기 규칙', () => {
  it('행 없음 → 유료면 쓰기, free 면 noop(unchanged — 행 없음 = Free)', () => {
    expect(decide([sub('active', 'pro')], null)).toMatchObject({ kind: 'write', write: { planCode: 'pro', limits: PLAN_CATALOG.pro } });
    expect(decide([sub('canceled', 'pro')], null)).toEqual({ kind: 'noop', desired: 'free', reason: 'unchanged' });
    expect(decide([], null)).toEqual({ kind: 'noop', desired: 'free', reason: 'unchanged' });
  });

  it('provider 행 → 그대로 쓴다(올림 · 강등 · 유예) · reconcile 도 provider 행은 쓴다', () => {
    expect(decide([sub('active', 'team')], row('pro', 'provider'))).toMatchObject({ kind: 'write', desired: 'team' });
    expect(decide([sub('active', 'pro')], row('team', 'provider'))).toMatchObject({ kind: 'write', desired: 'pro' });
    expect(decide([sub('canceled', 'team')], row('team', 'provider'), 'reconcile')).toMatchObject({ kind: 'write', desired: 'free', write: { cause: 'reconcile' } });
    expect(decide([sub('active', 'team')], row('team', 'provider'))).toEqual({ kind: 'noop', desired: 'team', reason: 'unchanged' });
  });

  it('운영자·백필 행 + 칸별로 지배하는 결제 → 쓰기(free 백필 · pro 운영자 행 위의 team)', () => {
    expect(decide([sub('active', 'pro')], row('free', 'default'))).toMatchObject({ kind: 'write', desired: 'pro' });
    expect(decide([sub('active', 'team')], row('pro', 'operator', { cause: 'operator' }))).toMatchObject({ kind: 'write', desired: 'team' });
    // 같은 요금제·같은 한도의 운영자 행이어도 쓴다 — 출처를 provider 로 바꿔야 뒤의 해지가 닿는다(M-1 · 저장소와 같은 판정). 쓴 뒤에는 noop.
    const same = row('pro', 'operator', { cause: 'operator' });
    const first = decide([sub('active', 'pro')], same);
    expect(first).toEqual({ kind: 'write', desired: 'pro', write: { planCode: 'pro', limits: PLAN_CATALOG.pro, graceUntil: null, cause: 'provider_event' } });
    expect(decide([sub('active', 'pro')], applied(same, first))).toEqual({ kind: 'noop', desired: 'pro', reason: 'unchanged' });
  });

  it('운영자·백필 행 + 해지·만료(free) → noop(operator_row_kept) — 공급자 강등은 provider 행에만', () => {
    expect(decide([sub('canceled', 'pro')], row('pro', 'operator'))).toEqual({ kind: 'noop', desired: 'free', reason: 'operator_row_kept' });
    expect(decide([], row('beta', 'default'))).toEqual({ kind: 'noop', desired: 'free', reason: 'operator_row_kept' });
  });

  it('reconcile 은 운영자·백필 행을 덮지 않는다 — 지배해도 noop(알람 없음) · 지배 못 하면 operator_row_held(알람)', () => {
    expect(decide([sub('active', 'pro')], row('free', 'default'), 'reconcile')).toEqual({ kind: 'noop', desired: 'pro', reason: 'reconcile_operator_row' });
    expect(decide([sub('active', 'pro')], row('beta', 'operator'), 'reconcile')).toEqual({ kind: 'noop', desired: 'pro', reason: 'operator_row_held' });
    expect(decide([sub('canceled', 'pro')], row('pro', 'operator'), 'reconcile')).toEqual({ kind: 'noop', desired: 'free', reason: 'reconcile_operator_row' });
  });

  it('모르는 출처 값은 덮지 않는 쪽(운영자 행처럼)', () => {
    expect(decide([sub('active', 'pro')], row('beta', 'default', { source: 'legacy' }))).toMatchObject({ kind: 'noop', reason: 'operator_row_held' });
  });
});

describe('④ 원인', () => {
  it('event → provider_event · reconcile·operator_sync → reconcile · 유예 만료만으로 free → grace_expired', () => {
    expect(decide([sub('active', 'pro')], null, 'event')).toMatchObject({ write: { cause: 'provider_event' } });
    expect(decide([sub('active', 'pro')], null, 'operator_sync')).toMatchObject({ write: { cause: 'reconcile' } });
    expect(decide([sub('active', 'team')], row('pro', 'provider'), 'reconcile')).toMatchObject({ write: { cause: 'reconcile' } });
    const lapsed = sub('past_due', 'pro', new Date(NOW.getTime() - 20 * DAY));
    for (const trigger of ['event', 'reconcile', 'operator_sync'] as const) {
      expect(decide([lapsed], row('pro', 'provider', { grace_until: new Date(NOW.getTime() - 6 * DAY) }), trigger), trigger).toMatchObject({
        kind: 'write',
        write: { planCode: 'free', cause: 'grace_expired', graceUntil: null },
      });
    }
    // 해지와 유예 만료가 섞이면 "유예 만료뿐" 이 아니다 — 계기의 원인.
    expect(decide([lapsed, sub('canceled', 'team')], row('pro', 'provider'))).toMatchObject({ write: { cause: 'provider_event' } });
    expect(decide([sub('canceled', 'team')], row('pro', 'provider'))).toMatchObject({ write: { cause: 'provider_event' } });
  });
});
