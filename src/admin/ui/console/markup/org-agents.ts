/**
 * src/admin/ui/console/markup/org-agents.ts — 에이전트 목록(§2.4). 행 전체가 그 에이전트로 가는 링크 · 신원 열(E9) · 썸네일.
 * P1(R-9): 서버 페이지(`GET /api/agents?limit=50&cursor=&q=`) — 검색 칸(250ms 뒤 서버 `q`) · `더 보기`(다음 커서).
 * 만들기는 대화상자 하나(`DLG_NEW_AGENT` — 2026-09-30 진윤겸: 만들고 바꾸는 흐름은 전부 라이트박스). 목록 머리 · 빈 상태 · 개요 ·
 * 에이전트 스위처의 `에이전트 추가` 가 모두 같은 창을 연다. 목록이 비면 주 동작은 빈 상태의 버튼 하나다(머리 버튼은 숨는다 — F18).
 */

import { P, skelRows, tip, viewHead } from '../kit';
import { agentHead } from './org-overview';

// --- 에이전트 -------------------------------------------------------------------

export const AGENTS_VIEW =
  '<section class="view" id="v-agents" aria-labelledby="h-agents" hidden>' +
  viewHead('h-agents', '에이전트', {
    count: '<span class="hcount num" id="ag-count"></span><span class="pill bad" id="ag-over" hidden>한도 초과</span>',
    tip: tip(
      'new-agent',
      '새 에이전트 설명',
      P('새 에이전트는 빈 발신 허용 목록 · 수신 전체로 시작합니다.') +
        P('만든 뒤에는 토큰 창의 설정 메시지를 에이전트에게 보내고, 이메일 화면에서 보낼 상대를 넣습니다.') +
        P('긴급 정지한 에이전트도 개수에 들어갑니다. 삭제한 에이전트는 빠지지만, 총합(요금제 한도의 3배)에는 계속 셉니다.'),
    ),
    // 검색은 머리 툴바 안(버튼 왼쪽) — 따로 한 줄을 쓰지 않는다(비평 R4-07, Vercel 목록 툴바).
    actions:
      '<div class="agbar" id="ag-bar" hidden><label class="sr" for="ag-q">에이전트 찾기</label>' +
      '<input type="search" id="ag-q" placeholder="이름이나 주소로 찾기" maxlength="64" autocomplete="off" spellcheck="false" autocapitalize="off"></div>' +
      '<button type="button" class="btn" id="na-open" aria-haspopup="dialog">에이전트 추가</button>',
  }) +
  '<div class="block">' +
  `<table class="tbl" id="agents-tbl">${agentHead()}` +
  '<tbody id="agents-body">' + skelRows(6) + '</tbody></table>' +
  `<div class="empty" id="agents-empty" hidden><p>에이전트가 없습니다.</p><button type="button" class="btn sm" id="na-cta" aria-haspopup="dialog">에이전트 추가</button></div>` +
  // 검색 결과 없음 — 무엇으로 찾았는지 + 되돌리는 방법(비평 R7-16).
  '<div class="empty" id="agents-none" hidden><p id="agents-none-t">찾는 에이전트가 없습니다.</p><button type="button" class="btn sm ghost" id="ag-clear">검색 지우기</button></div>' +
  '<div class="actions more"><button type="button" class="btn sm ghost" id="ag-more" hidden>더 보기</button></div>' +
  '<p class="msg" id="agents-msg" role="status"></p>' +
  '</div>' +
  '</section>';

/**
 * 에이전트 추가 — 이름 · 주소(@ 앞부분, 나중에 못 바꾼다 · 확인된 고객 도메인이 있으면 접미사가 도메인 고르기). 만들면 토큰 창(한 번만 보임)이 이어서 뜬다.
 * 접미 `@atmark.ai` 는 고른 도메인을 따라 스크립트가 바꾼다(`na-suf`).
 */
export const DLG_NEW_AGENT =
  '<dialog id="dlg-newagent" aria-labelledby="na-title"><form id="na-form" novalidate>' +
  '<div class="dh"><h3 id="na-title">에이전트 추가</h3></div>' +
  '<div class="db">' +
  '<label class="field" for="na-name"><span>이름</span><input type="text" id="na-name" maxlength="200" autocomplete="off" placeholder="founder-agent"></label>' +
  // 대표 주소 도메인(ADR-0014 M4) — 확인이 끝난 고객 도메인이 있을 때만 보인다. 고르면 @atmark.ai 주소는 보이지도 쓰이지도 않는다(잠든 앵커).
  // 확인된 고객 도메인이 있으면 접미사 자리가 곧 도메인 고르기다(F48 — @atmark.ai 가 두 번 보이지 않게).
  '<label class="field" for="na-local"><span>주소</span><span class="suffix"><input type="text" id="na-local" maxlength="64" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="founder">' +
  '<b id="na-suf-w"><span class="at">@</span><span id="na-suf">atmark.ai</span></b><select id="na-dom" aria-label="주소 도메인" hidden><option value="">@atmark.ai</option></select></span>' +
  '<small>주소는 나중에 바꿀 수 없습니다.</small><small id="na-dom-h" hidden></small></label>' +
  '<p class="msg" id="na-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="na-cancel">취소</button><button type="submit" class="btn" id="na-go">추가</button></div>' +
  '</form></dialog>';
