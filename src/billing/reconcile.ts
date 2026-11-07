/**
 * src/billing/reconcile.ts — **하루 1회 대조, 15분 틱으로 이어 가기**(WP-2, 계획 §3-5 M5).
 *
 * 왜 필요한가: 샌드박스 웹훅 재시도는 15분뿐이고, DLQ·NAT 장애로 이벤트를 놓칠 수 있으며, 유예 만료는 이벤트 없이 일어난다(로더는 제시각에 Free 로
 * 해석하지만 행에 `grace_expired` 를 한 번 적는다). 좁게 한다 — 금액·인보이스·고객 정보는 대조하지 않는다.
 *
 * 실행 모델: Scheduler `rate(15 minutes)` → `{"action":"reconcile"}`. `billing_reconcile_state`(한 행)가 판을 잇는다 — 마지막 완료가 24시간을 넘으면
 * 새 판을 연다(새 판도 `completed_at` 은 앞 판의 값을 이어받는다 — 진행 중에도 "마지막 완료" 가 지워지지 않는다, L-5). 한 틱은 `RECONCILE_TICK_BUDGET_MS` 안에서 멈추고 커서를 저장한다(λ 60초 · SQS 와 같은 예약 동시성 1 을 나눠 쓴다 — 길게 쥐지 않는다).
 *   - `list`: `GET /subscriptions?status=active,trialing,past_due,paused` 한 페이지씩(페이지 사이 300ms · 틱당 최대 20페이지) — **목록 엔터티를 그대로**
 *     쓴다(항목마다 다시 부르지 않는다). 결속된 구독만 갱신하고(결속은 이벤트 경로만 한다), 웹훅 누락을 판정한다.
 *   - `stale`: 표의 비종단 구독을 id 로 50개씩 다시 읽는다 — 목록에 없는 상태(해지)로 넘어간 구독이 여기서 잡힌다. 상태 다섯을 **명시**한다
 *     (비우면 공급자 기본값이 `canceled` 를 뺄 수 있다 — 그러면 해지가 영영 보이지 않는다). 한 묶음이 여러 페이지로 오면 `next` 를 따르되
 *     `RECONCILE_STALE_MAX_PAGES`(5쪽)까지다(코드 검토 N-4 — id ≤ 50 묶음은 한두 쪽이다; 넘으면 공급자 이상이라 끝없이 돌지 않게). 넘으면 메트릭
 *     `billing.reconcile_skipped` + 로그 `billing.reconcile_stale_pages` 뒤 그 묶음을 넘기고(커서 = 묶음의 마지막 id) 이 틱을 끝낸다 — 다음 틱이 다음
 *     묶음에서 잇는다. 넘긴 묶음의 뒤쪽은 다음 판(24시간)이 다시 본다.
 *   - `orgs`: 결속 구독이나 provider 출처 행이 있는 조직을 id 순 50개씩 읽고, **조직마다 짧은 트랜잭션**으로 재계산(계기 `reconcile` — 운영자 행은
 *     덮지 않는다). 교착·직렬화 실패(`40P01`·`40001`)는 한 번 다시 한다. 그래도 실패하거나 다른 오류(트리거 거부 등)면 그 조직만 되돌리고
 *     `billing.reconcile_org_failed` + SQLSTATE 로그(조직 id 없음) 뒤 넘어간다 — 한 조직이 판 전체를 매 틱 멈추게 하지 않는다. 단 **연결 오류**
 *     (`08xxx`)는 조직 탓이 아니라 틱을 던져(`billing.sync_failed`) 커서를 넘기지 않는다 — 다음 틱이 그 묶음을 다시 본다(코드 검토 N-5).
 *   - **Paddle 호출은 DB 트랜잭션 밖에서만**(페이지를 받은 뒤 트랜잭션을 연다).
 *   - **한 틱 = 전용 연결 하나**(재검토 N5). 단일 실행 잠금(세션 advisory)·커서·단계별 짧은 트랜잭션·해제를 `pool.connect()` 로 얻은 연결 하나에서
 *     한다 — 풀 크기와 무관하게 잠금과 해제가 같은 세션이다. 해제가 실패하면(연결 이상·쥐지 않은 잠금) 그 연결을 풀에 돌려주지 않고 버린다 —
 *     세션이 닫히며 잠금도 풀린다. 트랜잭션은 그 연결 위에서 짧게 열고 닫는다(Paddle 호출 때는 열린 트랜잭션이 없다 — 연결을 쥐고 있을 뿐).
 *
 * 생사(재검토 N5): 매 틱 마지막 완료의 나이(`billing.reconcile_completed_age_seconds`)를 낸다 — 알람 `atmark-billing-reconcile-stale` 이 26시간을
 * 넘거나 방출이 끊기면(틱 정지) 운다. 스위치 꺼짐·결제 표 전이면 0(대조를 기대하지 않는다). `concurrent` 는 메트릭 `billing.reconcile_concurrent`
 * 를 올리고, 운영자 수동 `restart` 가 `concurrent` 로 끝나면 응답의 `restartApplied: false` 와 경고 로그가 그것을 알린다.
 *
 * 웹훅 누락(M8): 목록 엔터티의 `updated_at` 이 (now − 7일, now − 2시간) 안인데 그 구독에 `occurred_at ≥ updated_at − 1분` 인 이벤트가 없으면
 * `billing.webhook_missed`. 활성 구독이 없으면 판정할 것이 없다.
 *
 * 설정 전: 스위치가 꺼져 있으면 알람 없이 건너뛴다(`billing.reconcile_skipped`) — 키가 자리표시여도 마찬가지다. 결제 표가 아직 없어도(마이그레이션 0400
 * 전 — 배포 순서 "Compute → bootstrap-roles → migrate") 알람 없이 건너뛴다. 스위치가 켜졌는데 키가 자리표시·만료면 `billing.provider_auth_failed`(알람)
 * — 조용히 멈춘 채로 운영되지 않게.
 */

import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import {
  hasSubscriptionEventSince,
  listNonTerminalSubscriptionIds,
  listReconcileOrganizationIds,
  loadReconcileState,
  loadSubscription,
  saveReconcileState,
  tryLockReconcileRun,
  unlockReconcileRun,
  upsertSubscription,
} from '../db/repositories/billing';
import type { BillingReconcileStateRow } from '../db/schema';
import { countMetric, emitMetric, METRIC_NAMES } from '../observability/metrics';
import { log } from '../observability/logger';
import { BILLING_PROVIDERS } from './constants';
import { PADDLE_LIST_MAX_IDS } from './paddle/adapter';
import {
  BillingProviderError,
  PROVIDER_SUBSCRIPTION_STATUSES,
  ProviderAuthError,
  ProviderRateLimitedError,
  type BillingProviderApi,
  type NormalizedSubscription,
  type ProviderSubscriptionStatus,
} from './provider';
import {
  BILLING_SYNC_ROUTE_ID,
  billingTablesPresent,
  organizationAllowed,
  recomputeOrganization,
  reportRecompute,
  sqlStateOf,
  subscriptionSnapshot,
  type BillingSyncDependencies,
} from './sync';

/** 한 틱의 시간 예산 — 이 뒤로는 새 페이지·청크를 시작하지 않는다(진행 중인 것은 끝낸다 → 호출은 약 45초 안에 끝난다). */
export const RECONCILE_TICK_BUDGET_MS = 40_000;
/** 판 간격 — 마지막 완료 뒤 이만큼 지나야 새 판을 연다. */
export const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RECONCILE_MAX_PAGES_PER_TICK = 20;
export const RECONCILE_PAGE_PAUSE_MS = 300;
export const RECONCILE_ORG_CHUNK = 50;
export const RECONCILE_STALE_CHUNK = PADDLE_LIST_MAX_IDS;
/** `stale` 한 묶음(id ≤ 50)에서 따르는 최대 페이지 — 넘으면 그 묶음을 넘기고 틱을 끝낸다(N-4). */
export const RECONCILE_STALE_MAX_PAGES = 5;
/** 조직 재계산을 한 번 다시 하는 SQLSTATE — 교착 · 직렬화 실패(N-5). */
const RECONCILE_ORG_RETRY_STATES: ReadonlySet<string> = new Set(['40P01', '40001']);
/** 마지막 완료가 이보다 오래면 알람(`atmark-billing-reconcile-stale`) — 판 간격 24시간 + 한 판이 여러 틱에 걸리는 여유 2시간. */
export const RECONCILE_STALE_AFTER_MS = 26 * 60 * 60 * 1000;

/** 커서 CAS 가 졌다 — 이 틱 도중 다른 실행이 판을 바꿨다. `runReconcile` 이 `concurrent` 로 바꿔 돌려준다. */
class ReconcileSupersededError extends Error {
  constructor() {
    super('billing_reconcile_state 의 run_id 가 이 틱이 읽은 값과 다르다 — 다른 실행이 새 판을 열었다');
    this.name = 'ReconcileSupersededError';
  }
}

/** 목록에서 보는 상태 — 해지(`canceled`)는 `stale` 단계가 id 로 잡는다. */
export const RECONCILE_LIST_STATUSES: readonly ProviderSubscriptionStatus[] = ['active', 'trialing', 'past_due', 'paused'];
/** `stale` 단계가 id 로 다시 읽을 때의 상태 — 다섯 모두(해지를 잡는 단계다). */
export const RECONCILE_STALE_STATUSES: readonly ProviderSubscriptionStatus[] = PROVIDER_SUBSCRIPTION_STATUSES;
/** 웹훅 누락 창 — Paddle 쪽 변화가 2시간 넘게(7일 안) 웹훅 없이 있었다. 이벤트 시각의 여유 1분. */
export const WEBHOOK_MISSED_MIN_AGE_MS = 2 * 60 * 60 * 1000;
export const WEBHOOK_MISSED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const WEBHOOK_MISSED_SLACK_MS = 60 * 1000;

const PROVIDER = BILLING_PROVIDERS[0];

export type ReconcileStatus =
  /** 스위치 꺼짐 — 알람 없음. */
  | 'skipped'
  /** 결제 표가 아직 없다(마이그레이션 0400 전 — 배포 순서) — 알람 없음. */
  | 'not_migrated'
  /** 스위치 켜짐 + 키 자리표시·만료·권한 밖 — 알람. */
  | 'auth_failed'
  /** 429 — 커서를 저장하고 다음 틱에. */
  | 'rate_limited'
  /** 마지막 판이 24시간 안에 끝났다. */
  | 'idle'
  /**
   * 다른 실행이 돌고 있거나(단일 실행 잠금을 못 잡았다) 이 틱 도중 다른 실행이 새 판을 열었다(커서 CAS 실패) — 남의 판을 덮지 않고 멈춘다.
   * 알람 없음(다음 틱이 잇는다). 코드 리뷰 M10.
   */
  | 'concurrent'
  /** 예산이 다 돼 커서를 저장했다. */
  | 'progress'
  /** 이 틱에서 판을 끝냈다. */
  | 'completed';

export interface ReconcileReport {
  readonly status: ReconcileStatus;
  /**
   * 운영자 수동 `restart` 가 새 판을 열었는가. `null` = restart 를 요청하지 않았다. `false` 면 새 판이 열리지 않았다 — 대개 `concurrent`
   * (다른 실행이 돌고 있었다)이며, 잠시 뒤 다시 부른다(재검토 N5).
   */
  readonly restartApplied: boolean | null;
  readonly phase: BillingReconcileStateRow['phase'] | null;
  readonly pages: number;
  readonly subscriptions: number;
  readonly organizations: number;
  readonly applied: number;
  readonly missed: number;
}

export interface ReconcileOptions {
  /** 진행 중인 판을 버리고 새로 연다(`{"action":"reconcile","restart":true}`). */
  readonly restart?: boolean;
  /** 테스트가 시계·대기를 바꾼다. 기본은 실제 시계와 `setTimeout`. */
  readonly clock?: { readonly elapsedMs: () => number; readonly sleep: (ms: number) => Promise<void> };
  readonly budgetMs?: number;
}

type State = Omit<BillingReconcileStateRow, 'id'>;

function stateOf(row: BillingReconcileStateRow): State {
  const { id: _id, ...rest } = row;
  return rest;
}

/** 새 판 — 마지막 완료 시각은 앞 판의 것을 이어받는다(L-5). */
function freshRun(now: Date, previousCompletedAt: Date | null): State {
  return { run_id: randomUUID(), phase: 'list', paddle_cursor: null, org_cursor: null, started_at: now, updated_at: now, completed_at: previousCompletedAt };
}

function realClock(): NonNullable<ReconcileOptions['clock']> {
  const started = Date.now();
  return { elapsedMs: () => Date.now() - started, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
}

/** 전용 연결 위의 짧은 트랜잭션. 실패하면 되돌리고(되돌리기 실패는 원래 오류를 덮지 않는다) 던진다. */
async function inTransaction<T>(session: PoolClient, run: (client: PoolClient) => Promise<T>): Promise<T> {
  await session.query('BEGIN');
  try {
    const result = await run(session);
    await session.query('COMMIT');
    return result;
  } catch (error) {
    await session.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** 마지막 완료의 나이(초). 한 번도 끝나지 않았으면 그 판의 시작부터, 판이 아직 없으면 0(이 틱이 첫 판을 연다). */
export function reconcileCompletedAgeSeconds(state: Pick<BillingReconcileStateRow, 'completed_at' | 'started_at'> | null, now: Date): number {
  const since = state === null ? null : (state.completed_at ?? state.started_at);
  if (since === null) return 0;
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));
}

/** 목록·id 조회로 받은 구독을 표에 반영한다 — 결속된 것만(짧은 트랜잭션 하나). 웹훅 누락을 센다. */
async function applyListed(
  deps: BillingSyncDependencies,
  session: PoolClient,
  items: readonly NormalizedSubscription[],
  detectMissed: boolean,
): Promise<{ applied: number; missed: number }> {
  const now = deps.now();
  return inTransaction(session, async (client) => {
    let applied = 0;
    let missed = 0;
    for (const sub of items) {
      if (sub.environment !== deps.environment) continue;
      if (detectMissed) {
        const age = now.getTime() - sub.updatedAt.getTime();
        if (age > WEBHOOK_MISSED_MIN_AGE_MS && age < WEBHOOK_MISSED_MAX_AGE_MS) {
          const seen = await hasSubscriptionEventSince(client, sub.id, new Date(sub.updatedAt.getTime() - WEBHOOK_MISSED_SLACK_MS));
          if (!seen) missed += 1;
        }
      }
      const existing = await loadSubscription(client, PROVIDER, sub.id);
      if (existing === null || existing.environment !== deps.environment) continue;
      const written = await upsertSubscription(client, subscriptionSnapshot(sub, existing, null, now));
      if (written === 'updated') applied += 1;
      else if (written === 'stale') countMetric(METRIC_NAMES.billingSyncStale);
    }
    return { applied, missed };
  });
}

/**
 * 조직 하나 — 자기 트랜잭션에서. 교착·직렬화 실패는 한 번 다시 한다. 그래도 실패하면 그 트랜잭션만 되돌리고 메트릭 + SQLSTATE 로그(조직 id 없음)를
 * 남긴 뒤 넘어간다(코드 검토 M-3). 연결 오류(`08xxx`)는 던진다 — 틱이 실패로 끝나고 커서는 마지막 저장 지점(이 묶음 앞)에서 잇는다(N-5).
 */
async function reconcileOrganization(deps: BillingSyncDependencies, session: PoolClient, organizationId: string, counts: { applied: number }): Promise<void> {
  const attempt = () => inTransaction(session, (client) => recomputeOrganization(client, deps, organizationId, 'reconcile', null));
  try {
    let result;
    try {
      result = await attempt();
    } catch (error) {
      if (!RECONCILE_ORG_RETRY_STATES.has(sqlStateOf(error) ?? '')) throw error;
      result = await attempt();
    }
    reportRecompute(result);
    if (result.changed) counts.applied += 1;
  } catch (error) {
    if (sqlStateOf(error)?.startsWith('08') === true) throw error;
    countMetric(METRIC_NAMES.billingReconcileOrgFailed);
    log('warn', 'billing.reconcile_org_failed', {
      route_id: BILLING_SYNC_ROUTE_ID,
      outcome: 'skipped',
      error_kind: error instanceof Error ? error.name : typeof error,
      error_code: sqlStateOf(error),
    });
  }
}

/**
 * reconcile 한 틱. 공급자 인증 실패·레이트는 값으로 돌려준다(메트릭 · 커서 저장). 그 밖의 공급자 오류와 DB 오류는 던진다(`billing.sync_failed` 뒤) —
 * 호출이 실패로 남고 다음 틱이 저장된 커서에서 잇는다.
 */
export async function runReconcile(deps: BillingSyncDependencies, options: ReconcileOptions = {}): Promise<ReconcileReport> {
  const counts = { pages: 0, subscriptions: 0, organizations: 0, applied: 0, missed: 0 };
  const restartRequested = options.restart === true;
  let restartApplied = false;
  const report = (status: ReconcileStatus, phase: ReconcileReport['phase']): ReconcileReport => {
    log(status === 'auth_failed' ? 'warn' : 'info', 'billing.reconcile', { route_id: BILLING_SYNC_ROUTE_ID, outcome: status, detail: JSON.stringify({ phase, ...counts }) });
    if (status === 'concurrent') countMetric(METRIC_NAMES.billingReconcileConcurrent);
    if (restartRequested && !restartApplied) {
      log('warn', 'billing.reconcile_restart_not_applied', { route_id: BILLING_SYNC_ROUTE_ID, outcome: status });
    }
    return { status, restartApplied: restartRequested ? restartApplied : null, phase, ...counts };
  };

  if (!deps.enabled) {
    countMetric(METRIC_NAMES.billingReconcileSkipped);
    emitMetric(METRIC_NAMES.billingReconcileCompletedAgeSeconds, 0, 'Seconds');
    return report('skipped', null);
  }
  const provider: BillingProviderApi | null = deps.provider;
  if (provider === null) {
    // 스위치는 켜졌는데 키가 없다 — 대조가 멈췄다. 나이를 내지 않는다(결측 = 위반 — stale 알람도 함께 운다).
    countMetric(METRIC_NAMES.billingProviderAuthFailed);
    return report('auth_failed', null);
  }

  if (!(await billingTablesPresent(deps.pool))) {
    countMetric(METRIC_NAMES.billingReconcileSkipped);
    emitMetric(METRIC_NAMES.billingReconcileCompletedAgeSeconds, 0, 'Seconds');
    return report('not_migrated', null);
  }

  // 한 틱 = 전용 연결 하나(N5) — 잠금·작업·해제가 같은 세션이다.
  const session = await deps.pool.connect();
  let discard = false;
  try {
    // 단일 실행(코드 리뷰 M10). 예약 동시성 1 이라 평소에는 늘 잡힌다 — 운영자 수동 호출·재배포 겹침·테스트 병렬이 겹칠 때만 진다.
    if (!(await tryLockReconcileRun(session))) return report('concurrent', null);
    try {
      return await reconcileTick(deps, session, provider, options, counts, report, () => {
        restartApplied = restartRequested;
      });
    } finally {
      const released = await unlockReconcileRun(session).catch(() => false);
      if (!released) {
        // 쥔 잠금을 못 풀었다 — 이 연결을 풀에 돌려주지 않는다(세션이 닫히며 잠금이 풀린다). 다음 틱은 새 연결로 잡는다.
        discard = true;
        log('warn', 'billing.reconcile_lock_release_missed', { route_id: BILLING_SYNC_ROUTE_ID, outcome: 'lock_not_held' });
      }
    }
  } catch (error) {
    // 연결 오류(08xxx)면 그 연결을 다시 쓰지 않는다.
    if (sqlStateOf(error)?.startsWith('08') === true) discard = true;
    throw error;
  } finally {
    await emitCompletedAge(deps, session);
    session.release(discard);
  }
}

/** 마지막 완료의 나이를 낸다(틱의 결말과 무관 — 읽기 실패면 내지 않는다: 결측 = 위반). */
async function emitCompletedAge(deps: BillingSyncDependencies, session: PoolClient): Promise<void> {
  try {
    const state = await loadReconcileState(session);
    emitMetric(METRIC_NAMES.billingReconcileCompletedAgeSeconds, reconcileCompletedAgeSeconds(state, deps.now()), 'Seconds');
  } catch {
    // 연결이 죽었다 — 방출하지 않는다(틱 실패는 billing.sync_failed 가 알리고, 이어지면 stale 알람이 결측으로 운다).
  }
}

/** 잠금을 쥔 뒤의 한 틱 — 판 결정 · 세 단계 · 커서 저장(CAS). */
async function reconcileTick(
  deps: BillingSyncDependencies,
  session: PoolClient,
  provider: BillingProviderApi,
  options: ReconcileOptions,
  counts: { pages: number; subscriptions: number; organizations: number; applied: number; missed: number },
  report: (status: ReconcileStatus, phase: ReconcileReport['phase']) => ReconcileReport,
  onRestarted: () => void,
): Promise<ReconcileReport> {
  const clock = options.clock ?? realClock();
  const budget = options.budgetMs ?? RECONCILE_TICK_BUDGET_MS;
  const within = (): boolean => clock.elapsedMs() < budget;

  const stored = await loadReconcileState(session);
  const now = deps.now();
  let state: State;
  if (stored === null || options.restart === true) {
    state = freshRun(now, stored?.completed_at ?? null);
  } else if (stored.phase === 'done') {
    if (stored.completed_at !== null && now.getTime() - stored.completed_at.getTime() < RECONCILE_INTERVAL_MS) return report('idle', 'done');
    state = freshRun(now, stored.completed_at);
  } else {
    state = stateOf(stored);
  }
  // CAS 의 기대값 — 이 틱이 마지막으로 읽었거나 쓴 판. 다른 실행이 그 사이 판을 바꿨으면 저장이 지고 틱은 `concurrent` 로 멈춘다.
  let owned: string | null = stored?.run_id ?? null;
  const save = async (next: State): Promise<void> => {
    state = { ...next, updated_at: deps.now() };
    if (!(await saveReconcileState(session, state, owned))) throw new ReconcileSupersededError();
    owned = state.run_id;
  };
  try {
    await save(state);
  } catch (error) {
    if (error instanceof ReconcileSupersededError) return report('concurrent', state.phase);
    throw error;
  }
  if (options.restart === true) onRestarted();

  try {
    // --- list ---
    while (state.phase === 'list' && within()) {
      if (counts.pages >= RECONCILE_MAX_PAGES_PER_TICK) return report('progress', state.phase);
      if (counts.pages > 0) await clock.sleep(RECONCILE_PAGE_PAUSE_MS);
      const page = await provider.listSubscriptions({ statuses: RECONCILE_LIST_STATUSES, after: state.paddle_cursor });
      counts.pages += 1;
      counts.subscriptions += page.items.length;
      // 정보 메트릭 — 페이지마다 낸다(판의 합 = 활성 구독 수; 틱이 여러 번이어도 빠지지 않는다).
      emitMetric(METRIC_NAMES.billingActiveSubscriptions, page.items.filter((sub) => sub.status === 'active' || sub.status === 'trialing').length, 'Count');
      const { applied, missed } = await applyListed(deps, session, page.items, true);
      counts.applied += applied;
      counts.missed += missed;
      for (let i = 0; i < missed; i += 1) countMetric(METRIC_NAMES.billingWebhookMissed);
      await save(page.next === null ? { ...state, phase: 'stale', paddle_cursor: null } : { ...state, paddle_cursor: page.next });
    }
    // --- stale --- (커서 = 마지막으로 다시 읽은 구독 id)
    while (state.phase === 'stale' && within()) {
      const cursor = state.paddle_cursor;
      const ids = (await listNonTerminalSubscriptionIds(session, deps.environment)).filter((id) => cursor === null || id > cursor).slice(0, RECONCILE_STALE_CHUNK);
      const last = ids[ids.length - 1];
      if (last === undefined) {
        await save({ ...state, phase: 'orgs', paddle_cursor: null, org_cursor: null });
        break;
      }
      // 한 묶음(id ≤ 50)이 여러 페이지로 올 수 있다 — `next` 를 따른다(버리면 그 묶음 뒤쪽의 해지가 조용히 빠진다). 단 `RECONCILE_STALE_MAX_PAGES`
      // 까지(N-4) — 넘으면 공급자 이상이다: 메트릭·로그 뒤 그 묶음을 넘기고 이 틱을 끝낸다(같은 묶음을 매 틱 끝없이 돌지 않게).
      let after: string | null = null;
      let pages = 0;
      do {
        const page = await provider.listSubscriptions({ ids, statuses: RECONCILE_STALE_STATUSES, after });
        pages += 1;
        counts.subscriptions += page.items.length;
        const { applied } = await applyListed(deps, session, page.items, false);
        counts.applied += applied;
        after = page.next;
      } while (after !== null && pages < RECONCILE_STALE_MAX_PAGES);
      await save({ ...state, paddle_cursor: last });
      if (after !== null) {
        countMetric(METRIC_NAMES.billingReconcileSkipped);
        log('warn', 'billing.reconcile_stale_pages', { route_id: BILLING_SYNC_ROUTE_ID, outcome: 'skipped', detail: JSON.stringify({ pages, ids: ids.length }) });
        return report('progress', state.phase);
      }
    }
    // --- orgs --- (조직마다 짧은 트랜잭션 · 실패한 조직은 건너뛴다 · 운영자 행 불변)
    while (state.phase === 'orgs' && within()) {
      const orgs = await listReconcileOrganizationIds(session, deps.environment, state.org_cursor, RECONCILE_ORG_CHUNK);
      for (const organizationId of orgs) {
        if (!organizationAllowed(deps, organizationId)) continue;
        await reconcileOrganization(deps, session, organizationId, counts);
      }
      counts.organizations += orgs.length;
      const last = orgs[orgs.length - 1];
      if (orgs.length < RECONCILE_ORG_CHUNK || last === undefined) {
        await save({ ...state, phase: 'done', org_cursor: null, completed_at: deps.now() });
        return report('completed', 'done');
      }
      await save({ ...state, org_cursor: last });
    }
    return report('progress', state.phase);
  } catch (error) {
    if (error instanceof ReconcileSupersededError) return report('concurrent', state.phase);
    if (error instanceof ProviderAuthError) {
      countMetric(METRIC_NAMES.billingProviderAuthFailed);
      return report('auth_failed', state.phase);
    }
    if (error instanceof ProviderRateLimitedError) return report('rate_limited', state.phase);
    countMetric(METRIC_NAMES.billingSyncFailed);
    log('error', 'billing.reconcile_failed', {
      route_id: BILLING_SYNC_ROUTE_ID,
      outcome: state.phase,
      error_kind: error instanceof Error ? error.name : typeof error,
      error_code: error instanceof BillingProviderError ? error.code : null,
    });
    throw error;
  }
}
