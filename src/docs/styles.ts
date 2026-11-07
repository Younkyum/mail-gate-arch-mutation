/**
 * src/docs/styles.ts — 문서(`docs.atmark.ai`)의 스타일시트 하나(해시 하나). 모든 페이지가 같은 블록을 싣는다.
 *
 * 브랜드(계획 §6 · 홈과 같은 규율): Pretendard 하나 · 순수 회색(r=g=b) 토큰 · 주황 없음(`@` 도 주변 글자색 — 진윤겸 2026-09-29) · 파란색 없음
 * (링크는 검정 + 밑줄) · 빨강(`danger`)은 되돌릴 수 없는 동작의 콜아웃에만 · 그림자 대신 1px 선(예외: 떠 있는 검색 대화상자) · 그라디언트 없음.
 * 색 값은 **홈 팔레트를 그대로 옮긴 것**이다(`src/site/styles.ts` `SITE_LIGHT`·`SITE_DARK` — 문서 번들은 `src/site/**` 를 import 하지 않는다.
 * 같은지는 `test/unit/docs/docs-sources.test.ts` 가 본다). 비색상 토큰은 공용 `BASE_TOKENS`(`src/ui/tokens.ts`).
 * 테마: 시스템 설정을 따르고, 머리의 테마 버튼(스크립트)이 `html[data-theme]` 로 밝게/어둡게를 고정한다(홈 토큰 블록과 같은 선택자).
 * 한국어 줄바꿈은 `word-break:keep-all`. ASCII 만(해시가 인코딩에 흔들리지 않게).
 */

import { FONT_FACE_CSS } from '../ui/font-faces';
import { BASE_TOKENS } from '../ui/tokens';

export type DocsPalette = Readonly<Record<string, string>>;

export const DOCS_LIGHT: DocsPalette = {
  'background-100': '#F3F3F3',
  'background-200': '#EAEAEA',
  'background-raised': '#FFFFFF',
  'gray-100': '#E9E9E9',
  'gray-200': '#E0E0E0',
  'gray-300': '#D6D6D6',
  'gray-400': '#E0E0E0',
  'gray-500': '#CCCCCC',
  'gray-600': '#808080',
  'gray-700': '#1A1A1A',
  'gray-800': '#333333',
  'gray-900': '#666666',
  'gray-1000': '#171717',
  'gray-alpha-100': 'rgba(0,0,0,.03)',
  'gray-alpha-400': 'rgba(0,0,0,.05)',
  'shadow-near': 'rgba(0,0,0,.06)',
  'shadow-far': 'rgba(0,0,0,.1)',
  scrim: 'rgba(0,0,0,.35)',
  'focus-ring': '#171717',
  'inv-bg': '#171717',
  'inv-fg': '#D4D4D4',
  'inv-strong': '#FFFFFF',
  'inv-muted': '#8E8E8E',
  'inv-line': '#333333',
  glass: 'rgba(255,255,255,.86)',
  'glass-line': 'rgba(255,255,255,.2)',
  'photo-ink': '#FFFFFF',
  'photo-soft': 'rgba(255,255,255,.84)',
  'photo-scrim': 'rgba(0,0,0,.5)',
  'header-glass': 'rgba(243,243,243,.78)',
  lift: 'rgba(0,0,0,.45)',
  'inv-wash': 'rgba(255,255,255,.035)',
  danger: '#B42318',
};

export const DOCS_DARK: DocsPalette = {
  'background-100': '#0E0E0E',
  'background-200': '#171717',
  'background-raised': '#1C1C1C',
  'gray-100': '#1C1C1C',
  'gray-200': '#242424',
  'gray-300': '#2C2C2C',
  'gray-400': '#262626',
  'gray-500': '#3A3A3A',
  'gray-600': '#7C7C7C',
  'gray-700': '#EDEDED',
  'gray-800': '#C9C9C9',
  'gray-900': '#A0A0A0',
  'gray-1000': '#EDEDED',
  'gray-alpha-100': 'rgba(255,255,255,.04)',
  'gray-alpha-400': 'rgba(255,255,255,.08)',
  'shadow-near': 'rgba(0,0,0,.4)',
  'shadow-far': 'rgba(0,0,0,.55)',
  scrim: 'rgba(0,0,0,.6)',
  'focus-ring': '#EDEDED',
  'inv-bg': '#181818',
  'inv-fg': '#A9A9A9',
  'inv-strong': '#EDEDED',
  'inv-muted': '#8E8E8E',
  'inv-line': '#2C2C2C',
  glass: 'rgba(20,20,20,.8)',
  'glass-line': 'rgba(255,255,255,.1)',
  'photo-ink': '#FFFFFF',
  'photo-soft': 'rgba(255,255,255,.84)',
  'photo-scrim': 'rgba(0,0,0,.6)',
  'header-glass': 'rgba(14,14,14,.76)',
  lift: 'rgba(0,0,0,.6)',
  'inv-wash': 'rgba(255,255,255,.035)',
  danger: '#FF8A7A',
};

const decls = (p: DocsPalette): string =>
  Object.entries(p)
    .map(([k, v]) => `--${k}:${v}`)
    .join(';');

const TOKENS =
  `:root{${decls(DOCS_LIGHT)};color-scheme:light}\n` +
  `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${decls(DOCS_DARK)};color-scheme:dark}}\n` +
  `:root[data-theme="dark"]{${decls(DOCS_DARK)};color-scheme:dark}`;

const DARK_SWAP = '.shot .shot-light{display:none}.shot .shot-dark{display:block}';

export const DOCS_CSS = `${FONT_FACE_CSS}
${TOKENS}
${BASE_TOKENS}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;scroll-padding-top:80px}
body{margin:0;background:var(--background-100);color:var(--gray-1000);font-family:var(--font-sans);font-size:16px;line-height:1.5;font-synthesis:none;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;-webkit-tap-highlight-color:transparent;word-break:keep-all;overflow-wrap:break-word}
::selection{background:var(--gray-1000);color:var(--background-100)}
a,a:visited{color:inherit;text-decoration:none}
:focus{outline:none}
:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px;border-radius:4px}
button,input{font:inherit;color:inherit}
button{cursor:pointer}
h1,h2,h3,h4,p,ol,ul,figure{margin:0}
code,kbd,pre{font-family:var(--font-mono)}
[hidden]{display:none !important}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.muted{color:var(--gray-900)}
.ico{display:inline-block;flex:none;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;vertical-align:-3px}
.ico *{vector-effect:non-scaling-stroke}
.skip{position:absolute;left:16px;top:-80px;z-index:var(--z-toast);padding:8px 16px;border-radius:var(--radius-full);background:var(--gray-700);color:var(--background-100);font-size:14px;line-height:20px;font-weight:600}
.skip:visited{color:var(--background-100)}
.skip:focus-visible{top:12px}
.kbd{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:4px;box-shadow:inset 0 0 0 1px var(--gray-500);font-family:var(--font-sans);font-size:11px;line-height:1;font-weight:600;color:var(--gray-900)}

.top{position:sticky;top:0;z-index:var(--z-header);height:var(--header-h);background:var(--background-100);border-bottom:1px solid var(--gray-400)}
.bar{display:flex;align-items:center;gap:8px;height:100%;max-width:1440px;margin:0 auto;padding:0 24px}
.logo{display:inline-flex;align-items:baseline;gap:8px;white-space:nowrap}
/* logo-m = the inline lockup SVG (src/ui/brand.ts); an SVG's baseline is its bottom edge, so "Docs" is lifted onto the wordmark baseline (185/208 of the height) */
.logo-m{display:block;flex:none;width:auto;height:20px;color:var(--gray-1000)}
.logo-d{position:relative;top:-2px;font-size:15px;line-height:1;font-weight:600;color:var(--gray-900)}
.tabs-nav{display:flex;align-items:stretch;gap:4px;height:100%;margin-left:24px}
.tabs-nav a{display:inline-flex;align-items:center;padding:0 10px;font-size:14px;line-height:20px;font-weight:600;color:var(--gray-900);white-space:nowrap}
.tabs-nav a:hover{color:var(--gray-1000)}
.tabs-nav a[aria-current="true"]{color:var(--gray-1000);box-shadow:inset 0 -2px 0 var(--gray-1000)}
.bar-r{display:flex;align-items:center;gap:8px;margin-left:auto}
.search-b{display:inline-flex;align-items:center;gap:8px;height:36px;min-width:220px;padding:0 8px 0 12px;border-radius:var(--radius-full);box-shadow:inset 0 0 0 1px var(--gray-500);font-size:14px;line-height:20px;color:var(--gray-900)}
.search-b:hover{box-shadow:inset 0 0 0 1px var(--gray-600);color:var(--gray-1000)}
.search-t{flex:1}
.plain{display:inline-flex;align-items:center;height:36px;padding:0 10px;border-radius:var(--radius-full);font-size:14px;line-height:20px;font-weight:600;color:var(--gray-900);white-space:nowrap}
.plain:hover{color:var(--gray-1000);background:var(--gray-100)}
.theme-b{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border:0;border-radius:var(--radius-full);background:transparent;color:var(--gray-900)}
.theme-b:hover{color:var(--gray-1000);background:var(--gray-100)}
.theme-b .ico{display:none}
.theme-bl{width:auto;gap:8px;padding:0 14px;min-height:44px;font-size:15px;font-weight:600}
:root:not([data-tc="light"]):not([data-tc="dark"]) .theme-b .th-system,:root[data-tc="light"] .theme-b .th-light,:root[data-tc="dark"] .theme-b .th-dark{display:inline-block}
.btn,.btn:visited{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 22px;border:0;border-radius:var(--radius-full);background:var(--gray-700);color:var(--background-100);font-size:15px;line-height:20px;font-weight:700;white-space:nowrap}
.btn:hover{background:var(--gray-800)}
.btn.sm{height:36px;padding:0 16px;font-size:14px}
.menu-b{display:none;align-items:center;justify-content:center;width:40px;height:40px;margin-left:-8px;padding:0;border:0;border-radius:var(--radius-full);background:transparent;color:var(--gray-1000)}
.menu-b:hover{background:var(--gray-alpha-100)}
.bars{position:relative;display:block;width:16px;height:1.5px;background:currentColor}
.bars::before,.bars::after{content:"";position:absolute;left:0;width:16px;height:1.5px;background:currentColor}
.bars::before{top:-5px}
.bars::after{top:5px}

.shell{display:grid;grid-template-columns:260px minmax(0,1fr) 220px;gap:48px;max-width:1440px;margin:0 auto;padding:0 24px}
.shell-home{display:block}
.side{scrollbar-width:thin;position:sticky;top:var(--header-h);align-self:start;height:calc(100vh - var(--header-h));overflow:auto;margin:0;padding:24px 16px 48px 0;border:0;border-right:1px solid var(--gray-400);background:transparent;color:inherit;right:auto;bottom:auto;left:auto;width:auto}
.side[popover]:not(:popover-open){display:block}
.side-home[popover]:not(:popover-open){display:none}
.side-tabs,.side-x,.side-f{display:none}
.side-g+.side-g{margin-top:24px}
.side-h{margin:0 0 6px;padding:0 10px;font-size:13px;line-height:20px;font-weight:600;color:var(--gray-900)}
.side ul{list-style:none;margin:0;padding:0}
.side li a{display:block;padding:6px 10px;border-radius:var(--radius-sm);font-size:14px;line-height:20px;color:var(--gray-900)}
.side li a:hover{color:var(--gray-1000);background:var(--gray-alpha-100)}
.side li a[aria-current="page"]{color:var(--gray-1000);font-weight:700;background:var(--gray-100)}

.doc{min-width:0;max-width:720px;padding:32px 0 96px}
.crumbs ol{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0;padding:0;font-size:13px;line-height:20px;color:var(--gray-900)}
.crumbs li+li::before{content:"/";margin-right:6px;color:var(--gray-600)}
.crumbs a:hover{color:var(--gray-1000);text-decoration:underline;text-underline-offset:3px}
.doc h1{margin-top:12px;font-size:36px;line-height:44px;font-weight:800;letter-spacing:-0.03em;text-wrap:balance}
.lede{margin-top:12px;font-size:18px;line-height:28px;color:var(--gray-900)}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;margin-top:16px;padding-bottom:24px;border-bottom:1px solid var(--gray-400);font-size:13px;line-height:20px;color:var(--gray-900)}
.meta-b{padding:0;border:0;background:transparent;font-weight:600;color:var(--gray-1000);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
.meta-a{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
.meta-a:hover,.meta-b:hover{color:var(--gray-1000)}
.meta-u{margin-left:auto}

.prose{font-size:16px;line-height:28px}
.prose>*:first-child{margin-top:28px}
.prose>h2:first-child{padding-top:0;border-top:0}
.prose h2,.related h2{margin-top:48px;padding-top:24px;border-top:1px solid var(--gray-400);font-size:24px;line-height:32px;font-weight:700;letter-spacing:-0.02em}
.ha{margin-left:8px;color:var(--gray-600);font-weight:400;text-decoration:none !important;opacity:0}
.prose h2:hover .ha,.prose h3:hover .ha,.prose h4:hover .ha,.ha:focus-visible{opacity:1}
.prose h3{margin-top:32px;font-size:18px;line-height:28px;font-weight:700}
.prose h4{margin-top:24px;font-size:16px;line-height:24px;font-weight:700}
.prose p{margin-top:16px}
.prose ul,.prose ol{margin-top:16px;padding-left:24px}
.prose ul{list-style:disc}
.prose ol{list-style:decimal}
.prose li{margin-top:6px}
.prose li>ul,.prose li>ol{margin-top:6px}
.prose a,.fb a,.tbl-note a,.util-main a:not(.btn){text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;text-decoration-color:var(--gray-600)}
.prose a:hover,.fb a:hover,.tbl-note a:hover{text-decoration-color:var(--gray-1000)}
.prose strong{font-weight:700}
.prose :not(pre)>code{padding:1px 5px;border-radius:4px;background:var(--gray-100);font-size:.875em;overflow-wrap:anywhere}
.tbl{margin-top:20px;overflow-x:auto;border:1px solid var(--gray-400);border-radius:var(--radius-md)}
.tbl table{width:100%;border-collapse:collapse;font-size:14px;line-height:22px}
.tbl td:not(:first-child),.tbl th:not(:first-child){min-width:13em}
.tbl code,.prose .tbl :not(pre)>code{overflow-wrap:normal;word-break:normal;white-space:nowrap}
.tbl th,.tbl td{padding:10px 14px;border-bottom:1px solid var(--gray-400);text-align:left;vertical-align:top}
.tbl thead th{background:var(--background-200);font-weight:600}
.tbl tbody tr:last-child th,.tbl tbody tr:last-child td{border-bottom:0}
.tbl tbody th{font-weight:600}
.limits td{font-variant-numeric:tabular-nums;white-space:nowrap}
.tbl-hint{margin-top:16px;margin-bottom:-12px;font-size:12px;line-height:18px;color:var(--gray-900)}
.tbl-note{margin-top:8px;font-size:13px;line-height:20px;color:var(--gray-900)}
.code{margin-top:20px;overflow:hidden;border:1px solid var(--gray-400);border-radius:var(--radius-md);background:var(--gray-100)}
.code-h{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;padding:0 6px 0 14px;border-bottom:1px solid var(--gray-400);font-size:12px;line-height:16px;font-weight:600;color:var(--gray-900)}
.copy{height:32px;min-width:44px;padding:0 10px;border:0;border-radius:var(--radius-sm);background:transparent;font-size:12px;font-weight:600;color:var(--gray-900)}
.copy:hover{color:var(--gray-1000);background:var(--gray-alpha-400)}
.code pre{margin:0;padding:14px 16px;overflow-x:auto;font-size:13.5px;line-height:22px;word-break:normal;overflow-wrap:normal;white-space:pre}
.callout{margin-top:20px;padding:14px 16px;border:1px solid var(--gray-500);border-radius:var(--radius-md)}
.callout>.c-t{margin:0;font-size:14px;line-height:22px;font-weight:700}
.callout>.c-t+*{margin-top:4px}
.callout p,.callout ul,.callout ol{font-size:15px;line-height:26px}
.c-danger{border-color:var(--danger)}
.c-danger>.c-t{color:var(--danger)}
.prose .steps{list-style:none;counter-reset:step;margin-top:24px;padding:0}
.steps>li{position:relative;counter-increment:step;margin:0;padding:0 0 24px 44px}
.steps>li::before{content:counter(step);position:absolute;left:0;top:0;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:var(--radius-full);background:var(--gray-1000);color:var(--background-100);font-size:13px;line-height:1;font-weight:700}
.steps>li::after{content:"";position:absolute;left:13.5px;top:36px;bottom:8px;width:1px;background:var(--gray-500)}
.steps>li:last-child{padding-bottom:0}
.steps>li:last-child::after{display:none}
.prose .steps>li>h2,.prose .steps>li>h3,.prose .steps>li>h4{margin-top:0;padding-top:0;border-top:0;font-size:18px;line-height:28px;font-weight:700;letter-spacing:0}
.prose .cards,.related .cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;list-style:none;margin-top:20px;padding:0}
.cards li{margin:0}
.card{display:block;height:100%;padding:16px 18px;border:1px solid var(--gray-400);border-radius:var(--radius-md);text-decoration:none !important;transition:border-color var(--dur-fast) ease}
.card:hover{border-color:var(--gray-1000)}
.card-t{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:15px;line-height:22px;font-weight:700}
.card-t .ico{color:var(--gray-900)}
.card-d{display:block;margin-top:4px;font-size:14px;line-height:22px;color:var(--gray-900)}
.tabs{margin-top:20px}
.tab-l{margin-top:16px !important;font-size:13px;line-height:20px;font-weight:700;color:var(--gray-900)}
.tabs.js .tab-l{display:none}
.tabs.js .tab>*:first-child+*{margin-top:12px}
.tablist{display:flex;gap:4px;overflow-x:auto;border-bottom:1px solid var(--gray-400)}
.tablist button{flex:none;height:36px;padding:0 12px;border:0;background:transparent;font-size:14px;font-weight:600;color:var(--gray-900);white-space:nowrap}
.tablist button:hover{color:var(--gray-1000)}
.tablist button[aria-selected="true"]{color:var(--gray-1000);box-shadow:inset 0 -2px 0 var(--gray-1000)}
.prose details{margin-top:0;border-bottom:1px solid var(--gray-400)}
.prose details:first-of-type,.prose :not(details)+details{margin-top:20px;border-top:1px solid var(--gray-400)}
.prose summary{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;list-style:none;cursor:pointer;font-weight:600}
.prose summary::-webkit-details-marker{display:none}
.prose summary::after{content:"+";flex:none;font-size:20px;line-height:1;font-weight:400;color:var(--gray-900)}
.prose details[open]>summary::after{content:"\\2212"}
.dt-b{padding-bottom:16px}
.dt-b>*:first-child{margin-top:0}
.shot{margin-top:24px}
.shot>a{display:block;border-radius:var(--radius-md)}
.shot figcaption{margin-top:8px;font-size:13px;line-height:20px;color:var(--gray-900)}
.shot img{display:block;width:100%;height:auto;border:1px solid var(--gray-400);border-radius:var(--radius-md);background:var(--background-200)}
.shot .shot-dark{display:none}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) ${DARK_SWAP.replace('}.shot', '}:root:not([data-theme="light"]) .shot')}}
:root[data-theme="dark"] ${DARK_SWAP.replace('}.shot', '}:root[data-theme="dark"] .shot')}
.prose .tools{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0}
.tools li{margin:0}
.related{margin-top:56px}
.pn{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:48px}
.pn-a{display:flex;flex-direction:column;gap:4px;padding:14px 16px;border:1px solid var(--gray-400);border-radius:var(--radius-md)}
.pn-a:hover{border-color:var(--gray-1000)}
.pn-next{align-items:flex-end;text-align:right}
.pn-l{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:20px;color:var(--gray-900)}
.pn-t{font-size:15px;line-height:22px;font-weight:600}
.fb{margin-top:32px;font-size:13px;line-height:20px;color:var(--gray-900)}

.toc{position:sticky;top:var(--header-h);align-self:start;max-height:calc(100vh - var(--header-h));overflow:auto;padding:32px 0}
.toc-h{font-size:13px;line-height:20px;font-weight:700}
.toc ul{list-style:none;margin:8px 0 0;padding:0;border-left:1px solid var(--gray-400)}
.toc li a{display:block;margin-left:-1px;padding:4px 12px;border-left:1px solid transparent;font-size:13px;line-height:20px;color:var(--gray-900)}
.toc li.l3 a{padding-left:24px}
.toc li a:hover{color:var(--gray-1000)}
.toc li a[aria-current="true"]{color:var(--gray-1000);font-weight:600;border-left-color:var(--gray-1000)}

.home-main{max-width:1080px;margin:0 auto;padding:0 0 96px}
.hero{padding:64px 0 16px}
.hero h1{font-size:44px;line-height:52px;font-weight:800;letter-spacing:-0.035em;text-wrap:balance}
.hero .lede{max-width:640px}
.hero-s{display:flex;align-items:center;gap:10px;max-width:560px;height:52px;margin-top:28px;padding:0 6px 0 18px;border-radius:var(--radius-full);box-shadow:inset 0 0 0 1px var(--gray-500);color:var(--gray-900)}
.hero-s:focus-within{box-shadow:inset 0 0 0 2px var(--focus-ring)}
.hero-s input{flex:1;min-width:0;height:100%;border:0;background:transparent;font-size:16px;color:var(--gray-1000);outline:none}
.hero-s input::placeholder,.sd-q::placeholder{color:var(--gray-900)}
.home-prose{max-width:none}
.home-prose .cards{grid-template-columns:repeat(2,minmax(0,1fr))}
.idx{margin-top:64px;padding-top:32px;border-top:1px solid var(--gray-400)}
.idx-h{font-size:24px;line-height:32px;font-weight:700;letter-spacing:-0.02em}
.idx-t{margin-top:32px}
.idx-t h2{font-size:15px;line-height:22px;font-weight:700;color:var(--gray-900)}
.idx-gs{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:24px 32px;margin-top:12px}
.idx-g h3{font-size:15px;line-height:22px;font-weight:700}
.idx-g ul{list-style:none;margin:6px 0 0;padding:0}
.idx-g li a{display:block;padding:3px 0;font-size:14px;line-height:22px;color:var(--gray-900)}
.idx-g li a:hover{color:var(--gray-1000);text-decoration:underline;text-underline-offset:3px}
.util-main{max-width:720px;padding-top:64px}
.util-main h1{font-size:32px;line-height:40px;font-weight:800;letter-spacing:-0.03em}
.util-main .lede+*{margin-top:24px}
.sr-list{list-style:none;margin:24px 0 0;padding:0;border-top:1px solid var(--gray-400)}
.sr-list li{padding:16px 0;border-bottom:1px solid var(--gray-400)}
.sr-list a{font-size:16px;line-height:24px;font-weight:600}
.sr-list .sr-h{display:block;font-size:13px;line-height:20px;color:var(--gray-900)}
.sr-list p{margin-top:4px;font-size:14px;line-height:22px;color:var(--gray-900)}
.sr-more{display:flex;flex-wrap:wrap;gap:4px 16px;list-style:none;margin:6px 0 0;padding:0}
.sr-more li{padding:0;border:0}
.sr-more a{font-size:14px;line-height:22px;font-weight:500;color:var(--gray-900);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
.sr-pop{margin-top:32px;font-size:15px;line-height:22px;font-weight:700}
.sd-r .r-sub{padding:6px 12px 6px 28px;font-size:13px;line-height:20px;color:var(--gray-900)}
.nf-code{font-size:14px;line-height:20px;font-weight:600;color:var(--gray-900)}
.util-main .hero-s{margin-top:24px}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}

.foot{border-top:1px solid var(--gray-400)}
.foot-in{display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px;max-width:1440px;margin:0 auto;padding:28px 24px 40px;font-size:13px;line-height:20px}
.foot .logo{align-items:center}
.foot-l{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:14px;color:var(--gray-900)}
.foot-l a:hover{color:var(--gray-1000)}
.foot .muted{margin-left:auto;font-size:13px}

.sd{width:min(640px,calc(100vw - 32px));max-height:min(560px,calc(100vh - 96px));margin:12vh auto auto;padding:0;overflow:hidden;border:0;border-radius:var(--radius-lg);background:var(--background-raised);color:var(--gray-1000);box-shadow:var(--shadow-modal)}
.sd[open]{display:flex;flex-direction:column}
.sd::backdrop{background:var(--scrim)}
.sd-f{display:flex;align-items:center;gap:10px;flex:none;height:56px;padding:0 10px 0 16px;border-bottom:1px solid var(--gray-400);color:var(--gray-900)}
.sd-q{flex:1;min-width:0;height:100%;border:0;background:transparent;font-size:16px;color:var(--gray-1000);outline:none}
.sd-q::-webkit-search-cancel-button{display:none}
.sd-x{display:inline-flex;align-items:center;padding:4px;border:0;border-radius:var(--radius-sm);background:transparent}
.sd-r{flex:1;list-style:none;margin:0;padding:8px;overflow:auto}
.sd-r:empty{display:none}
.sd-r a{display:block;padding:10px 12px;border-radius:var(--radius-sm)}
.sd-r a:hover{background:var(--gray-100)}
.sd-r a:focus-visible,.sd-r a[aria-selected="true"]{background:var(--gray-200);box-shadow:inset 3px 0 0 var(--gray-1000);outline:none}
.sd-r .r-t{display:block;font-size:14px;line-height:20px;font-weight:600}
.sd-r .r-h{display:block;font-size:13px;line-height:20px;color:var(--gray-900)}
.sd-r .r-x{display:block;margin-top:2px;font-size:13px;line-height:20px;color:var(--gray-900);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-r .r-none{padding:16px 12px;font-size:14px;color:var(--gray-900)}

html[lang="ko"] .doc h1,html[lang="ko"] .hero h1{letter-spacing:-0.03em}
@media (max-width:1279px){.shell{grid-template-columns:260px minmax(0,1fr)}.toc{display:none}}
@media (max-width:1023px){
.shell{display:block;padding:0 20px}
.tabs-nav{display:none}
.menu-b{display:inline-flex}
.side,.side[popover]:not(:popover-open){display:none}
.side:popover-open,.side-home:popover-open{display:block;position:fixed;align-self:auto;inset:var(--header-h) auto 0 0;width:min(320px,86vw);height:auto;max-height:none;margin:0;padding:16px 16px 48px;border:0;border-right:1px solid var(--gray-400);background:var(--background-100);overflow:auto;z-index:var(--z-sidebar)}
.side::backdrop{background:var(--scrim)}
.side-tabs{display:flex;flex-direction:column;gap:2px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--gray-400)}
.side-tabs a{display:block;padding:8px 10px;border-radius:var(--radius-sm);font-size:15px;line-height:22px;font-weight:600;color:var(--gray-900)}
.side-tabs a[aria-current="true"]{color:var(--gray-1000);background:var(--gray-100)}
.side-x{display:flex;justify-content:flex-end;margin:-4px 0 8px}
.side-x button{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 14px;border:0;border-radius:var(--radius-full);background:var(--gray-100);font-size:14px;font-weight:600;color:var(--gray-1000)}
.side-f{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:24px;padding-top:16px;border-top:1px solid var(--gray-400)}
.side-f a{display:inline-flex;align-items:center;min-height:44px;padding:0 10px;font-size:15px;font-weight:600;color:var(--gray-900)}
.side li a{min-height:44px;display:flex;align-items:center;padding:10px 10px}
.side-tabs a{min-height:44px;display:flex;align-items:center}
.doc{max-width:720px;margin:0 auto}
.home-main{padding-bottom:64px}
}
@media (max-width:767px){
.bar{padding:0 12px 0 16px;gap:4px}
.search-b{min-width:0;width:44px;height:44px;padding:0;justify-content:center;box-shadow:none}
.theme-b,.menu-b{width:44px;height:44px}
.btn.sm{height:44px}
.bar-r{gap:2px}
.copy{height:36px}
.search-b .search-t,.search-b .kbd{display:none}
.bar-r .lang{display:none}
.doc{padding-top:20px}
.doc h1{font-size:30px;line-height:38px}
.hero{padding-top:40px}
.hero h1{font-size:32px;line-height:40px}
.prose .cards,.related .cards{grid-template-columns:minmax(0,1fr)}
.pn{grid-template-columns:minmax(0,1fr)}
.meta-u{margin-left:0}
.foot .muted{margin-left:0}
.foot-in{padding-left:16px;padding-right:16px}
.prose h2,.related h2{font-size:22px;line-height:30px}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none !important;scroll-behavior:auto !important}}
`;
