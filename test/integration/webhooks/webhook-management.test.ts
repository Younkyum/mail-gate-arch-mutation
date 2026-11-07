/**
 * 웹훅 관리(ADR-0013 개정) — **실제 Postgres 위에서**, 에이전트 API 표면: 권한(`webhooks:manage` · 옛 토큰 전환 경로 · 일몰) · URL 가림 ·
 * 시크릿 회전과 유예 서명 · DB 가드.
 *
 * 정리를 하지 않는다(DELETE 가 막혀 있다) — 테스트마다 새 에이전트를 만든다. 디스패처 시각은 1970년대다(`webhook-store.test.ts` 와 같은 규칙 —
 * 다른 테스트의 pending 행도 집히므로 응답·단언은 이 파일의 이벤트 id 로만 가른다).
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  handleDeleteWebhookEndpoint,
  handleListWebhookEndpoints,
  handleRegisterWebhookEndpoint,
  handleRotateWebhookSecret,
  MAX_WEBHOOK_ROTATIONS_PER_DAY,
} from '../../../src/api/routes/webhook-endpoints';
import { handleListWebhookDeliveries, handleRedeliverWebhookDelivery } from '../../../src/api/routes/webhook-deliveries';
import type { ApiRequest } from '../../../src/api/http';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories/agent-token-store';
import { createPostgresWebhookOutbox, enqueueWebhookEvent } from '../../../src/db/repositories/webhook-store';
import type { AgentId } from '../../../src/db/schema';
import { DEFAULT_AGENT_TOKEN_CAPABILITIES, issueAgentToken, type AgentTokenCapability } from '../../../src/identity/agent-token';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { dispatchDueWebhooks, type WebhookHttpRequest } from '../../../src/webhooks/dispatcher';
import { messageSentEvent } from '../../../src/webhooks/events';
import { LEGACY_WEBHOOK_MANAGE_UNTIL } from '../../../src/webhooks/management';
import { verifyWebhook } from '../../../src/webhooks/signing';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool } from '../db/support/harness';

const RING = parseHmacKeyring(`w1:${randomBytes(32).toString('base64url')}`, 'TEST');
/** 전환 경로가 열려 있는 시각(일몰 전). DB 시계(`now()`)는 실제 시각이다 — 유예 끝·상한 창은 그 시계로 센다. */
const BEFORE_SUNSET = new Date('2026-10-01T00:00:00.000Z');

let clock = Date.UTC(1972, 0, 1) + Math.floor(Math.random() * 1e9);
/** 디스패처용 — 테스트마다 겹치지 않는 옛 시각. */
function epoch(): Date {
  clock += 10 * 24 * 3_600_000;
  return new Date(clock);
}

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});
afterEach(() => resetLogSink());

async function issue(agentId: AgentId, capabilities: readonly AgentTokenCapability[], legacyEligible = false): Promise<string> {
  const issued = issueAgentToken(agentId, capabilities);
  if (legacyEligible) {
    // 202609301410 전에 발급된 토큰을 흉내 낸다(소유자 롤 — 칸은 INSERT 뒤 불변).
    await provisioningPool().query(
      `INSERT INTO agent_api_keys (agent_id, token_hash, capabilities, webhooks_legacy_eligible) VALUES ($1, $2, $3::agent_token_capability[], true)`,
      [agentId, issued.tokenHash, [...capabilities]],
    );
    return issued.plaintext;
  }
  await createPostgresAgentTokenStore(provisioningPool()).insert({ agentId, tokenHash: issued.tokenHash, capabilities: issued.capabilities, expiresAt: null });
  return issued.plaintext;
}

interface Agent {
  readonly agentId: AgentId;
  /** 기본 넷 + webhooks:manage. */
  readonly manage: string;
  /** 기본 넷 · 202609301410 전 발급(옛 토큰 — 전환 경로 자격). */
  readonly legacy: string;
  /** 기본 넷 · 새로 발급(자격 없음). */
  readonly fresh: string;
  /** messages:send 하나 · 옛 토큰. */
  readonly legacySendOnly: string;
  readonly readOnly: string;
  /** webhooks:manage 하나. */
  readonly manageOnly: string;
}

/** 활성 토큰 상한(5)이 있어 쓰는 토큰만 만든다 — 이름으로 부르면 그때 발급한다. */
const TOKEN_SPECS: Readonly<Record<string, readonly [readonly AgentTokenCapability[], boolean]>> = {
  manage: [[...DEFAULT_AGENT_TOKEN_CAPABILITIES, 'webhooks:manage'], false],
  legacy: [DEFAULT_AGENT_TOKEN_CAPABILITIES, true],
  fresh: [DEFAULT_AGENT_TOKEN_CAPABILITIES, false],
  readOnly: [['messages:read'], false],
  manageOnly: [['webhooks:manage'], false],
  legacySendOnly: [['messages:send'], true],
};

async function seedAgent(...kinds: (keyof typeof TOKEN_SPECS)[]): Promise<Agent> {
  const fixture = await seedFixture(testPool());
  const tokens: Record<string, string> = {};
  for (const kind of new Set(['manage', 'readOnly', ...kinds])) {
    const [capabilities, legacy] = TOKEN_SPECS[kind] ?? [[], false];
    tokens[kind] = await issue(fixture.agentId, capabilities, legacy);
  }
  const token = (kind: string): string => {
    const value = tokens[kind];
    if (value === undefined) throw new Error(`seedAgent 에 ${kind} 토큰을 요청하지 않았다`);
    return value;
  };
  return {
    agentId: fixture.agentId,
    get manage() {
      return token('manage');
    },
    get legacy() {
      return token('legacy');
    },
    get fresh() {
      return token('fresh');
    },
    get legacySendOnly() {
      return token('legacySendOnly');
    },
    get readOnly() {
      return token('readOnly');
    },
    get manageOnly() {
      return token('manageOnly');
    },
  };
}

function bearer(token: string, body: unknown = null): ApiRequest {
  return { headers: { authorization: `Bearer ${token}` }, query: {}, body };
}

function endpointDeps(now: Date = new Date()) {
  const pool = testPool();
  return { tokens: createPostgresAgentTokenStore(pool), db: pool, keyring: RING, now: () => now };
}

function deliveryDeps(now: Date = new Date()) {
  const pool = testPool();
  return { tokens: createPostgresAgentTokenStore(pool), db: pool, now: () => now };
}

const url = (): string => `https://hooks-${randomUUID().slice(0, 8)}.example.com/atmark`;

async function registered(agent: Agent): Promise<{ id: string; secret: string }> {
  const response = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.manage, { url: url() }), { agentId: agent.agentId });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return { id: response.body['id'] as string, secret: response.body['secret'] as string };
}

function captureLogs(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  setLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  return lines;
}

describe.skipIf(!DATABASE_AVAILABLE)('webhooks:manage — 에이전트 API 권한', () => {
  it('★ messages:read 만으로는 등록·삭제·회전·재전송 403(capability_not_granted) · 목록·전달 목록은 된다', async () => {
    const agent = await seedAgent();
    const { id } = await registered(agent);
    const target = { agentId: agent.agentId };
    const one = { ...target, endpointId: id };
    const denied = [
      await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.readOnly, { url: url() }), target),
      await handleDeleteWebhookEndpoint(endpointDeps(), bearer(agent.readOnly), one),
      await handleRotateWebhookSecret(endpointDeps(), bearer(agent.readOnly), one),
      await handleRedeliverWebhookDelivery(deliveryDeps(), bearer(agent.readOnly), { ...target, deliveryId: randomUUID() }),
    ];
    for (const response of denied) expect(response).toMatchObject({ status: 403, body: { error: 'forbidden', detail: 'capability_not_granted' } });
    expect((await handleListWebhookEndpoints(endpointDeps(), bearer(agent.readOnly), target)).status).toBe(200);
    expect((await handleListWebhookDeliveries(deliveryDeps(), bearer(agent.readOnly), target)).status).toBe(200);
  });

  it('webhooks:manage 하나만 가진 토큰: 등록·회전·삭제는 되고 목록은 403(messages:read 가 아니다)', async () => {
    const agent = await seedAgent('manageOnly');
    const target = { agentId: agent.agentId };
    const created = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.manageOnly, { url: url() }), target);
    expect(created.status).toBe(201);
    const one = { ...target, endpointId: created.body['id'] as string };
    expect((await handleRotateWebhookSecret(endpointDeps(), bearer(agent.manageOnly), one)).status).toBe(200);
    expect((await handleDeleteWebhookEndpoint(endpointDeps(), bearer(agent.manageOnly), one)).status).toBe(200);
    expect((await handleListWebhookEndpoints(endpointDeps(), bearer(agent.manageOnly), target)).status).toBe(403);
  });

  it('★ 옛 토큰(202609301410 전 발급 · messages:send): 일몰 전 등록·삭제는 통과 + 구조화 로그 · 회전은 403 · 일몰부터 403', async () => {
    const agent = await seedAgent('legacy');
    const target = { agentId: agent.agentId };
    const lines = captureLogs();
    const created = await handleRegisterWebhookEndpoint(endpointDeps(BEFORE_SUNSET), bearer(agent.legacy, { url: url() }), target);
    expect(created.status).toBe(201);
    const one = { ...target, endpointId: created.body['id'] as string };
    expect(await handleRotateWebhookSecret(endpointDeps(BEFORE_SUNSET), bearer(agent.legacy), one)).toMatchObject({
      status: 403,
      body: { detail: 'capability_not_granted' },
    });
    expect((await handleDeleteWebhookEndpoint(endpointDeps(BEFORE_SUNSET), bearer(agent.legacy), one)).status).toBe(200);
    const legacy = lines.filter((line) => line['event'] === 'webhook.legacy_capability');
    expect(legacy.map((line) => line['route_id'])).toEqual(['webhooks:register', 'webhooks:delete']);
    for (const line of legacy) expect(line).toMatchObject({ level: 'warn', agent_id: agent.agentId, outcome: 'allowed_legacy', reason: 'messages:send' });

    const after = await handleRegisterWebhookEndpoint(endpointDeps(LEGACY_WEBHOOK_MANAGE_UNTIL), bearer(agent.legacy, { url: url() }), target);
    expect(after).toMatchObject({ status: 403, body: { error: 'forbidden', detail: 'capability_not_granted' } });
    const redeliverAfter = await handleRedeliverWebhookDelivery(deliveryDeps(LEGACY_WEBHOOK_MANAGE_UNTIL), bearer(agent.legacy), {
      ...target,
      deliveryId: randomUUID(),
    });
    expect(redeliverAfter.status).toBe(403);
  });

  it('★ 보안 M3 — 새로 발급한 토큰(자격 없음)은 messages:send 로도 403 · 옛 토큰이라도 messages:read 없이는 등록 403(삭제는 된다)', async () => {
    const agent = await seedAgent('fresh', 'legacySendOnly');
    const target = { agentId: agent.agentId };
    const { id } = await registered(agent);
    for (const response of [
      await handleRegisterWebhookEndpoint(endpointDeps(BEFORE_SUNSET), bearer(agent.fresh, { url: url() }), target),
      await handleDeleteWebhookEndpoint(endpointDeps(BEFORE_SUNSET), bearer(agent.fresh), { ...target, endpointId: id }),
      await handleRedeliverWebhookDelivery(deliveryDeps(BEFORE_SUNSET), bearer(agent.fresh), { ...target, deliveryId: randomUUID() }),
      await handleRegisterWebhookEndpoint(endpointDeps(BEFORE_SUNSET), bearer(agent.legacySendOnly, { url: url() }), target),
    ]) {
      expect(response).toMatchObject({ status: 403, body: { detail: 'capability_not_granted' } });
    }
    expect((await handleDeleteWebhookEndpoint(endpointDeps(BEFORE_SUNSET), bearer(agent.legacySendOnly), { ...target, endpointId: id })).status).toBe(200);
    const flags = await provisioningPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agent_api_keys WHERE agent_id = $1 AND webhooks_legacy_eligible`,
      [agent.agentId],
    );
    expect(flags.rows[0]?.n).toBe(1);
    // 칸은 불변이다 — 소유자 롤도 자격을 켤 수 없다.
    await expect(provisioningPool().query('UPDATE agent_api_keys SET webhooks_legacy_eligible = true WHERE agent_id = $1', [agent.agentId])).rejects.toThrow(
      /immutable column/,
    );
  });

  it('★ 보안 L3 — webhooks:manage 없는 토큰의 목록은 url 을 가린다(url_masked) · manage 토큰은 전체', async () => {
    const agent = await seedAgent();
    const target = `https://hooks-${randomUUID().slice(0, 8)}.example.com/in/atmark?token=s3cr3t`;
    const created = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.manage, { url: target }), { agentId: agent.agentId });
    expect(created.status).toBe(201);
    const masked = await handleListWebhookEndpoints(endpointDeps(), bearer(agent.readOnly), { agentId: agent.agentId });
    expect(masked.body['endpoints']).toEqual([expect.objectContaining({ url: `${new URL(target).origin}/…mark`, url_masked: true })]);
    expect(JSON.stringify(masked.body)).not.toContain('s3cr3t');
    const full = await handleListWebhookEndpoints(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId });
    expect(full.body['endpoints']).toEqual([expect.objectContaining({ url: target, url_masked: false })]);
  });

  it('보안 L2 — 등록·삭제는 구조화 info 로그 한 줄(엔드포인트 id · URL 호스트, 경로·쿼리·시크릿 없음)', async () => {
    const agent = await seedAgent();
    const lines = captureLogs();
    const target = `https://hooks-${randomUUID().slice(0, 8)}.example.com/in/atmark?token=s3cr3t`;
    const created = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.manage, { url: target }), { agentId: agent.agentId });
    const id = created.body['id'] as string;
    await handleDeleteWebhookEndpoint(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId, endpointId: id });
    const events = lines.filter((line) => String(line['event']).startsWith('webhook.endpoint_'));
    expect(events).toEqual([
      expect.objectContaining({ level: 'info', event: 'webhook.endpoint_registered', agent_id: agent.agentId, detail: `endpoint:${id} host:${new URL(target).host}` }),
      expect.objectContaining({ level: 'info', event: 'webhook.endpoint_deleted', agent_id: agent.agentId, detail: `endpoint:${id}` }),
    ]);
    expect(JSON.stringify(lines)).not.toContain('s3cr3t');
    expect(JSON.stringify(lines)).not.toContain('whsec_');
  });

  it('남의 에이전트는 manage 토큰이어도 403 not_own_agent', async () => {
    const agent = await seedAgent();
    const stranger = await seedAgent();
    const { id } = await registered(agent);
    const response = await handleRotateWebhookSecret(endpointDeps(), bearer(stranger.manage), { agentId: agent.agentId, endpointId: id });
    expect(response).toMatchObject({ status: 403, body: { detail: 'not_own_agent' } });
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('시크릿 회전 — 에이전트 API', () => {
  it('★ 200 {endpoint, secret, previous_valid_until} · 새 시크릿은 다르다 · 버전 2 · 유예 ≈ 24시간 · 목록에 버전·유예 · 원장 한 행(via api) · 목록에 whsec_ 0', async () => {
    const agent = await seedAgent();
    const { id, secret: first } = await registered(agent);
    const before = Date.now();
    const response = await handleRotateWebhookSecret(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId, endpointId: id });
    expect(response.status).toBe(200);
    const secret = response.body['secret'] as string;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);
    expect(secret).not.toBe(first);
    const validUntil = Date.parse(response.body['previous_valid_until'] as string);
    expect(validUntil - before).toBeGreaterThan(23.9 * 3_600_000);
    expect(validUntil - before).toBeLessThan(24.1 * 3_600_000);
    expect(response.body['endpoint']).toMatchObject({ id, secret_version: 2, previous_secret_valid_until: response.body['previous_valid_until'] });

    const listed = await handleListWebhookEndpoints(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId });
    expect(listed.body['endpoints']).toMatchObject([{ id, secret_version: 2 }]);
    expect(JSON.stringify(listed.body)).not.toContain('whsec_');

    const ledger = await provisioningPool().query<{ from_version: number; to_version: number; via: string; agent_id: string }>(
      'SELECT from_version, to_version, via, agent_id FROM webhook_secret_rotations WHERE endpoint_id = $1',
      [id],
    );
    expect(ledger.rows).toEqual([{ from_version: 1, to_version: 2, via: 'api', agent_id: agent.agentId }]);
  });

  it('★ 디스패처(실제 outbox): 유예 안이면 서명 둘 — 새·옛 시크릿 모두 검증 · 유예가 끝나면 하나 — 옛 시크릿 실패 · last_attempt_at 기록', async () => {
    const agent = await seedAgent();
    const { id, secret: oldSecret } = await registered(agent);
    const rotated = await handleRotateWebhookSecret(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId, endpointId: id });
    const newSecret = rotated.body['secret'] as string;
    const pool = testPool();

    const deliverOnce = async (): Promise<WebhookHttpRequest & { eventId: string; at: Date }> => {
      const at = epoch();
      const event = messageSentEvent({ agentId: agent.agentId, messageId: randomUUID(), sentAt: at });
      expect(await enqueueWebhookEvent(pool, event, at)).toBe(1);
      const seen: WebhookHttpRequest[] = [];
      const deps = {
        outbox: createPostgresWebhookOutbox(pool),
        resolve: async () => [{ address: '93.184.215.14', family: 4 as const }],
        keyring: RING,
        transport: {
          post: async (request: WebhookHttpRequest) => {
            if (request.headers['webhook-id'] === event.eventId) seen.push(request);
            return { kind: 'response' as const, status: 200 };
          },
        },
      };
      await dispatchDueWebhooks(deps, at, { limit: 1000 });
      expect(seen).toHaveLength(1);
      const attempted = await pool.query<{ last_attempt_at: Date | null; status: string }>(
        'SELECT last_attempt_at, status::text AS status FROM webhook_deliveries WHERE endpoint_id = $1 AND event_id = $2',
        [id, event.eventId],
      );
      expect(attempted.rows[0]).toEqual({ last_attempt_at: at, status: 'delivered' });
      return { ...(seen[0] as WebhookHttpRequest), eventId: event.eventId, at };
    };
    const verify = (secret: string, request: WebhookHttpRequest & { at: Date }) =>
      verifyWebhook(
        secret,
        { id: request.headers['webhook-id'] ?? '', timestamp: request.headers['webhook-timestamp'] ?? '', signature: request.headers['webhook-signature'] ?? '' },
        request.body,
        request.at,
      );

    const inGrace = await deliverOnce();
    expect((inGrace.headers['webhook-signature'] ?? '').split(' ')).toHaveLength(2);
    expect(verify(newSecret, inGrace)).toEqual({ kind: 'valid' });
    expect(verify(oldSecret, inGrace)).toEqual({ kind: 'valid' });

    // 유예 끝을 과거로(소유자 롤 — 불변 핵심 트리거의 예외 칸, 가드는 버전·kid 만 본다).
    await provisioningPool().query(`UPDATE webhook_endpoints SET previous_secret_valid_until = timestamptz '1970-01-02' WHERE id = $1`, [id]);
    const expired = await deliverOnce();
    expect((expired.headers['webhook-signature'] ?? '').split(' ')).toHaveLength(1);
    expect(verify(newSecret, expired)).toEqual({ kind: 'valid' });
    expect(verify(oldSecret, expired)).toEqual({ kind: 'invalid', reason: 'no_matching_signature' });
    // 목록도 유예가 끝났다고 말한다.
    const listed = await handleListWebhookEndpoints(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId });
    expect(listed.body['endpoints']).toMatchObject([{ id, secret_version: 2, previous_secret_valid_until: null }]);
  });

  it(`상한: 엔드포인트당 24시간 ${String(MAX_WEBHOOK_ROTATIONS_PER_DAY)}회 — 다음은 429 webhook_rotation_rate_limited · 다른 엔드포인트는 따로 센다`, async () => {
    const agent = await seedAgent();
    const { id } = await registered(agent);
    const { id: other } = await registered(agent);
    const lines = captureLogs();
    for (let i = 0; i < MAX_WEBHOOK_ROTATIONS_PER_DAY; i += 1) {
      expect((await handleRotateWebhookSecret(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId, endpointId: id })).status).toBe(200);
    }
    const limited = await handleRotateWebhookSecret(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId, endpointId: id });
    expect(limited).toMatchObject({ status: 429, body: { error: 'webhook_rotation_rate_limited' } });
    expect(lines.filter((line) => line['event'] === 'webhook.secret_rotated')).toHaveLength(MAX_WEBHOOK_ROTATIONS_PER_DAY);
    expect(lines.filter((line) => line['event'] === 'webhook.secret_rotation_rejected')).toHaveLength(1);
    // 로그에는 시크릿이 없다.
    expect(JSON.stringify(lines)).not.toContain('whsec_');
    expect((await handleRotateWebhookSecret(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId, endpointId: other })).status).toBe(200);
    const versions = await provisioningPool().query<{ secret_version: number }>('SELECT secret_version FROM webhook_endpoints WHERE id = $1', [id]);
    expect(versions.rows[0]?.secret_version).toBe(MAX_WEBHOOK_ROTATIONS_PER_DAY + 1);
  });

  it('지운 것·남의 것·없는 것은 404 · 형식이 틀린 id 는 400', async () => {
    const agent = await seedAgent();
    const stranger = await seedAgent();
    const { id } = await registered(agent);
    const { id: theirs } = await registered(stranger);
    expect((await handleDeleteWebhookEndpoint(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId, endpointId: id })).status).toBe(200);
    for (const endpointId of [id, theirs, randomUUID()]) {
      const response = await handleRotateWebhookSecret(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId, endpointId });
      expect(response, endpointId).toMatchObject({ status: 404, body: { error: 'not_found' } });
    }
    expect((await handleRotateWebhookSecret(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId, endpointId: 'x' })).status).toBe(400);
  });

  it('DB 가드: 버전 내리기 · 지운 엔드포인트의 회전은 소유자 롤도 거부 · 원장은 append-only · 앱 롤은 표 UPDATE·원장 권한 0', async () => {
    const agent = await seedAgent();
    const { id } = await registered(agent);
    await handleRotateWebhookSecret(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId, endpointId: id });
    const owner = provisioningPool();
    await expect(owner.query('UPDATE webhook_endpoints SET secret_version = 1 WHERE id = $1', [id])).rejects.toThrow(/cannot go down/);
    await expect(owner.query('DELETE FROM webhook_secret_rotations WHERE endpoint_id = $1', [id])).rejects.toThrow();
    await expect(owner.query(`UPDATE webhook_secret_rotations SET via = 'console' WHERE endpoint_id = $1`, [id])).rejects.toThrow();
    const app = testPool();
    await expect(app.query('UPDATE webhook_endpoints SET secret_version = 9 WHERE id = $1', [id])).rejects.toThrow(/permission denied/);
    await expect(app.query('SELECT count(*) FROM webhook_secret_rotations')).rejects.toThrow(/permission denied/);
    await expect(
      app.query(`INSERT INTO webhook_secret_rotations (endpoint_id, agent_id, from_version, to_version, via) VALUES ($1, $2, 5, 6, 'api')`, [id, agent.agentId]),
    ).rejects.toThrow(/permission denied/);
    // 지운 뒤에는 소유자 롤의 직접 회전도 막힌다.
    await handleDeleteWebhookEndpoint(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId, endpointId: id });
    await expect(owner.query('UPDATE webhook_endpoints SET secret_version = secret_version + 1 WHERE id = $1', [id])).rejects.toThrow(/deleted/);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('옛 경로 호환', () => {
  it('등록 응답 모양은 그대로다(id · agent_id · url · event_types · secret · secret_notice + 더한 칸 has_authorization · authorization_hint) — 버전 1', async () => {
    const agent = await seedAgent();
    const response = await handleRegisterWebhookEndpoint(endpointDeps(), bearer(agent.manage, { url: url(), event_types: ['message.bounced'] }), {
      agentId: agent.agentId,
    });
    // 인증 헤더(202610141400)는 칸을 **더하기만** 한다 — 옛 칸은 그대로 · 주지 않으면 false · null.
    expect(Object.keys(response.body).sort()).toEqual([
      'agent_id',
      'authorization_hint',
      'event_types',
      'has_authorization',
      'id',
      'secret',
      'secret_notice',
      'url',
    ]);
    expect(response.body).toMatchObject({ has_authorization: false, authorization_hint: null });
    const listed = await handleListWebhookEndpoints(endpointDeps(), bearer(agent.manage), { agentId: agent.agentId });
    expect(listed.body['endpoints']).toMatchObject([
      { id: response.body['id'], event_types: ['message.bounced'], secret_version: 1, secret_rotated_at: null, previous_secret_valid_until: null },
    ]);
  });
});
