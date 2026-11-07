/**
 * EventBridge Scheduler → 투명성 로그 **서열·에폭·게시**(ADR-0008, US-010). 이벤트 `{"task": "log"}`(5분).
 *
 * **전용 Lambda `atmark-transparency-log` · 전용 IAM 역할(atmark-runtime-transparency-log — 체크포인트 키 `kms:Sign`) · DB 롤 `atmark_tlog`**
 * — HTTP 입구가 없다(스케줄러만 부른다). SES 권한 0 · 외부 HTTP 0. 앵커는 다른 함수(`transparency-anchor.ts` — M5, 2026-09-24).
 * 예약 동시성 1 이라 틱이 겹치지 않는다. 풀은 호출마다 열고 닫는다(연결 예산 1 — `transparency-composition.ts`). 입력의 task 가 `log`
 * 가 아니면 던진다 — 배선 오타가 조용히 다른 일을 하지 않게.
 */

import { runTransparencyLogger, TRANSPARENCY_LOGGER_ROUTE_ID } from '../../workers/transparency-logger';
import type { LambdaContext } from '../lambda';
import { composeTransparencyLog, createTransparencyTaskHandler, lambdaPlatform, type TransparencyPlatform } from '../transparency-composition';

export function createTransparencyLogHandler(platformOf: (context: LambdaContext) => TransparencyPlatform) {
  return createTransparencyTaskHandler({
    task: 'log',
    routeId: TRANSPARENCY_LOGGER_ROUTE_ID,
    compose: composeTransparencyLog,
    run: runTransparencyLogger,
    platformOf,
  });
}

export const handler = createTransparencyLogHandler(lambdaPlatform);
