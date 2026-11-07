/**
 * 콘솔 두 언어(`signup-contract.md` §8) — 사전 완전성 · 언어 새지 않음 · 두 벌 CSP(→ `admin-ui.test.ts` 의 `describe.each` 가 두 벌 다
 * 돈다) · 언어 선택 규칙 · `?lang=` 302 와 쿠키 · `Vary`.
 *
 * 되돌려서 빨개지는지 확인한 것은 보고서의 되돌림 표에 있다(사전 한 줄 삭제 → ⓘ-2 · 원문에 새 한국어 문구 → ⓘ-2 ·
 * `selectLang` 의 쿼리/쿠키 순서 뒤집기 → ⓘ-5 · `langRedirect` 제거 → ⓘ-6 · `Vary` 제거 → ⓘ-7).
 */

import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { createInMemoryContentStore } from '../../../src/api/content-store';
import { LANG_COOKIE, type AdminHttpEvent } from '../../../src/admin/http';
import { routeAdminEvent } from '../../../src/admin/router';
import { isLang, localize, MESSAGES, selectLang } from '../../../src/admin/ui/i18n';
import {
  renderAppPage,
  renderLoginLandingPage,
  renderLoginPage,
  renderSignupLandingPage,
  renderSignupPage,
  UI_SOURCES,
  type AdminUiPage,
  type Lang,
} from '../../../src/admin/ui/index';
import { SETUP_MESSAGE } from '../../../src/admin/ui/setup-message';

import { inlined } from './console-harness';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';

const RENDERERS: ReadonlyArray<readonly [string, (lang?: Lang) => AdminUiPage]> = [
  ['login', renderLoginPage],
  ['landing', renderLoginLandingPage],
  ['signup', renderSignupPage],
  ['signup-landing', renderSignupLandingPage],
  ['app', renderAppPage],
];

/** 한글 음절(가–힣) — 정화 정규식이 지우는 한글 채움 문자(U+1160·U+3164·U+FFA0)는 글자가 아니라 빼고 본다. */
const HANGUL = /[\uac00-\ud7a3]/;
/** 스크립트의 `\uXXXX` 를 푼 페이지 전체 — 브라우저가 보게 될 글자. */
const decoded = (html: string): string => html.replace(/\\u([0-9a-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
/** 한글 조각(앞뒤 문맥 조금). */
const hangulRuns = (text: string): string[] => [...text.matchAll(/[^<>'"\n]{0,20}[\uac00-\ud7a3][^<>'"\n]{0,20}/g)].map((m) => m[0]);

/**
 * 영어 페이지에 남아도 되는 한글 — 셋뿐이다: 언어 전환 링크 "한국어"(한국어로 적어야 한국어 사용자가 찾는다) ·
 * 표시 정화의 자르기 표식 "…(잘림)"(서버 `sanitizeDisplayText` 와 **같은 출력**이어야 한다 — `admin-ui.test.ts` ⑨·⑩. API 가 이미
 * 이 표식으로 자른 문자열을 준다) · **에이전트 설정 메시지의 한국어 틀**(v2 §4 — 메시지 언어는 페이지 언어와 따로 고른다(KO/EN),
 * 그래서 영어 페이지도 한국어 틀을 싣는다. 틀은 `\uXXXX` 로만 실려 사전 번역을 타지 않는다 — `admin-console-v2.test.ts` Ⓢ-5).
 * 틀 **통째로**만 뺀다 — 틀 밖에 한글이 한 글자라도 새면 여기서 빨갛다.
 */
// `>한국어</button>` — 설정 > 메일의 언어 선택지(202610101000)는 각 언어를 그 언어로 적는다(`MAIL_LOCALE_LABELS` · `lang="ko"`).
const ALLOWED_IN_EN = ['>한국어</a>', '>한국어</button>', "'\u2026(잘림)'", JSON.stringify(SETUP_MESSAGE.ko)];

describe('사전 — ko/en 키 집합 · 완전성', () => {
  it('ⓘ-1 두 언어의 키 집합이 같다 · 빈 키 없음 · 영어 값에 한글 없음 · 한국어 값은 원문 그대로', () => {
    const ko = Object.keys(MESSAGES.ko).sort();
    const en = Object.keys(MESSAGES.en).sort();
    expect(ko).toEqual(en);
    expect(ko.length).toBeGreaterThan(400);
    for (const key of ko) {
      expect(key.trim().length, JSON.stringify(key)).toBeGreaterThan(0);
      expect(HANGUL.test(key), key).toBe(true);
      expect(MESSAGES.ko[key]).toBe(key);
      expect(HANGUL.test(MESSAGES.en[key] ?? ''), key).toBe(false);
    }
  });

  it('ⓘ-2 영어 페이지 다섯에 한글이 남지 않는다(언어 전환 링크 · 자르기 표식만) — 사전에서 빠진 원문이 있으면 여기서 빨개진다', () => {
    for (const [name, render] of RENDERERS) {
      let text = decoded(inlined(render('en')));
      for (const allowed of ALLOWED_IN_EN) text = text.split(allowed).join('');
      expect(hangulRuns(text), name).toEqual([]);
    }
  });

  it('ⓘ-3 쓰이지 않는 키가 없다 — 모든 키가 영어 벌을 만들 때 한 번은 실제로 바뀐다(긴 키에 가려진 짧은 키도 빨갛다)', () => {
    const keys = Object.keys(MESSAGES.en).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
    const applied = new Set<string>();
    for (const part of UI_SOURCES) {
      for (const source of [part.title, part.body, part.script]) {
        let out = source;
        for (const key of keys) {
          if (!out.includes(key)) continue;
          applied.add(key);
          out = out.split(key).join(MESSAGES.en[key] ?? '');
        }
      }
    }
    expect(keys.filter((key) => !applied.has(key))).toEqual([]);
  });

  it('ⓘ-3b localize: 긴 키가 먼저 · 문맥별 이스케이프(HTML 텍스트 · JS 문자열) · 한국어는 그대로', () => {
    expect(localize('로그인 코드 받기', 'en', 'html')).toBe('Email me a login code');
    expect(localize('로그인', 'en', 'html')).toBe('Log in');
    expect(localize("x='이름을 적어 주세요.'", 'ko', 'js')).toBe("x='이름을 적어 주세요.'");
    // 영어 값의 아포스트로피가 JS 문자열을 닫지 않는다.
    expect(localize("'로그인 코드를 보내지 못했습니다'", 'en', 'js')).toBe("'We couldn\\'t send the login code'");
    expect(localize('로그인 코드를 보내지 못했습니다', 'en', 'html')).toBe("We couldn't send the login code");
  });
});

describe('페이지 — 언어가 새지 않는다 · lang 속성 · 전환 링크', () => {
  /** 한 언어에만 있어야 하는 표본 문구(페이지 → [한국어, 영어]). */
  const SAMPLES: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
    login: [
      ['메일을 확인하세요', 'Check your email'],
      ['처음이신가요? ', 'New to Atmark? '],
    ],
    landing: [['이 로그인 링크는 더 쓰지 않습니다', 'This login link no longer works']],
    signup: [
      ['조직 만들기', 'Create your organization'],
      ['이용약관', 'Terms of Service'],
    ],
    'signup-landing': [['이 가입 확인 링크는 더 쓰지 않습니다', 'This sign-up link no longer works']],
    app: [
      ['운영자가 검토하고 있습니다. 외부 발송은 검토 뒤 열립니다.', 'Under review. Outside email opens after review.'],
      ['토큰은 지금 한 번만 보입니다', 'This token is shown only once'],
      ['에이전트에게 보낼 설정 메시지', 'Setup message for your agent'],
      ['목록에 있는 상대에게만 보냅니다.', 'Sends only to listed contacts.'],
      ['콘솔에서만 보임', 'Visible in console only'],
      ['공개 신원 설명', 'About the public identity'],
      ['누구에게나 보냅니다. 한도·수신 거부 목록·내용 검사는 그대로입니다.', 'Emails anyone. Limits, the suppression list and content checks still apply.'],
    ],
  };

  it.each(RENDERERS)('ⓘ-4 %s — 한국어 벌에는 영어 표본이, 영어 벌에는 한국어 표본이 없다 · <html lang> · 반대 언어 링크', (name, render) => {
    const ko = decoded(inlined(render('ko')));
    const en = decoded(inlined(render('en')));
    for (const [koText, enText] of SAMPLES[name] ?? []) {
      expect(ko, name).toContain(koText);
      expect(ko, name).not.toContain(enText);
      expect(en, name).toContain(enText);
      expect(en, name).not.toContain(koText);
    }
    expect(ko.startsWith('<!doctype html><html lang="ko">')).toBe(true);
    expect(en.startsWith('<!doctype html><html lang="en">')).toBe(true);
    if (name === 'app') {
      // 콘솔은 상단 바의 전환 링크 대신 계정 메뉴의 언어 칸(2026-09-30) — 두 언어 링크가 늘 함께 있다.
      for (const page of [ko, en]) {
        expect(page).toContain('href="?lang=en" hreflang="en" lang="en" id="acct-en" aria-checked="false">English</a>');
        expect(page).toContain('href="?lang=ko" hreflang="ko" lang="ko" id="acct-ko" aria-checked="false">한국어</a>');
      }
    } else {
      expect(ko).toContain('<a class="lang" href="?lang=en" hreflang="en" lang="en">English</a>');
      expect(en).toContain('<a class="lang" href="?lang=ko" hreflang="ko" lang="ko">한국어</a>');
    }
    expect(render('ko').csp).not.toBe(render('en').csp);
    expect(render().html).toBe(render('ko').html); // 언어를 안 주면 한국어
  });

  it('ⓘ-4b 영어 가입 화면은 영어 약관·개인정보 안내(접두어 없음 — 2026-09-30 영어 기본)로 · 스크립트는 LANG과 로캘을 싣고 영어 화면에는 서버 detail(한국어)을 붙이지 않는다', () => {
    const en = inlined(renderSignupPage('en'));
    expect(en).toContain('I have read and agree to the <a href="https://atmark.ai/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a>');
    expect(en).toContain('<a href="https://atmark.ai/privacy" target="_blank" rel="noopener noreferrer">Privacy Notice</a>');
    expect(inlined(renderSignupPage('ko'))).toContain('<a href="https://atmark.ai/kr/terms"');
    const app = inlined(renderAppPage('en'));
    expect(app).toContain("<script>var LANG='en';(function(){");
    expect(inlined(renderAppPage('ko'))).toContain("<script>var LANG='ko';(function(){");
    // 날짜는 언어별 포매터 하나(비평 R9-06) — Intl 로캘 출력 대신 LANG 을 본다.
    expect(app).toContain("function isEn(){return typeof LANG!=='undefined'&&LANG==='en';}");
    // 서버 detail(한국어)은 사람이 읽는 문장 밖(title)에만, 그것도 한국어 화면에서만(비평 R7-04).
    expect(app).toContain("if(LANG==='ko'&&det&&!OWN[e.code])x.push(det);");
  });
});

describe('언어 선택 — ① ?lang ② 쿠키 ③ Accept-Language(첫 언어가 en*)', () => {
  it('ⓘ-5 selectLang', () => {
    expect(selectLang({})).toBe('ko');
    expect(selectLang({ acceptLanguage: 'en-US,en;q=0.9,ko;q=0.8' })).toBe('en');
    expect(selectLang({ acceptLanguage: 'EN' })).toBe('en');
    expect(selectLang({ acceptLanguage: ' en-GB ; q=1' })).toBe('en');
    expect(selectLang({ acceptLanguage: 'ko-KR,ko;q=0.9,en-US;q=0.8' })).toBe('ko');
    expect(selectLang({ acceptLanguage: 'fr-FR,en;q=0.5' })).toBe('ko');
    expect(selectLang({ cookie: 'en', acceptLanguage: 'ko-KR' })).toBe('en');
    expect(selectLang({ cookie: 'ko', acceptLanguage: 'en-US' })).toBe('ko');
    expect(selectLang({ cookie: 'fr', acceptLanguage: 'en-US' })).toBe('en');
    expect(selectLang({ query: 'ko', cookie: 'en', acceptLanguage: 'en' })).toBe('ko');
    expect(selectLang({ query: 'xx', cookie: 'en' })).toBe('en');
    expect(isLang('en')).toBe(true);
    expect(isLang('EN')).toBe(false);
  });

  // 라우터 그대로 — 페이지 경로는 세션 쿠키가 없으면 DB 를 부르지 않는다(풀은 쓰이면 던진다).
  const deps: AdminDependencies = {
    pool: new Proxy({} as Pool, {
      get() {
        throw new Error('이 테스트에서 DB를 부르면 안 된다');
      },
    }),
    loginKeys: parseHmacKeyring('k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'TEST'),
    custody: () => {
      throw new Error('unused');
    },
    outboundContent: createInMemoryContentStore(),
    now: () => new Date(),
  };
  const get = (path: string, options: { query?: string; cookies?: string[]; headers?: Record<string, string> } = {}) => {
    const event: AdminHttpEvent = {
      rawPath: path,
      ...(options.query === undefined ? {} : { rawQueryString: options.query }),
      headers: options.headers ?? {},
      cookies: options.cookies ?? [],
      requestContext: { requestId: `req-${randomUUID()}`, stage: '$default', http: { method: 'GET', sourceIp: '203.0.113.9' } },
    };
    return routeAdminEvent(deps, event);
  };

  it.each(['/', '/login', '/signup', '/signup/verify', '/app'])('ⓘ-6 %s?lang=en → 쿠키(__Host- · Secure · Path=/ · SameSite=Lax · 1년) + 쿼리 뺀 같은 경로로 302', async (path) => {
    const result = await get(path, { query: 'lang=en' });
    expect(result.statusCode).toBe(302);
    expect(result.headers['location']).toBe(path);
    expect(result.cookies).toEqual([`${LANG_COOKIE}=en; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`]);
    expect(result.headers['vary']).toBe('Cookie, Accept-Language');
    const back = await get(path, { query: 'lang=ko&x=1' });
    expect(back.headers['location']).toBe(`${path}?x=1`);
    expect(back.cookies?.[0]).toMatch(/^__Host-atmark_lang=ko; /);
  });

  it('ⓘ-7b 페이지는 Accept-Encoding: gzip 이면 gzip(base64 본문 · content-encoding · Vary 에 Accept-Encoding) — 아니면 그대로(리뷰 M3)', async () => {
    const page = inlined(renderAppPage('ko'));
    const plain = await get('/', { headers: { 'accept-language': 'ko' } });
    expect(plain.isBase64Encoded).toBe(false);
    expect(plain.headers['content-encoding']).toBeUndefined();
    for (const ae of ['gzip, deflate, br', 'br;q=1.0, gzip;q=0.8', '*']) {
      const packed = await get('/', { headers: { 'accept-encoding': ae, 'accept-language': 'ko' } });
      expect(packed.statusCode, ae).toBe(200);
      expect(packed.isBase64Encoded, ae).toBe(true);
      expect(packed.headers['content-encoding'], ae).toBe('gzip');
      expect(packed.headers['vary'], ae).toBe('Cookie, Accept-Language, Accept-Encoding');
      expect(gunzipSync(Buffer.from(packed.body, 'base64')).toString('utf8'), ae).toBe(plain.body);
    }
    for (const ae of ['gzip;q=0', 'br', 'identity']) {
      const off = await get('/', { headers: { 'accept-encoding': ae, 'accept-language': 'ko' } });
      expect(off.isBase64Encoded, ae).toBe(false);
      expect(off.headers['content-encoding'], ae).toBeUndefined();
    }
    expect(gzipSync(page).length).toBeLessThan(page.length / 3);
  });

  it('ⓘ-7 쿠키 → 그 언어 · 쿠키 없으면 Accept-Language · 둘 다 없으면 한국어 · Vary: Cookie, Accept-Language · 잘못된 ?lang은 무시', async () => {
    const byCookie = await get('/signup', { cookies: [`${LANG_COOKIE}=en`], headers: { 'accept-language': 'ko-KR' } });
    expect(byCookie.statusCode).toBe(200);
    expect(byCookie.body).toBe(renderSignupPage('en').html);
    expect(byCookie.headers['content-security-policy']).toBe(renderSignupPage('en').csp);
    expect(byCookie.headers['vary']).toBe('Cookie, Accept-Language, Accept-Encoding');
    const byHeader = await get('/', { headers: { 'accept-language': 'en-US,en;q=0.9' } });
    expect(byHeader.body).toBe(renderLoginPage('en').html);
    const koCookieWins = await get('/', { cookies: [`${LANG_COOKIE}=ko`], headers: { 'accept-language': 'en-US' } });
    expect(koCookieWins.body).toBe(renderLoginPage('ko').html);
    const plain = await get('/login');
    expect(plain.body).toBe(renderLoginLandingPage('ko').html);
    const junk = await get('/signup', { query: 'lang=fr', headers: { 'accept-language': 'en' } });
    expect(junk.statusCode).toBe(200);
    expect(junk.body).toBe(renderSignupPage('en').html);
    // 세션 없는 /app 은 언어와 무관하게 / 로(쿼리가 없을 때).
    const app = await get('/app', { cookies: [`${LANG_COOKIE}=en`] });
    expect(app.statusCode).toBe(302);
    expect(app.headers['location']).toBe('/');
  });
});
