/**
 * src/db/repositories/billing.ts — 결제 공급자 표 다섯의 읽기·쓰기(202609250400, ADR-0012 · 계획 `.omc/plans/wp2-paddle-adapter.md` §6-A).
 *
 * 두 롤이 이 파일을 쓴다 — 함수마다 어느 롤로 부르는지 적는다. 롤의 컬럼 단위 권한 밖 칸은 문장에 넣지 않는다(허용 목록
 * `RESTRICTED_ROLE_GRANTS`):
 *   - **sync 쪽**(`atmark_billing`, billing-sync λ): 이벤트 원장 · 체크아웃 조회·완료 · 구독 결속·갱신 · 고객 결속 · reconcile 커서.
 *   - **admin 쪽**(`atmark_admin`, 콘솔): 체크아웃 잠금·재사용·기록·superseded·하루 계수 · 결제 개요 · 고객 공유 판단(`loadOrgCustomer` ·
 *     `customerHasOtherOrgSubscription` — sync 쪽도 부를 수 있다).
 * 엔타이틀먼트 쓰기는 `entitlements-write.ts` 다.
 *
 * 공급자 호출은 여기 없다 — Paddle 은 DB 트랜잭션 **밖**에서만 부른다(계획 §3-1). 이 파일의 함수는 모두 호출자의 트랜잭션·연결에서 돈다.
 * 순서·종단 규칙(앞으로만 · canceled 종단 · 이벤트 종단 · 결속 FK)은 DB 트리거가 다시 본다 — 여기의 조건은 트리거 예외 대신 결과 코드를
 * 돌려주려는 것이다.
 */

import type { PoolClient } from 'pg';

import type { BillingEventReasonCode, BillingEventType, BillingProvider, PaddleEnvironment } from '../../billing/constants';
import type { Queryable } from '../client';
import type {
  BillingCheckoutRow,
  BillingPlanCode,
  BillingReconcileStateRow,
  BillingScheduledChangeAction,
  BillingSubscriptionRow,
  BillingSubscriptionStatus,
} from '../schema';
import { selectRow, selectRows } from './rows';

/** 같은 조직·환경·요금제의 `open` 거래를 다시 쓰는 창(중복 클릭 방지, 계획 §3-6). */
export const CHECKOUT_REUSE_MINUTES = 30;

const SUBSCRIPTION_COLUMNS = `provider, provider_subscription_id, environment, organization_id::text AS organization_id, provider_customer_id,
  origin_transaction_id, status, plan_code, price_id, current_period_end, scheduled_change_action, scheduled_change_at, past_due_since,
  provider_updated_at, synced_at, created_at`;

const CHECKOUT_COLUMNS = `id::text AS id, organization_id::text AS organization_id, provider, environment, transaction_id, plan_code,
  created_by_user_id::text AS created_by_user_id, status, created_at, completed_at`;

// ---------------------------------------------------------------------------
// sync 쪽 — atmark_billing
// ---------------------------------------------------------------------------

/** 큐 메시지에서 원장에 적는 좌표(본문 없음). */
export interface BillingEventRecord {
  readonly provider: BillingProvider;
  readonly eventId: string;
  readonly eventType: BillingEventType;
  readonly occurredAt: Date;
  readonly notificationId: string | null;
  readonly environment: PaddleEnvironment;
  readonly payloadSha256: string;
  readonly subscriptionId: string | null;
  readonly transactionId: string | null;
}

/**
 * `new` = 처음 본 이벤트 · `retry` = 전에 받았지만 끝나지 않았다(pending·failed — attempts + 1, pending 으로) · `duplicate` = 이미 done/ignored
 * (처리하지 않는다). FIFO 중복 제거(5분)를 넘긴 재전송·재시도를 이 원장이 영구로 거른다.
 */
export type RecordBillingEventOutcome = 'new' | 'retry' | 'duplicate';

/** 이벤트를 원장에 적는다(atmark_billing). 짧은 트랜잭션에서 부른다 — 뒤의 공급자 재조회는 트랜잭션 밖. */
export async function recordBillingEvent(db: Queryable, event: BillingEventRecord): Promise<RecordBillingEventOutcome> {
  const inserted = await db.query(
    `INSERT INTO billing_events (provider, event_id, event_type, occurred_at, notification_id, environment, payload_sha256, subscription_id, transaction_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING event_id`,
    [
      event.provider,
      event.eventId,
      event.eventType,
      event.occurredAt,
      event.notificationId,
      event.environment,
      event.payloadSha256,
      event.subscriptionId,
      event.transactionId,
    ],
  );
  if (inserted.rowCount === 1) return 'new';
  const existing = await selectRow<{ status: string }>(
    db,
    'SELECT status FROM billing_events WHERE provider = $1 AND event_id = $2 FOR UPDATE',
    [event.provider, event.eventId],
  );
  if (existing === null || existing.status === 'done' || existing.status === 'ignored') return 'duplicate';
  await db.query(
    `UPDATE billing_events SET attempts = attempts + 1, status = 'pending', last_error = NULL, processed_at = NULL
      WHERE provider = $1 AND event_id = $2`,
    [event.provider, event.eventId],
  );
  return 'retry';
}

/** 이벤트의 결말. `done` 은 이유 없음, `ignored`·`failed` 는 이유 코드가 반드시 있다(CHECK `billing_events_reason_check`). */
export type BillingEventFinish =
  | { readonly status: 'done'; readonly code: null }
  | { readonly status: 'ignored' | 'failed'; readonly code: BillingEventReasonCode };

/**
 * 이벤트를 끝낸다(atmark_billing). 이미 종단이면 아무것도 하지 않고 `false` — 같은 메시지를 두 λ 가 겹쳐 처리한 경우다(동시성 1 이라 드물다).
 * `failed` 는 종단이 아니다 — 다음 재시도가 `recordBillingEvent` 로 `retry` 를 받는다.
 */
export async function finishBillingEvent(db: Queryable, provider: BillingProvider, eventId: string, finish: BillingEventFinish): Promise<boolean> {
  const result = await db.query(
    `UPDATE billing_events SET status = $3, last_error = $4, processed_at = now()
      WHERE provider = $1 AND event_id = $2 AND status IN ('pending', 'failed')`,
    [provider, eventId, finish.status, finish.code],
  );
  return result.rowCount === 1;
}

/** 결속 검증에 쓰는 체크아웃 칸(atmark_billing 이 읽을 수 있는 넷). */
export type BillingCheckoutBinding = Pick<BillingCheckoutRow, 'organization_id' | 'environment' | 'transaction_id' | 'status'>;

/** 우리 거래인가(atmark_billing). 없으면 `null` — 그 구독은 어느 조직에도 결속되지 않는다(`unbound_subscription`). */
export async function findCheckout(db: Queryable, transactionId: string, environment: PaddleEnvironment): Promise<BillingCheckoutBinding | null> {
  return selectRow<BillingCheckoutBinding>(
    db,
    `SELECT organization_id::text AS organization_id, environment, transaction_id, status
       FROM billing_checkouts WHERE transaction_id = $1 AND environment = $2`,
    [transactionId, environment],
  );
}

/** 재조회한 공급자 구독의 정규화 — 어댑터(`src/billing/paddle/adapter.ts`)가 만들고 이 파일이 쓴다. 조직·원 거래는 결속 때만 정한다. */
export interface SubscriptionSnapshot {
  readonly provider: BillingProvider;
  readonly providerSubscriptionId: string;
  readonly environment: PaddleEnvironment;
  readonly providerCustomerId: string;
  readonly status: BillingSubscriptionStatus;
  /** 가격 id → 요금제. NULL = 모르는 가격. */
  readonly planCode: BillingPlanCode | null;
  readonly priceId: string | null;
  readonly currentPeriodEnd: Date | null;
  readonly scheduledChangeAction: BillingScheduledChangeAction | null;
  readonly scheduledChangeAt: Date | null;
  readonly pastDueSince: Date | null;
  readonly providerUpdatedAt: Date;
}

function snapshotValues(sub: SubscriptionSnapshot): unknown[] {
  return [
    sub.status,
    sub.planCode,
    sub.priceId,
    sub.currentPeriodEnd,
    sub.scheduledChangeAction,
    sub.scheduledChangeAt,
    sub.pastDueSince,
    sub.providerUpdatedAt,
  ];
}

/**
 * 처음 보는 구독을 결속한다(atmark_billing) — 구독 행 INSERT(조직·원 거래 고정) + 그 체크아웃 `completed`. 호출자가 먼저 `findCheckout` 으로
 * 거래·조직을 확인한다. 거래·조직·환경이 `billing_checkouts` 와 맞지 않으면 FK(`billing_subscriptions_origin_checkout`)가 `23503` 으로 거부한다.
 * `exists` = 이미 결속돼 있다(겹친 처리) — 호출자는 `upsertSubscription` 으로 넘어간다.
 */
export async function bindSubscription(
  db: Queryable,
  sub: SubscriptionSnapshot,
  organizationId: string,
  originTransactionId: string,
): Promise<'bound' | 'exists'> {
  const inserted = await db.query(
    `INSERT INTO billing_subscriptions (provider, provider_subscription_id, environment, organization_id, provider_customer_id, origin_transaction_id,
                                        status, plan_code, price_id, current_period_end, scheduled_change_action, scheduled_change_at,
                                        past_due_since, provider_updated_at, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
     ON CONFLICT (provider, provider_subscription_id) DO NOTHING
     RETURNING provider_subscription_id`,
    [sub.provider, sub.providerSubscriptionId, sub.environment, organizationId, sub.providerCustomerId, originTransactionId, ...snapshotValues(sub)],
  );
  if (inserted.rowCount !== 1) return 'exists';
  await db.query(
    `UPDATE billing_checkouts SET status = 'completed', completed_at = now()
      WHERE transaction_id = $1 AND environment = $2 AND status = 'open'`,
    [originTransactionId, sub.environment],
  );
  return 'bound';
}

/**
 * 결속된 구독을 재조회 결과로 갱신한다(atmark_billing). `updated` = 썼다(같은 `updated_at` 도 쓴다 — 멱등) · `stale` = 표의 행이 더 새롭다
 * (옛 재조회 · 해지된 구독을 되살리려는 입력) · `missing` = 아직 결속되지 않았다(→ 결속 경로).
 */
export async function upsertSubscription(db: Queryable, sub: SubscriptionSnapshot): Promise<'updated' | 'stale' | 'missing'> {
  const updated = await db.query(
    `UPDATE billing_subscriptions
        SET status = $3, plan_code = $4, price_id = $5, current_period_end = $6, scheduled_change_action = $7, scheduled_change_at = $8,
            past_due_since = $9, provider_updated_at = $10, synced_at = now()
      WHERE provider = $1 AND provider_subscription_id = $2
        AND provider_updated_at <= $10
        AND NOT (status = 'canceled' AND $3::text <> 'canceled')`,
    [sub.provider, sub.providerSubscriptionId, ...snapshotValues(sub)],
  );
  if (updated.rowCount === 1) return 'updated';
  const existing = await selectRow<{ one: number }>(
    db,
    'SELECT 1 AS one FROM billing_subscriptions WHERE provider = $1 AND provider_subscription_id = $2',
    [sub.provider, sub.providerSubscriptionId],
  );
  return existing === null ? 'missing' : 'stale';
}

/**
 * 고객 결속의 결과 — `bound` = 새로 묶었다 · `existing` = 같은 고객으로 이미 묶여 있다 · `shared` = 결속이 1:1 이 아니다: 이 고객이 다른 조직에도
 * 묶여 있거나(H-1/M-4 — 한 Paddle 고객이 여러 조직에 붙을 수 있다), 이 조직이 이미 다른 고객에 묶여 있다(그 행은 그대로 — 고치기 거부 표).
 * 호출자는 `shared` 를 메트릭 `billingCustomerShared` + 식별자 없는 로그로 남긴다. 결속 자체는 `shared` 여도 됐다(조직 행이 있다).
 */
export type BindCustomerOutcome = 'bound' | 'existing' | 'shared';

/** 조직 ↔ 공급자 고객(atmark_billing). 키는 (조직, 공급자, 환경) — 고객 id 는 키가 아니다. 이메일·주소는 받지 않는다. */
export async function bindCustomer(
  db: Queryable,
  organizationId: string,
  provider: BillingProvider,
  environment: PaddleEnvironment,
  providerCustomerId: string,
): Promise<BindCustomerOutcome> {
  const inserted = await db.query(
    `INSERT INTO billing_customers (organization_id, provider, provider_customer_id, environment) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, provider, environment) DO NOTHING RETURNING provider_customer_id`,
    [organizationId, provider, providerCustomerId, environment],
  );
  if (inserted.rowCount !== 1) {
    const row = await selectRow<{ provider_customer_id: string }>(
      db,
      'SELECT provider_customer_id FROM billing_customers WHERE organization_id = $1 AND provider = $2 AND environment = $3',
      [organizationId, provider, environment],
    );
    if (row?.provider_customer_id !== providerCustomerId) return 'shared';
  }
  const other = await selectRow<{ one: number }>(
    db,
    `SELECT 1 AS one FROM billing_customers
      WHERE provider = $1 AND environment = $2 AND provider_customer_id = $3 AND organization_id <> $4
      LIMIT 1`,
    [provider, environment, providerCustomerId, organizationId],
  );
  if (other !== null) return 'shared';
  return inserted.rowCount === 1 ? 'bound' : 'existing';
}

/** 조직의 결속된 고객과 공유 여부. */
export interface OrgBillingCustomer {
  readonly customerId: string;
  /** 같은 공급자·환경에서 다른 조직도 이 고객에 묶여 있다 — 체크아웃에 고객을 미리 채우지 않는다(H-1). */
  readonly shared: boolean;
}

/** 조직의 고객(atmark_admin · atmark_billing). 결속 전이면 `null`. 포털·체크아웃 판단의 입력. */
export async function loadOrgCustomer(
  db: Queryable,
  organizationId: string,
  provider: BillingProvider,
  environment: PaddleEnvironment,
): Promise<OrgBillingCustomer | null> {
  const row = await selectRow<{ customer_id: string; shared: boolean }>(
    db,
    `SELECT c.provider_customer_id AS customer_id,
            EXISTS (SELECT 1 FROM billing_customers o
                     WHERE o.provider = c.provider AND o.environment = c.environment AND o.provider_customer_id = c.provider_customer_id
                       AND o.organization_id <> c.organization_id) AS shared
       FROM billing_customers c
      WHERE c.organization_id = $1 AND c.provider = $2 AND c.environment = $3`,
    [organizationId, provider, environment],
  );
  return row === null ? null : { customerId: row.customer_id, shared: row.shared };
}

/**
 * 그 고객의 구독 중 다른 조직 것이 **우리 표에** 하나라도 있는가 — **상태 무관**(해지된 것도, atmark_admin · atmark_billing). 있으면 포털을 열지
 * 않는다(409 `billing_portal_shared_customer` — 포털은 고객의 구독 전부를, 해지된 것까지 보여 주고 영수증·결제 수단을 연다. 보안 검증 R-1).
 * 우리 거래에서 나오지 않은 구독은 이 표에 없다 — 공급자 쪽 목록 대조는 호출자 몫이다.
 */
export async function customerHasOtherOrgSubscription(
  db: Queryable,
  organizationId: string,
  provider: BillingProvider,
  environment: PaddleEnvironment,
  providerCustomerId: string,
): Promise<boolean> {
  const row = await selectRow<{ one: number }>(
    db,
    `SELECT 1 AS one FROM billing_subscriptions
      WHERE provider = $1 AND environment = $2 AND provider_customer_id = $3 AND organization_id <> $4
      LIMIT 1`,
    [provider, environment, providerCustomerId, organizationId],
  );
  return row !== null;
}

/** 조직의 결속된 구독 전체 — 이 환경의 것만(atmark_billing). 결정 함수의 입력. */
export async function loadOrgSubscriptions(db: Queryable, organizationId: string, environment: PaddleEnvironment): Promise<BillingSubscriptionRow[]> {
  return selectRows<BillingSubscriptionRow>(
    db,
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions
      WHERE organization_id = $1 AND environment = $2
      ORDER BY provider_subscription_id`,
    [organizationId, environment],
  );
}

/** 구독 하나(atmark_billing) — 결속됐는가 · 그 조직. 없으면 `null`. */
export async function loadSubscription(db: Queryable, provider: BillingProvider, providerSubscriptionId: string): Promise<BillingSubscriptionRow | null> {
  return selectRow<BillingSubscriptionRow>(
    db,
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE provider = $1 AND provider_subscription_id = $2`,
    [provider, providerSubscriptionId],
  );
}

/** reconcile `stale` 단계 — 이 환경의 비종단 구독 id(id 순, atmark_billing). */
export async function listNonTerminalSubscriptionIds(db: Queryable, environment: PaddleEnvironment): Promise<string[]> {
  const rows = await selectRows<{ id: string }>(
    db,
    `SELECT provider_subscription_id AS id FROM billing_subscriptions
      WHERE environment = $1 AND status <> 'canceled'
      ORDER BY provider_subscription_id`,
    [environment],
  );
  return rows.map((row) => row.id);
}

/**
 * reconcile `orgs` 단계 — 다시 계산할 조직 id(id 순, `after` 다음부터 `limit` 개, atmark_billing): 이 환경에 결속된 구독이 있는 조직과
 * provider 출처 행을 가진 조직(유예 만료 기록 · 해지 반영).
 */
export async function listReconcileOrganizationIds(
  db: Queryable,
  environment: PaddleEnvironment,
  after: string | null,
  limit: number,
): Promise<string[]> {
  const rows = await selectRows<{ id: string }>(
    db,
    `SELECT id::text AS id FROM (
       SELECT organization_id AS id FROM billing_subscriptions WHERE environment = $1
       UNION
       SELECT organization_id AS id FROM org_entitlements WHERE source = 'provider'
     ) candidates
      WHERE $2::uuid IS NULL OR id > $2::uuid
      ORDER BY id
      LIMIT $3`,
    [environment, after, limit],
  );
  return rows.map((row) => row.id);
}

/**
 * 웹훅 누락 탐지(reconcile, atmark_billing) — 그 구독에 대해 `since` 이후(occurred_at ≥ since) 이벤트를 받은 적이 있는가.
 * 호출자가 `since = 목록 엔터티의 updated_at − 1분` 을 준다(계획 §3-5).
 */
export async function hasSubscriptionEventSince(db: Queryable, providerSubscriptionId: string, since: Date): Promise<boolean> {
  const row = await selectRow<{ one: number }>(
    db,
    'SELECT 1 AS one FROM billing_events WHERE subscription_id = $1 AND occurred_at >= $2 LIMIT 1',
    [providerSubscriptionId, since],
  );
  return row !== null;
}

/** reconcile 커서(한 행, atmark_billing). 첫 판 전이면 `null`. */
export async function loadReconcileState(db: Queryable): Promise<BillingReconcileStateRow | null> {
  return selectRow<BillingReconcileStateRow>(
    db,
    `SELECT id, run_id::text AS run_id, phase, paddle_cursor, org_cursor::text AS org_cursor, started_at, updated_at, completed_at
       FROM billing_reconcile_state WHERE id = 1`,
  );
}

/**
 * reconcile 커서를 쓴다(atmark_billing) — 없으면 만들고 있으면 바꾼다. `updated_at` 은 호출자의 시각(틱 시각)이다.
 *
 * **CAS**(코드 리뷰 M10): 행의 `run_id` 가 `expectedRunId`(호출자가 마지막으로 읽었거나 쓴 판)일 때만 바꾼다. 그 사이 다른 실행이 새 판을 열었으면
 * (`restart`·동시 틱) 0행이고 `false` 다 — 호출자는 남의 판을 덮지 않고 멈춘다. 행이 아직 없으면(`expectedRunId = null`) 만든다.
 */
export async function saveReconcileState(
  db: Queryable,
  state: Omit<BillingReconcileStateRow, 'id'>,
  expectedRunId: string | null,
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO billing_reconcile_state (id, run_id, phase, paddle_cursor, org_cursor, started_at, updated_at, completed_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE
       SET run_id = EXCLUDED.run_id, phase = EXCLUDED.phase, paddle_cursor = EXCLUDED.paddle_cursor, org_cursor = EXCLUDED.org_cursor,
           started_at = EXCLUDED.started_at, updated_at = EXCLUDED.updated_at, completed_at = EXCLUDED.completed_at
       WHERE billing_reconcile_state.run_id IS NOT DISTINCT FROM $8::uuid`,
    [state.run_id, state.phase, state.paddle_cursor, state.org_cursor, state.started_at, state.updated_at, state.completed_at, expectedRunId],
  );
  return result.rowCount === 1;
}

/** reconcile 단일 실행 잠금 키(세션 advisory). 테스트가 같은 키로 다른 세션에서 잡아 `concurrent` 를 만든다. */
const RECONCILE_RUN_LOCK_KEY = `hashtextextended('billing_reconcile_run', 0)`;

/**
 * reconcile 단일 실행 잠금을 **시도**한다(atmark_billing, 세션 advisory — 기다리지 않는다). 세션 잠금이라 잡은 연결에서만 풀린다 —
 * 그래서 `pg.Pool` 이 아니라 `pool.connect()` 로 얻은 **전용 연결**만 받는다(재검토 N5: 잠금·작업·해제가 한 세션, 풀 크기와 무관).
 */
export async function tryLockReconcileRun(session: PoolClient): Promise<boolean> {
  const result = await session.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${RECONCILE_RUN_LOCK_KEY}) AS locked`);
  return result.rows[0]?.locked === true;
}

/** 위 잠금을 푼다(같은 전용 연결). 이 세션이 쥐고 있지 않았으면 `false`(Postgres 는 경고만 낸다). */
export async function unlockReconcileRun(session: PoolClient): Promise<boolean> {
  const result = await session.query<{ released: boolean }>(`SELECT pg_advisory_unlock(${RECONCILE_RUN_LOCK_KEY}) AS released`);
  return result.rows[0]?.released === true;
}

// ---------------------------------------------------------------------------
// admin 쪽 — atmark_admin
// ---------------------------------------------------------------------------

/**
 * 조직 체크아웃 잠금(atmark_admin) — 중복 클릭 두 요청이 거래를 둘 만들지 않게. 공급자 호출은 이 잠금을 쥔 트랜잭션 **밖**에서 한다
 * (① 잠금·조회 → ② 공급자 생성 → ③ 잠금·INSERT, 계획 §3-6).
 */
export async function lockOrgCheckout(db: Queryable, organizationId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing_checkout:' || $1::text, 0))`, [organizationId]);
}

/** 다시 쓸 수 있는 거래 — 같은 조직·환경·요금제의 `open` 거래 중 `CHECKOUT_REUSE_MINUTES` 안에 만든 가장 새것(atmark_admin). */
export async function openCheckoutFor(
  db: Queryable,
  organizationId: string,
  environment: PaddleEnvironment,
  plan: BillingPlanCode,
): Promise<BillingCheckoutRow | null> {
  return selectRow<BillingCheckoutRow>(
    db,
    `SELECT ${CHECKOUT_COLUMNS} FROM billing_checkouts
      WHERE organization_id = $1 AND environment = $2 AND plan_code = $3 AND status = 'open'
        AND created_at > now() - make_interval(mins => $4)
      ORDER BY created_at DESC LIMIT 1`,
    [organizationId, environment, plan, CHECKOUT_REUSE_MINUTES],
  );
}

/** 조직·환경의 `open` 거래 전부(atmark_admin) — 다른 요금제로 새 거래를 만들 때 옛 것을 `superseded` 로 닫는다. */
export async function listOpenCheckouts(db: Queryable, organizationId: string, environment: PaddleEnvironment): Promise<BillingCheckoutRow[]> {
  return selectRows<BillingCheckoutRow>(
    db,
    `SELECT ${CHECKOUT_COLUMNS} FROM billing_checkouts
      WHERE organization_id = $1 AND environment = $2 AND status = 'open'
      ORDER BY created_at DESC`,
    [organizationId, environment],
  );
}

export interface CheckoutInsert {
  readonly organizationId: string;
  readonly provider: BillingProvider;
  readonly environment: PaddleEnvironment;
  readonly transactionId: string;
  readonly plan: BillingPlanCode;
  /** 콘솔 세션의 사용자(owner·admin). */
  readonly createdByUserId: string;
}

/** 공급자가 만든 거래를 기록한다(atmark_admin) — 결속의 근거. 상태 `open`·시각은 DB 가 정한다. */
export async function insertCheckout(db: Queryable, checkout: CheckoutInsert): Promise<BillingCheckoutRow> {
  const row = await selectRow<BillingCheckoutRow>(
    db,
    `INSERT INTO billing_checkouts (organization_id, provider, environment, transaction_id, plan_code, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${CHECKOUT_COLUMNS}`,
    [checkout.organizationId, checkout.provider, checkout.environment, checkout.transactionId, checkout.plan, checkout.createdByUserId],
  );
  if (row === null) throw new Error('billing_checkouts INSERT 가 행을 돌려주지 않았다.');
  return row;
}

/**
 * 조직이 `since` 이후(created_at ≥ since) 만든 거래 수 — 상태·환경·요금제와 무관하게(atmark_admin). 하루 체크아웃 상한(보안 검증 M-1)의 입력 —
 * 상한 값과 판단은 호출자(`src/admin/ops/billing.ts`)가 갖는다. 재사용한 거래는 새 행이 아니라 세지 않는다.
 */
export async function countOrgCheckoutsSince(db: Queryable, organizationId: string, since: Date): Promise<number> {
  const row = await selectRow<{ n: number }>(
    db,
    'SELECT count(*)::int AS n FROM billing_checkouts WHERE organization_id = $1 AND created_at >= $2',
    [organizationId, since],
  );
  return row?.n ?? 0;
}

/** `open` 거래를 `superseded` 로 닫는다(atmark_admin). 이미 끝났으면 `false`. 공급자 쪽 취소는 호출자가 best-effort 로 한다. */
export async function supersedeCheckout(db: Queryable, transactionId: string): Promise<boolean> {
  const result = await db.query(`UPDATE billing_checkouts SET status = 'superseded' WHERE transaction_id = $1 AND status = 'open'`, [transactionId]);
  return result.rowCount === 1;
}

/** 결제 개요에 싣는 구독 칸(atmark_admin 이 읽을 수 있는 것 — 구독 id·가격 id·공급자 시각 없음). */
export type BillingOverviewSubscription = Pick<
  BillingSubscriptionRow,
  'status' | 'plan_code' | 'current_period_end' | 'scheduled_change_action' | 'scheduled_change_at' | 'past_due_since'
>;

export interface BillingOverviewRows {
  /** 이 환경의 결속된 공급자 고객(포털 세션에 쓴다). 없으면 `null`. */
  readonly customerId: string | null;
  /** 비종단이 먼저, 그다음 기간 끝이 늦은 순. */
  readonly subscriptions: readonly BillingOverviewSubscription[];
}

/** 결제 표(202609250400)가 아직 없다 — 콘솔은 `enabled:false`(잠김)로 그린다. */
export const BILLING_TABLES_MISSING = 'table_missing' as const;

/** 결제 개요(atmark_admin, `GET /api/billing`). 표가 없으면 `'table_missing'`. */
export async function loadBillingOverviewRows(
  db: Queryable,
  organizationId: string,
  environment: PaddleEnvironment,
): Promise<BillingOverviewRows | typeof BILLING_TABLES_MISSING> {
  const table = await selectRow<{ ok: boolean }>(db, `SELECT to_regclass('public.billing_subscriptions') IS NOT NULL AS ok`);
  if (table?.ok !== true) return BILLING_TABLES_MISSING;
  const customer = await selectRow<{ provider_customer_id: string }>(
    db,
    `SELECT provider_customer_id FROM billing_customers WHERE organization_id = $1 AND environment = $2`,
    [organizationId, environment],
  );
  const subscriptions = await selectRows<BillingOverviewSubscription>(
    db,
    `SELECT status, plan_code, current_period_end, scheduled_change_action, scheduled_change_at, past_due_since
       FROM billing_subscriptions
      WHERE organization_id = $1 AND environment = $2
      ORDER BY (status = 'canceled'), current_period_end DESC NULLS LAST`,
    [organizationId, environment],
  );
  return { customerId: customer?.provider_customer_id ?? null, subscriptions };
}
