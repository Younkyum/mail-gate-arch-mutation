/**
 * src/i18n/locales.ts — **시스템 메일 언어의 단일 등록부**(2026-10-10 진윤겸 결정: 한 통에 한 언어 · 기본 영어).
 *
 * 언어를 하나 더하려면:
 *   1. 아래 `SUPPORTED_MAIL_LOCALES` 에 코드를 더한다(타입 `MailLocale` 이 따라 넓어진다 — 모든 템플릿 사전 `copy.<locale>` 이 컴파일 오류로 빈칸을 알린다).
 *   2. 새 마이그레이션에서 조회 표 `mail_locales` 에 같은 코드를 한 행 넣는다(`users.mail_locale` 은 그 표를 FK 로 가리킨다 —
 *      `202610101000_mail_locale.sql`). 등록부와 표가 같은 집합인지는 통합 테스트가 본다.
 *   3. 각 템플릿 사전(`src/notify/*-template.ts` 의 `…_COPY`)에 그 언어 문구를 채운다 — 키 집합이 같은지는
 *      `test/unit/notify/mail-locale-dictionaries.test.ts` 가 본다.
 *   4. 콘솔 설정의 선택지(`MAIL_LOCALE_LABELS`)에 그 언어의 이름을 더한다.
 *
 * 메일에 어떤 언어를 쓰는지(받는 사람별 결정 순서)는 `resolveMailLocale` 하나가 정한다.
 */

/** 지원하는 시스템 메일 언어 — 첫 값이 기본값이 아니다(기본은 `DEFAULT_MAIL_LOCALE`). */
export const SUPPORTED_MAIL_LOCALES = ['en', 'ko'] as const;

export type MailLocale = (typeof SUPPORTED_MAIL_LOCALES)[number];

/** 아무 선택도 저장돼 있지 않을 때의 언어. */
export const DEFAULT_MAIL_LOCALE: MailLocale = 'en';

/** 콘솔 설정의 선택지 이름 — 각 언어를 **그 언어로** 적는다(어느 화면 언어에서 보든 같은 글자). */
export const MAIL_LOCALE_LABELS: Readonly<Record<MailLocale, string>> = {
  en: 'English',
  ko: '한국어',
};

export function isMailLocale(value: unknown): value is MailLocale {
  return typeof value === 'string' && (SUPPORTED_MAIL_LOCALES as readonly string[]).includes(value);
}

/**
 * 받는 사람 한 명의 메일 언어. 앞에서부터 처음 지원하는 값:
 *   1. 그 사람(사용자)이 콘솔 설정에서 고른 언어(`users.mail_locale`).
 *   2. 이 메일에 저장된 양식 언어 — 아직 사용자가 아닌 사람이 대기자 명단 · 가입 양식에서 쓴 화면 언어(`waitlist_mails.lang` ·
 *      `signup_links.lang` · `welcome_mails.lang` · `ops_login_challenges.lang`).
 *   3. `DEFAULT_MAIL_LOCALE`('en').
 * 모르는 값(옛 행 · 지원을 거둔 언어)은 건너뛴다 — 메일은 언제나 지원하는 언어 하나로 나간다.
 */
export function resolveMailLocale(...candidates: readonly unknown[]): MailLocale {
  for (const candidate of candidates) if (isMailLocale(candidate)) return candidate;
  return DEFAULT_MAIL_LOCALE;
}

/**
 * 템플릿 문구 사전의 모양 — 지원하는 언어마다 같은 모양의 문구 한 벌(`copy.en` · `copy.ko`). 언어를 더하면 모든 사전이 컴파일 오류로 빈칸을 알린다.
 * 문구 작성자는 사전만 고친다 — 구조(코드 · 링크 · 순서)는 템플릿의 `render…(view, locale)` 가 정한다.
 */
export type MailCopyDictionary<T> = Readonly<Record<MailLocale, T>>;
