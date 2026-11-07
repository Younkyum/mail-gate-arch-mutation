/**
 * 운영자 콘솔 **적대적 사례**(`.omc/plans/ops-console.md` §4 P1 수락 기준 · 사전 부검 1·3). 실제 Postgres.
 *
 *   - `atmark_ops` 의 도메인 표 · ops 표 직접 쓰기 → 42501. 코어 · 티켓 · 스위치 직접 호출 → 42501.
 *   - 세션이 없거나 · 만료 · 유휴 · 폐기 · 운영자 비활성 → 행위 AT401. 콘솔 닫힘 · 하드 잠금 → AT503.
 *   - 테스트용 정의 함수(소유자 소유)로 **티켓 없이** 도메인 표를 쓰면 zz_ 트리거가 42501 · 다른 조직의 티켓도 안 된다 · 같은 조직의 티켓이면 되고 효과가 남는다.
 *   - H1: 정의 함수로 CLI 출신 운영자 행을 바꾸려 해도 session_user 가 atmark_ops 면 42501.
 *   - 접근 요청 전역 시간당 6번째 · 대기 요청 6번째는 **조용히** 기록하지 않는다(응답은 같다).
 *   - login-mailer 는 다이제스트·결속을 읽지 못하고 검증 함수를 부르지 못한다. 앱 롤은 ops 표 0.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addOperator,
  appPool,
  AVAILABLE,
  backdate,
  CODE,
  deliver,
  hex64,
  inOpsTx,
  latestChallenge,
  lockOpsSettings,
  mailerPool,
  operatorSession,
  opsPool,
  ownerPool,
  pgFailure,
  releaseOpsSettings,
  reviewFixture,
  stepUp,
  suffix,
  testEmail,
  tidy,
  type OpsSettingsLock,
} from './db-support';

describe.skipIf(!AVAILABLE)('운영자 콘솔 — 적대적 사례', () => {
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

  it('atmark_ops 직접 쓰기(도메인 · ops 표)와 코어·티켓·스위치 직접 호출은 42501', async () => {
    const org = await reviewFixture(owner, { agents: false });
    for (const sql of [
      `UPDATE organizations SET review_status = 'active' WHERE id = $1`,
      `UPDATE organizations SET abuse_freeze = true WHERE id = $1`,
      `UPDATE agents SET status = 'suspended' WHERE organization_id = $1`,
      `UPDATE agent_api_keys SET revoked_at = now() WHERE agent_id IN (SELECT id FROM agents WHERE organization_id = $1)`,
      `INSERT INTO billing_audit (organization_id, to_plan, cause, actor, entitlement_version) VALUES ($1, 'beta', 'review', 'x', 1)`,
      `INSERT INTO org_entitlements (organization_id, plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max, agent_per_minute_max,
         recipients_per_message_max, tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes, version)
       VALUES ($1, 'beta', 'operator', 'review', 10, 1000, 10, 10, 10, 5, 1, 1, 1, 1)`,
      `UPDATE ops_operators SET status = 'active' WHERE id = $1`,
      `UPDATE ops_settings SET console_enabled = false WHERE $1::uuid IS NOT NULL`,
      `INSERT INTO ops_actions (kind, result, organization_id) VALUES ('failure', 'failed', $1)`,
      `UPDATE ops_login_challenges SET code_failures = 0 WHERE id = $1`,
      `SELECT * FROM ops_org_activate_core($1, 'ops:forged')`,
      `SELECT * FROM ops_org_reject_core($1)`,
      `SELECT ops_authorize('${hex64()}', 'org.reject', $1)`,
      `SELECT ops_ticket_allows($1)`,
      `SELECT ops_activation_beta_enabled() WHERE $1::uuid IS NOT NULL`,
      `SELECT ops_upsert_access_request($1::text)`,
    ]) {
      expect((await pgFailure(() => ops.query(sql, [org.id])))?.code, sql).toBe('42501');
    }
    // 비밀 칸은 읽지 못한다.
    for (const sql of ['SELECT token_hash FROM ops_sessions LIMIT 1', 'SELECT code_digest FROM ops_login_challenges LIMIT 1', 'SELECT failure_salt FROM ops_settings']) {
      expect((await pgFailure(() => ops.query(sql)))?.code, sql).toBe('42501');
    }
  });

  it('세션 없음 · 만료 · 유휴 · 폐기 · 운영자 비활성 → 행위 AT401 session_invalid', async () => {
    const org = await reviewFixture(owner, { agents: false });
    const call = (hash: string) => pgFailure(() => ops.query('SELECT * FROM ops_org_activate($1, $2)', [hash, org.id]));
    expect(await call(hex64())).toEqual({ code: 'AT401', detail: 'session_invalid' });
    const expired = await operatorSession(ops, owner);
    await backdate(owner, `UPDATE ops_sessions SET created_at = now() - interval '9 hours', expires_at = now() - interval '1 hour' WHERE id = $1`, [expired.sessionId]);
    expect((await call(expired.sessionHash))?.code).toBe('AT401');
    const idle = await operatorSession(ops, owner);
    await backdate(owner, `UPDATE ops_sessions SET last_seen_at = now() - interval '31 minutes' WHERE id = $1`, [idle.sessionId]);
    expect((await call(idle.sessionHash))?.code).toBe('AT401');
    const revoked = await operatorSession(ops, owner);
    await ops.query('SELECT ops_session_revoke($1, false)', [revoked.sessionHash]);
    expect((await call(revoked.sessionHash))?.code).toBe('AT401');
    const inactive = await operatorSession(ops, owner);
    await owner.query(`UPDATE ops_operators SET status = 'revoked' WHERE id = $1`, [inactive.operatorId]);
    expect((await call(inactive.sessionHash))?.code).toBe('AT401');
    expect((await pgFailure(() => ops.query('SELECT ops_request_stepup($1, $2, $3, $4, $5)', [inactive.sessionHash, hex64(), 'org.activate', org.id, null])))?.code).toBe(
      'AT401',
    );
  });

  it('콘솔 닫힘 · 하드 잠금 → 행위 AT503 ops_disabled (세션이 살아 있어도)', async () => {
    const session = await operatorSession(ops, owner);
    const org = await reviewFixture(owner, { agents: false });
    await stepUp(ops, owner, session, 'org.activate', { org: org.id });
    for (const setting of ['console_enabled = false', 'hard_locked = true']) {
      await owner.query(`UPDATE ops_settings SET ${setting}`);
      expect(await pgFailure(() => ops.query('SELECT * FROM ops_org_activate($1, $2)', [session.sessionHash, org.id])), setting).toEqual({
        code: 'AT503',
        detail: 'ops_disabled',
      });
      await owner.query('UPDATE ops_settings SET console_enabled = true, hard_locked = false');
    }
  });

  it('테스트용 정의 함수로 티켓 없이 도메인 쓰기 → zz_ 트리거 42501 · 다른 조직의 티켓도 42501 · 같은 조직 티켓이면 쓰이고 효과가 남는다 (롤백)', async () => {
    const session = await operatorSession(ops, owner);
    const org = await reviewFixture(owner, { agents: false });
    const other = await reviewFixture(owner, { agents: false });
    const fn = `ops_it_backdoor_${suffix()}`;
    await inOpsTx(owner, async (tx) => {
      await tx.client.query(
        `CREATE FUNCTION ${fn}(p_org uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
           AS $$ UPDATE public.organizations SET name = name || '!' WHERE id = p_org $$`,
      );
      await tx.asOps();
      await tx.client.query('SAVEPOINT s');
      expect(await pgFailure(() => tx.client.query(`SELECT ${fn}($1)`, [org.id]))).toEqual({ code: '42501', detail: 'ticket_violation' });
      await tx.client.query('ROLLBACK TO SAVEPOINT s');
      // 이 트랜잭션의 티켓(조직 org) — 소유자가 적어 둔다.
      await tx.asOwner();
      const ticket = await tx.client.query<{ id: string }>(
        `INSERT INTO ops_actions (kind, result, operator_id, session_id, action, organization_id, xact_id)
         VALUES ('ticket', 'ok', $1, $2, 'org.activate', $3, pg_current_xact_id()) RETURNING id`,
        [session.operatorId, session.sessionId, org.id],
      );
      await tx.asOps();
      await tx.client.query('SAVEPOINT s');
      expect(await pgFailure(() => tx.client.query(`SELECT ${fn}($1)`, [other.id]))).toEqual({ code: '42501', detail: 'ticket_violation' });
      await tx.client.query('ROLLBACK TO SAVEPOINT s');
      await tx.client.query(`SELECT ${fn}($1)`, [org.id]);
      await tx.asOwner();
      expect((await tx.client.query('SELECT table_name, row_key, op FROM ops_action_effects WHERE action_id = $1', [ticket.rows[0]?.id])).rows).toEqual([
        { table_name: 'organizations', row_key: org.id, op: 'UPDATE' },
      ]);
    });
    // 소유자 세션의 같은 쓰기는 zz_ 가 보지 않는다(다른 롤·경로는 무변경, I-3).
    await owner.query(`UPDATE organizations SET name = name || '.' WHERE id = $1`, [org.id]);
  });

  it('H1 — 정의 함수로도 CLI 출신 운영자 행은 session_user = atmark_ops 이면 바뀌지 않는다(42501) · 콘솔은 requested 만 적는다 (롤백)', async () => {
    const cli = await addOperator(owner);
    const fn = `ops_it_h1_${suffix()}`;
    await inOpsTx(owner, async (tx) => {
      await tx.client.query(
        `CREATE FUNCTION ${fn}(p_id uuid, p_email text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
         BEGIN
           IF p_id IS NOT NULL THEN UPDATE public.ops_operators SET status = 'revoked' WHERE id = p_id; END IF;
           IF p_email IS NOT NULL THEN INSERT INTO public.ops_operators (email, status, origin) VALUES (p_email, 'active', 'console'); END IF;
         END $$`,
      );
      await tx.asOps();
      await tx.client.query('SAVEPOINT s');
      expect((await pgFailure(() => tx.client.query(`SELECT ${fn}($1, NULL)`, [cli.id])))?.code).toBe('42501');
      await tx.client.query('ROLLBACK TO SAVEPOINT s');
      expect((await pgFailure(() => tx.client.query(`SELECT ${fn}(NULL, $1)`, [testEmail()])))?.code).toBe('42501');
    });
  });

  it('접근 요청 전역 시간당 6번째 · 대기 6번째는 조용히 기록하지 않는다(응답 모양은 같다)', async () => {
    // 전역 시간당 5 — 테스트 흔적 밖의 접근 요청 도전이 이미 있으면 그만큼 적게 만든다.
    const already = (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ops_login_challenges WHERE purpose = 'access_request' AND created_at > now() - interval '1 hour'`))
      .rows[0]?.n ?? 0;
    for (let i = already; i < 5; i += 1) await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [testEmail(), hex64(), hex64(), 'ko']);
    const sixth = testEmail();
    expect(await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [sixth, hex64(), hex64(), 'ko']).then((r) => r.rowCount)).toBe(1);
    expect(await latestChallenge(owner, { email: sixth })).toBeNull();
    // 로그인 목적은 이 상한에 세지 않는다.
    const operator = await addOperator(owner);
    await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [operator.email, hex64(), hex64(), 'ko']);
    expect((await latestChallenge(owner, { email: operator.email }))?.purpose).toBe('login');

    // 대기 5 — 도전을 만든 뒤(아직 4) 대기를 5 로 채우면 검증 결과가 pending_cap 이고 행이 생기지 않는다.
    await tidy(owner);
    const email = testEmail();
    const binding = hex64();
    await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [email, binding, hex64(), 'ko']);
    const challenge = await latestChallenge(owner, { email });
    expect(challenge?.purpose).toBe('access_request');
    await deliver(owner, challenge?.id ?? '');
    const pending = (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ops_operators WHERE status = 'requested'`)).rows[0]?.n ?? 0;
    for (let i = pending; i < 5; i += 1) {
      await owner.query(`INSERT INTO ops_operators (email, status, origin, requested_at) VALUES ($1, 'requested', 'console', now())`, [testEmail()]);
    }
    const verified = await ops.query<{ outcome: string }>('SELECT outcome FROM ops_login_verify($1, $2, $3, $4, $5)', [binding, hex64(), CODE, hex64(), hex64()]);
    expect(verified.rows[0]?.outcome).toBe('pending_cap');
    expect((await owner.query('SELECT 1 FROM ops_operators WHERE email = $1', [email])).rowCount).toBe(0);
    // DB 가드도 여섯째를 막는다(정의 함수가 아닌 경로 — 소유자도).
    expect((await pgFailure(() => owner.query(`INSERT INTO ops_operators (email, status, origin, requested_at) VALUES ($1, 'requested', 'console', now())`, [testEmail()])))?.code).toBe(
      'AT429',
    );
    // 대기가 찼으면 새 주소의 코드도 나가지 않는다.
    const late = testEmail();
    await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [late, hex64(), hex64(), 'ko']);
    expect(await latestChallenge(owner, { email: late })).toBeNull();
  });

  it('login-mailer 는 다이제스트·결속·요청자 키를 읽지 못하고 검증·요청 함수를 부르지 못한다 · 앱 롤은 ops 표 0', async () => {
    const mailer = mailerPool();
    const app = appPool();
    try {
      for (const sql of [
        'SELECT code_digest FROM ops_login_challenges LIMIT 1',
        'SELECT binding FROM ops_login_challenges LIMIT 1',
        'SELECT client_key FROM ops_login_challenges LIMIT 1',
        'SELECT token_hash FROM ops_sessions LIMIT 1',
        `UPDATE ops_login_challenges SET code_failures = 0 WHERE false`,
        `UPDATE ops_login_challenges SET used_at = now() WHERE false`,
        `SELECT * FROM ops_login_verify('${hex64()}', '${hex64()}', '000000', '${hex64()}', '${hex64()}')`,
        `SELECT ops_request_code('a@b.example', '${hex64()}', '${hex64()}', 'ko')`,
      ]) {
        expect((await pgFailure(() => mailer.query(sql)))?.code, sql).toBe('42501');
      }
      expect((await mailer.query('SELECT id, purpose, email, status FROM ops_login_challenges LIMIT 1')).rowCount).toBeGreaterThanOrEqual(0);
      for (const sql of ['SELECT 1 FROM ops_login_challenges LIMIT 1', 'SELECT 1 FROM ops_actions LIMIT 1', 'SELECT ops_mailer_set_digest(gen_random_uuid(), repeat(\'a\', 64))']) {
        expect((await pgFailure(() => app.query(sql)))?.code, sql).toBe('42501');
      }
    } finally {
      await mailer.end();
      await app.end();
    }
  });
});
