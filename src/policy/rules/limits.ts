/**
 * Stage 4 — rate & volume(계획 §4.2, §3.3, R22). 분·시·일 한도, 메시지당 수신자 수, 조직 워밍업 일일 캡.
 * 승인(Stage 7)보다 앞이고(§4.2 원칙 1), 억제·차단(영구 사실) 뒤다 — 한도는 시간이 지나면 풀리는 사실이라 `retry_after` 를 준다.
 *
 * **R22:** SES 계정 한도가 50,000통/일로 풀린 뒤 발송 경로와 평판 사이의 제동장치는 이 파일뿐이다. 그래서 워밍업 표는
 * **코드 상수**다 — 바꾸려면 커밋과 리뷰가 든다. `agent_policies.limits` 에 `warmup_daily_cap` 을 두지 않는 것도 같은 이유
 * (jsonb 한 줄 UPDATE 로 꺼지고 감사에 남지 않는다, §3.3 "앱에서 끌 수 없다").
 */

import { denyIfAny, type DecisionReason, type EvaluationContext, type HardStageRule } from '../types';
import { MAX_RECIPIENTS_PER_MESSAGE } from './content';

// ---------------------------------------------------------------------------
// 워밍업 캡 — 계획 §3.3 "볼륨 워밍업" 표
// ---------------------------------------------------------------------------

/** 워밍업 램프의 한 구간 — `throughDay` 까지(포함) 조직 일일 상한 `cap` **수신자**. */
export interface WarmupStep {
  readonly throughDay: number;
  readonly cap: number;
}

/** 계획 §3.3 표(Day 16+ 는 `WARMUP_STEADY_STATE_DAILY_CAP`). 행을 바꾸는 것은 평판 리스크를 바꾸는 것이다. */
export const WARMUP_DAILY_CAPS: readonly WarmupStep[] = [
  { throughDay: 3, cap: 20 },
  { throughDay: 6, cap: 50 },
  { throughDay: 9, cap: 100 },
  { throughDay: 12, cap: 200 },
  { throughDay: 15, cap: 400 },
];

/** Day 16 이후 — Phase 1 의 절대 상한(SES 계정 한도와 무관). */
export const WARMUP_STEADY_STATE_DAILY_CAP = 1000;

/**
 * `sending_started_at` 이 `null`(아직 보낸 적 없음)일 때의 캡 — 첫 구간이다. 기준일이 없다고 캡을 없애면
 * 기준일 기록이 실패한 순간 캡 전체가 사라진다(fail open).
 */
export const WARMUP_DAY_ZERO_CAP = 20;

const MS_PER_DAY = 86_400_000;

/** UTC 자정으로 내린 epoch ms. 로컬 타임존에 따라 캡이 바뀌면 안 된다. */
function utcMidnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** 워밍업 일차 — `sendingStartedAt` 당일이 Day 1. `null` 이면 `null`(캡 조회가 첫 구간을 쓴다). */
export function warmupDayIndex(now: Date, sendingStartedAt: Date | null): number | null {
  if (sendingStartedAt === null) return null;
  const elapsedDays = Math.floor((utcMidnight(now) - utcMidnight(sendingStartedAt)) / MS_PER_DAY);
  // 시계 역행(기준일이 미래)은 Day 1 — 음수 일차가 상한을 올리지 않게.
  return elapsedDays < 0 ? 1 : elapsedDays + 1;
}

/** 해당 시점에 적용되는 조직 전체 일일 캡. */
export function warmupDailyCap(now: Date, sendingStartedAt: Date | null): number {
  const day = warmupDayIndex(now, sendingStartedAt);
  if (day === null) return WARMUP_DAY_ZERO_CAP;

  for (const step of WARMUP_DAILY_CAPS) {
    if (day <= step.throughDay) return step.cap;
  }
  return WARMUP_STEADY_STATE_DAILY_CAP;
}

// ---------------------------------------------------------------------------
// retry_after
// ---------------------------------------------------------------------------

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

/** 다음 UTC 자정까지 남은 초. 일일 계열 거부의 `retry_after`. */
function secondsUntilNextUtcMidnight(now: Date): number {
  const next = utcMidnight(now) + MS_PER_DAY;
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** 여러 축에 걸리면 `retry_after` 는 **가장 긴 것** — 짧은 쪽이면 재시도가 다시 거부되는 루프가 된다. */
function longest(values: readonly number[]): number | null {
  let max: number | null = null;
  for (const value of values) {
    if (max === null || value > max) max = value;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Stage 4
// ---------------------------------------------------------------------------

/**
 * 오늘 조직 하루 수신자 상한과 그것을 **묶는 쪽** — `min(워밍업 캡, 요금제 한도)`(ADR-0011). 요금제 한도가 **더 작을 때만**
 * `plan_daily_cap`(같거나 크면 워밍업이 묶고, 업그레이드로 풀리지 않는다). 콘솔·운영자 CLI 표시용 — 판정은 `evaluateLimits`(같은 min).
 */
export function organizationDailyCap(
  now: Date,
  sendingStartedAt: Date | null,
  planDailyRecipients: number,
): { readonly cap: number; readonly reason: 'warmup_daily_cap' | 'plan_daily_cap' } {
  const warmup = warmupDailyCap(now, sendingStartedAt);
  return planDailyRecipients < warmup ? { cap: planDailyRecipients, reason: 'plan_daily_cap' } : { cap: warmup, reason: 'warmup_daily_cap' };
}

export const evaluateLimits: HardStageRule = (ctx, policy) => {
  const reasons: DecisionReason[] = [];
  const retryCandidates: number[] = [];
  // 요금제는 조이기만 한다(ADR-0011) — 각 축 = min(정책, 엔타이틀먼트). 행이 없으면 Free.
  const entitlements = ctx.organization.entitlements;
  const perMinute = Math.min(policy.limits.perMinute, entitlements.agentPerMinuteMax);
  const perDay = Math.min(policy.limits.perDay, entitlements.agentPerDayMax);
  const recipientsPerMessage = Math.min(policy.limits.recipientsPerMessage, entitlements.recipientsPerMessageMax);

  // 카운터는 이번 시도를 포함하지 않는다(로더 규약) — 그래서 `>=`(`>` 면 N+1 통째가 나간다).
  if (ctx.counters.agentLastMinute >= perMinute) {
    reasons.push('rate_limit_per_minute');
    retryCandidates.push(SECONDS_PER_MINUTE);
  }
  if (ctx.counters.agentLastHour >= policy.limits.perHour) {
    reasons.push('rate_limit_per_hour');
    retryCandidates.push(SECONDS_PER_HOUR);
  }
  if (ctx.counters.agentLastDay >= perDay) {
    reasons.push('rate_limit_per_day');
    retryCandidates.push(secondsUntilNextUtcMidnight(ctx.now));
  }

  // 메시지당 수신자 수. 사유는 무엇이 묶었는가로 나눈다: 소유자 정책이나 절대 천장(Stage 6 의 50)도 넘었으면 봉투의 성질
  // (`recipients_per_message` — 영구), 요금제만 넘었으면 `plan_recipients_per_message`(일시적 — 강등 뒤 승인된 봉투를 죽이지 않는다, ADR-0011 §9).
  const recipientCount = ctx.attempt.recipients.length;
  if (recipientCount > recipientsPerMessage) {
    const permanent = recipientCount > policy.limits.recipientsPerMessage || recipientCount > MAX_RECIPIENTS_PER_MESSAGE;
    reasons.push(permanent ? 'recipients_per_message' : 'plan_recipients_per_message');
  }

  // 조직 하루 상한 — 조직 전체·수신자 단위라 에이전트 한도와 따로 걸린다(에이전트 10개로 나눠 보내도 조직 평판은 10배로 탄다).
  // 사유 우선순위: 조직 워밍업 > 도메인 워밍업(ADR-0014 결정 7 — 고객 도메인 발신만, 추가 제동이라 상한을 넓히지 못한다) > 요금제
  // (`plan_daily_cap` 은 업그레이드로 풀리는 경우에만 — 콘솔이 업그레이드를 안내한다).
  if (isWarmupCapExceeded(ctx)) {
    reasons.push('warmup_daily_cap');
    retryCandidates.push(secondsUntilNextUtcMidnight(ctx.now));
  } else if (isDomainWarmupCapExceeded(ctx)) {
    reasons.push('domain_warmup_daily_cap');
    retryCandidates.push(secondsUntilNextUtcMidnight(ctx.now));
  } else if (ctx.counters.orgRecipientsLastDay + ctx.attempt.recipients.length > entitlements.orgDailyRecipients) {
    reasons.push('plan_daily_cap');
    retryCandidates.push(secondsUntilNextUtcMidnight(ctx.now));
  }

  return denyIfAny(reasons, longest(retryCandidates));
};

/**
 * 이번 시도가 조직 워밍업 캡을 넘기는가(데모·테스트도 부른다).
 *
 * **눈금은 수신자 수다** — 메시지 수로 읽으면 `MAX_RECIPIENTS_PER_MESSAGE`(50)와 곱해져 캡이 최대 50배 느슨해진다(SES 평판은
 * 수신자 단위). 그래서 이번 시도의 수신자를 **더해서** 비교한다.
 */
export function isWarmupCapExceeded(ctx: EvaluationContext): boolean {
  const cap = warmupDailyCap(ctx.now, ctx.organization.sendingStartedAt);
  return ctx.counters.orgRecipientsLastDay + ctx.attempt.recipients.length > cap;
}

/**
 * 이번 시도가 발신 **고객 도메인**의 워밍업 캡을 넘기는가(ADR-0014). 눈금·경계는 `isWarmupCapExceeded` 와 같고, Day 1 은 그 도메인의
 * 첫 발송 성공일이다(verified 시각이 아니다). `sendingDomain = null`(`atmark.ai` 발신 등)이면 거짓.
 */
export function isDomainWarmupCapExceeded(ctx: EvaluationContext): boolean {
  if (ctx.sendingDomain === null) return false;
  const cap = warmupDailyCap(ctx.now, ctx.sendingDomain.sendingStartedAt);
  return ctx.counters.domainRecipientsLastDay + ctx.attempt.recipients.length > cap;
}
