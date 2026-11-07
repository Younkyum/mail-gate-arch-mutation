/**
 * scripts/blog/build.ts — 블로그 원문(`src/site/blog/posts/<slug>/<lang>.md` · `figures/<이름>.svg`)을 읽어 검사하고, 사이트가 싣는 레코드
 * (`src/site/blog-data.ts` 의 `BlogPostRecord`)로 렌더한다. `pnpm gen:blog`·로컬 미리보기(초안 포함)·테스트가 부른다.
 *
 * 검사(오류 — 공개 글이면 `pnpm gen:blog` 가 실패한다, 초안이면 보고만 한다):
 *   - 폴더·파일 꼴(slug = 소문자·숫자·-, 파일 = `en.md`·`ko.md`, `en` 필수) · 머리말(키 · description ≤160 · 날짜 · 태그) · 본문 문법.
 *   - ko/en 짝: `ko.md` 는 같은 slug 의 `en.md` 가 있어야 하고, 영어가 초안인데 한국어만 공개될 수 없다.
 *   - 그림(`figure:`)이 `figures/` 에 있고 CSP 규칙을 지킨다(`figures.ts`) · 스크린샷(`shot:`) id 가 등록부에 있다.
 *   - 링크: 같은 글 앵커(`#…`)는 실제 헤딩 · 사이트 경로(`/…`·`https://atmark.ai/…`)는 실제 라우트(공개 글이 초안을 가리키면 오류) ·
 *     문서(`https://docs.atmark.ai/…`)는 실제 문서 페이지와 앵커 · 그 밖의 `http:` 는 오류(외부는 https 만 — `rel="noopener"`).
 *   - copy-guard 금지어(`test/support/copy-guard.ts` `COPY_GUARD_BANNED`) — 제목 · 설명 · 본문의 보이는 글자(그림 글자 포함).
 *   - 공개 글에 `<!-- TODO … -->` 주석이 남아 있으면 오류(주석은 원문에만 — 출력에 실리지 않는다).
 * 경고: 스크린샷 바이트가 아직 없다(`pnpm gen:blog-images`) · 예시가 아닌 `…@atmark.ai` 주소 · 공개 글의 OG 카드가 없거나 낡았다.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeDocsContent } from '../../src/docs/content-data';
import DOCS_CONTENT from '../../src/docs/generated/content.json';
import { DOCS_SHOTS } from '../../src/docs/shots';
import { slugify } from '../../src/docs/render';
import { EXAMPLE_RESERVED_LOCAL_PARTS } from '../../src/identity/address';
import { BLOG_SHOTS } from '../../src/site/blog/shots';
import type { BlogPostRecord } from '../../src/site/blog-data';
import { blogIndexPath, blogPostPath } from '../../src/site/blog-nav';
import { BLOG_OG_IMAGES } from '../../src/site/blog-og-data';
import { BLOG_SHOT_IMAGES } from '../../src/site/blog-shot-data';
import { DOCS_ORIGIN, SITE_ORIGIN } from '../../src/site/constants';
import { COPY_GUARD_BANNED, copyGuardHits, visibleText } from '../../test/support/copy-guard';
import { FigureError, prefixIds, sanitizeFigure, type FigureSvg } from './figures';
import { BlogSyntaxError, parseBlogSource, type BlogBlock, type BlogList, type Inline, type ParsedBlogSource } from './markdown';

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const BLOG_ROOT = join(REPO_ROOT, 'src/site/blog');
export const BLOG_DATA_OUT = join(REPO_ROOT, 'src/site/blog-data.ts');

export type BlogLang = 'en' | 'ko';
const BLOG_LANGS: readonly BlogLang[] = ['en', 'ko'];
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 80;

export interface BlogSourceFile {
  readonly slug: string;
  readonly lang: BlogLang;
  /** 보고용 경로(`posts/<slug>/<lang>.md`). */
  readonly file: string;
  readonly text: string;
}

export interface BlogSources {
  readonly posts: readonly BlogSourceFile[];
  /** 그림 이름 → SVG 원문. */
  readonly figures: ReadonlyMap<string, string>;
  /** 폴더 꼴 문제(파일 이름 · slug). */
  readonly problems: readonly string[];
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** 원문 폴더 → 글·그림. `.md`·`.svg` 가 아닌 파일, 꼴이 틀린 slug·언어는 `problems` 에(조용히 빠지지 않게). */
export function readBlogSources(root: string = BLOG_ROOT): BlogSources {
  const posts: BlogSourceFile[] = [];
  const problems: string[] = [];
  const postsDir = join(root, 'posts');
  for (const slug of list(postsDir)) {
    if (slug.startsWith('.')) continue;
    const dir = join(postsDir, slug);
    if (!statSync(dir).isDirectory()) {
      problems.push(`posts/${slug}: 글은 posts/<slug>/<lang>.md 꼴로 둔다`);
      continue;
    }
    if (!SLUG_PATTERN.test(slug) || slug.length > SLUG_MAX) problems.push(`posts/${slug}: slug 는 소문자·숫자·하이픈(${String(SLUG_MAX)}자 이하)`);
    for (const name of list(dir)) {
      if (name.startsWith('.')) continue;
      const m = /^(en|ko)\.md$/.exec(name);
      if (m === null) {
        problems.push(`posts/${slug}/${name}: 파일은 en.md · ko.md 뿐`);
        continue;
      }
      posts.push({ slug, lang: m[1] as BlogLang, file: `posts/${slug}/${name}`, text: readFileSync(join(dir, name), 'utf8') });
    }
  }
  const figures = new Map<string, string>();
  for (const name of list(join(root, 'figures'))) {
    if (name.startsWith('.')) continue;
    const m = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.svg$/.exec(name);
    if (m === null) {
      problems.push(`figures/${name}: 그림은 <이름>.svg(소문자·숫자·하이픈)`);
      continue;
    }
    figures.set(m[1] ?? '', readFileSync(join(root, 'figures', name), 'utf8'));
  }
  return { posts, figures, problems };
}

// ── 글자 조각 ────────────────────────────────────────────────────────────

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/**
 * 원문의 HTML 주석(`<!-- … -->`)을 지운다 — 코드 펜스 안은 그대로. 지운 주석 중 `TODO` 가 든 것의 줄 번호를 돌려준다(공개 글이면 오류).
 * 줄 수는 바꾸지 않는다(여러 줄 주석은 빈 줄로) — 문법 오류의 줄 번호가 원문과 같다.
 */
export function stripComments(text: string): { readonly text: string; readonly todos: readonly number[] } {
  const lines = text.split('\n');
  const todos: number[] = [];
  let inFence = false;
  let inComment = false;
  let commentStart = 0;
  let commentBody = '';
  const out = lines.map((line, i) => {
    if (!inComment && line.trim().startsWith('```')) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    let result = '';
    let rest = line;
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end < 0) {
          commentBody += rest;
          rest = '';
          break;
        }
        commentBody += rest.slice(0, end);
        if (/TODO/.test(commentBody)) todos.push(commentStart);
        inComment = false;
        commentBody = '';
        rest = rest.slice(end + 3);
        continue;
      }
      const start = rest.indexOf('<!--');
      if (start < 0) {
        result += rest;
        break;
      }
      result += rest.slice(0, start);
      inComment = true;
      commentStart = i + 1;
      rest = rest.slice(start + 4);
    }
    // 주석을 지운 자리의 겹친 공백 하나로.
    return result.replace(/[ \t]{2,}/g, (s, offset: number) => (offset === 0 ? s : ' ')).replace(/[ \t]+$/, '');
  });
  return { text: out.join('\n'), todos };
}

// ── 링크 ─────────────────────────────────────────────────────────────────

export interface LinkContext {
  /** 사이트 라우트(블로그 밖) — `SITE_ROUTES` 의 키. */
  readonly sitePaths: ReadonlySet<string>;
  /** 블로그 글 경로 → 초안인가. */
  readonly blogPaths: ReadonlyMap<string, boolean>;
  /** 문서 페이지 id → 앵커 집합(언어별). */
  readonly docs: Readonly<Record<BlogLang, ReadonlyMap<string, ReadonlySet<string>>>>;
}

const DOCS_HOST = new URL(DOCS_ORIGIN).host;
const SITE_HOST = new URL(SITE_ORIGIN).host;

/** 문서 원문 → 앵커 집합(헤딩의 `{#id}` 또는 글자에서 만든 id). 문서 렌더러와 같은 규칙(겹치면 `-2`)이 아니라 존재만 본다. */
function docAnchors(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/^[ \t]*#{2,3}[ \t]+(.+?)[ \t]*$/gm)) {
    const raw = m[1] ?? '';
    const explicit = /\{#([a-z0-9][a-z0-9-]*)\}$/.exec(raw);
    out.add(explicit?.[1] ?? slugify(raw.replace(/[`*]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')));
  }
  return out;
}

/** 문서 값 파일 → 언어별 페이지 id 와 앵커. 문서 사이트 경로: 한국어 `/<id>`, 영어 `/en/<id>`, 홈(`index`)은 `/`·`/en`. */
export function docsIndex(): Record<BlogLang, Map<string, Set<string>>> {
  const sources = decodeDocsContent(DOCS_CONTENT as Parameters<typeof decodeDocsContent>[0]);
  const build = (lang: 'ko' | 'en'): Map<string, Set<string>> =>
    new Map(Object.entries(sources[lang]).map(([id, text]) => [id === 'index' ? '' : id, docAnchors(text)]));
  return { ko: build('ko'), en: build('en') };
}

interface LinkResult {
  readonly href: string;
  readonly external: boolean;
  readonly error: string | null;
  /** 같은 글 앵커(`#x`) — 렌더 뒤에 헤딩과 대조한다. */
  readonly anchor: string | null;
}

function resolveLink(href: string, ctx: LinkContext, draft: boolean): LinkResult {
  const ok = (h: string, external = false): LinkResult => ({ href: h, external, error: null, anchor: null });
  const bad = (error: string): LinkResult => ({ href, external: false, error, anchor: null });
  if (href.startsWith('#')) {
    if (!/^#[\p{L}\p{N}][\p{L}\p{N}-]*$/u.test(href)) return bad(`앵커 꼴이 아니다: ${href}`);
    return { href, external: false, error: null, anchor: href.slice(1) };
  }
  if (href.startsWith('mailto:')) return /^mailto:[^\s@]+@[^\s@]+$/.test(href) ? ok(href) : bad(`mailto 꼴이 아니다: ${href}`);
  let url: URL;
  try {
    url = new URL(href, SITE_ORIGIN);
  } catch {
    return bad(`링크 주소를 읽지 못했다: ${href}`);
  }
  if (href.startsWith('//')) return bad(`프로토콜 없는 링크(//…)는 쓰지 않는다: ${href}`);
  if (url.protocol === 'http:') return bad(`http 링크 — https 로: ${href}`);
  if (url.protocol !== 'https:') return bad(`링크 프로토콜은 https · mailto 만: ${href}`);
  // 사이트 안(상대 경로 또는 https://atmark.ai/…) — 상대 경로로 싣는다.
  if (url.host === SITE_HOST) {
    if (!href.startsWith('/') && !href.startsWith(SITE_ORIGIN)) return bad(`상대 링크는 /… 로 시작한다: ${href}`);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;
    const blog = ctx.blogPaths.get(path);
    if (blog !== undefined) {
      if (blog && !draft) return bad(`공개 글이 초안을 가리킨다: ${path}`);
    } else if (!ctx.sitePaths.has(path)) {
      return bad(`사이트에 없는 경로: ${path}`);
    }
    return ok(`${path}${url.search}${url.hash}`);
  }
  if (url.host === DOCS_HOST) {
    const parts = url.pathname.replace(/^\/+|\/+$/g, '');
    if (parts === 'llms.txt' || parts === 'en/llms.txt') return ok(url.href);
    const lang: BlogLang = parts === 'en' || parts.startsWith('en/') ? 'en' : 'ko';
    const id = lang === 'en' ? parts.replace(/^en\/?/, '') : parts;
    const page = ctx.docs[lang].get(id.replace(/\.md$/, ''));
    if (page === undefined) return bad(`문서에 없는 페이지: ${href}`);
    const anchor = decodeURIComponent(url.hash.slice(1));
    if (anchor !== '' && !page.has(anchor)) return bad(`문서 페이지에 없는 앵커 #${anchor}: ${href}`);
    return ok(url.href);
  }
  return ok(url.href, true);
}

// ── 렌더 ─────────────────────────────────────────────────────────────────

interface RenderEnv {
  readonly lang: BlogLang;
  readonly draft: boolean;
  readonly file: string;
  readonly links: LinkContext;
  readonly figures: ReadonlyMap<string, string>;
  readonly shotIds: ReadonlySet<string>;
  readonly errors: string[];
  readonly anchorsUsed: { anchor: string; line: number }[];
  readonly headingIds: Set<string>;
  readonly shots: string[];
  /** 한 글 안 그림 순번(id 접두어). */
  figureCount: number;
}

const TABLE_LABEL: Readonly<Record<BlogLang, string>> = { en: 'Table', ko: '표' };

function renderInline(nodes: readonly Inline[], env: RenderEnv): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
          return escapeHtml(n.v);
        case 'code':
          return `<code>${escapeHtml(n.v)}</code>`;
        case 'strong':
          return `<strong>${renderInline(n.c, env)}</strong>`;
        case 'em':
          return `<em>${renderInline(n.c, env)}</em>`;
        case 'link': {
          const r = resolveLink(n.href, env.links, env.draft);
          if (r.error !== null) env.errors.push(`${env.file}:${String(n.line)}: ${r.error}`);
          if (r.anchor !== null) env.anchorsUsed.push({ anchor: r.anchor, line: n.line });
          return `<a href="${escapeHtml(r.href)}"${r.external ? ' rel="noopener"' : ''}>${renderInline(n.c, env)}</a>`;
        }
      }
    })
    .join('');
}

function inlinePlain(nodes: readonly Inline[]): string {
  return nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : inlinePlain(n.c))).join('');
}

function claimId(base: string, env: RenderEnv): string {
  const root = base === '' ? 'section' : base;
  let id = root;
  for (let k = 2; env.headingIds.has(id); k += 1) id = `${root}-${String(k)}`;
  env.headingIds.add(id);
  return id;
}

function renderList(b: BlogList, env: RenderEnv): string {
  const tag = b.ordered ? 'ol' : 'ul';
  return `<${tag}>${b.items.map((it) => `<li>${renderInline(it.inline, env)}${it.children === null ? '' : renderList(it.children, env)}</li>`).join('')}</${tag}>`;
}

const ALIGN_CLASS = { left: '', center: ' class="ac"', right: ' class="ar"' } as const;

/** 그림 하나의 인라인 SVG — `figure.svg` 를 검사해 id 에 접두어를 붙인다. `label` 이 `null` 이면 장식(aria-hidden). */
function figureSvg(fig: FigureSvg, prefix: string, label: string | null): string {
  const name = fig.labelled ? '' : label === null ? ' aria-hidden="true"' : ` aria-label="${escapeHtml(label)}"`;
  return prefixIds(
    `<svg class="fig-svg" viewBox="${fig.viewBox}" width="${fig.width}" height="${fig.height}"${fig.labelled || label !== null ? ' role="img"' : ''}${name} focusable="false"${fig.rootAttrs}>${fig.inner}</svg>`,
    prefix,
  );
}

function loadFigure(name: string, env: RenderEnv, line: number): FigureSvg | null {
  const source = env.figures.get(name);
  if (source === undefined) {
    env.errors.push(`${env.file}:${String(line)}: 그림이 없다 — src/site/blog/figures/${name}.svg`);
    return null;
  }
  try {
    return sanitizeFigure(source, `figures/${name}.svg`);
  } catch (error) {
    env.errors.push(`${env.file}:${String(line)}: ${error instanceof FigureError ? error.message : String(error)}`);
    return null;
  }
}

function renderBlock(b: BlogBlock, env: RenderEnv): string {
  switch (b.t) {
    case 'heading': {
      const id = b.explicitId === null ? claimId(slugify(inlinePlain(b.inline)), env) : claimId(b.explicitId, env);
      return `<h${String(b.level)} id="${id}">${renderInline(b.inline, env)}</h${String(b.level)}>`;
    }
    case 'para':
      return `<p>${renderInline(b.inline, env)}</p>`;
    case 'list':
      return renderList(b, env);
    case 'table': {
      const cell = (tag: 'th' | 'td', c: readonly Inline[], k: number): string =>
        `<${tag}${tag === 'th' ? ' scope="col"' : ''}${ALIGN_CLASS[b.align[k] ?? 'left']}>${renderInline(c, env)}</${tag}>`;
      return (
        `<div class="bt" role="region" aria-label="${TABLE_LABEL[env.lang]}" tabindex="0"><table>` +
        `<thead><tr>${b.head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>` +
        `<tbody>${b.rows.map((r) => `<tr>${r.map((c, k) => cell('td', c, k)).join('')}</tr>`).join('')}</tbody>` +
        '</table></div>'
      );
    }
    case 'code': {
      const label = b.title !== '' ? b.title : b.lang;
      return (
        `<figure class="bcode">${label === '' ? '' : `<figcaption>${escapeHtml(label)}</figcaption>`}` +
        `<pre tabindex="0"><code${b.lang === '' ? '' : ` class="lang-${b.lang.toLowerCase()}"`}>${escapeHtml(b.text)}</code></pre></figure>`
      );
    }
    case 'quote':
      return `<blockquote>${b.body.map((x) => renderBlock(x, env)).join('')}</blockquote>`;
    case 'hr':
      return '<hr>';
    case 'image': {
      const caption = b.caption ?? b.alt;
      // 캡션이 대체 글과 같으면 보조기술에는 한 번만 읽힌다(그림 이름 = 대체 글, 캡션은 aria-hidden).
      const capHidden = caption === b.alt;
      if (b.kind === 'figure') {
        const fig = loadFigure(b.name, env, b.line);
        if (fig === null) return '';
        env.figureCount += 1;
        const svg = figureSvg(fig, `f${String(env.figureCount)}`, b.alt);
        return `<figure class="bf fig"><div class="plate">${svg}</div><figcaption${capHidden && !fig.labelled ? ' aria-hidden="true"' : ''}>${escapeHtml(caption)}</figcaption></figure>`;
      }
      if (!env.shotIds.has(b.name)) {
        env.errors.push(`${env.file}:${String(b.line)}: 등록부에 없는 스크린샷 id "${b.name}" — src/site/blog/shots.ts 에 더한다(문서 등록부 id 도 쓸 수 있다)`);
      }
      if (!env.shots.includes(b.name)) env.shots.push(b.name);
      return `<figure class="bf shot"><!--shot:${b.name}:${b64url(b.alt)}--><figcaption${capHidden ? ' aria-hidden="true"' : ''}>${escapeHtml(caption)}</figcaption></figure>`;
    }
  }
}

// ── 읽는 시간 ────────────────────────────────────────────────────────────

/** 영어 230 단어/분 · 한국어 공백 뺀 500자/분. 1분 이상. 코드·그림 글자도 센다(읽는 사람이 훑는다). */
function readingMinutes(text: string, lang: BlogLang): number {
  if (lang === 'ko') return Math.max(1, Math.round(text.replace(/\s+/g, '').length / 500));
  return Math.max(1, Math.round((text.match(/\S+/g) ?? []).length / 230));
}

// ── 빌드 ─────────────────────────────────────────────────────────────────

export interface BlogBuildOptions {
  /** 초안까지 레코드에 싣는가(로컬 미리보기). `pnpm gen:blog` 는 거짓 — 공개 글만. */
  readonly drafts: boolean;
  /** 사이트 라우트(블로그 밖). */
  readonly sitePaths: ReadonlySet<string>;
  /** 문서 페이지·앵커. 생략하면 문서 값 파일에서. */
  readonly docs?: LinkContext['docs'];
  /** 스크린샷 등록부 id. 생략하면 블로그 + 문서 등록부. */
  readonly shotIds?: ReadonlySet<string>;
  /** 찍은 스크린샷 id(바이트가 있는 것). 생략하면 `blog-shot-data.ts`. */
  readonly shotImages?: ReadonlySet<string>;
}

export interface BlogBuild {
  /** 날짜 내림차순(같으면 slug) · 같은 slug 는 en 다음 ko. `drafts` 가 거짓이면 공개 글만. */
  readonly posts: readonly BlogPostRecord[];
  /** 공개 글(과 폴더 꼴)의 오류 — 비어야 `pnpm gen:blog` 가 통과한다. */
  readonly errors: readonly string[];
  /** 초안의 오류 — 보고만 한다(작성 중). */
  readonly draftErrors: readonly string[];
  readonly warnings: readonly string[];
}

function allShotIds(): Set<string> {
  return new Set([...Object.keys(BLOG_SHOTS), ...Object.keys(DOCS_SHOTS)]);
}

interface Parsed {
  readonly src: BlogSourceFile;
  readonly parsed: ParsedBlogSource | null;
  readonly todos: readonly number[];
  readonly error: string | null;
}

export function buildBlog(sources: BlogSources, options: BlogBuildOptions): BlogBuild {
  const errors: string[] = [...sources.problems];
  const draftErrors: string[] = [];
  const warnings: string[] = [];
  const docs = options.docs ?? docsIndex();
  const shotIds = options.shotIds ?? allShotIds();
  const shotImages = options.shotImages ?? new Set(Object.keys(BLOG_SHOT_IMAGES));

  const parsed: Parsed[] = sources.posts.map((src) => {
    const stripped = stripComments(src.text);
    try {
      return { src, parsed: parseBlogSource(stripped.text, src.file), todos: stripped.todos, error: null };
    } catch (error) {
      return { src, parsed: null, todos: stripped.todos, error: error instanceof BlogSyntaxError ? error.message : String(error) };
    }
  });
  // 머리말을 읽지 못한 글은 원문의 `draft:` 줄로 공개 여부를 가린다(공개하려던 글의 문법 오류를 초안 오류로 숨기지 않게) —
  // `draft:` 줄이 없거나 `true` 면 초안, 그 밖(`false` · 틀린 값)은 공개로 본다.
  const isDraft = (p: Parsed): boolean => {
    if (p.parsed !== null) return p.parsed.front.draft;
    const line = /^draft:[ \t]*(.*)$/m.exec(p.src.text.split('\n---')[0] ?? '');
    return line === null || /^["']?true["']?[ \t]*$/.test(line[1] ?? '');
  };
  const report = (p: Parsed, message: string): void => {
    (isDraft(p) ? draftErrors : errors).push(message);
  };

  // 블로그 경로 표(링크 검사) — 문법 오류로 읽지 못한 글은 초안으로 본다.
  const blogPaths = new Map<string, boolean>();
  for (const p of parsed) blogPaths.set(blogPostPath(p.src.lang, p.src.slug), isDraft(p));
  for (const lang of BLOG_LANGS) {
    const any = parsed.filter((p) => p.src.lang === lang);
    if (any.length > 0) blogPaths.set(blogIndexPath(lang), any.every(isDraft));
  }
  const links: LinkContext = { sitePaths: options.sitePaths, blogPaths, docs };

  // ko/en 짝.
  for (const p of parsed.filter((x) => x.src.lang === 'ko')) {
    const en = parsed.find((x) => x.src.slug === p.src.slug && x.src.lang === 'en');
    if (en === undefined) report(p, `${p.src.file}: 같은 slug 의 en.md 가 없다(영어가 먼저다)`);
    else if (!isDraft(p) && isDraft(en)) errors.push(`${p.src.file}: 영어(en.md)가 초안인데 한국어만 공개할 수 없다`);
  }

  const posts: BlogPostRecord[] = [];
  for (const p of parsed) {
    if (p.parsed === null) {
      report(p, p.error ?? `${p.src.file}: 읽지 못했다`);
      continue;
    }
    const { front, blocks } = p.parsed;
    if (!front.draft) for (const line of p.todos) errors.push(`${p.src.file}:${String(line)}: 공개 글에 TODO 주석이 남아 있다`);
    const env: RenderEnv = {
      lang: p.src.lang,
      draft: front.draft,
      file: p.src.file,
      links,
      figures: sources.figures,
      shotIds,
      errors: [],
      anchorsUsed: [],
      headingIds: new Set(),
      shots: [],
      figureCount: 0,
    };
    const body = blocks.map((b) => renderBlock(b, env)).join('');
    for (const { anchor, line } of env.anchorsUsed) {
      if (!env.headingIds.has(anchor)) env.errors.push(`${p.src.file}:${String(line)}: 글 안에 없는 앵커 #${anchor}`);
    }
    let cover: string | null = null;
    if (front.cover !== null) {
      const fig = loadFigure(front.cover, env, 1);
      if (fig !== null) cover = figureSvg(fig, `c-${p.src.slug}`, null);
    }
    const text = visibleText(`${body}`);
    const guard = copyGuardHits(`${front.title} ${front.description} ${text}`, COPY_GUARD_BANNED);
    if (guard.length > 0) env.errors.push(`${p.src.file}: copy-guard 금지어 — ${guard.join(', ')}`);
    for (const e of env.errors) report(p, e);
    for (const id of env.shots) if (shotIds.has(id) && !shotImages.has(id)) warnings.push(`${p.src.file}: 스크린샷 "${id}" 의 바이트가 아직 없다(pnpm gen:blog-images)`);
    const addresses = [...new Set([...text.matchAll(/([a-z0-9][a-z0-9._-]*)@atmark\.ai/gi)].map((m) => (m[1] ?? '').toLowerCase()))];
    const odd = addresses.filter((a) => !(EXAMPLE_RESERVED_LOCAL_PARTS as readonly string[]).includes(a) && !SERVICE_LOCAL_PARTS.includes(a));
    if (odd.length > 0) warnings.push(`${p.src.file}: 예시 예약 이름이 아닌 @atmark.ai 주소 — ${odd.map((a) => `${a}@`).join(', ')}(누군가 가질 수 있는 주소다)`);
    if (!front.draft) {
      const og = BLOG_OG_IMAGES[`${p.src.slug}/${p.src.lang}`];
      if (og === undefined) warnings.push(`${p.src.file}: OG 카드가 없다(pnpm gen:blog-images --og) — 사이트 공통 OG 로 대신한다`);
      else if (og.title !== front.title) warnings.push(`${p.src.file}: OG 카드의 제목이 낡았다(pnpm gen:blog-images --og)`);
    }
    if (front.draft && !options.drafts) continue;
    posts.push({
      slug: p.src.slug,
      lang: p.src.lang,
      title: front.title,
      description: front.description,
      date: front.date,
      updated: front.updated,
      author: front.author,
      tags: front.tags,
      draft: front.draft,
      minutes: readingMinutes(`${front.title} ${text}`, p.src.lang),
      shots: env.shots,
      body: Buffer.from(body, 'utf8').toString('base64'),
      cover: cover === null ? null : Buffer.from(cover, 'utf8').toString('base64'),
    });
  }
  posts.sort((a, b) => (a.date === b.date ? (a.slug === b.slug ? (a.lang === 'en' ? -1 : 1) : a.slug < b.slug ? -1 : 1) : a.date < b.date ? 1 : -1));
  return { posts, errors, draftErrors, warnings };
}

/** 실제 서비스 주소(글에서 문의처 등으로 말할 수 있다). */
const SERVICE_LOCAL_PARTS: readonly string[] = ['support', 'abuse', 'postmaster', 'onve'];

/** 생성 파일의 머리(머리말 + 레코드 모양). */
const BLOG_DATA_HEADER = "/**\n * 생성 파일 — 손으로 고치지 않는다. `pnpm gen:blog`(`scripts/gen-blog.ts`)가 블로그 글(`src/site/blog/posts/<slug>/<lang>.md`)을 검사하고\n * HTML 로 렌더해 쓴다. **공개 글(`draft: false`)만** 싣는다 — 초안은 운영 번들에 들어오지 않는다(로컬 미리보기는 원문에서 바로 만든다).\n * import 는 없다(값 파일). 본문·표지는 HTML 의 base64(UTF-8) — 글의 예시 문자열이 소스 트리의 문자열 리터럴이 되지 않게(문서 값 파일과 같은 이유).\n */\n\nexport interface BlogPostRecord {\n  readonly slug: string;\n  readonly lang: 'en' | 'ko';\n  readonly title: string;\n  readonly description: string;\n  readonly date: string;\n  readonly updated: string | null;\n  readonly author: string;\n  readonly tags: readonly string[];\n  readonly draft: boolean;\n  /** 읽는 시간(분, 1 이상). */\n  readonly minutes: number;\n  /** 본문이 싣는 스크린샷 id(등장 순, 중복 없음). */\n  readonly shots: readonly string[];\n  /** 본문 HTML 의 base64. 스크린샷 자리는 `<!--shot:<id>:<base64url 대체 글>-->`(사이트가 이미지 표로 채운다). */\n  readonly body: string;\n  /** 표지 그림(`<figure>` 인라인 SVG)의 base64 — 없으면 `null`. */\n  readonly cover: string | null;\n}\n\n";

/** 레코드 → `src/site/blog-data.ts` 본문(결정적). */
export function renderBlogDataFile(posts: readonly BlogPostRecord[]): string {
  const header = BLOG_DATA_HEADER;
  const item = (p: BlogPostRecord): string =>
    '  {\n' +
    `    slug: ${JSON.stringify(p.slug)},\n` +
    `    lang: ${JSON.stringify(p.lang)},\n` +
    `    title: ${JSON.stringify(p.title)},\n` +
    `    description: ${JSON.stringify(p.description)},\n` +
    `    date: ${JSON.stringify(p.date)},\n` +
    `    updated: ${JSON.stringify(p.updated)},\n` +
    `    author: ${JSON.stringify(p.author)},\n` +
    `    tags: ${JSON.stringify(p.tags)},\n` +
    `    draft: ${String(p.draft)},\n` +
    `    minutes: ${String(p.minutes)},\n` +
    `    shots: ${JSON.stringify(p.shots)},\n` +
    `    body: '${p.body}',\n` +
    `    cover: ${p.cover === null ? 'null' : `'${p.cover}'`},\n` +
    '  },\n';
  return `${header}export const BLOG_POSTS: readonly BlogPostRecord[] = [${posts.length === 0 ? '' : `\n${posts.map(item).join('')}`}];\n`;
}

/** 보고용 상대 경로. */
export function rel(path: string): string {
  return relative(REPO_ROOT, path);
}
