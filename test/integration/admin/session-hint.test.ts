/**
 * **세션 힌트 `GET /api/session/hint` — 실제 Postgres 위에서**(2026-09-30). 라우터는 `atmark_admin` 롤로 돈다. DB 없이 되는 규칙(쿠키 없음·
 * 모양 아닌 쿠키·CORS 헤더·메서드)은 `test/unit/admin/cross-site-auth.test.ts` 의 힌트 묶음.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 살아 있는 세션 → `{signedIn:true}` · 로그아웃(폐기)한 세션 → false · 만료된 세션 → false(같은 모양의 살아 있는 대조 행은 true)
 *   - 본문은 `signedIn` 키 하나뿐(사용자·조직·CSRF 없음) · `Set-Cookie` 없음 · `no-store` · `Vary: Origin`
 *   - 세션을 늘리지 않고 DB 에 쓰지 않는다 — 문장은 SELECT 하나, 세션 행(`expires_at`·`revoked_at`)은 그대로
 *   - 홈 출처(스위치 켬)에만 CORS 두 줄
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE, SESSION_HINT_PATH, SITE_CORS_ENV } from '../../../src/admin/http';
import { adminDeps, adminRolePool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, userIdOf } from './support';

const SITE = 'https://atmark.ai';
const CORS_KEYS = /^access-control-/;
const corsHeaders = (headers: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([key]) => CORS_KEYS.test(key)));

describe.skipIf(!AVAILABLE)('세션 힌트 — atmark_admin 롤', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
  });
  beforeEach(() => {
    vi.stubEnv(SITE_CORS_ENV, 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), mailer.end()]);
  });

  /** 라우터가 부른 SQL 을 적는 풀(admin 롤 그대로) — 힌트가 쓰지 않는다는 증거. */
  function recording(): { readonly pool: Pool; readonly sql: string[] } {
    const sql: string[] = [];
    const pool = {
      query: (text: string, values?: unknown[]) => {
        sql.push(text);
        return admin.query(text, values);
      },
    } as unknown as Pool;
    return { pool, sql };
  }

  const hint = (pool: Pool, cookies: Record<string, string>, origin?: string) =>
    call(adminDeps(pool), 'GET', SESSION_HINT_PATH, { cookies, ...(origin === undefined ? {} : { headers: { origin } }) });

  const sessionRow = async (token: string) =>
    (
      await owner.query<{ expires_at: Date; revoked_at: Date | null }>('SELECT expires_at, revoked_at FROM owner_sessions WHERE token_hash = $1', [
        createHash('sha256').update(token, 'utf8').digest('hex'),
      ])
    ).rows[0];

  it('살아 있는 세션 → 200 {signedIn:true} 뿐 · Set-Cookie 없음 · no-store · 홈 출처 CORS · SELECT 하나 · 세션 행 그대로', async () => {
    const organization = await newOrganization(owner);
    const session = await login(adminDeps(admin), mailer, organization);
    const before = await sessionRow(session.token);
    expect(before?.revoked_at).toBeNull();

    const rec = recording();
    const res = await hint(rec.pool, session.cookies, SITE);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"signedIn":true}');
    expect(res.cookies).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['vary']).toBe('Origin');
    expect(corsHeaders(res.headers)).toEqual({ 'access-control-allow-origin': SITE, 'access-control-allow-credentials': 'true' });
    // 쓰지 않는다 — 세션 해석 SELECT 한 번뿐.
    expect(rec.sql).toHaveLength(1);
    expect(rec.sql[0]).toMatch(/^\s*SELECT\b/);
    expect(rec.sql[0]).toMatch(/FROM owner_sessions s/);
    // 세션을 늘리지 않는다.
    expect(await sessionRow(session.token)).toEqual(before);

    // 콘솔 자기 출처(Origin 없음)도 같은 본문 · CORS 두 줄 없음.
    const same = await hint(admin, session.cookies);
    expect([same.statusCode, same.body]).toEqual([200, '{"signedIn":true}']);
    expect(corsHeaders(same.headers)).toEqual({});
  });

  it('로그아웃(폐기)한 세션 → {signedIn:false} · Set-Cookie 없음', async () => {
    const organization = await newOrganization(owner);
    const deps = adminDeps(admin);
    const session = await login(deps, mailer, organization);
    const out = await call(deps, 'POST', '/api/logout', authed(session));
    expect(out.statusCode).toBe(204);
    expect((await sessionRow(session.token))?.revoked_at).not.toBeNull();

    const res = await hint(admin, session.cookies, SITE);
    expect([res.statusCode, res.body]).toEqual([200, '{"signedIn":false}']);
    expect(res.cookies).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBe(SITE);
  });

  it('만료된 세션 → {signedIn:false} (같은 조직·사용자의 살아 있는 대조 행은 true)', async () => {
    const organization = await newOrganization(owner);
    const user = await userIdOf(owner, organization.ownerEmail);
    // 세션 행의 만료는 고칠 수 없다(트리거 — 바뀌는 것은 revoked_at 하나). 그래서 과거에 태어나 이미 만료된 행을 소유자 롤로 넣는다.
    const insert = async (createdAgo: string, expiresAgo: string): Promise<string> => {
      const token = `atk_admin_${randomBytes(32).toString('base64url')}`;
      const link = await owner.query<{ id: string }>(
        `INSERT INTO owner_login_links (organization_id, user_id, browser_binding, expires_at, next_attempt_at)
         VALUES ($1, $2, $3, date_trunc('milliseconds', now() + interval '10 minutes'), now()) RETURNING id`,
        [organization.id, user, 'e'.repeat(64)],
      );
      await owner.query(
        `INSERT INTO owner_sessions (organization_id, user_id, login_link_id, token_hash, created_at, expires_at)
         VALUES ($1, $2, $3, $4, now() - $5::interval, now() - $6::interval)`,
        [organization.id, user, link.rows[0]?.id, createHash('sha256').update(token, 'utf8').digest('hex'), createdAgo, expiresAgo],
      );
      return token;
    };
    const expired = await insert('2 hours', '1 second');
    const live = await insert('1 minute', '-1 hour');

    const dead = await hint(admin, { [SESSION_COOKIE]: expired }, SITE);
    expect([dead.statusCode, dead.body]).toEqual([200, '{"signedIn":false}']);
    expect(dead.cookies).toBeUndefined();
    const alive = await hint(admin, { [SESSION_COOKIE]: live }, SITE);
    expect([alive.statusCode, alive.body]).toEqual([200, '{"signedIn":true}']);
  });

  it('모양은 맞지만 없는 토큰 → {signedIn:false}', async () => {
    const res = await hint(admin, { [SESSION_COOKIE]: `atk_admin_${randomBytes(32).toString('base64url')}` });
    expect([res.statusCode, res.body]).toEqual([200, '{"signedIn":false}']);
  });
});
