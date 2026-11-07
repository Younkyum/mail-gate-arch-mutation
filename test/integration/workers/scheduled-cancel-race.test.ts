/**
 * 메일 기본기 A3 — 예약 **취소 ↔ 예약 워커** 경합(계획 R6). 실제 Postgres + 세는 전송단 + 진짜 워커 틱(`runScheduledSenderTick`).
 *
 *   - AC-A3-1 취소하면 다음 틱의 전송단 호출이 0이다(집히지도 않고, 관문 audit 도 없다).
 *   - 워커가 쥔 예약(임대 중)은 409 `schedule_in_flight`, 워커가 끝낸 예약은 409 `schedule_already_dispatched`.
 *   - 워커가 보낸 뒤 결과 기록 전에 죽었다(임대 만료 · `scheduled:{id}` 발송행 있음) → 여전히 `schedule_in_flight` — 다음 틱이 재생으로
 *     닫는다(SES 1회). 저장소의 발송행 키가 워커의 `scheduledIdempotencyKey` 와 같다는 것도 이 시나리오가 확인한다(다르면 취소가 통과한다).
 *   - 집은 뒤 발송행을 만들기 전에 죽은 워커(임대 만료 · 발송행 없음)는 취소되고, 그 워커의 늦은 `markDispatched` 는 0행이다(펜싱).
 *   - AC-A3-5 임대(`LEASE_TTL_SECONDS`) > 예약 워커 Lambda 타임아웃 — 취소가 "임대가 풀렸으면 워커는 끝났다" 에 기댄다.
 *
 * **`TEST_DATABASE_URL` 이 없으면 통째로 건너뛴다**(AC-A3-5 의 상수 단언은 DB 없이 돈다).
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { createInMemoryContentStore } from '../../../src/api/content-store';
import type { ApiRequest } from '../../../src/api/http';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import { handleCancelScheduledMessage, type ScheduledQueryRouteDependencies } from '../../../src/api/routes/scheduled-queries';
import { createPostgresAgentTokenStore, createPostgresGateStores } from '../../../src/db/repositories';
import { createPostgresScheduledSendStore } from '../../../src/db/repositories/scheduled-send-store';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { LEASE_TTL_SECONDS } from '../../../src/runtime/composition';
import { createLocalObjectStore } from '../../../src/storage/local-object-store';
import { createScheduledContentStore } from '../../../src/storage/scheduled-content-store';
import {
  runScheduledSenderTick,
  scheduledIdempotencyKey,
  type ScheduledSenderTickDependencies,
} from '../../../src/workers/scheduled-sender';
import { closeTestPool, DATABASE_AVAILABLE, hex64, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { countingTransport, type CountingTransport } from '../outbound/support/fakes';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

const FRIEND = 'friend@example.com';
const LEASE_SECONDS = 60;

interface World {
  readonly pool: Pool;
  readonly fixture: Fixture;
  readonly token: string;
  readonly clock: { now: Date };
  readonly transport: CountingTransport;
  readonly tick: ScheduledSenderTickDependencies;
  readonly routeDeps: ScheduledQueryRouteDependencies;
  readonly advancePastLease: () => void;
}

async function world(): Promise<World> {
  const pool = testPool();
  const fixture = await seedFixture(pool, { allowlist: [FRIEND] });
  const issued = issueAgentToken(fixture.agentId);
  await createPostgresAgentTokenStore(provisioningPool()).insert({
    agentId: fixture.agentId,
    tokenHash: issued.tokenHash,
    capabilities: issued.capabilities,
    expiresAt: null,
  });
  const clock = { now: new Date() };
  const stores = createPostgresGateStores(pool);
  const content = createScheduledContentStore(createLocalObjectStore({ directory: mkdtempSync(join(tmpdir(), 'atmark-race-')), env: {} }));
  const schedules = createPostgresScheduledSendStore(pool);
  const transport = countingTransport();
  return {
    pool,
    fixture,
    token: issued.plaintext,
    clock,
    transport,
    tick: {
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
      // 같은 DB 를 병렬로 쓰는 다른 테스트의 예약을 집지 않게.
      onlyAgentId: fixture.agentId,
    },
    routeDeps: { tokens: createPostgresAgentTokenStore(pool), schedules, content, now: () => clock.now },
    advancePastLease: () => {
      clock.now = new Date(clock.now.getTime() + (LEASE_SECONDS + 1) * 1000);
    },
  };
}

/** 기한이 이미 된 예약 하나(저장소로 직접 — 생성 라우트는 과거 시각을 받지 않는다). */
async function dueSchedule(w: World): Promise<string> {
  const id = randomUUID();
  await w.tick.content.put(id, { subject: '경합', text: '본문', html: null });
  const created = await w.tick.schedules.create({
    id,
    agentId: w.fixture.agentId,
    idempotencyKey: `race-${id}`,
    requestHash: hex64(),
    fromAddress: w.fixture.address,
    recipients: [FRIEND],
    sendAt: new Date(w.clock.now.getTime() - 1000),
    contentStorageKey: w.tick.content.keyFor(id),
    traceId: null,
    costCents: 0,
  });
  expect(created.kind).toBe('created');
  return id;
}

function cancel(w: World, id: string): ReturnType<typeof handleCancelScheduledMessage> {
  const request: ApiRequest = { headers: { authorization: `Bearer ${w.token}` }, query: {}, body: { reason_code: 'no_longer_needed' } };
  return handleCancelScheduledMessage(w.routeDeps, request, { scheduleId: id }, 'http');
}

async function statusOf(pool: Pool, id: string): Promise<string | undefined> {
  const result = await pool.query<{ status: string }>('SELECT status::text AS status FROM scheduled_sends WHERE id = $1', [id]);
  return result.rows[0]?.status;
}

describe.skipIf(!DATABASE_AVAILABLE)('A3 — 취소 ↔ 예약 워커 (AC-A3-1 · R6)', () => {
  it('AC-A3-1 취소한 예약은 다음 틱에 집히지 않는다 — 전송단 0 · audit 0 · 발송행 0', async () => {
    const w = await world();
    const id = await dueSchedule(w);
    expect((await cancel(w, id)).status).toBe(200);

    expect(await runScheduledSenderTick(w.tick)).toEqual([]);
    w.advancePastLease();
    expect(await runScheduledSenderTick(w.tick)).toEqual([]);
    expect(w.transport.calls()).toBe(0);
    expect(await statusOf(w.pool, id)).toBe('cancelled');
    expect((await w.pool.query('SELECT 1 FROM audit_logs WHERE agent_id = $1', [w.fixture.agentId])).rowCount).toBe(0);
    expect((await w.pool.query('SELECT 1 FROM messages WHERE agent_id = $1', [w.fixture.agentId])).rowCount).toBe(0);
  });

  it('워커가 쥔 예약(임대 중) → 409 schedule_in_flight · 워커가 끝내면 409 schedule_already_dispatched', async () => {
    const w = await world();
    const id = await dueSchedule(w);
    const claimed = await w.tick.schedules.claimDue(w.clock.now, 10, LEASE_SECONDS, { agentId: w.fixture.agentId });
    expect(claimed.map((r) => r.id)).toEqual([id]);
    const whileHeld = await cancel(w, id);
    expect([whileHeld.status, whileHeld.body['error']]).toEqual([409, 'schedule_in_flight']);

    // 임대가 풀린 뒤 워커가 다시 집어 보낸다 — 취소는 그 사이에 끼어들지 않았다.
    w.advancePastLease();
    expect((await runScheduledSenderTick(w.tick)).map((r) => r.outcome)).toEqual(['sent']);
    const after = await cancel(w, id);
    expect([after.status, after.body['error']]).toEqual([409, 'schedule_already_dispatched']);
    expect(w.transport.calls()).toBe(1);
  });

  it('보낸 뒤 결과 기록 전에 죽은 워커 — 임대가 풀려도 scheduled:{id} 발송행이 있으면 409 in_flight, 다음 틱이 재생으로 닫는다(SES 1회)', async () => {
    const w = await world();
    const id = await dueSchedule(w);
    const dying: ScheduledSenderTickDependencies = {
      ...w.tick,
      schedules: { ...w.tick.schedules, markDispatched: () => Promise.reject(new Error('worker died')) },
    };
    expect((await runScheduledSenderTick(dying)).map((r) => r.outcome)).toEqual(['retry']);
    expect(w.transport.calls()).toBe(1);
    const sendRow = await w.pool.query('SELECT 1 FROM messages WHERE agent_id = $1 AND idempotency_key = $2', [
      w.fixture.agentId,
      scheduledIdempotencyKey(id),
    ]);
    expect(sendRow.rowCount).toBe(1);

    w.advancePastLease();
    const inFlight = await cancel(w, id);
    expect([inFlight.status, inFlight.body['error']]).toEqual([409, 'schedule_in_flight']);
    expect(await statusOf(w.pool, id)).toBe('scheduled');

    expect((await runScheduledSenderTick(w.tick)).map((r) => r.outcome)).toEqual(['replayed']);
    expect(w.transport.calls()).toBe(1);
    expect(await statusOf(w.pool, id)).toBe('dispatched');
  });

  it('집은 뒤 발송행 전에 죽은 워커(임대 만료 · 발송행 없음) → 취소된다 · 그 워커의 늦은 기록은 0행(펜싱)', async () => {
    const w = await world();
    const id = await dueSchedule(w);
    const [claimed] = await w.tick.schedules.claimDue(w.clock.now, 10, LEASE_SECONDS, { agentId: w.fixture.agentId });
    expect(claimed?.id).toBe(id);
    w.advancePastLease();

    expect((await cancel(w, id)).status).toBe(200);
    expect(await w.tick.schedules.markDispatched(id, claimed?.attemptCount ?? 0, 'sent', null, w.clock.now)).toBe(false);
    expect(await statusOf(w.pool, id)).toBe('cancelled');
    expect(await runScheduledSenderTick(w.tick)).toEqual([]);
    expect(w.transport.calls()).toBe(0);
  });
});

describe('AC-A3-5 — 임대 > 워커 타임아웃', () => {
  it('LEASE_TTL_SECONDS 가 예약 워커 Lambda 타임아웃보다 길다(여유 두 배 이상)', () => {
    const stack = readFileSync(join(process.cwd(), 'infra/cdk/stacks/compute-stack.ts'), 'utf8');
    const block = /'scheduled-sender':\s*\{[^}]*?timeout:\s*cdk\.Duration\.seconds\((\d+)\)/.exec(stack);
    const timeoutSeconds = Number(block?.[1]);
    expect(Number.isInteger(timeoutSeconds) && timeoutSeconds > 0).toBe(true); // 비공허 — 실제로 읽었다.
    expect(LEASE_TTL_SECONDS).toBeGreaterThan(timeoutSeconds);
    expect(LEASE_TTL_SECONDS).toBeGreaterThanOrEqual(2 * timeoutSeconds);
  });
});
