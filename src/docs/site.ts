/**
 * src/docs/site.ts — 콘텐츠 원문(`generated/content.json` — `pnpm gen:docs` 가 `src/docs/content/**` 에서 만든다) → 문서 사이트 전체:
 * 페이지(HTML·`.md`) · 검색 색인 · 크롤러 파일. 요청마다 달라지는 값이 없어 첫 요청에서 한 번 만든다(`http.ts` `docsRuntime()`).
 *
 * 빌드 검증(틀리면 던진다 — gen:docs·테스트·핸들러 첫 요청이 모두 같은 함수를 부른다):
 *   - 두 언어의 페이지 id 집합이 같다 · 머리말 group 이 알려진 그룹이고 id 의 첫 칸과 같다 · feature 가 알려진 문서 플래그다.
 *   - 내부 링크·카드·related 가 **보이는** 페이지와 그 앵커를 가리킨다(꺼진 기능 페이지로의 링크도 오류).
 *   - 스크린샷 id 가 등록부(`shots.ts`)에 있다.
 */

import { DOCS_FEATURES, DOCS_LANGS, DOCS_ORIGIN, docsHomePath, docsLangPrefix, isDocsFeature, type DocsFeature, type DocsLang } from './constants';
import { DOCS_SHOT_IMAGES } from './generated/shots';
import { buildDocPage, buildHomePage, type DocChromePage } from './layout';
import type { DocPage } from './types';
import { parseSource } from './markdown';
import { DOCS_MCP_TOOL_NAMES } from './mcp-tools';
import { GROUP_LABELS, GROUP_ORDER, isDocsGroup, tabOfGroup, type DocsGroup } from './nav';
import { planLimitsHtml, planLimitsMarkdown } from './plan-limits';
import { blocksMarkdown, escapeHtml, outline, renderBlocks, resetTabCounter, sections, type Section } from './render';
import { isDocsShotId } from './shots';

export const HOME_ID = 'index';

export type { DocPage } from './types';

export interface RenderedPage {
  readonly page: DocPage;
  readonly html: string;
  readonly csp: string;
  readonly markdown: string;
}

export interface SearchItem {
  /** 페이지 제목. */
  readonly t: string;
  /** 그룹 이름. */
  readonly g: string;
  /** 절 제목(페이지 머리 절이면 빈 글). */
  readonly h: string;
  /** 경로(+ #앵커). */
  readonly u: string;
  /** 본문 평문. */
  readonly x: string;
  /** 검색 동의어(머리말 `keywords`) — 페이지 머리 항목에만. */
  readonly k?: string;
}

export interface DocsSite {
  readonly pages: ReadonlyMap<string, RenderedPage>;
  readonly markdown: ReadonlyMap<string, string>;
  readonly ordered: Readonly<Record<DocsLang, readonly DocPage[]>>;
  readonly search: Readonly<Record<DocsLang, { readonly items: readonly SearchItem[]; readonly json: string; readonly path: string }>>;
  readonly missingShots: readonly string[];
  /** `strict: false` 일 때 모은 링크 오류(엄격 모드에서는 늘 비어 있다). */
  readonly problems: readonly string[];
}

function docPath(lang: DocsLang, id: string): string {
  return id === HOME_ID ? docsHomePath(lang) : `${docsLangPrefix(lang)}/${id}`;
}

function docMdPath(lang: DocsLang, id: string): string {
  return id === HOME_ID ? `${docsLangPrefix(lang)}/index.md` : `${docPath(lang, id)}.md`;
}

export type DocsSources = Readonly<Record<DocsLang, Readonly<Record<string, string>>>>;

interface Options {
  readonly features?: Readonly<Record<string, boolean>>;
  /**
   * 거짓이면 링크·related 오류에서 던지지 않고 모아 둔다(`DocsSite.problems`) — 작성 중 미리보기(`scripts/ui/docs-preview.ts`)용.
   * 문법 오류는 늘 던진다. 운영·테스트·gen:docs 는 기본값(참)이다.
   */
  readonly strict?: boolean;
}

function fileOf(lang: DocsLang, id: string): string {
  return `content/${lang}/${id}.md`;
}

/** 빌드 한 번. `sources` 는 언어 → id → 원문. */
export function buildDocsSite(sources: DocsSources, options: Options = {}): DocsSite {
  const features: Readonly<Record<string, boolean>> = options.features ?? DOCS_FEATURES;
  // `!이름` 은 그 플래그가 꺼져 있을 때만 보이는 절(예: SDK 게시 전의 "준비 중" 안내).
  const featureOn = (flag: string): boolean => (flag.startsWith('!') ? features[flag.slice(1)] !== true : features[flag] === true);
  // `{{plan-limits}}` 의 별칭·첨부 행도 같은 플래그를 따른다(페이지·절과 한 스위치).
  const limitFeatures = Object.fromEntries(Object.keys(DOCS_FEATURES).map((flag) => [flag, featureOn(flag)])) as Record<DocsFeature, boolean>;
  const problems: string[] = [];
  const problem = (message: string): string => {
    if (options.strict !== false) throw new Error(message);
    if (!problems.includes(message)) problems.push(message);
    return '#';
  };
  const ids = (lang: DocsLang): string[] => Object.keys(sources[lang]).sort();
  const koIds = ids('ko');
  const enIds = ids('en');
  const onlyKo = koIds.filter((id) => !enIds.includes(id));
  const onlyEn = enIds.filter((id) => !koIds.includes(id));
  if (onlyKo.length > 0 || onlyEn.length > 0) {
    throw new Error(`ko/en 페이지가 짝이 맞지 않는다 — 한국어만: [${onlyKo.join(', ')}] · 영어만: [${onlyEn.join(', ')}]`);
  }
  if (!koIds.includes(HOME_ID)) throw new Error('홈(content/{ko,en}/index.md)이 없다');

  // 1) 파싱 · 머리말 검증
  const all: Record<DocsLang, DocPage[]> = { ko: [], en: [] };
  for (const lang of DOCS_LANGS) {
    for (const id of ids(lang)) {
      if (!/^[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(id)) throw new Error(`${fileOf(lang, id)}: 페이지 id 는 소문자·숫자·- 로 된 한두 칸(그룹/슬러그)`);
      const file = fileOf(lang, id);
      const home = id === HOME_ID;
      const parsed = parseSource(sources[lang][id] ?? '', file, home);
      const { front } = parsed;
      let group: DocsGroup | null = null;
      if (!home) {
        const g = front.group ?? '';
        if (!isDocsGroup(g)) throw new Error(`${file}: 모르는 group ${g}`);
        if (id.includes('/') && id.split('/')[0] !== g) throw new Error(`${file}: 경로의 그룹(${id.split('/')[0] ?? ''})과 머리말 group(${g})이 다르다`);
        group = g;
      }
      if (front.feature !== null && !isDocsFeature(front.feature)) throw new Error(`${file}: 모르는 feature ${front.feature}`);
      all[lang].push({
        lang,
        id,
        file,
        path: docPath(lang, id),
        mdPath: docMdPath(lang, id),
        front,
        blocks: parsed.blocks,
        group,
        tab: group === null ? null : tabOfGroup(group),
        outline: outline(parsed.blocks, file, featureOn),
        updated: front.updated ?? '',
      });
    }
  }
  // 두 언어의 같은 페이지는 같은 그룹·feature 여야 한다(사이드바가 언어마다 달라지지 않게).
  for (const ko of all.ko) {
    const en = all.en.find((p) => p.id === ko.id);
    if (en === undefined) continue;
    if (en.group !== ko.group || en.front.feature !== ko.front.feature || en.front.order !== ko.front.order) {
      throw new Error(`${ko.id}: ko/en 머리말의 group·order·feature 가 다르다`);
    }
  }

  // 2) 보이는 페이지 · 순서
  const visible = (p: DocPage): boolean => p.front.feature === null || featureOn(p.front.feature);
  const ordered: Record<DocsLang, DocPage[]> = { ko: [], en: [] };
  for (const lang of DOCS_LANGS) {
    ordered[lang] = all[lang]
      .filter((p) => p.id !== HOME_ID && visible(p))
      .sort((a, b) => {
        const ga = GROUP_ORDER.indexOf(a.group ?? 'help');
        const gb = GROUP_ORDER.indexOf(b.group ?? 'help');
        return ga - gb || (a.front.order ?? 0) - (b.front.order ?? 0) || a.id.localeCompare(b.id);
      });
  }
  const byId = (lang: DocsLang): Map<string, DocPage> => new Map(all[lang].filter(visible).map((p) => [p.id, p]));
  const visibleById: Record<DocsLang, Map<string, DocPage>> = { ko: byId('ko'), en: byId('en') };

  // 3) 링크 해석
  const resolver =
    (page: DocPage, absolute: boolean) =>
    (href: string, line: number): string => {
      const where = `${page.file}:${String(line)}`;
      if (href.startsWith('https://')) {
        if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:[/?#][^\s"<>]*)?$/i.test(href)) return problem(`${where}: 이상한 외부 주소 ${href}`);
        return href;
      }
      if (href.startsWith('mailto:')) {
        if (!/^mailto:[^\s"<>@]+@[a-z0-9.-]+$/i.test(href)) return problem(`${where}: 이상한 mailto ${href}`);
        return href;
      }
      const base = absolute ? DOCS_ORIGIN : '';
      if (href.startsWith('#')) {
        const anchor = href.slice(1);
        if (!page.outline.ids.has(anchor)) return problem(`${where}: 이 페이지에 없는 앵커 ${href}`);
        return absolute ? `${DOCS_ORIGIN}${page.path}${href}` : href;
      }
      const m = /^\/((?:[a-z0-9-]+(?:\/[a-z0-9-]+)?)?)(?:#([^\s#]+))?$/.exec(href);
      if (m === null) return problem(`${where}: 내부 링크는 /그룹/슬러그[#앵커] 꼴(언어 접두어 없이) — ${href}`);
      const id = m[1] === '' || m[1] === undefined ? HOME_ID : m[1];
      if (id === 'en' || id.startsWith('en/')) return problem(`${where}: 내부 링크에 /en 을 쓰지 않는다(빌드가 붙인다) — ${href}`);
      const target = visibleById[page.lang].get(id);
      if (target === undefined) return problem(`${where}: 없는(또는 숨긴) 페이지로의 링크 ${href}`);
      const anchor = m[2];
      if (anchor !== undefined && !target.outline.ids.has(anchor)) return problem(`${where}: ${id} 에 없는 앵커 #${anchor}`);
      return `${base}${target.path}${anchor === undefined ? '' : `#${anchor}`}`;
    };

  // 4) 렌더
  const missingShots = new Set<string>();
  const shotHtml = (page: DocPage) => (id: string, alt: string, line: number): string => {
    if (!isDocsShotId(id)) {
      problem(`${page.file}:${String(line)}: 등록부(src/docs/shots.ts)에 없는 스크린샷 id ${id}`);
      return '';
    }
    const set = DOCS_SHOT_IMAGES[id]?.[page.lang];
    if (set === undefined) {
      missingShots.add(id);
      return '';
    }
    // 테마마다 한 장(스타일시트가 하나만 보인다). 누르면 원본 크기 파일이 열린다 · 대체 글은 보이는 캡션으로도 싣는다.
    const img = (theme: 'light' | 'dark'): string => {
      const s = set[theme];
      return (
        `<a class="shot-${theme}" href="${s.path}">` +
        `<img src="${s.path}" width="${String(s.width)}" height="${String(s.height)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async"></a>`
      );
    };
    return `<figure class="shot">${img('light')}${img('dark')}<figcaption>${escapeHtml(alt)}</figcaption></figure>`;
  };
  const shotMd = (lang: DocsLang) => (id: string, alt: string): string => {
    const s = DOCS_SHOT_IMAGES[id]?.[lang]?.light;
    return s === undefined ? '' : `![${alt}](${DOCS_ORIGIN}${s.path})`;
  };
  const placeholderHtml = (lang: DocsLang) => (name: 'plan-limits' | 'mcp-tools'): string =>
    name === 'plan-limits' ? planLimitsHtml(lang, limitFeatures) : `<ul class="tools">${DOCS_MCP_TOOL_NAMES.map((n) => `<li><code>${n}</code></li>`).join('')}</ul>`;
  const placeholderMd = (lang: DocsLang) => (name: 'plan-limits' | 'mcp-tools'): string =>
    name === 'plan-limits' ? planLimitsMarkdown(lang, limitFeatures) : DOCS_MCP_TOOL_NAMES.map((n) => `- \`${n}\``).join('\n');

  // 4-1) 검색 색인 — 페이지 HTML 이 색인 경로(내용 해시)를 싣으므로 먼저 만든다.
  const searchOf = (lang: DocsLang): DocsSite['search'][DocsLang] => {
    const items = ordered[lang].flatMap((page) => searchEntries(page, sections(page.blocks, page.outline, featureOn)));
    const json = JSON.stringify({ v: 1, lang, items });
    return { items, json, path: `/_search/${shortHash(json)}/${lang}.json` };
  };
  const search: DocsSite['search'] = { ko: searchOf('ko'), en: searchOf('en') };

  // 4-2) 페이지 HTML · .md
  const pages = new Map<string, RenderedPage>();
  const markdown = new Map<string, string>();
  for (const lang of DOCS_LANGS) {
    const list = ordered[lang];
    const home = all[lang].find((p) => p.id === HOME_ID);
    if (home === undefined) throw new Error('홈이 없다');
    for (const page of [home, ...list]) {
      resetTabCounter();
      const env = {
        lang,
        outline: page.outline,
        link: resolver(page, false),
        shot: shotHtml(page),
        placeholder: placeholderHtml(lang),
        featureOn,
      };
      const body = renderBlocks(page.blocks, env);
      const related = page.front.related.flatMap((rid) => {
        const target = visibleById[lang].get(rid);
        if (target === undefined || rid === HOME_ID) {
          problem(`${page.file}: related 에 없는(또는 숨긴) 페이지 ${rid}`);
          return [];
        }
        return [target];
      });
      const index = list.indexOf(page);
      const chrome: DocChromePage = {
        page,
        body,
        related,
        prev: index > 0 ? (list[index - 1] ?? null) : null,
        next: index >= 0 && index < list.length - 1 ? (list[index + 1] ?? null) : null,
        ordered: list,
        other: all[lang === 'ko' ? 'en' : 'ko'].find((p) => p.id === page.id) ?? null,
        searchPath: search[lang].path,
      };
      const built = page.id === HOME_ID ? buildHomePage(chrome) : buildDocPage(chrome);
      const mdEnv = { lang, outline: page.outline, link: resolver(page, true), shot: shotMd(lang), placeholder: placeholderMd(lang), featureOn };
      const md =
        `# ${page.front.title}\n\n> ${page.front.description}\n\n${blocksMarkdown(page.blocks, mdEnv)}\n\n---\n\n` +
        `${lang === 'ko' ? '원문' : 'Source'}: ${DOCS_ORIGIN}${page.path}` +
        (page.updated === '' ? '' : ` · ${lang === 'ko' ? '마지막 수정' : 'Last updated'} ${page.updated}`) +
        '\n';
      pages.set(page.path, { page, html: built.html, csp: built.csp, markdown: md });
      markdown.set(page.mdPath, md);
    }
  }

  return { pages, markdown, ordered, search, missingShots: [...missingShots].sort(), problems };
}

function searchEntries(page: DocPage, secs: readonly Section[]): SearchItem[] {
  const group = page.group === null ? '' : GROUP_LABELS[page.lang][page.group];
  const head = secs.find((s) => s.anchor === null);
  const keywords = page.front.keywords.join(' · ');
  const out: SearchItem[] = [
    { t: page.front.title, g: group, h: '', u: page.path, x: `${page.front.description} ${head?.text ?? ''}`.trim(), ...(keywords === '' ? {} : { k: keywords }) },
  ];
  for (const s of secs) {
    if (s.anchor === null) continue;
    out.push({ t: page.front.title, g: group, h: s.heading, u: `${page.path}#${s.anchor}`, x: s.text });
  }
  return out;
}

/** 짧은 내용 해시(FNV-1a 64 → 16 hex) — 색인 URL 을 내용에 묶는다(1년 immutable). 암호 강도는 필요 없다. */
function shortHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ── 검색(서버 — `/search?q=`) ─────────────────────────────────────────────
//
// 클라이언트(`script.ts`)와 **같은 규칙**이다(테스트가 같은 질의에 같은 순서를 단언한다):
//   - 질의를 공백으로 낱말로 나누고(최대 8), 모든 낱말이 제목·동의어·절 제목·본문 어딘가에 맞아야 한다.
//   - 한 낱말이 한 칸에 맞는 방법 셋: ① 그대로 포함 ② 공백을 뺀 채 포함("허용목록" ↔ "허용 목록") ③ 한글 세 글자 이상이면 **음절 2-gram**의
//     60% 이상이 그 칸에 있음("토큰교체" ↔ "토큰을 교체"). 무게: ①1 · ②0.8 · ③0.4×비율.
//   - 칸 무게: 제목 10 · 동의어 8 · 절 제목 5 · 본문 1. 제목·절 제목 어디에도 따로 맞지 않으면 둘을 이은 글에 6(낱말이 두 칸에 나뉜 경우).
//     페이지 머리 항목이 제목으로 모든 낱말을 맞히면 +5.
//   - 결과는 **페이지별로 묶는다** — 가장 잘 맞은 절 하나 + 같은 페이지의 다음 절 둘까지.

export interface SearchHit {
  readonly item: SearchItem;
  readonly score: number;
  readonly snippet: string;
}

export interface SearchGroup {
  /** 가장 잘 맞은 항목. */
  readonly best: SearchHit;
  /** 같은 페이지에서 더 맞은 절(최대 둘). */
  readonly more: readonly SearchHit[];
}

function normalizeQuery(q: string): string[] {
  return q
    .normalize('NFC')
    .toLowerCase()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .slice(0, 8);
}

interface Field {
  readonly plain: string;
  readonly compact: string;
  grams: Set<string> | null;
}

const HANGUL = /[\uac00-\ud7a3]/;

function field(text: string): Field {
  const plain = text.normalize('NFC').toLowerCase();
  return { plain, compact: plain.replace(/\s+/g, ''), grams: null };
}

function gramsOf(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < text.length; i += 1) out.push(text.slice(i, i + 2));
  return out;
}

/** 낱말 하나가 칸 하나에 얼마나 맞는가(0–1). */
function termMatch(f: Field, term: string): number {
  if (f.plain.includes(term)) return 1;
  const t = term.replace(/\s+/g, '');
  if (t !== '' && f.compact.includes(t)) return 0.8;
  if (t.length >= 3 && HANGUL.test(t)) {
    f.grams ??= new Set(gramsOf(f.compact));
    const grams = gramsOf(t);
    const hit = grams.filter((g) => f.grams?.has(g) === true).length / grams.length;
    if (hit >= 0.6) return 0.4 * hit;
  }
  return 0;
}

interface Prepared {
  readonly t: Field;
  readonly k: Field;
  readonly h: Field;
  readonly x: Field;
  /** 제목 + 절 제목 — 낱말이 두 칸에 나뉘어 있을 때("토큰" 제목 · "교체하기" 절 → "토큰교체"). */
  readonly th: Field;
}

const PREPARED = new WeakMap<SearchItem, Prepared>();

function prepared(item: SearchItem): Prepared {
  let p = PREPARED.get(item);
  if (p === undefined) {
    p = { t: field(item.t), k: field(item.k ?? ''), h: field(item.h), x: field(item.x), th: field(`${item.t} ${item.h}`) };
    PREPARED.set(item, p);
  }
  return p;
}

/** 모든 낱말이 맞는 항목과 점수(높은 순). */
export function searchDocs(items: readonly SearchItem[], query: string, limit = 60): SearchHit[] {
  const terms = normalizeQuery(query);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  items.forEach((item, order) => {
    const p = prepared(item);
    let score = 0;
    for (const term of terms) {
      const mt = termMatch(p.t, term);
      const mh = termMatch(p.h, term);
      const s = 10 * mt + 8 * termMatch(p.k, term) + 5 * mh + termMatch(p.x, term) + (mt === 0 && mh === 0 && item.h !== '' ? 6 * termMatch(p.th, term) : 0);
      if (s === 0) return;
      score += s;
    }
    if (item.h === '' && terms.every((term) => termMatch(p.t, term) > 0)) score += 5;
    hits.push({ item, score: Math.round(score * 100) * 10_000 - order, snippet: snippet(item.x, terms) });
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 페이지별로 묶는다 — 묶음의 순서는 가장 잘 맞은 항목의 순서. */
export function groupHits(hits: readonly SearchHit[], limit = 10): SearchGroup[] {
  const groups = new Map<string, { best: SearchHit; more: SearchHit[] }>();
  for (const hit of hits) {
    const page = hit.item.u.split('#')[0] ?? hit.item.u;
    const g = groups.get(page);
    if (g === undefined) groups.set(page, { best: hit, more: [] });
    // 페이지 머리 항목(절 제목 없음)은 덧붙이지 않는다 — 묶음 제목이 이미 그 페이지다.
    else if (g.more.length < 2 && hit.item.h !== '') g.more.push(hit);
  }
  return [...groups.values()].slice(0, limit);
}

export function snippet(text: string, terms: readonly string[]): string {
  const lower = text.normalize('NFC').toLowerCase();
  let at = -1;
  for (const term of terms) {
    at = lower.indexOf(term);
    if (at >= 0) break;
  }
  if (at < 0) return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  const start = Math.max(0, at - 40);
  return (start > 0 ? '…' : '') + text.slice(start, start + 140) + (start + 140 < text.length ? '…' : '');
}
