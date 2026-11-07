/**
 * src/mail/mime/parse-charset.ts — 한국어 레거시 charset 디코딩 (`parse.ts` 전용).
 *
 * 디코딩은 원래 postal-mime 이 한다. 이 파일이 존재하는 이유는 **Node 에서 그 디코딩이
 * 한국어 두 곳에서 틀리기 때문**이다. 둘 다 조용히 틀린다.
 *
 * ---------------------------------------------------------------------------
 * ## ① CP949(UHC) 확장 — Node 의 `euc-kr` 디코더에 없다 (2026-09-23 실측)
 * ---------------------------------------------------------------------------
 *
 * WHATWG 의 `euc-kr` 은 CP949 표(KS X 1001 + 확장 한글 8,822자)다. 그런데 Node 의
 * `TextDecoder('euc-kr')` 는 ICU 의 순수 EUC-KR 변환기이고, 확장 영역을 만나면 **한 글자를
 * 두 글자로 쪼갠다**: 리드 `0x81–0xA0` 은 C1 제어문자 `U+0081–U+00A0` 로, 리드 `0xA1–0xC6` 은
 * U+FFFD 로, 그리고 **트레일 바이트는 따로 ASCII 로** — `0x8C 0x63`("똠") → `"\u008Cc"`.
 * `fatal: true` 로도 던지지 않는다. (Node 25.8 / ICU 78.2 에서 확인.)
 *
 * 이것은 글자가 깨지는 문제로 끝나지 않는다. **파서 차이(parser differential)** 다:
 * 트레일 바이트 `0x41-0x5A`·`0x61-0x7A` 는 ASCII 영문자이고 C1 제어문자는 거의 모든
 * 텍스트 처리에서 지워지거나 보이지 않는다(이 모듈의 본문 정리도 지운다). 공격자는 사람의
 * 메일 클라이언트(CP949 지원)에는 무의미한 한글 음절로 보이고 **우리 에이전트에게만 영어
 * 지시문으로 보이는** 본문을 쓸 수 있다 — `81 49 81 47 81 4E …` 는 사람에게 "갏갍갢…",
 * 우리에게 "IGNORE…" 다. 사람의 검토와 P4 스캐너가 서로 다른 글을 본다.
 *
 * 그래서 확장 영역은 여기서 직접 푼다. 표는 **알고리즘으로** 만든다: 확장 8,822자는
 * "U+AC00–U+D7A3 중 KS X 1001 에 없는 음절" 을 코드포인트 순으로 리드 `0x81–0xC6` ×
 * 트레일(`41–5A`,`61–7A`,`81–FE`; 리드 `A1` 부터는 `81–A0` 까지)에 차례로 채운 것이다.
 * 이 배치는 개발 중 python `cp949` 코덱과 **8,822자 전수 대조**로 확인했고, 테스트 픽스처는
 * 이 파일과 독립인 python 코덱으로 만든다(`test/fixtures/eml/_generate.py`).
 * KS X 1001 영역은 ICU 가 맞게 푼다 — 단 CP949 가 뒤에 추가한 `A2E6`(€)·`A2E7`(®) 두 자만
 * 빠져 있어 여기서 채운다(같은 전수 대조에서 나온 차이 전부).
 *
 * ---------------------------------------------------------------------------
 * ## ② ISO-2022-KR — WHATWG 가 디코더를 없앴다
 * ---------------------------------------------------------------------------
 *
 * WHATWG 는 `iso-2022-kr` 을 `replacement` 인코딩에 묶었고 Node 는 그 라벨에서 던진다.
 * postal-mime 은 그때 windows-1252 로 떨어진다. RFC 1557 은 순수 7bit 이므로 직접 푼다:
 * SO…SI 구간의 바이트 쌍에 `0x80` 을 더하면 EUC-KR(= KS X 1001) 이다.
 */

// ---------------------------------------------------------------------------
// charset 라벨 판정
// ---------------------------------------------------------------------------

/**
 * postal-mime 3.0.0 `decode-strings.js` 의 별칭표 사본. 그쪽이 판정 함수를 export 하지
 * 않는다. 이 사본이 갈라지면 틀리는 것은 **`unknown_charset` 경고 한 줄**이다(본문 디코딩은
 * 라이브러리 또는 이 파일이 한다). 라이브러리를 올릴 때 다시 대조하라.
 */
const CHARSET_ALIASES = new Map<string, string>([
  ['iso88598i', 'iso-8859-8'],
  ['iso88598e', 'iso-8859-8'],
  ['shiftjis', 'shift_jis'],
  ['windows31j', 'shift_jis'],
  ['mskanji', 'shift_jis'],
  ['eucjp', 'euc-jp'],
  ['iso2022jp', 'iso-2022-jp'],
  ['iso2022jp1', 'iso-2022-jp'],
  ['iso2022jp2', 'iso-2022-jp'],
  ['junet', 'iso-2022-jp'],
  ['euckr', 'euc-kr'],
  ['uhc', 'euc-kr'],
  ['tis620', 'windows-874'],
]);

const CODE_PAGE_ALIASES = new Map<string, string>([
  ['932', 'shift_jis'],
  ['936', 'gbk'],
  ['949', 'euc-kr'],
  ['950', 'big5'],
  ['874', 'windows-874'],
  ['51932', 'euc-jp'],
  ['50220', 'iso-2022-jp'],
  ['50221', 'iso-2022-jp'],
  ['50222', 'iso-2022-jp'],
]);

function decoderEncoding(label: string): string | null {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return null;
  }
}

/**
 * 라벨 → 누가 디코딩하는가.
 *   - `cp949`: WHATWG `euc-kr` 로 풀리는 모든 라벨(`euc-kr`·`ks_c_5601-1987`·`cp949`·…). 이 파일.
 *   - `iso-2022-kr`: 이 파일.
 *   - `native`: 라이브러리(= `TextDecoder`)가 맞게 푼다.
 *   - `unknown`: 라이브러리가 windows-1252 로 떨어진다 — 본문이 깨졌을 수 있다.
 *
 * `rfc2231` 언어 꼬리(`utf-8*ko`)는 떼고 본다.
 */
export type CharsetHandling = 'cp949' | 'iso-2022-kr' | 'native' | 'unknown';

export function classifyCharset(rawLabel: string): CharsetHandling {
  const label = rawLabel.split('*')[0]?.trim().toLowerCase() ?? '';
  if (label === '') return 'native'; // 라벨 없음 = 라이브러리 기본(utf-8)

  const normalized = label.replace(/^(?:x-ms-|x-|cs)/, '').replace(/[\s._-]+/g, '');
  if (normalized === 'iso2022kr') return 'iso-2022-kr';

  const codePage = /^(?:cp|windows|ms|ibm)(\d+)$/.exec(normalized)?.[1];
  const alias =
    (codePage !== undefined ? CODE_PAGE_ALIASES.get(codePage) : undefined) ??
    CHARSET_ALIASES.get(normalized) ??
    normalized;
  const encoding = decoderEncoding(label) ?? decoderEncoding(alias);
  if (encoding === null) return 'unknown';
  return encoding === 'euc-kr' ? 'cp949' : 'native';
}

/**
 * 경고에 싣는 라벨. **공격자가 쓴 문자열이다** — 길이를 자르고 라벨 문자 밖은 `?` 로 바꾼다.
 * 경고는 로그로 가고, 로그에 제어문자나 수 KB 짜리 값이 들어가면 그 자체가 인젝션이다.
 */
export function describeCharsetLabel(rawLabel: string): string {
  return rawLabel.trim().slice(0, 64).replace(/[^\w.:+-]/g, '?');
}

// ---------------------------------------------------------------------------
// CP949
// ---------------------------------------------------------------------------

const ksDecoder = new TextDecoder('euc-kr');
const REPLACEMENT = '\ufffd';

/** CP949 가 KS X 1001 에 더한 두 자. ICU 에는 없다(모듈 머리말). */
const CP949_KS_ADDITIONS = new Map<number, string>([
  [0xa2e6, '€'],
  [0xa2e7, '®'],
]);

let extensionTable: string[] | null = null;

/** 확장 음절 8,822자, 확장 코드 순서대로. 첫 사용 때 한 번 만든다. */
function cp949Extension(): string[] {
  if (extensionTable !== null) return extensionTable;
  const ks = new Set<string>();
  for (let lead = 0xb0; lead <= 0xc8; lead += 1) {
    for (let trail = 0xa1; trail <= 0xfe; trail += 1) {
      ks.add(ksDecoder.decode(Uint8Array.of(lead, trail)));
    }
  }
  const table: string[] = [];
  for (let code = 0xac00; code <= 0xd7a3; code += 1) {
    const syllable = String.fromCharCode(code);
    if (!ks.has(syllable)) table.push(syllable);
  }
  extensionTable = table;
  return table;
}

/** 트레일 바이트의 확장 영역 내 순번. 영역 밖이면 -1. */
function trailOrdinal(trail: number, wide: boolean): number {
  if (trail >= 0x41 && trail <= 0x5a) return trail - 0x41;
  if (trail >= 0x61 && trail <= 0x7a) return 26 + trail - 0x61;
  if (trail >= 0x81 && trail <= (wide ? 0xfe : 0xa0)) return 52 + trail - 0x81;
  return -1;
}

/** 확장 영역이면 그 음절, KS X 1001 영역이면 `null`(ICU 에 맡긴다), 둘 다 아니면 U+FFFD. */
function extensionChar(lead: number, trail: number): string | null {
  if (lead >= 0xa1 && trail >= 0xa1) return null; // KS X 1001
  if (lead > 0xc6) return REPLACEMENT;
  const wide = lead < 0xa1; // 리드 81–A0 은 트레일 178개, A1–C6 은 84개
  const ordinal = trailOrdinal(trail, wide);
  if (ordinal < 0) return REPLACEMENT;
  const index = wide ? (lead - 0x81) * 178 + ordinal : 32 * 178 + (lead - 0xa1) * 84 + ordinal;
  return cp949Extension()[index] ?? REPLACEMENT;
}

/**
 * CP949 바이트 → 문자열. KS X 1001 구간은 ICU 에 묶어서 넘기고(빠르다), 확장·오류 바이트만
 * 여기서 한 글자씩 푼다. **어떤 바이트도 조용히 사라지지 않는다** — 풀 수 없으면 U+FFFD 다.
 */
export function decodeCp949(bytes: Uint8Array): string {
  const out: string[] = [];
  let runStart = 0; // ICU 로 넘길 구간의 시작

  const flushRun = (end: number): void => {
    if (end > runStart) out.push(ksDecoder.decode(bytes.subarray(runStart, end)));
  };

  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index] ?? 0;
    if (lead < 0x80) {
      index += 1;
      continue;
    }
    const trail = index + 1 < bytes.length ? (bytes[index + 1] ?? -1) : -1;
    if (lead === 0x80 || lead === 0xff || trail < 0) {
      flushRun(index);
      out.push(REPLACEMENT);
      index += 1;
      runStart = index;
      continue;
    }
    const addition = CP949_KS_ADDITIONS.get((lead << 8) | trail);
    const special = addition ?? extensionChar(lead, trail);
    if (special === null) {
      index += 2; // KS X 1001 — ICU 구간에 남긴다
      continue;
    }
    flushRun(index);
    if (special === REPLACEMENT && trail < 0x80) {
      // 잘못된 리드 + ASCII 트레일: ASCII 는 살린다(WHATWG 규칙). 삼키면 그것이 ① 의 버그다.
      out.push(REPLACEMENT);
      index += 1;
    } else {
      out.push(special);
      index += 2;
    }
    runStart = index;
  }
  flushRun(bytes.length);
  return out.join('');
}

// ---------------------------------------------------------------------------
// ISO-2022-KR (RFC 1557)
// ---------------------------------------------------------------------------

/** `ESC $ ) C` — G1 을 KS X 1001 로 지정한다. */
const ISO_2022_KR_DESIGNATOR = [0x1b, 0x24, 0x29, 0x43] as const;
const SHIFT_OUT = 0x0e;
const SHIFT_IN = 0x0f;

/**
 * ISO-2022-KR 바이트 → 문자열. RFC 1557 은 줄마다 ASCII 로 시작한다고 정하므로 개행에서
 * SO 상태를 끊는다 — 끊지 않으면 SI 가 빠진 한 줄이 **메일 나머지 전체**를 한글 쓰레기로 만든다.
 */
export function decodeIso2022Kr(bytes: Uint8Array): string {
  const out: string[] = [];
  let shifted = false;
  let pending: number[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    // 홀수 바이트면 마지막 한 바이트는 짝이 없다 — 디코더가 U+FFFD 로 바꾼다.
    out.push(decodeCp949(Uint8Array.from(pending, (byte) => byte | 0x80)));
    pending = [];
  };

  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    if (ISO_2022_KR_DESIGNATOR.every((expected, offset) => bytes[index + offset] === expected)) {
      flush();
      index += ISO_2022_KR_DESIGNATOR.length - 1;
      continue;
    }
    if (byte === SHIFT_OUT) {
      flush();
      shifted = true;
      continue;
    }
    if (byte === SHIFT_IN || byte === 0x0a || byte === 0x0d) {
      flush();
      shifted = false;
      if (byte !== SHIFT_IN) out.push(String.fromCharCode(byte));
      continue;
    }
    if (shifted && byte >= 0x21 && byte <= 0x7e) {
      pending.push(byte);
      continue;
    }
    flush();
    // 7bit 인코딩에 8bit 바이트가 있으면 규격 위반이다 — 추측하지 않고 U+FFFD.
    out.push(byte < 0x80 ? String.fromCharCode(byte) : REPLACEMENT);
  }
  flush();
  return out.join('');
}

/** `classifyCharset` 결과가 `cp949`·`iso-2022-kr` 인 바이트를 푼다. */
export function decodeKoreanLegacy(handling: 'cp949' | 'iso-2022-kr', bytes: Uint8Array): string {
  return handling === 'cp949' ? decodeCp949(bytes) : decodeIso2022Kr(bytes);
}

// ---------------------------------------------------------------------------
// RFC 2047 인코딩 워드 — 한국어 레거시 charset 만 UTF-8 로 바꿔 쓴다
// ---------------------------------------------------------------------------

const ENCODED_WORD = /=\?([^?\s]+)\?([QqBb])\?([^?]*)\?=/g;

function encodedWordBytes(encoding: string, text: string): Uint8Array {
  if (encoding.toUpperCase() === 'B') {
    return Buffer.from(text.replace(/[^A-Za-z0-9+/]/g, ''), 'base64');
  }
  // Q: `_` 는 공백, `=XX` 는 바이트, 나머지는 ASCII 그대로(RFC 2047 §4.2).
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    const hex = text.slice(index + 1, index + 3);
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(char === '_' ? 0x20 : char.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * 헤더 값 안의 **한국어 레거시 charset 인코딩 워드**를 이 파일의 디코더로 풀어 `=?UTF-8?B?…?=`
 * 로 바꿔 쓴다. 나머지(UTF-8 워드, 평문)는 한 글자도 건드리지 않는다. 결과는 여전히 RFC 2047
 * 헤더 값이라 라이브러리의 `decodeWords`·`addressParser` 에 그대로 넘긴다 — 그쪽의 주소
 * 문법 처리(인코딩 워드로 주소를 위조하는 것을 막는 2.7.4 수정 포함)를 잃지 않는다.
 *
 * 공백으로만 떨어진 **같은 charset 의 연속 워드는 바이트를 이어 붙인 뒤** 푼다. 메일 프로그램은
 * 한 글자(2바이트)를 두 워드에 걸쳐 쪼개곤 한다 — 워드마다 따로 풀면 그 글자가 깨진다.
 */
export function rewriteKoreanEncodedWords(value: string): string {
  if (!value.includes('=?')) return value;
  const out: string[] = [];
  let cursor = 0;
  let run: { handling: 'cp949' | 'iso-2022-kr'; label: string; chunks: Uint8Array[] } | null = null;

  const flushRun = (): void => {
    if (run === null) return;
    const text = decodeKoreanLegacy(run.handling, Buffer.concat(run.chunks));
    out.push(`=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`);
    run = null;
  };

  for (const match of value.matchAll(ENCODED_WORD)) {
    const [word, label = '', encoding = 'B', text = ''] = match;
    const start = match.index;
    const gap = value.slice(cursor, start);
    const handling = classifyCharset(label);
    const normalizedLabel = label.split('*')[0]?.toLowerCase() ?? '';

    if (handling === 'cp949' || handling === 'iso-2022-kr') {
      const joinable = run !== null && run.label === normalizedLabel && /^[ \t\r\n]*$/.test(gap);
      if (!joinable) {
        flushRun();
        out.push(gap);
        run = { handling, label: normalizedLabel, chunks: [] };
      }
      run?.chunks.push(encodedWordBytes(encoding, text));
    } else {
      flushRun();
      out.push(gap, word);
    }
    cursor = start + word.length;
  }
  flushRun();
  out.push(value.slice(cursor));
  return out.join('');
}
