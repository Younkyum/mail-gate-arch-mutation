/**
 * 관문의 P2 몫 — **승인 요청을 여는 곳**과 **릴리스가 같은 행을 갱신하는 곳** (계획 §4.3 r3-V2).
 *
 * | 사건 | 관문이 하는 일 | 여기서 못 박는 것 |
 * |---|---|---|
 * | 최초 평가 → `pending_approval` | `record` 1회, `approval` 동봉 | lease·전송 0, TTL=정책값 |
 * | 릴리스 → 재평가 허용 | lease → **`resolvePending(released)`** → 전송 | `record` 0회(새 행 없음) |
 * | 릴리스 → 재평가 거부 | **`resolvePending(denied)`** | 전송 0, `record` 0 |
 * | 릴리스 → 요청이 승인 상태가 아님 | **아무것도 쓰지 않는다** | 만료된 요청은 보낼 수 없다 |
 * | 릴리스 → 재평가 **일시적** 거부 | **아무것도 쓰지 않고 미룬다**(`deferral`) | 대기 행 무접촉 · 창 끝이면 닫는다 |
 * | 릴리스 → 정책 읽기·잠금·lease 실패 | 새 행 없이 미룬다 | 대기 행이 영원히 남지 않는다 |
 */

import { entitlementRow } from '../../support/entitlements';
import { describe, expect, it, vi } from 'vitest';

import type { MessageStatus } from '../../../src/db/schema';
import {
  dispatch,
  SerializationUnavailableError,
  unserialized,
  type AuditEntry,
  type DispatchRequest,
  type GateDependencies,
  type PendingAuditTarget,
  type PendingResolution,
  type SendEvidence,
} from '../../../src/policy/gate';
import type { ApprovalGrantSource, PolicySourceResult } from '../../../src/policy/policy-loader';
import type { SenderRelationshipRow } from '../../../src/db/schema';
import { AGENT_ID, NOW, ORG_ID, POLICY_VERSION_ID, baseAttempt, baseCounters } from './fixtures';

vi.mock('../../../src/policy/manifest', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/policy/manifest')>();
  return {
    ...original,
    OUTBOUND_ROUTES: [
      {
        id: 'fixture_send',
        kind: 'http',
        file: 'src/api/routes/fixture-messages.ts',
        ref: 'POST /v1/fixture/messages',
        requiresIdempotencyKey: true,
      },
    ],
  };
});

const STRANGER = 'stranger@example.com';
const APPROVAL_ID = '44444444-4444-4444-8444-444444444444';

function source(overrides: Partial<PolicySourceResult> = {}, ttlSeconds: number | null = null): PolicySourceResult {
  return {
    entitlements: entitlementRow('beta'),
    organization: {
      id: ORG_ID,
      name: 'Atmark',
      ses_tenant_id: null,
      billing_status: 'active',
      abuse_freeze: false,
      owner_paused: false,
      review_status: 'active',
      sending_started_at: new Date('2026-09-01T00:00:00.000Z'),
      created_at: NOW,
      updated_at: NOW,
    },
    agent: {
      id: AGENT_ID,
      organization_id: ORG_ID,
      name: 'demo',
      status: 'active',
      plan: 'free',
      monthly_budget_cents: 10_000,
      created_at: NOW,
      updated_at: NOW,
    },
    addresses: [
      { id: 'addr-1', agent_id: AGENT_ID, address: 'agent@atmark.ai', domain: 'atmark.ai', is_primary: true, created_at: NOW },
    ],
    policy: {
      agent_id: AGENT_ID,
      outbound_mode: 'approval_required',
      inbound_mode: 'all',
      require_approval: false,
      limits: { per_minute: 10, per_hour: 100, per_day: 500, recipients_per_message: 10 },
      config_json: {
        max_attachment_bytes_total: 5_000_000,
        allowed_mime_types: ['application/pdf'],
        allowlist: [],
        blocklist: [],
        ...(ttlSeconds === null ? {} : { approval_ttl_seconds: ttlSeconds }),
      },
      current_version: 1,
      created_at: NOW,
      updated_at: NOW,
    },
    policyVersion: {
      id: POLICY_VERSION_ID,
      agent_id: AGENT_ID,
      version: 1,
      outbound_mode: 'approval_required',
      inbound_mode: 'all',
      snapshot: {},
      created_by: null,
      created_at: NOW,
    },
    suppressions: [],
    counters: baseCounters,
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

function approvedGrant(recipients: readonly string[] = [STRANGER]): ApprovalGrantSource {
  return {
    request: {
      id: APPROVAL_ID,
      agent_id: AGENT_ID,
      subject: 'message',
      status: 'approved',
      created_at: NOW,
      expires_at: new Date(NOW.getTime() + 86_400_000),
      decided_at: NOW,
      decided_by: 'owner@example.com',
      granted_scope: 'recipient',
    },
    recipients,
  };
}

interface Probe {
  readonly deps: GateDependencies;
  readonly records: AuditEntry[];
  readonly pending: { readonly target: PendingAuditTarget; readonly resolution: PendingResolution }[];
  readonly resolutions: string[];
  readonly sends: { count: number };
  readonly leases: { count: number };
}

function probe(options: {
  readonly result: PolicySourceResult;
  readonly status?: MessageStatus;
  readonly resolvePendingReturns?: boolean;
  readonly evidence?: SendEvidence | null;
}): Probe {
  const records: AuditEntry[] = [];
  const pending: { target: PendingAuditTarget; resolution: PendingResolution }[] = [];
  const resolutions: string[] = [];
  const sends = { count: 0 };
  const leases = { count: 0 };
  return {
    records,
    pending,
    resolutions,
    sends,
    leases,
    deps: {
      source: { load: () => Promise.resolve(options.result) },
      audit: {
        record: (entry) => {
          records.push(entry);
          return Promise.resolve(`audit-new-${records.length}`);
        },
        resolve: (auditId, outcome) => {
          resolutions.push(`${auditId}:${outcome}`);
          return Promise.resolve();
        },
        resolvePending: (target, resolution) => {
          pending.push({ target, resolution });
          return Promise.resolve(options.resolvePendingReturns ?? true);
        },
      },
      leases: {
        acquire: () => {
          leases.count += 1;
          return Promise.resolve(true);
        },
        statusOf: () => Promise.resolve(options.status ?? 'pending'),
      },
      transport: {
        send: () => {
          sends.count += 1;
          return Promise.resolve({ sesMessageId: 'ses-1' });
        },
      },
      serializer: unserialized(),
      sendEvidence: { findSendEvidence: () => Promise.resolve(options.evidence ?? null) },
      leaseTtlSeconds: 300,
    },
  };
}

const firstAttempt: DispatchRequest = {
  agentId: AGENT_ID,
  attempt: { ...baseAttempt, recipients: [STRANGER], fromAddress: 'agent@atmark.ai' },
  now: NOW,
  traceId: 'trace-1',
  thisAttemptCostCents: 7,
  messageId: 'msg-1',
  messageIdHeader: '<msg-1@atmark.ai>',
  leaseId: 'lease-1',
  release: null,
};

const releaseAttempt: DispatchRequest = {
  ...firstAttempt,
  leaseId: 'lease-2',
  release: { approvalId: APPROVAL_ID, auditId: 'audit-original', deadlineAt: new Date(NOW.getTime() + 48 * 3_600_000) },
};

describe('관문 — 최초 평가가 승인 대기면 **여기서** 요청을 연다', () => {
  it('audit 1행에 승인 요청이 동봉되고, lease·전송은 없다 (API 는 블로킹하지 않는다, §3.4 1조)', async () => {
    const p = probe({ result: source({}, 7_200) });
    const outcome = await dispatch(p.deps, firstAttempt);

    expect(outcome.kind).toBe('pending_approval');
    expect(p.sends.count).toBe(0);
    expect(p.leases.count).toBe(0);
    expect(p.records).toHaveLength(1);

    const opening = p.records[0]?.approval;
    expect(opening).not.toBeNull();
    // TTL 은 **정책 값**이다(기본 24h 가 아니라 7200 을 줬다). 두 시각은 같은 시계다.
    expect(opening?.createdAt).toEqual(NOW);
    expect(opening?.expiresAt).toEqual(new Date(NOW.getTime() + 7_200_000));
    // 릴리스가 재통과할 봉투 — 사람이 본 그대로.
    expect(opening?.envelope).toEqual({
      fromAddress: 'agent@atmark.ai',
      recipients: [STRANGER],
      isThreadReply: false,
      threadId: null,
      costCents: 7,
    });
    // 응답이 싣는 id 와 audit 에 간 id 가 같다.
    expect(outcome.kind === 'pending_approval' ? outcome.approval?.approvalId : null).toBe(opening?.approvalId);
  });

  it('승인 대기가 아닌 판정은 요청을 열지 않는다 (`approval: null`)', async () => {
    const p = probe({
      result: source({
        relationships: [
          {
            id: 'rel-1',
            agent_id: AGENT_ID,
            scope: 'recipient',
            address: STRANGER,
            domain: null,
            thread_id: null,
            trust_category: 'seed',
            granted_via_approval_id: null,
            granted_by: 'owner_provisioning',
            domain_scope_confirmed_by: null,
            created_at: NOW,
          } satisfies SenderRelationshipRow,
        ],
      }),
    });
    const outcome = await dispatch(p.deps, firstAttempt);
    expect(outcome.kind).toBe('sent');
    expect(p.records[0]?.approval).toBeNull();
    expect(p.records[0]?.decision.reasons).toEqual(['seed_relationship']);
  });

  it('messages 행 없는 승인 대기는 **던진다** — 릴리스할 대상이 없는 요청을 열지 않는다', async () => {
    const p = probe({ result: source() });
    await expect(dispatch(p.deps, { ...firstAttempt, messageId: null })).rejects.toThrow(/messages 행이 없다/);
    expect(p.records).toHaveLength(0);
  });
});

describe('관문 — 릴리스는 새 행을 만들지 않고 같은 행을 갱신한다 (§4.3)', () => {
  it('재평가 허용 → lease → 기존 행을 `released`(approved_by) → 전송 → **같은 행**을 sent 로 해소', async () => {
    const p = probe({ result: source({ approvalGrant: approvedGrant() }) });
    const outcome = await dispatch(p.deps, releaseAttempt);

    expect(outcome.kind).toBe('sent');
    expect(outcome.decision.reasons).toEqual(['approval_granted']);
    expect(p.sends.count).toBe(1);
    // ★ 새 행 0 — 이 한 줄이 "시도당 1행" 의 릴리스 쪽 절반이다.
    expect(p.records).toHaveLength(0);
    expect(p.pending).toEqual([
      {
        target: { auditId: 'audit-original', approvalId: APPROVAL_ID, messageId: 'msg-1' },
        resolution: { kind: 'released', approvedBy: 'owner@example.com' },
      },
    ]);
    expect(p.resolutions).toEqual(['audit-original:sent']);
  });

  it('재평가 거부(그 사이 억제 목록) → 같은 행을 `denied` 로, 전송 0 — 승인은 kill-switch 를 이기지 못한다', async () => {
    const p = probe({
      result: source({
        approvalGrant: approvedGrant(),
        suppressions: [
          {
            id: 's-1',
            organization_id: ORG_ID,
            address: STRANGER,
            domain: 'example.com',
            source: 'complaint',
            reason: null,
            expires_at: null,
            created_at: NOW,
          },
        ],
      }),
    });
    const outcome = await dispatch(p.deps, releaseAttempt);

    expect(outcome.kind).toBe('denied');
    expect(p.sends.count).toBe(0);
    expect(p.leases.count).toBe(0);
    expect(p.records).toHaveLength(0);
    expect(p.pending[0]?.resolution).toEqual({ kind: 'denied', reason: 'release_denied:suppression_list' });
  });

  it('요청이 승인 상태가 아니면(grant 없음) **아무것도 쓰지 않는다** — 만료된 요청은 보낼 수 없다', async () => {
    const p = probe({ result: source({ approvalGrant: null }) });
    const outcome = await dispatch(p.deps, releaseAttempt);

    expect(outcome).toMatchObject({ kind: 'pending_approval', approval: null });
    expect(p.sends.count).toBe(0);
    expect(p.leases.count).toBe(0);
    expect(p.records).toHaveLength(0);
    expect(p.pending).toHaveLength(0);
  });

  it('grant 가 있어도 봉투의 수신자가 승인 밖이면 아무것도 쓰지 않는다', async () => {
    const p = probe({ result: source({ approvalGrant: approvedGrant(['someone-else@example.com']) }) });
    const outcome = await dispatch(p.deps, releaseAttempt);
    expect(outcome).toMatchObject({ kind: 'pending_approval', approval: null });
    expect(p.sends.count + p.records.length + p.pending.length).toBe(0);
  });

  it('갱신할 대기 행이 없으면(누가 먼저 해소했다) lease 를 쥔 채 **보내지 않고** 실패로 끝낸다', async () => {
    const p = probe({ result: source({ approvalGrant: approvedGrant() }), resolvePendingReturns: false });
    const outcome = await dispatch(p.deps, releaseAttempt);

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'approval_release_audit_not_pending' });
    expect(p.sends.count).toBe(0);
    expect(p.records).toHaveLength(0);
  });

  it('릴리스의 lease 만료 재전송 — 이전 워커가 이미 행을 released 로 바꿨다: 같은 행으로 재전송', async () => {
    const p = probe({
      result: source({ approvalGrant: approvedGrant() }),
      status: 'dispatching',
      resolvePendingReturns: false,
      evidence: null,
    });
    const outcome = await dispatch(p.deps, releaseAttempt);

    expect(outcome.kind).toBe('sent');
    expect(p.sends.count).toBe(1);
    expect(p.records).toHaveLength(0);
    expect(p.resolutions).toEqual(['audit-original:sent']);
  });

  it('릴리스의 lease 만료 — 이벤트 증거가 있으면 재전송 없이 **같은 행**을 sent 로', async () => {
    const p = probe({
      result: source({ approvalGrant: approvedGrant() }),
      status: 'dispatching',
      resolvePendingReturns: false,
      evidence: { eventType: 'send', sesMessageId: 'ses-earlier' },
    });
    const outcome = await dispatch(p.deps, releaseAttempt);

    expect(outcome).toMatchObject({ kind: 'sent', sesMessageId: 'ses-earlier' });
    expect(p.sends.count).toBe(0);
    expect(p.records).toHaveLength(0);
    expect(p.resolutions).toEqual(['audit-original:sent']);
  });

  it('messages 행 없는 릴리스는 던진다 — 릴리스는 항상 기존 행을 가리킨다', async () => {
    const p = probe({ result: source({ approvalGrant: approvedGrant() }) });
    await expect(dispatch(p.deps, { ...releaseAttempt, messageId: null })).rejects.toThrow(/릴리스에 messages 행이 없다/);
  });
});

describe('관문 — 릴리스의 일시적 거부는 닫지 않고 미룬다 (P2 수정)', () => {
  const minuteFull = { ...baseCounters, agentLastMinute: 10 };

  it('분당 한도 → `pending_approval` + deferral(61초 뒤) · resolvePending 0 · lease 0 · 새 행 0', async () => {
    const p = probe({ result: source({ approvalGrant: approvedGrant(), counters: minuteFull }) });
    const outcome = await dispatch(p.deps, releaseAttempt);

    expect(outcome.kind).toBe('pending_approval');
    if (outcome.kind !== 'pending_approval') return;
    expect(outcome.approval).toBeNull();
    expect(outcome.deferral).toEqual({ retryAt: new Date(NOW.getTime() + 61_000), reason: 'rate_limit_per_minute' });
    // 관측은 "이번 평가는 막았다" 를 참으로 적는다.
    expect(outcome.decision.verdict).toBe('denied');
    expect(p.pending).toHaveLength(0);
    expect(p.leases.count + p.sends.count + p.records.length).toBe(0);
  });

  it('창 끝의 재평가도 일시적 거부면 **그때** 닫는다 — `release_denied:rate_limit_per_minute`', async () => {
    const p = probe({ result: source({ approvalGrant: approvedGrant(), counters: minuteFull }) });
    const outcome = await dispatch(p.deps, { ...releaseAttempt, release: { ...releaseAttempt.release!, deadlineAt: NOW } });
    expect(outcome.kind).toBe('denied');
    expect(p.pending[0]?.resolution).toEqual({ kind: 'denied', reason: 'release_denied:rate_limit_per_minute' });
  });

  it('정책을 못 읽었다 → 릴리스는 **새 행을 쓰지 않고** 미룬다(evaluation_error, 5분 + 1초)', async () => {
    const p = probe({ result: source({ approvalGrant: approvedGrant() }) });
    const outcome = await dispatch(
      { ...p.deps, source: { load: () => Promise.reject(new Error('db down')) } },
      releaseAttempt,
    );
    expect(outcome).toMatchObject({
      kind: 'pending_approval',
      deferral: { retryAt: new Date(NOW.getTime() + 301_000), reason: 'evaluation_error' },
    });
    expect(p.records).toHaveLength(0);
    expect(p.pending).toHaveLength(0);
  });

  it('정책을 못 읽었고 창도 끝났다 → 대기 행을 `release_denied:evaluation_error` 로 닫는다(새 행 0)', async () => {
    const p = probe({ result: source({ approvalGrant: approvedGrant() }) });
    const outcome = await dispatch(
      { ...p.deps, source: { load: () => Promise.reject(new Error('db down')) } },
      { ...releaseAttempt, release: { ...releaseAttempt.release!, deadlineAt: NOW } },
    );
    expect(outcome.kind).toBe('denied');
    expect(p.records).toHaveLength(0);
    expect(p.pending[0]?.resolution).toEqual({ kind: 'denied', reason: 'release_denied:evaluation_error' });
  });

  it('조직 잠금 실패 → 릴리스는 새 행 없이 미룬다 (예전: 새 행 + denied → messages 가 닫혀 대기 행이 영원히 남았다)', async () => {
    const p = probe({ result: source({ approvalGrant: approvedGrant() }) });
    const outcome = await dispatch(
      {
        ...p.deps,
        serializer: { serialize: () => Promise.reject(new SerializationUnavailableError('잠글 조직을 찾지 못했다')) },
      },
      releaseAttempt,
    );
    expect(outcome).toMatchObject({ kind: 'pending_approval', deferral: { reason: 'evaluation_error' } });
    expect(p.records).toHaveLength(0);
    expect(p.pending).toHaveLength(0);
  });

  it('lease 저장소가 던진다 → 릴리스는 미룬다(전송 0)', async () => {
    const p = probe({ result: source({ approvalGrant: approvedGrant() }) });
    const outcome = await dispatch(
      { ...p.deps, leases: { ...p.deps.leases, acquire: () => Promise.reject(new Error('lease timeout')) } },
      releaseAttempt,
    );
    expect(outcome).toMatchObject({ kind: 'pending_approval', deferral: { reason: 'evaluation_error' } });
    expect(p.sends.count + p.records.length + p.pending.length).toBe(0);
  });
});

describe('관문 — lease 저장소가 던지면 행 없는 `pending` 을 남기지 않는다 (lease 전 throw 경로)', () => {
  it('일반 시도: statusOf 가 던진다 → `denied` + evaluation_error **1행**(정책 스탬프는 그 판정의 것) · 전송 0', async () => {
    const seeded = source({
      relationships: [
        {
          id: 'rel-1',
          agent_id: AGENT_ID,
          scope: 'recipient',
          address: STRANGER,
          domain: null,
          thread_id: null,
          trust_category: 'seed',
          granted_via_approval_id: null,
          granted_by: 'owner_provisioning',
          domain_scope_confirmed_by: null,
          created_at: NOW,
        } satisfies SenderRelationshipRow,
      ],
    });
    const p = probe({ result: seeded });
    const outcome = await dispatch(
      { ...p.deps, leases: { ...p.deps.leases, statusOf: () => Promise.reject(new Error('statement timeout')) } },
      firstAttempt,
    );
    expect(outcome.kind).toBe('denied');
    expect(outcome.decision.reasons).toEqual(['evaluation_error']);
    expect(p.records).toHaveLength(1);
    expect(p.records[0]?.decision.policyVersionId).toBe(POLICY_VERSION_ID);
    expect(p.sends.count).toBe(0);
  });

  it('audit INSERT 까지 실패하면 그 예외는 그대로 올라간다 — 행을 쓸 수 없는 장애를 쓴 척 덮지 않는다', async () => {
    const p = probe({ result: source({ approvalGrant: approvedGrant() }) });
    const seededAttempt = { ...firstAttempt, attempt: { ...firstAttempt.attempt, recipients: [STRANGER] } };
    await expect(
      dispatch(
        {
          ...p.deps,
          source: {
            load: () =>
              Promise.resolve(
                source({
                  relationships: [
                    {
                      id: 'rel-1',
                      agent_id: AGENT_ID,
                      scope: 'recipient',
                      address: STRANGER,
                      domain: null,
                      thread_id: null,
                      trust_category: 'seed',
                      granted_via_approval_id: null,
                      granted_by: 'owner_provisioning',
                      domain_scope_confirmed_by: null,
                      created_at: NOW,
                    } satisfies SenderRelationshipRow,
                  ],
                }),
              ),
          },
          audit: { ...p.deps.audit, record: () => Promise.reject(new Error('audit INSERT 실패')) },
          leases: { ...p.deps.leases, acquire: () => Promise.reject(new Error('lease timeout')) },
        },
        seededAttempt,
      ),
    ).rejects.toThrow(/audit INSERT 실패/);
  });
});
