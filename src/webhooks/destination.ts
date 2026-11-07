/**
 * src/webhooks/destination.ts — 웹훅 목적지 검사 (SSRF 방어). **I/O 가 없다.**
 *
 * 웹훅 URL 은 에이전트 소유자가 적는 문자열이고, 우리 서버가 그 주소로 **요청을 보낸다.**
 * 검사가 없으면 "Atmark 서버를 시켜 내부망을 두드리는" 기능이 된다:
 *   - `169.254.169.254` — 클라우드 인스턴스 메타데이터. IAM 자격증명이 거기 있다.
 *   - `127.0.0.1`·`10.0.0.0/8`·사설 대역 — VPC 안의 관리 포트, DB, 내부 API.
 *   - IPv6 루프백·링크로컬·ULA(`fd00:ec2::254` 는 EC2 IMDS 의 IPv6 주소다).
 *
 * ---------------------------------------------------------------------------
 * ## 규칙은 차단 목록이 아니라 **허용 목록**이다
 * ---------------------------------------------------------------------------
 *
 *   - IPv4: 특수 용도 대역(IANA special-purpose registry)을 전부 막고 나머지를 공인으로 본다.
 *   - IPv6: **`2000::/3`(global unicast) 안만** 허용하고 그 안의 특수 대역을 다시 막는다.
 *     그 밖(루프백 `::1`, 미지정 `::`, IPv4-mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96`,
 *     ULA `fc00::/7`, 링크로컬 `fe80::/10`, 멀티캐스트)은 **이름을 붙이기 전에 이미 밖이다.**
 *     차단 목록으로 IPv6 를 다루면 IPv4 를 품은 표기(mapped·NAT64·6to4·Teredo)를 하나씩
 *     떠올려야 하고, 하나를 잊으면 `::ffff:169.254.169.254` 가 통과한다.
 *
 * 표기 우회(`0x7f.1`, `2130706433`, `0177.0.0.1`)는 WHATWG URL 파서가 `127.0.0.1` 로
 * 정규화한 **뒤에** 검사하므로 따로 다루지 않는다(테스트가 그 전제를 고정한다).
 *
 * ---------------------------------------------------------------------------
 * ## DNS 재바인딩 — 검사한 IP 로 **연결한다**
 * ---------------------------------------------------------------------------
 *
 * 호스트명을 검사 시점에 한 번 풀고, 연결 시점에 전송단이 **다시** 풀면 그 사이에 DNS
 * 응답이 바뀔 수 있다(TTL 0 으로 첫 응답은 공인 IP, 두 번째는 `169.254.169.254`).
 * 그래서 `resolveDestination` 은 검사를 통과한 IP 하나를 **고정(pin)** 해 돌려주고,
 * 전송단(`https-transport.ts`)은 DNS 를 부르지 않고 그 IP 로 소켓을 연다.
 * 호스트명은 TLS SNI·인증서 검증·`Host` 헤더에만 쓰인다.
 *
 * 응답에 주소가 여럿이면 **하나라도 막힌 대역이면 거부**한다. 공인 IP 만 골라 쓰는 쪽이
 * 가용성은 낫지만, 공인+내부를 섞어 돌려주는 응답은 그 자체로 탐침 신호다.
 */

import { isIPv4, isIPv6 } from 'node:net';

// ---------------------------------------------------------------------------
// 주소 분류
// ---------------------------------------------------------------------------

export type AddressClass =
  | { readonly kind: 'public' }
  | { readonly kind: 'blocked'; readonly range: string };

interface Cidr4 {
  readonly base: number;
  readonly bits: number;
  readonly range: string;
}

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function cidr4(text: string, range: string): Cidr4 {
  const [base = '', bits = ''] = text.split('/');
  return { base: ipv4ToInt(base), bits: Number(bits), range };
}

/** IANA IPv4 Special-Purpose Address Registry + 멀티캐스트·예약. */
const BLOCKED_IPV4: readonly Cidr4[] = [
  cidr4('0.0.0.0/8', 'this_network'),
  cidr4('10.0.0.0/8', 'private'),
  cidr4('100.64.0.0/10', 'shared_cgnat'), // Alibaba 메타데이터 100.100.100.200 이 여기 있다
  cidr4('127.0.0.0/8', 'loopback'),
  cidr4('169.254.0.0/16', 'link_local'), // AWS·GCP·Azure 메타데이터 169.254.169.254
  cidr4('172.16.0.0/12', 'private'),
  cidr4('192.0.0.0/24', 'ietf_protocol'),
  cidr4('192.0.2.0/24', 'documentation'),
  cidr4('192.88.99.0/24', 'relay_6to4'),
  cidr4('192.168.0.0/16', 'private'),
  cidr4('198.18.0.0/15', 'benchmarking'),
  cidr4('198.51.100.0/24', 'documentation'),
  cidr4('203.0.113.0/24', 'documentation'),
  cidr4('224.0.0.0/4', 'multicast'),
  cidr4('240.0.0.0/4', 'reserved'), // 255.255.255.255 포함
];

function inCidr4(value: number, cidr: Cidr4): boolean {
  const size = 2 ** (32 - cidr.bits);
  return Math.floor(value / size) === Math.floor(cidr.base / size);
}

function classifyIPv4(address: string): AddressClass {
  const value = ipv4ToInt(address);
  const hit = BLOCKED_IPV4.find((cidr) => inCidr4(value, cidr));
  return hit === undefined ? { kind: 'public' } : { kind: 'blocked', range: hit.range };
}

/** IPv6 문자열 → 128비트 정수. `::` 축약과 끝의 IPv4 표기(`::ffff:1.2.3.4`)를 푼다. */
function ipv6ToBigInt(address: string): bigint {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);

  // 끝이 IPv4 표기면 16비트 두 조각으로 바꾼다.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    text = `${text.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const [head = '', rest] = text.split('::', 2);
  const headGroups = head === '' ? [] : head.split(':');
  const restGroups = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = 8 - headGroups.length - restGroups.length;
  const groups = rest === undefined ? headGroups : [...headGroups, ...Array<string>(missing).fill('0'), ...restGroups];

  return groups.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group, 16)), 0n);
}

interface Cidr6 {
  readonly base: bigint;
  readonly bits: number;
  readonly range: string;
}

function cidr6(text: string, range: string): Cidr6 {
  const [base = '', bits = ''] = text.split('/');
  return { base: ipv6ToBigInt(base), bits: Number(bits), range };
}

function inCidr6(value: bigint, cidr: Cidr6): boolean {
  const shift = BigInt(128 - cidr.bits);
  return value >> shift === cidr.base >> shift;
}

/** 허용 대역. 이 밖은 전부 막힌다. */
const GLOBAL_UNICAST = cidr6('2000::/3', 'global_unicast');

/** 허용 대역 **안**의 특수 용도. */
const BLOCKED_IPV6_IN_GLOBAL: readonly Cidr6[] = [
  cidr6('2001:db8::/32', 'documentation'),
  cidr6('2001::/23', 'ietf_protocol'), // Teredo 2001::/32 — IPv4 를 품는다
  cidr6('2002::/16', 'embedded_6to4'), // 6to4 — IPv4 를 품는다
  cidr6('3fff::/20', 'documentation'),
];

/** 허용 대역 **밖**을 진단용으로 이름 붙인다. 이름이 없어도 막힌다(`reserved`). */
const NAMED_IPV6_OUTSIDE: readonly Cidr6[] = [
  cidr6('::/128', 'unspecified'),
  cidr6('::1/128', 'loopback'),
  cidr6('::ffff:0:0/96', 'ipv4_mapped'),
  cidr6('64:ff9b::/96', 'nat64'),
  cidr6('fc00::/7', 'unique_local'), // EC2 IMDS IPv6 fd00:ec2::254
  cidr6('fe80::/10', 'link_local'),
  cidr6('ff00::/8', 'multicast'),
];

function classifyIPv6(address: string): AddressClass {
  const value = ipv6ToBigInt(address);
  if (!inCidr6(value, GLOBAL_UNICAST)) {
    const named = NAMED_IPV6_OUTSIDE.find((cidr) => inCidr6(value, cidr));
    return { kind: 'blocked', range: named?.range ?? 'reserved' };
  }
  const hit = BLOCKED_IPV6_IN_GLOBAL.find((cidr) => inCidr6(value, cidr));
  return hit === undefined ? { kind: 'public' } : { kind: 'blocked', range: hit.range };
}

/** IP 문자열 하나의 분류. IP 가 아니면 막는다 — 모르는 것은 공인이 아니다. */
export function classifyAddress(address: string): AddressClass {
  if (isIPv4(address)) return classifyIPv4(address);
  if (isIPv6(address)) return classifyIPv6(address);
  return { kind: 'blocked', range: 'not_an_ip' };
}

// ---------------------------------------------------------------------------
// URL 검사 (등록 시점과 전달 시점 둘 다)
// ---------------------------------------------------------------------------

/** URL 상한. 쿼리스트링에 뭔가를 실어 오는 것까지 막지는 않지만 무한은 아니다. */
const MAX_WEBHOOK_URL_LENGTH = 2048;

export type WebhookUrlRejection =
  | 'invalid_url'
  | 'not_https'
  | 'credentials_in_url'
  | 'fragment_in_url'
  | 'internal_hostname'
  | 'blocked_address';

export type WebhookUrlCheck =
  | { readonly kind: 'ok'; readonly url: URL; readonly hostname: string; readonly literal: string | null }
  | { readonly kind: 'rejected'; readonly reason: WebhookUrlRejection; readonly range?: string };

/** URL 의 호스트가 IP 리터럴이면 그 IP(대괄호 제거), 아니면 `null`. */
function literalAddress(hostname: string): string | null {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return isIPv4(bare) || isIPv6(bare) ? bare : null;
}

/**
 * 내부 이름. **점이 없는 이름**도 막는다 — 리졸버의 search domain 이 붙어
 * `metadata` → `metadata.google.internal` 처럼 내부 이름으로 풀린다.
 */
function isInternalHostname(hostname: string): boolean {
  const name = hostname.replace(/\.$/, '');
  if (!name.includes('.')) return true;
  return ['localhost', 'local', 'internal', 'localdomain', 'home.arpa'].some(
    (suffix) => name === suffix || name.endsWith(`.${suffix}`),
  );
}

/** 정적 검사. DNS 를 부르지 않는다 — 등록 API 가 즉시 400 을 돌려줄 수 있게. */
export function checkWebhookUrl(raw: string): WebhookUrlCheck {
  if (raw.length > MAX_WEBHOOK_URL_LENGTH) return { kind: 'rejected', reason: 'invalid_url' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'rejected', reason: 'invalid_url' };
  }
  // http 를 열면 서명 헤더와 본문이 평문으로 지나가고, 중간자가 재생할 수 있다.
  if (url.protocol !== 'https:') return { kind: 'rejected', reason: 'not_https' };
  if (url.username !== '' || url.password !== '') return { kind: 'rejected', reason: 'credentials_in_url' };
  if (url.hash !== '') return { kind: 'rejected', reason: 'fragment_in_url' };
  if (url.hostname === '') return { kind: 'rejected', reason: 'invalid_url' };

  const literal = literalAddress(url.hostname);
  if (literal !== null) {
    const verdict = classifyAddress(literal);
    if (verdict.kind === 'blocked') return { kind: 'rejected', reason: 'blocked_address', range: verdict.range };
    return { kind: 'ok', url, hostname: literal, literal };
  }
  if (isInternalHostname(url.hostname)) return { kind: 'rejected', reason: 'internal_hostname' };
  return { kind: 'ok', url, hostname: url.hostname, literal: null };
}

// ---------------------------------------------------------------------------
// 해석 + 고정 (전달 시점)
// ---------------------------------------------------------------------------

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** 호스트명 → 주소 전부. 실제 구현은 `https-transport.ts` 에 있다(네트워크 I/O 는 그 파일 하나). */
export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export type PinnedDestination =
  | {
      readonly kind: 'pinned';
      readonly url: URL;
      /** SNI·인증서 검증·Host 헤더용. 연결에는 쓰지 않는다. */
      readonly hostname: string;
      /** 검사를 통과한, **연결할** IP. */
      readonly address: string;
      readonly family: 4 | 6;
    }
  | { readonly kind: 'rejected'; readonly reason: WebhookUrlRejection; readonly range?: string }
  | { readonly kind: 'dns_failure' };

/**
 * URL → 연결할 IP 하나. **리졸버를 정확히 한 번 부른다** — 두 번 부르는 설계(검사용 1회,
 * 연결용 1회)가 곧 재바인딩 창이다.
 */
export async function resolveDestination(raw: string, resolve: HostResolver): Promise<PinnedDestination> {
  const checked = checkWebhookUrl(raw);
  if (checked.kind === 'rejected') return checked;

  if (checked.literal !== null) {
    return {
      kind: 'pinned',
      url: checked.url,
      hostname: checked.hostname,
      address: checked.literal,
      family: isIPv4(checked.literal) ? 4 : 6,
    };
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolve(checked.hostname);
  } catch {
    return { kind: 'dns_failure' };
  }

  for (const candidate of addresses) {
    const verdict = classifyAddress(candidate.address);
    if (verdict.kind === 'blocked') return { kind: 'rejected', reason: 'blocked_address', range: verdict.range };
  }
  const [first] = addresses;
  if (first === undefined) return { kind: 'dns_failure' };
  return {
    kind: 'pinned',
    url: checked.url,
    hostname: checked.hostname,
    address: first.address,
    family: isIPv4(first.address) ? 4 : 6,
  };
}
