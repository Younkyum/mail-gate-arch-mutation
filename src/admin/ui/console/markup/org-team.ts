/**
 * src/admin/ui/console/markup/org-team.ts — 사용자·멤버십(`extensibility-p0-p1.md` §4): 조직 고르기 화면 `#/select-org` ·
 * 설정의 `멤버`·`조직 API 키` 행 · 대화상자(새 조직 · 초대 · 조직 키 발급/이름 · 조직 키 평문 한 번만).
 *
 * 규율은 다른 조각과 같다: 정적 문자열만(데이터는 스크립트가 `textContent` 로) · 문구는 한 줄 + ⓘ(R2 · R5) · 지금 누르는 동작의
 * 결과는 확인 대화상자에(R6) · 장식 번호 없음(R10). 조직 키 화면은 에이전트 토큰 화면과 **섞지 않는다**(§4-4 — 접두사·표·권한이 다르다).
 */

import { P, prop, settingsRow, skelRows, tip, viewHead } from '../kit';

/** 조직 키로 부르는 CI 표면(§3.7, F-4) — 콘솔 호스트의 `/org-api/v1`. 화면에 **표시만** 한다(콘솔 스크립트가 부르는 곳이 아니다). */
export const ORG_API_URL = 'https://console.atmark.ai/org-api/v1';

/** 조직 키 권한(§3.7 · ADR-0014 M3b) — 서버 `org_api_keys.capabilities ⊆ {agents:read, agents:create, domains:manage}` 와 같은 세 개. */
const ORG_KEY_CAPS: ReadonlyArray<readonly [string, string]> = [
  ['agents:read', '에이전트 읽기'],
  ['agents:create', '에이전트 만들기'],
  ['domains:manage', '도메인 관리'],
];

// --- 조직 고르기 ------------------------------------------------------------------

/** 로그인 착지가 `next:'select-org'` 일 때 오는 화면. 행 = 조직 하나(이름 · 내 역할 · 검토 상태). 고르면 세션을 그 조직으로 바꾼다. */
export const SELECT_ORG_VIEW =
  '<section class="view" id="v-select-org" aria-labelledby="h-select-org" hidden>' +
  viewHead('h-select-org', '조직 고르기', {
    tip: tip('select-org', '조직 고르기 설명', P('이 주소로 들어갈 수 있는 조직입니다. 고른 조직으로 콘솔이 다시 열립니다.') + P('나중에 상단의 조직 이름을 눌러 바꿀 수 있습니다.')),
    actions: '<button type="button" class="btn ghost" id="so-new">새 조직 만들기</button>',
  }) +
  '<ul class="orglist" id="so-list"></ul>' +
  '<p class="msg" id="so-msg" role="status"></p>' +
  '</section>';

// --- 설정: 멤버 --------------------------------------------------------------------

export const MEMBERS_ROW = settingsRow(
  's-members',
  'h-members',
  '멤버와 초대',
  tip(
    'members',
    '멤버 설명',
    P('소유자는 멤버·초대·조직 API 키까지 전부, 관리자는 에이전트·토큰·정책을, 멤버는 읽기만 합니다.') +
      P('주 소유자는 승인 알림을 받는 주소라 역할을 바꾸거나 제거할 수 없습니다.') +
      P('초대는 7일 뒤 만료됩니다. 운영자가 거절하거나 보류한 조직은 초대를 보낼 수 없습니다. 초대 메일에는 조직 이름이 들어가지 않습니다.'),
  ),
  '',
  '<div class="ctl"><p class="stateline"><span class="lbl">인원</span><span class="num" id="mb-count">—</span></p>' +
    '<div class="actions"><button type="button" class="btn sm ghost" id="mb-invite" aria-haspopup="dialog">초대</button></div></div>' +
    '<table class="tbl mbt" id="mb-tbl"><thead><tr><th scope="col">주소</th><th scope="col">역할</th><th scope="col">참여한 날</th>' +
    '<th scope="col"><span class="sr">동작</span></th></tr></thead><tbody id="mb-body">' + skelRows(4) + '</tbody></table>' +
    '<div class="subsec" id="inv-w" hidden><div class="lh"><h3>대기 중인 초대</h3><span class="num small muted" id="inv-n"></span></div>' +
    '<table class="tbl mbt" id="inv-tbl"><thead><tr><th scope="col">주소</th><th scope="col">역할</th><th scope="col">만료</th>' +
    '<th scope="col"><span class="sr">동작</span></th></tr></thead><tbody id="inv-body"></tbody></table></div>' +
    '<p class="msg" id="mb-msg" role="status"></p>',
  '',
  '<div class="actions mb-leave"><button type="button" class="btn sm link" id="mb-leave" hidden>이 조직에서 나가기</button></div>',
);

// --- 설정: 조직 API 키 ---------------------------------------------------------------

export const KEYS_ROW = settingsRow(
  's-keys',
  'h-keys',
  '조직 API 키',
  tip(
    'keys',
    '조직 API 키 설명',
    P('CI·스크립트가 에이전트를 만들고 읽을 때 쓰는 조직 단위 키입니다. 에이전트 토큰과 다르고, 콘솔 주소의 <code>/org-api/v1</code> 에서만 받습니다.') +
      P('Atmark는 키 원문을 보관하지 않아 발급 직후 한 번만 보입니다. 조직당 활성 키 수는 요금제가 정합니다(최대 5개).'),
  ),
  '',
  '<div class="ctl" id="ok-ctl"><p class="stateline"><span class="lbl">활성</span><span class="num" id="ok-count">—</span></p>' +
    '<div class="actions"><button type="button" class="btn sm ghost" id="ok-new" aria-haspopup="dialog">키 발급</button></div></div>' +
    '<p class="small muted" id="ok-owner" hidden>소유자만 조직 API 키를 보고 관리합니다.</p>' +
    '<table class="tbl okt" id="ok-tbl" hidden><thead><tr><th scope="col">이름</th><th scope="col">키 값</th><th scope="col">권한</th>' +
    '<th scope="col">만든 사람</th><th scope="col">마지막 사용</th><th scope="col">만료</th><th scope="col"><span class="sr">동작</span></th></tr></thead>' +
    '<tbody id="ok-body">' + skelRows(7) + '</tbody></table>' +
    `<div class="empty" id="ok-empty" hidden><p>조직 API 키가 없습니다.</p><button type="button" class="btn sm" id="ok-cta" aria-haspopup="dialog">키 발급</button></div>` +
    '<p class="msg" id="ok-msg" role="status"></p>',
);

// --- 대화상자 -----------------------------------------------------------------------

/** 새 조직(F-3: 기존 사용자의 새 조직은 콘솔에서만). 만들면 세션이 그 조직으로 바뀌고 콘솔이 다시 열린다. */
const DLG_NEW_ORG =
  '<dialog id="dlg-neworg" aria-labelledby="no-title"><form id="no-form" novalidate>' +
  '<div class="dh"><h3 id="no-title">새 조직 만들기</h3></div>' +
  '<div class="db">' +
  '<label class="field" for="no-name"><span>조직 이름</span><input type="text" id="no-name" maxlength="160" autocomplete="organization" spellcheck="false">' +
  '<small>콘솔과 메일에 보입니다. 80자까지.</small></label>' +
  '<p class="small muted">새 조직은 바로 활성이고 Free 요금제로 시작합니다. 내가 소유자가 됩니다.</p>' +
  '<p class="msg" id="no-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="no-cancel">취소</button><button type="submit" class="btn" id="no-go">만들기</button></div>' +
  '</form></dialog>';

/** 초대(owner) — 주소 + 역할(관리자 | 멤버). 받는 사람은 초대 메일 → 로그인 메일 두 통을 받는다(I1). */
const DLG_INVITE =
  '<dialog id="dlg-invite" aria-labelledby="in-title"><form id="in-form" novalidate>' +
  '<div class="dh"><h3 id="in-title">멤버 초대</h3></div>' +
  '<div class="db">' +
  '<label class="field" for="in-email"><span>이메일</span><input type="email" id="in-email" maxlength="254" autocomplete="off" inputmode="email" spellcheck="false" autocapitalize="off"></label>' +
  '<fieldset class="rolepick"><legend class="lbl">역할</legend>' +
  '<label class="ropt" for="in-r-member"><input type="radio" name="in-role" id="in-r-member" value="member" checked><span class="ro-n">멤버</span><span class="ro-d">보기만 합니다.</span></label>' +
  '<label class="ropt" for="in-r-admin"><input type="radio" name="in-role" id="in-r-admin" value="admin"><span class="ro-n">관리자</span><span class="ro-d">에이전트·토큰·정책을 바꿉니다.</span></label>' +
  '</fieldset>' +
  '<p class="small muted">초대 메일의 링크를 연 뒤, 로그인 메일을 한 번 더 받습니다.</p>' +
  '<p class="msg" id="in-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="in-cancel">취소</button><button type="submit" class="btn" id="in-go">초대</button></div>' +
  '</form></dialog>';

/** 조직 키 발급 · 이름 바꾸기(같은 폼 — 이름 바꾸기에서는 권한·만료를 숨긴다). 권한은 하나 이상(서버도 빈 배열을 거부한다). */
const DLG_ORG_KEY =
  '<dialog id="dlg-orgkey" aria-labelledby="ko-title"><form id="ko-form" novalidate>' +
  '<div class="dh"><h3 id="ko-title">키 발급</h3></div>' +
  '<div class="db">' +
  '<label class="field" for="ko-label"><span>이름</span><input type="text" id="ko-label" maxlength="60" autocomplete="off" spellcheck="false" placeholder="github-actions">' +
  '<small>쓰는 곳을 알아볼 이름, 60자까지</small></label>' +
  '<fieldset class="capset" id="ko-caps-w"><legend class="lbl">권한</legend>' +
  ORG_KEY_CAPS.map(([v, label], i) => `<label class="check" for="ko-cap-${String(i)}"><input type="checkbox" id="ko-cap-${String(i)}" value="${v}"${v === 'domains:manage' ? '' : ' checked'}><span>${label} <code>${v}</code></span></label>`).join('') +
  '</fieldset>' +
  '<label class="field" id="ko-exp-w" for="ko-exp"><span>만료</span><select id="ko-exp"><option value="">만료 없음</option><option value="30">30일</option><option value="90">90일</option><option value="365">365일</option></select></label>' +
  '<p class="msg" id="ko-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="ko-cancel">취소</button><button type="submit" class="btn" id="ko-go">발급</button></div>' +
  '</form></dialog>';

/** 조직 키 평문 — 한 번만(토큰 창과 같은 규율: 닫으면 DOM·변수에서 지운다). */
const DLG_ORG_KEY_SHOW =
  '<dialog id="dlg-okshow" aria-labelledby="ks-title">' +
  '<div class="dh hatch"><p class="kicker" id="ks-kicker">조직 API 키</p><h3 id="ks-title">키는 지금 한 번만 보입니다</h3></div>' +
  '<div class="db">' +
  '<p>이 창을 닫으면 키를 다시 볼 수 없습니다.</p>' +
  `<dl class="kv"><dt>이름</dt><dd id="ks-name"></dd><dt>권한</dt><dd id="ks-caps"></dd><dt>엔드포인트</dt><dd class="mono">${ORG_API_URL}</dd></dl>` +
  '<span class="lbl">ATMARK_ORG_KEY</span>' +
  '<div class="tokenbox"><code id="ks-key"></code><button type="button" class="btn" id="ks-copy">복사</button></div>' +
  '<span class="lbl">예시</span><pre class="snippet" id="ks-ex"></pre>' +
  '</div>' +
  '<div class="df"><button type="button" class="btn ghost" id="ks-close">닫기</button></div>' +
  '</dialog>';

export const TEAM_DIALOGS = DLG_NEW_ORG + DLG_INVITE + DLG_ORG_KEY + DLG_ORG_KEY_SHOW;

/** 설정의 조직 행 칸 — 내 역할을 조직 사실 줄에 더한다(멤버십이 생긴 뒤 "누구로 보고 있나"). */
export const ORG_ROLE_PROP = prop('내 역할', 'so-role');
