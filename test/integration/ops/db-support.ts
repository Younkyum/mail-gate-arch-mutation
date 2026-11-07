/**
 * 운영자 콘솔 **DB 층** 통합 테스트(W-DB)의 공용 지반 — 진짜 로컬 Postgres(`atmark_v2`, 202609290500·0510 적용). AWS·메일 0.
 *
 *   - 롤: 소유자(`TEST_MIGRATION_DATABASE_URL`) · `atmark_ops` · `atmark_login_mailer` · 앱 · admin — 제한 롤은 앱 URL 의 사용자만 바꾼다(로컬 trust,
 *     `test/integration/signup/support.ts` 와 같은 규칙). `atmark_ops` 는 CONNECTION LIMIT 3 이라 풀은 max 1 로 연다.
 *   - **직렬화**: `ops_settings` 는 DB 전체 한 행이라, ops 통합 파일은 소유자 연결의 세션 advisory lock(`atmark.test.ops-settings` — W-APP 의
 *     `hosted-support.ts` 와 같은 키)을 파일 내내 쥐고, 콘솔을 연 뒤 끝나면 원래 값으로 되돌린다.
 *   - 메일 대신: 소유자 롤이 `ops_mailer_set_digest(id, ops_code_digest(id, code))` 로 다이제스트를 적고 `sent` 로 표시한다(login-mailer 와 같은 함수).
 *   - 테스트 주소는 `ops-db-<난수>@example.com` · 요청자 키는 테스트마다 난수(요청자 상한이 섞이지 않게).
 */

import { randomBytes } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { createPool } from '../../../src/db/client';

export const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
export const APP_URL = process.env['TEST_DATABASE_URL'] ?? '';
export const AVAILABLE = OWNER_URL.trim() !== '' && APP_URL.trim() !== '';

export function roleUrl(role: string, explicit?: string): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  if (APP_URL.trim() === '') return '';
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

export const ownerPool = (max = 4): Pool => createPool(OWNER_URL, { max });
/** `atmark_ops` 풀 — 하드 잠금 테스트가 백엔드를 끊을 수 있어 유휴 연결 오류를 삼킨다(다음 쿼리가 다시 붙는다). */
export function opsPool(): Pool {
  const pool = createPool(roleUrl('atmark_ops', process.env['TEST_OPS_DATABASE_URL']), { max: 1 });
  pool.on('error', () => undefined);
  return pool;
}
export const mailerPool = (): Pool => createPool(roleUrl('atmark_login_mailer', process.env['TEST_LOGIN_MAILER_DATABASE_URL']), { max: 1 });
export const appPool = (): Pool => createPool(APP_URL, { max: 1 });
export const adminPool = (): Pool => createPool(roleUrl('atmark_admin', process.env['TEST_ADMIN_DATABASE_URL']), { max: 1 });

export const hex64 = (): string => randomBytes(32).toString('hex');
export const suffix = (): string => randomBytes(4).toString('hex');
export const testEmail = (): string => `ops-db-${suffix()}@example.com`;
export const CODE = '314159';
export const OTHER_CODE = '271828';

/** PG 오류의 SQLSTATE · DETAIL(없으면 `null`). */
export async function pgFailure(run: () => Promise<unknown>): Promise<{ code: string; detail: string | null } | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const record = error as { code?: unknown; detail?: unknown };
    return { code: String(record.code), detail: typeof record.detail === 'string' ? record.detail : null };
  }
}

export const OPS_TEST_LOCK = 'atmark.test.ops-settings';

export interface OpsSettingsLock {
  readonly client: PoolClient;
  readonly saved: { readonly console_enabled: boolean; readonly hard_locked: boolean };
}

/** 파일 내내 쥐는 직렬화 잠금 + 콘솔 열기. 이 파일이 남긴 흔적만 치운다(`ops-db-%`). */
export async function lockOpsSettings(owner: Pool): Promise<OpsSettingsLock> {
  const client = await owner.connect();
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [OPS_TEST_LOCK]);
  const saved = (await client.query<{ console_enabled: boolean; hard_locked: boolean }>('SELECT console_enabled, hard_locked FROM ops_settings')).rows[0] ?? {
    console_enabled: false,
    hard_locked: false,
  };
  await client.query('UPDATE ops_settings SET console_enabled = true, hard_locked = false');
  await tidy(client);
  return { client, saved };
}

/**
 * 접근 요청 전역 시간당 5 · 대기 5 는 DB 전체라, 테스트 주소(이 파일들의 `ops-db-%` · W-APP 의 `ops-it-%`)의 흔적만 치운다(소유자 롤). ops 통합 파일은
 * 같은 잠금 아래에서만 돌므로 다른 파일의 진행 중 도전을 지우지 않는다.
 */
export async function tidy(db: Pool | PoolClient): Promise<void> {
  const tests = `(email LIKE 'ops-db-%@example.com' OR email LIKE 'ops-it-%@example.com')`;
  await db.query(`DELETE FROM ops_login_challenges WHERE ${tests}`);
  await db.query(`UPDATE ops_operators SET status = 'expired' WHERE status = 'requested' AND ${tests}`);
}

export async function releaseOpsSettings(lock: OpsSettingsLock | undefined): Promise<void> {
  if (lock === undefined) return;
  await tidy(lock.client).catch(() => undefined);
  await lock.client
    .query('UPDATE ops_settings SET console_enabled = $1, hard_locked = $2', [lock.saved.console_enabled, lock.saved.hard_locked])
    .catch(() => undefined);
  await lock.client.query('SELECT pg_advisory_unlock(hashtext($1))', [OPS_TEST_LOCK]).catch(() => undefined);
  lock.client.release();
}

/** CLI 처럼 소유자 롤로 활성 운영자(origin cli). */
export async function addOperator(owner: Pool, email = testEmail(), origin: 'cli' | 'console' = 'cli'): Promise<{ id: string; email: string }> {
  const row = await owner.query<{ id: string }>(`INSERT INTO ops_operators (email, status, origin) VALUES ($1, 'active', $2) RETURNING id`, [email, origin]);
  return { id: row.rows[0]?.id ?? '', email };
}

/** login-mailer 대신 — 도전 하나에 다이제스트를 적고 sent. */
export async function deliver(owner: Pool, challengeId: string, code = CODE): Promise<void> {
  const set = await owner.query<{ r: string }>('SELECT ops_mailer_set_digest($1, ops_code_digest($1, $2)) AS r', [challengeId, code]);
  if (set.rows[0]?.r !== 'ok') throw new Error(`digest not ok: ${String(set.rows[0]?.r)}`);
  await owner.query(`UPDATE ops_login_challenges SET status = 'sent', sent_at = now() WHERE id = $1`, [challengeId]);
}

/** 가장 최근 도전(발송 전). */
export async function latestChallenge(owner: Pool, where: { readonly email?: string; readonly sessionId?: string }): Promise<{ id: string; purpose: string; target_ref: string | null } | null> {
  const row = await owner.query<{ id: string; purpose: string; target_ref: string | null }>(
    `SELECT id, purpose, target_ref FROM ops_login_challenges
      WHERE ($1::text IS NULL OR email = $1) AND ($2::uuid IS NULL OR session_id = $2) AND status = 'pending'
      ORDER BY created_at DESC, id LIMIT 1`,
    [where.email ?? null, where.sessionId ?? null],
  );
  return row.rows[0] ?? null;
}

export interface OpsSession {
  readonly operatorId: string;
  readonly sessionId: string;
  readonly sessionHash: string;
  readonly uaHash: string;
  readonly clientKey: string;
  readonly email: string;
}

/** 코드 요청 → 배달 → 검증 = 세션. 운영자는 active 여야 한다. */
export async function login(ops: Pool, owner: Pool, email: string, clientKey = hex64()): Promise<OpsSession> {
  const binding = hex64();
  await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [email, binding, clientKey, 'ko']);
  const challenge = await latestChallenge(owner, { email });
  if (challenge === null || challenge.purpose !== 'login') throw new Error(`login challenge missing for ${email}`);
  await deliver(owner, challenge.id);
  const sessionHash = hex64();
  const uaHash = hex64();
  const verified = await ops.query<{ outcome: string; operator_id: string; session_id: string }>(
    'SELECT outcome, operator_id, session_id FROM ops_login_verify($1, $2, $3, $4, $5)',
    [binding, clientKey, CODE, sessionHash, uaHash],
  );
  const row = verified.rows[0];
  if (row?.outcome !== 'session') throw new Error(`login failed: ${String(row?.outcome)}`);
  return { operatorId: row.operator_id, sessionId: row.session_id, sessionHash, uaHash, clientKey, email };
}

/** step-up 요청 → 배달 → 검증. 대상 참조. */
export async function stepUp(
  ops: Pool,
  owner: Pool,
  session: OpsSession,
  action: string,
  target: { readonly org?: string; readonly operator?: string },
): Promise<string> {
  const requested = await ops.query<{ ref: string }>('SELECT ops_request_stepup($1, $2, $3, $4, $5) AS ref', [
    session.sessionHash,
    session.clientKey,
    action,
    target.org ?? null,
    target.operator ?? null,
  ]);
  const challenge = await latestChallenge(owner, { sessionId: session.sessionId });
  if (challenge === null) throw new Error('step-up challenge missing');
  await deliver(owner, challenge.id, OTHER_CODE);
  const verified = await ops.query<{ outcome: string; target_ref: string }>('SELECT outcome, target_ref FROM ops_stepup_verify($1, $2, $3)', [
    session.sessionHash,
    session.clientKey,
    OTHER_CODE,
  ]);
  if (verified.rows[0]?.outcome !== 'ok') throw new Error('step-up verify failed');
  if (verified.rows[0].target_ref !== requested.rows[0]?.ref) throw new Error('target_ref mismatch');
  return requested.rows[0]?.ref ?? '';
}

/** 가입 조직(pending_review) + 에이전트(active · 소유자 정지 · 운영자 정지 · provisioning · disabled) + 토큰(살아 있음 · 폐기됨). */
export async function reviewFixture(owner: Pool, options: { readonly agents?: boolean } = {}): Promise<{ id: string; agents: Record<string, string> }> {
  const org = await owner.query<{ id: string }>(
    `INSERT INTO organizations (name, owner_email, review_status, signup_source) VALUES ($1, $2, 'pending_review', 'self_signup') RETURNING id`,
    [`운영 검토 ${suffix()}`, `ops-db-owner-${suffix()}@example.com`],
  );
  const id = org.rows[0]?.id ?? '';
  const agents: Record<string, string> = {};
  if (options.agents !== false) {
    for (const [key, status, by] of [
      ['active', 'active', null],
      ['ownerSuspended', 'suspended', 'owner'],
      ['operatorSuspended', 'suspended', 'operator'],
      ['provisioning', 'provisioning', null],
      ['disabled', 'disabled', null],
    ] as const) {
      const agentId = hex64().slice(0, 32);
      await owner.query(
        `INSERT INTO agents (id, organization_id, name, status, suspended_by, plan, monthly_budget_cents) VALUES ($1, $2, $3, $4, $5, 'free', 1000)`,
        [agentId, id, `agent-${suffix()}`, status, by],
      );
      agents[key] = agentId;
    }
    for (const [agent, revoked] of [
      [agents['active'], null],
      [agents['active'], new Date('2026-09-01T00:00:00.000Z')],
      [agents['ownerSuspended'], null],
      [agents['provisioning'], null],
    ] as const) {
      await owner.query(
        `INSERT INTO agent_api_keys (agent_id, token_hash, capabilities, revoked_at) VALUES ($1, $2, ARRAY['messages:send']::agent_token_capability[], $3)`,
        [agent, hex64(), revoked],
      );
    }
  }
  return { id, agents };
}

/** 소유자 연결 한 트랜잭션(끝나면 **롤백**) — `asOps()` 로 session_user 를 atmark_ops 로(정의 함수·zz_ 트리거가 보는 값), `asOwner()` 로 되돌린다.
 *  전역 상한(거절 하루 10)을 소모하는 행위·append-only 원장을 남기면 안 되는 사례가 쓴다. */
export async function inOpsTx<T>(
  owner: Pool,
  run: (tx: { readonly client: PoolClient; asOps(): Promise<void>; asOwner(): Promise<void> }) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    return await run({
      client,
      asOps: async () => {
        await client.query('SET LOCAL SESSION AUTHORIZATION atmark_ops');
      },
      asOwner: async () => {
        await client.query('RESET SESSION AUTHORIZATION');
      },
    });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** 시각 되감기(로컬 superuser 전용) — 가드 트리거를 끈 채(session_replication_role = replica) 한 문장. 유휴·만료·쿨다운 사례가 쓴다. */
export async function backdate(owner: Pool, sql: string, values: unknown[] = []): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(sql, values);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 활성 운영자 하나 + 세션. */
export async function operatorSession(ops: Pool, owner: Pool, origin: 'cli' | 'console' = 'cli'): Promise<OpsSession> {
  const operator = await addOperator(owner, testEmail(), origin);
  return login(ops, owner, operator.email);
}

/** 베타 스위치(`ops_activation_beta_enabled`)를 트랜잭션 안에서 바꾸는 테스트가 ops 통합 파일과 겹치지 않게 — 같은 키의 트랜잭션 advisory lock. */
export async function lockOpsTestXact(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [OPS_TEST_LOCK]);
}

/**
 * **롤백하는 트랜잭션 안에서만** — 커밋된 거절 티켓(append-only `ops_actions`)의 시각을 하루 밖으로 되감아, 전역 거절 하루 10 이 다른 테스트·실행이
 * 남긴 기록 때문에 이 테스트의 성공 경로를 가리지 않게 한다(코드 리뷰 M2). 가드는 `session_replication_role = replica` 로 이 문장에서만 끈다
 * (로컬 superuser 전용). 커밋하면 원장을 고쳐 쓰는 것이므로 **반드시 롤백되는 트랜잭션**(`inOpsTx`)에서 `asOps()` 전에 부른다.
 */
export async function neutralizeRejectHistory(client: PoolClient): Promise<void> {
  await client.query('SET LOCAL session_replication_role = replica');
  await client.query(
    `UPDATE ops_actions SET created_at = created_at - interval '2 days'
      WHERE kind = 'ticket' AND action = 'org.reject' AND created_at > now() - interval '1 day'`,
  );
  await client.query('SET LOCAL session_replication_role = origin');
}
