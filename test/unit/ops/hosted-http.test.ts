/**
 * 호스팅 ops HTTP 검문 · 헤더 · 쿠키 · 파생값(`.omc/plans/ops-console.md` §3.7 · W-APP 수락 기준).
 */

import { describe, expect, it } from 'vitest';

import { OPS_COOKIES, OPS_ORIGIN } from '../../../src/ops/contract';
import {
  BASE_HEADERS,
  checkHost,
  checkOrigin,
  clearSessionCookie,
  jsonResult,
  loginCookie,
  parseCookies,
  readJsonBody,
  sessionCookie,
} from '../../../src/ops/hosted/http';
import { createOpsKeys, randomToken, sessionHash, TOKEN_PATTERN } from '../../../src/ops/hosted/keys';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { event, keys } from './hosted-support';

describe('Host — ops.atmark.ai 하나, 나머지는 421', () => {
  it('정확한 Host 만 통과', () => {
    expect(checkHost(event({ path: '/' }))).toEqual({ ok: true });
  });

  it('execute-api 기본 엔드포인트 · 다른 호스트 · 대문자 · 포트 · domainName 불일치는 421', () => {
    for (const host of ['abc123.execute-api.ap-northeast-2.amazonaws.com', 'console.atmark.ai', 'OPS.ATMARK.AI', 'ops.atmark.ai:443', 'ops.atmark.ai.evil.example']) {
      expect(checkHost(event({ path: '/', host })), host).toEqual({ ok: false, status: 421, code: 'misdirected_request' });
    }
    expect(checkHost(event({ path: '/', domainName: 'abc123.execute-api.ap-northeast-2.amazonaws.com' }))).toMatchObject({ ok: false, status: 421 });
    const noHost = event({ path: '/' });
    expect(checkHost({ ...noHost, headers: {} })).toMatchObject({ ok: false, status: 421 });
  });
});

describe('출처 — 정확한 Origin · Sec-Fetch-Site', () => {
  it('POST 는 Origin 이 정확히 https://ops.atmark.ai 여야 한다(없으면 거부)', () => {
    expect(checkOrigin(event({ path: '/api/x', body: {} }), false)).toEqual({ ok: true });
    expect(checkOrigin(event({ path: '/api/x', body: {}, origin: null }), false)).toMatchObject({ ok: false, status: 403, code: 'origin_mismatch' });
    for (const origin of ['https://console.atmark.ai', 'http://ops.atmark.ai', 'https://ops.atmark.ai:443', 'null', `${OPS_ORIGIN}/`]) {
      expect(checkOrigin(event({ path: '/api/x', body: {}, origin }), false), origin).toMatchObject({ ok: false, status: 403 });
    }
  });

  it('교차 사이트 요청은 거부 · 페이지 탐색만 Sec-Fetch-Site none', () => {
    expect(checkOrigin(event({ path: '/api/x', site: 'cross-site' }), false)).toMatchObject({ ok: false, code: 'cross_site' });
    expect(checkOrigin(event({ path: '/api/x', site: 'same-site' }), false)).toMatchObject({ ok: false, code: 'cross_site' });
    expect(checkOrigin(event({ path: '/api/x', site: 'none' }), false)).toMatchObject({ ok: false });
    expect(checkOrigin(event({ path: '/', site: 'none' }), true)).toEqual({ ok: true });
    expect(checkOrigin(event({ path: '/api/x', origin: 'https://evil.example' }), false)).toMatchObject({ ok: false, code: 'origin_mismatch' });
  });
});

describe('헤더 · 쿠키', () => {
  it('모든 응답: HSTS · no-store · nosniff · no-referrer · DENY · COOP · CORP · noindex · CORS 0', () => {
    const result = jsonResult(200, {});
    expect(result.headers).toMatchObject({
      'strict-transport-security': 'max-age=63072000; includeSubDomains',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'x-robots-tag': 'noindex, nofollow',
    });
    expect(Object.keys(result.headers).some((key) => key.startsWith('access-control-'))).toBe(false);
    expect(Object.keys(BASE_HEADERS).some((key) => key.startsWith('access-control-'))).toBe(false);
  });

  it('쿠키 둘 — __Host- · Secure · Path=/ · Domain 없음 · HttpOnly · SameSite=Strict', () => {
    for (const cookie of [sessionCookie('x', 60), loginCookie('y', 60), clearSessionCookie()]) {
      expect(cookie).toMatch(/^__Host-atmark_ops(_login)?=/);
      expect(cookie).toContain('; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=');
      expect(cookie).not.toMatch(/Domain=/i);
    }
    expect(OPS_COOKIES).toEqual({ session: '__Host-atmark_ops', login: '__Host-atmark_ops_login' });
  });

  it('같은 이름 쿠키가 다른 값으로 둘이면 버린다', () => {
    const e = event({ path: '/', cookies: {} });
    expect(parseCookies({ ...e, cookies: ['__Host-atmark_ops=a', '__Host-atmark_ops=b', 'x=1'] })).toEqual({ x: '1' });
    expect(parseCookies({ ...e, cookies: ['__Host-atmark_ops=a'], headers: { cookie: '__Host-atmark_ops=a; y=2' } })).toEqual({ '__Host-atmark_ops': 'a', y: '2' });
  });

  it('본문 — JSON 객체만 · 크기 상한', () => {
    const e = event({ path: '/api/x', body: { a: 1 } });
    expect(readJsonBody(e)).toEqual({ a: 1 });
    expect(readJsonBody({ ...e, body: '[1]' })).toBeNull();
    expect(readJsonBody({ ...e, body: 'x'.repeat(9000) })).toBeNull();
    expect(readJsonBody({ ...e, headers: { ...e.headers, 'content-type': 'text/plain' } })).toBeNull();
  });
});

describe('파생값 — 문맥 분리 · hex 64 · CSRF', () => {
  it('같은 입력이라도 문맥이 다르면 다른 값 · DB 계약 모양(hex 64)', () => {
    const values = [keys.binding('v'), keys.clientKey('v'), keys.uaHash('v'), sessionHash('v')];
    expect(new Set(values).size).toBe(4);
    for (const value of values) expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.binding('v')).toBe(keys.binding('v'));
  });

  it('다른 키면 다른 값(회전하면 세션이 UA 불일치로 끝난다)', () => {
    const other = createOpsKeys(parseHmacKeyring(`o2:${Buffer.alloc(32, 9).toString('base64url')}`, 'test'));
    expect(other.uaHash('ua')).not.toBe(keys.uaHash('ua'));
  });

  it('CSRF 는 세션 토큰에 묶인다 · 상수 시간 비교 · 없으면 거짓', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).toMatch(TOKEN_PATTERN);
    expect(keys.csrfMatches(a, keys.csrf(a))).toBe(true);
    expect(keys.csrfMatches(a, keys.csrf(b))).toBe(false);
    expect(keys.csrfMatches(a, undefined)).toBe(false);
    expect(keys.csrfMatches(a, '')).toBe(false);
  });
});
