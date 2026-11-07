/**
 * src/site/page.ts — 홈 페이지들의 공통 껍데기와 CSP.
 *
 * 콘솔(`src/admin/ui/page.ts`)과 같은 규율이되 더 닫혀 있다:
 *   - **모든 페이지가 머리 스크립트 하나**(`session-hint.ts` — 로그인 여부 힌트)를 `<head>` 에 싣는다. **로그인·가입
 *     (US-003)** 은 폼 스크립트 하나를 본문 끝에 더 싣는다. 둘 다 해시로만 허용(`script-src 'sha256-…'` — 페이지에 실린 블록마다 하나),
 *     ASCII 만(`asciiScript`), `connect-src` 는 콘솔 출처 하나(`CONSOLE_ORIGIN` — 힌트·폼이 부르는 곳). 콘솔 페이지와 같이
 *     `require-trusted-types-for 'script'`·`trusted-types 'none'` 을 더한다(`innerHTML` 류 싱크 차단의 실행 시 짝).
 *   - 스타일은 인라인 블록 하나이고 **해시**로만 허용한다. 해시는 HTML 에 박힌 바로 그 문자열(`SITE_CSS`)에서 잰다.
 *     `style=""` 속성은 CSP 가 막는다 — 마크업에 쓰지 않는다(테스트가 단언).
 *   - 이미지·외부 리소스 없음(`img-src` 도 없다). 인라인 SVG 는 문서의 일부라 리소스 요청이 아니다. 폰트는 같은 오리진 `/_fonts/…` 만
 *     (`font-src 'self'` — 자체 호스팅 Pretendard, `src/ui/fonts.ts`).
 *   - 동적 값이 없다 — 페이지는 모듈 로드 때 한 번 만든다(요청마다 끼워 넣는 값이 없다).
 *
 * 언어(영어가 기본): 영어(`/…`)·한국어(`/kr…`) 두 벌. 각 페이지는 `<html lang>` · `hreflang` 대안 링크(en·ko·x-default=en)
 * · 눈에 보이는 언어 전환 링크(`?hl=<언어>` — 엣지가 선택 쿠키를 적는다, `edge-lang.ts`)를 싣는다. `<link rel="alternate|canonical">` 은
 * 리소스를 가져오지 않으므로 CSP 와 무관하다.
 *
 * CSP 각 지시어: `default-src 'none'`(그 밖 전부 닫음) · `script-src 'sha256-…'` · `style-src 'sha256-…'` · `font-src 'self'` · `img-src 'self'` ·
 * `connect-src https://console.atmark.ai` · `base-uri 'none'` ·
 * `form-action 'none'`(폼은 스크립트가 가로챈다 — 스크립트가 죽어도 어디로도 제출되지 않는다) · `frame-ancestors 'none'`(클릭재킹).
 */

import { createHash } from 'node:crypto';

import { brandLockupSvg } from '../ui/brand';
import { FAVICON_LINK } from '../ui/favicon';
import {
  CONSOLE_APP_URLS,
  CONSOLE_ORIGIN,
  CONTACT_EMAIL,
  docsUrl,
  langPrefix,
  OTHER_LANG,
  REFUND_POLICY_APPROVED,
  SITE_LANG_QUERY,
  SITE_ORIGIN,
  type SiteLang,
} from './constants';
import { BLOG_NAV, type BlogNavLink } from './blog-nav';
import { ldJson, organizationNode, socialMeta, type LdNode, type SocialParts } from './seo';
import { HINT_GO_ATTR, SESSION_HINT_SCRIPT } from './session-hint';
import { SITE_CSS } from './styles';

/** 핸들러가 받는 모양 — `{ html, csp }`. */
export interface SitePage {
  readonly html: string;
  readonly csp: string;
}

export function sha256Base64(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

/** 텍스트 → HTML 본문·속성 값(`& < > "`). 글·사용 예시처럼 원문이 마크업이 아닌 값에만 쓴다. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 페이지가 아닌 응답(301·405)의 CSP — 아무것도 허용하지 않는다. */
export const BARE_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * 스크립트 없는 페이지의 CSP(결제 호스트 안내 — `pay.ts`). `fonts=false` 는 폰트를 싣지 않는 페이지(`SITE_CSS_NO_FONTS`, 그 호스트엔 `/_fonts/` 가 없다)
 * — `font-src` 를 열지 않는다(쓰지 않는 허용을 두지 않는다).
 */
export function buildSiteCsp(styleHash: string, fonts = true): string {
  return `default-src 'none'; style-src 'sha256-${styleHash}'; ${fonts ? `font-src 'self'; ${FAVICON_IMG_SRC}` : ''}base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/**
 * 파비콘(`/favicon.svg`, 콘솔 v5 — `src/ui/favicon.ts`) — Firefox 는 파비콘 요청에도 CSP 를 건다(img-src → `default-src 'none'` 이면 막힘).
 * 본 호스트(atmark.ai) 페이지만 싣는다 — 결제 호스트 안내에는 `<link rel="icon">` 이 없다. 페이지에 `<img>` 는 여전히 없다.
 */
const FAVICON_IMG_SRC = "img-src 'self'; ";

/** 사이트 페이지(atmark.ai)의 CSP — 스크립트 해시(실린 블록마다 하나) · 연결은 콘솔 출처 하나 · Trusted Types. */
export function buildSiteScriptCsp(scriptHashes: readonly string[], styleHash: string): string {
  return (
    "default-src 'none'; " +
    `script-src ${scriptHashes.map((h) => `'sha256-${h}'`).join(' ')}; ` +
    `style-src 'sha256-${styleHash}'; ` +
    "font-src 'self'; " +
    FAVICON_IMG_SRC +
    `connect-src ${CONSOLE_ORIGIN}; ` +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; " +
    "require-trusted-types-for 'script'; trusted-types 'none'"
  );
}

/** 스크립트 소스를 ASCII 로(콘솔 `asciiScript` 와 같은 규칙) — 응답 인코딩이 흔들려도 해시가 흔들리지 않게. */
export function asciiScript(source: string): string {
  return source.replace(/[^\x00-\x7f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** 두 언어에 다 있는 페이지(늘 라우트에 있다). 가격(`pricing`)은 Paddle 웹사이트 심사가 요구하는 공개 페이지다(`pricing.ts`). */
export type SitePageId = 'home' | 'pricing' | 'privacy' | 'terms' | 'login' | 'signup' | 'waitlist' | 'use-cases' | 'abuse' | 'changelog';

/** 두 언어 페이지 전부 — 환불 정책(`refund`, WP-2)은 `REFUND_POLICY_APPROVED` 일 때만 라우트에 오른다(`http.ts`). */
export type SiteDocumentId = SitePageId | 'refund';

/** 페이지의 경로 — `home` 은 `/`(영어)·`/kr`(한국어), 나머지는 `/<id>`·`/kr/<id>`. */
export function sitePath(lang: SiteLang, id: SiteDocumentId): string {
  if (id === 'home') return lang === 'ko' ? langPrefix('ko') : '/';
  return `${langPrefix(lang)}/${id}`;
}

/**
 * 보이는 언어 전환 링크의 목적지 — 반대 언어의 같은 페이지 + `?hl=<언어>`. 엣지 함수(`edge-lang.ts`)가 이 쿼리를 보면 선택 쿠키를 적고 쿼리 없는
 * 같은 경로로 302 한다. 엣지가 없는 곳(직접 부른 λ)에서는 쿼리가 무시되고 같은 페이지가 그대로 나온다.
 */
export function langSwitchHref(target: SiteLang, id: SiteDocumentId): string {
  return `${sitePath(target, id)}?${SITE_LANG_QUERY}=${target}`;
}

/** 머리·꼬리의 언어별 문구. 키 집합이 같다(테스트). */
export const CHROME_COPY: Readonly<Record<SiteLang, Readonly<Record<string, string>>>> = {
  ko: {
    skip: '본문으로 건너뛰기',
    homeLabel: 'Atmark 홈',
    primaryNav: '주 메뉴',
    menu: '메뉴',
    navGet: '신원',
    navHow: '작동 방식',
    useCases: '사용 예시',
    footProduct: '제품',
    accountNav: '계정',
    login: '로그인',
    start: '시작하기',
    // 머리의 주 버튼(가입은 대기자 명단 초대로만).
    waitlist: '대기자 명단',
    console: '콘솔',
    legalNav: '안내',
    pricing: '요금제',
    docs: '문서',
    privacy: '개인정보 처리 안내',
    terms: '이용약관',
    refund: '환불 정책',
    contact: '문의',
    blog: '블로그',
    changelog: '변경 내역',
    abuse: '남용 신고',
    copyright: '© 2026 Atmark',
    ogAlt: 'Atmark 로고와 헤드라인 “에이전트에게, 자기만의 이메일을.” 옆에 Atmark 콘솔 개요 화면',
    switchTo: 'English',
    contactPending: '정식 출시 전에 여기에 안내하겠습니다.',
  },
  en: {
    skip: 'Skip to content',
    homeLabel: 'Atmark home',
    primaryNav: 'Main',
    menu: 'Menu',
    navGet: 'Identity',
    navHow: 'How it works',
    useCases: 'Use cases',
    footProduct: 'Product',
    accountNav: 'Account',
    login: 'Log in',
    start: 'Get started',
    waitlist: 'Join the waitlist',
    console: 'Console',
    legalNav: 'Legal',
    pricing: 'Pricing',
    docs: 'Docs',
    privacy: 'Privacy',
    terms: 'Terms',
    refund: 'Refunds',
    contact: 'Contact',
    blog: 'Blog',
    changelog: 'Changelog',
    abuse: 'Report abuse',
    copyright: '© 2026 Atmark',
    ogAlt: 'The Atmark logo and the headline “Give your agent its own email.” next to the Atmark console overview',
    switchTo: '한국어',
    contactPending: 'A contact address will be published here before general launch.',
  },
};

export interface SitePageParts {
  readonly lang: SiteLang;
  readonly title: string;
  readonly description: string;
  /** `<main>` 안의 정적 마크업. */
  readonly main: string;
  /** 두 언어에 다 있는 페이지면 그 id(hreflang·언어 전환이 같은 페이지를 가리킨다). 404 는 없음 — 전환은 홈으로. */
  readonly id?: SiteDocumentId;
  /** 본문 끝 인라인 스크립트(로그인·가입만). ASCII 로 바꾼 뒤 그 문자열에서 해시를 잰다(머리 힌트 스크립트와 함께 `script-src` 에). */
  readonly script?: string;
  /** 로그인한 방문자를 콘솔로 보낸다(`<html data-hint="go">` — 로그인 화면만, `session-hint.ts`). */
  readonly hintGo?: boolean;
  /** 머리가 사진 히어로 위에서 시작한다(`<html data-hero>` — 홈만). 머리 스크립트가 스크롤 위치로 `at-hero` 를 켜고 끈다(`session-hint.ts`). */
  readonly hero?: boolean;
  /** 조직 노드 뒤에 붙일 구조화 데이터(홈: WebSite·FAQPage, 가격: SoftwareApplication). 색인하는 페이지에서만 싣는다. */
  readonly structured?: readonly LdNode[];
  /**
   * `SiteDocumentId` 밖의 색인 페이지(블로그 — 언어별로 있을 수도 없을 수도 있다). 있으면 `id` 대신 이 값이 정본·대안 링크·언어 전환을 정한다.
   * 이 페이지는 색인한다(`index,follow` + JSON-LD).
   */
  readonly route?: PageRoute;
  /** 링크 미리보기 덮어쓰기(블로그 글 — `og:type=article`, 글마다 그린 카드). */
  readonly social?: Pick<SocialParts, 'type' | 'image' | 'alternateLocale' | 'article'> & { readonly imageAlt?: string };
  /** `<head>` 끝에 더 싣는 링크(블로그 RSS 의 `<link rel="alternate" type="application/rss+xml">`) — 리소스를 가져오지 않는 `<link>` 만. */
  readonly head?: string;
  /** 머리·꼬리의 "블로그" 링크 덮어쓰기(로컬 미리보기의 초안 블로그). 기본은 공개 글로 정한 `BLOG_NAV`. */
  readonly blogNav?: BlogNavLink | null;
}

/**
 * 블로그처럼 언어마다 있을 수도 없을 수도 있는 페이지의 경로. `alternates` 는 두 언어가 **다 있을 때만** 채운다(hreflang ko·en·x-default=en) —
 * 한 언어뿐이면 canonical 만 싣는다. `switchHref` 는 보이는 언어 전환 링크(반대 언어의 같은 페이지, 없으면 그 언어의 블로그 목록이나 홈 + `?hl=`).
 */
export interface PageRoute {
  readonly self: string;
  readonly alternates: Readonly<Partial<Record<SiteLang, string>>>;
  readonly switchHref: string;
  /** 머리 주 메뉴에서 현재 표시할 칸. */
  readonly section: 'blog';
}

/**
 * 색인하지 않는 페이지 — 계정 화면(로그인·가입). 404(`id` 없음)도 색인하지 않는다. 둘 다 `noindex,follow`(링크는 따라간다).
 * robots.txt 에서 막지 않는다 — 막으면 크롤러가 이 `noindex` 를 읽지 못한다(`crawl.ts`).
 */
export const NOINDEX_IDS: ReadonlySet<SiteDocumentId> = new Set<SiteDocumentId>(['login', 'signup', 'waitlist']);

export function isIndexed(id: SiteDocumentId | undefined): id is SiteDocumentId {
  return id !== undefined && !NOINDEX_IDS.has(id);
}

/**
 * 선 아이콘(16 · 선 1.5 · `vector-effect:non-scaling-stroke`) — 콘솔 `ICON_PATHS`(`src/admin/ui/console/kit.ts`)와 같은 모양. 글자 기호(→ ✓ ✕)를
 * 쓰지 않는다. 색·굵기는 스타일시트 `.ico` 가 준다(표현 속성 없음 · data: URI 없음).
 */
export function lineIcon(d: string, cls = 'ico'): string {
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
}

export const ARROW_RIGHT_ICON = lineIcon('M3 8h10M9 4l4 4-4 4', 'ico arr');

/**
 * 로고 — 가로 조합(심볼 + "atmark", `src/ui/brand.ts` 단일 원천). 인라인 SVG · `currentColor`(머리의 글자색 — 사진 히어로 위에서도).
 * 크기는 스타일시트의 높이(`.logo .brand`)가 정한다. 감싸는 링크가 이름(`aria-label`)을 가지므로 그림 자신의 이름은 겹쳐도 무방하다.
 */
export const LOGO_TEXT = brandLockupSvg({ className: 'brand', height: 22 });

/** `이름@atmark.ai` 꼴 주소 — `@` 는 `.at`(색 없음). 로컬파트는 코드 상수만 넣는다(사용자 입력이 아니다). */
export function agentAddress(localPart: string): string {
  return `<span class="addr">${localPart}<span class="at">@</span>atmark.ai</span>`;
}

/** 문의처 한 줄 — `CONTACT_EMAIL` 이 정해지기 전에는 주소를 지어내지 않는다. */
export function contactHtml(lang: SiteLang): string {
  return CONTACT_EMAIL === null
    ? (CHROME_COPY[lang]['contactPending'] ?? '')
    : `<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`;
}

/**
 * 주 메뉴 링크 — 사용 예시 · 요금제 · 문서(`docs.atmark.ai`, 같은 언어) · 블로그(공개 글이 있을 때만). 현재 페이지면 `aria-current="page"`
 * (`site-wording.test.ts` 가 이 모양의 링크만 걷어 낸다).
 */
function mainLinks(lang: SiteLang, current: SiteDocumentId | undefined, section: PageRoute['section'] | undefined, blog: BlogNavLink | null): string {
  const c = CHROME_COPY[lang];
  return (
    `<a href="${sitePath(lang, 'use-cases')}"${current === 'use-cases' ? ' aria-current="page"' : ''}>${c['useCases'] ?? ''}</a>` +
    `<a href="${sitePath(lang, 'pricing')}"${current === 'pricing' ? ' aria-current="page"' : ''}>${c['pricing'] ?? ''}</a>` +
    `<a href="${docsUrl(lang)}">${c['docs'] ?? ''}</a>` +
    blogLink(lang, blog, section === 'blog')
  );
}

/** "블로그" 링크(`blog-nav.ts`) — 한국어 글이 없으면 한국어 페이지의 링크는 영어 목록으로(`hreflang="en"`). 블로그 안이면 `aria-current`. */
function blogLink(lang: SiteLang, blog: BlogNavLink | null, current: boolean): string {
  if (blog === null) return '';
  return `<a href="${blog.href}"${blog.hreflang === null ? '' : ` hreflang="${blog.hreflang}"`}${current ? ' aria-current="page"' : ''}>${CHROME_COPY[lang]['blog'] ?? ''}</a>`;
}

/**
 * 머리 — 세 칸 격자(`1fr auto 1fr`): 로고 · 주 메뉴 · 계정(로그인 · 대기자 명단, 로그인했으면 콘솔). 양옆 칸이 같은 폭이라 주 메뉴가
 * 정확히 가운데에 선다. 언어 전환은 꼬리에 있고, 휴대폰의 ≡ 서랍에만 예외로 둔다(꼬리가 멀다).
 * 로그인 여부(`session-hint.ts`)는 `<html class="signed-in">` 하나로 갈린다 — `.si` 는 로그인했을 때만, `.so` 는 로그아웃일 때만 보인다
 * (기본은 로그아웃 — `.si` 가 처음부터 자리 없이 숨어 화면이 움직이지 않는다).
 * 767px 이하의 ≡ 는 **Popover API**(`<button popovertarget>` + `<nav popover>`, 스크립트 없음) — Esc·바깥 누름으로 닫히고 포커스가 ≡ 로
 * 돌아간다(브라우저 기본). popover 를 모르는 브라우저는 ≡ 를 숨기고 같은 링크를 한 줄로 늘 보인다. 알려진 한계: auto popover 는 포커스를
 * 가두지 않는다.
 */
function header(lang: SiteLang, switchHref: string, current: SiteDocumentId | undefined, section: PageRoute['section'] | undefined, blog: BlogNavLink | null): string {
  const c = CHROME_COPY[lang];
  const other = OTHER_LANG[lang];
  const links = mainLinks(lang, current, section, blog);
  return (
    '<header class="top"><div class="wrap bar bar3">' +
    '<div class="bar-l">' +
    `<a class="logo" href="${sitePath(lang, 'home')}" aria-label="${c['homeLabel'] ?? ''}">${LOGO_TEXT}</a>` +
    '</div>' +
    `<nav class="nav-main" aria-label="${c['primaryNav'] ?? ''}">${links}</nav>` +
    `<nav class="nav acct" aria-label="${c['accountNav'] ?? ''}">` +
    // 지금 보고 있는 페이지를 가리키는 머리 동작은 현재 표시 + 보조 모양(가입 화면에 검은 주 버튼이 둘이 되지 않게).
    `<a class="plain so" href="${sitePath(lang, 'login')}"${current === 'login' ? ' aria-current="page"' : ''}>${c['login'] ?? ''}</a>` +
    // 가입은 초대로만 — 주 버튼은 "대기자 명단". 초대받은 사람은 초대 메일의 버튼으로 가입 화면에 온다.
    (current === 'waitlist'
      ? `<a class="btn sm ghost so" href="${sitePath(lang, 'waitlist')}" aria-current="page">${c['waitlist'] ?? ''}</a>`
      : `<a class="btn sm so" href="${sitePath(lang, 'waitlist')}">${c['waitlist'] ?? ''}</a>`) +
    // 로그인한 방문자는 같은 자리에 "콘솔".
    `<a class="btn sm si con" href="${CONSOLE_APP_URLS.app}">${c['console'] ?? ''}</a>` +
    '</nav>' +
    `<button type="button" class="mnav-b" popovertarget="mnav-p"><span class="bars" aria-hidden="true"></span><span class="sr">${c['menu'] ?? ''}</span></button>` +
    '</div>' +
    `<nav class="mnav-p" id="mnav-p" popover aria-label="${c['primaryNav'] ?? ''}">` +
    links +
    `<a class="plain so" href="${sitePath(lang, 'login')}">${c['login'] ?? ''}</a>` +
    `<a class="lang" href="${switchHref}" hreflang="${other}" lang="${other}">${c['switchTo'] ?? ''}</a>` +
    '</nav>' +
    '</header>'
  );
}

/**
 * 꼬리 — 넓은 화면 세 열(`2fr 1fr 1fr`): 로고 / 제품(홈 앵커 둘 · 사용 예시·요금제·문서·블로그·변경 내역) / 안내(개인정보·약관·환불·
 * 문의·남용 신고·언어 — 지금 페이지 경로를 지킨다). 맨 아래 저작권 한 줄. 운영자 표기는 약관 제1조·구조화 데이터에만 둔다.
 * 열 제목은 `nav` 의 `aria-label` 과 같은 이름이라 보조기술에는 한 번만 읽히게 숨긴다.
 */
function footer(lang: SiteLang, switchHref: string, blog: BlogNavLink | null): string {
  const c = CHROME_COPY[lang];
  const other = OTHER_LANG[lang];
  const home = sitePath(lang, 'home');
  const col = (label: string, links: string): string =>
    `<nav aria-label="${label}"><p class="fh" aria-hidden="true">${label}</p>${links}</nav>`;
  return (
    '<footer class="foot"><div class="wrap fgrid">' +
    '<div class="fbrand">' +
    `<a class="logo" href="${home}" aria-label="${c['homeLabel'] ?? ''}">${LOGO_TEXT}</a>` +
    '</div>' +
    col(
      c['footProduct'] ?? '',
      `<a href="${home}#get-title">${c['navGet'] ?? ''}</a>` +
        `<a href="${home}#how-title">${c['navHow'] ?? ''}</a>` +
        `<a href="${sitePath(lang, 'use-cases')}">${c['useCases'] ?? ''}</a>` +
        `<a href="${sitePath(lang, 'pricing')}">${c['pricing'] ?? ''}</a>` +
        `<a href="${docsUrl(lang)}">${c['docs'] ?? ''}</a>` +
        blogLink(lang, blog, false) +
        `<a href="${sitePath(lang, 'changelog')}">${c['changelog'] ?? ''}</a>`,
    ) +
    col(
      c['legalNav'] ?? '',
      `<a href="${sitePath(lang, 'privacy')}">${c['privacy'] ?? ''}</a>` +
        `<a href="${sitePath(lang, 'terms')}">${c['terms'] ?? ''}</a>` +
        (REFUND_POLICY_APPROVED ? `<a href="${sitePath(lang, 'refund')}">${c['refund'] ?? ''}</a>` : '') +
        (CONTACT_EMAIL === null ? '' : `<a href="mailto:${CONTACT_EMAIL}">${c['contact'] ?? ''}</a>`) +
        `<a href="${sitePath(lang, 'abuse')}">${c['abuse'] ?? ''}</a>` +
        `<a href="${switchHref}" hreflang="${other}" lang="${other}">${c['switchTo'] ?? ''}</a>`,
    ) +
    `<p class="fcopy muted">${c['copyright'] ?? ''}</p>` +
    '</div></footer>'
  );
}

/** canonical 과(두 언어가 다 있을 때만) hreflang 대안 링크(ko·en·x-default=en — 영어가 기본) — 절대 URL(`https://atmark.ai…`). */
function alternateLinks(self: string, pair: Readonly<Partial<Record<SiteLang, string>>>): string {
  const { en, ko } = pair;
  return (
    `<link rel="canonical" href="${SITE_ORIGIN}${self}">` +
    (en === undefined || ko === undefined
      ? ''
      : `<link rel="alternate" hreflang="ko" href="${SITE_ORIGIN}${ko}">` +
        `<link rel="alternate" hreflang="en" href="${SITE_ORIGIN}${en}">` +
        `<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${en}">`)
  );
}

/** 머리 힌트 스크립트(모든 페이지 같은 문자열 — ASCII 로 바꾼 값). */
const HINT_SCRIPT = asciiScript(SESSION_HINT_SCRIPT);
const HINT_SCRIPT_HASH = sha256Base64(HINT_SCRIPT);
const SITE_CSS_HASH = sha256Base64(SITE_CSS);

export function buildSitePage(parts: SitePageParts): SitePage {
  const { lang, route } = parts;
  const switchHref = route?.switchHref ?? langSwitchHref(OTHER_LANG[lang], parts.id ?? 'home');
  const script = parts.script === undefined ? undefined : asciiScript(parts.script);
  const indexed = route !== undefined || isIndexed(parts.id);
  const canonical = route !== undefined ? `${SITE_ORIGIN}${route.self}` : parts.id === undefined ? undefined : `${SITE_ORIGIN}${sitePath(lang, parts.id)}`;
  const blogNav = parts.blogNav === undefined ? BLOG_NAV[lang] : parts.blogNav;
  const { imageAlt, ...socialRest } = parts.social ?? {};
  const social =
    canonical === undefined
      ? ''
      : socialMeta({
          lang,
          title: parts.title,
          description: parts.description,
          url: canonical,
          imageAlt: imageAlt ?? CHROME_COPY[lang]['ogAlt'] ?? '',
          ...socialRest,
        });
  const html =
    `<!doctype html><html lang="${lang}"${parts.hintGo === true ? ` ${HINT_GO_ATTR}` : ''}${parts.hero === true ? ' data-hero' : ''}><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    `<meta name="robots" content="${indexed ? 'index,follow' : 'noindex,follow'}">` +
    '<meta name="color-scheme" content="light dark">' +
    FAVICON_LINK +
    `<meta name="description" content="${parts.description}">` +
    `<title>${parts.title}</title>` +
    (route !== undefined
      ? alternateLinks(route.self, route.alternates)
      : parts.id === undefined
        ? ''
        : alternateLinks(sitePath(lang, parts.id), { ko: sitePath('ko', parts.id), en: sitePath('en', parts.id) })) +
    social +
    (parts.head ?? '') +
    (indexed ? ldJson([organizationNode(), ...(parts.structured ?? [])]) : '') +
    `<style>${SITE_CSS}</style>` +
    `<script>${HINT_SCRIPT}</script>` +
    '</head><body>' +
    `<a class="skip" href="#main">${CHROME_COPY[lang]['skip'] ?? ''}</a>` +
    header(lang, switchHref, parts.id, route?.section, blogNav) +
    `<main id="main">${parts.main}</main>` +
    footer(lang, switchHref, blogNav) +
    (script === undefined ? '' : `<script>${script}</script>`) +
    '</body></html>';
  const scriptHashes = [HINT_SCRIPT_HASH, ...(script === undefined ? [] : [sha256Base64(script)])];
  return { html, csp: buildSiteScriptCsp(scriptHashes, SITE_CSS_HASH) };
}
