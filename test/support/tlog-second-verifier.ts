/**
 * test/support/tlog-second-verifier.ts — **두 번째 독립 검증기**(ADR-0008 §2.6 "서로 다른 구현 둘" · A-T6).
 *
 * `scripts/tlog-verify/verifier.ts`(1차)·`src/tlog/**`(생산자) 어느 쪽도 import 하지 않는다. 다른 부품으로 같은 번들의 **암호학적
 * 골격**을 다시 본다:
 *   - JCS: npm `canonicalize`(RFC 8785 저자의 구현) — 1차는 손으로 쓴 직렬화기, 생산자는 `src/passport/jcs.ts`.
 *   - Ed25519: `@noble/ed25519` — 1차·생산자는 Node(OpenSSL).
 *   - 머클: transparency-dev 식 inner/border 분해(`tlog-reference.ts`) — 1차는 RFC 9162 §2.1.3.2 비트 연산.
 *   - 조직 헤드: 가장자리 + 잎에서 **위에서 아래로** 재귀(RFC 정의)로 루트를 다시 만든다 — 1차는 아래에서 위로 쌓는 스택.
 * 원천 행 대조(커밋 열기)·저장 상태 연결은 1차의 몫이다 — 이 검증기는 "로그가 한 역사이고 서명·증명이 맞고 **빠진 것이 없는가**" 만 본다:
 * 범위의 모든 에폭에 체크포인트 · 시작 크기 > 0 이면 from 헤드 · 잎이 있으면 to 헤드 · 첫 헤드부터 to 까지 헤드가 끊기지 않음 ·
 * 시작 크기 0(창세 잎부터)이면 첫 헤드 직전 에폭이 범위 안이고 창세 잎 `at` 전에 닫혔다(L1 — 1차와 같은 규칙, 시각은 문자열 대신 Date 로 본다).
 * vkey 는 Go `note.NewVerifier` 처럼 자른다(키 자료 = 둘째 `+` 뒤 전부 — base64 에 `+` 가 있다). origin 은 고정 값과 같아야 한다.
 */

import { createHash } from 'node:crypto';

import * as ed from '@noble/ed25519';
import canonicalizeImport from 'canonicalize';

import { refLeafHash, refNodeHash, refVerifyConsistency, refVerifyInclusion } from './tlog-reference';

const canonicalize = canonicalizeImport as unknown as (value: unknown) => string | undefined;

interface Bundle {
  format: string;
  identity_since?: unknown;
  vkey: string;
  origin: string;
  org: { log: string };
  range: { from_epoch: number; to_epoch: number };
  start: { size: number; frontier: { height: number; hash: string }[] };
  leaves: { seq: number; leaf: string }[];
  heads: { epoch: number; size: number; root: string; position: number; epoch_size: number; epoch_proof: string[] }[];
  checkpoints: { epoch: number; note: string; global_leaf: string; inclusion: string[] }[];
  global_consistency: { from: number; to: number; proof: string[] }[];
  org_consistency: { from_size: number; to_size: number; proof: string[] } | null;
}

const bytes = (hex: string): Buffer => Buffer.from(hex, 'hex');

/** C2SP vkey — 이름 · 키 id · 키 자료(둘째 `+` 뒤 **전부**). 정규식으로 자른다(1차는 indexOf). */
export function secondParseVkey(vkey: string): { name: string; id: Buffer; publicKey: Buffer } | null {
  const match = /^([^+\s]+)\+([0-9a-f]{8})\+([A-Za-z0-9+/]+={0,2})$/u.exec(vkey.trim());
  if (match === null) return null;
  const [, name, idHex, material] = match as unknown as [string, string, string, string];
  const raw = Buffer.from(material, 'base64');
  if (raw.length !== 33 || raw[0] !== 1) return null;
  const publicKey = raw.subarray(1);
  const id = createHash('sha256').update(name).update(Buffer.from([0x0a, 0x01])).update(publicKey).digest().subarray(0, 4);
  return id.toString('hex') === idHex ? { name, id, publicKey } : null;
}

async function openCheckpoint(note: string, vkey: string, origin: string): Promise<{ size: number; root: Buffer } | null> {
  const key = secondParseVkey(vkey);
  if (key === null || key.name !== origin) return null;
  const [text, signatures] = note.split('\n\n') as [string, string | undefined];
  if (signatures === undefined) return null;
  const body = `${text}\n`;
  for (const line of signatures.split('\n')) {
    const parts = line.split(' ');
    if (parts[0] !== '—' || parts[1] !== key.name || parts[2] === undefined) continue;
    const blob = Buffer.from(parts[2], 'base64');
    if (!blob.subarray(0, 4).equals(key.id)) continue;
    if (await ed.verifyAsync(blob.subarray(4), Buffer.from(body, 'utf8'), key.publicKey)) {
      const lines = body.split('\n');
      const size = Number(lines[1]);
      if (lines[0] !== origin || !/^\d+$/.test(lines[1] ?? '') || !Number.isSafeInteger(size)) return null;
      return { size, root: Buffer.from(lines[2] ?? '', 'base64') };
    }
  }
  return null;
}

/** 크기 m 트리의 루트 — [0, start) 는 가장자리 노드로, 그 뒤는 잎으로 채우며 RFC 정의대로 위에서 아래로. */
function rootAt(m: number, start: number, frontier: readonly { height: number; hash: Buffer }[], leaves: readonly Buffer[]): Buffer {
  const nodes = new Map<string, Buffer>();
  let offset = 0;
  for (const node of frontier) {
    nodes.set(`${String(offset)}:${String(2 ** node.height)}`, node.hash);
    offset += 2 ** node.height;
  }
  const mth = (a: number, n: number): Buffer => {
    const known = nodes.get(`${String(a)}:${String(n)}`);
    if (known !== undefined) return known;
    if (n === 1) {
      if (a < start) throw new Error('가장자리 밖의 과거 잎을 요구했다');
      return leaves[a - start] as Buffer;
    }
    if (n === 0) return createHash('sha256').digest();
    let k = 1;
    while (k * 2 < n) k *= 2;
    return refNodeHash(mth(a, k), mth(a + k, n - k));
  };
  return mth(0, m);
}

/** 오류 코드 목록(비면 통과). 모양이 틀린 번들은 `malformed` 하나. */
export async function secondVerify(bundle: Bundle, origin = 'id.atmark.ai/log/v1'): Promise<string[]> {
  try {
    return await secondVerifyUnsafe(bundle, origin);
  } catch {
    return ['malformed'];
  }
}

async function secondVerifyUnsafe(bundle: Bundle, origin: string): Promise<string[]> {
  const errors: string[] = [];
  if (bundle.format !== 'atmark-tlog-bundle/v2') return ['format'];
  if (bundle.origin !== origin) errors.push('origin');
  const { from_epoch: from, to_epoch: to } = bundle.range;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) return [...errors, 'range'];
  const checkpoints = new Map<number, { size: number; root: Buffer }>();
  const epochRoots = new Map<number, Buffer>();
  const closedAt = new Map<number, number>();
  for (const entry of bundle.checkpoints) {
    if (entry.epoch < from || entry.epoch > to) {
      errors.push(`checkpoint_range:${String(entry.epoch)}`);
      continue;
    }
    const opened = await openCheckpoint(entry.note, bundle.vkey, origin);
    if (opened === null) {
      errors.push(`signature:${String(entry.epoch)}`);
      continue;
    }
    const parsed = JSON.parse(entry.global_leaf) as { v: unknown; kind: unknown; epoch: number; epoch_root: string; closed_at: unknown };
    if (canonicalize(parsed) !== entry.global_leaf || parsed.epoch !== entry.epoch || parsed.v !== 2 || parsed.kind !== 'epoch' || opened.size !== entry.epoch + 1) {
      errors.push(`global_leaf:${String(entry.epoch)}`);
    }
    if (!refVerifyInclusion(entry.epoch, opened.size, refLeafHash(Buffer.from(entry.global_leaf)), entry.inclusion.map(bytes), opened.root)) {
      errors.push(`global_inclusion:${String(entry.epoch)}`);
    }
    checkpoints.set(entry.epoch, opened);
    epochRoots.set(entry.epoch, bytes(parsed.epoch_root));
    if (typeof parsed.closed_at === 'string') closedAt.set(entry.epoch, new Date(parsed.closed_at.replace(/(\.\d{3})\d*Z$/, '$1Z')).getTime());
  }
  for (let epoch = from; epoch <= to; epoch += 1) if (!checkpoints.has(epoch)) errors.push(`checkpoint_missing:${String(epoch)}`);
  for (let epoch = from; epoch < to; epoch += 1) {
    const link = bundle.global_consistency.find((item) => item.from === epoch + 1 && item.to === epoch + 2);
    const a = checkpoints.get(epoch);
    const b = checkpoints.get(epoch + 1);
    if (link === undefined || a === undefined || b === undefined || !refVerifyConsistency(a.size, b.size, a.root, b.root, link.proof.map(bytes))) {
      errors.push(`global_consistency:${String(epoch + 1)}`);
    }
  }
  const leaves: Buffer[] = [];
  bundle.leaves.forEach((entry, index) => {
    const parsed = JSON.parse(entry.leaf) as { seq: number; log: string };
    if (canonicalize(parsed) !== entry.leaf || parsed.seq !== bundle.start.size + index || parsed.log !== bundle.org.log) errors.push(`leaf:${String(entry.seq)}`);
    leaves.push(refLeafHash(Buffer.from(entry.leaf, 'utf8')));
  });
  const frontier = bundle.start.frontier.map((node) => ({ height: node.height, hash: bytes(node.hash) }));
  const roots = new Map<number, Buffer>();
  const headEpochs = new Map<number, { size: number }>();
  for (const head of bundle.heads) {
    if (head.epoch < from || head.epoch > to || headEpochs.has(head.epoch)) {
      errors.push(`head_range:${String(head.epoch)}`);
      continue;
    }
    headEpochs.set(head.epoch, head);
    let root: Buffer;
    try {
      root = rootAt(head.size, bundle.start.size, frontier, leaves);
    } catch {
      errors.push(`head_range:${String(head.epoch)}`);
      continue;
    }
    if (head.size > bundle.start.size + leaves.length) errors.push(`head_range:${String(head.epoch)}`);
    roots.set(head.size, root);
    if (!root.equals(bytes(head.root))) errors.push(`head_root:${String(head.epoch)}`);
    const epochRoot = epochRoots.get(head.epoch);
    const leaf = refLeafHash(Buffer.from(canonicalize({ epoch: head.epoch, log: bundle.org.log, size: head.size, root: head.root }) ?? '', 'utf8'));
    if (epochRoot === undefined || !refVerifyInclusion(head.position, head.epoch_size, leaf, head.epoch_proof.map(bytes), epochRoot)) errors.push(`head_epoch:${String(head.epoch)}`);
  }
  // 빠짐 — 1차와 같은 규칙을 다른 모양으로.
  if (bundle.start.size > 0 && headEpochs.get(from)?.size !== bundle.start.size) errors.push('start_head');
  if (bundle.leaves.length > 0 && !headEpochs.has(to)) errors.push('to_head');
  const firstHeadEpoch = Math.min(...headEpochs.keys());
  if (Number.isFinite(firstHeadEpoch)) {
    for (let epoch = firstHeadEpoch; epoch <= to; epoch += 1) if (!headEpochs.has(epoch)) errors.push(`head_missing:${String(epoch)}`);
  }
  // L1 — 창세 잎부터 싣는 번들: 첫 헤드 직전 에폭이 창세 전에(시계 차 5초 안) 닫혔는가.
  if (bundle.start.size === 0 && bundle.leaves.length > 0) {
    const genesis = JSON.parse((bundle.leaves[0] as { leaf: string }).leaf) as { kind: unknown; at: unknown };
    const genesisAt = typeof genesis.at === 'string' ? new Date(genesis.at.replace(/(\.\d{3})\d*Z$/, '$1Z')).getTime() : Number.NaN;
    if (genesis.kind !== 'org.genesis' || !Number.isFinite(genesisAt)) errors.push('org_genesis');
    else if (Number.isFinite(firstHeadEpoch) && firstHeadEpoch > 0) {
      const before = closedAt.get(firstHeadEpoch - 1);
      if (before === undefined) errors.push(`org_start_unproven:${String(firstHeadEpoch)}`);
      else if (before - genesisAt > 5000) errors.push(`org_start_hidden:${String(firstHeadEpoch)}`);
    }
  }
  // M2 — 신원 잎 도입 시각은 번들 안 어느 신원 잎보다도 뒤일 수 없다(여유 60초). 시각은 Date 로 본다(1차는 문자열 자르기).
  if (bundle.identity_since !== undefined && bundle.identity_since !== null) {
    const since = typeof bundle.identity_since === 'string' ? new Date(bundle.identity_since.replace(/(\.\d{3})\d*Z$/, '$1Z')).getTime() : Number.NaN;
    if (!Number.isFinite(since)) errors.push('identity_since');
    else {
      for (const entry of bundle.leaves) {
        const parsed = JSON.parse(entry.leaf) as { kind: unknown; at: unknown };
        if (typeof parsed.kind !== 'string' || !parsed.kind.startsWith('identity.') || typeof parsed.at !== 'string') continue;
        const at = new Date(parsed.at.replace(/(\.\d{3})\d*Z$/, '$1Z')).getTime();
        if (at + 60_000 < since) errors.push(`identity_since_after_leaf:${String(entry.seq)}`);
      }
    }
  }
  if (bundle.org_consistency !== null) {
    const a = roots.get(bundle.org_consistency.from_size);
    const b = roots.get(bundle.org_consistency.to_size);
    if (a === undefined || b === undefined || !refVerifyConsistency(bundle.org_consistency.from_size, bundle.org_consistency.to_size, a, b, bundle.org_consistency.proof.map(bytes))) {
      errors.push('org_consistency');
    }
  }
  return errors;
}

/**
 * 신원 변경 이력 블록(US-013 · `atmark-identity-blocks/v1`)의 **두 번째 구현** — 1차(`verifyIdentityBlocks`)와 부품을 바꿨다: JCS 는 `canonicalize`,
 * 잎 해시는 참조 구현(`refLeafHash`), 체인은 블록마다 **처음부터 다시** 접은 값과 대조한다(1차는 한 번 누적). 오류 코드 목록을 돌려준다.
 */
export function secondVerifyIdentityBlocks(file: { format?: unknown; agentId?: unknown; truncated?: unknown; blocks?: unknown; domains?: unknown }): string[] {
  const errors: string[] = [];
  if (file.format !== 'atmark-identity-blocks/v1' || typeof file.agentId !== 'string' || !Array.isArray(file.blocks)) return ['format'];
  const blocks = file.blocks as { seq?: unknown; leaf?: unknown; leafHash?: unknown; prevBlockHash?: unknown; blockHash?: unknown }[];
  const logs = new Set<string>();
  const leafHashes = blocks.map((block, index) => {
    if (typeof block.leaf !== 'string') {
      errors.push(`leaf:${String(index)}`);
      return Buffer.alloc(32);
    }
    let parsed: { kind?: unknown; seq?: unknown; body?: { agent_id?: unknown } } = {};
    try {
      parsed = JSON.parse(block.leaf) as typeof parsed;
    } catch {
      errors.push(`leaf_canonical:${String(index)}`);
    }
    if (canonicalize(parsed) !== block.leaf) errors.push(`leaf_canonical:${String(index)}`);
    if (typeof parsed.kind !== 'string' || !parsed.kind.startsWith('identity.')) errors.push(`kind:${String(index)}`);
    if (parsed.body?.agent_id !== file.agentId) errors.push(`agent:${String(index)}`);
    if (parsed.seq !== block.seq || (index > 0 && Number(parsed.seq) <= Number(blocks[index - 1]?.seq))) errors.push(`order:${String(index)}`);
    logs.add(String((parsed as { log?: unknown }).log));
    const hash = refLeafHash(Buffer.from(block.leaf, 'utf8'));
    if (hash.toString('hex') !== block.leafHash) errors.push(`leaf_hash:${String(index)}`);
    return hash;
  });
  // 블록 i 의 해시 = SHA-256(블록 i-1 의 해시 ‖ 잎 i). 첫 블록의 앞은 0×32(잘린 파일이면 파일의 값).
  const first = blocks[0];
  const genesis = file.truncated === true && typeof first?.prevBlockHash === 'string' ? bytes(first.prevBlockHash) : Buffer.alloc(32);
  const chainAt = (index: number): Buffer => {
    let hash = genesis;
    for (let i = 0; i <= index; i += 1) hash = createHash('sha256').update(hash).update(leafHashes[i] as Buffer).digest();
    return hash;
  };
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index] as { prevBlockHash?: unknown; blockHash?: unknown };
    if (block.blockHash !== chainAt(index).toString('hex')) errors.push(`block_hash:${String(index)}`);
    const expectedPrev = index === 0 ? genesis : chainAt(index - 1);
    if (block.prevBlockHash !== expectedPrev.toString('hex')) errors.push(`prev:${String(index)}`);
  }
  // 판 5 — 고객 도메인 사건(체인 밖): `domain.status` 종류 · JCS · 잎 해시 · 같은 로그.
  if (file.domains !== undefined && !Array.isArray(file.domains)) errors.push('domains');
  ((Array.isArray(file.domains) ? file.domains : []) as { leaf?: unknown; leafHash?: unknown }[]).forEach((entry, index) => {
    if (typeof entry.leaf !== 'string') {
      errors.push(`domain_leaf:${String(index)}`);
      return;
    }
    let parsed: { kind?: unknown; log?: unknown } = {};
    try {
      parsed = JSON.parse(entry.leaf) as typeof parsed;
    } catch {
      errors.push(`domain_canonical:${String(index)}`);
    }
    if (canonicalize(parsed) !== entry.leaf) errors.push(`domain_canonical:${String(index)}`);
    if (parsed.kind !== 'domain.status') errors.push(`domain_kind:${String(index)}`);
    logs.add(String(parsed.log));
    if (refLeafHash(Buffer.from(entry.leaf, 'utf8')).toString('hex') !== entry.leafHash) errors.push(`domain_leaf_hash:${String(index)}`);
  });
  // M4 — 한 에이전트의 블록은 한 조직 로그의 잎이다.
  if (logs.size > 1) errors.push('log_mixed');
  return errors;
}

/**
 * 신원 블록 파일의 **포함 증명**(M4 — `?proofs=1`)을 두 번째 부품으로 본다: 공통 닻의 체크포인트를 `@noble/ed25519` 로(고정한 vkey), 전역 잎·에폭
 * 트리·블록 잎 포함을 참조 구현(`refVerifyInclusion`)으로. 모든 블록이 증명되지 않으면 `unproven:<i>` — 1차의 `assurance: proven` 과 같은 판정.
 */
export async function secondVerifyIdentityBlockProofs(
  file: { blocks?: unknown; proof?: unknown },
  vkey: string,
  origin = 'id.atmark.ai/log/v1',
): Promise<string[]> {
  const errors: string[] = [];
  const anchor = file.proof as
    | {
        checkpoint: string;
        org: { log: string; epoch: number; treeSize: number; root: string };
        epochTree: { position: number; size: number; epochRoot: string; proof: string[] };
        global: { index: number; globalLeaf: string; proof: string[] };
      }
    | null
    | undefined;
  if (anchor === null || anchor === undefined || !Array.isArray(file.blocks)) return ['no_proof'];
  const opened = await openCheckpoint(anchor.checkpoint, vkey, origin);
  if (opened === null || opened.size !== anchor.org.epoch + 1) return ['checkpoint'];
  const globalLeaf = JSON.parse(anchor.global.globalLeaf) as { epoch_root?: unknown; epoch?: unknown };
  if (canonicalize(globalLeaf) !== anchor.global.globalLeaf || globalLeaf.epoch !== anchor.org.epoch || globalLeaf.epoch_root !== anchor.epochTree.epochRoot) errors.push('global_leaf');
  if (!refVerifyInclusion(anchor.global.index, opened.size, refLeafHash(Buffer.from(anchor.global.globalLeaf, 'utf8')), anchor.global.proof.map(bytes), opened.root)) {
    errors.push('global_inclusion');
  }
  const head = refLeafHash(Buffer.from(canonicalize({ epoch: anchor.org.epoch, log: anchor.org.log, size: anchor.org.treeSize, root: anchor.org.root }) ?? '', 'utf8'));
  if (!refVerifyInclusion(anchor.epochTree.position, anchor.epochTree.size, head, anchor.epochTree.proof.map(bytes), bytes(anchor.epochTree.epochRoot))) errors.push('head_epoch');
  (file.blocks as { seq?: unknown; leaf?: unknown; inclusion?: unknown }[]).forEach((block, index) => {
    if (typeof block.leaf !== 'string' || typeof block.seq !== 'number' || !Array.isArray(block.inclusion)) {
      errors.push(`unproven:${String(index)}`);
      return;
    }
    const leafLog = (JSON.parse(block.leaf) as { log?: unknown }).log;
    const ok =
      leafLog === anchor.org.log &&
      block.seq < anchor.org.treeSize &&
      refVerifyInclusion(block.seq, anchor.org.treeSize, refLeafHash(Buffer.from(block.leaf, 'utf8')), (block.inclusion as string[]).map(bytes), bytes(anchor.org.root));
    if (!ok) errors.push(`inclusion:${String(index)}`);
  });
  return errors;
}
