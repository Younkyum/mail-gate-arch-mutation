/**
 * 운영자 콘솔 **특권 행위 층**(202609290510) — 티켓 → 행위 정의 함수 → 소유자 코어. 실제 Postgres.
 *
 * 되돌리면 빨개져야 하는 것(§3.2 · §3.6 · §4 P1 수락 기준):
 *   - 활성화: (행위, 조직)에 묶인 window step-up · 다른 조직·11분 뒤는 AT403 · 티켓 한 행(xact_id) + 효과(조직 · 요금제 · 감사) 같은 커밋 · 감사 행위자 `ops:<uuid>`.
 *   - 거절: 대상 조직에 묶인 once · 재사용·다른 조직은 AT403 · 에이전트 운영자 정지 · 토큰 폐기(코어와 같은 결과).
 *   - 상한: 세션당 티켓 10분 20(21번째 AT429 ticket_cap) · 거절 세션 시간 3 · 전역 하루 10(AT429 action_cap).
 *   - H2: 티켓 ⇔ xact_id · 티켓은 ok · 실패 행은 티켓이 아니다. 효과 표는 트리거 밖에서 쓸 수 없다(H3).
 *   - 실패 기록: 세션당 10분 30 · 무효 세션이면 요청자 키로 센다(I-9).
 *   - CLI(소유자 롤) 경로는 zz_ 트리거에 걸리지 않는다(티켓 · 효과 0).
 *
 * 전역 상한(거절 하루 10)을 소모하는 거절은 **롤백하는 트랜잭션** 안에서 session_user 를 atmark_ops 로 바꿔 돌린다(`inOpsTx`) — append-only 원장에
 * 남기지 않는다. 그 트랜잭션 안에서 커밋된 오늘의 거절 티켓(다른 테스트·실행)을 하루 밖으로 되감아(`neutralizeRejectHistory`) 성공 경로를 늘 결정적으로
 * 본다. 활성화는 전역 상한이 없어 `atmark_ops` 로그인 풀로 실제로 커밋한다.
 */

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { reviewOrganizationOp } from '../../../src/ops/core/review';
import {
  AVAILABLE,
  backdate,
  hex64,
  inOpsTx,
  lockOpsSettings,
  neutralizeRejectHistory,
  operatorSession,
  opsPool,
  ownerPool,
  pgFailure,
  releaseOpsSettings,
  reviewFixture,
  stepUp,
  tidy,
  type OpsSession,
  type OpsSettingsLock,
} from './db-support';

const activate = (db: Pool | PoolClient, session: OpsSession, org: string) =>
  db.query<{ from_status: string; changed: boolean; grant: string; from_plan: string | null; kept_plan: string | null; version: number | null }>(
    'SELECT * FROM ops_org_activate($1, $2)',
    [session.sessionHash, org],
  );
const reject = (db: Pool | PoolClient, session: OpsSession, org: string) =>
  db.query<{ from_status: string; changed: boolean; suspended: string[]; revoked_tokens: number }>('SELECT * FROM ops_org_reject($1, $2)', [session.sessionHash, org]);

/** 가짜 티켓(소유자 · 롤백하는 트랜잭션 안에서만) — 상한 분자. xact_id 는 겹치지 않는 큰 값. */
async function fakeTickets(client: PoolClient, session: OpsSession, action: string, count: number): Promise<void> {
  await client.query(
    `INSERT INTO ops_actions (kind, result, operator_id, session_id, action, organization_id, xact_id)
     SELECT 'ticket', 'ok', $1, $2, $3, gen_random_uuid(), (9000000000000 + (random() * 1e12)::bigint + g)::text::xid8
       FROM generate_series(1, $4) g`,
    [session.operatorId, session.sessionId, action, count],
  );
}

describe.skipIf(!AVAILABLE)('운영자 콘솔 특권 행위(202609290510)', () => {
  let owner: Pool;
  let ops: Pool;
  let lock: OpsSettingsLock | undefined;
  beforeAll(async () => {
    owner = ownerPool(4);
    ops = opsPool();
    lock = await lockOpsSettings(owner);
  });
  beforeEach(async () => {
    await tidy(owner);
  });
  afterAll(async () => {
    await releaseOpsSettings(lock);
    await ops.end();
    await owner.end();
  });

  it('활성화 — window step-up · 티켓 + 효과(검토 상태만 — 베타 부여 꺼짐)가 같은 커밋 · 같은 조직은 창 안에서 다시 · 다른 조직은 AT403', async () => {
    const session = await operatorSession(ops, owner);
    const org = await reviewFixture(owner, { agents: false });
    const other = await reviewFixture(owner, { agents: false });
    expect(await pgFailure(() => activate(ops, session, org.id))).toEqual({ code: 'AT403', detail: 'step_up_required' });
    const ref = await stepUp(ops, owner, session, 'org.activate', { org: org.id });
    expect(ref).toMatch(/^[0-9A-Z]{4}$/);
    const first = (await activate(ops, session, org.id)).rows[0];
    // 베타 자동 부여는 꺼졌다(202609301520 — SQL 스위치 false) — 활성화는 검토 상태만 바꾸고 요금제 행을 만들지 않는다(= Free).
    expect(first).toEqual({ from_status: 'pending_review', changed: true, grant: 'disabled', from_plan: null, kept_plan: null, version: null });
    const ticket = (
      await owner.query<{ id: string; action: string; organization_id: string; has_xact: boolean }>(
        `SELECT id, action, organization_id, xact_id IS NOT NULL AS has_xact FROM ops_actions WHERE kind = 'ticket' AND session_id = $1 ORDER BY id`,
        [session.sessionId],
      )
    ).rows;
    expect(ticket).toEqual([{ id: expect.any(String), action: 'org.activate', organization_id: org.id, has_xact: true }]);
    const effects = (
      await owner.query<{ table_name: string; op: string }>('SELECT table_name, op FROM ops_action_effects WHERE action_id = $1 ORDER BY table_name, op', [ticket[0]?.id])
    ).rows;
    expect(effects).toEqual([{ table_name: 'organizations', op: 'UPDATE' }]);
    expect((await owner.query('SELECT actor, cause FROM billing_audit WHERE organization_id = $1', [org.id])).rows).toEqual([]);
    expect((await owner.query('SELECT 1 FROM org_entitlements WHERE organization_id = $1', [org.id])).rowCount).toBe(0);
    // 창 안에서 같은 조직 — 변경 없음(티켓은 또 남는다).
    expect((await activate(ops, session, org.id)).rows[0]).toMatchObject({ changed: false, grant: 'none' });
    // 창은 (행위, 조직)에 묶인다.
    expect((await pgFailure(() => activate(ops, session, other.id)))?.detail).toBe('step_up_required');
    // 11분 뒤는 창이 닫혔다.
    await backdate(
      owner,
      `UPDATE ops_step_up_grants SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE session_id = $1`,
      [session.sessionId],
    );
    expect((await pgFailure(() => activate(ops, session, org.id)))?.detail).toBe('step_up_required');
  });

  it('거절 — once(대상 조직) · 에이전트 운영자 정지 · 토큰 폐기 · 재사용과 다른 조직은 AT403 (롤백)', async () => {
    const session = await operatorSession(ops, owner);
    const org = await reviewFixture(owner);
    const other = await reviewFixture(owner, { agents: false });
    await stepUp(ops, owner, session, 'org.reject', { org: org.id });
    await inOpsTx(owner, async (tx) => {
      await tx.asOps();
      expect(await pgFailure(() => reject(tx.client, session, other.id))).toEqual({ code: 'AT403', detail: 'step_up_required' });
    });
    await inOpsTx(owner, async (tx) => {
      await neutralizeRejectHistory(tx.client);
      await tx.asOps();
      const row = (await reject(tx.client, session, org.id)).rows[0];
      expect(row).toEqual({
        from_status: 'pending_review',
        changed: true,
        suspended: [org.agents['active'], org.agents['ownerSuspended']].sort(),
        revoked_tokens: 3,
      });
      await tx.client.query('SAVEPOINT again');
      expect(await pgFailure(() => reject(tx.client, session, org.id))).toEqual({ code: 'AT403', detail: 'step_up_required' });
      await tx.client.query('ROLLBACK TO SAVEPOINT again');
      await tx.asOwner();
      const agents = (
        await tx.client.query<{ id: string; status: string; suspended_by: string | null }>('SELECT id, status::text, suspended_by FROM agents WHERE organization_id = $1', [org.id])
      ).rows;
      expect(agents.find((agent) => agent.id === org.agents['provisioning'])).toMatchObject({ status: 'provisioning', suspended_by: null });
      expect(agents.find((agent) => agent.id === org.agents['active'])).toMatchObject({ status: 'suspended', suspended_by: 'operator' });
      const ticket = (await tx.client.query<{ id: string }>(`SELECT id FROM ops_actions WHERE kind = 'ticket' AND xact_id = pg_current_xact_id()`)).rows[0];
      const tables = (await tx.client.query<{ table_name: string }>('SELECT DISTINCT table_name FROM ops_action_effects WHERE action_id = $1 ORDER BY 1', [ticket?.id])).rows;
      expect(tables.map((row) => row.table_name)).toEqual(['agent_api_keys', 'agents', 'organizations']);
    });
  });

  it('상한 — 세션 티켓 10분 20 → AT429 ticket_cap · 거절 세션 시간 3 · 전역 하루 10 → AT429 action_cap (롤백)', async () => {
    const session = await operatorSession(ops, owner);
    const peer = await operatorSession(ops, owner);
    const org = await reviewFixture(owner, { agents: false });
    await stepUp(ops, owner, session, 'org.activate', { org: org.id });
    await inOpsTx(owner, async (tx) => {
      await fakeTickets(tx.client, session, 'org.activate', 20);
      await tx.asOps();
      expect(await pgFailure(() => activate(tx.client, session, org.id))).toEqual({ code: 'AT429', detail: 'ticket_cap' });
    });
    await stepUp(ops, owner, session, 'org.reject', { org: org.id });
    await inOpsTx(owner, async (tx) => {
      await neutralizeRejectHistory(tx.client);
      await fakeTickets(tx.client, session, 'org.reject', 3);
      await tx.asOps();
      expect(await pgFailure(() => reject(tx.client, session, org.id))).toEqual({ code: 'AT429', detail: 'action_cap' });
    });
    await inOpsTx(owner, async (tx) => {
      await neutralizeRejectHistory(tx.client);
      await fakeTickets(tx.client, peer, 'org.reject', 9);
      await tx.asOps();
      // 9 개면(전역 하루 10 의 안쪽) 된다 — 바로 이 호출이 10번째다.
      await tx.client.query('SAVEPOINT tenth');
      expect((await reject(tx.client, session, org.id)).rows[0]?.changed).toBe(true);
      await tx.client.query('ROLLBACK TO SAVEPOINT tenth');
      await tx.asOwner();
      await fakeTickets(tx.client, peer, 'org.reject', 1);
      await tx.asOps();
      expect(await pgFailure(() => reject(tx.client, session, org.id))).toEqual({ code: 'AT429', detail: 'action_cap' });
    });
    // 상한 밖이면(가짜 티켓 없이) 된다 — 같은 once 허가가 아직 살아 있다(앞의 거부는 롤백됐다). 커밋된 기록과 무관하게 늘 성공 경로다.
    await inOpsTx(owner, async (tx) => {
      await neutralizeRejectHistory(tx.client);
      await tx.asOps();
      expect((await reject(tx.client, session, org.id)).rows[0]?.changed).toBe(true);
    });
  });

  it('H2 — 티켓 ⇔ xact_id · 티켓은 ok · 실패 행은 티켓이 될 수 없다 · 효과 표는 트리거 밖 INSERT 거부(H3)', async () => {
    const session = await operatorSession(ops, owner);
    await inOpsTx(owner, async ({ client }) => {
      for (const sql of [
        `INSERT INTO ops_actions (kind, result, code, xact_id) VALUES ('failure', 'failed', 'forbidden', pg_current_xact_id())`,
        `INSERT INTO ops_actions (kind, result, operator_id, session_id, action, organization_id, xact_id) VALUES ('ticket', 'failed', $1, $2, 'org.reject', gen_random_uuid(), pg_current_xact_id())`,
        `INSERT INTO ops_actions (kind, result, operator_id, session_id, action, organization_id) VALUES ('ticket', 'ok', $1, $2, 'org.reject', gen_random_uuid())`,
      ]) {
        await client.query('SAVEPOINT s');
        const values = sql.includes('$1') ? [session.operatorId, session.sessionId] : [];
        expect((await pgFailure(() => client.query(sql, values)))?.code, sql).toBe('23514');
        await client.query('ROLLBACK TO SAVEPOINT s');
      }
      const ticket = await client.query<{ id: string }>(
        `INSERT INTO ops_actions (kind, result, operator_id, session_id, action, organization_id, xact_id)
         VALUES ('ticket', 'ok', $1, $2, 'org.activate', gen_random_uuid(), pg_current_xact_id()) RETURNING id`,
        [session.operatorId, session.sessionId],
      );
      await client.query('SAVEPOINT s');
      expect(
        (await pgFailure(() => client.query(`INSERT INTO ops_action_effects (action_id, table_name, row_key, op) VALUES ($1, 'agents', 'x', 'UPDATE')`, [ticket.rows[0]?.id])))?.code,
      ).toBe('42501');
      await client.query('ROLLBACK TO SAVEPOINT s');
      for (const sql of ['UPDATE ops_actions SET result = $1', 'DELETE FROM ops_actions WHERE id = $1']) {
        await client.query('SAVEPOINT s');
        expect((await pgFailure(() => client.query(sql, [sql.startsWith('UPDATE') ? 'ok' : ticket.rows[0]?.id])))?.code, sql).toBe('23514');
        await client.query('ROLLBACK TO SAVEPOINT s');
      }
    });
  });

  it('실패 기록 — 세션당 10분 30(넘으면 조용히 버린다) · 무효 세션이면 요청자 키로 센다', async () => {
    const session = await operatorSession(ops, owner);
    for (let i = 0; i < 31; i += 1) {
      await ops.query('SELECT ops_record_failure($1, $2, $3, $4, $5, $6)', [session.sessionHash, session.clientKey, 'org.reject', null, null, 'step_up_required']);
    }
    expect((await owner.query(`SELECT count(*)::int AS n FROM ops_actions WHERE kind = 'failure' AND session_id = $1`, [session.sessionId])).rows[0]).toEqual({ n: 30 });
    const client = hex64();
    await ops.query('SELECT ops_record_failure($1, $2, $3, $4, $5, $6)', [hex64(), client, 'nope', null, 'not-an-agent', 'Bad Code!']);
    expect(
      (await owner.query(`SELECT result, action, agent_id, code, session_id FROM ops_actions WHERE kind = 'failure' AND client_key = $1`, [client])).rows,
    ).toEqual([{ result: 'failed', action: null, agent_id: null, code: 'unknown', session_id: null }]);
  });

  it('CLI(소유자 롤) 경로는 zz_ 트리거에 걸리지 않는다 — 티켓 · 효과 0, 전이는 같다', async () => {
    const org = await reviewFixture(owner);
    const before = (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM ops_action_effects')).rows[0]?.n ?? 0;
    expect((await reviewOrganizationOp(owner, org.id, 'active', 'admin:org-review:ops-it')).changed).toBe(true);
    expect((await reviewOrganizationOp(owner, org.id, 'rejected', 'admin:org-review:ops-it')).suspended).toEqual(
      [org.agents['active'], org.agents['ownerSuspended']].sort(),
    );
    expect((await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM ops_action_effects')).rows[0]?.n ?? 0).toBe(before);
  });
});
