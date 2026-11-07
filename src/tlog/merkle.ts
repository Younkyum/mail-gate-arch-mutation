/**
 * src/tlog/merkle.ts — **RFC 9162 머클 트리**(Certificate Transparency 2.0 §2.1) — ADR-0008 §2.2.
 *
 *   leaf_hash = SHA-256(0x00 ‖ data)          — §2.1.1 (두 번째 원상 공격을 막는 접두사)
 *   node_hash = SHA-256(0x01 ‖ left ‖ right)
 *   MTH({})   = SHA-256("")
 *   MTH(D[n]) = node_hash(MTH(D[0:k]), MTH(D[k:n])), k = n 보다 작은 가장 큰 2의 거듭제곱
 *
 * 생성(포함 증명 PATH · 일관성 증명 PROOF)은 §2.1.3.1 · §2.1.4.1 의 재귀 정의를 그대로 옮겼고, 검증은 §2.1.3.2 · §2.1.4.2 의
 * 비트 연산 알고리즘이다. **같은 성질을 다른 알고리즘으로** 보는 참조 구현(transparency-dev 식 inner/border 분해)이
 * `test/support/tlog-reference.ts` 에 있고, 차분 테스트(A-T1)가 둘을 대조한다 — 우리 코드로 우리를 통과시키지 않는다(R15).
 *
 * 접두사 두 바이트는 **형식의 일부다** — 바꾸면 발급된 모든 체크포인트가 검증 불가가 된다(변이 `K-leaf-prefix-changed`).
 */

import { createHash } from 'node:crypto';

/** RFC 9162 §2.1.1 — 잎 해시 접두사. */
export const LEAF_HASH_PREFIX = 0x00;
/** RFC 9162 §2.1.1 — 내부 노드 해시 접두사. */
export const NODE_HASH_PREFIX = 0x01;

export function sha256(...parts: readonly Uint8Array[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export function leafHash(data: Uint8Array): Buffer {
  return sha256(Uint8Array.of(LEAF_HASH_PREFIX), data);
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Buffer {
  return sha256(Uint8Array.of(NODE_HASH_PREFIX), left, right);
}

/** MTH({}) — 빈 트리의 루트. */
export function emptyRoot(): Buffer {
  return sha256();
}

/** n 보다 작은 가장 큰 2의 거듭제곱(n ≥ 2). */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function assertSize(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} 는 0 이상의 안전한 정수여야 한다`);
}

/** MTH(D[start:end]) — 재귀 정의(§2.1.1). */
export function subtreeRoot(leaves: readonly Uint8Array[], start: number, end: number): Buffer {
  const n = end - start;
  if (n === 0) return emptyRoot();
  if (n === 1) return Buffer.from(leaves[start] as Uint8Array);
  const k = splitPoint(n);
  return nodeHash(subtreeRoot(leaves, start, start + k), subtreeRoot(leaves, start + k, end));
}

/**
 * 잎 해시 목록의 루트 — 스택(compact range)으로 O(n) 에 계산한다. `subtreeRoot` 와 같은 값이어야 한다(단위 테스트).
 * 크기 n 의 트리는 n 의 이진 표현대로 완전 부분 트리들로 쪼개지고, 루트는 그것들을 오른쪽부터 접은 것이다.
 */
export function rootOf(leafHashes: readonly Uint8Array[], size: number = leafHashes.length): Buffer {
  assertSize(size, 'size');
  if (size > leafHashes.length) throw new RangeError('size 가 잎 수보다 크다');
  if (size === 0) return emptyRoot();
  return rootFromFrontier(frontierOf(leafHashes, size));
}

/** 완전 부분 트리 하나 — 높이(잎 2^height 개)와 해시. */
export interface FrontierNode {
  readonly height: number;
  readonly hash: Buffer;
}

/**
 * 크기 `size` 트리의 **오른쪽 가장자리**(compact range [0, size)) — 왼쪽부터 큰 완전 부분 트리 순서. 증명 번들이 범위의
 * 시작 크기를 이것으로 넘기면, 검증기는 이어지는 잎을 붙여 뒤의 모든 헤드를 다시 계산한다(`appendToFrontier`).
 */
export function frontierOf(leafHashes: readonly Uint8Array[], size: number = leafHashes.length): FrontierNode[] {
  assertSize(size, 'size');
  const stack: FrontierNode[] = [];
  for (let index = 0; index < size; index += 1) appendToFrontier(stack, leafHashes[index] as Uint8Array);
  return stack;
}

/** 잎 하나를 붙인다(제자리). 높이가 같은 이웃 둘은 하나로 합친다. */
export function appendToFrontier(stack: FrontierNode[], leaf: Uint8Array): void {
  let node: FrontierNode = { height: 0, hash: Buffer.from(leaf) };
  for (;;) {
    const top = stack.at(-1);
    if (top === undefined || top.height !== node.height) break;
    stack.pop();
    node = { height: node.height + 1, hash: nodeHash(top.hash, node.hash) };
  }
  stack.push(node);
}

/** 가장자리 → 루트(오른쪽부터 접는다). 빈 가장자리 = 빈 트리. */
export function rootFromFrontier(stack: readonly FrontierNode[]): Buffer {
  if (stack.length === 0) return emptyRoot();
  let accumulator = (stack.at(-1) as FrontierNode).hash;
  for (let index = stack.length - 2; index >= 0; index -= 1) accumulator = nodeHash((stack[index] as FrontierNode).hash, accumulator);
  return accumulator;
}

/** PATH(m, D[n]) — §2.1.3.1. `index` 번째 잎의 포함 증명(아래에서 위 순서). */
export function inclusionProof(leafHashes: readonly Uint8Array[], index: number, size: number = leafHashes.length): Buffer[] {
  assertSize(index, 'index');
  assertSize(size, 'size');
  if (size > leafHashes.length) throw new RangeError('size 가 잎 수보다 크다');
  if (index >= size) throw new RangeError('index 가 트리 밖이다');
  const path = (m: number, start: number, end: number): Buffer[] => {
    const n = end - start;
    if (n <= 1) return [];
    const k = splitPoint(n);
    if (m < k) return [...path(m, start, start + k), subtreeRoot(leafHashes, start + k, end)];
    return [...path(m - k, start + k, end), subtreeRoot(leafHashes, start, start + k)];
  };
  return path(index, 0, size);
}

/**
 * 같은 트리(크기 `size`)의 포함 증명 여럿 — `inclusionProof` 와 같은 PATH 이지만 부분 트리 루트를 **한 번씩만** 계산한다(메모). 신원 블록
 * API 가 블록마다 증명을 실을 때 쓴다: 증명 k 개가 O(k·N) 이 아니라 O(N + k·log N).
 */
export function inclusionProofs(leafHashes: readonly Uint8Array[], indices: readonly number[], size: number = leafHashes.length): Buffer[][] {
  assertSize(size, 'size');
  if (size > leafHashes.length) throw new RangeError('size 가 잎 수보다 크다');
  const memo = new Map<string, Buffer>();
  const root = (start: number, end: number): Buffer => {
    const n = end - start;
    if (n === 1) return Buffer.from(leafHashes[start] as Uint8Array);
    const key = `${String(start)}:${String(end)}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const k = splitPoint(n);
    const value = nodeHash(root(start, start + k), root(start + k, end));
    memo.set(key, value);
    return value;
  };
  const path = (m: number, start: number, end: number): Buffer[] => {
    const n = end - start;
    if (n <= 1) return [];
    const k = splitPoint(n);
    if (m < k) return [...path(m, start, start + k), root(start + k, end)];
    return [...path(m - k, start + k, end), root(start, start + k)];
  };
  return indices.map((index) => {
    assertSize(index, 'index');
    if (index >= size) throw new RangeError('index 가 트리 밖이다');
    return path(index, 0, size);
  });
}

/** PROOF(m, D[n]) — §2.1.4.1. 크기 `first` 트리가 크기 `second` 트리의 접두임을 보이는 증명. */
export function consistencyProof(leafHashes: readonly Uint8Array[], first: number, second: number = leafHashes.length): Buffer[] {
  assertSize(first, 'first');
  assertSize(second, 'second');
  if (second > leafHashes.length) throw new RangeError('second 가 잎 수보다 크다');
  if (first > second) throw new RangeError('first 가 second 보다 크다');
  if (first === 0 || first === second) return [];
  const subproof = (m: number, start: number, end: number, complete: boolean): Buffer[] => {
    const n = end - start;
    if (m === n) return complete ? [] : [subtreeRoot(leafHashes, start, end)];
    const k = splitPoint(n);
    if (m <= k) return [...subproof(m, start, start + k, complete), subtreeRoot(leafHashes, start + k, end)];
    return [...subproof(m - k, start + k, end, false), subtreeRoot(leafHashes, start, start + k)];
  };
  return subproof(first, 0, second, true);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/** 포함 증명 → 루트(§2.1.3.2). 모양이 틀리면 `null`. */
export function rootFromInclusionProof(index: number, size: number, leaf: Uint8Array, proof: readonly Uint8Array[]): Buffer | null {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size) return null;
  let fn = BigInt(index);
  let sn = BigInt(size - 1);
  let r: Buffer = Buffer.from(leaf);
  for (const p of proof) {
    if (sn === 0n) return null;
    if ((fn & 1n) === 1n || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1n) === 0n) {
        while ((fn & 1n) === 0n && fn !== 0n) {
          fn >>= 1n;
          sn >>= 1n;
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n ? r : null;
}

export function verifyInclusion(index: number, size: number, leaf: Uint8Array, proof: readonly Uint8Array[], root: Uint8Array): boolean {
  const computed = rootFromInclusionProof(index, size, leaf, proof);
  return computed !== null && equalBytes(computed, root);
}

/** 일관성 증명 검증(§2.1.4.2). first = 0 은 증명이 비어 있을 때만, first = second 는 증명이 비고 루트가 같을 때만 참. */
export function verifyConsistency(
  first: number,
  second: number,
  firstRoot: Uint8Array,
  secondRoot: Uint8Array,
  proof: readonly Uint8Array[],
): boolean {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first < 0 || first > second) return false;
  if (first === second) return proof.length === 0 && equalBytes(firstRoot, secondRoot);
  if (first === 0) return proof.length === 0;
  const path: Uint8Array[] = [...proof];
  if ((first & (first - 1)) === 0) path.unshift(firstRoot);
  if (path.length === 0) return false;
  let fn = BigInt(first - 1);
  let sn = BigInt(second - 1);
  while ((fn & 1n) === 1n) {
    fn >>= 1n;
    sn >>= 1n;
  }
  let fr: Buffer = Buffer.from(path[0] as Uint8Array);
  let sr: Buffer = Buffer.from(path[0] as Uint8Array);
  for (const c of path.slice(1)) {
    if (sn === 0n) return false;
    if ((fn & 1n) === 1n || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if ((fn & 1n) === 0n) {
        while ((fn & 1n) === 0n && fn !== 0n) {
          fn >>= 1n;
          sn >>= 1n;
        }
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return equalBytes(fr, firstRoot) && equalBytes(sr, secondRoot) && sn === 0n;
}
