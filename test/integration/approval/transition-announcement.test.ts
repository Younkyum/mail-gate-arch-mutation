/**
 * **전환 공지 — 실제 Postgres 위에서** (계획 §3.2 2단계 · AC-b1 · AC-b2 · §4.3 · R22).
 *
 * 인메모리 배선(`test/integration/outbound/transition-announcement.test.ts`)이 못 보는 것 — DB 가 있어야만
 * 참인 것들:
 *   - `approval_requests` 가 **정확히 1행**(`subject='batch'`)이고 항목이 20행이다(AC-b1).
 *   - 승인·릴리스 뒤 audit 이 **여전히 20행**이고, 20행 전부 `allowed` + `transition_announcement` + 같은
 *     `approval_id` + `sent` 로 해소됐다(AC-b2). 사유 불변은 트리거가 집행한다.
 *   - **AC-b2 는 기본 한도(분당 5)에서 통과한다.** 예전 이 파일은 한도를 넉넉히 준 상태에서만 초록이었다 —
 *     기본값이면 5통 발송·15통 `release_denied:rate_limit_per_minute` 영구 종결이었다(P2 수정 전 결함).
 *     지금은 시계를 흘려 분마다 5통씩, 4라운드에 20통이 나가는 것을 본다.
 *   - 결정된 요청·다른 에이전트의 배치에 항목이 붙지 않는다(저장소의 합류 가드).
 *   - **워밍업 Day 1 캡(20 수신자)을 공지 20통이 정확히 다 쓴다** — 그날 다음 1명은 거부된다(런북의 판단 근거).
 *
 * **`TEST_DATABASE_URL` 이 없으면 통째로 건너뛴다.**
 */

import { randomBytes, randomUUID } from 'node:crypto';
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
import { handleTransitionAnnouncement } from '../../../src/api/routes/transition-announcement';
import { createPostgresSeedContactReader } from '../../../src/api/seed-contact-store';
import { APPROVAL_RELEASE_WINDOW_HOURS, approveRequest } from '../../../src/approval/service';
import { DEFAULT_POLICY_LIMITS } from '../../../src/identity/provisioning';
import { createPostgresApprovalStore, createPostgresAuditSink, createPostgresGateStores } from '../../../src/db/repositories';
import { toAgentId, type AgentId } from '../../../src/db/schema';
import { dispatch } from '../../../src/policy/gate';
import { runApprovalRelease, type ApprovalReleaseOutcome } from '../../../src/workers/approval-release';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, testPool } from '../db/support/harness';
import { countingTransport, issuedToken } from '../outbound/support/fakes';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

const OWNER = 'owner@example.com';

interface Fixture {
  readonly agentId: AgentId;
  readonly address: string;
  readonly seeds: readonly string[];
}

/**
 * 기본 모드(`approval_required`) + seed 20명. `sending_started_at` 을 고를 수 있다 — `null` 이면 워밍업 Day 0
 * (캡 20 수신자). **에이전트 한도는 신규 에이전트 기본값 그대로다**(`DEFAULT_POLICY_LIMITS`, 분당 5) — 한도를
 * 넉넉히 주면 릴리스의 페이싱·재예약이 한 번도 실행되지 않은 채 초록이 된다.
 */
async function seedFixture(pool: Pool, sendingStartedAt: Date | null): Promise<Fixture> {
  const agentId = toAgentId(randomBytes(16).toString('hex'));
  const address = `ta-${agentId.slice(0, 16)}@atmark.ai`;
  const seeds = Array.from({ length: 20 }, (_, index) => `seed${String(index)}-${agentId.slice(0, 6)}@partner.example`);
  const org = await provisioningPool().query<{ id: string }>(
    `INSERT INTO organizations (name, billing_status, sending_started_at) VALUES ($1, 'active', $2) RETURNING id`,
    [`ta-org-${agentId.slice(0, 8)}`, sendingStartedAt],
  );
  const organizationId = org.rows[0]?.id as string;
  await provisioningPool().query(
    `INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents)
     VALUES ($1, $2, $3, 'active', 'free', 100000)`,
    [agentId, organizationId, `ta-agent-${agentId.slice(0, 8)}`],
  );
  await provisioningPool().query(
    `INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', true)`,
    [agentId, address],
  );
  const limits = { ...DEFAULT_POLICY_LIMITS };
  // TTL 을 상한(7일)으로 둔다. 같은 DB 를 쓰는 다른 테스트가 **전역** TTL 스윕을 `now + 24h` 로 돌린다 —
  // 기본 TTL(24h)이면 이 파일의 배치 요청이 공지 도중에 만료되어 합류 가드가 (올바르게) 던진다.
  const config = {
    allowlist: [],
    blocklist: [],
    max_attachment_bytes_total: 10_000_000,
    allowed_mime_types: ['text/plain'],
    approval_ttl_seconds: 7 * 24 * 60 * 60,
  };
  await provisioningPool().query(
    `INSERT INTO agent_policies (agent_id, outbound_mode, limits, config_json, current_version)
     VALUES ($1, 'approval_required', $2::jsonb, $3::jsonb, 1)`,
    [agentId, JSON.stringify(limits), JSON.stringify(config)],
  );
  await provisioningPool().query(
    `INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot) VALUES ($1, 1, 'approval_required', $2::jsonb)`,
    [agentId, JSON.stringify({ outbound_mode: 'approval_required', limits, config_json: config })],
  );
  for (const seed of seeds) {
    await provisioningPool().query(
      `INSERT INTO sender_relationships (agent_id, scope, address, trust_category, granted_by)
       VALUES ($1, 'recipient', $2, 'seed', 'owner_provisioning')`,
      [agentId, seed],
    );
  }
  return { agentId, address, seeds };
}

function serviceFor(pool: Pool, clock: { now: Date } | null = null): OutboundServiceDependencies {
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
    now: () => (clock === null ? new Date() : clock.now),
  };
}

/**
 * **시계를 흘리며** 그 요청의 릴리스를 끝까지 돌린다 — 매 라운드 기한이 된 항목을 집고, 다음 기한으로 시계를 옮긴다.
 * 라운드 상한은 무한 루프 방지이자 단언 대상이다(분당 5 · 20통이면 4라운드).
 */
async function releaseUntilSettled(
  pool: Pool,
  deps: { service: OutboundServiceDependencies; approvals: ReturnType<typeof createPostgresApprovalStore>; transport: ReturnType<typeof countingTransport> },
  clock: { now: Date },
  approvalId: string,
): Promise<{ readonly rounds: number; readonly outcomes: ApprovalReleaseOutcome[] }> {
  const outcomes: ApprovalReleaseOutcome[] = [];
  let rounds = 0;
  for (; rounds < 20; rounds += 1) {
    outcomes.push(...(await runApprovalRelease(deps, { approvalId, traceId: null })));
    const next = await pool.query<{ next: Date | null }>(
      `SELECT min(next_release_at) AS next FROM approval_releases WHERE approval_id = $1 AND status = 'scheduled'`,
      [approvalId],
    );
    const due = next.rows[0]?.next ?? null;
    if (due === null) return { rounds: rounds + 1, outcomes };
    clock.now = new Date(Math.max(due.getTime(), clock.now.getTime()));
  }
  return { rounds, outcomes };
}

async function announce(pool: Pool, service: OutboundServiceDependencies, fixture: Fixture) {
  const token = issuedToken(fixture.agentId);
  return handleTransitionAnnouncement(
    { tokens: token.store, service, seeds: createPostgresSeedContactReader(pool) },
    {
      headers: { authorization: `Bearer ${token.plaintext}`, 'idempotency-key': randomUUID() },
      query: {},
      body: { agent_id: fixture.agentId, from: fixture.address, owner_name: '진윤겸' },
    },
  );
}

interface AuditRow {
  id: string;
  message_id: string;
  decision: string;
  reasons: string[];
  approval_id: string | null;
  approved_by: string | null;
  resolution_reason: string | null;
}

async function auditRows(pool: Pool, agentId: string): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    `SELECT id, message_id, decision, reasons, approval_id, approved_by, resolution_reason
       FROM audit_logs WHERE agent_id = $1 ORDER BY created_at, id`,
    [agentId],
  );
  return result.rows;
}

/** §4.3 보조 불변식(재정의) 위반 행 — 이 에이전트 것만. `audit_pending_overdue(at)` 의 결과. */
async function overdueFor(pool: Pool, agentId: string, at: Date): Promise<string[]> {
  const result = await pool.query<{ audit_id: string }>(
    `SELECT o.audit_id FROM audit_pending_overdue($2) o JOIN audit_logs a ON a.id = o.audit_id WHERE a.agent_id = $1`,
    [agentId, at],
  );
  return result.rows.map((row) => row.audit_id);
}

async function requestsOf(pool: Pool, agentId: string): Promise<{ id: string; subject: string; status: string }[]> {
  const result = await pool.query<{ id: string; subject: string; status: string }>(
    'SELECT id, subject, status FROM approval_requests WHERE agent_id = $1',
    [agentId],
  );
  return result.rows;
}

async function sendOne(service: OutboundServiceDependencies, fixture: Fixture, recipient: string): Promise<OutboundOutcome> {
  const prepared = await prepareOutbound(service, {
    routeId: 'send',
    agentId: fixture.agentId,
    idempotencyKey: randomUUID(),
    fromAddress: fixture.address,
    recipients: [recipient],
    subject: 'after the announcement',
    text: '공지 뒤 첫 업무 메일',
    html: null,
    isThreadReply: false,
    traceId: null,
    costCents: 0,
  });
  if (prepared.kind !== 'ready') throw new Error(`ready 여야 한다: ${prepared.outcome.kind}`);
  const outcome = await dispatch(gateDependenciesFor(service, countingTransport()), prepared.dispatchRequest);
  return finalizeOutbound(service, prepared, outcome);
}

/** 공지 1회 = 시도 20건 × (직렬화 잠금 + 평가 + 트랜잭션). 전체 스위트가 병렬로 DB 를 두드릴 때 5초 기본값을 넘긴다. */
const DB_TIMEOUT = { timeout: 30_000 };

describe.skipIf(!DATABASE_AVAILABLE)('AC-b1 · AC-b2 — 전환 공지, 실제 DB', DB_TIMEOUT, () => {
  it('AC-b1 — seed 20명 → ApprovalRequest 1행(batch) · 항목 20 · audit 20행 대기 · messages 20행 pending', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, new Date('2026-01-01T00:00:00.000Z'));
    const response = await announce(pool, serviceFor(pool), fixture);

    expect(response.status).toBe(202);
    const requests = await requestsOf(pool, fixture.agentId);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.subject).toBe('batch');
    expect(requests[0]?.status).toBe('pending');
    expect(response.body['approval_id']).toBe(requests[0]?.id);

    const items = await pool.query('SELECT 1 FROM approval_request_items WHERE approval_id = $1', [requests[0]?.id]);
    expect(items.rowCount).toBe(20);

    const rows = await auditRows(pool, fixture.agentId);
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.decision === 'pending_approval')).toBe(true);
    expect(rows.every((row) => row.approval_id === requests[0]?.id)).toBe(true);
    expect(rows.every((row) => row.reasons.join() === 'transition_announcement')).toBe(true);

    // **승인 전 SES 0회**: 20행 전부 lease 를 잡은 적이 없다(`pending`). 전송은 lease 뒤에만 일어난다.
    const statuses = await pool.query<{ status: string }>(
      `SELECT status FROM messages WHERE agent_id = $1 AND direction = 'outbound'`,
      [fixture.agentId],
    );
    expect(statuses.rows.map((row) => row.status)).toEqual(Array.from({ length: 20 }, () => 'pending'));
  });

  it('AC-b2 — 기본 한도(분당 5)에서 승인 → 릴리스: 20통 · audit 여전히 20행 · 전부 allowed/sent · 같은 approval_id · 사유 불변', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, new Date('2026-01-01T00:00:00.000Z'));
    const clock = { now: new Date() };
    const service = serviceFor(pool, clock);
    const response = await announce(pool, service, fixture);
    const approvalId = response.body['approval_id'] as string;

    const approvals = createPostgresApprovalStore(pool);
    const approvedAt = clock.now;
    const approved = await approveRequest(approvals, {
      approvalId,
      decidedBy: OWNER,
      now: approvedAt,
      scope: 'recipient',
      confirmScope: null,
    });
    expect(approved.kind).toBe('approved');

    // 승인 전이 트리거가 같은 트랜잭션에서 항목 20개의 일정을 만들었다 — 창은 승인 + 48h.
    const schedule = await pool.query<{ next_release_at: Date; deadline_at: Date }>(
      'SELECT next_release_at, deadline_at FROM approval_releases WHERE approval_id = $1',
      [approvalId],
    );
    expect(schedule.rowCount).toBe(20);
    expect(
      schedule.rows.every(
        (row) =>
          row.next_release_at.getTime() === approvedAt.getTime() &&
          row.deadline_at.getTime() === approvedAt.getTime() + APPROVAL_RELEASE_WINDOW_HOURS * 3_600_000,
      ),
    ).toBe(true);

    const transport = countingTransport();
    const deps = { service, approvals, transport };

    // 첫 라운드 — 분당 5 에 걸려 5통만 나가고, 나머지 15통은 **닫히지 않고** 61초 뒤로 미뤄진다.
    const first = await runApprovalRelease(deps, { approvalId, traceId: null });
    expect(first.filter((outcome) => outcome.kind === 'sent')).toHaveLength(5);
    expect(first.filter((outcome) => outcome.kind === 'deferred')).toHaveLength(15);
    const midway = await auditRows(pool, fixture.agentId);
    expect(midway.filter((row) => row.decision === 'pending_approval')).toHaveLength(15);
    expect(midway.some((row) => row.resolution_reason?.startsWith('release_denied') ?? false)).toBe(false);
    // 재예약된 15행은 §4.3 보조 불변식(재정의)을 어기지 않는다 — 승인됐고, 일정이 살아 있고, 창 안이다.
    expect(await overdueFor(pool, fixture.agentId, clock.now)).toEqual([]);
    // 창을 넘기면 같은 15행이 위반으로 **보인다** — 측정 함수가 살아 있다는 증거.
    const pastWindow = new Date(approvedAt.getTime() + APPROVAL_RELEASE_WINDOW_HOURS * 3_600_000);
    expect(await overdueFor(pool, fixture.agentId, pastWindow)).toHaveLength(15);

    // 시계를 흘린다 — 분마다 5통, 합 4라운드.
    clock.now = new Date(approvedAt.getTime() + 61_000);
    const rest = await releaseUntilSettled(pool, deps, clock, approvalId);
    expect(rest.rounds).toBe(3);
    expect(transport.calls()).toBe(20);
    expect(clock.now.getTime() - approvedAt.getTime()).toBe(3 * 61_000);

    const rows = await auditRows(pool, fixture.agentId);
    // **시도 20건 = 20행.** 최초 PENDING 평가는 별도 행이 아니라 같은 20행의 초기 상태였다(§4.3).
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.decision === 'allowed')).toBe(true);
    expect(rows.every((row) => row.approval_id === approvalId)).toBe(true);
    expect(rows.every((row) => row.reasons.includes('transition_announcement'))).toBe(true);
    expect(rows.every((row) => row.approved_by === OWNER)).toBe(true);
    expect(rows.every((row) => row.resolution_reason === 'sent')).toBe(true);
    expect(await requestsOf(pool, fixture.agentId)).toHaveLength(1);
    const settled = await pool.query<{ status: string; settled_outcome: string }>(
      'SELECT status, settled_outcome FROM approval_releases WHERE approval_id = $1',
      [approvalId],
    );
    expect(settled.rows.every((row) => row.status === 'settled' && row.settled_outcome === 'sent')).toBe(true);
    expect(await overdueFor(pool, fixture.agentId, clock.now)).toEqual([]);
  });

  it('R22 · GATE 1일차 — 워밍업 Day 0 캡(20)을 공지 20통이 정확히 다 쓴다: 그날 다음 1명은 거부', async () => {
    const pool = testPool();
    // `sending_started_at = null` — 이 조직의 첫 발송이 공지다(런북이 피하라고 적은 순서).
    const fixture = await seedFixture(pool, null);
    const clock = { now: new Date() };
    const service = serviceFor(pool, clock);
    const response = await announce(pool, service, fixture);
    const approvalId = response.body['approval_id'] as string;
    const approvals = createPostgresApprovalStore(pool);
    await approveRequest(approvals, { approvalId, decidedBy: OWNER, now: clock.now, scope: 'recipient', confirmScope: null });

    const { outcomes } = await releaseUntilSettled(
      pool,
      { service, approvals, transport: countingTransport() },
      clock,
      approvalId,
    );
    // 캡은 20 **수신자**이고 공지는 1명씩 20통이다 — 경계에 정확히 맞아 전부 나간다(분당 5 로 페이싱되며).
    expect(outcomes.filter((outcome) => outcome.kind === 'sent')).toHaveLength(20);
    // 분당 한도가 풀릴 시간을 준 뒤에 본다 — 다음 1명을 막는 것이 **워밍업 캡**임을 보려면 다른 축이 비어 있어야 한다.
    clock.now = new Date(clock.now.getTime() + 3_600_000 + 1000);

    // 같은 날, 이미 관계가 있는 상대(seed)에게 보내는 **업무 메일 1통**이 캡에 막힌다.
    const next = await sendOne(service, fixture, fixture.seeds[0] as string);
    expect(next.kind).toBe('denied');
    if (next.kind === 'denied') expect(next.decision.reasons).toEqual(['warmup_daily_cap']);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('배치 합류 가드 — 결정된 요청 · 다른 에이전트의 요청에 항목이 붙지 않는다', DB_TIMEOUT, () => {
  it('승인된 배치에 새 시도를 붙이려 하면 저장소가 던지고 행이 남지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, new Date('2026-01-01T00:00:00.000Z'));
    const service = serviceFor(pool);
    const response = await announce(pool, service, fixture);
    const approvalId = response.body['approval_id'] as string;
    await approveRequest(createPostgresApprovalStore(pool), {
      approvalId,
      decidedBy: OWNER,
      now: new Date(),
      scope: 'recipient',
      confirmScope: null,
    });

    const prepared = await prepareOutbound(service, {
      routeId: 'transition_announcement',
      agentId: fixture.agentId,
      idempotencyKey: randomUUID(),
      fromAddress: fixture.address,
      recipients: ['late@partner.example'],
      subject: 'late',
      text: 'late',
      html: null,
      isThreadReply: false,
      traceId: null,
      costCents: 0,
    });
    if (prepared.kind !== 'ready') throw new Error('ready 여야 한다');
    await expect(
      dispatch(gateDependenciesFor(service, countingTransport()), { ...prepared.dispatchRequest, batch: { approvalId } }),
    ).rejects.toThrow(/배치 승인 요청에 합류할 수 없다/);

    const items = await pool.query('SELECT 1 FROM approval_request_items WHERE approval_id = $1', [approvalId]);
    expect(items.rowCount).toBe(20);
    expect(await auditRows(pool, fixture.agentId)).toHaveLength(20);
  });

  it('다른 에이전트의 배치 id 로는 합류할 수 없다 · message 요청 id 로도 안 된다', async () => {
    const pool = testPool();
    const owner = await seedFixture(pool, new Date('2026-01-01T00:00:00.000Z'));
    const intruder = await seedFixture(pool, new Date('2026-01-01T00:00:00.000Z'));
    const service = serviceFor(pool);
    const response = await announce(pool, service, owner);
    const approvalId = response.body['approval_id'] as string;

    const prepared = await prepareOutbound(service, {
      routeId: 'transition_announcement',
      agentId: intruder.agentId,
      idempotencyKey: randomUUID(),
      fromAddress: intruder.address,
      recipients: [intruder.seeds[0] as string],
      subject: 'join',
      text: 'join',
      html: null,
      isThreadReply: false,
      traceId: null,
      costCents: 0,
    });
    if (prepared.kind !== 'ready') throw new Error('ready 여야 한다');
    await expect(
      dispatch(gateDependenciesFor(service, countingTransport()), { ...prepared.dispatchRequest, batch: { approvalId } }),
    ).rejects.toThrow(/배치 승인 요청에 합류할 수 없다/);
    expect(await requestsOf(pool, intruder.agentId)).toHaveLength(0);

    // 단건(`subject='message'`) 요청 id 를 배치로 가장해도 합류하지 못한다.
    const sink = createPostgresAuditSink(pool);
    const single = await sendOne(service, intruder, 'stranger@elsewhere.example');
    if (single.kind !== 'pending_approval' || single.approval === null) throw new Error('승인 대기여야 한다');
    const denied = await sink
      .record({
        agentId: intruder.agentId,
        messageId: single.messageId,
        decision: single.decision,
        traceId: null,
        latencyMs: 0,
        approval: {
          approvalId: single.approval.approvalId,
          subject: 'batch',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600_000 * 2),
          envelope: { fromAddress: intruder.address, recipients: ['x@y.example'], isThreadReply: false, threadId: null, costCents: 0 },
        },
      })
      .then(
        () => 'recorded',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    expect(denied).toMatch(/배치 승인 요청에 합류할 수 없다/);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('창은 허용 쪽에도 있다 — 승인 뒤 워커 정지 (V1 MINOR-1)', DB_TIMEOUT, () => {
  it('승인 뒤 72시간 만의 깨우기: 0통 · 일정 저장소가 관문 전에 20행을 release_window_expired 로 닫는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, new Date('2026-01-01T00:00:00.000Z'));
    const clock = { now: new Date() };
    const service = serviceFor(pool, clock);
    const response = await announce(pool, service, fixture);
    const approvalId = response.body['approval_id'] as string;
    const approvals = createPostgresApprovalStore(pool);
    const approvedAt = clock.now;
    await approveRequest(approvals, { approvalId, decidedBy: OWNER, now: approvedAt, scope: 'recipient', confirmScope: null });

    // 워커가 멈췄다. 72시간 뒤 첫 깨우기 — 재평가하면 허용이다(한도 창은 오래전에 비었다).
    clock.now = new Date(approvedAt.getTime() + 72 * 3_600_000);
    const transport = countingTransport();
    const outcomes = await runApprovalRelease({ service, approvals, transport }, { approvalId, traceId: null });

    expect(transport.calls()).toBe(0);
    // **관문에 서지도 않았다** — 집기 전에 저장소가 닫았다(관문의 같은 창 검사는 두 번째 겹이다).
    expect(outcomes).toEqual([]);
    const releases = await pool.query<{ status: string; settled_outcome: string; last_deferral_reason: string; claim_count: number }>(
      'SELECT status, settled_outcome, last_deferral_reason, claim_count FROM approval_releases WHERE approval_id = $1',
      [approvalId],
    );
    expect(releases.rows).toHaveLength(20);
    expect(
      releases.rows.every(
        (row) =>
          row.status === 'settled' &&
          row.settled_outcome === 'denied' &&
          row.last_deferral_reason === 'release_window_expired' &&
          row.claim_count === 0,
      ),
    ).toBe(true);
    const rows = await auditRows(pool, fixture.agentId);
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.decision === 'denied' && row.resolution_reason === 'release_denied:release_window_expired')).toBe(true);
    const statuses = await pool.query<{ status: string }>(
      `SELECT status FROM messages WHERE agent_id = $1 AND direction = 'outbound'`,
      [fixture.agentId],
    );
    expect(statuses.rows.every((row) => row.status === 'denied')).toBe(true);
    // 닫혔으므로 보조 불변식 위반도 아니다.
    expect(await overdueFor(pool, fixture.agentId, clock.now)).toEqual([]);
  });

  it('창 끝 + 유예 안이면 저장소는 닫지 않는다 — 창 끝의 마지막 재평가를 관문이 받는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, new Date('2026-01-01T00:00:00.000Z'));
    const clock = { now: new Date() };
    const service = serviceFor(pool, clock);
    const response = await announce(pool, service, fixture);
    const approvalId = response.body['approval_id'] as string;
    const approvals = createPostgresApprovalStore(pool);
    const approvedAt = clock.now;
    await approveRequest(approvals, { approvalId, decidedBy: OWNER, now: approvedAt, scope: 'recipient', confirmScope: null });

    clock.now = new Date(approvedAt.getTime() + APPROVAL_RELEASE_WINDOW_HOURS * 3_600_000 + 60_000);
    const transport = countingTransport();
    const outcomes = await runApprovalRelease({ service, approvals, transport }, { approvalId, traceId: null });
    // 분당 5 — 5통은 나가고 15통은 창 끝을 지났으므로 재평가 거부가 곧 종결이다(`release_denied:rate_limit_per_minute`).
    expect(transport.calls()).toBe(5);
    expect(outcomes.filter((outcome) => outcome.kind === 'denied')).toHaveLength(15);
  });

  it('countPendingOverdue 는 audit_pending_overdue 의 행 수다 — 이 에이전트의 위반 15행이 전역 수에 들어 있다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, new Date('2026-01-01T00:00:00.000Z'));
    const clock = { now: new Date() };
    const service = serviceFor(pool, clock);
    const response = await announce(pool, service, fixture);
    const approvalId = response.body['approval_id'] as string;
    const approvals = createPostgresApprovalStore(pool);
    await approveRequest(approvals, { approvalId, decidedBy: OWNER, now: clock.now, scope: 'recipient', confirmScope: null });
    await runApprovalRelease({ service, approvals, transport: countingTransport() }, { approvalId, traceId: null });

    const pastWindow = new Date(clock.now.getTime() + APPROVAL_RELEASE_WINDOW_HOURS * 3_600_000);
    const mine = await overdueFor(pool, fixture.agentId, pastWindow);
    expect(mine).toHaveLength(15);
    // 공유 DB 라 전역 수는 정확히 모른다 — 이 에이전트의 15행을 **포함한다**는 것까지만 단언한다.
    expect(await approvals.countPendingOverdue(pastWindow)).toBeGreaterThanOrEqual(15);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('릴리스 집기는 잠긴 행을 건너뛴다 (SKIP LOCKED, R5)', DB_TIMEOUT, () => {
  it('다른 트랜잭션이 쥔 일정 행은 기다리지 않고 건너뛴다 — 나머지 19행을 곧바로 집는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, new Date('2026-01-01T00:00:00.000Z'));
    const clock = { now: new Date() };
    const service = serviceFor(pool, clock);
    const response = await announce(pool, service, fixture);
    const approvalId = response.body['approval_id'] as string;
    const approvals = createPostgresApprovalStore(pool);
    await approveRequest(approvals, { approvalId, decidedBy: OWNER, now: clock.now, scope: 'recipient', confirmScope: null });

    // 다른 워커가 한 행을 집는 중이다(행 잠금). 같은 풀이 아니라 독립 커넥션 — 그 트랜잭션이 끝나지 않는다.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      const locked = await holder.query<{ message_id: string }>(
        `SELECT message_id FROM approval_releases WHERE approval_id = $1 ORDER BY message_id LIMIT 1 FOR UPDATE`,
        [approvalId],
      );
      const lockedId = locked.rows[0]?.message_id;

      const claim = approvals.claimDueReleases({ now: clock.now, limit: 50, approvalId, leaseSeconds: 300 });
      const timeout = new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 3_000));
      const claimed = await Promise.race([claim, timeout]);
      expect(claimed).not.toBe('blocked');
      if (claimed === 'blocked') return;
      expect(claimed).toHaveLength(19);
      expect(claimed.some((entry) => entry.messageId === lockedId)).toBe(false);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    // 잠금이 풀리면 그 행도 집힌다 — 건너뛴 것이지 잃은 것이 아니다.
    const rest = await approvals.claimDueReleases({ now: clock.now, limit: 50, approvalId, leaseSeconds: 300 });
    expect(rest).toHaveLength(1);
    // 집어 둔 20행을 정상 경로로 끝낸다 — 공유 DB 에 창 끝까지 남는 일정(§4.3 보조 불변식 후보)을 두지 않는다.
    clock.now = new Date(clock.now.getTime() + 301_000);
    await releaseUntilSettled(pool, { service, approvals, transport: countingTransport() }, clock, approvalId);
  });
});
