/**
 * src/admin/ui/console/markup/dialogs.ts — 대화상자: 확인 · 토큰(한 번만 보임) · 새 토큰 · 새 조직 · 초대 · 조직 키(발급 · 한 번만 보임) · 예약 취소 ·
 * 목록 항목 추가 · 신뢰 표시 추가 · 별칭 추가 · 웹훅 추가 · 웹훅 비밀값(한 번만 보임) · 웹훅 인증 헤더 · 새 에이전트 · 분당 한도 · 개입 기록 · 인계 시험 시작 ·
 * 도메인 추가 · 도메인 제거 · 감시(에이전트별 설정 · 신뢰 발신자 추가 · 자가 등록 하루 상한) · 로그 상세 시트. 더하고 바꾸는 흐름은 전부 버튼 → 대화상자다(2026-09-29 · 09-30 진윤겸 — 인라인 입력 칸·펼치는 패널 없음).
 */

import { DLG_ALIAS } from './agent-addresses';
import { DLG_RULE } from './agent-common';
import { DLG_LIMIT, DLG_SENDER } from './agent-email';
import { DLG_NEW_TOKEN } from './agent-tokens';
import { DLG_WEBHOOK, DLG_WHAUTH, DLG_WHSECRET } from './agent-webhooks';
import { DLG_SCHEDULE_CANCEL } from './logs';
import { DLG_NEW_AGENT } from './org-agents';
import { TEAM_DIALOGS } from './org-team';
import { DLG_GATE_IV, DLG_GATE_START } from './settings';
import { DLG_DOMAIN_ADD, DLG_DOMAIN_REMOVE } from './domains';
import { WATCH_DIALOGS } from './watch';

export const DIALOGS =
  '<dialog id="dlg-confirm" aria-labelledby="dc-title">' +
  '<div class="dh" id="dc-head"><p class="kicker" id="dc-kicker"></p><h3 id="dc-title"></h3></div>' +
  '<div class="db"><div id="dc-body"></div>' +
  '<label class="check" id="dc-ackwrap" hidden><input type="checkbox" id="dc-ack"><span id="dc-acktext"></span></label></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="dc-cancel">취소</button><button type="button" class="btn" id="dc-ok">확인</button></div>' +
  '</dialog>' +
  '<dialog id="dlg-token" aria-labelledby="dt-title">' +
  '<div class="dh once"><p class="kicker" id="dt-kicker"></p><h3 id="dt-title">토큰은 지금 한 번만 보입니다</h3></div>' +
  '<div class="db">' +
  '<p>이 창을 닫으면 토큰을 다시 볼 수 없습니다.</p>' +
  '<dl class="kv"><dt>에이전트 이름</dt><dd id="dt-name"></dd><dt>주소</dt><dd id="dt-addr"></dd><dt>ID</dt><dd id="dt-id" class="mono"></dd></dl>' +
  '<span class="lbl">ATMARK_AGENT_TOKEN</span>' +
  '<div class="tokenbox"><code id="dt-token"></code><button type="button" class="btn" id="dt-copy">복사</button></div>' +
  '<div class="lblrow"><span class="lbl">설정 메시지(토큰 포함)</span><div class="seg" role="radiogroup" aria-label="메시지 언어">' +
  '<button type="button" role="radio" id="dm-en" aria-checked="true" tabindex="0">EN</button><button type="button" role="radio" id="dm-ko" aria-checked="false" tabindex="-1">KO</button></div></div>' +
  '<pre class="snippet" id="dt-msg"></pre>' +
  '<div class="actions"><button type="button" class="btn sm ghost" id="dt-copy-msg">메시지 복사</button></div>' +
  '</div>' +
  '<div class="df"><button type="button" class="btn ghost" id="dt-close">닫기</button></div>' +
  '</dialog>' +
  DLG_NEW_TOKEN +
  TEAM_DIALOGS +
  DLG_SCHEDULE_CANCEL +
  DLG_RULE +
  DLG_SENDER +
  DLG_ALIAS +
  DLG_WEBHOOK +
  DLG_WHSECRET +
  DLG_WHAUTH +
  DLG_NEW_AGENT +
  DLG_LIMIT +
  DLG_GATE_IV +
  DLG_GATE_START +
  DLG_DOMAIN_ADD +
  DLG_DOMAIN_REMOVE +
  WATCH_DIALOGS +
  '<dialog class="sheet" id="dlg-log" aria-labelledby="dl-title">' +
  '<div class="dh"><div class="sheet-top"><p><span class="kicker" id="dl-kicker"></span> <span class="mono small muted" id="dl-id"></span></p><button type="button" class="btn sm ghost" id="dl-close">닫기</button></div>' +
  '<h3 id="dl-title"></h3></div>' +
  '<div class="db"><dl class="kv" id="dl-kv"></dl><div id="dl-extra"></div><p class="msg" id="dl-msg" role="status"></p></div>' +
  '</dialog>';
