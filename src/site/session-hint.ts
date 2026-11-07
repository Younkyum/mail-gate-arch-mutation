/**
 * src/site/session-hint.ts — 머리 스크립트 하나(2026-09-30, 진윤겸): **로그인한 방문자에게는 머리 왼쪽(로고 옆)에 "콘솔" 버튼**을 보이고
 * "로그인"·"시작하기" 를 숨긴다. 로그인 화면(`/login`·`/kr/login`)에서는 폼을 보이지 않고 곧장 콘솔로 간다(로그인 메일을 아낀다).
 *
 *   - 묻는 곳은 콘솔 하나 — `GET https://console.atmark.ai/api/session/hint`(`credentials:'include'`). 응답 `{"signedIn":true|false}`.
 *     200 이 아니거나 JSON 이 아니거나 네트워크·CORS 가 실패하면 **로그아웃으로 본다**(화면은 처음 그대로 — 로그아웃 방문자에게는 아무 변화가 없다).
 *     단순 GET(맞춤 헤더 없음)이라 프리플라이트가 없다. 콘솔 쪽 CORS(이 출처 하나 · 자격 허용)는 `src/admin/**` 가 맡는다.
 *   - 표시는 `<html>` 의 클래스 하나(`signed-in`)로만 바꾼다 — 스타일시트가 `.si`(로그인 때만)·`.so`(로그아웃 때만) 요소를 켜고 끈다.
 *     `innerHTML` 류 싱크 없음(페이지 CSP 의 Trusted Types 와 맞다). 문구를 갖지 않는다 — 두 언어·모든 페이지가 같은 스크립트·같은 해시다.
 *   - 깜박임 줄이기: 확인된 로그인은 탭 수명 동안 `sessionStorage`(`atmark_hint=1`)에 적어, 다음 페이지에서는 응답을 기다리지 않고 먼저 켠다.
 *     응답이 로그아웃이면 지운다. 저장소를 못 쓰면(차단·비공개 창) 조용히 건너뛴다.
 *   - 로그인 화면(`<html data-hint="go">`): 응답을 기다리는 동안 폼을 가린다(`hint-wait` — 최대 2초, 넘으면 폼을 보이고 그 뒤로는 옮기지 않는다
 *     — 입력 중에 화면이 바뀌지 않게). **응답으로 확인된 로그인만** 옮긴다(저장된 표시만으로는 옮기지 않는다 — 세션이 끝난 뒤 콘솔 ↔ 로그인
 *     사이를 도는 일이 없게). 가는 곳은 상수(`CONSOLE_APP_URLS.app`)다.
 *   - 사진 히어로 위의 머리(`<html data-hero>` — 홈): 첫 그림부터 `at-hero` 를 켜 두고(맨 위에서 흰 글자·흰 버튼), 본문이 준비되면 스크롤마다
 *     히어로 아래 끝이 머리보다 위로 올라갔는지 보고 끈다(종이 머리 — 검은 버튼). 스크롤 구동 CSS 애니메이션(`animation-timeline`)은 브라우저마다
 *     맨 위에서도 끝 상태로 그려져(진윤겸 2026-09-30 "맨 위에서 시작하기 글자가 흰색") 이 방식으로 바꿨다. 스크립트가 못 돌면 종이 머리 그대로다.
 *   - `<head>` 안에서 돈다 — `documentElement` 만 만지므로 본문이 없어도 된다. ASCII 만(`asciiScript` — 해시가 인코딩에 흔들리지 않게).
 */

import { CONSOLE_APP_URLS, CONSOLE_SESSION_HINT_URL } from './constants';

/** `<html>` 에 이 속성이 있으면 로그인한 방문자를 콘솔로 보낸다(로그인 화면만). */
export const HINT_GO_ATTR = 'data-hint="go"';

export const SESSION_HINT_SCRIPT = String.raw`(function(){
'use strict';
var r=document.documentElement,go=r.getAttribute('data-hint')==='go',late=false,K='atmark_hint';
if(r.hasAttribute('data-hero')){
  r.classList.add('at-hero');
  var hq=false;
  var hs=function(){hq=false;var h=document.querySelector('.hero'),b=document.querySelector('.top');if(!h||!b)return;r.classList.toggle('at-hero',h.getBoundingClientRect().bottom>b.getBoundingClientRect().height);};
  var hr=function(){if(!hq){hq=true;requestAnimationFrame(hs);}};
  document.addEventListener('DOMContentLoaded',function(){hs();addEventListener('scroll',hr,{passive:true});addEventListener('resize',hr,{passive:true});});
}
function keep(v){try{if(v){sessionStorage.setItem(K,'1');}else{sessionStorage.removeItem(K);}}catch(e){}}
function kept(){try{return sessionStorage.getItem(K)==='1';}catch(e){return false;}}
function show(v){r.classList.toggle('signed-in',v);}
if(kept())show(true);
if(go)r.classList.add('hint-wait');
var t=setTimeout(function(){late=true;r.classList.remove('hint-wait');},2000);
function out(){clearTimeout(t);show(false);keep(false);r.classList.remove('hint-wait');}
if(typeof fetch!=='function'){out();return;}
fetch('${CONSOLE_SESSION_HINT_URL}',{method:'GET',mode:'cors',credentials:'include',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'})
.then(function(x){return x.status===200?x.json():null;})
.then(function(j){
  if(!j||j.signedIn!==true){out();return;}
  clearTimeout(t);show(true);keep(true);
  if(go&&!late){location.replace('${CONSOLE_APP_URLS.app}');return;}
  r.classList.remove('hint-wait');
})
.catch(out);
})();`;
