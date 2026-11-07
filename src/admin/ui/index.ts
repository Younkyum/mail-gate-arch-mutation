/**
 * src/admin/ui — 관리 화면 여섯 페이지. **백엔드(`src/admin/**`)가 부르는 공개면은 이 파일의 여섯 페이지 함수와 자산 조회
 * `adminUiAsset` 뿐이다.**
 *
 * 호스트는 `https://console.atmark.ai`(API 호스트 `api.atmark.ai` 와 분리 — 2026-09-23 리드 결정). 경로에 접두어 없음:
 *   GET /        → renderLoginPage()          로그인(이메일 → "메일을 확인하세요")
 *   GET /login   → renderLoginLandingPage()   로그인 링크 착지(프래그먼트 토큰 → 버튼 → verify)
 *   GET /app     → renderAppPage()            관리 앱
 *   GET /signup         → renderSignupPage()         셀프 가입(이메일 · 조직 이름 · 동의 → "메일을 확인하세요")
 *   GET /signup/verify  → renderSignupLandingPage()  가입 링크 착지(프래그먼트 토큰 → 버튼 → verify)
 *   GET /invite         → renderInvitePage()         초대 링크 착지(프래그먼트 토큰 → 버튼 → claim → 이 브라우저에 결속된 로그인 메일)
 *   GET /_assets/<해시>/<파일> → adminUiAsset(path)  페이지가 싣는 스타일시트·스크립트(불변 · SRI · CSP 정확한 URL — `page.ts`)
 * 페이지가 부르는 API 는 전부 같은 오리진의 `/api/*` 다(`connect-src 'self'`).
 *
 * 각 함수는 `{ html, csp }` 를 돌려준다. 서빙하는 쪽이 할 일:
 *   - `content-type: text/html; charset=utf-8` 와 **`content-security-policy: <csp>` 를 그대로** 싣는다.
 *     CSP 를 빼거나 바꾸면 해시로만 허용된 스크립트·스타일 모델이 무너진다(없으면 인라인이 다 돌고, 다르면 안 돈다).
 *   - 승인 페이지와 같은 공통 헤더를 권한다: `cache-control: no-store` · `referrer-policy: no-referrer` ·
 *     `x-content-type-options: nosniff` · `x-frame-options: DENY`.
 *   - HTML 에 아무것도 끼워 넣지 않는다 — 문자열 한 글자라도 바뀌면(스크립트·스타일 안이라면) 해시가 어긋난다.
 *   - 자산(`adminUiAsset`)은 세션 없이 `public, max-age=31536000, immutable` 로 낸다 — 경로에 내용 해시가 있어 URL 이 곧 본문이다.
 *
 * 페이지는 요청마다 달라지는 값이 없어 모듈 로드 때 **언어별로** 한 번씩 만든다(한국어·영어 — 해시도 언어별, `i18n.ts`).
 * 함수 모양은 백엔드와의 계약이다(언어를 안 주면 한국어).
 */

import { ADMIN_APP_PAGES, APP_PARTS } from './app';
import { DEFAULT_LANG, type Lang } from './i18n';
import { ADMIN_INVITE_PAGES, INVITE_PARTS } from './invite';
import { ADMIN_LOGIN_LANDING_PAGES, ADMIN_LOGIN_PAGES, LANDING_PARTS, LOGIN_PARTS } from './login';
import { ADMIN_SIGNUP_LANDING_PAGES, ADMIN_SIGNUP_PAGES, SIGNUP_LANDING_PARTS, signupParts } from './signup';
import { ADMIN_ORIGIN } from '../http';
import { buildPage, type PageParts } from './page';
import { CONSOLE_FONT_ORIGIN } from './styles';
import type { AdminUiPage } from './page';

export type { AdminUiAsset, AdminUiPage } from './page';
export { adminUiAsset, ASSET_PREFIX } from './page';
export type { Lang } from './i18n';

/**
 * 렌더 옵션(리뷰 M4) — `fontOrigin` 은 `@font-face` url 과 CSP `font-src` 의 출처, `consoleOrigin` 은 페이지를 내는 출처(CSP 의 자산 URL)다.
 * 둘 다 생략하면 운영값(`CONSOLE_FONT_ORIGIN` = 사이트 출처 · `ADMIN_ORIGIN` = 콘솔 출처)이고 그때는 모듈 로드 때 만든 페이지를 그대로 준다.
 * 로컬 미리보기(`scripts/ui/preview.ts`)가 `http://127.0.0.1:<포트>` 둘을 넘긴다.
 */
export interface AdminRenderOptions {
  readonly fontOrigin?: string;
  readonly consoleOrigin?: string;
}

const BUILT = new Map<string, AdminUiPage>();

function pick(pages: Readonly<Record<Lang, AdminUiPage>>, parts: (lang: Lang) => PageParts, name: string, lang: Lang, options?: AdminRenderOptions): AdminUiPage {
  const fontOrigin = options?.fontOrigin ?? CONSOLE_FONT_ORIGIN;
  const consoleOrigin = options?.consoleOrigin ?? ADMIN_ORIGIN;
  if (fontOrigin === CONSOLE_FONT_ORIGIN && consoleOrigin === ADMIN_ORIGIN) return pages[lang];
  const key = `${name}|${lang}|${fontOrigin}|${consoleOrigin}`;
  let page = BUILT.get(key);
  if (page === undefined) {
    page = buildPage(parts(lang), lang, fontOrigin, consoleOrigin);
    BUILT.set(key, page);
  }
  return page;
}

export function renderLoginPage(lang: Lang = DEFAULT_LANG, options?: AdminRenderOptions): AdminUiPage {
  return pick(ADMIN_LOGIN_PAGES, () => LOGIN_PARTS, 'login', lang, options);
}

export function renderLoginLandingPage(lang: Lang = DEFAULT_LANG, options?: AdminRenderOptions): AdminUiPage {
  return pick(ADMIN_LOGIN_LANDING_PAGES, () => LANDING_PARTS, 'landing', lang, options);
}

export function renderAppPage(lang: Lang = DEFAULT_LANG, options?: AdminRenderOptions): AdminUiPage {
  return pick(ADMIN_APP_PAGES, () => APP_PARTS, 'app', lang, options);
}

export function renderSignupPage(lang: Lang = DEFAULT_LANG, options?: AdminRenderOptions): AdminUiPage {
  return pick(ADMIN_SIGNUP_PAGES, signupParts, 'signup', lang, options);
}

export function renderSignupLandingPage(lang: Lang = DEFAULT_LANG, options?: AdminRenderOptions): AdminUiPage {
  return pick(ADMIN_SIGNUP_LANDING_PAGES, () => SIGNUP_LANDING_PARTS, 'signup-landing', lang, options);
}

export function renderInvitePage(lang: Lang = DEFAULT_LANG, options?: AdminRenderOptions): AdminUiPage {
  return pick(ADMIN_INVITE_PAGES, () => INVITE_PARTS, 'invite', lang, options);
}

/** 영어 벌을 만드는 번역 전 원문 전부 — 사전 완전성 테스트가 쓴다(`i18n.ts`: 모든 키가 여기 어딘가에 있다). */
export const UI_SOURCES: readonly PageParts[] = [LOGIN_PARTS, LANDING_PARTS, signupParts('en'), SIGNUP_LANDING_PARTS, APP_PARTS, INVITE_PARTS];

/** 콘솔 용어 사전(2026-10-15 UI 감사 §3.15) — 규칙의 정본. 금지어 테스트(`admin-console-terms.test.ts`)가 읽는다. */
export { TERMS, type Term } from './console/terms';
