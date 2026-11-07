/**
 * 고객 도메인 계약 SQLSTATE(`DOMAIN_SQLSTATES` — P0A01~P0A10)는 **어느 것도 500 이 아니다**(ADR-0014 단계 4 M3b). DB 없음 — 가짜 풀이 세션 조회
 * (또는 조직 키 인증)만 답하고 그다음 SQL 에서 그 SQLSTATE 를 던진다. 콘솔 라우터 · 조직 API 라우터 둘 다 코드별 상수 몸통으로 번역해야 한다
 * (DB 메시지 — 도메인 이름 · 주소 — 를 싣지 않는다). 새 코드를 계약에 더하고 번역표를 잊으면 여기서 빨개진다.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { SESSION_COOKIE } from '../../../src/admin/http';
import { DOMAIN_SQLSTATE_REJECTIONS, domainSqlStateRejection } from '../../../src/admin/ops/errors';
import { routeAdminEvent } from '../../../src/admin/router';
import { csrfTokenOf } from '../../../src/admin/session';
import { createInMemoryContentStore } from '../../../src/api/content-store';
import { DOMAIN_API_ERRORS, DOMAIN_SQLSTATES } from '../../../src/domains/contract';
import { ORG_API_KEY_PREFIX } from '../../../src/identity/org-api-key';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';

const SECRET_DETAIL = 'agents.secret-customer.example sales@agents.secret-customer.example';

function pgError(code: string): Error {
  return Object.assign(new Error(`custom_domains: ${SECRET_DETAIL}`), { code });
}

function deps(code: string): AdminDependencies {
  const query = (sql: string) => {
    if (/FROM owner_sessions s\s+JOIN memberships m/.test(sql)) {
      return Promise.resolve({
        rows: [{ id: '11111111-1111-4111-8111-111111111111', organization_id: '22222222-2222-4222-8222-222222222222', user_id: '33333333-3333-4333-8333-333333333333', role: 'owner' }],
        rowCount: 1,
      });
    }
    if (/FROM org_api_keys k WHERE k\.token_hash/.test(sql)) {
      const row = { id: '44444444-4444-4444-8444-444444444444', organization_id: '22222222-2222-4222-8222-222222222222', capabilities: ['domains:manage'] };
      return Promise.resolve({ rows: [row], rowCount: 1 });
    }
    if (/INSERT INTO org_api_request_windows/.test(sql)) return Promise.resolve({ rows: [{ key_n: 1, other_n: 0, retry_after: 30 }], rowCount: 1 });
    if (/UPDATE org_api_keys SET last_used_at/.test(sql)) return Promise.resolve({ rows: [], rowCount: 1 });
    return Promise.reject(pgError(code));
  };
  const pool = { query, connect: () => Promise.resolve({ query, release() {} }) } as unknown as Pool;
  return {
    pool,
    loginKeys: parseHmacKeyring(`k1:${randomBytes(32).toString('base64url')}`, 'TEST'),
    custody: () => {
      throw new Error('custody 를 부르면 안 된다');
    },
    outboundContent: createInMemoryContentStore(),
    now: () => new Date(),
  };
}

async function consoleList(code: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = `atk_admin_${randomBytes(32).toString('base64url')}`;
  const result = await routeAdminEvent(deps(code), {
    rawPath: '/api/domains',
    headers: { 'x-atmark-csrf': csrfTokenOf(token) },
    cookies: [`${SESSION_COOKIE}=${token}`],
    requestContext: { requestId: `req-${randomUUID()}`, stage: '$default', http: { method: 'GET', sourceIp: '198.51.100.7' } },
  });
  return { status: result.statusCode, body: JSON.parse(result.body) as Record<string, unknown> };
}

async function orgApiList(code: string): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }> {
  const result = await routeAdminEvent(deps(code), {
    rawPath: '/org-api/v1/domains',
    headers: { authorization: `Bearer ${ORG_API_KEY_PREFIX}${'A'.repeat(43)}` },
    cookies: [],
    requestContext: { requestId: `req-${randomUUID()}`, stage: '$default', http: { method: 'GET', sourceIp: '198.51.100.7' } },
  });
  return { status: result.statusCode, body: JSON.parse(result.body) as Record<string, unknown>, headers: result.headers };
}

describe('고객 도메인 SQLSTATE 번역 — 500 없음', () => {
  const codes = Object.values(DOMAIN_SQLSTATES);

  it('계약의 SQLSTATE 전부에 번역이 있다(번역표 = 계약 코드 집합)', () => {
    expect(Object.keys(DOMAIN_SQLSTATE_REJECTIONS).sort()).toEqual([...codes].sort());
    for (const code of codes) expect(domainSqlStateRejection(pgError(code)), code).not.toBeNull();
    expect(domainSqlStateRejection(pgError('23505'))).toBeNull();
    expect(domainSqlStateRejection(new Error('no code'))).toBeNull();
  });

  it('계약이 이름 붙인 코드는 계약의 API 코드로 — P0A05 400 domain_not_verified · P0A07 403 feature_not_enabled · P0A09 429 · P0A08 400 · P0A01 은 중립 409', () => {
    const at = (code: string) => DOMAIN_SQLSTATE_REJECTIONS[code];
    expect(at(DOMAIN_SQLSTATES.domainNotVerified)).toMatchObject({ status: 400, code: DOMAIN_API_ERRORS.domainNotVerified });
    expect(at(DOMAIN_SQLSTATES.featureNotEnabled)).toMatchObject({ status: 403, code: DOMAIN_API_ERRORS.featureNotEnabled });
    expect(at(DOMAIN_SQLSTATES.primaryRateLimited)).toMatchObject({ status: 429, code: 'primary_change_rate_limited' });
    expect(at(DOMAIN_SQLSTATES.primaryNotAllowed)).toMatchObject({ status: 400, code: 'primary_not_eligible' });
    expect(at(DOMAIN_SQLSTATES.addressCeiling)).toMatchObject({ status: 409 });
    expect(at(DOMAIN_SQLSTATES.primaryOnCustomDomain)).toMatchObject({ status: 400 });
    expect(at(DOMAIN_SQLSTATES.mailIdentityConflict)).toMatchObject({ status: 409, code: 'address_taken' });
    // 앵커 이름 충돌은 앱이 삼키는 코드 — 새어 나와도 같은 중립 409(존재를 밝히지 않는다).
    expect(at(DOMAIN_SQLSTATES.anchorNameConflict)).toMatchObject({ status: 409, code: 'address_taken' });
  });

  it.each(Object.entries(DOMAIN_SQLSTATES))('콘솔 라우터: %s(%s) → 번역된 상태 · DB 메시지를 싣지 않는다', async (_name, code) => {
    const result = await consoleList(code);
    expect(result.status).not.toBe(500);
    expect(result.status).toBe(DOMAIN_SQLSTATE_REJECTIONS[code]?.status);
    expect(result.body['error']).toBe(DOMAIN_SQLSTATE_REJECTIONS[code]?.code);
    expect(JSON.stringify(result.body)).not.toContain('secret-customer');
  });

  it.each(Object.entries(DOMAIN_SQLSTATES))('조직 API 라우터: %s(%s) → 번역된 상태(429 는 Retry-After) · DB 메시지를 싣지 않는다', async (_name, code) => {
    const result = await orgApiList(code);
    expect(result.status).not.toBe(500);
    expect(result.status).toBe(DOMAIN_SQLSTATE_REJECTIONS[code]?.status);
    expect(result.body['error']).toBe(DOMAIN_SQLSTATE_REJECTIONS[code]?.code);
    if (result.status === 429) expect(result.headers['retry-after']).toBe('60');
    expect(JSON.stringify(result.body)).not.toContain('secret-customer');
  });
});
