/**
 * src/admin/routes/pages.ts — 관리 UI HTML 서빙(`https://console.atmark.ai` 의 `GET /` · `/login` · `/app` · `/signup` ·
 * `/signup/verify`). 에셋은 UI 모듈(`src/admin/ui/index.ts`)이 언어별로 만들고 CSP 를 함께 준다 — 여기서는 언어를 고르고,
 * 그대로 싣고, 보안 헤더만 더한다.
 *
 *   - `/`      로그인 페이지. 세션이 있으면 `/app` 으로 302.
 *   - `/login` 링크 착지 — 토큰은 fragment(#)에 있어 서버는 보지 못한다. 페이지 스크립트가 verify 로 POST 한다.
 *   - `/app`   관리 앱. 세션이 없으면 `/` 로 302.
 *   - `/signup`         셀프 가입 폼. 세션이 있으면 `/app` 으로 302.
 *   - `/signup/verify`  가입 링크 착지 — `/login` 과 같은 규율(프래그먼트 토큰 · 사람이 버튼을 눌러야 verify).
 *   - `/invite`         초대 링크 착지 — 같은 규율(프래그먼트 토큰 · 버튼 → claim). 세션이 있어도 리다이렉트하지 않는다.
 *
 * **로그인·가입이 홈으로 옮긴 뒤**(US-003 · 운영 스위치 `ATMARK_AUTH_ON_SITE=true`): 비로그인 `/`·`/signup`·`/app` 은 홈의
 * `https://atmark.ai/login`·`/signup`(영어 — 접두어 없음, 한국어는 `/kr/…` — 언어는 아래 규칙 그대로)으로 302. 메일 링크 착지(`/login`·`/signup/verify`)는
 * 콘솔에 그대로다(결속 쿠키·세션이 콘솔 호스트에 있다). 스위치가 꺼져 있으면 지금처럼 콘솔 자기 화면이다.
 *
 * **언어**(`signup-contract.md` §8): ① `?lang=ko|en` → 쿠키 `__Host-atmark_lang` 을 적고 **쿼리를 뺀 같은 경로로 302**(세션 리다이렉트보다
 * 먼저) ② 쿠키 ③ `Accept-Language` 의 첫 언어가 `en*` 이면 영어, 아니면 한국어. 페이지 응답은 `Vary: Cookie, Accept-Language`.
 */

import { selectLang, isLang, type Lang } from '../ui/i18n';
import {
  renderAppPage,
  renderInvitePage,
  renderLoginLandingPage,
  renderLoginPage,
  renderSignupLandingPage,
  renderSignupPage,
  type AdminUiPage,
} from '../ui/index';
import type { AdminCall } from '../context';
import {
  authOnSite,
  htmlResponse,
  LANG_COOKIE,
  langCookie,
  redirect,
  SITE_LOGIN_URLS,
  SITE_SIGNUP_URLS,
  type AdminResponse,
} from '../http';

/** `?lang=` 이 있으면 쿠키를 적고 그 쿼리를 뺀 같은 경로로 302. 값이 ko|en 이 아니면 무시한다. */
function langRedirect(call: AdminCall): AdminResponse | null {
  const requested = call.request.query['lang'];
  if (!isLang(requested)) return null;
  const rest = new URLSearchParams(Object.entries(call.request.query).filter(([key]) => key !== 'lang')).toString();
  return redirect(rest === '' ? call.request.path : `${call.request.path}?${rest}`, [langCookie(requested)]);
}

export function pageLang(call: AdminCall): Lang {
  return selectLang({ cookie: call.request.cookies[LANG_COOKIE], acceptLanguage: call.request.headers['accept-language'] });
}

/** 비로그인 방문을 홈으로 보낼 곳 — 스위치가 꺼져 있으면 `null`(콘솔 화면을 그대로 준다). */
type SiteEntry = typeof SITE_LOGIN_URLS | null;

function page(
  call: AdminCall,
  render: (lang: Lang) => AdminUiPage,
  sessionRedirect: 'if-session' | 'if-no-session' | null,
  siteEntry: SiteEntry,
): AdminResponse {
  const switched = langRedirect(call);
  if (switched !== null) return switched;
  if (sessionRedirect === 'if-session' && call.session !== null) return redirect('/app');
  if (siteEntry !== null && authOnSite() && call.session === null) return redirect(siteEntry[pageLang(call)]);
  if (sessionRedirect === 'if-no-session' && call.session === null) return redirect('/');
  const rendered = render(pageLang(call));
  return htmlResponse(rendered.html, rendered.csp, call.request.headers['accept-encoding']);
}

function serve(
  call: AdminCall,
  render: (lang: Lang) => AdminUiPage,
  sessionRedirect: 'if-session' | 'if-no-session' | null,
  siteEntry: SiteEntry = null,
): Promise<AdminResponse> {
  return Promise.resolve(page(call, render, sessionRedirect, siteEntry));
}

export function handleLoginPage(call: AdminCall): Promise<AdminResponse> {
  return serve(call, renderLoginPage, 'if-session', SITE_LOGIN_URLS);
}

export function handleLoginLandingPage(call: AdminCall): Promise<AdminResponse> {
  return serve(call, renderLoginLandingPage, null);
}

export function handleAppPage(call: AdminCall): Promise<AdminResponse> {
  return serve(call, renderAppPage, 'if-no-session', SITE_LOGIN_URLS);
}

export function handleSignupPage(call: AdminCall): Promise<AdminResponse> {
  return serve(call, renderSignupPage, 'if-session', SITE_SIGNUP_URLS);
}

export function handleSignupLandingPage(call: AdminCall): Promise<AdminResponse> {
  return serve(call, renderSignupLandingPage, null);
}

export function handleInvitePage(call: AdminCall): Promise<AdminResponse> {
  return serve(call, renderInvitePage, null);
}
