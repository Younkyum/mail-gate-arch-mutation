/**
 * JCS(RFC 8785) — `src/passport/jcs.ts` 와 외부 구현 `canonicalize`(RFC 8785 저자의 구현)의 **차분 테스트**.
 *
 * 해시·서명 대상 바이트를 만드는 함수라, 외부 구현과 한 바이트라도 다르면 제3자가 content_hash 를 재계산할 수 없다(ADR-0003 B1).
 *   ① 고정 사례(수 표기·키 정렬·이스케이프)에서 바이트가 같다.
 *   ② 짝 없는 서로게이트(값·키)는 **둘 다 던진다** — `JSON.stringify` 는 `\ud800` 으로 이스케이프해 통과시킨다.
 *   ③ 희소 배열·JSON 이 아닌 값은 우리 쪽이 던진다(`canonicalize` 는 희소 배열을 `null` 로 채운다 — 조용히 채우지 않는 쪽을 고른다).
 *   ④ 결정적 의사난수 값 수천 개(유효한 서로게이트 쌍 포함)에서 바이트가 같다.
 */

import canonicalizeReference from 'canonicalize';
import { describe, expect, it } from 'vitest';

import { canonicalize, contentHashOf, JcsInputError } from '../../../src/passport/jcs';

function reference(value: unknown): string {
  const out = canonicalizeReference(value);
  if (out === undefined) throw new Error('canonicalize 가 undefined 를 돌려줬다');
  return out;
}

describe('JCS — canonicalize(외부 구현) 차분', () => {
  it('① 고정 사례 — 수 표기 · UTF-16 키 정렬 · 제어 문자 이스케이프가 바이트 단위로 같다', () => {
    const cases: unknown[] = [
      1e21, 1e-7, 5e-324, -0, 0.1 + 0.2, 123456789012345680000, 1.7976931348623157e308, 9007199254740993,
      '  ', 'é', '\u0000\u001f\u007f', '\n\t"\\', '</script>', '\u{1F600}', '😀',
      { '€': 1, '\r': 2, '1': 3, '😀': 4, '\u0080': 5, a: 6, A: 7, '': 8, '10': 9, '2': 10, 'ö': 11, 'דּ': 12 },
      [1, [2, [3]]],
      [{}, [], ''],
      { b: { d: 1, c: 2 }, a: null },
      JSON.parse('{"__proto__":{"x":1},"a":1}'),
    ];
    for (const value of cases) expect(canonicalize(value), JSON.stringify(value)).toBe(reference(value));
  });

  it('② 짝 없는 서로게이트는 값·키 어디서든 던진다(외부 구현도 던진다)', () => {
    for (const value of ['\ud800', 'x\udc00', 'a\ud83d', { '\udc00': 1 }, { a: ['ok', '\udbff'] }] as unknown[]) {
      expect(() => canonicalize(value)).toThrow(JcsInputError);
      expect(() => reference(value)).toThrow();
    }
    // 비공허: 짝이 맞는 서로게이트는 통과한다.
    expect(canonicalize({ '😀': '😀' })).toBe(reference({ '😀': '😀' }));
  });

  it('③ 희소 배열은 던진다 — JSON 이 아닌 `[1,,3]` 도, 조용한 null 채우기도 없다', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    expect(() => canonicalize(sparse)).toThrow(JcsInputError);
    expect(() => canonicalize({ a: new Array(2) })).toThrow(JcsInputError);
    // 비공허: 명시적 null 은 JSON 이다.
    expect(canonicalize([1, null, 3])).toBe('[1,null,3]');
  });

  it('JSON 이 아닌 값은 던진다 — 조용히 빠지거나 null 이 되지 않는다', () => {
    for (const bad of [{ a: undefined }, { a: Number.NaN }, { a: Infinity }, { a: new Date(0) }, { a: () => 1 }, { a: 1n }]) {
      expect(() => canonicalize(bad)).toThrow(JcsInputError);
    }
  });

  it('content_hash = SHA-256(JCS) 소문자 hex 64', () => {
    expect(contentHashOf(canonicalize({ a: 1 }))).toBe('015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  });

  it('④ 결정적 의사난수 값 5,000개 — 바이트가 같다', () => {
    let state = 0x2026_0924;
    const random = (): number => {
      // mulberry32 — 실패를 재현할 수 있게 시드 고정.
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const char = (): string => {
      const roll = random();
      if (roll < 0.1) return '😀'; // 유효한 쌍
      let code: number;
      do code = Math.floor(random() * 0xffff);
      while (code >= 0xd800 && code < 0xe000);
      return String.fromCharCode(code);
    };
    const text = (length: number): string => Array.from({ length }, char).join('');
    const value = (depth: number): unknown => {
      const roll = random();
      if (depth > 3 || roll < 0.3) {
        const leaf = random();
        if (leaf < 0.35) return (random() - 0.5) * 10 ** Math.floor(random() * 40 - 20);
        if (leaf < 0.7) return text(1 + Math.floor(random() * 6));
        if (leaf < 0.85) return random() < 0.5;
        return null;
      }
      if (roll < 0.6) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
      const record: Record<string, unknown> = {};
      for (let index = 0; index < 4; index += 1) record[text(1 + Math.floor(random() * 3))] = value(depth + 1);
      return record;
    };
    let compared = 0;
    for (let index = 0; index < 5000; index += 1) {
      const sample = value(0);
      expect(canonicalize(sample)).toBe(reference(sample));
      compared += 1;
    }
    expect(compared).toBe(5000);
  });
});
