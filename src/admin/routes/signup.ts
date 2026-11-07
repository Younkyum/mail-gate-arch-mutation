/**
 * src/admin/routes/signup.ts — 셀프 가입 (`signup-contract.md` §5: `POST /api/signup` · `POST /api/signup/verify`).
 *
 * **이 파일도 메일을 보내지 않는다.** 가입 요청은 `signup_links`(또는 이미 소유자인 주소면 `owner_login_links`)에 행을 적을
 * 뿐이고, 메일은 전용 Lambda `atmark-login-mailer` 가 보낸다(ADR-0006). 로직과 열거 방지 규율은 `admin/session.ts`.
 */

import { clientIpUnavailable, kickLoginMailer, logSecurityEvent, objectBody, type AdminCall } from '../context';
import {
  errorResponse,
  jsonResponse,
  LANG_COOKIE,
  LOGIN_BROWSER_COOKIE,
  loginBrowserCookie,
  sessionCookie,
  SIGNUP_BROWSER_COOKIE,
  signupBrowserCookie,
  type AdminResponse,
} from '../http';
import { LOGIN_BROWSER_TTL_MS, requestSignup, SESSION_TTL_MS, SIGNUP_BROWSER_TTL_MS, verifySignup } from '../session';
import { isLang, selectLang } from '../ui/i18n';
import { formLangCookies } from './session';

/**
 * `POST /api/signup {email, organizationName, consent:true, lang?}` → **항상** 202 `{ok:true}` + 같은 쿠키 둘(가입 논스 · 로그인 논스)
 * (+ `lang` 이 ko|en 이면 콘솔 언어 쿠키 — `formLangCookies`). 언어는 가입 링크 행에도 적힌다(환영 메일의 언어 — 없으면 쿠키 → Accept-Language).
 * 모양 오류만 400, 요청자 상한만 429 — 둘 다 주소의 존재와 무관하다. 400 은 앱 검사(SQL 전)와 DB 행 모양 탐침(두 갈래 같은 문장)
 * 두 층에서 같은 코드·같은 문구로 나온다(`session.ts` `requestSignup` ★ — 검증 H3).
 */
export async function handleSignupRequest(call: AdminCall): Promise<AdminResponse> {
  const sourceIp = call.request.sourceIp;
  if (sourceIp === null) return clientIpUnavailable(call.request);
  const body = objectBody(call.request.body);
  const outcome = await requestSignup(call.deps.pool, call.deps.loginKeys, {
    email: body['email'],
    organizationName: body['organizationName'],
    consent: body['consent'],
    sourceIp,
    signupNonce: call.request.cookies[SIGNUP_BROWSER_COOKIE],
    loginNonce: call.request.cookies[LOGIN_BROWSER_COOKIE],
    // 환영 메일의 언어(202609301510) — 폼의 화면 언어 → 콘솔 언어 쿠키 → Accept-Language.
    lang: isLang(body['lang'])
      ? body['lang']
      : selectLang({ cookie: call.request.cookies[LANG_COOKIE], acceptLanguage: call.request.headers['accept-language'] }),
  });
  if (outcome.kind === 'rate_limited') {
    return errorResponse(429, 'rate_limited', '가입 요청이 너무 잦다 — 잠시 뒤 다시 시도하라.');
  }
  // 커밋 뒤 · 새 주소(가입 링크)든 소유자 주소(로그인 링크)든 0행이든 같게(열거 방지 — `kickLoginMailer`).
  await kickLoginMailer(call.deps);
  return jsonResponse(202, { ok: true }, [
    signupBrowserCookie(outcome.signupNonce, SIGNUP_BROWSER_TTL_MS / 1000),
    loginBrowserCookie(outcome.loginNonce, LOGIN_BROWSER_TTL_MS / 1000),
    ...formLangCookies(call.request.body),
  ]);
}

/**
 * `POST /api/signup/verify {code}`(메일의 6자리) → 200 + 세션 쿠키 + `{redirect}` / 401 `signup_code_invalid` / 409 `signup_capacity`(새 조직
 * 상한 — 코드 미소진). 옛 메일 링크의 `{token}` 만 오면 410 `signup_link_retired`(2026-10-10 — 토큰을 보지 않는다). 가입 논스 쿠키가
 * **아예 없는** 브라우저만 `signup_browser_missing` 으로 따로 말한다(코드·DB 를 보기 전). 코드는 가입 메일의 것이든(새 주소) 로그인
 * 메일의 것이든(이미 사용자인 주소 — 가입 요청이 로그인 메일을 보낸다) 같은 화면에서 받는다 — `redirect` 는 로그인 쪽이 멤버십이 여럿이면
 * `/app#/select-org`. 틀린 코드가 IP 당 시간당 30회(`security/login-limits.ts`)면 429 `rate_limited`(주소와 무관, 로그인과 같은 원장). 홈(atmark.ai)의 가입
 * 화면도 코드를 여기로 보낸다(교차 출처 — `CROSS_SITE_AUTH_PATHS`).
 */
export async function handleSignupVerify(call: AdminCall): Promise<AdminResponse> {
  const sourceIp = call.request.sourceIp;
  if (sourceIp === null) return clientIpUnavailable(call.request);
  const body = objectBody(call.request.body);
  const outcome = await verifySignup(call.deps.pool, call.deps.loginKeys, {
    token: body['token'],
    code: body['code'],
    browserNonce: call.request.cookies[SIGNUP_BROWSER_COOKIE],
    loginNonce: call.request.cookies[LOGIN_BROWSER_COOKIE],
    sourceIp,
    now: call.deps.now(),
  });
  if (outcome.kind === 'link_retired') {
    logSecurityEvent('signup_link_retired', call.request.path, call.request.requestId, null);
    return errorResponse(410, 'signup_link_retired', '가입 확인 링크는 더 쓰지 않는다 — 가입 화면에서 메일의 6자리 코드를 입력하라.');
  }
  if (outcome.kind === 'rate_limited') {
    // IP 당 틀린 코드 상한(로그인과 같은 원장) — 주소와 무관하다.
    return errorResponse(429, 'rate_limited', '코드 확인이 너무 잦다 — 잠시 뒤 다시 시도하라.');
  }
  if (outcome.kind === 'browser_missing') {
    logSecurityEvent('signup_browser_missing', call.request.path, call.request.requestId, null);
    return errorResponse(
      401,
      'signup_browser_missing',
      '이 브라우저는 가입을 요청한 브라우저가 아니다 — 가입을 요청한 그 브라우저에 코드를 입력하라.',
    );
  }
  if (outcome.kind === 'rejected') {
    logSecurityEvent('signup_code_invalid', call.request.path, call.request.requestId, null);
    return errorResponse(
      401,
      'signup_code_invalid',
      '코드가 맞지 않다 — 틀렸거나, 만료됐거나, 이미 썼거나, 이 브라우저가 요청한 코드가 아니다. 5번 틀리면 가입을 다시 요청하라.',
    );
  }
  if (outcome.kind === 'capacity') {
    // 새 조직 상한(검증 M2) — 코드·결속이 맞은 뒤에만 나오므로 열거 신호가 아니다. 코드는 소비되지 않았다.
    logSecurityEvent('signup_capacity', call.request.path, call.request.requestId, null);
    return errorResponse(409, 'signup_capacity', '지금은 가입을 받을 수 없다 — 코드는 쓰이지 않았다. 잠시 뒤 다시 시도하라.');
  }
  // 가입 논스 쿠키는 **지우지 않는다**(30분이면 스스로 사라진다). 논스는 단일 사용 가입 행 하나에만 묶여 있어 남아도 새로 여는 것이 없다.
  // 커밋 뒤 — 새 가입이면 환영 메일 행이 방금 생겼다(202609301510). 링크·결속이 맞은 뒤라 열거와 무관하다.
  await kickLoginMailer(call.deps);
  return jsonResponse(200, { redirect: outcome.next === 'select-org' ? '/app#/select-org' : '/app' }, [sessionCookie(outcome.token, SESSION_TTL_MS / 1000)]);
}
