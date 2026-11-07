/**
 * 콘솔(`src/admin/ui`) 다크 모드(US-014) — 토큰 두 벌 · 하드코딩 색 없음 · WCAG AA 대비 · 설정의 테마 전환(시스템·라이트·다크).
 *
 * 테마 전환은 **가짜 DOM 위에서 실제 스크립트를 돌려** 본다(`console-harness.ts` — 머리의 테마 부트와 앱 스크립트가 같은 전역에서
 * 문서 순서대로 돈다). 저장은 localStorage 한 키(`THEME_STORAGE_KEY`), 적용은 `<html data-theme>`.
 * 브랜드는 완전 무채색이다(2026-09-29) — `@` 도 글자색이라 주황 예외는 없다.
 */

import vm from 'node:vm';

import { afterEach, describe, expect, it } from 'vitest';

import { renderAppPage, renderLoginLandingPage, renderLoginPage, renderSignupLandingPage, renderSignupPage } from '../../../src/admin/ui/index';
import { MESSAGES } from '../../../src/admin/ui/i18n';
import { THEME_BOOT_JS, THEME_STORAGE_KEY } from '../../../src/admin/ui/page';
import { ADMIN_UI_CSS, CONSOLE_DARK, CONSOLE_LIGHT } from '../../../src/admin/ui/styles';
import { contrast, ratios, resolve, themeBlocks, usedTokens, type Pair } from '../../support/theme-contrast';
import { boot, inlined, OVERRIDE } from './console-harness';

afterEach(() => OVERRIDE.clear());

const T = themeBlocks(ADMIN_UI_CSS);

const PAIRS: readonly Pair[] = [
  { label: '주 글자 / 바탕', fg: 'gray-1000', bg: 'background-100', min: 4.5 },
  { label: '주 글자 / 사이드바·표 머리·카드 푸터', fg: 'gray-1000', bg: 'background-200', min: 4.5 },
  { label: '주 글자 / 떠 있는 면(메뉴·ⓘ·대화상자·서랍)', fg: 'gray-1000', bg: 'background-raised', min: 4.5 },
  { label: '주 글자 / 칩·배지·코드(gray-100)', fg: 'gray-1000', bg: 'gray-100', min: 4.5 },
  { label: '주 글자 / 선택·빗금(gray-300)', fg: 'gray-1000', bg: 'gray-300', min: 4.5 },
  { label: '보조 글자 / 바탕', fg: 'gray-900', bg: 'background-100', min: 4.5 },
  { label: '보조 글자 / 사이드바·표 머리', fg: 'gray-900', bg: 'background-200', min: 4.5 },
  { label: '보조 글자 / 떠 있는 면', fg: 'gray-900', bg: 'background-raised', min: 4.5 },
  { label: '보조 글자 / 칩·세그먼트(gray-100)', fg: 'gray-900', bg: 'gray-100', min: 4.5 },
  { label: '보조 글자 / 선택·빗금(gray-300)', fg: 'gray-900', bg: 'gray-300', min: 4.5 },
  { label: 'primary 버튼·선택 채움 글자 / 채움(gray-700)', fg: 'background-100', bg: 'gray-700', min: 4.5 },
  { label: 'primary 버튼 글자 / hover(gray-800)', fg: 'background-100', bg: 'gray-800', min: 4.5 },
  { label: '조작부 경계(입력·체크·스위치·보조 버튼) / 바탕', fg: 'gray-600', bg: 'background-100', min: 3 },
  { label: '조작부 경계 / 사이드바', fg: 'gray-600', bg: 'background-200', min: 3 },
  { label: '조작부 경계 / 떠 있는 면', fg: 'gray-600', bg: 'background-raised', min: 3 },
  { label: '조작부 경계 / gray-100', fg: 'gray-600', bg: 'gray-100', min: 3 },
  { label: '스위치 꺼짐 트랙 윤곽 / gray-200', fg: 'gray-600', bg: 'gray-200', min: 3 },
  // 의미 색 빨강(되돌릴 수 없는 동작·오류 전용, 2026-09-27)
  { label: '빨간 글자(위험 버튼·오류 문구) / 바탕', fg: 'red-700', bg: 'background-100', min: 4.5 },
  { label: '빨간 글자 / 떠 있는 면(⋯ 메뉴 폐기·대화상자 머리)', fg: 'red-700', bg: 'background-raised', min: 4.5 },
  { label: '빨간 글자 / 옅은 빨간 면', fg: 'red-700', bg: 'red-100', min: 4.5 },
  { label: '흰 글자 / 빨간 채움(확인 대화상자 실행 버튼)', fg: 'on-red', bg: 'red-solid', min: 4.5 },
  { label: '빨간 테두리(위험 버튼·위험 카드·오류 입력) / 바탕', fg: 'red-700', bg: 'background-100', min: 3 },
  { label: '포커스 링 / 바탕', fg: 'focus-ring', bg: 'background-100', min: 3 },
];

describe('토큰 두 벌', () => {
  it('① 밝은·어두운 벌이 같은 이름 집합, 시스템 다크 = 명시 다크, `color-scheme` 이 따라간다', () => {
    expect([...T.light.keys()].sort()).toEqual([...T.systemDark.keys()].sort());
    expect([...T.systemDark.entries()]).toEqual([...T.forcedDark.entries()]);
    expect(Object.fromEntries(T.light)).toEqual(CONSOLE_LIGHT);
    expect(Object.fromEntries(T.systemDark)).toEqual(CONSOLE_DARK);
    expect(T.schemes).toEqual(['light', 'dark', 'dark']);
    expect(ADMIN_UI_CSS).toContain('@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){');
  });

  it('② CSS가 쓰는 토큰은 전부 정의돼 있고, 정의한 토큰은 전부 쓰인다', () => {
    // 규칙 안에서 정의하는 지역 변수(콘솔 ID 카드의 `--pad`)는 색 토큰이 아니다.
    const local = new Set([...T.rest.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1] ?? ''));
    const used = new Set([...usedTokens(T.rest)].filter((t) => !local.has(t)));
    expect([...used].filter((t) => !T.light.has(t))).toEqual([]);
    expect([...T.light.keys()].filter((t) => !used.has(t))).toEqual([]);
  });

  it('③ 토큰 블록 밖에 하드코딩 색이 없다 — 주황도 없다(그림자·배경막·SVG 칠·마스크 포함)', () => {
    const hexes = [...T.rest.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
    expect(hexes).toEqual([]);
    expect(T.rest).not.toMatch(/f97316|orange/i);
    expect(T.rest).not.toMatch(/rgba?\(|hsla?\(|(?<![-\w])(white|black)(?![-\w])/i);
    // 신원 카드 그림(v4)의 칠·선 — 전부 카드 토큰이라 테마와 키 hue 를 같이 따른다.
    for (const cls of ['k', 'm', 'disc']) expect(T.rest).toMatch(new RegExp(`\\.idc-svg \\.${cls}\\{fill:var\\(--id-[a-z0-9]+\\)\\}`));
    expect(T.rest).toContain('.idc-svg .rl{fill:none;stroke:var(--id-line)');
  });

  it('④ 앱 마크업·스크립트의 인라인 SVG에 색 속성이 없다 — 아이콘은 currentColor, 그림은 클래스(토큰)', () => {
    for (const lang of ['ko', 'en'] as const) {
      const html = inlined(renderAppPage(lang)).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
      expect(html).not.toMatch(/\b(fill|stroke|stop-color)\s*[=:]\s*['"]?#/i);
      expect(html).not.toMatch(/['"](fill|stroke)['"]\s*:/);
    }
    expect(ADMIN_UI_CSS).toContain('stroke:currentColor');
  });

  it('⑤ 다크 — 짙은 회색 바탕(#1B1B1B — 시각 언어 전환 §8) · 흰 글자(순검정·순백 아님) · 떠 있는 면이 한 단 뜬다', () => {
    const paper = resolve(T.systemDark, 'background-100');
    const ink = resolve(T.systemDark, 'gray-1000');
    expect(contrast(paper, '#000000')).toBeLessThan(1.3);
    expect(paper).not.toBe('#000000');
    expect(contrast(ink, '#FFFFFF')).toBeLessThan(1.3);
    expect(ink).not.toBe('#FFFFFF');
    expect(contrast(resolve(T.systemDark, 'background-raised'), paper)).toBeGreaterThan(1.02);
  });
});

describe('대비 — WCAG AA', () => {
  it.each([
    ['밝은 벌', T.light],
    ['어두운 벌', T.systemDark],
  ] as const)('⑥ %s — 글자 ≥ 4.5:1 · 테두리·배지 ≥ 기준', (_name, tokens) => {
    for (const r of ratios(tokens, PAIRS)) expect(r.ratio, `${r.label} ${r.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(r.min);
  });

  it('⑦ `@` 는 글자색 — `.at` 은 색 규칙이 없고, 주 글자색은 바탕 위 ≥ 4.5:1(위 PAIRS)', () => {
    expect(ADMIN_UI_CSS).not.toMatch(/\.at\s*\{/);
    expect(ADMIN_UI_CSS).not.toMatch(/f97316|orange/i);
  });
});

describe('테마 부트 스크립트 — 첫 칠 전에 `data-theme`', () => {
  const PAGES = [renderLoginPage, renderLoginLandingPage, renderAppPage, renderSignupPage, renderSignupLandingPage];

  it('⑧ 모든 콘솔 페이지가 `<head>` 의 스타일 앞에 같은 부트 스크립트를 싣고, `color-scheme: light dark` 를 알린다', () => {
    for (const render of PAGES) {
      for (const lang of ['ko', 'en'] as const) {
        const { html } = render(lang);
        const at = html.indexOf(`<script>${THEME_BOOT_JS}</script>`);
        expect(at).toBeGreaterThan(-1);
        // 스타일은 머리의 스타일시트 자산 하나(`<link rel="stylesheet">`) — 부트가 그보다 먼저다.
        expect(at).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
        expect(html.indexOf('<link rel="stylesheet"')).toBeLessThan(html.indexOf('</head>'));
        expect(html).toContain('<meta name="color-scheme" content="light dark">');
      }
    }
    expect(THEME_BOOT_JS).toMatch(/^[\x20-\x7e]*$/);
    expect(THEME_BOOT_JS).toContain(`'${THEME_STORAGE_KEY}'`);
  });

  /** 부트 스크립트 하나만 — `<html>` 의 속성과 저장소를 흉내 낸다. */
  function runBoot(stored: string | null | 'throw'): string | null {
    const attrs = new Map<string, string>();
    const localStorage = {
      getItem: (k: string) => {
        if (stored === 'throw') throw new Error('SecurityError');
        return k === THEME_STORAGE_KEY ? stored : null;
      },
    };
    const document = { documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) } };
    vm.runInContext(THEME_BOOT_JS, vm.createContext({ localStorage, document }));
    return attrs.get('data-theme') ?? null;
  }

  it('⑨ 저장된 light·dark만 적고, 없거나 엉뚱한 값·저장소 차단이면 아무것도 안 한다(= 시스템)', () => {
    expect(runBoot('dark')).toBe('dark');
    expect(runBoot('light')).toBe('light');
    expect(runBoot(null)).toBeNull();
    expect(runBoot('system')).toBeNull();
    expect(runBoot('"><script>')).toBeNull();
    expect(runBoot('throw')).toBeNull();
  });
});

describe('설정의 테마 전환 — 시스템 · 라이트 · 다크', () => {
  const pressed = (w: Awaited<ReturnType<typeof boot>>): string[] =>
    ['system', 'light', 'dark'].filter((k) => w.el(`th-${k}`).getAttribute('aria-checked') === 'true');

  it('⑩ 처음엔 시스템 — `data-theme` 없음 · 시스템 버튼이 눌려 있다', async () => {
    const w = await boot('ko', '#/settings/display');
    expect(w.root.getAttribute('data-theme')).toBeNull();
    expect(pressed(w)).toEqual(['system']);
    expect(w.storage?.has(THEME_STORAGE_KEY)).toBe(false); // 테마는 저장하지 않는다(조직 기억 키는 세션 만료 복원용 — 리뷰 M2)
  });

  it('⑪ 다크를 누르면 저장하고 `<html data-theme="dark">` · 라이트 → light · 시스템 → 키를 지우고 속성도 뗀다', async () => {
    const w = await boot('ko', '#/settings/display');
    w.el('th-dark').dispatch('click');
    expect(w.storage?.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(w.root.getAttribute('data-theme')).toBe('dark');
    expect(pressed(w)).toEqual(['dark']);
    w.el('th-light').dispatch('click');
    expect(w.storage?.get(THEME_STORAGE_KEY)).toBe('light');
    expect(w.root.getAttribute('data-theme')).toBe('light');
    expect(pressed(w)).toEqual(['light']);
    w.el('th-system').dispatch('click');
    expect(w.storage?.has(THEME_STORAGE_KEY)).toBe(false);
    expect(w.root.getAttribute('data-theme')).toBeNull();
    expect(pressed(w)).toEqual(['system']);
  });

  it('⑫ 다시 열면 저장된 테마 — 부트 스크립트가 먼저 적고, 앱은 그 버튼을 눌린 채로 그린다', async () => {
    const storage = new Map([[THEME_STORAGE_KEY, 'dark']]);
    const w = await boot('en', '#/settings/display', { storage });
    expect(w.root.getAttribute('data-theme')).toBe('dark');
    expect(pressed(w)).toEqual(['dark']);
  });

  it('⑬ 엉뚱한 저장값은 시스템으로 읽는다 · 저장소가 막혀도 부팅되고 이 탭에서는 전환이 먹는다', async () => {
    const odd = await boot('ko', '#/settings/display', { storage: new Map([[THEME_STORAGE_KEY, 'sepia']]) });
    expect(odd.root.getAttribute('data-theme')).toBeNull();
    expect(pressed(odd)).toEqual(['system']);
    const blocked = await boot('ko', '#/settings/display', { storage: null });
    expect(pressed(blocked)).toEqual(['system']);
    blocked.el('th-dark').dispatch('click');
    expect(blocked.root.getAttribute('data-theme')).toBe('dark');
    expect(pressed(blocked)).toEqual(['dark']);
  });

  it('⑭ 다른 탭에서 바꾸면(storage 이벤트)이 탭도 따라간다', async () => {
    const w = await boot('ko', '#/overview');
    w.storage?.set(THEME_STORAGE_KEY, 'light');
    w.win('storage', { key: THEME_STORAGE_KEY });
    expect(w.root.getAttribute('data-theme')).toBe('light');
    w.storage?.set(THEME_STORAGE_KEY, 'dark');
    w.win('storage', { key: 'unrelated' });
    expect(w.root.getAttribute('data-theme')).toBe('light');
  });

  it('⑮ 문구 — 한국어 시스템·라이트·다크 / 영어 System·Light·Dark (사전 1:1)', () => {
    const ko = inlined(renderAppPage('ko'));
    const en = inlined(renderAppPage('en'));
    expect(ko).toContain('<span class="lbl" id="th-l">테마</span><div class="seg" role="radiogroup" aria-labelledby="th-l"><button type="button" role="radio" id="th-system" aria-checked="true" tabindex="0">시스템</button><button type="button" role="radio" id="th-light" aria-checked="false" tabindex="-1">라이트</button><button type="button" role="radio" id="th-dark" aria-checked="false" tabindex="-1">다크</button></div>');
    expect(en).toContain('<span class="lbl" id="th-l">Theme</span><div class="seg" role="radiogroup" aria-labelledby="th-l"><button type="button" role="radio" id="th-system" aria-checked="true" tabindex="0">System</button><button type="button" role="radio" id="th-light" aria-checked="false" tabindex="-1">Light</button><button type="button" role="radio" id="th-dark" aria-checked="false" tabindex="-1">Dark</button></div>');
    for (const key of ['테마', '이 브라우저에 저장됩니다.', '시스템', '라이트', '다크']) {
      expect(MESSAGES.ko[key]).toBe(key);
      expect(MESSAGES.en[key]).toBeDefined();
    }
  });
});
