/**
 * 결제 sync(`src/billing/sync.ts`, 계획 §Step 3 수용 기준 2) — 실제 Postgres · **`atmark_billing` 롤**(운영 sync λ 와 같은 롤·풀 1) · 가짜 공급자.
 *
 *   ① 결속 + 적용: 우리 거래에서 나온 구독 → provider 출처 행 · 감사 행위자 `provider:paddle` · `provider_event_id` · 투명성 outbox 1 · 원장 done ·
 *      고객 결속. 같은 메시지 두 번 → 두 번째 `duplicate`, 버전 한 번.
 *   ② 순서: 옛 `updated_at` 재조회 → 표는 앞으로만(`billing.sync_stale`) · 요금제 무변.
 *   ③ 결속 거부: 우리 거래가 아닌 구독 · custom_data 조직이 다른 구독 → `failed(unbound_subscription)` + 알람 · 요금제 무변 · 구독 행 없음.
 *      원 거래가 공급자에 있고 우리 표에 없는데 만든 지 30분이 지났으면 `ignored(unbound_subscription)`(다시 해도 같다 — L-2) · 알람은 그대로.
 *      거래 이벤트의 거래가 우리 것이 아니면(갱신 거래가 먼저 왔다) 구독의 가장 이른 거래로 한 번 더 본다(L-3).
 *   ⑦ 한 고객이 두 조직에 결속(Paddle 이 같은 이메일에 같은 고객을 준다 — H-1) → 둘 다 결속·적용 · `billing.customer_shared` + 식별자 없는 로그.
 *   ⑧ DB 오류 → `failed(internal_error)`(공급자 탓이 아니다 — M-6) · 로그에 SQLSTATE · 재시도로 done.
 *   ④ 재조회 404 → `ignored(not_found)` · 5xx → `failed(provider_error)`(재시도) · 키 자리표시 → failed + auth 알람 · 환경 불일치 → ignored ·
 *      샌드박스 허용 목록 밖 → `ignored(sandbox_not_allowed)` · 거래 이벤트 → 거래의 구독 · 모양 밖 본문 → unparsable.
 *   ⑤ 운영자 beta 행 + pro 활성 → noop + `billing.entitlement_held` · 유예(past_due) → grace_until = min(실패 거래, 기간 시작) + 14일.
 *   ⑥ Paddle 호출 순간 열린 DB 트랜잭션 0 · sync 소스는 큐 메시지의 진단 칸을 읽지 않는다.
 *   ⑨ 런북 `docs/runbooks/billing.md` §5-1 의 수동 결속 SQL(두 블록 그대로) — 30분 뒤 ignored(unbound) 된 구독을 소유자 롤로 결속하고 `sync-org` 가
 *      적용한다(코드 검토 N-7) · 거래가 다른 조직 것이면 UNIQUE(23505), 구독의 조직이 거래와 다르면 FK(23503)가 막는다.
 */

import { readFileSync } from 'node:fs';

import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PROVIDER_GRACE_DAYS } from '../../../src/billing/constants';
import { PLAN_CATALOG } from '../../../src/billing/plans';
import { ProviderUnavailableError } from '../../../src/billing/provider';
import { serializeBillingQueueMessage } from '../../../src/billing/queue-message';
import { consumeBillingRecord, processBillingMessage, syncOrganization, type BillingSyncDeps } from '../../../src/billing/sync';
import { withTransaction } from '../../../src/db/client';
import { writeEntitlementVersion } from '../../../src/db/repositories/entitlements-write';
import { adminRolePool, AVAILABLE, ownerPool } from '../admin/support';
import { billingOrg, billingPool, captureMetrics, failingPool, FakeProvider, id26, message, ourCheckout, subscription, transaction } from './support';

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!AVAILABLE)('결제 sync — atmark_billing 롤 · 가짜 공급자', () => {
  let owner: Pool;
  let admin: Pool;
  let billing: Pool;
  let metrics: ReturnType<typeof captureMetrics>;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    billing = billingPool();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), billing.end()]);
  });
  afterEach(() => metrics?.restore());

  function deps(provider: FakeProvider | null, allow: readonly string[], overrides: Partial<BillingSyncDeps> = {}): BillingSyncDeps {
    return { pool: billing, environment: 'sandbox', provider, sandboxAllowlist: allow, now: () => new Date(), ...overrides };
  }

  async function entitlement(organizationId: string) {
    const row = await owner.query<{ plan_code: string; source: string; cause: string; version: string; grace_until: Date | null; max_agents: number }>(
      'SELECT plan_code, source, cause, version::text AS version, grace_until, max_agents FROM org_entitlements WHERE organization_id = $1',
      [organizationId],
    );
    return row.rows[0] ?? null;
  }

  async function ledger(eventId: string) {
    const row = await owner.query<{ status: string; last_error: string | null; attempts: number }>(
      'SELECT status, last_error, attempts FROM billing_events WHERE event_id = $1',
      [eventId],
    );
    return row.rows[0] ?? null;
  }

  /** 조직 + 우리 거래 + 그 거래에서 나온 구독(가짜 공급자에 올려 둔다). */
  async function paidOrg(provider: FakeProvider, plan: 'beta' | 'free' | 'pro' | null = null, sub: Partial<Parameters<typeof subscription>[0]> = {}) {
    const org = await billingOrg(owner, plan);
    const txn = await ourCheckout(admin, org, 'pro');
    const s = subscription({ organizationId: org.id, ...sub });
    provider.put(s, transaction({ id: txn, subscriptionId: s.id, customDataOrganizationId: org.id }));
    return { org, txn, sub: s };
  }

  it('① 우리 거래의 구독 → provider 행 · 감사 · outbox 1 · 원장 done · 고객 결속 — 같은 메시지 두 번이면 버전 한 번', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    const { org, sub } = await paidOrg(provider);
    const d = deps(provider, [org.id]);
    const m = message({ eventType: 'subscription.created', subscriptionId: sub.id });
    const outboxBefore = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM tlog_outbox WHERE source_table = 'org_entitlements' AND source_id = $1`, [org.id]);

    expect(await processBillingMessage(d, m)).toBe('done');
    expect(await entitlement(org.id)).toMatchObject({ plan_code: 'pro', source: 'provider', cause: 'provider_event', version: '1', max_agents: PLAN_CATALOG.pro.maxAgents });
    const audit = await owner.query<{ actor: string; provider_event_id: string | null; to_plan: string }>(
      'SELECT actor, provider_event_id, to_plan FROM billing_audit WHERE organization_id = $1 ORDER BY entitlement_version',
      [org.id],
    );
    expect(audit.rows).toEqual([{ actor: 'provider:paddle', provider_event_id: m.eventId, to_plan: 'pro' }]);
    const outboxAfter = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM tlog_outbox WHERE source_table = 'org_entitlements' AND source_id = $1`, [org.id]);
    expect((outboxAfter.rows[0]?.n ?? 0) - (outboxBefore.rows[0]?.n ?? 0)).toBe(1);
    expect(await ledger(m.eventId)).toMatchObject({ status: 'done', last_error: null });
    const customer = await owner.query('SELECT provider_customer_id FROM billing_customers WHERE organization_id = $1', [org.id]);
    expect(customer.rows).toEqual([{ provider_customer_id: sub.customerId }]);
    const checkout = await owner.query<{ status: string }>('SELECT status FROM billing_checkouts WHERE organization_id = $1', [org.id]);
    expect(checkout.rows.map((r) => r.status)).toEqual(['completed']);

    // 같은 메시지(FIFO 창 밖 재전송) → 원장이 거른다 · 버전 그대로.
    expect(await processBillingMessage(d, m)).toBe('duplicate');
    // 다른 이벤트지만 같은 상태 → 재계산해도 쓰지 않는다(noop).
    expect(await processBillingMessage(d, message({ subscriptionId: sub.id }))).toBe('done');
    expect(await entitlement(org.id)).toMatchObject({ version: '1' });
    expect(metrics.count('atmark.billing.sync_applied')).toBe(1);
    expect(metrics.count('atmark.billing.sync_noop')).toBe(1);
    // Paddle 호출 순간 열린 트랜잭션이 없었다.
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(provider.violations).toEqual([]);
  });

  it('② 옛 updated_at 재조회 → 표는 앞으로만(stale) · 요금제 무변 · 새 것은 반영(해지 → Free)', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    const { org, sub } = await paidOrg(provider, null, { updatedAt: new Date('2026-09-25T10:00:00.000Z') });
    const d = deps(provider, [org.id]);
    expect(await processBillingMessage(d, message({ subscriptionId: sub.id }))).toBe('done');
    // 옛 모습(해지)이 늦게 재조회됐다 — 표가 더 새롭다.
    provider.put({ ...sub, status: 'canceled', updatedAt: new Date('2026-09-25T09:00:00.000Z') });
    expect(await processBillingMessage(d, message({ subscriptionId: sub.id }))).toBe('done');
    expect(metrics.count('atmark.billing.sync_stale')).toBe(1);
    expect(await entitlement(org.id)).toMatchObject({ plan_code: 'pro', version: '1' });
    const row = await owner.query<{ status: string; provider_updated_at: Date }>('SELECT status, provider_updated_at FROM billing_subscriptions WHERE provider_subscription_id = $1', [sub.id]);
    expect(row.rows[0]).toMatchObject({ status: 'active', provider_updated_at: new Date('2026-09-25T10:00:00.000Z') });
    // 새 해지 → provider 행 강등(Free).
    provider.put({ ...sub, status: 'canceled', updatedAt: new Date('2026-09-25T11:00:00.000Z') });
    expect(await processBillingMessage(d, message({ eventType: 'subscription.canceled', subscriptionId: sub.id }))).toBe('done');
    expect(await entitlement(org.id)).toMatchObject({ plan_code: 'free', source: 'provider', version: '2' });
  });

  it('③ 우리 거래가 아닌 구독 · custom_data 조직이 다른 구독 → failed(unbound_subscription) + 알람 · 구독 행 없음 · 요금제 무변', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    const org = await billingOrg(owner);
    const d = deps(provider, [org.id]);
    // (a) 공개 클라이언트 토큰으로 만든 체크아웃 — 거래가 billing_checkouts 에 없다(custom_data 는 우리 조직을 주장한다). 방금 만든 거래라
    //     아직 확정이 아니다(admin INSERT 가 커밋 전일 수 있다) → failed(재시도).
    const foreign = subscription({ organizationId: org.id });
    provider.put(foreign, transaction({ id: `txn_${id26()}`, subscriptionId: foreign.id, customDataOrganizationId: org.id, createdAt: new Date() }));
    const a = message({ eventType: 'subscription.created', subscriptionId: foreign.id });
    expect(await processBillingMessage(d, a)).toBe('failed');
    expect(await ledger(a.eventId)).toMatchObject({ status: 'failed', last_error: 'unbound_subscription' });
    // (b) 우리 거래지만 구독의 custom_data 가 다른 조직.
    const other = await billingOrg(owner);
    const txn = await ourCheckout(admin, org);
    const spoofed = subscription({ organizationId: other.id });
    provider.put(spoofed, transaction({ id: txn, subscriptionId: spoofed.id, customDataOrganizationId: other.id }));
    const b = message({ eventType: 'transaction.completed', transactionId: txn, subscriptionId: spoofed.id });
    expect(await processBillingMessage(d, b)).toBe('failed');
    expect(await ledger(b.eventId)).toMatchObject({ status: 'failed', last_error: 'unbound_subscription' });

    // (c) 30분 넘게 지난 남의 거래 — 확정 → ignored(종단 · 다시 받으면 duplicate). 알람은 낸다(돈을 받았을 수 있다).
    const stale = subscription({ organizationId: org.id });
    provider.put(stale, transaction({ id: `txn_${id26()}`, subscriptionId: stale.id, customDataOrganizationId: org.id, createdAt: new Date(Date.now() - 31 * 60 * 1000) }));
    const c = message({ eventType: 'subscription.created', subscriptionId: stale.id });
    expect(await processBillingMessage(d, c)).toBe('ignored');
    expect(await ledger(c.eventId)).toMatchObject({ status: 'ignored', last_error: 'unbound_subscription' });
    expect(await processBillingMessage(d, c)).toBe('duplicate');

    expect(metrics.count('atmark.billing.unbound_subscription')).toBe(3);
    expect(metrics.count('atmark.billing.sync_failed')).toBe(2);
    const subs = await owner.query('SELECT 1 FROM billing_subscriptions WHERE provider_subscription_id = ANY($1::text[])', [[foreign.id, spoofed.id, stale.id]]);
    expect(subs.rowCount).toBe(0);
    expect(await entitlement(org.id)).toBeNull();
    expect(await entitlement(other.id)).toBeNull();
    // 재시도(SQS)는 attempts 를 올린다 — 여전히 결속되지 않는다.
    expect(await processBillingMessage(d, a)).toBe('failed');
    expect(await ledger(a.eventId)).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('④ 404 → ignored(not_found) · 5xx → failed(provider_error) 뒤 재시도로 done · 키 자리표시 → failed + auth 알람 · 환경 불일치 · 샌드박스 허용 목록 밖', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    const { org, sub } = await paidOrg(provider);

    const missing = message({ subscriptionId: `sub_${id26()}` });
    expect(await processBillingMessage(deps(provider, [org.id]), missing)).toBe('ignored');
    expect(await ledger(missing.eventId)).toMatchObject({ status: 'ignored', last_error: 'not_found' });
    expect(metrics.count('atmark.billing.provider_not_found')).toBe(1);

    const flaky = message({ subscriptionId: sub.id });
    provider.failures.push(new ProviderUnavailableError('provider_unavailable', 'http_503'));
    expect(await processBillingMessage(deps(provider, [org.id]), flaky)).toBe('failed');
    expect(await ledger(flaky.eventId)).toMatchObject({ status: 'failed', last_error: 'provider_error' });
    expect(await processBillingMessage(deps(provider, [org.id]), flaky)).toBe('done');
    expect(await ledger(flaky.eventId)).toMatchObject({ status: 'done', attempts: 2 });

    const unconfigured = message({ subscriptionId: sub.id });
    expect(await processBillingMessage(deps(null, [org.id]), unconfigured)).toBe('failed');
    expect(metrics.count('atmark.billing.provider_auth_failed')).toBe(1);

    const production = message({ environment: 'production', subscriptionId: sub.id });
    expect(await processBillingMessage(deps(provider, [org.id]), production)).toBe('ignored');
    expect(await ledger(production.eventId)).toMatchObject({ status: 'ignored', last_error: 'environment_mismatch' });

    const outsider = await paidOrg(provider);
    const notAllowed = message({ eventType: 'subscription.created', subscriptionId: outsider.sub.id });
    expect(await processBillingMessage(deps(provider, [org.id]), notAllowed)).toBe('ignored');
    expect(await ledger(notAllowed.eventId)).toMatchObject({ status: 'ignored', last_error: 'sandbox_not_allowed' });
    expect(await entitlement(outsider.org.id)).toBeNull();
    // 운영 환경은 허용 목록을 보지 않는다(그 λ 의 구독이면 적용).
    expect(provider.violations).toEqual([]);
  });

  it('④ 거래 이벤트는 거래의 구독을 재조회 · 거래에 구독이 없으면 done(할 일 없음) · 모양 밖 본문은 unparsable', async () => {
    const provider = new FakeProvider('sandbox', billing);
    const { org, txn } = await paidOrg(provider);
    const d = deps(provider, [org.id]);
    const m = message({ eventType: 'transaction.completed', transactionId: txn });
    expect(await consumeBillingRecord(d, serializeBillingQueueMessage({ ...m, diagnostic: { customDataOrganizationId: 'someone-else' } }))).toBe('done');
    expect(await entitlement(org.id)).toMatchObject({ plan_code: 'pro', source: 'provider' });
    const lonely = `txn_${id26()}`;
    provider.transactions.set(lonely, transaction({ id: lonely }));
    expect(await processBillingMessage(d, message({ eventType: 'transaction.completed', transactionId: lonely }))).toBe('done');
    expect(await consumeBillingRecord(d, '{"v":1}')).toBe('unparsable');
    expect(await consumeBillingRecord(d, 'not json')).toBe('unparsable');
  });

  it('③ L-3 — 갱신 거래 이벤트가 결속보다 먼저 와도 구독의 원 거래(가장 이른 것)가 우리 거래면 결속된다', async () => {
    const provider = new FakeProvider('sandbox', billing);
    const { org, sub } = await paidOrg(provider);
    const d = deps(provider, [org.id]);
    // 우리 거래(원 거래)는 가짜 공급자에 이미 있다(paidOrg) — 그보다 늦은 갱신 거래가 첫 이벤트다.
    const renewal = `txn_${id26()}`;
    provider.transactions.set(renewal, transaction({ id: renewal, subscriptionId: sub.id, customDataOrganizationId: org.id, createdAt: new Date('2026-10-25T00:00:00.000Z') }));
    expect(await processBillingMessage(d, message({ eventType: 'transaction.completed', transactionId: renewal, subscriptionId: sub.id }))).toBe('done');
    expect(await entitlement(org.id)).toMatchObject({ plan_code: 'pro', source: 'provider', version: '1' });
    const bound = await owner.query<{ origin_transaction_id: string }>('SELECT origin_transaction_id FROM billing_subscriptions WHERE provider_subscription_id = $1', [sub.id]);
    expect(bound.rows[0]?.origin_transaction_id).not.toBe(renewal);
    expect(provider.calls).toContain('listTransactionsBySubscription');
  });

  it('⑦ 한 고객이 두 조직에 결속(같은 이메일) → 둘 다 결속·적용 · customer_shared 메트릭 + 식별자 없는 로그', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    const customerId = provider.customerFor('same-person@example.com');
    const a = await paidOrg(provider, null, { customerId });
    const b = await paidOrg(provider, null, { customerId });
    const d = deps(provider, [a.org.id, b.org.id]);
    expect(await processBillingMessage(d, message({ eventType: 'subscription.created', subscriptionId: a.sub.id }))).toBe('done');
    expect(metrics.count('atmark.billing.customer_shared')).toBe(0);
    expect(await processBillingMessage(d, message({ eventType: 'subscription.created', subscriptionId: b.sub.id }))).toBe('done');
    expect(metrics.count('atmark.billing.customer_shared')).toBe(1);
    for (const made of [a, b]) expect(await entitlement(made.org.id)).toMatchObject({ plan_code: 'pro', source: 'provider' });
    const bound = await owner.query<{ organization_id: string }>(
      'SELECT organization_id::text AS organization_id FROM billing_customers WHERE provider_customer_id = $1 ORDER BY organization_id',
      [customerId],
    );
    expect(bound.rows.map((r) => r.organization_id).sort()).toEqual([a.org.id, b.org.id].sort());
    const shared = metrics.lines.filter((line) => line.includes('"billing.customer_shared"'));
    expect(shared).toHaveLength(1);
    expect(shared.join('')).not.toContain(customerId);
    expect(shared.join('')).not.toContain(b.org.id);
  });

  it('⑧ DB 오류 → failed(internal_error) · 로그에 SQLSTATE · 재시도로 done', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    const { org, sub } = await paidOrg(provider);
    const m = message({ eventType: 'subscription.created', subscriptionId: sub.id });
    expect(await processBillingMessage(deps(provider, [org.id], { pool: failingPool(billing, org.id, '40P01') }), m)).toBe('failed');
    expect(await ledger(m.eventId)).toMatchObject({ status: 'failed', last_error: 'internal_error' });
    const threw = metrics.lines.filter((line) => line.includes('"billing.sync_threw"'));
    expect(threw).toHaveLength(1);
    expect(JSON.parse(threw[0] ?? '{}')).toMatchObject({ error_code: '40P01' });
    expect(metrics.count('atmark.billing.sync_failed')).toBe(1);
    expect(await entitlement(org.id)).toBeNull();
    // 재시도(같은 메시지) — 이번에는 된다.
    expect(await processBillingMessage(deps(provider, [org.id]), m)).toBe('done');
    expect(await ledger(m.eventId)).toMatchObject({ status: 'done', attempts: 2 });
    expect(await entitlement(org.id)).toMatchObject({ plan_code: 'pro' });
  });

  it('⑤ 운영자 beta 행 + pro 활성 → noop + entitlement_held · 구독은 결속된다(돈은 받았다 — 운영자가 넘기면 적용)', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    const { org, sub } = await paidOrg(provider, 'beta');
    const d = deps(provider, [org.id]);
    expect(await processBillingMessage(d, message({ eventType: 'subscription.activated', subscriptionId: sub.id }))).toBe('done');
    expect(await entitlement(org.id)).toMatchObject({ plan_code: 'beta', source: 'default', version: '1' });
    expect(metrics.count('atmark.billing.entitlement_held')).toBe(1);
    const bound = await owner.query('SELECT organization_id::text AS id FROM billing_subscriptions WHERE provider_subscription_id = $1', [sub.id]);
    expect(bound.rows).toEqual([{ id: org.id }]);

    // 운영자가 넘기면(release-to-provider — 소유자 롤로 흉내) 운영자 sync-org 가 적용한다.
    await withTransaction(owner, (client) =>
      writeEntitlementVersion(client, {
        organizationId: org.id,
        plan: 'beta',
        limits: PLAN_CATALOG.beta,
        graceUntil: null,
        source: 'operator',
        cause: 'operator',
        providerOverrideAllowed: true,
        actor: 'test',
        providerEventId: null,
        note: 'release_to_provider',
      }),
    );
    expect(await syncOrganization({ ...d }, org.id)).toBe('applied');
    expect(await entitlement(org.id)).toMatchObject({ plan_code: 'pro', source: 'provider', cause: 'reconcile' });
    expect(provider.violations).toEqual([]);
  });

  it('⑤ 결제 실패(past_due) → grace_until = min(실패 거래, 기간 시작) + 14일 · 회복하면 유예가 걷힌다', async () => {
    const provider = new FakeProvider('sandbox', billing);
    const periodStart = new Date(Date.now() - 3 * DAY);
    const { org, sub } = await paidOrg(provider, null, { currentPeriodStart: periodStart, updatedAt: new Date(Date.now() - 4 * DAY) });
    const d = deps(provider, [org.id]);
    expect(await processBillingMessage(d, message({ subscriptionId: sub.id }))).toBe('done');
    const failedTxn = `txn_${id26()}`;
    provider.transactions.set(failedTxn, transaction({ id: failedTxn, subscriptionId: sub.id, status: 'past_due', createdAt: new Date(Date.now() - 2 * DAY) }));
    provider.put({ ...sub, status: 'past_due', updatedAt: new Date(Date.now() - DAY) });
    expect(await processBillingMessage(d, message({ eventType: 'transaction.payment_failed', transactionId: failedTxn, subscriptionId: sub.id }))).toBe('done');
    const graced = await entitlement(org.id);
    expect(graced).toMatchObject({ plan_code: 'pro', version: '2' });
    expect(graced?.grace_until?.getTime()).toBe(periodStart.getTime() + PROVIDER_GRACE_DAYS * DAY);
    provider.put({ ...sub, status: 'active', updatedAt: new Date() });
    expect(await processBillingMessage(d, message({ subscriptionId: sub.id }))).toBe('done');
    expect(await entitlement(org.id)).toMatchObject({ plan_code: 'pro', grace_until: null, version: '3' });
  });

  it('⑥ sync 소스는 큐 메시지의 진단 칸(diagnostic · customDataOrganizationId)을 읽지 않는다', () => {
    for (const file of ['src/billing/sync.ts', 'src/billing/reconcile.ts', 'src/runtime/handlers/billing-sync.ts']) {
      const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/\.diagnostic\b|\[['"]diagnostic['"]\]/);
    }
  });

  /** 런북 §5-1 의 SQL 블록(`<!-- manual-bind:<name> -->` 바로 뒤) — 자리를 채운다. */
  function runbookSql(name: 'check' | 'bind', values: Readonly<Record<string, string>>): string {
    const doc = readFileSync(new URL('../../../docs/runbooks/billing.md', import.meta.url), 'utf8');
    const block = new RegExp(`<!-- manual-bind:${name} -->\\s*\`\`\`sql\\n([\\s\\S]*?)\`\`\``).exec(doc)?.[1];
    if (block === undefined) throw new Error(`런북에 manual-bind:${name} 블록이 없다`);
    const filled = block.replace(/<([A-Z_]+)>/g, (whole, key: string) => values[key] ?? whole);
    expect(filled, name).not.toMatch(/<[A-Z_]+>/);
    return filled;
  }

  it('⑨ N-7 — 런북 수동 결속: 30분 뒤 ignored(unbound) 구독을 두 SQL 블록으로 결속 → sync-org 가 적용 · UNIQUE·FK 가 막는 조건', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    const org = await billingOrg(owner);
    const d = deps(provider, [org.id]);
    // 우리 표에 없는 거래(admin INSERT 가 실패했다 등)에서 나온 구독 — 31분이 지나 ignored.
    const txn = `txn_${id26()}`;
    const sub = subscription({ organizationId: org.id, updatedAt: new Date(Date.now() - 20 * 60 * 1000) });
    provider.put(sub, transaction({ id: txn, subscriptionId: sub.id, customDataOrganizationId: org.id, createdAt: new Date(Date.now() - 31 * 60 * 1000) }));
    const event = message({ eventType: 'subscription.created', subscriptionId: sub.id });
    expect(await processBillingMessage(d, event)).toBe('ignored');
    expect(await ledger(event.eventId)).toMatchObject({ status: 'ignored', last_error: 'unbound_subscription' });
    // 원장이 종단이라 다시 받아도 결속되지 않는다 · sync-org 도 결속된 구독만 본다.
    expect(await processBillingMessage(d, event)).toBe('duplicate');
    expect(await syncOrganization(d, org.id)).toBe('noop');
    expect(await entitlement(org.id)).toBeNull();

    const values = { ORG_ID: org.id, ENV: 'sandbox', TXN_ID: txn, SUB_ID: sub.id, CTM_ID: sub.customerId, PLAN: 'pro', STATUS: sub.status };
    // ② 확인 — (가) ignored · (나)(다) 0행 · (라) owner 1행.
    const checks = (await owner.query(runbookSql('check', values))) as unknown as { rows: Record<string, unknown>[] }[];
    expect(checks.map((result) => result.rows.length)).toEqual([1, 0, 0, 1]);
    expect(checks[0]?.rows[0]).toMatchObject({ status: 'ignored', last_error: 'unbound_subscription' });
    expect(checks[3]?.rows[0]).toEqual({ user_id: org.userId });
    // ③ 결속 — 마지막 확인이 한 행이면 COMMIT.
    const client = await owner.connect();
    try {
      const bound = (await client.query(runbookSql('bind', values))) as unknown as { rows: Record<string, unknown>[] }[];
      expect(bound.at(-1)?.rows).toEqual([{ organization_id: org.id, environment: 'sandbox', checkout: 'completed', subscription: 'active' }]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const customer = await owner.query('SELECT provider_customer_id FROM billing_customers WHERE organization_id = $1', [org.id]);
    expect(customer.rows).toEqual([{ provider_customer_id: sub.customerId }]);
    // ④ sync-org — Paddle 에서 다시 읽어 칸을 채우고 적용한다.
    expect(await syncOrganization(d, org.id)).toBe('applied');
    expect(await entitlement(org.id)).toMatchObject({ plan_code: 'pro', source: 'provider', version: '1' });
    const row = await owner.query<{ plan_code: string; price_id: string; provider_updated_at: Date }>(
      'SELECT plan_code, price_id, provider_updated_at FROM billing_subscriptions WHERE provider_subscription_id = $1',
      [sub.id],
    );
    expect(row.rows[0]).toEqual({ plan_code: 'pro', price_id: sub.priceId, provider_updated_at: sub.updatedAt });
    expect(provider.violations).toEqual([]);

    // 막는 조건 — (1) 거래가 이미 다른 조직 것이면 UNIQUE(23505) · 아무것도 쓰지 않는다.
    const other = await billingOrg(owner);
    const theirs = await ourCheckout(admin, other);
    const stolen = subscription({ organizationId: org.id });
    const steal = await owner.connect();
    try {
      const error = await steal.query(runbookSql('bind', { ...values, TXN_ID: theirs, SUB_ID: stolen.id, CTM_ID: stolen.customerId })).then(
        () => null,
        (e: unknown) => e as { code?: string },
      );
      expect(error?.code).toBe('23505');
      await steal.query('ROLLBACK');
    } finally {
      steal.release();
    }
    expect((await owner.query('SELECT 1 FROM billing_subscriptions WHERE provider_subscription_id = $1', [stolen.id])).rowCount).toBe(0);
    // (2) 구독의 (원 거래, 조직, 환경)이 거래 행과 다르면 FK(23503).
    const mismatched = await owner
      .query(
        `INSERT INTO billing_subscriptions (provider, provider_subscription_id, environment, organization_id, provider_customer_id, origin_transaction_id,
                                            status, provider_updated_at, synced_at)
         VALUES ('paddle', $1, 'sandbox', $2, $3, $4, 'active', '2000-01-01T00:00:00Z', now())`,
        [stolen.id, org.id, stolen.customerId, theirs],
      )
      .then(
        () => null,
        (e: unknown) => e as { code?: string; constraint?: string },
      );
    expect(mismatched).toMatchObject({ code: '23503', constraint: 'billing_subscriptions_origin_checkout' });
  });
});
