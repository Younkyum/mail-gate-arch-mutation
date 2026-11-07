/**
 * src/admin/ui/app.ts — `GET /app`(`console.atmark.ai`). 소유자 콘솔 — Cloudflare/Vercel 식 구조(`v2-contract.md` §4),
 * v3 화면 규칙(`.omc/handoffs/console-v3-design.md`: 번호 라벨 없음 · 긴 설명은 ⓘ 토글팁 뒤로 · 본문 전체 폭 · 신원 ID 카드).
 *
 * 구조(v4 — `.omc/handoffs/console-v4-design.md`):
 *   - 상단 바: `로고 / 조직 ▾ / ◐ 에이전트 ▾` breadcrumb 스위처(Vercel) · 언어 전환 · 계정 메뉴.
 *   - **스코프 사이드바**(Cloudflare): 조직 스코프 = 개요 · 에이전트 · 도메인 · 감시 · 로그 · 설정. 에이전트 경로에 들어가면 사이드바가 통째로
 *     `← 돌아가기 · 개요 · 연결 · 이메일 · 로그 · 신원 · 토큰` 으로 바뀐다. 모바일(≤880px)에서는 메뉴 버튼으로 접힌다.
 *   - 이메일은 채널 공통 컴포넌트(`dirPanel`)의 발신 | 수신 두 열 · 신원은 한 페이지(컬러 ID 카드 + 정보 + 신원 공개 스위치) ·
 *     토큰은 이름 있는 여러 토큰 목록 · 에이전트 정지는 에이전트 개요 맨 아래 한 행 · 투명성 로그는 설정 안.
 *   - **ⓘ 토글팁**(`tip()` · 스크립트 `setTip`): APG Disclosure(`button` + `aria-expanded` + `aria-controls`) + Esc·바깥 클릭·포커스
 *     이탈로 닫힘 · 한 번에 하나만 열림. 화면에는 섹션당 한 줄만 두고, 이유와 한계는 ⓘ 안에, 지금 누르는 동작의 결과는 확인
 *     대화상자에 둔다(§4 R6).
 *   - **해시 라우팅**(`ROUTER_JS` — 순수 함수 `parseRoute`·`routeHref`, 테스트가 vm 으로 왕복을 단언한다). v3 경로는 한 번
 *     `history.replaceState` 로 새 경로로 고친다. 로그 상세 패널도 경로다(`#/logs/outbound/{id}`) — 뒤로가기가 패널을 닫는다.
 *   - 사용자·멤버십(P0/P1 — `.omc/plans/extensibility-p0-p1.md` §4): 상단 조직 스위처는 `/api/me.memberships` 로 그리고, 고르면 세션을
 *     그 조직으로 바꿔(`POST /api/session/org`) 전체 새로고침한다 · 역할(owner·admin·member) — member 는 읽기 전용 · 설정의 멤버·조직 API 키 ·
 *     조직 고르기 `#/select-org` · 에이전트 목록은 서버 페이지(`limit·cursor·q`) · 정책은 채널 경로(`/channels/email/…`).
 *   - 레거시 "승인 대기"·"seed" 절은 없다(승인은 로그의 발신에서 `pending` 으로 보인다). GATE 는 설정 > GATE.
 *
 * 규율(`page.ts` 머리말과 함께 — 이전 판과 같다):
 *   - **데이터는 전부 `textContent`/`createTextNode` 로만.** HTML 문자열을 만드는 코드가 없다(`innerHTML` 0 — 테스트).
 *   - 에이전트·발신자가 정한 문자열(이름·주소·제목·수신자·발신자·사유·목록 값)은 표시 직전에 `clean()`(`client-sanitize.ts`).
 *   - 모든 변경 요청(GET 이 아닌 것 — POST·PATCH·DELETE)에 `X-Atmark-CSRF`.
 *   - **승인 버튼이 없다.** 승인은 서명 링크 한 경로로만.
 *   - 토큰은 발급·교체 직후 모달에서 **한 번만** 보이고, 그 모달의 설정 메시지에만 들어간다. 닫으면 DOM·변수에서 지운다.
 *     연결 화면의 메시지는 언제나 자리표시(`setupMessage` 에 토큰을 넘기는 곳은 `tokenMsg` 하나).
 *   - 링크 `href` 는 **속성 대입**으로만(`a.href=`) — 값은 이 스크립트가 만든 해시 경로이거나, `https://id.atmark.ai/` 로 시작하는
 *     신원 문서 URL(`safeIdUrl` 이 모양을 확인한 것)뿐이다.
 *   - 조직 정지·플랫폼 동결·검토 중·거절 배너는 모든 화면 맨 위에 계속 보인다.
 *   - 위험한 동작(토큰 교체·폐기, 정지, "전체" 모드, 게시 중단, GATE 기록)은 확인 대화상자를 거친다.
 *
 * GATE 수치의 기준값은 판정 코드의 상수를 빌드 때 스크립트에 박는다(화면과 `check:ac0` 가 같은 숫자를 말하게).
 */
//
// B0(v4): 이 파일은 조립만 한다. 라우터는 `console/router.ts`, 마크업은 `console/markup/*`, 스크립트 조각은 `console/script/*`,
// 서버 상수·문구 표는 `console/data.ts`. 조각은 **순서가 계약**이다(스크립트는 한 IIFE 의 공유 스코프 — `S`·`$`·`el`).

import { CLIENT_SANITIZE_JS } from './client-sanitize';
import { AGENT_LIMITS, GATE_CONSTANTS } from './console/data';
import { AGENT_VIEW } from './console/markup/agent-view';
import { DIALOGS } from './console/markup/dialogs';
import { DOMAINS_VIEW } from './console/markup/domains';
import { LOGS_VIEW } from './console/markup/logs';
import { AGENTS_VIEW } from './console/markup/org-agents';
import { SELECT_ORG_VIEW } from './console/markup/org-team';
import { OVERVIEW_VIEW } from './console/markup/org-overview';
import { SETTINGS_VIEW } from './console/markup/settings';
import { WATCH_VIEW } from './console/markup/watch';
import { BANNERS, BOOT_STATES, SIDEBAR, TOP_BAR } from './console/markup/shell';
import { ART_JS, ROUTER_JS, TIME_JS } from './console/router';
import { AGENT_JS } from './console/script/agent';
import { AGENTS_JS } from './console/script/agents';
import { CORE_JS } from './console/script/core';
import { DOMAINS_JS } from './console/script/domains';
import { AI_WATCH_JS } from './console/script/ai-watch';
import { EMAIL_JS } from './console/script/email';
import { GATE_JS } from './console/script/gate';
import { IDENTITY_JS } from './console/script/identity';
import { LOGS_JS } from './console/script/logs';
import { ORG_JS } from './console/script/org';
import { OVERVIEW_JS } from './console/script/overview';
import { PLAN_JS } from './console/script/plan';
import { SHELL_JS } from './console/script/shell';
import { TEAM_JS } from './console/script/team';
import { TOKENS_JS } from './console/script/tokens';
import { WATCH_JS } from './console/script/watch';
import { WEBHOOKS_JS } from './console/script/webhooks';
import type { Lang } from './i18n';
import { buildPage, type AdminUiPage } from './page';
import { SETUP_MESSAGE_JS } from './setup-message';

export { ART_JS, ROUTER_JS, TIME_JS } from './console/router';
export { GATE_NEXT_STEP_TEXT, REASON_LABELS } from './console/data';

/** 첫 Tab = 본문으로 건너뛰기(비평 R6-01 · WCAG 2.4.1). 해시 라우터와 부딪치지 않게 스크립트가 누름을 받아 `#main` 에 포커스만 옮긴다. */
const APP_BODY =
  '<a class="skip" id="skip" href="#main">본문으로 건너뛰기</a>' +
  TOP_BAR +
  '<div class="frame">' +
  SIDEBAR +
  '<main class="main" id="main" tabindex="-1">' +
  BANNERS +
  BOOT_STATES +
  OVERVIEW_VIEW +
  AGENTS_VIEW +
  DOMAINS_VIEW +
  WATCH_VIEW +
  SETTINGS_VIEW +
  LOGS_VIEW +
  AGENT_VIEW +
  SELECT_ORG_VIEW +
  '<noscript><p class="note">이 페이지는 자바스크립트가 필요합니다.</p></noscript>' +
  '</main></div>' +
  // 순간 성공(복사됨·저장됨·폐기됨)의 알림 자리 하나 — 명세 §3.5 토스트(비평 R7-11). 오류는 폼 옆 `.msg.err` 에 남는다.
  '<div class="toasts" id="toasts" role="status" aria-live="polite"></div>' +
  DIALOGS;

/** 스크립트 조각 — 이 순서로 한 IIFE 에 잇는다. */
const APP_SCRIPT_BODY = [CORE_JS, AGENTS_JS, OVERVIEW_JS, LOGS_JS, AGENT_JS, EMAIL_JS, WEBHOOKS_JS, IDENTITY_JS, TOKENS_JS, GATE_JS, ORG_JS, TEAM_JS, PLAN_JS, DOMAINS_JS, AI_WATCH_JS, WATCH_JS, SHELL_JS].join('');

const APP_SCRIPT = `(function(){\n'use strict';\nvar T=${GATE_CONSTANTS};\nvar L=${AGENT_LIMITS};\n${CLIENT_SANITIZE_JS}${ROUTER_JS}${TIME_JS}${ART_JS}${SETUP_MESSAGE_JS}${APP_SCRIPT_BODY}})();`;

export const APP_PARTS = { title: 'Atmark Console', bodyClass: 'p-app', body: APP_BODY, script: APP_SCRIPT };

export const ADMIN_APP_PAGES: Readonly<Record<Lang, AdminUiPage>> = {
  ko: buildPage(APP_PARTS, 'ko'),
  en: buildPage(APP_PARTS, 'en'),
};
