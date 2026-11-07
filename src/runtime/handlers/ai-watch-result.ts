/**
 * `atmark-ai-watch-result` 큐(SQS) → `workers/ai-watch-result`(ADR-0017 초안 · 경고 전용). 부분 배치 실패: 결말 `failed`(DB 일시 장애)만
 * 재전달한다(maxReceive 3 → DLQ). `recorded`·`late`·`ignored`·`heartbeat`·`rejected` 는 재전달해도 같다 — 지운다.
 * 롤은 `atmark_ai_watch`(정의 함수 둘 EXECUTE 만). SES 0 · S3 0.
 */

import { composeAiWatchResult } from '../composition';
import { memoize, platformOf, sqsHandler, type Compose, type LambdaContext } from '../lambda';
import { AI_WATCH_RESULT_ROUTE_ID, consumeAiWatchResult, type AiWatchResultDependencies } from '../../workers/ai-watch-result';

export function createAiWatchResultHandler(compose: Compose<AiWatchResultDependencies>) {
  return sqsHandler(
    AI_WATCH_RESULT_ROUTE_ID,
    compose,
    (deps, record) => consumeAiWatchResult(deps, { receiptId: record.messageId, body: record.body }),
    (outcome) => outcome === 'failed',
  );
}

export const handler = createAiWatchResultHandler(
  memoize((context: LambdaContext) => composeAiWatchResult(platformOf(context))),
);
