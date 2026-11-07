/**
 * 웹훅 인증 헤더(202610141400) — **실제 Postgres 위에서**, 에이전트 API 표면 + 디스패처 + DB 가드.
 *
 *   - 등록 `authorization` → DB 에는 봉인값 · 힌트만(평문 0 — 어느 칸에도) · 응답 · 목록은 `has_authorization` · `authorization_hint` 뿐 · 로그에 값 없음.
 *   - 규칙 위반 400 `invalid_authorization`(값을 되돌려 싣지 않는다) · 모르는 칸은 여전히 400.
 *   - 전달에 `authorization` 헤더 · 재전송은 **지금 값**(콘솔이 바꾼 값 · 지운 뒤에는 없음) · URL 을 바꾼 행은 보내지 않는다.
 *   - 앱 롤: 등록 트랜잭션 밖의 설정 `not_allowed` · 표 직접 쓰기 0 · 지우기 함수 0. admin 롤: 봉인값 칸 SELECT 0. 다른 에이전트의 엔드포인트 not_found.
 *   - 엔드포인트를 지우면 봉인값도 지운다 · 행 DELETE 는 소유자 롤도 거부.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { ApiRequest } from '../../../src/api/http';
import { handleRedeliverWebhookDelivery } from '../../../src/api/routes/webhook-deliveries';
import { handleDeleteWebhookEndpoint, handleListWebhookEndpoints, handleRegisterWebhookEndpoint } from '../../../src/api/routes/webhook-endpoints';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories/agent-token-store';
import {
  clearWebhookEndpointAuthorization,
  createPostgresWebhookOutbox,
  enqueueWebhookEvent,
  setWebhookEndpointAuthorization,
} from '../../../src/db/repositories/webhook-store';
import type { AgentId } from '../../../src/db/schema';
import { DEFAULT_AGENT_TOKEN_CAPABILITIES, issueAgentToken } from '../../../src/identity/agent-token';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { sealWebhookAuthorization } from '../../../src/webhooks/authorization';
import { dispatchDueWebhooks, type WebhookHttpRequest } from '../../../src/webhooks/dispatcher';
import { messageSentEvent } from '../../../src/webhooks/events';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool } from '../db/support/harness';

const RING = parseHmacKeyring(`w1:${randomBytes(32).toString('base64url')}`, 'TEST');
/** 테스트마다 다른 값 — DB · 로그 전체에서 이 조각을 찾는다. */
const secretValue = (): string => `Bearer gw_${randomBytes(18).toString('hex')}`;

let clock = Date.UTC(1973, 0, 1) + Math.floor(Math.random() * 1e9);
function epoch(): Date {
  clock += 10 * 24 * 3_600_000;
  return new Date(clock);
}

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});
afterEach(() => resetLogSink());

async function seedAgent(): Promise<{ agentId: AgentId; token: string }> {
  const fixture = await seedFixture(testPool());
  const issued = issueAgentToken(fixture.agentId, [...DEFAULT_AGENT_TOKEN_CAPABILITIES, 'webhooks:manage']);
  await createPostgresAgentTokenStore(provisioningPool()).insert({
    agentId: fixture.agentId,
    tokenHash: issued.tokenHash,
    capabilities: issued.capabilities,
    expiresAt: null,
  });
  return { agentId: fixture.agentId, token: issued.plaintext };
}

function bearer(token: string, body: unknown = null): ApiRequest {
  return { headers: { authorization: `Bearer ${token}` }, query: {}, body };
}

function endpointDeps() {
  const pool = testPool();
  return { tokens: createPostgresAgentTokenStore(pool), db: pool, keyring: RING, now: () => new Date() };
}

const hookUrl = (): string => `https://hooks-${randomUUID().slice(0, 8)}.example.com/atmark`;

function captureLogs(): string[] {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  return lines;
}

/** 이 엔드포인트로 이벤트 하나를 적고 디스패처를 한 번 돌려 그 요청(없으면 `null`)과 결과 행을 돌려준다. */
async function deliverOnce(agentId: AgentId, endpointId: string): Promise<{ request: WebhookHttpRequest | null; status: string; lastError: string | null; deliveryId: string }> {
  const pool = testPool();
  const at = epoch();
  const event = messageSentEvent({ agentId, messageId: randomUUID(), sentAt: at });
  await enqueueWebhookEvent(pool, event, at);
  let seen: WebhookHttpRequest | null = null;
  await dispatchDueWebhooks(
    {
      outbox: createPostgresWebhookOutbox(pool),
      resolve: async () => [{ address: '93.184.215.14', family: 4 as const }],
      keyring: RING,
      transport: {
        post: async (request: WebhookHttpRequest) => {
          if (request.headers['webhook-id'] === event.eventId) seen = request;
          return { kind: 'response' as const, status: 200 };
        },
      },
    },
    at,
    { limit: 1000 },
  );
  const row = await pool.query<{ id: string; status: string; last_error: string | null }>(
    'SELECT id, status::text AS status, last_error FROM webhook_deliveries WHERE endpoint_id = $1 AND event_id = $2',
    [endpointId, event.eventId],
  );
  const found = row.rows[0];
  if (found === undefined) throw new Error('전달 행이 없다');
  return { request: seen, status: found.status, lastError: found.last_error, deliveryId: found.id };
}

/** DB 전체에서 값 조각을 찾는다 — 웹훅 표 · 감사 · 로그성 표의 모든 text 칸. */
async function plaintextAnywhere(fragment: string): Promise<string[]> {
  const owner = provisioningPool();
  const columns = await owner.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb', 'json')
        AND table_name IN ('webhook_endpoints', 'webhook_endpoint_authorizations', 'webhook_deliveries', 'webhook_owner_action_details',
                           'owner_actions', 'webhook_secret_rotations', 'tlog_outbox', 'tlog_leaves')`,
  );
  const hits: string[] = [];
  for (const { table_name, column_name } of columns.rows) {
    const result = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table_name} WHERE "${column_name}"::text LIKE $1`, [`%${fragment}%`]);
    if ((result.rows[0]?.n ?? 0) > 0) hits.push(`${table_name}.${column_name}`);
  }
  return hits;
}

/** `atmark_admin` 롤로 질의 하나(되돌림 트랜잭션 — 실패해도 다음 질의에 번지지 않게 매번 새 트랜잭션). */
async function asAdmin(sql: string, params: readonly unknown[] = []): Promise<{ rowCount: number | null }> {
  const client = await provisioningPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE atmark_admin');
    return await client.query(sql, [...params]);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe.skipIf(!DATABASE_AVAILABLE)('웹훅 인증 헤더 — 에이전트 API', () => {
  it('★ 등록: 봉인값 · 힌트만 저장(평문 0) · 응답 · 목록은 has_authorization · hint 뿐 · 로그에 값 없음', async () => {
    const agent = await seedAgent();
    const value = secretValue();
    const lines = captureLogs();
    const response = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.token, { url: hookUrl(), authorization: `  ${value} ` }), {
      agentId: agent.agentId,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ has_authorization: true, authorization_hint: `Bearer …${value.slice(-4)}` });
    const id = response.body['id'] as string;
    const listed = await handleListWebhookEndpoints(endpointDeps(), bearer(agent.token), { agentId: agent.agentId });
    expect(listed.body['endpoints']).toMatchObject([{ id, has_authorization: true, authorization_hint: `Bearer …${value.slice(-4)}` }]);

    const fragment = value.slice('Bearer '.length);
    expect(JSON.stringify(response.body)).not.toContain(fragment);
    expect(JSON.stringify(listed.body)).not.toContain(fragment);
    expect(lines.join('\n')).not.toContain(fragment);
    expect(await plaintextAnywhere(fragment)).toEqual([]);
    const row = await provisioningPool().query<{ key_kid: string; sealed: string; hint: string; set_via: string }>(
      'SELECT key_kid, sealed, hint, set_via FROM webhook_endpoint_authorizations WHERE endpoint_id = $1',
      [id],
    );
    expect(row.rows[0]).toMatchObject({ key_kid: 'w1', set_via: 'api', hint: `Bearer …${value.slice(-4)}` });
    expect(row.rows[0]?.sealed).toMatch(/^v1\./);
  });

  it('주지 않으면 has_authorization: false · 행 없음', async () => {
    const agent = await seedAgent();
    const response = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.token, { url: hookUrl() }), { agentId: agent.agentId });
    expect(response.body).toMatchObject({ has_authorization: false, authorization_hint: null });
    const rows = await provisioningPool().query('SELECT 1 FROM webhook_endpoint_authorizations WHERE endpoint_id = $1', [response.body['id']]);
    expect(rows.rowCount).toBe(0);
  });

  it.each([
    ['CRLF 주입', 'Bearer x\r\nX-Injected: 1'],
    ['NUL', 'Bearer x\u0000'],
    ['비 ASCII', 'Bearer 토큰토큰'],
    ['길이', `Bearer ${'a'.repeat(2050)}`],
    ['헤더 이름째', 'Authorization: Bearer abc'],
    ['문자열 아님', { token: 'x' }],
  ])('규칙 위반(%s) → 400 invalid_authorization · 값을 되돌리지 않음 · 아무것도 쓰지 않음', async (_name, authorization) => {
    const agent = await seedAgent();
    const url = hookUrl();
    const response = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.token, { url, authorization }), { agentId: agent.agentId });
    expect(response).toMatchObject({ status: 400, body: { error: 'invalid_authorization' } });
    expect(JSON.stringify(response.body)).not.toContain('Injected');
    expect(JSON.stringify(response.body)).not.toContain('토큰');
    const rows = await provisioningPool().query('SELECT 1 FROM webhook_endpoints WHERE agent_id = $1', [agent.agentId]);
    expect(rows.rowCount).toBe(0);
  });

  it('★ 전달에 Authorization 헤더 · 재전송은 지금 값(바꾼 값 → 지운 뒤 없음) · 다른 에이전트의 엔드포인트는 not_found', async () => {
    const agent = await seedAgent();
    const first = secretValue();
    const created = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.token, { url: hookUrl(), authorization: first }), { agentId: agent.agentId });
    const id = created.body['id'] as string;
    const url = created.body['url'] as string;

    const delivered = await deliverOnce(agent.agentId, id);
    expect(delivered.status).toBe('delivered');
    expect(delivered.request?.headers['authorization']).toBe(first);
    expect(delivered.request?.headers['webhook-signature']).toMatch(/^v1,/);

    // dead 로 만든 뒤 콘솔(소유자 롤 — via console)이 값을 바꾸면 재전송은 새 값으로.
    const pool = testPool();
    const at = epoch();
    const event = messageSentEvent({ agentId: agent.agentId, messageId: randomUUID(), sentAt: at });
    await enqueueWebhookEvent(pool, event, at);
    const dead = await pool.query<{ id: string }>(
      `UPDATE webhook_deliveries SET status = 'dead', dead_at = now(), last_error = 'http_status'
        WHERE endpoint_id = $1 AND event_id = $2 AND status = 'pending' RETURNING id`,
      [id, event.eventId],
    );
    const deadId = dead.rows[0]?.id ?? '';
    const second = secretValue();
    const owner = provisioningPool();
    const sealed = sealWebhookAuthorization(RING, { agentId: agent.agentId, endpointId: id, generation: 2, url }, second);
    expect(await setWebhookEndpointAuthorization(owner, { agentId: agent.agentId, endpointId: id, ...sealed, via: 'console' })).toBe('set');
    const redelivered = await handleRedeliverWebhookDelivery(
      { tokens: createPostgresAgentTokenStore(pool), db: pool, now: () => at },
      bearer(agent.token),
      { agentId: agent.agentId, deliveryId: deadId },
    );
    expect(redelivered.status, JSON.stringify(redelivered.body)).toBe(201);
    const seen: WebhookHttpRequest[] = [];
    await dispatchDueWebhooks(
      {
        outbox: createPostgresWebhookOutbox(pool),
        resolve: async () => [{ address: '93.184.215.14', family: 4 as const }],
        keyring: RING,
        transport: {
          post: async (request: WebhookHttpRequest) => {
            if (request.headers['webhook-id'] === event.eventId) seen.push(request);
            return { kind: 'response' as const, status: 200 };
          },
        },
      },
      at,
      { limit: 1000 },
    );
    expect(seen.map((request) => request.headers['authorization'])).toEqual([second]);

    // 지우면 다음 전달에는 헤더가 없다.
    expect(await clearWebhookEndpointAuthorization(owner, agent.agentId, id, 'console')).toBe('cleared');
    expect(await clearWebhookEndpointAuthorization(owner, agent.agentId, id, 'console')).toBe('none');
    const after = await deliverOnce(agent.agentId, id);
    expect(after.status).toBe('delivered');
    expect(Object.keys(after.request?.headers ?? {})).not.toContain('authorization');

    // 다른 에이전트로는 같은 엔드포인트를 건드리지 못한다.
    const other = await seedAgent();
    expect(await setWebhookEndpointAuthorization(owner, { agentId: other.agentId, endpointId: id, ...sealed, via: 'console' })).toBe('not_found');
    expect(await clearWebhookEndpointAuthorization(owner, other.agentId, id, 'console')).toBe('not_found');
  });

  it('★ URL 을 바꾼 행(DB 쓰기 공격)은 보내지 않는다 — authorization_unavailable · 값이 다른 곳으로 가지 않음', async () => {
    const agent = await seedAgent();
    const value = secretValue();
    const created = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.token, { url: hookUrl(), authorization: value }), { agentId: agent.agentId });
    const id = created.body['id'] as string;
    await provisioningPool().query(`UPDATE webhook_endpoints SET url = 'https://attacker.example.net/collect' WHERE id = $1`, [id]);
    const result = await deliverOnce(agent.agentId, id);
    expect(result.request).toBeNull();
    expect(result).toMatchObject({ status: 'pending', lastError: 'authorization_unavailable' });
  });

  it('★ 봉인값을 다른 엔드포인트로 옮겨도(소유자 롤 직접 쓰기) 열리지 않는다', async () => {
    const victim = await seedAgent();
    const attacker = await seedAgent();
    const value = secretValue();
    const v = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(victim.token, { url: hookUrl(), authorization: value }), { agentId: victim.agentId });
    const a = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(attacker.token, { url: hookUrl() }), { agentId: attacker.agentId });
    const owner = provisioningPool();
    const stolen = await owner.query<{ key_kid: string; sealed: string; hint: string }>(
      'SELECT key_kid, sealed, hint FROM webhook_endpoint_authorizations WHERE endpoint_id = $1',
      [v.body['id']],
    );
    const row = stolen.rows[0];
    if (row === undefined) throw new Error('봉인 행이 없다');
    expect(
      await setWebhookEndpointAuthorization(owner, { agentId: attacker.agentId, endpointId: a.body['id'] as string, kid: row.key_kid, sealed: row.sealed, hint: row.hint, generation: 1, via: 'console' }),
    ).toBe('set');
    const result = await deliverOnce(attacker.agentId, a.body['id'] as string);
    expect(result.request).toBeNull();
    expect(result.lastError).toBe('authorization_unavailable');
  });

  it('★ 보안 리뷰 L2 — 같은 에이전트 · 같은 URL 로 다시 등록한 엔드포인트에 옛 봉인값을 옮겨도 열리지 않는다 · 등록 id 는 앱이 만들고 겹치면 거부', async () => {
    const agent = await seedAgent();
    const url = hookUrl();
    const old = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.token, { url, authorization: secretValue() }), { agentId: agent.agentId });
    const owner = provisioningPool();
    const before = await owner.query<{ key_kid: string; sealed: string; hint: string }>(
      'SELECT key_kid, sealed, hint FROM webhook_endpoint_authorizations WHERE endpoint_id = $1',
      [old.body['id']],
    );
    const saved = before.rows[0];
    if (saved === undefined) throw new Error('봉인 행이 없다');
    expect((await handleDeleteWebhookEndpoint(endpointDeps(), bearer(agent.token), { agentId: agent.agentId, endpointId: old.body['id'] as string })).status).toBe(200);
    const again = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.token, { url }), { agentId: agent.agentId });
    expect(again.body['url']).toBe(old.body['url']);
    expect(
      await setWebhookEndpointAuthorization(owner, { agentId: agent.agentId, endpointId: again.body['id'] as string, kid: saved.key_kid, sealed: saved.sealed, hint: saved.hint, generation: 1, via: 'console' }),
    ).toBe('set');
    const result = await deliverOnce(agent.agentId, again.body['id'] as string);
    expect(result.request).toBeNull();
    expect(result.lastError).toBe('authorization_unavailable');
    // 등록 id 는 앱이 고른다 — 이미 있는 id 를 고르면 PK 위반(남의 행을 덮지 못한다).
    await expect(
      testPool().query(`SELECT register_webhook_endpoint($1::uuid, $2, $3, 'w1', NULL, 'api')`, [again.body['id'], agent.agentId, hookUrl()]),
    ).rejects.toThrow(/duplicate key|webhook_endpoints_pkey/);
  });

  it('★ 재검증 L2 — 세대: 옛 봉인값을 같은 엔드포인트에 다시 넣으면 열리지 않는다 · 지운 값은 옛 봉인값 재생으로 되살아나지 않는다 · 세대는 내려가지 않는다', async () => {
    const agent = await seedAgent();
    const first = secretValue();
    const created = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.token, { url: hookUrl(), authorization: first }), { agentId: agent.agentId });
    const id = created.body['id'] as string;
    const url = created.body['url'] as string;
    const owner = provisioningPool();
    const read = async () =>
      (await owner.query<{ key_kid: string | null; sealed: string | null; hint: string | null; generation: number }>(
        'SELECT key_kid, sealed, hint, generation FROM webhook_endpoint_authorizations WHERE endpoint_id = $1',
        [id],
      )).rows[0];
    const old = await read();
    if (old?.sealed == null || old.key_kid == null || old.hint == null) throw new Error('봉인 행이 없다');
    expect(old.generation).toBe(1);

    // 교체(세대 2) 뒤 옛 봉인값(세대 1)을 다시 넣는다 — 함수는 stale(세대 1 은 지금 + 1 이 아니다), 세대만 맞춰도(3) 열리지 않는다.
    const second = sealWebhookAuthorization(RING, { agentId: agent.agentId, endpointId: id, generation: 2, url }, secretValue());
    expect(await setWebhookEndpointAuthorization(owner, { agentId: agent.agentId, endpointId: id, ...second, via: 'console' })).toBe('set');
    const replay = { agentId: agent.agentId, endpointId: id, kid: old.key_kid, sealed: old.sealed, hint: old.hint, via: 'console' as const };
    expect(await setWebhookEndpointAuthorization(owner, { ...replay, generation: 1 })).toBe('stale');
    expect(await setWebhookEndpointAuthorization(owner, { ...replay, generation: 3 })).toBe('set');
    const replayed = await deliverOnce(agent.agentId, id);
    expect(replayed.request).toBeNull();
    expect(replayed.lastError).toBe('authorization_unavailable');

    // 지운 뒤(세대 +1) 옛 봉인값으로는 되살릴 수 없다.
    expect(await clearWebhookEndpointAuthorization(owner, agent.agentId, id, 'console')).toBe('cleared');
    expect((await read())?.generation).toBe(4);
    expect(await setWebhookEndpointAuthorization(owner, { ...replay, sealed: second.sealed, kid: second.kid, generation: 2 })).toBe('stale');
    expect(await setWebhookEndpointAuthorization(owner, { ...replay, sealed: second.sealed, kid: second.kid, generation: 5 })).toBe('set');
    const revived = await deliverOnce(agent.agentId, id);
    expect(revived.request).toBeNull();
    expect(revived.lastError).toBe('authorization_unavailable');

    // 소유자 롤 직접 쓰기로 세대를 내리거나, 세대를 그대로 둔 채 봉인을 바꿀 수 없다(가드 트리거).
    await expect(owner.query('UPDATE webhook_endpoint_authorizations SET generation = 2 WHERE endpoint_id = $1', [id])).rejects.toThrow(/cannot go down/);
    await expect(owner.query('UPDATE webhook_endpoint_authorizations SET sealed = $2 WHERE endpoint_id = $1', [id, old.sealed])).rejects.toThrow(/new generation/);
  });

  it('★ 앱 롤: 등록 트랜잭션 밖의 설정 not_allowed · 표 직접 쓰기 · 지우기 함수 권한 0 · admin 롤은 봉인값 칸을 읽지 못한다', async () => {
    const agent = await seedAgent();
    const created = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.token, { url: hookUrl(), authorization: secretValue() }), { agentId: agent.agentId });
    const plain = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.token, { url: hookUrl() }), { agentId: agent.agentId });
    const app = testPool();
    const sealed = sealWebhookAuthorization(RING, { agentId: agent.agentId, endpointId: plain.body['id'] as string, generation: 1, url: plain.body['url'] as string }, secretValue());
    // 이미 등록된 엔드포인트(값 있음 · 없음 모두)에 에이전트 API 경로로는 적을 수 없다.
    for (const endpointId of [created.body['id'] as string, plain.body['id'] as string]) {
      expect(await setWebhookEndpointAuthorization(app, { agentId: agent.agentId, endpointId, ...sealed, via: 'api' })).toBe('not_allowed');
    }
    await expect(setWebhookEndpointAuthorization(app, { agentId: agent.agentId, endpointId: plain.body['id'] as string, ...sealed, via: 'console' })).rejects.toThrow(
      /does not match/,
    );
    await expect(clearWebhookEndpointAuthorization(app, agent.agentId, created.body['id'] as string, 'api')).rejects.toThrow(/permission denied/);
    await expect(app.query(`UPDATE webhook_endpoint_authorizations SET hint = 'x' WHERE endpoint_id = $1`, [created.body['id']])).rejects.toThrow(/permission denied/);
    await expect(
      app.query(`INSERT INTO webhook_endpoint_authorizations (endpoint_id, key_kid, sealed, hint, set_via) VALUES ($1, $2, $3, $4, 'api')`, [
        plain.body['id'],
        sealed.kid,
        sealed.sealed,
        sealed.hint,
      ]),
    ).rejects.toThrow(/permission denied/);

    expect((await asAdmin('SELECT endpoint_id, hint, set_at FROM webhook_endpoint_authorizations WHERE endpoint_id = $1', [created.body['id']])).rowCount).toBe(1);
    await expect(asAdmin('SELECT sealed FROM webhook_endpoint_authorizations LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(asAdmin('SELECT key_kid FROM webhook_endpoint_authorizations LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(asAdmin('SELECT * FROM webhook_endpoint_authorizations LIMIT 1')).rejects.toThrow(/permission denied/);
  });

  it('★ 엔드포인트를 지우면 봉인값도 지운다 · 행 DELETE · TRUNCATE 는 소유자 롤도 거부 · 지운 엔드포인트에는 다시 적지 못한다', async () => {
    const agent = await seedAgent();
    const created = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.token, { url: hookUrl(), authorization: secretValue() }), { agentId: agent.agentId });
    const id = created.body['id'] as string;
    expect((await handleDeleteWebhookEndpoint(endpointDeps(), bearer(agent.token), { agentId: agent.agentId, endpointId: id })).status).toBe(200);
    const owner = provisioningPool();
    const row = await owner.query<{ sealed: string | null; key_kid: string | null; hint: string | null; cleared_at: Date | null }>(
      'SELECT sealed, key_kid, hint, cleared_at FROM webhook_endpoint_authorizations WHERE endpoint_id = $1',
      [id],
    );
    expect(row.rows[0]).toMatchObject({ sealed: null, key_kid: null, hint: null });
    expect(row.rows[0]?.cleared_at).toBeInstanceOf(Date);
    await expect(owner.query('DELETE FROM webhook_endpoint_authorizations WHERE endpoint_id = $1', [id])).rejects.toThrow();
    const sealed = sealWebhookAuthorization(RING, { agentId: agent.agentId, endpointId: id, generation: 3, url: created.body['url'] as string }, secretValue());
    expect(await setWebhookEndpointAuthorization(owner, { agentId: agent.agentId, endpointId: id, ...sealed, via: 'console' })).toBe('not_found');
    // 모양 CHECK — 평문처럼 보이는 값은 봉인 칸에 들어가지 않는다.
    await expect(
      setWebhookEndpointAuthorization(owner, {
        agentId: agent.agentId,
        endpointId: (await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.token, { url: hookUrl() }), { agentId: agent.agentId })).body['id'] as string,
        kid: 'w1',
        sealed: 'Bearer plaintext-token-value',
        hint: 'x',
        generation: 1,
        via: 'console',
      }),
    ).rejects.toThrow(/webhook_endpoint_authorizations_sealed_check/);
  });
});
