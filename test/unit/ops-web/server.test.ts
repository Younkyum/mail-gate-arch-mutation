/**
 * 운영자 웹 화면 HTTP 서버 — 실제 소켓(127.0.0.1, 무작위 포트), DB 없음(가짜 풀 — DB 를 부르지 않는 경로만).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 127.0.0.1 에만 묶인다.
 *   - **앰비언트 자격 증명 0**: 어떤 응답에도 Set-Cookie 가 없고, 쿠키만으로는 `/api/*` 가 401.
 *   - 부트스트랩: 맞으면 303 `/#t=<세션 토큰>`(fragment) · 두 번째(재사용)·틀림·만료는 410 + 탈취 신호 콜백 + 서버가 더 받지 않는다.
 *   - `/api/*` 는 `/api/session` 포함 `x-ops-token` 필수 · Host 가 `127.0.0.1:포트` 가 아니면(localhost·rebinding) 403 · 다른 Origin 403 ·
 *     Origin 없는 POST 403 · preflight 거부(CORS 헤더 0).
 *   - 정적 페이지는 토큰 없이(데이터 없음) · 해시 CSP · 보안 헤더.
 */

import { request } from 'node:http';

import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OPS } from '../../../scripts/ops-web/api';
import { randomSecret } from '../../../scripts/ops-web/security';
import { startOpsServer, type OpsServer, type OpsServerOptions } from '../../../scripts/ops-web/server';

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${String(port)}`, ...options.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;

let current: OpsServer | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});

async function start(overrides: Partial<OpsServerOptions> = {}) {
  const token = randomSecret();
  const bootstrap = randomSecret();
  const abuse = vi.fn();
  const activity = vi.fn();
  const server = await startOpsServer({
    port: 0,
    sessionToken: token,
    bootstrap,
    bootstrapTtlMs: 60_000,
    context: {
      owner: fakePool,
      operator: null,
      target: { target: 'local', host: 'localhost', port: 5432, database: 'x', user: 'u', reasons: [] },
      actor: 'admin:web:test',
      audit: () => undefined,
      idleMinutes: 30,
      maxHours: 8,
      ops: OPS,
      now: () => new Date(),
    },
    onActivity: activity,
    onBootstrapAbuse: abuse,
    ...overrides,
  });
  current = server;
  return { server, token, bootstrap, abuse, activity, port: server.port };
}

describe('운영자 웹 서버', () => {
  it('127.0.0.1 에만 묶인다 · 부트스트랩 URL 도 127.0.0.1', async () => {
    const { server, bootstrap } = await start();
    const address = server.server.address();
    expect(typeof address === 'object' && address !== null ? address.address : null).toBe('127.0.0.1');
    expect(server.bootstrapUrl).toBe(`http://127.0.0.1:${String(server.port)}/bootstrap?k=${bootstrap}`);
  });

  it('부트스트랩 → 303 /#t=<토큰> · Set-Cookie 없음 · 재사용은 410 + 탈취 신호 + 서버가 더 받지 않는다', async () => {
    const { port, bootstrap, token, abuse } = await start();
    const first = await call(port, `/bootstrap?k=${bootstrap}`, { headers: { 'sec-fetch-site': 'none' } });
    expect(first.status).toBe(303);
    expect(first.headers['location']).toBe(`/#t=${token}`);
    expect(first.headers['set-cookie']).toBeUndefined();
    expect(first.headers['referrer-policy']).toBe('no-referrer');
    expect(abuse).not.toHaveBeenCalled();
    expect((await call(port, `/bootstrap?k=${bootstrap}`)).status).toBe(410);
    expect(abuse).toHaveBeenCalledWith('used');
    expect((await call(port, '/api/session', { headers: { 'x-ops-token': token } })).status).toBe(503);
  });

  it('틀린 부트스트랩 값·만료도 탈취 신호', async () => {
    const wrong = await start();
    expect((await call(wrong.port, `/bootstrap?k=${randomSecret()}`)).status).toBe(410);
    expect(wrong.abuse).toHaveBeenCalledWith('mismatch');
    await current?.close();
    let t = 0;
    const late = await start({ clock: () => t });
    t = 60_001;
    expect((await call(late.port, `/bootstrap?k=${late.bootstrap}`)).status).toBe(410);
    expect(late.abuse).toHaveBeenCalledWith('expired');
  });

  it('쿠키만으로는 401 — /api/session 도 토큰 필수 · 맞는 토큰이면 200(CSRF 값 같은 것은 주지 않는다)', async () => {
    const { port, token, activity } = await start();
    const cookie = `atmark_ops_${String(port)}=${token}; session=${token}`;
    expect((await call(port, '/api/session', { headers: { cookie } })).status).toBe(401);
    expect((await call(port, '/api/catalog', { headers: { cookie } })).status).toBe(401);
    expect((await call(port, '/api/catalog', { headers: { 'x-ops-token': randomSecret() } })).status).toBe(401);
    expect(activity).not.toHaveBeenCalled();
    const s = await call(port, '/api/session', { headers: { 'x-ops-token': token, 'sec-fetch-site': 'same-origin' } });
    expect(s.status).toBe(200);
    const body = JSON.parse(s.body) as Record<string, unknown>;
    expect(body).toMatchObject({ actor: 'admin:web:test', billingOperator: false, idleMinutes: 30, maxHours: 8 });
    expect(JSON.stringify(body)).not.toContain(token);
    expect(s.headers['set-cookie']).toBeUndefined();
    expect(s.headers['access-control-allow-origin']).toBeUndefined();
    expect(activity).toHaveBeenCalledTimes(1);
  });

  it('Host 가 127.0.0.1:포트 가 아니면(localhost · rebinding) 토큰이 있어도 403 · 다른 Origin · 교차 사이트 403', async () => {
    const { port, token } = await start();
    const auth = { 'x-ops-token': token };
    expect((await call(port, '/api/session', { headers: { ...auth, host: `localhost:${String(port)}` } })).status).toBe(403);
    expect((await call(port, '/', { headers: { host: `evil.example:${String(port)}` } })).status).toBe(403);
    expect((await call(port, '/api/session', { headers: { ...auth, origin: 'http://evil.example' } })).status).toBe(403);
    expect((await call(port, '/api/session', { headers: { ...auth, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
  });

  it('정적 페이지 — 토큰 없이 200 · 해시 CSP · 보안 헤더 · 비밀이 본문에 없다', async () => {
    const { port, token, bootstrap } = await start();
    const page = await call(port, '/', { headers: { 'sec-fetch-site': 'none' } });
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toMatch(/^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'; style-src 'sha256-/);
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(page.body).not.toContain(token);
    expect(page.body).not.toContain(bootstrap);
  });

  it('쓰기 — Origin 없는 POST 403 · preflight 거부(CORS 헤더 0) · JSON 아닌 본문 400', async () => {
    const { port, token } = await start();
    const origin = `http://127.0.0.1:${String(port)}`;
    const path = '/api/orgs/11111111-2222-4333-8444-555555555555/review';
    expect((await call(port, path, { method: 'POST', headers: { 'x-ops-token': token, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    const preflight = await call(port, path, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-ops-token' } });
    expect(preflight.status).toBe(401);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-headers']).toBeUndefined();
    const form = await call(port, path, { method: 'POST', headers: { origin, 'x-ops-token': token, 'content-type': 'text/plain' }, body: 'a=b' });
    expect(form.status).toBe(400);
    expect(JSON.parse(form.body)).toMatchObject({ error: 'invalid_body' });
  });
});
