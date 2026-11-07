/**
 * src/notify/signup-template.ts — 가입 확인 메일의 **고정 템플릿**. 순수 함수 하나(보내지 않는다).
 *
 * 로그인 메일(`owner-login-template.ts`)과 같은 규율이고 더 엄격해야 한다 — 가입 요청은 **누구나 아무 주소로** 보낼 수 있다.
 * 그래서 본문에 요청자가 고른 문자열이 한 글자도 없다: 조직 이름·입력 이메일을 싣지 않는다(조직 이름을 싣는 순간 그 칸이
 * 임의 주소로 가는 피싱 문구의 자리가 된다 — "OO 은행 보안 점검: 아래 버튼을 누르세요"). 들어가는 것은 6자리 코드(로그인 키로 파생한 숫자) ·
 * 만료 분(상수)뿐이다. 코드는 제목에도 싣는다(2026-10-10 문구 개편 — 로그인 메일과 같은 이유).
 *
 * **코드만(2026-10-10 진윤겸 결정)** — 가입 확인 링크(`atk_signup_`)를 뺐다(로그인 링크와 같은 결정). 옛 메일의 링크는 콘솔 `/signup/verify` 가
 * "더는 쓰지 않는 링크 — 가입 화면의 코드 칸에 입력하세요" 화면으로 받는다.
 *
 * **한 통에 한 언어** — 받는 사람은 아직 사용자가 아니다: 가입 양식의 화면 언어(`signup_links.lang`) → 'en'. 문구는 `SIGNUP_COPY.<locale>` 에만 있다.
 */

import type { MailCopyDictionary, MailLocale } from '../i18n/locales';
import { SIGNUP_LINK_TTL_MS } from '../security/login-code';
import { assertMailCode, renderMail, type MailLine, type RenderedMail } from './mail-layout';

/** 코드 수명(분) — 가입 시도 행의 수명과 같은 값. */
const SIGNUP_CODE_MINUTES = SIGNUP_LINK_TTL_MS / 60_000;

export interface SignupCopy {
  readonly subject: (code: string) => string;
  /** 숨은 미리보기 문장 — **코드를 넣지 않는다.** */
  readonly preheader: string;
  readonly heading: string;
  readonly codeLabel: string;
  readonly body: (minutes: number) => readonly MailLine[];
  readonly note: string;
}

// ===========================================================================
// ✎ 가입 확인 메일 문구 — 문구 작성자가 고치는 곳. `?` 를 쓰지 않는다.
// ===========================================================================

export const SIGNUP_COPY: MailCopyDictionary<SignupCopy> = {
  en: {
    subject: (code) => `${code} is your Atmark sign-up code`,
    preheader: 'It works only once.',
    heading: 'Confirm your email',
    codeLabel: 'Code',
    body: (minutes) => [`Enter this code on the sign-up screen. It expires in ${String(minutes)} minutes.`],
    note: "If you didn't request it, you can ignore this email.",
  },
  ko: {
    subject: (code) => `Atmark 가입 확인 코드 ${code}`,
    preheader: '한 번만 쓸 수 있습니다.',
    heading: '이메일 주소를 확인해 주세요',
    codeLabel: '코드',
    body: (minutes) => [`가입 화면에 입력해 주세요. ${String(minutes)}분 뒤 만료됩니다.`],
    note: '요청하지 않았다면 이 메일은 무시하셔도 됩니다.',
  },
};

// ===========================================================================

/** 가입 확인 메일 한 통 — 한 언어 · 코드만(링크 없음). 코드는 제목과 본문에 있고 미리보기 문장에는 없다. 코드는 우리가 파생한 숫자다. */
export function renderSignupMail(view: { readonly code: string; readonly expiresAt: Date }, locale: MailLocale): RenderedMail {
  const copy = SIGNUP_COPY[locale];
  const code = assertMailCode(view.code);
  return renderMail({
    subject: copy.subject(code),
    preheader: copy.preheader,
    link: null,
    section: {
      lang: locale,
      lead: [copy.heading],
      code: { label: copy.codeLabel, value: code },
      body: copy.body(SIGNUP_CODE_MINUTES),
      notes: [[copy.note]],
    },
  });
}
