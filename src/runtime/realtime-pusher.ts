/**
 * src/runtime/realtime-pusher.ts — 만드는 λ(api · inbound · admin · AI 감시 결과)의 **실시간 힌트 푸시 조립**(묶음 E). 조립 루트(`composition.ts` ·
 * `admin-composition.ts`) 둘이 같은 함수를 부른다 — 이 파일은 그 둘 어느 쪽도 import 하지 않는다(admin 폐포에 api 조립이 끼지 않게 — arch `admin-separation`).
 */

import { log } from '../observability/logger';
import { REALTIME_ENV } from '../realtime/contract';
import { createRealtimePusher, type RealtimePusher, type RealtimeTargetStore, type RealtimeTransport } from '../realtime/push';
import { createApiGatewayRealtimeTransport } from './realtime-transport';

const CALLBACK_URL = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9_$.-]+)?$/;

/**
 * 실시간 힌트 푸시(묶음 E). 콜백 URL(`ATMARK_REALTIME_CALLBACK_URL` — CDK 가 실시간 API 스테이지의 `@connections` 엔드포인트를 넣는다)이 없으면 `undefined`
 * (= 밀지 않는다 · DB 도 부르지 않는다). 대상 포트는 그 λ 의 DB 롤이 EXECUTE 를 가진 함수만 담는다(`realtime-connection-store.ts`).
 */
export function realtimePusherOf(
  env: NodeJS.ProcessEnv,
  region: string,
  targets: RealtimeTargetStore,
  routeId: string,
  transport?: RealtimeTransport,
): RealtimePusher | undefined {
  const callbackUrl = (env[REALTIME_ENV.callbackUrl] ?? '').trim();
  if (callbackUrl === '') return undefined;
  if (!CALLBACK_URL.test(callbackUrl)) {
    log('warn', 'runtime.feature_flag_invalid', { detail: REALTIME_ENV.callbackUrl, reason: 'malformed', outcome: 'off' });
    return undefined;
  }
  return createRealtimePusher({ targets, transport: transport ?? createApiGatewayRealtimeTransport(region, callbackUrl), routeId });
}

