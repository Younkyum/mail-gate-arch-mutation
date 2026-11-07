/**
 * Domain Connect 적용 URL(`src/domains/dc-url.ts`) — 순서 · 인코딩 · 서명 대상(보내는 문자열 그대로) · 결정성 · 공개키 TXT 왕복 ·
 * 서브도메인 = `host`(변수 아님) · apex 자체는 서명 전에 거부 · 템플릿 하나(동의 한 번)의 레코드 요약 7줄.
 */

import { createPublicKey, generateKeyPairSync, sign as rsaSign, verify } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyParamsOf,
  buildApplyUrl,
  DC_PROVIDER_ID,
  DC_PUBKEY_CHUNK,
  DC_PUBKEY_DOMAIN,
  DC_REDIRECT_DOMAIN,
  DC_SERVICE_ID,
  connectRecordsOf,
  DomainConnectInputError,
  hostOf,
  pubkeyTxtValues,
  queryStringOf,
  redirectUriOf,
  spkiFromPubkeyTxt,
  type DcSigner,
  type DomainConnectRow,
} from '../../../src/domains/dc-url';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer: DcSigner = { sign: (message) => Promise.resolve(rsaSign('sha256', message, privateKey)) };
const spki = publicKey.export({ format: 'der', type: 'spki' });

const ID = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'A'.repeat(20) + '_-' + 'b'.repeat(21);
const DKIM = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
const row = (over: Partial<DomainConnectRow> = {}): DomainConnectRow => ({
  id: ID,
  domain: 'agents.example.co.uk',
  registrable: 'example.co.uk',
  challengeToken: TOKEN,
  dkimTokens: DKIM,
  ...over,
});

/** URL → (서명 대상 쿼리, sig, key). 업체가 하는 대로 `sig`·`key` 를 떼어 낸다. */
function split(url: string): { base: string; signed: string; sig: string; key: string } {
  const [base = '', query = ''] = url.split('?');
  const pairs = query.split('&');
  const sig = pairs.find((pair) => pair.startsWith('sig='))?.slice(4) ?? '';
  const key = pairs.find((pair) => pair.startsWith('key='))?.slice(4) ?? '';
  return { base, signed: pairs.filter((pair) => !pair.startsWith('sig=') && !pair.startsWith('key=')).join('&'), sig, key };
}

describe('Domain Connect 적용 URL', () => {
  it('mail 하나: domain=apex & host=서브도메인(변수 아님) → token → t1..t3 → redirect_uri · sig·key 는 끝 · 공개키로 검증된다', async () => {
    const url = await buildApplyUrl({ urlSyncUX: 'https://dash.example-dns.test/dc/', row: row(), signer });
    const { base, signed, sig, key } = split(url);
    expect(base).toBe('https://dash.example-dns.test/dc/v2/domainTemplates/providers/atmark.ai/services/mail/apply');
    expect(signed).toBe(
      `domain=example.co.uk&host=agents&token=${TOKEN}&t1=${DKIM[0]}&t2=${DKIM[1]}&t3=${DKIM[2]}&redirect_uri=${encodeURIComponent(`https://console.atmark.ai/app?dc=1&d=${ID}`)}`,
    );
    expect(key).toBe('_dcpubkeyv1');
    expect(url.endsWith(`&sig=${sig}&key=_dcpubkeyv1`)).toBe(true);
    const signature = Buffer.from(decodeURIComponent(sig), 'base64');
    expect(verify('sha256', Buffer.from(signed, 'utf8'), createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature)).toBe(true);
    // 한 글자라도 바꾸면 검증 실패(서명 대상 = 보낸 문자열 그대로).
    expect(verify('sha256', Buffer.from(signed.replace('example', 'exampla'), 'utf8'), publicKey, signature)).toBe(false);
  });

  it('깊은 서브도메인 = 여러 라벨의 host · 같은 입력이면 같은 URL(결정적)', async () => {
    const input = { urlSyncUX: 'https://dash.example-dns.test', row: row({ domain: 'mx.agents.example.co.uk' }), signer };
    const url = await buildApplyUrl(input);
    expect(url).toBe(await buildApplyUrl(input));
    const { base, signed } = split(url);
    expect(base).toBe('https://dash.example-dns.test/v2/domainTemplates/providers/atmark.ai/services/mail/apply');
    expect(signed.startsWith('domain=example.co.uk&host=mx.agents&token=')).toBe(true);
  });

  it('★ 고객 도메인이 apex 자체면 서명하지 않는다(apex_not_allowed — 서버 쪽 방어, 템플릿 hostRequired 없음)', async () => {
    expect(() => hostOf('example.com', 'example.com')).toThrow(new DomainConnectInputError('apex_not_allowed'));
    expect(() => applyParamsOf(row({ domain: 'example.co.uk' }))).toThrow(DomainConnectInputError);
    let calls = 0;
    const counting: DcSigner = { sign: (message) => ((calls += 1), signer.sign(message)) };
    await expect(buildApplyUrl({ urlSyncUX: 'https://dash.example-dns.test', row: row({ domain: 'example.co.uk' }), signer: counting })).rejects.toThrow(DomainConnectInputError);
    expect(calls).toBe(0);
  });

  it('행 값이 모양을 벗어나면 서명하지 않는다 — 토큰 · DKIM · 등록 apex 밖 도메인 · urlSyncUX(https 아님 · 쿼리 · 자격)', async () => {
    expect(() => applyParamsOf(row({ challengeToken: 'x&host=evil' }))).toThrow(DomainConnectInputError);
    expect(() => applyParamsOf(row({ dkimTokens: [] }))).toThrow(DomainConnectInputError);
    expect(() => applyParamsOf(row({ dkimTokens: ['a', 'b'] }))).toThrow(DomainConnectInputError);
    expect(() => applyParamsOf(row({ dkimTokens: ['A'.repeat(32), 'b', 'c'] }))).toThrow(DomainConnectInputError);
    expect(() => applyParamsOf(row({ domain: 'agents.other.com' }))).toThrow(DomainConnectInputError);
    expect(() => hostOf('agents.other.com', 'example.com')).toThrow(DomainConnectInputError);
    expect(() => hostOf('agents.notexample.com', 'example.com')).toThrow(DomainConnectInputError);
    let calls = 0;
    const counting: DcSigner = { sign: (message) => ((calls += 1), signer.sign(message)) };
    for (const urlSyncUX of ['http://dash.example-dns.test', 'https://dash.example-dns.test/?a=1', 'https://u:p@dash.example-dns.test', 'not a url']) {
      await expect(buildApplyUrl({ urlSyncUX, row: row(), signer: counting }), urlSyncUX).rejects.toThrow(DomainConnectInputError);
    }
    expect(calls).toBe(0);
  });

  it('쿼리 인코딩 — encodeURIComponent(공백 · & · = · / · : 모두 인코딩)', () => {
    expect(queryStringOf([['a b', 'x&y=z/:']])).toBe('a%20b=x%26y%3Dz%2F%3A');
    expect(redirectUriOf(ID)).toBe(`https://console.atmark.ai/app?dc=1&d=${ID}`);
  });

  it('레코드 요약 — 템플릿 하나가 넣는 8줄 = 수동 표(dnsRecordsFor)와 같은 이름·순서 · 소유 TXT 는 서브도메인 아래 · DMARC(권장) 마지막', () => {
    expect(connectRecordsOf(row()).map((record) => [record.purpose, record.type, record.name])).toEqual([
      ['ownership', 'TXT', '_atmark-challenge.agents.example.co.uk'],
      ['inbound_mx', 'MX', 'agents.example.co.uk'],
      ['mail_from_mx', 'MX', 'bounce.agents.example.co.uk'],
      ['mail_from_spf', 'TXT', 'bounce.agents.example.co.uk'],
      ['dkim', 'CNAME', `${DKIM[0]}._domainkey.agents.example.co.uk`],
      ['dkim', 'CNAME', `${DKIM[1]}._domainkey.agents.example.co.uk`],
      ['dkim', 'CNAME', `${DKIM[2]}._domainkey.agents.example.co.uk`],
      ['dmarc', 'TXT', '_dmarc.agents.example.co.uk'],
    ]);
  });
});

describe('공개키 TXT(`_dcpubkeyv1.dc.atmark.ai`)', () => {
  it('RSA 2048 SPKI → p=1,a=RS256,d=… 두 줄 · 줄마다 255바이트 안 · 순서를 섞어도 같은 키로 재조립', () => {
    const values = pubkeyTxtValues(spki);
    expect(values).toHaveLength(2);
    expect(values[0]?.startsWith('p=1,a=RS256,d=MIIBIjAN')).toBe(true);
    for (const value of values) expect(Buffer.byteLength(value)).toBeLessThanOrEqual(255);
    expect(values[0]?.length).toBe('p=1,a=RS256,d='.length + DC_PUBKEY_CHUNK);
    expect(spkiFromPubkeyTxt([...values].reverse()).equals(spki)).toBe(true);
    expect(() => spkiFromPubkeyTxt(['p=1,a=ES256,d=AAAA'])).toThrow(DomainConnectInputError);
  });
});

describe('템플릿 파일(ops/domain-connect)과 코드가 같은 계약을 쓴다', () => {
  type Template = { providerId: string; serviceId: string; syncPubKeyDomain: string; syncRedirectDomain: string; hostRequired: boolean; records: Record<string, unknown>[] };
  const dir = join(process.cwd(), 'ops/domain-connect');
  const template = JSON.parse(readFileSync(join(dir, `atmark.ai.${DC_SERVICE_ID}.json`), 'utf8')) as Template;
  const variablesOf = (records: Record<string, unknown>[]): string[] =>
    [...new Set(records.flatMap((record) => Object.values(record).filter((value): value is string => typeof value === 'string').flatMap((value) => [...value.matchAll(/%([a-z0-9]+)%/gi)].map((m) => m[1] ?? ''))))].sort();

  it('템플릿 파일은 하나뿐 · serviceId · providerId · 공개키/복귀 도메인 · 변수 = 적용 쿼리의 변수(domain·host 제외) · host 변수 없음(규칙 8)', () => {
    expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toEqual([`atmark.ai.${DC_SERVICE_ID}.json`]);
    expect(template.serviceId).toBe(DC_SERVICE_ID);
    expect(template.providerId).toBe(DC_PROVIDER_ID);
    expect(template.syncPubKeyDomain).toBe(DC_PUBKEY_DOMAIN);
    expect(template.syncRedirectDomain).toBe(DC_REDIRECT_DOMAIN);
    // hostRequired 를 켜면 린터 DCTL1037 로 자동 병합이 막힌다 — apex 거부는 서버(hostOf)가 맡는다.
    expect(template.hostRequired).toBe(false);
    const params = applyParamsOf(row()).map(([key]) => key).filter((key) => key !== 'domain' && key !== 'host');
    expect(variablesOf(template.records)).toEqual([...params].sort());
    for (const record of template.records) expect(String(record['host'])).not.toMatch(/%(host|sub|domain|fqdn)%/);
  });

  it('템플릿 레코드를 host 기준으로 풀면 수동 표(dnsRecordsFor)와 같은 종류·이름·값이다', () => {
    const r = row();
    const fill = (value: string): string => value.replace(/%token%/g, r.challengeToken).replace(/%t([123])%/g, (_, n: string) => r.dkimTokens[Number(n) - 1] ?? '');
    const fqdn = (host: string): string => (host === '@' ? r.domain : `${fill(host)}.${r.domain}`);
    const fromTemplate = template.records.map((record) => {
      const host = fqdn(String(record['host']));
      switch (record['type']) {
        case 'TXT':
          return ['TXT', host, fill(String(record['data']))];
        case 'MX':
          return ['MX', host, `${String(record['priority'])} ${String(record['pointsTo'])}`];
        case 'SPFM':
          return ['TXT', host, `v=spf1 ${String(record['spfRules'])} ~all`];
        default:
          return [String(record['type']), host, fill(String(record['pointsTo']))];
      }
    });
    expect(fromTemplate).toEqual(connectRecordsOf(r).map((record) => [record.type, record.name, record.value]));
  });

  it('TXT 는 모두 conflict matching(Prefix) — 소유 TXT 는 옛 토큰을, DMARC 는 같은 호스트의 옛 DMARC 를 바꾼다(중복 v=DMARC1 은 DMARC 를 깨뜨린다) · DMARC 만 essential OnApply', () => {
    const txt = template.records.filter((record) => record['type'] === 'TXT');
    expect(txt.map((record) => [record['host'], record['txtConflictMatchingMode'], record['txtConflictMatchingPrefix'], record['essential']])).toEqual([
      ['_atmark-challenge', 'Prefix', 'atmark-domain-verification=', undefined],
      ['_dmarc', 'Prefix', 'v=DMARC1', 'OnApply'],
    ]);
  });
});
