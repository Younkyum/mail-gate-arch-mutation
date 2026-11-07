/**
 * `workers/transparency-logger` — 투명성 로그 틱(ADR-0008 Phase A): outbox → 잎 · 매시 에폭 마감(KMS Ed25519 체크포인트) · 공개 로그 게시.
 *
 * Lambda `atmark-transparency-log`(`runtime/handlers/transparency-log.ts` — 5분 틱 · 예약 동시성 1)에서만 돈다. 역할
 * `atmark-runtime-transparency-log`(체크포인트 키 kms:Sign · 로그 버킷 PutObject, **SES 0**), DB 롤 `atmark_tlog`.
 * **메일을 보내지 않는다** — `NON_SENDING_ENTRYPOINTS`. 규칙은 `src/tlog/**` 에 있다.
 */

import { runTransparencyLoggerTick, type TransparencyLoggerDependencies } from '../tlog/logger-tick';

export const TRANSPARENCY_LOGGER_ROUTE_ID = 'transparency_logger';

export type TransparencyLoggerWorkerDependencies = TransparencyLoggerDependencies;

export function runTransparencyLogger(deps: TransparencyLoggerWorkerDependencies): Promise<Readonly<Record<string, number>>> {
  return runTransparencyLoggerTick(deps);
}
