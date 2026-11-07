/**
 * 신원 변경 이력 블록(US-013) — **실제 Postgres**(202609242200) · 실제 롤(atmark_tlog · atmark_admin · atmark_passport_signer) · 가짜 KMS·S3.
 *
 *   ① 신원 사건마다 잎: 생성(provisioning) → 활성 · 주소 · 키 · passport 게시(draft 는 잎 없음) · 정지/재개 → 블록 API 가 seq 순서로
 *      SHA-256(이전 ‖ 잎) 체인을 준다 · 표시 값(DB)이 잎의 커밋과 맞다 · 블록마다 포함 증명이 검증된다 · 두 검증기가 블록 파일을 통과시키고
 *      1바이트 변조를 거부한다 · 번들의 신원 원천 대조가 통과한다 · 이름·주소 센티넬은 어떤 잎에도 평문으로 없다.
 *   ② 변조 탐지: 소유자 롤이 주소를 고치고(트리거 없음) 상태 트리거를 끄고 상태를 고치면 — 블록 API 가 그 칸을 `matches:false` 로,
 *      검증기가 `row_leaf_mismatch` 로 보고한다.
 *   ③ 조직 범위: 다른 조직 세션은 404 · 잎 조회 자체도 조직으로 가른다.
 *   ④ 속도 제한: 같은 조직의 증명 슬롯이 잡혀 있으면 429(다른 조직은 막히지 않는다).
 *   적대적 검증 반영(2026-09-24):
 *   ① M4 — `?proofs=1` 파일은 고정한 vkey 로 "증명"(proven) · 증명 없는 파일은 "일관성만" · 두 검증기.
 *   ② L3 — 트리거를 끄고 바꾼 상태는 유예(15분) 안에서는 `pending`(서열 대기), 유예 뒤에는 `matches:false`.
 *   ⑤ M2 — 번들의 `identity_since` = `tlog_identity_since`(202609242300) · `min_verifier_version` · 검증기 상태가 고정한다.
 *   ⑥ L4 — 이 에이전트를 가리키는 `source.missing` 잎이 `missing`(빠진 블록)으로 나온다.
 *   ⑦ L1 — 조직당 분당 30번(429, 다른 조직은 막히지 않는다) · 블록 조회가 부분 색인을 쓴다.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { drainOutboxFully } from '../../support/tlog-drain';
import { endPools, holdEpochTestLock, roleUrlOf } from '../../support/tlog-epoch-test-lock';

import type { AdminDependencies } from '../../../src/admin/context';
import { createPool } from '../../../src/db/client';
import { toAgentId, type AgentId } from '../../../src/db/schema';
import { createLocalDevKeyCustody } from '../../../src/passport/custody-local';
import { runPassportPublisherTick } from '../../../src/passport/publisher';
import { createPassportSigner } from '../../../src/passport/signer';
import { closeEpoch } from '../../../src/tlog/epoch';
import { IDENTITY_CHAIN_SQL, IDENTITY_PENDING_GRACE_MS, identityBlocksFor, type IdentityBlocksResponse } from '../../../src/tlog/identity-blocks';
import { publishPendingEpochs } from '../../../src/tlog/publisher';
import { verifyBundle, verifyIdentityBlocks, verifyInclusionProof } from '../../../scripts/tlog-verify/verifier';
import { memoryPublished, memoryWriter, testNoteSigner } from '../../support/tlog-fixtures';
import { secondVerify, secondVerifyIdentityBlockProofs, secondVerifyIdentityBlocks } from '../../support/tlog-second-verifier';
import { verifiedCustomDomain } from '../policy/support';
import { adminDeps, adminRolePool, APP_URL, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from '../admin/support';

const SENTINEL_NAME = 'Sentinel Identity 5e1d';

describe.skipIf(!AVAILABLE)('신원 변경 이력 블록(US-013) — 실제 Postgres', { timeout: 120_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let tlog: Pool;
  let signerDb: Pool;
  let keyDir: string;
  let deps: AdminDependencies;
  const signer = testNoteSigner();
  const writer = memoryWriter();
  const published = memoryPublished(writer);
  const noop = { put: () => Promise.resolve(), invalidate: () => Promise.resolve() };

  let releaseEpochLock: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    owner = ownerPool();
    releaseEpochLock = await holdEpochTestLock(owner);
    admin = adminRolePool();
    mailer = loginMailerPool();
    tlog = createPool(roleUrlOf(APP_URL, 'atmark_tlog'), { max: 2 });
    signerDb = createPool(roleUrlOf(APP_URL, 'atmark_passport_signer'), { max: 2 });
    keyDir = mkdtempSync(join(tmpdir(), 'atmark-identity-blocks-'));
    deps = adminDeps(admin, { custody: () => createLocalDevKeyCustody({ directory: keyDir, env: {} }) });
  }, 300_000); // 이웃 파일이 에폭 잠금을 쥔 동안 기다린다(holdEpochTestLock).
  afterAll(async () => {
    await releaseEpochLock?.();
    await endPools(owner, admin, mailer, tlog, signerDb);
    // beforeAll 이 잠금 대기에서 실패하면 keyDir 는 만들어지지 않았다.
    if ((keyDir as string | undefined) !== undefined) rmSync(keyDir, { recursive: true, force: true });
  });

  async function tick(at?: Date): Promise<number> {
    await drainOutboxFully(tlog); // 다른 파일이 남긴 outbox 가 틱 상한(5 000)을 넘어도 이 조직 행까지(`test/support/tlog-drain.ts`)
    const closed = await closeEpoch({ db: tlog, signer, published, now: () => at ?? new Date(), cadence: 'always' });
    await publishPendingEpochs({ db: tlog, writer, maxEpochs: 500 });
    expect(closed.closed).toBe(true);
    return closed.epoch ?? -1;
  }

  const publisherTick = (agent: AgentId) =>
    runPassportPublisherTick(
      {
        db: signerDb,
        signer: createPassportSigner({ kind: 'local-dev', directory: keyDir, env: {} }),
        documents: { put: noop.put },
        cdn: { invalidate: noop.invalidate },
        now: () => new Date(Date.now() + 1000),
      },
      { agentIds: [agent] },
    );

  interface Fixture {
    readonly org: { id: string; ownerEmail: string };
    readonly session: Session;
  }

  async function organization(): Promise<Fixture> {
    const org = await newOrganization(owner);
    await owner.query(`UPDATE organizations SET review_status = 'active'::organization_review_status WHERE id = $1`, [org.id]);
    return { org, session: await login(deps, mailer, org) };
  }

  async function agentIn(f: Fixture, localPart: string): Promise<{ id: AgentId; address: string }> {
    const created = await call(deps, 'POST', '/api/agents', authed(f.session, { body: { name: SENTINEL_NAME, localPart } }));
    expect(created.statusCode, created.body).toBe(201);
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    return { id: toAgentId(agent.id), address: agent.address };
  }

  const blocksOf = async (f: Fixture, agent: string, proofs = false): Promise<IdentityBlocksResponse> => {
    const result = await call(deps, 'GET', `/api/agents/${agent}/identity-blocks`, authed(f.session, proofs ? { query: 'proofs=1' } : {}));
    expect(result.statusCode, result.body).toBe(200);
    return result.json() as IdentityBlocksResponse;
  };

  const killSwitch = async (f: Fixture, agent: string, on: boolean): Promise<void> => {
    const result = await call(deps, 'POST', '/api/kill-switch', authed(f.session, { body: { scope: 'agent', id: agent, on } }));
    expect(result.statusCode, result.body).toBe(200);
  };

  async function bundleOf(f: Fixture, from: number, to: number): Promise<Record<string, unknown>> {
    const result = await call(deps, 'GET', '/api/logs/bundle', authed(f.session, { query: `from=${String(from)}&to=${String(to)}` }));
    expect(result.statusCode, result.body).toBe(200);
    return result.json() as Record<string, unknown>;
  }

  it('① 신원 사건마다 잎 → 블록 API(순서 · 해시 연결 · DB 값 = 커밋) · 포함 증명 · 두 검증기 · 번들 원천 대조 · PII 센티넬 0', async () => {
    const f = await organization();
    const start = await tick();
    const agent = await agentIn(f, `idb-${suffix()}`);
    // draft 단계 — passport 잎 없음 · DID 없음(B5).
    await drainOutboxFully(tlog); // 다른 파일이 남긴 outbox 가 틱 상한(5 000)을 넘어도 이 조직 행까지(`test/support/tlog-drain.ts`)
    const draft = await blocksOf(f, agent.id);
    expect(draft.card.did).toBeNull();
    expect(draft.blocks.map((block) => block.kind)).not.toContain('identity.passport_version');
    expect(draft.card.keyFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // 게시 → 정지 → 재개.
    expect((await call(deps, 'POST', `/api/agents/${agent.id}/identity/publish`, authed(f.session))).statusCode).toBe(202);
    expect(await publisherTick(agent.id)).toMatchObject({ 'signed.published': 1 });
    await killSwitch(f, agent.id, true);
    await killSwitch(f, agent.id, false);
    const base = Math.max(Date.now(), (await owner.query<{ closed_at: Date }>('SELECT closed_at FROM tlog_epochs WHERE epoch = $1', [start])).rows[0]?.closed_at.getTime() ?? 0);
    const end = await tick(new Date(base + 3 * 60 * 1000));

    const response = await blocksOf(f, agent.id);
    expect(response.format).toBe('atmark-identity-blocks/v1');
    expect(response.started).toBe(true);
    const kinds = response.blocks.map((block) => block.kind);
    expect(kinds[0]).toBe('identity.agent_created');
    expect(new Set(kinds)).toEqual(
      new Set(['identity.agent_created', 'identity.agent_updated', 'identity.address_assigned', 'identity.key_bound', 'identity.passport_version']),
    );
    // 상태 이력: provisioning → active → suspended(owner) → active.
    const statuses = response.blocks
      .filter((block) => block.kind === 'identity.agent_created' || block.kind === 'identity.agent_updated')
      .map((block) => block.changes.find((change) => change.field === 'status')?.value);
    expect(statuses).toEqual(['provisioning', 'active', 'suspended', 'active']);
    // 순서 · 해시 연결.
    let prev = '00'.repeat(32);
    let lastSeq = -1;
    for (const block of response.blocks) {
      expect(block.seq).toBeGreaterThan(lastSeq);
      lastSeq = block.seq;
      expect(block.leafHash).toBe(createHash('sha256').update(Buffer.from([0])).update(block.leaf).digest('hex'));
      expect(block.prevBlockHash).toBe(prev);
      expect(block.blockHash).toBe(createHash('sha256').update(Buffer.from(prev, 'hex')).update(Buffer.from(block.leafHash, 'hex')).digest('hex'));
      prev = block.blockHash;
      expect(block.checkpoint).toMatchObject({ state: 'checkpointed' });
      // DB 표시 값은 잎(커밋·평문)과 맞다 — 불일치(false)는 하나도 없다.
      expect(block.changes.filter((change) => change.matches === false), block.kind).toEqual([]);
    }
    const address = response.blocks.find((block) => block.kind === 'identity.address_assigned');
    expect(address?.changes).toEqual(expect.arrayContaining([{ field: 'address', value: agent.address, matches: true }]));
    const name = response.blocks[0]?.changes.find((change) => change.field === 'name');
    expect(name).toEqual({ field: 'name', value: SENTINEL_NAME, matches: true });
    // 게시 뒤 — DID · passport(JWS 지문).
    expect(response.card.did).toBe(`did:web:id.atmark.ai:agents:${agent.id}`);
    expect(response.card.passport).toMatchObject({ status: 'published', jwsSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(response.lastCheckpoint?.epoch).toBe(end);

    // 두 검증기 — 증명 없는 파일은 "일관성만"(ok 아님) · 잎 1바이트 · 체인 끊김을 거부.
    expect(verifyIdentityBlocks(response)).toMatchObject({ ok: false, assurance: 'consistency_only', errors: [], stats: { checkpointed: 0 } });
    expect(secondVerifyIdentityBlocks(response)).toEqual([]);
    expect(response.missing).toEqual([]);
    const tampered = structuredClone(response) as unknown as { blocks: { leaf: string; prevBlockHash: string }[] };
    const victim = tampered.blocks[1];
    if (victim !== undefined) victim.leaf = victim.leaf.replace('"seq":', '"seq": ');
    expect(verifyIdentityBlocks(tampered).errors.map((issue) => issue.code)).toEqual(expect.arrayContaining(['leaf_not_canonical', 'leaf_hash_mismatch']));
    expect(secondVerifyIdentityBlocks(tampered).some((code) => code.startsWith('leaf_hash'))).toBe(true);
    const unlinked = structuredClone(response) as unknown as { blocks: { prevBlockHash: string }[] };
    const second = unlinked.blocks[2];
    if (second !== undefined) second.prevBlockHash = 'ab'.repeat(32);
    expect(verifyIdentityBlocks(unlinked).errors.map((issue) => issue.code)).toContain('identity_block_unlinked');
    expect(secondVerifyIdentityBlocks(unlinked).some((code) => code.startsWith('prev'))).toBe(true);

    // M4 — 내려받기(?proofs=1): 공통 닻 + 블록마다 포함 증명 → 고정한 vkey 로 "증명" · 두 검증기 · 다른 키는 실패.
    const vkey = (await call(deps, 'GET', '/api/logs/integrity', authed(f.session))).json() as { vkey: string };
    const proven = await blocksOf(f, agent.id, true);
    expect(proven.blocks.map((block) => block.blockHash)).toEqual(response.blocks.map((block) => block.blockHash));
    expect(proven.proof?.org.epoch).toBe(end);
    expect(verifyIdentityBlocks(proven, { pinnedVkey: vkey.vkey })).toMatchObject({
      ok: true,
      assurance: 'proven',
      errors: [],
      stats: { blocks: response.blocks.length, checkpointed: response.blocks.length },
    });
    expect(await secondVerifyIdentityBlockProofs(proven, vkey.vkey)).toEqual([]);
    expect(verifyIdentityBlocks(proven)).toMatchObject({ ok: false, assurance: 'consistency_only' });
    const forgedRoot = structuredClone(proven) as unknown as { proof: { org: { root: string } } };
    forgedRoot.proof.org.root = 'ab'.repeat(32);
    expect(verifyIdentityBlocks(forgedRoot, { pinnedVkey: vkey.vkey }).ok).toBe(false);

    // 블록마다 포함 증명(기존 엔드포인트) — 서명된 체크포인트에 묶인다.
    for (const block of [response.blocks[0], response.blocks.at(-1)]) {
      const proof = await call(deps, 'GET', '/api/logs/inclusion-proof', authed(f.session, { query: `entry=${block?.entryId ?? ''}` }));
      expect(proof.statusCode, proof.body).toBe(200);
      expect((proof.json() as { entry: { leaf: string } }).entry.leaf).toBe(block?.leaf);
      expect(verifyInclusionProof(proof.json(), { pinnedVkey: vkey.vkey }).ok).toBe(true);
    }

    // 번들 — 신원 원천 행(agents · agent_addresses · agent_keypairs · passport_documents)을 1차 검증기가 잎과 대조한다.
    const bundle = await bundleOf(f, start, end);
    const tables = new Set((bundle['sources'] as { rows: { t: string }[] }).rows.map((row) => row.t));
    for (const table of ['agents', 'agent_addresses', 'agent_keypairs', 'passport_documents']) expect(tables.has(table), table).toBe(true);
    const report = verifyBundle(bundle, { pinnedVkey: bundle['vkey'] as string });
    expect(report.errors).toEqual([]);
    expect(await secondVerify(bundle as never)).toEqual([]);

    // PII 센티넬 — 이름·주소는 이 조직의 어떤 잎에도 평문으로 없다(커밋으로만).
    const leaves = await owner.query<{ leaf_json: string }>(
      'SELECT t.leaf_json FROM tlog_leaves t JOIN tlog_logs g ON g.org_log_id = t.org_log_id WHERE g.organization_id = $1',
      [f.org.id],
    );
    const everything = leaves.rows.map((row) => row.leaf_json).join('\n');
    expect(everything).toContain('identity.address_assigned');
    expect(everything).not.toContain(SENTINEL_NAME);
    expect(everything).not.toContain(agent.address);
    expect(everything).not.toContain(agent.address.split('@')[0] ?? '?');
    // 스냅샷(이름 평문)은 서열 뒤 지워졌다.
    const snapshots = await owner.query(`SELECT 1 FROM tlog_outbox WHERE organization_id = $1 AND snapshot IS NOT NULL`, [f.org.id]);
    expect(snapshots.rowCount).toBe(0);
  });

  it('② 변조 탐지 — 주소를 고치고 상태 트리거를 끄고 상태를 고치면 블록 API 는 matches:false, 검증기는 row_leaf_mismatch', async () => {
    const f = await organization();
    const start = await tick();
    const agent = await agentIn(f, `idt-${suffix()}`);
    const base = Math.max(Date.now(), (await owner.query<{ closed_at: Date }>('SELECT closed_at FROM tlog_epochs WHERE epoch = $1', [start])).rows[0]?.closed_at.getTime() ?? 0);
    const clean = await tick(new Date(base + 60 * 1000));
    const before = await blocksOf(f, agent.id);
    expect(before.blocks.flatMap((block) => block.changes).filter((change) => change.matches === false)).toEqual([]);

    const forged = `forged-${suffix()}@atmark.test`;
    const original = (await owner.query<{ address: string }>('SELECT address FROM agent_addresses WHERE agent_id = $1', [agent.id])).rows[0]?.address ?? '';
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      // 변조 흉내 — 주소 칸 불변 트리거(202609291120 agent_addresses_identity_immutable)도 끈다(DB 소유자만 할 수 있는 일).
      await client.query('ALTER TABLE agent_addresses DISABLE TRIGGER agent_addresses_identity_immutable');
      await client.query('UPDATE agent_addresses SET address = $2, domain = split_part($2, \'@\', 2) WHERE agent_id = $1', [agent.id, forged]);
      await client.query('ALTER TABLE agent_addresses ENABLE TRIGGER agent_addresses_identity_immutable');
      await client.query('ALTER TABLE agents DISABLE TRIGGER agents_tlog_enqueue_update');
      await client.query(`UPDATE agents SET status = 'suspended', suspended_by = 'operator' WHERE id = $1`, [agent.id]);
      await client.query('ALTER TABLE agents ENABLE TRIGGER agents_tlog_enqueue_update');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const after = await blocksOf(f, agent.id);
    // 체인 자체는 그대로다(잎은 바뀌지 않았다) — 바뀐 것은 DB 행이고, 그 칸이 불일치로 보인다.
    expect(after.blocks.map((block) => block.blockHash)).toEqual(before.blocks.map((block) => block.blockHash));
    const addressChange = after.blocks.find((block) => block.kind === 'identity.address_assigned')?.changes.find((change) => change.field === 'address');
    expect(addressChange).toEqual({ field: 'address', value: forged, matches: false });
    const statusOf = (response: IdentityBlocksResponse) =>
      [...response.blocks].reverse().find((block) => block.kind === 'identity.agent_updated' || block.kind === 'identity.agent_created')?.changes.find((change) => change.field === 'status');
    // L3 — 행이 마지막 잎 뒤에 바뀌었고 유예 안이다 → "서열 대기"(null + pending), 거짓 "기록과 다름" 이 아니다.
    expect(statusOf(after)).toMatchObject({ matches: null, pending: true });
    // 유예가 지나도 잎이 오지 않았다(트리거를 끄고 바꿨다) → 불일치.
    const later = await identityBlocksFor(admin, f.org.id, agent.id, { now: new Date(Date.now() + IDENTITY_PENDING_GRACE_MS + 60_000) });
    expect(statusOf(later)).toEqual({ field: 'status', value: 'active', matches: false });

    const end = await tick(new Date(base + 4 * 60 * 1000));
    const report = verifyBundle(await bundleOf(f, start, end), {});
    const mismatches = report.errors.filter((issue) => issue.code === 'row_leaf_mismatch').map((issue) => issue.detail);
    expect(mismatches.some((detail) => detail.startsWith('agent_addresses:') && detail.includes('c.address'))).toBe(true);
    expect(mismatches.some((detail) => detail.startsWith(`agents:${agent.id}`) && detail.includes('status'))).toBe(true);
    expect(clean).toBeLessThan(end);

    // 뒷정리 — 변조한 주소를 되돌린다. 남겨 두면 공유 테스트 DB 에 claim 없는 주소가 쌓여 claim 백필 대조가 깨진다(2026-09-30).
    const restore = await owner.connect();
    try {
      await restore.query('BEGIN');
      await restore.query('ALTER TABLE agent_addresses DISABLE TRIGGER agent_addresses_identity_immutable');
      await restore.query("UPDATE agent_addresses SET address = $2, domain = split_part($2, '@', 2) WHERE agent_id = $1", [agent.id, original]);
      await restore.query('ALTER TABLE agent_addresses ENABLE TRIGGER agent_addresses_identity_immutable');
      await restore.query('COMMIT');
    } finally {
      restore.release();
    }
  });

  it('③ 조직 범위 — 다른 조직 세션은 404 · 잎 조회도 조직으로 가른다 · 모양 밖 id 는 400', async () => {
    const f = await organization();
    const agent = await agentIn(f, `ido-${suffix()}`);
    await tick();
    const other = await organization();
    await agentIn(other, `idx-${suffix()}`);
    await tick();
    const foreign = await call(deps, 'GET', `/api/agents/${agent.id}/identity-blocks`, authed(other.session));
    expect(foreign.statusCode).toBe(404);
    expect((foreign.json() as { error: string }).error).toBe('agent_not_found');
    expect((await identityBlocksFor(admin, other.org.id, agent.id)).blocks).toEqual([]);
    expect((await identityBlocksFor(admin, f.org.id, agent.id)).blocks.length).toBeGreaterThan(0);
    expect((await call(deps, 'GET', '/api/agents/not-an-agent/identity-blocks', authed(f.session))).statusCode).toBe(400);
    expect((await call(deps, 'GET', `/api/agents/${agent.id}/identity-blocks`)).statusCode).toBe(401);
  });

  it('④ 속도 제한 — 같은 조직의 증명 슬롯이 잡혀 있으면 429 · 다른 조직은 막히지 않는다', async () => {
    const f = await organization();
    const agent = await agentIn(f, `idr-${suffix()}`);
    const other = await organization();
    const otherAgent = await agentIn(other, `ids-${suffix()}`);
    await tick();
    const holder = await admin.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended('tlog_proof:' || $1::text, 0))`, [f.org.id]);
      const blocked = await call(deps, 'GET', `/api/agents/${agent.id}/identity-blocks`, authed(f.session));
      expect(blocked.statusCode).toBe(429);
      expect((blocked.json() as { error: string }).error).toBe('rate_limited');
      expect((await call(deps, 'GET', `/api/agents/${otherAgent.id}/identity-blocks`, authed(other.session))).statusCode).toBe(200);
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended('tlog_proof:' || $1::text, 0))`, [f.org.id]);
      holder.release();
    }
    expect((await call(deps, 'GET', `/api/agents/${agent.id}/identity-blocks`, authed(f.session))).statusCode).toBe(200);
  });

  it('⑤ M2 — 번들의 identity_since = tlog_identity_since(도입 시각) · min_verifier_version · 검증기 상태가 고정한다 · 고칠 수 없다', async () => {
    const f = await organization();
    const start = await tick();
    await agentIn(f, `idm-${suffix()}`);
    const base = Math.max(Date.now(), (await owner.query<{ closed_at: Date }>('SELECT closed_at FROM tlog_epochs WHERE epoch = $1', [start])).rows[0]?.closed_at.getTime() ?? 0);
    const end = await tick(new Date(base + 3 * 60 * 1000));
    const since = (await owner.query<{ since: string }>(`SELECT to_char(since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS since FROM tlog_identity_since`)).rows[0]?.since;
    const bundle = await bundleOf(f, start, end);
    expect(bundle['identity_since']).toBe(since);
    expect(bundle['min_verifier_version']).toBe(4);
    const report = verifyBundle(bundle, { pinnedVkey: bundle['vkey'] as string });
    expect(report.errors).toEqual([]);
    expect(report.state?.identity_since).toBe(since);
    expect(await secondVerify(bundle as never)).toEqual([]);
    await expect(owner.query(`UPDATE tlog_identity_since SET since = now()`)).rejects.toThrow(/tlog_identity_since/);
    await expect(owner.query(`DELETE FROM tlog_identity_since`)).rejects.toThrow(/tlog_identity_since/);
  });

  it('⑥ L4 — 이 에이전트를 가리키는 source.missing 잎(원천 행이 서열 시점에 없었다)이 missing(빠진 블록)으로 나온다 · 체인은 그대로', async () => {
    const f = await organization();
    const agent = await agentIn(f, `idg-${suffix()}`);
    await tick();
    const before = await blocksOf(f, agent.id);
    expect(before.missing).toEqual([]);
    // 서명 문서가 없는(draft) passport 를 가리키는 outbox 행 — 서열기는 원천 행을 찾지 못해 source.missing(not_found) 을 커밋한다.
    const draft = (await owner.query<{ id: string }>(`SELECT id::text AS id FROM passports WHERE agent_id = $1`, [agent.id])).rows[0]?.id as string;
    await owner.query(`INSERT INTO tlog_outbox (source_table, source_id, event, rev, organization_id) VALUES ('passport_documents', $1, 'insert', 0, $2)`, [draft, f.org.id]);
    await tick();
    const after = await blocksOf(f, agent.id, true);
    expect(after.missing).toHaveLength(1);
    expect(after.missing[0]).toMatchObject({ table: 'passport_documents', reason: 'not_found', checkpoint: { state: 'checkpointed' } });
    expect(after.blocks.map((block) => block.blockHash)).toEqual(before.blocks.map((block) => block.blockHash));
    const vkey = ((await call(deps, 'GET', '/api/logs/integrity', authed(f.session))).json() as { vkey: string }).vkey;
    const report = verifyIdentityBlocks(after, { pinnedVkey: vkey });
    expect(report).toMatchObject({ ok: true, assurance: 'proven', stats: { missing: 1, missing_proven: 1 } });
    expect(report.warnings.join(' ')).toContain('빠진 블록 1건');
    // 다른 에이전트의 블록 뷰에는 없다.
    const other = await agentIn(f, `idh-${suffix()}`);
    await tick();
    expect((await blocksOf(f, other.id)).missing).toEqual([]);
  });

  it('⑦ L1 — 조직당 분당 30번(429 · 다른 조직은 막히지 않는다) · 블록 조회는 부분 색인(tlog_leaves_identity_agent_idx)을 쓴다', async () => {
    const f = await organization();
    const agent = await agentIn(f, `idl-${suffix()}`);
    const other = await organization();
    const otherAgent = await agentIn(other, `idk-${suffix()}`);
    await tick();
    expect((await call(deps, 'GET', `/api/agents/${agent.id}/identity-blocks`, authed(f.session))).statusCode).toBe(200);
    await owner.query(`INSERT INTO tlog_identity_block_requests (organization_id) SELECT $1 FROM generate_series(1, 29)`, [f.org.id]);
    const limited = await call(deps, 'GET', `/api/agents/${agent.id}/identity-blocks`, authed(f.session));
    expect(limited.statusCode).toBe(429);
    expect((limited.json() as { error: string }).error).toBe('rate_limited');
    expect((await call(deps, 'GET', `/api/agents/${otherAgent.id}/identity-blocks`, authed(other.session))).statusCode).toBe(200);
    // 창이 지나면(1분) 다시 된다 · 429 는 원장에 남지 않는다(되돌린 트랜잭션).
    const counted = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM tlog_identity_block_requests WHERE organization_id = $1', [f.org.id]);
    expect(counted.rows[0]?.n).toBe(30);
    await owner.query(`UPDATE tlog_identity_block_requests SET requested_at = now() - interval '2 minutes' WHERE organization_id = $1`, [f.org.id]);
    expect((await call(deps, 'GET', `/api/agents/${agent.id}/identity-blocks`, authed(f.session))).statusCode).toBe(200);
    expect((await call(deps, 'GET', `/api/agents/${agent.id}/identity-blocks`, authed(f.session, { query: 'proofs=2' }))).statusCode).toBe(400);

    // 블록 조회 SQL(생산 코드의 문장 그대로)이 부분 색인을 쓴다 — 술어나 식이 색인과 어긋나면 이 계획에서 색인이 사라진다.
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const log = (await client.query<{ org_log_id: Buffer }>('SELECT org_log_id FROM tlog_logs WHERE organization_id = $1', [f.org.id])).rows[0]?.org_log_id;
      const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${IDENTITY_CHAIN_SQL}`, [log, agent.id]);
      expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('tlog_leaves_identity_agent_idx');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
  it('⑧ #15 L1 — 잠든 앵커(ax--) 주소는 검증 번들에만 있다(검증기가 커밋을 여는 재료) · 블록 API · 에이전트 API 에는 없다', async () => {
    const f = await organization();
    const { domain } = await verifiedCustomDomain(f.org.id);
    const start = await tick();
    const created = await call(deps, 'POST', '/api/agents', authed(f.session, { body: { name: SENTINEL_NAME, localPart: `dorm-${suffix()}`, domain } }));
    expect(created.statusCode, created.body).toBe(201);
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    const anchor = (await owner.query<{ address: string }>('SELECT address FROM agent_addresses WHERE agent_id = $1 AND is_primary', [agent.id])).rows[0]?.address ?? '';
    expect(anchor).toMatch(/^ax--[a-z2-7]{20}@atmark\.ai$/);
    const end = await tick();
    const bundle = JSON.stringify(await bundleOf(f, start, end));
    expect(bundle).toContain(anchor); // 예외: 검증 재료(원천 행 평문 — 잎 커밋을 연다).
    expect(bundle).toContain(agent.address);
    const blocks = await call(deps, 'GET', `/api/agents/${agent.id}/identity-blocks`, authed(f.session));
    expect(blocks.statusCode).toBe(200);
    for (const surface of [
      blocks.body,
      (await call(deps, 'GET', `/api/agents/${agent.id}`, authed(f.session))).body,
      (await call(deps, 'GET', '/api/agents', authed(f.session))).body,
      (await call(deps, 'GET', `/api/agents/${agent.id}/aliases`, authed(f.session))).body,
    ]) {
      expect(surface).not.toContain(anchor);
    }
  });
});
