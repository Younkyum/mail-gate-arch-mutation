/**
 * src/notify/owner-login-template.ts — 소유자 로그인 메일의 **고정 템플릿**. 순수 함수 하나(보내지 않는다).
 *
 * 이 메일에는 **누구도 고른 문자열이 없다** — 에이전트 값·조직 이름·입력 이메일 어느 것도 싣지 않는다.
 * 들어가는 것은 6자리 코드(로그인 키로 파생한 숫자)뿐이다(만료는 상수 분 — `OWNER_LOGIN_LINK_TTL_MS`). 로그인 요청은 누구나(주소만 알면) 보낼 수 있으므로, 본문에 요청자가
 * 정한 값이 한 글자라도 있으면 그것이 소유자를 겨냥한 피싱 문구의 자리가 된다.
 *
 * **코드만(2026-10-10 진윤겸 결정 — "링크 로그인은 이제 삭제할거야. 너무 복잡해.").** 예전에는 서명 토큰 링크(`atk_login_`)와 코드를 함께 실었다.
 * 이제 링크가 없다 — 메일에 URL 이 한 글자도 없고(HTML 에도 `http` 가 없다), 코드는 로그인을 요청한 브라우저에 사람이 옮겨 적는다(결속은 DB 가 본다).
 * 옛 메일의 링크는 콘솔 `/login` 이 "더는 쓰지 않는 링크 — 코드로 로그인하세요" 화면으로 받는다.
 *
 * **코드는 제목에도 싣는다(2026-10-10 문구 개편)** — 메일 앱의 "코드 복사" 표시와 알림 미리보기가 코드를 집게. 본문에서는 제 줄에 따로 서고
 * (HTML 은 큰 고정폭 · `user-select: all` — 한 번 누르면 통째로 선택), text/plain 파트에도 같은 줄로 있다. 숨은 미리보기 문장에는 넣지 않는다.
 * 문구 구조: 지금 상황(코드) → 할 일(입력 · 만료 분) → 작은 글씨 한 줄(요청하지 않았다면 무시).
 *
 * **한 통에 한 언어** — 받는 사람의 언어(`users.mail_locale` → 'en', 알림기가 고른다). 문구는 `OWNER_LOGIN_COPY.<locale>` 에만 있다.
 * text/plain + text/html 두 파트는 공용 틀(`mail-layout.ts`)이 한 구조에서 함께 만든다.
 */

import type { MailCopyDictionary, MailLocale } from '../i18n/locales';
import { OWNER_LOGIN_LINK_TTL_MS } from '../security/login-code';
import { assertMailCode, renderMail, type MailLine, type RenderedMail } from './mail-layout';

/** 코드 수명(분) — 문구가 말한다. 로그인 시도 행의 수명과 같은 값. */
const OWNER_LOGIN_CODE_MINUTES = OWNER_LOGIN_LINK_TTL_MS / 60_000;

export interface OwnerLoginCopy {
  /** 제목 — 코드를 싣는다. */
  readonly subject: (code: string) => string;
  /** 숨은 미리보기 문장 — **코드를 넣지 않는다**. 제목 · 머리 · 본문에 없는 사실 하나(한 번만 쓴다). */
  readonly preheader: string;
  readonly heading: string;
  readonly codeLabel: string;
  /** 코드 아래 — 할 일 한 문장(입력 · 만료). */
  readonly body: (minutes: number) => readonly MailLine[];
  /** 작은 글씨 한 줄 — 요청하지 않았다면 무시. */
  readonly note: string;
}

// ===========================================================================
// ✎ 로그인 메일 문구 — 문구 작성자가 고치는 곳(구조는 아래 함수가 정한다). `?` 를 쓰지 않는다(본문에 쿼리 문자가 없다는 단언).
// ===========================================================================

export const OWNER_LOGIN_COPY: MailCopyDictionary<OwnerLoginCopy> = {
  en: {
    subject: (code) => `${code} is your Atmark login code`,
    preheader: 'It works only once.',
    heading: 'Your Atmark login code',
    codeLabel: 'Code',
    body: (minutes) => [`Enter this code to log in. It expires in ${String(minutes)} minutes.`],
    note: "If you didn't request it, you can ignore this email.",
  },
  ko: {
    subject: (code) => `Atmark 로그인 코드 ${code}`,
    preheader: '한 번만 쓸 수 있습니다.',
    heading: 'Atmark 로그인 코드',
    codeLabel: '코드',
    body: (minutes) => [`로그인 화면에 입력해 주세요. ${String(minutes)}분 뒤 만료됩니다.`],
    note: '요청하지 않았다면 이 메일은 무시하셔도 됩니다.',
  },
};

// ===========================================================================

/**
 * 로그인 메일 한 통 — 받는 사람의 언어 **하나**로. 6자리 코드는 제목과 본문(제 줄)에 있고, 숨은 미리보기 문장에는 없다. 링크가 없다(`link: null`).
 * `expiresAt` 은 호출 모양을 지키려고 받는다 — 문구는 상수 분(`OWNER_LOGIN_CODE_MINUTES`)을 말한다.
 */
export function renderOwnerLoginMail(view: { readonly code: string; readonly expiresAt: Date }, locale: MailLocale): RenderedMail {
  const copy = OWNER_LOGIN_COPY[locale];
  const code = assertMailCode(view.code);
  return renderMail({
    subject: copy.subject(code),
    preheader: copy.preheader,
    link: null,
    section: {
      lang: locale,
      lead: [copy.heading],
      code: { label: copy.codeLabel, value: code },
      body: copy.body(OWNER_LOGIN_CODE_MINUTES),
      notes: [[copy.note]],
    },
  });
}
