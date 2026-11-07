/**
 * **사용자·멤버십·세션 전환·새 조직·멤버·초대 — 실제 Postgres 위에서** (확장성 P0·P1 R-1, `.omc/plans/extensibility-p0-p1.md` §3·§7
 * 단계 2·3 수락 기준). 라우터는 `atmark_admin` 롤, 메일 워커는 `atmark_login_mailer` 롤, 지반은 소유자 롤. 실메일 0(가짜 SES).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - (a) 조직 둘의 owner 로그인 → 메일 **1통** → `next:'select-org'`
 *   - (b) 전환 → 옛 쿠키 401 · 옛 CSRF 403 · 새 세션 만료 = 옛 세션 만료 · 도착 조직 감사 `session.switch`(대상 없음) · 멤버 아닌 조직 404
 *   - (c) 새 조직 → owner · active(Free — 202609301520, 이미 가입한 사용자) · 감사 `org.create` · 하루 상한 409 `org_limit`
 *   - (d) 열거: 멤버십 없는 사용자(초대만 받은 주소)도 같은 202 · 같은 문장 수·순서 · 링크 0
 *   - (f) member 세션으로 **모든** 비-member 변경 라우트 → 403 `forbidden_role`
 *   - logout-all = 이 사용자의 모든 조직 세션 · 제거된 멤버의 세션은 즉시 401 · 강등은 다음 요청부터
 *   - 초대: 초대 → 메일(조직 이름 없음, 초대자 주소) → claim → 초대받은 주소로 로그인 메일 → verify → 멤버십 + 세션 + `member.join`
 *   - 전달된 초대 링크를 다른 브라우저에서 claim 해도 로그인 메일은 초대받은 주소로만 · 초대 토큰 ≠ 로그인 토큰(문맥)
 *   - 검토 전 조직 초대 403 · 이미 멤버 · 대기 중 · 멤버 상한 409 · 취소한 초대는 claim 401 · 억제 주소 미발송 · 전역 상한
 *   - 마지막 owner · 주 소유자 409(역할 변경 · 제거 · 나가기)
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOGIN_BROWSER_COOKIE, SESSION_COOKIE } from '../../../src/admin/http';
import { createOrganizationOp } from '../../../src/admin/ops/agents';
import { ADMIN_ROUTES } from '../../../src/admin/router';
import { csrfTokenOf } from '../../../src/admin/session';
import { createInviteNotifier } from '../../../src/notify/invite-notifier';
import { mintInviteToken } from '../../../src/security/invite-token';
import { runInviteMailer } from '../../../src/workers/invite-mailer';
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
  login,
  mailText,
  ownerPool,
  suffix,
  codeFromMail,
  uniqueCodeIp,
  type SentMail,
  type Session,
} from './support';

interface Org {
  readonly id: string;
  readonly ownerEmail: string;
}

describe.skipIf(!AVAILABLE)('사용자·멤버십·세션 전환·초대 (atmark_admin 롤)', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), mailer.end()]);
  });

  const deps = (): ReturnType<typeof adminDeps> => adminDeps(admin);

  async function orgOf(email: string, name = `members-${suffix()}`): Promise<Org> {
    const created = await createOrganizationOp(owner, { name, ownerEmail: email });
    return { id: created.id, ownerEmail: email };
  }

  const freshEmail = (tag: string): string => `${tag}-${suffix()}${suffix()}@example.com`;

  async function userIdOf(email: string): Promise<string> {
    const row = await owner.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    const id = row.rows[0]?.id;
    if (id === undefined) throw new Error(`users 행이 없다: ${email}`);
    return id;
  }

  async function actions(organizationId: string): Promise<{ action: string; target_id: string | null }[]> {
    const rows = await owner.query<{ action: string; target_id: string | null }>(
      'SELECT action, target_id FROM owner_actions WHERE organization_id = $1 ORDER BY created_at, id',
      [organizationId],
    );
    return rows.rows;
  }

  /** 초대 메일을 로그인 메일 롤로 비운다(그 초대만). */
  async function drainInviteMail(inviteIds: readonly string[], capPerHour = 1_000_000): Promise<{ sent: SentMail[]; report: Record<string, number> }> {
    const ses = fakeSes();
    const now = (): Date => new Date();
    const notifier = createInviteNotifier({ pool: mailer, client: ses.client, keyring: LOGIN_KEYS, now, capPerHour });
    const report = await runInviteMailer({ db: mailer, notifier, now }, { inviteIds });
    return { sent: ses.sent, report: { ...report } };
  }

  function inviteTokenFromMail(mail: SentMail): string {
    const match = /https:\/\/console\.atmark\.ai\/invite#t=(atk_invite_[A-Za-z0-9._-]+)/.exec(mailText(mail));
    if (match?.[1] === undefined) throw new Error(`메일에 초대 링크가 없다:\n${mailText(mail)}`);
    return match[1];
  }

  async function invite(session: Session, email: string, role: 'admin' | 'member' = 'member'): Promise<string> {
    const created = await call(deps(), 'POST', '/api/members/invites', authed(session, { body: { email, role } }));
    if (created.statusCode !== 201) throw new Error(`invite ${String(created.statusCode)} ${created.body}`);
    return (created.json() as { invite: { id: string } }).invite.id;
  }

  /** 초대 → 메일 → claim → 로그인 메일 → verify. 초대받은 사람의 세션. */
  async function acceptInvite(org: Org, session: Session, email: string, role: 'admin' | 'member' = 'member'): Promise<Session> {
    const inviteId = await invite(session, email, role);
    const { sent } = await drainInviteMail([inviteId]);
    const mail = sent[0];
    if (mail === undefined) throw new Error('초대 메일이 나가지 않았다');
    const claimed = await call(deps(), 'POST', '/api/invites/claim', { body: { token: inviteTokenFromMail(mail) } });
    if (claimed.statusCode !== 202) throw new Error(`claim ${String(claimed.statusCode)} ${claimed.body}`);
    const nonce = cookieValue(claimed, LOGIN_BROWSER_COOKIE) ?? '';
    const loginMail = (await drainLoginMail(mailer, org.id)).find((m) => m.to.includes(email));
    if (loginMail === undefined) throw new Error('초대 로그인 메일이 나가지 않았다');
    const verified = await call(deps(), 'POST', '/api/login/verify', { body: { code: codeFromMail(loginMail) }, ip: uniqueCodeIp(), cookies: { [LOGIN_BROWSER_COOKIE]: nonce } });
    if (verified.statusCode !== 200) throw new Error(`verify ${String(verified.statusCode)} ${verified.body}`);
    const token = cookieValue(verified, SESSION_COOKIE) ?? '';
    return { cookies: { [SESSION_COOKIE]: token }, csrf: (verified.json() as { csrf: string }).csrf, token };
  }

  // -------------------------------------------------------------------------
  // P0 — 로그인 · 전환 · 새 조직
  // -------------------------------------------------------------------------

  it('(a) 조직 둘의 owner 로그인 → 메일 1통 · next select-org · /api/me 멤버십 둘', async () => {
    const email = freshEmail('multi');
    const first = await orgOf(email);
    const second = await orgOf(email);
    const requested = await call(deps(), 'POST', '/api/login', { body: { email } });
    expect(requested.statusCode).toBe(202);
    const links = await owner.query('SELECT organization_id FROM owner_login_links WHERE user_id = $1', [await userIdOf(email)]);
    expect(links.rows).toEqual([{ organization_id: first.id }]);
    const mails = [...(await drainLoginMail(mailer, first.id)), ...(await drainLoginMail(mailer, second.id))];
    expect(mails.map((mail) => mail.to)).toEqual([[email]]);
    const [mail] = mails;
    const verified = await call(deps(), 'POST', '/api/login/verify', {
      body: { code: mail === undefined ? '' : codeFromMail(mail) },
      ip: uniqueCodeIp(),
      cookies: { [LOGIN_BROWSER_COOKIE]: cookieValue(requested, LOGIN_BROWSER_COOKIE) ?? '' },
    });
    expect(verified.statusCode).toBe(200);
    expect((verified.json() as { next: string }).next).toBe('select-org');
    const me = await call(deps(), 'GET', '/api/me', { cookies: { [SESSION_COOKIE]: cookieValue(verified, SESSION_COOKIE) ?? '' } });
    const body = me.json() as { user: { email: string }; organization: { id: string; role: string }; memberships: { organizationId: string; role: string }[] };
    expect(body.user.email).toBe(email);
    expect(body.organization).toMatchObject({ id: first.id, role: 'owner' });
    expect(body.memberships.map((m) => [m.organizationId, m.role])).toEqual([
      [first.id, 'owner'],
      [second.id, 'owner'],
    ]);
  });

  it('(ADR-0014) 에이전트 전용 도메인의 주소는 초대할 수 없다 — 다른 잘못된 주소와 같은 400 invalid_email(500 아님 · 에이전트 여부를 드러내지 않는다) · 조직 소유자 주소도 입력 오류', async () => {
    const org = await orgOf(freshEmail('agent-domain'));
    const session = await login(deps(), mailer, org);
    const registrable = `inv${suffix()}${suffix()}.com`;
    const domain = `agents.${registrable}`;
    await owner.query(`INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, 'custom_domains', 'test')`, [org.id]);
    const row = await owner.query<{ id: string }>(
      `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4) RETURNING id`,
      [org.id, domain, registrable, randomBytes(32).toString('base64url')],
    );
    await owner.query(`UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [row.rows[0]?.id]);
    await owner.query(`UPDATE custom_domains SET status = 'verified', verified_at = now() WHERE id = $1`, [row.rows[0]?.id]);
    const denied = await call(deps(), 'POST', '/api/members/invites', authed(session, { body: { email: `someone@${domain}`, role: 'member' } }));
    expect(`${String(denied.statusCode)} ${(denied.json() as { error: string }).error}`).toBe('400 invalid_email');
    await expect(createOrganizationOp(owner, { name: `agent-owner-${suffix()}`, ownerEmail: `owner@${domain}` })).rejects.toThrow(/에이전트 주소일 수 없다/);
  });

  it('(b) 조직 전환 — 새 쿠키·새 CSRF · 옛 쿠키 401 · 옛 CSRF 403 · 만료 상속 · 도착 조직 감사 · 멤버 아닌 조직 404 · 같은 조직 no-op', async () => {
    const email = freshEmail('switch');
    const first = await orgOf(email);
    const second = await orgOf(email);
    const stranger = await orgOf(freshEmail('stranger'));
    const session = await login(deps(), mailer, first);

    const same = await call(deps(), 'POST', '/api/session/org', authed(session, { body: { organizationId: first.id } }));
    expect(same.statusCode).toBe(200);
    expect(same.cookies ?? []).toEqual([]);
    expect((same.json() as { csrf: string }).csrf).toBe(session.csrf);

    for (const target of [stranger.id, randomUUID(), 'not-a-uuid']) {
      const denied = await call(deps(), 'POST', '/api/session/org', authed(session, { body: { organizationId: target } }));
      expect(denied.statusCode, target).toBe(404);
      expect((denied.json() as { error: string }).error).toBe('organization_not_found');
    }

    const switched = await call(deps(), 'POST', '/api/session/org', authed(session, { body: { organizationId: second.id } }));
    expect(switched.statusCode).toBe(200);
    const token = cookieValue(switched, SESSION_COOKIE) ?? '';
    const body = switched.json() as { csrf: string; organization: { id: string; role: string; reviewStatus: string } };
    expect(token).not.toBe(session.token);
    expect(body.csrf).toBe(csrfTokenOf(token));
    expect(body.organization).toMatchObject({ id: second.id, role: 'owner', reviewStatus: 'active' });

    // 옛 쿠키는 죽었다 · 새 쿠키 + 옛 CSRF 는 403.
    expect((await call(deps(), 'GET', '/api/me', { cookies: session.cookies })).statusCode).toBe(401);
    const staleCsrf = await call(deps(), 'POST', '/api/logout', { cookies: { [SESSION_COOKIE]: token }, headers: { 'x-atmark-csrf': session.csrf } });
    expect(staleCsrf.statusCode).toBe(403);
    const me = await call(deps(), 'GET', '/api/me', { cookies: { [SESSION_COOKIE]: token } });
    expect((me.json() as { organization: { id: string } }).organization.id).toBe(second.id);

    const rows = await owner.query<{ token_hash: string; expires_at: Date; revoked_at: Date | null; switched_from_session_id: string | null; id: string }>(
      'SELECT id, token_hash, expires_at, revoked_at, switched_from_session_id FROM owner_sessions WHERE user_id = $1 ORDER BY created_at',
      [await userIdOf(email)],
    );
    const [parent, child] = rows.rows;
    expect(parent?.revoked_at).not.toBeNull();
    expect(child?.switched_from_session_id).toBe(parent?.id);
    expect(child?.expires_at.getTime()).toBe(parent?.expires_at.getTime());
    expect(await actions(second.id)).toEqual([{ action: 'session.switch', target_id: null }]);
    // 떠난 조직의 로그에는 다른 조직 id 가 없다.
    expect((await actions(first.id)).map((row) => row.target_id)).not.toContain(second.id);
    const lastOrg = await owner.query<{ last_organization_id: string }>('SELECT last_organization_id FROM users WHERE email = $1', [email]);
    expect(lastOrg.rows[0]?.last_organization_id).toBe(second.id);
  });

  it('(c) 새 조직 — 201 · owner · active(Free — 202609301520) · 새 조직으로 전환 · 감사 org.create · 하루 상한 409 org_limit · 이름 400', async () => {
    const email = freshEmail('neworg');
    const first = await orgOf(email);
    const session = await login(deps(), mailer, first);
    const bad = await call(deps(), 'POST', '/api/organizations', authed(session, { body: { name: '  ' } }));
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: string }).error).toBe('invalid_organization_name');

    const created = await call(deps(), 'POST', '/api/organizations', authed(session, { body: { name: '두 번째 팀' } }));
    expect(created.statusCode).toBe(201);
    const body = created.json() as { csrf: string; organization: { id: string; name: string; role: string; reviewStatus: string } };
    expect(body.organization).toMatchObject({ name: '두 번째 팀', role: 'owner', reviewStatus: 'active' });
    const next: Session = { cookies: { [SESSION_COOKIE]: cookieValue(created, SESSION_COOKIE) ?? '' }, csrf: body.csrf, token: cookieValue(created, SESSION_COOKIE) ?? '' };
    const org = await owner.query<{ owner_email: string; signup_source: string }>('SELECT owner_email, signup_source FROM organizations WHERE id = $1', [
      body.organization.id,
    ]);
    expect(org.rows[0]).toEqual({ owner_email: email, signup_source: 'self_signup' });
    expect(await actions(body.organization.id)).toEqual([{ action: 'org.create', target_id: body.organization.id }]);
    // 옛 세션은 폐기됐다.
    expect((await call(deps(), 'GET', '/api/me', { cookies: session.cookies })).statusCode).toBe(401);

    // 하루 2 — CLI 로 만든 첫 조직도 오늘 생긴 owner 조직이라 센다(org_create 멤버십). 세 번째는 409.
    const third = await call(deps(), 'POST', '/api/organizations', authed(next, { body: { name: '세 번째 팀' } }));
    expect(third.statusCode).toBe(409);
    expect((third.json() as { error: string }).error).toBe('org_limit');
    // 실패한 요청은 세션을 건드리지 않았다.
    expect((await call(deps(), 'GET', '/api/me', { cookies: next.cookies })).statusCode).toBe(200);
  });

  it('(d) 열거 방지 — 멤버십 없는 사용자(초대만 받은 주소) · 없는 주소 · 멤버: 같은 202 · 같은 문장·순서 · 링크는 멤버만', async () => {
    const member = await orgOf(freshEmail('enum-member'));
    const invitedOnly = freshEmail('enum-invited');
    await owner.query('INSERT INTO users (email) VALUES ($1)', [invitedOnly]);
    const inputs = [member.ownerEmail, invitedOnly, freshEmail('enum-nobody')];
    const traces: string[][] = [];
    for (const email of inputs) {
      const trace: string[] = [];
      const recording = new Proxy(admin, {
        get(target, property, receiver) {
          if (property === 'connect') {
            return async () => {
              const client = await target.connect();
              const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<unknown>;
              return Object.assign(Object.create(client) as object, {
                query: (text: string, values?: unknown[]) => {
                  trace.push(text.replace(/\s+/g, ' ').slice(0, 60));
                  return query(text, values);
                },
                release: () => client.release(),
              });
            };
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      const result = await call(adminDeps(recording), 'POST', '/api/login', { body: { email } });
      expect(result.statusCode).toBe(202);
      expect(result.body).toBe('{"ok":true}');
      traces.push(trace);
    }
    expect(traces[1]).toEqual(traces[0]);
    expect(traces[2]).toEqual(traces[0]);
    const links = await owner.query<{ email: string }>(
      'SELECT u.email FROM owner_login_links l JOIN users u ON u.id = l.user_id WHERE u.email = ANY ($1::text[])',
      [inputs],
    );
    expect(links.rows.map((row) => row.email)).toEqual([member.ownerEmail]);
  });

  it('logout-all — 이 사용자의 모든 조직 세션 폐기(다른 사용자 세션은 그대로)', async () => {
    const email = freshEmail('logoutall');
    const first = await orgOf(email);
    const second = await orgOf(email);
    const other = await orgOf(freshEmail('bystander'));
    const a = await login(deps(), mailer, first);
    const b = await login(deps(), mailer, first);
    const switched = await call(deps(), 'POST', '/api/session/org', authed(b, { body: { organizationId: second.id } }));
    const inSecond: Session = { cookies: { [SESSION_COOKIE]: cookieValue(switched, SESSION_COOKIE) ?? '' }, csrf: '', token: '' };
    const bystander = await login(deps(), mailer, other);
    expect((await call(deps(), 'POST', '/api/logout-all', authed(a))).statusCode).toBe(204);
    expect((await call(deps(), 'GET', '/api/me', { cookies: a.cookies })).statusCode).toBe(401);
    expect((await call(deps(), 'GET', '/api/me', { cookies: inSecond.cookies })).statusCode).toBe(401);
    expect((await call(deps(), 'GET', '/api/me', { cookies: bystander.cookies })).statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // P1 — 초대 · 멤버
  // -------------------------------------------------------------------------

  it('초대 흐름 — 메일(조직 이름 없음 · 초대자 주소 · 로그인 메일 주체) → claim → 로그인 메일은 초대받은 주소로 → verify → member · 감사 member.invite·member.join', async () => {
    const org = await orgOf(freshEmail('inviter'), `비밀조직-${suffix()}`);
    const orgName = (await owner.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [org.id])).rows[0]?.name ?? '';
    const ownerSession = await login(deps(), mailer, org);
    const inviteeEmail = freshEmail('invitee');
    const inviteId = await invite(ownerSession, inviteeEmail, 'admin');

    const { sent } = await drainInviteMail([inviteId]);
    expect(sent).toHaveLength(1);
    const [mail] = sent;
    if (mail === undefined) throw new Error('mail');
    expect(mail.from).toBe('login@atmark.ai');
    expect(mail.to).toEqual([inviteeEmail]);
    const text = mailText(mail);
    expect(text).toContain(org.ownerEmail);
    expect(text).not.toContain(orgName);
    expect(text).not.toContain('?');
    // 다시 비워도 두 번째 메일은 없다.
    expect((await drainInviteMail([inviteId])).sent).toHaveLength(0);

    const inviteToken = inviteTokenFromMail(mail);
    // 문맥 분리 — 초대 토큰은 로그인 verify 에서 통하지 않고(로그인은 코드만 — 토큰은 보지도 않고 410), 옛 로그인 토큰 모양은 claim 에서 통하지 않는다.
    const loginAsInvite = inviteToken.replace(/^atk_invite_/, 'atk_login_');
    expect((await call(deps(), 'POST', '/api/invites/claim', { body: { token: loginAsInvite } })).statusCode).toBe(401);
    const probe = await call(deps(), 'POST', '/api/login', { body: { email: 'nobody@example.com' } });
    const crossed = await call(deps(), 'POST', '/api/login/verify', {
      body: { token: inviteToken },
      cookies: { [LOGIN_BROWSER_COOKIE]: cookieValue(probe, LOGIN_BROWSER_COOKIE) ?? '' },
    });
    expect(crossed.statusCode).toBe(410);
    expect(crossed.json()).toMatchObject({ error: 'login_link_retired' });

    const claimed = await call(deps(), 'POST', '/api/invites/claim', { body: { token: inviteToken } });
    expect(claimed.statusCode).toBe(202);
    const nonce = cookieValue(claimed, LOGIN_BROWSER_COOKIE) ?? '';
    const loginMails = await drainLoginMail(mailer, org.id);
    expect(loginMails.map((m) => m.to)).toEqual([[inviteeEmail]]);
    const [loginMail] = loginMails;
    const verified = await call(deps(), 'POST', '/api/login/verify', {
      body: { code: loginMail === undefined ? '' : codeFromMail(loginMail) },
      ip: uniqueCodeIp(),
      cookies: { [LOGIN_BROWSER_COOKIE]: nonce },
    });
    expect(verified.statusCode).toBe(200);
    expect((verified.json() as { next: string }).next).toBe('app');
    const me = await call(deps(), 'GET', '/api/me', { cookies: { [SESSION_COOKIE]: cookieValue(verified, SESSION_COOKIE) ?? '' } });
    expect((me.json() as { organization: { id: string; role: string } }).organization).toMatchObject({ id: org.id, role: 'admin' });

    const inviteeId = await userIdOf(inviteeEmail);
    const log = await actions(org.id);
    expect(log.filter((row) => row.action.startsWith('member.'))).toEqual([
      { action: 'member.invite', target_id: inviteId },
      { action: 'member.join', target_id: inviteeId },
    ]);
    const event = await owner.query('SELECT old_role, new_role FROM membership_events WHERE user_id = $1', [inviteeId]);
    expect(event.rows).toEqual([{ old_role: null, new_role: 'admin' }]);
    // 투명성 로그 원천 — 감사 행마다 outbox 한 행(owner.action 잎, 202609241600 트리거). 멤버십 사건은 따로 잎 모양을 만들지 않는다.
    const outbox = await owner.query(
      `SELECT 1 FROM tlog_outbox t JOIN owner_actions a ON a.id::text = t.source_id
        WHERE t.source_table = 'owner_actions' AND a.organization_id = $1 AND a.action IN ('member.invite', 'member.join')`,
      [org.id],
    );
    expect(outbox.rowCount).toBe(2);
    // 수락된 초대는 다시 claim 할 수 없다.
    expect((await call(deps(), 'POST', '/api/invites/claim', { body: { token: inviteToken } })).statusCode).toBe(401);
  });

  it('전달된 초대 링크 — 다른 브라우저의 claim 도 로그인 메일은 초대받은 주소로만 · claim 한 브라우저는 메일 없이는 세션을 못 만든다', async () => {
    const org = await orgOf(freshEmail('fwd-owner'));
    const ownerSession = await login(deps(), mailer, org);
    const inviteeEmail = freshEmail('fwd-invitee');
    const inviteId = await invite(ownerSession, inviteeEmail);
    const [mail] = (await drainInviteMail([inviteId])).sent;
    if (mail === undefined) throw new Error('mail');
    const attacker = await call(deps(), 'POST', '/api/invites/claim', { body: { token: inviteTokenFromMail(mail) }, ip: '203.0.113.9' });
    expect(attacker.statusCode).toBe(202);
    const loginMails = await drainLoginMail(mailer, org.id);
    expect(loginMails.map((m) => m.to)).toEqual([[inviteeEmail]]);
    // 공격자는 로그인 링크 토큰을 모른다 — 링크 행이 있어도 세션 0, 멤버십 0.
    const members = await owner.query('SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1', [inviteeEmail]);
    expect(members.rowCount).toBe(0);
  });

  it('초대 거부 — 검토 전 조직 403 · 모양 400 · 이미 멤버·대기 409 · 멤버 상한 409 · 취소 → claim 401 · 메일 obsolete', async () => {
    const pendingEmail = freshEmail('pending-owner');
    const pendingOrg = await orgOf(pendingEmail);
    await owner.query(`UPDATE organizations SET review_status = 'pending_review' WHERE id = $1`, [pendingOrg.id]);
    const pendingSession = await login(deps(), mailer, pendingOrg);
    const notActive = await call(deps(), 'POST', '/api/members/invites', authed(pendingSession, { body: { email: freshEmail('x'), role: 'member' } }));
    expect(notActive.statusCode).toBe(403);
    expect((notActive.json() as { error: string }).error).toBe('org_not_active');

    const org = await orgOf(freshEmail('limits-owner'));
    const session = await login(deps(), mailer, org);
    const shape = async (body: unknown): Promise<string> => {
      const result = await call(deps(), 'POST', '/api/members/invites', authed(session, { body }));
      return `${String(result.statusCode)} ${(result.json() as { error: string }).error}`;
    };
    expect(await shape({ email: 'not-an-email', role: 'member' })).toBe('400 invalid_email');
    expect(await shape({ email: freshEmail('y'), role: 'owner' })).toBe('400 invalid_role');
    expect(await shape({ email: org.ownerEmail, role: 'member' })).toBe('409 already_member');

    const revokedEmail = freshEmail('revoked');
    const revokedId = await invite(session, revokedEmail);
    expect(await shape({ email: revokedEmail, role: 'admin' })).toBe('409 invite_pending');
    const token = mintInviteToken(LOGIN_KEYS, {
      inviteId: revokedId,
      expiresAt: (await owner.query<{ expires_at: Date }>('SELECT expires_at FROM org_invites WHERE id = $1', [revokedId])).rows[0]?.expires_at ?? new Date(),
    });
    const revoked = await call(deps(), 'POST', `/api/members/invites/${revokedId}/revoke`, authed(session));
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as { invite: { status: string } }).invite.status).toBe('revoked');
    expect((await call(deps(), 'POST', `/api/members/invites/${revokedId}/revoke`, authed(session))).statusCode).toBe(409);
    const status = await owner.query('SELECT status::text, last_error FROM org_invites WHERE id = $1', [revokedId]);
    expect(status.rows).toEqual([{ status: 'obsolete', last_error: 'invite_revoked' }]);
    expect((await drainInviteMail([revokedId])).sent).toHaveLength(0);
    const claim = await call(deps(), 'POST', '/api/invites/claim', { body: { token } });
    expect(claim.statusCode).toBe(401);
    expect((claim.json() as { error: string }).error).toBe('invite_invalid');

    // 멤버 1(owner) + 대기 → 5 가 차면 member_limit.
    for (let i = 0; i < 4; i += 1) await invite(session, freshEmail(`fill${String(i)}`));
    expect(await shape({ email: freshEmail('over'), role: 'member' })).toBe('409 member_limit');
    const listing = await call(deps(), 'GET', '/api/members', authed(session));
    const listed = listing.json() as { members: { primary: boolean; you: boolean }[]; limits: { maxMembers: number; pendingInvites: number } };
    expect(listed.members).toEqual([expect.objectContaining({ primary: true, you: true, role: 'owner' })]);
    expect(listed.limits).toMatchObject({ maxMembers: 5, pendingInvites: 4 });
  });

  it('억제 주소 초대 → undeliverable(suppressed) · 메일 0 · 전역 상한(가입 메일과 같은 창) → undeliverable(global_cap)', async () => {
    const org = await orgOf(freshEmail('supp-owner'));
    const session = await login(deps(), mailer, org);
    const suppressed = freshEmail('bounced');
    await owner.query(`INSERT INTO system_mail_suppressions (address, reason) VALUES ($1, 'hard_bounce')`, [suppressed]);
    const suppressedId = await invite(session, suppressed);
    const first = await drainInviteMail([suppressedId]);
    expect(first.sent).toHaveLength(0);
    expect(first.report['undeliverable']).toBe(1);
    const capped = await invite(session, freshEmail('capped'));
    // 이 파일의 앞 테스트가 이미 초대 메일을 보냈다 — 창 안 사용량 ≥ 1 이므로 상한 1 이면 막힌다.
    const second = await drainInviteMail([capped], 1);
    expect(second.sent).toHaveLength(0);
    const row = await owner.query('SELECT status::text, last_error FROM org_invites WHERE id = $1', [capped]);
    expect(row.rows).toEqual([{ status: 'undeliverable', last_error: 'global_cap' }]);
  });

  it('(f) member 세션 — 비-member 변경 라우트 전부 403 forbidden_role · 읽기는 된다', async () => {
    const org = await orgOf(freshEmail('rbac-owner'));
    const ownerSession = await login(deps(), mailer, org);
    const memberSession = await acceptInvite(org, ownerSession, freshEmail('rbac-member'), 'member');
    const fill = (path: string): string =>
      path
        .replace('{agentId}', '0'.repeat(32))
        .replace('{tokenId}', randomUUID())
        .replace('{ruleId}', randomUUID())
        .replace('{inviteId}', randomUUID())
        .replace('{userId}', randomUUID())
        .replace(/\{[A-Za-z]+\}/g, randomUUID());
    const guarded = ADMIN_ROUTES.filter((route) => route.auth === 'session' && route.method !== 'GET' && route.role !== 'member');
    expect(guarded.length).toBeGreaterThan(10);
    for (const route of guarded) {
      const result = await call(deps(), route.method, fill(route.path), authed(memberSession, { body: {} }));
      expect(result.statusCode, `${route.method} ${route.path}`).toBe(403);
      expect((result.json() as { error: string }).error, `${route.method} ${route.path}`).toBe('forbidden_role');
    }
    expect((await call(deps(), 'GET', '/api/agents', authed(memberSession))).statusCode).toBe(200);
    expect((await call(deps(), 'GET', '/api/members', authed(memberSession))).statusCode).toBe(200);
  });

  it('인가는 매 요청 멤버십에서 — 세션 행을 건드리지 않고 멤버십만 제거해도(운영자 셸·트리거 경로) 그 세션은 다음 요청 401', async () => {
    const org = await orgOf(freshEmail('join-owner'));
    const ownerSession = await login(deps(), mailer, org);
    const email = freshEmail('join-member');
    const session = await acceptInvite(org, ownerSession, email, 'member');
    expect((await call(deps(), 'GET', '/api/me', { cookies: session.cookies })).statusCode).toBe(200);
    await owner.query(
      'UPDATE memberships SET removed_at = now() WHERE organization_id = $1 AND user_id = $2 AND removed_at IS NULL',
      [org.id, await userIdOf(email)],
    );
    const revoked = await owner.query('SELECT 1 FROM owner_sessions WHERE token_hash IS NOT NULL AND revoked_at IS NULL AND user_id = $1', [await userIdOf(email)]);
    expect(revoked.rowCount).toBe(1); // 세션 행은 살아 있다 — 막는 것은 조인이다.
    expect((await call(deps(), 'GET', '/api/me', { cookies: session.cookies })).statusCode).toBe(401);
  });

  it('역할 변경·제거 — 강등은 다음 요청부터 · 제거된 멤버 세션 즉시 401 · 마지막 owner·주 소유자 409 · 나가기', async () => {
    const org = await orgOf(freshEmail('roles-owner'));
    const ownerSession = await login(deps(), mailer, org);
    const adminEmail = freshEmail('roles-admin');
    const adminSession = await acceptInvite(org, ownerSession, adminEmail, 'admin');
    const adminId = await userIdOf(adminEmail);
    const primaryId = await userIdOf(org.ownerEmail);

    // admin 은 조직 정지를 켤 수 있지만 풀 수 없다(owner 만).
    const on = await call(deps(), 'POST', '/api/kill-switch', authed(adminSession, { body: { scope: 'org', id: org.id, on: true } }));
    expect(on.statusCode).toBe(200);
    const off = await call(deps(), 'POST', '/api/kill-switch', authed(adminSession, { body: { scope: 'org', id: org.id, on: false } }));
    expect(off.statusCode).toBe(403);
    expect((off.json() as { error: string }).error).toBe('forbidden_role');
    expect((await call(deps(), 'POST', '/api/kill-switch', authed(ownerSession, { body: { scope: 'org', id: org.id, on: false } }))).statusCode).toBe(200);

    // 주 소유자는 강등·제거 불가 · 자기 자신 제거는 400.
    const demotePrimary = await call(deps(), 'PATCH', `/api/members/${primaryId}`, authed(ownerSession, { body: { role: 'admin' } }));
    expect(demotePrimary.statusCode).toBe(409);
    expect((demotePrimary.json() as { error: string }).error).toBe('primary_owner');
    expect((await call(deps(), 'DELETE', `/api/members/${primaryId}`, authed(ownerSession))).statusCode).toBe(400);
    const leavePrimary = await call(deps(), 'POST', '/api/members/leave', authed(ownerSession));
    expect(leavePrimary.statusCode).toBe(409);

    // 강등 → 다음 요청부터 admin 행위 403.
    const demote = await call(deps(), 'PATCH', `/api/members/${adminId}`, authed(ownerSession, { body: { role: 'member' } }));
    expect(demote.statusCode).toBe(200);
    expect(demote.json()).toMatchObject({ changed: true, member: { userId: adminId, role: 'member' } });
    expect((await call(deps(), 'POST', '/api/agents', authed(adminSession, { body: { name: 'x', localPart: `x${suffix()}` } }))).statusCode).toBe(403);
    const same = await call(deps(), 'PATCH', `/api/members/${adminId}`, authed(ownerSession, { body: { role: 'member' } }));
    expect(same.json()).toMatchObject({ changed: false });

    // 제거 → 그 사람의 세션 즉시 401 · 감사 · 상세.
    expect((await call(deps(), 'DELETE', `/api/members/${adminId}`, authed(ownerSession))).statusCode).toBe(204);
    expect((await call(deps(), 'GET', '/api/me', { cookies: adminSession.cookies })).statusCode).toBe(401);
    expect((await call(deps(), 'DELETE', `/api/members/${adminId}`, authed(ownerSession))).statusCode).toBe(404);
    const log = (await actions(org.id)).filter((row) => row.action === 'member.role' || row.action === 'member.remove');
    expect(log).toEqual([
      { action: 'member.role', target_id: adminId },
      { action: 'member.remove', target_id: adminId },
    ]);

    // 나가기 — 다른 멤버는 나갈 수 있다(세션 폐기 · 쿠키 삭제).
    const leaverEmail = freshEmail('roles-leaver');
    const leaver = await acceptInvite(org, ownerSession, leaverEmail, 'member');
    const left = await call(deps(), 'POST', '/api/members/leave', authed(leaver));
    expect(left.statusCode).toBe(204);
    expect(left.cookies?.[0]).toMatch(/^__Host-atmark_admin=; /);
    expect((await call(deps(), 'GET', '/api/me', { cookies: leaver.cookies })).statusCode).toBe(401);
  });
});
