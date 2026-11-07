/**
 * 결제 페이지 `pay.atmark.ai`(`src/site/pay.ts` · `src/site/http.ts` Host 분기 · `src/runtime/handlers/site.ts` 설정) — 계획 수용 기준 B-5.
 *
 *   - Host 가 `pay.atmark.ai` 일 때만 두 경로(`/` 영어 · `/kr` 한국어 — 2026-09-30, 홈과 같은 규칙) · 쿼리 `_ptxn` 하나 · 스위치 꺼짐·설정 오류
 *     404(홈은 산다). 옛 `/en`(쿼리 포함)은 301 로 `/`(같은 쿼리) — 이미 나간 체크아웃 링크가 산다.
 *   - 쿼리 없는 `/`·`/kr` 은 스위치·설정과 무관하게 안내 페이지 200(Paddle 운영 도메인 심사) — 스크립트·Paddle.js 없음 · 링크 다섯 · 운영자 줄.
 *   - CSP: 콘솔 출처 없음 · 스크립트·스타일 해시 일치 · 환경별 호스트 목록(기본 환경 목록이 비면 실패 · 운영은 확정 전 404).
 *   - 콘솔 CORS: `pay.atmark.ai` 에서 온 교차 출처 요청에 `access-control-allow-origin` 이 없다(스위치가 켜져 있어도).
 *   - 핸들러의 작은 파서는 `config.ts` 의 `readPaddleEnvironment`·`readBillingEnabled` 와 같은 표에 같은 답을 낸다.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { routeAdminEvent } from '../../../src/admin/router';
import { PADDLE_ENVIRONMENT_DEFAULT, PADDLE_ENVIRONMENTS, PAY_HOST, PAY_ORIGIN } from '../../../src/billing/constants';
import { readBillingEnabled, readPaddleEnvironment, RUNTIME_ENV } from '../../../src/runtime/config';
import {
  parseSiteBillingEnabled,
  parseSitePaddleEnvironment,
  readSitePayOptions,
  SITE_PAY_ENV,
} from '../../../src/runtime/handlers/site';
import { CONSOLE_ORIGIN, REFUND_POLICY_APPROVED, SITE_HOST, type SiteLang } from '../../../src/site/constants';
import { handleSiteRequest, type SiteHttpEvent, type SiteRequestOptions } from '../../../src/site/http';
import { buildSiteCsp, CHROME_COPY, LOGO_TEXT } from '../../../src/site/page';
import {
  buildPayInfoPage,
  buildPayPage,
  PADDLE_JS_SCRIPT_SOURCE,
  PADDLE_JS_URL,
  PAY_CSP_HOSTS,
  PAY_INFO_PAGES,
  PAY_SUCCESS_URL,
  PAY_TRANSACTION_PATTERN,
  payConfigUsable,
  type PayConfig,
} from '../../../src/site/pay';
import { cspDirective, sha256Base64 } from '../../support/site-html';

const TOKEN = 'test_0123456789abcdef0123456789';
const TXN = 'txn_01hv0000000000000000000abc';
const SANDBOX: PayConfig = { environment: 'sandbox', clientToken: TOKEN };
const ON: SiteRequestOptions = { pay: SANDBOX };
const OFF: SiteRequestOptions = { pay: null };

function event(path: string, query = '', host = PAY_HOST, method = 'GET'): SiteHttpEvent {
  return { rawPath: path, rawQueryString: query, headers: { host }, requestContext: { domainName: host, http: { method } } };
}



function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
}

describe('pay.atmark.ai — Host 분기 · 경로 · 쿼리', () => {
  it('Host 가 pay.atmark.ai 이고 _ptxn 이 맞으면 / 는 영어, /kr 은 한국어 결제 페이지(200 · no-store · 쿠키 없음)', () => {
    for (const [path, lang] of [['/', 'en'], ['/kr', 'ko']] as const) {
      const res = handleSiteRequest(event(path, `_ptxn=${TXN}`), ON);
      expect(res.statusCode, path).toBe(200);
      expect(res.body).toContain(`<html lang="${lang}">`);
      expect(res.body).toContain(`<script src="${PADDLE_JS_URL}"></script>`);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(Object.keys(res.headers).map((k) => k.toLowerCase())).not.toContain('set-cookie');
      expect(res.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
  });

  it.each([
    ['', `https://${PAY_HOST}/`],
    [`_ptxn=${TXN}`, `https://${PAY_HOST}/?_ptxn=${TXN}`],
    ['utm_source=x&a=1', `https://${PAY_HOST}/?utm_source=x&a=1`],
  ])('옛 /en?%s → 301 %s (같은 쿼리 · no-store · BARE CSP · 빈 본문 — 스위치와 무관)', (query, location) => {
    for (const options of [ON, OFF, undefined]) {
      for (const method of ['GET', 'HEAD']) {
        const res = handleSiteRequest(event('/en', query, PAY_HOST, method), options);
        expect(res.statusCode).toBe(301);
        expect(res.headers['location']).toBe(location);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['content-security-policy']).toBe("default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        expect(res.body).toBe('');
        expect(Object.keys(res.headers).map((k) => k.toLowerCase())).not.toContain('set-cookie');
      }
    }
    // 쿼리의 제어 문자는 인코딩된다(헤더 주입 없음).
    const injected = handleSiteRequest(event('/en', 'a=\r\nset-cookie:x=1'), ON);
    expect(injected.headers['location']).toMatch(/^[\x21-\x7e]+$/);
    expect(new URL(injected.headers['location'] ?? '').host).toBe(PAY_HOST);
  });

  it('HEAD 는 같은 상태·빈 본문 · POST 는 405', () => {
    const head = handleSiteRequest(event('/', `_ptxn=${TXN}`, PAY_HOST, 'HEAD'), ON);
    expect([head.statusCode, head.body]).toEqual([200, '']);
    expect(handleSiteRequest(event('/', `_ptxn=${TXN}`, PAY_HOST, 'POST'), ON).statusCode).toBe(405);
  });

  // '쿼리 없음' 은 이 표에서 뺐다 — 2026-09-26 부터 쿼리 없는 `/`·`/kr`(2026-09-30 전에는 `/en`) 은 안내 페이지 200 이다. Paddle 운영 도메인 심사의 스캐너가
  // `https://pay.atmark.ai/` 를 쿼리 없이 열고, 404 를 "offline/under construction" 으로 보고 거절했다(아래 '안내 페이지' 묶음).
  it.each([
    ['_ptxn 모양 틀림', '/', '_ptxn=txn_short'],
    ['_ptxn 값 없음', '/', '_ptxn='],
    ['모르는 쿼리', '/', 'foo=1'],
    ['모르는 쿼리(한국어)', '/kr', 'utm_source=x'],
    ['_ptxn 대문자', '/', `_ptxn=${TXN.toUpperCase()}`],
    ['다른 쿼리가 더 있음', '/', `_ptxn=${TXN}&x=1`],
    ['다른 쿼리 키', '/', `ptxn=${TXN}`],
    ['_ptxn 두 번', '/', `_ptxn=${TXN}&_ptxn=${TXN}`],
    ['다른 경로', '/privacy', `_ptxn=${TXN}`],
    ['끝 슬래시', '/kr/', `_ptxn=${TXN}`],
    ['옛 영어 경로 아래', '/en/x', `_ptxn=${TXN}`],
    ['홈의 로그인 경로', '/login', `_ptxn=${TXN}`],
    ['쿼리 없는 다른 경로', '/pricing', ''],
    ['쿼리 없는 끝 슬래시', '/kr/', ''],
    ['쿼리 없는 옛 영어 끝 슬래시', '/en/', ''],
    ['robots.txt(홈과 같이 라우트 없음)', '/robots.txt', ''],
    ['favicon.ico(홈과 같이 라우트 없음)', '/favicon.ico', ''],
  ])('%s → 404(링크 없는 한 줄 · BARE CSP · no-store)', (_name, path, query) => {
    const res = handleSiteRequest(event(path, query), ON);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('Not Found\n');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('결제 스위치가 꺼지면(설정 null) 두 경로 모두 404', () => {
    expect(handleSiteRequest(event('/', `_ptxn=${TXN}`), OFF).statusCode).toBe(404);
    expect(handleSiteRequest(event('/kr', `_ptxn=${TXN}`), OFF).statusCode).toBe(404);
    expect(handleSiteRequest(event('/', `_ptxn=${TXN}`)).statusCode).toBe(404);
  });

  it('atmark.ai 에서는 결제 페이지가 아니다 — 같은 경로·쿼리여도 홈', () => {
    const res = handleSiteRequest(event('/', `_ptxn=${TXN}`, SITE_HOST), ON);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(PADDLE_JS_URL);
    expect(res.headers['content-security-policy']).not.toContain('paddle');
  });

  it('Host 대소문자·포트를 무시한다', () => {
    expect(handleSiteRequest(event('/', `_ptxn=${TXN}`, 'PAY.Atmark.ai:443'), ON).statusCode).toBe(200);
  });
});

describe('pay.atmark.ai — 쿼리 없는 안내 페이지(Paddle 운영 도메인 심사)', () => {
  const PATHS: readonly (readonly [string, SiteLang])[] = [['/', 'en'], ['/kr', 'ko']];
  const PRODUCTION: SiteRequestOptions = { pay: { environment: 'production', clientToken: 'live_0123456789abcdef0123456789' } };

  /** 필수 링크 — atmark.ai 절대 URL(가격·약관·개인정보·환불·홈). 환불은 `REFUND_POLICY_APPROVED` 일 때만 atmark.ai 에 있다(지금 켜져 있다). */
  function requiredLinks(lang: SiteLang): string[] {
    const p = lang === 'ko' ? '/kr' : '';
    return [
      `https://atmark.ai${p}/pricing`,
      `https://atmark.ai${p}/terms`,
      `https://atmark.ai${p}/privacy`,
      ...(REFUND_POLICY_APPROVED ? [`https://atmark.ai${p}/refund`] : []),
      lang === 'ko' ? 'https://atmark.ai/kr' : 'https://atmark.ai/',
    ];
  }

  it('환불 정책이 공개돼 있어 필수 링크는 다섯이다', () => {
    expect(REFUND_POLICY_APPROVED).toBe(true);
    expect(requiredLinks('ko')).toHaveLength(5);
    expect(requiredLinks('en')).toHaveLength(5);
  });

  it.each([
    ['스위치 꺼짐(설정 null)', OFF],
    ['옵션 생략(기본값 — 꺼짐)', undefined],
    ['스위치 켜짐 + 샌드박스', ON],
    ['운영 설정(CSP 목록 확정 전 — 체크아웃은 404)', PRODUCTION],
  ])('%s — /·/kr 200 · 필수 링크 다섯 · 저작권 줄(운영자 줄 없음) · no-store · 사이트 기본 CSP', (_name, options) => {
    for (const [path, lang] of PATHS) {
      const res = handleSiteRequest(event(path), options);
      expect(res.statusCode, path).toBe(200);
      expect(res.body).toContain(`<html lang="${lang}">`);
      expect(res.body).toContain(lang === 'ko' ? '<h1>Atmark 결제</h1>' : '<h1>Atmark checkout</h1>');
      const hrefs = [...res.body.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? '');
      for (const link of requiredLinks(lang)) expect(hrefs, `${path} ${link}`).toContain(link);
      expect(res.body).toContain(`<p class="fcopy muted">${CHROME_COPY[lang]['copyright'] ?? ''}</p>`);
      expect(/<footer class="foot">[\s\S]*<\/footer>/.exec(res.body)?.[0] ?? '').not.toMatch(/샤카|SHAKA|진윤겸|Younkyum/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      // 안내 페이지는 폰트를 싣지 않는다 — font-src 없는 판(배포 전 리뷰 I-3).
      expect(res.headers['content-security-policy']).toBe(buildSiteCsp(sha256Base64(/<style>([\s\S]*?)<\/style>/.exec(res.body)?.[1] ?? ''), false));
      expect(Object.keys(res.headers).map((k) => k.toLowerCase())).not.toContain('set-cookie');
    }
  });

  it('Paddle.js·스크립트가 없다 — CSP 에 script-src·connect-src·Paddle 호스트 없음', () => {
    for (const lang of ['ko', 'en'] as const) {
      const { html, csp } = buildPayInfoPage(lang);
      expect(html).not.toContain('<script');
      expect(html).not.toContain(PADDLE_JS_URL);
      expect(html).not.toMatch(/cdn\.paddle\.com/);
      expect(cspDirective(csp, 'script-src')).toBeUndefined();
      expect(cspDirective(csp, 'connect-src')).toBeUndefined();
      expect(csp).not.toMatch(/paddle/);
      // 안내 페이지에는 Paddle.js 가 없다 — 속성 인라인 허용(`style-src-attr`)도 어떤 `unsafe-inline` 도 없다(배포 전 리뷰 L-3 — 원복).
      expect(csp).not.toMatch(/style-src-attr|unsafe-inline/);
      expect(cspDirective(csp, 'font-src')).toBeUndefined();
    }
  });

  it('설명: 결제 창구 · Paddle.com 판매자(MoR) · 콘솔 설정 › 요금제에서 시작 — 한/영 1:1', () => {
    const ko = buildPayInfoPage('ko').html;
    const en = buildPayInfoPage('en').html;
    expect(ko).toContain('<title>Atmark 결제</title>');
    expect(en).toContain('<title>Atmark checkout</title>');
    expect(ko).toMatch(/AI 에이전트 신원 서비스 Atmark의 유료 요금제 결제 창구/);
    expect(en).toMatch(/Checkout for the paid plans of Atmark, an identity service for AI agents/);
    expect(ko).toContain('Paddle.com이 판매자(Merchant of Record)로서 처리합니다');
    expect(en).toContain('Paddle.com is the Merchant of Record and handles payment, tax and billing');
    expect(ko).toContain('콘솔의 설정 &rsaquo; 요금제에서 시작합니다');
    expect(en).toContain('Settings &rsaquo; Plan in the console');
    // 두 벌의 링크 수·모양이 같다(언어 접두어만 다르다 — 한국어는 /kr, 영어는 없음).
    const hrefs = (html: string): string[] =>
      [...html.matchAll(/href="([^"]+)"/g)].map((m) => (m[1] ?? '').replace('atmark.ai/kr', 'atmark.ai').replace(/\/$/, ''));
    expect(hrefs(en).filter((h) => h.startsWith('https://'))).toEqual(hrefs(ko).filter((h) => h.startsWith('https://')));
    expect(hrefs(en).filter((h) => h.startsWith('https://')).length).toBeGreaterThanOrEqual(5);
    // 언어 전환은 같은 호스트의 반대 언어 경로(쿼리 없음 — 결제 호스트에는 엣지 함수가 없다).
    expect(ko).toContain('<a class="plain lang" href="/" hreflang="en" lang="en">');
    expect(en).toContain('<a class="plain lang" href="/kr" hreflang="ko" lang="ko">');
    expect(`${ko}${en}`).not.toContain('?hl=');
  });

  it('마크업: 외부 링크는 atmark.ai 뿐(콘솔 없음) · on*·style= 없음 · 주황 없음(`@` 도 글자색) · 색인하지 않음', () => {
    for (const lang of ['ko', 'en'] as const) {
      const { html } = buildPayInfoPage(lang);
      const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? '');
      for (const href of hrefs) expect(href, href).toMatch(/^(#main|\/|\/kr|https:\/\/atmark\.ai(\/[a-z/]*)?)$/);
      expect(html).not.toContain(CONSOLE_ORIGIN);
      expect(html).not.toMatch(/\son[a-z]+=|style="/);
      // 완전 흑백(2026-09-29) — 스타일·마크업 어디에도 주황이 없다. 로고는 머리·꼬리의 가로 조합 둘(`currentColor` — 2026-09-30 `src/ui/brand.ts`),
      //   옛 글자 로고(`.at` 로 감싼 `@` + mark)는 없다.
      expect(html).not.toMatch(/#F97316/i);
      expect(html.split(LOGO_TEXT)).toHaveLength(3);
      expect(html).not.toContain('<span class="at">');
      expect(html).toContain('<meta name="robots" content="noindex,follow">');
    }
  });

  it('HEAD 는 같은 200 · 빈 본문(스위치 꺼짐에서도)', () => {
    const head = handleSiteRequest(event('/', '', PAY_HOST, 'HEAD'), OFF);
    expect([head.statusCode, head.body]).toEqual([200, '']);
    expect(head.headers['content-security-policy']).toBe(PAY_INFO_PAGES.en.csp);
    const headKo = handleSiteRequest(event('/kr', '', PAY_HOST, 'HEAD'), OFF);
    expect([headKo.statusCode, headKo.body, headKo.headers['content-security-policy']]).toEqual([200, '', PAY_INFO_PAGES.ko.csp]);
  });

  it('_ptxn 이 있고 스위치가 꺼져 있으면 여전히 404 — 안내 페이지로 떨어지지 않는다', () => {
    for (const [path] of PATHS) {
      const res = handleSiteRequest(event(path, `_ptxn=${TXN}`), OFF);
      expect(res.statusCode, path).toBe(404);
      expect(res.body).toBe('Not Found\n');
    }
  });
});

describe('pay.atmark.ai — CSP', () => {
  const page = (): { html: string; csp: string } => {
    const built = buildPayPage('ko', SANDBOX);
    if (built === null) throw new Error('샌드박스 결제 페이지가 없다');
    return built;
  };

  it('connect-src 에 콘솔 출처가 없다 — Paddle 호스트뿐 · 어느 지시어에도 atmark 출처가 없다', () => {
    const { csp } = page();
    const connect = cspDirective(csp, 'connect-src') ?? [];
    expect(connect.length).toBeGreaterThan(0);
    for (const host of connect) expect(host).toMatch(/^https:\/\/[a-z0-9-]+\.paddle\.com$/);
    expect(csp).not.toContain(CONSOLE_ORIGIN);
    expect(csp).not.toMatch(/atmark\.ai/);
    // 인라인 허용은 style 속성 하나뿐(Paddle.js 가 iframe 을 속성으로 띄운다 — `buildPayCsp` 머리말).
    expect(csp.replace("style-src-attr 'unsafe-inline'; ", '')).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/\*/);
  });

  it('script-src = 인라인 스크립트 해시 하나 + Paddle.js 호스트 · style-src = 스타일 해시 + Paddle 호스트 · 닫는 지시어', () => {
    const { html, csp } = page();
    const scripts = inlineScripts(html);
    expect(scripts).toHaveLength(1);
    const script = scripts[0] ?? '';
    expect(/^[\x00-\x7f]*$/.test(script)).toBe(true);
    // 보안 L-5 — 호스트 전체가 아니라 Paddle.js v2 경로로 좁힌다.
    expect(cspDirective(csp, 'script-src')).toEqual([`'sha256-${sha256Base64(script)}'`, 'https://cdn.paddle.com/paddle/v2/']);
    expect(PADDLE_JS_SCRIPT_SOURCE).toBe('https://cdn.paddle.com/paddle/v2/');
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    expect(cspDirective(csp, 'style-src')).toEqual([`'sha256-${sha256Base64(style)}'`, ...(PAY_CSP_HOSTS.sandbox?.style ?? [])]);
    expect(cspDirective(csp, 'style-src-attr')).toEqual(["'unsafe-inline'"]);
    expect(cspDirective(csp, 'style-src-elem')).toBeUndefined();
    expect(cspDirective(csp, 'default-src')).toEqual(["'none'"]);
    expect(cspDirective(csp, 'base-uri')).toEqual(["'none'"]);
    expect(cspDirective(csp, 'form-action')).toEqual(["'none'"]);
    expect(cspDirective(csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(cspDirective(csp, 'frame-src')).toEqual(PAY_CSP_HOSTS.sandbox?.frame);
    // Paddle.js 스크립트 태그의 주소가 script-src 경로 접두사 안이다(경로 끝 `/` = 접두사 일치).
    expect(new URL(PADDLE_JS_URL).origin).toBe('https://cdn.paddle.com');
    expect(PADDLE_JS_URL.startsWith(PADDLE_JS_SCRIPT_SOURCE)).toBe(true);
    expect(cspDirective(csp, 'script-src')).not.toContain('https://cdn.paddle.com');
  });

  it('스크립트: 샌드박스 환경 설정 · 토큰 · 성공 URL(콘솔 결제 설정) · innerHTML 없음 · 거래 id 모양 검사', () => {
    const script = inlineScripts(page().html)[0] ?? '';
    expect(script).toContain("Paddle.Environment.set('sandbox')");
    expect(script).toContain(JSON.stringify(TOKEN));
    expect(script).toContain(JSON.stringify(PAY_SUCCESS_URL));
    expect(script).toContain(String(PAY_TRANSACTION_PATTERN));
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    // 성공 URL 은 탐색 대상이지 연결 대상이 아니다 — 콘솔 출처이고 connect-src 에 없다.
    expect(new URL(PAY_SUCCESS_URL).origin).toBe(CONSOLE_ORIGIN);
    expect(PAY_SUCCESS_URL).toBe('https://console.atmark.ai/app?billing=return#/settings/plan');
  });

  it('마크업: 외부 링크는 콘솔·홈 두 곳뿐 · on* 속성·style= 없음 · 색인하지 않음', () => {
    const { html } = page();
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? '');
    for (const href of hrefs) expect(href, href).toMatch(/^https:\/\/(atmark\.ai\/|console\.atmark\.ai\/app#\/settings\/plan$)/);
    expect(html).not.toMatch(/\son[a-z]+=|style="/);
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it('영어·한국어 두 벌의 스크립트는 같다(문구는 마크업) — 같은 해시', () => {
    const ko = buildPayPage('ko', SANDBOX);
    const en = buildPayPage('en', SANDBOX);
    expect(ko?.csp).toBe(en?.csp);
  });
});

describe('pay.atmark.ai — 환경별 호스트 · 토큰 (fail-closed)', () => {
  it('기본 환경(PADDLE_ENVIRONMENT_DEFAULT)의 CSP 호스트 목록이 비어 있지 않다 — 비면 운영 전환이 결제 페이지를 끈다', () => {
    const hosts = PAY_CSP_HOSTS[PADDLE_ENVIRONMENT_DEFAULT];
    expect(hosts).not.toBeNull();
    // 원천은 Paddle 호스트 · 경로를 붙이면(보안 L-5 — script-src) 접두사 일치가 되도록 `/` 로 끝나야 한다.
    for (const list of Object.values(hosts ?? {})) for (const host of list as string[]) expect(host).toMatch(/^https:\/\/[a-z0-9.-]+\.paddle\.com(\/[a-z0-9._-]+)*\/?$/);
    for (const source of hosts?.script ?? []) expect(source === new URL(source).origin || source.endsWith('/')).toBe(true);
  });

  it('운영 목록은 확정 전이라 null — 운영 설정이면 결제 페이지는 404 다', () => {
    expect(PAY_CSP_HOSTS.production).toBeNull();
    const production: PayConfig = { environment: 'production', clientToken: 'live_0123456789abcdef0123456789' };
    expect(payConfigUsable(production)).toBe(false);
    expect(buildPayPage('ko', production)).toBeNull();
    expect(handleSiteRequest(event('/', `_ptxn=${TXN}`), { pay: production }).statusCode).toBe(404);
  });

  it('토큰 접두사가 환경과 다르거나 모양이 틀리면 쓰지 않는다', () => {
    expect(payConfigUsable({ environment: 'sandbox', clientToken: 'live_0123456789abcdef0123456789' })).toBe(false);
    expect(payConfigUsable({ environment: 'sandbox', clientToken: '' })).toBe(false);
    expect(payConfigUsable({ environment: 'sandbox', clientToken: 'test_"</script>' })).toBe(false);
    expect(payConfigUsable(SANDBOX)).toBe(true);
  });
});

describe('홈 λ 의 결제 설정 파서 — config.ts 와 같은 의미', () => {
  const INPUTS: readonly (string | undefined)[] = [
    undefined, '', ' ', 'sandbox', 'production', ' sandbox ', 'Sandbox', 'SANDBOX', 'live', 'prod', 'test',
    'true', 'false', ' true', 'false ', 'TRUE', 'True', '1', '0', 'yes', 'on', 'off', 'sandbox\n', '\tproduction',
  ];

  it('readPaddleEnvironment 가 받는 값 = parseSitePaddleEnvironment 가 받는 값(같은 결과) · 던지는 값 = null', () => {
    for (const value of INPUTS) {
      let expected: string | null;
      try {
        expected = readPaddleEnvironment({ [RUNTIME_ENV.paddleEnvironment]: value });
      } catch {
        expected = null;
      }
      expect(parseSitePaddleEnvironment(value), JSON.stringify(value)).toBe(expected);
    }
  });

  it('readBillingEnabled 가 받는 값 = parseSiteBillingEnabled 가 받는 값(같은 결과) · 던지는 값 = null', () => {
    for (const value of INPUTS) {
      let expected: boolean | null;
      try {
        expected = readBillingEnabled({ [RUNTIME_ENV.billingEnabled]: value });
      } catch {
        expected = null;
      }
      expect(parseSiteBillingEnabled(value), JSON.stringify(value)).toBe(expected);
    }
  });

  it('홈 λ 가 읽는 이름은 RUNTIME_ENV 의 같은 키와 같다', () => {
    expect(SITE_PAY_ENV).toEqual({
      paddleEnvironment: RUNTIME_ENV.paddleEnvironment,
      billingEnabled: RUNTIME_ENV.billingEnabled,
      paddleClientToken: RUNTIME_ENV.paddleClientToken,
    });
    expect([...PADDLE_ENVIRONMENTS].sort()).toEqual(['production', 'sandbox']);
  });

  it('readSitePayOptions — 꺼짐은 문제 아님 · 틀린 스위치·환경·토큰은 이유 코드 · 켜짐+샌드박스+토큰이면 설정', () => {
    const env = (values: Record<string, string | undefined>): Record<string, string | undefined> => ({
      [SITE_PAY_ENV.billingEnabled]: 'true',
      [SITE_PAY_ENV.paddleEnvironment]: 'sandbox',
      [SITE_PAY_ENV.paddleClientToken]: TOKEN,
      ...values,
    });
    expect(readSitePayOptions(env({}))).toEqual({ options: { pay: SANDBOX }, problem: null });
    expect(readSitePayOptions(env({ [SITE_PAY_ENV.billingEnabled]: 'false' }))).toEqual({ options: { pay: null }, problem: null });
    expect(readSitePayOptions(env({ [SITE_PAY_ENV.billingEnabled]: undefined })).problem).toBe('billing_enabled_invalid');
    expect(readSitePayOptions(env({ [SITE_PAY_ENV.paddleEnvironment]: 'live' })).problem).toBe('paddle_env_invalid');
    expect(readSitePayOptions(env({ [SITE_PAY_ENV.paddleClientToken]: '' })).problem).toBe('client_token_unusable');
    expect(readSitePayOptions(env({ [SITE_PAY_ENV.paddleEnvironment]: 'production', [SITE_PAY_ENV.paddleClientToken]: 'live_0123456789abcdef0123456789' })).problem).toBe(
      'client_token_unusable',
    );
  });
});

describe('배포되는 handler — 설정 오류에도 홈은 산다', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('환경이 틀리면 pay 는 404 · 홈은 200 · 이유 코드 한 줄만 로그(값 없음)', async () => {
    vi.stubEnv(SITE_PAY_ENV.billingEnabled, 'maybe');
    vi.stubEnv(SITE_PAY_ENV.paddleClientToken, TOKEN);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const { handler } = await import('../../../src/runtime/handlers/site');
    expect((await handler(event('/', `_ptxn=${TXN}`))).statusCode).toBe(404);
    expect((await handler(event('/', '', SITE_HOST))).statusCode).toBe(200);
    // 쿼리 없는 pay 안내 페이지는 설정 오류와 무관하게 200(Paddle 도메인 심사).
    expect((await handler(event('/'))).statusCode).toBe(200);
    expect(errors).toEqual([JSON.stringify({ level: 'error', event: 'site.pay_config_invalid', reason: 'billing_enabled_invalid' })]);
    expect(errors.join('')).not.toContain(TOKEN);
  });

  it('켜짐 + 샌드박스 + 토큰이면 pay 200', async () => {
    vi.stubEnv(SITE_PAY_ENV.billingEnabled, 'true');
    vi.stubEnv(SITE_PAY_ENV.paddleEnvironment, 'sandbox');
    vi.stubEnv(SITE_PAY_ENV.paddleClientToken, TOKEN);
    const { handler } = await import('../../../src/runtime/handlers/site');
    expect((await handler(event('/kr', `_ptxn=${TXN}`))).statusCode).toBe(200);
    expect((await handler(event('/', `_ptxn=${TXN}`))).statusCode).toBe(200);
  });
});

describe('콘솔 CORS — pay.atmark.ai 는 허용 출처가 아니다', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('홈 CORS 스위치가 켜져 있어도 pay.atmark.ai 출처의 프리플라이트에는 403 · access-control-allow-origin 없음', async () => {
    vi.stubEnv('ATMARK_SITE_CORS', 'true');
    for (const path of ['/api/login', '/api/signup']) {
      const result = await routeAdminEvent({} as AdminDependencies, {
        rawPath: path,
        headers: { origin: PAY_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
        requestContext: { requestId: 'r-pay-cors', http: { method: 'OPTIONS' } },
      });
      expect(result.statusCode, path).toBe(403);
      expect(Object.keys(result.headers).map((k) => k.toLowerCase())).not.toContain('access-control-allow-origin');
    }
  });
});
