/**
 * src/site/styles.ts — 홈(`atmark.ai`)의 스타일시트 하나(해시 하나). 모든 페이지(홈·가격·개인정보·약관·환불·로그인·가입·404)가 같은 블록을 싣는다.
 *
 * 방향: 옅은 회색 종이 캔버스(`background-100`) · 흑백 · 따뜻함은 사진이 맡는다. 히어로는 어둡게 가라앉힌 사진 위 가운데 정렬 헤드라인과
 * 무대(`.stage`) · 아래 절은 큰 제목과 넓은 간격 · 사진 위에 겹친 카드 · 움직이는 선 그림(CSS 키프레임, 멈춘 첫 장면도 뜻이 통한다) ·
 * 스크롤에 맞춘 떠오름(`.rv` — `animation-timeline: view()`, 모르는 브라우저는 처음부터 보임, `forwards` 만 — 화면 밖에서는 효과가 걸리지
 * 않아 전체 페이지 캡처에도 보인다). 모션 줄이기에서는 모든 움직임이 멈춘다.
 * 머리는 세 칸 격자(`.bar3` — 주 메뉴가 정확히 가운데) · 로그인 여부(`html.signed-in`)로 `.si`·`.so` 를 켜고 끈다.
 *   - 색은 **토큰(CSS 변수)으로만** 쓴다 — 값은 맨 앞 토큰 블록(`SITE_LIGHT` · `SITE_DARK`)에만 있다. **완전 흑백**(`@` 도 글자색).
 *     무채색(r=g=b) 밖의 색은 폼 오류(`danger`) 하나뿐. **파란색·보라 그라디언트 금지 — 예외 없음.** 예시 ID 카드의 신원 무늬도 토큰이다.
 *     그라디언트는 사진 위 가독성 막(`photo-scrim` → 투명) 하나뿐이다(글자·장식에는 없다).
 *   - 장식 번호 없음 — 네 단계는 `<ol>` 의미 + 칸 위 굵은 선으로 순서를 보인다. 법적 조항 번호(`ol.list`)만 남는다.
 * 다크 모드: 시스템 설정(`prefers-color-scheme`)을 따른다 — 같은 구조를 어두운 무채색으로. 사진은 같고 유리 카드·머리가 어두운 벌로 바뀐다.
 * 대비는 `site-theme.test.ts` 가 잰다. 사진 위 글자는 늘 흰색(`photo-ink`)이고 아래에 어두운 막(`photo-scrim`)이 깔린다.
 * 폰트: Pretendard Variable 하나(본문·헤드라인 — `src/ui/fonts.ts`, 같은 오리진 `/_fonts/…`, CSP `font-src 'self'`).
 * 한국어 줄바꿈은 `word-break:keep-all`(어절 단위). ASCII 만(해시가 인코딩에 흔들리지 않게 — 글리프는 `\\2715` 꼴 이스케이프).
 * 스크립트가 없는 페이지의 상호작용은 CSS 와 popover 뿐이다(모바일 메뉴).
 */

import { FONT_FACE_CSS } from '../ui/fonts';
import { BASE_TOKENS } from '../ui/tokens';
import { HERO_AGENT_NAMES, HERO_NAME_SECONDS } from './hero-names';

type SiteToken =
  | 'background-100'
  | 'background-200'
  | 'background-raised'
  | 'gray-100'
  | 'gray-200'
  | 'gray-300'
  | 'gray-400'
  | 'gray-500'
  | 'gray-600'
  | 'gray-700'
  | 'gray-800'
  | 'gray-900'
  | 'gray-1000'
  | 'gray-alpha-100'
  | 'gray-alpha-400'
  | 'shadow-near'
  | 'shadow-far'
  | 'scrim'
  | 'focus-ring'
  | 'inv-bg'
  | 'inv-fg'
  | 'inv-strong'
  | 'inv-muted'
  | 'inv-line'
  | 'glass'
  | 'glass-line'
  | 'photo-ink'
  | 'photo-soft'
  | 'photo-scrim'
  | 'header-glass'
  | 'lift'
  | 'inv-wash'
  | 'danger';

/**
 * 색 토큰 한 벌 — 이름은 `--` 를 뗀 것. 이름은 콘솔·공용 `BASE_TOKENS` 와 같은 체계(공용 블록이 `background-*`·`gray-*`·그림자 이름을 참조한다)이고
 * 값만 사이트 팔레트로 바꿨다. 사이트 전용: `inv-*`(ID 카드 뒷면 · 어두운 패널) · `danger`(폼 오류).
 */
export type SitePalette = Readonly<Record<SiteToken, string>>;

/**
 * 밝은 벌(기본) — 옅은 회색 종이 캔버스 #F3F3F3 · 교대 띠 #EAEAEA · 떠오르는 카드만 흰색 · 가는 선 #E0E0E0 · 잉크 #171717 · 보조 #666666
 * (띠·채움 위에서도 4.5:1). **순수 회색(r=g=b)** — 이 사이트의 "무채색" 불변식. 사이트 전용: `inv-*`(ID 카드 뒷면 · 어두운 띠) ·
 * `glass*`(사진 위 유리 카드 — 흰 86% · 1px 흰 20% 선) · `photo-*`(사진 위 글자 · 가독성 막) · `header-glass`(끈적한 머리의 반투명 바탕) ·
 * `lift`(사진 위에 뜬 카드의 그림자 — 깊이) · `danger`(폼 오류).
 */
export const SITE_LIGHT: SitePalette = {
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

/**
 * 어두운 벌 — 같은 구조를 어두운 무채색으로. 캔버스 #0E0E0E · 번갈아 쓰는 띠 #171717 · 떠 있는 카드는 한 단 위(#1C1C1C). ID 카드 뒷면은
 * 뒤집지 않고 한 단 떠 있는 어두운 면(윤곽은 1px 선 `inv-line`). 유리 카드는 어두운 유리(흰 글자), 사진 위 글자는 그대로 흰색.
 */
export const SITE_DARK: SitePalette = {
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

const decls = (p: SitePalette): string =>
  Object.entries(p)
    .map(([k, v]) => `--${k}:${v}`)
    .join(';');

/**
 * 토큰 블록 — 밝은 벌이 기본, 시스템이 다크면 어두운 벌. `html[data-theme="light"|"dark"]` 은 미디어 쿼리를 이긴다.
 * `color-scheme` 도 같이 바꿔 폼 컨트롤·스크롤바가 따라온다. 테스트 파서는 **첫 `:root{…}` = 밝은 벌**로 읽으므로 비색상 블록은 그 뒤에 둔다.
 */
const SITE_TOKENS =
  `:root{${decls(SITE_LIGHT)};color-scheme:light}\n` +
  `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${decls(SITE_DARK)};color-scheme:dark}}\n` +
  `:root[data-theme="dark"]{${decls(SITE_DARK)};color-scheme:dark}`;

/** 결제 호스트(`pay.atmark.ai`)용 — `@font-face` 없음(그 호스트엔 `/_fonts/` 경로가 없고 CSP 에 `font-src` 도 없다). 헤드라인은 시스템 산세리프로. */

/**
 * 히어로 주소의 바뀌는 이름(`hero-names.ts`) — 이름마다 같은 `word` 를 차례로 늦춰 돌리고, 칸 폭(`rwidth`)은 지금 이름의 글자 수(고정폭 글꼴의
 * `ch`)를 따라가서 `@` 앞에 빈칸이 없고 줄 전체가 가운데를 유지한다. `overflow:clip` — `hidden` 은 인라인 상자의 기준선을 아래로 내려(진윤겸
 * 2026-09-30 "정렬이 애매") 쓰지 않는다. 모션 줄이기면 첫 이름·첫 폭에 멈춘다(아래 reduce 블록).
 */
const HERO_NAME_CSS = ((): string => {
  const n = HERO_AGENT_NAMES.length;
  const total = n * HERO_NAME_SECONDS;
  const seg = 100 / n;
  const fade = 2.5;
  const pct = (v: number): string => `${Number(v.toFixed(3))}%`;
  const widths = HERO_AGENT_NAMES.map((name, i) => `${pct(i === 0 ? 0 : i * seg)},${pct((i + 1) * seg - fade)}{width:${name.length}ch}`).join('');
  const delays = HERO_AGENT_NAMES.map((_, i) => (i === 0 ? '' : `.rw .w${i + 1}{animation-delay:${i * HERO_NAME_SECONDS}s}`)).join('');
  return (
    `.rw{display:inline-grid;grid-template-columns:minmax(0,1fr);vertical-align:baseline;overflow:clip;text-align:right;width:${HERO_AGENT_NAMES[0].length}ch;animation:rwidth ${total}s ease-in-out infinite}\n` +
    `.rw>span{grid-area:1/1;justify-self:end;white-space:nowrap;opacity:0;animation:word ${total}s linear infinite}\n` +
    `${delays}\n` +
    `@keyframes rwidth{${widths}100%{width:${HERO_AGENT_NAMES[0].length}ch}}\n` +
    `@keyframes word{0%{opacity:0;transform:translateY(.35em)}${pct(fade)},${pct(seg - fade)}{opacity:1;transform:none}${pct(seg)},100%{opacity:0;transform:translateY(-.35em)}}`
  );
})();

export const SITE_CSS_NO_FONTS = `
${SITE_TOKENS}
${BASE_TOKENS}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;scroll-behavior:smooth}
body{--header-h:72px;--r-card:12px;--r-big:20px;--r-img:16px;--r-input:9px;--settle:cubic-bezier(.33,1,.68,1);margin:0;background:var(--background-100);color:var(--gray-1000);font-family:var(--font-sans);font-size:16px;line-height:1.5;font-synthesis:none;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;-webkit-tap-highlight-color:transparent;word-break:keep-all;overflow-wrap:break-word}
::selection{background:var(--gray-1000);color:var(--background-100)}
a,a:visited{color:inherit;text-decoration:none;text-underline-offset:3px;transition:color var(--dur-fast) ease,background-color var(--dur-fast) ease,text-decoration-color var(--dur-fast) ease}
a:hover{text-decoration:underline;text-decoration-thickness:1px}
:focus{outline:none}
:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
button,input,select,textarea{font:inherit;color:inherit;accent-color:var(--gray-1000)}
h1,h2,h3{margin:0;font-weight:600}
h1,h2[id$="-title"]{font-weight:800;line-height:1.08;letter-spacing:-0.04em;text-wrap:balance}
h2[id$="-title"]{font-weight:700;line-height:1.12;letter-spacing:-0.035em}
html[lang="ko"] h1,html[lang="ko"] h2[id$="-title"]{letter-spacing:-0.03em;line-height:1.2}
p,ol,ul,dl,dd,figure{margin:0}
ol,ul{padding:0;list-style:none}
code,.mono{font-family:var(--font-mono);font-size:.9em}
[id]{scroll-margin-top:calc(var(--header-h) + 16px)}
[hidden]{display:none !important}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

.skip{position:absolute;left:16px;top:-80px;z-index:var(--z-popover);padding:8px 16px;border-radius:var(--radius-full);background:var(--gray-700);color:var(--background-100);font-size:14px;line-height:20px;font-weight:600}
.skip:visited{color:var(--background-100)}
.skip:focus-visible{top:12px}
.wrap{width:100%;max-width:1200px;margin:0 auto;padding-left:20px;padding-right:20px}
.kicker{font-size:14px;line-height:20px;color:var(--gray-900)}
.muted{color:var(--gray-900)}
.addr{font-weight:500;white-space:nowrap}
.ico{display:inline-block;flex:none;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;vertical-align:-3px}
.ico *{vector-effect:non-scaling-stroke}

.top{position:sticky;top:0;z-index:var(--z-header);--hdr-ink:var(--gray-1000);--hdr-soft:var(--gray-900);--hdr-btn:var(--gray-700);--hdr-btn-ink:var(--background-100);color:var(--hdr-ink);background:var(--header-glass);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:inset 0 -1px 0 var(--gray-400)}
.bar{display:flex;align-items:center;gap:8px;height:var(--header-h)}
.bar3{display:grid;grid-template-columns:minmax(0,1fr) auto auto;column-gap:8px}
.bar-l{display:flex;align-items:center;gap:14px;min-width:0}
.bar3 .nav{margin-left:0;justify-self:end}
.si{display:none !important}
.signed-in .si{display:inline-flex !important}
.signed-in .so{display:none !important}
/* over the photo hero (html.at-hero, toggled by the head script from scroll position): photo ink, light button with dark text, no glass */
.top{transition:background-color .25s ease,box-shadow .25s ease}
.at-hero .top{--hdr-ink:var(--photo-ink);--hdr-soft:var(--photo-soft);--hdr-btn:var(--photo-ink);--hdr-btn-ink:var(--inv-bg);background:transparent;box-shadow:inset 0 -1px 0 transparent;-webkit-backdrop-filter:none;backdrop-filter:none;animation:none}
.hint-wait .auth-main{visibility:hidden}
/* logo = the inline lockup SVG (src/ui/brand.ts), sized by height, painted with currentColor */
.logo{display:inline-flex;align-items:center;flex:none;line-height:0}
.brand{display:block;flex:none;width:auto;height:22px}
a.logo:hover{text-decoration:none}
.nav-main{display:none;align-items:center;gap:4px}
.nav-main a,.nav a.plain{display:inline-flex;align-items:center;height:36px;padding:0 14px;border-radius:var(--radius-full);font-size:14px;line-height:20px;font-weight:500;color:var(--hdr-soft);white-space:nowrap}
.nav-main a:hover,.nav a.plain:hover{color:var(--hdr-ink);background:var(--gray-alpha-400);text-decoration:none}
.nav-main a[aria-current="page"],.nav a.plain[aria-current="page"]{color:var(--gray-1000);background:var(--gray-100)}
.nav{display:flex;align-items:center;gap:4px;margin-left:auto}
.acct a.plain{display:none}
.mnav-b{display:none;align-items:center;justify-content:center;width:40px;height:40px;padding:0;border:0;border-radius:var(--radius-full);background:transparent;cursor:pointer;color:var(--hdr-ink);transition:background-color var(--dur-fast) ease}
.mnav-b:hover{background:var(--gray-alpha-100)}
.bars{position:relative;display:block;width:16px;height:1.5px;background:currentColor;transition:background-color var(--dur-fast) ease}
.bars::before,.bars::after{content:"";position:absolute;left:0;width:16px;height:1.5px;background:currentColor;transition:transform var(--dur-base) var(--ease-out)}
.bars::before{top:-5px}
.bars::after{top:5px}
.top:has(.mnav-p:popover-open) .bars{background:transparent}
.top:has(.mnav-p:popover-open) .bars::before{transform:translateY(5px) rotate(45deg)}
.top:has(.mnav-p:popover-open) .bars::after{transform:translateY(-5px) rotate(-45deg)}
.mnav-p{display:none}
.mnav-p a{display:flex;align-items:center;height:48px;border-bottom:1px solid var(--gray-400);font-size:17px;font-weight:500;color:var(--gray-1000)}
.mnav-p a:last-child{border-bottom:0}
.mnav-p a:hover{text-decoration:none}
.mnav-p a[aria-current="page"]{font-weight:700}
.mnav-p a.lang{font-size:15px;color:var(--gray-900)}

.btn,.btn:visited{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 22px;border:0;border-radius:var(--radius-full);background:var(--gray-700);color:var(--background-100);font-size:15px;line-height:20px;font-weight:700;white-space:nowrap;cursor:pointer;transition:background-color var(--dur-fast) ease,box-shadow var(--dur-fast) ease,color var(--dur-fast) ease}
.btn:hover{background:var(--gray-800);text-decoration:none}
.btn.ghost,.btn.ghost:visited{background:transparent;color:var(--gray-1000);box-shadow:inset 0 0 0 1px var(--gray-1000)}
.btn.ghost:hover{background:var(--gray-alpha-100)}
.btn.ghost:active{background:var(--gray-200)}
.btn.ghost[aria-current="page"]{background:var(--gray-100)}
.btn.sm{height:36px;padding:0 16px;font-size:14px}
.top .btn.sm:not(.ghost),.top .btn.sm:not(.ghost):visited{background:var(--hdr-btn);color:var(--hdr-btn-ink)}
.actions.lg .btn{height:48px;padding:0 26px;font-size:16px}
.btn .arr{transition:transform var(--dur-fast) ease}
.btn:hover .arr{transform:translateX(2px)}
button.btn{font-family:inherit}
button.btn:disabled{cursor:not-allowed;background:var(--gray-100);color:var(--gray-900);box-shadow:inset 0 0 0 1px var(--gray-300)}
.btn.busy{cursor:progress}
.btn.busy::before{content:"";width:12px;height:12px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:32px}

.pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 10px;border-radius:var(--radius-full);background:var(--gray-100);color:var(--gray-1000);font-size:13px;line-height:18px;font-weight:600;white-space:nowrap}
.pill .dot{width:6px;height:6px;border-radius:50%;background:var(--gray-1000)}
.pill.bad{overflow:hidden;padding-left:0;background:var(--background-100);box-shadow:inset 0 0 0 1px var(--gray-1000)}
.pill.bad::before{content:"";align-self:stretch;width:8px;margin-right:4px;background:var(--hatch-pill);box-shadow:inset -1px 0 0 var(--gray-1000)}
.lbl,.pc{display:block;width:fit-content;max-width:100%;font-family:var(--font-sans);font-size:14px;line-height:20px;font-weight:500;letter-spacing:-0.005em;color:var(--gray-900);word-break:normal;overflow-wrap:anywhere}

main{display:block}
.sec{padding:72px 0}
.sec.tone{background:var(--background-200)}
.sec-in{width:100%;max-width:1200px;margin:0 auto;padding:0 20px}
.sec-head{max-width:760px;margin-bottom:36px}
.sec-head h2{font-size:34px}
main .sec-head h2,.cta-card h2{font-weight:500;letter-spacing:-0.028em}
.sec-note{margin-top:14px;font-size:16px;line-height:1.55;color:var(--gray-900)}
.sec-note a{color:var(--gray-1000);font-weight:600;text-decoration:underline;text-decoration-color:var(--gray-500)}

.sec-lede{max-width:26em;margin-top:20px;font-size:18px;line-height:1.5;color:var(--gray-900)}

.hero{position:relative;isolation:isolate;margin-top:calc(-1 * var(--header-h));padding:calc(var(--header-h) + 36px) 0 24px;overflow:hidden;background:var(--inv-bg);color:var(--photo-ink)}
.hero ::selection{background:var(--photo-ink);color:var(--inv-bg)}
.hero-media{position:absolute;inset:0;z-index:-1;overflow:hidden}
.hero-media img{display:block;width:100%;height:100%;object-fit:cover;object-position:62% 50%;filter:saturate(.85);animation:settle-in 2400ms var(--settle) both}
.hero-media::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,var(--photo-scrim) 0%,var(--photo-scrim) 48%,transparent 100%),linear-gradient(180deg,var(--photo-scrim),var(--photo-scrim))}
.hero-in{position:relative;display:flex;flex-direction:column;align-items:center;width:100%;max-width:1240px;margin:0 auto;padding:0 16px}
.hero-copy{max-width:880px;text-align:center;animation:rise 900ms var(--settle) both}
.hero h1{margin:0;font-weight:500;letter-spacing:-0.04em;line-height:1.02;font-size:clamp(42px,4.2vw + 14px,80px)}
html[lang="ko"] .hero h1{font-weight:560;letter-spacing:-0.035em;line-height:1.14;font-size:clamp(36px,3.8vw + 12px,70px)}
.hero .lede{max-width:36em;margin:18px auto 0;font-size:17px;line-height:1.55;color:var(--photo-soft);text-wrap:pretty}
.hero .lede .addr{color:var(--photo-ink)}
/* gate B (2026-10-01, marketing plan 2.4): proof line under the lede, then two small lines under the CTA (invite-only, MCP runtimes - text only) */
${HERO_NAME_CSS}
.hero .actions{justify-content:center;align-items:center;margin-top:26px}
.hero .btn:not(.ghost),.hero .btn:not(.ghost):visited{background:var(--photo-ink);color:var(--inv-bg)}
.hero .btn:not(.ghost):hover{background:var(--photo-soft)}
.hero .btn.ghost,.hero .btn.ghost:visited{color:var(--photo-ink);box-shadow:inset 0 0 0 1px var(--photo-soft)}
.hero .btn.ghost:hover{background:var(--glass-line)}

.stage{position:relative;display:grid;place-items:center;width:100%;max-width:1160px;margin:28px auto 0;padding:92px 0 104px}
.stage .hero-id{position:relative;z-index:2;width:100%;max-width:340px;color:var(--gray-1000);box-shadow:inset 0 0 0 1px var(--gray-400),0 40px 90px -30px var(--lift);animation:pop 700ms var(--settle) 150ms both}
.stage .hero-id ::selection{background:var(--gray-1000);color:var(--background-100)}
.glass{min-width:0;padding:14px 16px;border-radius:16px;background:var(--glass);box-shadow:inset 0 0 0 1px var(--glass-line),0 24px 60px -24px var(--lift);color:var(--gray-1000);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);font-size:14px;line-height:20px}
.glass ::selection{background:var(--gray-1000);color:var(--background-100)}
/* mail cards fly in from outside their own corner, one after another, after the ID card pops (--fx/--fy = start offset) */
.stage .m{position:absolute;z-index:3;width:212px;text-align:left;animation:fly 520ms cubic-bezier(.16,1,.3,1) both,bob 7s ease-in-out infinite alternate}
.m1{top:8px;right:0;--fx:140px;--fy:-60px;animation-delay:900ms,2s}
.m2{bottom:10px;left:0;--fx:-140px;--fy:60px;animation-delay:1040ms,2.6s}
.m3,.m4{display:none}
.m3{animation-delay:1180ms,2.3s}
.m4{animation-delay:1320ms,2.9s}
.gh{display:flex;justify-content:space-between;align-items:center;gap:10px;min-height:22px;font-size:13px;line-height:18px;color:var(--gray-900)}
.gk{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:var(--gray-1000)}
.gt{font-weight:500;font-variant-numeric:tabular-nums}
.gs{margin-top:10px;font-size:15px;line-height:22px;font-weight:600}
.gcode{margin-top:2px;font-family:var(--font-mono);font-size:26px;line-height:34px;font-weight:500;letter-spacing:.08em;font-variant-numeric:tabular-nums}
.gf{margin-top:4px;font-size:13px;line-height:18px;color:var(--gray-900)}
.gf.mono{font-family:var(--font-mono);font-size:12px}
.gf .addr{color:var(--gray-1000)}
.m .pill{height:20px;padding:0 8px;font-size:12px}
.idc .pill{background:var(--background-200)}

.sep-in{display:grid;grid-template-columns:minmax(0,1fr);gap:40px;align-items:center}
.sep-copy{min-width:0}
.sep-copy h2,.cta-card h2{font-size:clamp(38px,4.4vw + 12px,80px);font-weight:500;letter-spacing:-0.045em;line-height:1.02;text-wrap:balance}
html[lang="ko"] .sep-copy h2,html[lang="ko"] .cta-card h2{font-weight:560;letter-spacing:-0.035em;line-height:1.16;font-size:clamp(34px,3.4vw + 12px,64px)}
.sep-fig{position:relative;min-width:0;padding:0 0 88px}
.photo{overflow:hidden;border-radius:var(--r-img);background:var(--background-200)}
.photo img{display:block;width:100%;height:auto;aspect-ratio:4/3;object-fit:cover}
.box{position:absolute;width:min(78%,330px);padding:14px 18px 8px;border-radius:16px;font-size:15px;line-height:22px}
.box.you{top:20px;left:12px;background:var(--glass);color:var(--gray-1000);box-shadow:inset 0 0 0 1px var(--glass-line);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px)}
.box.agent{right:12px;bottom:0;background:var(--inv-bg);color:var(--inv-strong);box-shadow:inset 0 0 0 1px var(--inv-line),0 30px 70px -24px var(--lift)}
.box.agent ::selection{background:var(--inv-strong);color:var(--inv-bg)}
.box.join{display:none;top:-28px;right:-8px;width:260px;padding:14px 16px 16px;background:var(--background-raised);color:var(--gray-1000);box-shadow:inset 0 0 0 1px var(--gray-400),0 24px 60px -24px var(--lift);animation:bob 7s ease-in-out infinite alternate}
.box.join .jf{display:flex;align-items:baseline;gap:10px;margin-top:12px;padding:9px 12px;border-radius:10px;box-shadow:inset 0 0 0 1px var(--gray-500);font-size:14px}
.box.join .jl{flex:none;font-size:12px;color:var(--gray-900)}
.box.join .jf .addr{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.box.join .jb{margin-top:10px;padding:9px 12px;border-radius:var(--radius-full);background:var(--gray-1000);color:var(--background-100);font-size:14px;line-height:20px;font-weight:600;text-align:center}
.bh{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding-bottom:10px;border-bottom:1px solid var(--gray-400);font-size:13px;line-height:18px;font-weight:600}
.box .bh .addr{font-size:12px;font-weight:500}
.box.you .bh .addr,.box.you li{color:var(--gray-900)}
.box.agent .bh{border-bottom-color:var(--inv-line);color:var(--inv-muted)}
.box.agent .bh .addr{color:var(--inv-strong)}
.box li{padding:10px 0;border-bottom:1px solid var(--gray-400)}
.box.agent li{border-bottom-color:var(--inv-line)}
.box li:last-child{border-bottom:0}

.pillars{display:grid;grid-template-columns:minmax(0,1fr);gap:40px 28px}
.pl{min-width:0}
.pl-fig{display:grid;place-items:center;aspect-ratio:3/2;overflow:hidden;border-radius:var(--r-big);background:var(--background-raised);box-shadow:inset 0 0 0 1px var(--gray-400)}
.il{display:block;width:88%;height:auto;overflow:visible}
.pl h3,.facts h3{margin-top:22px;font-size:21px;line-height:28px;font-weight:600;letter-spacing:-0.022em}
html[lang="ko"] .pl h3,html[lang="ko"] .facts h3{letter-spacing:-0.012em}
.pl p{max-width:30em;margin-top:8px;font-size:16px;line-height:1.55;color:var(--gray-900)}
.il rect,.il circle,.il path{vector-effect:non-scaling-stroke}
.il text{font-family:var(--font-sans);font-weight:600;text-anchor:middle}
.il .slot{fill:none;stroke:var(--gray-1000);stroke-width:1.5}
.il .slot.dim{stroke:var(--gray-500);stroke-dasharray:3 4}
.il .slot.on{animation:slot-hit 1.6s ease-out 160ms infinite}
.il .slot-t{font-size:13px;fill:var(--gray-1000)}
.il .slot-t.dim{fill:var(--gray-600)}
.il .env rect{fill:var(--background-raised);stroke:var(--gray-1000);stroke-width:1.5}
.il .env path{fill:none;stroke:var(--gray-1000);stroke-width:1.5;stroke-linejoin:round}
.il .env{animation:env-drop 3.2s var(--settle) infinite}
.il .e2{animation-delay:1.6s;opacity:0}
.il .card{fill:var(--background-100);stroke:var(--gray-1000);stroke-width:1.5}
.il .face{fill:none;stroke:var(--gray-1000);stroke-width:1.5}
.il .ln{fill:var(--gray-1000)}
.il .b2,.il .b3{fill:var(--gray-500)}
.il .sig{fill:none;stroke:var(--gray-1000);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:140;animation:sig-draw 4.8s ease-in-out infinite}
.il .seal{transform-box:fill-box;transform-origin:center;animation:seal-in 4.8s var(--settle) infinite}
.il .seal circle{fill:var(--gray-1000)}
.il .seal path{fill:none;stroke:var(--background-raised);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.il .blk rect{fill:var(--background-raised);stroke:var(--gray-1000);stroke-width:1.5}
.il .blk text{font-family:var(--font-mono);font-weight:500;font-size:10px;fill:var(--gray-1000)}
.il .bk4 rect{fill:var(--gray-1000)}
.il .bk4 text{fill:var(--background-raised)}
.il .bk4{animation:blk-in 4s var(--settle) infinite}
.il .lnk{fill:none;stroke:var(--gray-1000);stroke-width:1.5;stroke-dasharray:16}
.il .lk3{animation:lnk-draw 4s ease infinite}
.il .tick{fill:none;stroke:var(--gray-500);stroke-width:1;stroke-dasharray:2 4}
.il .anchor{fill:var(--gray-1000);transform-box:fill-box;transform-origin:center;animation:ping 4s ease-out infinite}
.il .tg{fill:var(--gray-1000);stroke:var(--gray-1000);stroke-width:1.5;animation:tg 6s steps(1) infinite}
.il .knob{fill:var(--background-raised);stroke:var(--gray-1000);stroke-width:1.5;animation:knob 6s var(--settle) infinite}
.il .rail{fill:none;stroke:var(--gray-500);stroke-width:1.5;stroke-dasharray:3 5}
.il .gate{fill:none;stroke:var(--gray-1000);stroke-width:2;stroke-linecap:round}
.il .mdot{fill:var(--gray-1000);animation:mdot 6s linear infinite}
.il .stop{fill:none;stroke:var(--gray-1000);stroke-width:2;stroke-linecap:round;opacity:0;animation:stopx 6s linear infinite}

.split{display:grid;grid-template-columns:minmax(0,1fr);gap:48px}
.split-main,.split-side{min-width:0}
.lbl{margin-top:0}

.desk{position:relative;display:grid;place-items:center;overflow:hidden;padding:40px 16px;border-radius:24px;background:var(--background-200)}
.desk-photo{position:absolute;inset:0}
.desk-photo img{display:block;width:100%;height:100%;object-fit:cover}
.deck{position:relative;display:grid;gap:16px;width:100%;max-width:420px;margin:0 auto}
/* bridge: a partner's inbox receives Scout's mail -> "who sent this?" -> the recipient looks the address up: published shows, private is not found (6s loop; static = end frame) */
.brg-in{display:grid;grid-template-columns:minmax(0,1fr);gap:40px;align-items:center}
.brg-copy{min-width:0}
.brg-copy h2{font-size:clamp(34px,3.6vw + 12px,64px);font-weight:500;letter-spacing:-0.04em;line-height:1.06;text-wrap:balance}
html[lang="ko"] .brg-copy h2{letter-spacing:-0.03em}
.rin{position:relative;min-width:0;padding:16px 18px 10px;border-radius:var(--r-big);background:var(--background-raised);box-shadow:inset 0 0 0 1px var(--gray-400),0 30px 70px -30px var(--lift)}
.rin-h{display:flex;justify-content:space-between;gap:12px;padding-bottom:12px;border-bottom:1px solid var(--gray-400);font-size:13px;line-height:18px;font-weight:600}
.rin-to{font-size:13px;font-weight:500;color:var(--gray-900)}
.rin-row{position:relative;display:grid;gap:2px;padding:14px 10px;margin:0 -10px;border-bottom:1px solid var(--gray-400);border-radius:10px;font-size:15px;line-height:22px}
.rin-row:last-child{border-bottom:0}
.rin-row:not(.on){color:var(--gray-900)}
.rin-row b{font-weight:600;color:var(--gray-1000)}
.rin-from .addr{margin-left:6px;font-size:13px;color:var(--gray-900)}
.rin-s{color:var(--gray-900)}
.rin-row.on{background:var(--background-200);animation:rin-hl 6s ease infinite}
.look{margin-top:14px;padding:14px 14px 6px;border-radius:14px;background:var(--background-200)}
.look-h{display:flex;align-items:center;gap:8px;padding-bottom:10px;font-size:13px;line-height:18px;font-weight:600}
.look-host{margin-left:auto;font-size:13px;font-weight:500;color:var(--gray-900)}
.look-row{display:grid;gap:6px;padding:10px 0;border-top:1px solid var(--gray-400);font-size:14px;line-height:20px}
.look-q .addr{font-size:13px}
.look-r{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.look-row.l1{animation:look-in 6s var(--settle) infinite}
.look-row.l2{animation:look-in2 6s var(--settle) infinite}
.look-row.l2 .look-r{color:var(--gray-900)}
@media (min-width:640px){.look-row{grid-template-columns:minmax(0,1fr) auto;align-items:center}}
.rin-q{position:absolute;top:-14px;right:14px;padding:5px 10px;border-radius:var(--radius-full);background:var(--gray-1000);color:var(--background-100);font-size:12px;line-height:16px;font-weight:600;opacity:0;animation:rin-ask 6s var(--settle) infinite}
@media (min-width:960px){
  .brg-in{grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:72px}
}
/* the ID card turns in when it scrolls into view (answer to the bridge) */
@supports (animation-timeline:view()){
  .deck{perspective:1400px}
  .deck>.idc:first-child{animation:card-turn linear both;animation-timeline:view();animation-range:entry 5% cover 38%}
}
.facts{display:grid;grid-template-columns:minmax(0,1fr);gap:28px;margin-top:44px}
.facts li{min-width:0}
.facts h3{margin-top:10px}

.idc{min-width:0;border-radius:var(--r-big)}
.idc-top{display:flex;justify-content:space-between;align-items:center;gap:12px;padding-bottom:12px;border-bottom:1px solid var(--gray-400);font-size:13px;line-height:18px;font-weight:600;color:var(--gray-900)}
.idc-top code{font-family:inherit;font-size:inherit}
.idc.front{padding:20px;background:var(--background-raised);box-shadow:inset 0 0 0 1px var(--gray-400)}
.idc-logo{display:inline-flex;line-height:0;color:var(--gray-1000)}
.idc-logo .brand{height:16px}
.idc-id{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:16px}
.idc-id>div:first-child{min-width:0}
.idc-name{font-family:var(--font-sans);font-size:28px;line-height:36px;font-weight:800;letter-spacing:-0.035em}
.idc .idc-art{flex:none;width:56px;height:56px;border-radius:12px;overflow:hidden;background:var(--background-200);box-shadow:inset 0 0 0 1px var(--gray-400)}
.idc-svg{display:block;width:100%;height:100%}
.idc-svg .rl{fill:none;stroke:var(--gray-1000);stroke-width:.35}
.idc-svg .rim{fill:none;stroke:var(--gray-1000);stroke-width:.45}
.idc-svg .disc{fill:var(--background-200)}
.idc-addr{margin-top:4px;font-size:15px;line-height:22px}
.idc-f{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px 20px;margin-top:20px;padding-top:16px;border-top:1px solid var(--gray-400)}
.idc-f .w{grid-column:1/-1}
.idc-f dt{font-size:11.5px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--gray-900)}
html[lang="ko"] .idc-f dt{font-size:13px;font-weight:400;letter-spacing:0;text-transform:none}
.idc-f dd{margin-top:2px;font-size:15px;line-height:22px;min-width:0}
.idc-f dd.num{font-variant-numeric:tabular-nums}
.did{font-family:var(--font-mono);font-size:13px;line-height:19px;word-break:normal;overflow-wrap:anywhere}
.did>span{white-space:nowrap}
.did .sep{color:var(--gray-900)}
.idc.back{padding:20px;background:var(--inv-bg);color:var(--inv-fg);box-shadow:inset 0 0 0 1px var(--inv-line);font-size:13px;line-height:20px}
.idc.back ::selection{background:var(--inv-strong);color:var(--inv-bg)}
.idc.back .idc-top{border-bottom-color:var(--inv-line);color:var(--inv-muted);font-family:var(--font-sans)}
.idc-k{display:grid;grid-template-columns:minmax(0,1fr);margin-top:12px}
.idc-k>div{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:baseline}
.idc-k dt{color:var(--inv-muted);font-family:var(--font-sans);font-size:12px}
.idc-k dd{color:var(--inv-strong);text-align:right;min-width:0;word-break:break-all}
.idc-k dd.key{font-family:var(--font-mono);font-size:12px}
.priv{display:inline-flex;align-items:center;height:20px;margin-left:4px;padding:0 8px;border-radius:var(--radius-full);box-shadow:inset 0 0 0 1px var(--inv-muted);font-family:var(--font-sans);font-size:12px;line-height:16px;color:var(--inv-muted)}
.fp{display:block;width:100%;height:22px;margin-top:12px}
.fp rect{fill:var(--inv-strong)}
.json{margin:12px 0 0;padding:12px 0;border-top:1px solid var(--inv-line);border-bottom:1px solid var(--inv-line);font-family:var(--font-mono);font-size:12px;line-height:20px;color:var(--inv-strong);white-space:pre-wrap;word-break:break-all}
.json code{font-size:inherit}
.json .k{color:var(--inv-muted)}

.dark{padding:80px 0 88px;background:var(--inv-bg);color:var(--inv-fg)}
.dark ::selection{background:var(--inv-strong);color:var(--inv-bg)}
.dark .sec-head h2{color:var(--inv-strong)}
.dark .sec-lede{color:var(--inv-fg)}
.proofs{display:grid;grid-template-columns:minmax(0,1fr);gap:48px 28px}
.proof{min-width:0}
.pf-fig{display:grid;place-items:center;aspect-ratio:3/2;overflow:hidden;border-radius:var(--r-big);background:var(--inv-wash);box-shadow:inset 0 0 0 1px var(--inv-line)}
.proof h3{margin-top:22px;font-size:21px;line-height:28px;font-weight:600;letter-spacing:-0.022em;color:var(--inv-strong)}
.proof p{max-width:30em;margin-top:8px;font-size:16px;line-height:1.55;color:var(--inv-fg)}
.proof .pw{display:grid;gap:6px;justify-items:start;min-width:0;margin-top:16px}
.proof .pl-k{font-size:12px;line-height:16px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--inv-muted)}
.pdocs{margin-top:40px;font-size:15px}
.pdocs a{display:inline-flex;align-items:center;gap:8px;color:var(--inv-strong);text-decoration:underline;text-underline-offset:4px}
html[lang="ko"] .proof h3{letter-spacing:-0.012em}
/* proof illustrations on the dark band (end frame = static frame) */
.il.inv .pdoc{fill:var(--inv-wash);stroke:var(--inv-strong);stroke-width:1.5}
.il.inv .pbar{fill:none;stroke:var(--inv-muted);stroke-width:1}
.il.inv .pbar-t{font-size:9px;fill:var(--inv-fg)}
.il.inv .dl{fill:var(--inv-strong);transform-box:fill-box;transform-origin:left center}
.il.inv .dl.dim,.il.inv .d3{fill:var(--inv-muted)}
.il-did .d1{animation:type-in 5s var(--settle) infinite}
.il-did .d2{animation:type-in 5s var(--settle) .35s infinite}
.il-did .d3{animation:type-in 5s var(--settle) .7s infinite}
.il.inv .key-g circle,.il.inv .key-g path,.il.inv .vkey circle,.il.inv .vkey path{fill:none;stroke:var(--inv-strong);stroke-width:1.8;stroke-linecap:round}
.il.inv .mag circle,.il.inv .mag path{fill:none;stroke:var(--inv-strong);stroke-width:2;stroke-linecap:round}
.il-did .mag{animation:mag-scan 5s ease-in-out infinite}
.il.inv .vsig{fill:none;stroke:var(--inv-strong);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.il-verify .vkey{animation:key-in 5s var(--settle) infinite}
.il.inv .vok circle{fill:var(--inv-strong)}
.il.inv .vok path{fill:none;stroke:var(--inv-bg);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.il.inv .vok{transform-box:fill-box;transform-origin:center;animation:ok-in 5s var(--settle) infinite}
.il.inv .cb rect{fill:var(--inv-wash);stroke:var(--inv-strong);stroke-width:1.5}
.il.inv .cb text{font-family:var(--font-mono);font-size:9px;font-weight:500;text-anchor:middle;fill:var(--inv-strong)}
.il.inv .cb.new rect{fill:var(--inv-strong)}
.il.inv .cb.new text{fill:var(--inv-bg)}
.il-ckpt .cb.new{animation:blk-new 5s var(--settle) infinite}
.il.inv .cl{font-size:11px;font-weight:600;text-anchor:middle;fill:var(--inv-muted)}
.il.inv .cm{fill:none;stroke:var(--inv-muted);stroke-width:1.2;stroke-dasharray:3 4}
.il-ckpt .cm{animation:cmp 5s ease infinite}
.il-ckpt .m2{animation-delay:.2s}.il-ckpt .m3{animation-delay:.4s}
/* two-layer defense (2026-10-07, right after the split section; plain canvas + a hairline on top so it neither merges with the split above
   nor with the toned how-it-works band below): eyebrow + copy on top, then the illustration and the two layers. Each layer's top rule repeats its shape in the
   picture (layer 1 = solid scanner bar, layer 2 = dashed line). 2026-10-08 picture: one scanner, three lanes: clean mail into the agent, Risk mail (outlined
   badge) at the agent with its reply stopped at an approval gate, Block mail (solid badge) held in a box with the owner's bell. Coordinates in the SVG are the
   end frame; keyframes start from offsets, so with reduced motion the static picture is the end frame. */
.sec.def{box-shadow:inset 0 1px 0 var(--gray-400)}
.def-k{margin-bottom:16px;font-size:14px;line-height:20px;font-weight:600;color:var(--gray-900)}
.def-in{display:grid;grid-template-columns:minmax(0,1fr);gap:40px;align-items:center}
.def-copy{min-width:0;grid-column:1/-1}
.def-copy h2{font-size:clamp(34px,3.6vw + 12px,64px);font-weight:500;letter-spacing:-0.04em;line-height:1.06;text-wrap:balance}
html[lang="ko"] .def-copy h2{letter-spacing:-0.03em;line-height:1.16}
.df-fig{display:grid;place-items:center;min-width:0;aspect-ratio:7/4;overflow:hidden;border-radius:var(--r-big);background:var(--background-raised);box-shadow:inset 0 0 0 1px var(--gray-400),0 30px 70px -30px var(--lift)}
.df-fig .il{width:94%}
.layers{display:grid;grid-template-columns:minmax(0,1fr);gap:32px;min-width:0}
.ly{min-width:0;padding-top:18px;border-top:2px solid var(--gray-1000)}
.ly.l2{border-top:2px dashed var(--gray-600)}
.ly h3{margin-top:8px;font-size:21px;line-height:28px;font-weight:600;letter-spacing:-0.022em}
html[lang="ko"] .ly h3{letter-spacing:-0.012em}
.ly-k{font-size:13px;line-height:20px;font-weight:600;color:var(--gray-900)}
.ly p:not(.ly-k){max-width:34em;margin-top:8px;font-size:16px;line-height:1.55;color:var(--gray-900)}
.ly .ly-n{margin-top:12px;font-size:14px;line-height:1.5}
.il-def .lane{fill:none;stroke:var(--gray-500);stroke-width:1.5;stroke-dasharray:3 5}
.il-def .tray{fill:var(--background-200);stroke:var(--gray-600);stroke-width:1.5;animation:def-tray 9s ease-out infinite}
.il-def .l1,.il-def .gate{fill:var(--gray-1000)}
.il-def .l2{fill:none;stroke:var(--gray-600);stroke-width:2;stroke-dasharray:6 7;stroke-linecap:round;animation:l2-scan 1.4s linear infinite}
.il-def .agent{fill:var(--background-100);stroke:var(--gray-1000);stroke-width:1.5}
.il-def .agent-t{font-size:13px;fill:var(--gray-1000)}
.il-def .badge circle{fill:var(--background-raised);stroke:var(--gray-1000);stroke-width:1.5}
.il-def .badge path{fill:none;stroke:var(--gray-1000);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.il-def .ring{fill:none;stroke:var(--gray-1000);stroke-width:1;opacity:0;transform-box:fill-box;transform-origin:center;animation:def-ring 9s ease-out infinite}
.il-def .ring.rb{animation-name:def-ring-b}
.il-def .bell{transform-box:fill-box;transform-origin:50% 30%;animation:def-bell 9s var(--settle) infinite}
.il-def .env{animation:none}
.il-def .bad rect{fill:var(--gray-1000)}
.il-def .bad path{stroke:var(--background-raised)}
.il-def .bdg{transform-box:fill-box;transform-origin:center}
.il-def .bdg circle{stroke:var(--gray-1000);stroke-width:1.5}
.il-def .bdg path{fill:none;stroke-width:2;stroke-linecap:round}
.il-def .bdg.r circle{fill:var(--background-raised)}
.il-def .bdg.r path{stroke:var(--gray-1000)}
.il-def .bdg.k circle{fill:var(--gray-1000)}
.il-def .bdg.k path{stroke:var(--background-raised)}
.il-def .ea{opacity:0;animation:def-a 9s var(--settle) infinite}
.il-def .ec{animation:def-c 9s var(--settle) infinite}
.il-def .ec .bdg{animation:def-rb 9s var(--settle) infinite}
.il-def .eb{animation:def-b 9s var(--settle) infinite}
.il-def .eb .bdg{animation:def-kb 9s var(--settle) infinite}
.il-def .ed{animation:def-d 9s var(--settle) infinite}
.proof .pc{padding:5px 12px;border-radius:var(--radius-full);background:var(--inv-line);color:var(--inv-strong);font-size:14px}

.faq{min-width:0;border-top:1px solid var(--gray-500)}
.faq details{border-bottom:1px solid var(--gray-500)}
.faq summary{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:64px;padding:16px 0;cursor:pointer;list-style:none}
.faq summary::-webkit-details-marker{display:none}
.faq summary h3{font-size:18px;line-height:26px;font-weight:700;letter-spacing:-0.015em}
html[lang="ko"] .faq summary h3{letter-spacing:-0.01em}
.faq summary:hover h3{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:4px}
.faq .pm{width:20px;height:20px;transition:transform var(--dur-base) var(--settle)}
.faq details[open] .pm{transform:rotate(45deg)}
.faq details p{max-width:64ch;padding:0 36px 24px 0;font-size:16px;line-height:1.6;color:var(--gray-900)}
.faq details p a{color:var(--gray-1000);font-weight:600;text-decoration:underline;text-decoration-color:var(--gray-500)}

.cta{padding:112px 0 120px;text-align:center}
.cta-card{width:100%;max-width:1200px;margin:0 auto;padding:0 20px}
.actions.center{justify-content:center;margin-top:36px}

.foot{padding:48px 0 32px;border-top:1px solid var(--gray-400);font-size:14px;line-height:20px}
.foot .wrap{display:flex;flex-direction:column;gap:12px}
.foot .fgrid{display:grid;grid-template-columns:minmax(0,1fr);gap:32px}
.foot .logo .brand{height:20px}
.foot nav{display:flex;flex-wrap:wrap;gap:0 16px}
.fgrid nav{flex-direction:column;flex-wrap:nowrap;align-items:flex-start;gap:0}
.fh{margin-bottom:8px;font-size:13px;line-height:20px;font-weight:600;color:var(--gray-1000)}
.foot .fcopy{grid-column:1/-1;margin-top:16px;padding-top:20px;border-top:1px solid var(--gray-400);font-size:13px;line-height:20px}
.foot nav a,.foot nav a:visited{display:inline-flex;align-items:center;min-height:30px;color:var(--gray-900)}
.foot nav a:hover{color:var(--gray-1000)}

.doc{padding-top:56px;padding-bottom:80px}
.doc>*{max-width:720px}
.doc h1{margin:12px 0 16px;font-size:clamp(34px,2.4vw + 24px,48px)}
.doc .meta{padding-bottom:24px;border-bottom:1px solid var(--gray-400);font-size:14px;line-height:20px;color:var(--gray-900)}
.doc .intro{margin-top:24px}
.doc h2{margin:48px 0 12px;font-size:21px;line-height:30px;font-weight:700;letter-spacing:-0.02em}
html[lang="ko"] .doc h2{letter-spacing:-0.01em}
.doc p{margin:12px 0}
.doc{line-height:1.65}
.doc p a,.doc li a,.doc dd a{text-decoration:underline;text-decoration-color:var(--gray-500)}
.doc ol.list,.doc ul.list{margin:12px 0;padding-left:0}
.doc ol.list{counter-reset:c}
.doc ol.list>li{counter-increment:c;position:relative;margin:8px 0;padding-left:28px}
.doc ol.list>li::before{content:counter(c) ".";position:absolute;left:0;top:0;font-weight:600;font-variant-numeric:tabular-nums}
.doc ul.list>li{position:relative;margin:8px 0;padding-left:28px}
.doc ul.list>li::before{content:"";position:absolute;left:4px;top:.8em;width:6px;height:6px;border-radius:50%;background:var(--gray-1000)}
.doc .toc{margin-top:24px;padding:20px var(--card-pad);border-radius:var(--r-card);background:var(--background-200);font-size:14px;line-height:20px}
.toc-h{margin-bottom:8px;font-size:13px;line-height:18px;font-weight:700;color:var(--gray-900)}
.doc .toc ol{display:grid;grid-template-columns:minmax(0,1fr)}
.doc .toc a,.doc .toc a:visited{display:flex;align-items:center;min-height:30px;color:var(--gray-900);text-decoration:none}
.doc .toc a:hover{color:var(--gray-1000)}
/* report abuse (/abuse) - the address is the page's one big object */
.doc .ab-to{margin:32px 0 8px;padding:24px var(--card-pad);border-radius:var(--r-big);background:var(--background-200);box-shadow:inset 0 0 0 1px var(--gray-400)}
.doc .ab-to p{margin:0}
.ab-l{font-size:13px;line-height:20px;font-weight:600;color:var(--gray-900)}
.doc .ab-addr{margin-top:6px;font-size:clamp(22px,1.6vw + 16px,32px);line-height:1.25;font-weight:600;letter-spacing:-0.02em;overflow-wrap:anywhere}
.doc .ab-addr a{font-size:1em;text-decoration:none}
.doc .ab-addr a:hover{text-decoration:underline;text-decoration-thickness:1px}
.doc .ab-n{margin-top:10px;font-size:15px;line-height:22px}
/* changelog (/changelog) - a ledger: one row per day, date on the left from 768px, sticky while its items scroll */
.cl{padding-top:56px;padding-bottom:96px}
.cl-head{max-width:720px;padding-bottom:28px}
.cl h1{margin:12px 0 0;font-size:clamp(34px,2.4vw + 24px,48px)}
.cl-lede{max-width:32em;margin-top:14px;font-size:17px;line-height:1.55;color:var(--gray-900)}
.cl-list{max-width:920px;border-top:1px solid var(--gray-1000)}
.cl-day{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding:24px 0 28px;border-bottom:1px solid var(--gray-400)}
.cl-date{font-size:14px;line-height:20px;font-weight:600;letter-spacing:0;color:var(--gray-1000);font-variant-numeric:tabular-nums}
.cl-items{display:grid;gap:12px}
.cl-items li{position:relative;padding-left:22px;font-size:16px;line-height:1.6;text-wrap:pretty}
.cl-items li::before{content:"";position:absolute;left:2px;top:13px;width:10px;height:1px;background:var(--gray-1000)}
.cl-items code{padding:1px 6px;border-radius:6px;background:var(--gray-100);font-size:.86em;white-space:nowrap}
.items{margin:16px 0;border-top:1px solid var(--gray-400)}
.items>div{display:grid;grid-template-columns:minmax(0,1fr);gap:4px;padding:16px 0;border-bottom:1px solid var(--gray-400)}
.items dt{font-size:16px;line-height:26px;font-weight:700}
.items dd{font-size:16px;line-height:26px;color:var(--gray-900)}
.items dd b{color:var(--gray-1000);font-weight:600}
.items dd a{color:var(--gray-1000);font-weight:600;white-space:nowrap;text-decoration:underline;text-decoration-color:var(--gray-500)}

.auth{display:grid;grid-template-columns:minmax(0,400px);justify-content:center;padding-top:56px;padding-bottom:96px}
.auth-main{min-width:0}
.auth h1{margin:0 0 32px;text-align:center;font-size:40px}
.auth .actions{margin-top:24px}
.auth .actions .btn{width:100%;height:48px;font-size:16px}
.field{display:block;margin-top:16px}
.field span{display:block;margin-bottom:8px;font-size:14px;line-height:20px;font-weight:600}
.field input{display:block;width:100%;height:52px;padding:0 16px;border:0;border-radius:var(--r-input);background:var(--background-raised);box-shadow:inset 0 0 0 1px var(--gray-600);font-size:17px;line-height:24px;-webkit-appearance:none;appearance:none;transition:box-shadow var(--dur-fast) ease}
.field input:hover{box-shadow:inset 0 0 0 1px var(--gray-1000)}
.field input:focus{outline:none;box-shadow:inset 0 0 0 1px var(--gray-1000)}
.field input:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px;box-shadow:inset 0 0 0 1px var(--gray-1000)}
.field input[aria-invalid="true"]{box-shadow:inset 0 0 0 2px var(--danger)}
.check{display:grid;grid-template-columns:16px minmax(0,1fr);gap:10px;align-items:start;margin-top:20px;font-size:15px;line-height:22px}
.check a{text-decoration:underline;text-decoration-color:var(--gray-500)}
.check input{display:grid;place-content:center;width:16px;height:16px;margin:3px 0 0;border-radius:4px;background:var(--background-raised);box-shadow:inset 0 0 0 1px var(--gray-600);-webkit-appearance:none;appearance:none;cursor:pointer}
.check input::before{content:"";width:9px;height:5px;border-left:2px solid var(--background-100);border-bottom:2px solid var(--background-100);transform:translateY(-1px) rotate(-45deg);opacity:0}
.check input:checked{background:var(--gray-1000);box-shadow:none}
.check input:checked::before{opacity:1}
.check input[aria-invalid="true"]{box-shadow:inset 0 0 0 2px var(--danger)}
.choice{min-width:0;margin:16px 0 0;padding:0;border:0}
.choice legend{padding:0;margin-bottom:4px;font-size:14px;line-height:20px;font-weight:600}
.choice .check{margin-top:10px}
.choice[aria-invalid="true"] .check input{box-shadow:inset 0 0 0 2px var(--danger)}
.check input[type="radio"]{border-radius:50%}
.check input[type="radio"]::before{width:6px;height:6px;border:0;border-radius:50%;background:var(--background-100);transform:none}
.field select{display:block;width:100%;height:52px;padding:0 12px;border:0;border-radius:var(--r-input);background:var(--background-raised);box-shadow:inset 0 0 0 1px var(--gray-600);font-size:17px;line-height:24px;cursor:pointer}
.field select:hover,.field select:focus{outline:none;box-shadow:inset 0 0 0 1px var(--gray-1000)}
.field select:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.auth .note{margin-top:16px;padding:12px 16px;border-radius:var(--r-card);background:var(--background-200);font-size:14px;line-height:20px}
.msg{margin-top:12px;font-size:15px;line-height:22px;font-weight:600}
.msg::before{content:"! "}
.auth .msg{color:var(--danger)}
.field+.msg,.check+.msg,.choice+.msg{margin-top:8px}
.field input,.check input{scroll-margin-top:96px}
.panel{margin-top:24px;padding:var(--card-pad);border-radius:var(--r-card);background:var(--background-200)}
.panel h2{margin-bottom:8px;font-size:20px;line-height:28px;font-weight:700}
.panel .muted{font-size:15px;line-height:22px}
.panel .muted+.muted{margin-top:12px}
.panel .muted a{color:var(--gray-1000);font-weight:600;text-decoration:underline;text-decoration-color:var(--gray-500)}
.alt{margin-top:28px;text-align:center;font-size:15px;line-height:22px;color:var(--gray-900)}
.alt a,.alt a:visited{color:var(--gray-1000);font-weight:600}
.alt+.alt{margin-top:8px}
.auth .intro{margin:-16px 0 8px;text-align:center;font-size:15px;line-height:22px;color:var(--gray-900)}
.auth .fine{margin-top:16px;font-size:13px;line-height:20px;color:var(--gray-900)}
.auth .fine a{text-decoration:underline;text-decoration-color:var(--gray-500)}

.pr-head{max-width:1200px;margin:0 auto;padding:56px 20px 40px}
.pr-head h1{margin:0 0 14px;font-size:clamp(40px,2.6vw + 30px,60px)}
.pr-head .lede{max-width:36em;font-size:18px;line-height:1.5;color:var(--gray-900)}
.plans{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;max-width:1200px;margin:0 auto;padding:0 20px}
.plan{display:flex;flex-direction:column;min-width:0;padding:24px;border-radius:var(--r-card);background:var(--background-raised);box-shadow:inset 0 0 0 1px var(--gray-400)}
.plan.beta{box-shadow:inset 0 0 0 1.5px var(--gray-1000)}
.plan h2{font-size:16px;line-height:24px;font-weight:700}
.price{display:flex;flex-wrap:nowrap;align-items:baseline;gap:4px 8px;margin-top:12px;white-space:nowrap}
.price .amt{font-size:48px;line-height:56px;font-weight:800;letter-spacing:-0.04em;font-variant-numeric:tabular-nums}
.price .amt.word{font-family:var(--font-sans);font-size:22px;line-height:32px;font-weight:700;letter-spacing:-0.02em}
.price .per{font-size:14px;line-height:20px;color:var(--gray-900)}
.plan .who{margin-top:8px;font-size:14px;line-height:20px;font-weight:600}
.plan .agents{margin-top:16px;padding-top:12px;border-top:1px solid var(--gray-400);font-size:15px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}
.plan .how{margin-top:8px;font-size:14px;line-height:20px;color:var(--gray-900)}
.plan-go{margin-top:auto;padding-top:24px}
.plan-go .btn{width:100%}
.pr-sec{max-width:1200px;margin:0 auto;padding:80px 20px 0}
.pr-sec+.pr-sec{padding-bottom:96px}
.pr-sec>h2{font-size:34px}
.tbl{max-width:100%;margin-top:28px;overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--gray-400);border-radius:var(--r-card)}
.tbl:focus-visible{outline-offset:2px}
.limits{width:100%;min-width:640px;border-collapse:separate;border-spacing:0;font-size:15px;line-height:20px}
.limits th,.limits td{height:52px;padding:0 20px;border-bottom:1px solid var(--gray-400);text-align:right;white-space:nowrap}
.limits thead th{height:48px;background:var(--background-200);font-size:13px;line-height:18px;font-weight:700;color:var(--gray-900)}
.limits th:first-child{position:sticky;left:0;z-index:1;min-width:10em;text-align:left;white-space:normal;background:var(--background-100)}
.limits thead th:first-child{background:var(--background-200)}
.limits tbody th{font-weight:600}
.limits td{font-variant-numeric:tabular-nums}
.limits tbody tr:last-child>*{border-bottom:0}
.ceil{display:flex;align-items:flex-start;gap:8px;margin-top:16px;font-size:15px;line-height:22px;font-weight:600}
.ceil::before{content:"!";display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;border-radius:50%;box-shadow:inset 0 0 0 1px var(--gray-600);font-size:12px;line-height:1;font-weight:700}
.aside{max-width:44em;margin-top:8px;font-size:14px;line-height:20px;color:var(--gray-900)}
.pr-sec .items{margin-top:28px;margin-bottom:0}

.nf{padding-top:96px;padding-bottom:112px;text-align:center}
.nf .code{font-size:96px;line-height:1;font-weight:800;letter-spacing:-0.05em;font-variant-numeric:tabular-nums}
.nf h1{margin:24px 0 12px;font-size:32px}
.nf .actions{justify-content:center}

.blog{padding-top:56px;padding-bottom:8px}
.blog-head{padding-bottom:40px;border-bottom:1px solid var(--gray-1000)}
.blog-head h1{font-size:clamp(56px,6vw + 24px,112px);line-height:.95;letter-spacing:-0.055em}
html[lang="ko"] .blog-head h1{line-height:1.05;letter-spacing:-0.04em}
.blog-head .lede{max-width:30em;margin:24px 0 0;font-size:19px;line-height:1.55;color:var(--gray-900);text-wrap:pretty}
.blog-feed{margin:16px 0 0;font-size:14px;line-height:20px}
.blog-feed a,.blog-feed a:visited{color:var(--gray-900);text-decoration:underline;text-decoration-color:var(--gray-500)}
.blog-feed a:hover{color:var(--gray-1000)}
.posts{margin:0;padding:0;list-style:none}
.posts>li{border-bottom:1px solid var(--gray-400)}
.pcard{position:relative;display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding:32px 0}
.pcard-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin:0;font-size:14px;line-height:20px;color:var(--gray-900);font-variant-numeric:tabular-nums}
.pcard h2{font-size:clamp(24px,1.2vw + 19px,34px);line-height:1.16;font-weight:700;letter-spacing:-0.03em;text-wrap:balance}
html[lang="ko"] .pcard h2{line-height:1.32;letter-spacing:-0.02em}
.pcard h2 a::after{content:"";position:absolute;inset:0;border-radius:4px}
.pcard h2 a:focus-visible{outline:none}
.pcard h2 a:focus-visible::after{outline:2px solid var(--focus-ring);outline-offset:4px}
.pcard:hover h2 a{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:5px}
.pcard-desc{max-width:60ch;margin:12px 0 0;line-height:1.6;color:var(--gray-900);text-wrap:pretty}
.pcard .tags{margin-top:16px}
.pcard.lead{padding:40px 0 48px}
.pcard.lead h2{font-size:clamp(32px,2.6vw + 20px,56px);line-height:1.04;letter-spacing:-0.045em}
html[lang="ko"] .pcard.lead h2{line-height:1.18;letter-spacing:-0.035em}
.pcard.lead .pcard-desc{font-size:18px}
.pcard-cover{display:flex;align-items:center;justify-content:center;margin-top:12px;padding:clamp(20px,3vw,36px);border-radius:var(--r-big);background:var(--background-200);color:var(--gray-1000)}
.pcard-cover .fig-svg{width:100%}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.tags li{padding:2px 10px;border-radius:var(--radius-full);box-shadow:inset 0 0 0 1px var(--gray-500);font-size:12px;line-height:20px;color:var(--gray-900)}
.badge{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:var(--radius-full);background:var(--gray-1000);color:var(--background-100);font-size:12px;line-height:1;font-weight:700}

.post{width:100%;max-width:1088px;margin:0 auto;padding:48px 20px 0}
.post-head{max-width:720px;margin:0 auto}
.crumb{display:flex;align-items:center;gap:10px;margin:0;font-size:14px;line-height:20px;font-weight:600}
.crumb a,.crumb a:visited{color:var(--gray-1000);text-decoration:underline;text-decoration-color:var(--gray-500);text-underline-offset:4px}
.post-head h1{margin-top:20px;font-size:clamp(36px,2.8vw + 24px,60px);line-height:1.04;letter-spacing:-0.045em}
html[lang="ko"] .post-head h1{line-height:1.2;letter-spacing:-0.035em}
.dek{margin:20px 0 0;font-size:20px;line-height:1.5;color:var(--gray-900);text-wrap:pretty}
.byline{display:flex;flex-wrap:wrap;row-gap:4px;margin:32px 0 0;padding-top:16px;border-top:1px solid var(--gray-1000);font-size:14px;line-height:20px;color:var(--gray-900)}
.byline>span+span::before{content:"\\00B7";margin:0 10px;color:var(--gray-600)}
.byline>span:first-child{color:var(--gray-1000);font-weight:600}
.post-head .tags{margin-top:16px}
.prose{display:grid;grid-template-columns:[wide-start] minmax(0,1fr) [text-start] minmax(0,720px) [text-end] minmax(0,1fr) [wide-end];margin-top:56px;font-size:18px;line-height:1.72}
html[lang="ko"] .prose{font-size:17px;line-height:1.82}
.prose>*{grid-column:text;min-width:0;margin:0}
.prose>*+*{margin-top:1.15em}
.prose>h2{margin-top:2.4em;font-size:28px;line-height:1.22;font-weight:700;letter-spacing:-0.028em;text-wrap:balance;scroll-margin-top:calc(var(--header-h) + 24px)}
.prose>h3{margin-top:2em;font-size:21px;line-height:1.35;font-weight:700;letter-spacing:-0.015em;text-wrap:balance;scroll-margin-top:calc(var(--header-h) + 24px)}
html[lang="ko"] .prose>h2,html[lang="ko"] .prose>h3{letter-spacing:-0.01em}
.prose>h2+*,.prose>h3+*{margin-top:.65em}
.prose a,.prose a:visited{text-decoration:underline;text-decoration-thickness:1px;text-decoration-color:var(--gray-500)}
.prose a:hover{text-decoration-color:currentColor}
.prose strong{font-weight:700}
.prose ul,.prose ol{padding-left:1.35em}
.prose li+li,.prose li>ul,.prose li>ol{margin-top:.4em}
.prose li::marker{color:var(--gray-600);font-variant-numeric:tabular-nums}
.prose :not(pre)>code{padding:.12em .38em;border-radius:6px;background:var(--gray-alpha-400);box-shadow:inset 0 0 0 1px var(--gray-alpha-400);font-size:.86em;overflow-wrap:anywhere}
.prose>hr{justify-self:center;width:72px;height:0;margin-top:2.6em;border:0;border-top:1px solid var(--gray-1000)}
.prose>hr+*{margin-top:2.6em}
.prose blockquote{padding:2px 0 2px 24px;border-left:2px solid var(--gray-1000);font-size:1.12em;line-height:1.6;letter-spacing:-0.01em}
.prose blockquote>*{margin:0}
.prose blockquote>*+*{margin-top:.8em}
.bcode figcaption{margin-bottom:8px;font-size:13px;line-height:16px;font-weight:500;color:var(--gray-900)}
.bcode pre{margin:0;padding:18px 20px;overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:var(--r-card);background:var(--inv-bg);color:var(--inv-strong);box-shadow:inset 0 0 0 1px var(--inv-line);font-family:var(--font-mono);font-size:14px;line-height:1.65;tab-size:2}
.bcode pre code{font-size:inherit;white-space:pre}
.bcode pre::selection,.bcode pre ::selection{background:var(--inv-strong);color:var(--inv-bg)}
.bt{overflow-x:auto;-webkit-overflow-scrolling:touch}
.bt table{width:100%;border-collapse:collapse;font-size:15px;line-height:1.5}
.bt th,.bt td{padding:11px 20px 11px 0;border-bottom:1px solid var(--gray-400);text-align:left;vertical-align:top}
.bt th:last-child,.bt td:last-child{padding-right:0}
.bt thead th{border-bottom:1px solid var(--gray-1000);font-size:13px;line-height:18px;font-weight:700;color:var(--gray-900);white-space:nowrap}
.bt .ac{text-align:center}
.bt .ar{text-align:right;font-variant-numeric:tabular-nums}
.prose>.bf{grid-column:wide;margin-top:2.4em}
.prose>.bf+*{margin-top:2.4em}
.bf figcaption{max-width:720px;margin:14px auto 0;font-size:14px;line-height:21px;color:var(--gray-900);text-align:center;text-wrap:balance}
.plate{display:flex;justify-content:center;padding:clamp(20px,4vw,48px) clamp(12px,3vw,40px);border-radius:var(--r-big);background:var(--background-200);color:var(--gray-1000)}
.fig-svg{display:block;max-width:100%;height:auto;overflow:visible;color:inherit}
.fig-svg text{fill:currentColor;font-family:var(--font-sans)}
.fig-svg .ink{fill:var(--gray-1000)}
.fig-svg .paper{fill:var(--background-raised)}
.fig-svg .band{fill:var(--background-200)}
.fig-svg .mute{fill:var(--gray-900)}
.fig-svg .line{fill:none;stroke:var(--gray-1000)}
.fig-svg .hair{fill:none;stroke:var(--gray-500)}
.fig-svg .soft{fill:none;stroke:var(--gray-600)}
.fig-svg .dash{stroke-dasharray:4 4}
.fig-svg .thick{stroke-width:2}
.fig-svg .label{font-size:13px}
.fig-svg .small{font-size:11px;fill:var(--gray-900)}
.fig-svg .title{font-size:15px;font-weight:700}
.fig-svg .mono{font-family:var(--font-mono)}
.fig-svg .bold{font-weight:700}
.fig-svg .inv{fill:var(--background-100)}
.fig-svg .end{text-anchor:end}
.fig-svg .mid{text-anchor:middle}
.shot picture{display:block}
.shot img{display:block;max-width:100%;height:auto;margin:0 auto;border-radius:14px;background:var(--background-raised);box-shadow:0 0 0 1px var(--gray-400),0 32px 64px -40px var(--shadow-far)}
.shot-pending{display:flex;align-items:center;justify-content:center;max-width:860px;min-height:220px;margin:0 auto;padding:24px;border-radius:14px;background:var(--background-200);box-shadow:inset 0 0 0 1px var(--gray-500);font-size:13px;line-height:20px;color:var(--gray-900);text-align:center}
.pn{display:grid;grid-template-columns:minmax(0,1fr);max-width:720px;margin:80px auto 0;border-top:1px solid var(--gray-1000)}
.pn a,.pn a:visited{display:flex;flex-direction:column;gap:6px;padding:20px 0;border-bottom:1px solid var(--gray-400)}
.pn a:hover{text-decoration:none}
.pn a:hover .pn-t{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:4px}
.pn-k{font-size:13px;line-height:18px;color:var(--gray-900)}
.pn-t{font-size:18px;line-height:1.35;font-weight:700;letter-spacing:-0.015em;text-wrap:balance}
.pn-gap{display:none}
.cta.blog-cta{padding:96px 0 104px}
@media (max-width:767px){
  .post{padding-left:16px;padding-right:16px}
  .prose{margin-top:40px}
  .plate{border-radius:var(--r-card)}
  .bcode pre{margin-left:-16px;margin-right:-16px;padding-left:16px;padding-right:16px;border-radius:0;box-shadow:none}
  .bcode figcaption{margin-left:0}
}
@media (min-width:768px){
  .blog{padding-top:88px}
  .pcard{grid-template-columns:168px minmax(0,1fr);column-gap:40px;padding:40px 0}
  .pcard>.pcard-meta{flex-direction:column;align-items:flex-start;padding-top:9px}
  .pcard.lead{grid-template-columns:minmax(0,1fr);padding:48px 0 56px}
  .pcard.lead>.pcard-meta{flex-direction:row;align-items:center;padding-top:0}
  .post{padding-top:80px;padding-left:32px;padding-right:32px}
  .pn{grid-template-columns:repeat(2,minmax(0,1fr));column-gap:40px}
  .pn a{border-bottom:0}
  .pn-gap{display:block}
  .pn-newer{align-items:flex-end;text-align:right}
}
@media (min-width:960px){
  .pcard.lead.has-cover{grid-template-columns:minmax(0,5fr) minmax(0,6fr);grid-template-areas:"meta cover" "text cover";grid-template-rows:auto 1fr;column-gap:56px;align-items:start}
  .pcard.lead.has-cover>.pcard-meta{grid-area:meta}
  .pcard.lead.has-cover>.pcard-text{grid-area:text}
  .pcard.lead.has-cover>.pcard-cover{grid-area:cover;margin-top:0}
  .cta.blog-cta{padding:136px 0 144px}
}

.uc{padding-top:56px;padding-bottom:8px}
.uc-head{padding-bottom:40px;border-bottom:1px solid var(--gray-1000)}
.uc-head h1{max-width:13em;font-size:clamp(44px,4.4vw + 22px,88px);line-height:.98;letter-spacing:-0.05em;text-wrap:balance}
html[lang="ko"] .uc-head h1{line-height:1.12;letter-spacing:-0.04em}
.uc-head .lede{max-width:32em;margin:24px 0 0;font-size:19px;line-height:1.55;color:var(--gray-900);text-wrap:pretty}
.cases{margin:0;padding:0;list-style:none}
.case{display:grid;grid-template-columns:minmax(0,1fr);gap:28px;padding:40px 0;border-bottom:1px solid var(--gray-400);scroll-margin-top:calc(var(--header-h) + 16px)}
.case h2{font-size:clamp(26px,1.4vw + 20px,38px);line-height:1.12;font-weight:700;letter-spacing:-0.032em;text-wrap:balance}
html[lang="ko"] .case h2{line-height:1.28;letter-spacing:-0.022em}
.case-sit{max-width:32em;margin:14px 0 0;font-size:17px;line-height:1.62;color:var(--gray-900);text-wrap:pretty}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:20px 0 0;padding:0;list-style:none}
.chips li{padding:4px 12px;border-radius:var(--radius-full);background:var(--background-raised);box-shadow:inset 0 0 0 1px var(--gray-400);font-size:13px;line-height:18px;font-weight:600}
.case-go{margin:22px 0 0;font-size:15px;line-height:20px;font-weight:600}
.case-go a,.case-go a:visited,.uc-all,.uc-all:visited{display:inline-flex;align-items:center;gap:6px;text-decoration:underline;text-decoration-thickness:1px;text-decoration-color:var(--gray-500);text-underline-offset:4px}
.case-go a:hover,.uc-all:hover{text-decoration-color:currentColor}
.case-go .arr,.uc-all .arr{transition:transform var(--dur-fast) ease}
.case-go a:hover .arr,.uc-all:hover .arr{transform:translateX(2px)}
.case-fig{margin:0;padding:clamp(18px,3vw,36px) clamp(14px,3vw,36px);border-radius:var(--r-big);background:var(--background-200);color:var(--gray-1000)}
.flow .fig-svg{margin:0 auto}
.flow .fv{display:none}
.uc-not{margin:40px 0 0;font-size:15px;line-height:22px;color:var(--gray-900)}
.uc-not a,.uc-not a:visited{color:var(--gray-1000);font-weight:600;text-decoration:underline;text-decoration-color:var(--gray-500);text-underline-offset:4px}
.uc-row{margin-top:64px;padding-top:28px;border-top:1px solid var(--gray-500)}
.uc-row-h{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 24px}
.uc-row-h h3{font-size:22px;line-height:28px;font-weight:700;letter-spacing:-0.02em}
.uc-all{font-size:15px;line-height:20px;font-weight:600}
.ucards{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;margin:20px 0 0;padding:0;list-style:none}
.ucard,.ucard:visited{display:flex;flex-direction:column;gap:8px;height:100%;padding:22px 22px 20px;border-radius:var(--r-card);background:var(--background-raised);box-shadow:inset 0 0 0 1px var(--gray-400);transition:box-shadow var(--dur-fast) ease,transform var(--dur-fast) ease}
.ucard:hover{text-decoration:none;box-shadow:inset 0 0 0 1px var(--gray-1000)}
.ucard-t{font-size:18px;line-height:24px;font-weight:700;letter-spacing:-0.015em}
.ucard-d{font-size:15px;line-height:22px;color:var(--gray-900)}
.ucard-f{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;margin-top:auto;padding-top:12px;font-size:12px;line-height:18px;font-weight:600;color:var(--gray-900)}
.ucard-f .ico{width:12px;height:12px}
@media (max-width:639px){
  .flow .fh{display:none}
  .flow .fv{display:block;width:100%;max-width:300px;height:auto}
}
@media (min-width:768px){
  .uc{padding-top:88px}
  .ucards{grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
}
@media (min-width:1100px){
  .case{grid-template-columns:minmax(0,5fr) minmax(0,7fr);column-gap:64px;align-items:center;padding:56px 0}
}

@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes drop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes settle-in{from{transform:scale(1.06)}to{transform:none}}
@keyframes pop{0%{opacity:0;transform:scale(.82)}60%{opacity:1;transform:scale(1.035)}100%{opacity:1;transform:none}}
@keyframes fly{from{opacity:0;transform:translate(var(--fx,0),var(--fy,0)) scale(.9)}to{opacity:1;transform:none}}
@keyframes type-in{0%,6%{transform:scaleX(0)}26%,86%{transform:none}100%{transform:none;opacity:0}}
@keyframes mag-scan{0%{transform:translate(-96px,-44px)}30%{transform:translate(-40px,-44px)}55%{transform:translate(-80px,-20px)}80%,100%{transform:none}}
@keyframes key-in{0%,8%{opacity:0;transform:translateX(34px)}34%,86%{opacity:1;transform:none}100%{opacity:0;transform:none}}
@keyframes ok-in{0%,40%{opacity:0;transform:scale(1.6)}52%,88%{opacity:1;transform:none}100%{opacity:0;transform:none}}
@keyframes blk-new{0%,10%{opacity:0;transform:translateX(24px)}32%,90%{opacity:1;transform:none}100%{opacity:0;transform:none}}
@keyframes cmp{0%,30%{stroke-dashoffset:40;opacity:0}46%,88%{stroke-dashoffset:0;opacity:1}100%{opacity:0}}
@keyframes rin-hl{0%,8%{background:transparent}16%,100%{background:var(--background-200)}}
@keyframes rin-ask{0%,12%{opacity:0;transform:translateY(6px) scale(.9)}20%,52%{opacity:1;transform:none}60%,100%{opacity:0;transform:translateY(-4px)}}
@keyframes card-turn{from{opacity:0;transform:rotateY(-58deg) translateX(-24px) scale(.94)}to{opacity:1;transform:none}}
@keyframes look-in{0%,30%{opacity:0;transform:translateY(6px)}40%,100%{opacity:1;transform:none}}
@keyframes look-in2{0%,52%{opacity:0;transform:translateY(6px)}62%,100%{opacity:1;transform:none}}
@keyframes bob{from{translate:0 0}to{translate:0 -10px}}
@keyframes rv{from{opacity:0;transform:translateY(32px)}to{opacity:1;transform:none}}
@keyframes env-drop{0%{opacity:0;transform:translate(-36px,-8px)}14%{opacity:1}52%{opacity:1;transform:translate(0,64px)}64%,100%{opacity:0;transform:translate(0,72px)}}
@keyframes slot-hit{0%{stroke-width:1.5}10%{stroke-width:3.5}30%,100%{stroke-width:1.5}}
@keyframes sig-draw{0%,8%{stroke-dashoffset:140;opacity:1}45%{stroke-dashoffset:0}90%{opacity:1}100%{stroke-dashoffset:0;opacity:0}}
@keyframes seal-in{0%,46%{opacity:0;transform:scale(1.7)}56%,90%{opacity:1;transform:none}100%{opacity:0;transform:none}}
@keyframes blk-in{0%,18%{opacity:0;transform:translateX(26px)}42%,88%{opacity:1;transform:none}100%{opacity:0;transform:none}}
@keyframes lnk-draw{0%,38%{stroke-dashoffset:16;opacity:1}54%,88%{stroke-dashoffset:0;opacity:1}100%{stroke-dashoffset:0;opacity:0}}
@keyframes ping{0%,40%{transform:none}50%{transform:scale(1.8)}62%,100%{transform:none}}
@keyframes tg{0%{fill:var(--gray-1000)}50%{fill:var(--background-raised)}}
@keyframes knob{0%,44%{transform:none}52%,94%{transform:translateX(-28px)}100%{transform:none}}
@keyframes mdot{0%{opacity:0;transform:none}6%{opacity:1}38%{opacity:1;transform:translateX(104px)}44%,50%{opacity:0;transform:translateX(112px)}51%{opacity:0;transform:none}56%{opacity:1}74%,92%{opacity:1;transform:translateX(52px)}100%{opacity:0;transform:translateX(52px)}}
@keyframes stopx{0%,72%{opacity:0}76%,92%{opacity:1}100%{opacity:0}}
@keyframes l2-scan{to{stroke-dashoffset:-13}}
@keyframes def-a{0%{opacity:0;transform:translate(-304px,56px)}3%{opacity:1}13%{transform:translate(-196px,56px)}16%{transform:translate(-176px,0)}27%{opacity:1;transform:none}30%,100%{opacity:0;transform:translateX(14px)}}
@keyframes def-c{0%,8%{opacity:0;transform:translateX(-246px)}11%{opacity:1}20%{transform:translateX(-130px)}32%,90%{opacity:1;transform:none}97%,100%{opacity:0;transform:none}}
@keyframes def-rb{0%,19%{opacity:0;transform:scale(.3)}23%{opacity:1;transform:scale(1.3)}26%,100%{opacity:1;transform:none}}
@keyframes def-b{0%,30%{opacity:0;transform:translate(-330px,-88px)}33%{opacity:1}41%{transform:translate(-214px,-88px)}45%{transform:translate(-200px,0)}54%,90%{opacity:1;transform:none}97%,100%{opacity:0;transform:none}}
@keyframes def-kb{0%,40%{opacity:0;transform:scale(.3)}44%{opacity:1;transform:scale(1.3)}47%,100%{opacity:1;transform:none}}
@keyframes def-tray{0%,53%{stroke-width:1.5}56%{stroke-width:3}66%,100%{stroke-width:1.5}}
@keyframes def-bell{0%,55%{transform:none}57%{transform:rotate(14deg)}59%{transform:rotate(-12deg)}61%{transform:rotate(8deg)}63%,100%{transform:none}}
@keyframes def-ring-b{0%,55%{opacity:0;transform:none}57%{opacity:.8}67%,100%{opacity:0;transform:scale(1.9)}}
@keyframes def-d{0%,64%{opacity:0;transform:translateX(-60px)}68%{opacity:1}76%,90%{opacity:1;transform:none}97%,100%{opacity:0;transform:none}}
@keyframes def-ring{0%,76%{opacity:0;transform:none}78%{opacity:.8}88%,100%{opacity:0;transform:scale(1.9)}}
@keyframes hdr-line{from{box-shadow:inset 0 -1px 0 transparent}}
@supports (animation-timeline:scroll()){
  .top{animation:hdr-line linear both;animation-timeline:scroll(root);animation-range:0 48px}
}
@supports (animation-timeline:view()){
  .rv{animation:rv linear forwards;animation-timeline:view();animation-range:entry 0% entry 70%}
  .pillars .pl:nth-child(2),.facts li:nth-child(2),.proofs li:nth-child(2),.layers li:nth-child(2){animation-range:entry 8% entry 78%}
  .pillars .pl:nth-child(3),.facts li:nth-child(3),.proofs li:nth-child(3){animation-range:entry 16% entry 86%}
  .pillars .pl:nth-child(4){animation-range:entry 24% entry 94%}
}

@media (max-width:767px){
  .sec-in,.wrap,.cta-card{padding-left:16px;padding-right:16px}
  .gcode{font-size:22px;line-height:30px}
  .sec{padding:64px 0}
  .cta{padding:80px 0 88px}
  .idc.back .json{display:none}
  .faq details p{padding-right:0}
  .limits{min-width:520px}
  .limits th,.limits td{padding:0 12px}
  .limits th:first-child{min-width:0;width:112px;font-size:14px;line-height:20px}
  .pricing .tbl{animation-name:cmp-end;animation-timing-function:linear;animation-fill-mode:both;animation-timeline:scroll(self x)}
  @supports selector(:popover-open){
    .mnav-b{display:flex}
    .mnav-p:popover-open{position:fixed;inset:8px 8px auto 8px;top:calc(var(--header-h) - 4px);width:auto;max-height:calc(100dvh - var(--header-h));margin:0;padding:8px 20px;overflow:auto;border:0;border-radius:var(--r-img);display:grid;background:var(--background-raised);color:var(--gray-1000);box-shadow:var(--shadow-menu);animation:drop var(--dur-base) var(--ease-out)}
    .mnav-p::backdrop{background:var(--scrim);animation:fade var(--dur-base) var(--ease-out)}
    body:has(.mnav-p:popover-open){overflow:hidden}
  }
  @supports not selector(:popover-open){
    .mnav-p{display:flex;flex-wrap:wrap;gap:0 16px;padding:0 20px 8px}
    .mnav-p a{height:40px;border-bottom:0;font-size:15px}
  }
}
@keyframes cmp-end{from,99%{-webkit-mask-image:linear-gradient(90deg,var(--gray-1000) 82%,transparent);mask-image:linear-gradient(90deg,var(--gray-1000) 82%,transparent)}to{-webkit-mask-image:none;mask-image:none}}
@media (pointer:coarse){
  .btn.sm{height:40px}
  .btn:not(.sm){min-height:44px}
  .logo{display:inline-flex;align-items:center;min-height:40px}
  .check{grid-template-columns:20px minmax(0,1fr);gap:12px;min-height:40px;align-items:center}
  .check input{width:20px;height:20px;margin:0}
  .foot nav a,.doc .toc a{min-height:40px}
  .nav-main a,.nav a.plain{height:40px}
}
@media (min-width:768px){
  .wrap,.sec-in,.hero-in{padding-left:32px;padding-right:32px}
  .bar3{grid-template-columns:minmax(max-content,1fr) auto minmax(max-content,1fr)}
  .nav-main{display:flex}
  .acct a.plain{display:inline-flex}
  .mnav-b{display:none !important}
  .sec-head h2{font-size:44px}
  .hero .lede{font-size:18px}
  .stage{height:640px;padding:0;margin-top:40px}
  .stage .hero-id{max-width:320px}
  .stage .m{width:220px}
  .m3,.m4{display:block}
  .m1{top:12px;right:auto;left:0;--fx:-220px;--fy:-80px}
  .m2{top:60px;right:0;bottom:auto;left:auto;--fx:220px;--fy:-80px}
  .m3{bottom:16px;left:0;--fx:-220px;--fy:80px}
  .m4{bottom:0;right:0;--fx:220px;--fy:80px}
  .sep-fig{padding:0 0 72px}
  .box{width:340px}
  .box.you{top:32px;left:24px}
  .box.agent{right:24px}
  .box.join{display:block}
  .pillars{grid-template-columns:repeat(2,minmax(0,1fr))}
  .facts{grid-template-columns:repeat(3,minmax(0,1fr));gap:32px}
  .layers{grid-template-columns:repeat(2,minmax(0,1fr));gap:32px}
  .desk{padding:64px 32px}
  .cta-card{padding:0 32px}
  .pr-head{padding-left:32px;padding-right:32px}
  .foot .fgrid{grid-template-columns:2fr 1fr 1fr}
    .cl{padding-top:72px;padding-bottom:120px}
  .cl-day{grid-template-columns:200px minmax(0,1fr);gap:32px;padding:32px 0 36px}
  .cl-date{position:sticky;top:calc(var(--header-h) + 20px);align-self:start;padding-top:2px}
  .doc{padding-top:72px;padding-bottom:96px}
  .items>div{grid-template-columns:200px minmax(0,1fr);gap:24px}
  .auth{padding-top:80px}
  .auth h1{font-size:44px}
  .nf{padding-top:128px;padding-bottom:144px}
  .plans{grid-template-columns:repeat(3,minmax(0,1fr));padding:0 32px}
  .pr-sec{padding-left:32px;padding-right:32px}
  .pr-sec>h2{font-size:40px}
  .price{height:56px}
  .price .amt.word{font-size:20px;line-height:28px}
}
/* 768-1023: the full header (four links + log in + waitlist) fits with exact centring only with tighter link padding (2026-10-01 measure:
   EN 2*198+262+16=674 <= 689 content px at 768 with a 15px scrollbar; with 14px padding it would need 722). The menu button is phones only. */
@media (min-width:768px) and (max-width:1023px){
  .nav-main a,.nav a.plain{padding:0 10px}
}
@media (min-width:960px){
  .sec{padding:120px 0}
  .sec-head{margin-bottom:48px}
  .sec-head h2{font-size:56px}
  .sep-in{grid-template-columns:minmax(0,1fr) minmax(0,600px);gap:72px}
  .sep-fig{padding:0 0 72px}
  .photo img{aspect-ratio:5/4}
  .box.you{top:24px;left:-48px}
  .box.agent{right:-24px;bottom:0}
  .split{grid-template-columns:minmax(0,1fr) minmax(0,420px);gap:72px;align-items:start}
  .faq-in{grid-template-columns:minmax(0,340px) minmax(0,1fr)}
  .desk{padding:96px 48px;min-height:620px}
  .deck{grid-template-columns:repeat(2,minmax(0,1fr));align-items:center;max-width:860px;gap:0}
  .deck .idc.front{z-index:2;margin-right:-28px;transform:rotate(-3deg) translateY(14px);box-shadow:inset 0 0 0 1px var(--gray-400),0 36px 80px -28px var(--lift)}
  .deck .idc.back{margin-left:-28px;padding-left:64px;transform:rotate(2.5deg) translateY(-10px)}
  .idc .idc-art{width:64px;height:64px}
  .dark{padding:120px 0 128px}
  .proofs{grid-template-columns:repeat(3,minmax(0,1fr))}
  .def-in{grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:56px 64px}
  .layers{grid-template-columns:minmax(0,1fr);gap:36px}
  .cta{padding:160px 0 168px}
}
@media (min-width:1024px){
  .hero{min-height:min(100svh,1000px);padding:calc(var(--header-h) + 40px) 0 32px}
  .stage{height:480px;margin-top:20px}
  .stage .hero-id{max-width:340px}
  .stage .m{width:252px}
  .m1{top:24px;left:2%}
  .m2{top:60px;right:1%}
  .m3{bottom:40px;left:9%}
  .m4{bottom:6px;right:8%}
  .pillars{grid-template-columns:repeat(4,minmax(0,1fr));gap:28px}
}
@media (min-width:1150px){
  .plans{grid-template-columns:repeat(5,minmax(0,1fr))}
  .price{height:48px}
  .price .amt{font-size:40px;line-height:48px}
  .doc:has(>.toc){display:grid;grid-template-columns:220px minmax(0,720px);column-gap:64px;align-items:start}
  .doc:has(>.toc)>*{grid-column:2;margin-top:0;margin-bottom:0}
  .doc:has(>.toc)>h1{margin-top:12px;margin-bottom:16px}
  .doc:has(>.toc)>.intro{margin-top:24px}
  .doc:has(>.toc)>section>:last-child,.doc:has(>.toc)>section>:last-child>:last-child{margin-bottom:0}
  .doc:has(>.toc)>.toc{grid-column:1;grid-row:1/span 60;position:sticky;top:calc(var(--header-h) + 24px);margin-top:0;padding:0;border-radius:0;background:none}
}
@media (max-height:500px) and (orientation:landscape){
  .hero{padding-top:24px}
  .auth{padding-top:24px}
  .doc,.pr-head{padding-top:32px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;scroll-behavior:auto!important}
  .rw>span:first-child{opacity:1}
  .pricing .tbl{animation-name:cmp-end!important;animation-timeline:scroll(self x)!important}}
`;

/** 홈의 모든 페이지가 싣는 스타일 — 폰트(`@font-face` — Pretendard Variable) + 위 본문. */
export const SITE_CSS = `\n${FONT_FACE_CSS}\n${SITE_CSS_NO_FONTS}`;
