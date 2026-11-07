/**
 * src/site/constants.ts — 홈(`https://atmark.ai`)의 고정 값. 페이지·핸들러·테스트·CDK 가 **이 파일 하나**에서 읽는다.
 *
 * `CONTACT_EMAIL` 은 `support@atmark.ai` 다(US-009). 그 주소로 온 메일은 수신 파이프라인이 운영자 메일함으로 전달한다
 * (`src/contact/intake.ts` → `src/notify/contact-forwarder.ts`, ADR-0009) — 읽는 사람이 있는 메일함이다. 여기 한 곳이 푸터의 "문의" 와
 * 개인정보 처리 안내·이용약관의 문의처를 함께 정한다(`docs/runbooks/site.md` "공개 전 확인"). 값은 `CONTACT_ADDRESS` 와 같아야 한다
 * (`test/unit/contact/contact-forward.test.ts`).
 */

import type { PaidPlanCode } from '../billing/plans';

/** 홈의 정본 출처. `www` 는 여기로 301. */
export const SITE_HOST = 'atmark.ai';
export const SITE_WWW_HOST = 'www.atmark.ai';
export const SITE_ORIGIN = `https://${SITE_HOST}`;

/**
 * 신원 문서 호스트(표시용). 정본은 `src/passport/did.ts` 의 `IDENTITY_HOST` — 홈 번들은 `src/passport/**` 를 import 하지 않으므로
 * (`site-bundle.test.ts`) 값을 옮겨 적고, 테스트가 둘이 같은지 본다(`site-identity-card.test.ts`).
 */
export const SITE_IDENTITY_HOST = 'id.atmark.ai';

/**
 * 페이지 언어(진윤겸 2026-09-30 — **영어가 기본**). 영어는 접두어 없는 경로(`/`·`/pricing`…), 한국어는 `/kr` 아래(`/kr`·`/kr/pricing`…).
 * HTML 속성은 여전히 `lang="ko"`·`hreflang="ko"` 다 — 접두어만 `kr` 이다. 옛 `/en/…` 은 핸들러가 접두어 없는 경로로 301 한다(`http.ts`).
 * 접두어 없는 페이지 경로의 언어 협상(쿠키 `atmark_lang` · Accept-Language → `/kr…` 302)은 **엣지**(CloudFront Function, `edge-lang.ts`)가
 * 한다 — 핸들러는 경로로만 언어를 정한다(같은 URL 이 늘 같은 문서).
 */
export type SiteLang = 'ko' | 'en';
export const SITE_LANGS: readonly SiteLang[] = ['ko', 'en'];

/** 반대 언어 — 언어 전환 링크 · hreflang · `og:locale:alternate`. */
export const OTHER_LANG: Readonly<Record<SiteLang, SiteLang>> = { ko: 'en', en: 'ko' };

/** 한국어 경로 접두어. */
export const KO_PREFIX = '/kr';

/** 옛 영어 접두어 — 이 아래 경로는 접두어를 뗀 경로로 301(`http.ts`). */
export const LEGACY_EN_PREFIX = '/en';

/** 언어별 경로 접두어 — 영어는 없음, 한국어는 `/kr`. */
export function langPrefix(lang: SiteLang): string {
  return lang === 'ko' ? KO_PREFIX : '';
}

/**
 * 언어 선택 쿠키(엣지가 읽고 쓴다 — 핸들러는 보지 않는다). 값은 `ko`·`en`. 보이는 언어 전환 링크는 목적지 경로에 쿼리 `?hl=<언어>` 를 붙이고,
 * 엣지 함수가 그 쿼리를 보면 쿠키를 적고 쿼리 없는 같은 경로로 302 한다(스크립트 없이 — CSP 무관).
 */
export const SITE_LANG_COOKIE = 'atmark_lang';
export const SITE_LANG_QUERY = 'hl';

/**
 * 콘솔(소유자 관리 화면, `https://console.atmark.ai`). 로그인·가입 **폼**은 홈(`/login`·`/signup`, 영어 `/en/…`)에 있고(US-003),
 * 폼 스크립트가 콘솔 API 네 경로(요청 둘 · 코드 verify 둘)만 부른다 — 홈 페이지 CSP 의 `connect-src` 는 이 출처 하나다. 메일 링크 착지와 세션은 콘솔에 남는다
 * (응답의 결속 쿠키가 콘솔 호스트에 선다 — 두 호스트는 같은 사이트). 콘솔 쪽 CORS 는 `src/admin/router.ts`.
 */
export const CONSOLE_ORIGIN = 'https://console.atmark.ai';
export const CONSOLE_API: Readonly<{
  readonly login: string;
  readonly signup: string;
  readonly loginVerify: string;
  readonly signupVerify: string;
  readonly waitlist: string;
}> = {
  login: `${CONSOLE_ORIGIN}/api/login`,
  signup: `${CONSOLE_ORIGIN}/api/signup`,
  // 대기자 명단(202609301520) — 가입이 초대 전용이 됐다. 세션·결속 쿠키를 만들지 않는 등록 하나(항상 202).
  waitlist: `${CONSOLE_ORIGIN}/api/waitlist`,
  // 메일의 6자리 코드(2026-09-28) — 보낸 뒤 같은 화면에서 코드를 받아 verify 한다. 세션 쿠키는 콘솔 호스트에 서고, 성공하면 콘솔로 간다.
  loginVerify: `${CONSOLE_ORIGIN}/api/login/verify`,
  signupVerify: `${CONSOLE_ORIGIN}/api/signup/verify`,
};

/**
 * 로그인 여부 힌트(2026-09-30) — 모든 페이지의 머리 스크립트(`session-hint.ts`)가 `GET` 한 번(`credentials:'include'`)으로 묻는다.
 * 응답 `{"signedIn":true|false}` — 콘솔 세션 쿠키가 있는지만 알려 주고 누구인지는 말하지 않는다(콘솔 `src/admin/**` 가 낸다). 200 이 아니거나
 * 네트워크가 실패하면 로그아웃으로 본다(화면은 그대로).
 */
export const CONSOLE_SESSION_HINT_URL = `${CONSOLE_ORIGIN}/api/session/hint`;

/** 코드 verify 가 성공한 뒤 가는 곳 — 상수 둘뿐(스크립트는 응답의 경로를 따르지 않는다. `next`·`redirect` 는 둘 중 고르기만). */
export const CONSOLE_APP_URLS: Readonly<{ readonly app: string; readonly selectOrg: string }> = {
  app: `${CONSOLE_ORIGIN}/app`,
  selectOrg: `${CONSOLE_ORIGIN}/app#/select-org`,
};

/**
 * 검토 대기 조직의 에이전트 상한 — 가입 화면 안내문에 싣는다. 정본은 콘솔 `MAX_AGENTS_PER_PENDING_ORG`(`src/admin/ops/agents.ts`);
 * 홈 번들은 `src/admin/**` 를 import 하지 않으므로 값을 옮겨 적고, 테스트가 둘이 같은지 본다(`site-auth.test.ts`).
 */
export const PENDING_ORG_AGENT_LIMIT = 2;

/**
 * 환불 정책(`/refund`·`/en/refund`, WP-2 · 계획 §3-9) 공개 여부. **거짓이면 두 경로 404 · 푸터·가격 페이지 링크 없음.** 결제 스위치
 * (`atmark:billingEnabled`)와 무관하다. 진윤겸이 초안 문안을 그대로 승인했다(2026-09-26) — Paddle 운영 계정의 웹사이트 심사가 가격 페이지와
 * 환불 정책 URL 이 열려 있기를 요구하므로 운영 전환(런북 deploy §21-7)보다 먼저 켠다. 내리려면 `false` 로 되돌려 배포한다(런북 site §9.3).
 */
export const REFUND_POLICY_APPROVED = true;

/**
 * 결제로 사는 요금제의 **월 가격(USD)** — 가격 페이지(`/pricing`·`/en/pricing`)가 싣는 숫자. 진윤겸 확정(2026-09-26: Pro 29 · Team 99 ·
 * Scale 299). 카탈로그(`src/billing/plans.ts`)는 금액을 모르고, Paddle 가격 id(`src/billing/paddle/prices.ts`)가 실제 청구 금액을 정한다 —
 * Paddle 카탈로그의 금액을 바꾸면 이 값도 같은 커밋에서 바꾼다. 키 집합이 `PAID_PLAN_CODES` 와 같은지는 `pricing.test.ts` 가 본다.
 */
export const PLAN_MONTHLY_PRICE_USD: Readonly<Record<PaidPlanCode, number>> = { pro: 29, team: 99, scale: 299 };

/**
 * 사용자 문서(`https://docs.atmark.ai`, 별도 λ·스택 — `src/docs/**`). 머리 주 메뉴·꼬리·llms.txt 가 가리킨다. 한국어는 `/`, 영어는 `/en`(홈과 같은 규칙).
 * 정본은 `src/docs/constants.ts` `DOCS_ORIGIN` — 홈 번들은 `src/docs/**` 를 import 하지 않으므로 옮겨 적고 `test/unit/docs/docs-constants.test.ts` 가 같은지 본다.
 */
export const DOCS_ORIGIN = 'https://docs.atmark.ai';

export function docsUrl(lang: SiteLang): string {
  return `${DOCS_ORIGIN}${lang === 'en' ? '/en' : ''}`;
}

/** 문의 주소(US-009 — 운영자에게 전달된다). `null` 이면 푸터에 "문의" 가 없고, 약관·안내의 문의처는 "공개 전에 안내" 문구가 된다. */
export const CONTACT_EMAIL: string | null = 'support@atmark.ai';

/**
 * 개인정보 처리 안내·환불 정책의 시행일(ISO). **법률 검토 전 초안의 작성일이다** — 공개 전에 실제 시행일로 바꾼다
 * (`docs/runbooks/site.md`). 표시는 `effectiveDateText` 가 언어별로 만든다.
 */
const POLICY_EFFECTIVE_DATE = '2026-09-24';

/**
 * 개인정보 처리 안내의 시행일(ISO) — 2026-09-30 대기자 명단 항목(이메일 · 한 줄 메모 · 보관 기간)을 더하면서 환불 정책과 갈라졌다. 2026-10-01: 대기자
 * 신청서 세 칸(이용 목적 · 알게 된 곳 · 유입 경로 값)과 조직 행 복사, 투명성 로그 잠금 문장.
 */
export const PRIVACY_EFFECTIVE_DATE = '2026-10-01';

/**
 * 이용약관의 시행일(ISO) — 진윤겸이 승인한 개정의 날짜다(2026-09-26 요금제와 결제 조 · 운영자 표기 → 2026-09-30 '가입과 대기자 명단' 조 ·
 * 베타 요금제는 운영자가 정한 조직 → 2026-10-01 대기자 명단 조: 초대를 약속하지 않는다 · 이용 목적을 보고 조금씩 초대). 이 개정은 새 가입에만 걸리고 이용자에게 불리하지 않다(초대받은 조직은 검토 없이 바로 Free). 약관만 개정했으므로 개인정보 처리
 * 안내·환불 정책의 시행일(`POLICY_EFFECTIVE_DATE`)과 따로 둔다. 표시는 `effectiveDateText(lang, TERMS_EFFECTIVE_DATE)`.
 */
export const TERMS_EFFECTIVE_DATE = '2026-10-01';

/**
 * 사이트 문서의 마지막 내용 변경일(ISO) — `sitemap.xml` 의 `<lastmod>`. **배포 시각이 아니라 내용의 날짜**다(배포마다 흔들리면 크롤러가
 * 믿지 않는다). 홈·가격·약관·개인정보·환불 문구를 고치는 커밋에서 같이 올린다.
 */
export const SITE_CONTENT_DATE = '2026-10-01';

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function effectiveDateText(lang: SiteLang, isoDate: string = POLICY_EFFECTIVE_DATE): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return lang === 'ko' ? `${String(y)}년 ${String(m)}월 ${String(d)}일` : `${EN_MONTHS[m - 1] ?? ''} ${String(d)}, ${String(y)}`;
}
