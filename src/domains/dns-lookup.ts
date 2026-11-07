/**
 * src/domains/dns-lookup.ts — 고객 도메인의 **소유 증명 TXT** 와 **서브도메인 MX** 판정(ADR-0014 결정 2 · 계획 §3.3 M11·M12). domain-control λ 만 쓴다.
 * 소유 TXT 는 이름 둘의 OR(2026-10 one-shot — `_atmark-challenge.<domain>` 또는 `_atmark-challenge.<registrable>`, 계약 `combineChallengeVerdicts`)이고
 * 아래 1~4 는 **이름마다** 따로 적용한다(존 경계 · 권한 NS 집합이 이름마다 다를 수 있다 — 서브도메인이 위임된 하위 존이면 그 존의 NS).
 *
 * 판정은 공개 리졸버의 답을 믿지 않는다 — **권한 NS 전부에 직접** 묻는다:
 *   1. 질의 이름(`_atmark-challenge.<domain>` · `_atmark-challenge.<apex>` 또는 서브도메인)에서 apex 까지의 이름마다 공개 리졸버(1.1.1.1)로 NS 를 **병렬로** 묻고, 가장 깊은
 *      위임(존 경계)을 고른다. 그보다 깊은 이름의 NS 질의가 "없음"(NODATA·NXDOMAIN) 이 아닌 이유로 실패하면 error(위임 여부를 모른다).
 *   2. 그 NS 호스트마다 A 레코드를 얻고(공개 리졸버) **모든 주소에** UDP 로 직접 묻는다 — RD=0(재귀 요청 없음) · 2초 · **시도 1회**(재시도 없음).
 *   3. 한 서버의 답은 **권한 응답(AA 비트)이고 그 존이 실제로 있을 때만** 센다(단계 2 요구 — dangling NS): NOERROR + 답 · NOERROR(NODATA) 또는
 *      NXDOMAIN + **권한 절의 SOA — 소유자가 고른 위임 존 이름 그대로**(루트·TLD·다른 존의 SOA 는 증거가 아니다). 질문 이름은 0x20 으로 대소문자를 섞어
 *      보내고 응답의 질문 절이 글자 그대로 같아야 한다. AA 가 없거나(위임만 남은 NS · 재귀 리졸버) · REFUSED · SERVFAIL · 잘림(TC) · 질문
 *      불일치 · 타임아웃은 그 서버의 `error` 다 — 부재로 세면 남의 NS 를 차지한 사람이 부재를 꾸며 양도를 연다.
 *   4. 합치기: **전원 present = present · 전원 absent = absent · 그 밖 = error**(MX 는 전원 같은 판정이면 그 판정). `error` 는 소유권 상실로 세지 않는다.
 *
 * 응답에는 판정 코드만 싣는다 — DNS 원문·레코드 값은 돌려주지 않는다(계약 `DomainControlResult`). 오류 코드는 코드 모양 문자열(`dns_timeout` 등)이다.
 *
 * 송출: `node:dns/promises`(공개 리졸버) · `node:dgram`(권한 서버 직접 질의). `test/arch/network-egress.arch.test.ts` 허용 목록에 이름으로 오른다.
 */

import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { randomInt } from 'node:crypto';

import {
  CHALLENGE_VALUE_PREFIX,
  challengeRecordNames,
  combineChallengeVerdicts,
  DNS_QUERY_TIMEOUT_MS,
  SES_INBOUND_MX_HOST,
  type DnsVerdict,
  type MxVerdict,
} from './contract';

/** 공개 리졸버(위임 찾기 · NS 주소만 — 판정에는 쓰지 않는다). */
const PUBLIC_RESOLVER = '1.1.1.1';
/** NS 호스트 하나에서 묻는 주소 수 상한(애니캐스트면 보통 1). */
const MAX_ADDRESSES_PER_NS = 4;
/** 위임 하나의 NS 수 상한 — 넘으면 error(비정상 위임). */
const MAX_NAME_SERVERS = 13;
/** EDNS UDP 페이로드 크기(DNS flag day 2020 권장값). */
const EDNS_UDP_SIZE = 1232;

const TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, OPT: 41 } as const;
export type QueryType = 'TXT' | 'MX';

// ---------------------------------------------------------------------------
// 와이어 형식(RFC 1035) — 질의 만들기 · 응답 읽기. 순수 함수.
// ---------------------------------------------------------------------------

function encodeName(name: string): number[] {
  const out: number[] = [];
  for (const label of name.split('.')) {
    if (label.length === 0) continue;
    if (label.length > 63) throw new Error('dns_label_too_long');
    out.push(label.length, ...Buffer.from(label, 'ascii'));
  }
  out.push(0);
  return out;
}

/** 질의 패킷 — RD=0, 질문 하나, EDNS OPT 하나. */
export function encodeDnsQuery(id: number, name: string, type: QueryType | 'NS', recursionDesired = false): Uint8Array {
  const header = [id >> 8, id & 0xff, recursionDesired ? 0x01 : 0x00, 0x00, 0, 1, 0, 0, 0, 0, 0, 1];
  const question = [...encodeName(name), 0, TYPE[type], 0, 1];
  const opt = [0, 0, TYPE.OPT, EDNS_UDP_SIZE >> 8, EDNS_UDP_SIZE & 0xff, 0, 0, 0, 0, 0, 0];
  return Uint8Array.from([...header, ...question, ...opt]);
}

interface ResourceRecord {
  readonly name: string;
  readonly type: number;
  readonly data: Uint8Array;
  /** rdata 의 패킷 안 시작 위치(압축된 이름을 풀 때). */
  readonly offset: number;
}

export interface DnsResponse {
  readonly id: number;
  readonly authoritative: boolean;
  readonly truncated: boolean;
  readonly rcode: number;
  /** 질문 이름 — **대소문자 그대로**(0x20 대조용). */
  readonly questionName: string;
  readonly questionType: number;
  readonly answers: readonly ResourceRecord[];
  readonly authority: readonly ResourceRecord[];
}

class DnsParseError extends Error {}

function readName(packet: Uint8Array, start: number, preserveCase = false): { readonly name: string; readonly next: number } {
  const labels: string[] = [];
  let offset = start;
  let next = -1;
  for (let jumps = 0; ; ) {
    if (offset >= packet.length) throw new DnsParseError('name_out_of_bounds');
    const length = packet[offset] ?? 0;
    if (length === 0) {
      if (next < 0) next = offset + 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) throw new DnsParseError('pointer_out_of_bounds');
      if (next < 0) next = offset + 2;
      offset = ((length & 0x3f) << 8) | (packet[offset + 1] ?? 0);
      jumps += 1;
      if (jumps > 20) throw new DnsParseError('pointer_loop');
      continue;
    }
    if ((length & 0xc0) !== 0) throw new DnsParseError('label_type');
    const end = offset + 1 + length;
    if (end > packet.length) throw new DnsParseError('label_out_of_bounds');
    const label = Buffer.from(packet.subarray(offset + 1, end)).toString('latin1');
    labels.push(preserveCase ? label : label.toLowerCase());
    offset = end;
  }
  return { name: labels.join('.'), next };
}

function readRecords(packet: Uint8Array, start: number, count: number): { readonly records: ResourceRecord[]; readonly next: number } {
  const records: ResourceRecord[] = [];
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  let offset = start;
  for (let i = 0; i < count; i += 1) {
    const { name, next } = readName(packet, offset);
    if (next + 10 > packet.length) throw new DnsParseError('record_out_of_bounds');
    const type = view.getUint16(next);
    const length = view.getUint16(next + 8);
    const dataStart = next + 10;
    if (dataStart + length > packet.length) throw new DnsParseError('rdata_out_of_bounds');
    records.push({ name, type, data: packet.subarray(dataStart, dataStart + length), offset: dataStart });
    offset = dataStart + length;
  }
  return { records, next: offset };
}

/** 응답 패킷 읽기. 모양이 틀리면 던진다(부르는 쪽이 `dns_malformed` 로 센다). */
export function parseDnsResponse(packet: Uint8Array): DnsResponse {
  if (packet.length < 12) throw new DnsParseError('short');
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const id = view.getUint16(0);
  const flags = view.getUint16(2);
  if ((flags & 0x8000) === 0) throw new DnsParseError('not_a_response');
  if (((flags >> 11) & 0xf) !== 0) throw new DnsParseError('opcode');
  const qdcount = view.getUint16(4);
  const ancount = view.getUint16(6);
  const nscount = view.getUint16(8);
  if (qdcount !== 1) throw new DnsParseError('question_count');
  const question = readName(packet, 12, true);
  if (question.next + 4 > packet.length) throw new DnsParseError('question_out_of_bounds');
  const questionType = view.getUint16(question.next);
  const answers = readRecords(packet, question.next + 4, ancount);
  const authority = readRecords(packet, answers.next, nscount);
  return {
    id,
    authoritative: (flags & 0x0400) !== 0,
    truncated: (flags & 0x0200) !== 0,
    rcode: flags & 0xf,
    questionName: question.name,
    questionType,
    answers: answers.records,
    authority: authority.records,
  };
}

function txtStrings(record: ResourceRecord): string {
  // TXT rdata = <길이><바이트> 의 연속 — 한 레코드의 문자열 조각은 이어 붙인다(RFC 7208 §3.3 과 같은 규칙).
  const parts: string[] = [];
  let offset = 0;
  while (offset < record.data.length) {
    const length = record.data[offset] ?? 0;
    const end = offset + 1 + length;
    if (end > record.data.length) throw new DnsParseError('txt_out_of_bounds');
    parts.push(Buffer.from(record.data.subarray(offset + 1, end)).toString('latin1'));
    offset = end;
  }
  return parts.join('');
}

function mxExchange(packet: Uint8Array, record: ResourceRecord): string {
  if (record.data.length < 3) throw new DnsParseError('mx_short');
  return readName(packet, record.offset + 2).name;
}

/** `name` 이 `zone` 안에 있는가(같거나 하위). */
function isWithin(name: string, zone: string): boolean {
  return zone === '' || name === zone || name.endsWith(`.${zone}`);
}

/** 서버 하나의 답을 판정한다 — 권한 응답·존 존재만 센다(머리말 3). */
export type ServerAnswer =
  | { readonly kind: 'records'; readonly txt: readonly string[]; readonly mx: readonly string[] }
  | { readonly kind: 'empty' }
  | { readonly kind: 'cname' }
  | { readonly kind: 'error'; readonly code: string };

/**
 * `name` 은 **보낸 그대로의** 질문 이름(0x20 대소문자 섞기 — 응답의 질문 절이 글자 그대로 같아야 한다, 위조 응답의 문턱을 올린다).
 * `zone` 은 고른 위임 존 — 부재의 증거 SOA 는 **그 존 이름 그대로**여야 한다(보안 리뷰 L3 — 루트·TLD·다른 존의 SOA 는 증거가 아니다).
 */
export function classifyResponse(packet: Uint8Array, expectedId: number, name: string, type: QueryType, zone: string): ServerAnswer {
  let response: DnsResponse;
  try {
    response = parseDnsResponse(packet);
  } catch {
    return { kind: 'error', code: 'dns_malformed' };
  }
  const qname = name.toLowerCase();
  if (response.id !== expectedId || response.questionName !== name || response.questionType !== TYPE[type]) {
    return { kind: 'error', code: 'dns_question_mismatch' };
  }
  if (response.truncated) return { kind: 'error', code: 'dns_truncated' };
  if (response.rcode === 5) return { kind: 'error', code: 'dns_refused' };
  if (response.rcode === 2) return { kind: 'error', code: 'dns_servfail' };
  if (response.rcode !== 0 && response.rcode !== 3) return { kind: 'error', code: 'dns_rcode' };
  // ★ 권한 응답만 — 위임만 남고 존이 사라진 NS(비권한 응답 · 재귀 리졸버의 캐시 답)는 판정에 들어가지 않는다.
  if (!response.authoritative) return { kind: 'error', code: 'dns_not_authoritative' };
  const zoneExists = response.authority.some((record) => record.type === TYPE.SOA && record.name === zone.toLowerCase());
  if (response.rcode === 3) return zoneExists ? { kind: 'empty' } : { kind: 'error', code: 'dns_no_zone' };
  const atName = response.answers.filter((record) => record.name === qname);
  try {
    if (type === 'TXT') {
      const txt = atName.filter((record) => record.type === TYPE.TXT).map(txtStrings);
      if (txt.length > 0) return { kind: 'records', txt, mx: [] };
    } else {
      const mx = atName.filter((record) => record.type === TYPE.MX).map((record) => mxExchange(packet, record));
      if (mx.length > 0) return { kind: 'records', txt: [], mx };
    }
  } catch {
    return { kind: 'error', code: 'dns_malformed' };
  }
  if (atName.some((record) => record.type === TYPE.CNAME)) return { kind: 'cname' };
  // NODATA — 존이 있다는 증거(SOA)가 있어야 부재다.
  return zoneExists ? { kind: 'empty' } : { kind: 'error', code: 'dns_no_zone' };
}

// ---------------------------------------------------------------------------
// 송출 — 공개 리졸버(위임·주소) · UDP 직접 질의
// ---------------------------------------------------------------------------

/** 공개 리졸버가 돌려준 NS 레코드 하나 — **소유자 이름**을 함께(보안 재검증 LOW-4: CNAME 을 따라간 답의 NS 는 그 이름의 위임이 아니다). */
export interface NsRecord {
  readonly owner: string;
  readonly host: string;
}

export interface DnsTransport {
  /** 공개 리졸버의 NS 응답(답 절의 NS 레코드 전부 — 소유자 포함). 없음이면 `code` 가 `ENODATA`·`ENOTFOUND` 인 오류를 던진다. */
  resolveNs(name: string): Promise<readonly NsRecord[]>;
  resolve4(host: string): Promise<readonly string[]>;
  /** 서버 하나에 패킷 하나 — 응답 바이트. 시간 상한 안에 답이 없으면 던진다. 재시도하지 않는다. */
  exchange(server: string, packet: Uint8Array, timeoutMs: number): Promise<Uint8Array>;
  /** 질의 id(테스트는 고정값). */
  nextId(): number;
  /** 0x20 대소문자 섞기의 난수 비트(테스트는 고정값). */
  randomBit(): boolean;
}

function udpExchange(server: string, packet: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const id = ((packet[0] ?? 0) << 8) | (packet[1] ?? 0);
    const timer = setTimeout(() => {
      socket.close();
      reject(Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' }));
    }, timeoutMs);
    socket.on('message', (message, remote) => {
      // 다른 곳에서 온 패킷 · 다른 id 는 버리고 기다린다(위조 응답 하나가 판정을 끝내지 못하게).
      if (remote.address !== server || remote.port !== 53 || message.length < 2 || message.readUInt16BE(0) !== id) return;
      clearTimeout(timer);
      socket.close();
      resolve(new Uint8Array(message));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
    socket.send(packet, 53, server);
  });
}

/** 공개 리졸버에 NS 를 원시 질의로 묻는다(RD=1) — 답 절의 NS 레코드를 소유자와 함께. node:dns 의 `resolveNs` 는 CNAME 을 따라간 답의 소유자를 버린다. */
async function rawNs(name: string): Promise<readonly NsRecord[]> {
  const id = randomInt(0, 0x10000);
  const packet = await udpExchange(PUBLIC_RESOLVER, encodeDnsQuery(id, name, 'NS', true), DNS_QUERY_TIMEOUT_MS);
  const response = parseDnsResponse(packet);
  if (response.id !== id || response.questionName.toLowerCase() !== name.toLowerCase() || response.questionType !== TYPE.NS) {
    throw Object.assign(new Error('ns mismatch'), { code: 'EBADRESP' });
  }
  if (response.truncated) throw Object.assign(new Error('ns truncated'), { code: 'EBADRESP' });
  if (response.rcode === 3) throw Object.assign(new Error('nxdomain'), { code: 'ENOTFOUND' });
  if (response.rcode !== 0) throw Object.assign(new Error('ns rcode'), { code: 'ESERVFAIL' });
  const records = response.answers.filter((record) => record.type === TYPE.NS).map((record) => ({ owner: record.name, host: readName(packet, record.offset).name }));
  if (records.length === 0) throw Object.assign(new Error('nodata'), { code: 'ENODATA' });
  return records;
}

/** 실제 송출. 공개 리졸버는 2초 · 시도 1회. */
export function createDnsTransport(): DnsTransport {
  const resolver = new Resolver({ timeout: DNS_QUERY_TIMEOUT_MS, tries: 1 });
  resolver.setServers([PUBLIC_RESOLVER]);
  return {
    resolveNs: rawNs,
    resolve4: (host) => resolver.resolve4(host),
    exchange: udpExchange,
    nextId: () => randomInt(0, 0x10000),
    randomBit: () => randomInt(0, 2) === 1,
  };
}

// ---------------------------------------------------------------------------
// 판정
// ---------------------------------------------------------------------------

export interface DnsCheck<V> {
  readonly verdict: V;
  readonly errorCode: string | null;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

function isNoRecord(error: unknown): boolean {
  const code = codeOf(error);
  return code === 'ENODATA' || code === 'ENOTFOUND';
}

/** `name` 부터 `apex` 까지의 이름(깊은 것부터). `name` 이 `apex` 안이 아니면 빈 배열. */
export function namesUpTo(name: string, apex: string): string[] {
  if (!isWithin(name, apex)) return [];
  const names: string[] = [];
  let current = name;
  for (;;) {
    names.push(current);
    if (current === apex) return names;
    current = current.slice(current.indexOf('.') + 1);
  }
}

type ServersResult = { readonly ok: true; readonly zone: string; readonly servers: readonly string[] } | { readonly ok: false; readonly code: string };

/** 질의 이름을 맡은 권한 서버 주소 전부(머리말 1·2). */
async function authoritativeServers(transport: DnsTransport, name: string, apex: string): Promise<ServersResult> {
  const candidates = namesUpTo(name, apex);
  if (candidates.length === 0) return { ok: false, code: 'dns_name_outside_apex' };
  const lookups = await Promise.all(
    candidates.map((candidate) => transport.resolveNs(candidate).then((ns) => ({ ns, error: null }), (error: unknown) => ({ ns: null, error }))),
  );
  let nameServers: readonly string[] | null = null;
  let zone = '';
  for (const [i, lookup] of lookups.entries()) {
    const candidate = candidates[i] ?? '';
    // ★ 그 이름 **자신이 소유한** NS 만 위임이다(보안 재검증 LOW-4) — CNAME 을 따라간 답(다른 이름의 NS)은 존 경계가 아니다: 이 이름은 별칭이고
    //   위로 올라가 부모 존의 서버에 묻는다(그 서버의 권한 답이 CNAME 을 그대로 보여 준다).
    const owned = (lookup.ns ?? []).filter((record) => record.owner.toLowerCase() === candidate).map((record) => record.host);
    if (owned.length > 0) {
      nameServers = owned;
      zone = candidate;
      break;
    }
    if (lookup.ns !== null) continue;
    // 더 깊은 이름의 위임을 확인하지 못했다 — 위의 NS 에 물으면 위임된 존 대신 부모의 답을 센다.
    if (lookup.error !== null && !isNoRecord(lookup.error)) return { ok: false, code: 'dns_ns_lookup_failed' };
  }
  if (nameServers === null) return { ok: false, code: 'dns_ns_lookup_failed' };
  if (nameServers.length > MAX_NAME_SERVERS) return { ok: false, code: 'dns_too_many_ns' };
  const addresses = await Promise.all(
    [...new Set(nameServers.map((host) => host.toLowerCase()))].map((host) =>
      transport.resolve4(host).then((ips) => [...ips].sort().slice(0, MAX_ADDRESSES_PER_NS), () => null),
    ),
  );
  if (addresses.some((ips) => ips === null || ips.length === 0)) return { ok: false, code: 'dns_ns_address_failed' };
  return { ok: true, zone, servers: [...new Set(addresses.flatMap((ips) => ips ?? []))] };
}

/** 0x20 — 질문 이름의 글자 대소문자를 무작위로 섞는다(DNS 는 대소문자를 가리지 않고 응답은 질문을 글자 그대로 돌려준다). */
function mixCase(name: string, random: () => boolean): string {
  return [...name].map((c) => (/[a-z]/.test(c) && random() ? c.toUpperCase() : c)).join('');
}

async function askAll(transport: DnsTransport, servers: readonly string[], name: string, type: QueryType, zone: string): Promise<ServerAnswer[]> {
  return Promise.all(
    servers.map(async (server): Promise<ServerAnswer> => {
      const id = transport.nextId();
      const asked = mixCase(name, transport.randomBit);
      try {
        const reply = await transport.exchange(server, encodeDnsQuery(id, asked, type), DNS_QUERY_TIMEOUT_MS);
        return classifyResponse(reply, id, asked, type, zone);
      } catch (error) {
        return { kind: 'error', code: codeOf(error) === 'ETIMEOUT' ? 'dns_timeout' : 'dns_exchange_failed' };
      }
    }),
  );
}

function stripDot(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

export interface DnsLookup {
  /**
   * 소유 증명 — `challengeRecordNames(domain, registrable)`(서브도메인 `_atmark-challenge.<domain>` · apex `_atmark-challenge.<registrable>`)
   * **각 이름마다** 그 이름의 권한 NS 전부에 `atmark-domain-verification=<token>` 이 **정확히** 있는지 판정하고 `combineChallengeVerdicts` 로 합친다
   * (하나라도 present → present · 모두 absent → absent · 그 밖 error). 이름마다 존 경계를 따로 찾는다 — 서브도메인이 위임된 하위 존이면 그 존의 NS.
   */
  checkChallenge(domain: string, registrable: string, token: string): Promise<DnsCheck<DnsVerdict>>;
  /** 서브도메인 MX — 없음(`missing`) · SES 수신만(`ses`) · 다른 곳(`other`). */
  checkMx(domain: string, registrable: string): Promise<DnsCheck<MxVerdict>>;
}

/** 이름 하나의 소유 TXT 판정(머리말 1~4) — 권한 NS 전원 정확한 토큰 = present · 전원 확정 부재 = absent · 그 밖 error. */
async function checkChallengeName(transport: DnsTransport, name: string, registrable: string, expected: string): Promise<DnsCheck<DnsVerdict>> {
  const servers = await authoritativeServers(transport, name, registrable);
  if (!servers.ok) return { verdict: 'error', errorCode: servers.code };
  const answers = await askAll(transport, servers.servers, name, 'TXT', servers.zone);
  if (answers.length === 0) return { verdict: 'error', errorCode: 'dns_no_servers' };
  const verdicts = answers.map((answer): DnsVerdict | { readonly code: string } => {
    if (answer.kind === 'error') return { code: answer.code };
    // CNAME 으로 넘긴 도전 레코드는 받지 않는다 — 다른 존(다른 주인)의 값을 이 도메인의 증명으로 세지 않는다.
    if (answer.kind === 'cname') return { code: 'dns_cname' };
    if (answer.kind === 'empty') return 'absent';
    return answer.txt.includes(expected) ? 'present' : 'absent';
  });
  const failure = verdicts.find((verdict): verdict is { readonly code: string } => typeof verdict !== 'string');
  if (failure !== undefined) return { verdict: 'error', errorCode: failure.code };
  if (verdicts.every((verdict) => verdict === 'present')) return { verdict: 'present', errorCode: null };
  if (verdicts.every((verdict) => verdict === 'absent')) return { verdict: 'absent', errorCode: null };
  return { verdict: 'error', errorCode: 'dns_disagreement' };
}

export function createDnsLookup(transport: DnsTransport = createDnsTransport()): DnsLookup {
  return {
    async checkChallenge(domain, registrable, token) {
      const expected = `${CHALLENGE_VALUE_PREFIX}${token}`;
      const checks = await Promise.all(challengeRecordNames(domain, registrable).map((name) => checkChallengeName(transport, name, registrable, expected)));
      const verdict = combineChallengeVerdicts(checks.map((check) => check.verdict));
      // 합이 error 일 때만 코드를 싣는다(앞 이름 = 서브도메인의 코드부터). present/absent 면 한쪽의 오류는 판정을 바꾸지 않았다.
      return { verdict, errorCode: verdict === 'error' ? (checks.find((check) => check.errorCode !== null)?.errorCode ?? 'dns_no_names') : null };
    },
    async checkMx(domain, registrable) {
      const servers = await authoritativeServers(transport, domain, registrable);
      if (!servers.ok) return { verdict: 'error', errorCode: servers.code };
      const answers = await askAll(transport, servers.servers, domain, 'MX', servers.zone);
      const verdicts = answers.map((answer): MxVerdict | { readonly code: string } => {
        if (answer.kind === 'error') return { code: answer.code };
        // 서브도메인이 다른 이름의 별칭이면 메일은 그 이름의 MX 로 간다 — 사람 메일일 수 있다(닫힌 쪽: other).
        if (answer.kind === 'cname') return 'other';
        if (answer.kind === 'empty') return 'missing';
        const hosts = answer.mx.map(stripDot);
        // 널 MX(RFC 7505 — 교환기 `.`) = 메일을 받지 않는다.
        if (hosts.every((host) => host === '')) return 'missing';
        return hosts.every((host) => host === SES_INBOUND_MX_HOST) ? 'ses' : 'other';
      });
      const failure = verdicts.find((verdict): verdict is { readonly code: string } => typeof verdict !== 'string');
      if (failure !== undefined) return { verdict: 'error', errorCode: failure.code };
      const first = verdicts[0];
      if (first === undefined || typeof first !== 'string') return { verdict: 'error', errorCode: 'dns_no_servers' };
      return verdicts.every((verdict) => verdict === first) ? { verdict: first, errorCode: null } : { verdict: 'error', errorCode: 'dns_disagreement' };
    },
  };
}
