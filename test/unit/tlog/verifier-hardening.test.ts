/**
 * 투명성 로그 — 적대적 검증(2026-09-24)이 찾은 결함의 회귀. DB·AWS·외부 호출 0 — 합성 역사(`tlog-synthetic.ts`)와 순수 함수만.
 *
 *   H1  vkey 자르기: base64 키 자료에 `+` 가 있는 키(약 절반)를 세 파서 모두 받는다.
 *   H2  저장 상태 연결: 범위 밖 번들(분기·되감김)로 저장한 상태를 우회·덮어쓰지 못한다 — link 증명이 있어야 한다.
 *   H3  빠짐: 빈 번들 · 헤드를 뺀 번들 · 체크포인트 밖 꼬리 잎(attack.mts A·C·D) — 두 검증기.
 *   H4  게시 수위: 게시된 크기보다 작거나 갈라진 트리에는 서명 계획이 거부한다.
 *   M3  에폭 트리 잎에 에폭 번호 — 쉬는 조직의 잎도 에폭마다 다르다.
 *   M6  번들 한 페이지의 끝(에폭·잎 상한).
 *   L7  origin 고정 · tree size 는 안전한 정수.
 *   M1' (최종 적대적 검증) 저장 상태의 조직 로그 id 고정 — 새 id 의 분기 번들은 실패, --accept-new-log 여도 전역 연결은 본다.
 *   L1' (최종 적대적 검증) 창세 잎부터 싣는 번들: 첫 헤드 직전 에폭이 범위 안이고 창세 전에 닫혔다 — 앞 헤드를 빼면 두 검증기가 실패.
 *   M2' (신원 잎 적대적 검증) identity_since — 도입 전 신원 행은 거짓 경보가 아니고, 신원 잎보다 늦출 수 없고, 저장 상태가 고정한다.
 *   M3' (신원 잎 적대적 검증) 창 끝 뒤에 바뀐 agents 행 — 미래 시각은 오류, 아니면 경고 + 대기 → 다음 번들이 풀거나 실패.
 *   L6' (신원 잎 적대적 검증) 번들의 min_verifier_version.
 */

import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseVkey as verifierParseVkey, VERIFIER_VERSION, verifyBundle, type SavedState } from '../../../scripts/tlog-verify/verifier';
import { checkpointBody, parseCheckpointBody, parseVkey, vkeyOf } from '../../../src/tlog/checkpoint';
import { GLOBAL_LEAF_VERSION, TLOG_ORIGIN } from '../../../src/tlog/constants';
import { EpochIntegrityError, planEpoch } from '../../../src/tlog/epoch';
import { epochTreeLeaf, globalEpochLeaf } from '../../../src/tlog/leaf';
import { leafHash, rootOf } from '../../../src/tlog/merkle';
import {
  bundlePageEnd,
  DOMAIN_MIN_VERIFIER_VERSION,
  MAX_BUNDLE_EPOCHS,
  MAX_BUNDLE_LEAVES,
  MIN_VERIFIER_VERSION,
  OPERATOR_MIN_VERIFIER_VERSION,
  TlogProofRangeError,
} from '../../../src/tlog/proofs';
import { secondParseVkey, secondVerify } from '../../support/tlog-second-verifier';
import { syntheticHistory, syntheticSigner } from '../../support/tlog-synthetic';

type Bundle = Record<string, unknown> & {
  range: { from_epoch: number; to_epoch: number };
  start: { size: number; frontier: unknown[] };
  org_consistency: unknown;
  leaves: { id: string; seq: number; leaf: string }[];
  heads: { epoch: number; size: number; root: string; epoch_proof: string[] }[];
  checkpoints: { epoch: number }[];
  sources: { rows: Record<string, unknown>[] };
  org: { log: string };
};
const codes = (report: { errors: readonly { code: string }[] }): string[] => report.errors.map((issue) => issue.code);
const canonical = (value: unknown): string => JSON.stringify(value, Object.keys(value as object).sort());

describe('H1 — vkey 는 첫 두 `+` 에서만 자른다(키 자료의 `+` 는 base64 다)', () => {
  it('무작위 키 1000개 — 생산자·1차·2차 파서가 모두 받는다 · `+` 가 든 키가 실제로 섞여 있다', () => {
    let withPlus = 0;
    for (let i = 0; i < 1000; i += 1) {
      const { publicKey } = generateKeyPairSync('ed25519');
      const raw = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
      const vkey = vkeyOf(TLOG_ORIGIN, raw);
      if (vkey.split('+').length > 3) withPlus += 1;
      expect(parseVkey(vkey).publicKey.equals(raw), vkey).toBe(true);
      expect(verifierParseVkey(vkey)?.key.equals(raw), vkey).toBe(true);
      expect(secondParseVkey(vkey)?.publicKey.equals(raw), vkey).toBe(true);
    }
    // 33바이트의 base64 44자 중 하나라도 `+` 일 확률 ≈ 1 − (63/64)^44 ≈ 0.5 — 1000개면 수백 개.
    expect(withPlus).toBeGreaterThan(200);
  });

  it('`+` 가 든 키로 서명한 번들을 두 검증기가 통과시키고, 틀린 모양은 셋 다 거부한다', async () => {
    const history = syntheticHistory({ tag: 'h1' });
    expect(history.signer.vkey.split('+').length).toBeGreaterThan(3);
    const bundle = history.bundle(1, 3);
    expect(verifyBundle(bundle, { pinnedVkey: history.signer.vkey }).errors).toEqual([]);
    expect(await secondVerify(bundle as never)).toEqual([]);
    const material = history.signer.vkey.slice(history.signer.vkey.indexOf('+', history.signer.vkey.indexOf('+') + 1) + 1);
    for (const bad of [`+00000000+${material}`, `${TLOG_ORIGIN}+0000000+${material}`, `${TLOG_ORIGIN}+${'0'.repeat(8)}+${material}`, `${TLOG_ORIGIN} x+00000000+${material}`]) {
      expect(() => parseVkey(bad)).toThrow();
      expect(verifierParseVkey(bad)).toBeNull();
      expect(secondParseVkey(bad)).toBeNull();
    }
  });
});

describe('H2 — 저장한 상태와 이어지지 않는 번들은 실패하고 상태를 갱신하지 않는다', () => {
  const history = syntheticHistory({ tag: 'h2', epochs: 12 });
  const vkey = history.signer.vkey;
  const saved = verifyBundle(history.bundle(0, 2), { pinnedVkey: vkey }).state as SavedState;
  // 같은 키로 서명한 완전히 다른 역사(Atmark 가 역사를 다시 쓴 분기) — 같은 조직 로그 id 로 보이게 한다.
  const forged = syntheticHistory({ tag: 'h2-forged', epochs: 12, signer: history.signer });
  const forgedBundle = (from: number, to: number, since?: number): Bundle => {
    const bundle = forged.bundle(from, to, since === undefined ? {} : { since }) as Bundle;
    bundle.org.log = history.log;
    bundle.leaves = [];
    bundle.heads = [];
    bundle.sources.rows = [];
    bundle.start = { size: 0, frontier: [] };
    bundle.org_consistency = null;
    if (bundle['link'] !== null) (bundle['link'] as { org: unknown }).org = null;
    return bundle;
  };

  it('정직한 번들 [0,2] 가 상태를 만든다', () => {
    expect(saved.checkpoint.epoch).toBe(2);
    expect(saved.org?.log).toBe(history.log);
  });

  it('attack B — 저장한 에폭 뒤에서 시작하는 분기 번들(링크 없음) → state_unlinked · 상태 null', () => {
    const report = verifyBundle(forgedBundle(10, 12 - 1), { pinnedVkey: vkey, previous: saved });
    expect(codes(report)).toContain('state_unlinked');
    expect(report.state).toBeNull();
    // 정직한 역사라도 링크 없이 범위 밖이면 같다(우회 경로가 없다).
    const honest = verifyBundle(history.bundle(5, 7), { pinnedVkey: vkey, previous: saved });
    expect(codes(honest)).toContain('state_unlinked');
    expect(honest.state).toBeNull();
  });

  it('분기 번들이 링크를 싣고 와도 저장한 루트와 일관성 증명이 맞지 않는다', () => {
    const report = verifyBundle(forgedBundle(5, 7, 2), { pinnedVkey: vkey, previous: saved });
    expect(codes(report)).toEqual(expect.arrayContaining(['state_checkpoint_inconsistent']));
    expect(report.state).toBeNull();
  });

  it('정직한 링크(forward since=2) → 통과 · 상태는 7 로 앞선다 · 조직 링크를 떼면 실패', () => {
    const bundle = history.bundle(5, 7, { since: 2 });
    const report = verifyBundle(bundle, { pinnedVkey: vkey, previous: saved });
    expect(report.errors).toEqual([]);
    expect(report.state?.checkpoint.epoch).toBe(7);
    const withoutOrg = structuredClone(bundle) as { link: { org: unknown } };
    withoutOrg.link.org = null;
    expect(codes(verifyBundle(withoutOrg, { pinnedVkey: vkey, previous: saved }))).toContain('state_org_inconsistent');
  });

  it('저장 상태보다 앞선 범위(backward since=7) → 통과 · 상태는 7 에 머문다 · 링크 없으면 실패', () => {
    const later = verifyBundle(history.bundle(5, 7, { since: 2 }), { pinnedVkey: vkey, previous: saved }).state as SavedState;
    const back = verifyBundle(history.bundle(1, 3, { since: 7 }), { pinnedVkey: vkey, previous: later });
    expect(back.errors).toEqual([]);
    expect(back.state?.checkpoint.epoch).toBe(7);
    expect(codes(verifyBundle(history.bundle(1, 3), { pinnedVkey: vkey, previous: later }))).toContain('state_unlinked');
  });

  it('조직 로그가 되감겼다(저장한 헤드보다 작은 시작) · 다른 조직의 상태 · 다른 origin 의 상태 → 실패', () => {
    const rolled = verifyBundle(history.bundle(1, 3), { pinnedVkey: vkey, previous: { ...saved, org: { ...(saved.org as NonNullable<SavedState['org']>), size: 10_000 } } });
    expect(codes(rolled).some((code) => code === 'state_org_ahead' || code === 'state_org_inconsistent')).toBe(true);
    expect(codes(verifyBundle(history.bundle(1, 3), { pinnedVkey: vkey, previous: { ...saved, org: { ...(saved.org as NonNullable<SavedState['org']>), log: 'ee'.repeat(16) } } }))).toContain(
      'state_org_mismatch',
    );
    expect(codes(verifyBundle(history.bundle(1, 3), { pinnedVkey: vkey, previous: { ...saved, origin: 'other.example/log' } }))).toContain('state_origin_mismatch');
  });
});

describe('H3 — 빠짐을 통과시키지 않는다(attack.mts A · C · D)', () => {
  const history = syntheticHistory({ tag: 'h3', epochs: 6 });
  const vkey = history.signer.vkey;
  const honest = (): Bundle => structuredClone(history.bundle(0, 2)) as Bundle;

  it('A — 빈 번들(체크포인트·헤드·잎 없음) → checkpoint_missing · 두 검증기', async () => {
    const hollow = { ...honest(), range: { from_epoch: 2, to_epoch: 2 }, checkpoints: [], heads: [], leaves: [], global_consistency: [], org_consistency: null, start: { size: 0, frontier: [] } };
    hollow.sources = { ...hollow.sources, rows: [] };
    expect(codes(verifyBundle(hollow, { pinnedVkey: vkey }))).toContain('checkpoint_missing');
    expect(await secondVerify(hollow as never)).toContain('checkpoint_missing:2');
    // 저장한 상태가 있으면 연결도 실패한다.
    const saved = verifyBundle(honest(), { pinnedVkey: vkey }).state as SavedState;
    expect(verifyBundle(hollow, { pinnedVkey: vkey, previous: saved }).ok).toBe(false);
  });

  it('C — 마지막 헤드 뒤의 위조 잎은 검증된 것으로 세지 않고 원천 대조에도 쓰지 않는다', async () => {
    const bundle = honest();
    const last = JSON.parse(bundle.leaves.at(-1)?.leaf ?? '{}') as { seq: number; src: { id: string }; at: string; body: Record<string, unknown> };
    const seq = last.seq + 1;
    const forgedLeaf = { ...last, seq, src: { ...last.src, id: '99999999-9999-4999-8999-999999999999' }, body: { action: 'forged.action', target_id: null } };
    bundle.leaves.push({ id: '999', seq, leaf: canonicalJson(forgedLeaf) });
    bundle.sources.rows.push({ t: 'owner_actions', id: forgedLeaf.src.id, action: 'forged.action', target_id: null, created_at: last.at });
    const report = verifyBundle(bundle, { pinnedVkey: vkey });
    expect(report.stats['uncheckpointed_leaves']).toBe(1);
    expect(report.stats['leaves']).toBe(bundle.leaves.length - 1);
    expect(report.stats['unverified_sources']).toBe(1);
    expect(report.warnings.join(' ')).toContain('체크포인트 뒤의 잎 1개');
    expect(report.errors).toEqual([]);
    expect(await secondVerify(bundle as never)).toEqual([]);
  });

  it('D — 헤드를 빼고 과거 잎과 원천 행을 함께 고쳤다 → to_head_missing · 두 검증기', async () => {
    const bundle = honest();
    bundle.heads = [];
    bundle.org_consistency = null;
    const victim = JSON.parse(bundle.leaves[2]?.leaf ?? '{}') as { body: { action: string }; src: { id: string } };
    victim.body.action = 'rewritten.action';
    (bundle.leaves[2] as { leaf: string }).leaf = canonicalJson(victim);
    bundle.sources.rows = bundle.sources.rows.map((row) => (row['id'] === victim.src.id ? { ...row, action: 'rewritten.action' } : row));
    const report = verifyBundle(bundle, { pinnedVkey: vkey });
    expect(codes(report)).toEqual(expect.arrayContaining(['to_head_missing', 'start_head_missing']));
    expect(await secondVerify(bundle as never)).toEqual(expect.arrayContaining(['to_head', 'start_head']));
  });

  it('중간 헤드 하나를 빼면 epoch_head_missing · 범위 밖 체크포인트는 checkpoint_outside_range', () => {
    const bundle = structuredClone(history.bundle(0, 3)) as Bundle;
    bundle.heads = bundle.heads.filter((head) => head.epoch !== 2);
    expect(codes(verifyBundle(bundle, { pinnedVkey: vkey }))).toContain('epoch_head_missing');
    const extra = structuredClone(history.bundle(0, 1)) as Bundle;
    extra.checkpoints.push({ ...(history.bundle(2, 2) as Bundle).checkpoints[0] } as never);
    expect(codes(verifyBundle(extra, { pinnedVkey: vkey }))).toContain('checkpoint_outside_range');
  });
});

describe("M1' — 조직 로그 id 고정(새 id 로 저장 상태를 건너뛰지 못한다)", () => {
  const history = syntheticHistory({ tag: 'm1', epochs: 10 });
  const vkey = history.signer.vkey;
  const saved = verifyBundle(history.bundle(0, 2), { pinnedVkey: vkey }).state as SavedState;
  const forked = syntheticHistory({ tag: 'm1-fork', epochs: 10, signer: history.signer });

  it('첫 통과가 로그 id 를 고정한다', () => {
    expect(saved.org_log).toBe(history.log);
    expect(saved.org?.log).toBe(history.log);
  });

  it('새 로그 id 를 단 분기 번들(링크 없음 · 링크 있음) → state_org_log_changed · 상태 null', () => {
    expect(forked.log).not.toBe(history.log);
    for (const bundle of [forked.bundle(5, 7), forked.bundle(5, 7, { since: 2 }), forked.bundle(1, 3)]) {
      const report = verifyBundle(bundle, { pinnedVkey: vkey, previous: saved });
      expect(codes(report)).toContain('state_org_log_changed');
      expect(report.state).toBeNull();
    }
  });

  it('--accept-new-log 여도 전역 체크포인트 연결은 본다 — 분기 역사는 실패, 같은 전역 역사의 새 로그 id 는 통과하고 고정이 바뀐다', () => {
    const fork = verifyBundle(forked.bundle(5, 7, { since: 2 }), { pinnedVkey: vkey, previous: saved, acceptNewLog: true });
    expect(codes(fork)).toContain('state_checkpoint_inconsistent');
    expect(fork.state).toBeNull();
    const renamed: SavedState = { ...saved, org_log: 'ee'.repeat(16), org: { ...(saved.org as NonNullable<SavedState['org']>), log: 'ee'.repeat(16) } };
    expect(codes(verifyBundle(history.bundle(1, 3), { pinnedVkey: vkey, previous: renamed }))).toContain('state_org_log_changed');
    const accepted = verifyBundle(history.bundle(1, 3), { pinnedVkey: vkey, previous: renamed, acceptNewLog: true });
    expect(accepted.errors).toEqual([]);
    expect(accepted.warnings.join(' ')).toContain('조직 로그 id 가 바뀌었다');
    expect(accepted.state?.org_log).toBe(history.log);
  });

  it('상태 파일에 org_log 가 없으면 state_malformed(조용히 고정 없이 넘어가지 않는다)', () => {
    const { org_log: _dropped, ...legacy } = saved;
    expect(codes(verifyBundle(history.bundle(1, 3), { pinnedVkey: vkey, previous: legacy as SavedState }))).toContain('state_malformed');
  });
});

describe("L1' — 조직 로그의 시작을 늦춰 꾸미지 못한다(창세 잎부터 싣는 번들)", () => {
  // A 의 로그는 에폭 3 에 생긴다 — 서버 규칙대로 from ≤ 2 인 번들은 시작 크기 0 · 창세 잎부터 · 첫 헤드 3.
  const history = syntheticHistory({ tag: 'l1', epochs: 7, startEpoch: 3 });
  const vkey = history.signer.vkey;

  it('정직한 번들(from 이 로그 시작 전) — 두 검증기 통과 · 시작 크기 0 · 첫 헤드 3', async () => {
    const bundle = history.bundle(1, 5) as Bundle;
    expect(bundle.start.size).toBe(0);
    expect(bundle.heads[0]?.epoch).toBe(3);
    expect(verifyBundle(bundle, { pinnedVkey: vkey }).errors).toEqual([]);
    expect(await secondVerify(bundle as never)).toEqual([]);
    // 로그가 시작한 뒤의 범위는 시작 크기 > 0 — 저장 상태가 없으면 "앞 역사를 보지 않았다" 경고(오류 아님).
    const later = verifyBundle(history.bundle(4, 5), { pinnedVkey: vkey });
    expect(later.errors).toEqual([]);
    expect(later.warnings.join(' ')).toContain('에폭 4 앞의 역사는 보지 않았다');
  });

  it('앞 에폭 헤드를 뺐다(첫 헤드 3 → 4) — 에폭 3 은 창세 뒤에 닫혔다 → org_start_hidden · 두 검증기', async () => {
    const bundle = structuredClone(history.bundle(1, 5)) as Bundle;
    bundle.heads = bundle.heads.filter((head) => head.epoch !== 3);
    expect(codes(verifyBundle(bundle, { pinnedVkey: vkey }))).toContain('org_start_hidden');
    expect(await secondVerify(bundle as never)).toContain('org_start_hidden:4');
  });

  it('범위를 로그 시작 뒤로 잡고 시작 크기 0 으로 창세부터 실었다(from = 첫 헤드) → org_start_unproven · 두 검증기', async () => {
    const bundle = structuredClone(history.bundle(1, 5)) as Bundle & { global_consistency: { from: number }[] };
    bundle.range = { from_epoch: 4, to_epoch: 5 };
    bundle.checkpoints = bundle.checkpoints.filter((entry) => entry.epoch >= 4);
    bundle.global_consistency = bundle.global_consistency.filter((link) => link.from >= 5);
    bundle.heads = bundle.heads.filter((head) => head.epoch >= 4);
    expect(codes(verifyBundle(bundle, { pinnedVkey: vkey }))).toContain('org_start_unproven');
    expect(await secondVerify(bundle as never)).toContain('org_start_unproven:4');
  });

  it('seq 0 잎이 창세가 아니면 org_genesis_missing', async () => {
    const bundle = structuredClone(history.bundle(1, 5)) as Bundle;
    const first = JSON.parse(bundle.leaves[0]?.leaf ?? '{}') as Record<string, unknown>;
    (bundle.leaves[0] as { leaf: string }).leaf = canonicalJson({ ...first, kind: 'owner.action' });
    expect(codes(verifyBundle(bundle, { pinnedVkey: vkey }))).toContain('org_genesis_missing');
    expect(await secondVerify(bundle as never)).toContain('org_genesis');
  });
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

describe('M3 — 에폭 트리 잎에 에폭 번호(형식 v2)', () => {
  it('쉬는 조직의 잎도 에폭마다 다르다 · 전역 잎 v = 2 · 검증기는 v1 전역 잎을 받지 않는다', () => {
    const root = 'ab'.repeat(32);
    expect(epochTreeLeaf(1, 'cd'.repeat(16), 3, root)).not.toBe(epochTreeLeaf(2, 'cd'.repeat(16), 3, root));
    expect(epochTreeLeaf(1, 'cd'.repeat(16), 3, root)).toBe(canonical({ epoch: 1, log: 'cd'.repeat(16), root, size: 3 }));
    expect(JSON.parse(globalEpochLeaf(0, '2026-09-24T00:00:00.000000Z', root)) as { v: number }).toMatchObject({ v: GLOBAL_LEAF_VERSION });
    expect(GLOBAL_LEAF_VERSION).toBe(2);
    const history = syntheticHistory({ tag: 'm3' });
    const bundle = history.bundle(1, 2) as Bundle & { checkpoints: { global_leaf: string }[] };
    const v1 = structuredClone(bundle);
    (v1.checkpoints[0] as { global_leaf: string }).global_leaf = (v1.checkpoints[0] as { global_leaf: string }).global_leaf.replace('"v":2', '"v":1');
    expect(codes(verifyBundle(v1, { pinnedVkey: history.signer.vkey }))).toContain('global_leaf_version');
  });

  it('형제 해시: 쉬는 조직 C 가 있는 에폭 3·5 의 A 포함 증명이 서로 다르다(v1 이면 C 쪽 형제가 같았다)', () => {
    const history = syntheticHistory({ tag: 'm3-siblings', epochs: 6 });
    const bundle = history.bundle(3, 5) as Bundle & { heads: { epoch: number; epoch_proof: string[] }[] };
    const proofs = bundle.heads.map((head) => head.epoch_proof);
    expect(proofs[0]).not.toEqual(proofs[2]);
    for (const [index, proof] of proofs.entries()) for (const sibling of proof) expect(proofs.filter((other, i) => i !== index && other.includes(sibling))).toEqual([]);
  });
});

describe('H4 — 게시 수위(서명 전 계획)', () => {
  const logs = ['1'.repeat(32)];
  const heads = [{ log: logs[0] as string, size: 1, root: leafHash(Buffer.from('x')) }];
  const first = planEpoch({ epoch: 0, closedAt: '2026-09-24T00:00:00.000000Z', logs, heads, previousHeads: [], globalLeafHashes: [], previousRoot: null, leafHashesOf: () => undefined });
  const next = {
    epoch: 1,
    closedAt: '2026-09-24T01:00:00.000000Z',
    logs,
    heads: first.heads,
    previousHeads: first.heads,
    globalLeafHashes: [first.globalLeafHash],
    previousRoot: first.globalRoot,
    leafHashesOf: () => undefined,
  };

  it('게시본과 이어지면 서명 계획 · 게시본이 더 크면 published_rollback · 갈라지면 published_inconsistent', () => {
    expect(planEpoch({ ...next, published: { size: 1, root: first.globalRoot } }).treeSize).toBe(2);
    expect(() => planEpoch({ ...next, published: { size: 3, root: Buffer.alloc(32) } })).toThrow('published_rollback');
    expect(() => planEpoch({ ...next, published: { size: 1, root: Buffer.alloc(32, 9) } })).toThrow('published_inconsistent');
    expect(() => planEpoch({ ...next, published: { size: 1, root: Buffer.alloc(32, 9) } })).toThrow(EpochIntegrityError);
    // 같은 크기 = 새 트리보다 하나 작다(에폭 1 을 닫는 중) — 새 루트와 게시본의 일관성은 prefix 루트로 본다.
    const two = planEpoch({ ...next, published: null });
    expect(() => planEpoch({ ...next, published: { size: 2, root: two.globalRoot } })).not.toThrow();
    expect(rootOf([first.globalLeafHash, two.globalLeafHash])).toEqual(two.globalRoot);
  });

  it('origin 은 서명 키 이름을 따른다(기본 운영 값)', () => {
    expect(planEpoch({ ...next, origin: 'staging.id.atmark.ai/log/v1' }).checkpointText.startsWith('staging.id.atmark.ai/log/v1\n')).toBe(true);
    expect(planEpoch(next).checkpointText.startsWith(`${TLOG_ORIGIN}\n`)).toBe(true);
  });
});

describe('M6 — 번들 한 페이지의 끝', () => {
  it('에폭 상한 · 잎 상한 안에서 가장 큰 to · 한 에폭이 상한을 넘으면 413', () => {
    expect(bundlePageEnd(0, 10, 0, [{ epoch: 10, size: 100 }])).toBe(10);
    expect(bundlePageEnd(0, 1000, 0, [])).toBe(MAX_BUNDLE_EPOCHS - 1);
    const sizes = [1, 2, 3, 4].map((epoch) => ({ epoch, size: epoch * 2000 }));
    expect(bundlePageEnd(0, 4, 0, sizes)).toBe(2);
    expect(bundlePageEnd(2, 4, 4000, sizes)).toBe(4);
    expect(() => bundlePageEnd(0, 4, 0, [{ epoch: 1, size: MAX_BUNDLE_LEAVES + 1 }])).toThrow(TlogProofRangeError);
    expect(bundlePageEnd(3, 3, 6000, sizes)).toBe(3);
  });
});

describe('L7 — origin 고정 · 안전한 정수', () => {
  it('다른 origin 의 번들 · 체크포인트 · 키 이름은 실패', () => {
    const history = syntheticHistory({ tag: 'l7' });
    const bundle = history.bundle(1, 2);
    expect(codes(verifyBundle(bundle, { pinnedVkey: history.signer.vkey, origin: 'other.example/log/v1' }))).toEqual(
      expect.arrayContaining(['origin_mismatch', 'vkey_origin_mismatch', 'checkpoint_origin_mismatch']),
    );
    const staging = syntheticSigner('staging.id.atmark.ai/log/v1');
    expect(codes(verifyBundle({ ...bundle, vkey: staging.vkey }, { pinnedVkey: staging.vkey }))).toContain('vkey_origin_mismatch');
  });

  it('tree size 가 2^53 이상이면 체크포인트 모양이 아니다', () => {
    const root = Buffer.alloc(32, 1).toString('base64');
    expect(() => parseCheckpointBody(`${TLOG_ORIGIN}\n9007199254740993\n${root}\n`)).toThrow('tree size');
    expect(() => parseCheckpointBody(`${TLOG_ORIGIN}\n1\n${root}\n`)).not.toThrow();
    expect(() => parseCheckpointBody(`bad origin\n1\n${root}\n`)).toThrow('origin');
    expect(checkpointBody({ origin: TLOG_ORIGIN, size: 1, root: Buffer.alloc(32) })).toMatch(/^id\.atmark\.ai\/log\/v1\n1\n/);
  });
});

// ---------------------------------------------------------------------------
// 신원 잎(US-013) 적대적 검증 — M2 · M3 · L6. 합성 역사: 에폭 2 에 에이전트 생성 잎, 에폭 3 에 상태 갱신 잎(active → suspended/owner),
// 도입(01:30) 전인 01:00 에 만든 에이전트·주소 행(잎 없음).
// ---------------------------------------------------------------------------

const IDENTITY_SINCE = '2026-09-24T01:30:00.000000Z';
type Row = Record<string, unknown> & { t: string; id: string };
const rowsOf = (bundle: Record<string, unknown>): Row[] => (bundle['sources'] as { rows: Row[] }).rows;

describe("M2' — 신원 잎 도입 시각(identity_since): 도입 전 행은 거짓 경보가 아니고, 서버가 늦춰 숨기지 못한다", () => {
  const history = syntheticHistory({ tag: 'm2i', epochs: 6, identitySince: IDENTITY_SINCE });
  const vkey = history.signer.vkey;

  it('정직한 번들 — 도입 전(로그 시작 뒤)에 만든 에이전트·주소 행은 잎이 없어도 통과 · 두 검증기 · 상태가 도입 시각을 고정한다', async () => {
    const bundle = history.bundle(0, 5);
    const report = verifyBundle(bundle, { pinnedVkey: vkey });
    expect(report.errors).toEqual([]);
    expect(report.stats['context_sources']).toBeGreaterThanOrEqual(2);
    expect(report.state?.identity_since).toBe(IDENTITY_SINCE);
    expect(await secondVerify(bundle as never)).toEqual([]);
  });

  it('도입 시각이 없으면(옛 서버) 도입 전 행을 가리지 못한다 — row_without_leaf(가림이 실제로 일하고 있다는 대조군) · 경고', () => {
    const { identity_since: _dropped, ...legacy } = history.bundle(0, 5);
    const report = verifyBundle(legacy, { pinnedVkey: vkey });
    expect(report.errors.filter((issue) => issue.code === 'row_without_leaf').map((issue) => issue.detail.split(' ')[0])).toHaveLength(2);
    expect(report.warnings.join(' ')).toContain('identity_since');
  });

  it('서버가 도입 시각을 신원 잎 뒤로 늦추면 identity_since_after_leaf — 두 검증기', async () => {
    const bundle = { ...history.bundle(0, 5), identity_since: '2026-09-24T02:30:00.000000Z' };
    expect(codes(verifyBundle(bundle, { pinnedVkey: vkey }))).toContain('identity_since_after_leaf');
    expect((await secondVerify(bundle as never)).some((code) => code.startsWith('identity_since_after_leaf'))).toBe(true);
  });

  it('저장 상태에 고정된 도입 시각과 다른 번들은 state_identity_since_changed(범위에 신원 잎이 없어도) · 상태 null', () => {
    const saved = verifyBundle(history.bundle(0, 1), { pinnedVkey: vkey }).state as SavedState;
    expect(saved.identity_since).toBe(IDENTITY_SINCE);
    const moved = { ...history.bundle(1, 5), identity_since: '2026-09-24T01:45:00.000000Z' };
    const report = verifyBundle(moved, { pinnedVkey: vkey, previous: saved });
    expect(codes(report)).toContain('state_identity_since_changed');
    expect(report.state).toBeNull();
    expect(verifyBundle(history.bundle(1, 5), { pinnedVkey: vkey, previous: saved }).errors).toEqual([]);
  });
});

describe("M3' — 창 끝 뒤에 바뀐 agents 행: 미래 시각은 오류 · 아니면 이름 붙은 경고 + 저장 상태의 대기 → 다음 번들이 풀어야 한다", () => {
  const history = syntheticHistory({ tag: 'm3i', epochs: 6, identitySince: IDENTITY_SINCE });
  const vkey = history.signer.vkey;
  const agent = history.identityAgent as string;
  const withAgent = (bundle: Record<string, unknown>, patch: Record<string, unknown> | null): Record<string, unknown> => {
    const rows = rowsOf(bundle).flatMap((row) => (row.t === 'agents' && row.id === agent ? (patch === null ? [] : [{ ...row, ...patch }]) : [row]));
    return { ...bundle, sources: { ...(bundle['sources'] as object), rows } };
  };

  it('updated_at 을 먼 미래로 꾸미면 updated_at_in_future(접기 대조를 건너뛰는 길이 막힌다)', () => {
    const report = verifyBundle(withAgent(history.bundle(0, 5), { status: 'active', suspended_by: null, updated_at: '2031-01-01T00:00:00.000000Z' }), { pinnedVkey: vkey });
    expect(codes(report)).toEqual(['updated_at_in_future']);
    expect(report.state).toBeNull();
  });

  it('창 끝 뒤(번들 생성 전)에 상태를 되돌렸다 → 경고 agent_fold_deferred + 대기 → 다음 번들이 행을 마지막 잎과 대조해 row_leaf_mismatch', () => {
    const first = verifyBundle(withAgent(history.bundle(0, 3), { status: 'active', suspended_by: null, updated_at: '2026-09-24T04:30:00.000000Z' }), { pinnedVkey: vkey });
    expect(first.errors).toEqual([]);
    expect(first.warnings.some((warning) => warning.startsWith(`agent_fold_deferred: agents:${agent}`))).toBe(true);
    const saved = first.state as SavedState;
    expect(saved.pending_agent_updates).toHaveLength(1);
    expect(saved.pending_agent_updates?.[0]).toMatchObject({ agent, updated_at: '2026-09-24T04:30:00.000000Z' });
    // 다음 번들(저장한 에폭 3 부터) — 뒤의 agent_updated 잎이 없고 행은 여전히 active.
    const next = verifyBundle(withAgent(history.bundle(3, 5), { status: 'active', suspended_by: null, updated_at: '2026-09-24T04:30:00.000000Z' }), { pinnedVkey: vkey, previous: saved });
    expect(codes(next)).toEqual(['row_leaf_mismatch']);
    expect(next.errors[0]?.detail).toContain(`agents:${agent}`);
  });

  it('상태와 무관한 칸만 바뀌었다(값 = 마지막 잎) → 다음 번들에서 대조가 맞아 대기가 풀린다', () => {
    const first = verifyBundle(withAgent(history.bundle(0, 3), { updated_at: '2026-09-24T04:30:00.000000Z' }), { pinnedVkey: vkey });
    const saved = first.state as SavedState;
    expect(saved.pending_agent_updates).toHaveLength(1);
    const next = verifyBundle(withAgent(history.bundle(3, 5), { updated_at: '2026-09-24T04:30:00.000000Z' }), { pinnedVkey: vkey, previous: saved });
    expect(next.errors).toEqual([]);
    expect(next.state?.pending_agent_updates).toEqual([]);
  });

  it('다음 번들에 그 행도 뒤의 잎도 없으면 agent_update_leaf_missing · 저장 상태의 대기 모양이 틀리면 state_malformed', () => {
    const saved = verifyBundle(withAgent(history.bundle(0, 3), { status: 'active', suspended_by: null, updated_at: '2026-09-24T04:30:00.000000Z' }), { pinnedVkey: vkey })
      .state as SavedState;
    expect(codes(verifyBundle(withAgent(history.bundle(3, 5), null), { pinnedVkey: vkey, previous: saved }))).toEqual(['agent_update_leaf_missing']);
    const broken = { ...saved, pending_agent_updates: [{ agent: 'x', after_seq: -1, updated_at: 'now', last_leaf: 1 }] } as unknown as SavedState;
    expect(codes(verifyBundle(history.bundle(3, 5), { pinnedVkey: vkey, previous: broken }))).toEqual(['state_malformed']);
  });
});

describe("L6' — 번들이 요구하는 검증기 판", () => {
  it('min_verifier_version 이 이 검증기(VERIFIER_VERSION)보다 크면 verifier_outdated 로 멈춘다 · 같거나 작으면 통과', () => {
    const history = syntheticHistory({ tag: 'l6', epochs: 4, identitySince: IDENTITY_SINCE });
    const bundle = history.bundle(0, 3);
    // 판 5(ADR-0014 단계 3)는 도메인·대표 주소 잎이 있는 번들만 요구한다 — 그 잎이 없는 번들은 판 4 그대로(`verifier-v5.test.ts`).
    expect(bundle['min_verifier_version']).toBe(MIN_VERIFIER_VERSION);
    expect(MIN_VERIFIER_VERSION).toBe(4);
    expect(DOMAIN_MIN_VERIFIER_VERSION).toBe(5);
    // 판 6(운영자 · 시스템 행위자, 202610131610)이 이 검증기 — 그 행이 있는 번들만 요구한다(`owner-action-actor.test.ts`).
    expect(OPERATOR_MIN_VERIFIER_VERSION).toBe(VERIFIER_VERSION);
    expect(verifyBundle(bundle, { pinnedVkey: history.signer.vkey }).errors).toEqual([]);
    const report = verifyBundle({ ...bundle, min_verifier_version: VERIFIER_VERSION + 1 }, { pinnedVkey: history.signer.vkey });
    expect(codes(report)).toEqual(['verifier_outdated']);
    expect(report.errors[0]?.detail).toContain(`v${String(VERIFIER_VERSION + 1)}`);
  });
});
