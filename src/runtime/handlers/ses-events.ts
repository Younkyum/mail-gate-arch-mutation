/**
 * `atmark-ses-events` 큐(SQS) → `workers/ses-event-consumer`. 부분 배치 실패: 결말 `failed`(DB 기록 실패)만 재전달한다.
 * 배치 끝의 소비자 건강 판정(`reportHealth`)은 레코드 결말과 무관하게 한 번 돈다.
 */

import { composeSesEventConsumer } from '../composition';
import {
  beginInvocation,
  consumeSqsBatch,
  memoize,
  platformOf,
  type Compose,
  type LambdaContext,
  type SqsBatchResponse,
  type SqsEvent,
} from '../lambda';
import {
  consumeSesEvent,
  reportHealth,
  SES_EVENT_CONSUMER_ROUTE_ID,
  type SesEventConsumerDependencies,
} from '../../workers/ses-event-consumer';

export function createSesEventsHandler(compose: Compose<SesEventConsumerDependencies>) {
  return async (event: SqsEvent, context: LambdaContext): Promise<SqsBatchResponse> => {
    beginInvocation(context);
    const { deps } = await compose(context);
    const response = await consumeSqsBatch(
      SES_EVENT_CONSUMER_ROUTE_ID,
      event,
      (record) => consumeSesEvent(deps, { receiptId: record.messageId, body: record.body }),
      (outcome) => outcome === 'failed',
    );
    // 정지 감지(ADR-0004)는 배치마다 한 번. 던지지 않는다 — 조회 실패는 `idle` + error 로그다.
    await reportHealth(deps);
    return response;
  };
}

export const handler = createSesEventsHandler(
  memoize((context: LambdaContext) => composeSesEventConsumer(platformOf(context))),
);
