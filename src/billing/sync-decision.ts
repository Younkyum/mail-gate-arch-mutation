/**
 * src/billing/sync-decision.ts — **공급자 결과 → 엔타이틀먼트 쓰기 결정**(순수 함수, 계획 §3-3 · 진윤겸 결정 D-3 보완).
 *
 * 입력은 조직의 **결속된 구독 전체**(재조회한 정규화 결과, 이 λ 환경의 것만)와 지금 `org_entitlements` 행이다. 이벤트 본문은 없다 —
 * 이벤트는 "다시 계산하라" 는 신호일 뿐이고, 결과는 구독 전체에서 매번 새로 나온다. 그래서 같은 입력은 같은 결과이고(두 번째는 noop),
 * 입력 순서가 달라도 결과가 같다(표 테스트의 속성).
 *
 *   1. 후보: 알려진 요금제의 `active`·`trialing` → 그 요금제 · `past_due` 이고 유예(`past_due_since` + 14일)가 남았으면 → 그 요금제 + 유예.
 *      `paused`·`canceled`·유예 지난 `past_due` 는 후보가 아니다.
 *   2. `canceled` 가 아닌 구독에 모르는 가격(`planCode` null)이 있으면 → noop(`unknown_price`) + 알람. 모르는 것을 "구독 없음" 으로 읽어
 *      강등하지 않는다(사전 부검 2).
 *   3. 원하는 요금제 = 후보 중 `PLAN_RANK` 최고(같으면 유예 없는 쪽), 없으면 `free`. 한도 = `PLAN_CATALOG[plan]`.
 *   4. 지금 행 출처에 따른 쓰기 규칙(D-3):
 *      - 행 없음 → 원하는 것이 유료면 쓴다(INSERT), free 면 noop(행 없음 = Free).
 *      - `provider` 출처 → 그대로 쓴다(강등 포함).
 *      - `default`·`operator` 이고 `provider_override_allowed`(운영자가 `admin:plan --release-to-provider` 로 넘김) → 계기가 `event`·`operator_sync`
 *        면 **값이 같아도** 쓴다(출처 provider · 제어 칸 false 로 이양을 끝낸다), `reconcile` 이면 noop(reconcile 은 운영자 행을 덮지 않는다).
 *      - `default`·`operator`(넘기지 않음) → 원하는 것이 유료이고 **한도 열한 칸이 모두 지금 적용 한도 이상**이며 계기가 `reconcile` 이 아닐 때만
 *        쓴다. 유료인데 지배하지 못하면 noop(`operator_row_held`) + `billing.entitlement_held` 알람. 원하는 것이 free(해지·만료)면 noop —
 *        공급자 강등은 provider 행에만.
 *   5. 지금 행이 provider 출처(넘김 표시 false)이고 요금제·한도 열한 칸·유예가 모두 같으면 noop(`unchanged`). 운영자 행은 값이 같아도 쓴다
 *      (출처를 provider 로 — 저장소 `writeEntitlementVersion` 과 같은 판정, 코드 검토 M-1).
 *   6. 원인: `event` → `provider_event` · `reconcile`/`operator_sync` → `reconcile` · 결과가 free 이고 이유가 유예 만료뿐이면 `grace_expired`.
 *
 * 결제 결정은 **순위가 아니라 칸별 지배 비교**다 — "beta 행 + pro 활성" 은 pro 가 beta 의 하루 발송 한도를 넘지 못해 noop 이다.
 *
 * import 는 이 폴더의 순수 파일 둘뿐이다(DB·공급자 모름). 쓰기(버전 +1 · 감사 · 잎)는 호출자(`sync.ts`·`reconcile.ts`)가
 * `writeEntitlementVersion` 으로 한다.
 */

import { PROVIDER_GRACE_DAYS } from './constants';
import {
  dominatesLimits,
  isPlanCode,
  LIMIT_COLUMNS,
  PLAN_CATALOG,
  PLAN_RANK,
  resolveEntitlements,
  type EntitlementCause,
  type EntitlementLimits,
  type EntitlementRowInput,
  type PaidPlanCode,
  type PlanCode,
} from './plans';
import type { ProviderSubscriptionStatus } from './provider';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 결정을 부른 계기 — 웹훅 이벤트 · 하루 1회 대조 · 운영자 수동 `sync-org`. */
export type DecisionTrigger = 'event' | 'reconcile' | 'operator_sync';

/** 결정에 필요한 구독 칸(표 `billing_subscriptions` 행이든 정규화 결과든 같은 모양으로 넘긴다). */
export interface DecisionSubscription {
  readonly status: ProviderSubscriptionStatus;
  /** null = 모르는 가격. */
  readonly planCode: PaidPlanCode | null;
  /** `past_due` 가 아니면 null. */
  readonly pastDueSince: Date | null;
}

/** 지금 `org_entitlements` 행 중 결정에 필요한 칸(`OrgEntitlementsControlRow` 의 부분). */
export interface DecisionRow extends EntitlementRowInput {
  readonly source: string;
  readonly provider_override_allowed: boolean;
}

export interface DecisionInput {
  readonly subscriptions: readonly DecisionSubscription[];
  /** 행이 없으면 null(= Free). */
  readonly row: DecisionRow | null;
  readonly now: Date;
  readonly trigger: DecisionTrigger;
}

/** 쓸 값 — 출처는 늘 `provider`(`atmark_billing` 롤은 그 출처만 쓸 수 있다 — 트리거 `org_entitlements_source_by_role`). */
export interface EntitlementWrite {
  readonly planCode: PlanCode;
  readonly limits: EntitlementLimits;
  readonly graceUntil: Date | null;
  readonly cause: EntitlementCause;
}

export type NoopReason =
  /** 결과가 지금 행과 같다(또는 행 없음 + free). */
  | 'unchanged'
  /** `canceled` 아닌 구독에 모르는 가격 — 알람 `billing.unknown_price`. */
  | 'unknown_price'
  /** 운영자·백필 행을 결제가 칸별로 지배하지 못한다 — 알람 `billing.entitlement_held`. */
  | 'operator_row_held'
  /** 운영자·백필 행 위의 해지·만료(free) — 공급자 강등은 provider 행에만. 알람 없음. */
  | 'operator_row_kept'
  /** reconcile 은 운영자·백필 행(넘긴 행 포함)을 덮지 않는다. 알람 없음. */
  | 'reconcile_operator_row';

export type EntitlementDecision =
  | { readonly kind: 'write'; readonly desired: PlanCode; readonly write: EntitlementWrite }
  | { readonly kind: 'noop'; readonly desired: PlanCode | null; readonly reason: NoopReason };

interface Candidate {
  readonly plan: PaidPlanCode;
  readonly graceUntil: Date | null;
}

function graceUntilOf(pastDueSince: Date): Date {
  return new Date(pastDueSince.getTime() + PROVIDER_GRACE_DAYS * DAY_MS);
}

/** 후보 둘 중 나은 것 — 순위 높은 쪽 · 같으면 유예 없는 쪽 · 둘 다 유예면 늦게 끝나는 쪽(입력 순서와 무관). */
function better(a: Candidate, b: Candidate): Candidate {
  if (PLAN_RANK[a.plan] !== PLAN_RANK[b.plan]) return PLAN_RANK[a.plan] > PLAN_RANK[b.plan] ? a : b;
  if (a.graceUntil === null) return a;
  if (b.graceUntil === null) return b;
  return a.graceUntil.getTime() >= b.graceUntil.getTime() ? a : b;
}

/** 원하는 요금제·유예와 "유예 만료로만 free 가 됐는가". */
function desiredOf(subscriptions: readonly DecisionSubscription[], now: Date): { candidate: Candidate | null; graceExpiredOnly: boolean } {
  let best: Candidate | null = null;
  let graceExpired = false;
  let otherwiseInactive = false;
  for (const subscription of subscriptions) {
    if (subscription.planCode === null) continue;
    if (subscription.status === 'paused' || subscription.status === 'canceled') otherwiseInactive = true;
    if (subscription.status === 'active' || subscription.status === 'trialing') {
      const candidate: Candidate = { plan: subscription.planCode, graceUntil: null };
      best = best === null ? candidate : better(best, candidate);
    } else if (subscription.status === 'past_due') {
      // `past_due_since` 가 비어 있으면 유예를 셀 기준이 없다 — 유예 없이 끝난 것으로 본다(올리지 않는 쪽).
      const graceUntil = subscription.pastDueSince === null ? null : graceUntilOf(subscription.pastDueSince);
      if (graceUntil !== null && graceUntil.getTime() > now.getTime()) {
        const candidate: Candidate = { plan: subscription.planCode, graceUntil };
        best = best === null ? candidate : better(best, candidate);
      } else {
        graceExpired = true;
      }
    }
  }
  return { candidate: best, graceExpiredOnly: best === null && graceExpired && !otherwiseInactive };
}

function numeric(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * 쓸 값이 지금 행과 같은가 — 요금제 · 한도 열한 칸(행에 적힌 값) · 유예 · **출처(provider)와 넘김 표시(false)**. 저장소
 * (`writeEntitlementVersion`)와 같은 판정이다(코드 검토 M-1): 운영자 행(넘긴 행 포함)이 원하는 값과 같아도 쓴다 — 출처를 provider 로,
 * 제어 칸을 false 로 바꿔야 이양이 끝나고 뒤의 해지·만료 강등이 그 행에 닿는다.
 */
function sameAsRow(row: DecisionRow, write: EntitlementWrite): boolean {
  if (row.source !== 'provider' || row.provider_override_allowed) return false;
  if (row.plan_code !== write.planCode) return false;
  const rowGrace = row.grace_until === null ? null : row.grace_until.getTime();
  const writeGrace = write.graceUntil === null ? null : write.graceUntil.getTime();
  if (rowGrace !== writeGrace) return false;
  const values = row as unknown as Record<string, number | string>;
  return LIMIT_COLUMNS.every(([key, column]) => numeric(values[column] ?? Number.NaN) === write.limits[key]);
}

function causeOf(trigger: DecisionTrigger, desired: PlanCode, graceExpiredOnly: boolean): EntitlementCause {
  if (desired === 'free' && graceExpiredOnly) return 'grace_expired';
  return trigger === 'event' ? 'provider_event' : 'reconcile';
}

export function decideProviderEntitlement(input: DecisionInput): EntitlementDecision {
  const { subscriptions, row, now, trigger } = input;
  // 2. 모르는 가격 — 살아 있는 구독에 하나라도 있으면 아무것도 바꾸지 않는다.
  if (subscriptions.some((subscription) => subscription.status !== 'canceled' && subscription.planCode === null)) {
    return { kind: 'noop', desired: null, reason: 'unknown_price' };
  }
  // 1·3. 원하는 요금제.
  const { candidate, graceExpiredOnly } = desiredOf(subscriptions, now);
  const desired: PlanCode = candidate === null ? 'free' : candidate.plan;
  const write: EntitlementWrite = {
    planCode: desired,
    limits: PLAN_CATALOG[desired],
    graceUntil: candidate === null ? null : candidate.graceUntil,
    cause: causeOf(trigger, desired, graceExpiredOnly),
  };

  // 4. 지금 행 출처에 따른 쓰기 규칙(D-3).
  if (row === null) {
    return desired === 'free' ? { kind: 'noop', desired, reason: 'unchanged' } : { kind: 'write', desired, write };
  }
  if (row.source !== 'provider') {
    // default · operator — 운영자 결정(보상 요금제·백필·베타)을 보존한다. 모르는 출처 값도 이쪽(덮지 않는 쪽)이다.
    if (trigger === 'reconcile') {
      const held = desired !== 'free' && !row.provider_override_allowed && !dominatesLimits(write.limits, resolveEntitlements(row, now));
      return { kind: 'noop', desired, reason: held ? 'operator_row_held' : 'reconcile_operator_row' };
    }
    if (!row.provider_override_allowed) {
      if (desired === 'free') return { kind: 'noop', desired, reason: 'operator_row_kept' };
      // 칸별 지배 — 지금 **적용 중인** 한도(유예가 끝난 행이면 Free)와 비교한다.
      if (!dominatesLimits(write.limits, resolveEntitlements(row, now))) return { kind: 'noop', desired, reason: 'operator_row_held' };
    }
  }
  // 5. 같으면 쓰지 않는다(버전을 올리지 않는다).
  if (isPlanCode(row.plan_code) && sameAsRow(row, write)) return { kind: 'noop', desired, reason: 'unchanged' };
  return { kind: 'write', desired, write };
}
