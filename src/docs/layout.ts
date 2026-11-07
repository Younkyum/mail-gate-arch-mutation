/**
 * src/docs/layout.ts — 문서 페이지의 껍데기(머리·사이드바·본문·목차·꼬리·검색 대화상자)와 CSP.
 *
 * 격자(계획 §6): 머리 56px 고정(로고 가로 조합 + `Docs` · 탭 넷 · 검색 ⌘K · 언어 · 테마 · "콘솔" 알약) · 왼쪽 사이드바 260 · 본문 최대 720 ·
 * 오른쪽 목차 220(≥1280). 1024 미만에서 사이드바는 머리의 메뉴 버튼으로 여는 서랍(`popover` — 스크립트 없이 동작).
 *
 * CSP(페이지마다 같다): `default-src 'none'` · 인라인 스타일 하나와 인라인 스크립트 하나를 **해시로만** · 폰트·이미지·연결은 같은 출처만 ·
 * 폼 제출은 같은 출처(검색 폼 `/search`) · `frame-ancestors 'none'` · Trusted Types(`innerHTML` 류 싱크 없음 — 스크립트는 DOM API 만 쓴다).
 * 스크립트가 없어도 모든 페이지·검색(`/search?q=`)·서랍·목차 링크가 동작한다(점진적 향상).
 */

import { createHash } from 'node:crypto';

import { brandLockupSvg } from '../ui/brand';
import { FAVICON_LINK } from '../ui/favicon';
import { OG_IMAGE_HASH } from '../ui/og-version';
import { CONSOLE_URL, DOCS_ORIGIN, HOME_ORIGIN, OG_IMAGE, SUPPORT_EMAIL, docsHomePath, docsLangPrefix, type DocsLang } from './constants';
import { GROUP_LABELS, TAB_GROUPS, TAB_LABELS, DOCS_TABS, type DocsTab } from './nav';
import { ARROW_ICON, escapeHtml } from './render';
import { DOCS_SCRIPT } from './script';
import type { DocPage } from './types';
import { DOCS_CSS } from './styles';

/** 홈 OG 이미지의 절대 URL — 내용 해시 경로(그림이 바뀌면 링크 미리보기도 새로 받는다). */
export function ogImageUrl(lang: DocsLang): string {
  return `${HOME_ORIGIN}/og/${OG_IMAGE_HASH[lang]}/${lang}.png`;
}

export function sha256Base64(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

/** 페이지가 아닌 응답(301·405·자산 404)의 CSP — 아무것도 허용하지 않는다. */
export const BARE_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const STYLE_HASH = sha256Base64(DOCS_CSS);
export const SCRIPT_HASH = sha256Base64(DOCS_SCRIPT);

export const DOCS_PAGE_CSP =
  "default-src 'none'; " +
  `script-src 'sha256-${SCRIPT_HASH}'; ` +
  `style-src 'sha256-${STYLE_HASH}'; ` +
  "font-src 'self'; img-src 'self'; connect-src 'self'; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; " +
  "require-trusted-types-for 'script'; trusted-types 'none'";

const CHROME: Readonly<Record<DocsLang, Readonly<Record<string, string>>>> = {
  ko: {
    skip: '본문으로 건너뛰기',
    docs: '문서',
    homeLabel: 'Atmark 문서 홈',
    tabsNav: '문서 영역',
    search: '검색',
    searchLabel: '문서 검색',
    searchPlaceholder: '문서 검색',
    searchGo: '검색',
    console: '콘솔',
    switchTo: 'English',
    theme: '테마',
    themeSystem: '시스템',
    themeLight: '밝게',
    themeDark: '어둡게',
    menu: '메뉴',
    sideNav: '문서 목차',
    crumbs: '이동 경로',
    toc: '이 페이지에서',
    copyMd: '페이지 복사',
    copied: '복사했습니다',
    viewMd: 'Markdown 보기',
    updated: '마지막 수정',
    related: '관련 문서',
    pager: '이전·다음 문서',
    prev: '이전',
    next: '다음',
    feedback: '이 문서에 대한 의견은 {email}로 보내 주세요.',
    close: '닫기',
    noResults: '찾는 결과가 없습니다. 띄어쓰기를 바꾸거나 더 짧은 낱말로 찾아 보세요.',
    noResultsFor: '“{q}”에 맞는 문서가 없습니다.',
    noResultsHint: '띄어쓰기를 바꾸거나 더 짧은 낱말로 찾아 보세요.',
    popular: '자주 찾는 문서',
    resultsFor: '“{q}” 검색 결과',
    resultsCount: '{n}개',
    searchTitle: '검색',
    searchIntro: '제목과 본문에서 찾습니다.',
    footHome: 'Atmark 홈',
    footPricing: '요금제',
    footTerms: '이용약관',
    footPrivacy: '개인정보 처리 안내',
    footCopy: '© 2026 Atmark',
    suffix: ' | Atmark 문서',
    nfTitle: '페이지를 찾을 수 없습니다',
    nfBody: '주소를 다시 확인하거나 검색해 보세요.',
    nfHome: '문서 홈으로',
    homeAll: '모든 페이지',
  },
  en: {
    skip: 'Skip to content',
    docs: 'Docs',
    homeLabel: 'Atmark Docs home',
    tabsNav: 'Docs sections',
    search: 'Search',
    searchLabel: 'Search the docs',
    searchPlaceholder: 'Search the docs',
    searchGo: 'Search',
    console: 'Console',
    switchTo: '한국어',
    theme: 'Theme',
    themeSystem: 'System',
    themeLight: 'Light',
    themeDark: 'Dark',
    menu: 'Menu',
    sideNav: 'Docs navigation',
    crumbs: 'Breadcrumb',
    toc: 'On this page',
    copyMd: 'Copy page',
    copied: 'Copied',
    viewMd: 'View as Markdown',
    updated: 'Last updated',
    related: 'Related',
    pager: 'Previous and next',
    prev: 'Previous',
    next: 'Next',
    feedback: 'Feedback on this page? Write to {email}.',
    close: 'Close',
    noResults: 'No results. Try fewer or shorter words.',
    noResultsFor: 'Nothing matches “{q}”.',
    noResultsHint: 'Try fewer or shorter words, or a different spelling.',
    popular: 'Popular pages',
    resultsFor: 'Results for “{q}”',
    resultsCount: '{n} found',
    searchTitle: 'Search',
    searchIntro: 'Searches titles and page text.',
    footHome: 'Atmark home',
    footPricing: 'Pricing',
    footTerms: 'Terms',
    footPrivacy: 'Privacy',
    footCopy: '© 2026 Atmark',
    suffix: ' | Atmark Docs',
    nfTitle: 'Page not found',
    nfBody: 'Check the address, or search the docs.',
    nfHome: 'Back to docs home',
    homeAll: 'All pages',
  },
};

export function chrome(lang: DocsLang, key: string): string {
  const v = CHROME[lang][key];
  if (v === undefined) throw new Error(`CHROME.${lang}.${key} 가 없다`);
  return v;
}

const OTHER: Readonly<Record<DocsLang, DocsLang>> = { ko: 'en', en: 'ko' };
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function dateText(lang: DocsLang, iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return lang === 'ko' ? `${String(y)}년 ${String(m)}월 ${String(d)}일` : `${EN_MONTHS[m - 1] ?? ''} ${String(d)}, ${String(y)}`;
}

// ── 아이콘(16 · 선 1.5 — 홈·콘솔과 같은 재질) ─────────────────────────────

const svg = (paths: string, cls = 'ico'): string =>
  `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${paths}</svg>`;
const SEARCH_ICON = svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>');
const SUN_ICON = svg('<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>', 'ico th-light');
const MOON_ICON = svg('<path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z"/>', 'ico th-dark');
const SYSTEM_ICON = svg('<rect x="2" y="3" width="12" height="8.5" rx="1.5"/><path d="M5.5 14h5M8 11.5V14"/>', 'ico th-system');
const ARROW_LEFT = svg('<path d="M13 8H3M7 4 3 8l4 4"/>');

/** 로고 — 가로 조합(심볼 + "atmark", `src/ui/brand.ts` 단일 원천 · 2026-09-30). 인라인 SVG · `currentColor` · 높이는 `.logo-m`. */
export const LOGO = brandLockupSvg({ className: 'logo-m', height: 20 });

// ── 조각 ────────────────────────────────────────────────────────────────

function firstPageOf(ordered: readonly DocPage[], tab: DocsTab): DocPage | undefined {
  return ordered.find((p) => p.tab === tab);
}

function tabLinks(lang: DocsLang, ordered: readonly DocPage[], current: DocsTab | null): string {
  return DOCS_TABS.map((tab) => {
    const first = firstPageOf(ordered, tab);
    if (first === undefined) return '';
    return `<a href="${first.path}"${tab === current ? ' aria-current="true"' : ''}>${TAB_LABELS[lang][tab]}</a>`;
  }).join('');
}

function header(lang: DocsLang, ordered: readonly DocPage[], current: DocsTab | null, switchHref: string): string {
  const other = OTHER[lang];
  return (
    '<header class="top"><div class="bar">' +
    `<button type="button" class="menu-b" popovertarget="side" aria-label="${chrome(lang, 'menu')}"><span class="bars" aria-hidden="true"></span></button>` +
    `<a class="logo" href="${docsHomePath(lang)}" aria-label="${chrome(lang, 'homeLabel')}">${LOGO}<span class="logo-d">${chrome(lang, 'docs')}</span></a>` +
    `<nav class="tabs-nav" aria-label="${chrome(lang, 'tabsNav')}">${tabLinks(lang, ordered, current)}</nav>` +
    '<div class="bar-r">' +
    `<a class="search-b" href="${docsLangPrefix(lang)}/search" id="search-open" aria-keyshortcuts="Meta+K Control+K /">${SEARCH_ICON}<span class="search-t">${chrome(lang, 'search')}</span><kbd class="kbd" aria-hidden="true">&#8984;K</kbd></a>` +
    `<a class="plain lang" href="${switchHref}" hreflang="${other}" lang="${other}">${chrome(lang, 'switchTo')}</a>` +
    themeButton(lang, false) +
    `<a class="btn sm" href="${CONSOLE_URL}">${chrome(lang, 'console')}</a>` +
    '</div></div></header>'
  );
}

/** 테마 버튼(스크립트가 켠다 — 없으면 숨김). 서랍 안의 것은 글자 이름을 같이 보인다. */
function themeButton(lang: DocsLang, withLabel: boolean): string {
  return (
    `<button type="button" class="theme-b${withLabel ? ' theme-bl' : ''}" hidden data-l-system="${chrome(lang, 'themeSystem')}" data-l-light="${chrome(lang, 'themeLight')}" data-l-dark="${chrome(lang, 'themeDark')}" data-l-theme="${chrome(lang, 'theme')}" aria-label="${chrome(lang, 'theme')}: ${chrome(lang, 'themeSystem')}">` +
    `${SYSTEM_ICON}${SUN_ICON}${MOON_ICON}${withLabel ? `<span class="theme-l">${chrome(lang, 'themeSystem')}</span>` : ''}</button>`
  );
}

function sidebar(lang: DocsLang, ordered: readonly DocPage[], currentTab: DocsTab | null, currentId: string | null, switchHref: string): string {
  const tabs = DOCS_TABS.filter((t) => firstPageOf(ordered, t) !== undefined);
  const showTabs = currentTab === null ? tabs : [currentTab];
  const groups = showTabs
    .flatMap((tab) => TAB_GROUPS[tab])
    .map((group) => {
      const pages = ordered.filter((p) => p.group === group);
      if (pages.length === 0) return '';
      return (
        `<div class="side-g"><p class="side-h" id="sg-${group}">${GROUP_LABELS[lang][group]}</p><ul aria-labelledby="sg-${group}">` +
        pages
          .map(
            (p) =>
              `<li><a href="${p.path}"${p.id === currentId ? ' aria-current="page"' : ''}>${escapeHtml(p.front.navTitle ?? p.front.title)}</a></li>`,
          )
          .join('') +
        '</ul></div>'
      );
    })
    .join('');
  return (
    `<nav class="side${currentTab === null ? ' side-home' : ''}" id="side" popover aria-label="${chrome(lang, 'sideNav')}">` +
    // 서랍(1024 미만)에서만 보이는 닫기 · 탭 · (끝에) 언어·테마. 넓은 화면의 사이드바에서는 숨는다.
    `<div class="side-x"><button type="button" popovertarget="side" popovertargetaction="hide">${chrome(lang, 'close')}</button></div>` +
    `<div class="side-tabs">${tabLinks(lang, ordered, currentTab)}</div>` +
    groups +
    `<div class="side-f"><a href="${switchHref}" hreflang="${OTHER[lang]}" lang="${OTHER[lang]}">${chrome(lang, 'switchTo')}</a>${themeButton(lang, true)}</div>` +
    '</nav>'
  );
}

function footer(lang: DocsLang, switchHref: string): string {
  const other = OTHER[lang];
  // 홈(atmark.ai)의 언어 접두어 — 2026-09-30: 영어가 기본(접두어 없음), 한국어는 `/kr`. 문서 자신의 경로(`/en`)와는 다르다.
  const p = lang === 'en' ? '' : '/kr';
  return (
    '<footer class="foot"><div class="foot-in">' +
    `<a class="logo" href="${HOME_ORIGIN}${p === '' ? '/' : p}" aria-label="${chrome(lang, 'footHome')}">${LOGO}</a>` +
    `<nav class="foot-l" aria-label="Atmark">` +
    `<a href="${HOME_ORIGIN}${p}/pricing">${chrome(lang, 'footPricing')}</a>` +
    `<a href="${HOME_ORIGIN}${p}/terms">${chrome(lang, 'footTerms')}</a>` +
    `<a href="${HOME_ORIGIN}${p}/privacy">${chrome(lang, 'footPrivacy')}</a>` +
    `<a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>` +
    `<a href="${switchHref}" hreflang="${other}" lang="${other}">${chrome(lang, 'switchTo')}</a>` +
    '</nav>' +
    `<p class="muted">${chrome(lang, 'footCopy')}</p>` +
    '</div></footer>'
  );
}

function searchDialog(lang: DocsLang, indexPath: string): string {
  return (
    `<dialog class="sd" id="search-d" aria-label="${chrome(lang, 'searchLabel')}" data-index="${indexPath}" data-empty="${chrome(lang, 'noResults')}">` +
    `<form class="sd-f" action="${docsLangPrefix(lang)}/search" method="get" role="search">${SEARCH_ICON}` +
    `<input class="sd-q" id="search-q" name="q" type="search" autocomplete="off" spellcheck="false" placeholder="${chrome(lang, 'searchPlaceholder')}" aria-label="${chrome(lang, 'searchLabel')}" aria-controls="search-r">` +
    `<button type="button" class="sd-x" id="search-x"><span class="kbd">Esc</span><span class="sr">${chrome(lang, 'close')}</span></button></form>` +
    '<ul class="sd-r" id="search-r" aria-live="polite"></ul>' +
    '</dialog>'
  );
}

interface HeadParts {
  readonly lang: DocsLang;
  readonly title: string;
  readonly description: string;
  readonly indexed: boolean;
  /** 두 언어 쌍의 경로(대안 링크·canonical). 없으면(404·검색) 대안 링크 없음. */
  readonly paths?: { readonly ko: string; readonly en: string };
  readonly ld?: string;
  readonly ogType?: string;
}

function head(p: HeadParts): string {
  const url = (path: string): string => `${DOCS_ORIGIN}${path}`;
  const canonical = p.paths === undefined ? '' : url(p.paths[p.lang]);
  const prop = (name: string, value: string): string => `<meta property="${name}" content="${escapeHtml(value)}">`;
  const nm = (name: string, value: string): string => `<meta name="${name}" content="${escapeHtml(value)}">`;
  return (
    `<!doctype html><html lang="${p.lang}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    `<meta name="robots" content="${p.indexed ? 'index,follow' : 'noindex,follow'}">` +
    '<meta name="color-scheme" content="light dark">' +
    FAVICON_LINK +
    `<meta name="description" content="${escapeHtml(p.description)}">` +
    `<title>${escapeHtml(p.title)}</title>` +
    (p.paths === undefined
      ? ''
      : `<link rel="canonical" href="${canonical}">` +
        `<link rel="alternate" hreflang="ko" href="${url(p.paths.ko)}">` +
        `<link rel="alternate" hreflang="en" href="${url(p.paths.en)}">` +
        `<link rel="alternate" hreflang="x-default" href="${url(p.paths.ko)}">` +
        prop('og:type', p.ogType ?? 'article') +
        prop('og:site_name', 'Atmark Docs') +
        prop('og:title', p.title) +
        prop('og:description', p.description) +
        prop('og:url', canonical) +
        prop('og:locale', p.lang === 'ko' ? 'ko_KR' : 'en_US') +
        prop('og:image', ogImageUrl(p.lang)) +
        prop('og:image:type', OG_IMAGE.contentType) +
        prop('og:image:width', String(OG_IMAGE.width)) +
        prop('og:image:height', String(OG_IMAGE.height)) +
        nm('twitter:card', 'summary_large_image') +
        nm('twitter:title', p.title) +
        nm('twitter:description', p.description) +
        nm('twitter:image', ogImageUrl(p.lang))) +
    (p.ld ?? '') +
    `<style>${DOCS_CSS}</style>` +
    `<script>${DOCS_SCRIPT}</script>` +
    '</head>'
  );
}

/** 구조화 데이터 블록 하나(`@graph`). `<` 는 `<` 로(문자열 안 `</script>` 가 블록을 닫지 못하게). */
export function ldJson(nodes: readonly Readonly<Record<string, unknown>>[]): string {
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes }).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

const ORG_NODE = { '@type': 'Organization', '@id': `${HOME_ORIGIN}/#organization`, name: 'Atmark', url: `${HOME_ORIGIN}/`, logo: `${HOME_ORIGIN}/favicon.svg` };

// ── 페이지 ──────────────────────────────────────────────────────────────

export interface DocChromePage {
  readonly page: DocPage;
  /** 렌더된 본문 HTML. */
  readonly body: string;
  readonly related: readonly DocPage[];
  readonly prev: DocPage | null;
  readonly next: DocPage | null;
  /** 같은 언어의 보이는 페이지 전부(사이드바 순서). */
  readonly ordered: readonly DocPage[];
  /** 다른 언어의 같은 페이지. */
  readonly other: DocPage | null;
  /** 검색 색인 경로(대화상자가 fetch 한다 — `/_search/<해시>/<lang>.json`). */
  readonly searchPath: string;
}

export interface BuiltPage {
  readonly html: string;
  readonly csp: string;
}

function cardsOf(pages: readonly DocPage[]): string {
  return (
    '<ul class="cards">' +
    pages
      .map(
        (p) =>
          `<li><a class="card" href="${p.path}"><span class="card-t">${escapeHtml(p.front.title)}${ARROW_ICON}</span><span class="card-d">${escapeHtml(p.front.description)}</span></a></li>`,
      )
      .join('') +
    '</ul>'
  );
}

export function buildDocPage(c: DocChromePage): BuiltPage {
  const { page } = c;
  const lang = page.lang;
  const switchHref = c.other?.path ?? docsHomePath(OTHER[lang]);
  const groupLabel = page.group === null ? '' : GROUP_LABELS[lang][page.group];
  const groupFirst = c.ordered.find((p) => p.group === page.group);
  const home = docsHomePath(lang);
  const crumbs =
    `<nav class="crumbs" aria-label="${chrome(lang, 'crumbs')}"><ol>` +
    `<li><a href="${home}">${chrome(lang, 'docs')}</a></li>` +
    (groupFirst === undefined ? '' : `<li><a href="${groupFirst.path}">${groupLabel}</a></li>`) +
    `<li><span aria-current="page">${escapeHtml(page.front.title)}</span></li>` +
    '</ol></nav>';
  const meta =
    '<div class="meta">' +
    `<button type="button" class="meta-b" id="copy-md" hidden data-md="${page.mdPath}" data-done="${chrome(lang, 'copied')}">${chrome(lang, 'copyMd')}</button>` +
    `<a class="meta-a" href="${page.mdPath}">${chrome(lang, 'viewMd')}</a>` +
    (page.updated === '' ? '' : `<span class="meta-u">${chrome(lang, 'updated')} <time datetime="${page.updated}">${dateText(lang, page.updated)}</time></span>`) +
    '</div>';
  const related = c.related.length === 0 ? '' : `<section class="related" aria-labelledby="related-h"><h2 id="related-h">${chrome(lang, 'related')}</h2>${cardsOf(c.related)}</section>`;
  const pager =
    c.prev === null && c.next === null
      ? ''
      : `<nav class="pn" aria-label="${chrome(lang, 'pager')}">` +
        (c.prev === null
          ? '<span></span>'
          : `<a class="pn-a pn-prev" href="${c.prev.path}" rel="prev"><span class="pn-l">${ARROW_LEFT}${chrome(lang, 'prev')}</span><span class="pn-t">${escapeHtml(c.prev.front.title)}</span></a>`) +
        (c.next === null
          ? '<span></span>'
          : `<a class="pn-a pn-next" href="${c.next.path}" rel="next"><span class="pn-l">${chrome(lang, 'next')}${ARROW_ICON}</span><span class="pn-t">${escapeHtml(c.next.front.title)}</span></a>`) +
        '</nav>';
  const feedback = `<p class="fb">${chrome(lang, 'feedback').replace('{email}', `<a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>`)}</p>`;
  const toc =
    page.outline.toc.length === 0
      ? ''
      : `<aside class="toc" aria-labelledby="toc-h"><p class="toc-h" id="toc-h">${chrome(lang, 'toc')}</p><ul>` +
        page.outline.toc.map((a) => `<li class="l${String(a.level)}"><a href="#${escapeHtml(a.id)}">${escapeHtml(a.text)}</a></li>`).join('') +
        '</ul></aside>';
  const url = `${DOCS_ORIGIN}${page.path}`;
  const ld = ldJson([
    {
      '@type': 'TechArticle',
      headline: page.front.title,
      description: page.front.description,
      inLanguage: lang,
      url,
      ...(page.updated === '' ? {} : { dateModified: page.updated }),
      isPartOf: { '@type': 'WebSite', name: 'Atmark Docs', url: `${DOCS_ORIGIN}/` },
      publisher: ORG_NODE,
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: chrome(lang, 'docs'), item: `${DOCS_ORIGIN}${home}` },
        ...(groupFirst === undefined ? [] : [{ '@type': 'ListItem', position: 2, name: groupLabel, item: `${DOCS_ORIGIN}${groupFirst.path}` }]),
        { '@type': 'ListItem', position: groupFirst === undefined ? 2 : 3, name: page.front.title, item: url },
      ],
    },
  ]);
  const html =
    head({
      lang,
      title: `${page.front.title}${chrome(lang, 'suffix')}`,
      description: page.front.description,
      indexed: true,
      paths: { ko: lang === 'ko' ? page.path : switchHref, en: lang === 'en' ? page.path : switchHref },
      ld,
    }) +
    '<body>' +
    `<a class="skip" href="#main">${chrome(lang, 'skip')}</a>` +
    header(lang, c.ordered, page.tab, switchHref) +
    '<div class="shell">' +
    sidebar(lang, c.ordered, page.tab, page.id, switchHref) +
    `<main id="main" class="doc">${crumbs}<h1>${escapeHtml(page.front.title)}</h1><p class="lede">${escapeHtml(page.front.description)}</p>${meta}` +
    `<div class="prose">${c.body}</div>${related}${pager}${feedback}</main>` +
    toc +
    '</div>' +
    footer(lang, switchHref) +
    searchDialog(lang, c.searchPath) +
    '</body></html>';
  return { html, csp: DOCS_PAGE_CSP };
}

export function buildHomePage(c: DocChromePage): BuiltPage {
  const { page } = c;
  const lang = page.lang;
  const switchHref = c.other?.path ?? docsHomePath(OTHER[lang]);
  const all = DOCS_TABS.map((tab) => {
    const groups = TAB_GROUPS[tab]
      .map((group) => {
        const pages = c.ordered.filter((p) => p.group === group);
        if (pages.length === 0) return '';
        return (
          // 그룹 이름이 탭 이름과 같으면(도움말 › 도움말) 그룹 제목을 되풀이하지 않는다.
          `<div class="idx-g">${GROUP_LABELS[lang][group] === TAB_LABELS[lang][tab] ? '' : `<h3>${GROUP_LABELS[lang][group]}</h3>`}<ul>` +
          pages.map((p) => `<li><a href="${p.path}">${escapeHtml(p.front.navTitle ?? p.front.title)}</a></li>`).join('') +
          '</ul></div>'
        );
      })
      .join('');
    return groups === '' ? '' : `<section class="idx-t" aria-labelledby="idx-${tab}"><h2 id="idx-${tab}">${TAB_LABELS[lang][tab]}</h2><div class="idx-gs">${groups}</div></section>`;
  }).join('');
  const ld = ldJson([
    { '@type': 'WebSite', name: 'Atmark Docs', url: `${DOCS_ORIGIN}${page.path}`, inLanguage: lang, description: page.front.description, publisher: ORG_NODE },
  ]);
  const html =
    head({
      lang,
      // 홈 제목은 이미 "Atmark 문서" — 꼬리(" | Atmark 문서")를 두 번 붙이지 않는다.
      title: page.front.title.includes('Atmark') ? page.front.title : `${page.front.title}${chrome(lang, 'suffix')}`,
      description: page.front.description,
      indexed: true,
      paths: { ko: lang === 'ko' ? page.path : switchHref, en: lang === 'en' ? page.path : switchHref },
      ld,
      ogType: 'website',
    }) +
    '<body class="home">' +
    `<a class="skip" href="#main">${chrome(lang, 'skip')}</a>` +
    header(lang, c.ordered, null, switchHref) +
    '<div class="shell shell-home">' +
    sidebar(lang, c.ordered, null, null, switchHref) +
    '<main id="main" class="home-main">' +
    `<div class="hero"><h1>${escapeHtml(page.front.title)}</h1><p class="lede">${escapeHtml(page.front.description)}</p>` +
    `<form class="hero-s" action="${docsLangPrefix(lang)}/search" method="get" role="search">${SEARCH_ICON}<input name="q" type="search" autocomplete="off" placeholder="${chrome(lang, 'searchPlaceholder')}" aria-label="${chrome(lang, 'searchLabel')}"><button type="submit" class="btn sm">${chrome(lang, 'searchGo')}</button></form></div>` +
    `<div class="prose home-prose">${c.body}</div>` +
    `<div class="idx"><h2 class="idx-h">${chrome(lang, 'homeAll')}</h2>${all}</div>` +
    '</main></div>' +
    footer(lang, switchHref) +
    searchDialog(lang, c.searchPath) +
    '</body></html>';
  return { html, csp: DOCS_PAGE_CSP };
}

/** 색인하지 않는 쪽(404·검색 결과) — 본문만 받는다. */
export function buildUtilityPage(p: {
  readonly lang: DocsLang;
  readonly title: string;
  readonly description: string;
  readonly main: string;
  readonly ordered: readonly DocPage[];
  readonly switchHref: string;
  readonly searchPath: string;
}): BuiltPage {
  const html =
    head({ lang: p.lang, title: `${p.title}${chrome(p.lang, 'suffix')}`, description: p.description, indexed: false }) +
    '<body class="util">' +
    `<a class="skip" href="#main">${chrome(p.lang, 'skip')}</a>` +
    header(p.lang, p.ordered, null, p.switchHref) +
    '<div class="shell shell-home">' +
    sidebar(p.lang, p.ordered, null, null, p.switchHref) +
    `<main id="main" class="home-main util-main">${p.main}</main></div>` +
    footer(p.lang, p.switchHref) +
    searchDialog(p.lang, p.searchPath) +
    '</body></html>';
  return { html, csp: DOCS_PAGE_CSP };
}
