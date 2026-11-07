/**
 * 신원 변경 이력 블록(US-013) — 두 검증기(1차 `verifyIdentityBlocks` · 2차 `secondVerifyIdentityBlocks`)와 CLI 가 **실제 잎**(`buildOrgLeaf`)과
 * 생산자의 체인 규칙(`blockHashOf` — SHA-256(이전 ‖ 잎))으로 만든 파일을 통과시키고, 잎 1바이트 · 끊긴 체인 · 다른 에이전트의 잎 ·
 * 뒤바뀐 순서를 **둘 다** 거부한다.
 *
 * 적대적 검증 M4 — 체인만으로는 증거가 아니다: 증명 없는 파일은 `consistency_only`(CLI 3), 잘린 파일은 `truncated`(CLI 3), 로그가 섞인 파일은
 * 오류(1). **고정한 vkey 로 연 체크포인트 닻 + 블록마다 포함 증명**이 맞을 때만 `proven`(CLI 0) — 파일이 주장하는 `checkpoint` 는 세지 않는다.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkpointBody, keyIdOf, signedNote, vkeyOf } from '../../../src/tlog/checkpoint';
import { TLOG_ORIGIN } from '../../../src/tlog/constants';
import { blockHashOf, GENESIS_BLOCK_HASH, IDENTITY_BLOCKS_FORMAT } from '../../../src/tlog/identity-blocks';
import { buildOrgLeaf, epochTreeLeaf, globalEpochLeaf, publicKeyFingerprint, type OrgEvent } from '../../../src/tlog/leaf';
import { inclusionProof, inclusionProofs, leafHash, rootOf } from '../../../src/tlog/merkle';
import { runCli } from '../../../scripts/log-verify';
import { verifyIdentityBlocks } from '../../../scripts/tlog-verify/verifier';
import { testNoteSigner } from '../../support/tlog-fixtures';
import { secondVerifyIdentityBlockProofs, secondVerifyIdentityBlocks } from '../../support/tlog-second-verifier';

const AGENT = 'b'.repeat(32);
const OTHER = 'c'.repeat(32);
const AT = '2026-09-24T00:00:00.000000Z';
const PUB = Buffer.alloc(32, 9).toString('base64url');

function file(agent = AGENT): { format: string; agentId: string; truncated: boolean; blocks: Record<string, unknown>[] } {
  const events: OrgEvent[] = [
    { kind: 'identity.agent_created', src: { t: 'agents', id: agent, e: 'insert', r: 0 }, at: AT, agentId: agent, name: 'n', status: 'provisioning', suspendedBy: null },
    { kind: 'identity.key_bound', src: { t: 'agent_keypairs', id: agent, e: 'insert', r: 0 }, at: AT, agentId: agent, algorithm: 'ed25519', publicKey: PUB },
    { kind: 'identity.agent_updated', src: { t: 'agents', id: agent, e: 'update', r: 1 }, at: AT, agentId: agent, name: 'n', status: 'active', suspendedBy: null, changed: ['status'] },
  ];
  let prev = GENESIS_BLOCK_HASH;
  const blocks = events.map((event, index) => {
    const seq = 5 + index * 2;
    const leaf = buildOrgLeaf({ log: 'a'.repeat(32), seq, saltKey: Buffer.alloc(32, 1) }, event);
    const leafHash = leaf.hash.toString('hex');
    const blockHash = blockHashOf(prev, leafHash);
    const block = { entryId: String(100 + index), seq, kind: event.kind, leaf: leaf.json, leafHash, prevBlockHash: prev, blockHash, checkpoint: { state: 'checkpointed', epoch: 3 } };
    prev = blockHash;
    return block;
  });
  return { format: IDENTITY_BLOCKS_FORMAT, agentId: agent, truncated: false, blocks };
}

const codes = (input: unknown): string[] => verifyIdentityBlocks(input).errors.map((issue) => issue.code);

const SIGNER = testNoteSigner();
const VKEY = vkeyOf(TLOG_ORIGIN, SIGNER.raw);
const EPOCH = 3;

/**
 * 블록 파일 + 서명 체크포인트 닻(서버 `checkpointAnchorFor` 모양). 조직 트리 = seq 0..(마지막 블록 seq + `extra`) — 블록 잎은 제자리, 나머지는
 * 채움 해시. 에폭 3 의 에폭 트리는 이 조직 헤드 하나, 전역 트리는 에폭 0..3.
 */
async function provenFile(agent = AGENT, extra = 0): Promise<ReturnType<typeof file> & { proof: Record<string, unknown> }> {
  const f = file(agent);
  const last = f.blocks.at(-1)?.['seq'] as number;
  const size = last + 1 + extra;
  const hashes = Array.from({ length: size }, (_, seq) => {
    const block = f.blocks.find((b) => b['seq'] === seq);
    return block === undefined ? leafHash(Buffer.from(`filler-${String(seq)}`)) : leafHash(Buffer.from(block['leaf'] as string, 'utf8'));
  });
  const root = rootOf(hashes).toString('hex');
  const headLeaf = epochTreeLeaf(EPOCH, 'a'.repeat(32), size, root);
  const epochRoot = leafHash(Buffer.from(headLeaf, 'utf8')).toString('hex');
  const globalLeaf = globalEpochLeaf(EPOCH, '2026-09-24T03:00:00.000000Z', epochRoot);
  const globals = [0, 1, 2].map((e) => leafHash(Buffer.from(`epoch-${String(e)}`))).concat([leafHash(Buffer.from(globalLeaf, 'utf8'))]);
  const text = checkpointBody({ origin: TLOG_ORIGIN, size: EPOCH + 1, root: rootOf(globals) });
  const note = signedNote(text, TLOG_ORIGIN, keyIdOf(TLOG_ORIGIN, SIGNER.raw), await SIGNER.sign(Buffer.from(text, 'utf8')));
  const seqs = f.blocks.map((b) => b['seq'] as number);
  const paths = inclusionProofs(hashes, seqs, size);
  f.blocks.forEach((block, index) => {
    block['inclusion'] = (paths[index] ?? []).map((node) => node.toString('hex'));
  });
  return {
    ...f,
    proof: {
      origin: TLOG_ORIGIN,
      vkey: VKEY,
      checkpoint: note,
      org: { log: 'a'.repeat(32), epoch: EPOCH, treeSize: size, root },
      epochTree: { position: 0, size: 1, epochRoot, proof: [] },
      global: { index: EPOCH, treeSize: EPOCH + 1, globalLeaf, proof: inclusionProof(globals, EPOCH, EPOCH + 1).map((node) => node.toString('hex')) },
    },
  };
}

describe('신원 블록 검증기 — 1차 · 2차 · CLI', () => {
  it('실제 잎 + 생산자 체인 → 두 검증기의 체인 검사 통과 · 증명 없으면 "일관성만"(ok 아님, checkpointed 0) · 공개키는 지문으로만 잎에', () => {
    const f = file();
    // 파일은 블록마다 checkpoint: checkpointed 라고 주장하지만 증명이 없다 — 세지 않는다.
    expect(verifyIdentityBlocks(f)).toMatchObject({ ok: false, assurance: 'consistency_only', errors: [], stats: { blocks: 3, checkpointed: 0 } });
    expect(secondVerifyIdentityBlocks(f)).toEqual([]);
    const key = JSON.parse(f.blocks[1]?.['leaf'] as string) as { body: Record<string, unknown> };
    expect(key.body['key_fp']).toBe(publicKeyFingerprint(PUB));
    expect(f.blocks[1]?.['leaf']).not.toContain(PUB);
    expect(f.blocks[0]?.['prevBlockHash']).toBe('00'.repeat(32));
  });

  it('잎 1바이트 · 끊긴 체인 · 다른 에이전트 · 뒤바뀐 순서 · 블록 해시 — 둘 다 거부', () => {
    const leaf = file();
    leaf.blocks[1] = { ...leaf.blocks[1], leaf: (leaf.blocks[1]?.['leaf'] as string).replace('ed25519', 'ed25518') };
    expect(codes(leaf)).toContain('leaf_hash_mismatch');
    expect(secondVerifyIdentityBlocks(leaf).some((c) => c.startsWith('leaf_hash'))).toBe(true);

    const chain = file();
    chain.blocks[2] = { ...chain.blocks[2], prevBlockHash: 'ab'.repeat(32) };
    expect(codes(chain)).toContain('identity_block_unlinked');
    expect(secondVerifyIdentityBlocks(chain).some((c) => c.startsWith('prev'))).toBe(true);

    const mixed = file();
    mixed.blocks[1] = file(OTHER).blocks[1] as Record<string, unknown>;
    expect(codes(mixed)).toEqual(expect.arrayContaining(['identity_block_agent']));
    expect(secondVerifyIdentityBlocks(mixed).some((c) => c.startsWith('agent'))).toBe(true);

    const swapped = file();
    swapped.blocks.reverse();
    expect(codes(swapped)).toContain('identity_block_order');
    expect(secondVerifyIdentityBlocks(swapped).some((c) => c.startsWith('order'))).toBe(true);

    const forged = file();
    forged.blocks[0] = { ...forged.blocks[0], blockHash: 'cd'.repeat(32) };
    expect(codes(forged)).toContain('identity_block_hash_mismatch');
    expect(secondVerifyIdentityBlocks(forged).some((c) => c.startsWith('block_hash'))).toBe(true);

    expect(codes({ format: 'x' })).toEqual(['identity_blocks_format']);
    expect(secondVerifyIdentityBlocks({ format: 'x' })).toEqual(['format']);
  });

  it('잘린 파일(truncated) — 첫 블록의 이전 해시를 받아들이되 통과가 아니다(별도 상태 truncated) · 나머지는 이어야 한다', async () => {
    const f = await provenFile();
    const cut = { ...f, truncated: true, blocks: f.blocks.slice(1) };
    // 블록 잎이 모두 증명돼도 앞이 잘린 체인은 "증명" 이 아니다.
    expect(verifyIdentityBlocks(cut, { pinnedVkey: VKEY })).toMatchObject({ ok: false, assurance: 'truncated', errors: [] });
    expect(secondVerifyIdentityBlocks(cut)).toEqual([]);
    expect(verifyIdentityBlocks({ ...cut, truncated: false }, { pinnedVkey: VKEY }).errors.map((issue) => issue.code)).toContain('identity_block_unlinked');
  });

  it('M4 — 모든 잎이 한 조직 로그여야 한다(다른 로그의 잎으로 지은 체인은 오류) — 둘 다', () => {
    const f = file();
    const foreign = buildOrgLeaf(
      { log: 'd'.repeat(32), seq: 11, saltKey: Buffer.alloc(32, 1) },
      { kind: 'identity.agent_updated', src: { t: 'agents', id: AGENT, e: 'update', r: 2 }, at: AT, agentId: AGENT, name: 'n', status: 'suspended', suspendedBy: 'owner', changed: ['status'] },
    );
    const prev = f.blocks.at(-1)?.['blockHash'] as string;
    const leafHashHex = foreign.hash.toString('hex');
    f.blocks.push({ entryId: '200', seq: 11, kind: foreign.kind, leaf: foreign.json, leafHash: leafHashHex, prevBlockHash: prev, blockHash: blockHashOf(prev, leafHashHex), checkpoint: { state: 'checkpointed', epoch: 3 } });
    expect(codes(f)).toEqual(['identity_blocks_log_mixed']);
    expect(secondVerifyIdentityBlocks(f)).toEqual(['log_mixed']);
  });

  it('M4 — 고정한 vkey 로 연 닻 + 블록마다 포함 증명이 맞을 때만 proven · checkpointed = 검증된 증명 수 · 두 검증기', async () => {
    const f = await provenFile(AGENT, 4);
    expect(verifyIdentityBlocks(f, { pinnedVkey: VKEY })).toMatchObject({ ok: true, assurance: 'proven', errors: [], stats: { blocks: 3, checkpointed: 3 } });
    expect(await secondVerifyIdentityBlockProofs(f, VKEY)).toEqual([]);
    // 키를 고정하지 않으면 증명을 보지 않는다 — 일관성만.
    expect(verifyIdentityBlocks(f)).toMatchObject({ ok: false, assurance: 'consistency_only', errors: [] });
    // 다른 키(파일이 스스로 내민 키로 서명한 가짜 닻) — 서명 실패.
    const other = testNoteSigner(9);
    expect(verifyIdentityBlocks(f, { pinnedVkey: vkeyOf(TLOG_ORIGIN, other.raw) }).errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['vkey_mismatch', 'checkpoint_signature_invalid']),
    );
    expect(await secondVerifyIdentityBlockProofs(f, vkeyOf(TLOG_ORIGIN, other.raw))).toEqual(['checkpoint']);
    // 블록 하나의 증명이 틀리면 오류, 증명이 없으면(체크포인트 뒤) 일관성만.
    const broken = structuredClone(f);
    (broken.blocks[1] as { inclusion: string[] }).inclusion[0] = 'ab'.repeat(32);
    expect(verifyIdentityBlocks(broken, { pinnedVkey: VKEY }).errors.map((issue) => issue.code)).toEqual(['identity_block_inclusion_invalid']);
    expect(await secondVerifyIdentityBlockProofs(broken, VKEY)).toEqual(['inclusion:1']);
    const partial = structuredClone(f);
    (partial.blocks[2] as { inclusion: string[] | null }).inclusion = null;
    expect(verifyIdentityBlocks(partial, { pinnedVkey: VKEY })).toMatchObject({ ok: false, assurance: 'consistency_only', errors: [], stats: { checkpointed: 2 } });
    // 닻의 조직 루트를 바꾸면(체크포인트에 없는 트리) 에폭 트리 포함이 깨진다.
    const reroot = structuredClone(f);
    (reroot.proof['org'] as { root: string }).root = 'cd'.repeat(32);
    expect(verifyIdentityBlocks(reroot, { pinnedVkey: VKEY }).errors.map((issue) => issue.code)).toContain('head_epoch_proof_invalid');
  });

  it('CLI(pnpm log:verify) — 증명 0 · 일관성만 3 · 잘림 3 · 실패 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atmark-identity-blocks-'));
    const write = (name: string, value: unknown): string => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(value));
      return path;
    };
    const proven = write('proven.json', await provenFile());
    const out: string[] = [];
    expect(runCli([proven, '--key', VKEY], (line) => out.push(line))).toBe(0);
    expect(out[0]).toBe('✓ 신원 블록 검증 통과');
    const chainOnly: string[] = [];
    expect(runCli([write('chain.json', file())], (line) => chainOnly.push(line))).toBe(3);
    expect(chainOnly[0]).toBe('△ 신원 블록 — 일관성만, 증명 아님(consistency_only)');
    expect(runCli([proven], () => undefined)).toBe(3);
    const f = await provenFile();
    const truncated: string[] = [];
    expect(runCli([write('cut.json', { ...f, truncated: true, blocks: f.blocks.slice(1) }), '--key', VKEY], (line) => truncated.push(line))).toBe(3);
    expect(truncated[0]).toContain('truncated');
    const bad = file();
    bad.blocks[0] = { ...bad.blocks[0], blockHash: 'ee'.repeat(32) };
    expect(runCli([write('bad.json', bad)], () => undefined)).toBe(1);
  });
});
