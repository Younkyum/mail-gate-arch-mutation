/**
 * src/docs/render.ts — 구문 트리(`markdown.ts`) → ① HTML 조각(페이지 본문) ② 에이전트용 마크다운(`.md` 판·`llms-full.txt`)
 * ③ 앵커·목차 ④ 검색용 절(section) 평문.
 *
 * 규율: 글자는 전부 이스케이프한다(`escapeHtml`) — 콘텐츠가 만드는 마크업은 여기 정해진 태그뿐이다. `style=`·`on*=` 속성을 만들지 않는다
 * (CSP 가 막는다 — 테스트가 단언). 링크 주소는 빌드(`site.ts`)가 검증해 넘긴다(내부 링크는 있는 페이지·앵커만).
 */

import type { DocsLang } from './constants';
import { inlineText, type Block, type CalloutKind, type Inline, type PlaceholderName, type StepItem } from './markdown';

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 화살표 선 아이콘 — 홈 `ARROW_RIGHT_ICON` 과 같은 모양(선 1.5, 색은 스타일시트). */
export const ARROW_ICON =
  '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8h10M9 4l4 4-4 4"/></svg>';

const CALLOUT_LABELS: Readonly<Record<DocsLang, Readonly<Record<CalloutKind, string>>>> = {
  ko: { note: '참고', tip: '팁', warning: '주의', danger: '되돌릴 수 없음' },
  en: { note: 'Note', tip: 'Tip', warning: 'Warning', danger: 'Irreversible' },
};

const COPY_LABEL: Readonly<Record<DocsLang, string>> = { ko: '복사', en: 'Copy' };
const ANCHOR_LABEL: Readonly<Record<DocsLang, string>> = { ko: '이 절로 가는 링크', en: 'Link to this section' };
const TABLE_LABEL: Readonly<Record<DocsLang, string>> = { ko: '표', en: 'Table' };

// ── 앵커 ────────────────────────────────────────────────────────────────

export interface Anchor {
  readonly id: string;
  readonly level: number;
  readonly text: string;
}

export interface Outline {
  /** 헤딩·단계 노드 → 앵커. */
  readonly anchors: ReadonlyMap<object, Anchor>;
  /** 오른쪽 목차 — 본문 맨 위 층의 h2·h3(단계 제목이 h2·h3 이면 그것도). */
  readonly toc: readonly Anchor[];
  readonly ids: ReadonlySet<string>;
}

/** 헤딩 글자 → 앵커 id. 글자·숫자(한글 포함)만 남기고 나머지는 `-`. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** 보이는 블록(`feature` 가 꺼진 절은 없다고 본다)에 앵커를 준다. 단계 제목의 단계 = 앞선 헤딩 + 1(없으면 2). */
export function outline(blocks: readonly Block[], file: string, featureOn: (flag: string) => boolean): Outline {
  const anchors = new Map<object, Anchor>();
  const toc: Anchor[] = [];
  const ids = new Set<string>();
  const explicit = new Set<string>();
  const claim = (base: string, isExplicit: boolean, line: number): string => {
    if (isExplicit) {
      if (explicit.has(base) || ids.has(base)) throw new Error(`${file}:${String(line)}: 앵커 {#${base}} 가 겹친다`);
      explicit.add(base);
      ids.add(base);
      return base;
    }
    const root = base === '' ? 'section' : base;
    let id = root;
    for (let n = 2; ids.has(id); n += 1) id = `${root}-${String(n)}`;
    ids.add(id);
    return id;
  };
  // 명시 앵커를 먼저 예약한다 — 자동 앵커가 뒤에 오는 명시 앵커와 부딪혀 명시 쪽이 밀리지 않게.
  const reserve = (list: readonly Block[]): void => {
    for (const b of list) {
      if (b.t === 'feature' && !featureOn(b.flag)) continue;
      if (b.t === 'heading' && b.explicitId !== null) claim(b.explicitId, true, b.line);
      if (b.t === 'steps') for (const s of b.items) if (s.explicitId !== null) claim(s.explicitId, true, s.line);
      for (const child of childLists(b)) reserve(child);
    }
  };
  reserve(blocks);
  const walk = (list: readonly Block[], top: boolean, lastLevel: { v: number }): void => {
    for (const b of list) {
      if (b.t === 'feature') {
        if (featureOn(b.flag)) walk(b.body, top, lastLevel);
        continue;
      }
      if (b.t === 'heading') {
        const text = inlineText(b.inline).trim();
        const id = b.explicitId ?? claim(slugify(text), false, b.line);
        const a: Anchor = { id, level: b.level, text };
        anchors.set(b, a);
        if (top) toc.push(a);
        lastLevel.v = b.level;
        continue;
      }
      if (b.t === 'steps') {
        const level = Math.min(lastLevel.v === 0 ? 2 : lastLevel.v + 1, 4);
        for (const s of b.items) {
          const text = inlineText(s.title).trim();
          const id = s.explicitId ?? claim(slugify(text), false, s.line);
          const a: Anchor = { id, level, text };
          anchors.set(s, a);
          // 단계 제목은 오른쪽 목차에 넣지 않는다(목차가 절차의 낱낱으로 길어지지 않게) — 단계 묶음이 페이지 맨 위 층의 h2 일 때만 넣는다.
          if (top && level === 2) toc.push(a);
          walk(s.body, false, { v: level });
        }
        continue;
      }
      for (const child of childLists(b)) walk(child, false, { v: lastLevel.v });
    }
  };
  walk(blocks, true, { v: 0 });
  return { anchors, toc, ids };
}

function childLists(b: Block): (readonly Block[])[] {
  switch (b.t) {
    case 'callout':
    case 'details':
    case 'feature':
      return [b.body];
    case 'tabs':
    case 'steps':
      return b.items.map((i) => i.body);
    default:
      return [];
  }
}

// ── HTML ───────────────────────────────────────────────────────────────

export interface RenderEnv {
  readonly lang: DocsLang;
  readonly outline: Outline;
  /** 링크 주소 검증·해석(빌드가 준다). 틀리면 던진다. */
  readonly link: (href: string, line: number) => string;
  readonly shot: (id: string, alt: string, line: number) => string;
  readonly placeholder: (name: PlaceholderName) => string;
  readonly featureOn: (flag: string) => boolean;
}

export function renderInline(nodes: readonly Inline[], env: RenderEnv, allowLinks = true): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
          return escapeHtml(n.v);
        case 'code':
          return `<code>${escapeHtml(n.v)}</code>`;
        case 'strong':
          return `<strong>${renderInline(n.c, env, allowLinks)}</strong>`;
        case 'em':
          return `<em>${renderInline(n.c, env, allowLinks)}</em>`;
        case 'link': {
          if (!allowLinks) throw new Error(`${String(n.line)}: 링크 안(카드·요약)에는 링크를 쓰지 않는다`);
          return `<a href="${escapeHtml(env.link(n.href, n.line))}">${renderInline(n.c, env, false)}</a>`;
        }
      }
    })
    .join('');
}

let tabCounter = 0;

/** 헤딩 — 끝에 마우스를 올리면 보이는 `#` 링크(같은 절 주소를 복사해 나누기 좋게). 글자 `#` 은 보조기술에 읽히지 않고 링크 이름은 따로 준다. */
function headingTag(level: number, id: string, inner: string, lang: DocsLang): string {
  const tag = `h${String(Math.min(Math.max(level, 2), 4))}`;
  const safe = escapeHtml(id);
  return `<${tag} id="${safe}">${inner}<a class="ha" href="#${safe}" aria-label="${ANCHOR_LABEL[lang]}"><span aria-hidden="true">#</span></a></${tag}>`;
}

export function renderBlocks(blocks: readonly Block[], env: RenderEnv): string {
  return blocks.map((b) => renderBlock(b, env)).join('');
}

function renderList(b: Extract<Block, { t: 'list' }>, env: RenderEnv): string {
  const tag = b.ordered ? 'ol' : 'ul';
  return `<${tag}>${b.items
    .map((it) => `<li>${renderInline(it.inline, env)}${it.children === null ? '' : renderList(it.children, env)}</li>`)
    .join('')}</${tag}>`;
}

function renderBlock(b: Block, env: RenderEnv): string {
  const c = env.lang;
  switch (b.t) {
    case 'heading': {
      const a = env.outline.anchors.get(b);
      if (a === undefined) throw new Error('앵커 없는 헤딩');
      return headingTag(b.level, a.id, renderInline(b.inline, env), env.lang);
    }
    case 'para':
      return `<p>${renderInline(b.inline, env)}</p>`;
    case 'list':
      return renderList(b, env);
    case 'table': {
      const label = `${TABLE_LABEL[c]}: ${b.head.map((h) => inlineText(h)).join(' · ')}`;
      return (
        `<div class="tbl" role="region" tabindex="0" aria-label="${escapeHtml(label)}"><table>` +
        `<thead><tr>${b.head.map((h) => `<th scope="col">${renderInline(h, env)}</th>`).join('')}</tr></thead>` +
        `<tbody>${b.rows.map((r) => `<tr>${r.map((cell) => `<td>${renderInline(cell, env)}</td>`).join('')}</tr>`).join('')}</tbody>` +
        '</table></div>'
      );
    }
    case 'code': {
      const label = b.title !== '' ? b.title : b.lang;
      return (
        '<div class="code">' +
        `<div class="code-h"><span class="code-l">${escapeHtml(label)}</span>` +
        `<button type="button" class="copy" data-copy hidden>${COPY_LABEL[c]}</button></div>` +
        `<pre tabindex="0"><code>${escapeHtml(b.text)}</code></pre></div>`
      );
    }
    case 'callout': {
      // 제목이 있어도 종류 낱말(참고·주의 …)을 앞에 둔다 — 제목만 있으면 콜아웃의 무게를 글에서 알 수 없다.
      const kind = escapeHtml(CALLOUT_LABELS[c][b.kind]);
      const title = b.title === null ? kind : `${kind} · ${renderInline(b.title, env)}`;
      return `<div class="callout c-${b.kind}" role="note"><p class="c-t">${title}</p>${renderBlocks(b.body, env)}</div>`;
    }
    case 'steps':
      return `<ol class="steps">${b.items.map((s) => renderStep(s, env)).join('')}</ol>`;
    case 'cards':
      return (
        '<ul class="cards">' +
        b.items
          .map(
            (it) =>
              `<li><a class="card" href="${escapeHtml(env.link(it.href, it.line))}">` +
              `<span class="card-t">${renderInline(it.title, env, false)}${ARROW_ICON}</span>` +
              `<span class="card-d">${renderInline(it.desc, env, false)}</span></a></li>`,
          )
          .join('') +
        '</ul>'
      );
    case 'tabs': {
      tabCounter += 1;
      return (
        `<div class="tabs" data-tabs="${String(tabCounter)}">` +
        b.items.map((it) => `<div class="tab"><p class="tab-l">${escapeHtml(it.label)}</p>${renderBlocks(it.body, env)}</div>`).join('') +
        '</div>'
      );
    }
    case 'details':
      return `<details><summary>${renderInline(b.summary, env)}</summary><div class="dt-b">${renderBlocks(b.body, env)}</div></details>`;
    case 'feature':
      return env.featureOn(b.flag) ? renderBlocks(b.body, env) : '';
    case 'shot':
      return env.shot(b.id, b.alt, b.line);
    case 'placeholder':
      return env.placeholder(b.name);
  }
}

function renderStep(s: StepItem, env: RenderEnv): string {
  const a = env.outline.anchors.get(s);
  if (a === undefined) throw new Error('앵커 없는 단계');
  return `<li>${headingTag(a.level, a.id, renderInline(s.title, env), env.lang)}${renderBlocks(s.body, env)}</li>`;
}

/** 탭 id 가 페이지를 넘어 쌓이지 않게(결정적 출력) 페이지마다 되돌린다. */
export function resetTabCounter(): void {
  tabCounter = 0;
}

// ── 마크다운(.md 판) ──────────────────────────────────────────────────────

export interface MarkdownEnv {
  readonly lang: DocsLang;
  readonly outline: Outline;
  /** 절대 URL 로 해석(내부 링크 → https://docs.atmark.ai/…). */
  readonly link: (href: string, line: number) => string;
  readonly shot: (id: string, alt: string) => string;
  readonly placeholder: (name: PlaceholderName) => string;
  readonly featureOn: (flag: string) => boolean;
}

function codeSpan(v: string): string {
  let run = 1;
  for (const m of v.matchAll(/`+/g)) run = Math.max(run, m[0].length + 1);
  const fence = '`'.repeat(run);
  const pad = v.startsWith('`') || v.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${v}${pad}${fence}`;
}

function inlineMarkdown(nodes: readonly Inline[], env: MarkdownEnv): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
          return n.v;
        case 'code':
          return codeSpan(n.v);
        case 'strong':
          return `**${inlineMarkdown(n.c, env)}**`;
        case 'em':
          return `*${inlineMarkdown(n.c, env)}*`;
        case 'link':
          return `[${inlineMarkdown(n.c, env)}](${env.link(n.href, n.line)})`;
      }
    })
    .join('');
}

function listMarkdown(b: Extract<Block, { t: 'list' }>, env: MarkdownEnv, indent: string): string {
  return b.items
    .map((it, k) => {
      const mark = b.ordered ? `${String(k + 1)}.` : '-';
      const child = it.children === null ? '' : `\n${listMarkdown(it.children, env, `${indent}  `)}`;
      return `${indent}${mark} ${inlineMarkdown(it.inline, env)}${child}`;
    })
    .join('\n');
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => (l === '' ? '>' : `> ${l}`))
    .join('\n');
}

export function blocksMarkdown(blocks: readonly Block[], env: MarkdownEnv): string {
  return blocks
    .map((b) => blockMarkdown(b, env))
    .filter((s) => s !== '')
    .join('\n\n');
}

function blockMarkdown(b: Block, env: MarkdownEnv): string {
  switch (b.t) {
    case 'heading':
      return `${'#'.repeat(b.level)} ${inlineMarkdown(b.inline, env)}`;
    case 'para':
      return inlineMarkdown(b.inline, env);
    case 'list':
      return listMarkdown(b, env, '');
    case 'table': {
      const row = (cells: readonly (readonly Inline[])[]): string => `| ${cells.map((cell) => inlineMarkdown(cell, env).replace(/\|/g, '\\|')).join(' | ')} |`;
      return [row(b.head), `|${b.head.map(() => '---').join('|')}|`, ...b.rows.map(row)].join('\n');
    }
    case 'code':
      return `\`\`\`${b.lang}${b.title === '' ? '' : ` title="${b.title}"`}\n${b.text}\n\`\`\``;
    case 'callout': {
      const head = b.title === null ? CALLOUT_LABELS[env.lang][b.kind] : `${CALLOUT_LABELS[env.lang][b.kind]} · ${inlineMarkdown(b.title, env)}`;
      return quote(`**${head}**\n\n${blocksMarkdown(b.body, env)}`);
    }
    case 'steps':
      return b.items
        .map((s, k) => {
          const a = env.outline.anchors.get(s);
          const level = a?.level ?? 3;
          return `${'#'.repeat(level)} ${String(k + 1)}. ${inlineMarkdown(s.title, env)}${s.body.length === 0 ? '' : `\n\n${blocksMarkdown(s.body, env)}`}`;
        })
        .join('\n\n');
    case 'cards':
      return b.items.map((it) => `- [${inlineMarkdown(it.title, env)}](${env.link(it.href, it.line)}): ${inlineMarkdown(it.desc, env)}`).join('\n');
    case 'tabs':
      return b.items.map((it) => `**${it.label}**\n\n${blocksMarkdown(it.body, env)}`).join('\n\n');
    case 'details':
      return `**${inlineMarkdown(b.summary, env)}**\n\n${blocksMarkdown(b.body, env)}`;
    case 'feature':
      return env.featureOn(b.flag) ? blocksMarkdown(b.body, env) : '';
    case 'shot':
      return env.shot(b.id, b.alt);
    case 'placeholder':
      return env.placeholder(b.name);
  }
}

// ── 검색용 절 ─────────────────────────────────────────────────────────────

export interface Section {
  /** 절의 앵커(페이지 머리 절이면 `null`). */
  readonly anchor: string | null;
  readonly heading: string;
  readonly text: string;
}

/** 본문 → 절(헤딩·단계 제목에서 끊는다). 글자는 평문(마크업 없음). 꺼진 기능 절·자리표시는 빠진다. */
export function sections(blocks: readonly Block[], ol: Outline, featureOn: (flag: string) => boolean): Section[] {
  const out: { anchor: string | null; heading: string; parts: string[] }[] = [{ anchor: null, heading: '', parts: [] }];
  const cur = (): { parts: string[] } => out[out.length - 1] ?? { parts: [] };
  const start = (node: object): void => {
    const a = ol.anchors.get(node);
    if (a !== undefined) out.push({ anchor: a.id, heading: a.text, parts: [] });
  };
  const walk = (list: readonly Block[]): void => {
    for (const b of list) {
      switch (b.t) {
        case 'heading':
          start(b);
          break;
        case 'para':
          cur().parts.push(inlineText(b.inline));
          break;
        case 'list': {
          const texts: string[] = [];
          const items = (l: Extract<Block, { t: 'list' }>): void => {
            for (const it of l.items) {
              texts.push(inlineText(it.inline));
              if (it.children !== null) items(it.children);
            }
          };
          items(b);
          cur().parts.push(texts.join(' · '));
          break;
        }
        case 'table':
          // 칸·줄 사이를 ` · ` 로 — 검색 요약에서 칸이 한 낱말로 붙어 보이지 않게.
          cur().parts.push([...b.head, ...b.rows.flat()].map((c) => inlineText(c).trim()).filter((t) => t !== '').join(' · '));
          break;
        case 'code':
          cur().parts.push(b.text);
          break;
        case 'callout':
          if (b.title !== null) cur().parts.push(inlineText(b.title));
          walk(b.body);
          break;
        case 'steps':
          for (const s of b.items) {
            start(s);
            walk(s.body);
          }
          break;
        case 'cards':
          for (const it of b.items) cur().parts.push(`${inlineText(it.title)} ${inlineText(it.desc)}`);
          break;
        case 'tabs':
          for (const it of b.items) {
            cur().parts.push(it.label);
            walk(it.body);
          }
          break;
        case 'details':
          cur().parts.push(inlineText(b.summary));
          walk(b.body);
          break;
        case 'feature':
          if (featureOn(b.flag)) walk(b.body);
          break;
        case 'shot':
        case 'placeholder':
          break;
      }
    }
  };
  walk(blocks);
  return out
    .map((s) => ({ anchor: s.anchor, heading: s.heading, text: cleanText(s.parts.join(' ')) }))
    .filter((s) => s.anchor !== null || s.text !== '');
}

/** 검색 글 정리 — 공백 하나로, 점 줄임표(`···`·`⋯`)는 뺀다(요약에 장식 점이 남지 않게). */
function cleanText(text: string): string {
  return text
    .replace(/·{2,}|⋯/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
