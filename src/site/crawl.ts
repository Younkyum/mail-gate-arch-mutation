/**
 * src/site/crawl.ts — 크롤러용 텍스트 셋: `/robots.txt` · `/sitemap.xml` · `/llms.txt`(`.omc/research/seo-aeo-checklist.md` §1.4·§1.5·§4.1).
 * 모듈 로드 때 한 번 만든다(요청마다 달라지는 값 없음).
 *
 *   - robots.txt — 전부 허용. AI 크롤러(학습·검색·사용자 요청 대리)도 이름을 불러 허용한다(신규 서비스는 답변 엔진 노출이 이득 — 리드 판정).
 *     `/login`·`/signup` 을 **막지 않는다**: 막으면 크롤러가 페이지의 `noindex` 를 못 읽어 URL 만 색인될 수 있다. 계정 화면은
 *     페이지의 `<meta name="robots" content="noindex,follow">` 로 뺀다(`page.ts` `NOINDEX_IDS`). 끝에 사이트맵 한 줄.
 *   - sitemap.xml — 색인하는 페이지만(두 언어 각각 한 `<url>`). 각 항목에 hreflang 묶음(ko·en·x-default=en — HTML 의 대안 링크와 같다)과
 *     `lastmod`(= `SITE_CONTENT_DATE`, 내용 날짜 — 배포 시각이 아니다).
 *   - llms.txt — 짧게: 한 문장 메시지(마케팅 계획 2026-09-30 §2.3, 두 언어) + 제품 한 단락(홈 FAQ 첫 답과 같은 정의문, 두 언어) + 주요 페이지 링크
 *     (홈 문서 · 변경 내역 · 남용 신고 · 문서 Quickstart · "Atmark로 하면 안 되는 일" — 계획 §5.1). 공식 표준은 아니고 코딩 에이전트가 읽는 관행이다.
 */

import { BLOG_SITE, sitemapUrl } from './blog';
import { CONTACT_EMAIL, docsUrl, REFUND_POLICY_APPROVED, SITE_CONTENT_DATE, SITE_LANGS, SITE_ORIGIN, type SiteLang } from './constants';
import { homeFaq } from './home';
import { isIndexed, sitePath, type SiteDocumentId } from './page';

/** 사이트맵·llms.txt 에 싣는 문서 — 색인 대상(계정 화면 제외), 환불은 공개됐을 때만. 순서는 사람이 읽기 좋은 순. */
export const INDEXED_DOCUMENTS: readonly SiteDocumentId[] = (['home', 'use-cases', 'pricing', 'changelog', 'terms', 'privacy', 'refund', 'abuse'] as const).filter(
  (id) => isIndexed(id) && (id !== 'refund' || REFUND_POLICY_APPROVED),
);

/** 이름을 불러 허용하는 AI 크롤러(학습 · 검색 색인 · 사용자 요청 대리). `*` 가 이미 허용하지만 운영자 의도를 적어 둔다. */
export const AI_CRAWLERS: readonly string[] = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
];

const absolute = (lang: SiteLang, id: SiteDocumentId): string => `${SITE_ORIGIN}${sitePath(lang, id)}`;

export const ROBOTS_TXT =
  '# Atmark (https://atmark.ai). Everything here is open to crawlers, including AI crawlers.\n' +
  '# Account pages (/login, /signup) are not blocked: they carry <meta name="robots" content="noindex,follow">.\n' +
  '\n' +
  'User-agent: *\nAllow: /\n' +
  AI_CRAWLERS.map((bot) => `\nUser-agent: ${bot}\nAllow: /\n`).join('') +
  `\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`;

export const SITEMAP_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
  INDEXED_DOCUMENTS.flatMap((id) =>
    SITE_LANGS.map((lang) => sitemapUrl(sitePath(lang, id), SITE_CONTENT_DATE, { en: sitePath('en', id), ko: sitePath('ko', id) })),
  ).join('') +
  // 블로그 — 공개 글이 있을 때만: 목록과 글, lastmod 는 글의 수정일(없으면 게시일). 두 언어가 다 있는 것만 hreflang 묶음.
  BLOG_SITE.sitemap +
  '</urlset>\n';

/** llms.txt 링크 이름과 한 줄 설명(두 언어). */
const LLMS_LINKS: Readonly<Record<SiteLang, Readonly<Record<SiteDocumentId, readonly [string, string]>>>> = {
  en: {
    home: ['Home', 'Its own email address for every agent, a signed identity, a tamper-evident log of its mail decisions and one console.'],
    'use-cases': ['Use cases', 'Six ways to use an agent address: a daily newsletter, newsletter digests, a support inbox, service alerts, receipts and invoices, and tool sign-ups.'],
    pricing: ['Pricing', 'Monthly prices and the limits of each plan.'],
    terms: ['Terms of Service', 'Sign-up and the waitlist, the beta service, owner responsibilities and prohibited use.'],
    privacy: ['Privacy Notice', 'What personal information Atmark processes and why.'],
    refund: ['Refund Policy', 'Payment, cancellation and refunds for paid plans.'],
    changelog: ['Changelog', 'What has shipped to Atmark, one dated line per change, newest first.'],
    abuse: ['Report abuse', 'Unwanted mail from an @atmark.ai address: send it to abuse@atmark.ai with the original headers. Every report is reviewed within 24 hours.'],
    login: ['Log in', ''],
    signup: ['Sign up', ''],
    waitlist: ['Join the waitlist', ''],
  },
  ko: {
    home: ['홈', '에이전트 전용 이메일 주소, 서명된 신원, 변조 흔적이 남는 메일 판정 기록, 콘솔 하나.'],
    'use-cases': ['사용 예시', '에이전트 주소로 하는 여섯 가지 일: 나만의 뉴스레터, 뉴스레터 요약, 지원 메일함, 서비스 알림, 영수증·청구서 정리, 도구 가입.'],
    pricing: ['요금제', '요금제별 월 가격과 한도.'],
    terms: ['이용약관', '가입과 대기자 명단, 베타 서비스, 소유자의 책임, 금지 행위.'],
    privacy: ['개인정보 처리 안내', 'Atmark가 처리하는 개인정보와 그 목적.'],
    refund: ['환불 정책', '유료 요금제의 결제·해지·환불.'],
    changelog: ['변경 내역', 'Atmark에 배포한 변경을 날짜와 한 줄로, 최신이 위.'],
    abuse: ['남용 신고', '@atmark.ai 주소에서 온 원치 않는 메일은 원본 헤더와 함께 abuse@atmark.ai로. 모든 신고를 24시간 안에 검토합니다.'],
    login: ['로그인', ''],
    signup: ['가입', ''],
    waitlist: ['대기자 명단', ''],
  },
};

const firstAnswer = (lang: SiteLang): string => homeFaq(lang)[0]?.answer ?? '';

/** 한 문장 메시지(마케팅 계획 2026-09-30 §2.3) — llms.txt 맨 위. */
const LLMS_MESSAGE: Readonly<Record<SiteLang, string>> = {
  en: 'Give your agent its own email address — not your Gmail.',
  ko: '에이전트에게 당신의 Gmail 말고, 자기 이름의 메일 주소를.',
};

/** 문서에서 llms.txt 에 따로 올리는 페이지 — 이름과 한 줄 설명(두 언어). 경로는 문서 사이트의 페이지 id. */
const LLMS_DOCS_PAGES: Readonly<Record<SiteLang, readonly (readonly [string, string, string])[]>> = {
  en: [
    ['get-started/quickstart', 'Quickstart', 'Create an agent, email it from your inbox, allow your address so it can reply, then route one real alert to it.'],
    ['get-started/not-for', 'What Atmark is not for', 'Cold outreach, bulk or marketing mail, mail people do not expect, and mass sign-ups or code harvesting. Every agent shares one domain.'],
    ['api/discovery', 'Discovery for agents', 'Read https://api.atmark.ai/.well-known/atmark.json and the OpenAPI document to set yourself up. MCP agents call get_capabilities first.'],
  ],
  ko: [
    ['get-started/quickstart', '빠른 시작', '에이전트를 만들고, 내 메일함에서 보낸 메일을 읽히고, 내 주소를 허용해 답장을 받은 뒤, 실제 알림 하나를 에이전트 주소로 돌립니다.'],
    ['get-started/not-for', 'Atmark로 하면 안 되는 일', '콜드 아웃리치, 대량·마케팅 발송, 받는 사람이 기대하지 않은 메일, 대량 계정 생성과 인증 코드 수집. 모든 에이전트가 한 도메인을 함께 씁니다.'],
    ['api/discovery', '에이전트용 발견 문서', 'https://api.atmark.ai/.well-known/atmark.json 과 OpenAPI 문서를 읽고 스스로 설정합니다. MCP 에이전트는 get_capabilities 를 먼저 부릅니다.'],
  ],
};

export const LLMS_TXT =
  '# Atmark\n\n' +
  `> ${LLMS_MESSAGE.en}\n\n` +
  `> ${LLMS_MESSAGE.ko}\n\n` +
  `> ${firstAnswer('en')}\n\n` +
  `> ${firstAnswer('ko')}\n\n` +
  `Atmark is in beta and is operated by SHAKA.${CONTACT_EMAIL === null ? '' : ` Contact: ${CONTACT_EMAIL}`}\n\n` +
  (['en', 'ko'] as const)
    .map(
      (lang) =>
        `## ${lang === 'en' ? 'English' : '한국어'}\n\n` +
        INDEXED_DOCUMENTS.map((id) => {
          const [name, note] = LLMS_LINKS[lang][id];
          return `- [${name}](${absolute(lang, id)}): ${note}\n`;
        }).join('') +
        LLMS_DOCS_PAGES[lang].map(([id, name, note]) => `- [${name}](${docsUrl(lang)}/${id}): ${note}\n`).join('') +
        (lang === 'en'
          ? `- [Docs](${docsUrl(lang)}): User documentation, with a Markdown version of every page (${docsUrl('ko')}/llms.txt).\n`
          : `- [문서](${docsUrl(lang)}): 사용자 문서. 모든 페이지에 Markdown 판이 있습니다(${docsUrl('ko')}/llms.txt).\n`) +
        BLOG_SITE.llms[lang],
    )
    .join('\n');
