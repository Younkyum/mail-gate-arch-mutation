/**
 * 발견(묶음 B) — `GET /.well-known/atmark.json` · `GET /v1/openapi.json`(둘 다 **무인증** · 공개 캐시) · `GET /v1/agents/{id}/capabilities`(에이전트 토큰).
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 상수 문서를 돌려주고, capabilities 는 정책을 **읽기만** 한다(`agent-policy.ts` 와 같은 소스 ·
 * 같은 라우트 함수) — 관문을 import 하지 않는다. MCP `get_capabilities` 도 이 함수다.
 */

import { PolicySourceUnavailableError } from '../../policy/policy-loader';
import { authorizeAgentRequest, claimedAgentOfPath } from '../auth';
import { discoveryDocument, realtimeConnectionInfo, REALTIME_URL } from '../discovery';
import { jsonResponse, type ApiRequest, type ApiResponse } from '../http';
import { openApiDocument } from '../openapi/document';
import { handleGetAgentPolicy, type AgentPolicyRouteDependencies } from './agent-policy';
import { ENROLLED_AGENT_DEFAULTS } from './agents-enroll';

/** 무인증 공개 문서의 응답 머리 — 브라우저 · 에이전트 어디서나 읽게(CORS `*`), 5분 캐시. 라우터가 덧붙인다. */
export const PUBLIC_DOCUMENT_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=300',
};

/** 실시간 접속 주소(묶음 E) — 배포가 정한다(조립 루트가 `ATMARK_REALTIME_URL` 을 읽어 넣는다). 없으면 정본 호스트. */
export interface RealtimeUrlDependency {
  readonly realtimeUrl?: string;
}

export function handleGetDiscovery(realtimeUrl: string = REALTIME_URL): Promise<ApiResponse> {
  return Promise.resolve(jsonResponse(200, discoveryDocument(realtimeUrl)));
}

/**
 * `GET /v1/agents/{agentId}/realtime`(MCP `get_realtime_connection`) — 실시간 WebSocket 에 붙는 법: 주소 · 인증(헤더 또는 하위 프로토콜 — 쿼리 문자열은
 * 거부) · 이벤트 스키마 · 한도 · 재연결. 토큰 권한은 연결과 같은 `messages:read`. **토큰을 되돌려 싣지 않는다**(본문은 상수와 주소뿐).
 */
export async function handleGetRealtimeConnection(
  deps: Pick<AgentPolicyRouteDependencies, 'tokens' | 'now'> & RealtimeUrlDependency,
  request: ApiRequest,
  params: { readonly agentId: string },
): Promise<ApiResponse> {
  // `me` = 토큰의 에이전트(`auth.claimedAgentOfPath`). id 를 적었으면 형식(400) · 인가는 오늘과 같다.
  const claimed = claimedAgentOfPath(params.agentId);
  if (claimed.kind === 'error') return claimed.response;
  const access = await authorizeAgentRequest(deps.tokens, request, deps.now(), 'messages:read', claimed.agentId);
  if (access.kind === 'error') return access.response;
  const { agentId } = access;
  return jsonResponse(200, { agent_id: agentId, ...realtimeConnectionInfo(deps.realtimeUrl ?? REALTIME_URL) });
}

export function handleGetOpenApi(): Promise<ApiResponse> {
  return Promise.resolve(jsonResponse(200, openApiDocument()));
}

/**
 * 발견 문서 + **부르는 에이전트**: 주소(대표 · 별칭) · 토큰 권한 · 정책 요약(발신 · 수신 모드 · 한도 — `GET /v1/agents/{id}/policy` 와 같은 값).
 * 정책을 읽지 못하면 그 응답의 오류를 그대로 돌려준다(요약을 지어내지 않는다).
 */
export async function handleGetCapabilities(
  deps: AgentPolicyRouteDependencies & RealtimeUrlDependency,
  request: ApiRequest,
  params: { readonly agentId: string },
): Promise<ApiResponse> {
  // `me` = 토큰의 에이전트(`auth.claimedAgentOfPath`). id 를 적었으면 형식(400) · 인가는 오늘과 같다.
  const claimed = claimedAgentOfPath(params.agentId);
  if (claimed.kind === 'error') return claimed.response;
  const access = await authorizeAgentRequest(deps.tokens, request, deps.now(), 'agent:read_self', claimed.agentId);
  if (access.kind === 'error') return access.response;
  const { agentId } = access;

  const policy = await handleGetAgentPolicy(deps, request, params);
  if (policy.status !== 200) return policy;

  let addresses: { address: string; primary: boolean }[] = [];
  try {
    const loaded = await deps.policies.load({ agentId, recipients: [], now: deps.now(), threadId: null, releaseApprovalId: null });
    // 유효 대표(ADR-0014 2026-10 개정) — 로더가 정한 값이 있으면 그것, 없으면 앵커 행.
    const primary = loaded.primaryAddress !== undefined ? loaded.primaryAddress : (loaded.addresses.find((row) => row.is_primary)?.address ?? null);
    addresses = loaded.addresses.map((row) => ({ address: row.address, primary: primary !== null && row.address === primary }));
  } catch (error) {
    if (!(error instanceof PolicySourceUnavailableError)) throw error;
  }
  const body = policy.body;
  // 자가 등록(묶음 D) — 권한 · 소유자 설정 · 하루 상한. 판정은 admin λ · DB 가 다시 한다(여기는 안내).
  const scopeGranted = access.principal.capabilities.includes('agents:enroll');
  const enroll = deps.selfEnroll === undefined ? null : await deps.selfEnroll.load(agentId);
  const selfEnroll =
    enroll === null
      ? null
      : {
          available: scopeGranted && enroll.enabled && enroll.usedLast24h < enroll.dailyCap,
          scope_granted: scopeGranted,
          enabled_by_owner: enroll.enabled,
          daily_cap: enroll.dailyCap,
          used_last_24h: enroll.usedLast24h,
          endpoint: 'POST /v1/agents',
          mcp_tool: 'create_agent',
          defaults: ENROLLED_AGENT_DEFAULTS,
        };
  // 요약 — 모드와 목록 **개수**만(목록 자체는 `get_my_policy` · `GET /v1/agents/{id}/policy`).
  const section = (value: unknown): Record<string, unknown> | null => {
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    return { mode: record['mode'] ?? null, allow_count: Array.isArray(record['allow']) ? record['allow'].length : 0, block_count: record['block_count'] ?? 0 };
  };
  return jsonResponse(200, {
    ...discoveryDocument(deps.realtimeUrl ?? REALTIME_URL),
    agent: {
      agent_id: agentId,
      address: addresses.find((row) => row.primary)?.address ?? addresses[0]?.address ?? null,
      addresses,
      scopes: [...access.principal.capabilities],
    },
    policy: {
      policy_version: body['policy_version'] ?? null,
      outbound: section(body['outbound']),
      inbound: section(body['inbound']),
      limits: body['limits'] ?? null,
      plan: body['plan'] ?? null,
      send_approval: body['send_approval'] ?? null,
      how_to_change: body['how_to_change'] ?? null,
    },
    self_enroll: selfEnroll,
  });
}
