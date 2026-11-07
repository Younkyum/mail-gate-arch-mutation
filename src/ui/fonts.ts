/**
 * src/ui/fonts.ts — 자체 호스팅 웹폰트 Pretendard Variable(SIL OFL 1.1, orioncactus — 전문은 `pretendard-LICENSE.txt`)의 **바이트 쪽**:
 * 생성 파일 `pretendard-data.ts`(base64 본문)를 경로로 찾아 준다. 폰트를 내는 곳은 홈(`atmark.ai`) λ 하나다(배포 전 리뷰 M4 — 콘솔은
 * 홈 출처에서 받는다). `@font-face` 문자열·경로 규칙은 바이트 없는 `font-faces.ts` 에 있고 여기서 다시 내보낸다(홈 코드의 기존 import 용).
 *   - `fontAsset(path)` — 홈 핸들러(`site/http.ts`)와 로컬 미리보기가 쓰는 조회 하나. 표에 없는 경로는 `undefined`(→ 404). 세션·DB·환경을 보지 않는다.
 */

import { FONT_ROUTE_PREFIX, fontPath } from './font-faces';
import { PRETENDARD_CHUNKS } from './pretendard-data';

export { FONT_FACE_CSS, FONT_ROUTE_PREFIX, fontFaceCss, fontPath } from './font-faces';

export const FONT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const FONT_CONTENT_TYPE = 'font/woff2';

interface FontBytes {
  readonly base64: string;
  readonly bytes: number;
}

const BY_PATH: ReadonlyMap<string, FontBytes> = new Map<string, FontBytes>([
  ...PRETENDARD_CHUNKS.map((chunk): [string, FontBytes] => [fontPath(chunk), chunk]),
]);

/** 경로 → 폰트 본문(base64 — λ 응답에 그대로 싣는다). 표에 없으면 `undefined`. */
export function fontAsset(path: string): { readonly base64: string; readonly bytes: number } | undefined {
  const chunk = BY_PATH.get(path);
  return chunk === undefined ? undefined : { base64: chunk.base64, bytes: chunk.bytes };
}

/** 폰트 경로 아래인가(표에 있든 없든 — 없으면 핸들러가 404). */
export function isFontPath(path: string): boolean {
  return path.startsWith(FONT_ROUTE_PREFIX);
}
