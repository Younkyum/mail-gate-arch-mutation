/**
 * test/integration/db/support/harness.ts — 실제 Postgres 위에서 도는 테스트의 공용 지반.
 *
 * **`TEST_DATABASE_URL` 이 없으면 이 층은 통째로 건너뛴다.** 스텁이 아니라 환경 게이트다 —
 * DB 가 없는 기계에서 `pnpm test` 가 빨간불이 되면 아무도 그 빨간불을 읽지 않게 되고,
 * 그 상태가 곧 "테스트가 있는데 아무도 안 보는" 상태다. 대신 **건너뛰었다는 사실을
 * 숨기지 않는다**: 아래 `DATABASE_AVAILABLE` 을 읽는 테스트가 각 파일 이름에 드러난다.
 *
 * **접속은 앱 롤(`atmark_app`)로 한다.** 소유자 롤로 붙으면 GRANT 가 잘못돼 있어도
 * 전부 통과한다 — 마이그레이션 4가 세운 권한 경계가 검사되지 않는다.
 *
 * **정리(cleanup)를 하지 않는다.** `audit_logs`·`agent_api_keys` 는 DELETE·TRUNCATE 가
 * 트리거로 막혀 있고, 그 막힘이야말로 §4.3 이 원하는 성질이다. 그래서 테스트는
 * 매번 **새 조직·새 에이전트**를 만들고 자기 것만 본다.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { createPool } from '../../../../src/db/client';
import type { PlanCode } from '../../../../src/billing/plans';
import { toAgentId, type AgentId } from '../../../../src/db/schema';
import { grantPlan } from '../../../support/entitlements';
import type { Pool, PoolClient } from 'pg';

const url = process.env['TEST_DATABASE_URL'];

/** DB 가 붙어 있는가. `describe.skipIf(!DATABASE_AVAILABLE)` 로 쓴다. */
export const DATABASE_AVAILABLE = url !== undefined && url.trim() !== '';

let pool: Pool | undefined;

export function testPool(): Pool {
  if (!DATABASE_AVAILABLE) throw new Error('TEST_DATABASE_URL 이 없다 — 이 층은 건너뛰어야 한다');
  pool ??= createPool(url as string, { max: 4 });
  return pool;
}

/**
 * **공유 풀과 아무것도 나누지 않는 새 풀.** 만든 쪽이 `end()` 로 닫는다.
 *
 * 왜 필요한가 — 다중 프로세스 배포(람다 N 개)에서는 프로세스마다 풀도 직렬화기도
 * 따로다. 그 구성에서는 `createPostgresOutboundSerializer` 의 **프로세스 내 큐가
 * 아무 일도 하지 않고**, 캡을 지키는 것은 `pg_advisory_xact_lock` 뿐이다. 공유 풀
 * 하나로 도는 테스트는 그 축을 건드리지 못한다(큐가 먼저 막아 주기 때문에 잠금을
 * 지워도 초록이다). 이 함수가 그 축을 테스트 가능하게 만든다.
 */
export function newIndependentPool(overrides: Parameters<typeof createPool>[1] = {}): Pool {
  if (!DATABASE_AVAILABLE) throw new Error('TEST_DATABASE_URL 이 없다 — 이 층은 건너뛰어야 한다');
  return createPool(url as string, overrides);
}

export async function closeTestPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
  await ownerPoolForProvisioning?.end();
  ownerPoolForProvisioning = undefined;
}

const ownerUrl = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
let ownerPoolForProvisioning: Pool | undefined;

/**
 * **프로비저닝·소유자 컬럼 변경용 풀 — 소유자 롤**(`TEST_MIGRATION_DATABASE_URL`). 운영에서 프로비저닝(`provisionAgent`)을
 * 부르는 롤은 CLI(소유자 롤)·admin(`atmark_admin`)뿐이다 — 앱 롤은 `agents` UPDATE 가 없고(프로비저닝 끝의 `status='active'`),
 * `organizations` 는 `sending_started_at` 만 UPDATE 한다(202609230730, ADR-0006 보강). 그래서 테스트도 그 롤로 한다.
 * 없으면 던진다(앱 롤로 조용히 떨어지지 않는다).
 */
export function provisioningPool(): Pool {
  if (!DATABASE_AVAILABLE || ownerUrl.trim() === '') {
    throw new Error('TEST_MIGRATION_DATABASE_URL 이 없다 — 프로비저닝·owner_email 변경은 소유자 롤로만 한다(202609230730).');
  }
  ownerPoolForProvisioning ??= createPool(ownerUrl, { max: 4 });
  return ownerPoolForProvisioning;
}

export function newAgentId(): AgentId {
  return toAgentId(randomBytes(16).toString('hex'));
}

/** sha256 hex 64자를 요구하는 컬럼용(`from_address_hash`, `request_hash`, `token_hash`). */
export function hex64(): string {
  return randomBytes(32).toString('hex');
}

/** 한 시나리오의 뿌리. 조직 1 · 에이전트 1 · 주소 1 · 정책 1 · 버전 1. */
export interface Fixture {
  readonly organizationId: string;
  readonly agentId: AgentId;
  readonly address: string;
  readonly policyVersionId: string;
}

export interface SeedOptions {
  /** 기본은 `null` — "아직 한 통도 성공적으로 보낸 적이 없다"(워밍업 Day 0). */
  readonly sendingStartedAt?: Date | null;
  /** 발신 allow 목록(정책 v2 `agent_contact_rules`). 기본은 `jinyounkyum@gmail.com` 하나. */
  readonly allowlist?: readonly string[];
  /** 요금제(ADR-0011). 기본 `beta`(도입 전 한도) · `null` = 행 없음(Free, fail-closed). */
  readonly plan?: PlanCode | null;
}

/**
 * 소유자 롤 트랜잭션 하나. 연락처 규칙 변경은 **같은 트랜잭션의 새 정책 버전**(스냅샷 = 살아 있는 목록)과 함께여야 커밋된다
 * (202609241040 제약 트리거 — 검증 M3). 규칙을 건드리는 헬퍼는 전부 이 안에서 쓴다.
 */
export async function withOwnerTransaction<T>(run: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await provisioningPool().connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 살아 있는 연락처 규칙 → 스냅샷 `contact_rules`(`policySnapshotOf` 와 같은 모양·순서). */
const LIVE_RULES_JSON = `coalesce((
  SELECT jsonb_agg(jsonb_build_object('id', r.id, 'direction', r.direction, 'list', r.list, 'kind', r.kind, 'value', r.value)
                   ORDER BY r.direction, r.list, r.value)
    FROM agent_contact_rules r WHERE r.agent_id = p.agent_id AND r.removed_at IS NULL), '[]'::jsonb)`;

/**
 * 정책 한 버전 올린다 — 모드·한도는 현재 버전 그대로, 스냅샷의 목록만 **지금 살아 있는 목록**으로. 운영의 관리 연산
 * (`admin/ops/policy.ts` `appendPolicyVersion`)과 같은 모양이다. 새 버전 번호를 돌려준다.
 */
export async function appendPolicyVersionFromLive(db: PoolClient, agentId: AgentId, createdBy = 'test'): Promise<number> {
  const inserted = await db.query<{ version: number }>(
    `INSERT INTO policy_versions (agent_id, version, outbound_mode, inbound_mode, snapshot, created_by)
     SELECT p.agent_id, p.current_version + 1, v.outbound_mode, v.inbound_mode,
            v.snapshot || jsonb_build_object('contact_rules', ${LIVE_RULES_JSON}), $2
       FROM agent_policies p JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version
      WHERE p.agent_id = $1
     RETURNING version`,
    [agentId, createdBy],
  );
  const version = inserted.rows[0]?.version;
  if (version === undefined) throw new Error(`정책 버전을 올릴 수 없다 — 현재 버전 행이 없다 (agent=${agentId})`);
  await db.query('UPDATE agent_policies SET current_version = $2 WHERE agent_id = $1', [agentId, version]);
  return version;
}

async function insertContactRules(
  db: PoolClient,
  agentId: AgentId,
  direction: 'inbound' | 'outbound',
  list: 'allow' | 'block',
  values: readonly string[],
): Promise<void> {
  for (const value of values) {
    await db.query(
      `INSERT INTO agent_contact_rules (agent_id, direction, list, kind, value, created_by)
       VALUES ($1, $2, $3, $4, $5, 'test')`,
      [agentId, direction, list, value.includes('@') ? 'address' : 'domain', value],
    );
  }
}

/**
 * 연락처 규칙을 **소유자 롤로** 더한다(앱 롤은 SELECT 만 — 202609241010) — 규칙과 **새 정책 버전**(스냅샷 = 살아 있는 목록)을
 * 한 트랜잭션으로(202609241040). 값의 종류는 `@` 로 정한다.
 */
export async function seedContactRules(
  agentId: AgentId,
  direction: 'inbound' | 'outbound',
  list: 'allow' | 'block',
  values: readonly string[],
): Promise<void> {
  await withOwnerTransaction(async (db) => {
    await insertContactRules(db, agentId, direction, list, values);
    await appendPolicyVersionFromLive(db, agentId);
  });
}

/** 살아 있는 규칙을 값으로 지운다(지우기 표시) — 새 정책 버전과 한 트랜잭션으로. */
export async function removeContactRules(agentId: AgentId, values: readonly string[]): Promise<void> {
  await withOwnerTransaction(async (db) => {
    await db.query(
      `UPDATE agent_contact_rules SET removed_at = now(), removed_by = 'test'
        WHERE agent_id = $1 AND value = ANY($2::text[]) AND removed_at IS NULL`,
      [agentId, [...values]],
    );
    await appendPolicyVersionFromLive(db, agentId);
  });
}

/**
 * **조직·에이전트·주소·정책·버전은 소유자 롤로 심는다**(`provisioningPool`). 앱 롤은 이 테이블들에 INSERT 가 없다
 * (202609230750 — 앱 롤이 만들 수 있으면 api 탈취가 영속 백도어 에이전트를 심는다, 2차 검증 H-B). `_db` 는 호출부
 * 호환을 위해 받는다 — 심은 행은 앱 롤 풀에서 그대로 보인다(SELECT 는 앱 롤에 있다).
 *
 * 정책·목록·버전 1 은 **한 트랜잭션**이다 — 버전 1 의 스냅샷이 목록 전문을 싣고, 그래야 커밋된다(202609241040).
 */
export async function seedFixture(_db: Pool, options: SeedOptions = {}): Promise<Fixture> {
  const db = provisioningPool();
  const agentId = newAgentId();
  const address = `agent-${agentId.slice(0, 16)}@atmark.ai`;

  const org = await db.query<{ id: string }>(
    `INSERT INTO organizations (name, billing_status, sending_started_at)
     VALUES ($1, 'active', $2) RETURNING id`,
    [`test-org-${agentId.slice(0, 8)}`, options.sendingStartedAt ?? null],
  );
  const organizationId = org.rows[0]?.id;
  if (organizationId === undefined) throw new Error('organizations INSERT 실패');
  // 요금제(ADR-0011) — 이 픽스처의 한도(per_minute 10 · 수신자 20 · per_day 500)는 도입 전 한도를 전제로 쓴 것이다. 기존 활성 조직이
  //   백필로 받은 beta 를 준다(`plan: null` 이면 행 없음 = Free).
  if (options.plan !== null) await grantPlan(db, organizationId, options.plan ?? 'beta');

  await db.query(
    `INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents)
     VALUES ($1, $2, $3, 'active', 'free', 100000)`,
    [agentId, organizationId, `test-agent-${agentId.slice(0, 8)}`],
  );

  await db.query(
    `INSERT INTO agent_addresses (agent_id, address, domain, is_primary)
     VALUES ($1, $2, 'atmark.ai', true)`,
    [agentId, address],
  );

  const limits = { per_minute: 10, per_hour: 100, per_day: 500, recipients_per_message: 20 };
  const config = {
    max_attachment_bytes_total: 10_000_000,
    allowed_mime_types: ['text/plain'],
  };
  const allowlist = options.allowlist ?? ['jinyounkyum@gmail.com'];

  const policyVersionId = await withOwnerTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO agent_policies (agent_id, outbound_mode, limits, config_json, current_version)
       VALUES ($1, 'allowlist_only', $2::jsonb, $3::jsonb, 1)`,
      [agentId, JSON.stringify(limits), JSON.stringify(config)],
    );
    await insertContactRules(tx, agentId, 'outbound', 'allow', allowlist);
    const version = await tx.query<{ id: string }>(
      `INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot)
       SELECT p.agent_id, 1, 'allowlist_only',
              jsonb_build_object('outbound_mode', 'allowlist_only', 'inbound_mode', 'all', 'limits', p.limits,
                                 'config_json', p.config_json, 'contact_rules', ${LIVE_RULES_JSON})
         FROM agent_policies p WHERE p.agent_id = $1
       RETURNING id`,
      [agentId],
    );
    const id = version.rows[0]?.id;
    if (id === undefined) throw new Error('policy_versions INSERT 실패');
    return id;
  });

  return { organizationId, agentId, address, policyVersionId };
}

export interface MessageOptions {
  readonly status?: 'pending' | 'dispatching' | 'sent' | 'failed';
  readonly recipientCount?: number;
  readonly createdAt?: Date;
  readonly sentAt?: Date;
  readonly messageIdHeader?: string;
}

/** outbound `messages` 행 하나. 상태기계 CHECK 를 만족하는 조합만 만든다. */
export async function seedMessage(
  db: Pool,
  agentId: AgentId,
  options: MessageOptions = {},
): Promise<string> {
  const status = options.status ?? 'pending';
  const header = options.messageIdHeader ?? `<${randomUUID()}@atmark.ai>`;
  const sentAt = status === 'sent' ? (options.sentAt ?? new Date()) : null;
  const sesMessageId = status === 'sent' ? `ses-${randomUUID()}` : null;
  const failureReason = status === 'failed' ? 'seeded failure' : null;
  const failedAt = status === 'failed' ? new Date() : null;
  const leaseId = status === 'dispatching' ? randomUUID() : null;
  const leaseExpiresAt = status === 'dispatching' ? new Date(Date.now() + 60_000) : null;

  // P3a — 발송 행은 스레드 없이 존재할 수 없다(`messages_outbound_has_thread`). 행마다 에이전트 스레드 하나.
  const result = await db.query<{ id: string }>(
    `WITH thread AS (
       INSERT INTO threads (agent_id, started_by, starter_address) VALUES ($1, 'agent', NULL) RETURNING id
     )
     INSERT INTO messages
       (agent_id, direction, from_address_hash, from_domain, status, message_id_header,
        idempotency_key, request_hash, recipient_count, created_at,
        ses_message_id, sent_at, failure_reason, failed_at, lease_id, lease_expires_at, thread_id)
     VALUES ($1, 'outbound', $2, 'atmark.ai', $3, $4, $5, $6, $7, $8,
             $9, $10, $11, $12, $13, $14, (SELECT id FROM thread))
     RETURNING id`,
    [
      agentId,
      hex64(),
      status,
      header,
      randomUUID(),
      hex64(),
      options.recipientCount ?? 1,
      options.createdAt ?? new Date(),
      sesMessageId,
      sentAt,
      failureReason,
      failedAt,
      leaseId,
      leaseExpiresAt,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('messages INSERT 실패');
  return id;
}

// ---------------------------------------------------------------------------
// 거부 확인 — SQLSTATE 를 값으로 받아 단언한다.
// ---------------------------------------------------------------------------

/** pg 오류의 SQLSTATE(`code`). 객체가 아니면 `''`. */
export function sqlState(error: unknown): string {
  return typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code) : '';
}

/** `promise` 가 거부돼야 한다 — 그 SQLSTATE 와 문구. 통과하면 던진다. */
export async function rejects(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return { code: sqlState(error), message: error instanceof Error ? error.message : String(error) };
  }
  throw new Error('거부되지 않았다');
}

/** `run` 의 결과 — 통과 `'ok'`, 거부면 SQLSTATE(없으면 `'no-code'`). */
export async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
  return 'ok';
}

/** 열린 트랜잭션 안에서 SAVEPOINT 로 한 문장을 돌린다 — `'ok'` 또는 SQLSTATE. 거부돼도 트랜잭션은 이어 쓸 수 있다. */
export async function stateOf(client: PoolClient, sql: string, params: readonly unknown[] = []): Promise<string> {
  await client.query('SAVEPOINT s');
  try {
    await client.query(sql, [...params]);
    await client.query('RELEASE SAVEPOINT s');
    return 'ok';
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT s');
    return (error as { code?: string }).code ?? 'no-code';
  }
}

/** 트랜잭션 하나에서 `run` 을 돌리고 **언제나 롤백**한다. */
export async function rolledBack(db: Pool, run: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await run(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** 열린 트랜잭션 안에서 `role` 로 `run` 을 돌린다(`SET LOCAL ROLE` → `RESET ROLE`). */
export async function asRole<T>(client: PoolClient, role: string, run: () => Promise<T>): Promise<T> {
  await client.query(`SET LOCAL ROLE ${role}`);
  try {
    return await run();
  } finally {
    await client.query('RESET ROLE');
  }
}

/**
 * 서열기 능력(202610131610 `tlog_capabilities` · 적대 검토 M-1) — 운영 DB 에서는 새 서열기가 틱마다 적는다. 운영자 · 시스템 행위자 감사 행을 만드는
 * 테스트(운영자 CLI · 평판 자동 동결)는 그 상태를 전제한다 — 소유자 롤로 같은 정의자를 부른다(멱등). 능력이 **없을 때**의 거부는
 * `test/integration/adversarial/platform-reputation.test.ts` 가 되돌림 트랜잭션에서 본다.
 */
export async function recordTlogCapabilities(): Promise<void> {
  await provisioningPool().query(`SELECT atmark_tlog_record_capabilities(ARRAY['owner_action_operator_actor'])`);
}
