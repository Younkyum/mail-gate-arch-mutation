/**
 * src/ops/hosted/http.ts — 호스팅 운영자 콘솔(`ops.atmark.ai`)의 요청·응답 모양, 보안 헤더, `__Host-` 쿠키, 요청 검문(Host · Origin · Sec-Fetch-Site ·
 * CSRF). 순수 함수만 — 라우터(`app.ts`)가 요청마다 부르고 테스트가 직접 부른다. `.omc/plans/ops-console.md` §3.7.
 *
 * - Host 는 정확히 `ops.atmark.ai` 하나. 다른 Host(execute-api 기본 엔드포인트 포함)는 **421**(요청을 다른 호스트로 보냈다).
 * - 변경 요청(POST)은 `Origin` 이 정확히 `https://ops.atmark.ai` 여야 하고, 세션 뒤 요청은 CSRF 헤더(`x-atmark-ops-csrf`)가 세션 토큰에서
 *   파생한 값과 같아야 한다. `Sec-Fetch-Site` 가 있으면 `same-origin`(페이지 탐색만 `none`). CORS 헤더는 0 이다.
 * - 쿠키 둘(`__Host-` — Secure · Path=/ · Domain 없음 · HttpOnly · SameSite=Strict).
 * - 헤더: HSTS · no-store · nosniff · no-referrer · DENY · COOP/CORP · noindex. 페이지는 해시 CSP(+ trusted types, `console/page.ts`).
 * 응답에 스택·내부 메시지를 싣지 않는다 — `{error, detail}` 뿐.
 */

import { OPS_COOKIES, OPS_CSRF_HEADER, OPS_DOMAIN_NAME, OPS_ORIGIN } from '../contract';

/** API Gateway HTTP API payload v2 중 읽는 필드. */
export interface OpsHttpEvent {
  readonly rawPath: string;
  readonly rawQueryString?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly cookies?: readonly string[];
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext: {
    readonly requestId: string;
    readonly domainName?: string;
    readonly http: { readonly method: string; readonly sourceIp?: string; readonly userAgent?: string };
  };
}

export interface OpsHttpResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly cookies?: readonly string[];
  readonly body: string;
  readonly isBase64Encoded: boolean;
}

export const BASE_HEADERS: Readonly<Record<string, string>> = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-robots-tag': 'noindex, nofollow',
};

/** JSON·글 응답의 CSP — 문서로 열려도 아무것도 돌지 않는다. */
export const PLAIN_CSP = "default-src 'none'; frame-ancestors 'none'";

/** 본문 상한 — 가장 큰 본문은 확인 입력이 붙은 쓰기(수백 바이트). */
export const MAX_BODY_BYTES = 8 * 1024;

function result(status: number, contentType: string, csp: string, body: string): OpsHttpResult {
  return { statusCode: status, headers: { ...BASE_HEADERS, 'content-type': contentType, 'content-security-policy': csp }, body, isBase64Encoded: false };
}

export function jsonResult(status: number, body: unknown, cookies?: readonly string[]): OpsHttpResult {
  const json = result(status, 'application/json; charset=utf-8', PLAIN_CSP, JSON.stringify(body));
  return cookies === undefined || cookies.length === 0 ? json : { ...json, cookies };
}

export function errorResult(status: number, error: string, detail: string, cookies?: readonly string[]): OpsHttpResult {
  return jsonResult(status, { error, detail }, cookies);
}

export function textResult(status: number, text: string): OpsHttpResult {
  return result(status, 'text/plain; charset=utf-8', PLAIN_CSP, text);
}

export function htmlResult(html: string, csp: string): OpsHttpResult {
  return result(200, 'text/html; charset=utf-8', csp, html);
}

/** `__Host-` 규칙: Secure · Path=/ · Domain 없음 · HttpOnly · SameSite=Strict. */
function hostCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${String(maxAgeSeconds)}`;
}

export const sessionCookie = (token: string, maxAgeSeconds: number): string => hostCookie(OPS_COOKIES.session, token, maxAgeSeconds);
export const clearSessionCookie = (): string => hostCookie(OPS_COOKIES.session, '', 0);
export const loginCookie = (nonce: string, maxAgeSeconds: number): string => hostCookie(OPS_COOKIES.login, nonce, maxAgeSeconds);
export const clearLoginCookie = (): string => hostCookie(OPS_COOKIES.login, '', 0);

/** 헤더 한 개(대소문자 무관). */
export function header(event: OpsHttpEvent, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

/** `name=value` 목록 → 맵. **같은 이름이 다른 값으로 두 번이면 버린다**(어느 값을 믿을지가 갈리면 세션 판단이 갈린다). */
export function parseCookies(event: OpsHttpEvent): Record<string, string> {
  const pairs = [...(event.cookies ?? [])];
  const raw = header(event, 'cookie');
  if (raw !== undefined) pairs.push(...raw.split(';'));
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

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly status: 403 | 421; readonly code: string };

const deny = (status: 403 | 421, code: string): Verdict => ({ ok: false, status, code });

/**
 * Host 검문 — **모든 요청의 첫 판단.** `Host` 헤더와 API Gateway 의 `domainName`(있으면) 둘 다 `ops.atmark.ai` 여야 한다. execute-api 기본
 * 엔드포인트로 온 요청(도메인을 붙이기 전 · 기본 엔드포인트를 끄기 전)은 421 이다.
 */
export function checkHost(event: OpsHttpEvent): Verdict {
  const host = header(event, 'host');
  if (host !== OPS_DOMAIN_NAME) return deny(421, 'misdirected_request');
  const domain = event.requestContext.domainName;
  if (domain !== undefined && domain !== OPS_DOMAIN_NAME) return deny(421, 'misdirected_request');
  return { ok: true };
}

/**
 * 출처 검문. `navigation`(페이지 `GET /`)만 `Sec-Fetch-Site: none` 을 받는다. 변경 요청은 `Origin` 이 **있고** 정확히 같아야 한다.
 * 읽기(GET /api/*)는 `Origin` 이 있으면 같아야 한다(CORS 0 이라 교차 출처는 응답을 못 읽지만, 서버도 받지 않는다).
 */
export function checkOrigin(event: OpsHttpEvent, navigation: boolean): Verdict {
  const method = event.requestContext.http.method.toUpperCase();
  const origin = header(event, 'origin');
  const site = header(event, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && !(navigation && site === 'none')) return deny(403, 'cross_site');
  const mutation = method !== 'GET' && method !== 'HEAD';
  if (origin !== OPS_ORIGIN && (mutation || origin !== undefined)) return deny(403, 'origin_mismatch');
  return { ok: true };
}

/** CSRF 헤더 값(세션 뒤 변경 요청). */
export function csrfHeader(event: OpsHttpEvent): string | undefined {
  return header(event, OPS_CSRF_HEADER);
}

/** 요청 본문(JSON 객체). content-type 이 JSON 이 아니거나 너무 크거나 객체가 아니면 `null`. */
export function readJsonBody(event: OpsHttpEvent): Record<string, unknown> | null {
  const type = header(event, 'content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) return null;
  const raw = event.body === undefined ? '' : event.isBase64Encoded === true ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
