/**
 * src/site/pay.ts — **결제 페이지 `https://pay.atmark.ai`**(WP-2 · 진윤겸 결정 D-1, 계획 §3-9). 홈 λ 가 Host 로 나눠 이 페이지 하나만 낸다.
 *
 * **왜 별도 호스트인가.** `atmark.ai` 는 콘솔의 **자격 포함 CORS 허용 출처**다(`atmarkSiteCors: true`). 제3자 스크립트(Paddle.js)를 그 출처에
 * 실으면 그 스크립트가 콘솔 API 를 소유자 쿠키째 부를 수 있다. `pay.atmark.ai` 는 콘솔 CORS 목록 **밖**이고(`src/admin/http.ts` 무변경),
 * 이 페이지의 CSP `connect-src` 에는 **콘솔 출처가 없다** — Paddle 호스트뿐이다. 쿠키를 만들지도 읽지도 않는다.
 *
 * **흐름.** 콘솔(admin λ)이 Paddle 거래를 만들고 `checkout.url = https://pay.atmark.ai/` 로 준다 → Paddle 이 돌려준 `…/?_ptxn=txn_…` 로
 * 소유자를 보낸다 → 이 페이지가 Paddle.js 를 싣고 `Paddle.Initialize` 한다 → Paddle.js 가 `_ptxn` 을 보고 그 거래의 체크아웃을 연다(P17) →
 * 결제가 끝나면 `PAY_SUCCESS_URL`(콘솔 결제 설정 — 콘솔이 `?billing=return` 을 보고 다시 읽는다)로 간다. 성공 URL 로 가는 것은 **탐색**이지
 * 연결(`connect-src`)이 아니다 — 그래서 콘솔 출처를 CSP 에 넣을 필요가 없다.
 *
 * **경로.** `/`(영어)·`/kr`(한국어) 둘뿐이다(`http.ts` — 2026-09-30 홈과 같은 규칙, 옛 `/en` 은 301 로 `/`).
 *   - **쿼리가 없으면 안내 페이지(`PAY_INFO_PAGES`)가 늘 200이다** — 결제 스위치·설정과 무관하다. Paddle 운영 도메인 심사의 스캐너는
 *     `https://pay.atmark.ai/` 를 쿼리 없이 연다. 거기가 404면 "offline/under construction" 으로 거절된다(2026-09-26). 안내 페이지는 홈의
 *     다른 정적 페이지와 같은 규율이다 — 스크립트 없음(Paddle.js 도 없다) · CSP 는 사이트 기본(`buildSiteCsp`, 스타일 해시만).
 *   - 쿼리가 정확히 `_ptxn=txn_<26>` 하나면 체크아웃 페이지다. 결제 스위치가 꺼졌거나 설정(환경·클라이언트 토큰)이 틀렸거나 그 환경의 CSP
 *     호스트 목록이 비었으면(운영 목록은 E2E 확정 전 `null`) **404**(fail-closed).
 *   - 그 밖의 쿼리·경로는 404.
 *
 * **CSP 호스트는 환경별 상수.** 샌드박스는 Paddle 문서의 후보로 시작하고 샌드박스 E2E 에서 위반 0 으로 확정한다(계획 §0 미확인 ①). 운영
 * 목록은 **확정값만** 넣는다 — 비어 있으면(`null`) 운영에서 이 페이지는 404 다. `require-trusted-types-for` 는 Paddle.js 가 그 아래에서
 * 동작하는지(미확인 ⑧) 확인한 뒤 켠다(`PAY_REQUIRE_TRUSTED_TYPES`).
 *
 * 스크립트는 ASCII(`asciiScript`) · 해시로만 허용 · `innerHTML` 없음 · 문구는 마크업의 숨은 요소(로그인 화면과 같은 규율).
 *
 * 스타일은 `SITE_CSS_NO_FONTS` — 홈의 `@font-face`(자체 호스팅 Pretendard)를 뺀 같은 시트. 이 호스트에는 `/_fonts/` 경로가 없고
 * 체크아웃 CSP 에 `font-src` 가 없다(폰트 요청이 404·CSP 위반이 되지 않게). 글꼴 스택은 같으므로 시스템 글꼴로 떨어진다.
 */

import type { PaddleEnvironment } from '../billing/constants';
import { CONSOLE_ORIGIN, OTHER_LANG, REFUND_POLICY_APPROVED, SITE_ORIGIN, type SiteLang } from './constants';
import { asciiScript, buildSiteCsp, CHROME_COPY, LOGO_TEXT, sha256Base64, sitePath, type SiteDocumentId, type SitePage } from './page';
import { SITE_CSS_NO_FONTS } from './styles';

/** Paddle.js 는 이 주소에서만 싣는다(계획 §0 P16). */
export const PADDLE_JS_URL = 'https://cdn.paddle.com/paddle/v2/paddle.js';

/**
 * `script-src` 에 넣는 Paddle.js 경로(보안 L-5) — 호스트 전체(`https://cdn.paddle.com`)가 아니라 **v2 경로**로 좁힌다. 같은 CDN 의 다른
 * 경로(옛 v1·다른 제품 스크립트)를 이 페이지에서 실을 수 없다. 끝의 `/` 는 CSP 경로 접두사 일치다. 리디렉션 뒤에는 CSP 가 경로를 보지 않으므로
 * 이 좁힘은 첫 요청에만 걸린다. Paddle.js 가 이 경로 밖에서 청크를 싣는지는 샌드박스 E2E 에서 위반 0 으로 확인한다(런북 billing.md §7).
 */
export const PADDLE_JS_SCRIPT_SOURCE = 'https://cdn.paddle.com/paddle/v2/';

/** 결제가 끝나면 가는 곳 — 콘솔 결제 설정. 콘솔이 `billing=return` 을 보고 구독 상태를 다시 읽는다(C 의 콘솔 계약). */
export const PAY_SUCCESS_URL = `${CONSOLE_ORIGIN}/app?billing=return#/settings/plan`;

/** 쿼리의 거래 id(`_ptxn`) 모양 — 이것 하나만 받는다. */
export const PAY_TRANSACTION_PATTERN = /^txn_[a-z0-9]{26}$/;

/** Paddle.js 가 이 페이지에서 쓰는 호스트(CSP). */
export interface PayCspHosts {
  readonly script: readonly string[];
  readonly style: readonly string[];
  readonly img: readonly string[];
  readonly frame: readonly string[];
  readonly connect: readonly string[];
}

/**
 * 환경별 CSP 호스트. **운영은 `null`** — 샌드박스 E2E 로 확정된 값만 운영 목록에 들어간다(계획 §3-9 "운영 목록은 확정값만").
 * 운영 전환 커밋(런북 deploy §21-7)이 `PADDLE_ENVIRONMENT_DEFAULT`·운영 가격 id 와 함께 이 값을 채운다(`REFUND_POLICY_APPROVED` 는 2026-09-26 먼저 켰다) —
 * 기본 환경의 목록이 비면 `pay.test.ts` 가 빨갛다.
 */
export const PAY_CSP_HOSTS: Readonly<Record<PaddleEnvironment, PayCspHosts | null>> = {
  sandbox: {
    script: [PADDLE_JS_SCRIPT_SOURCE],
    // 샌드박스 Paddle.js 는 체크아웃 자산(css·images)을 `sandbox-cdn.paddle.com` 에서 싣는다(paddle.js v2 소스, 2026-09-27 E2E).
    style: ['https://cdn.paddle.com', 'https://sandbox-cdn.paddle.com'],
    img: ['https://cdn.paddle.com', 'https://sandbox-cdn.paddle.com'],
    frame: ['https://sandbox-buy.paddle.com'],
    connect: ['https://sandbox-checkout-service.paddle.com'],
  },
  production: null,
};

/** Trusted Types 강제 — Paddle.js 호환이 확인되면(미확인 ⑧) 켠다. */
const PAY_REQUIRE_TRUSTED_TYPES = false;

/** Paddle.js 클라이언트 토큰 모양 — 공개값(계획 §0 P21). 환경과 접두사가 맞아야 한다(샌드박스 `test_`, 운영 `live_`). */
const PADDLE_CLIENT_TOKEN_PATTERNS: Readonly<Record<PaddleEnvironment, RegExp>> = {
  sandbox: /^test_[A-Za-z0-9]{10,64}$/,
  production: /^live_[A-Za-z0-9]{10,64}$/,
};

/** 결제 페이지 실행 설정 — 핸들러(`src/runtime/handlers/site.ts`)가 환경에서 읽어 넘긴다. */
export interface PayConfig {
  readonly environment: PaddleEnvironment;
  readonly clientToken: string;
}

/** 이 설정으로 페이지를 낼 수 있는가 — 토큰 모양·환경 접두사·그 환경의 CSP 목록. */
export function payConfigUsable(config: PayConfig): boolean {
  return PADDLE_CLIENT_TOKEN_PATTERNS[config.environment].test(config.clientToken) && PAY_CSP_HOSTS[config.environment] !== null;
}

const COPY: Readonly<Record<SiteLang, Readonly<Record<string, string>>>> = {
  ko: {
    title: '결제 | Atmark',
    h1: '결제 창을 여는 중입니다',
    lede: '결제는 Paddle이 처리합니다. 창이 열리지 않으면 잠시 뒤 콘솔에서 다시 시도하세요.',
    fail: '결제 창을 열지 못했습니다. 콘솔로 돌아가 다시 시도하세요.',
    back: '콘솔로 돌아가기',
    noscript: '이 페이지는 자바스크립트가 필요합니다.',
    mor: 'Paddle.com이 판매자(Merchant of Record)로서 결제·청구서·세금을 처리합니다.',
  },
  en: {
    title: 'Checkout | Atmark',
    h1: 'Opening checkout',
    lede: 'Payments are handled by Paddle. If nothing opens, go back to the console and try again in a moment.',
    fail: 'We couldn&rsquo;t open checkout. Go back to the console and try again.',
    back: 'Back to the console',
    noscript: 'This page needs JavaScript.',
    mor: 'Paddle.com is the Merchant of Record and handles payment, invoices and tax.',
  },
};

/** 인라인 스크립트 — 설정 값은 모양을 검사한 것만 JSON 으로 싣는다. 언어와 무관(문구는 마크업). */
function payScript(config: PayConfig): string {
  return asciiScript(
    '(function(){' +
      "var fail=function(){var el=document.getElementById('pay-fail');if(el){el.hidden=false;}};" +
      "var txn=new URLSearchParams(window.location.search).get('_ptxn');" +
      `if(!txn||!${String(PAY_TRANSACTION_PATTERN)}.test(txn)||typeof Paddle==='undefined'){fail();return;}` +
      'try{' +
      (config.environment === 'sandbox' ? "Paddle.Environment.set('sandbox');" : '') +
      `Paddle.Initialize({token:${JSON.stringify(config.clientToken)},checkout:{settings:{successUrl:${JSON.stringify(PAY_SUCCESS_URL)}}}});` +
      '}catch(e){fail();}' +
      '})();',
  );
}

/**
 * 이 호스트만의 CSP — 콘솔 출처 없음.
 *
 * `style-src-attr 'unsafe-inline'`: Paddle.js 는 체크아웃 iframe 을 `setAttribute('style', 'position: fixed; … z-index: 2147483647')`
 * 로 화면 전체에 띄운다. 해시만 있는 `style-src` 는 style **속성**을 막아, 2026-09-27 샌드박스 E2E 에서 iframe 이 기본 크기(왼쪽 아래 작은 상자)로
 * 떨어졌다. 속성에만 인라인을 연다 — `<style>` 요소·외부 시트(`style-src`)는 해시와 Paddle 호스트 그대로다. Paddle.js 가 넣는 `<style>`
 * 두 개(로더 회전 애니메이션·스크롤바 숨김)는 계속 막히며 모양만 다르다. 이 페이지에는 사용자 입력이 그려지지 않으므로 속성 주입 경로가 없다.
 */
export function buildPayCsp(hosts: PayCspHosts, scriptHash: string, styleHash: string): string {
  const list = (values: readonly string[]): string => (values.length === 0 ? '' : ` ${values.join(' ')}`);
  return (
    "default-src 'none'; " +
    `script-src 'sha256-${scriptHash}'${list(hosts.script)}; ` +
    `style-src 'sha256-${styleHash}'${list(hosts.style)}; ` +
    "style-src-attr 'unsafe-inline'; " +
    (hosts.img.length === 0 ? '' : `img-src${list(hosts.img)}; `) +
    (hosts.frame.length === 0 ? '' : `frame-src${list(hosts.frame)}; `) +
    (hosts.connect.length === 0 ? '' : `connect-src${list(hosts.connect)}; `) +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'" +
    (PAY_REQUIRE_TRUSTED_TYPES ? "; require-trusted-types-for 'script'; trusted-types 'none'" : '')
  );
}

/**
 * 결제 페이지 한 벌. 쓸 수 없는 설정이면 `null`(→ 404). 머리·꼬리는 홈과 다르다 — 이 호스트에는 홈의 상대 경로(`/login` 등)가 없으므로
 * 링크는 절대 URL 둘(콘솔 · 홈)뿐이다. 색인하지 않는다.
 */
export function buildPayPage(lang: SiteLang, config: PayConfig): SitePage | null {
  const hosts = PAY_CSP_HOSTS[config.environment];
  if (hosts === null || !payConfigUsable(config)) return null;
  const c = COPY[lang];
  const script = payScript(config);
  const html =
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    '<meta name="robots" content="noindex">' +
    '<meta name="color-scheme" content="light dark">' +
    `<title>${c['title'] ?? ''}</title>` +
    `<style>${SITE_CSS_NO_FONTS}</style>` +
    '</head><body>' +
    `<header class="top"><div class="wrap bar"><a class="logo" href="${SITE_ORIGIN}${sitePath(lang, 'home')}" aria-label="Atmark">${LOGO_TEXT}</a></div></header>` +
    '<main id="main"><section class="wrap nf">' +
    `<h1>${c['h1'] ?? ''}</h1>` +
    `<p class="muted">${c['lede'] ?? ''}</p>` +
    `<p id="pay-fail" role="alert" hidden>${c['fail'] ?? ''}</p>` +
    `<noscript><p>${c['noscript'] ?? ''}</p></noscript>` +
    `<div class="actions"><a class="btn ghost" href="${CONSOLE_ORIGIN}/app#/settings/plan">${c['back'] ?? ''}</a></div>` +
    `<p class="muted">${c['mor'] ?? ''}</p>` +
    '</section></main>' +
    `<script src="${PADDLE_JS_URL}"></script>` +
    `<script>${script}</script>` +
    '</body></html>';
  return { html, csp: buildPayCsp(hosts, sha256Base64(script), sha256Base64(SITE_CSS_NO_FONTS)) };
}

const INFO_COPY: Readonly<Record<SiteLang, Readonly<Record<string, string>>>> = {
  ko: {
    title: 'Atmark 결제',
    description: 'Atmark 유료 요금제의 결제 창구입니다. 결제·세금·청구는 Paddle.com이 판매자(Merchant of Record)로서 처리합니다.',
    h1: 'Atmark 결제',
    about: '이 주소는 AI 에이전트 신원 서비스 Atmark의 유료 요금제 결제 창구입니다.',
    mor: '결제·세금·청구는 Paddle.com이 판매자(Merchant of Record)로서 처리합니다.',
    start: '결제는 콘솔의 설정 &rsaquo; 요금제에서 시작합니다.',
    pricingCta: '요금제 보기',
    homeCta: 'Atmark 홈으로',
    switchTo: 'English',
  },
  en: {
    title: 'Atmark checkout',
    description: 'Checkout for Atmark paid plans. Paddle.com is the Merchant of Record and handles payment, tax and billing.',
    h1: 'Atmark checkout',
    about: 'Checkout for the paid plans of Atmark, an identity service for AI agents.',
    mor: 'Paddle.com is the Merchant of Record and handles payment, tax and billing.',
    start: 'Checkout starts from Settings &rsaquo; Plan in the console.',
    pricingCta: 'See plans',
    homeCta: 'Atmark home',
    switchTo: '한국어',
  },
};

/**
 * 쿼리 없는 `pay.atmark.ai` 의 안내 페이지 — 스위치·설정과 무관하게 늘 200(Paddle 도메인 심사). 스크립트가 없고 CSP 는 홈의 정적 페이지와
 * 같다. 이 호스트에는 홈의 상대 경로가 없으므로 atmark.ai 링크(가격·약관·개인정보·환불·홈)는 절대 URL 이다. 언어 전환만 같은 호스트의
 * `/`·`/kr` 을 가리킨다. 꼬리의 저작권 줄은 홈 푸터의 문구(`CHROME_COPY.copyright`)를 그대로 쓴다. 색인하지 않는다 — 정본 문서는 atmark.ai 에 있다.
 */
export function buildPayInfoPage(lang: SiteLang): SitePage {
  const c = INFO_COPY[lang];
  const chrome = CHROME_COPY[lang];
  const other = OTHER_LANG[lang];
  const site = (id: SiteDocumentId): string => `${SITE_ORIGIN}${sitePath(lang, id)}`;
  const html =
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    // 안내 페이지는 색인하지 않되 링크(홈·약관)는 따라가게 — 홈의 계정 화면·404 와 같은 `noindex,follow`(SEO 리드 판정).
    '<meta name="robots" content="noindex,follow">' +
    '<meta name="color-scheme" content="light dark">' +
    `<meta name="description" content="${c['description'] ?? ''}">` +
    `<title>${c['title'] ?? ''}</title>` +
    `<style>${SITE_CSS_NO_FONTS}</style>` +
    '</head><body>' +
    `<a class="skip" href="#main">${chrome['skip'] ?? ''}</a>` +
    '<header class="top"><div class="wrap bar">' +
    `<a class="logo" href="${site('home')}" aria-label="${chrome['homeLabel'] ?? ''}">${LOGO_TEXT}</a>` +
    '<div class="nav">' +
    `<a class="plain lang" href="${sitePath(other, 'home')}" hreflang="${other}" lang="${other}">${c['switchTo'] ?? ''}</a>` +
    '</div></div></header>' +
    '<main id="main"><section class="wrap doc">' +
    `<h1>${c['h1'] ?? ''}</h1>` +
    `<p class="intro">${c['about'] ?? ''}</p>` +
    `<p>${c['mor'] ?? ''}</p>` +
    `<p>${c['start'] ?? ''}</p>` +
    '<div class="actions">' +
    `<a class="btn" href="${site('pricing')}">${c['pricingCta'] ?? ''}</a>` +
    `<a class="btn ghost" href="${site('home')}">${c['homeCta'] ?? ''}</a>` +
    '</div></section></main>' +
    '<footer class="foot"><div class="wrap">' +
    `<a class="logo" href="${site('home')}" aria-label="${chrome['homeLabel'] ?? ''}">${LOGO_TEXT}</a>` +
    `<nav aria-label="${chrome['legalNav'] ?? ''}">` +
    `<a href="${site('pricing')}">${chrome['pricing'] ?? ''}</a>` +
    `<a href="${site('privacy')}">${chrome['privacy'] ?? ''}</a>` +
    `<a href="${site('terms')}">${chrome['terms'] ?? ''}</a>` +
    (REFUND_POLICY_APPROVED ? `<a href="${site('refund')}">${chrome['refund'] ?? ''}</a>` : '') +
    '</nav>' +
    `<p class="fcopy muted">${chrome['copyright'] ?? ''}</p>` +
    '</div></footer>' +
    '</body></html>';
  return { html, csp: buildSiteCsp(sha256Base64(SITE_CSS_NO_FONTS), false) };
}

/** 안내 페이지 두 벌 — 동적 값이 없어 모듈 로드 때 한 번 만든다. */
export const PAY_INFO_PAGES: Readonly<Record<SiteLang, SitePage>> = { ko: buildPayInfoPage('ko'), en: buildPayInfoPage('en') };
