/**
 * `GET /v1/agents/{id}/policy` — **에이전트가 자기 정책을 읽는다** (계획 §3.1 · 정책 v2 — 계약 v2 §1 · ADR-0007).
 *
 * AC-a1(재정의, ADR-0007 · 2026-10-13 개정): 소유자가 새로 만든 에이전트는 이 호출이 `outbound_mode: "unrestricted"`(콘솔 "전체")·
 * `inbound_mode: "all"` 을 반환한다(자가 등록 · 운영자 예약 주소는 `allowlist_only` 빈 목록). MCP `get_my_policy` 도 이 함수다.
 *
 * **목록 자체를 준다(발신·수신 allow), 차단 목록은 개수만**(계약 v2 §1) — 에이전트는 "누구에게 보낼 수 있나 / 누구의 메일이
 * 보이나" 를 알아야 설정을 스스로 확인한다(진윤겸: 설정은 대부분 에이전트에게 메시지로). 차단 목록의 내용은 에이전트가 우회
 * 대상을 고르는 재료가 될 뿐이라 싣지 않는다.
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 조회 전용이고 관문을 import 하지 않는다.
 *
 * **관문이 읽는 것과 같은 것을 읽는다.** 조회 SQL 을 따로 쓰지 않고 `PolicySource`(관문의 입력)와
 * `resolvePolicy`(로더의 해석)를 그대로 쓴다. 그래서 여기서 보이는 `outbound_mode` 는 정책 **행**이 아니라
 * 관문이 판정에 쓰는 **스냅샷**(`policy_versions`)의 값이다 — 둘이 갈라진 창에서 API 가 행을, 관문이
 * 스냅샷을 말하면 AC-9 가 답할 수 없다(`policy-loader.resolvePolicy` 머리말).
 *
 * **인가가 읽기보다 먼저다** — 대상이 경로에 있으므로 `audit.ts` 와 달리 행을 읽기 전에 판정할 수 있고,
 * 그러면 남의 에이전트는 존재 여부조차 알 수 없다(403 이 먼저 나간다).
 *
 * **한도는 관문이 실제로 쓰는 값이다**(ADR-0011): `limits` = min(정책, 요금제) — Stage 4 와 같은 `resolveEntitlements` 로 해석한다. 소유자가
 * 정책에 적은 값은 `policy_limits`, 요금제 코드는 `plan` 에 따로 싣는다 — 에이전트가 정책 값만 보고 보냈다가 요금제에 걸리지 않게.
 *
 * **정책을 해석할 수 없으면 409** — 그 에이전트의 발송은 전부 `evaluation_error` 로 막혀 있다
 * (예: P4 이전에 `auto_approve_verification_senders=true`). 모드만 골라 200 으로 보여 주면 에이전트는
 * "승인 모드구나" 라고 믿고, 실제로는 한 통도 못 보낸다.
 */

import { resolveEntitlements } from '../../billing/plans';
import type { AgentTokenStore } from '../../identity/agent-token';
import { LEGACY_OUTBOUND_MODES } from '../../db/schema';
import type { SelfEnrollStatusPort } from '../../db/repositories/self-enroll-status';
import type { InboundPolicy, InboundPolicyPort } from '../../policy/inbound-policy';
import { consoleInboundModeOf, consoleOutboundModeOf } from '../../policy/mode-names';
import {
  PolicyShapeError,
  PolicySourceUnavailableError,
  resolvePolicy,
  type PolicySource,
} from '../../policy/policy-loader';
import { organizationDailyCap } from '../../policy/rules/limits';
import { authorizeAgentRequest, claimedAgentOfPath } from '../auth';
import { errorResponse, jsonResponse, type ApiRequest, type ApiResponse } from '../http';

export interface AgentPolicyRouteDependencies {
  readonly tokens: AgentTokenStore;
  readonly policies: PolicySource;
  /** 정책 v2 — 수신 정책(수신 소비자와 같은 소스). */
  readonly inboundPolicies: InboundPolicyPort;
  readonly now: () => Date;
  /** 자가 등록 상태(발견만 읽는다 — 묶음 D). 없으면 발견은 `self_enroll: null`(테스트 대역 · 옛 조립). */
  readonly selfEnroll?: SelfEnrollStatusPort;
}

/** 에이전트가 볼 "바꾸는 법" — 정책은 소유자만 바꾼다(콘솔). 에이전트용 영어. */
const POLICY_CHANGE_HINT =
  'Only your owner can change this policy, in the console (https://console.atmark.ai → this agent → Outbound / Inbound). ' +
  'If you need to email someone who is not allowed, ask your owner to add the address or domain there — or ask with request_policy_change ' +
  '(POST /v1/agents/me/policy/requests, scope policy:request) and a reason; nothing changes until your owner approves it. ' +
  'Rules: an address matches exactly (including any +tag); "example.com" matches only that domain; "*.example.com" matches its subdomains.';

/** 발신·수신 정책을 **같은 버전으로** 읽을 때 다시 읽는 횟수 — 두 읽기 사이에 정책이 바뀐 경우(드물다). */
const CONSISTENT_READ_ATTEMPTS = 3;

export async function handleGetAgentPolicy(
  deps: AgentPolicyRouteDependencies,
  request: ApiRequest,
  params: { readonly agentId: string },
): Promise<ApiResponse> {
  // `me` = 토큰의 에이전트(`auth.claimedAgentOfPath`). id 를 적었으면 형식(400) · 인가는 오늘과 같다.
  const claimed = claimedAgentOfPath(params.agentId);
  if (claimed.kind === 'error') return claimed.response;

  const now = deps.now();
  const access = await authorizeAgentRequest(deps.tokens, request, now, 'agent:read_self', claimed.agentId);
  if (access.kind === 'error') return access.response;
  const { agentId } = access;

  let loaded: Awaited<ReturnType<PolicySource['load']>> | undefined;
  let inbound: InboundPolicy | undefined;
  try {
    // 발신(관문 소스)과 수신(수신 소비자 소스)은 다른 트랜잭션이다 — 둘 사이에 소유자가 정책을 바꾸면 버전이 갈린다. 같은 버전을
    // 볼 때까지 몇 번 다시 읽는다(목록 변경 = 새 버전이므로 버전이 같으면 목록도 같은 시점이다).
    for (let attempt = 0; attempt < CONSISTENT_READ_ATTEMPTS; attempt += 1) {
      // 수신자·스레드·릴리스 없이 읽는다 — 정책 자체만 필요하다.
      loaded = await deps.policies.load({ agentId, recipients: [], now, threadId: null, releaseApprovalId: null });
      inbound = await deps.inboundPolicies.loadInboundPolicy(agentId);
      if (inbound.version === loaded.policyVersion.version) break;
    }
  } catch (error) {
    if (error instanceof PolicySourceUnavailableError) {
      return errorResponse(404, 'policy_not_found', 'No policy was found for this agent.');
    }
    if (error instanceof PolicyShapeError) {
      return errorResponse(409, 'policy_unevaluable', 'The stored policy could not be read. Ask the owner to review it in the console.');
    }
    throw error;
  }
  if (loaded === undefined || inbound === undefined || inbound.version !== loaded.policyVersion.version) {
    return errorResponse(409, 'policy_changing', 'The policy is being changed right now. Read it again shortly.');
  }

  let policy: ReturnType<typeof resolvePolicy>;
  try {
    policy = resolvePolicy(loaded.policy, loaded.policyVersion, loaded.agentRequestedRuleIds);
  } catch (error) {
    if (error instanceof PolicyShapeError) {
      return errorResponse(
        409,
        'policy_unevaluable',
        'The stored policy could not be read, so every send from this agent is denied with evaluation_error until the owner fixes it.',
      );
    }
    throw error;
  }

  const legacy = (LEGACY_OUTBOUND_MODES as readonly string[]).includes(policy.outboundMode);
  // 관문(Stage 4 `evaluateLimits`)과 같은 클램프 — 요금제는 조이기만 한다. per_hour 는 요금제 차원이 아니다.
  const entitlements = resolveEntitlements(loaded.entitlements, now);
  return jsonResponse(200, {
    agent_id: policy.agentId,
    policy_version: policy.version,
    outbound_mode: policy.outboundMode,
    inbound_mode: inbound.mode,
    outbound: {
      mode: consoleOutboundModeOf(policy.outboundMode),
      allow: [...policy.allowlist],
      block_count: policy.blocklist.length,
    },
    inbound: {
      mode: consoleInboundModeOf(inbound.mode),
      allow: [...inbound.allow],
      block_count: inbound.block.length,
    },
    limits: {
      per_minute: Math.min(policy.limits.perMinute, entitlements.agentPerMinuteMax),
      per_hour: policy.limits.perHour,
      per_day: Math.min(policy.limits.perDay, entitlements.agentPerDayMax),
      recipients_per_message: Math.min(policy.limits.recipientsPerMessage, entitlements.recipientsPerMessageMax),
      // 조직 전체 24시간 수신자 상한 = min(워밍업, 요금제) — 관문 Stage 4 와 같은 함수.
      org_daily_recipients: organizationDailyCap(now, loaded.organization.sending_started_at, entitlements.orgDailyRecipients).cap,
    },
    policy_limits: {
      per_minute: policy.limits.perMinute,
      per_hour: policy.limits.perHour,
      per_day: policy.limits.perDay,
      recipients_per_message: policy.limits.recipientsPerMessage,
    },
    plan: entitlements.planCode,
    // 소유자 발신 승인(ADR-0016 2026-10-08) — `always` 면 정책이 허용한 발송도 전부 pending_approval(owner_requires_approval)이다. 다시 보내지 말고 결과를 기다린다.
    send_approval: policy.sendApproval,
    // 레거시 승인 모드(소유자 롤로만 생긴다)에서만 의미가 있는 값 — 그 모드일 때만 싣는다.
    ...(legacy
      ? {
          approval_ttl_seconds: policy.approvalTtlSeconds,
          pre_approval: {
            auto_approve_reply_within_thread: policy.preApproval.autoApproveReplyWithinThread,
            auto_approve_domains: [...policy.preApproval.autoApproveDomains],
            auto_approve_verification_senders: policy.preApproval.autoApproveVerificationSenders,
          },
        }
      : {}),
    how_to_change: POLICY_CHANGE_HINT,
  });
}
