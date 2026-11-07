/**
 * `GET /v1/identity/{address}` — **무인증 공개 신원 조회** (계획 §4B.3 · PP-C, 계약 §3).
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 조회 전용이고 관문·토큰 저장소를 import 하지 않는다 — 인증이 없다는 것이 설계다
 * (검증자는 Atmark 고객이 아니다). 대신 응답에 들어갈 수 있는 것을 **직렬화기 하나**(`src/passport/public-view.ts`
 * `toPublicIdentityView`)가 정한다: 이 파일은 그 함수의 반환값과 고정된 404 본문 말고는 본문을 만들지 않는다
 * (`test/arch/passport-public-surface.arch.test.ts`).
 *
 * 헤더(§4B.3 "엔드포인트 하드닝"):
 *   - `Access-Control-Allow-Origin: *` — 브라우저의 검증기가 부를 수 있게.
 *   - `Cache-Control: public, max-age=300` — **이 줄이 필드 allowlist·sentinel 스캔을 필수 게이트로 만드는 이유다**(한 번 나간 값은 캐시에서
 *     회수할 수 없다). 서명 Lambda 가 상태 전이 때 CloudFront(`id.atmark.ai/v1/identity/*`)를 무효화한다.
 *   - 404 도 **같은 헤더·같은 본문**이다 — 없는 주소 · draft(게시 전) · 형식이 틀린 주소를 응답으로 구별할 수 없다(존재 누설 없음).
 *
 * 레이트 리밋: 오리진 보호용 라우트 스로틀은 HTTP API 스테이지가 건다(`compute-stack.ts` `API_ROUTE_THROTTLES`). **열거 방어는 목표가
 * 아니다**(§4B.3 r3 정정) — 긁어 가도 얻는 것이 공개 전제로 설계된 필드뿐이게 하는 것이 방어다.
 */

import type { ApiResponse } from '../http';
import type { PublicIdentityDirectory } from '../../passport/public-directory';
import { PUBLIC_IDENTITY_NOT_FOUND, toPublicIdentityView } from '../../passport/public-view';

export interface IdentityRouteDependencies {
  readonly directory: PublicIdentityDirectory;
}

/** 공개 신원 응답의 헤더 — 200·404 공통. 라우터가 JSON 기본 헤더 위에 덮는다. */
export const IDENTITY_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'public, max-age=300',
  'access-control-allow-origin': '*',
};

export async function handleGetIdentity(
  deps: IdentityRouteDependencies,
  params: { readonly address: string },
): Promise<ApiResponse> {
  const source = await deps.directory.findByAddress(params.address);
  if (source === null) return { status: 404, body: PUBLIC_IDENTITY_NOT_FOUND };
  return { status: 200, body: toPublicIdentityView(source) };
}
