/** src/admin/ui/console/markup/org-overview.ts — 조직 개요(§2.4): 통계 줄 · 시작하기 · 에이전트 · 최근 활동("전체 로그" 가 조직 로그로 가는 유일한 길 — D5). */

import { icon, LI, secHead, skelRows, tip, viewHead } from '../kit';

/** 통계 한 칸 — 값은 스크립트가 `textContent` 로(7일 수치는 `GET /api/stats?days=7`, E10). */
export function stat(id: string, label: string): string {
  return `<div><span class="lbl">${label}</span><span class="big num" id="${id}"></span><span class="sub num" id="${id}-sub"></span></div>`;
}

/** 에이전트 표 머리 — 조직 개요와 목록이 같은 열(§2.4). 첫 칸은 썸네일 + 이름 + 둘째 줄 주소(명세 §3.3 · 비평 R1-05). */
const AGENT_COLS = ['이름', '상태', '신원', '발신', '수신', '마지막 사용'] as const;
export function agentHead(): string {
  return `<thead><tr>${AGENT_COLS.map((c) => `<th scope="col">${c}</th>`).join('')}</tr></thead>`;
}

export const OVERVIEW_VIEW =
  '<section class="view" id="v-overview" aria-labelledby="h-overview" hidden>' +
  viewHead('h-overview', '개요', { actions: '<button type="button" class="btn" id="ov-new" aria-haspopup="dialog">에이전트 추가</button>' }) +
  '<div class="stats" id="ov-stats">' +
  // 에이전트 수 = 사용량 `n / N`(목록 머리와 같은 표기 — F27). 넘으면 옆에 상태 알약 `✕ 한도 초과` 하나(숫자는 그대로).
  '<div><span class="lbl">에이전트</span><span class="big num" id="st-agents"></span><span class="sub num" id="st-agents-sub"></span><span class="pill bad" id="st-agents-over" hidden>한도 초과</span></div>' +
  stat('st-out', '7일 발신') +
  stat('st-in', '7일 수신') +
  stat('st-bad', '막힘·보류') +
  '</div>' +
  '<p class="msg" id="ov-stats-msg" role="status"></p>' +
  '<div class="block" id="ov-start" hidden>' +
  secHead(
    'h-start',
    '시작하기',
    tip(
      'start',
      '시작하기 설명',
      LI([
        '주소와 토큰이 생깁니다. 토큰은 한 번만 보입니다.',
        '연결 화면의 메시지를 에이전트와의 대화에 붙여 넣으면, 에이전트가 MCP를 스스로 연결하고 확인합니다.',
        '새 에이전트는 빈 발신 허용 목록으로 시작합니다. 목록에 넣기 전에는 아무에게도 보내지 못합니다.',
      ]),
    ),
  ) +
  '<ul class="steps">' +
  '<li id="ov-s1"><span class="stn" aria-hidden="true"></span><strong>에이전트 만들기</strong><a href="#/agents" class="more">에이전트' + icon('arrowRight') + '</a></li>' +
  '<li id="ov-s2"><span class="stn" aria-hidden="true"></span><strong>에이전트에게 설정 메시지 보내기</strong><a href="#/agents" class="more" id="ov-s2-a">연결' + icon('arrowRight') + '</a></li>' +
  '<li id="ov-s3"><span class="stn" aria-hidden="true"></span><strong>보낼 상대 정하기</strong><a href="#/agents" class="more" id="ov-s3-a">이메일' + icon('arrowRight') + '</a></li>' +
  '</ul></div>' +
  '<div class="block" id="ov-agents-b"><div class="bh"><h2>에이전트</h2><a href="#/agents" class="more">모두 보기' + icon('arrowRight') + '</a></div>' +
  `<table class="tbl" id="ov-agents-tbl">${agentHead()}` +
  '<tbody id="ov-agents-body">' + skelRows(6) + '</tbody></table>' +
  `<div class="empty" id="ov-agents-empty" hidden><p>에이전트가 없습니다.</p></div></div>` +
  '<div class="block" id="ov-log-b"><div class="bh"><h2>최근 활동</h2><a href="#/logs" class="more">모두 보기' + icon('arrowRight') + '</a></div>' +
  '<table class="tbl dense" id="ov-log-tbl"><thead><tr><th scope="col">시각</th><th scope="col">방향</th><th scope="col">에이전트 이름</th><th scope="col">상대</th><th scope="col">결과</th></tr></thead>' +
  '<tbody id="ov-log-body">' + skelRows(5) + '</tbody></table>' +
  '<div class="empty" id="ov-log-empty" hidden><p>최근 활동이 없습니다.</p></div>' +
  '<p class="msg" id="ov-log-msg" role="status"></p></div>' +
  '</section>';
