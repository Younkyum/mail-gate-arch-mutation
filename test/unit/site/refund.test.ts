/**
 * 환불 정책 `atmark.ai/refund`(영어) · `/kr/refund`(한국어 — 2026-09-30)(`src/site/refund.ts`, WP-2 계획 §3-9 · 수용 기준 B-6).
 *
 *   - `REFUND_POLICY_APPROVED = true`(진윤겸 승인 2026-09-26 — 초안 문안 그대로)면 한/영 두 벌 200 + 모든 페이지 푸터·가격 페이지에 링크.
 *   - 스위치는 남아 있다 — `false` 로 되돌리면 두 경로 404 · 링크 없음(모듈을 상수만 바꿔 다시 읽어 확인한다).
 *   - **결제 스위치와 무관** — `pay` 설정이 켜지든 꺼지든 같은 답이다.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONSOLE_APP_URLS, REFUND_POLICY_APPROVED, SITE_HOST } from '../../../src/site/constants';
import { handleSiteRequest, SITE_ROUTES, type SiteHttpEvent, type SiteRequestOptions } from '../../../src/site/http';
import { asciiScript, sha256Base64 } from '../../../src/site/page';
import { PRICING_PAGES } from '../../../src/site/pricing';
import { REFUND_COPY, REFUND_PAGES } from '../../../src/site/refund';
import { SESSION_HINT_SCRIPT } from '../../../src/site/session-hint';

const PAY_ON: SiteRequestOptions = { pay: { environment: 'sandbox', clientToken: 'test_0123456789abcdef0123456789' } };
const PAY_OFF: SiteRequestOptions = { pay: null };

function event(path: string): SiteHttpEvent {
  return { rawPath: path, rawQueryString: '', headers: { host: SITE_HOST }, requestContext: { domainName: SITE_HOST, http: { method: 'GET' } } };
}

describe('환불 정책 — 공개(REFUND_POLICY_APPROVED = true)', () => {
  it('승인됐다 — 진윤겸이 초안 문안을 그대로 승인(2026-09-26)', () => {
    expect(REFUND_POLICY_APPROVED).toBe(true);
  });

  it('/refund · /kr/refund 는 200 · 끝 슬래시와 옛 /en/refund 는 301 — 결제 스위치가 켜지든 꺼지든 같다', () => {
    for (const options of [PAY_ON, PAY_OFF]) {
      const ko = handleSiteRequest(event('/kr/refund'), options);
      const en = handleSiteRequest(event('/refund'), options);
      expect([ko.statusCode, en.statusCode], String(options.pay !== null)).toEqual([200, 200]);
      expect(ko.body).toBe(REFUND_PAGES.ko.html);
      expect(en.body).toBe(REFUND_PAGES.en.html);
      expect(ko.headers['content-security-policy']).toBe(REFUND_PAGES.ko.csp);
      expect(en.headers['content-security-policy']).toBe(REFUND_PAGES.en.csp);
      expect(handleSiteRequest(event('/refund/'), options).statusCode).toBe(301);
      expect(handleSiteRequest(event('/kr/refund/'), options).statusCode).toBe(301);
      const legacy = handleSiteRequest(event('/en/refund'), options);
      expect([legacy.statusCode, legacy.headers['location']]).toEqual([301, 'https://atmark.ai/refund']);
    }
  });

  it('모든 페이지의 푸터에 환불 링크(언어별) · 가격 페이지 본문에도 링크', () => {
    for (const [path, page] of Object.entries(SITE_ROUTES)) {
      const ko = path === '/kr' || path.startsWith('/kr/');
      expect(page.html, path).toContain(ko ? '<a href="/kr/refund">환불 정책</a>' : '<a href="/refund">Refunds</a>');
    }
    expect(PRICING_PAGES.ko.html).toContain('<a href="/kr/refund">환불 정책</a></dd>');
    expect(PRICING_PAGES.en.html).toContain('<a href="/refund">Refund policy</a></dd>');
  });
});

describe('환불 정책 — 문안', () => {
  it('한/영 문구 키 집합이 같다 · 판매자(Paddle)·해지·환불 창·요청 방법·문의가 있다', () => {
    expect(Object.keys(REFUND_COPY.en).sort()).toEqual(Object.keys(REFUND_COPY.ko).sort());
    expect(REFUND_PAGES.ko.html).toContain('Merchant of Record');
    expect(REFUND_PAGES.en.html).toContain('Merchant of Record');
    expect(REFUND_PAGES.ko.html).toContain('14일');
    expect(REFUND_PAGES.en.html).toContain('14 days');
    expect(REFUND_PAGES.ko.html).toContain('mailto:support@atmark.ai');
  });

  it('외부 링크가 없다 — href 는 atmark.ai 경로·mailto 뿐(+ 머리의 콘솔 링크 하나) · 실행 스크립트는 머리 힌트 하나', () => {
    const hint = asciiScript(SESSION_HINT_SCRIPT);
    for (const page of [REFUND_PAGES.ko, REFUND_PAGES.en]) {
      // 머리·꼬리의 사용자 문서 링크(docs.atmark.ai, 같은 언어)와 로그인했을 때만 보이는 머리의 콘솔 링크(2026-09-30)만 atmark.ai 밖이다.
      const hrefs = [...page.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? '');
      for (const href of hrefs) {
        expect(href).toMatch(/^(\/|#main$|https:\/\/atmark\.ai\/|https:\/\/atmark\.ai$|mailto:support@atmark\.ai$|https:\/\/docs\.atmark\.ai(\/en)?$|https:\/\/console\.atmark\.ai\/app$)/);
      }
      expect(hrefs.filter((h) => h === CONSOLE_APP_URLS.app)).toHaveLength(1);
      // JSON-LD 데이터 블록(조직) 하나와 모든 페이지 공통의 머리 힌트 하나 말고는 스크립트가 없다.
      expect(page.html.match(/<script\b/g)).toHaveLength(2);
      expect(page.html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '').replace(`<script>${hint}</script>`, '')).not.toContain('<script');
      expect(page.csp).toContain(`script-src 'sha256-${sha256Base64(hint)}';`);
    }
  });

  it('hreflang·canonical 은 /refund(영어 · x-default) · /kr/refund(한국어)', () => {
    expect(REFUND_PAGES.ko.html).toContain('<link rel="canonical" href="https://atmark.ai/kr/refund">');
    expect(REFUND_PAGES.en.html).toContain('<link rel="canonical" href="https://atmark.ai/refund">');
    for (const page of [REFUND_PAGES.ko, REFUND_PAGES.en]) {
      expect(page.html).toContain('<link rel="alternate" hreflang="ko" href="https://atmark.ai/kr/refund">');
      expect(page.html).toContain('<link rel="alternate" hreflang="en" href="https://atmark.ai/refund">');
      expect(page.html).toContain('<link rel="alternate" hreflang="x-default" href="https://atmark.ai/refund">');
    }
  });
});

describe('환불 정책 — 스위치를 내리면(상수만 false 로 바꿔 모듈을 다시 읽는다)', () => {
  afterEach(() => {
    vi.doUnmock('../../../src/site/constants');
    vi.resetModules();
  });

  it('두 경로 404 · 푸터와 가격 페이지에 링크 없음 · 결제 스위치와 무관', async () => {
    vi.resetModules();
    vi.doMock('../../../src/site/constants', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../src/site/constants')>()),
      REFUND_POLICY_APPROVED: false,
    }));
    const http = await import('../../../src/site/http');
    for (const options of [PAY_ON, PAY_OFF]) {
      for (const path of ['/refund', '/kr/refund', '/refund/', '/kr/refund/']) {
        expect(http.handleSiteRequest(event(path), options).statusCode, `${path} ${String(options.pay !== null)}`).toBe(404);
      }
      // 옛 영어 경로는 스위치와 무관하게 접두어만 떼어 301 — 그 목적지(/refund)가 404 다.
      expect(http.handleSiteRequest(event('/en/refund'), options).headers['location']).toBe('https://atmark.ai/refund');
    }
    expect(Object.keys(http.SITE_ROUTES)).not.toContain('/refund');
    expect(Object.keys(http.SITE_ROUTES)).not.toContain('/kr/refund');
    for (const [path, page] of Object.entries(http.SITE_ROUTES)) expect(page.html, path).not.toMatch(/href="(\/kr)?\/refund"/);
    // 가격 페이지는 그대로 열려 있다 — 환불 스위치와 따로 논다.
    expect(http.handleSiteRequest(event('/pricing'), PAY_OFF).statusCode).toBe(200);
  });
});
