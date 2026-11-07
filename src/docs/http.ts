/**
 * src/docs/http.ts — 사용자 문서(`docs.atmark.ai`)의 요청 처리. API Gateway HTTP API payload v2 → 응답. 상태가 없다(DB·비밀·네트워크 0).
 *
 *   - 메서드: GET·HEAD 만(그 밖 405). HEAD 는 같은 상태·헤더에 빈 본문.
 *   - 페이지: 한국어 `/`·`/<그룹>/<슬러그>`, 영어 `/en`·`/en/<그룹>/<슬러그>` → 200. 끝 슬래시만 붙은 것은 301 로 정본 경로에.
 *     언어는 경로로만 정한다(Accept-Language 로 옮기지 않는다 — 같은 URL 이 늘 같은 문서).
 *   - `<경로>.md`(홈은 `/index.md`·`/en/index.md`) — 페이지의 마크다운 판(`text/markdown`). "페이지 복사"·에이전트가 읽는다.
 *   - `/search?q=` · `/en/search?q=` — 스크립트 없는 서버 검색(색인하지 않음).
 *   - `/robots.txt`·`/sitemap.xml`·`/llms.txt`·`/llms-full.txt` · `/_search/<해시>/<lang>.json`(검색 색인, 1년 immutable) ·
 *     `/_img/<해시>/<파일>.webp`(스크린샷, 1년 immutable) · `/_fonts/<해시>/<파일>.woff2`(같은 출처 Pretendard, 1년 immutable) · 파비콘 둘.
 *   - 그 밖은 404 문서(`/en/…` 아래면 영어). 자산 경로 아래의 없는 파일은 404 한 줄.
 *   - 모든 응답: CSP(페이지는 해시, 나머지는 아무것도 허용 안 함) · HSTS(2년, 하위 도메인) · nosniff · no-referrer · DENY. HTML·`.md`·크롤러 파일은
 *     `public, max-age=300`(개인화 없음 — 문구를 고치면 5분 안에 퍼진다). HTML 은 `accept-encoding` 에 gzip 이 있으면 gzip(+ `vary`).
 */

import { gzipSync } from 'node:zlib';

import { faviconAsset } from '../ui/favicon';
import { FONT_CACHE_CONTROL, FONT_CONTENT_TYPE, fontAsset, isFontPath } from '../ui/fonts';
import { DOCS_LANGS, DOCS_ORIGIN, docsHomePath, docsLangPrefix, type DocsLang } from './constants';
import { decodeDocsContent } from './content-data';
import { buildCrawlFiles, type CrawlFiles } from './crawl';
import DOCS_CONTENT from './generated/content.json';
import { DOCS_SHOT_IMAGES } from './generated/shots';
import { BARE_CSP, buildUtilityPage, chrome, type BuiltPage } from './layout';
import { escapeHtml } from './render';
import { buildDocsSite, groupHits, searchDocs, type DocsSite, type DocsSources, type SearchHit } from './site';

export interface DocsHttpEvent {
  readonly rawPath?: string;
  readonly rawQueryString?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly requestContext?: { readonly domainName?: string; readonly http?: { readonly method?: string } };
}

export interface DocsHttpResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly isBase64Encoded: boolean;
}

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const PAGE_CACHE = 'public, max-age=300';

/**
 * 문서가 쓰지 않는 강력 기능을 끈다(보안 검토 I4) — 카메라·마이크·위치·결제·USB 등. 클립보드 쓰기("복사")는 브라우저 기본 허용(같은 출처)이라 적지 않는다.
 */
const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';

const DOCS_BASE_HEADERS: Readonly<Record<string, string>> = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'permissions-policy': PERMISSIONS_POLICY,
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': PAGE_CACHE,
};

export interface DocsRuntime {
  readonly site: DocsSite;
  readonly crawl: CrawlFiles;
  readonly notFound: Readonly<Record<DocsLang, BuiltPage>>;
  readonly images: ReadonlyMap<string, string>;
}

let runtime: DocsRuntime | undefined;

/** 사이트 전체 — 첫 요청(또는 테스트)에서 한 번 만든다. */
export function docsRuntime(): DocsRuntime {
  runtime ??= createDocsRuntime(decodeDocsContent(DOCS_CONTENT));
  return runtime;
}

/** 원문에서 런타임 하나. 운영은 `docsRuntime()`(생성 값 파일, 엄격), 로컬 미리보기는 디스크의 콘텐츠를 느슨하게(`strict: false`) 넘긴다. */
export function createDocsRuntime(sources: DocsSources, options: { readonly strict?: boolean; readonly features?: Readonly<Record<string, boolean>> } = {}): DocsRuntime {
  const site = buildDocsSite(sources, options);
  const images = new Map<string, string>();
  for (const set of Object.values(DOCS_SHOT_IMAGES)) {
    for (const lang of DOCS_LANGS) for (const theme of ['light', 'dark'] as const) images.set(set[lang][theme].path, set[lang][theme].base64);
  }
  const notFound = Object.fromEntries(
    DOCS_LANGS.map((lang) => [
      lang,
      buildUtilityPage({
        lang,
        title: chrome(lang, 'nfTitle'),
        description: chrome(lang, 'nfBody'),
        ordered: site.ordered[lang],
        switchHref: docsHomePath(lang === 'ko' ? 'en' : 'ko'),
        searchPath: site.search[lang].path,
        main:
          '<p class="nf-code" aria-hidden="true">404</p>' +
          `<h1>${chrome(lang, 'nfTitle')}</h1><p class="lede">${chrome(lang, 'nfBody')}</p>` +
          searchForm(lang, '') +
          `<div class="actions"><a class="btn" href="${docsHomePath(lang)}">${chrome(lang, 'nfHome')}</a></div>`,
      }),
    ]),
  ) as Record<DocsLang, BuiltPage>;
  return { site, crawl: buildCrawlFiles(site), notFound, images };
}

function searchForm(lang: DocsLang, value: string): string {
  return (
    `<form class="hero-s" action="${docsLangPrefix(lang)}/search" method="get" role="search">` +
    `<input name="q" type="search" autocomplete="off" value="${escapeHtml(value)}" placeholder="${chrome(lang, 'searchPlaceholder')}" aria-label="${chrome(lang, 'searchLabel')}">` +
    `<button type="submit" class="btn sm">${chrome(lang, 'searchGo')}</button></form>`
  );
}

/** 결과가 없을 때 보이는 자주 찾는 페이지(있는 것만). */
const POPULAR_PAGES: readonly string[] = ['get-started/quickstart', 'email/allow-block-lists', 'connect/tokens', 'help/troubleshooting-sending'];

/** `/search?q=` 결과 문서 — 페이지별 묶음(가장 잘 맞은 절 + 같은 페이지의 절 둘까지). */
function searchPage(lang: DocsLang, query: string, rt: DocsRuntime = docsRuntime()): BuiltPage {
  const q = query.slice(0, 200);
  // 화면에 되풀이하는 질의는 60자까지(보안 검토 L6 — 긴 입력이 페이지에 그대로 실리지 않게). 검색 자체는 200자까지.
  const shown = [...q].length > 60 ? `${[...q].slice(0, 60).join('')}…` : q;
  const groups = groupHits(searchDocs(rt.site.search[lang].items, q));
  const where = (h: SearchHit): string => (h.item.h === '' ? h.item.g : `${h.item.g} › ${h.item.h}`);
  const popular = POPULAR_PAGES.map((id) => rt.site.ordered[lang].find((p) => p.id === id)).filter((p) => p !== undefined);
  const empty =
    `<p class="muted">${escapeHtml(chrome(lang, 'noResultsFor').replace('{q}', () => shown))} ${chrome(lang, 'noResultsHint')}</p>` +
    `<h2 class="sr-pop">${chrome(lang, 'popular')}</h2><ul class="sr-list">` +
    popular.map((p) => `<li><a href="${p.path}">${escapeHtml(p.front.title)}</a><p>${escapeHtml(p.front.description)}</p></li>`).join('') +
    '</ul>';
  const list =
    q.trim() === ''
      ? `<p class="muted">${chrome(lang, 'searchIntro')}</p>`
      : groups.length === 0
        ? empty
        : `<p class="muted">${escapeHtml(chrome(lang, 'resultsFor').replace('{q}', () => shown))} · ${chrome(lang, 'resultsCount').replace('{n}', String(groups.length))}</p>` +
          '<ol class="sr-list">' +
          groups
            .map(
              (g) =>
                `<li><a href="${escapeHtml(g.best.item.u)}">${escapeHtml(g.best.item.t)}</a>` +
                `<span class="sr-h">${escapeHtml(where(g.best))}</span>` +
                `<p>${escapeHtml(g.best.snippet)}</p>` +
                (g.more.length === 0
                  ? ''
                  : `<ul class="sr-more">${g.more.map((m) => `<li><a href="${escapeHtml(m.item.u)}">${escapeHtml(m.item.h === '' ? m.item.t : m.item.h)}</a></li>`).join('')}</ul>`) +
                '</li>',
            )
            .join('') +
          '</ol>';
  return buildUtilityPage({
    lang,
    title: chrome(lang, 'searchTitle'),
    description: chrome(lang, 'searchIntro'),
    ordered: rt.site.ordered[lang],
    switchHref: `${docsLangPrefix(lang === 'ko' ? 'en' : 'ko')}/search${q === '' ? '' : `?q=${encodeURIComponent(q)}`}`,
    searchPath: rt.site.search[lang].path,
    main: `<h1>${chrome(lang, 'searchTitle')}</h1>${searchForm(lang, q)}${list}`,
  });
}

function headerOf(event: DocsHttpEvent, name: string): string | undefined {
  return Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

export function acceptsGzip(event: DocsHttpEvent): boolean {
  const header = headerOf(event, 'accept-encoding');
  if (header === undefined) return false;
  return header.split(',').some((part) => {
    const [name = '', ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    if (name !== 'gzip' && name !== '*') return false;
    const q = params.find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

function respond(status: number, headers: Record<string, string>, body: string, head: boolean): DocsHttpResult {
  return { statusCode: status, headers: { ...DOCS_BASE_HEADERS, ...headers }, body: head ? '' : body, isBase64Encoded: false };
}

/** 자산(폰트·이미지·색인·파비콘) — 문서 헤더(프레임·리퍼러)를 물려받지 않고 뜻 있는 것만. */
function asset(contentType: string, cache: string, body: string, base64: boolean, head: boolean): DocsHttpResult {
  return {
    statusCode: 200,
    headers: {
      'strict-transport-security': DOCS_BASE_HEADERS['strict-transport-security'] ?? '',
      'x-content-type-options': 'nosniff',
      'cross-origin-opener-policy': 'same-origin',
      'content-security-policy': BARE_CSP,
      'content-type': contentType,
      'cache-control': cache,
    },
    body: head ? '' : body,
    isBase64Encoded: base64 && !head,
  };
}

const notFoundText = (head: boolean): DocsHttpResult =>
  respond(404, { 'content-security-policy': BARE_CSP, 'content-type': 'text/plain; charset=utf-8' }, 'Not Found\n', head);

function langOfPath(path: string): DocsLang {
  return path === '/en' || path.startsWith('/en/') ? 'en' : 'ko';
}

function safeTail(text: string): string {
  return text.replace(/[^\x21-\x7e]/g, (ch) => encodeURIComponent(ch));
}

const GZIP_CACHE = new Map<string, string>();

function gzipBase64(html: string): string {
  const hit = GZIP_CACHE.get(html);
  if (hit !== undefined) return hit;
  const encoded = gzipSync(Buffer.from(html, 'utf8'), { level: 9 }).toString('base64');
  if (GZIP_CACHE.size >= 256) GZIP_CACHE.clear();
  GZIP_CACHE.set(html, encoded);
  return encoded;
}

export function handleDocsRequest(event: DocsHttpEvent, rt: DocsRuntime = docsRuntime()): DocsHttpResult {
  const result = routeDocsRequest(event, rt);
  const type = result.headers['content-type'] ?? '';
  if (!type.startsWith('text/html')) return result;
  const headers = { ...result.headers, vary: 'accept-encoding' };
  if (result.body === '' || result.isBase64Encoded || !acceptsGzip(event)) return { ...result, headers };
  return { ...result, headers: { ...headers, 'content-encoding': 'gzip' }, body: gzipBase64(result.body), isBase64Encoded: true };
}

function routeDocsRequest(event: DocsHttpEvent, rt: DocsRuntime): DocsHttpResult {
  const method = (event.requestContext?.http?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return respond(405, { 'content-security-policy': BARE_CSP, 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }, 'Method Not Allowed\n', false);
  }
  const head = method === 'HEAD';
  const path = event.rawPath === undefined || event.rawPath === '' ? '/' : event.rawPath;
  const query = event.rawQueryString ?? '';

  if (isFontPath(path)) {
    const font = fontAsset(path);
    return font === undefined ? notFoundText(head) : asset(FONT_CONTENT_TYPE, FONT_CACHE_CONTROL, font.base64, true, head);
  }
  // 파비콘(`src/ui/favicon.ts`) — 해시 경로 셋(1년 immutable) + 옛 고정 경로 셋(하루).
  const favicon = faviconAsset(path);
  if (favicon !== undefined) return asset(favicon.contentType, favicon.cacheControl, favicon.body(), favicon.base64, head);
  if (path.startsWith('/_img/')) {
    const image = rt.images.get(path);
    return image === undefined ? notFoundText(head) : asset('image/webp', IMMUTABLE_CACHE, image, true, head);
  }
  if (path.startsWith('/_search/')) {
    const lang = DOCS_LANGS.find((l) => rt.site.search[l].path === path);
    return lang === undefined ? notFoundText(head) : asset('application/json; charset=utf-8', IMMUTABLE_CACHE, rt.site.search[lang].json, false, head);
  }
  const text = (body: string, type: string): DocsHttpResult => respond(200, { 'content-security-policy': BARE_CSP, 'content-type': type }, body, head);
  if (path === '/robots.txt') return text(rt.crawl.robots, 'text/plain; charset=utf-8');
  if (path === '/sitemap.xml') return text(rt.crawl.sitemap, 'application/xml; charset=utf-8');
  if (path === '/llms.txt') return text(rt.crawl.llms, 'text/plain; charset=utf-8');
  if (path === '/llms-full.txt') return text(rt.crawl.llmsFull, 'text/plain; charset=utf-8');
  // `/en.md` 는 영어 홈의 마크다운 판(`/en/index.md`)과 같다 — `<경로>.md` 규칙을 영어 홈에도 맞춘다.
  const md = rt.site.markdown.get(path === '/en.md' ? '/en/index.md' : path);
  if (md !== undefined) return text(md, 'text/markdown; charset=utf-8');

  const html = (status: number, page: BuiltPage): DocsHttpResult =>
    respond(status, { 'content-security-policy': page.csp, 'content-type': 'text/html; charset=utf-8' }, page.html, head);
  if (path === '/search' || path === '/en/search') {
    const q = new URLSearchParams(query).get('q') ?? '';
    return html(200, searchPage(langOfPath(path), q, rt));
  }
  const known = (p: string): boolean => rt.site.pages.has(p) || p === '/search' || p === '/en/search';
  if (path.length > 1 && path.endsWith('/') && known(path.slice(0, -1))) {
    return respond(301, { 'content-security-policy': BARE_CSP, location: `${DOCS_ORIGIN}${safeTail(path.slice(0, -1))}${query === '' ? '' : `?${safeTail(query)}`}` }, '', head);
  }
  const page = rt.site.pages.get(path);
  if (page !== undefined) return html(200, page);
  return html(404, rt.notFound[langOfPath(path)]);
}
