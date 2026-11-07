/**
 * 메일 기본기 2차 D6 — `billing.entitlement` 잎 **9칸 → 11칸 전환**(tlog v4, 202609270105~0120 · 계획 §4 D6 F18 해법) — 실제 Postgres · 실제 롤.
 *
 *   AC-D6-2 전환: v4 전에 적재된 **9칸 스냅샷**이 outbox 에 남은 채 새 서열기가 돌면 9칸 잎을 만든다(`source.missing` 0). v4 스냅샷은 11칸 잎.
 *           **10칸 스냅샷**(두 칸 중 하나만)은 `source.missing(unrepresentable)`.
 *   AC-D6-3 판 4 검증기: 행에 늦은 두 칸이 있는데 마지막 잎이 9칸이면 `row_leaf_mismatch`(aliases…) — 백필 UPDATE(원인 backfill · version+1)가
 *           11칸 잎을 더하면 접기 대조가 통과한다(9칸 레거시 잎 → 11칸 잎). 번들은 `min_verifier_version = 4` 를 요구한다(판 3 = verifier_outdated).
 *   AC-D6-4 `atmark_billing` 은 카탈로그 밖 값(pro 에 별칭 6)을 쓰지 못한다 · 두 칸을 모르는 옛 billing 쓰기는 카탈로그 값으로 채워진다.
 *
 * 9칸 스냅샷은 "v4 전 outbox 잔량" 을 흉내 낸다 — 소유자 롤이 outbox 가드를 한 트랜잭션에서 끄고 두 키를 지운다(운영에서는 0115 전에 적재된 행).
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setOrgPlanOp } from '../../../scripts/admin/plan';
import { verifyBundle, VERIFIER_VERSION } from '../../../scripts/tlog-verify/verifier';
import type { AdminDependencies } from '../../../src/admin/context';
import { MIB, PLAN_CATALOG } from '../../../src/billing/plans';
import { createPool } from '../../../src/db/client';
import { closeEpoch } from '../../../src/tlog/epoch';
import { publishPendingEpochs } from '../../../src/tlog/publisher';
import { drainOutboxFully } from '../../support/tlog-drain';
import { endPools, holdEpochTestLock, roleUrlOf } from '../../support/tlog-epoch-test-lock';
import { memoryPublished, memoryWriter, testNoteSigner } from '../../support/tlog-fixtures';
import { adminDeps, adminRolePool, APP_URL, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, type Session } from '../admin/support';
import { billingOrg, billingPool } from '../billing/support';

const LATE = ['aliases_per_agent_max', 'attachment_bytes_total_max'] as const;

describe.skipIf(!AVAILABLE)('엔타이틀먼트 잎 9칸 → 11칸 전환(tlog v4) — 실제 Postgres', { timeout: 180_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let tlog: Pool;
  let billing: Pool;
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
    billing = billingPool();
    deps = adminDeps(admin);
  }, 300_000);
  afterAll(async () => {
    await releaseEpochLock?.();
    await endPools(owner, admin, mailer, tlog, billing);
  });

  async function tick(at?: Date): Promise<number> {
    await drainOutboxFully(tlog);
    const closed = await closeEpoch({ db: tlog, signer, published, now: () => at ?? new Date(), cadence: 'always' });
    await publishPendingEpochs({ db: tlog, writer, maxEpochs: 500 });
    expect(closed.closed).toBe(true);
    return closed.epoch ?? -1;
  }

  async function windowAfter(start: number, ms: number): Promise<Date> {
    const closed = (await owner.query<{ closed_at: Date }>('SELECT closed_at FROM tlog_epochs WHERE epoch = $1', [start])).rows[0]?.closed_at.getTime() ?? 0;
    return new Date(Math.max(Date.now(), closed) + ms);
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

  /** 처리 전 outbox 스냅샷에서 키를 지운다(v4 전 적재 행 흉내) — 소유자 롤 · 가드를 이 트랜잭션에서만 끈다. */
  async function stripPendingSnapshot(organizationId: string, keys: readonly string[]): Promise<void> {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE tlog_outbox DISABLE TRIGGER tlog_outbox_guard');
      const removed = keys.reduce((expr, _key, index) => `${expr} - $${String(index + 2)}::text`, 'snapshot');
      const result = await client.query(
        `UPDATE tlog_outbox SET snapshot = ${removed} WHERE source_table = 'org_entitlements' AND source_id = $1 AND processed_at IS NULL`,
        [organizationId, ...keys],
      );
      expect(result.rowCount).toBeGreaterThan(0);
      await client.query('ALTER TABLE tlog_outbox ENABLE TRIGGER tlog_outbox_guard');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function leavesOf(organizationId: string): Promise<{ kind: string; body: Record<string, unknown> }[]> {
    const rows = await owner.query<{ kind: string; leaf_json: string }>(
      `SELECT kind, leaf_json FROM tlog_leaves WHERE source_table = 'org_entitlements' AND source_id = $1 ORDER BY seq`,
      [organizationId],
    );
    return rows.rows.map((row) => ({ kind: row.kind, body: (JSON.parse(row.leaf_json) as { body: Record<string, unknown> }).body }));
  }

  /** 202609270120 과 같은 백필 UPDATE(이 조직 하나) — 원인 backfill · version + 1 · 두 칸 = 카탈로그 · 감사 짝. */
  async function backfill(organizationId: string): Promise<void> {
    await owner.query(
      `WITH audit AS (
         INSERT INTO billing_audit (organization_id, from_plan, to_plan, cause, actor, entitlement_version)
         SELECT e.organization_id, e.plan_code, e.plan_code, 'backfill', 'migration:202609270120', e.version + 1 FROM org_entitlements e WHERE e.organization_id = $1
       )
       UPDATE org_entitlements SET cause = 'backfill', version = version + 1,
              aliases_per_agent_max = aliases_per_agent_max, attachment_bytes_total_max = attachment_bytes_total_max
        WHERE organization_id = $1`,
      [organizationId],
    );
  }

  it('AC-D6-2 · AC-D6-3 — 9칸 스냅샷은 9칸 잎(source.missing 0) → 판 4 가 접기 불일치로 잡고 → 백필 11칸 잎 뒤 통과', async () => {
    const f = await organization();
    const start = await tick();
    await setOrgPlanOp(owner, { organizationId: f.id, plan: 'pro', overrides: {}, graceUntil: undefined, actor: 'admin:plan:test', note: null });
    await stripPendingSnapshot(f.id, LATE);
    const middle = await tick(await windowAfter(start, 3 * 60 * 1000));

    const legacy = await leavesOf(f.id);
    expect(legacy.map((leaf) => leaf.kind)).toEqual(['billing.entitlement']);
    for (const field of LATE) expect(Object.hasOwn(legacy[0]?.body ?? {}, field), field).toBe(false);
    expect(legacy[0]?.body).toMatchObject({ plan_code: 'pro', version: 1, max_agents: PLAN_CATALOG.pro.maxAgents });

    // 행에는 두 칸이 있다(채움 트리거 · 새 쓰기) — 마지막 잎(9칸)과 접기 대조가 어긋난다.
    const mismatchBundle = await bundleOf(f.session, start, middle);
    expect(mismatchBundle['min_verifier_version']).toBe(4);
    // 판 5(ADR-0014 단계 3)는 도메인·대표 주소 잎이 든 번들만 요구한다 — 이 번들은 그대로 4 이고 판 4 이상이면 읽는다.
    expect(VERIFIER_VERSION).toBeGreaterThanOrEqual(4);
    const mismatch = verifyBundle(mismatchBundle, { pinnedVkey: mismatchBundle['vkey'] as string }).errors.filter((issue) => issue.code === 'row_leaf_mismatch');
    expect(mismatch.some((issue) => issue.detail.startsWith(`org_entitlements:${f.id}`) && issue.detail.includes('aliases_per_agent_max'))).toBe(true);

    await backfill(f.id);
    const end = await tick(await windowAfter(middle, 3 * 60 * 1000));
    const after = await leavesOf(f.id);
    expect(after.map((leaf) => leaf.kind)).toEqual(['billing.entitlement', 'billing.entitlement']);
    expect(after[1]?.body).toMatchObject({
      cause: 'backfill',
      version: 2,
      aliases_per_agent_max: PLAN_CATALOG.pro.aliasesPerAgentMax,
      attachment_bytes_total_max: PLAN_CATALOG.pro.attachmentBytesTotalMax,
    });
    const bundle = await bundleOf(f.session, start, end);
    const rows = (bundle['sources'] as { rows: { t: string; id: string }[] }).rows.filter((row) => row.t === 'org_entitlements');
    expect(rows).toMatchObject([{ id: f.id, version: 2, aliases_per_agent_max: 5, attachment_bytes_total_max: 10 * MIB }]);
    expect(verifyBundle(bundle, { pinnedVkey: bundle['vkey'] as string }).errors).toEqual([]);
  });

  it('AC-D6-2 — v4 스냅샷은 11칸 잎 · 10칸 스냅샷(두 칸 중 하나만)은 source.missing(unrepresentable)', async () => {
    const whole = await organization();
    const partial = await organization();
    await tick();
    await setOrgPlanOp(owner, { organizationId: whole.id, plan: 'team', overrides: {}, graceUntil: undefined, actor: 'admin:plan:test', note: null });
    await setOrgPlanOp(owner, { organizationId: partial.id, plan: 'team', overrides: {}, graceUntil: undefined, actor: 'admin:plan:test', note: null });
    await stripPendingSnapshot(partial.id, ['attachment_bytes_total_max']);
    await drainOutboxFully(tlog);

    const eleven = await leavesOf(whole.id);
    expect(eleven.map((leaf) => leaf.kind)).toEqual(['billing.entitlement']);
    expect(eleven[0]?.body).toMatchObject({ aliases_per_agent_max: 10, attachment_bytes_total_max: 20 * MIB });

    const ten = await owner.query<{ kind: string; leaf_json: string }>(
      `SELECT kind, leaf_json FROM tlog_leaves WHERE source_table = 'org_entitlements' AND source_id = $1`,
      [partial.id],
    );
    expect(ten.rows.map((row) => row.kind)).toEqual(['source.missing']);
    expect((JSON.parse(ten.rows[0]?.leaf_json ?? '{}') as { body: { reason: string } }).body.reason).toBe('unrepresentable');
  });

  it('AC-D6-4 — atmark_billing: 카탈로그 밖 값(pro 별칭 6) 거부 · 두 칸을 모르는 옛 쓰기(INSERT·UPDATE)는 카탈로그 값으로 채운다', async () => {
    const org = await billingOrg(owner, null);
    const legacyColumns = `organization_id, plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max, agent_per_minute_max,
      recipients_per_message_max, tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes, version`;
    const pro = PLAN_CATALOG.pro;
    const legacyValues = [org.id, 'pro', 'provider', 'provider_event', pro.maxAgents, pro.orgDailyRecipients, pro.agentPerDayMax, pro.agentPerMinuteMax,
      pro.recipientsPerMessageMax, pro.tokensPerAgentMax, pro.webhookEndpointsPerAgentMax, pro.orgApiKeysMax, pro.inboundStorageBytes];
    const inTransaction = async (body: (client: import('pg').PoolClient) => Promise<void>): Promise<void> => {
      const client = await billing.connect();
      try {
        await client.query('BEGIN');
        await body(client);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    const audit = (client: import('pg').PoolClient, from: string | null, to: string, version: number) =>
      client.query(
        `INSERT INTO billing_audit (organization_id, from_plan, to_plan, cause, actor, entitlement_version) VALUES ($1, $2, $3, 'provider_event', 'provider:paddle', $4)`,
        [org.id, from, to, version],
      );

    // 카탈로그 밖 값 — pro 에 별칭 6.
    await expect(
      inTransaction(async (client) => {
        await audit(client, null, 'pro', 1);
        await client.query(
          `INSERT INTO org_entitlements (${legacyColumns}, aliases_per_agent_max, attachment_bytes_total_max)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, 6, $14)`,
          [...legacyValues, pro.attachmentBytesTotalMax],
        );
      }),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/카탈로그 한도만/) });

    // 옛 코드의 INSERT(두 칸 없음) → 채움 트리거가 pro 카탈로그.
    await inTransaction(async (client) => {
      await audit(client, null, 'pro', 1);
      await client.query(`INSERT INTO org_entitlements (${legacyColumns}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1)`, legacyValues);
    });
    const inserted = await owner.query('SELECT aliases_per_agent_max, attachment_bytes_total_max FROM org_entitlements WHERE organization_id = $1', [org.id]);
    expect(inserted.rows[0]).toEqual({ aliases_per_agent_max: 5, attachment_bytes_total_max: 10 * MIB });

    // 옛 코드의 UPDATE(pro → team, 두 칸 그대로) → 가드가 team 카탈로그로 맞춘다.
    const team = PLAN_CATALOG.team;
    await inTransaction(async (client) => {
      await audit(client, 'pro', 'team', 2);
      await client.query(
        `UPDATE org_entitlements SET plan_code = 'team', max_agents = $2, agent_per_day_max = $3, agent_per_minute_max = $4, recipients_per_message_max = $5,
                webhook_endpoints_per_agent_max = $6, org_api_keys_max = $7, inbound_storage_bytes = $8, version = version + 1
          WHERE organization_id = $1`,
        [org.id, team.maxAgents, team.agentPerDayMax, team.agentPerMinuteMax, team.recipientsPerMessageMax, team.webhookEndpointsPerAgentMax, team.orgApiKeysMax,
          team.inboundStorageBytes],
      );
    });
    const updated = await owner.query('SELECT plan_code, aliases_per_agent_max, attachment_bytes_total_max FROM org_entitlements WHERE organization_id = $1', [org.id]);
    expect(updated.rows[0]).toEqual({ plan_code: 'team', aliases_per_agent_max: 10, attachment_bytes_total_max: 20 * MIB });

    // 두 칸을 바꾼 쓰기는 카탈로그와 같아야 한다 — team 에 별칭 11.
    await expect(
      inTransaction(async (client) => {
        await audit(client, 'team', 'team', 3);
        await client.query('UPDATE org_entitlements SET aliases_per_agent_max = 11, version = version + 1 WHERE organization_id = $1', [org.id]);
      }),
    ).rejects.toMatchObject({ code: '42501' });

    // 공급자 롤은 백필 원인을 쓰지 못한다(CHECK 은 넓어졌지만 가드가 묶는다).
    await expect(
      inTransaction(async (client) => {
        await client.query(
          `INSERT INTO billing_audit (organization_id, from_plan, to_plan, cause, actor, entitlement_version) VALUES ($1, 'team', 'team', 'backfill', 'provider:paddle', 3)`,
          [org.id],
        );
        await client.query(`UPDATE org_entitlements SET cause = 'backfill', version = version + 1 WHERE organization_id = $1`, [org.id]);
      }),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/공급자 원인만/) });
  });
});
