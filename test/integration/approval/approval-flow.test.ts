/**
 * **P2 승인 결정 경로 — 실제 Postgres 위에서** (계획 §3.1 · §3.4 · §4.3 · AC-a1~a4 · AC-d2 · AC-d5).
 *
 * 인메모리 테스트(`test/unit/policy/stage7-approval.test.ts`·`gate-approval.test.ts`)는 판정과 배선을
 * 본다. 여기서 보는 것은 **DB 가 있어야만 참인 것들**이다 — 조건부 UPDATE 의 no-op, 트리거가 막는
 * 종단 상태, TTL 을 넘긴 승인을 거부하는 CHECK, 한 트랜잭션으로 닫히는 세 테이블, 그리고
 * "릴리스는 새 행을 만들지 않고 같은 행을 갱신한다" 가 **실제 audit_logs 에서** 성립하는지.
 *
 * **`TEST_DATABASE_URL` 이 없으면 통째로 건너뛴다** — 다른 통합 층과 같은 환경 게이트다.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { grantPlan } from '../../support/entitlements';
import { afterAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createInMemoryContentStore } from '../../../src/api/content-store';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import {
  finalizeOutbound,
  gateDependenciesFor,
  prepareOutbound,
  type OutboundOutcome,
  type OutboundServiceDependencies,
} from '../../../src/api/outbound-service';
import { createPostgresProvisioningStore } from '../../../src/api/provisioning-store';
import { handleSend } from '../../../src/api/routes/send';
import {
  approveRequest,
  DomainScopeConfirmationRequiredError,
  rejectRequest,
  sweepExpiredRequests,
  type ApprovalStore,
} from '../../../src/approval/service';
import { createPostgresAgentTokenStore, createPostgresApprovalStore, createPostgresGateStores } from '../../../src/db/repositories';
import { toAgentId, type AgentId, type OutboundMode } from '../../../src/db/schema';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { provisionAgent } from '../../../src/identity/provisioning';
import { dispatch } from '../../../src/policy/gate';
import { runApprovalRelease, type ApprovalReleaseOutcome } from '../../../src/workers/approval-release';
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

const OWNER = 'owner@example.com';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// 지반
// ---------------------------------------------------------------------------

interface ApprovalFixture {
  readonly agentId: AgentId;
  readonly address: string;
  readonly organizationId: string;
}

/**
 * 한 시나리오의 뿌리 — 모드·seed·에이전트 생성 시각을 고른다.
 *
 * `seedFixture`(P1 공용)를 쓰지 않는 이유: 그 픽스처는 `allowlist_only` 로 고정이고 에이전트
 * `created_at` 을 고를 수 없다(grace 14일 경계를 재현할 수 없다). 한도는 넉넉히 둔다 —
 * 11건을 1분 안에 보내는 시나리오(AC-a3)가 Stage 4 에 먼저 걸리면 Stage 7 을 보지 못한다.
 */
async function seedApprovalFixture(
  pool: Pool,
  options: {
    readonly mode: OutboundMode;
    readonly seeds?: readonly string[];
    readonly agentCreatedAt?: Date;
    readonly config?: Record<string, unknown>;
  },
): Promise<ApprovalFixture> {
  const agentId = toAgentId(randomBytes(16).toString('hex'));
  const address = `p2-${agentId.slice(0, 16)}@atmark.ai`;
  const org = await provisioningPool().query<{ id: string }>(
    `INSERT INTO organizations (name, billing_status) VALUES ($1, 'active') RETURNING id`,
    [`p2-org-${agentId.slice(0, 8)}`],
  );
  const organizationId = org.rows[0]?.id as string;
  // 요금제(ADR-0011) — 이 파일의 한도(per_minute 100 · 수신자 20)는 도입 전 한도(beta)를 전제로 쓴 것이다.
  await grantPlan(provisioningPool(), organizationId, 'beta');
  await provisioningPool().query(
    `INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents, created_at)
     VALUES ($1, $2, $3, 'active', 'free', 100000, $4)`,
    [agentId, organizationId, `p2-agent-${agentId.slice(0, 8)}`, options.agentCreatedAt ?? new Date()],
  );
  await provisioningPool().query(
    `INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', true)`,
    [agentId, address],
  );
  const limits = { per_minute: 100, per_hour: 1000, per_day: 5000, recipients_per_message: 20 };
  const config = {
    allowlist: [],
    blocklist: [],
    max_attachment_bytes_total: 10_000_000,
    allowed_mime_types: ['text/plain'],
    ...options.config,
  };
  await provisioningPool().query(
    `INSERT INTO agent_policies (agent_id, outbound_mode, limits, config_json, current_version)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, 1)`,
    [agentId, options.mode, JSON.stringify(limits), JSON.stringify(config)],
  );
  await provisioningPool().query(
    `INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot) VALUES ($1, 1, $2, $3::jsonb)`,
    [agentId, options.mode, JSON.stringify({ outbound_mode: options.mode, limits, config_json: config })],
  );
  for (const seed of options.seeds ?? []) {
    await provisioningPool().query(
      `INSERT INTO sender_relationships (agent_id, scope, address, trust_category, granted_by)
       VALUES ($1, 'recipient', $2, 'seed', 'owner_provisioning')`,
      [agentId, seed],
    );
  }
  return { agentId, address, organizationId };
}

interface Harness {
  readonly service: OutboundServiceDependencies;
  readonly transport: ReturnType<typeof countingTransport>;
  readonly approvals: ApprovalStore;
  /** 서비스 시계. 테스트가 옮긴다(TTL 경계). */
  readonly clock: { now: Date };
}

function harnessFor(pool: Pool, start: Date = new Date()): Harness {
  const stores = createPostgresGateStores(pool);
  const clock = { now: start };
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

async function send(
  h: Harness,
  fixture: ApprovalFixture,
  recipient: string,
  key: string = randomUUID(),
): Promise<OutboundOutcome> {
  const prepared = await prepareOutbound(h.service, {
    routeId: 'send',
    agentId: fixture.agentId,
    idempotencyKey: key,
    fromAddress: fixture.address,
    recipients: [recipient],
    subject: 'P2 approval flow',
    text: '승인 경로',
    html: null,
    isThreadReply: false,
    traceId: null,
    costCents: 0,
  });
  if (prepared.kind !== 'ready') throw new Error(`ready 여야 한다: ${prepared.outcome.kind}`);
  const outcome = await dispatch(gateDependenciesFor(h.service, h.transport), prepared.dispatchRequest);
  return finalizeOutbound(h.service, prepared, outcome);
}

function approvalIdOf(outcome: OutboundOutcome): string {
  if (outcome.kind !== 'pending_approval' || outcome.approval === null) {
    throw new Error(`승인 대기여야 한다: ${outcome.kind}`);
  }
  return outcome.approval.approvalId;
}

function release(h: Harness, approvalId: string): Promise<readonly ApprovalReleaseOutcome[]> {
  return runApprovalRelease(
    { service: h.service, approvals: h.approvals, transport: h.transport },
    { approvalId, traceId: null },
  );
}

interface AuditRow {
  id: string;
  message_id: string | null;
  decision: string;
  reasons: string[];
  policy_version: number | null;
  policy_version_id: string | null;
  approval_id: string | null;
  approved_by: string | null;
  resolved_at: Date | null;
  resolution_reason: string | null;
  bootstrap_grace_remaining: number | null;
}

async function auditRows(pool: Pool, agentId: string): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    `SELECT id, message_id, decision, reasons, policy_version, policy_version_id, approval_id, approved_by,
            resolved_at, resolution_reason, bootstrap_grace_remaining
       FROM audit_logs WHERE agent_id = $1 ORDER BY created_at, id`,
    [agentId],
  );
  return result.rows;
}

async function approvalStatus(pool: Pool, approvalId: string): Promise<string | undefined> {
  const result = await pool.query<{ status: string }>('SELECT status FROM approval_requests WHERE id = $1', [approvalId]);
  return result.rows[0]?.status;
}

async function messageStatus(pool: Pool, messageId: string): Promise<string | undefined> {
  const result = await pool.query<{ status: string }>('SELECT status FROM messages WHERE id = $1', [messageId]);
  return result.rows[0]?.status;
}

/** DB 오류의 SQLSTATE. 트리거·CHECK 는 23514 로 통일돼 있다. */
async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

// ---------------------------------------------------------------------------
// AC-a1 · AC-a2 — 기본 모드와 seed
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('AC-a1 · AC-a2 — 프로비저닝 기본값과 seed 관계', () => {
  it('AC-a1(정책 v2 재정의, ADR-0007) — 프로비저닝된 에이전트의 정책 행·스냅샷이 둘 다 `allowlist_only`·수신 `all` 이고 seed 는 발신 allow 다', async () => {
    const pool = testPool();
    const suffix = randomBytes(4).toString('hex');
    const provisioned = await provisionAgent(
      createPostgresProvisioningStore(provisioningPool()),
      {
        organization: { kind: 'create', name: `p2-a1-${suffix}`, ownerEmail: OWNER },
        agentName: `p2-a1-${suffix}`,
        addressLocalPart: `p2-a1-${suffix}`,
        seedContacts: ['Seed+Tag@Example.com'],
        monthlyBudgetCents: 1000,
        createdBy: 'test:p2',
        tokenCapabilities: null,
        outboundMode: null,
      },
      testKeyCustody(),
    );

    const policy = await pool.query<{ outbound_mode: string; inbound_mode: string }>(
      'SELECT outbound_mode, inbound_mode FROM agent_policies WHERE agent_id = $1',
      [provisioned.agent.id],
    );
    expect(policy.rows[0]).toEqual({ outbound_mode: 'allowlist_only', inbound_mode: 'all' });
    expect(provisioned.policyVersion.outbound_mode).toBe('allowlist_only');
    expect(provisioned.policyVersion.inbound_mode).toBe('all');
    const allow = await pool.query<{ value: string }>(
      `SELECT value FROM agent_contact_rules WHERE agent_id = $1 AND direction = 'outbound' AND list = 'allow' AND removed_at IS NULL`,
      [provisioned.agent.id],
    );
    expect(allow.rows).toEqual([{ value: 'seed+tag@example.com' }]);

    // seed 는 **같은 트랜잭션에서** 관계 1행이 됐다 — 허용 비교형(소문자, `+tag` 보존)으로. 소유자가 적은 주소 그대로다.
    const seeds = await pool.query<{ address: string; trust_category: string; granted_by: string }>(
      'SELECT address, trust_category, granted_by FROM sender_relationships WHERE agent_id = $1',
      [provisioned.agent.id],
    );
    expect(seeds.rows).toEqual([{ address: 'seed+tag@example.com', trust_category: 'seed', granted_by: 'owner_provisioning' }]);
  });

  it('AC-a1(정책 v2) — DB 기본값도 발신 `allowlist_only`·수신 `all` 이다(모드를 적지 않은 INSERT)', async () => {
    const pool = testPool();
    const fixture = await seedApprovalFixture(pool, { mode: 'allowlist_only' });
    const agentId = toAgentId(randomBytes(16).toString('hex'));
    await provisioningPool().query(
      `INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents)
       VALUES ($1, $2, 'p2-default', 'provisioning', 'free', 0)`,
      [agentId, fixture.organizationId],
    );
    const inserted = await provisioningPool().query<{ outbound_mode: string; inbound_mode: string }>(
      `INSERT INTO agent_policies (agent_id) VALUES ($1) RETURNING outbound_mode, inbound_mode`,
      [agentId],
    );
    expect(inserted.rows[0]).toEqual({ outbound_mode: 'allowlist_only', inbound_mode: 'all' });

    // **기존 행은 건드리지 않았다** — 명시적으로 allowlist_only 로 만든 에이전트는 그대로다.
    const existing = await pool.query<{ outbound_mode: string }>(
      'SELECT outbound_mode FROM agent_policies WHERE agent_id = $1',
      [fixture.agentId],
    );
    expect(existing.rows[0]?.outbound_mode).toBe('allowlist_only');
  });

  it('AC-a2 — seed 로의 첫 발송은 승인 없이 allowed, audit reasons ∋ `seed_relationship`', async () => {
    const pool = testPool();
    const fixture = await seedApprovalFixture(pool, { mode: 'approval_required', seeds: ['seed@example.com'] });
    const h = harnessFor(pool);

    // 저장된 seed 는 소문자 값이고, 시도는 대소문자만 다르다 — 같은 상대다.
    const outcome = await send(h, fixture, 'Seed@Example.com');

    expect(outcome.kind).toBe('sent');
    expect(h.transport.calls()).toBe(1);
    const rows = await auditRows(pool, fixture.agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reasons).toContain('seed_relationship');
    expect(rows[0]?.approval_id).toBeNull();
    const requests = await pool.query('SELECT 1 FROM approval_requests WHERE agent_id = $1', [fixture.agentId]);
    expect(requests.rowCount).toBe(0);
  });

  it('허용은 좁게 — `seed@` 의 seed 는 `seed+x@` 를 덮지 않는다: 승인 대기, SES 0회 (V1 MINOR-2)', async () => {
    const pool = testPool();
    const fixture = await seedApprovalFixture(pool, { mode: 'approval_required', seeds: ['seed@example.com'] });
    const h = harnessFor(pool);

    const outcome = await send(h, fixture, 'Seed+x@Example.com');
    expect(outcome.kind).toBe('pending_approval');
    expect(h.transport.calls()).toBe(0);
    const rows = await auditRows(pool, fixture.agentId);
    expect(rows.map((row) => row.reasons)).toEqual([['new_recipient']]);
  });

  it('승인한 `Sales+EU@` 의 관계는 그 주소만 연다 — `sales@`·`sales+us@` 는 다시 승인을 탄다 (V1 MINOR-2)', async () => {
    const pool = testPool();
    const fixture = await seedApprovalFixture(pool, { mode: 'approval_required' });
    const h = harnessFor(pool);

    const first = await send(h, fixture, 'Sales+EU@Corp.example');
    await approveRequest(h.approvals, {
      approvalId: approvalIdOf(first),
      decidedBy: OWNER,
      now: new Date(),
      scope: 'recipient',
      confirmScope: null,
    });
    const stored = await pool.query<{ address: string }>(
      `SELECT address FROM sender_relationships WHERE agent_id = $1 AND trust_category = 'approved'`,
      [fixture.agentId],
    );
    expect(stored.rows.map((row) => row.address)).toEqual(['sales+eu@corp.example']);

    expect((await send(h, fixture, 'sales+eu@corp.example')).kind).toBe('sent');
    expect((await send(h, fixture, 'sales@corp.example')).kind).toBe('pending_approval');
    expect((await send(h, fixture, 'sales+us@corp.example')).kind).toBe('pending_approval');
  });
});

// ---------------------------------------------------------------------------
// AC-d2 — 승인은 상대방당 1회
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('AC-d2 — 신규 상대 1명과 5턴 → ApprovalRequest 총 1개', () => {
  it('첫 턴만 승인을 타고, 릴리스는 **같은 audit 행**을 갱신하며, 2~5턴은 standing approval 로 통과한다', async () => {
    const pool = testPool();
    const fixture = await seedApprovalFixture(pool, { mode: 'approval_required' });
    const h = harnessFor(pool);
    const partner = 'new-partner@example.com';

    // 턴 1 — 승인 대기. **SES 0회**(API 는 블로킹하지 않는다).
    const first = await send(h, fixture, partner);
    const approvalId = approvalIdOf(first);
    expect(h.transport.calls()).toBe(0);
    expect(await approvalStatus(pool, approvalId)).toBe('pending');

    // 사람의 승인 → standing approval 생성. 승인은 **보내지 않는다.**
    const approved = await approveRequest(h.approvals, {
      approvalId,
      decidedBy: OWNER,
      now: h.clock.now,
      scope: 'recipient',
      confirmScope: null,
    });
    expect(approved.kind).toBe('approved');
    expect(h.transport.calls()).toBe(0);

    // 릴리스 — 관문 재통과 → 발송.
    const released = await release(h, approvalId);
    expect(released.map((outcome) => outcome.kind)).toEqual(['sent']);
    expect(h.transport.calls()).toBe(1);

    // 턴 2~5 — 승인 없이.
    for (let turn = 2; turn <= 5; turn += 1) {
      const outcome = await send(h, fixture, partner);
      expect(outcome.kind).toBe('sent');
      if (outcome.kind === 'sent') expect(outcome.decision.reasons).toEqual(['standing_approval']);
    }
    expect(h.transport.calls()).toBe(5);

    // ★ AC-d2 — 요청은 **1개**.
    const requests = await pool.query('SELECT id FROM approval_requests WHERE agent_id = $1', [fixture.agentId]);
    expect(requests.rowCount).toBe(1);

    // §4.3 — 시도 5건 = audit 5행. 릴리스는 행을 늘리지 않았다.
    const rows = await auditRows(pool, fixture.agentId);
    expect(rows).toHaveLength(5);
    const firstRow = rows.find((row) => row.approval_id === approvalId);
    expect(firstRow).toMatchObject({
      decision: 'allowed',
      approved_by: OWNER,
      resolution_reason: 'sent',
      reasons: ['new_recipient'],
    });
    expect(firstRow?.resolved_at).not.toBeNull();
  });

  it('`policy_version` 은 **최초 평가 시점 값**을 유지한다 — 승인 중 정책이 바뀌어도', async () => {
    const pool = testPool();
    const fixture = await seedApprovalFixture(pool, { mode: 'approval_required' });
    const h = harnessFor(pool);

    const first = await send(h, fixture, 'versioned@example.com');
    const approvalId = approvalIdOf(first);
    const before = (await auditRows(pool, fixture.agentId))[0];
    expect(before?.policy_version).toBe(1);

    // 승인 대기 중에 정책이 v2 로 바뀐다.
    await provisioningPool().query(
      `INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot)
       VALUES ($1, 2, 'approval_required', '{"note":"v2"}'::jsonb)`,
      [fixture.agentId],
    );
    await provisioningPool().query('UPDATE agent_policies SET current_version = 2 WHERE agent_id = $1', [fixture.agentId]);

    await approveRequest(h.approvals, { approvalId, decidedBy: OWNER, now: h.clock.now, scope: 'recipient', confirmScope: null });
    const released = await release(h, approvalId);
    expect(released[0]?.kind).toBe('sent');
    // 재평가 자체는 **현재** 정책(v2)으로 했다 — 관문을 재통과했다는 증거.
    if (released[0]?.kind === 'sent') expect(released[0].decision.policyVersion).toBe(2);

    const rows = await auditRows(pool, fixture.agentId);
    expect(rows).toHaveLength(1);
    // 그런데 audit 행의 판단 근거는 **평가 시점 값** 그대로다(§4.3).
    expect(rows[0]).toMatchObject({
      decision: 'allowed',
      policy_version: 1,
      policy_version_id: before?.policy_version_id,
    });
  });
});

// ---------------------------------------------------------------------------
// 릴리스 재평가 · 거절 · 만료
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('릴리스는 관문을 재통과한다 — 승인은 그 사이의 변화를 이기지 못한다', () => {
  it('승인 뒤 억제 목록에 오른 상대 → 같은 행이 `denied`(release_denied:suppression_list), SES 0', async () => {
    const pool = testPool();
    const fixture = await seedApprovalFixture(pool, { mode: 'approval_required' });
    const h = harnessFor(pool);
    const recipient = 'complains-later@example.com';

    const first = await send(h, fixture, recipient);
    const approvalId = approvalIdOf(first);
    await approveRequest(h.approvals, { approvalId, decidedBy: OWNER, now: h.clock.now, scope: 'recipient', confirmScope: null });

    // 승인과 릴리스 사이에 불만 신고가 들어왔다.
    await provisioningPool().query(
      `INSERT INTO suppression_entries (organization_id, address, domain, source) VALUES ($1, $2, 'example.com', 'complaint')`,
      [fixture.organizationId, recipient],
    );

    const released = await release(h, approvalId);
    expect(released[0]?.kind).toBe('denied');
    expect(h.transport.calls()).toBe(0);

    const rows = await auditRows(pool, fixture.agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      decision: 'denied',
      approved_by: null,
      resolution_reason: 'release_denied:suppression_list',
      reasons: ['new_recipient'],
    });
    expect(await messageStatus(pool, rows[0]?.message_id as string)).toBe('denied');
    // 사람은 승인했다 — 거부한 것은 시스템이다. 둘을 섞지 않는다.
    expect(await approvalStatus(pool, approvalId)).toBe('approved');
  });

  it('거절 → 같은 행이 `denied`/`approval_rejected`, messages `denied`, 이후 릴리스는 아무것도 보내지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedApprovalFixture(pool, { mode: 'approval_required' });
    const h = harnessFor(pool);

    const approvalId = approvalIdOf(await send(h, fixture, 'rejected@example.com'));
    expect(await rejectRequest(h.approvals, { approvalId, decidedBy: OWNER, now: h.clock.now })).toBe(true);
    // 두 번째 거절은 no-op(조건부 UPDATE).
    expect(await rejectRequest(h.approvals, { approvalId, decidedBy: OWNER, now: h.clock.now })).toBe(false);

    const rows = await auditRows(pool, fixture.agentId);
    expect(rows[0]).toMatchObject({ decision: 'denied', resolution_reason: 'approval_rejected' });
    expect(await messageStatus(pool, rows[0]?.message_id as string)).toBe('denied');

    // 거절된 요청에는 **릴리스 일정 자체가 없다**(일정은 `pending → approved` 전이에서만 생긴다) — 릴리스가
    // 관문에 세울 항목이 0이다. 관문의 grant 검사(승인 상태가 아니면 아무것도 쓰지 않는다)는 그 뒤의 2차 방어선이다.
    const released = await release(h, approvalId);
    expect(released).toEqual([]);
    expect(h.transport.calls()).toBe(0);
    const schedule = await pool.query('SELECT 1 FROM approval_releases WHERE approval_id = $1', [approvalId]);
    expect(schedule.rowCount).toBe(0);
    // 거절된 상대와의 관계는 생기지 않았다.
    const relationships = await pool.query('SELECT 1 FROM sender_relationships WHERE agent_id = $1', [fixture.agentId]);
    expect(relationships.rowCount).toBe(0);
  });

  it('**만료는 절대 발송하지 않는다** — TTL 스윕 → expired, 뒤늦은 승인·릴리스 모두 SES 0', async () => {
    const pool = testPool();
    const fixture = await seedApprovalFixture(pool, { mode: 'approval_required' });
    const start = new Date();
    const h = harnessFor(pool, start);

    const approvalId = approvalIdOf(await send(h, fixture, 'too-late@example.com'));

    // TTL(기본 24h) 전의 스윕은 아무것도 만료시키지 않는다.
    const early = await sweepExpiredRequests(h.approvals, new Date(start.getTime() + 23 * HOUR_MS), 100);
    expect(early.expired).not.toContain(approvalId);
    expect(await approvalStatus(pool, approvalId)).toBe('pending');

    const late = new Date(start.getTime() + DAY_MS + 1000);
    const sweep = await sweepExpiredRequests(h.approvals, late, 1000);
    expect(sweep.expired).toContain(approvalId);
    expect(await approvalStatus(pool, approvalId)).toBe('expired');

    const rows = await auditRows(pool, fixture.agentId);
    expect(rows[0]).toMatchObject({ decision: 'denied', resolution_reason: 'approval_expired' });
    expect(rows[0]?.resolved_at).not.toBeNull();
    expect(await messageStatus(pool, rows[0]?.message_id as string)).toBe('denied');

    const afterExpiry = await approveRequest(h.approvals, {
      approvalId,
      decidedBy: OWNER,
      now: late,
      scope: 'recipient',
      confirmScope: null,
    });
    expect(afterExpiry).toEqual({ kind: 'not_pending', status: 'expired' });
    await release(h, approvalId);
    expect(h.transport.calls()).toBe(0);
  });

  it('스위퍼가 아직 안 돌았어도 **TTL 을 넘긴 요청은 승인되지 않는다** — 앱 조건과 DB CHECK 두 겹', async () => {
    const pool = testPool();
    const fixture = await seedApprovalFixture(pool, { mode: 'approval_required', config: { approval_ttl_seconds: 3600 } });
    const start = new Date();
    const h = harnessFor(pool, start);

    const approvalId = approvalIdOf(await send(h, fixture, 'unswept@example.com'));
    const pastTtl = new Date(start.getTime() + HOUR_MS + 1000);

    // 앱 쪽 — 조건부 UPDATE 의 `expires_at > now` 가 0행을 만든다.
    const outcome = await approveRequest(h.approvals, {
      approvalId,
      decidedBy: OWNER,
      now: pastTtl,
      scope: 'recipient',
      confirmScope: null,
    });
    expect(outcome).toEqual({ kind: 'not_pending', status: 'past_ttl' });

    // DB 쪽 — WHERE 를 빠뜨린 코드가 와도 CHECK 가 막는다.
    const state = await sqlState(() =>
      pool.query(
        `UPDATE approval_requests
            SET status = 'approved', decided_at = expires_at + interval '1 second', decided_by = 'x', granted_scope = 'recipient'
          WHERE id = $1`,
        [approvalId],
      ),
    );
    expect(state).toBe('23514');
    expect(await approvalStatus(pool, approvalId)).toBe('pending');
  });

  it('종단 상태는 트리거가 동결한다 — `expired` 를 `approved` 로 되살릴 수 없다', async () => {
    const pool = testPool();
    const fixture = await seedApprovalFixture(pool, { mode: 'approval_required' });
    const start = new Date();
    const h = harnessFor(pool, start);
    const approvalId = approvalIdOf(await send(h, fixture, 'frozen@example.com'));
    await sweepExpiredRequests(h.approvals, new Date(start.getTime() + DAY_MS + 1000), 1000);

    const state = await sqlState(() =>
      pool.query(
        `UPDATE approval_requests SET status = 'approved', decided_by = 'x', granted_scope = 'recipient' WHERE id = $1`,
        [approvalId],
      ),
    );
    expect(state).toBe('23514');
    expect(await approvalStatus(pool, approvalId)).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// AC-d5 — domain 스코프는 소유자 확인 없이 만들 수 없다
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('AC-d5 — domain 스코프 승인', () => {
  it('확인 파라미터 없이는 거부된다 — 서비스(400 의 근거)와 DB CHECK 두 겹', async () => {
    const pool = testPool();
    const fixture = await seedApprovalFixture(pool, { mode: 'approval_required' });
    const h = harnessFor(pool);
    const approvalId = approvalIdOf(await send(h, fixture, 'ceo@partner-corp.io'));

    await expect(
      approveRequest(h.approvals, { approvalId, decidedBy: OWNER, now: h.clock.now, scope: 'domain', confirmScope: null }),
    ).rejects.toThrow(DomainScopeConfirmationRequiredError);
    await expect(
      approveRequest(h.approvals, {
        approvalId,
        decidedBy: OWNER,
        now: h.clock.now,
        scope: 'domain',
        confirmScope: 'recipient',
      }),
    ).rejects.toThrow(DomainScopeConfirmationRequiredError);
    // 거부된 시도는 아무것도 바꾸지 않았다.
    expect(await approvalStatus(pool, approvalId)).toBe('pending');

    const state = await sqlState(() =>
      pool.query(
        `INSERT INTO sender_relationships (agent_id, scope, domain, trust_category, granted_via_approval_id, granted_by)
         VALUES ($1, 'domain', 'partner-corp.io', 'approved', $2, 'sneaky')`,
        [fixture.agentId, approvalId],
      ),
    );
    expect(state).toBe('23514');
  });

  it('확인하면 도메인 관계가 생기고, 같은 도메인의 **다른 사람**도 승인 없이 통과한다', async () => {
    const pool = testPool();
    const fixture = await seedApprovalFixture(pool, { mode: 'approval_required' });
    const h = harnessFor(pool);
    const approvalId = approvalIdOf(await send(h, fixture, 'ceo@partner-corp.io'));

    const approved = await approveRequest(h.approvals, {
      approvalId,
      decidedBy: OWNER,
      now: h.clock.now,
      scope: 'domain',
      confirmScope: 'domain',
    });
    expect(approved.kind).toBe('approved');

    const relationship = await pool.query<{ scope: string; domain: string; domain_scope_confirmed_by: string }>(
      'SELECT scope, domain, domain_scope_confirmed_by FROM sender_relationships WHERE agent_id = $1',
      [fixture.agentId],
    );
    expect(relationship.rows).toEqual([{ scope: 'domain', domain: 'partner-corp.io', domain_scope_confirmed_by: OWNER }]);

    const other = await send(h, fixture, 'cfo@partner-corp.io');
    expect(other.kind).toBe('sent');
    const elsewhere = await send(h, fixture, 'cfo@not-partner.io');
    expect(elsewhere.kind).toBe('pending_approval');
  });
});

// ---------------------------------------------------------------------------
// AC-a3 · AC-a4 — reply_only 의 bootstrap_grace
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('AC-a3 · AC-a4 — reply_only bootstrap_grace (10건 또는 14일)', () => {
  it('9번째 발송의 잔여가 API 응답과 audit 양쪽에서 1이고, 11번째는 거부·SES 0', async () => {
    const pool = testPool();
    const seed = 'grace-seed@example.com';
    const fixture = await seedApprovalFixture(pool, { mode: 'reply_only', seeds: [seed] });
    const h = harnessFor(pool);
    const tokenStore = createPostgresAgentTokenStore(pool);
    const token = issueAgentToken(fixture.agentId);
    await createPostgresAgentTokenStore(provisioningPool()).insert({
      agentId: fixture.agentId,
      tokenHash: token.tokenHash,
      capabilities: token.capabilities,
      expiresAt: null,
    });

    const responses: { status: number; remaining: unknown; reasons: unknown }[] = [];
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      const response = await handleSend(
        { tokens: tokenStore, service: h.service, transport: h.transport },
        {
          headers: { authorization: `Bearer ${token.plaintext}`, 'idempotency-key': `grace-${String(attempt)}-${fixture.agentId}` },
          query: {},
          body: { agent_id: fixture.agentId, from: fixture.address, to: [seed], subject: 'grace', text: 'grace' },
        },
      );
      const decision = response.body['decision'] as { bootstrap_grace_remaining?: unknown; reasons?: unknown } | undefined;
      responses.push({ status: response.status, remaining: decision?.bootstrap_grace_remaining, reasons: decision?.reasons });
    }

    // 1~10 은 grace 안 — seed 라서 승인 없이 나갔다.
    expect(responses.slice(0, 10).map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(responses[0]?.reasons).toEqual(['seed_relationship', 'bootstrap_grace']);

    // ★ AC-a4 — 9번째: API 1, audit 1.
    expect(responses[8]?.remaining).toBe(1);
    const rows = await auditRows(pool, fixture.agentId);
    expect(rows[8]?.bootstrap_grace_remaining).toBe(1);
    expect(rows[8]?.reasons).toContain('bootstrap_grace');

    // ★ AC-a3 — 11번째: policy_denied + reply_only_no_inbound_thread, SES 는 10에서 멈춘다.
    expect(responses[10]).toMatchObject({ status: 403, reasons: ['reply_only_no_inbound_thread'] });
    expect(h.transport.calls()).toBe(10);
    expect(rows[10]?.bootstrap_grace_remaining).toBeNull();
  });

  it('AC-a3 — 생성 15일째의 첫 outbound 는 발송 0건이어도 거부된다', async () => {
    const pool = testPool();
    const seed = 'old-agent-seed@example.com';
    const fixture = await seedApprovalFixture(pool, {
      mode: 'reply_only',
      seeds: [seed],
      agentCreatedAt: new Date(Date.now() - 15 * DAY_MS),
    });
    const h = harnessFor(pool);

    const outcome = await send(h, fixture, seed);
    expect(outcome.kind).toBe('denied');
    if (outcome.kind === 'denied') expect(outcome.decision.reasons).toEqual(['reply_only_no_inbound_thread']);
    expect(h.transport.calls()).toBe(0);
  });
});
