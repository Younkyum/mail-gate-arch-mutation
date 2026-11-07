/**
 * 예약 워커의 임대 겹을 **따로** 시험한다(검증 V2 낮음). `scheduled-send.test.ts` 의 시나리오는 이 겹들이 틀려도
 * 멱등 키가 중복 발송을 막아 초록이었다 — 여기서는 각 겹만 본다. 실제 Postgres.
 *
 *   - 펜싱(`attempt_count`): 임대를 잃은 워커의 늦은 결과 기록은 0행이다. `markDispatched` 의 `attempt_count = $2`
 *     를 지우면 빨갛다.
 *   - 시도 상한: `MAX_SCHEDULED_ATTEMPTS` 번째까지는 보내고, 넘으면 관문에 가지 않고 `abandoned`. 비교를 바꾸면 빨갛다.
 *   - `SKIP LOCKED`: 다른 트랜잭션이 잡고 있는 행을 기다리지 않고 건너뛴다. 지우면 집기가 막혀 빨갛다.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { createInMemoryContentStore } from '../../../src/api/content-store';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import { createPostgresGateStores } from '../../../src/db/repositories';
import {
  createPostgresScheduledSendStore,
  MAX_SCHEDULED_ATTEMPTS,
} from '../../../src/db/repositories/scheduled-send-store';
import { createLocalObjectStore } from '../../../src/storage/local-object-store';
import { createScheduledContentStore } from '../../../src/storage/scheduled-content-store';
import { runScheduledSenderTick, type ScheduledSenderTickDependencies } from '../../../src/workers/scheduled-sender';
import { closeTestPool, DATABASE_AVAILABLE, hex64, newIndependentPool, seedFixture, testPool } from '../db/support/harness';
import { countingTransport } from './support/fakes';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

const FRIEND = 'friend@example.com';
const LEASE_SECONDS = 60;

async function world() {
  const pool = testPool();
  const fixture = await seedFixture(pool, { allowlist: [FRIEND] });
  const schedules = createPostgresScheduledSendStore(pool);
  const content = createScheduledContentStore(createLocalObjectStore({ directory: mkdtempSync(join(tmpdir(), 'atmark-fence-')), env: {} }));
  const clock = { now: new Date() };
  const id = randomUUID();
  await content.put(id, { subject: '펜싱', text: '본문', html: null });
  const created = await schedules.create({
    id,
    agentId: fixture.agentId,
    idempotencyKey: `fence-${id}`,
    requestHash: hex64(),
    fromAddress: fixture.address,
    recipients: [FRIEND],
    sendAt: new Date(clock.now.getTime() - 1000),
    contentStorageKey: content.keyFor(id),
    traceId: null,
    costCents: 0,
  });
  expect(created.kind).toBe('created');
  const stores = createPostgresGateStores(pool);
  const transport = countingTransport();
  const tick: ScheduledSenderTickDependencies = {
    service: {
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
    },
    transport,
    schedules,
    content,
    leaseSeconds: LEASE_SECONDS,
    onlyAgentId: fixture.agentId,
  };
  const advance = (): void => {
    clock.now = new Date(clock.now.getTime() + (LEASE_SECONDS + 1) * 1000);
  };
  return { pool, fixture, schedules, clock, advance, id, tick, transport };
}

describe.skipIf(!DATABASE_AVAILABLE)('예약 임대 — 겹마다', () => {
  it('펜싱 — 임대를 잃은 워커(옛 attempt)의 늦은 기록은 0행, 지금 임대의 기록만 들어간다', async () => {
    const w = await world();
    const scope = { agentId: w.fixture.agentId };
    const first = await w.schedules.claimDue(w.clock.now, 10, LEASE_SECONDS, scope);
    expect(first.map((r) => r.attemptCount)).toEqual([1]);
    // 임대 안에서는 다시 집히지 않는다.
    expect(await w.schedules.claimDue(w.clock.now, 10, LEASE_SECONDS, scope)).toEqual([]);
    w.advance();
    const second = await w.schedules.claimDue(w.clock.now, 10, LEASE_SECONDS, scope);
    expect(second.map((r) => r.attemptCount)).toEqual([2]);

    expect(await w.schedules.markDispatched(w.id, 1, 'sent', null, w.clock.now)).toBe(false);
    const row = await w.pool.query<{ status: string }>('SELECT status::text AS status FROM scheduled_sends WHERE id = $1', [w.id]);
    expect(row.rows[0]?.status).toBe('scheduled');
    expect(await w.schedules.markDispatched(w.id, 2, 'sent', null, w.clock.now)).toBe(true);
  });

  it(`시도 상한 — ${String(MAX_SCHEDULED_ATTEMPTS)}번째 집기까지는 아직 상한 안이다(관문에 가서 보낸다)`, async () => {
    const w = await world();
    const scope = { agentId: w.fixture.agentId };
    // 워커가 MAX-1 번 집고 결과 없이 죽었다.
    for (let attempt = 1; attempt < MAX_SCHEDULED_ATTEMPTS; attempt += 1) {
      expect((await w.schedules.claimDue(w.clock.now, 10, LEASE_SECONDS, scope)).map((r) => r.attemptCount)).toEqual([attempt]);
      w.advance();
    }
    // MAX 번째 — 아직 상한 안이다. 보낸다.
    const atLimit = await runScheduledSenderTick(w.tick);
    expect(atLimit.map((r) => r.outcome)).toEqual(['sent']);
    expect(w.transport.calls()).toBe(1);
  });

  it('시도 상한을 넘은 예약은 관문에 가지 않는다 — abandoned 로 닫힌다', async () => {
    const w = await world();
    const scope = { agentId: w.fixture.agentId };
    for (let attempt = 1; attempt <= MAX_SCHEDULED_ATTEMPTS; attempt += 1) {
      await w.schedules.claimDue(w.clock.now, 10, LEASE_SECONDS, scope);
      w.advance();
    }
    const over = await runScheduledSenderTick(w.tick);
    expect(over.map((r) => r.outcome)).toEqual(['abandoned']);
    expect(w.transport.calls()).toBe(0);
    const audits = await w.pool.query('SELECT 1 FROM audit_logs WHERE agent_id = $1', [w.fixture.agentId]);
    expect(audits.rowCount).toBe(0);
    const row = await w.pool.query<{ status: string; dispatch_outcome: string }>(
      'SELECT status::text AS status, dispatch_outcome FROM scheduled_sends WHERE id = $1',
      [w.id],
    );
    expect(row.rows[0]).toEqual({ status: 'dispatched', dispatch_outcome: 'abandoned' });
  });

  it('SKIP LOCKED — 다른 트랜잭션이 잡고 있는 예약은 기다리지 않고 건너뛴다', async () => {
    const w = await world();
    const holder = newIndependentPool({ max: 1 });
    const client = await holder.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM scheduled_sends WHERE id = $1 FOR UPDATE', [w.id]);
      const claimed = await Promise.race([
        w.schedules.claimDue(w.clock.now, 10, LEASE_SECONDS, { agentId: w.fixture.agentId }),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 1_500)),
      ]);
      expect(claimed).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await holder.end();
    }
    // 잠금이 풀리면 집힌다(통제군).
    expect((await w.schedules.claimDue(w.clock.now, 10, LEASE_SECONDS, { agentId: w.fixture.agentId })).map((r) => r.id)).toEqual([w.id]);
  });
});
