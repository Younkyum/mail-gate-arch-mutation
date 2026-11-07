/**
 * src/domains/reputation.ts — 고객 도메인 **평판 동결**(ADR-0014 결정 14 · J6 · 계획 §3.8). 판정은 순수 함수, 집계 질의는 틱 롤로 한 번.
 *
 * 창 둘(7일 · 24시간 — `REPUTATION_THRESHOLDS.windowsMs`)마다 같은 식:
 *   - complaint율 ≥ 0.08% **그리고** complaint ≥ 3건 → 동결.
 *   - bounce율의 **윌슨 95% 하한** ≥ 3% → 동결(표본이 작으면 하한이 낮아 우연한 bounce 몇 건으로 얼지 않는다).
 *   - 경고(알람만): complaint ≥ 0.05% 그리고 ≥ 2건 · 윌슨 하한 ≥ 2%.
 * 그리고 **계정 기여분**(7일): 도메인 bounce ÷ 계정 전체 전달 시도 ≥ 1.0%p, complaint ÷ 같은 분모 ≥ 0.02%p → 비율과 무관하게 동결(한 도메인이 계정
 * 지표를 끌어올리는 것 자체를 막는다 — 계정 검토선 5% · 0.1% 의 20%).
 *
 * 분자 bounce 는 **영구(Permanent)만**(`bounce_type`, 202610021104 — 일시·판정 불가·칸 이전 NULL 은 세지 않는다), 계정 기여분은 7일 최소 건수(complaint 3 ·
 * bounce 10) 아래면 동결하지 않는다(진윤겸 결정 2026-10 · #13 M3). 분모 = **전달 시도**(`ses_events` 의 delivery + bounce — 종류 무관). 이벤트는 `messages.from_domain` 과 그 메시지 에이전트의 조직으로 도메인 행에 묶는다(같은
 * 도메인을 예전에 쓴 다른 조직의 메일은 세지 않는다). 창은 우리가 이벤트를 받은 시각(`received_at` — 색인)이다.
 * 동결 = `suspended(reputation)` — **운영자만 푼다**(DB 전이 가드 · 결정 12). 해제 경로는 `pnpm admin:domain --unfreeze`.
 */

import { REPUTATION_THRESHOLDS } from './contract';

export interface ReputationCounts {
  /** 전달 시도(delivery + bounce 이벤트 — bounce 종류 무관). */
  readonly attempts: number;
  /** 영구(Permanent) bounce 만. */
  readonly bounces: number;
  readonly complaints: number;
}

export type ReputationAction = 'ok' | 'warn' | 'freeze';

export interface ReputationVerdict {
  readonly action: ReputationAction;
  /** 무엇이 걸렸는가(로그용 코드 — 도메인 이름 없음). */
  readonly reasons: readonly string[];
}

/** 이항 비율의 윌슨 점수 하한(z = 1.96 — 95%). 시도 0 이면 0. */
export function wilsonLowerBound(successes: number, trials: number, z: number = REPUTATION_THRESHOLDS.wilsonZ): number {
  if (trials <= 0) return 0;
  const p = successes / trials;
  const z2 = z * z;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return Math.max(0, (centre - margin) / (1 + z2 / trials));
}

/** 창 하나의 판정. */
export function judgeWindow(counts: ReputationCounts): ReputationVerdict {
  const t = REPUTATION_THRESHOLDS;
  const reasons: string[] = [];
  const complaintRate = counts.attempts > 0 ? counts.complaints / counts.attempts : 0;
  const bounceLower = wilsonLowerBound(counts.bounces, counts.attempts);
  if (complaintRate >= t.freezeComplaintRate && counts.complaints >= t.freezeComplaintMinCount) reasons.push('complaint_rate');
  if (bounceLower >= t.freezeBounceWilsonLower) reasons.push('bounce_wilson');
  if (reasons.length > 0) return { action: 'freeze', reasons };
  if (complaintRate >= t.warnComplaintRate && counts.complaints >= t.warnComplaintMinCount) reasons.push('complaint_rate_warn');
  if (bounceLower >= t.warnBounceWilsonLower) reasons.push('bounce_wilson_warn');
  return { action: reasons.length > 0 ? 'warn' : 'ok', reasons };
}

/** 계정 기여분(7일) — 계정 전체 전달 시도가 분모. 걸리면 동결 사유. */
export function accountContributionReasons(domain7d: ReputationCounts, accountAttempts7d: number): string[] {
  if (accountAttempts7d <= 0) return [];
  const t = REPUTATION_THRESHOLDS;
  const reasons: string[] = [];
  // 최소 건수(#13 M3) — 그보다 적으면 그 지표로는 동결하지 않는다.
  if (domain7d.bounces >= t.freezeAccountBounceMinCount && domain7d.bounces / accountAttempts7d >= t.freezeAccountBounceContribution) {
    reasons.push('account_bounce_contribution');
  }
  if (domain7d.complaints >= t.freezeAccountComplaintMinCount && domain7d.complaints / accountAttempts7d >= t.freezeAccountComplaintContribution) {
    reasons.push('account_complaint_contribution');
  }
  return reasons;
}

/** 도메인 하나의 최종 판정 — 두 창 + 계정 기여분. 가장 센 것을 고른다. */
export function judgeReputation(input: { readonly week: ReputationCounts; readonly day: ReputationCounts; readonly accountAttemptsWeek: number }): ReputationVerdict {
  const week = judgeWindow(input.week);
  const day = judgeWindow(input.day);
  const contribution = accountContributionReasons(input.week, input.accountAttemptsWeek);
  const freeze = [
    ...(week.action === 'freeze' ? week.reasons.map((reason) => `7d:${reason}`) : []),
    ...(day.action === 'freeze' ? day.reasons.map((reason) => `24h:${reason}`) : []),
    ...contribution.map((reason) => `7d:${reason}`),
  ];
  if (freeze.length > 0) return { action: 'freeze', reasons: freeze };
  const warn = [
    ...(week.action === 'warn' ? week.reasons.map((reason) => `7d:${reason}`) : []),
    ...(day.action === 'warn' ? day.reasons.map((reason) => `24h:${reason}`) : []),
  ];
  return { action: warn.length > 0 ? 'warn' : 'ok', reasons: warn };
}

// ---------------------------------------------------------------------------
// 집계(틱 롤 — ses_events · messages 의 칸 SELECT, 202610021103)
// ---------------------------------------------------------------------------

export interface ReputationDb {
  query<R extends object = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ readonly rows: R[] }>;
}

export interface DomainReputationInput {
  readonly domainId: string;
  readonly week: ReputationCounts;
  readonly day: ReputationCounts;
}

/**
 * 판정 대상(verified · 그리고 아직 reputation·operator 가 아닌 suspended) 도메인 행마다 두 창의 수 + 계정 전체 7일 전달 시도. 질의 둘.
 * 이벤트가 없는 도메인은 0 으로 돌려준다(판정 ok).
 */
export async function loadReputationInputs(
  db: ReputationDb,
  now: Date,
  organizationIds: readonly string[] | null = null,
): Promise<{ readonly domains: readonly DomainReputationInput[]; readonly accountAttemptsWeek: number }> {
  const [weekMs, dayMs] = REPUTATION_THRESHOLDS.windowsMs;
  const weekStart = new Date(now.getTime() - weekMs);
  const dayStart = new Date(now.getTime() - dayMs);
  const rows = await db.query<{
    id: string;
    week_attempts: number;
    week_bounces: number;
    week_complaints: number;
    day_attempts: number;
    day_bounces: number;
    day_complaints: number;
  }>(
    `SELECT d.id::text AS id,
            count(*) FILTER (WHERE e.event_type IN ('delivery', 'bounce'))::int AS week_attempts,
            count(*) FILTER (WHERE e.event_type = 'bounce' AND e.bounce_type = $4)::int AS week_bounces,
            count(*) FILTER (WHERE e.event_type = 'complaint')::int AS week_complaints,
            count(*) FILTER (WHERE e.event_type IN ('delivery', 'bounce') AND e.received_at >= $2)::int AS day_attempts,
            count(*) FILTER (WHERE e.event_type = 'bounce' AND e.bounce_type = $4 AND e.received_at >= $2)::int AS day_bounces,
            count(*) FILTER (WHERE e.event_type = 'complaint' AND e.received_at >= $2)::int AS day_complaints
       FROM custom_domains d
       LEFT JOIN (ses_events e
                  JOIN messages m ON m.id = e.message_id
                  JOIN agents a ON a.id = m.agent_id)
              ON m.from_domain = d.domain AND a.organization_id = d.organization_id AND e.received_at >= $1
      WHERE (d.status = 'verified' OR (d.status = 'suspended' AND d.suspended_reason NOT IN ('reputation', 'operator')))
        AND ($3::uuid[] IS NULL OR d.organization_id = ANY ($3::uuid[]))
      GROUP BY d.id
      ORDER BY d.id`,
    [weekStart, dayStart, organizationIds === null ? null : [...organizationIds], REPUTATION_THRESHOLDS.countedBounceType],
  );
  const account = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ses_events WHERE received_at >= $1 AND event_type IN ('delivery', 'bounce')`,
    [weekStart],
  );
  return {
    domains: rows.rows.map((row) => ({
      domainId: row.id,
      week: { attempts: row.week_attempts, bounces: row.week_bounces, complaints: row.week_complaints },
      day: { attempts: row.day_attempts, bounces: row.day_bounces, complaints: row.day_complaints },
    })),
    accountAttemptsWeek: account.rows[0]?.n ?? 0,
  };
}
