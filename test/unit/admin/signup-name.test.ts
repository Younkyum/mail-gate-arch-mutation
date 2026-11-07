/**
 * 가입 조직 이름의 앱 검사(`isValidOrganizationName`, `src/admin/session.ts`) — **DB 없이** 전 코드 포인트(0..0x10FFFF)를 돈다.
 *
 * 검증 H3: 앱 검사가 `signup_links.organization_name` CHECK 보다 좁으면(U+2065 — 미할당, 앱 통과 · DB 거부) 새 주소만 CHECK 에
 * 걸려 가입 응답이 주소의 존재를 가른다. 앱 검사는 아래 금지 목록(보안 수정의 합의 목록 — DB 문자 집합을 포함한다)을 **전부**
 * 거부해야 한다. 실제 DB CHECK 와의 대조는 `test/integration/admin/signup-name-charset.test.ts`.
 *
 * 되돌리면 빨개지는 것: 금지 정규식에서 `\p{Cn}` 을 빼면(U+2065 통과) ⓝ-1 · 명시 범위 하나(예: U+3164)를 빼면 ⓝ-1 · 길이 규칙을
 * 81 로 느슨하게 하면 ⓝ-3.
 */

import { describe, expect, it } from 'vitest';

import { isValidOrganizationName, SIGNUP_ORGANIZATION_NAME_MAX_LENGTH } from '../../../src/admin/session';

/** 합의된 금지 목록 — 범주 + 명시 범위. */
const FORBIDDEN_CATEGORIES = /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;
const FORBIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0x2800, 0x2800],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];
const forbidden = (cp: number): boolean =>
  FORBIDDEN_CATEGORIES.test(String.fromCodePoint(cp)) || FORBIDDEN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);

describe('가입 조직 이름 — 앱 검사가 금지 목록 전부를 거부한다 (검증 H3)', () => {
  it('ⓝ-1 전 코드 포인트 0..0x10FFFF: 금지 목록의 글자는 (가운데에 끼어도) 거부 · 그 밖의 글자는 통과', () => {
    const leaked: string[] = [];
    const overBlocked: string[] = [];
    let forbiddenCount = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      // 앞뒤를 보통 글자로 감싼다 — trim 으로 사라지는 자리가 아니라 **값 안에** 남는 경우를 본다.
      const name = `a${String.fromCodePoint(cp)}b`;
      const bad = forbidden(cp);
      if (bad) forbiddenCount++;
      const accepted = isValidOrganizationName(name);
      if (bad && accepted) leaked.push(cp.toString(16));
      if (!bad && !accepted) overBlocked.push(cp.toString(16));
    }
    expect(leaked, `앱이 통과시킨 금지 글자: ${leaked.slice(0, 20).join(',')}`).toEqual([]);
    // 앱은 목록 밖의 글자를 막지 않는다(합의 목록 = 앱 검사 — 둘이 같다).
    expect(overBlocked.slice(0, 20)).toEqual([]);
    expect(forbiddenCount).toBeGreaterThan(900_000); // 미할당(Cn) · 사용자 영역(Co)이 대부분
  });

  it('ⓝ-2 검증이 실증한 글자와 그 이웃: U+2065(미할당) · 한글 채움 · 점자 빈칸 · 이형 선택자 · 태그 문자', () => {
    for (const cp of [0x2065, 0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x034f, 0xfe0f, 0xe0001, 0xe0100, 0x180e, 0x17b4, 0xfeff]) {
      expect(isValidOrganizationName(`Acme${String.fromCodePoint(cp)}`), cp.toString(16)).toBe(false);
    }
    for (const ok of ['Acme', 'Acme 연구소', '株式会社', 'Café-Ω', 'A&B (주)', '🚀 Rocket']) expect(isValidOrganizationName(ok), ok).toBe(true);
  });

  it(`ⓝ-3 길이: 1~${String(SIGNUP_ORGANIZATION_NAME_MAX_LENGTH)} 코드 포인트(DB length() 와 같은 단위)`, () => {
    expect(isValidOrganizationName('')).toBe(false);
    expect(isValidOrganizationName('a')).toBe(true);
    expect(isValidOrganizationName('가'.repeat(SIGNUP_ORGANIZATION_NAME_MAX_LENGTH))).toBe(true);
    expect(isValidOrganizationName('가'.repeat(SIGNUP_ORGANIZATION_NAME_MAX_LENGTH + 1))).toBe(false);
    // 아스트랄 글자도 한 글자(코드 포인트) — UTF-16 단위로 세면 40개에서 막힌다.
    expect(isValidOrganizationName('😀'.repeat(SIGNUP_ORGANIZATION_NAME_MAX_LENGTH))).toBe(true);
    expect(isValidOrganizationName('😀'.repeat(SIGNUP_ORGANIZATION_NAME_MAX_LENGTH + 1))).toBe(false);
  });
});
