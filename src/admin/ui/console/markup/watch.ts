/**
 * src/admin/ui/console/markup/watch.ts — 감시 `#/watch/{section}`(2026-10-08 진윤겸 — 사이드바 1단 항목: 개요 · 에이전트 · 도메인 · **감시** · 로그 · 설정).
 *
 * 받은 메일의 두 등급(`src/security/levels.ts` — **차단** · **위험**)과 그 둘레의 설정을 한곳에 모은다. 모양은 설정과 같다(왼쪽 메뉴 + 섹션 하나씩,
 * 좁으면 위 가로 탭 — `.sset` · `.snav` · `settingsRow`). 섹션 순서 = 라우터 `WATCH_SECTIONS`:
 *   메일      보류된 메일(`GET /api/watch/held` · 풀어 주기) · 신뢰 발신자(소유자) · AI 의심 메일 감시(설정 > 운영에서 옮김 — `ai-watch.ts`)
 *   에이전트  에이전트별 설정(`/api/agents/{id}/watch` — 관리자) · 가입한 곳(`GET /api/watch/signups` + 알림 스위치) · 자가 등록(소유자)
 * 등급 표식: 차단 = 꽉 찬 검정 · 위험 = 검은 테두리(색 없음 — 빨강은 되돌릴 수 없는 동작 · 오류에만). 차단은 늘 보류 · 늘 알림이라 스위치가 아니라
 * **고정 한 줄**(`.wfix`)로 보인다. 바꾸는 흐름은 전부 대화상자(에이전트별 설정 · 신뢰 발신자 추가 · 하루 상한)와 확인 대화상자(풀어 주기 · 켜기)다.
 * 역할: 멤버는 읽기만 · 관리자는 에이전트별 설정과 풀어 주기 · 소유자는 조직 설정(신뢰 발신자 · 자가 등록 · 알림)까지 — 최종 판정은 서버다.
 * 데이터는 전부 스크립트(`script/watch.ts`)가 `textContent` 로 그린다.
 */

import { icon, LI, P, settingsRow, skelRows, tip, viewHead } from '../kit';
import { AI_WATCH_SECTION } from './ai-watch';

/** 사이드바 · 화면 제목 — 한국어 `감시`, 영어 `Watch`. */
export const WATCH_LABEL = '감시';

/** 감시 메뉴 — [묶음, 이름, [섹션, 메뉴 이름]…]. 섹션 순서는 라우터 `WATCH_SECTIONS` 와 같다(테스트). 메뉴 이름 = 섹션 제목(F34). */
export const WATCH_NAV: ReadonlyArray<readonly [string, string, ReadonlyArray<readonly [string, string]>]> = [
  [
    'mail',
    '메일',
    [
      ['held', '보류된 메일'],
      ['trusted', '신뢰 발신자'],
      ['ai', 'AI 의심 메일 감시'],
    ],
  ],
  [
    'agent',
    '에이전트',
    [
      ['agents', '에이전트별 설정'],
      ['signups', '가입한 곳'],
      ['enroll', '자가 등록'],
    ],
  ],
];

const WATCH_MENU =
  '<nav class="snav" id="wnav" aria-label="감시 메뉴">' +
  WATCH_NAV.map(
    ([g, label, items]) =>
      `<div class="snav-sec"><p class="snav-g" id="wng-${g}">${label}</p><ul aria-labelledby="wng-${g}">` +
      items.map(([sec, l]) => `<li><a href="#/watch/${sec}" id="nw-${sec}">${l}</a></li>`).join('') +
      '</ul></div>',
  ).join('') +
  '</nav>';

/** 차단 등급의 고정 처리 — 스위치가 아니라 한 줄(바꿀 수 없다). */
const BLOCK_FIXED = '<p class="wfix"><span class="lvl lvl-block">차단</span><span>늘 보류하고 늘 알립니다. 바꿀 수 없습니다.</span></p>';

/** 에이전트 고르기(목록 거르기) — 보류된 메일 · 가입한 곳이 같이 쓰는 모양. 옵션은 스크립트가 채운다. */
function agentFilter(id: string): string {
  return `<label class="field wfl" for="${id}"><span>에이전트</span><select id="${id}"><option value="">모든 에이전트</option></select></label>`;
}

// --- 보류된 메일 ------------------------------------------------------------------

const HELD_ROW = settingsRow(
  'w-held',
  'h-w-held',
  '보류된 메일',
  tip(
    'w-held',
    '보류된 메일 설명',
    // 감시 화면의 ⓘ 는 섹션마다 하나(F36 — 페이지 ⓘ 를 없애고 등급 설명을 여기로). 문단 셋.
    P('받은 메일은 전부 프롬프트 인젝션 탐지를 거칩니다. 차단 등급(뚜렷한 조종 시도 · 검사 실패)은 늘 보류하고, 위험 등급은 에이전트별 설정에 따라 보류합니다. 탐지가 모든 공격을 잡지는 못합니다.') +
      P('여기 나오는 메일은 에이전트에게 보이지 않습니다. 제목과 본문 대신 보낸 사람 도메인과 인증 여부만 보입니다. 수신 정책으로 막은 메일은 수신 로그에 있습니다.') +
      P('풀어 주면 에이전트가 읽을 수 있고, 그 뒤 처음 보내는 상대에게 가는 메일은 내 승인을 거칩니다. 검사를 마치지 못한 메일은 풀 수 없습니다.'),
  ),
  '',
  '<div class="ctl">' +
    agentFilter('hm-agent') +
    '<p class="stateline"><span class="lbl">보류된 메일</span><span class="num" id="hm-count">—</span></p></div>' +
    '<table class="tbl wht" id="hm-tbl"><thead><tr><th scope="col">에이전트</th><th scope="col">등급</th><th scope="col">이유</th>' +
    '<th scope="col">보낸 사람</th><th scope="col">시각</th><th scope="col"><span class="sr">동작</span></th></tr></thead>' +
    `<tbody id="hm-body">${skelRows(6, 3)}</tbody></table>` +
    '<div class="empty" id="hm-empty" hidden><p>보류된 메일이 없습니다.</p><p>차단되거나 보류된 메일이 오면 여기 보입니다.</p></div>' +
    '<div class="actions more"><button type="button" class="btn sm ghost" id="hm-more" hidden>더 보기</button></div>' +
    '<p class="msg" id="hm-msg" role="status"></p>',
);

// --- 신뢰 발신자 ------------------------------------------------------------------

const TRUSTED_ROW = settingsRow(
  'w-trusted',
  'h-w-trusted',
  '신뢰 발신자',
  tip(
    'w-trusted',
    '신뢰 발신자 설명',
    P('늘 주고받는 상대의 정상 메일이 위험으로 잡힐 때 씁니다. 정확한 주소나 도메인 하나씩 넣습니다. 도메인은 그 도메인만이고 하위 도메인은 따로 넣습니다.') +
      P('DMARC 인증을 통과하고, Reply-To가 있으면 From과 같은 도메인일 때만 건너뜁니다. 어긋나면 평소처럼 검사하고, 건너뛰어도 검사 기록은 남습니다.') +
      P('공용 메일 서비스 도메인은 누구나 주소를 만들 수 있어 도메인째로 넣을 수 없습니다. 정확한 주소를 넣으세요. 소유자만 바꿀 수 있습니다.'),
  ),
  '',
  '<div class="warnbox wwarn"><strong>이 목록의 발신자에게는 인젝션 탐지가 꺼집니다.</strong>' +
    '<p>DMARC를 통과하고 Reply-To가 같은 도메인일 때만 적용됩니다.</p></div>' +
    '<div class="ctl"><p class="stateline"><span class="lbl">발신자</span><span class="num" id="wt-count">—</span></p>' +
    `<div class="actions"><button type="button" class="btn sm ghost" id="wt-add" aria-haspopup="dialog" disabled>${icon('plus')}<span>추가</span></button></div></div>` +
    '<p class="small muted" id="wt-owner" hidden>소유자만 바꿀 수 있습니다.</p>' +
    '<table class="tbl wtt" id="wt-tbl"><thead><tr><th scope="col">발신자</th><th scope="col">종류</th><th scope="col">만든 날</th>' +
    `<th scope="col"><span class="sr">동작</span></th></tr></thead><tbody id="wt-body">${skelRows(3, 2)}</tbody></table>` +
    '<div class="empty" id="wt-empty" hidden><p>신뢰 발신자가 없습니다.</p><p>모든 받은 메일이 인젝션 탐지를 거칩니다.</p></div>' +
    '<p class="msg" id="wt-msg" role="status"></p>',
);

// --- 에이전트별 설정 ----------------------------------------------------------------

const AGENTS_ROW = settingsRow(
  'w-agents',
  'h-w-agents',
  '에이전트별 설정',
  tip(
    'w-agents',
    '에이전트별 설정 설명',
    P('위험 메일을 바로 전달하면 에이전트가 곧바로 읽고, 읽은 뒤 새 상대에게 보내는 메일은 내 승인을 거칩니다. 보류하면 내가 풀어 줄 때까지 숨깁니다.') +
      P('위험 메일 알림을 켜면 위험 메일이 올 때 소유자 메일로 알립니다. 관리자 이상이 바꿀 수 있습니다.') +
      P('발신 승인이 자동이면 정책(목록 · 한도)에 맞는 메일은 바로 나갑니다. 모두 내 승인 후면 바깥으로 가는 메일은 전부 내가 승인해야 나갑니다.'),
  ),
  '',
  BLOCK_FIXED +
    '<table class="tbl wat" id="pa-tbl"><thead><tr><th scope="col">에이전트</th><th scope="col">위험 메일</th><th scope="col">위험 메일 알림</th>' +
    `<th scope="col">발신 승인</th><th scope="col"><span class="sr">동작</span></th></tr></thead><tbody id="pa-body">${skelRows(5, 3)}</tbody></table>` +
    '<div class="empty" id="pa-empty" hidden><p>에이전트가 없습니다.</p></div>' +
    '<div class="actions more"><button type="button" class="btn sm ghost" id="pa-more" hidden>더 보기</button></div>' +
    '<p class="msg" id="pa-msg" role="status"></p>',
);

/** 스위치 한 줄(이름 · 상태 글자 · 스위치 + 아래 한 줄) — AI 의심 메일 감시와 같은 부품(`idsw aw-sw`). */
function switchRow(id: string, label: string): string {
  return (
    `<div class="idsw aw-sw"><div class="idsw-r"><span class="idsw-l" id="${id}-l">${label}</span>` +
    `<button type="button" class="switch" id="${id}" role="switch" aria-checked="false" aria-labelledby="${id}-l" aria-describedby="${id}-line" aria-disabled="true"><span class="knob" aria-hidden="true"></span></button>` +
    `<span class="small strong sw-st" id="${id}-st"></span></div>` +
    `<p class="small muted" id="${id}-line"></p></div>`
  );
}

// --- 가입한 곳 --------------------------------------------------------------------

const SIGNUPS_ROW = settingsRow(
  'w-signups',
  'h-w-signups',
  '가입한 곳',
  tip(
    'w-signups',
    '가입한 곳 설명',
    P('에이전트가 받은 가입 확인 · 환영 · 계정 생성 메일로 어디에 가입했는지 알아냅니다. DMARC 인증된 보낸 사람의 도메인만 셉니다.') +
      P('에이전트가 볼 수 있는 메일만 셉니다. 보류된 메일은 세지 않습니다. 제목과 본문은 여기 나오지 않습니다.') +
      P('알림은 소유자 메일로 갑니다. 하루에 보내는 알림 수에는 상한이 있습니다.'),
  ),
  '',
  switchRow('su-notify', '에이전트가 어딘가에 가입하면 알림') +
    '<div class="ctl wctl">' +
    agentFilter('su-agent') +
    '</div>' +
    '<table class="tbl sut" id="su-tbl"><thead><tr><th scope="col">서비스</th><th scope="col">에이전트</th><th scope="col">종류</th>' +
    `<th scope="col">만든 날</th><th scope="col">마지막 메일</th><th scope="col">메일 수</th></tr></thead><tbody id="su-body">${skelRows(6, 3)}</tbody></table>` +
    '<div class="empty" id="su-empty" hidden><p>아직 찾은 가입이 없습니다.</p><p>에이전트가 가입 확인 메일을 받으면 여기 보입니다.</p></div>' +
    '<div class="actions more"><button type="button" class="btn sm ghost" id="su-more" hidden>더 보기</button></div>' +
    '<p class="msg" id="su-msg" role="status"></p>',
);

// --- 자가 등록 --------------------------------------------------------------------

/** 자가 등록으로 태어난 에이전트의 고정 기본값(`src/admin/ops/enroll.ts` ③④ — 바꿀 수 없다). */
const ENROLL_DEFAULTS = LI([
  '발신: 허용 목록만(처음엔 비어 있음) · 모든 발송은 내 승인 후',
  '수신: 전체 · 위험 메일은 보류',
  '토큰: 보내기 · 읽기 · 자기 정보만(자가 등록 · 웹훅 · 감사 권한 없음)',
  '새 에이전트는 다시 자가 등록을 할 수 없습니다. 요금제의 에이전트 한도도 그대로입니다.',
]);

const ENROLL_ROW = settingsRow(
  'w-enroll',
  'h-w-enroll',
  '자가 등록',
  tip(
    'w-enroll',
    '자가 등록 설명',
    P('켜면, 자가 등록 권한(agents:enroll)을 받은 토큰을 가진 에이전트가 이 조직에 새 에이전트(주소 · 토큰 포함)를 스스로 만들 수 있습니다.') +
      P('권한은 토큰마다 따로 줍니다. 에이전트의 토큰 화면에서 새 토큰을 발급할 때 고릅니다. 소유자만 줄 수 있습니다.') +
      P('하루 상한은 지난 24시간 동안 이 조직에서 시도할 수 있는 횟수입니다. 실패한 시도도 셉니다.'),
  ),
  '',
  switchRow('we-switch', '자가 등록') +
    '<dl class="pl lim wcap"><div><dt>하루 상한</dt><dd class="lim-edit"><span id="we-cap" class="num">—</span>' +
    '<button type="button" class="btn link sm" id="we-cap-edit" aria-haspopup="dialog" disabled>변경</button></dd></div></dl>' +
    switchRow('we-notify', '새 에이전트가 생기면 알림') +
    `<div class="wdef"><h3>새 에이전트의 안전한 기본값</h3>${ENROLL_DEFAULTS}</div>` +
    '<p class="wtok small"><span>권한은 에이전트 토큰에서 줍니다.</span>' +
    `<a class="more" id="we-tokens" href="#/agents">토큰${icon('arrowRight')}</a></p>` +
    '<p class="msg" id="we-msg" role="status"></p>',
);

export const WATCH_VIEW =
  '<section class="view" id="v-watch" aria-labelledby="h-watch" hidden>' +
  viewHead('h-watch', WATCH_LABEL) +
  '<div class="sset">' +
  WATCH_MENU +
  '<div class="spanes">' +
  HELD_ROW +
  TRUSTED_ROW +
  AI_WATCH_SECTION +
  AGENTS_ROW +
  SIGNUPS_ROW +
  ENROLL_ROW +
  '</div></div>' +
  '</section>';

// --- 대화상자 -----------------------------------------------------------------------

/** 에이전트별 설정 — 위험 메일(두 카드) · 위험 알림(확인란) · 보내기(두 카드) · 차단 고정 한 줄. 바뀐 칸만 보낸다(`PATCH /api/agents/{id}/watch`). */
const DLG_WATCH_AGENT =
  '<dialog id="dlg-wagent" aria-labelledby="pg-title"><form id="pg-form" novalidate>' +
  '<div class="dh"><p class="kicker">에이전트별 설정</p><h3 id="pg-title"></h3></div>' +
  '<div class="db">' +
  '<fieldset class="rolepick wpick"><legend class="lbl">위험 메일</legend>' +
  '<label class="ropt" for="pg-rh-deliver"><input type="radio" name="pg-rh" id="pg-rh-deliver" value="deliver"><span class="ro-n">바로 전달</span>' +
  '<span class="ro-d">읽은 뒤 새 상대에게 보내는 메일은 내 승인을 거칩니다.</span></label>' +
  '<label class="ropt" for="pg-rh-hold"><input type="radio" name="pg-rh" id="pg-rh-hold" value="hold"><span class="ro-n">보류 후 내가 확인</span>' +
  '<span class="ro-d">내가 풀어 줄 때까지 에이전트에게 보이지 않습니다.</span></label>' +
  '</fieldset>' +
  '<label class="check" for="pg-notify"><input type="checkbox" id="pg-notify"><span>위험 메일이 오면 알림 받기<small class="caphint">소유자 메일로 알립니다.</small></span></label>' +
  '<fieldset class="rolepick wpick"><legend class="lbl">발신 승인</legend>' +
  '<label class="ropt" for="pg-sa-auto"><input type="radio" name="pg-sa" id="pg-sa-auto" value="auto"><span class="ro-n">자동</span>' +
  '<span class="ro-d">정책(목록 · 한도)에 맞으면 바로 보냅니다.</span></label>' +
  '<label class="ropt" for="pg-sa-always"><input type="radio" name="pg-sa" id="pg-sa-always" value="always"><span class="ro-n">모두 내 승인 후</span>' +
  '<span class="ro-d">바깥으로 가는 메일은 내가 승인해야 나갑니다.</span></label>' +
  '</fieldset>' +
  BLOCK_FIXED +
  '<p class="msg" id="pg-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="pg-cancel">취소</button><button type="submit" class="btn" id="pg-go">저장</button></div>' +
  '</form></dialog>';

/**
 * 신뢰 발신자 추가 — 칸 하나 · 경고 상자 · 확인란(확인해야 추가가 열린다). 공용 메일 도메인은 칸 바로 아래에서 거절하고 정확한 주소를 권한다
 * (서버 `trusted_sender_freemail_domain` 도 같은 자리).
 */
const DLG_TRUST_ADD =
  '<dialog id="dlg-wtrust" aria-labelledby="wt-title"><form id="wt-form" novalidate>' +
  '<div class="dh"><h3 id="wt-title">신뢰 발신자 추가</h3></div>' +
  '<div class="db">' +
  '<label class="field" for="wt-in"><span>주소 또는 도메인</span>' +
  '<input type="text" id="wt-in" maxlength="320" spellcheck="false" autocapitalize="off" autocomplete="off" inputmode="email" placeholder="billing@partner.example · partner.example">' +
  '<small>도메인은 그 도메인만입니다. 하위 도메인은 따로 넣습니다.</small></label>' +
  '<div class="warnbox"><strong>이 발신자의 메일은 인젝션 탐지를 건너뜁니다.</strong>' +
  '<p>DMARC를 통과하고 Reply-To가 같은 도메인일 때만 건너뜁니다. 그 밖에는 평소처럼 검사합니다.</p></div>' +
  '<label class="check" for="wt-ack"><input type="checkbox" id="wt-ack"><span>이 발신자의 메일이 탐지를 건너뛰는 것을 확인했습니다</span></label>' +
  '<p class="msg" id="wt-dmsg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="wt-cancel">취소</button><button type="submit" class="btn" id="wt-go" disabled>추가</button></div>' +
  '</form></dialog>';

/** 자가 등록 하루 상한 — 칸 하나(1~최대, 지금 값으로 채워 연다). */
const DLG_ENROLL_CAP =
  '<dialog id="dlg-wcap" aria-labelledby="wc-title"><form id="wc-form" novalidate>' +
  '<div class="dh"><h3 id="wc-title">하루 상한 변경</h3></div>' +
  '<div class="db">' +
  '<label class="field" for="wc-n"><span>하루에 시도할 수 있는 자가 등록</span><input type="number" id="wc-n" min="1" step="1" inputmode="numeric"><small id="wc-hint"></small></label>' +
  '<p class="small muted">지난 24시간 동안의 시도를 셉니다. 실패한 시도도 셉니다.</p>' +
  '<p class="msg" id="wc-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="wc-cancel">취소</button><button type="submit" class="btn" id="wc-go">저장</button></div>' +
  '</form></dialog>';

export const WATCH_DIALOGS = DLG_WATCH_AGENT + DLG_TRUST_ADD + DLG_ENROLL_CAP;
