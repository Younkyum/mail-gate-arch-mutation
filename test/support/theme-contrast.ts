/**
 * 색 토큰 블록 파서와 WCAG 대비 계산 — 홈(`src/site/styles.ts`)과 콘솔(`src/admin/ui/styles.ts`)의 다크 모드 테스트가 같이 쓴다(US-014).
 *
 * 모듈이 내보내는 팔레트 객체를 믿지 않고 **렌더되는 CSS 문자열**에서 토큰 값을 다시 읽는다 — 브라우저가 실제로 받는 것이 그 문자열이다.
 * 토큰 블록은 세 개다: `:root{…}`(밝은 벌) · `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){…}}`(시스템 다크)
 * · `:root[data-theme="dark"]{…}`(명시 다크).
 */

export type Tokens = ReadonlyMap<string, string>;

export interface ThemeBlocks {
  readonly light: Tokens;
  readonly systemDark: Tokens;
  readonly forcedDark: Tokens;
  /** 세 블록을 뺀 나머지 CSS — 여기에는 색 값이 없어야 한다(주황도 없다). */
  readonly rest: string;
  /** 블록 안의 `color-scheme` 값 — [밝은, 시스템 다크, 명시 다크]. */
  readonly schemes: readonly [string, string, string];
}

const LIGHT_RE = /:root\{([^{}]*)\}/;
const SYSTEM_DARK_RE = /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\)\{([^{}]*)\}\}/;
const FORCED_DARK_RE = /:root\[data-theme="dark"\]\{([^{}]*)\}/;

function decls(body: string): { tokens: Map<string, string>; scheme: string } {
  const tokens = new Map<string, string>();
  let scheme = '';
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name.startsWith('--')) tokens.set(name.slice(2), value);
    else if (name === 'color-scheme') scheme = value;
  }
  return { tokens, scheme };
}

export function themeBlocks(css: string): ThemeBlocks {
  const light = LIGHT_RE.exec(css);
  const systemDark = SYSTEM_DARK_RE.exec(css);
  const forcedDark = FORCED_DARK_RE.exec(css);
  if (!light || !systemDark || !forcedDark) throw new Error('토큰 블록 세 개(밝은 · 시스템 다크 · 명시 다크)가 다 있어야 한다');
  const l = decls(light[1] ?? '');
  const s = decls(systemDark[1] ?? '');
  const f = decls(forcedDark[1] ?? '');
  const rest = css.replace(light[0], '').replace(systemDark[0], '').replace(forcedDark[0], '');
  return { light: l.tokens, systemDark: s.tokens, forcedDark: f.tokens, rest, schemes: [l.scheme, s.scheme, f.scheme] };
}

/** CSS 에서 쓰는 `var(--이름)` 전부. */
export function usedTokens(css: string): Set<string> {
  return new Set([...css.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1] ?? ''));
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** `#RRGGBB` 의 상대 휘도(WCAG 2.x). */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`#RRGGBB 가 아니다: ${hex}`);
  const n = parseInt(m[1] ?? '', 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(channel) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 대비비 — (밝은 + 0.05) / (어두운 + 0.05), 1–21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** 짝 하나 — 앞 토큰(글자·선)을 뒤 토큰(면) 위에. 토큰 이름 대신 `#RRGGBB` 를 직접 줄 수도 있다. */
export interface Pair {
  readonly label: string;
  readonly fg: string;
  readonly bg: string;
  readonly min: number;
}

export function resolve(tokens: Tokens, nameOrHex: string): string {
  if (nameOrHex.startsWith('#')) return nameOrHex;
  const v = tokens.get(nameOrHex);
  if (v === undefined) throw new Error(`토큰 --${nameOrHex} 가 없다`);
  return v;
}

/** 짝마다 [라벨, 대비비] — 표를 찍거나 단언할 때. */
export function ratios(tokens: Tokens, pairs: readonly Pair[]): Array<{ label: string; ratio: number; min: number }> {
  return pairs.map((p) => ({ label: p.label, ratio: contrast(resolve(tokens, p.fg), resolve(tokens, p.bg)), min: p.min }));
}
