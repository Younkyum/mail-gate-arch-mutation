/**
 * 고객 도메인 × 승인 릴리스 — 실제 Postgres(ADR-0014 결정 7 · 계획 §3.7 수용 기준 "릴리스"). 스냅샷은 **발송 시점**에 새로 읽는다:
 *
 *   ① 승인 뒤 도메인이 정지(dkim_failed)되면 릴리스는 **즉시 종결**(`release_denied:domain_suspended`) — SES 0, 사람의 승인은 그대로.
 *   ② 승인 뒤 요금제 강등(plan_limit)이면 **미룬다**(`domain_plan_limit`) — 창 안에서 풀리면 같은 봉투가 나가고, 그때 도메인 워밍업 시계가
 *      **한 번** 적힌다(`settleSent` 커밋 뒤 `atmark_mark_domain_sending_started` — 두 번째 발송은 시계를 바꾸지 않는다).
 *   ③ 승인 대기 중 From 별칭이 폐기되면 릴리스는 `release_denied:from_inactive`(위조가 아니다 — ADR-0014 개정).
 *   ④ atmark.ai 발신의 발송 확정은 고객 도메인 시계를 건드리지 않는다(질의 0).
 *   ⑤ 시계 칸은 앱 롤이 직접 쓰지 못한다(42501) — 정의자 함수 하나만 쓴다.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { createInMemoryContentStore } from '../../../src/api/content-store';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import { finalizeOutbound, gateDependenciesFor, prepareOutbound, type OutboundOutcome, type OutboundServiceDependencies } from '../../../src/api/outbound-service';
import { approveRequest, type ApprovalStore } from '../../../src/approval/service';
import { createPostgresApprovalStore, createPostgresGateStores } from '../../../src/db/repositories';
import { toAgentId, type AgentId } from '../../../src/db/schema';
import { markDomainSendingStarted } from '../../../src/db/repositories/sending-clock';
import { dispatch } from '../../../src/policy/gate';
import { runApprovalRelease, type ApprovalReleaseOutcome } from '../../../src/workers/approval-release';
import { grantPlan } from '../../support/entitlements';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, testPool } from '../db/support/harness';
import { countingTransport } from '../outbound/support/fakes';
import { addAlias, liftDomain, OWNER_URL, retireAddress, suspendDomain, verifiedCustomDomain } from './support';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';

const AVAILABLE = DATABASE_AVAILABLE && OWNER_URL.trim() !== '';
const OWNER = 'owner@example.com';

afterAll(async () => {
  if (AVAILABLE) await closeTestPool();
});

interface ReleaseFixture {
  readonly agentId: AgentId;
  readonly organizationId: string;
  readonly primary: string;
}

/** 승인 필수 모드 에이전트(atmark.ai 대표) — `approval-flow.test.ts` 의 지반과 같은 한도(beta). */
async function seedApprovalAgent(): Promise<ReleaseFixture> {
  const owner = provisioningPool();
  const agentId = toAgentId(randomBytes(16).toString('hex'));
  const primary = `dr-${agentId.slice(0, 10)}@atmark.ai`;
  const org = await owner.query<{ id: string }>(`INSERT INTO organizations (name, billing_status, sending_started_at) VALUES ($1, 'active', '2026-01-01') RETURNING id`, [
    `dr-org-${agentId.slice(0, 8)}`,
  ]);
  const organizationId = org.rows[0]?.id as string;
  await grantPlan(owner, organizationId, 'beta');
  await owner.query(`INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, $3, 'active', 'free', 100000)`, [
    agentId,
    organizationId,
    `dr-agent-${agentId.slice(0, 8)}`,
  ]);
  await owner.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', true)`, [agentId, primary]);
  const limits = { per_minute: 100, per_hour: 1000, per_day: 5000, recipients_per_message: 20 };
  const config = { allowlist: [], blocklist: [], max_attachment_bytes_total: 10_000_000, allowed_mime_types: ['text/plain'] };
  await owner.query(
    `INSERT INTO agent_policies (agent_id, outbound_mode, limits, config_json, current_version) VALUES ($1, 'approval_required', $2::jsonb, $3::jsonb, 1)`,
    [agentId, JSON.stringify(limits), JSON.stringify(config)],
  );
  await owner.query(`INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot) VALUES ($1, 1, 'approval_required', $2::jsonb)`, [
    agentId,
    JSON.stringify({ outbound_mode: 'approval_required', limits, config_json: config }),
  ]);
  return { agentId, organizationId, primary };
}

interface Harness {
  readonly service: OutboundServiceDependencies;
  readonly transport: ReturnType<typeof countingTransport>;
  readonly approvals: ApprovalStore;
  readonly clock: { now: Date };
}

function harnessFor(pool: Pool): Harness {
  const stores = createPostgresGateStores(pool);
  const clock = { now: new Date() };
  return {
    clock,
    transport: countingTransport(),
    approvals: createPostgresApprovalStore(pool),
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
  };
}

async function send(h: Harness, agentId: AgentId, from: string, recipient: string): Promise<OutboundOutcome> {
  const prepared = await prepareOutbound(h.service, {
    routeId: 'send',
    agentId,
    idempotencyKey: randomUUID(),
    fromAddress: from,
    recipients: [recipient],
    subject: 'domain release',
    text: '도메인 릴리스',
    html: null,
    isThreadReply: false,
    traceId: null,
    costCents: 0,
  });
  if (prepared.kind !== 'ready') throw new Error(`ready 여야 한다: ${prepared.outcome.kind}`);
  return finalizeOutbound(h.service, prepared, await dispatch(gateDependenciesFor(h.service, h.transport), prepared.dispatchRequest));
}

/** 보내고(승인 대기) 승인한다. 승인 id. */
async function sendAndApprove(h: Harness, agentId: AgentId, from: string, recipient: string): Promise<string> {
  const outcome = await send(h, agentId, from, recipient);
  if (outcome.kind !== 'pending_approval' || outcome.approval === null) throw new Error(`승인 대기여야 한다: ${outcome.kind}`);
  const approvalId = outcome.approval.approvalId;
  await approveRequest(h.approvals, { approvalId, decidedBy: OWNER, now: h.clock.now, scope: 'recipient', confirmScope: null });
  return approvalId;
}

const release = (h: Harness, approvalId: string): Promise<readonly ApprovalReleaseOutcome[]> =>
  runApprovalRelease({ service: h.service, approvals: h.approvals, transport: h.transport }, { approvalId, traceId: null });

async function resolutionOf(pool: Pool, agentId: string): Promise<{ decision: string; resolution_reason: string | null; reasons: string[] }[]> {
  return (
    await pool.query<{ decision: string; resolution_reason: string | null; reasons: string[] }>(
      'SELECT decision, resolution_reason, reasons FROM audit_logs WHERE agent_id = $1 ORDER BY created_at, id',
      [agentId],
    )
  ).rows;
}

const domainClock = async (domainId: string): Promise<Date | null> =>
  (await provisioningPool().query<{ at: Date | null }>('SELECT sending_started_at AS at FROM custom_domains WHERE id = $1', [domainId])).rows[0]?.at ?? null;

describe.skipIf(!AVAILABLE)('고객 도메인 × 승인 릴리스', () => {
  it('① 승인 뒤 도메인 정지(dkim_failed) → 즉시 종결 release_denied:domain_suspended · SES 0 · 승인은 그대로', async () => {
    const pool = testPool();
    const f = await seedApprovalAgent();
    const { id, domain } = await verifiedCustomDomain(f.organizationId);
    const alias = `bot@${domain}`;
    await addAlias(f.agentId, alias);
    const h = harnessFor(pool);
    const approvalId = await sendAndApprove(h, f.agentId, alias, 'partner@example.com');
    await suspendDomain(id, 'dkim_failed');

    const released = await release(h, approvalId);
    expect(released.map((outcome) => outcome.kind)).toEqual(['denied']);
    expect(h.transport.calls()).toBe(0);
    expect(await resolutionOf(pool, f.agentId)).toEqual([expect.objectContaining({ decision: 'denied', resolution_reason: 'release_denied:domain_suspended' })]);
    expect((await pool.query<{ status: string }>('SELECT status FROM approval_requests WHERE id = $1', [approvalId])).rows[0]?.status).toBe('approved');
    // 정지가 풀려도 종결된 봉투는 다시 나가지 않는다(정지의 뜻 — 밀린 승인분이 한꺼번에 나가지 않는다).
    await liftDomain(id);
    expect(await release(h, approvalId)).toEqual([]);
    expect(h.transport.calls()).toBe(0);
  });

  it('② 승인 뒤 plan_limit → 미룸(domain_plan_limit) · 풀린 뒤 같은 봉투가 나가고 도메인 시계가 한 번 적힌다', async () => {
    const pool = testPool();
    const f = await seedApprovalAgent();
    const { id, domain } = await verifiedCustomDomain(f.organizationId);
    const alias = `bot@${domain}`;
    await addAlias(f.agentId, alias);
    const h = harnessFor(pool);
    const approvalId = await sendAndApprove(h, f.agentId, alias, 'partner@example.com');
    await suspendDomain(id, 'plan_limit');

    const first = await release(h, approvalId);
    expect(first.map((outcome) => outcome.kind)).toEqual(['deferred']);
    const deferred = first[0] as Extract<ApprovalReleaseOutcome, { kind: 'deferred' }>;
    expect(deferred.reason).toBe('domain_plan_limit');
    expect(h.transport.calls()).toBe(0);
    expect(await domainClock(id)).toBeNull();

    await liftDomain(id);
    h.clock.now = new Date(deferred.retryAt.getTime() + 1000);
    const second = await release(h, approvalId);
    expect(second.map((outcome) => outcome.kind)).toEqual(['sent']);
    expect(h.transport.calls()).toBe(1);
    const started = await domainClock(id);
    expect(started).not.toBeNull();

    // 두 번째 발송 — 시계는 그대로(한 번 쓰기).
    const again = await sendAndApprove(h, f.agentId, alias, 'partner2@example.com');
    expect((await release(h, again)).map((outcome) => outcome.kind)).toEqual(['sent']);
    expect((await domainClock(id))?.getTime()).toBe(started?.getTime());
  });

  it('③ 승인 대기 중 From 별칭 폐기 → release_denied:from_inactive(위조 아님)', async () => {
    const pool = testPool();
    const f = await seedApprovalAgent();
    const alias = `old-${randomBytes(3).toString('hex')}@atmark.ai`;
    await addAlias(f.agentId, alias);
    const h = harnessFor(pool);
    const approvalId = await sendAndApprove(h, f.agentId, alias, 'partner@example.com');
    await retireAddress(alias);
    expect((await release(h, approvalId)).map((outcome) => outcome.kind)).toEqual(['denied']);
    expect(h.transport.calls()).toBe(0);
    expect(await resolutionOf(pool, f.agentId)).toEqual([expect.objectContaining({ decision: 'denied', resolution_reason: 'release_denied:from_inactive' })]);
  });

  it('④ atmark.ai 발신의 발송 확정은 고객 도메인 시계를 건드리지 않는다', async () => {
    const pool = testPool();
    const f = await seedApprovalAgent();
    const { id } = await verifiedCustomDomain(f.organizationId);
    const h = harnessFor(pool);
    const approvalId = await sendAndApprove(h, f.agentId, f.primary, 'partner@example.com');
    expect((await release(h, approvalId)).map((outcome) => outcome.kind)).toEqual(['sent']);
    expect(await domainClock(id)).toBeNull();
  });

  it('⑤ 시계 — atmark.ai 발신은 질의하지 않는다 · 앱 롤은 sending_started_at 을 직접 쓰지 못한다(42501)', async () => {
    const seen: string[] = [];
    const recorder = { query: (text: string) => (seen.push(text), Promise.resolve({ rows: [], rowCount: 0 })) } as unknown as Parameters<typeof markDomainSendingStarted>[0];
    expect(await markDomainSendingStarted(recorder, randomUUID(), 'atmark.ai')).toBe(false);
    expect(seen).toEqual([]);
    await markDomainSendingStarted(recorder, randomUUID(), 'agents.example.com');
    expect(seen).toEqual(['SELECT atmark_mark_domain_sending_started($1::uuid) AS marked']);
    const code = await testPool()
      .query('UPDATE custom_domains SET sending_started_at = now() WHERE false')
      .then(() => 'ok', (error: { code?: string }) => error.code ?? 'no-code');
    expect(code).toBe('42501');
  });
});
