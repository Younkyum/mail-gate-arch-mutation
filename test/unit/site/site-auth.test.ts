/**
 * 홈의 로그인·가입 화면(US-003) — **가짜 DOM 위에서 실제 스크립트(HTML 에 박힌 그 블록)를 돌려** 동작을 본다.
 *
 *   - 제출은 콘솔 API 절대 URL 로만: `https://console.atmark.ai/api/login`·`/api/signup` · `credentials:'include'` · `mode:'cors'` ·
 *     요청 헤더는 `content-type` 하나(콘솔 프리플라이트가 허용하는 그것) · 리다이렉트 거부.
 *   - 열거 방지: 202 면 늘 같은 "메일을 확인하세요". 429·400(가입)·그 밖(403·5xx·CORS 거부 = fetch 거부)만 다른 문구.
 *   - 스크립트는 문구가 없다 — 두 언어가 같은 스크립트(같은 해시). 화면 언어는 `<html lang>` 에서 읽어 본문 `lang` 으로 보낸다
 *     (콘솔이 언어 쿠키를 적는다). `innerHTML` 류 싱크 없음.
 *   - 콘솔 쪽 상수(출처·경로·언어별 착지 URL)와 홈 쪽 상수가 서로 맞는다(두 번들은 서로 import 하지 않는다).
 */

import { createHash } from 'node:crypto';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  ADMIN_ORIGIN,
  CROSS_SITE_AUTH_PATHS,
  SITE_LOGIN_URLS,
  SITE_ORIGIN as ADMIN_SIDE_SITE_ORIGIN,
  SITE_SIGNUP_URLS,
} from '../../../src/admin/http';
import { MAX_AGENTS_PER_PENDING_ORG } from '../../../src/admin/ops/agents';
import { renderLoginPage as renderConsoleLoginPage, renderSignupPage as renderConsoleSignupPage } from '../../../src/admin/ui/index';
import {
  LOGIN_COPY,
  LOGIN_SCRIPT,
  SIGNUP_COPY,
  SIGNUP_SCRIPT,
  WAITLIST_COPY,
  WAITLIST_HEARD_FROM_KEYS,
  WAITLIST_SCRIPT,
  WAITLIST_USE_CASE_KEYS,
  waitlistNotForUrl,
} from '../../../src/site/auth';
import { WAITLIST_HEARD_FROM, WAITLIST_USE_CASES } from '../../../src/admin/waitlist';
import { WAITLIST_NOT_FOR_URLS } from '../../../src/notify/waitlist-template';
import { CONSOLE_API, CONSOLE_APP_URLS, CONSOLE_ORIGIN, PENDING_ORG_AGENT_LIMIT, SITE_ORIGIN, type SiteLang } from '../../../src/site/constants';
import { renderLoginPage, renderSignupPage, renderWaitlistPage, type SitePage } from '../../../src/site/index';
import { asciiScript, sitePath } from '../../../src/site/page';
import { SESSION_HINT_SCRIPT } from '../../../src/site/session-hint';

const LANGS: readonly SiteLang[] = ['ko', 'en'];

/** 실행 블록(`<script>` — 속성 없음, JSON-LD 데이터 블록 제외) 전부 — 머리 힌트(2026-09-30)가 먼저, 폼 스크립트가 본문 끝. */
function executedScripts(page: SitePage): string[] {
  return [...page.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
}

/** 본문 끝의 폼 스크립트 — 실행 블록 중 마지막(첫째는 모든 페이지가 싣는 머리 힌트). */
function scriptOf(page: SitePage): string {
  const scripts = executedScripts(page);
  const found = scripts[scripts.length - 1];
  if (scripts.length !== 2 || found === undefined) throw new Error(`폼 스크립트가 없다(실행 블록 ${String(scripts.length)}개)`);
  return found;
}

interface FakeElement {
  hidden: boolean;
  disabled: boolean;
  value: string;
  checked: boolean;
  focused: number;
  readonly attrs: Map<string, string>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  readonly classes: Set<string>;
  readonly classList: { add(c: string): void; remove(c: string): void };
  readonly listeners: Record<string, Array<(ev: { preventDefault(): void }) => void>>;
  addEventListener(type: string, fn: (ev: { preventDefault(): void }) => void): void;
  focus(): void;
  select(): void;
}

interface FetchInit {
  readonly method: string;
  readonly mode?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly credentials?: string;
  readonly cache?: string;
  readonly redirect?: string;
  readonly referrerPolicy?: string;
}

interface FakeFetchCall {
  readonly url: string;
  readonly init: FetchInit;
  resolve(response: { ok: boolean; status: number; json?: () => Promise<unknown> }): void;
  reject(error: unknown): void;
}

interface World {
  readonly el: (id: string) => FakeElement;
  readonly fetches: FakeFetchCall[];
  readonly touched: Set<string>;
  /** 코드가 맞은 뒤 `location.replace` 로 간 곳. */
  readonly navigated: string[];
}

function fakeElement(): FakeElement {
  const classes = new Set<string>();
  const listeners: FakeElement['listeners'] = {};
  const element: FakeElement = {
    hidden: false,
    disabled: false,
    value: '',
    checked: false,
    focused: 0,
    attrs: new Map<string, string>(),
    setAttribute(name, value) {
      element.attrs.set(name, value);
    },
    removeAttribute(name) {
      element.attrs.delete(name);
    },
    classes,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    listeners,
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    focus() {
      element.focused += 1;
    },
    select() {
      element.focused += 1;
    },
  };
  return element;
}

/** 페이지의 스크립트를 가짜 DOM·fetch 위에서 돌린다. 마크업에서 `hidden` 인 요소는 처음에 숨김(마크업과 같게). */
function run(page: SitePage, globals: Record<string, unknown> = {}): World {
  const elements = new Map<string, FakeElement>();
  const touched = new Set<string>();
  const el = (id: string): FakeElement => {
    touched.add(id);
    let found = elements.get(id);
    if (found === undefined) {
      found = fakeElement();
      found.hidden = new RegExp(`id="${id}"[^>]*\\shidden[\\s>]`).test(page.html);
      elements.set(id, found);
    }
    return found;
  };
  const fetches: FakeFetchCall[] = [];
  const navigated: string[] = [];
  const context = vm.createContext({
    location: { replace: (to: string) => navigated.push(to) },
    document: { getElementById: el, documentElement: { lang: /^<!doctype html><html lang="(ko|en)"[^>]*>/.exec(page.html)?.[1] ?? '' } },
    JSON,
    Array,
    fetch: (url: string, init: FetchInit) =>
      new Promise((resolve, reject) => {
        fetches.push({ url, init, resolve, reject });
      }),
    ...globals,
  });
  vm.runInContext(scriptOf(page), context);
  return { el, fetches, touched, navigated };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const submit = (world: World): void => {
  for (const fn of world.el('f').listeners['submit'] ?? []) fn({ preventDefault: () => undefined });
};
const click = (world: World, id: string): void => {
  for (const fn of world.el(id).listeners['click'] ?? []) fn({ preventDefault: () => undefined });
};
const visible = (world: World, ids: readonly string[]): string[] => ids.filter((id) => !world.el(id).hidden);

const LOGIN_MESSAGES = ['e0', 'e1', 'e2', 'e6'] as const;
const SIGNUP_MESSAGES = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'] as const;

describe.each(LANGS)('로그인 %s — 스크립트 동작', (lang) => {
  const page = renderLoginPage(lang);

  it('① 제출 → 콘솔 절대 URL 로 POST · credentials include · cors · content-type 하나 · 리다이렉트 거부 · 본문 {email}', () => {
    const world = run(page);
    world.el('email').value = '  owner@example.com ';
    submit(world);
    expect(world.fetches).toHaveLength(1);
    const [only] = world.fetches;
    expect(only?.url).toBe('https://console.atmark.ai/api/login');
    expect(only?.init).toEqual({
      method: 'POST',
      mode: 'cors',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', lang }),
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect(world.el('go').disabled).toBe(true);
  });

  it('② 202 → "메일을 확인하세요"(폼 숨김) · 다른 주소로 다시 → 폼', async () => {
    const world = run(page);
    world.el('email').value = 'owner@example.com';
    submit(world);
    world.fetches[0]?.resolve({ ok: true, status: 202 });
    await settle();
    expect(world.el('sent').hidden).toBe(false);
    expect(world.el('f').hidden).toBe(true);
    expect(world.el('email').value).toBe('');
    expect(visible(world, LOGIN_MESSAGES)).toEqual([]);
    click(world, 'again');
    expect([world.el('sent').hidden, world.el('f').hidden]).toEqual([true, false]);
  });

  it.each([
    [429, 'e2'],
    [403, 'e1'],
    [400, 'e1'],
    [500, 'e1'],
    [503, 'e1'],
  ] as const)('③ %i → %s (메일을 확인하세요가 아니다)', async (status, shown) => {
    const world = run(page);
    world.el('email').value = 'owner@example.com';
    submit(world);
    world.fetches[0]?.resolve({ ok: false, status });
    await settle();
    expect(visible(world, LOGIN_MESSAGES)).toEqual([shown]);
    expect(world.el('sent').hidden).toBe(true);
    expect(world.el('go').disabled).toBe(false);
  });

  it('④ fetch 거부(네트워크·CORS 거부·CORS 헤더 없는 API Gateway 429) → e6 "요청이 많거나 연결이 불안정" (검증 F11)', async () => {
    const world = run(page);
    world.el('email').value = 'owner@example.com';
    submit(world);
    world.fetches[0]?.reject(new TypeError('Failed to fetch'));
    await settle();
    expect(visible(world, LOGIN_MESSAGES)).toEqual(['e6']);
    expect(world.el('sent').hidden).toBe(true);
    expect(world.el('go').disabled).toBe(false);
    expect(page.html).toContain(LOGIN_COPY[lang]['e6'] ?? '∅');
  });

  it.each(['', 'no-at', '@example.com', 'a@', 'a b@example.com'])('⑤ 잘못된 주소 %j → e0 · 요청 없음', (value) => {
    const world = run(page);
    world.el('email').value = value;
    submit(world);
    expect(world.fetches).toEqual([]);
    expect(visible(world, LOGIN_MESSAGES)).toEqual(['e0']);
    // 칸 오류(비평 R7-20): 틀린 칸에 aria-invalid + 칸 바로 아래 메시지를 가리키는 aria-describedby · 포커스 · 입력하면 해제.
    const em = world.el('email');
    expect([em.attrs.get('aria-invalid'), em.attrs.get('aria-describedby')]).toEqual(['true', 'e0']);
    expect(em.focused).toBe(1);
    for (const fn of em.listeners['input'] ?? []) fn({ preventDefault: () => undefined });
    expect(visible(world, LOGIN_MESSAGES)).toEqual([]);
    expect(em.attrs.has('aria-invalid')).toBe(false);
  });

  it('⑥ 보내는 중에는 다시 보내지 않는다(버튼 busy · 중복 제출 없음)', () => {
    const world = run(page);
    world.el('email').value = 'owner@example.com';
    submit(world);
    submit(world);
    expect(world.fetches).toHaveLength(1);
    expect(world.el('go').classes.has('busy')).toBe(true);
  });

  it('⑦ 마크업 — 칸 오류는 칸 바로 뒤, 연결·속도 오류는 버튼 아래', () => {
    expect(page.html).toMatch(/<input type="email" id="email"[^>]*><\/label><p class="msg" id="e0"/);
    expect(page.html).toMatch(/id="go"[^>]*>[^<]*<\/button><\/div><p class="msg" id="e1"/);
  });
});

describe.each(LANGS)('가입 %s — 스크립트 동작', (lang) => {
  const page = renderSignupPage(lang);
  const fill = (world: World, overrides: { email?: string; org?: string; consent?: boolean } = {}): void => {
    world.el('email').value = overrides.email ?? 'new-owner@example.com';
    world.el('org').value = overrides.org ?? 'Acme 연구소';
    world.el('consent').checked = overrides.consent ?? true;
  };

  it('① 제출 → 콘솔 `/api/signup` · 본문 {email, organizationName, consent:true} · credentials include', () => {
    const world = run(page);
    fill(world);
    submit(world);
    expect(world.fetches).toHaveLength(1);
    expect(world.fetches[0]?.url).toBe('https://console.atmark.ai/api/signup');
    expect(world.fetches[0]?.init).toMatchObject({
      method: 'POST',
      mode: 'cors',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      redirect: 'error',
    });
    expect(JSON.parse(world.fetches[0]?.init.body ?? 'null')).toEqual({ email: 'new-owner@example.com', organizationName: 'Acme 연구소', consent: true, lang });
  });

  it.each([
    [202, null],
    [429, 'e2'],
    [400, 'e5'],
    [403, 'e1'],
    [500, 'e1'],
  ] as const)('② %i → %s', async (status, shown) => {
    const world = run(page);
    fill(world);
    submit(world);
    world.fetches[0]?.resolve({ ok: status === 202, status });
    await settle();
    expect(visible(world, SIGNUP_MESSAGES)).toEqual(shown === null ? [] : [shown]);
    expect(world.el('sent').hidden).toBe(shown !== null);
    if (shown === null) expect([world.el('email').value, world.el('org').value, world.el('consent').checked]).toEqual(['', '', false]);
  });

  it('③ 화면 검사 — 주소 e0 · 이름(빈 값·81자·보이지 않는 문자) e3 · 동의 없음 e4 · 모두 요청 없음', () => {
    const cases: ReadonlyArray<readonly [Parameters<typeof fill>[1], string]> = [
      [{ email: 'x@y' }, 'e0'],
      [{ org: '   ' }, 'e3'],
      [{ org: 'a'.repeat(81) }, 'e3'],
      [{ org: 'Acme​corp' }, 'e3'],
      [{ org: 'Acme‮corp' }, 'e3'],
      [{ consent: false }, 'e4'],
    ];
    for (const [overrides, shown] of cases) {
      const world = run(page);
      fill(world, overrides);
      submit(world);
      expect(world.fetches, JSON.stringify(overrides)).toEqual([]);
      expect(visible(world, SIGNUP_MESSAGES), JSON.stringify(overrides)).toEqual([shown]);
      // 틀린 칸 하나에만 aria-invalid + aria-describedby(비평 R7-20), 그 칸에 포커스.
      const field = ({ e0: 'email', e3: 'org', e4: 'consent' } as const)[shown as 'e0' | 'e3' | 'e4'];
      for (const id of ['email', 'org', 'consent']) {
        const el = world.el(id);
        expect(el.attrs.get('aria-invalid'), `${id} ${JSON.stringify(overrides)}`).toBe(id === field ? 'true' : undefined);
        expect(el.attrs.get('aria-describedby')).toBe(id === field ? shown : undefined);
      }
      expect(world.el(field).focused).toBe(1);
    }
    // 마크업: 칸 오류는 각 칸 바로 뒤, 서버·연결 오류(e5·e1·e2·e6)는 버튼 아래.
    expect(page.html).toMatch(/<input type="email" id="email"[^>]*><\/label><p class="msg" id="e0"/);
    expect(page.html).toMatch(/<input type="text" id="org"[^>]*><\/label><p class="msg" id="e3"/);
    expect(page.html).toMatch(/id="consent"[\s\S]*?<\/label><p class="msg" id="e4"/);
    expect(page.html).toMatch(/id="go"[^>]*>[^<]*<\/button><\/div><p class="msg" id="e5"/);
  });

  it('④ fetch 거부 → e6 (검증 F11 — 스로틀 429 는 CORS 헤더가 없어 거부로 보인다)', async () => {
    const world = run(page);
    fill(world);
    submit(world);
    world.fetches[0]?.reject(new TypeError('Failed to fetch'));
    await settle();
    expect(visible(world, SIGNUP_MESSAGES)).toEqual(['e6']);
    expect(page.html).toContain(SIGNUP_COPY[lang]['e6'] ?? '∅');
  });
});

describe('스크립트·마크업 규율', () => {
  it('① 두 언어가 같은 스크립트(문구 없음 — 같은 해시) · HTML 에 박힌 것이 ASCII 화한 원문 그대로', () => {
    for (const [render, source] of [
      [renderLoginPage, LOGIN_SCRIPT],
      [renderSignupPage, SIGNUP_SCRIPT],
    ] as const) {
      expect(scriptOf(render('ko'))).toBe(scriptOf(render('en')));
      expect(scriptOf(render('ko'))).toBe(asciiScript(source));
      expect(render('ko').csp).toContain(`'sha256-${createHash('sha256').update(scriptOf(render('ko')), 'utf8').digest('base64')}'`);
    }
  });

  it('①-힌트 — 머리 힌트 스크립트(2026-09-30)가 페이지마다 한 번 · <head> 안 · 해시가 CSP 의 첫 script-src · 로그인 화면만 data-hint="go"', () => {
    const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64');
    const hint = asciiScript(SESSION_HINT_SCRIPT);
    for (const lang of LANGS) {
      for (const [page, go] of [
        [renderLoginPage(lang), true],
        [renderSignupPage(lang), false],
      ] as const) {
        const scripts = executedScripts(page);
        expect(scripts).toHaveLength(2);
        expect(scripts[0]).toBe(hint);
        expect(scripts[1]).not.toBe(hint);
        expect(page.html.split(`<script>${hint}</script>`)).toHaveLength(2);
        expect(page.html.indexOf(`<script>${hint}</script>`)).toBeLessThan(page.html.indexOf('</head>'));
        expect(page.csp).toContain(`script-src 'sha256-${sha(hint)}' 'sha256-${sha(scripts[1] ?? '')}';`);
        expect(page.html.startsWith(`<!doctype html><html lang="${lang}"${go ? ' data-hint="go"' : ''}><head>`)).toBe(true);
      }
    }
    // 힌트는 문구가 없다 — 콘솔 힌트 API 한 곳에 묻고, 옮겨 가는 곳은 콘솔 상수 하나.
    expect(hint.match(/https?:\/\/[^'"\s]+/g)).toEqual([`${CONSOLE_ORIGIN}/api/session/hint`, CONSOLE_APP_URLS.app]);
    expect(hint).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|document\.cookie/);
  });

  it('② 위험한 싱크·동적 코드·다른 URL 없음 — fetch 는 콘솔 API 둘(요청 · 코드 verify) · 이동은 콘솔 상수 둘 중 하나로 한 번', () => {
    for (const [script, api, verify] of [
      [LOGIN_SCRIPT, CONSOLE_API.login, CONSOLE_API.loginVerify],
      [SIGNUP_SCRIPT, CONSOLE_API.signup, CONSOLE_API.signupVerify],
    ] as const) {
      // 이동은 `location.replace(<조건>?'<상수>':'<상수>')` 한 곳뿐 — 응답의 경로를 따르지 않는다. 그 한 문장을 걷어 낸 나머지에 `location` 이 없다.
      const navigation = /location\.replace\(j&&\(j\.next==='select-org'\|\|j\.redirect==='\/app#\/select-org'\)\?'([^']+)':'([^']+)'\)/;
      const found = navigation.exec(script);
      expect(found?.slice(1)).toEqual([CONSOLE_APP_URLS.selectOrg, CONSOLE_APP_URLS.app]);
      // 초대 링크의 주소 채우기(202609301520) — `#invite=` fragment 를 읽고 주소창에서 지우는 한 문장(가입 스크립트만). 걷어 낸 뒤 나머지를 본다.
      const prefill = /\(function\(\)\{var m=\/\^#invite=[^\n]*history\.replaceState\(null,'',location\.pathname\);\}\)\(\);/;
      if (script === SIGNUP_SCRIPT) expect(prefill.test(script)).toBe(true);
      const rest = script.replace(navigation, '').replace(prefill, '');
      expect(rest).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setTimeout\(\s*['"]|location|cookie|localStorage|sessionStorage|postMessage/);
      expect(rest.match(/https?:\/\/[^'"\s]+/g)).toEqual([api, verify]);
      expect(script.match(/fetch\(/g)).toHaveLength(2);
      expect(script.match(/credentials:'include'/g)).toHaveLength(2);
    }
  });

  it('③ 스크립트가 찾는 요소가 전부 마크업에 있고, 메시지·완료 패널은 처음에 숨어 있다', () => {
    for (const lang of LANGS) {
      for (const page of [renderLoginPage(lang), renderSignupPage(lang)]) {
        const script = scriptOf(page);
        const ids = new Set([...script.matchAll(/\bg\('([a-z0-9]+)'\)/g), ...script.matchAll(/'(e[0-9])'/g)].map((m) => m[1] ?? ''));
        expect(ids.size).toBeGreaterThan(5);
        for (const id of ids) expect(page.html, id).toContain(`id="${id}"`);
        const world = run(page);
        expect([...world.touched].every((id) => ids.has(id))).toBe(true);
        for (const id of ['sent', 'e0', 'e1', 'e2']) expect(page.html).toMatch(new RegExp(`id="${id}"[^>]*\\shidden[\\s>]`));
      }
    }
  });

  it('④ 문구 — 두 언어 키 집합이 같다 · 한국어는 콘솔 화면 문구 그대로(재사용) · 가입 안내의 에이전트 상한 = 콘솔 상수', () => {
    expect(Object.keys(LOGIN_COPY.en).sort()).toEqual(Object.keys(LOGIN_COPY.ko).sort());
    expect(Object.keys(SIGNUP_COPY.en).sort()).toEqual(Object.keys(SIGNUP_COPY.ko).sort());
    const consoleLogin = renderConsoleLoginPage('ko').html;
    // 처음 보는 화면은 설명 없이(진윤겸 2026-09-27) — lede·꼬리 안내는 두 표면 모두에서 없앴다. 남은 문구는 콘솔과 글자까지 같다.
    for (const key of ['email', 'submit', 'e0', 'e1', 'e2', 'sentTitle', 'sentBody', 'again', 'code', 'codeSubmit', 'c0', 'c1', 'c2', 'c3', 'c4', 'c5']) {
      expect(consoleLogin, key).toContain(LOGIN_COPY.ko[key] ?? '∅');
    }
    const consoleSignup = renderConsoleSignupPage('ko').html;
    // 가입 안내 상자는 굵은 한 줄(`reviewStrong`)만 남았다(비평 R4-05 — 콘솔과 같이 회색 둘째 문단 삭제). 검토 중 에이전트 상한은 `foot` 이 말한다.
    for (const key of ['h1', 'org', 'submit', 'e3', 'e4', 'e5', 'e2', 'sentBody', 'again', 'code', 'codeSubmit', 'c0', 'c1', 'c2', 'c3', 'c4', 'c5']) {
      expect(consoleSignup, key).toContain(SIGNUP_COPY.ko[key] ?? '∅');
    }
    expect(PENDING_ORG_AGENT_LIMIT).toBe(MAX_AGENTS_PER_PENDING_ORG);
  });

  it('⑤ 동의 링크는 이 사이트의 이 언어 약관·안내(새 탭, opener 없음) · 서로 오가는 링크', () => {
    for (const lang of LANGS) {
      const signup = renderSignupPage(lang).html;
      for (const id of ['terms', 'privacy'] as const) {
        expect(signup).toContain(`<a href="${sitePath(lang, id)}" target="_blank" rel="noopener noreferrer">`);
      }
      expect(signup).toContain(`<p class="alt">${SIGNUP_COPY[lang]['altText'] ?? ''} <a href="${sitePath(lang, 'login')}">`);
      // 가입은 초대로만(202609301520) — 로그인 화면의 "처음이신가요?" 는 대기자 명단으로, 가입 화면은 대기자 명단 링크를 하나 더.
      expect(renderLoginPage(lang).html).toContain(`<p class="alt">${LOGIN_COPY[lang]['altText'] ?? ''} <a href="${sitePath(lang, 'waitlist')}">`);
      expect(signup).toContain(`<p class="alt">${SIGNUP_COPY[lang]['waitText'] ?? ''} <a href="${sitePath(lang, 'waitlist')}">`);
    }
  });
});

describe('홈 ↔ 콘솔 상수가 맞는다', () => {
  it('출처·API 경로·언어별 착지 URL', () => {
    expect(ADMIN_SIDE_SITE_ORIGIN).toBe(SITE_ORIGIN);
    expect(CONSOLE_ORIGIN).toBe(ADMIN_ORIGIN);
    expect([...CROSS_SITE_AUTH_PATHS].sort()).toEqual(
      [CONSOLE_API.login, CONSOLE_API.signup, CONSOLE_API.loginVerify, CONSOLE_API.signupVerify, CONSOLE_API.waitlist].map((url) => new URL(url).pathname).sort(),
    );
    expect(CONSOLE_APP_URLS).toEqual({ app: `${ADMIN_ORIGIN}/app`, selectOrg: `${ADMIN_ORIGIN}/app#/select-org` });
    for (const lang of LANGS) {
      expect(SITE_LOGIN_URLS[lang]).toBe(`${SITE_ORIGIN}${sitePath(lang, 'login')}`);
      expect(SITE_SIGNUP_URLS[lang]).toBe(`${SITE_ORIGIN}${sitePath(lang, 'signup')}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 메일의 6자리 코드(2026-09-28) — 보낸 뒤 같은 화면에서 코드를 받아 콘솔 verify 로(교차 출처 · 자격 포함).
// ---------------------------------------------------------------------------

describe.each([
  ['로그인', renderLoginPage, CONSOLE_API.loginVerify, 'login_browser_missing', 'member_limit'],
  ['가입', renderSignupPage, CONSOLE_API.signupVerify, 'signup_browser_missing', 'signup_capacity'],
] as const)('%s — 6자리 코드', (_label, render, verify, missing, conflict) => {
  const submitCode = (world: World): void => {
    for (const fn of world.el('cf').listeners['submit'] ?? []) fn({ preventDefault: () => undefined });
  };
  const json = (body: unknown) => () => Promise.resolve(body);
  const CODE_MESSAGES = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'] as const;

  it.each(LANGS)('마크업(%s) — 보낸 뒤 패널 안의 한 칸 · 숫자 자판 · 코드 자동 채움 · 메시지는 처음에 숨김', (lang) => {
    const html = render(lang).html;
    expect(html.match(/<input [^>]*id="code"[^>]*>/g)).toEqual([
      '<input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required spellcheck="false" autocapitalize="off" autocorrect="off">',
    ]);
    expect(html.indexOf('id="cf"')).toBeGreaterThan(html.indexOf('id="sent"'));
    for (const id of CODE_MESSAGES) expect(html).toMatch(new RegExp(`<p class="msg" id="${id}" role="alert" hidden>`));
    // 칸 오류는 칸 바로 뒤.
    expect(html).toMatch(/autocorrect="off"><\/label><p class="msg" id="c0"/);
  });

  it('보낸 뒤 코드 → 콘솔 verify 절대 URL 로 한 번 · cors · 자격 포함 · content-type 하나 · 본문 {code}(공백·하이픈 뗌) · 200 이면 콘솔 상수로', async () => {
    const world = run(render('ko'));
    world.el('code').value = '1234';
    submitCode(world);
    expect(world.fetches).toHaveLength(0);
    expect(visible(world, CODE_MESSAGES)).toEqual(['c0']);
    expect(world.el('code').attrs.get('aria-invalid')).toBe('true');
    world.el('code').value = '１２３ ４５６';
    submitCode(world);
    submitCode(world);
    expect(world.fetches).toHaveLength(1);
    const call = world.fetches[0];
    expect(call?.url).toBe(verify);
    expect(call?.init).toMatchObject({
      method: 'POST',
      mode: 'cors',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect(Object.keys(call?.init.headers ?? {})).toEqual(['content-type']);
    expect(JSON.parse(call?.init.body ?? '{}')).toEqual({ code: '123456' });
    call?.resolve({ ok: true, status: 200, json: json({ next: 'select-org' }) });
    await settle();
    await settle();
    expect(world.navigated).toEqual([CONSOLE_APP_URLS.selectOrg]);

    const plain = run(render('en'));
    plain.el('code').value = '000111';
    submitCode(plain);
    // 응답의 경로는 따르지 않는다 — 모르는 값이면 상수 /app.
    plain.fetches[0]?.resolve({ ok: true, status: 200, json: json({ redirect: 'https://evil.example/', next: 'x' }) });
    await settle();
    await settle();
    expect(plain.navigated).toEqual([CONSOLE_APP_URLS.app]);
  });

  it('401 은 한 문장(c1) · 스스로 센 5번째 실패 뒤에만 c2(입력 잠금) · 결속 없음 c3 · 409 c5 · 그 밖 c4 · fetch 거부 c6 · 새 요청이면 센 것을 지운다', async () => {
    const world = run(render('ko'));
    const attempt = async (status: number, error: string | null): Promise<void> => {
      world.el('code').value = '000000';
      submitCode(world);
      world.fetches.at(-1)?.resolve({ ok: false, status, json: json(error === null ? null : { error }) });
      await settle();
      await settle();
    };
    for (let i = 1; i <= 4; i += 1) {
      await attempt(401, 'login_code_invalid');
      expect(visible(world, CODE_MESSAGES)).toEqual(['c1']);
      expect(world.el('code').disabled).toBe(false);
    }
    await attempt(401, 'signup_code_invalid');
    expect(visible(world, CODE_MESSAGES)).toEqual(['c2']);
    expect(world.el('code').disabled).toBe(true);
    expect(world.navigated).toEqual([]);

    // 새로 보내면(202) 다시 다섯 번.
    world.el('email').value = 'owner@example.com';
    world.el('org').value = 'Acme';
    world.el('consent').checked = true;
    submit(world);
    world.fetches.at(-1)?.resolve({ ok: true, status: 202 });
    await settle();
    expect(world.el('code').disabled).toBe(false);
    expect(visible(world, CODE_MESSAGES)).toEqual([]);

    for (const [status, error, shown] of [
      [401, missing, 'c3'],
      [409, conflict, 'c5'],
      [429, 'rate_limited', 'c6'],
      [403, 'origin_mismatch', 'c4'],
      [500, null, 'c4'],
    ] as const) {
      await attempt(status, error);
      expect(visible(world, CODE_MESSAGES), `${String(status)} ${String(error)}`).toEqual([shown]);
    }
    world.el('code').value = '000000';
    submitCode(world);
    world.fetches.at(-1)?.reject(new TypeError('Failed to fetch'));
    await settle();
    expect(visible(world, CODE_MESSAGES)).toEqual(['c6']);
    expect(world.navigated).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 대기자 명단(202609301520 · 신청서 202609301530) — 주소 + 용도(필수) + 한 줄 메모 + 알게 된 곳(선택) + ?ref= → 콘솔 `POST /api/waitlist`
// (쿠키 없음 · 늘 202) · 꿀단지 · "먼저 발송" 을 고르면 완료 패널에 보류 안내 · 가입 화면의 초대 주소 채우기.
// ---------------------------------------------------------------------------

const WAITLIST_MESSAGES = ['e0', 'e1', 'e2', 'e6', 'e7', 'e8'] as const;

describe.each(LANGS)('대기자 명단 %s — 스크립트 동작', (lang) => {
  const page = renderWaitlistPage(lang);
  /** 채워진 폼 — 주소 · 용도(기본 alerts). */
  const filled = (useCase: string = 'alerts', globals: Record<string, unknown> = {}): World => {
    const world = run(page, globals);
    world.el('email').value = 'wait@example.com';
    world.el(`uc-${useCase}`).checked = true;
    return world;
  };

  it('① 제출 → 콘솔 절대 URL · cors · 쿠키 없음(omit) · 본문 {email, useCase, ref, lang, note?, heardFrom?} · 꿀단지가 비면 싣지 않는다', () => {
    const world = run(page);
    world.el('email').value = ' Wait@Example.com ';
    world.el('uc-replies').checked = true;
    world.el('note').value = '  고객 문의에 답하는 에이전트 ';
    world.el('heard').value = 'github';
    submit(world);
    expect(world.fetches).toHaveLength(1);
    expect(world.fetches[0]?.url).toBe(CONSOLE_API.waitlist);
    expect(world.fetches[0]?.init).toEqual({
      method: 'POST',
      mode: 'cors',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'Wait@Example.com', useCase: 'replies', ref: 'none', lang, note: '고객 문의에 답하는 에이전트', heardFrom: 'github' }),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    const bot = filled('codes');
    bot.el('email').value = 'bot@example.com';
    bot.el('website').value = 'http://spam.example';
    submit(bot);
    expect(JSON.parse(bot.fetches[0]?.init.body ?? '{}')).toEqual({ email: 'bot@example.com', useCase: 'codes', ref: 'none', lang, website: 'http://spam.example' });
  });

  it('①-ref — 주소창의 ?ref= 값을 그대로 옮긴다(허용목록은 서버가 본다) · 없거나 60자 넘거나 디코딩 실패면 none', () => {
    const refOf = (search: string): unknown => {
      const world = filled('alerts', { location: { search, replace: () => undefined } });
      submit(world);
      return (JSON.parse(world.fetches[0]?.init.body ?? '{}') as { ref?: unknown }).ref;
    };
    expect(refOf('?ref=github')).toBe('github');
    expect(refOf('?hl=en&ref=recipe-alert-routing')).toBe('recipe-alert-routing');
    expect(refOf('?ref=Something%20Else')).toBe('Something Else');
    expect(refOf('')).toBe('none');
    expect(refOf('?ref=')).toBe('none');
    expect(refOf(`?ref=${'x'.repeat(61)}`)).toBe('none');
    expect(refOf('?ref=%E0%A4%A')).toBe('none');
  });

  it('② 202 → 완료 패널(폼 숨김 · 입력 지움) · 다른 주소로 → 폼 · 429 e2 · 400 invalid_note e7 · invalid_use_case e8 · 그 밖 400 e0 · 500 e1 · fetch 거부 e6', async () => {
    const world = filled('alerts');
    world.el('heard').value = 'x';
    submit(world);
    world.fetches[0]?.resolve({ ok: true, status: 202 });
    await settle();
    expect([world.el('done').hidden, world.el('f').hidden, world.el('email').value, world.el('uc-alerts').checked, world.el('heard').value]).toEqual([false, true, '', false, '']);
    // 보류 안내는 "먼저 발송" 을 고른 사람에게만.
    expect(world.el('hold').hidden).toBe(true);
    click(world, 'again');
    expect([world.el('done').hidden, world.el('f').hidden]).toEqual([true, false]);
    const outcomes: [number, unknown, string][] = [
      [429, {}, 'e2'],
      [400, { error: 'invalid_note' }, 'e7'],
      [400, { error: 'invalid_use_case' }, 'e8'],
      [400, { error: 'invalid_heard_from' }, 'e1'],
      [400, { error: 'invalid_email' }, 'e0'],
      [500, {}, 'e1'],
    ];
    for (const [status, body, shown] of outcomes) {
      const w = filled();
      submit(w);
      w.fetches[0]?.resolve({ ok: false, status, json: () => Promise.resolve(body) });
      await settle();
      await settle();
      expect(visible(w, WAITLIST_MESSAGES), `${String(status)} ${JSON.stringify(body)}`).toEqual([shown]);
    }
    const failed = filled();
    submit(failed);
    failed.fetches[0]?.reject(new TypeError('network'));
    await settle();
    expect(visible(failed, WAITLIST_MESSAGES)).toEqual(['e6']);
  });

  it('②-보류 — "먼저 발송"(outreach)을 고르고 202 면 완료 패널에 보류 안내가 함께 선다 · 다른 주소로 → 다시 숨김', async () => {
    const world = filled('outreach');
    submit(world);
    expect(JSON.parse(world.fetches[0]?.init.body ?? '{}')).toMatchObject({ useCase: 'outreach' });
    world.fetches[0]?.resolve({ ok: true, status: 202 });
    await settle();
    expect([world.el('done').hidden, world.el('hold').hidden]).toEqual([false, false]);
    click(world, 'again');
    expect(world.el('hold').hidden).toBe(true);
    // 오류 응답에는 보류 안내가 없다(완료가 아니다).
    const limited = filled('outreach');
    submit(limited);
    limited.fetches[0]?.resolve({ ok: false, status: 429 });
    await settle();
    expect([limited.el('done').hidden, limited.el('hold').hidden]).toEqual([true, true]);
  });

  it('③ 앱 검사 — 주소 모양 e0 · 용도 없음 e8 · 메모 200자 초과·제어 문자 e7(보내지 않는다)', () => {
    for (const [email, useCase, note, shown] of [
      ['not-an-email', 'alerts', '', 'e0'],
      ['wait@example.com', null, '', 'e8'],
      ['wait@example.com', 'alerts', 'x'.repeat(201), 'e7'],
      ['wait@example.com', 'alerts', 'line\u2028break', 'e7'],
    ] as const) {
      const world = run(page);
      world.el('email').value = email;
      if (useCase !== null) world.el(`uc-${useCase}`).checked = true;
      world.el('note').value = note;
      submit(world);
      expect(world.fetches, shown).toHaveLength(0);
      expect(visible(world, WAITLIST_MESSAGES)).toEqual([shown]);
    }
    const missing = run(page);
    missing.el('email').value = 'wait@example.com';
    submit(missing);
    expect(missing.el('uc').attrs.get('aria-invalid')).toBe('true');
    expect(missing.el('uc-alerts').focused).toBe(1);
  });

  it('④ 마크업 — 완료 패널·보류 안내·메시지는 처음에 숨김 · 꿀단지는 화면·보조기술·탭 순서 밖 · 개인정보 처리 안내 링크 · 두 언어 키 집합이 같다', () => {
    for (const id of ['done', 'hold', ...WAITLIST_MESSAGES]) expect(page.html).toMatch(new RegExp(`id="${id}"[^>]*\\shidden[\\s>]`));
    expect(page.html).toContain('<div class="sr" aria-hidden="true"><label for="website">Website</label><input type="text" id="website" name="website" tabindex="-1" autocomplete="off"></div>');
    expect(page.html).toContain(`<a href="${sitePath(lang, 'privacy')}" target="_blank" rel="noopener noreferrer">`);
    expect(page.html).toContain('<input type="text" id="note" name="note" maxlength="200" autocomplete="off"');
    expect(Object.keys(WAITLIST_COPY.en).sort()).toEqual(Object.keys(WAITLIST_COPY.ko).sort());
    // 스크립트가 읽는 주소창은 `location.search`(?ref=) 하나뿐 — 이동·쿠키·저장소는 없다.
    expect(WAITLIST_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|location(?!\.search\b)|cookie|localStorage|sessionStorage|postMessage/);
    expect(WAITLIST_SCRIPT.match(/location/g)).toHaveLength(1);
    expect(WAITLIST_SCRIPT.match(/https?:\/\/[^'"\s]+/g)).toEqual([CONSOLE_API.waitlist]);
  });

  it('④-신청서 — 용도 라디오 넷(반복 수신이 앞 · 필수) · 알게 된 곳 선택(빈 값이 기본) · 값은 DB CHECK 와 같다 · 보류 안내의 문서 링크', () => {
    expect(WAITLIST_USE_CASE_KEYS.map(([value]) => value)).toEqual([...WAITLIST_USE_CASES]);
    expect(WAITLIST_USE_CASES).toEqual(['alerts', 'replies', 'codes', 'outreach']);
    expect(WAITLIST_HEARD_FROM_KEYS.map(([value]) => value)).toEqual([...WAITLIST_HEARD_FROM]);
    const radios = [...page.html.matchAll(/<input type="radio" id="uc-([a-z]+)" name="use_case" value="([a-z]+)" required>/g)].map((m) => [m[1], m[2]]);
    expect(radios).toEqual(WAITLIST_USE_CASES.map((v) => [v, v]));
    const c = WAITLIST_COPY[lang];
    const labels = WAITLIST_USE_CASE_KEYS.map(([, key]) => c[key] ?? '');
    let at = 0;
    for (const label of labels) {
      const next = page.html.indexOf(label, at);
      expect(next, label).toBeGreaterThan(at);
      at = next;
    }
    expect(page.html).toMatch(/<select id="heard" name="heard_from"><option value="">[^<]+<\/option><option value="directory">/);
    // 보류 안내 — 문서 "Atmark가 맞지 않는 용도"(한국어는 접두어 없음 · 영어는 /en) · 메일 템플릿의 링크와 같다.
    expect(waitlistNotForUrl(lang)).toBe(lang === 'en' ? 'https://docs.atmark.ai/en/get-started/not-for' : 'https://docs.atmark.ai/get-started/not-for');
    expect(waitlistNotForUrl(lang)).toBe(WAITLIST_NOT_FOR_URLS[lang]);
    expect(page.html).toMatch(new RegExp(`<p class="muted" id="hold" hidden>[^<]+ <a href="${waitlistNotForUrl(lang)}" target="_blank" rel="noopener noreferrer">`));
    expect(c['hold']).toContain(lang === 'ko' ? '고객 도메인이 준비될 때까지 초대하지 않습니다' : 'until custom domains are ready');
  });
});

describe('가입 화면 — 초대 링크의 주소 채우기(#invite=<base64url>)', () => {
  const invite = (fragment: string) => {
    const replaced: string[] = [];
    const world = run(renderSignupPage('en'), {
      location: { hash: fragment, pathname: '/signup', replace: () => undefined },
      history: { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
      atob: (b: string) => Buffer.from(b, 'base64').toString('binary'),
    });
    return { world, replaced };
  };

  it('주소 모양이면 채우고 조직 이름 칸으로 · 어느 경우든 fragment 는 주소창에서 지운다', () => {
    const ok = invite(`#invite=${Buffer.from('invited@example.com').toString('base64url')}`);
    expect(ok.world.el('email').value).toBe('invited@example.com');
    expect(ok.world.el('org').focused).toBe(1);
    expect(ok.replaced).toEqual(['/signup']);
    const junk = invite(`#invite=${Buffer.from('<script>').toString('base64url')}`);
    expect(junk.world.el('email').value).toBe('');
    expect(junk.replaced).toEqual(['/signup']);
    const none = invite('#other');
    expect(none.world.el('email').value).toBe('');
    expect(none.replaced).toEqual([]);
  });
});
