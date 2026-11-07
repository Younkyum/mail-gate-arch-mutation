/**
 * src/admin/ui/console/markup/agent-view.ts — 에이전트 스코프 화면 `#/agents/{id}[/…]`. v3 의 상단 탭 줄은 없다 — 항목은 스코프 사이드바가
 * 고르고(§2.1), 화면마다 자기 머리(H1)를 가진다. 에이전트를 못 찾으면 빈 상태 하나.
 */

import { backLink, tip, viewHead } from '../kit';
import { A_ADDRESSES } from './agent-addresses';
import { A_CONNECT } from './agent-connect';
import { A_EMAIL } from './agent-email';
import { A_IDENTITY } from './agent-identity';
import { A_OVERVIEW } from './agent-overview';
import { A_TOKENS } from './agent-tokens';
import { A_WEBHOOKS } from './agent-webhooks';

/** 에이전트 로그 — 로그 종류 ⓘ 는 탭 줄 끝이 아니라 제목 옆(F41). 글은 스크립트가 탭에 맞춰 쓴다(`showLogs`). */
const A_LOGS = '<div class="pane" id="t-logs" hidden>' + viewHead('h-ag-logs', '로그', { tip: tip('logs-a', '로그 종류 설명', '<p id="tip-logs-a-t"></p>') }) + '<div id="a-logs-host"></div></div>';

export const AGENT_VIEW =
  '<section class="view" id="v-agent" aria-label="에이전트" hidden>' +
  // 없는 에이전트(지워졌거나 다른 조직) — 제목 + 할 일 하나(비평 R7-10). 사이드바는 조직 스코프로 돌아간다(shell.ts renderScope).
  `<div class="empty" id="a-missing" hidden><p>에이전트를 찾을 수 없습니다.</p>` +
  '<p>지워졌거나 다른 조직의 에이전트입니다.</p><a href="#/agents" class="btn sm">에이전트 목록</a></div>' +
  '<div id="a-body" hidden>' +
  backLink('a-back', '#/agents', '에이전트') +
  // 삭제한 에이전트(2026-10-13) — 화면은 읽기 전용(개요 · 로그만). 기록은 남는다.
  '<p class="banner" id="a-gone" role="status" hidden>삭제한 에이전트입니다. 받은 메일과 기록은 남아 있고, 바꿀 수 없습니다.</p>' +
  A_OVERVIEW +
  A_CONNECT +
  A_EMAIL +
  A_ADDRESSES +
  A_WEBHOOKS +
  A_LOGS +
  A_IDENTITY +
  A_TOKENS +
  '</div></section>';
