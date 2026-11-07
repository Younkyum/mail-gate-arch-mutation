/**
 * src/domains/lifecycle.ts — 고객 도메인 **수명주기 · 확인 틱**(ADR-0014 결정 2 · 4 · 12 · 14 · 계획 §3.3 · §3.4 · 단계 4).
 *
 * 틱 하나(`runDomainTick`, admin λ 의 `{task:'domain-recheck'}` — 10분)는:
 *   ① **시간 전이**(SES 호출 0): pending 72시간 → removed · verifying 72시간 → removed(제거 사가) · ownership_lost 14일 → removed · D-3 예고 ·
 *      **비활성 조직**(운영자 거절)의 살아 있는 행 → removed(알림 없음 · M3b).
 *   ② **요금제 강등·복귀**(SES 호출 0): 한도를 넘는 verified 를 가장 최근 것부터 `suspended(plan_limit)`, 한도 안이면 plan_limit 을 verified 로.
 *   ③ **확인 배치**: 기한이 된 행마다 요청을 만들고(`planRow` — 순수) pending 예산 P(요청 8) · 재확인 예산 R(요청 10)을 따로 채워 **domain-control
 *      호출 하나**로 보낸다. domain-control 이 없거나 결과가 계약 모양이 아니면(`DomainControlUnavailableError`) **아무것도 바꾸지 않고** 끝난다.
 *   ④ 결과를 행마다 **자기 트랜잭션**에서 적용한다(`decide` — 순수 · 행 잠금 아래 `updated_at` 이 계획 때와 같을 때만 — 그 사이 누가 바꿨으면 버린다).
 *   ⑤ **양도**(시간이 남으면 한 건): 같은 도메인 진입 잠금 안에서 옛 행 토큰의 부재를 다시 확인하고 옛 행 → removed(`superseded_by`) · 새 행 → verifying.
 *   ⑥ **평판**(`reputation.ts`): 동결이면 `suspended(reputation)` + 알림 · 경고는 지표만.
 *   ⑦ 밀린 수 · 고아 후보 · 활성 관리자 수 지표(0 이어도).
 *
 * 규율:
 *   - **`error` 는 상태를 바꾸지 않는다**(원칙 3): DNS·SES 인프라 오류는 확정 실패 카운터를 올리지 않는다 — 다음 확인 시각만 민다.
 *   - **확정 실패 2회 연속 → 정지**(TXT absent → ownership_lost · DKIM FAILED → dkim_failed). 성공하면 그 둘은 verified 로 자동 복귀한다.
 *     **reputation · operator 는 자동 복귀하지 않는다**(DB 전이 가드가 틱을 막는다 — 여기서도 시도하지 않는다).
 *   - **removed · superseded 행에는 sync_policy · audit_policy 를 보내지 않는다**(#12 보안 리뷰 — 옛 행의 동기화가 채택 직후 옛 조직 주소로 정책을
 *     다시 만드는 경합). 정책 요청은 verified · suspended 행에만 만들고, 적용 때 행이 그 사이 바뀌었으면 버린다. 대체된 행의 제거 사가는 SES 호출 0
 *     (identity 는 새 행의 것이다).
 *   - **`supersededRowId` 는 DB 불변식을 다시 본 조회(`adoptableRowFor` — 넘겨주기 사슬 · 옛 양도)로만 채운다**(domain-control 은 그 값을 믿고 채택한다).
 *   - 로그 · 지표에 도메인 이름이 없다(도메인 id 만).
 *
 * **한 번에 설정(2026-10 one-shot · `docs/internal/plans/custom-domains-oneshot.md`)** — 상태 값은 그대로이고 **identity 관리자(steward)** 축이 더해졌다:
 *   - ③ 앞의 **클레임**(DB 먼저 · SES 나중): 기한이 된 pending 행이 관리자가 아니고 그 도메인에 활성 관리자가 없으며 다른 조직이 같은 apex 를 쥐고 있지
 *     않으면 도메인 진입 잠금 아래 `identity_claimed_at` 을 쓴다(색인 23505 = 진 쪽). 다른 조직이 apex 를 쥐면 `registrable_taken` 을 TXT 전에도 적는다.
 *   - pending 관리자는 사가를 `config_set` 까지 돈다(`policy` = 발신 권한은 verifying 에서만) · 관리자가 아닌 pending 은 `peek_identity` 로 토큰만.
 *   - **증명이 선점을 이긴다**: 관리자가 아닌 행이 TXT 를 증명하면 같은 트랜잭션에서 pending(또는 정책을 지운 removed) 관리자를 놓게 하고(`identity_handover_to`)
 *     verifying 으로 들어선다(DB 가 자동 클레임). 다음 틱 사가가 직전 관리자의 identity 를 **채택**한다 — 토큰이 바뀌지 않는다.
 *   - 제거 사가는 identity 단계 전에 **넘겨주기**를 먼저 본다(같은 도메인의 클레임한 적 없는 살아 있는 행 — SES 호출 0). 관리권을 놓은 행은 SES 를
 *     건드리지 않는다.
 *   - `provisionDomainNow` — 도메인 추가 직후 그 행 하나에 클레임 + `saga_step(identity)`(또는 `peek_identity`)를 곧바로 돈다.
 */

import {
  CUSTOM_DOMAIN_SUSPENSION_STRENGTH,
  DEFINITIVE_FAILURE_RETRY_MS,
  DOMAIN_LOG_EVENTS,
  DOMAIN_TICK_BUDGET_MS,
  DOMAIN_TICK_INTERVAL_MS,
  DOMAIN_TICK_PENDING_BUDGET,
  DOMAIN_TICK_RECHECK_BUDGET,
  DomainControlUnavailableError,
  EXPIRY_CHECK_INTERVAL_MS,
  EXPIRY_WARNING_DAYS,
  OWNERSHIP_LOST_REMOVAL_MS,
  PENDING_CHECK_INTERVAL_MS,
  PENDING_EXPIRY_MS,
  RDAP_EXPIRY_GRACE_MS,
  RECHECK_INTERVAL_MS,
  REMOVAL_NOTICE_DAYS_BEFORE,
  SUSPEND_AFTER_DEFINITIVE_FAILURES,
  DOMAIN_CONTROL_INVOKE_TIMEOUT_MS,
  PENDING_SAGA_LAST_STEP,
  PROVISION_NOW_BUDGET_MS,
  identityStewardshipOf,
  type CustomDomainSagaStep,
  type CustomDomainSesStatus,
  type CustomDomainSuspendedReason,
  type DomainControlInvoker,
  type DomainControlRequest,
  type DomainControlResult,
  type InboundMxStatus,
  type ProvisionDomainOutcome,
} from './contract';
import { DOMAIN_METRIC_NAMES, emitDomainMetric, type DomainMetricName } from './metrics';
import { judgeReputation, loadReputationInputs } from './reputation';
import {
  activeStewardFor,
  adoptableRowFor,
  claimIdentity,
  dueBacklog,
  handoverTargetFor,
  identitiesHeld,
  inTickTransaction,
  insertNotice,
  liveAddressesFor,
  lockDomainEntry,
  orphanCandidates,
  planLimitInputs,
  registrableHeldElsewhere,
  selectClaimCandidates,
  selectDueRows,
  selectExpiringRows,
  selectInactiveOrganizationRows,
  selectRow,
  successorState,
  transferSourceFor,
  updateRow,
  type DomainDb,
  type DomainPool,
  type DomainRow,
  type NoticeSpec,
  type SuccessorState,
  type TickPatch,
  type TickScope,
} from './store';
import { customDomainLimitOf, resolveEntitlements, type EntitlementRowInput } from '../billing/plans';
import { log } from '../observability/logger';

const ROUTE_ID = 'domain-recheck';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// 순수 — 요청 계획
// ---------------------------------------------------------------------------

/** 생성 사가의 다음 단계(`saga_step` = 마지막으로 마친 단계). `done` 이면 없음. */
export function nextSagaStep(step: CustomDomainSagaStep): Exclude<CustomDomainSagaStep, 'none' | 'done'> | null {
  switch (step) {
    case 'none':
      return 'identity';
    case 'identity':
      return 'mail_from';
    case 'mail_from':
      return 'config_set';
    case 'config_set':
      return 'policy';
    case 'policy':
    case 'done':
      return null;
  }
}

/** pending 관리자의 다음 사가 단계 — `config_set` 에서 멈춘다(`policy` = 발신 권한은 소유 증명 뒤 verifying 에서만). */
export function pendingSagaStep(step: CustomDomainSagaStep): Exclude<CustomDomainSagaStep, 'none' | 'done' | 'policy'> | null {
  if (step === PENDING_SAGA_LAST_STEP) return null;
  const next = nextSagaStep(step);
  return next === null || next === 'policy' ? null : next;
}

/** 행 하나를 위해 미리 읽은 것 — 정책 주소(verified 만) · 양도 채택 대상(검증된 조회의 결과) · 대체된 행의 정산(`supersededRemovalAction`). */
export interface RowContext {
  readonly now: Date;
  readonly addresses: readonly string[];
  /** 채택해도 되는 직전 관리자 행(`adoptableRowFor` — 넘겨주기 사슬 · 옛 양도). 없으면 null. */
  readonly supersededRowId: string | null;
  /** 대체된 removed 행만 — 후속 행이 채택 전에 사라졌으면 `'remove'`(제거 사가를 정상으로 돈다). 생략 = 대체 행이 아니다. */
  readonly supersededAction?: SupersededRemovalAction;
}

/** 이 행이 지금 그 도메인의 **활성 identity 관리자**인가(계약 `identityStewardshipOf`). */
export function isSteward(row: Pick<DomainRow, 'identityClaimedAt' | 'identityReleasedAt' | 'identityDeletedAt'>): boolean {
  return identityStewardshipOf(row) === 'steward';
}

/**
 * 제거 사가를 SES 호출 0 으로 끝내도 되는 행:
 *   - 관리권을 **놓은** 행(넘겨줬거나 포기했다 — identity 는 이제 다른 행의 것이다).
 *   - 클레임한 적 **없는** 행(one-shot — 사가는 클레임이 먼저라 identity 를 만들지 않았다. pending 만료 · 관리자가 아니던 pending).
 * 놓지 않은 옛 대체 행(관리자 축 이전의 양도)은 `supersededRemovalAction` 이 정한다.
 */
export function removalNeedsNoSes(row: Pick<DomainRow, 'supersededBy' | 'identityClaimedAt' | 'identityReleasedAt'>): boolean {
  if (row.identityReleasedAt !== null) return true;
  if (row.supersededBy !== null) return false;
  return row.identityClaimedAt === null;
}

/** 제거 사가에서 **넘겨주기**를 볼 때인가 — 관리자이고, 이 행의 정책이 없거나(사가가 정책 단계에 닿지 않았다) 이미 지웠다(removal_step = policy). */
export function removalHandoverDue(row: Pick<DomainRow, 'status' | 'removalStep' | 'sagaStep' | 'identityClaimedAt' | 'identityReleasedAt' | 'identityDeletedAt'>): boolean {
  if (row.status !== 'removed' || row.removalStep === 'done' || !isSteward(row)) return false;
  return row.removalStep === 'policy' || row.sagaStep !== 'done';
}

export type SupersededRemovalAction = 'settle' | 'remove' | 'wait';

/**
 * **대체된 옛 행의 제거 사가**(#13 보안 리뷰 M2 — 양도 채택 전에 후속 행이 사라지면 identity 가 옛 행 태그를 단 채 고아가 되고, 그 도메인은 다시
 * 등록할 수 없었다):
 *   - `settle` — 후속 행이 **채택을 끝냈다**(태그 = 후속 행 id · 또는 사가가 identity 단계를 지났다): identity 는 후속 행의 것 → SES 호출 0 으로 done.
 *   - `remove` — 후속 행이 채택 **전에** removed 가 됐다(또는 행이 없다): identity 태그는 아직 옛 행 id → 옛 행의 **정상 제거 사가**(policy → identity) —
 *     domain-control 의 소유 검사도 통과한다.
 *   - `wait` — 후속 행이 아직 pending · verifying 이고 채택 전이다: 기다린다(그 사가가 채택하면 settle, 사라지면 remove).
 */
export function supersededRemovalAction(successor: SuccessorState | null): SupersededRemovalAction {
  if (successor === null) return 'remove';
  if (successor.sesIdentityRowTag === successor.id || successor.sagaStep !== 'none') return 'settle';
  return successor.status === 'removed' ? 'remove' : 'wait';
}

/** 이 행이 정책 요청(sync · audit)을 받을 수 있는가 — **verified · suspended 이고 대체되지 않은 행만**(#12 보안 리뷰). */
export function policyOpsAllowed(row: Pick<DomainRow, 'status' | 'supersededBy'>): boolean {
  return (row.status === 'verified' || row.status === 'suspended') && row.supersededBy === null;
}

/**
 * 행 하나의 domain-control 요청들(순수). 빈 배열 = 이번 틱에 SES·DNS 일이 없다.
 *   - pending · 관리자 · 사가 < config_set: `saga_step`(다음 — identity 단계는 채택 대상과 함께) + `check`.
 *   - pending · 관리자 · 사가 = config_set: `check` + `peek_identity`(DKIM · MAIL FROM 상태 표시).
 *   - pending · 관리자 아님: `check` (+ 토큰이 아직 없으면 `peek_identity` — 다른 행이 쥔 identity 의 토큰만).
 *   - verifying · 사가 중: `saga_step`(다음 단계 · 검증된 양도 대상).
 *   - verifying · 사가 끝: `check` + `audit_policy([])`(DKIM 상태 — 주소가 있을 수 없으니 기대 정책은 빈 집합).
 *   - verified · suspended: 기한이면 `check` · 정책(동기화가 밀렸으면 `sync_policy`, 아니면 기한일 때 `audit_policy` — verified 는 주소, suspended 는
 *     빈 집합 = 정책 없음) · 만료 확인(24시간에 한 번).
 *   - removed · 제거 사가 중: `remove_step`(SES 가 필요 없는 행이면 없음 — `removalNeedsNoSes` · 대체된 행은 `supersededRemovalAction` 이 remove 일 때만).
 *     넘겨받기만 하고 채택 전에 removed 가 된 관리자는 먼저 `saga_step(identity)` 로 채택한다(태그가 자기 것이어야 지울 수 있다).
 */
export function planRow(row: DomainRow, ctx: RowContext): DomainControlRequest[] {
  const base = { rowId: row.id, domain: row.domain, registrable: row.registrable } as const;
  const due = row.nextCheckAt.getTime() <= ctx.now.getTime();
  switch (row.status) {
    case 'pending': {
      if (!due) return [];
      const check: DomainControlRequest = { ...base, op: 'check', token: row.challengeToken };
      const peek: DomainControlRequest = { ...base, op: 'peek_identity' };
      if (!isSteward(row)) return row.dkimTokens.length === 0 ? [check, peek] : [check];
      const step = pendingSagaStep(row.sagaStep);
      if (step !== null) return [{ ...base, op: 'saga_step', step, supersededRowId: step === 'identity' ? ctx.supersededRowId : null }, check];
      return [check, peek];
    }
    case 'verifying': {
      if (!due) return [];
      const step = nextSagaStep(row.sagaStep);
      if (row.sagaStep !== 'done' && step !== null) return [{ ...base, op: 'saga_step', step, supersededRowId: ctx.supersededRowId }];
      return [
        { ...base, op: 'check', token: row.challengeToken },
        { ...base, op: 'audit_policy', addresses: [], expectedDigest: row.policyDigest },
      ];
    }
    case 'verified':
    case 'suspended': {
      if (!policyOpsAllowed(row)) return [];
      const addresses = row.status === 'verified' ? [...ctx.addresses] : [];
      const requests: DomainControlRequest[] = [];
      if (due) requests.push({ ...base, op: 'check', token: row.challengeToken });
      if (row.policySyncRequestedAt !== null) requests.push({ ...base, op: 'sync_policy', addresses });
      else if (due) requests.push({ ...base, op: 'audit_policy', addresses, expectedDigest: row.policyDigest });
      if (due && (row.registrationCheckedAt === null || row.registrationCheckedAt.getTime() <= ctx.now.getTime() - EXPIRY_CHECK_INTERVAL_MS)) {
        requests.push({ ...base, op: 'check_expiry' });
      }
      return requests;
    }
    case 'removed': {
      if (row.removalStep === 'done' || removalNeedsNoSes(row)) return [];
      // 대체된 행 — 후속 행이 채택 전에 사라졌을 때만 SES 를 건드린다(`supersededRemovalAction`).
      if (row.supersededBy !== null && row.identityReleasedAt === null && ctx.supersededAction !== 'remove') return [];
      // 넘겨받고 채택하기 전에 removed — 직전 관리자의 identity 를 먼저 채택한다(그다음 정상 제거 사가).
      if (isSteward(row) && ctx.supersededRowId !== null && row.sesIdentityRowTag !== row.id) {
        return [{ ...base, op: 'saga_step', step: 'identity', supersededRowId: ctx.supersededRowId }];
      }
      const step = row.removalStep === 'none' ? 'policy' : row.removalStep === 'policy' ? 'identity' : null;
      return step === null ? [] : [{ ...base, op: 'remove_step', step }];
    }
  }
}

// ---------------------------------------------------------------------------
// 순수 — 결과 판정
// ---------------------------------------------------------------------------

export interface MetricBump {
  readonly name: DomainMetricName;
  readonly value: number;
}

export type Decision =
  | {
      readonly kind: 'update';
      readonly patch: TickPatch;
      readonly notices: readonly NoticeSpec[];
      readonly metrics: readonly MetricBump[];
      /** 상태 전이(로그 `domain.transition`) — 없으면 null. */
      readonly transition: { readonly to: string; readonly reason: string | null } | null;
    }
  /**
   * pending → verifying 은 도메인 진입 잠금 · 점유 가드(P0A02)를 거친다 — 실패하면 양도 후보를 찾는다. `patch` = 같은 틱의 사가 · 들여다보기 결과(토큰 ·
   * SES 상태 칸) — 진입 성패와 함께 적는다.
   */
  | { readonly kind: 'enter_verifying'; readonly inboundMx: InboundMxStatus; readonly patch: TickPatch; readonly metrics: readonly MetricBump[] };

/** `last_error` 칸 모양(`^[a-z][a-z0-9_.:-]{0,79}$`)으로 — SES 예외 이름(대문자)도 소문자로. */
export function lastErrorOf(code: string | null): string | null {
  if (code === null) return null;
  const cleaned = code.toLowerCase().replace(/[^a-z0-9_.:-]/g, '_').slice(0, 80);
  return /^[a-z]/.test(cleaned) ? cleaned : `e_${cleaned}`.slice(0, 80);
}

function at(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

/** 알림 사건 키의 시각 부분(에폭 초). */
function epochSeconds(date: Date): string {
  return String(Math.floor(date.getTime() / 1000));
}

/** 정지 사유가 지금보다 센가(또는 지금 verified 인가) — DB 전이 가드의 "세지는 쪽으로만" 과 같은 판정. */
export function canSuspend(row: Pick<DomainRow, 'status' | 'suspendedReason'>, reason: CustomDomainSuspendedReason): boolean {
  if (row.status === 'verified') return true;
  if (row.status !== 'suspended' || row.suspendedReason === null) return false;
  return CUSTOM_DOMAIN_SUSPENSION_STRENGTH[reason] > CUSTOM_DOMAIN_SUSPENSION_STRENGTH[row.suspendedReason];
}

/** 정지 패치 + 알림(사건 키 = 사유:에폭초). ownership_lost 는 14일 뒤 제거 시각. */
function suspendPatch(row: Pick<DomainRow, 'removalDueAt'>, reason: CustomDomainSuspendedReason, now: Date): { patch: TickPatch; notice: NoticeSpec } {
  const patch: TickPatch = {
    status: 'suspended',
    suspended_reason: reason,
    suspended_at: now,
    removal_due_at: reason === 'ownership_lost' ? (row.removalDueAt ?? at(now, OWNERSHIP_LOST_REMOVAL_MS)) : null,
  };
  return { patch, notice: { kind: 'suspended', eventKey: `${reason}:${epochSeconds(now)}` } };
}

/**
 * RDAP 만료의 확정 — 이번 관측의 만료일이 `now − RDAP_EXPIRY_GRACE_MS` 이전이고, **앞 틱의 관측**(행의 `registration_expires_at` · `registration_checked_at`)도
 * 그 시각 기준으로 하루 넘게 지난 만료였다. 첫 관측은 기록만 한다(다음 확인 — 24시간 뒤 — 이 확정한다).
 */
function expiryConfirmed(row: Pick<DomainRow, 'registrationExpiresAt' | 'registrationCheckedAt'>, expiresAt: Date, now: Date): boolean {
  if (expiresAt.getTime() > now.getTime() - RDAP_EXPIRY_GRACE_MS) return false;
  const before = row.registrationExpiresAt;
  const seen = row.registrationCheckedAt;
  return before !== null && seen !== null && seen.getTime() < now.getTime() && before.getTime() <= seen.getTime() - RDAP_EXPIRY_GRACE_MS;
}

function resultOf<O extends DomainControlResult['op']>(results: readonly DomainControlResult[], op: O): Extract<DomainControlResult, { op: O }> | undefined {
  return results.find((result): result is Extract<DomainControlResult, { op: O }> => result.op === op);
}

function mxRecord(mx: string): InboundMxStatus | undefined {
  return mx === 'missing' || mx === 'ses' || mx === 'other' ? mx : undefined;
}

/** 생성 사가 결과를 패치에 싣는다(pending · verifying 공용). 나아갔으면 참. pending 사가는 `config_set` 에서 멈추므로 `policy → done` 접기는 verifying 뿐이다. */
function applySaga(row: DomainRow, saga: Extract<DomainControlResult, { op: 'saga_step' }>, now: Date, patch: TickPatch, metrics: MetricBump[]): boolean {
  patch.last_checked_at = now;
  if (saga.outcome === 'advanced') {
    const step = nextSagaStep(row.sagaStep);
    patch.saga_step = step === 'policy' ? 'done' : (step ?? row.sagaStep);
    patch.saga_attempts = 0;
    patch.last_error = null;
    if (step === 'identity') patch.ses_identity_row_tag = row.id;
    if (saga.dkimTokens.length > 0) patch.dkim_tokens = [...saga.dkimTokens];
    if (saga.dkimStatus !== 'unknown') patch.dkim_status = saga.dkimStatus;
    if (saga.mailFromStatus !== 'unknown') patch.mail_from_status = saga.mailFromStatus;
    if (step === 'policy' && saga.policyDigest !== null) patch.policy_digest = saga.policyDigest;
    patch.next_check_at = now; // 다음 틱이 다음 단계를 잇는다.
    return true;
  }
  patch.saga_attempts = row.sagaAttempts + 1;
  recordSagaFailure(saga, patch, metrics);
  patch.next_check_at = at(now, PENDING_CHECK_INTERVAL_MS);
  return false;
}

/** 사가가 나아가지 못했다 — `last_error` + 지표(태그가 다른 행이면 `identity_owned_elsewhere`, 그 밖은 확인 오류). */
function recordSagaFailure(saga: Extract<DomainControlResult, { op: 'saga_step' }>, patch: TickPatch, metrics: MetricBump[]): void {
  const elsewhere = saga.outcome === 'identity_owned_elsewhere';
  patch.last_error = elsewhere ? 'identity_owned_elsewhere' : lastErrorOf(saga.errorCode ?? 'error');
  metrics.push({ name: elsewhere ? DOMAIN_METRIC_NAMES.identityOwnedElsewhere : DOMAIN_METRIC_NAMES.checkError, value: 1 });
}

/**
 * 들여다보기 결과(읽기 전용)를 패치에 싣는다 — 토큰은 언제나(공개 DNS 이름), SES 상태는 **이 행이 태그 주인일 때만**(계약 — 다른 행의 진행은 `unknown`).
 * `identity_owned_elsewhere` 지표를 올리지 않는다(관리자 아닌 pending 에선 정상).
 */
function applyPeek(row: DomainRow, peek: Extract<DomainControlResult, { op: 'peek_identity' }>, patch: TickPatch, metrics: MetricBump[]): void {
  if (peek.outcome === 'error') {
    if (peek.errorCode !== null) metrics.push({ name: DOMAIN_METRIC_NAMES.checkError, value: 1 });
    return;
  }
  if (peek.outcome !== 'found') return;
  if (peek.dkimTokens.length > 0 && peek.dkimTokens.join(',') !== row.dkimTokens.join(',')) patch.dkim_tokens = [...peek.dkimTokens];
  if (!peek.ownerIsRow) return;
  if (peek.dkimStatus !== 'unknown') patch.dkim_status = peek.dkimStatus;
  if (peek.mailFromStatus !== 'unknown') patch.mail_from_status = peek.mailFromStatus;
}

/**
 * 결과 → 결정(순수). `results` 는 `planRow` 가 만든 요청의 결과(같은 순서). 결정은 행을 다시 잠근 뒤 `updated_at` 이 계획 때와 같을 때만 적용된다.
 */
export function decide(row: DomainRow, results: readonly DomainControlResult[], now: Date): Decision {
  const metrics: MetricBump[] = [];
  const notices: NoticeSpec[] = [];
  const patch: TickPatch = {};
  let transition: { to: string; reason: string | null } | null = null;
  const errorMetric = (code: string | null): void => {
    if (code !== null) metrics.push({ name: DOMAIN_METRIC_NAMES.checkError, value: 1 });
  };

  switch (row.status) {
    case 'pending': {
      // pending 관리자의 사가(identity → mail_from → config_set) · 들여다보기 — 상태는 그대로, 토큰 · SES 상태 칸만.
      const saga = resultOf(results, 'saga_step');
      const advanced = saga !== undefined && applySaga(row, saga, now, patch, metrics);
      const peek = resultOf(results, 'peek_identity');
      if (peek !== undefined) applyPeek(row, peek, patch, metrics);
      const check = resultOf(results, 'check');
      if (check === undefined) break;
      patch.last_checked_at = now;
      // 사가가 나아갔으면 다음 틱이 다음 단계를 잇는다.
      patch.next_check_at = advanced ? now : at(now, PENDING_CHECK_INTERVAL_MS);
      errorMetric(check.errorCode);
      if (check.txt === 'present' && (check.mx === 'missing' || check.mx === 'ses')) {
        return { kind: 'enter_verifying', inboundMx: check.mx, patch, metrics };
      }
      if (check.txt === 'present' && check.mx === 'other') {
        patch.pending_reason = 'subdomain_has_mail';
        patch.inbound_mx_status = 'other';
      }
      break;
    }
    case 'verifying': {
      const saga = resultOf(results, 'saga_step');
      if (saga !== undefined) {
        applySaga(row, saga, now, patch, metrics);
        break;
      }
      const check = resultOf(results, 'check');
      const audit = resultOf(results, 'audit_policy');
      if (check === undefined) break;
      patch.last_checked_at = now;
      errorMetric(check.errorCode);
      const mx = mxRecord(check.mx);
      if (mx !== undefined) patch.inbound_mx_status = mx;
      const dkim: CustomDomainSesStatus = audit !== undefined && audit.outcome !== 'error' ? audit.dkimStatus : 'unknown';
      if (dkim !== 'unknown') patch.dkim_status = dkim;
      if (audit?.outcome === 'not_owner') metrics.push({ name: DOMAIN_METRIC_NAMES.identityOwnedElsewhere, value: 1 });
      if (check.txt === 'present' && (check.mx === 'missing' || check.mx === 'ses') && dkim === 'success') {
        patch.status = 'verified';
        patch.verified_at = now;
        patch.consecutive_definitive_failures = 0;
        patch.next_check_at = at(now, RECHECK_INTERVAL_MS);
        transition = { to: 'verified', reason: null };
        // 확인 완료 알림 — 사건 키 = 그 시각(확인 회차마다 한 번 · 같은 결정의 재시도는 UNIQUE 가 막는다).
        notices.push({ kind: 'verified', eventKey: `verified:${epochSeconds(now)}` });
      } else {
        patch.next_check_at = at(now, PENDING_CHECK_INTERVAL_MS);
      }
      break;
    }
    case 'verified':
    case 'suspended': {
      let suspendTo: CustomDomainSuspendedReason | null = null;
      const consider = (reason: CustomDomainSuspendedReason): void => {
        if (suspendTo === null || CUSTOM_DOMAIN_SUSPENSION_STRENGTH[reason] > CUSTOM_DOMAIN_SUSPENSION_STRENGTH[suspendTo]) suspendTo = reason;
      };
      let recovered = false;
      const check = resultOf(results, 'check');
      const audit = resultOf(results, 'audit_policy');
      const sync = resultOf(results, 'sync_policy');
      const expiry = resultOf(results, 'check_expiry');
      const dkim: CustomDomainSesStatus = audit !== undefined && audit.outcome !== 'error' ? audit.dkimStatus : 'unknown';
      if (dkim !== 'unknown') patch.dkim_status = dkim;

      if (check !== undefined) {
        patch.last_checked_at = now;
        errorMetric(check.errorCode);
        const mx = mxRecord(check.mx);
        if (mx !== undefined) patch.inbound_mx_status = mx;
        if (mx === 'other' && row.inboundMxStatus !== 'other') metrics.push({ name: DOMAIN_METRIC_NAMES.mxConflict, value: 1 });
        const txtAbsent = check.txt === 'absent';
        const dkimFailed = dkim === 'failed';
        if (txtAbsent || dkimFailed) {
          const failures = row.consecutiveDefinitiveFailures + 1;
          patch.consecutive_definitive_failures = failures;
          patch.next_check_at = at(now, DEFINITIVE_FAILURE_RETRY_MS);
          if (failures >= SUSPEND_AFTER_DEFINITIVE_FAILURES) consider(txtAbsent ? 'ownership_lost' : 'dkim_failed');
        } else if (check.txt === 'present') {
          patch.consecutive_definitive_failures = 0;
          patch.next_check_at = at(now, RECHECK_INTERVAL_MS);
          // 자동 복귀 — ownership_lost · dkim_failed 만(DKIM 은 성공을 본 때만). reputation · operator · plan_limit 은 여기서 풀지 않는다.
          if (row.status === 'suspended' && row.suspendedReason === 'ownership_lost') recovered = true;
          if (row.status === 'suspended' && row.suspendedReason === 'dkim_failed' && dkim === 'success') recovered = true;
        } else {
          // error — 상태 · 카운터 불변(원칙 3).
          patch.next_check_at = at(now, DEFINITIVE_FAILURE_RETRY_MS);
        }
      }
      if (audit !== undefined) {
        if (audit.outcome === 'drift') {
          metrics.push({ name: DOMAIN_METRIC_NAMES.policyDrift, value: 1 });
          consider('operator'); // 계획 §3.5 — 덮어쓰기(domain-control) + 사람이 볼 때까지 operator 정지.
        } else if (audit.outcome === 'not_owner') {
          metrics.push({ name: DOMAIN_METRIC_NAMES.identityOwnedElsewhere, value: 1 });
        } else if (audit.outcome === 'error') {
          errorMetric(audit.errorCode);
        }
      }
      if (sync !== undefined) {
        if (sync.outcome === 'synced') {
          patch.policy_digest = sync.policyDigest;
          patch.policy_sync_requested_at = null;
        } else if (sync.outcome === 'too_large') {
          metrics.push({ name: DOMAIN_METRIC_NAMES.policyTooLarge, value: 1 });
        } else if (sync.outcome === 'not_owner') {
          metrics.push({ name: DOMAIN_METRIC_NAMES.identityOwnedElsewhere, value: 1 });
        } else {
          errorMetric(sync.errorCode ?? sync.outcome);
        }
      }
      if (expiry !== undefined) {
        if (expiry.outcome === 'ok' && expiry.expiresAt !== null) {
          const expiresAt = new Date(expiry.expiresAt);
          patch.registration_expires_at = expiresAt;
          patch.registration_checked_at = now;
          if (expiresAt.getTime() <= now.getTime()) {
            // 만료(#13 보안 리뷰 L1 · 리드 결정) — ownership_lost 는 별칭을 되돌릴 수 없이 폐기하므로 RDAP 한 번으로 정하지 않는다: **서로 다른 틱에서 두 번**,
            //   그리고 만료일이 **하루 넘게 지났을 때만**(갱신 반영 지연 · RDAP 오답 한 번을 견딘다). 앞 관측은 행에 남은 값(만료일 · 확인 시각)이다.
            if (expiryConfirmed(row, expiresAt, now)) consider('ownership_lost');
          } else {
            const day = expiresAt.toISOString().slice(0, 10).replaceAll('-', '');
            for (const days of EXPIRY_WARNING_DAYS) {
              if (expiresAt.getTime() - now.getTime() <= days * DAY_MS) notices.push({ kind: 'expiry_warning', eventKey: `d${String(days)}:${day}` });
            }
          }
        } else if (expiry.outcome === 'unsupported') {
          patch.registration_checked_at = now;
        } else {
          errorMetric(expiry.errorCode);
        }
      }

      const target = suspendTo as CustomDomainSuspendedReason | null;
      if (target !== null && canSuspend(row, target)) {
        const { patch: suspend, notice } = suspendPatch(row, target, now);
        Object.assign(patch, suspend);
        notices.push(notice);
        transition = { to: 'suspended', reason: target };
      } else if (recovered && target === null) {
        patch.status = 'verified';
        patch.suspended_reason = null;
        patch.removal_due_at = null;
        transition = { to: 'verified', reason: 'recovered' };
        // 자동 복귀(ownership_lost · dkim_failed)도 알린다 — 정지 알림을 받은 소유자가 풀린 것을 안다. 요금제 복귀(planLimitChanges)는 소유자가
        // 요금제를 바꾼 결과라 알리지 않는다 · 운영자 해제(admin:domain --unfreeze)는 운영자가 직접 연락한다.
        notices.push({ kind: 'verified', eventKey: `recovered:${epochSeconds(now)}` });
      }
      break;
    }
    case 'removed': {
      // 넘겨받은 identity 를 채택(그다음 정상 제거 사가 — 태그가 이 행이어야 지운다).
      const adopt = resultOf(results, 'saga_step');
      if (adopt !== undefined) {
        if (adopt.outcome === 'advanced') {
          patch.ses_identity_row_tag = row.id;
          patch.last_error = null;
        } else {
          recordSagaFailure(adopt, patch, metrics);
        }
        patch.next_check_at = adopt.outcome === 'advanced' ? now : at(now, PENDING_CHECK_INTERVAL_MS);
        break;
      }
      const remove = resultOf(results, 'remove_step');
      if (remove === undefined) break;
      if (remove.outcome === 'advanced') {
        const next = row.removalStep === 'none' ? 'policy' : 'done';
        patch.removal_step = next;
        if (next === 'done') patch.identity_deleted_at = now;
        patch.last_error = null;
      } else if (remove.outcome === 'not_owner') {
        // ★ 다른 행(또는 태그 없음)이 쥔 identity 는 지우지 않는다 — 이 행의 사가는 끝. 관리자였으면 관리권을 **포기**한다(넘겨받을 행 없음 —
        //   그 도메인에 관리자가 없고 identity 는 남는다 → 고아 후보로 센다).
        patch.removal_step = 'done';
        if (isSteward(row)) patch.identity_released_at = now;
      } else {
        patch.last_error = lastErrorOf(remove.errorCode ?? 'error');
        errorMetric(remove.errorCode ?? 'error');
      }
      break;
    }
  }
  return { kind: 'update', patch, notices, metrics, transition };
}

// ---------------------------------------------------------------------------
// 순수 — 시간 전이 · 요금제 강등
// ---------------------------------------------------------------------------

/** 시간만으로 정해지는 전이(SES 호출 0). `null` = 아직. */
export function timedTransition(row: DomainRow, now: Date): { patch: TickPatch; notices: NoticeSpec[]; reason: string } | null {
  const removed = (reason: string, extra: TickPatch = {}): { patch: TickPatch; notices: NoticeSpec[]; reason: string } => ({
    patch: { status: 'removed', removed_at: now, suspended_reason: null, pending_reason: null, ...extra },
    notices: [{ kind: 'removed', eventKey: `removed:${epochSeconds(now)}` }],
    reason,
  });
  if (row.status === 'pending' && row.createdAt.getTime() <= now.getTime() - PENDING_EXPIRY_MS) {
    // 관리자였으면(one-shot — pending 에서 identity 를 만들었다) 제거 사가가 잇는다(넘겨주기 우선 · 없으면 identity 삭제). 아니면 SES 호출 0 으로 끝.
    return { ...removed('pending_expired', isSteward(row) ? {} : { removal_step: 'done' }), notices: [] };
  }
  if (row.status === 'verifying' && row.txtVerifiedAt !== null && row.txtVerifiedAt.getTime() <= now.getTime() - PENDING_EXPIRY_MS) {
    return { ...removed('verifying_expired'), notices: [] };
  }
  if (row.status === 'suspended' && row.suspendedReason === 'ownership_lost' && row.removalDueAt !== null) {
    if (row.removalDueAt.getTime() <= now.getTime()) return removed('ownership_lost_14d');
    if (row.removalDueAt.getTime() - REMOVAL_NOTICE_DAYS_BEFORE * DAY_MS <= now.getTime()) {
      return { patch: {}, notices: [{ kind: 'removal_d3', eventKey: `d3:${epochSeconds(row.removalDueAt)}` }], reason: 'removal_notice' };
    }
  }
  return null;
}

/**
 * 요금제 강등·복귀(순수) — 조직의 verified · suspended 행을 verified 시각 순으로 세어 한도 안의 plan_limit 은 verified 로, 한도 밖의 verified 는
 * plan_limit 으로. 다른 사유의 정지는 자리만 차지하고 건드리지 않는다. **요금제는 정책 로더와 같은 해석**(`resolveEntitlements` — 행이 없거나 유예가
 * 끝났으면 Free, 유예 중이면 그 요금제)이다(#13 보안 리뷰 M1 — 유예 만료를 무시하지 않는다). 한도 칸은 보지 않는다 — 도메인 수는 코드 카탈로그.
 */
export function planLimitChanges(
  input: { readonly planCode: string | null; readonly graceUntil: Date | null; readonly rows: readonly DomainRow[] },
  now: Date,
): { readonly row: DomainRow; readonly to: 'verified' | 'plan_limit' }[] {
  const row = input.planCode === null ? null : ({ plan_code: input.planCode, grace_until: input.graceUntil } as unknown as EntitlementRowInput);
  const limit = customDomainLimitOf(resolveEntitlements(row, now).planCode);
  const ordered = [...input.rows].sort((a, b) => (a.verifiedAt?.getTime() ?? 0) - (b.verifiedAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
  const changes: { row: DomainRow; to: 'verified' | 'plan_limit' }[] = [];
  ordered.forEach((domainRow, index) => {
    const within = index < limit;
    if (within && domainRow.status === 'suspended' && domainRow.suspendedReason === 'plan_limit') changes.push({ row: domainRow, to: 'verified' });
    if (!within && domainRow.status === 'verified') changes.push({ row: domainRow, to: 'plan_limit' });
  });
  return changes;
}

// ---------------------------------------------------------------------------
// 틱
// ---------------------------------------------------------------------------

export interface DomainTickDependencies {
  /** 틱 롤 풀(max 1 — 이벤트마다 열고 닫는다). */
  readonly pool: DomainPool;
  readonly invoker: DomainControlInvoker;
  readonly now: () => Date;
  /** 단조 시계(ms) — 예산. */
  readonly clock?: () => number;
  readonly budgetMs?: number;
  /** 운영은 생략(전부). 통합 테스트만 조직을 좁힌다. */
  readonly scope?: TickScope;
}

export interface DomainTickReport {
  /** `busy` = 틱 롤 연결 상한(53300 — 즉시 실행이 연결을 쥐고 있다 · 겹친 예약 틱). 에러가 아니다 — 다음 틱이 잇는다(보안 리뷰 M2). */
  readonly outcome: 'ok' | 'unavailable' | 'busy';
  readonly timed: number;
  readonly planLimit: number;
  readonly requests: number;
  readonly applied: number;
  readonly skipped: number;
  readonly transfers: number;
  readonly reputation: number;
  readonly dueBacklog: number;
  /** 고아 identity 후보 수(`orphanCandidates` — 0 이 정상). */
  readonly orphanCandidates: number;
  /** 이번 틱의 클레임(관리자가 된 pending 행) · 제거 사가 넘겨주기 수. */
  readonly claims?: number;
  readonly handovers?: number;
  /** 활성 identity 관리자 수(`domain.identities_held`). */
  readonly identitiesHeld?: number;
  /** 예산 때문에 다음 틱으로 미룬 단계(`timed` · `plan_limit` · `batch` · `reputation`). */
  readonly deferred: readonly string[];
}

function logTransition(row: Pick<DomainRow, 'id' | 'status'>, to: string, reason: string | null): void {
  log('info', DOMAIN_LOG_EVENTS.transition, { route_id: ROUTE_ID, outcome: to, reason, detail: `domain_id=${row.id} from=${row.status} to=${to}` });
}

/** 알림 적기 — 하루 상한에 걸려 버려지면 로그를 남긴다(조용히 사라지지 않게). 같은 사건(duplicate)은 정상이라 남기지 않는다. */
async function recordNotice(tx: DomainDb, row: Pick<DomainRow, 'id' | 'organizationId'>, notice: NoticeSpec): Promise<void> {
  if ((await insertNotice(tx, row, notice)) === 'capped') {
    log('warn', DOMAIN_LOG_EVENTS.noticeCapped, { route_id: ROUTE_ID, outcome: 'capped', reason: notice.kind, detail: `domain_id=${row.id} kind=${notice.kind}` });
  }
}

async function applyDecision(tx: DomainDb, row: DomainRow, decision: Extract<Decision, { kind: 'update' }>): Promise<void> {
  await updateRow(tx, row.id, decision.patch);
  for (const notice of decision.notices) await recordNotice(tx, row, notice);
}

/** 계획 때와 같은 행인가(잠근 뒤) — 다르면 이번 결과는 버린다. */
async function lockedUnchanged(tx: DomainDb, row: DomainRow): Promise<DomainRow | null> {
  const current = await selectRow(tx, row.id, true);
  return current !== null && current.updatedAt.getTime() === row.updatedAt.getTime() ? current : null;
}

/** 틱마다 0 이어도 내는 수치 셋(밀린 수 · 고아 후보 · 활성 관리자) — 결측이 곧 틱 정지 알람이다. */
async function emitTickGauges(pool: DomainPool, now: Date, scope: TickScope | null): Promise<{ backlog: number; orphans: number; held: number }> {
  const backlog = await dueBacklog(pool, now, scope);
  emitDomainMetric(DOMAIN_METRIC_NAMES.dueBacklog, backlog);
  const orphans = await orphanCandidates(pool, scope);
  emitDomainMetric(DOMAIN_METRIC_NAMES.orphanCandidates, orphans);
  const held = await identitiesHeld(pool, scope);
  emitDomainMetric(DOMAIN_METRIC_NAMES.identitiesHeld, held);
  return { backlog, orphans, held };
}

function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

/**
 * pending → verifying(도메인 진입 잠금 · 점유 가드). 점유(P0A02) · 같은 도메인 경합(23505) · 동결 톰스톤(42501)이면 pending 에 `registrable_taken`
 * 을 남기고(다른 조직을 밝히지 않는다), 양도 후보(다른 조직의 ownership_lost 행)가 있으면 그 행을 돌려준다. **SES 호출 0**(진 쪽).
 *
 * **증명이 선점을 이긴다**(one-shot §2.3 ②) — 이 행이 관리자가 아니고 그 도메인의 활성 관리자가 pending(조직 무관 — 증명 없음)이거나 정책을 지운 removed
 * 면 같은 트랜잭션(세이브포인트 안)에서 그 행을 놓게 하고(`identity_handover_to` = 이 행) 들어선다 — DB 가 이 행을 자동 클레임한다. 다음 틱 사가가
 * 채택한다. 관리자가 removed 인데 정책이 남았으면 이번엔 들어서지 않는다(`deferred` — 제거 사가의 정책 단계 뒤에 다시 본다).
 * MAIL FROM 이 `failed` 로 굳어 있으면 사가를 `identity` 로 되돌려 다시 넣는다(멱등 재설정).
 */
async function enterVerifying(
  pool: DomainPool,
  row: DomainRow,
  inboundMx: InboundMxStatus,
  now: Date,
  extra: TickPatch = {},
): Promise<'entered' | 'taken' | 'stale' | 'deferred' | { readonly transferFrom: DomainRow }> {
  return inTickTransaction(pool, async (tx) => {
    await lockDomainEntry(tx, row.domain);
    const current = await lockedUnchanged(tx, row);
    if (current === null || current.status !== 'pending') return 'stale';
    let released: DomainRow | null = null;
    await tx.query('SAVEPOINT enter_verifying');
    try {
      if (current.identityReleasedAt === null && !isSteward(current)) {
        const holder = await activeStewardFor(tx, current.domain);
        if (holder !== null && holder.id !== current.id) {
          if (holder.status === 'pending' || (holder.status === 'removed' && (holder.removalStep === 'policy' || holder.sagaStep !== 'done'))) {
            await updateRow(tx, holder.id, { identity_released_at: now, identity_handover_to: current.id });
            released = holder;
          } else if (holder.status === 'removed') {
            await tx.query('RELEASE SAVEPOINT enter_verifying');
            await updateRow(tx, current.id, { ...extra, inbound_mx_status: inboundMx, last_checked_at: now, next_check_at: at(now, DOMAIN_TICK_INTERVAL_MS) });
            return 'deferred';
          }
          // verifying+ 관리자 — 아래 UPDATE 가 P0A02(다른 조직) · 23505(색인)로 막힌다.
        }
      }
      const redoMailFrom = current.mailFromStatus === 'failed' && (current.sagaStep === 'mail_from' || current.sagaStep === 'config_set');
      await updateRow(tx, row.id, {
        ...extra,
        ...(redoMailFrom ? { saga_step: 'identity' } : {}),
        status: 'verifying',
        txt_verified_at: now,
        pending_reason: null,
        inbound_mx_status: inboundMx,
        next_check_at: now,
        last_checked_at: now,
      });
      await tx.query('RELEASE SAVEPOINT enter_verifying');
      if (released !== null) {
        emitDomainMetric(DOMAIN_METRIC_NAMES.identityHandover, 1);
        log('info', DOMAIN_LOG_EVENTS.identityHandover, { route_id: ROUTE_ID, outcome: 'preempted', detail: `domain_id=${row.id} from=${released.id}` });
      }
      return 'entered';
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT enter_verifying');
      const code = sqlState(error);
      // 23514 — 관리권을 이미 놓은 행(쓰기 1회 클레임)은 다시 관리자가 될 수 없다(steward CHECK).
      if (code !== 'P0A02' && code !== '23505' && code !== '42501' && code !== '23514') throw error;
    }
    const source = await transferSourceFor(tx, row);
    await updateRow(tx, row.id, { ...extra, pending_reason: 'registrable_taken', inbound_mx_status: inboundMx, last_checked_at: now, next_check_at: at(now, PENDING_CHECK_INTERVAL_MS) });
    return source === null ? 'taken' : { transferFrom: source };
  });
}

/**
 * 양도(계획 §3.3 ⑨) — **도메인 진입 잠금을 쥔 채** 옛 행 토큰의 부재를 domain-control 로 다시 확인하고, 부재면 같은 트랜잭션에서 새 행 TXT 통과 →
 * 옛 행 removed(`superseded_by`) → 새 행 verifying. 옛 행이 그 사이 바뀌었거나 토큰이 있거나 확인이 error 면 아무것도 바꾸지 않는다.
 */
async function attemptTransfer(pool: DomainPool, invoker: DomainControlInvoker, row: DomainRow, from: DomainRow, now: Date): Promise<boolean> {
  return inTickTransaction(pool, async (tx) => {
    await lockDomainEntry(tx, row.domain);
    const old = await selectRow(tx, from.id, true);
    const next = await selectRow(tx, row.id, true);
    if (old === null || next === null || old.status !== 'suspended' || old.suspendedReason !== 'ownership_lost' || next.status !== 'pending') return false;
    const [result] = await invoker.invoke([{ op: 'check', rowId: old.id, domain: old.domain, registrable: old.registrable, token: old.challengeToken }]);
    if (result?.op !== 'check' || result.txt !== 'absent') return false;
    await updateRow(tx, next.id, { txt_verified_at: now });
    // 옛 행의 정산(settle · wait · remove)은 다음 틱부터 곧바로 본다 — next_check_at 을 지금으로(대체 행은 기한을 본다, selectDueRows).
    // 관리권도 같은 UPDATE 에서 넘긴다(one-shot §2.3 ② — 새 행은 verifying 진입에서 DB 가 자동 클레임 · 다음 틱 사가가 채택).
    await updateRow(tx, old.id, {
      status: 'removed',
      suspended_reason: null,
      removed_at: now,
      superseded_by: next.id,
      next_check_at: now,
      ...(isSteward(old) ? { identity_released_at: now, identity_handover_to: next.id } : {}),
    });
    await updateRow(tx, next.id, { status: 'verifying', pending_reason: null, next_check_at: now, last_checked_at: now });
    await recordNotice(tx, old, { kind: 'removed', eventKey: `superseded:${epochSeconds(now)}` });
    logTransition(old, 'removed', 'superseded');
    logTransition(next, 'verifying', 'transfer');
    emitDomainMetric(DOMAIN_METRIC_NAMES.identityHandover, 1);
    log('info', DOMAIN_LOG_EVENTS.identityHandover, { route_id: ROUTE_ID, outcome: 'transfer', detail: `domain_id=${next.id} from=${old.id}` });
    return true;
  });
}

/**
 * 클레임 한 건(one-shot §2.3 ① — DB 먼저 · SES 나중). 도메인 진입 잠금 아래 다시 읽고:
 *   - `held_elsewhere` — 같은 apex(또는 겹치는 도메인)를 다른 조직이 verifying+ 로 쥐고 있다 → `registrable_taken`(TXT 전에도 · 다른 조직은 밝히지 않는다).
 *   - `other_steward` — 그 도메인에 다른 활성 관리자가 있다(이 행은 `peek_identity` 로 토큰만).
 *   - `claimed` — 이 행이 관리자가 됐다(`registrable_taken` 이 남아 있었으면 지운다) · `steward` — 이미 관리자.
 *   - `stale` — 행이 그 사이 바뀌었거나 pending 이 아니거나 관리권을 놓은 행이다.
 */
async function claimPendingRow(pool: DomainPool, row: DomainRow, now: Date): Promise<'claimed' | 'steward' | 'held_elsewhere' | 'other_steward' | 'stale'> {
  return inTickTransaction(pool, async (tx) => {
    await lockDomainEntry(tx, row.domain);
    const current = await selectRow(tx, row.id, true);
    if (current === null || current.status !== 'pending' || current.identityReleasedAt !== null) return 'stale';
    if (isSteward(current)) return 'steward';
    if (await registrableHeldElsewhere(tx, current)) {
      if (current.pendingReason !== 'registrable_taken') await updateRow(tx, current.id, { pending_reason: 'registrable_taken' });
      return 'held_elsewhere';
    }
    if ((await activeStewardFor(tx, current.domain)) !== null) return 'other_steward';
    if ((await claimIdentity(tx, current.id)) === 'taken') return 'other_steward';
    if (current.pendingReason === 'registrable_taken') await updateRow(tx, current.id, { pending_reason: null });
    log('info', DOMAIN_LOG_EVENTS.transition, { route_id: ROUTE_ID, outcome: 'identity_claimed', detail: `domain_id=${current.id} at=${now.toISOString()}` });
    return 'claimed';
  });
}

/**
 * 제거 사가의 **넘겨주기**(one-shot §2.5) — SES 호출 0. 같은 도메인의 클레임한 적 없는 살아 있는 행(가장 오래된 것)이 있으면 그 행에 관리권을 넘기고
 * (놓기 · 받는 행 클레임 · 다음 확인 지금) 이 행의 제거 사가를 끝낸다. 대상이 없거나 행이 바뀌었으면 `false`(정상 제거 사가가 잇는다).
 */
async function handOverOnRemoval(pool: DomainPool, row: DomainRow, now: Date): Promise<boolean> {
  return inTickTransaction(pool, async (tx) => {
    await lockDomainEntry(tx, row.domain);
    const current = await lockedUnchanged(tx, row);
    if (current === null || !removalHandoverDue(current)) return false;
    const target = await handoverTargetFor(tx, current);
    if (target === null) return false;
    await updateRow(tx, current.id, { identity_released_at: now, identity_handover_to: target, removal_step: 'done' });
    if ((await claimIdentity(tx, target)) !== 'claimed') throw new Error('넘겨받는 행이 클레임하지 못했다(가드 · 색인과 어긋남)');
    await updateRow(tx, target, { next_check_at: now });
    emitDomainMetric(DOMAIN_METRIC_NAMES.identityHandover, 1);
    log('info', DOMAIN_LOG_EVENTS.identityHandover, { route_id: ROUTE_ID, outcome: 'removal', detail: `domain_id=${target} from=${current.id}` });
    return true;
  });
}

/** 요청 수로 예산을 채운다 — 한 행의 요청은 함께 간다(나누지 않는다). */
export function packBudget(planned: readonly { readonly row: DomainRow; readonly requests: readonly DomainControlRequest[] }[]): {
  readonly row: DomainRow;
  readonly requests: readonly DomainControlRequest[];
}[] {
  let pending = 0;
  let recheck = 0;
  const chosen: { row: DomainRow; requests: readonly DomainControlRequest[] }[] = [];
  for (const item of planned) {
    if (item.requests.length === 0) continue;
    const isPending = item.row.status === 'pending' || item.row.status === 'verifying';
    const cost = item.requests.length;
    if (isPending ? pending + cost > DOMAIN_TICK_PENDING_BUDGET : recheck + cost > DOMAIN_TICK_RECHECK_BUDGET) continue;
    if (isPending) pending += cost;
    else recheck += cost;
    chosen.push(item);
  }
  return chosen;
}

/**
 * 틱 하나. 던지지 않는 것이 목표지만 DB 오류는 위로 올린다(핸들러가 로그 · 실패로 끝낸다 — 다음 틱이 잇는다).
 * **연결 상한(53300)은 오류가 아니다**(보안 리뷰 M2) — 틱 롤은 `CONNECTION LIMIT 1` 이고 즉시 실행(`provisionDomainNow`)이 잠깐 쥘 수 있다. 그때는
 * `busy`(warn)로 끝낸다. 이미 커밋한 단계(행마다 자기 트랜잭션)는 그대로이고, 남은 일은 다음 틱이 잇는다.
 */
export async function runDomainTick(deps: DomainTickDependencies): Promise<DomainTickReport> {
  try {
    return await runDomainTickOnce(deps);
  } catch (error) {
    if (sqlState(error) !== '53300') throw error;
    log('warn', DOMAIN_LOG_EVENTS.backlog, { route_id: ROUTE_ID, outcome: 'busy', error_code: '53300', detail: 'connection_limit' });
    return { outcome: 'busy', orphanCandidates: 0, timed: 0, planLimit: 0, requests: 0, applied: 0, skipped: 0, transfers: 0, reputation: 0, dueBacklog: 0, deferred: ['all'] };
  }
}

async function runDomainTickOnce(deps: DomainTickDependencies): Promise<DomainTickReport> {
  const clock = deps.clock ?? (() => Date.now());
  const started = clock();
  const budget = deps.budgetMs ?? DOMAIN_TICK_BUDGET_MS;
  const now = deps.now();
  const { pool } = deps;
  const scope = deps.scope ?? null;
  let timed = 0;
  let planLimit = 0;
  let applied = 0;
  let skipped = 0;
  let transfers = 0;
  let reputation = 0;
  // 예산(#13 보안 리뷰 L6) — 틱 전체가 `budget`(20초) 안이다(admin λ 타임아웃 25초). DB 만 쓰는 단계(①②⑥)도 남은 시간을 본다: ①② 는 확인 배치 몫
  //   (호출 상한 10초 + 적용 여유 2초)을 남기고 멈추고, ③ 의 호출은 그 몫이 남았을 때만, ⑥ 은 남은 시간이 있을 때만. 멈춘 일은 다음 틱(10분)이 잇는다.
  const remaining = (): number => budget - (clock() - started);
  const reserveForBatch = DOMAIN_CONTROL_INVOKE_TIMEOUT_MS + 2_000;
  const deferred: string[] = [];
  let claims = 0;
  let handovers = 0;
  let batch: readonly DomainControlRequest[] = [];
  const report = (outcome: 'ok' | 'unavailable', gauges: { backlog: number; orphans: number; held: number }): DomainTickReport => ({
    outcome,
    orphanCandidates: gauges.orphans,
    timed,
    planLimit,
    requests: batch.length,
    applied,
    skipped,
    transfers,
    reputation,
    dueBacklog: gauges.backlog,
    deferred,
    claims,
    handovers,
    identitiesHeld: gauges.held,
  });

  // ① 시간 전이
  for (const row of await selectExpiringRows(pool, now, { pendingExpiryMs: PENDING_EXPIRY_MS, noticeBeforeMs: REMOVAL_NOTICE_DAYS_BEFORE * DAY_MS }, scope)) {
    if (remaining() < reserveForBatch) {
      deferred.push('timed');
      break;
    }
    const change = timedTransition(row, now);
    if (change === null) continue;
    await inTickTransaction(pool, async (tx) => {
      if ((await lockedUnchanged(tx, row)) === null) return;
      await updateRow(tx, row.id, change.patch);
      for (const notice of change.notices) await recordNotice(tx, row, notice);
      if (change.patch['status'] !== undefined) logTransition(row, String(change.patch['status']), change.reason);
      timed += 1;
    });
  }

  // ①-b 비활성 조직(운영자 거절 — review_status 'rejected')의 살아 있는 행 → removed(알림 없음 · identity 가 있던 행은 제거 사가가 잇는다).
  for (const row of await selectInactiveOrganizationRows(pool, scope)) {
    if (remaining() < reserveForBatch) {
      deferred.push('organization_inactive');
      break;
    }
    await inTickTransaction(pool, async (tx) => {
      const current = await lockedUnchanged(tx, row);
      if (current === null || current.status === 'removed') return;
      await updateRow(tx, current.id, {
        status: 'removed',
        removed_at: now,
        suspended_reason: null,
        pending_reason: null,
        ...(removalNeedsNoSes(current) ? { removal_step: 'done' } : {}),
      });
      logTransition(current, 'removed', 'organization_inactive');
      timed += 1;
    });
  }

  // ② 요금제 강등 · 복귀
  planLimitPhase: for (const org of await planLimitInputs(pool, scope)) {
    for (const change of planLimitChanges(org, now)) {
      if (remaining() < reserveForBatch) {
        deferred.push('plan_limit');
        break planLimitPhase;
      }
      await inTickTransaction(pool, async (tx) => {
        const current = await lockedUnchanged(tx, change.row);
        if (current === null) return;
        if (change.to === 'plan_limit') {
          if (!canSuspend(current, 'plan_limit')) return;
          const { patch, notice } = suspendPatch(current, 'plan_limit', now);
          await updateRow(tx, current.id, patch);
          await recordNotice(tx, current, notice);
        } else {
          await updateRow(tx, current.id, { status: 'verified', suspended_reason: null });
        }
        logTransition(current, change.to === 'plan_limit' ? 'suspended' : 'verified', 'plan_limit');
        planLimit += 1;
      });
    }
  }

  // ③-a 클레임(one-shot — DB 먼저 · SES 나중). 기한이 된 pending 행 중 관리자가 아닌 것.
  for (const row of await selectClaimCandidates(pool, now, DOMAIN_TICK_PENDING_BUDGET * 4, scope)) {
    if (remaining() < reserveForBatch) {
      deferred.push('claim');
      break;
    }
    if ((await claimPendingRow(pool, row, now)) === 'claimed') claims += 1;
  }

  // ③ 확인 배치
  const due = await selectDueRows(pool, now, (DOMAIN_TICK_PENDING_BUDGET + DOMAIN_TICK_RECHECK_BUDGET) * 4, scope);
  const planned: { row: DomainRow; requests: DomainControlRequest[] }[] = [];
  const settled: DomainRow[] = [];
  const waiting: DomainRow[] = [];
  const handing: DomainRow[] = [];
  for (const row of due) {
    let supersededAction: SupersededRemovalAction | undefined;
    if (row.status === 'removed' && row.removalStep !== 'done') {
      if (removalHandoverDue(row) && (await handoverTargetFor(pool, row)) !== null) {
        // 넘겨주기 우선(SES 호출 0) — 아래에서 도메인 진입 잠금 아래 다시 보고 넘긴다.
        handing.push(row);
        continue;
      }
      if (row.supersededBy !== null && row.identityReleasedAt === null) {
        supersededAction = supersededRemovalAction(await successorState(pool, row.supersededBy));
        if (supersededAction === 'settle') settled.push(row);
        if (supersededAction === 'wait') waiting.push(row);
        if (supersededAction !== 'remove') continue;
      } else if (removalNeedsNoSes(row)) {
        settled.push(row);
        continue;
      }
    }
    const addresses = row.status === 'verified' && policyOpsAllowed(row) ? await liveAddressesFor(pool, row) : [];
    // 채택 대상 — 사가가 identity 단계를 앞둔 verifying · pending 관리자, 그리고 채택 전에 removed 가 된 관리자.
    const needsAdoptable =
      (row.status === 'verifying' && row.sagaStep === 'none') ||
      (row.status === 'pending' && isSteward(row) && row.sagaStep === 'none' && row.sesIdentityRowTag !== row.id) ||
      (row.status === 'removed' && isSteward(row) && row.sesIdentityRowTag !== row.id);
    const supersededRowId = needsAdoptable ? await adoptableRowFor(pool, row.id) : null;
    planned.push({ row, requests: planRow(row, { now, addresses, supersededRowId, ...(supersededAction === undefined ? {} : { supersededAction }) }) });
  }
  // 후속 행의 채택을 기다리는 대체 행 — 다음 주기로 미룬다(selectDueRows 상한 슬롯을 차지하지 않게, #13 재검증).
  for (const row of waiting) {
    await inTickTransaction(pool, async (tx) => {
      if ((await lockedUnchanged(tx, row)) === null) return;
      await updateRow(tx, row.id, { next_check_at: at(now, DOMAIN_TICK_INTERVAL_MS) });
    });
  }
  // 제거 사가의 넘겨주기 — SES 호출 0.
  for (const row of handing) {
    if (await handOverOnRemoval(pool, row, now)) {
      handovers += 1;
      applied += 1;
    }
  }
  // 채택이 끝난 대체 행 · identity 없던 행 · 관리권을 놓은 행의 제거 사가 — SES 호출 0 으로 끝낸다.
  for (const row of settled) {
    await inTickTransaction(pool, async (tx) => {
      if ((await lockedUnchanged(tx, row)) === null) return;
      await updateRow(tx, row.id, { removal_step: 'done' });
      applied += 1;
    });
  }
  const enoughForBatch = remaining() >= DOMAIN_CONTROL_INVOKE_TIMEOUT_MS;
  if (!enoughForBatch && planned.some((item) => item.requests.length > 0)) deferred.push('batch');
  const chosen = enoughForBatch ? packBudget(planned) : [];
  batch = chosen.flatMap((item) => item.requests);
  let results: readonly DomainControlResult[] = [];
  if (batch.length > 0) {
    try {
      results = await deps.invoker.invoke(batch);
    } catch (error) {
      if (!(error instanceof DomainControlUnavailableError)) throw error;
      log('error', DOMAIN_LOG_EVENTS.check, { route_id: ROUTE_ID, outcome: 'unavailable', error_kind: error.name, detail: `requests=${String(batch.length)}` });
      emitDomainMetric(DOMAIN_METRIC_NAMES.checkError, batch.length);
      return report('unavailable', await emitTickGauges(pool, now, scope));
    }
  }

  // ④ 적용
  const transferCandidates: { row: DomainRow; from: DomainRow }[] = [];
  let offset = 0;
  for (const item of chosen) {
    const slice = results.slice(offset, offset + item.requests.length);
    offset += item.requests.length;
    const decision = decide(item.row, slice, now);
    for (const metric of decision.metrics) emitDomainMetric(metric.name, metric.value);
    for (const result of slice) {
      log(result.errorCode === null ? 'info' : 'warn', DOMAIN_LOG_EVENTS.check, {
        route_id: ROUTE_ID,
        outcome: 'outcome' in result ? result.outcome : `${result.txt}/${result.mx}`,
        error_code: result.errorCode,
        detail: `domain_id=${item.row.id} op=${result.op}`,
      });
    }
    if (decision.kind === 'enter_verifying') {
      const entered = await enterVerifying(pool, item.row, decision.inboundMx, now, decision.patch);
      if (entered === 'entered') {
        logTransition(item.row, 'verifying', null);
        applied += 1;
      } else if (entered === 'stale') skipped += 1;
      else if (entered === 'deferred') applied += 1;
      else {
        applied += 1;
        if (typeof entered === 'object') transferCandidates.push({ row: item.row, from: entered.transferFrom });
      }
      continue;
    }
    const done = await inTickTransaction(pool, async (tx) => {
      if ((await lockedUnchanged(tx, item.row)) === null) return false;
      await applyDecision(tx, item.row, decision);
      return true;
    });
    if (done) {
      applied += 1;
      if (decision.transition !== null) logTransition(item.row, decision.transition.to, decision.transition.reason);
    } else skipped += 1;
  }

  // ⑤ 양도 — 시간이 남으면 한 건(호출 하나를 잠금 안에서).
  const first = transferCandidates[0];
  if (first !== undefined && clock() - started + DOMAIN_CONTROL_INVOKE_TIMEOUT_MS < budget) {
    try {
      if (await attemptTransfer(pool, deps.invoker, first.row, first.from, now)) transfers += 1;
    } catch (error) {
      // 호출 실패 · 그 사이 다른 점유(P0A02 · 23505) · 동결(42501) · 가드(23514) — 아무것도 바뀌지 않았다(트랜잭션 되돌림). 다음 틱이 다시 본다.
      if (!(error instanceof DomainControlUnavailableError) && !['P0A02', '23505', '42501', '23514'].includes(sqlState(error) ?? '')) throw error;
      log('warn', DOMAIN_LOG_EVENTS.transition, { route_id: ROUTE_ID, outcome: 'transfer_aborted', error_code: sqlState(error) ?? 'unavailable', detail: `domain_id=${first.row.id}` });
    }
  }

  // ⑥ 평판(남은 시간이 있을 때만 — 7일 창이라 한 틱 늦어도 판정이 바뀌지 않는다)
  const inputs = remaining() > 0 ? await loadReputationInputs(pool, now, scope === null ? null : scope.organizationIds) : { domains: [], accountAttemptsWeek: 0 };
  if (remaining() <= 0) deferred.push('reputation');
  for (const domain of inputs.domains) {
    const verdict = judgeReputation({ week: domain.week, day: domain.day, accountAttemptsWeek: inputs.accountAttemptsWeek });
    if (verdict.action === 'ok') continue;
    emitDomainMetric(DOMAIN_METRIC_NAMES.reputationFlagged, 1);
    log(verdict.action === 'freeze' ? 'error' : 'warn', DOMAIN_LOG_EVENTS.reputation, {
      route_id: ROUTE_ID,
      outcome: verdict.action,
      detail: `domain_id=${domain.domainId} reasons=${verdict.reasons.join(',')}`,
    });
    if (verdict.action !== 'freeze') continue;
    await inTickTransaction(pool, async (tx) => {
      const current = await selectRow(tx, domain.domainId, true);
      if (current === null || !canSuspend(current, 'reputation')) return;
      const { patch, notice } = suspendPatch(current, 'reputation', now);
      await updateRow(tx, current.id, patch);
      await recordNotice(tx, current, notice);
      logTransition(current, 'suspended', 'reputation');
      reputation += 1;
    });
  }

  // ⑦ 밀린 수(0 이어도)
  const gauges = await emitTickGauges(pool, now, scope);
  const { backlog, orphans, held } = gauges;
  log('info', DOMAIN_LOG_EVENTS.backlog, {
    route_id: ROUTE_ID,
    outcome: 'ok',
    latency_ms: clock() - started,
    detail: `due_backlog=${String(backlog)} requests=${String(batch.length)} applied=${String(applied)} skipped=${String(skipped)} timed=${String(timed)} plan_limit=${String(planLimit)} transfers=${String(transfers)} reputation=${String(reputation)} orphan_candidates=${String(orphans)} claims=${String(claims)} handovers=${String(handovers)} identities_held=${String(held)} deferred=${deferred.join(',')}`,
  });
  return report('ok', gauges);
}

// ---------------------------------------------------------------------------
// 즉시 실행(one-shot §1.3)
// ---------------------------------------------------------------------------

export interface ProvisionDependencies {
  /** 틱 롤 풀(`CONNECTION LIMIT 1` — 예약 틱과 겹치면 53300 → `busy`). */
  readonly pool: DomainPool;
  readonly invoker: DomainControlInvoker;
  readonly now: () => Date;
  readonly budgetMs?: number;
}

class ProvisionTimeout extends Error {}

function withBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProvisionTimeout('budget'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * **즉시 실행**(계약 `ProvisionDomainNow`) — 도메인 추가가 커밋된 뒤 그 행 하나에 대해 클레임(틱과 같은 `claimPendingRow`) + `saga_step(identity)`
 * (관리자) 또는 `peek_identity`(다른 행이 관리 중)를 domain-control 호출 **하나**로 돈다. 판단은 전부 DB 를 다시 읽어서 하고, 결과는 틱과 같은
 * `decide` 로 행 잠금 아래(`updated_at` 이 같을 때만) 적는다. **던지지 않는다.**
 */
export async function provisionDomainNow(deps: ProvisionDependencies, rowId: string): Promise<ProvisionDomainOutcome> {
  const now = deps.now();
  const finish = (outcome: ProvisionDomainOutcome, errorKind: string | null = null): ProvisionDomainOutcome => {
    log(outcome === 'unavailable' ? 'warn' : 'info', DOMAIN_LOG_EVENTS.provision, { route_id: ROUTE_ID, outcome, error_kind: errorKind, detail: `domain_id=${rowId}` });
    return outcome;
  };
  try {
    const first = await selectRow(deps.pool, rowId);
    if (first === null || first.status !== 'pending') return finish('skipped');
    const claim = await claimPendingRow(deps.pool, first, now);
    if (claim === 'held_elsewhere') return finish('waiting');
    if (claim === 'stale' && first.identityReleasedAt === null) return finish('skipped');
    const row = await selectRow(deps.pool, rowId);
    if (row === null || row.status !== 'pending') return finish('skipped');
    const steward = isSteward(row);
    let requests: DomainControlRequest[];
    const base = { rowId: row.id, domain: row.domain, registrable: row.registrable } as const;
    if (steward && row.sagaStep === 'none') {
      const supersededRowId = row.sesIdentityRowTag !== row.id ? await adoptableRowFor(deps.pool, row.id) : null;
      requests = [{ ...base, op: 'saga_step', step: 'identity', supersededRowId }];
    } else if (row.dkimTokens.length > 0) {
      return finish(steward ? 'provisioned' : 'peeked');
    } else {
      requests = [{ ...base, op: 'peek_identity' }];
    }
    const results = await withBudget(deps.invoker.invoke(requests), deps.budgetMs ?? PROVISION_NOW_BUDGET_MS);
    const decision = decide(row, results, now);
    for (const metric of decision.metrics) emitDomainMetric(metric.name, metric.value);
    const patch = decision.patch;
    const written = await inTickTransaction(deps.pool, async (tx) => {
      if ((await lockedUnchanged(tx, row)) === null) return false;
      await updateRow(tx, row.id, patch);
      return true;
    });
    const tokens = written && Array.isArray(patch.dkim_tokens) ? (patch.dkim_tokens as unknown[]) : row.dkimTokens;
    if (tokens.length === 0) return finish('waiting');
    return finish(steward ? 'provisioned' : 'peeked');
  } catch (error) {
    if (error instanceof ProvisionTimeout) return finish('busy', 'budget');
    if (sqlState(error) === '53300') return finish('busy', 'connection_limit');
    return finish('unavailable', error instanceof Error ? error.name : typeof error);
  }
}
