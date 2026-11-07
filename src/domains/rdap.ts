/**
 * src/domains/rdap.ts — 도메인 등록 만료일 조회(RDAP, WHOIS 의 후속 표준 · JSON). `scripts/check-domain-expiry.ts`(atmark.ai 감시, ADR-0002 F6)와
 * domain-control λ(고객 apex 의 만료일만 — 계획 §3.13 · 계약 `check_expiry`)가 쓴다.
 *
 * 규칙:
 *   - 외부 패키지 없이 `node:https` 만. 리다이렉트는 **https 로만** 따라가고 횟수 상한이 있다. 응답 크기 상한(1 MiB)과 시간 상한이 있다.
 *   - **등록자 정보는 읽지도 싣지도 않는다** — 응답에서 `ldhName`·`events`·`status` 만 남기고 나머지(엔티티·연락처)는 버린다.
 *   - 오류는 코드(`RdapError.code`)로 — domain-control 은 코드만 `errorCode` 로 싣는다(값·URL 없음).
 */

import { get } from 'node:https';

export interface RdapEvent {
  readonly eventAction?: string;
  readonly eventDate?: string;
}

/** RDAP 도메인 응답 중 남기는 칸(등록자·연락처 없음). */
export interface RdapDomain {
  readonly ldhName?: string;
  readonly events?: readonly RdapEvent[];
  readonly status?: readonly string[];
}

export type RdapErrorCode = 'rdap_timeout' | 'rdap_http' | 'rdap_not_found' | 'rdap_not_json' | 'rdap_redirects' | 'rdap_insecure_redirect' | 'rdap_too_large' | 'rdap_network';

export class RdapError extends Error {
  constructor(
    readonly code: RdapErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RdapError';
  }
}

export interface RdapOptions {
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxBytes?: number;
  readonly userAgent?: string;
  /**
   * 조회 **전체**(끝점 여럿 · 리다이렉트 포함)의 마감(ms, 보안 리뷰 L4). 넘으면 진행 중인 요청을 끊고 `rdap_timeout`. 없으면 마감 없음(스크립트).
   * domain-control 은 λ 12초 · 호출 상한 10초 안에 끝나도록 준다.
   */
  readonly deadlineMs?: number;
}

const RDAP_DEFAULT_TIMEOUT_MS = 10_000;
const RDAP_DEFAULT_MAX_REDIRECTS = 5;
const RDAP_MAX_BYTES = 1024 * 1024;

/** IANA 부트스트랩을 대신 해 주는 rdap.org — 레지스트리 RDAP 로 리다이렉트한다. TLD 를 모르면 404. */
export function rdapOrgEndpoint(domain: string): string {
  return `https://rdap.org/domain/${encodeURIComponent(domain)}`;
}

function fetchJson(url: string, redirectsLeft: number, options: ResolvedOptions): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = get(url, { headers: { accept: 'application/rdap+json, application/json', 'user-agent': options.userAgent } }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;

      if (status >= 300 && status < 400 && typeof location === 'string') {
        res.resume();
        if (redirectsLeft <= 0) {
          rejectPromise(new RdapError('rdap_redirects', `리다이렉트 한도 초과: ${url}`));
          return;
        }
        const next = new URL(location, url);
        if (next.protocol !== 'https:') {
          rejectPromise(new RdapError('rdap_insecure_redirect', `https 가 아닌 리다이렉트: ${url}`));
          return;
        }
        resolvePromise(fetchJson(next.toString(), redirectsLeft - 1, options));
        return;
      }

      if (status !== 200) {
        res.resume();
        rejectPromise(new RdapError(status === 404 ? 'rdap_not_found' : 'rdap_http', `HTTP ${String(status)} — ${url}`));
        return;
      }

      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > options.maxBytes) {
          req.destroy(new RdapError('rdap_too_large', `응답이 ${String(options.maxBytes)}바이트를 넘는다 — ${url}`));
          return;
        }
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolvePromise(JSON.parse(body) as unknown);
        } catch {
          rejectPromise(new RdapError('rdap_not_json', `RDAP 응답이 JSON이 아니다 — ${url}`));
        }
      });
    });

    options.signal.addEventListener('abort', () => req.destroy(new RdapError('rdap_timeout', `마감 — ${url}`)), { once: true });
    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new RdapError('rdap_timeout', `타임아웃 ${String(options.timeoutMs)}ms — ${url}`));
    });
    req.on('error', (error) => {
      rejectPromise(error instanceof RdapError ? error : new RdapError('rdap_network', `${error.message} — ${url}`));
    });
  });
}

/** 등록자·연락처를 버리고 남길 칸만 옮긴다. */
function project(raw: unknown): RdapDomain | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const events = Array.isArray(record['events'])
    ? (record['events'] as unknown[])
        .filter((event): event is Record<string, unknown> => typeof event === 'object' && event !== null)
        .map((event): RdapEvent => ({
          ...(typeof event['eventAction'] === 'string' ? { eventAction: event['eventAction'] } : {}),
          ...(typeof event['eventDate'] === 'string' ? { eventDate: event['eventDate'] } : {}),
        }))
    : undefined;
  const status = Array.isArray(record['status']) ? (record['status'] as unknown[]).filter((s): s is string => typeof s === 'string') : undefined;
  return {
    ...(typeof record['ldhName'] === 'string' ? { ldhName: record['ldhName'] } : {}),
    ...(events === undefined ? {} : { events }),
    ...(status === undefined ? {} : { status }),
  };
}

/**
 * 끝점을 차례로 묻는다 — 첫 성공을 돌려주고, 전부 실패하면 **마지막 실패의 코드**로 던진다(메시지에는 끝점별 사유를 모은다 — 스크립트가 출력한다).
 */
export async function lookupRdapDomain(endpoints: readonly string[], options: RdapOptions = {}): Promise<RdapDomain> {
  const controller = new AbortController();
  const timer = options.deadlineMs === undefined ? undefined : setTimeout(() => controller.abort(), options.deadlineMs);
  try {
    return await lookupWithin(endpoints, {
      timeoutMs: options.timeoutMs ?? RDAP_DEFAULT_TIMEOUT_MS,
      maxRedirects: options.maxRedirects ?? RDAP_DEFAULT_MAX_REDIRECTS,
      maxBytes: options.maxBytes ?? RDAP_MAX_BYTES,
      userAgent: options.userAgent ?? 'atmark-rdap/1.0',
      signal: controller.signal,
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface ResolvedOptions {
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly maxBytes: number;
  readonly userAgent: string;
  readonly signal: AbortSignal;
}

async function lookupWithin(endpoints: readonly string[], resolved: ResolvedOptions): Promise<RdapDomain> {
  const errors: string[] = [];
  let lastCode: RdapErrorCode = 'rdap_network';
  for (const endpoint of endpoints) {
    if (resolved.signal.aborted) {
      lastCode = 'rdap_timeout';
      errors.push(`${endpoint}: 마감`);
      break;
    }
    try {
      const doc = project(await fetchJson(endpoint, resolved.maxRedirects, resolved));
      if (doc !== null) return doc;
      lastCode = 'rdap_not_json';
      errors.push(`${endpoint}: 예상치 못한 응답 형태`);
    } catch (error: unknown) {
      lastCode = error instanceof RdapError ? error.code : 'rdap_network';
      errors.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new RdapError(lastCode, `RDAP 조회 실패\n  - ${errors.join('\n  - ')}`);
}

/** `expiration` 이벤트의 날짜(없거나 날짜가 아니면 `null`). */
export function findExpiration(doc: RdapDomain): Date | null {
  for (const event of doc.events ?? []) {
    if (event.eventAction === 'expiration' && typeof event.eventDate === 'string') {
      const parsed = new Date(event.eventDate);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  return null;
}

/** domain-control `check_expiry` 의 판정 — 만료일 · TLD 미지원(404) · 오류(코드). */
export type RdapExpiryResult =
  | { readonly kind: 'ok'; readonly expiresAt: Date }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'error'; readonly code: string };

export async function rdapExpiration(domain: string, options: RdapOptions = {}): Promise<RdapExpiryResult> {
  try {
    const expiresAt = findExpiration(await lookupRdapDomain([rdapOrgEndpoint(domain)], options));
    return expiresAt === null ? { kind: 'error', code: 'rdap_no_expiration' } : { kind: 'ok', expiresAt };
  } catch (error) {
    const code = error instanceof RdapError ? error.code : 'rdap_network';
    return code === 'rdap_not_found' ? { kind: 'unsupported' } : { kind: 'error', code };
  }
}
