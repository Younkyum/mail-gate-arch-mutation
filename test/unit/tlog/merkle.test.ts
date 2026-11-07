/**
 * A-T1 머클 정합 — `src/tlog/merkle.ts` 를 **다른 알고리즘의 참조 구현**(`test/support/tlog-reference.ts`, transparency-dev 식)과
 * 차분 비교한다. 크기 1~2¹² 에서 무작위 표본 + 경계(2의 거듭제곱 ± 1)의 모든 i<j 쌍 일부.
 */

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  appendToFrontier,
  consistencyProof,
  emptyRoot,
  frontierOf,
  inclusionProof,
  inclusionProofs,
  leafHash,
  nodeHash,
  rootFromFrontier,
  rootOf,
  subtreeRoot,
  verifyConsistency,
  verifyInclusion,
} from '../../../src/tlog/merkle';
import {
  refConsistencyProof,
  refInclusionProof,
  refLeafHash,
  refNodeHash,
  refRoot,
  refSha256,
  refVerifyConsistency,
  refVerifyInclusion,
} from '../../support/tlog-reference';

const leavesOf = (n: number): Buffer[] => Array.from({ length: n }, (_, i) => leafHash(Buffer.from(`leaf-${String(i)}`)));

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('RFC 9162 해시 규칙', () => {
  it('잎 0x00 · 노드 0x01 접두사 · 빈 트리 = SHA-256("")', () => {
    const data = Buffer.from('atmark');
    expect(leafHash(data)).toEqual(refSha256(Buffer.from([0x00]), data));
    expect(leafHash(data)).toEqual(refLeafHash(data));
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(nodeHash(a, b)).toEqual(refSha256(Buffer.from([0x01]), a, b));
    expect(nodeHash(a, b)).toEqual(refNodeHash(a, b));
    expect(emptyRoot().toString('hex')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('RFC 6962 테스트 벡터(잎 8개, 빈 잎 포함)의 루트와 같다', () => {
    // certificate-transparency-go / transparency-dev 의 표준 벡터.
    const inputs = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'].map((hex) => Buffer.from(hex, 'hex'));
    const hashes = inputs.map(leafHash);
    expect(rootOf(hashes).toString('hex')).toBe('5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328');
    expect(rootOf(hashes, 1).toString('hex')).toBe('6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d');
    expect(rootOf(hashes, 3).toString('hex')).toBe('aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77');
  });
});

describe('A-T1 — 루트·증명이 참조 구현과 일치한다', () => {
  const sizes = [1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 100, 255, 256, 257, 1000, 1023, 1024, 1025, 4095, 4096];
  const random = rng(20260924);
  for (let i = 0; i < 12; i += 1) sizes.push(1 + Math.floor(random() * 4096));

  it('루트: 스택 접기 = 재귀 정의 = 참조(비트 길이 분할)', () => {
    const all = leavesOf(4096);
    for (const n of sizes) {
      const leaves = all.slice(0, n);
      const expected = refRoot(leaves);
      expect(rootOf(leaves)).toEqual(expected);
      expect(subtreeRoot(leaves, 0, n)).toEqual(expected);
      expect(rootFromFrontier(frontierOf(leaves))).toEqual(expected);
    }
  });

  it('포함 증명: 생성이 같고, 두 검증기가 둘 다 받고, 1바이트 변조는 둘 다 거부한다', () => {
    const all = leavesOf(4096);
    for (const n of sizes) {
      const leaves = all.slice(0, n);
      const root = rootOf(leaves);
      const indices = new Set([0, n - 1, Math.floor(n / 2), Math.floor(random() * n)]);
      // 여러 증명을 한 번에(메모 — 신원 블록 API) = 하나씩 만든 것.
      expect(inclusionProofs(leaves, [...indices])).toEqual([...indices].map((index) => refInclusionProof(leaves, index)));
      for (const index of indices) {
        const proof = inclusionProof(leaves, index);
        expect(proof).toEqual(refInclusionProof(leaves, index));
        const leaf = leaves[index] as Buffer;
        expect(verifyInclusion(index, n, leaf, proof, root)).toBe(true);
        expect(refVerifyInclusion(index, n, leaf, proof, root)).toBe(true);
        const badLeaf = Buffer.from(leaf);
        badLeaf[0] = (badLeaf[0] as number) ^ 1;
        expect(verifyInclusion(index, n, badLeaf, proof, root)).toBe(false);
        expect(refVerifyInclusion(index, n, badLeaf, proof, root)).toBe(false);
        if (proof.length > 0) {
          const badProof = proof.map((hash) => Buffer.from(hash));
          (badProof[0] as Buffer)[31] = ((badProof[0] as Buffer)[31] as number) ^ 0x80;
          expect(verifyInclusion(index, n, leaf, badProof, root)).toBe(false);
          expect(refVerifyInclusion(index, n, leaf, badProof, root)).toBe(false);
        }
        // 다른 위치·다른 크기로는 통과하지 않는다.
        if (n > 1) expect(verifyInclusion((index + 1) % n, n, leaf, proof, root)).toBe(false);
      }
    }
  });

  it('일관성 증명: 모든 경계 쌍 + 무작위 i<j — 생성 일치 · 두 검증기 통과 · 되감은 루트는 둘 다 거부', () => {
    const all = leavesOf(1100);
    const pairs: [number, number][] = [];
    const edges = [1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 31, 32, 33, 64, 65, 255, 256, 257, 1024, 1025];
    for (const a of edges) for (const b of edges) if (a < b) pairs.push([a, b]);
    for (let i = 0; i < 60; i += 1) {
      const b = 2 + Math.floor(random() * 1098);
      pairs.push([1 + Math.floor(random() * (b - 1)), b]);
    }
    for (const [m, n] of pairs) {
      const leaves = all.slice(0, n);
      const rootM = rootOf(leaves, m);
      const rootN = rootOf(leaves);
      const proof = consistencyProof(leaves, m);
      expect(proof).toEqual(refConsistencyProof(leaves, m));
      expect(verifyConsistency(m, n, rootM, rootN, proof)).toBe(true);
      expect(refVerifyConsistency(m, n, rootM, rootN, proof)).toBe(true);
      // 과거를 고친 트리(첫 잎 변조)의 루트는 옛 루트와 일관되지 않는다.
      const forked = [...leaves];
      forked[0] = leafHash(Buffer.from('rewritten'));
      const forkedProof = consistencyProof(forked, m);
      const forkedRoot = rootOf(forked);
      expect(verifyConsistency(m, n, rootM, forkedRoot, forkedProof)).toBe(false);
      expect(refVerifyConsistency(m, n, rootM, forkedRoot, forkedProof)).toBe(false);
    }
  });

  it('같은 크기·0 크기의 일관성 경계', () => {
    const leaves = leavesOf(5);
    const root = rootOf(leaves);
    expect(verifyConsistency(5, 5, root, root, [])).toBe(true);
    expect(verifyConsistency(5, 5, root, rootOf(leaves, 4), [])).toBe(false);
    expect(verifyConsistency(0, 5, emptyRoot(), root, [])).toBe(true);
    expect(verifyConsistency(0, 5, emptyRoot(), root, [root])).toBe(false);
    expect(verifyConsistency(6, 5, root, root, [])).toBe(false);
  });

  it('가장자리(frontier)에 잎을 이어 붙이면 모든 중간 루트가 재계산된다', () => {
    const leaves = leavesOf(300);
    const stack = frontierOf(leaves, 37);
    for (let size = 38; size <= 300; size += 1) {
      appendToFrontier(stack, leaves[size - 1] as Buffer);
      expect(rootFromFrontier(stack)).toEqual(refRoot(leaves.slice(0, size)));
    }
  });
});
