/**
 * lease · audit · sending_started_at — **§4.5 의 exactly-once 가 실제 DB 에서 성립하는가.**
 *
 * 단위 테스트는 "acquire 가 false 를 돌려준다" 까지만 말할 수 있다. 조건부 UPDATE 가
 * 실제로 0행을 바꾸는가, 상태기계 CHECK 와 전이 트리거가 우리 SQL 을 받아 주는가는
 * 진짜 Postgres 위에서만 답이 나온다 — 그리고 그 답이 틀렸을 때의 증상이
 * "같은 사람에게 메일이 세 번 간다" 다.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { createPostgresAuditSink } from '../../../src/db/repositories/audit-sink';
import {
  createPostgresLeaseStore,
  MessageNotFoundError,
} from '../../../src/db/repositories/lease-store';
import { createPostgresSendingClock } from '../../../src/db/repositories/sending-clock';
import { allowed, deny, toDeniedDecision, type Decision } from '../../../src/policy/types';
import {
  closeTestPool,
  DATABASE_AVAILABLE,
  seedFixture,
  seedMessage,
  testPool,
} from './support/harness';

const TTL = 300;

describe.skipIf(!DATABASE_AVAILABLE)('lease (§4.5-3)', () => {
  afterAll(closeTestPool);

  it('pending 을 잡으면 dispatching 이 되고 attempt 가 1 오른다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'pending' });
    const leases = createPostgresLeaseStore(pool);
    const now = new Date();

    expect(await leases.acquire({ messageId, leaseId: randomUUID(), now, ttlSeconds: TTL })).toBe(true);

    const row = await pool.query<{ status: string; attempt: number; lease_expires_at: Date }>(
      'SELECT status, attempt, lease_expires_at FROM messages WHERE id = $1',
      [messageId],
    );
    expect(row.rows[0]?.status).toBe('dispatching');
    expect(row.rows[0]?.attempt).toBe(1);
    expect(row.rows[0]?.lease_expires_at.getTime()).toBe(now.getTime() + TTL * 1000);
  });

  it('**중복 SQS 전달이 여기서 죽는다** — 두 번째 acquire 는 0행이다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'pending' });
    const leases = createPostgresLeaseStore(pool);
    const now = new Date();

    expect(await leases.acquire({ messageId, leaseId: randomUUID(), now, ttlSeconds: TTL })).toBe(true);
    expect(await leases.acquire({ messageId, leaseId: randomUUID(), now, ttlSeconds: TTL })).toBe(false);
  });

  it('동시 acquire 10회 중 정확히 1회만 이긴다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'pending' });
    const leases = createPostgresLeaseStore(pool);
    const now = new Date();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        leases.acquire({ messageId, leaseId: randomUUID(), now, ttlSeconds: TTL }),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('만료된 lease 는 다시 잡힌다 (AC-i3)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'pending' });
    const leases = createPostgresLeaseStore(pool);
    const acquiredAt = new Date();

    await leases.acquire({ messageId, leaseId: randomUUID(), now: acquiredAt, ttlSeconds: 1 });

    const beforeExpiry = new Date(acquiredAt.getTime() + 500);
    expect(
      await leases.acquire({ messageId, leaseId: randomUUID(), now: beforeExpiry, ttlSeconds: TTL }),
    ).toBe(false);

    const afterExpiry = new Date(acquiredAt.getTime() + 2000);
    expect(
      await leases.acquire({ messageId, leaseId: randomUUID(), now: afterExpiry, ttlSeconds: TTL }),
    ).toBe(true);
  });

  it('종단 상태(sent)는 다시 잡히지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'sent' });
    const leases = createPostgresLeaseStore(pool);

    expect(await leases.statusOf(messageId)).toBe('sent');
    expect(
      await leases.acquire({ messageId, leaseId: randomUUID(), now: new Date(), ttlSeconds: TTL }),
    ).toBe(false);
  });

  it('없는 메시지의 상태는 거짓말하지 않고 던진다', async () => {
    const pool = testPool();
    await expect(createPostgresLeaseStore(pool).statusOf(randomUUID())).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });

  it('lease 를 쥔 워커만 결과를 확정한다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'pending' });
    const leases = createPostgresLeaseStore(pool);
    const leaseId = randomUUID();
    const now = new Date();

    await leases.acquire({ messageId, leaseId, now, ttlSeconds: TTL });

    // `ses_message_id` 는 전역 유니크다(`messages_ses_message_id_key`) — 테스트마다 새 값.
    const sesMessageId = `ses-${randomUUID()}`;

    // lease 를 잃은(혹은 애초에 못 잡은) 워커의 확정 시도는 0행이다.
    expect(await leases.settleSent(messageId, randomUUID(), `ses-${randomUUID()}`, now)).toBe(false);
    expect(await leases.settleSent(messageId, leaseId, sesMessageId, now)).toBe(true);

    const row = await pool.query<{ status: string; ses_message_id: string }>(
      'SELECT status, ses_message_id FROM messages WHERE id = $1',
      [messageId],
    );
    expect(row.rows[0]).toMatchObject({ status: 'sent', ses_message_id: sesMessageId });
  });

  it('종단 행의 결과 컬럼은 다시 쓰이지 않는다 (DB 트리거)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'pending' });
    const leases = createPostgresLeaseStore(pool);
    const leaseId = randomUUID();
    const now = new Date();

    await leases.acquire({ messageId, leaseId, now, ttlSeconds: TTL });
    // `ses_message_id` 는 전역 유니크다(`messages_ses_message_id_key`) — 테스트마다 새 값.
    await leases.settleSent(messageId, leaseId, `ses-${randomUUID()}`, now);

    // 이미 sent 다 — settleFailed 는 status='dispatching' 조건에서 0행이 된다.
    expect(await leases.settleFailed(messageId, leaseId, 'nope', now)).toBe(false);
  });
});

/**
 * `denied` — **"정책이 막았다" 를 `messages` 가 말할 수 있는가** (P1b 리뷰 MAJOR 3).
 *
 * 마이그레이션 `202609221500`(enum 값) + `202609221510`(상태기계·전이 가드) 두 장이
 * 세운 명제를 실제 Postgres 위에서 확인한다. 단위 테스트는 가짜 맵의 성질만 말한다.
 */
describe.skipIf(!DATABASE_AVAILABLE)('denied (§4.5-1)', () => {
  afterAll(closeTestPool);

  it('pending 은 denied 로 확정된다 — 결과 컬럼은 전부 NULL 로 남는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'pending' });
    const leases = createPostgresLeaseStore(pool);

    expect(await leases.settleDenied(messageId)).toBe(true);

    const row = await pool.query<{
      status: string;
      lease_id: string | null;
      ses_message_id: string | null;
      failure_reason: string | null;
    }>('SELECT status, lease_id, ses_message_id, failure_reason FROM messages WHERE id = $1', [
      messageId,
    ]);
    // 거부 사유는 `audit_logs` 가 단일 출처다 — 여기 복사본을 두면 둘이 갈라진다.
    expect(row.rows[0]).toMatchObject({
      status: 'denied',
      lease_id: null,
      ses_message_id: null,
      failure_reason: null,
    });
  });

  it('denied 는 종단이다 — 카운터(dispatching/sent)에도 들어가지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'pending' });
    const leases = createPostgresLeaseStore(pool);

    await leases.settleDenied(messageId);

    expect(await leases.statusOf(messageId)).toBe('denied');
    // 재전달이 거부된 행에 lease 를 걸면 그 시도는 다시 평가를 받는다 — 종단이 아니게 된다.
    expect(
      await leases.acquire({ messageId, leaseId: randomUUID(), now: new Date(), ttlSeconds: TTL }),
    ).toBe(false);

    const counted = await pool.query<{ recipients: string }>(
      `SELECT coalesce(sum(recipient_count), 0)::text AS recipients
         FROM messages WHERE id = $1 AND status IN ('dispatching', 'sent')`,
      [messageId],
    );
    expect(counted.rows[0]?.recipients).toBe('0');
  });

  it('**dispatching 은 denied 로 되돌아가지 않는다** (DB 트리거)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'pending' });
    const leases = createPostgresLeaseStore(pool);

    await leases.acquire({ messageId, leaseId: randomUUID(), now: new Date(), ttlSeconds: TTL });

    // 애플리케이션 경로는 status='pending' 조건에서 0행으로 멈춘다.
    expect(await leases.settleDenied(messageId)).toBe(false);

    // 그 조건을 건너뛰고 직접 UPDATE 해도 트리거가 거부한다. lease 를 잡은 시도는
    // 이미 나가고 있을 수 있고, 그 행을 "정책이 막았다" 로 되돌리는 것은 나간 메일을
    // failed 로 기록하던 BLOCKER 와 같은 종류의 거짓말이다.
    await expect(
      pool.query(`UPDATE messages SET status = 'denied' WHERE id = $1`, [messageId]),
    ).rejects.toThrow(/illegal messages.status transition/);
  });

  it('denied 행에 사후에 ses_message_id 를 끼워 넣을 수 없다 (DB 트리거)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'pending' });
    const leases = createPostgresLeaseStore(pool);

    await leases.settleDenied(messageId);

    await expect(
      pool.query(`UPDATE messages SET ses_message_id = $2 WHERE id = $1`, [
        messageId,
        `ses-${randomUUID()}`,
      ]),
    ).rejects.toThrow(/terminal/);
  });
});

/**
 * 허용 결정 한 건.
 *
 * `policyVersionId` 에 **실재하는 행의 id** 를 넣어야 한다 — `audit_logs.policy_version_id`
 * 는 FK 이고, 두 스탬프 컬럼은 DB CHECK 가 "항상 함께 있거나 함께 없다" 로 묶는다.
 */
function allowedDecision(policyVersionId: string): Decision {
  return allowed(['allowlist_match'], {
    policyVersion: 1,
    policyVersionId,
    evaluatedAt: new Date(),
  });
}

describe.skipIf(!DATABASE_AVAILABLE)('audit (§4.3 — 시도당 정확히 1행)', () => {
  afterAll(closeTestPool);

  it('거부 시도도 messages 행 없이 1행을 남긴다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const audit = createPostgresAuditSink(pool);

    const decision = toDeniedDecision(deny(['evaluation_error']), {
      policyVersion: null,
      policyVersionId: null,
      evaluatedAt: new Date(),
    });

    const auditId = await audit.record({
      agentId: fixture.agentId,
      messageId: null,
      decision,
      traceId: 'trace-1',
      latencyMs: 3,
      approval: null,
    });

    const row = await pool.query<{ decision: string; reasons: string[]; policy_version: number | null }>(
      'SELECT decision, reasons, policy_version FROM audit_logs WHERE id = $1',
      [auditId],
    );
    expect(row.rows[0]).toMatchObject({ decision: 'denied', policy_version: null });
    expect(row.rows[0]?.reasons).toEqual(['evaluation_error']);
  });

  it('스탬프 없는 행은 `denied` + `evaluation_error` 일 때만 들어간다 (DB CHECK)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const audit = createPostgresAuditSink(pool);

    // `allowed` 인데 스탬프가 없는 행은 DB 가 거부해야 한다.
    await expect(
      audit.record({
        agentId: fixture.agentId,
        messageId: null,
        decision: allowed(['allowlist_match'], {
          policyVersion: null,
          policyVersionId: null,
          evaluatedAt: new Date(),
        }),
        traceId: null,
        latencyMs: 1,
        approval: null,
      }),
    ).rejects.toThrow(/audit_logs_policy_stamp_presence/);
  });

  it('resolve 는 **같은 행**을 갱신한다 — 새 행이 생기지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const audit = createPostgresAuditSink(pool);

    const before = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM audit_logs WHERE agent_id = $1',
      [fixture.agentId],
    );

    const auditId = await audit.record({
      agentId: fixture.agentId,
      messageId: null,
      decision: allowedDecision(fixture.policyVersionId),
      traceId: null,
      latencyMs: 1,
      approval: null,
    });
    await audit.resolve(auditId, 'sent', null);

    const after = await pool.query<{ count: string; resolution_reason: string | null }>(
      `SELECT count(*)::text AS count FROM audit_logs WHERE agent_id = $1`,
      [fixture.agentId],
    );
    expect(Number(after.rows[0]?.count)).toBe(Number(before.rows[0]?.count) + 1);

    const row = await pool.query<{ decision: string; resolution_reason: string; resolved_at: Date }>(
      'SELECT decision, resolution_reason, resolved_at FROM audit_logs WHERE id = $1',
      [auditId],
    );
    // 판정은 바뀌지 않는다 — 전송 실패는 "보내도 된다" 는 판정을 뒤집지 않는다.
    expect(row.rows[0]?.decision).toBe('allowed');
    expect(row.rows[0]?.resolution_reason).toBe('sent');
    expect(row.rows[0]?.resolved_at).toBeInstanceOf(Date);
  });

  it('실패 사유가 같은 컬럼에 남는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const audit = createPostgresAuditSink(pool);

    const auditId = await audit.record({
      agentId: fixture.agentId,
      messageId: null,
      decision: allowedDecision(fixture.policyVersionId),
      traceId: null,
      latencyMs: 1,
      approval: null,
    });
    await audit.resolve(auditId, 'failed', 'SES throttled');

    const row = await pool.query<{ resolution_reason: string }>(
      'SELECT resolution_reason FROM audit_logs WHERE id = $1',
      [auditId],
    );
    expect(row.rows[0]?.resolution_reason).toBe('failed:SES throttled');
  });

  it('두 번째 resolve 는 첫 해소를 덮어쓰지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const audit = createPostgresAuditSink(pool);

    const auditId = await audit.record({
      agentId: fixture.agentId,
      messageId: null,
      decision: allowedDecision(fixture.policyVersionId),
      traceId: null,
      latencyMs: 1,
      approval: null,
    });
    await audit.resolve(auditId, 'sent', null);
    await audit.resolve(auditId, 'failed', 'late');

    const row = await pool.query<{ resolution_reason: string }>(
      'SELECT resolution_reason FROM audit_logs WHERE id = $1',
      [auditId],
    );
    expect(row.rows[0]?.resolution_reason).toBe('sent');
  });

  it('audit 행은 삭제되지 않는다 (DB 트리거)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const audit = createPostgresAuditSink(pool);
    const auditId = await audit.record({
      agentId: fixture.agentId,
      messageId: null,
      decision: allowedDecision(fixture.policyVersionId),
      traceId: null,
      latencyMs: 1,
      approval: null,
    });

    await expect(pool.query('DELETE FROM audit_logs WHERE id = $1', [auditId])).rejects.toThrow();
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('sending_started_at (§3.3 M7)', () => {
  afterAll(closeTestPool);

  it('최초 1회만 세팅된다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, { sendingStartedAt: null });
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'pending' });
    const clock = createPostgresSendingClock(pool);

    const first = new Date('2026-10-01T00:00:00.000Z');
    expect(await clock.markFirstSend(messageId, first)).toBe(true);

    // 두 번째 발송이 기준일을 오늘로 밀면 램프가 영원히 Day 1 에 묶인다.
    const second = new Date('2026-10-05T00:00:00.000Z');
    expect(await clock.markFirstSend(messageId, second)).toBe(false);

    const row = await pool.query<{ sending_started_at: Date }>(
      'SELECT sending_started_at FROM organizations WHERE id = $1',
      [fixture.organizationId],
    );
    expect(row.rows[0]?.sending_started_at.toISOString()).toBe(first.toISOString());
  });

  it('없는 메시지면 아무 조직도 건드리지 않는다', async () => {
    const pool = testPool();
    expect(await createPostgresSendingClock(pool).markFirstSend(randomUUID(), new Date())).toBe(false);
  });
});
