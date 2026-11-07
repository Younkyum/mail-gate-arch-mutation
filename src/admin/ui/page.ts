/**
 * src/admin/ui/page.ts — 관리 화면 여섯 페이지의 공통 껍데기와 CSP.
 *
 * 승인 페이지(`src/approval/magic-link.ts`)와 같은 규율이다:
 *   - **동적 값이 하나도 없는 정적 HTML.** 서버는 이 문자열에 아무것도 끼워 넣지 않는다. 데이터는 스크립트가
 *     같은 오리진 API 로 받아 `textContent` 로만 그린다(`innerHTML` 없음 — 테스트가 소스에서 단언한다).
 *   - CSP 는 `default-src 'none'` 에서 필요한 것만 연다. 인라인은 머리의 테마 부트(`THEME_BOOT_JS`) **하나뿐**이고 **해시**로만 허용한다.
 *   - 스타일시트와 페이지 스크립트는 **같은 출처의 불변 자산**이다(`/_assets/<내용 해시>/console.css`·`page.js` — 콘솔 HTML 이
 *     `no-store` 라 매 방문 약 480KB 를 다시 받던 것을 1년 immutable 캐시로 돌린다). 자산은 두 겹으로 묶인다:
 *       ① HTML 의 `integrity="sha384-…"`(SRI) — 본문이 한 바이트라도 다르면 브라우저가 적용·실행하지 않는다.
 *       ② CSP 가 그 자산의 **정확한 URL**(출처 + 전체 경로 — 경로 접두어가 아니다)만 연다. `'self'` 가 아니다.
 *     외부 스크립트를 해시(`'sha384-…'`)만으로 허용하는 CSP3 규칙은 Safari 가 아직 따르지 않고, 외부 스타일시트는 CSP 해시로 허용할
 *     방법이 없다 — 그래서 정확한 URL + SRI 다(세 브라우저 모두 지원). 경로에 내용 해시가 들어 있어 URL 하나가 본문 하나를 뜻한다.
 *     SRI 해시·경로·CSP 는 **실제로 싣는 그 문자열**에서 잰다(`buildPage` 가 같은 변수로 셋 다 만든다).
 *   - 스크립트는 **ASCII 만**이다(`asciiScript`). 한국어 문구는 `\uXXXX` 로 바뀌어 들어간다 — 응답 인코딩이
 *     흔들려도 SRI 해시가 흔들리지 않게.
 *
 * CSP 각 지시어:
 *   · `script-src 'sha256-…' <출처>/_assets/<해시>/page.js` — 인라인 테마 부트 하나(해시)와 그 페이지의 스크립트 자산 하나(정확한 URL).
 *     `style-src <출처>/_assets/<해시>/console.css` — 스타일시트 자산 하나. 인라인 `<style>`·`style=""` 속성·`on*=` 속성은
 *     허용되지 않는다(테스트가 HTML 에 없음을 단언 — 있으면 운영에서 "초록인데 안 먹는" 스타일이 된다).
 *     JS 가 `el.style.width` 로 CSSOM 을 바꾸는 것은 CSP 대상이 아니다(막대그래프가 이것을 쓴다).
 *   · `font-src https://atmark.ai` — 자체 호스팅 Pretendard 는 **사이트 출처**에서만(리뷰 M4 · `src/ui/font-faces.ts`). 외부 CDN·`data:` 없음.
 *   · `connect-src 'self'` — `fetch` 는 같은 오리진(`console.atmark.ai`) `/api/*` 로만. 로그인 토큰·CSRF 가 밖으로 못 나간다.
 *   · `form-action 'none'` — 폼은 전부 스크립트가 가로챈다. 스크립트가 죽어도 폼이 어디로도 제출되지 않는다.
 *   · `frame-ancestors 'none'` — 클릭재킹. `base-uri 'none'` — `<base>` 인젝션으로 상대 경로를 돌리지 못하게.
 *   · `require-trusted-types-for 'script'` + `trusted-types 'none'` — 지원 브라우저에서 `innerHTML` 류 싱크에
 *     문자열을 넣는 순간 예외. 소스에 `innerHTML` 이 없다는 테스트의 **실행 시 짝**이다.
 */

import { createHash } from 'node:crypto';

import { brandLockupSvg } from '../../ui/brand';
import { FAVICON_LINK } from '../../ui/favicon';
import { ADMIN_ORIGIN } from '../http';
import { localize, type Lang } from './i18n';
import { ADMIN_UI_CSS, adminUiCss, CONSOLE_FONT_ORIGIN } from './styles';

/** 백엔드(`src/admin/**`)가 받는 모양 — `{ html, csp }`. 헤더 이름은 `content-security-policy`. */
export interface AdminUiPage {
  readonly html: string;
  readonly csp: string;
}

export function sha256Base64(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

/**
 * 스크립트 소스를 ASCII 로. 비ASCII 는 **문자열 리터럴 안에만** 있어야 한다(한국어 문구) — 거기서는 `\uXXXX` 가
 * 같은 문자로 풀린다. 코드 단위(UTF-16) 기준이라 보충 평면 문자도 서로게이트 쌍 이스케이프로 맞게 풀린다.
 */
export function asciiScript(source: string): string {
  return source.replace(/[^\x00-\x7f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * 테마 부트 스크립트(US-014) — `<head>` 에서 **첫 칠 전에** 저장된 테마를 `<html data-theme>` 에 적는다(깜빡임 없음).
 * 값은 `light`·`dark` 둘만 적고, 없거나 다른 값이면 아무것도 안 한다(= 시스템 설정 — CSS 의 `prefers-color-scheme`).
 * 같은 IIFE 에서 사이드바 접힘(`rail`)도 `<html data-side="rail">` 로 적는다(명세 §4.3 — 펼침이 기본이라 다른 값은 무시).
 * 저장소를 못 읽으면(사생활 모드·차단) 조용히 기본값을 따른다. 설정 화면·사이드바의 전환(`console/script/shell.ts`)이 같은 키를 쓴다.
 * 번역할 문구가 없어 언어와 무관한 한 벌이다 — ASCII 만, 해시는 이 문자열 그대로에서 잰다.
 */
export const THEME_STORAGE_KEY = 'atmark.console.theme';
export const SIDE_STORAGE_KEY = 'atmark.console.side';
export const THEME_BOOT_JS = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);var s=localStorage.getItem('${SIDE_STORAGE_KEY}');if(s==='rail')document.documentElement.setAttribute('data-side','rail');}catch(e){}})();`;

/**
 * 정적 자산(스타일시트·페이지 스크립트) — `GET /_assets/<sha384 앞 16 hex>/<파일>`. 조립(DB·비밀·세션) **전에** 답한다
 * (`admin/router.ts` `routeAdminAssetEvent`). 본문은 모듈 로드 때 `buildPage` 가 만든 그 문자열이고, 목록에 없는 경로는 404 다.
 */
export const ASSET_PREFIX = '/_assets/';

export interface AdminUiAsset {
  /** `/_assets/<해시>/<파일>` — HTML 의 `href`·`src` 와 CSP 의 URL 이 이 값이다. */
  readonly path: string;
  readonly contentType: string;
  readonly body: string;
  /** SRI — `sha384-<base64>`(본문 UTF-8 바이트). */
  readonly integrity: string;
}

const ASSETS = new Map<string, AdminUiAsset>();

function registerAsset(file: string, contentType: string, body: string): AdminUiAsset {
  const digest = createHash('sha384').update(body, 'utf8').digest();
  const path = `${ASSET_PREFIX}${digest.toString('hex').slice(0, 16)}/${file}`;
  const known = ASSETS.get(path);
  if (known !== undefined) {
    // 경로 해시 64비트 충돌 — 일어나면 조용히 덮지 않고 모듈 로드에서 멈춘다(SRI 가 어차피 막겠지만 화면이 죽는다).
    if (known.body !== body) throw new Error(`asset path collision: ${path}`);
    return known;
  }
  const asset: AdminUiAsset = { path, contentType, body, integrity: `sha384-${digest.toString('base64')}` };
  ASSETS.set(path, asset);
  return asset;
}

/** 경로 → 자산(없으면 `undefined`). 백엔드는 이 함수로만 자산을 낸다. */
export function adminUiAsset(path: string): AdminUiAsset | undefined {
  return ASSETS.get(path);
}

/**
 * 스크립트: 인라인 테마 부트(해시) + 페이지 스크립트 자산(정확한 URL). 스타일: 스타일시트 자산(정확한 URL) 하나.
 * `scriptUrl`·`styleUrl` 은 출처까지 붙은 절대 URL 이다(CSP 소스 식에서 경로를 쓰려면 호스트가 있어야 한다 — `'self'` 는 경로를 못 받는다).
 */
export function buildCsp(
  scriptUrl: string,
  styleUrl: string,
  bootHash: string = sha256Base64(THEME_BOOT_JS),
  fontOrigin: string = CONSOLE_FONT_ORIGIN,
): string {
  return (
    "default-src 'none'; " +
    `script-src 'sha256-${bootHash}' ${scriptUrl}; ` +
    `style-src ${styleUrl}; ` +
    `font-src ${fontOrigin}; ` +
    // 파비콘(`/favicon.svg`, 콘솔 v5) — Firefox 는 파비콘에도 CSP(img-src → default-src 'none')를 건다. 페이지에 <img> 는 여전히 없다.
    "img-src 'self'; " +
    "connect-src 'self'; " +
    "form-action 'none'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'none'; " +
    "require-trusted-types-for 'script'; " +
    "trusted-types 'none'"
  );
}

export interface PageParts {
  /** 한국어 원문(`i18n.ts` 가 영어 벌을 만든다). */
  readonly title: string;
  /** `<body>` 의 클래스 — 페이지 종류별 레이아웃. */
  readonly bodyClass: string;
  /** 정적 마크업(한국어 원문). 동적 값을 끼워 넣지 않는다. 언어 전환 링크 자리는 `LANG_SWITCH`. */
  readonly body: string;
  /** 스크립트 원문(한국어 문구 그대로 — `asciiScript` 는 `buildPage` 가 번역 **뒤에** 건다). */
  readonly script: string;
}

/** 마크업 안의 언어 전환 링크 자리 — 번역이 끝난 뒤 `buildPage` 가 그 언어의 링크로 바꾼다(링크 문구는 반대 언어로 적혀 있다). */
export const LANG_SWITCH = '{{lang-switch}}';

/** 반대 언어로 가는 링크 — `?lang=` 은 서버가 쿠키를 적고 쿼리 없는 같은 경로로 302 한다(`routes/pages.ts`). */
function langSwitch(lang: Lang): string {
  return lang === 'ko'
    ? '<a class="lang" href="?lang=en" hreflang="en" lang="en">English</a>'
    : '<a class="lang" href="?lang=ko" hreflang="ko" lang="ko">한국어</a>';
}

/**
 * 한 언어의 페이지. 순서가 계약이다: ① 원문(한국어)을 그 언어로 번역(`localize` — 마크업과 스크립트는 이스케이프 규칙이
 * 다르다) → ② 스크립트 앞에 `var LANG='ko'|'en';` → ③ ASCII 화(`asciiScript`) → ④ **실제로 싣는 그 문자열**에서 자산 경로·SRI·CSP.
 * `consoleOrigin` 은 페이지를 내는 출처(CSP 의 자산 URL) — 운영은 `https://console.atmark.ai`, 로컬 미리보기만 다르다.
 */
export function buildPage(
  parts: PageParts,
  lang: Lang,
  fontOrigin: string = CONSOLE_FONT_ORIGIN,
  consoleOrigin: string = ADMIN_ORIGIN,
): AdminUiPage {
  const css = registerAsset('console.css', 'text/css; charset=utf-8', fontOrigin === CONSOLE_FONT_ORIGIN ? ADMIN_UI_CSS : adminUiCss(fontOrigin));
  const body = localize(parts.body, lang, 'html').split(LANG_SWITCH).join(langSwitch(lang));
  const script = registerAsset('page.js', 'text/javascript; charset=utf-8', asciiScript(`var LANG='${lang}';${localize(parts.script, lang, 'js')}`));
  const html =
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">' +
    '<meta name="color-scheme" content="light dark">' +
    FAVICON_LINK +
    `<title>${localize(parts.title, lang, 'html')}</title>` +
    `<script>${THEME_BOOT_JS}</script>` +
    `<link rel="stylesheet" href="${css.path}" integrity="${css.integrity}">` +
    `</head><body class="${parts.bodyClass}">${body}` +
    `<script src="${script.path}" integrity="${script.integrity}"></script></body></html>`;
  return { html, csp: buildCsp(`${consoleOrigin}${script.path}`, `${consoleOrigin}${css.path}`, sha256Base64(THEME_BOOT_JS), fontOrigin) };
}

/**
 * 로고 — 가로 조합(심볼 + "atmark", `src/ui/brand.ts` 단일 원천 · 2026-09-30). 인라인 SVG · `currentColor`(무채색 · 테마를 따른다).
 * 이름은 그림 자신이 가진다(`role="img"` · `aria-label="Atmark"` · `<title>`). 높이는 스타일시트(`.logo`)가 정한다.
 */
export const LOGO = brandLockupSvg({ className: 'logo', height: 20 });
