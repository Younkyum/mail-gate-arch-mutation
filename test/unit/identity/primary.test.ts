/**
 * 대표 주소 포인터 모델 · 앵커 이름 비충돌(ADR-0014 2026-10 개정) — 순수 부분.
 *   ① 앵커 이름: `ax--` + base32 소문자 20자 · **속성 테스트**(대량 생성 — 형식 · 무충돌) · 에이전트 id 와 무관(같은 입력에도 다르다).
 *   ② 사용자 입력 `ax--…` 은 형식 오류(`invalid_character` — "사용 중" 이 아니다) · 모든 도메인 · 접두사 상수 = 계약.
 *   ③ `effectivePrimaryOf` 표 · `anchorDormantOf`. DB 와의 대조(TS = SQL)는 `test/integration/domains/primary-pointer.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { ANCHOR_LOCAL_PART_PATTERN, ANCHOR_LOCAL_PART_PREFIX, ANCHOR_RANDOM_LENGTH, type PrimaryFacts } from '../../../src/domains/contract';
import { AGENT_LOCAL_PART_MAX_LENGTH, AGENT_LOCAL_PART_PATTERN, AgentAddressError, ANCHOR_NAMESPACE_PREFIX, buildAgentAddress } from '../../../src/identity/address';
import { anchorDormantOf, effectivePrimaryOf, generateAnchorLocalPart, isAnchorLocalPart } from '../../../src/identity/primary';

describe('① 앵커 이름', () => {
  it('속성 — 20,000개: 모두 `ax--[a-z2-7]{20}` · 에이전트 로컬파트 문법 안 · 서로 다르다', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) {
      const local = generateAnchorLocalPart();
      expect(local).toMatch(ANCHOR_LOCAL_PART_PATTERN);
      expect(local.length).toBe(ANCHOR_LOCAL_PART_PREFIX.length + ANCHOR_RANDOM_LENGTH);
      expect(local.length).toBeLessThanOrEqual(AGENT_LOCAL_PART_MAX_LENGTH);
      expect(AGENT_LOCAL_PART_PATTERN.test(local)).toBe(true);
      seen.add(local);
    }
    expect(seen.size).toBe(20_000);
  });

  it('난수 원천의 비트를 그대로 base32 로(앞 100비트) — 알파벳 32자를 모두 쓴다 · 0 바이트 = a…', () => {
    expect(generateAnchorLocalPart((size) => new Uint8Array(size))).toBe(`ax--${'a'.repeat(20)}`);
    expect(generateAnchorLocalPart((size) => new Uint8Array(size).fill(0xff))).toBe(`ax--${'7'.repeat(20)}`);
    const letters = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) for (const c of generateAnchorLocalPart().slice(4)) letters.add(c);
    expect([...letters].sort().join('')).toBe('234567abcdefghijklmnopqrstuvwxyz');
    expect(isAnchorLocalPart('ax--abcdefghijklmnopqrst')).toBe(true);
    expect(isAnchorLocalPart('ax--abcdefghijklmnopqrs1')).toBe(false); // 1 은 base32 가 아니다
  });
});

describe('② 사용자 입력 ax-- 은 형식 오류', () => {
  it('모든 도메인 · 대소문자 · 그 밖의 `ax-` · `xax--` 는 그대로 된다', () => {
    expect(ANCHOR_NAMESPACE_PREFIX).toBe(ANCHOR_LOCAL_PART_PREFIX);
    for (const [local, domain] of [
      ['ax--abcdefghijklmnopqrst', 'atmark.ai'],
      ['AX--mine', 'atmark.ai'],
      ['ax--x', 'agents.example.com'],
    ] as const) {
      let caught: unknown;
      try {
        buildAgentAddress(local, domain);
      } catch (error) {
        caught = error;
      }
      expect(caught, local).toBeInstanceOf(AgentAddressError);
      expect((caught as AgentAddressError).reason).toBe('invalid_character');
    }
    expect(buildAgentAddress('ax-mine')).toBe('ax-mine@atmark.ai');
    expect(buildAgentAddress('max--a')).toBe('max--a@atmark.ai');
  });
});

describe('③ 유효 대표 판정(TS 거울)', () => {
  const anchor = { id: 'anchor', address: 'ax--abcdefghijklmnopqrst@atmark.ai' };
  const custom = (patch: Partial<NonNullable<PrimaryFacts['target']>> = {}): PrimaryFacts['target'] => ({
    address: 'bob@agents.example.com',
    domain: 'agents.example.com',
    retired: false,
    domainStatuses: ['verified'],
    ...patch,
  });

  it.each([
    ['선택 없음 → 앵커', { anchor, lastChoice: null, target: null }, anchor.address],
    ['앵커 선택 → 앵커', { anchor, lastChoice: { addressId: 'anchor' }, target: null }, anchor.address],
    ['verified 고객 선택 → 그 주소', { anchor, lastChoice: { addressId: 'c' }, target: custom() }, 'bob@agents.example.com'],
    ['suspended 도 그 주소(관문이 막는다)', { anchor, lastChoice: { addressId: 'c' }, target: custom({ domainStatuses: ['removed', 'suspended'] }) }, 'bob@agents.example.com'],
    ['폐기된 선택 → NULL(주소 없음)', { anchor, lastChoice: { addressId: 'c' }, target: custom({ retired: true }) }, null],
    ['도메인 removed → NULL', { anchor, lastChoice: { addressId: 'c' }, target: custom({ domainStatuses: ['removed'] }) }, null],
    ['도메인 행 없음 → NULL', { anchor, lastChoice: { addressId: 'c' }, target: custom({ domainStatuses: [] }) }, null],
    ['가리키는 행이 없다 → NULL', { anchor, lastChoice: { addressId: 'c' }, target: null }, null],
    ['atmark.ai 선택(가드가 막지만) → 그 주소', { anchor, lastChoice: { addressId: 'c' }, target: custom({ address: 'x@atmark.ai', domain: 'atmark.ai', domainStatuses: [] }) }, 'x@atmark.ai'],
  ] as const)('%s', (_label, facts, expected) => {
    expect(effectivePrimaryOf(facts as PrimaryFacts)).toBe(expected);
  });

  it('잠든 앵커 = 마지막 선택이 앵커가 아니다(그 선택이 무효가 돼도 깨지 않는다)', () => {
    expect(anchorDormantOf({ anchor, lastChoice: null })).toBe(false);
    expect(anchorDormantOf({ anchor, lastChoice: { addressId: 'anchor' } })).toBe(false);
    expect(anchorDormantOf({ anchor, lastChoice: { addressId: 'c' } })).toBe(true);
  });
});
