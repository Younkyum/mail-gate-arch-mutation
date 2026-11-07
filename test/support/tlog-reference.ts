/**
 * test/support/tlog-reference.ts — **참조 머클 구현**(ADR-0008 A-T1 · R15 "우리 코드로 우리를 통과시키지 않는다").
 *
 * `src/tlog/merkle.ts` 와 **다른 알고리즘**으로 같은 성질을 계산한다 — `src/**` 를 import 하지 않는다(arch 테스트).
 *   - 루트: RFC 9162 §2.1.1 재귀 정의를 **비트 길이로 분할점을 구하는** 형태로 옮긴 것(`src` 는 스택 접기).
 *   - 포함·일관성 검증: transparency-dev `merkle/proof` 의 inner/border 분해(Go `proof.VerifyInclusion` · `VerifyConsistency` 를
 *     옮김 — `src` 는 RFC 9162 §2.1.3.2·§2.1.4.2 의 fn/sn 비트 연산).
 *   - 증명 생성: 완전 이진 레벨 표를 만들어 형제 노드를 모은다(재귀 정의가 아니다).
 */

import { createHash } from 'node:crypto';

export function refSha256(...parts: readonly Uint8Array[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export const refLeafHash = (data: Uint8Array): Buffer => refSha256(Buffer.from([0]), data);
export const refNodeHash = (left: Uint8Array, right: Uint8Array): Buffer => refSha256(Buffer.from([1]), left, right);

function bitLength(value: number): number {
  return value === 0 ? 0 : Math.floor(Math.log2(value)) + 1;
}

/** MTH — k = 2^(bitlen(n-1)-1). */
export function refRoot(leaves: readonly Uint8Array[]): Buffer {
  if (leaves.length === 0) return refSha256();
  if (leaves.length === 1) return Buffer.from(leaves[0] as Uint8Array);
  const k = 2 ** (bitLength(leaves.length - 1) - 1);
  return refNodeHash(refRoot(leaves.slice(0, k)), refRoot(leaves.slice(k)));
}

function trailingZeros(value: bigint): number {
  if (value === 0n) return 64;
  let count = 0;
  let rest = value;
  while ((rest & 1n) === 0n) {
    rest >>= 1n;
    count += 1;
  }
  return count;
}

function onesCount(value: bigint): number {
  let count = 0;
  let rest = value;
  while (rest > 0n) {
    count += Number(rest & 1n);
    rest >>= 1n;
  }
  return count;
}

function bitLen64(value: bigint): number {
  let count = 0;
  let rest = value;
  while (rest > 0n) {
    rest >>= 1n;
    count += 1;
  }
  return count;
}

function decompInclProof(index: bigint, size: bigint): [number, number] {
  const inner = bitLen64(index ^ (size - 1n));
  const border = onesCount(index >> BigInt(inner));
  return [inner, border];
}

function chainInner(seed: Buffer, proof: readonly Uint8Array[], index: bigint): Buffer {
  let out = seed;
  proof.forEach((hash, i) => {
    out = ((index >> BigInt(i)) & 1n) === 0n ? refNodeHash(out, hash) : refNodeHash(hash, out);
  });
  return out;
}

function chainInnerRight(seed: Buffer, proof: readonly Uint8Array[], index: bigint): Buffer {
  let out = seed;
  proof.forEach((hash, i) => {
    if (((index >> BigInt(i)) & 1n) === 1n) out = refNodeHash(hash, out);
  });
  return out;
}

function chainBorderRight(seed: Buffer, proof: readonly Uint8Array[]): Buffer {
  let out = seed;
  for (const hash of proof) out = refNodeHash(hash, out);
  return out;
}

export function refVerifyInclusion(index: number, size: number, leaf: Uint8Array, proof: readonly Uint8Array[], root: Uint8Array): boolean {
  if (index < 0 || index >= size) return false;
  const [inner, border] = decompInclProof(BigInt(index), BigInt(size));
  if (proof.length !== inner + border) return false;
  const computed = chainBorderRight(chainInner(Buffer.from(leaf), proof.slice(0, inner), BigInt(index)), proof.slice(inner));
  return computed.equals(Buffer.from(root));
}

export function refVerifyConsistency(size1: number, size2: number, root1: Uint8Array, root2: Uint8Array, proof: readonly Uint8Array[]): boolean {
  if (size2 < size1) return false;
  if (size1 === size2) return proof.length === 0 && Buffer.from(root1).equals(Buffer.from(root2));
  if (size1 === 0) return proof.length === 0;
  if (proof.length === 0) return false;
  let [inner, border] = decompInclProof(BigInt(size1 - 1), BigInt(size2));
  const shift = trailingZeros(BigInt(size1));
  inner -= shift;
  let seed: Buffer;
  let start: number;
  if (size1 === 2 ** shift) {
    seed = Buffer.from(root1);
    start = 0;
  } else {
    seed = Buffer.from(proof[0] as Uint8Array);
    start = 1;
  }
  if (proof.length !== start + inner + border) return false;
  const rest = proof.slice(start);
  const mask = BigInt(size1 - 1) >> BigInt(shift);
  const hash1 = chainBorderRight(chainInnerRight(seed, rest.slice(0, inner), mask), rest.slice(inner));
  if (!hash1.equals(Buffer.from(root1))) return false;
  const hash2 = chainBorderRight(chainInner(seed, rest.slice(0, inner), mask), rest.slice(inner));
  return hash2.equals(Buffer.from(root2));
}

/** 포함 증명 생성 — 재귀 분할(PATH)과 같은 결과여야 하지만 계산 경로가 다르다: 분할점을 비트 길이로 구하고 슬라이스로 내려간다. */
export function refInclusionProof(leaves: readonly Uint8Array[], index: number): Buffer[] {
  if (leaves.length <= 1) return [];
  const k = 2 ** (bitLength(leaves.length - 1) - 1);
  if (index < k) return [...refInclusionProof(leaves.slice(0, k), index), refRoot(leaves.slice(k))];
  return [...refInclusionProof(leaves.slice(k), index - k), refRoot(leaves.slice(0, k))];
}

export function refConsistencyProof(leaves: readonly Uint8Array[], first: number): Buffer[] {
  if (first === 0 || first === leaves.length) return [];
  const sub = (m: number, part: readonly Uint8Array[], complete: boolean): Buffer[] => {
    if (m === part.length) return complete ? [] : [refRoot(part)];
    const k = 2 ** (bitLength(part.length - 1) - 1);
    if (m <= k) return [...sub(m, part.slice(0, k), complete), refRoot(part.slice(k))];
    return [...sub(m - k, part.slice(k), false), refRoot(part.slice(0, k))];
  };
  return sub(first, leaves, true);
}
