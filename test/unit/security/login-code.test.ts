/**
 * 로그인·가입 메일의 6자리 코드(`src/security/login-code.ts`) — 형식 · 파생(키·링크·만료·문맥에 묶임) · 정규화 · 상수 시간 맞추기. DB 없음.
 * 결속·단일 사용·5회 계수는 DB 층이라 `test/integration/admin/login-code.test.ts` 가 본다.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import {
  LOGIN_CODE_DIGITS,
  LOGIN_CODE_MAX_FAILURES,
  LoginCodeError,
  matchLoginCode,
  mintLoginCode,
  normalizeLoginCode,
  opsCodeDigest,
  opsTargetRef,
} from '../../../src/security/login-code';
import { mintInviteToken } from '../../../src/security/invite-token';

const secret = (): string => randomBytes(32).toString('base64url');
const ring = (kid = 'k1') => parseHmacKeyring(`${kid}:${secret()}`, 'TEST');
const LINK = '0f0e0d0c-0b0a-4908-8706-050403020100';
const EXP = new Date('2026-09-28T00:15:00.000Z');

describe('6자리 코드 — 발급', () => {
  it('정확히 6자리 숫자(앞자리 0 유지) · 상수', () => {
    expect(LOGIN_CODE_DIGITS).toBe(6);
    expect(LOGIN_CODE_MAX_FAILURES).toBe(5);
    const keys = ring();
    for (let i = 0; i < 300; i += 1) {
      expect(mintLoginCode(keys, 'owner_login', { linkId: randomUUID(), expiresAt: EXP })).toMatch(/^[0-9]{6}$/);
    }
  });

  it('결정적 — 같은 키·링크·만료·용도면 같은 코드(저장하지 않고 verify 때 다시 계산한다)', () => {
    const keys = ring();
    expect(mintLoginCode(keys, 'owner_login', { linkId: LINK, expiresAt: EXP })).toBe(mintLoginCode(keys, 'owner_login', { linkId: LINK, expiresAt: EXP }));
  });

  it('키·링크·만료·용도 어느 하나가 달라도 코드가 갈린다(충돌은 우연 — 1/10^6)', () => {
    const keys = ring();
    const base = mintLoginCode(keys, 'owner_login', { linkId: LINK, expiresAt: EXP });
    const variants = [
      mintLoginCode(ring(), 'owner_login', { linkId: LINK, expiresAt: EXP }),
      mintLoginCode(keys, 'owner_login', { linkId: randomUUID(), expiresAt: EXP }),
      mintLoginCode(keys, 'owner_login', { linkId: LINK, expiresAt: new Date(EXP.getTime() + 1) }),
      mintLoginCode(keys, 'signup', { linkId: LINK, expiresAt: EXP }),
    ];
    // 넷이 모두 우연히 같을 확률은 무시할 만하다 — 하나라도 다르면 입력이 코드에 들어간다는 증거가 약해지므로 넷 다 본다.
    expect(variants.filter((code) => code === base).length).toBeLessThanOrEqual(1);
  });

  it('고르게 퍼진다 — 첫 자리 분포(2000개, 각 숫자 ≥ 100)', () => {
    const keys = ring();
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < 2000; i += 1) {
      const code = mintLoginCode(keys, 'signup', { linkId: randomUUID(), expiresAt: EXP });
      counts[Number(code[0])] = (counts[Number(code[0])] ?? 0) + 1;
    }
    for (const count of counts) expect(count).toBeGreaterThanOrEqual(100);
  });

  it('링크 id 가 uuid 가 아니거나 만료가 유효한 시각이 아니면 던진다', () => {
    const keys = ring();
    expect(() => mintLoginCode(keys, 'owner_login', { linkId: 'not-a-uuid', expiresAt: EXP })).toThrow(LoginCodeError);
    expect(() => mintLoginCode(keys, 'owner_login', { linkId: LINK, expiresAt: new Date(Number.NaN) })).toThrow(LoginCodeError);
  });

  it('코드는 같은 키의 서명 토큰(초대) 안에 들어 있지 않다(토큰에서 코드를 읽어 낼 수 없다 — 둘은 다른 문맥의 HMAC)', () => {
    const keys = ring();
    const code = mintLoginCode(keys, 'owner_login', { linkId: LINK, expiresAt: EXP });
    const token = mintInviteToken(keys, { inviteId: LINK, expiresAt: EXP });
    expect(token).not.toContain(code);
  });
});

describe('6자리 코드 — 입력 정규화', () => {
  it.each([
    ['123456', '123456'],
    [' 123456 ', '123456'],
    ['123 456', '123456'],
    ['123-456', '123456'],
    ['１２３４５６', '123456'],
    ['012345', '012345'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeLoginCode(raw)).toBe(expected);
  });

  it.each([['12345'], ['1234567'], ['12a456'], [''], ['123_456'], ['x'.repeat(40)]])('%j → null', (raw) => {
    expect(normalizeLoginCode(raw)).toBeNull();
  });

  it('문자열이 아니면 null', () => {
    for (const raw of [123456, null, undefined, ['123456'], { code: '123456' }]) expect(normalizeLoginCode(raw)).toBeNull();
  });
});

describe('6자리 코드 — 맞추기', () => {
  const links = [
    { linkId: randomUUID(), expiresAt: EXP },
    { linkId: randomUUID(), expiresAt: EXP },
    { linkId: randomUUID(), expiresAt: EXP },
  ];

  it('맞는 후보의 위치 · 틀리면 -1 · 후보 없음 -1', () => {
    const keys = ring();
    const code = mintLoginCode(keys, 'owner_login', links[1]!);
    expect(matchLoginCode(keys, 'owner_login', links, code)).toBe(1);
    const issued = new Set(links.map((link) => mintLoginCode(keys, 'owner_login', link)));
    const wrong = ['000000', '000001', '000002', '000003'].find((candidate) => !issued.has(candidate)) ?? '999999';
    expect(matchLoginCode(keys, 'owner_login', links, wrong)).toBe(-1);
    expect(matchLoginCode(keys, 'owner_login', [], code)).toBe(-1);
  });

  it('용도가 다르면 맞지 않는다(가입 코드는 로그인 코드가 아니다)', () => {
    const keys = ring();
    const code = mintLoginCode(keys, 'signup', links[0]!);
    const loginCode = mintLoginCode(keys, 'owner_login', links[0]!);
    if (code !== loginCode) expect(matchLoginCode(keys, 'owner_login', [links[0]!], code)).toBe(-1);
  });

  it('다른 키 묶음의 코드는 맞지 않는다 · 회전 중(새 키가 앞)에는 옛 키로 발급한 코드도 맞는다', () => {
    const oldSecret = secret();
    const oldRing = parseHmacKeyring(`k1:${oldSecret}`, 'TEST');
    const code = mintLoginCode(oldRing, 'owner_login', links[2]!);
    const other = ring('k1');
    if (mintLoginCode(other, 'owner_login', links[2]!) !== code) expect(matchLoginCode(other, 'owner_login', [links[2]!], code)).toBe(-1);
    const rotated = parseHmacKeyring(`k2:${secret()},k1:${oldSecret}`, 'TEST');
    expect(matchLoginCode(rotated, 'owner_login', [links[2]!], code)).toBe(0);
  });

  it('정규화되지 않은 입력(공백·하이픈)은 맞추지 않는다 — 호출자가 먼저 정규화한다', () => {
    const keys = ring();
    const code = mintLoginCode(keys, 'owner_login', links[0]!);
    expect(matchLoginCode(keys, 'owner_login', [links[0]!], `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(-1);
    expect(matchLoginCode(keys, 'owner_login', [links[0]!], normalizeLoginCode(`${code.slice(0, 3)}-${code.slice(3)}`) ?? '')).toBe(0);
  });
});

describe('운영자 콘솔 코드(ops_login) — 문맥 · 다이제스트 · 대상 참조(`.omc/plans/ops-console.md` 결정 C2)', () => {
  it('ops_login 문맥은 소유자·가입 코드와 갈린다(같은 키·도전 id·만료)', () => {
    const keys = ring();
    const link = { linkId: LINK, expiresAt: EXP };
    const ops = mintLoginCode(keys, 'ops_login', link);
    expect(ops).toMatch(/^[0-9]{6}$/);
    expect(ops).toBe(mintLoginCode(keys, 'ops_login', link));
    expect([mintLoginCode(keys, 'owner_login', link), mintLoginCode(keys, 'signup', link)].filter((code) => code === ops).length).toBeLessThanOrEqual(1);
  });

  it('다이제스트 벡터 — DB 의 ops_code_digest(202609290500)와 같은 식(통합 테스트가 DB 로 다시 맞춘다)', () => {
    expect(opsCodeDigest(LINK, '012345')).toBe('d47223620d2f01a5d800d259e4371adb0ae3efdbd8b84df39d253d4c6bef25f9');
    expect(opsCodeDigest(LINK, '012346')).not.toBe(opsCodeDigest(LINK, '012345'));
    expect(() => opsCodeDigest('nope', '012345')).toThrow(LoginCodeError);
    expect(() => opsCodeDigest(LINK, '12345')).toThrow(LoginCodeError);
  });

  it('대상 참조 벡터 — Crockford base32 4자리(I·L·O·U 없음) · DB 의 ops_target_ref 와 같은 식', () => {
    expect(opsTargetRef(LINK, 'org.reject', '11111111-2222-4333-8444-555555555555')).toBe('PH5K');
    expect(opsTargetRef('00000000-0000-4000-8000-000000000001', 'operator.approve', '00000000-0000-4000-8000-000000000002')).toBe('TP6H');
    for (let i = 0; i < 200; i += 1) expect(opsTargetRef(randomUUID(), 'org.activate', randomUUID())).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
  });
});
