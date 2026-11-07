/**
 * 메일 기본기 A3 — 예약 조회·취소(`src/api/routes/scheduled-queries.ts` · `scheduled-send-store.ts` · 마이그레이션 202609260100·0105).
 * **실제 Postgres**(앱 롤 + 가드 확인용 소유자 롤) + 로컬 객체 저장소.
 *
 * 각 단언이 겨냥하는 것:
 *   - AC-A3-2 판정 표의 오류 코드가 서로 다르고, 재취소는 200 `replayed`, `reason_code` 가 없으면 400.
 *   - AC-A3-3 남의 예약 id → 404(없는 id 와 같은 응답), 토큰 권한 없음 → 403.
 *   - AC-A3-4 DB 가드: `cancelled → scheduled` · 취소 칼럼 고쳐 쓰기 · `agent_cancellable` 변경 · `send_at` 변경 거부(소유자 롤에서도),
 *     모양 CHECK(예약 중 취소 흔적 · 메모 제어문자) · 앱 롤은 그 칼럼들의 UPDATE 권한부터 없다.
 *   - AC-A3-6(1차 수정 — 보안 M1 리드 결정으로 경로 무관): `agent_cancellable=false` → HTTP·MCP 모두 403, HTTP·MCP 를 섞은 1시간 안
 *     6번째 → 어느 경로든 429(동시 요청도 5건에서 멈춘다), 행의 `cancelled_via` 는 들어온 경로. 거부마다 `scheduled.cancel_rejected` 로그.
 *     MCP 경로는 `mcpDependenciesOf` 가 리터럴 `'mcp'` 로 부른다. 상한 세기는 부분 색인을 쓸 수 있다.
 *   - 생성 재생 응답의 `status`·`cancelled_at`(코드 리뷰 L6).
 *   - 완화 ①·③: 구조화 로그 `scheduled.cancelled` 한 줄(동결 어휘 — 메모 없음) · 메트릭 `scheduledCancelled`(차원 `route_id`).
 *   - 목록·단건: 커서·상태 필터·응답 칸(메모 없음), 단건은 `subject`.
 *
 * **`TEST_DATABASE_URL` 이 없으면 통째로 건너뛴다.**
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { ApiRequest } from '../../../src/api/http';
import {
  handleCancelScheduledMessage,
  handleGetScheduledMessage,
  handleListScheduledMessages,
  type ScheduledQueryRouteDependencies,
} from '../../../src/api/routes/scheduled-queries';
import { handleCreateScheduledMessage } from '../../../src/api/routes/scheduled-messages';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories';
import { createPostgresScheduledSendStore } from '../../../src/db/repositories/scheduled-send-store';
import { AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT, type AgentTokenCapability } from '../../../src/db/schema';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { ALARM_LOG_EVENTS, METRIC_NAMES } from '../../../src/observability/metrics';
import { mcpDependenciesOf, type ApiDependencies } from '../../../src/runtime/router';
import { createLocalObjectStore } from '../../../src/storage/local-object-store';
import { createScheduledContentStore } from '../../../src/storage/scheduled-content-store';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool, type Fixture } from './support/harness';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';
import { type ScheduledMessageRouteDependencies } from '../../../src/api/routes/scheduled-messages';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

afterEach(() => {
  resetLogSink();
});

const FRIEND = 'friend@example.com';

interface World {
  readonly pool: Pool;
  readonly fixture: Fixture;
  readonly token: string;
  readonly clock: { now: Date };
  readonly deps: ScheduledQueryRouteDependencies & ScheduledMessageRouteDependencies;
}

async function issueToken(fixture: Fixture, capabilities?: readonly AgentTokenCapability[]): Promise<string> {
  const issued = issueAgentToken(fixture.agentId, capabilities);
  await createPostgresAgentTokenStore(provisioningPool()).insert({
    agentId: fixture.agentId,
    tokenHash: issued.tokenHash,
    capabilities: issued.capabilities,
    expiresAt: null,
  });
  return issued.plaintext;
}

async function world(): Promise<World> {
  const pool = testPool();
  const fixture = await seedFixture(pool, { allowlist: [FRIEND] });
  const token = await issueToken(fixture);
  const clock = { now: new Date() };
  const content = createScheduledContentStore(createLocalObjectStore({ directory: mkdtempSync(join(tmpdir(), 'atmark-cancel-')), env: {} }));
  const deps: ScheduledQueryRouteDependencies & ScheduledMessageRouteDependencies = {
    tokens: createPostgresAgentTokenStore(pool),
    schedules: createPostgresScheduledSendStore(pool),
    content,
    now: () => clock.now,
    risk: { riskSignals: inertRiskSignals(), dlp: inertDlp(), now: () => clock.now },
  };
  return { pool, fixture, token, clock, deps };
}

function auth(token: string): Readonly<Record<string, string>> {
  return { authorization: `Bearer ${token}` };
}

/** 생성 라우트로 예약 하나(기본 1시간 뒤). */
async function schedule(w: World, options: { readonly agentCancellable?: boolean; readonly sendAt?: Date; readonly subject?: string } = {}): Promise<string> {
  const response = await handleCreateScheduledMessage(w.deps, {
    headers: { ...auth(w.token), 'idempotency-key': randomUUID() },
    query: {},
    body: {
      agent_id: w.fixture.agentId,
      from: w.fixture.address,
      to: [FRIEND],
      subject: options.subject ?? '예약',
      text: '본문',
      send_at: (options.sendAt ?? new Date(w.clock.now.getTime() + 3600_000)).toISOString(),
      ...(options.agentCancellable === undefined ? {} : { agent_cancellable: options.agentCancellable }),
    },
  });
  expect(response.status).toBe(202);
  expect(response.body['agent_cancellable']).toBe(options.agentCancellable ?? true);
  return response.body['schedule_id'] as string;
}

function cancelRequest(token: string, body: unknown): ApiRequest {
  return { headers: auth(token), query: {}, body };
}

async function rowOf(pool: Pool, id: string): Promise<Record<string, unknown>> {
  const result = await pool.query(
    `SELECT status::text AS status, cancel_reason_code, cancel_note, cancelled_via, agent_cancellable, cancelled_at FROM scheduled_sends WHERE id = $1`,
    [id],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error(`예약 ${id} 가 없다`);
  return row;
}

describe.skipIf(!DATABASE_AVAILABLE)('A3 — 예약 취소 판정 (AC-A3-2 · AC-A3-3)', () => {
  it('취소 → 200 cancelled · 재취소는 200 replayed(판정 없이) · 행이 감사 기록이다', async () => {
    const w = await world();
    const id = await schedule(w);
    const first = await handleCancelScheduledMessage(w.deps, cancelRequest(w.token, { reason_code: 'wrong_time', note: '  다음 주로  ' }), { scheduleId: id }, 'http');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ schedule_id: id, status: 'cancelled', cancel_reason_code: 'wrong_time', cancelled_via: 'http', replayed: false });
    expect(first.body).not.toHaveProperty('cancel_note');
    expect(await rowOf(w.pool, id)).toMatchObject({ status: 'cancelled', cancel_reason_code: 'wrong_time', cancel_note: '다음 주로', cancelled_via: 'http' });

    // 재취소 — 다른 사유·경로로 와도 기록은 그대로다(쓰기 1회), 응답은 replayed.
    const again = await handleCancelScheduledMessage(w.deps, cancelRequest(w.token, { reason_code: 'other' }), { scheduleId: id }, 'mcp');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, cancel_reason_code: 'wrong_time', cancelled_via: 'http' });
  });

  it('reason_code 없음·모르는 값·메모 제어문자·201자 → 400, 행은 그대로 scheduled', async () => {
    const w = await world();
    const id = await schedule(w);
    const bodies: unknown[] = [
      {},
      { reason_code: 'because' },
      { reason_code: 'other', note: 'a\nb' },
      { reason_code: 'other', note: 'a b' },
      { reason_code: 'other', note: 7 },
      { reason_code: 'other', note: '가'.repeat(201) },
      null,
      ['other'],
    ];
    for (const body of bodies) {
      const response = await handleCancelScheduledMessage(w.deps, cancelRequest(w.token, body), { scheduleId: id }, 'http');
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body['error']).toBe('invalid_request');
    }
    // 코드 포인트로 센다 — 200자 한글은 통과.
    const ok = await handleCancelScheduledMessage(w.deps, cancelRequest(w.token, { reason_code: 'other', note: '가'.repeat(200) }), { scheduleId: id }, 'http');
    expect(ok.status).toBe(200);
  });

  it('발송된 예약 → 409 schedule_already_dispatched · 임대 중 → 409 schedule_in_flight (서로 다른 코드)', async () => {
    const w = await world();
    const dispatchedId = await schedule(w, { sendAt: new Date(w.clock.now.getTime() - 1000) });
    const inFlightId = await schedule(w, { sendAt: new Date(w.clock.now.getTime() - 500) });
    const claimed = await w.deps.schedules.claimDue(w.clock.now, 10, 300, { agentId: w.fixture.agentId });
    expect(claimed.map((r) => r.id).sort()).toEqual([dispatchedId, inFlightId].sort());
    const attempt = claimed.find((r) => r.id === dispatchedId)?.attemptCount ?? 0;
    expect(await w.deps.schedules.markDispatched(dispatchedId, attempt, 'sent', null, w.clock.now)).toBe(true);

    const dispatched = await handleCancelScheduledMessage(w.deps, cancelRequest(w.token, { reason_code: 'other' }), { scheduleId: dispatchedId }, 'http');
    const inFlight = await handleCancelScheduledMessage(w.deps, cancelRequest(w.token, { reason_code: 'other' }), { scheduleId: inFlightId }, 'http');
    expect([dispatched.status, dispatched.body['error']]).toEqual([409, 'schedule_already_dispatched']);
    expect([inFlight.status, inFlight.body['error']]).toEqual([409, 'schedule_in_flight']);
    expect((await rowOf(w.pool, inFlightId))['status']).toBe('scheduled');
  });

  it('남의 예약 id → 404(없는 id 와 같은 코드) · 권한 없는 토큰 → 403 · 형식 틀린 id → 400', async () => {
    const mine = await world();
    const theirs = await world();
    const theirId = await schedule(theirs);
    for (const scheduleId of [theirId, randomUUID()]) {
      const cancel = await handleCancelScheduledMessage(mine.deps, cancelRequest(mine.token, { reason_code: 'other' }), { scheduleId }, 'http');
      const get = await handleGetScheduledMessage(mine.deps, cancelRequest(mine.token, undefined), { scheduleId });
      expect([cancel.status, cancel.body['error']]).toEqual([404, 'schedule_not_found']);
      expect([get.status, get.body['error']]).toEqual([404, 'schedule_not_found']);
    }
    expect((await rowOf(theirs.pool, theirId))['status']).toBe('scheduled');
    // 남의 에이전트 목록은 403(대상을 쿼리로 적는 목록은 인가가 막는다 — 수신 목록과 같은 규약).
    const list = await handleListScheduledMessages(mine.deps, { headers: auth(mine.token), query: { agent_id: theirs.fixture.agentId }, body: undefined });
    expect(list.status).toBe(403);

    // 읽기만 가진 토큰은 취소 못 하고, 보내기만 가진 토큰은 읽지 못한다.
    const ownId = await schedule(mine);
    const readOnly = await issueToken(mine.fixture, ['messages:read']);
    const sendOnly = await issueToken(mine.fixture, ['messages:send']);
    const denied = await handleCancelScheduledMessage(mine.deps, cancelRequest(readOnly, { reason_code: 'other' }), { scheduleId: ownId }, 'http');
    expect([denied.status, denied.body['error']]).toEqual([403, 'forbidden']);
    const deniedRead = await handleGetScheduledMessage(mine.deps, cancelRequest(sendOnly, undefined), { scheduleId: ownId });
    expect(deniedRead.status).toBe(403);
    const deniedList = await handleListScheduledMessages(mine.deps, { headers: auth(sendOnly), query: { agent_id: mine.fixture.agentId }, body: undefined });
    expect(deniedList.status).toBe(403);
    const unauthenticated = await handleCancelScheduledMessage(mine.deps, cancelRequest('atk_agent_nope', { reason_code: 'other' }), { scheduleId: ownId }, 'http');
    expect(unauthenticated.status).toBe(401);

    const malformed = await handleCancelScheduledMessage(mine.deps, cancelRequest(mine.token, { reason_code: 'other' }), { scheduleId: 'NOT-A-UUID' }, 'http');
    expect(malformed.status).toBe(400);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('A3 — 에이전트 취소 보호: 경로 무관 (AC-A3-6 · 보안 M1 리드 결정)', () => {
  it('agent_cancellable=false → HTTP·MCP 둘 다 403 schedule_not_agent_cancellable · 행은 그대로 scheduled · 거부 로그 두 줄', async () => {
    const w = await world();
    const id = await schedule(w, { agentCancellable: false });
    const mcp = mcpDependenciesOf({ scheduledQueries: w.deps } as unknown as ApiDependencies);
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const viaHttp = await handleCancelScheduledMessage(w.deps, cancelRequest(w.token, { reason_code: 'owner_request' }), { scheduleId: id }, 'http');
    const viaMcp = await mcp.cancelScheduled(cancelRequest(w.token, { reason_code: 'owner_request' }), { scheduleId: id });
    resetLogSink();
    expect([viaHttp.status, viaHttp.body['error']]).toEqual([403, 'schedule_not_agent_cancellable']);
    expect([viaMcp.status, viaMcp.body['error']]).toEqual([403, 'schedule_not_agent_cancellable']);
    expect(await rowOf(w.pool, id)).toMatchObject({ status: 'scheduled', cancelled_via: null, agent_cancellable: false });
    const rejected = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line['event'] === ALARM_LOG_EVENTS.scheduledCancelRejected);
    expect(rejected.map((line) => [line['agent_id'], line['route_id'], line['outcome']])).toEqual([
      [w.fixture.agentId, 'http', 'not_agent_cancellable'],
      [w.fixture.agentId, 'mcp', 'not_agent_cancellable'],
    ]);
  });

  it(`HTTP·MCP 합쳐 1시간에 ${String(AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT)}건 — 섞어 보낸 6번째는 어느 경로든 429, 1시간 뒤 다시 열린다`, async () => {
    const w = await world();
    // 라우터의 MCP 칸 — 경로 리터럴 'mcp' 는 여기서 붙는다(헤더로 받지 않는다). 다른 칸은 건드리지 않는다.
    const mcp = mcpDependenciesOf({ scheduledQueries: w.deps } as unknown as ApiDependencies);
    const ids: string[] = [];
    for (let i = 0; i <= AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT; i += 1) ids.push(await schedule(w));

    const channels: string[] = [];
    for (const [index, id] of ids.slice(0, AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT).entries()) {
      w.clock.now = new Date(w.clock.now.getTime() + 60_000);
      const channel = index % 2 === 0 ? 'http' : 'mcp';
      const body = cancelRequest(w.token, { reason_code: 'no_longer_needed' });
      const response =
        channel === 'mcp'
          ? await mcp.cancelScheduled(body, { scheduleId: id })
          : await handleCancelScheduledMessage(w.deps, body, { scheduleId: id }, 'http');
      expect(response.status).toBe(200);
      channels.push((await rowOf(w.pool, id))['cancelled_via'] as string);
    }
    expect(channels).toEqual(['http', 'mcp', 'http', 'mcp', 'http']);

    const sixth = ids[AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT] as string;
    const limitedMcp = await mcp.cancelScheduled(cancelRequest(w.token, { reason_code: 'no_longer_needed' }), { scheduleId: sixth });
    const limitedHttp = await handleCancelScheduledMessage(w.deps, cancelRequest(w.token, { reason_code: 'no_longer_needed' }), { scheduleId: sixth }, 'http');
    expect([limitedMcp.status, limitedMcp.body['error']]).toEqual([429, 'cancel_rate_limited']);
    expect([limitedHttp.status, limitedHttp.body['error']]).toEqual([429, 'cancel_rate_limited']);
    expect((await rowOf(w.pool, sixth))['status']).toBe('scheduled');

    // 재생은 상한과 무관하다(판정 순서 — 이미 취소가 먼저).
    const replay = await mcp.cancelScheduled(cancelRequest(w.token, { reason_code: 'no_longer_needed' }), { scheduleId: ids[0] as string });
    expect(replay.body['replayed']).toBe(true);

    // 창은 1시간이다 — 첫 취소가 창 밖으로 나가면 다시 하나 열린다.
    w.clock.now = new Date(w.clock.now.getTime() + 3600_000 - 4 * 60_000);
    const reopened = await handleCancelScheduledMessage(w.deps, cancelRequest(w.token, { reason_code: 'other' }), { scheduleId: sixth }, 'http');
    expect(reopened.status).toBe(200);
    expect((await rowOf(w.pool, sixth))['cancelled_via']).toBe('http');
  });

  it('동시 취소 여덟 개(HTTP 넷 · MCP 넷) — 정확히 상한만큼만 취소된다(세고 쓰기를 에이전트별로 줄 세운다)', async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) ids.push(await schedule(w));
    const responses = await Promise.all(
      ids.map((id, index) =>
        handleCancelScheduledMessage(w.deps, cancelRequest(w.token, { reason_code: 'duplicate' }), { scheduleId: id }, index % 2 === 0 ? 'http' : 'mcp'),
      ),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(8 - AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT);
    const counted = await w.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM scheduled_sends WHERE agent_id = $1 AND cancelled_via IN ('http', 'mcp')`,
      [w.fixture.agentId],
    );
    expect(Number(counted.rows[0]?.n)).toBe(AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT);
  });

  it('상한 세기는 부분 색인 scheduled_sends_agent_cancel_idx 를 쓸 수 있다(술어가 저장소 쿼리와 같다)', async () => {
    const w = await world();
    const client = await w.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT count(*)::text AS count FROM scheduled_sends
          WHERE agent_id = $1 AND cancelled_via IN ('http', 'mcp') AND cancelled_at > $2::timestamptz - interval '1 hour'`,
        [w.fixture.agentId, w.clock.now],
      );
      expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('scheduled_sends_agent_cancel_idx');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('생성 재생 응답이 그사이의 취소를 알린다 — status·cancelled_at (코드 리뷰 L6)', async () => {
    const w = await world();
    const key = randomUUID();
    const create = (): Promise<{ status: number; body: Record<string, unknown> }> =>
      handleCreateScheduledMessage(w.deps, {
        headers: { ...auth(w.token), 'idempotency-key': key },
        query: {},
        body: {
          agent_id: w.fixture.agentId,
          from: w.fixture.address,
          to: [FRIEND],
          subject: '예약',
          text: '본문',
          send_at: new Date(w.clock.now.getTime() + 3600_000).toISOString(),
        },
      });
    const first = await create();
    expect(first.body).toMatchObject({ status: 'scheduled', cancelled_at: null, replayed: false });
    const id = first.body['schedule_id'] as string;
    expect((await handleCancelScheduledMessage(w.deps, cancelRequest(w.token, { reason_code: 'duplicate' }), { scheduleId: id }, 'http')).status).toBe(200);
    const replayed = await create();
    expect(replayed.status).toBe(202);
    expect(replayed.body).toMatchObject({ schedule_id: id, status: 'cancelled', cancelled_at: w.clock.now.toISOString(), replayed: true });
  });

  it('구조화 로그 한 줄(동결 어휘 · 메모 없음) + 메트릭(route_id) — 재생은 세지 않는다', async () => {
    const w = await world();
    const id = await schedule(w);
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const secret = `NOTE-${randomUUID()}`;
    await handleCancelScheduledMessage(w.deps, cancelRequest(w.token, { reason_code: 'wrong_recipient', note: secret }), { scheduleId: id }, 'mcp');
    await handleCancelScheduledMessage(w.deps, cancelRequest(w.token, { reason_code: 'wrong_recipient', note: secret }), { scheduleId: id }, 'mcp');
    resetLogSink();

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const events = parsed.filter((line) => line['event'] === ALARM_LOG_EVENTS.scheduledCancelled);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agent_id: w.fixture.agentId, route_id: 'mcp', reason: 'wrong_recipient', detail: id });
    const metrics = parsed.filter((line) => METRIC_NAMES.scheduledCancelled in line);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ route_id: 'mcp', [METRIC_NAMES.scheduledCancelled]: 1 });
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.join('\n')).not.toContain(FRIEND);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('A3 — 조회 (목록 · 단건)', () => {
  it('목록: send_at 내림차순 커서 · status 필터 · 칸 모양(메모 없음) · 단건은 subject', async () => {
    const w = await world();
    const base = w.clock.now.getTime() + 3600_000;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await schedule(w, { sendAt: new Date(base + i * 60_000), subject: `제목 ${String(i)}` }));
    await handleCancelScheduledMessage(w.deps, cancelRequest(w.token, { reason_code: 'duplicate', note: '비밀 메모' }), { scheduleId: ids[1] as string }, 'http');

    const list = (query: Record<string, string>) =>
      handleListScheduledMessages(w.deps, { headers: auth(w.token), query: { agent_id: w.fixture.agentId, ...query }, body: undefined });
    const first = await list({ limit: '2' });
    expect(first.status).toBe(200);
    expect(Object.keys(first.body).sort()).toEqual(['next_cursor', 'schedules']);
    const firstPage = first.body['schedules'] as Record<string, unknown>[];
    expect(firstPage.map((s) => s['schedule_id'])).toEqual([ids[4], ids[3]]);
    expect(Object.keys(firstPage[0] ?? {}).sort()).toEqual(
      [
        'agent_cancellable',
        'cancel_reason_code',
        'cancelled_at',
        'cancelled_via',
        'created_at',
        'dispatch_outcome',
        'from_address',
        'message_id',
        'recipient_count',
        'recipients',
        'schedule_id',
        'send_at',
        'status',
      ].sort(),
    );
    expect(firstPage[0]).toMatchObject({ recipients: [FRIEND], recipient_count: 1, from_address: w.fixture.address, status: 'scheduled' });

    const collected = [...firstPage];
    let cursor = first.body['next_cursor'] as string | null;
    while (cursor !== null) {
      const next = await list({ limit: '2', cursor });
      collected.push(...(next.body['schedules'] as Record<string, unknown>[]));
      cursor = next.body['next_cursor'] as string | null;
    }
    expect(collected.map((s) => s['schedule_id'])).toEqual([...ids].reverse());
    expect(JSON.stringify(collected)).not.toContain('비밀 메모');

    const cancelled = await list({ status: 'cancelled' });
    expect((cancelled.body['schedules'] as Record<string, unknown>[]).map((s) => [s['schedule_id'], s['cancel_reason_code'], s['cancelled_via']])).toEqual([
      [ids[1], 'duplicate', 'http'],
    ]);

    for (const bad of [{ status: 'pending' }, { limit: '0' }, { limit: '51' }, { cursor: '!!' }]) {
      expect((await list(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    // agent_id 생략 = 토큰의 에이전트(2026-10-11) — 같은 목록이다.
    const noAgent = await handleListScheduledMessages(w.deps, { headers: auth(w.token), query: {}, body: undefined });
    expect(noAgent.status).toBe(200);
    expect((noAgent.body['schedules'] as Record<string, unknown>[]).map((s) => s['schedule_id'])).toEqual([...ids].reverse());

    const single = await handleGetScheduledMessage(w.deps, cancelRequest(w.token, undefined), { scheduleId: ids[2] as string });
    expect(single.status).toBe(200);
    expect(single.body).toMatchObject({ schedule_id: ids[2], subject: '제목 2', status: 'scheduled', agent_cancellable: true });
    expect(single.body).not.toHaveProperty('cancel_note');
  });

  it('생성 본문의 agent_cancellable 이 불리언이 아니면 400 · false 는 요청 해시에 든다(같은 키로 값을 바꾸면 409)', async () => {
    const w = await world();
    const request = (key: string, value: unknown): ApiRequest => ({
      headers: { ...auth(w.token), 'idempotency-key': key },
      query: {},
      body: {
        agent_id: w.fixture.agentId,
        from: w.fixture.address,
        to: [FRIEND],
        subject: '예약',
        text: '본문',
        send_at: new Date(w.clock.now.getTime() + 3600_000).toISOString(),
        agent_cancellable: value,
      },
    });
    expect((await handleCreateScheduledMessage(w.deps, request(randomUUID(), 'no'))).status).toBe(400);
    const key = randomUUID();
    expect((await handleCreateScheduledMessage(w.deps, request(key, true))).status).toBe(202);
    expect((await handleCreateScheduledMessage(w.deps, request(key, false))).status).toBe(409);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('A3 — DB 가드 (AC-A3-4)', () => {
  async function cancelledRow(): Promise<{ w: World; id: string }> {
    const w = await world();
    const id = await schedule(w);
    const response = await handleCancelScheduledMessage(w.deps, cancelRequest(w.token, { reason_code: 'other', note: '메모' }), { scheduleId: id }, 'http');
    expect(response.status).toBe(200);
    return { w, id };
  }

  it('소유자 롤에서도: cancelled → scheduled · 취소 칼럼 고쳐 쓰기 · 메모 뒤늦게 채우기 거부', async () => {
    const { id } = await cancelledRow();
    const owner = provisioningPool();
    const attempts = [
      `UPDATE scheduled_sends SET status = 'scheduled', cancelled_at = NULL, cancel_reason_code = NULL, cancel_note = NULL, cancelled_via = NULL WHERE id = $1`,
      `UPDATE scheduled_sends SET cancel_reason_code = 'duplicate' WHERE id = $1`,
      `UPDATE scheduled_sends SET cancelled_via = 'mcp' WHERE id = $1`,
      `UPDATE scheduled_sends SET cancelled_at = cancelled_at - interval '1 day' WHERE id = $1`,
      `UPDATE scheduled_sends SET cancel_note = '다른 메모' WHERE id = $1`,
    ];
    for (const sql of attempts) {
      await expect(owner.query(sql, [id]), sql).rejects.toMatchObject({ code: '23514' });
    }
    // 쓰기 1회 트리거는 종단 가드와 **따로** 선다 — 종단 가드를 끈 채로도 고쳐 쓰기가 막힌다.
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE scheduled_sends DISABLE TRIGGER scheduled_sends_terminal_guard');
      await expect(client.query(`UPDATE scheduled_sends SET cancel_reason_code = 'duplicate' WHERE id = $1`, [id])).rejects.toThrow(/write-once/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // 반대로 쓰기 1회 트리거를 꺼도 종단 가드가 `cancelled → scheduled` 를 막는다.
    const other = await owner.connect();
    try {
      await other.query('BEGIN');
      await other.query('ALTER TABLE scheduled_sends DISABLE TRIGGER scheduled_sends_cancel_write_once');
      await expect(
        other.query(
          `UPDATE scheduled_sends SET status = 'scheduled', cancelled_at = NULL, cancel_reason_code = NULL, cancel_note = NULL, cancelled_via = NULL WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/terminal/);
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
  });

  it('agent_cancellable · send_at 은 불변(예약 중에도, 소유자 롤에서도) · 앱 롤은 그 칼럼 UPDATE 권한부터 없다', async () => {
    const w = await world();
    const id = await schedule(w, { agentCancellable: false });
    const owner = provisioningPool();
    for (const sql of [
      `UPDATE scheduled_sends SET agent_cancellable = true WHERE id = $1`,
      `UPDATE scheduled_sends SET send_at = send_at + interval '1 day' WHERE id = $1`,
    ]) {
      await expect(owner.query(sql, [id]), sql).rejects.toMatchObject({ code: '23514' });
      await expect(w.pool.query(sql, [id]), sql).rejects.toMatchObject({ code: '42501' });
    }
    expect((await rowOf(w.pool, id))['agent_cancellable']).toBe(false);
  });

  it('모양 CHECK: 예약 중 행에 취소 흔적 · 사유 없는 취소 · 모르는 사유·경로 · 메모 제어문자 거부(앱 롤)', async () => {
    const w = await world();
    const id = await schedule(w);
    for (const [sql, params] of [
      [`UPDATE scheduled_sends SET cancelled_at = now() WHERE id = $1`, []],
      [`UPDATE scheduled_sends SET status = 'cancelled', cancelled_at = now(), cancelled_via = 'http' WHERE id = $1`, []],
      [`UPDATE scheduled_sends SET status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'because', cancelled_via = 'http' WHERE id = $1`, []],
      [`UPDATE scheduled_sends SET status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'other', cancelled_via = 'header' WHERE id = $1`, []],
      [`UPDATE scheduled_sends SET status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'other', cancelled_via = 'http', cancel_note = $2 WHERE id = $1`, ['a\nb']],
      [`UPDATE scheduled_sends SET status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'other', cancelled_via = 'http', cancel_note = $2 WHERE id = $1`, ['x'.repeat(201)]],
    ] as const) {
      await expect(w.pool.query(sql, [id, ...params]), sql).rejects.toMatchObject({ code: '23514' });
    }
    expect((await rowOf(w.pool, id))['status']).toBe('scheduled');
  });
});
