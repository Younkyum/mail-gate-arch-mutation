/**
 * 운영자 콘솔 **신원 층**(202609290500) — 실제 Postgres, `atmark_ops` 로그인 풀과 소유자 롤. 메일 0(소유자가 다이제스트를 적는다).
 *
 * 되돌리면 빨개져야 하는 것(§3.3~3.6 · §4 P1 수락 기준):
 *   - 표 칸 = `OPS_TABLE_COLUMNS` · 설정 한 행(지우기 거부 · 솔트 불변 · 기본 닫힘).
 *   - 로그인: 틀린 코드는 `invalid`(후보 +1) · 맞으면 세션 · 한 번만 · 5번 틀리면 죽는다 · 쓰면 다이제스트 NULL(H11).
 *   - 세션: touch 가 last_seen 을 민다 · UA 가 바뀌면 폐기 · 유휴 30분 · 절대 8시간 · 로그아웃 · 폐기한 세션은 빈 결과.
 *   - 요청자 15분 10회 → AT429 · 콘솔 닫힘/하드 잠금 → AT503.
 *   - 접근 요청: 코드 검증 뒤에만 requested(콘솔 출신) · 다시 요청하면 pending · 승인·거절은 대상에 묶인 once step-up · 자기 결정 금지 · 거절 7일 쿨다운.
 *   - 폐기: once · CLI 출신 불가(H1) · 마지막 운영자 불가 · 자기 자신 가능 · 대상 세션·코드 무효.
 *   - 메일러 다이제스트: 같은 값 ok · 다른 값 dead(키 회전) · 닫힌 도전 dead.
 *   - 주소 실패 50 → 24시간 코드 발급 0 → CLI `--unlock` 뒤 다시 발급 · census.
 *   - 보존 · 요청 만료(7일) · census(앱 롤 함수 셋).
 *   - 하드 킬 스위치: hard_locked 면 bootstrap 이 NOLOGIN 을 유지 · status 는 hard_locked && LOGIN 을 ok=false · ops-role-lock 은 NOLOGIN + 백엔드 종료.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OPS_TABLE_COLUMNS, OPS_TABLES } from '../../../src/db/schema';
import { addressLockedUntilOp, unlockAddressOp } from '../../../src/db/repositories/ops-operators';
import { createPostgresOpsRetention } from '../../../src/db/repositories/ops-retention';
import { createMigrateHandler, type MigrationStatus } from '../../../src/runtime/handlers/migrate';
import { bootstrapRoles, lockOpsRole, unlockOpsRole } from '../../../src/runtime/role-bootstrap';
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
  login,
  operatorSession,
  opsPool,
  OTHER_CODE,
  ownerPool,
  pgFailure,
  releaseOpsSettings,
  reviewFixture,
  stepUp,
  testEmail,
  tidy,
  type OpsSettingsLock,
} from './db-support';

const verify = (ops: Pool, binding: string, client: string, code: string) =>
  ops
    .query<{ outcome: string; operator_id: string | null; session_id: string | null }>('SELECT * FROM ops_login_verify($1, $2, $3, $4, $5)', [
      binding,
      client,
      code,
      hex64(),
      hex64(),
    ])
    .then((result) => result.rows[0]);

const touch = (ops: Pool, session: { sessionHash: string; uaHash: string; clientKey: string }, ua = session.uaHash) =>
  ops.query<{ operator_id: string; email: string }>('SELECT * FROM ops_session_touch($1, $2, $3)', [session.sessionHash, ua, session.clientKey]).then((r) => r.rows);

describe.skipIf(!AVAILABLE)('운영자 콘솔 신원 층(202609290500)', () => {
  let owner: Pool;
  let ops: Pool;
  let lock: OpsSettingsLock | undefined;
  beforeAll(async () => {
    owner = ownerPool(4);
    ops = opsPool();
    lock = await lockOpsSettings(owner);
  });
  // 접근 요청 전역 시간당 5 · 대기 5 는 DB 전체 — 사례마다 테스트 흔적을 치운다(테스트 주소만).
  beforeEach(async () => {
    await tidy(owner);
  });
  afterAll(async () => {
    await releaseOpsSettings(lock);
    await ops.end();
    await owner.end();
  });

  it('표 칸 = OPS_TABLE_COLUMNS(양방향) · 설정은 한 행 · 지우기 거부 · 솔트 불변', async () => {
    for (const table of OPS_TABLES) {
      const columns = await owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`,
        [table],
      );
      expect(columns.rows.map((row) => row.column_name), table).toEqual([...OPS_TABLE_COLUMNS[table]].sort());
    }
    expect((await owner.query('SELECT 1 FROM ops_settings')).rowCount).toBe(1);
    expect((await pgFailure(() => owner.query('DELETE FROM ops_settings')))?.code).toBe('23514');
    expect((await pgFailure(() => owner.query(`UPDATE ops_settings SET failure_salt = repeat('0', 64)`)))?.code).toBe('23514');
  });

  it('로그인 — 틀린 코드는 invalid(+1) · 맞으면 세션 · 한 번만 · 쓰면 다이제스트 NULL', async () => {
    const operator = await addOperator(owner);
    const binding = hex64();
    const client = hex64();
    await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [`  ${operator.email.toUpperCase()} `, binding, client, 'en']);
    const challenge = await latestChallenge(owner, { email: operator.email });
    expect(challenge?.purpose).toBe('login');
    await deliver(owner, challenge?.id ?? '');
    expect(await verify(ops, binding, client, OTHER_CODE)).toEqual({ outcome: 'invalid', operator_id: null, session_id: null });
    expect((await owner.query('SELECT code_failures FROM ops_login_challenges WHERE id = $1', [challenge?.id])).rows[0]).toEqual({ code_failures: 1 });
    const ok = await verify(ops, binding, client, CODE);
    expect(ok?.outcome).toBe('session');
    expect(ok?.operator_id).toBe(operator.id);
    expect((await owner.query('SELECT code_digest, used_at IS NOT NULL AS used FROM ops_login_challenges WHERE id = $1', [challenge?.id])).rows[0]).toEqual({
      code_digest: null,
      used: true,
    });
    expect((await verify(ops, binding, client, CODE))?.outcome).toBe('invalid');
    // 코드 모양이 아니면 후보를 건드리지 않고 invalid.
    expect((await verify(ops, binding, client, '12ab56'))?.outcome).toBe('invalid');
  });

  it('5번 틀리면 그 도전은 죽는다(다이제스트 NULL) — 맞는 코드도 invalid', async () => {
    const operator = await addOperator(owner);
    const binding = hex64();
    const client = hex64();
    await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [operator.email, binding, client, 'ko']);
    const challenge = await latestChallenge(owner, { email: operator.email });
    await deliver(owner, challenge?.id ?? '');
    for (let i = 0; i < 5; i += 1) expect((await verify(ops, binding, client, OTHER_CODE))?.outcome).toBe('invalid');
    expect((await owner.query('SELECT code_failures, code_digest FROM ops_login_challenges WHERE id = $1', [challenge?.id])).rows[0]).toEqual({
      code_failures: 5,
      code_digest: null,
    });
    expect((await verify(ops, binding, client, CODE))?.outcome).toBe('invalid');
  });

  it('세션 — touch 가 민다 · UA 가 바뀌면 폐기(빈 결과) · 유휴 30분 · 절대 8시간 · 로그아웃', async () => {
    const session = await operatorSession(ops, owner);
    expect(await touch(ops, session)).toEqual([expect.objectContaining({ operator_id: session.operatorId, email: session.email })]);
    // IP 가 바뀌면 기록만(세션은 산다).
    expect(await ops.query('SELECT * FROM ops_session_touch($1, $2, $3)', [session.sessionHash, session.uaHash, hex64()]).then((r) => r.rowCount)).toBe(1);
    expect((await owner.query(`SELECT count(*)::int AS n FROM ops_actions WHERE session_id = $1 AND result = 'ip_changed'`, [session.sessionId])).rows[0]).toEqual({ n: 1 });

    const ua = await operatorSession(ops, owner);
    expect(await touch(ops, ua, hex64())).toEqual([]);
    expect(await touch(ops, ua)).toEqual([]);
    expect((await owner.query('SELECT revoke_reason FROM ops_sessions WHERE id = $1', [ua.sessionId])).rows[0]).toEqual({ revoke_reason: 'ua_changed' });

    const idle = await operatorSession(ops, owner);
    await backdate(owner, `UPDATE ops_sessions SET last_seen_at = now() - interval '31 minutes' WHERE id = $1`, [idle.sessionId]);
    expect(await touch(ops, idle)).toEqual([]);

    const old = await operatorSession(ops, owner);
    await backdate(owner, `UPDATE ops_sessions SET created_at = now() - interval '9 hours', expires_at = now() - interval '1 hour' WHERE id = $1`, [old.sessionId]);
    expect(await touch(ops, old)).toEqual([]);

    const out = await operatorSession(ops, owner);
    expect((await ops.query<{ n: number }>('SELECT ops_session_revoke($1, false) AS n', [out.sessionHash])).rows[0]?.n).toBe(1);
    expect(await touch(ops, out)).toEqual([]);
    expect((await ops.query<{ n: number }>('SELECT ops_session_revoke($1, false) AS n', [out.sessionHash])).rows[0]?.n).toBe(0);
  });

  it('요청자 15분 10회 → 11번째 AT429 rate_limited(주소와 무관 · 조용한 상한과 별개)', async () => {
    // 활성 운영자 주소로(로그인 목적 — 접근 요청 전역 시간당 5 를 소모하지 않는다). (주소, 요청자) 시간 3 은 조용히 거르지만 요청 수는 센다.
    const operator = await addOperator(owner);
    const client = hex64();
    for (let i = 0; i < 10; i += 1) await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [operator.email, hex64(), client, 'ko']);
    expect((await owner.query('SELECT count(*)::int AS n FROM ops_login_challenges WHERE email = $1', [operator.email])).rows[0]).toEqual({ n: 3 });
    expect(await pgFailure(() => ops.query('SELECT ops_request_code($1, $2, $3, $4)', [operator.email, hex64(), client, 'ko']))).toEqual({
      code: 'AT429',
      detail: 'rate_limited',
    });
  });

  it('콘솔 닫힘 · 하드 잠금이면 AT503 ops_disabled', async () => {
    await owner.query('UPDATE ops_settings SET console_enabled = false');
    expect(await pgFailure(() => ops.query('SELECT ops_request_code($1, $2, $3, $4)', [testEmail(), hex64(), hex64(), 'ko']))).toEqual({
      code: 'AT503',
      detail: 'ops_disabled',
    });
    await owner.query('UPDATE ops_settings SET console_enabled = true, hard_locked = true');
    expect((await pgFailure(() => ops.query('SELECT * FROM ops_session_touch($1, $2, $3)', [hex64(), hex64(), hex64()])))?.code).toBe('AT503');
    await owner.query('UPDATE ops_settings SET hard_locked = false');
  });

  it('접근 요청 — 코드 검증 뒤에만 requested(콘솔 출신) · 다시 요청하면 pending · 활성 운영자는 로그인 목적', async () => {
    const email = testEmail();
    const binding = hex64();
    const client = hex64();
    await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [email, binding, client, 'ko']);
    const challenge = await latestChallenge(owner, { email });
    expect(challenge?.purpose).toBe('access_request');
    expect((await owner.query('SELECT 1 FROM ops_operators WHERE email = $1', [email])).rowCount).toBe(0);
    await deliver(owner, challenge?.id ?? '');
    expect((await verify(ops, binding, client, CODE))?.outcome).toBe('requested');
    expect((await owner.query('SELECT status, origin FROM ops_operators WHERE email = $1', [email])).rows[0]).toEqual({ status: 'requested', origin: 'console' });
    expect((await owner.query(`SELECT actor FROM ops_operator_events e JOIN ops_operators o ON o.id = e.operator_id WHERE o.email = $1`, [email])).rows).toEqual([
      { actor: 'console:access_request' },
    ]);
    // 같은 주소로 다시 — 코드를 검증하면 pending(기록은 하나).
    const again = hex64();
    await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [email, again, hex64(), 'ko']);
    await deliver(owner, (await latestChallenge(owner, { email }))?.id ?? '');
    expect((await verify(ops, again, hex64(), CODE))?.outcome).toBe('pending');
    expect((await owner.query('SELECT count(*)::int AS n FROM ops_operators WHERE email = $1', [email])).rows[0]).toEqual({ n: 1 });
    // 결속이 다르면(다른 브라우저) 후보가 없다 — invalid.
    expect((await verify(ops, hex64(), hex64(), CODE))?.outcome).toBe('invalid');
  });

  it('승인·거절 — 대상에 묶인 once step-up · 자기 결정 금지 · 거절 7일 쿨다운', async () => {
    const approver = await operatorSession(ops, owner);
    const requests: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const email = testEmail();
      const binding = hex64();
      await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [email, binding, hex64(), 'ko']);
      await deliver(owner, (await latestChallenge(owner, { email }))?.id ?? '');
      expect((await verify(ops, binding, hex64(), CODE))?.outcome).toBe('requested');
      requests.push((await owner.query<{ id: string }>('SELECT id FROM ops_operators WHERE email = $1', [email])).rows[0]?.id ?? '');
    }
    const [first = '', second = ''] = requests;
    // step-up 없이는 AT403.
    expect(await pgFailure(() => ops.query('SELECT ops_decide_request($1, $2, $3)', [approver.sessionHash, first, 'approve']))).toEqual({
      code: 'AT403',
      detail: 'step_up_required',
    });
    await stepUp(ops, owner, approver, 'operator.approve', { operator: first });
    // 다른 대상에는 쓰이지 않는다.
    expect((await pgFailure(() => ops.query('SELECT ops_decide_request($1, $2, $3)', [approver.sessionHash, second, 'approve'])))?.detail).toBe('step_up_required');
    expect((await ops.query<{ r: string }>('SELECT ops_decide_request($1, $2, $3) AS r', [approver.sessionHash, first, 'approve'])).rows[0]?.r).toBe('ok');
    expect((await owner.query('SELECT status, decided_by FROM ops_operators WHERE id = $1', [first])).rows[0]).toEqual({ status: 'active', decided_by: approver.operatorId });
    expect((await owner.query(`SELECT actor FROM ops_operator_events WHERE operator_id = $1 AND to_status = 'active'`, [first])).rows[0]).toEqual({
      actor: `ops:${approver.operatorId}`,
    });
    // 자기 결정 금지.
    expect((await pgFailure(() => ops.query('SELECT ops_decide_request($1, $2, $3)', [approver.sessionHash, approver.operatorId, 'deny'])))?.detail).toBe('self_decision');
    // 거절 → denied → 7일 안의 재요청은 cooldown.
    await stepUp(ops, owner, approver, 'operator.deny', { operator: second });
    expect((await ops.query<{ r: string }>('SELECT ops_decide_request($1, $2, $3) AS r', [approver.sessionHash, second, 'deny'])).rows[0]?.r).toBe('ok');
    const email = (await owner.query<{ email: string }>('SELECT email FROM ops_operators WHERE id = $1', [second])).rows[0]?.email ?? '';
    const binding = hex64();
    await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [email, binding, hex64(), 'ko']);
    await deliver(owner, (await latestChallenge(owner, { email }))?.id ?? '');
    expect((await verify(ops, binding, hex64(), CODE))?.outcome).toBe('cooldown');
    // CLI 출신 대상 → cli_operator(H1 — 가드의 42501 보다 먼저 계약 코드로).
    const cli = await addOperator(owner);
    expect((await pgFailure(() => ops.query('SELECT ops_decide_request($1, $2, $3)', [approver.sessionHash, cli.id, 'approve'])))?.detail).toBe('cli_operator');
    // 이미 active 인 대상 → not_requested.
    expect((await pgFailure(() => ops.query('SELECT ops_decide_request($1, $2, $3)', [approver.sessionHash, first, 'deny'])))?.detail).toBe('not_requested');
  });

  it('폐기 — once · CLI 출신 불가(H1) · 자기 자신 가능 · 대상 세션·코드 무효 · 마지막 운영자 불가', async () => {
    const admin = await operatorSession(ops, owner);
    const target = await operatorSession(ops, owner, 'console');
    const cli = await addOperator(owner);
    expect((await pgFailure(() => ops.query('SELECT ops_revoke_operator($1, $2)', [admin.sessionHash, cli.id])))?.detail).toBe('cli_operator');
    expect((await pgFailure(() => ops.query('SELECT ops_revoke_operator($1, $2)', [admin.sessionHash, target.operatorId])))?.detail).toBe('step_up_required');
    await stepUp(ops, owner, admin, 'operator.revoke', { operator: target.operatorId });
    expect((await ops.query<{ r: string }>('SELECT ops_revoke_operator($1, $2) AS r', [admin.sessionHash, target.operatorId])).rows[0]?.r).toBe('ok');
    expect(await touch(ops, target)).toEqual([]);
    expect((await owner.query('SELECT revoke_reason FROM ops_sessions WHERE id = $1', [target.sessionId])).rows[0]).toEqual({ revoke_reason: 'operator_revoked' });
    // 자기 자신(콘솔 출신)도 폐기할 수 있다.
    const self = await operatorSession(ops, owner, 'console');
    await stepUp(ops, owner, self, 'operator.revoke', { operator: self.operatorId });
    expect((await ops.query<{ r: string }>('SELECT ops_revoke_operator($1, $2) AS r', [self.sessionHash, self.operatorId])).rows[0]?.r).toBe('ok');
    // 마지막 운영자 — 한 트랜잭션 안에서 다른 active 를 모두 거둔 뒤(롤백).
    const last = await operatorSession(ops, owner, 'console');
    await stepUp(ops, owner, last, 'operator.revoke', { operator: last.operatorId });
    const failure = await inOpsTx(owner, async (tx) => {
      await tx.client.query(`UPDATE ops_operators SET status = 'revoked' WHERE status = 'active' AND id <> $1`, [last.operatorId]);
      await tx.asOps();
      return pgFailure(() => tx.client.query('SELECT ops_revoke_operator($1, $2)', [last.sessionHash, last.operatorId]));
    });
    expect(failure).toEqual({ code: 'AT403', detail: 'last_operator' });
  });

  it('메일러 다이제스트 — 같은 값 ok(재시도) · 다른 값 dead(키 회전, 예외 없음) · 쓰인 도전 dead', async () => {
    const operator = await addOperator(owner);
    await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [operator.email, hex64(), hex64(), 'ko']);
    const id = (await latestChallenge(owner, { email: operator.email }))?.id ?? '';
    const set = (digest: string) => owner.query<{ r: string }>('SELECT ops_mailer_set_digest($1, $2) AS r', [id, digest]).then((r) => r.rows[0]?.r);
    const first = hex64();
    expect(await set(first)).toBe('ok');
    expect(await set(first)).toBe('ok');
    expect(await set(hex64())).toBe('dead');
    expect((await owner.query('SELECT status, last_error, code_digest FROM ops_login_challenges WHERE id = $1', [id])).rows[0]).toEqual({
      status: 'dead',
      last_error: 'key_rotated',
      code_digest: null,
    });
    expect(await set(first)).toBe('dead');
  });

  it('주소 실패 50 → 24시간 코드 발급 0(조용히) → --unlock 뒤 다시 발급 · census 에 잠긴 주소', async () => {
    const operator = await addOperator(owner);
    const binding = hex64();
    const client = hex64();
    await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [operator.email, binding, client, 'ko']);
    await deliver(owner, (await latestChallenge(owner, { email: operator.email }))?.id ?? '');
    // 오늘 49번 틀린 것으로 두고(소유자) 한 번 더 틀린다 → 50 → 잠금.
    await owner.query(
      `INSERT INTO ops_address_failures (address_hash, day, failures) VALUES (ops_address_hash($1), (now() AT TIME ZONE 'UTC')::date, 49)
       ON CONFLICT (address_hash, day) DO UPDATE SET failures = 49, locked_until = NULL`,
      [operator.email],
    );
    expect((await verify(ops, binding, client, OTHER_CODE))?.outcome).toBe('invalid');
    expect(await addressLockedUntilOp(owner, operator.email)).not.toBeNull();
    const census = await createPostgresOpsRetention(owner).census();
    expect(census?.addressesLocked).toBeGreaterThanOrEqual(1);
    // 잠긴 동안: 요청은 받지만 도전은 생기지 않는다(열거 동형).
    await owner.query(`UPDATE ops_login_challenges SET invalidated_at = now() WHERE email = $1 AND used_at IS NULL AND invalidated_at IS NULL`, [operator.email]);
    await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [operator.email, hex64(), hex64(), 'ko']);
    expect(await latestChallenge(owner, { email: operator.email })).toBeNull();
    // CLI --unlock.
    expect(await unlockAddressOp(owner, operator.email)).toBeGreaterThanOrEqual(1);
    expect(await addressLockedUntilOp(owner, operator.email)).toBeNull();
    await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [operator.email, hex64(), hex64(), 'ko']);
    expect((await latestChallenge(owner, { email: operator.email }))?.purpose).toBe('login');
  });

  it('보존 · 7일 요청 만료 · census — 앱 롤은 함수 셋만(표는 0)', async () => {
    const app = appPool();
    try {
      const email = testEmail();
      await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [email, hex64(), hex64(), 'ko']);
      const old = (await latestChallenge(owner, { email }))?.id ?? '';
      await backdate(owner, `UPDATE ops_login_challenges SET created_at = now() - interval '2 days', expires_at = now() - interval '2 days' + interval '5 minutes' WHERE id = $1`, [old]);
      const requested = await owner.query<{ id: string }>(
        `INSERT INTO ops_operators (email, status, origin, requested_at) VALUES ($1, 'requested', 'console', now()) RETURNING id`,
        [testEmail()],
      );
      await backdate(owner, `UPDATE ops_operators SET requested_at = now() - interval '8 days' WHERE id = $1`, [requested.rows[0]?.id]);
      const retention = createPostgresOpsRetention(app);
      expect(await retention.purge()).toBeGreaterThanOrEqual(1);
      expect((await owner.query('SELECT 1 FROM ops_login_challenges WHERE id = $1', [old])).rowCount).toBe(0);
      expect(await retention.expire()).toBeGreaterThanOrEqual(1);
      expect((await owner.query('SELECT status FROM ops_operators WHERE id = $1', [requested.rows[0]?.id])).rows[0]).toEqual({ status: 'expired' });
      const census = await retention.census();
      expect(census).toEqual({
        active: expect.any(Number),
        pending: expect.any(Number),
        addressesFailingToday: expect.any(Number),
        addressesLocked: expect.any(Number),
      });
      expect(census?.active).toBeGreaterThan(0);
      expect((await pgFailure(() => app.query('SELECT 1 FROM ops_operators LIMIT 1')))?.code).toBe('42501');
    } finally {
      await app.end();
    }
  });

  it('하드 킬 스위치 — hard_locked 면 bootstrap 이 NOLOGIN 유지 · status 는 hard_locked && LOGIN 을 ok=false (롤백)', async () => {
    const statusOn = async (client: import('pg').PoolClient): Promise<MigrationStatus> => {
      const borrowed = { query: client.query.bind(client), release: () => undefined };
      const handler = createMigrateHandler({
        owner: () => Promise.resolve({ deps: null, pool: { connect: () => Promise.resolve(borrowed), end: () => Promise.resolve() } as never }),
        bootstrap: () => Promise.reject(new Error('no bootstrap')),
      });
      return (await handler({ action: 'status' }, { awsRequestId: 'r', invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:m', callbackWaitsForEmptyEventLoop: true })) as MigrationStatus;
    };
    const canLogin = async (client: import('pg').PoolClient): Promise<boolean | undefined> =>
      (await client.query<{ rolcanlogin: boolean }>(`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'atmark_ops'`)).rows[0]?.rolcanlogin;
    await inOpsTx(owner, async ({ client }) => {
      const database = (await client.query<{ db: string }>('SELECT current_database() AS db')).rows[0]?.db ?? '';
      await client.query('UPDATE ops_settings SET hard_locked = true');
      // 검사 4 — rolconfig 의 유휴 종료가 빠지면 ok=false(부트스트랩이 다시 넣는다).
      await client.query('ALTER ROLE atmark_ops RESET idle_session_timeout');
      expect((await statusOn(client)).ops?.roleConfigProblems).toEqual(['idle_session_timeout 없음']);
      // 잠겼는데 LOGIN 이 살아 있다 → ok=false.
      const leaked = await statusOn(client);
      expect([leaked.ok, leaked.ops?.hardLockedButCanLogin]).toEqual([false, true]);
      // 비밀이 비어 있는 재부트스트랩(비밀번호를 새로 건다)도 NOLOGIN 을 건다.
      const filled = { secretFilled: true } as const;
      const result = await bootstrapRoles(client, database, {
        owner: filled,
        app: filled,
        admin: filled,
        loginMailer: filled,
        passportSigner: filled,
        tlog: filled,
        tlogAnchor: filled,
        billing: filled,
        billingOperator: filled,
        ops: { secretFilled: false },
        domainTick: filled,
        aiWatch: filled,
      });
      expect(result.ops.action).toBe('password_set');
      expect(await canLogin(client)).toBe(false);
      expect((await client.query<{ rolconfig: string[] }>(`SELECT rolconfig FROM pg_roles WHERE rolname = 'atmark_ops'`)).rows[0]?.rolconfig).toEqual(
        expect.arrayContaining(['statement_timeout=5s', 'lock_timeout=2s', 'idle_in_transaction_session_timeout=10s', 'idle_session_timeout=120s']),
      );
      expect((await statusOn(client)).ops?.roleConfigProblems).toEqual([]);
      expect((await statusOn(client)).ops?.hardLockedButCanLogin).toBe(false);
    });
    // 롤백 뒤 — 다시 LOGIN 이고 hard_locked 는 거짓.
    expect((await owner.query(`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'atmark_ops'`)).rows[0]).toEqual({ rolcanlogin: true });
    expect((await owner.query('SELECT hard_locked FROM ops_settings')).rows[0]).toEqual({ hard_locked: false });
  });
  it('step-up — 이 세션의 가장 최근 살아 있는 도전 하나만 대조한다(옛 도전의 코드는 invalid · 옛 도전은 건드리지 않는다)', async () => {
    const session = await operatorSession(ops, owner);
    const org = await reviewFixture(owner, { agents: false });
    const request = () =>
      ops.query('SELECT ops_request_stepup($1, $2, $3, $4, $5)', [session.sessionHash, session.clientKey, 'org.activate', org.id, null]);
    await request();
    const older = await latestChallenge(owner, { sessionId: session.sessionId });
    await deliver(owner, older?.id ?? '', CODE);
    await request();
    const newer = await latestChallenge(owner, { sessionId: session.sessionId });
    await deliver(owner, newer?.id ?? '', OTHER_CODE);
    const verifyStep = (code: string) =>
      ops.query<{ outcome: string }>('SELECT outcome FROM ops_stepup_verify($1, $2, $3)', [session.sessionHash, session.clientKey, code]).then((r) => r.rows[0]?.outcome);
    expect(await verifyStep(CODE)).toBe('invalid');
    const failures = (id: string | undefined) =>
      owner.query<{ code_failures: number }>('SELECT code_failures FROM ops_login_challenges WHERE id = $1', [id]).then((r) => r.rows[0]?.code_failures);
    expect([await failures(older?.id), await failures(newer?.id)]).toEqual([0, 1]);
    expect(await verifyStep(OTHER_CODE)).toBe('ok');
  });

  it('step-up — 세션당 틀린 코드 10 이면 그 자리에서 세션 폐기(step_up_failures) · 다음 호출은 AT401', async () => {
    const session = await operatorSession(ops, owner);
    const org = await reviewFixture(owner, { agents: false });
    const verifyStep = () =>
      ops.query<{ outcome: string }>('SELECT outcome FROM ops_stepup_verify($1, $2, $3)', [session.sessionHash, hex64(), '000000']).then((r) => r.rows[0]?.outcome);
    for (let round = 0; round < 2; round += 1) {
      await ops.query('SELECT ops_request_stepup($1, $2, $3, $4, $5)', [session.sessionHash, session.clientKey, 'org.activate', org.id, null]);
      await deliver(owner, (await latestChallenge(owner, { sessionId: session.sessionId }))?.id ?? '', OTHER_CODE);
      for (let i = 0; i < 5; i += 1) expect(await verifyStep()).toBe('invalid');
    }
    expect((await owner.query('SELECT step_up_failures, revoke_reason FROM ops_sessions WHERE id = $1', [session.sessionId])).rows[0]).toEqual({
      step_up_failures: 10,
      revoke_reason: 'step_up_failures',
    });
    expect(await touch(ops, session)).toEqual([]);
    expect((await pgFailure(() => ops.query('SELECT * FROM ops_stepup_verify($1, $2, $3)', [session.sessionHash, hex64(), OTHER_CODE])))?.code).toBe('AT401');
    // 후보가 없으면(시험한 것이 없다) 세지 않는다.
    const quiet = await operatorSession(ops, owner);
    expect((await ops.query<{ outcome: string }>('SELECT outcome FROM ops_stepup_verify($1, $2, $3)', [quiet.sessionHash, hex64(), '000000'])).rows[0]?.outcome).toBe('invalid');
    expect((await owner.query('SELECT step_up_failures FROM ops_sessions WHERE id = $1', [quiet.sessionId])).rows[0]).toEqual({ step_up_failures: 0 });
  });

  it('로그인 검증 실패는 시험한 후보마다 그 주소에 실패 하나(중복 제거 없음) — 주소 하루 50 이 추측 수를 묶는다', async () => {
    const operator = await addOperator(owner);
    const binding = hex64();
    const client = hex64();
    for (let i = 0; i < 3; i += 1) {
      await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [operator.email, binding, client, 'ko']);
      await deliver(owner, (await latestChallenge(owner, { email: operator.email }))?.id ?? '');
    }
    const failuresToday = () =>
      owner
        .query<{ n: number }>(
          `SELECT coalesce(sum(failures), 0)::int AS n FROM ops_address_failures WHERE address_hash = ops_address_hash($1) AND day = (now() AT TIME ZONE 'UTC')::date`,
          [operator.email],
        )
        .then((r) => r.rows[0]?.n ?? 0);
    const before = await failuresToday();
    expect((await verify(ops, binding, client, OTHER_CODE))?.outcome).toBe('invalid');
    expect((await failuresToday()) - before).toBe(3);
  });

  it('ops-role-lock — NOLOGIN 을 먼저 커밋하고 트랜잭션 밖에서 백엔드를 끊는다 · 남은 백엔드 0 · 새 로그인 거부 · unlock 뒤 다시 된다', async () => {
    const probePool = opsPool();
    const probe = await probePool.connect();
    probe.on('error', () => undefined);
    const client = await owner.connect();
    try {
      await probe.query('SELECT 1');
      await owner.query('UPDATE ops_settings SET hard_locked = true');
      const locked = await lockOpsRole(client);
      expect(locked).toMatchObject({ canLogin: false, remaining: 0, hardLocked: true });
      expect(locked.terminated).toBeGreaterThanOrEqual(1);
      // 커밋된 NOLOGIN — 다른 세션이 본다.
      expect((await owner.query(`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'atmark_ops'`)).rows[0]).toEqual({ rolcanlogin: false });
      expect(await pgFailure(() => probe.query('SELECT 1'))).not.toBeNull();
      const fresh = opsPool();
      try {
        expect((await pgFailure(() => fresh.query('SELECT 1')))?.code).toBe('28000');
      } finally {
        await fresh.end().catch(() => undefined);
      }
    } finally {
      const unlocked = await unlockOpsRole(client);
      await owner.query('UPDATE ops_settings SET hard_locked = false');
      client.release();
      probe.release(true);
      await probePool.end().catch(() => undefined);
      expect(unlocked).toMatchObject({ canLogin: true, terminated: 0 });
    }
    expect((await ops.query<{ one: number }>('SELECT 1 AS one')).rows[0]).toEqual({ one: 1 });
  });
  it('step-up 검증 — 세션 행을 잠근 뒤 다시 본다: 동시에 폐기된 세션이면 AT401 session_invalid (INFO-2)', async () => {
    const session = await operatorSession(ops, owner);
    const org = await reviewFixture(owner, { agents: false });
    await ops.query('SELECT ops_request_stepup($1, $2, $3, $4, $5)', [session.sessionHash, session.clientKey, 'org.activate', org.id, null]);
    await deliver(owner, (await latestChallenge(owner, { sessionId: session.sessionId }))?.id ?? '', OTHER_CODE);
    const holder = await owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE ops_sessions SET revoked_at = now(), revoke_reason = 'logout' WHERE id = $1`, [session.sessionId]);
      // 검증은 세션을 판정(아직 커밋 전이라 살아 있다)한 뒤 세션 행 잠금에서 기다린다.
      const pending = pgFailure(() => ops.query('SELECT * FROM ops_stepup_verify($1, $2, $3)', [session.sessionHash, session.clientKey, OTHER_CODE]));
      const deadline = Date.now() + 5_000;
      for (;;) {
        const waiting = await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'atmark_ops' AND wait_event_type = 'Lock'`,
        );
        if ((waiting.rows[0]?.n ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error('검증이 세션 행 잠금을 기다리지 않는다');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await holder.query('COMMIT');
      expect(await pending).toEqual({ code: 'AT401', detail: 'session_invalid' });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    // 도전은 쓰이지 않았다.
    expect((await owner.query('SELECT used_at FROM ops_login_challenges WHERE session_id = $1', [session.sessionId])).rows).toEqual([{ used_at: null }]);
  });
});
