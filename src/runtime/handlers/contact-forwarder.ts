/**
 * EventBridge Scheduler(1분) → `workers/contact-forwarder`. `support@atmark.ai` 문의 전달 outbox 배출(시스템 메일 범주, US-009 ·
 * ADR-0009).
 *
 * 발송 역할(`atmark-runtime-sender`)을 api 등과 **공유한다** — SES 발송 주체는 늘지 않는다(Layer E `mustEqual: 2`). 대신 이 함수만의
 * 것 둘을 IAM 이 **함수 단위**(`lambda:SourceFunctionArn`)로 묶는다: 전달 주소 비밀 읽기 · `contact/forward/*` 문서 읽기. 그리고
 * `support@atmark.ai` 발신은 이 함수 밖에서 명시 Deny 다(`compute-stack.ts`).
 */

import { CONTACT_FORWARD_NOTIFY_ROUTE_ID } from '../../notify/contact-forwarder';
import { runContactForwarder, type ContactForwarderWorkerDependencies } from '../../workers/contact-forwarder';
import { composeContactForwarder } from '../composition';
import { memoize, platformOf, scheduledHandler, type Compose, type LambdaContext } from '../lambda';

export function createContactForwarderHandler(compose: Compose<ContactForwarderWorkerDependencies>) {
  return scheduledHandler(CONTACT_FORWARD_NOTIFY_ROUTE_ID, compose, (deps) => runContactForwarder(deps));
}

export const handler = createContactForwarderHandler(
  memoize((context: LambdaContext) => composeContactForwarder(platformOf(context))),
);
