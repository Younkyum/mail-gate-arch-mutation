/** EventBridge Scheduler(1분) → `workers/webhook-dispatcher`. 웹훅 outbox 배출(메일이 아니다). */

import {
  runWebhookDispatcher,
  WEBHOOK_DISPATCHER_ROUTE_ID,
  type WebhookDispatcherDependencies,
} from '../../workers/webhook-dispatcher';
import { composeWebhookDispatcher } from '../composition';
import { countBy, memoize, platformOf, scheduledHandler, type Compose, type LambdaContext } from '../lambda';

export function createWebhookDispatcherHandler(compose: Compose<WebhookDispatcherDependencies>) {
  return scheduledHandler(WEBHOOK_DISPATCHER_ROUTE_ID, compose, async (deps) =>
    countBy(await runWebhookDispatcher(deps), (report) => report.outcome),
  );
}

export const handler = createWebhookDispatcherHandler(
  memoize((context: LambdaContext) => composeWebhookDispatcher(platformOf(context))),
);
