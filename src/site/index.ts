/**
 * src/site — 홈(`https://atmark.ai`). 정적 페이지(영어 `/…` · 한국어 `/kr/…` 두 벌)와 HTTP 처리. **DB·비밀·SES·S3 에 닿지 않는다** —
 * 바깥 import 는 `node:crypto`·`node:zlib`(CSP 해시·gzip) · `src/ui/`(로고·파비콘·폰트·토큰) · 값 파일(`src/billing/constants.ts` · `src/billing/plans.ts`)뿐이다
 * (`test/unit/site/site-bundle.test.ts` 가 번들로 단언). 경로 표는 `http.ts`(`SITE_ROUTES`), 페이지 id 는 `page.ts`(`SiteDocumentId`).
 *
 * 페이지는 요청마다 달라지는 값이 없어 모듈 로드 때 한 번 만든다(해시 계산 1회). 아래 `render*` 는 그 값을 언어로 고르는 얇은 진입점이다.
 */

import { ABUSE_PAGES } from './abuse';
import { LOGIN_PAGES, SIGNUP_PAGES, WAITLIST_PAGES } from './auth';
import { CHANGELOG_PAGES } from './changelog';
import type { SiteLang } from './constants';
import { HOME_PAGES } from './home';
import { NOT_FOUND_PAGES } from './not-found';
import type { SitePage } from './page';
import { PRICING_PAGES } from './pricing';
import { PRIVACY_PAGES } from './privacy';
import { REFUND_PAGES } from './refund';
import { TERMS_PAGES } from './terms';
import { USE_CASES_PAGES } from './use-cases';

export type { SitePage } from './page';
export type { SiteLang } from './constants';
export { handleSiteRequest, SITE_ROUTES, type SiteHttpEvent, type SiteHttpResult } from './http';

export function renderHomePage(lang: SiteLang = 'ko'): SitePage {
  return HOME_PAGES[lang];
}

export function renderPricingPage(lang: SiteLang = 'ko'): SitePage {
  return PRICING_PAGES[lang];
}

export function renderRefundPage(lang: SiteLang = 'ko'): SitePage {
  return REFUND_PAGES[lang];
}

export function renderPrivacyPage(lang: SiteLang = 'ko'): SitePage {
  return PRIVACY_PAGES[lang];
}

export function renderTermsPage(lang: SiteLang = 'ko'): SitePage {
  return TERMS_PAGES[lang];
}

export function renderLoginPage(lang: SiteLang = 'ko'): SitePage {
  return LOGIN_PAGES[lang];
}

export function renderSignupPage(lang: SiteLang = 'ko'): SitePage {
  return SIGNUP_PAGES[lang];
}

export function renderWaitlistPage(lang: SiteLang = 'ko'): SitePage {
  return WAITLIST_PAGES[lang];
}

export function renderUseCasesPage(lang: SiteLang = 'ko'): SitePage {
  return USE_CASES_PAGES[lang];
}

export function renderAbusePage(lang: SiteLang = 'ko'): SitePage {
  return ABUSE_PAGES[lang];
}

export function renderChangelogPage(lang: SiteLang = 'ko'): SitePage {
  return CHANGELOG_PAGES[lang];
}

export function renderNotFoundPage(lang: SiteLang = 'ko'): SitePage {
  return NOT_FOUND_PAGES[lang];
}
