/**
 * **초대만 받은 사용자 주소 지우기**(202609250220, ADR-0010 후속 L7) — 실제 Postgres, 운영과 같은 롤로. 지반은 소유자 롤.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 조건이 맞으면 주소 → `erased-<id>@erased.invalid` · `erased_at` · id 그대로(초대 행 FK·감사 대상 id 불변) · 두 번째는 false
 *   - 조건 하나라도 어긋나면 아무것도 안 바꾼다: 멤버십 이력(제거 포함) · 대기 초대 · 끝난 지 30일 미만(만료·취소) · 대기 메일 ·
 *     살아 있는 로그인 링크 · 주 소유자 주소 · 초대 없음
 *   - 적대적 검토 M1·L3: 막힌 후보(35일 전에 만들고 5일 전에 취소)가 배치 LIMIT 을 차지하지 않는다 · 잠긴 행은 기다리지 않는다(NOWAIT) ·
 *     살아 있는 가입 링크는 지우기를 미루지 못한다 · 가입 확정 advisory 잠금 중이면 건너뛴다 · 밀린 수(37일) · 가입 링크 보존(M2)
 *   - EXECUTE: `erase_invited_only_user` 는 admin·앱·로그인 메일 롤 모두 42501 · 배치는 앱 롤만(admin·메일 42501) · 앱 롤이 이르게 불러도
 *     조건이 안 맞는 행은 그대로 · 배치 크기는 함수가 자른다
 *   - 가드: 소유자도 자리표시 밖 주소로는 못 바꾼다 · 1회 · admin 은 주소 칸 권한 없음 · 자리표시 도메인 INSERT 거부 · 지운 행에 초대 INSERT 거부
 *   - 지운 뒤 같은 주소로 다시 초대하면 **새** 사용자 행 · 초대 목록은 지운 주소를 `email:null, erased:true` 로
 */

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOrganizationOp } from '../../../src/admin/ops/agents';
import { adminDeps, adminRolePool, appPool, authed, AVAILABLE, call, login, loginMailerPool, ownerPool, suffix } from '../admin/support';
import { rejects } from './support/harness';

interface UserState {
  id: string;
  email: string;
  erased_at: Date | null;
}

describe.skipIf(!AVAILABLE)('초대만 받은 사용자 주소 지우기 (ADR-0010 L7)', () => {
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

  const address = (tag: string): string => `l7-${tag}-${suffix()}${suffix()}@example.com`;

  async function org(): Promise<{ id: string; ownerEmail: string; ownerUserId: string }> {
    const ownerEmail = address('owner');
    const created = await createOrganizationOp(owner, { name: `l7-${suffix()}`, ownerEmail });
    const row = await owner.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [ownerEmail]);
    return { id: created.id, ownerEmail, ownerUserId: row.rows[0]?.id ?? '' };
  }

  async function invitee(tag: string): Promise<{ id: string; email: string }> {
    const email = address(tag);
    const row = await owner.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [email]);
    return { id: row.rows[0]?.id ?? '', email };
  }

  /** 과거에 만든 초대(소유자 롤로 created_at 을 적는다). 기본: 40일 전 · 7일 만료 · 메일 outbox 정리됨. */
  async function pastInvite(
    organization: { id: string; ownerUserId: string },
    userId: string,
    options: { createdDaysAgo?: number; settle?: boolean; revokedDaysAgo?: number; db?: Pool | PoolClient } = {},
  ): Promise<string> {
    const created = options.createdDaysAgo ?? 40;
    const db = options.db ?? owner;
    const row = await db.query<{ id: string }>(
      `INSERT INTO org_invites (organization_id, user_id, role, invited_by_user_id, created_at, expires_at, next_attempt_at)
       VALUES ($1, $2, 'member', $3, now() - make_interval(days => $4),
               date_trunc('milliseconds', now() - make_interval(days => $4) + interval '7 days'), now())
       RETURNING id`,
      [organization.id, userId, organization.ownerUserId, created],
    );
    const id = row.rows[0]?.id ?? '';
    if (options.revokedDaysAgo !== undefined) {
      await db.query('UPDATE org_invites SET revoked_at = now() - make_interval(days => $2) WHERE id = $1', [id, options.revokedDaysAgo]);
    }
    if (options.settle ?? true) {
      await db.query(
        `UPDATE org_invites SET status = 'obsolete', settled_at = now(), last_error = 'link_expired' WHERE id = $1 AND status = 'pending'`,
        [id],
      );
    }
    return id;
  }

  async function state(userId: string): Promise<UserState> {
    const row = await owner.query<UserState>('SELECT id, email, erased_at FROM users WHERE id = $1', [userId]);
    const found = row.rows[0];
    if (found === undefined) throw new Error(userId);
    return found;
  }

  async function erase(pool: Pool, userId: string): Promise<boolean> {
    const row = await pool.query<{ ok: boolean }>('SELECT erase_invited_only_user($1) AS ok', [userId]);
    return row.rows[0]?.ok ?? false;
  }

  /**
   * 가드 트리거 **이름 하나씩**을 끈 채 소유자 롤 **한 트랜잭션** 안에서 반례를 만들고 판정까지 한 뒤 되돌린다(적대적 검토 L5 — 슈퍼유저가 필요한
   * `session_replication_role` 을 쓰지 않는다 · 잘못된 상태가 커밋되지 않는다). `ALTER TABLE … DISABLE TRIGGER` 는 그 표를 트랜잭션 끝까지
   * ACCESS EXCLUSIVE 로 잡으므로 안에서 하는 일은 짧게 둔다.
   */
  async function withTriggersDisabled(disable: readonly (readonly [table: string, trigger: string])[], run: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '10s'");
      for (const [table, trigger] of disable) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      await run(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  /** 같은 트랜잭션 안에서 — 한 사용자 지우기가 false 이고 행이 그대로다. */
  async function expectUnchangedIn(client: PoolClient, userId: string): Promise<void> {
    const read = async (): Promise<UserState | undefined> =>
      (await client.query<UserState>('SELECT id, email, erased_at FROM users WHERE id = $1', [userId])).rows[0];
    const before = await read();
    const result = await client.query<{ ok: boolean }>('SELECT erase_invited_only_user($1) AS ok', [userId]);
    expect(result.rows[0]?.ok).toBe(false);
    expect(await read()).toEqual(before);
    expect(before?.erased_at).toBeNull();
  }

  const placeholder = (id: string): string => `erased-${id}@erased.invalid`;

  it('조건이 맞으면 주소만 지운다 — id·초대 FK 그대로 · 두 번째 호출은 false · 소유자도 되돌리지 못한다', async () => {
    const organization = await org();
    const user = await invitee('ok');
    const expiredInvite = await pastInvite(organization, user.id);
    const revokedInvite = await pastInvite(organization, user.id, { createdDaysAgo: 45, revokedDaysAgo: 44 });

    expect(await erase(owner, user.id)).toBe(true);
    const after = await state(user.id);
    expect(after.id).toBe(user.id);
    expect(after.email).toBe(placeholder(user.id));
    expect(after.erased_at).toBeInstanceOf(Date);
    const invites = await owner.query<{ id: string }>('SELECT id FROM org_invites WHERE user_id = $1 ORDER BY id', [user.id]);
    expect(invites.rows.map((row) => row.id).sort()).toEqual([expiredInvite, revokedInvite].sort());

    expect(await erase(owner, user.id)).toBe(false);
    expect(await state(user.id)).toEqual(after);
    const restore = await rejects(owner.query('UPDATE users SET email = $2, erased_at = NULL WHERE id = $1', [user.id, user.email]));
    expect([restore.code, restore.message]).toEqual(['23514', `user ${user.id} is already erased`]);
  });

  describe('조건 하나라도 어긋나면 아무것도 바꾸지 않는다', () => {
    async function expectUnchanged(userId: string): Promise<void> {
      const before = await state(userId);
      expect(await erase(owner, userId)).toBe(false);
      expect(await state(userId)).toEqual(before);
      expect(before.erased_at).toBeNull();
    }

    it('초대가 한 번도 없다(초대받은 사용자가 아니다)', async () => {
      await expectUnchanged((await invitee('no-invite')).id);
    });

    it('멤버십 이력(제거된 것 포함)', async () => {
      const organization = await org();
      const user = await invitee('member');
      await pastInvite(organization, user.id);
      const membership = await owner.query<{ id: string }>(
        `INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, 'member', 'invite') RETURNING id`,
        [user.id, organization.id],
      );
      await owner.query('UPDATE memberships SET removed_at = now() WHERE id = $1', [membership.rows[0]?.id]);
      await expectUnchanged(user.id);
    });

    it('대기 초대가 있다(다른 조직에서)', async () => {
      const first = await org();
      const second = await org();
      const user = await invitee('pending');
      await pastInvite(first, user.id);
      await owner.query(
        `INSERT INTO org_invites (organization_id, user_id, role, invited_by_user_id, expires_at)
         VALUES ($1, $2, 'member', $3, date_trunc('milliseconds', now() + interval '7 days'))`,
        [second.id, user.id, second.ownerUserId],
      );
      await expectUnchanged(user.id);
    });

    it('마지막 초대가 끝난 지 30일이 안 됐다 — 만료(3일 전)', async () => {
      const organization = await org();
      const user = await invitee('recent-expiry');
      await pastInvite(organization, user.id);
      await pastInvite(organization, user.id, { createdDaysAgo: 10 });
      await expectUnchanged(user.id);
    });

    it('마지막 초대가 끝난 지 30일이 안 됐다 — 취소(5일 전, 만료보다 늦게 적힌 끝)', async () => {
      const organization = await org();
      const user = await invitee('recent-revoke');
      await pastInvite(organization, user.id, { createdDaysAgo: 40, revokedDaysAgo: 5 });
      await expectUnchanged(user.id);
    });

    it('초대 메일 outbox 에 대기 행이 있다(지운 주소로 메일이 나가지 않게)', async () => {
      const organization = await org();
      const user = await invitee('outbox');
      await pastInvite(organization, user.id, { settle: false });
      await expectUnchanged(user.id);
    });

    it('살아 있는 로그인 링크', async () => {
      const organization = await org();
      const user = await invitee('login-link');
      await pastInvite(organization, user.id);
      // 멤버 아닌 사용자의 로그인 링크는 가드(`owner_login_links_user_guard`)가 막는다 — 그 하나만 끄고 같은 트랜잭션에서 판정한다.
      await withTriggersDisabled([['owner_login_links', 'owner_login_links_user_guard']], async (client) => {
        await client.query(
          `INSERT INTO owner_login_links (organization_id, user_id, browser_binding, client_key, expires_at)
           VALUES ($1, $2, repeat('a', 64), repeat('b', 64), date_trunc('milliseconds', now() + interval '10 minutes'))`,
          [organization.id, user.id],
        );
        await expectUnchangedIn(client, user.id);
      });
    });

    it('어느 조직의 주 소유자 주소다', async () => {
      const organization = await org();
      const user = await invitee('primary');
      await pastInvite(organization, user.id);
      // 주 소유자 이전은 멤버십을 옮긴다(`organizations_owner_email_moves_membership`) — 그 하나만 꺼서 "주소만 주 소유자" 인 반례를 만든다.
      await withTriggersDisabled([['organizations', 'organizations_owner_email_moves_membership']], async (client) => {
        await client.query('UPDATE organizations SET owner_email = $2 WHERE id = $1', [organization.id, user.email]);
        await expectUnchangedIn(client, user.id);
      });
      const kept = await owner.query<{ owner_email: string }>('SELECT owner_email FROM organizations WHERE id = $1', [organization.id]);
      expect(kept.rows[0]?.owner_email).toBe(organization.ownerEmail);
    });
  });

  it('EXECUTE — 한 사용자 함수는 admin·앱·로그인 메일 롤 모두 42501 · 배치는 앱 롤만', async () => {
    const organization = await org();
    const user = await invitee('roles');
    await pastInvite(organization, user.id);
    for (const pool of [admin, app, mailer]) {
      const denied = await rejects(erase(pool, user.id));
      expect(denied.code).toBe('42501');
    }
    for (const pool of [admin, mailer]) {
      const denied = await rejects(pool.query('SELECT * FROM erase_invited_only_users(10)'));
      expect(denied.code).toBe('42501');
    }
    expect((await state(user.id)).erased_at).toBeNull();
    const privileges = await owner.query<{ name: string; public_exec: boolean; admin: boolean; app: boolean; mailer: boolean; config: string[] | null }>(
      `SELECT p.proname AS name, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('atmark_admin', p.oid, 'EXECUTE') AS admin,
              has_function_privilege('atmark_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('atmark_login_mailer', p.oid, 'EXECUTE') AS mailer
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('erase_invited_only_user', 'erase_invited_only_users', 'invited_user_erasure_backlog', 'invited_only_user_erasable',
                            'purge_expired_signup_links') ORDER BY 1`,
    );
    // search_path 는 pg_temp 가 **마지막**(적대적 검토 L1) · 배치에 잠금 대기 설정 없음(NOWAIT — M1) · 조건 함수는 definer 가 아니고 누구에게도 없다.
    const pinned = ['search_path=pg_catalog, public, pg_temp'];
    expect(privileges.rows).toEqual([
      { name: 'erase_invited_only_user', config: pinned, public_exec: false, admin: false, app: false, mailer: false },
      { name: 'erase_invited_only_users', config: pinned, public_exec: false, admin: false, app: true, mailer: false },
      { name: 'invited_only_user_erasable', config: null, public_exec: false, admin: false, app: false, mailer: false },
      { name: 'invited_user_erasure_backlog', config: pinned, public_exec: false, admin: false, app: true, mailer: false },
      { name: 'purge_expired_signup_links', config: pinned, public_exec: false, admin: false, app: true, mailer: false },
    ]);
    expect((await rejects(admin.query('SELECT invited_user_erasure_backlog()'))).code).toBe('42501');
    const backlog = await app.query<{ n: number }>('SELECT invited_user_erasure_backlog() AS n');
    expect(typeof backlog.rows[0]?.n).toBe('number');
  });

  it('앱 롤이 배치를 이르게·크게 불러도 조건이 안 맞는 행은 그대로 · 크기는 500 으로 잘린다 · 맞는 행만 지운다', async () => {
    const organization = await org();
    const early = await invitee('early');
    await pastInvite(organization, early.id, { createdDaysAgo: 10 });
    const pending = await invitee('early-pending');
    await pastInvite(organization, pending.id, { settle: false });
    const due = await invitee('due');
    await pastInvite(organization, due.id);
    const beforeEarly = await state(early.id);
    const beforePending = await state(pending.id);

    // 크기는 함수 안에서 1–500 으로 자른다: 0 → 1(후보가 있으면 정확히 하나를 본다) · 상한 500 은 정의에 박혀 있다.
    const one = await app.query<{ erased: number; skipped: number }>('SELECT erased, skipped FROM erase_invited_only_users(0)');
    expect((one.rows[0]?.erased ?? 0) + (one.rows[0]?.skipped ?? 0)).toBe(1);
    const definition = await owner.query<{ src: string }>(`SELECT pg_get_functiondef('erase_invited_only_users(integer)'::regprocedure) AS src`);
    expect(definition.rows[0]?.src).toContain('least(greatest(coalesce(p_limit, 1), 1), 500)');

    const result = await app.query<{ erased: number; skipped: number }>('SELECT erased, skipped FROM erase_invited_only_users(1000000)');
    const counts = result.rows[0];
    expect(counts).toBeDefined();
    expect((counts?.erased ?? 0) + (counts?.skipped ?? 0)).toBeLessThanOrEqual(500);
    expect(await state(early.id)).toEqual(beforeEarly);
    expect(await state(pending.id)).toEqual(beforePending);
    expect((await state(due.id)).email).toBe(placeholder(due.id));
    // 다시 불러도(멱등) 더 바뀌는 것이 없다.
    const again = await state(due.id);
    await app.query('SELECT * FROM erase_invited_only_users(0)');
    expect(await state(due.id)).toEqual(again);
    expect(await state(early.id)).toEqual(beforeEarly);
  });

  it('가드 — 소유자도 자리표시로만 · erased_at 과 함께만 · admin·앱은 주소 칸 권한 없음 · 자리표시 도메인 INSERT 거부 · 지운 행에 초대 거부', async () => {
    const organization = await org();
    const user = await invitee('guard');
    await pastInvite(organization, user.id);
    const other = await rejects(owner.query(`UPDATE users SET email = 'someone-else@example.com', erased_at = now() WHERE id = $1`, [user.id]));
    expect(other.code).toBe('23514');
    const withoutStamp = await rejects(owner.query('UPDATE users SET email = $2 WHERE id = $1', [user.id, placeholder(user.id)]));
    expect(withoutStamp.code).toBe('23514');
    expect((await rejects(admin.query('UPDATE users SET email = $2, erased_at = now() WHERE id = $1', [user.id, placeholder(user.id)]))).code).toBe('42501');
    expect((await rejects(app.query('UPDATE users SET erased_at = now() WHERE id = $1', [user.id]))).code).toBe('42501');
    const reserved = await rejects(admin.query(`INSERT INTO users (email) VALUES ($1)`, [`erased-${suffix()}@erased.invalid`]));
    expect([reserved.code, reserved.message]).toEqual(['23514', 'users.email domain erased.invalid is reserved']);
    expect((await state(user.id)).erased_at).toBeNull();

    expect(await erase(owner, user.id)).toBe(true);
    const attach = await rejects(
      owner.query(
        `INSERT INTO org_invites (organization_id, user_id, role, invited_by_user_id, expires_at)
         VALUES ($1, $2, 'member', $3, date_trunc('milliseconds', now() + interval '7 days'))`,
        [organization.id, user.id, organization.ownerUserId],
      ),
    );
    expect([attach.code, attach.message]).toEqual(['AT409', 'invitee_erased']);
  });

  it('지운 뒤 같은 주소로 다시 초대하면 새 사용자 행 · 초대 목록은 지운 주소를 email:null, erased:true 로', async () => {
    const organization = await org();
    const user = await invitee('reinvite');
    await pastInvite(organization, user.id);
    expect(await erase(owner, user.id)).toBe(true);

    const deps = adminDeps(admin);
    const session = await login(deps, mailer, organization);
    const created = await call(deps, 'POST', '/api/members/invites', authed(session, { body: { email: user.email, role: 'member' } }));
    expect(created.statusCode).toBe(201);
    const fresh = await owner.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [user.email]);
    expect(fresh.rows).toHaveLength(1);
    expect(fresh.rows[0]?.id).not.toBe(user.id);
    expect((await state(user.id)).email).toBe(placeholder(user.id));
    const reservedInvite = await call(deps, 'POST', '/api/members/invites', authed(session, { body: { email: placeholder(user.id), role: 'member' } }));
    expect([reservedInvite.statusCode, (reservedInvite.json() as { error?: string }).error]).toEqual([400, 'invalid_email']);

    // 목록 창(최근 30일) 안의 초대가 가리키는 사용자를 운영자가 지운 경우(소유자 셸) — 주소 대신 표시만.
    const listed = await invitee('listed');
    await owner.query(
      `INSERT INTO org_invites (organization_id, user_id, role, invited_by_user_id, expires_at)
       VALUES ($1, $2, 'member', $3, date_trunc('milliseconds', now() + interval '7 days'))`,
      [organization.id, listed.id, organization.ownerUserId],
    );
    await owner.query('UPDATE users SET email = $2, erased_at = now() WHERE id = $1', [listed.id, placeholder(listed.id)]);
    const members = await call(deps, 'GET', '/api/members', authed(session));
    const invites = (members.json() as { invites: { email: string | null; erased: boolean }[] }).invites;
    expect(invites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: null, erased: true }),
        expect.objectContaining({ email: user.email, erased: false }),
      ]),
    );
    expect(JSON.stringify(invites)).not.toContain('@erased.invalid');
  });

  describe('적대적 검토 M1·L3 — 후보 = 최종 판정 · 기다리지 않는다 · 가입 링크는 미루지 못한다', () => {
    const tinyId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

    it('막힌 후보(35일 전에 만들고 5일 전에 취소)가 배치 LIMIT 앞자리를 차지하지 않는다', async () => {
      const organization = await org();
      // 가장 작은 id 둘 — ORDER BY id LIMIT 1 의 앞자리. 트랜잭션 안에서만(되돌린다) 있어 다른 실행과 섞이지 않는다.
      await withTriggersDisabled([], async (client) => {
        const blocked = tinyId(1);
        const due = tinyId(2);
        await client.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [blocked, address('blocked'), due, address('due-first')]);
        await pastInvite(organization, blocked, { createdDaysAgo: 35, revokedDaysAgo: 5, db: client });
        await pastInvite(organization, due, { db: client });
        const result = await client.query<{ erased: number; skipped: number }>('SELECT erased, skipped FROM erase_invited_only_users(1)');
        expect(result.rows[0]).toEqual({ erased: 1, skipped: 0 });
        const rows = await client.query<{ id: string; erased: boolean }>('SELECT id::text AS id, erased_at IS NOT NULL AS erased FROM users WHERE id = ANY ($1::uuid[]) ORDER BY id', [
          [blocked, due],
        ]);
        expect(rows.rows).toEqual([
          { id: blocked, erased: false },
          { id: due, erased: true },
        ]);
      });
    });

    it('잠긴 행은 기다리지 않는다 — 한 사용자 함수는 곧바로 55P03 · 배치는 건너뛴다 · 잠금이 풀리면 지운다', async () => {
      const organization = await org();
      const user = await invitee('locked');
      await pastInvite(organization, user.id);
      const holder = await owner.connect();
      const caller = await owner.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [user.id]);
        // 되돌리면(NOWAIT 없이) 여기서 기다린다 — 문장 상한 3초에 57014 로 빨개진다.
        await caller.query("SET statement_timeout = '3s'");
        const locked = await rejects(caller.query('SELECT erase_invited_only_user($1)', [user.id]));
        expect(locked.code).toBe('55P03');
        const started = Date.now();
        await app.query('SELECT * FROM erase_invited_only_users(500)');
        expect(Date.now() - started).toBeLessThan(2_000);
        expect((await state(user.id)).erased_at).toBeNull();
      } finally {
        await holder.query('ROLLBACK');
        await caller.query('RESET statement_timeout');
        holder.release();
        caller.release();
      }
      expect(await erase(owner, user.id)).toBe(true);
    });

    it('살아 있는 가입 링크(주소로)는 지우기를 미루지 못한다 — 누구나 청할 수 있는 행이다', async () => {
      const organization = await org();
      const user = await invitee('signup-link');
      await pastInvite(organization, user.id);
      await withTriggersDisabled([], async (client) => {
        await client.query(
          `INSERT INTO signup_links (email, organization_name, browser_binding, client_key, expires_at)
           VALUES ($1, 'l7 signup', repeat('c', 64), repeat('d', 64), date_trunc('milliseconds', now() + interval '10 minutes'))`,
          [user.email],
        );
        const result = await client.query<{ ok: boolean }>('SELECT erase_invited_only_user($1) AS ok', [user.id]);
        expect(result.rows[0]?.ok).toBe(true);
        const after = await client.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [user.id]);
        expect(after.rows[0]?.email).toBe(placeholder(user.id));
        // 가입 링크는 주소를 그대로 들고 있다 — 가입 확정은 그 주소로 **새** 사용자 행을 만든다(옛 행은 자리표시).
        const link = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM signup_links WHERE email = $1', [user.email]);
        expect(link.rows[0]?.n).toBe(1);
      });
    });

    it('가입 확정과 같은 advisory 키가 잡혀 있으면 건너뛴다(false · 그대로) · 풀리면 지운다', async () => {
      const organization = await org();
      const user = await invitee('signup-lock');
      await pastInvite(organization, user.id);
      const holder = await owner.connect();
      try {
        await holder.query('BEGIN');
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('signup_email:' || $1, 0))", [user.email]);
        const before = await state(user.id);
        expect(await erase(owner, user.id)).toBe(false);
        expect(await state(user.id)).toEqual(before);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect(await erase(owner, user.id)).toBe(true);
    });

    it('밀린 수 — 마지막 초대가 끝난 지 37일이 지났는데 안 지운 사용자만 센다', async () => {
      const organization = await org();
      await withTriggersDisabled([], async (client) => {
        const count = async (): Promise<number> =>
          (await client.query<{ n: number }>('SELECT invited_user_erasure_backlog() AS n')).rows[0]?.n ?? -1;
        const before = await count();
        const overdue = (await client.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [address('overdue')])).rows[0]?.id ?? '';
        await pastInvite(organization, overdue, { createdDaysAgo: 50, db: client }); // 끝 = 43일 전
        const onTime = (await client.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [address('on-time')])).rows[0]?.id ?? '';
        await pastInvite(organization, onTime, { createdDaysAgo: 40, db: client }); // 끝 = 33일 전 — 아직 약속 안
        expect(await count()).toBe(before + 1);
        await client.query('SELECT erase_invited_only_user($1)', [overdue]);
        expect(await count()).toBe(before);
      });
    });
  });

  it('초대 트리거는 `public.users` 를 본다 — 부르는 세션의 임시 표 `users` 에 속지 않는다(적대적 검토 L4)', async () => {
    const organization = await org();
    const user = await invitee('l4');
    await withTriggersDisabled([], async (client) => {
      // pg_temp 는 search_path 에 적지 않으면 맨 앞이다 — 이름이 스키마 없이 적혀 있으면 이 빈 임시 표를 보고 "지운 사용자" 로 거부했다.
      await client.query('CREATE TEMP TABLE users (id uuid, erased_at timestamptz) ON COMMIT DROP');
      await client.query(
        `INSERT INTO org_invites (organization_id, user_id, role, invited_by_user_id, expires_at)
         VALUES ($1, $2, 'member', $3, date_trunc('milliseconds', now() + interval '7 days'))`,
        [organization.id, user.id, organization.ownerUserId],
      );
      const config = await client.query<{ config: string[] | null }>(`SELECT proconfig AS config FROM pg_proc WHERE oid = 'org_invites_invitee_live()'::regprocedure`);
      expect(config.rows[0]?.config).toEqual(['search_path=pg_catalog, public, pg_temp']);
    });
  });

  describe('쓰이지 않은 가입 링크 보존(M2, 202609250240)', () => {
    it('발송이 끝났고 만료 30일이 지난 쓰이지 않은 링크만 지운다 — 대기·30일 안·쓰인 링크는 남는다 · 소유자도 조건 밖은 못 지운다', async () => {
      const organization = await org();
      await withTriggersDisabled([], async (client) => {
        const link = async (tag: string, daysAgo: number, shape: 'settled' | 'pending' | 'used'): Promise<string> => {
          const settled = shape === 'settled';
          const used = shape === 'used';
          const row = await client.query<{ id: string }>(
            `INSERT INTO signup_links (email, organization_name, browser_binding, client_key, created_at, expires_at, status, settled_at,
                                       used_at, organization_id)
             VALUES ($1, 'm2 retention', repeat('e', 64), repeat('f', 64), now() - make_interval(days => $2),
                     date_trunc('milliseconds', now() - make_interval(days => $2) + interval '20 minutes'),
                     $3::signup_link_status, CASE WHEN $4 THEN now() END, CASE WHEN $5 THEN now() - make_interval(days => $2) END,
                     CASE WHEN $5 THEN $6::uuid END)
             RETURNING id`,
            [address(tag), daysAgo, settled ? 'obsolete' : 'pending', settled, used, organization.id],
          );
          return row.rows[0]?.id ?? '';
        };
        const old = await link('old', 40, 'settled');
        const recent = await link('recent', 10, 'settled');
        const pending = await link('pending', 40, 'pending');
        const usedLink = await link('used', 40, 'used');

        await client.query('SAVEPOINT s');
        const early = await rejects(client.query('DELETE FROM signup_links WHERE id = $1', [recent]));
        expect(early.code).toBe('23514');
        await client.query('ROLLBACK TO SAVEPOINT s');

        const purged = await client.query<{ n: number }>('SELECT purge_expired_signup_links() AS n');
        expect(purged.rows[0]?.n).toBeGreaterThanOrEqual(1);
        const left = await client.query<{ id: string }>('SELECT id::text AS id FROM signup_links WHERE id = ANY ($1::uuid[])', [[old, recent, pending, usedLink]]);
        expect(left.rows.map((row) => row.id).sort()).toEqual([recent, pending, usedLink].sort());
      });
      // 다른 롤은 DELETE 권한이 없다(조건과 무관하게).
      expect((await rejects(admin.query('DELETE FROM signup_links WHERE false'))).code).toBe('42501');
      expect((await rejects(app.query('DELETE FROM signup_links WHERE false'))).code).toBe('42501');
    });
  });
});
