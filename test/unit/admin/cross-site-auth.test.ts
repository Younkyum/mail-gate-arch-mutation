/**
 * 콘솔의 교차 출처 로그인·가입(US-003) — **DB 없이** 라우터 그대로(`routeAdminEvent`). DB 가 필요한 경로(202·쿠키·열거·상한·
 * 로그인 전체 흐름)는 `test/integration/admin/cross-site-auth.test.ts`.
 *
 *   - 프리플라이트: `OPTIONS /api/login`·`/api/signup`·그 verify 둘(2026-09-28 — 메일 코드) 만, 출처가 **정확히** `https://atmark.ai` · 메서드 POST · 요청 헤더
 *     `content-type` 뿐일 때만 204 + CORS. 그 밖(다른 출처·www·http·접미 도메인·null·없음, 다른 메서드, CSRF·Authorization·Cookie
 *     헤더 요청)은 403 이고 CORS 헤더가 없다. 다른 경로의 OPTIONS 는 지금처럼 404·405 이고 CORS 헤더가 없다.
 *   - 출처 허용 목록은 경로별: 홈 출처는 `POST /api/login`·`/api/signup`·그 verify 둘에서만 통과(그 응답에만 CORS 헤더) — 세션 경로는 403.
 *     홈 출처의 로그인 verify 응답에는 CSRF 토큰이 없다(통합 테스트 `login-code.test.ts`).
 *   - 운영 스위치 `ATMARK_SITE_CORS`(검증 F2): 위 두 항목은 켰을 때다. 끄면(기본) 홈 출처도 다른 교차 출처와 같다 —
 *     프리플라이트 403 · CORS 헤더 없음 · `POST` 403 origin_mismatch.
 *   - 운영 스위치 `ATMARK_AUTH_ON_SITE`: 켜면 비로그인 `/`·`/signup`·`/app` → 홈(언어 유지), 끄면(기본) 지금 그대로.
 *     메일 링크 착지(`/login`·`/signup/verify`)는 두 상태 모두 콘솔 페이지다.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import {
  AUTH_ON_SITE_ENV,
  authOnSite,
  CORS_MAX_AGE_SECONDS,
  LANG_COOKIE,
  SESSION_COOKIE,
  SESSION_HINT_PATH,
  SITE_CORS_ENV,
  siteCors,
  type AdminHttpEvent,
} from '../../../src/admin/http';
import { routeAdminEvent } from '../../../src/admin/router';
import {
  renderLoginLandingPage,
  renderLoginPage,
  renderSignupLandingPage,
  renderSignupPage,
} from '../../../src/admin/ui/index';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';

const SITE = 'https://atmark.ai';
const CONSOLE = 'https://console.atmark.ai';

/** DB 를 부르면 던지는 의존성 — 이 파일의 모든 경로는 DB 전에 끝난다. */
const deps = {
  pool: new Proxy({} as Pool, {
    get() {
      throw new Error('이 테스트에서 DB 를 부르면 안 된다');
    },
  }),
  loginKeys: parseHmacKeyring('k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'TEST'),
  custody: () => {
    throw new Error('unused');
  },
  now: () => new Date(),
} as unknown as AdminDependencies;

interface Req {
  readonly headers?: Record<string, string>;
  readonly cookies?: string[];
  readonly body?: string;
  readonly query?: string;
}

function send(method: string, path: string, req: Req = {}) {
  const event: AdminHttpEvent = {
    rawPath: path,
    ...(req.query === undefined ? {} : { rawQueryString: req.query }),
    headers: req.headers ?? {},
    cookies: req.cookies ?? [],
    ...(req.body === undefined ? {} : { body: req.body }),
    isBase64Encoded: false,
    requestContext: { requestId: `req-${randomUUID()}`, stage: '$default', http: { method, sourceIp: '203.0.113.7' } },
  };
  return routeAdminEvent(deps, event);
}

const preflightHeaders = (origin: string | undefined, method = 'POST', headers: string | undefined = 'content-type'): Record<string, string> => ({
  ...(origin === undefined ? {} : { origin }),
  'access-control-request-method': method,
  ...(headers === undefined ? {} : { 'access-control-request-headers': headers }),
});

const CORS_KEYS = /^access-control-/;
const corsHeaderNames = (headers: Readonly<Record<string, string>>): string[] => Object.keys(headers).filter((key) => CORS_KEYS.test(key));

/** CORS 스위치를 켠 상태(아래 두 묶음) — 끈 상태는 맨 끝 묶음. */
function withSiteCorsOn(): void {
  beforeEach(() => {
    vi.stubEnv(SITE_CORS_ENV, 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
}

describe('프리플라이트 — OPTIONS /api/login · /api/signup', () => {
  withSiteCorsOn();
  it.each(['/api/login', '/api/signup', '/api/login/verify', '/api/signup/verify'])('%s: 출처 https://atmark.ai · POST · content-type → 204 + 정확한 CORS 헤더(와일드카드 없음)', async (path) => {
    const res = await send('OPTIONS', path, { headers: preflightHeaders(SITE) });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.cookies).toBeUndefined();
    const cors = Object.fromEntries(Object.entries(res.headers).filter(([key]) => CORS_KEYS.test(key)));
    expect(cors).toEqual({
      'access-control-allow-origin': 'https://atmark.ai',
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': String(CORS_MAX_AGE_SECONDS),
    });
    expect(CORS_MAX_AGE_SECONDS).toBeLessThanOrEqual(600);
    expect(res.headers['vary']).toMatch(/\bOrigin\b/);
    expect(JSON.stringify(res.headers)).not.toContain('*');
    // 공통 보안 헤더는 그대로.
    expect(res.headers).toMatchObject({ 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' });
  });

  it('요청 헤더 이름은 대소문자·공백을 무시한다 · 요청 헤더가 없어도 된다', async () => {
    for (const headers of ['Content-Type', ' content-type ', undefined]) {
      const res = await send('OPTIONS', '/api/login', { headers: preflightHeaders(SITE, 'POST', headers) });
      expect(res.statusCode, String(headers)).toBe(204);
    }
    // 헤더 이름 대소문자(API Gateway 는 소문자로 주지만, 라우터는 스스로 낮춘다).
    const upper = await send('OPTIONS', '/api/signup', { headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST' } });
    expect(upper.statusCode).toBe(204);
  });

  it.each([
    ['다른 출처', 'https://evil.example'],
    ['www', 'https://www.atmark.ai'],
    ['http', 'http://atmark.ai'],
    ['접미 도메인', 'https://atmark.ai.evil.example'],
    ['형제 호스트', 'https://api.atmark.ai'],
    ['콘솔 자신(교차 출처가 아니다)', CONSOLE],
    ['끝 슬래시', 'https://atmark.ai/'],
    ['포트', 'https://atmark.ai:443'],
    ['대문자', 'https://ATMARK.ai'],
    ['null', 'null'],
    ['없음', undefined],
  ] as const)('출처 %s(%s) → 403 · CORS 헤더 없음', async (_label, origin) => {
    for (const path of ['/api/login', '/api/signup']) {
      const res = await send('OPTIONS', path, { headers: preflightHeaders(origin) });
      expect(res.statusCode).toBe(403);
      expect(corsHeaderNames(res.headers)).toEqual([]);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'cors_rejected' });
    }
  });

  it.each([
    ['메서드 GET', 'GET', 'content-type'],
    ['메서드 PUT', 'PUT', 'content-type'],
    ['메서드 없음', '', 'content-type'],
    ['CSRF 헤더', 'POST', 'content-type, x-atmark-csrf'],
    ['Authorization', 'POST', 'authorization'],
    ['Cookie', 'POST', 'content-type,cookie'],
    ['임의 헤더', 'POST', 'x-requested-with'],
  ] as const)('%s → 403 · CORS 헤더 없음', async (_label, method, headers) => {
    const res = await send('OPTIONS', '/api/login', { headers: preflightHeaders(SITE, method, headers) });
    expect(res.statusCode).toBe(403);
    expect(corsHeaderNames(res.headers)).toEqual([]);
  });

  it.each(['/api/kill-switch', '/api/logout', '/api/me', '/api/invites/claim', '/', '/login', '/signup/verify', '/nope'])(
    '다른 경로 OPTIONS %s → 프리플라이트 아님(404·405) · CORS 헤더 없음',
    async (path) => {
      const res = await send('OPTIONS', path, { headers: preflightHeaders(SITE) });
      expect([404, 405]).toContain(res.statusCode);
      expect(corsHeaderNames(res.headers)).toEqual([]);
    },
  );

  it('스테이지 접두어·끝 슬래시가 붙은 경로도 같은 규칙', async () => {
    const res = await send('OPTIONS', '/api/login/', { headers: preflightHeaders(SITE) });
    expect(res.statusCode).toBe(204);
  });
});

describe('출처 허용 목록 — 경로별', () => {
  withSiteCorsOn();
  const json = { 'content-type': 'application/json' };

  it.each([
    ['POST', '/api/invites/claim'],
    ['POST', '/api/logout'],
    ['POST', '/api/kill-switch'],
    ['POST', '/api/agents'],
    ['PATCH', '/api/agents/0123456789abcdef0123456789abcdef/policy'],
  ] as const)('홈 출처의 %s %s → 403 origin_mismatch · CORS 헤더 없음', async (method, path) => {
    const res = await send(method, path, { headers: { ...json, origin: SITE }, body: '{}' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'origin_mismatch' });
    expect(corsHeaderNames(res.headers)).toEqual([]);
  });

  it.each(['https://evil.example', 'https://www.atmark.ai', 'http://atmark.ai', 'https://atmark.ai.evil.example', 'null'])(
    '다른 출처(%s)의 POST /api/login·/api/signup → 403 · CORS 헤더 없음',
    async (origin) => {
      for (const path of ['/api/login', '/api/signup']) {
        const res = await send('POST', path, { headers: { ...json, origin }, body: '{}' });
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body)).toMatchObject({ error: 'origin_mismatch' });
        expect(corsHeaderNames(res.headers)).toEqual([]);
        expect(res.cookies).toBeUndefined();
      }
    },
  );

  it.each([
    ['/api/login/verify', 'login_browser_missing'],
    ['/api/signup/verify', 'signup_browser_missing'],
  ] as const)('홈 출처의 POST %s(코드, 결속 쿠키 없음) → 401 %s(DB 전) · CORS 헤더가 붙는다', async (path, code) => {
    const res = await send('POST', path, { headers: { ...json, origin: SITE }, body: JSON.stringify({ code: '123456' }) });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: code });
    expect(res.headers['access-control-allow-origin']).toBe(SITE);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['vary']).toBe('Origin');
  });

  it('홈 출처의 오류 응답(DB 전)에도 CORS 헤더가 붙는다 — 화면이 상태를 읽는다 · Vary: Origin', async () => {
    const wrongType = await send('POST', '/api/login', { headers: { origin: SITE, 'content-type': 'text/plain' }, body: 'x' });
    expect(wrongType.statusCode).toBe(415);
    expect(wrongType.headers['access-control-allow-origin']).toBe(SITE);
    expect(wrongType.headers['access-control-allow-credentials']).toBe('true');
    expect(wrongType.headers['vary']).toBe('Origin');
    const bearer = await send('POST', '/api/signup', { headers: { ...json, origin: SITE, authorization: 'Bearer x' }, body: '{}' });
    expect(bearer.statusCode).toBe(401);
    expect(bearer.headers['access-control-allow-origin']).toBe(SITE);
    const tooBig = await send('POST', '/api/login', { headers: { ...json, origin: SITE }, body: 'x'.repeat(70 * 1024) });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.headers['access-control-allow-origin']).toBe(SITE);
  });

  it('콘솔 출처·출처 없음의 요청에는 CORS 허용 헤더가 없다(같은 출처 — 필요 없다) · Vary: Origin 은 있다', async () => {
    for (const headers of [{ ...json, origin: CONSOLE }, json]) {
      const res = await send('POST', '/api/login', { headers: { ...headers, 'content-type': 'text/plain' }, body: 'x' });
      expect(res.statusCode).toBe(415);
      expect(corsHeaderNames(res.headers)).toEqual([]);
      expect(res.headers['vary']).toBe('Origin');
    }
  });

  it('GET 에는 CORS 헤더가 없다(교차 출처 읽기 경로는 세션 힌트 하나뿐 — 아래 묶음)', async () => {
    for (const path of ['/', '/login', '/signup', '/signup/verify', '/api/me']) {
      const res = await send('GET', path, { headers: { origin: SITE } });
      expect(corsHeaderNames(res.headers), path).toEqual([]);
    }
  });
});

/**
 * 세션 힌트(2026-09-30) — `GET /api/session/hint` → `{signedIn}`. 여기는 DB 전에 끝나는 경우(쿠키 없음·모양 아닌 쿠키)와 헤더 규칙.
 * 살아 있는·폐기·만료 세션은 `test/integration/admin/session-hint.test.ts`.
 */
describe('세션 힌트 — GET /api/session/hint', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('경로 상수', () => {
    expect(SESSION_HINT_PATH).toBe('/api/session/hint');
  });

  it.each([
    ['쿠키 없음', undefined],
    ['모양 아닌 쿠키', [`${SESSION_COOKIE}=garbage`]],
    ['접두어만 맞는 쿠키', [`${SESSION_COOKIE}=atk_admin_short`]],
  ] as const)('%s → 200 {signedIn:false} 뿐 · DB 를 보지 않는다 · Set-Cookie 없음 · no-store · Vary: Origin', async (_label, cookies) => {
    vi.stubEnv(SITE_CORS_ENV, 'true');
    const res = await send('GET', SESSION_HINT_PATH, { headers: { origin: SITE }, ...(cookies === undefined ? {} : { cookies: [...cookies] }) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"signedIn":false}');
    expect(res.cookies).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['vary']).toBe('Origin');
  });

  it('스위치 켬 · 출처 정확히 https://atmark.ai → CORS 두 줄(와일드카드 없음) · 그 밖의 출처는 CORS 헤더 없음(200 은 그대로)', async () => {
    vi.stubEnv(SITE_CORS_ENV, 'true');
    const site = await send('GET', SESSION_HINT_PATH, { headers: { origin: SITE } });
    expect(Object.fromEntries(Object.entries(site.headers).filter(([key]) => CORS_KEYS.test(key)))).toEqual({
      'access-control-allow-origin': 'https://atmark.ai',
      'access-control-allow-credentials': 'true',
    });
    for (const origin of ['https://evil.example', 'https://www.atmark.ai', 'http://atmark.ai', 'https://atmark.ai.evil.example', 'https://api.atmark.ai', 'null', CONSOLE, undefined]) {
      const res = await send('GET', SESSION_HINT_PATH, { headers: origin === undefined ? {} : { origin } });
      expect(res.statusCode, String(origin)).toBe(200);
      expect(corsHeaderNames(res.headers), String(origin)).toEqual([]);
      expect(res.headers['vary'], String(origin)).toBe('Origin');
    }
  });

  it.each([undefined, '', 'false'])('스위치 %s(끔) → 홈 출처에도 CORS 헤더 없음', async (value) => {
    if (value !== undefined) vi.stubEnv(SITE_CORS_ENV, value);
    const res = await send('GET', SESSION_HINT_PATH, { headers: { origin: SITE } });
    expect(res.statusCode).toBe(200);
    expect(corsHeaderNames(res.headers)).toEqual([]);
  });

  it('GET 하나뿐 — POST·OPTIONS(프리플라이트 없음) → 405 Allow: GET · Authorization → 401(CORS 는 붙어 화면이 읽는다)', async () => {
    vi.stubEnv(SITE_CORS_ENV, 'true');
    const post = await send('POST', SESSION_HINT_PATH, { headers: { origin: SITE, 'content-type': 'application/json' }, body: '{}' });
    expect([post.statusCode, post.headers['allow']]).toEqual([405, 'GET']);
    const options = await send('OPTIONS', SESSION_HINT_PATH, { headers: preflightHeaders(SITE, 'GET', undefined) });
    expect([options.statusCode, options.headers['allow']]).toEqual([405, 'GET']);
    expect(corsHeaderNames(options.headers)).toEqual([]);
    const bearer = await send('GET', SESSION_HINT_PATH, { headers: { origin: SITE, authorization: 'Bearer x' } });
    expect(bearer.statusCode).toBe(401);
    expect(bearer.headers['access-control-allow-origin']).toBe(SITE);
  });

  it('끝 슬래시도 같은 경로(CORS 포함)', async () => {
    vi.stubEnv(SITE_CORS_ENV, 'true');
    const res = await send('GET', `${SESSION_HINT_PATH}/`, { headers: { origin: SITE } });
    expect([res.statusCode, res.body, res.headers['access-control-allow-origin']]).toEqual([200, '{"signedIn":false}', SITE]);
  });
});

describe('운영 스위치 ATMARK_AUTH_ON_SITE — 콘솔 비로그인 방문을 홈으로', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('값은 정확히 "true" 일 때만 켜진다', () => {
    expect(AUTH_ON_SITE_ENV).toBe('ATMARK_AUTH_ON_SITE');
    expect(authOnSite({ ATMARK_AUTH_ON_SITE: 'true' })).toBe(true);
    for (const value of [undefined, '', 'false', '1', 'TRUE', 'yes', ' true']) expect(authOnSite({ ATMARK_AUTH_ON_SITE: value }), String(value)).toBe(false);
  });

  it('끔(기본): / · /signup 은 콘솔 화면 200, 비로그인 /app 은 / 로 — 지금 그대로', async () => {
    vi.stubEnv(AUTH_ON_SITE_ENV, '');
    const root = await send('GET', '/');
    expect([root.statusCode, root.body]).toEqual([200, renderLoginPage('ko').html]);
    const signup = await send('GET', '/signup', { headers: { 'accept-language': 'en-US' } });
    expect([signup.statusCode, signup.body]).toEqual([200, renderSignupPage('en').html]);
    const app = await send('GET', '/app');
    expect([app.statusCode, app.headers['location']]).toEqual([302, '/']);
  });

  it('켬: 비로그인 / · /app → 홈 로그인, /signup → 홈 가입 — 한국어는 /kr/…, 영어는 접두어 없음(2026-09-30) (언어: 쿠키 → Accept-Language → 한국어)', async () => {
    vi.stubEnv(AUTH_ON_SITE_ENV, 'true');
    const cases: ReadonlyArray<readonly [string, Req, string]> = [
      ['/', {}, 'https://atmark.ai/kr/login'],
      ['/', { headers: { 'accept-language': 'en-US,en;q=0.9' } }, 'https://atmark.ai/login'],
      ['/', { cookies: [`${LANG_COOKIE}=en`], headers: { 'accept-language': 'ko-KR' } }, 'https://atmark.ai/login'],
      ['/', { cookies: [`${LANG_COOKIE}=ko`], headers: { 'accept-language': 'en-US' } }, 'https://atmark.ai/kr/login'],
      ['/app', {}, 'https://atmark.ai/kr/login'],
      ['/app', { cookies: [`${LANG_COOKIE}=en`] }, 'https://atmark.ai/login'],
      ['/signup', {}, 'https://atmark.ai/kr/signup'],
      ['/signup', { headers: { 'accept-language': 'en' } }, 'https://atmark.ai/signup'],
      // 모양이 틀린 세션 쿠키는 세션이 아니다(DB 를 보지 않는다) — 비로그인과 같다.
      ['/', { cookies: [`${SESSION_COOKIE}=garbage`] }, 'https://atmark.ai/kr/login'],
    ];
    for (const [path, req, location] of cases) {
      const res = await send('GET', path, req);
      expect([res.statusCode, res.headers['location']], `${path} ${JSON.stringify(req)}`).toEqual([302, location]);
      expect(res.body).toBe('');
      expect(res.headers['vary']).toBe('Cookie, Accept-Language');
    }
  });

  it('켬: ?lang= 은 먼저 — 쿠키를 적고 콘솔의 같은 경로로 302(그다음 방문이 홈의 그 언어로 간다)', async () => {
    vi.stubEnv(AUTH_ON_SITE_ENV, 'true');
    const res = await send('GET', '/', { query: 'lang=en' });
    expect([res.statusCode, res.headers['location']]).toEqual([302, '/']);
    expect(res.cookies?.[0]).toMatch(/^__Host-atmark_lang=en; /);
  });

  it('두 상태 모두: 메일 링크 착지 /login · /signup/verify 는 콘솔 페이지 그대로(200)', async () => {
    for (const value of ['true', 'false']) {
      vi.stubEnv(AUTH_ON_SITE_ENV, value);
      for (const lang of ['ko', 'en'] as const) {
        const headers = { 'accept-language': lang };
        const login = await send('GET', '/login', { headers });
        expect([login.statusCode, login.body]).toEqual([200, renderLoginLandingPage(lang).html]);
        const verify = await send('GET', '/signup/verify', { headers });
        expect([verify.statusCode, verify.body]).toEqual([200, renderSignupLandingPage(lang).html]);
      }
    }
  });
});

describe('운영 스위치 ATMARK_SITE_CORS — 끔(기본)이면 홈 출처도 교차 출처로 거부 (검증 F2)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const json = { 'content-type': 'application/json' };

  it('값은 정확히 "true" 일 때만 켜진다', () => {
    expect(SITE_CORS_ENV).toBe('ATMARK_SITE_CORS');
    expect(siteCors({ ATMARK_SITE_CORS: 'true' })).toBe(true);
    for (const value of [undefined, '', 'false', '1', 'TRUE', 'yes', ' true']) expect(siteCors({ ATMARK_SITE_CORS: value }), String(value)).toBe(false);
  });

  it.each([undefined, '', 'false', 'TRUE'])('스위치 %s: 프리플라이트 403 · CORS 헤더 없음', async (value) => {
    if (value !== undefined) vi.stubEnv(SITE_CORS_ENV, value);
    for (const path of ['/api/login', '/api/signup', '/api/login/']) {
      const res = await send('OPTIONS', path, { headers: preflightHeaders(SITE) });
      expect(res.statusCode, path).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'cors_rejected' });
      expect(corsHeaderNames(res.headers)).toEqual([]);
    }
  });

  it('홈 출처의 POST /api/login·/api/signup → 403 origin_mismatch · CORS 헤더 없음(DB 전에 끝난다)', async () => {
    vi.stubEnv(SITE_CORS_ENV, 'false');
    for (const path of ['/api/login', '/api/signup']) {
      const res = await send('POST', path, { headers: { ...json, origin: SITE }, body: '{"email":"a@example.com"}' });
      expect(res.statusCode, path).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'origin_mismatch' });
      expect(corsHeaderNames(res.headers)).toEqual([]);
      expect(res.cookies).toBeUndefined();
    }
  });

  it('끔이어도 콘솔 자기 출처의 로그인·가입은 그대로 통과한다(DB 전 검사 — 415 로 확인)', async () => {
    vi.stubEnv(SITE_CORS_ENV, 'false');
    for (const headers of [{ origin: CONSOLE }, {}]) {
      const res = await send('POST', '/api/login', { headers: { ...headers, 'content-type': 'text/plain' }, body: 'x' });
      expect(res.statusCode).toBe(415);
      expect(corsHeaderNames(res.headers)).toEqual([]);
    }
  });

  it('리다이렉트 스위치만 켜도 CORS 는 열리지 않는다(두 스위치는 독립)', async () => {
    vi.stubEnv(AUTH_ON_SITE_ENV, 'true');
    vi.stubEnv(SITE_CORS_ENV, 'false');
    const res = await send('OPTIONS', '/api/login', { headers: preflightHeaders(SITE) });
    expect(res.statusCode).toBe(403);
    expect(corsHeaderNames(res.headers)).toEqual([]);
  });
});
