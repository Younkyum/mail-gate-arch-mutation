/**
 * `POST /v1/agents/{id}/policy/requests` · `GET /v1/agents/{id}/policy/requests/{requestId}` — **에이전트의 정책 변경 요청**(ADR-0007 2026-10-13 개정 ·
 * 진윤겸 결정 A: "허용 목록 같은 변경을 에이전트한테 시키는 경우가 있다. 유저의 승인을 받으면 에이전트가 수정할 수 있도록").
 *
 * 만들기는 **바꾸지 않는다** — 요청 한 행을 남기고 202 `pending_approval` 을 돌려줄 뿐이다. 소유자가 콘솔에서 정확한 차이(지금 → 바뀐 뒤) · 이유 ·
 * 위험 경고(ADR-0016 — 요청 직전 위험 표시 메일을 읽었나)를 보고 승인하면, 그때 소유자 행위(관리 연산 · 감사 1행 · 새 정책 버전)로서 바뀐다
 * (`admin/ops/policy-requests.ts`). 에이전트는 이 라우트의 GET(MCP `get_policy_request`)으로 결과를 본다.
 *
 * 요청할 수 있는 것: 목록 항목 더하기 · 빼기(발신 · 수신 × 허용 · 차단) · 모드 바꾸기(넷 중 하나) — 닫힌 어휘는 `policy/policy-requests.ts`.
 * 권한: 만들기 `policy:request`(신규 토큰 기본) · 읽기 `agent:read_self`. 대상은 토큰의 에이전트뿐이다(`me` 별칭 · 남의 id → 403).
 * 같은 변경의 pending 이 있으면 그것을 돌려준다(`replayed: true` — 상한에 세지 않는다). 에이전트당 24시간 20건 · pending 5건 · 7일 뒤 만료.
 * 차단 목록의 내용은 에이전트에게 감춘다(ADR-0007) — 차단 목록 항목 요청은 지금 상태와 견주지 않고 받는다(승인 때 이미 그 상태면 stale).
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 메일을 보내지 않고 관문을 import 하지 않는다. 소유자 알림은 DB 가 감시 알림 창에 센다(시스템 메일 워커).
 */

import type { PolicyRequestStore } from '../../db/repositories/policy-request-store';
import { hashAgentToken, type AgentTokenStore } from '../../identity/agent-token';
import {
  effectivePolicyRequestStatus,
  parsePolicyRequest,
  policyRequestChangeBody,
  policyRequestChangeOf,
  policyRequestHash,
  PolicyRequestInputError,
  POLICY_REQUESTS_PENDING_MAX,
  POLICY_REQUESTS_PER_DAY,
  type PolicyRequestStatus,
} from '../../policy/policy-requests';
import { authorizeAgentRequest, claimedAgentOfPath } from '../auth';
import { AUTHORIZATION_HEADER, errorResponse, headerOf, isJsonObject, jsonResponse, UUID_PATTERN, type ApiRequest, type ApiResponse } from '../http';

export interface PolicyRequestRouteDependencies {
  readonly tokens: AgentTokenStore;
  readonly policyRequests: PolicyRequestStore;
  readonly now: () => Date;
}

const PENDING_NEXT_STEP =
  'Nothing has changed yet. Your owner must approve this in the console; you will not be asked. Check later with get_policy_request ' +
  '(GET /v1/agents/me/policy/requests/{request_id}). Do not send the same request again, and do not try to work around the current policy meanwhile.';

/** 에이전트에게 보이는 상태 — pending 은 send 와 같은 낱말(`pending_approval`). */
function publicStatus(status: PolicyRequestStatus): string {
  return status === 'pending' ? 'pending_approval' : status;
}

function nextStepOf(status: PolicyRequestStatus): string {
  switch (status) {
    case 'pending':
      return PENDING_NEXT_STEP;
    case 'approved':
      return 'This change is in effect now. Read get_my_policy to see your policy.';
    case 'rejected':
      return 'Your owner rejected this change. Do not ask again for the same change unless your owner tells you to.';
    case 'stale':
      return 'This request no longer applied when your owner reviewed it (the policy had already changed). Read get_my_policy before asking again.';
    case 'expired':
      return 'Nobody decided within 7 days, so this request expired. Nothing changed.';
  }
}

const REFUSALS: Readonly<Record<string, readonly [number, string, string]>> = {
  scope_missing: [403, 'forbidden', 'capability_not_granted'],
  agent_not_active: [403, 'agent_not_active', 'This agent is not active (paused, suspended or being provisioned).'],
  daily_limit: [429, 'policy_request_daily_limit', `You can make at most ${String(POLICY_REQUESTS_PER_DAY)} policy change requests per 24 hours.`],
  pending_limit: [
    429,
    'policy_request_pending_limit',
    `You already have ${String(POLICY_REQUESTS_PENDING_MAX)} requests waiting for your owner. Wait until they are decided.`,
  ],
  no_change: [409, 'no_change', 'Your policy already looks like that (see get_my_policy). Nothing to request.'],
  self_address: [400, 'rule_self_address', 'You cannot allow sending to your own address.'],
  // 보안 감사 L-2 — 거절된 같은 변경을 24시간 안에 다시 묻지 못한다(소유자를 같은 요청으로 두드려 지쳐 승인하게 만드는 길을 닫는다).
  recently_rejected: [
    409,
    'policy_request_recently_rejected',
    'Your owner rejected this same change within the last 24 hours. Do not ask for it again unless your owner tells you to.',
  ],
};

/** `POST /v1/agents/{id}/policy/requests {action, direction, list?, value?, mode?, reason}` → 202 `pending_approval`. */
export async function handleCreatePolicyRequest(
  deps: PolicyRequestRouteDependencies,
  request: ApiRequest,
  params: { readonly agentId: string },
): Promise<ApiResponse> {
  const claimed = claimedAgentOfPath(params.agentId);
  if (claimed.kind === 'error') return claimed.response;
  const access = await authorizeAgentRequest(deps.tokens, request, deps.now(), 'policy:request', claimed.agentId);
  if (access.kind === 'error') return access.response;

  if (!isJsonObject(request.body)) {
    return errorResponse(400, 'invalid_request', 'Body must be a JSON object: {action, direction, list?, value?, mode?, reason}.');
  }
  let parsed: ReturnType<typeof parsePolicyRequest>;
  try {
    parsed = parsePolicyRequest(request.body);
  } catch (error) {
    if (error instanceof PolicyRequestInputError) return errorResponse(400, error.code, error.message);
    throw error;
  }

  // 인증이 이미 지난 헤더 — 같은 토큰의 해시를 DB 가 다시 본다(권한 · 에이전트 · 폐기).
  const presented = (headerOf(request, AUTHORIZATION_HEADER) ?? '').slice('bearer '.length).trim();
  const outcome = await deps.policyRequests.create({
    agentId: access.agentId,
    tokenHash: hashAgentToken(presented),
    change: parsed.change,
    reason: parsed.reason,
    requestHash: policyRequestHash(parsed.change),
  });
  if (outcome.kind !== 'created' && outcome.kind !== 'replayed') {
    const [status, error, detail] = REFUSALS[outcome.kind] ?? [500, 'internal_error', 'unexpected refusal'];
    return errorResponse(status, error, detail);
  }
  return jsonResponse(202, {
    request_id: outcome.id,
    agent_id: access.agentId,
    status: publicStatus(outcome.status),
    replayed: outcome.kind === 'replayed',
    change: policyRequestChangeBody(parsed.change),
    base_policy_version: outcome.baseVersion,
    created_at: outcome.createdAt.toISOString(),
    expires_at: outcome.expiresAt.toISOString(),
    next_step: nextStepOf(outcome.status),
  });
}

/** `GET /v1/agents/{id}/policy/requests/{requestId}` → 요청의 지금 상태. 남의 요청 · 없는 요청은 같은 404. */
export async function handleGetPolicyRequest(
  deps: PolicyRequestRouteDependencies,
  request: ApiRequest,
  params: { readonly agentId: string; readonly requestId: string },
): Promise<ApiResponse> {
  const claimed = claimedAgentOfPath(params.agentId);
  if (claimed.kind === 'error') return claimed.response;
  if (!UUID_PATTERN.test(params.requestId)) return errorResponse(400, 'invalid_request', 'request id must be a lowercase uuid.');
  const now = deps.now();
  const access = await authorizeAgentRequest(deps.tokens, request, now, 'agent:read_self', claimed.agentId);
  if (access.kind === 'error') return access.response;

  const record = await deps.policyRequests.find(access.agentId, params.requestId);
  const change = record === null ? null : policyRequestChangeOf(record);
  if (record === null || change === null) {
    return errorResponse(404, 'policy_request_not_found', `No policy change request with request_id=${params.requestId} for this agent.`);
  }
  const effective = effectivePolicyRequestStatus(record.status, record.expiresAt, now);
  // ★ 차단 목록 요청은 결과로 차단 목록의 내용이 새지 않게 한다(적대 검증 E05 · E06). stale(already_applied — "이미 그 상태")와 approved 가 갈리면
  //   에이전트가 "그 값이 차단돼 있는가" 를 물어볼 수 있다. 그래서 차단 목록은: 이미 그 상태 → approved(요청한 상태가 지금 사실이다) · 다른 stale →
  //   rejected · stale_reason 없음 · applied_policy_version 없음(버전 유무가 stale 과 approved 를 가른다). 소유자 콘솔에는 그대로 보인다. 같은 코드 경로라
  //   응답 시간도 가르지 않는다.
  const blockList = change.action !== 'set_mode' && change.list === 'block';
  const status: PolicyRequestStatus =
    blockList && effective === 'stale' ? (record.staleReason === 'already_applied' ? 'approved' : 'rejected') : effective;
  return jsonResponse(200, {
    request_id: record.id,
    agent_id: record.agentId,
    status: publicStatus(status),
    change: policyRequestChangeBody(change),
    created_at: record.createdAt.toISOString(),
    expires_at: record.expiresAt.toISOString(),
    decided_at: effective === 'expired' && record.decidedAt === null ? record.expiresAt.toISOString() : (record.decidedAt?.toISOString() ?? null),
    applied_policy_version: blockList ? null : record.appliedVersion,
    ...(!blockList && status === 'stale' && record.staleReason !== null ? { stale_reason: record.staleReason } : {}),
    next_step: nextStepOf(status),
  });
}
