/**
 * scripts/blog/markdown.ts — 블로그 글(`src/site/blog/posts/<slug>/<lang>.md`)의 **마크다운 부분집합** 파서. 결과는 구문 트리(AST)이고,
 * HTML 은 `render.ts` 가 만든다. 인라인 문법(굵게 · 기울임 · 코드 · 링크, 원시 HTML 거부)은 문서 파서(`src/docs/markdown.ts` `parseInline`)를
 * 그대로 쓴다 — 두 표면이 같은 인라인 규칙을 갖는다. 블록은 블로그 전용이다(인용 `>` · 그림 `figure:` · 가로줄 `---` 이 있고, 문서의
 * `:::` 지시어·`{{…}}` 자리표시는 없다). 정해진 문법 밖은 **전부 오류**다(조용히 글자로 두지 않는다).
 *
 * 블록:
 *   - `## `·`### ` 헤딩(끝에 `{#id}` 로 앵커 고정 — 없으면 글자에서 만든다). `#` 하나(h1)는 쓰지 않는다 — 제목은 머리말 `title`.
 *   - 문단 · 목록(`- `·`1. `, 두 칸 들여 한 단계) · 표(GFM 파이프, `:---:` 정렬) · 코드 펜스(```언어 [title="…"]) · 인용(`> `, 안에 문단·목록·코드)
 *     · 가로줄(`---`).
 *   - 줄 하나짜리 그림: `![대체 글](figure:<이름>)` — `src/site/blog/figures/<이름>.svg`(흑백 SVG, 인라인) ·
 *     `![대체 글](shot:<id>)` — 콘솔 스크린샷(`src/site/blog/shots.ts` 등록부 · 문서 등록부). 끝에 `"캡션"` 을 붙이면 캡션이 대체 글과 달라진다.
 * import 는 문서 파서의 인라인 함수뿐이다(값·함수만).
 */

import { DocsSyntaxError, parseInline, type Inline } from '../../src/docs/markdown';

export { DocsSyntaxError as BlogSyntaxError };
export type { Inline };

export interface BlogListItem {
  readonly inline: readonly Inline[];
  readonly children: BlogList | null;
}

export interface BlogList {
  readonly t: 'list';
  readonly ordered: boolean;
  readonly items: readonly BlogListItem[];
}

export type TableAlign = 'left' | 'center' | 'right' | null;

export type BlogBlock =
  | { readonly t: 'heading'; readonly level: 2 | 3; readonly inline: readonly Inline[]; readonly explicitId: string | null; readonly line: number }
  | { readonly t: 'para'; readonly inline: readonly Inline[] }
  | BlogList
  | {
      readonly t: 'table';
      readonly align: readonly TableAlign[];
      readonly head: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    }
  | { readonly t: 'code'; readonly lang: string; readonly title: string; readonly text: string }
  | { readonly t: 'quote'; readonly body: readonly BlogBlock[] }
  | { readonly t: 'image'; readonly kind: 'figure' | 'shot'; readonly name: string; readonly alt: string; readonly caption: string | null; readonly line: number }
  | { readonly t: 'hr' };

interface Line {
  readonly text: string;
  readonly no: number;
}

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)(?:[ \t]+title="([^"]*)")?[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
const EXPLICIT_ID = /^(.*?)[ \t]*\{#([a-z0-9][a-z0-9-]*)\}$/;
const LIST_ITEM = /^( *)(?:([-*])|(\d+)\.)[ \t]+(.*)$/;
/** `![대체 글](figure:이름)` · `![대체 글](shot:id "캡션")` — 줄 하나. */
const IMAGE_LINE = /^!\[([^\]]*)\]\((figure|shot):([a-z0-9-]+)(?:[ \t]+"([^"]*)")?\)$/;
const TABLE_SEP = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
const HR = /^(?:-[ \t]*){3,}$|^(?:\*[ \t]*){3,}$/;

type Scope = 'top' | 'quote';

/** 본문(머리말을 뗀 뒤)을 블록으로. `firstLine` = 본문 첫 줄의 파일 줄 번호. */
function parseBlogBody(body: string, file: string, firstLine: number): BlogBlock[] {
  const lines: Line[] = body.split('\n').map((text, i) => ({ text: text.replace(/\r$/, ''), no: firstLine + i }));
  return parseBlocks(lines, file, 'top');
}

function isBlockStart(text: string): boolean {
  const t = text.trim();
  return (
    t === '' ||
    t.startsWith('```') ||
    t.startsWith('>') ||
    HEADING.test(t) ||
    LIST_ITEM.test(text) ||
    t.startsWith('|') ||
    t.startsWith('![') ||
    HR.test(t)
  );
}

function splitRow(text: string): string[] {
  let t = text.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i] ?? '';
    if (ch === '\\' && t[i + 1] === '|') {
      cur += '\\|';
      i += 1;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function alignOf(cell: string): TableAlign {
  const c = cell.trim();
  const left = c.startsWith(':');
  const right = c.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function parseBlocks(lines: readonly Line[], file: string, scope: Scope): BlogBlock[] {
  const out: BlogBlock[] = [];
  let i = 0;
  const err = (l: Line | undefined, msg: string): never => {
    throw new DocsSyntaxError(file, l?.no ?? 0, msg);
  };
  while (i < lines.length) {
    const l = lines[i];
    if (l === undefined) break;
    const text = l.text;
    const t = text.trim();
    if (t === '') {
      i += 1;
      continue;
    }
    // 코드 펜스
    if (t.startsWith('```')) {
      const m = FENCE_OPEN.exec(t);
      if (m === null) err(l, '코드 펜스 여는 줄은 ```언어 [title="…"] 꼴');
      const indent = text.length - text.trimStart().length;
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j += 1) {
        const cl = lines[j];
        if (cl === undefined) break;
        if (cl.text.trim() === '```') {
          closed = true;
          break;
        }
        body.push(cl.text.slice(Math.min(indent, cl.text.length - cl.text.trimStart().length)));
      }
      if (!closed) err(l, '닫히지 않은 코드 펜스');
      out.push({ t: 'code', lang: m?.[1] ?? '', title: m?.[2] ?? '', text: body.join('\n') });
      i = j + 1;
      continue;
    }
    if (t.startsWith(':::')) err(l, '블로그 글에는 ::: 지시어를 쓰지 않는다(문서 전용) — 인용은 > 로');
    if (/^\{\{[a-z-]+\}\}$/.test(t)) err(l, '블로그 글에는 {{…}} 자리표시를 쓰지 않는다');
    // 인용 — 이어지는 `>` 줄을 모아 안쪽을 다시 블록으로.
    if (t.startsWith('>')) {
      if (scope === 'quote') err(l, '인용 안에 인용은 쓰지 않는다');
      const inner: Line[] = [];
      let j = i;
      for (; j < lines.length; j += 1) {
        const ql = lines[j];
        if (ql === undefined || !ql.text.trim().startsWith('>')) break;
        inner.push({ text: ql.text.trim().replace(/^>[ \t]?/, ''), no: ql.no });
      }
      const body = parseBlocks(inner, file, 'quote');
      if (body.length === 0) err(l, '빈 인용');
      out.push({ t: 'quote', body });
      i = j;
      continue;
    }
    // 가로줄
    if (HR.test(t)) {
      if (scope !== 'top') err(l, '인용 안에는 가로줄을 쓰지 않는다');
      out.push({ t: 'hr' });
      i += 1;
      continue;
    }
    // 헤딩
    const h = HEADING.exec(t);
    if (h !== null) {
      const hashes = (h[1] ?? '').length;
      if (hashes === 1) err(l, '본문에 # 제목(h1)을 쓰지 않는다 — 제목은 머리말 title');
      if (hashes > 3) err(l, '#### 이하 헤딩은 쓰지 않는다');
      if (scope !== 'top') err(l, '인용 안에는 헤딩을 쓰지 않는다');
      const raw = h[2] ?? '';
      const idm = EXPLICIT_ID.exec(raw);
      const inlineSrc = idm === null ? raw : (idm[1] ?? '');
      out.push({ t: 'heading', level: hashes as 2 | 3, inline: parseInline(inlineSrc, file, l.no), explicitId: idm?.[2] ?? null, line: l.no });
      i += 1;
      continue;
    }
    // 그림 · 스크린샷
    if (t.startsWith('![')) {
      const m = IMAGE_LINE.exec(t);
      if (m === null) err(l, '이미지는 줄 하나에 ![대체 글](figure:<이름>) 또는 ![대체 글](shot:<id>) 꼴만 쓴다(외부 이미지 없음)');
      if (scope !== 'top') err(l, '인용 안에는 그림을 쓰지 않는다');
      const alt = (m?.[1] ?? '').trim();
      const caption = m?.[4] === undefined ? null : m[4].trim();
      if (alt === '') err(l, '그림에 대체 글이 없다');
      for (const v of [alt, caption ?? '']) if (/[<>"&`*[\]]/.test(v)) err(l, '대체 글·캡션은 꾸밈 없는 글자만(< > " & ` * [ ] 없음)');
      if (caption === '') err(l, '빈 캡션 — 캡션을 대체 글과 같게 하려면 따옴표 부분을 지운다');
      out.push({ t: 'image', kind: (m?.[2] ?? 'figure') as 'figure' | 'shot', name: m?.[3] ?? '', alt, caption, line: l.no });
      i += 1;
      continue;
    }
    // 표
    if (t.startsWith('|')) {
      const sep = lines[i + 1];
      if (sep === undefined || !TABLE_SEP.test(sep.text.trim())) err(l, '표는 머리 줄 다음에 |---| 구분 줄이 있어야 한다');
      const head = splitRow(text);
      const align = splitRow(sep?.text ?? '').map(alignOf);
      if (align.length !== head.length) err(sep, `표 구분 줄 칸 수가 머리(${String(head.length)})와 다르다`);
      const rows: string[][] = [];
      const rowLines: number[] = [];
      let j = i + 2;
      for (; j < lines.length; j += 1) {
        const rl = lines[j];
        if (rl === undefined || !rl.text.trim().startsWith('|')) break;
        const cells = splitRow(rl.text);
        if (cells.length !== head.length) err(rl, `표 칸 수가 머리(${String(head.length)})와 다르다(${String(cells.length)})`);
        rows.push(cells);
        rowLines.push(rl.no);
      }
      if (rows.length === 0) err(l, '표에 몸통 줄이 없다');
      out.push({
        t: 'table',
        align,
        head: head.map((c) => parseInline(c, file, l.no)),
        rows: rows.map((r, k) => r.map((c) => parseInline(c, file, rowLines[k] ?? l.no))),
      });
      i = j;
      continue;
    }
    // 목록
    if (LIST_ITEM.test(text)) {
      const { list, next } = parseList(lines, i, file);
      out.push(list);
      i = next;
      continue;
    }
    if (/^\s{4,}\S/.test(text)) err(l, '들여 쓴 코드 블록은 쓰지 않는다 — ``` 펜스를 쓴다');
    // 문단 — 빈 줄·다른 블록 시작까지
    const parts: string[] = [t];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const pl = lines[j];
      if (pl === undefined || isBlockStart(pl.text)) break;
      parts.push(pl.text.trim());
    }
    out.push({ t: 'para', inline: parseInline(parts.join(' '), file, l.no) });
    i = j;
  }
  return out;
}

function parseList(lines: readonly Line[], start: number, file: string): { list: BlogList; next: number } {
  const first = lines[start];
  const m0 = first === undefined ? null : LIST_ITEM.exec(first.text);
  if (first === undefined || m0 === null) throw new DocsSyntaxError(file, first?.no ?? 0, '목록이 아니다');
  if ((m0[1] ?? '').length !== 0) throw new DocsSyntaxError(file, first.no, '목록 첫 항목은 들여 쓰지 않는다');
  const ordered = m0[3] !== undefined;
  type Raw = { src: string; line: number; child: { ordered: boolean; items: { src: string; line: number }[] } | null };
  const items: Raw[] = [];
  let i = start;
  for (; i < lines.length; i += 1) {
    const l = lines[i];
    if (l === undefined || l.text.trim() === '') break;
    const m = LIST_ITEM.exec(l.text);
    if (m !== null) {
      const indent = (m[1] ?? '').length;
      const isOrdered = m[3] !== undefined;
      if (indent === 0) {
        if (isOrdered !== ordered) throw new DocsSyntaxError(file, l.no, '한 목록에 - 와 1. 을 섞지 않는다');
        items.push({ src: m[4] ?? '', line: l.no, child: null });
        continue;
      }
      if (indent >= 2 && indent <= 4) {
        const parent = items[items.length - 1];
        if (parent === undefined) throw new DocsSyntaxError(file, l.no, '들여 쓴 항목 앞에 부모 항목이 없다');
        if (parent.child === null) parent.child = { ordered: isOrdered, items: [] };
        else if (parent.child.ordered !== isOrdered) throw new DocsSyntaxError(file, l.no, '한 목록에 - 와 1. 을 섞지 않는다');
        parent.child.items.push({ src: m[4] ?? '', line: l.no });
        continue;
      }
      throw new DocsSyntaxError(file, l.no, '목록은 한 단계(두 칸)까지만 들여 쓴다');
    }
    if (isBlockStart(l.text) && !/^\s+/.test(l.text)) break;
    const parent = items[items.length - 1];
    if (parent === undefined) break;
    const target = parent.child?.items[parent.child.items.length - 1] ?? parent;
    target.src += ` ${l.text.trim()}`;
  }
  const list: BlogList = {
    t: 'list',
    ordered,
    items: items.map((it) => ({
      inline: parseInline(it.src, file, it.line),
      children:
        it.child === null
          ? null
          : { t: 'list', ordered: it.child.ordered, items: it.child.items.map((c) => ({ inline: parseInline(c.src, file, c.line), children: null })) },
    })),
  };
  return { list, next: i };
}

// ── 머리말 ───────────────────────────────────────────────────────────────

const BLOG_DEFAULT_AUTHOR = "Younkyum 'Onve' Jin";
const BLOG_DESCRIPTION_MAX = 160;

export interface BlogFrontMatter {
  readonly title: string;
  readonly description: string;
  readonly date: string;
  readonly updated: string | null;
  readonly author: string;
  readonly tags: readonly string[];
  /** 기본 `true` — 명시적으로 `draft: false` 라고 적어야 공개된다. */
  readonly draft: boolean;
  readonly cover: string | null;
}

const FRONT_KEYS = new Set(['title', 'description', 'date', 'updated', 'author', 'tags', 'draft', 'cover']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** 달력에 있는 날인가(2026-02-30 거부). */
function isCalendarDate(iso: string): boolean {
  if (!ISO_DATE.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

export interface ParsedBlogSource {
  readonly front: BlogFrontMatter;
  readonly blocks: readonly BlogBlock[];
}

/** 파일 전체 → 머리말 + 블록. */
export function parseBlogSource(source: string, file: string): ParsedBlogSource {
  const text = source.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) throw new DocsSyntaxError(file, 1, '머리말(---)로 시작해야 한다');
  const end = text.indexOf('\n---\n', 3);
  const endAtEof = end < 0 && text.endsWith('\n---') ? text.length - 4 : end;
  if (endAtEof < 0) throw new DocsSyntaxError(file, 1, '닫히지 않은 머리말');
  const values = new Map<string, { value: string; line: number }>();
  text
    .slice(4, endAtEof)
    .split('\n')
    .forEach((line, k) => {
      const no = k + 2;
      if (line.trim() === '' || line.trim().startsWith('#')) return;
      const m = /^([a-z_]+):[ \t]*(.*)$/.exec(line);
      if (m === null) throw new DocsSyntaxError(file, no, `머리말 줄은 key: value 꼴: ${line}`);
      const key = m[1] ?? '';
      if (!FRONT_KEYS.has(key)) throw new DocsSyntaxError(file, no, `모르는 머리말 키 ${key}(쓸 수 있는 키: ${[...FRONT_KEYS].join(', ')})`);
      if (values.has(key)) throw new DocsSyntaxError(file, no, `머리말 키가 두 번: ${key}`);
      values.set(key, { value: (m[2] ?? '').replace(/[ \t]+#.*$/, '').trim(), line: no });
    });
  const lineOf = (key: string): number => values.get(key)?.line ?? 1;
  const need = (key: string): string => {
    const v = values.get(key);
    if (v === undefined || unquote(v.value) === '') throw new DocsSyntaxError(file, 1, `머리말 ${key} 가 없다`);
    return unquote(v.value);
  };
  const title = need('title');
  const description = need('description');
  if ([...description].length > BLOG_DESCRIPTION_MAX) {
    throw new DocsSyntaxError(file, lineOf('description'), `description 이 ${String(BLOG_DESCRIPTION_MAX)}자를 넘는다(${String([...description].length)}자)`);
  }
  for (const [k, v] of [['title', title], ['description', description]] as const) {
    if (/[<>]/.test(v)) throw new DocsSyntaxError(file, lineOf(k), `${k} 에 < > 를 쓰지 않는다`);
    if (/[*`[\]]/.test(v)) throw new DocsSyntaxError(file, lineOf(k), `${k} 는 꾸밈 없는 글자만(* \` [ ] 없음)`);
  }
  const date = need('date');
  if (!isCalendarDate(date)) throw new DocsSyntaxError(file, lineOf('date'), `date 는 YYYY-MM-DD(달력에 있는 날): ${date}`);
  const updatedRaw = values.get('updated');
  const updated = updatedRaw === undefined || unquote(updatedRaw.value) === '' ? null : unquote(updatedRaw.value);
  if (updated !== null && !isCalendarDate(updated)) throw new DocsSyntaxError(file, lineOf('updated'), `updated 는 YYYY-MM-DD: ${updated}`);
  if (updated !== null && updated < date) throw new DocsSyntaxError(file, lineOf('updated'), `updated(${updated}) 가 date(${date}) 보다 앞이다`);
  const authorRaw = values.get('author');
  const author = authorRaw === undefined || unquote(authorRaw.value) === '' ? BLOG_DEFAULT_AUTHOR : unquote(authorRaw.value);
  if (/[<>`*[\]]/.test(author)) throw new DocsSyntaxError(file, lineOf('author'), 'author 는 꾸밈 없는 글자만');
  const tagsRaw = values.get('tags');
  let tags: string[] = [];
  if (tagsRaw !== undefined && tagsRaw.value !== '') {
    const m = /^\[(.*)\]$/.exec(tagsRaw.value);
    if (m === null) throw new DocsSyntaxError(file, tagsRaw.line, 'tags 는 [a, b] 꼴');
    tags = (m[1] ?? '')
      .split(',')
      .map((s) => unquote(s))
      .filter((s) => s !== '');
    for (const tag of tags) if (/[<>"&`*[\]]/.test(tag) || tag.length > 32) throw new DocsSyntaxError(file, tagsRaw.line, `태그는 32자 이하의 꾸밈 없는 글자: ${tag}`);
    if (new Set(tags.map((x) => x.toLowerCase())).size !== tags.length) throw new DocsSyntaxError(file, tagsRaw.line, '태그가 겹친다');
  }
  const draftRaw = values.get('draft');
  let draft = true;
  if (draftRaw !== undefined) {
    const v = unquote(draftRaw.value);
    if (v !== 'true' && v !== 'false') throw new DocsSyntaxError(file, draftRaw.line, `draft 는 true 또는 false: ${v}`);
    draft = v === 'true';
  }
  const coverRaw = values.get('cover');
  const cover = coverRaw === undefined || unquote(coverRaw.value) === '' ? null : unquote(coverRaw.value);
  if (cover !== null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cover)) throw new DocsSyntaxError(file, lineOf('cover'), `cover 는 그림 이름(소문자·숫자·-): ${cover}`);
  const bodyStart = endAtEof + 5;
  const body = text.slice(Math.min(bodyStart, text.length));
  const firstLine = text.slice(0, Math.min(bodyStart, text.length)).split('\n').length;
  return {
    front: { title, description, date, updated, author, tags, draft, cover },
    blocks: parseBlogBody(body, file, firstLine),
  };
}
