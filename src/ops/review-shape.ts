/**
 * src/ops/review-shape.ts — 검토 전이 결과의 **모양 하나**(`.omc/plans/ops-console.md` §3.2 M2). 의존성 0(타입만).
 *
 * SQL 코어(`ops_org_activate_core` · `ops_org_reject_core`)와 호스팅 definer(`ops_org_activate` · `ops_org_reject`)는 같은 TABLE 을 돌려준다.
 * CLI 래퍼(`src/ops/core/review.ts`)와 호스팅 백엔드(`src/ops/hosted/backend.ts`)가 이 매핑 하나를 쓴다. 호스팅 폐포에 `core/plan*` 이 들어가지
 * 않도록 `ActivationGrant` 도 여기 둔다(`core/plan.ts` 는 이것을 다시 내보낸다).
 */

import type { OrganizationReviewStatus } from '../db/schema';

export type ActivationGrant =
  | { readonly granted: true; readonly fromPlan: string | null; readonly version: number }
  | { readonly granted: false; readonly reason: 'disabled' | 'kept'; readonly plan: string | null };

export interface ReviewOutcome {
  readonly from: OrganizationReviewStatus;
  readonly changed: boolean;
  /** 거절로 운영자 정지한 에이전트 id(정렬). 활성화면 빈 배열. */
  readonly suspended: readonly string[];
  readonly revokedTokens: number;
  /** 활성화 때 베타 자동 부여 결과. 거절·변경 없음이면 `null`. */
  readonly plan: ActivationGrant | null;
}

/** 활성화 TABLE 한 행. `grant ∈ {granted, disabled, kept, none}`. */
export interface ActivateCoreRow {
  readonly from_status: OrganizationReviewStatus;
  readonly changed: boolean;
  readonly grant: 'granted' | 'disabled' | 'kept' | 'none';
  readonly from_plan: string | null;
  readonly kept_plan: string | null;
  readonly version: number | null;
}

/** 거절 TABLE 한 행. */
export interface RejectCoreRow {
  readonly from_status: OrganizationReviewStatus;
  readonly changed: boolean;
  readonly suspended: string[] | null;
  readonly revoked_tokens: number | null;
}

/** M2 — `grant` → `ActivationGrant`. `none` = 변경 없음(이미 active). */
export function activationGrantOf(row: Pick<ActivateCoreRow, 'grant' | 'from_plan' | 'kept_plan' | 'version'>): ActivationGrant | null {
  if (row.grant === 'granted') return { granted: true, fromPlan: row.from_plan, version: Number(row.version) };
  if (row.grant === 'disabled') return { granted: false, reason: 'disabled', plan: null };
  if (row.grant === 'kept') return { granted: false, reason: 'kept', plan: row.kept_plan };
  return null;
}

export function activateOutcomeOf(row: ActivateCoreRow): ReviewOutcome {
  return { from: row.from_status, changed: row.changed, suspended: [], revokedTokens: 0, plan: activationGrantOf(row) };
}

export function rejectOutcomeOf(row: RejectCoreRow): ReviewOutcome {
  return { from: row.from_status, changed: row.changed, suspended: [...(row.suspended ?? [])].sort(), revokedTokens: Number(row.revoked_tokens ?? 0), plan: null };
}
