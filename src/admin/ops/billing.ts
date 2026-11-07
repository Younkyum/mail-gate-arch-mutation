/**
 * src/admin/ops/billing.ts — **콘솔 결제**(WP-2, 계획 §3-6 · §3-8 · 진윤겸 결정 D-5 owner + admin). `GET /api/billing` · `POST /api/billing/checkout` ·
 * `POST /api/billing/portal` 의 연산. `planUsageOp`(`ops/plan.ts`)는 건드리지 않는다 — 한도·사용량은 `/api/plan`, 결제 상태는 여기.
 *
 * **체크아웃은 서버가 만든다.** Paddle 거래(`custom_data.atmark_organization_id` = 세션 조직 — 클라이언트 입력이 아니다)를 admin 키로 만들고
 * `billing_checkouts` 에 적은 뒤 `https://pay.atmark.ai/?_ptxn=…` 를 돌려준다. 결속은 이 표의 거래에서 나온 구독만 인정된다(sync).
 *   (전체가 조직 체크아웃 **세션 잠금** 안 — `pg_try_advisory_lock` 이라 기다리지 않는다: 이미 잡혀 있으면(중복 클릭·다른 탭) 409
 *   `billing_checkout_busy`. 기다리는 요청이 admin 연결 둘을 붙잡아 λ 25초를 넘기지 않게 한다 — 보안 검증 M-1.)
 *   ① 잠금·조회 트랜잭션: 조직 체크아웃 잠금 → 허용 조건 → 열린 거래 · 같은 요금제 거래(30분 안) · 결속 고객(공유 여부) · 하루 동안 만든 거래 수.
 *   ② Paddle 거래 상태 — **트랜잭션 밖**, 병렬(각 5초): 재사용 후보를 뺀 **모든** 열린 거래(요금제 무관 — 30분이 지난 같은 요금제 거래 포함,
 *      최근 `OPEN_STATUS_WINDOW_MS`(24시간) 안의 새것부터 `OPEN_STATUS_MAX`(5)건)가 이미 `completed`/`paid` 면(웹훅이 아직 반영 전) 409
 *      `billing_subscription_exists`(이중 청구를 막는다 — M-2 · 코드 검토 N-1). 같은 요금제 거래는 `ready`/`draft` 일 때만 다시 쓴다(M-8), 아니면
 *      새로 만든다. 상한 밖(24시간 전 · 여섯째부터)은 조회하지 않는다 — 결제됐다면 웹훅·reconcile 이 이미 구독을 결속해 허용 조건이 막는다.
 *   ③ (새로 만들 때만) 하루 상한 `CHECKOUT_DAILY_LIMIT`(넘으면 429 `billing_checkout_limit`) → Paddle 거래 생성(트랜잭션 밖). 공유 고객이면
 *      고객을 미리 채우지 않는다(H-1 — 다른 조직의 결제 수단·주소가 채워진 체크아웃이 되지 않게).
 *   ④ 잠금·INSERT 트랜잭션: INSERT + 다른 열린 거래를 `superseded` 로 · 감사 1행(`billing.checkout`, 대상 = 체크아웃 id).
 *   Paddle 호출은 각 5초 제한(admin 조립)이고 한 요청에서 차례로 부르는 것은 많아야 셋(상태 묶음 · 생성 · 취소 묶음)이다 — λ 25초 안.
 *
 * 허용 조건(`upgradeAvailable`, 계획 §3-6): 스위치 · admin 키 · 가격 id · 역할 owner·admin · 조직 활성 · 샌드박스 허용 조직 · 비종단 구독 없음 ·
 * **지금 적용 요금제가 beta 가 아님**(beta 기간 잠김) · 요청 요금제가 지금 적용 한도를 칸별로 지배하거나 행이 provider 출처/넘긴 행
 * (결제하고도 보류되는 일을 막는다). 금액·이메일·주소는 어디에도 없다. 포털 URL 은 임시라 저장·로그하지 않는다.
 *
 * 포털(H-1): 한 Paddle 고객이 여러 조직에 붙을 수 있다(같은 이메일). 포털은 그 고객의 구독을 **전부**(해지된 것까지 — 영수증·결제 수단) 보여
 * 주므로, 그 고객의 구독이 **상태와 무관하게** 전부 이 조직 것일 때만 연다(보안 검증 R-1 — 한 번이라도 다른 조직 구독이었으면 공유) — 우리 표
 * (다른 조직에 결속된 구독이 없다)와 Paddle 목록(`GET /subscriptions?customer_id=` 의 상태 다섯 모두가 이 조직의 `custom_data`) 둘 다. 아니면 409
 * `billing_portal_shared_customer`.
 */

import type { Pool, PoolClient } from 'pg';

import { PAY_ORIGIN, PROVIDER_GRACE_DAYS, BILLING_PROVIDERS, type PaddleEnvironment } from '../../billing/constants';
import { planForPrice, priceForPlan } from '../../billing/paddle/prices';
import {
  dominatesLimits,
  ENTITLEMENTS_TABLE_MISSING,
  isPaidPlanCode,
  PAID_PLAN_CODES,
  PLAN_CATALOG,
  resolveEntitlements,
  type PaidPlanCode,
} from '../../billing/plans';
import {
  PROVIDER_SUBSCRIPTION_STATUSES,
  ProviderNotFoundError,
  type AdminBillingDependencies,
  type BillingProviderApi,
  type NormalizedSubscription,
} from '../../billing/provider';
import type { Queryable } from '../../db/client';
import { DOMAIN_API_ERRORS } from '../../domains/contract';
import {
  BILLING_TABLES_MISSING,
  countOrgCheckoutsSince,
  customerHasOtherOrgSubscription,
  insertCheckout,
  listOpenCheckouts,
  loadBillingOverviewRows,
  loadOrgCustomer,
  lockOrgCheckout,
  openCheckoutFor,
  supersedeCheckout,
  type BillingOverviewRows,
} from '../../db/repositories/billing';
import { loadOrgEntitlementsControlRow } from '../../db/repositories/entitlements-write';
import type { BillingSubscriptionStatus } from '../../db/schema';
import { roleAtLeast, type MemberRole } from '../context';
import { iso } from '../display';
import { AdminInputError } from './errors';

/** 잠금 사유 — 콘솔 ⓘ 한 줄(`script/plan.ts` `BILL_WHY`). */
type BillingLockedReason =
  | 'disabled'
  | 'not_configured'
  | 'role'
  | 'not_active'
  | 'sandbox_not_allowed'
  | 'subscription_exists'
  | 'beta'
  | 'no_higher_plan';

/** 콘솔이 보는 거부 코드 — `script/core.ts` `CODES` 에 두 언어 문구가 있다(`admin-console-billing` 테스트가 대조). */
export const BILLING_ERROR_CODES = [
  'invalid_plan',
  'billing_unavailable',
  'billing_provider_error',
  'billing_beta_locked',
  'billing_org_not_active',
  'billing_subscription_exists',
  'billing_plan_not_higher',
  'billing_sandbox_not_allowed',
  'billing_no_customer',
  'billing_checkout_busy',
  'billing_checkout_limit',
  'billing_portal_shared_customer',
  // 청구 이메일이 에이전트 주소(ADR-0014 결정 8 · M3b).
  'billing_email_is_agent',
] as const;

/** 조직이 24시간 동안 새로 만들 수 있는 체크아웃 거래 수(보안 검증 M-1). 다시 쓴 거래는 세지 않는다. 넘으면 429 `billing_checkout_limit`. */
export const CHECKOUT_DAILY_LIMIT = 10;
/** 상태를 조회하는 열린 거래의 창과 수(재사용 후보 제외) — 조회가 느려지지 않게(병렬이라도 λ 25초 · Paddle 레이트 안). */
const OPEN_STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const OPEN_STATUS_MAX = 5;
/** 이미 돈을 받은 거래 상태 — 열린 거래가 이 상태면 구독이 곧 생긴다(M-2). */
const PAID_TRANSACTION_STATUSES: ReadonlySet<string> = new Set(['completed', 'paid']);
/** 다시 쓸 수 있는 거래 상태 — 아직 결제 전(M-8). 그 밖(`billed`·`canceled`·`past_due` 등)은 새 거래를 만든다. */
const REUSABLE_TRANSACTION_STATUSES: ReadonlySet<string> = new Set(['ready', 'draft']);
/** 포털 판단 때 읽는 고객 구독 목록의 최대 페이지 — 넘으면 공유로 본다(fail-closed · 시간 예산). */
const PORTAL_CUSTOMER_MAX_PAGES = 2;

interface BillingPlanOffer {
  readonly code: PaidPlanCode;
  readonly available: boolean;
}

export interface BillingOverviewView {
  readonly enabled: boolean;
  readonly environment: PaddleEnvironment | null;
  readonly canManage: boolean;
  readonly upgradeAvailable: boolean;
  readonly lockedReason: BillingLockedReason | null;
  readonly plans: readonly BillingPlanOffer[];
  readonly subscription: {
    readonly status: BillingSubscriptionStatus;
    readonly plan: PaidPlanCode | null;
    readonly currentPeriodEnd: string | null;
    readonly scheduledChange: { readonly action: string; readonly at: string | null } | null;
    readonly graceUntil: string | null;
  } | null;
  readonly portalAvailable: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PROVIDER = BILLING_PROVIDERS[0];

interface Gate {
  readonly lockedReason: BillingLockedReason | null;
  readonly plans: readonly BillingPlanOffer[];
  readonly rows: BillingOverviewRows | null;
  /** 잠금 사유가 없으면 늘 있다(`not_configured` 가 아니다). */
  readonly provider: BillingProviderApi | null;
}

/**
 * 허용 조건 — 개요와 체크아웃이 **같은 함수**를 본다(화면의 잠금과 409 가 같은 이유로 갈린다). 앞에서부터 첫 사유가 이긴다.
 * 요금제별 `available` 은 잠금 사유가 없을 때만 참일 수 있다.
 */
async function evaluateGate(db: Queryable, billing: AdminBillingDependencies | undefined, organizationId: string, role: MemberRole, now: Date): Promise<Gate> {
  let provider: BillingProviderApi | null = null;
  const closed = (lockedReason: BillingLockedReason, rows: BillingOverviewRows | null = null): Gate => ({
    lockedReason,
    plans: PAID_PLAN_CODES.map((code) => ({ code, available: false })),
    rows,
    provider,
  });
  if (billing === undefined || !billing.enabled) return closed('disabled');
  const loaded = await loadBillingOverviewRows(db, organizationId, billing.environment);
  if (loaded === BILLING_TABLES_MISSING) return closed('disabled');
  provider = await billing.loadProvider();
  if (provider === null || PAID_PLAN_CODES.every((plan) => priceForPlan(billing.prices, plan) === null)) return closed('not_configured', loaded);
  if (!roleAtLeast(role, 'admin')) return closed('role', loaded);
  const org = await db.query<{ review_status: string }>('SELECT review_status::text AS review_status FROM organizations WHERE id = $1', [organizationId]);
  if (org.rows[0]?.review_status !== 'active') return closed('not_active', loaded);
  if (billing.environment === 'sandbox' && !billing.sandboxAllowlist.includes(organizationId)) return closed('sandbox_not_allowed', loaded);
  if (loaded.subscriptions.some((sub) => sub.status !== 'canceled')) return closed('subscription_exists', loaded);
  const row = await loadOrgEntitlementsControlRow(db, organizationId);
  const applied = resolveEntitlements(row, now);
  if (applied.planCode === 'beta') return closed('beta', loaded);
  // provider 출처 행이나 운영자가 넘긴 행이면 결제가 그대로 덮는다(sync 결정 규칙과 같다). 아니면 칸별로 지배해야 결제가 적용된다.
  const handedOver = row !== null && row !== ENTITLEMENTS_TABLE_MISSING && (row.source === 'provider' || row.provider_override_allowed);
  const plans = PAID_PLAN_CODES.map((code) => ({
    code,
    available: priceForPlan(billing.prices, code) !== null && (handedOver || dominatesLimits(PLAN_CATALOG[code], applied)),
  }));
  if (!plans.some((plan) => plan.available)) return { lockedReason: 'no_higher_plan', plans, rows: loaded, provider };
  return { lockedReason: null, plans, rows: loaded, provider };
}

/** `GET /api/billing` — 멤버 누구나 읽는다(역할에 따라 `canManage`·잠금 사유가 갈린다). */
export async function billingOverviewOp(
  db: Queryable,
  billing: AdminBillingDependencies | undefined,
  session: { readonly organizationId: string; readonly role: MemberRole },
  now: Date,
): Promise<BillingOverviewView> {
  const gate = await evaluateGate(db, billing, session.organizationId, session.role, now);
  const enabled = gate.lockedReason !== 'disabled';
  const canManage = roleAtLeast(session.role, 'admin');
  const sub = gate.rows?.subscriptions[0] ?? null;
  return {
    enabled,
    environment: enabled && billing !== undefined ? billing.environment : null,
    canManage,
    upgradeAvailable: gate.lockedReason === null,
    lockedReason: gate.lockedReason,
    plans: gate.plans,
    subscription:
      sub === null
        ? null
        : {
            status: sub.status,
            plan: sub.plan_code,
            currentPeriodEnd: iso(sub.current_period_end),
            scheduledChange: sub.scheduled_change_action === null ? null : { action: sub.scheduled_change_action, at: iso(sub.scheduled_change_at) },
            graceUntil: sub.status === 'past_due' && sub.past_due_since !== null ? new Date(sub.past_due_since.getTime() + PROVIDER_GRACE_DAYS * DAY_MS).toISOString() : null,
          },
    portalAvailable: enabled && canManage && gate.provider !== null && (gate.rows?.customerId ?? null) !== null,
  };
}

/** 잠금 사유 → 체크아웃 거부. */
function lockedError(reason: BillingLockedReason): AdminInputError {
  switch (reason) {
    case 'role':
      return new AdminInputError('이 작업에는 admin 역할이 필요하다.', 'forbidden_role', 403);
    case 'not_active':
      return new AdminInputError('운영자 검토가 끝난 조직만 결제할 수 있다.', 'billing_org_not_active', 403);
    case 'sandbox_not_allowed':
      return new AdminInputError('이 조직은 샌드박스 결제 허용 목록에 없다.', 'billing_sandbox_not_allowed', 409);
    case 'subscription_exists':
      return new AdminInputError('이미 구독이 있다 — 결제 관리에서 바꾼다.', 'billing_subscription_exists', 409);
    case 'beta':
      return new AdminInputError('베타 기간에는 결제가 열리지 않는다.', 'billing_beta_locked', 409);
    case 'no_higher_plan':
      return new AdminInputError('지금 한도를 칸별로 넘는 요금제가 없다.', 'billing_plan_not_higher', 409);
    case 'disabled':
    case 'not_configured':
      return new AdminInputError('결제가 아직 열리지 않았다(스위치·키·가격).', 'billing_unavailable', 409);
  }
}

/** 공급자 호출이 실패했거나 돌려준 URL 이 우리 결제 페이지가 아니다 — 라우트가 502 로 바꾼다. */
export class BillingProviderFailure extends Error {
  constructor(readonly code: 'billing_provider_error' = 'billing_provider_error') {
    super(code);
    this.name = 'BillingProviderFailure';
  }
}

/**
 * 결제 페이지 URL — `https://pay.atmark.ai/[kr]?_ptxn=<txn>`(2026-09-30: 영어가 기본 `/`, 한국어는 `/kr` — 옛 `/en` 은 결제 호스트가 301).
 * 콘솔 스크립트가 같은 모양만 따른다.
 */
function checkoutPageUrl(transactionId: string, lang: 'ko' | 'en'): string {
  return `${PAY_ORIGIN}/${lang === 'ko' ? 'kr' : ''}?_ptxn=${transactionId}`;
}

/** Paddle 이 돌려준 체크아웃 URL 이 우리 결제 페이지 + 이 거래인가(출처 · 경로 `/` · `_ptxn`). */
function paddleCheckoutUrlOk(url: string | null, transactionId: string): boolean {
  if (url === null) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === PAY_ORIGIN && parsed.pathname === '/' && parsed.searchParams.get('_ptxn') === transactionId && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

interface CheckoutInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: MemberRole;
  readonly plan: unknown;
  readonly lang: 'ko' | 'en';
  /** 새 거래를 적을 때 감사 1행(같은 트랜잭션). */
  readonly audit: (tx: Queryable, checkoutId: string) => Promise<void>;
}

interface CheckoutResult {
  readonly url: string;
  readonly reused: boolean;
}

/** 조직 체크아웃 잠금의 키 — `lockOrgCheckout`(A 저장소, 트랜잭션 잠금)과 **같은 키**. 같은 세션은 다시 잡을 수 있다. */
const CHECKOUT_LOCK_KEY = `hashtextextended('billing_checkout:' || $1::text, 0)`;

/**
 * 조직 체크아웃 **세션** 잠금 — 연결 하나를 빌려 잠금을 쥔 채 ①→④ 를 돈다. Paddle 호출 동안 **DB 트랜잭션은 열려 있지 않다**(연결만 쥔다).
 * `pg_try_advisory_lock` 이라 기다리지 않는다 — 같은 조직의 다른 요청(중복 클릭·다른 탭)은 곧바로 409 `billing_checkout_busy`(보안 검증 M-1:
 * 기다리는 요청이 admin 풀(2)을 붙잡거나 λ 시간을 넘기지 않게). 풀리지 않은 잠금을 가진 연결은 풀로 돌려보내지 않는다(풀기가 실패하면 버린다).
 */
async function withCheckoutSession<T>(pool: Pool, organizationId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    const acquired = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(${CHECKOUT_LOCK_KEY}) AS ok`, [organizationId]);
    if (acquired.rows[0]?.ok !== true) throw new AdminInputError('같은 조직의 결제 요청이 진행 중이다.', 'billing_checkout_busy', 409);
    try {
      return await run(client);
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${CHECKOUT_LOCK_KEY})`, [organizationId]).catch(() => {
        broken = true;
      });
    }
  } finally {
    client.release(broken);
  }
}

/** 빌린 연결 위의 짧은 트랜잭션. */
async function inTransaction<T>(client: PoolClient, run: (tx: Queryable) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * 거래들의 공급자 상태(트랜잭션 밖 · 병렬). 404 는 `null`(공급자에 없다 — 결제될 수 없다). 그 밖의 실패는 `BillingProviderFailure`(502) —
 * 상태를 모른 채 새 거래를 만들면 이중 구독을 막지 못한다(fail-closed).
 */
async function transactionStatuses(provider: BillingProviderApi, ids: readonly string[]): Promise<ReadonlyMap<string, string | null>> {
  const entries = await Promise.all(
    ids.map(async (id): Promise<[string, string | null]> => {
      try {
        return [id, (await provider.fetchTransaction(id)).status];
      } catch (error) {
        if (error instanceof ProviderNotFoundError) return [id, null];
        throw new BillingProviderFailure();
      }
    }),
  );
  return new Map(entries);
}

/** `POST /api/billing/checkout` — 위 머리말 ①–④(조직 세션 잠금 안에서). */
export async function createCheckoutOp(pool: Pool, billing: AdminBillingDependencies | undefined, input: CheckoutInput, now: Date): Promise<CheckoutResult> {
  if (!isPaidPlanCode(input.plan)) throw new AdminInputError('plan 은 pro | team | scale 이다.', 'invalid_plan');
  const plan = input.plan;
  const outcome = await withCheckoutSession(pool, input.organizationId, async (client) => {
    // ① 잠금 · 허용 조건 · 열린 거래 · 고객 · 하루 계수.
    const first = await inTransaction(client, async (tx) => {
      await lockOrgCheckout(tx, input.organizationId);
      const gate = await evaluateGate(tx, billing, input.organizationId, input.role, now);
      if (gate.lockedReason !== null) throw lockedError(gate.lockedReason);
      if (gate.plans.find((offer) => offer.code === plan)?.available !== true) {
        throw priceForPlan(billing?.prices ?? {}, plan) === null
          ? new AdminInputError('이 요금제의 가격이 아직 없다.', 'billing_unavailable', 409)
          : new AdminInputError('이 요금제는 지금 한도보다 좁은 칸이 있다.', 'billing_plan_not_higher', 409);
      }
      const environment = billing?.environment ?? 'sandbox';
      return {
        provider: gate.provider,
        open: await listOpenCheckouts(tx, input.organizationId, environment),
        reuse: await openCheckoutFor(tx, input.organizationId, environment, plan),
        customer: await loadOrgCustomer(tx, input.organizationId, PROVIDER, environment),
        createdToday: await countOrgCheckoutsSince(tx, input.organizationId, new Date(now.getTime() - DAY_MS)),
      };
    });
    // evaluateGate 가 통과했으면 billing·provider·가격이 있다.
    const deps = billing as AdminBillingDependencies;
    const provider = first.provider as BillingProviderApi;

    // ② 공급자 거래 상태(트랜잭션 밖 · 병렬) — 재사용 후보를 뺀 열린 거래(요금제 무관 · 최근 24시간 · 새것부터 5건)가 이미 결제됐는가(M-2 · N-1) ·
    //    같은 요금제 거래를 다시 써도 되는가(M-8). `listOpenCheckouts` 는 새것부터 준다.
    const since = now.getTime() - OPEN_STATUS_WINDOW_MS;
    const others = first.open
      .filter((checkout) => checkout.transaction_id !== first.reuse?.transaction_id && checkout.created_at.getTime() > since)
      .slice(0, OPEN_STATUS_MAX);
    const statuses = await transactionStatuses(provider, [...others.map((checkout) => checkout.transaction_id), ...(first.reuse === null ? [] : [first.reuse.transaction_id])]);
    const paid = (id: string): boolean => PAID_TRANSACTION_STATUSES.has(statuses.get(id) ?? '');
    if (others.some((checkout) => paid(checkout.transaction_id))) throw lockedError('subscription_exists');
    if (first.reuse !== null) {
      if (paid(first.reuse.transaction_id)) throw lockedError('subscription_exists');
      if (REUSABLE_TRANSACTION_STATUSES.has(statuses.get(first.reuse.transaction_id) ?? '')) {
        return { transactionId: first.reuse.transaction_id, reused: true, cancels: [] as string[], provider };
      }
    }

    // ③ 새 거래 — 하루 상한 · 가격 1:1 · 공유 고객이면 미리 채우지 않는다 · Paddle 은 트랜잭션 밖(세션 잠금만 쥔다).
    if (first.createdToday >= CHECKOUT_DAILY_LIMIT) {
      throw new AdminInputError('오늘 만든 결제 거래가 상한에 닿았다.', 'billing_checkout_limit', 429);
    }
    const priceId = priceForPlan(deps.prices, plan) as string;
    if (planForPrice(deps.prices, priceId) !== plan) throw new AdminInputError('가격표가 1:1 이 아니다.', 'billing_unavailable', 409);
    const customerId = first.customer === null || first.customer.shared ? null : first.customer.customerId;
    let created;
    try {
      created = await provider.createTransaction({ priceId, organizationId: input.organizationId, customerId, checkoutBaseUrl: `${PAY_ORIGIN}/` });
    } catch {
      throw new BillingProviderFailure();
    }
    if (!paddleCheckoutUrlOk(created.checkoutUrl, created.id)) {
      await provider.cancelTransaction(created.id).catch(() => undefined);
      throw new BillingProviderFailure();
    }
    const transactionId = created.id;

    // ④ 잠금 · INSERT · 다른 열린 거래(다시 쓰지 못한 같은 요금제 거래 포함)는 superseded · 감사. 세션 잠금을 쥐고 있어 그사이 끼어든 거래는 없다.
    return inTransaction(client, async (tx) => {
      await lockOrgCheckout(tx, input.organizationId);
      const row = await insertCheckout(tx, {
        organizationId: input.organizationId,
        provider: PROVIDER,
        environment: deps.environment,
        transactionId,
        plan,
        createdByUserId: input.userId,
      });
      const superseded: string[] = [];
      for (const open of await listOpenCheckouts(tx, input.organizationId, deps.environment)) {
        if (open.transaction_id !== transactionId && (await supersedeCheckout(tx, open.transaction_id))) superseded.push(open.transaction_id);
      }
      await input.audit(tx, row.id);
      return { transactionId, reused: false, cancels: superseded, provider };
    });
  });
  // 공급자 쪽 취소는 잠금 밖에서 best-effort(병렬 — 한 번의 5초). superseded 거래는 우리 거래라 열린 탭에서 결제되면 결속된다 — 받은 돈을 잃지
  // 않고, 이중 구독은 결정 함수의 최고 요금제 규칙이 흡수한다(다음 체크아웃은 ② 가 막는다).
  await Promise.all(outcome.cancels.map((id) => outcome.provider.cancelTransaction(id).catch(() => undefined)));
  return { url: checkoutPageUrl(outcome.transactionId, input.lang), reused: outcome.reused };
}

/** 포털 URL 호스트 — Paddle 고객 포털(미확인 ② — 샌드박스 E2E 로 확정한다). 이 밖이면 502. */
const PORTAL_HOST_SHAPE = /^([a-z0-9-]+\.)*paddle\.com$/;

/**
 * 그 고객의 구독(공급자 목록 · 상태 다섯 모두 — 해지 포함 · 트랜잭션 밖)이 **전부** 이 조직 것인가 — 거래에서 복사된 `custom_data` 조직으로 본다
 * (우리 표에 없는 구독 — 결속 안 된 구독 — 까지 막는다). 상태를 명시한다(비우면 공급자 기본값이 해지를 뺄 수 있다). `PORTAL_CUSTOMER_MAX_PAGES` 를
 * 넘으면 아니라고 본다(fail-closed).
 */
async function customerSubscriptionsAllOurs(provider: BillingProviderApi, customerId: string, organizationId: string): Promise<boolean> {
  let after: string | null = null;
  for (let page = 0; page < PORTAL_CUSTOMER_MAX_PAGES; page += 1) {
    const listed: { readonly items: readonly NormalizedSubscription[]; readonly next: string | null } = await provider.listSubscriptions({
      customerId,
      statuses: PROVIDER_SUBSCRIPTION_STATUSES,
      after,
    });
    if (listed.items.some((sub) => sub.customDataOrganizationId !== organizationId)) return false;
    if (listed.next === null) return true;
    after = listed.next;
  }
  return false;
}

function sharedCustomer(): AdminInputError {
  return new AdminInputError('이 결제 고객에는 다른 조직의 구독도 있다 — 결제 관리를 열지 않는다.', 'billing_portal_shared_customer', 409);
}

/**
 * `POST /api/billing/portal` — 결속 고객이 있어야 하고, 그 고객의 구독이 상태와 무관하게 전부 이 조직 것이어야 한다(H-1 · R-1 — 머리말). URL 은 돌려주기만
 * 한다(저장·로그 없음). Paddle 호출은 목록(≤ 2쪽) + 세션 하나, 각 5초.
 */
export async function createPortalOp(
  db: Queryable,
  billing: AdminBillingDependencies | undefined,
  session: { readonly organizationId: string; readonly role: MemberRole },
): Promise<{ readonly url: string }> {
  if (!roleAtLeast(session.role, 'admin')) throw lockedError('role');
  if (billing === undefined || !billing.enabled) throw lockedError('disabled');
  const rows = await loadBillingOverviewRows(db, session.organizationId, billing.environment);
  if (rows === BILLING_TABLES_MISSING) throw lockedError('disabled');
  const provider = await billing.loadProvider();
  if (provider === null) throw lockedError('disabled');
  const customer = await loadOrgCustomer(db, session.organizationId, PROVIDER, billing.environment);
  if (customer === null) throw new AdminInputError('결속된 결제 고객이 없다.', 'billing_no_customer', 409);
  // 청구 이메일이 에이전트 주소다(ADR-0014 결정 8 — sync 가 `atmark_is_agent_mail_identity` 로 적은 표시) — 포털을 열지 않는다(포털 로그인 메일이
  // 에이전트에게 가면 에이전트가 결제를 관리한다). 운영자에게 청구 이메일 변경을 요청한다.
  const flagged = await db.query<{ flagged: boolean }>('SELECT billing_email_is_agent AS flagged FROM organizations WHERE id = $1', [session.organizationId]);
  if (flagged.rows[0]?.flagged === true) {
    throw new AdminInputError('청구 이메일이 에이전트 주소다 — 결제 관리를 열지 않는다. 청구 이메일을 사람 주소로 바꿔 달라고 운영자에게 요청한다.', DOMAIN_API_ERRORS.billingEmailIsAgent, 409);
  }
  // 우리 표 — 다른 조직에 결속된 그 고객의 구독(상태 무관).
  if (await customerHasOtherOrgSubscription(db, session.organizationId, PROVIDER, billing.environment, customer.customerId)) throw sharedCustomer();
  // 공급자 목록 — 우리 표에 없는 구독까지.
  let ours: boolean;
  try {
    ours = await customerSubscriptionsAllOurs(provider, customer.customerId, session.organizationId);
  } catch {
    throw new BillingProviderFailure();
  }
  if (!ours) throw sharedCustomer();
  // 포털 세션의 구독 id 는 admin 롤이 읽을 수 없다(칸 권한) — 고객 단위 포털을 연다(빈 목록).
  let url: string;
  try {
    ({ url } = await provider.createPortalSession({ customerId: customer.customerId, subscriptionIds: [] }));
  } catch {
    throw new BillingProviderFailure();
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BillingProviderFailure();
  }
  if (parsed.protocol !== 'https:' || !PORTAL_HOST_SHAPE.test(parsed.hostname) || parsed.port !== '' || parsed.username !== '') throw new BillingProviderFailure();
  return { url: parsed.toString() };
}
