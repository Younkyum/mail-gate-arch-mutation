/**
 * `workers/transparency-anchor` — 체크포인트 외부 앵커(ADR-0008 Phase B): OpenTimestamps 캘린더 · Sigstore Rekor v2 · 대기 증명 업그레이드.
 *
 * Lambda `atmark-transparency-anchor`(`runtime/handlers/transparency-anchor.ts` — 매시 틱, 예약은 하루 1회) · 역할
 * `atmark-runtime-transparency-anchor`(앵커 키 kms:Sign 하나 — 체크포인트 키 없음, M5) · DB 롤 `atmark_tlog_anchor`. 외부 HTTP 는
 * `src/tlog/anchor-http.ts` 하나(허용 호스트 고정). **메일을 보내지 않는다** — `NON_SENDING_ENTRYPOINTS`.
 */

import { runAnchorTick, type AnchorDependencies } from '../tlog/anchor';

export const TRANSPARENCY_ANCHOR_ROUTE_ID = 'transparency_anchor';

export type TransparencyAnchorWorkerDependencies = AnchorDependencies;

export async function runTransparencyAnchor(deps: TransparencyAnchorWorkerDependencies): Promise<Readonly<Record<string, number>>> {
  return { ...(await runAnchorTick(deps)) };
}
