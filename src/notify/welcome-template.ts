/**
 * src/notify/welcome-template.ts — 셀프 가입 **환영 메일**의 고정 템플릿. 순수 함수 하나(보내지 않는다).
 *
 * 다른 시스템 메일과 다른 점 둘:
 *   - **한 언어로만 쓴다**(이제 모든 시스템 메일이 그렇다 — 2026-10-10). 받는 사용자의 설정(`users.mail_locale` — 가입 확정 때 가입 언어로 채워진다)
 *     → 가입할 때 고른 화면 언어(`welcome_mails.lang`) → 'en'. 알림기가 고른다. 문구는 `WELCOME_COPY.<locale>` 에만 있다.
 *   - **편지 모양이다.** 제목 크기 머리 문장·코드·작은 글씨 안내가 없고, 본문 문단 → 콘솔 버튼 → 맺음 문단이다. 디자인은 같은 공용 틀
 *     (`mail-layout.ts` — 무채색 · 원격 자원 0 · 링크 하나 · 버튼 아래 같은 href 의 원문 URL)이다.
 *
 * 본문에 보간하는 값이 **하나도 없다** — 받는 사람의 주소·조직 이름·가입 시각을 싣지 않는다. 입력은 언어 하나뿐이다.
 */

import type { MailCopyDictionary, MailLocale } from '../i18n/locales';
import { renderMail, type RenderedMail } from './mail-layout';

/** 콘솔 버튼의 목적지 — 상수(보간 없음). 공용 틀의 링크 모양(`assertMailLink` — 경로 `/` 가 있어야 한다)을 따른다. */
export const WELCOME_CONSOLE_URL = 'https://console.atmark.ai/';

/** 설정 안내(문서 "에이전트 연결 방법 고르기") — 언어별 상수. 문서는 한국어가 접두어 없음 · 영어가 `/en`(`src/docs/constants.ts` `docsLangPrefix`). */
export const WELCOME_SETUP_GUIDE_URLS: Readonly<Record<MailLocale, string>> = {
  ko: 'https://docs.atmark.ai/connect/overview',
  en: 'https://docs.atmark.ai/en/connect/overview',
};

// ===========================================================================
// ✎ 환영 메일 문구 — 소유자가 고치는 곳 (2026-10-10 개편: 15분 통화 · "제가 직접 읽고 답장드립니다" 삭제 · "감사합니다" · 타사 제품 이름 없음)
//
//   - 여기 문자열만 고치면 text/plain·text/html 두 파트가 함께 바뀐다(한 원본).
//   - `?` 를 쓰지 않는다(시스템 메일 본문에 쿼리 문자가 없다는 단언 — `test/unit/notify/mail-html.test.ts`).
//   - 영어 문구에 한글을 넣지 않는다 · 한국어 문구와 영어 문구는 같은 내용이다.
// ===========================================================================

export interface WelcomeCopy {
  readonly subject: string;
  /** 첫 문단(인사 + 감사 한 번). */
  readonly greeting: string;
  /** 숨은 미리보기 — 본문에 없는 사실 하나. */
  readonly preheader: string;
  /** 둘째 문단 — 감사 + 시작하는 법(한 문장, 용어 없이). */
  readonly intro: string;
  /** 콘솔 버튼 글자(HTML 만 — text/plain 에서는 URL 앞 한 줄). */
  readonly buttonLabel: string;
  /** 버금 링크(설정 안내 문서) 글자. */
  readonly guideLabel: string;
  /** 답장 안내 문단. */
  readonly reply: string;
  /** 서명(한 줄씩). */
  readonly signOff: readonly string[];
}

export const WELCOME_COPY: MailCopyDictionary<WelcomeCopy> = {
  ko: {
    subject: 'Atmark에 오신 것을 환영합니다',
    preheader: '콘솔을 바로 쓸 수 있습니다.',
    greeting: "안녕하세요. Atmark를 만든 Younkyum 'Onve' Jin입니다. 가입해 주셔서 감사합니다.",
    intro: '콘솔에서 에이전트를 만들고, 설정 안내에 따라 쓰는 AI 에이전트에 연결해 보세요.',
    buttonLabel: '콘솔 열기',
    guideLabel: '설정 안내 보기',
    reply: '막히는 곳이 있으면 답장해 주세요.',
    signOff: ['Onve 드림'],
  },
  en: {
    subject: 'Welcome to Atmark',
    preheader: 'Your console is ready to use.',
    greeting: "Hi, I'm Younkyum 'Onve' Jin, and I built Atmark. Thank you for signing up.",
    intro: 'Create an agent in the console, then connect it to your AI agent using the setup guide.',
    buttonLabel: 'Open console',
    guideLabel: 'Read the setup guide',
    reply: 'If anything gets in your way, just reply.',
    signOff: ['Onve'],
  },
};

// ===========================================================================

/** 환영 메일 한 통 — 받는 사람의 언어 **하나**로. */
export function renderWelcomeMail(locale: MailLocale): RenderedMail {
  const copy = WELCOME_COPY[locale];
  return renderMail({
    subject: copy.subject,
    preheader: copy.preheader,
    link: WELCOME_CONSOLE_URL,
    secondaryLink: { href: WELCOME_SETUP_GUIDE_URLS[locale], label: copy.guideLabel },
    section: {
      lang: locale,
      lead: [],
      paragraphs: [[copy.greeting], [copy.intro]],
      buttonLabel: copy.buttonLabel,
      closing: [[copy.reply], [...copy.signOff]],
      notes: [],
    },
  });
}
