/**
 * EventBridge Scheduler(1분) → `workers/passport-signer`. passport 게시 outbox · 재서명(계획 §4B.1b).
 *
 * **전용 Lambda · 전용 IAM 역할(atmark-runtime-passport-signer) · 전용 DB 롤(atmark_passport_signer)** — 에이전트 개인키를 복호할 수
 * 있는 런타임 주체는 이것 하나다(§3.5 AC-e2). HTTP 입구가 없다(스케줄러만 부른다) — 외부 입력이 닿는 면이 0 이다. SES 권한 0.
 */

import { memoize, scheduledHandler, type Compose } from '../lambda';
import { composePassportSigner } from '../passport-signer-composition';
import { PASSPORT_SIGNER_ROUTE_ID, runPassportSigner, type PassportSignerWorkerDependencies } from '../../workers/passport-signer';

export function createPassportSignerHandler(compose: Compose<PassportSignerWorkerDependencies>) {
  return scheduledHandler(PASSPORT_SIGNER_ROUTE_ID, compose, runPassportSigner);
}

export const handler = createPassportSignerHandler(
  memoize((context) => composePassportSigner({ env: process.env, invokedFunctionArn: context.invokedFunctionArn })),
);
