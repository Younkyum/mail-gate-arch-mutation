/**
 * scripts/blog/figures.ts — 블로그 그림(`src/site/blog/figures/<이름>.svg`)을 검사하고 **인라인 SVG** 로 다시 쓴다.
 *
 * 왜 인라인인가: 그림은 `currentColor`·사이트 색 토큰(CSS 변수)을 따라 밝은·어두운 화면에서 같이 바뀌어야 한다. `<img src=…svg>` 로 실으면
 * SVG 가 페이지 스타일을 받지 못한다. 인라인 SVG 는 문서의 일부라 리소스 요청도 아니다(CSP `img-src` 와 무관).
 *
 * 페이지 CSP 는 닫혀 있다(`style-src` 는 해시 하나 · 스크립트는 해시만) — 그래서 그림 안에서는:
 *   - `<style>`·`style=""`·`<script>`·`on*=`·`<foreignObject>`·`<image>`·외부 `href` 를 **쓰지 않는다**(CSP 가 조용히 막거나 위험하다 → 오류).
 *   - 색은 **글자로 적지 않는다**: `fill`·`stroke` 속성 값은 `none` · `currentColor` · `url(#…)`(그림 안 마커·그라디언트 없이 — 마커만)뿐이고,
 *     나머지 색은 정해진 **칠 클래스**(`FIGURE_CLASSES` — 사이트 스타일시트 `.fig-svg .ink{fill:var(--gray-1000)}` 꼴)로 준다. 흑백이 강제된다.
 *   - 칠하는 요소(사각형·원·경로·글자 …)는 자기 또는 조상에 칠(`fill` 속성·칠 클래스)이 있어야 한다 — 없으면 SVG 기본값(검정)이 어두운
 *     화면에서 사라진다.
 *   - `id` 는 그림마다 접두어를 붙여 페이지 안에서 겹치지 않게 하고, `url(#id)`·`href="#id"` 를 같이 고친다.
 *   - 뿌리 `<svg>` 에는 `viewBox` 가 있어야 한다. `width`·`height` 는 그림의 최대 폭(CSS px)으로 남기고 화면이 좁으면 줄어든다.
 */

/** 그림 안에서 쓸 수 있는 클래스 — 사이트 스타일시트(`src/site/styles.ts` 블로그 절)가 정의한다. 이름과 뜻은 `src/site/blog/README.md`. */
const FIGURE_CLASSES = [
  // 칠(fill)
  'ink', // 잉크(글자색) 면
  'paper', // 떠오른 카드 면(흰색 · 어두운 화면에서 한 단 위)
  'band', // 옅은 띠 면
  'mute', // 보조 회색 면·글자
  // 선(stroke) — 칠은 없음(fill:none)
  'line', // 잉크 선
  'hair', // 가는 회색 선
  'soft', // 중간 회색 선
  // 선 꾸밈
  'dash',
  'thick',
  // 글자
  'label', // 13px 보통
  'small', // 11px 보조
  'title', // 15px 굵게
  'mono', // 고정폭
  'bold',
  'inv', // 잉크 면 위의 글자(바탕색)
  'end', // text-anchor:end
  'mid', // text-anchor:middle
] as const;

const PAINT_CLASSES = new Set(['ink', 'paper', 'band', 'mute', 'line', 'hair', 'soft', 'inv']);

const ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'defs',
  'marker',
  'use',
  'symbol',
]);

/** 칠이 필요한 요소(글자는 스타일시트가 기본으로 `currentColor` 를 준다). */
const PAINTED = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);

const NUMERIC = /^-?[0-9.]+(?:e-?\d+)?(?:px|%|em)?$/;
const NUMBER_LIST = /^[-0-9.,\s e]+$/;

/** 속성 → 값 검사. `true` 면 통과. */
const ATTRS: Readonly<Record<string, (v: string) => boolean>> = {
  viewBox: (v) => /^-?[0-9.]+(?:[\s,]+-?[0-9.]+){3}$/.test(v.trim()),
  xmlns: (v) => v === 'http://www.w3.org/2000/svg',
  width: (v) => NUMERIC.test(v),
  height: (v) => NUMERIC.test(v),
  x: (v) => NUMERIC.test(v),
  y: (v) => NUMERIC.test(v),
  x1: (v) => NUMERIC.test(v),
  y1: (v) => NUMERIC.test(v),
  x2: (v) => NUMERIC.test(v),
  y2: (v) => NUMERIC.test(v),
  cx: (v) => NUMERIC.test(v),
  cy: (v) => NUMERIC.test(v),
  r: (v) => NUMERIC.test(v),
  rx: (v) => NUMERIC.test(v),
  ry: (v) => NUMERIC.test(v),
  dx: (v) => NUMBER_LIST.test(v),
  dy: (v) => NUMBER_LIST.test(v),
  d: (v) => /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/.test(v),
  points: (v) => NUMBER_LIST.test(v),
  transform: (v) => /^(?:\s*(?:translate|scale|rotate|matrix|skewX|skewY)\([-0-9.,\s e]+\)\s*)+$/.test(v),
  fill: (v) => /^(?:none|currentColor|url\(#[A-Za-z][\w-]*\))$/.test(v),
  stroke: (v) => /^(?:none|currentColor)$/.test(v),
  'stroke-width': (v) => NUMERIC.test(v),
  'stroke-linecap': (v) => /^(?:butt|round|square)$/.test(v),
  'stroke-linejoin': (v) => /^(?:miter|round|bevel)$/.test(v),
  'stroke-dasharray': (v) => /^(?:none|[0-9.,\s]+)$/.test(v),
  'stroke-dashoffset': (v) => NUMERIC.test(v),
  'fill-rule': (v) => /^(?:nonzero|evenodd)$/.test(v),
  'clip-rule': (v) => /^(?:nonzero|evenodd)$/.test(v),
  opacity: (v) => /^(?:0|1|0?\.\d+)$/.test(v),
  'fill-opacity': (v) => /^(?:0|1|0?\.\d+)$/.test(v),
  'stroke-opacity': (v) => /^(?:0|1|0?\.\d+)$/.test(v),
  'vector-effect': (v) => v === 'non-scaling-stroke',
  'text-anchor': (v) => /^(?:start|middle|end)$/.test(v),
  'dominant-baseline': (v) => /^(?:auto|middle|central|hanging|alphabetic)$/.test(v),
  'font-size': (v) => NUMERIC.test(v),
  'font-weight': (v) => /^(?:normal|bold|[1-9]00)$/.test(v),
  'letter-spacing': (v) => NUMERIC.test(v),
  'marker-start': (v) => /^url\(#[A-Za-z][\w-]*\)$/.test(v),
  'marker-mid': (v) => /^url\(#[A-Za-z][\w-]*\)$/.test(v),
  'marker-end': (v) => /^url\(#[A-Za-z][\w-]*\)$/.test(v),
  markerWidth: (v) => NUMERIC.test(v),
  markerHeight: (v) => NUMERIC.test(v),
  markerUnits: (v) => /^(?:strokeWidth|userSpaceOnUse)$/.test(v),
  refX: (v) => NUMERIC.test(v),
  refY: (v) => NUMERIC.test(v),
  orient: (v) => /^(?:auto|auto-start-reverse|-?[0-9.]+)$/.test(v),
  preserveAspectRatio: (v) => /^[A-Za-z ]+$/.test(v),
  href: (v) => /^#[A-Za-z][\w-]*$/.test(v),
  role: (v) => v === 'img',
  'font-family': (v) => v === 'inherit',
  id: (v) => /^[A-Za-z][\w-]*$/.test(v),
  class: (v) => v.split(/\s+/).every((c) => (FIGURE_CLASSES as readonly string[]).includes(c)),
  'aria-hidden': (v) => v === 'true',
};

export class FigureError extends Error {
  public constructor(file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = 'FigureError';
  }
}

interface Node {
  readonly name: string;
  readonly attrs: [string, string][];
  readonly children: (Node | string)[];
}

const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

/** 작은 XML 파서 — 요소·속성(큰따옴표)·글자만. 주석·`<?xml?>` 은 버리고, 그 밖의 `<!…>`·CDATA 는 오류. */
function parse(svg: string, file: string): Node {
  let rest = svg.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  if (/<!/.test(rest)) throw new FigureError(file, 'DOCTYPE·CDATA 는 쓰지 않는다');
  const root: Node = { name: '#root', attrs: [], children: [] };
  const stack: Node[] = [root];
  const token = /^(?:<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+))/;
  while (rest.length > 0) {
    const m = token.exec(rest);
    if (m === null) throw new FigureError(file, `SVG 를 읽지 못했다(속성은 큰따옴표로): ${rest.slice(0, 40)}`);
    rest = rest.slice(m[0].length);
    const top = stack[stack.length - 1];
    if (top === undefined) throw new FigureError(file, '요소 짝이 맞지 않는다');
    if (m[5] !== undefined) {
      const textValue = m[5];
      if (textValue.replace(ENTITY, '').includes('&')) throw new FigureError(file, `모르는 엔티티: ${textValue.trim().slice(0, 30)}`);
      if (textValue.trim() !== '') {
        if (top.name !== 'text' && top.name !== 'tspan' && top.name !== 'title' && top.name !== 'desc') {
          throw new FigureError(file, `<${top.name}> 안에 글자가 있다`);
        }
        top.children.push(textValue);
      } else if (top.name === 'text' || top.name === 'tspan') {
        top.children.push(textValue);
      }
      continue;
    }
    const [, close, name = '', rawAttrs = '', selfClose] = m;
    if (close === '/') {
      if (top.name !== name) throw new FigureError(file, `짝이 안 맞는다: </${name}>(열린 것 <${top.name}>)`);
      stack.pop();
      continue;
    }
    if (!ELEMENTS.has(name)) throw new FigureError(file, `<${name}> 는 쓸 수 없다(쓸 수 있는 요소: ${[...ELEMENTS].join(', ')})`);
    const attrs: [string, string][] = [];
    for (const a of rawAttrs.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
      const key = a[1] ?? '';
      if (attrs.some(([k]) => k === key)) throw new FigureError(file, `속성이 겹친다: ${key}`);
      attrs.push([key, a[2] ?? '']);
    }
    const node: Node = { name, attrs, children: [] };
    top.children.push(node);
    if (selfClose !== '/') stack.push(node);
  }
  if (stack.length !== 1) throw new FigureError(file, '닫히지 않은 요소');
  const elements = root.children.filter((c): c is Node => typeof c !== 'string');
  if (elements.length !== 1 || elements[0]?.name !== 'svg') throw new FigureError(file, '뿌리는 <svg> 하나');
  return elements[0];
}

/** 검사 — 요소·속성 허용 목록, 칠 규칙. */
function check(node: Node, file: string, painted: boolean, ids: Set<string>): void {
  if (!ELEMENTS.has(node.name)) {
    throw new FigureError(file, `<${node.name}> 는 쓸 수 없다(쓸 수 있는 요소: ${[...ELEMENTS].join(', ')})`);
  }
  let hasPaint = painted;
  for (const [key, value] of node.attrs) {
    if (/^on/i.test(key)) throw new FigureError(file, `이벤트 속성 ${key} 는 쓸 수 없다(CSP)`);
    if (key === 'style') throw new FigureError(file, 'style="" 은 쓸 수 없다(CSP) — 칠 클래스를 쓴다');
    if (key === 'xlink:href') throw new FigureError(file, 'xlink:href 대신 href="#id"');
    if (key === 'aria-labelledby' || key === 'aria-describedby') {
      if (!/^[A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*)*$/.test(value)) throw new FigureError(file, `${key} 는 그림 안 id 목록`);
      continue;
    }
    if (key.startsWith('aria-') && key !== 'aria-hidden') throw new FigureError(file, `${key} 는 쓰지 않는다(aria-labelledby · aria-describedby · aria-hidden 만)`);
    const ok = ATTRS[key];
    if (ok === undefined) throw new FigureError(file, `<${node.name} ${key}> 속성은 쓸 수 없다`);
    if (!ok(value)) {
      const hint =
        key === 'fill' || key === 'stroke'
          ? ' — 색은 글자로 적지 않는다(none · currentColor 만). 회색·면 색은 칠 클래스(ink · paper · band · mute · line · hair · soft)로'
          : key === 'class'
            ? ` — 쓸 수 있는 클래스: ${FIGURE_CLASSES.join(' ')}`
            : '';
      throw new FigureError(file, `<${node.name} ${key}="${value}"> 값이 허용 밖${hint}`);
    }
    if (key === 'id') {
      if (ids.has(value)) throw new FigureError(file, `id 가 겹친다: ${value}`);
      ids.add(value);
    }
    if (key === 'fill') hasPaint = true;
    if (key === 'class' && value.split(/\s+/).some((c) => PAINT_CLASSES.has(c))) hasPaint = true;
  }
  if (PAINTED.has(node.name) && !hasPaint) {
    throw new FigureError(file, `<${node.name}> 에 칠이 없다 — fill="none"·fill="currentColor" 또는 칠 클래스를 단다(기본 검정은 어두운 화면에서 사라진다)`);
  }
  for (const child of node.children) if (typeof child !== 'string') check(child, file, hasPaint, ids);
}

function escapeAttr(v: string): string {
  return v.replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function serialize(node: Node, rename: (id: string) => string): string {
  const attrs = node.attrs
    .map(([k, v]) => {
      let value = v;
      if (k === 'id') value = rename(v);
      if (k === 'href') value = `#${rename(v.slice(1))}`;
      value = value.replace(/url\(#([A-Za-z][\w-]*)\)/g, (_, id: string) => `url(#${rename(id)})`);
      return ` ${k}="${escapeAttr(value)}"`;
    })
    .join('');
  const inner = node.children.map((c) => (typeof c === 'string' ? c.replace(/\s+/g, ' ') : serialize(c, rename))).join('');
  return inner === '' ? `<${node.name}${attrs}/>` : `<${node.name}${attrs}>${inner}</${node.name}>`;
}

export interface FigureSvg {
  /** 뿌리 `<svg>` 의 안쪽(id 는 아직 원래 이름 — 렌더러가 `prefixIds` 로 접두어를 붙인다). */
  readonly inner: string;
  /** 뿌리에 남기는 속성(칠·선·글꼴 기본값 · `aria-labelledby`), 앞에 공백이 붙은 문자열. */
  readonly rootAttrs: string;
  /** 뿌리가 그림 안 `<title>`·`<desc>` 로 이름을 갖는가(`aria-labelledby`) — 아니면 렌더러가 대체 글로 `aria-label` 을 단다. */
  readonly labelled: boolean;
  readonly viewBox: string;
  readonly width: string;
  readonly height: string;
}

/** 뿌리 `<svg>` 에 남기는 속성 — 자식이 물려받는 칠·선·글꼴 기본값과 이름표. 크기·`xmlns`·`role` 은 렌더러가 다시 단다. */
const ROOT_KEEP = new Set([
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'font-size',
  'font-weight',
  'font-family',
  'text-anchor',
  'aria-labelledby',
  'aria-describedby',
]);

/** SVG 원문 → 검사한 그림. 오류는 `FigureError`. */
export function sanitizeFigure(source: string, file: string): FigureSvg {
  const root = parse(source, file);
  check(root, file, false, new Set());
  const nested = (n: Node): boolean => n.children.some((c) => typeof c !== 'string' && (c.name === 'svg' || nested(c)));
  if (nested(root)) throw new FigureError(file, '<svg> 안에 <svg> 를 두지 않는다');
  const attr = (k: string): string | undefined => root.attrs.find(([key]) => key === k)?.[1];
  const viewBox = attr('viewBox');
  if (viewBox === undefined) throw new FigureError(file, '뿌리 <svg> 에 viewBox 가 없다');
  const [, , vw = '0', vh = '0'] = viewBox.trim().split(/[\s,]+/);
  const width = (attr('width') ?? vw).replace(/px$/, '');
  const height = (attr('height') ?? vh).replace(/px$/, '');
  if (!/^\d+(\.\d+)?$/.test(width) || !/^\d+(\.\d+)?$/.test(height)) throw new FigureError(file, '뿌리 width·height 는 px 숫자(또는 생략 — viewBox 크기)');
  const ids = new Set<string>();
  const collect = (n: Node): void => {
    for (const [k, v] of n.attrs) if (k === 'id') ids.add(v);
    for (const c of n.children) if (typeof c !== 'string') collect(c);
  };
  collect(root);
  const labelledBy = attr('aria-labelledby');
  for (const ref of [labelledBy, attr('aria-describedby')]) {
    for (const id of ref === undefined ? [] : ref.split(/\s+/)) if (!ids.has(id)) throw new FigureError(file, `aria-labelledby·describedby 가 없는 id 를 가리킨다: ${id}`);
  }
  for (const n of [root]) {
    const walk = (x: Node): void => {
      for (const [k, v] of x.attrs) {
        const refs = k === 'href' ? [v.slice(1)] : [...v.matchAll(/url\(#([A-Za-z][\w-]*)\)/g)].map((m) => m[1] ?? '');
        for (const id of refs) if (!ids.has(id)) throw new FigureError(file, `없는 id 를 가리킨다: #${id}`);
      }
      for (const c of x.children) if (typeof c !== 'string') walk(c);
    };
    walk(n);
  }
  const rootAttrs = root.attrs
    .filter(([k]) => ROOT_KEEP.has(k))
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
  return {
    inner: root.children.map((c) => (typeof c === 'string' ? '' : serialize(c, (id) => id))).join(''),
    rootAttrs,
    labelled: labelledBy !== undefined,
    viewBox: viewBox.trim(),
    width,
    height,
  };
}

/** 렌더 시 id 접두어(같은 그림을 한 페이지에 두 번 실어도 겹치지 않게) — `id` · `href="#…"` · `url(#…)` · `aria-labelledby`·`aria-describedby`. */
export function prefixIds(markup: string, prefix: string): string {
  return markup
    .replace(/\sid="([A-Za-z][\w-]*)"/g, (_, id: string) => ` id="${prefix}-${id}"`)
    .replace(/\shref="#([A-Za-z][\w-]*)"/g, (_, id: string) => ` href="#${prefix}-${id}"`)
    .replace(/url\(#([A-Za-z][\w-]*)\)/g, (_, id: string) => `url(#${prefix}-${id})`)
    .replace(/\s(aria-labelledby|aria-describedby)="([^"]*)"/g, (_, k: string, ids: string) => ` ${k}="${ids.split(/\s+/).map((id) => `${prefix}-${id}`).join(' ')}"`);
}
