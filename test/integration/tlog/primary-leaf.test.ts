/**
 * 대표 주소 선택 잎 `identity.primary_set`(202610021110 · ADR-0014 2026-10 개정) — 실제 Postgres · 실제 롤(atmark_tlog 서열 · atmark_admin 선택 · 번들).
 * 잎 모양 · 서열 분기 · 검증기 판 5 는 M2 가 먼저 넣었다 — 여기서는 **DB 쪽이 열렸을 때 끝까지 도는지**를 본다:
 *
 *   ① admin 롤의 선택 INSERT → outbox → 서열(atmark_tlog — 칸 GRANT) → 잎 `identity.primary_set` 하나 · 평문에 주소(`@`) 없음.
 *   ② 번들(admin 롤 — 원천 행 SELECT) `min_verifier_version: 5` · 판 5 · 2차 검증기 통과 · 판 4(동결본)는 `verifier_outdated`.
 *   ③ 신원 블록 체인에 그 블록이 들고(커밋이 DB 주소로 열린다) 판 5 가 통과.
 */

import { randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { drainOutboxFully } from '../../support/tlog-drain';
import { endPools, holdEpochTestLock, roleUrlOf } from '../../support/tlog-epoch-test-lock';

import { verifyBundle, verifyIdentityBlocks } from '../../../scripts/tlog-verify/verifier';
import { createPool } from '../../../src/db/client';
import { closeEpoch } from '../../../src/tlog/epoch';
import { identityBlocksFor } from '../../../src/tlog/identity-blocks';
import { buildVerificationBundle } from '../../../src/tlog/proofs';
import { publishPendingEpochs } from '../../../src/tlog/publisher';
import { verifyBundle as verifyBundleV4 } from '../../support/legacy/tlog-verifier-v4';
import { memoryPublished, memoryWriter, testNoteSigner } from '../../support/tlog-fixtures';
import { secondVerify } from '../../support/tlog-second-verifier';
import { adminRolePool, APP_URL, AVAILABLE, ownerPool } from '../admin/support';
import { closeTestPool, seedFixture, testPool } from '../db/support/harness';
import { addAlias, verifiedCustomDomain } from '../policy/support';

describe.skipIf(!AVAILABLE)('대표 주소 선택 잎 identity.primary_set — 실제 Postgres · 검증기 판 5', { timeout: 120_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let tlog: Pool;
  const signer = testNoteSigner();
  const writer = memoryWriter();
  const published = memoryPublished(writer);

  let releaseEpochLock: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    owner = ownerPool();
    releaseEpochLock = await holdEpochTestLock(owner);
    admin = adminRolePool();
    tlog = createPool(roleUrlOf(APP_URL, 'atmark_tlog'), { max: 2 });
  }, 300_000);
  afterAll(async () => {
    await releaseEpochLock?.();
    await endPools(owner, admin, tlog);
    await closeTestPool();
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

  it('① 선택 → 잎 하나(평문 @ 0) · ② 번들 min 5 · 판 5 · 2차 통과 · 판 4 verifier_outdated · ③ 신원 블록', async () => {
    const f = await seedFixture(testPool());
    const start = await tick();
    const { domain } = await verifiedCustomDomain(f.organizationId);
    const alias = `lead-${randomBytes(3).toString('hex')}@${domain}`;
    await addAlias(f.agentId, alias);
    const target = (await owner.query<{ id: string }>('SELECT id::text AS id FROM agent_addresses WHERE address = $1', [alias])).rows[0]?.id;
    await admin.query(`INSERT INTO agent_primary_changes (agent_id, address_id, cause) VALUES ($1, $2, 'owner')`, [f.agentId, target]);
    const change = (await owner.query<{ id: string }>('SELECT id::text AS id FROM agent_primary_changes WHERE agent_id = $1', [f.agentId])).rows[0]?.id ?? '';
    const end = await tick(await windowAfter(start, 3 * 60 * 1000));

    const leaves = await owner.query<{ kind: string; event: string; leaf_json: string }>(
      `SELECT kind, event, leaf_json FROM tlog_leaves WHERE source_table = 'agent_primary_changes' AND source_id = $1 ORDER BY seq`,
      [change],
    );
    expect(leaves.rows.map((row) => [row.kind, row.event])).toEqual([['identity.primary_set', 'insert']]);
    const body = (JSON.parse(leaves.rows[0]?.leaf_json ?? '{}') as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({ agent_id: f.agentId, cause: 'owner' });
    expect(JSON.stringify(body)).not.toContain('@');

    const bundle = await buildVerificationBundle(admin, f.organizationId, { fromEpoch: start, toEpoch: end, now: new Date() });
    expect(bundle['min_verifier_version']).toBe(5);
    const rows = (bundle['sources'] as { rows: { t: string; id: string }[] }).rows.filter((row) => row.t === 'agent_primary_changes');
    expect(rows).toMatchObject([{ t: 'agent_primary_changes', id: change, agent_id: f.agentId, address: alias, cause: 'owner' }]);
    expect(verifyBundle(bundle, { pinnedVkey: bundle['vkey'] as string }).errors).toEqual([]);
    expect(await secondVerify(bundle as never)).toEqual([]);
    expect(verifyBundleV4(bundle, { pinnedVkey: bundle['vkey'] as string }).errors.map((issue) => issue.code)).toEqual(['verifier_outdated']);

    const blocks = await identityBlocksFor(admin, f.organizationId, f.agentId, { now: new Date(), proofs: true });
    const report = verifyIdentityBlocks(blocks, { pinnedVkey: bundle['vkey'] as string });
    expect(report.errors).toEqual([]);
    expect(JSON.stringify(blocks)).toContain('identity.primary_set');
  });
});
