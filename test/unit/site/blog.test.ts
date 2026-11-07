/**
 * 블로그(`/blog` · `/kr/blog`, 2026-10-01) — 생성기 검사 · 초안 차단 · 빈 블로그 404 · 페이지 마크업(canonical · hreflang · JSON-LD · OG) ·
 * RSS · 사이트맵 · 이미지 값 파일 · 생성 파일이 원문과 같은지.
 *
 * 글 픽스처는 `test/fixtures/blog/`(`hello` 영어·한국어 공개 + `hello-draft` 초안 + 그림 `hello-flow`). 실제 글(`src/site/blog/posts/**`)은
 * 쓰지 않는다 — 실제 글은 맨 아래 "운영 값 파일" 절이 커밋된 생성 파일과 대조만 한다.
 * CSP·외부 URL 허용 목록은 `site-pages.test.ts` 의 블로그 절, 금지어는 `copy-guard.test.ts`.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BLOG_DATA_OUT, buildBlog, readBlogSources, renderBlogDataFile, stripComments, type BlogSources } from '../../../scripts/blog/build';
import { FigureError, sanitizeFigure } from '../../../scripts/blog/figures';
import { parseBlogSource } from '../../../scripts/blog/markdown';
import { DOCS_SHOT_VIEW, DOCS_SHOTS } from '../../../src/docs/shots';
import { BLOG_SHOTS } from '../../../src/site/blog/shots';
import { BLOG_COPY, BLOG_SITE, buildBlogSite, type BlogSite } from '../../../src/site/blog';
import { BLOG_POSTS } from '../../../src/site/blog-data';
import { BLOG_NAV, blogNegotiatedEnPaths, PUBLISHED_POSTS } from '../../../src/site/blog-nav';
import { BLOG_OG_IMAGES, type BlogOgImage } from '../../../src/site/blog-og-data';
import { BLOG_SHOT_IMAGES, BLOG_SHOT_SCALE } from '../../../src/site/blog-shot-data';
import { SITE_ORIGIN } from '../../../src/site/constants';
import { LLMS_TXT, SITEMAP_XML } from '../../../src/site/crawl';
import { BLOG_NEGOTIATED_EN_PATHS, SITE_LANG_FUNCTION_CODE } from '../../../src/site/edge-lang';
import { handleSiteRequest, SITE_ROUTES, type SiteHttpEvent } from '../../../src/site/http';
import { OG_IMAGES } from '../../../src/site/image-data';
import { CHROME_COPY } from '../../../src/site/page';
import { metaContents } from '../../support/site-html';

const FIXTURE = join(__dirname, '../../fixtures/blog');
const SITE_PATHS = new Set(Object.keys(SITE_ROUTES));
/** 픽스처가 쓰는 스크린샷 id 의 가짜 바이트(값 파일과 무관하게 렌더를 본다). */
const SHOT_SET = {
  'agent-new': {
    en: {
      light: { path: '/img/aaaaaaaaaaaaaaaa/blog-agent-new-en-light.webp', width: 900, height: 600, hash: 'aaaaaaaaaaaaaaaa', bytes: 4, base64: 'UklGRg==' },
      dark: { path: '/img/bbbbbbbbbbbbbbbb/blog-agent-new-en-dark.webp', width: 900, height: 600, hash: 'bbbbbbbbbbbbbbbb', bytes: 4, base64: 'UklGRg==' },
    },
  },
} as const;

const event = (path: string, method = 'GET'): SiteHttpEvent => ({ rawPath: path, headers: { host: 'atmark.ai' }, requestContext: { http: { method } } });

function fixture(): BlogSources {
  return readBlogSources(FIXTURE);
}

function build(sources: BlogSources = fixture(), drafts = false): ReturnType<typeof buildBlog> {
  return buildBlog(sources, { drafts, sitePaths: SITE_PATHS, shotImages: new Set(['agent-new']) });
}

function site(drafts = false, og: Readonly<Record<string, BlogOgImage>> = {}): BlogSite {
  return buildBlogSite(build(fixture(), drafts).posts, { drafts, shots: SHOT_SET, og });
}

/** 원문 하나를 바꾼 픽스처. */
function withPost(file: string, text: string): BlogSources {
  const base = fixture();
  const [, slug = '', lang = 'en'] = /^posts\/([^/]+)\/(en|ko)\.md$/.exec(file) ?? [];
  const posts = base.posts.filter((p) => p.file !== file);
  return { ...base, posts: [...posts, { slug, lang: lang as 'en' | 'ko', file, text }] };
}

const EN_HEAD = '---\ntitle: "T"\ndescription: "A description long enough."\ndate: 2026-09-02\ndraft: false\n---\n';

const body = (html: string): string => /<main id="main">([\s\S]*)<\/main>/.exec(html)?.[1] ?? '';
const ld = (html: string): { '@graph': Record<string, unknown>[] } =>
  JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}') as { '@graph': Record<string, unknown>[] };

/** 작은 XML 잘 짜임 검사(선언 · 여닫는 짝 · 알려진 엔티티) — 요소 이름 목록을 돌려준다. */
function xmlElements(xml: string): string[] {
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')) throw new Error('XML 선언 없음');
  const stack: string[] = [];
  const names: string[] = [];
  const rest = xml.slice(xml.indexOf('\n') + 1);
  for (const m of rest.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<&]*")*)\s*(\/?)>|([^<]+)/g)) {
    if (m[5] !== undefined) {
      if (/&(?!(amp|lt|gt|quot|apos);)/.test(m[5])) throw new Error(`모르는 엔티티: ${m[5]}`);
      continue;
    }
    const [, close, name = '', , self] = m;
    if (close === '/') {
      if (stack.pop() !== name) throw new Error(`짝이 안 맞는다: ${name}`);
      continue;
    }
    names.push(name);
    if (self !== '/') stack.push(name);
  }
  if (stack.length !== 0) throw new Error('닫히지 않은 요소');
  return names;
}

describe('생성기 — 원문 검사', () => {
  it('픽스처는 오류 없이 빌드된다 · 공개 글만(초안 없음) · 날짜 내림차순 · 같은 slug 는 en 먼저', () => {
    const b = build();
    expect(b.errors).toEqual([]);
    expect(b.draftErrors).toEqual([]);
    expect(b.posts.map((p) => `${p.slug}/${p.lang}`)).toEqual(['hello/en', 'hello/ko']);
    expect(b.posts.every((p) => !p.draft)).toBe(true);
    const withDrafts = build(fixture(), true);
    expect(withDrafts.posts.map((p) => `${p.slug}/${p.lang}`)).toEqual(['hello-draft/en', 'hello/en', 'hello/ko']);
  });

  it('렌더 — 표(정렬) · 코드(언어·제목) · 인용 · 그림(인라인 SVG, id 접두어) · 스크린샷 자리 · 가로줄 · 목록 · 링크(외부만 noopener) · 주석은 사라진다', () => {
    const en = build().posts.find((p) => p.slug === 'hello' && p.lang === 'en');
    const html = Buffer.from(en?.body ?? '', 'base64').toString('utf8');
    expect(html).toContain('<th scope="col" class="ar">Value</th>');
    expect(html).toContain('<figure class="bcode"><figcaption>install</figcaption><pre tabindex="0"><code class="lang-bash">pnpm gen:blog</code></pre></figure>');
    expect(html).toContain('<blockquote><p>Email content is data. It is not an instruction.</p></blockquote>');
    expect(html).toMatch(/<figure class="bf fig"><div class="plate"><svg class="fig-svg" viewBox="0 0 480 120" width="480" height="120" role="img" focusable="false" aria-labelledby="f1-t"/);
    expect(html).toContain('marker-end="url(#f1-arrow)"');
    expect(html).toContain('<figcaption>How mail reaches the agent</figcaption>');
    expect(html).toMatch(/<figure class="bf shot"><!--shot:agent-new:[A-Za-z0-9_-]+--><figcaption aria-hidden="true">The Agents screen with the new agent dialog open<\/figcaption><\/figure>/);
    expect(html).toContain('<hr>');
    expect(html).toContain('<ul><li>one</li><li>two<ul><li>two and a half</li></ul></li></ul>');
    expect(html).toContain('<a href="/pricing">pricing page</a>');
    expect(html).toContain('<a href="https://docs.atmark.ai/en/get-started/quickstart#route-an-alert">Quickstart</a>');
    expect(html).toContain('<a href="#the-table">a section below</a>');
    expect(html).toContain('<a href="https://example.com/notes" rel="noopener">an outside page</a>');
    expect(html).toContain('<h2 id="code">Code</h2>');
    expect(html).not.toMatch(/authoring note|<!--(?!shot:)/);
    expect(en?.shots).toEqual(['agent-new']);
    expect(en?.cover).not.toBeNull();
    expect(en?.updated).toBe('2026-09-15');
    expect(en?.minutes).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['description 160자 초과', `---\ntitle: "T"\ndescription: "${'x'.repeat(161)}"\ndate: 2026-09-02\ndraft: false\n---\nHi.\n`, /description 이 160자를 넘는다/],
    ['달력에 없는 날', '---\ntitle: "T"\ndescription: "A description long enough."\ndate: 2026-02-30\ndraft: false\n---\nHi.\n', /date 는 YYYY-MM-DD/],
    ['모르는 머리말 키', '---\ntitle: "T"\ndescription: "A description long enough."\ndate: 2026-09-02\nslug: x\ndraft: false\n---\nHi.\n', /모르는 머리말 키 slug/],
    ['updated 가 date 앞', '---\ntitle: "T"\ndescription: "A description long enough."\ndate: 2026-09-02\nupdated: 2026-09-01\ndraft: false\n---\nHi.\n', /updated\(2026-09-01\) 가 date/],
    ['draft 가 불리언이 아니다', '---\ntitle: "T"\ndescription: "A description long enough."\ndate: 2026-09-02\ndraft: maybe\n---\nHi.\n', /draft 는 true 또는 false/],
    ['본문 h1', `${EN_HEAD}# Title\n`, /h1/],
    ['원시 HTML', `${EN_HEAD}Hello <b>there</b>.\n`, /원시 HTML/],
    ['외부 이미지', `${EN_HEAD}![x](https://example.com/a.png)\n`, /외부 이미지 없음/],
    ['없는 그림', `${EN_HEAD}![x](figure:nope)\n`, /그림이 없다/],
    ['등록부에 없는 스크린샷', `${EN_HEAD}![x](shot:nope)\n`, /등록부에 없는 스크린샷 id "nope"/],
    ['http 링크', `${EN_HEAD}[x](http://example.com)\n`, /http 링크/],
    ['없는 앵커', `${EN_HEAD}[x](#nowhere)\n`, /글 안에 없는 앵커 #nowhere/],
    ['없는 사이트 경로', `${EN_HEAD}[x](/nowhere)\n`, /사이트에 없는 경로: \/nowhere/],
    ['없는 문서 페이지', `${EN_HEAD}[x](https://docs.atmark.ai/en/nowhere)\n`, /문서에 없는 페이지/],
    ['문서에 없는 앵커', `${EN_HEAD}[x](https://docs.atmark.ai/en/get-started/quickstart#nowhere)\n`, /문서 페이지에 없는 앵커 #nowhere/],
    ['공개 글이 초안을 가리킨다', `${EN_HEAD}[x](/blog/hello-draft)\n`, /공개 글이 초안을 가리킨다/],
    ['copy-guard 금지어', `${EN_HEAD}Our log is immutable.\n`, /copy-guard 금지어 — immutable/],
    ['공개 글의 TODO 주석', `${EN_HEAD}Hi. <!-- TODO: fix -->\n`, /TODO 주석/],
    ['::: 지시어', `${EN_HEAD}:::note\nx\n:::\n`, /::: 지시어/],
  ])('오류: %s', (_name, text, pattern) => {
    const b = build(withPost('posts/extra/en.md', text));
    expect(b.errors.join('\n')).toMatch(pattern);
  });

  it('ko/en 짝 — en 없는 ko 는 오류 · en 이 초안인데 ko 만 공개도 오류', () => {
    const lonely = build(withPost('posts/solo/ko.md', EN_HEAD.replace('draft: false', 'draft: false') + '안녕.\n'));
    expect(lonely.errors.join('\n')).toMatch(/posts\/solo\/ko\.md: 같은 slug 의 en\.md 가 없다/);
    const base = fixture();
    const drafted: BlogSources = {
      ...base,
      posts: base.posts.map((p) => (p.file === 'posts/hello/en.md' ? { ...p, text: p.text.replace('draft: false', 'draft: true') } : p)),
    };
    expect(build(drafted).errors.join('\n')).toMatch(/영어\(en\.md\)가 초안인데 한국어만 공개할 수 없다/);
  });

  it('폴더 꼴 — slug 꼴 · en/ko 밖 파일 이름은 오류', () => {
    const base = fixture();
    const bad = buildBlog({ ...base, problems: ['posts/Bad_Slug: slug 는 소문자·숫자·하이픈(80자 이하)'] }, { drafts: false, sitePaths: SITE_PATHS });
    expect(bad.errors).toContain('posts/Bad_Slug: slug 는 소문자·숫자·하이픈(80자 이하)');
  });

  it('초안의 오류는 보고만 한다(공개 글 오류와 분리)', () => {
    const b = build(withPost('posts/wip/en.md', '---\ntitle: "W"\ndescription: "A draft description."\ndate: 2026-09-02\n---\n[x](/nowhere) <!-- TODO: x -->\n'));
    expect(b.errors).toEqual([]);
    expect(b.draftErrors.join('\n')).toMatch(/사이트에 없는 경로/);
    expect(b.posts.map((p) => p.slug)).not.toContain('wip');
  });

  it('머리말 기본값 — draft 는 기본 true · author 기본 · tags 기본 []', () => {
    const parsed = parseBlogSource('---\ntitle: "T"\ndescription: "D is long enough."\ndate: 2026-09-02\n---\nHi.\n', 'x.md');
    expect(parsed.front).toMatchObject({ draft: true, author: "Younkyum 'Onve' Jin", tags: [], cover: null, updated: null });
  });

  it('주석 — 코드 펜스 안은 그대로 · 줄 수 유지 · TODO 줄 번호', () => {
    const r = stripComments('a <!-- x --> b\n```\n<!-- keep -->\n```\n<!-- TODO\nmore -->\nc');
    expect(r.text).toBe('a b\n```\n<!-- keep -->\n```\n\n\nc');
    expect(r.todos).toEqual([5]);
  });
});

describe('그림 — CSP 규칙(인라인 SVG)', () => {
  const svg = (inner: string, root = ''): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${root}>${inner}</svg>`;

  it.each([
    ['style 속성', svg('<rect width="1" height="1" fill="none" style="fill:red"/>'), /style=/],
    ['<style>', svg('<style>rect{fill:red}</style>'), /<style> 는 쓸 수 없다/],
    ['<script>', svg('<script>alert(1)</script>'), /<script> 는 쓸 수 없다/],
    ['이벤트 속성', svg('<rect width="1" height="1" fill="none" onclick="x()"/>'), /이벤트 속성/],
    ['색 글자', svg('<rect width="1" height="1" fill="#ff0000"/>'), /색은 글자로 적지 않는다/],
    ['stroke 색', svg('<rect width="1" height="1" fill="none" stroke="blue"/>'), /값이 허용 밖/],
    ['외부 href', svg('<use href="https://example.com/a.svg#x"/>'), /값이 허용 밖/],
    ['<image>', svg('<image href="#a"/>'), /<image> 는 쓸 수 없다/],
    ['<foreignObject>', svg('<foreignObject/>'), /<foreignObject> 는 쓸 수 없다/],
    ['칠 없는 도형', svg('<rect width="1" height="1"/>'), /칠이 없다/],
    ['모르는 클래스', svg('<rect width="1" height="1" class="red"/>'), /쓸 수 있는 클래스/],
    ['viewBox 없음', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="none"/></svg>', /viewBox/],
    ['없는 id 참조', svg('<line x1="0" y1="0" x2="1" y2="1" stroke="currentColor" fill="none" marker-end="url(#nope)"/>'), /없는 id/],
  ])('거부: %s', (_name, source, pattern) => {
    expect(() => sanitizeFigure(source, 'x.svg')).toThrow(FigureError);
    expect(() => sanitizeFigure(source, 'x.svg')).toThrow(pattern);
  });

  it('통과 — currentColor · 칠 클래스 · 뿌리의 칠 기본값은 남고, 크기는 viewBox 에서', () => {
    const f = sanitizeFigure(svg('<rect width="1" height="1" class="ink"/><text x="1" y="1">a &amp; b</text>', ' fill="none" stroke="currentColor"'), 'x.svg');
    expect(f).toMatchObject({ viewBox: '0 0 10 10', width: '10', height: '10', labelled: false, rootAttrs: ' fill="none" stroke="currentColor"' });
    expect(f.inner).toBe('<rect width="1" height="1" class="ink"/><text x="1" y="1">a &amp; b</text>');
  });

  it('실제 그림(src/site/blog/figures)은 전부 규칙을 지킨다', () => {
    const real = readBlogSources();
    expect(real.problems).toEqual([]);
    for (const [name, source] of real.figures) expect(() => sanitizeFigure(source, name), name).not.toThrow();
  });
});

describe('초안 차단 — 운영 빌드는 초안을 싣지 않는다', () => {
  const prod = site(false);
  const preview = site(true);

  it('운영: 초안 경로 404 · 목록·RSS·사이트맵·llms 에 없음 / 미리보기: 초안이 보이고 "초안" 표시', () => {
    expect(prod.routes.has('/blog/hello-draft')).toBe(false);
    expect(handleSiteRequest(event('/blog/hello-draft'), { pay: null, blog: prod }).statusCode).toBe(404);
    const index = prod.routes.get('/blog')?.html ?? '';
    expect(index).not.toContain('hello-draft');
    expect(index).not.toContain('A draft that never ships');
    expect(prod.feeds.get('/blog/rss.xml')).not.toContain('hello-draft');
    expect(prod.sitemap).not.toContain('hello-draft');
    expect(prod.llms.en).not.toContain('hello-draft');
    expect(preview.routes.has('/blog/hello-draft')).toBe(true);
    expect(preview.routes.get('/blog/hello-draft')?.html).toContain(`<span class="badge">${BLOG_COPY.en['draft'] ?? ''}</span>`);
  });

  it('레코드에 초안이 섞여 와도 drafts 없이는 걸러 낸다(이중 차단)', () => {
    const records = build(fixture(), true).posts;
    expect(records.some((p) => p.draft)).toBe(true);
    const s = buildBlogSite(records);
    expect(s.posts.some((p) => p.draft)).toBe(false);
    expect(s.routes.has('/blog/hello-draft')).toBe(false);
  });

  it('운영 값 파일(blog-data.ts)에는 초안이 없다', () => {
    expect(BLOG_POSTS.filter((p) => p.draft)).toEqual([]);
  });
});

describe('빈 블로그 — 공개 글이 없으면 /blog 404 · 링크 없음', () => {
  const empty = buildBlogSite([]);

  it('라우트·RSS·이미지·사이트맵·llms 가 비고 /blog · /kr/blog · RSS 가 404', () => {
    expect([empty.routes.size, empty.feeds.size, empty.images.size, empty.sitemap, empty.llms.en, empty.llms.ko]).toEqual([0, 0, 0, '', '', '']);
    for (const path of ['/blog', '/kr/blog', '/blog/rss.xml', '/blog/hello']) {
      expect(handleSiteRequest(event(path), { pay: null, blog: empty }).statusCode, path).toBe(404);
    }
  });

  it('초안만 있으면 운영 블로그는 비어 있다', () => {
    const draftsOnly = build(fixture(), true).posts.filter((p) => p.draft);
    expect(buildBlogSite(draftsOnly).routes.size).toBe(0);
  });

  it('머리·꼬리의 "블로그" 링크는 공개 글이 있을 때만(운영 값 파일 기준)', () => {
    const home = SITE_ROUTES['/']?.html ?? '';
    const label = CHROME_COPY.en['blog'] ?? '';
    if (PUBLISHED_POSTS.length === 0) {
      expect(BLOG_NAV).toEqual({ en: null, ko: null });
      expect(home).not.toContain('href="/blog"');
      expect(home).not.toContain(`>${label}</a>`);
      expect(handleSiteRequest(event('/blog')).statusCode).toBe(404);
    } else {
      expect(home.split(`<a href="/blog">${label}</a>`)).toHaveLength(4); // 주 메뉴 · 모바일 메뉴 · 꼬리
    }
  });

  it('블로그가 있으면 링크가 생긴다 — 영어는 /blog, 한국어 목록이 없으면 한국어 페이지는 영어 목록(hreflang="en")', () => {
    const s = site();
    const en = s.routes.get('/blog')?.html ?? '';
    expect(en.split(`<a href="/blog" aria-current="page">${CHROME_COPY.en['blog'] ?? ''}</a>`)).toHaveLength(3); // 주 메뉴 · 모바일 메뉴
    expect(en).toContain(`<a href="/blog">${CHROME_COPY.en['blog'] ?? ''}</a>`); // 꼬리
    const enOnly = buildBlogSite(build().posts.filter((p) => p.lang === 'en'), { shots: SHOT_SET });
    const ko = handleSiteRequest(event('/blog/hello'), { pay: null, blog: enOnly }).body;
    expect(ko).toContain(`<a href="/blog" aria-current="page">${CHROME_COPY.en['blog'] ?? ''}</a>`);
    expect(enOnly.routes.has('/kr/blog')).toBe(false);
  });
});

describe('페이지 마크업 — canonical · hreflang · JSON-LD · OG', () => {
  const s = site();
  const enPost = s.routes.get('/blog/hello')?.html ?? '';
  const koPost = s.routes.get('/kr/blog/hello')?.html ?? '';
  const enIndex = s.routes.get('/blog')?.html ?? '';

  it('라우트 — 목록·글 두 언어 · 끝 슬래시는 301 · RSS 둘', () => {
    expect([...s.routes.keys()].sort()).toEqual(['/blog', '/blog/hello', '/kr/blog', '/kr/blog/hello']);
    expect([...s.feeds.keys()].sort()).toEqual(['/blog/rss.xml', '/kr/blog/rss.xml']);
    const slash = handleSiteRequest(event('/blog/hello/'), { pay: null, blog: s });
    expect([slash.statusCode, slash.headers['location']]).toEqual([301, `${SITE_ORIGIN}/blog/hello`]);
    expect(handleSiteRequest(event('/blog/hello'), { pay: null, blog: s }).headers['cache-control']).toBe('public, max-age=300');
  });

  it('canonical · hreflang(두 언어가 다 있으면 ko·en·x-default=en) · 언어 전환 링크', () => {
    expect(enPost).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/blog/hello">`);
    expect(enPost).toContain(`<link rel="alternate" hreflang="ko" href="${SITE_ORIGIN}/kr/blog/hello">`);
    expect(enPost).toContain(`<link rel="alternate" hreflang="en" href="${SITE_ORIGIN}/blog/hello">`);
    expect(enPost).toContain(`<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}/blog/hello">`);
    expect(koPost).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/kr/blog/hello">`);
    const alts = (html: string): string[] => [...html.matchAll(/<link rel="alternate" hreflang[^>]*>/g)].map((m) => m[0]);
    expect(alts(koPost)).toEqual(alts(enPost));
    // 언어 전환은 ≡ 서랍 맨 아래 · 꼬리에만(머리 정리 2026-10-01) — 같은 글의 반대 언어로.
    expect(enPost).not.toContain('class="plain lang"');
    expect(enPost).toContain('<a class="lang" href="/kr/blog/hello?hl=ko" hreflang="ko" lang="ko">');
    expect(enPost).toContain('<a href="/kr/blog/hello?hl=ko" hreflang="ko" lang="ko">한국어</a></nav><p class="fcopy');
    expect(koPost).toContain('<a class="lang" href="/blog/hello?hl=en" hreflang="en" lang="en">');
    expect(koPost).toContain('<a href="/blog/hello?hl=en" hreflang="en" lang="en">English</a></nav><p class="fcopy');
    expect(enIndex).toContain('<a class="lang" href="/kr/blog?hl=ko" hreflang="ko" lang="ko">');
    expect(enIndex).toContain('<a href="/kr/blog?hl=ko" hreflang="ko" lang="ko">한국어</a></nav><p class="fcopy');
    expect(enPost).toContain('<meta name="robots" content="index,follow">');
  });

  it('영어만 있는 글 — canonical 만(hreflang 없음) · og:locale:alternate 없음 · 전환 링크는 한국어 목록이나 홈', () => {
    const solo = buildBlog(withPost('posts/solo/en.md', `${EN_HEAD}Just English.\n`), { drafts: false, sitePaths: SITE_PATHS, shotImages: new Set(['agent-new']) });
    const ss = buildBlogSite(solo.posts, { shots: SHOT_SET });
    const html = ss.routes.get('/blog/solo')?.html ?? '';
    expect(html).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/blog/solo">`);
    expect(html).not.toMatch(/hreflang="(ko|en|x-default)" href="https:\/\/atmark\.ai/);
    expect(metaContents(html, 'property', 'og:locale:alternate')).toEqual([]);
    expect(html).toContain('<a class="lang" href="/kr/blog?hl=ko"');
    expect(html).toContain('<a href="/kr/blog?hl=ko" hreflang="ko" lang="ko">');
    const enOnly = buildBlogSite(solo.posts.filter((p) => p.lang === 'en'));
    expect(enOnly.routes.get('/blog/solo')?.html).toContain('<a href="/kr?hl=ko" hreflang="ko" lang="ko">');
  });

  it('JSON-LD — 글은 조직 + BlogPosting(제목·설명·날짜·글쓴이·출판사·언어·URL·태그), 목록은 Blog(글 목록)', () => {
    const graph = ld(enPost)['@graph'];
    expect(graph.map((n) => n['@type'])).toEqual(['Organization', 'BlogPosting']);
    expect(graph[1]).toMatchObject({
      headline: 'Hello from the fixture',
      datePublished: '2026-09-01',
      dateModified: '2026-09-15',
      inLanguage: 'en',
      url: `${SITE_ORIGIN}/blog/hello`,
      mainEntityOfPage: `${SITE_ORIGIN}/blog/hello`,
      author: { '@type': 'Person', name: "Younkyum 'Onve' Jin" },
      publisher: { '@id': `${SITE_ORIGIN}/#organization` },
      keywords: 'fixture, tests',
    });
    const index = ld(enIndex)['@graph'];
    expect(index[1]).toMatchObject({ '@type': 'Blog', url: `${SITE_ORIGIN}/blog`, inLanguage: 'en' });
    expect((index[1]?.['blogPost'] as unknown[]).length).toBe(1);
    expect(enPost.match(/application\/ld\+json/g)).toHaveLength(1);
  });

  it('OG — article · 날짜·태그 · 카드가 없으면 사이트 공통 OG · 카드가 있고 제목이 같으면 그 카드 · 제목이 낡았으면 다시 공통 OG', () => {
    expect(metaContents(enPost, 'property', 'og:type')).toEqual(['article']);
    expect(metaContents(enPost, 'property', 'og:url')).toEqual([`${SITE_ORIGIN}/blog/hello`]);
    expect(metaContents(enPost, 'property', 'article:published_time')).toEqual(['2026-09-01']);
    expect(metaContents(enPost, 'property', 'article:modified_time')).toEqual(['2026-09-15']);
    expect(metaContents(enPost, 'property', 'article:tag')).toEqual(['fixture', 'tests']);
    expect(metaContents(enPost, 'property', 'og:image')).toEqual([`${SITE_ORIGIN}/og/${OG_IMAGES.en.hash}/en.png`]);
    expect(metaContents(enPost, 'name', 'twitter:card')).toEqual(['summary_large_image']);
    const card: BlogOgImage = { path: '/og/blog/cccccccccccccccc/hello-en.png', contentType: 'image/png', width: 1200, height: 630, hash: 'cccccccccccccccc', bytes: 4, base64: 'iVBORw==', title: 'Hello from the fixture' };
    const withCard = site(false, { 'hello/en': card });
    const html = withCard.routes.get('/blog/hello')?.html ?? '';
    expect(metaContents(html, 'property', 'og:image')).toEqual([`${SITE_ORIGIN}${card.path}`]);
    expect(metaContents(html, 'name', 'twitter:image')).toEqual([`${SITE_ORIGIN}${card.path}`]);
    expect(metaContents(html, 'property', 'og:image:alt')).toEqual(['Atmark Blog: Hello from the fixture']);
    expect(ld(html)['@graph'][1]?.['image']).toBe(`${SITE_ORIGIN}${card.path}`);
    const img = handleSiteRequest(event(card.path), { pay: null, blog: withCard });
    expect([img.statusCode, img.headers['content-type'], img.headers['cache-control']]).toEqual([200, 'image/png', 'public, max-age=31536000, immutable']);
    const stale = site(false, { 'hello/en': { ...card, title: 'Old title' } });
    expect(metaContents(stale.routes.get('/blog/hello')?.html ?? '', 'property', 'og:image')).toEqual([`${SITE_ORIGIN}/og/${OG_IMAGES.en.hash}/en.png`]);
    expect(stale.images.has(card.path)).toBe(false);
  });

  it('글 — 글쓴이·날짜·수정일·읽는 시간·태그 · 이전/다음 · CTA 하나(대기자 명단) · RSS 대안 링크', () => {
    const main = body(enPost);
    expect(main).toContain('<p class="byline"><span>By Younkyum \'Onve\' Jin</span><span><time datetime="2026-09-01">September 1, 2026</time></span><span>Updated <time datetime="2026-09-15">September 15, 2026</time></span>');
    expect(main).toMatch(/<span>\d+ min read<\/span>/);
    expect(main).toContain('<ul class="tags" aria-label="Tags"><li>fixture</li><li>tests</li></ul>');
    expect(main.match(/class="btn"/g)).toHaveLength(1);
    expect(main).toContain('<a class="btn" href="/waitlist">Join the waitlist ');
    expect(body(koPost)).toContain('<a class="btn" href="/kr/waitlist">대기자 명단 ');
    expect(enPost).toContain(`<link rel="alternate" type="application/rss+xml" title="Atmark Blog" href="${SITE_ORIGIN}/blog/rss.xml">`);
    const preview = site(true).routes.get('/blog/hello')?.html ?? '';
    expect(preview).toContain('<nav class="pn" aria-label="More from the blog">');
    expect(preview).toContain('<a class="pn-newer" href="/blog/hello-draft" rel="next">');
  });

  it('스크린샷 — <picture>(어두운 화면은 어두운 벌) · 크기 명시(CSS px = 픽셀 / 배율) · lazy · 같은 출처 /img · 1년 immutable', () => {
    expect(body(enPost)).toContain(
      '<picture><source media="(prefers-color-scheme: dark)" srcset="/img/bbbbbbbbbbbbbbbb/blog-agent-new-en-dark.webp" width="600" height="400">' +
        '<img src="/img/aaaaaaaaaaaaaaaa/blog-agent-new-en-light.webp" width="600" height="400" alt="The Agents screen with the new agent dialog open" loading="lazy" decoding="async"></picture>',
    );
    const res = handleSiteRequest(event('/img/aaaaaaaaaaaaaaaa/blog-agent-new-en-light.webp'), { pay: null, blog: s });
    expect([res.statusCode, res.headers['content-type'], res.headers['cache-control'], res.isBase64Encoded]).toEqual([200, 'image/webp', 'public, max-age=31536000, immutable', true]);
    const missing = buildBlogSite(build().posts, { shots: {} });
    expect(body(missing.routes.get('/blog/hello')?.html ?? '')).toContain('<div class="shot-pending" role="img"');
  });
});

describe('RSS 2.0', () => {
  const s = site();
  const feed = s.feeds.get('/blog/rss.xml') ?? '';

  it('잘 짜인 XML · rss 2.0 · 채널 필수 요소 · atom self · 글마다 title·link·guid·pubDate(RFC 822)·description · 200 application/rss+xml', () => {
    const names = xmlElements(feed);
    expect(names.slice(0, 2)).toEqual(['rss', 'channel']);
    expect(feed).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
    for (const tag of ['title', 'link', 'description', 'language', 'lastBuildDate']) expect(feed).toMatch(new RegExp(`<channel>[\\s\\S]*<${tag}>`));
    expect(feed).toContain(`<atom:link href="${SITE_ORIGIN}/blog/rss.xml" rel="self" type="application/rss+xml"/>`);
    expect(feed.match(/<item>/g)).toHaveLength(1);
    expect(feed).toContain(`<guid isPermaLink="true">${SITE_ORIGIN}/blog/hello</guid>`);
    expect(feed).toContain('<pubDate>Tue, 01 Sep 2026 00:00:00 GMT</pubDate>');
    expect(feed).toContain('<lastBuildDate>Tue, 15 Sep 2026 00:00:00 GMT</lastBuildDate>');
    expect(feed).toContain('<category>fixture</category>');
    const res = handleSiteRequest(event('/blog/rss.xml'), { pay: null, blog: s });
    expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, 'application/rss+xml; charset=utf-8', feed]);
    expect(xmlElements(s.feeds.get('/kr/blog/rss.xml') ?? '')).toContain('item');
    expect(() => xmlElements(feed.replace('</title>', '</titl>'))).toThrow();
  });

  it('특수 문자는 이스케이프된다', () => {
    const tricky = build(withPost('posts/amp/en.md', '---\ntitle: "Tom & Jerry\'s \\"mail\\""\ndescription: "Ampersands & quotes in a description."\ndate: 2026-09-03\ndraft: false\n---\nHi.\n'));
    const feedXml = buildBlogSite(tricky.posts, { shots: SHOT_SET }).feeds.get('/blog/rss.xml') ?? '';
    expect(() => xmlElements(feedXml)).not.toThrow();
    expect(feedXml).toContain('Tom &amp; Jerry&apos;s');
  });
});

describe('사이트맵 · llms.txt', () => {
  const s = site();

  it('블로그 항목 — 목록·글, lastmod = 수정일(없으면 게시일), 두 언어가 다 있으면 hreflang 묶음', () => {
    const urls = [...s.sitemap.matchAll(/<url>[\s\S]*?<\/url>/g)].map((m) => m[0]);
    expect(urls.map((u) => /<loc>([^<]+)<\/loc>/.exec(u)?.[1])).toEqual([
      `${SITE_ORIGIN}/blog`,
      `${SITE_ORIGIN}/blog/hello`,
      `${SITE_ORIGIN}/kr/blog`,
      `${SITE_ORIGIN}/kr/blog/hello`,
    ]);
    expect(urls.map((u) => /<lastmod>([^<]+)<\/lastmod>/.exec(u)?.[1])).toEqual(['2026-09-15', '2026-09-15', '2026-09-01', '2026-09-01']);
    for (const u of urls) expect(u.match(/<xhtml:link rel="alternate" hreflang="(ko|en|x-default)"/g)).toHaveLength(3);
    expect(s.llms.en).toContain(`- [Hello from the fixture](${SITE_ORIGIN}/blog/hello): `);
    expect(s.llms.ko).toContain(`(${SITE_ORIGIN}/kr/blog/hello)`);
  });

  it('운영 사이트맵·llms.txt 는 운영 블로그(공개 글)를 그대로 싣는다', () => {
    expect(SITEMAP_XML).toContain(BLOG_SITE.sitemap);
    for (const lang of ['en', 'ko'] as const) expect(LLMS_TXT).toContain(BLOG_SITE.llms[lang]);
    if (BLOG_SITE.posts.length === 0) expect(SITEMAP_XML).not.toContain('/blog');
  });
});

describe('엣지 언어 협상 — 블로그', () => {
  it('한국어 짝이 있는 영어 경로만(목록 · 글) — 영어만 있는 글은 옮기지 않는다', () => {
    expect(blogNegotiatedEnPaths(build().posts)).toEqual(['/blog', '/blog/hello']);
    expect(blogNegotiatedEnPaths(build().posts.filter((p) => p.lang === 'en'))).toEqual([]);
    expect(site().negotiatedEnPaths).toEqual(['/blog', '/blog/hello']);
  });

  it('운영 엣지 함수 표에 운영 블로그의 협상 경로가 있고, 그 두 언어 경로가 실제 라우트다', () => {
    expect(BLOG_NEGOTIATED_EN_PATHS).toEqual(BLOG_SITE.negotiatedEnPaths);
    for (const p of BLOG_NEGOTIATED_EN_PATHS) {
      expect(SITE_LANG_FUNCTION_CODE).toContain(`'${p}':1`);
      expect(BLOG_SITE.routes.has(p)).toBe(true);
      expect(BLOG_SITE.routes.has(`/kr${p}`)).toBe(true);
    }
  });
});

describe('운영 값 파일', () => {
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex').slice(0, 16);

  it('blog-data.ts 는 원문에서 다시 만든 것과 같다(글을 고치면 pnpm gen:blog) · 공개 글에 오류가 없다', () => {
    const b = buildBlog(readBlogSources(), { drafts: false, sitePaths: SITE_PATHS });
    expect(b.errors).toEqual([]);
    expect(readFileSync(BLOG_DATA_OUT, 'utf8')).toBe(renderBlogDataFile(b.posts));
  });

  it('공개 글이 쓰는 스크린샷은 그 언어의 두 테마 바이트가 있다', () => {
    for (const p of PUBLISHED_POSTS) {
      for (const id of p.shots) {
        const set = BLOG_SHOT_IMAGES[id]?.[p.lang];
        expect(set, `${p.slug}/${p.lang} ${id}`).toBeDefined();
      }
    }
  });

  it('스크린샷 값 파일 — /img/<해시>/blog-<id>-<lang>-<theme>.webp · RIFF/WEBP · 해시·크기 일치 · 배율 = 문서 스크린샷', () => {
    expect(BLOG_SHOT_SCALE).toBe(DOCS_SHOT_VIEW.scale);
    for (const [id, set] of Object.entries(BLOG_SHOT_IMAGES)) {
      for (const [lang, pair] of Object.entries(set)) {
        for (const [theme, img] of Object.entries(pair ?? {})) {
          expect(img.path).toBe(`/img/${img.hash}/blog-${id}-${lang}-${theme}.webp`);
          const bytes = Buffer.from(img.base64, 'base64');
          expect([bytes.subarray(0, 4).toString('latin1'), bytes.subarray(8, 12).toString('latin1')]).toEqual(['RIFF', 'WEBP']);
          expect([bytes.length, sha(bytes)]).toEqual([img.bytes, img.hash]);
        }
      }
    }
  });

  it('OG 값 파일 — /og/blog/<해시>/<slug>-<lang>.png · PNG 1200×630 · 해시·크기 일치', () => {
    for (const [key, img] of Object.entries(BLOG_OG_IMAGES)) {
      const [slug, lang] = key.split('/');
      expect(img.path).toBe(`/og/blog/${img.hash}/${slug ?? ''}-${lang ?? ''}.png`);
      const bytes = Buffer.from(img.base64, 'base64');
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
      expect([bytes.length, sha(bytes)]).toEqual([img.bytes, img.hash]);
    }
  });

  it('스크린샷 등록부 — 블로그 전용 id 는 blog- 로 시작하고 문서 id 와 겹치지 않는다', () => {
    for (const id of Object.keys(BLOG_SHOTS)) {
      expect(id).toMatch(/^blog-[a-z0-9-]+$/);
      expect(Object.keys(DOCS_SHOTS)).not.toContain(id);
    }
  });

  it('언어별 문구 키 집합이 같다', () => {
    expect(Object.keys(BLOG_COPY.ko).sort()).toEqual(Object.keys(BLOG_COPY.en).sort());
  });
});

