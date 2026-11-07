/**
 * `workers/passport-signer` — **passport 게시 outbox 를 비우고 재서명한다** (계획 §4B.1b · §4B.2 PP-B, 계약 §3).
 *
 * 전용 Lambda `atmark-passport-signer`(`runtime/handlers/passport-signer.ts`, 1분 틱 · 예약 동시성 1)에서만 돈다 — 역할
 * `atmark-runtime-passport-signer`(개인키 복호 + identity 버킷 PutObject + CloudFront 무효화, **SES 0**), DB 롤 `atmark_passport_signer`.
 * **메일을 보내지 않는다** — `NON_SENDING_ENTRYPOINTS`. 관문·알림 모듈을 import 하지 않는다(Layer C).
 *
 * 이 파일은 틱 하나를 부를 뿐이다. 무엇을 서명할지는 DB(outbox·현재 버전)가 정하고, 그 규칙은 `src/passport/publisher.ts` 에 있다.
 */

import { runPassportPublisherTick, type PassportPublisherDependencies, type TickCounts } from '../passport/publisher';

export const PASSPORT_SIGNER_ROUTE_ID = 'passport_signer';

export type PassportSignerWorkerDependencies = PassportPublisherDependencies;

export function runPassportSigner(deps: PassportSignerWorkerDependencies): Promise<TickCounts> {
  return runPassportPublisherTick(deps);
}
