/**
 * src/site/blog.ts — 블로그(`/blog` · `/kr/blog`)의 페이지·RSS·이미지·사이트맵 항목. 글은 생성 값 파일(`blog-data.ts`, `pnpm gen:blog`)에서
 * 오고, 이 모듈은 그 레코드로 **모듈 로드 때 한 번** 페이지를 만든다(요청마다 달라지는 값 없음). 경로 규칙과 "블로그가 있는가"는 `blog-nav.ts`.
 *
 *   - 공개 글이 없으면 아무것도 만들지 않는다 — `/blog` 는 404(라우트가 없다), RSS·사이트맵·llms.txt 항목도 없다.
 *   - 초안(`draft: true`)은 운영 값 파일에 아예 없다. 로컬 미리보기만 원문에서 초안을 포함한 레코드를 만들어 `buildBlogSite(…, {drafts:true})` 로 넘긴다
 *     (`scripts/ui/preview.ts`). 이 함수도 `drafts` 가 거짓이면 레코드의 초안을 한 번 더 걸러 낸다.
 *   - 목록(`/blog`): 최신 글 순. 맨 위 글은 머리기사(표지 그림이 있으면 회색 판 위에), 나머지는 날짜 칸 + 제목·설명·태그.
 *   - 글(`/blog/<slug>`): 제목 · 요약 · 글쓴이 · 날짜 · 읽는 시간 · 태그 → 본문(최대 68ch) → 이전·다음 글 → 대기자 명단 CTA 하나.
 *     본문 그림은 인라인 SVG(생성 때 검사), 스크린샷은 같은 출처 WebP(`/img/<해시>/blog-…`, 밝은·어두운 두 벌 — `<picture>` 가 화면 설정에 맞는
 *     한 장만 받는다 · 크기 명시로 CLS 없음 · `loading="lazy"`).
 *   - SEO: canonical · (두 언어가 다 있을 때) hreflang ko·en·x-default · OG(`article`, 글마다 그린 카드 — 없거나 제목이 낡았으면 사이트 공통 OG) ·
 *     JSON-LD(`BlogPosting` · 목록은 `Blog`) · RSS 2.0(`/blog/rss.xml` · 한국어 글이 있으면 `/kr/blog/rss.xml`) + `<link rel="alternate">`.
 */

import { BLOG_POSTS, type BlogPostRecord } from './blog-data';
import { blogFeedPath, blogIndexPath, blogNavLink, blogNegotiatedEnPaths, blogPostPath, hasBlogIndex, visiblePosts } from './blog-nav';
import { BLOG_OG_IMAGES, type BlogOgImage } from './blog-og-data';
import { BLOG_SHOT_IMAGES, BLOG_SHOT_SCALE, type BlogShotSet } from './blog-shot-data';
import { effectiveDateText, OTHER_LANG, SITE_LANG_QUERY, SITE_LANGS, SITE_ORIGIN, type SiteLang } from './constants';
import { ARROW_RIGHT_ICON, buildSitePage, esc, sitePath, type PageRoute, type SitePage } from './page';
import { ORG_ID, type LdNode } from './seo';

/** 블로그가 내는 이미지 한 장(스크린샷 WebP · OG PNG). */
export interface BlogImage {
  readonly contentType: string;
  readonly base64: string;
}

export interface BlogSite {
  /** 실린 글(운영은 공개 글만) — 날짜 내림차순. */
  readonly posts: readonly BlogPostRecord[];
  /** 경로 → 페이지(목록 · 글, 두 언어). */
  readonly routes: ReadonlyMap<string, SitePage>;
  /** 경로 → RSS 본문. */
  readonly feeds: ReadonlyMap<string, string>;
  /** 경로 → 이미지(글이 싣는 스크린샷 · 글의 OG 카드). */
  readonly images: ReadonlyMap<string, BlogImage>;
  /** 사이트맵의 `<url>` 항목들(없으면 빈 문자열). */
  readonly sitemap: string;
  /** llms.txt 에 더할 줄(언어별, 없으면 빈 문자열). */
  readonly llms: Readonly<Record<SiteLang, string>>;
  /** 엣지 언어 협상에 더하는 영어 경로(한국어 짝이 있는 것만). */
  readonly negotiatedEnPaths: readonly string[];
}

export interface BlogSiteOptions {
  /** 초안까지 싣는가 — 로컬 미리보기만. */
  readonly drafts?: boolean;
  readonly shots?: Readonly<Record<string, BlogShotSet>>;
  readonly og?: Readonly<Record<string, BlogOgImage>>;
}

/** 블로그의 언어별 문구. 키 집합이 같다(테스트). */
export const BLOG_COPY: Readonly<Record<SiteLang, Readonly<Record<string, string>>>> = {
  en: {
    indexTitle: 'Blog | Atmark',
    indexDescription: 'Engineering notes from Atmark on giving AI agents an identity and an email address of their own, and what we learn building it.',
    h1: 'Blog',
    lede: 'Engineering notes on giving AI agents an identity and an email address of their own.',
    feed: 'RSS feed',
    feedTitle: 'Atmark Blog',
    by: 'By',
    minutes: '{n} min read',
    updated: 'Updated',
    tags: 'Tags',
    draft: 'Draft',
    more: 'More from the blog',
    older: 'Previous post',
    newer: 'Next post',
    ctaTitle: 'Create your first agent email.',
    waitlist: 'Join the waitlist',
    pending: 'Screenshot not captured yet',
    ogAlt: 'Atmark Blog: {title}',
  },
  ko: {
    indexTitle: '블로그 | Atmark',
    indexDescription: 'AI 에이전트에게 자기 신원과 메일 주소를 주는 일에 관한 Atmark 엔지니어링 노트. 만들면서 배운 것을 적습니다.',
    h1: '블로그',
    lede: 'AI 에이전트에게 자기 신원과 메일 주소를 주는 일에 관한 엔지니어링 노트.',
    feed: 'RSS 피드',
    feedTitle: 'Atmark 블로그',
    by: '글',
    minutes: '읽는 시간 {n}분',
    updated: '수정',
    tags: '태그',
    draft: '초안',
    more: '블로그의 다른 글',
    older: '이전 글',
    newer: '다음 글',
    ctaTitle: '첫 에이전트 이메일을 만들어 보세요.',
    waitlist: '대기자 명단',
    pending: '스크린샷을 아직 찍지 않았습니다',
    ogAlt: 'Atmark 블로그: {title}',
  },
};

function xmlEsc(text: string): string {
  return esc(text).replace(/'/g, '&apos;');
}

const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');

/** 수정일(없으면 게시일). */
const modified = (p: BlogPostRecord): string => p.updated ?? p.date;

/** RSS 날짜(RFC 822) — 날짜만 있으므로 그날 00:00 UTC. */
function rfc822(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toUTCString();
}

/** 글의 OG 카드 — 있고 제목이 지금과 같을 때만(아니면 사이트 공통 OG). */
function ogFor(p: BlogPostRecord, og: Readonly<Record<string, BlogOgImage>>): BlogOgImage | undefined {
  if (p.draft) return undefined;
  const img = og[`${p.slug}/${p.lang}`];
  return img !== undefined && img.title === p.title ? img : undefined;
}

/** 스크린샷 자리(`<!--shot:<id>:<base64url 대체 글>-->`) → `<picture>`(어두운 화면은 어두운 벌). 바이트가 아직 없으면 회색 자리(미리보기에서만 보인다 — 공개 글은 테스트가 막는다). */
function fillShots(body: string, lang: SiteLang, shots: Readonly<Record<string, BlogShotSet>>, pending: string): string {
  return body.replace(/<!--shot:([a-z0-9-]+):([A-Za-z0-9_-]*)-->/g, (_, id: string, altB64: string) => {
    const alt = esc(Buffer.from(altB64, 'base64url').toString('utf8'));
    const set = shots[id]?.[lang];
    if (set === undefined) return `<div class="shot-pending" role="img" aria-label="${alt}"><span>${esc(pending)} · ${id}</span></div>`;
    const css = (px: number): string => String(Math.round(px / BLOG_SHOT_SCALE));
    return (
      '<picture>' +
      `<source media="(prefers-color-scheme: dark)" srcset="${set.dark.path}" width="${css(set.dark.width)}" height="${css(set.dark.height)}">` +
      `<img src="${set.light.path}" width="${css(set.light.width)}" height="${css(set.light.height)}" alt="${alt}" loading="lazy" decoding="async">` +
      '</picture>'
    );
  });
}

function tagList(p: BlogPostRecord, lang: SiteLang): string {
  if (p.tags.length === 0) return '';
  return `<ul class="tags" aria-label="${BLOG_COPY[lang]['tags'] ?? ''}">${p.tags.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
}

function dateTag(iso: string, lang: SiteLang): string {
  return `<time datetime="${iso}">${effectiveDateText(lang, iso)}</time>`;
}

function minutesText(p: BlogPostRecord, lang: SiteLang): string {
  return (BLOG_COPY[lang]['minutes'] ?? '').replace('{n}', String(p.minutes));
}

function draftBadge(p: BlogPostRecord, lang: SiteLang): string {
  return p.draft ? `<span class="badge">${BLOG_COPY[lang]['draft'] ?? ''}</span>` : '';
}

function cta(lang: SiteLang): string {
  const c = BLOG_COPY[lang];
  return (
    '<section class="cta blog-cta" aria-labelledby="start-title"><div class="cta-card">' +
    `<h2 id="start-title">${c['ctaTitle'] ?? ''}</h2>` +
    `<div class="actions center"><a class="btn" href="${sitePath(lang, 'waitlist')}">${c['waitlist'] ?? ''} ${ARROW_RIGHT_ICON}</a></div>` +
    '</div></section>'
  );
}

function feedLink(lang: SiteLang): string {
  return `<link rel="alternate" type="application/rss+xml" title="${BLOG_COPY[lang]['feedTitle'] ?? ''}" href="${SITE_ORIGIN}${blogFeedPath(lang)}">`;
}

function personNode(name: string): LdNode {
  return { '@type': 'Person', name };
}

// ── 목록 ─────────────────────────────────────────────────────────────────

function indexPage(lang: SiteLang, posts: readonly BlogPostRecord[], all: readonly BlogPostRecord[]): SitePage {
  const c = BLOG_COPY[lang];
  const other = OTHER_LANG[lang];
  const otherHas = hasBlogIndex(all, other);
  const self = blogIndexPath(lang);
  const route: PageRoute = {
    self,
    alternates: otherHas ? { [lang]: self, [other]: blogIndexPath(other) } : { [lang]: self },
    switchHref: `${otherHas ? blogIndexPath(other) : sitePath(other, 'home')}?${SITE_LANG_QUERY}=${other}`,
    section: 'blog',
  };
  const card = (p: BlogPostRecord, lead: boolean): string => {
    const href = blogPostPath(lang, p.slug);
    const cover = lead && p.cover !== null ? `<div class="pcard-cover" aria-hidden="true">${decode(p.cover)}</div>` : '';
    return (
      `<li><article class="pcard${lead ? ' lead' : ''}${cover === '' ? '' : ' has-cover'}">` +
      `<p class="pcard-meta">${dateTag(p.date, lang)}<span>${minutesText(p, lang)}</span>${draftBadge(p, lang)}</p>` +
      '<div class="pcard-text">' +
      `<h2><a href="${href}">${esc(p.title)}</a></h2>` +
      `<p class="pcard-desc">${esc(p.description)}</p>` +
      tagList(p, lang) +
      '</div>' +
      cover +
      '</article></li>'
    );
  };
  const main =
    '<div class="wrap blog">' +
    '<header class="blog-head">' +
    `<h1>${c['h1'] ?? ''}</h1>` +
    `<p class="lede">${c['lede'] ?? ''}</p>` +
    `<p class="blog-feed"><a href="${blogFeedPath(lang)}" type="application/rss+xml">${c['feed'] ?? ''}</a></p>` +
    '</header>' +
    `<ol class="posts">${posts.map((p, i) => card(p, i === 0)).join('')}</ol>` +
    '</div>' +
    cta(lang);
  const url = `${SITE_ORIGIN}${self}`;
  return buildSitePage({
    lang,
    title: c['indexTitle'] ?? '',
    description: c['indexDescription'] ?? '',
    main,
    route,
    social: { alternateLocale: otherHas },
    head: feedLink(lang),
    blogNav: blogNavLink(all, lang),
    structured: [
      {
        '@type': 'Blog',
        '@id': `${url}#blog`,
        name: c['feedTitle'] ?? '',
        description: c['indexDescription'] ?? '',
        url,
        inLanguage: lang,
        publisher: { '@id': ORG_ID },
        blogPost: posts.map((p) => ({
          '@type': 'BlogPosting',
          headline: p.title,
          url: `${SITE_ORIGIN}${blogPostPath(lang, p.slug)}`,
          datePublished: p.date,
          dateModified: modified(p),
        })),
      },
    ],
  });
}

// ── 글 ──────────────────────────────────────────────────────────────────

interface PostEnv {
  readonly all: readonly BlogPostRecord[];
  readonly shots: Readonly<Record<string, BlogShotSet>>;
  readonly og: Readonly<Record<string, BlogOgImage>>;
}

function postPage(p: BlogPostRecord, sameLang: readonly BlogPostRecord[], env: PostEnv): SitePage {
  const lang = p.lang;
  const c = BLOG_COPY[lang];
  const other = OTHER_LANG[lang];
  const pair = env.all.find((x) => x.slug === p.slug && x.lang === other);
  const self = blogPostPath(lang, p.slug);
  const route: PageRoute = {
    self,
    alternates: pair === undefined ? { [lang]: self } : { [lang]: self, [other]: blogPostPath(other, p.slug) },
    switchHref: `${pair !== undefined ? blogPostPath(other, p.slug) : hasBlogIndex(env.all, other) ? blogIndexPath(other) : sitePath(other, 'home')}?${SITE_LANG_QUERY}=${other}`,
    section: 'blog',
  };
  const i = sameLang.indexOf(p);
  const older = sameLang[i + 1];
  const newer = i > 0 ? sameLang[i - 1] : undefined;
  const pn = (q: BlogPostRecord | undefined, key: 'older' | 'newer'): string =>
    q === undefined
      ? '<span class="pn-gap"></span>'
      : `<a class="pn-${key}" href="${blogPostPath(lang, q.slug)}" rel="${key === 'older' ? 'prev' : 'next'}"><span class="pn-k">${c[key] ?? ''}</span><span class="pn-t">${esc(q.title)}</span></a>`;
  const nav = older === undefined && newer === undefined ? '' : `<nav class="pn" aria-label="${c['more'] ?? ''}">${pn(older, 'older')}${pn(newer, 'newer')}</nav>`;
  const main =
    '<article class="post" aria-labelledby="post-title">' +
    '<header class="post-head">' +
    `<p class="crumb"><a href="${blogIndexPath(lang)}">${c['h1'] ?? ''}</a>${draftBadge(p, lang)}</p>` +
    `<h1 id="post-title">${esc(p.title)}</h1>` +
    `<p class="dek">${esc(p.description)}</p>` +
    '<p class="byline">' +
    `<span>${c['by'] ?? ''} ${esc(p.author)}</span>` +
    `<span>${dateTag(p.date, lang)}</span>` +
    (p.updated === null || p.updated === p.date ? '' : `<span>${c['updated'] ?? ''} ${dateTag(p.updated, lang)}</span>`) +
    `<span>${minutesText(p, lang)}</span>` +
    '</p>' +
    tagList(p, lang) +
    '</header>' +
    `<div class="prose">${fillShots(decode(p.body), lang, env.shots, c['pending'] ?? '')}</div>` +
    nav +
    '</article>' +
    cta(lang);
  const url = `${SITE_ORIGIN}${self}`;
  const og = ogFor(p, env.og);
  const imageUrl = og === undefined ? undefined : `${SITE_ORIGIN}${og.path}`;
  const imageAlt = (c['ogAlt'] ?? '').replace('{title}', esc(p.title));
  return buildSitePage({
    lang,
    title: `${esc(p.title)} | Atmark`,
    description: esc(p.description),
    main,
    route,
    social: {
      type: 'article',
      alternateLocale: pair !== undefined,
      article: { published: p.date, modified: modified(p), tags: p.tags.map(esc) },
      ...(og === undefined ? {} : { image: { url: imageUrl ?? '', contentType: og.contentType, width: og.width, height: og.height }, imageAlt }),
    },
    head: feedLink(lang),
    blogNav: blogNavLink(env.all, lang),
    structured: [
      {
        '@type': 'BlogPosting',
        '@id': `${url}#article`,
        headline: p.title,
        description: p.description,
        datePublished: p.date,
        dateModified: modified(p),
        inLanguage: lang,
        url,
        mainEntityOfPage: url,
        author: personNode(p.author),
        publisher: { '@id': ORG_ID },
        ...(imageUrl === undefined ? {} : { image: imageUrl }),
        ...(p.tags.length === 0 ? {} : { keywords: p.tags.join(', ') }),
      },
    ],
  });
}

// ── RSS · 사이트맵 · llms.txt ─────────────────────────────────────────────

function feedXml(lang: SiteLang, posts: readonly BlogPostRecord[]): string {
  const c = BLOG_COPY[lang];
  const index = `${SITE_ORIGIN}${blogIndexPath(lang)}`;
  const newest = posts.map(modified).sort().at(-1) ?? '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n' +
    '  <channel>\n' +
    `    <title>${xmlEsc(c['feedTitle'] ?? '')}</title>\n` +
    `    <link>${index}</link>\n` +
    `    <description>${xmlEsc(c['indexDescription'] ?? '')}</description>\n` +
    `    <language>${lang}</language>\n` +
    `    <lastBuildDate>${rfc822(newest)}</lastBuildDate>\n` +
    `    <atom:link href="${SITE_ORIGIN}${blogFeedPath(lang)}" rel="self" type="application/rss+xml"/>\n` +
    posts
      .map((p) => {
        const link = `${SITE_ORIGIN}${blogPostPath(lang, p.slug)}`;
        return (
          '    <item>\n' +
          `      <title>${xmlEsc(p.title)}</title>\n` +
          `      <link>${link}</link>\n` +
          `      <guid isPermaLink="true">${link}</guid>\n` +
          `      <pubDate>${rfc822(p.date)}</pubDate>\n` +
          `      <description>${xmlEsc(p.description)}</description>\n` +
          p.tags.map((t) => `      <category>${xmlEsc(t)}</category>\n`).join('') +
          '    </item>\n'
        );
      })
      .join('') +
    '  </channel>\n' +
    '</rss>\n'
  );
}

/** 사이트맵 `<url>` 한 항목(블로그 · `crawl.ts` 의 문서) — 짝이 있으면 hreflang ko·en·x-default=en 묶음. */
export function sitemapUrl(loc: string, lastmod: string, pair: { readonly en: string; readonly ko: string } | null): string {
  return (
    '  <url>\n' +
    `    <loc>${SITE_ORIGIN}${loc}</loc>\n` +
    `    <lastmod>${lastmod}</lastmod>\n` +
    (pair === null
      ? ''
      : `    <xhtml:link rel="alternate" hreflang="ko" href="${SITE_ORIGIN}${pair.ko}"/>\n` +
        `    <xhtml:link rel="alternate" hreflang="en" href="${SITE_ORIGIN}${pair.en}"/>\n` +
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${pair.en}"/>\n`) +
    '  </url>\n'
  );
}

// ── 조립 ─────────────────────────────────────────────────────────────────

export function buildBlogSite(records: readonly BlogPostRecord[], options: BlogSiteOptions = {}): BlogSite {
  const drafts = options.drafts === true;
  const shots = options.shots ?? BLOG_SHOT_IMAGES;
  const og = options.og ?? BLOG_OG_IMAGES;
  const posts = [...visiblePosts(records, drafts)].sort((a, b) => (a.date === b.date ? (a.slug < b.slug ? -1 : 1) : a.date < b.date ? 1 : -1));
  const routes = new Map<string, SitePage>();
  const feeds = new Map<string, string>();
  const images = new Map<string, BlogImage>();
  let sitemap = '';
  const llms: Record<SiteLang, string> = { en: '', ko: '' };
  const env: PostEnv = { all: posts, shots, og };
  for (const lang of SITE_LANGS) {
    const mine = posts.filter((p) => p.lang === lang);
    if (mine.length === 0) continue;
    routes.set(blogIndexPath(lang), indexPage(lang, mine, posts));
    for (const p of mine) routes.set(blogPostPath(lang, p.slug), postPage(p, mine, env));
    feeds.set(blogFeedPath(lang), feedXml(lang, mine));
  }
  // 사이트맵·llms.txt — 영어 먼저(목록 → 글), 그다음 한국어. 짝이 있으면 hreflang 묶음.
  for (const lang of ['en', 'ko'] as const) {
    const mine = posts.filter((p) => p.lang === lang);
    if (mine.length === 0) continue;
    const indexPair = hasBlogIndex(posts, 'en') && hasBlogIndex(posts, 'ko') ? { en: blogIndexPath('en'), ko: blogIndexPath('ko') } : null;
    sitemap += sitemapUrl(blogIndexPath(lang), mine.map(modified).sort().at(-1) ?? '', indexPair);
    for (const p of mine) {
      const pairExists = posts.some((x) => x.slug === p.slug && x.lang !== p.lang);
      sitemap += sitemapUrl(blogPostPath(lang, p.slug), modified(p), pairExists ? { en: blogPostPath('en', p.slug), ko: blogPostPath('ko', p.slug) } : null);
    }
    llms[lang] =
      `- [${BLOG_COPY[lang]['feedTitle'] ?? ''}](${SITE_ORIGIN}${blogIndexPath(lang)}): ${BLOG_COPY[lang]['lede'] ?? ''}\n` +
      mine.map((p) => `- [${p.title}](${SITE_ORIGIN}${blogPostPath(lang, p.slug)}): ${p.description}\n`).join('');
  }
  for (const p of posts) {
    for (const id of p.shots) {
      const set = shots[id]?.[p.lang];
      if (set === undefined) continue;
      for (const img of [set.light, set.dark]) images.set(img.path, { contentType: 'image/webp', base64: img.base64 });
    }
    const card = ogFor(p, og);
    if (card !== undefined) images.set(card.path, { contentType: card.contentType, base64: card.base64 });
  }
  return { posts, routes, feeds, images, sitemap, llms, negotiatedEnPaths: blogNegotiatedEnPaths(posts) };
}

/** 운영 블로그 — 공개 글만. */
export const BLOG_SITE: BlogSite = buildBlogSite(BLOG_POSTS);
