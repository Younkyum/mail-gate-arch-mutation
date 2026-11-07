/**
 * src/site/seo.ts — 검색·답변 엔진·링크 미리보기용 머리 조각(`.omc/research/seo-aeo-checklist.md` §2–§3). 값만 받아 문자열을 만든다 —
 * 페이지 모듈을 import 하지 않는다(`page.ts` 가 이 파일을 부른다, 순환 없음).
 *
 *   - Open Graph · Twitter 카드 — 언어별 제목·설명·정본 URL·로캘·이미지(`/og/<lang>.png`, 1200×630 — `scripts/gen-images.ts`).
 *     소셜 크롤러는 브라우저가 아니라 페이지 CSP(`img-src 'self'`)와 무관하다 — 절대 URL 만 있으면 된다.
 *   - JSON-LD(`<script type="application/ld+json">`) — **데이터 블록**이다(HTML 은 JavaScript MIME 이 아닌 `<script>` 를 실행하지 않는다) →
 *     CSP 에 `script-src` 를 더하지 않는다. 페이지마다 **정확히 하나**(`@graph`)만 싣고, 테스트가 그 하나만 예외로 둔다(`site-pages` ③).
 *     본문에 보이는 것만 적는다(Google 구조화 데이터 지침): 조직(이름·운영 주체·URL·로고·문의) · 홈의 WebSite · 홈 FAQ(본문 `<details>` 와 1:1)
 *     · 가격 페이지의 SoftwareApplication + Offer(가격 표와 같은 상수).
 *   - `<` 는 `<` 로 적는다 — 문자열 안의 `</script>` 가 블록을 닫지 못하게.
 */

import { CONTACT_EMAIL, OTHER_LANG, SITE_ORIGIN, type SiteLang } from './constants';
import { OG_IMAGES } from './image-data';
import { ogHashedPath } from './images';

/** 구조화 데이터 노드 한 개(`@graph` 의 원소). 값은 코드 상수뿐이다. */
export type LdNode = Readonly<Record<string, unknown>>;

const OG_LOCALE: Readonly<Record<SiteLang, string>> = { ko: 'ko_KR', en: 'en_US' };

/** 조직 노드의 `@id` — 다른 노드가 `publisher` 로 가리킨다. */
export const ORG_ID = `${SITE_ORIGIN}/#organization`;
const WEBSITE_ID = `${SITE_ORIGIN}/#website`;

/** OG 이미지의 절대 URL — 내용 해시가 든 `/og/<해시>/<lang>.png`(그림이 바뀌면 링크 미리보기도 새로 받는다). */
export function ogImageUrl(lang: SiteLang): string {
  return `${SITE_ORIGIN}${ogHashedPath(lang)}`;
}

export interface SocialParts {
  readonly lang: SiteLang;
  readonly title: string;
  readonly description: string;
  /** 정본 URL(= `<link rel="canonical">`). */
  readonly url: string;
  readonly imageAlt: string;
  /** 기본 `website`. 블로그 글은 `article`(+ `article`). */
  readonly type?: 'website' | 'article';
  /** 기본은 사이트 공통 OG(`/og/<해시>/<lang>.png`). 블로그 글은 글마다 그린 카드(`/og/blog/<해시>/<slug>-<lang>.png`). */
  readonly image?: { readonly url: string; readonly contentType: string; readonly width: number; readonly height: number };
  /** 반대 언어 판이 있는가(`og:locale:alternate`) — 기본 있음. 영어만 있는 블로그 글은 없음. */
  readonly alternateLocale?: boolean;
  /** `og:type=article` 의 날짜·태그(Open Graph article 속성). */
  readonly article?: { readonly published: string; readonly modified: string; readonly tags: readonly string[] };
}

/** Open Graph + Twitter 카드. 값은 이미 HTML 속성에 넣을 수 있는 정적 문자열이다(페이지 제목·설명과 같은 원천). */
export function socialMeta(p: SocialParts): string {
  const og = OG_IMAGES[p.lang];
  const image = p.image ?? { url: ogImageUrl(p.lang), contentType: og.contentType, width: og.width, height: og.height };
  const prop = (name: string, value: string): string => `<meta property="${name}" content="${value}">`;
  const tw = (name: string, value: string): string => `<meta name="${name}" content="${value}">`;
  return (
    prop('og:type', p.type ?? 'website') +
    prop('og:site_name', 'Atmark') +
    prop('og:title', p.title) +
    prop('og:description', p.description) +
    prop('og:url', p.url) +
    prop('og:locale', OG_LOCALE[p.lang]) +
    (p.alternateLocale === false ? '' : prop('og:locale:alternate', OG_LOCALE[OTHER_LANG[p.lang]])) +
    prop('og:image', image.url) +
    prop('og:image:type', image.contentType) +
    prop('og:image:width', String(image.width)) +
    prop('og:image:height', String(image.height)) +
    prop('og:image:alt', p.imageAlt) +
    (p.article === undefined
      ? ''
      : prop('article:published_time', p.article.published) +
        prop('article:modified_time', p.article.modified) +
        p.article.tags.map((t) => prop('article:tag', t)).join('')) +
    tw('twitter:card', 'summary_large_image') +
    tw('twitter:title', p.title) +
    tw('twitter:description', p.description) +
    tw('twitter:image', image.url) +
    tw('twitter:image:alt', p.imageAlt)
  );
}

/**
 * 운영 주체 — 약관 제1조와 같은 사실(꼬리·홈 FAQ 에는 적지 않는다 — 진윤겸 2026-09-30). 로고는 파비콘의 고정 경로(`/favicon.svg`, 벡터 — 어떤
 * 크기로도 그려진다 · 해시 경로와 같은 지금 그림을 낸다).
 */
export function organizationNode(): LdNode {
  return {
    '@type': 'Organization',
    '@id': ORG_ID,
    name: 'Atmark',
    legalName: 'SHAKA',
    url: `${SITE_ORIGIN}/`,
    logo: `${SITE_ORIGIN}/favicon.svg`,
    ...(CONTACT_EMAIL === null ? {} : { email: CONTACT_EMAIL }),
  };
}

export function websiteNode(lang: SiteLang): LdNode {
  return { '@type': 'WebSite', '@id': WEBSITE_ID, name: 'Atmark', url: `${SITE_ORIGIN}/`, inLanguage: lang, publisher: { '@id': ORG_ID } };
}

export interface FaqEntry {
  /** 질문 — 평문. */
  readonly question: string;
  /** 답 — 평문(본문 `<details>` 의 글자와 같다). */
  readonly answer: string;
}

export function faqNode(lang: SiteLang, entries: readonly FaqEntry[]): LdNode {
  return {
    '@type': 'FAQPage',
    inLanguage: lang,
    mainEntity: entries.map((e) => ({ '@type': 'Question', name: e.question, acceptedAnswer: { '@type': 'Answer', text: e.answer } })),
  };
}

export interface OfferEntry {
  readonly name: string;
  /** USD, 월. 문자열 숫자(`"29"`). */
  readonly price: string;
}

export function softwareNode(lang: SiteLang, url: string, offers: readonly OfferEntry[]): LdNode {
  return {
    '@type': 'SoftwareApplication',
    name: 'Atmark',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    inLanguage: lang,
    url,
    publisher: { '@id': ORG_ID },
    offers: offers.map((o) => ({ '@type': 'Offer', name: o.name, price: o.price, priceCurrency: 'USD' })),
  };
}

/** 노드들을 `@graph` 하나로 — `<script type="application/ld+json">` 블록 하나. */
export function ldJson(nodes: readonly LdNode[]): string {
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes }).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

/** 이 사이트의 문구 조각에 쓰이는 이름 엔티티 — 구조화 데이터·llms.txt 에는 풀린 글자를 적는다. */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  nbsp: ' ',
  middot: '·',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rarr: '→',
};

/** 정적 마크업 조각 → 평문(태그를 벗기고 엔티티를 푼다, 공백 하나로). 모르는 엔티티가 있으면 던진다(조용히 `&x;` 를 싣지 않게). */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&([a-z]+);/g, (whole, name: string) => {
      const ch = ENTITIES[name];
      if (ch === undefined) throw new Error(`plainText: 모르는 엔티티 ${whole}`);
      return ch;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
