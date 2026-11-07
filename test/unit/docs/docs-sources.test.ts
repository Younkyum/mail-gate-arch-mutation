/**
 * 문서가 **옮겨 적은 값**이 원천과 같은지 — 문서 번들은 홈·MCP·인프라 코드를 import 하지 않으므로(번들 경계) 값을 복사하고 여기서 대조한다.
 *   - MCP 도구 이름(`src/mcp/tools.ts` `MCP_TOOLS`) · 요금제 한도 표(카탈로그·가격 페이지 행/이름) · 홈과 같은 상수·팔레트 · 인프라 도메인.
 *   - 팔레트 대비(WCAG AA — 홈 `site-theme.test.ts` 와 같은 기준) · 색 규칙(무채색 + danger 뿐, 주황·파랑 0).
 */

import { describe, expect, it } from 'vitest';

import { DOCS_DOMAIN_NAME } from '../../../infra/cdk/stacks/docs-stack';
import { PLAN_CATALOG, PLAN_CODES } from '../../../src/billing/plans';
import { CONSOLE_URL, DOCS_HOST, DOCS_ORIGIN, HOME_ORIGIN, SUPPORT_EMAIL } from '../../../src/docs/constants';
import { DOCS_MCP_TOOL_NAMES } from '../../../src/docs/mcp-tools';
import { DOCS_GROUPS, DOCS_TABS, GROUP_LABELS, TAB_GROUPS, TAB_LABELS } from '../../../src/docs/nav';
import { DOCS_LIMIT_ROWS, docsLimitCell, LIMIT_LABELS, planLimitsHtml, planLimitsMarkdown, visibleLimitRows } from '../../../src/docs/plan-limits';
import { DOCS_CSS, DOCS_DARK, DOCS_LIGHT } from '../../../src/docs/styles';
import { MCP_TOOLS } from '../../../src/mcp/tools';
import { CONSOLE_ORIGIN, CONTACT_EMAIL, DOCS_ORIGIN as SITE_DOCS_ORIGIN, KO_PREFIX, LEGACY_EN_PREFIX, SITE_ORIGIN } from '../../../src/site/constants';
import { limitCell, PRICING_COPY, PRICING_LIMIT_ROWS } from '../../../src/site/pricing';
import { SITE_DARK, SITE_LIGHT } from '../../../src/site/styles';
import { ratios, themeBlocks, type Pair } from '../../support/theme-contrast';

describe('옮겨 적은 값', () => {
  it('MCP 도구 이름 — 제품의 도구 표와 순서까지 같다', () => {
    expect(DOCS_MCP_TOOL_NAMES).toEqual(MCP_TOOLS.map((t) => t.name));
  });

  it('상수 — 홈·콘솔 출처 · 문의 주소 · 문서 호스트(홈의 링크 · 인프라 도메인)', () => {
    expect(HOME_ORIGIN).toBe(SITE_ORIGIN);
    expect(CONSOLE_URL).toBe(CONSOLE_ORIGIN);
    expect(SUPPORT_EMAIL).toBe(CONTACT_EMAIL);
    expect(DOCS_ORIGIN).toBe(SITE_DOCS_ORIGIN);
    expect(DOCS_HOST).toBe(DOCS_DOMAIN_NAME);
  });

  it('팔레트 — 홈과 같은 값(밝게·어둡게)', () => {
    expect(DOCS_LIGHT).toEqual(SITE_LIGHT);
    expect(DOCS_DARK).toEqual(SITE_DARK);
  });

  it('요금제 한도 표 — 가격 페이지와 같은 행·이름·칸 글자, 숫자는 카탈로그 그대로', () => {
    expect(DOCS_LIMIT_ROWS).toEqual(PRICING_LIMIT_ROWS);
    for (const lang of ['ko', 'en'] as const) {
      for (const key of DOCS_LIMIT_ROWS) expect(LIMIT_LABELS[lang][key], `${lang}.${key}`).toBe(PRICING_COPY[lang][key]);
      expect(LIMIT_LABELS[lang]['limitCol']).toBe(PRICING_COPY[lang]['limitCol']);
    }
    for (const key of DOCS_LIMIT_ROWS) for (const p of PLAN_CODES) expect(docsLimitCell(key, PLAN_CATALOG[p][key])).toBe(limitCell(key, PLAN_CATALOG[p][key]));
    const html = planLimitsHtml('ko');
    for (const key of visibleLimitRows()) {
      expect(html).toContain(`<tr><th scope="row">${LIMIT_LABELS.ko[key] ?? ''}</th>${PLAN_CODES.map((p) => `<td>${docsLimitCell(key, PLAN_CATALOG[p][key])}</td>`).join('')}</tr>`);
    }
  });

  it('문서 플래그가 꺼진 기능(별칭·첨부)의 행은 표에 없다', () => {
    const html = planLimitsHtml('en', { aliases: false, attachments: false, customDomains: false, sdkPublished: false });
    expect(html).not.toContain(LIMIT_LABELS.en['aliasesPerAgentMax']);
    expect(html).not.toContain(LIMIT_LABELS.en['attachmentBytesTotalMax']);
    expect(visibleLimitRows({ aliases: true, attachments: true, customDomains: true, sdkPublished: true })).toEqual([...DOCS_LIMIT_ROWS]);
  });

  it('한도 표의 가격 링크 — 영어 /pricing · 한국어 KO_PREFIX/pricing(옛 /en 301 경로가 아니다)', () => {
    const en = `${SITE_ORIGIN}/pricing`;
    const ko = `${SITE_ORIGIN}${KO_PREFIX}/pricing`;
    expect(planLimitsHtml('en')).toContain(`href="${en}"`);
    expect(planLimitsHtml('ko')).toContain(`href="${ko}"`);
    expect(planLimitsMarkdown('en').endsWith(` ${en}`)).toBe(true);
    expect(planLimitsMarkdown('ko').endsWith(` ${ko}`)).toBe(true);
    for (const lang of ['en', 'ko'] as const) expect(planLimitsHtml(lang) + planLimitsMarkdown(lang)).not.toContain(`${LEGACY_EN_PREFIX}/pricing`);
  });
});

describe('뼈대', () => {
  it('모든 그룹은 정확히 한 탭에 있다 · 이름이 두 언어에 있다', () => {
    const inTabs = DOCS_TABS.flatMap((t) => TAB_GROUPS[t]);
    expect([...inTabs].sort()).toEqual([...DOCS_GROUPS].sort());
    expect(new Set(inTabs).size).toBe(inTabs.length);
    for (const lang of ['ko', 'en'] as const) {
      for (const g of DOCS_GROUPS) expect(GROUP_LABELS[lang][g]).not.toBe('');
      for (const t of DOCS_TABS) expect(TAB_LABELS[lang][t]).not.toBe('');
    }
  });
});

describe('테마 · 색', () => {
  const T = themeBlocks(DOCS_CSS);
  const PAIRS: readonly Pair[] = [
    { label: '본문 / 바탕', fg: 'gray-1000', bg: 'background-100', min: 4.5 },
    { label: '본문 / 표 머리·교대 면', fg: 'gray-1000', bg: 'background-200', min: 4.5 },
    { label: '본문 / 코드 블록·현재 항목', fg: 'gray-1000', bg: 'gray-100', min: 4.5 },
    { label: '본문 / 검색 대화상자', fg: 'gray-1000', bg: 'background-raised', min: 4.5 },
    { label: '보조 글자 / 바탕', fg: 'gray-900', bg: 'background-100', min: 4.5 },
    { label: '보조 글자 / 코드 블록 머리', fg: 'gray-900', bg: 'gray-100', min: 4.5 },
    { label: '보조 글자 / 표 머리', fg: 'gray-900', bg: 'background-200', min: 4.5 },
    { label: '단계 번호 / 검은 원', fg: 'background-100', bg: 'gray-1000', min: 4.5 },
    { label: '주 버튼 글자 / 채움', fg: 'background-100', bg: 'gray-700', min: 4.5 },
    { label: '위험 콜아웃 제목 / 바탕', fg: 'danger', bg: 'background-100', min: 4.5 },
    { label: '조작부 경계(검색 버튼) / 바탕', fg: 'gray-600', bg: 'background-100', min: 3 },
    { label: '포커스 링 / 바탕', fg: 'focus-ring', bg: 'background-100', min: 3 },
  ];

  it('밝게·어둡게(시스템·명시) 모두 WCAG AA', () => {
    for (const [name, tokens] of [
      ['light', T.light],
      ['dark', T.systemDark],
      ['explicit dark', T.forcedDark],
    ] as const) {
      const bad = ratios(tokens, PAIRS).filter((r) => r.ratio < r.min);
      expect(bad, name).toEqual([]);
    }
  });

  it('색은 토큰으로만 — 토큰 블록 밖 16진 색은 없다(주황 0) · 파랑·보라 0 · 그라디언트는 공용 빗금 토큰뿐', () => {
    const tokenBlocks = DOCS_CSS.replace(/:root(\[[^\]]*\])?(:not\([^)]*\))?\{[^}]*\}/g, '');
    const hexes = [...tokenBlocks.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)].map((m) => m[0].toUpperCase());
    expect(hexes).toEqual([]);
    expect(DOCS_CSS).not.toMatch(/#F97316|orange/i);
    const all = [...Object.values(DOCS_LIGHT), ...Object.values(DOCS_DARK)].filter((v) => v.startsWith('#'));
    for (const hex of all) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      if (hex !== DOCS_LIGHT['danger'] && hex !== DOCS_DARK['danger']) expect(r === g && g === b, hex).toBe(true);
    }
    // 그라디언트는 공용 비색상 토큰(`--hatch-*`)의 정의뿐 — 문서 규칙이 쓰지 않는다.
    expect(DOCS_CSS.replace(/--hatch-[a-z]+:[^;]+;/g, '')).not.toMatch(/gradient/);
  });
});
