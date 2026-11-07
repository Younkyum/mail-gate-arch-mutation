/**
 * 웹훅 v2(메일 기본기 1차 A4) — **실제 Postgres 위에서**: 구독(opt-in, AC-A4-1) · 소프트 삭제 · 재등록 상한(AC-A4-5) · 전달 목록 ·
 * 재전송(AC-A4-6). SES 소비자 경로는 `test/integration/workers/ses-event-webhook.test.ts`.
 *
 * 정리를 하지 않는다(DELETE 가 막혀 있다) — 테스트마다 새 에이전트를 만들고 자기 행만 본다. 적재 시각은 먼 미래(2999년)다 — 다른 파일의
 * 디스패처 테스트(1970년대 시각·자기 엔드포인트로 거른 outbox)가 이 파일의 pending 행을 집을 일이 없다.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import {
  handleDeleteWebhookEndpoint,
  handleListWebhookEndpoints,
  handleRegisterWebhookEndpoint,
  MAX_WEBHOOK_REGISTRATIONS_PER_DAY,
} from '../../../src/api/routes/webhook-endpoints';
import {
  decodeDeliveryCursor,
  handleListWebhookDeliveries,
  handleRedeliverWebhookDelivery,
} from '../../../src/api/routes/webhook-deliveries';
import type { ApiRequest } from '../../../src/api/http';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories/agent-token-store';
import {
  enqueueWebhookEvent,
  insertWebhookEndpoint,
  MAX_REDELIVERIES_PER_AGENT_HOURLY,
  MAX_REDELIVERIES_PER_ROOT,
} from '../../../src/db/repositories/webhook-store';
import type { AgentId } from '../../../src/db/schema';
import { AGENT_TOKEN_CAPABILITIES, issueAgentToken, type AgentTokenCapability } from '../../../src/identity/agent-token';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { LEGACY_EVENT_TYPES, messageDeliveredEvent, messageSentEvent } from '../../../src/webhooks/events';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool } from '../db/support/harness';

const RING = parseHmacKeyring(`w1:${randomBytes(32).toString('base64url')}`, 'TEST');
const FUTURE = new Date('2999-01-01T00:00:00.000Z');
const SES_KEY = () => `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

interface Agent {
  readonly agentId: AgentId;
  readonly token: string;
  readonly readOnlyToken: string;
}

async function issue(agentId: AgentId, capabilities?: readonly AgentTokenCapability[]): Promise<string> {
  const issued = issueAgentToken(agentId, capabilities);
  await createPostgresAgentTokenStore(provisioningPool()).insert({
    agentId,
    tokenHash: issued.tokenHash,
    capabilities: issued.capabilities,
    expiresAt: null,
  });
  return issued.plaintext;
}

async function seedAgent(pool: Pool): Promise<Agent> {
  const fixture = await seedFixture(pool);
  return {
    agentId: fixture.agentId,
    // 관리 토큰 = 기본 넷 + `webhooks:manage`(2026-09-30). 이 파일의 시계는 2999년이라 옛 토큰의 `messages:send` 전환 경로(2026-12-31 까지)는
    //   이미 닫혀 있다 — 그 경로는 `webhook-management.test.ts` 가 본다.
    token: await issue(fixture.agentId, [...AGENT_TOKEN_CAPABILITIES]),
    readOnlyToken: await issue(fixture.agentId, ['messages:read']),
  };
}

function bearer(token: string, body: unknown = null, query: Record<string, string> = {}): ApiRequest {
  return { headers: { authorization: `Bearer ${token}` }, query, body };
}

function endpointDeps(pool: Pool) {
  return { tokens: createPostgresAgentTokenStore(pool), db: pool, keyring: RING, now: () => FUTURE };
}

function deliveryDeps(pool: Pool) {
  return { tokens: createPostgresAgentTokenStore(pool), db: pool, now: () => FUTURE };
}

function url(): string {
  return `https://hooks-${randomUUID().slice(0, 8)}.example.com/atmark`;
}

async function register(pool: Pool, agent: Agent, body: Record<string, unknown> = { url: url() }) {
  return handleRegisterWebhookEndpoint(endpointDeps(pool), bearer(agent.token, body), { agentId: agent.agentId });
}

async function registered(pool: Pool, agent: Agent, eventTypes?: readonly string[]): Promise<string> {
  const response = await register(pool, agent, eventTypes === undefined ? { url: url() } : { url: url(), event_types: eventTypes });
  expect(response.status).toBe(201);
  return response.body['id'] as string;
}

async function rowsOf(pool: Pool, endpointId: string) {
  const result = await pool.query<{
    id: string;
    event_id: string;
    event_type: string;
    dedupe_key: string;
    body: string;
    status: string;
    redelivery_of: string | null;
  }>(
    `SELECT id, event_id, event_type::text AS event_type, dedupe_key, body, status::text AS status, redelivery_of
       FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at, id`,
    [endpointId],
  );
  return result.rows;
}

/** 앱 롤의 칸 단위 UPDATE 로 전달을 종단시킨다(디스패처가 쓰는 칸과 같다). */
async function kill(pool: Pool, deliveryId: string, lastError = 'http_status'): Promise<void> {
  const result = await pool.query(
    `UPDATE webhook_deliveries SET status = 'dead', dead_at = now(), last_error = $2 WHERE id = $1 AND status = 'pending'`,
    [deliveryId, lastError],
  );
  expect(result.rowCount).toBe(1);
}

async function sentDelivery(pool: Pool, agent: Agent, endpointId: string): Promise<string> {
  await enqueueWebhookEvent(pool, messageSentEvent({ agentId: agent.agentId, messageId: randomUUID(), sentAt: FUTURE }), FUTURE);
  const rows = await rowsOf(pool, endpointId);
  const last = rows[rows.length - 1];
  if (last === undefined) throw new Error('전달 행이 없다');
  return last.id;
}

async function rejects(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('거부돼야 한다');
}

describe.skipIf(!DATABASE_AVAILABLE)('A4 구독 — 엔드포인트별 opt-in (AC-A4-1)', () => {
  it('옛 엔드포인트(event_types NULL)는 옛 4종만, 구독 엔드포인트는 적은 것만 받는다 · 같은 사건 재적재는 0행', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const legacy = await registered(pool, agent);
    const outcomesOnly = await registered(pool, agent, ['message.delivered']);
    const mixed = await registered(pool, agent, ['message.bounced', 'message.sent']);

    const sent = messageSentEvent({ agentId: agent.agentId, messageId: randomUUID(), sentAt: FUTURE });
    expect(await enqueueWebhookEvent(pool, sent, FUTURE)).toBe(2);
    const delivered = messageDeliveredEvent({
      agentId: agent.agentId,
      messageId: randomUUID(),
      sesDedupeKey: SES_KEY(),
      occurredAt: FUTURE,
      recipientPositions: [0],
    });
    expect(await enqueueWebhookEvent(pool, delivered, FUTURE)).toBe(1);
    expect(await enqueueWebhookEvent(pool, delivered, FUTURE)).toBe(0);

    expect((await rowsOf(pool, legacy)).map((row) => row.event_type)).toEqual(['message.sent']);
    expect((await rowsOf(pool, outcomesOnly)).map((row) => row.event_type)).toEqual(['message.delivered']);
    expect((await rowsOf(pool, mixed)).map((row) => row.event_type)).toEqual(['message.sent']);
  });

  it('등록 본문 event_types — 중복 제거·정의 순서로 저장, 응답·목록은 NULL 을 옛 4종으로 풀어 보인다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const created = await register(pool, agent, {
      url: url(),
      event_types: ['message.complained', 'message.delivered', 'message.complained'],
    });
    expect(created.status).toBe(201);
    expect(created.body['event_types']).toEqual(['message.delivered', 'message.complained']);
    const stored = await pool.query<{ event_types: string[] }>(`SELECT event_types::text[] AS event_types FROM webhook_endpoints WHERE id = $1`, [
      created.body['id'],
    ]);
    expect(stored.rows[0]?.event_types).toEqual(['message.delivered', 'message.complained']);

    const plain = await register(pool, agent);
    expect(plain.body['event_types']).toEqual([...LEGACY_EVENT_TYPES]);
    const listed = await handleListWebhookEndpoints(endpointDeps(pool), bearer(agent.token), { agentId: agent.agentId });
    expect(listed.body['endpoints']).toEqual([
      expect.objectContaining({ id: created.body['id'], event_types: ['message.delivered', 'message.complained'] }),
      expect.objectContaining({ id: plain.body['id'], event_types: [...LEGACY_EVENT_TYPES] }),
    ]);
  });

  it.each([
    ['빈 배열', []],
    ['모르는 종류', ['message.quarantined']],
    ['문자열이 아니다', [7]],
    ['배열이 아니다', 'message.delivered'],
  ])('event_types 형식 오류는 400: %s', async (_label, eventTypes) => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const response = await register(pool, agent, { url: url(), event_types: eventTypes });
    expect(response).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
  });

  it('DB 바닥 — 빈 배열 CHECK · 구독은 등록 뒤 불변(소유자 롤도)', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const error = await rejects(
      pool.query(`INSERT INTO webhook_endpoints (agent_id, url, secret_kid, event_types) VALUES ($1, $2, 'w1', '{}')`, [agent.agentId, url()]),
    );
    expect(error.message).toMatch(/webhook_endpoints_event_types_shape/);
    const id = await registered(pool, agent);
    const update = await rejects(
      provisioningPool().query(`UPDATE webhook_endpoints SET event_types = '{message.delivered}' WHERE id = $1`, [id]),
    );
    expect(update.message).toMatch(/event_types/);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('A4 소프트 삭제 · 재등록 상한 (AC-A4-5)', () => {
  it('삭제는 webhooks:manage · 삭제 뒤 목록에서 사라지고 새 전달 0행 · 다시 삭제·남의 것·없는 것은 404', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const stranger = await seedAgent(pool);
    const id = await registered(pool, agent);
    const strangerHook = await registered(pool, stranger);
    const deps = endpointDeps(pool);
    const target = { agentId: agent.agentId, endpointId: id };

    expect((await handleDeleteWebhookEndpoint(deps, bearer(agent.readOnlyToken), target)).status).toBe(403);
    expect((await handleDeleteWebhookEndpoint(deps, bearer(stranger.token), target)).status).toBe(403);
    expect((await handleDeleteWebhookEndpoint(deps, bearer(agent.token), { ...target, endpointId: 'nope' })).status).toBe(400);

    const deleted = await handleDeleteWebhookEndpoint(deps, bearer(agent.token), target);
    expect(deleted).toMatchObject({ status: 200, body: { id, agent_id: agent.agentId } });
    expect(typeof deleted.body['deleted_at']).toBe('string');

    const listed = await handleListWebhookEndpoints(deps, bearer(agent.token), { agentId: agent.agentId });
    expect(listed.body['endpoints']).toEqual([]);
    expect(await enqueueWebhookEvent(pool, messageSentEvent({ agentId: agent.agentId, messageId: randomUUID(), sentAt: FUTURE }), FUTURE)).toBe(0);
    expect(await rowsOf(pool, id)).toEqual([]);

    expect((await handleDeleteWebhookEndpoint(deps, bearer(agent.token), target)).status).toBe(404);
    // 경로의 에이전트는 자기 것이지만 엔드포인트는 남의 것 — 끄지 않고 404.
    expect((await handleDeleteWebhookEndpoint(deps, bearer(agent.token), { agentId: agent.agentId, endpointId: strangerHook })).status).toBe(404);
    expect((await handleDeleteWebhookEndpoint(deps, bearer(agent.token), { agentId: agent.agentId, endpointId: randomUUID() })).status).toBe(404);
    const alive = await pool.query<{ disabled_at: Date | null }>('SELECT disabled_at FROM webhook_endpoints WHERE id = $1', [strangerHook]);
    expect(alive.rows[0]?.disabled_at).toBeNull();
  });

  it('되살리기 거부 — disabled_at 쓰기 1회(소유자 롤도) · 앱 롤은 표 UPDATE 자체가 없다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const id = await registered(pool, agent);
    expect((await handleDeleteWebhookEndpoint(endpointDeps(pool), bearer(agent.token), { agentId: agent.agentId, endpointId: id })).status).toBe(200);

    for (const sql of [
      'UPDATE webhook_endpoints SET disabled_at = NULL WHERE id = $1',
      "UPDATE webhook_endpoints SET disabled_at = disabled_at + interval '1 second' WHERE id = $1",
    ]) {
      const error = await rejects(provisioningPool().query(sql, [id]));
      expect(error.code).toBe('23514');
    }
    expect((await rejects(pool.query('UPDATE webhook_endpoints SET disabled_at = NULL WHERE id = $1', [id]))).message).toMatch(/permission denied/);
  });

  it('11번째 등록은 409 webhook_endpoint_registration_limit(24시간 · 삭제한 것 포함) · DB 바닥은 20', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const deps = endpointDeps(pool);
    for (let i = 0; i < MAX_WEBHOOK_REGISTRATIONS_PER_DAY; i += 1) {
      const id = await registered(pool, agent);
      expect((await handleDeleteWebhookEndpoint(deps, bearer(agent.token), { agentId: agent.agentId, endpointId: id })).status).toBe(200);
    }
    const eleventh = await register(pool, agent);
    expect(eleventh).toMatchObject({ status: 409, body: { error: 'webhook_endpoint_registration_limit' } });

    // 앱 검사를 거치지 않는 INSERT(소유자 롤)는 바닥 20 에서 멈춘다 — 활성 천장에 걸리지 않게 하나씩 끄며 넣는다.
    const owner = provisioningPool();
    for (let i = 0; i < 10; i += 1) {
      const row = await owner.query<{ id: string }>(`INSERT INTO webhook_endpoints (agent_id, url, secret_kid) VALUES ($1, $2, 'w1') RETURNING id`, [
        agent.agentId,
        url(),
      ]);
      await owner.query('UPDATE webhook_endpoints SET disabled_at = now() WHERE id = $1', [row.rows[0]?.id]);
    }
    const floor = await rejects(owner.query(`INSERT INTO webhook_endpoints (agent_id, url, secret_kid) VALUES ($1, $2, 'w1')`, [agent.agentId, url()]));
    expect(floor.message).toContain('max 20');
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('A4 전달 목록 — 본문·URL 없음 · 커서', () => {
  it('같은 시각에 적힌 행도 커서로 빠짐없이 한 번씩 · 본문·URL·dedupe 키 없음 · status 필터', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const hooks = [await registered(pool, agent), await registered(pool, agent), await registered(pool, agent)];
    // 한 INSERT … SELECT 가 세 행을 같은 created_at 으로 적는다.
    const event = messageSentEvent({ agentId: agent.agentId, messageId: randomUUID(), sentAt: FUTURE });
    expect(await enqueueWebhookEvent(pool, event, FUTURE)).toBe(3);
    const deps = deliveryDeps(pool);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const query: Record<string, string> = cursor === null ? { limit: '1' } : { limit: '1', cursor };
      const response = await handleListWebhookDeliveries(deps, bearer(agent.readOnlyToken, null, query), { agentId: agent.agentId });
      expect(response.status).toBe(200);
      const deliveries = response.body['deliveries'] as Record<string, unknown>[];
      for (const delivery of deliveries) seen.push(delivery['id'] as string);
      cursor = response.body['next_cursor'] as string | null;
      if (cursor === null) break;
      expect(decodeDeliveryCursor(cursor)).not.toBeNull();
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);

    const full = await handleListWebhookDeliveries(deps, bearer(agent.token), { agentId: agent.agentId });
    const [first] = full.body['deliveries'] as Record<string, unknown>[];
    expect(Object.keys(first ?? {}).sort()).toEqual(
      [
        'attempt_count',
        'created_at',
        'dead_at',
        'delivered_at',
        'endpoint_id',
        'event_id',
        'event_type',
        'id',
        'last_error',
        'last_http_status',
        'next_attempt_at',
        'redelivery_of',
        'status',
      ].sort(),
    );
    const json = JSON.stringify(full.body);
    expect(json).not.toContain('hooks-');
    expect(json).not.toContain(event.dedupeKey);
    expect(json).not.toContain('"body"');
    expect(hooks).toContain(first?.['endpoint_id']);

    await kill(pool, (first?.['id'] as string) ?? '');
    const dead = await handleListWebhookDeliveries(deps, bearer(agent.token, null, { status: 'dead' }), { agentId: agent.agentId });
    expect((dead.body['deliveries'] as unknown[]).length).toBe(1);
  });

  it('M4 엔드포인트별 LATERAL 병합 — 여러 엔드포인트에 엇갈려 적힌 행이 쪽을 넘겨도 전역 최신순 그대로 · 삭제된 엔드포인트의 행도 보인다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const a = await registered(pool, agent);
    const b = await registered(pool, agent);
    const written: string[] = [];
    // a·b 가 번갈아 한 행씩 받게 한다(구독 없는 옛 4종 → 두 엔드포인트 모두 받는다 — 매 적재 2행, 같은 created_at).
    for (let i = 0; i < 4; i += 1) {
      await enqueueWebhookEvent(pool, messageSentEvent({ agentId: agent.agentId, messageId: randomUUID(), sentAt: FUTURE }), FUTURE);
    }
    const all = await pool.query<{ id: string }>(
      `SELECT d.id FROM webhook_deliveries d WHERE d.endpoint_id = ANY ($1::uuid[]) ORDER BY d.created_at DESC, d.id DESC`,
      [[a, b]],
    );
    written.push(...all.rows.map((row) => row.id));
    expect(written).toHaveLength(8);
    expect(
      (await handleDeleteWebhookEndpoint(endpointDeps(pool), bearer(agent.token), { agentId: agent.agentId, endpointId: b })).status,
    ).toBe(200);

    const deps = deliveryDeps(pool);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const query: Record<string, string> = cursor === null ? { limit: '3' } : { limit: '3', cursor };
      const response = await handleListWebhookDeliveries(deps, bearer(agent.token, null, query), { agentId: agent.agentId });
      expect(response.status).toBe(200);
      seen.push(...(response.body['deliveries'] as Record<string, unknown>[]).map((delivery) => delivery['id'] as string));
      cursor = response.body['next_cursor'] as string | null;
      if (cursor === null) break;
    }
    expect(seen).toEqual(written);
  });

  it('남의 에이전트 403 · limit·status·cursor 형식 400', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const stranger = await seedAgent(pool);
    const deps = deliveryDeps(pool);
    const target = { agentId: agent.agentId };
    expect((await handleListWebhookDeliveries(deps, bearer(stranger.token), target)).status).toBe(403);
    for (const query of [{ limit: '0' }, { limit: '101' }, { status: 'lost' }, { cursor: 'not a cursor' }, { cursor: 'Zm9v' }]) {
      expect((await handleListWebhookDeliveries(deps, bearer(agent.token, null, query), target)).status).toBe(400);
    }
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('A4 재전송 (AC-A4-6)', () => {
  async function world() {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const endpointId = await registered(pool, agent);
    const deps = deliveryDeps(pool);
    const redeliver = (deliveryId: string, token = agent.token) =>
      handleRedeliverWebhookDelivery(deps, bearer(token), { agentId: agent.agentId, deliveryId });
    return { pool, agent, endpointId, redeliver };
  }

  it('dead 만 · 새 행은 같은 event_id·body 로 루트를 가리킨다 · 재전송 행을 지정해도 루트 귀속 · 루트 4번째는 409', async () => {
    const { pool, agent, endpointId, redeliver } = await world();
    const root = await sentDelivery(pool, agent, endpointId);

    expect(await redeliver(root)).toMatchObject({ status: 409, body: { error: 'delivery_not_dead' } });
    await kill(pool, root);
    expect((await redeliver(root, agent.readOnlyToken)).status).toBe(403);

    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const first = await redeliver(root).finally(() => resetLogSink());
    expect(first).toMatchObject({ status: 201, body: { redelivery_of: root, status: 'pending', redeliveries_used: 1, redeliveries_max: 3 } });
    expect(lines.filter((line) => line.includes('"atmark.webhook.redelivered"'))).toHaveLength(1);

    const rows = await rowsOf(pool, endpointId);
    const rootRow = rows.find((row) => row.id === root);
    const copy = rows.find((row) => row.id === first.body['id']);
    expect(copy).toMatchObject({
      event_id: rootRow?.event_id,
      event_type: rootRow?.event_type,
      body: rootRow?.body,
      redelivery_of: root,
      dedupe_key: `redelivery:${root}:1`,
      status: 'pending',
    });
    expect(first.body['event_id']).toBe(rootRow?.event_id);

    // 재전송 행이 pending 이면 그 행은 재전송 대상이 아니다. dead 가 되면 지정할 수 있고 — 루트로 귀속된다(사슬 없음).
    const copyId = first.body['id'] as string;
    expect(await redeliver(copyId)).toMatchObject({ status: 409, body: { error: 'delivery_not_dead' } });
    await kill(pool, copyId);
    const second = await redeliver(copyId);
    expect(second).toMatchObject({ status: 201, body: { redelivery_of: root, redeliveries_used: 2 } });
    const third = await redeliver(root);
    expect(third).toMatchObject({ status: 201, body: { redelivery_of: root, redeliveries_used: 3 } });
    expect(await redeliver(root)).toMatchObject({ status: 409, body: { error: 'redelivery_limit' } });
    expect(await redeliver(copyId)).toMatchObject({ status: 409, body: { error: 'redelivery_limit' } });

    const family = (await rowsOf(pool, endpointId)).filter((row) => row.id === root || row.redelivery_of === root);
    expect(family).toHaveLength(4);
    expect(new Set(family.map((row) => row.body)).size).toBe(1);
    expect(new Set(family.map((row) => row.event_id)).size).toBe(1);
  });

  it.each(['blocked_destination', 'invalid_url', 'endpoint_disabled'])('목적지 거부류(%s)로 죽은 가족은 409 redelivery_destination_rejected', async (error) => {
    const { pool, agent, endpointId, redeliver } = await world();
    const root = await sentDelivery(pool, agent, endpointId);
    await kill(pool, root, error);
    expect(await redeliver(root)).toMatchObject({ status: 409, body: { error: 'redelivery_destination_rejected' } });

    // 재전송 행이 거부류로 죽어도 가족 전체가 막힌다.
    const other = await sentDelivery(pool, agent, endpointId);
    await kill(pool, other);
    const copy = await redeliver(other);
    expect(copy.status).toBe(201);
    await kill(pool, copy.body['id'] as string, error);
    expect(await redeliver(other)).toMatchObject({ status: 409, body: { error: 'redelivery_destination_rejected' } });
  });

  it('L13 가족에 delivered 가 있으면 409 delivery_already_delivered — 루트로도, 죽은 재전송 행으로도', async () => {
    const { pool, agent, endpointId, redeliver } = await world();
    const root = await sentDelivery(pool, agent, endpointId);
    await kill(pool, root);
    const first = await redeliver(root);
    expect(first.status).toBe(201);
    const firstId = first.body['id'] as string;
    const second = await redeliver(root);
    expect(second.status).toBe(201);
    await kill(pool, second.body['id'] as string);
    // 첫 재전송이 수신측에 닿았다(디스패처가 쓰는 칸과 같은 UPDATE).
    const delivered = await pool.query(
      `UPDATE webhook_deliveries SET status = 'delivered', delivered_at = now(), last_http_status = 204 WHERE id = $1 AND status = 'pending'`,
      [firstId],
    );
    expect(delivered.rowCount).toBe(1);
    expect(await redeliver(root)).toMatchObject({ status: 409, body: { error: 'delivery_already_delivered' } });
    expect(await redeliver(second.body['id'] as string)).toMatchObject({ status: 409, body: { error: 'delivery_already_delivered' } });
    expect((await rowsOf(pool, endpointId)).filter((row) => row.redelivery_of === root)).toHaveLength(2);
  });

  it(`보안 L5 에이전트 하나의 재전송은 1시간 ${String(MAX_REDELIVERIES_PER_AGENT_HOURLY)}건 — 다음은 429 redelivery_rate_limited · 다른 에이전트는 무관`, async () => {
    const { pool, agent, endpointId, redeliver } = await world();
    const roots: string[] = [];
    for (let i = 0; i < Math.ceil(MAX_REDELIVERIES_PER_AGENT_HOURLY / MAX_REDELIVERIES_PER_ROOT) + 1; i += 1) {
      const root = await sentDelivery(pool, agent, endpointId);
      await kill(pool, root);
      roots.push(root);
    }
    let made = 0;
    for (const root of roots) {
      for (let n = 0; n < MAX_REDELIVERIES_PER_ROOT && made < MAX_REDELIVERIES_PER_AGENT_HOURLY; n += 1) {
        expect((await redeliver(root)).status).toBe(201);
        made += 1;
      }
    }
    const fresh = roots[roots.length - 1] as string;
    expect(await redeliver(fresh)).toMatchObject({ status: 429, body: { error: 'redelivery_rate_limited' } });

    const other = await world();
    const otherRoot = await sentDelivery(other.pool, other.agent, other.endpointId);
    await kill(other.pool, otherRoot);
    expect((await other.redeliver(otherRoot)).status).toBe(201);
  });

  it('삭제된 엔드포인트 409 · 남의 전달·없는 id 404 · id 형식 400', async () => {
    const { pool, agent, endpointId, redeliver } = await world();
    const root = await sentDelivery(pool, agent, endpointId);
    await kill(pool, root);

    const stranger = await seedAgent(pool);
    const strangerHook = await registered(pool, stranger);
    const strangers = await sentDelivery(pool, stranger, strangerHook);
    await kill(pool, strangers);
    expect((await redeliver(strangers)).status).toBe(404);
    expect((await redeliver(randomUUID())).status).toBe(404);
    expect((await redeliver('nope')).status).toBe(400);

    expect(
      (await handleDeleteWebhookEndpoint(endpointDeps(pool), bearer(agent.token), { agentId: agent.agentId, endpointId })).status,
    ).toBe(200);
    expect(await redeliver(root)).toMatchObject({ status: 409, body: { error: 'webhook_endpoint_deleted' } });
  });

  it('DB 가드 — 루트가 아닌 행을 가리키기 · 다른 본문 · 순번 4 · 살아 있는 루트는 거부된다(앱 층을 거치지 않아도)', async () => {
    const { pool, agent, endpointId, redeliver } = await world();
    const root = await sentDelivery(pool, agent, endpointId);
    const insert = (redeliveryOf: string, dedupeKey: string, body?: string) =>
      pool.query(
        `INSERT INTO webhook_deliveries (event_id, endpoint_id, event_type, dedupe_key, body, next_attempt_at, redelivery_of)
         SELECT r.event_id, r.endpoint_id, r.event_type, $2, coalesce($3, r.body), $4, $1 FROM webhook_deliveries r WHERE r.id = $1`,
        [redeliveryOf, dedupeKey, body ?? null, FUTURE],
      );

    expect((await rejects(insert(root, `redelivery:${root}:1`))).message).toMatch(/not dead/);
    await kill(pool, root);
    expect((await rejects(insert(root, `redelivery:${root}:4`))).message).toMatch(/webhook_deliveries_redelivery_shape/);
    expect((await rejects(insert(root, `redelivery:${root}:1`, '{"id":"other"}'))).message).toMatch(/repeat the root/);
    expect((await rejects(insert(root, `message.sent:${randomUUID()}`))).message).toMatch(/webhook_deliveries_redelivery_shape/);

    const copy = await redeliver(root);
    expect(copy.status).toBe(201);
    const copyId = copy.body['id'] as string;
    await kill(pool, copyId);
    expect((await rejects(insert(copyId, `redelivery:${copyId}:1`))).message).toMatch(/root delivery/);
    // 같은 순번 둘은 유니크에서 죽는다.
    expect((await rejects(insert(root, `redelivery:${root}:1`))).code).toBe('23505');
    // 원래 행이 `redelivery:` 로 시작하는 키를 쓸 수 없다.
    const plain = await rejects(
      pool.query(
        `INSERT INTO webhook_deliveries (event_id, endpoint_id, event_type, dedupe_key, body, next_attempt_at)
         VALUES ($1, $2, 'message.sent', $3, '{}', $4)`,
        [randomUUID(), endpointId, `redelivery:${root}:2`, FUTURE],
      ),
    );
    expect(plain.message).toMatch(/webhook_deliveries_redelivery_shape/);
  });
});
