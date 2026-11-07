/**
 * 로고(`src/ui/brand.ts` — 로고 05 "Continuity", 2026-09-30): 도형 수치가 원본 경로와 같고, 점-도형 판정이 그 도형을 그대로 따르며, 그림은
 * 무채색(`currentColor`)·이름 있는 그림이다. 그리고 **모든 표면이 이 한 원천을 쓴다** — 홈 머리·꼬리·신원 카드 · 결제 · 콘솔(로그인·가입·초대 ·
 * 상단 바 · 서랍 · 신원 카드) · 문서 머리·꼬리 · 운영 콘솔 · OG 틀 · 파비콘. 옛 `@mark` 글자 로고는 어디에도 없다.
 */
import { describe, expect, it } from 'vitest';

import { ogHtml } from '../../../scripts/gen-images';
import { renderAppPage, renderInvitePage, renderLoginPage, renderSignupPage } from '../../../src/admin/ui/index';
import { SIDEBAR, TOP_BAR } from '../../../src/admin/ui/console/markup/shell';
import { handleDocsRequest } from '../../../src/docs/http';
import { buildOpsPage, HOSTED_PAGE_CONFIG, LOCAL_PAGE_CONFIG } from '../../../src/ops/console/page';
import { renderHomePage, renderPrivacyPage } from '../../../src/site/index';
import { buildPayInfoPage } from '../../../src/site/pay';
import {
  BRAND_LOCKUP_RATIO,
  BRAND_LOCKUP_SVG,
  BRAND_LOCKUP_VIEWBOX,
  BRAND_SYMBOL_GEOMETRY,
  BRAND_SYMBOL_PATHS,
  BRAND_SYMBOL_SVG,
  BRAND_SYMBOL_VIEWBOX,
  brandLockupSvg,
  brandSymbolSvg,
  inBrandSymbol,
} from '../../../src/ui/brand';
import { FAVICON_SVG } from '../../../src/ui/favicon';

/** 원본 파일(`05-continuity-symbol.svg`)의 두 경로 — 글자 그대로. */
const ORIGINAL_RINGS = 'M128 24A104 104 0 1 0 232 128H200A72 72 0 1 1 128 56ZM128 88A40 40 0 1 0 168 128H140A12 12 0 1 1 128 116Z';
const ORIGINAL_BRACKET = 'M160 24H232V96H200V56H160Z';

/** 모든 표면이 싣는 도형 지문 — 심볼 고리 경로(가로 조합·심볼 모두에 들어 있다). */
const FINGERPRINT = `d="${ORIGINAL_RINGS}"`;
const LOCKUP_MARK = `viewBox="${BRAND_LOCKUP_VIEWBOX}"`;
const SYMBOL_MARK = `viewBox="${BRAND_SYMBOL_VIEWBOX}"`;

describe('로고 도형', () => {
  it('경로는 원본 그대로 · 수치(중심·고리 반경·L 직사각형)가 경로와 같다', () => {
    expect(BRAND_SYMBOL_PATHS.rings).toBe(ORIGINAL_RINGS);
    expect(BRAND_SYMBOL_PATHS.bracket).toBe(ORIGINAL_BRACKET);
    const { center, outer, inner, bracket } = BRAND_SYMBOL_GEOMETRY;
    // 고리: 위 끝(center, center - r_out) → 오른쪽 끝(center + r_out, center), 안쪽 호 반경 r_in.
    for (const [rIn, rOut] of [outer, inner]) {
      expect(ORIGINAL_RINGS).toContain(`M${String(center)} ${String(center - rOut)}A${String(rOut)} ${String(rOut)} 0 1 0 ${String(center + rOut)} ${String(center)}`);
      expect(ORIGINAL_RINGS).toContain(`H${String(center + rIn)}A${String(rIn)} ${String(rIn)} 0 1 1 ${String(center)} ${String(center - rIn)}Z`);
    }
    // L 괄호 = 위 막대 [160,232]×[24,56] ∪ 오른쪽 막대 [200,232]×[24,96].
    expect(bracket).toEqual([
      [160, 24, 232, 56],
      [200, 24, 232, 96],
    ]);
  });

  it('점-도형 판정 — 고리 띠 안 · 오른쪽 위 사분면은 비고 · L 괄호는 칠해진다', () => {
    expect(inBrandSymbol(128 - 88, 128)).toBe(true); // 바깥 고리 왼쪽
    expect(inBrandSymbol(128, 128 + 88)).toBe(true); // 바깥 고리 아래
    expect(inBrandSymbol(128 - 26, 128)).toBe(true); // 안쪽 고리 왼쪽
    expect(inBrandSymbol(128, 128)).toBe(false); // 가운데 구멍
    expect(inBrandSymbol(128 - 56, 128)).toBe(false); // 두 고리 사이
    expect(inBrandSymbol(128 + 50, 128 - 50)).toBe(false); // 오른쪽 위 사분면(고리가 열린 자리)
    expect(inBrandSymbol(128 + 60, 128 + 60)).toBe(true); // 오른쪽 아래 — 바깥 고리
    expect(inBrandSymbol(180, 40)).toBe(true); // L 위 막대
    expect(inBrandSymbol(216, 80)).toBe(true); // L 오른쪽 막대
    expect(inBrandSymbol(180, 80)).toBe(false); // L 안쪽 모서리 빈칸
    expect(inBrandSymbol(20, 20)).toBe(false);
  });
});

describe('로고 그림', () => {
  it('currentColor 하나 · 색 값 없음 · 이름 있는 그림(role=img · aria-label · <title>) · 외부 참조 없음', () => {
    for (const svg of [BRAND_LOCKUP_SVG, BRAND_SYMBOL_SVG]) {
      expect(svg).toContain('<g fill="currentColor">');
      expect(svg).toContain('role="img" aria-label="Atmark"');
      expect(svg).toContain('<title>Atmark</title>');
      expect(svg).toContain(FINGERPRINT);
      expect(svg).toContain(`d="${ORIGINAL_BRACKET}"`);
      expect(svg).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(|<text|<image|href=|url\(|<script|style=/i);
    }
    expect(BRAND_LOCKUP_SVG).toContain(LOCKUP_MARK);
    expect(BRAND_SYMBOL_SVG).toContain(SYMBOL_MARK);
    // 워드마크 여섯 글자(a·t·m·a·r·k) — 글꼴이 아니라 도형.
    expect(BRAND_LOCKUP_SVG.match(/<path fill-rule="evenodd"/g)).toHaveLength(1 + 6);
  });

  it('장식 모양 · 높이 속성(폭은 비율로)', () => {
    const deco = brandSymbolSvg({ decorative: true });
    expect(deco).toContain('aria-hidden="true"');
    expect(deco).not.toMatch(/role=|aria-label=|<title>/);
    expect(brandLockupSvg({ height: 20 })).toContain(`width="${String(Math.round(20 * BRAND_LOCKUP_RATIO * 100) / 100)}" height="20"`);
    expect(brandSymbolSvg({ height: 20, className: 'x' })).toMatch(/^<svg class="x" viewBox="24 24 208 208" width="20" height="20"/);
  });
});

describe('모든 표면이 같은 로고를 쓴다', () => {
  const docsHtml = (path: string): string => {
    const r = handleDocsRequest({ rawPath: path, headers: { host: 'docs.atmark.ai' }, requestContext: { http: { method: 'GET' } } });
    return r.isBase64Encoded === true ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
  };

  const surfaces: readonly (readonly [string, string, string])[] = [
    ['홈(ko)', renderHomePage('ko').html, LOCKUP_MARK],
    ['홈(en)', renderHomePage('en').html, LOCKUP_MARK],
    ['개인정보(en)', renderPrivacyPage('en').html, LOCKUP_MARK],
    ['결제 안내', buildPayInfoPage('ko').html, LOCKUP_MARK],
    ['콘솔 로그인', renderLoginPage('ko').html, LOCKUP_MARK],
    ['콘솔 가입', renderSignupPage('en').html, LOCKUP_MARK],
    ['콘솔 초대', renderInvitePage('ko').html, LOCKUP_MARK],
    ['콘솔 앱', renderAppPage('en').html, LOCKUP_MARK],
    ['콘솔 상단 바(가로 조합)', TOP_BAR, LOCKUP_MARK],
    ['콘솔 상단 바(레일 — 심볼)', TOP_BAR, SYMBOL_MARK],
    ['콘솔 서랍 머리', SIDEBAR, LOCKUP_MARK],
    ['문서(ko)', docsHtml('/'), LOCKUP_MARK],
    ['문서(en)', docsHtml('/en'), LOCKUP_MARK],
    ['운영 콘솔(로컬)', buildOpsPage(LOCAL_PAGE_CONFIG).html, LOCKUP_MARK],
    ['운영 콘솔(호스팅)', buildOpsPage(HOSTED_PAGE_CONFIG).html, LOCKUP_MARK],
    ['OG 틀(ko)', ogHtml('ko'), LOCKUP_MARK],
    ['파비콘 SVG', FAVICON_SVG, SYMBOL_MARK],
  ];

  it.each(surfaces)('%s', (_name, html, mark) => {
    expect(html).toContain(FINGERPRINT);
    expect(html).toContain(mark);
    // 옛 글자 로고(`@mark` — `.at` 로 감싼 `@` 바로 뒤 "mark")는 사라졌다. 주소의 `@atmark.ai` 는 타이포그래피라 그대로 남는다.
    expect(html).not.toMatch(/<span class="at">@<\/span>mark/);
  });

  it('홈 머리·꼬리는 링크 안의 가로 조합(링크가 이름을 가진다)', () => {
    const html = renderHomePage('en').html;
    const head = /<header class="top">[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
    const foot = /<footer class="foot">[\s\S]*<\/footer>/.exec(html)?.[0] ?? '';
    for (const part of [head, foot]) expect(part).toMatch(new RegExp(`<a class="logo" href="/" aria-label="[^"]+"><svg class="brand" ${LOCKUP_MARK}`));
  });
});
