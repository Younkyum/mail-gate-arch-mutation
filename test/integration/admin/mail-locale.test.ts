/**
 * 시스템 메일 언어(202610101000 · 2026-10-10 진윤겸 결정 — 한 통에 한 언어 · 기본 영어) — **실제 Postgres 위에서**, 실메일 0(가짜 SES).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 등록부(`SUPPORTED_MAIL_LOCALES`)와 DB 조회 표(`mail_locales`)가 같은 집합 · 모르는 언어는 FK 가 막는다(모든 롤).
 *   - 콘솔 `GET/PATCH /api/me/preferences` — 기본 en(chosen:false) · 본인 행만 · CSRF · 등록부 밖은 400 `invalid_mail_locale`.
 *     admin 롤은 `users.mail_locale` 한 칸만 바꾼다(다른 칸 · 다른 사용자 행은 콘솔 경로가 없다).
 *   - 로그인 메일은 받는 사용자의 설정으로 한 언어(코드만) — 바꾸면 다음 메일부터.
 *   - 가입 확정이 가입 양식 언어를 사용자 설정으로 한 번 옮긴다(이미 고른 값은 덮지 않는다).
 *   - 앱 롤의 정의자 함수 둘: 조직 멤버 · 주 소유자의 설정만(`atmark_org_mail_locales`) · 활성 운영자의 설정만(`atmark_operator_mail_locale`).
 *     앱 롤은 여전히 users 를 읽지 못한다.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOGIN_BROWSER_COOKIE, SESSION_COOKIE, SIGNUP_BROWSER_COOKIE } from '../../../src/admin/http';
import { SUPPORTED_MAIL_LOCALES } from '../../../src/i18n/locales';
import {
  adminDeps,
  adminRolePool,
  appPool,
  authed,
  AVAILABLE,
  call,
  cookieValue,
  drainLoginMail,
  LOGIN_KEYS,
  login,
  loginMailerPool,
  mailText,
  newOrganization,
  ownerPool,
  suffix,
  uniqueCodeIp,
  userIdOf,
} from './support';
import { seedLiveInvite, signupCodeOf } from '../signup/support';

describe.skipIf(!AVAILABLE)('시스템 메일 언어', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let app: Pool;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
    app = appPool();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), mailer.end(), app.end()]);
  });

  const deps = () => adminDeps(admin);

  it('등록부 = DB 조회 표 · 모르는 언어는 FK 가 막는다(소유자 롤도)', async () => {
    const rows = await owner.query<{ code: string }>('SELECT code FROM mail_locales ORDER BY code');
    expect(rows.rows.map((row) => row.code)).toEqual([...SUPPORTED_MAIL_LOCALES].sort());
    const org = await newOrganization(owner);
    const userId = await userIdOf(owner, org.ownerEmail);
    await expect(owner.query(`UPDATE users SET mail_locale = 'fr' WHERE id = $1`, [userId])).rejects.toMatchObject({ code: '23503' });
    await expect(owner.query(`DELETE FROM mail_locales WHERE code = 'ko'`)).rejects.toThrow();
  });

  it('GET/PATCH /api/me/preferences — 기본 en · 본인 행만 · CSRF 필수 · 등록부 밖은 400 · 로그인 메일이 다음부터 그 언어', async () => {
    const org = await newOrganization(owner);
    const session = await login(deps(), mailer, org, uniqueCodeIp());

    const initial = await call(deps(), 'GET', '/api/me/preferences', authed(session));
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ mailLocale: 'en', chosen: false, supported: ['en', 'ko'] });

    // CSRF 없는 변경은 403(쿠키만으로는 바꾸지 못한다).
    expect((await call(deps(), 'PATCH', '/api/me/preferences', { body: { mailLocale: 'ko' }, cookies: session.cookies })).statusCode).toBe(403);
    for (const bad of ['fr', 'KO', '', null, 42, ['ko']]) {
      const rejected = await call(deps(), 'PATCH', '/api/me/preferences', authed(session, { body: { mailLocale: bad } }));
      expect(rejected.statusCode, JSON.stringify(bad)).toBe(400);
      expect(rejected.json()).toMatchObject({ error: 'invalid_mail_locale' });
    }
    const changed = await call(deps(), 'PATCH', '/api/me/preferences', authed(session, { body: { mailLocale: 'ko' } }));
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toEqual({ mailLocale: 'ko', chosen: true, supported: ['en', 'ko'] });
    expect((await call(deps(), 'GET', '/api/me/preferences', authed(session))).json()).toMatchObject({ mailLocale: 'ko', chosen: true });
    const userId = await userIdOf(owner, org.ownerEmail);
    expect((await owner.query('SELECT mail_locale FROM users WHERE id = $1', [userId])).rows).toEqual([{ mail_locale: 'ko' }]);

    // 다음 로그인 메일은 한국어 한 통 · 코드만.
    const requested = await call(deps(), 'POST', '/api/login', { body: { email: org.ownerEmail }, ip: uniqueCodeIp() });
    expect(requested.statusCode).toBe(202);
    const [koMail] = await drainLoginMail(mailer, org.id);
    const koText = koMail === undefined ? '' : mailText(koMail);
    expect(koText).toContain('로그인 화면에 입력해 주세요.');
    expect(koText).not.toContain('Enter this code');
    expect(koText).not.toMatch(/https?:\/\//);
    expect(cookieValue(requested, LOGIN_BROWSER_COOKIE)).toBeDefined();

    // 되돌리면 영어.
    expect((await call(deps(), 'PATCH', '/api/me/preferences', authed(session, { body: { mailLocale: 'en' } }))).statusCode).toBe(200);
    await call(deps(), 'POST', '/api/login', { body: { email: org.ownerEmail }, ip: uniqueCodeIp() });
    const [enMail] = await drainLoginMail(mailer, org.id);
    const enText = enMail === undefined ? '' : mailText(enMail);
    expect(enText).toContain('Enter this code to log in.');
    expect(enText).not.toMatch(/[가-힣]/);
  });

  it('admin 롤은 users.mail_locale 한 칸만 — 주소 · 지운 시각은 못 바꾼다 · 로그인 메일 롤은 읽기만 · 앱 롤은 users 를 읽지 못한다', async () => {
    const org = await newOrganization(owner);
    const userId = await userIdOf(owner, org.ownerEmail);
    await admin.query(`UPDATE users SET mail_locale = 'ko' WHERE id = $1`, [userId]);
    await expect(admin.query(`UPDATE users SET email = $2 WHERE id = $1`, [userId, `x-${suffix()}@example.com`])).rejects.toMatchObject({ code: '42501' });
    await expect(admin.query(`UPDATE users SET erased_at = now() WHERE id = $1`, [userId])).rejects.toMatchObject({ code: '42501' });
    expect((await mailer.query('SELECT mail_locale FROM users WHERE id = $1', [userId])).rows).toEqual([{ mail_locale: 'ko' }]);
    await expect(mailer.query(`UPDATE users SET mail_locale = 'en' WHERE id = $1`, [userId])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('SELECT mail_locale FROM users LIMIT 1')).rejects.toMatchObject({ code: '42501' });
  });

  it('atmark_org_mail_locales(앱 롤) — 그 조직의 멤버 · 주 소유자의 고른 언어만 · 다른 조직 · 모르는 주소는 없다', async () => {
    const org = await newOrganization(owner);
    const other = await newOrganization(owner);
    await owner.query(`UPDATE users SET mail_locale = 'ko' WHERE email = ANY($1::text[])`, [[org.ownerEmail, other.ownerEmail]]);
    const rows = await app.query<{ email: string; mail_locale: string }>('SELECT email, mail_locale FROM atmark_org_mail_locales($1, $2::text[]) ORDER BY email', [
      org.id,
      [org.ownerEmail, other.ownerEmail, `nobody-${suffix()}@example.com`],
    ]);
    expect(rows.rows).toEqual([{ email: org.ownerEmail, mail_locale: 'ko' }]);
    // 고르지 않은 사용자는 행이 없다(알림기가 en 으로).
    await owner.query('UPDATE users SET mail_locale = NULL WHERE email = $1', [org.ownerEmail]);
    expect((await app.query('SELECT 1 FROM atmark_org_mail_locales($1, $2::text[])', [org.id, [org.ownerEmail]])).rowCount).toBe(0);
  });

  it('atmark_operator_mail_locale(앱 롤) — 활성 운영자의 사용자 주소일 때만 그 언어 · 아니면 NULL', async () => {
    const org = await newOrganization(owner);
    await owner.query(`UPDATE users SET mail_locale = 'ko' WHERE email = $1`, [org.ownerEmail]);
    const ask = async (email: string): Promise<string | null> =>
      (await app.query<{ locale: string | null }>('SELECT atmark_operator_mail_locale($1) AS locale', [email])).rows[0]?.locale ?? null;
    expect(await ask(org.ownerEmail)).toBeNull();
    const operator = await owner.query<{ id: string }>(`INSERT INTO ops_operators (email, status, origin) VALUES ($1, 'active', 'cli') RETURNING id`, [org.ownerEmail]);
    expect(await ask(org.ownerEmail)).toBe('ko');
    expect(await ask(`  ${org.ownerEmail.toUpperCase()} `)).toBe('ko');
    await owner.query(`UPDATE ops_operators SET status = 'revoked' WHERE id = $1`, [operator.rows[0]?.id]);
    expect(await ask(org.ownerEmail)).toBeNull();
  });

  it('가입 확정이 가입 양식 언어를 사용자 설정으로 한 번 옮긴다', async () => {
    const email = `locale-${suffix()}${suffix()}@example.com`;
    await seedLiveInvite(email);
    const requested = await call(deps(), 'POST', '/api/signup', {
      body: { email, organizationName: `Locale ${suffix()}`, consent: true, lang: 'ko' },
      ip: uniqueCodeIp(),
    });
    expect(requested.statusCode, requested.body).toBe(202);
    const link = (await owner.query<{ id: string; expires_at: Date }>('SELECT id, expires_at FROM signup_links WHERE email = $1', [email])).rows[0];
    if (link === undefined) throw new Error('가입 행이 없다');
    const verified = await call(deps(), 'POST', '/api/signup/verify', {
      body: { code: await signupCodeOf(owner, LOGIN_KEYS, link) },
      cookies: { [SIGNUP_BROWSER_COOKIE]: cookieValue(requested, SIGNUP_BROWSER_COOKIE) ?? '' },
      ip: uniqueCodeIp(),
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect((await owner.query('SELECT mail_locale FROM users WHERE email = $1', [email])).rows).toEqual([{ mail_locale: 'ko' }]);
    const session = cookieValue(verified, SESSION_COOKIE) ?? '';
    const prefs = await call(deps(), 'GET', '/api/me/preferences', { cookies: { [SESSION_COOKIE]: session } });
    expect(prefs.json()).toMatchObject({ mailLocale: 'ko', chosen: true });
  });
});
