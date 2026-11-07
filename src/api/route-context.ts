/**
 * src/api/route-context.ts — 발송 라우트 4종의 **관문 앞 공통 절차**.
 *
 * 순서가 계약이다:
 *   ① `Idempotency-Key` (§4.5-1) → ② 인증 → ③ 본문 파싱 → ④ 인가(대상 에이전트) → 관문
 *
 * **왜 멱등 키가 인증보다 먼저인가:** Layer D 가 매니페스트를 순회해 "키 없이 호출하면
 * 400" 케이스를 **모든 http 경로에 자동 생성**한다. 그 테스트가 토큰까지 갖춰야
 * 돌아간다면 검사는 인증 픽스처의 건강에 의존하게 되고, 픽스처가 깨지는 날 그 400 은
 * 401 로 조용히 바뀐다. 헤더 유무는 누구인지와 무관한 형식 검사다 — 형식이 먼저다.
 *
 * **왜 인가가 본문 파싱보다 뒤인가:** 인가는 `targetAgentId` 를 필수로 받는다
 * (`authorizeAgentToken` 의 설계). 그 값은 본문에 있으므로 파싱 전에는 인가를 **적을 수
 * 없다**.
 *
 * **본문 `agent_id` 생략 = 토큰의 에이전트**(2026-10-11, `auth.bodyWithDefaultAgent`). 키가 **없을 때만** 채우고, 적은 값은
 * 그대로 파싱 · 인가한다 — 적은 남의 id 를 자기 id 로 바꿔치는 일(§47 이 없애려던 것)은 여전히 일어나지 않는다.
 */

import type { AgentId } from '../db/schema';
import type { AgentTokenStore } from '../identity/agent-token';
import { log } from '../observability/logger';
import { countMetric, METRIC_NAMES } from '../observability/metrics';
import { authenticateRequest, authorizeRequest, bodyWithDefaultAgent } from './auth';
import { requireIdempotencyKey, type ApiRequest, type ApiResponse } from './http';
import { parseSendBody, toSendRequest } from './outbound-http';
import type { OutboundSendRequest, OutboundServiceDependencies } from './outbound-service';

export interface OutboundRouteDependencies {
  readonly tokens: AgentTokenStore;
  readonly service: OutboundServiceDependencies;
}

export type PreflightOutcome =
  | { readonly kind: 'ok'; readonly request: OutboundSendRequest }
  | { readonly kind: 'error'; readonly response: ApiResponse };

/**
 * 관문 앞에서 죽은 요청을 방출한다. **관문 지표에 보이지 않는 유일한 축이다.**
 *
 * `gate.attempt` 는 관문을 *지난* 것만 센다. 그런데 400/401/403 은 관문에 닿지도
 * 못하므로, 여기서 방출하지 않으면 **"클라이언트가 계속 400을 받고 있다"는 사실이
 * 어디에도 나타나지 않는다** — 발송량 그래프는 조용히 0으로 수렴하고, 그 0은
 * "보낼 게 없었다" 와 구별되지 않는다.
 *
 * 본문·주소는 싣지 않는다. `error_code` 는 기계가 읽는 닫힌 값이고(`http.ts` 규약),
 * 그것만으로 "무엇이 틀렸는가" 는 충분히 좁혀진다.
 */
function observeRejection(routeId: string, response: ApiResponse): void {
  const code = response.body['error'];
  countMetric(METRIC_NAMES.preflightRejected, { route_id: routeId });
  log('warn', 'api.preflight_rejected', {
    route_id: routeId,
    http_status: response.status,
    error_code: typeof code === 'string' ? code : null,
  });
}

/**
 * `isThreadReply` 는 **리터럴 `false`** 다(P3b) — 이 절차로 들어오는 경로는 스레드 회신을 주장할 수 없다.
 * 회신(`routes/reply.ts`)은 `preflightWith` 로 자기 본문을 파싱하고, 스레드는 DB 에서 찾는다.
 */
export async function preflight(
  deps: OutboundRouteDependencies,
  request: ApiRequest,
  routeId: string,
  isThreadReply: false,
): Promise<PreflightOutcome> {
  const pre = await preflightWith(deps, request, routeId, parseSendBody);
  if (pre.kind === 'error') return pre;
  return { kind: 'ok', request: toSendRequest(pre.body, routeId, pre.idempotencyKey, isThreadReply) };
}

/** `preflightWith` 의 본문 파서 — 실패는 응답 그 자체다(`parseSendBody` 와 같은 규약). */
export type BodyParser<T extends { readonly agentId: AgentId }> = (
  body: unknown,
) => { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'error'; readonly response: ApiResponse };

export type PreflightWithOutcome<T> =
  | { readonly kind: 'ok'; readonly idempotencyKey: string; readonly body: T }
  | { readonly kind: 'error'; readonly response: ApiResponse };

/**
 * 같은 순서(① 멱등 키 → ② 인증 → ③ 본문 파싱 → ④ 인가)를 **본문 모양이 다른 경로**에 준다(P3b `reply`).
 * 순서를 경로마다 다시 쓰지 않는 이유는 머리말과 같다 — 한 경로만 인증을 키 검사 앞에 두는 날
 * Layer D 의 400 이 그 경로에서만 401 로 바뀐다.
 */
export async function preflightWith<T extends { readonly agentId: AgentId }>(
  deps: OutboundRouteDependencies,
  request: ApiRequest,
  routeId: string,
  parse: BodyParser<T>,
): Promise<PreflightWithOutcome<T>> {
  const key = requireIdempotencyKey(request);
  if (key.kind === 'error') {
    observeRejection(routeId, key.response);
    return { kind: 'error', response: key.response };
  }

  const now = deps.service.now();
  const authentication = await authenticateRequest(deps.tokens, request, now);
  if (authentication.kind === 'error') {
    observeRejection(routeId, authentication.response);
    return { kind: 'error', response: authentication.response };
  }

  const body = parse(bodyWithDefaultAgent(request.body, authentication.principal));
  if (body.kind === 'error') {
    observeRejection(routeId, body.response);
    return { kind: 'error', response: body.response };
  }

  // **대상은 본문의 `agent_id` 다**(생략했으면 위에서 채운 토큰의 에이전트). 적은 값을 principal 의 것으로 바꿔치면 "남의 에이전트로
  // 보내려 했다" 는 시도가 조용히 자기 발송으로 성공한다 — AC-1 이 막으려는 위조와
  // 같은 종류의 사고이고, 여기서는 Stage 1 에 닿기도 전에 일어난다.
  const forbidden = authorizeRequest(authentication.principal, 'messages:send', body.value.agentId);
  if (forbidden !== null) {
    observeRejection(routeId, forbidden);
    return { kind: 'error', response: forbidden };
  }

  return { kind: 'ok', idempotencyKey: key.key, body: body.value };
}
