/**
 * **메일의 6자리 코드 — 실제 Postgres 위에서** (2026-09-28, `src/security/login-code.ts` · `src/admin/session.ts` 코드 절 ·
 * `202609280100_login_codes.sql`). 실메일 0(가짜 SES) · AWS 0.
 *
 * 라우터는 `atmark_admin` 롤(운영 admin Lambda 의 롤)로 돈다 — 소유자 롤이면 GRANT 가 모자라도 초록이다. 메일 워커는 로그인 메일 롤.
 * 테스트 지반(행 심기·검사)만 소유자 롤.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 메일에 코드가 있다(링크 위) · 코드는 요청한 브라우저에서 **한 번** 된다 · 링크와 코드는 한 시도를 여는 두 방법(하나를 쓰면 다른 하나도 끝)
 *   - 다른 브라우저(결속 쿠키 없음 → `login_browser_missing` · 다른 논스 → `login_code_invalid`)에서는 안 된다
 *   - 5번 틀리면 그 시도는 링크로도 코드로도 끝 · 동시에 틀려도 5를 넘겨 세지 않는다(행 잠금)
 *   - 코드 후보는 결속 안에서 사용자(가입은 주소)마다 최신의 살아 있는 링크 하나(보안 리뷰 L-1) — 옛 메일의 코드는 안 되고 링크는 된다
 *   - 만료된 행 · 아직 안 보낸 행(`pending`)의 코드는 안 된다
 *   - 열거 방지: 없는 주소·틀린 코드·안 보낸 메일·5회 초과가 같은 401 본문 · 같은 SQL 문장·순서
 *   - 가입: 가입 메일의 코드 → 조직 · 이미 사용자인 주소의 가입 요청 → 로그인 메일의 코드가 가입 화면에서 된다 · 5번 틀리면 가입 링크도 끝
 *   - 홈(atmark.ai) 출처의 코드 verify 응답에는 CSRF 토큰이 없다
 *   - DB 가드: `code_failures` 는 +1 씩만 · 5 인 링크의 `used_at` 쓰기 거부(모든 롤)
 *   - 잠금 DoS 수정(2026-10-10, `security/login-limits.ts`): 다른 IP 의 공격자가 틀린 코드를 아무리 넣어도 피해자의 로그인은 된다(계정 단위 예산 없음) ·
 *     주소 발급 상한(15분 5통)을 공격자가 채워도 이 주소로 성공한 적 있는 IP 는 코드를 받는다 · IP 당 틀린 코드 시간당 30회(맞는 코드는 세지 않는다,
 *     동시에도 넘지 않는다) · 응답은 주소와 무관
 */

import { createHmac } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { LOGIN_BROWSER_COOKIE, SESSION_COOKIE, SIGNUP_BROWSER_COOKIE, SITE_CORS_ENV, SITE_ORIGIN } from '../../../src/admin/http';
import { createSignupNotifier } from '../../../src/notify/signup-notifier';
import { browserBindingOf } from '../../../src/admin/session';
import { activeKey } from '../../../src/security/hmac-keyring';
import { mintLoginCode } from '../../../src/security/login-code';
import {
  LOGIN_CODE_FAILURES_PER_CLIENT,
  LOGIN_CODE_MAX_FAILURES,
  LOGIN_UNTRUSTED_LINKS_PER_USER_PER_DAY,
  LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW,
} from '../../../src/security/login-limits';
import { runSignupMailer } from '../../../src/workers/signup-mailer';
import {
  adminDeps,
  adminRolePool,
  appPool,
  AVAILABLE,
  call,
  cookieValue,
  drainLoginMail,
  fakeSes,
  LOGIN_KEYS,
  loginMailerPool,
  mailText,
  newOrganization,
  ownerPool,
  suffix,
  userIdOf,
  type SentMail,
} from './support';
import { seedLiveInvite } from '../signup/support';
import { afterDbNow } from '../../support/db-clock';

const uniqueIp = (): string => `198.51.100.${String(Math.floor(Math.random() * 250))}-${suffix()}${suffix()}`;

/** 메일 본문의 코드 — 한 줄에 6자리 숫자만 있는 줄(한 통에 한 언어 · 한 번 — 2026-10-10). 링크 · 서명 토큰이 없다. */
function codeFromMail(mail: SentMail): string {
  const text = mailText(mail);
  const codes = text.split('\n').filter((line) => /^[0-9]{6}$/.test(line));
  expect(codes).toHaveLength(1);
  expect(text).not.toMatch(/https?:\/\/|atk_(login|signup)_/);
  return codes[0] ?? '';
}

/** 틀린 코드 — 주어진 코드와 다른 6자리. */
const wrong = (code: string): string => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

/** 풀 직접 문장과 트랜잭션 커넥션 문장을 **둘 다** 적는 풀(가입·로그인 열거 테스트와 같은 기법). */
function recording(pool: Pool, into: string[]): Pool {
  const record = (text: string): void => {
    into.push(text.replace(/\s+/g, ' ').trim());
  };
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'query') {
        return (text: string, values?: unknown[]) => {
          record(text);
          return target.query(text, values);
        };
      }
      if (property === 'connect') {
        return async (): Promise<PoolClient> => {
          const client = await target.connect();
          const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<unknown>;
          return Object.assign(Object.create(client) as PoolClient, {
            query: (text: string, values?: unknown[]) => {
              record(text);
              return query(text, values);
            },
            release: () => client.release(),
          });
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

describe.skipIf(!AVAILABLE)('메일의 6자리 코드 — atmark_admin 롤', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  const createdSignupEmails: string[] = [];
  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
  });
  afterAll(async () => {
    await owner.query(
      `UPDATE organizations SET review_status = 'rejected' WHERE owner_email = ANY($1::text[]) AND review_status = 'pending_review'`,
      [createdSignupEmails],
    );
    await Promise.all([owner.end(), admin.end(), mailer.end()]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const deps = (pool: Pool = admin) => adminDeps(pool);

  /** 로그인 요청(새 브라우저) → 로그인 메일 롤 워커 → 메일의 코드 · 이 브라우저의 논스. */
  async function requestCode(organization: { id: string; ownerEmail: string }, nonce?: string) {
    const requested = await call(deps(), 'POST', '/api/login', {
      body: { email: organization.ownerEmail },
      ip: uniqueIp(),
      ...(nonce === undefined ? {} : { cookies: { [LOGIN_BROWSER_COOKIE]: nonce } }),
    });
    expect(requested.statusCode).toBe(202);
    const browser = cookieValue(requested, LOGIN_BROWSER_COOKIE) ?? '';
    const mails = await drainLoginMail(mailer, organization.id);
    const mail = mails.at(-1);
    if (mail === undefined) throw new Error('로그인 메일이 나가지 않았다');
    return { nonce: browser, code: codeFromMail(mail), text: mailText(mail) };
  }

  // 요청자마다 고유 IP — IP 당 틀린 코드 상한(시간당 30회)이 공유 DB 에서 다른 테스트·이전 실행과 섞이지 않게(상한 자체는 따로 본다).
  const verifyCode = (code: unknown, nonce: string | undefined, headers: Record<string, string> = {}, ip: string = uniqueIp()) =>
    call(deps(), 'POST', '/api/login/verify', {
      body: { code },
      headers,
      ip,
      ...(nonce === undefined ? {} : { cookies: { [LOGIN_BROWSER_COOKIE]: nonce } }),
    });
  /** 옛 메일의 링크 토큰(2026-10-10 링크 로그인 삭제) — 서버는 보지 않고 410 `login_link_retired`. */
  const OLD_LOGIN_TOKEN = 'atk_login_k1.eyJsIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAwIiwiZSI6MH0.c2ln';
  const verifyToken = (token: string, nonce: string) =>
    call(deps(), 'POST', '/api/login/verify', { body: { token }, cookies: { [LOGIN_BROWSER_COOKIE]: nonce } });

  async function failuresOf(userId: string): Promise<number[]> {
    const rows = await owner.query<{ code_failures: number }>(
      'SELECT code_failures FROM owner_login_links WHERE user_id = $1 ORDER BY created_at',
      [userId],
    );
    return rows.rows.map((row) => row.code_failures);
  }

  // -------------------------------------------------------------------------
  // 로그인
  // -------------------------------------------------------------------------

  it('메일에는 코드만 · 같은 브라우저에서 코드 → 200 세션 · 같은 코드 두 번째 401 · 옛 링크 토큰은 410(세션 없음)', async () => {
    const organization = await newOrganization(owner);
    const { nonce, code, text } = await requestCode(organization);
    expect(text).not.toContain('https://console.atmark.ai/login');

    const ok = await verifyCode(` ${code.slice(0, 3)}-${code.slice(3)} `, nonce);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ next: 'app', csrf: expect.any(String) });
    const session = cookieValue(ok, SESSION_COOKIE);
    expect(session).toMatch(/^atk_admin_/);
    const me = await call(deps(), 'GET', '/api/me', { cookies: { [SESSION_COOKIE]: session ?? '' } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: organization.ownerEmail } });

    const again = await verifyCode(code, nonce);
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({ error: 'login_code_invalid' });
    const link = await verifyToken(OLD_LOGIN_TOKEN, nonce);
    expect(link.statusCode).toBe(410);
    expect(link.json()).toMatchObject({ error: 'login_link_retired' });
  });

  it('옛 링크 토큰은 시도를 태우지 않는다(410 · DB 를 보지 않는다 · 틀린 수 0) — 그 뒤에도 코드는 된다', async () => {
    const organization = await newOrganization(owner);
    const { nonce, code } = await requestCode(organization);
    const userId = await userIdOf(owner, organization.ownerEmail);
    for (const token of [OLD_LOGIN_TOKEN, 'atk_login_k1.x.y', '']) {
      const retired = await verifyToken(token, nonce);
      expect(retired.statusCode).toBe(410);
      expect(retired.cookies ?? []).toEqual([]);
    }
    expect(await failuresOf(userId)).toEqual([0]);
    expect((await verifyCode(code, nonce)).statusCode).toBe(200);
  });

  it('다른 브라우저: 결속 쿠키 없음 → 401 login_browser_missing(DB 전 · 세지 않음) · 다른 논스 → 401 login_code_invalid · 요청한 브라우저의 시도는 그대로 산다', async () => {
    const organization = await newOrganization(owner);
    const { nonce, code } = await requestCode(organization);
    const userId = await userIdOf(owner, organization.ownerEmail);

    const missing = await verifyCode(code, undefined);
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: 'login_browser_missing' });

    // 다른 브라우저(자기 논스로 다른 주소를 요청한 공격자 포함) — 결속이 달라 후보가 없다. 요청한 브라우저의 틀린 수는 늘지 않는다.
    const other = await newOrganization(owner);
    const { nonce: otherNonce } = await requestCode(other);
    for (let i = 0; i < LOGIN_CODE_MAX_FAILURES + 2; i += 1) {
      const res = await verifyCode(code, otherNonce);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: 'login_code_invalid' });
    }
    expect(await failuresOf(userId)).toEqual([0]);
    expect((await verifyCode(code, nonce)).statusCode).toBe(200);
  });

  it('5번 틀리면 그 시도는 끝 — 맞는 코드도 401 · 틀린 수는 5에서 멈춘다 · 새로 요청하면 다시 된다', async () => {
    const organization = await newOrganization(owner);
    const { nonce, code } = await requestCode(organization);
    const userId = await userIdOf(owner, organization.ownerEmail);
    for (let i = 1; i <= LOGIN_CODE_MAX_FAILURES; i += 1) {
      const res = await verifyCode(wrong(code), nonce);
      expect(res.statusCode).toBe(401);
      expect(await failuresOf(userId)).toEqual([i]);
    }
    const right = await verifyCode(code, nonce);
    expect(right.statusCode).toBe(401);
    expect(right.json()).toMatchObject({ error: 'login_code_invalid' });
    expect(await failuresOf(userId)).toEqual([5]);

    // 같은 브라우저에서 새로 요청 → 새 링크(새 코드)는 산다.
    const fresh = await requestCode(organization, nonce);
    expect(fresh.nonce).toBe(nonce);
    expect((await verifyCode(fresh.code, nonce)).statusCode).toBe(200);
  });

  it('L-1 같은 브라우저의 살아 있는 시도 둘 — 코드는 최신 메일 것만 된다 · 틀린 코드는 최신 행만 센다', async () => {
    const organization = await newOrganization(owner);
    const first = await requestCode(organization);
    const second = await requestCode(organization, first.nonce);
    const userId = await userIdOf(owner, organization.ownerEmail);
    const bad = ['000000', '999999', '123456', '654321'].find((candidate) => candidate !== first.code && candidate !== second.code) ?? '111111';
    expect((await verifyCode(bad, first.nonce)).statusCode).toBe(401);
    expect(await failuresOf(userId)).toEqual([0, 1]);
    // 옛 메일의 코드 — 후보가 아니다(같은 401 · 최신 링크의 틀린 수로 센다).
    const stale = await verifyCode(first.code, first.nonce);
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ error: 'login_code_invalid' });
    expect(await failuresOf(userId)).toEqual([0, 2]);
    expect((await verifyCode(second.code, first.nonce)).statusCode).toBe(200);
  });

  it(`L-1 한 결속에 한 사용자의 링크 ${String(LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW)}개 — 틀린 코드 한 번은 최신 링크 하나만 센다(추측 1번)`, async () => {
    const organization = await newOrganization(owner);
    const first = await requestCode(organization);
    const codes = [first.code];
    for (let i = 1; i < LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW; i += 1) codes.push((await requestCode(organization, first.nonce)).code);
    const userId = await userIdOf(owner, organization.ownerEmail);
    const bad = ['000000', '999999', '123456', '654321', '111111', '222222', '333333', '444444', '555555', '777777', '888888'].find(
      (candidate) => !codes.includes(candidate),
    ) ?? '246802';
    expect((await verifyCode(bad, first.nonce)).statusCode).toBe(401);
    const failures = await failuresOf(userId);
    expect(failures).toHaveLength(LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW);
    expect(failures.reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(failures.at(-1)).toBe(1);
  });

  it('동시에 틀려도(12건) 틀린 수는 5를 넘지 않는다 — 행 잠금 아래 +1', async () => {
    const organization = await newOrganization(owner);
    const { nonce, code } = await requestCode(organization);
    const userId = await userIdOf(owner, organization.ownerEmail);
    const results = await Promise.all(Array.from({ length: 12 }, () => verifyCode(wrong(code), nonce)));
    expect(results.every((res) => res.statusCode === 401)).toBe(true);
    expect(await failuresOf(userId)).toEqual([5]);
    expect((await verifyCode(code, nonce)).statusCode).toBe(401);
  });

  it('만료된 행 · 아직 안 보낸 행(pending)의 코드는 401 — 보낸 뒤에는 같은 코드가 된다', async () => {
    const organization = await newOrganization(owner);
    const userId = await userIdOf(owner, organization.ownerEmail);

    // 만료: 소유자 롤로 이미 만료된 "보낸" 행을 심는다(15분 창 안 · 이 브라우저 결속).
    const requested = await call(deps(), 'POST', '/api/login', { body: { email: `nobody-${suffix()}@example.com` }, ip: uniqueIp() });
    const nonce = cookieValue(requested, LOGIN_BROWSER_COOKIE) ?? '';
    const { browserBindingOf } = await import('../../../src/admin/session');
    const expired = await owner.query<{ id: string; expires_at: Date }>(
      `INSERT INTO owner_login_links (organization_id, user_id, browser_binding, client_key, created_at, expires_at, next_attempt_at,
                                      status, sent_at, ses_message_id, attempt_count)
       VALUES ($1, $2, $3, $4, now() - interval '20 minutes', date_trunc('milliseconds', now() - interval '6 minutes'), now(),
               'sent', now() - interval '19 minutes', 'ses-test', 1)
       RETURNING id, expires_at`,
      [organization.id, userId, browserBindingOf(nonce), 'f'.repeat(64)],
    );
    const row = expired.rows[0];
    if (row === undefined) throw new Error('행이 없다');
    const expiredCode = mintLoginCode(LOGIN_KEYS, 'owner_login', { linkId: row.id, expiresAt: row.expires_at });
    const late = await verifyCode(expiredCode, nonce);
    expect(late.statusCode).toBe(401);
    expect(late.json()).toMatchObject({ error: 'login_code_invalid' });

    // 안 보낸 행: 요청만 하고 워커를 돌리지 않는다 → 행의 id·만료로 코드를 계산해도 401. 워커가 보낸 뒤에는 같은 코드가 된다.
    const pending = await call(deps(), 'POST', '/api/login', { body: { email: organization.ownerEmail }, ip: uniqueIp() });
    const pendingNonce = cookieValue(pending, LOGIN_BROWSER_COOKIE) ?? '';
    const link = await owner.query<{ id: string; expires_at: Date; status: string }>(
      'SELECT id, expires_at, status::text AS status FROM owner_login_links WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId],
    );
    const pendingRow = link.rows[0];
    if (pendingRow === undefined) throw new Error('행이 없다');
    expect(pendingRow.status).toBe('pending');
    const pendingCode = mintLoginCode(LOGIN_KEYS, 'owner_login', { linkId: pendingRow.id, expiresAt: pendingRow.expires_at });
    expect((await verifyCode(pendingCode, pendingNonce)).statusCode).toBe(401);
    const mails = await drainLoginMail(mailer, organization.id);
    expect(codeFromMail(mails.at(-1) as SentMail)).toBe(pendingCode);
    // 안 보낸 동안의 틀린 시도는 세지 않았다(후보가 아니었다) — 보낸 뒤 바로 된다.
    expect((await verifyCode(pendingCode, pendingNonce)).statusCode).toBe(200);
  });

  it('열거 방지 — 없는 주소 · 틀린 코드 · 5회 초과: 같은 401 본문 · 같은 SQL 문장·순서', async () => {
    const organization = await newOrganization(owner);
    const { nonce, code } = await requestCode(organization);
    const ghost = await call(deps(), 'POST', '/api/login', { body: { email: `ghost-${suffix()}@example.com` }, ip: uniqueIp() });
    const ghostNonce = cookieValue(ghost, LOGIN_BROWSER_COOKIE) ?? '';

    const trace = async (codeValue: string, browser: string): Promise<{ statements: string[]; status: number; body: string }> => {
      const statements: string[] = [];
      const res = await call(adminDeps(recording(admin, statements)), 'POST', '/api/login/verify', {
        body: { code: codeValue },
        ip: uniqueIp(),
        cookies: { [LOGIN_BROWSER_COOKIE]: browser },
      });
      return { statements, status: res.statusCode, body: res.body };
    };
    const existing = await trace(wrong(code), nonce);
    const absent = await trace(code, ghostNonce);
    expect(existing.status).toBe(401);
    expect(absent.status).toBe(401);
    expect(absent.body).toBe(existing.body);
    expect(absent.statements).toEqual(existing.statements);
    for (let i = 1; i < LOGIN_CODE_MAX_FAILURES; i += 1) await verifyCode(wrong(code), nonce);
    const dead = await trace(code, nonce);
    expect(dead.status).toBe(401);
    expect(dead.body).toBe(existing.body);
    expect(dead.statements).toEqual(existing.statements);
  });

  it('모양이 아닌 코드 · 토큰과 코드를 함께 → 401(DB 전 · 세지 않음)', async () => {
    const organization = await newOrganization(owner);
    const { nonce, code } = await requestCode(organization);
    const token = OLD_LOGIN_TOKEN;
    const userId = await userIdOf(owner, organization.ownerEmail);
    for (const bad of ['12345', 'abcdef', 123456, null, ['123456']]) {
      const res = await verifyCode(bad, nonce);
      expect(res.statusCode, JSON.stringify(bad)).toBe(401);
      expect(res.json()).toMatchObject({ error: 'login_code_invalid' });
    }
    const both = await call(deps(), 'POST', '/api/login/verify', { body: { code, token }, cookies: { [LOGIN_BROWSER_COOKIE]: nonce } });
    expect(both.statusCode).toBe(401);
    expect(await failuresOf(userId)).toEqual([0]);
    expect((await verifyCode(code, nonce)).statusCode).toBe(200);
  });

  it('홈(atmark.ai) 출처의 코드 verify — 200 · CORS 헤더 · 세션 쿠키는 서지만 본문에 CSRF 토큰이 없다', async () => {
    vi.stubEnv(SITE_CORS_ENV, 'true');
    const organization = await newOrganization(owner);
    const { nonce, code } = await requestCode(organization);
    const res = await verifyCode(code, nonce, { origin: SITE_ORIGIN });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ next: 'app' });
    expect(res.headers['access-control-allow-origin']).toBe(SITE_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(cookieValue(res, SESSION_COOKIE)).toMatch(/^atk_admin_/);
  });

  it('DB 가드(모든 롤) — code_failures 는 +1 씩만 · 되돌릴 수 없다 · 5 인 링크의 used_at 쓰기 거부', async () => {
    const organization = await newOrganization(owner);
    const { nonce, code } = await requestCode(organization);
    const userId = await userIdOf(owner, organization.ownerEmail);
    const id = (await owner.query<{ id: string }>('SELECT id FROM owner_login_links WHERE user_id = $1', [userId])).rows[0]?.id ?? '';
    await expect(owner.query('UPDATE owner_login_links SET code_failures = 2 WHERE id = $1', [id])).rejects.toMatchObject({ code: '23514' });
    for (let i = 0; i < LOGIN_CODE_MAX_FAILURES; i += 1) await verifyCode(wrong(code), nonce);
    await expect(owner.query('UPDATE owner_login_links SET code_failures = 0 WHERE id = $1', [id])).rejects.toMatchObject({ code: '23514' });
    await expect(owner.query('UPDATE owner_login_links SET code_failures = 6 WHERE id = $1', [id])).rejects.toMatchObject({ code: '23514' });
    await expect(owner.query('UPDATE owner_login_links SET used_at = now() WHERE id = $1', [id])).rejects.toMatchObject({ code: '23514' });
    // admin 롤도 같다(권한은 있어도 가드가 막는다).
    await expect(admin.query('UPDATE owner_login_links SET used_at = now() WHERE id = $1', [id])).rejects.toMatchObject({ code: '23514' });
  });

  // -------------------------------------------------------------------------
  // 가입
  // -------------------------------------------------------------------------

  async function requestSignup(email: string, cookies: Record<string, string> = {}) {
    await seedLiveInvite(email); // 초대 전용 가입(202609301520)
    const requested = await call(deps(), 'POST', '/api/signup', {
      body: { email, organizationName: `Acme ${suffix()}`, consent: true },
      ip: uniqueIp(),
      cookies,
    });
    expect(requested.statusCode, requested.body).toBe(202);
    return {
      signupNonce: cookieValue(requested, SIGNUP_BROWSER_COOKIE) ?? '',
      loginNonce: cookieValue(requested, LOGIN_BROWSER_COOKIE) ?? '',
    };
  }

  async function drainSignupMail(email: string): Promise<SentMail | undefined> {
    const ses = fakeSes();
    const notifier = createSignupNotifier({ pool: mailer, client: ses.client, keyring: LOGIN_KEYS, now: () => new Date(), capPerHour: 1_000_000 });
    await afterDbNow(mailer); // 행의 next_attempt_at 은 DB 시각 — 테스트 시계가 뒤처지면 아직 기한 전으로 보인다
    await runSignupMailer({ db: mailer, notifier, now: () => new Date() }, { email });
    return (ses.sent as SentMail[]).at(-1);
  }

  const verifySignupCode = (code: unknown, nonces: { signupNonce: string; loginNonce: string }) =>
    call(deps(), 'POST', '/api/signup/verify', {
      body: { code },
      ip: uniqueIp(),
      cookies: { [SIGNUP_BROWSER_COOKIE]: nonces.signupNonce, [LOGIN_BROWSER_COOKIE]: nonces.loginNonce },
    });

  it('가입: 가입 메일의 코드 → 200 {redirect:/app} · active 조직(초대 전용 — 202609301520) · 같은 코드 두 번째 401 · 옛 링크 토큰 410', async () => {
    const email = `code-signup-${suffix()}${suffix()}@example.com`;
    createdSignupEmails.push(email);
    const nonces = await requestSignup(email);
    const mail = await drainSignupMail(email);
    if (mail === undefined) throw new Error('가입 메일이 나가지 않았다');
    const code = codeFromMail(mail);

    const ok = await verifySignupCode(code, nonces);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ redirect: '/app' });
    const org = await owner.query<{ review_status: string }>('SELECT review_status::text AS review_status FROM organizations WHERE owner_email = $1', [email]);
    expect(org.rows.map((row) => row.review_status)).toEqual(['active']);

    const again = await verifySignupCode(code, nonces);
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({ error: 'signup_code_invalid' });
    const link = await call(deps(), 'POST', '/api/signup/verify', { body: { token: 'atk_signup_k1.x.y' }, cookies: { [SIGNUP_BROWSER_COOKIE]: nonces.signupNonce } });
    expect(link.statusCode).toBe(410);
    expect(link.json()).toMatchObject({ error: 'signup_link_retired' });
  });

  it('가입: 이미 사용자인 주소 → 로그인 메일의 코드가 가입 화면(signup/verify)에서 된다 · 조직은 새로 생기지 않는다', async () => {
    const organization = await newOrganization(owner);
    const nonces = await requestSignup(organization.ownerEmail);
    const mails = await drainLoginMail(mailer, organization.id);
    const mail = mails.at(-1);
    if (mail === undefined) throw new Error('로그인 메일이 나가지 않았다');
    const res = await verifySignupCode(codeFromMail(mail), nonces);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ redirect: '/app' });
    const me = await call(deps(), 'GET', '/api/me', { cookies: { [SESSION_COOKIE]: cookieValue(res, SESSION_COOKIE) ?? '' } });
    expect(me.json()).toMatchObject({ organization: { id: organization.id } });
    const count = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM organizations WHERE owner_email = $1', [organization.ownerEmail]);
    expect(count.rows[0]?.n).toBe(1);
  });

  it('가입: 5번 틀리면 그 가입 시도는 끝(맞는 코드도 401 · 가입 함수가 거부) · 결속 쿠키 없음은 signup_browser_missing', async () => {
    const email = `code-signup-${suffix()}${suffix()}@example.com`;
    createdSignupEmails.push(email);
    const nonces = await requestSignup(email);
    const mail = await drainSignupMail(email);
    if (mail === undefined) throw new Error('가입 메일이 나가지 않았다');
    const code = codeFromMail(mail);

    const missing = await call(deps(), 'POST', '/api/signup/verify', { body: { code } });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: 'signup_browser_missing' });

    for (let i = 0; i < LOGIN_CODE_MAX_FAILURES; i += 1) expect((await verifySignupCode(wrong(code), nonces)).statusCode).toBe(401);
    const failures = await owner.query<{ code_failures: number }>('SELECT code_failures FROM signup_links WHERE email = $1', [email]);
    expect(failures.rows.map((row) => row.code_failures)).toEqual([5]);
    expect((await verifySignupCode(code, nonces)).statusCode).toBe(401);
    // 가입 함수도 5 인 행을 거부한다(코드 경로를 거치지 않아도).
    const used = await admin.query<{ organization_id: string | null }>(
      'SELECT create_signup_organization(id, browser_binding, now()) AS organization_id FROM signup_links WHERE email = $1',
      [email],
    );
    expect(used.rows.map((row) => row.organization_id)).toEqual([null]);
    const org = await owner.query('SELECT 1 FROM organizations WHERE owner_email = $1', [email]);
    expect(org.rowCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 잠금 DoS 수정(2026-10-10) — 실패는 코드와 IP 에만 · 주소에는 발급만
  // -------------------------------------------------------------------------

  const ipKeyOf = (ip: string): string => createHmac('sha256', activeKey(LOGIN_KEYS).key).update(`ip:${ip}`, 'utf8').digest('hex');
  const failureRowsOf = async (ip: string): Promise<number> =>
    (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM login_code_attempts WHERE client_key = $1', [ipKeyOf(ip)])).rows[0]?.n ?? 0;

  /** 정해진 IP 에서 로그인 요청 → 메일의 코드 · 논스(메일이 안 나갔으면 code 가 null — 발급 상한에 걸렸다). */
  async function requestCodeFrom(organization: { id: string; ownerEmail: string }, ip: string, nonce?: string) {
    const requested = await call(deps(), 'POST', '/api/login', {
      body: { email: organization.ownerEmail },
      ip,
      ...(nonce === undefined ? {} : { cookies: { [LOGIN_BROWSER_COOKIE]: nonce } }),
    });
    expect(requested.statusCode).toBe(202);
    const browser = cookieValue(requested, LOGIN_BROWSER_COOKIE) ?? '';
    const mail = (await drainLoginMail(mailer, organization.id)).at(-1);
    return { nonce: browser, code: mail === undefined ? null : codeFromMail(mail), body: requested.body };
  }

  /** 신뢰 밖 요청자에게 나간 것처럼 보이는 지난 코드 행(2시간 전 · 보냄 · 만료)을 심는다 — 15분 창 밖, 하루 창 안. */
  async function seedUntrustedLinks(organizationId: string, userId: string, n: number): Promise<void> {
    await owner.query(
      `INSERT INTO owner_login_links (organization_id, user_id, browser_binding, client_key, created_at, expires_at, status, sent_at, ses_message_id)
       SELECT $1, $2, md5(random()::text) || md5(random()::text), md5(random()::text) || md5(random()::text), t,
              date_trunc('milliseconds', t + interval '15 minutes'), 'sent', t, 'seed-' || g
         FROM (SELECT date_trunc('milliseconds', now() - interval '2 hours') AS t) at, generate_series(1, $3) g`,
      [organizationId, userId, n],
    );
  }

  it('공격자 IP 가 피해자 주소로 코드를 받아 틀린 코드를 다 태워도(IP 상한까지) 피해자의 신뢰 IP 로그인은 된다 — 계정 단위 잠금 없음', async () => {
    const organization = await newOrganization(owner);
    const userId = await userIdOf(owner, organization.ownerEmail);
    const homeIp = uniqueIp();
    const before = await requestCodeFrom(organization, homeIp);
    expect((await verifyCode(before.code, before.nonce, {}, homeIp)).statusCode).toBe(200);

    const attackerIp = uniqueIp();
    // 공격자: 자기 IP 로 피해자 주소의 코드 — 신뢰 밖 15분 몫(2통)까지 받고, 각 5번씩 틀려 그 코드는 끝.
    const attacker = await requestCodeFrom(organization, attackerIp);
    for (let i = 1; i < LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW; i += 1) await requestCodeFrom(organization, attackerIp, attacker.nonce);
    expect((await requestCodeFrom(organization, attackerIp, attacker.nonce)).code).toBeNull(); // 조용히 0행(같은 202)
    for (let i = 0; i < LOGIN_CODE_FAILURES_PER_CLIENT; i += 1) {
      expect((await verifyCode('000000', attacker.nonce, {}, attackerIp)).statusCode).toBe(401);
    }
    const limited = await verifyCode('000000', attacker.nonce, {}, attackerIp);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate_limited' });
    expect(await failuresOf(userId)).toEqual([0, 5, 5]);
    expect(await failureRowsOf(attackerIp)).toBe(LOGIN_CODE_FAILURES_PER_CLIENT);

    // 피해자: 평소 IP 에서 코드를 받고 로그인된다(예전: 계정 예산 20 이 차면 24시간 401). 맞는 코드는 IP 원장에 세지 않는다.
    const victim = await requestCodeFrom(organization, homeIp);
    expect(victim.code).not.toBeNull();
    const ok = await verifyCode(victim.code, victim.nonce, {}, homeIp);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await failureRowsOf(homeIp)).toBe(0);
  });

  it(`대입 바닥: 신뢰 밖에서는 IP 를 몇 개 쓰든 주소당 하루 코드 ${String(LOGIN_UNTRUSTED_LINKS_PER_USER_PER_DAY)}통 × ${String(LOGIN_CODE_MAX_FAILURES)}회 ≤ 20번 · 신뢰 IP 는 그 위에서도 코드를 받는다 · 처음 보는 IP 는 같은 202 로 0통`, async () => {
    const organization = await newOrganization(owner);
    const userId = await userIdOf(owner, organization.ownerEmail);
    const homeIp = uniqueIp();
    const before = await requestCodeFrom(organization, homeIp);
    expect((await verifyCode(before.code, before.nonce, {}, homeIp)).statusCode).toBe(200);

    // 하루 몫 중 3통은 2시간 전에 이미 나갔다(15분 창 밖) — 15분 창은 2통을 허락하지만 하루 몫이 1통만 남았다.
    await seedUntrustedLinks(organization.id, userId, LOGIN_UNTRUSTED_LINKS_PER_USER_PER_DAY - 1);
    // 공격자: 매번 새 IP · 새 브라우저로 코드를 요청하고 받은 코드마다 다 틀린다.
    let issued = 0;
    for (let i = 0; i < 6; i += 1) {
      const ip = uniqueIp();
      const got = await requestCodeFrom(organization, ip);
      if (got.code === null) continue;
      issued += 1;
      for (let k = 0; k < LOGIN_CODE_MAX_FAILURES + 1; k += 1) expect((await verifyCode(wrong(got.code), got.nonce, {}, ip)).statusCode).toBe(401);
    }
    expect(issued).toBe(1); // 하루 상한이 15분 창(2)보다 먼저 닫았다
    // 신뢰 밖 코드의 하루 합: 4통 · 틀린 코드로 셀 수 있는 것 ≤ 4 × 5 = 20.
    const untrusted = await owner.query<{ n: number; guesses: number }>(
      `SELECT count(*)::int AS n, (count(*) * $3)::int AS guesses FROM owner_login_links
        WHERE user_id = $1 AND created_at > now() - interval '1 day' AND client_key <> $2`,
      [userId, ipKeyOf(homeIp), LOGIN_CODE_MAX_FAILURES],
    );
    expect(untrusted.rows[0]?.n).toBe(LOGIN_UNTRUSTED_LINKS_PER_USER_PER_DAY);
    expect(untrusted.rows[0]?.guesses).toBeLessThanOrEqual(20);
    expect(LOGIN_UNTRUSTED_LINKS_PER_USER_PER_DAY * LOGIN_CODE_MAX_FAILURES).toBe(20);
    const burned = await owner.query<{ n: number }>(
      'SELECT coalesce(sum(code_failures), 0)::int AS n FROM owner_login_links WHERE user_id = $1',
      [userId],
    );
    expect(burned.rows[0]?.n).toBeLessThanOrEqual(20);

    // 처음 보는 IP — 15분 창은 남았지만 하루 몫이 찼다. 응답은 없는 주소와 같은 202 · 같은 본문(열거 신호 없음).
    const stranger = await requestCodeFrom(organization, uniqueIp());
    expect(stranger.code).toBeNull();
    const ghost = await call(deps(), 'POST', '/api/login', { body: { email: `ghost-${suffix()}@example.com` }, ip: uniqueIp() });
    expect(ghost.statusCode).toBe(202);
    expect(ghost.body).toBe(stranger.body);
    // 신뢰 IP 는 넉넉한 몫(15분 5 · 하루 50)으로 — 코드를 받고 로그인된다.
    const home = await requestCodeFrom(organization, homeIp);
    expect(home.code).not.toBeNull();
    expect((await verifyCode(home.code, home.nonce, {}, homeIp)).statusCode).toBe(200);
  });

  it('IP 당 틀린 코드 시간당 30 — 31번째 429(로그인·가입 같은 원장) · 다른 IP 는 그대로 · 맞는 코드는 세지 않는다', async () => {
    const ip = uniqueIp();
    const ghost = await call(deps(), 'POST', '/api/login', { body: { email: `ghost-${suffix()}@example.com` }, ip: uniqueIp() });
    const ghostNonce = cookieValue(ghost, LOGIN_BROWSER_COOKIE) ?? '';
    // 같은 IP 에서 먼저 맞는 코드로 로그인 — 원장에 행이 생기지 않는다.
    const organization = await newOrganization(owner);
    const { nonce, code } = await requestCode(organization);
    expect((await verifyCode(code, nonce, {}, ip)).statusCode).toBe(200);
    expect(await failureRowsOf(ip)).toBe(0);
    for (let i = 0; i < LOGIN_CODE_FAILURES_PER_CLIENT - 1; i += 1) expect((await verifyCode('000000', ghostNonce, {}, ip)).statusCode).toBe(401);
    // 30번째는 가입 verify — 같은 원장이다.
    const signupLast = await call(deps(), 'POST', '/api/signup/verify', { body: { code: '000000' }, ip, cookies: { [SIGNUP_BROWSER_COOKIE]: 'a'.repeat(43) } });
    expect(signupLast.statusCode).toBe(401);
    expect(await failureRowsOf(ip)).toBe(LOGIN_CODE_FAILURES_PER_CLIENT);
    // 논스를 새로 만들어도(새 브라우저) 같은 IP 는 429 — 로그인 · 가입 모두.
    const blocked = await verifyCode('000000', 'z'.repeat(43), {}, ip);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: 'rate_limited' });
    const signupBlocked = await call(deps(), 'POST', '/api/signup/verify', { body: { code: '000000' }, ip, cookies: { [SIGNUP_BROWSER_COOKIE]: 'b'.repeat(43) } });
    expect(signupBlocked.statusCode).toBe(429);
    expect(await failureRowsOf(ip)).toBe(LOGIN_CODE_FAILURES_PER_CLIENT);
    // 다른 IP 는 상한과 무관하다 — 있는 계정의 맞는 코드가 된다.
    const other = await newOrganization(owner);
    const fresh = await requestCode(other);
    expect((await verifyCode(fresh.code, fresh.nonce)).statusCode).toBe(200);
    // 한 시간이 지난 행은 세지 않는다.
    const stale = uniqueIp();
    await owner.query(`INSERT INTO login_code_attempts (client_key, created_at) SELECT $1, now() - interval '61 minutes' FROM generate_series(1, 40)`, [ipKeyOf(stale)]);
    expect((await verifyCode('000000', ghostNonce, {}, stale)).statusCode).toBe(401);
  });

  it('응답은 주소와 무관 — 있는 주소 · 없는 주소의 틀린 코드는 같은 401 본문 · IP 상한의 429 도 같은 본문', async () => {
    const organization = await newOrganization(owner);
    const { nonce, code } = await requestCode(organization);
    const ghost = await call(deps(), 'POST', '/api/login', { body: { email: `ghost-${suffix()}@example.com` }, ip: uniqueIp() });
    const ghostNonce = cookieValue(ghost, LOGIN_BROWSER_COOKIE) ?? '';
    const known = await verifyCode(wrong(code), nonce);
    const unknown = await verifyCode(wrong(code), ghostNonce);
    expect(known.statusCode).toBe(401);
    expect(unknown.body).toBe(known.body);
    const ipA = uniqueIp();
    const ipB = uniqueIp();
    await owner.query('INSERT INTO login_code_attempts (client_key) SELECT $1 FROM generate_series(1, $2)', [ipKeyOf(ipA), LOGIN_CODE_FAILURES_PER_CLIENT]);
    await owner.query('INSERT INTO login_code_attempts (client_key) SELECT $1 FROM generate_series(1, $2)', [ipKeyOf(ipB), LOGIN_CODE_FAILURES_PER_CLIENT]);
    const limitedKnown = await verifyCode(code, nonce, {}, ipA);
    const limitedUnknown = await verifyCode(code, ghostNonce, {}, ipB);
    expect(limitedKnown.statusCode).toBe(429);
    expect(limitedUnknown.body).toBe(limitedKnown.body);
    // 막힌 IP 의 시도는 코드의 틀린 수도 올리지 않는다 — 다른 IP 에서 맞는 코드가 된다.
    expect((await verifyCode(code, nonce)).statusCode).toBe(200);
  });

  it('경합: 같은 IP 의 여러 브라우저가 동시에 상한에 닿아도 30 을 넘겨 쓰지 않는다(IP advisory 잠금)', async () => {
    const ip = uniqueIp();
    await owner.query('INSERT INTO login_code_attempts (client_key) SELECT $1 FROM generate_series(1, $2)', [ipKeyOf(ip), LOGIN_CODE_FAILURES_PER_CLIENT - 3]);
    const nonces = Array.from({ length: 8 }, (_, i) => `${String.fromCharCode(99 + i)}`.repeat(43));
    const results = await Promise.all(nonces.map((nonce) => verifyCode('000000', nonce, {}, ip)));
    expect(results.map((result) => result.statusCode).sort()).toEqual([401, 401, 401, 429, 429, 429, 429, 429]);
    expect(await failureRowsOf(ip)).toBe(LOGIN_CODE_FAILURES_PER_CLIENT);
  });

  it('L3 원장 보존: 하루 넘은 행만 purge_login_code_attempts()(앱 롤 EXECUTE) 가 지운다 · 앱 롤은 표를 읽지 못한다 · admin 은 지우지 못한다', async () => {
    const oldKey = createHmac('sha256', Buffer.from(suffix())).update('old').digest('hex');
    const newKey = createHmac('sha256', Buffer.from(suffix())).update('new').digest('hex');
    await owner.query(`INSERT INTO login_code_attempts (client_key, created_at) VALUES ($1, now() - interval '25 hours'), ($2, now())`, [oldKey, newKey]);
    const app = appPool();
    try {
      await expect(app.query('SELECT 1 FROM login_code_attempts LIMIT 1')).rejects.toMatchObject({ code: '42501' });
      const purged = await app.query<{ purged: number }>('SELECT purge_login_code_attempts() AS purged');
      expect(purged.rows[0]?.purged).toBeGreaterThanOrEqual(1);
    } finally {
      await app.end();
    }
    const left = await owner.query<{ client_key: string }>('SELECT client_key FROM login_code_attempts WHERE client_key = ANY($1::text[])', [[oldKey, newKey]]);
    expect(left.rows.map((row) => row.client_key)).toEqual([newKey]);
    await expect(admin.query('DELETE FROM login_code_attempts WHERE client_key = $1', [newKey])).rejects.toMatchObject({ code: '42501' });
    await expect(admin.query('UPDATE login_code_attempts SET created_at = now() WHERE client_key = $1', [newKey])).rejects.toMatchObject({ code: '42501' });
  });

  it('가입: 앞선 가입 코드들이 다 죽어도(주소 단위 틀린 코드 예산 없음) 새 가입 코드는 된다 · 코드마다 5회면 끝 · 옛 링크 토큰은 410', async () => {
    const email = `code-budget-${suffix()}${suffix()}@example.com`;
    createdSignupEmails.push(email);
    const first = await requestSignup(email);
    for (let i = 0; i < 2; i += 1) await requestSignup(email, { [SIGNUP_BROWSER_COOKIE]: first.signupNonce, [LOGIN_BROWSER_COOKIE]: first.loginNonce });
    const ses = fakeSes();
    const notifier = createSignupNotifier({ pool: mailer, client: ses.client, keyring: LOGIN_KEYS, now: () => new Date(), capPerHour: 1_000_000 });
    await afterDbNow(mailer); // 행의 next_attempt_at 은 DB 시각 — 테스트 시계가 뒤처지면 아직 기한 전으로 보인다
    await runSignupMailer({ db: mailer, notifier, now: () => new Date() }, { email });
    const codes = (ses.sent as SentMail[]).map(codeFromMail);
    expect(codes).toHaveLength(3);
    const bad = ['000000', '999999', '123456', '654321', '111111'].find((candidate) => !codes.includes(candidate)) ?? '222222';
    // 틀린 코드는 주소마다 최신의 살아 있는 가입 링크 하나만 센다(L-1) — 첫 번째는 최신 하나만 +1, 15번이면 셋 모두 5.
    const eachOf = async (): Promise<number[]> =>
      (await owner.query<{ code_failures: number }>('SELECT code_failures FROM signup_links WHERE email = $1 ORDER BY created_at', [email])).rows.map(
        (row) => row.code_failures,
      );
    expect((await verifySignupCode(bad, first)).statusCode).toBe(401);
    expect(await eachOf()).toEqual([0, 0, 1]);
    for (let i = 1; i < 3 * LOGIN_CODE_MAX_FAILURES; i += 1) expect((await verifySignupCode(bad, first)).statusCode).toBe(401);
    expect(await eachOf()).toEqual([5, 5, 5]);
    const sum = await owner.query<{ n: number }>('SELECT sum(code_failures)::int AS n FROM signup_links WHERE email = $1', [email]);
    expect(sum.rows[0]?.n).toBe(15);

    // 옛 링크 토큰은 410(세션 없음). 새 브라우저의 새 가입 코드는 된다 — 주소 단위 틀린 코드 예산은 없다.
    const fresh = await requestSignup(email);
    const link = await call(deps(), 'POST', '/api/signup/verify', { body: { token: 'atk_signup_k1.x.y' }, cookies: { [SIGNUP_BROWSER_COOKIE]: fresh.signupNonce } });
    expect(link.statusCode, link.body).toBe(410);
    const mail = await drainSignupMail(email);
    if (mail === undefined) throw new Error('가입 메일이 나가지 않았다');
    const ok = await verifySignupCode(codeFromMail(mail), fresh);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await owner.query('SELECT 1 FROM organizations WHERE owner_email = $1', [email])).rowCount).toBe(1);
  });

  it('L4 부분 색인: 두 후보 문장이 결속 부분 색인을 탄다(EXPLAIN)', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = async (sql: string): Promise<string> =>
        (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`)).rows.map((row) => row['QUERY PLAN']).join('\n');
      // 후보 문장의 안쪽(사용자·주소마다 최신 하나, L-1)이 결속을 고르는 곳이다.
      const login = await plan(
        `SELECT DISTINCT ON (c.user_id) c.id FROM owner_login_links c WHERE c.browser_binding = '${'a'.repeat(64)}' AND c.used_at IS NULL
           AND c.invalidated_at IS NULL AND c.expires_at > now() AND c.status = 'sent' AND c.code_failures < 5 AND c.user_id IS NOT NULL
           ORDER BY c.user_id, c.created_at DESC, c.id`,
      );
      expect(login).toContain('owner_login_links_code_candidates_idx');
      const signup = await plan(
        `SELECT DISTINCT ON (c.email) c.id FROM signup_links c WHERE c.browser_binding = '${'a'.repeat(64)}' AND c.used_at IS NULL
           AND c.expires_at > now() AND c.status = 'sent' AND c.code_failures < 5 ORDER BY c.email, c.created_at DESC, c.id`,
      );
      expect(signup).toContain('signup_links_code_candidates_idx');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
