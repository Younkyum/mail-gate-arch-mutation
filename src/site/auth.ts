/**
 * src/site/auth.ts — 홈의 로그인·가입·대기자 명단 화면(US-003 · 202609301520). 영어 `/login`·`/signup`·`/waitlist`, 한국어 `/kr/…`.
 *
 * **가입은 초대로만**(202609301520): 머리의 주 버튼은 대기자 명단(`/waitlist` — 주소 + 한 줄 메모 → 콘솔 `POST /api/waitlist`, 늘 202). 초대 메일의 버튼은
 * 가입 화면(`/signup#invite=<base64url(주소)>`)으로 오고 스크립트가 주소 칸을 채운다(fragment 는 서버로 가지 않는다 · 읽은 뒤 주소창에서 지운다).
 * 초대받지 않은 주소로 가입을 요청해도 응답은 같은 202 이고, 서버가 그 주소를 대기자 명단에 올린다 — 화면은 둘을 가리지 않는 한 문장으로 말한다.
 *
 * 로그인 화면은 `<html data-hint="go">` 다 — 머리 힌트 스크립트(`session-hint.ts`)가 콘솔 세션을 확인하면 폼을 보이지 않고 콘솔로 간다.
 *
 * 폼은 여기 있고, 제출은 **콘솔 API** 로 간다: `fetch('https://console.atmark.ai/api/login' | '/api/signup', {credentials:'include'})`.
 *   - **메일의 6자리 코드(2026-09-28)**: 보낸 뒤 같은 화면에 코드 입력란이 선다. 코드는 `…/api/login/verify` · `…/api/signup/verify`
 *     (`{code}`, 같은 CORS 규칙)로 가고, 콘솔 호스트의 결속 쿠키가 같은 브라우저인지 본다. 성공(200)이면 세션 쿠키가 콘솔 호스트에 서고
 *     화면은 콘솔(`CONSOLE_APP_URLS` 상수 둘 중 하나 — 응답의 경로를 따르지 않는다)로 간다. 401 은 이유를 가리지 않는 한 문장이고, 5번째
 *     실패 뒤의 "새 코드를 받으세요" 는 화면이 스스로 센 횟수로만 보인다(서버의 계수를 묻지 않는다 — 열거 방지).
 *   - 두 호스트는 **같은 사이트·다른 출처**다. 콘솔이 이 출처(`https://atmark.ai`)에만 CORS 를 연다(`src/admin/router.ts`) —
 *     응답의 브라우저 결속 쿠키(`__Host-atmark_admin_login`·`__Host-atmark_signup`, SameSite=Strict)는 **콘솔 호스트**에 선다.
 *     메일에는 코드만 있다(2026-10-10 — 로그인 · 가입 확인 링크 삭제). 세션은 콘솔에만 있다(이 페이지는 쿠키를 보지도 만들지도 않는다).
 *   - 열거 방지: 서버는 주소와 무관하게 늘 202 이고, 화면도 202 면 **같은 문구**("메일을 확인하세요")다. 다르게 말하는 것은
 *     429(요청자 상한)·400(가입 모양 오류)·서버 오류(읽을 수 있는 4xx·5xx — `e1`)·응답을 읽지 못함(`e6`)뿐이다 — 전부 주소의 존재와 무관하다.
 *   - `e6`(2026-09-24 검증 F11): fetch 가 **거부**되면(TypeError — 네트워크·CORS 거부) 상태를 알 수 없다. API Gateway 스로틀의 429 는
 *     Lambda 를 거치지 않아 CORS 헤더가 없고, 브라우저는 그것을 네트워크 오류로 보인다 — 그래서 "요청이 많거나 연결이 불안정" 으로만 말한다.
 *   - 문구는 콘솔 로그인·가입 화면(`src/admin/ui/login.ts`·`signup.ts` · 영어는 `i18n.ts`)과 같다. 홈 번들은 `src/admin/**` 를
 *     import 하지 않으므로 여기 두 언어로 옮겨 적었다(키 집합이 같은지 테스트).
 *   - 스크립트는 문구를 갖지 않는다(메시지는 마크업의 숨은 요소) — 두 언어가 같은 스크립트·같은 해시다. `innerHTML` 없음.
 *     화면 언어는 `<html lang>` 에서 읽어 본문 `lang` 으로 보낸다 — 콘솔이 그 값으로 언어 쿠키를 적어, 메일 링크로 콘솔 착지에
 *     왔을 때 같은 언어 화면이 된다.
 */

import { CONSOLE_API, CONSOLE_APP_URLS, docsUrl, type SiteLang } from './constants';
import { ARROW_RIGHT_ICON, buildSitePage, sitePath, type SitePage } from './page';

type Copy = Readonly<Record<string, string>>;

/** 로그인 화면 문구. 값은 정적 마크업 조각(코드 상수). */
export const LOGIN_COPY: Readonly<Record<SiteLang, Copy>> = {
  ko: {
    title: '로그인 | Atmark',
    description: '등록한 이메일로 로그인 코드를 받아 Atmark Console에 들어갑니다.',
    h1: '로그인',
    email: '이메일',
    submit: '로그인 코드 받기',
    e0: '이메일 주소를 확인해 주세요.',
    e1: '서버에 닿지 못했습니다. 연결을 확인하고 다시 시도하세요.',
    // 응답을 읽지 못한 실패(fetch 거부 — 네트워크·CORS 거부, 그리고 API Gateway 스로틀 429: 그 응답엔 CORS 헤더가 없어 브라우저가
    //   상태를 보여 주지 않는다 — 검증 F11). "서버에 닿지 못했다" 고 단정하지 않는다.
    e6: '요청이 많거나 연결이 불안정합니다. 잠시 뒤 다시 시도하세요.',
    e2: '요청이 너무 잦습니다. 몇 분 뒤 다시 시도하세요.',
    sentTitle: '메일을 확인하세요',
    sentBody: '코드는 15분 동안 한 번 쓸 수 있습니다.',
    code: '메일로 받은 6자리 코드',
    codeSubmit: '로그인',
    c0: '메일의 6자리 숫자를 입력하세요.',
    c1: '코드가 맞지 않거나 만료됐습니다. 다시 확인하세요.',
    c2: '여러 번 틀렸습니다. 새 코드를 받으세요.',
    c3: '이 브라우저에서 요청한 코드가 아닙니다. 이 브라우저에서 새 코드를 받으세요.',
    c4: '서버에 닿지 못했습니다. 연결을 확인하고 다시 시도하세요.',
    c5: '조직 멤버가 가득 찼습니다. 초대한 사람에게 알려 주세요.',
    c6: '요청이 많거나 연결이 불안정합니다. 잠시 뒤 다시 시도하세요.',
    again: '다른 주소로 다시',
    altText: '처음이신가요?',
    altLink: '대기자 명단에 올리기',
    noscript: '이 페이지는 자바스크립트가 필요합니다.',
  },
  en: {
    title: 'Log in | Atmark',
    description: 'Get a login code at your registered email and open the Atmark console.',
    h1: 'Log in',
    email: 'Email',
    submit: 'Email me a login code',
    e0: 'Please check the email address.',
    e1: 'Couldn&rsquo;t reach the server. Check your connection and try again.',
    e6: 'Too many requests, or the connection is unstable. Please try again in a moment.',
    e2: 'Too many requests. Please try again in a few minutes.',
    sentTitle: 'Check your email',
    sentBody: 'The code works once, for 15 minutes.',
    code: '6-digit code from the email',
    codeSubmit: 'Log in',
    c0: 'Enter the 6 digits from the email.',
    c1: 'That code is wrong or has expired. Check it and try again.',
    c2: 'Too many wrong tries. Request a new code.',
    c3: 'This code wasn&rsquo;t requested in this browser. Request a new code here.',
    c4: 'Couldn&rsquo;t reach the server. Check your connection and try again.',
    c5: 'This organization is full. Let the person who invited you know.',
    c6: 'Too many requests, or the connection is unstable. Please try again in a moment.',
    again: 'Use a different address',
    altText: 'New to Atmark?',
    altLink: 'Join the waitlist',
    noscript: 'This page needs JavaScript.',
  },
};

/** 가입 화면 문구. `consent` 는 어순이 달라 언어별 마크업(`consentHtml`). */
export const SIGNUP_COPY: Readonly<Record<SiteLang, Copy>> = {
  ko: {
    title: '가입 | Atmark',
    description: '조직을 만들고 AI 에이전트마다 @atmark.ai 주소를 발급받으세요.',
    h1: '조직 만들기',
    intro: 'Atmark는 지금 초대로만 가입할 수 있습니다. 초대 메일의 버튼으로 오셨다면 주소가 채워져 있습니다.',
    email: '소유자 이메일',
    org: '조직 이름',
    terms: '이용약관',
    privacy: '개인정보 처리 안내',
    submit: '가입 코드 받기',
    e0: '이메일 주소를 확인해 주세요.',
    e3: '조직 이름은 1~80자로, 보이지 않는 문자 없이 적어 주세요.',
    e4: '이용약관과 개인정보 처리 안내에 동의해야 가입할 수 있습니다.',
    e5: '입력을 다시 확인해 주세요. 에이전트 도메인(atmark.ai) 주소로는 가입할 수 없습니다.',
    e1: '서버에 닿지 못했습니다. 연결을 확인하고 다시 시도하세요.',
    // 응답을 읽지 못한 실패(fetch 거부 — 네트워크·CORS 거부, 그리고 API Gateway 스로틀 429: 그 응답엔 CORS 헤더가 없어 브라우저가
    //   상태를 보여 주지 않는다 — 검증 F11). "서버에 닿지 못했다" 고 단정하지 않는다.
    e6: '요청이 많거나 연결이 불안정합니다. 잠시 뒤 다시 시도하세요.',
    e2: '요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요.',
    sentTitle: '메일을 확인하세요',
    // 초대 전용(202609301520) — 초대받지 않은 주소는 가입 메일 대신 대기 확인 메일이 간다. 어느 쪽인지 화면은 모른다(같은 문장).
    sentBody: '초대받은 주소라면 가입 코드가 담긴 메일이 갑니다. 코드는 30분 동안 한 번 쓸 수 있습니다. 아직 초대받지 않은 주소라면 대기자 명단에 올려 두었습니다.',
    code: '메일로 받은 6자리 코드',
    codeSubmit: '확인',
    c0: '메일의 6자리 숫자를 입력하세요.',
    c1: '코드가 맞지 않거나 만료됐습니다. 다시 확인하세요.',
    c2: '여러 번 틀렸습니다. 새 코드를 받으세요.',
    c3: '이 브라우저에서 요청한 코드가 아닙니다. 이 브라우저에서 새 코드를 받으세요.',
    c4: '서버에 닿지 못했습니다. 연결을 확인하고 다시 시도하세요.',
    c5: '지금은 가입을 받을 수 없습니다. 잠시 뒤 다시 시도하세요.',
    c6: '요청이 많거나 연결이 불안정합니다. 잠시 뒤 다시 시도하세요.',
    again: '다시 입력',
    altText: '이미 계정이 있나요?',
    altLink: '로그인',
    waitText: '아직 초대받지 않으셨나요?',
    waitLink: '대기자 명단',
    noscript: '이 페이지는 자바스크립트가 필요합니다.',
  },
  en: {
    title: 'Sign up | Atmark',
    description: 'Create an organization that gives your AI agents @atmark.ai addresses of their own.',
    h1: 'Create your organization',
    intro: 'Sign-up is by invitation for now. If you came from your invitation email, your address is already filled in.',
    email: 'Owner email',
    org: 'Organization name',
    terms: 'Terms of Service',
    privacy: 'Privacy Notice',
    submit: 'Email me a sign-up code',
    e0: 'Please check the email address.',
    e3: 'Organization names are 1&ndash;80 characters, with no invisible characters.',
    e4: 'You need to agree to the Terms of Service and the Privacy Notice to sign up.',
    e5: 'Please check what you entered. Addresses on the agent domain (atmark.ai) can&rsquo;t be used to sign up.',
    e1: 'Couldn&rsquo;t reach the server. Check your connection and try again.',
    e6: 'Too many requests, or the connection is unstable. Please try again in a moment.',
    e2: 'Too many requests. Please try again in a moment.',
    sentTitle: 'Check your email',
    sentBody: 'If this address has an invitation, we&rsquo;ve emailed it a sign-up code. The code works once, for 30 minutes. If it hasn&rsquo;t been invited yet, we&rsquo;ve added it to the waitlist.',
    code: '6-digit code from the email',
    codeSubmit: 'Confirm',
    c0: 'Enter the 6 digits from the email.',
    c1: 'That code is wrong or has expired. Check it and try again.',
    c2: 'Too many wrong tries. Request a new code.',
    c3: 'This code wasn&rsquo;t requested in this browser. Request a new code here.',
    c4: 'Couldn&rsquo;t reach the server. Check your connection and try again.',
    c5: 'We can&rsquo;t accept new sign-ups right now. Please try again shortly.',
    c6: 'Too many requests, or the connection is unstable. Please try again in a moment.',
    again: 'Start over',
    altText: 'Already have an account?',
    altLink: 'Log in',
    waitText: 'Not invited yet?',
    waitLink: 'Join the waitlist',
    noscript: 'This page needs JavaScript.',
  },
};

/**
 * 대기자 명단 화면 문구(202609301520 · 신청서 202609301530). 모으는 것은 주소 · 용도(필수) · 한 줄 메모 · 알게 된 곳(선택) · 유입 ref 다(개인정보 처리
 * 안내). 용도 값의 화면 순서는 반복 수신이 앞이다(`WAITLIST_USE_CASE_KEYS`).
 */
export const WAITLIST_COPY: Readonly<Record<SiteLang, Copy>> = {
  ko: {
    title: '대기자 명단 | Atmark',
    description: 'Atmark 대기자 명단에 이메일을 올려 두세요. 초대를 보내 드리게 되면 이 주소로 알려 드립니다.',
    h1: '대기자 명단',
    intro: 'Atmark는 지금 초대로만 가입할 수 있습니다. 이메일을 남겨 주시면 초대를 보내 드리게 될 때 이 주소로 알려 드립니다.',
    email: '이메일',
    useCase: '주로 어디에 쓰실 건가요?',
    ucAlerts: '소유자에게 보고·알림 받기',
    ucReplies: '아는 상대에게 답장',
    ucCodes: '인증코드·가입 메일 수신',
    ucOutreach: '모르는 사람에게 먼저 발송',
    note: 'Atmark로 무엇을 하고 싶으세요? (선택)',
    notePlaceholder: '예: 고객 문의 메일에 답하는 에이전트',
    heardFrom: '어디서 알게 되셨나요? (선택)',
    hfNone: '선택 안 함',
    hfDirectory: 'MCP 디렉터리',
    hfGithub: 'GitHub',
    hfReddit: 'Reddit',
    hfX: 'X',
    hfSearch: '검색',
    hfFriend: '지인 소개',
    hfOther: '기타',
    privacyBefore: '남겨 주신 주소와 답은 ',
    privacyLink: '개인정보 처리 안내',
    privacyAfter: '대로 다룹니다.',
    submit: '대기자 명단에 올리기',
    e0: '이메일 주소를 확인해 주세요.',
    e7: '메모는 한 줄, 200자 이하로 적어 주세요.',
    e8: '쓰실 용도를 하나 골라 주세요.',
    e1: '서버에 닿지 못했습니다. 연결을 확인하고 다시 시도하세요.',
    e6: '요청이 많거나 연결이 불안정합니다. 잠시 뒤 다시 시도하세요.',
    e2: '요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요.',
    doneTitle: '대기자 명단에 올렸습니다',
    doneBody: '고맙습니다. 초대를 보내 드리게 되면 이 주소로 알려 드리겠습니다. 이미 계정이 있다면 로그인하세요.',
    // 먼저 발송(④)만 고른 사람 — 화면이 자기 입력으로만 보인다(서버 응답은 같다).
    hold: '먼저 보내는 용도는 지금 보류합니다. 모든 에이전트가 한 도메인을 함께 쓰기 때문에, 모르는 사람에게 먼저 보내는 용도는 고객 도메인이 준비될 때까지 초대하지 않습니다.',
    holdLink: 'Atmark에 맞지 않는 용도',
    again: '다른 주소로',
    altText: '이미 계정이 있나요?',
    altLink: '로그인',
    inviteText: '초대 메일을 받으셨나요?',
    inviteLink: '가입하기',
    noscript: '이 페이지는 자바스크립트가 필요합니다.',
  },
  en: {
    title: 'Join the waitlist | Atmark',
    description: 'Add your email to the Atmark waitlist. If we send you an invitation, it will come to this address.',
    h1: 'Join the waitlist',
    intro: 'Atmark is invite-only for now. Leave your email, and if we send you an invitation, it will come to this address.',
    email: 'Email',
    useCase: 'What will you mainly use it for?',
    ucAlerts: 'Get reports and alerts',
    ucReplies: 'Reply to people it knows',
    ucCodes: 'Receive sign-up codes and verification mail',
    ucOutreach: 'Email people who haven&rsquo;t written first',
    note: 'What do you want to do with Atmark? (optional)',
    notePlaceholder: 'e.g. an agent that answers customer email',
    heardFrom: 'Where did you hear about Atmark? (optional)',
    hfNone: 'Prefer not to say',
    hfDirectory: 'An MCP directory',
    hfGithub: 'GitHub',
    hfReddit: 'Reddit',
    hfX: 'X',
    hfSearch: 'Search',
    hfFriend: 'A friend or colleague',
    hfOther: 'Somewhere else',
    privacyBefore: 'We handle your address and answers as described in our ',
    privacyLink: 'Privacy Notice',
    privacyAfter: '.',
    submit: 'Join the waitlist',
    e0: 'Please check the email address.',
    e7: 'Keep the note to one line of 200 characters or fewer.',
    e8: 'Please choose what you&rsquo;ll use it for.',
    e1: 'Couldn&rsquo;t reach the server. Check your connection and try again.',
    e6: 'Too many requests, or the connection is unstable. Please try again in a moment.',
    e2: 'Too many requests. Please try again in a moment.',
    doneTitle: 'You&rsquo;re on the waitlist',
    doneBody: 'Thanks. If we send you an invitation, it will come to this address. If you already have an account, log in.',
    hold: 'We&rsquo;re holding invitations for outreach for now. Every agent shares one domain, so we won&rsquo;t invite people who want to email strangers first until custom domains are ready.',
    holdLink: 'What Atmark is not for',
    again: 'Use a different address',
    altText: 'Already have an account?',
    altLink: 'Log in',
    inviteText: 'Got an invitation?',
    inviteLink: 'Sign up',
    noscript: 'This page needs JavaScript.',
  },
};

/**
 * 코드 입력의 스크립트 조각(로그인·가입) — 콘솔 조각(`src/admin/ui/login.ts` `codeScript`)과 같은 검사·같은 분기. 다른 점: 콘솔 **절대 URL**
 * 로 `credentials:'include'` · 200 만 성공 · 성공하면 콘솔로(**상수 URL 둘 중 하나** — 응답의 `next`·`redirect` 는 고르기만 한다) ·
 * fetch 거부(네트워크·CORS 거부·CORS 헤더 없는 스로틀 429)와 Lambda 의 요청자 상한 429 는 `c6`. `CODE_RESET()` 은 새 요청 때 부른다(스스로 센 실패를 지운다).
 */
function codeScript(api: string, browserMissing: string, conflict: string): string {
  return String.raw`var cf=g('cf'),ci=g('code'),cg=g('cgo'),CF=0;
function cmsg(k){['c0','c1','c2','c3','c4','c5','c6'].forEach(function(i){g(i).hidden=(i!==k);});
  if(k==='c0'||k==='c1'){ci.setAttribute('aria-invalid','true');ci.setAttribute('aria-describedby',k);}else{ci.removeAttribute('aria-invalid');ci.removeAttribute('aria-describedby');}}
function CODE_RESET(){CF=0;ci.value='';ci.disabled=false;cg.disabled=false;cmsg(null);}
ci.addEventListener('input',function(){if(!g('c0').hidden||!g('c1').hidden)cmsg(null);});
cf.addEventListener('submit',function(ev){
  ev.preventDefault();
  if(cg.disabled)return;
  var c=ci.value.normalize('NFKC').replace(/[\s-]/g,'');
  if(!/^[0-9]{6}$/.test(c)){cmsg('c0');ci.focus();return;}
  cmsg(null);cg.disabled=true;cg.classList.add('busy');
  fetch('${api}',{method:'POST',mode:'cors',headers:{'content-type':'application/json'},
    body:JSON.stringify({code:c}),credentials:'include',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'})
  .then(function(r){
    cg.classList.remove('busy');
    return r.json().catch(function(){return null;}).then(function(j){
      if(r.status===200){location.replace(j&&(j.next==='select-org'||j.redirect==='/app#/select-org')?'${CONSOLE_APP_URLS.selectOrg}':'${CONSOLE_APP_URLS.app}');return;}
      var e=(j&&typeof j.error==='string')?j.error:'';
      cg.disabled=false;
      if(r.status===401&&e==='${browserMissing}'){cmsg('c3');return;}
      if(r.status===409&&e==='${conflict}'){cmsg('c5');return;}
      if(r.status===429){cmsg('c6');return;}
      if(r.status===401){CF+=1;if(CF>=5){ci.disabled=true;cg.disabled=true;cmsg('c2');return;}ci.select();cmsg('c1');return;}
      cmsg('c4');
    });
  })
  .catch(function(){cg.disabled=false;cg.classList.remove('busy');cmsg('c6');});
});`;
}

/**
 * 로그인 스크립트 — 콘솔 로그인 스크립트(`src/admin/ui/login.ts`)와 같은 검사·같은 상태. 다른 점: 콘솔 **절대 URL** 로
 * `credentials:'include'`(교차 출처라 쿠키를 싣고 받으려면 필요) · 202 만 "메일을 확인하세요"(그 밖의 상태는 서버 오류 문구 —
 * 교차 출처 거부·403 을 성공처럼 보이지 않게) · 요청 헤더는 `content-type` 하나(프리플라이트가 허용하는 그것).
 */
export const LOGIN_SCRIPT = String.raw`(function(){
'use strict';
var d=document,g=function(i){return d.getElementById(i);},LANG=d.documentElement.lang==='en'?'en':'ko';
var f=g('f'),em=g('email'),go=g('go');
var FIELDS=[['e0',em]];
function msg(k){['e0','e1','e2','e6'].forEach(function(i){g(i).hidden=(i!==k);});
  FIELDS.forEach(function(p){if(p[0]===k){p[1].setAttribute('aria-invalid','true');p[1].setAttribute('aria-describedby',p[0]);}else{p[1].removeAttribute('aria-invalid');p[1].removeAttribute('aria-describedby');}});}
FIELDS.forEach(function(p){p[1].addEventListener('input',function(){if(!g(p[0]).hidden)msg(null);});});
f.addEventListener('submit',function(ev){
  ev.preventDefault();
  if(go.disabled)return;
  var v=em.value.trim();
  if(v.length<3||v.length>254||v.indexOf('@')<1||v.lastIndexOf('@')===v.length-1||/\s/.test(v)){msg('e0');em.focus();return;}
  msg(null);go.disabled=true;go.classList.add('busy');
  fetch('${CONSOLE_API.login}',{method:'POST',mode:'cors',headers:{'content-type':'application/json'},
    body:JSON.stringify({email:v,lang:LANG}),credentials:'include',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'})
  .then(function(r){
    go.disabled=false;go.classList.remove('busy');
    if(r.status===429){msg('e2');return;}
    if(r.status!==202){msg('e1');return;}
    f.hidden=true;g('sent').hidden=false;em.value='';CODE_RESET();ci.focus();
  })
  .catch(function(){go.disabled=false;go.classList.remove('busy');msg('e6');});
});
g('again').addEventListener('click',function(){g('sent').hidden=true;f.hidden=false;em.focus();});
${codeScript(CONSOLE_API.loginVerify, 'login_browser_missing', 'member_limit')}
})();`;

/** 가입 스크립트 — 콘솔 가입 스크립트(`src/admin/ui/signup.ts`)와 같은 검사(조직 이름 문자 집합 포함). 다른 점은 로그인과 같다. */
export const SIGNUP_SCRIPT = String.raw`(function(){
'use strict';
var d=document,g=function(i){return d.getElementById(i);},LANG=d.documentElement.lang==='en'?'en':'ko';
var f=g('f'),em=g('email'),on=g('org'),ck=g('consent'),go=g('go');
var FIELDS=[['e0',em],['e3',on],['e4',ck]];
/* invite link (202609301520): #invite=<base64url(email)> prefills the address; the fragment never reaches a server. Wiped from the address bar. */
(function(){var m=/^#invite=([A-Za-z0-9_-]{4,400})$/.exec(location.hash);if(!m)return;try{var b=m[1].replace(/-/g,'+').replace(/_/g,'/');while(b.length%4)b+='=';var v=atob(b);if(/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(v)){em.value=v;on.focus();}}catch(e){}history.replaceState(null,'',location.pathname);})();
function msg(k){['e0','e1','e2','e3','e4','e5','e6'].forEach(function(i){g(i).hidden=(i!==k);});
  FIELDS.forEach(function(p){if(p[0]===k){p[1].setAttribute('aria-invalid','true');p[1].setAttribute('aria-describedby',p[0]);}else{p[1].removeAttribute('aria-invalid');p[1].removeAttribute('aria-describedby');}});}
FIELDS.forEach(function(p){p[1].addEventListener(p[1]===ck?'change':'input',function(){if(!g(p[0]).hidden)msg(null);});});
function badName(n){var len=Array.from(n).length;return len<1||len>80||/[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}­͏؜ᅟᅠ឴឵᠋-᠏​-‏ -‮⁠-⁯ㅤ⠀︀-️﻿ﾠ\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u.test(n);}
f.addEventListener('submit',function(ev){
  ev.preventDefault();
  if(go.disabled)return;
  var v=em.value.trim(),n=on.value.trim();
  if(v.length<6||v.length>254||v.indexOf('@')<1||v.lastIndexOf('@')===v.length-1||/\s/.test(v)){msg('e0');em.focus();return;}
  if(badName(n)){msg('e3');on.focus();return;}
  if(!ck.checked){msg('e4');ck.focus();return;}
  msg(null);go.disabled=true;go.classList.add('busy');
  fetch('${CONSOLE_API.signup}',{method:'POST',mode:'cors',headers:{'content-type':'application/json'},
    body:JSON.stringify({email:v,organizationName:n,consent:true,lang:LANG}),credentials:'include',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'})
  .then(function(r){
    go.disabled=false;go.classList.remove('busy');
    if(r.status===429){msg('e2');return;}
    if(r.status===400){msg('e5');return;}
    if(r.status!==202){msg('e1');return;}
    f.hidden=true;g('sent').hidden=false;em.value='';on.value='';ck.checked=false;CODE_RESET();ci.focus();
  })
  .catch(function(){go.disabled=false;go.classList.remove('busy');msg('e6');});
});
g('again').addEventListener('click',function(){g('sent').hidden=true;f.hidden=false;em.focus();});
${codeScript(CONSOLE_API.signupVerify, 'signup_browser_missing', 'signup_capacity')}
})();`;

const EMAIL_INPUT =
  '<input type="email" id="email" name="email" autocomplete="email" inputmode="email" required maxlength="254" spellcheck="false" autocapitalize="off">';

function errors(c: Copy, ids: readonly string[]): string {
  return ids.map((id) => `<p class="msg" id="${id}" role="alert" hidden>${c[id] ?? ''}</p>`).join('');
}

/**
 * 보낸 뒤의 코드 입력 — 한 칸 · 숫자 자판 · 메일 앱의 코드 자동 채움(콘솔 `codeForm` 과 같은 칸). 칸 오류(c0)는 칸 바로 뒤, 나머지는 버튼 아래.
 */
function codeForm(c: Copy): string {
  return (
    '<form id="cf" novalidate>' +
    `<label class="field" for="code"><span>${c['code'] ?? ''}</span>` +
    '<input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required spellcheck="false" autocapitalize="off" autocorrect="off"></label>' +
    errors(c, ['c0']) +
    `<div class="actions"><button type="submit" class="btn" id="cgo">${c['codeSubmit'] ?? ''}</button></div>` +
    errors(c, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) +
    '</form>'
  );
}

/**
 * 화면 뼈대 — 제목 · 폼 · 보낸 뒤(코드 입력 · 한 줄) · 반대편 링크. 처음 보는 화면은 설명이 필요 없어야 한다(진윤겸 2026-09-27): kicker · lede ·
 * "다음 순서" 카드 · 꼬리 안내를 두지 않는다. 필요한 사실(링크 유효 시간·같은 브라우저)은 보낸 뒤 한 줄에만.
 */
function shell(c: Copy, form: string, alt: string): string {
  return (
    '<section class="wrap auth" aria-labelledby="auth-title">' +
    '<div class="auth-main">' +
    `<h1 id="auth-title">${c['h1'] ?? ''}</h1>` +
    form +
    '<section class="panel" id="sent" hidden aria-live="polite">' +
    `<h2>${c['sentTitle'] ?? ''}</h2>` +
    codeForm(c) +
    `<p class="muted">${c['sentBody'] ?? ''}</p>` +
    `<div class="actions"><button type="button" class="btn ghost" id="again">${c['again'] ?? ''}</button></div>` +
    '</section>' +
    alt +
    `<noscript><p class="note">${c['noscript'] ?? ''}</p></noscript>` +
    '</div>' +
    '</section>'
  );
}

function loginPage(lang: SiteLang): SitePage {
  const c = LOGIN_COPY[lang];
  const form =
    '<form id="f" novalidate>' +
    `<label class="field" for="email"><span>${c['email'] ?? ''}</span>${EMAIL_INPUT}</label>` +
    errors(c, ['e0']) +
    `<div class="actions"><button type="submit" class="btn" id="go">${c['submit'] ?? ''}</button></div>` +
    errors(c, ['e1', 'e2', 'e6']) +
    '</form>';
  // 가입은 초대로만(202609301520) — 처음 온 사람은 대기자 명단으로.
  const alt = `<p class="alt">${c['altText'] ?? ''} <a href="${sitePath(lang, 'waitlist')}">${c['altLink'] ?? ''} ${ARROW_RIGHT_ICON}</a></p>`;
  return buildSitePage({
    lang,
    id: 'login',
    title: c['title'] ?? '',
    description: c['description'] ?? '',
    main: shell(c, form, alt),
    script: LOGIN_SCRIPT,
    // 로그인한 방문자는 폼 없이 곧장 콘솔로(진윤겸 2026-09-30 — 로그인 메일을 아낀다, `session-hint.ts`).
    hintGo: true,
  });
}

/** 동의 문장 — 약관·안내는 같은 사이트의 이 언어 경로(새 탭 — 입력한 폼이 사라지지 않게). */
function consentHtml(lang: SiteLang, c: Copy): string {
  const link = (id: 'terms' | 'privacy'): string =>
    `<a href="${sitePath(lang, id)}" target="_blank" rel="noopener noreferrer">${c[id] ?? ''}</a>`;
  return lang === 'en'
    ? `<span>I have read and agree to the ${link('terms')} and the ${link('privacy')}.</span>`
    : `<span>${link('terms')}과 ${link('privacy')}를 읽었고 동의합니다.</span>`;
}

function signupPage(lang: SiteLang): SitePage {
  const c = SIGNUP_COPY[lang];
  const form =
    `<p class="intro">${c['intro'] ?? ''}</p>` +
    '<form id="f" novalidate>' +
    `<label class="field" for="email"><span>${c['email'] ?? ''}</span>${EMAIL_INPUT}</label>` +
    errors(c, ['e0']) +
    `<label class="field" for="org"><span>${c['org'] ?? ''}</span>` +
    '<input type="text" id="org" name="organization" autocomplete="organization" required maxlength="80"></label>' +
    errors(c, ['e3']) +
    `<label class="check" for="consent"><input type="checkbox" id="consent" name="consent" required>${consentHtml(lang, c)}</label>` +
    errors(c, ['e4']) +
    `<div class="actions"><button type="submit" class="btn" id="go">${c['submit'] ?? ''}</button></div>` +
    errors(c, ['e5', 'e1', 'e2', 'e6']) +
    '</form>';
  const alt =
    `<p class="alt">${c['altText'] ?? ''} <a href="${sitePath(lang, 'login')}">${c['altLink'] ?? ''}</a></p>` +
    `<p class="alt">${c['waitText'] ?? ''} <a href="${sitePath(lang, 'waitlist')}">${c['waitLink'] ?? ''} ${ARROW_RIGHT_ICON}</a></p>`;
  return buildSitePage({
    lang,
    id: 'signup',
    title: c['title'] ?? '',
    description: c['description'] ?? '',
    main: shell(c, form, alt),
    script: SIGNUP_SCRIPT,
  });
}

/** 용도 라디오의 값과 문구 키 — 화면 순서(① 보고·알림 ② 답장 ③ 인증코드 ④ 먼저 발송). 값은 `waitlist_entries.use_case` CHECK 와 같다(테스트). */
export const WAITLIST_USE_CASE_KEYS: readonly (readonly [value: string, copyKey: string])[] = [
  ['alerts', 'ucAlerts'],
  ['replies', 'ucReplies'],
  ['codes', 'ucCodes'],
  ['outreach', 'ucOutreach'],
];

/** 알게 된 곳의 값과 문구 키(선택 — 빈 값이 첫 줄). 값은 `waitlist_entries.heard_from` CHECK 와 같다(테스트). */
export const WAITLIST_HEARD_FROM_KEYS: readonly (readonly [value: string, copyKey: string])[] = [
  ['directory', 'hfDirectory'],
  ['github', 'hfGithub'],
  ['reddit', 'hfReddit'],
  ['x', 'hfX'],
  ['search', 'hfSearch'],
  ['friend', 'hfFriend'],
  ['other', 'hfOther'],
];

/**
 * 대기자 명단 스크립트(202609301520 · 신청서 202609301530) — 가입 스크립트와 같은 규율(콘솔 **절대 URL** · 202 만 성공 · 429 는 e2 · fetch 거부는 e6 ·
 * `innerHTML` 없음). 다른 점: 쿠키가 필요 없다(`credentials:'omit'` — 이 경로는 결속·세션을 만들지 않는다) · 400 은 서버의 코드로 칸을 고른다
 * (`invalid_note` → 메모, `invalid_use_case` → 용도, `invalid_heard_from` → 서버 오류 문구, 그 밖 → 주소) · 숨은 칸(`website`, 꿀단지)은 값이 있을
 * 때만 싣는다 — 서버는 그 요청을 같은 202 로 받고 등록하지 않는다.
 * 신청서(202609301530): 용도 라디오(필수) · 알게 된 곳(선택 — 비면 싣지 않는다) · 주소창의 `?ref=` 값(60자 넘으면 `none` — 허용목록은 **서버**가 본다,
 * 쿠키·저장소에 남기지 않는다). 202 뒤 용도가 "먼저 발송"(`outreach`)이면 보류 안내(`#hold`)를 함께 보인다 — **자기가 고른 값**으로만 정한다(응답은
 * 주소와 무관하게 같다 — 새는 것이 없다).
 */
export const WAITLIST_SCRIPT = String.raw`(function(){
'use strict';
var d=document,g=function(i){return d.getElementById(i);},LANG=d.documentElement.lang==='en'?'en':'ko';
var f=g('f'),em=g('email'),uc=g('uc'),nt=g('note'),hf=g('heard'),hp=g('website'),go=g('go');
var UCV=${JSON.stringify(WAITLIST_USE_CASE_KEYS.map(([value]) => value))};
var REF=(function(){var m=/[?&]ref=([^&#]*)/.exec(location.search),v='';if(m){try{v=decodeURIComponent(m[1]);}catch(e){v='';}}return v&&v.length<=60?v:'none';})();
var FIELDS=[['e0',em],['e8',uc],['e7',nt]];
function msg(k){['e0','e1','e2','e6','e7','e8'].forEach(function(i){g(i).hidden=(i!==k);});
  FIELDS.forEach(function(p){if(p[0]===k){p[1].setAttribute('aria-invalid','true');p[1].setAttribute('aria-describedby',p[0]);}else{p[1].removeAttribute('aria-invalid');p[1].removeAttribute('aria-describedby');}});}
FIELDS.forEach(function(p){p[1].addEventListener(p[1]===uc?'change':'input',function(){if(!g(p[0]).hidden)msg(null);});});
function badNote(n){return Array.from(n).length>200||/[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u.test(n);}
function useCase(){for(var i=0;i<UCV.length;i++){if(g('uc-'+UCV[i]).checked)return UCV[i];}return '';}
function wipe(){em.value='';nt.value='';hf.value='';UCV.forEach(function(v){g('uc-'+v).checked=false;});}
f.addEventListener('submit',function(ev){
  ev.preventDefault();
  if(go.disabled)return;
  var v=em.value.trim(),u=useCase(),n=nt.value.trim();
  if(v.length<6||v.length>254||v.indexOf('@')<1||v.lastIndexOf('@')===v.length-1||/\s/.test(v)){msg('e0');em.focus();return;}
  if(!u){msg('e8');g('uc-'+UCV[0]).focus();return;}
  if(n&&badNote(n)){msg('e7');nt.focus();return;}
  msg(null);go.disabled=true;go.classList.add('busy');
  var body={email:v,useCase:u,ref:REF,lang:LANG};if(n)body.note=n;if(hf.value)body.heardFrom=hf.value;if(hp.value)body.website=hp.value;
  fetch('${CONSOLE_API.waitlist}',{method:'POST',mode:'cors',headers:{'content-type':'application/json'},
    body:JSON.stringify(body),credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'})
  .then(function(r){
    go.disabled=false;go.classList.remove('busy');
    if(r.status===202){g('hold').hidden=(u!=='outreach');f.hidden=true;g('done').hidden=false;wipe();g('again').focus();return;}
    if(r.status===429){msg('e2');return;}
    if(r.status===400){return r.json().catch(function(){return null;}).then(function(j){var e=j&&j.error;if(e==='invalid_note'){msg('e7');nt.focus();}else if(e==='invalid_use_case'){msg('e8');g('uc-'+UCV[0]).focus();}else if(e==='invalid_heard_from'){msg('e1');}else{msg('e0');em.focus();}});}
    msg('e1');
  })
  .catch(function(){go.disabled=false;go.classList.remove('busy');msg('e6');});
});
g('again').addEventListener('click',function(){g('done').hidden=true;g('hold').hidden=true;f.hidden=false;em.focus();});
})();`;

/** 보류 안내의 링크 — 문서 "Atmark가 맞지 않는 용도"(같은 언어 — 문서는 한국어가 `/`, 영어가 `/en`). */
export function waitlistNotForUrl(lang: SiteLang): string {
  return `${docsUrl(lang)}/get-started/not-for`;
}

function waitlistPage(lang: SiteLang): SitePage {
  const c = WAITLIST_COPY[lang];
  const form =
    `<p class="intro">${c['intro'] ?? ''}</p>` +
    '<form id="f" novalidate>' +
    `<label class="field" for="email"><span>${c['email'] ?? ''}</span>${EMAIL_INPUT}</label>` +
    errors(c, ['e0']) +
    // 용도(필수, 202609301530) — 라디오 넷, 반복 수신이 앞.
    `<fieldset class="choice" id="uc"><legend>${c['useCase'] ?? ''}</legend>` +
    WAITLIST_USE_CASE_KEYS.map(
      ([value, key]) =>
        `<label class="check" for="uc-${value}"><input type="radio" id="uc-${value}" name="use_case" value="${value}" required><span>${c[key] ?? ''}</span></label>`,
    ).join('') +
    '</fieldset>' +
    errors(c, ['e8']) +
    `<label class="field" for="note"><span>${c['note'] ?? ''}</span>` +
    `<input type="text" id="note" name="note" maxlength="200" autocomplete="off" placeholder="${c['notePlaceholder'] ?? ''}"></label>` +
    errors(c, ['e7']) +
    // 알게 된 곳(선택, 202609301530) — 빈 값이 기본.
    `<label class="field" for="heard"><span>${c['heardFrom'] ?? ''}</span><select id="heard" name="heard_from">` +
    `<option value="">${c['hfNone'] ?? ''}</option>` +
    WAITLIST_HEARD_FROM_KEYS.map(([value, key]) => `<option value="${value}">${c[key] ?? ''}</option>`).join('') +
    '</select></label>' +
    // 꿀단지 — 사람에게는 보이지 않고(화면 밖 · 보조기술에서 숨김 · 탭 순서 밖) 자동 입력기는 채운다.
    '<div class="sr" aria-hidden="true"><label for="website">Website</label><input type="text" id="website" name="website" tabindex="-1" autocomplete="off"></div>' +
    `<div class="actions"><button type="submit" class="btn" id="go">${c['submit'] ?? ''}</button></div>` +
    errors(c, ['e1', 'e2', 'e6']) +
    `<p class="fine">${c['privacyBefore'] ?? ''}<a href="${sitePath(lang, 'privacy')}" target="_blank" rel="noopener noreferrer">${c['privacyLink'] ?? ''}</a>${c['privacyAfter'] ?? ''}</p>` +
    '</form>';
  const main =
    '<section class="wrap auth" aria-labelledby="auth-title">' +
    '<div class="auth-main">' +
    `<h1 id="auth-title">${c['h1'] ?? ''}</h1>` +
    form +
    '<section class="panel" id="done" hidden aria-live="polite">' +
    `<h2>${c['doneTitle'] ?? ''}</h2>` +
    `<p class="muted">${c['doneBody'] ?? ''}</p>` +
    `<p class="muted" id="hold" hidden>${c['hold'] ?? ''} <a href="${waitlistNotForUrl(lang)}" target="_blank" rel="noopener noreferrer">${c['holdLink'] ?? ''}</a></p>` +
    `<div class="actions"><button type="button" class="btn ghost" id="again">${c['again'] ?? ''}</button></div>` +
    '</section>' +
    `<p class="alt">${c['altText'] ?? ''} <a href="${sitePath(lang, 'login')}">${c['altLink'] ?? ''}</a></p>` +
    `<p class="alt">${c['inviteText'] ?? ''} <a href="${sitePath(lang, 'signup')}">${c['inviteLink'] ?? ''}</a></p>` +
    `<noscript><p class="note">${c['noscript'] ?? ''}</p></noscript>` +
    '</div>' +
    '</section>';
  return buildSitePage({
    lang,
    id: 'waitlist',
    title: c['title'] ?? '',
    description: c['description'] ?? '',
    main,
    script: WAITLIST_SCRIPT,
  });
}

export const LOGIN_PAGES: Readonly<Record<SiteLang, SitePage>> = { ko: loginPage('ko'), en: loginPage('en') };
export const SIGNUP_PAGES: Readonly<Record<SiteLang, SitePage>> = { ko: signupPage('ko'), en: signupPage('en') };
export const WAITLIST_PAGES: Readonly<Record<SiteLang, SitePage>> = { ko: waitlistPage('ko'), en: waitlistPage('en') };
