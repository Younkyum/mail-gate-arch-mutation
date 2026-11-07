/**
 * 콘솔 결제 라우트(WP-2 — 계획 §Step 3 수용 기준 4 · D-5 owner + admin) — 실제 Postgres · **admin 롤(`atmark_admin`)** · 실제 라우터 · 가짜 공급자.
 *
 *   ① 역할: member 는 `GET /api/billing` 만(canManage false · 잠금 사유 role) · 체크아웃·포털은 403 `forbidden_role` · owner·admin 은 허용.
 *   ② 체크아웃: 서버가 Paddle 거래를 만든다(custom_data 조직 = 세션 조직 — 본문의 조직은 무시) · `billing_checkouts` open · 감사 1행 ·
 *      `https://pay.atmark.ai/?_ptxn=…` · 다른 요금제로 다시 누르면 옛 거래 superseded + Paddle 취소 · **동시 두 요청 → 하나는 409
 *      `billing_checkout_busy`(기다리지 않는다), Paddle 생성 1회** · 하루 상한 10 → 429 `billing_checkout_limit`(보안 M-1).
 *      재사용 후보를 뺀 열린 거래(요금제 무관 — 30분 지난 같은 요금제 거래 포함)가 Paddle 에서 이미 completed/paid → 409
 *      `billing_subscription_exists`(M-2 · N-1) · 상태 조회는 최근 24시간 · 5건까지 · 같은 요금제 거래는 ready/draft 일 때만 다시 쓰고 아니면 새로
 *      만든다(M-8) · 공유 고객이면 customer 를 미리 채우지 않는다(H-1).
 *   ③ 잠금: 검토 전 403 · 스위치 꺼짐·키 없음·가격 없음 409 `billing_unavailable` · beta 409 `billing_beta_locked` · 지배 못 함 409
 *      `billing_plan_not_higher` · 비종단 구독 409 · 샌드박스 허용 목록 밖 409 · 모르는 요금제 400 · 돌아온 URL 출처 ≠ pay.atmark.ai → 502.
 *   ④ 포털: 결속 고객 필요(409) · Paddle 호스트만(502) · URL 은 저장·로그되지 않는다 · 그 고객의 구독이 상태와 무관하게 전부 이 조직 것일 때만 —
 *      우리 표(다른 조직에 결속된 구독 — 해지 포함)나 Paddle 목록(상태 다섯 · 다른 조직 custom_data)에 남의 것이 있으면 409
 *      `billing_portal_shared_customer`(H-1 · R-1).
 *   ⑤ 결제 표가 없으면(마이그레이션 0400 전): 개요는 잠김(오류 없음) · 체크아웃·포털은 409 거부.
 */

import { randomBytes } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { billingOverviewOp, CHECKOUT_DAILY_LIMIT, createCheckoutOp, createPortalOp, OPEN_STATUS_MAX } from '../../../src/admin/ops/billing';
import { AdminInputError } from '../../../src/admin/ops/errors';
import type { PaidPlanCode } from '../../../src/billing/plans';
import type {
  AdminBillingDependencies,
  BillingProviderApi,
  CreatePortalSessionInput,
  CreateTransactionInput,
  ListSubscriptionsQuery,
  NormalizedSubscription,
  NormalizedTransaction,
  SubscriptionPage,
} from '../../../src/billing/provider';
import { ProviderNotFoundError, ProviderUnavailableError } from '../../../src/billing/provider';
import { bindCustomer, bindSubscription, insertCheckout, supersedeCheckout } from '../../../src/db/repositories/billing';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import {
  adminDeps,
  adminRolePool,
  authed,
  AVAILABLE,
  call,
  login,
  loginMailerPool,
  newOrganization,
  ownerPool,
  suffix,
  userIdOf,
  type Session,
} from './support';

const id26 = (): string => randomBytes(13).toString('hex');
const PRICES: Readonly<Record<string, PaidPlanCode>> = { [`pri_${'a'.repeat(26)}`]: 'pro', [`pri_${'b'.repeat(26)}`]: 'team', [`pri_${'c'.repeat(26)}`]: 'scale' };
const PORTAL = `https://sandbox-customer-portal.paddle.com/cpl_${id26()}?token=pga_secret_${id26()}`;

/** 가짜 admin 공급자 — 거래 생성(지연 가능)·상태 조회·취소·포털 · 고객의 구독 목록. */
class FakeAdminProvider implements BillingProviderApi {
  readonly provider = 'paddle' as const;
  readonly environment = 'sandbox' as const;
  readonly created: CreateTransactionInput[] = [];
  readonly canceled: string[] = [];
  /** 거래 상태(공급자 쪽) — 만든 거래는 `ready`. 여기 없는 거래는 404. */
  readonly statuses = new Map<string, string>();
  /** 고객 → 그 고객의 구독(Paddle 목록). */
  readonly customerSubscriptions = new Map<string, NormalizedSubscription[]>();
  readonly listed: ListSubscriptionsQuery[] = [];
  delayMs = 0;
  checkoutUrl: ((id: string) => string) | null = null;
  portalUrl = PORTAL;
  failCreate = false;

  async createTransaction(input: CreateTransactionInput): Promise<NormalizedTransaction> {
    this.created.push(input);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failCreate) throw new ProviderUnavailableError('provider_unavailable', 'http_503');
    const id = `txn_${id26()}`;
    this.statuses.set(id, 'ready');
    return {
      provider: 'paddle',
      environment: 'sandbox',
      id,
      status: 'ready',
      subscriptionId: null,
      customerId: input.customerId,
      customDataOrganizationId: input.organizationId,
      createdAt: new Date(),
      checkoutUrl: this.checkoutUrl === null ? `${input.checkoutBaseUrl}?_ptxn=${id}` : this.checkoutUrl(id),
    };
  }
  cancelTransaction(id: string): Promise<void> {
    this.canceled.push(id);
    return Promise.resolve();
  }
  createPortalSession(_input: CreatePortalSessionInput): Promise<{ readonly url: string }> {
    return Promise.resolve({ url: this.portalUrl });
  }
  fetchSubscription(): Promise<never> {
    return Promise.reject(new Error('admin 은 구독을 재조회하지 않는다'));
  }
  listSubscriptions(query: ListSubscriptionsQuery): Promise<SubscriptionPage> {
    this.listed.push(query);
    if (query.customerId === undefined) return Promise.reject(new Error('admin 은 고객 단위 목록만 본다'));
    const statuses = query.statuses ?? ['active', 'trialing', 'past_due', 'paused'];
    const items = (this.customerSubscriptions.get(query.customerId) ?? []).filter((sub) => statuses.includes(sub.status));
    return Promise.resolve({ items, next: null });
  }
  fetchTransaction(id: string): Promise<NormalizedTransaction> {
    const status = this.statuses.get(id);
    if (status === undefined) return Promise.reject(new ProviderNotFoundError());
    return Promise.resolve({ provider: 'paddle', environment: 'sandbox', id, status, subscriptionId: null, customerId: null, customDataOrganizationId: null, createdAt: new Date(), checkoutUrl: null });
  }
  listTransactionsBySubscription(): Promise<never> {
    return Promise.reject(new Error('admin 은 거래 목록을 보지 않는다'));
  }
}

describe.skipIf(!AVAILABLE)('콘솔 결제 라우트 — admin 롤 · 가짜 공급자', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), mailer.end()]);
  });
  afterEach(() => resetLogSink());

  function billingDeps(provider: FakeAdminProvider | null, allow: readonly string[], overrides: Partial<AdminBillingDependencies> = {}): AdminDependencies {
    return adminDeps(admin, {
      billing: { environment: 'sandbox', enabled: true, loadProvider: () => Promise.resolve(provider), prices: PRICES, sandboxAllowlist: allow, ...overrides },
    });
  }

  /** 조직(요금제 행 선택) + 그 조직의 owner 세션. */
  async function ownerOf(deps: AdminDependencies, plan: 'beta' | 'pro' | null = null) {
    const org = await newOrganization(owner, plan);
    return { org, session: await login(deps, mailer, org) };
  }

  /** 같은 조직의 다른 역할 사용자 세션(멤버십은 소유자 롤로 직접 — 초대 흐름은 members 테스트가 본다). */
  async function roleSession(deps: AdminDependencies, organizationId: string, role: 'admin' | 'member'): Promise<Session> {
    const email = `billing-${role}-${suffix()}@example.com`;
    await owner.query('INSERT INTO users (email) VALUES ($1)', [email]);
    const userId = await userIdOf(owner, email);
    await owner.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, $3, 'invite')`, [userId, organizationId, role]);
    return login(deps, mailer, { id: organizationId, ownerEmail: email });
  }

  it('① 역할 — member 는 보기만(canManage false · role 잠금) · 체크아웃·포털 403 forbidden_role · owner·admin 허용', async () => {
    const provider = new FakeAdminProvider();
    const probe = billingDeps(provider, []);
    const { org, session } = await ownerOf(probe);
    const deps = billingDeps(provider, [org.id]);
    const member = await roleSession(deps, org.id, 'member');
    const viewed = await call(deps, 'GET', '/api/billing', authed(member));
    expect(viewed.statusCode).toBe(200);
    expect(viewed.json()).toMatchObject({ enabled: true, canManage: false, upgradeAvailable: false, lockedReason: 'role', portalAvailable: false });
    for (const path of ['/api/billing/checkout', '/api/billing/portal']) {
      const denied = await call(deps, 'POST', path, authed(member, { body: { plan: 'pro' } }));
      expect(denied.statusCode, path).toBe(403);
      expect(denied.json(), path).toMatchObject({ error: 'forbidden_role' });
    }
    expect(provider.created).toHaveLength(0);

    const mine = await call(deps, 'GET', '/api/billing', authed(session));
    expect(mine.json()).toMatchObject({
      enabled: true,
      environment: 'sandbox',
      canManage: true,
      upgradeAvailable: true,
      lockedReason: null,
      plans: [
        { code: 'pro', available: true },
        { code: 'team', available: true },
        { code: 'scale', available: true },
      ],
      subscription: null,
    });
    const adminUser = await roleSession(deps, org.id, 'admin');
    const byAdmin = await call(deps, 'POST', '/api/billing/checkout', authed(adminUser, { body: { plan: 'team' } }));
    expect(byAdmin.statusCode).toBe(200);
  });

  it('② 체크아웃 — 서버가 조직을 넣는다 · open 행 · 감사 · pay.atmark.ai URL · 다른 요금제면 옛 거래 superseded + 취소', async () => {
    const provider = new FakeAdminProvider();
    const { org, session } = await ownerOf(billingDeps(provider, []));
    const deps = billingDeps(provider, [org.id]);
    const other = await newOrganization(owner, null);
    // 본문에 다른 조직을 넣어도 무시된다 — 거래의 조직은 세션의 것.
    const first = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'pro', organizationId: other.id } }));
    expect(first.statusCode).toBe(200);
    const url = (first.json() as { url: string }).url;
    expect(url).toMatch(/^https:\/\/pay\.atmark\.ai\/kr\?_ptxn=txn_[a-z0-9]{26}$/); // 언어 쿠키 없음 = 한국어 → /kr(2026-09-30)
    expect(provider.created.map((input) => input.organizationId)).toEqual([org.id]);
    expect(provider.created[0]).toMatchObject({ priceId: `pri_${'a'.repeat(26)}`, customerId: null, checkoutBaseUrl: 'https://pay.atmark.ai/' });
    const txn = new URL(url).searchParams.get('_ptxn');
    const rows = await owner.query<{ transaction_id: string; status: string; plan_code: string; created_by_user_id: string }>(
      'SELECT transaction_id, status, plan_code, created_by_user_id::text AS created_by_user_id FROM billing_checkouts WHERE organization_id = $1',
      [org.id],
    );
    expect(rows.rows).toEqual([{ transaction_id: txn, status: 'open', plan_code: 'pro', created_by_user_id: await userIdOf(owner, org.ownerEmail) }]);
    const audit = await owner.query<{ action: string }>(`SELECT action FROM owner_actions WHERE organization_id = $1 AND action LIKE 'billing.%'`, [org.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['billing.checkout']);

    // 같은 요금제 다시 → 같은 거래(상태 ready 확인만 — 생성 0) · 다른 요금제 → 새 거래 + 옛 것 superseded + Paddle 취소.
    const again = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'pro' } }));
    expect(again.json()).toEqual({ url, reused: true });
    expect(provider.created).toHaveLength(1);
    const team = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'team' } }));
    expect(team.statusCode).toBe(200);
    expect(provider.canceled).toEqual([txn]);
    const statuses = await owner.query<{ plan_code: string; status: string }>('SELECT plan_code, status FROM billing_checkouts WHERE organization_id = $1 ORDER BY created_at', [org.id]);
    expect(statuses.rows).toEqual([
      { plan_code: 'pro', status: 'superseded' },
      { plan_code: 'team', status: 'open' },
    ]);
    // 영어 화면은 /en 결제 페이지.
    const en = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'team' }, cookies: { '__Host-atmark_lang': 'en' } }));
    expect((en.json() as { url: string }).url).toMatch(/^https:\/\/pay\.atmark\.ai\/\?_ptxn=txn_/); // 영어가 기본 경로
  });

  it('② 동시 두 요청(중복 클릭) → 하나는 200 · 하나는 409 billing_checkout_busy(기다리지 않는다) · Paddle 생성 1회 · 뒤에 다시 누르면 같은 거래', async () => {
    const provider = new FakeAdminProvider();
    provider.delayMs = 150;
    const { org, session } = await ownerOf(billingDeps(provider, []));
    const deps = billingDeps(provider, [org.id]);
    const [a, b] = await Promise.all([
      call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'scale' } })),
      call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'scale' } })),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const busy = a.statusCode === 409 ? a : b;
    expect(busy.json()).toMatchObject({ error: 'billing_checkout_busy' });
    expect(provider.created).toHaveLength(1);
    const rows = await owner.query('SELECT 1 FROM billing_checkouts WHERE organization_id = $1', [org.id]);
    expect(rows.rowCount).toBe(1);
    const again = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'scale' } }));
    expect(again.json()).toMatchObject({ reused: true, url: ((a.statusCode === 200 ? a : b).json() as { url: string }).url });
  });

  it('② 세션 잠금을 다른 연결이 쥐고 있으면 곧바로 409 billing_checkout_busy(공급자 호출 0)', async () => {
    const provider = new FakeAdminProvider();
    const { org, session } = await ownerOf(billingDeps(provider, []));
    const deps = billingDeps(provider, [org.id]);
    const holder = await owner.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended('billing_checkout:' || $1::text, 0))`, [org.id]);
      const started = Date.now();
      const busy = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'pro' } }));
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toMatchObject({ error: 'billing_checkout_busy' });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(provider.created).toHaveLength(0);
    } finally {
      await holder.query(`SELECT pg_advisory_unlock_all()`);
      holder.release();
    }
  });

  it('② 하루 상한 — 24시간 안에 만든 거래가 10 이면 새 거래는 429 billing_checkout_limit · ready 인 같은 요금제 거래는 그대로 다시 쓴다', async () => {
    const provider = new FakeAdminProvider();
    const { org, session } = await ownerOf(billingDeps(provider, []));
    const deps = billingDeps(provider, [org.id]);
    const userId = await userIdOf(owner, org.ownerEmail);
    const first = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'pro' } }));
    expect(first.statusCode).toBe(200);
    // 그 밖의 거래 아홉(이미 superseded 등 — 상태와 무관하게 센다).
    for (let i = 0; i < CHECKOUT_DAILY_LIMIT - 1; i += 1) {
      const txn = `txn_${id26()}`;
      await insertCheckout(admin, { organizationId: org.id, provider: 'paddle', environment: 'sandbox', transactionId: txn, plan: 'pro', createdByUserId: userId });
      await supersedeCheckout(admin, txn);
    }
    const limited = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'team' } }));
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'billing_checkout_limit' });
    expect(provider.created).toHaveLength(1);
    const reused = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'pro' } }));
    expect(reused.json()).toMatchObject({ reused: true, url: (first.json() as { url: string }).url });
  });

  it('② M-2 · M-8 — 다른 요금제 거래가 이미 결제됨 → 409 subscription_exists · 같은 요금제 거래가 ready/draft 가 아니면 새로 만든다', async () => {
    const provider = new FakeAdminProvider();
    const { org, session } = await ownerOf(billingDeps(provider, []));
    const deps = billingDeps(provider, [org.id]);
    const pro = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'pro' } }));
    const proTxn = new URL((pro.json() as { url: string }).url).searchParams.get('_ptxn') ?? '';
    // pro 거래가 Paddle 에서 결제됐다(웹훅 → sync 가 아직 반영 전).
    for (const status of ['completed', 'paid']) {
      provider.statuses.set(proTxn, status);
      const blocked = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'team' } }));
      expect(blocked.statusCode, status).toBe(409);
      expect(blocked.json(), status).toMatchObject({ error: 'billing_subscription_exists' });
      // 같은 요금제로 다시 눌러도 결제된 거래를 돌려주지 않는다.
      const same = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'pro' } }));
      expect(same.json(), status).toMatchObject({ error: 'billing_subscription_exists' });
    }
    expect(provider.created).toHaveLength(1);
    // Paddle 에서 취소된 같은 요금제 거래 → 새 거래 · 옛 것은 superseded.
    provider.statuses.set(proTxn, 'canceled');
    const fresh = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'pro' } }));
    expect(fresh.json()).toMatchObject({ reused: false });
    expect(new URL((fresh.json() as { url: string }).url).searchParams.get('_ptxn')).not.toBe(proTxn);
    const rows = await owner.query<{ transaction_id: string; status: string }>('SELECT transaction_id, status FROM billing_checkouts WHERE organization_id = $1 ORDER BY created_at', [org.id]);
    expect(rows.rows.map((r) => r.status)).toEqual(['superseded', 'open']);
    // draft 도 다시 쓴다 · 상태 조회 실패는 502(모른 채 새 거래를 만들지 않는다).
    const freshTxn = new URL((fresh.json() as { url: string }).url).searchParams.get('_ptxn') ?? '';
    provider.statuses.set(freshTxn, 'draft');
    expect((await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'pro' } }))).json()).toMatchObject({ reused: true });
    const failing = new FakeAdminProvider();
    failing.fetchTransaction = () => Promise.reject(new ProviderUnavailableError('provider_unavailable', 'http_503'));
    const down = await call(billingDeps(failing, [org.id]), 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'team' } }));
    expect(down.statusCode).toBe(502);
    expect(failing.created).toHaveLength(0);
  });

  /** 거래의 created_at 을 과거로 옮긴다(가드 트리거가 막는 칸이라 소유자 롤로 잠깐 끄고 — 한 트랜잭션). */
  async function backdateCheckout(transactionId: string, minutes: number): Promise<void> {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE billing_checkouts DISABLE TRIGGER billing_checkouts_guard');
      await client.query(`UPDATE billing_checkouts SET created_at = now() - make_interval(mins => $2) WHERE transaction_id = $1`, [transactionId, minutes]);
      await client.query('ALTER TABLE billing_checkouts ENABLE TRIGGER billing_checkouts_guard');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('② N-1 — 같은 요금제 31분 전 거래(재사용 창 밖)가 Paddle 에서 paid → 409 subscription_exists · 새 거래를 만들지 않는다', async () => {
    const provider = new FakeAdminProvider();
    const { org, session } = await ownerOf(billingDeps(provider, []));
    const deps = billingDeps(provider, [org.id]);
    const first = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'pro' } }));
    const txn = new URL((first.json() as { url: string }).url).searchParams.get('_ptxn') ?? '';
    await backdateCheckout(txn, 31);
    provider.statuses.set(txn, 'paid');
    const again = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'pro' } }));
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'billing_subscription_exists' });
    expect(provider.created).toHaveLength(1);
    const rows = await owner.query<{ status: string }>('SELECT status FROM billing_checkouts WHERE organization_id = $1', [org.id]);
    expect(rows.rows).toEqual([{ status: 'open' }]);
    // 결제되지 않았으면(ready) 창 밖이라 다시 쓰지 않고 새로 만든다 — 옛 것은 superseded.
    provider.statuses.set(txn, 'ready');
    const fresh = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'pro' } }));
    expect(fresh.json()).toMatchObject({ reused: false });
    expect(provider.created).toHaveLength(2);
  });

  it('② N-1 상한 — 상태 조회는 최근 24시간 안의 열린 거래 새것부터 5건뿐(24시간 넘은 것 · 여섯째는 부르지 않는다)', async () => {
    const provider = new FakeAdminProvider();
    const { org, session } = await ownerOf(billingDeps(provider, []));
    const deps = billingDeps(provider, [org.id]);
    const userId = await userIdOf(owner, org.ownerEmail);
    const open: string[] = [];
    for (let i = 0; i < OPEN_STATUS_MAX + 2; i += 1) {
      const txn = `txn_${id26()}`;
      await insertCheckout(admin, { organizationId: org.id, provider: 'paddle', environment: 'sandbox', transactionId: txn, plan: 'team', createdByUserId: userId });
      // 앞의 것일수록 오래됐다 — 첫째는 25시간 전(창 밖), 나머지는 몇 분 간격.
      await backdateCheckout(txn, i === 0 ? 25 * 60 : 60 - i);
      provider.statuses.set(txn, 'ready');
      open.push(txn);
    }
    const fetched: string[] = [];
    const fetchTransaction = provider.fetchTransaction.bind(provider);
    provider.fetchTransaction = (id: string) => {
      fetched.push(id);
      return fetchTransaction(id);
    };
    // 창 밖(25시간 전) 거래가 paid 여도 조회하지 않는다 — 결제됐다면 이미 결속돼 허용 조건이 막는다.
    provider.statuses.set(open[0] ?? '', 'paid');
    const result = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan: 'pro' } }));
    expect(result.statusCode).toBe(200);
    expect(fetched).toHaveLength(OPEN_STATUS_MAX);
    // 새것부터 다섯 — 가장 오래된 둘(창 밖 하나 · 여섯째 하나)은 부르지 않았다.
    expect([...fetched].sort()).toEqual(open.slice(-OPEN_STATUS_MAX).sort());
  });

  it('② H-1 — 결속 고객이 다른 조직과 공유되면 체크아웃에 customer 를 미리 채우지 않는다 · 혼자면 채운다', async () => {
    const provider = new FakeAdminProvider();
    const solo = await ownerOf(billingDeps(provider, []));
    const soloCustomer = `ctm_${id26()}`;
    await bindCustomer(owner, solo.org.id, 'paddle', 'sandbox', soloCustomer);
    await call(billingDeps(provider, [solo.org.id]), 'POST', '/api/billing/checkout', authed(solo.session, { body: { plan: 'pro' } }));
    expect(provider.created.at(-1)).toMatchObject({ customerId: soloCustomer });

    const shared = await ownerOf(billingDeps(provider, []));
    const other = await newOrganization(owner, null);
    const sharedCustomer = `ctm_${id26()}`;
    await bindCustomer(owner, other.id, 'paddle', 'sandbox', sharedCustomer);
    await bindCustomer(owner, shared.org.id, 'paddle', 'sandbox', sharedCustomer);
    await call(billingDeps(provider, [shared.org.id]), 'POST', '/api/billing/checkout', authed(shared.session, { body: { plan: 'pro' } }));
    expect(provider.created.at(-1)).toMatchObject({ customerId: null, organizationId: shared.org.id });
  });

  it('③ 잠금 — 검토 전 · 스위치·키·가격 · beta · 지배 못 함 · 비종단 구독 · 샌드박스 목록 밖 · 모르는 요금제 · 엉뚱한 URL', async () => {
    const provider = new FakeAdminProvider();
    const expectCheckout = async (deps: AdminDependencies, session: Session, plan: string, status: number, error: string): Promise<void> => {
      const result = await call(deps, 'POST', '/api/billing/checkout', authed(session, { body: { plan } }));
      expect(result.statusCode, `${plan} ${error}`).toBe(status);
      expect(result.json(), `${plan} ${error}`).toMatchObject({ error });
    };

    const pending = await ownerOf(billingDeps(provider, []));
    await owner.query(`UPDATE organizations SET review_status = 'pending_review' WHERE id = $1`, [pending.org.id]);
    await expectCheckout(billingDeps(provider, [pending.org.id]), pending.session, 'pro', 403, 'billing_org_not_active');

    const free = await ownerOf(billingDeps(provider, []));
    const allow = [free.org.id];
    await expectCheckout(billingDeps(provider, allow, { enabled: false }), free.session, 'pro', 409, 'billing_unavailable');
    await expectCheckout(billingDeps(null, allow), free.session, 'pro', 409, 'billing_unavailable');
    // 키가 자리표시·오류(admin 조립의 loadProvider 가 null — N-3)면 결제만 잠긴다: 개요는 200 · not_configured · 포털 409.
    const keyless = await call(billingDeps(null, allow), 'GET', '/api/billing', authed(free.session));
    expect(keyless.statusCode).toBe(200);
    expect(keyless.json()).toMatchObject({ enabled: true, lockedReason: 'not_configured', upgradeAvailable: false, portalAvailable: false });
    expect((await call(billingDeps(null, allow), 'POST', '/api/billing/portal', authed(free.session))).json()).toMatchObject({ error: 'billing_unavailable' });
    await expectCheckout(billingDeps(provider, allow, { prices: {} }), free.session, 'pro', 409, 'billing_unavailable');
    await expectCheckout(billingDeps(provider, allow, { prices: { [`pri_${'b'.repeat(26)}`]: 'team' } }), free.session, 'pro', 409, 'billing_unavailable');
    await expectCheckout(billingDeps(provider, []), free.session, 'pro', 409, 'billing_sandbox_not_allowed');
    await expectCheckout(billingDeps(provider, allow), free.session, 'gold', 400, 'invalid_plan');
    await expectCheckout(billingDeps(provider, allow), free.session, 'beta', 400, 'invalid_plan');
    const offView = await call(adminDeps(admin), 'GET', '/api/billing', authed(free.session));
    expect(offView.json()).toMatchObject({ enabled: false, environment: null, lockedReason: 'disabled', upgradeAvailable: false });

    const beta = await ownerOf(billingDeps(provider, []), 'beta');
    await expectCheckout(billingDeps(provider, [beta.org.id]), beta.session, 'scale', 409, 'billing_beta_locked');

    // 운영자가 에이전트 20 을 준 pro 행 — pro 는 지배하지 못하고 team 은 지배한다.
    const override = await newOrganization(owner, null);
    await owner.query(
      `WITH audit AS (INSERT INTO billing_audit (organization_id, from_plan, to_plan, cause, actor, entitlement_version) VALUES ($1, NULL, 'pro', 'operator', 'test', 1))
       INSERT INTO org_entitlements (organization_id, plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max, agent_per_minute_max,
         recipients_per_message_max, tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes, version)
       VALUES ($1, 'pro', 'operator', 'operator', 20, 1000, 300, 30, 25, 5, 3, 2, 10737418240, 1)`,
      [override.id],
    );
    const overrideSession = await login(billingDeps(provider, []), mailer, override);
    const overrideDeps = billingDeps(provider, [override.id]);
    expect((await call(overrideDeps, 'GET', '/api/billing', authed(overrideSession))).json()).toMatchObject({
      lockedReason: null,
      plans: [
        { code: 'pro', available: false },
        { code: 'team', available: true },
        { code: 'scale', available: true },
      ],
    });
    await expectCheckout(overrideDeps, overrideSession, 'pro', 409, 'billing_plan_not_higher');

    // 결속된 비종단 구독이 있으면 409(요금제 간 변경은 결제 관리에서 — D-4 범위 밖).
    const subscribed = await ownerOf(billingDeps(provider, []));
    const txn = `txn_${id26()}`;
    await insertCheckout(admin, { organizationId: subscribed.org.id, provider: 'paddle', environment: 'sandbox', transactionId: txn, plan: 'pro', createdByUserId: await userIdOf(owner, subscribed.org.ownerEmail) });
    await bindSubscription(
      owner,
      {
        provider: 'paddle',
        providerSubscriptionId: `sub_${id26()}`,
        environment: 'sandbox',
        providerCustomerId: `ctm_${id26()}`,
        status: 'past_due',
        planCode: 'pro',
        priceId: `pri_${'a'.repeat(26)}`,
        currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
        scheduledChangeAction: null,
        scheduledChangeAt: null,
        pastDueSince: new Date('2026-10-01T00:00:00Z'),
        providerUpdatedAt: new Date(),
      },
      subscribed.org.id,
      txn,
    );
    const subDeps = billingDeps(provider, [subscribed.org.id]);
    await expectCheckout(subDeps, subscribed.session, 'team', 409, 'billing_subscription_exists');
    expect((await call(subDeps, 'GET', '/api/billing', authed(subscribed.session))).json()).toMatchObject({
      lockedReason: 'subscription_exists',
      subscription: { status: 'past_due', plan: 'pro', currentPeriodEnd: '2026-11-01T00:00:00.000Z', scheduledChange: null, graceUntil: '2026-10-15T00:00:00.000Z' },
    });

    // 돌아온 URL 이 우리 결제 페이지가 아니면 502 · 그 거래는 취소 시도 · 표에 없다. 공급자 실패도 502.
    const wrong = new FakeAdminProvider();
    wrong.checkoutUrl = (id) => `https://checkout.paddle.com/?_ptxn=${id}`;
    await expectCheckout(billingDeps(wrong, allow), free.session, 'pro', 502, 'billing_provider_error');
    expect(wrong.canceled).toHaveLength(1);
    const failing = new FakeAdminProvider();
    failing.failCreate = true;
    await expectCheckout(billingDeps(failing, allow), free.session, 'pro', 502, 'billing_provider_error');
    expect((await owner.query('SELECT 1 FROM billing_checkouts WHERE organization_id = $1', [free.org.id])).rowCount).toBe(0);
  });

  it('④ 포털 — 결속 고객 필요 · Paddle 호스트만 · URL 은 저장·로그되지 않는다', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const provider = new FakeAdminProvider();
    const { org, session } = await ownerOf(billingDeps(provider, []));
    const deps = billingDeps(provider, [org.id]);
    const none = await call(deps, 'POST', '/api/billing/portal', authed(session));
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ error: 'billing_no_customer' });
    expect((await call(deps, 'GET', '/api/billing', authed(session))).json()).toMatchObject({ portalAvailable: false });

    await bindCustomer(owner, org.id, 'paddle', 'sandbox', `ctm_${id26()}`);
    expect((await call(deps, 'GET', '/api/billing', authed(session))).json()).toMatchObject({ portalAvailable: true });
    const opened = await call(deps, 'POST', '/api/billing/portal', authed(session));
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toEqual({ url: PORTAL });
    const token = new URL(PORTAL).searchParams.get('token') ?? 'x';
    expect(lines.filter((line) => line.includes(token) || line.includes('customer-portal'))).toEqual([]);
    const stored = await owner.query(`SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1 AND action = 'billing.portal' AND target_id IS NULL`, [org.id]);
    expect(stored.rows[0]).toEqual({ n: 1 });

    provider.portalUrl = 'https://paddle.com.evil.example/cpl_x';
    const evil = await call(deps, 'POST', '/api/billing/portal', authed(session));
    expect(evil.statusCode).toBe(502);
    expect(evil.json()).toMatchObject({ error: 'billing_provider_error' });
  });

  it('④ 청구 이메일이 에이전트 주소(ADR-0014 결정 8 — billing_email_is_agent)면 포털 409 billing_email_is_agent · 공급자를 부르지 않는다', async () => {
    const provider = new FakeAdminProvider();
    const { org, session } = await ownerOf(billingDeps(provider, []));
    const deps = billingDeps(provider, [org.id]);
    await bindCustomer(owner, org.id, 'paddle', 'sandbox', `ctm_${id26()}`);
    await owner.query('UPDATE organizations SET billing_email_is_agent = true WHERE id = $1', [org.id]);
    const denied = await call(deps, 'POST', '/api/billing/portal', authed(session));
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ error: 'billing_email_is_agent' });
    await owner.query('UPDATE organizations SET billing_email_is_agent = false WHERE id = $1', [org.id]);
    expect((await call(deps, 'POST', '/api/billing/portal', authed(session))).statusCode).toBe(200);
  });

  it('④ H-1 · R-1 — 공유 고객: 다른 조직의 구독이 상태와 무관하게(해지 포함) 우리 표나 Paddle 목록에 있으면 409 billing_portal_shared_customer', async () => {
    const provider = new FakeAdminProvider();
    const { org, session } = await ownerOf(billingDeps(provider, []));
    const deps = billingDeps(provider, [org.id]);
    const customerId = `ctm_${id26()}`;
    await bindCustomer(owner, org.id, 'paddle', 'sandbox', customerId);
    const liveSub = (organizationId: string | null, status: NormalizedSubscription['status'] = 'active'): NormalizedSubscription => ({
      provider: 'paddle',
      environment: 'sandbox',
      id: `sub_${id26()}`,
      customerId,
      status,
      priceId: `pri_${'a'.repeat(26)}`,
      planCode: 'pro',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      scheduledChange: null,
      updatedAt: new Date(),
      customDataOrganizationId: organizationId,
    });
    const expectShared = async (why: string): Promise<void> => {
      const result = await call(deps, 'POST', '/api/billing/portal', authed(session));
      expect(result.statusCode, why).toBe(409);
      expect(result.json(), why).toMatchObject({ error: 'billing_portal_shared_customer' });
    };

    // 혼자 쓰는 고객 — 이 조직 구독만(해지된 자기 구독 포함) · Paddle 목록은 고객 필터 + 상태 다섯 모두(해지 포함 — 명시).
    provider.customerSubscriptions.set(customerId, [liveSub(org.id), liveSub(org.id, 'canceled')]);
    expect((await call(deps, 'POST', '/api/billing/portal', authed(session))).statusCode).toBe(200);
    expect(provider.listed.at(-1)).toMatchObject({ customerId, statuses: ['active', 'trialing', 'past_due', 'paused', 'canceled'] });

    // Paddle 목록에 다른 조직(custom_data)의 살아 있는 구독 — 우리 표에 없는(결속 안 된) 것까지 막는다.
    const other = await newOrganization(owner, null);
    provider.customerSubscriptions.set(customerId, [liveSub(org.id), liveSub(other.id, 'past_due')]);
    await expectShared('Paddle 목록');
    provider.customerSubscriptions.set(customerId, [liveSub(org.id), liveSub(null, 'paused')]);
    await expectShared('custom_data 없는 구독');
    // 해지된 남의 구독도 공유다(R-1 — 포털은 해지된 구독·영수증도 보여 준다).
    provider.customerSubscriptions.set(customerId, [liveSub(org.id), liveSub(other.id, 'canceled')]);
    await expectShared('Paddle 목록 — 해지된 다른 조직 구독');

    // 우리 표 — 같은 고객으로 다른 조직에 결속된 살아 있는 구독.
    const otherTxn = `txn_${id26()}`;
    await insertCheckout(admin, { organizationId: other.id, provider: 'paddle', environment: 'sandbox', transactionId: otherTxn, plan: 'pro', createdByUserId: await userIdOf(owner, org.ownerEmail) });
    await bindCustomer(owner, other.id, 'paddle', 'sandbox', customerId);
    const otherSubId = `sub_${id26()}`;
    await bindSubscription(
      owner,
      {
        provider: 'paddle',
        providerSubscriptionId: otherSubId,
        environment: 'sandbox',
        providerCustomerId: customerId,
        status: 'active',
        planCode: 'pro',
        priceId: `pri_${'a'.repeat(26)}`,
        currentPeriodEnd: null,
        scheduledChangeAction: null,
        scheduledChangeAt: null,
        pastDueSince: null,
        providerUpdatedAt: new Date(),
      },
      other.id,
      otherTxn,
    );
    provider.customerSubscriptions.set(customerId, [liveSub(org.id)]);
    const listedBefore = provider.listed.length;
    await expectShared('우리 표');
    // 우리 표에서 이미 걸리면 Paddle 을 부르지 않는다.
    expect(provider.listed).toHaveLength(listedBefore);
    // 우리 표의 그 구독이 해지돼도 공유다(R-1).
    await owner.query(`UPDATE billing_subscriptions SET status = 'canceled' WHERE provider_subscription_id = $1`, [otherSubId]);
    await expectShared('우리 표 — 해지된 다른 조직 구독');
    expect(provider.listed).toHaveLength(listedBefore);
  });

  it('⑤ 결제 표가 없으면(마이그레이션 0400 전) — 개요는 잠김 응답 · 체크아웃·포털은 409 거부(오류 아님)', async () => {
    // to_regclass 가 없다고 답하는 가짜 연결 — 다른 문장은 부르면 안 된다(표 없는 SELECT 는 42P01).
    const statements: string[] = [];
    const query = (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
      statements.push(text);
      if (text.includes('to_regclass')) return Promise.resolve({ rows: [{ ok: false }], rowCount: 1 });
      if (text.includes('pg_try_advisory_lock')) return Promise.resolve({ rows: [{ ok: true }], rowCount: 1 });
      if (/pg_advisory|^BEGIN|^COMMIT|^ROLLBACK/.test(text.trim())) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.reject(Object.assign(new Error(`relation does not exist: ${text.slice(0, 40)}`), { code: '42P01' }));
    };
    const client = { query, release: () => undefined } as unknown as PoolClient;
    const pool = { query, connect: () => Promise.resolve(client) } as unknown as Pool;
    const provider = new FakeAdminProvider();
    const billing: AdminBillingDependencies = { environment: 'sandbox', enabled: true, loadProvider: () => Promise.resolve(provider), prices: PRICES, sandboxAllowlist: [] };
    const orgId = '00000000-0000-4000-8000-00000000b111';

    expect(await billingOverviewOp(pool, billing, { organizationId: orgId, role: 'owner' }, new Date())).toMatchObject({
      enabled: false,
      upgradeAvailable: false,
      lockedReason: 'disabled',
      subscription: null,
      portalAvailable: false,
    });
    const checkout = await createCheckoutOp(pool, billing, { organizationId: orgId, userId: orgId, role: 'owner', plan: 'pro', lang: 'ko', audit: () => Promise.resolve() }, new Date()).catch(
      (error: unknown) => error,
    );
    expect(checkout).toBeInstanceOf(AdminInputError);
    expect(checkout).toMatchObject({ code: 'billing_unavailable', status: 409 });
    const portal = await createPortalOp(pool, billing, { organizationId: orgId, role: 'owner' }).catch((error: unknown) => error);
    expect(portal).toMatchObject({ code: 'billing_unavailable', status: 409 });
    expect(statements.filter((text) => !/to_regclass|pg_(try_)?advisory|^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim()))).toEqual([]);
  });
});
