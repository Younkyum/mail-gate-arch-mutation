/**
 * src/site/http.ts — 홈(`atmark.ai`)의 요청 처리. API Gateway HTTP API payload v2 → 응답. 상태가 없다(DB·비밀·네트워크 0).
 *
 *   - 메서드: GET·HEAD 만(그 밖은 405). HEAD 는 GET 과 같은 상태·헤더에 빈 본문(링크 미리보기·모니터링이 HEAD 를 쓴다).
 *   - 호스트 `www.atmark.ai` → 301 `https://atmark.ai` + 같은 경로·쿼리. 정본 호스트는 하나다.
 *   - 경로: 정확히 일치(`SITE_ROUTES` · 블로그) → 200. 끝 슬래시만 붙은 페이지 경로는 301 로 정본에. 그 밖은 404(`/kr` 아래면 한국어 404).
 *     옛 영어 경로 `/en`·`/en/…` 은 301 로 접두어를 뗀 경로에(쿼리 유지) — 옛 링크·북마크가 산다.
 *   - 언어는 **경로로만** 정한다. 접두어 없는 경로의 언어 협상(쿠키 · Accept-Language → `/kr…` 302)은 엣지(`edge-lang.ts`)가 한다 —
 *     이 핸들러는 같은 URL 에 늘 같은 문서를 낸다(쿠키·Accept-Language 를 보지 않는다).
 *   - 공통 헤더: CSP(페이지마다) · HSTS(2년, 하위 도메인 — 콘솔과 같은 값) · nosniff · no-referrer · DENY · 5분 캐시(약관 문구 수정이 5분 안에 퍼진다).
 *   - 호스트 `pay.atmark.ai` → 결제 페이지(`pay.ts`, `handlePayRequest`). 설정(`PayConfig`)은 런타임 핸들러가 환경에서 읽어 넘긴다 —
 *     이 폴더는 환경·네트워크를 모른다.
 *   - apex 만: 폰트 `/_fonts/…` · 파비콘 · 이미지 `/img/…`·`/og/…` · 블로그 이미지 · 크롤러 파일(`crawl.ts`) · RSS. 표에 없는 자원 경로는 404 한 줄.
 */

import { gzipSync } from 'node:zlib';

import { PAY_HOST } from '../billing/constants';
import { faviconAsset, type FaviconAsset } from '../ui/favicon';
import { FONT_CACHE_CONTROL, FONT_CONTENT_TYPE, fontAsset, isFontPath } from '../ui/fonts';
import { ABUSE_PAGES } from './abuse';
import { LOGIN_PAGES, SIGNUP_PAGES, WAITLIST_PAGES } from './auth';
import { BLOG_SITE, type BlogSite } from './blog';
import { CHANGELOG_PAGES } from './changelog';
import { CONSOLE_ORIGIN, KO_PREFIX, LEGACY_EN_PREFIX, REFUND_POLICY_APPROVED, SITE_LANGS, SITE_ORIGIN, SITE_WWW_HOST, type SiteLang } from './constants';
import { LLMS_TXT, ROBOTS_TXT, SITEMAP_XML } from './crawl';
import { HOME_PAGES } from './home';
import { IMAGE_IMMUTABLE_CACHE, isImagePath, isLegacyOgPath, OG_IMAGE_CACHE, siteImage } from './images';
import { NOT_FOUND_PAGES } from './not-found';
import { BARE_CSP, sitePath, type SiteDocumentId, type SitePage } from './page';
import { buildPayPage, PAY_INFO_PAGES, PAY_TRANSACTION_PATTERN, type PayConfig } from './pay';
import { PRICING_PAGES } from './pricing';
import { PRIVACY_PAGES } from './privacy';
import { REFUND_PAGES } from './refund';
import { TERMS_PAGES } from './terms';
import { USE_CASES_PAGES } from './use-cases';

/** payload v2 중 읽는 필드. */
export interface SiteHttpEvent {
  readonly rawPath?: string;
  readonly rawQueryString?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly requestContext?: {
    readonly domainName?: string;
    readonly http?: { readonly method?: string };
  };
}

export interface SiteHttpResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** 폰트(`/_fonts/…`)와 gzip 으로 줄인 HTML 만 `true` — 본문이 base64 다. */
  readonly isBase64Encoded: boolean;
}

const PAGES_BY_ID: Readonly<Record<SiteDocumentId, Readonly<Record<SiteLang, SitePage>>>> = {
  home: HOME_PAGES,
  pricing: PRICING_PAGES,
  privacy: PRIVACY_PAGES,
  terms: TERMS_PAGES,
  login: LOGIN_PAGES,
  signup: SIGNUP_PAGES,
  waitlist: WAITLIST_PAGES,
  'use-cases': USE_CASES_PAGES,
  abuse: ABUSE_PAGES,
  changelog: CHANGELOG_PAGES,
  refund: REFUND_PAGES,
};

/** 라우트에 오르는 페이지 — 환불 정책은 문안 승인(`REFUND_POLICY_APPROVED`) 뒤에만. */
const ROUTED_IDS = (Object.keys(PAGES_BY_ID) as SiteDocumentId[]).filter((id) => id !== 'refund' || REFUND_POLICY_APPROVED);

/** 경로 → 페이지. 정확히 일치만(대소문자 변형은 404). */
export const SITE_ROUTES: Readonly<Record<string, SitePage>> = Object.fromEntries(
  SITE_LANGS.flatMap((lang) => ROUTED_IDS.map((id) => [sitePath(lang, id), PAGES_BY_ID[id][lang]] as const)),
);

/**
 * 결제 페이지 설정 — 핸들러가 환경(`ATMARK_BILLING_ENABLED`·`ATMARK_PADDLE_ENV`·`ATMARK_PADDLE_CLIENT_TOKEN`)에서 만든다.
 * `null` = 스위치 꺼짐 또는 설정 오류 → `pay.atmark.ai` 의 체크아웃(`?_ptxn=…`)은 404. 쿼리 없는 안내 페이지는 그래도 200.
 */
export interface SiteRequestOptions {
  readonly pay: PayConfig | null;
  /**
   * 블로그 덮어쓰기 — **로컬 미리보기만**(초안 포함, `scripts/ui/preview.ts`). 운영 핸들러는 넘기지 않는다 → 공개 글만 실린 `BLOG_SITE`.
   */
  readonly blog?: BlogSite;
}

const NO_PAY: SiteRequestOptions = { pay: null };

const hasRoute = (path: string): boolean => Object.prototype.hasOwnProperty.call(SITE_ROUTES, path);

/** `prefix` 자체이거나 그 아래 경로인가(`/kr` · `/kr/…` — `/krx` 는 아니다). */
function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** 없는 경로의 언어 — `/kr` 아래면 한국어, 그 밖은 영어(기본). */
function langOfPath(path: string): SiteLang {
  return under(path, KO_PREFIX) ? 'ko' : 'en';
}

/** 옛 영어 경로(`/en`·`/en/…`)면 접두어를 뗀 경로(`/`·`/…`), 아니면 `undefined`. */
function legacyEnTarget(path: string): string | undefined {
  if (!under(path, LEGACY_EN_PREFIX)) return undefined;
  const rest = path.slice(LEGACY_EN_PREFIX.length);
  return rest === '' ? '/' : rest;
}

/** `Location` 에 싣는 글자 — 출력 가능한 ASCII 밖(제어 문자·공백·비ASCII)은 퍼센트 인코딩(헤더 주입 방지). */
function headerSafe(text: string): string {
  return text.replace(/[^\x21-\x7e]/g, (ch) => encodeURIComponent(ch));
}

/** 리다이렉트 `Location` 의 쿼리 꼬리(`?…`, 없으면 빈 문자열). */
function queryTail(event: SiteHttpEvent): string {
  const query = event.rawQueryString ?? '';
  return query === '' ? '' : `?${headerSafe(query)}`;
}

/** 요청 경로 — 비어 있으면 `/`. */
function pathOf(event: SiteHttpEvent): string {
  return event.rawPath === undefined || event.rawPath === '' ? '/' : event.rawPath;
}

/** 모든 응답에 실리는 헤더(CSP 는 응답마다 — 페이지면 스타일 해시, 아니면 BARE). */
const SITE_BASE_HEADERS: Readonly<Record<string, string>> = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'public, max-age=300',
};

function headerOf(event: SiteHttpEvent, name: string): string | undefined {
  const entry = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

/** 요청 호스트(포트 제거·소문자). 헤더가 없으면 API Gateway 가 붙인 `domainName`. */
function hostOf(event: SiteHttpEvent): string {
  const raw = headerOf(event, 'host') ?? event.requestContext?.domainName ?? '';
  return raw.trim().toLowerCase().replace(/:\d+$/, '');
}

/**
 * `Location` 에 싣는 경로·쿼리. 정본 출처를 **앞에 고정**하므로(`https://atmark.ai` + …) 경로가 `//evil` 이어도 호스트는
 * 바뀌지 않는다.
 */
function safeTail(event: SiteHttpEvent): string {
  const path = pathOf(event);
  return headerSafe(path.startsWith('/') ? path : `/${path}`) + queryTail(event);
}

function respond(status: number, headers: Record<string, string>, body: string, head: boolean): SiteHttpResult {
  return { statusCode: status, headers: { ...SITE_BASE_HEADERS, ...headers }, body: head ? '' : body, isBase64Encoded: false };
}

/** 문서가 아닌 자원(폰트·이미지)의 404 — HTML 404 페이지가 아니라 텍스트 한 줄. */
function textNotFound(head: boolean, extra: Record<string, string> = {}): SiteHttpResult {
  return respond(404, { ...extra, 'content-security-policy': BARE_CSP, 'content-type': 'text/plain; charset=utf-8' }, 'Not Found\n', head);
}

/** 문서가 아닌 자원은 페이지 헤더(5분 캐시 · `x-frame-options` · `referrer-policy`)를 물려받지 않고 뜻 있는 것만 적는다. */
const ASSET_BASE_HEADERS = {
  'strict-transport-security': SITE_BASE_HEADERS['strict-transport-security'] ?? '',
  'x-content-type-options': 'nosniff',
} as const;

/**
 * 파비콘(콘솔·문서와 같은 그림, `src/ui/favicon.ts`) — 해시 경로는 1년 immutable, 옛 고정 경로는 하루 · svg 는 글, ico·png 는 base64.
 */
function faviconSiteResponse(asset: FaviconAsset, head: boolean): SiteHttpResult {
  const headers = { ...ASSET_BASE_HEADERS, 'cache-control': asset.cacheControl, 'content-type': asset.contentType };
  if (head) return { statusCode: 200, headers, body: '', isBase64Encoded: false };
  return { statusCode: 200, headers, body: asset.body(), isBase64Encoded: asset.base64 };
}

/** base64 바이트 이미지 200(HEAD 는 빈 본문). */
function imageOk(contentType: string, base64: string, cacheControl: string, head: boolean): SiteHttpResult {
  const headers = { ...ASSET_BASE_HEADERS, 'content-security-policy': BARE_CSP, 'content-type': contentType, 'cache-control': cacheControl };
  return { statusCode: 200, headers, body: head ? '' : base64, isBase64Encoded: !head };
}

/**
 * `/img/<해시>/…`(홈 사진, 1년 immutable) · `/og/<해시>/<lang>.png`(링크 미리보기, 1년 immutable) · 옛 `/og/<lang>.png`(하루).
 * 표에 없는 이미지 경로는 404 한 줄.
 */
function imageResponse(path: string, head: boolean): SiteHttpResult {
  const image = siteImage(path);
  if (image === undefined) return textNotFound(head);
  return imageOk(image.contentType, image.base64, isLegacyOgPath(path) ? OG_IMAGE_CACHE : IMAGE_IMMUTABLE_CACHE, head);
}

/** RSS 2.0(블로그 — 공개 글이 있는 언어만). 페이지와 같은 5분 캐시 · 아무것도 허용하지 않는 CSP. */
const RSS_CONTENT_TYPE = 'application/rss+xml; charset=utf-8';

/** 크롤러용 텍스트(`crawl.ts`) — 페이지와 같은 기본 헤더(5분 캐시) · 아무것도 허용하지 않는 CSP. */
const CRAWL_FILES: Readonly<Record<string, readonly [body: string, contentType: string]>> = {
  '/robots.txt': [ROBOTS_TXT, 'text/plain; charset=utf-8'],
  '/sitemap.xml': [SITEMAP_XML, 'application/xml; charset=utf-8'],
  '/llms.txt': [LLMS_TXT, 'text/plain; charset=utf-8'],
};

/**
 * `/_fonts/<해시>/<파일>` — 자체 호스팅 Pretendard(`src/ui/fonts.ts`). 표에 있으면 200 · 1년 immutable(해시가 URL 에 있다) · base64.
 * 표에 없는 폰트 경로는 404 한 줄(폰트 요청에 문서를 주지 않는다).
 */
function fontResponse(path: string, head: boolean): SiteHttpResult {
  const asset = fontAsset(path);
  if (asset === undefined) return textNotFound(head);
  return { statusCode: 200, headers: { ...FONT_HEADERS }, body: head ? '' : asset.base64, isBase64Encoded: !head };
}

/**
 * 폰트 200 응답의 헤더. 교차 출처 허용은 **콘솔 출처 하나**(`CONSOLE_ORIGIN` — 콘솔이 `fontFaceCss(SITE_ORIGIN)` 으로 여기서 받는다, M4):
 * `@font-face` 의 교차 출처 요청은 자격 없는 CORS 모드라 이 헤더 하나면 되고, 값이 요청 `Origin` 을 반사하지 않으므로 `vary: origin` 은
 * 필요 없다(모든 요청에 같은 응답 — 공유 캐시가 출처별로 갈라 둘 이유가 없다). `*` 는 쓰지 않는다(다른 사이트가 폰트 대역을 빌려 쓰지 못하게).
 * 같은 출처(atmark.ai) 페이지의 요청은 이 헤더와 무관하게 쓰인다.
 */
const FONT_HEADERS: Readonly<Record<string, string>> = {
  ...ASSET_BASE_HEADERS,
  'content-security-policy': BARE_CSP,
  'content-type': FONT_CONTENT_TYPE,
  'cache-control': FONT_CACHE_CONTROL,
  'access-control-allow-origin': CONSOLE_ORIGIN,
};

/** 결제 페이지 캐시 — 설정은 실행 환경 수명 동안 하나다(해시 계산 1회). */
let payCache: { readonly key: string; readonly pages: Readonly<Record<SiteLang, SitePage | null>> } | undefined;

function payPages(config: PayConfig): Readonly<Record<SiteLang, SitePage | null>> {
  const key = `${config.environment}\u0000${config.clientToken}`;
  if (payCache?.key !== key) payCache = { key, pages: { ko: buildPayPage('ko', config), en: buildPayPage('en', config) } };
  return payCache.pages;
}

/**
 * `pay.atmark.ai` — 경로 둘(`/` 영어 · `/kr` 한국어 — 2026-09-30, 홈과 같은 규칙). 쿼리 없음 → 안내 페이지(늘 200) · 쿼리 `_ptxn` 하나 →
 * 체크아웃(설정 없음은 404) · 그 밖은 404(링크 없는 한 줄). 옛 `/en`(쿼리 포함)은 301 로 `/`(같은 쿼리) — 이미 나간 체크아웃 링크가 산다.
 */
function handlePayRequest(event: SiteHttpEvent, config: PayConfig | null, head: boolean): SiteHttpResult {
  const noStore = { 'cache-control': 'no-store' };
  const notFound = (): SiteHttpResult => textNotFound(head, noStore);
  const ok = (page: SitePage): SiteHttpResult =>
    respond(200, { ...noStore, 'content-security-policy': page.csp, 'content-type': 'text/html; charset=utf-8' }, page.html, head);
  const path = pathOf(event);
  if (path === LEGACY_EN_PREFIX) {
    return respond(301, { ...noStore, 'content-security-policy': BARE_CSP, location: `https://${PAY_HOST}/${queryTail(event)}` }, '', head);
  }
  const lang: SiteLang | undefined = path === '/' ? 'en' : path === KO_PREFIX ? 'ko' : undefined;
  if (lang === undefined) return notFound();
  const query = event.rawQueryString ?? '';
  if (query === '') return ok(PAY_INFO_PAGES[lang]);
  if (config === null) return notFound();
  const match = /^_ptxn=([^&=]*)$/.exec(query);
  if (match === null || !PAY_TRANSACTION_PATTERN.test(match[1] ?? '')) return notFound();
  const page = payPages(config)[lang];
  return page === null ? notFound() : ok(page);
}

/**
 * 요청이 gzip 을 받는가 — `accept-encoding` 의 토큰 중 `gzip`(또는 `*`)이 `q=0` 이 아닌 채로 있으면. 헤더가 없으면 받지 않는다(원문 그대로).
 */
export function acceptsGzip(event: SiteHttpEvent): boolean {
  const header = headerOf(event, 'accept-encoding');
  if (header === undefined) return false;
  return header.split(',').some((part) => {
    const [name = '', ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    if (name !== 'gzip' && name !== '*') return false;
    const q = params.find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** 줄인 HTML(base64) 캐시 — 페이지는 모듈 로드 때 한 번 만든 문자열이라 종류가 적다(결제 설정이 바뀌면 늘 수 있어 상한만 둔다). */
const GZIP_CACHE = new Map<string, string>();

function gzipBase64(html: string): string {
  const hit = GZIP_CACHE.get(html);
  if (hit !== undefined) return hit;
  const encoded = gzipSync(Buffer.from(html, 'utf8'), { level: 9 }).toString('base64');
  if (GZIP_CACHE.size >= 64) GZIP_CACHE.clear();
  GZIP_CACHE.set(html, encoded);
  return encoded;
}

/**
 * 사이트 HTML 응답을 gzip 으로(배포 전 리뷰 M3) — `accept-encoding` 에 gzip 이 있고 본문이 있는 `text/html` 응답만. 폰트(이미 woff2 압축)·
 * 리다이렉트·텍스트 오류는 그대로다. 모든 HTML 응답에 `vary: accept-encoding` 을 실어 공유 캐시가 두 모양을 섞지 않게 한다.
 * 본문은 base64(`isBase64Encoded`) — API Gateway HTTP API 가 바이트로 풀어 보낸다. CSP 해시는 **풀린** 문서에서 재므로 바뀌지 않는다.
 */
export function handleSiteRequest(event: SiteHttpEvent, options: SiteRequestOptions = NO_PAY): SiteHttpResult {
  const result = routeSiteRequest(event, options);
  if (!(result.headers['content-type'] ?? '').startsWith('text/html')) return result;
  const headers = { ...result.headers, vary: 'accept-encoding' };
  if (result.body === '' || result.isBase64Encoded || !acceptsGzip(event)) return { ...result, headers };
  return { ...result, headers: { ...headers, 'content-encoding': 'gzip' }, body: gzipBase64(result.body), isBase64Encoded: true };
}

function routeSiteRequest(event: SiteHttpEvent, options: SiteRequestOptions): SiteHttpResult {
  const method = (event.requestContext?.http?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return respond(
      405,
      { 'content-security-policy': BARE_CSP, 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' },
      'Method Not Allowed\n',
      false,
    );
  }
  const head = method === 'HEAD';
  const redirect = (tail: string): SiteHttpResult =>
    respond(301, { 'content-security-policy': BARE_CSP, location: `${SITE_ORIGIN}${tail}` }, '', head);

  const host = hostOf(event);
  if (host === SITE_WWW_HOST) return redirect(safeTail(event));
  if (host === PAY_HOST) return handlePayRequest(event, options.pay, head);

  const path = pathOf(event);
  const blog = options.blog ?? BLOG_SITE;
  if (isFontPath(path)) return fontResponse(path, head);
  const favicon = faviconAsset(path);
  if (favicon !== undefined) return faviconSiteResponse(favicon, head);
  const blogImage = blog.images.get(path);
  if (blogImage !== undefined) return imageOk(blogImage.contentType, blogImage.base64, IMAGE_IMMUTABLE_CACHE, head);
  if (isImagePath(path)) return imageResponse(path, head);
  const crawl = Object.prototype.hasOwnProperty.call(CRAWL_FILES, path) ? CRAWL_FILES[path] : undefined;
  if (crawl !== undefined) return respond(200, { 'content-security-policy': BARE_CSP, 'content-type': crawl[1] }, crawl[0], head);
  const feed = blog.feeds.get(path);
  if (feed !== undefined) return respond(200, { 'content-security-policy': BARE_CSP, 'content-type': RSS_CONTENT_TYPE }, feed, head);
  const legacy = legacyEnTarget(path);
  if (legacy !== undefined) return redirect(safeTail({ ...event, rawPath: legacy }));
  const routed = (p: string): boolean => hasRoute(p) || blog.routes.has(p);
  if (path.length > 1 && path.endsWith('/') && routed(path.slice(0, -1))) return redirect(path.slice(0, -1) + queryTail(event));
  const page = hasRoute(path) ? SITE_ROUTES[path] : blog.routes.get(path);
  const found = page ?? NOT_FOUND_PAGES[langOfPath(path)];
  return respond(
    page === undefined ? 404 : 200,
    { 'content-security-policy': found.csp, 'content-type': 'text/html; charset=utf-8' },
    found.html,
    head,
  );
}
