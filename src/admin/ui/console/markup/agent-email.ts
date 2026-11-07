/**
 * src/admin/ui/console/markup/agent-email.ts — 이메일 채널 화면 `#/agents/{id}/email[/{outbound|inbound}]`(§2.4).
 * 발신 | 수신 두 열(≥1280px), 그보다 좁으면 `발신 | 수신` 세그먼트로 한 열씩(`aria-controls`). 두 열은 `dirPanel` 한 컴포넌트다.
 */

import { icon, P, prop, secHead, tip, viewHead } from '../kit';
import { dirPanel, LIST_SWITCH, modeTipList, RULE_NOTE } from './agent-common';

const OUT_MODE_LONG = {
  all: '누구에게나 보냅니다. 한도·수신 거부 목록·내용 검사는 그대로입니다.',
  allowlist: '허용 목록에 있는 주소·도메인에만 보냅니다. 나머지는 막힙니다.',
  blocklist: '차단 목록에 있는 상대만 막고 나머지에는 보냅니다.',
  none: '아무에게도 보내지 않습니다. 모든 발송이 거부됩니다.',
};
const IN_MODE_LONG = {
  all: '모든 발신자의 메일이 에이전트에게 보입니다.',
  allowlist: '허용 목록에 있는 발신자의 메일만 보입니다. 나머지는 보류됩니다.',
  blocklist: '차단 목록에 있는 발신자의 메일만 보류하고 나머지는 보입니다.',
  none: '모든 메일을 보류합니다. 에이전트 수신함이 비어 있습니다.',
};

/** 발신 열 전용 — 한도(분당은 `변경` → 대화상자 `DLG_LIMIT` 에서 바꾼다 · 시간당·하루는 운영자가 정한다). */
const OUT_LIMITS =
  '<section class="sec limits" aria-labelledby="h-o-lim">' +
  secHead('h-o-lim', '한도', tip('limits', '한도 설명', P('모든 모드에 공통으로 걸립니다. "전체"도 이 한도를 넘지 못합니다.') + P('시간당·하루 한도는 운영자가 정합니다.'))) +
  '<dl class="pl lim" id="o-limits">' +
  '<div><dt>분당</dt><dd class="lim-edit"><span id="ol-min" class="num">—</span><button type="button" class="btn link sm" id="ol-edit" aria-haspopup="dialog">변경</button></dd></div>' +
  prop('시간당', 'ol-hour', 'num') +
  prop('하루', 'ol-day', 'num') +
  prop('메일당 수신자', 'ol-rcpt', 'num') +
  '</dl>' +
  '<p class="msg" id="ol-msg" role="status"></p>' +
  '</section>';

/** 분당 한도 변경 대화상자 — 칸 하나(지금 값으로 채워 연다). 저장하면 새 정책 버전이 생긴다. */
export const DLG_LIMIT =
  '<dialog id="dlg-limit" aria-labelledby="lm-title"><form id="ol-form" novalidate>' +
  '<div class="dh"><h3 id="lm-title">분당 한도 변경</h3></div>' +
  '<div class="db">' +
  '<label class="field" for="ol-rate"><span>분당 최대 발송</span><input type="number" id="ol-rate" min="1" max="9999" step="1" inputmode="numeric" placeholder="1–9999"></label>' +
  '<p class="small muted">저장하면 새 정책 버전이 생기고 즉시 적용됩니다.</p>' +
  '<p class="msg" id="lm-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="ol-cancel">취소</button><button type="submit" class="btn" id="ol-go">저장</button></div>' +
  '</form></dialog>';

/**
 * 수신 열 전용 — 신뢰 표시(v3 senders). 표시 추가는 머리의 `표시 추가` → 대화상자(`DLG_SENDER` — 2026-09-29 진윤겸: 접힌 인라인 폼 대신).
 * 행의 `seen 표시`·`표시 해제` 도 확인 대화상자를 거친다(에이전트가 보는 `sender_trust` 가 바뀐다).
 */
const IN_TRUST =
  '<section class="sec trust" id="s-senders" aria-labelledby="h-trust">' +
  secHead(
    'h-trust',
    '신뢰 표시',
    tip(
      'trust',
      '신뢰 표시 설명',
      P(
        '받은 메일의 발신자를 <code>seen</code>으로 표시합니다. 에이전트는 수신 목록에서 <code>sender_trust: "seen"</code>을 봅니다. 신뢰도는 자동으로 오르지 않습니다. 표시하지 않은 발신자는 계속 <code>unknown</code> 입니다. 수신 모드와는 별개입니다.',
      ),
    ),
    `<button type="button" class="btn sm ghost addbtn" id="sn-add" aria-haspopup="dialog" aria-label="신뢰 표시 추가">${icon('plus')}<span>추가</span></button>`,
  ) +
  '<table class="tbl" id="sn-tbl"><thead><tr><th scope="col">발신자</th><th scope="col">표시</th><th scope="col">시각</th><th scope="col"><span class="muted">동작</span></th></tr></thead>' +
  '<tbody id="sn-body"></tbody></table><div class="empty" id="sn-empty" hidden><p>표시한 발신자가 없습니다.</p></div>' +
  '<p class="msg" id="sn-load-msg" role="status"></p>' +
  '</section>';

/** 신뢰 표시 추가 대화상자 — 범위(주소 하나 | 도메인 전체) · 발신자 · 표시(seen | cleared) · 도메인 seen 확인란. */
export const DLG_SENDER =
  '<dialog id="dlg-sender" aria-labelledby="sd-title"><form id="sn-form" novalidate>' +
  '<div class="dh"><h3 id="sd-title">신뢰 표시 추가</h3></div>' +
  '<div class="db">' +
  '<label class="field" for="sn-scope"><span>범위</span><select id="sn-scope">' +
  '<option value="address">주소 하나</option><option value="domain">도메인 전체</option></select></label>' +
  '<label class="field" for="sn-addr"><span id="sn-addr-label">발신자 주소</span>' +
  '<input type="text" id="sn-addr" maxlength="254" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="noreply@service.example"></label>' +
  '<fieldset class="field" id="sn-mark"><legend class="lbl">표시</legend>' +
  '<label class="check"><input type="radio" name="sn-mark" id="sn-m-seen" value="seen" checked><span><code>seen</code>으로 표시</span></label>' +
  '<label class="check"><input type="radio" name="sn-mark" id="sn-m-cleared" value="cleared"><span>표시 해제 <code>cleared</code></span></label></fieldset>' +
  '<label class="check" id="sn-confirm-wrap" hidden><input type="checkbox" id="sn-confirm"><span>도메인 스코프 seen은 "그 도메인의 <strong>누구든</strong>" 입니다. 공유 메일 도메인(gmail.com 등)이 아님을 확인했습니다.</span></label>' +
  '<p class="msg" id="sn-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="sn-cancel">취소</button><button type="submit" class="btn" id="sn-go">추가</button></div>' +
  '</form></dialog>';

const OUTBOUND = dirPanel('email', 'outbound', {
  title: '발신',
  legend: '발신 모드',
  tipLabel: '발신 모드 설명',
  tipBody:
    P('모드를 고르고 저장하면 새 정책 버전이 생깁니다. 목록 밖 상대에게 보내는 메일은 승인 요청 없이 막힙니다.') +
    modeTipList(OUT_MODE_LONG) +
    P('MCP <code>get_my_policy</code> 에서는 <code>all</code> · <code>allowlist</code> · <code>blocklist</code> · <code>none</code>으로 보입니다.'),
  allowTip: P('허용 목록 모드에서 이 상대들에게만 보냅니다.') + LIST_SWITCH + RULE_NOTE,
  blockTip: P('이 상대들에게는 보내지 않습니다(허용 목록 모드에서도 차단 목록이 이깁니다).') + LIST_SWITCH + RULE_NOTE,
  warn:
    '<div class="warnbox" id="o-legacy" hidden><strong>예전 발신 모드입니다. 네 모드 중 하나로 저장하세요.</strong> <span class="muted" id="o-legacy-mode"></span></div>' +
    '<div class="warnbox" id="o-warn-all" hidden><div class="hrow"><strong>"전체"는 이 에이전트가 누구에게나 메일을 보낼 수 있다는 뜻입니다.</strong>' +
    tip(
      'out-all',
      '&quot;전체&quot; 설명',
      P('토큰이 새거나 에이전트가 메일 속 지시에 속으면 모르는 사람에게도 나갑니다. 속도·수신자 수·예산 한도와 수신 거부 목록·내용 검사는 그대로 걸리지만, 상대를 고르는 층은 없어집니다. 보낼 상대가 정해져 있다면 허용 목록을 쓰세요.'),
    ) +
    '</div></div>',
  extra: OUT_LIMITS,
  modeLine: { all: '모든 상대에게 보냅니다.', allowlist: '목록에 있는 상대에게만 보냅니다.', blocklist: '차단 목록만 빼고 보냅니다.', none: '보내지 않습니다.' },
});

const INBOUND = dirPanel('email', 'inbound', {
  title: '수신',
  legend: '수신 모드',
  tipLabel: '수신 모드 설명',
  tipBody: P('막힌 메일은 반송하지 않고 보류합니다. 보류된 메일은 에이전트에게 보이지 않고, 로그의 수신 탭에 남습니다.') + modeTipList(IN_MODE_LONG),
  allowTip:
    P('허용 목록 모드에서 이 발신자의 메일만 보입니다. 발신 도메인 인증(DMARC)을 통과한 메일만 맞춰 봅니다.') +
    P('주소 규칙이어도 확인되는 것은 발신 도메인이 DMARC를 통과했다는 것까지입니다. 그 도메인 안의 특정 메일함이 보냈다는 증명은 아닙니다.') +
    RULE_NOTE,
  blockTip: P('이 발신자의 메일은 보류됩니다(허용 목록 모드에서도 차단 목록이 이깁니다).') + LIST_SWITCH + RULE_NOTE,
  warn:
    '<div class="warnbox" id="i-warn-none" hidden><div class="hrow"><strong>"모두 막기"는 에이전트가 메일을 하나도 보지 못한다는 뜻입니다.</strong>' +
    tip('in-none', '&quot;모두 막기&quot; 설명', P('인증 코드·회신도 보류됩니다. 에이전트를 멈추려는 것이라면 개요 맨 아래의 긴급 정지를 쓰세요.')) +
    '</div></div>',
  extra: IN_TRUST,
  modeLine: { all: '모든 메일을 받습니다.', allowlist: '목록에 있는 발신자만 받습니다.', blocklist: '차단 목록만 보류합니다.', none: '모두 보류합니다.' },
});

/**
 * 에이전트의 정책 변경 요청(ADR-0007 2026-10-13) — 결정을 기다리는 요청이 있을 때만 보인다(이메일 화면 맨 위). 요청마다 바뀌는 것(지금 → 승인하면) · 에이전트가
 * 적은 이유 · 위험 경고(요청 직전 위험 표시 메일을 읽었다)와 승인 · 거절. 승인은 직접 바꿀 때처럼 새 정책 버전이다. 항목은 스크립트(`email.ts` `renderRequests`)가 그린다.
 */
const REQUESTS =
  '<section class="preq" id="pr-sec" aria-labelledby="h-preq" hidden>' +
  secHead(
    'h-preq',
    '변경 요청',
    tip(
      'preq',
      '변경 요청 설명',
      P('에이전트가 이 정책의 변경을 요청했습니다. 승인하기 전에는 아무것도 바뀌지 않습니다.') +
        P('승인하면 직접 바꿀 때처럼 새 정책 버전이 생기고 즉시 적용됩니다. 결정하지 않은 요청은 7일 뒤 만료됩니다.') +
        P('에이전트가 받은 메일 속 지시에 따라 요청했을 수도 있습니다. 직접 시킨 일이 아니면 거절하세요.'),
    ),
    '<span class="pill warn" id="pr-n"></span>',
  ) +
  '<ul class="prlist" id="pr-list"></ul>' +
  '<p class="msg" id="pr-msg" role="status"></p>' +
  '</section>';

export const A_EMAIL =
  '<div class="pane" id="t-email" hidden>' +
  viewHead('h-ag-email', '이메일', {
    sub: '<span id="em-addr"></span>',
    tip: tip('email', '이메일 설명', P('발신과 수신은 따로 저장합니다. 목록에 추가하고 제거하는 것은 바로 반영되고, 그때마다 새 정책 버전이 생깁니다.')),
  }) +
  REQUESTS +
  '<div class="seg em-tabs" role="radiogroup" aria-label="방향">' +
  '<button type="button" role="radio" id="em-t-outbound" aria-controls="col-outbound" aria-checked="true" tabindex="0">발신</button>' +
  '<button type="button" role="radio" id="em-t-inbound" aria-controls="col-inbound" aria-checked="false" tabindex="-1">수신</button></div>' +
  `<div class="em-cols" id="em-cols">${OUTBOUND}${INBOUND}</div>` +
  '</div>';
