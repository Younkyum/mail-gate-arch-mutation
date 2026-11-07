/**
 * 적대적 검증(묶음 D) 공용 지반 — 실제 Postgres 위 API 라우터(`routeHttpApiEvent`) · 콘솔 라우터 · 자가 등록(admin 연산) · 수신 소비자.
 * 이 파일은 테스트가 아니다. 운영 소스는 건드리지 않는다.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { createInMemoryContentStore } from '../../../src/api/content-store';
import type { OutboundServiceDependencies } from '../../../src/api/outbound-service';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import { createPostgresSeedContactReader } from '../../../src/api/seed-contact-store';
import {
  createPostgresAgentTokenStore,
  createPostgresApprovalStore,
  createPostgresGateStores,
  createPostgresReplyTargetLookup,
} from '../../../src/db/repositories';
import { createPostgresDraftStore } from '../../../src/db/repositories/draft-store';
import { createPostgresExposureRecorder } from '../../../src/db/repositories/exposure-store';
import { createPostgresInboundPolicySource } from '../../../src/db/repositories/inbound-policy-store';
import { createPostgresInboundReadStore } from '../../../src/db/repositories/inbound-read-store';
import { createPostgresMessageStateStore } from '../../../src/db/repositories/message-state-store';
import { createPostgresPdfParseSlots } from '../../../src/db/repositories/pdf-parse-slots';
import { createPostgresScheduledSendStore } from '../../../src/db/repositories/scheduled-send-store';
import { createPostgresSelfEnrollStatus } from '../../../src/db/repositories/self-enroll-status';
import type { AgentId } from '../../../src/db/schema';
import { enrollAgentOp } from '../../../src/admin/ops/enroll';
import { changePolicyOp, resolvePolicyChange } from '../../../src/admin/ops/policy';
import { setAgentWatchOp, agentWatchPatchOf } from '../../../src/admin/ops/watch';
import type { EnrollEvent } from '../../../src/runtime/enroll-event';
import { routeHttpApiEvent, type ApiDependencies } from '../../../src/runtime/router';
import { createDraftContentStore } from '../../../src/storage/draft-content-store';
import { createInboundArtifactReader, createInboundAttachmentReader } from '../../../src/storage/inbound-artifact-store';
import { createLocalDownloadSigner, createLocalObjectStore } from '../../../src/storage/local-object-store';
import { createScheduledContentStore } from '../../../src/storage/scheduled-content-store';
import { testKeyCustody } from '../../unit/identity/fixtures';
import { adminDeps, adminRolePool, appPool, call, login, loginMailerPool, ownerPool, suffix, userIdOf, authed, type Session } from '../admin/support';
import { provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { consumerDeps, deliver, eml, newSesMessageId } from '../inbound/support';
import { countingTransport, type CountingTransport } from '../outbound/support/fakes';
import { inertDlp, inertRiskSignals, TEST_DLP_KEYRING } from '../../support/injection-doubles';
import type { AdminDependencies } from '../../../src/admin/context';
import { OWNER_AVAILABLE, tokenFor } from './watch-support';
import { createPostgresPolicyRequestStore } from '../../../src/db/repositories/policy-request-store';

export { OWNER_AVAILABLE, tokenFor };

export const PARTNER = 'partner@example.com';
export const CLIENT = 'client@customer.example';
export const STRANGER = 'stranger@elsewhere.example';

export function untouchable(label: string): never {
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

export interface ApiWorld {
  readonly pool: Pool;
  readonly fixture: Fixture;
  readonly token: string;
  readonly transport: CountingTransport;
  readonly deps: ApiDependencies;
  readonly service: OutboundServiceDependencies;
  readonly consumer: ReturnType<typeof consumerDeps>;
  readonly clock: { now: Date };
  readonly enrollCalls: EnrollEvent[];
}

/** 에이전트 하나가 있는 조직 위에 API 의존성 전체를 조립한다(실제 저장소 · 세는 전송단). */
export async function apiWorldFor(fixture: Fixture, token: string, clock: { now: Date } = { now: new Date() }): Promise<ApiWorld> {
  const pool = testPool();
  const directory = mkdtempSync(join(tmpdir(), 'atmark-adv-d-'));
  const objects = createLocalObjectStore({ directory, env: {} });
  const tokens = createPostgresAgentTokenStore(pool);
  const stores = createPostgresGateStores(pool);
  const now = (): Date => clock.now;
  const content = createInMemoryContentStore();
  const service: OutboundServiceDependencies = {
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
  const replyTargets = createPostgresReplyTargetLookup(pool);
  const drafts = createPostgresDraftStore(pool);
  const draftContent = createDraftContentStore(objects);
  const schedules = {
    tokens,
    schedules: createPostgresScheduledSendStore(pool),
    content: createScheduledContentStore(objects),
    now,
    risk: service,
  };
  const enrollCalls: EnrollEvent[] = [];
  const custody = testKeyCustody();
  const admin = consoleKit().admin;
  const deps: ApiDependencies = {
    send: { tokens, service, transport },
    reply: { tokens, service, transport, replyTargets, artifacts },
    forward: { tokens, service, transport, inbound, artifacts },
    transitionAnnouncement: { tokens, service, seeds: createPostgresSeedContactReader(pool) },
    audit: untouchable('audit'),
    approvalLink: untouchable('approvalLink'),
    approvals: { tokens, approvals: createPostgresApprovalStore(pool), now },
    agentPolicy: { tokens, policies: service.source, inboundPolicies: createPostgresInboundPolicySource(pool), now, selfEnroll: createPostgresSelfEnrollStatus(pool) },
    webhookEndpoints: untouchable('webhookEndpoints'),
    inboundRead,
    attachments: { ...inboundRead, signer: createLocalDownloadSigner({ directory, env: {} }), contents: createInboundAttachmentReader(objects), pdfSlots: createPostgresPdfParseSlots(pool) },
    scheduledMessages: schedules,
    scheduledQueries: schedules,
    verificationCode: untouchable('verificationCode'),
    webhookDeliveries: untouchable('webhookDeliveries'),
    outboundAttachments: untouchable('outboundAttachments'),
    drafts: { tokens, drafts, content: draftContent, replyTargets, now },
    draftSend: { tokens, service, transport, drafts, draftContent, replyTargets, artifacts },
    labels: { tokens, messageState: createPostgresMessageStateStore(pool), now },
    agentEnroll: {
      tokens,
      // 운영의 `createAgentEnroller` 와 같은 모양 — 이벤트를 JSON 으로 직렬화했다 되살려 admin 연산을 부른다(λ 경계).
      enroll: async (event) => {
        enrollCalls.push(event);
        const result = await enrollAgentOp(admin, custody, JSON.parse(JSON.stringify(event)) as EnrollEvent);
        return { ok: true as const, body: JSON.parse(JSON.stringify(result)) as unknown };
      },
      now,
      requestId: () => `req-${randomUUID()}`,
      precheck: null,
    },
    policyRequests: { tokens, policyRequests: createPostgresPolicyRequestStore(pool), now },
    identity: untouchable('identity'),
    health: untouchable('health'),
  };
  return { pool, fixture, token, transport, deps, service, consumer: consumerDeps(pool, objects), clock, enrollCalls };
}

/** 발송 시험용 세계: 허용 목록에 PARTNER · CLIENT 가 있는 에이전트 하나. */
export async function sendWorld(allowlist: readonly string[] = [PARTNER, CLIENT]): Promise<ApiWorld> {
  const fixture = await seedFixture(provisioningPool(), { allowlist });
  return apiWorldFor(fixture, await tokenFor(fixture.agentId));
}

export interface ApiResult {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly text: string;
}

let requestCounter = 0;
export async function api(
  w: { deps: ApiDependencies },
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string>; query?: string } = {},
): Promise<ApiResult> {
  requestCounter += 1;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const result = await routeHttpApiEvent(w.deps, {
    rawPath: path,
    ...(options.query === undefined ? {} : { rawQueryString: options.query }),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    isBase64Encoded: false,
    requestContext: { requestId: `adv-d-${String(requestCounter)}`, stage: '$default', http: { method } },
  } as never);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(result.body) as Record<string, unknown>;
  } catch {
    // 본문이 JSON 이 아니다.
  }
  return { status: result.statusCode, json, text: result.body };
}

export interface ToolCall {
  readonly status: number;
  readonly isError: boolean;
  readonly text: string;
  readonly meta: Record<string, unknown>;
}

export async function mcp(w: { deps: ApiDependencies; token: string }, name: string, args: Record<string, unknown>, token: string = w.token): Promise<ToolCall> {
  requestCounter += 1;
  const result = await routeHttpApiEvent(w.deps, {
    rawPath: '/mcp',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestCounter, method: 'tools/call', params: { name, arguments: args } }),
    isBase64Encoded: false,
    requestContext: { requestId: `adv-d-mcp-${String(requestCounter)}`, stage: '$default', http: { method: 'POST' } },
  } as never);
  let parsed: { result?: { isError: boolean; content: { text: string }[] }; error?: unknown } = {};
  try {
    parsed = JSON.parse(result.body) as typeof parsed;
  } catch {
    // 그대로.
  }
  const text = parsed.result?.content[0]?.text ?? result.body;
  const metaLine = text.split('\n').find((line) => line.startsWith('{')) ?? '{}';
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(metaLine) as Record<string, unknown>;
  } catch {
    // 메타 없음.
  }
  return { status: result.statusCode, isError: parsed.result?.isError ?? true, text, meta };
}

/** 발신 승인을 바꾼다 — 콘솔 라우트가 부르는 연산 그대로(정책 새 버전). */
export async function setSendApproval(agentId: string, organizationId: string, value: 'auto' | 'always'): Promise<void> {
  await setAgentWatchOp(provisioningPool(), organizationId, randomUUID(), agentId, agentWatchPatchOf({ sendApproval: value }), 'adv-d', 'owner');
}

export async function setMode(agentId: AgentId, mode: 'all' | 'allowlist' | 'blocklist' | 'none'): Promise<void> {
  await changePolicyOp(provisioningPool(), agentId, resolvePolicyChange({ outboundMode: mode }), 'adv-d');
}

/** 받은 메일 한 통(DMARC 통과) — 답장 · 전달 시험용. 받은 메일 id 와 스레드 id 를 돌려준다. */
export async function receiveFrom(w: ApiWorld, from: string, subject = '견적서', text = '견적 부탁드립니다.'): Promise<{ id: string; threadId: string }> {
  const ses = newSesMessageId();
  await deliver(w.consumer, eml({ from, subject, text }), { sesMessageId: ses, recipients: [w.fixture.address] });
  const row = await w.pool.query<{ id: string; thread_id: string }>('SELECT id, thread_id FROM inbound_messages WHERE agent_id = $1 AND ses_message_id = $2', [w.fixture.agentId, ses]);
  const found = row.rows[0];
  if (found === undefined) throw new Error('받은 메일 행이 없다');
  return { id: found.id, threadId: found.thread_id };
}

export async function outboundRows(agentId: string): Promise<{ id: string; status: string }[]> {
  const rows = await provisioningPool().query<{ id: string; status: string }>(`SELECT id, status::text AS status FROM messages WHERE agent_id = $1 AND direction = 'outbound' ORDER BY created_at`, [agentId]);
  return rows.rows;
}

export async function auditDecisions(agentId: string): Promise<{ decision: string; reasons: string[]; policy_version: number | null }[]> {
  const rows = await provisioningPool().query<{ decision: string; reasons: string[]; policy_version: number | null }>(
    'SELECT decision::text AS decision, reasons, policy_version FROM audit_logs WHERE agent_id = $1 ORDER BY created_at, id',
    [agentId],
  );
  return rows.rows;
}

// ---------------------------------------------------------------------------
// 콘솔 세션 — 같은 조직의 owner · admin · member
// ---------------------------------------------------------------------------

export interface ConsoleKit {
  readonly deps: AdminDependencies;
  readonly owner: Pool;
  readonly admin: Pool;
  readonly app: Pool;
  readonly mailer: Pool;
}

let kitCache: ConsoleKit | undefined;
export function consoleKit(): ConsoleKit {
  if (kitCache === undefined) {
    const admin = adminRolePool();
    kitCache = { deps: adminDeps(admin), owner: ownerPool(), admin, app: appPool(), mailer: loginMailerPool() };
  }
  return kitCache;
}

export async function closeConsoleKit(): Promise<void> {
  if (kitCache === undefined) return;
  const kit = kitCache;
  kitCache = undefined;
  await Promise.all([kit.owner.end(), kit.admin.end(), kit.app.end(), kit.mailer.end()]);
}

/** 조직에 사용자를 심고 그 역할로 로그인한다. */
export async function sessionFor(organizationId: string, role: 'owner' | 'admin' | 'member'): Promise<Session> {
  const kit = consoleKit();
  const email = `adv-d-${role}-${suffix()}@example.com`;
  await kit.owner.query('INSERT INTO users (email) VALUES ($1)', [email]);
  const userId = await userIdOf(kit.owner, email);
  await kit.owner.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, $3, 'invite')`, [userId, organizationId, role]);
  return login(kit.deps, kit.mailer, { id: organizationId, ownerEmail: email });
}

export { authed, call, suffix };
