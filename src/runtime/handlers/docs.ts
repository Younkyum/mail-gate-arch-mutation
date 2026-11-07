/**
 * API Gateway HTTP API `atmark-docs`(payload v2, `docs.atmark.ai`) → `src/docs/http.ts`.
 *
 * **별도 Lambda · 별도 IAM 역할(자기 로그만) · VPC 밖 · DB 없음 · 비밀 없음 · 환경 변수 없음.** 이 번들의 import 폐포는 `src/docs/**` ·
 * `src/ui/**`(폰트·토큰·파비콘 값 파일) · `src/billing/plans.ts`(import 없는 값 파일 — 요금제 한도 표)뿐이다(`test/unit/docs/docs-bundle.test.ts`).
 * 홈(`atmark-site`)과 공유하는 것이 없다 — 문서 배포가 홈·결제에 닿지 않는다.
 */

import { handleDocsRequest, type DocsHttpEvent, type DocsHttpResult } from '../../docs/http';

export const handler = async (event: DocsHttpEvent): Promise<DocsHttpResult> => handleDocsRequest(event);
