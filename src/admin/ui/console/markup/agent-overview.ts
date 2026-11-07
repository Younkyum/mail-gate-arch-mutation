/**
 * src/admin/ui/console/markup/agent-overview.ts — 에이전트 개요 `#/agents/{id}`(§2.4): 머리(썸네일 · 이름 · 주소 · 상태 · 신원 · id) ·
 * 7일 통계(E10) · 이메일/토큰/신원 요약 카드 · 최근 활동 · 맨 아래 정지 한 행(D6 — v3 "위험 구역" 탭을 없애고 옮김).
 */

import { copyBtn, dangerZone, icon, P, skelRows, tip } from '../kit';
import { stat } from './org-overview';

/** 요약 카드 한 장 — 제목 + 그 화면으로 가는 링크 + 라벨–값 두세 줄(값은 스크립트가). */
function card(id: string, title: string, more: string, rows: ReadonlyArray<readonly [string, string]>): string {
  return (
    `<section class="ocard" aria-labelledby="h-ao-${id}"><div class="bh"><h2 id="h-ao-${id}">${title}</h2><a href="#/agents" class="more" id="ao-${id}-a">${more}${icon('arrowRight')}</a></div>` +
    `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd id="${v}">—</dd>`).join('')}</dl></section>`
  );
}

/**
 * 위험 구역(§2.7) — Vercel·GitHub 식 두 행: 긴급 정지 · 에이전트 삭제(2026-10-13 — 별칭 삭제와 같은 소프트 삭제, 되돌릴 수 없다). 결과(토큰 유출의
 * 대안 아님 · 30일 뒤 다른 조직 등)는 확인 대화상자가 말한다(R6). 삭제한 에이전트에서는 구역 전체가 숨는다(읽기 전용).
 */
const DANGER_ROW = dangerZone('dz', [
  {
    title: '긴급 정지',
    titleId: 'dz-title',
    tip: tip('danger', '긴급 정지 설명', P('이 에이전트의 모든 발신을 즉시 막습니다. 승인 릴리스와 예약 발송도 막습니다. 수신과 읽기는 계속됩니다.') + P('토큰이 샜다면 긴급 정지 대신 그 토큰을 폐기하세요.')),
    text: '모든 발신을 즉시 막습니다. 수신은 계속됩니다.',
    textId: 'dz-text',
    noteId: 'dz-note',
    button: '<button type="button" class="btn danger" id="dz-kill">정지</button>',
    msgId: 'dz-msg',
  },
  {
    title: '에이전트 삭제',
    titleId: 'dzd-title',
    text: '토큰을 폐기하고 주소를 삭제해 메일을 멈춥니다. 되돌릴 수 없습니다.',
    noteId: 'dzd-note',
    button: '<button type="button" class="btn danger" id="dz-del">삭제</button>',
    msgId: 'dzd-msg',
  },
]);

export const A_OVERVIEW =
  '<div class="pane" id="t-overview" hidden>' +
  '<header class="ah"><span class="idthumb lg" id="ao-thumb" aria-hidden="true"></span>' +
  '<div class="ah-t"><h1 id="a-name" tabindex="-1"></h1><div class="ameta"><span id="a-addr"></span><span id="a-status"></span><span id="a-ident"></span>' +
  `<span class="idchip"><span class="mono muted small" id="a-id"></span>${copyBtn('a-id-copy', 'ID 복사')}</span></div></div>` +
  '<div class="vh-act"><button type="button" class="btn ghost" id="ao-copy">연결 메시지 복사</button></div></header>' +
  '<div class="stats" id="ao-stats">' +
  // 순서 고정(F29): 발신 → 수신 → 막힘 → 보류 — 조직 개요와 같다.
  stat('ao-st-out', '7일 발신') +
  stat('ao-st-in', '7일 수신') +
  stat('ao-st-denied', '막힘') +
  stat('ao-st-q', '보류') +
  '</div>' +
  '<p class="msg" id="ao-stats-msg" role="status"></p>' +
  '<div class="ocards">' +
  card('email', '이메일', '이메일', [
    ['발신', 'ao-out'],
    ['수신', 'ao-in'],
    ['속도', 'ao-rate'],
  ]) +
  card('tokens', '토큰', '토큰', [
    ['활성', 'ao-tokens'],
    ['마지막 사용', 'ao-used'],
  ]) +
  card('identity', '신원', '신원', [
    ['상태', 'ao-ident'],
    ['만료', 'ao-until'],
  ]) +
  '</div>' +
  '<div class="block"><div class="bh"><h2>최근 활동</h2><a href="#/agents" class="more" id="ao-logs-a">모두 보기' + icon('arrowRight') + '</a></div>' +
  '<table class="tbl dense" id="ao-log-tbl"><thead><tr><th scope="col">시각</th><th scope="col">방향</th><th scope="col">상대</th><th scope="col">제목</th><th scope="col">결과</th></tr></thead>' +
  '<tbody id="ao-log-body">' + skelRows(5) + '</tbody></table>' +
  '<div class="empty" id="ao-log-empty" hidden><p>최근 활동이 없습니다.</p></div>' +
  '<p class="msg" id="ao-msg" role="status"></p></div>' +
  DANGER_ROW +
  '</div>';
