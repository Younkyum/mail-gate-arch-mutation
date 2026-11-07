/**
 * test/integration/outbound/support/fakes.ts — 발송 경로를 **DB 없이** 끝까지 구동하는 지반.
 *
 * `test/integration/db/**` 와 달리 이 층은 `TEST_DATABASE_URL` 을 요구하지 않는다.
 * 이유는 편의가 아니라 **이 층이 증명하는 명제가 DB 의 명제가 아니기 때문**이다:
 * Layer D 는 *"매니페스트의 모든 경로가, 모든 거부 축에서, SES 호출 0회로 막히고
 * audit 행을 정확히 1개 남긴다"* 를 본다. 그 명제는 라우트 → 관문 → 전송단의 배선에
 * 관한 것이고, 배선은 Postgres 없이도 참이거나 거짓이다.
 *
 * **반대로 DB 가 있어야만 참인 것들은 여기서 증명하지 않는다** — 조건부 UPDATE lease 의
 * 경합, `(agent_id, idempotency_key)` 유니크, 상태 전이 트리거. 그것들은
 * `test/integration/db/dispatch.test.ts`(worker-1)와 `demo:p1b` 의 몫이다.
 * 가짜 저장소로 그 성질을 "증명" 하면 그 증명은 가짜의 성질을 증명한 것이다.
 */

import { entitlementRow } from '../../../support/entitlements';
import { randomUUID } from 'node:crypto';

import type { MessageContentStore } from '../../../../src/api/content-store';
import { createInMemoryContentStore } from '../../../../src/api/content-store';
import type {
  OutboundInsertOutcome,
  OutboundMessageInsert,
  OutboundMessageSnapshot,
  OutboundMessageStore,
} from '../../../../src/api/outbound-store';
import type { OutboundServiceDependencies } from '../../../../src/api/outbound-service';
import { APPROVAL_RELEASE_WINDOW_HOURS, type ApprovalStore } from '../../../../src/approval/service';
import type { MessageDispatchStore } from '../../../../src/db/repositories/lease-store';
import type { ReplyTarget, ReplyTargetLookup } from '../../../../src/db/repositories/reply-target-store';
import {
  toAgentId,
  type AgentId,
  type AgentPolicyRow,
  type AgentRow,
  type ApprovalRequestItemRow,
  type ApprovalRequestRow,
  type ContactRuleRow,
  type MessageStatus,
  type OrganizationRow,
  type OutboundMessageStatus,
  type PolicyVersionRow,
  type SuppressionEntryRow,
} from '../../../../src/db/schema';
import type { AgentTokenRecord, AgentTokenStore } from '../../../../src/identity/agent-token';
import { hashAgentToken, issueAgentToken } from '../../../../src/identity/agent-token';
import { unserialized } from '../../../../src/policy/gate';
import type {
  AuditEntry,
  AuditSink,
  LeaseRequest,
  OutboundTransport,
  PendingAuditTarget,
  PendingResolution,
  TransportRequest,
} from '../../../../src/policy/gate';
import type { PolicySource, PolicySourceResult } from '../../../../src/policy/policy-loader';
import { inertDlp, inertRiskSignals } from '../../../support/injection-doubles';

export const AGENT_ID: AgentId = toAgentId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
export const ORG_ID = '11111111-1111-4111-8111-111111111111';
export const POLICY_VERSION_ID = '22222222-2222-4222-8222-222222222222';
export const AGENT_ADDRESS = 'demo-agent@atmark.ai';
export const ALLOWED_RECIPIENT = 'friend@example.com';
export const FOREIGN_ADDRESS = 'someone-else@atmark.ai';

/** 고정 시각. 워밍업 캡 계산이 "오늘" 에 흔들리면 테스트가 날짜마다 다르게 돈다. */
export const NOW = new Date('2026-10-15T12:00:00.000Z');

// ---------------------------------------------------------------------------
// 행 픽스처
// ---------------------------------------------------------------------------

export function organizationRow(overrides: Partial<OrganizationRow> = {}): OrganizationRow {
  return {
    id: ORG_ID,
    name: 'Atmark test org',
    ses_tenant_id: null,
    billing_status: 'active',
    abuse_freeze: false,
    owner_paused: false,
    review_status: 'active',
    // `null` = "아직 한 통도 성공적으로 보낸 적이 없다" → 워밍업 Day 0 캡(20 수신자).
    sending_started_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: AGENT_ID,
    organization_id: ORG_ID,
    name: 'test-agent',
    status: 'active',
    plan: 'free',
    monthly_budget_cents: 10_000,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function policyRow(overrides: Partial<AgentPolicyRow> = {}): AgentPolicyRow {
  return {
    agent_id: AGENT_ID,
    outbound_mode: 'allowlist_only',
    inbound_mode: 'all',
    require_approval: false,
    limits: { per_minute: 10, per_hour: 100, per_day: 500, recipients_per_message: 10 },
    config_json: {
      max_attachment_bytes_total: 5_000_000,
      allowed_mime_types: ['application/pdf'],
    },
    current_version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

/** 규칙들 → 버전 스냅샷(`contact_rules`). 관문은 목록을 스냅샷에서 읽는다(202609241040). */
export function rulesSnapshot(rules: readonly ContactRuleRow[]): PolicyVersionRow['snapshot'] {
  return {
    contact_rules: rules.map(({ id, direction, list, kind, value }) => ({ id, direction, list, kind, value })),
  };
}

/** 기본 버전 행 — 스냅샷의 발신 allow 목록은 `ALLOWED_RECIPIENT` 하나. */
export function policyVersionRow(overrides: Partial<PolicyVersionRow> = {}): PolicyVersionRow {
  return {
    id: POLICY_VERSION_ID,
    agent_id: AGENT_ID,
    version: 1,
    outbound_mode: 'allowlist_only',
    inbound_mode: 'all',
    snapshot: rulesSnapshot([contactRuleRow('outbound', 'allow', ALLOWED_RECIPIENT)]),
    created_by: null,
    created_at: NOW,
    ...overrides,
  };
}

export function suppressionRow(address: string): SuppressionEntryRow {
  return {
    id: randomUUID(),
    organization_id: ORG_ID,
    address,
    domain: address.slice(address.lastIndexOf('@') + 1),
    source: 'bounce',
    reason: 'hard bounce',
    expires_at: null,
    created_at: NOW,
  };
}

/** 연락처 규칙 한 행(정책 v2). 값의 종류는 `@` 로 정한다(`contact-rules.ts`). */
export function contactRuleRow(
  direction: ContactRuleRow['direction'],
  list: ContactRuleRow['list'],
  value: string,
): ContactRuleRow {
  return {
    id: randomUUID(),
    agent_id: AGENT_ID,
    direction,
    list,
    kind: value.includes('@') ? 'address' : 'domain',
    value,
    created_at: NOW,
    created_by: null,
    removed_at: null,
    removed_by: null,
  };
}

/** `PolicySource` 가 돌려줄 한 벌. 거부 축마다 이 객체의 **한 축만** 비튼다. 발신 allow 목록은 `ALLOWED_RECIPIENT` 하나. */
export function sourceResult(overrides: Partial<PolicySourceResult> = {}): PolicySourceResult {
  return {
    entitlements: entitlementRow('beta'),
    organization: organizationRow(),
    agent: agentRow(),
    addresses: [
      {
        id: 'addr-1',
        agent_id: AGENT_ID,
        address: AGENT_ADDRESS,
        domain: 'atmark.ai',
        is_primary: true,
        created_at: NOW,
      },
    ],
    policy: policyRow(),
    policyVersion: policyVersionRow(),
    suppressions: [],
    counters: { agentLastMinute: 0, agentLastHour: 0, agentLastDay: 0, orgRecipientsLastDay: 0 },
    monthToDateSpentCents: 0,
    relationships: [],
    approvalGrant: null,
    outboundSentCount: 0,
    agentRequestedRuleIds: [],
    // 고객 도메인(ADR-0014) — 에이전트 주소가 전부 atmark.ai 라 소스가 고객 도메인 행을 주지 않는다.
    inactiveAddresses: [],
    customDomains: [],
    thread: null,
    ...overrides,
  };
}

export function fixedSource(result: PolicySourceResult): PolicySource {
  return { load: () => Promise.resolve(result) };
}

// ---------------------------------------------------------------------------
// 가짜 저장소
// ---------------------------------------------------------------------------

export interface RecordingAudit extends AuditSink {
  readonly rows: AuditEntry[];
  readonly resolutions: { readonly auditId: string; readonly outcome: 'sent' | 'failed'; readonly reason: string | null }[];
  /** 릴리스가 `pending_approval` 행에 적은 결말. **새 행이 아니라 기존 행의 갱신**이다(§4.3). */
  readonly pendingResolutions: { readonly target: PendingAuditTarget; readonly resolution: PendingResolution }[];
}

function recordingAudit(): RecordingAudit {
  const rows: AuditEntry[] = [];
  const resolutions: { auditId: string; outcome: 'sent' | 'failed'; reason: string | null }[] = [];
  const pendingResolutions: { target: PendingAuditTarget; resolution: PendingResolution }[] = [];
  return {
    rows,
    resolutions,
    pendingResolutions,
    record(entry: AuditEntry): Promise<string> {
      rows.push(entry);
      return Promise.resolve(`audit-${String(rows.length)}`);
    },
    resolvePending(target: PendingAuditTarget, resolution: PendingResolution): Promise<boolean> {
      // 실제 구현의 조건부 UPDATE 를 흉내 낸다 — 그 행이 `pending_approval` 로 **기록된 적이 있고**
      // 아직 해소되지 않았을 때만 `true`. 가짜가 무조건 `true` 면 "행 없는 릴리스" 가 통과한다.
      const index = Number(target.auditId.replace('audit-', '')) - 1;
      const row = rows[index];
      const alreadyResolved = pendingResolutions.some((entry) => entry.target.auditId === target.auditId);
      const ok =
        row !== undefined &&
        row.decision.verdict === 'pending_approval' &&
        row.approval?.approvalId === target.approvalId &&
        row.messageId === target.messageId &&
        !alreadyResolved;
      if (ok) pendingResolutions.push({ target, resolution });
      return Promise.resolve(ok);
    },
    resolve(auditId: string, outcome: 'sent' | 'failed', reason: string | null): Promise<void> {
      resolutions.push({ auditId, outcome, reason });
      return Promise.resolve();
    },
  };
}

interface FakeMessageRow {
  id: string;
  agentId: AgentId;
  status: OutboundMessageStatus;
  messageIdHeader: string;
  idempotencyKey: string;
  requestHash: string;
  recipientCount: number;
  sesMessageId: string | null;
  failureReason: string | null;
  leaseId: string | null;
}

/**
 * `messages` 의 인메모리 대역 — 저장소와 lease 를 **같은 맵** 위에 둔다.
 *
 * 실제로도 같은 테이블이다. 둘을 따로 두면 "lease 는 잡혔는데 행은 없다" 같은
 * 실제로는 불가능한 상태가 테스트에서만 가능해지고, 그 상태에서 통과한 코드는
 * DB 위에서 처음 실패한다.
 */
export interface FakeMessageStore {
  readonly messages: OutboundMessageStore;
  readonly dispatchStore: MessageDispatchStore;
  rowCount(): number;
  rowsFor(agentId: AgentId, idempotencyKey: string): number;
}

function fakeMessageStore(): FakeMessageStore {
  const rows = new Map<string, FakeMessageRow>();
  const byKey = new Map<string, string>();

  const snapshot = (row: FakeMessageRow): OutboundMessageSnapshot => ({
    id: row.id,
    agentId: row.agentId,
    status: row.status,
    messageIdHeader: row.messageIdHeader,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    recipientCount: row.recipientCount,
    sesMessageId: row.sesMessageId,
    failureReason: row.failureReason,
    // 이 대역은 audit 을 보지 못한다 — "관문 앞에서 멈춘 행"(202609230510)은 실 Postgres 테스트가 본다. 여기서는
    // 모든 행을 관문을 지난 것으로 두어 재호출이 예전처럼 재생되게 한다.
    gated: true,
  });

  const messages: OutboundMessageStore = {
    insertOrReplay(input: OutboundMessageInsert): Promise<OutboundInsertOutcome> {
      if (input.recipientCount < 1) {
        // DB CHECK `messages_outbound_has_recipients` 와 같은 명제.
        return Promise.reject(new Error('recipient_count >= 1 이어야 한다'));
      }
      const key = `${input.agentId}::${input.idempotencyKey}`;
      const existingId = byKey.get(key);
      if (existingId !== undefined) {
        const existing = rows.get(existingId);
        if (existing === undefined) throw new Error('인덱스와 행이 어긋났다');
        return Promise.resolve({ kind: 'replayed', message: snapshot(existing) });
      }
      const row: FakeMessageRow = {
        id: randomUUID(),
        agentId: input.agentId,
        status: 'pending',
        messageIdHeader: input.messageIdHeader,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        recipientCount: input.recipientCount,
        sesMessageId: null,
        failureReason: null,
        leaseId: null,
      };
      rows.set(row.id, row);
      byKey.set(key, row.id);
      return Promise.resolve({ kind: 'inserted', message: snapshot(row) });
    },

    findById(messageId: string): Promise<OutboundMessageSnapshot | null> {
      const row = rows.get(messageId);
      return Promise.resolve(row === undefined ? null : snapshot(row));
    },

    claimUngated(): Promise<number | null> {
      return Promise.resolve(null);
    },

    releaseClaim(): Promise<void> {
      return Promise.resolve();
    },
  };

  const dispatchStore: MessageDispatchStore = {
    acquire(request: LeaseRequest): Promise<boolean> {
      const row = rows.get(request.messageId);
      if (row === undefined || row.status !== 'pending') return Promise.resolve(false);
      row.status = 'dispatching';
      row.leaseId = request.leaseId;
      return Promise.resolve(true);
    },
    statusOf(messageId: string): Promise<MessageStatus> {
      const row = rows.get(messageId);
      if (row === undefined) return Promise.reject(new Error(`messages 행이 없다 (id=${messageId})`));
      return Promise.resolve(row.status);
    },
    settleSent(messageId: string, leaseId: string, sesMessageId: string): Promise<boolean> {
      const row = rows.get(messageId);
      // `lease_id` 가 WHERE 에 있는 것이 실제 구현의 요점이므로 여기서도 대조한다.
      if (row === undefined || row.leaseId !== leaseId || row.status !== 'dispatching') {
        return Promise.resolve(false);
      }
      row.status = 'sent';
      row.sesMessageId = sesMessageId;
      return Promise.resolve(true);
    },
    settleFailed(messageId: string, leaseId: string, reason: string): Promise<boolean> {
      const row = rows.get(messageId);
      if (row === undefined || row.leaseId !== leaseId || row.status !== 'dispatching') {
        return Promise.resolve(false);
      }
      row.status = 'failed';
      row.failureReason = reason;
      return Promise.resolve(true);
    },
    settleDenied(messageId: string): Promise<boolean> {
      const row = rows.get(messageId);
      // lease 를 잡은 적이 없는 시도다 — `leaseId` 대조가 없는 대신 `pending` 을 요구한다.
      // 그 사이에 누가 lease 를 잡았다면 그 시도는 이미 나가고 있고, 되돌리면 거짓말이다.
      if (row === undefined || row.status !== 'pending') return Promise.resolve(false);
      row.status = 'denied';
      return Promise.resolve(true);
    },
  };

  return {
    messages,
    dispatchStore,
    rowCount: () => rows.size,
    rowsFor: (agentId, idempotencyKey) => (byKey.has(`${agentId}::${idempotencyKey}`) ? 1 : 0),
  };
}

/** 호출 횟수를 세는 전송단. **AC-5 의 "SES 호출 0회" 는 이 숫자로 판정한다.** */
export interface CountingTransport extends OutboundTransport {
  calls(): number;
}

export function countingTransport(): CountingTransport {
  let count = 0;
  return {
    calls: () => count,
    send(request: TransportRequest): Promise<{ readonly sesMessageId: string }> {
      count += 1;
      return Promise.resolve({ sesMessageId: `fake-ses-${request.messageId}` });
    },
  };
}

// ---------------------------------------------------------------------------
// 토큰
// ---------------------------------------------------------------------------

export interface IssuedToken {
  readonly plaintext: string;
  readonly store: AgentTokenStore;
}

/** 실제 발급 함수를 쓴다 — 형식·해시 규칙을 테스트가 따로 베끼지 않기 위해서다. */
export function issuedToken(agentId: AgentId = AGENT_ID): IssuedToken {
  const token = issueAgentToken(agentId);
  const record: AgentTokenRecord = {
    tokenHash: token.tokenHash,
    agentId,
    capabilities: token.capabilities,
    revokedAt: null,
    expiresAt: null,
  };
  return {
    plaintext: token.plaintext,
    store: {
      findByHash: (hash) => Promise.resolve(hash === hashAgentToken(token.plaintext) ? record : null),
    },
  };
}

// ---------------------------------------------------------------------------
// 조립
// ---------------------------------------------------------------------------

export interface OutboundHarness {
  readonly service: OutboundServiceDependencies;
  readonly audit: RecordingAudit;
  readonly transport: CountingTransport;
  readonly content: MessageContentStore;
  readonly store: FakeMessageStore;
}

export function harness(result: PolicySourceResult = sourceResult()): OutboundHarness {
  const audit = recordingAudit();
  const store = fakeMessageStore();
  const content = createInMemoryContentStore();
  return {
    audit,
    store,
    content,
    transport: countingTransport(),
    service: {
      source: fixedSource(result),
      audit,
      dispatchStore: store.dispatchStore,
      serializer: unserialized(),
      // 이 하네스에는 SES 가 없으므로 이벤트도 없다. **`null` 은 "조회는 됐고 증거가
      // 없다" 이지 "모른다" 가 아니다** — 관문은 둘을 다르게 다룬다(ADR-0004). 여기서
      // 던지면 lease 만료 경로의 테스트가 전부 `unknown` 으로 빨려 들어가 재전송
      // 판단 자체가 실행되지 않는다. 그 축을 보는 테스트는 자기 조회를 주입한다.
      sendEvidence: { findSendEvidence: () => Promise.resolve(null) },
      messages: store.messages,
      content,
      leaseTtlSeconds: 300,
      riskSignals: inertRiskSignals(),
      dlp: inertDlp(),
      now: () => NOW,
    },
  };
}

// ---------------------------------------------------------------------------
// 회신 대상 조회 (P3b `routes/reply.ts`)
// ---------------------------------------------------------------------------

export const REPLY_INBOUND_ID = '66666666-6666-4666-8666-666666666666';
export const REPLY_THREAD_ID = '77777777-7777-4777-8777-777777777777';

/**
 * `AGENT_ID` 의 수신 메일 `REPLY_INBOUND_ID` 하나만 아는 조회. **권한을 주지 않는다** — 이 하네스의 정책 소스는
 * 스레드 사실을 주지 않으므로(`sourceResult().thread === null`), 회신이어도 관문은 스레드 회신으로 보지 않는다.
 */
export function fakeReplyTargets(
  fromAddress: string = ALLOWED_RECIPIENT,
  overrides: Partial<ReplyTarget> = {},
): ReplyTargetLookup {
  const target: ReplyTarget = {
    inboundMessageId: REPLY_INBOUND_ID,
    threadId: REPLY_THREAD_ID,
    fromAddress,
    fromAuthenticated: true,
    subject: '견적 문의',
    messageIdHeader: '<parent-1@partner.example>',
    inReplyTo: '<grand-1@atmark.ai>',
    quarantined: false,
    ...overrides,
  };
  return {
    find: (agentId, inboundMessageId) =>
      Promise.resolve(agentId === AGENT_ID && inboundMessageId === REPLY_INBOUND_ID ? target : null),
  };
}

// ---------------------------------------------------------------------------
// 릴리스 일정 (`approval_releases`) 의 인메모리 대역 — P2 수정
// ---------------------------------------------------------------------------

/** 인메모리 일정 행 하나. 실제 테이블의 가변 컬럼만 둔다. */
export interface FakeReleaseRow {
  readonly approvalId: string;
  readonly messageId: string;
  readonly auditId: string;
  readonly agentId: AgentId;
  readonly deadlineAt: Date;
  status: 'scheduled' | 'settled';
  claimCount: number;
  nextReleaseAt: Date;
  lastDeferralReason: string | null;
  settledOutcome: string | null;
}

export type FakeApprovals = Pick<
  ApprovalStore,
  'find' | 'items' | 'claimDueReleases' | 'deferRelease' | 'settleRelease' | 'countPendingOverdue'
> & { readonly releases: FakeReleaseRow[] };

/**
 * 승인된 요청 하나 + 그 항목들 + **승인 전이 트리거가 만들었을** 일정 행들.
 *
 * 실제로는 `approval_requests_schedule_release` 트리거가 `decided_at` / `decided_at + 48h` 로 만든다. 대역이
 * 같은 값을 쓰도록 창은 `APPROVAL_RELEASE_WINDOW_HOURS` 를 읽는다(그 상수와 SQL 은 통합 테스트가 맞붙인다).
 * 집기의 순서·임대·`scheduled` 조건은 Postgres 구현(`approval-store.ts`)과 같은 규칙이다.
 */
export function approvedWithSchedule(
  request: ApprovalRequestRow,
  items: readonly ApprovalRequestItemRow[],
): FakeApprovals {
  const decidedAt = request.decided_at ?? request.created_at;
  const releases: FakeReleaseRow[] = items.map((item) => ({
    approvalId: item.approval_id,
    messageId: item.message_id,
    auditId: item.audit_id,
    agentId: request.agent_id,
    deadlineAt: new Date(decidedAt.getTime() + APPROVAL_RELEASE_WINDOW_HOURS * 3_600_000),
    status: 'scheduled',
    claimCount: 0,
    nextReleaseAt: decidedAt,
    lastDeferralReason: null,
    settledOutcome: null,
  }));
  const rowOf = (messageId: string): FakeReleaseRow | undefined =>
    releases.find((row) => row.messageId === messageId && row.status === 'scheduled');
  return {
    releases,
    find: (approvalId) => Promise.resolve(approvalId === request.id ? request : null),
    items: (approvalId) => Promise.resolve(items.filter((item) => item.approval_id === approvalId)),
    claimDueReleases(claim) {
      const due = releases
        .filter(
          (row) =>
            row.status === 'scheduled' &&
            row.nextReleaseAt.getTime() <= claim.now.getTime() &&
            (claim.approvalId === null || row.approvalId === claim.approvalId),
        )
        .sort((left, right) => left.nextReleaseAt.getTime() - right.nextReleaseAt.getTime())
        .slice(0, claim.limit);
      for (const row of due) {
        row.claimCount += 1;
        row.nextReleaseAt = new Date(claim.now.getTime() + claim.leaseSeconds * 1000);
      }
      return Promise.resolve(
        due.map((row) => ({
          approvalId: row.approvalId,
          messageId: row.messageId,
          auditId: row.auditId,
          agentId: row.agentId,
          deadlineAt: row.deadlineAt,
          claimCount: row.claimCount,
        })),
      );
    },
    deferRelease(messageId, until, reason) {
      const row = rowOf(messageId);
      if (row !== undefined) {
        row.nextReleaseAt = until;
        row.lastDeferralReason = reason;
      }
      return Promise.resolve();
    },
    settleRelease(messageId, outcome) {
      const row = rowOf(messageId);
      if (row !== undefined) {
        row.status = 'settled';
        row.settledOutcome = outcome;
      }
      return Promise.resolve();
    },
    // 대역은 릴리스 갈래(b)만 안다 — 창 끝을 넘긴 `scheduled` 일정(`audit_pending_overdue` 의 (b) 위반).
    countPendingOverdue: (at) =>
      Promise.resolve(releases.filter((row) => row.status === 'scheduled' && row.deadlineAt.getTime() <= at.getTime()).length),
  };
}
