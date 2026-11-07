/**
 * `destination.ts` — SSRF. **대역마다 한 줄씩** 단언한다: 목록에서 대역 하나를 지우면
 * 그 줄이 빨간불이 된다(되돌리기 확인 대상).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  checkWebhookUrl,
  classifyAddress,
  resolveDestination,
  type HostResolver,
} from '../../../src/webhooks/destination';

describe('주소 분류 — 막히는 대역', () => {
  it.each([
    ['0.0.0.0', 'this_network'],
    ['10.1.2.3', 'private'],
    ['100.100.100.200', 'shared_cgnat'], // Alibaba 메타데이터
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link_local'], // AWS·GCP·Azure 메타데이터
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.192', 'ietf_protocol'],
    ['192.0.2.1', 'documentation'],
    ['192.88.99.1', 'relay_6to4'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['198.51.100.1', 'documentation'],
    ['203.0.113.1', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
  ])('IPv4 %s → %s', (address, range) => {
    expect(classifyAddress(address)).toEqual({ kind: 'blocked', range });
  });

  it.each([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['::ffff:169.254.169.254', 'ipv4_mapped'],
    ['::ffff:127.0.0.1', 'ipv4_mapped'],
    ['::ffff:8.8.8.8', 'ipv4_mapped'], // 공인 v4 라도 mapped 표기는 받지 않는다(허용 목록 밖)
    ['64:ff9b::a9fe:a9fe', 'nat64'], // NAT64 로 169.254.169.254
    ['fd00:ec2::254', 'unique_local'], // EC2 IMDS IPv6
    ['fc00::1', 'unique_local'],
    ['fe80::1', 'link_local'],
    ['fe80::1%en0', 'link_local'],
    ['ff02::1', 'multicast'],
    ['::a9fe:a9fe', 'reserved'], // IPv4-compatible(폐기) 표기
    ['100::1', 'reserved'], // discard
    ['2001:db8::1', 'documentation'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'ietf_protocol'], // Teredo
    ['2002:a9fe:a9fe::1', 'embedded_6to4'], // 6to4 로 169.254.169.254
    ['3fff::1', 'documentation'],
  ])('IPv6 %s → %s', (address, range) => {
    expect(classifyAddress(address)).toEqual({ kind: 'blocked', range });
  });

  it.each(['example.com', '', '1.2.3', '::g'])('IP 가 아닌 것(%s)은 막힌다 — 모르는 것은 공인이 아니다', (value) => {
    expect(classifyAddress(value).kind).toBe('blocked');
  });
});

describe('주소 분류 — 통과하는 공인 주소', () => {
  it.each(['8.8.8.8', '1.1.1.1', '93.184.215.14', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e'])(
    '%s',
    (address) => {
      expect(classifyAddress(address)).toEqual({ kind: 'public' });
    },
  );
});

describe('URL 정적 검사', () => {
  it('정상 https URL 은 통과한다', () => {
    expect(checkWebhookUrl('https://hooks.example.com/atmark?x=1')).toMatchObject({ kind: 'ok', literal: null });
  });

  it.each([
    ['http', 'http://hooks.example.com/', 'not_https'],
    ['file', 'file:///etc/passwd', 'not_https'],
    ['gopher', 'gopher://hooks.example.com/', 'not_https'],
    ['자격증명', 'https://u:p@hooks.example.com/', 'credentials_in_url'],
    ['fragment', 'https://hooks.example.com/#x', 'fragment_in_url'],
    ['파싱 불가', 'not a url', 'invalid_url'],
    ['길이 초과', `https://hooks.example.com/${'a'.repeat(2100)}`, 'invalid_url'],
    ['localhost', 'https://localhost/', 'internal_hostname'],
    ['*.localhost', 'https://api.localhost/', 'internal_hostname'],
    ['점 없는 이름(search domain)', 'https://metadata/', 'internal_hostname'],
    ['.internal', 'https://metadata.google.internal/', 'internal_hostname'],
    ['.local', 'https://printer.local/', 'internal_hostname'],
  ])('거부: %s', (_label, raw, reason) => {
    expect(checkWebhookUrl(raw)).toMatchObject({ kind: 'rejected', reason });
  });

  // WHATWG URL 파서가 먼저 정규화한다 — 그 전제가 깨지면 이 표가 빨개진다.
  it.each([
    ['https://127.0.0.1/', 'loopback'],
    ['https://0x7f.1/', 'loopback'],
    ['https://2130706433/', 'loopback'],
    ['https://0177.0.0.1/', 'loopback'],
    ['https://169.254.169.254/latest/meta-data/', 'link_local'],
    ['https://0xa9fea9fe/', 'link_local'],
    ['https://[::1]/', 'loopback'],
    ['https://[::ffff:169.254.169.254]/', 'ipv4_mapped'],
    ['https://[fd00:ec2::254]/', 'unique_local'],
  ])('IP 리터럴 우회 표기 거부: %s', (raw, range) => {
    expect(checkWebhookUrl(raw)).toEqual({ kind: 'rejected', reason: 'blocked_address', range });
  });
});

describe('해석 + 고정', () => {
  const resolverOf = (...addresses: string[]): HostResolver =>
    vi.fn(async () => addresses.map((address) => ({ address, family: address.includes(':') ? (6 as const) : (4 as const) })));

  it('공인 주소로 풀리면 그 IP 를 고정해 돌려준다(호스트명은 SNI 용으로 따로)', async () => {
    const resolve = resolverOf('93.184.215.14');
    expect(await resolveDestination('https://hooks.example.com/x', resolve)).toMatchObject({
      kind: 'pinned',
      hostname: 'hooks.example.com',
      address: '93.184.215.14',
      family: 4,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['메타데이터로 풀리는 이름', ['169.254.169.254']],
    ['루프백으로 풀리는 이름', ['127.0.0.1']],
    ['IPv6 루프백', ['::1']],
    ['공인+사설 혼합 — 하나라도 막히면 거부', ['93.184.215.14', '10.0.0.5']],
    ['사설이 뒤에 있어도', ['2606:4700:4700::1111', 'fd00:ec2::254']],
  ])('%s → blocked_address', async (_label, addresses) => {
    expect(await resolveDestination('https://evil.example.com/', resolverOf(...addresses))).toMatchObject({
      kind: 'rejected',
      reason: 'blocked_address',
    });
  });

  it('리졸버 실패·빈 응답은 dns_failure (재시도 대상)', async () => {
    expect(await resolveDestination('https://hooks.example.com/', vi.fn(async () => Promise.reject(new Error('ENOTFOUND'))))).toEqual({
      kind: 'dns_failure',
    });
    expect(await resolveDestination('https://hooks.example.com/', resolverOf())).toEqual({ kind: 'dns_failure' });
  });

  it('IP 리터럴은 리졸버를 부르지 않는다', async () => {
    const resolve = resolverOf('10.0.0.1');
    expect(await resolveDestination('https://[2606:4700:4700::1111]/', resolve)).toMatchObject({
      kind: 'pinned',
      address: '2606:4700:4700::1111',
      family: 6,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('정적 검사에서 거부된 URL 은 리졸버를 부르지 않는다', async () => {
    const resolve = resolverOf('93.184.215.14');
    expect((await resolveDestination('https://localhost/', resolve)).kind).toBe('rejected');
    expect(resolve).not.toHaveBeenCalled();
  });
});
