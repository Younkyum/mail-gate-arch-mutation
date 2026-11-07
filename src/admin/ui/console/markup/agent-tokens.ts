/**
 * src/admin/ui/console/markup/agent-tokens.ts — 토큰 `#/agents/{id}/tokens`(§2.4 · D7): 에이전트당 활성 토큰 여러 개(상한 5) · 이름 ·
 * 토큰 값(`atk_agent_••••••••` + 끝 4자 — 평문은 저장되지 않는다) · 권한(발급 때 고름 — R-7) · 만든 날 · 마지막 사용 · 만료 · 상태 · 행마다 ⋯ 메뉴
 * (이름 바꾸기 · 교체 · 폐기). 머리의 `전부 교체 ▾` 메뉴는 v3 의 교체(전부 폐기 + 새 1개)와 전부 폐기. 평문은 발급·교체 직후 v3 토큰 창에서
 * **한 번만** 보인다 — 놓쳤으면 그 토큰을 교체한다(2026-09-27 진윤겸).
 */

import { icon, P, skelRows, tip, viewHead } from '../kit';

export const A_TOKENS =
  '<div class="pane" id="t-tokens" hidden>' +
  viewHead('h-ag-tokens', '토큰', {
    count: '<span class="hcount num" id="tk-count"></span>',
    tip: tip(
      'tokens',
      '토큰 설명',
      P('에이전트가 MCP·API에 쓰는 비밀. Atmark는 토큰 원문을 보관하지 않아 발급 직후 한 번만 보입니다.') +
        P('쓰는 곳마다 이름을 붙인 토큰을 따로 두면, 샌 것 하나만 폐기할 수 있습니다. 한 에이전트의 활성 토큰 수는 요금제가 정합니다(최대 5개).') +
        P('평문을 놓쳤다면 ⋯ 메뉴의 교체로 같은 이름·권한의 새 토큰을 받으세요. 전부 교체는 모든 토큰을 폐기하고 새 토큰 1개를 발급합니다.'),
    ),
    actions:
      '<div class="mwrap"><button type="button" class="btn ghost" id="tk-bulk" aria-haspopup="menu" aria-expanded="false" aria-controls="tk-bulk-menu">' +
      `<span>전부 교체</span>${icon('chev')}</button>` +
      '<div class="menu" id="tk-bulk-menu" hidden><ul class="mlist" role="menu" aria-labelledby="tk-bulk">' +
      '<li role="none"><button type="button" role="menuitem" class="mi" id="tk-rotate">전부 교체</button></li>' +
      '<li role="none"><button type="button" role="menuitem" class="mi" id="tk-revoke">전부 폐기</button></li>' +
      '</ul></div></div>' +
      '<button type="button" class="btn" id="tk-new" aria-haspopup="dialog">토큰 발급</button>',
  }) +
  // 활성/전체는 보기 전환이 아니라 목록 필터 — 세그먼트 대신 확인란 하나(F40: 탭 = 보기 · 세그먼트 = 값 고르기 · 필터 = 확인란·고르기).
  '<label class="check tk-filter" id="tk-filter" for="tk-f-all"><input type="checkbox" id="tk-f-all"><span>끝난 토큰도 보기 <span class="num muted" id="tk-f-endn"></span></span></label>' +
  '<table class="tbl tokt" id="tk-tbl"><thead><tr><th scope="col">이름</th><th scope="col">토큰 값</th><th scope="col">권한</th><th scope="col">만든 날</th>' +
  '<th scope="col">마지막 사용</th><th scope="col">만료</th><th scope="col"><span class="sr">동작</span></th></tr></thead>' +
  '<tbody id="tk-body">' + skelRows(7) + '</tbody></table>' +
  `<div class="empty" id="tk-empty" hidden><p>활성 토큰이 없습니다.</p></div>` +
  '<p class="small" id="tk-gap" role="status" hidden></p>' +
  '<p class="msg" id="tk-msg" role="status"></p>' +
  '</div>';

/**
 * 에이전트 토큰 권한(R-7) — 발급 때 고른다. 하나도 고르지 않으면 발급 버튼이 잠긴다 — 서버도 빈 배열을 `400 invalid_capability`
 * 로 거부한다(예전에는 빈 배열이 전체 권한으로 풀렸다, F9). 한 줄 = `[값, 이름, 기본으로 켜짐, 한 줄 설명]`.
 * 앞의 넷과 맨 뒤 `policy:request`(2026-10-13 — 요청만 · 바꾸지 않는다)는 기본으로 켜져 있다. `webhooks:manage`(2026-09-30 — 에이전트가 자기 웹훅을 추가·삭제·교체)는 기본으로 **꺼져** 있다 — 이벤트를
 * 바깥 주소로 내보내는 권한이라 소유자가 골라서 준다. `agents:enroll`(2026-10-08 — 같은 조직에 새 에이전트를 스스로 만든다)도 기본으로 꺼져 있고
 * **소유자에게만** 보인다(고르면 경고 한 줄). 스크립트(`tokens.ts`)가 같은 배열에서 개수·기본값을 읽는다.
 */
export const TOKEN_CAPS: ReadonlyArray<readonly [string, string, boolean, string]> = [
  ['messages:send', '보내기', true, ''],
  ['messages:read', '읽기', true, ''],
  ['audit:read', '감사', true, ''],
  ['agent:read_self', '자기 정보', true, ''],
  ['webhooks:manage', '웹훅 관리', false, '에이전트가 자기 웹훅을 추가·삭제하고 비밀값을 교체할 수 있습니다.'],
  ['agents:enroll', '자가 등록', false, '이 토큰으로 같은 조직에 새 에이전트를 만들 수 있습니다. 감시 › 자가 등록이 켜져 있어야 쓰입니다. 소유자만 줍니다.'],
  // 2026-10-13(ADR-0007 개정) — 정책 변경 **요청**. 바꾸지 않는다(승인은 소유자가 이메일 화면에서) — 기본으로 켜져 있다. 뒤에 둔다(앞 칸의 순서 · id 를 지킨다).
  ['policy:request', '정책 변경 요청', true, '에이전트가 허용·차단 목록이나 모드의 변경을 요청할 수 있습니다. 승인하기 전에는 아무것도 바뀌지 않습니다.'],
];

/** 소유자만 고를 수 있는 권한(서버도 `requireRole(owner)` — `src/admin/routes/tokens.ts`). 다른 역할에게는 칸이 숨는다. */
export const OWNER_ONLY_CAPS: readonly string[] = ['agents:enroll'];

/** 새 토큰 · 이름 바꾸기 대화상자(같은 폼 — 이름 바꾸기에서는 권한·만료 칸을 숨긴다). 제출은 스크립트가 가로챈다(`form-action 'none'`). */
export const DLG_NEW_TOKEN =
  '<dialog id="dlg-newtok" aria-labelledby="nt-title"><form id="nt-form" novalidate>' +
  '<div class="dh"><h3 id="nt-title">토큰 발급</h3></div>' +
  '<div class="db">' +
  '<label class="field" for="nt-label"><span>이름</span><input type="text" id="nt-label" maxlength="60" autocomplete="off" spellcheck="false" placeholder="prod-mcp">' +
  '<small>쓰는 곳을 알아볼 이름, 60자까지</small></label>' +
  '<fieldset class="capset" id="nt-caps-w"><legend class="lbl">권한</legend>' +
  TOKEN_CAPS.map(
    ([v, label, on, hint], i) =>
      `<label class="check" for="nt-cap-${String(i)}" id="nt-cap-${String(i)}-w"><input type="checkbox" id="nt-cap-${String(i)}" value="${v}"${on ? ' checked' : ''}><span>${label} <code>${v}</code>` +
      (hint ? `<small class="caphint">${hint}</small>` : '') +
      '</span></label>',
  ).join('') +
  '<small class="capnote" id="nt-enroll-warn" hidden>토큰이 새면 다른 사람이 이 조직에 에이전트를 만들 수 있습니다. 꼭 필요한 곳에만 주세요.</small>' +
  '<small class="capnote" id="nt-caps-none" hidden>권한을 하나 이상 고르세요.</small></fieldset>' +
  '<label class="field" id="nt-exp-w" for="nt-exp"><span>만료</span><select id="nt-exp"><option value="">만료 없음</option><option value="30">30일</option><option value="90">90일</option><option value="365">365일</option></select></label>' +
  '<p class="msg" id="nt-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="nt-cancel">취소</button><button type="submit" class="btn" id="nt-go">발급</button></div>' +
  '</form></dialog>';
