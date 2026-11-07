/**
 * src/domains/dc-discovery.ts — Domain Connect **발견**(스펙 "DNS Provider Discovery") — 콘솔 admin λ 의 송출 문 하나
 * (`test/arch/network-egress.arch.test.ts` 허용 목록). `node:dns/promises`(TXT · 주소) + `node:https`(설정 · 템플릿 지원 GET).
 *
 *   1. TXT `_domainconnect.<registrable>` → URL 접두(예 `api.cloudflare.com/client/v4/dns/domainconnect`).
 *   2. `GET https://{접두}/v2/{registrable}/settings` → `providerName` · `urlSyncUX` · `urlAPI`(업체가 그 존을 맡지 않으면 404).
 *   3. `GET {urlAPI}/v2/domainTemplates/providers/atmark.ai/services/{serviceId}` → 200 = 그 업체가 우리 템플릿을 안다.
 *
 * **SSRF 방어**(업체 응답·고객 DNS 가 URL 을 정한다 — 둘 다 신뢰하지 않는다): https 만 · 자격·조각 없음 · 호스트는 IP 리터럴이 아닌 공개 DNS
 * 이름(점 없음 · localhost · .internal 류 거부) · **주소를 풀어 전부 공인일 때만**(`classifyAddress` — 웹훅과 같은 허용 목록) 그 IP 로
 * **고정 연결**(재바인딩 창 없음 — `lookup` 고정, SNI·인증서는 원래 이름) · 리다이렉트 따라가지 않음(Node 기본) · 요청 하나 3초 · 응답 32KB 상한 ·
 * 커넥션 재사용 없음. 결과는 메모리에 5분 캐시(실행 환경당 — 긍정·부정 모두, 항목 상한).
 * 실패는 전부 `supported:false` + 사유 코드(값·URL·도메인은 로그에 남기지 않는다 — 호출자가 사유 코드만 남긴다).
 */

import { lookup as dnsLookup, resolveTxt as dnsResolveTxt } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import { classifyAddress } from '../webhooks/destination';
import { DC_PROVIDER_ID } from './dc-url';

const DC_HTTP_TIMEOUT_MS = 3_000;
const DC_MAX_RESPONSE_BYTES = 32 * 1024;
export const DC_CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 500;

export type DiscoveryFailure =
  | 'no_domainconnect_record'
  | 'bad_domainconnect_record'
  | 'blocked_destination'
  | 'dns_failure'
  | 'settings_unavailable'
  | 'bad_settings'
  | 'template_unsupported'
  | 'network_error';

export type DiscoveryResult =
  | { readonly supported: true; readonly providerName: string; readonly urlSyncUX: string }
  | { readonly supported: false; readonly reason: DiscoveryFailure };

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface HttpGetResult {
  readonly status: number;
  /** 200 이고 JSON 이면 그 값, 아니면 `null`. */
  readonly json: unknown;
}

/** 네트워크 면 — 테스트는 가짜를 준다. 운영은 `systemDiscoveryPorts`. */
export interface DiscoveryPorts {
  resolveTxt(name: string): Promise<string[][]>;
  resolveAddresses(hostname: string): Promise<readonly ResolvedAddress[]>;
  /** 검사를 통과한 주소로 **고정** 연결해 GET. */
  getJson(url: URL, pinned: ResolvedAddress): Promise<HttpGetResult>;
  now(): number;
}

const PREFIX_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\/[A-Za-z0-9._~-]+)*\/?$/i;
const PROVIDER_NAME_SHAPE = /^[\p{L}\p{N} .,&()'_-]{1,64}$/u;

function isInternalHostname(hostname: string): boolean {
  const name = hostname.replace(/\.$/, '').toLowerCase();
  if (!name.includes('.')) return true;
  return ['localhost', 'local', 'internal', 'localdomain', 'home.arpa', 'arpa'].some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/** 정적 검사 — https · 자격·조각 없음 · IP 리터럴 아님 · 내부 이름 아님. 통과하면 URL. */
export function checkDiscoveryUrl(raw: string): URL | null {
  if (raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '' || url.port !== '') return null;
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (bare === '' || isIP(bare) !== 0 || isInternalHostname(bare)) return null;
  return url;
}

type GetOutcome = { readonly kind: 'ok'; readonly result: HttpGetResult } | { readonly kind: 'failed'; readonly reason: DiscoveryFailure };

/** 검사 → 해석(한 번) → 전부 공인일 때만 첫 주소로 고정 GET. */
async function safeGet(ports: DiscoveryPorts, raw: string): Promise<GetOutcome> {
  const url = checkDiscoveryUrl(raw);
  if (url === null) return { kind: 'failed', reason: 'blocked_destination' };
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await ports.resolveAddresses(url.hostname);
  } catch {
    return { kind: 'failed', reason: 'dns_failure' };
  }
  const [first] = addresses;
  if (first === undefined) return { kind: 'failed', reason: 'dns_failure' };
  if (addresses.some((entry) => classifyAddress(entry.address).kind !== 'public')) return { kind: 'failed', reason: 'blocked_destination' };
  try {
    return { kind: 'ok', result: await ports.getJson(url, first) };
  } catch {
    return { kind: 'failed', reason: 'network_error' };
  }
}

interface Settings {
  readonly providerName: string;
  readonly urlSyncUX: string;
  readonly urlAPI: string;
}

function settingsOf(json: unknown): Settings | null {
  if (typeof json !== 'object' || json === null) return null;
  const record = json as Record<string, unknown>;
  const { providerName, urlSyncUX, urlAPI } = record;
  if (typeof providerName !== 'string' || !PROVIDER_NAME_SHAPE.test(providerName)) return null;
  if (typeof urlSyncUX !== 'string' || typeof urlAPI !== 'string') return null;
  // urlSyncUX 는 사용자 브라우저가 갈 곳(서버는 부르지 않는다) — 그래도 https 공개 이름만.
  if (checkDiscoveryUrl(urlSyncUX) === null || checkDiscoveryUrl(urlAPI) === null) return null;
  return { providerName, urlSyncUX, urlAPI };
}

const trimSlash = (value: string): string => value.replace(/\/+$/, '');

/** 발견기 — 실행 환경당 하나(캐시를 품는다). */
export interface DomainConnectDiscovery {
  discover(registrable: string, serviceId: string): Promise<DiscoveryResult>;
}

export function createDomainConnectDiscovery(ports: DiscoveryPorts): DomainConnectDiscovery {
  const settingsCache = new Map<string, { readonly at: number; readonly value: Settings | DiscoveryFailure }>();
  const templateCache = new Map<string, { readonly at: number; readonly value: boolean | DiscoveryFailure }>();

  function remember<V>(cache: Map<string, { readonly at: number; readonly value: V }>, key: string, value: V): V {
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: ports.now(), value });
    return value;
  }
  function recall<V>(cache: Map<string, { readonly at: number; readonly value: V }>, key: string): V | undefined {
    const hit = cache.get(key);
    if (hit === undefined) return undefined;
    if (ports.now() - hit.at > DC_CACHE_TTL_MS) {
      cache.delete(key);
      return undefined;
    }
    return hit.value;
  }

  async function settingsFor(registrable: string): Promise<Settings | DiscoveryFailure> {
    const cached = recall(settingsCache, registrable);
    if (cached !== undefined) return cached;
    let records: string[][];
    try {
      records = await ports.resolveTxt(`_domainconnect.${registrable}`);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return remember(settingsCache, registrable, code === 'ENOTFOUND' || code === 'ENODATA' ? 'no_domainconnect_record' : 'dns_failure');
    }
    const prefix = records.map((chunks) => chunks.join('').trim()).find((value) => value !== '');
    if (prefix === undefined) return remember(settingsCache, registrable, 'no_domainconnect_record');
    if (prefix.length > 253 || !PREFIX_SHAPE.test(prefix)) return remember(settingsCache, registrable, 'bad_domainconnect_record');
    const outcome = await safeGet(ports, `https://${trimSlash(prefix)}/v2/${registrable}/settings`);
    if (outcome.kind === 'failed') return remember(settingsCache, registrable, outcome.reason);
    if (outcome.result.status !== 200) return remember(settingsCache, registrable, 'settings_unavailable');
    return remember(settingsCache, registrable, settingsOf(outcome.result.json) ?? 'bad_settings');
  }

  async function templateSupported(urlAPI: string, serviceId: string): Promise<boolean | DiscoveryFailure> {
    const key = `${urlAPI}\u0000${serviceId}`;
    const cached = recall(templateCache, key);
    if (cached !== undefined) return cached;
    const outcome = await safeGet(ports, `${trimSlash(urlAPI)}/v2/domainTemplates/providers/${DC_PROVIDER_ID}/services/${encodeURIComponent(serviceId)}`);
    if (outcome.kind === 'failed') return remember(templateCache, key, outcome.reason);
    return remember(templateCache, key, outcome.result.status === 200);
  }

  return {
    async discover(registrable, serviceId) {
      const settings = await settingsFor(registrable.toLowerCase());
      if (typeof settings === 'string') return { supported: false, reason: settings };
      const template = await templateSupported(settings.urlAPI, serviceId);
      if (typeof template === 'string') return { supported: false, reason: template };
      if (!template) return { supported: false, reason: 'template_unsupported' };
      return { supported: true, providerName: settings.providerName, urlSyncUX: settings.urlSyncUX };
    },
  };
}

// ---------------------------------------------------------------------------
// 운영 네트워크 면
// ---------------------------------------------------------------------------

function pinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

/** 고정 주소로 GET 하나 — 리다이렉트 없음 · 커넥션 재사용 없음 · 시간·크기 상한. 200 이면 JSON 을 읽는다(아니면 본문을 버린다). */
function pinnedGetJson(url: URL, pinned: ResolvedAddress): Promise<HttpGetResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: 'https:',
        hostname: url.hostname,
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        lookup: pinnedLookup(pinned),
        headers: { accept: 'application/json', 'user-agent': 'Atmark-DomainConnect/1 (+https://atmark.ai)' },
        timeout: DC_HTTP_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.resume();
          res.destroy();
          resolve({ status, json: null });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > DC_MAX_RESPONSE_BYTES) {
            req.destroy(new Error('response_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve({ status, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
          } catch {
            resolve({ status, json: null });
          }
        });
        res.on('error', reject);
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), DC_HTTP_TIMEOUT_MS);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

export function systemDiscoveryPorts(): DiscoveryPorts {
  return {
    resolveTxt: (name) => dnsResolveTxt(name),
    resolveAddresses: async (hostname) => {
      const results = await dnsLookup(hostname, { all: true, verbatim: true });
      return results.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
    },
    getJson: pinnedGetJson,
    now: () => Date.now(),
  };
}
