/** src/admin/ui/console/markup/agent-connect.ts — 연결 `#/agents/{id}/connect`: 설정 메시지(토큰은 발급 창에서만 — i 도움말). */

import { P, secHead, tip, viewHead } from '../kit';

export const A_CONNECT =
  '<div class="pane" id="t-connect" hidden>' +
  viewHead('h-ag-connect', '연결') +
  '<div class="cols">' +
  '<div>' +
  secHead(
    'h-cm',
    '에이전트에게 보낼 설정 메시지',
    tip('connect', '설정 메시지 설명', P('에이전트가 MCP 서버에 스스로 연결하고 <code>get_my_policy</code>로 확인한 뒤 답합니다.')),
  ) +
  '<p class="sdesc">에이전트와의 대화에 그대로 붙여 넣으세요.</p>' +
  '<div class="msgbox"><div class="bar"><span class="lbl">메시지 언어</span><div class="seg" role="radiogroup" aria-label="메시지 언어">' +
  '<button type="button" role="radio" id="cm-en" aria-checked="true" tabindex="0">EN</button><button type="button" role="radio" id="cm-ko" aria-checked="false" tabindex="-1">KO</button></div>' +
  '<div class="hrow in">' +
  tip('connect-token', '토큰 설명', P('토큰 정보는 토큰 생성 시에만 적용되어 복사됩니다.')) +
  '</div><span class="grow"></span>' +
  '<button type="button" class="btn sm" id="cm-copy">메시지 복사</button></div>' +
  '<pre id="cm-text"></pre></div>' +
  '<p class="msg" id="cm-msg" role="status"></p>' +
  '</div>' +
  '</div></div>';
