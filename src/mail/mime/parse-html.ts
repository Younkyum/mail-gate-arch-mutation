/**
 * src/mail/mime/parse-html.ts — HTML 본문 → 텍스트 (`parse.ts` 전용).
 *
 * **목표는 렌더링 품질이 아니라 보존이다.** 가입 확인 메일의 확인 코드와 인증 링크가
 * 텍스트에 살아남아야 한다(AC-3). 그래서:
 *
 *   - `<a href>` 의 URL 은 라벨 뒤에 `(URL)` 로 남긴다. 버튼 모양 링크("인증하기")가
 *     라벨만 남기면 링크가 사라진다.
 *   - 스크립트·스타일·title·template 의 **내용**은 버린다. 메일 클라이언트가 보여 주지
 *     않는 텍스트이고, 남기면 CSS 가 확인 코드처럼 생긴 숫자(`#482913`)를 끼워 넣는다.
 *   - 숨김 요소(`display:none`)의 텍스트는 **남긴다.** 사람이 못 보는 곳이 지시문 탈취가
 *     숨는 곳이다 — P4 스캐너가 그 텍스트를 봐야 한다. 걸러 내는 것은 이 파일의 일이 아니다.
 *
 * **왜 postal-mime 의 변환을 쓰지 않는가.** 그쪽은 `<script>` 는 지우지만 `<style>` 은
 * `<head>` 밖에 있으면 CSS 를 본문으로 남긴다. 그리고 export 되지 않는다.
 *
 * ---------------------------------------------------------------------------
 * ## 선형 시간이어야 한다
 * ---------------------------------------------------------------------------
 *
 * 입력은 인터넷에서 온다. `<script` 만 10만 번 쓰고 닫지 않은 본문에 `<script>[\s\S]*?</script>`
 * 같은 정규식을 돌리면 여는 태그마다 끝까지 훑는다 — 이차 시간이고, 큐 소비자에게는
 * **타임아웃 = poison pill** 이다. 그래서 정규식 치환 대신 한 번 훑는 토크나이저로 쓴다:
 *
 *   - 닫히지 않은 `<script>`·`<style>`·주석은 **끝까지 버리고 멈춘다**(브라우저 렌더링과 같다).
 *   - `>` 가 더 없다는 사실은 한 번 알면 기억한다 — 이후의 `<` 는 전부 글자다.
 */

/** 내용까지 버리는 요소. 닫는 태그를 못 찾으면 문서 끝까지 버린다. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'title', 'template']);

/** 앞뒤로 줄을 바꾸는 요소. 줄이 없으면 `<p>123</p><p>456</p>` 이 `123456` 이 된다. */
const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'dd', 'div', 'dl', 'dt', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);

/** 셀 사이는 공백. 없으면 `<td>코드</td><td>482913</td>` 가 `코드482913` 이 된다. */
const CELL_ELEMENTS = new Set(['td', 'th']);

const TAG_NAME = /^(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)/;

/**
 * `DROP_WITH_CONTENT` 요소의 닫는 태그 뒤 위치. 닫히지 않았으면 `-1`(브라우저도 나머지를 렌더링하지 않는다).
 * `</script\b[^>]*>` 로 한 번에 찾지 않는다 — 뒤에 `>` 가 없으면 `[^>]*` 가 후보마다 끝까지 훑어 다시 이차 시간이 된다. 이름만 찾고 `>` 는 indexOf 한 번.
 */
function skipDropped(html: string, name: string, from: number): number {
  const closer = new RegExp(`</${name}\\b`, 'gi');
  closer.lastIndex = from;
  const found = closer.exec(html);
  const closerEnd = found === null ? -1 : html.indexOf('>', found.index);
  return closerEnd === -1 ? -1 : closerEnd + 1;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', times: '×', zwnj: '\u200c',
  zwj: '\u200d', shy: '\u00ad',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      // 서로게이트·범위 밖은 대체 문자. `String.fromCodePoint` 가 던지게 두면 본문 하나가
      // 파싱 전체를 죽인다.
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\ufffd';
      return String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** 원문의 공백·개행은 HTML 에서 공백 하나다. 줄바꿈은 태그가 만든다. */
function appendText(out: string[], raw: string): void {
  if (raw === '') return;
  out.push(decodeEntities(raw.replace(/[\t\n\f\r ]+/g, ' ')));
}

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function hrefOf(tagBody: string): string | null {
  const match = HREF.exec(tagBody);
  const href = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
  // 페이지 안 앵커와 스크립트 URL 은 정보가 아니다. `javascript:` 를 텍스트로 옮기면
  // 에이전트가 그것을 "링크" 로 읽는다.
  if (href === '' || href.startsWith('#') || /^javascript:/i.test(href)) return null;
  return decodeEntities(href);
}

/** HTML → 텍스트. 결과의 공백은 정리돼 있다(줄 끝 공백 없음, 빈 줄 최대 1개). */
export function htmlToText(html: string): string {
  const out: string[] = [];
  /** 열린 `<a>` — 브라우저처럼 중첩을 허용하지 않는다(새 `<a>` 가 이전 것을 닫는다). */
  let anchor: { readonly href: string | null; readonly start: number } | null = null;
  /** 다음 `>` 의 위치. `-1` 이면 문서 끝까지 `>` 가 없다. */
  let nextGt = -2;
  let index = 0;

  const closeAnchor = (): void => {
    if (anchor === null) return;
    const { href, start } = anchor;
    anchor = null;
    if (href === null) return;
    const label = out.slice(start).join('').trim();
    // 라벨이 URL 그 자체면 두 번 쓰지 않는다.
    if (label !== href) out.push(` (${href}) `);
  };

  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) {
      appendText(out, html.slice(index));
      break;
    }
    appendText(out, html.slice(index, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) break; // 닫히지 않은 주석 — 나머지는 전부 주석이다.
      index = end + 3;
      continue;
    }

    if (nextGt !== -1 && nextGt < lt) nextGt = html.indexOf('>', lt);
    if (nextGt === -1) {
      // 더 이상 태그가 없다. 남은 `<` 는 글자다.
      appendText(out, html.slice(lt));
      break;
    }

    const tagBody = html.slice(lt + 1, nextGt);
    const nameMatch = TAG_NAME.exec(tagBody);
    if (nameMatch === null) {
      if (tagBody.startsWith('!') || tagBody.startsWith('?')) {
        index = nextGt + 1; // <!DOCTYPE>, <?xml?> — 선언이다.
      } else {
        appendText(out, '<'); // "3 < 5" 의 `<` 다.
        index = lt + 1;
      }
      continue;
    }

    const closing = nameMatch[1] === '/';
    const name = (nameMatch[2] ?? '').toLowerCase();
    index = nextGt + 1;

    if (!closing && DROP_WITH_CONTENT.has(name)) {
      index = skipDropped(html, name, index);
      if (index === -1) break;
      continue;
    }

    if (name === 'a') {
      closeAnchor();
      if (!closing) anchor = { href: hrefOf(tagBody), start: out.length };
      continue;
    }
    if (name === 'br' || BLOCK_ELEMENTS.has(name)) {
      out.push('\n');
    } else if (CELL_ELEMENTS.has(name)) {
      out.push(' ');
    }
  }
  closeAnchor();

  return out
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// 숨긴 글(2026-10-08 인코딩 점검 — 숨김 신호)
// ---------------------------------------------------------------------------

const MAX_HIDDEN_STACK = 512;
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const STYLE_ATTR = /\bstyle\s*=\s*(?:"([^"]{0,2048})"|'([^']{0,2048})')/i;
const HIDDEN_ATTR = /(?:^|\s)hidden(?:\s|=|$)/i;
const ARIA_HIDDEN = /\baria-hidden\s*=\s*["']?true\b/i;

function styleOf(tagBody: string): Map<string, string> {
  const match = STYLE_ATTR.exec(tagBody);
  const out = new Map<string, string>();
  const style = decodeEntities(match?.[1] ?? match?.[2] ?? '');
  for (const decl of style.split(';')) {
    const colon = decl.indexOf(':');
    if (colon <= 0) continue;
    out.set(decl.slice(0, colon).trim().toLowerCase(), decl.slice(colon + 1).replace(/!important/i, '').trim().toLowerCase());
  }
  return out;
}

const NAMED_COLORS: Readonly<Record<string, string>> = { white: '#ffffff', black: '#000000', '#fff': '#ffffff', '#000': '#000000' };

function normalizeColor(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  const v = value.replace(/\s+/g, '');
  const rgb = /^rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})(?:,[\d.]{1,6})?\)$/.exec(v);
  if (rgb !== null) return `#${[rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short !== null) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return NAMED_COLORS[v] ?? (/^#[0-9a-f]{6}$/.test(v) ? v : null);
}

function zeroLength(value: string | undefined): boolean {
  return value !== undefined && /^0(?:\.0{1,4})?(?:px|em|rem|pt|%)?$/.test(value);
}

/** 이 태그가 스스로 숨기는가(부모와 무관하게). */
export function hidesItself(tagBody: string): boolean {
  if (HIDDEN_ATTR.test(tagBody.replace(/\s*=\s*(?:"[^"]{0,2048}"|'[^']{0,2048}')/g, '=x')) || ARIA_HIDDEN.test(tagBody)) return true;
  const style = styleOf(tagBody);
  if (style.size === 0) return false;
  if (style.get('display') === 'none' || style.get('visibility') === 'hidden' || style.get('mso-hide') === 'all') return true;
  if (zeroLength(style.get('opacity')) || style.get('opacity') === '0') return true;
  const fontSize = /^(\d{1,3}(?:\.\d{1,3})?)(px|pt)?$/.exec(style.get('font-size') ?? '');
  if (fontSize !== null && Number(fontSize[1]) <= 1) return true;
  if (zeroLength(style.get('max-height')) || ((zeroLength(style.get('height')) || zeroLength(style.get('width'))) && style.get('overflow') === 'hidden')) return true;
  const color = normalizeColor(style.get('color'));
  const background = normalizeColor(style.get('background-color') ?? style.get('background'));
  return color !== null && color === background;
}

/**
 * HTML → **숨긴 요소 안의 글만**(없으면 `''`). 보이는 글은 싣지 않는다. `htmlToText` 의 출력(보이는 글 + 숨긴 글)은 그대로 두고, 스캐너가 "숨겼다" 는 사실을 따로 알 수 있게 한다.
 * 숨김 판정은 **인라인으로 풀리는 것만**: `hidden` 속성 · `aria-hidden="true"` · `display:none` · `visibility:hidden` · `opacity:0` ·
 * `font-size` 1px 이하 · `width`/`height`/`max-height` 0(+ `overflow:hidden`) · 같은 `style` 안의 글자색 = 배경색. `<style>` 클래스·상속 배경색은
 * 보지 않는다(CSS 캐스케이드가 필요하다 — `docs/security/encoding-limits.md`). 숨긴 글 자체는 신호가 아니다(마케팅 프리헤더) — 스캐너가
 * 그 안에서 지시성 룰이 걸릴 때만 가산한다.
 *
 * 선형: 태그마다 한 번, 열린 요소 스택은 `MAX_HIDDEN_STACK` 까지(넘으면 더 쌓지 않는다 — 숨김 판정은 부모 상태를 물려받는다).
 */
export function htmlHiddenText(html: string): string {
  const out: string[] = [];
  const stack: { readonly name: string; readonly hidden: boolean }[] = [];
  const hiddenNow = (): boolean => stack[stack.length - 1]?.hidden === true;
  let nextGt = -2;
  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) {
      if (hiddenNow()) appendText(out, html.slice(index));
      break;
    }
    if (hiddenNow()) appendText(out, html.slice(index, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) break;
      index = end + 3;
      continue;
    }
    if (nextGt !== -1 && nextGt < lt) nextGt = html.indexOf('>', lt);
    if (nextGt === -1) break;
    const tagBody = html.slice(lt + 1, nextGt);
    const nameMatch = TAG_NAME.exec(tagBody);
    index = nextGt + 1;
    if (nameMatch === null) {
      if (!tagBody.startsWith('!') && !tagBody.startsWith('?')) {
        if (hiddenNow()) appendText(out, '<');
        index = lt + 1;
      }
      continue;
    }
    const closing = nameMatch[1] === '/';
    const name = (nameMatch[2] ?? '').toLowerCase();
    if (!closing && DROP_WITH_CONTENT.has(name)) {
      index = skipDropped(html, name, index);
      if (index === -1) break;
      continue;
    }
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]?.name === name) {
          stack.length = i;
          break;
        }
      }
      if (BLOCK_ELEMENTS.has(name) && hiddenNow()) out.push('\n');
      continue;
    }
    const selfClosing = tagBody.trimEnd().endsWith('/');
    if (name === 'br' || BLOCK_ELEMENTS.has(name)) {
      if (hiddenNow()) out.push('\n');
    } else if (CELL_ELEMENTS.has(name) && hiddenNow()) {
      out.push(' ');
    }
    if (VOID_ELEMENTS.has(name) || selfClosing || stack.length >= MAX_HIDDEN_STACK) continue;
    stack.push({ name, hidden: hiddenNow() || hidesItself(tagBody) });
  }
  return out
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}
