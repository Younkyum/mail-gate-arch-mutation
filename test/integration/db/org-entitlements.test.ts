/**
 * 과금 P0 엔타이틀먼트 DB(202609250300, ADR-0011) — 실제 Postgres · 실제 롤.
 *
 *   ① 최소 권한: 앱·admin 롤은 org_entitlements 를 읽기만(쓰기 거부) · billing_audit 은 둘 다 0.
 *   ② version 은 1 에서 하나씩 앞으로만 · 조직 불변 · 지우기/비우기 거부 · 감사 행 없는 변경은 커밋되지 않는다(지연 트리거).
 *   ③ 칸 상한 = 코드 천장(CHECK) · 출처↔원인 짝.
 *   ④ 투명성 outbox — INSERT·UPDATE 마다 그때 값 스냅샷(요금제 · 한도 · 버전 · 원인 · at = updated_at) · 금액·고객 칸 없음.
 *   ⑤ 정책 소스 — 행이 없으면 null(로더가 Free) · 있으면 행 · 앱 롤로 읽힌다.
 *   ⑥ billing_audit append-only.
 *   ⑦ 표가 없으면 `table_missing` → 도입 전 한도(Free 가 아니다 — 배포 순서가 어긋나도 승인된 봉투를 영구 거부하지 않는다).
 *   ⑧ 천장 트리거: 에이전트당 활성 웹훅 10 · 조직당 에이전트 1000(비활성 포함) — 소유자 롤로 넣어도 넘지 못한다.
 *   ② 에는 감사 짝의 L1 규칙도 있다: 감사 행은 같은 트랜잭션(created_at = now())이고 이전 요금제가 직전 행과 같아야 한다.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOrganizationOp } from '../../../src/admin/ops/agents';
import { PLAN_CATALOG, resolveEntitlements } from '../../../src/billing/plans';
import { loadEntitlements, loadOrgEntitlementsRow } from '../../../src/db/repositories/entitlements';
import { createPostgresPolicySource } from '../../../src/db/repositories/policy-source';
import { adminRolePool, appPool, AVAILABLE, ownerPool, suffix } from '../admin/support';
import { grantPlan } from '../../support/entitlements';
import { provisioningPool, rejects, seedFixture, testPool } from './support/harness';

describe.skipIf(!AVAILABLE)('org_entitlements · billing_audit (202609250300)', () => {
  let owner: Pool;
  let admin: Pool;
  let app: Pool;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    app = appPool();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), app.end()]);
  });

  async function org(): Promise<string> {
    return (await createOrganizationOp(owner, { name: `ent-${suffix()}`, ownerEmail: `ent-${suffix()}@example.com` })).id;
  }

  /** 소유자 롤 트랜잭션 — 감사 행(이전 요금제 `fromPlan`)과 함께 버전을 올린다. */
  async function bump(organizationId: string, set: string, auditPlan: string, version: number, fromPlan: string | null): Promise<void> {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO billing_audit (organization_id, from_plan, to_plan, cause, actor, entitlement_version) VALUES ($1, $4, $2, 'operator', 'test', $3)`,
        [organizationId, auditPlan, version, fromPlan],
      );
      await client.query(`UPDATE org_entitlements SET ${set}, source = 'operator', cause = 'operator', version = version + 1 WHERE organization_id = $1`, [organizationId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('① 앱·admin 롤은 읽기만 — INSERT·UPDATE·DELETE 는 42501 · billing_audit 은 SELECT 도 없다', async () => {
    const id = await org();
    await grantPlan(owner, id, 'free');
    for (const pool of [app, admin]) {
      expect((await pool.query('SELECT plan_code FROM org_entitlements WHERE organization_id = $1', [id])).rows).toEqual([{ plan_code: 'free' }]);
      expect((await rejects(pool.query(`UPDATE org_entitlements SET plan_code = 'scale' WHERE organization_id = $1`, [id]))).code).toBe('42501');
      expect((await rejects(pool.query('DELETE FROM org_entitlements WHERE organization_id = $1', [id]))).code).toBe('42501');
      const other = await org();
      expect(
        (await rejects(pool.query(`INSERT INTO org_entitlements (organization_id, plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max,
             agent_per_minute_max, recipients_per_message_max, tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes, version)
           VALUES ($1, 'scale', 'operator', 'operator', 200, 1000, 5000, 600, 50, 5, 10, 5, 0, 1)`, [other]))).code,
      ).toBe('42501');
      expect((await rejects(pool.query('SELECT 1 FROM billing_audit LIMIT 1'))).code).toBe('42501');
      expect((await rejects(pool.query(`INSERT INTO billing_audit (organization_id, to_plan, cause, actor, entitlement_version) VALUES ($1, 'scale', 'operator', 'x', 2)`, [id]))).code).toBe('42501');
    }
  });

  it('② version 은 하나씩 앞으로만 · 조직 불변 · 지우기·비우기 거부 · 감사 행이 없으면 커밋되지 않는다', async () => {
    const id = await org();
    await grantPlan(owner, id, 'free');
    await bump(id, `plan_code = 'pro'`, 'pro', 2, 'free');
    expect((await owner.query('SELECT plan_code, version::int AS version FROM org_entitlements WHERE organization_id = $1', [id])).rows).toEqual([{ plan_code: 'pro', version: 2 }]);
    // 버전을 그대로 두거나 건너뛰면 트리거가 거부한다.
    expect((await rejects(owner.query(`UPDATE org_entitlements SET max_agents = 9 WHERE organization_id = $1`, [id]))).message).toContain('하나씩 앞으로만');
    expect((await rejects(owner.query(`UPDATE org_entitlements SET version = version + 2 WHERE organization_id = $1`, [id]))).message).toContain('하나씩 앞으로만');
    expect((await rejects(owner.query(`UPDATE org_entitlements SET version = version - 1 WHERE organization_id = $1`, [id]))).code).toBe('23514');
    // 감사 행 없는 변경 — 문장은 되지만 커밋(지연 트리거)에서 되돌아간다.
    const failed = await rejects(owner.query(`UPDATE org_entitlements SET plan_code = 'scale', source = 'operator', cause = 'operator', version = version + 1 WHERE organization_id = $1`, [id]));
    expect(failed.code).toBe('23514');
    expect(failed.message).toContain('billing_audit');
    expect((await owner.query('SELECT plan_code FROM org_entitlements WHERE organization_id = $1', [id])).rows).toEqual([{ plan_code: 'pro' }]);
    // 감사 행의 요금제가 다르면 짝이 아니다.
    expect((await rejects(bump(id, `plan_code = 'team'`, 'scale', 3, 'pro'))).code).toBe('23514');
    // L1: 감사 행의 이전 요금제가 직전 행과 다르면(강등을 승급으로 꾸미기) 짝이 아니다.
    expect((await rejects(bump(id, `plan_code = 'team'`, 'team', 3, 'free'))).message).toContain('billing_audit');
    // L1: 앞 트랜잭션에 미리 적어 둔 감사 행은 나중 변경의 감사가 되지 못한다(created_at = 이 트랜잭션의 now()).
    await owner.query(
      `INSERT INTO billing_audit (organization_id, from_plan, to_plan, cause, actor, entitlement_version) VALUES ($1, 'pro', 'team', 'operator', 'pre-written', 3)`,
      [id],
    );
    const prewritten = await rejects(owner.query(`UPDATE org_entitlements SET plan_code = 'team', source = 'operator', cause = 'operator', version = version + 1 WHERE organization_id = $1`, [id]));
    expect(prewritten.message).toContain('billing_audit');
    expect((await owner.query('SELECT plan_code, version::int AS version FROM org_entitlements WHERE organization_id = $1', [id])).rows).toEqual([{ plan_code: 'pro', version: 2 }]);
    expect((await rejects(owner.query('DELETE FROM org_entitlements WHERE organization_id = $1', [id]))).code).toBe('23514');
    const other = await org();
    expect((await rejects(owner.query(`UPDATE org_entitlements SET organization_id = $2, version = version + 1 WHERE organization_id = $1`, [id, other]))).code).toBe('23514');
    // 첫 행은 version 1 만.
    const fresh = await org();
    expect(
      (await rejects(owner.query(`INSERT INTO org_entitlements (organization_id, plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max,
           agent_per_minute_max, recipients_per_message_max, tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes, version)
         VALUES ($1, 'free', 'default', 'backfill', 3, 100, 100, 5, 10, 2, 1, 1, 0, 7)`, [fresh]))).message,
    ).toContain('version 은 1');
  });

  it('③ 칸 상한 = 코드 천장(CHECK) · 출처↔원인 짝', async () => {
    const id = await org();
    for (const [column, value] of [
      ['recipients_per_message_max', 51],
      ['org_daily_recipients', 1001],
      ['tokens_per_agent_max', 6],
      ['org_api_keys_max', 6],
      ['webhook_endpoints_per_agent_max', 11],
      ['max_agents', 1001],
      ['agent_per_minute_max', 10_000],
    ] as const) {
      // 조직마다 새로 — grantPlan 은 감사 행을 먼저 쓴다(같은 조직·버전이면 UNIQUE 가 먼저 막는다).
      expect((await rejects(grantPlan(owner, await org(), 'scale', { [column]: value }))).code, column).toBe('23514');
    }
    const mismatch = await rejects(
      owner.query(`INSERT INTO org_entitlements (organization_id, plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max,
           agent_per_minute_max, recipients_per_message_max, tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes, version)
         VALUES ($1, 'scale', 'provider', 'operator', 200, 1000, 5000, 600, 50, 5, 10, 5, 0, 1)`, [id]),
    );
    expect(mismatch.message).toContain('org_entitlements_source_cause');
  });

  it('④ 투명성 outbox — INSERT(rev 0)·UPDATE(rev 1) 마다 그때 값 스냅샷 · at = updated_at · 금액·고객 칸 없음', async () => {
    const id = await org();
    await grantPlan(owner, id, 'free');
    await bump(id, `plan_code = 'team', max_agents = 50`, 'team', 2, 'free');
    const rows = await owner.query<{ event: string; rev: number; snapshot: Record<string, unknown> | null; processed: boolean }>(
      `SELECT event, rev, snapshot, processed_at IS NOT NULL AS processed FROM tlog_outbox
        WHERE source_table = 'org_entitlements' AND source_id = $1 ORDER BY rev`,
      [id],
    );
    const pending = rows.rows.filter((row) => !row.processed);
    expect(rows.rows.map((row) => [row.event, row.rev])).toEqual([
      ['insert', 0],
      ['update', 1],
    ]);
    // 서열기가 아직 집지 않았으면 스냅샷이 있다(서열 뒤 NULL).
    for (const row of pending) {
      expect(Object.keys(row.snapshot ?? {}).sort()).toEqual(
        [
          'agent_per_day_max',
          'agent_per_minute_max',
          // tlog v4(202609270115) — 메일 기본기 2차 두 칸.
          'aliases_per_agent_max',
          'at',
          'attachment_bytes_total_max',
          'cause',
          'grace_until',
          'inbound_storage_bytes',
          'max_agents',
          'org_api_keys_max',
          'org_daily_recipients',
          'plan_code',
          'recipients_per_message_max',
          'tokens_per_agent_max',
          'version',
          'webhook_endpoints_per_agent_max',
        ].sort(),
      );
    }
    const last = pending.at(-1);
    if (last !== undefined && last.rev === 1) {
      const updated = await owner.query<{ at: string }>(
        `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM org_entitlements WHERE organization_id = $1`,
        [id],
      );
      expect(last.snapshot).toMatchObject({ plan_code: 'team', cause: 'operator', version: 2, max_agents: 50, at: updated.rows[0]?.at });
    }
  });

  it('⑤ 정책 소스(앱 롤) — 행 없음 = null → Free · beta 행 → 행 그대로', async () => {
    const source = createPostgresPolicySource(testPool());
    const now = new Date();
    const none = await seedFixture(testPool(), { plan: null });
    const beta = await seedFixture(testPool());
    const load = (agentId: typeof none.agentId) => source.load({ agentId, recipients: [], now, threadId: null, releaseApprovalId: null });
    const missing = await load(none.agentId);
    expect(missing.entitlements).toBeNull();
    expect(resolveEntitlements(missing.entitlements, now)).toMatchObject({ planCode: 'free', basis: 'missing' });
    const row = await load(beta.agentId);
    expect(row.entitlements).toMatchObject({ plan_code: 'beta', max_agents: 10, version: '1' });
    expect(provisioningPool()).toBeDefined();
  });

  it('⑥ billing_audit — 고치기·지우기·비우기 거부(소유자 롤도)', async () => {
    const id = await org();
    await grantPlan(owner, id, 'free');
    expect((await rejects(owner.query(`UPDATE billing_audit SET actor = 'x' WHERE organization_id = $1`, [id]))).code).toBe('23514');
    expect((await rejects(owner.query('DELETE FROM billing_audit WHERE organization_id = $1', [id]))).code).toBe('23514');
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      expect((await rejects(client.query('TRUNCATE billing_audit'))).code).toBe('23514');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('⑦ 표가 없으면(마이그레이션 전) table_missing — 행 없음(Free)이 아니라 도입 전 한도(beta 값) · 운영자 쓰기는 거부', async () => {
    const fixture = await seedFixture(testPool(), { plan: null });
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL lock_timeout = \'2s\'');
      await client.query('ALTER TABLE org_entitlements RENAME TO org_entitlements_hidden_for_test');
      expect(await loadOrgEntitlementsRow(client, fixture.organizationId)).toBe('table_missing');
      expect(await loadEntitlements(client, fixture.organizationId, new Date())).toMatchObject({
        planCode: 'beta',
        basis: 'table_missing',
        maxAgents: PLAN_CATALOG.beta.maxAgents,
        recipientsPerMessageMax: PLAN_CATALOG.beta.recipientsPerMessageMax,
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // 표가 있으면 같은 조직은 행 없음 = Free.
    expect(await loadOrgEntitlementsRow(owner, fixture.organizationId)).toBeNull();
    expect((await loadEntitlements(owner, fixture.organizationId, new Date())).basis).toBe('missing');
  });

  it('⑧ 천장 트리거 — 에이전트당 활성 웹훅 10(소유자 롤도 · 되살림 포함) · 조직당 에이전트 1000(비활성 포함)', async () => {
    const fixture = await seedFixture(testPool());
    const hook = (n: number) =>
      owner.query(`INSERT INTO webhook_endpoints (agent_id, url, secret_kid) VALUES ($1, $2, 'k1') RETURNING id`, [fixture.agentId, `https://hook-${String(n)}-${suffix()}.example.com/`]);
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) ids.push((await hook(i)).rows[0]?.id as string);
    expect((await rejects(hook(10))).message).toContain('max 10');
    // 하나를 끄면 새로 넣을 수 있고, 꺼진 것을 되살리면 다시 천장에 걸린다.
    await owner.query('UPDATE webhook_endpoints SET disabled_at = now() WHERE id = $1', [ids[0]]);
    await hook(11);
    expect((await rejects(owner.query('UPDATE webhook_endpoints SET disabled_at = NULL WHERE id = $1', [ids[0]]))).code).toBe('23514');

    // 에이전트 1000 — 한 트랜잭션에서 채우고 되돌린다(투명성 outbox 를 남기지 않는다).
    const orgId = await org();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents)
         SELECT substr(md5($1 || g::text), 1, 32), $2, 'bulk-' || g::text, 'disabled', 'free', 1000 FROM generate_series(1, 1000) g`,
        [suffix(), orgId],
      );
      const over = await rejects(
        client.query(`INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, 'one-more', 'provisioning', 'free', 1000)`, [
          'f'.repeat(32),
          orgId,
        ]),
      );
      expect(over.code).toBe('23514');
      expect(over.message).toContain('max 1000');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
