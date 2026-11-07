/**
 * 콘솔 "새 조직"(`POST /api/organizations` → `create_member_organization`, 202609301520 보안 검토 HIGH) — 초대 없이 발신 조직 나무가 자라지 않게.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 이미 owner 인 조직 중 active · 미동결이 있으면 새 조직은 active(Free) · 없으면(검토 대기 조직의 owner) pending_review.
 *   - owner 인 조직 중 하나라도 거절(`rejected`)·운영자 동결(`abuse_freeze`)이면 409 org_limit(DB: AT429 · DETAIL account_restricted) · 조직 0.
 *   - 상한은 콘솔 새 조직 전용(`signup_limits.member_org_daily_cap`, 기본 20) — 가입 상한(`self_signup_daily_cap`)과 나뉜다(롤백되는 트랜잭션에서).
 */

import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/admin/http';

import { adminDeps, adminRolePool, authed, AVAILABLE, call, cookieValue, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from './support';

describe.skipIf(!AVAILABLE)('콘솔 새 조직 — 초대 없는 발신 조직 나무를 막는다 (202609301520)', () => {
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

  const deps = () => adminDeps(admin);
  const createOrg = (session: Session, name: string) => call(deps(), 'POST', '/api/organizations', authed(session, { body: { name } }));
  const statusOf = (id: string) =>
    owner.query<{ s: string }>('SELECT review_status::text AS s FROM organizations WHERE id = $1', [id]).then((r) => r.rows[0]?.s);
  const ownedCount = (email: string) =>
    owner.query<{ n: number }>('SELECT count(*)::int AS n FROM organizations WHERE owner_email = $1', [email]).then((r) => r.rows[0]?.n ?? 0);

  it('active · 미동결 조직의 owner → 새 조직 active · 검토 대기 조직만의 owner → 새 조직 pending_review', async () => {
    const active = await newOrganization(owner, null);
    const s1 = await login(deps(), mailer, active);
    const made = await createOrg(s1, `팀 ${suffix()}`);
    expect(made.statusCode, made.body).toBe(201);
    expect(await statusOf((made.json() as { organization: { id: string } }).organization.id)).toBe('active');

    const pending = await newOrganization(owner, null);
    await owner.query(`UPDATE organizations SET review_status = 'pending_review' WHERE id = $1`, [pending.id]);
    const s2 = await login(deps(), mailer, pending);
    const fallback = await createOrg(s2, `팀 ${suffix()}`);
    expect(fallback.statusCode, fallback.body).toBe(201);
    const body = fallback.json() as { organization: { id: string; reviewStatus: string } };
    expect(body.organization.reviewStatus).toBe('pending_review');
    expect(await statusOf(body.organization.id)).toBe('pending_review');
  });

  it('owner 인 조직 하나가 거절 · 운영자 동결이면 409 org_limit — 조직이 생기지 않는다(다른 active 조직이 있어도)', async () => {
    for (const restrict of [`review_status = 'rejected'`, 'abuse_freeze = true'] as const) {
      const base = await newOrganization(owner, null);
      const session = await login(deps(), mailer, base);
      const second = await createOrg(session, `팀 ${suffix()}`);
      expect(second.statusCode).toBe(201);
      // 새 조직으로 전환된 세션(부모 세션은 폐기됐다) — 그 세션은 active 조직에 있고, 거절·동결은 처음 조직에 건다.
      const token = cookieValue(second, SESSION_COOKIE) ?? '';
      const switched: Session = { cookies: { [SESSION_COOKIE]: token }, csrf: (second.json() as { csrf: string }).csrf, token };
      await owner.query(`UPDATE organizations SET ${restrict} WHERE id = $1`, [base.id]);
      const before = await ownedCount(base.ownerEmail);
      const refused = await createOrg(switched, `팀 ${suffix()}`);
      expect([refused.statusCode, (refused.json() as { error: string }).error], restrict).toEqual([409, 'org_limit']);
      expect(await ownedCount(base.ownerEmail)).toBe(before);
    }
  });

  it('DB — 거절 사유는 account_restricted · 상한은 콘솔 새 조직 전용 칸(member_org_daily_cap)이고 가입 상한과 따로다 (롤백)', async () => {
    const base = await newOrganization(owner, null);
    const session = await login(deps(), mailer, base);
    const sessionId = (
      await owner.query<{ id: string }>('SELECT id FROM owner_sessions WHERE token_hash = $1', [createHash('sha256').update(session.token).digest('hex')])
    ).rows[0]?.id;
    expect(sessionId).toBeDefined();
    const client: PoolClient = await owner.connect();
    const attempt = async (name: string): Promise<{ id: string } | { code: string; detail: string | undefined }> => {
      await client.query('SAVEPOINT a');
      try {
        const row = await client.query<{ id: string }>('SELECT create_member_organization($1, $2) AS id', [sessionId, name]);
        await client.query('RELEASE SAVEPOINT a');
        return { id: row.rows[0]?.id ?? '' };
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT a');
        const e = error as { code?: string; detail?: string };
        return { code: String(e.code), detail: e.detail };
      }
    };
    try {
      await client.query('BEGIN');
      // 조직 생성 잠금 · 표를 얼린다(병렬 파일이 세는 값을 바꾸지 않게).
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('signup_org_create', 0))`);
      await client.query('LOCK TABLE organizations IN SHARE ROW EXCLUSIVE MODE');
      const consoleOrgs = (
        await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM organizations o WHERE o.signup_source = 'self_signup' AND o.created_at > now() - interval '24 hours'
              AND NOT EXISTS (SELECT 1 FROM signup_links l WHERE l.organization_id = o.id)`,
        )
      ).rows[0]?.n ?? 0;
      // 콘솔 상한이 찼다(가입 상한은 넉넉해도).
      await client.query('UPDATE signup_limits SET self_signup_daily_cap = 1000000, member_org_daily_cap = $1', [consoleOrgs]);
      expect(await attempt(`팀 ${suffix()}`)).toEqual({ code: 'AT429', detail: 'member_org_daily_cap' });
      // 가입 상한을 0 으로 내려도 콘솔 새 조직은 된다(따로 센다) — 콘솔 상한이 하나 남았을 때.
      await client.query('UPDATE signup_limits SET self_signup_daily_cap = 0, member_org_daily_cap = $1', [consoleOrgs + 1]);
      expect(await attempt(`팀 ${suffix()}`)).toMatchObject({ id: expect.any(String) });
      await client.query('UPDATE signup_limits SET member_org_daily_cap = 1000000');
      // 거절된 조직의 owner — account_restricted.
      await client.query(`UPDATE organizations SET review_status = 'rejected' WHERE id = $1`, [base.id]);
      expect(await attempt(`팀 ${suffix()}`)).toEqual({ code: 'AT429', detail: 'account_restricted' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
