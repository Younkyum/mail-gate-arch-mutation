/**
 * src/runtime/realtime-transport.ts — **API Gateway Management API SDK 를 import 하는 유일한 파일**(묶음 E — 실시간 WebSocket 의 `PostToConnection`).
 *
 * 격리 규칙은 `sqs.ts` · `lambda-invoke.ts` 와 같다: AWS SDK 클라이언트 하나당 파일 하나 · 네트워크 송출 허용 목록(`test/arch/network-egress.arch.test.ts`)에
 * 이름으로 오른다 · `.dependency-cruiser.cjs` `no-apigw-management-sdk-outside-runtime-realtime` 가 한 번 더 막는다. 공개 면은 **프레임 보내기 하나**다
 * (`GetConnection`·`DeleteConnection` 은 쓰지 않는다 — IAM 도 `POST @connections/*` 만 준다). 엔드포인트(스테이지 콜백 URL)는 조립 루트가 묶는다.
 *
 * 시간: 요청 타임아웃 · 시도 1회(재시도 없음 — 최대 한 번). 호출자(`realtime/push.ts`)가 1초 상한과 AbortSignal 을 함께 건다.
 */

import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

import type { RealtimeTransport } from '../realtime/push';

export const REALTIME_POST_REQUEST_TIMEOUT_MS = 800;

/** 실제 API Gateway(엔드포인트 하나에 묶음). **부르는 순간 자격증명이 필요하다**(만들기만 해서는 네트워크를 타지 않는다). */
export function createApiGatewayRealtimeTransport(region: string, callbackUrl: string): RealtimeTransport {
  const client = new ApiGatewayManagementApiClient({
    region,
    endpoint: callbackUrl,
    maxAttempts: 1,
    requestHandler: { requestTimeout: REALTIME_POST_REQUEST_TIMEOUT_MS },
  });
  return {
    async post(connectionId, frame, signal) {
      try {
        await client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: new TextEncoder().encode(frame) }), { abortSignal: signal });
        return 'sent';
      } catch (error) {
        if (error instanceof GoneException || (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode === 410) return 'gone';
        throw error;
      }
    },
  };
}
