/**
 * 홈 핸들러(`src/runtime/handlers/site.ts` → `src/site/http.ts`) — 메서드·호스트·경로·헤더.
 * 2026-09-30 — 영어가 기본(접두어 없는 경로), 한국어는 `/kr…`. 옛 영어 경로 `/en…` 은 접두어를 뗀 경로로 301(쿼리 유지).
 *
 * 핸들러를 **배포되는 그 export** 로 부른다(`handler`). 모든 응답(200·301·404·405, GET·HEAD)이 같은 보안 헤더를 싣는지
 * 한 표로 돈다 — 한 갈래만 헤더를 빼먹는 회귀가 흔하다.
 */

import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { handler } from '../../../src/runtime/handlers/site';
import { SITE_ORIGIN } from '../../../src/site/constants';
import { BARE_CSP } from '../../../src/site/page';
import {
  renderHomePage,
  renderLoginPage,
  renderNotFoundPage,
  renderPricingPage,
  renderPrivacyPage,
  renderRefundPage,
  renderSignupPage,
  renderTermsPage,
  SITE_ROUTES,
  type SiteHttpEvent,
  type SiteHttpResult,
} from '../../../src/site/index';

function event(method: string, path: string, host = 'atmark.ai', query = ''): SiteHttpEvent {
  return {
    rawPath: path,
    rawQueryString: query,
    headers: { host },
    requestContext: { domainName: host, http: { method } },
  };
}

const call = (e: SiteHttpEvent): Promise<SiteHttpResult> => handler(e);

const EXPECTED_BASE = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'public, max-age=300',
};

describe('홈 — 페이지(두 언어)', () => {
  it.each([
    ['/', () => renderHomePage('en')],
    ['/privacy', () => renderPrivacyPage('en')],
    ['/terms', () => renderTermsPage('en')],
    ['/kr', () => renderHomePage('ko')],
    ['/kr/privacy', () => renderPrivacyPage('ko')],
    ['/kr/terms', () => renderTermsPage('ko')],
    ['/login', () => renderLoginPage('en')],
    ['/signup', () => renderSignupPage('en')],
    ['/kr/login', () => renderLoginPage('ko')],
    ['/kr/signup', () => renderSignupPage('ko')],
    ['/pricing', () => renderPricingPage('en')],
    ['/kr/pricing', () => renderPricingPage('ko')],
    ['/refund', () => renderRefundPage('en')],
    ['/kr/refund', () => renderRefundPage('ko')],
  ] as const)('GET %s → 200 · 그 페이지의 HTML 과 CSP', async (path, render) => {
    const res = await call(event('GET', path));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(render().html);
    // 경로의 언어가 문서의 언어다(`/kr…` = 한국어, 그 밖 = 영어).
    expect(res.body.startsWith(`<!doctype html><html lang="${path === '/kr' || path.startsWith('/kr/') ? 'ko' : 'en'}"`)).toBe(true);
    expect(res.headers['content-security-policy']).toBe(render().csp);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.isBase64Encoded).toBe(false);
  });

  it('라우트는 정확히 스물둘 — 언어별 열한 페이지(소개·사용 예시·가격·개인정보·약관·환불·로그인·가입·대기자 명단·남용 신고·변경 내역)', () => {
    expect(Object.keys(SITE_ROUTES).sort()).toEqual(
      [
        '/',
        '/abuse',
        '/changelog',
        '/kr',
        '/kr/abuse',
        '/kr/changelog',
        '/kr/login',
        '/kr/pricing',
        '/kr/privacy',
        '/kr/refund',
        '/kr/signup',
        '/kr/terms',
        '/kr/use-cases',
        '/kr/waitlist',
        '/login',
        '/pricing',
        '/privacy',
        '/refund',
        '/signup',
        '/terms',
        '/use-cases',
        '/waitlist',
      ].sort(),
    );
  });

  it('로그인·가입 경로도 끝 슬래시 → 301, POST 는 405(제출은 콘솔로 간다 — 홈은 GET·HEAD 만)', async () => {
    for (const path of ['/login', '/signup', '/kr/login', '/kr/signup']) {
      const slash = await call(event('GET', `${path}/`));
      expect([slash.statusCode, slash.headers['location']]).toEqual([301, `${SITE_ORIGIN}${path}`]);
      const post = await call(event('POST', path));
      expect([post.statusCode, post.headers['allow']]).toEqual([405, 'GET, HEAD']);
    }
  });

  it('Accept-Language·언어 쿠키로 바꾸지 않는다 — 같은 URL 은 늘 같은 문서(언어 협상은 엣지 함수 몫)', async () => {
    for (const path of ['/', '/kr', '/pricing']) {
      const plain = await call(event('GET', path));
      const en = await call({ ...event('GET', path), headers: { host: 'atmark.ai', 'accept-language': 'en-US,en;q=0.9' } });
      const ko = await call({ ...event('GET', path), headers: { host: 'atmark.ai', 'accept-language': 'ko-KR,ko;q=0.9' } });
      const cookie = await call({ ...event('GET', path), headers: { host: 'atmark.ai', cookie: 'atmark_lang=ko' } });
      // `?hl=` 도 핸들러는 보지 않는다(엣지가 쿠키를 적고 302 한다) — 같은 문서.
      const hl = await call(event('GET', path, 'atmark.ai', 'hl=ko'));
      expect(en).toEqual(plain);
      expect(ko).toEqual(plain);
      expect(cookie).toEqual(plain);
      expect(hl).toEqual(plain);
      // 언어로 갈라 두지 않는다 — vary 는 압축(accept-encoding, 배포 전 리뷰 M3)뿐이다.
      expect(plain.headers['vary']).toBe('accept-encoding');
    }
  });

  it.each(['/', '/privacy', '/terms', '/kr', '/kr/privacy', '/kr/terms', '/login', '/kr/signup'])('HEAD %s → 200 · 빈 본문 · GET 과 같은 헤더', async (path) => {
    const get = await call(event('GET', path));
    const head = await call(event('HEAD', path));
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers).toEqual(get.headers);
  });

  it.each(['/nope', '/Terms', '/index.html', '/__proto__', '/constructor', '/toString', '/ko', '/english', '/krx', '/KR', '/kr.html'])(
    'GET %s → 영어 404 페이지(색인 안 함 — 영어가 기본)',
    async (path) => {
      const res = await call(event('GET', path));
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(renderNotFoundPage('en').html);
      expect(res.headers['content-security-policy']).toBe(renderNotFoundPage('en').csp);
    },
  );

  it.each(['/kr/nope', '/kr/Terms', '/kr/kr', '/kr/privacy/x', '/kr/en'])('GET %s → 한국어 404 페이지', async (path) => {
    const res = await call(event('GET', path));
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(renderNotFoundPage('ko').html);
    expect(res.headers['content-security-policy']).toBe(renderNotFoundPage('ko').csp);
  });

  it.each([
    ['/privacy/', '/privacy'],
    ['/terms/', '/terms'],
    ['/kr/', '/kr'],
    ['/kr/privacy/', '/kr/privacy'],
  ])('GET %s → 301 %s (끝 슬래시만 다른 페이지 경로)', async (path, target) => {
    const res = await call(event('GET', path, 'atmark.ai', 'a=1'));
    expect(res.statusCode).toBe(301);
    expect(res.headers['location']).toBe(`${SITE_ORIGIN}${target}?a=1`);
  });

  it.each([
    ['/en', '', `${SITE_ORIGIN}/`],
    ['/en/', '', `${SITE_ORIGIN}/`],
    ['/en/pricing', '', `${SITE_ORIGIN}/pricing`],
    ['/en/privacy', 'a=1&b=2', `${SITE_ORIGIN}/privacy?a=1&b=2`],
    ['/en/login', '', `${SITE_ORIGIN}/login`],
    ['/en/refund', '', `${SITE_ORIGIN}/refund`],
    ['/en/terms/', '', `${SITE_ORIGIN}/terms/`],
    ['/en/nope', '', `${SITE_ORIGIN}/nope`],
    ['/en/en', '', `${SITE_ORIGIN}/en`],
  ])('옛 영어 경로 GET %s?%s → 301 %s (접두어만 뗀다 · 쿼리 유지 · 빈 본문 · BARE CSP)', async (path, query, location) => {
    for (const method of ['GET', 'HEAD']) {
      const res = await call(event(method, path, 'atmark.ai', query));
      expect(res.statusCode).toBe(301);
      expect(res.headers['location']).toBe(location);
      expect(res.body).toBe('');
      expect(res.headers['content-security-policy']).toBe(BARE_CSP);
    }
  });

  it('옛 영어 경로의 301 도 열린 리다이렉트·헤더 주입이 없다 — 출처가 앞에 고정되고 제어 문자는 인코딩된다', async () => {
    for (const path of ['/en//evil.example/x', '/en/\\evil.example', '/en/a\r\nset-cookie: x=1', '/en/한글']) {
      const res = await call(event('GET', path, 'atmark.ai', 'q=\r\nx'));
      expect(res.statusCode).toBe(301);
      const location = res.headers['location'] ?? '';
      expect(location.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
      expect(location).toMatch(/^[\x21-\x7e]+$/);
      expect(new URL(location).host).toBe('atmark.ai');
    }
  });

  it('HEAD 없는 경로 → 404 · 빈 본문(두 언어)', async () => {
    for (const path of ['/nope', '/kr/nope']) {
      const res = await call(event('HEAD', path));
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe('');
    }
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE'])('%s → 405 · allow: GET, HEAD', async (method) => {
    for (const host of ['atmark.ai', 'www.atmark.ai']) {
      const res = await call(event(method, '/', host));
      expect(res.statusCode).toBe(405);
      expect(res.headers['allow']).toBe('GET, HEAD');
      expect(res.headers['location']).toBeUndefined();
    }
  });
});

describe('홈 — www → 301 https://atmark.ai + 같은 경로', () => {
  it.each([
    ['/', '', `${SITE_ORIGIN}/`],
    ['/terms', '', `${SITE_ORIGIN}/terms`],
    ['/privacy', 'a=1&b=2', `${SITE_ORIGIN}/privacy?a=1&b=2`],
    ['/nope', '', `${SITE_ORIGIN}/nope`],
    ['/kr', '', `${SITE_ORIGIN}/kr`],
    ['/kr/terms', 'x=1', `${SITE_ORIGIN}/kr/terms?x=1`],
    ['/kr/nope', '', `${SITE_ORIGIN}/kr/nope`],
    // www 는 경로를 그대로 옮긴다(옛 `/en` 은 apex 에서 한 번 더 301).
    ['/en/terms', '', `${SITE_ORIGIN}/en/terms`],
  ])('GET www%s?%s → %s', async (path, query, location) => {
    const res = await call(event('GET', path, 'www.atmark.ai', query));
    expect(res.statusCode).toBe(301);
    expect(res.headers['location']).toBe(location);
    expect(res.body).toBe('');
  });

  it('호스트 대소문자·포트를 무시하고, HEAD 도 301', async () => {
    for (const host of ['WWW.Atmark.AI', 'www.atmark.ai:443']) {
      const res = await call(event('HEAD', '/terms', host));
      expect(res.statusCode).toBe(301);
      expect(res.headers['location']).toBe(`${SITE_ORIGIN}/terms`);
    }
  });

  it('Host 헤더가 없으면 API Gateway 의 domainName 으로 가른다', async () => {
    const res = await call({ rawPath: '/', requestContext: { domainName: 'www.atmark.ai', http: { method: 'GET' } } });
    expect(res.statusCode).toBe(301);
  });

  it('열린 리다이렉트·헤더 주입이 없다 — 출처가 앞에 고정되고, 제어 문자는 인코딩된다', async () => {
    for (const path of ['//evil.example/x', '/\\evil.example', '/a\r\nset-cookie: x=1', '/한글']) {
      const res = await call(event('GET', path, 'www.atmark.ai', 'q=\r\nx'));
      const location = res.headers['location'] ?? '';
      expect(location.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
      expect(location).toMatch(/^[\x21-\x7e]+$/);
      expect(new URL(location).host).toBe('atmark.ai');
    }
  });

  it('apex 는 리다이렉트하지 않는다', async () => {
    const res = await call(event('GET', '/', 'atmark.ai'));
    expect(res.statusCode).toBe(200);
  });
});

describe('홈 — 모든 응답의 보안 헤더', () => {
  // 페이지가 아닌 응답(301·405) — BARE CSP(아무것도 허용하지 않음).
  const bare: ReadonlyArray<readonly [string, SiteHttpEvent]> = [
    ['GET /terms/ 301', event('GET', '/terms/')],
    ['GET /en 301', event('GET', '/en')],
    ['HEAD /en/pricing 301', event('HEAD', '/en/pricing')],
    ['GET www 301', event('GET', '/', 'www.atmark.ai')],
    ['POST / 405', event('POST', '/')],
  ];

  it.each(bare)('%s — HSTS · nosniff · no-referrer · DENY · 짧은 공개 캐시 · 닫힌 CSP(BARE)', async (_label, e) => {
    const res = await call(e);
    expect(res.headers).toMatchObject(EXPECTED_BASE);
    const csp = res.headers['content-security-policy'] ?? '';
    expect(csp).toBe(BARE_CSP);
    expect(csp.startsWith("default-src 'none'")).toBe(true);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src|unsafe-|https?:|\*/);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  // 페이지(200·404 — 두 언어) — 2026-09-30 부터 모든 페이지가 머리 힌트 스크립트를 싣는다: 스크립트 해시(힌트 하나, 로그인·가입은 폼 하나 더)
  // + connect-src 콘솔 하나 + Trusted Types.
  const pages: ReadonlyArray<readonly [string, SiteHttpEvent, number]> = [
    ['GET / 200', event('GET', '/'), 1],
    ['HEAD / 200', event('HEAD', '/'), 1],
    ['GET /privacy 200', event('GET', '/privacy'), 1],
    ['GET /terms 200', event('GET', '/terms'), 1],
    ['GET /nope 404', event('GET', '/nope'), 1],
    ['GET /kr 200', event('GET', '/kr'), 1],
    ['GET /kr/privacy 200', event('GET', '/kr/privacy'), 1],
    ['GET /kr/terms 200', event('GET', '/kr/terms'), 1],
    ['GET /kr/nope 404', event('GET', '/kr/nope'), 1],
    ['HEAD /nope 404', event('HEAD', '/nope'), 1],
    ['GET /login 200', event('GET', '/login'), 2],
    ['GET /signup 200', event('GET', '/signup'), 2],
    ['GET /kr/login 200', event('GET', '/kr/login'), 2],
    ['HEAD /kr/signup 200', event('HEAD', '/kr/signup'), 2],
  ];

  it.each(pages)('%s — 같은 보안 헤더 · CSP 는 스크립트 해시(실린 블록마다 하나) + connect-src 콘솔 하나 + Trusted Types · 쿠키 없음', async (_label, e, scripts) => {
    const res = await call(e);
    expect(res.headers).toMatchObject(EXPECTED_BASE);
    const csp = res.headers['content-security-policy'] ?? '';
    expect(csp.startsWith("default-src 'none'")).toBe(true);
    expect(csp).toContain("frame-ancestors 'none'");
    const scriptSrc = /(?:^|; )script-src ([^;]+);/.exec(csp)?.[1]?.split(' ') ?? [];
    expect(scriptSrc).toHaveLength(scripts);
    for (const source of scriptSrc) expect(source).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
    expect(csp).toContain('; connect-src https://console.atmark.ai;');
    expect(csp.match(/https?:\/\/[^\s;]+/g)).toEqual(['https://console.atmark.ai']);
    expect(csp).toContain("require-trusted-types-for 'script'; trusted-types 'none'");
    expect(csp).not.toMatch(/unsafe-|\*|nonce-|data:|blob:/);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('HTML gzip(배포 전 리뷰 M3)', () => {
  const withEncoding = (path: string, value: string, method = 'GET'): SiteHttpEvent => ({
    ...event(method, path),
    headers: { host: 'atmark.ai', 'accept-encoding': value },
  });

  it.each(['/', '/kr', '/pricing', '/login', '/no-such-page'])('%s — gzip 을 받으면 줄여 보내고, 풀면 원문과 같다 · CSP 는 그대로', async (path) => {
    const plain = await call(event('GET', path));
    const zipped = await call(withEncoding(path, 'gzip, deflate, br'));
    expect(zipped.statusCode).toBe(plain.statusCode);
    expect(zipped.isBase64Encoded).toBe(true);
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.headers['vary']).toBe('accept-encoding');
    expect(zipped.headers['content-security-policy']).toBe(plain.headers['content-security-policy']);
    expect(gunzipSync(Buffer.from(zipped.body, 'base64')).toString('utf8')).toBe(plain.body);
    expect(Buffer.from(zipped.body, 'base64').length).toBeLessThan(Buffer.byteLength(plain.body) / 2);
  });

  it('gzip 이 없거나 q=0 이면 원문 · HEAD 는 빈 본문(압축 헤더 없음) · 폰트·리다이렉트는 줄이지 않는다', async () => {
    for (const value of ['br', 'identity', 'gzip;q=0', 'deflate, gzip;q=0.0']) {
      const res = await call(withEncoding('/', value));
      expect(res.isBase64Encoded, value).toBe(false);
      expect(res.headers['content-encoding'], value).toBeUndefined();
      expect(res.body.startsWith('<!doctype html>'), value).toBe(true);
    }
    expect((await call(withEncoding('/', 'GZIP;q=0.5'))).headers['content-encoding']).toBe('gzip');
    const head = await call(withEncoding('/', 'gzip', 'HEAD'));
    expect([head.body, head.headers['content-encoding'], head.headers['vary']]).toEqual(['', undefined, 'accept-encoding']);
    const redirect = await call(withEncoding('/pricing/', 'gzip'));
    expect([redirect.statusCode, redirect.headers['content-encoding']]).toEqual([301, undefined]);
  });
});

