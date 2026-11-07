/**
 * src/admin/routes/policy-requests.ts — 에이전트의 정책 변경 요청(ADR-0007 2026-10-13 개정)을 콘솔에서 보고 · 승인하고 · 거절한다.
 *
 *   GET  /api/agents/{agentId}/change-requests?status=pending|all  → `{items, currentVersion}` (member)
 *   POST /api/agents/{agentId}/change-requests/{requestId}/approve  `{expectedVersion, ack?}` → `{request, policy}` (admin) — 위험 경고가 있으면
 *        `ack: true` 가 있어야 한다(409 `risk_ack_required`)
 *   POST /api/agents/{agentId}/change-requests/{requestId}/reject   → `{request}` (admin)
 *
 * 승인은 소유자가 콘솔에서 정책을 직접 바꿀 때와 **같은 역할**(admin)과 **같은 관리 연산**이다 — 결정 · 새 정책 버전 · 감사 1행
 * (`agent.policy_request.approve` · `.reject` · `.stale`)이 한 트랜잭션(`audited`). 에이전트 토큰은 이 표면에 닿지 않는다(라우터가 `Authorization` 헤더를 401 로
 * 끊는다) — 에이전트는 자기 요청을 승인할 수 없다.
 *
 * 이유(`reason`)와 값은 **에이전트가 쓴 글자**다 — 표시 규칙으로 한 번 거른다(`displaySubject` · `displayAddress`). 발송 없음.
 */

import { AdminInputError } from '../ops/errors';
import {
  decidePolicyRequestOp,
  listPolicyRequestsOp,
  resolvePolicyRequestFilter,
  type PolicyRequestDecision,
  type PolicyRequestOutcome,
  type PolicyRequestView,
} from '../ops/policy-requests';
import type { PolicyView } from '../ops/policy';
import { actorOfSession, audited, objectBody, optionalBody, rejectUnknownKeys, requireAgentInOrganization, sessionOf, type AdminCall } from '../context';
import { displayAddress, displaySubject } from '../display';
import { jsonResponse, type AdminResponse } from '../http';

/** 표시 정화 — 이유 · 값은 에이전트가 쓴 글자다. */
function requestForDisplay(view: PolicyRequestView): Record<string, unknown> {
  const change =
    view.change.action === 'set_mode'
      ? view.change
      : { ...view.change, value: displayAddress(view.change.value) };
  const diff = view.diff === null || view.diff.kind === 'mode' ? view.diff : { ...view.diff, value: displayAddress(view.diff.value) };
  return { ...view, change, diff, reason: displaySubject(view.reason) };
}

/** 관리 API 의 정책 모양(규칙 값 표시 정화 — `routes/agents.ts` 와 같은 칸). */
function policyForDisplay(view: PolicyView): Record<string, unknown> {
  const rules = (list: PolicyView['outbound']['allow']) => list.map((rule) => ({ ...rule, value: displayAddress(rule.value) }));
  return {
    outbound: { mode: view.outbound.mode, legacyMode: view.outbound.legacyMode, allow: rules(view.outbound.allow), block: rules(view.outbound.block) },
    inbound: { mode: view.inbound.mode, allow: rules(view.inbound.allow), block: rules(view.inbound.block) },
    limits: view.limits,
    version: view.version,
    ruleLimit: view.ruleLimit,
  };
}

/** `GET /api/agents/{agentId}/change-requests` */
export async function handleListPolicyRequests(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const filter = resolvePolicyRequestFilter(call.request.query['status']);
  const result = await listPolicyRequestsOp(call.deps.pool, session.organizationId, agentId, filter, call.deps.now());
  return jsonResponse(200, { items: result.items.map(requestForDisplay), currentVersion: result.currentVersion });
}

const ACTIONS: Readonly<Record<PolicyRequestOutcome['kind'], string | null>> = {
  approved: 'agent.policy_request.approve',
  rejected: 'agent.policy_request.reject',
  stale: 'agent.policy_request.stale',
  // 만료는 소유자의 결정이 아니다(시간이 닫았다) — 감사 행 없음.
  expired: null,
};

async function decide(call: AdminCall, decision: PolicyRequestDecision, expectedVersion: number | undefined, riskAcknowledged = false): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const outcome = await audited<PolicyRequestOutcome>(
    call.deps.pool,
    session,
    (result) => ACTIONS[result.kind] ?? 'agent.policy_request.expire',
    (tx) =>
      decidePolicyRequestOp(tx, {
        organizationId: session.organizationId,
        agentId,
        requestId: call.params['requestId'] ?? '',
        decision,
        actor: actorOfSession(session),
        userId: session.userId,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        riskAcknowledged,
        now: call.deps.now(),
      }),
    (result) => (ACTIONS[result.kind] === null ? undefined : agentId),
  );
  switch (outcome.kind) {
    case 'approved':
      return jsonResponse(200, { request: requestForDisplay(outcome.request), policy: policyForDisplay(outcome.policy) });
    case 'rejected':
      return jsonResponse(200, { request: requestForDisplay(outcome.request) });
    case 'stale':
      return jsonResponse(409, {
        error: 'policy_request_stale',
        detail: `지금 정책에서는 이 요청을 적용할 수 없어 닫았다(${outcome.reason}).`,
        reason: outcome.reason,
        request: requestForDisplay(outcome.request),
      });
    case 'expired':
      return jsonResponse(409, { error: 'policy_request_expired', detail: '7일이 지나 만료된 요청이다.', request: requestForDisplay(outcome.request) });
  }
}

const APPROVE_KEYS: ReadonlySet<string> = new Set(['expectedVersion', 'ack']);

/** `POST /api/agents/{agentId}/change-requests/{requestId}/approve {expectedVersion}` — 차이를 본 버전이 필수다(본 것과 다른 것을 승인하지 않게). */
export async function handleApprovePolicyRequest(call: AdminCall): Promise<AdminResponse> {
  const body = objectBody(call.request.body);
  rejectUnknownKeys(body, APPROVE_KEYS);
  const expected = body['expectedVersion'];
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1) {
    throw new AdminInputError('expectedVersion(차이를 본 정책 버전, 정수)이 필요하다.', 'invalid_body');
  }
  const ack = body['ack'];
  if (ack !== undefined && typeof ack !== 'boolean') throw new AdminInputError('ack 는 true | false 다.', 'invalid_body');
  return decide(call, 'approve', expected, ack === true);
}

/** `POST /api/agents/{agentId}/change-requests/{requestId}/reject` */
export async function handleRejectPolicyRequest(call: AdminCall): Promise<AdminResponse> {
  rejectUnknownKeys(optionalBody(call.request.body), new Set());
  return decide(call, 'reject', undefined);
}
