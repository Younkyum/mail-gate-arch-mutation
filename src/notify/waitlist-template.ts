/**
 * src/notify/waitlist-template.ts — **대기 확인 메일**과 **초대 메일**의 고정 템플릿. 순수 함수(보내지 않는다).
 *
 * 환영 메일(`welcome-template.ts`)과 같은 모양이다: **한 언어로만**(받는 사람은 아직 사용자가 아니다 — 대기 등록 때의 화면 언어
 * `waitlist_entries.lang` → `waitlist_mails.lang` → 'en', 알림기가 `resolveMailLocale` 로 고른다. 문구는 `WAITLIST_COPY.<locale>` 에만 있다),
 * 편지 모양(본문 문단 → (초대만) 버튼 → 맺음 문단), 같은 공용 틀(`mail-layout.ts` — 무채색 · 원격 자원 0 · 링크 하나).
 *
 * 보간하는 값은 **초대 링크 하나**다(초대 메일만): 가입 화면 URL(언어별 상수) + fragment `#invite=<받는 주소의 base64url>` — 가입 화면이 주소 칸을
 * 미리 채운다. fragment 는 서버·로그로 가지 않고, 주소는 받는 사람 자신의 것이다. 링크 모양은 공용 틀이 한 번 더 본다(`assertMailLink` — 쿼리 없음).
 * 대기 확인 메일은 링크가 없다(버튼 없음) — **예외 하나**(202609301530): 용도가 "모르는 사람에게 먼저 발송"(`outreach`)인 항목의 확인 메일은 보류를 알리는
 * 조건부 문단과 문서 "Atmark가 맞지 않는 용도"(`WAITLIST_NOT_FOR_URLS`, 언어별 상수) 링크 하나를 싣는다. 새 메일을 보내지 않는다 — 같은 확인 메일의 모양만 다르다.
 */

import type { MailCopyDictionary, MailLocale } from '../i18n/locales';
import { renderMail, type RenderedMail } from './mail-layout';

export type WaitlistMailKind = 'confirmation' | 'invitation';

/** 초대 메일의 가입 화면 — 언어별 상수(홈의 가입 화면 · `src/site/page.ts` `sitePath`). */
export const WAITLIST_SIGNUP_URLS: Readonly<Record<MailLocale, string>> = {
  ko: 'https://atmark.ai/kr/signup',
  en: 'https://atmark.ai/signup',
};

/**
 * 보류 안내의 문서 링크(202609301530) — "What Atmark is not for". 문서는 한국어가 접두어 없음(`/`), 영어가 `/en` 이다(`src/docs/constants.ts`
 * `docsLangPrefix`). 홈 화면의 보류 안내(`src/site/auth.ts` `waitlistNotForUrl`)와 같은 값(테스트).
 */
export const WAITLIST_NOT_FOR_URLS: Readonly<Record<MailLocale, string>> = {
  ko: 'https://docs.atmark.ai/get-started/not-for',
  en: 'https://docs.atmark.ai/en/get-started/not-for',
};

/** 가입 화면이 읽는 fragment 키(`src/site/auth.ts` 가입 스크립트와 같은 값). */
const WAITLIST_INVITE_FRAGMENT_KEY = 'invite';

/** 초대 링크 — 가입 화면 + `#invite=<base64url(주소)>`. base64url 은 `A-Za-z0-9_-` 뿐이라 공용 틀의 링크 모양을 벗어나지 않는다. */
export function waitlistInviteLink(lang: MailLocale, email: string): string {
  return `${WAITLIST_SIGNUP_URLS[lang]}#${WAITLIST_INVITE_FRAGMENT_KEY}=${Buffer.from(email, 'utf8').toString('base64url')}`;
}

// ===========================================================================
// ✎ 대기자 명단 메일 문구 — 소유자가 고치는 곳(2026-10-10 개편: 공용 도메인 이야기 삭제 · "작은 팀이 안정성을 위해 조금씩 넓힌다" ·
//   명단에서 빼 달라는 답장 안내 삭제 · "감사합니다").
//
//   - 여기 문자열만 고치면 text/plain·text/html 두 파트가 함께 바뀐다(한 원본).
//   - `?` 를 쓰지 않는다(시스템 메일 본문에 쿼리 문자가 없다는 단언 — `test/unit/notify/mail-html.test.ts`).
//   - 영어 문구에 한글을 넣지 않는다 · 한국어 문구와 영어 문구는 같은 내용이다.
//   - 확인 메일은 순번("차례" · "your turn")을 약속하지 않는다.
//   - 초대 유효 기간(14일)은 약관(`src/site/terms.ts`)과 같아야 한다.
// ===========================================================================

export interface WaitlistCopy {
  readonly subject: string;
  readonly preheader: string;
  /** 머리 한 줄(제목 크기). */
  readonly heading: string;
  /** 본문 문단들 — 지금 상황 → 할 일. */
  readonly paragraphs: readonly (readonly string[])[];
  /** 버튼 글자(초대 메일만 — HTML 만, text/plain 에서는 URL 한 줄). */
  readonly buttonLabel?: string;
  /** 맺음 문단들(버튼 뒤 — 서명). */
  readonly closing: readonly (readonly string[])[];
  /** 작은 글씨 문단들(맺음 뒤). */
  readonly notes?: readonly (readonly string[])[];
}

/** 확인 메일의 보류 조건부 문단(202609301530 — 용도 `outreach` 만) — 문단과 문서 링크의 버튼 글자. */
export interface WaitlistHoldCopy {
  readonly paragraph: readonly string[];
  readonly buttonLabel: string;
}

export interface WaitlistLocaleCopy {
  readonly confirmation: WaitlistCopy;
  readonly invitation: WaitlistCopy;
  /** 확인 메일의 보류 조건부 문단(202609301530 — 용도 `outreach` 만). */
  readonly hold: WaitlistHoldCopy;
}

export const WAITLIST_COPY: MailCopyDictionary<WaitlistLocaleCopy> = {
  en: {
    confirmation: {
      subject: "You're on the Atmark waitlist",
      preheader: 'There is nothing you need to do for now.',
      heading: "You're on the waitlist",
      paragraphs: [
        [
          "Thanks for your interest in Atmark. We're a small team, so we're opening access gradually to keep the service stable.",
          "When we can invite you, we'll email this address.",
        ],
      ],
      closing: [['Onve']],
      notes: [["If this wasn't you, you can ignore this email."]],
    },
    invitation: {
      subject: 'Your Atmark invitation is here',
      preheader: 'Use this email address to sign up.',
      heading: 'Your invitation is ready',
      paragraphs: [['You can now create your Atmark account. This invitation is valid for 14 days.']],
      buttonLabel: 'Create your account',
      closing: [
        ["Once you're in, create an agent and send it an email from your own inbox."],
        ["If it expires, reply to this email and we'll send a new one."],
        ['Onve'],
      ],
    },
    hold: {
      paragraph: ["Atmark isn't built for emailing people who haven't written to you first, so we can't invite you for that use."],
      buttonLabel: 'See what Atmark is not for',
    },
  },
  ko: {
    confirmation: {
      subject: 'Atmark 대기자 명단에 등록되었습니다',
      preheader: '지금은 따로 할 일이 없습니다.',
      heading: '대기자 명단에 등록되었습니다',
      paragraphs: [
        [
          'Atmark에 관심을 가져 주셔서 감사합니다. 작은 팀이 운영하고 있어, 서비스 안정성을 위해 이용 범위를 조금씩 넓히고 있습니다.',
          '초대해 드릴 수 있게 되면 이 주소로 알려 드리겠습니다.',
        ],
      ],
      closing: [['Onve 드림']],
      notes: [['직접 등록하지 않았다면 이 메일은 무시하셔도 됩니다.']],
    },
    invitation: {
      subject: 'Atmark 초대장이 도착했습니다',
      preheader: '이 주소로 가입해 주세요.',
      heading: '초대장이 준비되었습니다',
      paragraphs: [['기다려 주셔서 감사합니다. 이제 Atmark 계정을 만들 수 있습니다. 초대는 14일 동안 유효합니다.']],
      buttonLabel: '계정 만들기',
      closing: [
        ['가입한 뒤 에이전트를 하나 만들고, 내 메일함에서 그 주소로 메일을 보내 보세요.'],
        ['기한이 지났다면 이 메일에 답장해 주세요. 새 초대장을 보내 드리겠습니다.'],
        ['Onve 드림'],
      ],
    },
    hold: {
      paragraph: ['먼저 연락하지 않은 사람에게 보내는 용도는 아직 지원하지 않아, 지금은 초대해 드리기 어렵습니다.'],
      buttonLabel: 'Atmark에 맞지 않는 용도 보기',
    },
  },
};

// ===========================================================================

/**
 * 대기자 명단 메일 한 통 — 받는 사람의 언어 **하나**로. 초대 메일은 `email`(받는 주소)로 가입 링크를 만든다. `hold` 는 확인 메일에만 뜻이 있다
 * (용도 `outreach` — 보류 문단 + 문서 링크 하나). 초대 메일에는 무시한다.
 */
export function renderWaitlistMail(
  view: { readonly kind: WaitlistMailKind; readonly email: string; readonly hold?: boolean },
  locale: MailLocale,
): RenderedMail {
  const copy = WAITLIST_COPY[locale][view.kind];
  const hold = view.kind === 'confirmation' && view.hold === true ? WAITLIST_COPY[locale].hold : null;
  const link = view.kind === 'invitation' ? waitlistInviteLink(locale, view.email) : hold === null ? null : WAITLIST_NOT_FOR_URLS[locale];
  const buttonLabel = hold === null ? copy.buttonLabel : hold.buttonLabel;
  return renderMail({
    subject: copy.subject,
    preheader: copy.preheader,
    link,
    section: {
      lang: locale,
      lead: [copy.heading],
      paragraphs: hold === null ? copy.paragraphs : [...copy.paragraphs, hold.paragraph],
      ...(buttonLabel === undefined ? {} : { buttonLabel }),
      closing: copy.closing,
      notes: copy.notes ?? [],
    },
  });
}
