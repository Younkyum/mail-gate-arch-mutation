/**
 * src/mail/events/from-alignment.ts — **SES 이벤트의 헤더 From 대 발신 주소** (2026-09-24 최종 검증 M3b). I/O 없는 순수 함수.
 *
 * IAM 의 `ses:FromAddress` 조건은 SESv2 `FromEmailAddress` 를 본다. raw MIME 안의 `From:` 헤더가 그 값과 달라도 SES 가 거부하는지는
 * AWS 문서가 말하지 않는다(ADR-0006 "M3b"). 전송단은 두 값이 같은지 보내기 전에 확인하지만(`ses-transport.ts`
 * `assertHeaderFromMatches`), 발송 역할 자격증명이 탈취되면 그 코드는 지나지 않는다. 그래서 SES 가 되돌려 주는 이벤트에서 **사후로**
 * 본다: `mail.source`(= `FromEmailAddress`)와 `mail.commonHeaders.from`(실제 나간 헤더).
 *
 * 판정:
 *   - `mismatch` — 헤더 From 이 하나가 아니거나, 그 주소(꺾쇠 안, 소문자)가 발신 주소(소문자)와 다르다.
 *   - `reserved` — 헤더 From 문자열(공백·제어·보이지 않는 문자를 지우고 소문자로)에 예약 주소가 들어 있는데, 발신 주소가 **정확히**
 *     그 예약 주소가 아니다. 표시 이름 사칭(`"login@atmark.ai" <x@atmark.ai>`)도 여기 걸린다 — 우리 세 발송면은 맨 주소만 쓴다.
 *     login-mailer(발신 `login@`)·contact-forwarder(발신 `support@`)의 정상 메일은 발신 주소가 예약 주소 자신이라 걸리지 않는다
 *     (IAM 이 그 두 발신을 그 두 주체에만 허락한다).
 *   - `aligned` — 둘 다 아니다.
 *   - `unknown` — `source` 나 `commonHeaders.from` 이 없다. 판정하지 않는다(알람을 올리지 않는다 — 형태 변화는 로그로만).
 *
 * 주소는 결과에 싣지 않는다(PII — `SesEvent` 와 같은 규율). 판정 종류만 돌려준다.
 */

/**
 * 예약 발신 주소 — `src/notify/owner-login-notifier.ts` `OWNER_LOGIN_FROM_ADDRESS`, `src/contact/intake.ts` `CONTACT_ADDRESS`, 환영 메일 발신
 * `onve@atmark.ai`(ADR-0006 2026-09-30 개정 — CDK `WELCOME_MAIL_FROM_ADDRESS`)와 같은 값(`test/unit/mail/from-alignment.test.ts` 가 일치를 단언한다 —
 * `mail/` 은 `notify/` 를 import 하지 않는다). 판정은 **글자 그대로**다: 헤더에 이 주소가 있으면 발신 주소도 정확히 그 주소여야 한다(`onve@` 는
 * login-mailer 와 지원 에이전트가 함께 쓰지만, 둘 다 발신 주소 = 헤더 주소라 걸리지 않는다).
 */
export const RESERVED_FROM_ADDRESSES: readonly string[] = ['login@atmark.ai', 'support@atmark.ai', 'onve@atmark.ai'];

export type FromAlignment = 'aligned' | 'mismatch' | 'reserved' | 'unknown';

/** 헤더·발신 주소에서 지우는 것: 공백·C0/C1 제어·보이지 않는 서식 문자(제로폭·양방향·BOM·소프트 하이픈). */
const STRIP = /[\s\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁯﻿]/gu;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** `Name <a@b>` → `a@b`, 맨 주소는 그대로. 마지막 꺾쇠 쌍을 쓴다(표시 이름 안의 꺾쇠를 비켜 간다). 소문자·앞뒤 공백 제거. */
function addressOf(mailbox: string): string {
  const angle = /<([^<>]*)>\s*$/u.exec(mailbox);
  return (angle === null ? mailbox : (angle[1] ?? '')).trim().toLowerCase();
}

/** `text` 안에 `address` 가 있고 그 바로 앞이 로컬파트 글자(`[a-z0-9._-]`)가 아니다(맨 앞이거나 `<`·`"`·`,` 등). */
function mentions(text: string, address: string): boolean {
  for (let at = text.indexOf(address); at >= 0; at = text.indexOf(address, at + 1)) {
    if (at === 0 || !/[a-z0-9._-]/u.test(text.charAt(at - 1))) return true;
  }
  return false;
}

/** SES 이벤트의 `mail` 객체 → 판정. **던지지 않는다.** */
export function checkFromAlignment(mail: unknown): FromAlignment {
  const record = asRecord(mail);
  const source = record?.['source'];
  const headerFrom = asRecord(record?.['commonHeaders'])?.['from'];
  if (typeof source !== 'string' || source === '' || !Array.isArray(headerFrom) || headerFrom.length === 0) return 'unknown';
  if (!headerFrom.every((entry): entry is string => typeof entry === 'string')) return 'mismatch';

  const sourceAddress = addressOf(source);
  const flattened = headerFrom.join(',').replace(STRIP, '').toLowerCase();
  // 발신 주소는 **글자 그대로** 비교한다(공백·대소문자 변형은 정상 주체가 아니다 — IAM 은 두 주체에 정확한 소문자 주소만 허락한다).
  //   예약 주소 **앞**에 로컬파트 글자가 붙은 것(`xlogin@atmark.ai` — 정당한 에이전트 주소)은 예약 주소가 아니다.
  if (RESERVED_FROM_ADDRESSES.some((reserved) => mentions(flattened, reserved) && source !== reserved)) return 'reserved';

  if (headerFrom.length !== 1 || addressOf(headerFrom[0] ?? '') !== sourceAddress) return 'mismatch';
  return 'aligned';
}
