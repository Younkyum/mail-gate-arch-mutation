/**
 * API Gateway WebSocket(`atmark-realtime` — `wss://realtime.atmark.ai`, 묶음 E) → `realtime/gateway.ts`. 세 라우트(`$connect` · `$disconnect` · `$default`)가
 * 전부 이 함수로 들어온다. 앱 롤 · 풀 1 · 예약 1(연결 예산 — `REALTIME_RESERVED_CONCURRENCY`). SES 0 · S3 0 · `@connections` 권한 0(보내는 것은 만드는 λ).
 *
 * 조립이 실패하면 `$connect` 는 **503**(핸드셰이크가 열리지 않는다 — 클라이언트는 백오프로 다시 온다), 나머지는 200(API Gateway 는 그 결과를 쓰지 않는다).
 * 라우트가 던지면 500 — 스택 · 메시지를 응답에 싣지 않는다.
 */

import { log } from '../../observability/logger';
import { handleRealtimeEvent, REALTIME_ROUTE_ID, type RealtimeGatewayDependencies, type WebSocketEvent, type WebSocketResult } from '../../realtime/gateway';
import { composeRealtime } from '../composition';
import { beginInvocation, memoize, platformOf, type Compose, type LambdaContext } from '../lambda';

export function createRealtimeHandler(compose: Compose<RealtimeGatewayDependencies>) {
  return async (event: WebSocketEvent, context: LambdaContext): Promise<WebSocketResult> => {
    beginInvocation(context);
    const connecting = event.requestContext.routeKey === '$connect';
    let deps: RealtimeGatewayDependencies;
    try {
      ({ deps } = await compose(context));
    } catch (error) {
      log('error', 'runtime.compose_failed', {
        route_id: REALTIME_ROUTE_ID,
        trace_id: event.requestContext.requestId ?? null,
        error_kind: error instanceof Error ? error.name : typeof error,
      });
      return { statusCode: connecting ? 503 : 200 };
    }
    try {
      return await handleRealtimeEvent(deps, event);
    } catch (error) {
      log('error', 'realtime.failed', {
        route_id: REALTIME_ROUTE_ID,
        trace_id: event.requestContext.requestId ?? null,
        reason: event.requestContext.routeKey,
        error_kind: error instanceof Error ? error.name : typeof error,
      });
      return { statusCode: 500 };
    }
  };
}

export const handler = createRealtimeHandler(memoize((context: LambdaContext) => composeRealtime(platformOf(context))));
