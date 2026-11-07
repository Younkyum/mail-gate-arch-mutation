/**
 * src/security/dlp/markup.ts — 발신 DLP 앞의 **마크업 정규화**(ADR-0016 결정 2 ④). 순수 · 한 번 훑기(상한 있는 정규식만).
 *
 * 왜: 비밀·코드를 HTML 로 쪼개면 패턴이 끊긴다 — `atk_agent_abc<span></span>def` · `atk&#95;agent_…` · `atk%5Fagent_…`. 받는 쪽 메일 앱은
 * 태그를 지우고 엔티티를 풀어 **이어진 문자열**을 보여 준다. DLP 도 그 보기로 본다.
 *
 *   1. 태그 제거 — `<이름 …>`·`</이름>`·`<!…>`(속성 512자까지). 바꿀 문자는 호출자가 고른다: 비밀·코드는 `''`(쪼갠 토큰을 잇는다),
 *      복사 지문은 `' '`(단어 경계를 지킨다 — `<p>a</p><p>b</p>` 가 `ab` 한 단어가 되지 않게).
 *   2. HTML 엔티티 — 숫자(`&#95;`·`&#x5F;`)와 흔한 이름(`&amp;`·`&lt;`·`&gt;`·`&quot;`·`&apos;`·`&nbsp;`). 두 번 푼다(`&amp;#95;` 이중 인코딩).
 *   3. 퍼센트 인코딩 — `%XX` 가 인쇄 가능 ASCII(0x21–0x7E)일 때만 푼다.
 *
 * **한계:** 이것은 메일 앱이 보여 주는 모양으로 맞추는 일이지 디코더가 아니다. base64 · 16진수 · 비 ASCII `%XX` 는 `decode.ts` 가 따로 풀어
 * 본다(2026-10-08). 뒤집기 · 접두사 생략 같은 변형은 여전히 풀지 않는다(`docs/security/encoding-limits.md`).
 */

export const MARKUP_TAG = /<\/?[A-Za-z][A-Za-z0-9-]{0,32}(?:[\s/][^<>]{0,512})?>/g;
/** `<!-- … -->`·`<!DOCTYPE …>` — 간격이 둘이 되지 않게 태그 정규식과 나눴다. */
export const MARKUP_DECLARATION = /<![^<>]{0,512}>/g;
export const HTML_ENTITY = /&(?:#([0-9]{1,7})|#[xX]([0-9A-Fa-f]{1,6})|(amp|lt|gt|quot|apos|nbsp));?/g;
export const PERCENT_ESCAPE = /%([0-9A-Fa-f]{2})/g;

/** ReDoS 감사용(`dlp-redos.test.ts`). */
export const MARKUP_AUDITED_PATTERNS: readonly { readonly name: string; readonly source: string }[] = [
  { name: 'MARKUP_TAG', source: MARKUP_TAG.source },
  { name: 'MARKUP_DECLARATION', source: MARKUP_DECLARATION.source },
  { name: 'HTML_ENTITY', source: HTML_ENTITY.source },
  { name: 'PERCENT_ESCAPE', source: PERCENT_ESCAPE.source },
];

const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(HTML_ENTITY, (match: string, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED[name] ?? match;
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16);
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return match;
    return String.fromCodePoint(cp);
  });
}

/** 마크업을 걷은 보기. `tagReplacement` 는 `''`(비밀·코드) 또는 `' '`(복사 지문). */
export function normalizeMarkup(text: string, tagReplacement: '' | ' '): string {
  const stripped = text.replace(MARKUP_TAG, tagReplacement).replace(MARKUP_DECLARATION, tagReplacement);
  const decoded = decodeEntities(decodeEntities(stripped));
  return decoded.replace(PERCENT_ESCAPE, (match: string, hex: string) => {
    const c = Number.parseInt(hex, 16);
    return c >= 0x21 && c <= 0x7e ? String.fromCharCode(c) : match;
  });
}
