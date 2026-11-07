/**
 * Domain Connect 발견(`src/domains/dc-discovery.ts`) — 가짜 DNS · HTTP. 정상 경로 · 업체 미지원 · SSRF 거부(IP 리터럴 · 내부 이름 · 사설 주소 ·
 * http · 섞인 응답) · 캐시(5분 · 부정 결과도).
 */

import { describe, expect, it } from 'vitest';

import { checkDiscoveryUrl, createDomainConnectDiscovery, DC_CACHE_TTL_MS, type DiscoveryPorts, type HttpGetResult, type ResolvedAddress } from '../../../src/domains/dc-discovery';

const PUBLIC: readonly ResolvedAddress[] = [{ address: '104.16.132.229', family: 4 }];
const SETTINGS = {
  providerId: 'cloudflare.com',
  providerName: 'Cloudflare',
  urlSyncUX: 'https://dash.cloudflare.com/domainconnect',
  urlAPI: 'https://api.cloudflare.com/client/v4/dns/domainconnect',
};

interface Fake {
  readonly ports: DiscoveryPorts;
  readonly gets: string[];
  readonly pinned: string[];
  clock: number;
}

function fake(options: {
  txt?: string[][] | Error;
  addresses?: Record<string, readonly ResolvedAddress[]>;
  responses?: Record<string, HttpGetResult>;
}): Fake {
  const state: Fake = {
    gets: [],
    pinned: [],
    clock: 0,
    ports: {
      resolveTxt: (name) => {
        expect(name).toBe('_domainconnect.example.com');
        return options.txt instanceof Error ? Promise.reject(options.txt) : Promise.resolve(options.txt ?? [['api.cloudflare.com/client/v4/dns/domainconnect']]);
      },
      resolveAddresses: (hostname) => Promise.resolve(options.addresses?.[hostname] ?? PUBLIC),
      getJson: (url, pinned) => {
        state.gets.push(url.href);
        state.pinned.push(pinned.address);
        return Promise.resolve(options.responses?.[url.href] ?? { status: 404, json: null });
      },
      now: () => state.clock,
    },
  };
  return state;
}

const SETTINGS_URL = 'https://api.cloudflare.com/client/v4/dns/domainconnect/v2/example.com/settings';
const TEMPLATE_URL = 'https://api.cloudflare.com/client/v4/dns/domainconnect/v2/domainTemplates/providers/atmark.ai/services/mail';
const ok = { [SETTINGS_URL]: { status: 200, json: SETTINGS }, [TEMPLATE_URL]: { status: 200, json: {} } };

describe('Domain Connect 발견', () => {
  it('TXT → settings → 템플릿 200 = supported · 검사한 주소로 고정 연결', async () => {
    const f = fake({ responses: ok });
    const result = await createDomainConnectDiscovery(f.ports).discover('example.com', 'mail');
    expect(result).toEqual({ supported: true, providerName: 'Cloudflare', urlSyncUX: SETTINGS.urlSyncUX });
    expect(f.gets).toEqual([SETTINGS_URL, TEMPLATE_URL]);
    expect(f.pinned).toEqual(['104.16.132.229', '104.16.132.229']);
  });

  it('미지원: TXT 없음 · settings 404 · 템플릿 404 · settings 모양 틀림(urlSyncUX http · 이름에 제어문자)', async () => {
    const notFound = Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    expect(await createDomainConnectDiscovery(fake({ txt: notFound }).ports).discover('example.com', 'mail')).toEqual({ supported: false, reason: 'no_domainconnect_record' });
    expect(await createDomainConnectDiscovery(fake({}).ports).discover('example.com', 'mail')).toEqual({ supported: false, reason: 'settings_unavailable' });
    expect(await createDomainConnectDiscovery(fake({ responses: { [SETTINGS_URL]: { status: 200, json: SETTINGS } } }).ports).discover('example.com', 'mail')).toEqual({
      supported: false,
      reason: 'template_unsupported',
    });
    for (const json of [{ ...SETTINGS, urlSyncUX: 'http://dash.cloudflare.com' }, { ...SETTINGS, providerName: 'Evil\u0007' }, { ...SETTINGS, urlAPI: 'https://127.0.0.1' }, null]) {
      const f = fake({ responses: { [SETTINGS_URL]: { status: 200, json } } });
      expect(await createDomainConnectDiscovery(f.ports).discover('example.com', 'mail')).toEqual({ supported: false, reason: 'bad_settings' });
    }
  });

  it('SSRF: TXT 가 IP · localhost · 내부 이름 · 포트 · 이상한 모양이면 요청 0 · 사설/메타데이터/섞인 주소면 요청 0', async () => {
    for (const [txt, reason] of [
      ['127.0.0.1/dc', 'blocked_destination'],
      ['169.254.169.254', 'blocked_destination'],
      ['localhost/x', 'bad_domainconnect_record'],
      ['a.localhost/x', 'blocked_destination'],
      ['dc.internal', 'blocked_destination'],
      ['metadata', 'bad_domainconnect_record'],
      ['api.example.com:8443/dc', 'bad_domainconnect_record'],
      ['https://api.example.com', 'bad_domainconnect_record'],
      ['api.example.com/a?b=c', 'bad_domainconnect_record'],
    ] as const) {
      const f = fake({ txt: [[txt]] });
      expect(await createDomainConnectDiscovery(f.ports).discover('example.com', 'mail'), txt).toEqual({ supported: false, reason });
      expect(f.gets, txt).toEqual([]);
    }
    for (const addresses of [
      [{ address: '10.0.0.5', family: 4 }],
      [{ address: '169.254.169.254', family: 4 }],
      [{ address: 'fd00:ec2::254', family: 6 }],
      [...PUBLIC, { address: '192.168.1.1', family: 4 }],
    ] as ResolvedAddress[][]) {
      const f = fake({ addresses: { 'api.cloudflare.com': addresses }, responses: ok });
      expect(await createDomainConnectDiscovery(f.ports).discover('example.com', 'mail')).toEqual({ supported: false, reason: 'blocked_destination' });
      expect(f.gets).toEqual([]);
    }
  });

  it('checkDiscoveryUrl — https 공개 이름만', () => {
    expect(checkDiscoveryUrl('https://api.cloudflare.com/x')).not.toBeNull();
    for (const raw of ['http://api.cloudflare.com', 'https://[::1]/', 'https://0x7f.1/', 'https://u:p@api.cloudflare.com', 'https://api.cloudflare.com/#x', 'https://host', 'https://a.localhost'])
      expect(checkDiscoveryUrl(raw), raw).toBeNull();
  });

  it('캐시 5분 — 같은 apex 는 다시 묻지 않는다(부정 결과 포함) · 지나면 다시', async () => {
    const f = fake({ responses: ok });
    const discovery = createDomainConnectDiscovery(f.ports);
    await discovery.discover('example.com', 'mail');
    await discovery.discover('example.com', 'mail');
    expect(f.gets).toHaveLength(2);
    f.clock += DC_CACHE_TTL_MS + 1;
    await discovery.discover('example.com', 'mail');
    expect(f.gets).toHaveLength(4);
  });

  it('네트워크 오류는 supported:false(던지지 않는다)', async () => {
    const f = fake({});
    const ports: DiscoveryPorts = { ...f.ports, getJson: () => Promise.reject(new Error('ECONNRESET')) };
    expect(await createDomainConnectDiscovery(ports).discover('example.com', 'mail')).toEqual({ supported: false, reason: 'network_error' });
  });
});
