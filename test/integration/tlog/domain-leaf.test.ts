/**
 * 고객 도메인 잎 `domain.status`(202609291130 · ADR-0014 단계 3) — 실제 Postgres · 실제 롤(atmark_tlog · atmark_admin). 검증기 판 5.
 *
 *   ① 도메인 행의 상태 사건(생성 pending → verifying → verified → suspended(plan_limit))마다 잎 하나 · 평문에 도메인 이름 없음.
 *   ② 번들 — 원천 행(custom_domains)이 실리고 `min_verifier_version: 5` · 판 5 와 2차 검증기 통과 · 판 4(동결본)는 `verifier_outdated`.
 *      같은 범위에 도메인 잎이 없는 조직의 번들은 그대로 4(판 4 통과).
 *   ③ 변조 — 잎 트리거를 끄고 상태를 바꾸면 판 5 가 row_leaf_mismatch(status · reason).
 *   ④ 신원 블록 — 그 도메인에 주소가 있는 에이전트의 `domains`(체인 밖) · 커밋이 DB 이름으로 열린다 · 판 5 가 증명으로 묶는다.
 *   ⑤ 마지막 체크포인트 뒤의 정상 제거 — removed 잎은 아직 열린 에폭(범위 밖)인데 행은 실린다(제거 시각 상한 없음) → 오류 없이 대기 → 다음 번들의
 *      removed 잎으로 풀린다(최종 확인 — domain_row_missing 오탐 회귀).
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
import { addAlias, requestRemoval, suspendDomain, verifiedCustomDomain } from '../policy/support';

describe.skipIf(!AVAILABLE)('고객 도메인 잎 domain.status — 실제 Postgres · 검증기 판 5', { timeout: 120_000 }, () => {
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

  const bundleOf = (organizationId: string, from: number, to: number): Promise<Record<string, unknown>> =>
    buildVerificationBundle(admin, organizationId, { fromEpoch: from, toEpoch: to, now: new Date() });

  it('① 상태 사건마다 잎 · ② 번들 min 5 · 판 5 · 2차 통과 · 판 4 는 verifier_outdated · 도메인 없는 조직은 4 · ④ 신원 블록 도메인 사건', async () => {
    // 조직 로그를 시작 에폭 안에서 열어 둔다(앞 테스트 파일이 미래 시각으로 닫은 에폭이 있으면 창세 잎이 그 뒤로 밀려 org_start_hidden 이 된다).
    const f = await seedFixture(testPool());
    const plain = await seedFixture(testPool());
    const start = await tick();
    const { id, domain } = await verifiedCustomDomain(f.organizationId);
    const alias = `bot-${randomBytes(3).toString('hex')}@${domain}`;
    await addAlias(f.agentId, alias);
    await suspendDomain(id, 'plan_limit');
    const end = await tick(await windowAfter(start, 3 * 60 * 1000));

    const leaves = await owner.query<{ kind: string; event: string; rev: number; leaf_json: string }>(
      `SELECT kind, event, rev, leaf_json FROM tlog_leaves WHERE source_table = 'custom_domains' AND source_id = $1 ORDER BY seq`,
      [id],
    );
    expect(leaves.rows.map((row) => [row.kind, row.event, row.rev, (JSON.parse(row.leaf_json) as { body: { status: string } }).body.status])).toEqual([
      ['domain.status', 'insert', 0, 'pending'],
      ['domain.status', 'update', 1, 'verifying'],
      ['domain.status', 'update', 2, 'verified'],
      ['domain.status', 'update', 3, 'suspended'],
    ]);
    expect(leaves.rows.map((row) => row.leaf_json).join('\n')).not.toContain(domain);

    const bundle = await bundleOf(f.organizationId, start, end);
    expect(bundle['min_verifier_version']).toBe(5);
    const rows = (bundle['sources'] as { rows: { t: string; id: string }[] }).rows.filter((row) => row.t === 'custom_domains');
    expect(rows).toMatchObject([{ t: 'custom_domains', id, domain, status: 'suspended', suspended_reason: 'plan_limit' }]);
    const report = verifyBundle(bundle, { pinnedVkey: bundle['vkey'] as string });
    expect(report.errors).toEqual([]);
    expect(await secondVerify(bundle as never)).toEqual([]);
    expect(verifyBundleV4(bundle, { pinnedVkey: bundle['vkey'] as string }).errors.map((issue) => issue.code)).toEqual(['verifier_outdated']);

    const plainBundle = await bundleOf(plain.organizationId, start, end);
    expect(plainBundle['min_verifier_version']).toBe(4);
    expect(verifyBundleV4(plainBundle, { pinnedVkey: plainBundle['vkey'] as string }).errors).toEqual([]);

    const blocks = await identityBlocksFor(admin, f.organizationId, f.agentId, { now: new Date(), proofs: true });
    expect(blocks.domains.map((event) => [event.status, event.reason, event.domain, event.domainMatches])).toEqual([
      ['pending', null, domain, true],
      ['verifying', null, domain, true],
      ['verified', null, domain, true],
      ['suspended', 'plan_limit', domain, true],
    ]);
    const blockReport = verifyIdentityBlocks(blocks, { pinnedVkey: bundle['vkey'] as string });
    expect(blockReport.errors).toEqual([]);
    expect(blockReport.stats).toMatchObject({ domains: 4, domains_proven: 4 });
    // 도메인 주소가 없는 에이전트는 custom_domains 를 읽지 않는다(빈 배열).
    expect((await identityBlocksFor(admin, plain.organizationId, plain.agentId, { now: new Date() })).domains).toEqual([]);
  });

  it('③ 변조 — 잎 트리거를 끄고 상태를 바꾸면 판 5 가 row_leaf_mismatch', async () => {
    const f = await seedFixture(testPool());
    const start = await tick();
    const { id } = await verifiedCustomDomain(f.organizationId);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE custom_domains DISABLE TRIGGER custom_domains_tlog_enqueue_update');
      await client.query(`UPDATE custom_domains SET status = 'suspended', suspended_reason = 'operator', suspended_at = now() WHERE id = $1`, [id]);
      await client.query('ALTER TABLE custom_domains ENABLE TRIGGER custom_domains_tlog_enqueue_update');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const end = await tick(await windowAfter(start, 3 * 60 * 1000));
    const report = verifyBundle(await bundleOf(f.organizationId, start, end), {});
    const mismatch = report.errors.filter((issue) => issue.code === 'row_leaf_mismatch').map((issue) => issue.detail);
    expect(mismatch.some((detail) => detail.startsWith(`custom_domains:${id}`) && detail.includes('status') && detail.includes('reason'))).toBe(true);
  });

  it('⑤ 마지막 체크포인트 뒤 정상 제거 — 오류 없이 대기(domain_fold_deferred) · 다음 번들의 removed 잎이 푼다', async () => {
    const f = await seedFixture(testPool());
    const start = await tick();
    const { id } = await verifiedCustomDomain(f.organizationId);
    const mid = await tick(await windowAfter(start, 3 * 60 * 1000));
    const first = verifyBundle(await bundleOf(f.organizationId, start, mid), {});
    expect(first.errors).toEqual([]);
    expect(first.state?.domain_folds).toHaveLength(1);
    // 도메인 잎이 없는 에폭 하나 — 다음 번들(mid~end)은 그 도메인의 잎을 싣지 않는다(행만 실릴 수 있다).
    const endAt = await windowAfter(mid, 3 * 60 * 1000);
    const end = await tick(endAt);

    // 체크포인트(end) 뒤의 정상 제거 — 잎은 outbox(다음 에폭)에 있고 범위 밖. 에폭 끝은 미래 시각(endAt)이라 제거 시각을 그 뒤로 옮겨
    // "창 끝 뒤 제거" 를 재현한다(시각만 — 소유자 롤이 그 트랜잭션에서만 트리거를 끈다).
    await requestRemoval(id);
    const removedAt = new Date(endAt.getTime() + 30_000);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query('UPDATE custom_domains SET removed_at = $2, updated_at = $2 WHERE id = $1', [id, removedAt]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const second = await buildVerificationBundle(admin, f.organizationId, { fromEpoch: mid, toEpoch: end, now: new Date(removedAt.getTime() + 60_000) });
    expect((second['sources'] as { rows: { t: string; id: string }[] }).rows.some((row) => row.t === 'custom_domains' && row.id === id)).toBe(true);
    const deferred = verifyBundle(second, { previous: first.state });
    expect(deferred.errors).toEqual([]);
    expect(deferred.warnings.some((warning) => warning.startsWith('domain_fold_deferred'))).toBe(true);

    const nextAt = new Date(endAt.getTime() + 5 * 60 * 1000);
    const next = await tick(nextAt);
    const third = await buildVerificationBundle(admin, f.organizationId, { fromEpoch: end, toEpoch: next, now: new Date(nextAt.getTime() + 60_000) });
    const resolved = verifyBundle(third, { previous: deferred.state });
    expect(resolved.errors).toEqual([]);
    expect(resolved.state?.domain_folds?.every((entry) => entry.updated_at === null)).toBe(true);
  });
});
