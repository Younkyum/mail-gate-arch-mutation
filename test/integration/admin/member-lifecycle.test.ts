/**
 * **멤버·초대 수명 — 확장성 P0·P1 적대적 검토 보강**(M1·M2·M3·L2·L3·L6, 202609250180). 실제 Postgres · 라우터는 `atmark_admin` 롤 ·
 * 메일 워커는 `atmark_login_mailer` 롤 · 지반은 소유자 롤. 실메일 0(가짜 SES).
 *
 * 되돌리면 빨개져야 하는 것(2026-09-25 되돌려 확인):
 *   - M1 전환 ∥ logout-all · 전환 ∥ 멤버 제거 — 전환 트랜잭션이 자식 세션을 넣고 커밋 전일 때 폐기 문장이 돌아도 살아 남는 자식이 없다
 *     (`revokeAllSessions`·`removeMembership` 의 `lockUserSessions` 를 빼면 빨강). 두 연결로 결정적으로: 소유자 연결이 `users` 행을 잡아
 *     전환을 마지막 문장(`UPDATE users`)에서 세운다.
 *   - M2 owner 강등·제거 → 그 사람의 대기 초대 취소 · 조직 키 폐기 · 감사(`revokeGrantsOf` 를 빼면 빨강) · 초대자가 owner 가 아니면 수락·claim·
 *     발송 거부(202609250180 ②③④)
 *   - M3 동결 조직 초대 403(앱) · AT403(DB) · 초대 뒤 동결 → 발송 obsolete(`org_not_sendable`) · 검토 전으로 돌아가도 같다
 *   - L2 주소당 상한은 **보낸** 메일(조직 무관 3) — 조직 넷에서 초대는 만들어지고 넷째 메일만 `recipient_cap` · 한 조직 안의 같은 주소 하루 3
 *   - L3 동결된 조직의 초대 링크 claim 401 · 초대 로그인 링크 INSERT 거부 · 수락 NULL
 *   - L6 조직 전환·새 조직 10분 30회 → 429 `rate_limited`
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOGIN_BROWSER_COOKIE, SESSION_COOKIE } from '../../../src/admin/http';
import { createOrganizationOp } from '../../../src/admin/ops/agents';
import { grantPlan } from '../../support/entitlements';
import { INVITES_PER_USER_PER_DAY } from '../../../src/admin/ops/members';
import { SESSION_SWITCHES_PER_USER } from '../../../src/admin/session';
import { createInviteNotifier } from '../../../src/notify/invite-notifier';
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

/** `notify/invite-notifier.ts` 의 주소당 하루 메일 상한(모듈 밖으로 내보내지 않는다 — 공개 표면 동결). */
const INVITE_MAILS_PER_RECIPIENT_PER_DAY = 3;

interface Org {
  readonly id: string;
  readonly ownerEmail: string;
}

describe.skipIf(!AVAILABLE)('멤버·초대 수명 보강 (atmark_admin 롤)', () => {
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
  const freshEmail = (tag: string): string => `${tag}-${suffix()}${suffix()}@example.com`;

  async function orgOf(email: string): Promise<Org> {
    const created = await createOrganizationOp(owner, { name: `life-${suffix()}`, ownerEmail: email });
    // 요금제(ADR-0011) — 조직 키 여러 개를 쓰는 시나리오라 도입 전 한도(beta: 키 5)를 준다.
    await grantPlan(owner, created.id, 'beta');
    return { id: created.id, ownerEmail: email };
  }

  async function userIdOf(email: string): Promise<string> {
    const row = await owner.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    const id = row.rows[0]?.id;
    if (id === undefined) throw new Error(`users 행이 없다: ${email}`);
    return id;
  }

  /** 한 트랜잭션의 감사 행은 created_at(= 트랜잭션 시작)이 같다 — 마지막 트랜잭션의 행들을 행위 이름 순으로. */
  async function lastTransactionActions(organizationId: string): Promise<{ action: string; target_id: string | null }[]> {
    const rows = await owner.query<{ action: string; target_id: string | null }>(
      `SELECT action, target_id FROM owner_actions
        WHERE organization_id = $1 AND created_at = (SELECT max(created_at) FROM owner_actions WHERE organization_id = $1)
        ORDER BY action COLLATE "C", target_id`,
      [organizationId],
    );
    return rows.rows;
  }

  async function actions(organizationId: string): Promise<{ action: string; target_id: string | null }[]> {
    const rows = await owner.query<{ action: string; target_id: string | null }>(
      'SELECT action, target_id FROM owner_actions WHERE organization_id = $1 ORDER BY created_at, id',
      [organizationId],
    );
    return rows.rows;
  }

  async function drainInviteMail(inviteIds: readonly string[]): Promise<{ sent: SentMail[]; report: Record<string, number> }> {
    const ses = fakeSes();
    const now = (): Date => new Date();
    const notifier = createInviteNotifier({ pool: mailer, client: ses.client, keyring: LOGIN_KEYS, now, capPerHour: 1_000_000 });
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

  async function acceptInvite(org: Org, session: Session, email: string, role: 'admin' | 'member' = 'member'): Promise<Session> {
    const inviteId = await invite(session, email, role);
    const mail = (await drainInviteMail([inviteId])).sent[0];
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

  async function issueOrgKey(session: Session, label: string): Promise<{ id: string; key: string }> {
    const issued = await call(deps(), 'POST', '/api/org-keys', authed(session, { body: { label, capabilities: ['agents:read'] } }));
    if (issued.statusCode !== 201) throw new Error(`org-key ${String(issued.statusCode)} ${issued.body}`);
    const body = issued.json() as { key: string; item: { id: string } };
    return { id: body.item.id, key: body.key };
  }

  const orgApiStatus = async (key: string): Promise<number> =>
    (await call(deps(), 'GET', '/org-api/v1/agents', { headers: { authorization: `Bearer ${key}` } })).statusCode;

  async function inviteRow(id: string): Promise<{ revoked: boolean; status: string; last_error: string | null }> {
    const row = await owner.query<{ revoked: boolean; status: string; last_error: string | null }>(
      'SELECT revoked_at IS NOT NULL AS revoked, status::text AS status, last_error FROM org_invites WHERE id = $1',
      [id],
    );
    const found = row.rows[0];
    if (found === undefined) throw new Error(`초대 ${id} 가 없다`);
    return found;
  }

  /** 다른 연결이 이 문장 모양으로 잠금을 기다리기 시작했거나, 그 요청이 이미 끝났을 때까지. */
  async function blockedOrSettled(pending: Promise<unknown>, pattern: RegExp): Promise<'blocked' | 'settled'> {
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let i = 0; i < 400; i += 1) {
      if (settled) return 'settled';
      const waiting = await owner.query<{ query: string }>(
        `SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
      );
      if (waiting.rows.some((row) => pattern.test(row.query))) return 'blocked';
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`잠금 대기도 끝남도 보이지 않는다: ${String(pattern)}`);
  }

  /** 전환을 마지막 문장(`UPDATE users SET last_organization_id`)에서 세운 채 `during` 을 돌린다 — 자식 INSERT·부모 폐기는 끝났고 커밋 전. */
  async function withSwitchHeld<T>(
    userId: string,
    session: Session,
    targetOrg: string,
    during: () => Promise<T>,
  ): Promise<{ switched: Awaited<ReturnType<typeof call>>; result: T }> {
    const blocker = await owner.connect();
    try {
      await blocker.query('BEGIN');
      // FOR NO KEY UPDATE — 자식 INSERT 의 FK 확인(FOR KEY SHARE)은 통과시키고, 마지막 `UPDATE users`(비키 칸)만 세운다.
      await blocker.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
      const switching = call(deps(), 'POST', '/api/session/org', authed(session, { body: { organizationId: targetOrg } }));
      expect(await blockedOrSettled(switching, /UPDATE users SET last_organization_id/)).toBe('blocked');
      const result = await during();
      await blocker.query('COMMIT');
      return { switched: await switching, result };
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  }

  // -------------------------------------------------------------------------
  // M1 — 세션 경합
  // -------------------------------------------------------------------------

  it('M1 전환 ∥ logout-all — 전환이 커밋 전일 때 들어온 logout-all 뒤에 살아 있는 세션이 없다(새 쿠키도 401)', async () => {
    const email = freshEmail('race-out');
    const first = await orgOf(email);
    const second = await orgOf(email);
    const session = await login(deps(), mailer, first);
    const userId = await userIdOf(email);

    const { switched, result: loggedOut } = await withSwitchHeld(userId, session, second.id, async () => {
      const out = call(deps(), 'POST', '/api/logout-all', authed(session));
      // 고친 코드: 사용자 세션 잠금에서 기다린다. 옛 코드: 부모 행 잠금에서 기다렸다(그리고 자식을 놓쳤다).
      expect(await blockedOrSettled(out, /owner_session_user|UPDATE owner_sessions SET revoked_at = now\(\) WHERE user_id/)).toBe('blocked');
      return { pending: out }; // 약속을 그대로 돌려주면 await 가 그것까지 기다린다(잠금을 쥔 채 교착).
    });
    expect(switched.statusCode).toBe(200);
    expect((await loggedOut.pending).statusCode).toBe(204);

    const live = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM owner_sessions WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    expect(live.rows[0]?.n).toBe(0);
    const childToken = cookieValue(switched, SESSION_COOKIE) ?? '';
    expect(childToken).not.toBe('');
    expect((await call(deps(), 'GET', '/api/me', { cookies: { [SESSION_COOKIE]: childToken } })).statusCode).toBe(401);
  });

  it('M1 전환 ∥ 멤버 제거 — 제거된 조직으로 막 전환한 자식 세션도 행에서 폐기된다', async () => {
    const inviteeEmail = freshEmail('race-rm');
    const home = await orgOf(inviteeEmail);
    const team = await orgOf(freshEmail('race-rm-owner'));
    const inviteeHome = await login(deps(), mailer, home);
    const teamOwner = await login(deps(), mailer, team);
    await acceptInvite(team, teamOwner, inviteeEmail, 'member');
    const inviteeId = await userIdOf(inviteeEmail);

    const { switched, result: removed } = await withSwitchHeld(inviteeId, inviteeHome, team.id, async () => {
      const remove = call(deps(), 'DELETE', `/api/members/${inviteeId}`, authed(teamOwner));
      // 고친 코드는 사용자 세션 잠금에서 기다리고(blocked), 옛 코드는 기다리지 않고 끝났다(settled) — 어느 쪽이든 아래 행 단언이 판정한다.
      await blockedOrSettled(remove, /owner_session_user/);
      return { pending: remove };
    });
    expect(switched.statusCode).toBe(200);
    expect((await removed.pending).statusCode).toBe(204);
    const live = await owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM owner_sessions WHERE user_id = $1 AND organization_id = $2 AND revoked_at IS NULL',
      [inviteeId, team.id],
    );
    expect(live.rows[0]?.n).toBe(0);
  });

  // -------------------------------------------------------------------------
  // M2 — owner 가 owner 가 아니게 되면 그 사람의 초대·조직 키를 거둔다
  // -------------------------------------------------------------------------

  it('M2 owner 강등·제거 → 그 사람의 대기 초대 취소 · 조직 키 폐기 · 감사 · 같은 트랜잭션', async () => {
    const org = await orgOf(freshEmail('m2-primary'));
    const primary = await login(deps(), mailer, org);
    const coEmail = freshEmail('m2-co');
    const co = await acceptInvite(org, primary, coEmail, 'admin');
    const coId = await userIdOf(coEmail);
    expect((await call(deps(), 'PATCH', `/api/members/${coId}`, authed(primary, { body: { role: 'owner' } }))).statusCode).toBe(200);

    // 공동 owner 가 초대 하나 · 키 하나를 남긴다. 주 소유자의 것은 거두지 않는다.
    const coInvite = await invite(co, freshEmail('m2-target'));
    const coKey = await issueOrgKey(co, 'co key');
    const primaryKey = await issueOrgKey(primary, 'primary key');
    expect(await orgApiStatus(coKey.key)).toBe(200);

    const demoted = await call(deps(), 'PATCH', `/api/members/${coId}`, authed(primary, { body: { role: 'admin' } }));
    expect(demoted.statusCode).toBe(200);
    expect(await inviteRow(coInvite)).toEqual({ revoked: true, status: 'obsolete', last_error: 'invite_revoked' });
    expect(await orgApiStatus(coKey.key)).toBe(401);
    expect(await orgApiStatus(primaryKey.key)).toBe(200);
    expect(await lastTransactionActions(org.id)).toEqual([
      { action: 'member.invite_revoke', target_id: coInvite },
      { action: 'member.role', target_id: coId },
      { action: 'org_key.revoke', target_id: coKey.id },
    ]);

    // 제거 경로 — 다시 owner 로 올린 뒤 초대·키 → 내보내기.
    expect((await call(deps(), 'PATCH', `/api/members/${coId}`, authed(primary, { body: { role: 'owner' } }))).statusCode).toBe(200);
    const coInvite2 = await invite(co, freshEmail('m2-target2'));
    const coKey2 = await issueOrgKey(co, 'co key 2');
    expect((await call(deps(), 'DELETE', `/api/members/${coId}`, authed(primary))).statusCode).toBe(204);
    expect((await inviteRow(coInvite2)).revoked).toBe(true);
    expect(await orgApiStatus(coKey2.key)).toBe(401);
    expect(await lastTransactionActions(org.id)).toEqual([
      { action: 'member.invite_revoke', target_id: coInvite2 },
      { action: 'member.remove', target_id: coId },
      { action: 'org_key.revoke', target_id: coKey2.id },
    ]);
    expect((await actions(org.id)).filter((row) => row.action === 'org_key.revoke').map((row) => row.target_id)).toEqual([coKey.id, coKey2.id]);

    // 409 로 끝난 강등(주 소유자)은 아무것도 거두지 않는다 — 트랜잭션이 통째로 되돌아간다.
    const primaryInvite = await invite(primary, freshEmail('m2-keep'));
    const primaryId = await userIdOf(org.ownerEmail);
    expect((await call(deps(), 'PATCH', `/api/members/${primaryId}`, authed(primary, { body: { role: 'admin' } }))).statusCode).toBe(409);
    expect((await inviteRow(primaryInvite)).revoked).toBe(false);
    expect(await orgApiStatus(primaryKey.key)).toBe(200);
  });

  it('M2 초대자가 (앱을 거치지 않고) owner 가 아니게 되면 — 수락 NULL · claim 401 · 대기 메일 obsolete(org_not_sendable) · 새 초대 INSERT AT403', async () => {
    const org = await orgOf(freshEmail('m2db-primary'));
    const primary = await login(deps(), mailer, org);
    const coEmail = freshEmail('m2db-co');
    const co = await acceptInvite(org, primary, coEmail, 'admin');
    const coId = await userIdOf(coEmail);
    expect((await call(deps(), 'PATCH', `/api/members/${coId}`, authed(primary, { body: { role: 'owner' } }))).statusCode).toBe(200);

    const sentInvite = await invite(co, freshEmail('m2db-sent'));
    const mail = (await drainInviteMail([sentInvite])).sent[0];
    if (mail === undefined) throw new Error('초대 메일이 나가지 않았다');
    const unsentInvite = await invite(co, freshEmail('m2db-unsent'));
    // 운영자 셸 경로(소유자 롤 — 앱의 거두기를 거치지 않는다).
    await owner.query(`UPDATE memberships SET role = 'admin' WHERE user_id = $1 AND organization_id = $2 AND removed_at IS NULL`, [coId, org.id]);

    const claimed = await call(deps(), 'POST', '/api/invites/claim', { body: { token: inviteTokenFromMail(mail) } });
    expect(claimed.statusCode).toBe(401);
    expect((claimed.json() as { error: string }).error).toBe('invite_invalid');
    const invitee = await owner.query<{ user_id: string }>('SELECT user_id FROM org_invites WHERE id = $1', [sentInvite]);
    const accepted = await admin.query<{ membership_id: string | null }>('SELECT membership_id FROM accept_org_invite($1, $2, now())', [
      sentInvite,
      invitee.rows[0]?.user_id,
    ]);
    expect(accepted.rows[0]?.membership_id).toBeNull();
    const link = await admin
      .query(
        `INSERT INTO owner_login_links (organization_id, user_id, invite_id, browser_binding, client_key, expires_at, next_attempt_at)
         VALUES ($1, $2, $3, $4, $4, date_trunc('milliseconds', now() + interval '10 minutes'), now())`,
        [org.id, invitee.rows[0]?.user_id, sentInvite, 'b'.repeat(64)],
      )
      .then(
        () => 'inserted',
        (error: { message?: string }) => error.message ?? '',
      );
    expect(link).toMatch(/does not match a pending invite/);
    const drained = await drainInviteMail([unsentInvite]);
    expect(drained.sent).toEqual([]);
    expect(await inviteRow(unsentInvite)).toEqual({ revoked: false, status: 'obsolete', last_error: 'org_not_sendable' });
    const direct = await admin
      .query(
        `INSERT INTO org_invites (organization_id, user_id, role, invited_by_user_id, expires_at, next_attempt_at)
         VALUES ($1, $2, 'member', $3, date_trunc('milliseconds', now() + interval '1 day'), now())`,
        [org.id, invitee.rows[0]?.user_id, coId],
      )
      .then(
        () => null,
        (error: { code?: string; message?: string }) => [error.code, error.message],
      );
    expect(direct).toEqual(['AT403', 'inviter_not_owner']);
  });

  // -------------------------------------------------------------------------
  // M3 · L3 — 동결·검토 전 조직
  // -------------------------------------------------------------------------

  it('M3 동결(abuse_freeze) 조직은 초대 403(앱) · AT403(DB) · 초대 뒤 동결되면 발송 obsolete · claim 401 · 초대 링크 INSERT 거부 · 수락 NULL', async () => {
    const org = await orgOf(freshEmail('m3-owner'));
    const session = await login(deps(), mailer, org);
    const ownerId = await userIdOf(org.ownerEmail);

    await owner.query('UPDATE organizations SET abuse_freeze = true WHERE id = $1', [org.id]);
    const frozen = await call(deps(), 'POST', '/api/members/invites', authed(session, { body: { email: freshEmail('m3-a'), role: 'member' } }));
    expect(frozen.statusCode).toBe(403);
    expect((frozen.json() as { error: string }).error).toBe('org_not_active');
    const targetEmail = freshEmail('m3-db');
    await owner.query('INSERT INTO users (email) VALUES ($1)', [targetEmail]);
    const direct = await admin
      .query(
        `INSERT INTO org_invites (organization_id, user_id, role, invited_by_user_id, expires_at, next_attempt_at)
         VALUES ($1, $2, 'member', $3, date_trunc('milliseconds', now() + interval '1 day'), now())`,
        [org.id, await userIdOf(targetEmail), ownerId],
      )
      .then(
        () => null,
        (error: { code?: string; message?: string }) => [error.code, error.message],
      );
    expect(direct).toEqual(['AT403', 'org_not_active']);

    // 활성일 때 초대 둘(하나는 메일까지) → 동결.
    await owner.query('UPDATE organizations SET abuse_freeze = false WHERE id = $1', [org.id]);
    const sentEmail = freshEmail('m3-sent');
    const sentInvite = await invite(session, sentEmail);
    const mail = (await drainInviteMail([sentInvite])).sent[0];
    if (mail === undefined) throw new Error('초대 메일이 나가지 않았다');
    const unsentInvite = await invite(session, freshEmail('m3-unsent'));
    await owner.query('UPDATE organizations SET abuse_freeze = true WHERE id = $1', [org.id]);

    const drained = await drainInviteMail([unsentInvite]);
    expect(drained.sent).toEqual([]);
    expect(await inviteRow(unsentInvite)).toEqual({ revoked: false, status: 'obsolete', last_error: 'org_not_sendable' });
    const claimed = await call(deps(), 'POST', '/api/invites/claim', { body: { token: inviteTokenFromMail(mail) } });
    expect(claimed.statusCode).toBe(401);
    const sentUser = await userIdOf(sentEmail);
    const link = await admin
      .query(
        `INSERT INTO owner_login_links (organization_id, user_id, invite_id, browser_binding, client_key, expires_at, next_attempt_at)
         VALUES ($1, $2, $3, $4, $4, date_trunc('milliseconds', now() + interval '10 minutes'), now())`,
        [org.id, sentUser, sentInvite, 'a'.repeat(64)],
      )
      .then(
        () => 'inserted',
        (error: { message?: string }) => error.message ?? '',
      );
    expect(link).toMatch(/does not match a pending invite/);
    const accepted = await admin.query<{ membership_id: string | null }>('SELECT membership_id FROM accept_org_invite($1, $2, now())', [sentInvite, sentUser]);
    expect(accepted.rows[0]?.membership_id).toBeNull();

    // 동결을 풀면 같은 초대가 다시 수락된다(초대 자체는 대기 중이다).
    await owner.query('UPDATE organizations SET abuse_freeze = false WHERE id = $1', [org.id]);
    const later = await admin.query<{ joined: boolean }>('SELECT joined FROM accept_org_invite($1, $2, now())', [sentInvite, sentUser]);
    expect(later.rows[0]?.joined).toBe(true);
  });

  it('M3 검토 전(pending_review)으로 돌아간 조직의 대기 초대 메일도 obsolete(org_not_sendable)', async () => {
    const org = await orgOf(freshEmail('m3p-owner'));
    const session = await login(deps(), mailer, org);
    const pending = await invite(session, freshEmail('m3p'));
    await owner.query(`UPDATE organizations SET review_status = 'pending_review' WHERE id = $1`, [org.id]);
    expect((await drainInviteMail([pending])).sent).toEqual([]);
    expect(await inviteRow(pending)).toEqual({ revoked: false, status: 'obsolete', last_error: 'org_not_sendable' });
  });

  // -------------------------------------------------------------------------
  // L2 — 주소당 상한은 보낸 메일로(조직 무관) · 조직 안 상한은 따로
  // -------------------------------------------------------------------------

  it(`L2 같은 주소 — 조직 넷의 초대는 모두 만들어지고 메일은 ${String(INVITE_MAILS_PER_RECIPIENT_PER_DAY)}통까지(넷째 recipient_cap) · 한 조직 안에서는 하루 ${String(INVITES_PER_USER_PER_DAY)}`, async () => {
    const target = freshEmail('l2-target');
    const invites: string[] = [];
    for (let i = 0; i < INVITE_MAILS_PER_RECIPIENT_PER_DAY + 1; i += 1) {
      const org = await orgOf(freshEmail(`l2-owner${String(i)}`));
      invites.push(await invite(await login(deps(), mailer, org), target));
    }
    const sent: SentMail[] = [];
    for (const id of invites) sent.push(...(await drainInviteMail([id])).sent);
    expect(sent).toHaveLength(INVITE_MAILS_PER_RECIPIENT_PER_DAY);
    const last = invites.at(-1) ?? '';
    const lastRow = await owner.query('SELECT status::text AS status, last_error FROM org_invites WHERE id = $1', [last]);
    expect(lastRow.rows).toEqual([{ status: 'undeliverable', last_error: 'recipient_cap' }]);

    // 만들어지기만 한(보내지 않은) 초대는 세지 않는다 — 다른 주소, 동결 조직의 초대 행 넷이 있어도 첫 메일은 나간다.
    const victim = freshEmail('l2-victim');
    for (let i = 0; i < INVITE_MAILS_PER_RECIPIENT_PER_DAY + 1; i += 1) {
      const org = await orgOf(freshEmail(`l2-spam${String(i)}`));
      const id = await invite(await login(deps(), mailer, org), victim);
      await owner.query('UPDATE organizations SET abuse_freeze = true WHERE id = $1', [org.id]);
      expect((await drainInviteMail([id])).sent).toEqual([]);
    }
    const legit = await orgOf(freshEmail('l2-legit'));
    const legitInvite = await invite(await login(deps(), mailer, legit), victim);
    expect((await drainInviteMail([legitInvite])).sent).toHaveLength(1);

    // 한 조직 안 — 초대·취소를 되풀이해도 같은 주소 하루 3.
    const churn = await orgOf(freshEmail('l2-churn'));
    const churnOwner = await login(deps(), mailer, churn);
    const churned = freshEmail('l2-churned');
    for (let i = 0; i < INVITES_PER_USER_PER_DAY; i += 1) {
      const id = await invite(churnOwner, churned);
      expect((await call(deps(), 'POST', `/api/members/invites/${id}/revoke`, authed(churnOwner))).statusCode).toBe(200);
    }
    const over = await call(deps(), 'POST', '/api/members/invites', authed(churnOwner, { body: { email: churned, role: 'member' } }));
    expect(over.statusCode).toBe(409);
    expect((over.json() as { error: string }).error).toBe('invite_limit');
  });

  // -------------------------------------------------------------------------
  // L6 — 전환·새 조직 속도
  // -------------------------------------------------------------------------

  it(`L6 조직 전환·새 조직 — 사용자당 10분 ${String(SESSION_SWITCHES_PER_USER)}회 뒤 429 rate_limited(세션은 그대로)`, async () => {
    const email = freshEmail('l6');
    const first = await orgOf(email);
    const second = await orgOf(email);
    let session = await login(deps(), mailer, first);
    for (let i = 0; i < SESSION_SWITCHES_PER_USER; i += 1) {
      const target = i % 2 === 0 ? second.id : first.id;
      const switched = await call(deps(), 'POST', '/api/session/org', authed(session, { body: { organizationId: target } }));
      expect(switched.statusCode, `switch ${String(i)}`).toBe(200);
      const token = cookieValue(switched, SESSION_COOKIE) ?? '';
      session = { cookies: { [SESSION_COOKIE]: token }, csrf: (switched.json() as { csrf: string }).csrf, token };
    }
    // 마지막(29번째) 전환은 first 로 갔다 — 다른 조직(second)으로.
    const limited = await call(deps(), 'POST', '/api/session/org', authed(session, { body: { organizationId: second.id } }));
    expect(limited.statusCode).toBe(429);
    expect((limited.json() as { error: string }).error).toBe('rate_limited');
    const create = await call(deps(), 'POST', '/api/organizations', authed(session, { body: { name: '속도 팀' } }));
    expect(create.statusCode).toBe(429);
    expect((create.json() as { error: string }).error).toBe('rate_limited');
    // 같은 조직(no-op)은 세지 않고 막지도 않는다 · 거부된 요청은 세션을 건드리지 않았다.
    const here = (await call(deps(), 'GET', '/api/me', { cookies: session.cookies })).json() as { organization: { id: string } };
    expect((await call(deps(), 'POST', '/api/session/org', authed(session, { body: { organizationId: here.organization.id } }))).statusCode).toBe(200);
  });
});
