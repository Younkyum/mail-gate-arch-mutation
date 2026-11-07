/**
 * **셀프 가입 — 실제 Postgres 위에서** (`signup-contract.md` §5, `src/admin/session.ts` 가입 절 · `routes/signup.ts`). 실메일 0(가짜 SES) · AWS 0.
 *
 * 라우터는 `atmark_admin` 롤(운영 admin Lambda 의 롤)로 돈다 — 소유자 롤로 돌리면 GRANT 가 모자라도 초록이다. 테스트 지반(조직
 * 심기·검사·검토 상태 변경)만 소유자 롤. 가입 메일 워커는 로그인 메일 롤(`atmark_login_mailer`)로 돈다.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 열거 방지: 새 주소 · 이미 소유자인 주소 · 모양은 맞지만 이상한 주소 — 같은 202 · 같은 본문 · 같은 쿠키 모양 · **같은 SQL 문장·순서**
 *   - 이미 소유자인 주소 → 가입 링크가 아니라 그 조직의 **로그인 링크**(그리고 가입 응답의 로그인 논스로 로그인된다)
 *   - 요청자 상한 5/h(동시 30건 → 정확히 5건 202 · 25건 429) · 같은 주소 하루 두 층 — (주소, 요청자) 3 · 주소 10(넘어도 202)
 *   - 검증 M1: 공격자 요청자가 피해자 주소의 자기 몫(3)을 다 태워도 피해자의 요청자는 링크를 받는다
 *   - 검증 M2: 새 조직 상한(`create_signup_organization` 의 SQLSTATE `AT429`) → 409 `signup_capacity` · 링크 미소진 · 조직·세션·감사 없음
 *   - verify(코드만 — 2026-10-10 가입 확인 링크 삭제): 결속 쿠키 없음 401 `signup_browser_missing`(미소진) · 다른 브라우저·재사용·틀린 코드·다른 문맥 401
 *     `signup_code_invalid` · 옛 링크 토큰 410 `signup_link_retired`(토큰을 보지 않는다)
 *   - verify 성공: `pending_review` 조직 + 세션 + 감사(`signup.verify`) · 감사 실패 → 조직 없음 · 링크 미소진 · 세션 없음
 *   - 검토 전 조직의 에이전트 상한 2(콘솔 409 `agent_limit` · CLI 같은 코드) · 활성화되면 풀린다
 *   - `/api/me` 의 `organization.reviewStatus`
 *   - 모양 오류만 400(`consent_required` · `invalid_organization_name` · `invalid_email`) — DB 에 아무것도 적지 않는다
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentProvision } from '../../../scripts/admin/agent-provision';
import type { AdminIo } from '../../../scripts/admin/common';
import { LOGIN_BROWSER_COOKIE, SESSION_COOKIE, SIGNUP_BROWSER_COOKIE } from '../../../src/admin/http';
import { createOrganizationOp, MAX_AGENTS_PER_ORG, MAX_AGENTS_PER_PENDING_ORG } from '../../../src/admin/ops/agents';
import { AdminInputError } from '../../../src/admin/ops/errors';
import { csrfTokenOf } from '../../../src/admin/session';
import {
  SIGNUP_LINKS_PER_EMAIL_PER_DAY,
  SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR,
  SIGNUP_REQUESTS_PER_EMAIL_PER_CLIENT_PER_DAY,
  SIGNUP_REQUESTS_PER_EMAIL_PER_DAY,
} from '../../../src/security/login-limits';
import { createSignupNotifier } from '../../../src/notify/signup-notifier';
import { mintLoginCode } from '../../../src/security/login-code';
import { runSignupMailer } from '../../../src/workers/signup-mailer';
import {
  adminDeps,
  adminRolePool,
  authed,
  AVAILABLE,
  call,
  cookieValue,
  drainLoginMail,
  fakeSes,
  LOGIN_KEYS,
  loginMailerPool,
  mailText,
  newOrganization,
  OWNER_URL,
  ownerPool,
  suffix,
  codeFromMail,
  uniqueCodeIp,
  type RequestOptions,
  type SentMail,
  type Session,
} from './support';
import { codeOfMail, seedInvitedEmails, signupCodeOf } from '../signup/support';
import { afterDbNow } from '../../support/db-clock';

const keyDir = mkdtempSync(resolve(tmpdir(), 'atmark-signup-keys-'));
const cliEnv = (): NodeJS.ProcessEnv => ({ DATABASE_MIGRATION_URL: OWNER_URL, ATMARK_DEV_KEY_DIR: keyDir, USER: 'signup-test' });
const cliIo = (): AdminIo => ({ out: () => undefined, err: () => undefined, interactive: false, ask: async () => '' });
async function cliCode(run: Promise<number>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof AdminInputError) return error.code;
    throw error;
  }
  return 'ok';
}

/** 테스트마다 고유한 요청자 — 공유 DB 에서 요청자 상한(시간당 5)이 다른 테스트·이전 실행과 섞이지 않게. */
const uniqueIp = (): string => `203.0.113.${String(Math.floor(Math.random() * 250))}-${suffix()}${suffix()}`;
/** 이 파일이 만든 가입 주소 — 끝나면 남은 검토 대기 조직을 `rejected` 로 돌린다(전역 검토 대기 상한 200 을 공유 DB 에서 채우지 않게). */
const createdEmails: string[] = [];
/** 초대 전용 가입(202609301520) — 살아 있는 초대가 있는 주소를 `beforeAll` 에서 한 번에 심어 두고 꺼내 쓴다. */
let invitedEmails: string[] = [];
const newEmail = (): string => {
  const email = invitedEmails.pop() ?? `signup-${suffix()}${suffix()}@example.com`;
  createdEmails.push(email);
  return email;
};

/** 감사 INSERT 만 실패시키는 풀(console-fixes 와 같은 모의) — 풀 직접 문장과 트랜잭션 커넥션 문장 둘 다. */
function failingAudit(pool: Pool): Pool {
  const isAudit = (text: unknown): boolean => typeof text === 'string' && text.includes('INSERT INTO owner_actions');
  const failure = (): Promise<never> => Promise.reject(new Error('모의 감사 실패'));
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'query') return (text: string, values?: unknown[]) => (isAudit(text) ? failure() : target.query(text, values));
      if (property === 'connect') {
        return async (): Promise<PoolClient> => {
          const client = await target.connect();
          const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<unknown>;
          return Object.assign(Object.create(client) as PoolClient, {
            query: (text: string, values?: unknown[]) => (isAudit(text) ? failure() : query(text, values)),
            release: () => client.release(),
          });
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** 풀 직접 문장과 트랜잭션 커넥션 문장을 **둘 다** 적는 풀(로그인 열거 테스트와 같은 기법). */
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
        return async () => {
          const client = await target.connect();
          const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<unknown>;
          return Object.assign(Object.create(client) as object, {
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

describe.skipIf(!AVAILABLE)('셀프 가입 (console.atmark.ai /signup) — atmark_admin 롤', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  beforeAll(async () => {
    invitedEmails = await seedInvitedEmails(200, 'signup');
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
  });
  afterAll(async () => {
    await owner.query(
      `UPDATE organizations SET review_status = 'rejected' WHERE owner_email = ANY($1::text[]) AND review_status = 'pending_review'`,
      [createdEmails],
    );
    await Promise.all([owner.end(), admin.end(), mailer.end()]);
  });

  const deps = (overrides: Parameters<typeof adminDeps>[1] = {}): ReturnType<typeof adminDeps> => adminDeps(admin, overrides);

  async function requestSignup(email: string, options: RequestOptions & { organizationName?: string } = {}) {
    return call(deps(), 'POST', '/api/signup', {
      body: { email, organizationName: options.organizationName ?? `Acme ${suffix()}`, consent: true },
      ip: options.ip ?? uniqueIp(),
      ...(options.cookies === undefined ? {} : { cookies: options.cookies }),
    });
  }

  async function latestLink(email: string): Promise<{ id: string; expires_at: Date; used_at: Date | null; organization_id: string | null } | undefined> {
    const rows = await owner.query<{ id: string; expires_at: Date; used_at: Date | null; organization_id: string | null }>(
      'SELECT id, expires_at, used_at, organization_id FROM signup_links WHERE email = $1 ORDER BY created_at DESC LIMIT 1',
      [email],
    );
    return rows.rows[0];
  }

  /**
   * 가입 요청 → 링크 행을 보낸 상태로 표시하고 메일러와 같은 키 · 문맥으로 코드를 만든다(메일러의 전역 상한과 무관하게 — 메일 경로 자체는 첫 테스트가
   * 본다). 가입 확인은 코드만이다(2026-10-10).
   */
  async function signupCode(email: string, organizationName?: string): Promise<{ code: string; nonce: string; linkId: string }> {
    const requested = await requestSignup(email, organizationName === undefined ? {} : { organizationName });
    expect(requested.statusCode, requested.body).toBe(202);
    const nonce = cookieValue(requested, SIGNUP_BROWSER_COOKIE) ?? '';
    const link = await latestLink(email);
    if (link === undefined) throw new Error('가입 링크 행이 없다');
    return { code: await signupCodeOf(owner, LOGIN_KEYS, link), nonce, linkId: link.id };
  }

  async function verify(code: string, nonce: string | undefined, overrides: Parameters<typeof adminDeps>[1] = {}) {
    return call(deps(overrides), 'POST', '/api/signup/verify', {
      body: { code },
      ip: uniqueCodeIp(),
      ...(nonce === undefined ? {} : { cookies: { [SIGNUP_BROWSER_COOKIE]: nonce } }),
    });
  }

  async function signedUp(): Promise<{ email: string; organizationId: string; session: Session }> {
    const email = newEmail();
    const { code, nonce } = await signupCode(email);
    const verified = await verify(code, nonce);
    expect(verified.statusCode, verified.body).toBe(200);
    const sessionToken = cookieValue(verified, SESSION_COOKIE) ?? '';
    const org = await owner.query<{ id: string }>('SELECT id FROM organizations WHERE owner_email = $1', [email]);
    const organizationId = org.rows[0]?.id ?? '';
    return { email, organizationId, session: { cookies: { [SESSION_COOKIE]: sessionToken }, csrf: csrfTokenOf(sessionToken), token: sessionToken } };
  }

  // -------------------------------------------------------------------------
  // 전체 흐름
  // -------------------------------------------------------------------------

  it('전체 흐름: 202 + 쿠키 둘 → 가입 메일(로그인 메일 롤 워커 · 가짜 SES) → 같은 브라우저 verify → active(Free) 조직(초대 전용 — 202609301520) · 세션 · 감사', async () => {
    const email = newEmail();
    const requested = await requestSignup(`  ${email.toUpperCase()} `, { organizationName: '  Acme 연구소  ' });
    expect(requested.statusCode).toBe(202);
    expect(requested.json()).toEqual({ ok: true });
    const signupCookie = (requested.cookies ?? []).find((c) => c.startsWith(`${SIGNUP_BROWSER_COOKIE}=`)) ?? '';
    expect(signupCookie).toMatch(/^__Host-atmark_signup=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=1800$/);
    const loginCookie = (requested.cookies ?? []).find((c) => c.startsWith(`${LOGIN_BROWSER_COOKIE}=`)) ?? '';
    expect(loginCookie).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=900$/);

    // 메일 — 로그인 메일 롤의 워커가 가짜 SES 로(실메일 0). 수신자는 정규화된 입력 주소, 링크는 프래그먼트 `#t=`.
    const ses = fakeSes();
    const notifier = createSignupNotifier({
      pool: mailer,
      client: ses.client,
      keyring: LOGIN_KEYS,
      now: () => new Date(),
      // 실제 시각 흐름 — 전역 상한은 공유 DB 의 창 전체를 센다. 상한 동작은 signup-mailer.test.ts 가 본다.
      capPerHour: 1_000_000,
    });
    await afterDbNow(mailer); // 행의 next_attempt_at 은 DB 시각 — 테스트 시계가 뒤처지면 아직 기한 전으로 보인다
    const report = await runSignupMailer({ db: mailer, notifier, now: () => new Date() }, { email });
    expect(report.sent, JSON.stringify(report)).toBe(1);
    const [mail] = ses.sent as SentMail[];
    expect(mail?.to).toEqual([email]);
    const text = mail === undefined ? '' : mailText(mail);
    expect(text).not.toMatch(/https?:\/\/|atk_signup_/); // 코드만(2026-10-10)
    const code = mail === undefined ? '' : codeOfMail(mail);

    const verified = await verify(code, cookieValue(requested, SIGNUP_BROWSER_COOKIE));
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toEqual({ redirect: '/app' });
    const sessionCookie = (verified.cookies ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '';
    expect(sessionCookie).toMatch(/^__Host-atmark_admin=atk_admin_[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);
    // 가입 논스는 지우지 않는다 — 같은 브라우저에서 쓴 링크를 다시 열면 "이미 쓴 링크" 로 안내되게(아래 재사용 테스트).
    expect(verified.cookies ?? []).toHaveLength(1);

    const org = await owner.query<{ id: string; name: string; review_status: string; signup_source: string; billing_status: string }>(
      'SELECT id, name, review_status::text, signup_source, billing_status::text FROM organizations WHERE owner_email = $1',
      [email],
    );
    expect(org.rows).toHaveLength(1);
    const created = org.rows[0];
    expect(created).toMatchObject({ name: 'Acme 연구소', review_status: 'active', signup_source: 'self_signup' });
    const link = await latestLink(email);
    expect(link?.used_at).toBeInstanceOf(Date);
    expect(link?.organization_id).toBe(created?.id);
    const audit = await owner.query<{ action: string; target_id: string }>('SELECT action, target_id FROM owner_actions WHERE organization_id = $1', [
      created?.id,
    ]);
    expect(audit.rows).toEqual([{ action: 'signup.verify', target_id: created?.id }]);

    const sessionToken = cookieValue(verified, SESSION_COOKIE) ?? '';
    const me = await call(deps(), 'GET', '/api/me', { cookies: { [SESSION_COOKIE]: sessionToken } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { organization: unknown }).organization).toEqual({
      id: created?.id,
      name: 'Acme 연구소',
      ownerEmail: email,
      reviewStatus: 'active',
      role: 'owner',
    });
  });

  // -------------------------------------------------------------------------
  // 열거 방지
  // -------------------------------------------------------------------------

  it('열거 방지: 새 주소 · 이미 소유자인 주소 · 이상하지만 모양은 맞는 주소 — 같은 202 · 같은 본문 · 같은 쿠키 모양 · 같은 SQL 문장과 순서', async () => {
    const existing = await newOrganization(owner);
    const fresh = newEmail();
    const odd = `Weird+Tag.${suffix()}@Sub.Example-Domain.COM`;
    const statements: string[][] = [[], [], []];
    const results = [];
    for (const [index, email] of [existing.ownerEmail, fresh, odd].entries()) {
      results.push(
        await call(adminDeps(recording(admin, statements[index] ?? [])), 'POST', '/api/signup', {
          body: { email, organizationName: 'Same Name', consent: true },
          ip: uniqueIp(),
        }),
      );
    }
    const shape = (cookies: readonly string[] | undefined): string[] => (cookies ?? []).map((c) => c.replace(/=[^;]+;/, '=X;'));
    for (const result of results) {
      expect(result.statusCode).toBe(202);
      expect(result.body).toBe('{"ok":true}');
      expect(shape(result.cookies)).toEqual(shape(results[0]?.cookies));
      expect(Object.keys(result.headers).sort()).toEqual(Object.keys(results[0]?.headers ?? {}).sort());
    }
    expect(shape(results[0]?.cookies)).toEqual([
      `${SIGNUP_BROWSER_COOKIE}=X; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=1800`,
      `${LOGIN_BROWSER_COOKIE}=X; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`,
    ]);
    // 일치 여부로 갈리는 분기가 없다 — 같은 문장이 같은 순서로(값만 다르다).
    expect(statements[1]).toEqual(statements[0]);
    expect(statements[2]).toEqual(statements[0]);
    expect(statements[0]?.length).toBeGreaterThanOrEqual(8);
    expect(statements[0]?.some((s) => s.startsWith('INSERT INTO owner_login_links'))).toBe(true);
    expect(statements[0]?.some((s) => s.startsWith('INSERT INTO signup_links'))).toBe(true);

    // 데이터가 가른 결과: 소유자 주소 → 로그인 링크 1 · 가입 링크 0 / 초대받은 새 주소 → 가입 링크 1 / 초대받지 않은 새 주소(202609301520) →
    //   가입 링크 0 · 대기자 명단 한 행(출처 signup). 세 번째 문장(`SELECT waitlist_join`)도 세 갈래에서 똑같이 돈다(위 문장 비교).
    expect(statements[0]?.some((s) => s.startsWith('SELECT waitlist_join'))).toBe(true);
    expect((await owner.query('SELECT 1 FROM owner_login_links WHERE organization_id = $1', [existing.id])).rowCount).toBe(1);
    expect((await owner.query('SELECT 1 FROM signup_links WHERE email = $1', [existing.ownerEmail])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM waitlist_entries WHERE email = $1', [existing.ownerEmail])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM signup_links WHERE email = $1', [fresh])).rowCount).toBe(1);
    expect((await owner.query('SELECT 1 FROM signup_links WHERE email = $1', [odd.toLowerCase()])).rowCount).toBe(0);
    expect((await owner.query(`SELECT source, status FROM waitlist_entries WHERE email = $1`, [odd.toLowerCase()])).rows).toEqual([{ source: 'signup', status: 'waiting' }]);
  });

  it('이미 소유자인 주소의 가입 요청 → 가입 메일이 아니라 로그인 링크 · 가입 응답이 준 로그인 논스로 그 브라우저에서 로그인된다 · 조직은 늘지 않는다', async () => {
    const existing = await newOrganization(owner);
    const requested = await requestSignup(existing.ownerEmail);
    expect(requested.statusCode).toBe(202);
    const mails = await drainLoginMail(mailer, existing.id);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toEqual([existing.ownerEmail]);
    const verified = await call(deps(), 'POST', '/api/login/verify', {
      body: { code: mails[0] === undefined ? '' : codeFromMail(mails[0]) },
      cookies: { [LOGIN_BROWSER_COOKIE]: cookieValue(requested, LOGIN_BROWSER_COOKIE) ?? '' },
      ip: uniqueCodeIp(),
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect((await owner.query('SELECT 1 FROM organizations WHERE owner_email = $1', [existing.ownerEmail])).rowCount).toBe(1);
    expect((await owner.query('SELECT 1 FROM signup_links WHERE email = $1', [existing.ownerEmail])).rowCount).toBe(0);
  });

  it('가입 링크를 받은 뒤 그 주소의 조직이 (CLI 로) 생겼으면 verify 는 새 조직을 만들지 않고 그 조직의 세션을 연다', async () => {
    const email = newEmail();
    const { code, nonce } = await signupCode(email);
    const operatorOrg = { rows: [await createOrganizationOp(owner, { name: 'operator-made', ownerEmail: email })] };
    const verified = await verify(code, nonce);
    expect(verified.statusCode, verified.body).toBe(200);
    const orgs = await owner.query<{ id: string }>('SELECT id FROM organizations WHERE owner_email = $1', [email]);
    expect(orgs.rows.map((row) => row.id)).toEqual([operatorOrg.rows[0]?.id]);
    const me = await call(deps(), 'GET', '/api/me', { cookies: { [SESSION_COOKIE]: cookieValue(verified, SESSION_COOKIE) ?? '' } });
    expect((me.json() as { organization: { id: string; reviewStatus: string } }).organization).toMatchObject({
      id: operatorOrg.rows[0]?.id,
      reviewStatus: 'active',
    });
  });

  // -------------------------------------------------------------------------
  // 상한
  // -------------------------------------------------------------------------

  it(`요청자 상한: 같은 요청자의 동시 30건 → 정확히 ${String(SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR)}건 202 · 나머지 429 · 가입 링크도 그만큼`, async () => {
    const ip = uniqueIp();
    const emails = Array.from({ length: 30 }, () => newEmail());
    const results = await Promise.all(
      emails.map((email) => call(deps(), 'POST', '/api/signup', { body: { email, organizationName: 'Race', consent: true }, ip })),
    );
    const statuses = results.map((result) => result.statusCode);
    expect(statuses.filter((status) => status === 202)).toHaveLength(SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR);
    expect(statuses.filter((status) => status === 429)).toHaveLength(30 - SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR);
    expect(results.find((result) => result.statusCode === 429)?.json()).toMatchObject({ error: 'rate_limited' });
    const links = await owner.query('SELECT 1 FROM signup_links WHERE email = ANY($1::text[])', [emails]);
    expect(links.rowCount).toBe(SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR);
  });

  it(`같은 주소·같은 요청자 하루 ${String(SIGNUP_REQUESTS_PER_EMAIL_PER_CLIENT_PER_DAY)}회: 한 요청자에서 5번 → 전부 같은 202 · 링크는 ${String(SIGNUP_REQUESTS_PER_EMAIL_PER_CLIENT_PER_DAY)}개 (조용히)`, async () => {
    const email = newEmail();
    const ip = uniqueIp();
    const results = [];
    for (let i = 0; i < SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR; i++) results.push(await requestSignup(email, { ip }));
    for (const result of results) {
      expect(result.statusCode).toBe(202);
      expect(result.body).toBe('{"ok":true}');
    }
    expect((await owner.query('SELECT 1 FROM signup_links WHERE email = $1', [email])).rowCount).toBe(SIGNUP_REQUESTS_PER_EMAIL_PER_CLIENT_PER_DAY);
  });

  it('검증 M1: 공격자 요청자가 피해자 주소의 자기 몫을 다 태워도(넘친 요청도 202) 피해자의 요청자는 가입 링크를 받는다 — 소유자 주소의 로그인 링크도 같다', async () => {
    const victim = newEmail();
    const attackerIp = uniqueIp();
    for (let i = 0; i < SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR; i++) expect((await requestSignup(victim, { ip: attackerIp })).statusCode).toBe(202);
    expect((await owner.query('SELECT 1 FROM signup_links WHERE email = $1', [victim])).rowCount).toBe(SIGNUP_REQUESTS_PER_EMAIL_PER_CLIENT_PER_DAY);
    const victimIp = uniqueIp();
    const mine = await requestSignup(victim, { ip: victimIp });
    expect(mine.statusCode).toBe(202);
    const links = await owner.query<{ client_key: string }>('SELECT client_key FROM signup_links WHERE email = $1 ORDER BY created_at DESC', [victim]);
    expect(links.rowCount).toBe(SIGNUP_REQUESTS_PER_EMAIL_PER_CLIENT_PER_DAY + 1);
    // 가장 새 링크는 피해자 요청자의 것 — 그리고 그 브라우저의 논스로 verify 된다.
    expect(new Set(links.rows.map((row) => row.client_key)).size).toBe(2);
    const newest = await latestLink(victim);
    if (newest === undefined) throw new Error('가입 링크 행이 없다');
    expect((await verify(await signupCodeOf(owner, LOGIN_KEYS, newest), cookieValue(mine, SIGNUP_BROWSER_COOKIE))).statusCode).toBe(200);

    // 이미 소유자인 주소: 공격자가 가입 요청으로 신뢰 밖 몫을 태워도 소유자의 평소 요청자(이 주소로 로그인한 적 있는 IP)는 로그인 링크를 받는다.
    const existing = await newOrganization(owner);
    const ownerIp = uniqueIp();
    const first = await call(adminDeps(admin), 'POST', '/api/login', { body: { email: existing.ownerEmail }, ip: ownerIp });
    const [firstMail] = await drainLoginMail(mailer, existing.id);
    const signedIn = await call(adminDeps(admin), 'POST', '/api/login/verify', {
      body: { code: firstMail === undefined ? '' : codeFromMail(firstMail) },
      cookies: { [LOGIN_BROWSER_COOKIE]: cookieValue(first, LOGIN_BROWSER_COOKIE) ?? '' },
      ip: uniqueCodeIp(),
    });
    expect(signedIn.statusCode).toBe(200);
    const attacker2 = uniqueIp();
    for (let i = 0; i < SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR; i++) expect((await requestSignup(existing.ownerEmail, { ip: attacker2 })).statusCode).toBe(202);
    const before = (await owner.query('SELECT 1 FROM owner_login_links WHERE organization_id = $1', [existing.id])).rowCount ?? 0;
    expect((await requestSignup(existing.ownerEmail, { ip: ownerIp })).statusCode).toBe(202);
    expect((await owner.query('SELECT 1 FROM owner_login_links WHERE organization_id = $1', [existing.id])).rowCount).toBe(before + 1);
  });

  it(`같은 주소 하루 ${String(SIGNUP_REQUESTS_PER_EMAIL_PER_DAY)}회(요청자 무관): 다른 요청자 ${String(SIGNUP_REQUESTS_PER_EMAIL_PER_DAY + 3)}곳에서 → 전부 같은 202 · 가입 코드는 ${String(SIGNUP_LINKS_PER_EMAIL_PER_DAY)}통(주소당 하루 — 대입 20번 바닥, 조용히)`, async () => {
    const email = newEmail();
    const results = await Promise.all(Array.from({ length: SIGNUP_REQUESTS_PER_EMAIL_PER_DAY + 3 }, () => requestSignup(email)));
    for (const result of results) {
      expect(result.statusCode).toBe(202);
      expect(result.body).toBe('{"ok":true}');
    }
    expect((await owner.query('SELECT 1 FROM signup_links WHERE email = $1', [email])).rowCount).toBe(SIGNUP_LINKS_PER_EMAIL_PER_DAY);
    expect(SIGNUP_LINKS_PER_EMAIL_PER_DAY).toBeLessThanOrEqual(SIGNUP_REQUESTS_PER_EMAIL_PER_DAY);
    expect(SIGNUP_REQUESTS_PER_EMAIL_PER_DAY).toBeGreaterThan(SIGNUP_REQUESTS_PER_EMAIL_PER_CLIENT_PER_DAY);
  });

  // -------------------------------------------------------------------------
  // verify
  // -------------------------------------------------------------------------

  it('결속 쿠키 없음 → 401 signup_browser_missing(미소진) · 다른 브라우저 → 401 signup_code_invalid(미소진) · 요청한 브라우저 → 200', async () => {
    const email = newEmail();
    const { code, nonce, linkId } = await signupCode(email);
    const missing = await verify(code, undefined);
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: 'signup_browser_missing' });
    const other = await verify(code, 'A'.repeat(43));
    expect(other.statusCode).toBe(401);
    expect(other.json()).toMatchObject({ error: 'signup_code_invalid' });
    // 로그인 논스를 가입 쿠키 자리에 넣어도 안 된다(결속 문맥이 다르다) — 여기서는 같은 모양의 다른 논스로 대신 본다.
    const unused = await owner.query<{ used_at: Date | null; code_failures: number }>('SELECT used_at, code_failures FROM signup_links WHERE id = $1', [linkId]);
    expect(unused.rows[0]).toEqual({ used_at: null, code_failures: 0 });
    expect((await owner.query('SELECT 1 FROM organizations WHERE owner_email = $1', [email])).rowCount).toBe(0);
    expect((await verify(code, nonce)).statusCode).toBe(200);
  });

  it('재사용 → 401 signup_code_invalid · 조직·세션은 하나', async () => {
    const email = newEmail();
    const { code, nonce, linkId } = await signupCode(email);
    expect((await verify(code, nonce)).statusCode).toBe(200);
    const again = await verify(code, nonce);
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({ error: 'signup_code_invalid' });
    expect((await owner.query('SELECT 1 FROM organizations WHERE owner_email = $1', [email])).rowCount).toBe(1);
    expect((await owner.query('SELECT 1 FROM owner_sessions WHERE signup_link_id = $1', [linkId])).rowCount).toBe(1);
  });

  it('틀린 코드 · 다른 문맥(로그인)의 코드 · 모양 아님 → 401(틀린 것만 센다) · 옛 링크 토큰 → 410 signup_link_retired(DB 를 보지 않는다) · 미소진', async () => {
    const email = newEmail();
    const { code, nonce, linkId } = await signupCode(email);
    const link = await latestLink(email);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    expect((await verify(wrong, nonce)).json()).toMatchObject({ error: 'signup_code_invalid' });
    const loginContext = mintLoginCode(LOGIN_KEYS, 'owner_login', { linkId, expiresAt: link?.expires_at ?? new Date() });
    if (loginContext !== code) expect((await verify(loginContext, nonce)).json()).toMatchObject({ error: 'signup_code_invalid' });
    expect((await verify(42 as unknown as string, nonce)).statusCode).toBe(401);
    for (const token of ['atk_signup_k1.eyJsIjoiMSJ9.sig', 'atk_login_k1.x.y']) {
      const retired = await call(deps(), 'POST', '/api/signup/verify', { body: { token }, cookies: { [SIGNUP_BROWSER_COOKIE]: nonce } });
      expect(retired.statusCode).toBe(410);
      expect(retired.json()).toMatchObject({ error: 'signup_link_retired' });
      expect(retired.cookies ?? []).toEqual([]);
    }
    const unused = await owner.query<{ used_at: Date | null; code_failures: number }>('SELECT used_at, code_failures FROM signup_links WHERE id = $1', [linkId]);
    expect(unused.rows[0]?.used_at).toBeNull();
    expect(unused.rows[0]?.code_failures).toBe(loginContext !== code ? 2 : 1);
    expect((await owner.query('SELECT 1 FROM organizations WHERE owner_email = $1', [email])).rowCount).toBe(0);
    expect((await verify(code, nonce)).statusCode).toBe(200);
  });

  it('검증 M2: 한 요청자가 하루 새 조직 상한(3)을 채우면 다음 verify 는 409 signup_capacity — 링크 미소진 · 조직·세션·감사 없음 · 기존 소유자 분기는 상한과 무관', async () => {
    const limits = await owner.query<{ per_client_daily_cap: number }>('SELECT per_client_daily_cap FROM signup_limits');
    const cap = limits.rows[0]?.per_client_daily_cap ?? 3;
    const ip = uniqueIp();
    // 같은 요청자(IP)에서 cap + 2 개 주소를 요청한다(요청자 시간당 5 안). 앞 cap 개는 조직이 된다.
    const requested = [];
    for (let i = 0; i < cap + 2; i++) {
      const email = newEmail();
      const response = await requestSignup(email, { ip });
      expect(response.statusCode, response.body).toBe(202);
      const link = await latestLink(email);
      if (link === undefined) throw new Error('가입 링크 행이 없다');
      requested.push({ email, nonce: cookieValue(response, SIGNUP_BROWSER_COOKIE), linkId: link.id, code: await signupCodeOf(owner, LOGIN_KEYS, link) });
    }
    for (const entry of requested.slice(0, cap)) expect((await verify(entry.code, entry.nonce)).statusCode).toBe(200);

    const over = requested[cap];
    if (over === undefined) throw new Error('상한 넘는 요청이 없다');
    const refused = await verify(over.code, over.nonce);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'signup_capacity' });
    expect(refused.cookies ?? []).toEqual([]);
    const unused = await owner.query<{ used_at: Date | null; organization_id: string | null }>(
      'SELECT used_at, organization_id FROM signup_links WHERE id = $1',
      [over.linkId],
    );
    expect(unused.rows[0]).toEqual({ used_at: null, organization_id: null });
    expect((await owner.query('SELECT 1 FROM organizations WHERE owner_email = $1', [over.email])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM owner_sessions WHERE signup_link_id = $1', [over.linkId])).rowCount).toBe(0);
    // 링크가 소비되지 않았으므로 같은 링크로 다시 해도 같은 409(상한이 풀리기 전) — "만료·사용"(401)이 아니다.
    expect((await verify(over.code, over.nonce)).json()).toMatchObject({ error: 'signup_capacity' });

    // 그 주소의 조직이 (CLI 로) 생기면 같은 링크는 기존 소유자 분기 — 조직을 만들지 않으므로 상한과 무관하게 200.
    const operatorOrg = await createOrganizationOp(owner, { name: 'operator-made', ownerEmail: over.email });
    const joined = await verify(over.code, over.nonce);
    expect(joined.statusCode, joined.body).toBe(200);
    const me = await call(deps(), 'GET', '/api/me', { cookies: { [SESSION_COOKIE]: cookieValue(joined, SESSION_COOKIE) ?? '' } });
    expect((me.json() as { organization: { id: string } }).organization.id).toBe(operatorOrg.id);
  });

  it('원자성: 감사 INSERT 가 실패하면 500 · 조직 없음 · 링크 미소진 · 세션 없음 — 같은 링크로 다시 하면 된다', async () => {
    const email = newEmail();
    const { code, nonce, linkId } = await signupCode(email);
    const failed = await call(adminDeps(failingAudit(admin)), 'POST', '/api/signup/verify', {
      body: { code },
      cookies: { [SIGNUP_BROWSER_COOKIE]: nonce },
      ip: uniqueCodeIp(),
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ error: 'internal_error' });
    expect((await owner.query('SELECT 1 FROM organizations WHERE owner_email = $1', [email])).rowCount).toBe(0);
    const unused = await owner.query<{ used_at: Date | null; organization_id: string | null }>(
      'SELECT used_at, organization_id FROM signup_links WHERE id = $1',
      [linkId],
    );
    expect(unused.rows[0]).toEqual({ used_at: null, organization_id: null });
    expect((await owner.query('SELECT 1 FROM owner_sessions WHERE signup_link_id = $1', [linkId])).rowCount).toBe(0);
    expect((await verify(code, nonce)).statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // 검토 상태 · 에이전트 상한 · /api/me
  // -------------------------------------------------------------------------

  it(`검토 전 조직의 에이전트 상한 ${String(MAX_AGENTS_PER_PENDING_ORG)} — 콘솔 409 agent_limit(검토 문구) · CLI 같은 코드 · 활성화되면 풀린다`, async () => {
    const { organizationId, session } = await signedUp();
    // 새 가입 조직은 active 로 태어난다(202609301520) — 이 상한은 이미 있는 검토 대기 조직(운영 DB 의 옛 pending_review)의 것이라 소유자 롤로 되돌려 본다.
    await owner.query(`UPDATE organizations SET review_status = 'pending_review' WHERE id = $1`, [organizationId]);
    const create = (name: string) =>
      call(deps(), 'POST', '/api/agents', authed(session, { body: { name, localPart: `pend-${suffix()}${suffix()}` } }));
    for (let i = 0; i < MAX_AGENTS_PER_PENDING_ORG; i++) expect((await create(`a${String(i)}`)).statusCode).toBe(201);
    const third = await create('over');
    expect(third.statusCode).toBe(409);
    expect(third.json()).toMatchObject({ error: 'agent_limit' });
    expect((third.json() as { detail: string }).detail).toContain(`${String(MAX_AGENTS_PER_PENDING_ORG)}개까지`);
    const local = `cli-pend-${suffix()}`;
    expect(await cliCode(agentProvision(['--org', organizationId, '--name', local, '--local-part', local], { env: cliEnv(), io: cliIo() }))).toBe(
      'agent_limit',
    );
    expect((await owner.query('SELECT 1 FROM agents WHERE organization_id = $1', [organizationId])).rowCount).toBe(MAX_AGENTS_PER_PENDING_ORG);

    // 운영자(소유자 롤)가 활성화하면 기존 상한(10)으로.
    await owner.query(`UPDATE organizations SET review_status = 'active' WHERE id = $1`, [organizationId]);
    expect((await create('after-activate')).statusCode).toBe(201);
    expect(MAX_AGENTS_PER_ORG).toBeGreaterThan(MAX_AGENTS_PER_PENDING_ORG);
  });

  it('/api/me reviewStatus: 셀프 가입 active(초대 전용 — 202609301520) → 거절되면 rejected · CLI 조직은 active', async () => {
    const { organizationId, session } = await signedUp();
    const status = async (s: Session): Promise<unknown> =>
      ((await call(deps(), 'GET', '/api/me', authed(s))).json() as { organization: { reviewStatus: unknown } }).organization.reviewStatus;
    expect(await status(session)).toBe('active');
    await owner.query(`UPDATE organizations SET review_status = 'rejected' WHERE id = $1`, [organizationId]);
    expect(await status(session)).toBe('rejected');
    // admin 롤은 review_status 를 바꿀 수 없다(A1 의 가드) — 콘솔이 자기 조직을 활성화하는 길이 없다.
    await expect(admin.query(`UPDATE organizations SET review_status = 'active' WHERE id = $1`, [organizationId])).rejects.toThrow();

    const cliOrg = await newOrganization(owner);
    const requested = await call(deps(), 'POST', '/api/login', { body: { email: cliOrg.ownerEmail }, ip: uniqueIp() });
    const [mail] = await drainLoginMail(mailer, cliOrg.id);
    const verified = await call(deps(), 'POST', '/api/login/verify', {
      body: { code: mail === undefined ? '' : codeFromMail(mail) },
      cookies: { [LOGIN_BROWSER_COOKIE]: cookieValue(requested, LOGIN_BROWSER_COOKIE) ?? '' },
      ip: uniqueCodeIp(),
    });
    const token = cookieValue(verified, SESSION_COOKIE) ?? '';
    expect(await status({ cookies: { [SESSION_COOKIE]: token }, csrf: csrfTokenOf(token), token })).toBe('active');
  });

  // -------------------------------------------------------------------------
  // 모양 오류 · 페이지 · 출처
  // -------------------------------------------------------------------------

  it('모양 오류만 400 — 동의 없음 · 조직 이름(빈 값 · 81자 · 제어/방향 문자) · 이메일 모양 · 에이전트 도메인 — DB 에 아무것도 적지 않는다', async () => {
    const email = newEmail();
    const ip = uniqueIp();
    const cases: Array<[unknown, string]> = [
      [{ email, organizationName: 'Acme' }, 'consent_required'],
      [{ email, organizationName: 'Acme', consent: false }, 'consent_required'],
      [{ email, organizationName: 'Acme', consent: 'true' }, 'consent_required'],
      [{ email, organizationName: '   ', consent: true }, 'invalid_organization_name'],
      [{ email, organizationName: '가'.repeat(81), consent: true }, 'invalid_organization_name'],
      [{ email, organizationName: 'a‮b', consent: true }, 'invalid_organization_name'],
      [{ email, organizationName: 'a\nb', consent: true }, 'invalid_organization_name'],
      [{ email, organizationName: 42, consent: true }, 'invalid_organization_name'],
      [{ email: 'not-an-email', organizationName: 'Acme', consent: true }, 'invalid_email'],
      [{ email: `x-${suffix()}@atmark.ai`, organizationName: 'Acme', consent: true }, 'invalid_email'],
      [{ email: 7, organizationName: 'Acme', consent: true }, 'invalid_email'],
      [[1, 2], 'invalid_body'],
    ];
    for (const [body, code] of cases) {
      const result = await call(deps(), 'POST', '/api/signup', { body, ip });
      expect(result.statusCode, JSON.stringify(body)).toBe(400);
      expect(result.json(), JSON.stringify(body)).toMatchObject({ error: code });
      expect(result.cookies ?? []).toEqual([]);
    }
    expect((await owner.query('SELECT 1 FROM signup_links WHERE email = $1', [email])).rowCount).toBe(0);
    // 400 은 요청자 상한을 태우지 않는다 — 같은 요청자가 곧바로 정상 가입할 수 있다.
    expect((await call(deps(), 'POST', '/api/signup', { body: { email, organizationName: '가'.repeat(80), consent: true }, ip })).statusCode).toBe(202);
  });

  it('페이지: /signup · /signup/verify 는 CSP·보안 헤더를 싣는다 · 세션이 있으면 /signup 은 302 /app · 다른 출처의 POST 는 403', async () => {
    const page = await call(deps(), 'GET', '/signup');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toMatch(/^default-src 'none'; script-src 'sha256-/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('https://atmark.ai/kr/terms');
    const landing = await call(deps(), 'GET', '/signup/verify');
    expect(landing.statusCode).toBe(200);
    // 옛 가입 확인 링크 착지(2026-10-10) — 안내만. 페이지 스크립트(같은 출처 불변 자산 · SRI)는 서버를 부르지 않는다.
    const scriptPath = /<script src="(\/_assets\/[0-9a-f]+\/[^"]+\.js)" integrity="sha384-[^"]+"/.exec(landing.body)?.[1];
    expect(scriptPath).toBeDefined();
    const script = await call(deps(), 'GET', scriptPath ?? '');
    expect(script.statusCode).toBe(200);
    expect(script.body).not.toContain('fetch(');
    expect(landing.body).toContain('href="/signup"');
    const { session } = await signedUp();
    const redirected = await call(deps(), 'GET', '/signup', { cookies: session.cookies });
    expect(redirected.statusCode).toBe(302);
    expect(redirected.headers['location']).toBe('/app');
    const foreign = await call(deps(), 'POST', '/api/signup', {
      body: { email: newEmail(), organizationName: 'x', consent: true },
      headers: { origin: 'https://evil.example' },
      ip: uniqueIp(),
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ error: 'origin_mismatch' });
    const bearer = await call(deps(), 'POST', '/api/signup/verify', { body: { token: 'x' }, headers: { authorization: 'Bearer atk_x' } });
    expect(bearer.statusCode).toBe(401);
    expect(bearer.json()).toMatchObject({ error: 'unauthenticated' });
  });
});
