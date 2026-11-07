/**
 * `atmark-inbound` 큐(SQS) → `workers/inbound-consumer`. 부분 배치 실패: 결말 `failed`(S3·DB 일시 장애)만 재전달한다.
 * `stored`·`duplicate`·`ignored`·`rejected`·`unparsable` 은 재전달해도 결과가 같다 — 지운다.
 */

import { composeInboundConsumer } from '../composition';
import { memoize, platformOf, sqsHandler, type Compose, type LambdaContext } from '../lambda';
import {
  consumeInboundMail,
  INBOUND_CONSUMER_ROUTE_ID,
  type InboundConsumerDependencies,
} from '../../workers/inbound-consumer';

export function createInboundHandler(compose: Compose<InboundConsumerDependencies>) {
  return sqsHandler(
    INBOUND_CONSUMER_ROUTE_ID,
    compose,
    (deps, record) => consumeInboundMail(deps, { receiptId: record.messageId, body: record.body }),
    (outcome) => outcome === 'failed',
  );
}

export const handler = createInboundHandler(
  memoize((context: LambdaContext) => composeInboundConsumer(platformOf(context))),
);
