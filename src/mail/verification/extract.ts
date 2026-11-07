/**
 * src/mail/verification/extract.ts — 받은 메일 한 통에서 인증코드 후보와 확인 링크를 **결정론적으로** 뽑는다(메일 기본기 A1 · D1).
 *
 * 순수 함수다 — 네트워크·DB·LLM·시계가 없다. 입력은 조회 라우트가 `visibleToAgent` 를 거쳐 읽은 파싱 문서(제목·`text`·`htmlText`)와
 * 행의 `from_domain` 뿐이다. 링크는 **따라가지 않는다**(문자열로 파싱만 한다).
 *
 * ---------------------------------------------------------------------------
 * ## 코드 (계획 §4 A1 "코드 규칙")
 * ---------------------------------------------------------------------------
 *
 *   1. URL·메일 주소를 **같은 길이의 공백으로 가린다** — URL 안의 숫자(토큰·경로)는 후보가 아니다. 위치는 그대로라 줄·거리 계산이 맞다.
 *   2. 후보 모양: 숫자 4~8 · `123-456` 류(3~4 + 3~4) · 영숫자 6~10(숫자 ≥1, 글자 ≥1) · 한 칸씩 띄운 숫자 4~8(`4 8 2 9 1 3` —
 *      칸마다 `<td>` 인 HTML 메일이 텍스트로 바뀐 모양, 값은 붙여서 싣는다). 앞뒤가 영숫자·`_`·`-`·`#` 이면 후보가 아니다.
 *   3. 제외: 날짜·시각·버전·파일명·IP(`.`·`/`·`:`·`,` 로 숫자·글자에 붙음) · 연도 모양 4자리·`YYYYMMDD` ·
 *      전화(`1588-1234` 류 대표번호 · 앞의 `+`·`(` · 같은 줄 앞의 전화 표지) · 금액(통화 기호·단위) · 주문/송장/사업자/쿠폰/참조 번호
 *      (`EXCLUDE_CONTEXT` 가 인증 키워드보다 가까이 있을 때) · 한국어 단위(`년`·`월`·`일`·`시`·`분`·`개`·`명`·`건`·`원`·`%`).
 *   4. `high` = 인증 키워드(`CODE_KEYWORD`) 가까이 — 키워드 **뒤 첫 후보**(≤`KEYWORD_BEFORE_WINDOW` 글자·줄바꿈 ≤3), 또는 같은 줄에서
 *      키워드 **바로 앞**(≤`KEYWORD_AFTER_WINDOW` 글자, "482913 is your verification code"). 제목도 제목 안에 키워드가 있어야 `high` 다
 *      (제목과 본문은 따로 훑는다). 나머지는 `low`.
 *
 * ---------------------------------------------------------------------------
 * ## 링크 (확정 모드 전용 — 후보 모드는 이 함수를 부르지 않는다)
 * ---------------------------------------------------------------------------
 *
 * WHATWG `URL` 로 파싱하고 `https:` 만 받는다. userinfo·IP 리터럴·기본(443) 외 포트·2048자 초과는 버린다. 종류(`LINK_KIND_PATTERNS`)는
 * **URL 의 경로·쿼리로만** 정하고(2회차 수정 Y1, 보안 R1 — 링크 앞 글은 빼는 쪽으로만 본다), 종류가 없는 링크(수신 거부·약관·로고)는
 * 싣지 않는다. 리다이렉트 파라미터(`REDIRECT_PARAM_KEYS`, 값이 URL 인 파라미터 포함)·OAuth 동의·기기 로그인
 * 경로(`EXCLUDED_LINK_PATH`)가 든 링크도 싣지 않는다(1차 수정 X1, 보안 M2). 호스트는 호출자가 준 `sender_domain` 범위여야 한다
 * (`hostInScope` — `include_subdomains=false` 면 **정확 일치만**, `true` 여도 **등록 가능 경계**(`registrableDomain`)를 넘지 않는다). 범위
 * 밖은 버리고 **센다**(`droppedHostMismatch` — 메트릭 `verificationLinksDroppedHostMismatch`). 최대 `MAX_LINKS` 개.
 *
 * ---------------------------------------------------------------------------
 * ## 선형 시간 (1차 수정 X1 — 보안 H1 · 코드 H2 · 보안 L3)
 * ---------------------------------------------------------------------------
 *
 * 입력은 인터넷에서 온다. 본문마다 `MAX_SCAN_CHARS` 글자만 보고, 키워드·후보·링크는 본문마다 `MAX_*_PER_SOURCE` 개까지만 본다. 후보마다
 * 하는 일은 **상수 창**이다: 줄 경계는 창(`EXCLUDE_WINDOW`·`AFTER_CONTEXT`·`LINK_LABEL_WINDOW`) 안에서만 찾고, 가까운 키워드는 정렬된
 * 위치 배열의 이분 탐색으로 찾는다(예전: 후보마다 줄 시작까지 `lastIndexOf` · 키워드 전체 선형 탐색 — 이차). 링크 끝 구두점은 정규식
 * (`[...]+$` — 점 k 개 줄에서 k²)이 아니라 끝에서부터 자르는 루프다. 적대 입력 실측은 `test/unit/mail/verification/extract.test.ts`.
 *
 * ---------------------------------------------------------------------------
 * ## 확정 모드의 발신 주소 (2회차 수정 Y1 — 보안 R1 · 코드 N2)
 * ---------------------------------------------------------------------------
 *
 * `isVerifiedModeSender` — 확정 모드는 제목(`isVerificationSubject`)에 더해 **발신 주소**도 본다: 알림형 로컬파트(`NOTIFICATION_LOCAL_PARTS`)는
 * 빼고, 발신 도메인이 공용 메일 apex 면 공급자 시스템 발신 주소(`isSharedMailboxSystemSender`)만 받는다.
 */

import {
  CODE_KEYWORD,
  CURRENCY_AFTER,
  CURRENCY_BEFORE,
  EXCLUDE_CONTEXT,
  EXCLUDE_WINDOW,
  EXCLUDED_LINK_PATH,
  LINK_EXCLUDE,
  LINK_KIND_PATTERNS,
  LINK_KINDS,
  LINK_PARAM_VALUE_IS_URL,
  NOTIFICATION_LOCAL_PARTS,
  PHONE_CONTEXT,
  REDIRECT_PARAM_KEYS,
  REPLY_PREFIX,
  SUBJECT_KEYWORD,
  type VerificationLinkKind,
} from './keywords';
import { isSharedMailboxDomain, isSharedMailboxSystemSender, registrableDomain } from './public-suffix';

/** 추출 규칙의 판. 응답의 `extractor_version` — 규칙이 바뀌면 올린다(2: 제목 문·링크 범위·리다이렉트 제외 · 3: 링크 종류는 URL 만 · 발신 주소 문). */
export const EXTRACTOR_VERSION = 'atmark-verification-3';

/** 한 번에 훑는 글자 수 상한(본문 하나당). 인증 메일은 이보다 훨씬 짧다 — 넘는 뒤쪽은 보지 않는다(선형 시간 · 상한). */
export const MAX_SCAN_CHARS = 50_000;
/** 본문 하나에서 보는 인증 키워드 수 상한. */
const MAX_KEYWORDS_PER_SOURCE = 500;
/** 본문 하나에서 보는 후보(모양이 맞는 것) 수 상한. */
const MAX_CANDIDATES_PER_SOURCE = 500;
/** 본문 하나에서 보는 링크 모양 문자열 수 상한(`URL` 파싱 횟수의 상한). */
const MAX_LINKS_SCANNED_PER_SOURCE = 500;
/** 제목에서 보는 글자 수 상한. */
const MAX_SUBJECT_CHARS = 1_000;
/** 키워드 뒤 첫 후보까지의 거리 상한(글자). */
const KEYWORD_BEFORE_WINDOW = 120;
/** 키워드 뒤 첫 후보까지 허용하는 줄바꿈 수. */
const KEYWORD_BEFORE_NEWLINES = 3;
/** 같은 줄에서 후보 뒤에 키워드가 올 때의 거리 상한(글자). */
const KEYWORD_AFTER_WINDOW = 40;
/** 확정 모드가 싣는 링크 수 상한. */
export const MAX_LINKS = 5;
/** 링크 하나의 길이 상한. */
const MAX_LINK_LENGTH = 2048;

export type CodeConfidence = 'high' | 'low';

export interface CodeCandidate {
  readonly value: string;
  readonly confidence: CodeConfidence;
}

export interface VerificationLink {
  readonly url: string;
  readonly kind: VerificationLinkKind;
}

export interface MailText {
  readonly subject: string | null;
  readonly text: string;
  readonly htmlText: string | null;
}

// ---------------------------------------------------------------------------
// 코드
// ---------------------------------------------------------------------------

const URL_LIKE = /\b(?:https?|ftp|mailto|javascript|data|file|tel|sms):[^\s<>"'()[\]{}]{1,4096}|\bwww\.[^\s<>"'()[\]{}]{1,4096}/giu;
const EMAIL_LIKE = /[^\s@<>()[\]"',;:]{1,64}@[^\s@<>()[\]"',;:]{1,255}/gu;

/** 같은 길이의 공백으로 가린다 — 위치·줄 계산이 그대로다. */
function mask(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => match.replace(/[^\n]/gu, ' '));
}

const TOKEN = /(?<![A-Za-z0-9_\-#])(?:\d{3,4}-\d{3,4}|[A-Za-z0-9]{4,10})(?![A-Za-z0-9_\-])/gu;
const SPACED_DIGITS = /(?<![A-Za-z0-9_\-#])(?<!\d )\d(?: \d){3,7}(?! ?\d)(?![A-Za-z0-9_\-])/gu;

/** 후보 모양인가. 숫자만이면 4~8, 하이픈은 3~4-3~4, 영숫자는 6~10 에 숫자·글자 둘 다. */
function isCodeShape(value: string): boolean {
  if (/^\d+$/u.test(value)) return value.length >= 4 && value.length <= 8;
  if (/^\d{3,4}-\d{3,4}$/u.test(value)) return true;
  return value.length >= 6 && value.length <= 10 && /\d/u.test(value) && /[A-Za-z]/u.test(value);
}

/** 버리는 모양 — 연도(1900~2099)·`YYYYMMDD`(날짜). */
function isDateLike(value: string): boolean {
  if (/^(?:19|20)\d{2}$/u.test(value)) return true;
  const ymd = /^((?:19|20)\d{2})(\d{2})(\d{2})$/u.exec(value);
  if (ymd === null) return false;
  const month = Number(ymd[2]);
  const day = Number(ymd[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** 대표번호(`1588-1234` 등 15xx~19xx) — 한국 고객센터 번호 모양. */
const REPRESENTATIVE_PHONE = /^1[5-9]\d{2}-\d{4}$/u;
/** 앞뒤에 붙으면 날짜·시각·버전·금액·파일명·IP 의 일부다. */
const GLUED_BEFORE = /(?:[0-9A-Za-z][./:,]|[+(]\s?)$/u;
const GLUED_AFTER = /^[./:,][0-9A-Za-z]/u;
const UNIT_AFTER = /^\s?(?:년|월|일|시|분|초|개|명|건|원|%|am\b|pm\b)/iu;

interface Found {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

interface KeywordSpan {
  readonly start: number;
  readonly end: number;
}

/** 후보 뒤에서 보는 글자 수(같은 줄) — 단위·통화·붙은 구두점. */
const AFTER_CONTEXT = 16;

const EXCLUDE_CONTEXT_ALL = new RegExp(EXCLUDE_CONTEXT.source, 'giu');
const PHONE_CONTEXT_ALL = new RegExp(PHONE_CONTEXT.source, 'giu');

/** `text` 안에서 `pattern`(전역) 의 마지막 일치 시작. `text` 는 창(≤`EXCLUDE_WINDOW`)이다. */
function lastMatchStart(pattern: RegExp, text: string): number {
  let last = -1;
  for (const match of text.matchAll(pattern)) last = match.index;
  return last;
}

function newlinesIn(text: string): number {
  let count = 0;
  for (const char of text) if (char === '\n') count += 1;
  return count;
}

/** 오름차순 `values` 에서 `value` 이상인 첫 칸(없으면 길이). */
function lowerBound(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] as number) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** 이터러블에서 조건에 맞는 것을 `limit` 개까지 — 나머지는 만들지도 않는다. */
function take<T, U>(items: Iterable<T>, limit: number, map: (item: T) => U | null): U[] {
  const out: U[] = [];
  if (limit <= 0) return out;
  for (const item of items) {
    const mapped = map(item);
    if (mapped === null) continue;
    out.push(mapped);
    if (out.length >= limit) break;
  }
  return out;
}

/** 창 `[from, to)` 을 자르되 줄바꿈이 있으면 `to` 쪽(마지막 줄바꿈 뒤)만. */
function lineTailBefore(text: string, from: number, to: number): string {
  const window = text.slice(Math.max(0, from), to);
  const newline = window.lastIndexOf('\n');
  return newline === -1 ? window : window.slice(newline + 1);
}

/** 창 `[from, to)` 을 자르되 줄바꿈이 있으면 `from` 쪽(첫 줄바꿈 앞)만. */
function lineHeadAfter(text: string, from: number, to: number): string {
  const window = text.slice(from, to);
  const newline = window.indexOf('\n');
  return newline === -1 ? window : window.slice(0, newline);
}

/** 본문(또는 제목) 하나 → 후보들(위치 순). 선형 시간 — 머리말 "선형 시간". */
function scanCodes(raw: string): { readonly value: string; readonly confidence: CodeConfidence }[] {
  const text = mask(mask(raw.slice(0, MAX_SCAN_CHARS).replace(/\r\n?/gu, '\n'), URL_LIKE), EMAIL_LIKE);
  // 키워드 자체에 제외 문맥이 들어 있으면(`your promo code is`) 키워드가 아니다. matchAll 은 겹치지 않고 위치 순이다 — 시작·끝 모두 오름차순.
  const keywords: KeywordSpan[] = take(text.matchAll(CODE_KEYWORD), MAX_KEYWORDS_PER_SOURCE, (m) =>
    EXCLUDE_CONTEXT.test(m[0]) ? null : { start: m.index, end: m.index + m[0].length },
  );
  const keywordStarts = keywords.map((keyword) => keyword.start);
  const keywordEnds = keywords.map((keyword) => keyword.end);

  const shaped = (m: RegExpExecArray | RegExpMatchArray, value: string): Found | null =>
    isCodeShape(value) ? { start: m.index as number, end: (m.index as number) + m[0].length, value } : null;
  const found: Found[] = [
    ...take(text.matchAll(TOKEN), MAX_CANDIDATES_PER_SOURCE, (m) => shaped(m, m[0])),
    ...take(text.matchAll(SPACED_DIGITS), MAX_CANDIDATES_PER_SOURCE, (m) => shaped(m, m[0].replace(/ /gu, ''))),
  ]
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_CANDIDATES_PER_SOURCE);

  const claimed = new Set<number>();
  const out: { value: string; confidence: CodeConfidence }[] = [];
  for (const candidate of found) {
    const before = lineTailBefore(text, candidate.start - EXCLUDE_WINDOW, candidate.start);
    const after = lineHeadAfter(text, candidate.end, candidate.end + AFTER_CONTEXT);

    if (GLUED_BEFORE.test(before) || GLUED_AFTER.test(after) || UNIT_AFTER.test(after)) continue;
    if (CURRENCY_BEFORE.test(before) || CURRENCY_AFTER.test(after)) continue;
    if (REPRESENTATIVE_PHONE.test(candidate.value)) continue;
    // 연도·날짜 모양은 키워드 가까이여도 후보가 아니다 — 키워드를 "차지" 하지도 않는다(뒤의 진짜 코드가 `high` 를 받게).
    if (isDateLike(candidate.value)) continue;

    // 가장 가까운 앞 키워드(끝이 후보 시작 이하) — 끝 위치 배열에서 `start` 초과 첫 칸의 앞.
    const nearestIndex = lowerBound(keywordEnds, candidate.start + 1) - 1;
    const nearest = nearestIndex >= 0 ? (keywords[nearestIndex] as KeywordSpan) : null;

    // 제외 문맥·전화 표지 — 인증 키워드보다 가까이(뒤에) 있으면 이긴다.
    const windowStart = candidate.start - before.length;
    const excludeAt = Math.max(lastMatchStart(EXCLUDE_CONTEXT_ALL, before), lastMatchStart(PHONE_CONTEXT_ALL, before));
    if (excludeAt >= 0 && (nearest === null || windowStart + excludeAt >= nearest.end)) continue;

    let confidence: CodeConfidence = 'low';
    if (nearest !== null && !claimed.has(nearestIndex) && candidate.start - nearest.end <= KEYWORD_BEFORE_WINDOW) {
      if (newlinesIn(text.slice(nearest.end, candidate.start)) <= KEYWORD_BEFORE_NEWLINES) {
        confidence = 'high';
        claimed.add(nearestIndex);
      }
    }
    if (confidence === 'low') {
      const following = keywords[lowerBound(keywordStarts, candidate.end)];
      if (following !== undefined && following.start - candidate.end <= KEYWORD_AFTER_WINDOW) {
        const gap = text.slice(candidate.end, following.start);
        if (!gap.includes('\n') && !/\d/u.test(gap) && !EXCLUDE_CONTEXT.test(gap)) confidence = 'high';
      }
    }
    // 앞의 키워드를 다른 후보가 이미 차지했으면 `low` — 키워드 뒤 **첫** 후보만 `high` 다.
    out.push({ value: candidate.value, confidence });
  }
  return out;
}

/**
 * 제목이 **인증 메일 제목**인가 — 확정 모드의 문(1차 수정 X1, 보안 M2). 인증 키워드(`SUBJECT_KEYWORD`)가 있고 답장·전달(`REPLY_PREFIX`)이
 * 아니다. 제목이 없으면 아니다. DMARC pass 는 "그 도메인이 보냈다" 일 뿐이라, 사이트가 남의 글을 자기 도메인으로 보내는 알림(GitHub 이슈
 * 댓글 등)의 본문 코드를 사이트의 코드로 주지 않기 위해서다.
 */
export function isVerificationSubject(subject: string | null): boolean {
  if (subject === null) return false;
  const head = subject.slice(0, MAX_SUBJECT_CHARS);
  return !REPLY_PREFIX.test(head) && SUBJECT_KEYWORD.test(head);
}

const NOTIFICATION_PARTS = new Set(NOTIFICATION_LOCAL_PARTS);

/** 로컬파트를 `-`·`_`·`.`·`+` 로 나눈 조각 하나라도 알림형이면 알림 주소다(`comments-noreply`·`notifications`). */
export function isNotificationSender(fromAddress: string): boolean {
  const at = fromAddress.lastIndexOf('@');
  const local = (at === -1 ? fromAddress : fromAddress.slice(0, at)).toLowerCase();
  return local.split(/[-_.+]/u).some((part) => NOTIFICATION_PARTS.has(part));
}

/**
 * 확정 모드가 이 발신 주소(소문자 `local@domain`)의 메일을 보는가(2회차 수정 Y1). 제목 문(`isVerificationSubject`)과 **함께** 쓴다.
 *   - 알림형 로컬파트(`notifications@github.com`)는 아니다 — 제목·본문을 남이 정한다(보안 R1).
 *   - 발신 도메인이 공용 메일 **apex**(`naver.com`)면 공급자 시스템 발신 주소만(`noreply@naver.com` 예, `attacker@naver.com` 아니오 — 코드 N2).
 *     하위 도메인(`accounts.kakao.com`)은 공용이 아니라 이 줄을 타지 않는다.
 */
export function isVerifiedModeSender(fromAddress: string): boolean {
  if (isNotificationSender(fromAddress)) return false;
  const domain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1);
  return !isSharedMailboxDomain(domain) || isSharedMailboxSystemSender(fromAddress);
}

/** 비교용 정규형 — 대문자, 하이픈 없음. 같은 코드의 표기 차이(`abc-123`·`ABC123`)를 합친다. */
export function normalizeCode(value: string): string {
  return value.replace(/-/gu, '').toUpperCase();
}

/**
 * 메일 한 통의 코드 후보. 제목 → `text` → `htmlText` 순으로 훑어 정규형으로 합친다(같은 값이면 높은 쪽 신뢰도). 결과는 `high` 먼저,
 * 그 안에서 나온 순서. `htmlText` 는 `text` 와 다를 때만 훑는다(HTML 에서 만든 `text` 는 같은 내용이다).
 */
export function extractCodes(mail: MailText): readonly CodeCandidate[] {
  const sources = [mail.subject ?? '', mail.text];
  if (mail.htmlText !== null && mail.htmlText !== mail.text) sources.push(mail.htmlText);
  const merged = new Map<string, { value: string; confidence: CodeConfidence; order: number }>();
  let order = 0;
  for (const source of sources) {
    for (const candidate of scanCodes(source)) {
      const key = normalizeCode(candidate.value);
      const existing = merged.get(key);
      if (existing === undefined) merged.set(key, { ...candidate, order: order++ });
      else if (candidate.confidence === 'high' && existing.confidence === 'low') merged.set(key, { ...existing, confidence: 'high' });
    }
  }
  return [...merged.values()]
    .sort((a, b) => (a.confidence === b.confidence ? a.order - b.order : a.confidence === 'high' ? -1 : 1))
    .map(({ value, confidence }) => ({ value, confidence }));
}

// ---------------------------------------------------------------------------
// 링크
// ---------------------------------------------------------------------------

const LINK_LIKE = /\bhttps?:\/\/[^\s<>"'()[\]{}]{1,4096}/giu;
/** 링크 끝에서 떼는 구두점 — 정규식이 아니라 끝에서부터 자르는 루프로(`trimTrailingPunctuation`). */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '\u2019', '\u201D', '>']);
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
/** 링크 앞에서 제외 표지(`LINK_EXCLUDE`)를 읽는 글자 수(같은 줄). */
const LINK_LABEL_WINDOW = 80;
const REDIRECT_KEYS = new Set(REDIRECT_PARAM_KEYS);
/** 경로 안에 URL 이 든 모양(`/r/https://…`·인코딩된 것). */
const URL_IN_PATH = /:\/\/|%3a%2f%2f/iu;

export interface LinkExtraction {
  readonly links: readonly VerificationLink[];
  /** 모양·종류는 받을 만했지만 호스트가 `sender_domain` 범위 밖이라 버린 인증 링크 수. */
  readonly droppedHostMismatch: number;
}

/** 확정 모드의 도메인 범위 — 호출자가 준 `sender_domain`(소문자, 공개 접미사 아님)과 `include_subdomains`. */
export interface SenderScope {
  readonly senderDomain: string;
  readonly includeSubdomains: boolean;
}

/**
 * 호스트가 확정 모드 범위 안인가. `include_subdomains=false` 면 **정확 일치만**. `true` 면 하위도 받되 **등록 가능 경계를 넘지 않는다** —
 * 하위 호스트의 등록 가능 도메인이 `sender_domain` 의 것과 같아야 한다(`sender_domain=amazonaws.com` 이어도 `x.s3.amazonaws.com` 은 남의 것).
 * 메일의 `from_domain` 과 링크 호스트 둘 다 이 규칙으로 본다.
 */
export function hostInScope(host: string, scope: SenderScope): boolean {
  if (host === scope.senderDomain) return true;
  if (!scope.includeSubdomains || !host.endsWith(`.${scope.senderDomain}`)) return false;
  const registrable = registrableDomain(scope.senderDomain);
  return registrable !== null && registrableDomain(host) === registrable;
}

function trimTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(value.charAt(end - 1))) end -= 1;
  return value.slice(0, end);
}

/** 다른 곳으로 보내는 링크인가 — 리다이렉트 키·URL 값(쿼리와 `#` 조각) · 경로 안의 URL. */
function redirects(url: URL): boolean {
  if (URL_IN_PATH.test(url.pathname)) return true;
  const params = [url.searchParams];
  if (url.hash.includes('=')) {
    const fragment = url.hash.slice(1);
    const query = fragment.indexOf('?');
    params.push(new URLSearchParams(query === -1 ? fragment : fragment.slice(query + 1)));
  }
  for (const list of params) {
    for (const [key, value] of list) {
      if (REDIRECT_KEYS.has(key.toLowerCase().replace(/[-_]/gu, ''))) return true;
      if (LINK_PARAM_VALUE_IS_URL.test(value)) return true;
    }
  }
  return false;
}

/**
 * 링크 종류 — **URL 의 경로·쿼리로만**(보안 R1). 라벨(링크 앞 글)은 제외 표지로만 본다: 알림 메일에서 라벨은 남이 쓴 글이라
 * "Confirm your account: https://github.com/octo/repo/issues/12" 가 인증 링크가 되면 안 된다.
 */
function linkKind(url: URL, label: string): VerificationLinkKind | null {
  const inUrl = `${url.pathname}${url.search}`;
  if (LINK_EXCLUDE.test(inUrl) || LINK_EXCLUDE.test(label)) return null;
  for (const kind of LINK_KINDS) if (LINK_KIND_PATTERNS[kind].test(inUrl)) return kind;
  return null;
}

/** 확정 모드 링크. `scope` 는 호출자가 준 `sender_domain` 범위(`hostInScope`). */
export function extractLinks(mail: MailText, scope: SenderScope): LinkExtraction {
  const sources = [mail.text];
  if (mail.htmlText !== null && mail.htmlText !== mail.text) sources.push(mail.htmlText);
  const seen = new Set<string>();
  const links: VerificationLink[] = [];
  let droppedHostMismatch = 0;
  for (const source of sources) {
    const text = source.slice(0, MAX_SCAN_CHARS);
    let scanned = 0;
    for (const match of text.matchAll(LINK_LIKE)) {
      scanned += 1;
      if (scanned > MAX_LINKS_SCANNED_PER_SOURCE) break;
      const raw = trimTrailingPunctuation(match[0]);
      if (raw.length > MAX_LINK_LENGTH) continue;
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        continue;
      }
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') continue;
      if (IPV4.test(url.hostname) || url.hostname.startsWith('[') || !url.hostname.includes('.')) continue;
      if (url.href.length > MAX_LINK_LENGTH) continue;
      const label = lineTailBefore(text, match.index - LINK_LABEL_WINDOW, match.index);
      const kind = linkKind(url, label);
      if (kind === null) continue;
      if (EXCLUDED_LINK_PATH.test(url.pathname) || redirects(url)) continue;
      if (!hostInScope(url.hostname, scope)) {
        droppedHostMismatch += 1;
        continue;
      }
      if (seen.has(url.href) || links.length >= MAX_LINKS) continue;
      seen.add(url.href);
      links.push({ url: url.href, kind });
    }
  }
  return { links, droppedHostMismatch };
}
