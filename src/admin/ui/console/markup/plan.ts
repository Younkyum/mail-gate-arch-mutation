/**
 * src/admin/ui/console/markup/plan.ts — 설정 "요금제 · 사용량"(과금 P0, ADR-0011) · 결제(WP-2) · 한도 초과 배너.
 *
 * 규율은 다른 조각과 같다: 정적 문자열만(숫자·요금제 이름·날짜는 스크립트가 `textContent` 로) · 문구는 한 줄 + ⓘ. 금액은 화면 어디에도 없다 —
 * 가격은 결제 화면(`pay.atmark.ai`, Paddle)에서만 보인다. **이 페이지는 결제 스크립트를 싣지 않는다**(콘솔 CSP 불변 — 계획 §3-8).
 *
 * "업그레이드" 는 처음에 잠겨 있다. 스크립트가 `GET /api/billing` 을 읽고 결제가 열려 있고(스위치 · 가격 · 키) 내 역할이 owner·admin(D-5)이고
 * 잠금 사유가 없을 때만 푼다. 잠긴 이유는 ⓘ 안의 한 문단으로 보인다(스크립트가 사유에 맞는 고정 문구로 바꾼다). member 에게는
 * 단추 대신 "결제는 소유자·관리자가 합니다" 한 줄.
 */

import { icon, P, settingsRow, skelRows, tip } from '../kit';

/**
 * ⓘ 안의 한 문단 — 잠긴 이유(또는 열렸을 때의 안내). 처음 문구는 "결제 준비 중" 이고, 스크립트가 `/api/billing` 의 `lockedReason` 에 맞는
 * **고정 문구**로 바꾼다(`BILL_WHY_TEXT` — 데이터가 아니다).
 */
const LOCK_REASON = '<p id="bl-why">결제 준비 중입니다. 요금제를 바꾸려면 운영자에게 요청하세요.</p>';

export const PLAN_ROW = settingsRow(
  's-plan',
  'h-plan',
  '요금제 · 사용량',
  tip(
    'plan',
    '요금제 설명',
    P('한도는 요금제가 정합니다. 에이전트는 삭제한 것을 빼고 셉니다.') +
      P('하루 발송 수신자는 단계적 증량 상한과 요금제 한도 중 작은 쪽입니다. 단계적 증량은 요금제로 앞당겨지지 않습니다.') +
      P('한도를 넘은 것은 지우지 않습니다. 새로 만들지 못할 뿐입니다.'),
  ),
  '',
  '<div class="warnbox" id="pl-over" role="status" hidden><div class="hrow"><strong>요금제 한도를 넘었습니다.</strong><span id="pl-over-d"></span></div></div>' +
    '<div class="warnbox" id="bl-due" role="status" hidden><div class="hrow"><strong>결제가 실패했습니다.</strong><span id="bl-due-d"></span></div></div>' +
    '<p class="stateline plan-now"><span class="lbl">요금제</span><span id="pl-name">—</span></p>' +
    '<p class="small muted" id="bl-member" hidden>결제는 소유자·관리자가 합니다.</p>' +
    '<p class="small muted" id="bl-sub" hidden></p>' +
    '<p class="small muted" id="pl-grace" hidden></p>' +
    '<table class="tbl plt dense" id="pl-tbl"><thead><tr><th scope="col">항목</th><th scope="col">사용</th><th scope="col">한도</th></tr></thead>' +
    '<tbody id="pl-body">' + skelRows(3) + '</tbody></table>' +
    // 에이전트·메일마다의 한도는 '사용'이 없다 — 따로 소표(F55: '사용' 칸의 — 가 0 으로 읽히지 않게).
    '<table class="tbl plt dense" id="pl-tbl2"><thead><tr><th scope="col">에이전트 · 메일마다</th><th scope="col">한도</th></tr></thead><tbody id="pl-body2"></tbody></table>' +
    '<p class="small muted" id="pl-cap"></p>' +
    '<p class="msg" id="pl-msg" role="status"></p>' +
    '<p class="msg" id="bl-msg" role="status"></p>',
  '',
  '<div class="actions">' +
    '<label class="field" id="bl-pick-w" for="bl-pick" hidden><span>새 요금제</span><select id="bl-pick"></select></label>' +
    '<button type="button" class="btn ghost" id="bl-portal" hidden>결제 관리</button>' +
    '<button type="button" class="btn" id="pl-upgrade" disabled>업그레이드</button>' +
    tip('upgrade', '업그레이드 설명', LOCK_REASON) +
    '</div>',
);

/** 모든 화면 맨 위 — 강등·운영자 조정 뒤 이미 가진 것이 한도를 넘을 때. */
export const PLAN_BANNER =
  '<div class="warnbox" id="pl-banner" role="status" hidden><div class="hrow"><strong>요금제 한도를 넘었습니다.</strong><a href="#/settings/plan" class="more">요금제' + icon('arrowRight') + '</a>' +
  tip('pl-banner', '한도 초과 설명', P('이미 있는 에이전트·키·토큰은 그대로 동작합니다. 한도 아래로 줄이기 전까지 새로 만들 수 없습니다.')) +
  '</div></div>';
