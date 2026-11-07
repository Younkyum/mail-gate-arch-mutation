/** EventBridge Scheduler(1분) → `workers/approval-release` 의 주기 스윕. 승인된 요청을 관문에 다시 세워 **실제로 보낸다.** */

import { composeApprovalRelease } from '../composition';
import { countBy, memoize, platformOf, scheduledHandler, type Compose, type LambdaContext } from '../lambda';
import {
  APPROVAL_RELEASE_ROUTE_ID,
  runApprovalReleaseSweep,
  type ApprovalReleaseDependencies,
} from '../../workers/approval-release';

export function createApprovalReleaseHandler(compose: Compose<ApprovalReleaseDependencies>) {
  return scheduledHandler(APPROVAL_RELEASE_ROUTE_ID, compose, async (deps) =>
    countBy(await runApprovalReleaseSweep(deps), (outcome) => outcome.kind),
  );
}

export const handler = createApprovalReleaseHandler(
  memoize((context: LambdaContext) => composeApprovalRelease(platformOf(context))),
);
