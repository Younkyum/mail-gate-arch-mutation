/**
 * 도메인 화면 — 레코드 한 번에 넣기(2026-10-05 진윤겸 요청).
 *   Ⓩ-1~ 순수 함수 `buildZoneFile`(`src/admin/ui/console/zonefile.ts` 의 `ZONEFILE_JS` 를 vm 으로 — 앱 스크립트가 싣는 바로 그 글):
 *     표와 같은 순서 · 절대 이름(끝 점) · TTL 3600 IN · TXT 따옴표/이스케이프/255자 조각 · MX 우선순위 · CNAME 대상 끝 점 + Cloudflare 프록시 끔 주석 ·
 *     레코드가 없는 무리는 머리째 빠진다(2026-10 one-shot — 파일 하나에 전부, "다시 받으라" 주석 없음) · 이름 모양이 아닌 값은 그 줄을 뺀다 ·
 *     결정적 · ASCII 만.
 *   Ⓩ-UI (ko/en) 표 위 `레코드 파일 받기` · `모두 복사` · Cloudflare 안내 한 줄 · 파일 이름 · Blob · object URL 회수 · 클립보드 · 토스트 ·
 *     레코드 준비 중(DKIM 토큰 전)에는 두 단추가 잠긴다.
 */

import vm from 'node:vm';

import { afterEach, describe, expect, it } from 'vitest';

import { ZONEFILE_JS } from '../../../src/admin/ui/console/zonefile';
import { dnsRecordsFor } from '../../../src/domains/contract';
import { MESSAGES } from '../../../src/admin/ui/i18n';
import { renderAppPage } from '../../../src/admin/ui/index';

import { boot, domainDetail, DOMAINS, HANGUL, inlined, OVERRIDE, preparingDetail, resetTeam, t } from './console-harness';

afterEach(() => {
  OVERRIDE.clear();
  resetTeam();
});

interface Rec {
  readonly purpose: string;
  readonly type: string;
  readonly name: string;
  readonly value: string;
}
const ctx = vm.createContext({});
vm.runInContext(`${ZONEFILE_JS};this.build=buildZoneFile;this.fileName=zoneFileName;this.hasDkim=zoneHasDkim;`, ctx);
const zone = ctx as unknown as {
  build: (domain: unknown, records: unknown, now: unknown) => string;
  fileName: (domain: unknown) => string;
  hasDkim: (records: unknown) => boolean;
};
const NOW = Date.parse('2026-10-05T03:04:59.000Z');

const READY: Rec[] = [
  { purpose: 'dmarc', type: 'TXT', name: '_dmarc.agents.example.com', value: 'v=DMARC1; p=none' },
  { purpose: 'ownership', type: 'TXT', name: '_atmark-challenge.agents.example.com', value: 'atmark-domain-verification=tok' },
  ...['k1', 'k2', 'k3'].map((t) => ({ purpose: 'dkim', type: 'CNAME', name: `${t}._domainkey.agents.example.com`, value: `${t}.dkim.amazonses.com` })),
  { purpose: 'mail_from_mx', type: 'MX', name: 'bounce.agents.example.com', value: '10 feedback-smtp.ap-northeast-2.amazonses.com' },
  { purpose: 'mail_from_spf', type: 'TXT', name: 'bounce.agents.example.com', value: 'v=spf1 include:amazonses.com ~all' },
  { purpose: 'inbound_mx', type: 'MX', name: 'agents.example.com', value: '10 inbound-smtp.ap-northeast-2.amazonaws.com' },
];
const body = (text: string): string[] => text.split('\n').filter((l) => l !== '' && !l.startsWith(';'));

describe('Ⓩ buildZoneFile — BIND 존 파일', () => {
  it('Ⓩ-1 전체 글 — 머리 주석(영어) · 표 순서 · 절대 이름 · TTL 3600 IN · 열 맞춤 · CNAME 프록시 끔 주석 · 끝 줄바꿈', () => {
    expect(zone.build('agents.example.com', READY, NOW)).toBe(
      [
        '; Atmark DNS records for agents.example.com',
        '; Generated 2026-10-05 03:04 UTC',
        ';',
        '; Cloudflare: DNS > Records > Import and Export > Import, then upload this file.',
        '; Keep every record DNS only (proxy off). CNAME records must not be proxied.',
        '; TTL is 3600 seconds here. Auto TTL at your DNS provider works too.',
        '',
        '; Ownership',
        '_atmark-challenge.agents.example.com. 3600 IN TXT   "atmark-domain-verification=tok"',
        '',
        '; Receiving mail',
        'agents.example.com.                   3600 IN MX    10 inbound-smtp.ap-northeast-2.amazonaws.com.',
        '',
        '; Bounce address (MAIL FROM)',
        'bounce.agents.example.com.            3600 IN MX    10 feedback-smtp.ap-northeast-2.amazonses.com.',
        'bounce.agents.example.com.            3600 IN TXT   "v=spf1 include:amazonses.com ~all"',
        '',
        '; Signing (DKIM)',
        'k1._domainkey.agents.example.com.     3600 IN CNAME k1.dkim.amazonses.com. ; cf_tags=cf-proxied:false',
        'k2._domainkey.agents.example.com.     3600 IN CNAME k2.dkim.amazonses.com. ; cf_tags=cf-proxied:false',
        'k3._domainkey.agents.example.com.     3600 IN CNAME k3.dkim.amazonses.com. ; cf_tags=cf-proxied:false',
        '',
        '; DMARC (recommended)',
        '_dmarc.agents.example.com.            3600 IN TXT   "v=DMARC1; p=none"',
        '',
      ].join('\n'),
    );
  });

  it('Ⓩ-2 계약의 dnsRecordsFor 와 같은 레코드 수 · 모든 이름과 대상이 끝 점 · ASCII 만', () => {
    const recs = dnsRecordsFor('agents.example.com', 'tok', ['a1', 'b2', 'c3']);
    const text = zone.build('agents.example.com', recs, NOW);
    const lines = body(text);
    expect(lines).toHaveLength(recs.length);
    for (const l of lines) {
      const [name, ttl, cls, type, ...rest] = l.split(/\s+/);
      expect(name).toMatch(/\.$/);
      expect([ttl, cls]).toEqual(['3600', 'IN']);
      if (type === 'MX') expect(rest.slice(0, 2).join(' ')).toMatch(/^\d+ \S+\.$/);
      if (type === 'CNAME') expect(rest[0]).toMatch(/\.$/);
    }
    expect(text).toMatch(/^[\x0a\x20-\x7e]*$/);
  });

  it('Ⓩ-3 TXT — 따옴표 · 역슬래시 이스케이프 · 255자마다 조각', () => {
    const long = 'x'.repeat(255) + 'y'.repeat(255) + 'z'.repeat(10);
    const lines = body(zone.build('a.example.com', [
      { purpose: 'ownership', type: 'TXT', name: '_atmark-challenge.example.com', value: 'say "hi" \\ bye' },
      { purpose: 'mail_from_spf', type: 'TXT', name: 'bounce.a.example.com', value: long },
    ], NOW));
    expect(lines[0]).toMatch(/ TXT {3}"say \\"hi\\" \\\\ bye"$/);
    expect(lines[1]?.split(' IN TXT   ')[1]).toBe(`"${'x'.repeat(255)}" "${'y'.repeat(255)}" "${'z'.repeat(10)}"`);
  });

  it('Ⓩ-4 레코드가 없는 무리는 머리째 빠진다(파일 하나에 전부 — "다시 받으라" 주석 없음) · hasDkim', () => {
    const pending = READY.filter((r) => r.purpose !== 'dkim');
    const text = zone.build('agents.example.com', pending, NOW);
    expect(text).not.toContain('CNAME k');
    expect(text).not.toContain('; Signing (DKIM)');
    expect(text).not.toMatch(/again|appear here/i);
    expect(text.trimEnd().split('\n').slice(-6)).toEqual([
      '; Bounce address (MAIL FROM)',
      'bounce.agents.example.com.            3600 IN MX    10 feedback-smtp.ap-northeast-2.amazonses.com.',
      'bounce.agents.example.com.            3600 IN TXT   "v=spf1 include:amazonses.com ~all"',
      '',
      '; DMARC (recommended)',
      '_dmarc.agents.example.com.            3600 IN TXT   "v=DMARC1; p=none"',
    ]);
    expect(body(text)).toHaveLength(5);
    expect(zone.hasDkim(pending)).toBe(false);
    expect(zone.hasDkim(READY)).toBe(true);
  });

  it('Ⓩ-5 서버를 믿지 않는다 — 대문자 · 이미 붙은 끝 점은 정리, 이름 모양이 아닌 값 · 줄바꿈 · 모르는 형식 · 모르는 목적은 그 줄을 뺀다', () => {
    const lines = body(zone.build('Agents.Example.com.', [
      { purpose: 'inbound_mx', type: 'MX', name: 'Agents.Example.COM.', value: '10 Inbound.Example.net.' },
      { purpose: 'inbound_mx', type: 'MX', name: 'agents.example.com', value: 'ten host' },
      { purpose: 'inbound_mx', type: 'MX', name: 'agents.example.com', value: '70000 host.example.net' },
      { purpose: 'ownership', type: 'TXT', name: 'evil name.example.com', value: 'x' },
      { purpose: 'ownership', type: 'TXT', name: 'a.example.com\nb.example.com 3600 IN A 1.2.3.4', value: 'x' },
      { purpose: 'ownership', type: 'TXT', name: '_atmark-challenge.example.com', value: 'ok\nIN A 1.2.3.4' },
      { purpose: 'dkim', type: 'CNAME', name: 'k._domainkey.agents.example.com', value: 'not a host' },
      { purpose: 'dkim', type: 'A', name: 'k._domainkey.agents.example.com', value: '1.2.3.4' },
      { purpose: 'other', type: 'TXT', name: 'x.example.com', value: 'x' },
      null,
      'junk',
    ], NOW));
    expect(lines).toEqual([
      '_atmark-challenge.example.com. 3600 IN TXT   "okIN A 1.2.3.4"',
      'agents.example.com.            3600 IN MX    10 inbound.example.net.',
    ]);
    // 레코드가 아닌 값 — 머리 주석만(무리 없음).
    expect(body(zone.build('agents.example.com', 'nope', NOW))).toEqual([]);
    expect(zone.build('agents.example.com', 'nope', NOW)).not.toContain('; Ownership');
  });

  it('Ⓩ-6 결정적 — 같은 now 면 같은 글, now 가 달라도 레코드 줄은 같다 · 시각이 없으면 생성 줄을 뺀다', () => {
    expect(zone.build('agents.example.com', READY, NOW)).toBe(zone.build('agents.example.com', READY, NOW));
    const later = zone.build('agents.example.com', READY, NOW + 86_400_000);
    expect(later).toContain('; Generated 2026-10-06 03:04 UTC');
    expect(body(later)).toEqual(body(zone.build('agents.example.com', READY, NOW)));
    expect(zone.build('agents.example.com', READY, 'not a date')).not.toContain('Generated');
  });

  it('Ⓩ-7 파일 이름 — <domain>.atmark-dns.txt (이름 모양이 아니면 domain.atmark-dns.txt)', () => {
    expect(zone.fileName('agents.example.com')).toBe('agents.example.com.atmark-dns.txt');
    expect(zone.fileName('Agents.Example.com.')).toBe('agents.example.com.atmark-dns.txt');
    expect(zone.fileName('../../x y')).toBe('domain.atmark-dns.txt');
  });
});

const LANGS = ['ko', 'en'] as const;
const KEYS = [
  '레코드 파일 받기',
  '모두 복사',
  'Cloudflare: DNS → 레코드 → 가져오기 및 내보내기 → 가져오기',
  '복사하지 못했습니다. 레코드 파일을 받아 쓰세요.',
  '레코드 파일 설명',
];
interface FakeBlob {
  readonly parts: unknown[];
  readonly type: string;
}

describe.each(LANGS)('Ⓩ-UI 도메인 화면 — 한 번에 넣기 (%s)', (lang) => {
  it('Ⓩ-UI-1 마크업 — 표 위에 두 단추(그 언어) · Cloudflare 가져오기 안내 한 줄 · "DKIM 은 나중" 안내가 없다 · 사전 키가 두 언어에 있다', () => {
    for (const k of KEYS) {
      expect(MESSAGES.ko[k]).toBe(k);
      expect(MESSAGES.en[k]).toBeTruthy();
      expect(MESSAGES.en[k]).not.toMatch(HANGUL);
    }
    const html = inlined(renderAppPage(lang));
    const bar = /<div class="dzx" id="dd-zone">([\s\S]*?)<div class="dnsw"/.exec(html)?.[1] ?? '';
    expect(html.indexOf('id="dd-zone"')).toBeLessThan(html.indexOf('id="dd-tbl"'));
    expect(html.indexOf('id="dd-zone"')).toBeGreaterThan(html.indexOf('id="dd-rec-h"'));
    expect(/<button type="button" class="btn sm ghost" id="dd-zone-dl">[\s\S]*?<span>([^<]+)<\/span><\/button>/.exec(bar)?.[1]).toBe(t(lang, '레코드 파일 받기'));
    expect(/<button type="button" class="btn sm ghost" id="dd-zone-cp">[\s\S]*?<span>([^<]+)<\/span><\/button>/.exec(bar)?.[1]).toBe(t(lang, '모두 복사'));
    expect(/<div class="hrow small muted dzx-h"><span>([^<]+)<\/span>/.exec(bar)?.[1]).toBe(t(lang, KEYS[2] ?? ''));
    // 무엇이 되는지 · 프록시 · TTL 은 ⓘ 안(상시 글은 한 줄 — Ⓥ-2).
    expect(bar).toContain(`aria-label="${t(lang, '레코드 파일 설명')}"`);
    expect(/<div class="tip-pop" id="tip-zone" hidden>([\s\S]*?)<\/div>/.exec(bar)?.[1]).toContain(lang === 'ko' ? '프록시는 꺼 두세요' : 'Keep the proxy off');
    // one-shot: DKIM 을 나중에 다시 받으라는 줄은 없다(레코드가 처음부터 전부).
    expect(html).not.toContain('id="dd-zone-dkim"');
    expect(MESSAGES.en['DKIM 레코드는 소유 확인 뒤에 나옵니다 — 그때 파일을 한 번 더 받으세요.']).toBeUndefined();
    if (lang === 'en') expect(bar).not.toMatch(HANGUL);
  });

  it('Ⓩ-UI-2 사용 중 도메인 — 파일 받기: <domain>.atmark-dns.txt · text/plain Blob · 표와 같은 레코드 · object URL 회수 · 토스트', async () => {
    const w = await boot(lang, '#/domains/dm1', { timers: 'fast' });
    expect(w.el('dd-zone').hidden).toBe(false);
    expect(w.el('dd-zone-dl').disabled).toBe(false);
    w.el('dd-zone-dl').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.downloads).toHaveLength(1);
    expect(w.downloads[0]?.download).toBe('agents.example.com.atmark-dns.txt');
    expect(w.downloads[0]?.attached).toBe(true);
    const blob = w.objectUrls.created[0] as FakeBlob;
    expect(blob.type).toBe('text/plain;charset=utf-8');
    const text = String(blob.parts[0]);
    const d = domainDetail(DOMAINS[0]);
    expect(body(text)).toEqual(body(zone.build('agents.example.com', d.records, NOW)));
    expect(body(text).map((l) => l.split(/\s+/)[3])).toEqual(['TXT', 'MX', 'MX', 'TXT', 'CNAME', 'CNAME', 'CNAME', 'TXT']);
    expect(w.objectUrls.revoked).toEqual([w.downloads[0]?.href]);
    // 토스트(4초 — 빠른 타이머에서는 곧바로 사라지므로 보통 타이머로 한 번 더)
    const w2 = await boot(lang, '#/domains/dm1');
    w2.el('dd-zone-dl').click();
    expect(w2.el('toasts').children.map((c) => c.textContent)).toEqual([t(lang, '내려받았습니다: {f}').replace('{f}', 'agents.example.com.atmark-dns.txt')]);
  });

  it('Ⓩ-UI-3 확인 대기 도메인 — 파일 하나에 레코드 전부(소유 TXT 는 서브도메인 이름 · DKIM 셋 포함)', async () => {
    const w = await boot(lang, '#/domains/dm2', { timers: 'fast' });
    expect(w.el('dd-zone-dl').disabled).toBe(false);
    w.el('dd-zone-dl').click();
    expect(w.downloads[0]?.download).toBe('mail.example.org.atmark-dns.txt');
    const text = String((w.objectUrls.created[0] as FakeBlob).parts[0]);
    expect(body(text).map((l) => l.split(/\s+/)[3])).toEqual(['TXT', 'MX', 'MX', 'TXT', 'CNAME', 'CNAME', 'CNAME', 'TXT']);
    expect(body(text)[0]).toMatch(/^_atmark-challenge\.mail\.example\.org\. /);
    expect(text).not.toMatch(/again/i);
  });

  it('Ⓩ-UI-3b 레코드 준비 중(DKIM 토큰 전) — 파일 받기 · 모두 복사가 잠기고 눌러도 아무것도 만들지 않는다 · 준비되면 풀린다', async () => {
    OVERRIDE.set('/api/domains/dm2', { status: 200, json: { item: preparingDetail(DOMAINS[1]) } });
    const w = await boot(lang, '#/domains/dm2', { timers: 'fast', clipboard: 'ok' });
    expect(w.el('dd-zone-dl').disabled).toBe(true);
    expect(w.el('dd-zone-cp').disabled).toBe(true);
    w.el('dd-zone-dl').click();
    w.el('dd-zone-cp').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.downloads).toHaveLength(0);
    expect(w.clipboard).toHaveLength(0);
    // 다시 읽기(2초 간격)가 토큰을 가져오면 풀린다.
    OVERRIDE.set('/api/domains/dm2', { status: 200, json: { item: domainDetail(DOMAINS[1]) } });
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
    expect(w.el('dd-zone-dl').disabled).toBe(false);
    expect(w.el('dd-zone-cp').disabled).toBe(false);
  });

  it('Ⓩ-UI-4 모두 복사 — 클립보드에 같은 글 · "복사했습니다." 토스트', async () => {
    const w = await boot(lang, '#/domains/dm1', { clipboard: 'ok' });
    w.el('dd-zone-cp').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.clipboard).toHaveLength(1);
    expect(body(w.clipboard[0] ?? '')).toEqual(body(zone.build('agents.example.com', domainDetail(DOMAINS[0]).records, NOW)));
    expect(w.clipboard[0]).toMatch(/^; Atmark DNS records for agents\.example\.com\n/);
    expect(w.el('toasts').children.map((c) => c.textContent)).toEqual([t(lang, '복사했습니다.')]);
    expect(w.downloads).toHaveLength(0);
  });

  it('Ⓩ-UI-5 클립보드가 막히거나 없으면 — 파일을 받으라는 토스트(선택하라고 하지 않는다)', async () => {
    for (const clipboard of ['fail', undefined] as const) {
      const w = await boot(lang, '#/domains/dm1', clipboard ? { clipboard } : {});
      w.el('dd-zone-cp').click();
      await new Promise((r) => setTimeout(r, 0));
      expect(w.el('toasts').children.map((c) => c.textContent)).toEqual([t(lang, '복사하지 못했습니다. 레코드 파일을 받아 쓰세요.')]);
    }
  });

  it('Ⓩ-UI-6 제거된 도메인 — 한 번에 넣기 줄이 숨고 눌러도 파일을 만들지 않는다', async () => {
    const removed = { ...domainDetail(DOMAINS[0]), status: 'removed', removedAt: '2026-09-28T00:00:00.000Z', records: [] };
    OVERRIDE.set('/api/domains/dm1', { status: 200, json: { item: removed } });
    const w = await boot(lang, '#/domains/dm1');
    expect(w.el('dd-steps').hidden).toBe(true);
    w.el('dd-zone-dl').click();
    expect(w.downloads).toHaveLength(0);
  });
});
