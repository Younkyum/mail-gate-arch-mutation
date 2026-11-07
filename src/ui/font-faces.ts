/**
 * src/ui/font-faces.ts — Pretendard Variable 의 `@font-face` 문자열과 폰트 경로. **폰트 바이트를 import 하지 않는다** — 메타 표
 * `pretendard-faces.ts`(생성 파일: 파일 · 내용 해시 · unicode-range)만 쓴다. 그래서 콘솔 번들은 이 모듈만 import 해 4MB 남짓한
 * `pretendard-data.ts`(base64 본문)를 싣지 않는다(배포 전 리뷰 M4 — 폰트는 홈 λ 하나만 싣고, 콘솔은 홈 출처에서 받는다).
 *
 *   - `FONT_FACE_CSS` — 청크마다 `@font-face` 하나(`unicode-range` 로 나뉜 동적 서브셋). 브라우저는 페이지에 실제로 나온 글자의 청크만 받는다.
 *     각 페이지 빌더가 **하나뿐인 인라인 `<style>`** 맨 앞에 이 문자열을 붙인다(해시는 빌더가 그 결과에서 잰다). `<link rel=preload>` 는 쓰지 않는다.
 *   - `fontFaceCss(origin)` — 같은 규칙을 다른 출처의 절대 URL 로. 콘솔은 `fontFaceCss(SITE_ORIGIN)`(홈 `/_fonts/…` 가 콘솔 출처 하나에
 *     `access-control-allow-origin` 을 준다 — `src/site/http.ts`).
 *   - 경로 `/_fonts/<내용 해시>/<파일>` — 해시가 URL 에 있으므로 응답은 1 년 immutable. 폰트가 바뀌면 URL 이 바뀐다.
 * ASCII 만(CSS 해시가 인코딩에 흔들리지 않게 — `unicode-range` 도 `U+…` ASCII 다).
 */

import { PRETENDARD_FACES, type PretendardFace } from './pretendard-faces';

export const FONT_ROUTE_PREFIX = '/_fonts/';

/** 청크의 URL 경로. */
export function fontPath(chunk: Pick<PretendardFace, 'hash' | 'file'>): string {
  return `${FONT_ROUTE_PREFIX}${chunk.hash}/${chunk.file}`;
}

/** `fontFaceCss` 가 받는 출처 — 빈 문자열(같은 출처) 또는 `https://호스트`(끝 `/`·경로·포트 없음) 하나, 로컬 미리보기의 `http://127.0.0.1:<포트>`. */
const FONT_ORIGIN_RE = /^(|https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}|http:\/\/127\.0\.0\.1:\d{2,5})$/;

/**
 * `@font-face` 들(줄 하나에 규칙 하나). `origin` 이 비면 같은 출처 경로(`/_fonts/…`), 아니면 그 출처의 절대 URL(`https://atmark.ai/_fonts/…`).
 * 교차 출처면 브라우저가 자격 없는 CORS 모드로 요청하므로, 받는 쪽이 요청 페이지 출처에 `access-control-allow-origin` 을 줘야 쓰인다.
 * `http://127.0.0.1:<포트>` 는 로컬 미리보기(`scripts/ui/preview.ts`) 전용 — 배포 코드가 넘기지 않는다.
 */
export function fontFaceCss(origin: string): string {
  if (!FONT_ORIGIN_RE.test(origin)) throw new Error(`fontFaceCss: 출처가 아니다: ${origin}`);
  return PRETENDARD_FACES.map(
    (face) =>
      '@font-face{font-family:"Pretendard Variable";font-display:swap;font-weight:45 920;' +
      `src:url(${origin}${fontPath(face)}) format("woff2-variations");unicode-range:${face.unicodeRange}}`,
  ).join('\n');
}

/** 같은 출처 판 — 홈(`atmark.ai`)의 모든 페이지가 싣는다. */
export const FONT_FACE_CSS = fontFaceCss('');
