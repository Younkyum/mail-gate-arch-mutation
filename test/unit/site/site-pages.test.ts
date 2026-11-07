/**
 * 홈(`src/site`) 여덟 페이지(소개·가격·개인정보·약관·환불·로그인·가입·404) — CSP·스타일·링크 규율을 **렌더된 HTML 에서** 단언한다
 * (콘솔 `admin-ui.test.ts` 와 같은 방식). 로그인·가입의 스크립트 동작은 `site-auth.test.ts`.
 *
 * 해시는 모듈이 알려 주는 값을 믿지 않고 HTML 을 다시 파싱해 인라인 블록마다 직접 잰다. 검사기들이 공허하지 않은지도
 * 단언한다(⑧ — 일부러 망가뜨린 입력을 넣으면 거부해야 한다).
 *
 * 되돌려서 빨개지는지 확인한 것(2026-09-24, 소스를 직접 고쳐 돌리고 되돌림): 파일 머리의 표는 `docs/runbooks/site.md` §6.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DB_BACKUP_RETENTION_DAYS } from '../../../infra/cdk/stacks/data-stack';
import { buildBlog, readBlogSources } from '../../../scripts/blog/build';
import { MCP_URL } from '../../../src/admin/ui/setup-message';
import { BLOG_SITE, buildBlogSite } from '../../../src/site/blog';
import { BLOG_NAV } from '../../../src/site/blog-nav';
import {
  CONSOLE_ORIGIN,
  CONTACT_EMAIL,
  docsUrl,
  effectiveDateText,
  OTHER_LANG,
  PLAN_MONTHLY_PRICE_USD,
  SITE_ORIGIN,
  TERMS_EFFECTIVE_DATE,
  PRIVACY_EFFECTIVE_DATE,
  type SiteLang,
} from '../../../src/site/constants';
import { HERO_AGENT_NAMES } from '../../../src/site/hero-names';
import { HOME_COPY } from '../../../src/site/home';
import { SITE_ROUTES } from '../../../src/site/http';
import {
  renderAbusePage,
  renderChangelogPage,
  renderHomePage,
  renderLoginPage,
  renderNotFoundPage,
  renderPricingPage,
  renderPrivacyPage,
  renderRefundPage,
  renderSignupPage,
  renderTermsPage,
  renderUseCasesPage,
  renderWaitlistPage,
  type SitePage,
} from '../../../src/site/index';
import { USE_CASES, useCaseDocsHref } from '../../../src/site/use-cases';
import { OG_IMAGES } from '../../../src/site/image-data';
import { SITE_PHOTOS } from '../../../src/site/photo-data';
import { ARROW_RIGHT_ICON, asciiScript, CHROME_COPY, isIndexed, LOGO_TEXT, sitePath, type SiteDocumentId } from '../../../src/site/page';
import { SESSION_HINT_SCRIPT } from '../../../src/site/session-hint';
import { SITE_CSS, SITE_DARK, SITE_LIGHT } from '../../../src/site/styles';
import { APPLE_TOUCH_ICON_PATH, FAVICON_ICO_PATH, FAVICON_LINK, FAVICON_SVG_PATH } from '../../../src/ui/favicon';
import { cspDirective, sha256Base64 } from '../../support/site-html';

const RENDER: Readonly<Record<SiteDocumentId | 'not-found', (lang: SiteLang) => SitePage>> = {
  home: renderHomePage,
  pricing: renderPricingPage,
  refund: renderRefundPage,
  privacy: renderPrivacyPage,
  terms: renderTermsPage,
  login: renderLoginPage,
  signup: renderSignupPage,
  waitlist: renderWaitlistPage,
  'use-cases': renderUseCasesPage,
  abuse: renderAbusePage,
  changelog: renderChangelogPage,
  'not-found': renderNotFoundPage,
};

/**
 * 본문 끝에 폼 스크립트를 더 싣는 페이지(US-003) — 로그인·가입. 모든 페이지는 머리 힌트 스크립트(`session-hint.ts`, 2026-09-30) 하나를
 * 싣는다 — 그래서 로그인·가입은 실행 블록 둘, 나머지는 하나.
 */
const SCRIPTED: ReadonlySet<string> = new Set(['login', 'signup', 'waitlist']);

/** 머리 힌트 스크립트 — HTML 에 박힌 모양(ASCII 화한 원문). 모든 페이지·두 언어가 같은 문자열이다. */
const HINT = asciiScript(SESSION_HINT_SCRIPT);

/** 언어 전환 링크의 목적지 — 반대 언어의 같은 페이지 + `?hl=<언어>`(2026-09-30, 엣지가 선택 쿠키를 적는다). */
const switchHref = (target: SiteLang, id: SiteDocumentId | 'not-found'): string => `${sitePath(target, id === 'not-found' ? 'home' : id)}?hl=${target}`;

/** 가격·요금제를 말하는 것이 본분인 페이지 — ⑥(가격·무료 문구 금지)에서 빠진다. 과장 금지는 `pricing.test.ts` 가 따로 건다. */
const PRICED: ReadonlySet<string> = new Set(['pricing', 'refund']);

/** [이름, 언어, 페이지 id, 렌더] — 두 언어 × 여덟 페이지. */
const PAGES: ReadonlyArray<readonly [string, SiteLang, SiteDocumentId | 'not-found', () => SitePage]> = (['ko', 'en'] as const).flatMap(
  (lang) => (Object.keys(RENDER) as (SiteDocumentId | 'not-found')[]).map((id) => [`${lang} ${id}`, lang, id, () => RENDER[id](lang)] as const),
);

/** 공통 꼬리의 가격 페이지 링크 — 모든 페이지에 있는 **내비게이션 이름**(요금제·Pricing)이라 ⑥ 에서 걷어 낸다. 금액은 여전히 금지. */
const pricingNavLink = (lang: SiteLang): string => `<a href="${sitePath(lang, 'pricing')}">${CHROME_COPY[lang]['pricing'] ?? ''}</a>`;

/**
 * 머리(주 메뉴·모바일 메뉴)와 꼬리의 가격 링크 **전부** — href 가 정확히 가격 경로이고 글자가 정확히 링크 이름인 `<a>` 만(속성 `class`·
 * `aria-current` 허용, 명세 §6.3 · `site-wording.test.ts` 와 같은 모양). 그 밖의 금액·"무료"는 그대로 잡힌다.
 */
const withoutPricingNav = (html: string, lang: SiteLang): string =>
  html.replace(
    new RegExp(`<a(?: class="[^"]*")? href="${sitePath(lang, 'pricing')}"(?: aria-current="page")?>${CHROME_COPY[lang]['pricing'] ?? ''}</a>`, 'g'),
    '',
  );

/**
 * 약관의 '요금제와 결제' 조(2026-09-26 개정) — 요금제·무료 베타를 말하는 것이 본분인 **조 하나**. ⑥ 은 약관 페이지에서 이 조만 걷어 내고
 * 나머지에 가격·무료 금지를 그대로 건다. 조 안에도 금액은 없어야 한다(⑬-결제).
 */
const TERMS_BILLING_ARTICLE = /<section(?: id="[a-z0-9-]+")?><h2>(?:제\d+조 \(요금제와 결제\)|\d+\. Plans and payment)<\/h2>[\s\S]*?<\/section>/;

/** 약관 목차(R1-22)에서 그 조를 가리키는 링크 **하나** — 글자는 그 조 제목 그대로다. 조와 같은 예외로, 정확히 이 모양 하나만 걷어 낸다. */
const TERMS_BILLING_TOC = /<li><a href="#art-\d+">(?:제\d+조 \(요금제와 결제\)|\d+\. Plans and payment)<\/a><\/li>/;


function blocks(html: string, tag: 'script' | 'style'): string[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1] ?? '');
}

/** JSON-LD 데이터 블록(`seo.ts` `ldJson`) — 색인하는 페이지에 정확히 하나. */
const LD_BLOCK = /<script type="application\/ld\+json">[\s\S]*?<\/script>/g;
function ldBlocks(html: string): string[] {
  return [...html.matchAll(LD_BLOCK)].map((m) => m[0]);
}
function withoutLd(html: string): string {
  return html.replace(LD_BLOCK, '');
}


/** 인라인 스타일 해시가 CSP 에 있고, 쓰이지 않는 해시가 없다. 문제 목록(빈 배열 = 통과). */
function hashProblems(page: SitePage): string[] {
  const problems: string[] = [];
  const allowed = cspDirective(page.csp, 'style-src') ?? [];
  const needed = [...new Set(blocks(page.html, 'style').map((b) => `'sha256-${sha256Base64(b)}'`))];
  for (const hash of needed) if (!allowed.includes(hash)) problems.push(`style-src 에 ${hash} 없음`);
  for (const source of allowed) if (!needed.includes(source)) problems.push(`style-src 에 쓰이지 않는 ${source}`);
  return problems;
}

/** 스타일 블록을 뺀 마크업. */
function markup(html: string): string {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

/** 태그를 벗긴 글자 — 인라인(span·b·strong·a)은 붙이고, 블록 경계는 공백 하나로. */
function text(html: string): string {
  return markup(html)
    .replace(/<\/?(span|b|strong|a)\b[^>]*>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

interface CssRule {
  readonly selector: string;
  readonly body: string;
}

function cssRules(css: string): CssRule[] {
  return css
    .split('}')
    .map((chunk) => chunk.split('{'))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({ selector: (parts[parts.length - 2] ?? '').trim(), body: parts[parts.length - 1] ?? '' }));
}

/**
 * 색 규칙 — 회색(r=g=b)·흰색만, **주황 없음**(진윤겸 2026-09-29 — `@` 도 글자색을 따른다), 파랑 계열 이름·다른 색 함수 금지. 문제 목록.
 * 마크업 쪽: `.at` 는 `@` 한 글자만 감싸는 구조 표시로만 남고(색 규칙 없음), 어디에도 주황 값이 없다.
 */
function colorProblems(cssIn: string, html: string): string[] {
  const problems: string[] = [];
  // 예외 없음(AI 티 감사 C1, 2026-09-27): 예시 ID 카드의 신원 무늬도 무채색 토큰으로 그린다 — 콘솔의 키 hue(보라-분홍) 예외를 거뒀다.
  // oklch 는 아래 유채색 함수 검사에 그대로 걸린다.
  const css = cssIn;
  // 무채색 밖으로 허용하는 토큰 값 — 폼 오류(danger) 두 벌뿐(랜딩 v2 — 복숭아 카드 없음, 흑백 + 주황 `@`). 토큰 블록 밖에 hex 가
  // 없다는 것은 `site-theme.test.ts` ③ 이 따로 건다 — 여기는 "그 밖의 유채색이 없다" 만 본다.
  const allowed = new Set(
    [SITE_LIGHT, SITE_DARK].map((p) => p.danger.replace('#', '').toLowerCase()),
  );
  for (const m of css.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
    const hex = (m[1] ?? '').toLowerCase();
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    if (allowed.has(full)) continue;
    const [r, g, b] = [0, 2, 4].map((i) => full.slice(i, i + 2));
    if (!(r === g && g === b)) problems.push(`#${hex} 는 회색이 아니다`);
  }
  for (const m of css.matchAll(/rgba?\(([^)]*)\)/gi)) {
    const [r, g, b] = (m[1] ?? '').split(',').map((v) => v.trim());
    if (!(r === g && g === b)) problems.push(`${m[0]} 는 회색이 아니다`);
  }
  if (/\b(blue|navy|teal|cyan|aqua|azure|indigo|royalblue|steelblue|skyblue|dodgerblue|orange|red|green|purple|hsla?\(|oklch|lab\(|lch\(|color-mix)\b/i.test(css)) {
    problems.push('이름 있는 색·색 함수');
  }
  if (/f97316/i.test(css)) problems.push('주황 값이 스타일에 있다');
  const atRules = cssRules(css).filter((r) => /(^|[\s,])\.at(?![-\w])/.test(r.selector) && /color/.test(r.body));
  if (atRules.length > 0) problems.push(`.at 에 색 규칙이 있다: ${JSON.stringify(atRules)}`);
  const m = markup(html);
  if (/f97316/i.test(m)) problems.push('마크업에 주황 값');
  const atSpans = [...m.matchAll(/<span class="at">([^<]*)<\/span>/g)].map((x) => x[1]);
  for (const inner of atSpans) if (inner !== '@') problems.push(`.at 가 "${String(inner)}" 를 감싼다`);
  for (const cls of m.matchAll(/class="([^"]*)"/g)) {
    const names = (cls[1] ?? '').split(/\s+/);
    if (names.includes('at') && cls[1] !== 'at') problems.push(`.at 가 다른 클래스와 섞였다: ${String(cls[1])}`);
  }
  return problems;
}

describe.each(PAGES)('%s — CSP · 마크업', (_name, lang, id, render) => {
  const page = render();

  it('① 닫힌 CSP — default-src none · 스타일은 해시 하나 · 이미지는 같은 오리진 · 폰트는 같은 오리진만 · 스크립트는 해시만(머리 힌트 하나 + 로그인·가입 폼 하나) · 연결은 콘솔 출처 하나', () => {
    // 로그인 화면만 `data-hint="go"` — 로그인한 방문자는 폼 없이 콘솔로(2026-09-30).
    // 홈만 `data-hero` — 머리가 사진 히어로 위에서 시작한다(머리 스크립트가 스크롤로 `at-hero` 를 켜고 끈다).
    expect(page.html.startsWith(`<!doctype html><html lang="${lang}"${id === 'login' ? ' data-hint="go"' : ''}${id === 'home' ? ' data-hero' : ''}>`)).toBe(true);
    expect(cspDirective(page.csp, 'default-src')).toEqual(["'none'"]);
    // 이미지는 파비콘 하나(콘솔 v5 — Firefox 는 파비콘에도 CSP 를 건다) — 같은 오리진 'self' 만. 페이지에 <img> 는 없다(③).
    expect(cspDirective(page.csp, 'img-src')).toEqual(["'self'"]);
    // 자체 호스팅 Pretendard(`/_fonts/…`, `src/ui/fonts.ts`) — 같은 오리진 하나뿐(외부 CDN·data: 없음).
    expect(cspDirective(page.csp, 'font-src')).toEqual(["'self'"]);
    expect(cspDirective(page.csp, 'style-src')).toHaveLength(1);
    expect(cspDirective(page.csp, 'base-uri')).toEqual(["'none'"]);
    expect(cspDirective(page.csp, 'form-action')).toEqual(["'none'"]);
    expect(cspDirective(page.csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(page.csp).not.toMatch(/unsafe-|\*|data:|blob:|nonce-|http:/);
    // 2026-09-30 — 모든 페이지가 머리 힌트 스크립트를 싣는다: 스크립트 해시(첫째는 늘 힌트) · 연결은 콘솔 하나 · Trusted Types 가 전 페이지에.
    const scriptSrc = cspDirective(page.csp, 'script-src') ?? [];
    expect(scriptSrc).toHaveLength(SCRIPTED.has(id) ? 2 : 1);
    for (const source of scriptSrc) expect(source).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
    expect(scriptSrc[0]).toBe(`'sha256-${sha256Base64(HINT)}'`);
    // 새로 열린 출처는 콘솔 하나뿐 — 연결(fetch)만.
    expect(cspDirective(page.csp, 'connect-src')).toEqual([CONSOLE_ORIGIN]);
    expect(page.csp.match(/https:\/\/[^\s;]+/g)).toEqual([CONSOLE_ORIGIN]);
    expect(page.csp).not.toMatch(/http:/);
    expect(cspDirective(page.csp, 'require-trusted-types-for')).toEqual(["'script'"]);
    expect(cspDirective(page.csp, 'trusted-types')).toEqual(["'none'"]);
  });

  it('② 인라인 스타일 블록 하나 — 그 해시가 CSP 에 있고 남는 해시가 없다', () => {
    expect(blocks(page.html, 'style')).toEqual([SITE_CSS]);
    expect(hashProblems(page)).toEqual([]);
  });

  it('③ 스크립트는 머리 힌트 하나(모든 페이지) + 로그인·가입 폼 하나 — 해시가 맞다 · on* 속성·javascript:·style= 없음, CSP 가 조용히 막을 마크업 없음', () => {
    // 예외 하나(SEO — 리드 판정): 색인하는 페이지의 JSON-LD **데이터 블록** 정확히 하나(`type="application/ld+json"` — 실행되지 않아 CSP 대상이
    // 아니다). 색인하지 않는 페이지(로그인·가입·404)에는 없다. 그 하나를 걷어 낸 뒤 나머지 규칙을 그대로 건다.
    const ld = ldBlocks(page.html);
    expect(ld).toHaveLength(id !== 'not-found' && isIndexed(id) ? 1 : 0);
    const html = withoutLd(page.html);
    const m = markup(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const scripts = blocks(html, 'script');
    // 머리 힌트(2026-09-30) — `<head>` 안, 스타일 블록 바로 뒤에 정확히 한 번 · ASCII.
    expect(scripts[0]).toBe(HINT);
    expect(HINT).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
    expect(page.html.split(`<script>${HINT}</script>`)).toHaveLength(2);
    expect(page.html).toContain(`<style>${SITE_CSS}</style><script>${HINT}</script></head>`);
    if (SCRIPTED.has(id)) {
      expect(scripts).toHaveLength(2);
      expect(cspDirective(page.csp, 'script-src')).toEqual([`'sha256-${sha256Base64(scripts[0] ?? '')}'`, `'sha256-${sha256Base64(scripts[1] ?? '')}'`]);
      expect(scripts[1]).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
      // 폼 스크립트는 본문 끝(머리가 아니다).
      expect(page.html.indexOf(`<script>${scripts[1] ?? ''}</script>`)).toBeGreaterThan(page.html.indexOf('</footer>'));
      expect(m).toMatch(/<form id="f" novalidate>/);
      expect(m).not.toMatch(/<form\b[^>]*\s(action|method)=/i);
    } else {
      expect(scripts).toEqual([HINT]);
      expect(cspDirective(page.csp, 'script-src')).toEqual([`'sha256-${sha256Base64(HINT)}'`]);
      expect(m).not.toMatch(/<(form|input)\b/i);
    }
    expect(m).not.toMatch(/<script\b/i);
    expect(m).not.toMatch(/\son[a-z]+\s*=/i);
    expect(m).not.toMatch(/javascript:/i);
    expect(m).not.toMatch(/\sstyle\s*=/i);
    // 이미지 예외(홈 개편 2026-09-29 — 진윤겸 승인): 홈의 사진 세 장(히어로 · 사서함 · 창빛 — 2026-09-30 순서)만 `<img>` 로 싣는다 — 같은 출처 `/img/<해시>/…`
    // `srcset`(폭 기술자)·`sizes`·크기·alt(언어별)·decoding 명시, 히어로만 `fetchpriority="high"`, 나머지는 `loading="lazy"`. 그 밖의 페이지·요소에는
    // `<img>`·`<source>`·`src=` 가 없다.
    const photo = /<img src="([^"]+)" srcset="([^"]+)" sizes="[^"]+" width="(\d+)" height="(\d+)" alt="([^"]+)" decoding="async" (fetchpriority="high"|loading="lazy")>/g;
    const photos = [...m.matchAll(photo)];
    if (id === 'home') {
      const expected = [
        ['desk-window', 'heroAlt', 'fetchpriority="high"'],
        ['post-boxes', 'splitAlt', 'loading="lazy"'],
        ['window-light', 'getAlt', 'loading="lazy"'],
      ] as const;
      expect(photos).toHaveLength(expected.length);
      expected.forEach(([name, altKey, load], i) => {
        const set = SITE_PHOTOS[name];
        const shot = photos[i];
        expect(shot?.[1]).toBe(set[0]?.path);
        expect(shot?.[2]).toBe(set.map((p) => `${p.path} ${String(p.width)}w`).join(', '));
        expect([Number(shot?.[3]), Number(shot?.[4])]).toEqual([set[0]?.width, set[0]?.height]);
        expect(shot?.[5]).toBe(HOME_COPY[lang][altKey]);
        expect(shot?.[6]).toBe(load);
      });
    } else {
      expect(photos).toEqual([]);
    }
    const rest = m.replace(photo, '');
    expect(rest).not.toMatch(/<(img|iframe|object|embed|base|video|audio|source|picture|meta\s+http-equiv)\b/i);
    // <link> 는 hreflang 대안·canonical(리소스를 가져오지 않는다)과 **정확히 이 아이콘 묶음 한 번**(ICO · SVG · apple-touch-icon — 해시 경로,
    // 2026-09-30)뿐 — stylesheet·preload 없음.
    const icons = [...FAVICON_LINK.matchAll(/<link\b[^>]*>/gi)].map((l) => l[0]);
    expect(icons).toEqual([
      `<link rel="icon" href="${FAVICON_ICO_PATH}" sizes="32x32">`,
      `<link rel="icon" href="${FAVICON_SVG_PATH}" type="image/svg+xml">`,
      `<link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON_PATH}">`,
    ]);
    expect(m.split(FAVICON_LINK)).toHaveLength(2);
    const links = [...m.matchAll(/<link\b[^>]*>/gi)].map((l) => l[0]);
    for (const icon of icons) expect(links.filter((l) => l === icon)).toHaveLength(1);
    for (const link of links.filter((l) => !icons.includes(l))) expect(link).toMatch(/^<link rel="(alternate" hreflang="(ko|en|x-default)|canonical)" href="https:\/\/atmark\.ai[^"]*">$/);
    expect(rest).not.toMatch(/\b(src|srcset)\s*=/i);
  });

  it('④ 외부 URL 없음 — 절대 URL 은 atmark.ai 대안 링크 · 머리 힌트(콘솔 힌트 API · 콘솔 상수) · 머리의 콘솔 링크(와 로그인·가입 스크립트의 콘솔 API·코드 verify·성공 뒤 콘솔 상수)뿐, href 는 허용 목록 안', () => {
    // 모든 페이지(2026-09-30): 머리 힌트 스크립트의 힌트 API · 로그인 화면에서 옮겨 갈 콘솔 상수 · 로그인한 방문자에게만 보이는 머리의 콘솔 링크.
    const allowedAbsolute = new Set<string>([`${CONSOLE_ORIGIN}/api/session/hint`, `${CONSOLE_ORIGIN}/app`]);
    if (id === 'login') allowedAbsolute.add(`${CONSOLE_ORIGIN}/api/login`);
    if (id === 'signup') allowedAbsolute.add(`${CONSOLE_ORIGIN}/api/signup`);
    if (id === 'waitlist') allowedAbsolute.add(`${CONSOLE_ORIGIN}/api/waitlist`);
    // 메일의 6자리 코드(2026-09-28) — 같은 화면의 코드 verify 와, 성공 뒤 가는 콘솔 상수 둘.
    if (id === 'login') allowedAbsolute.add(`${CONSOLE_ORIGIN}/api/login/verify`);
    if (id === 'signup') allowedAbsolute.add(`${CONSOLE_ORIGIN}/api/signup/verify`);
    if (id === 'login' || id === 'signup') for (const u of [`${CONSOLE_ORIGIN}/app`, `${CONSOLE_ORIGIN}/app#/select-org`]) allowedAbsolute.add(u);
    if (id !== 'not-found') for (const l of ['ko', 'en'] as const) allowedAbsolute.add(`${SITE_ORIGIN}${sitePath(l, id)}`);
    // 링크 미리보기(OG·Twitter — 자기 언어의 `/og/<해시>/<lang>.png`)와 구조화 데이터(schema.org 문맥 · 조직·웹사이트 id · 홈 URL · 로고 = 파비콘).
    // 둘 다 가져오는 리소스가 아니다(크롤러가 읽는 값). 404 에는 없다.
    if (id !== 'not-found') allowedAbsolute.add(`${SITE_ORIGIN}/og/${OG_IMAGES[lang].hash}/${lang}.png`);
    // 머리 주 메뉴·꼬리의 사용자 문서 링크(docs.atmark.ai, 같은 언어) — 링크일 뿐 가져오는 리소스가 아니다.
    allowedAbsolute.add(docsUrl(lang));
    // 홈 "직접 확인해 보세요" 끝의 확인 절차 문서 링크.
    if (id === 'home') allowedAbsolute.add(`${docsUrl(lang)}/identity/verify`);
    // 대기자 명단의 보류 안내(202609301530) — 문서 "Atmark가 맞지 않는 용도"(한국어 /get-started/not-for · 영어 /en/get-started/not-for).
    if (id === 'waitlist') allowedAbsolute.add(`${docsUrl(lang)}/get-started/not-for`);
    // 사용 예시(2026-10-01) — 쓰임새마다 문서의 시작 링크 + 맨 아래 "하면 안 되는 일".
    if (id === 'use-cases') for (const u of [...USE_CASES.map((uc) => useCaseDocsHref(uc, lang)), `${docsUrl(lang)}/get-started/not-for`]) allowedAbsolute.add(u);
    // 남용 신고(게이트 B 2026-10-01) — 규칙 문장의 "Atmark로 하면 안 되는 일".
    if (id === 'abuse') allowedAbsolute.add(`${docsUrl(lang)}/get-started/not-for`);
    if (id !== 'not-found' && isIndexed(id)) {
      for (const u of ['https://schema.org', `${SITE_ORIGIN}/`, `${SITE_ORIGIN}/#organization`, `${SITE_ORIGIN}/favicon.svg`]) allowedAbsolute.add(u);
      if (id === 'home') allowedAbsolute.add(`${SITE_ORIGIN}/#website`);
      if (id === 'pricing') allowedAbsolute.add(`${SITE_ORIGIN}${sitePath(lang, 'pricing')}`);
    }
    const urls = [...page.html.matchAll(/\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>]*/gi)].map((m) => m[0]);
    for (const url of urls) expect(allowedAbsolute.has(url), url).toBe(true);
    const allowedHrefs = new Set<string>([
      ...(id === 'not-found' ? [] : [`${SITE_ORIGIN}${sitePath('ko', id)}`, `${SITE_ORIGIN}${sitePath('en', id)}`]),
      sitePath(lang, 'home'),
      sitePath(lang, 'pricing'),
      sitePath(lang, 'refund'),
      sitePath(lang, 'privacy'),
      sitePath(lang, 'terms'),
      sitePath(lang, 'login'),
      sitePath(lang, 'signup'),
      sitePath(lang, 'waitlist'), // 머리의 주 버튼 · 로그인·가입 화면의 대기자 명단 링크(202609301520)
      sitePath(lang, 'use-cases'), // 머리·꼬리의 사용 예시(2026-10-01)
      sitePath(lang, 'changelog'), // 꼬리 제품 열의 변경 내역(게이트 B 2026-10-01)
      sitePath(lang, 'abuse'), // 꼬리 안내 열의 남용 신고(게이트 B 2026-10-01)
      ...(BLOG_NAV[lang] === null ? [] : [BLOG_NAV[lang].href]), // 머리·꼬리의 블로그(공개 글이 있을 때만 — 2026-10-01)
      ...(id === 'home' ? USE_CASES.slice(0, 3).map((uc) => `${sitePath(lang, 'use-cases')}#${uc.id}`) : []), // 홈 작동 방식 절의 카드 셋
      switchHref(OTHER_LANG[lang], id), // 언어 전환(`?hl=` — 2026-09-30)
      `${CONSOLE_ORIGIN}/app`, // 머리의 콘솔 링크(로그인했을 때만 보인다 — 2026-09-30)
      // 꼬리의 홈 절 링크(신원 · 작동 방식) — 같은 사이트 같은 언어의 홈 안 앵커(명세 §5.2). 머리에서는 빠졌다(2026-10-01).
      `${sitePath(lang, 'home')}#get-title`,
      `${sitePath(lang, 'home')}#how-title`,
      '#main',
      // 아이콘 묶음(해시 경로 셋 — 2026-09-30).
      FAVICON_ICO_PATH,
      FAVICON_SVG_PATH,
      APPLE_TOUCH_ICON_PATH,
      docsUrl(lang), // 사용자 문서(같은 언어)
      ...(id === 'home' ? [`${docsUrl(lang)}/identity/verify`] : []), // 홈 "직접 확인" 끝의 확인 절차 문서
      ...(id === 'waitlist' ? [`${docsUrl(lang)}/get-started/not-for`] : []), // 대기자 명단 보류 안내(202609301530)
      ...(id === 'use-cases' ? [...USE_CASES.map((uc) => useCaseDocsHref(uc, lang)), `${docsUrl(lang)}/get-started/not-for`] : []),
      // 남용 신고 — 신고 주소 둘(수신 전용 역할 주소)과 규칙 문서.
      ...(id === 'abuse' ? ['mailto:abuse@atmark.ai', 'mailto:postmaster@atmark.ai', `${docsUrl(lang)}/get-started/not-for`] : []),
    ]);
    if (CONTACT_EMAIL !== null) allowedHrefs.add(`mailto:${CONTACT_EMAIL}`);
    for (const m of page.html.matchAll(/\shref="([^"]*)"/g)) {
      const href = m[1] ?? '';
      if (href.startsWith('#') && (id === 'privacy' || id === 'terms')) continue; // 목차 앵커(같은 문서) — 아래에서 대상 id 가 있는지 본다
      expect(allowedHrefs.has(href), href).toBe(true);
    }
    // 목차 앵커는 문서 안의 id 를 가리킨다.
    for (const m of page.html.matchAll(/\shref="#([^"]+)"/g)) expect(page.html).toContain(`id="${m[1] ?? ''}"`);
    // 콘솔로 가는 링크는 머리의 "콘솔" 하나뿐(로그인했을 때만 보인다 — `.si`, 2026-09-30) — 로그인·가입은 이 사이트의 이 언어 경로(US-003).
    // 콘솔 URL 은 머리 힌트의 fetch 하나 · 옮겨 갈 콘솔 상수, 그 링크, 로그인·가입 스크립트의 fetch 둘(요청 · 코드 verify, 2026-09-28)과 코드가
    // 맞은 뒤 가는 콘솔 상수 둘뿐.
    const consoleHrefs = [...page.html.matchAll(/<a\b[^>]*href="https:\/\/console\.atmark\.ai[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(consoleHrefs).toEqual([`<a class="btn sm si con" href="${CONSOLE_ORIGIN}/app">`]);
    const consoleUrls = [...page.html.matchAll(/https:\/\/console\.atmark\.ai[^'"\s<]*/g)].map((m) => m[0]);
    expect(consoleUrls).toEqual([
      `${CONSOLE_ORIGIN}/api/session/hint`,
      `${CONSOLE_ORIGIN}/app`,
      `${CONSOLE_ORIGIN}/app`,
      // 대기자 명단(202609301520) — 등록 fetch 하나(코드 verify · 콘솔로 옮겨 가기 없음).
      ...(id === 'waitlist'
        ? [`${CONSOLE_ORIGIN}/api/waitlist`]
        : SCRIPTED.has(id)
          ? [`${CONSOLE_ORIGIN}/api/${id}`, `${CONSOLE_ORIGIN}/api/${id}/verify`, `${CONSOLE_ORIGIN}/app#/select-org`, `${CONSOLE_ORIGIN}/app`]
          : []),
    ]);
  });

  it('④-머리 — 주 메뉴는 사용 예시 · 요금제 · 문서 · 블로그(공개 글이 있을 때만), 오른쪽은 로그인 · 대기자 명단(로그인했으면 콘솔) — 진윤겸 2026-10-01', () => {
    const c = CHROME_COPY[lang];
    const blog = BLOG_NAV[lang];
    const main = /<nav class="nav-main" aria-label="[^"]+">([\s\S]*?)<\/nav>/.exec(page.html)?.[1] ?? '';
    const names = [...main.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
    expect(names).toEqual([c['useCases'], c['pricing'], c['docs'], ...(blog === null ? [] : [c['blog']])]);
    expect(main).not.toContain('#get-title');
    expect(main).not.toContain('#how-title');
    const acct = /<nav class="nav acct" aria-label="[^"]+">([\s\S]*?)<\/nav>/.exec(page.html)?.[1] ?? '';
    expect([...acct.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].map((m) => m[1])).toEqual([c['login'], c['waitlist'], c['console']]);
    // 서랍은 주 메뉴와 같은 링크 + 로그인 + 언어.
    const drawer = /<nav class="mnav-p" id="mnav-p" popover aria-label="[^"]+">([\s\S]*?)<\/nav>/.exec(page.html)?.[1] ?? '';
    expect([...drawer.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].map((m) => m[1])).toEqual([...names, c['login'], c['switchTo']]);
    // 꼬리의 제품 열에는 홈 절 둘이 남는다.
    const foot = page.html.slice(page.html.indexOf('<footer class="foot">'));
    expect(foot).toContain(`<a href="${sitePath(lang, 'home')}#get-title">${c['navGet'] ?? ''}</a>`);
    expect(foot).toContain(`<a href="${sitePath(lang, 'home')}#how-title">${c['navHow'] ?? ''}</a>`);
  });

  it('④-언어 — hreflang 쌍(ko·en·x-default=en)·canonical · 보이는 언어 전환 링크(반대 언어의 같은 페이지 + ?hl=)', () => {
    const other = OTHER_LANG[lang];
    // 2026-09-30 — 영어가 기본(접두어 없음), 한국어는 /kr. 전환 링크는 `?hl=<언어>` 를 붙인다(엣지가 선택 쿠키를 적는다).
    const target = switchHref(other, id);
    expect(target).toBe(`${other === 'ko' ? (id === 'home' || id === 'not-found' ? '/kr' : `/kr/${id}`) : id === 'home' || id === 'not-found' ? '/' : `/${id}`}?hl=${other}`);
    const switchLabel = CHROME_COPY[lang]['switchTo'] ?? '';
    // 머리 정리(진윤겸 2026-10-01): 넓은 화면의 머리에는 언어 전환이 없다 — 꼬리의 안내 열 하나와 ≡ 서랍 맨 아래 하나(휴대폰에선 꼬리가 멀다).
    expect(page.html).not.toContain('class="plain lang"');
    const top = page.html.slice(page.html.indexOf('<header class="top">'), page.html.indexOf('</header>'));
    const drawerAt = top.indexOf('<nav class="mnav-p"');
    expect(top.slice(0, drawerAt)).not.toContain('?hl=');
    // 서랍: 주 메뉴 · 로그인 · 언어(맨 아래).
    expect(top.slice(drawerAt).endsWith(`<a class="plain so" href="${sitePath(lang, 'login')}">${CHROME_COPY[lang]['login'] ?? ''}</a><a class="lang" href="${target}" hreflang="${other}" lang="${other}">${switchLabel}</a></nav>`)).toBe(true);
    const foot = page.html.slice(page.html.indexOf('<footer class="foot">'));
    expect(foot.split(`<a href="${target}" hreflang="${other}" lang="${other}">${switchLabel}</a>`)).toHaveLength(2);
    expect(switchLabel).toBe(lang === 'ko' ? 'English' : '한국어');
    if (id === 'not-found') {
      expect(page.html).not.toMatch(/rel="(alternate|canonical)"/);
      return;
    }
    expect(page.html).toContain(`<link rel="canonical" href="${SITE_ORIGIN}${sitePath(lang, id)}">`);
    expect(page.html).toContain(`<link rel="alternate" hreflang="ko" href="${SITE_ORIGIN}${sitePath('ko', id)}">`);
    expect(page.html).toContain(`<link rel="alternate" hreflang="en" href="${SITE_ORIGIN}${sitePath('en', id)}">`);
    expect(page.html).toContain(`<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${sitePath('en', id)}">`);
    expect(`${SITE_ORIGIN}${sitePath('en', id)}`).toBe(id === 'home' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}/${id}`);
    expect(`${SITE_ORIGIN}${sitePath('ko', id)}`).toBe(id === 'home' ? `${SITE_ORIGIN}/kr` : `${SITE_ORIGIN}/kr/${id}`);
    // 쌍 — 반대 언어 페이지도 똑같은 대안 묶음을 싣는다.
    const alternates = (html: string): string[] => [...html.matchAll(/<link rel="alternate"[^>]*>/g)].map((m) => m[0]);
    expect(alternates(RENDER[id](other).html)).toEqual(alternates(page.html));
  });

  it('④-누수 — 반대 언어 문구가 새지 않는다(영어 페이지엔 전환 링크 밖 한글 0, 한국어 페이지엔 영어 문구 샘플 0)', () => {
    const t = text(page.html.replace(/<a [^>]*hreflang="ko"[^>]*>한국어<\/a>/g, ''));
    if (lang === 'en') {
      expect(t.match(/[\u3131-\u318e\uac00-\ud7a3]+/g)).toBeNull();
    } else {
      for (const phrase of ['Get started', 'Log in', 'Privacy Notice', 'Terms of Service', 'How it works', 'Skip to content', 'Page not found', 'Effective ']) {
        expect(t).not.toContain(phrase);
      }
      for (const key of ['h1', 'k2Title', 'bandTitle']) expect(page.html).not.toContain(HOME_COPY.en[key] ?? '∅');
    }
  });

  it('⑤ 스타일은 ASCII 만 · 색 규칙(회색만 — `@` 도 글자색) · 공통 머리·꼬리(로고·약관 링크·CTA)', () => {
    const c = CHROME_COPY[lang];
    expect(SITE_CSS).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
    expect(colorProblems(SITE_CSS, page.html)).toEqual([]);
    expect(page.html).toContain(`<a class="logo" href="${sitePath(lang, 'home')}" aria-label="${c['homeLabel'] ?? ''}">${LOGO_TEXT}</a>`);
    expect(page.html).toContain(`<a href="${sitePath(lang, 'privacy')}">${c['privacy'] ?? ''}</a>`);
    expect(page.html).toContain(`<a href="${sitePath(lang, 'terms')}">${c['terms'] ?? ''}</a>`);
    // 가격·환불 링크(Paddle 웹사이트 심사) — 두 언어 모두, 꼬리의 내비(제품·안내 두 열) 안에.
    const foot = /<footer class="foot">[\s\S]*<\/footer>/.exec(page.html)?.[0] ?? '';
    const legalNav = [...foot.matchAll(/<nav aria-label="[^"]*">([\s\S]*?)<\/nav>/g)].map((n) => n[1] ?? '').join('');
    expect(legalNav).toContain(pricingNavLink(lang));
    expect(legalNav).toContain(`<a href="${sitePath(lang, 'refund')}">${c['refund'] ?? ''}</a>`);
    // 2026-09-30 — 영어가 기본(접두어 없음), 한국어는 /kr.
    expect(sitePath(lang, 'pricing')).toBe(lang === 'en' ? '/pricing' : '/kr/pricing');
    expect(sitePath(lang, 'refund')).toBe(lang === 'en' ? '/refund' : '/kr/refund');
    // 머리 왼쪽 무리 — 로고뿐. 로그인했을 때만 보이는 콘솔 링크(`.si`)는 오른쪽 계정 메뉴의 끝, "시작하기" 자리(진윤겸 2026-09-30).
    expect(page.html).toContain(
      `<div class="wrap bar bar3"><div class="bar-l"><a class="logo" href="${sitePath(lang, 'home')}" aria-label="${c['homeLabel'] ?? ''}">${LOGO_TEXT}</a></div>`,
    );
    expect(page.html).toContain(`<a class="btn sm si con" href="${CONSOLE_ORIGIN}/app">${c['console'] ?? ''}</a></nav>`);
    expect(c['console']).toBe(lang === 'en' ? 'Console' : '콘솔');
    // 머리의 주 버튼 — 대기자 명단(202609301520, 가입은 초대로만). 대기자 명단 페이지 자신에서는 현재 표시 + 보조 모양(비평 R10-13), 나머지는
    //   주 버튼. 로그아웃일 때만 보인다(`.so`).
    expect(page.html).toContain(
      id === 'waitlist'
        ? `<a class="btn sm ghost so" href="${sitePath(lang, 'waitlist')}" aria-current="page">${c['waitlist'] ?? ''}</a>`
        : `<a class="btn sm so" href="${sitePath(lang, 'waitlist')}">${c['waitlist'] ?? ''}</a>`,
    );
    expect(c['waitlist']).toBe(lang === 'en' ? 'Join the waitlist' : '대기자 명단');
    // 로그인 — 머리(로그인 화면에서는 현재 표시)와 모바일 메뉴, 둘 다 `.so`.
    expect(page.html).toContain(`<a class="plain so" href="${sitePath(lang, 'login')}"${id === 'login' ? ' aria-current="page"' : ''}>${c['login'] ?? ''}</a>`);
    expect(page.html.split(`<a class="plain so" href="${sitePath(lang, 'login')}">${c['login'] ?? ''}</a>`)).toHaveLength(id === 'login' ? 2 : 3);
    expect(sitePath(lang, 'login')).toBe(lang === 'en' ? '/login' : '/kr/login');
    expect(sitePath(lang, 'signup')).toBe(lang === 'en' ? '/signup' : '/kr/signup');
    // 꼬리의 브랜드 칸은 로고뿐 — 옛 소개 문장(footNote)은 없다.
    expect(c['footNote']).toBeUndefined();
    expect(foot).toContain(`<div class="fbrand"><a class="logo" href="${sitePath(lang, 'home')}" aria-label="${c['homeLabel'] ?? ''}">${LOGO_TEXT}</a></div>`);
    expect(foot).not.toMatch(/Atmark는 AI 에이전트에게 신원과 이메일 주소를 발급합니다|Atmark is in beta\. An identity of its own/);
  });

  it('⑥ 과장 금지 — 인증·가용성 수치·평생 문구가 없고, 가격·무료 문구는 가격·환불 페이지에만(꼬리의 "요금제" 링크 이름은 제외)', () => {
    const html = withoutPricingNav(page.html, lang);
    if (id === 'terms') expect(html).toMatch(TERMS_BILLING_ARTICLE);
    if (id === 'terms') expect(html.match(new RegExp(TERMS_BILLING_TOC, 'g')) ?? []).toHaveLength(1);
    const t = text(id === 'terms' ? html.replace(TERMS_BILLING_ARTICLE, '').replace(TERMS_BILLING_TOC, '') : html);
    expect(t).not.toMatch(/SOC ?2|ISO ?27001|HIPAA|GDPR|평생|forever|99\.9|\bSLA\b|보장합니다|guarantee/i);
    if (!PRICED.has(id)) expect(t).not.toMatch(/무료|\bfree\b|가격|요금제|pricing|₩|\$\d|\d+\s*원/i);
  });
});

describe('스타일 — 파란 기본값을 덮는다', () => {
  it('⑦ 링크(방문 포함)·포커스 링·선택 영역·탭 하이라이트·accent', () => {
    expect(SITE_CSS).toContain('a,a:visited{color:inherit');
    expect(SITE_CSS).toContain(':focus-visible{outline:2px solid var(--focus-ring)');
    expect(SITE_CSS).toContain('::selection{background:var(--gray-1000);color:var(--background-100)}');
    expect(SITE_CSS).toContain('-webkit-tap-highlight-color:transparent');
    expect(SITE_CSS).toContain('accent-color:var(--gray-1000)');
    // 글꼴 스택은 공통 비색상 토큰(`--font-sans`, 콘솔과 같은 문자열 — 명세 §1.2)에 있고 본문이 그것을 쓴다.
    expect(SITE_CSS).toContain('--font-sans:"Pretendard Variable","Pretendard",');
    expect(SITE_CSS).toMatch(/body\{[^}]*font-family:var\(--font-sans\)/);
    expect(SITE_CSS).not.toMatch(/@import/i);
    // `url(` 은 `@font-face` 의 같은 오리진 폰트 경로뿐이다(외부·data: 없음) — 그 경로가 실제로 있는지는 `test/unit/ui/fonts.test.ts`.
    const urls = [...SITE_CSS.matchAll(/url\(([^)]*)\)/gi)].map((m) => m[1] ?? '');
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((u) => !/^\/_fonts\/[0-9a-f]{10}\/[A-Za-z0-9.-]+\.woff2$/.test(u))).toEqual([]);
  });
});

describe('검사기는 공허하지 않다', () => {
  const home = renderHomePage('ko');

  it('⑧ 스타일 한 글자·주황 누수·파란 링크·`.at` 오용을 잡는다', () => {
    const tampered = { html: home.html.replace('.ico{display:inline-block', '.ico{display:inline-block '), csp: home.csp };
    expect(hashProblems(tampered).length).toBeGreaterThan(0);
    expect(colorProblems(`${SITE_CSS}.logo{color:#F97316}`, home.html).length).toBeGreaterThan(0);
    // 주황 폐지(2026-09-29) — `.at` 에 다시 색을 입히면(옛 규칙 그대로라도) 잡는다.
    expect(colorProblems(`${SITE_CSS}.at{color:#F97316}`, home.html).length).toBeGreaterThan(0);
    expect(colorProblems(`${SITE_CSS}.addr .at{color:#171717}`, home.html).length).toBeGreaterThan(0);
    expect(colorProblems(SITE_CSS, home.html.replace('</main>', '<p>#F97316</p></main>')).length).toBeGreaterThan(0);
    expect(colorProblems(SITE_CSS.replace('a,a:visited{color:inherit', 'a,a:visited{color:#0000EE'), home.html).length).toBeGreaterThan(0);
    expect(colorProblems(`${SITE_CSS}a:focus{outline-color:dodgerblue}`, home.html).length).toBeGreaterThan(0);
    expect(colorProblems(SITE_CSS, home.html.replace('<span class="at">@</span>atmark.ai', '<span class="at">@a</span>tmark.ai')).length).toBeGreaterThan(0);
    expect(colorProblems(SITE_CSS, home.html.replace('<h1 ', '<h1 class="at big" ')).length).toBeGreaterThan(0);
    // oklch 예외는 없다 — 신원 카드 규칙 안이라도 유채색이면 잡는다. 예시 무늬는 평면 회색 바탕 + 잉크 선(토큰).
    expect(colorProblems(`${SITE_CSS}.logo{color:oklch(60% .1 var(--h))}`, home.html).length).toBeGreaterThan(0);
    expect(colorProblems(`${SITE_CSS}.idc .x{color:oklch(60% .1 var(--h))}`, home.html).length).toBeGreaterThan(0);
    expect(SITE_CSS).not.toMatch(/oklch|linear-gradient\(160deg/);
    expect(SITE_CSS).toMatch(/\.idc \.idc-art\{[^}]*background:var\(--background-200\)/);
    expect(SITE_CSS).toContain('.idc-svg .rl{fill:none;stroke:var(--gray-1000)');
  });
});

describe('내용 — 홈', () => {
  const html = renderHomePage('ko').html;
  const t = text(html);
  /** 화면에 보이는 글자 — JSON-LD(FAQPage 가 FAQ 답을 한 번 더 싣는다)와 스크립트를 뺀다. */
  const visible = (h: string): string => text(withoutLd(h).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
  /** 두 겹 방어 절(⑤-2)을 걷어 낸 HTML. */
  const DEFENSE_SECTION = /<section class="sec def" aria-labelledby="def-title">[\s\S]*?<\/section>/;
  const withoutDefense = (h: string): string => h.replace(DEFENSE_SECTION, '');

  it('⑨ 히어로(사진·헤드라인·신원 카드와 유리 메일 카드)·분리·네 기둥·신원 카드와 사실 셋·증거 셋·FAQ 다섯·CTA', () => {
    // 홈 2차 개편(2026-09-30): 에이전트에게 자기만의 이메일을.
    expect(t).toContain('에이전트에게, 자기만의 이메일을.');
    expect(html).toContain('<h1 id="hero-title">에이전트에게,<br>자기만의 이메일을.</h1>');
    // 서브 한 줄 — 주소의 로컬파트가 에이전트 이름으로 바뀐다(예약 로컬파트). 화면 읽기에는 첫 주소 하나.
    expect(html).toContain(`당신의 받은편지함과 섞이지 않는 <span class="addr rot"><span class="sr">${HERO_AGENT_NAMES[0]}@atmark.ai</span>`);
    for (const name of HERO_AGENT_NAMES) expect(html).toContain(`>${name}</span>`);
    // 무대 — 가운데 신원 카드(앞면) + 둘레의 유리 메일 카드 넷(받은 인증 코드 · 정책이 허용한 발송 · 답장 · 기록). 예시 상대는 example.com 뿐.
    expect(html).toMatch(
      /<figure class="stage" aria-label="[^"]+">[\s\S]*?<div class="idc front hero-id">[\s\S]*?<div class="glass m m1">[\s\S]*?<div class="glass m m2">[\s\S]*?<div class="glass m m3">[\s\S]*?<div class="glass m m4">[\s\S]*?<\/figure>/,
    );
    expect(html.match(/<div class="glass m m[1-4]">/g)).toHaveLength(4);
    for (const needle of ['482 913', 'verify@example.com', 'team@example.com', 'partner@example.com', '정책 허용', '해시 체인에 이어짐']) expect(t).toContain(needle);
    // 순서: 히어로(사진 + 무대) → 분리(사서함 사진 + 받은편지함 둘) → 작동 방식(네 기둥 — 진윤겸 2026-09-30 위로) → 받는 사람의 받은편지함 → 신원 카드(창빛 사진 + 카드 앞·뒤 + 사실 셋) → 증거(어두운 띠)
    // → FAQ → 끝 CTA.
    const order = [
      'class="hero-media"',
      '<figure class="stage"',
      'id="split-title"',
      'id="def-title"',
      '<figure class="df-fig"',
      '<ol class="layers">',
      'id="how-title"',
      '<ol class="pillars">',
      'id="bridge-title"',
      'id="get-title"',
      '<figure class="deck"',
      '<ul class="facts">',
      'id="proof-title"',
      'id="faq-title"',
      'id="start-title"',
    ];
    const at = order.map((needle) => html.indexOf(needle));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // 분리 — 당신 · 에이전트, 받은편지함 둘.
    expect(html).toContain('<h2 id="split-title">에이전트 메일은<br>에이전트 주소로.</h2>');
    expect(html).toContain('<div class="box you"><p class="bh"><span>당신</span><span class="addr">you@example.com</span></p>');
    expect(html).toContain('<div class="box agent"><p class="bh"><span>에이전트</span><span class="addr">scout<span class="at">@</span>atmark.ai</span></p>');
    // 네 기둥 — 칸마다 인라인 SVG 그림 하나 + 제목 + 한 줄.
    const pillars = /<ol class="pillars">([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '';
    expect(pillars.match(/<li class="pl rv">/g)).toHaveLength(4);
    expect(pillars.match(/<svg class="il il-[a-z]+" viewBox="0 0 240 160" aria-hidden="true" focusable="false">/g)).toHaveLength(4);
    for (const heading of ['자기 주소', '서명된 신원', '변조 흔적이 남는 기록', '스위치 하나로 관리']) expect(pillars).toContain(`<h3>${heading}</h3>`);
    // 신원 카드 — 앞·뒤(캡션 없음) · 사실 셋.
    const deck = /<figure class="deck"[\s\S]*?<\/figure>/.exec(html)?.[0] ?? '';
    expect(deck).toContain('<div class="idc front">');
    expect(deck).toContain('<div class="idc back">');
    expect(deck).not.toContain('<figcaption');
    const facts = /<ul class="facts">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
    expect(facts.match(/<li class="rv">/g)).toHaveLength(3);
    for (const heading of ['게시하면 누구나 조회', '에이전트 키로 서명, 90일 유효', '콘솔에서 게시하고 멈춤']) expect(facts).toContain(`<h3>${heading}</h3>`);
    // 증거 셋 — 그림 · 쉬운 말 제목 · 한두 문장 · "여기서 확인" 코드 칩, 끝에 확인 절차 문서 링크(2026-09-30).
    expect(html.match(/<li class="proof rv"><div class="pf-fig">[\s\S]*?<\/div><h3>[^<]+<\/h3><p>[^<]+<\/p><div class="pw"><span class="pl-k">여기서 확인<\/span><code class="pc">[^<]+<\/code><\/div><\/li>/g)).toHaveLength(3);
    for (const heading of ['누구의 에이전트인지', '신분증이 진짜인지', '기록이 고쳐지지 않았는지']) expect(html).toContain(`<h3>${heading}</h3>`);
    expect(html).toContain('확인하는 방법 자세히 보기');
    // FAQ 다섯(운영자 질문은 뺐다 — 2026-09-30).
    expect(html.match(/<details><summary><h3>/g)).toHaveLength(5);
    expect(html).not.toContain('누가 Atmark를 운영하나요?');
    // 끝 CTA — 제목 한 줄뿐(본문 없음).
    expect(html).toMatch(/<section class="cta" aria-labelledby="start-title"><div class="cta-card rv"><h2 id="start-title">첫 에이전트 이메일을 만들어 보세요\.<\/h2><div class="actions center">/);
    // 뺀 것: 베타 한 줄 · 단계 · "메일이 나가기까지"(관문 표본) · 받는 것 다섯 · 띠 본문.
    for (const gone of ['id="does-title"', 'class="steps"', '<li class="get">', '<figure class="specimen"', 'class="fine"']) expect(html).not.toContain(gone);
    for (const key of ['fine', 'bandBody', 's1Title', 'd1Title', 'g1Title', 'q6', 'a6']) expect(HOME_COPY.ko[key], key).toBeUndefined();
    // 시작하기(가입) CTA 와 보조 링크(문서)가 히어로와 끝 CTA 둘에 있다. 로그인은 머리(넓은 화면)·메뉴(좁은 화면)에.
    expect(html.split(`<a class="btn" href="/kr/waitlist">대기자 명단 ${ARROW_RIGHT_ICON}</a>`).length - 1).toBe(2);
    expect(html.split(`<a class="btn ghost" href="${docsUrl('ko')}">문서 보기</a>`).length - 1).toBe(2);
    expect(html.split('<a class="plain so" href="/kr/login">로그인</a>').length - 1).toBe(2);
  });

  it('⑨-짧게 — 헤드라인 일곱 어절 이하 · 서브 한 문장 · 기둥 제목 여덟 어절·본문 스무 어절 이하 · 사실·증거 제목 여덟 어절 이하', () => {
    const words = (s: string): number => s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').trim().split(/\s+/).length;
    const sentences = (s: string): number => s.replace(/<[^>]+>/g, '').split(/[.!?](\s|$)/).filter((x) => x !== undefined && x.trim() !== '').length;
    for (const lang of ['ko', 'en'] as const) {
      const c = HOME_COPY[lang];
      expect(words(c['h1'] ?? ''), `${lang} h1`).toBeLessThanOrEqual(7);
      expect(sentences(c['lede'] ?? ''), `${lang} lede`).toBe(1);
      for (const key of ['k1', 'k2', 'k3', 'k4']) {
        expect(c[`${key}Title`], `${lang} ${key}Title`).toBeTruthy();
        expect(c[`${key}Body`], `${lang} ${key}Body`).toBeTruthy();
        expect(words(c[`${key}Title`] ?? ''), `${lang} ${key}Title`).toBeLessThanOrEqual(8);
        expect(words(c[`${key}Body`] ?? ''), `${lang} ${key}Body`).toBeLessThanOrEqual(20);
      }
      for (const key of ['f1', 'f2', 'f3', 'p1', 'p2', 'p3']) {
        expect(c[`${key}Title`], `${lang} ${key}Title`).toBeTruthy();
        expect(words(c[`${key}Title`] ?? ''), `${lang} ${key}Title`).toBeLessThanOrEqual(8);
      }
      // 사실은 제목만. 증거는 무엇을 확인하는지 두 문장 이내(진윤겸 2026-09-30 — "뭐가 뭔지 모르겠다").
      for (const key of ['f1', 'f2', 'f3']) expect(c[`${key}Body`], `${lang} ${key}Body`).toBeUndefined();
      for (const key of ['p1', 'p2', 'p3']) {
        expect(c[`${key}Body`], `${lang} ${key}Body`).toBeTruthy();
        expect(words(c[`${key}Body`] ?? ''), `${lang} ${key}Body`).toBeLessThanOrEqual(32);
      }
    }
  });

  it('⑩ 대기자 명단 초대 · 바로 활성 · 베타는 운영자 초대 — FAQ 마지막 답(a5)에만 한 번씩(2026-10-01)', () => {
    // 두 겹 방어 절(2026-10-07)의 "베타" 머리표는 다른 사실(AI 의심 메일 감시가 베타)이다 — 그 절을 걷어 내고 센다(그 절 안의 한 번은 아래 ⑫ 가 본다).
    const v = visible(withoutDefense(html));
    const a5 = HOME_COPY.ko['a5'] ?? '';
    expect(a5).toContain('베타');
    expect(a5).toContain('가입은 대기자 명단의 초대로 받습니다.');
    expect(a5).toContain('조직이 바로 활성이 되어');
    // 같은 사실은 화면에 한 번만(비평 R4-09) — 히어로의 베타 한 줄과 띠 본문은 뺐다(2026-09-30).
    expect(v.split('베타').length - 1).toBe(1);
    expect(v.split('운영자').length - 1).toBe(1);
    expect(v).toContain(text(a5).trim());
    const en = visible(withoutDefense(renderHomePage('en').html));
    const a5en = HOME_COPY.en['a5'] ?? '';
    expect(a5en.toLowerCase()).toContain('beta');
    expect(a5en).toContain('Sign-up is by invitation from the waitlist.');
    expect(en.split(/\bbeta\b/i).length - 1).toBe(1);
    expect(en.split('operator').length - 1).toBe(1);
  });

  it('⑫ 두 겹 방어(2026-10-07) — 분리 절 바로 다음 한 절: 눈썹 · 제목 · 한 줄 · 움직이는 그림 · 겹 둘(머리표 + 제목 + 한두 줄), 짧게 · 과장 없이', () => {
    const words = (s: string): number => s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').trim().split(/\s+/).length;
    for (const lang of ['ko', 'en'] as const) {
      const h = renderHomePage(lang).html;
      const c = HOME_COPY[lang];
      const sec = DEFENSE_SECTION.exec(h)?.[0] ?? '';
      expect(sec, lang).not.toBe('');
      expect(h.match(new RegExp(DEFENSE_SECTION, 'g')), lang).toHaveLength(1);
      expect(sec).toContain(`<p class="def-k">${c['defKicker'] ?? '∅'}</p><h2 id="def-title">${c['defTitle'] ?? '∅'}</h2><p class="sec-lede">${c['defLede'] ?? '∅'}</p>`);
      // 그림 — 장식 SVG 하나(보조기술에는 figure 의 이름 하나), 글자는 두 언어 공통 `scout@` 뿐.
      expect(sec).toContain(`<figure class="df-fig" aria-label="${c['defLabel'] ?? '∅'}"><svg class="il il-def" viewBox="0 0 560 320" aria-hidden="true" focusable="false">`);
      expect([...sec.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])).toEqual(['scout@']);
      // 끝 장면(2026-10-08 개정 — 한 검사선 · 세 갈래): 테두리 표(위험)를 단 봉투 · 보류 칸의 채운 표(차단) 봉투와 종(소유자 알림) · 승인 문 앞의 답장.
      for (const needle of ['<g class="ec">', '<g class="bdg r">', '<g class="eb">', '<g class="env bad">', '<g class="bdg k">', 'class="tray"', '<g class="badge bell">', 'class="gate"', '<g class="badge ok">', 'class="env ed"', 'class="l1"', 'class="l2"']) expect(sec, needle).toContain(needle);
      // 옛 그림(시계 · 경고 삼각형)은 없다.
      expect(sec).not.toContain('<g class="tag">');
      expect(sec).not.toContain('M174 64v8l5 4');
      // 겹 둘 — 첫 겹(모두에게) · 둘째 겹(켜는 조직만 · 베타, 경고만).
      const layers = /<ol class="layers">([\s\S]*?)<\/ol>/.exec(sec)?.[1] ?? '';
      expect(layers.match(/<li class="ly l[12] rv"><p class="ly-k">[^<]+(?:&middot;[^<]+)?<\/p><h3>[^<]+<\/h3><p>[^<]+<\/p>/g)).toHaveLength(2);
      expect(layers).toContain(`<p class="ly-n">${c['l2Note'] ?? '∅'}</p>`);
      // 덧붙임은 켜는 곳 한 줄뿐(진윤겸 2026-10-07 — 처리 장비 문장은 뺐다).
      expect(words(c['l2Note'] ?? ''), `${lang} l2Note`).toBeLessThanOrEqual(8);
      expect(sec).not.toMatch(/장비|hardware/);
      // 짧게(홈은 글자를 적게 — 진윤겸 2026-10-01): 제목 여덟 어절 · 한 줄 한두 문장 · 겹 본문 마흔 어절 이하.
      expect(words(c['defTitle'] ?? ''), `${lang} defTitle`).toBeLessThanOrEqual(8);
      expect(words(c['defLede'] ?? ''), `${lang} defLede`).toBeLessThanOrEqual(28);
      for (const key of ['defKicker', 'l1Title', 'l2Title', 'l1Tag', 'l2Tag']) expect(words(c[key] ?? ''), `${lang} ${key}`).toBeLessThanOrEqual(4);
      for (const key of ['l1Body', 'l2Body', 'l2Note']) expect(words(c[key] ?? ''), `${lang} ${key}`).toBeLessThanOrEqual(40);
      const sv = visible(sec);
      // 베타는 둘째 겹 머리표에 한 번(대기자 명단 사실과 다른 것 — ⑩ 은 이 절을 걷어 내고 센다).
      expect(sv.split(lang === 'ko' ? '베타' : /\bbeta\b/i).length - 1, `${lang} beta`).toBe(1);
      // 둘째 겹은 경고만 — 막지 않는다는 말이 있다.
      expect(sv).toContain(lang === 'ko' ? '경고 전용이라 차단·승인·판정에는 관여하지 않습니다' : 'Warning only: it never blocks, approves or changes a decision');
      // 개발자용 일반어(결정론 · DLP · 분류 모델 · classifier)는 쓰되, 모델 고유명 · 제공사 · 인프라 · 임계값 · 수치는 쓰지 않는다.
      expect(sv).toMatch(lang === 'ko' ? /결정론[\s\S]*DLP[\s\S]*분류 모델/ : /Deterministic[\s\S]*DLP[\s\S]*classifier/);
      expect(sv).not.toMatch(/\b(?:GPT|Claude|Llama|Gemini|Qwen|Mistral|Phi|BERT|DeBERTa|OpenAI|Anthropic|Ollama|SQS|KMS|Lambda|S3|AWS|Mac|Studio|threshold)\b|임계|\d/i);
      // 과장 금지 — 위험한 낱말(copy-guard 에 더해 이 절에서만).
      expect(sv).not.toMatch(/완벽|100\s*%|모든 공격|막아 ?냅|prevents?|every attack|guarantee|보장/i);
    }
  });

  it('⑪ atmark 주소 예시의 `@` 는 `.at` 로 표시만 한다(색 없음) — 카드·받은편지함·JSON · 외부 주소(example.com)에는 없다', () => {
    for (const lang of ['ko', 'en'] as const) {
      const h = renderHomePage(lang).html;
      expect(h).toContain('<p class="idc-addr"><span class="addr">scout<span class="at">@</span>atmark.ai</span></p>');
      expect(h).toMatch(/<div class="box agent"><p class="bh"><span>[^<]+<\/span><span class="addr">scout<span class="at">@<\/span>atmark\.ai<\/span><\/p>/);
      expect(h).toContain('"scout<span class="at">@</span>atmark.ai"');
      for (const address of ['partner@example.com', 'verify@example.com', 'team@example.com', 'you@example.com']) expect(h).toContain(`<span class="addr">${address}</span>`);
      expect(h).not.toMatch(/<span class="at">@<\/span>example/);
    }
  });

  it('⑪-영어 — 같은 구성과 접두어 없는 CTA(/signup), 문구 키 집합이 한국어와 같다', () => {
    const en = renderHomePage('en').html;
    const te = text(en);
    expect(Object.keys(HOME_COPY.en).sort()).toEqual(Object.keys(HOME_COPY.ko).sort());
    expect(Object.keys(CHROME_COPY.en).sort()).toEqual(Object.keys(CHROME_COPY.ko).sort());
    expect(en).toContain('<h1 id="hero-title">Give your agent<br>its own email.</h1>');
    expect(te).toContain('Give your agent its own email.');
    expect(en).toContain(`<span class="addr rot"><span class="sr">${HERO_AGENT_NAMES[0]}@atmark.ai</span>`);
    expect(en).toContain('</span></span> &mdash; never mixed with your inbox.');
    const pillars = /<ol class="pillars">([\s\S]*?)<\/ol>/.exec(en)?.[1] ?? '';
    expect(pillars.match(/<li class="pl rv">/g)).toHaveLength(4);
    for (const heading of ['Its own address', 'A signed identity', 'Tamper-evident records', 'Managed with a switch']) expect(pillars).toContain(`<h3>${heading}</h3>`);
    expect((/<ul class="facts">([\s\S]*?)<\/ul>/.exec(en)?.[1] ?? '').match(/<li class="rv">/g)).toHaveLength(3);
    expect(en.match(/<li class="proof rv">/g)).toHaveLength(3);
    expect(en.match(/<details><summary><h3>/g)).toHaveLength(5);
    expect(en).not.toContain('Who runs Atmark?');
    expect(en).toContain('<h2 id="start-title">Create your first agent email.</h2>');
    expect(en.split(`<a class="btn" href="/waitlist">Join the waitlist ${ARROW_RIGHT_ICON}</a>`).length - 1).toBe(2);
    expect(en.split(`<a class="btn ghost" href="${docsUrl('en')}">Read the docs</a>`).length - 1).toBe(2);
    expect(en.split('<a class="plain so" href="/login">Log in</a>').length - 1).toBe(2);
    // 두 언어의 마크업 뼈대(태그·클래스 순서)가 같다 — 한쪽에만 있는 블록이 없다.
    const skeleton = (h: string): string => markup(h).replace(/>[^<]*</g, '><').replace(/\s(href|hreflang|lang|aria-label|id|content|src|srcset|alt)="[^"]*"/g, '');
    expect(skeleton(en)).toBe(skeleton(renderHomePage('ko').html));
  });
});

describe('내용 — 대기자 명단 화면', () => {
  it('순번을 약속하지 않는다 — "차례"·"your turn" 이 없고, 초대는 "보내게 되면 이 주소로" 로 말한다(소유자 승인 마케팅 안 2026-09-30)', () => {
    const ko = text(renderWaitlistPage('ko').html);
    const en = text(renderWaitlistPage('en').html);
    expect(ko).not.toContain('차례');
    expect(en).not.toMatch(/your turn/i);
    expect(ko).toContain('초대를 보내 드리게 될 때 이 주소로 알려 드립니다');
    expect(en).toContain('if we send you an invitation, it will come to this address');
  });
});

describe('내용 — 개인정보 처리 안내·이용약관', () => {
  const privacy = text(renderPrivacyPage('ko').html);
  const terms = text(renderTermsPage('ko').html);
  const privacyEn = text(renderPrivacyPage('en').html);
  const termsEn = text(renderTermsPage('en').html);

  it('⑫ 개인정보 — 수집 항목·목적·보관·제3자·위탁(AWS 서울·SES)·문의처·시행일', () => {
    for (const item of ['가입 이메일', '조직 이름', '요청 IP 주소의 HMAC 값', 'IP 주소 원문은 데이터베이스에 보관하지 않습니다.', '에이전트가 주고받는 메일', '감사 기록', '접속 기록']) {
      expect(privacy).toContain(item);
    }
    expect(privacy).toContain('회원 탈퇴 또는 처리 목적을 달성할 때까지 보유합니다. 관계 법령이 일정 기간 보관을 요구하면 그 기간 동안 보관');
    expect(privacy).toContain('개인정보를 제3자에게 제공하지 않습니다.');
    expect(privacy).toContain('AWS 서울 리전(ap-northeast-2)');
    expect(privacy).toContain('Amazon SES');
    expect(privacy).toContain(`시행일 ${effectiveDateText('ko', PRIVACY_EFFECTIVE_DATE)}`);
    expect(privacy).toContain('대기자 명단에 올린 이메일 주소');
    expect(privacy).toContain('문의처:');
    // 보관 기간은 US-008 결정대로 항목별 숫자가 있다 — 메일 본문 1년 · 접속 기록 3개월 · 감사 기록은 서비스 제공 기간,
    // 투명성 로그(운영 중 — 2026-10-01 문구): 공개본(체크포인트·해시만)은 1년 잠금(진윤겸 2026-09-24 — 7년에서 줄임). "누구나 검증" · "고칠 수 없" 없음.
    expect(privacy).toContain('1년');
    expect(privacy).toContain('3개월');
    expect(privacy).toContain('투명성 로그를 운영합니다');
    expect(privacy).toContain('공개한 파일은 1년 동안 지울 수 없도록 잠가 두며');
    expect(privacy).not.toContain('아직 운영하지 않습니다');
    // 대기자 신청서(202609301530) — 이용 목적 · 알게 된 곳 · 유입 경로 값과 목적 · 조직 행 복사.
    expect(privacy).toContain('신청할 때 고른 이용 목적');
    expect(privacy).toContain('초대 순서를 정하고 어떤 경로로 알려졌는지 가늠하는 데 씁니다');
    // 처리 위탁은 AWS 둘뿐(2026-10-01 진윤겸 — Anthropic 항목은 이 문서가 관리하지 않는다).
    expect(privacy).not.toContain('Anthropic');
    // ADR-0010 L7(202609250220) — 초대만 받고 들어오지 않은 사람의 주소는 마지막 초대가 끝나고 30일 뒤 지운다.
    expect(privacy).toContain('초대받은 사람의 이메일');
    expect(privacy).toContain('마지막 초대가 취소되거나 만료된 날로부터 30일이 지나면 지웁니다');
    // 적대적 검토 M2 — 쓰이지 않은 가입 신청(202609250240) · 따로 남는 것 둘(반송·수신 거부 목록은 원문 주소 · 백업 14일).
    expect(privacy).toContain('링크가 만료된 날로부터 30일이 지나면 지웁니다');
    expect(privacy).toContain('반송·수신 거부 목록에 주소 원문 그대로 보관합니다');
    expect(privacy).toContain(`백업은 ${String(DB_BACKUP_RETENTION_DAYS)}일 보관합니다`);
    expect(privacy).not.toContain('초안');
  });

  it('⑫-영어 — 같은 항목·위탁·시행일, 보관 기간 숫자 있음, "draft" 표시 없음', () => {
    for (const item of ['Sign-up email', 'Organization name', 'HMAC of the requesting IP address', 'The IP address itself is not stored in our database.', 'Mail your agents send and receive', 'Audit records', 'Access logs']) {
      expect(privacyEn).toContain(item);
    }
    expect(privacyEn).toContain('does not provide personal information to third parties');
    expect(privacyEn).toContain('AWS Seoul Region (ap-northeast-2)');
    expect(privacyEn).toContain(`Effective ${effectiveDateText('en', PRIVACY_EFFECTIVE_DATE)}`);
    expect(privacyEn).toContain('The email address you add to the waitlist');
    expect(privacyEn).toContain('one year');
    expect(privacyEn).toContain('three months');
    expect(privacyEn).toContain('We run a transparency log');
    expect(privacyEn).toContain('locked against deletion for one year');
    expect(privacyEn).not.toContain('not yet running');
    expect(privacyEn).toContain('the intended use you choose');
    expect(privacyEn).toContain('to learn which channels work');
    expect(privacyEn).not.toContain('Anthropic');
    expect(privacyEn).toContain('Invitee email');
    expect(privacyEn).toContain('30 days after their last invite was revoked or expired');
    expect(privacyEn).toContain('30 days after the link expired');
    expect(privacyEn).toContain('suppression list as the address itself');
    expect(privacyEn).toContain(`backups are kept for ${String(DB_BACKUP_RETENTION_DAYS)} days`);
    expect(privacyEn).not.toMatch(/draft/i);
    // 두 언어의 절 수가 같다.
    const sections = (lang: SiteLang): number => (renderPrivacyPage(lang).html.match(/<section id=/g) ?? []).length;
    expect(sections('en')).toBe(sections('ko'));
  });

  it('⑬ 약관 — 대기자 명단·베타·금지 행위·시행일, "초안" 표시 없음 · 영어판도 같은 조 수', () => {
    expect(terms).toContain('서비스는 지금 대기자 명단으로 가입을 받습니다.');
    // 2026-10-01 — 대기자 명단은 초대를 약속하지 않는다 · 이용 목적을 보고 조금씩 초대한다(마케팅 계획 §9.4).
    expect(terms).toContain('대기자 명단에 올렸다고 해서 초대를 약속하지는 않습니다.');
    expect(terms).toContain('이용 목적을 보고 초대를 조금씩 보냅니다');
    expect(terms).not.toContain('검토가 끝난 뒤 열립니다');
    expect(terms).toContain('서비스는 베타 단계입니다.');
    expect(terms).toContain('관문과 발송 정책을 우회하거나 무력화하려는 시도');
    expect(terms).toContain(`이 약관은 ${effectiveDateText('ko', TERMS_EFFECTIVE_DATE)}부터 시행합니다.`);
    expect(terms).toContain(`시행일 ${effectiveDateText('ko', TERMS_EFFECTIVE_DATE)}`);
    expect(terms).not.toContain('초안');
    expect(termsEn).toContain('Sign-up is currently by waitlist.');
    expect(termsEn).toContain('Joining the waitlist does not mean you will be invited.');
    expect(termsEn).toContain('based on the intended use you tell us');
    expect(termsEn).not.toContain('opens only after the review');
    expect(termsEn).toContain('The service is in beta.');
    expect(termsEn).toContain(`These terms take effect on ${effectiveDateText('en', TERMS_EFFECTIVE_DATE)}.`);
    expect(termsEn).toContain(`Effective ${effectiveDateText('en', TERMS_EFFECTIVE_DATE)}`);
    expect(termsEn).not.toMatch(/draft/i);
    const articles = (lang: SiteLang): number => (renderTermsPage(lang).html.match(/<section(?: id="[a-z0-9-]+")?>/g) ?? []).length;
    expect(articles('ko')).toBeGreaterThan(10);
    expect(articles('en')).toBe(articles('ko'));
  });

  it('⑬-결제 — 2026-09-26 개정(2026-09-30 대기자 명단 조 개정 포함): 베타 조의 요금 문장을 빼고 요금제와 결제 조(Paddle MoR·자동 갱신·해지·환불·가격 변경·무료 베타)를 둔다', () => {
    expect(TERMS_EFFECTIVE_DATE).toBe('2026-10-01');
    expect(PRIVACY_EFFECTIVE_DATE).toBe('2026-10-01');
    expect(effectiveDateText('ko', TERMS_EFFECTIVE_DATE)).toBe('2026년 10월 1일');
    expect(effectiveDateText('en', TERMS_EFFECTIVE_DATE)).toBe('October 1, 2026');
    // 뺀 문장은 두 언어 모두 없다 — 베타 조의 나머지(기능 변경·가용성 비약속)는 남는다.
    expect(terms).not.toContain('이용 요금이 생기면');
    expect(termsEn).not.toContain('If we introduce fees');
    expect(terms).toContain('특정 수준의 가용성을 약속하지 않습니다.');
    expect(termsEn).toContain('do not promise any particular level of availability.');
    for (const phrase of [
      '제6조 (요금제와 결제)',
      '유료 요금제(Pro·Team·Scale)는 월 단위로 자동 갱신됩니다.',
      '결제·세금·청구는 Paddle.com이 판매자(Merchant of Record)로서 처리하며, 결제에는 Paddle의 구매자 약관이 함께 적용됩니다.',
      '콘솔의 결제 관리에서 언제든 해지할 수 있습니다. 해지해도 이미 결제한 기간이 끝날 때까지는 요금제가 유지됩니다.',
      '환불은 환불 정책을 따릅니다.',
      '가격을 바꾸면 다음 갱신 전에 알립니다.',
      '베타 요금제는 운영자가 따로 정한 조직에 무료로 제공하며, 베타를 마치기 전에 미리 알립니다.',
    ]) expect(terms).toContain(phrase);
    for (const phrase of [
      '6. Plans and payment',
      'Paid plans (Pro, Team and Scale) renew automatically every month.',
      'Paddle.com processes payments, tax and billing as our Merchant of Record, and Paddle&rsquo;s buyer terms also apply to your payment.',
      'You can cancel a paid plan at any time from billing in the console. After you cancel, your plan stays active until the end of the period you have already paid for.',
      'Refunds follow our Refund Policy.',
      'If we change prices, we will tell you before your next renewal.',
      'The Beta plan is free for organizations we choose to grant it to. We will tell you before the beta ends.',
    ]) expect(termsEn).toContain(phrase);
    for (const lang of ['ko', 'en'] as const) {
      const article = TERMS_BILLING_ARTICLE.exec(renderTermsPage(lang).html)?.[0] ?? '';
      // 가격 페이지·환불 정책으로 링크한다.
      expect(article).toContain(`<a href="${sitePath(lang, 'pricing')}">`);
      expect(article).toContain(`<a href="${sitePath(lang, 'refund')}">`);
      // 금액은 가격 페이지에만 — 약관에는 어떤 금액도 적지 않는다.
      expect(text(article)).not.toMatch(/\$\s?\d|₩|USD|\d[\d,]*\s*(원|달러)/);
      for (const price of Object.values(PLAN_MONTHLY_PRICE_USD)) expect(text(renderTermsPage(lang).html)).not.toMatch(new RegExp(`\\b${String(price)}\\b`));
    }
  });

  it('⑬-운영자 — 약관 제1조에 운영자(샤카, 대표 진윤겸)를 적고, 사업자등록번호·주소는 적지 않는다 · 꼬리에는 운영자 줄이 없고 저작권 한 줄만', () => {
    expect(terms).toContain('서비스 운영자: 샤카(개인사업자, 대표 진윤겸)');
    expect(termsEn).toContain('The service is operated by SHAKA, a sole proprietorship represented by Younkyum Jin, in the Republic of Korea.');
    for (const t of [terms, termsEn]) expect(t).not.toMatch(/사업자\s*등록\s*번호|business registration|\d{3}-\d{2}-\d{5}/i);
    expect(CHROME_COPY.ko['operator']).toBeUndefined();
    expect(CHROME_COPY.en['operator']).toBeUndefined();
    expect(CHROME_COPY.ko['copyright']).toBe('© 2026 Atmark');
    expect(CHROME_COPY.en['copyright']).toBe('© 2026 Atmark');
    for (const [name, lang, , render] of PAGES) {
      const foot = /<footer class="foot">[\s\S]*<\/footer>/.exec(render().html)?.[0] ?? '';
      expect(foot, name).toContain(`<p class="fcopy muted">${CHROME_COPY[lang]['copyright'] ?? ''}</p>`);
      expect(foot, name).not.toMatch(/샤카|SHAKA|진윤겸|Younkyum/);
    }
  });

  it('⑭ 문의 주소를 지어내지 않는다 — CONTACT_EMAIL 이 없으면 mailto 도 없다', () => {
    for (const [, , , render] of PAGES) {
      const html = render().html;
      if (CONTACT_EMAIL === null) expect(html).not.toContain('mailto:');
      else expect(html).toContain(`mailto:${CONTACT_EMAIL}`);
      // 글에 나오는 메일 주소는 예시(홈)뿐이다. 나란한 두 칸(받은편지함 머리의 이름 · 주소)은 떼어 읽는다.
      const addresses = [...text(html.replace(/<\/span><span/g, '</span> <span')).matchAll(/[A-Za-z0-9._%+가-힣-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g)].map((m) => m[0]);
      for (const address of addresses) {
        // onve@ · abuse@ · postmaster@ — 예전 처리 위탁 문단의 주소(지금은 없다 — 허용만 남긴다).
        // 사용 예시(2026-10-01)의 흐름 그림 — 예시 예약 이름(help-desk · ops-pager · invoices)과 `*.example`.
        expect(['이름@atmark.ai', 'name@atmark.ai', 'onve@atmark.ai', 'abuse@atmark.ai', 'postmaster@atmark.ai', 'scout@atmark.ai', 'partner@example.com', 'verify@example.com', 'team@example.com', 'you@example.com', 'research@atmark.ai', 'help-desk@atmark.ai', 'ops-pager@atmark.ai', 'invoices@atmark.ai', 'maya@acme.example', ...HERO_AGENT_NAMES.map((n) => `${n}@atmark.ai`), CONTACT_EMAIL]).toContain(address);
      }
    }
  });

  it('⑮ 404·로그인·가입은 색인하지 않고(noindex,follow — 링크는 따라간다), 나머지는 색인한다', () => {
    const robots = (html: string): string[] => [...html.matchAll(/<meta name="robots" content="([^"]*)">/g)].map((m) => m[1] ?? '');
    for (const lang of ['ko', 'en'] as const) {
      for (const render of [renderNotFoundPage, renderLoginPage, renderSignupPage]) expect(robots(render(lang).html)).toEqual(['noindex,follow']);
      for (const render of [renderHomePage, renderPricingPage, renderRefundPage, renderPrivacyPage, renderTermsPage, renderAbusePage, renderChangelogPage]) {
        expect(robots(render(lang).html)).toEqual(['index,follow']);
      }
    }
  });

  it('⑯ 시행일 표시 — 한 상수에서 두 언어로', () => {
    expect(effectiveDateText('ko')).toMatch(/^\d{4}년 \d{1,2}월 \d{1,2}일$/);
    expect(effectiveDateText('en')).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
  });
});

/**
 * 블로그(2026-10-01) — 같은 CSP·마크업 규율을 블로그 목록·글에 건다. 글은 픽스처(`test/fixtures/blog`)로 만든다(운영 글이 아직 없어도 규칙이 공허하지
 * 않게) + 운영 블로그의 공개 글 전부. 다른 점(허용하는 것)만 적는다:
 *   - `<picture>` 안의 스크린샷 `<source media="(prefers-color-scheme: dark)" srcset="/img/…">` + `<img src="/img/…" … loading="lazy">` — 같은 출처뿐.
 *   - 인라인 SVG 그림(문서의 일부 — 리소스 요청 아님). 그 안에도 on*·style·외부 href 없음.
 *   - `<link rel="alternate" type="application/rss+xml">` 하나(RSS — 리소스를 가져오지 않는다).
 *   - 본문의 외부 링크는 전부 `rel="noopener"` 이고, 외부 절대 URL 은 그 링크들뿐(그 밖은 atmark.ai · 문서 · 콘솔 상수 · schema.org).
 */
describe('블로그 — CSP · 마크업 · 외부 URL 허용 목록', () => {
  const fixtureRecords = buildBlog(readBlogSources(join(__dirname, '../../fixtures/blog')), {
    drafts: false,
    sitePaths: new Set(Object.keys(SITE_ROUTES)),
    shotImages: new Set(['agent-new']),
  }).posts;
  const shots = {
    'agent-new': {
      en: {
        light: { path: '/img/aaaaaaaaaaaaaaaa/blog-agent-new-en-light.webp', width: 900, height: 600, hash: 'aaaaaaaaaaaaaaaa', bytes: 4, base64: 'UklGRg==' },
        dark: { path: '/img/bbbbbbbbbbbbbbbb/blog-agent-new-en-dark.webp', width: 900, height: 600, hash: 'bbbbbbbbbbbbbbbb', bytes: 4, base64: 'UklGRg==' },
      },
    },
  };
  const fixtureSite = buildBlogSite(fixtureRecords, { shots });
  const pages = [...fixtureSite.routes, ...BLOG_SITE.routes].map(([path, page]) => [path, page] as const);
  const known = (path: string): boolean =>
    Object.prototype.hasOwnProperty.call(SITE_ROUTES, path) ||
    fixtureSite.routes.has(path) ||
    BLOG_SITE.routes.has(path) ||
    fixtureSite.feeds.has(path) ||
    BLOG_SITE.feeds.has(path);

  it('픽스처가 목록·글 두 언어를 만든다(검사가 공허하지 않다)', () => {
    expect([...fixtureSite.routes.keys()].sort()).toEqual(['/blog', '/blog/hello', '/kr/blog', '/kr/blog/hello']);
  });

  it.each(pages)('%s — ① 닫힌 CSP(다른 페이지와 같은 모양 — 스크립트는 머리 힌트 하나)', (_path, page) => {
    expect(cspDirective(page.csp, 'default-src')).toEqual(["'none'"]);
    expect(cspDirective(page.csp, 'img-src')).toEqual(["'self'"]);
    expect(cspDirective(page.csp, 'font-src')).toEqual(["'self'"]);
    expect(cspDirective(page.csp, 'script-src')).toEqual([`'sha256-${sha256Base64(HINT)}'`]);
    expect(cspDirective(page.csp, 'connect-src')).toEqual([CONSOLE_ORIGIN]);
    expect(page.csp).not.toMatch(/unsafe-|\*|data:|blob:|nonce-|http:/);
    expect(blocks(page.html, 'style')).toEqual([SITE_CSS]);
    expect(hashProblems(page)).toEqual([]);
    expect(colorProblems(SITE_CSS, page.html)).toEqual([]);
  });

  it.each(pages)('%s — ③ 마크업: 스크립트·이벤트 속성·style= 없음 · 이미지는 같은 출처 <picture> 스크린샷뿐 · <link> 는 아이콘·정본·대안·RSS 뿐', (path, page) => {
    expect(ldBlocks(page.html)).toHaveLength(1);
    const html = withoutLd(page.html);
    expect(blocks(html, 'script')).toEqual([HINT]);
    const m = markup(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    expect(m).not.toMatch(/\son[a-z]+\s*=/i);
    expect(m).not.toMatch(/javascript:/i);
    expect(m).not.toMatch(/\sstyle\s*=/i);
    expect(m).not.toMatch(/<(iframe|object|embed|base|video|audio|foreignObject|image|meta\s+http-equiv)\b/i);
    expect(m).not.toMatch(/<style\b/i);
    const picture = /<picture><source media="\(prefers-color-scheme: dark\)" srcset="(\/img\/[0-9a-f]{16}\/blog-[a-z0-9-]+-(?:en|ko)-dark\.webp)" width="\d+" height="\d+"><img src="(\/img\/[0-9a-f]{16}\/blog-[a-z0-9-]+-(?:en|ko)-light\.webp)" width="\d+" height="\d+" alt="[^"]+" loading="lazy" decoding="async"><\/picture>/g;
    const rest = m.replace(picture, '');
    if (path === '/blog/hello') expect(m.match(picture)).toHaveLength(1);
    expect(rest).not.toMatch(/<(img|source|picture)\b/i);
    expect(rest).not.toMatch(/\s(src|srcset)\s*=/i);
    const links = [...m.matchAll(/<link\b[^>]*>/gi)].map((l) => l[0]);
    const icons = [...FAVICON_LINK.matchAll(/<link\b[^>]*>/gi)].map((l) => l[0]);
    const feeds = links.filter((l) => l.includes('application/rss+xml'));
    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatch(/^<link rel="alternate" type="application\/rss\+xml" title="[^"]+" href="https:\/\/atmark\.ai(\/kr)?\/blog\/rss\.xml">$/);
    for (const link of links.filter((l) => !icons.includes(l) && !feeds.includes(l))) {
      expect(link).toMatch(/^<link rel="(alternate" hreflang="(ko|en|x-default)|canonical)" href="https:\/\/atmark\.ai[^"]*">$/);
    }
    // 그림 SVG 안에도 외부 참조가 없다(href 는 그림 안 #id 만).
    for (const svg of m.matchAll(/<svg class="fig-svg"[\s\S]*?<\/svg>/g)) {
      for (const h of svg[0].matchAll(/\shref="([^"]*)"/g)) expect(h[1]).toMatch(/^#/);
      expect(svg[0]).not.toMatch(/url\((?!#)/);
    }
  });

  it.each(pages)('%s — ④ 외부 URL 허용 목록 · 외부 링크는 rel="noopener" · 상대 링크는 실제 경로', (path, page) => {
    const html = page.html;
    const external = new Set<string>();
    for (const a of html.matchAll(/<a href="(https:\/\/[^"]+)"( rel="noopener")?>/g)) {
      const url = new URL(a[1] ?? '');
      const ours = url.host === 'atmark.ai' || url.host.endsWith('.atmark.ai');
      if (!ours) {
        expect(a[2], `${a[1] ?? ''} 에 rel="noopener" 가 없다`).toBe(' rel="noopener"');
        external.add(a[1] ?? '');
      }
    }
    const urls = [...html.matchAll(/\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>]*/gi)].map((u) => u[0]);
    for (const url of urls) {
      const ok =
        url.startsWith(`${SITE_ORIGIN}/`) ||
        url === SITE_ORIGIN ||
        url.startsWith('https://docs.atmark.ai') ||
        // MCP 엔드포인트 — 글의 설정 코드 블록 안 글자(링크 아님, 2026-10-01 첫 글).
        [`${CONSOLE_ORIGIN}/api/session/hint`, `${CONSOLE_ORIGIN}/app`, 'https://schema.org', MCP_URL].includes(url) ||
        external.has(url);
      expect(ok, url).toBe(true);
    }
    expect(urls.filter((u) => u.startsWith('http:'))).toEqual([]);
    for (const h of html.matchAll(/\shref="(\/[^"#?]*)(?:[?#][^"]*)?"/g)) {
      const target = h[1] ?? '';
      if (/^\/(_fonts|favicon|apple-touch-icon)/.test(target)) continue;
      expect(known(target), `${path} → ${target}`).toBe(true);
    }
    for (const h of html.matchAll(/\shref="#([^"]+)"/g)) expect(html).toContain(`id="${h[1] ?? ''}"`);
  });
});
