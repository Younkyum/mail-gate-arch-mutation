/**
 * src/admin/ui/invite.ts — `GET /invite`(초대 링크 착지) — `console.atmark.ai`. `extensibility-p0-p1.md` §3.3 · §4-9 · 결정 I1(두 통 흐름).
 *
 * 초대 메일의 링크는 **세션을 만들지 않는다.** 이 페이지는 사람이 버튼을 누를 때만 `POST /api/invites/claim {token}` 을 보내고, 서버는
 * 초대받은 주소로 **이 브라우저에 결속된** 로그인 코드 메일을 보낸다(로그인 논스 쿠키). 그 코드를 이 화면에 입력하면 verify 가
 * 멤버십을 만들고 세션을 그 조직으로 연다. 그래서 초대 링크만 가진 사람(전달받은 사람·메일 스캐너)은 아무것도 할 수 없다.
 * (초대 링크는 2026-10-10 의 링크 로그인 삭제 뒤에도 남는다 — 로그인 링크가 아니라 "코드 메일을 보내 달라" 는 버튼이다.)
 *
 * 로그인 착지(`login.ts`)와 같은 규율: ① 토큰은 URL **프래그먼트**에 있고 읽자마자 주소창에서 지운다 ② GET 은 아무것도 바꾸지 않는다
 * ③ 상태 변경(claim — 메일 발송)은 버튼을 눌러야 나간다 ④ 서명·만료·대기 상태가 아닌 초대는 서버가 `401 invite_invalid` 하나로 답한다
 * (토큰을 가진 쪽이 이미 아는 정보라 나누지 않는다). 초대 메일에는 조직 이름이 없으므로 이 화면에도 없다(F-2 — 이름은 로그인 뒤 콘솔에서만).
 * 프래그먼트는 `#<토큰>` 과 `#t=<토큰>` 둘 다 받는다.
 */

import type { Lang } from './i18n';
import { codeForm, codeScript } from './login';
import { buildPage, LANG_SWITCH, LOGO, type AdminUiPage } from './page';

/** 막다른 화면의 다음 길(F68) — 주 동작 하나(로그인으로) + 지원 주소. */
const NEXT =
  '<div class="actions"><a class="btn" href="/">로그인으로</a></div>' +
  '<p class="muted small">계속 안 되면 <a href="mailto:support@atmark.ai">support@atmark.ai</a>로 알려 주세요.</p>';

const INVITE_BODY =
  '<div class="shell">' +
  `<header>${LOGO}${LANG_SWITCH}</header>` +
  '<main>' +
  // 처음 보는 화면은 설명 없이 — 제목 · 주 버튼 · 결과·오류뿐(진윤겸 2026-09-27). 예외 한 줄: 전달받은 초대를 따라 누르지 않게 하는
  //   경고(적대적 검토 L4 — 보안 단언)는 버튼 앞에 한 문장으로 남긴다.
  '<h1>조직 초대</h1>' +
  '<section id="go" hidden>' +
  '<p class="note" id="own">이 초대가 당신 주소로 온 것일 때만 계속하세요.</p>' +
  '<div class="actions"><button type="button" class="btn" id="b" disabled>로그인 코드 받기</button></div>' +
  '</section>' +
  // 보낸 뒤 — 로그인 메일의 6자리 코드를 여기서 받는다(로그인 화면과 같은 입력란 · 같은 verify). 메일에는 코드만 있다.
  '<section class="panel" id="sent" hidden aria-live="polite"><h2>메일을 확인하세요</h2>' +
  codeForm('로그인', '조직 멤버가 가득 찼습니다. 초대한 사람에게 알려 주세요.') +
  '<p class="muted">코드는 15분 동안 한 번 쓸 수 있습니다.</p></section>' +
  '<section class="panel" id="m0" hidden><h2>링크가 온전하지 않습니다</h2>' +
  '<p class="muted">메일의 링크를 그대로 다시 열어 주세요. 주소 끝의 <code>#</code> 뒤까지 있어야 합니다.</p>' + NEXT + '</section>' +
  '<section class="panel" id="m1" hidden><h2>만료됐거나 취소된 초대입니다</h2>' +
  '<p class="muted">초대는 7일 동안만 쓸 수 있습니다. 초대한 사람에게 새 초대를 요청하세요.</p>' + NEXT + '</section>' +
  '<section class="panel" id="m2" hidden><h2>요청이 너무 잦습니다</h2>' +
  '<p class="muted">몇 분 뒤 메일의 링크를 다시 열어 주세요.</p></section>' +
  '<section class="panel" id="m3" hidden><h2>로그인 코드를 보내지 못했습니다</h2>' +
  '<p class="muted">서버에 닿지 못했거나 오류가 났습니다. 잠시 뒤 메일의 링크를 다시 열어 보세요.</p>' + NEXT + '</section>' +
  '<noscript><p class="note">이 페이지는 자바스크립트가 필요합니다.</p></noscript>' +
  '</main>' +
  '</div>';

const INVITE_SCRIPT = String.raw`(function(){
'use strict';
var d=document,g=function(i){return d.getElementById(i);},h=location.hash.slice(1);
function show(k){['go','sent','m0','m1','m2','m3'].forEach(function(i){g(i).hidden=(i!==k);});}
history.replaceState(null,'',location.pathname+location.search);
if(h.indexOf('t=')===0)h=h.slice(2);
/* atk_invite_<kid>.<payload>.<sig> (p0p1-api s2) - the shape check below is the same as the login landing's. */
if(!h||h.length>2048||/[^A-Za-z0-9._~%+/=_-]/.test(h)){h='';show('m0');return;}
show('go');var b=g('b');b.disabled=false;b.focus();
b.addEventListener('click',function(){
  if(!h)return;
  b.disabled=true;b.classList.add('busy');
  var t=h;h='';
  fetch('/api/invites/claim',{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},
    body:JSON.stringify({token:t}),credentials:'same-origin',cache:'no-store',redirect:'error'})
  .then(function(r){
    if(r.status===202||r.status===200){show('sent');CODE_RESET();ci.focus();return;}
    show(r.status===429?'m2':(r.status===400||r.status===401||r.status===404||r.status===410)?'m1':'m3');
  })
  .catch(function(){show('m3');});
});
${codeScript('/api/login/verify', 'login_browser_missing', 'member_limit')}
})();`;

export const INVITE_PARTS = { title: 'Atmark — 조직 초대', bodyClass: 'p-landing', body: INVITE_BODY, script: INVITE_SCRIPT };

export const ADMIN_INVITE_PAGES: Readonly<Record<Lang, AdminUiPage>> = {
  ko: buildPage(INVITE_PARTS, 'ko'),
  en: buildPage(INVITE_PARTS, 'en'),
};
