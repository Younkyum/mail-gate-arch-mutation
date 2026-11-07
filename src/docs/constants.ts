/**
 * src/docs/constants.ts — 사용자 문서(`https://docs.atmark.ai`)의 고정 값. 페이지·핸들러·테스트·CDK 가 이 파일에서 읽는다.
 *
 * 홈(`src/site/constants.ts`)과 겹치는 값(홈 출처·콘솔 출처·문의 주소)은 **옮겨 적는다** — 문서 번들은 `src/site/**` 를 import 하지 않는다
 * (`test/unit/docs/docs-bundle.test.ts`). 둘이 같은지는 `test/unit/docs/docs-sources.test.ts` 가 본다.
 * import 가 없는 값 파일이다.
 */

export const DOCS_HOST = 'docs.atmark.ai';
export const DOCS_ORIGIN = `https://${DOCS_HOST}`;

/** 홈 출처(요금제·약관 링크, OG 이미지) — `src/site/constants.ts` `SITE_ORIGIN` 과 같다(테스트). */
export const HOME_ORIGIN = 'https://atmark.ai';
/** 콘솔 출처(머리의 "콘솔" 버튼) — `src/site/constants.ts` `CONSOLE_ORIGIN` 과 같다(테스트). */
export const CONSOLE_URL = 'https://console.atmark.ai';
/** 문의 — `src/site/constants.ts` `CONTACT_EMAIL` 과 같다(테스트). */
export const SUPPORT_EMAIL = 'support@atmark.ai';

/** 문서 언어. 한국어는 접두어 없음(`/`), 영어는 `/en`. Accept-Language 로 옮기지 않는다(홈과 같은 규칙). */
export type DocsLang = 'ko' | 'en';
export const DOCS_LANGS: readonly DocsLang[] = ['ko', 'en'];

export function docsLangPrefix(lang: DocsLang): string {
  return lang === 'en' ? '/en' : '';
}

export function docsHomePath(lang: DocsLang): string {
  return lang === 'en' ? '/en' : '/';
}

/**
 * 문서 플래그 — 운영에서 사용자에게 켜져 있지 않은 기능의 페이지(`feature:`)·절(`:::feature`)을 숨긴다(계획 §3 "미공개·플래그 기능 결정").
 * 기능을 운영에서 켜는 날 같은 커밋에서 여기를 켠다. 요금제 한도 표(`{{plan-limits}}`)의 해당 행도 같이 숨는다.
 * 절은 `:::feature 이름`(켜졌을 때만) · `:::feature !이름`(꺼졌을 때만)으로 쓴다.
 */
export const DOCS_FEATURES = {
  /** 별칭 주소 — 운영 전체 공개(2026-09-29). */
  aliases: true,
  /** 발신 첨부 — 운영 전체 공개(2026-09-29). */
  attachments: true,
  /** 고객 도메인(`email/custom-domains` · 주소 · 별칭 · 에이전트 만들기 · 조직 API 키의 절) — 꺼짐. 베타를 여는 날(M5) 켠다. */
  customDomains: false,
  /**
   * SDK 게시(npm `atmark-sdk` · PyPI `atmark-sdk`) — 꺼짐. 진윤겸이 게시한 날 `src/api/discovery.ts` `SDK_PUBLISHED` 와 **같은 커밋에서** 켠다
   * (둘이 같은지는 `test/unit/docs/docs-sdk.test.ts`). 켜면 `connect/sdks` 등의 "준비 중" 절이 설치 줄로 바뀐다. 런북 `docs/runbooks/sdk-publish.md`.
   */
  sdkPublished: false,
} as const satisfies Readonly<Record<string, boolean>>;

export type DocsFeature = keyof typeof DOCS_FEATURES;

export function isDocsFeature(value: string): value is DocsFeature {
  return Object.prototype.hasOwnProperty.call(DOCS_FEATURES, value);
}

/** 홈 OG 이미지(1200×630 PNG) — 문서는 이미지를 따로 만들지 않고 홈의 것을 **내용 해시 경로**로 가리킨다(URL 은 `layout.ts` `ogImageUrl` — `src/ui/og-version.ts`). */
export const OG_IMAGE = { width: 1200, height: 630, contentType: 'image/png' } as const;
