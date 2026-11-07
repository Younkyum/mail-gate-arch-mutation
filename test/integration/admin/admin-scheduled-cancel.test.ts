/**
 * 콘솔 예약 취소(메일 기본기 1차 2회차 Y2 — 진윤겸 결정 2026-09-26): `POST /api/scheduled/{id}/cancel`.
 *
 * 라우터는 **`atmark_admin` 롤 풀**로 돈다(운영 admin Lambda 와 같은 롤) — 이 롤은 `scheduled_sends` 쓰기 권한이 없고 정의자 함수
 * `console_cancel_scheduled_send`(202609260125) EXECUTE 하나만 있다. 행 심기·확인은 소유자 롤. 실메일 0 · AWS 호출 0.
 *
 *   - 역할: owner·admin 성공 · member 403 `forbidden_role` · CSRF 없음 403 · 다른 조직 404(`schedule_not_found`)
 *   - 범위: 보호 예약(`agent_cancellable = false`)도 콘솔로는 취소된다 · 상한 없음
 *   - 판정: 발송됨 409 · 발송 중(임대·발송행) 409 · 재취소 200 `replayed`(감사 없음) · 사유 필수 400 · 메모 모양 400
 *   - 기록: 행 `cancelled_via = 'console'` · 감사 `owner_actions` 한 행(`scheduled.cancel`, 대상 = 예약 id)
 *   - 에이전트 상한(`http`·`mcp` 합 시간당 5)에 콘솔 취소가 세지지 않는다
 *   - 권한: admin 롤 허용 목록 = 실제 ACL · admin 은 표를 직접 못 고친다 · 함수는 DEFINER · pg_temp 마지막 · PUBLIC·앱 롤 실행 불가 · CHECK 검증됨
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminDeps, adminRolePool, appPool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, userIdOf, type Session } from './support';
import type { AdminDependencies } from '../../../src/admin/context';
import { createPostgresScheduledSendStore } from '../../../src/db/repositories/scheduled-send-store';
import { AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT, type AgentId } from '../../../src/db/schema';
import { ADMIN_ROLE, APP_ROLE_NAME, inspectRestrictedRole, RESTRICTED_ROLE_GRANTS } from '../../../src/runtime/role-bootstrap';

interface Fixture {
  readonly organizationId: string;
  readonly session: Session;
  readonly agentId: string;
  readonly address: string;
}

describe.skipIf(!AVAILABLE)('콘솔 예약 취소 — 메일 기본기 1차 Y2', () => {
  let owner: Pool;
  let admin: Pool;
  let app: Pool;
  let mailer: Pool;
  let deps: AdminDependencies;

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    app = appPool();
    mailer = loginMailerPool();
    deps = adminDeps(admin);
  });
  afterAll(async () => {
    await owner.end();
    await admin.end();
    await app.end();
    await mailer.end();
  });

  async function fixture(): Promise<Fixture> {
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'sc', localPart: `sc-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    return { organizationId: org.id, session, agentId: agent.id, address: agent.address };
  }

  async function roleSession(organizationId: string, role: 'admin' | 'member'): Promise<Session> {
    const email = `sched-${role}-${suffix()}@example.com`;
    await owner.query('INSERT INTO users (email) VALUES ($1)', [email]);
    const userId = await userIdOf(owner, email);
    await owner.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, $3, 'invite')`, [userId, organizationId, role]);
    return login(deps, mailer, { id: organizationId, ownerEmail: email });
  }

  /** 1시간 뒤 예약 하나(소유자 롤로 심는다). */
  async function schedule(f: Fixture, options: { agentCancellable?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO scheduled_sends
         (id, agent_id, idempotency_key, request_hash, from_address, recipients, send_at, content_storage_key, cost_cents, agent_cancellable)
       VALUES ($1::uuid, $2, $3, repeat('a', 64), $4, ARRAY['to@example.com'], now() + interval '1 hour',
               'outbound/scheduled/' || $1::text || '.json', 0, $5)`,
      [id, f.agentId, `idem-${id}`, f.address, options.agentCancellable ?? true],
    );
    return id;
  }

  function cancel(session: Session, id: string, body: unknown = { reasonCode: 'owner_request' }) {
    return call(deps, 'POST', `/api/scheduled/${id}/cancel`, authed(session, { body }));
  }

  async function rowOf(id: string): Promise<Record<string, unknown>> {
    const result = await owner.query(
      `SELECT status::text AS status, cancelled_via, cancel_reason_code, cancel_note, cancelled_at FROM scheduled_sends WHERE id = $1`,
      [id],
    );
    return result.rows[0] as Record<string, unknown>;
  }

  async function auditRows(organizationId: string, id: string): Promise<number> {
    const result = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM owner_actions WHERE organization_id = $1 AND action = 'scheduled.cancel' AND target_id = $2`,
      [organizationId, id],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  it('★ owner 취소 → 200 · 행 cancelled_via=console · 사유·메모 · 감사 1행(대상 = 예약 id) · 재취소는 replayed(감사 없음)', async () => {
    const f = await fixture();
    const id = await schedule(f);
    const done = await cancel(f.session, id, { reasonCode: 'wrong_recipient', note: ' 받는 사람을 바꿀 것 ' });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ id, status: 'cancelled', cancelReason: 'wrong_recipient', cancelledVia: 'console', replayed: false });
    expect(await rowOf(id)).toMatchObject({ status: 'cancelled', cancelled_via: 'console', cancel_reason_code: 'wrong_recipient', cancel_note: '받는 사람을 바꿀 것' });
    expect(await auditRows(f.organizationId, id)).toBe(1);

    const again = await cancel(f.session, id, { reasonCode: 'duplicate' });
    expect(again.statusCode, again.body).toBe(200);
    // 재생은 첫 기록을 돌려준다(쓰기 1회) — 두 번째 사유는 적히지 않는다.
    expect(again.json()).toMatchObject({ id, status: 'cancelled', cancelReason: 'wrong_recipient', cancelledVia: 'console', replayed: true });
    expect(await auditRows(f.organizationId, id)).toBe(1);

    // 콘솔 예약 로그에 경로 console 로 보인다.
    const listed = await call(deps, 'GET', '/api/logs', authed(f.session, { query: 'type=scheduled&decision=cancelled' }));
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: Record<string, unknown>[] }).items[0]).toMatchObject({ id, cancelledVia: 'console', cancelReason: 'wrong_recipient' });
  });

  it('★ 역할: admin 성공 · member 403 forbidden_role(행 그대로) · CSRF 없음 403', async () => {
    const f = await fixture();
    const byAdmin = await schedule(f);
    const adminSession = await roleSession(f.organizationId, 'admin');
    const ok = await cancel(adminSession, byAdmin);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await auditRows(f.organizationId, byAdmin)).toBe(1);

    const kept = await schedule(f);
    const memberSession = await roleSession(f.organizationId, 'member');
    const denied = await cancel(memberSession, kept);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'forbidden_role', required: 'admin' });
    const noCsrf = await call(deps, 'POST', `/api/scheduled/${kept}/cancel`, { cookies: f.session.cookies, body: { reasonCode: 'owner_request' } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ error: 'csrf_mismatch' });
    expect(await rowOf(kept)).toMatchObject({ status: 'scheduled', cancelled_via: null });
    expect(await auditRows(f.organizationId, kept)).toBe(0);
  });

  it('★ 다른 조직의 예약 → 404 schedule_not_found(없는 id 와 같다) · 행 그대로', async () => {
    const mine = await fixture();
    const theirs = await fixture();
    const id = await schedule(theirs);
    const probe = await cancel(mine.session, id);
    expect(probe.statusCode).toBe(404);
    expect(probe.json()).toMatchObject({ error: 'schedule_not_found' });
    const missing = await cancel(mine.session, randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'schedule_not_found' });
    expect(await rowOf(id)).toMatchObject({ status: 'scheduled', cancelled_via: null });
  });

  it('★ 보호 예약(agent_cancellable=false)도 콘솔로는 취소된다 — 에이전트 경로는 여전히 거부', async () => {
    const f = await fixture();
    const agentTry = await schedule(f, { agentCancellable: false });
    const store = createPostgresScheduledSendStore(app);
    const rejected = await store.cancel({
      id: agentTry,
      agentId: f.agentId as AgentId,
      channel: 'mcp',
      reasonCode: 'other',
      note: null,
      now: new Date(),
      agentHourlyLimit: AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT,
    });
    expect(rejected.kind).toBe('not_agent_cancellable');
    const done = await cancel(f.session, agentTry);
    expect(done.statusCode, done.body).toBe(200);
    expect(await rowOf(agentTry)).toMatchObject({ status: 'cancelled', cancelled_via: 'console', cancel_reason_code: 'owner_request' });
  });

  it('★ 발송됨 → 409 schedule_already_dispatched · 임대 중·발송행 → 409 schedule_in_flight(감사 없음)', async () => {
    const f = await fixture();
    const dispatched = await schedule(f);
    await owner.query(
      `UPDATE scheduled_sends SET status = 'dispatched', dispatched_at = now(), dispatch_outcome = 'sent' WHERE id = $1`,
      [dispatched],
    );
    const late = await cancel(f.session, dispatched);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: 'schedule_already_dispatched' });

    const leased = await schedule(f);
    await owner.query(`UPDATE scheduled_sends SET attempt_count = 1, lease_expires_at = now() + interval '5 minutes' WHERE id = $1`, [leased]);
    const sending = await cancel(f.session, leased);
    expect(sending.statusCode).toBe(409);
    expect(sending.json()).toMatchObject({ error: 'schedule_in_flight' });
    expect(await rowOf(leased)).toMatchObject({ status: 'scheduled' });
    for (const id of [dispatched, leased]) expect(await auditRows(f.organizationId, id)).toBe(0);
  });

  it('입력: 사유 없음·모르는 사유 400 invalid_reason_code · 메모 줄바꿈·201자 400 invalid_note · 모르는 키 400 · id 모양 400', async () => {
    const f = await fixture();
    const id = await schedule(f);
    for (const body of [{}, { reasonCode: 'because' }]) {
      const bad = await cancel(f.session, id, body);
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: 'invalid_reason_code' });
    }
    for (const note of ['a\nb', 'x'.repeat(201), 3]) {
      const bad = await cancel(f.session, id, { reasonCode: 'other', note });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: 'invalid_note' });
    }
    const extra = await cancel(f.session, id, { reasonCode: 'other', via: 'http' });
    expect(extra.json()).toMatchObject({ error: 'invalid_body' });
    const shape = await cancel(f.session, 'not-a-uuid');
    expect(shape.json()).toMatchObject({ error: 'invalid_schedule_id' });
    expect(await rowOf(id)).toMatchObject({ status: 'scheduled' });
  });

  it('★ 콘솔 취소는 에이전트 시간당 상한에 세지지 않는다 — 상한만큼 콘솔로 취소한 뒤에도 에이전트(HTTP) 취소가 된다', async () => {
    const f = await fixture();
    for (let i = 0; i < AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT + 1; i += 1) {
      const done = await cancel(f.session, await schedule(f));
      expect(done.statusCode, done.body).toBe(200);
    }
    const counted = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM scheduled_sends WHERE agent_id = $1 AND cancelled_via IN ('http', 'mcp') AND cancelled_at > now() - interval '1 hour'`,
      [f.agentId],
    );
    expect(counted.rows[0]?.n).toBe('0');
    const store = createPostgresScheduledSendStore(app);
    const agentCancel = await store.cancel({
      id: await schedule(f),
      agentId: f.agentId as AgentId,
      channel: 'http',
      reasonCode: 'no_longer_needed',
      note: null,
      now: new Date(),
      agentHourlyLimit: AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT,
    });
    expect(agentCancel.kind).toBe('cancelled');
  });

  it('★ 권한: admin 허용 목록 = 실제 ACL · admin 은 표를 직접 못 고친다 · 함수 DEFINER·pg_temp 마지막·PUBLIC·앱 롤 실행 불가 · CHECK 검증됨', async () => {
    const report = await inspectRestrictedRole(owner, ADMIN_ROLE);
    expect(report.grants).toEqual([...RESTRICTED_ROLE_GRANTS[ADMIN_ROLE]].sort());
    expect(report.problems).toEqual([]);
    expect(RESTRICTED_ROLE_GRANTS[ADMIN_ROLE]).toContain('function:console_cancel_scheduled_send:EXECUTE');
    expect(RESTRICTED_ROLE_GRANTS[ADMIN_ROLE].filter((grant) => grant.startsWith('scheduled_sends') && !grant.endsWith(':SELECT'))).toEqual([]);
    expect(RESTRICTED_ROLE_GRANTS[APP_ROLE_NAME]).not.toContain('function:console_cancel_scheduled_send:EXECUTE');

    const f = await fixture();
    const id = await schedule(f);
    // admin 롤이 경로를 위조해 직접 적는 길은 없다(칼럼 UPDATE 0).
    await expect(
      admin.query(`UPDATE scheduled_sends SET status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'other', cancelled_via = 'http' WHERE id = $1`, [id]),
    ).rejects.toThrow(/permission denied/);
    // 앱 롤(에이전트 경로)은 정의자 함수를 부를 수 없다 — 보호 플래그·상한 우회가 닫혀 있다.
    await expect(app.query(`SELECT * FROM console_cancel_scheduled_send($1::uuid, $2::uuid, 'other', NULL)`, [f.organizationId, id])).rejects.toThrow(
      /permission denied/,
    );

    const fn = await owner.query<{ definer: boolean; config: string[] | null; public_exec: boolean; admin_exec: boolean; app_exec: boolean }>(
      `SELECT p.prosecdef AS definer, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('atmark_admin', p.oid, 'EXECUTE') AS admin_exec,
              has_function_privilege('atmark_app', p.oid, 'EXECUTE') AS app_exec
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'console_cancel_scheduled_send'`,
    );
    expect(fn.rows).toEqual([{ definer: true, config: ['search_path=pg_catalog, public, pg_temp'], public_exec: false, admin_exec: true, app_exec: false }]);

    const check = await owner.query<{ def: string; valid: boolean }>(
      `SELECT pg_get_constraintdef(oid) AS def, convalidated AS valid FROM pg_constraint
        WHERE conrelid = 'scheduled_sends'::regclass AND conname = 'scheduled_sends_cancelled_via_check'`,
    );
    expect(check.rows).toHaveLength(1);
    expect(check.rows[0]?.valid).toBe(true);
    expect(check.rows[0]?.def).toContain("'console'");
    // CHECK 밖 경로는 소유자 롤로도 적히지 않는다.
    await expect(
      owner.query(`UPDATE scheduled_sends SET status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'other', cancelled_via = 'owner' WHERE id = $1`, [id]),
    ).rejects.toThrow(/scheduled_sends_cancelled_via_check/);
  });
});
