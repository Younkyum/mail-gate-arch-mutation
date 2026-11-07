/**
 * 투명성 로그 — **Go `golang.org/x/mod/sumdb/{tlog,note}` 교차 검증**(ADR-0008 §2.6 "서로 다른 구현" · F28). Go 가 없으면 건너뛴다.
 *
 * 네트워크 0 · 리포에 제3자 코드 0: Go 설치본이 싣고 있는 x/mod 사본(`$GOROOT/src/cmd/vendor/golang.org/x/mod/sumdb`)을 임시 모듈로 복사하고
 * `test/support/go-tlog/main.go` 를 `go run` 한다(GOPROXY=off · GOTOOLCHAIN=local · GOFLAGS=-mod=mod).
 *
 *   ① 머클: 생산자(`src/tlog/merkle.ts`)의 포함·일관성 증명 = Go ProveRecord/ProveTree · 변조한 증명의 판정이 같다.
 *   ② C2SP 타일 경로·내용 = Go ReadTileData · 잎 묶음.
 *   ③ vkey(H1): 생산자 vkeyOf 의 출력 — 키 자료에 `+` 가 든 것을 포함해 Go note.NewVerifier 가 전부 받는다 · 체크포인트를 note.Open 으로 연다.
 *   ④ 번들 v2(M3): 에폭 트리 잎 {epoch, log, root, size} · 전역 포함·일관성 · 헤드 재계산 · 빠짐(H3) · since 링크(H2) — 정직한 번들은 Go 가 통과,
 *      변조·누락 번들은 Go 도 거부한다.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { vkeyOf } from '../../../src/tlog/checkpoint';
import { TLOG_ORIGIN } from '../../../src/tlog/constants';
import { consistencyProof, inclusionProof, leafHash, rootOf, verifyConsistency, verifyInclusion } from '../../../src/tlog/merkle';
import { rightmostTiles } from '../../../src/tlog/tiles';
import { syntheticHistory } from '../../support/tlog-synthetic';

function goRoot(): string | null {
  try {
    return execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, GOTOOLCHAIN: 'local' } }).trim();
  } catch {
    return null;
  }
}

const GOROOT = goRoot();
const SUMDB = GOROOT === null ? null : join(GOROOT, 'src', 'cmd', 'vendor', 'golang.org', 'x', 'mod', 'sumdb');
const AVAILABLE = SUMDB !== null && existsSync(join(SUMDB, 'tlog', 'tlog.go')) && existsSync(join(SUMDB, 'note', 'note.go'));

/** 결정적 의사난수(선형 합동) — 같은 벡터. */
function prng(seed: number): (n: number) => number {
  let state = seed;
  return (n: number) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % n;
  };
}

function vectors(): Record<string, unknown> {
  const rnd = prng(12345);
  const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
  const entries = Array.from({ length: 1100 }, (_, i) => Buffer.from(`entry-${String(i)}-${'x'.repeat(rnd(40))}`));
  const hashes = entries.map((entry) => leafHash(entry));
  const mutate = (proof: Buffer[]): { kind: string; proof: Buffer[] }[] => {
    const out: { kind: string; proof: Buffer[] }[] = [{ kind: 'extra', proof: [...proof, Buffer.alloc(32, 7)] }];
    if (proof.length > 0) {
      const flipped = proof.map((node) => Buffer.from(node));
      const victim = flipped[rnd(flipped.length)] as Buffer;
      const offset = rnd(32);
      victim[offset] = (victim[offset] as number) ^ 1;
      out.push({ kind: 'flip', proof: flipped }, { kind: 'drop_last', proof: proof.slice(0, -1) });
    }
    return out;
  };
  const sizes = [...Array.from({ length: 70 }, (_, i) => i + 1), 255, 256, 257, 511, 512, 513, 1024, 1025, 1100];
  const cases = sizes.map((n) => {
    const root = rootOf(hashes, n);
    const indexes = n <= 20 ? [...Array(n).keys()] : [0, n - 1, rnd(n), n >> 1];
    const incl = indexes.map((i) => {
      const proof = inclusionProof(hashes, i, n);
      return { i, proof: proof.map(hex), muts: mutate(proof).map((m) => ({ kind: m.kind, proof: m.proof.map(hex), ts: verifyInclusion(i, n, hashes[i] as Buffer, m.proof, root) })) };
    });
    const ms = n <= 20 ? [...Array(n + 1).keys()] : [1, 2, n - 1, n, 1 + rnd(n)];
    const cons = ms.map((m) => {
      const proof = consistencyProof(hashes, m, n);
      const r1 = rootOf(hashes, m);
      return { m, r1: hex(r1), proof: proof.map(hex), muts: mutate(proof).map((x) => ({ kind: x.kind, proof: x.proof.map(hex), ts: verifyConsistency(m, n, r1, root, x.proof) })) };
    });
    return { n, root: hex(root), incl, cons };
  });
  const tiles = [1, 2, 255, 256, 257, 300, 511, 512, 513, 1100].flatMap((n) =>
    rightmostTiles(hashes, entries, n).map((tile) => ({ n, path: tile.path, bytes: tile.bytes.toString('base64') })),
  );
  // H1 — 무작위 공개키의 vkey(약 절반은 키 자료에 `+`).
  const vkeys = Array.from({ length: 300 }, (_, i) => vkeyOf(TLOG_ORIGIN, Buffer.from(leafHash(Buffer.from(`key-${String(i)}`)))));

  const history = syntheticHistory({ tag: 'go', epochs: 8 });
  const honest = history.bundle(2, 5);
  const saved = history.bundle(0, 1) as { checkpoints: { note: string }[] };
  const savedRoot = Buffer.from((saved.checkpoints[1]?.note.split('\n')[2] ?? ''), 'base64').toString('hex');
  const tamperedLeaf = structuredClone(honest) as { leaves: { leaf: string }[] };
  (tamperedLeaf.leaves[1] as { leaf: string }).leaf = (tamperedLeaf.leaves[1] as { leaf: string }).leaf.replace('probe.e', 'probe.x');
  const missingCheckpoint = structuredClone(honest) as { checkpoints: unknown[] };
  missingCheckpoint.checkpoints.splice(1, 1);
  const headsDropped = structuredClone(honest) as { heads: unknown[] };
  headsDropped.heads = [];
  const v1Leaf = structuredClone(honest) as { heads: { epoch_proof: string[] }[] };
  // 에폭 트리 v1(에폭 없는 잎)로 만든 증명인 척 — 형제 하나를 바꾸면 v2 잎으로 루트가 맞지 않는다.
  (v1Leaf.heads[0] as { epoch_proof: string[] }).epoch_proof[0] = 'ff'.repeat(32);
  return {
    entries: entries.map((entry) => entry.toString('base64')),
    cases,
    tiles,
    vkeys,
    vkey: history.signer.vkey,
    notes: (honest as { checkpoints: { epoch: number; note: string }[] }).checkpoints.map((entry) => ({ n: entry.epoch + 1, note: entry.note })),
    bundles: [
      { name: 'honest', bundle: honest },
      { name: 'linked', bundle: history.bundle(4, 6, { since: 1 }), savedEpoch: 1, savedRoot },
      { name: 'unlinked', bundle: history.bundle(4, 6), savedEpoch: 1, savedRoot },
      { name: 'tampered_leaf', bundle: tamperedLeaf },
      { name: 'missing_checkpoint', bundle: missingCheckpoint },
      { name: 'heads_dropped', bundle: headsDropped },
      { name: 'epoch_proof', bundle: v1Leaf },
    ],
  };
}

interface GoOutput {
  readonly disagreements: string[];
  readonly counts: Record<string, number>;
  readonly bundles: { name: string; errors: string[] }[];
}

describe.skipIf(!AVAILABLE)('Go golang.org/x/mod/sumdb 교차 검증(Go 가 있을 때)', { timeout: 180_000 }, () => {
  const work = mkdtempSync(join(tmpdir(), 'atmark-go-tlog-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('머클·타일·vkey·체크포인트·번들 v2 — Go 와 불일치 0 · 정직한 번들 통과 · 변조·누락은 Go 도 거부', () => {
    for (const pkg of ['tlog', 'note']) {
      mkdirSync(join(work, 'third_party', pkg), { recursive: true });
      for (const file of readdirSync(join(SUMDB as string, pkg)).filter((name) => name.endsWith('.go') && !name.endsWith('_test.go'))) {
        copyFileSync(join(SUMDB as string, pkg, file), join(work, 'third_party', pkg, file));
      }
    }
    writeFileSync(join(work, 'go.mod'), 'module atmarkgo\n\ngo 1.22\n');
    copyFileSync(fileURLToPath(new URL('../../support/go-tlog/main.go', import.meta.url)), join(work, 'main.go'));
    writeFileSync(join(work, 'input.json'), JSON.stringify(vectors()));
    const stdout = execFileSync('go', ['run', '.', 'input.json'], {
      cwd: work,
      encoding: 'utf8',
      timeout: 170_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GOTOOLCHAIN: 'local', GOPROXY: 'off', GOFLAGS: '-mod=mod', GOWORK: 'off' },
    });
    const output = JSON.parse(stdout) as GoOutput;
    expect(output.disagreements).toEqual([]);
    expect(output.counts['inclusion']).toBeGreaterThan(200);
    expect(output.counts['consistency']).toBeGreaterThan(200);
    expect(output.counts['mutations']).toBeGreaterThan(500);
    expect(output.counts['tiles']).toBeGreaterThan(10);
    expect(output.counts['vkeys']).toBe(300);
    expect(output.counts['notes']).toBe(4);
    const result = (name: string): string[] => output.bundles.find((entry) => entry.name === name)?.errors ?? ['(없음)'];
    expect(result('honest')).toEqual([]);
    expect(result('linked')).toEqual([]);
    expect(result('unlinked')).toContain('state_unlinked');
    expect(result('tampered_leaf').some((code) => code.startsWith('head_root'))).toBe(true);
    expect(result('missing_checkpoint').some((code) => code.startsWith('checkpoint_missing'))).toBe(true);
    expect(result('heads_dropped')).toEqual(expect.arrayContaining(['start_head', 'to_head']));
    expect(result('epoch_proof').some((code) => code.startsWith('head_epoch'))).toBe(true);
  });
});
