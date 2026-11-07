/**
 * `POST /v1/agents` — **에이전트 자가 등록**(ADR-0016 2026-10-08 개정 "자가 등록" · 계획 watch-and-dev-surface 묶음 D 항목 2a). MCP `create_agent` 도 이 함수다.
 *
 * `agents:enroll` 토큰을 가진 에이전트가 **같은 조직에** 형제 에이전트 하나를 만든다 — 조직 설정(감시 탭 `agentSelfEnroll`, 기본 꺼짐)이 켜졌을 때만, 조직 하루 상한
 * (`enrollDailyCap`, 기본 5 · 최대 20) · 요금제 에이전트 한도 안에서. 새 에이전트는 **안전 기본값 고정**이다(고를 수 없다): 발신 allowlist_only(빈 목록) ·
 * 수신 all · 발신 승인 always · 위험 처리 hold · 토큰 `messages:send`·`messages:read`·`agent:read_self` 뿐(`agents:enroll` 없음 — 연쇄 금지). 응답의 토큰은 **한 번만**.
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 메일을 보내지 않고 관문을 import 하지 않는다. 정책 쓰기 · 자기 토큰 · 다른 에이전트의 데이터에 닿지 않는다 —
 * 하는 일은 admin λ 의 자가 등록 이벤트 하나를 부르는 것뿐이다(`runtime/enroll-event.ts`). 여기서 토큰 · 권한 · 입력을 한 번 보고(빠른 거절), admin λ 가
 * **DB 에서 처음부터 다시** 판정한다(토큰 원문 → 해시 · 상태 · 설정 · 하루 상한 — 트리거).
 *
 * 응답 201: `{agent:{agent_id, name, address}, token, token_scopes, defaults:{…}, policy_version, how_to_change}`.
 * 거절: 400 `invalid_request`(본문 · 이름 · 로컬파트) · 401 · 403 `forbidden`(권한 없음) · 403 `self_enroll_disabled` · 403 `agent_not_active` ·
 * 403 `enroll_chain_forbidden` · 409 `address_taken` · 409 `agent_limit` · 429 `enroll_daily_cap` · 429 `enroll_rate_limited`(에이전트당 분당 3 — admin 을 부르지 않는다) · 503 `enroll_busy`(관리 함수가 바쁘다 — 잠시 뒤 한 번) ·
 * 503 `enroll_timeout`(만들어졌을 수 있다 — 바로 다시 부르지 말고 소유자에게 확인) · 503 `enroll_unavailable`.
 */

import { isAgentId } from '../../db/schema';
import type { AgentTokenStore } from '../../identity/agent-token';
import {
  ENROLL_EVENT_ACTION,
  ENROLL_EVENT_SOURCE,
  ENROLL_EVENT_VERSION,
  ENROLL_NAME_MAX,
  parseEnrollResult,
  type AgentEnroller,
  type EnrollRefusal,
} from '../../runtime/enroll-event';
import type { EnrollPrecheck } from '../../db/repositories/self-enroll-status';
import { authenticateRequest, authorizeRequest } from '../auth';
import { AUTHORIZATION_HEADER, errorResponse, headerOf, isJsonObject, jsonResponse, type ApiRequest, type ApiResponse } from '../http';

export interface AgentEnrollRouteDependencies {
  readonly tokens: AgentTokenStore;
  /** admin λ 자가 등록 호출. `null` 이면 이 조립에는 없다(503 `enroll_unavailable`). */
  readonly enroll: AgentEnroller | null;
  readonly now: () => Date;
  /** 요청 id(로그를 잇는다 — admin λ 로그의 trace_id). */
  readonly requestId: () => string;
  /**
   * admin 을 부르기 **전** 거르개(배포 전 보안 리뷰 — admin 예약 동시성 3 보호): 조직 설정 · 하루 상한 · 에이전트당 분당 3(`atmark_enroll_precheck`). `null` 이면
   * 거르지 않는다(테스트 대역 — 운영 조립은 늘 싣는다).
   */
  readonly precheck: ((agentId: string) => Promise<EnrollPrecheck>) | null;
}

/** 새 에이전트의 고정 기본값 — 응답 · 발견 문서가 같은 값을 말한다. */
export const ENROLLED_AGENT_DEFAULTS = {
  outbound_mode: 'allowlist_only',
  outbound_allow: [] as string[],
  inbound_mode: 'all',
  send_approval: 'always',
  risk_handling: 'hold',
} as const;

const BODY_KEYS: ReadonlySet<string> = new Set(['name', 'local_part']);

const REFUSAL_RESPONSES: Readonly<Record<EnrollRefusal, readonly [number, string, string]>> = {
  unauthorized: [401, 'unauthorized', 'The agent token is not valid.'],
  scope_missing: [403, 'forbidden', 'capability_not_granted'],
  not_active: [403, 'agent_not_active', 'This agent or its organization is not active (paused, suspended or under review).'],
  self_enroll_disabled: [403, 'self_enroll_disabled', 'Your owner has not turned on agent self-enrollment in the console (Watch tab).'],
  enroll_daily_cap: [429, 'enroll_daily_cap', 'The organization reached its daily limit for self-enrollment. Try again tomorrow or ask your owner.'],
  agent_limit: [409, 'agent_limit', 'The organization reached its plan limit for agents.'],
  address_taken: [409, 'address_taken', 'That address is not available. Pick another local_part (this attempt still counts toward the daily limit).'],
  invalid_local_part: [400, 'invalid_request', 'local_part is not a valid or allowed address local part.'],
  invalid_name: [400, 'invalid_request', `name must be 1–${String(ENROLL_NAME_MAX)} visible characters.`],
  chain_forbidden: [403, 'enroll_chain_forbidden', 'An agent created by self-enrollment cannot create agents.'],
  replayed: [409, 'enroll_replayed', 'This enrollment request was already processed. No new agent was created.'],
  unavailable: [503, 'enroll_unavailable', 'Self-enrollment is unavailable right now.'],
};

function refusalResponse(refusal: EnrollRefusal): ApiResponse {
  const [status, error, detail] = REFUSAL_RESPONSES[refusal];
  return errorResponse(status, error, detail);
}

export async function handleEnrollAgent(deps: AgentEnrollRouteDependencies, request: ApiRequest): Promise<ApiResponse> {
  const authentication = await authenticateRequest(deps.tokens, request, deps.now());
  if (authentication.kind === 'error') return authentication.response;
  const principal = authentication.principal;
  // 부른 에이전트 자신에 대한 권한이다 — 만든 에이전트에 대한 권한은 생기지 않는다(새 토큰은 응답에만 있다).
  const forbidden = authorizeRequest(principal, 'agents:enroll', principal.agentId);
  if (forbidden !== null) return forbidden;

  const body = request.body;
  if (!isJsonObject(body)) return errorResponse(400, 'invalid_request', 'Body must be a JSON object: {name, local_part?}.');
  const record = body;
  const unknown = Object.keys(record).find((key) => !BODY_KEYS.has(key));
  if (unknown !== undefined) return errorResponse(400, 'invalid_request', `Unknown field: ${unknown.slice(0, 40)} (name, local_part).`);
  const name = record['name'];
  const localPart = record['local_part'];
  if (typeof name !== 'string' || name.trim() === '' || [...name.trim()].length > ENROLL_NAME_MAX) return refusalResponse('invalid_name');
  if (localPart !== undefined && localPart !== null && (typeof localPart !== 'string' || localPart.length < 1 || localPart.length > 64)) {
    return refusalResponse('invalid_local_part');
  }
  if (deps.enroll === null || !isAgentId(principal.agentId)) return refusalResponse('unavailable');
  if (deps.precheck !== null) {
    const pre = await deps.precheck(principal.agentId);
    if (pre === 'disabled') return refusalResponse('self_enroll_disabled');
    if (pre === 'daily_cap') return refusalResponse('enroll_daily_cap');
    if (pre === 'not_found') return refusalResponse('unauthorized');
    if (pre === 'rate_limited') {
      return { status: 429, body: { error: 'enroll_rate_limited', detail: 'Too many self-enrollment attempts. Wait a minute before trying again.', retry_after_seconds: 60 } };
    }
  }

  const header = headerOf(request, AUTHORIZATION_HEADER) ?? '';
  const token = header.slice('bearer '.length).trim();
  const invoked = await deps.enroll({
    source: ENROLL_EVENT_SOURCE,
    action: ENROLL_EVENT_ACTION,
    v: ENROLL_EVENT_VERSION,
    token,
    name: name.trim(),
    localPart: typeof localPart === 'string' ? localPart.trim().toLowerCase() : null,
    requestId: deps.requestId(),
  });
  if (!invoked.ok) {
    if (invoked.reason === 'busy') return errorResponse(503, 'enroll_busy', 'Self-enrollment is busy. Try once more in a minute.');
    if (invoked.reason === 'timeout') {
      return errorResponse(503, 'enroll_timeout', 'Self-enrollment did not answer in time. The agent may have been created — do not retry right away; ask your owner to check the console.');
    }
    return refusalResponse('unavailable');
  }
  const result = parseEnrollResult(invoked.body);
  if (!result.ok) return refusalResponse(result.error);
  return jsonResponse(201, {
    agent: { agent_id: result.agent.id, name: result.agent.name, address: result.agent.address },
    token: result.token,
    token_scopes: [...result.scopes],
    token_shown_once: true,
    defaults: ENROLLED_AGENT_DEFAULTS,
    policy_version: result.policyVersion,
    how_to_change: 'Only your owner can change the new agent’s policy, approval and risk settings, in the console (https://console.atmark.ai).',
  });
}
