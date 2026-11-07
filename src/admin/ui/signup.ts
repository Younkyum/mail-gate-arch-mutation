/**
 * src/admin/ui/signup.ts — `GET /signup`(셀프 가입)과 `GET /signup/verify`(옛 가입 확인 링크 착지 — 안내만) — `console.atmark.ai`
 * (`signup-contract.md` §5).
 *
 * **가입** — 이메일 · 조직 이름 · 동의(이용약관 `https://atmark.ai/terms` · 개인정보 처리 안내 `https://atmark.ai/privacy` — 한국어 화면은 `/kr/…`)를
 * `POST /api/signup` 으로 보낸다. 서버는 모양이 맞으면 **항상** 202 이고(이미 조직을 가진 주소면 가입 메일 대신 로그인 링크가
 * 간다), 화면도 언제나 **같은 문구** "메일을 확인하세요" 를 보인다 — 그 주소가 이미 가입돼 있는지를 화면이 새지 않게.
 * 다르게 말하는 것은 모양 오류(400)·요청자 상한(429)·서버에 닿지 않음뿐이다 — 셋 다 주소의 존재와 무관하다. 동의 확인란은
 * 화면에서도 필수이고, 서버도 `consent !== true` 를 400 으로 거부한다.
 *
 * **코드(2026-09-28)** — 보낸 뒤 같은 화면에 6자리 코드 입력란(로그인 화면과 같은 조각 — `login.ts` `codeForm`). 이미 사용자인 주소면
 * 가입 요청이 로그인 메일을 보내므로, 서버는 이 화면의 코드를 가입·로그인 두 벌에 함께 맞춘다(`POST /api/signup/verify {code}`).
 *
 * **착지(`/signup/verify`)** — 가입 확인 링크는 2026-10-10 에 없앴다(로그인 링크와 같은 결정). 옛 메일의 링크를 열면 "더는 쓰지 않는 링크 —
 * 가입 화면에서 코드로 확인하세요" 를 말하고 가입 화면으로 보낸다. 서버에 아무것도 보내지 않는다(토큰은 주소창에서 지울 뿐 — 서버도 `{token}` 을
 * 410 `signup_link_retired` 로 닫는다).
 */

import type { Lang } from './i18n';
import { codeForm, codeScript } from './login';
import { icon } from './console/kit';
import { buildPage, LANG_SWITCH, LOGO, type AdminUiPage } from './page';

/** 약관·개인정보 안내 — 홈(atmark.ai)의 언어별 경로(2026-09-30: 영어는 접두어 없음, 한국어는 `/kr/…`). */
function signupBody(lang: Lang): string {
  const docs = lang === 'en' ? 'https://atmark.ai' : 'https://atmark.ai/kr';
  return (
  '<div class="shell">' +
  `<header>${LOGO}${LANG_SWITCH}</header>` +
  '<main>' +
  // 처음 보는 화면은 설명 없이 — 제목 · 입력 · 필수 동의 · 주 버튼 · 오류뿐(진윤겸 2026-09-27).
  '<h1>조직 만들기</h1>' +
  '<form id="f" novalidate>' +
  '<label class="field" for="email"><span>소유자 이메일</span>' +
  '<input type="email" id="email" name="email" autocomplete="email" inputmode="email" required maxlength="254" spellcheck="false" autocapitalize="off"></label>' +
  '<label class="field" for="org"><span>조직 이름</span>' +
  '<input type="text" id="org" name="organization" autocomplete="organization" required maxlength="80"></label>' +
  '<label class="check" for="consent"><input type="checkbox" id="consent" name="consent" required>' +
  // 어순이 다른 문장(링크 둘 사이의 조사)은 언어별 마크업이다 — 나머지 문구는 사전(i18n.ts)이 옮긴다.
  (lang === 'en'
    ? `<span>I have read and agree to the <a href="${docs}/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a> and the ` +
      `<a href="${docs}/privacy" target="_blank" rel="noopener noreferrer">Privacy Notice</a>.</span></label>`
    : `<span><a href="${docs}/terms" target="_blank" rel="noopener noreferrer">이용약관</a>과 ` +
      `<a href="${docs}/privacy" target="_blank" rel="noopener noreferrer">개인정보 처리 안내</a>를 읽었고 동의합니다.</span></label>`) +
  '<div class="actions"><button type="submit" class="btn" id="go">가입 코드 받기</button></div>' +
  '<p class="msg err" id="e0" role="alert" hidden>이메일 주소를 확인해 주세요.</p>' +
  '<p class="msg err" id="e3" role="alert" hidden>조직 이름은 1~80자로, 보이지 않는 문자 없이 적어 주세요.</p>' +
  '<p class="msg err" id="e4" role="alert" hidden>이용약관과 개인정보 처리 안내에 동의해야 가입할 수 있습니다.</p>' +
  '<p class="msg err" id="e5" role="alert" hidden>입력을 다시 확인해 주세요. 에이전트 도메인(atmark.ai) 주소로는 가입할 수 없습니다.</p>' +
  '<p class="msg err" id="e1" role="alert" hidden>서버에 닿지 못했습니다. 연결을 확인하고 다시 시도하세요.</p>' +
  '<p class="msg err" id="e2" role="alert" hidden>요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요.</p>' +
  '</form>' +
  // 보낸 뒤 — 메일의 6자리 코드(가입 메일이든, 이미 사용자인 주소면 로그인 메일이든 — 화면은 모른다)를 여기서 받는다.
  '<section class="panel" id="sent" hidden aria-live="polite">' +
  '<h2>메일을 확인하세요</h2>' +
  codeForm('확인', '지금은 가입을 받을 수 없습니다. 잠시 뒤 다시 시도하세요.') +
  // 초대 전용(202609301520) — 초대받지 않은 주소는 대기 확인 메일이 간다. 화면은 둘을 가리지 않는 한 문장(홈 가입 화면과 같은 글자).
  '<p class="muted">초대받은 주소라면 가입 코드가 담긴 메일이 갑니다. 코드는 30분 동안 한 번 쓸 수 있습니다. 아직 초대받지 않은 주소라면 대기자 명단에 올려 두었습니다.</p>' +
  '<div class="actions"><button type="button" class="btn ghost" id="again">다시 입력</button></div>' +
  '</section>' +
  '<p class="alt">이미 계정이 있나요? <a href="/">로그인' + icon('arrowRight') + '</a></p>' +
  // 가입은 초대 전용(2026-09-30) — 초대 없이 온 사람에게 대기자 명단 길을 같은 모양의 한 줄로(F67).
  `<p class="alt">초대를 받지 못했나요? <a href="${docs}/waitlist">대기자 명단${icon('arrowRight')}</a></p>` +
  '<noscript><p class="note">이 페이지는 자바스크립트가 필요합니다.</p></noscript>' +
  '</main>' +
  '</div>'
  );
}

const SIGNUP_SCRIPT = String.raw`(function(){
'use strict';
var d=document,g=function(i){return d.getElementById(i);};
var f=g('f'),em=g('email'),on=g('org'),ck=g('consent'),go=g('go');
function msg(k){['e0','e1','e2','e3','e4','e5'].forEach(function(i){g(i).hidden=(i!==k);});}
function badName(n){var len=Array.from(n).length;return len<1||len>80||/[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\u2800\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u.test(n);}
f.addEventListener('submit',function(ev){
  ev.preventDefault();
  var v=em.value.trim(),n=on.value.trim();
  if(v.length<6||v.length>254||v.indexOf('@')<1||v.lastIndexOf('@')===v.length-1||/\s/.test(v)){msg('e0');em.focus();return;}
  if(badName(n)){msg('e3');on.focus();return;}
  if(!ck.checked){msg('e4');ck.focus();return;}
  msg(null);go.disabled=true;go.classList.add('busy');
  fetch('/api/signup',{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},
    body:JSON.stringify({email:v,organizationName:n,consent:true,lang:LANG}),credentials:'same-origin',cache:'no-store',redirect:'error'})
  .then(function(r){
    go.disabled=false;go.classList.remove('busy');
    if(r.status===429){msg('e2');return;}
    if(r.status===400){msg('e5');return;}
    if(r.status>=500){msg('e1');return;}
    f.hidden=true;g('sent').hidden=false;em.value='';on.value='';ck.checked=false;CODE_RESET();ci.focus();
  })
  .catch(function(){go.disabled=false;go.classList.remove('busy');msg('e1');});
});
g('again').addEventListener('click',function(){g('sent').hidden=true;f.hidden=false;em.focus();});
${codeScript('/api/signup/verify', 'signup_browser_missing', 'signup_capacity')}
})();`;

const LANDING_BODY =
  '<div class="shell">' +
  `<header>${LOGO}${LANG_SWITCH}</header>` +
  '<main>' +
  '<h1>이 가입 확인 링크는 더 쓰지 않습니다</h1>' +
  '<p class="muted">이제 가입 확인은 메일로 받는 6자리 코드로만 합니다. 가입 화면에서 다시 요청하고, 메일의 코드를 그 화면에 입력하세요.</p>' +
  '<div class="actions"><a class="btn" href="/signup">가입 코드 받기</a></div>' +
  '</main>' +
  '</div>';

/** 옛 링크의 토큰(fragment `#t=…`)을 주소창 · 방문 기록에서 지운다 — 읽지도 보내지도 않는다. */
const LANDING_SCRIPT = String.raw`(function(){
'use strict';
/* retired sign-up link (2026-10-10): drop the old token from the address bar; nothing is sent */
if(location.hash)history.replaceState(null,'',location.pathname+location.search);
})();`;

export const signupParts = (lang: Lang) => ({ title: 'Atmark — 가입', bodyClass: 'p-signup', body: signupBody(lang), script: SIGNUP_SCRIPT });
export const SIGNUP_LANDING_PARTS = { title: 'Atmark — 가입 확인', bodyClass: 'p-landing', body: LANDING_BODY, script: LANDING_SCRIPT };

export const ADMIN_SIGNUP_PAGES: Readonly<Record<Lang, AdminUiPage>> = {
  ko: buildPage(signupParts('ko'), 'ko'),
  en: buildPage(signupParts('en'), 'en'),
};

export const ADMIN_SIGNUP_LANDING_PAGES: Readonly<Record<Lang, AdminUiPage>> = {
  ko: buildPage(SIGNUP_LANDING_PARTS, 'ko'),
  en: buildPage(SIGNUP_LANDING_PARTS, 'en'),
};
