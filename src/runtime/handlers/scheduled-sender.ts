/** EventBridge Scheduler(1분) → `workers/scheduled-sender`. 예약 발송 — **발송 시점에** 관문을 지난다. */

import {
  runScheduledSenderTick,
  SCHEDULED_SEND_ROUTE_ID,
  type ScheduledSenderTickDependencies,
} from '../../workers/scheduled-sender';
import { composeScheduledSender } from '../composition';
import { countBy, memoize, platformOf, scheduledHandler, type Compose, type LambdaContext } from '../lambda';

export function createScheduledSenderHandler(compose: Compose<ScheduledSenderTickDependencies>) {
  return scheduledHandler(SCHEDULED_SEND_ROUTE_ID, compose, async (deps) =>
    countBy(await runScheduledSenderTick(deps), (result) => result.outcome),
  );
}

export const handler = createScheduledSenderHandler(
  memoize((context: LambdaContext) => composeScheduledSender(platformOf(context))),
);
