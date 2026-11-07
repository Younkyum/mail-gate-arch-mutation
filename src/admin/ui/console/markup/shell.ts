/** src/admin/ui/console/markup/shell.ts — 셸: 상단 바(스코프 스위처) · 스코프 사이드바(항목 · 아래 계정 블록 + 접기) · 배너. */

import { brandLockupSvg, brandSymbolSvg } from '../../../../ui/brand';
import { MAX_AGENTS_PER_PENDING_ORG } from '../../../ops/agents';
import { ADDRESSES_LABEL } from './agent-addresses';
import { PLAN_BANNER } from './plan';
import { DOMAINS_LABEL } from './domains';
import { WATCH_LABEL } from './watch';
import { icon, ICON_PATHS, P, skelRows, tip } from '../kit';

/**
 * 상단 바(콘솔 v5 · 2026-09-27) — `[로고] / [조직] ⇅ / [에이전트] ⇅`. 로고(2026-09-30 — `src/ui/brand.ts`)는 사이드바가 펼쳐졌을 때(≥1150)
 * 가로 조합, 레일로 접혔을 때·태블릿에서는 심볼만(스위처 앞 좁은 자리), 폰(≤767)에서는 숨고 서랍 머리에 가로 조합이 선다. 로고 링크는 이름을
 * 스스로 갖고(`aria-label="Atmark"`) 안의 두 그림은 장식이다. 조직 이름은 개요로 가는 링크(`#top-home`), 옆의 ⇅ 가 조직 스위처.
 * 에이전트 조각은 에이전트 스코프에서만 보인다(≤767 은 마지막 조각만 — `.scope-agent`).
 * 조직 메뉴의 조직 목록은 `/api/me` 의 `memberships` 로만 그린다(E11). 다른 조직을 고르면 `POST /api/session/org` → 새 세션으로 전체 새로고침.
 * 테마·언어·계정은 상단 바에 없다(2026-09-30 진윤겸 — Vercel·Linear·Supabase 처럼 사이드바 왼쪽 아래 계정 블록의 메뉴로 옮겼다).
 * 헤더·사이드바·본문은 한 면(`--background-100`) — 경계는 1px 선뿐.
 */
const THEME_ITEMS: ReadonlyArray<readonly [string, keyof typeof ICON_PATHS, string]> = [
  ['system', 'system', '시스템'],
  ['light', 'sun', '라이트'],
  ['dark', 'moon', '다크'],
];

export const TOP_BAR =
  '<header class="top" id="top">' +
  '<button type="button" class="menu-btn" id="menu-btn" aria-controls="side" aria-expanded="false"><span class="bars" aria-hidden="true"></span><span class="sr">메뉴</span></button>' +
  `<a class="top-brand" id="top-brand" href="#/overview" aria-label="Atmark">${brandLockupSvg({ className: 'brand', height: 20, decorative: true })}${brandSymbolSvg({ className: 'brand-s', height: 20, decorative: true })}</a>` +
  '<span class="sep sep-brand" aria-hidden="true">/</span>' +
  '<nav class="crumb" id="crumb" aria-label="위치">' +
  '<div class="sw sw-org" id="sw-org-w">' +
  '<a class="crumb-home" id="top-home" href="#/overview"><span class="av org" id="org-av" aria-hidden="true"></span><span class="sw-t org" id="org-name"></span></a>' +
  `<button type="button" class="sw-btn sw-caret" id="sw-org" aria-haspopup="menu" aria-expanded="false" aria-controls="sw-org-menu"><span class="sr">조직 바꾸기</span>${icon('updown')}</button>` +
  '<div class="menu" id="sw-org-menu" hidden>' +
  '<ul class="mlist" id="swo-list" role="menu" aria-labelledby="sw-org"></ul>' +
  '<ul class="mlist mfoot" role="menu" aria-labelledby="sw-org">' +
  '<li role="none"><a role="menuitem" class="mi" href="#/settings" id="swo-settings">조직 설정</a></li>' +
  '<li role="none"><button type="button" role="menuitem" class="mi" id="swo-new">새 조직 만들기</button></li>' +
  '</ul></div></div>' +
  '<span class="sep sep-ag" id="sep-ag" aria-hidden="true" hidden>/</span>' +
  '<div class="sw sw-ag" id="sw-ag-w" hidden>' +
  `<button type="button" class="sw-btn" id="sw-ag" aria-haspopup="menu" aria-expanded="false" aria-controls="sw-ag-menu"><span class="idthumb dot" id="sw-ag-dot" aria-hidden="true"></span><span class="sw-t" id="sw-ag-name"></span>${icon('updown')}</button>` +
  '<div class="menu" id="sw-ag-menu" hidden>' +
  '<div class="msearch"><label class="sr" for="sw-q">에이전트 찾기</label><input type="search" id="sw-q" placeholder="에이전트 찾기" autocomplete="off" spellcheck="false" autocapitalize="off"></div>' +
  '<ul class="mlist" id="swa-list" role="menu" aria-labelledby="sw-ag"></ul>' +
  '<p class="small muted mnone" id="swa-none" hidden>찾는 에이전트가 없습니다.</p>' +
  '<ul class="mlist mfoot" role="menu" aria-labelledby="sw-ag">' +
  `<li role="none"><a role="menuitem" class="mi" href="#/agents" id="swa-all">${icon('agents')}<span>모든 에이전트</span></a></li>` +
  `<li role="none"><button type="button" role="menuitem" class="mi" id="swa-new" aria-haspopup="dialog">${icon('plus')}<span>에이전트 추가</span></button></li>` +
  '</ul></div></div>' +
  '</nav>' +
  '</header>';

/**
 * 조직 스코프 사이드바(D5) — 개요 · 에이전트 · 도메인 · 감시 · 로그 · 설정(감시는 2026-10-08 — 받은 메일 등급 · 보류 · 신뢰 발신자 · 자가 등록). 조직 로그는 1단 항목이다(비평 R10-11 — 에이전트 스코프와 같은 구성,
 * 활성 표시가 거짓말하지 않게). 도메인은 2026-10-05 진윤겸 결정으로 설정 섹션에서 1단 항목으로 올라왔다 — 기능이 닫힌 조직에도 항목은
 * 보이고, 화면이 "베타 · 초대받은 조직에만" 상태를 말한다(`domains.ts` `showDomainsView`).
 */
export const NAV_ORG: ReadonlyArray<readonly [keyof typeof ICON_PATHS, string]> = [
  ['overview', '개요'],
  ['agents', '에이전트'],
  ['domains', DOMAINS_LABEL],
  ['watch', WATCH_LABEL],
  ['logs', '로그'],
  ['settings', '설정'],
];

/**
 * 에이전트 스코프 사이드바(§2.1 · D4) — 에이전트 경로에 들어가면 사이드바가 통째로 바뀐다. 맨 위는 `← 에이전트`(2026-10-15 F38 — 부모 이름. 늘 `#/agents`,
 * history.back 아님), 그다음 스코프 머리(썸네일 · 이름 · 주소 · 상태 점 — 링크 아님), 그리고 항목. 항목은 두 묶음이고 사이에 1px 선
 * (개요 · 연결 · 이메일 · 주소 · 웹훅 | 로그 · 신원 · 토큰 — 비평 R3-08: 한 항목짜리 묶음과 이름 없는 빈칸을 없앴다). 채널이 둘 이상이 되면 채널 항목 위에
 * "채널" 라벨을 둔다(지금은 라벨 없음). 주소(대표 + 별칭)는 이메일 바로 뒤(2026-09-29 진윤겸 — 이메일 화면에서 뺐다), 웹훅은 주소 뒤(2026-09-30).
 */
const NAV_AGENT_GROUPS: ReadonlyArray<ReadonlyArray<readonly [keyof typeof ICON_PATHS, string]>> = [
  [
    ['overview', '개요'],
    ['connect', '연결'],
    ['email', '이메일'],
    ['addresses', ADDRESSES_LABEL],
    ['webhooks', '웹훅'],
  ],
  [
    ['logs', '로그'],
    ['identity', '신원'],
    ['tokens', '토큰'],
  ],
];

const navLink = (v: keyof typeof ICON_PATHS, label: string): string =>
  `<li><a href="#/${v}" id="n-${v}">${icon(v)}<span>${label}</span></a></li>`;

/**
 * 사이드바 아래(2026-09-30 진윤겸) — 왼쪽 아래 계정 블록(아바타 · 주소 · 역할) + 접기 버튼. 계정 블록을 누르면 메뉴가 **위로** 열린다(레일에서는
 * 오른쪽으로): 주소 · 역할 · 설정 링크 둘 · 테마(시스템·라이트·다크) · 언어(한국어·English) · 로그아웃 둘. 테마·언어 칸은 고르는 즉시
 * 적용되는 `menuitemradio`(테마는 메뉴를 닫지 않는다 — 바뀐 화면을 보면서 고른다). 레일로 접히면 아바타만 남는다.
 */
const ACCOUNT =
  '<div class="acct" id="acct">' +
  '<button type="button" class="acct-b" id="acct-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="acct-menu">' +
  '<span class="av" id="acct-av" aria-hidden="true"></span><span class="sr">계정</span>' +
  `<span class="acct-t"><span class="acct-e" id="acct-email"></span><span class="acct-r" id="acct-role"></span></span>${icon('updown')}</button>` +
  '<div class="pop menu" id="acct-menu" hidden>' +
  '<p class="pop-h"><span id="owner" class="addr"></span><span class="pop-r" id="me-role"></span></p>' +
  '<ul class="mlist" role="menu" aria-labelledby="acct-btn">' +
  '<li role="none"><a role="menuitem" class="mi" href="#/settings/session" id="acct-set">계정 설정</a></li>' +
  '<li role="none"><a role="menuitem" class="mi" href="#/settings" id="acct-org">조직 설정</a></li>' +
  '<li role="separator" class="msep"></li>' +
  '<li role="none" class="mrow"><span class="mrow-l" aria-hidden="true">테마</span>' +
  '<div class="aseg" role="group" aria-label="테마">' +
  THEME_ITEMS.map(
    ([k, ic, label]) =>
      `<button type="button" role="menuitemradio" class="aseg-i" id="sbt-${k}" aria-checked="${k === 'system' ? 'true' : 'false'}" title="${label}">${icon(ic)}<span class="sr">${label}</span></button>`,
  ).join('') +
  '</div></li>' +
  '<li role="none" class="mrow"><span class="mrow-l" aria-hidden="true">언어</span>' +
  '<div class="aseg" role="group" aria-label="언어">' +
  '<a role="menuitemradio" class="aseg-i" href="?lang=ko" hreflang="ko" lang="ko" id="acct-ko" aria-checked="false">한국어</a>' +
  '<a role="menuitemradio" class="aseg-i" href="?lang=en" hreflang="en" lang="en" id="acct-en" aria-checked="false">English</a>' +
  '</div></li>' +
  '<li role="separator" class="msep"></li>' +
  '<li role="none"><button type="button" role="menuitem" class="mi" id="logout">로그아웃</button></li>' +
  '<li role="none"><button type="button" role="menuitem" class="mi" id="logout-all">모든 기기에서 로그아웃</button></li>' +
  '</ul></div></div>';

const SIDE_FOOT =
  '<div class="side-foot">' +
  ACCOUNT +
  `<button type="button" class="icon-btn" id="side-toggle" aria-controls="side" aria-expanded="true">${icon('panel')}<span class="tt" id="side-toggle-t">사이드바 접기</span></button>` +
  '</div>';

/**
 * 사이드바(명세 §4.3) — ≥1150 펼침(사용자가 레일로 접는다) · 768–1149 레일(누르면 겹침 패널) · ≤767 서랍(맨 위 닫기).
 * 배경막 `#side-scrim` 은 겹침·서랍일 때만 보인다(스크립트 `navOpen`).
 */
export const SIDEBAR =
  '<nav class="side" id="side" aria-label="콘솔 메뉴">' +
  `<div class="side-top">${brandLockupSvg({ className: 'brand', height: 20 })}<button type="button" class="icon-btn" id="side-close" aria-label="닫기">${icon('close')}</button></div>` +
  '<div class="side-body">' +
  '<div class="scope" id="nav-org"><ul class="nav">' +
  NAV_ORG.map(([v, label]) => navLink(v, label)).join('') +
  '</ul></div>' +
  '<div class="scope" id="nav-agent" hidden>' +
  `<a href="#/agents" class="nav-back" id="na-back">${icon('back')}<span>에이전트</span></a>` +
  '<div class="scope-h"><span class="idthumb" id="sc-thumb" aria-hidden="true"></span>' +
  '<span class="scope-t"><span class="nm" id="sc-name"></span><span class="scope-a" id="sc-addr"></span></span>' +
  '<span class="dot" id="sc-dot" role="img"></span></div>' +
  NAV_AGENT_GROUPS.map((g) => `<ul class="nav">${g.map(([v, label]) => `<li><a href="#/agents" id="na-${v}">${icon(v)}<span>${label}</span></a></li>`).join('')}</ul>`).join('') +
  '</div>' +
  '</div>' +
  SIDE_FOOT +
  '</nav>' +
  '<div class="scrim" id="side-scrim" hidden></div>';

/**
 * 부팅 상태(비평 R7-01·R7-03) — `/api/me`·`/api/agents` 가 오기 전에는 화면 대신 스켈레톤 한 장(제목 · 통계 · 표 줄), 실패하면 원인 한 줄 +
 * `다시 시도`(오류 코드는 문장 밖 `title`). 부팅 뒤에는 둘 다 숨고 화면이 그려진다.
 */
export const BOOT_STATES =
  '<div class="bootsk" id="boot-skel" aria-hidden="true">' +
  '<span class="skel sk-h"></span><div class="stats sk-stats"><div><span class="skel"></span></div><div><span class="skel"></span></div><div><span class="skel"></span></div><div><span class="skel"></span></div></div>' +
  `<table class="tbl sk-tbl"><tbody>${skelRows(4, 4)}</tbody></table></div>` +
  `<div class="empty" id="boot-err" role="alert" hidden><p>콘솔을 불러오지 못했습니다.</p>` +
  '<p id="boot-err-t"></p><button type="button" class="btn sm" id="boot-retry">다시 시도</button></div>';

/** 배너(R4) — 굵은 제목 한 줄만 보이고, 본문은 ⓘ 로. */
export const BANNERS =
  '<p class="banner" id="banner" role="alert" hidden></p>' +
  // 부분 오류(F60) — 화면을 옮기면 이것만 걷힌다(다른 배너는 그대로).
  '<p class="banner" id="part-banner" role="status" hidden>일부 정보를 불러오지 못했습니다. 잠시 뒤 새로고침하세요.</p>' +
  '<div class="banner bar" id="org-other" role="status" hidden><span>다른 조직의 링크입니다.</span>' +
  '<button type="button" class="btn sm ghost" id="org-other-go" hidden>이 조직으로 전환</button></div>' +
  '<p class="banner" id="org-moved" role="status" hidden>다른 탭에서 조직을 바꿔 새로고침합니다.</p>' +
  '<div class="robar" id="ro-bar" role="status" hidden><div class="hrow"><strong id="ro-t">읽기 전용</strong>' +
  tip(
    'ro',
    '읽기 전용 설명',
    P('이 조직에서 내 역할은 멤버입니다. 에이전트·토큰·정책·로그를 볼 수 있지만 바꿀 수는 없습니다.') +
      P('역할은 조직 소유자가 설정 › 멤버와 초대에서 바꿉니다.'),
  ) +
  '</div></div>' +
  '<div class="warnbox" id="rv-pending" role="status" hidden><div class="hrow"><strong>운영자가 검토하고 있습니다. 외부 발송은 검토 뒤 열립니다.</strong>' +
  tip(
    'rv-pending',
    '검토 중 설명',
    P('에이전트와 토큰은 지금 만들 수 있습니다.') +
      P(`검토 중에는 에이전트를 ${String(MAX_AGENTS_PER_PENDING_ORG)}개까지 만들 수 있습니다. 검토가 끝나면 따로 할 일은 없습니다. 이 배너가 사라지고 발송이 열립니다.`),
  ) +
  '</div></div>' +
  '<div class="warnbox" id="rv-rejected" role="status" hidden><div class="hrow"><strong>가입이 승인되지 않아 외부 발송이 닫혀 있습니다.</strong>' +
  tip(
    'rv-rejected',
    '거절 설명',
    P('운영자가 검토 끝에 이 조직을 거절했습니다. 이 조직의 에이전트는 운영자가 보류했고, 이 화면에서 풀 수 없습니다. 잘못된 결정이라고 생각되면 Atmark 운영자에게 문의하세요.'),
  ) +
  '</div></div>' +
  '<div class="warnbox" id="ks-platform" role="status" hidden><div class="hrow"><strong>운영자가 이 조직의 발송을 동결했습니다.</strong>' +
  tip(
    'ks-platform',
    '플랫폼 동결 설명',
    P('이 조직의 모든 에이전트 발신이 막혀 있습니다. 승인 릴리스와 예약 발송도 막힙니다. atmark.ai 주소에서 나간 메일의 반송이나 스팸 신고가 기준을 넘으면 Atmark가 자동으로 동결합니다(로그의 콘솔 기록에 남습니다). 플랫폼 동결은 운영자만 풀 수 있고, 이 화면의 긴급 정지 해제로는 풀리지 않습니다. support@atmark.ai로 문의하세요.'),
  ) +
  '</div></div>' +
  '<div class="warnbox" id="ks-owner" role="status" hidden><div class="hrow"><strong>조직 전체가 긴급 정지 중입니다.</strong><a href="#/settings/pause" class="more">긴급 정지 해제' + icon('arrowRight') + '</a>' +
  tip('ks-owner', '조직 긴급 정지 설명', P('이 조직의 모든 에이전트 발신이 막혀 있습니다. 승인 릴리스와 예약 발송도 막힙니다. 정지 중에 막힌 발송은 해제해도 다시 나가지 않습니다.')) +
  '</div></div>' +
  PLAN_BANNER;
