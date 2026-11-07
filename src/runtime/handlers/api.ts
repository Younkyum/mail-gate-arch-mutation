/**
 * API Gateway HTTP API(payload v2) → `runtime/router.ts`. 라우트 함수 전부가 이 함수 하나로 들어온다. 예외 하나: admin λ 의 **내부 이벤트**
 * (콘솔 웹훅 시크릿 발급 — `runtime/internal-api-event.ts`)는 모양을 엄격하게 갈라 라우터 앞에서 처리한다.
 *
 * 조립이 실패하면(비밀·설정) **503** 과 요청 id 만 돌려준다 — 원인은 로그로만 간다. 라우트가 던지면 라우터가
 * 500 `internal_error` 로 바꾼다. 어느 쪽도 스택·내부 메시지를 응답에 싣지 않는다.
 */

import { log } from '../../observability/logger';
import { composeApi } from '../composition';
import { parseInternalApiEvent, type InternalApiEvent, type InternalApiResult } from '../internal-api-event';
import { handleInternalApiEvent } from '../internal-api-handler';
import { beginInvocation, memoize, platformOf, type Compose, type LambdaContext } from '../lambda';
import {
  routeHttpApiEvent,
  unavailableResult,
  type ApiDependencies,
  type HttpApiEvent,
  type HttpApiResult,
} from '../router';

/** HTTP 이벤트는 HTTP 결과, 내부 이벤트는 내부 결과 — 호출부 타입이 섞이지 않게 겹쳐 쓴다. */
export interface ApiHandler {
  (event: HttpApiEvent, context: LambdaContext): Promise<HttpApiResult>;
  (event: InternalApiEvent, context: LambdaContext): Promise<InternalApiResult>;
}

export function createApiHandler(compose: Compose<ApiDependencies>): ApiHandler {
  const handle = async (event: HttpApiEvent | InternalApiEvent, context: LambdaContext): Promise<HttpApiResult | InternalApiResult> => {
    beginInvocation(context);
    // 내부 이벤트(콘솔 웹훅 시크릿 — 보안 M1)는 정확한 키 집합의 평범한 객체뿐이다. API Gateway 이벤트는 그 모양일 수 없다(`internal-api-event.ts`).
    const internal = parseInternalApiEvent(event);
    if (internal !== null) {
      try {
        const { deps } = await compose(context);
        return await handleInternalApiEvent(deps.webhookEndpoints, internal);
      } catch (error) {
        log('error', 'runtime.compose_failed', { route_id: 'api:internal', error_kind: error instanceof Error ? error.name : typeof error });
        return { ok: false, error: 'unavailable' };
      }
    }
    const http = event as HttpApiEvent;
    let deps: ApiDependencies;
    try {
      ({ deps } = await compose(context));
    } catch (error) {
      log('error', 'runtime.compose_failed', {
        route_id: 'api',
        trace_id: http.requestContext.requestId,
        error_kind: error instanceof Error ? error.name : typeof error,
        detail: error instanceof Error ? error.message : String(error),
      });
      return unavailableResult(http.requestContext.requestId);
    }
    return routeHttpApiEvent(deps, http);
  };
  return handle as ApiHandler;
}

export const handler = createApiHandler(memoize((context: LambdaContext) => composeApi(platformOf(context))));
