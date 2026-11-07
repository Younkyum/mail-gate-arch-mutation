/**
 * 초대 토큰(`src/security/invite-token.ts`) — **로그인 토큰과 같은 키링, 다른 서명 문맥**(`atmark-invite-v1`, 확장성 P1).
 *
 *   - 발급 → 검증 왕복 · 만료 경계(정각은 만료) · ms 밖 만료 거부 · 변조·미지 kid·비정규 형식 거부.
 *   - ★ 문맥 분리: 로그인·가입은 이제 코드만이다(2026-10-10 — 링크 토큰 삭제). 같은 id·만료의 로그인·가입 코드는 초대 토큰에 들어 있지 않고,
 *     옛 로그인·가입 토큰 접두사로 바꿔 끼운 초대 토큰은 초대로 검증되지 않는다.
 *   - 링크 URL 은 `https://console.atmark.ai/invite#t=<token>` — 토큰은 fragment 에만(메일 스캐너의 선제 GET 이 보지 못한다).
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { INVITE_PAGE_URL } from '../../../src/notify/invite-notifier';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { buildInviteUrl, INVITE_TOKEN_PREFIX, INVITE_TTL_MS, mintInviteToken, verifyInviteToken } from '../../../src/security/invite-token';
import { mintLoginCode } from '../../../src/security/login-code';

const KEYRING = parseHmacKeyring(`k1:${randomBytes(32).toString('base64url')}`, 'TEST');
const NOW = new Date('2026-09-25T00:00:00.000Z');
const EXPIRES = new Date(NOW.getTime() + INVITE_TTL_MS);

describe('초대 토큰', () => {
  it('발급 → 검증 왕복 — inviteId·만료 그대로 · 접두사 atk_invite_ · 7일', () => {
    const inviteId = randomUUID();
    const token = mintInviteToken(KEYRING, { inviteId, expiresAt: EXPIRES });
    expect(token.startsWith(INVITE_TOKEN_PREFIX)).toBe(true);
    expect(verifyInviteToken(KEYRING, token, NOW)).toEqual({ kind: 'valid', claims: { inviteId, expiresAt: EXPIRES } });
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('만료 경계 — 정각은 만료 · 모양이 아닌 id 는 발급 거부', () => {
    const token = mintInviteToken(KEYRING, { inviteId: randomUUID(), expiresAt: EXPIRES });
    expect(verifyInviteToken(KEYRING, token, new Date(EXPIRES.getTime() - 1)).kind).toBe('valid');
    expect(verifyInviteToken(KEYRING, token, EXPIRES)).toEqual({ kind: 'rejected', reason: 'expired' });
    expect(() => mintInviteToken(KEYRING, { inviteId: 'nope', expiresAt: EXPIRES })).toThrow();
  });

  it('변조·미지 kid·형식 오류는 거부', () => {
    const token = mintInviteToken(KEYRING, { inviteId: randomUUID(), expiresAt: EXPIRES });
    const [head = '', payload = '', signature = ''] = token.split('.');
    const flipped = `${head}.${payload}.${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BA' : 'AA'}`;
    expect(verifyInviteToken(KEYRING, flipped, NOW).kind).toBe('rejected');
    expect(verifyInviteToken(KEYRING, token.replace('atk_invite_k1.', 'atk_invite_k9.'), NOW)).toEqual({ kind: 'rejected', reason: 'unknown_key' });
    expect(verifyInviteToken(KEYRING, 'atk_invite_', NOW)).toEqual({ kind: 'rejected', reason: 'malformed' });
    expect(verifyInviteToken(KEYRING, `${token}x`.repeat(20), NOW)).toEqual({ kind: 'rejected', reason: 'malformed' });
  });

  it('★ 문맥 분리 — 로그인·가입 코드 ↔ 초대 토큰은 서로 통하지 않는다(접두사를 바꿔 끼워도 초대로 검증되지 않는다)', () => {
    const id = randomUUID();
    const invite = mintInviteToken(KEYRING, { inviteId: id, expiresAt: EXPIRES });
    const login = mintLoginCode(KEYRING, 'owner_login', { linkId: id, expiresAt: EXPIRES });
    const signup = mintLoginCode(KEYRING, 'signup', { linkId: id, expiresAt: EXPIRES });
    // 같은 키 · 같은 id · 같은 만료라도 문맥이 다르다 — 초대 토큰에서 코드를 읽어 낼 수 없다.
    expect(invite).not.toContain(login);
    expect(invite).not.toContain(signup);
    expect(login).not.toBe(signup);
    // 옛 링크 토큰 접두사(atk_login_ · atk_signup_)로 바꿔 끼운 초대 토큰은 초대가 아니다.
    expect(verifyInviteToken(KEYRING, invite.replace(/^atk_invite_/, 'atk_login_'), NOW).kind).toBe('rejected');
    expect(verifyInviteToken(KEYRING, invite.replace(/^atk_invite_/, 'atk_signup_'), NOW).kind).toBe('rejected');
    expect(verifyInviteToken(KEYRING, invite, NOW).kind).toBe('valid');
  });

  it('링크 URL — https://console.atmark.ai/invite#t=<token> · 쿼리·fragment 가 있는 페이지는 거부', () => {
    const token = mintInviteToken(KEYRING, { inviteId: randomUUID(), expiresAt: EXPIRES });
    const url = buildInviteUrl(INVITE_PAGE_URL, token);
    expect(url).toBe(`https://console.atmark.ai/invite#t=${token}`);
    expect(new URL(url).search).toBe('');
    expect(() => buildInviteUrl('http://console.atmark.ai/invite', token)).toThrow();
    expect(() => buildInviteUrl(`${INVITE_PAGE_URL}?x=1`, token)).toThrow();
    expect(() => buildInviteUrl(`${INVITE_PAGE_URL}#a`, token)).toThrow();
    expect(() => buildInviteUrl(INVITE_PAGE_URL, 'atk_login_k1.a.b')).toThrow();
  });
});
