/**
 * src/security/dlp/codes.ts — **인증 코드 지문**(ADR-0016 B `verification_code`). 받은 인증 코드가 다른 곳으로 나가는지 본다.
 *
 * 흐름(배선은 M1):
 *   1. **수신 쪽** — 에이전트가 인증 코드를 읽을 때(조회 라우트, 추출기 `src/mail/verification/**` 의 결과) 코드마다
 *      `fingerprintCode` 로 지문을 만들어 24시간 둔다. 원문 코드는 저장하지 않는다 — HMAC(`hmac-keyring`)만.
 *   2. **발신 쪽** — 발송 본문에서 코드처럼 보이는 문자열 후보를 전부 투영해(`projectCodeCandidates`) 같은 키로 HMAC 을 내고
 *      지문과 맞춘다(`matchCodeFingerprints`).
 *
 * **ADR-0013 경계 개정(ADR-0016):** 추출 결과는 여전히 정책·발송·승인의 **입력이 아니다** — 이 파일은 추출기를 import 하지 않는다
 * (arch `verification-boundary`). 호출자가 넘긴 코드 문자열을 지문으로 바꿀 뿐이고, 그 지문은 발신 판정을 **좁히는 방향으로만** 쓴다
 * (허용을 만들지 않는다 — `rules/risk-hold.ts`).
 *
 * **출처 도메인 제외:** 코드를 보낸 곳(등록 도메인)과 수신자 도메인이 (전원) 같으면 세지 않는다(무료·공용 메일 도메인은 제외하지 않는다) — "받은 코드를 그 서비스에 되돌려 보낸다" 는
 * 정상 흐름이다(확인 메일에 코드로 회신). 등록 도메인 계산(공개 접미사)은 호출자가 한다 — 이 디렉터리는 순수하게 둔다.
 *
 * **비밀 링크(재검증 N2 — 리드 결정):** 재설정·로그인 링크는 코드와 같은 값이다(받은 사람이면 누구나 쓴다). 상세 노출 때 받은 메일의 URL 안 **토큰**
 * (`secretLinkTokens` — 기준은 그 함수 머리말)을 다른 서명 문맥으로 지문화해 같은 표(`agent_code_fingerprints`, 24시간)에 둔다. 발신 쪽은 본문(세
 * 보기 — 태그를 지운 · 공백으로 바꾼 · **태그째**: `href` 속 토큰)의 `[a-z0-9_-]` 연속 16~256자를 같은 문맥으로 HMAC 해 맞춘다. 맞으면
 * `secret_link`(진윤겸 결정 — 재설정·공유·추적 구분 없이 승인 대기, 에이전트에게는 `risk_review`)다 — 출처 도메인 제외는 코드와 같다(그 서비스에 되돌리는 것은 정상).
 *
 * **HMAC 입력에 도메인을 넣지 않는 이유:** 넣으면 발신 쪽이 후보 × 출처 도메인 수만큼 HMAC 을 내야 한다. 도메인은 이미 수신 메타
 * (`inbound_messages.from_domain`)에 평문으로 있으므로 숨길 것이 없고, 지문 행에 나란히 둔다.
 */

import { createHmac } from 'node:crypto';

import type { HmacKeyring } from '../hmac-keyring';
import { fold } from '../injection/normalize';
import { isSharedMailboxDomain } from '../shared-mailbox';

/** 서명 문맥(domain separation) — 다른 용도의 같은 키 HMAC 과 겹치지 않게. */
const CODE_CONTEXT = 'atmark.dlp.verification-code.v1';

/** 코드 정규형 길이. 추출기 모양(숫자 4~8 · `ddd-dddd` · 영숫자 6~10)을 덮는 범위. */
export const MIN_CODE_CHARS = 4;
export const MAX_CODE_CHARS = 12;

/**
 * 후보 사이에 둘 수 있는 구분자(접은 보기 기준) — `123 456` · `123-456` · `1.2.3.4` · `12·34` · `12_34` · `12/34` · 줄바꿈 · `,` `|` `+` `:` `;`.
 * 넓혀도 오탐 비용은 거의 없다 — 후보는 받은 코드와 **HMAC 이 정확히 같을 때만** 걸린다. HTML 태그·엔티티는 앞 단계(`markup.ts`)가 걷는다.
 */
const SEPARATORS = new Set([' ', '\n', '-', '.', '_', '·', '/', '‐', '‑', '–', '—', ',', '|', '+', ':', ';']);
/** 원자 사이 구분자 연속 상한(` - ` 같은 3글자까지). */
const MAX_SEPARATOR_RUN = 3;
/** 한 본문에서 HMAC 을 낼 후보 상한(중복 제거 뒤). 넘으면 `truncated` — 호출자가 `scan_limit` 으로 닫는다(fail closed). */
export const MAX_CODE_CANDIDATES = 50_000;

/** 지문 한 줄. `mac` 은 hex 32자(128비트). */
export interface CodeFingerprint {
  readonly kid: string;
  readonly mac: string;
  /** 코드를 보낸 메일의 **등록 도메인**(소문자). */
  readonly originDomain: string;
}

function isAsciiAlnum(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a);
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

const DECIMAL_DIGIT = /\p{Nd}/u;
const NON_ASCII_DECIMAL_DIGIT = /[^\x00-\x7f]/gu;
const digitCache = new Map<number, string>();

/** 비 ASCII 십진 숫자(\p{Nd} — 아라비아-인도 `٤`·데바나가리 `४` 등) → ASCII. 그 숫자 연속의 시작에서 센 자리값이다. */
function asciiDigitOf(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  const cached = digitCache.get(cp);
  if (cached !== undefined) return cached;
  let out = ch;
  if (DECIMAL_DIGIT.test(ch)) {
    let start = cp;
    for (let k = 0; k < 64 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1)); k += 1) start -= 1;
    out = String((cp - start) % 10);
  }
  if (digitCache.size < 4096) digitCache.set(cp, out);
  return out;
}

/** 접은 보기의 비 ASCII 십진 숫자를 ASCII 로 접는다(NFKD 가 풀지 않는 숫자들). 한 번 훑는다. */
export function foldDecimalDigits(text: string): string {
  return text.replace(NON_ASCII_DECIMAL_DIGIT, asciiDigitOf);
}

/**
 * 코드 정규형 — 접고(전각 숫자·대소문자) ASCII 영숫자만 남긴다. 숫자가 하나도 없거나 길이가 범위 밖이면 `null`
 * (추출기의 코드 모양은 모두 숫자를 품는다 — `src/mail/verification/extract.ts` `isCodeShape`).
 */
export function normalizeVerificationCode(code: string): string | null {
  const text = foldDecimalDigits(fold(code.slice(0, 256)).text);
  let out = '';
  let digits = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (!isAsciiAlnum(c)) continue;
    out += text[i];
    if (isDigit(c)) digits += 1;
  }
  if (digits === 0 || out.length < MIN_CODE_CHARS || out.length > MAX_CODE_CHARS) return null;
  return out;
}

function macOf(key: Buffer, normalized: string, context: string = CODE_CONTEXT): string {
  return createHmac('sha256', key).update(`${context}\n${normalized}`, 'utf8').digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// 비밀 링크(재검증 N2)
// ---------------------------------------------------------------------------

/** 링크 토큰의 서명 문맥 — 코드 지문과 같은 표에 두되 값이 겹치지 않게. */
const LINK_CONTEXT = 'atmark.dlp.secret-link.v1';
/** 링크 토큰 길이(`[A-Za-z0-9_-]` 연속). 16자 아래는 경로 낱말·짧은 id 다 — 재설정 토큰은 대개 20자 이상이다. */
export const MIN_LINK_TOKEN_CHARS = 16;
export const MAX_LINK_TOKEN_CHARS = 256;
/** 한 메일에서 지문을 남길 링크 토큰 상한. */
export const MAX_LINK_TOKENS_PER_MAIL = 20;
/** 한 메일에서 보는 URL 상한 · URL 하나의 길이 상한. */
const MAX_URLS_PER_MAIL = 200;
const MAX_URL_CHARS = 2048;

function isTokenChar(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x5f;
}

/** URL 이 끝나는 글자 — 공백 · 따옴표 · 꺾쇠 · 괄호(메일 앱이 `(URL)` 로 감싼다). */
function endsUrl(c: number): boolean {
  return c <= 0x20 || c === 0x22 || c === 0x27 || c === 0x3c || c === 0x3e || c === 0x28 || c === 0x29 || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x7f;
}

/**
 * 토큰처럼 보이는 연속인가(원문 대소문자로 본다). 넷 모두:
 *   ① 길이 16~256 · ② 숫자 2개 이상 · ③ 글자 2개 이상 ·
 *   ④ 무작위 모양 — 대문자와 소문자가 섞였다(base64url) **또는** 글자가 전부 a–f(16진수 · UUID) **또는** 글자만 이어진 구간이 4자 이하다.
 * ④ 가 사람이 쓴 경로(`2024-annual-report`)를 뺀다 — 낱말은 5자 이상 글자 연속이다. 지문은 받은 토큰과 **정확히** 같을 때만 걸리므로 기준이
 * 넓어도 오탐은 거의 없다(저장량만 는다). 좁으면 놓친다 — 그래서 ④ 는 셋 중 하나다.
 */
export function isSecretToken(run: string): boolean {
  if (run.length < MIN_LINK_TOKEN_CHARS || run.length > MAX_LINK_TOKEN_CHARS) return false;
  let digits = 0;
  let letters = 0;
  let upper = false;
  let lower = false;
  let nonHex = false;
  let letterRun = 0;
  let longestLetterRun = 0;
  for (let i = 0; i < run.length; i += 1) {
    const c = run.charCodeAt(i);
    if (c >= 0x30 && c <= 0x39) digits += 1;
    const isUpper = c >= 0x41 && c <= 0x5a;
    const isLower = c >= 0x61 && c <= 0x7a;
    if (isUpper || isLower) {
      letters += 1;
      upper ||= isUpper;
      lower ||= isLower;
      if (!((c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66))) nonHex = true;
      letterRun += 1;
      if (letterRun > longestLetterRun) longestLetterRun = letterRun;
    } else {
      letterRun = 0;
    }
  }
  if (digits < 2 || letters < 2) return false;
  return (upper && lower) || !nonHex || longestLetterRun <= 4;
}

/**
 * 받은 메일 글(제목 · text · HTML 변환 텍스트 — 변환은 `<a href>` 를 `(URL)` 로 남긴다)의 **URL 안 토큰**(소문자, 중복 없음, 최대 20). URL 은
 * `http://`·`https://` 로 시작하는 연속이고, 호스트 뒤(경로 · 쿼리 · 조각)의 `[A-Za-z0-9_-]` 연속 중 `isSecretToken` 인 것만 낸다. 한 번 훑는다.
 */
export function secretLinkTokens(text: string): string[] {
  const out = new Set<string>();
  const starts = /https?:\/\//giu;
  for (let urls = 0; urls < MAX_URLS_PER_MAIL && out.size < MAX_LINK_TOKENS_PER_MAIL; urls += 1) {
    const found = starts.exec(text);
    if (found === null) break;
    const at = found.index;
    const scheme = found[0].length;
    let end = at + scheme;
    while (end < text.length && end - at < MAX_URL_CHARS && !endsUrl(text.charCodeAt(end))) end += 1;
    // 호스트 뒤부터 — 호스트 이름은 토큰이 아니다.
    let i = at + scheme;
    while (i < end && text[i] !== '/' && text[i] !== '?' && text[i] !== '#') i += 1;
    while (i < end && out.size < MAX_LINK_TOKENS_PER_MAIL) {
      if (!isTokenChar(text.charCodeAt(i))) {
        i += 1;
        continue;
      }
      const start = i;
      while (i < end && isTokenChar(text.charCodeAt(i))) i += 1;
      const run = text.slice(start, i);
      if (isSecretToken(run)) out.add(run.toLowerCase());
    }
    starts.lastIndex = Math.max(starts.lastIndex, end);
  }
  return [...out];
}

/**
 * 받은 링크 토큰 → 지문(활성 키). **모양을 다시 판정하지 않는다**(재검증 R1) — 모양(`isSecretToken`)은 원래 대소문자로 `secretLinkTokens` 가 한 번만
 * 본다. 여기서는 소문자로 정규화해 HMAC 만 낸다(발신 쪽 후보도 접은 — 소문자 — 보기에서 같은 정규화로 낸다). 빈 값이나 길이 범위 밖만 `null`.
 */
export function fingerprintLink(keyring: HmacKeyring, token: string, originDomain: string): CodeFingerprint | null {
  const key = keyring.keys.get(keyring.activeKid);
  const normalized = token.toLowerCase();
  if (key === undefined || normalized.length < MIN_LINK_TOKEN_CHARS || normalized.length > MAX_LINK_TOKEN_CHARS) return null;
  return { kid: keyring.activeKid, mac: macOf(key, normalized, LINK_CONTEXT), originDomain: originDomain.toLowerCase() };
}

/** 발신 보기(접은 — 소문자) → `[a-z0-9_-]` 연속 16~256자 전부. 한 번 훑는다. 상한을 넘으면 `truncated`. */
function projectLinkCandidates(folded: string, into: Set<string>): boolean {
  let i = 0;
  while (i < folded.length) {
    if (!isTokenChar(folded.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < folded.length && isTokenChar(folded.charCodeAt(i))) i += 1;
    const len = i - start;
    if (len < MIN_LINK_TOKEN_CHARS || len > MAX_LINK_TOKEN_CHARS) continue;
    if (into.size >= MAX_CODE_CANDIDATES) return true;
    into.add(folded.slice(start, i));
  }
  return false;
}

/** 받은 코드 → 지문(활성 키). 코드 모양이 아니면 `null`. */
export function fingerprintCode(keyring: HmacKeyring, code: string, originDomain: string): CodeFingerprint | null {
  const normalized = normalizeVerificationCode(code);
  const key = keyring.keys.get(keyring.activeKid);
  if (normalized === null || key === undefined) return null;
  return { kid: keyring.activeKid, mac: macOf(key, normalized), originDomain: originDomain.toLowerCase() };
}

export interface CodeProjection {
  /** 정규형 후보(중복 없음). */
  readonly candidates: ReadonlySet<string>;
  /** 후보 상한에 걸려 끝까지 투영하지 못했다. */
  readonly truncated: boolean;
}

/**
 * 접은 본문 → 코드 후보 정규형 집합. **한 번 훑는다**(원자 수 × 원자 12개 이하 연장 — 선형).
 *
 *   - 원자 = ASCII 영숫자 연속. 원자 사이가 구분자 1~3글자뿐이면 이어 붙일 수 있다(`123 456` → `123456`).
 *   - 시작 원자마다 이어 붙인 길이가 4~12 이고 숫자를 품은 것을 전부 후보로 낸다.
 *   - 원자 **안의** 숫자 연속(4~12)도 후보다(`code123456` 의 `123456`).
 */
export function projectCodeCandidates(folded: string): CodeProjection {
  // 1) 원자와 "앞 원자와 이어지는가" 를 한 번 훑어 모은다.
  const atoms: string[] = [];
  const joinable: boolean[] = [];
  const candidates = new Set<string>();
  let truncated = false;
  const add = (value: string): void => {
    if (truncated || candidates.has(value)) return;
    if (candidates.size >= MAX_CODE_CANDIDATES) {
      truncated = true;
      return;
    }
    candidates.add(value);
  };

  let i = 0;
  let separatorRun = 0;
  let bridge = false; // 직전 원자 뒤가 구분자 1~3글자만이었다
  while (i < folded.length) {
    const c = folded.charCodeAt(i);
    if (isAsciiAlnum(c)) {
      const start = i;
      while (i < folded.length && isAsciiAlnum(folded.charCodeAt(i))) i += 1;
      const atom = folded.slice(start, i);
      joinable.push(atoms.length > 0 && bridge);
      atoms.push(atom);
      // 원자 안 숫자 연속.
      let d = 0;
      while (d < atom.length) {
        if (!isDigit(atom.charCodeAt(d))) {
          d += 1;
          continue;
        }
        const ds = d;
        while (d < atom.length && isDigit(atom.charCodeAt(d))) d += 1;
        const len = d - ds;
        if (len >= MIN_CODE_CHARS && len <= MAX_CODE_CHARS && len !== atom.length) add(atom.slice(ds, d));
      }
      separatorRun = 0;
      bridge = true;
      continue;
    }
    if (SEPARATORS.has(folded[i] ?? '')) {
      separatorRun += 1;
      if (separatorRun > MAX_SEPARATOR_RUN) bridge = false;
    } else {
      bridge = false;
    }
    i += 1;
  }

  // 2) 시작 원자마다 이어 붙인다 — 길이 12 를 넘으면 멈춘다(원자 ≥1글자 → 12개 이하).
  for (let s = 0; s < atoms.length && !truncated; s += 1) {
    let value = '';
    for (let e = s; e < atoms.length; e += 1) {
      if (e > s && !joinable[e]) break;
      value += atoms[e];
      if (value.length > MAX_CODE_CHARS) break;
      if (value.length >= MIN_CODE_CHARS && /\d/.test(value)) add(value);
    }
  }
  return { candidates, truncated };
}

export interface CodeMatchResult {
  /** 받은 인증 코드가 맞았다(`verification_code`). */
  readonly hit: boolean;
  /** 받은 메일의 비밀 링크 토큰이 맞았다(`secret_link`, 재검증 — 진윤겸 결정: 사유를 코드와 나눈다). */
  readonly linkHit: boolean;
  readonly truncated: boolean;
  /** 키 묶음에 kid 가 없어 비교하지 못한 지문 수(키 회전 뒤 보존 기간이 짧았다 — ADR-0016 운영 계약). */
  readonly droppedFingerprints: number;
}

/**
 * 발신 본문(접은 보기)의 후보가 지문과 맞는가. 수신자 등록 도메인이 **전부** 출처 등록 도메인과 같은 지문은 세지 않는다 —
 * 단 출처가 **무료·공용 메일 도메인**(`gmail.com`·`naver.com` … `shared-mailbox.ts`)이면 빼지 않는다: 같은 `gmail.com` 이라도 서로 남이다.
 * 지문이 없으면(대부분의 발송) 후보를 만들지도 않는다.
 */
export function matchCodeFingerprints(
  keyring: HmacKeyring,
  /** 접은 보기 하나, 또는 여러 보기(후보를 합친다 — `scan.ts` 의 태그 지운 보기·공백 보기). */
  folded: string | readonly string[],
  fingerprints: readonly CodeFingerprint[],
  recipientDomains: readonly string[],
  /** 링크 토큰 후보를 볼 보기(재검증 N2 — 태그째 보기를 더한다: `href` 속 토큰). 없으면 `folded` 와 같다. */
  linkViews?: readonly string[],
): CodeMatchResult {
  // 수신자 **전원**이 출처 도메인일 때만 뺀다 — 출처 서비스와 공격자를 함께 수신자로 넣는 우회를 막는다. 수신자가 0명이면 빼지 않는다.
  const domains = recipientDomains.map((d) => d.toLowerCase());
  const known = fingerprints.filter((f) => keyring.keys.has(f.kid));
  const droppedFingerprints = fingerprints.length - known.length;
  const live = known.filter(
    (f) => domains.length === 0 || isSharedMailboxDomain(f.originDomain) || domains.some((d) => d !== f.originDomain),
  );
  if (live.length === 0) return { hit: false, linkHit: false, truncated: false, droppedFingerprints };

  const byKid = new Map<string, Set<string>>();
  for (const f of live) {
    const set = byKid.get(f.kid) ?? new Set<string>();
    set.add(f.mac);
    byKid.set(f.kid, set);
  }
  const views = typeof folded === 'string' ? [folded] : folded;
  const candidates = new Set<string>();
  let truncated = false;
  for (const view of views) {
    const part = projectCodeCandidates(foldDecimalDigits(view));
    truncated ||= part.truncated;
    for (const candidate of part.candidates) {
      if (candidates.size >= MAX_CODE_CANDIDATES) {
        truncated = true;
        break;
      }
      candidates.add(candidate);
    }
  }
  const links = new Set<string>();
  for (const view of linkViews ?? views) truncated = projectLinkCandidates(view, links) || truncated;
  // 맞는 것을 찾으면 그 갈래의 HMAC 을 더 내지 않는다(결과는 참/거짓뿐이다).
  const anyMac = (key: Buffer, macs: ReadonlySet<string>, values: Iterable<string>, context?: string): boolean => {
    for (const value of values) if (macs.has(macOf(key, value, context))) return true;
    return false;
  };
  let hit = false;
  let linkHit = false;
  for (const [kid, macs] of byKid) {
    const key = keyring.keys.get(kid);
    if (key === undefined) continue;
    hit ||= anyMac(key, macs, candidates);
    linkHit ||= anyMac(key, macs, links, LINK_CONTEXT);
  }
  return { hit, linkHit, truncated, droppedFingerprints };
}
