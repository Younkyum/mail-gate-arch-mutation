/**
 * **P2 승인 표면 + 웹훅 배선 — 실제 Postgres 위에서** (계획 §3.4 1조·4조·5조, AC-a1·AC-d3·AC-d5).
 *
 * 단위 테스트(`magic-link.test.ts`·`service.test.ts`)는 판정을 본다. 여기서 보는 것은 **DB 가 있어야만
 * 참인 것들**이다:
 *   - 매직링크 GET·미리보기가 **아무 행도 바꾸지 않는다**(사용 기록·요청 상태·outbox 전부)
 *   - 결정은 `FOR UPDATE` → 사용 기록 → 전이 → 웹훅이 **한 트랜잭션**이다 — 중간에 던지면 전부 없다
 *   - 전이에 진 쪽은 이벤트가 없다 / 이벤트의 에이전트가 틀리면 전이째 롤백
 *   - 만료 웹훅은 스위퍼가 두 번 돌아도 1회(AC-d3), `message.sent` 는 확정과 같은 트랜잭션
 *   - 조회 라우트의 소유 검사, 웹훅 시크릿 1회 노출, 그 시크릿이 실제 전달의 서명을 검증한다
 *
 * **디스패처 전달 테스트는 자기 엔드포인트의 행만 집는다**(`scopedOutbox`). 실제 `claimDue` 는 테이블 전체의
 * 기한 된 행을 집으므로, 병렬로 도는 `webhook-store.test.ts` 의 행을 가로채면 그쪽이 흔들린다. 전역 집기의
 * 성질(SKIP LOCKED·펜싱)은 그 파일이 본다.
 *
 * **`TEST_DATABASE_URL` 이 없으면 통째로 건너뛴다.**
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { PLAN_CATALOG, type PlanCode } from '../../../src/billing/plans';
import { grantPlan } from '../../support/entitlements';

import { afterAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createInMemoryContentStore } from '../../../src/api/content-store';
import type { ApiRequest } from '../../../src/api/http';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import {
  finalizeOutbound,
  gateDependenciesFor,
  prepareOutbound,
  type OutboundServiceDependencies,
} from '../../../src/api/outbound-service';
import { createPostgresProvisioningStore } from '../../../src/api/provisioning-store';
import { handleGetAgentPolicy } from '../../../src/api/routes/agent-policy';
import { handleApprovalLink } from '../../../src/api/routes/approval-link';
import { handleGetApproval } from '../../../src/api/routes/approvals';
import {
  handleListWebhookEndpoints,
  handleRegisterWebhookEndpoint,
  MAX_WEBHOOK_ENDPOINTS_PER_AGENT,
} from '../../../src/api/routes/webhook-endpoints';
import {
  ApprovalLinkScopeError,
  mintApprovalLinkToken,
  type ApprovalLinkPorts,
} from '../../../src/approval/magic-link';
import { approveRequest, expireRequest, rejectRequest } from '../../../src/approval/service';
import {
  createPostgresAgentTokenStore,
  createPostgresApprovalStore,
  createPostgresGateStores,
  createPostgresInboundPolicySource,
  createPostgresPolicySource,
} from '../../../src/db/repositories';
import {
  createPostgresApprovalLinkPorts,
  magicLinkDecider,
} from '../../../src/db/repositories/approval-link-use-store';
import { createPostgresWebhookOutbox } from '../../../src/db/repositories/webhook-store';
import { toAgentId, type AgentId } from '../../../src/db/schema';
import { AGENT_TOKEN_CAPABILITIES, issueAgentToken } from '../../../src/identity/agent-token';
import { provisionAgent } from '../../../src/identity/provisioning';
import { dispatch } from '../../../src/policy/gate';
import type { PolicySource } from '../../../src/policy/policy-loader';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import type { ClaimedDelivery, WebhookHttpRequest, WebhookOutboxPort } from '../../../src/webhooks/dispatcher';
import { approvalResolvedEvent } from '../../../src/webhooks/events';
import { verifyWebhook } from '../../../src/webhooks/signing';
import { runApprovalRelease } from '../../../src/workers/approval-release';
import { runWebhookDispatcher } from '../../../src/workers/webhook-dispatcher';
import {
  closeTestPool,
  DATABASE_AVAILABLE,
  provisioningPool,
  testPool,
} from '../db/support/harness';
import { countingTransport } from '../outbound/support/fakes';
import { testKeyCustody } from '../../unit/identity/fixtures';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

const LINK_RING = parseHmacKeyring(`k1:${randomBytes(32).toString('base64url')}`, 'TEST');
const HOOK_RING = parseHmacKeyring(`w1:${randomBytes(32).toString('base64url')}`, 'TEST');
const FORM = 'application/x-www-form-urlencoded';

// ---------------------------------------------------------------------------
// 지반
// ---------------------------------------------------------------------------

interface Agent {
  readonly agentId: AgentId;
  readonly address: string;
  readonly token: string;
}

/** `approval_required` 에이전트 + 토큰. `config` 로 정책 모양을 바꾼다(409 경로). */
async function seedAgent(pool: Pool, config: Record<string, unknown> = {}, plan: PlanCode | null = 'beta'): Promise<Agent> {
  const agentId = toAgentId(randomBytes(16).toString('hex'));
  const address = `t1-${agentId.slice(0, 16)}@atmark.ai`;
  const org = await provisioningPool().query<{ id: string }>(
    `INSERT INTO organizations (name, billing_status) VALUES ($1, 'active') RETURNING id`,
    [`t1-org-${agentId.slice(0, 8)}`],
  );
  // 요금제(ADR-0011) — 이 파일의 한도(per_minute 100 · 수신자 20 · 웹훅 10)는 도입 전 한도(beta)를 전제로 쓴 것이다. `null` = 행 없음(Free).
  if (plan !== null) await grantPlan(provisioningPool(), org.rows[0]?.id ?? '', plan);
  await provisioningPool().query(
    `INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents)
     VALUES ($1, $2, $3, 'active', 'free', 100000)`,
    [agentId, org.rows[0]?.id, `t1-agent-${agentId.slice(0, 8)}`],
  );
  await provisioningPool().query(
    `INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', true)`,
    [agentId, address],
  );
  const limits = { per_minute: 100, per_hour: 1000, per_day: 5000, recipients_per_message: 20 };
  const policyConfig = {
    allowlist: [],
    blocklist: [],
    max_attachment_bytes_total: 10_000_000,
    allowed_mime_types: ['text/plain'],
    // TTL 을 최대(7일)로 둔다 — 스위퍼는 **전역**이고 `approval-flow.test.ts` 가 병렬로 `now + 24h` 스윕을
    // 돌린다. 기본 24h 면 그 스윕이 이 파일의 대기 요청을 테스트 도중에 만료시킨다.
    approval_ttl_seconds: 7 * 24 * 3600,
    ...config,
  };
  await provisioningPool().query(
    `INSERT INTO agent_policies (agent_id, outbound_mode, limits, config_json, current_version)
     VALUES ($1, 'approval_required', $2::jsonb, $3::jsonb, 1)`,
    [agentId, JSON.stringify(limits), JSON.stringify(policyConfig)],
  );
  await provisioningPool().query(
    `INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot) VALUES ($1, 1, 'approval_required', $2::jsonb)`,
    [agentId, JSON.stringify({ outbound_mode: 'approval_required', limits, config_json: policyConfig })],
  );
  // 전 권한(웹훅 관리 포함 — 2026-09-30부터 새 토큰은 webhooks:manage 가 있어야 웹훅을 등록한다).
  const issued = issueAgentToken(agentId, AGENT_TOKEN_CAPABILITIES);
  await createPostgresAgentTokenStore(provisioningPool()).insert({
    agentId,
    tokenHash: issued.tokenHash,
    capabilities: issued.capabilities,
    expiresAt: null,
  });
  return { agentId, address, token: issued.plaintext };
}

function serviceFor(pool: Pool): OutboundServiceDependencies {
  const stores = createPostgresGateStores(pool);
  return {
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
    now: () => new Date(),
  };
}

interface Opened {
  readonly approvalId: string;
  readonly expiresAt: Date;
  readonly messageId: string;
}

/** 새 상대에게 보내 승인 대기를 연다 — 관문이 실제로 요청을 만든다. */
async function openApproval(
  service: OutboundServiceDependencies,
  agent: Agent,
  recipient = `cfo-${randomUUID().slice(0, 8)}@partner-${randomUUID().slice(0, 6)}.io`,
): Promise<Opened> {
  const prepared = await prepareOutbound(service, {
    routeId: 'send',
    agentId: agent.agentId,
    idempotencyKey: randomUUID(),
    fromAddress: agent.address,
    recipients: [recipient],
    subject: 't1',
    text: 't1',
    html: null,
    isThreadReply: false,
    traceId: null,
    costCents: 0,
  });
  if (prepared.kind !== 'ready') throw new Error('ready 여야 한다');
  const outcome = await finalizeOutbound(
    service,
    prepared,
    await dispatch(gateDependenciesFor(service, countingTransport()), prepared.dispatchRequest),
  );
  if (outcome.kind !== 'pending_approval' || outcome.approval === null) throw new Error(`승인 대기여야 한다: ${outcome.kind}`);
  return { approvalId: outcome.approval.approvalId, expiresAt: outcome.approval.expiresAt, messageId: outcome.messageId };
}

function bearer(token: string, body: unknown = null): ApiRequest {
  return { headers: { authorization: `Bearer ${token}` }, query: {}, body };
}

function webhookDeps(pool: Pool) {
  return { tokens: createPostgresAgentTokenStore(pool), db: pool, keyring: HOOK_RING, now: () => new Date() };
}

/** 등록 라우트로 엔드포인트를 만들고 **응답의** 시크릿을 돌려준다. */
async function registerEndpoint(pool: Pool, agent: Agent): Promise<{ id: string; secret: string }> {
  const response = await handleRegisterWebhookEndpoint(
    webhookDeps(pool),
    bearer(agent.token, { url: `https://hooks-${randomUUID().slice(0, 8)}.example.com/atmark` }),
    { agentId: agent.agentId },
  );
  expect(response.status).toBe(201);
  return { id: response.body['id'] as string, secret: response.body['secret'] as string };
}

interface OutboxRow {
  event_type: string;
  dedupe_key: string;
  body: string;
  status: string;
}

async function outboxOf(pool: Pool, endpointId: string): Promise<OutboxRow[]> {
  const result = await pool.query<OutboxRow>(
    'SELECT event_type, dedupe_key, body, status FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at, id',
    [endpointId],
  );
  return result.rows;
}

async function linkUses(pool: Pool, approvalId: string): Promise<number> {
  const result = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM approval_link_uses WHERE approval_id = $1', [
    approvalId,
  ]);
  return result.rows[0]?.n ?? -1;
}

async function statusOf(pool: Pool, approvalId: string): Promise<{ status: string; decided_by: string | null } | undefined> {
  const result = await pool.query<{ status: string; decided_by: string | null }>(
    'SELECT status, decided_by FROM approval_requests WHERE id = $1',
    [approvalId],
  );
  return result.rows[0];
}

async function relationshipsOf(pool: Pool, agentId: string) {
  const result = await pool.query<{ scope: string; domain: string | null; domain_scope_confirmed_by: string | null }>(
    `SELECT scope, domain, domain_scope_confirmed_by FROM sender_relationships
      WHERE agent_id = $1 AND granted_via_approval_id IS NOT NULL`,
    [agentId],
  );
  return result.rows;
}

function linkPorts(pool: Pool, approved: string[] = []): ApprovalLinkPorts {
  return createPostgresApprovalLinkPorts(pool, {
    keyring: LINK_RING,
    onApproved: (approvalId) => {
      approved.push(approvalId);
      return Promise.resolve();
    },
  });
}

function linkRequest(ports: ApprovalLinkPorts, method: string, body = '', contentType: string | null = FORM) {
  return handleApprovalLink({ ports, now: () => new Date() }, { method, contentType, body });
}

function tokenFor(opened: Opened): string {
  return mintApprovalLinkToken(LINK_RING, { approvalId: opened.approvalId, expiresAt: opened.expiresAt });
}

// ---------------------------------------------------------------------------
// 매직링크 — GET·미리보기는 아무것도 바꾸지 않는다
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('매직링크 라우트 — GET·미리보기는 읽기만, 결정은 한 번', () => {
  it('GET·HEAD 를 몇 번 해도 사용 기록·요청 상태·outbox 가 그대로다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const hook = await registerEndpoint(pool, agent);
    const opened = await openApproval(serviceFor(pool), agent);
    const ports = linkPorts(pool);

    for (const method of ['GET', 'HEAD', 'GET']) {
      const response = await linkRequest(ports, method, `token=${tokenFor(opened)}&decision=approve`);
      expect(response.status).toBe(200);
    }
    expect(await linkUses(pool, opened.approvalId)).toBe(0);
    expect((await statusOf(pool, opened.approvalId))?.status).toBe('pending');
    expect(await outboxOf(pool, hook.id)).toEqual([]);
  });

  it('미리보기는 요청 내용을 돌려주고 **사용을 소비하지 않는다** — 세 번 본 뒤에도 결정이 성공한다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const recipient = `buyer-${randomUUID().slice(0, 8)}@acme-${randomUUID().slice(0, 6)}.io`;
    const opened = await openApproval(serviceFor(pool), agent, recipient);
    const token = tokenFor(opened);
    const approved: string[] = [];
    const ports = linkPorts(pool, approved);

    for (let i = 0; i < 3; i += 1) {
      const preview = await linkRequest(ports, 'POST', new URLSearchParams({ intent: 'preview', token }).toString());
      expect(preview.status).toBe(200);
      expect(JSON.parse(preview.body)).toEqual({
        approval: {
          kind: 'message',
          agent_name: `t1-agent-${agent.agentId.slice(0, 8)}`,
          from: [agent.address],
          recipients: [recipient],
          message_count: 1,
          attachment_count: 0,
          attachment_bytes: 0,
          attachment_names: [],
          expires_at: opened.expiresAt.toISOString(),
          // ADR-0016 — 위험 보류가 아니면 빈 목록(페이지는 범위 선택을 그대로 보인다).
          risk_reasons: [],
        },
      });
    }
    expect(await linkUses(pool, opened.approvalId)).toBe(0);
    expect((await statusOf(pool, opened.approvalId))?.status).toBe('pending');

    const decided = await linkRequest(ports, 'POST', new URLSearchParams({ token, decision: 'approve' }).toString());
    expect(decided.status).toBe(200);
    expect(await statusOf(pool, opened.approvalId)).toEqual({ status: 'approved', decided_by: magicLinkDecider('k1') });
    expect(await linkUses(pool, opened.approvalId)).toBe(1);
    expect(approved).toEqual([opened.approvalId]);

    // 결정 뒤의 미리보기는 409 — 결정된 요청의 내용을 계속 보여 주지 않는다.
    const after = await linkRequest(ports, 'POST', new URLSearchParams({ intent: 'preview', token }).toString());
    expect(after.status).toBe(409);
    // 같은 링크의 두 번째 결정도 409 이고, 릴리스 잡은 한 번뿐이다.
    expect((await linkRequest(ports, 'POST', new URLSearchParams({ token, decision: 'reject' }).toString())).status).toBe(409);
    expect(approved).toEqual([opened.approvalId]);
  });

  it('onApproved 는 **커밋 뒤에** 불린다 — 그 시점에 다른 커넥션이 approved 를 본다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const opened = await openApproval(serviceFor(pool), agent);
    const seen: (string | undefined)[] = [];
    const ports = createPostgresApprovalLinkPorts(pool, {
      keyring: LINK_RING,
      onApproved: async (approvalId) => {
        seen.push((await statusOf(pool, approvalId))?.status);
      },
    });
    await linkRequest(ports, 'POST', new URLSearchParams({ token: tokenFor(opened), decision: 'approve' }).toString());
    expect(seen).toEqual(['approved']);
  });

  it('onResolved(실시간 approval.resolved 힌트, 묶음 E) 는 승인 · 거절 모두 **커밋 뒤에** 한 번 · 진 전이 · 미리보기에는 없다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const approvedOpen = await openApproval(serviceFor(pool), agent);
    const rejectedOpen = await openApproval(serviceFor(pool), agent);
    const seen: [string, string | undefined][] = [];
    const ports = createPostgresApprovalLinkPorts(pool, {
      keyring: LINK_RING,
      onApproved: () => Promise.resolve(),
      onResolved: async (approvalId) => {
        seen.push([approvalId, (await statusOf(pool, approvalId))?.status]);
      },
    });
    await linkRequest(ports, 'POST', new URLSearchParams({ intent: 'preview', token: tokenFor(approvedOpen) }).toString());
    expect(seen).toEqual([]);
    await linkRequest(ports, 'POST', new URLSearchParams({ token: tokenFor(approvedOpen), decision: 'approve' }).toString());
    await linkRequest(ports, 'POST', new URLSearchParams({ token: tokenFor(rejectedOpen), decision: 'reject' }).toString());
    // 두 번째 결정(409)은 부르지 않는다.
    await linkRequest(ports, 'POST', new URLSearchParams({ token: tokenFor(approvedOpen), decision: 'reject' }).toString());
    expect(seen).toEqual([
      [approvedOpen.approvalId, 'approved'],
      [rejectedOpen.approvalId, 'rejected'],
    ]);
  });

  it('거절 — 요청 rejected, audit denied/approval_rejected, `approval.resolved`(rejected) 1행, 릴리스 없음', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const hook = await registerEndpoint(pool, agent);
    const opened = await openApproval(serviceFor(pool), agent);
    const approved: string[] = [];

    const response = await linkRequest(
      linkPorts(pool, approved),
      'POST',
      new URLSearchParams({ token: tokenFor(opened), decision: 'reject' }).toString(),
    );
    expect(response.status).toBe(200);
    expect((await statusOf(pool, opened.approvalId))?.status).toBe('rejected');
    const audit = await pool.query<{ decision: string; resolution_reason: string }>(
      'SELECT decision, resolution_reason FROM audit_logs WHERE approval_id = $1',
      [opened.approvalId],
    );
    expect(audit.rows).toEqual([{ decision: 'denied', resolution_reason: 'approval_rejected' }]);
    const rows = await outboxOf(pool, hook.id);
    expect(rows.map((row) => row.dedupe_key)).toEqual([`approval.resolved:${opened.approvalId}`]);
    expect(JSON.parse(rows[0]?.body ?? '{}')).toMatchObject({
      type: 'approval.resolved',
      agent_id: agent.agentId,
      data: { approval_id: opened.approvalId, decision: 'rejected', message_ids: [opened.messageId] },
    });
    expect(approved).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-d5 — domain 스코프
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('AC-d5 — 매직링크의 domain 승인은 confirm_scope 없이는 400', () => {
  it('확인 없는 domain 승인은 400 이고 아무것도 바뀌지 않는다 — 링크는 살아 있고, 확인하면 domain 관계가 생긴다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const hook = await registerEndpoint(pool, agent);
    const opened = await openApproval(serviceFor(pool), agent, `ceo@wide-${randomUUID().slice(0, 8)}.io`);
    const token = tokenFor(opened);
    const ports = linkPorts(pool);

    for (const extra of [{ scope: 'domain' }, { scope: 'domain', confirm_scope: 'recipient' }]) {
      const response = await linkRequest(ports, 'POST', new URLSearchParams({ token, decision: 'approve', ...extra }).toString());
      expect(response.status).toBe(400);
    }
    expect(await linkUses(pool, opened.approvalId)).toBe(0);
    expect((await statusOf(pool, opened.approvalId))?.status).toBe('pending');
    expect(await relationshipsOf(pool, agent.agentId)).toEqual([]);
    expect(await outboxOf(pool, hook.id)).toEqual([]);

    const confirmed = await linkRequest(
      ports,
      'POST',
      new URLSearchParams({ token, decision: 'approve', scope: 'domain', confirm_scope: 'domain' }).toString(),
    );
    expect(confirmed.status).toBe(200);
    expect(await relationshipsOf(pool, agent.agentId)).toEqual([
      { scope: 'domain', domain: expect.stringMatching(/^wide-/) as unknown as string, domain_scope_confirmed_by: 'magic_link:k1' },
    ]);
  });

  it('2차 방어선 — 라우트 검사를 건너뛰어도 서비스가 전이 안에서 거부하고, 사용 기록까지 롤백된다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const opened = await openApproval(serviceFor(pool), agent);
    const ports = linkPorts(pool);
    const now = new Date();

    await expect(
      ports.runInTransaction(async (tx) => {
        await tx.findApprovalForUpdate(opened.approvalId);
        await tx.recordUse({
          approvalId: opened.approvalId,
          tokenIdHash: randomBytes(32).toString('hex'),
          keyId: 'k1',
          decision: 'approve',
          usedAt: now,
        });
        await tx.resolveApproval(opened.approvalId, 'approve', now, { scope: 'domain', confirmScope: null, keyId: 'k1' });
      }),
    ).rejects.toBeInstanceOf(ApprovalLinkScopeError);
    expect(await linkUses(pool, opened.approvalId)).toBe(0);
    expect((await statusOf(pool, opened.approvalId))?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// L-A — 조직 정지·동결 중의 승인은 409 안내 페이지. 링크는 소진되지 않고, 풀면 같은 링크로 승인된다
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('L-A — 정지·동결 중 매직링크 승인', () => {
  for (const column of ['owner_paused', 'abuse_freeze'] as const) {
    it(`${column} 이면 409 "조직이 정지 중입니다" — 사용 기록 0 · pending · 관계 0 · 릴리스 없음, 풀면 같은 링크로 200`, async () => {
      const pool = testPool();
      const owner = provisioningPool();
      const agent = await seedAgent(pool);
      const opened = await openApproval(serviceFor(pool), agent);
      const token = tokenFor(opened);
      const approved: string[] = [];
      const ports = linkPorts(pool, approved);
      const setPaused = (on: boolean) =>
        owner.query(`UPDATE organizations SET ${column} = $2 WHERE id = (SELECT organization_id FROM agents WHERE id = $1)`, [
          agent.agentId,
          on,
        ]);

      await setPaused(true);
      const blocked = await linkRequest(ports, 'POST', new URLSearchParams({ token, decision: 'approve' }).toString());
      expect(blocked.status).toBe(409);
      expect(blocked.body).toContain('조직이 정지 중입니다');
      expect(await linkUses(pool, opened.approvalId)).toBe(0);
      expect((await statusOf(pool, opened.approvalId))?.status).toBe('pending');
      expect(await relationshipsOf(pool, agent.agentId)).toEqual([]);
      expect(approved).toEqual([]);

      await setPaused(false);
      const decided = await linkRequest(ports, 'POST', new URLSearchParams({ token, decision: 'approve' }).toString());
      expect(decided.status).toBe(200);
      expect((await statusOf(pool, opened.approvalId))?.status).toBe('approved');
      expect(approved).toEqual([opened.approvalId]);
    });
  }
});

// ---------------------------------------------------------------------------
// 셀프 가입 — 운영자 검토 전·거절 조직의 승인은 409 안내 페이지. 링크는 소진되지 않고, 활성화하면 같은 링크로 승인된다
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('셀프 가입 — 검토 전·거절 조직의 매직링크 승인', () => {
  for (const status of ['pending_review', 'rejected'] as const) {
    it(`review_status=${status} 이면 409 "운영자 검토 중인 조직입니다" — 사용 기록 0 · pending · 관계 0, 활성화하면 같은 링크로 200`, async () => {
      const pool = testPool();
      const owner = provisioningPool();
      const agent = await seedAgent(pool);
      const opened = await openApproval(serviceFor(pool), agent);
      const token = tokenFor(opened);
      const approved: string[] = [];
      const ports = linkPorts(pool, approved);
      // 검토 상태는 소유자 롤(운영자 CLI)만 바꾼다 — 테스트도 그 롤로.
      const setReview = (value: 'pending_review' | 'rejected' | 'active') =>
        owner.query(`UPDATE organizations SET review_status = $2 WHERE id = (SELECT organization_id FROM agents WHERE id = $1)`, [
          agent.agentId,
          value,
        ]);

      await setReview(status);
      const blocked = await linkRequest(ports, 'POST', new URLSearchParams({ token, decision: 'approve' }).toString());
      expect(blocked.status).toBe(409);
      expect(blocked.body).toContain('운영자 검토 중인 조직입니다');
      expect(blocked.body).toContain('검토가 끝난 뒤 같은 링크로 다시 승인해 주세요. 링크는 아직 유효합니다.');
      expect(await linkUses(pool, opened.approvalId)).toBe(0);
      expect((await statusOf(pool, opened.approvalId))?.status).toBe('pending');
      expect(await relationshipsOf(pool, agent.agentId)).toEqual([]);
      expect(approved).toEqual([]);

      // 영어 페이지도 같은 판정(계약 §8).
      const english = await handleApprovalLink(
        { ports, now: () => new Date() },
        { method: 'POST', contentType: FORM, body: new URLSearchParams({ token, decision: 'approve' }).toString(), language: 'en' },
      );
      expect(english.status).toBe(409);
      expect(english.body).toContain('under operator review');
      expect(await linkUses(pool, opened.approvalId)).toBe(0);

      await setReview('active');
      const decided = await linkRequest(ports, 'POST', new URLSearchParams({ token, decision: 'approve' }).toString());
      expect(decided.status).toBe(200);
      expect((await statusOf(pool, opened.approvalId))?.status).toBe('approved');
      expect(approved).toEqual([opened.approvalId]);
    });
  }

  it('DB 트리거가 두 번째 층이다 — 앱 코드 검사를 건너뛴 raw 승인도 55000 · 거절은 된다', async () => {
    const pool = testPool();
    const owner = provisioningPool();
    const agent = await seedAgent(pool);
    const opened = await openApproval(serviceFor(pool), agent);
    await owner.query(`UPDATE organizations SET review_status = 'pending_review' WHERE id = (SELECT organization_id FROM agents WHERE id = $1)`, [
      agent.agentId,
    ]);
    const raw = pool.query(
      `UPDATE approval_requests SET status = 'approved', decided_at = now(), decided_by = 'x', granted_scope = 'recipient' WHERE id = $1`,
      [opened.approvalId],
    );
    await expect(raw).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('not active (review)') as unknown as string });
    const ports = linkPorts(pool);
    const rejected = await linkRequest(ports, 'POST', new URLSearchParams({ token: tokenFor(opened), decision: 'reject' }).toString());
    expect(rejected.status).toBe(200);
    expect((await statusOf(pool, opened.approvalId))?.status).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// 웹훅 원자성 — 이벤트는 전이와 함께 커밋되거나 함께 사라진다
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('웹훅 enqueue 는 상태 전이와 원자적이다', () => {
  it('결정 트랜잭션이 전이 **뒤에** 던지면 전이·사용 기록·관계·이벤트가 전부 없다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const hook = await registerEndpoint(pool, agent);
    const opened = await openApproval(serviceFor(pool), agent);
    const approved: string[] = [];
    const ports = linkPorts(pool, approved);
    const now = new Date();

    await expect(
      ports.runInTransaction(async (tx) => {
        await tx.findApprovalForUpdate(opened.approvalId);
        await tx.recordUse({
          approvalId: opened.approvalId,
          tokenIdHash: randomBytes(32).toString('hex'),
          keyId: 'k1',
          decision: 'approve',
          usedAt: now,
        });
        await tx.resolveApproval(opened.approvalId, 'approve', now, { scope: 'recipient', confirmScope: null, keyId: 'k1' });
        throw new Error('커밋 직전 실패');
      }),
    ).rejects.toThrow('커밋 직전 실패');

    expect((await statusOf(pool, opened.approvalId))?.status).toBe('pending');
    expect(await linkUses(pool, opened.approvalId)).toBe(0);
    expect(await relationshipsOf(pool, agent.agentId)).toEqual([]);
    expect(await outboxOf(pool, hook.id)).toEqual([]);
    expect(approved).toEqual([]);
  });

  it('전이에 진 쪽은 이벤트가 없다 — 승인 뒤의 만료, 만료 뒤의 승인·거절 모두 0행', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const hook = await registerEndpoint(pool, agent);
    const service = serviceFor(pool);
    const store = createPostgresApprovalStore(pool);

    // (a) 승인이 이긴다 → 뒤늦은 만료는 0행.
    const won = await openApproval(service, agent);
    const approval = await approveRequest(store, {
      approvalId: won.approvalId,
      decidedBy: 'owner@example.com',
      now: new Date(),
      scope: 'recipient',
      confirmScope: null,
    });
    expect(approval.kind).toBe('approved');
    expect(await expireRequest(store, won.approvalId, new Date(won.expiresAt.getTime() + 1000))).toBe(false);

    // (b) 만료가 이긴다 → 뒤늦은 거절·승인은 0행. (거절이 먼저 **이긴 뒤**를 쓰지 않는 이유: 승인·거절은 같은
    //     dedupe 키 `approval.resolved:<id>` 를 써서, 진 쪽이 이벤트를 적어도 outbox 가 조용히 삼킨다.)
    const lost = await openApproval(service, agent);
    expect(await expireRequest(store, lost.approvalId, new Date(lost.expiresAt.getTime() + 1000))).toBe(true);
    expect(await rejectRequest(store, { approvalId: lost.approvalId, decidedBy: 'owner@example.com', now: new Date() })).toBe(false);
    const late = await approveRequest(store, {
      approvalId: lost.approvalId,
      decidedBy: 'owner@example.com',
      now: new Date(),
      scope: 'recipient',
      confirmScope: null,
    });
    expect(late.kind).toBe('not_pending');

    const rows = await outboxOf(pool, hook.id);
    expect(rows.map((row) => row.dedupe_key)).toEqual([
      `approval.resolved:${won.approvalId}`,
      `approval.expired:${lost.approvalId}`,
    ]);
    expect(JSON.parse(rows[0]?.body ?? '{}')).toMatchObject({ data: { decision: 'approved', message_ids: [won.messageId] } });
  });

  it('저장소가 **pending 을 본 뒤** 조건부 UPDATE 에 져도 이벤트가 없다(서비스의 선조회를 건너뛴 직접 호출)', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const hook = await registerEndpoint(pool, agent);
    const opened = await openApproval(serviceFor(pool), agent);
    const store = createPostgresApprovalStore(pool);
    // TTL 전에는 만료 UPDATE 가 0행이다 — 그때 이벤트를 적으면 "일어나지 않은 만료" 를 알린다.
    const event = approvalResolvedEvent({
      agentId: agent.agentId,
      approvalId: opened.approvalId,
      decision: 'rejected',
      resolvedAt: new Date(),
      messageIds: [opened.messageId],
    });
    expect(await store.expire({ approvalId: opened.approvalId, now: new Date(), event })).toBe(false);
    expect(await outboxOf(pool, hook.id)).toEqual([]);

    // 만료가 이긴 뒤, 저장소를 **직접** 부른 거절·승인도 0행이다 — 서비스의 선조회(`find`)가 없어도
    // 조건부 UPDATE 가 지면 이벤트를 적지 않는다.
    expect(await expireRequest(store, opened.approvalId, new Date(opened.expiresAt.getTime() + 1000))).toBe(true);
    expect(
      await store.reject({ approvalId: opened.approvalId, decidedBy: 'owner@example.com', now: new Date(), event }),
    ).toBe(false);
    expect(
      await store.approve({
        approvalId: opened.approvalId,
        decidedBy: 'owner@example.com',
        now: new Date(),
        scope: 'recipient',
        relationships: [],
        event: approvalResolvedEvent({
          agentId: agent.agentId,
          approvalId: opened.approvalId,
          decision: 'approved',
          resolvedAt: new Date(),
          messageIds: [opened.messageId],
        }),
      }),
    ).toBeNull();
    expect((await outboxOf(pool, hook.id)).map((row) => row.event_type)).toEqual(['approval.expired']);
  });

  it('이벤트의 agent_id 가 전이한 요청의 것과 다르면 던지고 전이째 롤백된다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const other = await seedAgent(pool);
    const otherHook = await registerEndpoint(pool, other);
    const opened = await openApproval(serviceFor(pool), agent);
    const store = createPostgresApprovalStore(pool);

    await expect(
      store.reject({
        approvalId: opened.approvalId,
        decidedBy: 'owner@example.com',
        now: new Date(),
        event: approvalResolvedEvent({
          agentId: other.agentId,
          approvalId: opened.approvalId,
          decision: 'rejected',
          resolvedAt: new Date(),
          messageIds: [opened.messageId],
        }),
      }),
    ).rejects.toThrow(/agent_id/);
    expect((await statusOf(pool, opened.approvalId))?.status).toBe('pending');
    expect(await outboxOf(pool, otherHook.id)).toEqual([]);
  });

  it('AC-d3 — TTL 뒤 만료를 두 번 시도해도 `approval.expired` 는 1행이고 SES 는 0회', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const hook = await registerEndpoint(pool, agent);
    const service = serviceFor(pool);
    const opened = await openApproval(service, agent);
    const store = createPostgresApprovalStore(pool);
    const transport = countingTransport();
    const after = new Date(opened.expiresAt.getTime() + 1000);

    // 스위퍼의 **항목 경로**(`expireRequest`)를 두 번 탄다. 전역 스윕(`sweepExpiredRequests`)을 이 시각(+7일)으로
    // 돌리면 병렬로 도는 다른 파일의 대기 요청까지 전부 만료시킨다 — 그래서 표적으로만 돈다. 스윕이 항목마다
    // 이 함수를 부른다는 것은 `service.test.ts` 의 sweep 단언이 본다.
    expect(await expireRequest(store, opened.approvalId, after)).toBe(true);
    expect(await expireRequest(store, opened.approvalId, after)).toBe(false);
    expect((await statusOf(pool, opened.approvalId))?.status).toBe('expired');
    // 만료된 요청의 릴리스 잡이 늦게 와도 관문이 막는다.
    await runApprovalRelease({ service, approvals: store, transport }, { approvalId: opened.approvalId, traceId: null });
    expect(transport.calls()).toBe(0);

    const rows = await outboxOf(pool, hook.id);
    expect(rows.map((row) => row.event_type)).toEqual(['approval.expired']);
    expect(JSON.parse(rows[0]?.body ?? '{}')).toMatchObject({
      data: { approval_id: opened.approvalId, message_ids: [opened.messageId] },
    });
  });

  it('`message.sent` — 발송 확정과 같은 트랜잭션에 1행, 재릴리스·lease 잃은 확정은 행을 늘리지 않는다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const hook = await registerEndpoint(pool, agent);
    const service = serviceFor(pool);
    const opened = await openApproval(service, agent);
    const store = createPostgresApprovalStore(pool);
    const transport = countingTransport();

    // 아직 lease 도 없는 메시지에 대한 확정 — 0행이고 이벤트도 없다(이 시점의 outbox 는 비어 있어야 한다).
    expect(await service.dispatchStore.settleSent(opened.messageId, randomUUID(), 'stray-ses-id', new Date())).toBe(false);
    expect(await outboxOf(pool, hook.id)).toEqual([]);

    await approveRequest(store, {
      approvalId: opened.approvalId,
      decidedBy: 'owner@example.com',
      now: new Date(),
      scope: 'recipient',
      confirmScope: null,
    });
    await runApprovalRelease({ service, approvals: store, transport }, { approvalId: opened.approvalId, traceId: null });
    await runApprovalRelease({ service, approvals: store, transport }, { approvalId: opened.approvalId, traceId: null });
    expect(transport.calls()).toBe(1);
    // lease 를 잃은 워커의 확정 — 0행이고 이벤트도 없다.
    expect(await service.dispatchStore.settleSent(opened.messageId, randomUUID(), 'late-ses-id', new Date())).toBe(false);

    const sent = (await outboxOf(pool, hook.id)).filter((row) => row.event_type === 'message.sent');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? '{}')).toMatchObject({ agent_id: agent.agentId, data: { message_id: opened.messageId } });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/approvals/{id}
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('GET /v1/approvals/{id} — 자기 에이전트의 요청만', () => {
  it('자기 것 200 · 남의 것 403 · 없음 404 · 형식 400 · 토큰 없음 401', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const stranger = await seedAgent(pool);
    const opened = await openApproval(serviceFor(pool), agent);
    const deps = { tokens: createPostgresAgentTokenStore(pool), approvals: createPostgresApprovalStore(pool), now: () => new Date() };

    const own = await handleGetApproval(deps, bearer(agent.token), { approvalId: opened.approvalId });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({
      id: opened.approvalId,
      agent_id: agent.agentId,
      kind: 'message',
      status: 'pending',
      expires_at: opened.expiresAt.toISOString(),
      decided_at: null,
      message_ids: [opened.messageId],
    });
    // 얇은 응답 — 수신자·결정자가 없다.
    expect(JSON.stringify(own.body)).not.toContain('@');

    const theirs = await handleGetApproval(deps, bearer(stranger.token), { approvalId: opened.approvalId });
    expect(theirs.status).toBe(403);
    expect(theirs.body).not.toHaveProperty('status');

    expect((await handleGetApproval(deps, bearer(agent.token), { approvalId: randomUUID() })).status).toBe(404);
    expect((await handleGetApproval(deps, bearer(agent.token), { approvalId: 'apr_123' })).status).toBe(400);
    expect(
      (await handleGetApproval(deps, { headers: {}, query: {}, body: null }, { approvalId: opened.approvalId })).status,
    ).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/agents/{id}/policy — AC-a1
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('GET /v1/agents/{id}/policy — AC-a1 (정책 v2 재정의, ADR-0007)', () => {
  it('AC-a1 — 프로비저닝 직후의 에이전트가 자기 정책을 읽으면 발신 화이트리스트(빈 목록)·수신 전체다', async () => {
    const pool = testPool();
    const suffix = randomBytes(4).toString('hex');
    const provisioned = await provisionAgent(
      createPostgresProvisioningStore(provisioningPool()),
      {
        organization: { kind: 'create', name: `t1-a1-${suffix}`, ownerEmail: 'owner@example.com' },
        agentName: `t1-a1-${suffix}`,
        addressLocalPart: `t1-a1-${suffix}`,
        seedContacts: [],
        monthlyBudgetCents: 1000,
        createdBy: 'test:t1',
        tokenCapabilities: null,
        outboundMode: null,
      },
      testKeyCustody(),
    );
    const response = await handleGetAgentPolicy(
      {
        tokens: createPostgresAgentTokenStore(pool),
        policies: createPostgresPolicySource(pool),
        inboundPolicies: createPostgresInboundPolicySource(pool),
        now: () => new Date(),
      },
      bearer(provisioned.token.plaintext),
      { agentId: provisioned.agent.id },
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      agent_id: provisioned.agent.id,
      outbound_mode: 'allowlist_only',
      inbound_mode: 'all',
      policy_version: 1,
      outbound: { mode: 'allowlist', allow: [], block_count: 0 },
      inbound: { mode: 'all', allow: [], block_count: 0 },
    });
    // 레거시 승인 값은 레거시 모드에서만 싣는다.
    expect(response.body).not.toHaveProperty('approval_ttl_seconds');
  });

  it('남의 에이전트는 403 — **정책을 읽기 전에** 막는다(존재 여부도 새지 않는다)', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const stranger = await seedAgent(pool);
    let loads = 0;
    const counting: PolicySource = {
      load: (query) => {
        loads += 1;
        return createPostgresPolicySource(pool).load(query);
      },
    };
    const deps = {
      tokens: createPostgresAgentTokenStore(pool),
      policies: counting,
      inboundPolicies: createPostgresInboundPolicySource(pool),
      now: () => new Date(),
    };

    expect((await handleGetAgentPolicy(deps, bearer(stranger.token), { agentId: agent.agentId })).status).toBe(403);
    expect(
      (await handleGetAgentPolicy(deps, bearer(stranger.token), { agentId: toAgentId(randomBytes(16).toString('hex')) }))
        .status,
    ).toBe(403);
    expect(loads).toBe(0);
    expect((await handleGetAgentPolicy(deps, bearer(agent.token), { agentId: 'not-hex' })).status).toBe(400);
    expect((await handleGetAgentPolicy(deps, bearer(agent.token), { agentId: agent.agentId })).status).toBe(200);
    expect(loads).toBe(1);
  });

  it('한도는 관문이 쓰는 값 — limits = min(정책, 요금제) · 정책 값은 policy_limits · 요금제 코드(ADR-0011, L6)', async () => {
    const pool = testPool();
    const deps = {
      tokens: createPostgresAgentTokenStore(pool),
      policies: createPostgresPolicySource(pool),
      inboundPolicies: createPostgresInboundPolicySource(pool),
      now: () => new Date(),
    };
    // 정책: per_minute 100 · per_day 5000 · 수신자 20. Free(행 없음): 5 · 100 · 10 — 요금제가 묶는다.
    const free = await seedAgent(pool, {}, null);
    const freeView = await handleGetAgentPolicy(deps, bearer(free.token), { agentId: free.agentId });
    expect(freeView.status).toBe(200);
    expect(freeView.body).toMatchObject({
      plan: 'free',
      limits: {
        per_minute: PLAN_CATALOG.free.agentPerMinuteMax,
        per_hour: 1000,
        per_day: PLAN_CATALOG.free.agentPerDayMax,
        recipients_per_message: PLAN_CATALOG.free.recipientsPerMessageMax,
      },
      policy_limits: { per_minute: 100, per_hour: 1000, per_day: 5000, recipients_per_message: 20 },
    });
    expect((freeView.body['limits'] as Record<string, number>)['org_daily_recipients']).toBeLessThanOrEqual(PLAN_CATALOG.free.orgDailyRecipients);
    // beta: 요금제가 넓다 — 정책 값이 묶는다.
    const beta = await seedAgent(pool);
    const betaView = await handleGetAgentPolicy(deps, bearer(beta.token), { agentId: beta.agentId });
    expect(betaView.body).toMatchObject({ plan: 'beta', limits: { per_minute: 100, per_hour: 1000, per_day: 5000, recipients_per_message: 20 } });
  });

  it('해석할 수 없는 정책(pre-approval 플래그의 모양 오류)은 409 — 모드만 골라 200 으로 보여 주지 않는다', async () => {
    // P3b 에서 `auto_approve_verification_senders: true` 는 해석 가능한 정책이 됐다(로더가 ON 을 허용한다).
    // 해석 불가의 대표로 같은 플래그의 **모양 오류**를 쓴다 — 기본값으로 떨어지지 않고 던져야 한다.
    const pool = testPool();
    const agent = await seedAgent(pool, { auto_approve_verification_senders: 'true' });
    const response = await handleGetAgentPolicy(
      {
        tokens: createPostgresAgentTokenStore(pool),
        policies: createPostgresPolicySource(pool),
        inboundPolicies: createPostgresInboundPolicySource(pool),
        now: () => new Date(),
      },
      bearer(agent.token),
      { agentId: agent.agentId },
    );
    expect(response.status).toBe(409);
    expect(response.body['error']).toBe('policy_unevaluable');
  });
});

// ---------------------------------------------------------------------------
// 웹훅 엔드포인트 — 시크릿 1회 노출, 그 시크릿이 실제 전달을 검증한다
// ---------------------------------------------------------------------------

/** 이 엔드포인트의 행만 집는 outbox — 병렬 테스트의 행을 가로채지 않는다(머리말). */
function scopedOutbox(pool: Pool, endpointId: string): WebhookOutboxPort {
  const real = createPostgresWebhookOutbox(pool);
  return {
    markDelivered: real.markDelivered,
    scheduleRetry: real.scheduleRetry,
    markDead: real.markDead,
    async claimDue(now: Date, limit: number, leaseMs: number): Promise<readonly ClaimedDelivery[]> {
      const result = await pool.query<{
        id: string;
        event_id: string;
        body: string;
        attempt_count: number;
        endpoint_id: string;
        url: string;
        secret_kid: string;
        secret_version: number;
        disabled: boolean;
      }>(
        `UPDATE webhook_deliveries d
            SET attempt_count = d.attempt_count + 1,
                next_attempt_at = $2::timestamptz + ($4::integer * interval '1 millisecond')
           FROM webhook_endpoints e
          WHERE d.id IN (SELECT id FROM webhook_deliveries
                          WHERE endpoint_id = $1 AND status = 'pending' AND next_attempt_at <= $2
                          ORDER BY next_attempt_at LIMIT $3)
            AND e.id = d.endpoint_id
         RETURNING d.id, d.event_id, d.body, d.attempt_count, e.id AS endpoint_id, e.url, e.secret_kid,
                   e.secret_version, (e.disabled_at IS NOT NULL) AS disabled`,
        [endpointId, now, limit, leaseMs],
      );
      return result.rows.map((row) => ({
        deliveryId: row.id,
        eventId: row.event_id,
        body: row.body,
        attempt: row.attempt_count,
        endpoint: {
          id: row.endpoint_id,
          url: row.url,
          secretKid: row.secret_kid,
          secretVersion: row.secret_version,
          disabled: row.disabled,
        },
      }));
    },
  };
}

describe.skipIf(!DATABASE_AVAILABLE)('웹훅 엔드포인트 등록 — 시크릿은 한 번만', () => {
  it('등록 응답에만 시크릿이 있고, 목록에는 없다 — 그 시크릿이 디스패처가 보낸 실제 요청의 서명을 검증한다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const hook = await registerEndpoint(pool, agent);
    expect(hook.secret).toMatch(/^whsec_/);

    const listed = await handleListWebhookEndpoints(webhookDeps(pool), bearer(agent.token), { agentId: agent.agentId });
    expect(listed.status).toBe(200);
    expect(listed.body['endpoints']).toEqual([expect.objectContaining({ id: hook.id }) as unknown]);
    const listedJson = JSON.stringify(listed.body);
    expect(listedJson).not.toContain('whsec_');
    expect(listedJson).not.toContain(hook.secret.slice('whsec_'.length, 20));

    // 실제 전이가 만든 이벤트를 워커가 보낸다 — 가짜 전송단이 받은 헤더를 **등록 응답의** 시크릿으로 검증.
    const opened = await openApproval(serviceFor(pool), agent);
    await linkRequest(linkPorts(pool), 'POST', new URLSearchParams({ token: tokenFor(opened), decision: 'reject' }).toString());
    const captured: WebhookHttpRequest[] = [];
    const now = new Date(Date.now() + 1000);
    const reports = await runWebhookDispatcher({
      outbox: scopedOutbox(pool, hook.id),
      resolve: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      transport: {
        post: (request) => {
          captured.push(request);
          return Promise.resolve({ kind: 'response', status: 204 });
        },
      },
      keyring: HOOK_RING,
      now: () => now,
    });
    expect(reports.map((report) => report.outcome)).toEqual(['delivered']);
    const [request] = captured;
    if (request === undefined) throw new Error('전달이 없다');
    expect(
      verifyWebhook(
        hook.secret,
        {
          id: request.headers['webhook-id'] ?? '',
          timestamp: request.headers['webhook-timestamp'] ?? '',
          signature: request.headers['webhook-signature'] ?? '',
        },
        request.body,
        now,
      ),
    ).toEqual({ kind: 'valid' });
    expect(JSON.parse(request.body)).toMatchObject({ type: 'approval.resolved', data: { approval_id: opened.approvalId } });
    expect((await outboxOf(pool, hook.id)).map((row) => row.status)).toEqual(['delivered']);

    // 같은 URL 을 다시 등록하면 **다른** 엔드포인트·다른 시크릿이다(재조회가 아니라 재발급).
    const again = await registerEndpoint(pool, agent);
    expect(again.id).not.toBe(hook.id);
    expect(again.secret).not.toBe(hook.secret);
  });

  it('남의 에이전트 403 · 내부 주소 400 · 모르는 필드 400 · 상한 초과 409', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const stranger = await seedAgent(pool);
    const deps = webhookDeps(pool);
    const target = { agentId: agent.agentId };

    const forbidden = await handleRegisterWebhookEndpoint(deps, bearer(stranger.token, { url: 'https://hooks.example.com/' }), target);
    expect(forbidden.status).toBe(403);
    expect((await handleListWebhookEndpoints(deps, bearer(stranger.token), target)).status).toBe(403);

    const internal = await handleRegisterWebhookEndpoint(deps, bearer(agent.token, { url: 'https://169.254.169.254/' }), target);
    expect(internal).toMatchObject({ status: 400, body: { error: 'invalid_webhook_url' } });
    expect(JSON.stringify(internal.body)).not.toContain('whsec_');

    const extra = await handleRegisterWebhookEndpoint(
      deps,
      bearer(agent.token, { url: 'https://hooks.example.com/', secret: 'whsec_mine' }),
      target,
    );
    expect(extra.status).toBe(400);

    for (let i = 0; i < MAX_WEBHOOK_ENDPOINTS_PER_AGENT; i += 1) await registerEndpoint(pool, agent);
    const over = await handleRegisterWebhookEndpoint(deps, bearer(agent.token, { url: 'https://hooks.example.com/' }), target);
    expect(over).toMatchObject({ status: 409, body: { error: 'webhook_endpoint_limit' } });

    // 요금제(ADR-0011) — 행이 없는 조직(= Free)은 에이전트당 1개. 두 번째가 409(천장 10 이 아니라 요금제가 묶는다).
    const free = await seedAgent(pool, {}, null);
    expect(PLAN_CATALOG.free.webhookEndpointsPerAgentMax).toBe(1);
    await registerEndpoint(pool, free);
    const freeOver = await handleRegisterWebhookEndpoint(deps, bearer(free.token, { url: 'https://hooks.example.com/' }), { agentId: free.agentId });
    expect(freeOver).toMatchObject({ status: 409, body: { error: 'webhook_endpoint_limit' } });
  });

  it('동시 등록이 겹쳐도 요금제 한도를 넘지 않는다 — 세기와 INSERT 가 한 트랜잭션 · 에이전트 잠금 아래(M1)', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const deps = webhookDeps(pool);
    const attempts = MAX_WEBHOOK_ENDPOINTS_PER_AGENT + 4;
    const results = await Promise.all(
      Array.from({ length: attempts }, (_unused, i) =>
        handleRegisterWebhookEndpoint(deps, bearer(agent.token, { url: `https://race-${String(i)}.example.com/` }), { agentId: agent.agentId }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(MAX_WEBHOOK_ENDPOINTS_PER_AGENT);
    expect(results.filter((r) => r.status === 409 && r.body['error'] === 'webhook_endpoint_limit')).toHaveLength(attempts - MAX_WEBHOOK_ENDPOINTS_PER_AGENT);
    expect((await handleListWebhookEndpoints(deps, bearer(agent.token), { agentId: agent.agentId })).body['endpoints']).toHaveLength(
      MAX_WEBHOOK_ENDPOINTS_PER_AGENT,
    );
  });
});
