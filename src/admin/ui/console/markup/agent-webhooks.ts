/**
 * src/admin/ui/console/markup/agent-webhooks.ts — 웹훅 `#/agents/{id}/webhooks`(2026-09-30). 주소 탭 바로 뒤의 에이전트 탭이다.
 *
 * 한 화면에 두 절: ① 엔드포인트 표(URL · 구독 이벤트 · 마지막 전달 · 비밀값 버전 · 만든 날 · 행마다 ⋯ 메뉴 = 비밀값 교체 · 삭제)와 한도 한 줄
 * (`GET …/webhooks` 의 `limits{active,activeMax,registrationsToday,registrationsMax}` 그대로 · 등록 수는 최근 24시간 — 화면이 숫자를 지어내지 않는다) ② 전달 기록
 * (최근 전달 · 웹훅 필터 · `더 보기` 커서 · 재시도가 끝난 행의 `다시 보내기`).
 *
 * 더하는 흐름은 버튼 → 대화상자(`dlg-webhook` — https 주소 · 이벤트 체크박스 · "본문에는 ID와 시각만" 한 줄) → 비밀값은 **한 번만** 보이는
 * 창(`dlg-whsecret` — 토큰 창과 같은 모양: 복사 버튼 · "다시 볼 수 없습니다" 한 줄 · 닫으면 DOM·변수에서 지운다). 비밀값 교체도 같은 창으로
 * 끝난다(확인 대화상자에서 이전 값이 24시간 더 통한다고 말한다). 삭제는 빨간 확인 대화상자(되돌릴 수 없다).
 * member(읽기 전용)에게는 추가·교체·삭제·다시 보내기가 없다(스크립트 `webhooks.ts` · `org.ts` MUT_ADMIN).
 *
 * 인증 헤더(선택, 202610141400): 추가 대화상자의 선택 칸(`wh-auth` — 가린 입력) · 행 메뉴의 "인증 헤더 설정/교체 · 삭제" → `dlg-whauth`(같은 가린
 * 입력 하나). 값은 저장 뒤 다시 보이지 않는다 — 표의 비밀값 칸 아래에 힌트(`Bearer …wxyz`)만 보인다.
 */

import { P, secHead, skelRows, tip, viewHead } from '../kit';

/**
 * 인증 헤더 입력 칸 — 가린 입력(어깨 너머로 보이지 않게) · 비밀번호 관리자가 저장하지 않게(`autocomplete=off` · `data-1p-ignore`). 규칙 위반은 칸 아래.
 */
const AUTH_FIELD = (id: string, label: string): string =>
  '<label class="field whauth" for="' + id + '"><span>' + label + '</span>' +
  '<input type="password" id="' + id + '" maxlength="2048" autocomplete="off" spellcheck="false" autocapitalize="off" data-1p-ignore data-lpignore="true" placeholder="Bearer …">' +
  '<small>받는 서버가 인증을 요구할 때만 넣으세요. 헤더 값 전체를 모든 전달에 싣고, 저장한 뒤에는 끝 네 글자만 보입니다.</small></label>';

export const A_WEBHOOKS =
  '<div class="pane" id="t-webhooks" hidden>' +
  viewHead('h-ag-wh', '웹훅', {
    count: '<span class="hcount num" id="wh-lim"></span>',
    tip: tip(
      'wh',
      '웹훅 설명',
      P('이벤트가 생기면 Atmark가 등록한 https 주소로 POST 요청을 보냅니다. 요청마다 이 웹훅의 비밀값으로 만든 서명이 붙습니다.') +
        P('전달에 실패하면 시간을 두고 다시 보냅니다. 같은 이벤트가 두 번 올 수 있으니 수신 서버는 이벤트 ID로 중복을 거르세요.'),
    ),
    actions: '<button type="button" class="btn" id="wh-add" aria-haspopup="dialog" hidden>웹훅 추가</button>',
  }) +
  '<table class="tbl whk" id="wh-tbl"><thead><tr><th scope="col">URL</th><th scope="col">마지막 전달</th>' +
  '<th scope="col">비밀값</th><th scope="col">만든 날</th><th scope="col"><span class="sr">동작</span></th></tr></thead>' +
  '<tbody id="wh-body">' + skelRows(5, 2) + '</tbody></table>' +
  '<div class="empty" id="wh-empty" hidden><p>웹훅이 없습니다.</p><p>메일을 보내고 받거나 승인이 끝나면 등록한 주소로 알려 줍니다.</p>' +
  '<button type="button" class="btn sm" id="wh-add-empty" aria-haspopup="dialog" hidden>웹훅 추가</button></div>' +
  '<p class="msg" id="wh-msg" role="status"></p>' +
  '<section class="wdsec" id="wd-sec" aria-labelledby="h-wd">' +
  secHead(
    'h-wd',
    '전달 기록',
    '',
    '<label class="whf" for="wd-f"><span class="lbl">웹훅</span><select id="wd-f"><option value="">모든 웹훅</option></select></label>',
  ) +
  '<table class="tbl dense whd" id="wd-tbl"><thead><tr><th scope="col">이벤트</th><th scope="col">상태</th><th scope="col">시도</th>' +
  '<th scope="col">HTTP</th><th scope="col">URL</th><th scope="col">시각</th><th scope="col"><span class="sr">동작</span></th></tr></thead>' +
  '<tbody id="wd-body">' + skelRows(7, 2) + '</tbody></table>' +
  '<div class="empty" id="wd-empty" hidden><p>전달 기록이 없습니다.</p></div>' +
  '<div class="actions lgmore"><button type="button" class="btn ghost sm" id="wd-more" hidden>더 보기</button></div>' +
  '<p class="msg" id="wd-msg" role="status"></p>' +
  '</section></div>';

/**
 * 웹훅 추가 대화상자 — URL(https 만 · 모양 오류는 칸 바로 아래) · 이벤트 체크박스(목록은 서버의 `availableEventTypes`, 기본 넷이 켜진 채 —
 * 스크립트가 연 때마다 다시 그린다) · 한도 두 줄 · "본문에는 ID와 시각만" 한 줄. 하나도 고르지 않으면 추가가 잠긴다.
 */
export const DLG_WEBHOOK =
  '<dialog id="dlg-webhook" aria-labelledby="wa-title"><form id="wa-form" novalidate>' +
  '<div class="dh"><h3 id="wa-title">웹훅 추가</h3></div>' +
  '<div class="db">' +
  '<label class="field" for="wh-url"><span>URL</span><input type="text" id="wh-url" maxlength="2048" inputmode="url" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="https://…/hooks/atmark">' +
  '<small>https 주소만 됩니다.</small></label>' +
  '<fieldset class="capset evset" id="wa-evts-w"><legend class="lbl">이벤트</legend><div id="wa-evts"></div>' +
  '<small class="capnote" id="wa-none" hidden>이벤트를 하나 이상 고르세요.</small></fieldset>' +
  '<p class="small muted">이벤트 본문에는 ID와 시각만 담깁니다. 메일 주소·제목·본문은 담기지 않습니다.</p>' +
  AUTH_FIELD('wh-auth', '인증 헤더 (선택)') +
  '<dl class="kv aq"><dt>활성</dt><dd class="num" id="wa-active">—</dd><dt>24시간 등록</dt><dd class="num" id="wa-today">—</dd></dl>' +
  '<p class="msg" id="wa-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="wa-cancel">취소</button><button type="submit" class="btn" id="wa-go">추가</button></div>' +
  '</form></dialog>';

/**
 * 비밀값 창 — 추가·교체 직후 **한 번만**(토큰 창 `dlg-token` 과 같은 모양: `.dh.once` · `.tokenbox` + 복사 · 닫기 하나). 닫으면(버튼 · Esc)
 * 비밀값을 DOM 과 변수에서 지운다. 교체였으면 이전 비밀값이 언제까지 통하는지(`previousValidUntil`) 한 줄을 더 보인다.
 */
export const DLG_WHSECRET =
  '<dialog id="dlg-whsecret" aria-labelledby="ws-title">' +
  '<div class="dh once"><p class="kicker" id="ws-kicker"></p><h3 id="ws-title">비밀값은 지금 한 번만 보입니다</h3></div>' +
  '<div class="db">' +
  '<p>이 비밀값은 다시 볼 수 없습니다.</p>' +
  '<dl class="kv"><dt>URL</dt><dd id="ws-url" class="mono"></dd><dt id="ws-prev-t" hidden>이전 비밀값</dt><dd id="ws-prev" hidden></dd></dl>' +
  '<span class="lbl">서명 비밀값</span>' +
  '<div class="tokenbox"><code id="ws-secret"></code><button type="button" class="btn" id="ws-copy">복사</button></div>' +
  '<p class="small muted">수신 서버가 요청 서명을 확인할 때 씁니다.</p>' +
  '</div>' +
  '<div class="df"><button type="button" class="btn ghost" id="ws-close">닫기</button></div>' +
  '</dialog>';

/** 인증 헤더 설정·교체 — 가린 입력 하나. 삭제는 행 메뉴의 확인 대화상자다. */
export const DLG_WHAUTH =
  '<dialog id="dlg-whauth" aria-labelledby="wz-title"><form id="wz-form" novalidate>' +
  '<div class="dh"><h3 id="wz-title">인증 헤더 설정</h3></div>' +
  '<div class="db">' +
  '<dl class="kv"><dt>URL</dt><dd id="wz-url" class="mono"></dd><dt id="wz-cur-t" hidden>지금 값</dt><dd id="wz-cur" class="mono" hidden></dd></dl>' +
  AUTH_FIELD('wz-auth', '새 값') +
  '<p class="msg" id="wz-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="wz-cancel">취소</button><button type="submit" class="btn" id="wz-go">저장</button></div>' +
  '</form></dialog>';
