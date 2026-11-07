/**
 * 청구 이메일 표시(ADR-0014 결정 8 · 계획 §3.15 · M3b) — sync 가 Paddle 고객 이메일을 재조회해 `atmark_is_agent_mail_identity` 로 판정하고
 * `organizations.billing_email_is_agent` 를 쓴다. 이메일 평문은 저장 · 로그되지 않는다. `atmark_billing` 롤 · 가짜 공급자.
 *
 *   ① 구독 이벤트 — 결속과 같은 트랜잭션에서 표시를 쓴다(에이전트 주소 → 참).
 *   ② 고객 이벤트(customer.updated) — 사람 주소로 바뀌면 거짓 · 결속 안 된 고객은 아무 조직도 바꾸지 않는다 · 재계산 없음.
 *   ③ 이메일 조회 실패는 구독 동기화를 막지 않는다(표시는 그대로) · 고객 이벤트의 실패는 재시도(failed).
 */

import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ProviderUnavailableError } from '../../../src/billing/provider';
import { processBillingMessage, type BillingSyncDeps } from '../../../src/billing/sync';
import { setLogSink, resetLogSink } from '../../../src/observability/logger';
import { adminRolePool, AVAILABLE, ownerPool } from '../admin/support';
import { seedFixture, testPool } from '../db/support/harness';
import { billingOrg, billingPool, FakeProvider, id26, message, ourCheckout, subscription, transaction } from './support';

class EmailProvider extends FakeProvider {
  readonly emails = new Map<string, string>();
  failEmail = false;

  fetchCustomerEmail(customerId: string): Promise<string> {
    this.calls.push('fetchCustomerEmail');
    if (this.failEmail) return Promise.reject(new ProviderUnavailableError());
    const email = this.emails.get(customerId);
    return email === undefined ? Promise.reject(new ProviderUnavailableError()) : Promise.resolve(email);
  }
}

describe.skipIf(!AVAILABLE)('청구 이메일이 에이전트 주소인가 — sync', () => {
  let owner: Pool;
  let admin: Pool;
  let billing: Pool;
  const lines: string[] = [];

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    billing = billingPool();
    setLogSink((line) => lines.push(line));
  });
  afterEach(() => {
    lines.length = 0;
  });
  afterAll(async () => {
    resetLogSink();
    await Promise.all([owner.end(), admin.end(), billing.end()]);
  });

  const deps = (provider: FakeProvider, allow: readonly string[]): BillingSyncDeps => ({
    pool: billing,
    environment: 'sandbox',
    provider,
    sandboxAllowlist: allow,
    now: () => new Date(),
  });

  async function flag(organizationId: string): Promise<boolean | undefined> {
    return (await owner.query<{ flag: boolean }>('SELECT billing_email_is_agent AS flag FROM organizations WHERE id = $1', [organizationId])).rows[0]?.flag;
  }

  async function paid(provider: EmailProvider) {
    const org = await billingOrg(owner);
    const txn = await ourCheckout(admin, org, 'pro');
    const sub = subscription({ organizationId: org.id });
    provider.put(sub, transaction({ id: txn, subscriptionId: sub.id, customDataOrganizationId: org.id }));
    return { org, sub };
  }

  it('① 구독 이벤트 — 청구 이메일이 에이전트 주소면 참 · 이메일은 원장 · 로그에 없다', async () => {
    const provider = new EmailProvider('sandbox', billing);
    const { org, sub } = await paid(provider);
    const agent = await seedFixture(testPool());
    provider.emails.set(sub.customerId, agent.address);
    expect(await processBillingMessage(deps(provider, [org.id]), message({ eventType: 'subscription.created', subscriptionId: sub.id }))).toBe('done');
    expect(await flag(org.id)).toBe(true);
    expect(provider.violations).toEqual([]); // 이메일 조회도 트랜잭션 밖.
    expect(lines.filter((line) => line.includes(agent.address))).toEqual([]);
  });

  it('② 고객 이벤트 — 사람 주소로 바뀌면 거짓 · 결속 안 된 고객은 아무것도 바꾸지 않는다', async () => {
    const provider = new EmailProvider('sandbox', billing);
    const { org, sub } = await paid(provider);
    const agent = await seedFixture(testPool());
    provider.emails.set(sub.customerId, agent.address);
    await processBillingMessage(deps(provider, [org.id]), message({ eventType: 'subscription.created', subscriptionId: sub.id }));
    expect(await flag(org.id)).toBe(true);
    provider.emails.set(sub.customerId, `finance-${id26()}@example.com`);
    expect(await processBillingMessage(deps(provider, [org.id]), message({ eventType: 'customer.updated', customerId: sub.customerId }))).toBe('done');
    expect(await flag(org.id)).toBe(false);
    // 결속 안 된 고객 — 표시를 바꿀 조직이 없다(원장은 done).
    const stray = `ctm_${id26()}`;
    provider.emails.set(stray, agent.address);
    expect(await processBillingMessage(deps(provider, [org.id]), message({ eventType: 'customer.updated', customerId: stray }))).toBe('done');
    expect(await flag(org.id)).toBe(false);
    const recomputed = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM billing_audit WHERE organization_id = $1`, [org.id]);
    expect(recomputed.rows[0]?.n).toBe(1); // 구독 이벤트 한 번뿐 — 고객 이벤트는 요금제를 재계산하지 않는다.
  });

  it('③ 이메일 조회 실패 — 구독 동기화는 된다(표시 그대로) · 고객 이벤트는 failed(재시도)', async () => {
    const provider = new EmailProvider('sandbox', billing);
    const { org, sub } = await paid(provider);
    provider.failEmail = true;
    expect(await processBillingMessage(deps(provider, [org.id]), message({ eventType: 'subscription.created', subscriptionId: sub.id }))).toBe('done');
    expect(await flag(org.id)).toBe(false);
    expect(await processBillingMessage(deps(provider, [org.id]), message({ eventType: 'customer.updated', customerId: sub.customerId }))).toBe('failed');
  });
});
