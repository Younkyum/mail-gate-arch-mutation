/**
 * `src/domains/dns-lookup.ts` — 소유 증명 TXT · 서브도메인 MX 판정(ADR-0014 결정 2 · 단계 2 "AA 비트 · 존 존재 — dangling NS 는 error").
 *
 * 가짜 송출(`DnsTransport`)에 **진짜 와이어 형식** 응답을 만들어 준다 — 판정 표 전부:
 *   - 모든 권한 서버 일치 → present / 모든 서버 부재(NXDOMAIN·NODATA + SOA · 토큰 없음) → absent / 그 밖 → error.
 *   - 비권한 응답(AA=0 — 위임만 남은 NS · 재귀 리졸버) · REFUSED · SERVFAIL · 잘림 · 질문 불일치 · SOA 없는 부재(존 없음) · 타임아웃 → error.
 *   - 위임(존 경계): 더 깊은 이름의 NS 가 있으면 그 서버에 묻는다 · 더 깊은 이름의 NS 질의가 "없음" 이 아닌 이유로 실패하면 error.
 *   - **재시도 없음**(서버마다 정확히 한 번 · 공개 리졸버 이름마다 한 번).
 *   - 소유 TXT 이름 둘의 OR(2026-10 one-shot — 서브도메인 · apex): 이름마다 존 경계·권한 NS 를 따로 찾고 `combineChallengeVerdicts` 로 합친다.
 */

import { describe, expect, it } from 'vitest';

import { CHALLENGE_VALUE_PREFIX, SES_INBOUND_MX_HOST } from '../../../src/domains/contract';
import { classifyResponse, createDnsLookup, encodeDnsQuery, namesUpTo, parseDnsResponse, type DnsTransport, type NsRecord } from '../../../src/domains/dns-lookup';

const TOKEN = 'A'.repeat(43);
const APEX = 'example.com';
const SUB = 'agents.example.com';
const CHALLENGE = `_atmark-challenge.${APEX}`;
const SUB_CHALLENGE = `_atmark-challenge.${SUB}`;

// ---------------------------------------------------------------------------
// 응답 만들기(테스트 전용 — RFC 1035 와이어 형식)
// ---------------------------------------------------------------------------

function name(value: string): number[] {
  const out: number[] = [];
  for (const label of value.split('.').filter((l) => l.length > 0)) out.push(label.length, ...Buffer.from(label, 'ascii'));
  out.push(0);
  return out;
}
const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

interface Rr {
  readonly name: string;
  readonly type: 'TXT' | 'MX' | 'CNAME' | 'SOA';
  readonly value: string | readonly string[];
  readonly preference?: number;
}
const TYPES = { TXT: 16, MX: 15, CNAME: 5, SOA: 6 } as const;

function rdata(rr: Rr): number[] {
  if (rr.type === 'TXT') return (Array.isArray(rr.value) ? rr.value : [rr.value]).flatMap((part) => [part.length, ...Buffer.from(String(part), 'latin1')]);
  if (rr.type === 'MX') return [...u16(rr.preference ?? 10), ...name(String(rr.value))];
  if (rr.type === 'CNAME') return name(String(rr.value));
  return [...name(`ns1.${String(rr.value)}`), ...name(`hostmaster.${String(rr.value)}`), ...u32(1), ...u32(3600), ...u32(600), ...u32(86400), ...u32(300)];
}
function record(rr: Rr): number[] {
  const data = rdata(rr);
  return [...name(rr.name), ...u16(TYPES[rr.type]), ...u16(1), ...u32(300), ...u16(data.length), ...data];
}

interface ReplyShape {
  readonly aa?: boolean;
  readonly tc?: boolean;
  readonly rcode?: number;
  readonly answers?: readonly Rr[];
  readonly authority?: readonly Rr[];
  /** 질문 이름을 바꿔 돌려준다(위조·혼선). */
  readonly questionName?: string;
  readonly idDelta?: number;
}

function reply(query: Uint8Array, shape: ReplyShape): Uint8Array {
  const view = new DataView(query.buffer, query.byteOffset, query.byteLength);
  const id = (view.getUint16(0) + (shape.idDelta ?? 0)) & 0xffff;
  // 질문 절을 질의에서 그대로 떼어 온다(이름 + 타입 + 클래스).
  let offset = 12;
  while ((query[offset] ?? 0) !== 0) offset += 1 + (query[offset] ?? 0);
  const qtype = view.getUint16(offset + 1);
  const question = shape.questionName === undefined ? [...query.subarray(12, offset + 5)] : [...name(shape.questionName), ...u16(qtype), ...u16(1)];
  const flags = 0x8000 | (shape.aa === false ? 0 : 0x0400) | (shape.tc === true ? 0x0200 : 0) | (shape.rcode ?? 0);
  const answers = shape.answers ?? [];
  const authority = shape.authority ?? [];
  return Uint8Array.from([
    ...u16(id),
    ...u16(flags),
    ...u16(1),
    ...u16(answers.length),
    ...u16(authority.length),
    ...u16(0),
    ...question,
    ...answers.flatMap(record),
    ...authority.flatMap(record),
  ]);
}

const soa = (zone: string): Rr => ({ name: zone, type: 'SOA', value: zone });
const challengeTxt = (value: string = `${CHALLENGE_VALUE_PREFIX}${TOKEN}`): Rr => ({ name: CHALLENGE, type: 'TXT', value });

// ---------------------------------------------------------------------------
// 가짜 송출
// ---------------------------------------------------------------------------

interface FakeOptions {
  /** 이름 → NS 호스트 목록(소유자 = 그 이름) · 소유자를 직접 준 레코드 · 또는 오류 코드(`ENODATA`·`ENOTFOUND`·`ESERVFAIL`·`ETIMEOUT`). 없으면 ENODATA. */
  readonly ns?: Readonly<Record<string, readonly string[] | readonly NsRecord[] | string>>;
  /** NS 호스트 → 주소(없으면 오류). */
  readonly a?: Readonly<Record<string, readonly string[]>>;
  /** 서버 주소 → 응답 모양(또는 'timeout'). */
  readonly servers: Readonly<Record<string, ReplyShape | 'timeout' | ((query: Uint8Array) => ReplyShape)>>;
}

function isRecordList(value: unknown): value is readonly NsRecord[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null && 'owner' in item);
}

function fake(options: FakeOptions): DnsTransport & { readonly calls: { ns: string[]; a: string[]; exchange: string[] } } {
  const calls = { ns: [] as string[], a: [] as string[], exchange: [] as string[] };
  let id = 100;
  return {
    calls,
    resolveNs(target) {
      calls.ns.push(target);
      const entry = options.ns?.[target];
      if (isRecordList(entry)) return Promise.resolve(entry);
      if (Array.isArray(entry)) return Promise.resolve((entry as readonly string[]).map((host) => ({ owner: target, host })));
      return Promise.reject(Object.assign(new Error('dns'), { code: typeof entry === 'string' ? entry : 'ENODATA' }));
    },
    resolve4(host) {
      calls.a.push(host);
      const ips = options.a?.[host];
      return ips === undefined ? Promise.reject(Object.assign(new Error('dns'), { code: 'ENOTFOUND' })) : Promise.resolve(ips);
    },
    exchange(server, packet) {
      calls.exchange.push(server);
      const shape = options.servers[server];
      if (shape === undefined || shape === 'timeout') return Promise.reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }));
      return Promise.resolve(reply(packet, typeof shape === 'function' ? shape(packet) : shape));
    },
    nextId: () => (id += 1),
    randomBit: () => true,
  };
}

/** 두 권한 NS(주소 하나씩) — apex 위임. */
const TWO_NS = {
  ns: { [APEX]: ['ns1.dns.test', 'ns2.dns.test'] },
  a: { 'ns1.dns.test': ['192.0.2.1'], 'ns2.dns.test': ['192.0.2.2'] },
} as const;

describe('와이어 형식', () => {
  it('질의: RD=0 · 질문 하나 · EDNS OPT 하나 — 응답 파서가 압축 이름까지 읽는다', () => {
    const query = encodeDnsQuery(0x1234, CHALLENGE, 'TXT');
    expect([query[0], query[1]]).toEqual([0x12, 0x34]);
    expect(query[2]).toBe(0); // QR=0 · OPCODE=0 · AA · TC · RD 모두 0
    const parsed = parseDnsResponse(reply(query, { answers: [challengeTxt()] }));
    expect(parsed).toMatchObject({ id: 0x1234, authoritative: true, truncated: false, rcode: 0, questionName: CHALLENGE, questionType: 16 });
    expect(parsed.answers).toHaveLength(1);
    // 압축 포인터(0xc00c — 질문 이름)를 쓰는 응답.
    const compressed = Uint8Array.from([...reply(query, {}).subarray(0, 6), ...u16(1), 0, 0, 0, 0, ...query.subarray(12, query.length - 11), 0xc0, 0x0c, ...u16(16), ...u16(1), ...u32(60), ...u16(3), 2, 104, 105]);
    compressed[2] = 0x84;
    expect(classifyResponse(compressed, 0x1234, CHALLENGE, 'TXT', APEX)).toEqual({ kind: 'records', txt: ['hi'], mx: [] });
  });

  it('부서진 패킷 · 포인터 고리는 dns_malformed(던지지 않는다)', () => {
    expect(classifyResponse(new Uint8Array([1, 2, 3]), 0, CHALLENGE, 'TXT', APEX)).toEqual({ kind: 'error', code: 'dns_malformed' });
    const query = encodeDnsQuery(7, CHALLENGE, 'TXT');
    const loop = Uint8Array.from([0, 7, 0x84, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c]);
    expect(classifyResponse(loop, 7, CHALLENGE, 'TXT', APEX)).toEqual({ kind: 'error', code: 'dns_malformed' });
    expect(query.length).toBeGreaterThan(12);
  });

  it('namesUpTo — 질의 이름부터 apex 까지(깊은 것부터) · apex 밖이면 빈 배열', () => {
    expect(namesUpTo('a.b.example.com', APEX)).toEqual(['a.b.example.com', 'b.example.com', APEX]);
    expect(namesUpTo(APEX, APEX)).toEqual([APEX]);
    expect(namesUpTo('example.org', APEX)).toEqual([]);
    expect(namesUpTo('badexample.com', APEX)).toEqual([]);
  });
});

describe('소유 증명 TXT — 판정 표', () => {
  it('모든 권한 NS 가 정확한 토큰 → present · 서버마다 정확히 한 번(재시도 없음)', async () => {
    const transport = fake({ ...TWO_NS, servers: { '192.0.2.1': { answers: [challengeTxt()] }, '192.0.2.2': { answers: [challengeTxt(), challengeTxt('v=other')] } } });
    await expect(createDnsLookup(transport).checkChallenge(APEX, APEX, TOKEN)).resolves.toEqual({ verdict: 'present', errorCode: null });
    expect(transport.calls.exchange.sort()).toEqual(['192.0.2.1', '192.0.2.2']);
    expect(transport.calls.ns.sort()).toEqual([CHALLENGE, APEX].sort());
  });

  it('TXT 조각(255자 경계)은 이어 붙여 대조한다', async () => {
    const value = `${CHALLENGE_VALUE_PREFIX}${TOKEN}`;
    const transport = fake({ ...TWO_NS, servers: { '192.0.2.1': { answers: [challengeTxt([value.slice(0, 10), value.slice(10)] as unknown as string)] }, '192.0.2.2': { answers: [challengeTxt()] } } });
    await expect(createDnsLookup(transport).checkChallenge(APEX, APEX, TOKEN)).resolves.toEqual({ verdict: 'present', errorCode: null });
  });

  it('모든 NS 가 부재(NXDOMAIN + SOA · NODATA + SOA · 다른 토큰) → absent', async () => {
    const transport = fake({
      ...TWO_NS,
      servers: { '192.0.2.1': { rcode: 3, authority: [soa(APEX)] }, '192.0.2.2': { answers: [challengeTxt(`${CHALLENGE_VALUE_PREFIX}${'B'.repeat(43)}`)] } },
    });
    await expect(createDnsLookup(transport).checkChallenge(APEX, APEX, TOKEN)).resolves.toEqual({ verdict: 'absent', errorCode: null });
    const nodata = fake({ ...TWO_NS, servers: { '192.0.2.1': { authority: [soa(APEX)] }, '192.0.2.2': { authority: [soa(APEX)] } } });
    await expect(createDnsLookup(nodata).checkChallenge(APEX, APEX, TOKEN)).resolves.toEqual({ verdict: 'absent', errorCode: null });
  });

  it('일부만 present → error(dns_disagreement) — 소유권 상실로도 증명으로도 세지 않는다', async () => {
    const transport = fake({ ...TWO_NS, servers: { '192.0.2.1': { answers: [challengeTxt()] }, '192.0.2.2': { rcode: 3, authority: [soa(APEX)] } } });
    await expect(createDnsLookup(transport).checkChallenge(APEX, APEX, TOKEN)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_disagreement' });
  });

  it.each([
    ['비권한 응답(AA=0 — 위임만 남은 NS · 재귀 리졸버의 답)', { aa: false, rcode: 3, authority: [soa(APEX)] }, 'dns_not_authoritative'],
    ['비권한인데 토큰을 돌려준다(남의 리졸버가 꾸민 답)', { aa: false, answers: [challengeTxt()] }, 'dns_not_authoritative'],
    ['REFUSED(존이 사라진 dangling NS)', { rcode: 5 }, 'dns_refused'],
    ['SERVFAIL', { rcode: 2 }, 'dns_servfail'],
    ['권한 NXDOMAIN 인데 SOA 가 없다(존 존재를 증명하지 못한다)', { rcode: 3 }, 'dns_no_zone'],
    ['권한 NODATA 인데 SOA 가 없다', {}, 'dns_no_zone'],
    ['다른 존의 SOA', { rcode: 3, authority: [soa('other.test')] }, 'dns_no_zone'],
    ['TLD 의 SOA(위임 존이 아니다 — 보안 리뷰 L3)', { rcode: 3, authority: [soa('com')] }, 'dns_no_zone'],
    ['질문 이름의 대소문자를 바꿔 돌려준다(0x20)', { questionName: CHALLENGE.toLowerCase(), answers: [challengeTxt()] }, 'dns_question_mismatch'],
    ['잘린 응답(TC)', { tc: true, answers: [challengeTxt()] }, 'dns_truncated'],
    ['질문 이름이 다르다', { questionName: 'evil.test', answers: [challengeTxt()] }, 'dns_question_mismatch'],
    ['id 가 다르다', { idDelta: 1, answers: [challengeTxt()] }, 'dns_question_mismatch'],
    ['CNAME 으로 넘긴 도전 레코드', { answers: [{ name: CHALLENGE, type: 'CNAME', value: 'x.other.test' } as Rr] }, 'dns_cname'],
  ] as const)('한 서버가 %s → error', async (_label, shape, code) => {
    const transport = fake({ ...TWO_NS, servers: { '192.0.2.1': { answers: [challengeTxt()] }, '192.0.2.2': shape as ReplyShape } });
    await expect(createDnsLookup(transport).checkChallenge(APEX, APEX, TOKEN)).resolves.toEqual({ verdict: 'error', errorCode: code });
    // 부재 쪽도 마찬가지 — 다른 서버가 권한 부재여도 합쳐서 absent 가 되지 않는다.
    const absentOther = fake({ ...TWO_NS, servers: { '192.0.2.1': { rcode: 3, authority: [soa(APEX)] }, '192.0.2.2': shape as ReplyShape } });
    expect((await createDnsLookup(absentOther).checkChallenge(APEX, APEX, TOKEN)).verdict).toBe('error');
  });

  it('한 서버 타임아웃 → error(dns_timeout) · 다시 묻지 않는다', async () => {
    const transport = fake({ ...TWO_NS, servers: { '192.0.2.1': { answers: [challengeTxt()] }, '192.0.2.2': 'timeout' } });
    await expect(createDnsLookup(transport).checkChallenge(APEX, APEX, TOKEN)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_timeout' });
    expect(transport.calls.exchange.filter((server) => server === '192.0.2.2')).toHaveLength(1);
  });

  it('NS 조회 실패 · NS 주소 실패 → error(권한 서버에 묻지 않는다)', async () => {
    const noNs = fake({ ns: { [APEX]: 'ESERVFAIL' }, servers: {} });
    await expect(createDnsLookup(noNs).checkChallenge(APEX, APEX, TOKEN)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_ns_lookup_failed' });
    const gone = fake({ ns: { [APEX]: 'ENOTFOUND' }, servers: {} });
    await expect(createDnsLookup(gone).checkChallenge(APEX, APEX, TOKEN)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_ns_lookup_failed' });
    const noAddress = fake({ ns: { [APEX]: ['ns1.dns.test', 'ns2.dns.test'] }, a: { 'ns1.dns.test': ['192.0.2.1'] }, servers: { '192.0.2.1': { answers: [challengeTxt()] } } });
    await expect(createDnsLookup(noAddress).checkChallenge(APEX, APEX, TOKEN)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_ns_address_failed' });
    expect(noAddress.calls.exchange).toEqual([]);
  });

  it('NS 의 주소가 여럿이면 전부 묻는다(호스트당 상한 안) — 한 주소라도 다르면 error', async () => {
    const transport = fake({
      ns: { [APEX]: ['ns1.dns.test'] },
      a: { 'ns1.dns.test': ['192.0.2.1', '192.0.2.9'] },
      servers: { '192.0.2.1': { answers: [challengeTxt()] }, '192.0.2.9': { aa: false, answers: [challengeTxt()] } },
    });
    await expect(createDnsLookup(transport).checkChallenge(APEX, APEX, TOKEN)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_not_authoritative' });
    expect(transport.calls.exchange.sort()).toEqual(['192.0.2.1', '192.0.2.9']);
  });

  it('도전 이름이 따로 위임됐으면 그 NS 에 묻는다 · 그 위임 확인이 실패하면 error(부모의 답을 세지 않는다)', async () => {
    const delegated = fake({
      ns: { [CHALLENGE]: ['ns.delegate.test'], [APEX]: ['ns1.dns.test'] },
      a: { 'ns.delegate.test': ['192.0.2.50'], 'ns1.dns.test': ['192.0.2.1'] },
      servers: { '192.0.2.50': { answers: [challengeTxt()] }, '192.0.2.1': { rcode: 3, authority: [soa(APEX)] } },
    });
    await expect(createDnsLookup(delegated).checkChallenge(APEX, APEX, TOKEN)).resolves.toEqual({ verdict: 'present', errorCode: null });
    expect(delegated.calls.exchange).toEqual(['192.0.2.50']);
    const unknown = fake({ ...TWO_NS, ns: { [CHALLENGE]: 'ETIMEOUT', [APEX]: ['ns1.dns.test'] }, servers: { '192.0.2.1': { answers: [challengeTxt()] } } });
    await expect(createDnsLookup(unknown).checkChallenge(APEX, APEX, TOKEN)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_ns_lookup_failed' });
    expect(unknown.calls.exchange).toEqual([]);
  });
});

/** 질의 패킷의 질문 이름(소문자) — 이름마다 다른 답을 주는 가짜 서버용. */
function questionOf(query: Uint8Array): string {
  const labels: string[] = [];
  for (let offset = 12; (query[offset] ?? 0) !== 0; offset += 1 + (query[offset] ?? 0)) {
    labels.push(Buffer.from(query.subarray(offset + 1, offset + 1 + (query[offset] ?? 0))).toString('latin1').toLowerCase());
  }
  return labels.join('.');
}

const NX_APEX: ReplyShape = { rcode: 3, authority: [soa(APEX)] };
const subTxt = (value: string = `${CHALLENGE_VALUE_PREFIX}${TOKEN}`): Rr => ({ name: SUB_CHALLENGE, type: 'TXT', value });

/** 같은 존(apex)의 두 권한 NS 가 이름마다 `bySub`(서브도메인 이름) · `byApex`(apex 이름) 답을 준다. 둘째 서버만 다르게 하려면 `second`. */
function sameZone(bySub: ReplyShape, byApex: ReplyShape, second?: { readonly sub?: ReplyShape; readonly apex?: ReplyShape }) {
  const answer = (sub: ReplyShape, apex: ReplyShape) => (query: Uint8Array): ReplyShape => (questionOf(query) === SUB_CHALLENGE ? sub : apex);
  return fake({
    ...TWO_NS,
    servers: { '192.0.2.1': answer(bySub, byApex), '192.0.2.2': answer(second?.sub ?? bySub, second?.apex ?? byApex) },
  });
}

describe('소유 증명 TXT — 서브도메인 · apex 두 이름의 OR(2026-10 one-shot)', () => {
  it('서브도메인 present · apex 부재 → present · 두 이름을 모두 묻는다(서버마다 이름당 한 번)', async () => {
    const transport = sameZone({ answers: [subTxt()] }, NX_APEX);
    await expect(createDnsLookup(transport).checkChallenge(SUB, APEX, TOKEN)).resolves.toEqual({ verdict: 'present', errorCode: null });
    expect(transport.calls.exchange.sort()).toEqual(['192.0.2.1', '192.0.2.1', '192.0.2.2', '192.0.2.2']);
    expect([...new Set(transport.calls.ns)].sort()).toEqual([SUB_CHALLENGE, SUB, CHALLENGE, APEX].sort());
  });

  it('서브도메인 부재 · apex present(기존 행) → present', async () => {
    const transport = sameZone({ rcode: 3, authority: [soa(APEX)] }, { answers: [challengeTxt()] });
    await expect(createDnsLookup(transport).checkChallenge(SUB, APEX, TOKEN)).resolves.toEqual({ verdict: 'present', errorCode: null });
  });

  it('두 이름 모두 확정 부재(NXDOMAIN · 다른 토큰) → absent', async () => {
    const transport = sameZone({ answers: [subTxt(`${CHALLENGE_VALUE_PREFIX}${'B'.repeat(43)}`)] }, NX_APEX);
    await expect(createDnsLookup(transport).checkChallenge(SUB, APEX, TOKEN)).resolves.toEqual({ verdict: 'absent', errorCode: null });
  });

  it('한 이름 error + 다른 이름 absent → error(상실로 세지 않는다) · 코드는 오류 난 이름의 것', async () => {
    const subError = sameZone(NX_APEX, NX_APEX, { sub: { rcode: 2 } });
    await expect(createDnsLookup(subError).checkChallenge(SUB, APEX, TOKEN)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_servfail' });
    const apexError = sameZone(NX_APEX, NX_APEX, { apex: { aa: false, rcode: 3, authority: [soa(APEX)] } });
    await expect(createDnsLookup(apexError).checkChallenge(SUB, APEX, TOKEN)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_not_authoritative' });
  });

  it('한 이름 present + 다른 이름 error → present(증명은 하나로 충분)', async () => {
    const transport = sameZone({ answers: [subTxt()] }, NX_APEX, { apex: { rcode: 5 } });
    await expect(createDnsLookup(transport).checkChallenge(SUB, APEX, TOKEN)).resolves.toEqual({ verdict: 'present', errorCode: null });
    const apexOnly = sameZone({ rcode: 2 }, { answers: [challengeTxt()] });
    await expect(createDnsLookup(apexOnly).checkChallenge(SUB, APEX, TOKEN)).resolves.toEqual({ verdict: 'present', errorCode: null });
  });

  it('서브도메인 도전 이름이 CNAME 이면 그 이름은 error(dns_cname) — apex 가 부재면 합도 error', async () => {
    const transport = sameZone({ answers: [{ name: SUB_CHALLENGE, type: 'CNAME', value: 'x.other.test' }] }, NX_APEX);
    await expect(createDnsLookup(transport).checkChallenge(SUB, APEX, TOKEN)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_cname' });
  });

  it('서브도메인 일부 NS 만 present → 그 이름 error(dns_disagreement) — apex 부재면 합도 error', async () => {
    const transport = sameZone({ answers: [subTxt()] }, NX_APEX, { sub: NX_APEX });
    await expect(createDnsLookup(transport).checkChallenge(SUB, APEX, TOKEN)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_disagreement' });
  });

  it('★ 서브도메인이 위임된 하위 존이면 서브도메인 이름은 그 존의 NS 에(SOA = 하위 존), apex 이름은 apex 의 NS 에 묻는다', async () => {
    const transport = fake({
      ns: { [SUB]: ['ns.sub.test'], [APEX]: ['ns1.dns.test'] },
      a: { 'ns.sub.test': ['192.0.2.60'], 'ns1.dns.test': ['192.0.2.1'] },
      servers: {
        '192.0.2.60': (query) => (questionOf(query) === SUB_CHALLENGE ? { answers: [subTxt()] } : { rcode: 5 }),
        '192.0.2.1': (query) => (questionOf(query) === CHALLENGE ? NX_APEX : { rcode: 5 }),
      },
    });
    await expect(createDnsLookup(transport).checkChallenge(SUB, APEX, TOKEN)).resolves.toEqual({ verdict: 'present', errorCode: null });
    expect(transport.calls.exchange.sort()).toEqual(['192.0.2.1', '192.0.2.60']);
    // 하위 존의 부재 증거는 **그 존의** SOA 여야 한다 — apex SOA 로 답하면 존 존재를 증명하지 못한다(dns_no_zone).
    const wrongSoa = fake({
      ns: { [SUB]: ['ns.sub.test'], [APEX]: ['ns1.dns.test'] },
      a: { 'ns.sub.test': ['192.0.2.60'], 'ns1.dns.test': ['192.0.2.1'] },
      servers: { '192.0.2.60': { rcode: 3, authority: [soa(APEX)] }, '192.0.2.1': NX_APEX },
    });
    await expect(createDnsLookup(wrongSoa).checkChallenge(SUB, APEX, TOKEN)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_no_zone' });
    const rightSoa = fake({
      ns: { [SUB]: ['ns.sub.test'], [APEX]: ['ns1.dns.test'] },
      a: { 'ns.sub.test': ['192.0.2.60'], 'ns1.dns.test': ['192.0.2.1'] },
      servers: { '192.0.2.60': { rcode: 3, authority: [soa(SUB)] }, '192.0.2.1': NX_APEX },
    });
    await expect(createDnsLookup(rightSoa).checkChallenge(SUB, APEX, TOKEN)).resolves.toEqual({ verdict: 'absent', errorCode: null });
  });

  it('★ 위임된 하위 존의 NS 가 dangling(비권한 · REFUSED)이면 그 이름은 error — apex 가 부재여도 absent 로 합치지 않는다', async () => {
    for (const shape of [{ aa: false, rcode: 3, authority: [soa(SUB)] }, { rcode: 5 }] as const) {
      const transport = fake({
        ns: { [SUB]: ['ns.gone.test'], [APEX]: ['ns1.dns.test'] },
        a: { 'ns.gone.test': ['192.0.2.70'], 'ns1.dns.test': ['192.0.2.1'] },
        servers: { '192.0.2.70': shape as ReplyShape, '192.0.2.1': NX_APEX },
      });
      expect((await createDnsLookup(transport).checkChallenge(SUB, APEX, TOKEN)).verdict).toBe('error');
    }
  });

  it('하위 존 위임 확인이 실패하면(NS 질의 SERVFAIL) 서브도메인 이름은 error — 부모 존의 답을 세지 않는다', async () => {
    const transport = fake({
      ns: { [SUB]: 'ESERVFAIL', [APEX]: ['ns1.dns.test'] },
      a: { 'ns1.dns.test': ['192.0.2.1'] },
      servers: { '192.0.2.1': NX_APEX },
    });
    await expect(createDnsLookup(transport).checkChallenge(SUB, APEX, TOKEN)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_ns_lookup_failed' });
    expect(transport.calls.exchange).toEqual(['192.0.2.1']);
  });

  it('도메인 = registrable 이면 이름 하나만 묻는다', async () => {
    const transport = fake({ ...TWO_NS, servers: { '192.0.2.1': { answers: [challengeTxt()] }, '192.0.2.2': { answers: [challengeTxt()] } } });
    await expect(createDnsLookup(transport).checkChallenge(APEX, APEX, TOKEN)).resolves.toEqual({ verdict: 'present', errorCode: null });
    expect(transport.calls.exchange).toHaveLength(2);
  });
});

describe('서브도메인 MX — 판정 표', () => {
  const mx = (host: string, preference = 10): Rr => ({ name: SUB, type: 'MX', value: host, preference });

  it('MX 없음(NODATA·NXDOMAIN + SOA) → missing · 널 MX(.) → missing', async () => {
    const transport = fake({ ...TWO_NS, servers: { '192.0.2.1': { authority: [soa(APEX)] }, '192.0.2.2': { rcode: 3, authority: [soa(APEX)] } } });
    await expect(createDnsLookup(transport).checkMx(SUB, APEX)).resolves.toEqual({ verdict: 'missing', errorCode: null });
    const nullMx = fake({ ...TWO_NS, servers: { '192.0.2.1': { answers: [mx('', 0)] }, '192.0.2.2': { answers: [mx('', 0)] } } });
    await expect(createDnsLookup(nullMx).checkMx(SUB, APEX)).resolves.toEqual({ verdict: 'missing', errorCode: null });
  });

  it('SES 수신 엔드포인트만 → ses · 하나라도 다른 곳 → other · CNAME → other', async () => {
    const ses = fake({ ...TWO_NS, servers: { '192.0.2.1': { answers: [mx(SES_INBOUND_MX_HOST)] }, '192.0.2.2': { answers: [mx(SES_INBOUND_MX_HOST.toUpperCase())] } } });
    await expect(createDnsLookup(ses).checkMx(SUB, APEX)).resolves.toEqual({ verdict: 'ses', errorCode: null });
    const mixed = fake({ ...TWO_NS, servers: { '192.0.2.1': { answers: [mx(SES_INBOUND_MX_HOST), mx('mx.mail.test', 20)] }, '192.0.2.2': { answers: [mx(SES_INBOUND_MX_HOST), mx('mx.mail.test', 20)] } } });
    await expect(createDnsLookup(mixed).checkMx(SUB, APEX)).resolves.toEqual({ verdict: 'other', errorCode: null });
    const alias = fake({ ...TWO_NS, servers: { '192.0.2.1': { answers: [{ name: SUB, type: 'CNAME', value: 'x.other.test' }] }, '192.0.2.2': { answers: [{ name: SUB, type: 'CNAME', value: 'x.other.test' }] } } });
    await expect(createDnsLookup(alias).checkMx(SUB, APEX)).resolves.toEqual({ verdict: 'other', errorCode: null });
  });

  it('서버끼리 다르면 error · 비권한 응답이면 error', async () => {
    const split = fake({ ...TWO_NS, servers: { '192.0.2.1': { answers: [mx(SES_INBOUND_MX_HOST)] }, '192.0.2.2': { authority: [soa(APEX)] } } });
    await expect(createDnsLookup(split).checkMx(SUB, APEX)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_disagreement' });
    const lame = fake({ ...TWO_NS, servers: { '192.0.2.1': { authority: [soa(APEX)] }, '192.0.2.2': { aa: false, authority: [soa(APEX)] } } });
    await expect(createDnsLookup(lame).checkMx(SUB, APEX)).resolves.toEqual({ verdict: 'error', errorCode: 'dns_not_authoritative' });
  });

  it('★ CNAME 을 따라간 NS 답(소유자가 다른 이름)은 위임이 아니다 — 부모 존의 서버에 묻는다(보안 재검증 LOW-4)', async () => {
    const transport = fake({
      ns: { [SUB]: [{ owner: 'target.other.test', host: 'ns.other.test' }], [APEX]: ['ns1.dns.test'] },
      a: { 'ns.other.test': ['192.0.2.99'], 'ns1.dns.test': ['192.0.2.1'] },
      servers: { '192.0.2.1': { answers: [{ name: SUB, type: 'CNAME', value: 'target.other.test' }] }, '192.0.2.99': { answers: [mx(SES_INBOUND_MX_HOST)] } },
    });
    await expect(createDnsLookup(transport).checkMx(SUB, APEX)).resolves.toEqual({ verdict: 'other', errorCode: null });
    expect(transport.calls.exchange).toEqual(['192.0.2.1']);
  });

  it('서브도메인이 위임됐으면 그 NS 에 묻는다(가장 깊은 위임)', async () => {
    const transport = fake({
      ns: { [SUB]: ['ns.sub.test'], [APEX]: ['ns1.dns.test'] },
      a: { 'ns.sub.test': ['192.0.2.77'], 'ns1.dns.test': ['192.0.2.1'] },
      servers: { '192.0.2.77': { answers: [mx(SES_INBOUND_MX_HOST)] } },
    });
    await expect(createDnsLookup(transport).checkMx(SUB, APEX)).resolves.toEqual({ verdict: 'ses', errorCode: null });
    expect(transport.calls.exchange).toEqual(['192.0.2.77']);
  });
});
