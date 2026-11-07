/**
 * 관리 화면 세 페이지(`src/admin/ui`) — CSP·정화·스타일 규율을 **렌더된 HTML 에서** 단언한다.
 *
 * 이 저장소식 "초록인데 안 지킨다" 의 이 화면판은 **해시 불일치**다: 스크립트가 한 글자 바뀌었는데 CSP 해시가 옛
 * 것이면, 운영 브라우저는 스크립트를 조용히 실행하지 않는다(화면은 뜨는데 아무것도 안 된다). 그래서 해시는 모듈이
 * 알려 주는 값을 믿지 않고, **HTML 을 다시 파싱해 인라인 블록마다 직접 잰다.** 검사기 자체가 공허하지 않은지도
 * 단언한다(한 글자 바꾼 페이지를 넣으면 거부해야 한다).
 *
 * 되돌려서 빨개지는지 확인한 것(2026-09-23): ① `buildPage` 가 HTML 에 스크립트를 한 글자 바꿔 싣고 해시는 그대로 → ②가
 * 세 페이지 모두 빨강 ② `.logo` 에 `#F97316`(지금은 주황 자체가 금지) → ⑦ ③ 포커스 링을 파랑으로 → ⑥ ④ `client-sanitize.ts` 의 INV 에서
 * `\u202a-\u202e` 를 빼면 → ⑨·⑩ ⑤ 로그인 스크립트가 404 에 다른 문구 → ⑯ ⑥ `textContent` 를 `innerHTML` 로 → ⑤.
 */

import { FAVICON_LINK } from '../../../src/ui/favicon';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  renderAppPage,
  renderInvitePage,
  renderLoginLandingPage,
  renderLoginPage,
  renderSignupLandingPage,
  renderSignupPage,
  type AdminUiPage,
  type Lang,
} from '../../../src/admin/ui/index';
import { MAX_AGENTS_PER_PENDING_ORG } from '../../../src/admin/ops/agents';
import { isValidOrganizationName } from '../../../src/admin/session';
import { CLIENT_SANITIZE_JS } from '../../../src/admin/ui/client-sanitize';
import { asciiScript, LOGO, THEME_BOOT_JS } from '../../../src/admin/ui/page';
import { ADMIN_UI_CSS, CONSOLE_DARK, CONSOLE_LIGHT } from '../../../src/admin/ui/styles';
import { SITE_ORIGIN } from '../../../src/site/constants';
import { ADMIN_ORIGIN } from '../../../src/admin/http';
import { sanitizeDisplayText } from '../../../src/notify/approval-notification-template';

import { assetBody, CSP_ASSET_URL, inlined, SCRIPT_TAG, STYLESHEET_TAG } from './console-harness';

const RENDERERS: ReadonlyArray<readonly [string, (lang?: Lang) => AdminUiPage]> = [
  ['login', renderLoginPage],
  ['landing', renderLoginLandingPage],
  ['app', renderAppPage],
  ['signup', renderSignupPage],
  ['signup-landing', renderSignupLandingPage],
  ['invite', renderInvitePage],
];
/** 모든 페이지 × 두 언어(signup-contract.md §8) — 한국어 벌과 영어 벌은 HTML·스크립트가 달라 해시도 따로다. */
const PAGES: ReadonlyArray<readonly [string, () => AdminUiPage]> = RENDERERS.flatMap(([name, render]) => [
  [name, () => render('ko')] as const,
  [`${name}:en`, () => render('en')] as const,
]);

/** 페이지별로 허용되는 절대 URL(호스트까지) — 표시만 하는 MCP 엔드포인트 · 가입 화면의 약관·개인정보 안내 링크. */
const ALLOWED_ABSOLUTE: Readonly<Record<string, readonly string[]>> = {
  // 조직 키 CI 표면(`https://console.atmark.ai/org-api/v1`, P1 §3.7)은 조직 키 창·예시에 **표시만** 한다(fetch 대상이 아니다).
  app: ['https://api.atmark.ai', 'https://console.atmark.ai'],
  signup: ['https://atmark.ai'],
};

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64');

function blocks(html: string, tag: 'script' | 'style'): string[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1] ?? '');
}

function directive(csp: string, name: string): string[] {
  const part = csp
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name} `));
  return part === undefined ? [] : part.split(/\s+/).slice(1);
}

/**
 * CSP 의 `script-src`·`style-src` 가 페이지가 실제로 싣는 것과 정확히 같은가. 문제 목록(빈 배열 = 통과).
 *   - 인라인 블록마다 그 해시(`'sha256-…'`)가 있어야 한다.
 *   - 외부 자산(`<script src>`·`<link rel="stylesheet">`)마다 그 **정확한 URL**(콘솔 출처 + 경로)이 있어야 하고, 자산 본문의 SRI 가
 *     태그의 `integrity` 와 맞아야 한다(`assetBody` 가 본문에서 직접 잰다 — 모듈이 알려 준 값을 믿지 않는다).
 *   - CSP 에 쓰이지 않는 소스가 남으면 안 된다.
 */
function sourceProblems(page: AdminUiPage): string[] {
  const problems: string[] = [];
  const external = {
    script: [...page.html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"[^>]*\bintegrity="([^"]*)"[^>]*>/gi)],
    style: [...page.html.matchAll(/<link rel="stylesheet"[^>]*\bhref="([^"]*)"[^>]*\bintegrity="([^"]*)"[^>]*>/gi)],
  };
  for (const [tag, name] of [
    ['script', 'script-src'],
    ['style', 'style-src'],
  ] as const) {
    const allowed = directive(page.csp, name);
    const inline = blocks(page.html, tag).filter((b) => b !== '');
    const needed = [...new Set([...inline.map((b) => `'sha256-${sha(b)}'`), ...external[tag].map((m) => `${ADMIN_ORIGIN}${m[1] ?? ''}`)])];
    for (const m of external[tag]) {
      try {
        assetBody(m[1] ?? '', m[2] ?? '');
      } catch (error) {
        problems.push(`${name}: ${(error as Error).message}`);
      }
    }
    for (const source of needed) if (!allowed.includes(source)) problems.push(`${name}에 ${source} 없음`);
    for (const source of allowed) if (!needed.includes(source)) problems.push(`${name}에 쓰이지 않는 ${source}`);
  }
  return problems;
}

/** 스크립트·스타일 블록을 뺀 마크업. */
function markup(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

describe.each(PAGES)('%s 페이지 — CSP', (name, render) => {
  const page = render();
  /** 자산(스타일시트·페이지 스크립트)을 되돌려 끼운 HTML — 스크립트·스타일 **내용**을 보는 단언은 이것을 본다. */
  const full = inlined(page);

  it('① 모양 `{html, csp}` 와 닫힌 CSP', () => {
    expect(typeof page.html).toBe('string');
    expect(page.html.startsWith('<!doctype html>')).toBe(true);
    expect(directive(page.csp, 'default-src')).toEqual(["'none'"]);
    expect(directive(page.csp, 'connect-src')).toEqual(["'self'"]);
    // 자체 호스팅 Pretendard 는 사이트 출처에서만(리뷰 M4 — `https://atmark.ai/_fonts/…`). 그 정확한 출처 하나.
    expect(directive(page.csp, 'font-src')).toEqual([SITE_ORIGIN]);
    // 이미지는 파비콘 하나(콘솔 v5 — Firefox 는 파비콘에도 CSP 를 건다) — 같은 오리진 'self' 만. 페이지에 <img> 는 없다(③).
    expect(directive(page.csp, 'img-src')).toEqual(["'self'"]);
    expect(directive(page.csp, 'form-action')).toEqual(["'none'"]);
    expect(directive(page.csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(page.csp, 'base-uri')).toEqual(["'none'"]);
    expect(directive(page.csp, 'require-trusted-types-for')).toEqual(["'script'"]);
    // 스크립트 = 인라인 부트 해시 하나 + 자기 출처의 정확한 자산 URL 하나 · 스타일 = 정확한 자산 URL 하나('self'·경로 접두어 아님).
    expect(directive(page.csp, 'script-src')).toEqual([`'sha256-${sha(THEME_BOOT_JS)}'`, expect.stringMatching(/^https:\/\/console\.atmark\.ai\/_assets\/[0-9a-f]{16}\/page\.js$/)]);
    expect(directive(page.csp, 'style-src')).toEqual([expect.stringMatching(/^https:\/\/console\.atmark\.ai\/_assets\/[0-9a-f]{16}\/console\.css$/)]);
    // 외부 출처는 font-src 의 그 사이트 출처와 콘솔 자기 자산 URL 둘뿐 — 그것을 뺀 나머지에는 https?: 가 없다.
    expect(page.csp.match(CSP_ASSET_URL)).toHaveLength(2);
    expect(page.csp.replace(`font-src ${SITE_ORIGIN};`, '').replace(CSP_ASSET_URL, '')).not.toMatch(/unsafe-|https?:|\*|data:|blob:|nonce-|strict-dynamic/);
    expect(page.csp.split(SITE_ORIGIN)).toHaveLength(2);
  });

  it('② 인라인은 테마 부트 하나(해시) · 스타일시트·페이지 스크립트는 같은 출처 자산(정확한 URL + SRI) — CSP 와 정확히 맞다', () => {
    // 인라인 스크립트는 머리의 테마 부트(첫 칠 전에 `data-theme` 을 적는다, US-014) 하나 — 본문 끝의 페이지 스크립트는 자산이라 본문이 비었다.
    expect(blocks(page.html, 'script')).toEqual([THEME_BOOT_JS, '']);
    expect(blocks(page.html, 'style')).toEqual([]);
    expect(page.html.match(STYLESHEET_TAG)).toHaveLength(1);
    expect(page.html.match(SCRIPT_TAG)).toHaveLength(1);
    const boot = page.html.indexOf(`<script>${THEME_BOOT_JS}</script>`);
    const sheet = page.html.indexOf('<link rel="stylesheet"');
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(sheet);
    expect(sheet).toBeLessThan(page.html.indexOf('</head>'));
    expect(page.html).toMatch(new RegExp(`${SCRIPT_TAG.source}</body></html>$`));
    expect(sourceProblems(page)).toEqual([]);
    // 자산을 되돌려 끼우면 예전 모양(인라인 스크립트 둘 · 스타일 하나) 그대로다.
    expect(blocks(full, 'script')).toHaveLength(2);
    expect(blocks(full, 'style')).toHaveLength(1);
  });

  it('②-검사기 — 인라인을 한 글자 바꾸거나, 자산 경로·SRI 를 바꾸고 CSP 를 안 고치면 잡는다', () => {
    const tamperedBoot = { html: page.html.replace(`<script>${THEME_BOOT_JS}</script>`, `<script>${THEME_BOOT_JS} </script>`), csp: page.csp };
    expect(sourceProblems(tamperedBoot).length).toBeGreaterThan(0);
    const scriptPath = /<script src="([^"]+)"/.exec(page.html)?.[1] ?? '∅';
    const sheetPath = /<link rel="stylesheet" href="([^"]+)"/.exec(page.html)?.[1] ?? '∅';
    // 다른 자산(스타일시트 경로)을 스크립트로 — 그 URL 은 script-src 에 없다.
    const swapped = { html: page.html.replace(`<script src="${scriptPath}"`, `<script src="${sheetPath}"`), csp: page.csp };
    expect(sourceProblems(swapped).length).toBeGreaterThan(0);
    // SRI 한 글자 — 본문과 맞지 않는다.
    const badSri = { html: page.html.replace(/(<link rel="stylesheet"[^>]*integrity="sha384-)(.)/, (_m, head: string, c: string) => `${head}${c === 'A' ? 'B' : 'A'}`), csp: page.csp };
    expect(sourceProblems(badSri).length).toBeGreaterThan(0);
    // CSP 에 남는 소스(예전 스타일 해시) — 쓰이지 않는 소스도 잡는다.
    const extra = { html: page.html, csp: page.csp.replace('style-src ', `style-src 'sha256-${sha('x')}' `) };
    expect(sourceProblems(extra).length).toBeGreaterThan(0);
  });

  it('③ CSP가 막아 "조용히 안 먹는" 마크업이 없다 — style/on* 속성·다른 외부 스크립트·외부 리소스', () => {
    const m = markup(page.html);
    expect(m).not.toMatch(/\sstyle\s*=/i);
    expect(m).not.toMatch(/\son[a-z]+\s*=/i);
    // 외부 스크립트는 같은 출처의 페이지 스크립트 자산 하나(모양 고정 — 경로 `/_assets/<16 hex>/page.js` · integrity 필수).
    expect(page.html.match(/<script\b[^>]*\bsrc\s*=/gi)).toHaveLength(1);
    expect(page.html.match(SCRIPT_TAG)).toHaveLength(1);
    // <link> 는 파비콘 한 줄(콘솔 v5)과 스타일시트 자산 한 줄뿐 — 그 밖의 link·img·iframe… 없음.
    expect(m.split(FAVICON_LINK)).toHaveLength(2);
    expect(m.match(STYLESHEET_TAG)).toHaveLength(1);
    expect(m.replace(FAVICON_LINK, '').replace(STYLESHEET_TAG, '')).not.toMatch(/<(link|img|iframe|object|embed|base|meta\s+http-equiv)\b/i);
    expect(m).not.toMatch(/javascript:/i);
  });

  it('④ 스크립트는 ASCII만, HTML 파서가 블록을 일찍 닫을 문자열이 없다', () => {
    for (const script of blocks(full, 'script')) {
      expect(script).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
      expect(script).not.toMatch(/<\/|<!--/);
      expect(() => new vm.Script(script)).not.toThrow();
    }
    expect(ADMIN_UI_CSS).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
  });

  it('⑤ innerHTML·eval·new Function·외부 URL 부재 (렌더된 페이지 전체 — 자산 포함)', () => {
    expect(full.length).toBeGreaterThan(page.html.length);
    expect(full).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function|DOMParser|createContextualFragment/);
    expect(full).not.toMatch(/setTimeout\s*\(\s*['"]|setInterval\s*\(\s*['"]/);
    expect(full).not.toMatch(/setAttribute\(\s*['"](style|on[a-z]+|href|src)['"]/i);
    // 절대 URL 은 앱의 설정 메시지에 **표시만** 하는 MCP 엔드포인트(`https://api.atmark.ai/mcp` — fetch 대상이 아니다, ⑪)와
    //   가입 화면의 약관·개인정보 안내 링크(`https://atmark.ai/terms`·`/privacy` — 사람이 누르는 링크, ㉑)뿐이다.
    const allowed = ALLOWED_ABSOLUTE[name.replace(/:en$/, '')] ?? [];
    //   그리고 `@font-face` 의 폰트 url — 사이트 출처의 `/_fonts/<해시>/<파일>.woff2` 모양만(리뷰 M4 · CSP font-src 와 같은 출처).
    const scanned = full.replace(/url\(https:\/\/atmark\.ai\/_fonts\/[0-9a-f]{10}\/[A-Za-z0-9.-]+\.woff2\)/g, 'url()');
    const urls = [...scanned.matchAll(/\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/gi)].map((m) => m[0]);
    expect(urls.filter((u) => !allowed.includes(u))).toEqual([]);
  });
});

/** 본문의 `oklch(…)` 호출을 괄호 짝을 맞춰 통째로 꺼낸다(안에 `calc(…)`·`var(…)` 가 겹친다). */
function oklchCalls(body: string): string[] {
  const out: string[] = [];
  for (let i = body.indexOf('oklch('); i >= 0; i = body.indexOf('oklch(', i + 1)) {
    let depth = 0;
    for (let j = i + 5; j < body.length; j++) {
      if (body[j] === '(') depth++;
      else if (body[j] === ')' && --depth === 0) {
        out.push(body.slice(i, j + 1));
        break;
      }
    }
  }
  return out;
}

describe('스타일 — 완전 흑백(`@` 도 글자색)', () => {
  const rules = ADMIN_UI_CSS.split('}')
    .map((chunk) => chunk.split('{'))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({ selector: (parts[parts.length - 2] ?? '').trim(), body: parts[parts.length - 1] ?? '' }));

  it('⑥ 셸의 색은 회색(r=g=b)뿐 — 주황·파란색이 없다 · 유채색(oklch)은 신원 표면(.idc/.idthumb) 규칙 안에서 키 hue(--h)로만(v4 D1 · C1–C2)', () => {
    // 예외 하나 — 의미 색 빨강(`--red-*`, 되돌릴 수 없는 동작·오류 전용, 2026-09-27): 그 값은 토큰 선언 `--red-…:값` 으로만 나온다.
    const redValues = new Set(
      [CONSOLE_LIGHT, CONSOLE_DARK].flatMap((p) => (['red-700', 'red-100', 'red-solid', 'red-alpha'] as const).map((k) => p[k].toLowerCase().replace(/\s/g, ''))),
    );
    const withoutRedTokens = ADMIN_UI_CSS.replace(/--red-(700|100|solid|alpha):([^;}]+)/g, (_m, _k, v: string) => {
      expect(redValues.has(v.toLowerCase().replace(/\s/g, '')), v).toBe(true);
      return '';
    });
    const hexes = [...withoutRedTokens.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)].map((m) => (m[1] ?? '').toLowerCase());
    expect(hexes.length).toBeGreaterThan(5);
    for (const hex of hexes) {
      const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
      const [r, g, b] = [0, 2, 4].map((i) => full.slice(i, i + 2));
      expect(r === g && g === b, `#${hex}는 회색이 아니다`).toBe(true);
    }
    for (const m of withoutRedTokens.matchAll(/rgba?\(([^)]*)\)/gi)) {
      const [r, g, b] = (m[1] ?? '').split(',').map((v) => v.trim());
      expect(r === g && g === b, `${m[0]}는 회색이 아니다`).toBe(true);
    }
    expect(ADMIN_UI_CSS).not.toMatch(/\b(blue|navy|teal|cyan|aqua|azure|indigo|royalblue|steelblue|skyblue|dodgerblue|hsla?\(|color-mix)\b/i);
    // oklch 는 선택자가 전부 .idc/.idthumb 인 규칙 안에만, 모양은 oklch(L% C var(--h)…) — 상수 hue 로 칠한 유채색은 없다.
    const oklchRules = rules.filter((r) => /oklch\(/.test(r.body));
    expect(oklchRules.length).toBeGreaterThanOrEqual(3); // 밝은 벌 · 시스템 다크 · 명시 다크
    for (const r of oklchRules) {
      for (const sel of r.selector.split(',')) expect(sel, r.selector).toMatch(/\.(idc|idthumb)\b/);
      // 키 hue(--h)와 그 파생 hue(--h2 두 번째 면 · --h3/--h4 포일 — 스크립트가 허용 집합 안에서 고른다, 비평 R5-01).
      for (const call of oklchCalls(r.body)) expect(call, r.selector).toMatch(/var\(--h[2-4]?\)/);
    }
    // 신원 표면 밖에는 oklch 가 없다(@supports 조건식은 색이 아니라 기능 검사).
    const outside = rules.filter((r) => /oklch\(/.test(r.body) && !/\.(idc|idthumb)\b/.test(r.selector));
    expect(outside).toEqual([]);
  });

  it('⑥b 빨강은 되돌릴 수 없는 동작·오류에만 — 위험 버튼·위험 카드·위험 확인 머리·⋯ 메뉴 폐기 항목·칸 오류·부팅 실패(상태 배지·한도·로그 결과는 흑백)', () => {
    const red = rules.filter((r) => /var\(--(red-|on-red)/.test(r.body)).map((r) => r.selector.replace(/\/\*[\s\S]*?\*\//g, '').trim());
    expect(red.length).toBeGreaterThan(5);
    // `.dnst .dk-st .rsfail` — 도메인 화면 DNS 레코드 표의 "실패" 칸(2026-10-05): 사용자가 고쳐야 하는 오류라 빨강(2026-10-15 F21 — 모양은 전역 상태 알약). `.pill` 선택자는 그대로 흑백.
    const allowed = /(\.btn\.danger|\.dz\b|#s-pause|dialog \.dh\.hatch|\.mi\.danger|\[aria-invalid="true"\]|\.msg\.err|#boot-err|\.dk-st \.rsfail)/;
    // 최상위 쉼표로만 나눈다(`:is(a,b)` 안의 쉼표는 한 선택자).
    const parts = (sel: string): string[] => sel.split(/,(?![^(]*\))/);
    for (const sel of red) for (const part of parts(sel)) expect(part, sel).toMatch(allowed);
    for (const sel of ['.pill', '.hcount', '.stats .sub', '.dot']) expect(red.some((r) => r.split(',').some((p) => p.trim().startsWith(sel))), sel).toBe(false);
  });

  it('⑥-기본값 — 브라우저가 파랗게 그리는 곳을 덮는다(링크·포커스 링·체크박스·선택 영역)', () => {
    expect(ADMIN_UI_CSS).toContain('a{color:inherit');
    expect(ADMIN_UI_CSS).toContain(':focus-visible{outline:2px solid var(--focus-ring)');
    expect(ADMIN_UI_CSS).toContain('accent-color:var(--gray-1000)');
    expect(ADMIN_UI_CSS).toContain('::selection{background:var(--gray-1000)');
  });

  it('⑦ #F97316은 어디에도 없고, `.at` 는 `@` 한 글자에만(색 없이 글자색을 따른다)', () => {
    expect(rules.filter((r) => /f97316|orange/i.test(r.body) || /f97316|orange/i.test(r.selector))).toEqual([]);
    expect(rules.filter((r) => r.selector === '.at')).toEqual([]);
    for (const [, render] of PAGES) {
      const html = inlined(render());
      const [style] = blocks(html, 'style');
      expect(html).not.toMatch(/f97316/i);
      const atSpans = [...markup(html).matchAll(/<span class="at">([^<]*)<\/span>/g)].map((m) => m[1]);
      // 로고는 이제 SVG 가로 조합(`src/ui/brand.ts`, currentColor — 2026-09-30)이라 `.at` 가 없는 페이지도 있다. 있으면 `@` 한 글자뿐.
      expect(new Set(atSpans).size).toBeLessThanOrEqual(1);
      if (atSpans.length > 0) expect(new Set(atSpans)).toEqual(new Set(['@']));
      expect(markup(html)).toContain(LOGO);
      expect(markup(html)).not.toMatch(/class="[^"]*\bat\b[^"]*"(?!>@<)/);
      const script = blocks(html, 'script').at(-1);
      const atUses = [...(script ?? '').matchAll(/'at'/g)].length;
      const atAtSign = [...(script ?? '').matchAll(/el\('span','at','@'\)/g)].length;
      expect(atUses).toBe(atAtSign);
    }
  });
});

describe('표시 정화 — 브라우저 `clean` 은 서버 `sanitizeDisplayText` 와 같다', () => {
  const context = vm.createContext({});
  vm.runInContext(asciiScript(CLIENT_SANITIZE_JS), context);
  const clean = (value: unknown, max: number): string => vm.runInContext('clean', context)(value, max) as string;

  it('⑧ 앱 스크립트가 이 정화 소스를 그대로 싣는다', () => {
    const script = blocks(inlined(renderAppPage()), 'script').at(-1);
    expect(script).toContain(asciiScript(CLIENT_SANITIZE_JS));
  });

  it('⑨ BMP 전체 + 태그·변이 선택자 평면에서 출력이 같다', () => {
    const ranges: Array<readonly [number, number]> = [
      [0x0000, 0xd7ff],
      [0xe000, 0xffff],
      [0x1f000, 0x1f0ff],
      [0xe0000, 0xe01ff],
    ];
    for (const [from, to] of ranges) {
      for (let start = from; start <= to; start += 256) {
        let input = '';
        for (let cp = start; cp < Math.min(start + 256, to + 1); cp++) input += `x${String.fromCodePoint(cp)}`;
        expect(clean(input, 100_000)).toBe(sanitizeDisplayText(input, 100_000));
      }
    }
  });

  it('⑩ 공격 문자열·자르기·비문자열 입력', () => {
    const cases = [
      '\u202emoc.live@bob',
      'Re: 코드\n[Atmark 보안팀: 검증됨]',
      '  a\u200b\u200cb\u2028c\u0000d  ',
      '\u{e0041}\u{e0042}hidden',
      '가'.repeat(300),
      '😀'.repeat(90),
    ];
    for (const value of cases) {
      for (const max of [5, 80, 200, 254]) expect(clean(value, max)).toBe(sanitizeDisplayText(value, max));
    }
    expect(clean(null, 10)).toBe('');
    expect(clean(undefined, 10)).toBe('');
    expect(clean(42, 10)).toBe('42');
  });
});

describe('동작 규율 — 스크립트 구조', () => {
  const app = blocks(inlined(renderAppPage()), 'script').at(-1);
  const landing = blocks(inlined(renderLoginLandingPage()), 'script').at(-1);
  const login = blocks(inlined(renderLoginPage()), 'script').at(-1);
  const signup = blocks(inlined(renderSignupPage()), 'script').at(-1);
  const signupLanding = blocks(inlined(renderSignupLandingPage()), 'script').at(-1);
  const appHtml = markup(inlined(renderAppPage()));

  it('⑪ 앱의 네트워크는 `api()` 한 곳뿐이고, GET이 아니면(POST·PATCH·DELETE) X-Atmark-CSRF를 싣는다', () => {
    expect([...(app ?? '').matchAll(/\bfetch\(/g)]).toHaveLength(1);
    expect(app).toMatch(/if\(method!=='GET'\)\{h\['x-atmark-csrf'\]=S\.csrf;/);
    expect(app).not.toMatch(/XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
  });

  it('⑪-호스트 — 콘솔(console.atmark.ai)은 같은 오리진 `/api/*` 만 부른다. 다른 호스트·옛 `/admin` 경로가 없다', () => {
    const calls = [...(app ?? '').matchAll(/\bapi\('(GET|POST|PATCH|DELETE)',\s*'([^']*)'/g)].map((m) => m[2] ?? '');
    expect(calls.length).toBeGreaterThan(15);
    expect(app).toContain("api('DELETE','/api/agents/'");
    for (const path of calls) expect(path.startsWith('/api/'), path).toBe(true);
    for (const script of [app, login, landing, signup, signupLanding]) {
      for (const m of (script ?? '').matchAll(/fetch\('([^']*)'/g)) expect((m[1] ?? '').startsWith('/api/'), m[1]).toBe(true);
      expect(script).not.toMatch(/\/admin\b/);
      expect(script).not.toMatch(/location\.origin/);
    }
    // MCP 주소는 설정 메시지 틀(SETUP_MESSAGE_JS)에 **표시용 문자열**로만 있다 — fetch 대상이 아니다.
    expect(app).toContain('"url":"https://api.atmark.ai/mcp"');
    expect(app).toContain("location.replace('/')");
    // 옛 로그인 · 가입 확인 링크 착지(2026-10-10 링크 삭제)는 서버를 부르지 않는다.
    expect(landing).not.toContain('fetch(');
    expect(signupLanding).not.toContain('fetch(');
    for (const [, render] of PAGES) expect(markup(inlined(render()))).not.toMatch(/href="\/admin/);
  });

  it('⑫ 승인 버튼이 없다 — 승인은 서명 링크 한 경로로만 · 레거시 "승인 대기"·"seed" 절이 없다(v2 §4)', () => {
    expect(app).not.toMatch(/\/approve\b|\/api\/approvals|\/seeds\b/);
    expect(appHtml).not.toMatch(/id="s-(approvals|seeds|policy)"|id="(ap|seed|p)-go"/);
    // 레거시 승인 대기는 발신 로그의 `pending` 으로 보인다.
    expect(app).toContain(asciiScript("pending:['승인 대기','dim']"));
    expect(app).not.toMatch(/autoApproveVerificationSenders|ac7Acknowledged/);
  });

  it('⑬ 발신·수신 모드는 네 라디오 카드(all·allowlist·blocklist·none)뿐 — 레거시 모드는 고를 수 없다 · "전체"는 경고와 확인란', () => {
    for (const p of ['o', 'i']) {
      const values = [...appHtml.matchAll(new RegExp(`<input type="radio" name="${p}-mode" value="([a-z]+)"`, 'g'))].map((m) => m[1]);
      expect(values, p).toEqual(['all', 'allowlist', 'blocklist', 'none']);
    }
    expect(appHtml).not.toMatch(/value="(approval_required|reply_only|unrestricted|allowlist_only|disabled)"/);
    expect(appHtml).toContain('<div class="warnbox" id="o-warn-all" hidden><div class="hrow"><strong>"전체"는 이 에이전트가 누구에게나 메일을 보낼 수 있다는 뜻입니다.</strong>');
    expect(app).toContain("$('o-warn-all').hidden=draft!=='all';");
    expect(app).toContain(asciiScript("o.ack='누구에게나 보낼 수 있게 되는 것을 확인했습니다'"));
    // PATCH 는 방향별 {mode} 하나 · 목록은 POST/DELETE rules(T1 메모의 모양).
    expect(app).toContain('var body={};body[dir]={mode:to};');
    expect(app).toContain("api('POST','/api/agents/'+enc(aid)+'/channels/'+CH+'/rules',{direction:dir,list:list,value:v})"); // aid = 대화상자를 연 에이전트(RL.agent)
    // "현재 모드에서는 쓰이지 않음" — 발신·수신 같은 표(T1 메모): allow 는 허용 목록에서만, block 은 허용 목록·차단 목록에서.
    expect(app).toContain("function listUsed(mode,list){return list==='allow'?mode==='allowlist':(mode==='allowlist'||mode==='blocklist');}");
  });

  it('⑭ 토큰 모달 — 한 번만(닫으면 다시 볼 수 없다는 한 줄) · 보통의 닫기 버튼 · 닫히면(버튼·Esc) 지운다', () => {
    expect(appHtml).toContain('<p>이 창을 닫으면 토큰을 다시 볼 수 없습니다.</p>');
    expect(appHtml).toContain('<button type="button" class="btn ghost" id="dt-close">닫기</button>'); // 주 버튼은 복사 하나(2026-10-15 F49)
    expect(appHtml).not.toContain('dt-ack');
    expect(appHtml).not.toContain('토큰 지우기');
    expect(app).toContain("$('dlg-token').addEventListener('close',function(){TOKEN='';txt('dt-token','');txt('dt-msg','');TOKEN_AGENT=null;");
    // 토큰을 설정 메시지에 넣는 곳은 모달의 `tokenMsg` 하나뿐 — 연결 화면·개요의 "연결 메시지 복사"는 언제나 빈 토큰(자리표시).
    expect([...(app ?? '').matchAll(/setupMessage\(/g)].length).toBe(5); // 정의 1 + tokenMsg 1 + 연결 2(그리기·복사) + 개요 복사 1
    expect([...(app ?? '').matchAll(/msgInput\(TOKEN_AGENT,TOKEN\)/g)]).toHaveLength(1);
    expect([...(app ?? '').matchAll(/setupMessage\(S\.msgLang,msgInput\(a,''\)\)/g)]).toHaveLength(3);
    // 메시지는 클라이언트 중립 — 인증 헤더는 자리표시(`<token>`)로만 적고, 토큰 값은 저장 안내 다음 줄(`ATMARK_AGENT_TOKEN=…`)에만 붙는다.
    expect(app).toContain("out.push(t.envStep,SM.env+'='+tok)");
    expect(app).not.toContain('{env:');
  });

  it('⑮ 옛 로그인 링크 착지(2026-10-10 링크 로그인 삭제) — 프래그먼트(옛 토큰)를 주소창에서 지울 뿐 서버에 아무것도 보내지 않는다 · 코드로 로그인하라는 안내 + 로그인 화면 버튼', () => {
    const s = landing ?? '';
    expect(s).toContain('history.replaceState');
    expect(s).toContain('location.hash');
    expect(s).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|\/api\//);
    const landingHtml = markup(inlined(renderLoginLandingPage()));
    expect(landingHtml).toContain('<h1>이 로그인 링크는 더 쓰지 않습니다</h1>');
    expect(landingHtml).toContain('6자리 코드로만');
    expect(landingHtml).toContain('<a class="btn" href="/">로그인 코드 받기</a>');
    expect(landingHtml).not.toMatch(/<button|id="m[0-9]"/);
  });

  it('⑯ 로그인 — 응답과 무관하게 같은 문구(열거 방지): 결과 분기는 429·5xx·네트워크뿐', () => {
    // 요청 부분만(코드 입력 조각 `var cf=` 앞) — 코드 verify 의 분기는 ⑯-코드가 본다.
    const s = (login ?? '').slice(0, (login ?? '').indexOf('var cf='));
    expect(s.length).toBeGreaterThan(100);
    const statuses = [...s.matchAll(/r\.status(?:===|>=)(\d+)/g)].map((m) => m[1]);
    expect(statuses.sort()).toEqual(['429', '500']);
    expect(s).not.toMatch(/r\.ok|\.json\(/);
    expect(markup(inlined(renderLoginPage())).match(/메일을 확인하세요/g)).toHaveLength(1);
  });

  it('⑱ 조직 정지 상태(U2) — /api/me orgKillSwitch를 읽어 배너 둘(소유자·플랫폼)과 버튼 하나만 · 운영자 정지는 해제 버튼이 잠긴다', () => {
    const s = app ?? '';
    expect(s).toContain('var k=(j&&obj(j.orgKillSwitch))?j.orgKillSwitch:{};');
    expect(s).toContain("$('ks-owner').hidden=!S.ks.ownerPaused;$('ks-platform').hidden=!S.ks.platformFrozen;");
    expect(s).toContain("$('org-kill-on').hidden=S.ks.ownerPaused;$('org-kill-off').hidden=!S.ks.ownerPaused;");
    expect(appHtml).toContain('<button type="button" class="btn danger" id="org-kill-on" hidden>');
    expect(appHtml).toContain('<button type="button" class="btn ghost" id="org-kill-off" hidden>');
    // v3: 배너는 굵은 제목 한 줄만(R4) — 본문은 ⓘ(tip-ks-*) 안.
    expect(appHtml).toContain('<div class="warnbox" id="ks-platform" role="status" hidden><div class="hrow"><strong>운영자가 이 조직의 발송을 동결했습니다.</strong>');
    expect(appHtml).toContain('<div class="warnbox" id="ks-owner" role="status" hidden><div class="hrow"><strong>조직 전체가 긴급 정지 중입니다.</strong><a href="#/settings/pause" class="more">긴급 정지 해제<svg class="ico"');
    expect(appHtml).toMatch(/<div class="tip-pop" id="tip-ks-platform" hidden><p>[^<]*플랫폼 동결은 운영자만 풀 수 있고/);
    expect(s).toContain("if(susp&&a.suspendedBy!=='owner'){k.disabled=true;");
    // 정지 뒤 상태를 다시 읽는다(배너·버튼이 따라온다).
    expect(s).toMatch(/say\('org-kill-msg'[^;]*;return loadMe\(\);/);
  });

  it('⑲ 인계 시험(U1) — ambiguous는 "인계 시험 없음"이 아니라 고르라고 말한다 · 새 인계 시험은 newGate 확인란 · CLI 명령을 시키지 않는다', () => {
    const s = app ?? '';
    // 한 문장은 한 번만(2026-09-27): 요약 줄 `g-sum` 이 "없음"·"고르세요" 를 말하고, 패널 안에 같은 문장을 다시 두지 않는다.
    expect(appHtml).not.toMatch(/id="g-none"|id="g-ambig"/);
    expect(s).toMatch(/txt\('g-sum',amb\?fmt\('[^']+',\{n:S\.gates\.length\}\):/);
    expect(appHtml).toContain('<p>판정·기록은 고른 인계 시험에만 합니다(최신을 자동으로 고르지 않습니다. 틀린 인계 시험의 통과는 공허한 통과입니다).</p>');
    expect(s).toContain('S.ambiguous=j.ambiguous===true&&!rep;');
    expect(s).toContain('if(fresh)body.newGate=true;');
    expect(appHtml).toContain('<input type="checkbox" id="gs-new">');
    for (const text of [appHtml, s]) expect(text).not.toMatch(/ac0:restart|--new-gate/);
  });

  it('⑳ 모든 기기에서 로그아웃(L5) — 확인을 거쳐 POST /api/logout-all', () => {
    expect(appHtml).toContain('id="logout-all">모든 기기에서 로그아웃</button>');
    expect(app).toContain("api('POST','/api/logout-all')");
  });
});

// ---------------------------------------------------------------------------
// 셀프 가입 화면 (signup-contract.md §5) — 정적 구조 + **가짜 DOM 위에서 스크립트를 실제로 돌려** 동작을 본다.
// ---------------------------------------------------------------------------

interface FakeElement {
  hidden: boolean;
  disabled: boolean;
  value: string;
  checked: boolean;
  focused: number;
  readonly classes: Set<string>;
  readonly classList: { add(c: string): void; remove(c: string): void };
  readonly listeners: Record<string, Array<(ev: { preventDefault(): void }) => void>>;
  addEventListener(type: string, fn: (ev: { preventDefault(): void }) => void): void;
  focus(): void;
  readonly attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  select(): void;
}

interface FakeFetchCall {
  readonly url: string;
  readonly init: { method: string; body?: string };
  resolve(response: { ok: boolean; status: number; json?: () => Promise<unknown> }): void;
  reject(error: unknown): void;
}

interface FakeWorld {
  readonly el: (id: string) => FakeElement;
  readonly fetches: FakeFetchCall[];
  readonly replaced: string[];
  readonly navigated: string[];
  readonly location: { hash: string; pathname: string; search: string };
}

function fakeElement(): FakeElement {
  const classes = new Set<string>();
  const listeners: FakeElement['listeners'] = {};
  const attributes = new Map<string, string>();
  const element: FakeElement = {
    hidden: false,
    disabled: false,
    value: '',
    checked: false,
    focused: 0,
    classes,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    listeners,
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    focus() {
      element.focused += 1;
    },
    attributes,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    select() {
      element.focused += 1;
    },
  };
  return element;
}

/** 페이지 스크립트 하나를 가짜 DOM·location·history·fetch 위에서 돌린다. 모든 요소는 처음에 `hidden`(마크업과 같다). */
function runPage(script: string, url: { pathname: string; hash?: string }): FakeWorld {
  const elements = new Map<string, FakeElement>();
  const el = (id: string): FakeElement => {
    let found = elements.get(id);
    if (found === undefined) {
      found = fakeElement();
      found.hidden = true;
      elements.set(id, found);
    }
    return found;
  };
  const fetches: FakeFetchCall[] = [];
  const replaced: string[] = [];
  const navigated: string[] = [];
  const location = {
    hash: url.hash ?? '',
    pathname: url.pathname,
    search: '',
    replace: (to: string) => navigated.push(to),
  };
  const context = vm.createContext({
    document: { getElementById: el },
    location,
    history: {
      replaceState: (_s: unknown, _t: string, to: string) => {
        replaced.push(to);
        location.hash = '';
      },
    },
    fetch: (u: string, init: FakeFetchCall['init']) =>
      new Promise((resolve, reject) => {
        fetches.push({ url: u, init, resolve, reject });
      }),
  });
  vm.runInContext(script, context);
  return { el, fetches, replaced, navigated, location };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const submit = (world: FakeWorld): void => {
  for (const fn of world.el('f').listeners['submit'] ?? []) fn({ preventDefault: () => undefined });
};
const click = (world: FakeWorld, id: string): void => {
  for (const fn of world.el(id).listeners['click'] ?? []) fn({ preventDefault: () => undefined });
};
const TOKEN = 'atk_signup_abc.DEF-123_x';

describe('셀프 가입 화면 — /signup · /signup/verify · 로그인 링크 · /app 배너', () => {
  const signupHtml = markup(inlined(renderSignupPage()));
  const signup = blocks(inlined(renderSignupPage()), 'script').at(-1);
  const signupLanding = blocks(inlined(renderSignupLandingPage()), 'script').at(-1);
  const app = blocks(inlined(renderAppPage()), 'script').at(-1);
  const appHtml = markup(inlined(renderAppPage()));

  it('㉑ 가입 폼 — 이메일 · 조직 이름(80자) · 필수 동의 확인란(약관·개인정보 링크는 새 창 · noopener) · 로그인 링크', () => {
    expect(signupHtml).toContain('<input type="email" id="email"');
    expect(signupHtml).toContain('<input type="text" id="org" name="organization" autocomplete="organization" required maxlength="80">');
    expect(signupHtml).toContain('<input type="checkbox" id="consent" name="consent" required>');
    expect(signupHtml).toContain('<a href="https://atmark.ai/kr/terms" target="_blank" rel="noopener noreferrer">이용약관</a>');
    expect(signupHtml).toContain('<a href="https://atmark.ai/kr/privacy" target="_blank" rel="noopener noreferrer">개인정보 처리 안내</a>');
    expect(signupHtml).toContain('이미 계정이 있나요? <a href="/">로그인<svg'); // 로그인 화면의 "가입하기 →"와 같은 모양(F67)
    expect(signupHtml).toContain('초대를 받지 못했나요? <a href="https://atmark.ai/kr/waitlist">대기자 명단<svg');
    expect(signupHtml.match(/메일을 확인하세요/g)).toHaveLength(1);
    // 처음 보는 화면은 설명 없이(진윤겸 2026-09-27) — 가입 화면에는 안내 문단·꼬리가 없다. 검토 중 에이전트 상한은 /app 배너가 말한다(아래 ㉖).
    expect(signupHtml).not.toMatch(/class="(kicker|lede)"|<footer>/);
  });

  it('㉒ 로그인 화면 → 가입 링크', () => {
    expect(markup(inlined(renderLoginPage()))).toContain('처음이신가요? <a href="/signup">가입하기<svg class="ico"');
  });

  it('㉓ 가입 요청 — 결과 분기는 400·429·5xx·네트워크뿐(열거 방지: 202는 하나의 문구) · 본문은 consent:true', () => {
    const s = (signup ?? '').slice(0, (signup ?? '').indexOf('var cf='));
    expect(s.length).toBeGreaterThan(100);
    const statuses = [...s.matchAll(/r\.status(?:===|>=)(\d+)/g)].map((m) => m[1]);
    expect(statuses.sort()).toEqual(['400', '429', '500']);
    expect(s).not.toMatch(/r\.ok|\.json\(/);
    // 화면 언어(LANG — 페이지마다 `var LANG='ko'|'en';`)도 싣는다 — 환영 메일의 언어(202609301510).
    expect(s).toContain('body:JSON.stringify({email:v,organizationName:n,consent:true,lang:LANG})');
  });

  it('㉓-동작 — 동의 없이는 fetch가 나가지 않는다 · 동의하면 한 번 · 202 면 "메일을 확인하세요" · 429는 따로', async () => {
    const world = runPage(signup ?? '', { pathname: '/signup' });
    world.el('email').value = ' Owner@Example.com ';
    world.el('org').value = '  Acme  ';
    world.el('f').hidden = false;
    submit(world);
    expect(world.fetches).toHaveLength(0);
    expect(world.el('e4').hidden).toBe(false);

    world.el('org').value = 'a‮b';
    world.el('consent').checked = true;
    submit(world);
    expect(world.fetches).toHaveLength(0);
    expect(world.el('e3').hidden).toBe(false);

    world.el('org').value = '가'.repeat(81);
    submit(world);
    expect(world.fetches).toHaveLength(0);
    world.el('org').value = '가'.repeat(80);
    submit(world);
    expect(world.fetches).toHaveLength(1);
    const [first] = world.fetches;
    expect(first?.url).toBe('/api/signup');
    expect(JSON.parse(first?.init.body ?? '{}')).toEqual({ email: 'Owner@Example.com', organizationName: '가'.repeat(80), consent: true, lang: 'ko' });
    first?.resolve({ ok: true, status: 202 });
    await settle();
    expect(world.el('sent').hidden).toBe(false);
    expect(world.el('f').hidden).toBe(true);

    const limited = runPage(signup ?? '', { pathname: '/signup' });
    limited.el('email').value = 'a@example.com';
    limited.el('org').value = 'Acme';
    limited.el('consent').checked = true;
    submit(limited);
    limited.fetches[0]?.resolve({ ok: false, status: 429 });
    await settle();
    expect(limited.el('e2').hidden).toBe(false);
    expect(limited.el('sent').hidden).toBe(true);
  });

  it('㉔ 옛 가입 확인 링크 착지(2026-10-10 링크 삭제) — 로드하면 토큰(#t=)을 주소창에서 지우고 끝 · fetch 0 · 버튼 0 · 가입 화면으로 안내', () => {
    const s = signupLanding ?? '';
    expect(s).toContain('history.replaceState');
    expect(s).not.toMatch(/fetch\(|\/api\//);
    const world = runPage(s, { pathname: '/signup/verify', hash: `#t=${TOKEN}` });
    expect(world.replaced).toEqual(['/signup/verify']);
    expect(world.location.hash).toBe('');
    expect(world.fetches).toHaveLength(0);
    const html = markup(inlined(renderSignupLandingPage()));
    expect(html).toContain('<h1>이 가입 확인 링크는 더 쓰지 않습니다</h1>');
    expect(html).toContain('<a class="btn" href="/signup">가입 코드 받기</a>');
    expect(html).not.toContain('<button');
    expect(markup(inlined(renderSignupLandingPage('en')))).toContain('<h1>This sign-up link no longer works</h1>');
    // 토큰 없이 열어도 같은 안내(주소창을 건드릴 것이 없다).
    const bare = runPage(s, { pathname: '/signup/verify', hash: '' });
    expect(bare.replaced).toEqual([]);
    expect(bare.fetches).toHaveLength(0);
  });

  it('㉓-이름 — 가입 폼의 조직 이름 검사는 서버(isValidOrganizationName)와 전 코드 포인트에서 같은 판정(검증 H3 — 화면이 먼저 e3을 말한다)', async () => {
    const s = signup ?? '';
    const literal = /function badName\(n\)\{[^}]*?\/(\[.*?\])\/u\.test\(n\)/.exec(s)?.[1];
    expect(literal).toBeDefined();
    const client = new RegExp(literal ?? '[]', 'u');
    const disagree: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const name = `a${String.fromCodePoint(cp)}b`;
      if (client.test(name) === isValidOrganizationName(name)) disagree.push(cp.toString(16));
    }
    expect(disagree.slice(0, 20)).toEqual([]);

    const world = runPage(s, { pathname: '/signup' });
    world.el('email').value = 'a@example.com';
    world.el('org').value = 'Acme\u2065';
    world.el('consent').checked = true;
    submit(world);
    expect(world.fetches).toHaveLength(0);
    expect(world.el('e3').hidden).toBe(false);
  });

  it('㉕ /app 배너 — reviewStatus가 pending_review·rejected 일 때 각각 · 검토 전 조직의 에이전트 상한은 따로 말한다', () => {
    expect(appHtml).toContain('<div class="warnbox" id="rv-pending" role="status" hidden><div class="hrow"><strong>운영자가 검토하고 있습니다. 외부 발송은 검토 뒤 열립니다.</strong>');
    expect(appHtml).toContain(`<p>검토 중에는 에이전트를 ${MAX_AGENTS_PER_PENDING_ORG}개까지 만들 수 있습니다.`);
    expect(appHtml).toContain('<div class="warnbox" id="rv-rejected" role="status" hidden><div class="hrow"><strong>가입이 승인되지 않아 외부 발송이 닫혀 있습니다.</strong>');
    const s = app ?? '';
    expect(s).toContain("S.review=(S.org.reviewStatus==='pending_review'||S.org.reviewStatus==='rejected')?S.org.reviewStatus:'active';");
    expect(s).toContain("$('rv-pending').hidden=S.review!=='pending_review';$('rv-rejected').hidden=S.review!=='rejected';");
    // 활성 조직의 상한은 요금제(ADR-0011 — `/api/me.plan.maxAgents`)라 상수로 박지 않는다. 검토 전 상한만 서버 상수.
    expect(s).toContain(`var L=${JSON.stringify({ pending: MAX_AGENTS_PER_PENDING_ORG })};`);
    expect(s).toContain("var base=(e.code==='agent_limit'&&S.review!=='active')?CODES.agent_limit_pending:");
    expect(MAX_AGENTS_PER_PENDING_ORG).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// P0/P1(extensibility-p0-p1 §3.2 · §3.3 · §4-2 · §4-9) — 로그인 착지의 조직 고르기 · 초대 착지(/invite)
// ---------------------------------------------------------------------------

describe('P0/P1 착지 — 조직 고르기 · 초대', () => {
  const landing = blocks(inlined(renderLoginLandingPage()), 'script').at(-1) ?? '';
  const invite = blocks(inlined(renderInvitePage()), 'script').at(-1) ?? '';
  const LOGIN = 'atk_login_abc.DEF-123_x';
  const INVITE = 'atk_invite_k1.PAYLOAD-abc_9.sig_XYZ';

  it('㉖ 옛 로그인 링크 착지 — 로드하면 토큰을 주소창에서 지우고 끝(verify 를 부르지 않는다) · 조직 고르기는 코드 verify 의 next 로', () => {
    const old = runPage(landing, { pathname: '/login', hash: `#${LOGIN}` });
    expect(old.replaced).toEqual(['/login']);
    expect(old.location.hash).toBe('');
    expect(old.fetches).toHaveLength(0);
    // 조직이 여럿이면 코드 verify 의 `next:'select-org'` 가 조직 고르기로 보낸다(로그인 · 초대 화면의 코드 입력이 같은 조각).
    expect(blocks(inlined(renderLoginPage()), 'script').at(-1)).toContain("function cnext(j){if(j&&j.next==='select-org')return '/app#/select-org';");
  });

  it('㉗b 초대 착지 — "당신 주소로 온 초대일 때만 계속" 안내가 버튼 영역에 두 언어로(적대적 검토 L4)', () => {
    const ko = markup(inlined(renderInvitePage('ko')));
    const en = markup(inlined(renderInvitePage('en')));
    expect(ko).toContain('이 초대가 당신 주소로 온 것일 때만 계속하세요.');
    expect(en).toContain('Only continue if this invite was sent to your own address.');
    expect(en).not.toContain('이 초대가');
    // 버튼 섹션(#go) 안 — 버튼보다 앞.
    expect(ko.indexOf('id="own"')).toBeGreaterThan(ko.indexOf('id="go"'));
    expect(ko.indexOf('id="own"')).toBeLessThan(ko.indexOf('id="b"'));
  });

  it('㉗ 초대 착지 — 조각(#t=…)을 먼저 지우고 · 로드만으로는 fetch 0 · 누르면 한 번 POST /api/invites/claim {token} · 202 면 "메일을 확인하세요"', async () => {
    const replace = invite.indexOf('history.replaceState');
    expect(replace).toBeGreaterThan(-1);
    expect(invite.indexOf("addEventListener('click'")).toBeGreaterThan(replace);
    const w = runPage(invite, { pathname: '/invite', hash: `#t=${INVITE}` });
    expect(w.replaced).toEqual(['/invite']);
    expect(w.fetches).toHaveLength(0);
    expect(w.el('go').hidden).toBe(false);
    click(w, 'b');
    click(w, 'b');
    expect(w.fetches).toHaveLength(1);
    expect(w.fetches[0]?.url).toBe('/api/invites/claim');
    expect(JSON.parse(w.fetches[0]?.init.body ?? '{}')).toEqual({ token: INVITE });
    w.fetches[0]?.resolve({ ok: true, status: 202 });
    await settle();
    expect(w.el('sent').hidden).toBe(false);
    expect(w.navigated).toEqual([]); // 초대 링크는 세션을 만들지 않는다 — 로그인 메일을 이 브라우저에서 열어야 한다
    // 조각 모양 `#<token>` 도 받는다.
    const bare = runPage(invite, { pathname: '/invite', hash: `#${INVITE}` });
    click(bare, 'b');
    expect(JSON.parse(bare.fetches[0]?.init.body ?? '{}')).toEqual({ token: INVITE });
  });

  it('㉗-분기 — 401 invite_invalid은 m1(만료·취소) · 429는 m2 · 403(출처)·5xx·네트워크는 m3 · 온전하지 않은 조각은 m0 이고 버튼이 없다', async () => {
    for (const [status, panel] of [[401, 'm1'], [429, 'm2'], [403, 'm3'], [500, 'm3']] as const) {
      const w = runPage(invite, { pathname: '/invite', hash: `#t=${INVITE}` });
      click(w, 'b');
      w.fetches[0]?.resolve({ ok: false, status });
      await settle();
      expect(w.el(panel).hidden, String(status)).toBe(false);
      expect(w.el('sent').hidden).toBe(true);
    }
    const down = runPage(invite, { pathname: '/invite', hash: `#t=${INVITE}` });
    click(down, 'b');
    down.fetches[0]?.reject(new Error('offline'));
    await settle();
    expect(down.el('m3').hidden).toBe(false);
    for (const hash of ['', '#t=', '#t=<script>', '#t=a b']) {
      const broken = runPage(invite, { pathname: '/invite', hash });
      expect(broken.el('m0').hidden, hash).toBe(false);
      expect(broken.el('b').listeners['click'] ?? [], hash).toHaveLength(0);
    }
  });

  it('㉘ 초대 착지 문구 — 조직 이름을 싣지 않는다(F-2) · 두 언어 · 로그인 화면 문구는 "소유자"가 아니라 콘솔 사용자', () => {
    const ko = markup(inlined(renderInvitePage('ko')));
    const en = markup(inlined(renderInvitePage('en')));
    expect(ko).toContain('<h1>조직 초대</h1>');
    expect(en).toContain('<h1>Organization invite</h1>');
    expect(ko).not.toMatch(/id="(org|org-name)"/);
    expect(markup(inlined(renderLoginPage()))).not.toContain('조직 소유자');
    expect(markup(inlined(renderLoginPage()))).not.toMatch(/class="(kicker|lede)"|<footer>/);
  });
});

// ---------------------------------------------------------------------------
// 메일의 6자리 코드(2026-09-28) — 로그인·가입·초대 화면의 코드 입력란(`login.ts` `codeForm`·`codeScript`).
// ---------------------------------------------------------------------------

describe('6자리 코드 입력 — 로그인 · 가입 · 초대', () => {
  const pages = [
    ['로그인', renderLoginPage, '/api/login/verify', 'login_browser_missing', 'member_limit'],
    ['가입', renderSignupPage, '/api/signup/verify', 'signup_browser_missing', 'signup_capacity'],
    ['초대', renderInvitePage, '/api/login/verify', 'login_browser_missing', 'member_limit'],
  ] as const;
  const submitCode = (world: FakeWorld): void => {
    for (const fn of world.el('cf').listeners['submit'] ?? []) fn({ preventDefault: () => undefined });
  };
  const json = (body: unknown) => () => Promise.resolve(body);

  it.each(pages)('%s — 한 칸 · 숫자 자판 · 코드 자동 채움 · 코드만(링크 안내 없음 — 2026-10-10) · 두 언어(영어에 한글 없음) · 대시 없음', (_label, render) => {
    const ko = markup(inlined(render('ko')));
    const en = markup(inlined(render('en')));
    expect(ko.match(/<input [^>]*id="code"[^>]*>/g)).toEqual([
      '<input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required spellcheck="false" autocapitalize="off" autocorrect="off">',
    ]);
    expect(ko).toContain('<span>메일로 받은 6자리 코드</span>');
    // 메일에는 코드만 있다 — "링크를 열어도 된다" 는 안내가 없고, 코드 한 번 · 유효 시간만 말한다.
    expect(ko).toMatch(/코드는 (15|30)분 동안 한 번 쓸 수 있습니다\./);
    expect(ko).not.toMatch(/메일의 링크를 이 브라우저에서/);
    expect(en).toContain('<span>6-digit code from the email</span>');
    expect(en).toMatch(/The code works once, for (15|30) minutes\./);
    expect(en).not.toMatch(/open the link from (the|that) email/);
    // 코드 입력란은 보낸 뒤 패널(#sent) 안에만 있다.
    expect(ko.indexOf('id="cf"')).toBeGreaterThan(ko.indexOf('id="sent"'));
    // 오류 문구는 오류 색(err)만 — 새 문장에 대시 없음.
    for (const id of ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']) expect(ko).toContain(`<p class="msg err" id="${id}" role="alert" hidden>`);
    const codeSection = ko.slice(ko.indexOf('id="sent"'), ko.indexOf('</section>', ko.indexOf('id="sent"')));
    expect(codeSection).not.toContain('—');
  });

  it.each(pages)('%s — 보낸 뒤 코드: 공백·하이픈을 떼고 한 번 POST {code} · 모양이 아니면 fetch 0(c0) · 성공은 콘솔로', async (label, render, endpoint) => {
    const script = blocks(inlined(render('ko')), 'script').at(-1) ?? '';
    const w = runPage(script, label === '초대' ? { pathname: '/invite', hash: '#t=atk_invite_k1.a.b' } : { pathname: label === '가입' ? '/signup' : '/' });
    w.el('code').value = '12 34';
    submitCode(w);
    expect(w.fetches).toHaveLength(0);
    expect(w.el('c0').hidden).toBe(false);
    w.el('code').value = ' 123-456 ';
    submitCode(w);
    submitCode(w); // 누르는 동안 두 번째는 나가지 않는다
    expect(w.fetches).toHaveLength(1);
    expect(w.fetches[0]?.url).toBe(endpoint);
    expect(JSON.parse(w.fetches[0]?.init.body ?? '{}')).toEqual({ code: '123456' });
    w.fetches[0]?.resolve({ ok: true, status: 200, json: json(label === '로그인' ? { csrf: 'x', next: 'select-org' } : { redirect: '/app' }) });
    await settle();
    await settle();
    expect(w.navigated).toEqual([label === '로그인' ? '/app#/select-org' : '/app']);
  });

  it.each(pages)('%s — 401 은 한 문장(c1 · 이유를 가리지 않는다) · 스스로 센 5번째 실패 뒤에만 c2(입력 잠금) · 결속 없음 c3 · 409 c5 · 429 c6 · 5xx·네트워크 c4', async (_label, render, _endpoint, missing, conflict) => {
    const script = blocks(inlined(render('ko')), 'script').at(-1) ?? '';
    const w = runPage(script, { pathname: '/', hash: '#t=atk_invite_k1.a.b' });
    const attempt = async (status: number, error: string | null): Promise<void> => {
      w.el('code').value = '000000';
      submitCode(w);
      w.fetches.at(-1)?.resolve({ ok: false, status, json: json(error === null ? null : { error }) });
      await settle();
      await settle();
    };
    for (let i = 1; i <= 4; i += 1) {
      await attempt(401, 'login_code_invalid');
      expect(w.el('c1').hidden).toBe(false);
      expect(w.el('c2').hidden).toBe(true);
      expect(w.el('code').disabled).toBe(false);
    }
    await attempt(401, 'signup_code_invalid');
    expect(w.el('c2').hidden).toBe(false);
    expect(w.el('code').disabled).toBe(true);
    expect(w.el('cgo').disabled).toBe(true);
    expect(w.fetches).toHaveLength(5);

    const v = runPage(script, { pathname: '/', hash: '#t=atk_invite_k1.a.b' });
    const once = async (status: number, error: string | null, shown: string): Promise<void> => {
      v.el('code').value = '000000';
      submitCode(v);
      v.fetches.at(-1)?.resolve({ ok: false, status, json: json(error === null ? null : { error }) });
      await settle();
      await settle();
      expect(v.el(shown).hidden, `${String(status)} ${String(error)}`).toBe(false);
    };
    await once(401, missing, 'c3');
    await once(409, conflict, 'c5');
    await once(429, 'rate_limited', 'c6');
    await once(500, null, 'c4');
    v.el('code').value = '000000';
    submitCode(v);
    v.fetches.at(-1)?.reject(new TypeError('network'));
    await settle();
    expect(v.el('c4').hidden).toBe(false);
    expect(v.navigated).toEqual([]);
  });

  it('로그인 — "다른 주소로 다시" 뒤 새로 보내면 스스로 센 실패가 지워진다(새 시도)', async () => {
    const script = blocks(inlined(renderLoginPage('ko')), 'script').at(-1) ?? '';
    const w = runPage(script, { pathname: '/' });
    for (let i = 0; i < 5; i += 1) {
      w.el('code').value = '000000';
      submitCode(w);
      w.fetches.at(-1)?.resolve({ ok: false, status: 401, json: json({ error: 'login_code_invalid' }) });
      await settle();
      await settle();
    }
    expect(w.el('code').disabled).toBe(true);
    w.el('email').value = 'someone@example.com';
    submit(w);
    w.fetches.at(-1)?.resolve({ ok: true, status: 202 });
    await settle();
    expect(w.el('sent').hidden).toBe(false);
    expect(w.el('code').disabled).toBe(false);
    expect(w.el('c2').hidden).toBe(true);
  });
});
