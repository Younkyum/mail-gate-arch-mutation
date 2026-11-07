/**
 * 셀프 가입 DB 표면(202609240800) — 실제 Postgres, 운영과 같은 롤로.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - `create_signup_organization`: 유효한 링크 + 살아 있는 초대(202609301520) → `active`(Free)·`self_signup` 조직 + 링크 소비 · 초대 없음 ·
 *     결속 불일치·만료·재사용 → NULL
 *     (예외 아님, 링크 그대로) · 과거 `p_now` 로 만료 링크를 살리지 못한다 · 같은 주소가 이미 소유자면 **그 조직**(중복 없음) ·
 *     같은 새 주소의 동시 소비 두 건 → 조직 하나.
 *   - admin 롤은 `organizations` 를 직접 INSERT 하지 못한다(함수로만) · 결속·outbox 칸을 읽지 못한다.
 *   - 검토 상태 가드: 비소유자는 권한이 있어도 `review_status` 를 바꾸지 못하고 `active` 조직을 INSERT 하지 못한다 · 소유자 롤은 바꾼다.
 *   - 앱 롤은 가입 테이블·함수에 권한 0(실제 쿼리로).
 *   - 가입 세션(202609240810): 링크 하나 = 세션 하나 · 세션의 조직 = 링크가 소비된 조직 · 로그인/가입 링크 정확히 하나.
 *   - 저장소: 검토 전 조직의 승인은 `ApprovalBlockedByReviewError`.
 *   - 보안 강화(202609240900): 새 조직 상한 — 검토 대기 총수 · 요청자 키당 24시간 3개 → SQLSTATE `AT429`(`signup_capacity`), 링크
 *     미소비 · 기존 소유자 분기는 상한과 무관 · 조직 이름의 보이지 않는 문자 금지(DB) · 시스템 메일 억제 표는 앱 롤 INSERT 만.
 */

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { approveRequest } from '../../../src/approval/service';
import { ApprovalBlockedByReviewError, createPostgresApprovalStore } from '../../../src/db/repositories/approval-store';
import { adminPool, appPool, AVAILABLE, hex64, insertLinkAsAdmin, msTrunc, ownerPool, sqlState, suffix, uniqueEmail, mailerPool } from './support';

interface OrgRow {
  id: string;
  name: string;
  owner_email: string | null;
  review_status: string;
  signup_source: string;
  billing_status: string;
  reviewed_at: Date | null;
}

describe.skipIf(!AVAILABLE)('셀프 가입 DB — 조직 생성 함수 · 검토 가드 · 권한 경계', () => {
  let owner: Pool;
  let admin: Pool;
  let app: Pool;
  let mailer: Pool;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminPool();
    app = appPool();
    mailer = mailerPool();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), app.end(), mailer.end()]);
  });

  const create = (pool: Pool, linkId: string, binding: string, now: Date = new Date()) =>
    pool.query<{ org: string | null }>('SELECT create_signup_organization($1, $2, $3) AS org', [linkId, binding, now]).then((r) => r.rows[0]?.org ?? null);

  const linkState = (id: string) =>
    owner
      .query<{ used_at: Date | null; organization_id: string | null }>('SELECT used_at, organization_id FROM signup_links WHERE id = $1', [id])
      .then((r) => r.rows[0]);

  const orgsOwnedBy = (email: string) =>
    owner.query<OrgRow>('SELECT id, name, owner_email, review_status::text, signup_source, billing_status::text, reviewed_at FROM organizations WHERE owner_email = $1', [email]).then((r) => r.rows);

  it('유효한 링크 + 살아 있는 초대 → active·self_signup·trialing 조직(검토 없음 · reviewed_at NULL) + 링크 소비(used_at·organization_id) · 두 번째 소비는 NULL', async () => {
    const name = `새 조직 ${suffix()}`;
    const link = await insertLinkAsAdmin(admin, { organizationName: name });
    const orgId = await create(admin, link.id, link.binding);
    expect(orgId).not.toBeNull();
    const orgs = await orgsOwnedBy(link.email);
    expect(orgs).toEqual([
      { id: orgId, name, owner_email: link.email, review_status: 'active', signup_source: 'self_signup', billing_status: 'trialing', reviewed_at: null },
    ]);
    const state = await linkState(link.id);
    expect(state?.organization_id).toBe(orgId);
    expect(state?.used_at).not.toBeNull();
    // 단일 사용.
    expect(await create(admin, link.id, link.binding)).toBeNull();
    expect(await orgsOwnedBy(link.email)).toHaveLength(1);
  });

  it('초대 전용(202609301520) — 초대가 없거나 끝났으면 NULL · 링크는 그대로 · 조직 없음 · 초대가 생기면 같은 링크로 된다', async () => {
    const link = await insertLinkAsAdmin(admin, { invite: false });
    expect(await create(admin, link.id, link.binding)).toBeNull();
    // 끝난 초대(만료 1일 지남).
    await owner.query(
      `INSERT INTO waitlist_entries (email, lang, source, status, invited_at, invite_expires_at, invited_by)
       VALUES ($1, 'ko', 'site', 'invited', now() - interval '15 days', now() - interval '1 day', 'test:seed')`,
      [link.email],
    );
    expect(await create(admin, link.id, link.binding)).toBeNull();
    expect((await linkState(link.id))?.used_at).toBeNull();
    expect(await orgsOwnedBy(link.email)).toEqual([]);
    await owner.query(`UPDATE waitlist_entries SET invited_at = now(), invite_expires_at = now() + interval '14 days' WHERE email = $1`, [link.email]);
    expect(await create(admin, link.id, link.binding)).not.toBeNull();
  });

  it('결속이 다르거나 모양이 틀리면 NULL — 예외가 아니고 링크는 그대로(쓸 수 있다)', async () => {
    const link = await insertLinkAsAdmin(admin);
    expect(await create(admin, link.id, hex64())).toBeNull();
    expect(await create(admin, link.id, 'not-hex')).toBeNull();
    expect(await create(admin, '00000000-0000-4000-8000-000000000000', link.binding)).toBeNull();
    expect((await linkState(link.id))?.used_at).toBeNull();
    expect(await orgsOwnedBy(link.email)).toEqual([]);
    // 비공허: 맞는 결속이면 된다.
    expect(await create(admin, link.id, link.binding)).not.toBeNull();
  });

  it('만료: 호출자 시각이 만료 뒤면 NULL · 과거 시각을 넘겨도 이미 만료된 링크를 살리지 못한다', async () => {
    const link = await insertLinkAsAdmin(admin);
    expect(await create(admin, link.id, link.binding, new Date(link.expiresAt.getTime()))).toBeNull();
    expect((await linkState(link.id))?.used_at).toBeNull();
    // 이미 만료된 행(소유자 롤로만 만들 수 있다 — created_at 을 과거로) + 과거 p_now.
    const email = uniqueEmail();
    const binding = hex64();
    const createdAt = new Date(Date.now() - 40 * 60 * 1000);
    const expired = await owner.query<{ id: string }>(
      `INSERT INTO signup_links (email, organization_name, browser_binding, client_key, created_at, expires_at)
       VALUES ($1, 'expired org', $2, $3, $4, $5) RETURNING id`,
      [email, binding, hex64(), createdAt, msTrunc(new Date(createdAt.getTime() + 30 * 60 * 1000))],
    );
    const expiredId = expired.rows[0]?.id ?? '';
    expect(await create(admin, expiredId, binding, new Date(createdAt.getTime() + 60 * 1000))).toBeNull();
    expect(await orgsOwnedBy(email)).toEqual([]);
  });

  it('같은 주소가 이미 소유자인 조직이 있으면 그 조직 id — 새 조직을 만들지 않고 링크는 소비된다', async () => {
    const email = uniqueEmail();
    const existing = await owner.query<{ id: string }>(`INSERT INTO organizations (name, owner_email) VALUES ('기존 조직', $1) RETURNING id`, [email]);
    const existingId = existing.rows[0]?.id;
    const link = await insertLinkAsAdmin(admin, { email });
    expect(await create(admin, link.id, link.binding)).toBe(existingId);
    const orgs = await orgsOwnedBy(email);
    expect(orgs.map((org) => [org.id, org.review_status, org.signup_source])).toEqual([[existingId, 'active', 'operator']]);
    expect((await linkState(link.id))?.organization_id).toBe(existingId);
  });

  it('같은 새 주소의 링크 둘을 동시에 소비해도 조직은 하나다(주소 단위 잠금)', async () => {
    const email = uniqueEmail();
    const first = await insertLinkAsAdmin(admin, { email });
    const second = await insertLinkAsAdmin(admin, { email });
    const [a, b] = await Promise.all([create(admin, first.id, first.binding), create(admin, second.id, second.binding)]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(await orgsOwnedBy(email)).toHaveLength(1);
  });

  it('admin 롤: organizations 직접 INSERT 불가 · 가입 링크 UPDATE 는 틀린 코드 수(+1 씩만)뿐 · 발송 칸 읽기 불가 · 허용 칸 읽기는 된다', async () => {
    expect(await sqlState(() => admin.query(`INSERT INTO organizations (name, owner_email) VALUES ('backdoor', $1)`, [uniqueEmail()]))).toBe('42501');
    const link = await insertLinkAsAdmin(admin);
    expect(await sqlState(() => admin.query('UPDATE signup_links SET used_at = now() WHERE id = $1', [link.id]))).toBe('42501');
    expect(await sqlState(() => admin.query("UPDATE signup_links SET status = 'sent' WHERE id = $1", [link.id]))).toBe('42501');
    for (const column of ['sent_at', 'ses_message_id', 'attempt_count', 'last_error', 'claimed_at', 'next_attempt_at', 'settled_at']) {
      expect(await sqlState(() => admin.query(`SELECT ${column} FROM signup_links WHERE id = $1`, [link.id])), column).toBe('42501');
    }
    expect(await sqlState(() => admin.query('SELECT id, email, organization_name, client_key, created_at, expires_at, used_at, organization_id FROM signup_links WHERE id = $1', [link.id]))).toBe('ok');
    // 가입 코드(202609280100) — 결속으로 후보를 찾고(결속 · 발송 상태 · 틀린 수 읽기) 틀린 수를 +1 한다. 되돌리기·건너뛰기는 가드가 막는다(23514).
    expect(await sqlState(() => admin.query('SELECT browser_binding, status, code_failures FROM signup_links WHERE id = $1', [link.id]))).toBe('ok');
    expect(await sqlState(() => admin.query('UPDATE signup_links SET code_failures = code_failures + 1 WHERE id = $1', [link.id]))).toBe('ok');
    expect(await sqlState(() => admin.query('UPDATE signup_links SET code_failures = 0 WHERE id = $1', [link.id]))).toBe('23514');
    expect(await sqlState(() => admin.query('UPDATE signup_links SET code_failures = 3 WHERE id = $1', [link.id]))).toBe('23514');
    // outbox 상태를 미리 적는 INSERT 는 없다.
    expect(
      await sqlState(() =>
        admin.query(
          `INSERT INTO signup_links (email, organization_name, browser_binding, client_key, expires_at, status, sent_at, ses_message_id)
           VALUES ($1, 'x', $2, $3, $4, 'sent', now(), 'x')`,
          [uniqueEmail(), hex64(), hex64(), msTrunc(new Date(Date.now() + 600_000))],
        ),
      ),
    ).toBe('42501');
    expect(await sqlState(() => admin.query('INSERT INTO signup_requests (client_key, email_hash) VALUES ($1, $2)', [hex64(), hex64()]))).toBe('ok');
  });

  it('login-mailer 롤: 조직 이름·결속·소비 칸을 읽지 못하고 INSERT 가 없다 · 억제 함수는 실행된다 · 조직 생성 함수는 못 부른다', async () => {
    const link = await insertLinkAsAdmin(admin);
    for (const column of ['organization_name', 'browser_binding', 'used_at', 'client_key', 'organization_id']) {
      expect(await sqlState(() => mailer.query(`SELECT ${column} FROM signup_links WHERE id = $1`, [link.id])), column).toBe('42501');
    }
    expect(await sqlState(() => mailer.query('SELECT id, email, expires_at, status FROM signup_links WHERE id = $1', [link.id]))).toBe('ok');
    expect(await sqlState(() => mailer.query(`INSERT INTO signup_links (email, organization_name, browser_binding, client_key, expires_at) VALUES ($1, 'x', $2, $3, $4)`, [uniqueEmail(), hex64(), hex64(), link.expiresAt]))).toBe('42501');
    expect(await sqlState(() => mailer.query('SELECT signup_email_suppressed($1)', [link.email]))).toBe('ok');
    expect(await sqlState(() => mailer.query('SELECT 1 FROM suppression_entries LIMIT 1'))).toBe('42501');
    expect(await sqlState(() => create(mailer, link.id, link.binding))).toBe('42501');
  });

  it('앱 롤: 가입 테이블·함수에 권한 0 (실제 쿼리)', async () => {
    const link = await insertLinkAsAdmin(admin);
    expect(await sqlState(() => app.query('SELECT id FROM signup_links LIMIT 1'))).toBe('42501');
    expect(await sqlState(() => app.query('SELECT id FROM signup_requests LIMIT 1'))).toBe('42501');
    expect(await sqlState(() => app.query('INSERT INTO signup_requests (client_key, email_hash) VALUES ($1, $2)', [hex64(), hex64()]))).toBe('42501');
    expect(await sqlState(() => create(app, link.id, link.binding))).toBe('42501');
    expect(await sqlState(() => app.query('SELECT signup_email_suppressed($1)', [link.email]))).toBe('42501');
    expect((await linkState(link.id))?.used_at).toBeNull();
  });

  it('검토 상태 가드 — 비소유자는 UPDATE 권한이 있어도 못 바꾸고 active 조직을 INSERT 하지 못한다 · 소유자 롤은 바꾼다', async () => {
    const link = await insertLinkAsAdmin(admin);
    const orgId = (await create(admin, link.id, link.binding)) ?? '';
    // 운영 GRANT 로는 admin 에 review_status UPDATE 자체가 없다(권한 거부).
    expect(await sqlState(() => admin.query(`UPDATE organizations SET review_status = 'rejected' WHERE id = $1`, [orgId]))).toBe('42501');
    // 권한을 **줘도** 트리거가 막는다(롤백되는 트랜잭션에서 GRANT 후 SET ROLE).
    const client: PoolClient = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('GRANT UPDATE (review_status, signup_source, reviewed_at, owner_paused) ON organizations TO atmark_admin');
      await client.query('GRANT INSERT ON organizations TO atmark_admin');
      await client.query('SET LOCAL ROLE atmark_admin');
      // 가입 조직은 이제 active 로 태어난다(202609301520) — 검토 상태를 **바꾸는** 문장(거절)으로 가드를 본다.
      for (const sql of [
        `UPDATE organizations SET review_status = 'rejected' WHERE id = $1`,
        `UPDATE organizations SET signup_source = 'operator' WHERE id = $1`,
        `UPDATE organizations SET reviewed_at = now() WHERE id = $1`,
      ]) {
        await client.query('SAVEPOINT s');
        const state = await sqlState(() => client.query(sql, [orgId]));
        await client.query('ROLLBACK TO SAVEPOINT s');
        expect(state, sql).toBe('42501');
      }
      // 다른 칸(owner_paused)은 그대로 된다 — 가드는 검토 세 칸만.
      await client.query('SAVEPOINT s');
      expect(await sqlState(() => client.query('UPDATE organizations SET owner_paused = true WHERE id = $1', [orgId]))).toBe('ok');
      await client.query('ROLLBACK TO SAVEPOINT s');
      // INSERT: active·operator 조직은 거부, pending_review·self_signup 만.
      await client.query('SAVEPOINT s');
      expect(await sqlState(() => client.query(`INSERT INTO organizations (name, owner_email) VALUES ('x', $1)`, [uniqueEmail()]))).toBe('42501');
      await client.query('ROLLBACK TO SAVEPOINT s');
      expect(
        await sqlState(() =>
          client.query(`INSERT INTO organizations (name, owner_email, review_status, signup_source) VALUES ('x', $1, 'pending_review', 'self_signup')`, [uniqueEmail()]),
        ),
      ).toBe('ok');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    // 소유자 롤(운영자 CLI)은 바꾼다.
    await owner.query(`UPDATE organizations SET review_status = 'rejected', reviewed_at = now() WHERE id = $1`, [orgId]);
    expect((await owner.query<{ s: string }>('SELECT review_status::text AS s FROM organizations WHERE id = $1', [orgId])).rows[0]?.s).toBe('rejected');
  });

  it('가입 세션(202609240810) — 링크 하나 = 세션 하나 · 세션의 조직은 그 링크가 소비된 조직뿐 · 링크는 정확히 하나 · user_id 결속(202609250190)', async () => {
    const link = await insertLinkAsAdmin(admin);
    const session = (orgId: string | null, userId: string | null, signupLinkId: string | null) =>
      sqlState(() =>
        admin.query(
          `INSERT INTO owner_sessions (organization_id, user_id, signup_link_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
          [orgId, userId, signupLinkId, hex64()],
        ),
      );
    // "other" 도 owner_email 을 가진 조직으로 만든다 — 그 소유자를 user_id 로 써서 세션 가드(살아 있는 멤버십)를 통과시키고,
    //   시험하려는 실패가 **복합 FK**(링크·조직 불일치)임을 그대로 유지한다(0190 은 user_id NOT NULL 을 더했을 뿐, 이 FK 를
    //   건드리지 않았다).
    const otherEmail = uniqueEmail();
    const other = await owner.query<{ id: string }>(`INSERT INTO organizations (name, owner_email) VALUES ('other', $1) RETURNING id`, [otherEmail]);
    const otherUser = (await owner.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [otherEmail])).rows[0]?.id ?? null;
    // 소비 전 링크로는 세션이 서지 않는다(복합 FK — 링크의 organization_id 가 NULL).
    expect(await session(other.rows[0]?.id ?? null, otherUser, link.id)).toBe('23503');
    const orgId = (await create(admin, link.id, link.binding)) ?? '';
    const linkUser = (await owner.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [link.email])).rows[0]?.id ?? null;
    // 다른 조직으로는 안 된다.
    expect(await session(other.rows[0]?.id ?? null, otherUser, link.id)).toBe('23503');
    // 0190: user_id 없이는 CHECK 로 거부된다(옛 자동 채움 트리거는 걷혔다).
    expect(await session(orgId, null, link.id)).toBe('23514');
    // 링크 없는 세션은 CHECK(owner_sessions_one_link).
    expect(await session(orgId, linkUser, null)).toBe('23514');
    expect(await session(orgId, linkUser, link.id)).toBe('ok');
    // 같은 링크로 두 번째 세션은 없다.
    expect(await session(orgId, linkUser, link.id)).toBe('23505');
  });

  it('저장소 — 검토 전 조직의 승인은 ApprovalBlockedByReviewError · 요청 pending 유지', async () => {
    // 조직·에이전트·승인 요청을 소유자 롤로 심고, 앱 롤 저장소로 승인을 시도한다.
    const email = uniqueEmail();
    const org = await owner.query<{ id: string }>(
      `INSERT INTO organizations (name, owner_email, review_status, signup_source) VALUES ('review org', $1, 'pending_review', 'self_signup') RETURNING id`,
      [email],
    );
    const agentId = hex64().slice(0, 32);
    await owner.query(`INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, 'review-agent', 'active', 'free', 1000)`, [
      agentId,
      org.rows[0]?.id,
    ]);
    const approval = await owner.query<{ id: string }>(
      `INSERT INTO approval_requests (id, agent_id, subject, created_at, expires_at) VALUES (gen_random_uuid(), $1, 'message', now(), now() + interval '1 hour') RETURNING id`,
      [agentId],
    );
    const approvalId = approval.rows[0]?.id ?? '';
    const store = createPostgresApprovalStore(app);
    await expect(
      approveRequest(store, { approvalId, decidedBy: email, now: new Date(), scope: 'recipient', confirmScope: null }),
    ).rejects.toThrow(ApprovalBlockedByReviewError);
    expect((await store.find(approvalId))?.status).toBe('pending');
    await owner.query(`UPDATE organizations SET review_status = 'rejected' WHERE id = $1`, [org.rows[0]?.id]);
    await expect(
      approveRequest(store, { approvalId, decidedBy: email, now: new Date(), scope: 'recipient', confirmScope: null }),
    ).rejects.toMatchObject({ reason: 'org_review_rejected' });
  });

  // -------------------------------------------------------------------------
  // 보안 강화(202609240900)
  // -------------------------------------------------------------------------

  /**
   * 상한 시나리오는 **롤백되는 소유자 트랜잭션** 안에서 돈다 — `signup_limits` 를 그 안에서만 바꾸고, admin 롤로 SET LOCAL ROLE 해
   * 운영과 같은 롤로 함수를 부른다. 공유 DB 의 검토 대기 수·상한 값은 바뀌지 않는다.
   */
  async function inCapTransaction(run: (client: PoolClient) => Promise<void>): Promise<void> {
    const client: PoolClient = await owner.connect();
    try {
      await client.query('BEGIN');
      await run(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  /** admin 롤로 링크 한 행(요청자 키 지정) → id. 트랜잭션 안(SET LOCAL ROLE atmark_admin 상태)에서 부른다. */
  async function linkIn(client: PoolClient, clientKey: string, email: string = uniqueEmail()): Promise<{ id: string; binding: string }> {
    const binding = hex64();
    // 초대 전용(202609301520) — 같은 트랜잭션에서 소유자 롤로 살아 있는 초대를 심고 admin 롤로 돌아간다.
    await client.query('RESET ROLE');
    await client.query(
      `INSERT INTO waitlist_entries (email, lang, source, status, invited_at, invite_expires_at, invited_by)
       VALUES ($1, 'ko', 'site', 'invited', now(), now() + interval '14 days', 'test:seed') ON CONFLICT (email) DO NOTHING`,
      [email],
    );
    await client.query('SET LOCAL ROLE atmark_admin');
    const row = await client.query<{ id: string }>(
      `INSERT INTO signup_links (email, organization_name, browser_binding, client_key, expires_at, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
      [email, `상한 조직 ${suffix()}`, binding, clientKey, msTrunc(new Date(Date.now() + 20 * 60 * 1000))],
    );
    return { id: row.rows[0]?.id ?? '', binding };
  }

  /** 함수 호출 한 번 — 결과(조직 id·NULL) 또는 오류의 SQLSTATE·DETAIL. SAVEPOINT 로 감싸 트랜잭션을 살린다. */
  async function consume(client: PoolClient, link: { id: string; binding: string }): Promise<{ org: string | null } | { code: string; detail: string | undefined }> {
    await client.query('SAVEPOINT c');
    try {
      const row = await client.query<{ org: string | null }>('SELECT create_signup_organization($1, $2, now()) AS org', [link.id, link.binding]);
      await client.query('RELEASE SAVEPOINT c');
      return { org: row.rows[0]?.org ?? null };
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT c');
      const failure = error as { code?: string; detail?: string };
      return { code: String(failure.code), detail: failure.detail };
    }
  }

  it('M2 — 요청자 키당 24시간 새 조직 3개: 넷째는 AT429(client_daily_cap) · 링크 미소비 · 다른 키는 된다 · 기존 소유자 분기는 상한 밖', async () => {
    await inCapTransaction(async (client) => {
      await client.query('UPDATE signup_limits SET self_signup_daily_cap = 1000000, per_client_daily_cap = 3');
      await client.query('SET LOCAL ROLE atmark_admin');
      const key = hex64();
      const created: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const outcome = await consume(client, await linkIn(client, key));
        expect('org' in outcome && outcome.org !== null, JSON.stringify(outcome)).toBe(true);
        if ('org' in outcome && outcome.org !== null) created.push(outcome.org);
      }
      // 같은 키로 이미 소유자인 주소 — 조직을 만들지 않으므로 상한과 무관하고, 새 조직 수에도 들지 않는다.
      const ownerEmail = (await client.query<{ owner_email: string }>('SELECT owner_email FROM organizations WHERE id = $1', [created[0]])).rows[0]?.owner_email;
      expect(await consume(client, await linkIn(client, key, ownerEmail))).toEqual({ org: created[0] });
      const fourth = await linkIn(client, key);
      expect(await consume(client, fourth)).toEqual({ code: 'AT429', detail: 'client_daily_cap' });
      const unused = await client.query<{ used_at: Date | null }>('SELECT used_at FROM signup_links WHERE id = $1', [fourth.id]);
      expect(unused.rows[0]?.used_at).toBeNull();
      // 다른 요청자 키는 된다.
      const other = await consume(client, await linkIn(client, hex64()));
      expect('org' in other && other.org !== null).toBe(true);
    });
  });

  /**
   * 롤링 24시간 새 셀프 가입 조직 수(202609301520 — 검토 대기 총수 상한을 대신한다)는 **공유 로컬 DB 전체**의 값이다 — 병렬로 도는 다른 파일이
   * 셀프 가입 조직을 만들면, 아래에서 센 수와 함수가 세는 값이 달라져 "하나 모자라면 만든다" 가 상한으로 떨어진다(병렬에서만 빨감).
   * 그래서 이 트랜잭션 동안 조직 표를 얼린다. 순서가 교착을 막는다: 함수와 같은
   * 조직 생성 잠금(`signup_org_create`)을 **먼저** 잡고(그 잠금을 쥔 다른 가입이 끝나기를 기다린다 — 그 가입은 잠금 뒤에야 쓴다), 그다음
   * 표 잠금(SHARE ROW EXCLUSIVE — 다른 쓰기는 롤백까지 기다린다, 읽기는 된다). 함수 안의 같은 잠금은 같은 세션이라 다시 잡힌다.
   */
  async function freezeOrganizations(client: PoolClient): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('signup_org_create', 0))`);
    await client.query('LOCK TABLE organizations IN SHARE ROW EXCLUSIVE MODE');
  }

  it('M2 — 롤링 24시간 새 셀프 가입 조직 수가 전역 상한이면 AT429(self_signup_daily_cap) · 링크 미소비 · 기존 소유자 분기는 된다 · 하나 모자라면 만든다', async () => {
    await inCapTransaction(async (client) => {
      await freezeOrganizations(client);
      const recent = (
        await client.query<{ n: number }>(
          // 가입 링크로 생긴 조직만 센다(콘솔 새 조직은 `member_org_daily_cap` 이 따로 — 보안 검토).
          `SELECT count(*)::int AS n FROM organizations o WHERE o.signup_source = 'self_signup' AND o.created_at > now() - interval '24 hours'
              AND EXISTS (SELECT 1 FROM signup_links l WHERE l.organization_id = o.id)`,
        )
      ).rows[0]?.n ?? 0;
      // 검토 대기 총수는 이제 막지 않는다 — 옛 상한을 0 으로 내려도 된다.
      await client.query('UPDATE signup_limits SET self_signup_daily_cap = $1, pending_review_cap = 0, per_client_daily_cap = 1000', [recent + 1]);
      const existingEmail = uniqueEmail();
      await client.query(`INSERT INTO organizations (name, owner_email) VALUES ('기존 조직', $1)`, [existingEmail]);
      await client.query('SET LOCAL ROLE atmark_admin');
      // 하나 모자라면(대기 = 상한 - 1) 만든다 — 이제 대기 = 상한.
      const room = await consume(client, await linkIn(client, hex64()));
      expect('org' in room && room.org !== null, JSON.stringify(room)).toBe(true);
      const full = await linkIn(client, hex64());
      expect(await consume(client, full)).toEqual({ code: 'AT429', detail: 'self_signup_daily_cap' });
      expect((await client.query<{ used_at: Date | null }>('SELECT used_at FROM signup_links WHERE id = $1', [full.id])).rows[0]?.used_at).toBeNull();
      // 기존 소유자 → 그 조직(상한 무관).
      const existing = await consume(client, await linkIn(client, hex64(), existingEmail));
      expect('org' in existing && existing.org !== null).toBe(true);
    });
  });

  it('M2 — 상한 행이 없어도 기본값(200 · 3)으로 막는다(표를 비워 상한을 푸는 길 없음) · admin 롤은 상한 표를 읽지도 바꾸지도 못한다', async () => {
    expect(await sqlState(() => admin.query('SELECT * FROM signup_limits'))).toBe('42501');
    expect(await sqlState(() => admin.query('UPDATE signup_limits SET per_client_daily_cap = 1000'))).toBe('42501');
    expect(await sqlState(() => app.query('SELECT * FROM signup_limits'))).toBe('42501');
    await inCapTransaction(async (client) => {
      await client.query('DELETE FROM signup_limits');
      await client.query('SET LOCAL ROLE atmark_admin');
      const key = hex64();
      const outcomes = [];
      for (let i = 0; i < 4; i += 1) outcomes.push(await consume(client, await linkIn(client, key)));
      // 롤링 24시간 셀프 가입 조직이 이미 200 이상이면 첫 호출부터 self_signup_daily_cap — 어느 쪽이든 넷째는 막힌다.
      expect(outcomes[3]).toMatchObject({ code: 'AT429' });
    });
  });

  it('L3 — 조직 이름: 보이지 않는 문자·채움 문자·태그·변형 선택자를 DB 가 거부한다(23514) · 평범한 한글·영문·이모지는 된다', async () => {
    const forbidden = [
      '\u0001', '\u001b', '\u007f', '\u0085', '\u009b', '\u00ad', '\u061c', '\u115f', '\u1160', '\u180e', '\u200b', '\u200f',
      '\u2028', '\u202e', '\u2060', '\u2065', '\u206f', '\u2800', '\u3164', '\ufe00', '\ufe0f', '\ufeff', '\uffa0', '\u{e0000}', '\u{e0041}', '\u{e007f}',
    ];
    const insert = (name: string) =>
      sqlState(() =>
        admin.query(
          `INSERT INTO signup_links (email, organization_name, browser_binding, client_key, expires_at) VALUES ($1, $2, $3, $4, $5)`,
          [uniqueEmail(), name, hex64(), hex64(), msTrunc(new Date(Date.now() + 600_000))],
        ),
      );
    for (const char of forbidden) {
      expect(await insert(`Acme${char}Corp`), JSON.stringify(char)).toBe('23514');
    }
    // 채움 문자만으로 된 이름(빈 이름처럼 보인다).
    expect(await insert('\u3164')).toBe('23514');
    expect(await insert('\u2800')).toBe('23514');
    for (const name of ['에이전트 주식회사', 'Acme Corp.', '株式会社アトマーク', 'Café 🚀', '\u0915\u094d\u0937']) {
      expect(await insert(name), name).toBe('ok');
    }
    // 가입 조직(self_signup)의 이름도 같은 집합을 거부한다(겹 방어) — 운영자 조직은 대상 밖.
    expect(
      await sqlState(() =>
        owner.query(`INSERT INTO organizations (name, owner_email, review_status, signup_source) VALUES ($1, $2, 'pending_review', 'self_signup')`, [
          'Acme\u2800',
          uniqueEmail(),
        ]),
      ),
    ).toBe('23514');
  });

  it('H2 — system_mail_suppressions: 앱 롤은 INSERT 만(ON CONFLICT DO NOTHING 포함) · 읽기·고치기·지우기 불가 · 메일러는 주소만 읽는다 · 행은 불변', async () => {
    const address = uniqueEmail();
    expect(await sqlState(() => app.query(`INSERT INTO system_mail_suppressions (address, reason) VALUES ($1, 'hard_bounce') ON CONFLICT DO NOTHING`, [address]))).toBe('ok');
    expect(await sqlState(() => app.query(`INSERT INTO system_mail_suppressions (address, reason) VALUES ($1, 'complaint') ON CONFLICT DO NOTHING`, [address]))).toBe('ok');
    expect(await sqlState(() => app.query('SELECT address FROM system_mail_suppressions LIMIT 1'))).toBe('42501');
    expect(await sqlState(() => app.query('UPDATE system_mail_suppressions SET reason = $2 WHERE address = $1', [address, 'complaint']))).toBe('42501');
    expect(await sqlState(() => app.query('DELETE FROM system_mail_suppressions WHERE address = $1', [address]))).toBe('42501');
    expect(await sqlState(() => mailer.query('SELECT address FROM system_mail_suppressions WHERE address = $1', [address]))).toBe('ok');
    expect(await sqlState(() => mailer.query('SELECT reason FROM system_mail_suppressions WHERE address = $1', [address]))).toBe('42501');
    expect(await sqlState(() => mailer.query(`INSERT INTO system_mail_suppressions (address, reason) VALUES ($1, 'complaint')`, [uniqueEmail()]))).toBe('42501');
    expect(await sqlState(() => admin.query('SELECT address FROM system_mail_suppressions LIMIT 1'))).toBe('42501');
    // 먼저 적힌 사유가 남고, 소유자도 고치지 못한다(해제는 DELETE).
    expect((await owner.query<{ reason: string }>('SELECT reason FROM system_mail_suppressions WHERE address = $1', [address])).rows[0]?.reason).toBe('hard_bounce');
    expect(await sqlState(() => owner.query(`UPDATE system_mail_suppressions SET reason = 'complaint' WHERE address = $1`, [address]))).not.toBe('ok');
    // 가입 억제 함수가 시스템 억제도 본다.
    expect((await mailer.query<{ s: boolean }>('SELECT signup_email_suppressed($1) AS s', [address])).rows[0]?.s).toBe(true);
    expect((await mailer.query<{ s: boolean }>('SELECT signup_email_suppressed($1) AS s', [uniqueEmail()])).rows[0]?.s).toBe(false);
  });
});
