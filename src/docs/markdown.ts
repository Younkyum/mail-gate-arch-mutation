/**
 * src/docs/markdown.ts — 문서 콘텐츠(`src/docs/content/**`)의 **마크다운 부분집합** 파서. 결과는 구문 트리(AST)이고, HTML·`.md` 는
 * `render.ts` 가 만든다. 정해진 문법 밖은 **전부 오류**다(조용히 글자로 두지 않는다) — 특히 원시 HTML 은 코드 밖 어디서든 거부한다.
 *
 * 문법(작성자에게 보낸 명세 v1 — `docs/runbooks/docs.md` "쓰는 법"):
 *   - 머리말(`---` 사이 `key: value`): title · description(≤160) · group · order · updated(YYYY-MM-DD) · related([id, …]) · feature? · nav_title?.
 *     모르는 키는 오류.
 *   - 본문: `## `·`### ` 헤딩(끝에 `{#id}` 로 앵커 고정) · 문단 · **굵게** · *기울임* · `코드` · 링크 `[글](/그룹/슬러그#앵커)`·`(#앵커)`·
 *     `(https://…)`·`(mailto:…)` · 목록(`- `·`1. `, 두 칸 들여 한 단계) · 표(GFM 파이프) · 코드 펜스(```언어 title="…").
 *   - 지시어 `:::이름 [인자]` … `:::` (중첩 가능): note·tip·warning·danger(인자 = 제목) · steps(안에 `### 단계 제목`) ·
 *     cards(`- [제목](/id): 설명` 줄) · tabs(안에 `@tab 이름`) · details(인자 = 질문) · feature(인자 = 문서 플래그, 꺼져 있으면 숨김 · `!플래그` 는 거꾸로 꺼져 있을 때만 보임).
 *   - 줄 하나짜리: `![대체 글](shot:<id>)` 스크린샷 · `{{plan-limits}}` · `{{mcp-tools}}`.
 * import 가 없다(값·함수만) — 렌더러·빌드·테스트가 부른다.
 */

export class DocsSyntaxError extends Error {
  public constructor(
    public readonly file: string,
    public readonly line: number,
    detail: string,
  ) {
    super(`${file}:${String(line)}: ${detail}`);
    this.name = 'DocsSyntaxError';
  }
}

// ── 인라인 ────────────────────────────────────────────────────────────────

export type Inline =
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'code'; readonly v: string }
  | { readonly t: 'strong'; readonly c: readonly Inline[] }
  | { readonly t: 'em'; readonly c: readonly Inline[] }
  | { readonly t: 'link'; readonly href: string; readonly c: readonly Inline[]; readonly line: number };

const ESCAPABLE = new Set('\\`*_[](){}#+-.!|<>~:@'.split(''));

interface InlineResult {
  readonly nodes: Inline[];
  readonly end: number;
  readonly closed: boolean;
}

/** 인라인 한 줄(또는 이어 붙인 문단)을 파싱한다. `line` 은 오류 위치용. */
export function parseInline(src: string, file: string, line: number): Inline[] {
  return scan(src, 0, null, file, line).nodes;
}

function pushText(nodes: Inline[], text: string): void {
  if (text === '') return;
  const last = nodes[nodes.length - 1];
  if (last !== undefined && last.t === 'text') nodes[nodes.length - 1] = { t: 'text', v: last.v + text };
  else nodes.push({ t: 'text', v: text });
}

function scan(src: string, start: number, closer: '**' | '*' | ']' | null, file: string, line: number): InlineResult {
  const nodes: Inline[] = [];
  let i = start;
  const fail = (msg: string): never => {
    throw new DocsSyntaxError(file, line, msg);
  };
  while (i < src.length) {
    const ch = src[i] ?? '';
    const next = src[i + 1] ?? '';
    if (closer === '**' && ch === '*' && next === '*') return { nodes, end: i + 2, closed: true };
    if (closer === '*' && ch === '*' && next !== '*') return { nodes, end: i + 1, closed: true };
    if (closer === ']' && ch === ']') return { nodes, end: i + 1, closed: true };
    if (ch === '\\') {
      if (ESCAPABLE.has(next)) {
        pushText(nodes, next);
        i += 2;
        continue;
      }
      pushText(nodes, '\\');
      i += 1;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (src[i + run] === '`') run += 1;
      const fence = '`'.repeat(run);
      const close = src.indexOf(fence, i + run);
      if (close < 0) fail('닫히지 않은 인라인 코드(`)');
      let body = src.slice(i + run, close);
      if (body.startsWith(' ') && body.endsWith(' ') && body.trim() !== '') body = body.slice(1, -1);
      nodes.push({ t: 'code', v: body });
      i = close + run;
      continue;
    }
    if (ch === '*' && next === '*') {
      const inner = scan(src, i + 2, '**', file, line);
      if (!inner.closed) fail('닫히지 않은 **굵게**');
      if (inner.nodes.length === 0) fail('빈 **굵게**');
      nodes.push({ t: 'strong', c: inner.nodes });
      i = inner.end;
      continue;
    }
    if (ch === '*') {
      if (next === ' ' || next === '') {
        pushText(nodes, '*');
        i += 1;
        continue;
      }
      const inner = scan(src, i + 1, '*', file, line);
      if (!inner.closed) fail('닫히지 않은 *기울임* — 별표 글자는 \\* 로');
      nodes.push({ t: 'em', c: inner.nodes });
      i = inner.end;
      continue;
    }
    if (ch === '!' && next === '[') fail('인라인 이미지는 쓰지 않는다 — 스크린샷은 줄 하나에 ![대체 글](shot:<id>)');
    if (ch === '[') {
      const label = scan(src, i + 1, ']', file, line);
      if (label.closed && src[label.end] === '(') {
        const close = src.indexOf(')', label.end);
        if (close < 0) fail('닫히지 않은 링크 주소');
        const href = src.slice(label.end + 1, close);
        if (href === '' || /\s/.test(href)) fail(`링크 주소가 비었거나 공백이 있다: (${href})`);
        if (label.nodes.length === 0) fail('링크 글자가 비었다');
        if (label.nodes.some((n) => n.t === 'link')) fail('링크 안에 링크');
        nodes.push({ t: 'link', href, c: label.nodes, line });
        i = close + 1;
        continue;
      }
      pushText(nodes, '[');
      i += 1;
      continue;
    }
    if (ch === '<' && /[A-Za-z/!?]/.test(next)) fail('원시 HTML·자동 링크(<…>)는 쓸 수 없다');
    if (ch === '{' && next === '{') fail('{{…}} 자리표시는 줄 하나에 따로 쓴다');
    pushText(nodes, ch);
    i += 1;
  }
  return { nodes, end: i, closed: false };
}

/** 인라인 → 평문(검색·메타·목차용). */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : inlineText(n.c))).join('');
}

// ── 블록 ─────────────────────────────────────────────────────────────────

export type CalloutKind = 'note' | 'tip' | 'warning' | 'danger';
const CALLOUT_KINDS: readonly CalloutKind[] = ['note', 'tip', 'warning', 'danger'];
export type PlaceholderName = 'plan-limits' | 'mcp-tools';
const PLACEHOLDERS: readonly PlaceholderName[] = ['plan-limits', 'mcp-tools'];

export interface ListItem {
  readonly inline: readonly Inline[];
  readonly children: ListBlock | null;
}

export interface ListBlock {
  readonly t: 'list';
  readonly ordered: boolean;
  readonly items: readonly ListItem[];
}

export interface HeadingBlock {
  readonly t: 'heading';
  readonly level: 2 | 3;
  readonly inline: readonly Inline[];
  readonly explicitId: string | null;
  readonly line: number;
}

export interface StepItem {
  readonly title: readonly Inline[];
  readonly explicitId: string | null;
  readonly body: readonly Block[];
  readonly line: number;
}

export interface CardItem {
  readonly title: readonly Inline[];
  readonly href: string;
  readonly desc: readonly Inline[];
  readonly line: number;
}

export type Block =
  | HeadingBlock
  | { readonly t: 'para'; readonly inline: readonly Inline[] }
  | ListBlock
  | { readonly t: 'table'; readonly head: readonly (readonly Inline[])[]; readonly rows: readonly (readonly (readonly Inline[])[])[] }
  | { readonly t: 'code'; readonly lang: string; readonly title: string; readonly text: string }
  | { readonly t: 'callout'; readonly kind: CalloutKind; readonly title: readonly Inline[] | null; readonly body: readonly Block[] }
  | { readonly t: 'steps'; readonly items: readonly StepItem[] }
  | { readonly t: 'cards'; readonly items: readonly CardItem[] }
  | { readonly t: 'tabs'; readonly items: readonly { readonly label: string; readonly body: readonly Block[] }[] }
  | { readonly t: 'details'; readonly summary: readonly Inline[]; readonly body: readonly Block[] }
  | { readonly t: 'feature'; readonly flag: string; readonly body: readonly Block[]; readonly line: number }
  | { readonly t: 'shot'; readonly id: string; readonly alt: string; readonly line: number }
  | { readonly t: 'placeholder'; readonly name: PlaceholderName };

interface Line {
  readonly text: string;
  readonly no: number;
}

const DIRECTIVE_OPEN = /^:::([a-z]+)(?:[ \t]+(.*))?$/;
const DIRECTIVES = new Set(['note', 'tip', 'warning', 'danger', 'steps', 'cards', 'tabs', 'details', 'feature']);
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)(?:[ \t]+title="([^"]*)")?[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
const EXPLICIT_ID = /^(.*?)[ \t]*\{#([a-z0-9][a-z0-9-]*)\}$/;
const LIST_ITEM = /^( *)(?:([-*])|(\d+)\.)[ \t]+(.*)$/;
const SHOT_LINE = /^!\[([^\]]*)\]\(shot:([a-z0-9-]+)\)$/;
const PLACEHOLDER_LINE = /^\{\{([a-z-]+)\}\}$/;
const TABLE_SEP = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;

export interface ParseContext {
  readonly file: string;
}

/** 본문(머리말을 뗀 뒤)을 블록으로. `firstLine` = 본문 첫 줄의 파일 줄 번호. */
function parseBody(body: string, file: string, firstLine: number): Block[] {
  const lines: Line[] = body.split('\n').map((text, i) => ({ text: text.replace(/\r$/, ''), no: firstLine + i }));
  return parseBlocks(lines, { file }, 'top');
}

type Scope = 'top' | 'nested';

/** 지시어의 몸통 줄들 — 여는 줄 다음부터 짝이 맞는 `:::` 앞까지. 코드 펜스 안의 `:::` 는 세지 않는다. */
function collectDirective(lines: readonly Line[], start: number, ctx: ParseContext): { body: Line[]; next: number } {
  let depth = 1;
  let inFence = false;
  const body: Line[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const l = lines[i];
    if (l === undefined) break;
    const trimmed = l.text.trim();
    if (trimmed.startsWith('```')) inFence = !inFence;
    if (!inFence) {
      if (trimmed === ':::') {
        depth -= 1;
        if (depth === 0) return { body, next: i + 1 };
      } else if (DIRECTIVE_OPEN.test(trimmed)) depth += 1;
    }
    body.push(l);
  }
  throw new DocsSyntaxError(ctx.file, lines[start - 1]?.no ?? 0, '닫히지 않은 지시어(:::)');
}

/** 몸통을 `마커` 줄로 나눈다(단계의 `### `, 탭의 `@tab `). 중첩 지시어·코드 펜스 안의 마커는 세지 않는다. */
function splitByMarker(lines: readonly Line[], marker: RegExp, ctx: ParseContext, what: string): { head: Line; body: Line[] }[] {
  const parts: { head: Line; body: Line[] }[] = [];
  let depth = 0;
  let inFence = false;
  for (const l of lines) {
    const trimmed = l.text.trim();
    const atTop = depth === 0 && !inFence;
    if (trimmed.startsWith('```')) inFence = !inFence;
    else if (!inFence) {
      if (trimmed === ':::') depth -= 1;
      else if (DIRECTIVE_OPEN.test(trimmed)) depth += 1;
    }
    if (atTop && marker.test(l.text)) {
      parts.push({ head: l, body: [] });
      continue;
    }
    const current = parts[parts.length - 1];
    if (current === undefined) {
      if (trimmed !== '') throw new DocsSyntaxError(ctx.file, l.no, `${what} 안의 첫 줄은 ${marker.source} 여야 한다`);
      continue;
    }
    current.body.push(l);
  }
  if (parts.length === 0) throw new DocsSyntaxError(ctx.file, lines[0]?.no ?? 0, `빈 ${what}`);
  return parts;
}

function isBlockStart(text: string): boolean {
  const t = text.trim();
  return (
    t === '' ||
    t.startsWith('```') ||
    t.startsWith(':::') ||
    HEADING.test(t) ||
    LIST_ITEM.test(text) ||
    t.startsWith('|') ||
    SHOT_LINE.test(t) ||
    PLACEHOLDER_LINE.test(t) ||
    t.startsWith('@tab ')
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

function parseBlocks(lines: readonly Line[], ctx: ParseContext, scope: Scope): Block[] {
  const out: Block[] = [];
  let i = 0;
  const err = (l: Line | undefined, msg: string): never => {
    throw new DocsSyntaxError(ctx.file, l?.no ?? 0, msg);
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
    // 지시어
    if (t.startsWith(':::')) {
      const m = DIRECTIVE_OPEN.exec(t);
      if (m === null) err(l, t === ':::' ? '짝 없는 닫는 :::' : `지시어 꼴이 아니다: ${t}`);
      const name = m?.[1] ?? '';
      const arg = (m?.[2] ?? '').trim();
      if (!DIRECTIVES.has(name)) err(l, `모르는 지시어 :::${name}`);
      const { body, next } = collectDirective(lines, i + 1, ctx);
      out.push(parseDirective(name, arg, l, body, ctx));
      i = next;
      continue;
    }
    // 헤딩
    const h = HEADING.exec(t);
    if (h !== null) {
      const hashes = (h[1] ?? '').length;
      if (hashes === 1) err(l, '본문에 # 제목(h1)을 쓰지 않는다 — 제목은 머리말 title');
      if (hashes > 3) err(l, '#### 이하 헤딩은 쓰지 않는다');
      if (scope !== 'top') err(l, '지시어 안에는 헤딩을 쓰지 않는다(단계 제목 ### 은 :::steps 바로 안에서만)');
      const raw = h[2] ?? '';
      const idm = EXPLICIT_ID.exec(raw);
      const inlineSrc = idm === null ? raw : (idm[1] ?? '');
      out.push({ t: 'heading', level: hashes as 2 | 3, inline: parseInline(inlineSrc, ctx.file, l.no), explicitId: idm?.[2] ?? null, line: l.no });
      i += 1;
      continue;
    }
    // 스크린샷 · 자리표시
    const shot = SHOT_LINE.exec(t);
    if (shot !== null) {
      const alt = (shot[1] ?? '').trim();
      if (alt === '') err(l, '스크린샷에 대체 글이 없다');
      if (/[<>"&]/.test(alt)) err(l, '대체 글에 < > " & 를 쓰지 않는다');
      out.push({ t: 'shot', id: shot[2] ?? '', alt, line: l.no });
      i += 1;
      continue;
    }
    if (t.startsWith('![')) err(l, '이미지는 ![대체 글](shot:<id>) 꼴만 쓴다');
    const ph = PLACEHOLDER_LINE.exec(t);
    if (ph !== null) {
      const name = ph[1] ?? '';
      if (!(PLACEHOLDERS as readonly string[]).includes(name)) err(l, `모르는 자리표시 {{${name}}}`);
      out.push({ t: 'placeholder', name: name as PlaceholderName });
      i += 1;
      continue;
    }
    if (t.startsWith('@tab ')) err(l, '@tab 은 :::tabs 바로 안에서만');
    if (t.startsWith('>')) err(l, '인용(>)은 쓰지 않는다 — :::note 를 쓴다');
    // 표
    if (t.startsWith('|')) {
      const sep = lines[i + 1];
      if (sep === undefined || !TABLE_SEP.test(sep.text.trim())) err(l, '표는 머리 줄 다음에 |---| 구분 줄이 있어야 한다');
      const head = splitRow(text);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length; j += 1) {
        const rl = lines[j];
        if (rl === undefined || !rl.text.trim().startsWith('|')) break;
        const cells = splitRow(rl.text);
        if (cells.length !== head.length) err(rl, `표 칸 수가 머리(${String(head.length)})와 다르다(${String(cells.length)})`);
        rows.push(cells);
      }
      const lineOf = (k: number): number => lines[k]?.no ?? l.no;
      out.push({
        t: 'table',
        head: head.map((c) => parseInline(c, ctx.file, l.no)),
        rows: rows.map((r, k) => r.map((c) => parseInline(c, ctx.file, lineOf(i + 2 + k)))),
      });
      i = j;
      continue;
    }
    // 목록
    if (LIST_ITEM.test(text)) {
      const { list, next } = parseList(lines, i, ctx);
      out.push(list);
      i = next;
      continue;
    }
    if (/^\s{4,}\S/.test(text) && scope === 'top') err(l, '들여 쓴 코드 블록은 쓰지 않는다 — ``` 펜스를 쓴다');
    // 문단 — 빈 줄·다른 블록 시작까지
    const parts: string[] = [t];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const pl = lines[j];
      if (pl === undefined || isBlockStart(pl.text)) break;
      parts.push(pl.text.trim());
    }
    out.push({ t: 'para', inline: parseInline(parts.join(' '), ctx.file, l.no) });
    i = j;
  }
  return out;
}

function parseList(lines: readonly Line[], start: number, ctx: ParseContext): { list: ListBlock; next: number } {
  const first = lines[start];
  const m0 = first === undefined ? null : LIST_ITEM.exec(first.text);
  if (first === undefined || m0 === null) throw new DocsSyntaxError(ctx.file, first?.no ?? 0, '목록이 아니다');
  const baseIndent = (m0[1] ?? '').length;
  if (baseIndent !== 0) throw new DocsSyntaxError(ctx.file, first.no, '목록 첫 항목은 들여 쓰지 않는다');
  const ordered = m0[3] !== undefined;
  const items: { src: string; line: number; child: { ordered: boolean; items: { src: string; line: number }[] } | null }[] = [];
  let i = start;
  for (; i < lines.length; i += 1) {
    const l = lines[i];
    if (l === undefined || l.text.trim() === '') break;
    const m = LIST_ITEM.exec(l.text);
    if (m !== null) {
      const indent = (m[1] ?? '').length;
      const isOrdered = m[3] !== undefined;
      if (indent === 0) {
        if (isOrdered !== ordered) throw new DocsSyntaxError(ctx.file, l.no, '한 목록에 - 와 1. 을 섞지 않는다');
        items.push({ src: m[4] ?? '', line: l.no, child: null });
        continue;
      }
      if (indent >= 2 && indent <= 4) {
        const parent = items[items.length - 1];
        if (parent === undefined) throw new DocsSyntaxError(ctx.file, l.no, '들여 쓴 항목 앞에 부모 항목이 없다');
        if (parent.child === null) parent.child = { ordered: isOrdered, items: [] };
        else if (parent.child.ordered !== isOrdered) throw new DocsSyntaxError(ctx.file, l.no, '한 목록에 - 와 1. 을 섞지 않는다');
        parent.child.items.push({ src: m[4] ?? '', line: l.no });
        continue;
      }
      throw new DocsSyntaxError(ctx.file, l.no, '목록은 한 단계(두 칸)까지만 들여 쓴다');
    }
    if (isBlockStart(l.text) && !/^\s+/.test(l.text)) break;
    // 이어지는 줄 — 마지막 항목(또는 그 자식의 마지막 항목)에 붙인다.
    const parent = items[items.length - 1];
    if (parent === undefined) break;
    const target = parent.child?.items[parent.child.items.length - 1] ?? parent;
    target.src += ` ${l.text.trim()}`;
  }
  const list: ListBlock = {
    t: 'list',
    ordered,
    items: items.map((it) => ({
      inline: parseInline(it.src, ctx.file, it.line),
      children:
        it.child === null
          ? null
          : { t: 'list', ordered: it.child.ordered, items: it.child.items.map((c) => ({ inline: parseInline(c.src, ctx.file, c.line), children: null })) },
    })),
  };
  return { list, next: i };
}

const CARD_LINE = /^[-*][ \t]+\[([^\]]+)\]\(([^)\s]+)\):[ \t]*(.+)$/;

function parseDirective(name: string, arg: string, open: Line, body: Line[], ctx: ParseContext): Block {
  const err = (msg: string, l: Line = open): never => {
    throw new DocsSyntaxError(ctx.file, l.no, msg);
  };
  if ((CALLOUT_KINDS as readonly string[]).includes(name)) {
    const blocks = parseBlocks(body, ctx, 'nested');
    if (blocks.length === 0) err(`빈 :::${name}`);
    return { t: 'callout', kind: name as CalloutKind, title: arg === '' ? null : parseInline(arg, ctx.file, open.no), body: blocks };
  }
  if (name === 'details') {
    if (arg === '') err(':::details 에는 질문(요약) 글이 필요하다');
    const blocks = parseBlocks(body, ctx, 'nested');
    if (blocks.length === 0) err('빈 :::details');
    return { t: 'details', summary: parseInline(arg, ctx.file, open.no), body: blocks };
  }
  if (name === 'feature') {
    if (!/^!?[a-zA-Z-]+$/.test(arg)) err(':::feature 에는 문서 플래그 이름(또는 !이름)이 필요하다');
    return { t: 'feature', flag: arg, body: parseBlocks(body, ctx, 'nested'), line: open.no };
  }
  if (arg !== '') err(`:::${name} 는 인자를 받지 않는다`);
  if (name === 'steps') {
    const parts = splitByMarker(body, /^###[ \t]+\S/, ctx, ':::steps');
    return {
      t: 'steps',
      items: parts.map((p) => {
        const raw = p.head.text.replace(/^###[ \t]+/, '').trim();
        const idm = EXPLICIT_ID.exec(raw);
        const titleSrc = idm === null ? raw : (idm[1] ?? '');
        const blocks = parseBlocks(p.body, ctx, 'nested');
        return { title: parseInline(titleSrc, ctx.file, p.head.no), explicitId: idm?.[2] ?? null, body: blocks, line: p.head.no };
      }),
    };
  }
  if (name === 'tabs') {
    const parts = splitByMarker(body, /^@tab[ \t]+\S/, ctx, ':::tabs');
    const items = parts.map((p) => {
      const label = p.head.text.replace(/^@tab[ \t]+/, '').trim();
      if (/[<>&"`*[\]]/.test(label)) err('탭 이름은 꾸밈 없는 글자만', p.head);
      return { label, body: parseBlocks(p.body, ctx, 'nested') };
    });
    if (items.length < 2) err(':::tabs 에는 탭이 둘 이상 있어야 한다');
    return { t: 'tabs', items };
  }
  // cards
  const items: CardItem[] = [];
  for (const l of body) {
    const t = l.text.trim();
    if (t === '') continue;
    const m = CARD_LINE.exec(t);
    if (m === null) err('카드 줄은 - [제목](/id): 설명 꼴', l);
    items.push({
      title: parseInline(m?.[1] ?? '', ctx.file, l.no),
      href: m?.[2] ?? '',
      desc: parseInline(m?.[3] ?? '', ctx.file, l.no),
      line: l.no,
    });
  }
  if (items.length === 0) err('빈 :::cards');
  return { t: 'cards', items };
}

// ── 머리말 ───────────────────────────────────────────────────────────────

export interface FrontMatter {
  readonly title: string;
  readonly description: string;
  readonly group: string | null;
  readonly order: number | null;
  readonly updated: string | null;
  readonly related: readonly string[];
  readonly feature: string | null;
  readonly navTitle: string | null;
  /** 검색 동의어·다른 표현(본문에 없는 말로 찾는 사람을 위해). 화면에는 보이지 않고 검색 색인에만 들어간다. */
  readonly keywords: readonly string[];
}

const FRONT_KEYS = new Set(['title', 'description', 'group', 'order', 'updated', 'related', 'feature', 'nav_title', 'keywords']);
const DESCRIPTION_MAX = 160;

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

export interface ParsedSource {
  readonly front: FrontMatter;
  readonly blocks: readonly Block[];
}

/** 파일 전체 → 머리말 + 블록. `home` 이면 group·order·updated 가 없어도 된다. */
export function parseSource(source: string, file: string, home: boolean): ParsedSource {
  const text = source.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) throw new DocsSyntaxError(file, 1, '머리말(---)로 시작해야 한다');
  const end = text.indexOf('\n---\n', 3);
  const endAtEof = end < 0 && text.endsWith('\n---') ? text.length - 4 : end;
  if (endAtEof < 0) throw new DocsSyntaxError(file, 1, '닫히지 않은 머리말');
  const raw = text.slice(4, endAtEof);
  const values = new Map<string, string>();
  raw.split('\n').forEach((line, k) => {
    const no = k + 2;
    if (line.trim() === '' || line.trim().startsWith('#')) return;
    const m = /^([a-z_]+):[ \t]*(.*)$/.exec(line);
    if (m === null) throw new DocsSyntaxError(file, no, `머리말 줄은 key: value 꼴: ${line}`);
    const key = m[1] ?? '';
    if (!FRONT_KEYS.has(key)) throw new DocsSyntaxError(file, no, `모르는 머리말 키 ${key}`);
    if (values.has(key)) throw new DocsSyntaxError(file, no, `머리말 키가 두 번: ${key}`);
    values.set(key, (m[2] ?? '').replace(/[ \t]+#.*$/, '').trim());
  });
  const need = (key: string): string => {
    const v = values.get(key);
    if (v === undefined || unquote(v) === '') throw new DocsSyntaxError(file, 1, `머리말 ${key} 가 없다`);
    return unquote(v);
  };
  const title = need('title');
  const description = need('description');
  if ([...description].length > DESCRIPTION_MAX) throw new DocsSyntaxError(file, 1, `description 이 ${String(DESCRIPTION_MAX)}자를 넘는다`);
  for (const [k, v] of [['title', title], ['description', description]] as const) {
    if (/[<>]/.test(v)) throw new DocsSyntaxError(file, 1, `${k} 에 < > 를 쓰지 않는다`);
    if (/[*`[\]]/.test(v)) throw new DocsSyntaxError(file, 1, `${k} 는 꾸밈 없는 글자만(* \` [ ] 없음)`);
  }
  const orderRaw = values.get('order');
  const order = orderRaw === undefined ? null : Number(orderRaw);
  if (order !== null && (!Number.isInteger(order) || order < 0)) throw new DocsSyntaxError(file, 1, 'order 는 0 이상의 정수');
  const optional = (key: string): string | null => {
    const v = values.get(key);
    return v === undefined ? null : unquote(v);
  };
  const updated = optional('updated');
  if (updated !== null && !/^\d{4}-\d{2}-\d{2}$/.test(updated)) throw new DocsSyntaxError(file, 1, 'updated 는 YYYY-MM-DD');
  const listOf = (key: string): string[] => {
    const raw = values.get(key);
    if (raw === undefined || raw === '') return [];
    const m = /^\[(.*)\]$/.exec(raw);
    if (m === null) throw new DocsSyntaxError(file, 1, `${key} 는 [a, b] 꼴`);
    return (m[1] ?? '')
      .split(',')
      .map((s) => unquote(s))
      .filter((s) => s !== '');
  };
  const related = listOf('related');
  const keywords = listOf('keywords');
  for (const k of keywords) if (/[<>`*[\]]/.test(k)) throw new DocsSyntaxError(file, 1, `keywords 는 꾸밈 없는 글자만: ${k}`);
  const group = optional('group');
  const feature = optional('feature');
  const navTitle = optional('nav_title');
  if (!home) {
    if (group === null) throw new DocsSyntaxError(file, 1, '머리말 group 이 없다');
    if (order === null) throw new DocsSyntaxError(file, 1, '머리말 order 가 없다');
    if (updated === null) throw new DocsSyntaxError(file, 1, '머리말 updated 가 없다');
  }
  const bodyStart = endAtEof + 5;
  const body = text.slice(Math.min(bodyStart, text.length));
  const firstLine = text.slice(0, Math.min(bodyStart, text.length)).split('\n').length;
  return {
    front: { title, description, group, order, updated, related, feature, navTitle, keywords },
    blocks: parseBody(body, file, firstLine),
  };
}
