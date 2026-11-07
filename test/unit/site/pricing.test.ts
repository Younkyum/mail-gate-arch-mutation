/**
 * 가격 페이지 `atmark.ai/pricing`(영어) · `/kr/pricing`(한국어 — 2026-09-30)(`src/site/pricing.ts`) — Paddle 운영 계정 웹사이트 심사가
 * 요구하는 공개 가격 페이지.
 *
 *   - 두 언어 200 · 닫힌 CSP(실행 스크립트는 모든 페이지 공통의 머리 힌트 하나뿐). 공통 CSP·색·링크 규율은 `site-pages.test.ts` 표가 이 페이지에도 돈다.
 *   - **한도 숫자는 카탈로그에서** — 표의 칸을 `PLAN_CATALOG` 와 하나씩 맞추고, 카탈로그 값만 바꿔 모듈을 다시 읽으면 표가 따라 바뀐다
 *     (하드코딩이면 빨개진다). 천장 한 줄도 `ENTITLEMENT_CEILINGS` 에서.
 *   - 가격 셋(Pro 29 · Team 99 · Scale 299, 월 USD — 진윤겸 확정 2026-09-26) · Beta 는 초대·검토로만 · Paddle(MoR) + 환불 링크 ·
 *     업그레이드 경로(콘솔 설정 › 요금제 + 로그인 링크) · 과장·아웃리치 문구 없음(Paddle AUP 심사).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENTITLEMENT_CEILINGS, PAID_PLAN_CODES, PLAN_CATALOG, PLAN_CODES } from '../../../src/billing/plans';
import { CONSOLE_APP_URLS, docsUrl, PLAN_MONTHLY_PRICE_USD, SITE_HOST } from '../../../src/site/constants';
import { handleSiteRequest, type SiteHttpEvent } from '../../../src/site/http';
import { renderPricingPage } from '../../../src/site/index';
import { asciiScript, sha256Base64 } from '../../../src/site/page';
import { SESSION_HINT_SCRIPT } from '../../../src/site/session-hint';
import { groupDigits, limitCell, PRICING_COPY, PRICING_LIMIT_ROWS, PRICING_PAGES } from '../../../src/site/pricing';

function event(path: string, method = 'GET'): SiteHttpEvent {
  return { rawPath: path, rawQueryString: '', headers: { host: SITE_HOST }, requestContext: { domainName: SITE_HOST, http: { method } } };
}

/** 태그를 벗긴 글자 — 인라인은 붙이고 블록 경계는 공백 하나. 엔티티 `&rsaquo;`·`&rsquo;` 는 글자로. */
function text(html: string): string {
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(span|b|strong|a)\b[^>]*>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&rsaquo;/g, '›')
    .replace(/&rsquo;/g, '’')
    .replace(/\s+/g, ' ');
}

/** 한도 표 → [행 머리, 칸…][]. `<tbody>` 만. */
function tableRows(html: string): string[][] {
  const body = /<table class="limits">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? '';
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => [...(row[1] ?? '').matchAll(/<t[hd][^>]*>([^<]*)<\/t[hd]>/g)].map((c) => c[1] ?? ''));
}

function tableHead(html: string): string[] {
  const head = /<table class="limits"><thead>([\s\S]*?)<\/thead>/.exec(html)?.[1] ?? '';
  return [...head.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((c) => c[1] ?? '');
}

describe('가격 페이지 — 경로·CSP', () => {
  it.each([
    ['/pricing', 'en'],
    ['/kr/pricing', 'ko'],
  ] as const)('GET %s → 200 · 그 언어의 페이지 · 닫힌 CSP(실행 스크립트는 머리 힌트 하나 · 연결은 콘솔 하나 · 이미지는 같은 오리진)', (path, lang) => {
    const res = handleSiteRequest(event(path));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(PRICING_PAGES[lang].html);
    expect(res.body).toBe(renderPricingPage(lang).html);
    expect(res.body.startsWith(`<!doctype html><html lang="${lang}">`)).toBe(true);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    const csp = res.headers['content-security-policy'] ?? '';
    expect(csp).toBe(PRICING_PAGES[lang].csp);
    // 2026-09-30 — 모든 페이지 공통의 머리 힌트 스크립트 하나(해시) · 연결은 콘솔 하나 · Trusted Types.
    const hint = asciiScript(SESSION_HINT_SCRIPT);
    const style = /<style>([\s\S]*?)<\/style>/.exec(res.body)?.[1] ?? '';
    expect(style.length).toBeGreaterThan(0);
    expect(csp).toBe(
      `default-src 'none'; script-src 'sha256-${sha256Base64(hint)}'; style-src 'sha256-${sha256Base64(style)}'; ` +
        "font-src 'self'; img-src 'self'; connect-src https://console.atmark.ai; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; " +
        "require-trusted-types-for 'script'; trusted-types 'none'",
    );
    // 실행되는 스크립트는 머리 힌트 하나 — JSON-LD 데이터 블록(SoftwareApplication) 하나와 그 힌트를 걷어 내면 `<script` 가 없다.
    expect(res.body.match(/<script\b/gi)).toHaveLength(2);
    expect(res.body.split(`<script>${hint}</script>`)).toHaveLength(2);
    expect(res.body.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '').replace(`<script>${hint}</script>`, '')).not.toMatch(/<script\b/i);
  });

  it('HEAD 200 · 끝 슬래시 301 · 대소문자 변형 404', () => {
    expect(handleSiteRequest(event('/pricing', 'HEAD')).statusCode).toBe(200);
    expect(handleSiteRequest(event('/pricing/')).statusCode).toBe(301);
    expect(handleSiteRequest(event('/kr/pricing/')).headers['location']).toBe('https://atmark.ai/kr/pricing');
    expect(handleSiteRequest(event('/Pricing')).statusCode).toBe(404);
    expect(handleSiteRequest(event('/kr/Pricing')).statusCode).toBe(404);
    // 옛 영어 경로(2026-09-30 전) — 접두어를 뗀 경로로 301.
    expect(handleSiteRequest(event('/en/pricing')).statusCode).toBe(301);
    expect(handleSiteRequest(event('/en/pricing')).headers['location']).toBe('https://atmark.ai/pricing');
  });

  it('hreflang·canonical 은 /pricing(영어 · x-default) · /kr/pricing(한국어) · 색인한다', () => {
    expect(PRICING_PAGES.en.html).toContain('<link rel="canonical" href="https://atmark.ai/pricing">');
    expect(PRICING_PAGES.ko.html).toContain('<link rel="canonical" href="https://atmark.ai/kr/pricing">');
    for (const lang of ['ko', 'en'] as const) {
      expect(PRICING_PAGES[lang].html).toContain('<link rel="alternate" hreflang="ko" href="https://atmark.ai/kr/pricing">');
      expect(PRICING_PAGES[lang].html).toContain('<link rel="alternate" hreflang="en" href="https://atmark.ai/pricing">');
      expect(PRICING_PAGES[lang].html).toContain('<link rel="alternate" hreflang="x-default" href="https://atmark.ai/pricing">');
    }
    expect(PRICING_PAGES.ko.html).toContain('<meta name="robots" content="index,follow">');
    expect(PRICING_PAGES.en.html).toContain('<meta name="robots" content="index,follow">');
  });
});

describe('가격 페이지 — 한도는 카탈로그에서', () => {
  it.each(['ko', 'en'] as const)('%s — 표의 열은 요금제 다섯(카탈로그 순서), 칸은 PLAN_CATALOG 값 그대로', (lang) => {
    const html = PRICING_PAGES[lang].html;
    expect(tableHead(html).slice(1)).toEqual(['Free', 'Beta', 'Pro', 'Team', 'Scale']);
    expect(PLAN_CODES).toEqual(['free', 'beta', 'pro', 'team', 'scale']);
    const rows = tableRows(html);
    expect(rows).toHaveLength(PRICING_LIMIT_ROWS.length);
    PRICING_LIMIT_ROWS.forEach((key, i) => {
      const row = rows[i] ?? [];
      expect(row[0], key).toBe(PRICING_COPY[lang][key]);
      expect(row.slice(1), key).toEqual(PLAN_CODES.map((plan) => limitCell(key, PLAN_CATALOG[plan][key])));
    });
  });

  it('메일 기본기 2차 두 줄(AC-D6-5) — 별칭은 개수, 첨부는 MB(MiB 기준) · ko/en 1:1', () => {
    expect(PRICING_LIMIT_ROWS).toContain('aliasesPerAgentMax');
    expect(PRICING_LIMIT_ROWS).toContain('attachmentBytesTotalMax');
    for (const lang of ['ko', 'en'] as const) {
      const rows = tableRows(PRICING_PAGES[lang].html);
      const aliases = rows[PRICING_LIMIT_ROWS.indexOf('aliasesPerAgentMax')] ?? [];
      const attachments = rows[PRICING_LIMIT_ROWS.indexOf('attachmentBytesTotalMax')] ?? [];
      expect(aliases.slice(1), lang).toEqual(['0', '3', '5', '10', '20']);
      expect(attachments.slice(1), lang).toEqual(['5 MB', '10 MB', '10 MB', '20 MB', '25 MB']);
      expect(aliases[0], lang).toBe(PRICING_COPY[lang]['aliasesPerAgentMax']);
      expect(attachments[0], lang).toBe(PRICING_COPY[lang]['attachmentBytesTotalMax']);
    }
    expect(limitCell('attachmentBytesTotalMax', 25 * 1024 * 1024)).toBe('25 MB');
    expect(limitCell('maxAgents', 1000)).toBe(groupDigits(1000));
  });

  it('요구된 한도 여섯(에이전트·조직 하루 수신자·에이전트 하루 발송·메일당 수신자·웹훅·조직 API 키)이 표에 있다', () => {
    for (const key of ['maxAgents', 'orgDailyRecipients', 'agentPerDayMax', 'recipientsPerMessageMax', 'webhookEndpointsPerAgentMax', 'orgApiKeysMax'] as const) {
      expect(PRICING_LIMIT_ROWS).toContain(key);
    }
    // 표시만 하는 값(수신 저장 용량 — ADR-0011 미적용)은 약속처럼 보이지 않게 싣지 않는다.
    expect(PRICING_LIMIT_ROWS).not.toContain('inboundStorageBytes');
  });

  it('천장 한 줄 — ENTITLEMENT_CEILINGS 값(조직 하루 1,000명 · 메일당 50명)', () => {
    expect(text(PRICING_PAGES.ko.html)).toContain(
      `요금제로도 넘을 수 없는 상한: 조직 하루 ${groupDigits(ENTITLEMENT_CEILINGS.orgDailyRecipients)}명, 메일당 ${groupDigits(ENTITLEMENT_CEILINGS.recipientsPerMessageMax)}명.`,
    );
    expect(text(PRICING_PAGES.ko.html)).toContain('요금제로도 넘을 수 없는 상한: 조직 하루 1,000명, 메일당 50명.');
    expect(text(PRICING_PAGES.en.html)).toContain(
      'Hard limits no plan can exceed: 1,000 recipients per organization per day, 50 recipients per message.',
    );
  });

  it('카드의 에이전트 수도 카탈로그에서', () => {
    for (const plan of PLAN_CODES) {
      expect(PRICING_PAGES.ko.html).toContain(`<p class="agents">에이전트 ${groupDigits(PLAN_CATALOG[plan].maxAgents)}개</p>`);
      expect(PRICING_PAGES.en.html).toContain(`<p class="agents">${groupDigits(PLAN_CATALOG[plan].maxAgents)} agents</p>`);
    }
  });

  it('groupDigits — 천 단위 쉼표', () => {
    expect([0, 50, 999, 1000, 10_000, 1_234_567].map(groupDigits)).toEqual(['0', '50', '999', '1,000', '10,000', '1,234,567']);
  });
});

describe('가격 페이지 — 하드코딩이 아니다(카탈로그만 바꿔 모듈을 다시 읽는다)', () => {
  afterEach(() => {
    vi.doUnmock('../../../src/billing/plans');
    vi.resetModules();
  });

  it('카탈로그·천장 값을 바꾸면 표·카드·천장 줄이 따라 바뀐다', async () => {
    vi.resetModules();
    vi.doMock('../../../src/billing/plans', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../../src/billing/plans')>();
      return {
        ...real,
        PLAN_CATALOG: { ...real.PLAN_CATALOG, pro: { ...real.PLAN_CATALOG.pro, maxAgents: 12_345, orgApiKeysMax: 77 } },
        ENTITLEMENT_CEILINGS: { ...real.ENTITLEMENT_CEILINGS, orgDailyRecipients: 4321 },
      };
    });
    const { PRICING_PAGES: mocked } = await import('../../../src/site/pricing');
    const rows = tableRows(mocked.ko.html);
    const proColumn = 1 + PLAN_CODES.indexOf('pro');
    expect(rows[PRICING_LIMIT_ROWS.indexOf('maxAgents')]?.[proColumn]).toBe('12,345');
    expect(rows[PRICING_LIMIT_ROWS.indexOf('orgApiKeysMax')]?.[proColumn]).toBe('77');
    expect(mocked.ko.html).toContain('<p class="agents">에이전트 12,345개</p>');
    expect(text(mocked.ko.html)).toContain('조직 하루 4,321명');
  });
});

describe('가격 페이지 — 가격·Beta·결제·업그레이드', () => {
  it('월 가격은 Pro 29 · Team 99 · Scale 299 USD(진윤겸 확정) — 키는 결제로 사는 요금제와 같다', () => {
    expect(PLAN_MONTHLY_PRICE_USD).toEqual({ pro: 29, team: 99, scale: 299 });
    expect(Object.keys(PLAN_MONTHLY_PRICE_USD).sort()).toEqual([...PAID_PLAN_CODES].sort());
  });

  it.each([
    ['ko', '/월'],
    ['en', '/month'],
  ] as const)('%s — 가격 셋과 Free $0 이 그 요금제 카드에 나온다', (lang, per) => {
    const html = PRICING_PAGES[lang].html;
    const card = (name: string): string => new RegExp(`<li class="plan[^"]*"><h2>${name}</h2>([\\s\\S]*?)</li>`).exec(html)?.[1] ?? '';
    expect(card('Free')).toContain(`<span class="amt">$0</span><span class="per">${per}</span>`);
    expect(card('Pro')).toContain(`<span class="amt">$29</span><span class="per">${per}</span>`);
    expect(card('Team')).toContain(`<span class="amt">$99</span><span class="per">${per}</span>`);
    expect(card('Scale')).toContain(`<span class="amt">$299</span><span class="per">${per}</span>`);
    expect(html.match(/<li class="plan[^"]*">/g)).toHaveLength(5);
  });

  it('Beta — 운영자 초대 조직 · 베타 기간 무료 · 가입 동작 없음 · 결제로 사지 않는다(금액 없음)', () => {
    const beta = (html: string): string => /<li class="plan beta">([\s\S]*?)<\/li>/.exec(html)?.[1] ?? '';
    const ko = text(beta(PRICING_PAGES.ko.html));
    const en = text(beta(PRICING_PAGES.en.html));
    expect(ko).toContain('베타 기간 무료');
    expect(ko).toContain('운영자 초대 조직');
    expect(en).toContain('Free during beta');
    expect(en).toContain('By invitation');
    expect(beta(PRICING_PAGES.ko.html)).not.toContain('<a ');
    expect(beta(PRICING_PAGES.en.html)).not.toContain('<a ');
    for (const t of [ko, en]) expect(t).not.toMatch(/\$\d/);
    // "초대로만 · 가입·결제로 살 수 없음" 은 같은 페이지 `결제와 변경 › Beta` 행 한 곳에서 말한다(비평 R4-09 — 칸과 행이 같은 문장을 되풀이하지 않게).
    expect(text(PRICING_PAGES.ko.html)).toContain('운영자가 초대한 조직에 베타 기간 동안 직접 드립니다. 가입이나 결제로 받을 수는 없습니다.');
    expect(text(PRICING_PAGES.en.html)).toContain('An operator grants it directly to organizations they invite during the beta. It cannot be bought or reached by signing up.');
  });

  it.each(['ko', 'en'] as const)('%s — Paddle(Merchant of Record)가 결제·세금·환불을 처리한다 + 환불 정책 링크', (lang) => {
    const t = text(PRICING_PAGES[lang].html);
    expect(t).toContain('Merchant of Record');
    expect(t).toMatch(lang === 'ko' ? /결제와 세금, 환불은 Paddle이 판매자/ : /Paddle processes payments, tax and refunds/);
    expect(PRICING_PAGES[lang].html).toContain(lang === 'ko' ? '<a href="/kr/refund">환불 정책</a>' : '<a href="/refund">Refund policy</a>');
  });

  it.each([
    ['ko', '콘솔의 설정 › 요금제에서 바꿉니다.', '<a href="/kr/login">콘솔 로그인</a>'],
    ['en', 'In the console, go to Settings › Plan.', '<a href="/login">Log in to the console</a>'],
  ] as const)('%s — 업그레이드는 콘솔 설정 › 요금제 · 로그인 링크는 이 사이트의 로그인 페이지', (lang, path, link) => {
    expect(text(PRICING_PAGES[lang].html)).toContain(path);
    expect(PRICING_PAGES[lang].html).toContain(link);
    // 절대 URL 링크는 머리·꼬리의 사용자 문서(docs.atmark.ai, 같은 언어)와 머리의 콘솔 링크 하나(로그인했을 때만 보인다 — 2026-09-30)뿐이다.
    const html = PRICING_PAGES[lang].html;
    const consoleLink = `<a class="btn sm si con" href="${CONSOLE_APP_URLS.app}">`;
    expect(html.split(consoleLink)).toHaveLength(2);
    expect(html.replace(new RegExp(`<a href="${docsUrl(lang)}">`, 'g'), '').replace(consoleLink, '')).not.toMatch(/<a [^>]*href="https?:/);
  });

  it.each([
    ['ko', '/kr/pricing', '요금제', '/kr/refund', '환불 정책'],
    ['en', '/pricing', 'Pricing', '/refund', 'Refunds'],
  ] as const)('%s — 이 페이지의 푸터에도 가격·환불 링크', (lang, pricingHref, pricingLabel, refundHref, refundLabel) => {
    const foot = /<footer class="foot">([\s\S]*?)<\/footer>/.exec(PRICING_PAGES[lang].html)?.[1] ?? '';
    expect(foot).toContain(`<a href="${pricingHref}">${pricingLabel}</a>`);
    expect(foot).toContain(`<a href="${refundHref}">${refundLabel}</a>`);
  });
});

describe('가격 페이지 — 문구', () => {
  /** 과장·순위·아웃리치 뉘앙스(Paddle AUP 심사) — 대량·콜드 메일·리드 발굴·마케팅 발송·무제한·인기·할인·최고 등. */
  const BANNED = /무제한|unlimited|대량|\bbulk\b|콜드|\bcold\b|outreach|아웃리치|리드|\bleads?\b|마케팅|marketing|캠페인|campaign|인기|popular|추천|recommended|best|최고|최저|할인|discount|save \d|\bsave\b|혜택|지금 바로|now only|limited time|보장|guarantee|99\.9|\bSLA\b|SOC ?2/i;

  it.each(['ko', 'en'] as const)('%s — 과장·아웃리치 문구가 없다', (lang) => {
    const t = text(PRICING_PAGES[lang].html);
    expect(t.match(BANNED)).toBeNull();
    for (const value of Object.values(PRICING_COPY[lang])) expect(value.match(BANNED), value).toBeNull();
  });

  it('검사기는 공허하지 않다', () => {
    for (const sample of ['무제한 발송', 'Unlimited agents', '대량 발송', 'bulk email', 'cold outreach', '리드 발굴', 'Most popular', '20% 할인', 'Save 20%']) {
      expect(sample.match(BANNED), sample).not.toBeNull();
    }
  });

  it('두 언어의 문구 키 집합이 같다 · 마크업 뼈대가 같다 · 영어판에 한글이 새지 않는다(언어 전환 링크 밖)', () => {
    expect(Object.keys(PRICING_COPY.en).sort()).toEqual(Object.keys(PRICING_COPY.ko).sort());
    const skeleton = (h: string): string =>
      h
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/>[^<]*</g, '><')
        .replace(/\s(href|hreflang|lang|aria-label|id|content)="[^"]*"/g, '');
    expect(skeleton(PRICING_PAGES.en.html)).toBe(skeleton(PRICING_PAGES.ko.html));
    const en = text(PRICING_PAGES.en.html.replace(/<a [^>]*hreflang="ko"[^>]*>한국어<\/a>/g, ''));
    expect(en.match(/[ㄱ-ㆎ가-힣]+/g)).toBeNull();
  });

  it('가입한 조직은 검토 없이 바로 활성 — 운영자가 거절·보류하면 발송이 닫힌다(두 언어)', () => {
    expect(text(PRICING_PAGES.ko.html)).toContain('가입한 조직은 운영자 검토 없이 바로 활성이 되어 요금제 한도 안에서 보낼 수 있습니다. 운영자가 조직을 거절하거나 보류하면 발송이 닫힙니다.');
    expect(text(PRICING_PAGES.en.html)).toContain('New organizations are active right away, with no operator review, and can send within their plan limits. If an operator rejects or suspends an organization, sending closes.');
  });
});
