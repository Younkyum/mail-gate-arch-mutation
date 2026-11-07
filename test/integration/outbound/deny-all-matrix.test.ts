/**
 * Layer D(런타임) — deny-all 매트릭스의 실제 구동(계획 §5.0, AC-5). `buildDenyAllMatrix(OUTBOUND_ROUTES)` 가 만든 경로 × 축
 * 케이스마다 (i) 판정이 거부 (ii) **SES 호출 0회** (iii) audit 행 정확히 1개를 단언한다. 케이스를 사람이 쓰지 않는다 —
 * 새 경로가 등록되면 차단 테스트가 저절로 붙는다. 모든 경로가 실제 전송단을 받으므로 "0회" 는 관문이 막았다는 증명이다.
 *
 * `approval_release` 는 축이 "승인 뒤에" 걸린다: 승인 대기 행(1행)을 만들고, 승인됐다고 두고, 그 사이 축 하나를 비튼 뒤
 * 릴리스한다 — audit 은 새 행 없이 그 1행이 `denied` 로 갱신된다(§4.3).
 */

import { describe, expect, it } from 'vitest';

import { publicReasonCode } from '../../../src/api/public-codes';
import { handleSendDraft } from '../../../src/api/routes/draft-send';
import { handleForward } from '../../../src/api/routes/forward';
import { handleReply } from '../../../src/api/routes/reply';
import { handleSend } from '../../../src/api/routes/send';
import { handleTransitionAnnouncement } from '../../../src/api/routes/transition-announcement';
import type { ApprovalRequestItemRow } from '../../../src/db/schema';
import { runApprovalRelease, type ApprovalReleaseOutcome } from '../../../src/workers/approval-release';
import type { ApiRequest, ApiResponse } from '../../../src/api/http';
import type { OutboundOutcome } from '../../../src/api/outbound-service';
import { runScheduledSend } from '../../../src/workers/scheduled-sender';
import { OUTBOUND_ROUTES } from '../../../src/policy/manifest';
import type { PolicySource, PolicySourceResult } from '../../../src/policy/policy-loader';
import { buildDenyAllMatrix, type DenyAxis } from '../../arch/support/deny-all-matrix';
import {
  AGENT_ADDRESS,
  AGENT_ID,
  ALLOWED_RECIPIENT,
  FOREIGN_ADDRESS,
  NOW,
  REPLY_INBOUND_ID,
  REPLY_THREAD_ID,
  fakeReplyTargets,
  agentRow,
  approvedWithSchedule,
  harness,
  issuedToken,
  policyRow,
  policyVersionRow,
  rulesSnapshot,
  contactRuleRow,
  sourceResult,
  suppressionRow,
  type OutboundHarness,
} from './support/fakes';
import { DRAFT_ID, fakeDraft } from './support/draft-fakes';
import { FORWARD_SOURCE_ID, forwardSource } from './support/forward-fakes';

/** 축 하나만 비튼 시나리오. **한 번에 하나** — 두 축을 동시에 비틀면 어느 쪽이 막았는지 모른다. */
interface Scenario {
  readonly result: PolicySourceResult;
  readonly from: string;
  readonly recipients: readonly string[];
  readonly costCents: number;
  readonly expectedReason: string;
}

function scenarioFor(axis: DenyAxis): Scenario {
  const base = { from: AGENT_ADDRESS, recipients: [ALLOWED_RECIPIENT], costCents: 0 };
  switch (axis) {
    case 'outbound_mode_disabled':
      return {
        ...base,
        // 두 행을 함께 바꾼다 — 어긋나면 `PolicyShapeError` 로 다른 사유가 나온다.
        result: sourceResult({
          policy: policyRow({ outbound_mode: 'disabled' }),
          policyVersion: policyVersionRow({ outbound_mode: 'disabled' }),
        }),
        expectedReason: 'outbound_disabled',
      };

    case 'suppression_list':
      return {
        ...base,
        result: sourceResult({ suppressions: [suppressionRow(ALLOWED_RECIPIENT)] }),
        expectedReason: 'suppression_list',
      };

    case 'blocklist':
      return {
        ...base,
        // 정책 v2 — 발신 allow 와 block 에 같은 수신자. 차단이 이긴다(§4.2, Stage 3).
        result: sourceResult({
          policyVersion: policyVersionRow({
            snapshot: rulesSnapshot([contactRuleRow('outbound', 'allow', ALLOWED_RECIPIENT), contactRuleRow('outbound', 'block', ALLOWED_RECIPIENT)]),
          }),
        }),
        expectedReason: 'recipient_blocklisted',
      };

    case 'budget_exhausted':
      return {
        ...base,
        // 예산 0 + 이번 시도 1센트 → `0 + 1 > 0`(비용 0 이면 예산 0 도 통과한다).
        costCents: 1,
        result: sourceResult({ agent: agentRow({ monthly_budget_cents: 0 }) }),
        expectedReason: 'budget_exhausted',
      };

    case 'warmup_cap':
      return {
        ...base,
        // Day 0 캡(20 수신자)에 이미 닿았다 — 다음 1명이 넘긴다.
        result: sourceResult({
          counters: { agentLastMinute: 0, agentLastHour: 0, agentLastDay: 0, orgRecipientsLastDay: 20 },
        }),
        expectedReason: 'warmup_daily_cap',
      };

    case 'from_forgery':
      // AC-1. 다른 에이전트의 주소로 보내려는 시도 — 정책 데이터는 건드리지 않는다.
      return { ...base, from: FOREIGN_ADDRESS, result: sourceResult(), expectedReason: 'from_forgery' };
  }
}

function apiRequest(scenario: Scenario, token: string, key: string): ApiRequest {
  return {
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    query: {},
    body: {
      agent_id: AGENT_ID,
      from: scenario.from,
      to: [...scenario.recipients],
      subject: 'deny-all matrix',
      text: '차단되어야 한다',
      cost_cents: scenario.costCents,
    },
  };
}

/** 응답(또는 워커 결과)에서 판정과 사유를 꺼낸다 — 두 종류를 같은 축으로 본다. */
interface DriveResult {
  readonly denied: boolean;
  readonly reasons: readonly string[];
  /** 릴리스 전용 — 첫 재평가가 닫지 않고 미뤘는가(일시적 거부). 릴리스가 아니면 `false`. */
  readonly deferredFirst: boolean;
  /** HTTP 응답에서 꺼냈는가 — 그러면 사유는 **공개 이름**이다(`src/api/public-codes.ts`). 워커 결과는 내부 이름이다. */
  readonly publicSurface?: boolean;
}

/** 릴리스에서 일시적이어야 하는 축 — 분류표와 독립적으로 적는다(import 하면 표가 틀려도 따라간다). */
const RELEASE_TRANSIENT_REASONS: ReadonlySet<string> = new Set(['budget_exhausted', 'warmup_daily_cap']);

async function drive(
  routeId: string,
  scenario: Scenario,
  test: OutboundHarness,
  token: { readonly plaintext: string; readonly store: ReturnType<typeof issuedToken>['store'] },
  key: string,
): Promise<DriveResult> {
  const httpDeps = { tokens: token.store, service: test.service };
  const request = apiRequest(scenario, token.plaintext, key);

  if (routeId === 'scheduled_send') {
    const outcome: OutboundOutcome = await runScheduledSend(
      { service: test.service, transport: test.transport },
      {
        agentId: AGENT_ID,
        idempotencyKey: key,
        fromAddress: scenario.from,
        recipients: [...scenario.recipients],
        subject: 'deny-all matrix',
        text: '차단되어야 한다',
        html: null,
        traceId: null,
        costCents: scenario.costCents,
      },
    );
    return {
      denied: outcome.kind === 'denied',
      reasons: outcome.kind === 'denied' ? [...outcome.decision.reasons] : [outcome.kind],
      deferredFirst: false,
    };
  }

  if (routeId === 'approval_release') return driveRelease(scenario, test, token, key);

  // 모르는 경로는 던진다 — 기본 분기가 있으면 새 경로의 케이스가 다른 핸들러를 구동하고 공허하게 통과한다.
  const handlers: Readonly<Record<string, () => Promise<ApiResponse>>> = {
    send: () => handleSend({ ...httpDeps, transport: test.transport }, request),
    // 답하는 메일의 발신자 = 시나리오의 수신자. 정책 소스가 스레드 사실을 주지 않아 회신 면제로 새지 않는다.
    reply: () =>
      handleReply(
        { ...httpDeps, transport: test.transport, replyTargets: fakeReplyTargets(scenario.recipients[0]), artifacts: forwardSource().artifacts },
        { ...request, body: { ...(request.body as Record<string, unknown>), in_reply_to: REPLY_INBOUND_ID, to: undefined } },
        { threadId: REPLY_THREAD_ID },
      ),
    // 보이는 원 메일 한 통 — 원 메일 조회는 통과하고 거부는 관문이 해야 한다.
    forward: () =>
      handleForward({ ...httpDeps, transport: test.transport, ...forwardSource() }, request, {
        inboundMessageId: FORWARD_SOURCE_ID,
      }),
    // 수신자는 본문의 `to` 가 아니라 seed 목록이다 — 시나리오의 수신자를 seed 로 준다. 공지는 서명이 필요하다.
    transition_announcement: () =>
      handleTransitionAnnouncement(
        { ...httpDeps, seeds: { listSeedContacts: () => Promise.resolve(scenario.recipients) } },
        { ...request, body: { ...(request.body as Record<string, unknown>), owner_name: '진윤겸' } },
      ),
    // 초안 보내기 — 시나리오의 발신·수신자가 초안에 있다.
    draft_send: () =>
      handleSendDraft(
        {
          ...httpDeps,
          transport: test.transport,
          ...fakeDraft(AGENT_ID, { from: scenario.from, to: scenario.recipients, subject: 'deny-all matrix', text: '차단되어야 한다' }),
          replyTargets: fakeReplyTargets(),
          artifacts: forwardSource().artifacts,
        },
        { ...request, body: { agent_id: AGENT_ID, cost_cents: scenario.costCents } },
        { draftId: DRAFT_ID },
      ),
  };
  const handler = handlers[routeId];
  if (handler === undefined) throw new Error(`deny-all 매트릭스에 구동기가 없는 경로: ${routeId}`);
  const response = await handler();

  const decision = response.body['decision'] as { reasons?: unknown } | undefined;
  return {
    denied: response.status === 403 && response.body['error'] === 'policy_denied',
    reasons: Array.isArray(decision?.reasons) ? (decision.reasons as readonly string[]) : [],
    deferredFirst: false,
    publicSurface: true,
  };
}

/** 승인이 필요한 정책 — 릴리스 구동의 1단계(승인 대기 행 만들기)에 쓴다. */
function approvalRequiredResult(): PolicySourceResult {
  const base = sourceResult();
  return {
    ...base,
    policy: { ...base.policy, outbound_mode: 'approval_required' },
    policyVersion: { ...base.policyVersion, outbound_mode: 'approval_required' },
  };
}

/**
 * `approval_release` 구동 — **승인 뒤에 축이 바뀐다.**
 *
 * 1) `approval_required` 로 첫 시도 → 승인 대기(audit 1행, 요청 1개)
 * 2) 요청이 승인됐다(로더가 읽을 grant) + 축 하나를 비튼 정책 상태
 * 3) 릴리스 → 관문 재통과 → 거부여야 한다
 */
async function driveRelease(
  scenario: Scenario,
  test: OutboundHarness,
  token: { readonly plaintext: string; readonly store: ReturnType<typeof issuedToken>['store'] },
  key: string,
): Promise<DriveResult> {
  let current: PolicySourceResult = approvalRequiredResult();
  const switchable: PolicySource = { load: () => Promise.resolve(current) };
  const service = { ...test.service, source: switchable };

  // 1단계 — 발신은 항상 자기 주소(위조면 승인 대기가 생기지 않는다). `from_forgery` 는 2단계에서 바인딩을 없애 재현한다.
  const first = await handleSend(
    { tokens: token.store, service, transport: test.transport },
    apiRequest({ ...scenario, from: AGENT_ADDRESS }, token.plaintext, key),
  );
  if (first.status !== 202) throw new Error(`1단계가 승인 대기가 아니다: ${String(first.status)}`);
  const pendingRow = test.audit.rows[0];
  const opening = pendingRow?.approval;
  if (pendingRow?.messageId == null || opening == null) throw new Error('승인 대기 행에 요청이 없다');

  // 2단계 — 사람이 승인했다. 그리고 **그 사이** 축 하나가 바뀌었다.
  const grant = {
    request: {
      id: opening.approvalId,
      agent_id: AGENT_ID,
      subject: 'message' as const,
      status: 'approved' as const,
      created_at: opening.createdAt,
      expires_at: opening.expiresAt,
      decided_at: NOW,
      decided_by: 'owner@example.com',
      granted_scope: 'recipient' as const,
    },
    recipients: opening.envelope.recipients,
  };
  current =
    scenario.expectedReason === 'from_forgery'
      ? {
          ...scenario.result,
          approvalGrant: grant,
          addresses: [{ ...scenario.result.addresses[0]!, address: FOREIGN_ADDRESS }],
        }
      : { ...scenario.result, approvalGrant: grant };

  const item: ApprovalRequestItemRow = {
    approval_id: opening.approvalId,
    message_id: pendingRow.messageId,
    audit_id: 'audit-1',
    from_address: opening.envelope.fromAddress,
    recipients: opening.envelope.recipients,
    is_thread_reply: opening.envelope.isThreadReply,
    thread_id: opening.envelope.threadId,
    cost_cents: opening.envelope.costCents,
    created_at: NOW,
  };

  // 3단계 — 릴리스(실제 전송단). 시계는 승인 시각에서 출발한다.
  const clock = { now: NOW };
  const approvals = approvedWithSchedule(grant.request, [item]);
  const releaseDeps = { service: { ...service, now: () => clock.now }, approvals, transport: test.transport };
  const release = (): Promise<readonly ApprovalReleaseOutcome[]> =>
    runApprovalRelease(releaseDeps, { approvalId: opening.approvalId, traceId: null });

  let outcomes = await release();
  const deferredFirst = outcomes.length === 1 && outcomes[0]?.kind === 'deferred';
  if (deferredFirst) {
    // 미뤄졌다(대기 행 그대로) — 창 끝의 재평가에서도 같은 축이 막으면 닫힌다.
    if (test.audit.pendingResolutions.length !== 0) throw new Error('미룬 릴리스가 대기 행을 건드렸다');
    clock.now = approvals.releases[0]?.deadlineAt as Date;
    outcomes = await release();
  }
  const outcome = outcomes[0];
  return {
    denied: outcomes.length === 1 && outcome?.kind === 'denied',
    reasons: outcome?.kind === 'denied' ? [...outcome.decision.reasons] : [String(outcome?.kind)],
    deferredFirst,
  };
}

const cases = buildDenyAllMatrix(OUTBOUND_ROUTES);

describe('Layer D (런타임) — 매니페스트 × 거부 축 전수', () => {
  it('매트릭스가 비어 있지 않다 — 0건 통과는 아무것도 증명하지 않는다', () => {
    expect(OUTBOUND_ROUTES.length).toBeGreaterThan(0);
    expect(cases.length).toBe(OUTBOUND_ROUTES.length * 6);
  });

  it.each(cases.map((denyCase) => [denyCase.name, denyCase] as const))(
    '%s',
    async (_name, denyCase) => {
      const scenario = scenarioFor(denyCase.axis);
      const test = harness(scenario.result);
      const token = issuedToken();

      const result = await drive(denyCase.routeId, scenario, test, token, `deny-${denyCase.name}`);

      // (i) 판정
      expect(result.denied).toBe(true);
      expect(result.reasons).toContain(result.publicSurface === true ? publicReasonCode(scenario.expectedReason) : scenario.expectedReason);
      // (ii) SES 호출 0회 — AC-5.
      expect(test.transport.calls()).toBe(denyCase.expect.sesSendCalls);
      // (iii) audit 행 정확히 1개 (§4.3).
      expect(test.audit.rows).toHaveLength(denyCase.expect.auditRows);
      if (denyCase.routeId === 'approval_release') {
        expect(result.deferredFirst).toBe(RELEASE_TRANSIENT_REASONS.has(scenario.expectedReason));
        // 릴리스는 새 행을 만들지 않는다 — 거부는 최초 승인 대기 행의 갱신이다.
        expect(test.audit.rows[0]?.decision.verdict).toBe('pending_approval');
        expect(test.audit.pendingResolutions).toHaveLength(1);
        expect(test.audit.pendingResolutions[0]?.resolution).toEqual({
          kind: 'denied',
          reason: `release_denied:${scenario.expectedReason}`,
        });
      } else {
        expect(test.audit.rows[0]?.decision.verdict).toBe('denied');
      }
      // 정책 버전이 찍혀 있다 — "어느 정책이 막았는가" 에 답할 수 있어야 한다(AC-9).
      expect(test.audit.rows[0]?.decision.policyVersion).toBe(1);
    },
  );
});

describe('Layer D (런타임) — fault injection', () => {
  it('정책을 읽지 못해도 SES 호출 0회 + evaluation_error audit 행 1개', async () => {
    const test = harness();
    const token = issuedToken();
    const failing: OutboundHarness = {
      ...test,
      service: {
        ...test.service,
        source: { load: () => Promise.reject(new Error('정책 소스 장애')) },
      },
    };

    const response = await handleSend(
      { tokens: token.store, service: failing.service, transport: test.transport },
      apiRequest(scenarioFor('from_forgery'), token.plaintext, 'fault-injection'),
    );

    expect(response.status).toBe(403);
    expect(test.transport.calls()).toBe(0);
    expect(test.audit.rows).toHaveLength(1);
    expect([...(test.audit.rows[0]?.decision.reasons ?? [])]).toContain('evaluation_error');
    // 스탬프 없는 행 — DB CHECK `audit_logs_policy_stamp_presence` 가 좁히는 그 한 경우다.
    expect(test.audit.rows[0]?.decision.policyVersion).toBeNull();
  });
});
