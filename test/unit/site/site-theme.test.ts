/**
 * 홈(`src/site`) 다크 모드(US-014) — 토큰 두 벌 · 하드코딩 색 없음 · 시스템 설정만 따름(스크립트 없음) · WCAG AA 대비.
 *
 * 대비는 **렌더되는 CSS 문자열**의 토큰 값에서 잰다(`test/support/theme-contrast.ts`). 기준: 본문 글자 ≥ 4.5:1, 큰 글자·UI 테두리 ≥ 3:1.
 * 완전 흑백(진윤겸 2026-09-29) — `@` 의 주황도 폐지돼 토큰 블록 밖에는 색 값이 하나도 없다. 사진 위 유리 카드·글자(`glass`·`photo-*`)는
 * 반투명 값이라 대비를 수로 잴 수 없다 — 유리의 불투명도 하한과 사진 위 글자가 순백인지를 따로 단언한다(⑥).
 */

import { describe, expect, it } from 'vitest';

import {
  renderHomePage,
  renderLoginPage,
  renderNotFoundPage,
  renderPricingPage,
  renderPrivacyPage,
  renderRefundPage,
  renderSignupPage,
  renderTermsPage,
} from '../../../src/site/index';
import { asciiScript } from '../../../src/site/page';
import { SESSION_HINT_SCRIPT } from '../../../src/site/session-hint';
import { SITE_CSS, SITE_DARK, SITE_LIGHT } from '../../../src/site/styles';
import { contrast, ratios, resolve, themeBlocks, usedTokens, type Pair } from '../../support/theme-contrast';

const T = themeBlocks(SITE_CSS);

/** 대비 짝 — 실제로 겹쳐 그려지는 조합(선택자는 `styles.ts`). 에디토리얼 명세 `.omc/plans/landing-editorial.md` §2 의 표. */
const PAIRS: readonly Pair[] = [
  { label: '주 글자 / 바탕', fg: 'gray-1000', bg: 'background-100', min: 4.5 },
  { label: '주 글자 / 교대 면(.tint·표 머리·표본 캡션)', fg: 'gray-1000', bg: 'background-200', min: 4.5 },
  { label: '주 글자 / 떠 있는 면(모바일 메뉴 패널)', fg: 'gray-1000', bg: 'background-raised', min: 4.5 },
  { label: '주 글자 / 채움(칩·배지·.note·.toc)', fg: 'gray-1000', bg: 'gray-100', min: 4.5 },
  { label: '주 글자 / 눌림 채움(.btn.ghost:active)', fg: 'gray-1000', bg: 'gray-200', min: 4.5 },
  { label: '주 글자 / 빗금 짝(.pill.bad)', fg: 'gray-1000', bg: 'gray-300', min: 4.5 },
  { label: '보조 글자 / 바탕', fg: 'gray-900', bg: 'background-100', min: 4.5 },
  { label: '보조 글자 / 교대 면', fg: 'gray-900', bg: 'background-200', min: 4.5 },
  { label: '보조 글자 / 떠 있는 면', fg: 'gray-900', bg: 'background-raised', min: 4.5 },
  { label: '보조 글자 / 채움(비활성 버튼 글자 포함)', fg: 'gray-900', bg: 'gray-100', min: 4.5 },
  { label: 'primary 버튼 글자 / 채움', fg: 'background-100', bg: 'gray-700', min: 4.5 },
  { label: 'primary 버튼 글자 / hover 채움', fg: 'background-100', bg: 'gray-800', min: 4.5 },
  { label: '조작부 경계(보조 버튼·입력·교차점) / 바탕', fg: 'gray-600', bg: 'background-100', min: 3 },
  { label: '조작부 경계 / 교대 면', fg: 'gray-600', bg: 'background-200', min: 3 },
  { label: '조작부 경계 / 떠 있는 면', fg: 'gray-600', bg: 'background-raised', min: 3 },
  { label: '조작부 경계 / 채움', fg: 'gray-600', bg: 'gray-100', min: 3 },
  { label: '포커스 링 / 바탕', fg: 'focus-ring', bg: 'background-100', min: 3 },
  { label: '빗금 선 위를 지나는 글자(.pill.bad · 판정 줄)', fg: 'gray-1000', bg: 'gray-500', min: 4.5 },
  { label: '폼 오류 글자 / 바탕', fg: 'danger', bg: 'background-100', min: 4.5 },
  { label: '폼 오류 글자 / 교대 면', fg: 'danger', bg: 'background-200', min: 4.5 },
  { label: '폼 오류 테두리 / 바탕', fg: 'danger', bg: 'background-100', min: 3 },
  { label: 'ID 카드 뒷면 글자', fg: 'inv-fg', bg: 'inv-bg', min: 4.5 },
  { label: 'ID 카드 뒷면 강조(키·JSON)', fg: 'inv-strong', bg: 'inv-bg', min: 4.5 },
  { label: 'ID 카드 뒷면 보조(라벨·비공개 배지)', fg: 'inv-muted', bg: 'inv-bg', min: 4.5 },
  { label: '어두운 패널 코드 알약 글자(.proof .pc)', fg: 'inv-strong', bg: 'inv-line', min: 4.5 },
];

describe('토큰 두 벌', () => {
  it('① 밝은·어두운 벌이 같은 이름 집합이고, 시스템 다크와 명시 다크(`data-theme="dark"`)가 같은 값이다', () => {
    expect([...T.light.keys()].sort()).toEqual([...T.systemDark.keys()].sort());
    expect([...T.systemDark.entries()]).toEqual([...T.forcedDark.entries()]);
    expect(Object.fromEntries(T.light)).toEqual(SITE_LIGHT);
    expect(Object.fromEntries(T.systemDark)).toEqual(SITE_DARK);
    expect(T.schemes).toEqual(['light', 'dark', 'dark']);
    // 명시 라이트는 시스템 다크를 이긴다 — 미디어 쿼리 블록이 `:not([data-theme="light"])` 로 걸린다.
    expect(SITE_CSS).toContain('@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){');
  });

  it('② CSS 가 쓰는 토큰은 전부 정의돼 있고, 정의한 토큰은 전부 쓰인다', () => {
    // 규칙 안에서 정의하는 지역 변수(비색상 토큰 블록 `--font-sans`·`--radius-*`… · 사이트 헤더 높이 `--header-h`)는 색 토큰이 아니다.
    const local = new Set([...T.rest.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1] ?? ''));
    const used = new Set([...usedTokens(T.rest)].filter((t) => !local.has(t)));
    expect([...used].filter((t) => !T.light.has(t))).toEqual([]);
    expect([...T.light.keys()].filter((t) => !used.has(t))).toEqual([]);
  });

  it('③ 토큰 블록 밖에 하드코딩 색이 없다 — 주황 `@` 도 없다(`.at` 에 색 규칙 없음)', () => {
    const hexes = [...T.rest.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
    expect(hexes).toEqual([]);
    expect(T.rest).not.toMatch(/\.at\{[^}]*color/);
    expect(SITE_CSS).not.toMatch(/f97316/i);
    expect(T.rest).not.toMatch(/rgba?\(|hsla?\(|(?<![-\w])(white|black)(?![-\w])/i);
  });

  it('④ 다크는 뒤집힌 흑백 — 거의 검정 바탕 · 흰 글자(순검정·순백은 아니다) · 떠 있는 면은 바탕보다 한 단 뜬다', () => {
    const paper = resolve(T.systemDark, 'background-100');
    const ink = resolve(T.systemDark, 'gray-1000');
    expect(contrast(paper, '#000000')).toBeLessThan(1.2);
    expect(paper).not.toBe('#000000');
    expect(contrast(ink, '#FFFFFF')).toBeLessThan(1.3);
    expect(ink).not.toBe('#FFFFFF');
    expect(contrast(resolve(T.systemDark, 'background-raised'), paper)).toBeGreaterThan(1.02);
    // ID 카드 뒷면 — 밝은 벌에서는 검은 면이라 바탕과 확실히 갈리고(≥3:1), 다크에서는 뒤집지 않고 한 단 떠 있는 어두운 면이다
    // (비평 R1-11, 리드 판정 2026-09-27 — 밝게 뒤집으면 검은 페이지에서 h1 보다 튄다). 다크의 윤곽은 1px 선(`inv-line`)이 맡는다(랜딩 v2 — 그림자 대신 선).
    expect(contrast(resolve(T.light, 'inv-bg'), resolve(T.light, 'background-100'))).toBeGreaterThanOrEqual(3);
    const invDark = resolve(T.systemDark, 'inv-bg');
    expect(contrast(invDark, paper)).toBeGreaterThan(1.05);
    expect(contrast(invDark, '#000000')).toBeLessThan(1.5);
    expect(SITE_CSS).toMatch(/\.idc\.back\{[^}]*box-shadow:inset 0 0 0 1px var\(--inv-line\)/);
    expect(contrast(resolve(T.systemDark, 'inv-line'), invDark)).toBeGreaterThan(1.2);
  });
});

describe('대비 — WCAG AA', () => {
  it.each([
    ['밝은 벌', T.light],
    ['어두운 벌', T.systemDark],
  ] as const)('⑤ %s — 글자 ≥ 4.5:1 · 테두리·큰 글자 ≥ 3:1', (_name, tokens) => {
    for (const r of ratios(tokens, PAIRS)) expect(r.ratio, `${r.label} ${r.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(r.min);
  });

  it.each([
    ['밝은 벌', T.light],
    ['어두운 벌', T.systemDark],
  ] as const)('⑥ %s — 사진 위 글자는 순백 · 가독성 막은 검정 ≥ 50% · 유리 카드는 불투명도 ≥ 80%(카드 글자는 본문 토큰)', (_name, tokens) => {
    const alpha = (v: string): number => Number(/^rgba\(\d+,\d+,\d+,([\d.]+)\)$/.exec(v)?.[1] ?? 'NaN');
    expect(resolve(tokens, 'photo-ink')).toBe('#FFFFFF');
    expect(tokens.get('photo-scrim')).toMatch(/^rgba\(0,0,0,/);
    expect(alpha(tokens.get('photo-scrim') ?? '')).toBeGreaterThanOrEqual(0.5);
    expect(alpha(tokens.get('glass') ?? '')).toBeGreaterThanOrEqual(0.8);
    expect(SITE_CSS).toMatch(/\.glass\{[^}]*background:var\(--glass\)[^}]*color:var\(--gray-1000\)/);
  });
});

describe('홈은 시스템 설정만 따른다 — 테마 스크립트 없음', () => {
  const pages = (['ko', 'en'] as const).flatMap((lang) =>
    [renderHomePage, renderPricingPage, renderPrivacyPage, renderTermsPage, renderRefundPage, renderLoginPage, renderSignupPage, renderNotFoundPage].map((r) =>
      r(lang),
    ),
  );

  it('⑦ 모든 페이지가 `color-scheme: light dark` 를 알리고, 테마 때문에 생긴 스크립트·저장소 접근이 없다', () => {
    for (const page of pages) {
      expect(page.html).toContain('<meta name="color-scheme" content="light dark">');
      expect(page.html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')).not.toMatch(/data-theme|localStorage|matchMedia/);
    }
    // 2026-09-30 — 모든 페이지가 머리 힌트 스크립트(`session-hint.ts` — 로그인 여부로 머리의 콘솔 버튼만 바꾼다) 하나를 싣는다. 테마와는
    // 무관하다: `data-theme`·`localStorage`·`matchMedia`·`color-scheme` 을 만지지 않는다(탭 수명의 `sessionStorage` 로그인 표시만 — 의도).
    // 홈의 `<script>` 는 JSON-LD 데이터 블록 하나(SEO — 실행되지 않는다, site-pages ③)와 그 힌트 하나, 정확히 둘이다.
    const hint = asciiScript(SESSION_HINT_SCRIPT);
    expect(hint).not.toMatch(/data-theme|localStorage|matchMedia|color-scheme|prefers-color-scheme|\.theme\b/);
    expect(hint).toContain('sessionStorage');
    for (const lang of ['ko', 'en'] as const) {
      const html = renderHomePage(lang).html;
      expect(html.match(/<script\b[^>]*>/gi)).toEqual(['<script type="application/ld+json">', '<script>']);
      expect(html.split(`<script>${hint}</script>`)).toHaveLength(2);
      expect(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '').replace(`<script>${hint}</script>`, '')).not.toMatch(/<script\b/i);
    }
  });

  it('⑧ 인라인 SVG(공개키 지문 막대)에 색 속성이 없다 — 칠은 토큰으로(`.fp rect{fill:var(--inv-strong)}`)', () => {
    for (const lang of ['ko', 'en'] as const) {
      const svg = /<svg class="fp"[\s\S]*?<\/svg>/.exec(renderHomePage(lang).html)?.[0] ?? '';
      expect(svg).not.toBe('');
      expect(svg).not.toMatch(/\b(fill|stroke|color|stop-color)=/i);
    }
    expect(SITE_CSS).toContain('.fp rect{fill:var(--inv-strong)}');
  });
});
