/**
 * src/ops/console/page.ts — 운영자 화면 한 장(P0 에 `scripts/ops-web/page.ts` 에서 옮겼다)(정적 HTML · 인라인 스타일 하나 · 인라인 스크립트 하나 · 해시 CSP).
 *
 * 콘솔(`src/admin/ui/page.ts`)과 같은 규율: 서버는 이 문자열에 **요청마다 아무 값도 끼워 넣지 않는다**. 데이터는 스크립트가 같은 오리진 API 에서
 * 받아 `textContent` 로만 그린다(HTML 문자열 싱크 없음 — 테스트가 소스에서 단언, 런타임 짝은 CSP `require-trusted-types-for`).
 * 스크립트는 ASCII 만(`asciiScript`) — 해시는 **박힌 그 문자열**에서 잰다. 외부 자원 0 — 폰트도 받지 않는다(콘솔 토큰의 글꼴 스택:
 * 로컬에 Pretendard 가 있으면 그것, 없으면 시스템 한글 글꼴).
 * 모양은 콘솔 셸 그대로: 흰 바탕 · 회색 스케일 토큰(`CONSOLE_LIGHT`·`CONSOLE_DARK` · `BASE_TOKENS`) · 왼쪽 사이드바 · shadow-as-border 카드.
 * 주황 없음(로고와 주소의 `@` 도 주변 글자색), 빨강은 되돌릴 수 없는 동작·오류만. 상태는 흑백 점(`.dot`) + 글자.
 *
 * **재사용**: `buildOpsPage(config)` 는 순수 함수다 — API 경로 앞부분(`apiBase`)과 인증 전달 방식(`auth`)만 받아 페이지를 만든다(빌드 시 한 번 ·
 * 요청마다가 아니다). 로컬 서버는 기본값(`/api` · `fragment-token`)을 쓴다. 다른 전달 계층(호스팅)이 쓰려면 `auth` 에 방식을 더한다.
 */

import { asciiScript, sha256Base64 } from '../../admin/ui/page';
import { CONSOLE_DARK, CONSOLE_LIGHT, CONSOLE_TOKEN_NAMES, type ConsolePalette } from '../../admin/ui/styles';
import { brandLockupSvg } from '../../ui/brand';
import { BASE_TOKENS } from '../../ui/tokens';

const decls = (p: ConsolePalette): string => CONSOLE_TOKEN_NAMES.map((k) => `--${k}:${p[k]}`).join(';');

export const OPS_CSS = `
:root{${decls(CONSOLE_LIGHT)};color-scheme:light}
@media (prefers-color-scheme:dark){:root{${decls(CONSOLE_DARK)};color-scheme:dark}}
${BASE_TOKENS}
:root{--radius-xs:4px;--side-w:224px}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--background-100);color:var(--gray-1000);font-family:var(--font-sans);font-size:14px;line-height:20px;-webkit-font-smoothing:antialiased;word-break:keep-all;overflow-wrap:break-word;font-feature-settings:"tnum" 0}
::selection{background:var(--gray-1000);color:var(--background-100)}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--gray-500);text-underline-offset:3px}
a:hover{text-decoration-color:var(--gray-1000)}
:focus{outline:none}
:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
input,select,button,textarea{font:inherit;color:inherit;accent-color:var(--gray-1000)}
h1,h2,h3{margin:0;font-weight:600}
p{margin:0}
code,.mono{font-family:var(--font-mono);font-size:12.5px;overflow-wrap:anywhere}
[hidden]{display:none !important}
.muted{color:var(--gray-900)}
.small{font-size:13px;line-height:18px}
.num{font-variant-numeric:tabular-nums}
.grow{flex:1}
.ico{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}

/* ---- shell: header + left sidebar (console v5 surface: one background, 1px edges) ---- */
.top{position:sticky;top:0;z-index:var(--z-header);display:flex;align-items:center;gap:12px;height:var(--header-h);padding:0 16px 0 20px;background:var(--background-100);box-shadow:0 1px 0 var(--gray-alpha-400)}
.logo{display:inline-flex;align-items:baseline;gap:8px;color:var(--gray-1000);line-height:1;white-space:nowrap;text-decoration:none}
.logo .brand{display:block;flex:none;width:auto;height:18px}
.logo .tag{position:relative;top:-2px;font-size:13px;font-weight:500;letter-spacing:0;color:var(--gray-900)}
.target{display:inline-block;max-width:52ch;height:24px;padding:0 10px;border-radius:var(--radius-full);font-size:12px;line-height:24px;color:var(--gray-900);box-shadow:inset 0 0 0 1px var(--gray-alpha-400);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.target::before{content:"";display:inline-block;width:6px;height:6px;margin:0 6px 1px 0;border-radius:50%;background:var(--gray-600);vertical-align:middle}
.target:empty{display:none}
.target.prod{color:var(--red-700);box-shadow:inset 0 0 0 1px var(--red-700)}
.target.prod::before{background:var(--red-700)}
.frame{display:grid;grid-template-columns:var(--side-w) minmax(0,1fr);min-height:calc(100vh - var(--header-h))}
.side{position:sticky;top:var(--header-h);align-self:start;display:flex;flex-direction:column;height:calc(100vh - var(--header-h));height:calc(100dvh - var(--header-h));background:var(--background-100);box-shadow:inset -1px 0 0 var(--gray-alpha-400)}
.nav{list-style:none;margin:0;padding:12px 8px;display:flex;flex-direction:column;gap:2px;flex:1}
.nav a{display:flex;align-items:center;gap:10px;height:32px;padding:0 8px;border-radius:var(--radius-sm);color:var(--gray-900);text-decoration:none;white-space:nowrap}
.nav a:hover{background:var(--gray-alpha-100);color:var(--gray-1000)}
.nav a[aria-current="page"]{background:var(--gray-alpha-200);color:var(--gray-1000);font-weight:500}
.nav .count{margin-left:auto;min-width:20px;height:20px;padding:0 6px;border-radius:var(--radius-full);background:var(--gray-1000);color:var(--background-100);font-size:12px;line-height:20px;font-weight:600;text-align:center}
.nav .count:empty{display:none}
.side-foot{display:flex;flex-direction:column;gap:2px;padding:12px 16px;font-size:12px;line-height:16px;color:var(--gray-900);box-shadow:inset 0 1px 0 var(--gray-alpha-400)}
.side-foot .who{color:var(--gray-1000);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
main{min-width:0;padding:32px 40px 64px}
.page{max-width:1200px}

/* ---- page head ---- */
.ph{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;margin:0 0 24px}
.ph h1{font-size:24px;line-height:32px;letter-spacing:-0.02em}
.ph .sub{margin-top:4px;color:var(--gray-900)}
.ph .acts{margin-left:auto;display:flex;gap:8px}
.crumb{display:inline-flex;margin-bottom:8px;font-size:13px;color:var(--gray-900);text-decoration:none}
.crumb:hover{color:var(--gray-1000)}

/* ---- stats (console .stats) ---- */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin:0 0 24px;border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-small);overflow:hidden}
.stat{display:flex;flex-direction:column;gap:4px;min-width:0;padding:16px var(--card-pad) 18px;box-shadow:1px 0 0 var(--gray-400),0 1px 0 var(--gray-400);color:inherit;text-decoration:none}
a.stat:hover{background:var(--gray-alpha-100)}
.stat .lbl{font-size:13px;line-height:18px;color:var(--gray-900)}
.stat .big{font-size:28px;line-height:36px;font-weight:600;letter-spacing:-0.02em;font-variant-numeric:tabular-nums}
.stat .sub{font-size:12px;line-height:16px;color:var(--gray-900)}
.stat.hot{background:var(--gray-1000);color:var(--background-100)}
.stat.hot .lbl,.stat.hot .sub{color:var(--background-100);opacity:.8}
a.stat.hot:hover{background:var(--gray-800)}

/* ---- cards ---- */
.card{margin:0 0 24px;border-radius:var(--radius-md);background:var(--background-100);box-shadow:var(--shadow-border);overflow:hidden}
.card-h{display:flex;align-items:center;gap:12px;min-height:52px;padding:0 var(--card-pad);box-shadow:inset 0 -1px 0 var(--gray-alpha-400)}
.card-h h2{font-size:14px;line-height:20px}
.card-h .more{margin-left:auto;font-size:13px;color:var(--gray-900);text-decoration:none}
.card-h .more:hover{color:var(--gray-1000)}
.card-b{padding:16px var(--card-pad)}
.card.danger{box-shadow:inset 0 0 0 1px var(--red-700)}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:0 24px}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:8px 20px;margin:0}
.kv dt{color:var(--gray-900)}
.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}

/* ---- tables ---- */
.tbl-wrap{overflow-x:auto}
.tbl{width:100%;border-collapse:separate;border-spacing:0}
.tbl th{height:36px;padding:0 12px;text-align:left;vertical-align:middle;color:var(--gray-900);font-size:12px;line-height:16px;font-weight:500;white-space:nowrap;box-shadow:inset 0 -1px 0 var(--gray-alpha-400)}
.tbl td{height:48px;padding:8px 12px;vertical-align:middle;box-shadow:inset 0 -1px 0 var(--gray-alpha-400)}
.tbl th:first-child,.tbl td:first-child{padding-left:var(--card-pad)}
.tbl th:last-child,.tbl td:last-child{padding-right:var(--card-pad)}
.tbl tbody tr:last-child td{box-shadow:none}
.tbl tr.rl{cursor:pointer}
.tbl tr.rl:hover td{background:var(--gray-alpha-100)}
.tbl .r{text-align:right;font-variant-numeric:tabular-nums}
.tbl td.act{text-align:right;white-space:nowrap}
.tbl td.act .btn+.btn{margin-left:8px}
.tbl .none td{height:64px;text-align:center;color:var(--gray-900)}
.nm{font-weight:500}
.sub2{display:block;font-size:12px;line-height:16px;color:var(--gray-900)}
.nowrap{white-space:nowrap}

/* ---- status: mono dot + words (console .dot) ---- */
.st{display:inline-flex;align-items:center;gap:8px;white-space:nowrap}
.dot{width:6px;height:6px;border-radius:50%;background:var(--gray-1000);flex:none}
.dot.off{background:transparent;box-shadow:inset 0 0 0 1.5px var(--gray-600)}
.dot.wait{background:linear-gradient(90deg,var(--gray-1000) 50%,transparent 50%);box-shadow:inset 0 0 0 1px var(--gray-1000)}
.dot.bad{width:8px;height:8px;border-radius:0;background:linear-gradient(45deg,transparent 40%,var(--gray-1000) 40% 60%,transparent 60%),linear-gradient(-45deg,transparent 40%,var(--gray-1000) 40% 60%,transparent 60%)}
.pill{display:inline-flex;align-items:center;min-height:20px;padding:0 8px;border-radius:var(--radius-full);background:var(--gray-100);font-size:12px;line-height:16px;font-weight:500;white-space:nowrap}
.pill.solid{background:var(--gray-1000);color:var(--background-100)}
.addr{font-family:var(--font-mono);font-size:12.5px;white-space:nowrap}

/* ---- review: queue + detail ---- */
.split{display:grid;grid-template-columns:minmax(280px,360px) minmax(0,1fr);gap:24px;align-items:start}
.qlist{list-style:none;margin:0;padding:4px;border-radius:var(--radius-md);box-shadow:var(--shadow-border)}
.qrow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;width:100%;padding:12px;border:0;border-radius:var(--radius-sm);background:transparent;text-align:left;cursor:pointer}
.qrow:hover{background:var(--gray-alpha-100)}
.qrow[aria-current="true"]{background:var(--gray-alpha-200)}
.qrow .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qrow .em{grid-column:1;font-size:13px;line-height:18px;color:var(--gray-900);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qrow .t{grid-row:1;grid-column:2;font-size:12px;color:var(--gray-900);white-space:nowrap}
.qrow .n{grid-column:2;font-size:12px;color:var(--gray-900);text-align:right;white-space:nowrap}
.panel{position:sticky;top:calc(var(--header-h) + 24px)}
.panel .card{margin-bottom:16px}
.pan-h{display:flex;align-items:flex-start;gap:16px;padding:20px var(--card-pad);box-shadow:inset 0 -1px 0 var(--gray-alpha-400)}
.pan-h h2{font-size:20px;line-height:28px;letter-spacing:-0.01em}
.pan-h .em{margin-top:2px;color:var(--gray-900)}
.decide{display:flex;gap:8px;align-items:center;padding:16px var(--card-pad);background:var(--background-200);box-shadow:inset 0 1px 0 var(--gray-alpha-400)}
.decide .hint{margin-right:auto;font-size:13px;color:var(--gray-900)}
.sec{padding:16px var(--card-pad);box-shadow:inset 0 -1px 0 var(--gray-alpha-400)}
.sec:last-child{box-shadow:none}
.sec h3{margin:0 0 10px;font-size:12px;line-height:16px;font-weight:500;color:var(--gray-900)}
.lines{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.lines li{display:flex;align-items:center;gap:12px;min-width:0}
.lines li .grow{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{padding:48px 24px;text-align:center;color:var(--gray-900)}
.empty strong{display:block;margin-bottom:4px;color:var(--gray-1000);font-size:16px;line-height:24px;font-weight:600}

/* ---- weekly board (202610010900) ---- */
.lad{display:flex;flex-direction:column;gap:2px}
.lad .big{font-size:28px;line-height:36px;font-weight:600;letter-spacing:-0.02em}
.ids{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.tbl-wrap.wrap .tbl td{white-space:normal}
.lines.wrap li .grow{white-space:normal;overflow:visible}
.verdict{min-height:44px;padding:12px;border-radius:var(--radius-sm);box-shadow:inset 0 0 0 1px var(--gray-alpha-400);color:var(--gray-900)}

/* ---- controls ---- */
.row{display:flex;gap:8px 12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:16px}
.row label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--gray-900)}
input[type=text],input[type=search],input[type=number],input[type=date],select{height:36px;padding:0 12px;border:0;border-radius:var(--radius-sm);background:var(--background-100);color:var(--gray-1000);box-shadow:inset 0 0 0 1px var(--gray-500);min-width:0}
input:hover,select:hover{box-shadow:inset 0 0 0 1px var(--gray-600)}
input:focus,select:focus{box-shadow:inset 0 0 0 1px var(--gray-1000)}
input[type=search]{width:280px;max-width:100%}
input[type=number]{width:120px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border:0;border-radius:var(--radius-sm);background:var(--gray-1000);color:var(--background-100);font-weight:500;white-space:nowrap;cursor:pointer;text-decoration:none;transition:background-color var(--dur-fast) ease}
.btn:hover{background:var(--gray-800)}
.btn.ghost{background:var(--background-100);color:var(--gray-1000);box-shadow:inset 0 0 0 1px var(--gray-500)}
.btn.ghost:hover{background:var(--gray-alpha-100)}
.btn.danger{background:var(--background-100);color:var(--red-700);box-shadow:inset 0 0 0 1px var(--red-700)}
.btn.danger:hover{background:var(--red-alpha)}
.btn.danger.solid{background:var(--red-solid);color:var(--on-red);box-shadow:none}
.btn.sm{height:28px;padding:0 10px;font-size:13px}
.btn:disabled{background:var(--gray-100);color:var(--gray-600);box-shadow:none;cursor:not-allowed}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.msg{margin:8px 0;font-size:13px}
.msg:empty{margin:0}
.msg.err{color:var(--red-700);font-weight:500}
.over{font-weight:600;text-decoration:underline;text-decoration-color:var(--red-700);text-underline-offset:3px}
.note{font-size:13px;line-height:18px;color:var(--gray-900)}
.toast{position:fixed;right:24px;bottom:24px;z-index:var(--z-toast);max-width:min(480px,calc(100vw - 32px));padding:12px 16px;border-radius:var(--radius-md);background:var(--gray-1000);color:var(--background-100);box-shadow:var(--shadow-menu);font-size:13px}
.toast.err{background:var(--red-solid);color:var(--on-red)}
dialog{max-width:480px;width:calc(100% - 32px);padding:0;border:0;border-radius:var(--radius-lg);background:var(--background-raised);color:var(--gray-1000);box-shadow:var(--shadow-modal)}
dialog::backdrop{background:var(--scrim)}
dialog .body{padding:24px}
dialog h2{font-size:18px;line-height:24px;margin-bottom:8px}
dialog.danger h2{color:var(--red-700)}
dialog ul{margin:0 0 20px;padding-left:18px;font-size:13px;line-height:20px;color:var(--gray-900)}
dialog label{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;font-size:13px;color:var(--gray-900)}
dialog input[type=text]{width:100%}
.expect{align-self:flex-start;padding:2px 8px;border-radius:var(--radius-xs);background:var(--gray-100);color:var(--gray-1000);white-space:pre-wrap;font-size:13px}
dialog .foot{display:flex;justify-content:flex-end;gap:8px;padding:16px 24px;background:var(--background-200);box-shadow:inset 0 1px 0 var(--gray-alpha-400)}

/* ---- hosted: login + session foot ---- */
.login{max-width:400px;margin:12vh auto 64px;padding:0 16px}
.login .logo{margin-bottom:24px}
.login h1{font-size:20px;line-height:28px;margin-bottom:4px}
.login label{display:flex;flex-direction:column;gap:6px;margin:16px 0 12px;font-size:13px;color:var(--gray-900)}
.login input{width:100%}
.login .btn{width:100%}
.login .note{margin-top:12px}
.login .btn.ghost{margin-top:8px}
.login .note:empty{display:none}
.side-foot .out{align-self:flex-start;margin-top:6px;padding:0;border:0;background:none;color:var(--gray-900);font-size:12px;text-decoration:underline;text-decoration-color:var(--gray-500);text-underline-offset:3px;cursor:pointer}
.side-foot .out:hover{color:var(--gray-1000)}
.ref{font-family:var(--font-mono);font-weight:600;letter-spacing:.08em}

/* ---- narrow ---- */
@media (max-width:1100px){.split{grid-template-columns:minmax(0,1fr)}.panel{position:static}main{padding:24px 24px 64px}}
@media (max-width:767px){
  .top{padding:0 16px;gap:8px}
  .top .target{max-width:56vw}
  .frame{display:block}
  .side{position:sticky;top:var(--header-h);z-index:var(--z-sticky);height:auto;flex-direction:row;overflow-x:auto;scrollbar-width:none;box-shadow:inset 0 -1px 0 var(--gray-alpha-400)}
  .side::-webkit-scrollbar{display:none}
  .nav{flex-direction:row;padding:6px 8px;gap:2px}
  .nav a{height:36px;padding:0 10px}
  .nav a .ico{display:none}
  .side-foot{display:none}
  main{padding:20px 16px 64px}
  .ph h1{font-size:20px;line-height:28px}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .stat .big{font-size:22px;line-height:28px}
  .cols{grid-template-columns:minmax(0,1fr)}
  .kv{gap:8px 12px}
  .stats.lead .stat:first-child{grid-column:1/-1}
  .tbl td{white-space:nowrap}
  .decide{flex-wrap:wrap}
  .decide .hint{flex-basis:100%}
  .hide-sm{display:none}
}
`;

const icon = (paths: string): string =>
  `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`;

type NavItem = readonly [string, string, string, string];

const NAV_ITEMS: Readonly<Record<string, NavItem>> = {
  home: ['home', '#/', '대시보드', icon('<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>')],
  board: ['board', '#/board', '주간 운영판', icon('<path d="M2.5 13.5h11"/><path d="M4 11V8M7 11V4.5M10 11V6.5M13 11V9"/>')],
  review: ['review', '#/review', '가입 검토', icon('<path d="M2 9.5h3.5l1 2h3l1-2H14"/><path d="M3.5 3h9L14 9.5V13H2V9.5z"/>')],
  waitlist: ['waitlist', '#/waitlist', '대기자 명단', icon('<path d="M3 3.5h10M3 8h10M3 12.5h6"/><circle cx="12.5" cy="12.5" r="1.5"/>')],
  orgs: ['orgs', '#/orgs', '조직', icon('<path d="M3 14V3h6v11"/><path d="M9 7h4v7"/><path d="M1.5 14h13"/><path d="M5 5.5h2M5 8h2M5 10.5h2"/>')],
  plans: ['plans', '#/plans', '요금제', icon('<rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="M1.5 6.5h13M4 10h3"/>')],
  kill: ['kill', '#/kill', '긴급 정지', icon('<path d="M5.5 1.5h5l4 4v5l-4 4h-5l-4-4v-5z"/><path d="M6 6v4M10 6v4"/>')],
  ops: ['ops', '#/ops', '운영자', icon('<circle cx="6" cy="5" r="2.5"/><path d="M1.5 13.5c.5-2.5 2.3-4 4.5-4s4 1.5 4.5 4"/><path d="M10.5 3a2.5 2.5 0 0 1 0 4.5M12.5 9.8c1 .7 1.7 2 2 3.7"/>')],
  audit: ['audit', '#/audit', '감사 로그', icon('<path d="M4 2.5h8M4 6h8M4 9.5h8M4 13h5"/>')],
};

/** 로컬 화면 — 전부. 호스팅(P1) — 요금제·긴급 정지 화면이 없고 운영자 관리가 있다. */
const LOCAL_NAV = ['home', 'board', 'review', 'waitlist', 'orgs', 'plans', 'kill', 'audit'] as const;
const HOSTED_NAV = ['home', 'board', 'review', 'waitlist', 'orgs', 'ops', 'audit'] as const;

const PENDING_BADGE: Readonly<Record<string, string>> = { review: 'nav-pending', ops: 'nav-ops-pending' };

function navHtml(keys: readonly string[]): string {
  return keys
    .map((key) => NAV_ITEMS[key] as NavItem)
    .map(([key, href, label, svg]) => `<li><a href="${href}" data-nav="${key}">${svg}<span>${label}</span>${PENDING_BADGE[key] === undefined ? '' : `<span class="count" id="${PENDING_BADGE[key]}"></span>`}</a></li>`)
    .join('');
}

const CONFIRM_DIALOG = `<dialog id="confirm" aria-labelledby="c-title">
<div class="body">
<h2 id="c-title"></h2>
<ul id="c-lines"></ul>
<label><span id="c-name-label"></span><code id="c-expect" class="expect"></code><input type="text" id="c-name" autocomplete="off" spellcheck="false"></label>
<label id="c-ack-wrap"><span>되돌릴 수 없다. CONFIRM 입력</span><input type="text" id="c-ack" autocomplete="off" spellcheck="false"></label>
<label id="c-reason-wrap" hidden><span>사유(한 줄 · 감사와 조직의 투명성 로그에 남는다)</span><input type="text" id="c-reason" maxlength="500" autocomplete="off"></label>
<p id="c-msg" class="msg err" role="alert"></p>
</div>
<div class="foot"><button type="button" class="btn ghost" id="c-cancel">취소</button><button type="button" class="btn" id="c-run">실행</button></div>
</dialog>`;

/** 호스팅만 — 본인 확인(step-up) 대화상자. 메일과 같은 참조(`target_ref`)를 보인다. */
const STEP_UP_DIALOG = `<dialog id="stepup" aria-labelledby="s-title">
<div class="body">
<h2 id="s-title">본인 확인</h2>
<ul><li id="s-what"></li><li>메일로 보낸 6자리 코드를 입력하세요.</li><li>메일의 참조가 <span class="ref" id="s-ref"></span> 인지 확인하세요.</li></ul>
<label><span>코드</span><input type="text" id="s-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" spellcheck="false"></label>
<p id="s-msg" class="msg err" role="alert"></p>
</div>
<div class="foot"><button type="button" class="btn ghost" id="s-cancel">취소</button><button type="button" class="btn" id="s-run">확인</button></div>
</dialog>`;

function bodyHtml(hosted: boolean): string {
  const foot = hosted
    ? '<div class="side-foot"><span class="who" id="actor"></span><span id="session"></span><button type="button" class="out" id="logout">로그아웃</button></div>'
    : '<div class="side-foot"><span class="who" id="actor"></span><span id="session"></span></div>';
  return `<header class="top">
<a class="logo" href="#/">${brandLockupSvg({ className: 'brand', height: 18 })}<span class="tag">운영</span></a>
<span class="grow"></span>
<span id="target" class="target"></span>
</header>
${hosted ? '<section id="login" class="login" hidden></section>\n' : ''}<div class="frame"${hosted ? ' id="frame" hidden' : ''}>
<nav class="side" aria-label="화면">
<ul class="nav">${navHtml(hosted ? HOSTED_NAV : LOCAL_NAV)}</ul>
${foot}
</nav>
<main id="view" aria-live="polite"><p class="muted">불러오는 중…</p></main>
</div>
${CONFIRM_DIALOG}
${hosted ? `${STEP_UP_DIALOG}\n` : ''}<div id="toast" class="toast" role="status" hidden></div>`;
}

export const OPS_JS = String.raw`(function(){
'use strict';
var TOKEN_KEY='atmark.ops.token';
var TOKEN='';
var TOKEN_AUTH=CFG.auth==='fragment-token';
/* cookie-csrf (hosted ops.atmark.ai): HttpOnly __Host- session cookie + CSRF header from /session; login by email code */
var HOSTED=CFG.auth==='cookie-csrf';
var CSRF='';
var ME='';
/* fragment-token: the bootstrap redirect hands the session token once in the fragment (#t=...): move it to sessionStorage (origin = this port) and wipe it from the address bar */
if(TOKEN_AUTH)(function(){var m=/^#t=([A-Za-z0-9_-]{43})$/.exec(location.hash);try{if(m){sessionStorage.setItem(TOKEN_KEY,m[1]);}TOKEN=sessionStorage.getItem(TOKEN_KEY)||'';}catch(e){if(m)TOKEN=m[1];}if(m)history.replaceState(null,'',location.pathname+'#/');})();
var BILLING_OP=false;
var view=document.getElementById('view');
function h(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined&&text!==null)e.textContent=String(text);return e;}
function add(parent){for(var i=1;i<arguments.length;i++){var c=arguments[i];if(c===null||c===undefined||c===false)continue;parent.appendChild(typeof c==='string'?document.createTextNode(c):c);}return parent;}
function clear(e){while(e.firstChild)e.removeChild(e.firstChild);}
function pad(n){return (n<10?'0':'')+n;}
function when(v){if(!v)return '-';var d=new Date(v);if(isNaN(d.getTime()))return String(v);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes());}
function ago(v){if(!v)return '-';var d=new Date(v);if(isNaN(d.getTime()))return String(v);var s=Math.round((Date.now()-d.getTime())/1000);if(s<60)return '방금';var m=Math.round(s/60);if(m<60)return m+'분 전';var hr=Math.round(m/60);if(hr<24)return hr+'시간 전';var dd=Math.round(hr/24);if(dd<8)return dd+'일 전';return when(v).slice(0,10);}
function num(n){return Number(n||0).toLocaleString('ko-KR');}
function link(href,text,cls){var a=h('a',cls||null,text);a.href=href;return a;}
function btn(text,cls,fn){var b=h('button','btn sm '+(cls||''),text);b.type='button';b.addEventListener('click',function(e){e.stopPropagation();fn();});return b;}
function bigBtn(text,cls,fn){var b=btn(text,cls,fn);b.className='btn '+(cls||'');return b;}
function authHeaders(){var x={};if(TOKEN_AUTH)x['x-ops-token']=TOKEN;if(HOSTED&&CSRF)x['x-atmark-ops-csrf']=CSRF;return x;}
function api(method,path,body){
  var opt={method:method,headers:authHeaders(),credentials:TOKEN_AUTH?'omit':'same-origin',cache:'no-store'};
  if(body!==undefined){opt.headers['content-type']='application/json';opt.body=JSON.stringify(body);}
  return fetch(CFG.apiBase+path,opt).then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok){var e=new Error(msgOf(j,r.status));e.code=j.error;e.status=r.status;if(HOSTED&&r.status===401&&j.error==='session_invalid'&&path!=='/session')showLogin();throw e;}return j;});});
}
var MSG={confirmation_required:'확인 입력이 맞지 않습니다. 그대로 다시 입력하세요.',code_invalid:'코드가 맞지 않거나 만료됐습니다. 다시 확인하세요.',rate_limited:'요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.',ticket_cap:'요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.',action_cap:'이 작업의 한도에 닿았습니다. 나중에 다시 시도하세요.',ops_disabled:'운영 콘솔이 닫혀 있습니다.',ops_unavailable:'운영 콘솔을 지금 쓸 수 없습니다. 잠시 뒤 다시 시도하세요.',session_invalid:'다시 로그인하세요.',self_decision:'자기 요청은 결정할 수 없습니다.',last_operator:'마지막 운영자는 폐기할 수 없습니다.',cli_operator:'CLI로 등록한 운영자는 CLI에서 폐기하세요.',not_requested:'이미 결정된 요청입니다.',invalid_transition:'지금 상태에서는 할 수 없습니다.',forbidden:'권한이 없습니다.',step_up_required:'본인 확인이 필요합니다.',csrf_mismatch:'다시 로그인하세요.',ticket_violation:'처리하지 못했습니다. 잠시 뒤 다시 시도하세요.',internal_error:'처리하지 못했습니다. 잠시 뒤 다시 시도하세요.',organization_not_found:'조직을 찾을 수 없습니다.',operator_not_found:'운영자를 찾을 수 없습니다.',entry_not_found:'대기 항목을 찾을 수 없습니다.',already_joined:'이미 가입한 항목입니다.',invite_cap:'오늘 초대 한도에 닿았습니다.',remove_cap:'오늘 지우기 한도에 닿았습니다.',invalid_count:'1~50 사이의 수를 입력하세요.'};
function msgOf(j,status){return (HOSTED&&MSG[j.error])||j.detail||j.error||('HTTP '+status);}
var toastTimer=null;
function toast(text,err){var t=document.getElementById('toast');t.textContent=text;t.className='toast'+(err?' err':'');t.hidden=false;if(toastTimer)clearTimeout(toastTimer);toastTimer=setTimeout(function(){t.hidden=true;},6000);}
function cell(td,c){if(c instanceof Node)add(td,c);else td.textContent=(c===null||c===undefined||c==='')?'-':String(c);}
/* heads: [label, cls]; rows: {cells:[...], href?} */
function table(heads,rows,emptyText){
  var wrap=h('div','tbl-wrap');var t=h('table','tbl');var thead=h('thead');var tr=h('tr');
  heads.forEach(function(x){var th=h('th',Array.isArray(x)?x[1]:null,Array.isArray(x)?x[0]:x);add(tr,th);});add(thead,tr);add(t,thead);
  var tb=h('tbody');
  rows.forEach(function(row){var cells=row.cells||row;var r=h('tr',row.href?'rl':null);if(row.href)r.addEventListener('click',function(){location.hash=row.href;});
    cells.forEach(function(c,i){var hd=heads[i];var td=h('td',Array.isArray(hd)?hd[1]:null);cell(td,c);add(r,td);});add(tb,r);});
  if(rows.length===0){var r=h('tr','none');var td=h('td',null,emptyText||'없다');td.colSpan=heads.length;add(r,td);add(tb,r);}
  add(t,tb);add(wrap,t);return wrap;
}
function kv(pairs){var dl=h('dl','kv');pairs.forEach(function(p){add(dl,h('dt',null,p[0]));var dd=h('dd');cell(dd,p[1]);add(dl,dd);});return dl;}
function card(title,moreHref,moreText){var c=h('section','card');if(title){var hd=h('div','card-h');add(hd,h('h2',null,title));if(moreHref)add(hd,link(moreHref,moreText||'전부 보기','more'));add(c,hd);}return c;}
function body(c){var b=h('div','card-b');add(c,b);return b;}
function head(title,sub,crumb){var d=h('div','ph');var l=h('div');if(crumb)add(l,link(crumb[0],crumb[1],'crumb'));add(l,h('h1',null,title));if(sub)add(l,h('p','sub',sub));add(d,l);return d;}
function page(){clear(view);var p=h('div','page');add(view,p);return p;}
function fail(e){var p=page();add(p,h('p','msg err',e.message||String(e)));}
/* address; the @ keeps the surrounding text color (monochrome brand) */
function addr(a){var s=h('span','addr');if(!a){s.textContent='-';return s;}var i=a.indexOf('@');if(i<0){s.textContent=a;return s;}add(s,a.slice(0,i),h('span','at','@'),a.slice(i+1));return s;}
var REVIEW={pending_review:['검토 대기','wait'],active:['승인됨',''],rejected:['거절됨','off']};
var AGENT={provisioning:['준비 중','wait'],active:['활성',''],suspended:['정지','bad'],disabled:['비활성','off']};
var SOURCE={self_signup:'직접 가입',operator:'운영자 생성'};
function st(map,key,extra){var m=map[key]||[key,'off'];var s=h('span','st');add(s,h('span','dot'+(m[1]?' '+m[1]:'')),h('span',null,m[0]+(extra||'')));return s;}
function setPending(n){var c=document.getElementById('nav-pending');c.textContent=n>0?String(n):'';}

/* ---------- confirm dialog ---------- */
var dlg=document.getElementById('confirm');
var cName=document.getElementById('c-name');var cAck=document.getElementById('c-ack');var cReason=document.getElementById('c-reason');var cMsg=document.getElementById('c-msg');var cRun=document.getElementById('c-run');
var pending=null;
function confirmThen(opts){
  document.getElementById('c-title').textContent=opts.title;
  var ul=document.getElementById('c-lines');clear(ul);opts.lines.forEach(function(l){add(ul,h('li',null,l));});
  document.getElementById('c-name-label').textContent=opts.label||(opts.destructive?'조직 id 앞 8자리를 입력':'조직 이름을 그대로 입력');
  opts.expect=opts.expect||(opts.destructive?opts.id.slice(0,8):opts.name);
  document.getElementById('c-expect').textContent=opts.expect;
  cName.value='';cAck.value='';cReason.value='';cMsg.textContent='';
  document.getElementById('c-ack-wrap').hidden=!opts.destructive||!!opts.noAck;
  document.getElementById('c-reason-wrap').hidden=!opts.reason;
  dlg.className=opts.destructive?'danger':'';
  cRun.className='btn'+(opts.destructive?' danger solid':'');cRun.textContent=opts.runLabel||'실행';cRun.disabled=false;
  pending=opts;dlg.showModal();cName.focus();
}
document.getElementById('c-cancel').addEventListener('click',function(){pending=null;dlg.close();});
cRun.addEventListener('click',function(){
  if(!pending)return;var opts=pending;cMsg.textContent='';
  /* hosted: check the typed target before spending a step-up code (the server checks again) */
  if(HOSTED){var typed=cName.value.trim().normalize('NFC').toLowerCase();if(typed!==String(opts.expect).normalize('NFC').toLowerCase()||(opts.destructive&&!opts.noAck&&cAck.value!=='CONFIRM')){cMsg.textContent=MSG.confirmation_required;return;}}
  if(opts.reason==='required'&&cReason.value.trim()===''){cMsg.textContent='사유를 적어 주세요.';return;}
  cRun.disabled=true;
  opts.run(cName.value,cAck.value,cReason.value.trim()).then(function(res){pending=null;dlg.close();toast(opts.done(res));route();},function(e){cRun.disabled=false;cMsg.textContent=e.message||String(e);});
});
/* ---------- step-up (hosted): DB enforces it; the page asks for the mailed code and shows the same reference as the mail ---------- */
var ACTION={'org.activate':'가입 승인','org.reject':'가입 거절','operator.approve':'운영자 승인','operator.deny':'운영자 요청 거절','operator.revoke':'운영자 폐기'};
var ONCE={'org.reject':1,'operator.approve':1,'operator.deny':1,'operator.revoke':1};
function stepUp(action,target,label){
  return api('POST','/auth/step-up',{action:action,org:target.org,operator:target.operator}).then(function(r){
    return new Promise(function(resolve,reject){
      var d=document.getElementById('stepup');var code=document.getElementById('s-code');var msg=document.getElementById('s-msg');var run=document.getElementById('s-run');var cancel=document.getElementById('s-cancel');
      document.getElementById('s-what').textContent=(ACTION[action]||action)+': '+label;
      document.getElementById('s-ref').textContent=r.targetRef;
      code.value='';msg.textContent='';run.disabled=false;
      function done(){run.removeEventListener('click',go);cancel.removeEventListener('click',stop);d.removeEventListener('cancel',stop);code.removeEventListener('keydown',key);d.close();}
      function stop(e){if(e&&e.preventDefault)e.preventDefault();done();reject(new Error('본인 확인을 취소했습니다.'));}
      function go(){run.disabled=true;msg.textContent='';api('POST','/auth/step-up/verify',{code:code.value.trim()}).then(function(){done();resolve();},function(e){run.disabled=false;msg.textContent=e.message;});}
      function key(e){if(e.key==='Enter')go();}
      run.addEventListener('click',go);cancel.addEventListener('click',stop);d.addEventListener('cancel',stop);code.addEventListener('keydown',key);
      d.showModal();code.focus();
    });
  });
}
/* once: fresh code every time. window (org.activate): try first, ask only when the DB says step_up_required */
function withStepUp(action,target,label,fn){
  if(!HOSTED)return fn();
  var again=function(e){if(e.code!=='step_up_required')throw e;return stepUp(action,target,label).then(fn);};
  if(ONCE[action])return stepUp(action,target,label).then(fn).catch(again);
  return fn().catch(again);
}
function reviewDialog(o,decision){
  confirmThen({
    title:decision==='activate'?'가입 승인':'가입 거절',runLabel:decision==='activate'?'승인':'거절',
    lines:decision==='activate'?[o.name+' 조직의 외부 발송이 열립니다.','베타 기간이라 요금제 행이 없으면 beta 를 줍니다.']:['모든 에이전트를 운영자 정지합니다.','살아 있는 토큰을 전부 폐기합니다. 되돌릴 수 없습니다.'],
    name:o.name,id:o.id,destructive:decision==='reject',
    run:function(name,ack){return withStepUp(decision==='activate'?'org.activate':'org.reject',{org:o.id},o.name,function(){return api('POST','/orgs/'+o.id+'/review',{decision:decision,confirm:name,ack:ack});});},
    done:function(r){var x=r.outcome;if(!x.changed)return '이미 그 상태입니다.';if(decision==='activate'){return '승인했습니다'+(x.plan&&x.plan.granted?(' · 요금제 beta'):'')+'.';}return '거절했습니다 · 정지 '+x.suspended.length+' · 토큰 폐기 '+x.revokedTokens+'.';}
  });
}
function freezeDialog(o,on){
  confirmThen({title:on?'조직 발송 정지':'조직 정지 풀기',runLabel:on?'정지':'풀기',lines:on?[o.name+' 의 모든 에이전트 발송을 막는다.','소유자는 풀 수 없다.']:[o.name+' 의 발송을 다시 연다.','평판 자동 동결이었다면 원인을 정리했는지 확인한다 — 이 뒤의 반송 · 신고만 다시 센다.'],name:o.name,id:o.id,destructive:on,
    reason:on?'optional':'required',
    run:function(name,ack,reason){return api('POST','/orgs/'+o.id+'/freeze',{on:on,confirm:name,ack:ack,reason:reason});},
    done:function(r){return r.result&&!r.result.changed?'이미 그 상태다.':(on?'조직을 정지했다.':'조직 정지를 풀었다.');}});
}
function agentDialog(orgName,a,on){
  confirmThen({title:on?'에이전트 정지':'에이전트 정지 풀기',runLabel:on?'정지':'풀기',lines:[(a.address||a.name)+(on?' 을 정지한다(운영자 정지 — 소유자는 풀 수 없다).':' 을 다시 연다.')],name:orgName,destructive:false,
    run:function(name){return api('POST','/agents/'+a.id+'/suspend',{on:on,confirm:name});},
    done:function(r){return r.result.changed?('에이전트 '+(on?'정지':'재개')+'.'):'이미 그 상태다.';}});
}

/* ---------- dashboard ---------- */
function stat(label,value,sub,href,hot){var s=h(href?'a':'div','stat'+(hot?' hot':''));if(href)s.href=href;add(s,h('span','lbl',label),h('span','big',num(value)),sub?h('span','sub',sub):null);return s;}
function dashboard(){
  return api('GET','/dashboard').then(function(j){
    setPending(j.organizations.pendingReview);
    var p=page();add(p,head('대시보드',null));
    var s=h('div','stats lead');
    add(s,stat('검토 대기',j.organizations.pendingReview,j.organizations.pendingReview>0?'검토하기 →':'비었다','#/review',j.organizations.pendingReview>0),
      stat('활성 조직',j.organizations.active,j.organizations.frozen>0?('정지 '+num(j.organizations.frozen)):null,'#/orgs'),
      stat('에이전트',j.agents.active,'정지 '+num(j.agents.suspended)+' · 준비 '+num(j.agents.provisioning)),
      stat('가입 24시간',j.signups.day,null),
      stat('가입 7일',j.signups.week,null));
    add(p,s);
    var cols=h('div','cols');
    var rc=card('최근 가입','#/orgs','조직 전부');
    add(rc,table(['조직',['상태','nowrap'],['가입','nowrap']],j.recentSignups.map(function(o){
      var n=h('div');add(n,h('span','nm',o.name),h('span','sub2',o.ownerEmail||'-'));
      return {cells:[n,st(REVIEW,o.reviewStatus),ago(o.createdAt)],href:o.reviewStatus==='pending_review'?('#/review/'+o.id):('#/org/'+o.id)};
    }),'아직 가입이 없다'));
    var sc=card('발송','#/audit','감사 로그');
    var d=j.sending.day,w=j.sending.week;
    add(sc,table(['',['24시간','r'],['7일','r']],[['보냄',num(d.sent),num(w.sent)],['정책 거부',num(d.denied),num(w.denied)],['실패',num(d.failed),num(w.failed)],['대기·보내는 중',num(d.queued),num(w.queued)],['받음',num(d.received),num(w.received)]]));
    add(cols,rc,sc);add(p,cols);
  });
}

/* ---------- weekly board (202610010900): read-only. Thresholds, the volume floor and the <20 no-percent rule live on the server (ratio.pct is null below 20); the page only draws ---------- */
var LADDER={L0:'L0 이상 없음',L1:'L1 검토',L2:'L2 초대 동결',insufficient:'판정 불가 / insufficient volume'};
var SIG={fired:['넘음','bad'],clear:['아님',''],insufficient:['판정 불가','off'],not_evaluated:['해당 없음','off'],unobserved:['미관측','off']};
function ratioText(r){if(!r)return '-';return r.n+'/'+r.d+(r.pct===null||r.pct===undefined?'':' ('+r.pct+'%)');}
function ids(list){var d=h('div','ids');list.forEach(function(id){add(d,h('code',null,id));});return d;}
function board(){
  return api('GET','/board').then(function(j){
    var g=j.guardrail;var v=g.volume;
    var p=page();add(p,head('주간 운영판','매주 금요일 30분 · 읽기 전용 · 기준 '+when(j.at)));
    var s=h('div','stats lead');
    var lv=h('div','stat'+(g.verdict==='L1'||g.verdict==='L2'?' hot':''));
    add(lv,h('span','lbl','평판 사다리'),h('span','big',LADDER[g.verdict]||g.verdict),h('span','sub','L3 신호는 아래 수동 확인'));
    add(s,lv,
      stat('외부 발신 7일',v.d7,'판정 분모'),
      stat('외부 발신 14일',v.d14,'하한 '+v.floor14d+(g.belowFloor?' 미달':' 넘음')),
      stat('외부 발신 28일',v.d28,'런칭 하한 '+v.floor28d+(v.launchFloorMet?' 넘음':' 미달')));
    add(p,s);
    var gc=card('가드레일');
    /* the guardrail is what the founder reads first: let it wrap on phones instead of scrolling sideways */
    var gt=table(['신호',['단계','nowrap'],['상태','nowrap'],'관측'],g.signals.map(function(x){
      var val=h('div');add(val,h('span',null,x.value));if(x.organizations.length)add(val,ids(x.organizations));
      return [x.label,x.level,st(SIG,x.status),val];
    }),'신호가 없다');
    gt.className='tbl-wrap wrap';add(gc,gt);
    add(body(gc),h('p','note','하나라도 넘으면 나머지를 보기 전에 동결 규칙부터 집행한다. 0건은 외부 발신량과 함께 읽는다(14일 '+v.floor14d+'통 미만이면 판정 불가).'));
    add(p,gc);
    var mc=card('수동 확인 (계산하지 않는다)');
    var ml=h('ul','lines wrap');
    g.manual.forEach(function(m){
      var li=h('li');add(li,h('span','pill',m.level),h('span','grow',m.label));
      if(m.url&&/^https:\/\//.test(m.url)){var a=link(m.url,'열기','small');a.target='_blank';a.rel='noopener noreferrer';add(li,a);}
      add(ml,li);
    });
    add(body(mc),ml);add(p,mc);
    var n=j.northStar;
    var nc=card('북극성 · 주간 수신 활성 조직');
    add(body(nc),kv([['글로벌',num(n.global)+'곳'],['Beta',num(n.beta)+'곳'],['기준','최근 7일에 외부 발신자 메일을 받고 그 뒤 그 에이전트 토큰이 쓰인 조직 · 내부 조직 '+n.internalExcluded+'곳 제외']]));
    add(p,nc);
    var cc=card('코호트 · 초대 주차 (n/N)');
    var rows=[];
    j.cohorts.rows.forEach(function(r){
      var wk=h('div');add(wk,h('span','nm',r.week));if(r.windowOpen)add(wk,' ',h('span','pill','창 미종료'));
      var gl=r.global;
      rows.push([wk,num(r.invited),ratioText(gl.signedUp),ratioText(gl.agent),ratioText(gl.mcp),ratioText(gl.inbound),ratioText(gl.read),ratioText(gl.deny),ratioText(gl.reply),
        r.retentionOpen?h('span','muted',ratioText(gl.retained)+' · 미종료'):ratioText(gl.retained)]);
      var b=r.beta;
      if(b.signedUp.n>0)rows.push([h('span','sub2','Beta'),'-',num(b.signedUp.n),ratioText(b.agent),ratioText(b.mcp),ratioText(b.inbound),ratioText(b.read),ratioText(b.deny),ratioText(b.reply),ratioText(b.retained)]);
    });
    add(cc,table([['초대 주','nowrap'],['초대','r'],['14일 안 가입','r'],['첫 에이전트','r'],['첫 MCP','r'],['첫 외부 수신','r'],['첫 읽기(근사)','r'],['첫 허용목록 거부','r'],['첫 답장 성공','r'],['2주차 유지','r']],rows,'아직 초대 주차가 없다'));
    add(body(cc),h('p','note','단계는 가입 후 7일 안 · 2주차 유지는 가입 후 8~14일 활동 · 분모 20 미만은 퍼센트를 적지 않는다 · 내부 조직 '+j.cohorts.internalExcluded+'곳 제외 · 초대 수에는 Beta 초대가 섞여 있다 · 첫 읽기는 근사(첫 외부 수신 뒤 그 에이전트 토큰 사용).'));
    add(p,cc);
    var w=j.waitlist;
    var wc=card('대기자 명단','#/waitlist','명단 보기');
    var ws=h('div','stats');
    add(ws,
      stat('대기',w.waiting,'A '+w.grades.A+' · B '+w.grades.B+' · 보류 '+w.grades.hold+' · 미정 '+w.grades.unknown),
      stat('초대함',w.invited,'만료 '+num(w.expired)),
      stat('가입',w.joined,null),
      stat('A 등급 SLA 초과',w.gradeASlaBreaches,'A 후보 7일 넘게 대기',null,w.gradeASlaBreaches>0));
    add(body(wc),ws,h('p','note','등급은 후보다(본인 확인 안 됨 · unverified). 최종 등급은 메모를 읽고 정한다.'));
    add(p,wc);
    var vc=card('판정 한 줄');
    add(body(vc),h('p','verdict','증량 / 유지 / 동결 중 하나를 창업자가 직접 적는다. 이 화면은 저장하지 않는다.'));
    add(p,vc);
  });
}

/* ---------- review queue + detail ---------- */
function review(id){
  return api('GET','/review').then(function(j){
    setPending(j.items.length);
    var p=page();add(p,head('가입 검토',j.items.length?('대기 '+j.items.length+'곳. 승인하면 발송이 열립니다.'):null));
    if(j.items.length===0){var c=card(null);var e=h('div','empty');add(e,h('strong',null,'검토할 가입이 없습니다'),h('span',null,'새 가입이 오면 여기에 나타납니다.'));add(c,e);add(p,c);return;}
    var sel=id||(window.innerWidth>1100?j.items[0].id:null);
    var split=h('div','split');var ul=h('ul','qlist');
    j.items.forEach(function(o){
      var li=h('li');var b=h('button','qrow');b.type='button';if(o.id===sel)b.setAttribute('aria-current','true');
      add(b,h('span','nm',o.name),h('span','t',ago(o.createdAt)),h('span','em',o.ownerEmail||'-'),h('span','n','에이전트 '+o.agents));
      b.addEventListener('click',function(){location.hash='#/review/'+o.id;});
      add(li,b);add(ul,li);
    });
    var panel=h('div','panel');add(split,ul,panel);add(p,split);
    if(!sel){add(panel,h('p','note','왼쪽에서 가입을 고르세요.'));return;}
    add(panel,h('p','muted','불러오는 중…'));
    return api('GET','/orgs/'+sel).then(function(d){clear(panel);reviewPanel(panel,d);if(id&&window.innerWidth<=1100)panel.scrollIntoView({block:'start'});});
  });
}
function reviewPanel(panel,d){
  var o=d.organization;var c=h('section','card');
  var ph=h('div','pan-h');var t=h('div','grow');add(t,h('h2',null,o.name),h('p','em',o.ownerEmail||'-'));add(ph,t,st(REVIEW,o.reviewStatus));add(c,ph);
  var s1=h('div','sec');add(s1,kv([['가입',when(o.createdAt)+' ('+ago(o.createdAt)+')'],['출처',SOURCE[o.signupSource]||o.signupSource],['요금제',d.plan.plan.code+(d.plan.plan.rowCode?'':' (행 없음)')],['id',h('code',null,o.id)]]));add(c,s1);
  var s2=h('div','sec');add(s2,h('h3',null,'에이전트 '+d.agents.length));
  if(d.agents.length===0)add(s2,h('p','note','아직 없다'));
  else{var ul=h('ul','lines');d.agents.forEach(function(a){var li=h('li');var g=h('span','grow');add(g,a.address?addr(a.address):h('span',null,a.name));add(li,g,h('span','small muted hide-sm',a.name),st(AGENT,a.status));add(ul,li);});add(s2,ul);}
  add(c,s2);
  var s3=h('div','sec');add(s3,h('h3',null,'멤버 '+d.members.length));
  if(d.members.length===0)add(s3,h('p','note','없다'));
  else{var ml=h('ul','lines');d.members.forEach(function(m){var li=h('li');add(li,h('span','grow',m.email),h('span','small muted',m.role==='owner'?'소유자':m.role));add(ml,li);});add(s3,ml);}
  add(c,s3);
  var dc=h('div','decide');
  add(dc,h('span','hint',o.reviewStatus==='pending_review'?'승인 전에는 외부로 보낼 수 없습니다.':''));
  if(o.reviewStatus!=='rejected')add(dc,bigBtn('거절','danger',function(){reviewDialog(o,'reject');}));
  if(o.reviewStatus!=='active')add(dc,bigBtn('승인','',function(){reviewDialog(o,'activate');}));
  add(c,dc);add(panel,c);
  add(panel,link('#/org/'+o.id,'조직 상세 보기','note'));
}

/* ---------- waitlist (202609301520): list by status, invite one / the N oldest, remove (= delete the row). Notes are user text: textContent only ---------- */
var WLST={waiting:['대기','wait'],invited:['초대함',''],expired:['초대 만료','off'],joined:['가입','']};
var WLF=[['waiting','대기'],['invited','초대함'],['expired','초대 만료'],['joined','가입'],['all','전부']];
var WLACT={invite:'초대',remove:'지우기',join:'가입'};
/* intake answers (202609301530): closed values. The grade is only a hint (the operator reads the note and decides) */
var WLUC={alerts:'보고·알림',replies:'답장',codes:'인증코드',outreach:'먼저 발송'};
var WLGR={A:'A',B:'B',hold:'보류'};
function waitlistDialog(e,kind){
  confirmThen({title:kind==='invite'?(e.status==='waiting'?'초대 보내기':'다시 초대'):'대기 항목 지우기',runLabel:kind==='invite'?'초대':'지우기',
    lines:kind==='invite'?[e.email+' 에게 초대 메일을 보냅니다.','초대는 14일 동안 유효합니다.']:[e.email+' 의 주소와 메모를 지웁니다. 되돌릴 수 없습니다.','다시 등록하면 맨 뒤에 섭니다.'],
    label:'대상 주소를 그대로 입력하세요',expect:e.email,destructive:kind==='remove',noAck:true,
    run:function(name){return api('POST','/waitlist/'+e.id+'/'+kind,{confirm:name});},
    done:function(){return kind==='invite'?'초대했습니다.':'지웠습니다.';}});
}
function waitlistOldestDialog(n){
  confirmThen({title:'가장 오래 기다린 '+n+'명 초대',runLabel:'초대',lines:['대기 중인 사람을 등록 순으로 '+n+'명까지 초대합니다.','한 번에 50명까지, 하루 한도 안에서입니다.'],
    label:'초대할 수를 그대로 입력하세요',expect:String(n),destructive:false,
    run:function(name){return api('POST','/waitlist/invite-oldest',{n:n,confirm:name});},
    done:function(r){return r.waitlist.invited+'명을 초대했습니다.';}});
}
function waitlist(params){
  var status=params.get('status')||'waiting';
  return api('GET','/waitlist?status='+encodeURIComponent(status)).then(function(j){
    var c=j.counts;
    var p=page();add(p,head('대기자 명단','대기 '+num(c.waiting)+' · 초대함 '+num(c.invited)+' · 초대 만료 '+num(c.expired)+' · 가입 '+num(c.joined)+' · 24시간 초대 '+num(c.invitedLastDay)));
    var bar=h('div','row');
    var s=h('select');WLF.forEach(function(x){var o=h('option',null,x[1]);o.value=x[0];add(s,o);});s.value=j.status;
    s.addEventListener('change',function(){location.hash='#/waitlist?status='+encodeURIComponent(s.value);});
    var nIn=h('input');nIn.type='number';nIn.min='1';nIn.max='50';nIn.value='5';
    var l=h('label',null,'가장 오래 기다린 사람');add(l,nIn);
    add(bar,s,l,btn('명 초대','',function(){var n=Number(nIn.value);if(!(n>=1&&n<=50&&Math.floor(n)===n)){toast(MSG.invalid_count,true);return;}waitlistOldestDialog(n);}));
    add(p,bar);
    var cd=card(null);
    /* the note, the use case and the grade hint (derived from them) are whatever the first person to submit this address typed: nobody verified them (label them so) */
    add(cd,table(['주소',['언어','nowrap'],'용도 (본인 확인 안 됨 · unverified)','등급 후보 (본인 확인 안 됨 · unverified)','메모 (본인 확인 안 됨 · unverified)',['알게 된 곳 · ref','nowrap'],'상태',['등록','nowrap'],['','act']],j.items.map(function(e){
      var act=null;
      if(e.status!=='joined'&&e.email){act=h('span');add(act,btn('지우기','danger',function(){waitlistDialog(e,'remove');}),btn(e.status==='waiting'?'초대':'다시 초대','',function(){waitlistDialog(e,'invite');}));}
      return [e.email?addr(e.email):h('span','muted','(가입함 · 주소 지움)'),e.lang,e.useCase?(WLUC[e.useCase]||e.useCase):'-',e.gradeHint?(WLGR[e.gradeHint]||e.gradeHint):'-',e.note,(e.heardFrom||'-')+' · '+(e.ref||'-'),st(WLST,e.status,e.inviteExpiresAt&&e.status!=='joined'?(' · '+when(e.inviteExpiresAt)):''),when(e.createdAt),act];
    }),'없다'));
    add(p,cd);
    if(j.items.length>=j.limit)add(p,h('p','note','최대 '+j.limit+'건까지 보입니다.'));
    var ec=card('최근 기록');
    add(ec,table([['시각','nowrap'],'행위','행위자','항목'],j.events.map(function(x){return [when(x.createdAt),WLACT[x.action]||x.action,x.actor,h('code',null,x.entryId.slice(0,8))];}),'기록이 없다'));
    add(p,ec);
  });
}

/* ---------- organizations ---------- */
var orgQuery={q:'',status:''};
function orgs(){
  var qs='?q='+encodeURIComponent(orgQuery.q)+'&status='+encodeURIComponent(orgQuery.status);
  return api('GET','/orgs'+qs).then(function(j){
    var p=page();add(p,head('조직',null));
    var bar=h('div','row');
    var q=h('input');q.type='search';q.placeholder='이름 · 소유자 이메일 · id';q.value=orgQuery.q;
    var s=h('select');[['','검토 상태 전부'],['pending_review','검토 대기'],['active','승인됨'],['rejected','거절됨']].forEach(function(x){var o=h('option',null,x[1]);o.value=x[0];add(s,o);});s.value=orgQuery.status;
    var go=function(){orgQuery.q=q.value.trim();orgQuery.status=s.value;orgs().catch(fail);};
    q.addEventListener('keydown',function(e){if(e.key==='Enter')go();});s.addEventListener('change',go);
    add(bar,q,s,btn('찾기','ghost',go));add(p,bar);
    var c=card(null);
    add(c,table(['조직','검토',['요금제','nowrap'],['에이전트','r'],['가입','nowrap']],j.items.map(function(o){
      var n=h('div');add(n,h('span','nm',o.name),h('span','sub2',o.ownerEmail||'-'));
      var flag=o.abuseFreeze?' · 정지':(o.ownerPaused?' · 소유자 멈춤':'');
      var ag=h('span',o.agents.active>o.agents.max?'over':null,o.agents.active+' / '+o.agents.max);
      return {cells:[n,st(REVIEW,o.reviewStatus,flag),o.plan.code,ag,ago(o.createdAt)],href:'#/org/'+o.id};
    }),'찾는 조직이 없다'));
    add(p,c);
    if(j.items.length>=j.limit)add(p,h('p','note','최근 '+j.limit+'곳까지. 검색으로 좁힌다.'));
  });
}

/* ---------- organization detail ---------- */
var CATALOG=null;
function orgDetail(id){
  var cat=CATALOG?Promise.resolve(CATALOG):api('GET','/catalog').then(function(c){CATALOG=c;return c;});
  return Promise.all([api('GET','/orgs/'+id),cat]).then(function(res){
    var j=res[0];var cat=res[1];var o=j.organization;
    var p=page();var hd=head(o.name,o.ownerEmail,['#/orgs','조직']);
    var acts=h('div','acts');
    if(o.reviewStatus!=='rejected')add(acts,btn('거절','danger',function(){reviewDialog(o,'reject');}));
    if(o.reviewStatus!=='active')add(acts,btn('승인','',function(){reviewDialog(o,'activate');}));
    add(hd,acts);add(p,hd);
    var cols=h('div','cols');
    var sum=card('요약');add(body(sum),kv([['검토',st(REVIEW,o.reviewStatus,o.reviewedAt?(' · '+when(o.reviewedAt)):'')],['출처',SOURCE[o.signupSource]||o.signupSource],['소유자 멈춤',o.ownerPaused?'켜짐':'꺼짐'],['첫 발송',when(o.sendingStartedAt)],['가입',when(o.createdAt)],['id',h('code',null,o.id)]]));
    var ks=h('section','card'+(o.abuseFreeze?' danger':''));var kh=h('div','card-h');add(kh,h('h2',null,'긴급 정지'));add(ks,kh);
    var kb=body(ks);add(kb,kv([['조직 발송',o.abuseFreeze?st({x:['정지됨','bad']},'x'):st({x:['정상','']},'x')]]));
    add(kb,h('p','note',o.abuseFreeze?'모든 에이전트 발송이 막혀 있다. 소유자는 풀 수 없다.':(HOSTED?'':'정지하면 이 조직 모든 에이전트의 발송을 곧바로 막는다.')));
    if(!HOSTED){var ka=h('div','actions');ka.style.marginTop='12px';
    add(ka,o.abuseFreeze?btn('정지 풀기','ghost',function(){freezeDialog(o,false);}):btn('조직 정지','danger',function(){freezeDialog(o,true);}));
    add(kb,ka);}add(cols,sum,ks);add(p,cols);
    var ac=card('에이전트 '+j.agents.length);
    add(ac,table(['주소','상태',['토큰','r'],['생성','nowrap'],['','act']],j.agents.map(function(a){
      var n=h('div');add(n,a.address?addr(a.address):h('span',null,'-'),h('span','sub2',a.name));
      var act=null;
      if(HOSTED)act=null;
      else if(a.status==='active')act=btn('정지','danger',function(){agentDialog(o.name,a,true);});
      else if(a.status==='suspended'&&a.suspendedBy==='operator')act=btn('정지 풀기','ghost',function(){agentDialog(o.name,a,false);});
      return [n,st(AGENT,a.status,a.suspendedBy?(' ('+(a.suspendedBy==='operator'?'운영자':'소유자')+')'):''),a.activeTokens,when(a.createdAt),act];
    }),'에이전트가 없다'));
    add(p,ac);
    add(p,planCard(o,j,cat));
    var mc=card('멤버 '+j.members.length);add(mc,table(['이메일','역할','경로',['가입','nowrap']],j.members.map(function(m){return [m.email,m.role==='owner'?'소유자':m.role,m.joinedVia,when(m.createdAt)];})));add(p,mc);
    var au=card('최근 감사','#/audit?org='+o.id);add(au,auditTable(j.audit,false));add(p,au);
  });
}
function planCard(o,j,cat){
  var pl=j.plan;var c=card('요금제');var b=body(c);
  var ctl=j.entitlementControl;
  add(b,kv([['적용',pl.plan.code+' (근거 '+pl.plan.basis+')'],['행',pl.plan.rowCode?(pl.plan.rowCode+' · 출처 '+pl.plan.source+' · v'+pl.plan.version):'없음(= free)'],['원인',ctl?(ctl.cause+(ctl.releasedToProvider?' · 결제에 넘김':'')):'-'],['유예 끝',when(pl.plan.graceUntil)],['결제',j.billing.betaLocked?'beta, 체크아웃 잠김':'열림'],['초과',pl.overLimit.length?pl.overLimit.join(', '):'-']]));
  var lim=pl.limits;var u=pl.usage;
  add(c,table(['항목',['사용','r'],['한도','r']],[['에이전트(비활성 제외)',u.agents,lim.maxAgents],['에이전트(전체)',u.agentsTotal,lim.agentsTotalMax],['24시간 수신자',u.recipientsLastDay,u.dailyCap+' ('+(u.dailyCapReason==='plan_daily_cap'?'요금제':'워밍업')+')'],['조직 키',u.orgKeys,lim.orgApiKeysMax],['토큰/에이전트','초과 '+u.agentsOverTokenLimit,lim.tokensPerAgentMax],['분당/에이전트','',lim.agentPerMinuteMax],['하루/에이전트','',lim.agentPerDayMax],['수신자/메시지','',lim.recipientsPerMessageMax]]));
  var subs=j.billing.subscriptions;
  if(subs.length)add(c,table(['결제 구독','상태','요금제','기간 끝','예정 변경'],subs.map(function(s){return [s.environment,s.status,s.plan,when(s.currentPeriodEnd),s.scheduledChange?(s.scheduledChange.action+' '+when(s.scheduledChange.at)):'-'];})));
  if(HOSTED)return c;
  var f=h('div','card-b');add(c,f);
  add(f,h('h3','small','요금제 바꾸기'));
  if(!BILLING_OP){add(f,h('p','note','요금제 쓰기 롤 없이 띄웠다 — pnpm ops --billing-operator 로 다시 띄운다.'));return c;}
  var row=h('div','row');row.style.marginTop='12px';
  var sel=h('select');cat.plans.forEach(function(code){var op=h('option',null,code);op.value=code;add(sel,op);});sel.value=pl.plan.rowCode||pl.plan.code;
  var gsel=h('select');[['keep','유예 그대로'],['clear','유예 없앰'],['set','유예 시각 지정']].forEach(function(x){var op=h('option',null,x[1]);op.value=x[0];add(gsel,op);});
  var gat=h('input');gat.type='text';gat.placeholder='2027-03-01T00:00:00Z';gat.hidden=true;gsel.addEventListener('change',function(){gat.hidden=gsel.value!=='set';});
  var note=h('input');note.type='text';note.placeholder='사유(감사 기록)';note.maxLength=500;
  var l1=h('label',null,'요금제');add(l1,sel);var l2=h('label',null,'유예');add(l2,gsel,gat);var l3=h('label',null,'사유');add(l3,note);
  add(row,l1,l2,l3);add(f,row);
  var ov=h('div','row');var inputs={};
  cat.columns.forEach(function(col){var i=h('input');i.type='number';i.min='0';i.max=String(col.ceiling);i.placeholder=String(cat.catalog[sel.value]?cat.catalog[sel.value][col.column]:'');inputs[col.column]=i;var l=h('label',null,col.column);add(l,i);add(ov,l);});
  sel.addEventListener('change',function(){cat.columns.forEach(function(col){inputs[col.column].placeholder=String(cat.catalog[sel.value][col.column]);});});
  var det=h('details');var sm=h('summary','note','한도 덮어쓰기(비우면 요금제 기본값)');add(det,sm,ov);add(f,det);
  var fa=h('div','actions');fa.style.marginTop='12px';
  add(fa,btn('요금제 적용','',function(){
    var overrides={};var bad=null;
    Object.keys(inputs).forEach(function(k){var v=inputs[k].value.trim();if(v==='')return;if(!/^\d+$/.test(v))bad=k;else overrides[k]=Number(v);});
    if(bad){toast(bad+' 는 0 이상 정수',true);return;}
    var grace=gsel.value==='set'?gat.value.trim():gsel.value;
    confirmThen({title:'요금제 바꾸기',runLabel:'적용',lines:['요금제 -> '+sel.value,'덮어쓰기: '+(Object.keys(overrides).length?JSON.stringify(overrides):'없음'),'유예: '+grace],name:o.name,destructive:false,
      run:function(name){return api('POST','/orgs/'+o.id+'/plan',{plan:sel.value,overrides:overrides,graceUntil:grace,note:note.value,confirm:name});},
      done:function(r){return r.result.changed?(String(r.result.fromPlan||'(행 없음)')+' -> '+sel.value+' (v'+r.result.version+')'):'이미 그 요금제·한도다.';}});
  }));
  if(ctl&&ctl.source!=='provider'&&!ctl.releasedToProvider){
    add(fa,btn('결제에 넘기기','ghost',function(){
      confirmThen({title:'결제에 넘기기',runLabel:'넘기기',lines:['요금제·한도·유예는 그대로 둔다.','그 뒤 결제 이벤트가 이 행을 바꾼다(강등 포함).'],name:o.name,destructive:false,
        run:function(name){return api('POST','/orgs/'+o.id+'/plan/release',{confirm:name});},
        done:function(r){return r.result.changed?('넘겼다 (v'+r.result.version+')'):'이미 넘긴 행이다.';}});
    }));
  }
  add(f,fa);return c;
}

/* ---------- plans ---------- */
function plans(){
  return api('GET','/plans').then(function(j){
    var p=page();add(p,head('요금제','바꾸려면 조직을 연다.'));
    var s=h('div','stats');j.counts.forEach(function(x){add(s,stat(x.plan==='none'?'행 없음(free)':x.plan,x.organizations,null));});add(p,s);
    var c=card('운영자·결제가 정한 조직');
    add(c,table(['조직',['요금제','nowrap'],'출처',['버전','r'],['유예 끝','nowrap'],['바뀜','nowrap']],j.items.map(function(x){
      return {cells:[h('span','nm',x.name),x.plan+(x.plan!==x.rowCode?(' (행 '+x.rowCode+')'):''),x.source+' · '+x.cause+(x.releasedToProvider?' · 넘김':''),'v'+x.version,when(x.graceUntil),ago(x.updatedAt)],href:'#/org/'+x.id};
    }),'모두 기본값이다'));
    add(p,c);
  });
}

/* ---------- kill switch ---------- */
function kill(){
  return api('GET','/killswitch').then(function(j){
    var p=page();var hd=head('긴급 정지','지금 막혀 있는 것. 새로 막으려면 조직을 연다.');var acts=h('div','acts');add(acts,link('#/orgs','조직 찾기','btn ghost'));add(hd,acts);add(p,hd);
    var c1=card('정지된 조직 '+j.frozenOrganizations.length);
    add(c1,table(['조직',['정지','nowrap'],['','act']],j.frozenOrganizations.map(function(o){
      var n=h('div');add(n,h('span','nm',o.name),h('span','sub2',o.ownerEmail||'-'));
      return {cells:[n,ago(o.updatedAt),btn('정지 풀기','ghost',function(){freezeDialog(o,false);})],href:'#/org/'+o.id};
    }),'정지된 조직이 없다'));
    var c2=card('운영자가 정지한 에이전트 '+j.suspendedAgents.length);
    add(c2,table(['주소','조직',['정지','nowrap'],['','act']],j.suspendedAgents.map(function(a){
      var n=h('div');add(n,a.address?addr(a.address):h('span',null,'-'),h('span','sub2',a.name));
      return {cells:[n,a.organizationName,ago(a.updatedAt),btn('정지 풀기','ghost',function(){agentDialog(a.organizationName,a,false);})],href:'#/org/'+a.organizationId};
    }),'정지된 에이전트가 없다'));
    add(p,c1,c2);
  });
}

/* ---------- operators (hosted) ---------- */
var OPST={requested:['요청','wait'],active:['활성',''],denied:['거절됨','off'],revoked:['폐기됨','bad'],expired:['만료','off']};
function setOpsPending(n){var c=document.getElementById('nav-ops-pending');if(c)c.textContent=n>0?String(n):'';}
function operatorDialog(o,kind){
  var T={approve:['운영자 승인','승인',[o.email+' 에게 운영자 권한을 줍니다.']],deny:['운영자 요청 거절','거절',[o.email+' 의 요청을 거절합니다.','이 주소는 7일 동안 다시 요청할 수 없습니다.']],revoke:['운영자 폐기','폐기',[o.email+' 의 권한과 세션을 바로 끊습니다.']]}[kind];
  confirmThen({title:T[0],runLabel:T[1],lines:T[2],label:'대상 주소를 그대로 입력하세요',expect:o.email,destructive:kind!=='approve',noAck:true,
    run:function(name){return withStepUp('operator.'+kind,{operator:o.id},o.email,function(){return api('POST','/operators/'+o.id+(kind==='revoke'?'/revoke':'/decision'),kind==='revoke'?{confirm:name}:{decision:kind,confirm:name});});},
    done:function(){return {approve:'승인했습니다.',deny:'거절했습니다.',revoke:'폐기했습니다.'}[kind];}});
}
function operators(){
  return api('GET','/operators').then(function(j){
    setOpsPending(j.pending);
    var p=page();add(p,head('운영자',j.pending?('요청 '+j.pending+'건'):null));
    var c=card(null);
    add(c,table(['주소','상태','출처',['요청','nowrap'],['','act']],j.items.map(function(o){
      var act=null;
      if(o.status==='requested'){act=h('span');add(act,btn('거절','danger',function(){operatorDialog(o,'deny');}),btn('승인','',function(){operatorDialog(o,'approve');}));}
      else if(o.status==='active'&&o.origin==='console')act=btn('폐기','danger',function(){operatorDialog(o,'revoke');});
      return [addr(o.email),st(OPST,o.status,o.id===ME?' (나)':''),o.origin==='cli'?'CLI':'콘솔',when(o.requestedAt||o.createdAt),act];
    }),'운영자가 없습니다'));
    add(p,c);
  });
}

/* ---------- login (hosted): email, then the 6-digit code from the mail ---------- */
var OUT={requested:'접근을 요청했습니다. 운영자가 승인하면 로그인할 수 있습니다.',pending:'이미 요청이 대기 중입니다. 승인을 기다리세요.',cooldown:'최근에 거절된 주소입니다. 나중에 다시 요청하세요.',pending_cap:'지금은 요청을 받을 수 없습니다. 나중에 다시 요청하세요.',already_operator:'이미 운영자입니다. 다시 로그인하세요.'};
function field(label,type,auto){var i=h('input');i.type=type;i.autocomplete=auto;i.spellcheck=false;var l=h('label',null,label);add(l,i);return [l,i];}
function showLogin(note){
  CSRF='';ME='';
  var frame=document.getElementById('frame');if(frame)frame.hidden=true;
  if(dlg.open)dlg.close();var sd=document.getElementById('stepup');if(sd&&sd.open)sd.close();
  var L=document.getElementById('login');L.hidden=false;clear(L);
  var msg=h('p','msg err');msg.setAttribute('role','alert');
  var e=field('이메일','email','email');
  var go=function(){var v=e[1].value.trim();if(!v){msg.textContent='이메일을 입력하세요.';return;}b.disabled=true;msg.textContent='';
    api('POST','/auth/request',{email:v}).then(function(){codeStep(v);},function(x){b.disabled=false;msg.textContent=x.message;});};
  var b=bigBtn('코드 받기','',go);
  e[1].addEventListener('keydown',function(ev){if(ev.key==='Enter')go();});
  add(L,h('h1',null,'운영자 로그인'),h('p','note','메일로 6자리 코드를 보내 드립니다.'),e[0],b,note?h('p','note',note):null,msg);
  e[1].focus();
}
function codeStep(email){
  var L=document.getElementById('login');clear(L);
  var msg=h('p','msg err');msg.setAttribute('role','alert');
  var c=field('코드','text','one-time-code');c[1].inputMode='numeric';c[1].maxLength=6;
  var go=function(){b.disabled=true;msg.textContent='';
    api('POST','/auth/verify',{code:c[1].value.trim()}).then(function(r){
      if(r.outcome==='session'){CSRF=r.csrf;hostedBoot();return;}
      clear(L);add(L,h('h1',null,'요청 결과'),h('p','note',OUT[r.outcome]||r.outcome),bigBtn('처음으로','ghost',function(){showLogin();}));
    },function(x){b.disabled=false;msg.textContent=x.message;});};
  var b=bigBtn('확인','',go);
  c[1].addEventListener('keydown',function(ev){if(ev.key==='Enter')go();});
  add(L,h('h1',null,'코드 입력'),h('p','note',email+' 로 코드를 보냈습니다. 10분 안에 입력하세요.'),c[0],b,msg,bigBtn('다른 주소','ghost',function(){showLogin();}));
  c[1].focus();
}
function hostedBoot(){
  return api('GET','/session').then(function(s){
    CSRF=s.csrf;ME=s.operatorId;
    document.getElementById('login').hidden=true;document.getElementById('frame').hidden=false;
    document.getElementById('actor').textContent=s.email;
    document.getElementById('session').textContent='유휴 '+s.idleMinutes+'분 · 최대 '+s.maxHours+'시간';
    setOpsPending(s.pendingOperators);
    route();
    if((location.hash||'#/')!=='#/'&&location.hash.indexOf('#/review')!==0)api('GET','/review').then(function(r){setPending(r.items.length);},function(){});
  },function(e){showLogin(e.status===401?null:e.message);});
}

/* ---------- audit ---------- */
function auditTable(items,withOrg){
  var heads=withOrg?[['시각','nowrap'],'조직','출처','행위','행위자','내용']:[['시각','nowrap'],'출처','행위','행위자','내용'];
  return table(heads,items.map(function(a){var r=[when(a.createdAt)];if(withOrg)r.push(a.organizationId?link('#/org/'+a.organizationId,a.organizationName):'-');r.push(a.source==='billing'?'요금제':a.source==='ops'?'운영자 콘솔':'콘솔',h('code',null,a.action),a.actor,a.detail||(a.targetId?h('code',null,a.targetId):'-'));return r;}),'기록이 없다');
}
function audit(params){
  var f={source:params.get('source')||'all',org:params.get('org')||'',action:params.get('action')||'',since:params.get('since')||''};
  var qs='?source='+encodeURIComponent(f.source)+'&org='+encodeURIComponent(f.org)+'&action='+encodeURIComponent(f.action)+'&since='+encodeURIComponent(f.since)+'&limit=200';
  return api('GET','/audit'+qs).then(function(j){
    var p=page();add(p,head('감사 로그','콘솔 행위와 요금제 변경. 최근 '+j.limit+'개.'));
    var bar=h('div','row');
    var s=h('select');[['all','출처 전부'],['owner','콘솔'],['billing','요금제']].concat(HOSTED?[['ops','운영자 콘솔']]:[]).forEach(function(x){var o=h('option',null,x[1]);o.value=x[0];add(s,o);});s.value=f.source;
    var org=h('input');org.type='text';org.placeholder='조직 id';org.value=f.org;
    var act=h('input');act.type='text';act.placeholder='행위 접두사';act.value=f.action;
    var since=h('input');since.type='date';since.value=f.since;
    var go=function(){location.hash='#/audit?source='+encodeURIComponent(s.value)+'&org='+encodeURIComponent(org.value.trim())+'&action='+encodeURIComponent(act.value.trim())+'&since='+encodeURIComponent(since.value);};
    [org,act].forEach(function(i){i.addEventListener('keydown',function(e){if(e.key==='Enter')go();});});
    add(bar,s,org,act,since,btn('찾기','ghost',go));add(p,bar);
    var c=card(null);add(c,auditTable(j.items,true));add(p,c);
  });
}

/* ---------- router ---------- */
function route(){
  var hash=location.hash||'#/';var q=hash.indexOf('?');var path=q<0?hash.slice(1):hash.slice(1,q);var params=new URLSearchParams(q<0?'':hash.slice(q+1));
  var parts=path.split('/').filter(Boolean);var name=parts[0]||'home';
  if(HOSTED&&(name==='plans'||name==='kill'))name='home';
  var navKey=name==='org'?'orgs':name;
  Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'),function(a){if(a.getAttribute('data-nav')===navKey)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  var p;
  if(name==='board')p=board();else if(name==='review')p=review(parts[1]||null);else if(name==='waitlist')p=waitlist(params);else if(name==='orgs')p=orgs();else if(name==='org'&&parts[1])p=orgDetail(parts[1]);else if(name==='plans')p=plans();else if(name==='kill')p=kill();else if(name==='audit')p=audit(params);else if(name==='ops'&&HOSTED)p=operators();else p=dashboard();
  p.then(function(){window.scrollTo(0,0);},fail);
}
window.addEventListener('hashchange',function(){if(!HOSTED||!document.getElementById('frame').hidden)route();});
if(HOSTED){
  document.getElementById('logout').addEventListener('click',function(){api('POST','/auth/logout',{}).then(function(){showLogin();},function(){showLogin();});});
  hostedBoot();
}else((!TOKEN_AUTH||TOKEN)?api('GET','/session'):Promise.reject(new Error('no token'))).catch(function(){throw new Error(CFG.relaunchHint);}).then(function(s){
  BILLING_OP=s.billingOperator;
  var t=document.getElementById('target');t.textContent=s.target.where;t.title=s.target.where;if(s.target.kind==='production')t.className='target prod';
  document.getElementById('actor').textContent=s.actor;
  document.getElementById('session').textContent=(s.billingOperator?'요금제 쓰기 · ':'')+'유휴 '+s.idleMinutes+'분 · 최대 '+s.maxHours+'시간';
  route();
  if((location.hash||'#/')!=='#/'&&location.hash.indexOf('#/review')!==0)api('GET','/review').then(function(r){setPending(r.items.length);},function(){});
}).catch(fail);
})();`;

/** 페이지 설정 — 빌드할 때 한 번 박힌다(요청마다 끼워 넣지 않는다 · 해시 CSP 가 이 값까지 덮는다). */
export interface OpsPageConfig {
  /** API 경로 앞부분(같은 오리진). 로컬 = `/api`. */
  readonly apiBase: string;
  /**
   * 세션 전달 방식. `fragment-token` = 로컬: 부트스트랩 fragment(`#t=`) → `sessionStorage` → 요청마다 `x-ops-token` 헤더 · 쿠키 0(`credentials:'omit'`).
   * 다른 전달 계층은 여기에 방식을 더한다(스크립트의 `authHeaders`·`credentials` 한곳).
   */
  readonly auth: 'fragment-token' | 'cookie-csrf';
  /** 세션이 없을 때(토큰 없음·만료) 안내. */
  readonly relaunchHint: string;
}

export const LOCAL_PAGE_CONFIG: OpsPageConfig = {
  apiBase: '/api',
  auth: 'fragment-token',
  relaunchHint: '세션이 없다 — 터미널에서 pnpm ops 를 다시 띄워 새 창으로 연다.',
};

/**
 * 호스팅(`ops.atmark.ai`) — 세션은 `__Host-` HttpOnly 쿠키, 변경 요청은 `/api/session` 이 준 CSRF 를 `x-atmark-ops-csrf` 헤더로. 로그인은 이메일 +
 * 6자리 코드. 화면은 대시보드 · 가입 검토 · 조직 · 운영자 · 감사(요금제 · 동결 · 정지 쓰기 없음 — P1).
 */
export const HOSTED_PAGE_CONFIG: OpsPageConfig = {
  apiBase: '/api',
  auth: 'cookie-csrf',
  relaunchHint: '다시 로그인하세요.',
};

const API_BASE = /^\/[a-z0-9/_-]{0,64}$/;

export function opsCsp(scriptHash: string, styleHash: string): string {
  return (
    "default-src 'none'; " +
    `script-src 'sha256-${scriptHash}'; ` +
    `style-src 'sha256-${styleHash}'; ` +
    "img-src 'none'; " +
    "connect-src 'self'; " +
    "form-action 'none'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'none'; " +
    "require-trusted-types-for 'script'; " +
    "trusted-types 'none'"
  );
}

export interface OpsPage {
  readonly html: string;
  readonly csp: string;
}

/** 페이지 한 장 — 순수 함수(설정 → HTML·CSP). 요청마다 부르지 않는다(서버는 시작할 때 한 번). */
export function buildOpsPage(config: OpsPageConfig = LOCAL_PAGE_CONFIG): OpsPage {
  if (!API_BASE.test(config.apiBase) || config.apiBase.endsWith('/')) throw new Error(`apiBase 는 /로 시작하는 경로(끝 / 없음): ${config.apiBase}`);
  // 설정은 JSON 으로만 박는다(`<` 는 이스케이프 — 스크립트 블록을 닫을 수 없다).
  const cfg = JSON.stringify({ apiBase: config.apiBase, auth: config.auth, relaunchHint: config.relaunchHint }).replace(/</g, '\\u003c');
  const script = asciiScript(`var CFG=${cfg};\n${OPS_JS}`);
  const html =
    '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">' +
    '<meta name="color-scheme" content="light dark">' +
    '<title>Atmark 운영</title>' +
    `<style>${OPS_CSS}</style>` +
    `</head><body>${bodyHtml(config.auth === 'cookie-csrf')}<script>${script}</script></body></html>`;
  return { html, csp: opsCsp(sha256Base64(script), sha256Base64(OPS_CSS)) };
}
