/**
 * 홈 히어로의 예시 에이전트 신원 카드(US-012) — 표본 값이 **정본과 어긋나지 않는지**를 본다.
 *
 * 홈 번들은 `src/passport/**` 를 import 하지 않는다(`site-bundle.test.ts`). 그래서 신원 호스트는 옮겨 적고(`SITE_IDENTITY_HOST`),
 * DID 는 세그먼트로 그린다(접두사 리터럴은 `src/passport/did.ts` 에만 — ADR-0002 · `keypair-immutability.arch.test.ts`).
 * 이 테스트는 두 사본을 정본에 묶는다: 접두사·호스트가 바뀌면 여기가 빨개진다.
 */

import { describe, expect, it } from 'vitest';

import { DID_WEB_PREFIX, IDENTITY_HOST } from '../../../src/passport/did';
import { SITE_IDENTITY_HOST } from '../../../src/site/constants';
import { HOME_COPY, SAMPLE_AGENT } from '../../../src/site/home';
import { renderHomePage } from '../../../src/site/index';

const deckOf = (html: string): string => html.match(/<figure class="deck"[\s\S]*?<\/figure>/)?.[0] ?? '';
const plain = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&hellip;/g, '…')
    .replace(/&middot;/g, '·');

describe('예시 신원 카드', () => {
  it('신원 호스트 사본 = passport 정본', () => {
    expect(SITE_IDENTITY_HOST).toBe(IDENTITY_HOST);
  });

  it.each(['ko', 'en'] as const)('%s — 앞면: 이름 · 주소(`@` 는 `.at` 표시 — 색 없음) · DID(정본 접두사, 가운데 줄임) · 발급일 · 상태', (lang) => {
    const deck = deckOf(renderHomePage(lang).html);
    const c = HOME_COPY[lang];
    expect(deck).not.toBe('');
    expect(deck).toContain(`<p class="idc-name">${SAMPLE_AGENT.name}</p>`);
    expect(deck).toContain('<span class="addr">scout<span class="at">@</span>atmark.ai</span>');
    const did = plain(deck.match(/<span class="did">[\s\S]*?<\/span><\/dd>/)?.[0] ?? '');
    expect(did.startsWith(DID_WEB_PREFIX)).toBe(true);
    expect(did.slice(DID_WEB_PREFIX.length)).toMatch(/^[0-9a-f]{4}…[0-9a-f]{4}$/);
    // 발급일은 언어별 표기(용어집) — 값은 SAMPLE_AGENT.issued(ISO)와 같은 날이다.
    const [y, m, d] = SAMPLE_AGENT.issued.split('-');
    const shown = lang === 'ko' ? `${y ?? ''}.${m ?? ''}.${d ?? ''}` : `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1] ?? ''} ${String(Number(d))}, ${y ?? ''}`;
    expect(c['cardIssuedValue']).toBe(shown);
    expect(deck).toContain(`<dd class="num">${shown}</dd>`);
    expect(deck).toContain(c['cardStatusValue'] ?? '∅');
  });

  it.each(['ko', 'en'] as const)('%s — 뒷면: 공개키 조각 · 지문 막대(장식, 보조기술에 숨김) · passport JSON 조각 · 소유 조직(비공개 표시)', (lang) => {
    const deck = deckOf(renderHomePage(lang).html);
    const c = HOME_COPY[lang];
    expect(deck).toContain('<div class="idc back">');
    expect(deck).toMatch(/<dd class="key">z6Mk[^<]*<\/dd>/);
    expect(deck).toMatch(/<svg class="fp" [^>]*aria-hidden="true"/);
    expect(deck.match(/<rect /g)).toHaveLength(32);
    // 인라인 SVG 는 외부 리소스를 부르지 않는다 — xmlns·href·url( 없음.
    expect(deck).not.toMatch(/xmlns|xlink|url\(/);
    const json = plain(deck.match(/<pre class="json">[\s\S]*?<\/pre>/)?.[0] ?? '');
    expect(JSON.parse(json)).toEqual({
      type: 'AtmarkAgentPassport',
      status: 'published',
      credentialSubject: { name: SAMPLE_AGENT.name, address: 'scout@atmark.ai' },
    });
    expect(deck).toContain(`${c['cardOwnerValue'] ?? '∅'} <span class="priv">${c['cardOwnerNote'] ?? '∅'}</span>`);
  });

  it('정부 신분증 흉내가 아니다 — 사진 칸·MRZ(`<<`)·국가·생년월일 필드 없음', () => {
    for (const lang of ['ko', 'en'] as const) {
      const deck = deckOf(renderHomePage(lang).html);
      expect(deck).not.toMatch(/&lt;&lt;|<<|portrait|photo|MRZ/i);
      expect(plain(deck)).not.toMatch(/국적|생년월일|여권|Nationality|Date of birth|Passport No/i);
    }
  });
});
