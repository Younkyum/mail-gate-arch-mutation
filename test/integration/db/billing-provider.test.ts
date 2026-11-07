/**
 * WP-2 결제 공급자 표 · 롤 · 가드(202609250400, ADR-0012) — 실제 Postgres · 실제 롤(계획 §Step 1 수용 기준 2).
 *
 *   atmark_billing(sync λ)
 *     ① 같은 event_id 는 한 행(new → retry → done → duplicate) · done 종단
 *     ② provider_updated_at 되감기 거부(트리거) · 저장소는 stale 로 돌려준다
 *     ③ canceled 되살림 거부 · ④ 조직·원 거래 변경 거부 · 결속 FK — 우리 거래·그 조직·같은 환경만
 *     ⑤ operator 출처 쓰기 거부 · ⑥ provider 출처 + beta 거부(L9) · ⑦ 감사 없는 v+1 은 커밋되지 않는다
 *     ⑧ billing_audit SELECT · tlog_outbox 직접 INSERT 거부 — 그런데 엔타이틀먼트 쓰기는 outbox 행 1(definer 트리거)
 *     ⑨ organizations.billing_status UPDATE 거부
 *     D-3: 넘기지 않은 운영자 beta 행 + pro 거부 · 유예 끝난 beta 행 + pro 허용 · 넘긴 행은 free 까지 허용 · provider 행 강등 허용
 *   atmark_billing_operator ⑩ provider 출처 거부 · ⑪ billing_events·billing_checkouts 접근 0
 *   고객 결속(H-1/M-4) — 조직마다 하나 · 한 고객 여러 조직(shared) · 포털 판단(다른 조직의 살아 있는 구독)
 *   atmark_admin ⑫ billing_checkouts INSERT·superseded 만(completed 로 적지 못한다) · 하루 상한 계수
 *   atmark_app ⑬ 새 표 다섯 권한 0
 *   + 표 칸 = `BILLING_PROVIDER_TABLE_COLUMNS` · `writeEntitlementVersion` 같은 값이면 changed:false — 출처·넘김 표시만 바뀌어도 v+1(M-1)
 *   + L-4: billing 롤의 provider 행은 카탈로그 한도만 · 감사 행위자는 provider:paddle 만
 *
 * `TEST_DATABASE_URL` / `TEST_MIGRATION_DATABASE_URL` 이 없으면 건너뛴다. 결제 롤 URL 은 앱 URL 의 사용자만 바꾼다(로컬 trust) —
 * `TEST_BILLING_DATABASE_URL` · `TEST_BILLING_OPERATOR_DATABASE_URL` 이 있으면 그것.
 */

import { randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOrganizationOp } from '../../../src/admin/ops/agents';
import { PLAN_CATALOG, type PlanCode } from '../../../src/billing/plans';
import { withTransaction } from '../../../src/db/client';
import {
  bindCustomer,
  bindSubscription,
  countOrgCheckoutsSince,
  customerHasOtherOrgSubscription,
  findCheckout,
  finishBillingEvent,
  insertCheckout,
  loadBillingOverviewRows,
  loadOrgCustomer,
  openCheckoutFor,
  recordBillingEvent,
  supersedeCheckout,
  upsertSubscription,
  type BillingEventRecord,
  type SubscriptionSnapshot,
} from '../../../src/db/repositories/billing';
import { writeEntitlementVersion, type EntitlementWriteInput } from '../../../src/db/repositories/entitlements-write';
import { BILLING_PROVIDER_TABLE_COLUMNS, BILLING_PROVIDER_TABLES } from '../../../src/db/schema';
import { createPool } from '../../../src/db/client';
import { adminRolePool, APP_URL, appPool, AVAILABLE, ownerPool, suffix, userIdOf } from '../admin/support';
import { grantPlan } from '../../support/entitlements';
import { rejects } from './support/harness';

function roleUrl(explicit: string | undefined, role: string): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  if (APP_URL.trim() === '') return '';
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

const BILLING_URL = roleUrl(process.env['TEST_BILLING_DATABASE_URL'], 'atmark_billing');
const OPERATOR_URL = roleUrl(process.env['TEST_BILLING_OPERATOR_DATABASE_URL'], 'atmark_billing_operator');

const id26 = (): string => randomBytes(13).toString('hex');
const sha = (): string => randomBytes(32).toString('hex');

describe.skipIf(!AVAILABLE)('결제 공급자 표 · 롤 · 가드 (202609250400)', () => {
  let owner: Pool;
  let admin: Pool;
  let app: Pool;
  let billing: Pool;
  let operator: Pool;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    app = appPool();
    billing = createPool(BILLING_URL, { max: 2 });
    operator = createPool(OPERATOR_URL, { max: 2 });
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), app.end(), billing.end(), operator.end()]);
  });

  async function org(plan: PlanCode | null = null): Promise<{ id: string; userId: string }> {
    const ownerEmail = `bill-${suffix()}@example.com`;
    const created = await createOrganizationOp(owner, { name: `bill-${suffix()}`, ownerEmail });
    if (plan !== null) await grantPlan(owner, created.id, plan);
    return { id: created.id, userId: await userIdOf(owner, ownerEmail) };
  }

  /** admin 롤로 거래 기록(콘솔 체크아웃과 같은 경로). */
  async function checkout(organization: { id: string; userId: string }, plan: 'pro' | 'team' | 'scale' = 'pro'): Promise<string> {
    const transactionId = `txn_${id26()}`;
    await insertCheckout(admin, {
      organizationId: organization.id,
      provider: 'paddle',
      environment: 'sandbox',
      transactionId,
      plan,
      createdByUserId: organization.userId,
    });
    return transactionId;
  }

  function snapshot(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
    return {
      provider: 'paddle',
      providerSubscriptionId: `sub_${id26()}`,
      environment: 'sandbox',
      providerCustomerId: `ctm_${id26()}`,
      status: 'active',
      planCode: 'pro',
      priceId: `pri_${id26()}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      scheduledChangeAction: null,
      scheduledChangeAt: null,
      pastDueSince: null,
      providerUpdatedAt: new Date('2026-09-25T00:00:00.000Z'),
      ...overrides,
    };
  }

  function providerWrite(organizationId: string, plan: PlanCode, overrides: Partial<EntitlementWriteInput> = {}): EntitlementWriteInput {
    return {
      organizationId,
      plan,
      limits: PLAN_CATALOG[plan],
      graceUntil: null,
      source: 'provider',
      cause: 'provider_event',
      providerOverrideAllowed: false,
      actor: 'provider:paddle',
      providerEventId: `evt_${id26()}`,
      note: null,
      ...overrides,
    };
  }

  const planOf = async (organizationId: string): Promise<unknown> =>
    (
      await owner.query(
        'SELECT plan_code, source, cause, provider_override_allowed, version::int AS version FROM org_entitlements WHERE organization_id = $1',
        [organizationId],
      )
    ).rows[0];

  it('표 칸 = BILLING_PROVIDER_TABLE_COLUMNS (양방향) · org_entitlements 제어 칸은 기본 false', async () => {
    for (const table of BILLING_PROVIDER_TABLES) {
      const columns = await owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`,
        [table],
      );
      expect(columns.rows.map((row) => row.column_name), table).toEqual([...BILLING_PROVIDER_TABLE_COLUMNS[table]].sort());
    }
    const organization = await org('beta');
    expect(await planOf(organization.id)).toMatchObject({ provider_override_allowed: false });
  });

  it('① 같은 event_id 는 한 행 — new → retry → done → duplicate · done 은 종단 · 이유 코드는 목록 안에서만', async () => {
    const event: BillingEventRecord = {
      provider: 'paddle',
      eventId: `evt_${id26()}`,
      eventType: 'subscription.updated',
      occurredAt: new Date(),
      notificationId: `ntf_${id26()}`,
      environment: 'sandbox',
      payloadSha256: sha(),
      subscriptionId: `sub_${id26()}`,
      transactionId: null,
    };
    expect(await recordBillingEvent(billing, event)).toBe('new');
    expect(await finishBillingEvent(billing, 'paddle', event.eventId, { status: 'failed', code: 'provider_error' })).toBe(true);
    expect(await withTransaction(billing, (client) => recordBillingEvent(client, event))).toBe('retry');
    expect(await finishBillingEvent(billing, 'paddle', event.eventId, { status: 'done', code: null })).toBe(true);
    expect(await recordBillingEvent(billing, event)).toBe('duplicate');
    expect(await finishBillingEvent(billing, 'paddle', event.eventId, { status: 'ignored', code: 'not_found' })).toBe(false);
    const rows = await owner.query('SELECT status, attempts, last_error FROM billing_events WHERE event_id = $1', [event.eventId]);
    expect(rows.rows).toEqual([{ status: 'done', attempts: 2, last_error: null }]);
    // 종단 행은 소유자도 되돌리지 못한다 · 봉투 칸 불변 · 이유 코드 밖 문자열 거부.
    expect((await rejects(owner.query(`UPDATE billing_events SET status = 'pending', processed_at = NULL WHERE event_id = $1`, [event.eventId]))).message).toContain('종단');
    const other = { ...event, eventId: `evt_${id26()}` };
    await recordBillingEvent(billing, other);
    expect(
      (await rejects(billing.query(`UPDATE billing_events SET status = 'failed', last_error = 'customer ctm_x', processed_at = now() WHERE event_id = $1`, [other.eventId]))).code,
    ).toBe('23514');
    expect((await rejects(billing.query(`UPDATE billing_events SET attempts = 0 WHERE event_id = $1`, [other.eventId]))).code).toBe('23514');
    expect((await rejects(billing.query('DELETE FROM billing_events WHERE event_id = $1', [other.eventId]))).code).toBe('42501');
  });

  it('② 구독 — 결속 FK(우리 거래·그 조직·같은 환경만) · 앞으로만 · stale · ③ canceled 종단 · ④ 조직 불변', async () => {
    const organization = await org('free');
    const stranger = await org('free');
    const txn = await checkout(organization);
    const sub = snapshot();
    // 공개 클라이언트 토큰으로 만든 거래(우리 표에 없음) · 남의 조직 · 다른 환경은 결속되지 않는다(FK).
    expect((await rejects(bindSubscription(billing, sub, organization.id, `txn_${id26()}`))).code).toBe('23503');
    expect((await rejects(bindSubscription(billing, sub, stranger.id, txn))).code).toBe('23503');
    expect((await rejects(bindSubscription(billing, { ...sub, environment: 'production' }, organization.id, txn))).code).toBe('23503');

    expect(await findCheckout(billing, txn, 'sandbox')).toEqual({ organization_id: organization.id, environment: 'sandbox', transaction_id: txn, status: 'open' });
    expect(await bindSubscription(billing, sub, organization.id, txn)).toBe('bound');
    expect(await bindSubscription(billing, sub, organization.id, txn)).toBe('exists');
    expect((await findCheckout(billing, txn, 'sandbox'))?.status).toBe('completed');

    const later = new Date('2026-09-26T00:00:00.000Z');
    expect(await upsertSubscription(billing, { ...sub, status: 'past_due', pastDueSince: new Date('2026-09-25T12:00:00.000Z'), providerUpdatedAt: later })).toBe('updated');
    expect(await upsertSubscription(billing, { ...sub, providerUpdatedAt: new Date('2026-09-25T06:00:00.000Z') })).toBe('stale');
    expect(await upsertSubscription(billing, snapshot())).toBe('missing');
    expect(
      (await rejects(billing.query(`UPDATE billing_subscriptions SET provider_updated_at = $2 WHERE provider_subscription_id = $1`, [sub.providerSubscriptionId, new Date('2026-01-01T00:00:00Z')]))).message,
    ).toContain('뒤로 가지 않는다');

    expect(await upsertSubscription(billing, { ...sub, status: 'canceled', providerUpdatedAt: new Date('2026-09-27T00:00:00.000Z') })).toBe('updated');
    expect(await upsertSubscription(billing, { ...sub, status: 'active', providerUpdatedAt: new Date('2026-09-28T00:00:00.000Z') })).toBe('stale');
    expect((await rejects(owner.query(`UPDATE billing_subscriptions SET status = 'active' WHERE provider_subscription_id = $1`, [sub.providerSubscriptionId]))).message).toContain('되살아나지');
    // ④ 조직·원 거래는 롤 권한으로도(칸 UPDATE 없음), 소유자로도(트리거) 바꿀 수 없다.
    expect((await rejects(billing.query(`UPDATE billing_subscriptions SET organization_id = $2 WHERE provider_subscription_id = $1`, [sub.providerSubscriptionId, stranger.id]))).code).toBe('42501');
    expect((await rejects(owner.query(`UPDATE billing_subscriptions SET organization_id = $2 WHERE provider_subscription_id = $1`, [sub.providerSubscriptionId, stranger.id]))).code).toBe('23514');

  });

  it('고객 결속(H-1/M-4) — 조직마다 하나 · 한 고객이 여러 조직에 붙는다(shared) · 포털 판단은 다른 조직 구독을 상태와 무관하게 본다(R-1)', async () => {
    const first = await org('free');
    const second = await org('free');
    const customer = `ctm_${id26()}`;
    expect(await loadOrgCustomer(admin, first.id, 'paddle', 'sandbox')).toBeNull();
    expect(await bindCustomer(billing, first.id, 'paddle', 'sandbox', customer)).toBe('bound');
    expect(await bindCustomer(billing, first.id, 'paddle', 'sandbox', customer)).toBe('existing');
    expect(await loadOrgCustomer(admin, first.id, 'paddle', 'sandbox')).toEqual({ customerId: customer, shared: false });
    // 조직이 이미 다른 고객에 묶여 있다 — 행은 그대로, 결과는 shared.
    expect(await bindCustomer(billing, first.id, 'paddle', 'sandbox', `ctm_${id26()}`)).toBe('shared');
    expect(await loadOrgCustomer(billing, first.id, 'paddle', 'sandbox')).toEqual({ customerId: customer, shared: false });
    // 같은 고객이 둘째 조직에 — 결속은 되고(행이 생긴다) 양쪽 모두 shared.
    expect(await bindCustomer(billing, second.id, 'paddle', 'sandbox', customer)).toBe('shared');
    expect(await bindCustomer(billing, second.id, 'paddle', 'sandbox', customer)).toBe('shared');
    expect(await bindCustomer(billing, first.id, 'paddle', 'sandbox', customer)).toBe('shared');
    expect(await loadOrgCustomer(admin, first.id, 'paddle', 'sandbox')).toEqual({ customerId: customer, shared: true });
    expect(await loadOrgCustomer(admin, second.id, 'paddle', 'sandbox')).toEqual({ customerId: customer, shared: true });
    // 다른 환경은 따로 센다.
    expect(await loadOrgCustomer(admin, first.id, 'paddle', 'production')).toBeNull();
    expect(await bindCustomer(billing, first.id, 'paddle', 'production', customer)).toBe('bound');

    // 포털 판단 — 둘째 조직의 구독이 있으면 첫째 조직 쪽에서 true, **해지돼도 true**(포털은 해지된 구독·영수증도 보여 준다 — R-1). 자기 조직 구독은 세지 않는다.
    expect(await customerHasOtherOrgSubscription(admin, first.id, 'paddle', 'sandbox', customer)).toBe(false);
    const own = snapshot({ providerCustomerId: customer });
    await bindSubscription(billing, own, first.id, await checkout(first));
    expect(await customerHasOtherOrgSubscription(admin, first.id, 'paddle', 'sandbox', customer)).toBe(false);
    const theirs = snapshot({ providerCustomerId: customer });
    await bindSubscription(billing, theirs, second.id, await checkout(second));
    expect(await customerHasOtherOrgSubscription(admin, first.id, 'paddle', 'sandbox', customer)).toBe(true);
    expect(await customerHasOtherOrgSubscription(admin, second.id, 'paddle', 'sandbox', customer)).toBe(true);
    expect(await customerHasOtherOrgSubscription(admin, first.id, 'paddle', 'production', customer)).toBe(false);
    await upsertSubscription(billing, { ...theirs, status: 'canceled', providerUpdatedAt: new Date('2026-09-27T00:00:00.000Z') });
    expect(await customerHasOtherOrgSubscription(admin, first.id, 'paddle', 'sandbox', customer)).toBe(true);
    expect(await customerHasOtherOrgSubscription(billing, second.id, 'paddle', 'sandbox', customer)).toBe(true);
  });

  it('⑤ billing 은 operator 출처를 못 쓴다 · ⑥ provider + beta 거부(L9) · ⑦ 감사 없는 v+1 은 커밋되지 않는다', async () => {
    const organization = await org(null);
    expect(
      (await rejects(withTransaction(billing, (client) => writeEntitlementVersion(client, { ...providerWrite(organization.id, 'pro'), source: 'operator', cause: 'operator' })))).code,
    ).toBe('42501');
    expect((await rejects(withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(organization.id, 'beta'))))).code).toBe('23514');
    expect(await withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(organization.id, 'pro')))).toEqual({
      changed: true,
      fromPlan: null,
      version: 1,
    });
    expect(await withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(organization.id, 'pro')))).toMatchObject({ changed: false, version: 1 });
    const bare = await rejects(
      // 카탈로그 한도는 그대로(L-4 가드를 지나) — 감사 짝만 없다.
      billing.query(`UPDATE org_entitlements SET cause = 'reconcile', version = version + 1 WHERE organization_id = $1`, [
        organization.id,
      ]),
    );
    expect([bare.code, bare.message.includes('billing_audit')]).toEqual(['23514', true]);
    const audit = await owner.query('SELECT actor, provider_event_id IS NOT NULL AS has_event, cause FROM billing_audit WHERE organization_id = $1', [organization.id]);
    expect(audit.rows).toEqual([{ actor: 'provider:paddle', has_event: true, cause: 'provider_event' }]);
  });

  it('⑧ billing 은 감사 원장을 읽지 못하고 outbox 에 직접 쓰지 못한다 — 그래도 엔타이틀먼트 쓰기는 outbox 행 1 · ⑨ billing_status 거부', async () => {
    const organization = await org(null);
    expect((await rejects(billing.query('SELECT 1 FROM billing_audit LIMIT 1'))).code).toBe('42501');
    expect(
      (await rejects(billing.query(`INSERT INTO tlog_outbox (source_table, source_id, event, rev, organization_id) VALUES ('org_entitlements', $1::text, 'insert', 0, $1::uuid)`, [organization.id]))).code,
    ).toBe('42501');
    const before = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM tlog_outbox WHERE source_table = 'org_entitlements' AND source_id = $1`, [organization.id]);
    await withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(organization.id, 'team')));
    const after = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM tlog_outbox WHERE source_table = 'org_entitlements' AND source_id = $1`, [organization.id]);
    expect((after.rows[0]?.n ?? 0) - (before.rows[0]?.n ?? 0)).toBe(1);
    expect((await rejects(billing.query(`UPDATE organizations SET billing_status = 'delinquent' WHERE id = $1`, [organization.id]))).code).toBe('42501');
  });

  it('D-3 — 넘기지 않은 운영자 beta 행 위에 pro 는 거부 · 유예 끝난 beta 행 위에는 허용 · 넘긴 행은 free 까지 · provider 행 강등 허용', async () => {
    // beta(운영자 보상) + pro 결제 → pro 가 칸별로 beta 를 넘지 못한다(에이전트/일 300 < 10000).
    const held = await org('beta');
    expect((await rejects(withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(held.id, 'pro'))))).code).toBe('42501');
    // 운영자·백필 행은 Free 로 떨어뜨리지 못한다(공급자 강등은 provider 행에만).
    expect((await rejects(withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(held.id, 'free', { cause: 'reconcile' }))))).code).toBe('42501');
    // scale 은 beta 를 칸별로 넘거나 같다? — beta 의 agent_per_day 10000 > scale 5000 이라 여전히 거부(순위가 아니라 칸별 지배).
    expect((await rejects(withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(held.id, 'scale'))))).code).toBe('42501');
    expect(await planOf(held.id)).toMatchObject({ plan_code: 'beta', source: 'default' });

    // 유예가 끝난 beta 행 = 지금 적용 한도는 Free → pro 가 지배한다.
    const expired = await org(null);
    await withTransaction(operator, (client) =>
      writeEntitlementVersion(client, {
        ...providerWrite(expired.id, 'beta'),
        source: 'operator',
        cause: 'operator',
        providerEventId: null,
        actor: 'admin:plan:test',
        graceUntil: new Date(Date.now() - 60_000),
      }),
    );
    expect(await withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(expired.id, 'pro')))).toMatchObject({ changed: true, version: 2 });

    // 넘긴 행(--release-to-provider) — 결제가 자유롭게 바꾼다(강등 포함). 쓰고 나면 provider 행 · 넘김 표시는 false.
    const released = await org('beta');
    await withTransaction(operator, (client) =>
      writeEntitlementVersion(client, {
        ...providerWrite(released.id, 'beta'),
        source: 'operator',
        cause: 'operator',
        providerEventId: null,
        actor: 'admin:plan:test',
        providerOverrideAllowed: true,
        note: 'release_to_provider',
      }),
    );
    expect(await planOf(released.id)).toMatchObject({ plan_code: 'beta', source: 'operator', provider_override_allowed: true, version: 2 });
    await withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(released.id, 'pro')));
    expect(await planOf(released.id)).toMatchObject({ plan_code: 'pro', source: 'provider', provider_override_allowed: false, version: 3 });
    // provider 행은 강등(free)도 된다 · provider 출처에 넘김 표시를 켤 수 없다.
    await withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(released.id, 'free', { cause: 'provider_event' })));
    expect(await planOf(released.id)).toMatchObject({ plan_code: 'free', source: 'provider', version: 4 });
    expect((await rejects(withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(released.id, 'pro', { providerOverrideAllowed: true }))))).code).toBe('23514');
  });

  it('M-1 — 출처만 바뀌어도 · 넘김 표시만 바뀌어도 v+1 · 원인만 다르면 그대로', async () => {
    const organization = await org(null);
    const operatorWrite = (overrides: Partial<EntitlementWriteInput> = {}): EntitlementWriteInput => ({
      ...providerWrite(organization.id, 'pro'),
      source: 'operator',
      cause: 'operator',
      providerEventId: null,
      actor: 'admin:plan:test',
      ...overrides,
    });
    expect(await withTransaction(operator, (client) => writeEntitlementVersion(client, operatorWrite()))).toMatchObject({ changed: true, version: 1 });
    // 넘김 표시만 — v2.
    expect(await withTransaction(operator, (client) => writeEntitlementVersion(client, operatorWrite({ providerOverrideAllowed: true })))).toMatchObject({
      changed: true,
      version: 2,
    });
    expect(await withTransaction(operator, (client) => writeEntitlementVersion(client, operatorWrite({ providerOverrideAllowed: true, note: 'again' })))).toMatchObject({
      changed: false,
      version: 2,
    });
    // 같은 pro 카탈로그를 공급자가 원한다 — 출처만 바뀐다 → v3 · provider 행(넘김 표시 false).
    expect(await withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(organization.id, 'pro')))).toMatchObject({
      changed: true,
      fromPlan: 'pro',
      version: 3,
    });
    expect(await planOf(organization.id)).toMatchObject({ plan_code: 'pro', source: 'provider', provider_override_allowed: false, version: 3 });
    // 원인만 다르면(reconcile 이 같은 상태를 다시 본다) 쓰지 않는다.
    expect(await withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(organization.id, 'pro', { cause: 'reconcile', providerEventId: null })))).toMatchObject({
      changed: false,
      version: 3,
    });
  });

  it('L-4 — billing 롤은 카탈로그 밖 한도 · provider:paddle 밖 감사 행위자를 쓰지 못한다(다른 롤은 이 규칙 밖)', async () => {
    const organization = await org(null);
    const bent = { ...PLAN_CATALOG.pro, agentPerDayMax: PLAN_CATALOG.pro.agentPerDayMax + 1 };
    const limits = await rejects(withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(organization.id, 'pro', { limits: bent }))));
    expect([limits.code, limits.message.includes('카탈로그')]).toEqual(['42501', true]);
    // 다른 요금제의 카탈로그를 빌려 와도 거부(free 이름에 pro 한도).
    expect((await rejects(withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(organization.id, 'free', { limits: PLAN_CATALOG.pro }))))).code).toBe(
      '42501',
    );
    const actor = await rejects(withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(organization.id, 'pro', { actor: 'admin:plan:jin' }))));
    expect([actor.code, actor.message.includes('provider:paddle')]).toEqual(['42501', true]);
    expect(await planOf(organization.id)).toBeUndefined();
    // 카탈로그 그대로 · provider:paddle 이면 쓴다. operator 롤은 덮어쓴 한도·자기 행위자를 그대로 쓴다.
    expect(await withTransaction(billing, (client) => writeEntitlementVersion(client, providerWrite(organization.id, 'team')))).toMatchObject({ changed: true, version: 1 });
    const other = await org(null);
    expect(
      await withTransaction(operator, (client) =>
        writeEntitlementVersion(client, { ...providerWrite(other.id, 'pro', { limits: bent }), source: 'operator', cause: 'operator', providerEventId: null, actor: 'admin:plan:jin' }),
      ),
    ).toMatchObject({ changed: true, version: 1 });
  });

  it('⑩ operator 롤은 provider 출처·review 원인을 못 쓴다 · ⑪ 이벤트·체크아웃·고객 접근 0 · 구독은 세 칸만', async () => {
    const organization = await org(null);
    expect((await rejects(withTransaction(operator, (client) => writeEntitlementVersion(client, { ...providerWrite(organization.id, 'pro'), providerEventId: null })))).code).toBe('42501');
    expect(
      (await rejects(withTransaction(operator, (client) =>
        writeEntitlementVersion(client, { ...providerWrite(organization.id, 'beta'), source: 'operator', cause: 'review', providerEventId: null }),
      ))).code,
    ).toBe('42501');
    // provider_event_id 칸은 운영자 롤에 없다 — 값을 주면 권한 오류.
    expect(
      (await rejects(withTransaction(operator, (client) => writeEntitlementVersion(client, { ...providerWrite(organization.id, 'pro'), source: 'operator', cause: 'operator' })))).code,
    ).toBe('42501');
    for (const sql of [
      'SELECT 1 FROM billing_events LIMIT 1',
      'SELECT 1 FROM billing_checkouts LIMIT 1',
      'SELECT 1 FROM billing_customers LIMIT 1',
      'SELECT 1 FROM billing_reconcile_state LIMIT 1',
      'SELECT provider_subscription_id FROM billing_subscriptions LIMIT 1',
      'SELECT 1 FROM billing_audit LIMIT 1',
      'SELECT owner_email FROM organizations LIMIT 1',
    ]) {
      expect((await rejects(operator.query(sql))).code, sql).toBe('42501');
    }
    await operator.query('SELECT organization_id, environment, status FROM billing_subscriptions LIMIT 1');
  });

  it('⑫ admin 은 체크아웃을 기록하고 superseded 로만 닫는다 · 재사용 창 · 개요는 표시 칸만', async () => {
    const organization = await org('free');
    const first = await checkout(organization, 'pro');
    expect((await openCheckoutFor(admin, organization.id, 'sandbox', 'pro'))?.transaction_id).toBe(first);
    expect(await openCheckoutFor(admin, organization.id, 'sandbox', 'team')).toBeNull();
    // completed 는 completed_at 과 함께만 — admin 은 그 칸이 없다.
    expect((await rejects(admin.query(`UPDATE billing_checkouts SET status = 'completed' WHERE transaction_id = $1`, [first]))).code).toBe('23514');
    expect((await rejects(admin.query(`UPDATE billing_checkouts SET status = 'completed', completed_at = now() WHERE transaction_id = $1`, [first]))).code).toBe('42501');
    expect(await supersedeCheckout(admin, first)).toBe(true);
    expect(await supersedeCheckout(admin, first)).toBe(false);
    expect((await rejects(owner.query(`UPDATE billing_checkouts SET status = 'open' WHERE transaction_id = $1`, [first]))).message).toContain('종단');
    expect((await rejects(admin.query(`UPDATE billing_checkouts SET plan_code = 'scale' WHERE transaction_id = $1`, [first]))).code).toBe('42501');
    expect((await rejects(admin.query('DELETE FROM billing_checkouts WHERE transaction_id = $1', [first]))).code).toBe('42501');
    // admin 은 이벤트 원장·구독 id 를 읽지 못하고, 개요는 표시 칸만 싣는다.
    expect((await rejects(admin.query('SELECT 1 FROM billing_events LIMIT 1'))).code).toBe('42501');
    expect((await rejects(admin.query('SELECT provider_subscription_id FROM billing_subscriptions LIMIT 1'))).code).toBe('42501');
    expect(await loadBillingOverviewRows(admin, organization.id, 'sandbox')).toEqual({ customerId: null, subscriptions: [] });

    // 하루 상한 계수(보안 M-1) — 상태·환경·요금제와 무관하게 since 이후 만든 거래 수. 다른 조직은 세지 않는다.
    const since = new Date(Date.now() - 60_000);
    expect(await countOrgCheckoutsSince(admin, organization.id, since)).toBe(1);
    await checkout(organization, 'team');
    await checkout(await org('free'), 'pro');
    expect(await countOrgCheckoutsSince(admin, organization.id, since)).toBe(2);
    expect(await countOrgCheckoutsSince(admin, organization.id, new Date(Date.now() + 60_000))).toBe(0);
  });

  it('⑬ 앱 롤은 새 표 다섯 모두 권한 0', async () => {
    for (const table of BILLING_PROVIDER_TABLES) {
      expect((await rejects(app.query(`SELECT 1 FROM ${table} LIMIT 1`))).code, table).toBe('42501');
    }
  });
});
