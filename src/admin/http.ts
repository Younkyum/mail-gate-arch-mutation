/**
 * src/admin/http.ts — 관리 표면(admin Lambda)의 요청·응답 모양과 쿠키·보안 헤더. **api Lambda 의 라우터와 공유하지 않는다** —
 * 관리 표면은 별도 Lambda·별도 역할·별도 DB 롤이고, api 번들의 import 폐포에 `src/admin/**` 가 없어야 한다
 * (`test/arch/admin-separation.arch.test.ts`). 여기서 api 쪽 모듈을 끌어오지 않는 것도 같은 이유다.
 *
 * 응답에 스택·내부 메시지를 싣지 않는다 — `{error, detail}` 뿐(계약).
 */

import { gzipSync } from 'node:zlib';

import { faviconAsset } from '../ui/favicon';

/** API Gateway HTTP API payload v2 중 우리가 읽는 필드. */
export interface AdminHttpEvent {
  readonly rawPath: string;
  readonly rawQueryString?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  /** payload v2 는 쿠키를 헤더가 아니라 이 배열로 싣는다. */
  readonly cookies?: readonly string[];
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext: {
    readonly requestId: string;
    readonly stage?: string;
    /** API Gateway 가 채우는 HTTP API id — admin 핸들러가 콘솔 API 의 것인지 본다(`handlers/admin.ts` `isFromConsoleApi`). */
    readonly apiId?: string;
    readonly http: { readonly method: string; readonly sourceIp?: string };
  };
}

/** payload v2 응답. `Set-Cookie` 는 `cookies` 배열로(여러 개를 헤더 하나에 접지 않는다). */
export interface AdminHttpResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly cookies?: readonly string[];
  readonly body: string;
  /** gzip 페이지만 `true` — 본문이 base64 다(`htmlResponse`, 리뷰 M3). */
  readonly isBase64Encoded: boolean;
}

export interface AdminRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** JSON 본문(파싱됨). 본문이 없으면 `undefined`. */
  readonly body: unknown;
  readonly cookies: Readonly<Record<string, string>>;
  /**
   * API Gateway 가 준 요청자 IP(`requestContext.http.sourceIp` — 헤더는 믿지 않는다). 없으면 `null` — 요청자 상한을 거는 라우트는
   * 503 `client_ip_unavailable` 로 닫는다(`clientIpUnavailable`). `'unknown'` 같은 한 값으로 모든 요청자를 한 버킷에 몰지 않는다(재확인 I-3).
   */
  readonly sourceIp: string | null;
  readonly requestId: string;
}

/** 이벤트 → 요청자 IP. 비었거나 없으면 `null`(설정이 어긋난 통합 — 닫힌 채 실패한다). */
export function clientIpOf(event: AdminHttpEvent): string | null {
  const ip = event.requestContext.http.sourceIp?.trim() ?? '';
  return ip === '' ? null : ip;
}

export interface AdminResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly cookies?: readonly string[];
  /** 본문이 base64 다 — gzip 으로 준 페이지(`htmlResponse`)뿐. */
  readonly isBase64Encoded?: boolean;
}

/**
 * 세션 쿠키(계약, 2026-09-23 console.atmark.ai). `__Host-` 접두어 — 브라우저가 **Secure · Path=/ · Domain 없음**일 때만
 * 받는다. 그래서 이 쿠키는 `console.atmark.ai` 호스트에 고정되고, 형제 호스트(api·id)나 상위 도메인이 덮어쓸 수 없다.
 */
export const SESSION_COOKIE = '__Host-atmark_admin';
/**
 * 로그인을 요청한 브라우저의 논스 쿠키 — verify 가 같은 논스를 요구한다(`admin/session.ts`). `__Host-` 는 Path=/ 필수라
 * 경로 제한 대신 이름 접두어로 호스트를 고정한다.
 */
export const LOGIN_BROWSER_COOKIE = '__Host-atmark_admin_login';
/**
 * 셀프 가입을 요청한 브라우저의 논스 쿠키(`signup-contract.md` §5) — `POST /api/signup/verify` 가 같은 논스를 요구한다.
 * 로그인 논스와 **다른 쿠키·다른 결속 문맥**이다(가입 링크와 로그인 링크가 서로의 논스로 통하지 않게).
 */
export const SIGNUP_BROWSER_COOKIE = '__Host-atmark_signup';

/**
 * 화면 언어 쿠키(`signup-contract.md` §8) — `ko`|`en`. `?lang=` 으로만 적힌다(서버가 302). 비밀이 아니고 스크립트가 읽지도
 * 않지만 HttpOnly 로 둔다. SameSite=Lax — 홈(atmark.ai)의 "English" 링크로 들어온 첫 요청에도 실려야 한다.
 */
export const LANG_COOKIE = '__Host-atmark_lang';
const LANG_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** CSRF 헤더(계약). */
export const CSRF_HEADER = 'x-atmark-csrf';

/** 관리 표면의 출처 — 변경 요청에 `Origin` 이 있으면 이것이어야 한다(아래 `CROSS_SITE_AUTH_PATHS` 만 예외). */
export const ADMIN_ORIGIN = 'https://console.atmark.ai';

/**
 * 홈(`https://atmark.ai`, US-003) — 로그인·가입 **폼**이 여기 있다. 폼 스크립트가 `POST /api/login`·`POST /api/signup` 을
 * `credentials:'include'` 로 부른다. 두 호스트는 **같은 사이트·다른 출처**라 응답의 `__Host-` 결속 쿠키(SameSite=Strict)가
 * 콘솔 호스트에 그대로 선다 — 메일 링크 착지(`/login`·`/signup/verify`)와 세션은 콘솔에 남는다.
 */
export const SITE_ORIGIN = 'https://atmark.ai';

/**
 * 홈 출처를 받는 경로 — **세션 전 요청 다섯뿐**(`POST`): 로그인·가입 요청 둘 · 그 verify 둘 · 대기자 명단 등록. 이 다섯에만 CORS(정확히
 * `https://atmark.ai`, 자격 포함)를 열고, 그 밖의 모든 경로는 콘솔 출처만 받는다. 다섯 다 CSRF 헤더가 없는 경로다(세션 전 — 요청 CSRF 는 브라우저 결속 쿠키가
 * 막는다: `admin/session.ts`). 그래서 프리플라이트가 허용하는 요청 헤더는 `content-type` 하나다.
 * verify 둘(2026-09-28 — 메일의 6자리 코드): 홈의 로그인·가입 화면이 보낸 뒤 같은 화면에서 코드를 받아 verify 한다. 새로 열리는 것은
 * "이 브라우저의 결속 쿠키로 코드·토큰을 태운다" 뿐이다 — 코드·토큰은 메일에만 있고, 결속 쿠키(HttpOnly)는 홈 스크립트가 읽지 못한다.
 * 세션 쿠키(HttpOnly)는 콘솔 호스트에 서고, 홈 출처 응답에는 CSRF 토큰을 싣지 않는다(`handleLoginVerify`) — 홈 출처로는 다른 콘솔 API 를
 * 부를 수 없으니(`origin_mismatch`) 쓸 곳도 없지만, 세션 문맥의 값을 다른 출처에 건네지 않는다.
 * 대기자 명단 등록(`/api/waitlist`)은 결속 쿠키도 만들지 않는다(응답 202 하나 · 쿠키 0).
 */
export const CROSS_SITE_AUTH_PATHS: ReadonlySet<string> = new Set(['/api/login', '/api/signup', '/api/login/verify', '/api/signup/verify', '/api/waitlist']);

/**
 * 세션 힌트(2026-09-30) — 홈이 "이미 콘솔에 로그인돼 있나" 만 묻는 **읽기 전용** 탐침. 홈은 이 값으로 "콘솔" 버튼을 보이고, 로그인
 * 메일을 또 보내지 않는다. `CROSS_SITE_AUTH_PATHS`(POST · 세션 전) 밖의 **유일한** 홈 출처 경로이고, GET 하나뿐이다.
 *
 * 계약(홈 스크립트가 부르는 모양):
 *   `fetch('https://console.atmark.ai/api/session/hint', { credentials: 'include' })`
 *   → `200 {"signedIn": true|false}` — 이 키 하나뿐(사용자 id·이메일·조직·CSRF 토큰 없음).
 *   - 헤더를 붙이지 않는다(단순 요청 — 프리플라이트가 없다. 이 경로는 `OPTIONS` 에 405 로 답한다). `Authorization` 을 싣으면 401.
 *   - `Cache-Control: no-store` · `Vary: Origin`. 출처가 정확히 `https://atmark.ai` 이고 `ATMARK_SITE_CORS='true'` 일 때만
 *     `Access-Control-Allow-Origin: https://atmark.ai` + `Access-Control-Allow-Credentials: true`. 그 밖의 출처는 CORS 헤더가 없다
 *     (브라우저가 응답을 스크립트에 주지 않는다 — 콘솔 자기 출처는 CORS 없이 그대로 읽는다).
 *   - `signedIn` 은 `resolveSession` 과 같은 판정이다(폐기·만료·멤버십 제거 → false). 세션을 늘리지 않고(`Set-Cookie` 없음) 쓰지 않는다
 *     (색인 SELECT 한 번 — `owner_sessions.token_hash`). 모양이 아닌 쿠키는 DB 를 보지 않고 false.
 *   - 5xx·429·네트워크 실패는 홈이 **false 로 다룬다**(힌트일 뿐 — 로그인 폼을 그대로 보인다). 권한 판단은 늘 콘솔이 다시 한다.
 */
export const SESSION_HINT_PATH = '/api/session/hint';

/** 프리플라이트 캐시(초) — 짧게. 정책을 바꾸면 10분 안에 퍼진다. */
export const CORS_MAX_AGE_SECONDS = 600;

/**
 * 홈의 로그인·가입 화면(언어별 — 2026-09-30 진윤겸: **영어가 기본(접두어 없음), 한국어는 `/kr`**. 옛 `/en/…` 은 홈이 301 로 넘긴다).
 * 콘솔의 비로그인 `/`·`/signup` 이 여기로 302(스위치 켰을 때).
 */
export const SITE_LOGIN_URLS: Readonly<Record<'ko' | 'en', string>> = { ko: `${SITE_ORIGIN}/kr/login`, en: `${SITE_ORIGIN}/login` };
export const SITE_SIGNUP_URLS: Readonly<Record<'ko' | 'en', string>> = { ko: `${SITE_ORIGIN}/kr/signup`, en: `${SITE_ORIGIN}/signup` };

/**
 * 운영 스위치(환경변수) — `'true'` 일 때만 콘솔의 비로그인 `/`·`/signup`·`/app` 이 홈(atmark.ai)의 로그인·가입으로 302 한다.
 * **기본 끔** — 홈이 배포되고 atmark.ai DNS 가 AWS 로 넘어간 **뒤에** 켠다(`docs/runbooks/site.md` §7). 끈 상태에서는 콘솔 자기
 * 로그인·가입 화면이 그대로다. CORS 는 **별도 스위치**(`ATMARK_SITE_CORS`, 아래)다.
 */
export const AUTH_ON_SITE_ENV = 'ATMARK_AUTH_ON_SITE';

export function authOnSite(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[AUTH_ON_SITE_ENV] === 'true';
}

/**
 * 운영 스위치(환경변수) — `'true'` 일 때만 홈 출처(`https://atmark.ai`)의 교차 출처 로그인·가입(`CROSS_SITE_AUTH_PATHS`)을 연다.
 * **기본 끔.** 2026-09-24 검증 F2: `atmark.ai` 가 아직 Vercel 에 있는 동안 이 CORS 가 열려 있으면, 그 호스트(우리 코드가 아닌 배포)에서
 * 도는 스크립트가 콘솔에 자격 포함 요청을 보낼 수 있다. 그래서 **DNS 가 AWS(홈 스택)로 넘어간 뒤에만** 켠다(`docs/runbooks/site.md` §7.3).
 * 끈 상태: 그 경로들의 프리플라이트는 403(CORS 헤더 없음), 홈 출처의 `POST` 는 다른 교차 출처처럼 403 `origin_mismatch`.
 */
export const SITE_CORS_ENV = 'ATMARK_SITE_CORS';

export function siteCors(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[SITE_CORS_ENV] === 'true';
}

/**
 * 모든 관리 응답의 공통 헤더. HSTS(2년 · 하위 도메인 포함) — 콘솔은 HTTPS 로만 산다(`__Host-` 쿠키도 Secure 필수).
 * 첫 방문 뒤 브라우저가 http 로 내려가는 길(중간자의 SSL 스트리핑)을 닫는다. `preload` 는 붙이지 않는다 — 목록 등재는
 * 도메인 전체(atmark.ai)의 결정이라 콘솔 응답 하나가 정할 일이 아니다.
 */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/**
 * 홈 출처 요청의 응답에 붙는 CORS 헤더(성공·오류 모두 — 화면이 429·400 을 읽어야 한다). 출처는 **고정 값**이다(요청의
 * `Origin` 을 되비추지 않는다). `Vary: Origin` — 같은 경로가 출처에 따라 다른 헤더를 낸다.
 */
export const SITE_CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': SITE_ORIGIN,
  'access-control-allow-credentials': 'true',
};

/** 허용된 프리플라이트 — 204 · 메서드 POST · 요청 헤더 content-type 하나. */
export function preflightResponse(): AdminResponse {
  return {
    status: 204,
    headers: {
      ...BASE_HEADERS,
      ...SITE_CORS_HEADERS,
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': String(CORS_MAX_AGE_SECONDS),
      vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    },
    body: '',
  };
}

export function jsonResponse(status: number, body: unknown, cookies?: readonly string[]): AdminResponse {
  return {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8' },
    body: status === 204 ? '' : JSON.stringify(body),
    ...(cookies === undefined ? {} : { cookies }),
  };
}

/** 오류 응답 — `{error, detail}`. 스택·내부 메시지 금지. */
export function errorResponse(status: number, error: string, detail: string, cookies?: readonly string[]): AdminResponse {
  return jsonResponse(status, { error, detail }, cookies);
}

/** 페이지는 언어(쿠키 · Accept-Language)에 따라 달라진다 — 캐시가 한 언어 벌을 다른 사람에게 주지 않게. */
const PAGE_VARY = 'Cookie, Accept-Language';

/**
 * 페이지 응답(리뷰 M3). 페이지 HTML 은 `no-store` 라 매번 전부 나간다(콘솔 `/app` 약 86KB — 스타일시트·스크립트는 불변 자산으로 뺐다,
 * `assetResponse`). API Gateway HTTP API 는 압축하지 않으므로 여기서 `Accept-Encoding: gzip` 이면 gzip 해 준다. 본문은 base64(`isBase64Encoded`) · `content-encoding: gzip`.
 * 페이지는 언어별 상수라 압축 결과를 문자열마다 한 번만 만든다. `Vary` 에 `Accept-Encoding` 을 더한다(압축 여부가 요청 헤더에 달렸다).
 */
const HTML_VARY = `${PAGE_VARY}, Accept-Encoding`;
const GZIP_CACHE = new Map<string, string>();

/** `Accept-Encoding` 이 gzip(또는 `*`)을 q>0 으로 받는가. */
export function acceptsGzip(header: string | undefined): boolean {
  if (header === undefined) return false;
  return header.split(',').some((part) => {
    const [name = '', ...params] = part.trim().toLowerCase().split(';');
    if (name.trim() !== 'gzip' && name.trim() !== '*') return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

function gzipBase64(text: string): string {
  let packed = GZIP_CACHE.get(text);
  if (packed === undefined) {
    packed = gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).toString('base64');
    if (GZIP_CACHE.size >= 32) GZIP_CACHE.clear();
    GZIP_CACHE.set(text, packed);
  }
  return packed;
}

export function htmlResponse(html: string, csp: string, acceptEncoding?: string): AdminResponse {
  const headers = { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, vary: HTML_VARY };
  if (!acceptsGzip(acceptEncoding)) return { status: 200, headers, body: html };
  return { status: 200, headers: { ...headers, 'content-encoding': 'gzip' }, body: gzipBase64(html), isBase64Encoded: true };
}

/** 콘솔 정적 자산(`/_assets/<내용 해시>/<파일>` — `admin/ui/page.ts`)의 캐시 — 경로가 곧 본문이라 1년 불변. */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const ASSET_VARY = 'Accept-Encoding';

/**
 * 스타일시트·페이지 스크립트 자산. 세션·쿠키를 보지 않는 공개 정적 응답이다(내용은 페이지 HTML 에 원래 인라인으로 있던 것 — 비밀 없음).
 * `no-store` 대신 `ASSET_CACHE_CONTROL`. `cross-origin-resource-policy: same-origin` — 다른 출처의 페이지가 `<script src>` 로 끌어다 쓰지 못한다
 * (콘솔 페이지는 같은 출처라 그대로). gzip 은 페이지와 같은 규칙(`Accept-Encoding`, 문자열마다 한 번 압축).
 */
export function assetResponse(body: string, contentType: string, acceptEncoding?: string): AdminResponse {
  const headers = {
    ...BASE_HEADERS,
    'cache-control': ASSET_CACHE_CONTROL,
    'content-type': contentType,
    'cross-origin-resource-policy': 'same-origin',
    vary: ASSET_VARY,
  };
  if (!acceptsGzip(acceptEncoding)) return { status: 200, headers, body };
  return { status: 200, headers: { ...headers, 'content-encoding': 'gzip' }, body: gzipBase64(body), isBase64Encoded: true };
}

/**
 * 파비콘(콘솔 v5 — `src/ui/favicon.ts`, 홈·문서와 같은 그림). 세션·쿠키를 보지 않는 공개 정적 응답 — 해시 경로는 1년 immutable, 옛 고정
 * 경로(`/favicon.svg` 등)는 하루(`no-store` 대신). svg 는 글, ico·png 는 base64 본문(`isBase64Encoded`). 라우트 표에 오른 경로만 온다.
 */
export function faviconResponse(path: string): AdminResponse {
  const asset = faviconAsset(path);
  if (asset === undefined) return { status: 404, headers: { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' }, body: 'Not Found\n' };
  const headers = { ...BASE_HEADERS, 'cache-control': asset.cacheControl, 'content-type': asset.contentType };
  return asset.base64 ? { status: 200, headers, body: asset.body(), isBase64Encoded: true } : { status: 200, headers, body: asset.body() };
}

export function redirect(location: string, cookies?: readonly string[]): AdminResponse {
  return { status: 302, headers: { ...BASE_HEADERS, location, vary: PAGE_VARY }, body: '', ...(cookies === undefined ? {} : { cookies }) };
}

/** `__Host-` 규칙(Secure · Path=/ · Domain 없음) · SameSite=Lax · 1년. */
export function langCookie(lang: string): string {
  return `${LANG_COOKIE}=${lang}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${String(LANG_COOKIE_MAX_AGE_SECONDS)}`;
}

/** `__Host-` 규칙: Secure · Path=/ · Domain 없음. */
function hostCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${String(maxAgeSeconds)}`;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return hostCookie(SESSION_COOKIE, token, maxAgeSeconds);
}

export function clearSessionCookie(): string {
  return hostCookie(SESSION_COOKIE, '', 0);
}

export function loginBrowserCookie(nonce: string, maxAgeSeconds: number): string {
  return hostCookie(LOGIN_BROWSER_COOKIE, nonce, maxAgeSeconds);
}

export function clearLoginBrowserCookie(): string {
  return hostCookie(LOGIN_BROWSER_COOKIE, '', 0);
}

export function signupBrowserCookie(nonce: string, maxAgeSeconds: number): string {
  return hostCookie(SIGNUP_BROWSER_COOKIE, nonce, maxAgeSeconds);
}

/** `name=value` 목록 → 맵. **같은 이름이 두 번이면 버린다**(어느 값을 믿을지가 갈리면 세션 판단이 갈린다). */
export function parseCookies(event: AdminHttpEvent): Record<string, string> {
  const pairs = [...(event.cookies ?? [])];
  const header = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'cookie')?.[1];
  if (header !== undefined) pairs.push(...header.split(';'));
  const seen = new Map<string, string | null>();
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    seen.set(name, seen.has(name) && seen.get(name) !== value ? null : value);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of seen) if (value !== null) out[name] = value;
  return out;
}

// ---------------------------------------------------------------------------
// 요청 해석 — 콘솔 라우터(`router.ts`)와 조직 API 라우터(`org-api/router.ts`)가 같은 규칙을 쓴다
// ---------------------------------------------------------------------------

/** 헤더 이름을 소문자로(값이 없는 칸은 버린다). */
export function lowerHeaders(event: AdminHttpEvent): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.headers ?? {})) if (value !== undefined) out[key.toLowerCase()] = value;
  return out;
}

const PATH_PARAM = /^\{([A-Za-z]+)\}$/;

function matchPath(template: string, path: string): Record<string, string> | null {
  const a = template.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (const [index, part] of a.entries()) {
    const actual = b[index] ?? '';
    const name = PATH_PARAM.exec(part)?.[1];
    if (name !== undefined) {
      if (actual === '') return null;
      params[name] = actual;
    } else if (part !== actual) {
      return null;
    }
  }
  return params;
}

type RouteMatch<R> =
  | { readonly kind: 'found'; readonly entry: R; readonly params: Record<string, string> }
  | { readonly kind: 'rejected'; readonly response: AdminResponse };

/** 표에서 경로(`{name}` 파라미터 — 빈 값은 맞지 않는다)와 메서드를 고른다. 경로가 없으면 404 `route_not_found`, 메서드가 없으면 405 + `allow`. */
export function findRoute<R extends { readonly method: string; readonly path: string }>(routes: readonly R[], method: string, path: string): RouteMatch<R> {
  const matched: { entry: R; params: Record<string, string> }[] = [];
  for (const entry of routes) {
    const params = matchPath(entry.path, path);
    if (params !== null) matched.push({ entry, params });
  }
  if (matched.length === 0) return { kind: 'rejected', response: errorResponse(404, 'route_not_found', '이 경로는 없다.') };
  const found = matched.find((candidate) => candidate.entry.method === method);
  if (found !== undefined) return { kind: 'found', ...found };
  const allow = [...new Set(matched.map((candidate) => candidate.entry.method))].join(', ');
  const response = errorResponse(405, 'method_not_allowed', `이 경로가 받는 메서드: ${allow}`);
  return { kind: 'rejected', response: { ...response, headers: { ...response.headers, allow } } };
}

/** 요청 본문 상한 — 콘솔·조직 API 요청은 작다(seed 20개가 가장 크다). */
const MAX_ADMIN_BODY_BYTES = 64 * 1024;

/** 본문 → JSON(GET 은 크기만 보고 내용은 읽지 않는다). 상한 초과 413 · JSON 이 아닌 미디어 타입 415 · 깨진 JSON 400. 비었으면 `undefined`. */
export function readJsonBody(
  event: AdminHttpEvent,
  method: string,
  headers: Readonly<Record<string, string>>,
): { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly response: AdminResponse } {
  const encoded = event.body ?? '';
  const bytes = event.isBase64Encoded === true ? Buffer.from(encoded, 'base64') : Buffer.from(encoded, 'utf8');
  if (bytes.length > MAX_ADMIN_BODY_BYTES) return { ok: false, response: errorResponse(413, 'payload_too_large', '요청 본문이 너무 크다.') };
  const raw = method === 'GET' ? '' : bytes.toString('utf8');
  if (raw.trim() === '') return { ok: true, body: undefined };
  if (!(headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    return { ok: false, response: errorResponse(415, 'unsupported_media_type', '본문은 application/json 이다.') };
  }
  try {
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid_json', '본문이 JSON 이 아니다.') };
  }
}

/** 쿼리 문자열 → 맵. **같은 이름이 두 번이면 400**(어느 값을 믿을지가 갈리지 않게). */
export function parseQuery(
  rawQueryString: string | undefined,
): { readonly ok: true; readonly query: Record<string, string> } | { readonly ok: false; readonly response: AdminResponse } {
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawQueryString ?? '')) {
    if (Object.hasOwn(query, key)) return { ok: false, response: errorResponse(400, 'invalid_request', '같은 쿼리 파라미터가 두 번 왔다.') };
    query[key] = value;
  }
  return { ok: true, query };
}
