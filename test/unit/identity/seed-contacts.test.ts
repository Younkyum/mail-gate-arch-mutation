/** seed contacts(계획 §3.1 층 2 · §3.2) — 상한 20 과 정규화 일치(어긋나면 "등록했는데 막히는" 조용한 상태)가 두 축이다. */

import { describe, expect, it } from 'vitest';
import { comparableAddress, normalizeAddress } from '../../../src/policy/policy-loader';
import {
  MAX_SEED_CONTACTS,
  P1B_DEMO_SEED_CONTACT,
  resolveSeedContacts,
  SeedContactError,
} from '../../../src/identity/seed-contacts';

describe('resolveSeedContacts', () => {
  it('빈 목록을 허용한다 — "상대가 아직 없는" 에이전트도 만들 수 있어야 한다', () => {
    expect(resolveSeedContacts([])).toEqual([]);
  });

  it('정책 로더의 허용 비교형으로 정규화한다 — 소문자화만, `+tag` 보존(허용은 좁게, V1 MINOR-2)', () => {
    const resolved = resolveSeedContacts(['  Victim+x@Gmail.com  ']);
    expect(resolved).toEqual(['victim+x@gmail.com']);
    expect(resolved[0]).toBe(comparableAddress('Victim+x@Gmail.com'));
    // 판정형(태그 절단)으로 저장하면 소유자가 적지 않은 `victim@`·`victim+*` 가 seed 가 된다.
    expect(resolved[0]).not.toBe(normalizeAddress('Victim+x@Gmail.com'));
  });

  it('정규화 후 중복은 조용히 제거하고 입력 순서를 보존한다 — 대소문자만 다른 것이 중복이고, 다른 태그는 다른 상대다', () => {
    expect(resolveSeedContacts(['b@x.com', 'a@b.com', 'A@B.com', 'a+tag@b.com'])).toEqual(['b@x.com', 'a@b.com', 'a+tag@b.com']);
  });

  it(`상한 ${MAX_SEED_CONTACTS} 개까지 허용하고 ${MAX_SEED_CONTACTS + 1} 개는 거부한다 (경계)`, () => {
    const seeds = (n: number): string[] => Array.from({ length: n }, (_, i) => `seed${i}@example.com`);
    expect(resolveSeedContacts(seeds(MAX_SEED_CONTACTS))).toHaveLength(MAX_SEED_CONTACTS);
    expect(() => resolveSeedContacts(seeds(MAX_SEED_CONTACTS + 1))).toThrow(SeedContactError);
  });

  it('중복 때문에 상한을 넘지 않는다', () => {
    const input = Array.from({ length: MAX_SEED_CONTACTS + 5 }, () => 'same@example.com');
    expect(resolveSeedContacts(input)).toEqual(['same@example.com']);
  });

  it.each([['@ 없음', 'not-an-address'], ['공백 포함', 'a b@c.com'], ['@ 둘', 'a@b@c.com'], ['빈 문자열', '']])(
    '%s 은 거부한다',
    (_label, value) => {
      expect(() => resolveSeedContacts([value])).toThrow(SeedContactError);
    },
  );

  it('문자열이 아닌 값은 거부한다 (API 경계의 JSON 은 타입을 지키지 않는다)', () => {
    expect(() => resolveSeedContacts([42 as unknown as string])).toThrow(SeedContactError);
  });
});

describe('P1B_DEMO_SEED_CONTACT', () => {
  it('자기 자신의 정규화형이고(allowlist 에 그대로 매칭) atmark.ai 주소가 아니다', () => {
    expect(normalizeAddress(P1B_DEMO_SEED_CONTACT)).toBe(P1B_DEMO_SEED_CONTACT);
    expect(resolveSeedContacts([P1B_DEMO_SEED_CONTACT])).toEqual([P1B_DEMO_SEED_CONTACT]);
    expect(P1B_DEMO_SEED_CONTACT.endsWith('@atmark.ai')).toBe(false);
  });
});
