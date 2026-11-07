/**
 * 요금제 잎 `billing.entitlement`(202609250300, ADR-0011) — 실제 Postgres · 실제 롤(atmark_tlog · atmark_admin).
 *
 *   ① 운영자 CLI 연산(`setOrgPlanOp`)의 버전마다 잎 하나(insert rev 0 → update rev 1) · 평문은 요금제 코드·한도·버전·원인·유예 끝뿐 ·
 *      행위자·사유·금액은 잎에 없다 · 커밋 칸 없음.
 *   ② 검증 번들 — 원천 행(org_entitlements)이 실리고 1차·2차 검증기가 통과한다(요금제 원천 대조).
 *   ③ 변조 — 잎 트리거를 끄고 요금제를 바꾸면 1차 검증기가 row_leaf_mismatch 로 잡는다.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { drainOutboxFully } from '../../support/tlog-drain';
import { endPools, holdEpochTestLock, roleUrlOf } from '../../support/tlog-epoch-test-lock';

import { setOrgPlanOp } from '../../../scripts/admin/plan';
import { verifyBundle } from '../../../scripts/tlog-verify/verifier';
import type { AdminDependencies } from '../../../src/admin/context';
import { createPool } from '../../../src/db/client';
import { closeEpoch } from '../../../src/tlog/epoch';
import { publishPendingEpochs } from '../../../src/tlog/publisher';
import { memoryPublished, memoryWriter, testNoteSigner } from '../../support/tlog-fixtures';
import { secondVerify } from '../../support/tlog-second-verifier';
import { adminDeps, adminRolePool, APP_URL, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, type Session } from '../admin/support';

const SENTINEL_ACTOR = 'admin:plan:sentinel-actor-7c1e@operator.example';
const SENTINEL_NOTE = 'SENTINEL-NOTE-7c1e 결제 사유';

describe.skipIf(!AVAILABLE)('요금제 잎 billing.entitlement — 실제 Postgres', { timeout: 120_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let tlog: Pool;
  let deps: AdminDependencies;
  const signer = testNoteSigner();
  const writer = memoryWriter();
  const published = memoryPublished(writer);

  let releaseEpochLock: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    owner = ownerPool();
    releaseEpochLock = await holdEpochTestLock(owner);
    admin = adminRolePool();
    mailer = loginMailerPool();
    tlog = createPool(roleUrlOf(APP_URL, 'atmark_tlog'), { max: 2 });
    deps = adminDeps(admin);
  }, 300_000);
  afterAll(async () => {
    await releaseEpochLock?.();
    await endPools(owner, admin, mailer, tlog);
  });

  async function tick(at?: Date): Promise<number> {
    await drainOutboxFully(tlog);
    const closed = await closeEpoch({ db: tlog, signer, published, now: () => at ?? new Date(), cadence: 'always' });
    await publishPendingEpochs({ db: tlog, writer, maxEpochs: 500 });
    expect(closed.closed).toBe(true);
    return closed.epoch ?? -1;
  }

  async function organization(): Promise<{ id: string; session: Session }> {
    const org = await newOrganization(owner, null);
    return { id: org.id, session: await login(deps, mailer, org) };
  }

  async function bundleOf(session: Session, from: number, to: number): Promise<Record<string, unknown>> {
    const result = await call(deps, 'GET', '/api/logs/bundle', authed(session, { query: `from=${String(from)}&to=${String(to)}` }));
    expect(result.statusCode, result.body).toBe(200);
    return result.json() as Record<string, unknown>;
  }

  const change = (organizationId: string, plan: 'pro' | 'team', overrides: Record<string, number> = {}) =>
    setOrgPlanOp(owner, { organizationId, plan, overrides, graceUntil: undefined, actor: SENTINEL_ACTOR, note: SENTINEL_NOTE });

  async function windowAfter(start: number, ms: number): Promise<Date> {
    const closed = (await owner.query<{ closed_at: Date }>('SELECT closed_at FROM tlog_epochs WHERE epoch = $1', [start])).rows[0]?.closed_at.getTime() ?? 0;
    return new Date(Math.max(Date.now(), closed) + ms);
  }

  it('① 버전마다 잎 하나 · 평문은 요금제·한도·버전·원인뿐(행위자·사유 없음) · ② 번들 원천 대조 — 두 검증기 통과', async () => {
    const f = await organization();
    const start = await tick();
    await change(f.id, 'pro');
    await change(f.id, 'team', { max_agents: 20 });
    const end = await tick(await windowAfter(start, 3 * 60 * 1000));

    const leaves = await owner.query<{ kind: string; event: string; rev: number; leaf_json: string }>(
      `SELECT kind, event, rev, leaf_json FROM tlog_leaves WHERE source_table = 'org_entitlements' AND source_id = $1 ORDER BY seq`,
      [f.id],
    );
    expect(leaves.rows.map((row) => [row.kind, row.event, row.rev])).toEqual([
      ['billing.entitlement', 'insert', 0],
      ['billing.entitlement', 'update', 1],
    ]);
    const bodies = leaves.rows.map((row) => JSON.parse(row.leaf_json) as { body: Record<string, unknown>; c: Record<string, string> });
    expect(bodies[0]?.body).toMatchObject({ plan_code: 'pro', cause: 'operator', version: 1, max_agents: 10, recipients_per_message_max: 25, grace_until: null });
    expect(bodies[1]?.body).toMatchObject({ plan_code: 'team', cause: 'operator', version: 2, max_agents: 20 });
    expect(bodies.every((leaf) => Object.keys(leaf.c).length === 0)).toBe(true);
    const joined = leaves.rows.map((row) => row.leaf_json).join('\n');
    expect(joined).not.toContain('sentinel-actor');
    expect(joined).not.toContain('SENTINEL-NOTE');

    const bundle = await bundleOf(f.session, start, end);
    expect(bundle['min_verifier_version']).toBe(4);
    const rows = (bundle['sources'] as { rows: { t: string; id: string }[] }).rows.filter((row) => row.t === 'org_entitlements');
    expect(rows).toMatchObject([{ t: 'org_entitlements', id: f.id, plan_code: 'team', version: 2, max_agents: 20 }]);
    const report = verifyBundle(bundle, { pinnedVkey: bundle['vkey'] as string });
    expect(report.errors).toEqual([]);
    expect(await secondVerify(bundle as never)).toEqual([]);
  });

  it('③ 변조 — 잎 트리거를 끄고 요금제를 올리면 1차 검증기가 row_leaf_mismatch(버전·요금제)', async () => {
    const f = await organization();
    const start = await tick();
    await change(f.id, 'pro');
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      // 지연 감사 트리거의 대기 사건이 있으면 ALTER TABLE 이 거부된다 — 이 트랜잭션에서는 즉시 검사로.
      await client.query('SET CONSTRAINTS org_entitlements_audited IMMEDIATE');
      await client.query('ALTER TABLE org_entitlements DISABLE TRIGGER org_entitlements_tlog_enqueue_update');
      await client.query(
        `INSERT INTO billing_audit (organization_id, from_plan, to_plan, cause, actor, entitlement_version) VALUES ($1, 'pro', 'scale', 'operator', 'forger', 2)`,
        [f.id],
      );
      await client.query(`UPDATE org_entitlements SET plan_code = 'scale', max_agents = 200, version = version + 1 WHERE organization_id = $1`, [f.id]);
      await client.query('ALTER TABLE org_entitlements ENABLE TRIGGER org_entitlements_tlog_enqueue_update');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const end = await tick(await windowAfter(start, 3 * 60 * 1000));
    const report = verifyBundle(await bundleOf(f.session, start, end), {});
    const mismatch = report.errors.filter((issue) => issue.code === 'row_leaf_mismatch').map((issue) => issue.detail);
    expect(mismatch.some((detail) => detail.startsWith(`org_entitlements:${f.id}`) && detail.includes('version') && detail.includes('plan_code'))).toBe(true);
  });
});
