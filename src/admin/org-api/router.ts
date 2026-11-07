/**
 * src/admin/org-api/router.ts — **조직 API 키 표면**의 라우트 표·인증(확장성 P1 R-6, 계획 §3.7 H1 · 계약 `.omc/handoffs/p0p1-api.md` B5).
 *
 * 콘솔 호스트(admin Lambda)의 `/org-api/v1/*` — admin 라우터(`src/admin/router.ts`)가 접두사로 이리 위임한다. 프로비저닝 보관소(KMS·
 * Secrets Manager)가 admin Lambda 역할에만 있어 api Lambda(발신 주체)의 역할을 넓히지 않는다(계획 F7).
 *
 * 규칙(이 표면은 **기계 전용**이다):
 *   - `Authorization: Bearer atk_org_<43>` **만**. 쿠키는 읽지 않는다(세션 쿠키가 있어도 무시 — 섞인 요청을 "어느 쪽이 이기나" 로 풀지 않는다).
 *   - `Origin` 헤더가 있으면 403 `origin_forbidden` — 브라우저가 보낸 요청을 받지 않는다(CSRF·CORS 면이 0). CORS 헤더를 싣지 않는다.
 *   - 헤더 없음 · 모양 아님 · 모르는 키 · 폐기 · 만료 → 401 `unauthenticated` 한 코드(에이전트 토큰은 detail 로 안내만).
 *   - 권한은 라우트마다 하나(`capability`) — 없으면 403 `forbidden_capability {required}`. 권한 검사는 대상 조회 **전**.
 *   - 본문 JSON 만(415) · 64 KiB(413). 모르는 경로 404 · 메서드 405.
 *   - 속도: API Gateway 라우트 `ANY /org-api/{proxy+}`(`CONSOLE_ROUTE_THROTTLES`, rate 10 · burst 20) — `$default`(콘솔·kill-switch)
 *     버킷을 비우지 못하고, 같은 admin Lambda 예약 동시성(3)을 콘솔과 나눠 쓰는 동안 **콘솔 몫을 남기는 유일한 장치**다(`$default` 의
 *     절반 이하 — 적대적 검토 H1). 그 천장은 전 조직 합이고, **조직 공정성은 인증 직후 DB 창 계수**(`rate-limit.ts` — 키당 60 · 조직당
 *     120/분 → 429 `rate_limited` + `Retry-After`, ADR-0010 L5)가 맡는다. 에이전트 생성은 조직당 분당 10(`limitOrgApiAgentCreates`)이 따로 묶는다.
 *   - DB 풀 대기 상한 1초(`pool-wait.ts`) — 커넥션을 못 받으면 503 `database_busy`. 호출 하나가 실행 환경을 쥐는 시간을 줄일 뿐 콘솔
 *     굶주림을 막지는 못한다(동시성은 호출 단위다 — `pool-wait.ts` 머리말).
 * 거부는 값 없이 한 줄씩(`logSecurityEvent('org_key_rejected' …)`).
 */

import { AGENT_TOKEN_PREFIX } from '../../identity/agent-token';
import type { OrgApiKeyCapability } from '../../identity/org-api-key';
import { log } from '../../observability/logger';
import { logSecurityEvent, type AdminDependencies } from '../context';
import {
  clientIpOf,
  errorResponse,
  findRoute,
  jsonResponse,
  lowerHeaders,
  parseQuery,
  readJsonBody,
  type AdminHttpEvent,
  type AdminRequest,
  type AdminResponse,
} from '../http';
import { AdminInputError, domainSqlStateRejection, sqlStateOf } from '../ops/errors';
import { authenticateOrgKey, touchOrgKey } from '../ops/org-keys';
import {
  handleOrgApiAddDomain,
  handleOrgApiCheckDomain,
  handleOrgApiGetDomain,
  handleOrgApiListDomains,
  handleOrgApiRemoveDomain,
} from '../routes/domains';
import { handleOrgApiCreateAgent, handleOrgApiGetAgent, handleOrgApiListAgents, type OrgApiCall } from '../routes/org-api';
import { OrgApiPoolBusyError, withPoolWaitCap } from './pool-wait';
import { countOrgApiRequest } from './rate-limit';

const ORG_API_PREFIX = '/org-api';

type OrgApiMethod = 'GET' | 'POST' | 'DELETE';

interface OrgApiRoute {
  readonly method: OrgApiMethod;
  readonly path: string;
  /** 이 라우트에 필요한 키 권한 — 하나. */
  readonly capability: OrgApiKeyCapability;
  readonly handler: (call: OrgApiCall) => Promise<AdminResponse>;
}

/** **조직 키 라우트 표** — 여기 없는 `/org-api/*` 경로는 404. */
export const ORG_API_ROUTES: readonly OrgApiRoute[] = [
  { method: 'GET', path: '/org-api/v1/agents', capability: 'agents:read', handler: handleOrgApiListAgents },
  { method: 'GET', path: '/org-api/v1/agents/{agentId}', capability: 'agents:read', handler: handleOrgApiGetAgent },
  { method: 'POST', path: '/org-api/v1/agents', capability: 'agents:create', handler: handleOrgApiCreateAgent },
  // 고객 도메인(ADR-0014 단계 4 M3b) — 보기 · 쓰기 모두 `domains:manage` 하나(콘솔 연산과 같다 · 키 행위자 감사).
  { method: 'GET', path: '/org-api/v1/domains', capability: 'domains:manage', handler: handleOrgApiListDomains },
  { method: 'POST', path: '/org-api/v1/domains', capability: 'domains:manage', handler: handleOrgApiAddDomain },
  { method: 'GET', path: '/org-api/v1/domains/{domainId}', capability: 'domains:manage', handler: handleOrgApiGetDomain },
  { method: 'POST', path: '/org-api/v1/domains/{domainId}/check', capability: 'domains:manage', handler: handleOrgApiCheckDomain },
  { method: 'DELETE', path: '/org-api/v1/domains/{domainId}', capability: 'domains:manage', handler: handleOrgApiRemoveDomain },
];

const BEARER = /^bearer\s+(\S+)\s*$/i;

/** 에이전트 id·조직 id 모양이 아닌 대상 404 는 탐침 신호라 센다. */
const PROBE_CODES: ReadonlySet<string> = new Set(['agent_not_found', 'domain_not_found']);

export function isOrgApiPath(path: string): boolean {
  return path === ORG_API_PREFIX || path.startsWith(`${ORG_API_PREFIX}/`);
}

function unauthenticated(detail: string): AdminResponse {
  return errorResponse(401, 'unauthenticated', detail);
}

/** 429 — 다음에 해 볼 수 있을 때까지의 초를 `Retry-After` 로. */
function rateLimited(detail: string, retryAfterSeconds: number, code = 'rate_limited'): AdminResponse {
  const response = errorResponse(429, code, detail);
  return { ...response, headers: { ...response.headers, 'retry-after': String(retryAfterSeconds) } };
}

/**
 * `/org-api/*` 요청 하나 → 응답. **던지지 않는다**(관리 예외·유니크 위반은 응답으로, 모르는 예외는 로그 + 500). `path` 는 스테이지를 벗기고
 * 끝 `/` 를 지운 값(admin 라우터와 같은 정규화).
 */
export async function routeOrgApiRequest(adminDeps: AdminDependencies, event: AdminHttpEvent, method: string, path: string): Promise<AdminResponse> {
  const requestId = event.requestContext.requestId;
  // 이 요청의 모든 DB 접근은 풀 대기 상한 1초를 탄다(콘솔 경로는 그대로).
  const deps: AdminDependencies = { ...adminDeps, pool: withPoolWaitCap(adminDeps.pool) };
  try {
    const found = findRoute(ORG_API_ROUTES, method, path);
    if (found.kind === 'rejected') return found.response;
    const { entry, params } = found;
    const headers = lowerHeaders(event);

    // 브라우저 요청 거부 — 이 표면은 CI·서버 전용이다.
    if (headers['origin'] !== undefined) {
      logSecurityEvent('org_key_origin_forbidden', entry.path, requestId, null);
      return errorResponse(403, 'origin_forbidden', '조직 API 는 브라우저 요청을 받지 않는다(서버·CI 에서 Bearer 키로).');
    }

    // 인증 — 쿠키는 보지 않는다.
    const bearer = BEARER.exec(headers['authorization'] ?? '')?.[1];
    if (bearer === undefined) {
      logSecurityEvent('org_key_rejected', entry.path, requestId, null);
      return unauthenticated('Authorization: Bearer <atk_org_...> 가 필요하다.');
    }
    if (bearer.startsWith(AGENT_TOKEN_PREFIX)) {
      logSecurityEvent('org_key_rejected', entry.path, requestId, null);
      return unauthenticated('에이전트 토큰(atk_agent_)은 여기서 무효다 — 조직 API 는 조직 키(atk_org_)만 받는다.');
    }
    const principal = await authenticateOrgKey(deps.pool, bearer);
    if (principal === null) {
      logSecurityEvent('org_key_rejected', entry.path, requestId, null);
      return unauthenticated('조직 키가 유효하지 않다(모양 · 폐기 · 만료).');
    }
    // 조직별 요청 상한(ADR-0010 L5) — 인증 직후, 권한·대상 조회 전. 권한 없는 요청도 센다(인증 조회만큼 비용이 들었다).
    const rate = await countOrgApiRequest(deps.pool, principal.id, principal.organizationId);
    if (!rate.allowed) {
      logSecurityEvent(`org_key_rate_limited_${rate.scope}`, entry.path, requestId, null);
      const limit = rate.scope === 'key' ? '이 조직 키의' : '이 조직의';
      return rateLimited(`${limit} /org-api 요청이 분당 상한을 넘었다 — ${String(rate.retryAfterSeconds)}초 뒤 다시 시도하라.`, rate.retryAfterSeconds);
    }
    if (!principal.capabilities.includes(entry.capability)) {
      logSecurityEvent('org_key_forbidden_capability', entry.path, requestId, null);
      return jsonResponse(403, { error: 'forbidden_capability', detail: `이 작업에는 ${entry.capability} 권한이 필요하다.`, required: entry.capability });
    }
    try {
      await touchOrgKey(deps.pool, principal.id);
    } catch (error) {
      log('warn', 'admin.org_key_touch_failed', { route_id: `org-api:${entry.path}`, trace_id: requestId, error_kind: error instanceof Error ? error.name : typeof error });
    }

    const body = readJsonBody(event, method, headers);
    if (!body.ok) return body.response;
    const query = parseQuery(event.rawQueryString);
    if (!query.ok) return query.response;
    const request: AdminRequest = {
      method,
      path,
      headers,
      query: query.query,
      body: body.body,
      cookies: {},
      sourceIp: clientIpOf(event),
      requestId,
    };
    try {
      return await entry.handler({ deps, request, params, principal });
    } catch (error) {
      if (error instanceof AdminInputError) {
        if (PROBE_CODES.has(error.code)) logSecurityEvent(error.code, entry.path, requestId, null);
        // 쓰기 상한(분당 1분 창 원장) — 늦어도 60초 뒤엔 창이 빈다.
        if (error.status === 429) return rateLimited(error.message, 60, error.code);
        return errorResponse(error.status, error.code, error.message);
      }
      // 고객 도메인 계약 SQLSTATE — 콘솔 라우터와 같은 번역(500 없음).
      const domain = domainSqlStateRejection(error);
      if (domain !== null) return domain.status === 429 ? rateLimited(domain.message, 60, domain.code) : errorResponse(domain.status, domain.code, domain.message);
      if (sqlStateOf(error) === '23505') return errorResponse(409, 'conflict', '이미 있는 값이다(예: 주소가 이미 쓰이고 있다).');
      throw error;
    }
  } catch (error) {
    if (error instanceof OrgApiPoolBusyError) {
      log('warn', 'admin.org_api_pool_busy', { route_id: 'org-api', trace_id: requestId });
      const response = errorResponse(503, 'database_busy', '지금 요청이 몰렸다 — 잠시 뒤 다시 시도하라.');
      return { ...response, headers: { ...response.headers, 'retry-after': '1' } };
    }
    log('error', 'admin.org_api_unhandled', {
      route_id: 'org-api',
      trace_id: requestId,
      error_kind: error instanceof Error ? error.name : typeof error,
      detail: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(500, 'internal_error', `요청을 처리하지 못했다. 요청 id: ${requestId}`);
  }
}
