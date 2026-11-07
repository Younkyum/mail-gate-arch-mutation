/**
 * 검증 V2 결함 3 — **관문에 한 번도 닿지 못한 `pending` 은 재생이 아니라 이어서 진행한다.** 실제 Postgres(관문 저장소 전부).
 *
 * 사라지던 모양: 첫 시도가 `messages` INSERT(커밋) 뒤·관문 전에 멈춘다(본문 저장 실패, 프로세스 사망). 같은 멱등 키의
 * 재시도는 그 행을 `replayed` 로 받고 끝났다 — `messages=pending`, audit 0, SES 0. HTTP(5xx 뒤 재호출)와 예약 워커
 * (임대 만료 재집기) 둘 다 같은 `prepare` 를 지난다.
 *
 * 각 단언은 방어 하나를 겨냥한다(되돌리기):
 *   - ★ 본문 저장 실패 → 같은 키 재호출이 **곧바로** 관문으로 간다(SES 1, audit 1). `prepare` 의 이어받기를 지우면,
 *     또는 실패 시 임대를 놓지 않으면(`releaseClaim`) 빨갛다.
 *   - ★ 첫 시도가 아직 가는 중일 수 있는 동안(관문 앞 임대 안)은 재생이다 — 임대가 지나면 이어받는다. 임대 조건을
 *     지우면(항상 이어받기) 빨갛다.
 *   - ★ 이어받기는 **한 명만** 한다 — 동시 재시도 10개 중 관문에 가는 것은 1개, 거부 audit 도 1행. 조건부 쓰기를
 *     지우면 빨갛다.
 *   - 관문을 지난 `pending`(승인 대기)은 여전히 재생이다(새 평가 없음).
 *   - ★ 예약 워커: 본문 저장 실패 → 임대 만료 뒤 재집기가 실제로 보낸다. 관문 앞 임대가 살아 있어 이어받지 못한
 *     재생은 `dispatched/replayed` 로 닫지 않는다(다시 집힌다).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createInMemoryContentStore, createObjectContentStore, type MessageContentStore } from '../../../src/api/content-store';
import {
  finalizeOutbound,
  gateDependenciesFor,
  prepareOutbound,
  PREPARE_CLAIM_SECONDS,
  type OutboundSendRequest,
  type OutboundServiceDependencies,
} from '../../../src/api/outbound-service';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import type { ApiRequest } from '../../../src/api/http';
import { handleCreateScheduledMessage } from '../../../src/api/routes/scheduled-messages';
import { createPostgresAgentTokenStore, createPostgresGateStores } from '../../../src/db/repositories';
import { createPostgresScheduledSendStore } from '../../../src/db/repositories/scheduled-send-store';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { dispatch } from '../../../src/policy/gate';
import { createLocalObjectStore } from '../../../src/storage/local-object-store';
import { createScheduledContentStore } from '../../../src/storage/scheduled-content-store';
import { runScheduledSenderTick, type ScheduledSenderTickDependencies } from '../../../src/workers/scheduled-sender';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { countingTransport, type CountingTransport } from './support/fakes';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

const FRIEND = 'friend@example.com';
const STRANGER = 'stranger@example.com';

/** 처음 `failures` 번의 `put` 만 실패하는 본문 저장소(S3 일시 장애). */
function flakyContent(failures: number): MessageContentStore & { puts: () => number } {
  const inner = createInMemoryContentStore();
  let calls = 0;
  return {
    load: (id) => inner.load(id),
    put: (id, content) => {
      calls += 1;
      return calls <= failures ? Promise.reject(new Error('S3 503 SlowDown')) : inner.put(id, content);
    },
    puts: () => calls,
  };
}

interface World {
  readonly pool: Pool;
  readonly fixture: Fixture;
  readonly clock: { now: Date };
  readonly transport: CountingTransport;
  readonly service: OutboundServiceDependencies;
}

async function world(content: MessageContentStore): Promise<World> {
  const pool = testPool();
  const fixture = await seedFixture(pool, { allowlist: [FRIEND] });
  const clock = { now: new Date() };
  const stores = createPostgresGateStores(pool);
  return {
    pool,
    fixture,
    clock,
    transport: countingTransport(),
    service: {
      source: stores.source,
      audit: stores.audit,
      dispatchStore: stores.leases,
      serializer: stores.serializer,
      sendEvidence: stores.sendEvidence,
      messages: createPostgresOutboundMessageStore(pool),
      content,
      leaseTtlSeconds: 300,
      riskSignals: inertRiskSignals(),
      dlp: inertDlp(),
      now: () => clock.now,
    },
  };
}

function request(w: World, key: string, to = FRIEND): OutboundSendRequest {
  return {
    routeId: 'send',
    agentId: w.fixture.agentId,
    idempotencyKey: key,
    fromAddress: w.fixture.address,
    recipients: [to],
    subject: '이어서 진행',
    text: '본문',
    html: null,
    isThreadReply: false,
    traceId: null,
    costCents: 0,
  };
}

/** HTTP 라우트가 하는 셋 — 준비 → 관문 → 확정. */
async function send(w: World, key: string, to = FRIEND): Promise<string> {
  const prepared = await prepareOutbound(w.service, request(w, key, to));
  if (prepared.kind === 'settled') return prepared.outcome.kind;
  const outcome = await dispatch(gateDependenciesFor(w.service, w.transport), prepared.dispatchRequest);
  return (await finalizeOutbound(w.service, prepared, outcome)).kind;
}

async function stateOf(pool: Pool, agentId: string, key: string): Promise<{ status: string; audits: number }> {
  const result = await pool.query<{ status: string; audits: number }>(
    `SELECT m.status::text AS status, (SELECT count(*)::int FROM audit_logs a WHERE a.message_id = m.id) AS audits
       FROM messages m WHERE m.agent_id = $1 AND m.idempotency_key = $2`,
    [agentId, key],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('messages 행이 없다');
  return row;
}

async function setApprovalRequired(pool: Pool, agentId: string): Promise<void> {
  const config = { allowlist: [FRIEND], blocklist: [], max_attachment_bytes_total: 10_000_000, allowed_mime_types: ['text/plain'] };
  const limits = { per_minute: 10, per_hour: 100, per_day: 500, recipients_per_message: 20 };
  // 목록은 버전 1 의 스냅샷 그대로 싣는다 — 목록을 싣지 않은 버전으로 포인터를 옮기면 커밋되지 않는다(202609241040).
  await provisioningPool().query(
    `INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot)
     SELECT $1, 2, 'approval_required', $2::jsonb || jsonb_build_object('contact_rules', v.snapshot -> 'contact_rules')
       FROM policy_versions v WHERE v.agent_id = $1 AND v.version = 1`,
    [agentId, JSON.stringify({ outbound_mode: 'approval_required', limits, config_json: config })],
  );
  await provisioningPool().query(
    `UPDATE agent_policies SET outbound_mode = 'approval_required', current_version = 2 WHERE agent_id = $1`,
    [agentId],
  );
}

describe.skipIf(!DATABASE_AVAILABLE)('V2-3 — HTTP 경로(prepare): 관문 앞에서 멈춘 행', () => {
  it('★ 본문 저장 실패(5xx) → 같은 키 재호출이 곧바로 관문으로 — SES 1 · audit 1 · sent', async () => {
    const content = flakyContent(1);
    const w = await world(content);
    const key = `resume-put-${w.fixture.agentId}`;

    await expect(send(w, key)).rejects.toThrow(/SlowDown/);
    // 비공허성: 사라지던 바로 그 상태 — pending, audit 0.
    expect(await stateOf(w.pool, w.fixture.agentId, key)).toEqual({ status: 'pending', audits: 0 });

    expect(await send(w, key)).toBe('sent');
    expect(w.transport.calls()).toBe(1);
    expect(content.puts()).toBe(2);
    expect(await stateOf(w.pool, w.fixture.agentId, key)).toEqual({ status: 'sent', audits: 1 });

    // 그다음 재호출은 진짜 재생이다.
    expect(await send(w, key)).toBe('replayed');
    expect(w.transport.calls()).toBe(1);
  });

  it('★ INSERT 뒤·관문 전에 죽은 시도 — 관문 앞 임대 안에서는 재생, 임대가 지나면 이어받아 보낸다', async () => {
    // 운영과 같은 write-once 본문 저장소 — 이어받는 시도의 `put` 은 AlreadyStored 를 만난다.
    const w = await world(createObjectContentStore(createLocalObjectStore({ directory: mkdtempSync(join(tmpdir(), 'atmark-resume-c-')), env: {} })));
    const key = `resume-crash-${w.fixture.agentId}`;
    // 첫 시도: 준비까지 하고(본문도 썼다) 관문에 닿기 전에 죽었다.
    const first = await prepareOutbound(w.service, request(w, key));
    expect(first.kind).toBe('ready');

    // 곧바로 온 재시도 — 첫 시도가 아직 가는 중일 수 있다. 재생이고, 그 재생은 "관문을 지나지 않았다" 를 말한다.
    const early = await prepareOutbound(w.service, request(w, key));
    expect(early.kind === 'settled' && early.outcome.kind === 'replayed' ? early.outcome.message : null).toMatchObject({
      status: 'pending',
      gated: false,
    });

    w.clock.now = new Date(w.clock.now.getTime() + (PREPARE_CLAIM_SECONDS + 1) * 1000);
    // 본문은 첫 시도가 이미 썼다(write-once 저장소면 AlreadyStored) — 같은 요청이므로 그대로 관문으로 간다.
    expect(await send(w, key)).toBe('sent');
    expect(w.transport.calls()).toBe(1);
    expect(await stateOf(w.pool, w.fixture.agentId, key)).toEqual({ status: 'sent', audits: 1 });
  });

  it('★ 이어받기는 한 명만 — 동시 재시도 10개 → 관문 1번 · 거부 audit 1행', async () => {
    const w = await world(flakyContent(1));
    const key = `resume-race-${w.fixture.agentId}`;
    // allowlist 밖 — 거부는 lease 전에 audit 을 쓴다. 둘이 관문에 가면 audit 이 2행이 된다.
    await expect(send(w, key, STRANGER)).rejects.toThrow(/SlowDown/);

    const outcomes = await Promise.all(Array.from({ length: 10 }, () => prepareOutbound(w.service, request(w, key, STRANGER))));
    const ready = outcomes.filter((outcome) => outcome.kind === 'ready');
    expect(ready).toHaveLength(1);
    const prepared = ready[0];
    if (prepared?.kind !== 'ready') throw new Error('unreachable');
    const outcome = await dispatch(gateDependenciesFor(w.service, w.transport), prepared.dispatchRequest);
    expect((await finalizeOutbound(w.service, prepared, outcome)).kind).toBe('denied');
    expect(await stateOf(w.pool, w.fixture.agentId, key)).toEqual({ status: 'denied', audits: 1 });
    expect(w.transport.calls()).toBe(0);
  });

  it('관문을 지난 pending(승인 대기)은 이어받지 않는다 — 재생, 새 audit 없음', async () => {
    const w = await world(createInMemoryContentStore());
    await setApprovalRequired(w.pool, w.fixture.agentId);
    const key = `resume-approval-${w.fixture.agentId}`;
    expect(await send(w, key)).toBe('pending_approval');
    expect(await stateOf(w.pool, w.fixture.agentId, key)).toEqual({ status: 'pending', audits: 1 });

    w.clock.now = new Date(w.clock.now.getTime() + (PREPARE_CLAIM_SECONDS + 1) * 1000);
    const again = await prepareOutbound(w.service, request(w, key));
    expect(again.kind === 'settled' && again.outcome.kind === 'replayed' ? again.outcome.message : null).toMatchObject({
      status: 'pending',
      gated: true,
    });
    expect(await stateOf(w.pool, w.fixture.agentId, key)).toEqual({ status: 'pending', audits: 1 });
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('V2-3 — 예약 워커: 조용히 사라지지 않는다', () => {
  async function scheduled(content: MessageContentStore) {
    const w = await world(content);
    const issued = issueAgentToken(w.fixture.agentId);
    const tokens = createPostgresAgentTokenStore(w.pool);
    await createPostgresAgentTokenStore(provisioningPool()).insert({ agentId: w.fixture.agentId, tokenHash: issued.tokenHash, capabilities: issued.capabilities, expiresAt: null });
    const schedules = createPostgresScheduledSendStore(w.pool);
    const scheduledContent = createScheduledContentStore(
      createLocalObjectStore({ directory: mkdtempSync(join(tmpdir(), 'atmark-resume-')), env: {} }),
    );
    const tick: ScheduledSenderTickDependencies = {
      service: w.service,
      transport: w.transport,
      schedules,
      content: scheduledContent,
      leaseSeconds: 60,
      onlyAgentId: w.fixture.agentId,
    };
    const sendAt = new Date(w.clock.now.getTime() + 60_000);
    const create: ApiRequest = {
      headers: { authorization: `Bearer ${issued.plaintext}`, 'idempotency-key': `sched-${w.fixture.agentId}` },
      query: {},
      body: { agent_id: w.fixture.agentId, from: w.fixture.address, to: [FRIEND], subject: '예약', text: '본문', send_at: sendAt.toISOString() },
    };
    const created = await handleCreateScheduledMessage({ tokens, schedules, content: scheduledContent, now: () => w.clock.now, risk: { riskSignals: inertRiskSignals(), dlp: inertDlp(), now: () => w.clock.now } }, create);
    expect(created.status).toBe(202);
    w.clock.now = new Date(sendAt.getTime() + 1000);
    return { ...w, tick, scheduleId: String(created.body['schedule_id']) };
  }

  async function scheduleRow(pool: Pool, id: string) {
    const result = await pool.query<{ status: string; dispatch_outcome: string | null; message_id: string | null }>(
      'SELECT status::text AS status, dispatch_outcome, message_id FROM scheduled_sends WHERE id = $1',
      [id],
    );
    return result.rows[0];
  }

  it('★ 첫 시도의 본문 저장 실패 → retry → 임대 만료 뒤 재집기가 실제로 보낸다(dispatched/sent, SES 1)', async () => {
    const w = await scheduled(flakyContent(1));
    expect((await runScheduledSenderTick(w.tick)).map((r) => r.outcome)).toEqual(['retry']);
    expect(await scheduleRow(w.pool, w.scheduleId)).toMatchObject({ status: 'scheduled' });

    w.clock.now = new Date(w.clock.now.getTime() + 61_000);
    expect((await runScheduledSenderTick(w.tick)).map((r) => r.outcome)).toEqual(['sent']);
    expect(w.transport.calls()).toBe(1);
    expect(await scheduleRow(w.pool, w.scheduleId)).toMatchObject({ status: 'dispatched', dispatch_outcome: 'sent' });
  });

  it('★ 관문 앞 임대가 살아 있어 이어받지 못한 재생 → dispatched 로 닫지 않는다(다시 집힌다)', async () => {
    const w = await scheduled(createInMemoryContentStore());
    // 첫 워커: 관문 앞에서 죽었다 — 준비만 하고 dispatch 도 결과 기록도 없다.
    const dying: ScheduledSenderTickDependencies = {
      ...w.tick,
      service: { ...w.service, serializer: { serialize: () => Promise.reject(new Error('worker died')) } },
    };
    expect((await runScheduledSenderTick(dying)).map((r) => r.outcome)).toEqual(['retry']);
    const messageId = (await w.pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE agent_id = $1 AND idempotency_key LIKE 'scheduled:%'`,
      [w.fixture.agentId],
    )).rows[0]?.id;
    expect(messageId).toBeDefined();
    // 다른 워커가 그 행을 막 이어받아 관문으로 가는 중이다(관문 앞 임대 보유).
    await testPool().query(
      `INSERT INTO outbound_prepare_claims (message_id, claimed_until, generation) VALUES ($1, 'infinity', 1)`,
      [messageId],
    );

    w.clock.now = new Date(w.clock.now.getTime() + 61_000);
    expect((await runScheduledSenderTick(w.tick)).map((r) => r.outcome)).toEqual(['retry']);
    expect(await scheduleRow(w.pool, w.scheduleId)).toMatchObject({ status: 'scheduled', dispatch_outcome: null });
    expect(w.transport.calls()).toBe(0);
  });
});
