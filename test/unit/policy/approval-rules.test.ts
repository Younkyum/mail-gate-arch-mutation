/**
 * 로더의 P2 몫 — pre-approval 규칙 · 승인 TTL · 관계 매칭 · 릴리스 grant (계획 §3.4 · §4.3).
 *
 * ★ **`auto_approve_verification_senders` — P2 의 fail-closed 는 P3b 에서 풀렸다.** P2 에서는 그 규칙의 전제
 *   (`injection_risk`·`sender_trust`)가 P4 산출물이라 로더가 플래그 `true` 를 읽는 순간 던졌다. P4 가 두 값을
 *   `inbound_messages` 에 스탬프하므로 이제 로더는 ON 을 **허용**하고(기본은 OFF), 전제 판정은 Stage 7 이 한다
 *   (`thread-reply.test.ts`). 아래 "관문까지" 테스트는 반대 방향을 본다 — ON 인 정책의 에이전트가 더 이상
 *   `evaluation_error` 로 전부 막히지 않고, 그렇다고 ON 이 아무것이나 열지도 않는다.
 */

import { entitlementRow } from '../../support/entitlements';
import { describe, expect, it, vi } from 'vitest';

import type { ApprovalRequestRow, SenderRelationshipRow } from '../../../src/db/schema';
import { dispatch, unserialized, type GateDependencies } from '../../../src/policy/gate';
import {
  DEFAULT_APPROVAL_TTL_SECONDS,
  loadEvaluationInput,
  matchRelationships,
  MAX_APPROVAL_TTL_SECONDS,
  MIN_APPROVAL_TTL_SECONDS,
  PolicyShapeError,
  resolveApprovalGrant,
  resolveApprovalTtlSeconds,
  resolvePreApprovalRules,
  type PolicySourceResult,
} from '../../../src/policy/policy-loader';
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

const BASE_CONFIG = {
  allowlist: [],
  blocklist: [],
  max_attachment_bytes_total: 5_000_000,
  allowed_mime_types: ['application/pdf'],
};

function sourceResult(config: Record<string, unknown>, overrides: Partial<PolicySourceResult> = {}): PolicySourceResult {
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
      config_json: { ...BASE_CONFIG, ...config } as PolicySourceResult['policy']['config_json'],
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

const loadRequest = {
  agentId: AGENT_ID,
  attempt: { ...baseAttempt, fromAddress: 'agent@atmark.ai', recipients: ['Friend+tag@Example.com'] },
  now: NOW,
  traceId: null,
  thisAttemptCostCents: 0,
  release: null,
};

describe('`auto_approve_verification_senders` — P3b: 로더가 ON 을 허용한다, 기본은 OFF (§3.4 3조)', () => {
  it('플래그가 true 인 정책을 **던지지 않고** 그대로 읽는다 — 켰다고 믿는 소유자와 읽은 값이 같다', () => {
    expect(resolvePreApprovalRules({ auto_approve_verification_senders: true }).autoApproveVerificationSenders).toBe(true);
  });

  it('**관문까지** — ON 인 정책의 에이전트도 평가된다: 스레드 없는 신규 상대는 여전히 승인 대기(SES 0회, audit 1행)', async () => {
    const records: unknown[] = [];
    let sends = 0;
    const deps: GateDependencies = {
      source: {
        load: () =>
          Promise.resolve(
            sourceResult(
              { auto_approve_verification_senders: true },
              // **관계 없음** — P2 의 이 테스트는 seed 가 있어도 막히는 것을 봤다. 이제는 ON 이 신규 상대를 열지
              // 않는다는 것을 본다(스레드 사실이 없으면 verification 문은 닫혀 있다).
              {},
            ),
          ),
      },
      audit: {
        record: (entry) => {
          records.push(entry);
          return Promise.resolve('audit-1');
        },
        resolve: () => Promise.resolve(),
        resolvePending: () => Promise.resolve(false),
      },
      leases: { acquire: () => Promise.resolve(true), statusOf: () => Promise.resolve('pending') },
      transport: {
        send: () => {
          sends += 1;
          return Promise.resolve({ sesMessageId: 'x' });
        },
      },
      serializer: unserialized(),
      leaseTtlSeconds: 300,
    };

    const outcome = await dispatch(deps, {
      ...loadRequest,
      // 스레드를 **주장**해도 소스가 스레드 사실을 주지 않으면(`thread: null`) 회신이 아니다.
      attempt: { ...loadRequest.attempt, routeId: 'fixture_send', threadId: '33333333-3333-4333-8333-333333333333', contentShape: 'code_only' },
      messageId: 'msg-1',
      messageIdHeader: '<m@atmark.ai>',
      leaseId: 'lease-1',
    });

    expect(outcome.kind).toBe('pending_approval');
    expect(outcome.decision.reasons).toEqual(['new_recipient']);
    expect(sends).toBe(0);
    expect(records).toHaveLength(1);
  });

  it('false 이거나 키가 없으면 OFF — 기본값은 계획대로 꺼져 있다', () => {
    expect(resolvePreApprovalRules({ auto_approve_verification_senders: false }).autoApproveVerificationSenders).toBe(false);
    expect(resolvePreApprovalRules({}).autoApproveVerificationSenders).toBe(false);
  });
});

describe('pre-approval 규칙 — 기본값과 모양 (§3.4 3조)', () => {
  it('키가 없으면 계획의 기본값: reply_within_thread=true, domains=[]', () => {
    expect(resolvePreApprovalRules({})).toEqual({
      autoApproveReplyWithinThread: true,
      autoApproveDomains: [],
      autoApproveVerificationSenders: false,
    });
  });

  it('도메인은 소문자·공백 제거로 정규화된다', () => {
    expect(resolvePreApprovalRules({ auto_approve_domains: ['  Partner.CO '] }).autoApproveDomains).toEqual([
      'partner.co',
    ]);
  });

  it.each([
    ['boolean 자리에 문자열', { auto_approve_reply_within_thread: 'yes' }],
    ['도메인 목록이 배열이 아님', { auto_approve_domains: 'partner.co' }],
    ['도메인 목록에 숫자', { auto_approve_domains: [1] }],
    // 주소를 도메인 자리에 적은 실수 — 잘라서 도메인으로 읽으면 의도보다 **넓어진다**.
    ['도메인 자리에 주소', { auto_approve_domains: ['ceo@partner.co'] }],
    ['빈 도메인', { auto_approve_domains: ['  '] }],
    ['verification_senders 가 문자열', { auto_approve_verification_senders: 'true' }],
  ])('%s → PolicyShapeError (기본값으로 떨어지지 않는다)', (_label, config) => {
    expect(() => resolvePreApprovalRules(config)).toThrow(PolicyShapeError);
  });
});

describe('승인 TTL — 기본 24h, 범위 1h–7d (§3.4 4조)', () => {
  it('키가 없으면 24시간', () => {
    expect(resolveApprovalTtlSeconds({})).toBe(DEFAULT_APPROVAL_TTL_SECONDS);
    expect(DEFAULT_APPROVAL_TTL_SECONDS).toBe(86_400);
  });

  it('경계값은 받는다', () => {
    expect(resolveApprovalTtlSeconds({ approval_ttl_seconds: MIN_APPROVAL_TTL_SECONDS })).toBe(3_600);
    expect(resolveApprovalTtlSeconds({ approval_ttl_seconds: MAX_APPROVAL_TTL_SECONDS })).toBe(604_800);
  });

  it.each([MIN_APPROVAL_TTL_SECONDS - 1, MAX_APPROVAL_TTL_SECONDS + 1, -5, 1.5, '3600'])(
    '범위·모양 밖(%s) → PolicyShapeError',
    (value) => {
      expect(() => resolveApprovalTtlSeconds({ approval_ttl_seconds: value })).toThrow(PolicyShapeError);
    },
  );
});

function relationshipRow(overrides: Partial<SenderRelationshipRow>): SenderRelationshipRow {
  return {
    id: 'rel-1',
    agent_id: AGENT_ID,
    scope: 'recipient',
    address: 'friend@example.com',
    domain: null,
    thread_id: null,
    trust_category: 'approved',
    granted_via_approval_id: 'apr-1',
    granted_by: 'owner',
    domain_scope_confirmed_by: null,
    created_at: NOW,
    ...overrides,
  };
}

describe('matchRelationships — 스코프 매칭은 로더 한 곳에서만', () => {
  const recipients = ['friend@example.com', 'boss@partner.co'];

  it('recipient 스코프 — 주소 정확 일치(소문자만, **`+tag` 보존** — 허용은 좁게, V1 MINOR-2)', () => {
    // 소유자가 `Friend+X@Example.com` 을 승인했다 — 그 관계는 그 주소 하나만 덮는다.
    const tagged = [relationshipRow({ address: 'Friend+X@Example.com' })];
    expect(matchRelationships(tagged, ['friend+x@example.com'], null)).toEqual([
      { recipient: 'friend+x@example.com', trustCategory: 'approved', scope: 'recipient' },
    ]);
    // 태그를 뗀 주소도, 다른 태그도 덮지 않는다 — 소유자는 그 주소들을 본 적이 없다.
    expect(matchRelationships(tagged, recipients, null)).toEqual([]);
    expect(matchRelationships(tagged, ['friend+y@example.com'], null)).toEqual([]);
    // 반대로 태그 없는 관계가 태그 달린 수신자를 덮지도 않는다.
    expect(matchRelationships([relationshipRow({ address: 'friend@example.com' })], ['friend+x@example.com'], null)).toEqual([]);
    expect(matchRelationships([relationshipRow({ address: 'Friend@Example.com' })], recipients, null)).toEqual([
      { recipient: 'friend@example.com', trustCategory: 'approved', scope: 'recipient' },
    ]);
  });

  it('thread 스코프도 `+tag` 를 보존해 맞춘다', () => {
    const row = relationshipRow({ scope: 'thread', thread_id: 't-1', address: 'bob+x@partner.co' });
    expect(matchRelationships([row], ['bob@partner.co'], 't-1')).toEqual([]);
    expect(matchRelationships([row], ['bob+x@partner.co'], 't-1')).toEqual([
      { recipient: 'bob+x@partner.co', trustCategory: 'approved', scope: 'thread' },
    ]);
  });

  it('domain 스코프 — 도메인 일치 수신자만', () => {
    const matches = matchRelationships(
      [relationshipRow({ scope: 'domain', address: null, domain: 'Partner.co', domain_scope_confirmed_by: 'owner' })],
      recipients,
      null,
    );
    expect(matches).toEqual([{ recipient: 'boss@partner.co', trustCategory: 'approved', scope: 'domain' }]);
  });

  it('thread 스코프 — **시도의 threadId 가 있고 같을 때만** 매칭 (P2 의 시도는 null → 매칭 없음)', () => {
    const row = relationshipRow({ scope: 'thread', thread_id: 't-1' });
    expect(matchRelationships([row], recipients, null)).toEqual([]);
    expect(matchRelationships([row], recipients, 't-2')).toEqual([]);
    expect(matchRelationships([row], recipients, 't-1')).toEqual([
      { recipient: 'friend@example.com', trustCategory: 'approved', scope: 'thread' },
    ]);
  });

  it('키가 비어 있는 행(모양 위반)은 아무것도 덮지 않는다 — 넓어지는 쪽으로 해석하지 않는다', () => {
    const broken = [
      relationshipRow({ address: null }),
      relationshipRow({ scope: 'domain', address: null, domain: null }),
      relationshipRow({ scope: 'thread', thread_id: 't-1', address: null }),
    ];
    expect(matchRelationships(broken, recipients, 't-1')).toEqual([]);
  });
});

function approvalRow(overrides: Partial<ApprovalRequestRow>): ApprovalRequestRow {
  return {
    id: 'apr-1',
    agent_id: AGENT_ID,
    subject: 'message',
    status: 'approved',
    created_at: NOW,
    expires_at: new Date(NOW.getTime() + 3_600_000),
    decided_at: NOW,
    decided_by: 'owner@example.com',
    granted_scope: 'recipient',
    ...overrides,
  };
}

describe('resolveApprovalGrant — 릴리스의 근거는 DB 의 상태다', () => {
  it('approved + 같은 에이전트 → grant (수신자는 허용 비교형 — 소문자, `+tag` 보존 · 승인자)', () => {
    expect(resolveApprovalGrant({ request: approvalRow({}), recipients: [' Friend+x@Example.com '] }, AGENT_ID)).toEqual({
      approvalId: 'apr-1',
      recipients: ['friend+x@example.com'],
      approvedBy: 'owner@example.com',
    });
  });

  it.each([
    ['조회하지 않음', null],
    ['pending', { request: approvalRow({ status: 'pending', decided_at: null, decided_by: null }), recipients: [] }],
    ['rejected', { request: approvalRow({ status: 'rejected' }), recipients: [] }],
    // ★ AC-i4 의 방어 하나 — 만료된 요청은 릴리스의 근거가 될 수 없다.
    ['expired', { request: approvalRow({ status: 'expired', decided_by: null }), recipients: [] }],
    ['다른 에이전트의 요청', { request: approvalRow({ agent_id: 'f'.repeat(32) as never }), recipients: [] }],
    ['승인자 없음', { request: approvalRow({ decided_by: null }), recipients: [] }],
  ])('%s → null', (_label, source) => {
    expect(resolveApprovalGrant(source, AGENT_ID)).toBeNull();
  });
});

describe('loadEvaluationInput — 승인 경로 입력의 조립', () => {
  it('관계·grant·grace 가 허용 비교형 수신자 기준으로 ctx 에 실린다 — 판정형(`+tag` 절단)은 거부 쪽에만', async () => {
    const input = await loadEvaluationInput(
      {
        load: () =>
          Promise.resolve(
            sourceResult(
              { auto_approve_domains: ['partner.co'], approval_ttl_seconds: 7_200 },
              {
                relationships: [
                  // 태그 없는 seed — 태그 달린 수신자(`Friend+tag@`)를 덮지 않는다(예전에는 덮었다: V1 MINOR-2).
                  relationshipRow({ trust_category: 'seed', granted_via_approval_id: null }),
                  relationshipRow({ id: 'rel-2', address: 'friend+tag@example.com' }),
                ],
                approvalGrant: { request: approvalRow({}), recipients: ['Friend+tag@Example.com'] },
                outboundSentCount: 4,
              },
            ),
          ),
      },
      { ...loadRequest, release: { approvalId: 'apr-1', auditId: 'audit-1' } },
    );

    // 두 형태는 같은 순서·같은 길이다. 판정형은 억제·차단(넓게), 허용 비교형은 Stage 7(좁게).
    expect(input.ctx.attempt.recipients).toEqual(['friend@example.com']);
    expect(input.ctx.approval.recipients).toEqual(['friend+tag@example.com']);
    expect(input.ctx.approval.relationships).toEqual([
      { recipient: 'friend+tag@example.com', trustCategory: 'approved', scope: 'recipient' },
    ]);
    expect(input.ctx.approval.grant?.recipients).toEqual(['friend+tag@example.com']);
    expect(input.ctx.approval.grant?.approvalId).toBe('apr-1');
    expect(input.ctx.approval.bootstrapGrace).toEqual({ agentCreatedAt: NOW, outboundSentCount: 4 });
    expect(input.policy.preApproval.autoApproveDomains).toEqual(['partner.co']);
    expect(input.policy.approvalTtlSeconds).toBe(7_200);
  });

  it('소스에 넘기는 질의가 threadId·릴리스 id 를 싣는다', async () => {
    const seen: unknown[] = [];
    await loadEvaluationInput(
      {
        load: (query) => {
          seen.push(query);
          return Promise.resolve(sourceResult({}));
        },
      },
      {
        ...loadRequest,
        attempt: { ...loadRequest.attempt, threadId: 't-9' },
        release: { approvalId: 'apr-9', auditId: 'audit-9' },
      },
    );
    expect(seen[0]).toMatchObject({ threadId: 't-9', releaseApprovalId: 'apr-9' });
    // 소스는 두 형태로 좁혀 읽는다 — 억제는 판정형, 관계는 허용 비교형으로 저장돼 있다.
    expect((seen[0] as { recipients: readonly string[] }).recipients).toEqual(['friend@example.com', 'friend+tag@example.com']);
  });

  it('소스가 음수 발송 수를 주면 던진다 — grace 가 무한히 늘어나는 입력이다', async () => {
    await expect(
      loadEvaluationInput({ load: () => Promise.resolve(sourceResult({}, { outboundSentCount: -1 })) }, loadRequest),
    ).rejects.toThrow(PolicyShapeError);
  });
});
