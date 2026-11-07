/**
 * src/admin/ui/styles.ts — 관리 화면 페이지가 공유하는 스타일시트 하나(같은 출처 불변 자산 하나 — `page.ts` `/_assets/<해시>/console.css` · SRI).
 *
 * "Geist 구조, Atmark 잉크"(`.omc/plans/vercel-redesign.md` — 운영 콘솔이라 에디토리얼 기본값(크림·세리프)은 쓰지 않는다):
 *   - 셸의 색은 **토큰(CSS 변수)으로만** 쓴다 — 값은 맨 앞 토큰 블록(`CONSOLE_LIGHT` · `CONSOLE_DARK`)에만 있다. 이름은 Vercel 식
 *     회색 스케일(`--background-*` · `--gray-100…1000` · `--gray-alpha-*`)이고 값은 전부 회색(r=g=b)이다. 회색 밖의 셸 색은 **하나**:
 *   - 브랜드는 완전 무채색(진윤겸 2026-09-29) — 로고(`src/ui/brand.ts` — `currentColor`)와 에이전트 주소의 `@`(`.at`)도 주변 글자색 그대로. 주황은 어디에도 없다(테스트가 `#F97316` 이 한 번이라도 나오면 빨개진다).
 *   - **파란색 금지** — 브라우저 기본값이 파란 곳을 전부 덮는다: 링크 색, 포커스 링(`:focus-visible` = `--focus-ring`),
 *     체크박스·라디오(`accent-color`), 선택 영역(`::selection`), 탭 하이라이트.
 *   - 윤곽은 테두리 대신 **shadow-as-border**(`--shadow-border` 등 — 두 번째 `:root{}` 의 비색상 토큰). 카드는 반경 12, 조작부는 6.
 *   - **빨강 = 되돌릴 수 없는 동작·오류 전용**(`--red-*` — 위험 버튼·위험 카드·확인 머리·⋯ 폐기 항목·칸 오류·부팅 실패). 상태는 흑백 글리프 + 글자(`.pill` · `.dot`).
 *   - 콘솔 본문(`.main`)에는 **최대폭이 없다**(목록·표·개요 = 전체 폭). 읽고 쓰는 폼(설정 카드·연결·조직 고르기)만 880px 열.
 *   - 기억점은 신원 ID 카드(`.idc` — 세로 ID-1 배지, 53.98:85.6) 하나다. 나머지는 조용한 회색 셸.
 *   - **유채색은 신원 표면에만**(v4 D1 · `console-v4-design.md` §3.1 C1–C5): `.idc`(카드)·`.idthumb`(썸네일) 규칙 안에서만, 모양은
 *     `oklch(<L> <C> var(--h))` 하나 — L 은 상수(명도 대비 보장), C 는 상수 × `--cs`(상태: 게시 전·폐기·키 없음 0 · 게시 중단 .4),
 *     `--h` 는 스크립트가 키 지문에서 뽑아 CSSOM 으로 준다(주황 대역 25–75° 와 파랑 대역(OKLCH) 180–295° 는 나오지 않는다 — 브랜드는 무채색, 파랑은 0). 리터럴 유채색 hex 는
 *     없다. `oklch` 를 모르는 브라우저는 `@supports not` 이 회색 카드로 떨어뜨린다(C5).
 * 셸(§4): 블러 헤더(breadcrumb 스위처) + 좌측 사이드바. 사이드바는 ≥1150 펼침 240(사용자가 레일 56 으로 접는다 — `html[data-side="rail"]`,
 * 첫 칠 전에 `page.ts` `THEME_BOOT_JS` 가 적는다) · 768–1149 레일(누르면 겹침 패널) · ≤767 서랍. 레일 모양은 사이드바 폭을 보는
 * 컨테이너 쿼리(`@container side`) 하나로 그린다 — 레일이 된 이유(사용자 선택 · 화면 폭)와 무관하게 같은 규칙.
 * 다크 모드(US-014): 시스템 설정을 따르고, 설정 화면·사이드바의 테마(시스템·라이트·다크)가 `html[data-theme]` 을 적으면 그것이 이긴다.
 * 폰트는 자체 호스팅 Pretendard Variable 하나(`src/ui/fonts.ts` — 같은 오리진 `/_fonts/…`, CSP `font-src 'self'`). 없으면 시스템 글꼴.
 * ASCII 만(해시가 인코딩에 흔들리지 않게). 로그인·가입 화면(`login.ts`·`signup.ts`·`invite.ts`)이 쓰는 클래스(`.shell` · `.panel` · `.alt` ·
 * `.field` · `.btn` · `.note` · `.check`)는 이 파일 앞쪽 공용 절에 있다.
 */

import { SITE_ORIGIN } from '../../site/constants';
import { fontFaceCss } from '../../ui/font-faces';
import { BASE_TOKENS } from '../../ui/tokens';

/** 색 토큰 이름(`--` 를 뗀 것) — 순서가 곧 토큰 블록의 순서다(사이트 `SITE_LIGHT/DARK` 와 같은 키·같은 값). */
export const CONSOLE_TOKEN_NAMES = [
  'background-100',
  'background-200',
  'background-raised',
  'gray-100',
  'gray-200',
  'gray-300',
  'gray-400',
  'gray-500',
  'gray-600',
  'gray-700',
  'gray-800',
  'gray-900',
  'gray-1000',
  'gray-alpha-100',
  'gray-alpha-200',
  'gray-alpha-400',
  'shadow-near',
  'shadow-far',
  'scrim',
  'focus-ring',
  'red-700',
  'red-100',
  'red-solid',
  'red-alpha',
  'on-red',
] as const;

/**
 * 색 토큰 한 벌 — 값은 회색 hex 나 회색 rgba 뿐이다. **예외 하나: 빨강(`--red-*` · `--on-red`) = 되돌릴 수 없는 동작·오류 전용**(2026-09-27 리드 판정).
 * 브랜드가 무채색이라 주황은 없고, 이건 별개의 의미 색이다. 상태 배지·한도 초과·로그 결과는 흑백 그대로. 파랑은 여전히 없다.
 *   red-700 — 글자·선(바탕 위 ≥4.5) · red-100 — 옅은 면 · red-solid — 확인 대화상자의 실행 버튼 채움(흰 글자 ≥4.5) · red-alpha — 호버 면.
 */
export type ConsolePalette = Readonly<Record<(typeof CONSOLE_TOKEN_NAMES)[number], string>>;

/** 밝은 벌(기본) — 바탕 `#FFFFFF` · 주 글자 `#171717` · 보조 `#666666` · 조작부 경계 `#858585`. */
export const CONSOLE_LIGHT: ConsolePalette = {
  'background-100': '#FFFFFF',
  'background-200': '#FAFAFA',
  'background-raised': '#FFFFFF',
  'gray-100': '#F5F5F5',
  'gray-200': '#EFEFEF',
  'gray-300': '#E8E8E8',
  'gray-400': '#E3E3E3',
  'gray-500': '#C7C7C7',
  'gray-600': '#858585',
  'gray-700': '#171717',
  'gray-800': '#383838',
  'gray-900': '#666666',
  'gray-1000': '#171717',
  'gray-alpha-100': 'rgba(0,0,0,.03)',
  'gray-alpha-200': 'rgba(0,0,0,.06)',
  'gray-alpha-400': 'rgba(0,0,0,.08)',
  'shadow-near': 'rgba(0,0,0,.05)',
  'shadow-far': 'rgba(0,0,0,.1)',
  scrim: 'rgba(0,0,0,.4)',
  'focus-ring': '#171717',
  'red-700': '#C1121F',
  'red-100': '#FDECEC',
  'red-solid': '#C1121F',
  'red-alpha': 'rgba(193,18,31,.08)',
  'on-red': '#FFFFFF',
};

/**
 * 어두운 벌(콘솔 시각 언어 전환 — `.omc/plans/astryx-transition.md` §8) — 짙은 회색 바탕(`#1B1B1B`)에 흰 글자(`#F1F1F1`). 푸터·오목한 칸은
 * 한 단 내려가고(`#161616`), 메뉴·대화상자 면은 한 단 뜬다(`#262626`). 윤곽은 밝은 alpha(`--gray-alpha-400`)라 카드 모양은 밝은 벌과 같다.
 */
export const CONSOLE_DARK: ConsolePalette = {
  'background-100': '#1B1B1B',
  'background-200': '#161616',
  'background-raised': '#262626',
  'gray-100': '#262626',
  'gray-200': '#2B2B2B',
  'gray-300': '#303030',
  'gray-400': '#3B3B3B',
  'gray-500': '#525252',
  'gray-600': '#808080',
  'gray-700': '#F1F1F1',
  'gray-800': '#C9C9C9',
  'gray-900': '#9E9E9E',
  'gray-1000': '#F1F1F1',
  'gray-alpha-100': 'rgba(255,255,255,.05)',
  'gray-alpha-200': 'rgba(255,255,255,.1)',
  'gray-alpha-400': 'rgba(255,255,255,.12)',
  'shadow-near': 'rgba(0,0,0,.4)',
  'shadow-far': 'rgba(0,0,0,.5)',
  scrim: 'rgba(0,0,0,.7)',
  'focus-ring': '#F1F1F1',
  'red-700': '#FF8A80',
  'red-100': '#3A2020',
  'red-solid': '#D32F2F',
  'red-alpha': 'rgba(255,138,128,.12)',
  'on-red': '#FFFFFF',
};

const decls = (p: ConsolePalette): string =>
  CONSOLE_TOKEN_NAMES.map((k) => `--${k}:${p[k]}`).join(';');

/** 토큰 블록 — 밝은 벌이 기본, 시스템이 다크면 어두운 벌, `html[data-theme]` 이 있으면 그것이 이긴다. `color-scheme` 도 같이. */
const CONSOLE_TOKENS =
  `:root{${decls(CONSOLE_LIGHT)};color-scheme:light}\n` +
  `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${decls(CONSOLE_DARK)};color-scheme:dark}}\n` +
  `:root[data-theme="dark"]{${decls(CONSOLE_DARK)};color-scheme:dark}`;


/**
 * 콘솔 폰트는 **사이트 출처**에서 받는다(리뷰 M4) — `https://atmark.ai/_fonts/…`(사이트 CloudFront 캐시). 콘솔 admin λ(예약 동시성 3)는 폰트를
 * 내지 않고, admin 번들에 폰트 데이터가 없다(`font-faces.ts` 는 메타만). CSP `font-src` 는 그 출처 하나(`page.ts`).
 */
export const CONSOLE_FONT_ORIGIN = SITE_ORIGIN;

/** 폰트 출처별 스타일시트(운영은 `CONSOLE_FONT_ORIGIN`, 로컬 미리보기는 `http://127.0.0.1:<포트>`). 폰트 뒤는 한 벌이다. */
export function adminUiCss(fontOrigin: string): string {
  return `\n${fontFaceCss(fontOrigin)}${ADMIN_UI_CSS_REST}`;
}

/**
 * 콘솔 전용 재질·치수(시각 언어 전환 — `.omc/plans/astryx-transition.md` §3·§4·§6·§8). `BASE_TOKENS`(사이트와 공유) 바로 뒤에서 콘솔만 덮는다 —
 * 사이트는 그대로다. 고도는 "페이지에서 떨어진 정도"로: 카드·요약 칸은 평면(1px 선, 그림자 0), 메뉴·ⓘ·토스트는 med, 대화상자·서랍은 high.
 * 반경은 element 10(버튼·입력·내비·메뉴 항목) · inner 6(`--radius-xs` — 칩·툴팁·스켈레톤) · container 12(`--radius-md`, 카드).
 */
const CONSOLE_SHAPE = `:root{--radius-sm:10px;--radius-xs:6px;--header-h:48px;--side-w:260px;--side-rail:48px;--dur-fast:125ms;--ease-out:cubic-bezier(.24,1,.4,1);
--shadow-small:var(--shadow-border);--shadow-medium:var(--shadow-border);--shadow-large:var(--shadow-border);
--shadow-menu:0 0 0 1px var(--gray-alpha-400),0 2px 4px var(--shadow-near),0 4px 12px var(--shadow-far);
--shadow-modal:0 0 0 1px var(--gray-alpha-400),0 4px 6px var(--shadow-far),0 12px 24px var(--shadow-far)}`;

const ADMIN_UI_CSS_REST = `
${CONSOLE_TOKENS}
${BASE_TOKENS}
${CONSOLE_SHAPE}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth;scroll-padding-top:calc(var(--header-h) + var(--space-6))}
body{margin:0;background:var(--background-100);color:var(--gray-1000);font-family:var(--font-sans);font-size:14px;line-height:22px;font-synthesis:none;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;word-break:keep-all;overflow-wrap:break-word;-webkit-tap-highlight-color:transparent}
::selection{background:var(--gray-1000);color:var(--background-100)}
a{color:inherit;text-decoration:underline;text-decoration-thickness:1px;text-decoration-color:var(--gray-500);text-underline-offset:3px;transition:text-decoration-color var(--dur-fast) ease,color var(--dur-fast) ease,background-color var(--dur-fast) ease}
a:hover{text-decoration-color:var(--gray-1000)}
:focus{outline:none}
:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
input,select,textarea,button{font:inherit;color:inherit;accent-color:var(--gray-1000)}
h1,h2,h3,h4{margin:0;font-weight:600;line-height:1.3}
p{margin:0}
code,pre,.mono{font-family:var(--font-mono);font-size:.93em;word-break:normal;overflow-wrap:anywhere}
[hidden]{display:none !important}
.num{font-variant-numeric:tabular-nums}

/* logo = the inline lockup SVG (src/ui/brand.ts), sized by height, painted with currentColor */
.logo{display:block;flex:none;width:auto;height:20px}

.kicker{font-size:12px;line-height:16px;font-weight:500;color:var(--gray-900)} /* sentence case in both languages - no uppercase-tracked eyebrow */
.muted{color:var(--gray-900)}
.small{font-size:13px;line-height:20px}
.note{margin:16px 0;padding:12px 16px;border-radius:var(--radius-md);background:var(--gray-100);font-size:13px;line-height:20px;max-width:68ch}
.note p+p{margin-top:4px}
.note .muted{display:block}
.warnbox{margin:0 0 16px;padding:12px var(--card-pad);border-radius:var(--radius-md);background:var(--hatch-wide);box-shadow:0 0 0 1px var(--gray-1000);font-size:14px;line-height:20px}
.warnbox>strong{display:block;font-weight:500;margin-bottom:4px}
.warnbox .hrow strong{margin:0;font-weight:500}
.warnbox>.hrow{flex-wrap:nowrap;align-items:flex-start}
.warnbox>.hrow>strong{flex:0 1 auto;min-width:0}
.warnbox>.hrow>.more,.warnbox>.hrow>.tip-btn{flex:none}

.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:32px;padding:0 12px;border:0;border-radius:var(--radius-sm);background:var(--gray-700);color:var(--background-100);font-size:14px;line-height:20px;font-weight:500;text-decoration:none;white-space:nowrap;cursor:pointer;flex:none;transition:background-color var(--dur-fast) ease,color var(--dur-fast) ease,box-shadow var(--dur-fast) ease}
.btn:hover{background:var(--gray-800)}
.btn:not(:disabled):not([aria-disabled="true"]):active{background:var(--gray-1000)} /* pressed: one step back from hover (critique R10-07) */
.btn.ghost{background:var(--gray-alpha-200);color:var(--gray-1000);box-shadow:none} /* secondary = a quiet fill, no outline (transition spec 7) */
.btn.ghost:hover{background:var(--gray-alpha-400)}
.btn.ghost:not(:disabled):active{background:var(--gray-alpha-400)}
.btn:not(:disabled):not([aria-disabled="true"]):active{transform:scale(.98)}
.btn.link{height:32px;padding:0 8px;background:transparent;color:var(--gray-1000);box-shadow:none}
.btn.link:hover{background:var(--gray-alpha-100)}
.btn.link:not(:disabled):active{background:var(--gray-alpha-200)}
.btn.danger{background:var(--background-100);color:var(--red-700);box-shadow:inset 0 0 0 1px var(--red-700)} /* irreversible action (red = irreversible and errors only) */
.btn.danger:hover{background:var(--red-alpha)}
.btn.danger:not(:disabled):active{background:var(--red-100)}
.btn.danger.solid{background:var(--red-solid);color:var(--on-red);box-shadow:none} /* the confirm dialog's run button */
.btn.danger.solid:hover{background:var(--red-solid);filter:brightness(1.08)}
.btn.sm{height:28px;padding:0 10px}
.btn.lg{height:36px;padding:0 14px}
/* disabled = one look everywhere (2026-10-15 UI audit F25): no fill, a dashed ring, muted text, not-allowed - the reason is the title or the line under it.
   .danger.solid (the confirm's run button, locked until its check is ticked) is listed so the red fill never reads as live. */
.btn:disabled,.btn:disabled:hover,.btn[aria-disabled="true"],.btn[aria-disabled="true"]:hover,.btn.danger.solid:disabled,.btn.danger.solid:disabled:hover{background:transparent;color:var(--gray-700);box-shadow:none;border:1px dashed var(--gray-500);cursor:not-allowed;filter:none}
.btn.busy{cursor:progress}
.btn.busy::before{content:"";width:12px;height:12px;flex:none;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

label{display:block}
fieldset{border:0;padding:0;margin:0 0 16px;min-width:0}
.field{margin:0 0 16px}
.field>span,.lbl{display:block;font-size:14px;line-height:20px;font-weight:500;margin-bottom:8px}
.field small{display:block;color:var(--gray-900);font-size:13px;line-height:18px;margin-top:8px}
input[type=text],input[type=password],input[type=email],input[type=search],input[type=number],input[type=date],select,textarea{width:100%;height:36px;padding:0 12px;border:0;border-radius:var(--radius-sm);background-color:var(--background-100);color:var(--gray-1000);box-shadow:inset 0 0 0 1px var(--gray-600);font-size:14px;line-height:20px;transition:box-shadow var(--dur-fast) ease}
textarea{height:auto;min-height:88px;padding:8px 12px;resize:vertical}
input::placeholder,textarea::placeholder{color:var(--gray-900);opacity:1}
input[type=text]:hover,input[type=password]:hover,input[type=email]:hover,input[type=search]:hover,input[type=number]:hover,input[type=date]:hover,select:hover,textarea:hover{box-shadow:inset 0 0 0 1px var(--gray-1000)}
input[type=text]:focus,input[type=password]:focus,input[type=email]:focus,input[type=search]:focus,input[type=number]:focus,input[type=date]:focus,select:focus,textarea:focus{outline:none;box-shadow:inset 0 0 0 1px var(--gray-1000)}
input[type=text]:focus-visible,input[type=password]:focus-visible,input[type=email]:focus-visible,input[type=search]:focus-visible,input[type=number]:focus-visible,input[type=date]:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px;box-shadow:inset 0 0 0 1px var(--gray-1000)}
[aria-invalid="true"],[aria-invalid="true"]:is(input,select,textarea),[aria-invalid="true"]:is(input,select,textarea):is(:hover,:focus,:focus-visible){box-shadow:inset 0 0 0 2px var(--red-700)} /* stays red while focused (same weight as the input :focus rules, later) */
/* the select chevron is the icon set's line chevron (1.5 stroke, open V), drawn as two 1.5px strokes - CSP allows no data: image (critique R10-06) */
select{-webkit-appearance:none;appearance:none;padding-right:32px;background-image:linear-gradient(45deg,transparent calc(50% - .75px),currentColor calc(50% - .75px) calc(50% + .75px),transparent calc(50% + .75px)),linear-gradient(-45deg,transparent calc(50% - .75px),currentColor calc(50% - .75px) calc(50% + .75px),transparent calc(50% + .75px));background-position:calc(100% - 17px) 50%,calc(100% - 12.5px) 50%;background-size:5px 5px;background-repeat:no-repeat;cursor:pointer}
select:disabled{color:var(--gray-900);background-color:var(--gray-100);cursor:not-allowed}
/* checkbox and radio drawn by us, not the UA (critique R9-02): in dark mode Chrome filled an unchecked box with dark grey at ~1.3:1.
   Empty box + gray-600 edge in both themes (the >=3:1 control-edge rule); the check is a CSS shape (no image, no data: URI). */
input[type=checkbox],input[type=radio]{-webkit-appearance:none;appearance:none;display:inline-grid;place-content:center;width:16px;height:16px;margin:0;flex:none;cursor:pointer;border-radius:4px;background:var(--background-100);box-shadow:inset 0 0 0 1px var(--gray-600);transition:background-color var(--dur-fast) ease,box-shadow var(--dur-fast) ease}
input[type=radio]{border-radius:50%}
input[type=checkbox]::before{content:"";width:9px;height:5px;margin-top:-2px;border:solid var(--background-100);border-width:0 0 2px 2px;transform:rotate(-45deg) scale(0);transition:transform var(--dur-fast) ease}
input[type=radio]::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--gray-1000);transform:scale(0);transition:transform var(--dur-fast) ease}
input[type=checkbox]:checked{background:var(--gray-1000);box-shadow:inset 0 0 0 1px var(--gray-1000)}
input[type=radio]:checked{box-shadow:inset 0 0 0 1px var(--gray-1000)}
input[type=checkbox]:checked::before{transform:rotate(-45deg) scale(1)}
input[type=radio]:checked::before{transform:scale(1)}
input[type=checkbox]:hover:not(:disabled),input[type=radio]:hover:not(:disabled){box-shadow:inset 0 0 0 1px var(--gray-1000)}
input[type=checkbox]:disabled,input[type=radio]:disabled{background:var(--gray-100);box-shadow:inset 0 0 0 1px var(--gray-400);cursor:not-allowed}
input[type=checkbox]:disabled:checked{background:var(--gray-600);box-shadow:inset 0 0 0 1px var(--gray-600)}
input[type=radio]:disabled::before{background:var(--gray-600)}
.check{display:flex;gap:8px;align-items:flex-start;margin:8px 0;font-size:14px;line-height:20px}
.check input{margin-top:2px}
.field>.suffix,.suffix{display:flex;align-items:stretch;margin:0;border-radius:var(--radius-sm)}
.suffix input{flex:1;min-width:0;border-radius:var(--radius-sm) 0 0 var(--radius-sm)}
.suffix select{flex:none;width:auto;max-width:45%;border-radius:0 var(--radius-sm) var(--radius-sm) 0;margin-left:-1px}
.suffix b{display:flex;align-items:center;padding:0 12px;border-radius:0 var(--radius-sm) var(--radius-sm) 0;background:var(--gray-100);box-shadow:inset 0 1px 0 var(--gray-600),inset -1px 0 0 var(--gray-600),inset 0 -1px 0 var(--gray-600);font-size:14px;font-weight:400;color:var(--gray-900);white-space:nowrap}
.row{display:flex;gap:12px 16px;flex-wrap:wrap;align-items:flex-end}
.row>.field{flex:1 1 200px}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.msg{font-size:14px;line-height:20px;margin-top:12px}
.msg:empty{margin:0}
.msg.err{font-weight:500;color:var(--red-700)}
.msg.err::before{content:"! ";font-weight:600}
.msg.ok::before,.toast::before,.day .cnt.ok::before,.legend .okm{content:"";display:inline-block;flex:none;width:9px;height:5px;margin:0 9px 3px 2px;border:solid currentColor;border-width:0 0 1.5px 1.5px;transform:rotate(-45deg);vertical-align:middle} /* the check is the icon set's check, drawn (R10-06) */

.pill{display:inline-flex;align-items:center;gap:6px;min-height:20px;padding:0 8px;border-radius:var(--radius-full);background:transparent;box-shadow:inset 0 0 0 1px var(--gray-400);color:var(--gray-1000);font-size:12px;line-height:16px;font-weight:500;white-space:nowrap;vertical-align:middle}
.pill:empty{display:none}
.pill.on::before{content:"";width:6px;height:6px;flex:none;border-radius:50%;background:currentColor}
.pill.dim{color:var(--gray-900)}
.pill.dim::before{content:"";width:6px;height:6px;flex:none;border-radius:50%;box-shadow:inset 0 0 0 1.5px var(--gray-600)}
.pill.warn::before{content:"!";font-weight:600}
/* a label, not a state (role, kind, "primary", "beta"): the one gray square chip - same as .rolechip / .cap (2026-10-15 UI audit F19, F20) */
.pill.tag{padding:0 6px;border-radius:var(--radius-xs);background:var(--gray-100);box-shadow:none;color:var(--gray-1000);font-weight:400}
/* every state is the same chip: a glyph and a word in a thin ring (2026-10-11, owner: active and provisioning get the same badge); alarms differ only by an ink ring and the x */
.pill.wait::before{content:"";width:6px;height:6px;flex:none;border-radius:50%;background:linear-gradient(90deg,currentColor 50%,transparent 50%);box-shadow:inset 0 0 0 1px currentColor;animation:pulse 1.2s ease-in-out infinite alternate}
@keyframes pulse{from{opacity:1}to{opacity:.35}}
/* alarm state = an x glyph in an ink-bordered chip (spec s3.4: blocked = x). The old hatched band was clipped by the round chip into a half-moon (2026-10-11). */
.pill.bad,.pill.bad.bad{box-shadow:inset 0 0 0 1.5px var(--gray-1000)}
.pill.bad::before{content:"";width:8px;height:8px;flex:none;background:linear-gradient(45deg,transparent calc(50% - .75px),currentColor calc(50% - .75px) calc(50% + .75px),transparent calc(50% + .75px)),linear-gradient(-45deg,transparent calc(50% - .75px),currentColor calc(50% - .75px) calc(50% + .75px),transparent calc(50% + .75px))}

/* tables are rows, not cards (transition spec 5): no outer frame, no header fill - a 1px line under the header and between rows */
.tbl{width:100%;border-collapse:separate;border-spacing:0;background:transparent;font-size:14px;line-height:20px}
.tbl th{height:36px;padding:0 12px;text-align:left;vertical-align:middle;background:transparent;color:var(--gray-900);font-size:12px;line-height:16px;font-weight:600;white-space:nowrap;box-shadow:inset 0 -1px 0 var(--gray-alpha-400)}
.tbl th:first-child,.tbl td:first-child{padding-left:12px}
.tbl th:last-child,.tbl td:last-child{padding-right:12px}
.tbl td{height:56px;padding:8px 12px;vertical-align:middle;box-shadow:inset 0 -1px 0 var(--gray-alpha-400);transition:background-color var(--dur-fast) ease}
.tbl tbody tr:last-child td{box-shadow:none}
.tbl.dense td{height:44px;padding-top:4px;padding-bottom:4px} /* sides stay with .tbl td and the first/last-child card-pad rules: header and cell text share one line (critique R10-02) */
.tbl tr.rl{cursor:pointer}
.tbl tr.rl:hover td{background:var(--gray-alpha-100)}
.tbl .tlink{text-decoration:none;white-space:nowrap;font-variant-numeric:tabular-nums}
.tbl .tlink:hover{text-decoration:underline}
.tbl .subj{max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tbl td.act{position:relative;text-align:right;white-space:nowrap}
.tbl td{white-space:nowrap}
.tbl .cv{min-width:0;max-width:min(32ch,26cqi);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.logt .cv,#ov-log-tbl .cv,#ao-log-tbl .cv{max-width:min(28ch,16cqi)}
#ov-log-tbl td[data-k="peer"] .cv,#ao-log-tbl td[data-k="peer"] .cv,#ao-log-tbl td[data-k="subj"] .cv,.logt td[data-k="peer"] .cv,.logt td[data-k="subj"] .cv{max-width:min(48ch,30cqi)} /* F59: cut only after the spare width is used */
.tbl td:first-child .cv{max-width:min(40ch,36cqi)}
.mbn{flex-wrap:nowrap;max-width:100%}
.mbn .addr{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tbl .caps{flex-wrap:nowrap;overflow:hidden;max-width:240px}
.nmt{display:flex;flex-direction:column;min-width:0}
.nmt>*{max-width:min(32ch,30cqi);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tbl td.act .btn{margin-left:8px;height:32px;padding:0 12px}
.tbl .cv.used{white-space:nowrap}
.plt th:nth-child(n+2),.plt td:nth-child(n+2){text-align:right}
.plt td:nth-child(n+2) .cv{margin-left:auto}
.plt td,.tokt td,.okt td,.mbt td{font-variant-numeric:tabular-nums}
.tbl .cv.used.none{color:var(--gray-900)}
#pl-name{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-0.015em}
.tbl .icon-btn{width:28px;height:28px}
.tbl .strong{font-weight:500}
.sub{display:block;color:var(--gray-900);font-size:13px;line-height:18px}
/* empty state: one quiet line in the place the list would be - the sentence on the left, its one action on the right. No icon disc, no centred block. */
.empty{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 24px;min-height:56px;padding:12px var(--card-pad);border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-border);color:var(--gray-900);text-align:left}
.empty>p{grid-column:1}
.empty>p:first-of-type{color:var(--gray-1000);font-weight:500}
.empty>.btn{grid-column:2;grid-row:1}
#boot-err>p:first-of-type{color:var(--red-700)} /* a failed boot is an error sentence (red = irreversible and errors only) */
/* loading (spec s3.5, critique R7-01): grey bars in the final layout. Empty value slots draw the bar themselves (:empty), table bodies start
   with .skr rows, the boot screen is one skeleton page. Motion stops for reduced motion (global rule). */
.skel,.stats .big:empty,#org-name:empty,.sw-t:empty,.scope-t .nm:empty{border-radius:var(--radius-xs);background:var(--gray-200);animation:skel 1.4s ease-in-out infinite alternate}
.boot-failed .skel,.boot-failed #org-name:empty,.boot-failed .sw-t:empty,.boot-failed .scope-t .nm:empty{animation:none;opacity:.5}
@keyframes skel{from{opacity:1}to{opacity:.45}}
.stats .big:empty{display:block;width:56px;height:32px}
#org-name:empty,.sw-t:empty{display:inline-block;width:96px;height:12px}
.scope-t .nm:empty{display:block;width:96px;height:12px;margin:4px 0}
.tbl tr.skr td{height:56px}
.tbl.dense tr.skr td{height:44px}
.tbl tr.skr .skel{display:block;width:64%;height:12px}
.tbl tr.skr td:nth-child(2n) .skel{width:44%}
.tbl tr.skr td:nth-child(3n) .skel{width:56%}
.tbl tr.skr:nth-child(2) td:first-child .skel{width:52%}
.tbl tr.skr:nth-child(3) td:first-child .skel{width:58%}
.bootsk{display:flex;flex-direction:column;gap:24px}
.bootsk .sk-h{display:block;width:160px;height:24px;margin:4px 0}
.bootsk .sk-stats{margin:0}
.bootsk .sk-stats>div{height:88px;justify-content:center}
.bootsk .sk-stats .skel{display:block;width:56px;height:32px}
.dirfs{margin:0;min-width:0}
.toasts{position:fixed;right:16px;bottom:16px;z-index:var(--z-toast);display:flex;flex-direction:column;align-items:flex-end;gap:8px;width:min(360px,calc(100vw - 32px));pointer-events:none}
.toast{pointer-events:auto;max-width:100%;padding:12px 16px;border-radius:var(--radius-md);background:var(--background-raised);box-shadow:var(--shadow-menu);color:var(--gray-1000);font-size:14px;line-height:22px;animation:pop-in var(--dur-base) var(--ease-out)}
.msg.ok{position:absolute;width:1px;height:1px;margin:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.field>.msg.err,.field .msg.err{margin-top:8px}
.addr{word-break:normal;overflow-wrap:anywhere}

.shell{min-height:100vh;display:flex;flex-direction:column;padding:0 16px}
.shell header{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;max-width:1200px;height:64px;margin:0 auto;padding:0 24px}
.shell header .logo{height:22px}
.lang{font-size:13px;line-height:18px;color:var(--gray-900);text-decoration:none;white-space:nowrap}
.lang:hover{color:var(--gray-1000)}
.shell main{flex:1;width:min(400px,100%);margin:0 auto;padding:80px 0 64px}
.shell h1{margin:16px 0;font-size:32px;line-height:40px;font-weight:600;letter-spacing:-0.025em}
html[lang="ko"] .shell h1{letter-spacing:-0.012em}
.shell main>h1{text-align:center}
.shell main>h1~.panel,.shell main>h1+section{margin-top:24px}
.p-landing main:has(>.panel:not([hidden]))>h1{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.p-landing main>h1~.panel{margin-top:0}
.p-landing main>.panel{margin-top:0;padding:0;background:transparent;box-shadow:none;text-align:center}
.p-landing main>.panel h2{margin:16px 0;font-size:32px;line-height:40px;letter-spacing:-0.025em}
html[lang="ko"] .p-landing main>.panel h2{letter-spacing:-0.012em}
.p-landing main>.panel .actions{justify-content:center}
.shell .note{margin:16px 0 0}
.shell .actions,.shell .panel .actions{margin-top:24px}
.shell #m-exp{margin:0 0 24px}
.shell input[type=text],.shell input[type=email]{height:48px;font-size:16px}
.shell .actions>.btn:only-child{width:100%;height:48px;padding:0 20px;font-size:16px;line-height:24px}
.shell footer{width:100%;max-width:1152px;margin:0 auto;padding:24px 0;border-top:1px solid var(--gray-400);font-size:12px;line-height:16px;color:var(--gray-900)}
.panel{padding:var(--card-pad);border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-medium)}
.panel h2{font-size:20px;line-height:28px;letter-spacing:-0.015em;margin-bottom:8px}
html[lang="ko"] .panel h2{letter-spacing:-0.008em}
.panel .actions{margin-top:16px}
.alt{margin-top:24px;font-size:14px;color:var(--gray-900);text-align:center}
.alt a{color:var(--gray-1000);font-weight:500;text-decoration:none}
.alt a:hover{text-decoration:underline}
.check a{font-weight:500}

.skip{position:absolute;left:16px;top:-80px;z-index:var(--z-toast);padding:8px 12px;border-radius:var(--radius-sm);background:var(--gray-700);color:var(--background-100);font-size:14px;line-height:20px;font-weight:500;text-decoration:none}
.skip:focus-visible{top:12px}
#main:focus{outline:none}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.strong{font-weight:600}
.grow{flex:1}

.ico{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.ico *{vector-effect:non-scaling-stroke} /* 1.5px at 14 and 20 too (critique R10-06) */
.more .ico{width:14px;height:14px;margin-left:2px}
.mi .ck{display:inline-flex}
.tbl td[data-k="dir"] .cv{display:inline-flex;align-items:center;gap:4px}
.tbl td[data-k="dir"] .ico{width:14px;height:14px;color:var(--gray-900)}
/* disclosures: the icon set's chevron instead of the UA triangle, turning a quarter on open */
summary{list-style:none;display:flex;align-items:center;gap:8px}
summary::-webkit-details-marker{display:none}
summary::before{content:"";width:5px;height:5px;flex:none;margin:0 2px;border:solid currentColor;border-width:1.5px 1.5px 0 0;transform:rotate(45deg);transition:transform var(--dur-fast) ease}
details[open]>summary::before{transform:rotate(135deg)}

.top{position:sticky;top:0;z-index:var(--z-header);display:flex;align-items:center;gap:8px;height:var(--header-h);padding:0 12px 0 16px;background:var(--background-100);box-shadow:0 1px 0 var(--gray-alpha-400)}
/* one shell surface (console v5): header, sidebar and body are the same --background-100 - no tint, no blur; the edges are 1px lines only. */
.top .sep{color:var(--gray-500);font-size:20px;font-weight:300;line-height:1;margin:0 2px}
/* brand (src/ui/brand.ts): the lockup while the sidebar is open (>=1150), the symbol alone on the rail and on tablets, hidden on phones (the drawer shows it) */
.top-brand{display:inline-flex;align-items:center;justify-content:center;flex:none;height:32px;padding:0 4px;border-radius:var(--radius-sm);color:var(--gray-1000);text-decoration:none}
.top-brand:hover{background:var(--gray-alpha-100);text-decoration:none}
.top-brand .brand,.top-brand .brand-s{display:block;flex:none;height:20px;width:auto}
.top-brand .brand-s,:root[data-side="rail"] .top-brand .brand{display:none}
:root[data-side="rail"] .top-brand .brand-s{display:block}
:root[data-side="rail"] .top-brand{width:32px;padding:0}
.menu-btn{display:none;align-items:center;justify-content:center;width:32px;height:32px;margin-left:-4px;padding:0;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--gray-1000);cursor:pointer;flex:none;transition:background-color var(--dur-fast) ease}
.menu-btn:hover{background:var(--gray-alpha-100)}
.menu-btn .bars{position:relative;display:block;width:16px;height:11px;border-top:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transition:border-color var(--dur-fast) ease}
.menu-btn .bars::before,.menu-btn .bars::after{content:"";position:absolute;left:0;right:0;top:50%;border-top:1.5px solid currentColor;transform:translateY(-50%);transition:transform var(--dur-base) var(--ease-out)}
.nav-open .menu-btn .bars{border-color:transparent}
.nav-open .menu-btn .bars::before{transform:translateY(-50%) rotate(45deg)}
.nav-open .menu-btn .bars::after{transform:translateY(-50%) rotate(-45deg)}

.crumb{display:flex;align-items:center;gap:4px;min-width:0;flex:0 1 auto}
.sw{position:relative;min-width:0;display:flex}
.sw-btn{display:inline-flex;align-items:center;gap:8px;max-width:100%;height:32px;min-width:0;padding:0 8px;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--gray-1000);font-size:14px;line-height:20px;font-weight:500;cursor:pointer;transition:background-color var(--dur-fast) ease}
.sw-btn:hover,.sw-btn[aria-expanded="true"]{background:var(--gray-alpha-100)}
.sw-btn:focus-visible{outline-offset:0}
.sw-btn>.ico{width:14px;height:14px;color:var(--gray-900)}
.crumb-home{display:inline-flex;align-items:center;gap:8px;min-width:0;height:32px;padding:0 6px 0 4px;border-radius:var(--radius-sm);color:var(--gray-1000);font-size:14px;line-height:20px;font-weight:500;text-decoration:none}
.crumb-home:hover{background:var(--gray-alpha-100)}
.sw-caret{width:24px;padding:0;justify-content:center}
.sw-t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;max-width:24ch}
.av{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;border-radius:50%;background:var(--gray-100);box-shadow:var(--shadow-border);color:var(--gray-1000);font-size:12px;line-height:1;font-weight:600;text-transform:uppercase;overflow:hidden}
.av.org{width:20px;height:20px;border-radius:var(--radius-xs);background:var(--gray-700);color:var(--background-100);box-shadow:none}
.av.org.lg{width:32px;height:32px;font-size:14px}
.av::before{content:attr(data-i)}
.av:not([data-i])::before,.av[data-i=""]::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.4}

.mi[aria-checked="true"]{font-weight:500}
.mi[aria-checked="true"]::after{content:"";width:9px;height:5px;margin:0 2px 3px auto;border:solid currentColor;border-width:0 0 1.5px 1.5px;transform:rotate(-45deg)}
.menu{position:absolute;left:0;top:calc(100% + 4px);z-index:var(--z-popover);min-width:220px;max-width:min(360px,calc(100vw - 24px));padding:4px;border-radius:var(--radius-md);background:var(--background-raised);box-shadow:var(--shadow-menu);transform-origin:top left;opacity:1;transform:none;transition:opacity var(--dur-base) var(--ease-out),transform var(--dur-base) var(--ease-out)}
@starting-style{.menu.enter{opacity:0;transform:translateY(-4px)}}
@keyframes pop-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.sw-ag .menu{min-width:300px}
.sw .menu:not([hidden]){display:flex;flex-direction:column;max-height:min(480px,calc(100dvh - var(--header-h) - 16px))}
#swo-list,#swa-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.sw .menu .msearch,.sw .menu .mfoot,.sw .menu .mnone{flex:none}
.mlist{list-style:none;margin:0;padding:0}
.mfoot{margin:4px -4px 0;padding:4px 4px 0;border-top:1px solid var(--gray-400)}
.mi{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:8px;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--gray-1000);font-size:14px;line-height:20px;font-weight:400;text-align:left;text-decoration:none;cursor:pointer;min-width:0;transition:background-color var(--dur-fast) ease}
.mi:hover{background:var(--gray-alpha-100)}
/* a destructive item sits apart, in red text - the item is itself the action (critique R10-17) */
.msep{height:1px;margin:4px -4px;background:var(--gray-400)}
.mi.danger{color:var(--red-700)}
.mi.danger:hover{background:var(--red-alpha)}
.mi:focus-visible{outline:2px solid var(--focus-ring);outline-offset:-2px;background:var(--gray-alpha-100)}
.mi[aria-current="true"]{font-weight:500}
.mi .ck{margin-left:auto;padding-left:8px}
.mi>.ico{color:var(--gray-900)}
.mi .idthumb.dot{margin:0}
.mi .mt{display:flex;flex-direction:column;min-width:0}
.mi .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mi .addr{font-size:12px;line-height:16px;color:var(--gray-900);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ameta #a-addr{flex:0 1 auto;min-width:0;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vh .hsub{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mi .rolechip,.mi .rolechip.r-owner,.mi .rolechip.r-member{margin-left:auto;padding:0;background:transparent;box-shadow:none;color:var(--gray-900);font-weight:400}
.mi .msub{font-size:12px;line-height:16px;color:var(--gray-900);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mi .rolechip+.ck{margin-left:0;padding-left:8px}
.msearch{padding:4px 4px 8px}
.msearch input{height:32px}
.mnone{padding:8px}
.mwrap{position:relative}
.mwrap .menu,.rowmenu{left:auto;right:0;transform-origin:top right}
.rowmenu{min-width:180px;text-align:left}

.frame{display:grid;grid-template-columns:var(--side-w) minmax(0,1fr);min-height:calc(100vh - var(--header-h));transition:grid-template-columns var(--dur-base) var(--ease-in-out)}
:root[data-side="rail"] .frame{grid-template-columns:var(--side-rail) minmax(0,1fr)}
.side{container:side/inline-size;position:sticky;top:var(--header-h);z-index:var(--z-sticky);align-self:start;display:flex;flex-direction:column;min-width:0;height:calc(100vh - var(--header-h));height:calc(100dvh - var(--header-h));background:var(--background-100);box-shadow:inset -1px 0 0 var(--gray-alpha-400)}
.side-top{display:none}
.side-body{flex:1;min-height:0;overflow-x:hidden;overflow-y:auto;padding:20px 8px 12px}
.scope{display:flex;flex-direction:column;animation:scope-in var(--dur-base) var(--ease-out)}
@keyframes scope-in{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:none}}
.nav{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0}
.nav+.nav{margin-top:8px;padding-top:8px;box-shadow:inset 0 1px 0 var(--gray-400)}
.nav a,.nav-back{position:relative;display:flex;align-items:center;gap:8px;height:32px;padding:0 8px;border-radius:var(--radius-sm);color:var(--gray-900);font-size:14px;line-height:20px;font-weight:400;text-decoration:none}
.nav a:hover,.nav-back:hover{background:var(--gray-alpha-100);color:var(--gray-1000)}
.nav a[aria-current="page"],.nav a[aria-current="location"]{background:var(--gray-alpha-200);color:var(--gray-1000);font-weight:500}
.nav a>span,.nav-back>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-back{margin-bottom:8px}
.scope-h{display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:center;gap:8px;margin:0 0 12px;padding:8px;border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-border)}
.scope-t{display:flex;flex-direction:column;min-width:0}
.scope-t .nm{font-weight:500;font-size:14px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scope-a .addr{display:block;font-size:12px;line-height:16px;color:var(--gray-900);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dot{width:6px;height:6px;border-radius:50%;background:var(--gray-1000);flex:none}
.dot.off{background:transparent;box-shadow:inset 0 0 0 1.5px var(--gray-600)}
.dot.wait{background:linear-gradient(90deg,var(--gray-1000) 50%,transparent 50%);box-shadow:inset 0 0 0 1px var(--gray-1000)}
.dot.bad{width:8px;height:8px;border-radius:0;background:linear-gradient(45deg,transparent 40%,var(--gray-1000) 40% 60%,transparent 60%),linear-gradient(-45deg,transparent 40%,var(--gray-1000) 40% 60%,transparent 60%)}

.side-foot{display:flex;align-items:center;gap:4px;padding:8px;box-shadow:inset 0 1px 0 var(--gray-alpha-400)}
/* usage over the plan's limit (F27): the numbers stay plain (n / N), one status pill "x over limit" sits beside them */
.stats>div>.pill{grid-column:1 / -1;justify-self:start}
#side-toggle{position:relative;flex:none;margin-left:auto}
#side-toggle>.tt{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
/* account block (2026-09-30, bottom left like Vercel, Linear, Supabase): avatar, address, role; the menu opens upward. The block reads
   like a sidebar item (same height rhythm, same hover wash); the rail keeps the avatar only and the menu opens to the right. */
.acct{position:relative;flex:1;min-width:0}
.acct-b{display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:40px;padding:0 8px 0 6px;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--gray-1000);text-align:left;cursor:pointer;transition:background-color var(--dur-fast) ease}
.acct-b:hover,.acct-b[aria-expanded="true"]{background:var(--gray-alpha-100)}
.acct-b:focus-visible{outline-offset:0}
.acct-b .av{font-size:11px}
.acct-t{display:flex;flex-direction:column;flex:1;min-width:0}
.acct-e,.acct-r{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acct-e{font-size:13px;line-height:18px;font-weight:500}
.acct-r{font-size:12px;line-height:16px;color:var(--gray-900)}
.acct-r:empty{display:none}
.acct-b>.ico{width:14px;height:14px;color:var(--gray-900)}
.acct .menu{top:auto;bottom:calc(100% + 8px);left:0;width:max(100%,240px);transform-origin:bottom left}
@starting-style{.acct .menu.enter{opacity:0;transform:translateY(4px)}}
.acct .pop-h{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 8px 10px;margin:0 0 4px;border-bottom:1px solid var(--gray-400)}
.acct .pop-h .addr{max-width:100%;color:var(--gray-1000);font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acct .pop-r{font-size:12px;line-height:16px;color:var(--gray-900)}
.acct .pop-r:empty{display:none}
/* a label + a compact segment in one menu row (theme, language): menuitemradio, checked = the raised chip, never a colour */
.mrow{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:36px;padding:2px 2px 2px 8px;color:var(--gray-1000);font-size:14px;line-height:20px}
.aseg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--radius-sm);background:var(--gray-100)}
.aseg-i{display:inline-flex;align-items:center;justify-content:center;height:24px;min-width:28px;padding:0 8px;border:0;border-radius:var(--radius-xs);background:transparent;color:var(--gray-900);font-size:12px;line-height:16px;font-weight:500;text-decoration:none;white-space:nowrap;cursor:pointer;transition:background-color var(--dur-fast) ease,color var(--dur-fast) ease,box-shadow var(--dur-fast) ease}
button.aseg-i{padding:0}
.aseg-i .ico{width:14px;height:14px}
.aseg-i:hover{color:var(--gray-1000)}
.aseg-i[aria-checked="true"]{background:var(--background-raised);color:var(--gray-1000);box-shadow:inset 0 0 0 1px var(--gray-600)}
.aseg-i:focus-visible{outline:2px solid var(--focus-ring);outline-offset:0}
.scrim{position:fixed;inset:0;z-index:calc(var(--z-sidebar) - 1);background:var(--scrim);animation:fade-in var(--dur-base) var(--ease-out)}
@keyframes fade-in{from{opacity:0}to{opacity:1}}

@container side (max-width:120px){
  .side-body{overflow:visible}
  .nav a,.nav-back{justify-content:center;padding:0}
  .nav a>span,.nav-back>span{position:absolute;left:calc(100% + 16px);top:50%;z-index:var(--z-popover);padding:4px 8px;border-radius:var(--radius-xs);background:var(--background-raised);box-shadow:var(--shadow-menu);color:var(--gray-1000);font-size:13px;line-height:18px;font-weight:400;overflow:visible;opacity:0;pointer-events:none;transform:translate(-4px,-50%);transition:opacity var(--dur-fast) ease,transform var(--dur-fast) ease}
  .nav a:hover>span,.nav a:focus-visible>span,.nav-back:hover>span,.nav-back:focus-visible>span{opacity:1;transform:translate(0,-50%)}
  @supports (anchor-name:--a) and (anchor-scope:--a){
    .side-body{overflow-x:hidden;overflow-y:auto}
    .nav a,.nav-back{anchor-name:--rail-i;anchor-scope:--rail-i}
    .nav a>span,.nav-back>span{position:fixed;position-anchor:--rail-i;left:calc(anchor(right) + 16px);top:anchor(center)}
  }
  .scope-h{grid-template-columns:1fr;justify-items:center;padding:4px 0;background:transparent;box-shadow:none}
  .scope-h .scope-t,.scope-h .dot{display:none}
  .scope-h .idthumb{--sz:32px}
  .side-foot{flex-direction:column;justify-content:center}
  #side-toggle{margin:0}
  .acct{flex:none}
  .acct-b{justify-content:center;width:32px;height:32px;padding:0;border-radius:50%}
  .acct-b:hover,.acct-b[aria-expanded="true"]{background:transparent}
  .acct-b:hover .av,.acct-b[aria-expanded="true"] .av{box-shadow:0 0 0 2px var(--gray-alpha-400)}
  .acct-t{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
  .acct-b>.ico{display:none}
  .acct .menu{left:calc(100% + 16px);bottom:0;width:240px;transform-origin:bottom left}
  @starting-style{.acct .menu.enter{opacity:0;transform:translateX(-4px)}}
  #side-toggle>.tt{position:absolute;left:calc(100% + 16px);top:50%;z-index:var(--z-popover);width:auto;height:auto;flex:none;clip-path:none;padding:4px 8px;border-radius:var(--radius-xs);background:var(--background-raised);box-shadow:var(--shadow-menu);color:var(--gray-1000);font-size:13px;line-height:18px;font-weight:400;overflow:visible;white-space:nowrap;opacity:0;pointer-events:none;transform:translate(-4px,-50%);transition:opacity var(--dur-fast) ease,transform var(--dur-fast) ease}
  #side-toggle:hover>.tt,#side-toggle:focus-visible>.tt{opacity:1;transform:translate(0,-50%)}
}

.main{container:main/inline-size;grid-column:2;min-width:0;width:100%;padding:32px 40px 96px}
.view{display:block}
.main>.warnbox,.main>.banner,.main>.robar{margin:0 0 16px}
/* one width rule (console v5): every screen's content spans the body - only the side padding is responsive (.main). No screen caps its
   column (settings, connect and the org picker used to stop at 880px while the overview, lists and logs filled the width). A text field alone
   keeps a readable width. */
.main .field>input:not([type=checkbox]):not([type=radio]),.main .field>select,.main .field>textarea,.main .suffix{max-width:560px}
.vh,.ah{display:flex;align-items:center;justify-content:space-between;gap:12px 16px;flex-wrap:wrap;min-height:32px;margin:0 0 24px}
/* page head (s3.2): title row [h1 usage tip] + at most one quiet line under it; the primary action on the right */
.vh-t{flex:1 1 auto;min-width:0}
.vh-sub{margin:4px 0 0;font-size:14px;line-height:20px;color:var(--gray-900);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vh .hrow{flex:1 1 auto;flex-wrap:nowrap}
.vh .hrow>h1{flex:none}
.vh h1,.ah h1{font-size:24px;line-height:32px;font-weight:600;letter-spacing:-0.02em}
html[lang="ko"] .vh h1,html[lang="ko"] .ah h1{letter-spacing:-0.01em}
.vh h1:focus,.ah h1:focus{outline:none}
.vh-act{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vh-act .btn{height:32px;padding:0 12px}
.hcount{font-size:14px;line-height:20px;color:var(--gray-900);font-variant-numeric:tabular-nums}

.hrow{position:relative;display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.hrow.in{display:inline-flex;flex-wrap:nowrap}
.tip-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--gray-900);cursor:pointer;flex:none;line-height:0;transition:color var(--dur-fast) ease}
.tip-btn::after{content:"";position:absolute;inset:-6px}
.tip-btn:hover,.tip-btn[aria-expanded="true"]{color:var(--gray-1000)}
.tip-btn[aria-expanded="true"] .ico circle{fill:var(--gray-1000)}
.tip-btn[aria-expanded="true"] .ico path{stroke:var(--background-100)}
.tip-pop{position:absolute;top:calc(100% + 8px);left:0;z-index:var(--z-popover);width:max-content;max-width:min(340px,calc(100vw - 32px));padding:12px 14px;border-radius:var(--radius-md);background:var(--background-raised);box-shadow:var(--shadow-menu);color:var(--gray-1000);font-size:13px;font-weight:400;line-height:20px;letter-spacing:0;text-transform:none;text-align:left;white-space:normal;overflow-wrap:anywhere;opacity:1;transform:none;transition:opacity var(--dur-base) var(--ease-out),transform var(--dur-base) var(--ease-out)}
@starting-style{.tip-pop.enter{opacity:0;transform:translateY(-4px)}}
.tip-pop.tip-up{top:auto;bottom:calc(100% + 8px)}
@starting-style{.tip-pop.tip-up.enter{opacity:0;transform:translateY(4px)}}
.tip-pop>*+*{margin-top:8px}
.tip-pop ul{margin:0;padding-left:16px}
.tip-pop li+li{margin-top:4px}
.tip-pop dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;margin:0}
.tip-pop dl+p{margin-top:8px}
.tip-pop dt{font-weight:500;white-space:nowrap}
.tip-pop dd{margin:0}
.tip-pop code{font-size:12px;padding:0 4px;border-radius:4px;background:var(--gray-100)}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--gray-900);cursor:pointer;flex:none;transition:background-color var(--dur-fast) ease,color var(--dur-fast) ease}
.icon-btn:hover{background:var(--gray-alpha-100);color:var(--gray-1000)}
.icon-btn:active{background:var(--gray-alpha-200)}
.icon-btn[aria-expanded="true"]{background:var(--gray-alpha-200);color:var(--gray-1000)}
.cpd{font-size:12px;line-height:16px;color:var(--gray-900);white-space:nowrap}
.cpd:empty{display:none}

.sh,.bh{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;min-height:32px;margin:0 0 12px}
.sh h2,.bh h2{font-size:17px;line-height:24px;font-weight:600;letter-spacing:-0.01em}
html[lang="ko"] .sh h2,html[lang="ko"] .bh h2{letter-spacing:0}
.sdesc{font-size:14px;line-height:22px;color:var(--gray-900);margin:0 0 16px}
.sh:has(+.sdesc),.bh:has(+.sdesc){min-height:0;margin-bottom:4px}
.sec{margin-top:24px;padding-top:24px;border-top:1px solid var(--gray-400)}
.block{margin:0 0 32px}
#ov-stats-msg:not(:empty),#ao-stats-msg:not(:empty){margin:-20px 0 32px}
.more{font-size:13px;line-height:18px;color:var(--gray-900);text-decoration:none;white-space:nowrap}
a.more{display:inline-flex;align-items:center}
.day .cnt.ok::before{margin:0 0 3px}
.alt a .ico{width:14px;height:14px;margin-left:2px;vertical-align:-2px}
.more:hover{color:var(--gray-1000)}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin:0 0 32px;border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-small);overflow:hidden}
.stats>div{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:baseline;gap:4px 8px;min-width:0;padding:16px var(--card-pad);box-shadow:1px 0 0 var(--gray-400),0 1px 0 var(--gray-400)}
.stats .lbl{grid-column:1/-1;margin:0;font-size:13px;line-height:18px;font-weight:400;color:var(--gray-900)}
.stats .big{font-size:24px;line-height:32px;font-weight:600;letter-spacing:-0.02em;font-variant-numeric:tabular-nums}
.stats .sub{font-size:14px;line-height:20px}
.steps{list-style:none;margin:0;padding:0 var(--card-pad);border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-medium)}
.steps li{display:grid;grid-template-columns:16px minmax(0,1fr) auto;gap:12px;align-items:center;min-height:48px;padding:8px 0;box-shadow:inset 0 -1px 0 var(--gray-400)}
.steps li:last-child{box-shadow:none}
.steps strong{font-weight:500}
.steps .stn{display:inline-flex;justify-content:center}
.steps .stn::before{content:"";width:8px;height:8px;border-radius:50%;box-shadow:inset 0 0 0 1.5px var(--gray-600)}
.steps li.done .stn::before{background:var(--gray-1000);box-shadow:none}
.steps li.done strong{color:var(--gray-900);font-weight:400}

.pl{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px 24px;margin:0}
.pl dt{font-size:13px;line-height:18px;color:var(--gray-900)}
.pl dd{margin:4px 0 0;font-size:14px;line-height:20px;font-weight:500;min-width:0;overflow-wrap:anywhere}
.pl.facts{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
.cols{display:flex;flex-direction:column;gap:24px}

.lists{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}
.lst{min-width:0}
.lh{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.lh h3{margin:0;font-size:14px;line-height:20px;font-weight:600}
.lcount{font-size:14px;line-height:20px;font-weight:500;color:var(--gray-900)}
.lh-r{display:flex;align-items:center;gap:8px;flex:none}
/* list "Add" buttons (2026-09-29: a button that opens a dialog, never an inline input): a quiet fill + a plus. */
.addbtn .ico{width:14px;height:14px}
.btn.sm.addbtn{padding:0 10px 0 8px;gap:4px}
.rules{list-style:none;margin:8px 0 0;padding:0}
.rules li{position:relative;display:flex;align-items:center;gap:12px;min-height:40px;padding:4px 0;box-shadow:inset 0 -1px 0 var(--gray-400);font-size:13px;min-width:0}
.rules li>.more-btn{margin-left:auto}
/* row actions (F09): a single action is a quiet text button (ink on hover); two or more live in the "..." menu */
.tbl td.act .btn.link,.rules li>.btn.link{color:var(--gray-900)}
.tbl td.act .btn.link:hover,.rules li>.btn.link:hover{color:var(--gray-1000)}
.rules li:last-child{box-shadow:none}
/* addresses (mail basics 2 - aliases): a flat card under the two email columns; rows like the rule lists */
.alsec{padding:var(--card-pad);border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-border)}
#al-primary{margin:0}
.alsub{margin-top:16px;padding-top:16px;box-shadow:inset 0 1px 0 var(--gray-400)}
.al-act{display:flex;align-items:center;gap:8px}
#al-over{margin:12px 0 0}
#al-list{margin-top:4px}
#al-list .btn,#al-primary .pill{flex:none}
dialog .kv.aq{margin:16px 0 8px;grid-template-columns:auto minmax(0,1fr)}
dialog .kv.aq dd{font-variant-numeric:tabular-nums}
/* primary address states (ADR-0014 2026-10, M4): no active address = a hatched box with two ways back; a dormant @atmark.ai = one quiet line */
.noaddr{display:flex;align-items:center;justify-content:space-between;gap:12px 24px;flex-wrap:wrap;margin:0}
.noaddr .na-t{flex:1 1 320px;min-width:0}
.noaddr .na-t>strong{display:block;font-weight:500}
.noaddr .na-t>p{margin:4px 0 0;max-width:68ch}
.noaddr .actions{margin:0;flex:0 1 auto;max-width:100%}
.al-anchor{display:flex;align-items:center;gap:4px;margin:8px 0 0}
.al-anchor .btn{height:28px;padding:0 8px}
.addr.none{font-family:var(--font-sans);font-size:13px;color:var(--gray-900)}
/* custom domains (ADR-0014 stage 4, M4) - a sidebar item since 2026-10-05: list, locked (beta) state, one domain = head + facts + alert +
   a DNS records table laid out like a DNS provider's (type, name, content, priority, TTL, proxy, status). Record values must stay whole
   (they are copied into a DNS provider): they wrap, never ellipsis. On a narrow screen the table scrolls inside its own box - never the page. */
.dmt tr.gone .strong{color:var(--gray-900)}
.dm-off{margin:0 0 12px}
.dlock{display:grid;justify-items:start;gap:8px;max-width:640px;padding:24px var(--card-pad);border-radius:var(--radius-md);border:1px dashed var(--gray-500);color:var(--gray-900);font-size:14px;line-height:20px}
.dlock>p{margin:0;max-width:60ch}
.dlock .dlock-t{margin:4px 0 0;color:var(--gray-1000);font-size:16px;line-height:24px;font-weight:600}
.aiw{display:inline-flex;align-items:center;gap:6px;height:20px;margin-left:8px;padding:0 7px;border-radius:var(--radius-xs);color:var(--gray-1000);font-size:12px;line-height:16px;font-weight:500;white-space:nowrap;vertical-align:middle;letter-spacing:.01em}
.aiw-f{box-shadow:inset 0 0 0 1px var(--gray-1000);font-weight:600}
.aiw-m{display:inline-flex;align-items:flex-end;gap:2px;height:10px}
.aiw-m i{display:block;width:3px;border-radius:1px;background:var(--gray-400)}
.aiw-m i:nth-child(1){height:4px}.aiw-m i:nth-child(2){height:7px}.aiw-m i:nth-child(3){height:10px}
.aiw-m i.on{background:currentColor}
.aiw-p{box-shadow:inset 0 0 0 1px var(--gray-500);color:var(--gray-900)}
.aiw-p::before{content:"";width:6px;height:6px;flex:none;border-radius:50%;box-shadow:inset 0 0 0 1px currentColor;background:linear-gradient(90deg,currentColor 50%,transparent 50%);animation:pulse 1.2s ease-in-out infinite alternate}
.aiw-s{padding:0 6px;border:1px dashed var(--gray-600);color:var(--gray-900)}
.aiw-c{padding:0;color:var(--gray-800);font-weight:400}
.kv .aiw{margin-left:0}
.dback{display:inline-flex;align-items:center;gap:6px;margin:0 0 12px;font-size:13px;line-height:20px;color:var(--gray-900);text-decoration:none}
.dback:hover{color:var(--gray-1000)}
.dback .ico{width:14px;height:14px}
.dvh{margin-bottom:16px}
.dnh{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;min-width:0}
.dname{min-width:0;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-0.025em;overflow-wrap:anywhere}
.dname:focus{outline:none}
.dfacts{margin:0 0 24px}
.dalert>p{margin:0;max-width:72ch}
.dalert>.dalert-a{margin-top:4px;color:var(--gray-900)}
.dalert.neutral{background:var(--gray-100);box-shadow:none}
.drh{display:flex;align-items:flex-start;justify-content:space-between;gap:12px 24px;flex-wrap:wrap;margin:0 0 16px}
.drh-t{flex:1 1 360px;min-width:0}
.drh-t h2{font-size:16px;line-height:24px;font-weight:600}
.drh-t p{margin:4px 0 0;max-width:72ch}
.drh-a{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end}
/* all records at once (2026-10-05): zone file download + copy all, one Cloudflare import line, a DKIM "download again" line before tokens exist */
.dzx{display:grid;gap:8px;margin:0 0 12px;padding:12px;border-radius:var(--radius-sm);box-shadow:inset 0 0 0 1px var(--gray-alpha-400)}
.dzx-a{display:flex;flex-wrap:wrap;gap:8px}
.dzx-a .btn{gap:6px;padding:0 10px 0 8px}
.dzx-a .btn .ico{width:14px;height:14px}
.dzx p{margin:0;max-width:80ch}
.dzx-h{flex-wrap:nowrap;align-items:flex-start;gap:6px}
.dzx-h>span{min-width:0;max-width:80ch}
.dnsw{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;border-radius:var(--radius-sm);box-shadow:inset 0 0 0 1px var(--gray-400)}
.dnsw:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.dnst{width:100%;min-width:820px;border-collapse:separate;border-spacing:0;font-size:13px;line-height:20px}
.dnst th,.dnst td{padding:10px 12px;text-align:left;vertical-align:top;box-shadow:inset 0 -1px 0 var(--gray-alpha-400)}
.dnst thead th{height:36px;padding-top:0;padding-bottom:0;vertical-align:middle;background:var(--background-200);color:var(--gray-900);font-size:12px;line-height:16px;font-weight:600;white-space:nowrap}
.dnst tbody tr:last-child td{box-shadow:none}
.dnst tr.dgrp th{padding:16px 12px 6px;background:transparent;color:var(--gray-900);font-size:12px;line-height:16px;font-weight:600;box-shadow:none}
.dnst tr.dgrp:first-child th{padding-top:12px}
.dnst tr.drr:hover td{background:var(--gray-alpha-100)}
.dnst .dk-type{width:72px}
.dnst .dk-type .cap{margin-top:4px;font-weight:500;letter-spacing:.02em}
.dnst .dk-name{width:28%}
.dnst .dk-prio,.dnst .dk-ttl{width:72px;padding-top:14px;white-space:nowrap;font-variant-numeric:tabular-nums}
.dnst .dk-ttl{color:var(--gray-900)}
.dnst .dk-proxy,.dnst .dk-st{width:1%;white-space:nowrap}
.dvw{display:flex;align-items:flex-start;gap:4px;min-width:0}
.dv{flex:1;min-width:0;padding:4px 0;font-size:13px;line-height:20px;word-break:normal;overflow-wrap:anywhere;user-select:all}
.dv.rel{font-weight:600}
.dcp{flex:none;width:28px;height:28px}
.dfq{display:block;padding-right:32px;font-family:var(--font-mono);font-size:12px;line-height:16px;color:var(--gray-900);word-break:normal;overflow-wrap:anywhere}
.dpx{display:inline-block;padding-top:4px;color:var(--gray-900)}
.dnst .dk-proxy .pill,.dnst .dk-st .pill{margin-top:4px}
.dnst .dk-st .rsfail{color:var(--red-700);box-shadow:inset 0 0 0 1.5px var(--red-700)} /* a DNS record that failed its check: an error the owner fixes (2026-10-05) - the same x pill, in red */
.dnst tr.dprep td{color:var(--gray-900);vertical-align:middle}
.dprep-t{display:inline-flex;align-items:center;gap:8px;min-height:28px}
.dprep-t::before{content:"";width:6px;height:6px;flex:none;border-radius:50%;background:currentColor;animation:pulse 1.2s ease-in-out infinite alternate}
.dprep-t.over::before{animation:none;background:transparent;box-shadow:inset 0 0 0 1.5px currentColor}
.dprep-b{margin-left:12px;vertical-align:middle}
.dnotes{display:grid;gap:6px;margin:16px 0 0;padding:0 0 0 18px;color:var(--gray-900);font-size:13px;line-height:20px}
.dnotes li{max-width:80ch}
.dnotes li.hrow{display:list-item}
.dnotes li.hrow>span{margin-right:4px}
.dnotes strong{color:var(--gray-1000);font-weight:600}
.dr-name{margin:0 0 12px;font-size:14px;font-weight:500}
dialog .warnbox{margin:16px 0}
/* confirm: "what goes / what stays" in two short columns (F46) */
.dsplit{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;margin:12px 0;padding:12px 16px;border-radius:var(--radius-md);background:var(--gray-100)}
.dsplit .lbl{margin:0 0 4px}
.dsplit ul{margin:0;padding:0 0 0 18px;font-size:13px;line-height:20px}
dialog .warnbox>p{margin:4px 0 0}
.rules li .addr{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cap,.rules .kind{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:var(--radius-xs);background:var(--gray-100);color:var(--gray-1000);font-size:12px;line-height:16px;font-weight:400;white-space:nowrap}
.rules .when{font-size:12px;color:var(--gray-900);white-space:nowrap;font-variant-numeric:tabular-nums}
.rules .btn{height:28px;padding:0 8px;margin-left:auto;margin-right:-8px}
.tbl td .btn.link:last-child{margin-right:-8px}
#v-overview .block .empty,#t-overview .block .empty,.lst .empty,.alsub .empty,.dirp .sec .empty{display:block;padding:8px 0 0;margin:0;box-shadow:none;background:none;border-radius:0;text-align:left;font-size:13px;line-height:20px}
#v-overview .block .empty>p:first-of-type,#t-overview .block .empty>p:first-of-type,.lst .empty>p:first-of-type,.alsub .empty>p:first-of-type{font-weight:400;color:var(--gray-900)}
.pl.lim{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}
.lim-edit{display:flex;align-items:center;gap:8px}
.lim-edit .btn.link{height:24px;padding:0 4px;font-size:13px}

.seg{display:inline-flex;align-items:center;gap:2px;padding:4px;border-radius:var(--radius-sm);background:var(--gray-100);flex:none}
.seg a,.seg button{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:24px;padding:0 12px;border:0;border-radius:var(--radius-xs);background:transparent;color:var(--gray-900);font-size:14px;line-height:20px;font-weight:500;text-decoration:none;white-space:nowrap;cursor:pointer;transition:background-color var(--dur-fast) ease,color var(--dur-fast) ease,box-shadow var(--dur-fast) ease}
.seg a:hover,.seg button:hover{color:var(--gray-1000)}
.seg a[aria-current="page"],.seg a[aria-current="true"],.seg button[aria-checked="true"]{background:var(--background-raised);color:var(--gray-1000);box-shadow:inset 0 0 0 1px var(--gray-600)}
.seg.tabs{display:flex;gap:0;padding:0;margin-left:-12px;border-radius:0;background:transparent;overflow-x:auto;scrollbar-width:none}
.seg.tabs a{position:relative;height:40px;padding:0 12px;border-radius:0;background:transparent;box-shadow:none}
.seg.tabs a::before{content:"";position:absolute;inset:6px 2px;z-index:-1;border-radius:var(--radius-xs);background:transparent;transition:background-color var(--dur-fast) ease}
.seg.tabs a:hover::before{background:var(--gray-alpha-100)}
.seg.tabs a::after{content:"";position:absolute;left:12px;right:12px;bottom:0;height:2px;background:var(--gray-1000);transform:scaleX(0);transition:transform var(--dur-base) var(--ease-out)}
.seg.tabs a[aria-current="page"]{background:transparent;box-shadow:none;color:var(--gray-1000)}
.seg.tabs a[aria-current="page"]::after{transform:scaleX(1)}
.lgtabs{position:relative;z-index:0;display:flex;align-items:center;gap:8px;margin:0 0 16px;box-shadow:inset 0 -1px 0 var(--gray-400)}
.msgbox{border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-medium);overflow:hidden}
.msgbox .bar{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;padding:8px 12px 8px var(--card-pad);background:var(--background-200);border-bottom:1px solid var(--gray-400)}
.msgbox .bar .lbl{margin:0;font-size:13px;font-weight:400;color:var(--gray-900)}
.msgbox pre{margin:0;padding:16px var(--card-pad);max-height:480px;overflow:auto;font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}
.cinfo{padding:16px var(--card-pad);border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-medium)}
.cinfo .sh{margin-bottom:12px}
.cinfo .kv{margin:0;grid-template-columns:auto minmax(0,1fr)}
.cinfo .kv dd{overflow-wrap:anywhere;font-weight:400}
.lblrow{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px}
.lblrow .lbl{margin:0}

.logbar{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;margin:0 0 16px}
.logbar .filter{display:flex;align-items:center;gap:8px}
.logbar .filter .lbl{margin:0;font-size:13px;font-weight:400;color:var(--gray-900);white-space:nowrap}
.logbar .filter select,.logbar .filter input{height:32px;width:auto;max-width:220px;font-size:13px}
.logbar #lg-refresh{margin-left:auto}
.lgmore{justify-content:center;margin-top:16px}

.ib{margin-top:32px}
.chain{list-style:none;margin:12px 0 0;padding:0 0 0 24px;box-shadow:inset 1px 0 0 var(--gray-400)}
.blk{position:relative;margin:0 0 16px;padding:16px var(--card-pad);border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-small)}
.blk:last-child{margin-bottom:0}
.blk::before{content:"";position:absolute;left:-28px;top:24px;width:8px;height:8px;border-radius:50%;background:var(--gray-1000);box-shadow:0 0 0 3px var(--background-100)}
.blk.blk-miss{background:var(--hatch-wide)}
.blk.blk-miss::before{background:var(--background-100);box-shadow:inset 0 0 0 1.5px var(--gray-600),0 0 0 3px var(--background-100)}
.blk-h{display:flex;align-items:center;gap:4px 12px;flex-wrap:wrap;min-height:24px}
.blk-k{font-size:14px;font-weight:600}
.blk-seq,.blk-t{font-size:13px}
.blk-seq{font-variant-numeric:tabular-nums}
.blk-proof{margin-left:auto}
.blk-c{display:grid;grid-template-columns:120px minmax(0,1fr);gap:4px 16px;margin:8px 0 0;font-size:13px;line-height:20px}
.blk-c dt{color:var(--gray-900)}
html[lang="ko"] .blk-c{grid-template-columns:96px minmax(0,1fr)}
.blk-c dd{margin:0;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;overflow-wrap:anywhere}
.blk-d{margin-top:8px}
.blk-d>summary{cursor:pointer;width:max-content;font-size:12px;line-height:16px;color:var(--gray-900)}
.blk-d>summary:hover{color:var(--gray-1000)}
.blk-d[open]{padding-top:8px;border-top:1px solid var(--gray-400)}
.blk-d[open]>summary{margin-bottom:8px}
.blk-d .blk-proof{margin:0 0 8px -8px}
.blk-hash{font-size:12px;overflow-wrap:anywhere}
.tech{padding:16px var(--card-pad);border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-medium)}
.idinfo .tech{border-radius:0}
.tech summary{cursor:pointer;font-size:14px;font-weight:500}
.tech .kv{margin:12px 0 4px;grid-template-columns:auto minmax(0,1fr)}
.tech .kv dd{overflow-wrap:anywhere;font-weight:400}

.stateline{display:flex;gap:12px;align-items:baseline;font-size:14px;line-height:20px;font-weight:500;margin:0}
.stateline .lbl{margin:0;font-weight:400;color:var(--gray-900)}
/* banners, two kinds only (2026-10-15 UI audit F22): info = this gray band, full width; warning or blocked = .warnbox (hatch + ink ring). */
.banner{padding:12px var(--card-pad);border-radius:var(--radius-md);background:var(--gray-100);box-shadow:none;font-size:14px;line-height:20px;font-weight:500}
#a-gone{margin:0 0 16px}
.banner.bar{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap}
.robar{padding:12px var(--card-pad);border-radius:var(--radius-md);background:var(--gray-100);font-size:14px;line-height:20px}
.robar .hrow strong{margin:0;font-weight:500}

/* settings (2026-09-27, one screen per section, Vercel settings): the settings menu on the left, the chosen section alone on the right.
   Every section is the same shape: a header (H2 + tip + at most one line) and full-width flat cards. Narrow content: the menu becomes a tab row. */
.sset{display:grid;grid-template-columns:200px minmax(0,1fr);gap:40px;align-items:start}
.snav{position:sticky;top:calc(var(--header-h) + 32px);display:flex;flex-direction:column;gap:20px;min-width:0}
.snav-g{margin:0 0 4px;padding:0 8px;font-size:12px;line-height:16px;font-weight:500;color:var(--gray-900)}
.snav ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.snav a{position:relative;display:flex;align-items:center;height:32px;padding:0 8px;border-radius:var(--radius-sm);color:var(--gray-900);font-size:14px;line-height:20px;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background-color var(--dur-fast) ease,color var(--dur-fast) ease}
.snav a:hover{background:var(--gray-alpha-100);color:var(--gray-1000)}
.snav a[aria-current="page"]{background:var(--gray-alpha-200);color:var(--gray-1000);font-weight:500}
.spanes{min-width:0;container:main/inline-size} /* the section pane is the "main" container for what is inside it: tables collapse by the width they really get beside the settings menu */
.spane{min-width:0}
.sph{margin:0 0 16px}
.sph h2{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-0.015em}
html[lang="ko"] .sph h2{letter-spacing:-0.008em}
.sph h2:focus{outline:none}
.sph .sdesc{margin:4px 0 0}
.srow{margin:0 0 16px;border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-medium)}
.srow>.sc{min-width:0;padding:var(--card-pad)}
.srow .sc .actions{margin-top:0}
.srow>.sf{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:12px var(--card-pad);border-top:1px solid var(--gray-400);border-radius:0 0 var(--radius-md) var(--radius-md);background:transparent;color:var(--gray-900);font-size:13px}
.srow>.sf:first-child{border-top:0;border-radius:var(--radius-md)}
.srow>.sf .actions{position:relative;margin:0}
.srow>.sf .btn,.savebar .btn{height:32px;padding:0 12px}
.srow>.sf .mb-leave{margin-right:auto}
.srow>.sf .field{display:flex;align-items:center;gap:8px;margin:0}
.srow>.sf .field>span{margin:0;font-size:13px;font-weight:400;color:var(--gray-900);white-space:nowrap}
.srow>.sf select{height:32px;width:auto;min-width:140px}
.srow>.sf:not(:has(button:not([hidden]))){display:none}
/* one-action cards (emergency stop, sessions): the state on the left, the action on the right - one row, no footer rule */
#s-session>.srow{display:flex;align-items:center;flex-wrap:wrap}
#s-session>.srow>.sc{flex:1 1 280px}
#s-session>.srow>.sf{flex:none;margin-left:auto;padding:0 var(--card-pad) 0 0;border-top:0}
/* emergency stop = the danger-zone card itself (F07 - the agent overview's structure), not a card inside a card */
#s-pause>.srow{background:none;box-shadow:none}
#s-pause .dz{margin-top:0}
#s-pause .dz .actions{margin:0;flex:none}
@container main (max-width:639px){
  #s-session>.srow>.sf{flex:1 1 100%;justify-content:flex-start;padding:0 var(--card-pad) var(--card-pad)}
  #s-session>.srow>.sc{padding-bottom:16px}
}
/* cards that end on a full-bleed table close just under its last row */
#s-members>.srow>.sc,#s-keys>.srow>.sc:has(>.tbl:not([hidden])){padding-bottom:8px}
/* the transparency log card opens on its fact row: the row's top rule would double the card edge */
#s-tlog .srow>.sc{padding-top:0}
#s-tlog .it-facts{box-shadow:inset 0 -1px 0 var(--gray-400)}
/* narrow content (tablet rail, phone): the settings menu is a scrolling tab row under the title - same tab look as the logs tabs */
@container main (max-width:899px){
  .sset{grid-template-columns:minmax(0,1fr);gap:24px}
  .snav{position:sticky;top:var(--header-h);z-index:var(--z-sticky);flex-direction:row;gap:0;margin:-8px 0 0;overflow-x:auto;scrollbar-width:none;background:var(--background-100);box-shadow:inset 0 -1px 0 var(--gray-400)}
  .snav::-webkit-scrollbar{display:none}
  .snav{padding-right:32px;-webkit-mask-image:linear-gradient(90deg,var(--gray-1000) calc(100% - 40px),transparent);mask-image:linear-gradient(90deg,var(--gray-1000) calc(100% - 40px),transparent)} /* F66: the row scrolls */
  .snav-sec{display:flex;flex:none}
  .snav-sec+.snav-sec::before{content:"";align-self:center;width:1px;height:16px;margin:0 4px;background:var(--gray-400)}
  .snav-g{position:absolute;width:1px;height:1px;margin:0;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
  .snav ul{flex-direction:row;gap:0}
  .snav a{height:44px;padding:0 12px;border-radius:0;background:transparent;overflow:visible}
  .snav a::before{content:"";position:absolute;inset:8px 2px;z-index:-1;border-radius:var(--radius-xs);background:transparent;transition:background-color var(--dur-fast) ease}
  .snav a:hover{background:transparent}
  .snav a:hover::before{background:var(--gray-alpha-100)}
  .snav a::after{content:"";position:absolute;left:12px;right:12px;bottom:0;height:2px;background:var(--gray-1000);transform:scaleX(0);transition:transform var(--dur-base) var(--ease-out)}
  .snav a[aria-current="page"]{background:transparent}
  .snav a[aria-current="page"]::after{transform:scaleX(1)}
}
.srow .tbl th,.srow .tbl td{padding-left:12px;padding-right:12px}
.srow .sc .tbl{width:calc(100% + 2 * var(--card-pad));margin-left:calc(-1 * var(--card-pad));margin-right:calc(-1 * var(--card-pad));border-radius:0;box-shadow:none}
.srow .tbl th:first-child,.srow .tbl td:first-child{padding-left:var(--card-pad)}
.srow .tbl th:last-child,.srow .tbl td:last-child{padding-right:var(--card-pad)}
.srow .tbl th{border-radius:0;box-shadow:inset 0 1px 0 var(--gray-400),inset 0 -1px 0 var(--gray-400)}
.srow .tbl tbody tr:last-child td{border-radius:0}
.dirp .sec .empty>p:first-of-type{font-weight:400;color:var(--gray-900)}
.okt td:nth-child(2) .cv,.okt td:nth-child(5) .cv,.okt td:nth-child(6) .cv,.tokt td:nth-child(2) .cv,.tokt td:nth-child(6) .cv{white-space:nowrap}
.srow .ctl{display:flex;align-items:center;justify-content:space-between;gap:12px 24px;flex-wrap:wrap}
.srow .sc .tbl{margin-top:16px}
.srow .sc>.small.muted{margin-top:12px}
/* danger card: a 1px red edge only while its button is the irreversible one (stop); stopped = a plain card around "Resume". No band. */
.dz:has(.btn.danger:not([hidden])){box-shadow:0 0 0 1px var(--red-700)}
/* watch tab (2026-10-08): the same frame as settings (menu + one section). Levels carry no hue - block = solid, risk = outlined. */
/* held-mail level = the same chip as every state (.pill): block = x like .pill.bad, risk = ! like .pill.warn, both in an ink ring */
.lvl{display:inline-flex;align-items:center;gap:6px;min-height:20px;padding:0 8px;border-radius:var(--radius-full);background:transparent;color:var(--gray-1000);box-shadow:inset 0 0 0 1px var(--gray-1000);font-size:12px;line-height:16px;font-weight:500;white-space:nowrap;vertical-align:middle}
.lvl-block::before{content:"";width:8px;height:8px;flex:none;background:linear-gradient(45deg,transparent calc(50% - .75px),currentColor calc(50% - .75px) calc(50% + .75px),transparent calc(50% + .75px)),linear-gradient(-45deg,transparent calc(50% - .75px),currentColor calc(50% - .75px) calc(50% + .75px),transparent calc(50% + .75px))}
.lvl-block{box-shadow:inset 0 0 0 1.5px var(--gray-1000)}
.lvl-risk{box-shadow:inset 0 0 0 1px var(--gray-400)}
.lvl-risk::before{content:"!";font-weight:600}
.held-why{display:block;margin-top:2px;text-align:right;white-space:nowrap} /* why a held mail cannot be released - visible on touch too */
.wfix{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0;font-size:13px;line-height:20px;color:var(--gray-900)}
dialog .wfix{margin-top:16px;padding-top:16px;border-top:1px solid var(--gray-alpha-400)}
.sdr{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%}
.sdr .addr{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.auth{display:inline-flex;align-items:center;gap:2px;flex:none;font-size:12px;line-height:16px;color:var(--gray-900)}
.auth .ico{width:12px;height:12px}
.auth.on{color:var(--gray-1000);font-weight:500}
.auth:not(.on){text-decoration:underline dotted var(--gray-600);text-underline-offset:3px}
.srow .ctl .wfl{display:flex;align-items:center;gap:8px;margin:0}
.srow .ctl .wfl>span{margin:0;font-size:13px;font-weight:400;color:var(--gray-900);white-space:nowrap}
.srow .ctl .wfl select{height:32px;width:auto;min-width:180px;max-width:100%}
.srow .wctl{margin-top:16px;padding-top:16px;border-top:1px solid var(--gray-400)}
.wwarn{margin:0 0 16px}
.wwarn>p{margin:4px 0 0;color:var(--gray-900)}
#w-agents .wfix{margin-bottom:0}
.wht .sdr .addr{max-width:20ch}
.wht td:nth-child(3) .cv{max-width:min(24ch,22cqi)}
.wht td.act .small{display:inline-block;max-width:9em;white-space:normal;line-height:16px;text-align:right;vertical-align:middle}
/* held-mail table fits its card at every table width (768px+; the release button was cut off at 1024-1280): fixed columns, the reason wraps to two lines, the sender stacks its auth mark under the domain, names and domains end in an ellipsis (full text on hover) */
@media (min-width:768px){
  .wht{table-layout:fixed}
  .wht th:nth-child(1){width:18%}
  .wht th:nth-child(2){width:76px}
  .wht th:nth-child(4){width:22%}
  .wht th:nth-child(5){width:104px}
  .wht th:nth-child(6){width:112px}
  .wht td{overflow:hidden}
  .wht td .cv,.wht td:first-child .cv{max-width:none}
  .wht td:nth-child(3) .cv{max-width:none;white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-height:18px}
  .wht td.act .btn{margin-left:0}
  .wht .sdr{flex-direction:column;align-items:flex-start;gap:0}
  .wht .sdr .addr{max-width:100%}
}
.aw-sw .sw-st{order:1;min-width:2.5em;text-align:right;color:var(--gray-900)}
.aw-sw .small.muted:empty{display:none}
.srow .sc>.idsw.aw-sw+.pl,.srow .sc>.pl+.idsw.aw-sw{margin-top:16px;padding-top:16px;border-top:1px solid var(--gray-400)}
.srow .sc>.pl.wcap{margin-bottom:0}
.wdef{margin-top:16px;padding:12px 16px;border-radius:var(--radius-md);background:var(--gray-100);font-size:13px;line-height:20px}
.wdef h3{margin:0 0 4px;font-size:13px;line-height:20px;font-weight:600}
.wdef ul{margin:0;padding-left:18px}
.wdef li+li{margin-top:2px}
.wtok{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;margin:12px 0 0;color:var(--gray-900)}
.wpick{margin-bottom:8px}
dialog .wpick+.check{margin-bottom:16px}
.gsum{display:flex;align-items:center;justify-content:space-between;gap:12px 24px;flex-wrap:wrap}
.gate-body{padding:0 var(--card-pad) var(--card-pad)}
.gate-body .row>.field{max-width:480px}
.gate-body h3{font-size:16px;line-height:24px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--gray-400)}
.gate-body .hrow:has(>h3){margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--gray-400)} /* the rule runs under the tip too */
.gate-body .hrow>h3{flex:none;margin:0;padding:0;border:0}
.gate-body>.block,.gate-body>form.block{margin-top:24px}
.gate-body .note .hrow,.gate-body .hrow .note{margin:0}
.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px}

.meter{height:4px;border-radius:var(--radius-full);background:var(--gray-200);position:relative;overflow:hidden}
.meter>i{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:inherit;background:var(--gray-700);transition:width var(--dur-base) var(--ease-out)}
.meters{display:grid;gap:16px}
.mrow .mh{display:flex;justify-content:space-between;gap:12px;font-size:14px;margin-bottom:8px}
.mrow .mh b{font-weight:500;font-variant-numeric:tabular-nums}

.verdict{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:32px;padding:24px 0;border-bottom:1px solid var(--gray-400);margin-bottom:32px}
.v-status{font-size:32px;line-height:40px;font-weight:600;letter-spacing:-0.025em;margin:8px 0 12px}
.v-meaning{max-width:52ch}
.v-facts{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;align-content:start;font-size:14px;margin:0}
.v-facts dt{color:var(--gray-900)}
.v-facts dd{margin:0;font-weight:500;min-width:0;overflow-wrap:anywhere}
.v-day{font-size:48px;line-height:54px;font-weight:600;letter-spacing:-0.035em;font-variant-numeric:tabular-nums;margin-bottom:16px}
.v-day small{font-size:16px;font-weight:500;letter-spacing:0;color:var(--gray-900);margin-left:4px}
.v-day small:first-child{margin:0 8px 0 0}

.days{display:grid;grid-template-columns:repeat(14,minmax(0,1fr));gap:4px;margin:8px 0}
.phase{grid-column:span 7;font-size:12px;font-weight:500;color:var(--gray-900);border-bottom:1px solid var(--gray-400);padding-bottom:4px;margin-bottom:4px}
.day{display:flex;flex-direction:column;align-items:stretch;gap:4px}
.day .col{position:relative;height:72px;border-radius:4px;background:var(--background-100);box-shadow:inset 0 0 0 1px var(--gray-400);overflow:hidden}
.day .col i{position:absolute;left:0;right:0;bottom:0;height:0;background:var(--gray-700);transition:height var(--dur-base) var(--ease-out)}
.day .cnt{text-align:center;font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;min-height:16px}
.day .col.fill i{background:var(--gray-300)}
.day.past .col{box-shadow:inset 0 0 0 1px var(--gray-600)}
.day.now .col{box-shadow:inset 0 0 0 2px var(--gray-1000)}
.day .d{text-align:center;font-size:12px;font-variant-numeric:tabular-nums;color:var(--gray-900)}
.day.now .d{color:var(--gray-1000);font-weight:600}
.day .tagx{text-align:center;font-size:12px;font-weight:600;min-height:16px}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--gray-900);margin-top:8px}
.ac{border-top:1px solid var(--gray-400);padding:16px 0 20px}
.ac h4{font-size:14px;display:flex;gap:8px;align-items:baseline;margin-bottom:8px}
.ac h4 .code{font-size:13px;color:var(--gray-900);font-weight:500;font-variant-numeric:tabular-nums}
.ac h4 .pill{margin-left:auto}
.ac p+p{margin-top:4px}
/* agent policy change requests (email page, ADR-0007 2026-10-13) - one ink-ringed card above the two columns; each request is a row:
   title + times, the risk warning (hatched), now -> if approved, the agent's reason (quoted text), then Reject / Approve. */
.preq{margin:0 0 24px;padding:16px var(--card-pad) 8px;border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-border)}
.preq .sh{margin-bottom:4px}
.prlist{list-style:none;margin:0;padding:0}
.pr{border-top:1px solid var(--gray-400);padding:16px 0}
.pr:first-child{border-top:0;padding-top:8px}
.pr-h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px}
.pr-h strong{font-size:14px;line-height:20px;font-weight:500}
.pr-h .when{margin-left:auto;font-size:12px;line-height:16px;color:var(--gray-900);font-variant-numeric:tabular-nums}
.pr .warnbox{margin:8px 0}
.pr .warnbox>p{margin:4px 0 0}
.pr-diff{grid-template-columns:repeat(2,minmax(0,1fr));margin:8px 0}
.pr-op{font-weight:600}
.pr-reason{display:flex;flex-direction:column;gap:2px;margin:8px 0 0;font-size:14px;line-height:20px;overflow-wrap:anywhere}
.pr-reason .muted{font-size:12px;line-height:16px}
.pr>.small{margin:8px 0 0}
.pr .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.next{margin:8px 0 0;padding:0;list-style:none}
.next li{position:relative;padding:8px 0 8px 20px;border-top:1px solid var(--gray-400);font-size:14px}
.next li::before{content:"";position:absolute;left:2px;top:15px;width:6px;height:6px;border:solid var(--gray-900);border-width:1.5px 1.5px 0 0;transform:rotate(45deg)}
.log{margin:8px 0 0;padding:0;list-style:none;font-size:13px}
.log li{padding:4px 0;border-top:1px solid var(--gray-400)}

dialog{width:min(560px,calc(100vw - 32px));max-width:none;padding:0;border:0;border-radius:var(--radius-md);background:var(--background-raised);color:var(--gray-1000);box-shadow:var(--shadow-modal)}
dialog[open]{animation:dlg-in var(--dur-base) var(--ease-out)}
@keyframes dlg-in{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:none}}
dialog::backdrop{background:var(--scrim)}
dialog[open]::backdrop{animation:fade-in var(--dur-base) var(--ease-out)}
dialog .dh{padding:var(--card-pad) var(--card-pad) 0}
dialog .dh.hatch{padding-bottom:16px;border-bottom:1px solid var(--gray-alpha-400)} /* irreversible: the red kicker and the solid red run button say it - no band */
dialog .dh.hatch .kicker{color:var(--red-700)}
dialog .dh.once{padding-bottom:16px;border-bottom:1px solid var(--gray-alpha-400)} /* shown once: a plain head (no hatch) */
dialog h3{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-0.015em;margin-top:4px}
html[lang="ko"] dialog h3{letter-spacing:-0.008em}
dialog .db{padding:16px var(--card-pad) var(--card-pad)}
dialog .db p+p{margin-top:8px}
dialog .db .lbl{margin-top:16px}
dialog .df{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding:12px var(--card-pad);border-top:1px solid var(--gray-alpha-400);border-radius:0 0 var(--radius-md) var(--radius-md);background:transparent}
.tokenbox{display:flex;align-items:center;gap:8px;margin:8px 0;padding:4px 4px 4px 12px;border-radius:var(--radius-md);background:var(--gray-100);box-shadow:var(--shadow-border)}
.tokenbox code{flex:1;min-width:0;padding:8px 0;word-break:break-all;font-size:13px;line-height:20px;user-select:all;-webkit-user-select:all}
.tokenbox .btn{height:32px;padding:0 12px}
pre.snippet{margin:8px 0;padding:12px 16px;border-radius:var(--radius-md);background:var(--gray-100);overflow:auto;font-size:13px;line-height:20px;white-space:pre}
dialog pre.snippet{white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px}
.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 16px;margin:16px 0;font-size:14px;line-height:20px}
.kv dt{color:var(--gray-900);font-size:13px}
.kv dd{margin:0;min-width:0}

dialog.sheet{position:fixed;inset:8px 8px 8px auto;margin:0;width:min(560px,calc(100vw - 16px));height:auto;max-height:none;overflow:auto;animation:sheet-in var(--dur-base) var(--ease-out)}
@keyframes sheet-in{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}
.sheet .dh{position:sticky;top:0;z-index:1;padding:16px var(--card-pad);background:var(--background-raised);border-bottom:1px solid var(--gray-400)}
.sheet-top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.sheet h3{overflow-wrap:anywhere}
.sheet h4{margin:24px 0 8px;font-size:12px;line-height:16px;font-weight:500;color:var(--gray-900)}
.sheet .kv{grid-template-columns:minmax(104px,auto) minmax(0,1fr)}
.sheet .kv dd{overflow-wrap:anywhere}
.sheet .db{padding-bottom:32px}
pre.lbody{margin:0 0 8px;padding:12px 16px;border-radius:var(--radius-md);background:var(--gray-100);font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:440px;overflow:auto}
.tl{list-style:none;margin:4px 0 0 4px;padding:0 0 0 20px;box-shadow:inset 1px 0 0 var(--gray-400)}
.tl li{position:relative;display:grid;grid-template-columns:minmax(0,auto) minmax(0,1fr);gap:0 12px;align-items:baseline;padding:4px 0;font-size:13px;line-height:20px}
.tl li::before{content:"";position:absolute;left:-24px;top:10px;width:8px;height:8px;border-radius:50%;background:var(--gray-1000);box-shadow:0 0 0 3px var(--background-raised)}
.tl li.ev-bad::before{background:repeating-linear-gradient(-45deg,var(--gray-1000) 0 1.5px,var(--background-raised) 1.5px 3px);box-shadow:inset 0 0 0 1.5px var(--gray-1000),0 0 0 3px var(--background-raised)}
.tl li.ev-dim::before{background:var(--background-raised);box-shadow:inset 0 0 0 1.5px var(--gray-600),0 0 0 3px var(--background-raised)}
.tl li.ev-ok .tl-k{font-weight:600}
.tl .tl-when{font-size:13px;color:var(--gray-900);white-space:nowrap;font-variant-numeric:tabular-nums}
.tl .tl-k{font-weight:500}
.tl .tl-code{grid-column:2;font-size:12px;color:var(--gray-900)}
.pills{display:inline-flex;gap:6px;flex-wrap:wrap}

.it-facts{grid-template-columns:repeat(4,minmax(0,1fr));gap:0;margin:0 calc(-1 * var(--card-pad));border-radius:0;box-shadow:inset 0 1px 0 var(--gray-400),inset 0 -1px 0 var(--gray-400);overflow:hidden}
.it-facts>div:first-child{padding-left:var(--card-pad)}
.it-facts>div{padding:12px 16px;min-width:0;box-shadow:1px 0 0 var(--gray-400)}
.it-facts dd{display:flex;flex-direction:column;align-items:flex-start;gap:4px}
.it-facts dd .sub{font-weight:400;font-size:12px}
.it-facts dd.num>span:first-child{font-size:14px;line-height:20px;font-weight:500}
.itk{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;margin-right:auto}
.itk .lbl{margin:0;font-size:13px;font-weight:400;color:var(--gray-900)}
.itk .it-kv{flex-direction:row;align-items:center;gap:8px}
.chip{display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:var(--radius-xs);background:var(--gray-100);color:var(--gray-1000);font-family:var(--font-mono);font-size:12px;white-space:nowrap}
.it-facts .pills{align-items:center}
.it-kv{display:flex;flex-direction:column;gap:4px;min-width:0}

.pane{padding:0}
.ah-t{flex:1 1 280px;min-width:0}
.ah h1{overflow-wrap:anywhere}
.ameta{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;margin-top:4px;font-size:14px;color:var(--gray-900)}
.ameta #a-ident{color:var(--gray-900)}
.idchip{display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 2px 0 8px;border-radius:var(--radius-xs);background:var(--gray-100)}
.idchip .mono{font-size:12px;color:var(--gray-1000)}
.idchip .icon-btn{width:24px;height:24px}
.idchip .icon-btn .ico{width:14px;height:14px}
.hsub{font-size:14px;color:var(--gray-900)}
.nmw{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%}
/* list rows open on a click anywhere in the row (hover = the row's background); names carry no underline (F39) */
.nmw a,.tbl tr.rl .nmt a{font-weight:500;text-decoration:none}
.ocards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:0 0 32px}
.ocards>.ocard:first-child{grid-column:span 2}
.ocard{min-width:0;padding:16px var(--card-pad);border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-medium)}
.ocard .bh{margin-bottom:12px;min-height:24px}
.ocard .kv{margin:0;grid-template-columns:minmax(72px,auto) minmax(0,1fr)}
.ocard .kv dd{font-weight:500;overflow-wrap:anywhere}
.dz{margin-top:32px;border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-border)}
.dz-row{display:flex;align-items:center;gap:24px;justify-content:space-between;padding:var(--card-pad)}
.dz-row~.dz-row{box-shadow:inset 0 1px 0 var(--gray-alpha-400)}
.dz-t{min-width:0}
.dz-t h2{font-size:17px;line-height:24px}
.dz-t p{margin-top:4px;color:var(--gray-900)}
.dz .btn{height:32px;padding:0 12px}
.dz .msg{margin:0 var(--card-pad) 16px}
.dz .msg:empty{display:none}

.em-tabs{display:none;margin:0 0 16px}
.em-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px;align-items:start}
.dirp{position:relative;min-width:0;padding:var(--card-pad) var(--card-pad) 0;border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-medium);overflow:hidden}
.dirp .sh{margin-bottom:12px}
.dirp>.sh h2{font-size:20px;line-height:28px;letter-spacing:-0.015em}
html[lang="ko"] .dirp>.sh h2{letter-spacing:-0.008em}
.dirp .sec .sh h2,.dirp .lh h3{font-size:14px;line-height:20px;font-weight:500;letter-spacing:0}
.dirp .sec .sh{margin-bottom:12px;min-height:24px}
.modes-f{margin:0}
.mseg{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:2px;padding:4px;border-radius:var(--radius-sm);background:var(--gray-100)}
.mopt{position:relative;display:flex;align-items:center;justify-content:center;min-height:32px;padding:4px 8px;border-radius:var(--radius-xs);color:var(--gray-900);cursor:pointer;font-size:14px;line-height:20px;font-weight:500;text-align:center;transition:background-color var(--dur-fast) ease,color var(--dur-fast) ease,box-shadow var(--dur-fast) ease}
.mopt input{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}
.mopt:hover{color:var(--gray-1000)}
.mopt:has(input:focus-visible){outline:2px solid var(--focus-ring);outline-offset:2px;z-index:1}
.mopt.m-none{background:var(--hatch-mode)}
.mopt.on,.mopt.on:hover{background:var(--background-raised);color:var(--gray-1000);box-shadow:inset 0 0 0 1px var(--gray-600)}
.mopt.m-none.on{background:var(--hatch-mode) var(--background-raised)}
.mopt.m-none .t{padding:0 6px;border-radius:4px;background:var(--background-100)} /* the label sits on a solid chip over the hatch (R10-08) */
.mopt.m-none.on .t{background:var(--background-raised)}
.mopt .md{display:none}
.mopt .cur{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.mopt:not(.saved) .cur{display:none}
.mopt.saved .t::before{content:"";display:inline-block;width:6px;height:6px;margin:0 6px 2px 0;border-radius:50%;background:currentColor;vertical-align:middle}
.mline{font-size:13px;line-height:20px;color:var(--gray-900);margin:8px 0 0;min-height:20px}
.dirp .lists{grid-template-columns:minmax(0,1fr);gap:24px;margin-top:24px}
.dirp .lists:not(:has(*)){display:none}
details.unused{margin-top:24px;border-top:1px solid var(--gray-400);padding-top:12px}
details.unused summary{cursor:pointer;font-size:13px;font-weight:500;color:var(--gray-900)}
details.unused[open] summary{color:var(--gray-1000)}
details.unused .lists{margin-top:12px}
.dirp .sec .tbl{margin-top:4px}
.dirp>.msg{margin:16px 0 0}
.savebar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:24px calc(-1 * var(--card-pad)) 0;padding:12px var(--card-pad);border-top:1px solid var(--gray-alpha-400);background:transparent;font-size:13px;line-height:18px;color:var(--gray-900);transition:background-color var(--dur-fast) ease}
.savebar.dirty{background:var(--gray-100);color:var(--gray-1000);font-weight:500}
.savebar.dirty>span:first-child::before{content:"";display:inline-block;width:6px;height:6px;margin:0 8px 2px 0;border-radius:50%;background:currentColor;vertical-align:middle}

.idsw{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.idsw-r{display:flex;align-items:center;gap:8px}
.idsw-l{font-size:14px;font-weight:500}
/* AI mail watch row (settings): name on the left, state word + switch at the right end, the line below reads left */
.idsw.aw-sw{align-items:stretch}
.aw-sw .idsw-r{gap:12px}
.aw-sw .idsw-l{flex:1;min-width:0}
.aw-sw #aw-st{order:1;min-width:2.5em;text-align:right;color:var(--gray-900)}
.aw-sw .switch{order:2}
.switch{position:relative;width:36px;height:20px;padding:0;border:0;border-radius:var(--radius-full);background:var(--gray-200);box-shadow:0 0 0 1px var(--gray-600);cursor:pointer;flex:none;transition:background-color var(--dur-base) var(--ease-in-out),box-shadow var(--dur-base) var(--ease-in-out)}
.switch .knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--background-100);box-shadow:var(--shadow-small);transition:transform var(--dur-base) var(--ease-in-out)}
.switch[aria-checked="true"]{background:var(--gray-700);box-shadow:0 0 0 1px var(--gray-700)}
.switch[aria-checked="true"] .knob{transform:translateX(16px)}
.switch[aria-busy="true"] .knob{transform:translateX(8px)}
.switch[aria-disabled="true"]{background:var(--gray-100);box-shadow:0 0 0 1px var(--gray-400);cursor:not-allowed}
.switch[aria-disabled="true"] .knob{background:var(--gray-300);box-shadow:none}
#id-sw-line:empty,#id-sw-st:empty{display:none}
.idlay{display:grid;grid-template-columns:minmax(280px,340px) minmax(0,1fr);gap:24px;align-items:start}
/* the facts beside the ID card are one surface split by 1px lines - not five identical cards */
.idinfo{min-width:0;display:flex;flex-direction:column;border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-border);overflow:hidden}
.idinfo>.msg:empty,.idinfo>.small:empty{display:none}
.idinfo>.msg,.idinfo>.small{margin:0;padding:12px var(--card-pad);box-shadow:inset 0 -1px 0 var(--gray-400)}
.idsec{padding:16px var(--card-pad)}
.idsec+.idsec,.idsec+.tech{box-shadow:inset 0 1px 0 var(--gray-400)}
.idsec .sh{margin-bottom:12px}
.idsec .kv{margin:0;grid-template-columns:minmax(96px,auto) minmax(0,1fr)}
.idsec .kv dd{overflow-wrap:anywhere}
.idorg{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:14px}
.conly{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:var(--radius-full);box-shadow:inset 0 0 0 1px var(--gray-400);font-size:12px;font-weight:500;color:var(--gray-900)}
.conly .ico{width:14px;height:14px}
.cpr{display:flex;align-items:center;gap:4px;min-width:0}
.cpr .mono{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.idsec .kv dd.mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cpr .icon-btn{width:24px;height:24px}
.cpr .icon-btn .ico{width:14px;height:14px}
.idc-links{list-style:none;margin:0;padding:0;display:flex;gap:4px 16px;flex-wrap:wrap;font-size:14px;font-weight:500}
.idc-links a .ico{width:14px;height:14px;margin-left:4px;vertical-align:-2px}

.idc,.idthumb{--h:300;--h2:320;--h3:0;--h4:155;--cs:1;--id-bg:oklch(96% calc(.035 * var(--cs)) var(--h));--id-bg2:oklch(90% calc(.07 * var(--cs)) var(--h2));--id-line:oklch(66% calc(.12 * var(--cs)) var(--h));--id-ink:var(--gray-1000);--id-label:oklch(42% calc(.03 * var(--cs)) var(--h));--id-seal:oklch(52% calc(.14 * var(--cs)) var(--h));--id-edge:oklch(80% calc(.06 * var(--cs)) var(--h));--id-foil-a:oklch(98% calc(.05 * var(--cs)) var(--h3) / .55);--id-foil-b:oklch(95% calc(.06 * var(--cs)) var(--h4) / .4);--id-shadow:oklch(40% calc(.08 * var(--cs)) var(--h) / .45);--id-hatch:oklch(66% calc(.12 * var(--cs)) var(--h) / .08)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .idc,:root:not([data-theme="light"]) .idthumb{--id-bg:oklch(26% calc(.04 * var(--cs)) var(--h));--id-bg2:oklch(33% calc(.08 * var(--cs)) var(--h2));--id-line:oklch(62% calc(.12 * var(--cs)) var(--h));--id-label:oklch(78% calc(.03 * var(--cs)) var(--h));--id-seal:oklch(74% calc(.13 * var(--cs)) var(--h));--id-edge:oklch(40% calc(.06 * var(--cs)) var(--h));--id-foil-a:oklch(98% calc(.05 * var(--cs)) var(--h3) / .18);--id-foil-b:oklch(95% calc(.06 * var(--cs)) var(--h4) / .14);--id-shadow:oklch(8% calc(.02 * var(--cs)) var(--h) / .9)}}
:root[data-theme="dark"] .idc,:root[data-theme="dark"] .idthumb{--id-bg:oklch(26% calc(.04 * var(--cs)) var(--h));--id-bg2:oklch(33% calc(.08 * var(--cs)) var(--h2));--id-line:oklch(62% calc(.12 * var(--cs)) var(--h));--id-label:oklch(78% calc(.03 * var(--cs)) var(--h));--id-seal:oklch(74% calc(.13 * var(--cs)) var(--h));--id-edge:oklch(40% calc(.06 * var(--cs)) var(--h));--id-foil-a:oklch(98% calc(.05 * var(--cs)) var(--h3) / .18);--id-foil-b:oklch(95% calc(.06 * var(--cs)) var(--h4) / .14);--id-shadow:oklch(8% calc(.02 * var(--cs)) var(--h) / .9)}
.idc.st-draft,.idc.st-revoked,.idc.nokey,.idthumb.nokey{--cs:0}
.idc.st-suspended{--cs:.4}
@supports not (color:oklch(0% 0 0)){:root:not(.nx) .idc,:root:not(.nx) .idthumb{--id-bg:var(--background-raised);--id-bg2:var(--gray-100);--id-line:var(--gray-900);--id-label:var(--gray-900);--id-seal:var(--gray-1000);--id-edge:var(--gray-1000);--id-foil-a:transparent;--id-foil-b:transparent;--id-shadow:transparent;--id-hatch:var(--gray-100)}}
.idw{container-type:inline-size;width:min(100%,400px)}
.idc{--pad:clamp(16px,6cqi,24px);position:relative;isolation:isolate;display:flex;flex-direction:column;gap:clamp(6px,2.2cqi,10px);width:100%;aspect-ratio:53.98/85.6;padding:var(--pad);border:1px solid var(--id-edge);border-radius:clamp(14px,4.2cqi,18px);background:var(--id-bg);color:var(--id-ink);box-shadow:0 1px 0 var(--id-edge),0 18px 40px -18px var(--id-shadow);overflow:hidden}
.idc-h{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:clamp(8px,2.4cqi,12px);border-bottom:1px solid var(--id-edge)}
.idc-org{display:flex;flex-direction:column;gap:2px;min-width:0}
.idc-l,.idc-k,.idc dt{font-size:10.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--id-label);line-height:1.3}
.idc-k{margin:2px 0 0}
.idc-on{display:flex;align-items:center;gap:6px;min-width:0;font-size:15px;font-weight:700;line-height:1.3}
.idc-on>.idc-v{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.idc-on .ico{width:14px;height:14px;color:var(--id-label)}
.idc-h .logo{height:16px}
.idc-art{--mx:50%;--my:50%;position:relative;aspect-ratio:1/1;border-radius:10px;overflow:hidden;background:linear-gradient(160deg,var(--id-bg) 0%,var(--id-bg2) 100%);box-shadow:inset 0 0 0 1px var(--id-edge)}
.idc-art::after{content:"";position:absolute;inset:0;background:linear-gradient(115deg,transparent 30%,var(--id-foil-a) 45%,var(--id-foil-b) 55%,transparent 70%);background-size:250% 250%;background-position:var(--mx) var(--my);mix-blend-mode:soft-light;pointer-events:none;transition:background-position .2s ease-out}
.idc.st-draft .idc-art::after,.idc.st-suspended .idc-art::after,.idc.st-revoked .idc-art::after,.idc.nokey .idc-art::after{display:none}
.idc-svg{display:block;width:100%;height:100%}
.idc-svg .rl{fill:none;stroke:var(--id-line);stroke-width:.35}
.idc-svg .rim{fill:none;stroke:var(--id-line);stroke-width:.45}
.idc-svg .disc{fill:var(--id-bg)}
.idc-svg .k{fill:var(--id-ink)}
.idc-svg .m{fill:var(--id-label)}
.idc-svg .nokey{fill:none;stroke:var(--id-line);stroke-width:.6;stroke-dasharray:2 2}
.idc.st-draft .sig,.idc.st-draft .disc{display:none}
.idc-name{font-size:clamp(20px,7cqi,26px);font-weight:700;letter-spacing:-.02em;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}
.idc-addr .addr{font-size:13px}
.idc-did{display:flex;align-items:center;gap:6px 10px;min-width:0;flex-wrap:wrap}
.idc-did .mono{font-size:11.5px;overflow-wrap:anywhere;min-width:0}
.seal{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:700;white-space:nowrap}
.seal .ico{width:14px;height:14px;color:var(--id-seal)}
.idc-row{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;margin-top:auto;padding-top:clamp(8px,2.4cqi,12px);border-top:1px solid var(--id-edge)}
.idc-aux{display:flex;gap:clamp(10px,4cqi,18px);margin:0;min-width:0}
.idc-aux dd{margin:2px 0 0;font-size:13px;font-weight:600;white-space:nowrap}
.idc-badge{padding:1px 9px;border:1px solid var(--id-ink);border-radius:999px;font-size:11.5px;font-weight:700;white-space:nowrap}
.idc-badge:empty{display:none}
.micro{margin:0 calc(var(--pad) * -1) calc(var(--pad) * -1);padding:5px var(--pad) 6px;border-top:1px solid var(--id-edge);font-family:var(--font-mono);font-size:6.5px;letter-spacing:.08em;line-height:1.4;color:var(--id-line);white-space:nowrap;overflow:hidden}
.idc .wm{position:absolute;z-index:2;left:50%;top:38%;transform:translate(-50%,-50%) rotate(-12deg);padding:2px 12px;background:var(--id-bg);border:1px solid var(--id-edge);font-size:clamp(20px,7cqi,30px);font-weight:700;letter-spacing:-.01em;color:var(--id-label);white-space:nowrap;pointer-events:none}
.idc .stamp{position:absolute;z-index:2;right:8%;top:56%;transform:rotate(-8deg);padding:3px 10px;border:2px solid var(--id-ink);background:var(--id-bg);font-size:13px;font-weight:700;letter-spacing:.08em;white-space:nowrap}
.idc.st-draft{border-style:dashed}
.idc.st-suspended::after{content:"";position:absolute;inset:0;z-index:-1;background:repeating-linear-gradient(45deg,transparent 0 7px,var(--id-hatch) 7px 9px)}
.idc.st-revoked .idc-v,.idc.st-revoked .idc-v .addr{color:var(--id-label)}
.idthumb{--sz:24px;display:inline-flex;flex:none;width:var(--sz);height:var(--sz);border-radius:50%;background:var(--id-bg2);box-shadow:inset 0 0 0 1px var(--id-edge);overflow:hidden}
.idthumb svg{display:block;width:100%;height:100%}
.idthumb .rl{fill:none;stroke:var(--id-seal);stroke-width:5}
.idthumb .core{fill:var(--id-seal)}
.idthumb .nokey{fill:none;stroke:var(--id-line);stroke-width:5;stroke-dasharray:8 7}
.idthumb:empty{box-shadow:inset 0 0 0 1px var(--gray-400);background:var(--gray-100)}
.idthumb.lg{--sz:56px}
.idthumb.dot{--sz:16px}
.idthumb.dot .rl{stroke-width:7}

.tk-filter{margin:0 0 16px}
.tokt tr.off td{color:var(--gray-900)}
.tkn{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.caps{display:flex;gap:4px;flex-wrap:wrap}
.more-btn span{font-size:16px;line-height:1;letter-spacing:0}
/* webhooks (2026-09-30): the endpoint table reads like the token table (one limits line under the head, a row menu); the deliveries sit
   below as a dense table with a webhook filter on the section head. State pills are the same ringed chip as everywhere else. */
.whurl{font-size:13px}
.whk td:first-child .cv.whep{display:flex;flex-direction:column;align-items:flex-start;gap:6px;max-width:min(56ch,40cqi);padding:4px 0}
.whep .whurl{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.whep .caps{flex-wrap:wrap;max-width:none;overflow:visible}
.whsv{display:flex;flex-direction:column}
.whsv .muted{font-size:12px;line-height:16px}
/* webhook Authorization header (202610141400): space the optional field from the note above; in the table only the hint value is mono. */
.whauth{margin-top:16px}
.whah .mono{font-size:12px}
.cap.mono{font-family:var(--font-mono);font-size:11.5px}
.whld{display:inline-flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0}
.whld .muted{font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
.wdsec{margin-top:48px}
.whf{display:inline-flex;align-items:center;gap:8px}
.whf .lbl{margin:0;font-size:13px;font-weight:400;color:var(--gray-900)} /* filter = label + select (F40) */
.whf select{height:32px;width:auto;max-width:280px;font-size:13px}
.whd .mono{font-size:12.5px}
.whd .whw{color:var(--gray-900)}
.evset .check{margin:6px 0}
.evset .check>span{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 4px}
.caphint{display:block;flex-basis:100%;margin-top:2px;font-size:13px;line-height:18px;color:var(--gray-900)}
.integ{margin:0}
.integ #it-shred,.integ #it-ver{margin-top:12px}
.integ #it-ver code{font-size:12px;padding:0 4px;border-radius:4px;background:var(--gray-100)}
.integ .empty{padding:16px}
.srow .empty{display:block;padding:8px 0 0;box-shadow:none;background:none;border-radius:0;text-align:left;font-size:13px;line-height:20px}
.srow .empty>p:first-of-type{font-weight:400;color:var(--gray-900)}
.srow .empty .btn{display:none}
.disp{display:flex;flex-direction:column;gap:12px}
.dg{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.dg .lbl{margin:0;min-width:64px;font-weight:400;color:var(--gray-900)}

.okt .addr{white-space:nowrap}
.rolechip{display:inline-flex;align-items:center;flex:none;height:20px;padding:0 6px;border-radius:var(--radius-xs);background:var(--gray-100);color:var(--gray-1000);font-size:12px;line-height:16px;font-weight:400;white-space:nowrap} /* every role the same chip (F20) */
.rolechip:empty{display:none}
.orglist{list-style:none;margin:0;padding:0;border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-medium);overflow:hidden}
.orglist:empty{display:none}
.orglist li+li{border-top:1px solid var(--gray-400)}
.orgpick{display:flex;align-items:center;gap:16px;width:100%;min-height:76px;padding:12px var(--card-pad);border:0;background:transparent;color:var(--gray-1000);text-align:left;cursor:pointer;transition:background-color var(--dur-fast) ease}
.orgpick:hover{background:var(--gray-alpha-100)}
.orgpick:focus-visible{outline:2px solid var(--focus-ring);outline-offset:-2px}
.op-t{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.op-n{font-size:17px;line-height:24px;font-weight:600;letter-spacing:-0.01em;overflow-wrap:anywhere}
.op-m{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.op-go{display:inline-flex;color:var(--gray-900);flex:none}
.mbn{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.rolesel{width:auto;min-width:112px;height:32px;font-size:14px}
.subsec{margin-top:24px}
.subsec .lh{margin-bottom:0}
.capset{margin:4px 0 16px}
.capset legend{padding:0}
.capset .check{margin:8px 0}
.capset code,.rolepick .ro-d{color:var(--gray-900)}
.capset code{font-size:12px;margin-left:4px}
.capnote{display:block;font-size:13px;font-weight:500;margin-top:4px}
.capnote::before{content:"! "}
.rolepick{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0 0 16px}
.rolepick legend{padding:0}
.ropt{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 8px;align-items:center;padding:12px;border-radius:var(--radius-sm);box-shadow:inset 0 0 0 1px var(--gray-400);cursor:pointer;transition:box-shadow var(--dur-fast) ease,background-color var(--dur-fast) ease}
.ropt:hover{box-shadow:inset 0 0 0 1px var(--gray-600)}
.ropt:has(input:checked){box-shadow:inset 0 0 0 2px var(--gray-1000);background:var(--gray-100)}
.ropt input{grid-row:1/3}
.ro-n{font-weight:600;font-size:14px}
.ro-d{font-size:13px;line-height:18px}
.role-ro .addbtn,.role-ro .lim-edit .btn{display:none}
/* read-only (member, F24): the edit footer goes; the mode segment shows only the saved mode as a value */
.role-ro .dirp .savebar,.role-ro .dirp .mopt:not(.saved){display:none}
.role-ro .dirp .mseg{display:flex;padding:0;background:none}
.role-ro .dirp .mopt.saved,.role-ro .dirp .mopt.saved.on{justify-content:flex-start;padding:0;background:none;box-shadow:none;color:var(--gray-1000);cursor:default}
.role-ro .dirp .mopt.saved .t::before{display:none}
.agbar{margin:0 0 16px;max-width:320px}
.agbar input{height:32px}
.vh-act .agbar{margin:0;width:240px;max-width:none}
.actions.more{justify-content:center;margin-top:16px}

/* low screens (landscape phone, 200% zoom - critique R8-03 , R8-04): the rail list scrolls; an open panel or drawer scrolls as one piece and
   its foot gets small (the plan card lives in Settings > Plan). */
@media (max-height:560px){
  .side-body{overflow-y:auto}
  .nav-open .side{overflow-y:auto}
  .nav-open .side-body{flex:none;overflow:visible}
  .side-foot{gap:4px;padding-top:4px;padding-bottom:4px}
}
@media (prefers-reduced-motion:reduce){*{transition:none !important;animation:none !important;scroll-behavior:auto !important}}
@media (min-width:1150px){.scrim{display:none}.top{padding-left:12px}:root[data-side="rail"] .top{padding-left:8px}}
@media (min-width:1150px) and (min-height:760px){.idw{position:sticky;top:calc(var(--header-h) + var(--space-6))}}
@media (min-width:1440px){.tbl .subj{max-width:48ch}}
@media (pointer:coarse){
  .btn.sm,.vh-act .btn{height:40px}
  .btn{height:44px}
  .mi{min-height:44px}
  .vh,.ah{min-height:40px}
}
/* ---- content-width layout (critique R8-01): the body decides by ITS width (container "main"), so opening or closing the sidebar
   never makes the page overflow. Shell switches (sidebar, header, drawer) stay on the viewport. ---- */
@container main (max-width:1039px){
  .em-tabs{display:inline-flex}
  .em-cols{grid-template-columns:minmax(0,1fr)}
  .em-cols.show-outbound #col-inbound,.em-cols.show-inbound #col-outbound{display:none}
  .dirp .lists{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
  .dirp>.sh{position:absolute;top:30px;left:var(--card-pad);right:var(--card-pad);z-index:1;justify-content:flex-end;min-height:0;margin:0;pointer-events:none}
  .dirp>.sh .hrow{justify-content:flex-end}
  .dirp>.sh .tip-btn,.dirp>.sh .tip-pop{pointer-events:auto}
  .dirp>.sh h2{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
  .dirp .modes-f{margin-right:32px}
}
@media (max-width:1149px){
  .menu-btn{display:inline-flex}
  .frame,:root[data-side="rail"] .frame{grid-template-columns:var(--side-rail) minmax(0,1fr)}
  .nav-open .side{position:fixed;top:var(--header-h);left:0;bottom:0;align-self:stretch;width:var(--side-w);height:auto;z-index:var(--z-sidebar);background:var(--background-raised);box-shadow:var(--shadow-menu)}
  .nav-open{overflow:hidden}
  .scrim{top:var(--header-h)}
  .main{padding:24px 32px 80px}
  .top-brand{width:32px;padding:0}
  .top-brand .brand{display:none}
  .top-brand .brand-s{display:block}
}
@container main (max-width:819px){
  .idlay{grid-template-columns:minmax(0,1fr);gap:24px}
  .idw{width:min(100%,360px);margin:0 auto}
}
@container main (max-width:959px){
  .ocards{grid-template-columns:minmax(0,1fr)}
  .ocards>.ocard:first-child{grid-column:auto}
}
@container main (max-width:900px){
  .split,.verdict{grid-template-columns:minmax(0,1fr);gap:24px}
}
@container main (min-width:640px) and (max-width:960px){
  .logt [data-k="reason"],.logt [data-k="agent"]{display:none}
  .tbl .subj{max-width:24ch}
  #agents-tbl th:nth-child(4),#agents-tbl td:nth-child(4),#agents-tbl th:nth-child(5),#agents-tbl td:nth-child(5),
  #ov-agents-tbl th:nth-child(4),#ov-agents-tbl td:nth-child(4),#ov-agents-tbl th:nth-child(5),#ov-agents-tbl td:nth-child(5),
  #tk-tbl th:nth-child(3),#tk-tbl td:nth-child(3),#tk-tbl th:nth-child(4),#tk-tbl td:nth-child(4),#ok-tbl th:nth-child(4),#ok-tbl td:nth-child(4),#ok-tbl th:nth-child(6),#ok-tbl td:nth-child(6){display:none}
}
@media (max-width:767px){
  .frame,:root[data-side="rail"] .frame{grid-template-columns:minmax(0,1fr)}
  .main{grid-column:1;padding:24px 16px calc(64px + env(safe-area-inset-bottom))}
  .srow{margin-bottom:16px}
  .rules .when{display:none}
  .side,.nav-open .side{position:fixed;top:0;left:0;bottom:0;align-self:stretch;width:min(300px,86vw);height:auto;z-index:var(--z-sidebar);border-radius:0 var(--radius-lg) var(--radius-lg) 0;background:var(--background-raised);box-shadow:var(--shadow-modal);transform:translateX(-100%);visibility:hidden;transition:transform var(--dur-base) var(--ease-out),visibility 0s linear var(--dur-base)}
  .nav-open .side{transform:none;visibility:visible;transition:transform var(--dur-base) var(--ease-out)}
  .scrim{top:0}
  .side-top{display:flex;align-items:center;justify-content:space-between;flex:none;height:56px;padding:0 12px 0 16px}
  .side-top .brand{display:block;height:20px;width:auto;color:var(--gray-1000)}
  .top-brand,.sep-brand{display:none}
  .side-foot{padding-bottom:max(16px,env(safe-area-inset-bottom))}
  .acct-b{height:48px}
  .nav a,.nav-back{height:40px;font-size:16px;line-height:24px}
  .top{gap:4px}
  .crumb .sw:has(>.menu:not([hidden]))::after{content:"";position:fixed;inset:0;z-index:calc(var(--z-popover) - 1);background:var(--scrim);animation:fade-in var(--dur-base) var(--ease-out)}
  #side-toggle{display:none}
  .menu-btn{margin-left:-8px}
  .crumb .menu{padding:4px 8px}
  .toasts{left:16px;right:16px;bottom:max(16px,env(safe-area-inset-bottom));width:auto;align-items:center}
  .sw .menu:not([hidden]){max-height:72vh}
  .crumb .menu .mfoot{margin:4px -8px 0;padding:4px 8px 0}
  .scope-agent .crumb .sw-org{display:none}
  .sw-t{max-width:34vw}
  .crumb .menu{position:fixed;z-index:var(--z-popover);left:0;right:0;bottom:0;top:auto;width:100%;min-width:0;max-width:none;overflow:hidden;border-radius:var(--radius-md) var(--radius-md) 0 0;padding-bottom:max(12px,env(safe-area-inset-bottom));transform-origin:bottom center}
  @starting-style{.crumb .menu.enter{opacity:0;transform:translateY(8px)}} /* the bottom sheet rises */
  .vh h1,.ah h1{font-size:20px;line-height:28px;letter-spacing:-0.015em}
  .vh-act{margin-left:auto}
  .tip-pop{position:static;flex-basis:100%;width:100%;max-width:none;margin-top:4px;box-shadow:var(--shadow-border)}
  .hrow.in{flex-wrap:wrap}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .stats .big{font-size:20px;line-height:28px}
  .steps li{grid-template-columns:16px minmax(0,1fr)}
  .steps li .more{grid-column:2}
  .dz-row{flex-direction:column;align-items:flex-start;gap:12px}
  .msgbox pre{padding:12px 16px;font-size:12px}
  .msgbox .bar .grow{display:none}
  .idsw{align-items:flex-start}
  .logbar{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px 12px}
  .logbar .filter{display:contents}
  .logbar .filter select,.logbar .filter input{width:100%;max-width:none}
  .logbar #lg-refresh{grid-column:1/-1;justify-self:end;margin-left:0}
  .chain{padding-left:20px}
  .blk::before{left:-24px}
  .rolepick{grid-template-columns:minmax(0,1fr)}
  .orgpick{min-height:68px}
  .agbar{max-width:none}
  .it-facts{grid-template-columns:repeat(2,minmax(0,1fr))}
  .v-status{font-size:24px;line-height:32px}
  .v-day{font-size:40px;line-height:48px}
  .shell h1,.p-landing .panel h2{font-size:24px;line-height:32px}
  .shell header{padding:0}
  .shell main{padding-top:48px}
  .days{gap:2px}
  .day .col{height:56px}
  .day .cnt,.day .d,.day .tagx{font-size:10px}
  .ah .vh-act{width:100%}
  .ah .vh-act .btn{width:100%}
  .ameta #a-ident{display:none}
  .vh:has(#ag-bar:not([hidden])){display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px 8px}
  .vh:has(#ag-bar:not([hidden])) .vh-act{display:contents}
  .vh-act .agbar{grid-column:1/-1;grid-row:2;width:100%;margin:0}
  dialog.sheet{inset:0;width:100%;border-radius:0}
}
/* narrow content (<640 - phones, and the drawer widths): tables become ~64px list rows (R4-02), columns stack (critique R8-01 , R8-09) */
@container main (max-width:639px){
  .tbl:not(.plt) thead{display:none}
  .tbl:not(.plt),.tbl:not(.plt) tbody,.tbl:not(.plt) tr,.tbl:not(.plt) td{display:block;width:100%}
  .tbl:not(.plt) tr{position:relative;padding:12px var(--card-pad);box-shadow:inset 0 -1px 0 var(--gray-400)}
  .tbl:not(.plt) tbody tr:last-child{box-shadow:none}
  .tbl tr.rl:hover{background:var(--gray-alpha-100)}
  .tbl tr.rl:hover td{background:transparent}
  .tbl:not(.plt) td,.tbl.dense:not(.plt) td,.srow .tbl:not(.plt) td{display:flex;justify-content:space-between;align-items:center;gap:16px;height:auto;padding:4px 0;box-shadow:none;text-align:right}
  .tbl tr.skr td:not(:first-child){display:none}
  .tbl tr.skr td{height:40px}
  .tbl:not(.plt) td::before{content:attr(data-label);flex:none;color:var(--gray-900);font-size:12px;line-height:20px;text-align:left}
  .tbl:not(.plt) td:first-child,.srow .tbl:not(.plt) td:first-child{justify-content:flex-start;padding:0 0 8px;text-align:left}
  .tbl:not(.plt) tr:has(td.act) td:first-child{padding-right:72px}
  .tbl:not(.plt) td:first-child::before{display:none}
  .tbl .cv,.tbl td:first-child .cv,.logt .cv,#ov-log-tbl .cv,#ao-log-tbl .cv{flex:1;min-width:0;max-width:none}
  .nmt>*{max-width:100%}
  .tbl td .caps{justify-content:flex-end}
  .tbl .subj{max-width:none;white-space:normal}
  .tbl:not(.plt) td.act,.srow .tbl:not(.plt) td.act{position:absolute;top:8px;right:var(--card-pad);width:auto;padding:0;gap:8px}
  .tbl:not(.plt) td.act::before{display:none}
  #agents-tbl td:not(:first-child):not([data-k="status"]),#ov-agents-tbl td:not(:first-child):not([data-k="status"]),
  .logt td:not(:first-child):not([data-k="result"]):not([data-k="peer"]):not(.act),
  #ov-log-tbl td:not(:first-child):not([data-k="result"]):not([data-k="peer"]),#ao-log-tbl td:not(:first-child):not([data-k="result"]):not([data-k="peer"]){display:none}
  /* tokens / org keys (F61): title line + the value + scopes, created, last use, expiry as label-value rows */
  .tbl td[data-k="status"],.tbl tr:not(:has(td.act)) td[data-k="result"]{position:absolute;top:12px;right:var(--card-pad);width:auto;padding:0}
  .tbl td[data-k="status"]::before,.tbl td[data-k="result"]::before,.tbl td[data-k="peer"]::before,.tokt td:nth-child(2)::before,.okt td:nth-child(2)::before{display:none}
  .tbl:not(.plt) td[data-k="peer"],.tbl:not(.plt).tokt td:nth-child(2),.tbl:not(.plt).okt td:nth-child(2){display:block;padding:0;text-align:left;color:var(--gray-900);font-size:13px}
  .tbl:not(.plt) td[data-k="peer"] .cv,.tbl:not(.plt).tokt td:nth-child(2) .cv,.tbl:not(.plt).okt td:nth-child(2) .cv{max-width:none;text-align:left}
  #agents-tbl td:first-child,#ov-agents-tbl td:first-child,.tbl tr:has(td[data-k="result"]) td:first-child{padding-right:112px}
  .tbl td[data-k="result"] .aiw{display:flex;width:max-content;margin:6px 0 0 auto}
  .logt tr:has(td[data-k="result"] .aiw) td[data-k="peer"]{padding-right:120px}
  #agents-tbl td:first-child,#ov-agents-tbl td:first-child{padding-bottom:0}
  .tbl td.act .btn{margin:0;white-space:nowrap;flex:none}
  .tbl td.act .menu{top:calc(100% + 4px)}
  .srow .tbl:not(.plt) td.act{position:static;justify-content:flex-end;padding-top:8px}
  .srow .tbl:not(.plt) tr:has(td.act) td:first-child{padding-right:0}
  .whd td:nth-child(5){display:none} /* endpoints keep secret version + created (F62) */
  .wht tr td:first-child{padding-right:64px}
  .wht td[data-k="status"]{top:12px}
  .srow .ctl .wfl{flex:1 1 100%}
  .srow .ctl .wfl select{flex:1;width:auto;min-width:0}
  .srow .tbl.wat:not(.plt) td.act{position:absolute;top:12px;right:var(--card-pad);width:auto;padding:0}
  .srow .tbl.wat:not(.plt) tr:has(td.act .btn) td:first-child{padding-right:88px}
  .wht .sdr .addr{max-width:none}
  .wht td.act .small{max-width:none}
  .whk td:first-child .cv.whep{max-width:none}
  .whk td .whep .caps{justify-content:flex-start}
  .whk .whld,.whk .whsv{align-items:flex-end}
  .whd tr:has(td.act .btn) td:first-child{padding-right:128px}
  .whf,.whf select{width:100%;max-width:none}
  .lists,.dirp .lists{grid-template-columns:minmax(0,1fr)}
  .mseg{grid-template-columns:minmax(0,1fr)}
  .mopt{justify-content:flex-start;flex-wrap:wrap;text-align:left;padding:8px 12px}
  .mopt .md{display:block;flex-basis:100%;font-size:13px;line-height:18px;font-weight:400;color:var(--gray-900)}
  .dirp .mline{display:none}
  /* DNS records (F63): one card per record - type, name, value + copy, priority, TTL, proxy, state stacked; no sideways scroll */
  .dnsw{overflow:visible}
  .dnst{min-width:0}
  .dnst thead{display:none}
  .dnst,.dnst tbody,.dnst tr,.dnst td,.dnst th{display:block;width:100%}
  .dnst tr.drr{padding:8px 0;box-shadow:inset 0 -1px 0 var(--gray-alpha-400)}
  .dnst tr.drr:hover td{background:transparent}
  .dnst td,.dnst .dk-type,.dnst .dk-name,.dnst .dk-prio,.dnst .dk-ttl,.dnst .dk-proxy,.dnst .dk-st{display:grid;grid-template-columns:88px minmax(0,1fr);gap:8px;align-items:start;width:100%;padding:4px 0;box-shadow:none;white-space:normal}
  .dnst td::before{content:attr(data-label);padding-top:4px;color:var(--gray-900);font-size:12px;line-height:20px}
  .dnst td>.cap,.dnst td>.pill,.dnst td>.dpx{justify-self:start;margin-top:4px}
  .dnst td>.dfq{grid-column:2;padding-right:32px}
  .dnst tr.dgrp th{padding:16px 0 4px}
  .dnst tr.dprep td{display:block}
  .dnst tr.dprep td::before{display:none}
}
/* Touch (critique R4-01): every target >= 40. Last in the sheet with selectors at least as specific as the rules they lift, so table,
   rule-row and danger-card buttons grow too. Icon-sized controls keep their look and widen only the hit area (::after). */
@media (pointer:coarse){
  .menu-btn,.side-top .icon-btn{width:40px;height:40px}
  .acct-b{height:44px}
  .aseg-i{height:32px;min-width:36px}
  @container side (max-width:120px){.acct-b{width:40px;height:40px}}
  .icon-btn,.tbl .icon-btn,.cpr .icon-btn,.idchip .icon-btn{position:relative}
  .icon-btn::after,.tip-btn::after,.switch::after,.more::after,.btn.link.sm::after,.lim-edit .btn.link::after{content:"";position:absolute;inset:-10px}
  .icon-btn::after{inset:-6px}
  .cpr .icon-btn::after,.idchip .icon-btn::after{inset:-8px}
  .switch::after{inset:-10px -2px}
  .more{position:relative}
  .sw-btn{height:40px}
  .seg a,.seg button{height:40px}
  .mopt{min-height:40px}
  input[type=text],input[type=password],input[type=email],input[type=search],input[type=number],input[type=date],select,
  .msearch input,.agbar input,.logbar .filter select,.logbar .filter input,.srow>.sf select,.whf select,.rolesel{height:44px}
  .btn.sm,.vh-act .btn,.rules .btn,.tbl td.act .btn,.dz .btn,.tokenbox .btn,.srow>.sf .btn,.savebar .btn,.msgbox .btn,.idsec .btn{height:40px}
  .nav a,.nav-back,.snav a{min-height:40px}
  .check{min-height:40px;align-items:center}
  .check input{width:20px;height:20px;margin-top:0}
}

`;

export const ADMIN_UI_CSS = adminUiCss(CONSOLE_FONT_ORIGIN);
