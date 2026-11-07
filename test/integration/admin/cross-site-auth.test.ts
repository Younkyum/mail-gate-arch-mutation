/**
 * **홈(atmark.ai) → 콘솔(console.atmark.ai) 교차 출처 로그인·가입 — 실제 Postgres 위에서**(US-003). 실메일 0(가짜 SES) · AWS 0.
 * 라우터는 `atmark_admin` 롤(운영 admin Lambda 의 롤)로 돈다. DB 없이 되는 규칙(프리플라이트·경로별 출처·리다이렉트 스위치)은
 * `test/unit/admin/cross-site-auth.test.ts`.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 홈 출처의 `POST /api/login`·`/api/signup` → 202 + **정확한** CORS(`https://atmark.ai` · credentials true · Vary: Origin)
 *   - 결속 쿠키가 콘솔 출처 요청과 **같은 속성**(`__Host-` · Path=/ · HttpOnly · Secure · SameSite=Strict · Max-Age)
 *   - 열거 방지: 있는 주소·없는 주소가 홈 출처에서도 같은 상태·본문·헤더·쿠키 모양
 *   - 요청자 상한은 출처와 무관한 **같은 버킷**(로그인 10/15분 · 가입 5/시간) — 429 에도 CORS 헤더(화면이 읽는다)
 *   - 전체 흐름: 홈에서 요청 → 메일 링크 → 콘솔 착지에서 같은 브라우저(결속 쿠키)로 verify → 세션 → `/app`.
 *     verify 는 홈 출처도 받는다(2026-09-28 — 홈 화면이 메일의 코드를 받아 verify 한다 · 코드 흐름은 `login-code.test.ts`) — 결속 쿠키가
 *     없으면 401 이고 CORS 헤더가 붙는다(링크는 살아 있다). 스위치를 켜도 세션이 있으면 `/` → `/app`.
 */

import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTH_ON_SITE_ENV,
  LOGIN_BROWSER_COOKIE,
  SESSION_COOKIE,
  SIGNUP_BROWSER_COOKIE,
  SITE_CORS_ENV,
  type AdminHttpResult,
} from '../../../src/admin/http';
import { LOGIN_REQUESTS_PER_CLIENT, SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR } from '../../../src/security/login-limits';
import {
  adminDeps,
  adminRolePool,
  AVAILABLE,
  call,
  cookieValue,
  drainLoginMail,
  LOGIN_KEYS,
  loginMailerPool,
  newOrganization,
  ownerPool,
  suffix,
  codeFromMail,
  uniqueCodeIp,
} from './support';
import { seedInvitedEmails, signupCodeOf } from '../signup/support';

const SITE = 'https://atmark.ai';
const CONSOLE = 'https://console.atmark.ai';

const uniqueIp = (): string => `198.18.${String(Math.floor(Math.random() * 250))}.${suffix()}${suffix()}`;
const createdEmails: string[] = [];
/** 초대 전용 가입(202609301520) — 살아 있는 초대가 있는 주소를 `beforeAll` 에서 한 번에 심어 두고 꺼내 쓴다. */
let invitedEmails: string[] = [];
const newEmail = (): string => {
  const email = invitedEmails.pop() ?? `xsite-${suffix()}${suffix()}@example.com`;
  createdEmails.push(email);
  return email;
};

/** 쿠키 값만 가린 모양. */
const shape = (cookies: readonly string[] | undefined): string[] => (cookies ?? []).map((c) => c.replace(/=[^;]*;/, '=X;'));
/** 응답에서 요청마다 달라지는 값(쿠키 값)을 뺀 비교용 모양. */
const comparable = (result: AdminHttpResult): unknown => ({
  status: result.statusCode,
  body: result.body,
  headers: result.headers,
  cookies: shape(result.cookies),
});

describe.skipIf(!AVAILABLE)('홈 → 콘솔 교차 출처 로그인·가입 — atmark_admin 롤', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  beforeAll(async () => {
    invitedEmails = await seedInvitedEmails(200, 'xsite');
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
  });
  // 이 파일은 CORS 스위치를 켠 상태(DNS 전환 뒤)를 본다 — 끈 상태(기본)는 `test/unit/admin/cross-site-auth.test.ts` 끝 묶음(검증 F2).
  beforeEach(() => {
    vi.stubEnv(SITE_CORS_ENV, 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await owner.query(
      `UPDATE organizations SET review_status = 'rejected' WHERE owner_email = ANY($1::text[]) AND review_status = 'pending_review'`,
      [createdEmails],
    );
    await Promise.all([owner.end(), admin.end(), mailer.end()]);
  });

  const deps = (): ReturnType<typeof adminDeps> => adminDeps(admin);
  const login = (email: string, origin: string | undefined, ip: string) =>
    call(deps(), 'POST', '/api/login', { body: { email }, ip, ...(origin === undefined ? {} : { headers: { origin } }) });
  const signup = (email: string, origin: string | undefined, ip: string) =>
    call(deps(), 'POST', '/api/signup', {
      body: { email, organizationName: `Acme ${suffix()}`, consent: true },
      ip,
      ...(origin === undefined ? {} : { headers: { origin } }),
    });

  it('로그인: 홈 출처 → 202 {ok:true} · 정확한 CORS · 결속 쿠키 속성은 콘솔 출처 요청과 같다', async () => {
    const organization = await newOrganization(owner);
    const fromSite = await login(organization.ownerEmail, SITE, uniqueIp());
    expect(fromSite.statusCode).toBe(202);
    expect(fromSite.json()).toEqual({ ok: true });
    expect(fromSite.headers['access-control-allow-origin']).toBe('https://atmark.ai');
    expect(fromSite.headers['access-control-allow-credentials']).toBe('true');
    expect(fromSite.headers['vary']).toBe('Origin');
    expect(Object.keys(fromSite.headers).filter((key) => key.startsWith('access-control-')).sort()).toEqual([
      'access-control-allow-credentials',
      'access-control-allow-origin',
    ]);
    expect(shape(fromSite.cookies)).toEqual([`${LOGIN_BROWSER_COOKIE}=X; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`]);

    const fromConsole = await login(organization.ownerEmail, CONSOLE, uniqueIp());
    expect(fromConsole.statusCode).toBe(202);
    expect(shape(fromConsole.cookies)).toEqual(shape(fromSite.cookies));
    expect(fromConsole.headers['access-control-allow-origin']).toBeUndefined();
    // CORS 두 줄 말고는 같은 응답이다.
    const { 'access-control-allow-origin': _o, 'access-control-allow-credentials': _c, ...rest } = fromSite.headers;
    expect(rest).toEqual(fromConsole.headers);
  });

  it('가입: 홈 출처 → 202 · 쿠키 둘(가입 30분 · 로그인 15분)의 속성이 콘솔 출처 요청과 같다 · 정확한 CORS', async () => {
    const fromSite = await signup(newEmail(), SITE, uniqueIp());
    expect(fromSite.statusCode, fromSite.body).toBe(202);
    expect(fromSite.json()).toEqual({ ok: true });
    expect(fromSite.headers['access-control-allow-origin']).toBe('https://atmark.ai');
    expect(fromSite.headers['access-control-allow-credentials']).toBe('true');
    expect(shape(fromSite.cookies)).toEqual([
      `${SIGNUP_BROWSER_COOKIE}=X; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=1800`,
      `${LOGIN_BROWSER_COOKIE}=X; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`,
    ]);
    const fromConsole = await signup(newEmail(), CONSOLE, uniqueIp());
    expect(shape(fromConsole.cookies)).toEqual(shape(fromSite.cookies));
  });

  it('열거 방지(홈 출처): 로그인·가입 모두 있는 주소·없는 주소가 같은 상태·본문·헤더·쿠키 모양', async () => {
    const existing = await newOrganization(owner);
    const unknown = `nobody-${suffix()}${suffix()}@example.com`;
    const loginA = await login(existing.ownerEmail, SITE, uniqueIp());
    const loginB = await login(unknown, SITE, uniqueIp());
    expect(comparable(loginA)).toEqual(comparable(loginB));
    const signupA = await signup(existing.ownerEmail, SITE, uniqueIp());
    const fresh = newEmail();
    const signupB = await signup(fresh, SITE, uniqueIp());
    expect(comparable(signupA)).toEqual(comparable(signupB));
    expect(signupA.statusCode).toBe(202);
  });

  it('폼 언어(lang) → 콘솔 언어 쿠키(메일 링크 착지가 같은 언어) · ko|en 밖은 무시 · 있는 주소·없는 주소 같은 모양', async () => {
    const existing = await newOrganization(owner);
    const withLang = (email: string, lang: unknown) =>
      call(deps(), 'POST', '/api/login', { body: { email, lang }, ip: uniqueIp(), headers: { origin: SITE } });
    const en = await withLang(existing.ownerEmail, 'en');
    expect(en.statusCode).toBe(202);
    expect(shape(en.cookies)).toEqual([
      `${LOGIN_BROWSER_COOKIE}=X; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`,
      '__Host-atmark_lang=X; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000',
    ]);
    expect(en.cookies?.[1]).toMatch(/^__Host-atmark_lang=en;/);
    expect(comparable(en)).toEqual(comparable(await withLang(`nobody-${suffix()}@example.com`, 'en')));
    for (const junk of ['fr', 'EN', 1, null]) expect(shape((await withLang(existing.ownerEmail, junk)).cookies), String(junk)).toHaveLength(1);
    const signupKo = await call(deps(), 'POST', '/api/signup', {
      body: { email: newEmail(), organizationName: `Acme ${suffix()}`, consent: true, lang: 'ko' },
      ip: uniqueIp(),
      headers: { origin: SITE },
    });
    expect(signupKo.statusCode).toBe(202);
    expect(signupKo.cookies?.[2]).toMatch(/^__Host-atmark_lang=ko; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000$/);
  });

  it(`요청자 상한은 출처와 무관한 같은 버킷 — 로그인: 콘솔 5 + 홈 ${String(LOGIN_REQUESTS_PER_CLIENT - 5)} 뒤 홈 출처 429(CORS 헤더 있음)`, async () => {
    const ip = uniqueIp();
    const email = `nobody-${suffix()}@example.com`;
    for (let i = 0; i < 5; i += 1) expect((await login(email, CONSOLE, ip)).statusCode).toBe(202);
    for (let i = 5; i < LOGIN_REQUESTS_PER_CLIENT; i += 1) expect((await login(email, SITE, ip)).statusCode).toBe(202);
    const limited = await login(email, SITE, ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate_limited' });
    expect(limited.headers['access-control-allow-origin']).toBe('https://atmark.ai');
    expect(limited.cookies).toBeUndefined();
    expect((await login(email, CONSOLE, ip)).statusCode).toBe(429);
  });

  it(`요청자 상한 — 가입: 홈 출처 ${String(SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR)}건 202 → 다음은 429(CORS 헤더 있음) · 콘솔 출처도 429`, async () => {
    const ip = uniqueIp();
    for (let i = 0; i < SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR; i += 1) expect((await signup(newEmail(), SITE, ip)).statusCode).toBe(202);
    const limited = await signup(newEmail(), SITE, ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['access-control-allow-origin']).toBe('https://atmark.ai');
    expect((await signup(newEmail(), CONSOLE, ip)).statusCode).toBe(429);
  });

  it('전체 흐름(로그인): 홈에서 요청 → 메일의 코드 → 같은 브라우저로 verify → 세션 → /app · 홈 출처 verify 는 결속 없이 401 + CORS', async () => {
    vi.stubEnv(AUTH_ON_SITE_ENV, 'true');
    const organization = await newOrganization(owner);
    const requested = await login(organization.ownerEmail, SITE, uniqueIp());
    expect(requested.statusCode).toBe(202);
    const nonce = cookieValue(requested, LOGIN_BROWSER_COOKIE) ?? '';
    const mails = await drainLoginMail(mailer, organization.id);
    const mail = mails.at(-1);
    if (mail === undefined) throw new Error('로그인 메일이 나가지 않았다');
    const code = codeFromMail(mail); // 메일에는 코드만(2026-10-10) — 링크가 없다.

    // 홈 출처의 verify 도 받는다(코드 입력 — 2026-09-28). 결속 쿠키가 없으면 DB 전에 401 이고 시도는 태워지지 않는다 · 화면이 읽도록 CORS 헤더.
    const fromSite = await call(deps(), 'POST', '/api/login/verify', { body: { code }, headers: { origin: SITE }, ip: uniqueCodeIp() });
    expect(fromSite.statusCode).toBe(401);
    expect(fromSite.json()).toMatchObject({ error: 'login_browser_missing' });
    expect(fromSite.headers['access-control-allow-origin']).toBe(SITE);

    // 결속 쿠키 없는 브라우저 → 401(시도는 살아 있다).
    const otherBrowser = await call(deps(), 'POST', '/api/login/verify', { body: { code }, headers: { origin: CONSOLE }, ip: uniqueCodeIp() });
    expect(otherBrowser.statusCode).toBe(401);

    const verified = await call(deps(), 'POST', '/api/login/verify', { body: { code }, cookies: { [LOGIN_BROWSER_COOKIE]: nonce }, headers: { origin: CONSOLE }, ip: uniqueCodeIp() });
    expect(verified.statusCode, verified.body).toBe(200);
    const session = cookieValue(verified, SESSION_COOKIE) ?? '';
    expect(session).toMatch(/^atk_admin_/);
    expect((verified.cookies ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`))).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);

    // 스위치 켠 상태에서도 세션이 있으면 / 와 /signup 은 /app, /app 은 200.
    const root = await call(deps(), 'GET', '/', { cookies: { [SESSION_COOKIE]: session } });
    expect([root.statusCode, root.headers['location']]).toEqual([302, '/app']);
    const signupPage = await call(deps(), 'GET', '/signup', { cookies: { [SESSION_COOKIE]: session } });
    expect([signupPage.statusCode, signupPage.headers['location']]).toEqual([302, '/app']);
    const app = await call(deps(), 'GET', '/app', { cookies: { [SESSION_COOKIE]: session } });
    expect(app.statusCode).toBe(200);
    // 비로그인은 홈으로.
    const anonymous = await call(deps(), 'GET', '/');
    expect([anonymous.statusCode, anonymous.headers['location']]).toEqual([302, 'https://atmark.ai/kr/login']);
  });

  it('전체 흐름(가입): 홈에서 요청 → 같은 브라우저로 코드 verify → 세션 · {redirect:"/app"}', async () => {
    const email = newEmail();
    const requested = await signup(email, SITE, uniqueIp());
    expect(requested.statusCode).toBe(202);
    const nonce = cookieValue(requested, SIGNUP_BROWSER_COOKIE) ?? '';
    const link = (
      await owner.query<{ id: string; expires_at: Date }>('SELECT id, expires_at FROM signup_links WHERE email = $1 ORDER BY created_at DESC LIMIT 1', [email])
    ).rows[0];
    if (link === undefined) throw new Error('가입 링크 행이 없다');
    const code = await signupCodeOf(owner, LOGIN_KEYS, link);

    const fromSite = await call(deps(), 'POST', '/api/signup/verify', { body: { code }, headers: { origin: SITE }, ip: uniqueCodeIp() });
    expect(fromSite.statusCode).toBe(401);
    expect(fromSite.json()).toMatchObject({ error: 'signup_browser_missing' });
    expect(fromSite.headers['access-control-allow-origin']).toBe(SITE);
    const verified = await call(deps(), 'POST', '/api/signup/verify', { body: { code }, cookies: { [SIGNUP_BROWSER_COOKIE]: nonce }, headers: { origin: CONSOLE }, ip: uniqueCodeIp() });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toEqual({ redirect: '/app' });
    const session = cookieValue(verified, SESSION_COOKIE) ?? '';
    const app = await call(deps(), 'GET', '/app', { cookies: { [SESSION_COOKIE]: session } });
    expect(app.statusCode).toBe(200);
  });
});
