/**
 * AC-0 판정 단위 테스트의 공통 시나리오 — 기준 시나리오(`judge({})`)는 통과다:
 * 1일차 전 ON · 관측 추세 감소(DECLINING) · 7일차 23:30 OFF · 증명 7일 무개입 · 활동 충족 · 15일차 01시 판정.
 */

import { AC0_ACTIVITY_THRESHOLDS, DAY_MS, kstMidnightOf, type Ac0Activity, type Ac0Window } from '../../../../src/observability/ac0-metrics';
import {
  ac0ActivityWindows,
  decideAc0,
  type Ac0Facts,
  type Ac0Verdict,
  type ForwardedArrival,
  type GateEvent,
  type InterventionRecord,
} from '../../../../src/gate/ac0-verdict';

export const T1 = kstMidnightOf('2026-10-01') as Date;
const HOUR = 3_600_000;

/** `day` 일차(1-기반, 0 = 1일차 전날) KST `hour`시 `minute`분. */
export function at(day: number, hour = 12, minute = 0): Date {
  return new Date(T1.getTime() + (day - 1) * DAY_MS + hour * HOUR + minute * 60_000);
}

/** 하루 `count` 통 — 서로 다른 외부 발신자 `count` 명(p0, p1, …)에게서. */
export function arrivals(perDay: Readonly<Record<number, number>>): ForwardedArrival[] {
  const out: ForwardedArrival[] = [];
  for (const [day, count] of Object.entries(perDay)) {
    for (let i = 0; i < count; i += 1) out.push({ at: at(Number(day), 9, i), sender: `p${String(i)}@partner.kr` });
  }
  return out;
}

/** 외부 발신자 한 명의 전달 한 통. */
export function fwd(when: Date, sender: string | null = 'late@partner.kr'): ForwardedArrival {
  return { at: when, sender };
}

export const START: GateEvent = { kind: 'start', recordedAt: at(0, 10), effectiveAt: T1 };
export const ON: GateEvent = { kind: 'forwarding_on', recordedAt: at(0, 11) };
export const OFF: GateEvent = { kind: 'forwarding_off', recordedAt: at(7, 23, 30) };
export const DECLINING = { 1: 6, 2: 5, 3: 4, 4: 3, 5: 3, 6: 2, 7: 2 };

/** 8일차 복귀 4회(재시작 신호 — 3회 초과). */
export const RESTARTS: GateEvent[] = [1, 2, 3, 4].map((n) => ({
  kind: 'restart',
  recordedAt: at(8 + n, 10),
  effectiveAt: at(9 + n, 0),
  returnDay: 8,
  cause: 'intervention_other',
}));

export function activityFor(window: Ac0Window, satisfied: boolean): Ac0Activity {
  const t = AC0_ACTIVITY_THRESHOLDS;
  return satisfied
    ? { window, newExternalContacts: t.newExternalContacts, outboundSuccess: t.outboundSuccess, multiTurnThreads: t.multiTurnThreads, satisfied: true, shortfalls: [] }
    : { window, newExternalContacts: 0, outboundSuccess: 0, multiTurnThreads: 0, satisfied: false, shortfalls: ['활동 0'] };
}

export interface Scenario {
  readonly asOf?: Date;
  readonly events?: readonly GateEvent[];
  readonly forwarded?: readonly ForwardedArrival[];
  readonly auxiliary?: readonly Date[];
  readonly interventions?: readonly InterventionRecord[];
  /** 창마다 충족 여부. 기본은 전부 충족. */
  readonly activitySatisfied?: boolean | ((window: Ac0Window) => boolean);
}

export function factsOf(scenario: Scenario): Ac0Facts {
  return {
    asOf: scenario.asOf ?? at(15, 1),
    events: scenario.events ?? [START, ON, OFF],
    forwardedArrivals: scenario.forwarded ?? arrivals(DECLINING),
    auxiliaryArrivals: scenario.auxiliary ?? [],
    interventions: scenario.interventions ?? [],
  };
}

export function judge(scenario: Scenario): Ac0Verdict {
  const facts = factsOf(scenario);
  const satisfied = scenario.activitySatisfied ?? true;
  const activities = ac0ActivityWindows(facts).map((window) =>
    activityFor(window, typeof satisfied === 'function' ? satisfied(window) : satisfied),
  );
  return decideAc0(facts, activities);
}
