/**
 * src/admin/routes/waitlist.ts — 대기자 명단 등록(`POST /api/waitlist`, 202609301520). 홈(`https://atmark.ai`)의 대기자 명단 폼이 부른다(교차 출처 —
 * `CROSS_SITE_AUTH_PATHS`). **이 파일도 메일을 보내지 않는다** — 확인 메일은 정의 함수가 outbox 에 쌓고 login-mailer 가 보낸다(ADR-0006).
 * 로직과 열거 방지 규율은 `admin/waitlist.ts`.
 */

import { clientIpUnavailable, kickLoginMailer, objectBody, type AdminCall } from '../context';
import { errorResponse, jsonResponse, LANG_COOKIE, type AdminResponse } from '../http';
import { isLang, selectLang } from '../ui/i18n';
import { requestWaitlist } from '../waitlist';

/**
 * `POST /api/waitlist {email, useCase, note?, heardFrom?, ref?, lang?, website?}` → **항상** 202 `{ok:true}`(새 주소 · 이미 대기 중 · 초대받음 · 이미
 * 가입 — 가리지 않는다. 용도가 "먼저 발송" 이어도 같다 — 보류 안내는 화면이 자기 입력으로 그린다). 모양 오류(이메일 · 용도 · 알게 된 곳 · 메모)만 400,
 * 요청자 상한만 429 — 둘 다 주소의 존재와 무관하다. `ref` 는 허용목록 밖이면 `none`(400 없음). 쿠키를 주지 않는다(이 경로는 세션·결속을 만들지 않는다).
 */
export async function handleWaitlistRequest(call: AdminCall): Promise<AdminResponse> {
  const sourceIp = call.request.sourceIp;
  if (sourceIp === null) return clientIpUnavailable(call.request);
  const body = objectBody(call.request.body);
  const outcome = await requestWaitlist(call.deps.pool, call.deps.loginKeys, {
    email: body['email'],
    note: body['note'],
    useCase: body['useCase'],
    heardFrom: body['heardFrom'],
    ref: body['ref'],
    honeypot: body['website'],
    sourceIp,
    // 확인·초대 메일의 언어 — 폼의 화면 언어 → 콘솔 언어 쿠키 → Accept-Language.
    lang: isLang(body['lang'])
      ? body['lang']
      : selectLang({ cookie: call.request.cookies[LANG_COOKIE], acceptLanguage: call.request.headers['accept-language'] }),
  });
  if (outcome.kind === 'rate_limited') {
    return errorResponse(429, 'rate_limited', '요청이 너무 잦다 — 잠시 뒤 다시 시도하라.');
  }
  // 커밋 뒤 — 확인 메일 행이 생겼을 수 있다(없어도 같게 깨운다 — 열거 방지).
  await kickLoginMailer(call.deps);
  return jsonResponse(202, { ok: true });
}
