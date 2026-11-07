/**
 * **관리 API — 실제 Postgres 위에서** (console.atmark.ai, `src/admin/**`). 실메일 0(가짜 SES) · AWS 호출 0.
 *
 * **라우터는 `atmark_admin` 롤(운영 admin Lambda 의 롤)로 돈다**(ADR-0006) — 소유자 롤로 돌리면 202609230720 의
 * GRANT 가 모자라도 전부 초록이다. 조직 생성 같은 테스트 지반만 소유자 롤(`owner`)로 한다.
 *
 * 되돌리면 빨개져야 하는 것(검증 규율):
 *   - 로그인: 일치하는 owner_email 만 링크 행 · 응답은 항상 같은 202 · 문장 수·순서 동일(열거 방지) · 수신자는 DB 의 owner_email
 *   - 링크: 단일 사용 · 만료(토큰·DB 둘 다) · **다른 브라우저 거부**(그리고 그때 링크를 태우지 않는다)
 *   - 세션: 쿠키만 · 에이전트 토큰(Authorization)은 무조건 401 · 세션 쿠키는 api 라우터에서 무효 · 로그아웃이 폐기한다
 *   - CSRF: 모든 변경 요청 · Origin 불일치 403
 *   - 승인 결정 엔드포인트 부재(405·404)
 *   - 조직 범위: 다른 조직의 에이전트는 404
 *   - 감사: owner_actions 1행 · 토큰 평문 없음 · append-only
 *   - 앱 롤 경계: 세션·감사·요청 원장 권한 0 · 링크 행 INSERT 불가 · browser_binding·used_at 읽기 불가
 */

import { createHash } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOGIN_BROWSER_COOKIE, SESSION_COOKIE } from '../../../src/admin/http';
import { ADMIN_ROUTES } from '../../../src/admin/router';
import { csrfTokenOf } from '../../../src/admin/session';
import { LOGIN_LINKS_PER_CLIENT_PER_USER_PER_HOUR, LOGIN_REQUESTS_PER_CLIENT, LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW } from '../../../src/security/login-limits';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories/agent-token-store';
import { OWNER_LOGIN_FROM_ADDRESS } from '../../../src/notify/owner-login-notifier';
import { mintLoginCode } from '../../../src/security/login-code';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { routeHttpApiEvent, type ApiDependencies } from '../../../src/runtime/router';
import {
  adminDeps,
  adminRolePool,
  appPool,
  authed,
  AVAILABLE,
  call,
  cookieValue,
  drainLoginMail,
  login,
  loginMailerPool,
  mailText,
  newOrganization,
  ownerPool,
  codeFromMail,
  uniqueCodeIp,
  userIdOf,
} from './support';

describe.skipIf(!AVAILABLE)('관리 API (console.atmark.ai) — atmark_admin 롤(운영 admin Lambda 의 롤) + 앱 롤 워커', () => {
  let owner: Pool;
  let admin: Pool;
  let app: Pool;
  let mailer: Pool;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    app = appPool();
    mailer = loginMailerPool();
  });
  afterAll(async () => {
    await owner.end();
    await admin.end();
    await app.end();
    await mailer.end();
  });

  // -------------------------------------------------------------------------
  // 로그인
  // -------------------------------------------------------------------------

  it('로그인 전체 흐름: 202 → 앱 롤 워커가 owner_email 로 1통(notify@, console 링크, 프래그먼트) → 같은 브라우저 verify → 세션', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const requested = await call(deps, 'POST', '/api/login', { body: { email: `  ${org.ownerEmail.toUpperCase()} ` } });
    expect(requested.statusCode).toBe(202);
    expect(requested.json()).toEqual({ ok: true });
    const nonceCookie = (requested.cookies ?? []).find((c) => c.startsWith(`${LOGIN_BROWSER_COOKIE}=`)) ?? '';
    expect(nonceCookie).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=900$/);

    const mails = await drainLoginMail(mailer, org.id);
    expect(mails).toHaveLength(1);
    const [mail] = mails;
    expect(mail?.to).toEqual([org.ownerEmail]);
    expect(mail?.from).toBe(OWNER_LOGIN_FROM_ADDRESS);
    const text = mail === undefined ? '' : mailText(mail);
    // 코드만(2026-10-10 링크 로그인 삭제) — 링크 · 서명 토큰이 메일에 없다.
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/atk_login_/);
    expect(text).not.toMatch(/\?/);

    // 두 번째 틱: 같은 링크의 두 번째 메일은 없다.
    expect(await drainLoginMail(mailer, org.id)).toHaveLength(0);

    const verified = await call(deps, 'POST', '/api/login/verify', {
      body: { code: mail === undefined ? '' : codeFromMail(mail) },
      cookies: { [LOGIN_BROWSER_COOKIE]: cookieValue(requested, LOGIN_BROWSER_COOKIE) ?? '' },
      ip: uniqueCodeIp(),
    });
    expect(verified.statusCode).toBe(200);
    const sessionCookie = (verified.cookies ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '';
    expect(sessionCookie).toMatch(/^__Host-atmark_admin=atk_admin_[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);
    expect(sessionCookie).not.toMatch(/Domain=/i);
    const token = cookieValue(verified, SESSION_COOKIE) ?? '';
    // 조직 하나 → next:'app'(둘 이상이면 'select-org' — memberships.test.ts).
    expect(verified.json()).toEqual({ csrf: csrfTokenOf(token), next: 'app' });

    const me = await call(deps, 'GET', '/api/me', { cookies: { [SESSION_COOKIE]: token } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      user: { id: expect.any(String) as string, email: org.ownerEmail },
      // reviewStatus — CLI 로 만든 조직은 active(signup-contract.md §0 · §5). role — 조직 INSERT 트리거가 만든 owner 멤버십.
      organization: { id: org.id, name: expect.any(String) as string, ownerEmail: org.ownerEmail, reviewStatus: 'active', role: 'owner' },
      orgKillSwitch: { ownerPaused: false, platformFrozen: false, active: false },
      // 확장성 P0 R-1 — 이 사용자의 살아 있는 멤버십 전부(여기서는 하나).
      memberships: [{ organizationId: org.id, name: expect.any(String) as string, role: 'owner', reviewStatus: 'active' }],
      // 과금 P0(ADR-0011) — 요금제 요약(에이전트 분모 · 한도 초과 배너). 테스트 조직은 beta(도입 전 한도).
      plan: { code: 'beta', basis: 'row', maxAgents: 10, overLimit: [] },
      csrf: csrfTokenOf(token),
    });

    // DB 에는 해시만 — 세션 토큰 평문이 어디에도 없다.
    const sessions = await owner.query<Record<string, unknown>>('SELECT * FROM owner_sessions WHERE organization_id = $1', [org.id]);
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0]?.['token_hash']).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(sessions.rows)).not.toContain(token.slice('atk_admin_'.length));
    const audit = await owner.query<{ action: string }>('SELECT action FROM owner_actions WHERE organization_id = $1', [org.id]);
    expect(audit.rows.map((row) => row.action)).toEqual(['session.login']);
  });

  it('열거 방지: 없는 주소·모양이 아닌 입력도 같은 202·같은 쿠키 모양 · 링크 행 0 · DB 문장 수와 순서가 같다', async () => {
    const org = await newOrganization(owner);
    const statements: string[][] = [[], []];
    // 풀 직접 문장과 트랜잭션 커넥션(`connect()`)의 문장을 **둘 다** 적는다 — 요청은 트랜잭션 안에서 돈다(L1).
    const record = (index: number, text: string): void => {
      statements[index]?.push(text.replace(/\s+/g, ' ').slice(0, 60));
    };
    const recording = (index: number): Pool =>
      new Proxy(admin, {
        get(target, property, receiver) {
          if (property === 'query') {
            return (text: string, values?: unknown[]) => {
              record(index, text);
              return target.query(text, values);
            };
          }
          if (property === 'connect') {
            return async () => {
              const client = await target.connect();
              const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<unknown>;
              return Object.assign(Object.create(client) as object, {
                query: (text: string, values?: unknown[]) => {
                  record(index, text);
                  return query(text, values);
                },
                release: () => client.release(),
              });
            };
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    const hit = await call(adminDeps(recording(0)), 'POST', '/api/login', { body: { email: org.ownerEmail } });
    const miss = await call(adminDeps(recording(1)), 'POST', '/api/login', { body: { email: `nobody-${org.id}@example.com` } });
    const junk = await call(adminDeps(admin), 'POST', '/api/login', { body: { email: 42 } });
    for (const result of [hit, miss, junk]) {
      expect(result.statusCode).toBe(202);
      expect(result.body).toBe('{"ok":true}');
      expect((result.cookies ?? [])[0]?.replace(/=[^;]+;/, '=X;')).toBe(`${LOGIN_BROWSER_COOKIE}=X; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
    }
    // 일치 여부로 갈리는 분기가 없다 — 같은 문장이 같은 순서로(타이밍의 구조적 동일성).
    expect(statements[0]).toEqual(statements[1]);
    expect(statements[0]?.length).toBeGreaterThanOrEqual(6);
    const links = await owner.query('SELECT 1 FROM owner_login_links WHERE organization_id = $1', [org.id]);
    expect(links.rowCount).toBe(1); // hit 하나만
  });

  it('코드는 단일 사용이다 — 같은 코드·같은 브라우저 두 번째 verify 는 401, 세션은 하나', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const requested = await call(deps, 'POST', '/api/login', { body: { email: org.ownerEmail } });
    const nonce = cookieValue(requested, LOGIN_BROWSER_COOKIE) ?? '';
    const [mail] = await drainLoginMail(mailer, org.id);
    const code = mail === undefined ? '' : codeFromMail(mail);
    const ip = uniqueCodeIp();
    const first = await call(deps, 'POST', '/api/login/verify', { body: { code }, cookies: { [LOGIN_BROWSER_COOKIE]: nonce }, ip });
    const second = await call(deps, 'POST', '/api/login/verify', { body: { code }, cookies: { [LOGIN_BROWSER_COOKIE]: nonce }, ip });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(401);
    expect(second.json()).toMatchObject({ error: 'login_code_invalid' });
    expect(second.cookies ?? []).toEqual([]);
    const sessions = await owner.query('SELECT 1 FROM owner_sessions WHERE organization_id = $1', [org.id]);
    expect(sessions.rowCount).toBe(1);
    // DB 층: used_at 은 NULL 로 되돌릴 수 없다(재사용 경로 없음).
    await expect(owner.query('UPDATE owner_login_links SET used_at = NULL WHERE organization_id = $1', [org.id])).rejects.toThrow(/write-once/);
  });

  it('다른 브라우저(논스 없음·다른 논스)는 401 이고 시도를 태우지 않는다 — 요청한 브라우저는 그 뒤에도 성공한다', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const requested = await call(deps, 'POST', '/api/login', { body: { email: org.ownerEmail } });
    const nonce = cookieValue(requested, LOGIN_BROWSER_COOKIE) ?? '';
    const [mail] = await drainLoginMail(mailer, org.id);
    const code = mail === undefined ? '' : codeFromMail(mail);
    const noNonce = await call(deps, 'POST', '/api/login/verify', { body: { code }, ip: uniqueCodeIp() });
    const otherNonce = await call(deps, 'POST', '/api/login/verify', { body: { code }, cookies: { [LOGIN_BROWSER_COOKIE]: 'A'.repeat(43) }, ip: uniqueCodeIp() });
    expect([noNonce.statusCode, otherNonce.statusCode]).toEqual([401, 401]);
    expect(noNonce.json()).toMatchObject({ error: 'login_browser_missing' });
    expect(otherNonce.json()).toMatchObject({ error: 'login_code_invalid' });
    const ok = await call(deps, 'POST', '/api/login/verify', { body: { code }, cookies: { [LOGIN_BROWSER_COOKIE]: nonce }, ip: uniqueCodeIp() });
    expect(ok.statusCode).toBe(200);
  });

  it('만료: 보낸(sent) 행이라도 만료면 코드는 401(앱 시계와 무관 — DB 시각) · 만료된 행은 DB 가 사용 처리를 거부한다', async () => {
    const org = await newOrganization(owner);
    const nonce = 'B'.repeat(43);
    const binding = createHash('sha256').update(`atmark.admin-login-browser.v1\n${nonce}`).digest('hex');
    // 20분 전에 만들어져 5분 전에 만료된 링크(소유자 롤은 created_at 을 적을 수 있다 — 테스트 지반).
    const user = await userIdOf(owner, org.ownerEmail);
    const row = await owner.query<{ id: string; expires_at: Date }>(
      `INSERT INTO owner_login_links (organization_id, user_id, browser_binding, created_at, expires_at, status, sent_at, ses_message_id)
       VALUES ($1, $2, $3, now() - interval '20 minutes', date_trunc('milliseconds', now() - interval '5 minutes'), 'sent', now() - interval '19 minutes', 'ses-expired')
       RETURNING id, expires_at`,
      [org.id, user, binding],
    );
    const link = row.rows[0];
    if (link === undefined) throw new Error('link');
    const code = mintLoginCode(adminDeps(admin).loginKeys, 'owner_login', { linkId: link.id, expiresAt: link.expires_at });
    // ① 지금 시각: 만료된 행은 코드 후보가 아니다.
    const expired = await call(adminDeps(admin), 'POST', '/api/login/verify', { body: { code }, cookies: { [LOGIN_BROWSER_COOKIE]: nonce }, ip: uniqueCodeIp() });
    expect(expired.statusCode).toBe(401);
    // ② 앱 시계를 과거로 돌려도 DB 가 만료를 본다(만료는 DB 시각으로만 판정한다).
    const past = adminDeps(admin, { now: () => new Date(link.expires_at.getTime() - 60_000) });
    const dbExpired = await call(past, 'POST', '/api/login/verify', { body: { code }, cookies: { [LOGIN_BROWSER_COOKIE]: nonce }, ip: uniqueCodeIp() });
    expect(dbExpired.statusCode).toBe(401);
    expect((await owner.query('SELECT used_at FROM owner_login_links WHERE id = $1', [link.id])).rows[0]).toEqual({ used_at: null });
    // ③ 트리거: 만료된 행의 used_at 은 적을 수 없다(앱 코드가 WHERE 를 잊어도).
    await expect(owner.query('UPDATE owner_login_links SET used_at = now() WHERE id = $1', [link.id])).rejects.toThrow(/expired/);
  });

  it('승인 링크 키로 파생한 코드는 로그인 코드가 아니다(키 분리) · 옛 링크 토큰은 무엇이든 410 login_link_retired 이고 세션을 만들지 않는다', async () => {
    const org = await newOrganization(owner);
    const requested = await call(adminDeps(admin), 'POST', '/api/login', { body: { email: org.ownerEmail } });
    const nonce = cookieValue(requested, LOGIN_BROWSER_COOKIE) ?? '';
    await drainLoginMail(mailer, org.id);
    const link = await owner.query<{ id: string; expires_at: Date }>('SELECT id, expires_at FROM owner_login_links WHERE organization_id = $1', [org.id]);
    const approvalKeys = parseHmacKeyring(`k1:${Buffer.alloc(32, 7).toString('base64url')}`, 'APPROVAL');
    const real = mintLoginCode(adminDeps(admin).loginKeys, 'owner_login', { linkId: link.rows[0]?.id ?? '', expiresAt: link.rows[0]?.expires_at ?? new Date() });
    const forged = mintLoginCode(approvalKeys, 'owner_login', { linkId: link.rows[0]?.id ?? '', expiresAt: link.rows[0]?.expires_at ?? new Date() });
    expect(forged).not.toBe(real);
    const result = await call(adminDeps(admin), 'POST', '/api/login/verify', { body: { code: forged }, cookies: { [LOGIN_BROWSER_COOKIE]: nonce }, ip: uniqueCodeIp() });
    expect(result.statusCode).toBe(401);
    // 링크 로그인은 없다(2026-10-10) — 옛 메일 토큰 모양이든 아무 문자열이든 토큰만 오면 410, 쿠키 · DB 를 보지 않는다.
    for (const token of ['atk_login_k1.eyJsIjoiMSJ9.sig', 'x']) {
      const retired = await call(adminDeps(admin), 'POST', '/api/login/verify', { body: { token }, cookies: { [LOGIN_BROWSER_COOKIE]: nonce } });
      expect(retired.statusCode).toBe(410);
      expect(retired.json()).toMatchObject({ error: 'login_link_retired' });
      expect(retired.cookies ?? []).toEqual([]);
    }
    // 토큰 + 코드를 함께 보내면 어느 것도 태우지 않는다(401).
    expect((await call(adminDeps(admin), 'POST', '/api/login/verify', { body: { token: 'x', code: real }, cookies: { [LOGIN_BROWSER_COOKIE]: nonce }, ip: uniqueCodeIp() })).statusCode).toBe(401);
    expect((await owner.query('SELECT 1 FROM owner_sessions WHERE organization_id = $1', [org.id])).rowCount).toBe(0);
    // 진짜 코드는 그대로 산다.
    expect((await call(adminDeps(admin), 'POST', '/api/login/verify', { body: { code: real }, cookies: { [LOGIN_BROWSER_COOKIE]: nonce }, ip: uniqueCodeIp() })).statusCode).toBe(200);
  });

  it('속도 상한: 요청자(IP)당 15분 10회 넘으면 429 · (조직, 요청자)당 시간당 링크 3개 넘으면 조용히(202) 적지 않는다', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const ip = `203.0.113.${String(Math.floor(Math.random() * 250) + 1)}-${org.id.slice(0, 8)}`;
    const statuses: number[] = [];
    for (let i = 0; i < LOGIN_REQUESTS_PER_CLIENT + 1; i += 1) {
      statuses.push((await call(deps, 'POST', '/api/login', { body: { email: org.ownerEmail }, ip })).statusCode);
    }
    expect(statuses.slice(0, LOGIN_REQUESTS_PER_CLIENT).every((status) => status === 202)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    const links = await owner.query('SELECT 1 FROM owner_login_links WHERE organization_id = $1', [org.id]);
    // 신뢰 밖 요청자는 (주소, IP) 3 보다 작은 신뢰 밖 15분 몫(2)에 먼저 닿는다.
    expect(links.rowCount).toBe(Math.min(LOGIN_LINKS_PER_CLIENT_PER_USER_PER_HOUR, LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW));
  });

  // -------------------------------------------------------------------------
  // 세션 · 에이전트 토큰 · CSRF
  // -------------------------------------------------------------------------

  it('에이전트 토큰(Authorization)은 관리 API 에서 무조건 401 — 유효한 세션 쿠키와 함께 와도', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'bearer-probe', localPart: `bearer-${org.id.slice(0, 8)}` } }));
    expect(created.statusCode).toBe(201);
    const agentToken = (created.json() as { token: string }).token;
    const bearerOnly = await call(deps, 'GET', '/api/agents', { headers: { authorization: `Bearer ${agentToken}` } });
    const both = await call(deps, 'GET', '/api/agents', authed(session, { headers: { authorization: `Bearer ${agentToken}` } }));
    expect([bearerOnly.statusCode, both.statusCode]).toEqual([401, 401]);
    const cookieOnly = await call(deps, 'GET', '/api/agents', authed(session));
    expect(cookieOnly.statusCode).toBe(200);
  });

  it('세션 쿠키는 api 라우터(api.atmark.ai)에서 무효다 — /v1 은 401, 관리 경로는 404', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    const apiDeps = { audit: { tokens: createPostgresAgentTokenStore(app), audit: {}, now: () => new Date() } } as unknown as ApiDependencies;
    const apiEvent = (method: string, rawPath: string, rawQueryString = '') => ({
      rawPath,
      rawQueryString,
      headers: { cookie: `${SESSION_COOKIE}=${session.token}`, 'x-atmark-csrf': session.csrf },
      cookies: [`${SESSION_COOKIE}=${session.token}`],
      requestContext: { requestId: 'r', stage: '$default', http: { method } },
    });
    const audit = await routeHttpApiEvent(apiDeps, apiEvent('GET', '/v1/audit', 'message_id=00000000-0000-4000-8000-000000000000'));
    expect([audit.statusCode, (JSON.parse(audit.body) as { error: string }).error]).toEqual([401, 'unauthorized']);
    for (const path of ['/api/me', '/api/agents', '/admin/api/me', '/admin', '/login', '/app']) {
      expect((await routeHttpApiEvent(apiDeps, apiEvent('GET', path))).statusCode, path).toBe(404);
    }
  });

  it('CSRF: 모든 변경 요청은 X-Atmark-CSRF 가 세션과 같아야 한다 · Origin 이 다르면 403 · 비-JSON 본문 415', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    const body = { scope: 'org', id: org.id, on: true };
    const none = await call(deps, 'POST', '/api/kill-switch', { body, cookies: session.cookies });
    const wrong = await call(deps, 'POST', '/api/kill-switch', { body, cookies: session.cookies, headers: { 'x-atmark-csrf': csrfTokenOf('atk_admin_other') } });
    const foreign = await call(deps, 'POST', '/api/kill-switch', authed(session, { body, headers: { 'x-atmark-csrf': session.csrf, origin: 'https://evil.example' } }));
    const form = await call(deps, 'POST', '/api/kill-switch', authed(session, { rawBody: 'scope=org', headers: { 'x-atmark-csrf': session.csrf, 'content-type': 'application/x-www-form-urlencoded' } }));
    expect([none.statusCode, wrong.statusCode, foreign.statusCode, form.statusCode]).toEqual([403, 403, 403, 415]);
    expect(none.json()).toMatchObject({ error: 'csrf_mismatch' });
    const pausedBefore = await owner.query<{ f: boolean }>('SELECT owner_paused AS f FROM organizations WHERE id = $1', [org.id]);
    expect(pausedBefore.rows[0]?.f).toBe(false);
    const ok = await call(deps, 'POST', '/api/kill-switch', authed(session, { body, headers: { 'x-atmark-csrf': session.csrf, origin: 'https://console.atmark.ai' } }));
    expect(ok.statusCode).toBe(200);
    const me = await call(deps, 'GET', '/api/me', authed(session));
    // 콘솔의 조직 정지는 소유자 정지다 — 플랫폼 동결(abuse_freeze)은 그대로(H3).
    expect((me.json() as { orgKillSwitch: unknown }).orgKillSwitch).toEqual({ ownerPaused: true, platformFrozen: false, active: true });
    // 표 자체: 세션 변경 경로는 전부 CSRF 가 켜져 있다(표에서 끌 자리가 없다).
    for (const route of ADMIN_ROUTES) {
      if (route.auth === 'session' && route.method !== 'GET') expect(route.csrf, `${route.method} ${route.path}`).toBe(true);
    }
  });

  it('로그아웃: 204 · 쿠키 삭제 · 세션 폐기(revoked_at) — 그 쿠키는 다시 쓸 수 없다 · 폐기 시각은 덮지 않는다', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    const out = await call(deps, 'POST', '/api/logout', authed(session));
    expect(out.statusCode).toBe(204);
    expect((out.cookies ?? [])[0]).toMatch(/^__Host-atmark_admin=; Path=\/; .*Max-Age=0$/);
    expect((await call(deps, 'GET', '/api/me', authed(session))).statusCode).toBe(401);
    const row = await owner.query<{ id: string; revoked_at: Date }>('SELECT id, revoked_at FROM owner_sessions WHERE organization_id = $1', [org.id]);
    expect(row.rows[0]?.revoked_at).toBeInstanceOf(Date);
    await expect(owner.query('UPDATE owner_sessions SET revoked_at = now() + interval \'1 day\' WHERE id = $1', [row.rows[0]?.id])).rejects.toThrow(/write-once/);
    const actions = await owner.query<{ action: string }>('SELECT action FROM owner_actions WHERE organization_id = $1 ORDER BY created_at', [org.id]);
    expect(actions.rows.map((r) => r.action)).toEqual(['session.login', 'session.logout']);
  });

  it('페이지: / 는 세션이 있으면 302 /app · /app 은 세션이 없으면 302 / · CSP 와 보안 헤더를 그대로 싣는다', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    const root = await call(deps, 'GET', '/', { cookies: session.cookies });
    expect([root.statusCode, root.headers['location']]).toEqual([302, '/app']);
    const app302 = await call(deps, 'GET', '/app');
    expect([app302.statusCode, app302.headers['location']]).toEqual([302, '/']);
    for (const path of ['/', '/login']) {
      const page = await call(deps, 'GET', path);
      expect(page.statusCode, path).toBe(200);
      expect(page.headers['content-security-policy'], path).toMatch(/default-src 'self'|default-src 'none'/);
      expect(page.headers).toMatchObject({
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      });
    }
  });

  // -------------------------------------------------------------------------
  // 승인 결정 부재 · 조직 범위 · 감사
  // -------------------------------------------------------------------------

  it('승인 결정 엔드포인트가 없다 — /api/approvals 는 GET 뿐(405), 하위 결정 경로는 404 · 표 어디에도 approve 가 없다', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    expect((await call(deps, 'GET', '/api/approvals', authed(session, { query: 'status=pending' }))).statusCode).toBe(200);
    for (const method of ['POST', 'PATCH']) {
      expect((await call(deps, method, '/api/approvals', authed(session, { body: {} }))).statusCode).toBe(405);
    }
    const id = '00000000-0000-4000-8000-000000000000';
    for (const path of [`/api/approvals/${id}`, `/api/approvals/${id}/approve`, `/api/approvals/${id}/decision`, '/api/approve', '/approve']) {
      expect((await call(deps, 'POST', path, authed(session, { body: { decision: 'approve' } }))).statusCode, path).toBe(404);
    }
    // 발송 승인의 결정은 서명 링크뿐이다. 콘솔의 approve 는 **정책 변경 요청**(ADR-0007 2026-10-13)의 것 하나 — 보내는 승인이 아니라 소유자가 정책을
    //   바꾸는 관리 연산이다(같은 역할 admin · 같은 감사 결).
    expect(ADMIN_ROUTES.filter((route) => /approv/.test(route.path)).map((route) => `${route.method} ${route.path}`)).toEqual([
      'POST /api/agents/{agentId}/change-requests/{requestId}/approve',
      'GET /api/approvals',
    ]);
  });

  it('조직 범위: 다른 조직의 에이전트·게이트는 404(없음과 구별하지 않는다) · 다른 조직 kill-switch 도 404', async () => {
    const deps = adminDeps(admin);
    const orgA = await newOrganization(owner);
    const orgB = await newOrganization(owner);
    const sessionA = await login(deps, mailer, orgA);
    const sessionB = await login(deps, mailer, orgB);
    const created = await call(deps, 'POST', '/api/agents', authed(sessionB, { body: { name: 'b-agent', localPart: `orgb-${orgB.id.slice(0, 8)}` } }));
    const agentB = (created.json() as { agent: { id: string } }).agent.id;
    for (const [method, path, body] of [
      ['GET', `/api/agents/${agentB}/policy`, undefined],
      ['POST', `/api/agents/${agentB}/token`, { action: 'revoke-all' }],
      ['PATCH', `/api/agents/${agentB}/policy`, { outbound: { mode: 'none' } }],
      ['POST', `/api/agents/${agentB}/rules`, { direction: 'outbound', list: 'allow', value: 'x@example.com' }],
      ['DELETE', `/api/agents/${agentB}/rules/00000000-0000-4000-8000-000000000000`, undefined],
    ] as const) {
      const result = await call(deps, method, path, authed(sessionA, body === undefined ? {} : { body }));
      expect(result.statusCode, `${method} ${path}`).toBe(404);
    }
    expect((await call(deps, 'POST', '/api/kill-switch', authed(sessionA, { body: { scope: 'org', id: orgB.id, on: true } }))).statusCode).toBe(404);
    expect((await call(deps, 'POST', '/api/kill-switch', authed(sessionA, { body: { scope: 'agent', id: agentB, on: true } }))).statusCode).toBe(404);
    const tokens = await owner.query('SELECT 1 FROM agent_api_keys WHERE agent_id = $1 AND revoked_at IS NULL', [agentB]);
    expect(tokens.rowCount).toBe(1); // A 의 revoke-all 은 닿지 않았다
    const listA = await call(deps, 'GET', '/api/agents', authed(sessionA));
    expect(listA.json()).toEqual([]);
  });

  it('에이전트 생성: 201 · 토큰은 응답 한 번 · DB 에는 해시만 · DID 없음 · 감사 행에 토큰이 없다 · 감사는 append-only', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'first', localPart: `first-${org.id.slice(0, 8)}` } }));
    expect(created.statusCode).toBe(201);
    const payload = created.json() as { agent: { id: string; outboundMode: string; status: string }; token: string };
    // 정책 v2 — 콘솔 이름으로(2026-10-13 결정 B: 발신 전체 · 수신 전체).
    // lastUsedAt (202609241400, US-007) — 방금 발급된 토큰은 아직 인증에 쓰인 적이 없다.
    expect(payload.agent).toMatchObject({ outboundMode: 'all', inboundMode: 'all', status: 'active', activeTokens: 1, lastUsedAt: null });
    expect(payload.token).toMatch(/^atk_agent_/);
    expect(created.body).not.toMatch(/did:/);
    const list = await call(deps, 'GET', '/api/agents', authed(session));
    expect(list.body).not.toContain(payload.token);
    expect(list.body).not.toMatch(/did:/);
    const keys = await owner.query<Record<string, unknown>>('SELECT * FROM agent_api_keys WHERE agent_id = $1', [payload.agent.id]);
    expect(JSON.stringify(keys.rows)).not.toContain(payload.token.slice('atk_agent_'.length));
    const actions = await owner.query<Record<string, unknown>>('SELECT * FROM owner_actions WHERE organization_id = $1 ORDER BY created_at, action', [org.id]);
    expect(actions.rows.map((row) => [row['action'], row['target_id']])).toEqual([
      ['session.login', null],
      ['agent.create', payload.agent.id],
    ]);
    expect(JSON.stringify(actions.rows)).not.toContain(payload.token);
    await expect(owner.query('UPDATE owner_actions SET action = $2 WHERE organization_id = $1', [org.id, 'x.y'])).rejects.toThrow(/immutable/);
    await expect(owner.query('DELETE FROM owner_actions WHERE organization_id = $1', [org.id])).rejects.toThrow(/append-only/);
    // 감사 대상 자리에 주소·토큰 모양은 들어갈 수 없다(DB CHECK).
    const sessionId = (await owner.query<{ id: string }>('SELECT id FROM owner_sessions WHERE organization_id = $1', [org.id])).rows[0]?.id;
    await expect(
      owner.query(`INSERT INTO owner_actions (session_id, organization_id, action, target_id) VALUES ($1, $2, 'x.y', 'bob@example.com')`, [sessionId, org.id]),
    ).rejects.toThrow(/check/i);
  });

  it('sender 분류: 관리 API 로 seen 을 적는다(소유자 롤) · 목록은 최신 행 · 도메인 seen 은 확인 없이 400', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'marks', localPart: `marks-${org.id.slice(0, 8)}` } }));
    const agentId = (created.json() as { agent: { id: string } }).agent.id;
    const marked = await call(deps, 'POST', '/api/senders', authed(session, { body: { agentId, address: 'NoReply@Service.example', mark: 'seen' } }));
    expect(marked.statusCode).toBe(201);
    const domain = await call(deps, 'POST', '/api/senders', authed(session, { body: { agentId, address: 'service.example', mark: 'seen', scope: 'domain' } }));
    expect([domain.statusCode, (domain.json() as { error: string }).error]).toEqual([400, 'domain_scope_unconfirmed']);
    const list = await call(deps, 'GET', '/api/senders', authed(session, { query: `agent=${agentId}` }));
    expect(list.json()).toEqual([{ address: 'noreply@service.example', scope: 'address', mark: 'seen', markedAt: expect.any(String) as string }]);
  });

  // -------------------------------------------------------------------------
  // 앱 롤 경계 — api Lambda·워커가 쓰는 롤은 세션을 만들지도 읽지도 못한다
  // -------------------------------------------------------------------------

  it('앱 롤: 세션·감사·요청 원장·링크 권한 0 · 로그인 메일 롤: outbox 컬럼만(browser_binding·used_at·client_key 읽기 불가 · INSERT 불가)', async () => {
    const org = await newOrganization(owner);
    await call(adminDeps(admin), 'POST', '/api/login', { body: { email: org.ownerEmail } });
    for (const sql of [
      'SELECT 1 FROM owner_sessions LIMIT 1',
      'SELECT 1 FROM owner_actions LIMIT 1',
      'SELECT 1 FROM owner_login_requests LIMIT 1',
      'SELECT browser_binding FROM owner_login_links LIMIT 1',
      'SELECT used_at FROM owner_login_links LIMIT 1',
    ]) {
      await expect(app.query(sql), sql).rejects.toThrow(/permission denied/);
    }
    await expect(
      app.query(`INSERT INTO owner_login_links (organization_id, browser_binding, expires_at) VALUES ($1, $2, now() + interval '5 minutes')`, [org.id, 'a'.repeat(64)]),
    ).rejects.toThrow(/permission denied/);
    await expect(app.query('UPDATE owner_login_links SET used_at = now() WHERE organization_id = $1', [org.id])).rejects.toThrow(/permission denied/);
    await expect(
      app.query(`INSERT INTO owner_sessions (organization_id, login_link_id, token_hash, expires_at) VALUES ($1, gen_random_uuid(), $2, now())`, [org.id, 'b'.repeat(64)]),
    ).rejects.toThrow(/permission denied/);
    // 앱 롤은 링크 outbox 도 읽지 못한다(`202609230720` — 발송은 로그인 메일 롤로 옮겨졌다).
    await expect(app.query('SELECT id, status FROM owner_login_links WHERE organization_id = $1', [org.id])).rejects.toThrow(/permission denied/);
    // 로그인 메일 롤: outbox 컬럼만 — 결속·사용 시각·요청자 키는 읽지 못하고, 링크를 만들 수 없다.
    const outbox = await mailer.query('SELECT id, status FROM owner_login_links WHERE organization_id = $1', [org.id]);
    expect(outbox.rowCount).toBe(1);
    for (const column of ['browser_binding', 'used_at', 'client_key']) {
      await expect(mailer.query(`SELECT ${column} FROM owner_login_links LIMIT 1`), column).rejects.toThrow(/permission denied/);
    }
    await expect(
      mailer.query(`INSERT INTO owner_login_links (organization_id, browser_binding, expires_at) VALUES ($1, $2, now() + interval '5 minutes')`, [org.id, 'a'.repeat(64)]),
    ).rejects.toThrow(/permission denied/);
  });
});
