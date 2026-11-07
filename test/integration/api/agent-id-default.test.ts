/**
 * `agent_id` 생략 = 토큰의 에이전트 · 경로 별칭 `/v1/agents/me/…` (2026-10-11 DX — 베타 스모크가 SDK 를 agentId 없이 만들었다가 400 을 받았다).
 *
 * 실제 라우터(`routeHttpApiEvent`) · 실제 저장소 · 앱 롤 풀 위에서, 바뀐 경로마다 네 갈래를 본다:
 *   ① 생략 → 토큰의 에이전트 ② 적은 값 = 자기 id → 그대로 ③ 적은 값 = 남의 id → 오늘과 같은 403 ④ 형식 위반 → 오늘과 같은 400.
 * 경로 별칭은 `me` → 토큰의 에이전트, 조직 키로 `me` → 401(이 호스트는 조직 키를 받지 않는다), `ME` 처럼 다른 철자 → 400.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createInMemoryContentStore } from '../../../src/api/content-store';
import type { OutboundServiceDependencies } from '../../../src/api/outbound-service';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import {
  createPostgresAgentTokenStore,
  createPostgresApprovalStore,
  createPostgresGateStores,
  createPostgresReplyTargetLookup,
} from '../../../src/db/repositories';
import { createPostgresDraftStore } from '../../../src/db/repositories/draft-store';
import { createPostgresInboundPolicySource } from '../../../src/db/repositories/inbound-policy-store';
import { createPostgresInboundReadStore } from '../../../src/db/repositories/inbound-read-store';
import { createPostgresMessageStateStore } from '../../../src/db/repositories/message-state-store';
import { createPostgresScheduledSendStore } from '../../../src/db/repositories/scheduled-send-store';
import { createPostgresExposureRecorder } from '../../../src/db/repositories/exposure-store';
import type { AgentId } from '../../../src/db/schema';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { routeHttpApiEvent, type ApiDependencies } from '../../../src/runtime/router';
import { createDraftContentStore } from '../../../src/storage/draft-content-store';
import { createInboundArtifactReader } from '../../../src/storage/inbound-artifact-store';
import { createLocalObjectStore } from '../../../src/storage/local-object-store';
import { createScheduledContentStore } from '../../../src/storage/scheduled-content-store';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { countingTransport, type CountingTransport } from '../outbound/support/fakes';
import { inertDlp, inertRiskSignals, TEST_DLP_KEYRING } from '../../support/injection-doubles';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

const PARTNER = 'partner@example.com';
const ORG_KEY = `atk_org_${'A'.repeat(43)}`;

function untouchable(label: string): never {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') return undefined;
        throw new Error(`${label}.${String(property)} 를 건드렸다`);
      },
    },
  ) as never;
}

interface World {
  readonly fixture: Fixture;
  readonly other: Fixture;
  readonly token: string;
  readonly transport: CountingTransport;
  readonly deps: ApiDependencies;
}

async function tokenFor(pool: Pool, agentId: AgentId): Promise<string> {
  const issued = issueAgentToken(agentId);
  await createPostgresAgentTokenStore(pool).insert({ agentId, tokenHash: issued.tokenHash, capabilities: issued.capabilities, expiresAt: null });
  return issued.plaintext;
}

async function world(): Promise<World> {
  const pool = testPool();
  const fixture = await seedFixture(provisioningPool(), { allowlist: [PARTNER] });
  const other = await seedFixture(provisioningPool(), { allowlist: [PARTNER] });
  const directory = mkdtempSync(join(tmpdir(), 'atmark-aid-'));
  const objects = createLocalObjectStore({ directory, env: {} });
  const tokens = createPostgresAgentTokenStore(pool);
  const stores = createPostgresGateStores(pool);
  const now = (): Date => new Date();
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
    now,
  };
  const transport = countingTransport();
  const inbound = createPostgresInboundReadStore(pool);
  const artifacts = createInboundArtifactReader(objects);
  const inboundRead = {
    tokens,
    inbound,
    artifacts,
    now,
    exposures: createPostgresExposureRecorder(pool, { keyring: TEST_DLP_KEYRING }),
    riskHoldMode: 'enforce' as const,
    messageState: createPostgresMessageStateStore(pool),
  };
  const drafts = createPostgresDraftStore(pool);
  const deps: ApiDependencies = {
    send: { tokens, service, transport },
    reply: untouchable('reply'),
    forward: untouchable('forward'),
    transitionAnnouncement: untouchable('transitionAnnouncement'),
    audit: untouchable('audit'),
    approvalLink: untouchable('approvalLink'),
    approvals: { tokens, approvals: createPostgresApprovalStore(pool), now },
    agentPolicy: { tokens, policies: service.source, inboundPolicies: createPostgresInboundPolicySource(pool), now },
    webhookEndpoints: { tokens, db: pool, keyring: untouchable('keyring'), now },
    inboundRead,
    attachments: untouchable('attachments'),
    scheduledMessages: untouchable('scheduledMessages'),
    scheduledQueries: { tokens, schedules: createPostgresScheduledSendStore(pool), content: createScheduledContentStore(objects), now },
    verificationCode: inboundRead,
    webhookDeliveries: { tokens, db: pool, now },
    outboundAttachments: untouchable('outboundAttachments'),
    drafts: { tokens, drafts, content: createDraftContentStore(objects), replyTargets: createPostgresReplyTargetLookup(pool), now },
    draftSend: { tokens, service, transport, drafts, draftContent: createDraftContentStore(objects), replyTargets: createPostgresReplyTargetLookup(pool), artifacts },
    labels: { tokens, messageState: createPostgresMessageStateStore(pool), now },
    agentEnroll: untouchable('agentEnroll'),
    policyRequests: untouchable('policyRequests'),
    identity: untouchable('identity'),
    health: untouchable('health'),
  };
  return { fixture, other, token: await tokenFor(provisioningPool(), fixture.agentId), transport, deps };
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

let requestNo = 0;
async function http(
  w: World,
  method: string,
  path: string,
  options: { readonly query?: string; readonly body?: unknown; readonly idempotencyKey?: string; readonly token?: string } = {},
): Promise<Reply> {
  requestNo += 1;
  const headers: Record<string, string> = { authorization: `Bearer ${options.token ?? w.token}`, 'content-type': 'application/json' };
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
  const result = await routeHttpApiEvent(w.deps, {
    rawPath: path,
    ...(options.query === undefined ? {} : { rawQueryString: options.query }),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    isBase64Encoded: false,
    requestContext: { requestId: `aid-${String(requestNo)}`, stage: '$default', http: { method } },
  });
  return { status: result.statusCode, body: JSON.parse(result.body) as Record<string, unknown> };
}

/** 쿼리 `agent_id` 를 받는 목록 경로 — 생략 · 자기 id · 남의 id · 형식 위반 · 빈 값. */
const QUERY_ROUTES: readonly { readonly path: string; readonly extra?: string }[] = [
  { path: '/v1/messages/inbound' },
  { path: '/v1/labels' },
  { path: '/v1/drafts' },
  { path: '/v1/messages/scheduled' },
  { path: '/v1/messages/verification-code', extra: 'sender_domain=example.com' },
];

/** 경로 `{agentId}` 를 받는 GET 경로(기본 토큰 권한으로 부를 수 있는 것). */
const PATH_ROUTES: readonly string[] = ['policy', 'capabilities', 'realtime', 'webhook-endpoints', 'webhook-deliveries'];

describe.skipIf(!DATABASE_AVAILABLE)('agent_id 생략 = 토큰의 에이전트 (쿼리)', () => {
  it.each(QUERY_ROUTES)('$path — 생략 200(토큰의 에이전트) · 자기 id 200 · 남의 id 403 · 형식 위반 400', async ({ path, extra }) => {
    const w = await world();
    const q = (agent: string | null): string => [agent === null ? null : `agent_id=${agent}`, extra ?? null].filter((part) => part !== null).join('&');

    const omitted = await http(w, 'GET', path, { query: q(null) });
    // 인증코드는 찾을 메일이 없으면 404 `code_not_found` 다 — 대상이 정해진 뒤의 결과이므로 생략도 같은 결과여야 한다.
    const explicit = await http(w, 'GET', path, { query: q(w.fixture.agentId) });
    expect(omitted.status, path).toBe(explicit.status);
    expect([200, 404]).toContain(omitted.status);
    expect(omitted.body, path).toEqual(explicit.body);
    if (path !== '/v1/messages/verification-code' && path !== '/v1/messages/scheduled') expect(omitted.body['agent_id'], path).toBe(w.fixture.agentId);

    const foreign = await http(w, 'GET', path, { query: q(w.other.agentId) });
    expect(foreign.status, path).toBe(403);
    expect(foreign.body['error']).toBe('forbidden');

    for (const bad of ['X', 'A'.repeat(32), '']) {
      const malformed = await http(w, 'GET', path, { query: q(bad) });
      expect(malformed.status, `${path} ${bad}`).toBe(400);
      expect(malformed.body['error']).toBe('invalid_request');
    }
  });

  it('생략해도 인증이 먼저다 — 토큰이 없으면 401 · 조직 키도 401', async () => {
    const w = await world();
    for (const { path } of QUERY_ROUTES) {
      expect((await http(w, 'GET', path, { token: 'atk_agent_nope' })).status, path).toBe(401);
      expect((await http(w, 'GET', path, { token: ORG_KEY })).status, path).toBe(401);
    }
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('agent_id 생략 = 토큰의 에이전트 (본문)', () => {
  it('POST /v1/messages — 생략하면 토큰의 에이전트로 보낸다 · 남의 id 는 403(SES 0) · 형식 위반 400', async () => {
    const w = await world();
    const mail = { from: w.fixture.address, to: [PARTNER], subject: '안녕하세요', text: '본문' };
    const sent = await http(w, 'POST', '/v1/messages', { body: mail, idempotencyKey: 'aid-1' });
    expect(sent.status).toBe(200);
    expect(sent.body['status']).toBe('sent');
    expect(w.transport.calls()).toBe(1);

    // 같은 키 · 같은 요청을 agent_id 를 적어 다시 — 같은 요청이므로 재생이다(생략과 명시가 같은 대상을 가리킨다).
    const replay = await http(w, 'POST', '/v1/messages', { body: { ...mail, agent_id: w.fixture.agentId }, idempotencyKey: 'aid-1' });
    expect(replay.body['replayed']).toBe(true);
    expect(replay.body['message_id']).toBe(sent.body['message_id']);

    const foreign = await http(w, 'POST', '/v1/messages', { body: { ...mail, agent_id: w.other.agentId }, idempotencyKey: 'aid-2' });
    expect(foreign.status).toBe(403);
    for (const bad of ['X', null, 7]) {
      const malformed = await http(w, 'POST', '/v1/messages', { body: { ...mail, agent_id: bad }, idempotencyKey: 'aid-3' });
      expect(malformed.status, String(bad)).toBe(400);
    }
    expect(w.transport.calls()).toBe(1);
  });

  it('초안 — 만들기 · 보내기(본문 없이) 모두 생략 가능 · 남의 id 로 만들기 403 · 형식 위반 400', async () => {
    const w = await world();
    const created = await http(w, 'POST', '/v1/drafts', { body: { from: w.fixture.address, to: [PARTNER], subject: '초안', text: '본문' } });
    expect(created.status).toBe(201);
    expect(created.body['agent_id']).toBe(w.fixture.agentId);

    expect((await http(w, 'POST', '/v1/drafts', { body: { agent_id: w.other.agentId, text: 'x' } })).status).toBe(403);
    expect((await http(w, 'POST', '/v1/drafts', { body: { agent_id: 'X', text: 'x' } })).status).toBe(400);

    const sent = await http(w, 'POST', `/v1/drafts/${String(created.body['id'])}/send`, { idempotencyKey: 'aid-draft' });
    expect(sent.status).toBe(200);
    expect(sent.body['status']).toBe('sent');
    expect(w.transport.calls()).toBe(1);

    const second = await http(w, 'POST', '/v1/drafts', { body: { from: w.fixture.address, to: [PARTNER], subject: '초안 2', text: '본문' } });
    const foreignSend = await http(w, 'POST', `/v1/drafts/${String(second.body['id'])}/send`, { body: { agent_id: w.other.agentId }, idempotencyKey: 'aid-draft-2' });
    expect(foreignSend.status).toBe(403);
    expect(w.transport.calls()).toBe(1);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('경로 별칭 /v1/agents/me/…', () => {
  it.each(PATH_ROUTES)('%s — me 와 자기 id 가 같은 답 · 남의 id 403 · 다른 철자 400 · 조직 키 401', async (tail) => {
    const w = await world();
    const me = await http(w, 'GET', `/v1/agents/me/${tail}`);
    const explicit = await http(w, 'GET', `/v1/agents/${w.fixture.agentId}/${tail}`);
    expect(me.status, tail).toBe(200);
    expect(me.status, tail).toBe(explicit.status);
    expect(me.body, tail).toEqual(explicit.body);
    expect(me.body['agent_id'] ?? (me.body['agent'] as Record<string, unknown> | undefined)?.['agent_id'], tail).toBe(w.fixture.agentId);

    expect((await http(w, 'GET', `/v1/agents/${w.other.agentId}/${tail}`)).status, tail).toBe(403);
    for (const spelling of ['ME', 'Me', 'self', 'me%20']) {
      const wrong = await http(w, 'GET', `/v1/agents/${spelling}/${tail}`);
      expect(wrong.status, `${tail} ${spelling}`).toBe(400);
      expect(wrong.body['error']).toBe('invalid_request');
    }
    const org = await http(w, 'GET', `/v1/agents/me/${tail}`, { token: ORG_KEY });
    expect(org.status, tail).toBe(401);
    expect(String(org.body['detail'])).toContain('atk_org_');
    expect((await http(w, 'GET', `/v1/agents/me/${tail}`, { token: 'atk_agent_nope' })).status, tail).toBe(401);
  });
});
