/**
 * src/site/blog-nav.ts — 블로그 경로와 "블로그가 있는가"(머리·꼬리 링크 · 엣지 언어 협상). 생성 값 파일(`blog-data.ts`)과 상수만 읽는다 —
 * 페이지 모듈을 import 하지 않는다(`page.ts` 가 이 파일을 부른다, 순환 없음 · 엣지 함수 소스 `edge-lang.ts` 도 이 파일만 부른다).
 *
 * 규칙(2026-10-01):
 *   - 경로: 영어 `/blog` · `/blog/<slug>` · `/blog/rss.xml`, 한국어 `/kr/blog` · `/kr/blog/<slug>` · `/kr/blog/rss.xml`.
 *   - **공개 글이 하나도 없으면** 블로그는 없다 — `/blog` 404 · 머리·꼬리 링크 없음 · 사이트맵·RSS·llms.txt 없음. 글이 공개되면 저절로 생긴다.
 *   - 한국어 목록(`/kr/blog`)은 공개된 한국어 글이 있을 때만 있다. 없으면 한국어 페이지의 "블로그" 링크는 영어 목록을 가리킨다(`hreflang="en"`).
 *   - 엣지 언어 협상(`edge-lang.ts`)은 **두 언어가 다 있는 블로그 경로만** 옮긴다(영어만 있는 글을 `/kr/…` 404 로 보내지 않게).
 */

import { BLOG_POSTS, type BlogPostRecord } from './blog-data';
import { langPrefix, type SiteLang } from './constants';

export function blogIndexPath(lang: SiteLang): string {
  return `${langPrefix(lang)}/blog`;
}

export function blogPostPath(lang: SiteLang, slug: string): string {
  return `${blogIndexPath(lang)}/${slug}`;
}

export function blogFeedPath(lang: SiteLang): string {
  return `${blogIndexPath(lang)}/rss.xml`;
}

/** 실을 글 — 운영은 공개 글만(`drafts` 거짓). 로컬 미리보기만 초안을 싣는다. */
export function visiblePosts(posts: readonly BlogPostRecord[], drafts = false): readonly BlogPostRecord[] {
  return posts.filter((p) => drafts || !p.draft);
}

/** 운영에 실리는 글(공개 글). */
export const PUBLISHED_POSTS: readonly BlogPostRecord[] = visiblePosts(BLOG_POSTS);

/** 이 언어에 블로그 목록이 있는가(그 언어 글이 하나 이상). */
export function hasBlogIndex(posts: readonly BlogPostRecord[], lang: SiteLang): boolean {
  return posts.some((p) => p.lang === lang);
}

/** 머리·꼬리의 "블로그" 링크 — 없으면 `null`. 한국어 목록이 없으면 한국어 페이지는 영어 목록으로(`hreflang`). */
export interface BlogNavLink {
  readonly href: string;
  readonly hreflang: SiteLang | null;
}

export function blogNavLink(posts: readonly BlogPostRecord[], lang: SiteLang): BlogNavLink | null {
  if (hasBlogIndex(posts, lang)) return { href: blogIndexPath(lang), hreflang: null };
  if (hasBlogIndex(posts, 'en')) return { href: blogIndexPath('en'), hreflang: 'en' };
  return null;
}

/** 운영 머리·꼬리의 링크(언어별). */
export const BLOG_NAV: Readonly<Record<SiteLang, BlogNavLink | null>> = {
  en: blogNavLink(PUBLISHED_POSTS, 'en'),
  ko: blogNavLink(PUBLISHED_POSTS, 'ko'),
};

/** 엣지 언어 협상에 더하는 블로그의 영어 경로 — 한국어 짝이 있는 것만(목록 · 글). */
export function blogNegotiatedEnPaths(posts: readonly BlogPostRecord[]): string[] {
  const ko = posts.filter((p) => p.lang === 'ko');
  if (ko.length === 0) return [];
  return [blogIndexPath('en'), ...ko.map((p) => blogPostPath('en', p.slug))];
}
