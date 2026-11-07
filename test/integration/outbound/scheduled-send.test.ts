/**
 * P3c — 예약 발송(`scheduled_send`). **실제 Postgres**(관문 저장소 전부) + 로컬 객체 저장소 + 세는 전송단.
 *
 * 각 단언은 방어 하나를 겨냥한다(보고서 "되돌리기"):
 *   - ★ **평가 시점 = 발송 시점.** 예약 뒤·발송 전에 수신자가 억제되면 발송 시점의 관문이 막는다(SES 0).
 *     예약 시점에 판정해 두는 구현으로 되돌리면 이 테스트가 빨갛다.
 *   - ★ 반대 방향도: 예약 시점에는 막혔을 상대(allowlist 밖)가 발송 전에 허용되면 나간다.
 *   - 기한 전에는 집히지 않는다.
 *   - ★ 임대 만료 재시도(결과 기록 전에 죽은 워커)는 같은 멱등 키로 재생 — SES 1회.
 *   - 생성 라우트: `Idempotency-Key` 필수(400), 같은 키 재호출은 같은 예약, 다른 요청이면 409.
 *
 * **`TEST_DATABASE_URL` 이 없으면 통째로 건너뛴다.**
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createInMemoryContentStore } from '../../../src/api/content-store';
import type { ApiRequest } from '../../../src/api/http';
import type { OutboundServiceDependencies } from '../../../src/api/outbound-service';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import { handleCreateScheduledMessage } from '../../../src/api/routes/scheduled-messages';
import { createPostgresAgentTokenStore, createPostgresGateStores } from '../../../src/db/repositories';
import { createPostgresScheduledSendStore } from '../../../src/db/repositories/scheduled-send-store';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { createLocalObjectStore } from '../../../src/storage/local-object-store';
import { createScheduledContentStore } from '../../../src/storage/scheduled-content-store';
import { runScheduledSenderTick, scheduledIdempotencyKey, type ScheduledSenderTickDependencies } from '../../../src/workers/scheduled-sender';
import { addRuleOp, resolveContactRuleInput } from '../../../src/admin/ops/rules';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { countingTransport, type CountingTransport } from './support/fakes';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

const FRIEND = 'friend@example.com';

interface World {
  readonly pool: Pool;
  readonly fixture: Fixture;
  readonly token: string;
  readonly clock: { now: Date };
  readonly transport: CountingTransport;
  readonly tick: ScheduledSenderTickDependencies;
  readonly routeDeps: Parameters<typeof handleCreateScheduledMessage>[0];
}

async function world(allowlist: readonly string[] = [FRIEND]): Promise<World> {
  const pool = testPool();
  const fixture = await seedFixture(pool, { allowlist });
  const issued = issueAgentToken(fixture.agentId);
  await createPostgresAgentTokenStore(provisioningPool()).insert({
    agentId: fixture.agentId,
    tokenHash: issued.tokenHash,
    capabilities: issued.capabilities,
    expiresAt: null,
  });
  const clock = { now: new Date() };
  const stores = createPostgresGateStores(pool);
  const service: OutboundServiceDependencies = {
    source: stores.source,
    audit: stores.audit,
    dispatchStore: stores.leases,
    serializer: stores.serializer,
    sendEvidence: stores.sendEvidence,
    messages: createPostgresOutboundMessageStore(pool),
    content: createInMemoryContentStore(),
    leaseTtlSeconds: 300,
    riskSignals: inertRiskSignals(),
    dlp: inertDlp(),
    now: () => clock.now,
  };
  const content = createScheduledContentStore(createLocalObjectStore({ directory: mkdtempSync(join(tmpdir(), 'atmark-sched-')), env: {} }));
  const schedules = createPostgresScheduledSendStore(pool);
  const transport = countingTransport();
  return {
    pool,
    fixture,
    token: issued.plaintext,
    clock,
    transport,
    // 같은 DB 를 병렬로 쓰는 다른 테스트의 예약을 집지 않게 — 이 에이전트의 예약만.
    tick: { service, transport, schedules, content, leaseSeconds: 60, onlyAgentId: fixture.agentId },
    routeDeps: { tokens: createPostgresAgentTokenStore(pool), schedules, content, now: () => clock.now, risk: service },
  };
}

function scheduleRequest(w: World, key: string | null, sendAt: Date, overrides: Record<string, unknown> = {}): ApiRequest {
  return {
    headers: { authorization: `Bearer ${w.token}`, ...(key === null ? {} : { 'idempotency-key': key }) },
    query: {},
    body: {
      agent_id: w.fixture.agentId,
      from: w.fixture.address,
      to: [FRIEND],
      subject: '예약 발송',
      text: '예약된 본문',
      send_at: sendAt.toISOString(),
      ...overrides,
    },
  };
}

/** 이 에이전트의 **예약 발송** 행에 대한 관문 판정(audit). 다른 테스트의 행과 섞이지 않게 에이전트로 묶는다. */
async function auditsFor(pool: Pool, agentId: string): Promise<{ decision: string; reasons: string[] }[]> {
  const result = await pool.query<{ decision: string; reasons: string[] }>(
    `SELECT decision::text AS decision, reasons FROM audit_logs WHERE agent_id = $1 ORDER BY evaluated_at`,
    [agentId],
  );
  return result.rows;
}

describe.skipIf(!DATABASE_AVAILABLE)('P3c — 예약 발송', () => {
  it('생성: Idempotency-Key 필수 · 같은 키는 같은 예약 · 다른 요청은 409 · 과거 시각은 400', async () => {
    const w = await world();
    const sendAt = new Date(w.clock.now.getTime() + 3600_000);
    const missing = await handleCreateScheduledMessage(w.routeDeps, scheduleRequest(w, null, sendAt));
    expect(missing.status).toBe(400);
    expect(missing.body['error']).toBe('idempotency_key_required');

    const first = await handleCreateScheduledMessage(w.routeDeps, scheduleRequest(w, 'sched-1', sendAt));
    const again = await handleCreateScheduledMessage(w.routeDeps, scheduleRequest(w, 'sched-1', sendAt));
    expect(first.status).toBe(202);
    expect(again.body['schedule_id']).toBe(first.body['schedule_id']);
    expect(again.body['replayed']).toBe(true);
    const conflict = await handleCreateScheduledMessage(w.routeDeps, scheduleRequest(w, 'sched-1', sendAt, { text: '다른 본문' }));
    expect(conflict.status).toBe(409);

    const past = await handleCreateScheduledMessage(w.routeDeps, scheduleRequest(w, 'sched-past', new Date(w.clock.now.getTime() - 3600_000)));
    expect(past.status).toBe(400);
    // 생성은 판정하지 않는다 — audit 행 0.
    expect(await auditsFor(w.pool, w.fixture.agentId)).toHaveLength(0);
  });

  it('생성: agent_id 생략 = 토큰의 에이전트 — 명시한 같은 요청은 재생 · 남의 id 403 · 형식 위반 400 (2026-10-11)', async () => {
    const w = await world();
    const sendAt = new Date(w.clock.now.getTime() + 3600_000);
    const omit = (request: ApiRequest): ApiRequest => {
      const { agent_id: _omitted, ...body } = request.body as Record<string, unknown>;
      return { ...request, body };
    };
    const omitted = await handleCreateScheduledMessage(w.routeDeps, omit(scheduleRequest(w, 'sched-aid', sendAt)));
    expect(omitted.status).toBe(202);
    const explicit = await handleCreateScheduledMessage(w.routeDeps, scheduleRequest(w, 'sched-aid', sendAt));
    expect(explicit.body['schedule_id']).toBe(omitted.body['schedule_id']);
    expect(explicit.body['replayed']).toBe(true);
    expect((await handleCreateScheduledMessage(w.routeDeps, scheduleRequest(w, 'sched-aid-2', sendAt, { agent_id: 'b'.repeat(32) }))).status).toBe(403);
    expect((await handleCreateScheduledMessage(w.routeDeps, scheduleRequest(w, 'sched-aid-3', sendAt, { agent_id: 'X' }))).status).toBe(400);
  });

  it('기한 전에는 집히지 않고, 기한이 되면 관문을 지나 실제로 나간다', async () => {
    const w = await world();
    const sendAt = new Date(w.clock.now.getTime() + 3600_000);
    const created = await handleCreateScheduledMessage(w.routeDeps, scheduleRequest(w, 'sched-ok', sendAt));
    const scheduleId = String(created.body['schedule_id']);

    expect(await runScheduledSenderTick(w.tick)).toEqual([]);
    expect(w.transport.calls()).toBe(0);

    w.clock.now = new Date(sendAt.getTime() + 1000);
    const results = await runScheduledSenderTick(w.tick);
    expect(results.filter((r) => r.scheduleId === scheduleId).map((r) => r.outcome)).toEqual(['sent']);
    expect(w.transport.calls()).toBe(1);
    const audits = await auditsFor(w.pool, w.fixture.agentId);
    expect(audits.map((a) => a.decision)).toEqual(['allowed']);

    const row = await w.pool.query('SELECT status, dispatch_outcome, message_id FROM scheduled_sends WHERE id = $1', [scheduleId]);
    expect(row.rows[0]).toMatchObject({ status: 'dispatched', dispatch_outcome: 'sent' });
    const message = await w.pool.query('SELECT idempotency_key FROM messages WHERE id = $1', [row.rows[0]?.message_id]);
    expect(message.rows[0]?.idempotency_key).toBe(scheduledIdempotencyKey(scheduleId));

    // 끝난 예약은 다시 집히지 않는다.
    w.clock.now = new Date(sendAt.getTime() + 7200_000);
    expect(await runScheduledSenderTick(w.tick)).toEqual([]);
    expect(w.transport.calls()).toBe(1);
  });

  it('★ 평가 시점 = 발송 시점 — 예약 뒤 억제된 수신자에게는 나가지 않는다(SES 0)', async () => {
    const w = await world();
    const sendAt = new Date(w.clock.now.getTime() + 3600_000);
    const created = await handleCreateScheduledMessage(w.routeDeps, scheduleRequest(w, 'sched-suppressed', sendAt));
    expect(created.status).toBe(202);

    // 예약과 발송 사이 — 수신자가 바운스·불만으로 억제됐다.
    await provisioningPool().query(
      `INSERT INTO suppression_entries (organization_id, address, domain, source) VALUES ($1, $2, 'example.com', 'complaint')`,
      [w.fixture.organizationId, FRIEND],
    );

    w.clock.now = new Date(sendAt.getTime() + 1000);
    const results = await runScheduledSenderTick(w.tick);
    expect(results.map((r) => r.outcome)).toContain('denied');
    expect(w.transport.calls()).toBe(0);
    const audits = await auditsFor(w.pool, w.fixture.agentId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.decision).toBe('denied');
    expect(audits[0]?.reasons.join(',')).toContain('suppress');
  });

  it('★ 반대 방향 — 예약 시점에 allowlist 밖이던 상대가 발송 전에 허용되면 나간다', async () => {
    const w = await world([]);
    const sendAt = new Date(w.clock.now.getTime() + 3600_000);
    await handleCreateScheduledMessage(w.routeDeps, scheduleRequest(w, 'sched-later-allowed', sendAt));

    // 발송 전에 소유자가 발신 allow 목록에 넣었다(정책 v2 — 관리 연산 그대로, 새 정책 버전).
    await addRuleOp(
      provisioningPool(),
      w.fixture.agentId,
      resolveContactRuleInput({ direction: 'outbound', list: 'allow', value: FRIEND }),
      'test:scheduled',
    );

    w.clock.now = new Date(sendAt.getTime() + 1000);
    const results = await runScheduledSenderTick(w.tick);
    expect(results.map((r) => r.outcome)).toEqual(['sent']);
    expect(w.transport.calls()).toBe(1);
  });

  it('★ 결과 기록 전에 죽은 워커 — 임대 만료 뒤 재시도는 같은 멱등 키로 재생된다(SES 1회)', async () => {
    const w = await world();
    const sendAt = new Date(w.clock.now.getTime() + 60_000);
    const created = await handleCreateScheduledMessage(w.routeDeps, scheduleRequest(w, 'sched-crash', sendAt));
    const scheduleId = String(created.body['schedule_id']);
    w.clock.now = new Date(sendAt.getTime() + 1000);

    // 첫 워커: 보냈지만 결과 기록(markDispatched) 전에 죽었다.
    const crashing: ScheduledSenderTickDependencies = {
      ...w.tick,
      schedules: { ...w.tick.schedules, markDispatched: () => Promise.reject(new Error('worker died')) },
    };
    const first = await runScheduledSenderTick(crashing);
    expect(first.map((r) => r.outcome)).toEqual(['retry']);
    expect(w.transport.calls()).toBe(1);

    // 임대 안에서는 다시 집히지 않는다.
    expect(await runScheduledSenderTick(w.tick)).toEqual([]);

    // 임대 만료 뒤 — 다시 집히지만 두 번 나가지 않는다.
    w.clock.now = new Date(w.clock.now.getTime() + 61_000);
    const second = await runScheduledSenderTick(w.tick);
    expect(second.map((r) => r.outcome)).toEqual(['replayed']);
    expect(w.transport.calls()).toBe(1);
    const row = await w.pool.query('SELECT status, attempt_count FROM scheduled_sends WHERE id = $1', [scheduleId]);
    expect(row.rows[0]).toMatchObject({ status: 'dispatched', attempt_count: 2 });
  });

  it('DB 가 예약의 정체를 지킨다 — 수신자·시각은 바꿀 수 없고, 끝난 예약은 되돌릴 수 없다', async () => {
    const w = await world();
    const sendAt = new Date(w.clock.now.getTime() + 60_000);
    const created = await handleCreateScheduledMessage(w.routeDeps, scheduleRequest(w, 'sched-immutable', sendAt));
    const id = String(created.body['schedule_id']);
    await expect(w.pool.query(`UPDATE scheduled_sends SET recipients = ARRAY['x@evil.example'] WHERE id = $1`, [id])).rejects.toThrow();
    await expect(w.pool.query(`UPDATE scheduled_sends SET send_at = now() WHERE id = $1`, [id])).rejects.toThrow();
    w.clock.now = new Date(sendAt.getTime() + 1000);
    await runScheduledSenderTick(w.tick);
    await expect(
      w.pool.query(`UPDATE scheduled_sends SET status = 'scheduled', dispatched_at = NULL, dispatch_outcome = NULL WHERE id = $1`, [id]),
    ).rejects.toThrow();
  });
});
