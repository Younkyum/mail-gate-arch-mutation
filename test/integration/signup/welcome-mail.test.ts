/**
 * 셀프 가입 **환영 메일**(202609301510 · `notify/welcome-notifier` · `workers/welcome-mailer`) — 실제 Postgres, 가짜 SES(AWS 호출 0).
 *
 * 라우터는 `atmark_admin` 롤, 워커는 `atmark_login_mailer` 롤로 돈다(운영과 같은 GRANT). 지반(행 심기·검사)만 소유자 롤.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 새 가입(링크 확정 → 새 조직) → 환영 메일 행 **정확히 하나**(사용자당 — 같은 사람이 다시 가입해도 둘이 되지 않는다).
 *   - 행이 생기지 않는 경로: 돌아온 소유자(링크 확정이 기존 조직으로 간다) · 초대받은 멤버 · 콘솔 새 조직(`create_member_organization`).
 *   - 언어 왕복: 폼의 `lang` → `signup_links.lang` → `welcome_mails.lang` → 그 언어 한 벌의 메일. 본문 `lang` 이 없으면 콘솔 언어 쿠키 →
 *     Accept-Language. 옛 코드가 적은 링크(lang NULL)는 한국어.
 *   - 워커: 수신자 = `users.email` · FromEmailAddress `onve@atmark.ai` · 헤더 `From: "Onve (Atmark)" <onve@atmark.ai>` · 알림 태그 · 한 번만
 *     (두 번째 틱엔 없다) · 시스템 메일 억제 → `undeliverable`(suppressed) · 지운 사용자 → `undeliverable`(user_erased) · 48시간 → `obsolete` ·
 *     전역 상한 → `deferred`(버리지 않는다 — 시도 수 그대로, 다음 창).
 *   - 발송 표식: claim 이 SES 호출 전에 `last_error='sending'` 을 적는다 · 표식이 남은 채 lease 가 끝난 행(호출 직후 죽음 · `markSent` 실패)은 다시 보내지 않고
 *     `dead(send_unknown)` — 사용자당 최대 한 통.
 *   - 권한: 로그인 메일 롤은 INSERT 0 · 조직 id 읽기 0, admin·앱 롤은 표 권한 0 · 종단 행은 소유자도 되돌릴 수 없다.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LANG_COOKIE, SESSION_COOKIE, SIGNUP_BROWSER_COOKIE } from '../../../src/admin/http';
import { csrfTokenOf } from '../../../src/admin/session';
import { ATMARK_NOTIFICATION_ID_TAG } from '../../../src/mail/events/tag';
import { createWelcomeNotifier } from '../../../src/notify/welcome-notifier';
import { setLogSink } from '../../../src/observability/logger';
import { runWelcomeMailer } from '../../../src/workers/welcome-mailer';
import { afterDbNow } from '../../support/db-clock';
import {
  adminDeps,
  adminRolePool,
  appPool,
  authed,
  AVAILABLE,
  call,
  cookieValue,
  LOGIN_KEYS,
  login,
  loginMailerPool,
  mailText,
  newOrganization,
  ownerPool,
  suffix,
  userIdOf,
  type SentMail,
  type Session,
  uniqueCodeIp,
} from '../admin/support';
import { seedLiveInvite, signupCodeOf } from './support';

const uniqueIp = (): string => `198.51.100.${String(Math.floor(Math.random() * 250))}-${suffix()}${suffix()}`;
const createdEmails: string[] = [];
const newEmail = (): string => {
  const email = `welcome-${suffix()}${suffix()}@example.com`;
  createdEmails.push(email);
  return email;
};

/** SES 가짜 — 태그·발신까지 기록한다. */
function fakeSes(): { client: { send: (command: { input: unknown }) => Promise<unknown> }; sent: (SentMail & { tags: unknown })[] } {
  const sent: (SentMail & { tags: unknown })[] = [];
  return {
    sent,
    client: {
      send(command) {
        const input = command.input as {
          FromEmailAddress?: string;
          Destination?: { ToAddresses?: string[] };
          Content?: { Raw?: { Data?: Uint8Array } };
          EmailTags?: unknown;
        };
        sent.push({
          from: input.FromEmailAddress,
          to: input.Destination?.ToAddresses ?? [],
          raw: Buffer.from(input.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8'),
          tags: input.EmailTags,
        });
        return Promise.resolve({ MessageId: `ses-${randomUUID()}`, $metadata: {} });
      },
    },
  };
}

function headerFrom(raw: string): string[] {
  const head = raw.slice(0, raw.indexOf('\r\n\r\n')).replace(/\r\n[ \t]/g, ' ');
  return head.split('\r\n').filter((line) => /^from:/i.test(line));
}

function headerSubject(raw: string): string {
  const head = raw.slice(0, raw.indexOf('\r\n\r\n')).replace(/\r\n[ \t]/g, ' ');
  const line = head.split('\r\n').find((l) => /^subject:/i.test(l)) ?? '';
  const value = line.slice('subject:'.length).trim();
  // RFC 2047 B 인코딩(UTF-8)만 푼다.
  return value.replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/gi, (_m, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
}

describe.skipIf(!AVAILABLE)('셀프 가입 환영 메일 (202609301510)', () => {
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
    // 전역 검토 대기 상한(200)을 공유 DB 에서 채우지 않게.
    await owner.query(
      `UPDATE organizations SET review_status = 'rejected' WHERE owner_email = ANY($1::text[]) AND review_status = 'pending_review'`,
      [createdEmails],
    );
    await Promise.all([owner.end(), admin.end(), mailer.end(), app.end()]);
  });

  const deps = (): ReturnType<typeof adminDeps> => adminDeps(admin);

  async function requestSignup(email: string, options: { lang?: string; headers?: Record<string, string>; cookies?: Record<string, string> } = {}) {
    // 초대 전용 가입(202609301520) — 새 주소는 살아 있는 초대가 있어야 가입 링크가 적힌다.
    await seedLiveInvite(email);
    const requested = await call(deps(), 'POST', '/api/signup', {
      body: { email, organizationName: `Welcome ${suffix()}`, consent: true, ...(options.lang === undefined ? {} : { lang: options.lang }) },
      ip: uniqueIp(),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.cookies === undefined ? {} : { cookies: options.cookies }),
    });
    expect(requested.statusCode, requested.body).toBe(202);
    return requested;
  }

  async function latestLink(email: string): Promise<{ id: string; expires_at: Date; lang: string | null }> {
    const rows = await owner.query<{ id: string; expires_at: Date; lang: string | null }>(
      'SELECT id, expires_at, lang FROM signup_links WHERE email = $1 ORDER BY created_at DESC LIMIT 1',
      [email],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new Error('가입 링크 행이 없다');
    return row;
  }

  /** 요청 → 가입 행 → verify(가입 문맥 코드 · 같은 브라우저 논스). 세션을 돌려준다. */
  async function signUp(email: string, options: Parameters<typeof requestSignup>[1] = {}): Promise<Session> {
    const requested = await requestSignup(email, options);
    const nonce = cookieValue(requested, SIGNUP_BROWSER_COOKIE) ?? '';
    const link = await latestLink(email);
    const verified = await call(deps(), 'POST', '/api/signup/verify', {
      body: { code: await signupCodeOf(owner, LOGIN_KEYS, { id: link.id, expires_at: link.expires_at }) },
      ip: uniqueCodeIp(),
      cookies: { [SIGNUP_BROWSER_COOKIE]: nonce },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const token = cookieValue(verified, SESSION_COOKIE) ?? '';
    return { cookies: { [SESSION_COOKIE]: token }, csrf: csrfTokenOf(token), token };
  }

  const welcomeRows = (email: string) =>
    owner
      .query<{ id: string; lang: string; status: string; organization_id: string; last_error: string | null; attempt_count: number; next_attempt_at: Date }>(
        `SELECT w.id, w.lang, w.status, w.organization_id, w.last_error, w.attempt_count, w.next_attempt_at
           FROM welcome_mails w JOIN users u ON u.id = w.user_id WHERE u.email = $1`,
        [email],
      )
      .then((r) => r.rows);

  async function drain(ids: readonly string[], now: () => Date = () => new Date(), capPerHour: number = 1_000_000) {
    await afterDbNow(mailer); // 가입이 적은 행의 next_attempt_at = DB 기본값 now()(µs) — 같은 밀리초 안의 워커는 기한 전으로 본다
    const ses = fakeSes();
    const notifier = createWelcomeNotifier({ pool: mailer, client: ses.client as never, now, capPerHour });
    const report = await runWelcomeMailer({ db: mailer, notifier, now }, { welcomeIds: ids });
    return { report, sent: ses.sent };
  }

  // -------------------------------------------------------------------------
  // 행이 생기는 곳 · 생기지 않는 곳
  // -------------------------------------------------------------------------

  it('새 가입 → 환영 메일 행 정확히 하나(pending · 그 조직) · 같은 주소의 두 번째 링크 확정(돌아온 소유자)은 행을 늘리지 않는다', async () => {
    const email = newEmail();
    await signUp(email, { lang: 'en' });
    const rows = await welcomeRows(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lang: 'en', status: 'pending', attempt_count: 0 });
    const org = await owner.query<{ id: string; review_status: string }>('SELECT id, review_status::text FROM organizations WHERE owner_email = $1', [email]);
    expect(org.rows).toHaveLength(1);
    expect(rows[0]?.organization_id).toBe(org.rows[0]?.id);

    // 같은 주소로 가입 링크를 하나 더(소유자 롤로 심는다 — admin 은 이미 멤버인 주소에 가입 링크를 만들지 않는다) → 확정은 기존 조직으로.
    const binding = 'b'.repeat(64);
    const again = await owner.query<{ id: string }>(
      `INSERT INTO signup_links (email, organization_name, browser_binding, client_key, expires_at, next_attempt_at, lang)
       VALUES ($1, 'again', $2, $3, date_trunc('milliseconds', now() + interval '20 minutes'), now(), 'ko') RETURNING id`,
      [email, binding, 'c'.repeat(64)],
    );
    const result = await owner.query<{ org: string | null }>('SELECT create_signup_organization($1, $2, now()) AS org', [again.rows[0]?.id, binding]);
    expect(result.rows[0]?.org).toBe(org.rows[0]?.id);
    expect(await welcomeRows(email)).toHaveLength(1);
  });

  it('가입 링크를 받은 뒤 그 주소가 (CLI 로) 소유자가 됐으면 확정은 그 조직으로 가고 환영 메일 행은 없다(돌아온 소유자)', async () => {
    const email = newEmail();
    const requested = await requestSignup(email);
    const nonce = cookieValue(requested, SIGNUP_BROWSER_COOKIE) ?? '';
    const link = await latestLink(email);
    await owner.query(`INSERT INTO organizations (name, owner_email) VALUES ('operator-made', $1)`, [email]);
    const verified = await call(deps(), 'POST', '/api/signup/verify', {
      body: { code: await signupCodeOf(owner, LOGIN_KEYS, { id: link.id, expires_at: link.expires_at }) },
      ip: uniqueCodeIp(),
      cookies: { [SIGNUP_BROWSER_COOKIE]: nonce },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(await welcomeRows(email)).toEqual([]);
  });

  it('초대받은 멤버 · 콘솔 새 조직(create_member_organization)은 환영 메일 행을 만들지 않는다', async () => {
    const organization = await newOrganization(owner);
    const session = await login(deps(), mailer, organization, uniqueIp());
    const invitee = newEmail();
    const created = await call(deps(), 'POST', '/api/members/invites', authed(session, { body: { email: invitee, role: 'member' } }));
    expect(created.statusCode, created.body).toBe(201);
    const inviteId = (created.json() as { invite: { id: string } }).invite.id;
    const inviteeId = await userIdOf(owner, invitee);
    const accepted = await admin.query<{ membership_id: string | null }>('SELECT membership_id FROM accept_org_invite($1, $2, now())', [inviteId, inviteeId]);
    expect(accepted.rows[0]?.membership_id).not.toBeNull();
    expect(await welcomeRows(invitee)).toEqual([]);

    const second = await call(deps(), 'POST', '/api/organizations', authed(session, { body: { name: `두 번째 ${suffix()}` } }));
    expect(second.statusCode, second.body).toBe(201);
    createdEmails.push(organization.ownerEmail);
    expect(await welcomeRows(organization.ownerEmail)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 언어 왕복
  // -------------------------------------------------------------------------

  it('언어: 본문 lang → 콘솔 언어 쿠키 → Accept-Language · 링크와 환영 메일 행에 같은 값 · 메일은 그 언어 한 벌', async () => {
    const cases: [Parameters<typeof requestSignup>[1], 'ko' | 'en'][] = [
      [{ lang: 'en', headers: { 'accept-language': 'ko-KR' } }, 'en'],
      [{ lang: 'ko', headers: { 'accept-language': 'en-US' } }, 'ko'],
      [{ cookies: { [LANG_COOKIE]: 'en' }, headers: { 'accept-language': 'ko-KR' } }, 'en'],
      [{ headers: { 'accept-language': 'en-GB,en;q=0.9' } }, 'en'],
      [{}, 'ko'],
    ];
    for (const [options, expected] of cases) {
      const email = newEmail();
      await signUp(email, options);
      expect((await owner.query<{ lang: string }>('SELECT lang FROM signup_links WHERE email = $1', [email])).rows.map((r) => r.lang)).toEqual([expected]);
      const rows = await welcomeRows(email);
      expect(rows.map((r) => r.lang)).toEqual([expected]);
      const { sent } = await drain(rows.map((r) => r.id));
      expect(sent).toHaveLength(1);
      const mail = sent[0];
      if (mail === undefined) continue;
      expect(headerSubject(mail.raw)).toBe(expected === 'en' ? 'Welcome to Atmark' : 'Atmark에 오신 것을 환영합니다');
      const text = mailText(mail);
      if (expected === 'en') expect(text).not.toMatch(/[가-힣]/);
      else expect(text).toContain('안녕하세요.');
    }
  });

  it('옛 코드가 적은 링크(lang NULL)로 가입하면 환영 메일은 한국어', async () => {
    const email = newEmail();
    const binding = 'd'.repeat(64);
    await seedLiveInvite(email); // 초대 전용 가입(202609301520)
    const link = await owner.query<{ id: string }>(
      `INSERT INTO signup_links (email, organization_name, browser_binding, client_key, expires_at, next_attempt_at)
       VALUES ($1, 'legacy', $2, $3, date_trunc('milliseconds', now() + interval '20 minutes'), now()) RETURNING id`,
      [email, binding, `${suffix()}${suffix()}`.padEnd(64, 'e')],
    );
    const org = await owner.query<{ org: string | null }>('SELECT create_signup_organization($1, $2, now()) AS org', [link.rows[0]?.id, binding]);
    expect(org.rows[0]?.org).not.toBeNull();
    expect((await welcomeRows(email)).map((r) => r.lang)).toEqual(['ko']);
  });

  // -------------------------------------------------------------------------
  // 워커
  // -------------------------------------------------------------------------

  it('워커: users.email 로 onve@ 에서 · 헤더 "Onve (Atmark)" <onve@atmark.ai> · 알림 태그 · sent 로 닫히고 두 번째 틱엔 없다', async () => {
    const email = newEmail();
    await signUp(email, { lang: 'en' });
    const [row] = await welcomeRows(email);
    if (row === undefined) throw new Error('환영 메일 행이 없다');
    const first = await drain([row.id]);
    expect(first.report.sent).toBe(1);
    expect(first.sent).toHaveLength(1);
    const mail = first.sent[0];
    expect(mail?.to).toEqual([email]);
    expect(mail?.from).toBe('onve@atmark.ai');
    expect(headerFrom(mail?.raw ?? '')).toEqual(['From: "Onve (Atmark)" <onve@atmark.ai>']);
    expect(mail?.tags).toEqual([{ Name: ATMARK_NOTIFICATION_ID_TAG, Value: row.id }]);
    expect(mailText(mail ?? { from: '', to: [], raw: '' })).toContain('https://console.atmark.ai/');
    const after = await welcomeRows(email);
    expect(after[0]?.status).toBe('sent');
    const second = await drain([row.id]);
    expect(second.sent).toEqual([]);
    expect(second.report.sent).toBe(0);
    // 종단 동결 — 소유자 롤도 되돌리지 못한다.
    await expect(owner.query(`UPDATE welcome_mails SET status = 'pending', sent_at = NULL, ses_message_id = NULL WHERE id = $1`, [row.id])).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('시스템 메일 억제 주소 → undeliverable(suppressed) · 발송 0', async () => {
    const email = newEmail();
    await signUp(email);
    await owner.query(`INSERT INTO system_mail_suppressions (address, reason) VALUES ($1, 'hard_bounce') ON CONFLICT DO NOTHING`, [email]);
    const [row] = await welcomeRows(email);
    const { report, sent } = await drain([row?.id ?? '']);
    expect(report.undeliverable).toBe(1);
    expect(sent).toEqual([]);
    expect(await welcomeRows(email)).toMatchObject([{ status: 'undeliverable', last_error: 'suppressed' }]);
  });

  /** 소유자 롤로 심은 대기 행(가입 경로 밖 — 워커 규칙만 본다). */
  async function seededRow(options: { createdAt?: Date; nextAttemptAt?: Date } = {}): Promise<{ id: string; email: string; userId: string }> {
    const organization = await newOrganization(owner, null);
    const email = `welcome-seed-${suffix()}${suffix()}@example.com`;
    const user = await owner.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [email]);
    const userId = user.rows[0]?.id ?? '';
    const createdAt = options.createdAt ?? new Date();
    const row = await owner.query<{ id: string }>(
      `INSERT INTO welcome_mails (user_id, organization_id, lang, created_at, next_attempt_at) VALUES ($1, $2, 'ko', $3, $4) RETURNING id`,
      [userId, organization.id, createdAt, options.nextAttemptAt ?? createdAt],
    );
    return { id: row.rows[0]?.id ?? '', email, userId };
  }

  it('지운 사용자(erased.invalid 자리표시) → undeliverable(user_erased) · 발송 0', async () => {
    const seeded = await seededRow();
    await owner.query(`UPDATE users SET email = 'erased-' || id::text || '@erased.invalid', erased_at = now() WHERE id = $1`, [seeded.userId]);
    const { report, sent } = await drain([seeded.id]);
    expect(report.undeliverable).toBe(1);
    expect(sent).toEqual([]);
    const row = await owner.query<{ status: string; last_error: string }>('SELECT status, last_error FROM welcome_mails WHERE id = $1', [seeded.id]);
    expect(row.rows[0]).toEqual({ status: 'undeliverable', last_error: 'user_erased' });
  });

  it('48시간이 지난 행 → obsolete(stale) · 발송 0', async () => {
    const seeded = await seededRow({ createdAt: new Date(Date.now() - 49 * 3_600_000) });
    const { report, sent } = await drain([seeded.id]);
    expect(report.obsolete).toBe(1);
    expect(sent).toEqual([]);
    const row = await owner.query<{ status: string; last_error: string }>('SELECT status, last_error FROM welcome_mails WHERE id = $1', [seeded.id]);
    expect(row.rows[0]).toEqual({ status: 'obsolete', last_error: 'stale' });
  });

  it('전역 시간당 상한 → deferred(시도 수 그대로 · 다음 시도는 뒤로) — 버리지 않고 창이 지나면 보낸다', async () => {
    // 먼 미래의 한 시각 T — 그 창에는 이 테스트의 행만 있다(공유 DB 의 다른 발송이 상한을 채우지 않게).
    const at = new Date(Date.now() + (1000 + Math.floor(Math.random() * 100_000)) * 86_400_000);
    const created = new Date(at.getTime() - 60_000);
    const a = await seededRow({ createdAt: created });
    const b = await seededRow({ createdAt: created, nextAttemptAt: new Date(created.getTime() + 1) });
    const first = await drain([a.id, b.id], () => at, 1);
    expect(first.report).toMatchObject({ sent: 1, deferred: 1 });
    expect(first.sent.map((m) => m.to[0])).toEqual([a.email]);
    const deferred = await owner.query<{ status: string; attempt_count: number; next_attempt_at: Date }>(
      'SELECT status, attempt_count, next_attempt_at FROM welcome_mails WHERE id = $1',
      [b.id],
    );
    expect(deferred.rows[0]?.status).toBe('pending');
    expect(deferred.rows[0]?.attempt_count).toBe(0);
    expect(deferred.rows[0]?.next_attempt_at.getTime()).toBeGreaterThan(at.getTime());
    // 한 시간 뒤(48시간 안) — 창이 비었다.
    const later = new Date(at.getTime() + 61 * 60_000);
    const second = await drain([b.id], () => later, 1);
    expect(second.report.sent).toBe(1);
    expect(second.sent.map((m) => m.to[0])).toEqual([b.email]);
  });

  it('발송 표식: claim 이 SES 호출 전에 last_error=sending 을 적고 · 성공하면 지운다 · 표식이 남은 채 lease 가 끝난 행은 다시 보내지 않고 dead(send_unknown) 로 닫는다', async () => {
    const seeded = await seededRow();
    const seen: (string | null)[] = [];
    const ses = fakeSes();
    const spying = {
      send: async (command: { input: unknown }) => {
        const row = await owner.query<{ last_error: string | null }>('SELECT last_error FROM welcome_mails WHERE id = $1', [seeded.id]);
        seen.push(row.rows[0]?.last_error ?? null);
        return ses.client.send(command);
      },
    };
    const notifier = createWelcomeNotifier({ pool: mailer, client: spying as never, now: () => new Date(), capPerHour: 1_000_000 });
    await runWelcomeMailer({ db: mailer, notifier, now: () => new Date() }, { welcomeIds: [seeded.id] });
    expect(seen).toEqual(['sending']);
    const sent = await owner.query<{ status: string; last_error: string | null }>('SELECT status, last_error FROM welcome_mails WHERE id = $1', [seeded.id]);
    expect(sent.rows[0]).toEqual({ status: 'sent', last_error: null });

    // 호출 직후 죽은 워커 — 표식이 남은 채 lease 가 지났다. 두 번째 메일을 보내지 않는다.
    const crashed = await seededRow();
    await owner.query(
      `UPDATE welcome_mails SET attempt_count = 1, claimed_at = now() - interval '10 minutes', next_attempt_at = now() - interval '5 minutes', last_error = 'sending' WHERE id = $1`,
      [crashed.id],
    );
    const { report, sent: resent } = await drain([crashed.id]);
    expect(report.dead).toBe(1);
    expect(resent).toEqual([]);
    const row = await owner.query<{ status: string; last_error: string }>('SELECT status, last_error FROM welcome_mails WHERE id = $1', [crashed.id]);
    expect(row.rows[0]).toEqual({ status: 'dead', last_error: 'send_unknown' });
  });

  it('markSent 가 실패해도 메일은 한 통이고(재시도 없음) 삼키지 않고 로그를 남기며 · lease 뒤에도 다시 보내지 않는다', async () => {
    const seeded = await seededRow();
    const ses = fakeSes();
    // 'sent' 로 닫는 UPDATE 만 실패하는 풀.
    const failing = new Proxy(mailer, {
      get(target, property, receiver) {
        if (property === 'query') {
          return (sql: unknown, values?: unknown) => {
            if (typeof sql === 'string' && sql.includes(`status = 'sent'`)) return Promise.reject(new Error('markSent down'));
            return (target.query as (a: unknown, b?: unknown) => Promise<unknown>).call(target, sql, values);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as Pool;
    const logged: string[] = [];
    const restore = setLogSink((line) => {
      logged.push(line);
    });
    try {
      const notifier = createWelcomeNotifier({ pool: failing, client: ses.client as never, now: () => new Date(), capPerHour: 1_000_000 });
      await expect(notifier.send(seeded.id)).resolves.toBe('sent');
    } finally {
      restore();
    }
    expect(ses.sent).toHaveLength(1);
    expect(logged.some((line) => line.includes('welcome_notify.mark_sent_failed'))).toBe(true);
    const stuck = await owner.query<{ status: string; last_error: string }>('SELECT status, last_error FROM welcome_mails WHERE id = $1', [seeded.id]);
    expect(stuck.rows[0]).toEqual({ status: 'pending', last_error: 'sending' });
    // lease(5분)가 지난 뒤의 틱 — 다시 보내지 않고 닫는다.
    const later = new Date(Date.now() + 6 * 60_000);
    const { report, sent } = await drain([seeded.id], () => later);
    expect(report.dead).toBe(1);
    expect(sent).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 권한
  // -------------------------------------------------------------------------

  it('권한: 로그인 메일 롤 INSERT·조직 id 읽기 0 · admin·앱 롤 표 권한 0', async () => {
    const seeded = await seededRow();
    const state = async (pool: Pool, sql: string, values: unknown[] = []): Promise<string> => {
      try {
        await pool.query(sql, values);
        return 'ok';
      } catch (error) {
        return String((error as { code?: unknown }).code);
      }
    };
    expect(await state(mailer, 'SELECT id, user_id, lang, status FROM welcome_mails WHERE id = $1', [seeded.id])).toBe('ok');
    expect(await state(mailer, 'SELECT organization_id FROM welcome_mails WHERE id = $1', [seeded.id])).toBe('42501');
    expect(await state(mailer, `INSERT INTO welcome_mails (user_id, organization_id, lang) VALUES ($1, $2, 'ko')`, [seeded.userId, randomUUID()])).toBe('42501');
    expect(await state(mailer, 'DELETE FROM welcome_mails WHERE id = $1', [seeded.id])).toBe('42501');
    expect(await state(admin, 'SELECT id FROM welcome_mails LIMIT 1')).toBe('42501');
    expect(await state(app, 'SELECT id FROM welcome_mails LIMIT 1')).toBe('42501');
    expect(await state(owner, 'DELETE FROM welcome_mails WHERE id = $1', [seeded.id])).not.toBe('ok');
  });
});
