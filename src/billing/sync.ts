/**
 * src/billing/sync.ts — **결제 이벤트 → 재조회 → 조직 재계산**(WP-2 sync λ, 계획 §3-1 ①–⑤ · §3-2 · §3-4 · §3-6).
 *
 * 큐 메시지는 **신호**다(`parseBillingQueueMessage` — 진단 칸은 타입에서 이미 벗겨졌다). 처리 순서:
 *   ① 원장 `billing_events` 에 좌표를 적는다(짧은 트랜잭션) — 이미 done·ignored 면 끝(`duplicate`).
 *   ② **트랜잭션 밖에서** Paddle 재조회: 구독 id 가 있으면 `GET /subscriptions/{id}`, 거래 이벤트면 `GET /transactions/{id}` → 그 구독.
 *      404 → `ignored(not_found)` · 401/403 → `failed(provider_error)` + `billing.provider_auth_failed` · 그 밖 → `failed(provider_error)`(SQS 재시도).
 *   ③ 처음 보는 구독이면 결속: 원 거래(거래 이벤트면 그 거래 — 그것이 우리 거래가 아니면 그 구독의 가장 이른 거래로 한 번 더(L-3), 구독 이벤트면
 *      가장 이른 거래)가 **우리 `billing_checkouts` 에 (이 환경으로)** 있고 그 조직 = 구독 `custom_data` 조직일 때만. 아니면 알람
 *      `billing.unbound_subscription`(요금제 무변 — 공개 클라이언트 토큰으로 만든 결제 차단): 원 거래가 공급자에 있는데 우리 표에 없는 것이 확정되고
 *      만든 지 `UNBOUND_SETTLE_MS`(30분)가 지났으면 `ignored(unbound_subscription)`(다시 해도 같다 — 보안 검증 L-2), 그 안이면 `failed`(재시도).
 *   ④ 샌드박스면 조직이 `BILLING_SANDBOX_ORG_ALLOWLIST` 안일 때만 적용(아니면 `ignored(sandbox_not_allowed)`). 환경이 다르면 `ignored(environment_mismatch)`.
 *   ⑤ 한 트랜잭션: 구독 결속/갱신(앞으로만) → 조직 잠금 → 결정 함수 → 바뀌면 v+1 + 감사(`provider:paddle`, `provider_event_id`) → 원장 done.
 *
 * `past_due_since` = min(실패한 거래 시각, 구독의 `current_billing_period.starts_at`, 이미 적힌 값) — 재조회 결과 기준이라 관측이 늦어도 유예가 늘지 않는다.
 * `active` 로 돌아오면 NULL(§3-4).
 *
 * 한 고객이 여러 조직에 결속되면(Paddle 은 같은 이메일에 같은 고객을 준다 — H-1) 결속은 그대로 하고 `billing.customer_shared` + 식별자 없는 로그.
 * 결정 시각은 DB 의 `now()` 다(출처-롤 트리거가 같은 시계로 "지금 적용 한도" 를 본다 — L-1).
 *
 * 오류: 공급자 오류만 `failed(provider_error)`, DB 오류·모르는 예외는 `failed(internal_error)` + 로그 `error_code`(SQLSTATE — M-6).
 *
 * 로그에는 이벤트 id · 종류 · 결과 코드만 싣는다(구독·고객 id · URL · 금액 없음). 메트릭 이름은 `METRIC_NAMES.billing*`(차원 없음).
 * 이 파일의 `recomputeOrganization`·`subscriptionSnapshot` 은 reconcile(`reconcile.ts`)과 운영자 `sync-org` 도 쓴다.
 */

import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../db/client';
import {
  bindCustomer,
  bindSubscription,
  findCheckout,
  finishBillingEvent,
  loadOrgSubscriptions,
  loadSubscription,
  recordBillingEvent,
  upsertSubscription,
  type BillingEventFinish,
  type SubscriptionSnapshot,
} from '../db/repositories/billing';
import { loadOrgEntitlementsControlRow, lockOrgEntitlements, writeEntitlementVersion } from '../db/repositories/entitlements-write';
import type { BillingSubscriptionRow } from '../db/schema';
import { countMetric, METRIC_NAMES } from '../observability/metrics';
import { log } from '../observability/logger';
import { BILLING_PROVIDERS, type BillingEventReasonCode, type PaddleEnvironment } from './constants';
import { ENTITLEMENTS_TABLE_MISSING } from './plans';
import {
  BillingProviderError,
  ProviderAuthError,
  ProviderNotFoundError,
  type BillingProviderApi,
  type NormalizedSubscription,
  type NormalizedTransaction,
} from './provider';
import { parseBillingQueueMessage, type BillingSyncMessage } from './queue-message';
import { decideProviderEntitlement, type DecisionTrigger, type EntitlementDecision } from './sync-decision';

export const BILLING_SYNC_ROUTE_ID = 'billing_sync';
/** 감사 행위자 — `billing_audit.actor`. 투명성 잎에는 싣지 않는다. */
export const BILLING_SYNC_ACTOR = 'provider:paddle';

/**
 * 메시지 하나의 결말(SQS 쪽). `failed`·`deferred` 만 재전달한다 — 공급자 오류·결속 실패(결속 거래가 공급자 목록에 늦게 보일 수 있다)는 다시 해 볼
 * 가치가 있고, `deferred`(결제 표가 아직 없다 — 마이그레이션 전)는 표가 생긴 뒤 처리하려고 돌려보낸다. 재전달에는 끝이 있다: 큐의 최대 수신
 * 횟수(10회)를 넘기면 **약 1시간 뒤 DLQ 로 가고**(알람 `atmark-billing-dlq-depth`), 그 뒤에는 운영자가 redrive 해야 처리된다(런북 billing.md).
 * `unparsable`·`duplicate`·`ignored`·`done` 은 다시 해도 같다.
 */
export type BillingSyncOutcome = 'done' | 'ignored' | 'duplicate' | 'failed' | 'unparsable' | 'deferred';

/**
 * 결제 표(202609250400)가 있는가. 배포 순서는 "새 Compute → bootstrap-roles → migrate(0400)" 라 새 sync 코드가 표보다 먼저 돈다 — 그동안은
 * **아무것도 쓰지 않는다**: 이벤트는 `deferred`(SQS 가 다시 준다 — 마이그레이션이 약 1시간(수신 10회) 안에 끝나지 않으면 DLQ 로 가고(알람) redrive 가 필요하다),
 * reconcile 은 알람 없이 건너뛴다.
 */
export async function billingTablesPresent(db: Queryable): Promise<boolean> {
  const result = await db.query<{ ok: boolean }>(
    `SELECT to_regclass('public.billing_events') IS NOT NULL AND to_regclass('public.billing_subscriptions') IS NOT NULL
        AND to_regclass('public.billing_reconcile_state') IS NOT NULL AS ok`,
  );
  return result.rows[0]?.ok === true;
}

/** sync λ 의 의존성 — 조립은 `src/runtime/billing-composition.ts`(SQS·reconcile 이 같은 것을 쓴다). */
export interface BillingSyncDependencies {
  /** `atmark_billing` 롤 풀(최대 1). */
  readonly pool: Pool;
  /** 이 λ 의 Paddle 환경 — 메시지·재조회 결과·표 행의 `environment` 가 이것과 다르면 적용하지 않는다. */
  readonly environment: PaddleEnvironment;
  /** 결제 스위치 — 꺼져 있으면 reconcile 은 건너뛴다(이벤트는 그대로 처리한다: 켜기 전에 들어온 결제도 잃지 않게). */
  readonly enabled: boolean;
  /** Paddle 어댑터. **sync 키가 자리표시면 null**(설정 전). */
  readonly provider: BillingProviderApi | null;
  /** 샌드박스에서 적용을 허용하는 조직(`BILLING_SANDBOX_ORG_ALLOWLIST`) — 운영에서는 보지 않는다. */
  readonly sandboxAllowlist: readonly string[];
  readonly now: () => Date;
}

/** 이벤트 처리가 쓰는 부분(스위치는 reconcile 만 본다). */
export type BillingSyncDeps = Omit<BillingSyncDependencies, 'enabled'>;

const PROVIDER = BILLING_PROVIDERS[0];

/**
 * 결속 실패를 "확정" 으로 보는 거래 나이(보안 검증 L-2). 원 거래가 공급자에 있는데 우리 `billing_checkouts` 에 없고 만든 지 이보다 오래면 다시 해도
 * 결속되지 않는다 — `ignored(unbound_subscription)` 로 끝낸다(재시도가 DLQ 를 채우지 않게). 그 안이면 admin 의 INSERT(③)가 아직 커밋 전일 수 있어
 * `failed` 로 다시 받는다. 알람(`billing.unbound_subscription`)은 둘 다 낸다 — 돈을 받았을 수 있다.
 */
export const UNBOUND_SETTLE_MS = 30 * 60 * 1000;

/** 결속·적용 전에 멈추는 이유(원장 결말 + SQS 결말). */
class SyncStop extends Error {
  constructor(
    readonly finish: BillingEventFinish,
    readonly outcome: BillingSyncOutcome,
  ) {
    super(finish.code ?? finish.status);
    this.name = 'SyncStop';
  }
}

function ignored(code: BillingEventReasonCode): SyncStop {
  return new SyncStop({ status: 'ignored', code }, 'ignored');
}

function failed(code: BillingEventReasonCode): SyncStop {
  return new SyncStop({ status: 'failed', code }, 'failed');
}

/** 공급자 오류 → 멈춤 + 메트릭(404 = 없음 · 401/403 = 키 알람 · 그 밖 = 재시도). 모르는 예외는 그대로 던진다. */
function providerStop(error: unknown): SyncStop {
  if (error instanceof ProviderNotFoundError) {
    countMetric(METRIC_NAMES.billingProviderNotFound);
    return ignored('not_found');
  }
  if (error instanceof ProviderAuthError) {
    countMetric(METRIC_NAMES.billingProviderAuthFailed);
    return failed('provider_error');
  }
  if (error instanceof BillingProviderError) return failed('provider_error');
  throw error;
}

/** Postgres 오류의 SQLSTATE(다섯 글자) — 아니면 null. 로그에는 이 코드만 싣는다(메시지에는 값이 섞일 수 있다). */
export function sqlStateOf(error: unknown): string | null {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/** 모르는 예외(DB 오류 포함) → `failed(internal_error)` + 로그(`error_kind` · SQLSTATE). 공급자 오류는 `providerStop` 이 먼저 갈랐다. */
function internalStop(error: unknown, message: BillingSyncMessage): SyncStop {
  log('error', 'billing.sync_threw', {
    route_id: BILLING_SYNC_ROUTE_ID,
    trace_id: message.eventId,
    error_kind: error instanceof Error ? error.name : typeof error,
    error_code: sqlStateOf(error),
  });
  return failed('internal_error');
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw providerStop(error);
  }
}

function earliest(dates: ReadonlyArray<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const date of dates) if (date instanceof Date && (best === null || date.getTime() < best.getTime())) best = date;
  return best;
}

/**
 * 재조회한 구독 → 표에 쓸 스냅숏. `past_due` 면 유예 시작 = min(실패 거래 시각, 기간 시작, 이미 적힌 값), 아니면 NULL.
 * 셋 다 없으면(기간 없는 past_due — 관측한 적 없는 모양) 지금 시각 — 올리는 쪽이 아니라 유예를 세기 시작하는 쪽이다.
 */
export function subscriptionSnapshot(
  sub: NormalizedSubscription,
  existing: Pick<BillingSubscriptionRow, 'status' | 'past_due_since'> | null,
  failedAt: Date | null,
  now: Date,
): SubscriptionSnapshot {
  const carried = existing?.status === 'past_due' ? existing.past_due_since : null;
  const pastDueSince = sub.status === 'past_due' ? (earliest([failedAt, sub.currentPeriodStart, carried]) ?? now) : null;
  return {
    provider: sub.provider,
    providerSubscriptionId: sub.id,
    environment: sub.environment,
    providerCustomerId: sub.customerId,
    status: sub.status,
    planCode: sub.planCode,
    priceId: sub.priceId,
    currentPeriodEnd: sub.currentPeriodEnd,
    scheduledChangeAction: sub.scheduledChange?.action ?? null,
    scheduledChangeAt: sub.scheduledChange?.effectiveAt ?? null,
    pastDueSince,
    providerUpdatedAt: sub.updatedAt,
  };
}

/** 조직 재계산의 결과(메트릭은 호출자가 커밋 뒤에 낸다). */
export interface RecomputeResult {
  readonly decision: EntitlementDecision;
  readonly changed: boolean;
}

/**
 * **조직 재계산 — 호출자의 트랜잭션 안에서.** 조직 잠금 → 지금 행 → 이 환경의 결속된 구독 전체 → 결정 함수 → 쓰기(바뀔 때만).
 * 쓰기는 늘 provider 출처 · 제어 칸 false(`atmark_billing` 은 그것만 쓸 수 있다 — DB 트리거가 다시 본다).
 */
export async function recomputeOrganization(
  db: Queryable,
  deps: Pick<BillingSyncDeps, 'environment'>,
  organizationId: string,
  trigger: DecisionTrigger,
  providerEventId: string | null,
): Promise<RecomputeResult> {
  await lockOrgEntitlements(db, organizationId);
  const row = await loadOrgEntitlementsControlRow(db, organizationId);
  if (row === ENTITLEMENTS_TABLE_MISSING) throw new Error('org_entitlements 표가 없다 — 마이그레이션 202609250300 을 먼저 적용한다.');
  const subscriptions = await loadOrgSubscriptions(db, organizationId, deps.environment);
  const decision = decideProviderEntitlement({
    subscriptions: subscriptions.map((sub) => ({ status: sub.status, planCode: sub.plan_code, pastDueSince: sub.past_due_since })),
    row,
    now: await databaseNow(db),
    trigger,
  });
  if (decision.kind === 'noop') return { decision, changed: false };
  const written = await writeEntitlementVersion(db, {
    organizationId,
    plan: decision.write.planCode,
    limits: decision.write.limits,
    graceUntil: decision.write.graceUntil,
    source: 'provider',
    cause: decision.write.cause,
    providerOverrideAllowed: false,
    actor: BILLING_SYNC_ACTOR,
    providerEventId,
    note: null,
  });
  return { decision, changed: written.changed };
}

/**
 * 결정 시각 — DB 의 `now()`(L-1). 출처-롤 트리거가 "지금 적용 한도"(유예 끝났는가)를 같은 시계로 본다 — λ 시계를 쓰면 유예 경계에서 결정 함수는
 * 쓰기를 내고 트리거는 거부하는 틈이 생긴다. 트랜잭션 안이면 그 트랜잭션의 시작 시각이라 트리거의 `now()` 와 정확히 같다.
 */
export async function databaseNow(db: Queryable): Promise<Date> {
  const result = await db.query<{ now: Date }>('SELECT now() AS now');
  const now = result.rows[0]?.now;
  if (!(now instanceof Date)) throw new Error('SELECT now() 가 시각을 돌려주지 않았다.');
  return now;
}

/** 재계산 결과 → 메트릭(커밋 뒤). */
export function reportRecompute(result: RecomputeResult): void {
  if (result.changed) {
    countMetric(METRIC_NAMES.billingSyncApplied);
    return;
  }
  countMetric(METRIC_NAMES.billingSyncNoop);
  if (result.decision.kind !== 'noop') return;
  if (result.decision.reason === 'unknown_price') countMetric(METRIC_NAMES.billingUnknownPrice);
  if (result.decision.reason === 'operator_row_held') countMetric(METRIC_NAMES.billingEntitlementHeld);
}

/** 이 환경에서 이 조직에 적용해도 되는가 — 샌드박스는 허용 조직만(빈 목록 = 0). */
export function organizationAllowed(deps: Pick<BillingSyncDeps, 'environment' | 'sandboxAllowlist'>, organizationId: string): boolean {
  return deps.environment !== 'sandbox' || deps.sandboxAllowlist.includes(organizationId);
}

interface Resolved {
  readonly subscription: NormalizedSubscription;
  /** 이벤트의 거래(있으면 재조회한 것) — 결속 후보 · 실패 시각. */
  readonly transaction: NormalizedTransaction | null;
}

/** ② 재조회 — 트랜잭션 밖. 거래에 구독이 없으면(일회성·아직 구독 전) null. */
async function resolve(provider: BillingProviderApi, message: BillingSyncMessage): Promise<Resolved | null> {
  let transaction: NormalizedTransaction | null = null;
  if (message.transactionId !== null) {
    const transactionId = message.transactionId;
    transaction = await call(() => provider.fetchTransaction(transactionId));
  }
  const subscriptionId = message.subscriptionId ?? transaction?.subscriptionId ?? null;
  if (subscriptionId === null) return null;
  // 봉투의 구독과 거래의 구독이 다르면 거래는 이 구독의 근거가 아니다.
  if (transaction !== null && transaction.subscriptionId !== subscriptionId) transaction = null;
  const subscription = await call(() => provider.fetchSubscription(subscriptionId));
  return { subscription, transaction };
}

/**
 * ③ 결속 근거 — 원 거래 id 와 조직. 거래 이벤트의 거래가 우리 거래가 아니면 그 구독의 가장 이른 거래(원 거래)로 한 번 더 본다(L-3 — 갱신·결제
 * 실패 거래 이벤트가 결속보다 먼저 와도 결속된다). 우리 거래가 아니면 `unbound_subscription`(나이에 따라 ignored/failed — `UNBOUND_SETTLE_MS`).
 */
async function bindingOf(deps: BillingSyncDeps, provider: BillingProviderApi, resolved: Resolved): Promise<{ organizationId: string; originTransactionId: string }> {
  const { subscription } = resolved;
  let origin: NormalizedTransaction | null = resolved.transaction;
  let checkout = origin === null ? null : await findCheckout(deps.pool, origin.id, deps.environment);
  if (checkout === null) {
    const transactions = await call(() => provider.listTransactionsBySubscription(subscription.id));
    const earliest = transactions[0] ?? null;
    if (earliest !== null && earliest.id !== origin?.id) {
      origin = earliest;
      checkout = await findCheckout(deps.pool, earliest.id, deps.environment);
    }
  }
  if (origin !== null && checkout !== null && checkout.organization_id === subscription.customDataOrganizationId) {
    return { organizationId: checkout.organization_id, originTransactionId: origin.id };
  }
  countMetric(METRIC_NAMES.billingUnboundSubscription);
  // 원 거래가 공급자에 있고 우리 표에 없는 것이 확정 + 충분히 오래 → 다시 해도 같다(L-2). 조직이 맞지 않는 경우·원 거래를 못 찾은 경우는 재시도.
  if (origin !== null && checkout === null && deps.now().getTime() - origin.createdAt.getTime() > UNBOUND_SETTLE_MS) throw ignored('unbound_subscription');
  throw failed('unbound_subscription');
}

async function finish(pool: Pool, eventId: string, result: BillingEventFinish): Promise<void> {
  await finishBillingEvent(pool, PROVIDER, eventId, result);
}

function logOutcome(message: BillingSyncMessage, outcome: BillingSyncOutcome, code: string | null): void {
  log(outcome === 'failed' ? 'warn' : 'info', 'billing.sync_event', {
    route_id: BILLING_SYNC_ROUTE_ID,
    trace_id: message.eventId,
    detail: message.eventType,
    outcome,
    error_code: code,
  });
}

/** 파싱한 메시지 하나(① → ⑤). 던지지 않는다 — 모르는 예외(DB 오류 포함)는 `failed(internal_error)` + `billing.sync_failed`(원장도 failed). */
export async function processBillingMessage(deps: BillingSyncDeps, message: BillingSyncMessage): Promise<BillingSyncOutcome> {
  const { pool } = deps;
  if (!(await billingTablesPresent(pool))) {
    logOutcome(message, 'deferred', 'not_migrated');
    return 'deferred';
  }
  // ① 원장.
  const recorded = await withTransaction(pool, (client) =>
    recordBillingEvent(client, {
      provider: message.provider,
      eventId: message.eventId,
      eventType: message.eventType,
      occurredAt: new Date(message.occurredAt),
      notificationId: message.notificationId,
      environment: message.environment,
      payloadSha256: message.payloadSha256,
      subscriptionId: message.subscriptionId,
      transactionId: message.transactionId,
    }),
  );
  if (recorded === 'duplicate') {
    logOutcome(message, 'duplicate', null);
    return 'duplicate';
  }

  try {
    if (message.environment !== deps.environment) throw ignored('environment_mismatch');
    const provider = deps.provider;
    if (provider === null) {
      // 스위치와 무관하게 이벤트는 받았는데 키가 자리표시 — 설정 누락이다(알람). SQS 재시도 · DLQ 가 메시지를 지킨다.
      countMetric(METRIC_NAMES.billingProviderAuthFailed);
      throw failed('provider_error');
    }
    // 고객 이벤트(ADR-0014 결정 8 · M3b) — 그 고객에 결속된 조직의 청구 이메일 표시만 다시 판정한다(구독 · 요금제 재계산 없음).
    if (message.eventType === 'customer.created' || message.eventType === 'customer.updated') {
      const customerId = message.customerId;
      if (customerId !== null && provider.fetchCustomerEmail !== undefined) {
        const email = await fetchCustomerEmailOrStop(provider.fetchCustomerEmail.bind(provider), customerId);
        await withTransaction(pool, (client) => markBillingEmailIsAgent(client, deps.environment, customerId, email));
      }
      await finish(pool, message.eventId, { status: 'done', code: null });
      logOutcome(message, 'done', 'customer');
      return 'done';
    }
    // ② 재조회(트랜잭션 밖).
    const resolved = await resolve(provider, message);
    if (resolved === null) {
      await finish(pool, message.eventId, { status: 'done', code: null });
      logOutcome(message, 'done', 'no_subscription');
      return 'done';
    }
    const { subscription } = resolved;
    if (subscription.environment !== deps.environment) throw ignored('environment_mismatch');

    // ③ 결속(처음 보는 구독만) — 조회는 트랜잭션 밖.
    const existing = await loadSubscription(pool, PROVIDER, subscription.id);
    if (existing !== null && existing.environment !== deps.environment) throw ignored('environment_mismatch');
    const binding = existing === null ? await bindingOf(deps, provider, resolved) : null;
    const organizationId = existing?.organization_id ?? binding?.organizationId ?? '';

    // ④ 샌드박스 격리.
    if (!organizationAllowed(deps, organizationId)) throw ignored('sandbox_not_allowed');

    const failedAt =
      resolved.transaction !== null && (message.eventType === 'transaction.payment_failed' || message.eventType === 'transaction.past_due')
        ? resolved.transaction.createdAt
        : null;
    const snapshot = subscriptionSnapshot(subscription, existing, failedAt, deps.now());
    // 청구 이메일이 에이전트 주소인가(ADR-0014 결정 8) — 이메일은 트랜잭션 밖에서 한 번 읽고 ⑤ 안에서 DB 판정 함수에 넘긴 뒤 버린다. 이 조회의 실패는
    // 요금제 동기화를 막지 않는다(표시는 다음 이벤트 · 고객 이벤트가 고친다).
    let customerEmail: string | null = null;
    if (provider.fetchCustomerEmail !== undefined) {
      try {
        customerEmail = await provider.fetchCustomerEmail(subscription.customerId);
      } catch (error) {
        log('warn', 'billing.customer_email_unavailable', {
          route_id: BILLING_SYNC_ROUTE_ID,
          trace_id: message.eventId,
          error_kind: error instanceof Error ? error.name : typeof error,
        });
      }
    }

    // ⑤ 한 트랜잭션.
    const { result, stale, shared } = await withTransaction(pool, async (client) => {
      let written: 'bound' | 'updated' | 'stale' | 'missing' | 'exists';
      if (binding !== null) {
        written = await bindSubscription(client, snapshot, binding.organizationId, binding.originTransactionId);
        if (written === 'exists') written = await upsertSubscription(client, snapshot);
      } else {
        written = await upsertSubscription(client, snapshot);
      }
      // 한 고객이 여러 조직에 묶일 수 있다(H-1) — 결속은 하고 공유를 알린다(포털·체크아웃이 공유 고객을 따로 다룬다).
      const customer = await bindCustomer(client, organizationId, PROVIDER, deps.environment, subscription.customerId);
      if (customerEmail !== null) await markBillingEmailIsAgent(client, deps.environment, subscription.customerId, customerEmail);
      const recomputed = await recomputeOrganization(client, deps, organizationId, 'event', message.eventId);
      await finishBillingEvent(client, PROVIDER, message.eventId, { status: 'done', code: null });
      return { result: recomputed, stale: written === 'stale', shared: customer === 'shared' };
    });
    if (stale) countMetric(METRIC_NAMES.billingSyncStale);
    if (shared) {
      countMetric(METRIC_NAMES.billingCustomerShared);
      log('warn', 'billing.customer_shared', { route_id: BILLING_SYNC_ROUTE_ID, trace_id: message.eventId, outcome: 'shared' });
    }
    reportRecompute(result);
    logOutcome(message, 'done', result.decision.kind === 'noop' ? result.decision.reason : null);
    return 'done';
  } catch (error) {
    const stop = error instanceof SyncStop ? error : internalStop(error, message);
    await finish(pool, message.eventId, stop.finish);
    if (stop.outcome === 'failed') countMetric(METRIC_NAMES.billingSyncFailed);
    logOutcome(message, stop.outcome, stop.finish.code);
    return stop.outcome;
  }
}

/**
 * `organizations.billing_email_is_agent` — 그 공급자 고객에 결속된 조직(들)의 표시를 DB 판정(`atmark_is_agent_mail_identity` — 해시로 에이전트 claim
 * 이 있는지만)으로 다시 쓴다. 이메일 평문은 매개변수로만 지나가고 어디에도 저장되지 않는다. 켜지면 포털 세션이 409 `billing_email_is_agent` 다.
 */
export async function markBillingEmailIsAgent(db: Queryable, environment: PaddleEnvironment, customerId: string, email: string): Promise<void> {
  await db.query(
    `UPDATE organizations SET billing_email_is_agent = atmark_is_agent_mail_identity($3)
      WHERE id IN (SELECT c.organization_id FROM billing_customers c WHERE c.provider = $1 AND c.environment = $2 AND c.provider_customer_id = $4)`,
    [PROVIDER, environment, email, customerId],
  );
}

/** 고객 이벤트의 이메일 — 없으면(404) 무시할 이벤트, 그 밖의 공급자 오류는 재시도(`failed`). */
async function fetchCustomerEmailOrStop(lookup: (customerId: string) => Promise<string>, customerId: string): Promise<string> {
  try {
    return await lookup(customerId);
  } catch (error) {
    if (error instanceof ProviderNotFoundError) throw ignored('not_found');
    if (error instanceof ProviderAuthError) countMetric(METRIC_NAMES.billingProviderAuthFailed);
    throw failed('provider_error');
  }
}

/** SQS 레코드 본문 하나. 모양이 아니면 버린다(`unparsable` — 재전달해도 같다) + `billing.sync_failed`. */
export async function consumeBillingRecord(deps: BillingSyncDeps, body: string): Promise<BillingSyncOutcome> {
  const message = parseBillingQueueMessage(body);
  if (message === null) {
    countMetric(METRIC_NAMES.billingSyncFailed);
    log('error', 'billing.sync_event', { route_id: BILLING_SYNC_ROUTE_ID, outcome: 'unparsable' });
    return 'unparsable';
  }
  return processBillingMessage(deps, message);
}

/** 운영자 수동 `{"action":"sync-org","organizationId":…}` 의 결과. */
export type SyncOrganizationOutcome = 'applied' | 'noop' | 'not_allowed' | 'unconfigured' | 'not_migrated';

/**
 * 운영자 수동 재계산(계기 `operator_sync` — `admin:plan --release-to-provider` 로 넘긴 행에 적용된다). 그 조직의 결속된 구독을 재조회해(트랜잭션 밖)
 * 갱신한 뒤 한 트랜잭션에서 재계산한다. 404 인 구독은 그대로 둔다.
 */
export async function syncOrganization(deps: BillingSyncDeps, organizationId: string): Promise<SyncOrganizationOutcome> {
  if (!organizationAllowed(deps, organizationId)) return 'not_allowed';
  if (!(await billingTablesPresent(deps.pool))) return 'not_migrated';
  const provider = deps.provider;
  if (provider === null) {
    countMetric(METRIC_NAMES.billingProviderAuthFailed);
    return 'unconfigured';
  }
  const rows = await loadOrgSubscriptions(deps.pool, organizationId, deps.environment);
  const fetched: NormalizedSubscription[] = [];
  for (const row of rows) {
    try {
      fetched.push(await provider.fetchSubscription(row.provider_subscription_id));
    } catch (error) {
      if (error instanceof ProviderNotFoundError) {
        countMetric(METRIC_NAMES.billingProviderNotFound);
        continue;
      }
      if (error instanceof ProviderAuthError) countMetric(METRIC_NAMES.billingProviderAuthFailed);
      throw error;
    }
  }
  const result = await withTransaction(deps.pool, async (client) => {
    for (const sub of fetched) {
      const existing = rows.find((row) => row.provider_subscription_id === sub.id) ?? null;
      await upsertSubscription(client, subscriptionSnapshot(sub, existing, null, deps.now()));
    }
    return recomputeOrganization(client, deps, organizationId, 'operator_sync', null);
  });
  reportRecompute(result);
  return result.changed ? 'applied' : 'noop';
}
