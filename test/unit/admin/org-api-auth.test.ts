/**
 * 조직 API 키 표면(`/org-api/v1/*`, 확장성 P1 R-6)의 **인증 문턱** — DB 없이(가짜 풀). 실제 키 조회·생성·감사는
 * `test/integration/admin/org-keys.test.ts`.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - admin 라우터가 `/org-api/*` 를 조직 키 표로 넘긴다(쿠키 세션 표로 가면 401 `unauthenticated` 가 아니라 404·세션 규칙이 된다).
 *   - `Origin` 이 있으면 403 `origin_forbidden` — Bearer 가 맞아도(브라우저 요청 거부).
 *   - Bearer 없음 · 쿠키만 · 에이전트 토큰 · 모양 아닌 키 → 401 `unauthenticated` 이고 **DB 를 부르지 않는다**.
 *   - 모양이 맞는 키는 해시로만 조회한다(평문이 SQL 파라미터에 실리지 않는다) · 모르는 키 401.
 *   - 권한 없는 라우트 403 `forbidden_capability {required}`(대상 조회 전).
 *   - 모르는 경로 404 · 메서드 405.
 *   - 발급 키: 접두사 `atk_org_` + 43자 · 해시 = sha256(평문) · hint = 끝 4자 · 매번 다르다.
 *   - api 호스트 인증(`src/api/auth.ts`)은 `atk_org_` 를 안내와 함께 401(에이전트 토큰 저장소를 부르지 않는다).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { SESSION_COOKIE, type AdminHttpEvent } from '../../../src/admin/http';
import { ORG_API_ROUTES } from '../../../src/admin/org-api/router';
import { routeAdminEvent } from '../../../src/admin/router';
import { authenticateRequest } from '../../../src/api/auth';
import { createInMemoryContentStore } from '../../../src/api/content-store';
import { hashOrgApiKey, isOrgApiKeyShape, issueOrgApiKey, ORG_API_KEY_PREFIX } from '../../../src/identity/org-api-key';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const WINDOW_SQL = /INSERT INTO org_api_request_windows/;

/**
 * 쿼리를 기록하고, 인증 SELECT 에는 `rows` 를, 창 계수(ADR-0010 L5)에는 `window` 를 돌려주는 가짜 풀. `/org-api` 는 풀 대기 상한
 * (`pool-wait.ts`)으로 `connect()` 를 거쳐 빌린다 — 같은 기록기를 준다.
 */
function fakeDeps(
  rows: readonly Record<string, unknown>[] = [],
  window: Record<string, unknown> = { key_n: 1, other_n: 0, retry_after: 30 },
): { deps: AdminDependencies; queries: Recorded[] } {
  const queries: Recorded[] = [];
  const query = (sql: string, params: readonly unknown[] = []) => {
    queries.push({ sql, params });
    if (/FROM org_api_keys k WHERE k\.token_hash/.test(sql)) return Promise.resolve({ rows, rowCount: rows.length });
    if (WINDOW_SQL.test(sql)) return Promise.resolve({ rows: [window], rowCount: 1 });
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  const pool = { query, connect: () => Promise.resolve({ query, release() {} }) } as unknown as Pool;
  return {
    queries,
    deps: {
      pool,
      loginKeys: parseHmacKeyring(`k1:${randomBytes(32).toString('base64url')}`, 'TEST'),
      custody: () => {
        throw new Error('custody 를 부르면 안 된다');
      },
      outboundContent: createInMemoryContentStore(),
      now: () => new Date(),
    },
  };
}

function event(method: string, path: string, headers: Record<string, string> = {}, cookies: string[] = []): AdminHttpEvent {
  return {
    rawPath: path,
    headers,
    cookies,
    isBase64Encoded: false,
    requestContext: { requestId: `req-${randomUUID()}`, stage: '$default', http: { method, sourceIp: '198.51.100.7' } },
  };
}

const VALID = `${ORG_API_KEY_PREFIX}${'A'.repeat(43)}`;

async function send(deps: AdminDependencies, e: AdminHttpEvent): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await routeAdminEvent(deps, e);
  return { status: result.statusCode, body: JSON.parse(result.body) as Record<string, unknown> };
}

describe('조직 키 형식', () => {
  it('접두사·길이·해시·끝 4자 · 매번 다르다', () => {
    const a = issueOrgApiKey();
    const b = issueOrgApiKey();
    expect(a.plaintext).toMatch(/^atk_org_[A-Za-z0-9_-]{43}$/);
    expect(isOrgApiKeyShape(a.plaintext)).toBe(true);
    expect(a.keyHash).toBe(createHash('sha256').update(a.plaintext, 'utf8').digest('hex'));
    expect(hashOrgApiKey(a.plaintext)).toBe(a.keyHash);
    expect(a.hint).toBe(a.plaintext.slice(-4));
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(isOrgApiKeyShape(`atk_agent_${'A'.repeat(43)}`)).toBe(false);
  });
});

describe('/org-api 인증 문턱', () => {
  it('표: 경로 여덟 · 권한 셋(도메인 다섯은 domains:manage — ADR-0014 M3b)', () => {
    expect(ORG_API_ROUTES.map((route) => `${route.method} ${route.path} ${route.capability}`)).toEqual([
      'GET /org-api/v1/agents agents:read',
      'GET /org-api/v1/agents/{agentId} agents:read',
      'POST /org-api/v1/agents agents:create',
      'GET /org-api/v1/domains domains:manage',
      'POST /org-api/v1/domains domains:manage',
      'GET /org-api/v1/domains/{domainId} domains:manage',
      'POST /org-api/v1/domains/{domainId}/check domains:manage',
      'DELETE /org-api/v1/domains/{domainId} domains:manage',
    ]);
  });

  it('Origin 이 있으면 403 origin_forbidden — 키가 있어도, DB 0', async () => {
    const { deps, queries } = fakeDeps();
    for (const origin of ['https://console.atmark.ai', 'https://evil.example', 'null']) {
      const result = await send(deps, event('GET', '/org-api/v1/agents', { origin, authorization: `Bearer ${VALID}` }));
      expect(result.status).toBe(403);
      expect(result.body['error']).toBe('origin_forbidden');
    }
    expect(queries).toHaveLength(0);
  });

  it('Bearer 없음·쿠키만·에이전트 토큰·모양 아닌 키 → 401 unauthenticated, DB 0', async () => {
    const { deps, queries } = fakeDeps();
    const cases: AdminHttpEvent[] = [
      event('GET', '/org-api/v1/agents'),
      event('GET', '/org-api/v1/agents', {}, [`${SESSION_COOKIE}=whatever`]),
      event('GET', '/org-api/v1/agents', { authorization: `Bearer atk_agent_${'B'.repeat(43)}` }),
      event('GET', '/org-api/v1/agents', { authorization: `Bearer ${ORG_API_KEY_PREFIX}short` }),
      event('GET', '/org-api/v1/agents', { authorization: `Basic ${VALID}` }),
      event('POST', '/org-api/v1/agents', { authorization: `Bearer ${VALID} extra` }),
    ];
    for (const e of cases) {
      const result = await send(deps, e);
      expect(result.status, JSON.stringify(e.headers)).toBe(401);
      expect(result.body['error']).toBe('unauthenticated');
    }
    expect(queries).toHaveLength(0);
  });

  it('모양이 맞는 키는 해시로만 조회 · 모르는 키 401', async () => {
    const { deps, queries } = fakeDeps([]);
    const result = await send(deps, event('GET', '/org-api/v1/agents', { authorization: `Bearer ${VALID}` }));
    expect(result.status).toBe(401);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.params).toEqual([hashOrgApiKey(VALID)]);
    expect(JSON.stringify(queries)).not.toContain(VALID);
  });

  it('권한 없는 라우트 403 forbidden_capability — 대상 조회 전', async () => {
    const principal = { id: randomUUID(), organization_id: randomUUID(), capabilities: ['agents:read'] };
    const { deps, queries } = fakeDeps([principal]);
    const result = await send(deps, event('POST', '/org-api/v1/agents', { authorization: `Bearer ${VALID}`, 'content-type': 'application/json' }));
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: 'forbidden_capability', required: 'agents:create' });
    // 인증 조회 + 창 계수(L5 — 권한 없는 요청도 센다)뿐 — 에이전트·프로비저닝을 건드리지 않는다.
    expect(queries.filter((query) => !/FROM org_api_keys k WHERE k\.token_hash/.test(query.sql) && !WINDOW_SQL.test(query.sql))).toHaveLength(0);
    expect(queries.filter((query) => WINDOW_SQL.test(query.sql))).toHaveLength(1);
  });

  it('창 상한(ADR-0010 L5) — 키 상한(key_n NULL)·조직 합 초과 → 429 rate_limited + Retry-After, 권한·대상 조회 전', async () => {
    const principal = { id: randomUUID(), organization_id: randomUUID(), capabilities: ['agents:read', 'agents:create'] };
    for (const window of [
      { key_n: null, other_n: 0, retry_after: 17 },
      { key_n: 5, other_n: 116, retry_after: 17 },
    ]) {
      const { deps, queries } = fakeDeps([principal], window);
      const result = await routeAdminEvent(deps, event('GET', '/org-api/v1/agents', { authorization: `Bearer ${VALID}` }));
      expect(result.statusCode, JSON.stringify(window)).toBe(429);
      expect((JSON.parse(result.body) as { error: string }).error).toBe('rate_limited');
      expect(result.headers['retry-after']).toBe('17');
      // 계수 파라미터: 키 id · 조직 id · 키 상한 60.
      expect(queries.find((query) => WINDOW_SQL.test(query.sql))?.params).toEqual([principal.id, principal.organization_id, 60]);
      expect(queries.filter((query) => !/FROM org_api_keys k WHERE k\.token_hash/.test(query.sql) && !WINDOW_SQL.test(query.sql))).toHaveLength(0);
    }
    // 경계: 조직 합이 정확히 120 이면 통과.
    const { deps } = fakeDeps([principal], { key_n: 60, other_n: 60, retry_after: 17 });
    expect((await routeAdminEvent(deps, event('GET', '/org-api/v1/agents', { authorization: `Bearer ${VALID}` }))).statusCode).toBe(200);
  });

  it('풀 대기 상한(ADR-0010 L5) — 커넥션이 1초 안에 안 오면 503 database_busy + Retry-After: 1 · 늦게 온 커넥션은 돌려준다', async () => {
    vi.useFakeTimers();
    try {
      let release: (() => void) | undefined;
      let released = 0;
      const late = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { deps } = fakeDeps();
      const slow = {
        ...deps,
        pool: { connect: () => late.then(() => ({ query: () => Promise.resolve({ rows: [] }), release: () => (released += 1) })) } as unknown as Pool,
      };
      const pending = routeAdminEvent(slow, event('GET', '/org-api/v1/agents', { authorization: `Bearer ${VALID}` }));
      await vi.advanceTimersByTimeAsync(999);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.statusCode).toBe(503);
      expect((JSON.parse(result.body) as { error: string }).error).toBe('database_busy');
      expect(result.headers['retry-after']).toBe('1');
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(released).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('모르는 경로 404 · 메서드 405', async () => {
    const { deps } = fakeDeps();
    expect((await send(deps, event('GET', '/org-api/v2/agents', { authorization: `Bearer ${VALID}` }))).status).toBe(404);
    expect((await send(deps, event('GET', '/org-api', { authorization: `Bearer ${VALID}` }))).status).toBe(404);
    const wrong = await send(deps, event('DELETE', '/org-api/v1/agents', { authorization: `Bearer ${VALID}` }));
    expect(wrong.status).toBe(405);
  });

  it('콘솔 /api/* 는 조직 키 Bearer 를 여전히 401 로 거부한다', async () => {
    const { deps, queries } = fakeDeps();
    const result = await send(deps, event('GET', '/api/agents', { authorization: `Bearer ${VALID}` }));
    expect(result.status).toBe(401);
    expect(queries).toHaveLength(0);
  });
});

describe('api 호스트는 조직 키를 받지 않는다', () => {
  it('atk_org_ → 401 + 안내, 저장소를 부르지 않는다', async () => {
    let looked = 0;
    const store = {
      findByHash() {
        looked += 1;
        return Promise.resolve(null);
      },
    };
    const outcome = await authenticateRequest(
      store as never,
      { method: 'GET', path: '/v1/messages', headers: { authorization: `Bearer ${VALID}` }, query: {}, body: undefined } as never,
      new Date(),
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.response.status).toBe(401);
    expect(JSON.stringify(outcome.response)).toContain('console.atmark.ai/org-api');
    expect(looked).toBe(0);
  });
});
