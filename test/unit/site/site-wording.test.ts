/**
 * 홈 문구 금지어(US-012 · `.omc/handoffs/landing-v2.md` "Risks / 금지 문구").
 *
 *   - 체인 발행 전: "블록체인 신원"·"blockchain identity"·NFT·민팅/mint — NFT 는 UI 표현일 뿐 체인 발행이 없다(ADR-0008 Phase C 트리거).
 *   - 신원에 대해 "독립 검증 가능"·"independently verifiable" 금지(ADR-0008 Q10 — 신원은 Phase C 전까지 Atmark 수탁).
 *   - "변조 불가"·"tamper-proof" 금지 — 대신 "고치면 드러난다", 그것도 투명성 로그가 운영에 공개된 뒤에만.
 *   - 가격·무료·인증(SOC2 등)·가용성 수치 금지(home.ts 규율).
 *
 * 두 언어의 문구 사전 값 전부와, 렌더된 **모든** 홈 페이지(두 언어 × 소개·개인정보·약관·로그인·가입·404)의 글자·메타에 건다.
 *
 * 가격 페이지(`/pricing`, Paddle 웹사이트 심사)가 생기면서 예외가 둘 생겼다 — 둘 다 좁게 건다:
 *   - 공통 꼬리의 가격 링크 이름(`CHROME_COPY.pricing` = "요금제"·"Pricing")은 모든 페이지에 있는 내비게이션 이름이다. 값을 정확히 못 박고,
 *     렌더된 페이지에서는 그 링크 하나만 걷어 낸 뒤 검사한다 — 본문에 금액·"무료" 가 새면 그대로 잡힌다.
 *   - 가격·환불 페이지 자체는 가격·무료를 말하는 것이 본분이라 그 두 항목만 빼고 나머지 금지어(체인·검증·변조·인증·가용성)를 건다.
 *
 * 약관 개정(2026-09-26)으로 셋째 예외가 생겼다 — 역시 좁게: 약관의 '요금제와 결제' 조 **하나**만 가격·무료 두 항목을 뺀다. 약관 페이지의
 * 나머지(그 조를 걷어 낸 글)에는 금지어 전부를 그대로 걸고, 그 조 안에도 금액(₩·$숫자·숫자원)은 없어야 한다.
 */

import { describe, expect, it } from 'vitest';

import { HOME_COPY } from '../../../src/site/home';
import type { SiteLang } from '../../../src/site/constants';
import {
  renderAbusePage,
  renderChangelogPage,
  renderHomePage,
  renderLoginPage,
  renderNotFoundPage,
  renderPricingPage,
  renderPrivacyPage,
  renderRefundPage,
  renderSignupPage,
  renderTermsPage,
} from '../../../src/site/index';
import { CHROME_COPY, sitePath } from '../../../src/site/page';

const BANNED: ReadonlyArray<readonly [string, RegExp]> = [
  ['블록체인 신원', /블록체인\s*(기반\s*)?신원/],
  ['blockchain identity', /blockchain[\s-]*(based\s+)?identit/i],
  ['NFT', /\bNFTs?\b/i],
  ['민팅', /민팅|민트|발행된\s*NFT/],
  ['mint', /\bmint(s|ed|ing)?\b/i],
  ['독립 검증', /독립\s*(적으로\s*)?검증/],
  ['independently verifiable', /independent(ly)?[\s-]*verif/i],
  ['변조 불가', /변조\s*(가\s*)?불가|위변조\s*불가/],
  ['tamper-proof', /tamper[\s-]*(proof|resistant)/i],
  // "요금" 단독은 막지 않는다 — 금액·요금제·가격만 막는다.
  ['가격·요금', /가격|요금제|₩|\$\s?\d|\d[\d,]*\s*원(?![가-힣])|pricing|\bprices?\b/i],
  ['무료', /무료|\bfree\b/i],
  ['인증 마크', /SOC\s?2|ISO\s?27001|HIPAA/i],
  ['가용성 수치', /\d{2}(\.\d+)?\s*%|\bSLA\b|uptime|가동률/i],
];

/** 이름 붙은 엔티티 — 브라우저가 글자로 바꿔 보여 주는 것 중 금지어를 가를 수 있는 것(공백·하이픈·기호·보이지 않는 글자). */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  shy: '\u00ad', zwj: '\u200d', zwnj: '\u200c', lrm: '\u200e', rlm: '\u200f',
  percnt: '%', dollar: '$', hyphen: '-', dash: '-', ndash: '–', mdash: '—', period: '.', comma: ',', colon: ':', sol: '/', num: '#',
};

/**
 * 엔티티를 푼다(숫자 `&#37;`·`&#x25;` · 이름 `&shy;` 등) — 화면에는 풀린 글자가 보이므로 금지어 검사도 풀린 글자에 한다(적대적 검증 L5:
 * `tamper&shy;proof` · `99.9&#37;` 가 정규식을 비껴갔다).
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** 보이지 않는 글자(소프트 하이픈 · 폭 없는 공백·결합자 · 단어 결합자 · BOM · 방향 표시) — 지우면 화면에 보이는 낱말이 된다. */
const INVISIBLE = /[\u00ad\u034f\u180e\u200b-\u200f\u2060-\u2064\ufeff]/g;

/** 태그를 벗긴 글자 + 메타(description·title)의 값. 스타일·스크립트 블록은 뺀다. 엔티티를 풀고 보이지 않는 글자를 지운다. */
function visible(html: string): string {
  const meta = [...html.matchAll(/<meta name="description" content="([^"]*)">/g)].map((m) => m[1] ?? '').join(' ');
  const body = html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(`${meta} ${body}`).replace(INVISIBLE, '').replace(/\s+/g, ' ');
}

function offenders(text: string): string[] {
  return BANNED.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** 가격을 말하는 것이 본분인 페이지(가격·환불)에서 빼는 두 항목. */
const PRICE_TALK: ReadonlySet<string> = new Set(['가격·요금', '무료']);

/** 꼬리의 가격 링크 이름 — 정확히 이 값이어야 한다(아래 단언). */
const PRICING_NAV_LABEL: Readonly<Record<SiteLang, string>> = { ko: '요금제', en: 'Pricing' };

/**
 * 렌더된 페이지에서 가격 링크만 걷어 낸다 — 머리(주 메뉴·모바일 메뉴)와 꼬리에 있는 그 링크 전부(명세 §6.3, 리드 승인 2026-09-27).
 * href 가 정확히 가격 경로이고 글자가 정확히 링크 이름인 `<a>` 만이다(속성은 `class`·`aria-current="page"` 만 허용). 본문에 새 금액·"무료"는 그대로 잡힌다(아래 비공허 테스트).
 */
const withoutPricingNav = (html: string, lang: SiteLang): string =>
  html.replace(new RegExp(`<a(?: class="[^"]*")? href="${sitePath(lang, 'pricing')}"(?: aria-current="page")?>${PRICING_NAV_LABEL[lang]}</a>`, 'g'), '');

/** 약관의 '요금제와 결제' 조 — 조 제목으로 정확히 한 조만 고른다. */
const TERMS_BILLING_ARTICLE = /<section(?: id="[a-z0-9-]+")?><h2>(?:제\d+조 \(요금제와 결제\)|\d+\. Plans and payment)<\/h2>[\s\S]*?<\/section>/;

/** 약관 목차(R1-22)에서 그 조를 가리키는 링크 **하나** — 글자는 그 조 제목 그대로다. 조와 같은 예외로, 정확히 이 모양 하나만 걷어 낸다. */
const TERMS_BILLING_TOC = /<li><a href="#art-\d+">(?:제\d+조 \(요금제와 결제\)|\d+\. Plans and payment)<\/a><\/li>/;

/**
 * 용어집(비평 9회전 R9-03~06·R9-12 · 리드 판정 2026-09-27 — 콘솔과 같은 말): 허용 목록/차단 목록(Allowlist/Blocklist) · login link · 콘솔 ·
 * outside email · 긴급 정지/Emergency stop · 라틴 낱말 뒤 조사는 붙여 쓴다. 렌더된 글자에서 옛 말이 다시 나오지 않게 막는다.
 */
const GLOSSARY_BANNED: Readonly<Record<SiteLang, ReadonlyArray<readonly [string, RegExp]>>> = {
  ko: [
    ['화이트·블랙리스트(→ 허용·차단 목록)', /화이트\s*리스트|블랙\s*리스트/],
    ['관리 화면(→ 콘솔)', /관리\s*화면/],
    ['비상 정지(→ 긴급 정지)', /비상\s*정지/],
    // `)` 는 넣지 않는다 — 약관 조 제목 `(목적)` 뒤 본문 첫 낱말 `이 약관은`(지시어)이 걸린다.
    ['라틴 낱말 뒤 띄운 조사', /[A-Za-z0-9]\s(는|은|이|가|을|를|로|으로|에서|에|의|와|과|나|도)(?=[\s,.])/],
  ],
  en: [
    ['whitelist·blacklist(→ allowlist·blocklist)', /\b(white|black)\s*list/i],
    ['sign-in(→ login)', /\bsign[\s-]?in\b/i],
    ['kill switch(→ emergency stop)', /\bkill[\s-]*switch/i],
    ['outside sending(→ outside email)', /\boutside sending\b/i],
  ],
};

describe('용어집 — 두 언어', () => {
  it.each(['ko', 'en'] as const)('%s 렌더된 모든 페이지에 옛 용어가 없다', (lang) => {
    for (const render of [renderHomePage, renderPricingPage, renderPrivacyPage, renderTermsPage, renderRefundPage, renderLoginPage, renderSignupPage, renderAbusePage, renderChangelogPage, renderNotFoundPage]) {
      // 인라인 태그(span·a·b·strong·code·wbr)는 공백 없이 지운다 — 화면에서 `…atmark.ai</span>로` 는 붙어 보인다.
      const text = visible(render(lang).html.replace(/<\/?(span|a|b|strong|code|wbr)\b[^>]*>/g, ''));
      const found = GLOSSARY_BANNED[lang].filter(([, re]) => re.test(text)).map(([name]) => name);
      expect(found, render.name).toEqual([]);
    }
  });

  it('검사기는 공허하지 않다', () => {
    for (const sample of ['화이트리스트 밖', '관리 화면에서', '비상 정지 한 번', 'Atmark 는 신원을', 'REST API 로 연결']) {
      expect(GLOSSARY_BANNED.ko.some(([, re]) => re.test(sample)), sample).toBe(true);
    }
    for (const sample of ['whitelist', 'Email me a sign-in link', 'one kill switch', 'Outside sending opens']) {
      expect(GLOSSARY_BANNED.en.some(([, re]) => re.test(sample)), sample).toBe(true);
    }
    expect(GLOSSARY_BANNED.ko.some(([, re]) => re.test('Atmark는 AI 에이전트에게 허용 목록을 줍니다. 콘솔에서 긴급 정지'))).toBe(false);
  });
});

describe('금지 문구 — 두 언어', () => {
  it.each(['ko', 'en'] as const)('%s 문구 사전(홈·머리·꼬리)의 어느 값에도 없다 — 꼬리의 가격 링크 이름은 정확한 값으로만', (lang) => {
    const { pricing, ...chrome } = CHROME_COPY[lang];
    expect(pricing).toBe(PRICING_NAV_LABEL[lang]);
    for (const [key, value] of Object.entries({ ...HOME_COPY[lang], ...chrome })) {
      expect(offenders(value), `${lang}.${key}`).toEqual([]);
    }
  });

  it.each(['ko', 'en'] as const)('%s 렌더된 모든 홈 페이지에 없다(꼬리의 가격 링크 이름만 걷어 낸다)', (lang) => {
    for (const render of [renderHomePage, renderPrivacyPage, renderTermsPage, renderLoginPage, renderSignupPage, renderAbusePage, renderChangelogPage, renderNotFoundPage]) {
      let html = render(lang).html;
      expect(html, render.name).toContain(`<a href="${sitePath(lang, 'pricing')}">${PRICING_NAV_LABEL[lang]}</a>`);
      // 약관은 '요금제와 결제' 조 하나만 걷어 낸다(아래 테스트가 그 조를 따로 검사한다).
      if (render === renderTermsPage) {
        expect(html.match(new RegExp(TERMS_BILLING_ARTICLE, 'g')) ?? [], render.name).toHaveLength(1);
        html = html.replace(TERMS_BILLING_ARTICLE, '');
        expect(html.match(new RegExp(TERMS_BILLING_TOC, 'g')) ?? [], render.name).toHaveLength(1);
        html = html.replace(TERMS_BILLING_TOC, '');
      }
      expect(offenders(visible(withoutPricingNav(html, lang))), render.name).toEqual([]);
    }
  });

  it.each(['ko', 'en'] as const)('%s 약관의 요금제와 결제 조 — 가격·무료 말고 나머지 금지어가 없고, 금액이 없다', (lang) => {
    const article = TERMS_BILLING_ARTICLE.exec(renderTermsPage(lang).html)?.[0] ?? '';
    expect(article).not.toBe('');
    const text = visible(article);
    expect(offenders(text).filter((name) => !PRICE_TALK.has(name))).toEqual([]);
    expect(text).not.toMatch(/₩|\$\s?\d|\d[\d,]*\s*원(?![가-힣])/);
    // 비공허: 이 조는 실제로 요금제·무료를 말한다(예외가 무엇을 빼는지 보인다).
    expect(offenders(text)).toEqual(expect.arrayContaining(['가격·요금', '무료']));
  });

  it.each(['ko', 'en'] as const)('%s 가격·환불 페이지 — 가격·무료 말고 나머지 금지어가 없다', (lang) => {
    for (const render of [renderPricingPage, renderRefundPage]) {
      const found = offenders(visible(render(lang).html)).filter((name) => !PRICE_TALK.has(name));
      expect(found, render.name).toEqual([]);
    }
    // 비공허: 가격 페이지에서는 가격 항목이 실제로 걸린다(예외가 무엇을 빼는지 보인다).
    expect(offenders(visible(renderPricingPage(lang).html))).toContain('가격·요금');
  });

  it('가격 링크를 걷어 내는 것은 링크 하나뿐이다 — 본문에 새 금액은 그대로 잡힌다', () => {
    const html = renderHomePage('ko').html.replace('</main>', '<p>Pro $29</p></main>');
    expect(offenders(visible(withoutPricingNav(html, 'ko')))).toContain('가격·요금');
  });

  it('검사기는 공허하지 않다 — 금지어를 하나씩 넣으면 잡는다', () => {
    const samples = [
      '블록체인 신원을 드립니다',
      'Blockchain-based identity',
      'NFT 로 발급',
      '신원을 민팅합니다',
      'Mint your agent',
      '독립 검증 가능한 신원',
      'Independently verifiable',
      '변조 불가능한 기록',
      'Tamper-proof logs',
      '월 9,900원',
      'Free forever',
      'SOC 2 Type II',
      '99.9% uptime',
    ];
    for (const sample of samples) expect(offenders(sample), sample).not.toEqual([]);
    // 허용되는 말은 걸리지 않는다.
    expect(offenders('고치면 드러난다 · 서명된 Passport · did:web · 90일')).toEqual([]);
  });

  it('엔티티·보이지 않는 글자로 쪼갠 금지어도 잡는다(L5) — 렌더된 HTML 을 보는 visible() 을 지난다', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['<p>Tamper&shy;proof logs</p>', 'tamper-proof'],
      ['<p>가용성 99.9&#37;</p>', '가용성 수치'],
      ['<p>99.9&#x25; 가동</p>', '가용성 수치'],
      ['<p>99.9&percnt;</p>', '가용성 수치'],
      ['<p>Tamper\u200bproof</p>', 'tamper-proof'],
      ['<p>N&#70;T 로 발급</p>', 'NFT'],
      ['<p>변조&nbsp;불가</p>', '변조 불가'],
      ['<meta name="description" content="Independently&#8203; verifiable">', 'independently verifiable'],
      ['<p>블록&zwj;체인 신원</p>', '블록체인 신원'],
    ];
    for (const [html, name] of cases) expect(offenders(visible(html)), html).toContain(name);
    // 풀어도 허용되는 말은 그대로다.
    expect(offenders(visible('<p>고치면 &amp; 드러난다 &mdash; did:web</p>'))).toEqual([]);
  });
});
