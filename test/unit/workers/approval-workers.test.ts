/**
 * 승인 워커 둘 — 스위퍼는 서비스에 위임하고, 릴리스는 **일정 행을 집어** 관문에 세운다.
 *
 * 릴리스 쪽이 여기서 못 박는 것 (P2 수정 — 일시적 거부를 영구 거부로 닫던 결함):
 *   - 일시적 거부는 **닫지 않고 미룬다**(대기 행 무접촉, 일정 행만 밀림) · 영구 거부는 곧바로 닫는다.
 *   - 페이싱 — 한 에이전트의 첫 일시적 거부 뒤 남은 항목은 관문에 세우지 않는다.
 *   - 창 끝의 재평가가 마지막이다(무한 재시도 없음) · 창 끝 항목은 페이싱으로 건너뛰지 않는다.
 *   - lease 를 남이 쥐고 있으면 일정을 닫지 않는다.
 * 실제 DB 위의 전이·발송은 `test/integration/approval/*.test.ts` 가 본다.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { handleTransitionAnnouncement } from '../../../src/api/routes/transition-announcement';
import {
  APPROVAL_RELEASE_WINDOW_HOURS,
  PENDING_OVERDUE_TOLERANCE_SECONDS,
  type ApprovalStore,
  type ExpireCommand,
} from '../../../src/approval/service';
import type { ApprovalRequestItemRow, ApprovalRequestRow, SenderRelationshipRow } from '../../../src/db/schema';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { METRIC_NAMES } from '../../../src/observability/metrics';
import type { PolicySource, PolicySourceResult } from '../../../src/policy/policy-loader';
import { RELEASE_WINDOW_GRACE_SECONDS } from '../../../src/policy/release-deferral';
import { APPROVAL_EXPIRY_BATCH, runApprovalExpiry, runSnippetRetention } from '../../../src/workers/approval-expiry';
import {
  APPROVAL_RELEASE_BATCH,
  RELEASE_LEASE_HELD,
  runApprovalRelease,
  runApprovalReleaseSweep,
} from '../../../src/workers/approval-release';
import {
  AGENT_ADDRESS,
  AGENT_ID,
  approvedWithSchedule,
  harness,
  issuedToken,
  policyRow,
  policyVersionRow,
  sourceResult,
  suppressionRow,
  type FakeApprovals,
  type OutboundHarness,
} from '../../integration/outbound/support/fakes';

const NOW = new Date('2026-10-15T12:00:00.000Z');

/** 로그 줄을 모은다 — 싱크는 `afterEach` 가 되돌린다. */
function captureLog(): string[] {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  return lines;
}

afterEach(() => resetLogSink());

function store(overrides: Partial<ApprovalStore>): ApprovalStore {
  return {
    find: () => Promise.resolve(null),
    items: () => Promise.resolve([]),
    riskHoldReasons: () => Promise.resolve([]),
    approve: () => Promise.resolve(null),
    reject: () => Promise.resolve(false),
    expire: () => Promise.resolve(false),
    listDue: () => Promise.resolve([]),
    oldestPendingCreatedAt: () => Promise.resolve(null),
    countPendingOverdue: () => Promise.resolve(0),
    claimDueReleases: () => Promise.resolve([]),
    deferRelease: () => Promise.resolve(),
    settleRelease: () => Promise.resolve(),
    ...overrides,
  };
}

describe('workers/approval-expiry', () => {
  it('서비스 시계로 한 번 스윕하고, 배치 상한을 넘기지 않는다 — 만료마다 `approval.expired` 를 싣는다', async () => {
    const approvalId = '00000000-0000-4000-8000-00000000a001';
    const seen: { now: Date; limit: number }[] = [];
    const expireCalls: ExpireCommand[] = [];
    const result = await runApprovalExpiry({
      approvals: store({
        find: () =>
          Promise.resolve({
            id: approvalId,
            agent_id: AGENT_ID,
            subject: 'message',
            status: 'pending',
            created_at: NOW,
            expires_at: NOW,
            decided_at: null,
            decided_by: null,
            granted_scope: null,
          }),
        listDue: (now, limit) => {
          seen.push({ now, limit });
          return Promise.resolve([approvalId]);
        },
        expire: (command) => {
          expireCalls.push(command);
          return Promise.resolve(true);
        },
      }),
      now: () => NOW,
    });
    expect(seen).toEqual([{ now: NOW, limit: APPROVAL_EXPIRY_BATCH }]);
    expect(result.expired).toEqual([approvalId]);
    expect(expireCalls.map((call) => call.event.type)).toEqual(['approval.expired']);
  });
});

describe('workers/approval-release — 얇은 층', () => {
  it('요청이 없으면 일정도 관문도 보지 않고 빈 결과 — 전송단 0회', async () => {
    const test = harness();
    let claimed = 0;
    const outcomes = await runApprovalRelease(
      {
        service: test.service,
        approvals: store({
          claimDueReleases: () => {
            claimed += 1;
            return Promise.resolve([]);
          },
        }),
        transport: test.transport,
      },
      { approvalId: 'missing', traceId: null },
    );
    expect(outcomes).toEqual([]);
    expect(claimed).toBe(0);
    expect(test.transport.calls()).toBe(0);
    expect(test.audit.rows).toHaveLength(0);
  });

  it('항목의 messages 행이 없으면 던진다 — 조용히 건너뛰면 승인된 메일이 사라진다', async () => {
    const test = harness();
    const request = approvedRequest('apr-1');
    const approvals = approvedWithSchedule(request, [
      {
        approval_id: 'apr-1',
        message_id: 'no-such-message',
        audit_id: 'audit-1',
        from_address: AGENT_ADDRESS,
        recipients: ['friend@example.com'],
        is_thread_reply: false,
        thread_id: null,
        cost_cents: 0,
        created_at: NOW,
      },
    ]);
    await expect(
      runApprovalRelease({ service: test.service, approvals, transport: test.transport }, { approvalId: 'apr-1', traceId: null }),
    ).rejects.toThrow(/messages 행이 없다/);
    expect(test.transport.calls()).toBe(0);
  });

  it('일정 행이 가리키는 항목이 없으면 던진다 — FK 가 보장하는 것을 조용히 넘기지 않는다', async () => {
    const test = harness();
    const approvals = approvedWithSchedule(approvedRequest('apr-1'), [item('apr-1', 'msg-x', 'audit-1')]);
    await expect(
      runApprovalRelease(
        { service: test.service, approvals: { ...approvals, items: () => Promise.resolve([]) }, transport: test.transport },
        { approvalId: 'apr-1', traceId: null },
      ),
    ).rejects.toThrow(/승인 항목이 없다/);
  });

  it('주기 스윕은 요청을 가리지 않고 기한이 된 항목을 배치 상한까지 집는다', async () => {
    const test = harness();
    const seen: { approvalId: string | null; limit: number; leaseSeconds: number }[] = [];
    const outcomes = await runApprovalReleaseSweep({
      service: test.service,
      approvals: store({
        claimDueReleases: (claim) => {
          seen.push({ approvalId: claim.approvalId, limit: claim.limit, leaseSeconds: claim.leaseSeconds });
          return Promise.resolve([]);
        },
      }),
      transport: test.transport,
    });
    expect(outcomes).toEqual([]);
    expect(seen).toEqual([{ approvalId: null, limit: APPROVAL_RELEASE_BATCH, leaseSeconds: test.service.leaseTtlSeconds }]);
  });
});

// ---------------------------------------------------------------------------
// 재예약 · 페이싱 · 창 끝 — 인메모리 구동
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const SEEDS = Array.from({ length: 20 }, (_, index) => `seed-${String(index + 1).padStart(2, '0')}@partner.example`);

function approvedRequest(id: string): ApprovalRequestRow {
  return {
    id,
    agent_id: AGENT_ID,
    subject: 'batch',
    status: 'approved',
    created_at: NOW,
    expires_at: new Date(NOW.getTime() + 24 * HOUR_MS),
    decided_at: NOW,
    decided_by: 'owner@example.com',
    granted_scope: 'recipient',
  };
}

function item(approvalId: string, messageId: string, auditId: string): ApprovalRequestItemRow {
  return {
    approval_id: approvalId,
    message_id: messageId,
    audit_id: auditId,
    from_address: AGENT_ADDRESS,
    recipients: ['friend@example.com'],
    is_thread_reply: false,
    thread_id: null,
    cost_cents: 0,
    created_at: NOW,
  };
}

function seedRelationship(address: string): SenderRelationshipRow {
  return {
    id: `rel-${address}`,
    agent_id: AGENT_ID,
    scope: 'recipient',
    address,
    domain: null,
    thread_id: null,
    trust_category: 'seed',
    granted_via_approval_id: null,
    granted_by: 'owner_provisioning',
    domain_scope_confirmed_by: null,
    created_at: NOW,
  };
}

/**
 * 전환 공지 20통을 승인 대기로 만들고, 승인된 상태의 릴리스 구동기를 돌려준다.
 *
 * **카운터가 살아 있다** — 로더가 돌려주는 `agentLastMinute`·`orgRecipientsLastDay` 는 이 구동기가 실제로 보낸
 * 기록(시계 기준)으로 계산된다. 고정 카운터면 한도는 영원히 안 걸리거나 영원히 걸리고, 페이싱은 증명되지 않는다.
 */
async function announcedRig(options: { readonly perMinute?: number } = {}): Promise<{
  readonly test: OutboundHarness;
  readonly approvals: FakeApprovals;
  readonly clock: { now: Date };
  readonly setOverrides: (overrides: Partial<PolicySourceResult>) => void;
  readonly release: () => ReturnType<typeof runApprovalRelease>;
  readonly sweep: () => ReturnType<typeof runApprovalReleaseSweep>;
  readonly sends: Date[];
}> {
  const clock = { now: NOW };
  const sends: Date[] = [];
  const base = sourceResult();
  let overrides: Partial<PolicySourceResult> = {};
  let grant: PolicySourceResult['approvalGrant'] = null;
  const result = (): PolicySourceResult => {
    const minuteAgo = clock.now.getTime() - 60_000;
    const dayAgo = clock.now.getTime() - 24 * HOUR_MS;
    const lastMinute = sends.filter((at) => at.getTime() >= minuteAgo).length;
    const lastDay = sends.filter((at) => at.getTime() >= dayAgo).length;
    return {
      ...base,
      organization: { ...base.organization, sending_started_at: new Date('2026-09-01T00:00:00.000Z') },
      policy: policyRow({
        outbound_mode: 'approval_required',
        limits: { per_minute: options.perMinute ?? 5, per_hour: 1000, per_day: 5000, recipients_per_message: 10 },
      }),
      policyVersion: policyVersionRow({ outbound_mode: 'approval_required' }),
      relationships: SEEDS.map(seedRelationship),
      counters: { agentLastMinute: lastMinute, agentLastHour: lastDay, agentLastDay: lastDay, orgRecipientsLastDay: lastDay },
      approvalGrant: grant,
      ...overrides,
    };
  };
  const source: PolicySource = { load: () => Promise.resolve(result()) };
  const test = harness(result());
  const service = { ...test.service, source, now: () => clock.now };
  const transport = {
    send: (request: Parameters<typeof test.transport.send>[0]) => {
      sends.push(clock.now);
      return test.transport.send(request);
    },
  };

  const token = issuedToken();
  const response = await handleTransitionAnnouncement(
    { tokens: token.store, service, seeds: { listSeedContacts: () => Promise.resolve(SEEDS) } },
    {
      headers: { authorization: `Bearer ${token.plaintext}`, 'idempotency-key': 'announce-1' },
      query: {},
      body: { agent_id: AGENT_ID, from: AGENT_ADDRESS, owner_name: '진윤겸' },
    },
  );
  if (response.status !== 202) throw new Error(`공지가 승인 대기가 아니다: ${String(response.status)}`);
  const approvalId = response.body['approval_id'] as string;
  const request = approvedRequest(approvalId);
  grant = { request, recipients: SEEDS };
  const items = test.audit.rows.map((row, index) => ({
    ...item(approvalId, row.messageId as string, `audit-${String(index + 1)}`),
    recipients: row.approval?.envelope.recipients as readonly string[],
  }));
  const approvals = approvedWithSchedule(request, items);
  const deps = { service, approvals, transport };
  return {
    test,
    approvals,
    clock,
    sends,
    setOverrides: (next) => {
      overrides = next;
    },
    release: () => runApprovalRelease(deps, { approvalId, traceId: null }),
    sweep: () => runApprovalReleaseSweep(deps),
  };
}

function kinds(outcomes: readonly { readonly kind: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome.kind] = (counts[outcome.kind] ?? 0) + 1;
  return counts;
}

describe('workers/approval-release — 일시적 거부는 닫지 않고 미룬다 (T3 결함)', () => {
  it('분당 5 · 20통 → 첫 실행: 5 발송 · 1 거부 판정(미룸) · 14 페이싱 — 대기 행 15개는 아무도 닫지 않았다', async () => {
    const rig = await announcedRig();
    const outcomes = await rig.release();

    expect(kinds(outcomes)).toEqual({ sent: 5, deferred: 15 });
    expect(rig.test.transport.calls()).toBe(5);
    // **거부 판정은 1건** — 6번째만 관문에 섰고 나머지 14건은 서지 않았다(페이싱).
    const deferred = outcomes.filter((outcome) => outcome.kind === 'deferred');
    expect(deferred.filter((outcome) => outcome.kind === 'deferred' && !outcome.paced)).toHaveLength(1);
    expect(deferred.every((outcome) => outcome.kind === 'deferred' && outcome.reason === 'rate_limit_per_minute')).toBe(true);
    // 대기 행은 5개만 `released` 로 갱신됐다 — `release_denied` 는 0.
    expect(rig.test.audit.pendingResolutions.map((entry) => entry.resolution.kind)).toEqual(Array(5).fill('released'));
    // messages 행 15개는 `pending` 그대로다 — `denied` 로 굳지 않았다.
    const pending = rig.approvals.releases.filter((row) => row.status === 'scheduled');
    expect(pending).toHaveLength(15);
    for (const row of pending) {
      expect((await rig.test.service.messages.findById(row.messageId))?.status).toBe('pending');
      // 다음 시도는 61초 뒤(retry_after 60 + 경계 여유 1) — 창 안이다.
      expect(row.nextReleaseAt).toEqual(new Date(NOW.getTime() + 61_000));
      expect(row.lastDeferralReason).toBe('rate_limit_per_minute');
    }
  });

  it('시간이 흐르면 20통 전부 나간다 — 분마다 5통, 4라운드 · release_denied 0 · 새 audit 행 0', async () => {
    const rig = await announcedRig();
    for (let round = 0; round < 10 && rig.test.transport.calls() < 20; round += 1) {
      await rig.sweep();
      rig.clock.now = new Date(rig.clock.now.getTime() + 61_000);
    }
    expect(rig.test.transport.calls()).toBe(20);
    expect(rig.sends.map((at) => at.getTime() - NOW.getTime())).toEqual(
      [0, 61_000, 122_000, 183_000].flatMap((offset) => Array(5).fill(offset)),
    );
    expect(rig.test.audit.rows).toHaveLength(20);
    expect(rig.test.audit.pendingResolutions.every((entry) => entry.resolution.kind === 'released')).toBe(true);
    expect(rig.approvals.releases.every((row) => row.status === 'settled' && row.settledOutcome === 'sent')).toBe(true);
  });

  it('기한 전의 항목은 다시 집히지 않는다 — 깨우기가 페이싱을 무너뜨리지 않는다', async () => {
    const rig = await announcedRig();
    await rig.release();
    const again = await rig.release();
    expect(again).toEqual([]);
    expect(rig.test.transport.calls()).toBe(5);
  });

  it('영구 거부는 곧바로 닫는다 — 재예약하면 억제된 상대에게 48시간 동안 재시도한다(무한 루프의 모양)', async () => {
    const rig = await announcedRig();
    // 승인과 릴리스 사이에 20명 전원이 억제 목록에 올랐다.
    rig.setOverrides({ suppressions: SEEDS.map((seed) => suppressionRow(seed)) });
    const outcomes = await rig.release();
    expect(kinds(outcomes)).toEqual({ denied: 20 });
    expect(rig.test.audit.pendingResolutions.map((entry) => entry.resolution)).toEqual(
      Array(20).fill({ kind: 'denied', reason: 'release_denied:suppression_list' }),
    );
    expect(rig.approvals.releases.every((row) => row.status === 'settled' && row.settledOutcome === 'denied')).toBe(true);
    for (const row of rig.approvals.releases) {
      expect((await rig.test.service.messages.findById(row.messageId))?.status).toBe('denied');
    }
    expect(await rig.sweep()).toEqual([]);
  });

  it('창 끝 — 일시적 거부가 끝까지 풀리지 않으면 `release_denied:<사유>` 로 닫고 더는 집지 않는다', async () => {
    // 예산이 소진된 채로 소유자가 올리지 않는다.
    const rig = await announcedRig();
    rig.setOverrides({ monthToDateSpentCents: 10_000_000 });
    const first = await rig.release();
    expect(kinds(first)).toEqual({ deferred: 20 });
    const firstRetry = rig.approvals.releases[0]?.nextReleaseAt as Date;
    // 예산은 규칙이 retry_after 를 주지 않는다 — 분류표의 fallback(1시간) + 여유 1초.
    expect(firstRetry).toEqual(new Date(NOW.getTime() + HOUR_MS + 1000));

    const deadline = new Date(NOW.getTime() + APPROVAL_RELEASE_WINDOW_HOURS * HOUR_MS);
    let rounds = 0;
    while (rig.approvals.releases.some((row) => row.status === 'scheduled') && rounds < 200) {
      const due = Math.min(...rig.approvals.releases.filter((row) => row.status === 'scheduled').map((row) => row.nextReleaseAt.getTime()));
      rig.clock.now = new Date(due);
      await rig.sweep();
      rounds += 1;
    }
    // 재시도 시각은 창 끝을 넘지 않는다 — 마지막 라운드가 정확히 창 끝이다.
    expect(rig.clock.now).toEqual(deadline);
    expect(rounds).toBe(APPROVAL_RELEASE_WINDOW_HOURS);
    expect(rig.test.transport.calls()).toBe(0);
    expect(rig.test.audit.pendingResolutions.map((entry) => entry.resolution)).toEqual(
      Array(20).fill({ kind: 'denied', reason: 'release_denied:budget_exhausted' }),
    );
    expect(await rig.sweep()).toEqual([]);
  });

  it('창 안에서 풀리면 나간다 — 소유자가 예산을 올렸다', async () => {
    const rig = await announcedRig({ perMinute: 100 });
    rig.setOverrides({ monthToDateSpentCents: 10_000_000 });
    expect(kinds(await rig.release())).toEqual({ deferred: 20 });
    rig.setOverrides({});
    rig.clock.now = new Date(NOW.getTime() + HOUR_MS + 1000);
    expect(kinds(await rig.sweep())).toEqual({ sent: 20 });
  });

  it('창 끝 항목은 페이싱으로 건너뛰지 않는다 — 마지막 재평가를 받는다', async () => {
    const rig = await announcedRig();
    rig.clock.now = new Date(NOW.getTime() + APPROVAL_RELEASE_WINDOW_HOURS * HOUR_MS);
    const outcomes = await rig.release();
    // 5통은 나가고, 나머지 15통은 **각자** 창 끝의 재평가를 받아 닫힌다(페이싱으로 미뤄지면 창 밖으로 샌다).
    expect(kinds(outcomes)).toEqual({ sent: 5, denied: 15 });
    expect(outcomes.some((outcome) => outcome.kind === 'deferred')).toBe(false);
  });

  it('lease 를 남이 쥐고 있으면 일정을 닫지 않는다 — lease TTL 뒤에 다시 본다', async () => {
    const rig = await announcedRig({ perMinute: 100 });
    const [first] = rig.approvals.releases;
    if (first === undefined) throw new Error('일정이 없다');
    // 다른 워커가 이 항목의 lease 를 잡았다(전송 중).
    await rig.test.service.dispatchStore.acquire({ messageId: first.messageId, leaseId: 'other', now: NOW, ttlSeconds: 300 });
    const outcomes = await rig.release();
    expect(outcomes[0]?.kind).toBe('replayed');
    expect(first.status).toBe('scheduled');
    expect(first.lastDeferralReason).toBe(RELEASE_LEASE_HELD);
    expect(first.nextReleaseAt).toEqual(new Date(NOW.getTime() + 300_000));
  });

  it('lease 재예약에도 창이 있다 — 창 끝 + 유예를 넘기면 일정을 닫는다(무한 재예약 없음, V1 MINOR-5)', async () => {
    const rig = await announcedRig({ perMinute: 100 });
    const [first] = rig.approvals.releases;
    if (first === undefined) throw new Error('일정이 없다');
    const closedAt = new Date(NOW.getTime() + APPROVAL_RELEASE_WINDOW_HOURS * HOUR_MS + RELEASE_WINDOW_GRACE_SECONDS * 1000);
    // 창 끝 + 유예 직전 — 아직 재예약한다.
    rig.clock.now = new Date(closedAt.getTime() - 1);
    await rig.test.service.dispatchStore.acquire({ messageId: first.messageId, leaseId: 'other', now: rig.clock.now, ttlSeconds: 300 });
    await rig.release();
    expect([first.status, first.lastDeferralReason]).toEqual(['scheduled', RELEASE_LEASE_HELD]);
    // 창이 닫힌 뒤(남의 lease 는 아직 살아 있다) — 관문이 lease 에 닿기 전에 창으로 닫고, 일정도 닫힌다.
    // messages 행은 건드리지 않는다(`dispatching` — 그 결말은 lease 쥔 쪽의 것이다).
    rig.clock.now = new Date(first.nextReleaseAt.getTime());
    await rig.test.service.dispatchStore.acquire({ messageId: first.messageId, leaseId: 'other-2', now: rig.clock.now, ttlSeconds: 300 });
    const outcomes = await rig.release();
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['denied']);
    expect([first.status, first.settledOutcome]).toEqual(['settled', 'denied']);
    expect((await rig.test.service.messages.findById(first.messageId))?.status).toBe('dispatching');
    expect(await rig.sweep()).toEqual([]);
  });
});

describe('workers/approval-release — 창은 허용 쪽에도 있다 (V1 MINOR-1)', () => {
  it('승인 뒤 워커가 멈췄다가 72시간 뒤 스윕 — 재평가는 허용이지만 20통 전부 닫는다(0통 발송)', async () => {
    const rig = await announcedRig({ perMinute: 100 });
    rig.clock.now = new Date(NOW.getTime() + 72 * HOUR_MS);
    const outcomes = await rig.sweep();

    // 대역 저장소는 창 밖 행을 미리 닫지 않는다 — 여기서 닫는 것은 **관문**(`reserveRelease`)이다.
    expect(kinds(outcomes)).toEqual({ denied: 20 });
    expect(rig.test.transport.calls()).toBe(0);
    expect(rig.test.audit.pendingResolutions.map((entry) => entry.resolution)).toEqual(
      Array(20).fill({ kind: 'denied', reason: 'release_denied:release_window_expired' }),
    );
    expect(rig.approvals.releases.every((row) => row.status === 'settled' && row.settledOutcome === 'denied')).toBe(true);
    for (const row of rig.approvals.releases) {
      expect((await rig.test.service.messages.findById(row.messageId))?.status).toBe('denied');
    }
  });

  it('창 끝 + 유예 안의 허용은 나간다 — 창 끝에 잡힌 마지막 재평가가 스윕 지연으로 늦어도 발송한다', async () => {
    const rig = await announcedRig({ perMinute: 100 });
    rig.clock.now = new Date(NOW.getTime() + APPROVAL_RELEASE_WINDOW_HOURS * HOUR_MS + RELEASE_WINDOW_GRACE_SECONDS * 1000 - 1);
    expect(kinds(await rig.sweep())).toEqual({ sent: 20 });
  });

  it('창 끝 + 유예 정각부터는 닫는다 — 경계가 한쪽에만 있다', async () => {
    const rig = await announcedRig({ perMinute: 100 });
    rig.clock.now = new Date(NOW.getTime() + APPROVAL_RELEASE_WINDOW_HOURS * HOUR_MS + RELEASE_WINDOW_GRACE_SECONDS * 1000);
    expect(kinds(await rig.sweep())).toEqual({ denied: 20 });
    expect(rig.test.transport.calls()).toBe(0);
  });
});

describe('§4.3 보조 불변식 감시 — 두 주기 워커가 서로를 잰다 (V1 MINOR-6)', () => {
  it('릴리스 스윕은 끝에 위반 수를 재어 메트릭으로 낸다 — 허용 폭(30분) 전 시각으로 잰다', async () => {
    const lines = captureLog();
    const test = harness();
    const asked: Date[] = [];
    await runApprovalReleaseSweep({
      service: test.service,
      approvals: store({
        countPendingOverdue: (at) => {
          asked.push(at);
          return Promise.resolve(3);
        },
      }),
      transport: test.transport,
    });
    expect(asked).toEqual([new Date(test.service.now().getTime() - PENDING_OVERDUE_TOLERANCE_SECONDS * 1000)]);
    const emitted = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(emitted.some((entry) => entry[METRIC_NAMES.approvalPendingOverdue] === 3)).toBe(true);
    expect(emitted.some((entry) => entry['event'] === 'approval.pending_overdue' && entry['level'] === 'error')).toBe(true);
  });

  it('TTL 스위퍼도 같은 것을 잰다 — 위반이 0 이면 0 을 낸다(결측과 0 은 다르다)', async () => {
    const lines = captureLog();
    await runApprovalExpiry({ approvals: store({}), now: () => NOW });
    const emitted = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(emitted.some((entry) => entry[METRIC_NAMES.approvalPendingOverdue] === 0)).toBe(true);
    expect(emitted.some((entry) => entry['event'] === 'approval.pending_overdue')).toBe(false);
  });
});

// 2026-09-24 최종 검증 L2 — 스니펫 보존 스윕이 건너뛴(거부된) 행 수를 매 스윕 메트릭으로 낸다(알람 11).
describe('runSnippetRetention — 막힌 행 메트릭 (L2)', () => {
  const emitted = (lines: readonly string[]): unknown[] =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => METRIC_NAMES.snippetRetentionStuck in record)
      .map((record) => record[METRIC_NAMES.snippetRetentionStuck]);

  it('막힌 행이 있으면 그 수를 내고 error 로그에 첫 행 id — 비운 수를 돌려준다', async () => {
    const lines = captureLog();
    const stuckId = '00000000-0000-4000-8000-00000000abcd';
    const cleared = await runSnippetRetention({ snippets: { sweep: () => Promise.resolve({ cleared: 4, stuckIds: [stuckId, 'x'] }) } });
    expect(cleared).toBe(4);
    expect(emitted(lines)).toEqual([2]);
    expect(lines.some((line) => line.includes('snippet_retention.stuck') && line.includes(stuckId))).toBe(true);
  });

  it('막힌 행이 없으면 0 을 낸다(결측이 아니다) · error 로그 없음', async () => {
    const lines = captureLog();
    await runSnippetRetention({ snippets: { sweep: () => Promise.resolve({ cleared: 0, stuckIds: [] }) } });
    expect(emitted(lines)).toEqual([0]);
    expect(lines.some((line) => line.includes('snippet_retention.stuck'))).toBe(false);
  });
});

describe('workers/approval-release — 첨부 서비스 없는 조립은 fail-closed (보안 리뷰 L6)', () => {
  it('첨부가 결속된 메일을 첨부 서비스 없이 릴리스하지 않는다 — 던지고 전송단 0회', async () => {
    const rig = await announcedRig();
    expect(rig.test.service.attachments).toBeUndefined();
    const content = rig.test.service.content as { load: (messageId: string) => ReturnType<typeof rig.test.service.content.load> };
    const original = content.load.bind(content);
    content.load = async (messageId) => ({
      ...(await original(messageId)),
      attachments: [
        { position: 0, filename: 'a.pdf', mimeType: 'application/pdf', bytes: 4, sha256: 'a'.repeat(64), key: 'outbound/attachments/x', data: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
      ],
    });
    await expect(rig.release()).rejects.toThrow(/첨부 서비스가 조립되지 않았다/);
    expect(rig.test.transport.calls()).toBe(0);
  });

  it('첨부 없는 메일은 첨부 서비스 없이도 그대로 릴리스된다', async () => {
    const rig = await announcedRig();
    expect(rig.test.service.attachments).toBeUndefined();
    const outcomes = await rig.release();
    expect(outcomes.some((outcome) => outcome.kind === 'sent')).toBe(true);
  });
});
