/**
 * src/admin/ops/members.ts — 멤버·초대 연산 (확장성 P1 R-1, 계획 §3.3 · 창업자 결정 F-1·F-2·F-5).
 *
 * 인가는 호출 전에 끝났다(라우트 표의 역할 — 관리 = owner, 목록·나가기 = member). 여기서는 **세션의 조직만** 본다: 대상 사용자·초대는
 * 언제나 `session.organizationId` 조건으로 고르고, 다른 조직의 것은 "없음"(404)과 구별하지 않는다.
 *
 * DB 가 마지막 층이다 — 마지막 owner · 주 소유자(`organizations.owner_email`) 보호 · 조직당 천장 50 · active 조직만 초대 · 대기 초대 10 ·
 * 수락은 `accept_org_invite` 만(202609250100·0120 트리거·함수). 이 파일의 앱 상한(멤버 5 · 하루 초대)은 그 **안쪽**이다. DB 가 `AT409 <코드>`
 * 로 거부하면 같은 코드의 409 로 바꾼다(`membershipConflict`).
 *
 * 모든 변경은 행위 + 감사(`owner_actions`, 대상 = 사용자 id 또는 초대 id) + 상세(`membership_events`)가 한 트랜잭션이다 — 감사는
 * 투명성 로그 `owner.action` 잎이 된다(주소는 잎에 가지 않는다).
 */

import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../../db/client';
import { ProvisioningError, resolveOwnerEmail } from '../../identity/provisioning';
import { INVITE_TTL_MS } from '../../security/invite-token';
import { isMemberRole, recordOwnerAction, type MemberRole, type OwnerSession } from '../context';
import { conflictCodeOf, FORBIDDEN_SQLSTATE, isMailIdentityConflict, lockUserSessions, recordMembershipEvent } from '../session';
import { AdminInputError, notFound, sqlStateOf, UUID_PATTERN } from './errors';

/** 조직당 멤버 앱 상한(창업자 결정 F-5 — 요금 연구 team 등급 초안, 뒤에 `org_entitlements.max_members`). DB 절대 천장은 50. */
const MAX_MEMBERS_PER_ORGANIZATION = 5;
/** 조직당 대기 초대 — DB 가드(`org_invites_guard`)와 같은 값. */
const MAX_PENDING_INVITES = 10;
/** 조직당 하루 초대 수(취소한 것 포함 — 취소·재초대 반복으로 메일을 흩뿌리지 못하게). */
const INVITES_PER_ORGANIZATION_PER_DAY = 20;
/**
 * 한 조직이 같은 사람(주소)에게 하루 초대 수(취소한 것 포함). **조직을 넘는** 주소당 상한은 여기서 세지 않는다(적대적 검토 L2) — 만들어진 초대
 * (보내지 않은 것·동결 조직의 것 포함)로 세면 다른 조직이 한 주소를 하루 잠글 수 있었다. 조직 무관 상한은 **실제로 보낸** 초대 메일로 세고
 * 발송 워커가 건다(`notify/invite-notifier.ts` `INVITE_MAILS_PER_RECIPIENT_PER_DAY`).
 */
export const INVITES_PER_USER_PER_DAY = 3;

interface MemberView {
  readonly userId: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly joinedAt: string;
  /** 주 소유자(`organizations.owner_email`) — 승인 알림 수신자. 강등·제거할 수 없다. */
  readonly primary: boolean;
  /** 요청한 사람 자신. */
  readonly you: boolean;
}

type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

interface InviteView {
  readonly id: string;
  /** 초대받은 주소. 주소가 지워졌으면(ADR-0010 L7 — 초대가 끝나고 30일, 멤버가 된 적 없음) `null` — 자리표시를 내보내지 않는다. */
  readonly email: string | null;
  /** 주소를 지운 사용자인가(화면은 "(지워진 주소)"). */
  readonly erased: boolean;
  readonly role: 'admin' | 'member';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: InviteStatus;
}

interface MembersListing {
  readonly members: MemberView[];
  readonly invites: InviteView[];
  readonly limits: { readonly maxMembers: number; readonly pendingInvites: number; readonly maxPendingInvites: number };
}

interface InviteRow {
  id: string;
  email: string | null;
  erased: boolean;
  role: 'admin' | 'member';
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

function inviteView(row: InviteRow, now: Date): InviteView {
  const status: InviteStatus =
    row.accepted_at !== null ? 'accepted' : row.revoked_at !== null ? 'revoked' : row.expires_at.getTime() <= now.getTime() ? 'expired' : 'pending';
  return {
    id: row.id,
    email: row.email,
    erased: row.erased,
    role: row.role,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    status,
  };
}

const INVITE_COLUMNS =
  `i.id, CASE WHEN u.erased_at IS NULL THEN u.email END AS email, u.erased_at IS NOT NULL AS erased, i.role, i.created_at, i.expires_at, i.accepted_at, i.revoked_at`;

/** DB 가드의 `AT409 <코드>`·`AT403 org_not_active` → 같은 코드의 응답 예외. 모르는 예외는 그대로. */
function membershipConflict(error: unknown): unknown {
  const conflict = conflictCodeOf(error);
  if (conflict !== null) return new AdminInputError(CONFLICT_DETAILS[conflict] ?? '지금 상태에서는 할 수 없다.', conflict, 409);
  if (sqlStateOf(error) === FORBIDDEN_SQLSTATE) {
    // DB 가드(202609250180): 초대자가 그 사이 owner 가 아니게 됐다(강등·제거와의 경합) — 라우트 표의 역할 거부와 같은 403.
    if ((error as { message?: unknown }).message === 'inviter_not_owner') return new AdminInputError('owner 만 초대할 수 있다.', 'forbidden_role', 403);
    return new AdminInputError(ORG_NOT_ACTIVE_DETAIL, 'org_not_active', 403);
  }
  return error;
}

const ORG_NOT_ACTIVE_DETAIL = '운영자 검토가 끝난(active) 조직만 멤버를 초대할 수 있다 — 플랫폼 동결(abuse_freeze) 중인 조직도 초대할 수 없다.';

const CONFLICT_DETAILS: Readonly<Record<string, string>> = {
  last_owner: '조직에는 owner 가 한 명 이상 있어야 한다.',
  primary_owner: '주 소유자(승인 알림을 받는 주소)는 강등하거나 내보낼 수 없다.',
  member_limit: `조직당 멤버는 ${String(MAX_MEMBERS_PER_ORGANIZATION)}명까지다(대기 중인 초대 포함).`,
  invite_pending: '이 주소에 대기 중인 초대가 이미 있다.',
  invite_limit: '초대 상한에 닿았다 — 대기 초대를 정리하거나 내일 다시 시도하라.',
  // DB 가드 `org_invites_invitee_live`(202609250220) — 그 주소의 사용자 행이 막 지워졌다(보존 과제와 엇갈림). 다시 보내면 새 사용자 행이다.
  invitee_erased: '이 주소의 이전 기록을 방금 정리했다 — 다시 초대하라.',
};

async function withMembershipTransaction<T>(pool: Pool, run: (client: Queryable) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(pool, run);
  } catch (error) {
    throw membershipConflict(error);
  }
}

/** `GET /api/members` — 살아 있는 멤버(가입 순) · 최근 30일 초대(최신 순, 50개) · 상한. */
export async function listMembersOp(db: Queryable, session: OwnerSession, now: Date): Promise<MembersListing> {
  const members = await db.query<{ user_id: string; email: string; role: MemberRole; created_at: Date; primary: boolean }>(
    `SELECT m.user_id, u.email, m.role, m.created_at, (u.email = o.owner_email) IS TRUE AS primary
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       JOIN organizations o ON o.id = m.organization_id
      WHERE m.organization_id = $1 AND m.removed_at IS NULL
      ORDER BY m.created_at, m.id`,
    [session.organizationId],
  );
  const invites = await db.query<InviteRow>(
    `SELECT ${INVITE_COLUMNS}
       FROM org_invites i JOIN users u ON u.id = i.user_id
      WHERE i.organization_id = $1 AND i.created_at > now() - interval '30 days'
      ORDER BY i.created_at DESC, i.id
      LIMIT 50`,
    [session.organizationId],
  );
  const views = invites.rows.map((row) => inviteView(row, now));
  return {
    members: members.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      role: row.role,
      joinedAt: row.created_at.toISOString(),
      primary: row.primary,
      you: row.user_id === session.userId,
    })),
    invites: views,
    limits: {
      maxMembers: MAX_MEMBERS_PER_ORGANIZATION,
      pendingInvites: views.filter((invite) => invite.status === 'pending').length,
      maxPendingInvites: MAX_PENDING_INVITES,
    },
  };
}

/**
 * 초대 주소가 에이전트 주소이거나 에이전트 전용 도메인에 있다(P0A01 — 사용자 INSERT 또는 초대 INSERT 의 claim 트리거, ADR-0014 · 202609291110) →
 * **다른 잘못된 초대 주소와 같은** 400 `invalid_email`(재리뷰 L6 — 어떤 주소가 에이전트 주소인지 초대로 캐 보지 못하게). 그 밖의 오류는 그대로.
 */
function rejectAgentAddress(error: unknown): never {
  if (isMailIdentityConflict(error)) {
    throw new AdminInputError('이메일 주소 모양이 아니다.', 'invalid_email');
  }
  throw error;
}

function inviteRole(raw: unknown): 'admin' | 'member' {
  if (raw !== 'admin' && raw !== 'member') throw new AdminInputError("role 은 'admin' | 'member' 다.", 'invalid_role');
  return raw;
}

/**
 * `POST /api/members/invites {email, role}` — 초대 행(= 메일 outbox) 하나 + 감사 `member.invite`(대상 = 초대 id). 메일은 여기서 보내지
 * 않는다(로그인 메일 Lambda). 순서: 모양(400) → active·미동결 조직(403, 적대적 검토 M3) → 조직 잠금 → 사용자 upsert → 이미 멤버(409) → 대기 초대(409) →
 * 멤버 + 대기 ≥ 5(409 `member_limit`) → 하루 상한(409 `invite_limit`) → INSERT(DB 가 active·대기 10·중복을 한 번 더).
 */
export async function inviteMemberOp(pool: Pool, session: OwnerSession, input: { readonly email: unknown; readonly role: unknown }): Promise<InviteView> {
  if (typeof input.email !== 'string') throw new AdminInputError('email 은 문자열이다.', 'invalid_email');
  let email: string;
  try {
    email = resolveOwnerEmail(input.email);
  } catch (error) {
    if (error instanceof ProvisioningError) throw new AdminInputError('이메일 주소 모양이 아니다.', 'invalid_email');
    throw error;
  }
  // 지운 주소의 자리표시 도메인(202609250220) — DB 가드 `users_erasure_guard` 도 이 도메인 INSERT 를 거부한다(여기서 400 으로 먼저).
  if (email.endsWith('@erased.invalid')) throw new AdminInputError('이메일 주소 모양이 아니다.', 'invalid_email');
  const role = inviteRole(input.role);
  return withMembershipTransaction(pool, async (client) => {
    const org = await client.query<{ review_status: string; abuse_freeze: boolean }>(
      'SELECT review_status::text AS review_status, abuse_freeze FROM organizations WHERE id = $1',
      [session.organizationId],
    );
    if (org.rows[0]?.review_status !== 'active' || org.rows[0].abuse_freeze) throw new AdminInputError(ORG_NOT_ACTIVE_DETAIL, 'org_not_active', 403);
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('org_invites:' || $1::text, 0))`, [session.organizationId]);
    await client.query('INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [email]).catch(rejectAgentAddress);
    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    const userId = user.rows[0]?.id;
    if (userId === undefined) throw new Error('users upsert 가 행을 남기지 않았다');
    const state = await client.query<{ member: boolean; pending_for_user: boolean; live: number; pending: number; org_today: number; user_today: number }>(
      `SELECT EXISTS (SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2 AND removed_at IS NULL) AS member,
              EXISTS (SELECT 1 FROM org_invites WHERE organization_id = $1 AND user_id = $2
                        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS pending_for_user,
              (SELECT count(*)::int FROM memberships WHERE organization_id = $1 AND removed_at IS NULL) AS live,
              (SELECT count(*)::int FROM org_invites WHERE organization_id = $1
                  AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS pending,
              (SELECT count(*)::int FROM org_invites WHERE organization_id = $1 AND created_at > now() - interval '1 day') AS org_today,
              (SELECT count(*)::int FROM org_invites WHERE organization_id = $1 AND user_id = $2 AND created_at > now() - interval '1 day') AS user_today`,
      [session.organizationId, userId],
    );
    const counts = state.rows[0];
    if (counts === undefined) throw new Error('초대 상태를 읽지 못했다');
    if (counts.member) throw new AdminInputError('이미 이 조직의 멤버다.', 'already_member', 409);
    if (counts.pending_for_user) throw new AdminInputError(CONFLICT_DETAILS['invite_pending'] ?? '', 'invite_pending', 409);
    if (counts.live + counts.pending >= MAX_MEMBERS_PER_ORGANIZATION) {
      throw new AdminInputError(CONFLICT_DETAILS['member_limit'] ?? '', 'member_limit', 409);
    }
    if (counts.pending >= MAX_PENDING_INVITES || counts.org_today >= INVITES_PER_ORGANIZATION_PER_DAY || counts.user_today >= INVITES_PER_USER_PER_DAY) {
      throw new AdminInputError(CONFLICT_DETAILS['invite_limit'] ?? '', 'invite_limit', 409);
    }
    const inserted = await client.query<{ id: string; created_at: Date; expires_at: Date }>(
      `INSERT INTO org_invites (organization_id, user_id, role, invited_by_user_id, expires_at, next_attempt_at)
       VALUES ($1, $2, $3, $4, date_trunc('milliseconds', now() + make_interval(secs => $5)), date_trunc('milliseconds', now()))
       RETURNING id, created_at, expires_at`,
      [session.organizationId, userId, role, session.userId, INVITE_TTL_MS / 1000],
    ).catch(rejectAgentAddress);
    const row = inserted.rows[0];
    if (row === undefined) throw new Error('org_invites INSERT 가 행을 돌려주지 않았다');
    await recordOwnerAction(client, session, 'member.invite', row.id);
    return { id: row.id, email, erased: false, role, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), status: 'pending' };
  });
}

/** `POST /api/members/invites/{id}/revoke` — 대기 중인 초대만. 아직 안 보낸 메일은 DB 가드가 `obsolete` 로 닫는다. 감사 `member.invite_revoke`. */
export async function revokeInviteOp(pool: Pool, session: OwnerSession, raw: unknown, now: Date): Promise<InviteView> {
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) throw notFound('초대가 없다.', 'invite_not_found');
  return withMembershipTransaction(pool, async (client) => {
    const updated = await client.query<{ id: string }>(
      `UPDATE org_invites SET revoked_at = now()
        WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
      [raw, session.organizationId],
    );
    if (updated.rows[0] === undefined) {
      const exists = await client.query('SELECT 1 FROM org_invites WHERE id = $1 AND organization_id = $2', [raw, session.organizationId]);
      if (exists.rowCount === 0) throw notFound('초대가 없다.', 'invite_not_found');
      throw new AdminInputError('이미 수락했거나 취소한 초대다.', 'invite_not_pending', 409);
    }
    await recordOwnerAction(client, session, 'member.invite_revoke', raw);
    const row = await client.query<InviteRow>(`SELECT ${INVITE_COLUMNS} FROM org_invites i JOIN users u ON u.id = i.user_id WHERE i.id = $1`, [raw]);
    const invite = row.rows[0];
    if (invite === undefined) throw new Error('취소한 초대를 다시 읽지 못했다');
    return inviteView(invite, now);
  });
}

interface LiveMember {
  id: string;
  role: MemberRole;
  email: string;
  created_at: Date;
  primary: boolean;
}

async function lockLiveMember(client: Queryable, organizationId: string, userId: string): Promise<LiveMember | null> {
  const found = await client.query<LiveMember>(
    `SELECT m.id, m.role, u.email, m.created_at, (u.email = o.owner_email) IS TRUE AS primary
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       JOIN organizations o ON o.id = m.organization_id
      WHERE m.organization_id = $1 AND m.user_id = $2 AND m.removed_at IS NULL
      FOR UPDATE OF m`,
    [organizationId, userId],
  );
  return found.rows[0] ?? null;
}

function targetUser(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) throw notFound('멤버가 없다.', 'member_not_found');
  return raw;
}

/**
 * owner 가 owner 가 아니게 될 때(강등·제거·나가기) 그 사람이 **이 조직에서** 남긴 권한을 같은 트랜잭션에서 거둔다(적대적 검토 M2):
 *   - 그 사람이 보낸 대기 초대 → 취소(감사 `member.invite_revoke`, 대상 = 초대 id). 아직 안 보낸 메일은 DB 가드가 `obsolete` 로 닫는다.
 *   - 그 사람이 발급한 활성 조직 API 키 → 폐기(감사 `org_key.revoke`, 대상 = 키 id). CI 는 바로 401.
 * 감사 행위자는 이 변경을 한 세션이다. **멤버십 UPDATE 보다 먼저** 부른다 — 초대 행 잠금 → 조직 멤버십 잠금 순서가 `accept_org_invite` 와
 * 같아야 교착이 없다. DB 도 막는다(202609250180): 초대자가 살아 있는 owner 가 아니면 수락·초대 링크·발송이 모두 거부된다.
 */
async function revokeGrantsOf(client: Queryable, session: OwnerSession, userId: string): Promise<void> {
  const invites = await client.query<{ id: string }>(
    `UPDATE org_invites SET revoked_at = now()
      WHERE organization_id = $1 AND invited_by_user_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
      RETURNING id`,
    [session.organizationId, userId],
  );
  for (const invite of invites.rows) await recordOwnerAction(client, session, 'member.invite_revoke', invite.id);
  const keys = await client.query<{ id: string }>(
    `UPDATE org_api_keys SET revoked_at = now()
      WHERE organization_id = $1 AND created_by_user_id = $2 AND revoked_at IS NULL
      RETURNING id::text AS id`,
    [session.organizationId, userId],
  );
  for (const key of keys.rows) await recordOwnerAction(client, session, 'org_key.revoke', key.id);
}

/**
 * `PATCH /api/members/{userId} {role}` — 역할 바꾸기(owner·admin·member). 같은 역할이면 아무것도 하지 않는다(감사 없음). 마지막 owner ·
 * 주 소유자는 DB 가 409 로 막는다. 역할은 세션에 캐시되지 않으므로 그 사람의 다음 요청부터 효력이다. 감사 `member.role` + 전·후.
 */
export async function changeMemberRoleOp(pool: Pool, session: OwnerSession, rawUserId: unknown, rawRole: unknown): Promise<{ member: MemberView; changed: boolean }> {
  const userId = targetUser(rawUserId);
  if (!isMemberRole(rawRole)) throw new AdminInputError("role 은 'owner' | 'admin' | 'member' 다.", 'invalid_role');
  const role = rawRole;
  return withMembershipTransaction(pool, async (client) => {
    const member = await lockLiveMember(client, session.organizationId, userId);
    if (member === null) throw notFound('멤버가 없다.', 'member_not_found');
    const view = (next: MemberRole): MemberView => ({
      userId,
      email: member.email,
      role: next,
      joinedAt: member.created_at.toISOString(),
      primary: member.primary,
      you: userId === session.userId,
    });
    if (member.role === role) return { member: view(role), changed: false };
    if (member.role === 'owner') await revokeGrantsOf(client, session, userId);
    await client.query('UPDATE memberships SET role = $2 WHERE id = $1', [member.id, role]);
    await recordMembershipEvent(client, session, 'member.role', { membershipId: member.id, userId, oldRole: member.role, newRole: role });
    return { member: view(role), changed: true };
  });
}

/**
 * 멤버십 제거 + 그 사용자의 **이 조직** 세션 폐기(같은 트랜잭션). 세션은 조인으로도 이미 무효지만 행에도 적는다. 그 사용자의 세션 잠금을
 * 먼저 잡는다(M1 — 동시에 이 조직으로 전환해 들어오는 자식 세션이 폐기 문장을 비껴가지 않게). owner 였으면 초대·조직 키도 거둔다(M2).
 */
async function removeMembership(client: Queryable, session: OwnerSession, userId: string, action: 'member.remove' | 'member.leave'): Promise<void> {
  await lockUserSessions(client, userId);
  const member = await lockLiveMember(client, session.organizationId, userId);
  if (member === null) throw notFound('멤버가 없다.', 'member_not_found');
  if (member.role === 'owner') await revokeGrantsOf(client, session, userId);
  await client.query('UPDATE memberships SET removed_at = now() WHERE id = $1', [member.id]);
  await client.query('UPDATE owner_sessions SET revoked_at = now() WHERE user_id = $1 AND organization_id = $2 AND revoked_at IS NULL', [
    userId,
    session.organizationId,
  ]);
  await recordMembershipEvent(client, session, action, { membershipId: member.id, userId, oldRole: member.role, newRole: null });
}

/** `DELETE /api/members/{userId}` — 다른 멤버 내보내기. 자기 자신은 `leave` 로(400 `cannot_remove_self`). 감사 `member.remove`. */
export async function removeMemberOp(pool: Pool, session: OwnerSession, rawUserId: unknown): Promise<void> {
  const userId = targetUser(rawUserId);
  if (userId === session.userId) throw new AdminInputError('자기 자신은 내보낼 수 없다 — 조직 나가기를 써라.', 'cannot_remove_self');
  await withMembershipTransaction(pool, (client) => removeMembership(client, session, userId, 'member.remove'));
}

/** `POST /api/members/leave` — 이 조직에서 나간다(이 조직의 내 세션 전부 폐기). 마지막 owner · 주 소유자는 409. 감사 `member.leave`. */
export async function leaveOrganizationOp(pool: Pool, session: OwnerSession): Promise<void> {
  await withMembershipTransaction(pool, (client) => removeMembership(client, session, session.userId, 'member.leave'));
}
