/**
 * src/notify/invite-template.ts — 조직 초대 메일의 **고정 템플릿**. 순수 함수 하나(보내지 않는다).
 *
 * 가입 메일(`signup-template.ts`)과 같은 규율(창업자 결정 F-2): **조직 이름을 싣지 않는다** — 조직 이름은 가입한 사람이 고른
 * 문자열이라, 임의 주소로 가는 메일에 실리는 순간 피싱 문구의 자리가 된다("OO 은행 보안 점검 팀에 초대되었습니다"). 들어가는 것은
 * 링크(우리 상수 호스트 + 서명 토큰) · 만료 시각 · **초대한 사람의 주소**뿐이다. 초대자 주소는 그 사람이 로그인으로 증명한
 * 값이고(`users.email` — 모양 CHECK: 공백·줄바꿈·꺾쇠 없음) 받는 사람이 "누가 보냈나" 를 판단할 유일한 근거다.
 * 초대자 주소는 HTML 에서 굵게만 보이고 **반드시 이스케이프된다**(DB CHECK 가 꺾쇠를 막지만 틀은 그것에 기대지 않는다). 링크로 만들지 않는다.
 *
 * **초대 링크는 남긴다(2026-10-10).** 로그인 링크를 없앤 결정은 "링크로 로그인" 을 없앤 것이다. 초대 링크(`atk_invite_`)는 세션을 만들지 않는다 —
 * 착지에서 버튼을 누르면 초대받은 주소로 **로그인 코드** 메일이 한 통 더 가고, 그 코드를 같은 브라우저에 입력해야 들어온다.
 *
 * **한 통에 한 언어** — 받는 사람(초대받은 사용자)의 언어(`users.mail_locale` → 'en'). 문구는 `INVITE_COPY.<locale>` 에만 있다.
 */

import type { MailCopyDictionary, MailLocale } from '../i18n/locales';
import { INVITE_TTL_MS } from '../security/invite-token';
import { renderMail, type MailInline, type MailLine, type RenderedMail } from './mail-layout';

/** 초대 유효 일수 — 초대 토큰 수명과 같은 값. */
const INVITE_VALID_DAYS = INVITE_TTL_MS / 86_400_000;

export interface InviteCopy {
  readonly subject: string;
  readonly preheader: string;
  /** 머리 문장 — 초대자 주소(굵게)를 받는다. */
  readonly heading: (inviter: MailInline) => MailLine;
  /** 할 일 한 문장(초대 열기 → 로그인 코드 · 유효 기간). */
  readonly body: (days: number) => string;
  readonly buttonLabel: string;
  readonly note: string;
}

// ===========================================================================
// ✎ 초대 메일 문구 — 문구 작성자가 고치는 곳. `?` 를 쓰지 않는다. 용어: login code(sign-in 금지 — 용어집 §6.4).
// ===========================================================================

export const INVITE_COPY: MailCopyDictionary<InviteCopy> = {
  en: {
    subject: "You're invited to an Atmark organization",
    preheader: "You'll log in with a code sent to this address.",
    heading: (inviter) => [inviter, ' invited you to Atmark'],
    body: (days) => `Open the invitation to join their organization. It's valid for ${String(days)} days.`,
    buttonLabel: 'Open invitation',
    note: "If you don't know the sender, you can ignore this email.",
  },
  ko: {
    subject: 'Atmark 조직에 초대되었습니다',
    preheader: '이 주소로 받은 코드로 로그인합니다.',
    heading: (inviter) => [inviter, ' 님이 Atmark에 초대했습니다'],
    body: (days) => `초대를 열어 참여해 주세요. ${String(days)}일 동안 유효합니다.`,
    buttonLabel: '초대 열기',
    note: '모르는 사람이 보낸 초대라면 이 메일은 무시하셔도 됩니다.',
  },
};

// ===========================================================================

/** 초대 메일 한 통 — 한 언어 · 링크 하나(초대 착지). `expiresAt` 은 호출 모양을 지키려고 받는다 — 문구는 상수 일수를 말한다. */
export function renderInviteMail(
  view: { readonly link: string; readonly inviterEmail: string; readonly expiresAt: Date },
  locale: MailLocale,
): RenderedMail {
  const copy = INVITE_COPY[locale];
  return renderMail({
    subject: copy.subject,
    preheader: copy.preheader,
    link: view.link,
    section: {
      lang: locale,
      lead: [copy.heading({ strong: view.inviterEmail })],
      body: [copy.body(INVITE_VALID_DAYS)],
      buttonLabel: copy.buttonLabel,
      notes: [[copy.note]],
    },
  });
}
