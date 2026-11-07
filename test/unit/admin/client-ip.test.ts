/**
 * 요청자 IP 가 없으면 **닫힌 채 실패한다**(로그인 보안 재확인 I-3) — DB 없이 라우터 그대로(`routeAdminEvent`).
 *
 *   - 요청자 상한을 거는 세션 전 라우트(로그인·가입 요청/검증 · 초대 수락)는 `sourceIp` 가 없거나 비면 503 `client_ip_unavailable` · DB 호출 0.
 *     예전에는 `'unknown'` 한 값으로 모든 요청자를 한 버킷(한 HMAC 키)에 몰았다 — 통합 설정이 어긋난 날 한 사람이 모두의 로그인을 막았다.
 *   - IP 를 쓰지 않는 경로(페이지)는 그대로다.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { clientIpOf, LOGIN_BROWSER_COOKIE, SIGNUP_BROWSER_COOKIE, type AdminHttpEvent } from '../../../src/admin/http';
import { routeAdminEvent } from '../../../src/admin/router';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';

/** DB 를 부르면 던지는 의존성 — 이 파일의 모든 경로는 DB 전에 끝나야 한다. */
const deps = {
  pool: new Proxy({} as Pool, {
    get() {
      throw new Error('이 테스트에서 DB 를 부르면 안 된다');
    },
  }),
  loginKeys: parseHmacKeyring('k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'TEST'),
  custody: () => {
    throw new Error('unused');
  },
  now: () => new Date(),
} as unknown as AdminDependencies;

const NONCE = 'n'.repeat(43);

function send(method: string, path: string, sourceIp: string | undefined, body?: unknown) {
  const event: AdminHttpEvent = {
    rawPath: path,
    headers: { 'content-type': 'application/json', origin: 'https://console.atmark.ai' },
    cookies: [`${LOGIN_BROWSER_COOKIE}=${NONCE}`, `${SIGNUP_BROWSER_COOKIE}=${NONCE}`],
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    isBase64Encoded: false,
    requestContext: { requestId: `req-${randomUUID()}`, stage: '$default', http: { method, ...(sourceIp === undefined ? {} : { sourceIp }) } },
  };
  return routeAdminEvent(deps, event);
}

const lines: string[] = [];
beforeEach(() => {
  lines.length = 0;
  setLogSink((line) => lines.push(line));
});
afterEach(() => resetLogSink());

describe('clientIpOf', () => {
  it('있으면 그대로(앞뒤 공백 제거) · 없거나 비면 null', () => {
    const of = (sourceIp: string | undefined): string | null =>
      clientIpOf({ rawPath: '/', requestContext: { requestId: 'r', http: { method: 'GET', ...(sourceIp === undefined ? {} : { sourceIp }) } } });
    expect(of('203.0.113.7')).toBe('203.0.113.7');
    expect(of(' 2001:db8::1 ')).toBe('2001:db8::1');
    expect(of(undefined)).toBeNull();
    expect(of('')).toBeNull();
    expect(of('   ')).toBeNull();
  });
});

describe('요청자 IP 가 없으면 세션 전 라우트는 503 client_ip_unavailable(재확인 I-3)', () => {
  const routes: readonly [string, unknown][] = [
    ['/api/login', { email: 'someone@example.com' }],
    ['/api/login/verify', { code: '123456' }],
    ['/api/signup', { email: 'someone@example.com', organizationName: 'Acme', consent: true }],
    ['/api/signup/verify', { code: '123456' }],
    ['/api/invites/claim', { token: 'x' }],
  ];

  it.each([undefined, '', '  '])('sourceIp=%j — 다섯 경로 모두 503 · DB 호출 0 · 오류 로그 한 줄(값 없이)', async (ip) => {
    for (const [path, body] of routes) {
      const res = await send('POST', path, ip, body);
      expect([res.statusCode, (JSON.parse(res.body) as { error: string }).error], path).toEqual([503, 'client_ip_unavailable']);
      expect(res.cookies ?? [], path).toEqual([]);
    }
    const missing = lines.filter((line) => line.includes('admin.client_ip_missing'));
    expect(missing).toHaveLength(routes.length);
    for (const line of missing) expect(line).not.toMatch(/someone@example\.com|nnnnnnnn/);
  });

  it('IP 를 쓰지 않는 페이지(GET /login)는 IP 없이도 200', async () => {
    const res = await send('GET', '/login', undefined);
    expect(res.statusCode).toBe(200);
  });
});
