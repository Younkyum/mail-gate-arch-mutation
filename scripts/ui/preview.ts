/**
 * `pnpm ui:preview` — AWS 도 DB 도 없이 콘솔·홈 화면을 로컬에서 그대로 띄운다(디자이너·비평가 에이전트가 스크린샷으로 검토할 수
 * 있게). `127.0.0.1` 에만 묶인다(외부 네트워크에 안 열린다).
 *
 *   - **콘솔**(포트 4173) — 실제 렌더 함수(`src/admin/ui/index.ts` 의 `render*Page`)가 만든 HTML·CSP 를 그대로 낸다.
 *     경로는 진짜 콘솔과 같다(`src/admin/router.ts` 참고): `/`·`/login`·`/app`·`/signup`·`/signup/verify`·`/invite`.
 *     세션·CSRF·역할 같은 인가는 흉내 내지 않는다(로컬 미리보기엔 진짜 세션이 없다) — 페이지는 늘 그 경로의 화면을 낸다
 *     (진짜 서버의 세션 기반 302 리다이렉트는 재현하지 않는다). `/api/*` 는 `fake-api.ts` 가 답한다.
 *     폰트는 운영처럼 **홈 출처**에서 받는다(배포 전 리뷰 M4): 콘솔 페이지는 `fontOrigin` = 홈 미리보기(`http://127.0.0.1:4174`)로 렌더하고,
 *     홈 미리보기는 `/_fonts/…` 응답의 `access-control-allow-origin` 을 콘솔 미리보기 출처로 바꿔 준다(운영값은 `https://console.atmark.ai`).
 *     스타일시트·페이지 스크립트 자산(`/_assets/<해시>/<파일>`)도 실제 함수(`adminUiAsset`)가 낸다 — 페이지는 `consoleOrigin` = 이 미리보기 출처로
 *     렌더해 CSP 의 자산 URL 이 로컬 출처를 가리킨다(운영값은 `https://console.atmark.ai`).
 *     언어는 `?lang=ko|en`(쿠키 `__Host-atmark_lang` 도 읽는다 — 실제 화면과 같은 우선순위, `src/admin/ui/i18n.ts` `selectLang`).
 *   - **홈**(포트 4174) — 진짜 사이트 핸들러(`src/site/http.ts` `handleSiteRequest`)를 그대로 부른다. 이 핸들러는 DB·비밀·
 *     네트워크가 없는 순수 함수라(`site/http.ts` 머리말) 그대로 로컬에서 돌 수 있다 — 라우팅·헤더·CSP 가 실제와 같다.
 *     결제 호스트(`pay.atmark.ai`)·`www` 호스트를 보려면 쿼리 `?_host=pay.atmark.ai` 로 호스트를 바꿔친다(로컬은 포트 하나뿐이라
 *     진짜 호스트 헤더를 못 만든다 — 미리보기 전용 손잡이). 결제는 `{pay: null}`(체크아웃은 404, 안내 페이지는 그대로 200).
 *     **미리보기 전용 흉내 셋(2026-09-30 — 운영에는 없다):**
 *       ① 언어 협상 — 운영에서는 CloudFront Function(`src/site/edge-lang.ts`)이 λ 앞에서 한다. 로컬에는 CloudFront 가 없으므로 **같은 함수
 *          소스를 그대로** Node 에서 돌린다(`runEdgeLang`). 쿠키 `atmark_lang` · Accept-Language → `/kr…` 302, `?hl=` → 쿠키 + 302.
 *          다른 점 하나: http 로컬이라 쿠키의 `Secure` 속성을 뗀다.
 *       ② 콘솔 출처 바꾸기 — 사이트 페이지의 힌트·폼 스크립트는 운영 콘솔(`https://console.atmark.ai`)을 부른다. 미리보기는 HTML 안의 그 출처를
 *          콘솔 미리보기 출처로 바꾸고, 바뀐 스크립트 블록에서 해시를 다시 재어 CSP(`script-src`·`connect-src`)를 고쳐 싣는다(`previewSiteHtml`).
 *       ③ 로그인 힌트 — 콘솔 미리보기가 `GET /api/session/hint` 를 답한다(`{"signedIn":…}` · 사이트 미리보기 출처에만 CORS). 로그인 상태는
 *          사이트 URL 의 `?_session=in|out` 로 고른다 — 쿠키 `atmark_preview_session` 에 남고(두 포트가 같은 호스트라 함께 실린다) 기본은 로그아웃.
 *       ④ 블로그 초안 — 운영은 공개 글만, 미리보기는 원문에서 초안까지 그린다(`previewBlog`). 머리·꼬리의 "블로그" 링크는 블로그 페이지 안에서만
 *          보인다(다른 페이지는 운영과 같이 공개 글로 정한다).
 *
 * 마크업이 바뀌어도 이 서버는 그대로 돈다 — 페이지 조립은 전부 `src/admin/ui/index.ts`·`src/site/http.ts` 의 공개 함수가 하고,
 * 여기서는 결과를 그대로 낼 뿐이다(마크업 안의 id·class 를 들여다보지 않는다).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { ASSET_CACHE_CONTROL, LANG_COOKIE } from '../../src/admin/http';
import {
  adminUiAsset,
  ASSET_PREFIX,
  renderAppPage,
  renderInvitePage,
  renderLoginLandingPage,
  renderLoginPage,
  renderSignupLandingPage,
  renderSignupPage,
  type AdminRenderOptions,
  type AdminUiPage,
  type Lang,
} from '../../src/admin/ui/index';
import { selectLang } from '../../src/admin/ui/i18n';
import { createHash } from 'node:crypto';

import { buildBlogSite, type BlogSite } from '../../src/site/blog';
import { SITE_LANG_FUNCTION_CODE } from '../../src/site/edge-lang';
import { CONSOLE_ORIGIN, SITE_ORIGIN } from '../../src/site/constants';
import { handleSiteRequest, SITE_ROUTES, type SiteHttpEvent } from '../../src/site/http';
import { buildBlog, readBlogSources } from '../blog/build';
import { faviconAsset } from '../../src/ui/favicon';

import { fakeConsoleApi, scenarioFromCookie, scenarioSetCookie } from './fake-api';

/** 미리보기 포트 — 기본 4173 · 4174. 다른 작업자의 미리보기가 떠 있으면 `ATMARK_UI_CONSOLE_PORT` · `ATMARK_UI_SITE_PORT` 로 비켜 띄운다(자식 프로세스도 같은 값을 읽는다). */
export const CONSOLE_PORT = Number(process.env['ATMARK_UI_CONSOLE_PORT'] ?? 4173);
export const SITE_PORT = Number(process.env['ATMARK_UI_SITE_PORT'] ?? 4174);
const HOST = '127.0.0.1';

/**
 * 두 미리보기 출처 — 콘솔 페이지의 폰트 출처와 홈 폰트 응답의 CORS 허용 출처로 쓴다. 기본은 4173·4174 이고, 같은 프로세스 안에서
 * 다른 포트 짝으로 띄울 때(`startPreview` — `pnpm gen:images` 가 다른 작업자의 미리보기와 부딪히지 않게)만 바뀐다.
 */
let consolePreviewOrigin = `http://${HOST}:${String(CONSOLE_PORT)}`;
let sitePreviewOrigin = `http://${HOST}:${String(SITE_PORT)}`;
let previewRender: AdminRenderOptions = { fontOrigin: `http://${HOST}:${String(SITE_PORT)}`, consoleOrigin: consolePreviewOrigin };

const CONSOLE_PAGES: Readonly<Record<string, (lang: Lang, options?: AdminRenderOptions) => AdminUiPage>> = {
  '/': renderLoginPage,
  '/login': renderLoginLandingPage,
  '/app': renderAppPage,
  '/signup': renderSignupPage,
  '/signup/verify': renderSignupLandingPage,
  '/invite': renderInvitePage,
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

function pageLang(req: IncomingMessage, url: URL): Lang {
  return selectLang({
    query: url.searchParams.get('lang') ?? undefined,
    cookie: cookieValue(req.headers.cookie, LANG_COOKIE),
    acceptLanguage: headerString(req.headers['accept-language']),
  });
}

/** ③ 미리보기 로그인 상태 쿠키(두 포트가 같은 호스트 `127.0.0.1` 이라 사이트에서 적은 값이 콘솔 요청에도 실린다). */
const PREVIEW_SESSION_COOKIE = 'atmark_preview_session';

async function handleConsoleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (url.pathname === '/api/session/hint' && method === 'GET') {
    // ③ 로그인 힌트(미리보기 전용 흉내) — 운영 계약과 같은 모양 `{"signedIn":true|false}` · 사이트 출처 하나에만 자격 포함 CORS.
    const signedIn = cookieValue(req.headers.cookie, PREVIEW_SESSION_COOKIE) === 'in';
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': sitePreviewOrigin,
      'access-control-allow-credentials': 'true',
      vary: 'origin',
    });
    res.end(JSON.stringify({ signedIn }));
    return;
  }
  const rawText = method === 'GET' || method === 'HEAD' ? '' : await readBody(req);
  let body: unknown;
  if (rawText.trim() !== '') {
    try {
      body = JSON.parse(rawText);
    } catch {
      body = undefined;
    }
  }
  const path = url.pathname + url.search;
  let result = fakeConsoleApi(method, path, body, scenarioFromCookie(req.headers.cookie));
  // 시나리오(fake-api.ts `SCENARIOS`) — 늦게 답하기 · 연결 끊기. 기본 동작에는 둘 다 없다.
  if (result.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
  if (result.drop === true) {
    req.socket.destroy();
    return;
  }
  if (result.status === 404 && method !== 'GET' && method !== 'HEAD') {
    console.log(`[ui:preview] console: 알 모르는 쓰기 경로 — 그럴듯한 성공으로 대신함: ${method} ${path}`);
    result = { status: 200, json: { ok: true } };
  } else if (result.status === 404) {
    console.log(`[ui:preview] console: 404 ${method} ${path}`);
  }
  res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', ...result.headers });
  res.end(result.status === 204 ? '' : JSON.stringify(result.json));
}

function handleConsoleAsset(res: ServerResponse, url: URL): void {
  const asset = adminUiAsset(url.pathname);
  if (asset === undefined) {
    console.log(`[ui:preview] console: 404 자산 ${url.pathname}`);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found\n');
    return;
  }
  res.writeHead(200, { 'content-type': asset.contentType, 'cache-control': ASSET_CACHE_CONTROL, 'x-content-type-options': 'nosniff' });
  res.end(asset.body);
}

function handleConsolePage(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const render = CONSOLE_PAGES[url.pathname];
  if (render === undefined) {
    console.log(`[ui:preview] console: 404 페이지 ${url.pathname}`);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found\n');
    return;
  }
  const page = render(pageLang(req, url), previewRender);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': page.csp, 'set-cookie': scenarioSetCookie(url) });
  res.end(page.html);
}

async function consoleRequestListener(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    if (url.pathname.startsWith('/api/')) {
      await handleConsoleApi(req, res, url);
      return;
    }
    if (url.pathname.startsWith(ASSET_PREFIX)) {
      handleConsoleAsset(res, url);
      return;
    }
    // 파비콘(해시 경로 셋 + 옛 경로 셋 — 운영 콘솔 라우트와 같은 표, `src/ui/favicon.ts`).
    const favicon = faviconAsset(url.pathname);
    if (favicon !== undefined) {
      res.writeHead(200, { 'content-type': favicon.contentType, 'cache-control': favicon.cacheControl });
      res.end(Buffer.from(favicon.body(), favicon.base64 ? 'base64' : 'utf8'));
      return;
    }
    handleConsolePage(req, res, url);
  } catch (error) {
    console.error('[ui:preview] console 오류', error);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Internal Error\n');
  }
}

/** Node 요청 → `handleSiteRequest` 가 읽는 API Gateway payload v2 흉내. `?_host=` 로 호스트를 바꿔친다(미리보기 전용). */
function toSiteEvent(req: IncomingMessage, url: URL): SiteHttpEvent {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const flat = headerString(value);
    if (flat !== undefined) headers[key] = flat;
  }
  const hostOverride = url.searchParams.get('_host');
  const host = hostOverride ?? headers['host'] ?? 'atmark.ai';
  const query = new URLSearchParams(url.search);
  query.delete('_host');
  return {
    rawPath: url.pathname,
    rawQueryString: query.toString(),
    headers: { ...headers, host },
    requestContext: { domainName: host, http: { method: req.method ?? 'GET' } },
  };
}

/** CloudFront Functions 이벤트의 한 값 모양. */
interface EdgeValue {
  readonly value: string;
  readonly multiValue?: readonly { readonly value: string }[];
}
interface EdgeResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, EdgeValue>>;
  readonly cookies?: Readonly<Record<string, { readonly value: string; readonly attributes?: string }>>;
}

/** ① 운영 엣지 함수 소스를 그대로 싣는다(한 번). `handler(event)` 는 요청(그대로 통과) 또는 응답(302)을 돌려준다. */
const edgeLangHandler = new Function(`${SITE_LANG_FUNCTION_CODE}\nreturn handler;`)() as (event: unknown) => EdgeResponse | { readonly uri: string };

/** 쿼리 원문 → CloudFront Functions 의 `querystring` 모양(키·값은 요청 줄의 인코딩 그대로 — 운영과 같다). */
function edgeQuery(raw: string): Record<string, EdgeValue> {
  const out: Record<string, { value: string; multiValue?: { value: string }[] }> = {};
  for (const part of raw === '' ? [] : raw.split('&')) {
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    const value = eq < 0 ? '' : part.slice(eq + 1);
    const prev = out[key];
    if (prev === undefined) out[key] = { value };
    else out[key] = { value: prev.value, multiValue: [...(prev.multiValue ?? [{ value: prev.value }]), { value }] };
  }
  return out;
}

/** ① 언어 협상 흉내 — 302 면 응답을 쓰고 `true`. 운영처럼 페이지 경로·GET/HEAD 만 대상이다(판단은 함수가 한다). */
function runEdgeLang(req: IncomingMessage, url: URL, res: ServerResponse): boolean {
  const cookies: Record<string, EdgeValue> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookies[part.slice(0, i).trim()] = { value: part.slice(i + 1).trim() };
  }
  const accept = headerString(req.headers['accept-language']);
  const raw = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  const out = edgeLangHandler({
    request: {
      method: (req.method ?? 'GET').toUpperCase(),
      uri: url.pathname,
      querystring: edgeQuery(raw),
      headers: accept === undefined ? {} : { 'accept-language': { value: accept } },
      cookies,
    },
  });
  if (!('statusCode' in out)) return false;
  const headers: Record<string, string | string[]> = {};
  for (const [name, v] of Object.entries(out.headers)) headers[name] = v.value;
  const setCookies = Object.entries(out.cookies ?? {}).map(([name, c]) => `${name}=${c.value}; ${(c.attributes ?? '').replace(/;\s*Secure/i, '')}`);
  if (setCookies.length > 0) headers['set-cookie'] = setCookies;
  console.log(`[ui:preview] site: 엣지 언어 협상 ${String(out.statusCode)} ${url.pathname}${url.search} -> ${String(headers['location'])}`);
  res.writeHead(out.statusCode, headers);
  res.end();
  return true;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64');

/**
 * ② 사이트 HTML 의 운영 콘솔 출처를 콘솔 미리보기 출처로 바꾸고, CSP 의 스크립트 해시·연결 출처를 바뀐 문서에 맞춘다(미리보기 전용).
 * JSON-LD 데이터 블록(`type="application/ld+json"`)은 스크립트 해시 대상이 아니다.
 */
function previewSiteHtml(html: string, csp: string): { readonly html: string; readonly csp: string } {
  if (!html.includes(CONSOLE_ORIGIN)) return { html, csp };
  const out = html.split(CONSOLE_ORIGIN).join(consolePreviewOrigin);
  const hashes = [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${sha256(m[1] ?? '')}'`);
  const fixed = csp
    .split(';')
    .map((part) => {
      const d = part.trim();
      if (d.startsWith('script-src ')) return ` script-src ${hashes.join(' ')}`;
      if (d.startsWith('connect-src ')) return ` connect-src ${consolePreviewOrigin}`;
      return part;
    })
    .join(';');
  return { html: out, csp: fixed.trim() };
}

/** ③ `?_session=in|out` → 미리보기 로그인 상태 쿠키(없으면 그대로). */
function previewSessionCookie(url: URL): string | undefined {
  const v = url.searchParams.get('_session');
  if (v === 'in') return `${PREVIEW_SESSION_COOKIE}=in; Path=/; SameSite=Lax`;
  if (v === 'out') return `${PREVIEW_SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  return undefined;
}

/**
 * ④ 블로그 초안(미리보기 전용 — 2026-10-01). 운영은 생성 값 파일의 공개 글만 싣는다. 미리보기는 원문(`src/site/blog/**`)에서 **초안까지** 바로
 * 그린다 — 글을 고치고 새로 고치면 바로 보인다(원문이 바뀌었을 때만 다시 만든다). 문법 오류로 읽지 못한 글은 빠지고 콘솔에 이유가 찍힌다.
 */
let previewBlogCache: { readonly key: string; readonly site: BlogSite } | undefined;

function previewBlog(): BlogSite {
  const sources = readBlogSources();
  const key = JSON.stringify([sources.posts.map((p) => [p.file, p.text]), [...sources.figures]]);
  if (previewBlogCache?.key === key) return previewBlogCache.site;
  const build = buildBlog(sources, { drafts: true, sitePaths: new Set(Object.keys(SITE_ROUTES)) });
  for (const e of [...build.errors, ...build.draftErrors]) console.log(`[ui:preview] blog: ${e}`);
  const site = buildBlogSite(build.posts, { drafts: true });
  previewBlogCache = { key, site };
  console.log(`[ui:preview] blog: 글 ${String(site.posts.length)}(초안 포함)`);
  return site;
}

function siteRequestListener(req: IncomingMessage, res: ServerResponse): void {
  try {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const session = previewSessionCookie(url);
    if (session === undefined && runEdgeLang(req, url, res)) return;
    const event = toSiteEvent(req, url);
    // 미리보기는 HTML 을 고쳐 싣으므로(②) 압축하지 않은 본문을 받는다.
    const plain = { ...event, headers: Object.fromEntries(Object.entries(event.headers ?? {}).filter(([k]) => k.toLowerCase() !== 'accept-encoding')) };
    const result = handleSiteRequest(plain, { pay: null, blog: previewBlog() });
    if (result.statusCode === 404) console.log(`[ui:preview] site: 404 ${url.pathname}`);
    // 폰트의 CORS 허용 출처만 미리보기 콘솔로 바꾼다(운영값 `https://console.atmark.ai` 로는 로컬 콘솔이 폰트를 못 쓴다). 다른 헤더는 그대로.
    let headers: Record<string, string | string[]> =
      result.headers['access-control-allow-origin'] === undefined ? { ...result.headers } : { ...result.headers, 'access-control-allow-origin': consolePreviewOrigin };
    let body = Buffer.from(result.body, result.isBase64Encoded ? 'base64' : 'utf8');
    if ((result.headers['content-type'] ?? '').startsWith('text/html') && !result.isBase64Encoded) {
      const page = previewSiteHtml(result.body, result.headers['content-security-policy'] ?? '');
      headers = { ...headers, 'content-security-policy': page.csp };
      body = Buffer.from(page.html, 'utf8');
    }
    // 핸들러의 301(끝 슬래시 · 옛 `/en…`)은 정본 출처(`https://atmark.ai`)를 싣는다 — 미리보기에서는 미리보기 출처로 바꾼다.
    const loc = headers['location'];
    if (typeof loc === 'string' && loc.startsWith(SITE_ORIGIN)) headers['location'] = `${sitePreviewOrigin}${loc.slice(SITE_ORIGIN.length)}`;
    if (session !== undefined) headers['set-cookie'] = session;
    res.writeHead(result.statusCode, headers);
    res.end(body);
  } catch (error) {
    console.error('[ui:preview] site 오류', error);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Internal Error\n');
  }
}

function listen(server: Server, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

export function startConsoleServer(port = CONSOLE_PORT): Promise<Server> {
  return listen(createServer((req, res) => void consoleRequestListener(req, res)), port);
}

export function startSiteServer(port = SITE_PORT): Promise<Server> {
  return listen(createServer(siteRequestListener), port);
}

/** 콘솔·홈 미리보기를 이 포트 짝으로 함께 띄운다(출처 둘을 서로 맞춘다). 끝나면 호출자가 `close()` 한다. */
export async function startPreview(consolePort: number, sitePort: number): Promise<{ readonly close: () => void }> {
  consolePreviewOrigin = `http://${HOST}:${String(consolePort)}`;
  sitePreviewOrigin = `http://${HOST}:${String(sitePort)}`;
  previewRender = { fontOrigin: `http://${HOST}:${String(sitePort)}`, consoleOrigin: consolePreviewOrigin };
  const [consoleServer, siteServer] = await Promise.all([startConsoleServer(consolePort), startSiteServer(sitePort)]);
  return {
    close: () => {
      consoleServer.close();
      siteServer.close();
    },
  };
}

async function main(): Promise<void> {
  const [consoleServer, siteServer] = await Promise.all([startConsoleServer(), startSiteServer()]);
  // shots.ts 가 이 한 줄로 준비됨을 확인한다(포트 폴링의 대안) — 사람이 읽어도 되게 JSON 한 줄.
  console.log(JSON.stringify({ ready: true, consolePort: CONSOLE_PORT, sitePort: SITE_PORT }));
  const shutdown = (): void => {
    consoleServer.close();
    siteServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) void main();
