/**
 * src/admin/ui/login.ts — `GET /`(로그인)과 `GET /login`(옛 로그인 링크 착지 — 안내만) — `console.atmark.ai`.
 *
 * **로그인** — 이메일 하나를 `POST /api/login` 으로 보내고, 응답이 무엇이든(서버는 항상 202) **같은 문구**
 * "메일을 확인하세요" 를 보인다. 그 주소가 콘솔 사용자(어느 조직의 멤버)인지를 화면이 새지 않게(열거 방지).
 * 착지의 verify 가 `next:'select-org'`(조직이 여럿)면 `/app#/select-org` 로 간다(P0 §3.2). 서버가
 * 아예 닿지 않은 경우(네트워크)와 429 만 다르게 말한다 — 둘 다 주소와 무관하다.
 *
 * **코드만(2026-09-28 코드 · 2026-10-10 링크 삭제)** — 보낸 뒤 같은 화면에 6자리 코드 입력란(`inputmode=numeric` · `autocomplete=one-time-code` ·
 * 붙여 넣은 공백·하이픈은 떼고 보낸다)을 보인다. 메일을 휴대폰에서 읽어도 코드를 이 브라우저에 옮겨 적으면 된다. 메일에는 링크가 없다.
 * 서버는 틀림·만료·5회 초과·없는 주소를 가리지 않는 401 `login_code_invalid` 하나로 답하고, 화면도 한 문장이다(열거 방지). 5번 틀린 뒤의
 * "새로 받으세요" 는 화면이 **스스로 센** 횟수로만 보인다(서버의 계수를 묻지 않는다).
 *
 * **착지(`/login`)** — 로그인 링크는 2026-10-10 에 없앴다(진윤겸: "링크 로그인은 이제 삭제할거야. 너무 복잡해."). 옛 메일의 링크(`/login#atk_login_…`)
 *   를 열면 이 페이지가 "더는 쓰지 않는 링크 — 코드로 로그인하세요" 를 말하고 로그인 화면으로 보낸다. **서버에 아무것도 보내지 않는다** — 토큰은
 *   읽지 않고 주소창에서 지울 뿐이다(서버도 `{token}` 을 410 `login_link_retired` 로 닫는다).
 */

import type { Lang } from './i18n';
import { icon } from './console/kit';
import { buildPage, LANG_SWITCH, LOGO, type AdminUiPage } from './page';

/**
 * 코드 입력(로그인·초대·가입 화면이 같이 쓴다) — 한 칸 · 숫자 자판 · 메일 앱의 코드 자동 채움. 오류 문구는 한 문장씩(열거 방지 — 서버가
 * 가리지 않는 것을 화면도 가리지 않는다). `c2` 는 이 화면이 스스로 센 5번째 실패 뒤에만. `c5` 는 409(초대: 멤버 상한 · 가입: 새 조직 상한 —
 * 둘 다 코드가 맞은 뒤에만 나오고, 코드는 쓰이지 않았다). `c6` 은 요청자 상한 429(주소와 무관).
 */
export function codeForm(button: string, conflict: string): string {
  return (
    '<form id="cf" novalidate>' +
    '<label class="field" for="code"><span>메일로 받은 6자리 코드</span>' +
    '<input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required spellcheck="false" autocapitalize="off" autocorrect="off"></label>' +
    `<div class="actions"><button type="submit" class="btn" id="cgo">${button}</button></div>` +
    '<p class="msg err" id="c0" role="alert" hidden>메일의 6자리 숫자를 입력하세요.</p>' +
    '<p class="msg err" id="c1" role="alert" hidden>코드가 맞지 않거나 만료됐습니다. 다시 확인하세요.</p>' +
    '<p class="msg err" id="c2" role="alert" hidden>여러 번 틀렸습니다. 새 코드를 받으세요.</p>' +
    '<p class="msg err" id="c3" role="alert" hidden>이 브라우저에서 요청한 코드가 아닙니다. 이 브라우저에서 새 코드를 받으세요.</p>' +
    '<p class="msg err" id="c4" role="alert" hidden>서버에 닿지 못했습니다. 연결을 확인하고 다시 시도하세요.</p>' +
    `<p class="msg err" id="c5" role="alert" hidden>${conflict}</p>` +
    '<p class="msg err" id="c6" role="alert" hidden>요청이 너무 잦습니다. 몇 분 뒤 다시 시도하세요.</p>' +
    '</form>'
  );
}

/**
 * 코드 입력의 스크립트 조각 — `var d,g` 가 선 IIFE 안에 넣는다. `CODE_RESET()` 은 새 요청 때 부른다(스스로 센 실패를 지운다).
 * 성공이면 서버가 알려 준 곳으로(로그인: `next` · 가입: `redirect` — 같은 출처 경로만). 문구는 없다(메시지는 마크업의 숨은 요소).
 */
export function codeScript(endpoint: '/api/login/verify' | '/api/signup/verify', browserMissing: string, conflict: string): string {
  return String.raw`var cf=g('cf'),ci=g('code'),cg=g('cgo'),CF=0;
function cmsg(k){['c0','c1','c2','c3','c4','c5','c6'].forEach(function(i){g(i).hidden=(i!==k);});
  if(k){ci.setAttribute('aria-invalid','true');ci.setAttribute('aria-describedby',k);}else{ci.removeAttribute('aria-invalid');ci.removeAttribute('aria-describedby');}}
function CODE_RESET(){CF=0;ci.value='';ci.disabled=false;cg.disabled=false;cmsg(null);}
function cnext(j){if(j&&j.next==='select-org')return '/app#/select-org';if(j&&j.redirect==='/app#/select-org')return '/app#/select-org';return '/app';}
ci.addEventListener('input',function(){if(!g('c0').hidden||!g('c1').hidden)cmsg(null);});
cf.addEventListener('submit',function(ev){
  ev.preventDefault();
  if(cg.disabled)return;
  var c=ci.value.normalize('NFKC').replace(/[\s-]/g,'');
  if(!/^[0-9]{6}$/.test(c)){cmsg('c0');ci.focus();return;}
  cmsg(null);cg.disabled=true;cg.classList.add('busy');
  fetch('${endpoint}',{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},
    body:JSON.stringify({code:c}),credentials:'same-origin',cache:'no-store',redirect:'error'})
  .then(function(r){
    cg.classList.remove('busy');
    if(r.ok)return r.json().catch(function(){return null;}).then(function(j){location.replace(cnext(j));});
    return r.json().catch(function(){return null;}).then(function(j){
      var e=(j&&typeof j.error==='string')?j.error:'';
      cg.disabled=false;
      if(r.status===401&&e==='${browserMissing}'){cmsg('c3');return;}
      if(r.status===409&&e==='${conflict}'){cmsg('c5');return;}
      if(r.status===429){cmsg('c6');return;}
      if(r.status===401){CF+=1;if(CF>=5){ci.disabled=true;cg.disabled=true;cmsg('c2');return;}ci.select();cmsg('c1');return;}
      cmsg('c4');
    });
  })
  .catch(function(){cg.disabled=false;cg.classList.remove('busy');cmsg('c4');});
});`;
}

const LOGIN_BODY =
  '<div class="shell">' +
  `<header>${LOGO}${LANG_SWITCH}</header>` +
  '<main>' +
  // 처음 보는 화면은 설명 없이 — 제목 · 입력 · 주 버튼 · 오류뿐(진윤겸 2026-09-27).
  '<h1>로그인</h1>' +
  // 콘솔이 401 로 보낼 때(`/?expired=1`) 이유 한 줄 — 가던 화면은 콘솔이 탭 저장소에 들고 있다가 로그인 뒤 다시 연다(비평 R7-05).
  '<p class="note" id="m-exp" role="status" hidden>세션이 끝났습니다. 다시 로그인하세요.</p>' +
  '<form id="f" novalidate>' +
  '<label class="field" for="email"><span>이메일</span>' +
  '<input type="email" id="email" name="email" autocomplete="email" inputmode="email" required maxlength="254" spellcheck="false" autocapitalize="off"></label>' +
  '<div class="actions"><button type="submit" class="btn" id="go">로그인 코드 받기</button></div>' +
  '<p class="msg err" id="e0" role="alert" hidden>이메일 주소를 확인해 주세요.</p>' +
  '<p class="msg err" id="e1" role="alert" hidden>서버에 닿지 못했습니다. 연결을 확인하고 다시 시도하세요.</p>' +
  '<p class="msg err" id="e2" role="alert" hidden>요청이 너무 잦습니다. 몇 분 뒤 다시 시도하세요.</p>' +
  '</form>' +
  '<section class="panel" id="sent" hidden aria-live="polite">' +
  '<h2>메일을 확인하세요</h2>' +
  codeForm('로그인', '조직 멤버가 가득 찼습니다. 초대한 사람에게 알려 주세요.') +
  '<p class="muted">코드는 15분 동안 한 번 쓸 수 있습니다.</p>' +
  '<div class="actions"><button type="button" class="btn ghost" id="again">다른 주소로 다시</button></div>' +
  '</section>' +
  '<p class="alt">처음이신가요? <a href="/signup">가입하기' + icon('arrowRight') + '</a></p>' +
  '<noscript><p class="note">이 페이지는 자바스크립트가 필요합니다.</p></noscript>' +
  '</main>' +
  '</div>';

const LOGIN_SCRIPT = String.raw`(function(){
'use strict';
var d=document,g=function(i){return d.getElementById(i);};
var f=g('f'),em=g('email'),go=g('go');
if(/[?&]expired=1(&|$)/.test(location.search))g('m-exp').hidden=false;
function msg(k){['e0','e1','e2'].forEach(function(i){g(i).hidden=(i!==k);});}
f.addEventListener('submit',function(ev){
  ev.preventDefault();
  var v=em.value.trim();
  if(v.length<3||v.length>254||v.indexOf('@')<1||v.lastIndexOf('@')===v.length-1||/\s/.test(v)){msg('e0');em.focus();return;}
  msg(null);go.disabled=true;go.classList.add('busy');
  fetch('/api/login',{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},
    body:JSON.stringify({email:v}),credentials:'same-origin',cache:'no-store',redirect:'error'})
  .then(function(r){
    go.disabled=false;go.classList.remove('busy');
    if(r.status===429){msg('e2');return;}
    if(r.status>=500){msg('e1');return;}
    f.hidden=true;g('sent').hidden=false;em.value='';CODE_RESET();ci.focus();
  })
  .catch(function(){go.disabled=false;go.classList.remove('busy');msg('e1');});
});
g('again').addEventListener('click',function(){g('sent').hidden=true;f.hidden=false;em.focus();});
${codeScript('/api/login/verify', 'login_browser_missing', 'member_limit')}
})();`;

const LANDING_BODY =
  '<div class="shell">' +
  `<header>${LOGO}${LANG_SWITCH}</header>` +
  '<main>' +
  '<h1>이 로그인 링크는 더 쓰지 않습니다</h1>' +
  '<p class="muted">이제 로그인은 메일로 받는 6자리 코드로만 합니다. 로그인 화면에서 이메일을 입력하고, 메일의 코드를 그 화면에 입력하세요.</p>' +
  '<div class="actions"><a class="btn" href="/">로그인 코드 받기</a></div>' +
  '</main>' +
  '</div>';

/** 옛 링크의 토큰(fragment)을 주소창 · 방문 기록에서 지운다 — 읽지도 보내지도 않는다. */
const LANDING_SCRIPT = String.raw`(function(){
'use strict';
if(location.hash)history.replaceState(null,'',location.pathname+location.search);
})();`;

export const LOGIN_PARTS = { title: 'Atmark Console — 로그인', bodyClass: 'p-login', body: LOGIN_BODY, script: LOGIN_SCRIPT };
export const LANDING_PARTS = { title: 'Atmark Console — 로그인 확인', bodyClass: 'p-landing', body: LANDING_BODY, script: LANDING_SCRIPT };

export const ADMIN_LOGIN_PAGES: Readonly<Record<Lang, AdminUiPage>> = {
  ko: buildPage(LOGIN_PARTS, 'ko'),
  en: buildPage(LOGIN_PARTS, 'en'),
};

export const ADMIN_LOGIN_LANDING_PAGES: Readonly<Record<Lang, AdminUiPage>> = {
  ko: buildPage(LANDING_PARTS, 'ko'),
  en: buildPage(LANDING_PARTS, 'en'),
};
