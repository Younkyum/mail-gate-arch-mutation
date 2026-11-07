/**
 * 홈 앞 CloudFront 의 언어 협상 함수(`src/site/edge-lang.ts` — 2026-09-30, 영어 기본 · 한국어 `/kr`). 배포되는 **소스 문자열 그대로**를
 * `new Function` 으로 싣고 CloudFront Functions 이벤트 모양으로 부른다(로컬 미리보기도 같은 방식 — `scripts/ui/preview.ts`).
 *
 * 고정하는 것: `?hl=` → 쿠키 + 쿼리 뗀 302 · 쿠키 `en` 은 옮기지 않음 · 쿠키 `ko` · (쿠키 없이) Accept-Language 최상위가 한국어면 `/kr…` 302 ·
 * `/kr…`·자산·그 밖의 경로·GET/HEAD 밖은 그대로 · 협상 대상 경로 = `SITE_ROUTES` 의 영어 페이지 전부 · ES5 · 크기 한도.
 */

import { describe, expect, it } from 'vitest';

import { KO_PREFIX, SITE_LANG_COOKIE } from '../../../src/site/constants';
import { NEGOTIATED_EN_PATHS, SITE_LANG_COOKIE_ATTRIBUTES, SITE_LANG_FUNCTION_CODE } from '../../../src/site/edge-lang';
import { SITE_ROUTES } from '../../../src/site/http';
import { sitePath } from '../../../src/site/page';

interface Value {
  readonly value: string;
  readonly multiValue?: readonly { readonly value: string }[];
}
interface EdgeResponse {
  readonly statusCode: number;
  readonly headers: Record<string, Value>;
  readonly cookies?: Record<string, { readonly value: string; readonly attributes?: string }>;
}
interface EdgeRequest {
  readonly method: string;
  readonly uri: string;
  readonly querystring: Record<string, Value>;
  readonly headers: Record<string, Value>;
  readonly cookies: Record<string, Value>;
}

const handler = new Function(`${SITE_LANG_FUNCTION_CODE}\nreturn handler;`)() as (event: { request: EdgeRequest }) => EdgeResponse | EdgeRequest;

function run(
  uri: string,
  opts: { method?: string; query?: Record<string, Value>; cookie?: string; acceptLanguage?: string } = {},
): EdgeResponse | EdgeRequest {
  const request: EdgeRequest = {
    method: opts.method ?? 'GET',
    uri,
    querystring: opts.query ?? {},
    headers: opts.acceptLanguage === undefined ? {} : { 'accept-language': { value: opts.acceptLanguage } },
    cookies: opts.cookie === undefined ? {} : { [SITE_LANG_COOKIE]: { value: opts.cookie } },
  };
  return handler({ request });
}

const isResponse = (r: EdgeResponse | EdgeRequest): r is EdgeResponse => 'statusCode' in r;

function location(r: EdgeResponse | EdgeRequest): string | undefined {
  return isResponse(r) ? r.headers['location']?.value : undefined;
}

describe('엣지 언어 협상 — 경로 표', () => {
  it('협상 대상 = 두 언어 페이지의 영어(접두어 없는) 경로 전부 — 라우트 표와 같다', () => {
    const routed = Object.keys(SITE_ROUTES).filter((p) => p !== KO_PREFIX && !p.startsWith(`${KO_PREFIX}/`));
    expect([...NEGOTIATED_EN_PATHS].sort()).toEqual(routed.sort());
    // 한국어 짝이 실제 라우트다(`/` → `/kr`, `/pricing` → `/kr/pricing`).
    for (const p of NEGOTIATED_EN_PATHS) expect(Object.keys(SITE_ROUTES)).toContain(p === '/' ? KO_PREFIX : `${KO_PREFIX}${p}`);
    expect(sitePath('ko', 'home')).toBe('/kr');
    expect(sitePath('en', 'home')).toBe('/');
  });

  it('ES5 · 10KB 한도 안 · 외부 참조 없음(require·import·fetch 없음)', () => {
    expect(Buffer.byteLength(SITE_LANG_FUNCTION_CODE, 'utf8')).toBeLessThan(10 * 1024);
    expect(SITE_LANG_FUNCTION_CODE).not.toMatch(/\b(let|const|class|async|await|import|require|fetch)\b|=>|`/);
    expect(SITE_LANG_FUNCTION_CODE).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
    expect(SITE_LANG_FUNCTION_CODE).toMatch(/function handler\(event\)/);
  });
});

describe('엣지 언어 협상 — 동작', () => {
  it('기본은 영어 — 쿠키·Accept-Language 없으면 그대로(크롤러는 늘 영어)', () => {
    for (const p of NEGOTIATED_EN_PATHS) expect(isResponse(run(p))).toBe(false);
    expect(isResponse(run('/', { acceptLanguage: 'en-US,en;q=0.9' }))).toBe(false);
  });

  it('Accept-Language 의 가장 높은 q 가 한국어면 `/kr…` 로 302(no-store) — 쿼리는 그대로 싣는다', () => {
    for (const al of ['ko', 'ko-KR,ko;q=0.9,en-US;q=0.8', 'en;q=0.5, ko-KR;q=0.9', 'KO-kr']) {
      const r = run('/', { acceptLanguage: al });
      expect(isResponse(r) && r.statusCode, al).toBe(302);
      expect(location(r), al).toBe('/kr');
      expect(isResponse(r) && r.headers['cache-control']?.value).toBe('no-store');
      expect(isResponse(r) && r.cookies).toBeUndefined();
    }
    expect(location(run('/pricing', { acceptLanguage: 'ko-KR', query: { utm_source: { value: 'x' } } }))).toBe('/kr/pricing?utm_source=x');
    expect(location(run('/login', { acceptLanguage: 'ko' }))).toBe('/kr/login');
  });

  it('한국어가 최상위가 아니거나 q=0 이면 옮기지 않는다', () => {
    for (const al of ['en-US,en;q=0.9,ko;q=0.8', 'ja,ko;q=0.9', 'ko;q=0', 'kok', 'x-ko', '', ' , ;q=1']) {
      expect(isResponse(run('/', { acceptLanguage: al })), al).toBe(false);
    }
  });

  it('쿠키 `en` 은 Accept-Language 가 한국어여도 영어에 머문다 · 쿠키 `ko` 는 Accept-Language 와 무관하게 `/kr…`', () => {
    expect(isResponse(run('/', { cookie: 'en', acceptLanguage: 'ko-KR' }))).toBe(false);
    expect(location(run('/terms', { cookie: 'ko', acceptLanguage: 'en-US' }))).toBe('/kr/terms');
    // 모르는 쿠키 값은 없는 것과 같다(Accept-Language 로 정한다).
    expect(isResponse(run('/', { cookie: 'fr' }))).toBe(false);
    expect(location(run('/', { cookie: 'fr', acceptLanguage: 'ko' }))).toBe('/kr');
  });

  it('`?hl=ko|en` → 선택 쿠키(1년 · Path=/ · Lax · Secure) + `hl` 뺀 같은 경로로 302', () => {
    const toKo = run('/kr/pricing', { query: { hl: { value: 'ko' }, a: { value: '1' } } });
    expect(isResponse(toKo) && toKo.statusCode).toBe(302);
    expect(location(toKo)).toBe('/kr/pricing?a=1');
    expect(isResponse(toKo) && toKo.cookies?.[SITE_LANG_COOKIE]).toEqual({ value: 'ko', attributes: SITE_LANG_COOKIE_ATTRIBUTES });
    expect(SITE_LANG_COOKIE_ATTRIBUTES).toBe('Path=/; Max-Age=31536000; SameSite=Lax; Secure');
    // 한국어 방문자가 English 를 고르면: 쿠키 en + 영어 경로 — 다음 요청부터는 옮기지 않는다.
    const toEn = run('/', { query: { hl: { value: 'en' } }, acceptLanguage: 'ko-KR' });
    expect(location(toEn)).toBe('/');
    expect(isResponse(toEn) && toEn.cookies?.[SITE_LANG_COOKIE]?.value).toBe('en');
    expect(isResponse(run('/', { cookie: 'en', acceptLanguage: 'ko-KR' }))).toBe(false);
    // 여러 값 쿼리는 모두 싣는다.
    expect(location(run('/', { query: { hl: { value: 'en' }, t: { value: '1', multiValue: [{ value: '1' }, { value: '2' }] } } }))).toBe('/?t=1&t=2');
    // 모르는 hl 값은 무시(일반 협상).
    expect(isResponse(run('/', { query: { hl: { value: 'fr' } } }))).toBe(false);
  });

  it('`/kr…`·자산·그 밖의 경로·GET/HEAD 밖은 절대 옮기지 않는다', () => {
    for (const p of ['/kr', '/kr/pricing', '/kr/login', '/_fonts/abc/x.woff2', '/img/1/a.webp', '/og/en.png', '/favicon.svg', '/robots.txt', '/sitemap.xml', '/nope', '/en', '/en/pricing', '/pricing/']) {
      expect(isResponse(run(p, { cookie: 'ko', acceptLanguage: 'ko' })), p).toBe(false);
    }
    expect(isResponse(run('/', { method: 'POST', cookie: 'ko' }))).toBe(false);
    expect(location(run('/', { method: 'HEAD', cookie: 'ko' }))).toBe('/kr');
    // 자산 경로의 `hl` 은 쿠키를 적지 않는다.
    expect(isResponse(run('/robots.txt', { query: { hl: { value: 'ko' } } }))).toBe(false);
  });

  it('비공허: 쿠키 ko 를 무시하게 망가뜨린 소스는 위 단언에 걸린다', () => {
    const broken = new Function(`${SITE_LANG_FUNCTION_CODE.replace("cv==='ko'||", '')}\nreturn handler;`)() as typeof handler;
    const r = broken({ request: { method: 'GET', uri: '/terms', querystring: {}, headers: {}, cookies: { [SITE_LANG_COOKIE]: { value: 'ko' } } } });
    expect(isResponse(r)).toBe(false);
  });
});
