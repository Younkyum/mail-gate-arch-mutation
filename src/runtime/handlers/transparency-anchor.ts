/**
 * EventBridge Scheduler → 투명성 로그 **외부 앵커**(ADR-0008 Phase B, US-010). 이벤트 `{"task": "anchor"}`(매시, 예약은 코드가 하루 1회).
 *
 * **전용 Lambda `atmark-transparency-anchor` · 전용 IAM 역할(atmark-runtime-transparency-anchor — 앵커 키 `kms:Sign` 하나 · `log/anchors/*`
 * PutObject 하나) · DB 롤 `atmark_tlog_anchor`.** OTS 캘린더·Rekor 응답(외부 입력)을 파싱하는 함수라 체크포인트 키·`atmark_tlog` 비밀을
 * 갖지 않는다(M5 해소 — 2026-09-24 리드 결정 ①: 예전에는 로그 함수와 한 역할이었다). SES 권한 0. 예약 동시성 1 · 풀은 호출마다 열고
 * 닫는다(연결 예산 1). 입력의 task 가 `anchor` 가 아니면 던진다.
 */

import { runTransparencyAnchor, TRANSPARENCY_ANCHOR_ROUTE_ID } from '../../workers/transparency-anchor';
import type { LambdaContext } from '../lambda';
import { composeTransparencyAnchor, createTransparencyTaskHandler, lambdaPlatform, type TransparencyPlatform } from '../transparency-composition';

export function createTransparencyAnchorHandler(platformOf: (context: LambdaContext) => TransparencyPlatform) {
  return createTransparencyTaskHandler({
    task: 'anchor',
    routeId: TRANSPARENCY_ANCHOR_ROUTE_ID,
    compose: composeTransparencyAnchor,
    run: runTransparencyAnchor,
    platformOf,
  });
}

export const handler = createTransparencyAnchorHandler(lambdaPlatform);
