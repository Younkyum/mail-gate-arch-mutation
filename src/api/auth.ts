/**
 * src/api/auth.ts — agent-scoped 토큰의 HTTP 경계.
 *
 * **규칙은 여기 없다.** 형식·해시·만료·권한 판정은 전부 `src/identity/agent-token.ts`
 * 에 있고 이 파일은 그 결과를 **HTTP 상태코드로 번역**만 한다. 판정이 두 곳이 되면
 * 한쪽만 고쳐진 상태가 곧 "폐기했는데 아직 되는 토큰" 이다.
 *
 * **401 과 403 을 가른다.** 401 은 "당신이 누구인지 모르겠다", 403 은 "누구인지는 알고
 * 그 권한이 없다" 다. 하나로 합치면 운영 질의("토큰이 죽었나, 권한이 모자라나")에
 * 답할 수 없다. 대신 **거부 사유의 세부는 본문에 넣되 상태코드로는 새지 않게** 한다.
 */

import {
  authenticateAgentToken,
  authorizeAgentToken,
  type AgentPrincipal,
  type AgentTokenCapability,
  type AgentTokenStore,
} from '../identity/agent-token';
import { isAgentId, type AgentId } from '../db/schema';
import { looksLikeOrgApiKey } from '../identity/org-api-key';
import { AUTHORIZATION_HEADER, errorResponse, headerOf, isJsonObject, type ApiRequest, type ApiResponse } from './http';

const BEARER_PREFIX = 'bearer ';

export type AuthenticationOutcome =
  | { readonly kind: 'ok'; readonly principal: AgentPrincipal }
  | { readonly kind: 'error'; readonly response: ApiResponse };

/**
 * `Authorization: Bearer atk_agent_...` → principal.
 *
 * 토큰을 쿼리스트링이나 본문에서 받지 않는다. URL 에 실린 비밀은 액세스 로그·리퍼러·
 * 브라우저 히스토리에 남고, 그 셋은 우리가 지울 수 없는 저장소다.
 */
export async function authenticateRequest(
  store: AgentTokenStore,
  request: ApiRequest,
  now: Date,
): Promise<AuthenticationOutcome> {
  const header = headerOf(request, AUTHORIZATION_HEADER);
  if (header === null || !header.toLowerCase().startsWith(BEARER_PREFIX)) {
    return {
      kind: 'error',
      response: errorResponse(401, 'unauthorized', 'An Authorization: Bearer <atk_agent_...> header is required.'),
    };
  }

  const presented = header.slice(BEARER_PREFIX.length).trim();
  // 조직 API 키(`atk_org_`, 확장성 P1 R-6)는 이 호스트의 토큰이 아니다 — 콘솔 호스트 `/org-api/v1` 만 받는다(프로비저닝 보관소가 admin
  // Lambda 에만 있다). 조회하지 않고 거부하되, 무엇이 틀렸는지는 알려 준다(접두사는 공개 분류자다).
  if (looksLikeOrgApiKey(presented)) {
    return {
      kind: 'error',
      response: errorResponse(401, 'unauthorized', 'Organization keys (atk_org_) do not work here. Use them with https://console.atmark.ai/org-api/v1.'),
    };
  }
  const result = await authenticateAgentToken(store, presented, now);
  if (result.kind === 'rejected') {
    // 사유를 본문에 담는다. `malformed_token` 과 `unknown_token` 을 구별해 주는 것이
    // 공격자에게 주는 정보는 사실상 없고(토큰 형식은 접두사로 이미 공개다),
    // 운영자에게 주는 정보는 크다 — "오타인가 폐기인가" 가 첫 질문이기 때문이다.
    return { kind: 'error', response: errorResponse(401, 'unauthorized', result.reason) };
  }
  return { kind: 'ok', principal: result.principal };
}

/**
 * 인가. **통과하면 `null`** — 반환값이 곧 "막혔다" 의 존재 여부다.
 *
 * `targetAgentId` 를 그대로 흘려보낸다. `authorizeAgentToken` 이 이 인자를 필수로
 * 받는 이유(호출부가 대상을 *적어야* 한다)를 여기서 optional 로 덮으면 그 설계가 사라진다.
 */
export function authorizeRequest(
  principal: AgentPrincipal,
  capability: AgentTokenCapability,
  targetAgentId: AgentId,
): ApiResponse | null {
  const result = authorizeAgentToken(principal, capability, targetAgentId);
  if (result.kind === 'authorized') return null;
  return errorResponse(403, 'forbidden', result.reason);
}

// ---------------------------------------------------------------------------
// 대상 에이전트 — "생략 = 토큰의 에이전트" (2026-10-11 진윤겸 결정, DX)
// ---------------------------------------------------------------------------
//
// 에이전트 토큰은 정확히 한 에이전트에 묶여 있다. 그래서 `agent_id` 를 **생략하면** 토큰의 에이전트가 대상이다.
// **적으면 오늘과 똑같다** — 형식 검사(400) 다음 `authorizeRequest` 가 그 값으로 인가한다(남의 id → 403). 생략을 principal 로
// 채우는 것은 "적은 값을 바꿔치기" 가 아니다: 바꿔치기(적은 남의 id 를 자기 id 로 덮기)는 여전히 일어나지 않고, 인가도 그대로 돈다.
// 조직 키(`atk_org_`)는 `authenticateRequest` 가 먼저 401 로 끊으므로 이 기본값에 닿지 않는다.

/**
 * 경로 별칭 `/v1/agents/me/…` — 토큰의 에이전트. 에이전트 id 는 32자 소문자 hex(`AGENT_ID_PATTERN`)라 `me` 와 겹칠 수 없다.
 */
export const SELF_AGENT_ALIAS = 'me';

/** 형식 위반 — 대상을 적었는데 모양이 틀렸다(400, 인증 전에 낸다 — 오늘과 같다). */
export type ClaimedAgent =
  | { readonly kind: 'ok'; readonly agentId: AgentId | null }
  | { readonly kind: 'error'; readonly response: ApiResponse };

/**
 * 쿼리 `agent_id`. **키가 없으면** `null`(= 토큰의 에이전트). 키가 있으면 형식을 본다 — 빈 값도 "적었다" 로 보고 400 이다
 * (조용히 기본값으로 떨어지지 않게).
 */
export function claimedAgentOfQuery(request: ApiRequest): ClaimedAgent {
  const raw = request.query['agent_id'];
  if (raw === undefined) return { kind: 'ok', agentId: null };
  const trimmed = raw.trim();
  if (!isAgentId(trimmed)) {
    return {
      kind: 'error',
      response: errorResponse(400, 'invalid_request', "The agent_id query parameter must be 32 lowercase hex characters (or leave it out to use your token's agent)."),
    };
  }
  return { kind: 'ok', agentId: trimmed };
}

/** 경로 `{agentId}` — `me` 면 `null`(= 토큰의 에이전트), 아니면 형식을 본다. */
export function claimedAgentOfPath(raw: string): ClaimedAgent {
  if (raw === SELF_AGENT_ALIAS) return { kind: 'ok', agentId: null };
  if (!isAgentId(raw)) {
    return { kind: 'error', response: errorResponse(400, 'invalid_request', 'agent id must be 32 lowercase hex characters (or "me" for your token\'s agent).') };
  }
  return { kind: 'ok', agentId: raw };
}

/** 적은 대상 또는(생략이면) 토큰의 에이전트. 인가는 호출부가 **이 값으로** 그대로 한다. */
export function targetAgentOf(principal: AgentPrincipal, claimed: AgentId | null): AgentId {
  return claimed ?? principal.agentId;
}

export type AgentAccessOutcome =
  | { readonly kind: 'ok'; readonly principal: AgentPrincipal; readonly agentId: AgentId }
  | { readonly kind: 'error'; readonly response: ApiResponse };

/** 인증(401) → 대상(`targetAgentOf`) → 그 대상으로 인가(403). 대상을 적는 라우트 대부분의 공통 앞단. */
export async function authorizeAgentRequest(
  store: AgentTokenStore,
  request: ApiRequest,
  now: Date,
  capability: AgentTokenCapability,
  claimed: AgentId | null,
): Promise<AgentAccessOutcome> {
  const authentication = await authenticateRequest(store, request, now);
  if (authentication.kind === 'error') return authentication;
  const agentId = targetAgentOf(authentication.principal, claimed);
  const forbidden = authorizeRequest(authentication.principal, capability, agentId);
  if (forbidden !== null) return { kind: 'error', response: forbidden };
  return { kind: 'ok', principal: authentication.principal, agentId };
}

/**
 * 본문 `agent_id` 기본값 — **키가 없을 때만** 토큰의 에이전트를 채운다. 키가 있으면(빈 값 · null 포함) 손대지 않는다 — 형식 검사와
 * 인가는 오늘처럼 라우트 파서 · `authorizeRequest` 가 한다. 객체가 아니면 그대로(파서가 400 을 낸다).
 */
export function bodyWithDefaultAgent(body: unknown, principal: AgentPrincipal): unknown {
  if (!isJsonObject(body)) return body;
  if (Object.prototype.hasOwnProperty.call(body, 'agent_id')) return body;
  return { ...body, agent_id: principal.agentId };
}
