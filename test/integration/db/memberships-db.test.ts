/**
 * **사용자·멤버십·세션 결속·초대 DB 표면**(202609250100·0110·0120) — 실제 Postgres, 운영과 같은 롤(`atmark_admin` · `atmark_app` ·
 * `atmark_login_mailer`)로. 지반만 소유자 롤.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 조직 INSERT → owner 멤버십(org_create) · owner_email 이동 → 새 주 소유자 owner · 옛 주 소유자 제거(L5) · 백필 불변식(owner_email ⇒ owner 멤버십)
 *   - 멤버십 가드(admin 롤): 주 소유자 강등·제거 · 마지막 owner · 제거 1회·제거 뒤 역할 불변 · 불변 핵심 · DELETE 거부 · 천장 50 · INSERT 권한 0
 *   - 세션 가드: 멤버 아닌 조직 세션 거부 · 전환은 살아 있는 부모 · 같은 사용자 · 연장 불가 · 부모당 자식 하나 · 세 출처 중 정확히 하나
 *   - user_id 결속 contract(202609250190): 세션·로그인 링크 INSERT 는 user_id 를 반드시 적는다(CHECK, 새 행만) — 옛 자동 채움 트리거는 걷혔다
 *   - 초대: active 조직만 · 대기 10 · 같은 사람 대기 1 · 수락은 함수로만(수신자 일치 · 만료 · 멤버 상한 5) · 취소/수락 1회 · 끝난 초대 메일 obsolete ·
 *     초대 링크는 초대받은 사람·그 조직에만
 *   - 새 조직 함수: 죽은 세션 거부 · owner 5 · 하루 2
 *   - 앱 롤은 새 테이블·함수에 권한 0 · 로그인 메일 롤은 memberships·org_invites 역할 칸을 못 읽는다
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOrganizationOp } from '../../../src/admin/ops/agents';
import { adminRolePool, appPool, AVAILABLE, loginMailerPool, ownerPool, suffix } from '../admin/support';
import { rejects } from './support/harness';

describe.skipIf(!AVAILABLE)('사용자·멤버십·세션 결속·초대 DB', () => {
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
    await Promise.all([owner.end(), admin.end(), app.end(), mailer.end()]);
  });

  const email = (tag: string): string => `${tag}-${suffix()}${suffix()}@example.com`;

  async function org(ownerEmail: string): Promise<string> {
    return (await createOrganizationOp(owner, { name: `mdb-${suffix()}`, ownerEmail })).id;
  }

  async function userId(address: string): Promise<string> {
    const row = await owner.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [address]);
    const id = row.rows[0]?.id;
    if (id === undefined) throw new Error(address);
    return id;
  }

  async function membership(organizationId: string, address: string): Promise<{ id: string; role: string; removed: boolean }[]> {
    const rows = await owner.query<{ id: string; role: string; removed: boolean }>(
      `SELECT m.id, m.role, m.removed_at IS NOT NULL AS removed FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND u.email = $2 ORDER BY m.created_at`,
      [organizationId, address],
    );
    return rows.rows;
  }

  /** 소유자 롤로 멤버십을 직접 넣는다(지반) — 운영에서 이 경로는 없다(함수 셋만). */
  async function addMember(organizationId: string, address: string, role: 'owner' | 'admin' | 'member'): Promise<string> {
    await owner.query('INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [address]);
    const row = await owner.query<{ id: string }>(
      `INSERT INTO memberships (user_id, organization_id, role, joined_via) SELECT id, $2, $3, 'invite' FROM users WHERE email = $1 RETURNING id`,
      [address, organizationId, role],
    );
    return row.rows[0]?.id ?? '';
  }

  it('조직 INSERT → owner 멤버십 · 백필 불변식: owner_email 이 있는 모든 조직에 그 주소의 owner 멤버십', async () => {
    const address = email('trigger');
    const id = await org(address);
    expect(await membership(id, address)).toEqual([{ id: expect.any(String) as string, role: 'owner', removed: false }]);
    const orphans = await owner.query(
      `SELECT o.id FROM organizations o
        WHERE o.owner_email IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.organization_id = o.id AND u.email = o.owner_email AND m.role = 'owner' AND m.removed_at IS NULL)`,
    );
    expect(orphans.rowCount).toBe(0);
  });

  it('owner_email 이동 → 새 주소 owner(없으면 멤버십, 있으면 승격) · 옛 주 소유자 제거 · NULL 로 지우기도 된다', async () => {
    const first = email('move-a');
    const second = email('move-b');
    const id = await org(first);
    await addMember(id, second, 'member');
    await owner.query('UPDATE organizations SET owner_email = $2 WHERE id = $1', [id, second]);
    expect(await membership(id, second)).toEqual([expect.objectContaining({ role: 'owner', removed: false })]);
    expect(await membership(id, first)).toEqual([expect.objectContaining({ role: 'owner', removed: true })]);
    const third = email('move-c');
    await owner.query('UPDATE organizations SET owner_email = $2 WHERE id = $1', [id, third]);
    expect(await membership(id, third)).toEqual([expect.objectContaining({ role: 'owner', removed: false })]);
    await owner.query('UPDATE organizations SET owner_email = NULL WHERE id = $1', [id]);
    expect(await membership(id, third)).toEqual([expect.objectContaining({ removed: true })]);
  });

  it('멤버십 가드(admin 롤) — 주 소유자 · 마지막 owner · 제거 1회 · 불변 핵심 · DELETE · INSERT 권한 0', async () => {
    const primary = email('guard-primary');
    const id = await org(primary);
    const primaryMembership = (await membership(id, primary))[0]?.id ?? '';
    const demote = await rejects(admin.query(`UPDATE memberships SET role = 'admin' WHERE id = $1`, [primaryMembership]));
    expect([demote.code, demote.message]).toEqual(['AT409', 'primary_owner']);
    const remove = await rejects(admin.query('UPDATE memberships SET removed_at = now() WHERE id = $1', [primaryMembership]));
    expect([remove.code, remove.message]).toEqual(['AT409', 'primary_owner']);

    // 주 소유자가 없는 조직(owner_email NULL)의 유일한 owner — 마지막 owner.
    const lone = await org(email('guard-lone'));
    await owner.query('UPDATE organizations SET owner_email = NULL WHERE id = $1', [lone]);
    const loneOwner = email('guard-lone-owner');
    const loneId = await addMember(lone, loneOwner, 'owner');
    const last = await rejects(admin.query(`UPDATE memberships SET role = 'member' WHERE id = $1`, [loneId]));
    expect([last.code, last.message]).toEqual(['AT409', 'last_owner']);
    // 두 번째 owner 가 있으면 된다.
    const coOwner = await addMember(lone, email('guard-co'), 'owner');
    await admin.query(`UPDATE memberships SET role = 'member' WHERE id = $1`, [loneId]);
    const lastAgain = await rejects(admin.query('UPDATE memberships SET removed_at = now() WHERE id = $1', [coOwner]));
    expect(lastAgain.message).toBe('last_owner');

    // 제거 1회 · 제거 뒤 역할 불변 · 불변 핵심 · DELETE · INSERT.
    const member = await addMember(id, email('guard-member'), 'member');
    await admin.query('UPDATE memberships SET removed_at = now() WHERE id = $1', [member]);
    expect((await rejects(admin.query(`UPDATE memberships SET removed_at = now() + interval '1 day' WHERE id = $1`, [member]))).message).toMatch(/write-once/);
    expect((await rejects(admin.query(`UPDATE memberships SET role = 'admin' WHERE id = $1`, [member]))).message).toMatch(/removed/);
    expect((await rejects(admin.query('UPDATE memberships SET organization_id = $2 WHERE id = $1', [member, lone]))).message).toMatch(/permission denied/);
    expect((await rejects(owner.query('UPDATE memberships SET organization_id = $2 WHERE id = $1', [member, lone]))).message).toMatch(/immutable/);
    expect((await rejects(owner.query('DELETE FROM memberships WHERE id = $1', [member]))).message).toMatch(/append-only/);
    expect((await rejects(admin.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, 'owner', 'invite')`, [await userId(primary), lone]))).message).toMatch(/permission denied/);
  });

  it('천장 50 — 소유자 롤로도 51번째 살아 있는 멤버는 거부(AT409 member_limit)', async () => {
    const id = await org(email('ceiling'));
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (email) SELECT 'ceiling-' || $1 || '-' || g || '@example.com' FROM generate_series(1, 50) g ON CONFLICT DO NOTHING`,
        [suffix()],
      );
      const inserted = await client.query(
        `INSERT INTO memberships (user_id, organization_id, role, joined_via)
         SELECT u.id, $1, 'member', 'invite' FROM users u WHERE u.email LIKE 'ceiling-%' AND NOT EXISTS (
           SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.organization_id = $1)
         LIMIT 49`,
        [id],
      );
      expect(inserted.rowCount).toBe(49);
      const over = await rejects(
        client.query(
          `INSERT INTO memberships (user_id, organization_id, role, joined_via)
           SELECT u.id, $1, 'member', 'invite' FROM users u WHERE u.email LIKE 'ceiling-%' AND NOT EXISTS (
             SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.organization_id = $1) LIMIT 1`,
          [id],
        ),
      );
      expect([over.code, over.message]).toEqual(['AT409', 'member_limit']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('세션 가드 — 멤버 아닌 조직 · 전환: 죽은 부모·다른 사용자·연장·두 번째 자식 거부 · 출처 정확히 하나 · user_id 결속 contract(0190)', async () => {
    const address = email('sess');
    const home = await org(address);
    const away = await org(email('sess-away'));
    const user = await userId(address);
    const link = await owner.query<{ id: string; user_id: string | null }>(
      `INSERT INTO owner_login_links (organization_id, user_id, browser_binding, expires_at, next_attempt_at)
       VALUES ($1, $2, $3, date_trunc('milliseconds', now() + interval '10 minutes'), now()) RETURNING id, user_id`,
      [home, user, 'd'.repeat(64)],
    );
    expect(link.rows[0]?.user_id).toBe(user);
    const hash = (): string => `${suffix()}${suffix()}`.padEnd(64, '0');
    const parent = await admin.query<{ id: string; user_id: string }>(
      `INSERT INTO owner_sessions (organization_id, user_id, login_link_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour') RETURNING id, user_id`,
      [home, user, link.rows[0]?.id, hash()],
    );
    const parentId = parent.rows[0]?.id ?? '';
    expect(parent.rows[0]?.user_id).toBe(user);

    // 0190(contract): 옛 자동 채움 트리거는 걷혔다 — user_id 없이 INSERT 하면 두 표 다 CHECK 로 거부된다(새 행만, NOT VALID).
    const linkNoUser = await rejects(
      owner.query(
        `INSERT INTO owner_login_links (organization_id, browser_binding, expires_at, next_attempt_at)
         VALUES ($1, $2, date_trunc('milliseconds', now() + interval '10 minutes'), now())`,
        [home, 'd'.repeat(64)],
      ),
    );
    expect(linkNoUser.message).toMatch(/owner_login_links_user_required/);
    const secondLink = await owner.query<{ id: string }>(
      `INSERT INTO owner_login_links (organization_id, user_id, browser_binding, expires_at, next_attempt_at)
       VALUES ($1, $2, $3, date_trunc('milliseconds', now() + interval '10 minutes'), now()) RETURNING id`,
      [home, user, 'e'.repeat(64)],
    );
    const sessionNoUser = await rejects(
      admin.query(
        `INSERT INTO owner_sessions (organization_id, login_link_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [home, secondLink.rows[0]?.id, hash()],
      ),
    );
    expect(sessionNoUser.message).toMatch(/owner_sessions_user_required/);

    const notMember = await rejects(
      admin.query(`INSERT INTO owner_sessions (organization_id, user_id, switched_from_session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '30 minutes')`, [
        away,
        user,
        parentId,
        hash(),
      ]),
    );
    expect(notMember.message).toMatch(/not a live member/);
    await addMember(away, address, 'member');
    const extended = await rejects(
      admin.query(`INSERT INTO owner_sessions (organization_id, user_id, switched_from_session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '2 hours')`, [
        away,
        user,
        parentId,
        hash(),
      ]),
    );
    expect(extended.message).toMatch(/switch .* not allowed/);
    // 다른 사용자(그 조직의 멤버라도)는 이 부모에서 자식 세션을 못 낳는다.
    const otherAddress = email('sess-other');
    await addMember(away, otherAddress, 'member');
    const otherUser = await rejects(
      admin.query(`INSERT INTO owner_sessions (organization_id, user_id, switched_from_session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '30 minutes')`, [
        away,
        await userId(otherAddress),
        parentId,
        hash(),
      ]),
    );
    expect(otherUser.message).toMatch(/switch .* not allowed/);
    const bothSources = await rejects(
      admin.query(`INSERT INTO owner_sessions (organization_id, user_id, login_link_id, switched_from_session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '30 minutes')`, [
        away,
        user,
        link.rows[0]?.id,
        parentId,
        hash(),
      ]),
    );
    expect(bothSources.message).toMatch(/owner_sessions_one_link|duplicate key/);
    await admin.query(`INSERT INTO owner_sessions (organization_id, user_id, switched_from_session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '30 minutes')`, [
      away,
      user,
      parentId,
      hash(),
    ]);
    const secondChild = await rejects(
      admin.query(`INSERT INTO owner_sessions (organization_id, user_id, switched_from_session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '30 minutes')`, [
        home,
        user,
        parentId,
        hash(),
      ]),
    );
    expect(secondChild.code).toBe('23505');
    await admin.query('UPDATE owner_sessions SET revoked_at = now() WHERE id = $1', [parentId]);
    const deadParent = await rejects(
      admin.query(`INSERT INTO owner_sessions (organization_id, user_id, switched_from_session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '30 minutes')`, [
        home,
        user,
        parentId,
        hash(),
      ]),
    );
    expect(deadParent.code).toMatch(/23505|23514/);
  });

  it('초대 — active 조직만 · 같은 사람 대기 1 · 대기 10 · 수락은 함수로만(수신자·만료·상한 5) · 끝난 초대 메일 obsolete · 초대 링크 결속', async () => {
    const inviterEmail = email('inv-owner');
    const id = await org(inviterEmail);
    const inviter = await userId(inviterEmail);
    const newUser = async (tag: string): Promise<string> => {
      const address = email(tag);
      await owner.query('INSERT INTO users (email) VALUES ($1)', [address]);
      return userId(address);
    };
    const inviteAs = (pool: Pool, organizationId: string, user: string, ttl = '7 days'): Promise<{ rows: { id: string }[] }> =>
      pool.query<{ id: string }>(
        `INSERT INTO org_invites (organization_id, user_id, role, invited_by_user_id, expires_at, next_attempt_at)
         VALUES ($1, $2, 'member', $3, date_trunc('milliseconds', now() + $4::interval), now()) RETURNING id`,
        [organizationId, user, inviter, ttl],
      );

    const pending = await org(email('inv-pending'));
    await owner.query(`UPDATE organizations SET review_status = 'pending_review' WHERE id = $1`, [pending]);
    const notActive = await rejects(inviteAs(admin, pending, await newUser('inv-a')));
    expect([notActive.code, notActive.message]).toEqual(['AT403', 'org_not_active']);

    const invitee = await newUser('inv-b');
    const invite = (await inviteAs(admin, id, invitee)).rows[0]?.id ?? '';
    const duplicate = await rejects(inviteAs(admin, id, invitee));
    expect(duplicate.message).toBe('invite_pending');
    expect((await rejects(inviteAs(admin, id, await newUser('inv-ttl'), '8 days'))).message).toMatch(/org_invites_ttl/);

    // 수락은 함수로만 — 다른 사용자 NULL · admin 은 accepted_at UPDATE 권한이 없다.
    const stranger = await newUser('inv-stranger');
    const wrong = await admin.query<{ membership_id: string | null }>('SELECT membership_id FROM accept_org_invite($1, $2, now())', [invite, stranger]);
    expect(wrong.rows[0]?.membership_id).toBeNull();
    expect((await rejects(admin.query('UPDATE org_invites SET accepted_at = now() WHERE id = $1', [invite]))).message).toMatch(/permission denied/);
    // 초대 로그인 링크는 초대받은 사람·그 조직에만.
    const badLink = await rejects(
      admin.query(
        `INSERT INTO owner_login_links (organization_id, user_id, invite_id, browser_binding, client_key, expires_at, next_attempt_at)
         VALUES ($1, $2, $3, $4, $4, date_trunc('milliseconds', now() + interval '10 minutes'), now())`,
        [id, stranger, invite, 'e'.repeat(64)],
      ),
    );
    expect(badLink.message).toMatch(/does not match a pending invite/);
    const accepted = await admin.query<{ membership_id: string | null; joined: boolean }>('SELECT membership_id, joined FROM accept_org_invite($1, $2, now())', [
      invite,
      invitee,
    ]);
    expect(accepted.rows[0]?.joined).toBe(true);
    const again = await admin.query<{ membership_id: string | null }>('SELECT membership_id FROM accept_org_invite($1, $2, now())', [invite, invitee]);
    expect(again.rows[0]?.membership_id).toBeNull();
    const row = await owner.query('SELECT status::text, last_error FROM org_invites WHERE id = $1', [invite]);
    expect(row.rows).toEqual([{ status: 'obsolete', last_error: 'invite_accepted' }]);
    expect((await rejects(owner.query('UPDATE org_invites SET revoked_at = now() WHERE id = $1', [invite]))).message).toMatch(/org_invites_one_end/);
    expect((await rejects(owner.query('DELETE FROM org_invites WHERE id = $1', [invite]))).message).toMatch(/append-only/);

    // 멤버 상한 5 — owner + 초대 수락 4 = 5 에서 여섯째 수락은 AT409.
    for (let i = 0; i < 3; i += 1) {
      const u = await newUser(`inv-fill${String(i)}`);
      const inv = (await inviteAs(admin, id, u)).rows[0]?.id ?? '';
      await admin.query('SELECT accept_org_invite($1, $2, now())', [inv, u]);
    }
    const sixth = await newUser('inv-sixth');
    const sixthInvite = (await inviteAs(admin, id, sixth)).rows[0]?.id ?? '';
    const full = await rejects(admin.query('SELECT accept_org_invite($1, $2, now())', [sixthInvite, sixth]));
    expect([full.code, full.message]).toEqual(['AT409', 'member_limit']);

    // 대기 10 — 새 조직에서.
    const busy = await org(email('inv-busy'));
    const busyInviter = await userId((await owner.query<{ owner_email: string }>('SELECT owner_email FROM organizations WHERE id = $1', [busy])).rows[0]?.owner_email ?? '');
    for (let i = 0; i < 10; i += 1) {
      await admin.query(
        `INSERT INTO org_invites (organization_id, user_id, role, invited_by_user_id, expires_at, next_attempt_at)
         VALUES ($1, $2, 'member', $3, date_trunc('milliseconds', now() + interval '1 day'), now())`,
        [busy, await newUser(`inv-busy${String(i)}`), busyInviter],
      );
    }
    const eleventh = await rejects(
      admin.query(
        `INSERT INTO org_invites (organization_id, user_id, role, invited_by_user_id, expires_at, next_attempt_at)
         VALUES ($1, $2, 'member', $3, date_trunc('milliseconds', now() + interval '1 day'), now())`,
        [busy, await newUser('inv-busy-over'), busyInviter],
      ),
    );
    expect(eleventh.message).toBe('invite_limit');
  });

  it('create_member_organization — 죽은 세션 거부 · 이름 모양 · owner 5', async () => {
    const dead = await rejects(admin.query("SELECT create_member_organization(gen_random_uuid(), 'x')"));
    expect(dead.code).toBe('28000');
    const address = email('cmo');
    const home = await org(address);
    const user = await userId(address);
    const link = await owner.query<{ id: string }>(
      `INSERT INTO owner_login_links (organization_id, user_id, browser_binding, expires_at, next_attempt_at)
       VALUES ($1, $2, $3, date_trunc('milliseconds', now() + interval '10 minutes'), now()) RETURNING id`,
      [home, user, 'f'.repeat(64)],
    );
    const session = await owner.query<{ id: string }>(
      `INSERT INTO owner_sessions (organization_id, user_id, login_link_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour') RETURNING id`,
      [home, user, link.rows[0]?.id, `${suffix()}${suffix()}`.padEnd(64, '1')],
    );
    const sessionId = session.rows[0]?.id ?? '';
    expect((await rejects(admin.query("SELECT create_member_organization($1, ' padded ')", [sessionId]))).code).toBe('22023');
    // owner 조직 5 — 소유자 롤로 4개를 더 만든다(하루 상한은 함수만 센다 — 지반은 CLI 경로).
    for (let i = 0; i < 4; i += 1) await org(address);
    const limited = await rejects(admin.query("SELECT create_member_organization($1, '여섯째')", [sessionId]));
    expect([limited.code, limited.message]).toEqual(['AT429', 'org_limit']);
  });

  it('권한 경계 — 앱 롤은 새 테이블·함수 0 · 로그인 메일 롤은 users(id,email)·초대 발송 칸만', async () => {
    for (const sql of [
      'SELECT 1 FROM users LIMIT 1',
      'SELECT 1 FROM memberships LIMIT 1',
      'SELECT 1 FROM org_invites LIMIT 1',
      'SELECT 1 FROM membership_events LIMIT 1',
      "SELECT create_member_organization(gen_random_uuid(), 'x')",
      'SELECT accept_org_invite(gen_random_uuid(), gen_random_uuid(), now())',
    ]) {
      expect((await rejects(app.query(sql))).message, sql).toMatch(/permission denied/);
    }
    for (const sql of [
      'SELECT 1 FROM memberships LIMIT 1',
      'SELECT last_organization_id FROM users LIMIT 1',
      'SELECT role FROM org_invites LIMIT 1',
      'SELECT organization_id FROM org_invites LIMIT 1',
      'SELECT revoked_at FROM org_invites LIMIT 1',
      "INSERT INTO org_invites (organization_id) VALUES (gen_random_uuid())",
    ]) {
      expect((await rejects(mailer.query(sql))).message, sql).toMatch(/permission denied/);
    }
    await expect(mailer.query('SELECT id, email FROM users LIMIT 1')).resolves.toBeDefined();
  });
});
