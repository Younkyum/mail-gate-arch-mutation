/**
 * src/security/injection/match.ts — 룰 파일들이 함께 쓰는 선형 시간 매칭 도구. 어휘 적중 캐시(`Lexicon`)와
 * 정렬된 적중 목록 위의 이분 탐색(`nearest`). 원거리 동시 출현을 정규식 하나로 쓰면 이차 시간이 된다(`rules.ts` 머리말).
 */

export interface Span {
  readonly start: number;
  readonly end: number;
}

/** 어휘별 적중 목록 캐시 — 같은 본문에 원거리 룰 여럿이 같은 어휘를 쓴다. */
export class Lexicon {
  private readonly cache = new Map<string, Span[]>();
  constructor(private readonly text: string) {}

  /** `flags` — 다국어 어휘는 유니코드 글자 경계(`\p{L}`)를 쓰므로 `gu`. 이름이 캐시 열쇠다(같은 이름 = 같은 원문·플래그). */
  get(name: string, source: string, flags = 'g'): Span[] {
    const hit = this.cache.get(name);
    if (hit) return hit;
    const spans = allMatches(new RegExp(source, flags), this.text);
    this.cache.set(name, spans);
    return spans;
  }

  /** 정규식이 아니라 함수로 찾는 어휘(`unicodeEmails`) — 같은 캐시 규칙. */
  computed(name: string, find: (text: string) => Span[]): Span[] {
    const hit = this.cache.get(name);
    if (hit) return hit;
    const spans = find(this.text);
    this.cache.set(name, spans);
    return spans;
  }
}

export function allMatches(pattern: RegExp, text: string, limit = Number.POSITIVE_INFINITY): Span[] {
  const out: Span[] = [];
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (out.length < limit && (m = pattern.exec(text)) !== null) {
    const end = m.index + m[0].length;
    out.push({ start: m.index, end });
    // 빈 적중이면 한 칸 전진 — 그렇지 않으면 무한 루프다(`(?:^|\n)` 류).
    pattern.lastIndex = end > m.index ? end : m.index + 1;
  }
  return out;
}

/** 정렬된 목록에서 `start ∈ [from, to]` 인 첫 항목. 이분 탐색 — 원거리 짝짓기를 선형으로 만든다. */
export function nearest(spans: readonly Span[], from: number, to: number): Span | undefined {
  const found = spans[lowerBound(spans, from)];
  return found !== undefined && found.start <= to ? found : undefined;
}

export function lowerBound(spans: readonly Span[], from: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((spans[mid]?.start ?? 0) < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 이메일 주소 — 토큰 머리에서만 시작한다(`(?<![...])`). 없으면 시작점마다 64자를 훑는다. */
export const EMAIL = String.raw`(?<![a-z0-9._%+-])[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,6}`;

/**
 * 국제화 도메인(IDN) 주소 — 도메인에 비 ASCII 글자가 **하나 이상** 있는 것만(`drop@почта.рф`, `drop@例え.jp`). 접은 보기는 키릴 일부를 라틴으로
 * 바꾸지만 나머지 글자는 그대로라 `EMAIL`(ASCII)이 놓치던 목적지다(2026-10-08 인코딩 점검). ASCII 주소는 `EMAIL` 이 본다 — 겹치지 않는다.
 * `u` 플래그 없이 BMP 범위(`\u00a1-\uffff`)로 적는다(어휘 캐시가 `g` 로 컴파일한다). 마침표는 `.`·`。`·`．`.
 */
export const IDN_EMAIL = String.raw`(?<![a-z0-9._%+-])[a-z0-9._%+-]{1,64}@(?=[^\s@]{0,64}[\u00a1-\uffff])[a-z0-9\u00a1-\uffff-]{1,63}(?:[.\u3002\uff0e][a-z0-9\u00a1-\uffff-]{1,63}){1,6}`;

export const URL = String.raw`\b(?:https?|hxxps?):\/\/[^\s]{3,200}|\bwww\.[a-z0-9-]{1,63}\.[a-z]{2,10}`;

export const OBFUSCATED_EMAIL = String.raw`(?<![a-z0-9._-])[a-z0-9._-]{1,64}\s?(?:\[at\]|\(at\)|\sat\s)\s?[a-z0-9-]{1,63}\s?(?:\[dot\]|\(dot\)|\sdot\s)\s?[a-z]{2,10}\b`;

/**
 * 국제화 주소(EAI · RFC 6531) — 로컬 부분이나 도메인에 비 ASCII 글자가 있는 주소(`담당자@회사.한국`, `컨택트@example.net`). 기계 번역된 지시문은
 * 주소까지 음차해 쓴다. 정규식으로 쓰면 "글자 연속 속 어딘가의 비 ASCII" 가 시작점마다 이차 역추적이 된다 — 그래서 `@` 에서 양쪽으로 펼치는
 * 한 번 훑기다(선형: `@` 마다 좌우 상한 64·255자, `@` 상한 4,096개). ASCII 만인 주소는 `EMAIL` 이 본다(겹치지 않는다).
 */
const LOCAL_CHAR = /[\p{L}\p{N}._%+-]/u;
const DOMAIN_CHAR = /[\p{L}\p{N}-]/u;
const DOMAIN_DOT = new Set(['.', '\u3002', '\uff0e']);
export const UNICODE_EMAIL_SIGNATURE = 'unicode-email(@-expand,local<=64[\\p{L}\\p{N}._%+-],domain<=255 labels[\\p{L}\\p{N}-] dot[.。．]>=1,non-ascii-required,max-at=4096)';
export function unicodeEmails(text: string): Span[] {
  const out: Span[] = [];
  let from = 0;
  for (let n = 0; n < 4096; n += 1) {
    const at = text.indexOf('@', from);
    if (at === -1) break;
    from = at + 1;
    let start = at;
    while (start > 0 && at - start < 64 && LOCAL_CHAR.test(text[start - 1] ?? '')) start -= 1;
    let end = at + 1;
    let dots = 0;
    let lastDot = -1;
    while (end < text.length && end - at < 255) {
      const ch = text[end] ?? '';
      if (DOMAIN_CHAR.test(ch)) end += 1;
      else if (DOMAIN_DOT.has(ch) && end > lastDot + 1 && end > at + 1 && DOMAIN_CHAR.test(text[end + 1] ?? '')) {
        lastDot = end;
        dots += 1;
        end += 1;
      } else break;
    }
    if (start === at || dots === 0 || end <= lastDot + 1) continue;
    let nonAscii = false;
    for (let i = start; i < end; i += 1) if (text.charCodeAt(i) > 0x7e) nonAscii = true;
    if (nonAscii) out.push({ start, end });
  }
  return out;
}
