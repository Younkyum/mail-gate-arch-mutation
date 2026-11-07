/**
 * src/security/dlp/decode.ts — 발신 DLP 의 **풀어 본 보기**(2026-10-08 인코딩 점검). 순수 · 상한 있는 한 번 훑기 · 값을 돌려주지 않는다(호출자만 본다).
 *
 * 왜: 마크업 정규화(`markup.ts`)는 받는 메일 앱이 보여 주는 모양으로 맞출 뿐이라 **base64 · base64url · 16진수 · 비 ASCII `%XX`** 로 한 번 감싼
 * 자격 증명·받은 코드·받은 메일 사본은 그대로 지나갔다(ADR-0016 "남는 한계"). 받는 사람은 그것을 한 줄 명령으로 푼다. 그래서 후보를 풀어
 * **사람이 읽는 글로 풀리는 것만**(UTF-8 · 제어문자 없음) 이어 붙인 보기를 하나 더 만든다 — 비밀·코드·복사 지문이 그 보기도 본다.
 *
 *   - base64 / base64url — `[A-Za-z0-9+/_-]` 8자 이상(6자리 코드의 base64 가 8자). 76자 줄바꿈(MIME 식)으로 나뉜 덩어리는 이은 것도 본다.
 *     영어 낱말(`information`)도 이 문자 집합이라 **숫자·`+/_-=`·안쪽 대문자(소문자 뒤 대문자)** 중 하나가 있는 후보만 푼다.
 *   - 16진수 — `48656c6c6f` · `\x48\x65` · `%48%65` · `48 65 6c` (4바이트 이상).
 *   - 퍼센트 — `%XX` 연속을 UTF-8 로(마크업 단계는 인쇄 가능 ASCII 만 푼다).
 *   - 두 겹까지(base64 안의 16진수 등).
 *
 * **상한:** 후보 수 `MAX_DECODE_CANDIDATES` · 풀어 낸 글 `MAX_DECODED_CHARS`. 넘으면 `truncated` — 호출자가 `scan_limit` 으로 닫는다(fail closed).
 * 이진으로 풀리는 후보(해시·이미지 data URI·메시지 ID)는 버리고 예산에 넣지 않는다.
 */

/** base64 후보. 상한 있는 수량자만(ReDoS 규율 — `dlp-redos.test.ts`). */
export const DECODE_BASE64 = /[A-Za-z0-9+/_-]{8,8192}={0,2}/g;
/** 줄바꿈 하나(와 인용 `>`)로 이어진 base64 줄 — 이은 보기를 따로 만든다. 앞 16자가 base64 문자일 때만. */
export const DECODE_BASE64_WRAP = /(?<=[A-Za-z0-9+/=_-]{16})\r?\n[ \t>]{0,4}(?=[A-Za-z0-9+/_-])/g;
export const DECODE_HEX = /(?<![0-9A-Za-z])(?:\\x|%|0x)?[0-9a-fA-F]{2}(?:(?:\\x|%|0x|[ :-])?[0-9a-fA-F]{2}){3,4095}/g;
export const DECODE_PERCENT = /(?:%[0-9a-fA-F]{2}){2,4096}/g;
const BASE64_QUALIFIES = /[0-9+/_=-]|[a-z][A-Z]/;
const HEX_SEPARATORS = /\\x|%|0x|[ :-]/g;

export const MAX_DECODE_CANDIDATES = 8192;
export const MAX_DECODED_CHARS = 256 * 1024;
const MAX_DEPTH = 2;

/** ReDoS 감사용(`dlp-redos.test.ts`). */
export const DECODE_AUDITED_PATTERNS: readonly { readonly name: string; readonly source: string }[] = [
  { name: 'DECODE_BASE64', source: DECODE_BASE64.source },
  { name: 'DECODE_BASE64_WRAP', source: DECODE_BASE64_WRAP.source },
  { name: 'DECODE_HEX', source: DECODE_HEX.source },
  { name: 'DECODE_PERCENT', source: DECODE_PERCENT.source },
];

export interface DecodedView {
  /** 풀린 글들을 줄바꿈으로 이은 것(접지 않은 원형). 풀린 것이 없으면 `''`. */
  readonly text: string;
  /** 후보·예산 상한에 걸려 끝까지 풀지 못했다. */
  readonly truncated: boolean;
}

/** 엄격 UTF-8 — 비스트리밍 `decode` 는 부를 때마다 상태를 새로 시작하므로 하나를 다시 쓴다. */
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

/** 사람이 읽는 글인가 — UTF-8(엄격) · 제어문자(탭·줄바꿈 밖) 없음 · 대체 문자 없음 · 4자 이상. */
function readable(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  let text: string;
  try {
    text = UTF8_STRICT.decode(bytes);
  } catch {
    return null;
  }
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f) || c === 0xfffd) return null;
  }
  return text;
}

function decodeBase64(candidate: string): string | null {
  const body = candidate.replace(/={1,2}$/, '');
  if (body.length < 8 || body.length % 4 === 1) return null;
  return readable(Buffer.from(body, 'base64'));
}

function decodeHex(candidate: string): string | null {
  const digits = candidate.replace(HEX_SEPARATORS, '');
  if (digits.length % 2 !== 0) return null;
  return readable(Buffer.from(digits, 'hex'));
}

function decodePercent(candidate: string): string | null {
  try {
    const text = decodeURIComponent(candidate);
    return readable(Buffer.from(text, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 원문(태그째 · 태그를 걷은 것 — 호출자가 고른다)들에서 풀린 글을 모은다. 결과는 **접지 않은** 글이다 — 호출자가 `fold` 한다.
 */
export function decodedView(sources: readonly string[]): DecodedView {
  const out: string[] = [];
  const seen = new Set<string>();
  let candidates = 0;
  let budget = MAX_DECODED_CHARS;
  let truncated = false;

  const tryAll = (text: string, pattern: RegExp, decode: (c: string) => string | null, found: string[], qualifies?: RegExp): void => {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while (!truncated && (m = pattern.exec(text)) !== null) {
      const candidate = m[0];
      if (qualifies !== undefined && !qualifies.test(candidate)) continue;
      candidates += 1;
      if (candidates > MAX_DECODE_CANDIDATES) {
        truncated = true;
        return;
      }
      const decoded = decode(candidate);
      if (decoded === null || seen.has(decoded)) continue;
      if (decoded.length > budget) {
        truncated = true;
        return;
      }
      budget -= decoded.length;
      seen.add(decoded);
      out.push(decoded);
      found.push(decoded);
    }
  };

  const collect = (text: string, depth: number): void => {
    const found: string[] = [];
    tryAll(text, DECODE_BASE64, decodeBase64, found, BASE64_QUALIFIES);
    // 줄바꿈으로 나뉜 덩어리 — 이은 보기에서 한 번 더. 이을 곳이 없으면 같은 글이라 건너뛴다.
    const unwrapped = text.replace(DECODE_BASE64_WRAP, '');
    if (unwrapped !== text) tryAll(unwrapped, DECODE_BASE64, decodeBase64, found, BASE64_QUALIFIES);
    tryAll(text, DECODE_HEX, decodeHex, found);
    tryAll(text, DECODE_PERCENT, decodePercent, found);
    if (depth < MAX_DEPTH) for (const inner of found) if (!truncated) collect(inner, depth + 1);
  };

  for (const source of sources) {
    if (truncated) break;
    collect(source, 1);
  }
  return { text: out.join('\n'), truncated };
}
