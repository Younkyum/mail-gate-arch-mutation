/**
 * src/mail/mime/parse.ts — 수신 원문(raw MIME) → 메타 + 본문 텍스트 (P3, AC-3·AC-4).
 *
 * SES receipt rule 이 S3 에 떨어뜨린 **원문 바이트**를 받아 발신자·수신자·제목·스레드
 * 헤더·날짜·첨부 목록·본문 텍스트를 뽑는다. 원문은 S3 에만 있고 Postgres 에는 이 파일이
 * 내는 메타만 들어간다(PRD 제약). P4 injection 스캐너는 여기서 나온 텍스트를 읽는다.
 *
 * **이 파일은 I/O 를 하지 않는다.** 바이트를 받아 값을 돌려준다(`ses-event.ts` 와 같은 규율).
 *
 * ---------------------------------------------------------------------------
 * ## 왜 라이브러리인가 — postal-mime 4.0.0 (정확 버전 고정)
 * ---------------------------------------------------------------------------
 *
 * MIME 을 손으로 파싱하면 거의 항상 틀린다 — 접힌 헤더, RFC 2047/2231, 전송 인코딩,
 * 경계 규칙, 중복 파라미터 하나하나가 수년 치 버그 이력이다. 후보는 둘이었다.
 *
 *   - **postal-mime** (채택): 런타임 의존성 **0개**, MIT-0, nodemailer 저자가 유지보수.
 *     최근 1년 릴리스 대부분이 보안 수정이다 — 중첩 깊이·헤더 크기 상한(2.4.6),
 *     주소 그룹 중첩 DoS(2.6.1), RFC 2047 인코딩 워드로 주소 위조(2.7.4), message/rfc822
 *     재귀 OOM(2.7.6), 중복 헤더 first-wins·NBSP 로 위장한 `From` 차단(3.0.0).
 *   - **mailparser** (기각): `nodemailer`·`iconv-lite`·`html-to-text`·`linkify-it`·`tlds` 등
 *     10개를 끌고 온다. **`nodemailer` 는 SMTP 발송 라이브러리다** — AC-8("SES SDK 를 import
 *     하는 파일은 하나") 의 정신과 정면으로 부딪히는 발송 능력이 의존성 트리에 들어온다.
 *     스트리밍은 장점이지만, 입력 상한을 40 MiB 로 두면 버퍼 파싱으로 충분하다.
 *
 * 버전을 **정확히** 고정한 이유: 아래 두 곳이 라이브러리의 비공개 표면에 기대고 있다 —
 * ① 한도 초과 예외를 메시지 문자열로 분류(`classifyParserError`), ② 파트 트리를
 * `parser.root` 로 읽음(`readPartTree`). 둘 다 **테스트가 모양을 고정**한다
 * (`test/unit/mail/mime-parse-adversarial.test.ts`). 올릴 때 그 테스트가 먼저 빨개진다.
 *
 * ---------------------------------------------------------------------------
 * ## 던지지 않는다 — 입력 때문에는
 * ---------------------------------------------------------------------------
 *
 * 인터넷에서 들어온 바이트는 공격 표면이다. 크기·깊이·헤더 상한을 넘거나 발신자가 모호한
 * 메일은 **값**(`{kind:'rejected'}`)으로 돌려준다. 큐 소비자에서 던지면 재전달되고, 파싱할 수
 * 없는 메일은 재전달해도 파싱되지 않는다 — poison pill 이다(`ses-event.ts` 머리말).
 *
 * **예외: 첨부 싱크(`onAttachment`)가 던진 것은 그대로 올라간다.** 그것은 입력의 문제가
 * 아니라 저장소(S3)의 일시 장애이고, **재시도해야 하는** 실패다. 둘을 같은 값으로 접으면
 * 일시 장애가 영구 거부로 기록된다.
 *
 * ---------------------------------------------------------------------------
 * ## 출력 규율
 * ---------------------------------------------------------------------------
 *
 *   - **첨부 바이트는 출력에 없다.** 위치(index)·크기·타입만. 바이트는 싱크로 흘려보내고
 *     이 함수가 돌아올 때 라이브러리 결과와 함께 버려진다.
 *   - **본문 외의 모든 문자열 필드에 제어문자가 없다**(C0·DEL·C1). 제목·표시 이름은 이후
 *     답장 헤더(`Re: ...`)로 다시 나가고, NUL 은 Postgres `text` 가 거부한다 — 메타 INSERT 가
 *     죽으면 그것도 poison pill 이다.
 *   - **주소는 전부 `isAddressShape` 를 통과한다**(정책 로더·DB CHECK 와 같은 정규식).
 *   - **경고의 `detail` 에 메일 내용을 싣지 않는다.** 헤더 이름·charset 라벨·숫자만.
 *     경고는 로그로 가고, 로그에 주소·제목이 들어가면 관측 경계(§4.3)가 무너진다.
 */

import PostalMime, { addressParser, decodeWords, type Address, type Email } from 'postal-mime';

import { isAddressShape } from '../../policy/policy-loader';
import { isMessageIdHeader } from '../message-id';
import {
  classifyCharset,
  decodeKoreanLegacy,
  describeCharsetLabel,
  rewriteKoreanEncodedWords,
} from './parse-charset';
import { htmlHiddenText, htmlToText } from './parse-html';

// ---------------------------------------------------------------------------
// 상한
// ---------------------------------------------------------------------------

export interface MimeParseLimits {
  /** 원문 전체. SES 수신 최대치(40 MB)와 같다 — SES 가 받은 것을 여기서 버리면 메일 유실이다. */
  readonly maxRawBytes: number;
  /** 모든 파트의 헤더 합계. 긴 `Received` 체인도 수십 KB 다. 라이브러리 기본 2 MiB 는 너무 넓다. */
  readonly maxHeaderBytes: number;
  /** multipart 중첩. 실제 메일은 5단을 넘기 어렵다. 라이브러리 기본 256 은 사실상 무제한이다. */
  readonly maxNestingDepth: number;
  /** 인라인 message/rfc822 재귀. 넘으면 파싱하지 않고 첨부로 남긴다(경고). */
  readonly maxRfc822NestingDepth: number;
  /** 파트 수(multipart 컨테이너 포함). 파트마다 첨부 행·S3 객체가 생긴다 — 증폭 상한. */
  readonly maxParts: number;
  /** `text`·`htmlText` 각각. 확인 코드는 앞에 있다. 스캐너 입력을 유한하게 한다. */
  readonly maxTextChars: number;
  readonly maxSubjectChars: number;
  /** `to`·`cc`·`replyTo` 각각. 헤더 상한 안에서도 주소 수천 개는 만들 수 있다. */
  readonly maxAddressesPerField: number;
  /** `references` — **뒤쪽**(가장 가까운 조상)을 남긴다. */
  readonly maxReferences: number;
}

export const DEFAULT_MIME_PARSE_LIMITS: MimeParseLimits = {
  maxRawBytes: 40 * 1024 * 1024,
  maxHeaderBytes: 256 * 1024,
  maxNestingDepth: 16,
  maxRfc822NestingDepth: 3,
  maxParts: 500,
  maxTextChars: 1_000_000,
  maxSubjectChars: 2_000,
  maxAddressesPerField: 500,
  maxReferences: 100,
};

// ---------------------------------------------------------------------------
// 출력 타입 — 닫힌 모양. optional 없음, 없는 값은 `null`.
// ---------------------------------------------------------------------------

export interface ParsedAddress {
  /** `isAddressShape` 통과, 제어문자 없음. **정규화하지 않았다** — `+태그` 도 대소문자도 원문 그대로. */
  readonly address: string;
  /** 디코딩된 표시 이름(RFC 2047). 없으면 `null`. 제어문자는 공백으로 바뀌어 있다. */
  readonly name: string | null;
}

export interface ParsedAttachment {
  /** 원문 속 등장 순서(0부터). 싱크 호출 순서와 같다 — 저장 조각이 이것으로 짝을 맞춘다. */
  readonly index: number;
  /** RFC 2047·2231 디코딩된 이름. **경로 문자(`/`·`\`·`..`)는 그대로다** — 저장 키로 쓰지 마라. */
  readonly filename: string | null;
  /** 소문자 MIME 타입(`application/pdf`). 발신자가 선언한 값이다 — 내용과 일치한다는 보장은 없다. */
  readonly contentType: string;
  readonly disposition: 'attachment' | 'inline' | null;
  /** 전송 인코딩을 푼 **디코딩 후** 바이트 수. */
  readonly size: number;
  /** `Content-ID` 원문(꺾쇠 포함 가능). 인라인 이미지의 `cid:` 참조 대상. */
  readonly contentId: string | null;
}

export type MimeParseWarningCode =
  /** RFC 5322 상 한 번만 와야 하는 헤더가 여럿이다. 첫 번째를 썼다(`to`·`cc` 는 합집합). */
  | 'duplicate_header'
  /** 모양이 주소가 아니거나 제어문자가 있어 버린 주소. detail 은 필드 이름. */
  | 'invalid_address'
  /** 제어문자를 지웠다(본문) 또는 공백으로 바꿨다(헤더). detail 은 필드 이름. */
  | 'control_chars_removed'
  /**
   * 그중 **C1**(U+0080–U+009F)이 있었다. detail 은 필드 이름. 정상 디코딩은 C1 을 내지 않는다 — 파서 차이 공격
   * (CP949 확장 음절 → C1 + ASCII)의 흔적이다. 개수·교대 길이는 `ParsedInboundMessage.c1Removed` 에.
   */
  | 'c1_controls_removed'
  | 'invalid_message_id'
  | 'invalid_date'
  /** 디코딩할 수 없는 charset — windows-1252 로 읽혔다. 본문이 깨졌을 수 있다. */
  | 'unknown_charset'
  /** `multipart/*` 인데 `boundary` 가 없다 — 그 파트의 내용은 텍스트로도 첨부로도 나오지 않는다. */
  | 'multipart_missing_boundary'
  /** message/rfc822 가 재귀 상한을 넘어 파싱되지 않고 첨부로 남았다. */
  | 'nested_message_depth_exceeded'
  /**
   * `Content-Disposition` 이 `attachment`·`inline` 이 아니다(`form-data` 등). RFC 2183 §2.8 대로 `attachment` 로 다뤘다.
   * detail 은 `attachments[i]` — 토큰 원문은 싣지 않는다(발신자가 정한 값).
   */
  | 'unknown_disposition'
  | 'text_truncated'
  | 'subject_truncated'
  | 'addresses_truncated'
  | 'references_truncated'
  /** 라이브러리 내부 파트 트리를 읽지 못했다 — 본문 선택·charset 경고가 축소 모드로 돌았다. */
  | 'part_tree_unavailable';

export interface MimeParseWarning {
  readonly code: MimeParseWarningCode;
  /** 헤더 이름·필드 이름·charset 라벨·숫자. **메일 내용(주소·제목·본문)은 싣지 않는다.** */
  readonly detail: string;
}

/**
 * 파서가 **지운(본문) 또는 공백으로 바꾼(헤더)** C1 제어문자의 흔적. 지우고 나면 injection 스캐너가 그 사실을
 * 볼 수 없으므로 여기 남겨 넘긴다(`scanForInjection` 입력 `c1Removed` — 모양이 같다).
 */
export interface C1Removal {
  readonly field: 'subject' | 'text' | 'htmlText' | 'attachmentName';
  /** 첨부 파일명이면 첨부 순서(`ParsedAttachment.index`), 아니면 0. */
  readonly index: number;
  readonly count: number;
  /** "C1 바로 뒤에 인쇄 가능 ASCII" 쌍이 연속한 최장 개수. 파서 차이 공격은 이것이 길다(`갏갍갢…` → C1·ASCII 교대). */
  readonly longestAlternation: number;
}

export interface ParsedInboundMessage {
  /** `<local@domain>` — `messages.message_id_header` CHECK 와 같은 모양. 없거나 깨졌으면 `null`. */
  readonly messageId: string | null;
  /** 첫 번째 유효 msg-id. */
  readonly inReplyTo: string | null;
  /** 유효 msg-id 만, 원문 순서(오래된 것 → 가까운 것). */
  readonly references: readonly string[];
  /** **항상 있다.** 없거나 모호하면 거부됐다(`MimeRejectReason`). */
  readonly from: ParsedAddress;
  readonly to: readonly ParsedAddress[];
  readonly cc: readonly ParsedAddress[];
  /** 회신 대상. 비었으면 `from` 에게 회신한다. 가입 확인 메일은 흔히 no-reply 로 온다. */
  readonly replyTo: readonly ParsedAddress[];
  /** 헤더가 없으면 `null`. 있으면 제어문자 없는 한 줄. */
  readonly subject: string | null;
  readonly date: Date | null;
  /**
   * 에이전트·스캐너가 읽는 본문. 실제 text/plain 파트가 있고 비어 있지 않으면 그것,
   * 아니면 HTML 을 변환한 것. 개행은 `\n`, 탭·개행 외 제어문자 없음.
   */
  readonly text: string;
  readonly textSource: 'plain' | 'html' | 'none';
  /**
   * HTML 파트를 변환한 텍스트(없으면 `null`). **`text` 가 plain 이어도 채운다.** 한국 서비스의
   * 확인 메일은 plain 파트에 "HTML 을 지원하지 않습니다" 만 넣고 코드는 HTML 에만 두는 경우가
   * 있다 — 코드 추출기와 P4 스캐너는 **둘 다** 봐야 한다.
   */
  readonly htmlText: string | null;
  /**
   * HTML 파트에서 **숨긴 요소**(인라인 `display:none` · `hidden` · 0 크기 · 글자색 = 배경색 …)의 글만(`parse-html.ts` `htmlHiddenText`).
   * `htmlText` 에도 이미 들어 있다 — 이 필드는 "숨겼다" 는 사실을 스캐너에 따로 넘기는 것이다. 숨긴 글이 없거나 HTML 이 없으면 `null`.
   * 에이전트에게 보여 주는 면이 아니다(스캐너 입력 전용).
   */
  readonly hiddenText: string | null;
  readonly attachments: readonly ParsedAttachment[];
  readonly warnings: readonly MimeParseWarning[];
  /** 제목·본문·첨부 파일명에서 지운 C1 의 흔적(없으면 빈 배열). 내용은 싣지 않는다 — 개수뿐. */
  readonly c1Removed: readonly C1Removal[];
}

export type MimeRejectReason =
  | 'empty'
  | 'too_large'
  | 'headers_too_large'
  | 'nesting_too_deep'
  | 'too_many_parts'
  /** `From` 헤더가 없다. */
  | 'missing_from'
  /** `From` 이 여러 개거나, 한 헤더에 주소가 여럿이거나, 그룹이다 — **어느 것도 믿지 않는다.** */
  | 'ambiguous_from'
  /** `From` 이 주소 모양이 아니거나 원문에 제어문자가 있다(bare CR·NUL 인젝션). */
  | 'invalid_from'
  /** 위 어디에도 속하지 않는 라이브러리 예외. */
  | 'unparsable';

export type MimeParseResult =
  | { readonly kind: 'parsed'; readonly message: ParsedInboundMessage }
  /** **재시도해도 결과가 같다.** 원문은 S3 에 남아 있으니 조사는 거기서 한다. */
  | { readonly kind: 'rejected'; readonly reason: MimeRejectReason; readonly detail: string };

/**
 * 첨부 바이트를 받는 포트. 저장(S3)은 다른 조각의 몫이다 — 이 파일은 넘겨주기만 한다.
 * `content` 는 호출이 끝난 뒤 참조를 유지하지 마라(복사해서 쓰거나 즉시 흘려보내라).
 * **여기서 던지면 `parseInboundMime` 도 던진다**(머리말 — 일시 장애는 재시도 대상이다).
 */
export type AttachmentSink = (attachment: ParsedAttachment, content: Uint8Array) => Promise<void> | void;

export interface MimeParseOptions {
  readonly limits?: Partial<MimeParseLimits>;
  readonly onAttachment?: AttachmentSink;
}

// ---------------------------------------------------------------------------
// 제어문자
// ---------------------------------------------------------------------------

/**
 * 헤더 값의 제어문자 — `build.ts` 의 `HEADER_UNSAFE` 와 **같은 집합**(C0·DEL·C1).
 * 그쪽은 나가는 값에서 던지고, 여기는 들어오는 값에서 공백으로 바꾸거나 버린다.
 */
const HEADER_CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const HEADER_CONTROL_RUNS = /[\x00-\x1f\x7f-\x9f]+/g;
/** 본문에서 지우는 것 — 위와 같되 탭·개행은 남긴다. `test` 용과 `replace` 용을 나눈다(`g` 의 lastIndex). */
const TEXT_CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const TEXT_CONTROL_ALL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

const C1_ANY = /[\x80-\x9f]/;

/** 헤더 안 RFC 2047 인코딩 워드의 charset 라벨(`=?euc-kr?B?`). `matchAll` 은 정규식을 복제하므로 모듈 상수로 둬도 된다 — **`matchAll` 전용**(`g` 라 `.test`/`.exec` 는 `lastIndex` 가 남는다). */
const ENCODED_WORD_CHARSET = /=\?([^?\s*]+)(?:\*[^?\s]*)?\?[bBqQ]\?/g;

const UTF8_ENCODER = new TextEncoder();

/**
 * C1 개수와 "C1·ASCII 교대" 최장 길이. 한 번 훑는다. C1 이 없으면 `null`(흔한 경우 — 정규식 한 번으로 끝).
 * 판정(몇 개부터 공격인가)은 이 파일의 일이 아니다 — 스캐너가 한다.
 */
function c1Stats(value: string): { readonly count: number; readonly longestAlternation: number } | null {
  if (!C1_ANY.test(value)) return null;
  let count = 0;
  let run = 0;
  let longest = 0;
  let i = 0;
  while (i < value.length) {
    const c = value.charCodeAt(i);
    if (c >= 0x80 && c <= 0x9f) {
      count += 1;
      const next = value.charCodeAt(i + 1);
      if (next >= 0x21 && next <= 0x7e) {
        run += 1;
        if (run > longest) longest = run;
        i += 2;
        continue;
      }
    }
    run = 0;
    i += 1;
  }
  return { count, longestAlternation: longest };
}

/** RFC 5322 §3.6 에서 한 번만 올 수 있는 헤더 중 `from` 을 뺀 것(`from` 은 거부 사유다). */
const SINGLETON_HEADERS = [
  'sender', 'reply-to', 'to', 'cc', 'bcc', 'message-id', 'in-reply-to', 'references', 'subject', 'date',
] as const;

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

/** 원문 한 통을 파싱한다. 입력 때문에 던지지 않는다(머리말). */
export async function parseInboundMime(
  raw: Uint8Array,
  options: MimeParseOptions = {},
): Promise<MimeParseResult> {
  const limits: MimeParseLimits = { ...DEFAULT_MIME_PARSE_LIMITS, ...options.limits };

  if (raw.byteLength === 0) return reject('empty', '원문이 0바이트다');
  // **파싱 전에** 자른다. 라이브러리는 입력을 한 번 통째로 복사하고 첨부를 디코딩해 들고
  // 있다 — 상한 검사를 파싱 뒤에 두면 막으려던 메모리를 이미 쓴 뒤다.
  if (raw.byteLength > limits.maxRawBytes) {
    return reject('too_large', `${String(raw.byteLength)} > ${String(limits.maxRawBytes)} 바이트`);
  }

  const parser = new PostalMime({
    maxNestingDepth: limits.maxNestingDepth,
    maxHeadersSize: limits.maxHeaderBytes,
    maxRfc822NestingDepth: limits.maxRfc822NestingDepth,
    attachmentEncoding: 'arraybuffer',
  });
  let email: Email;
  try {
    email = await parser.parse(raw);
  } catch (error) {
    return classifyParserError(error);
  }

  const warnings: MimeParseWarning[] = [];
  const seenWarnings = new Set<string>();
  const warn = (code: MimeParseWarningCode, detail: string): void => {
    // 같은 경고는 한 번만. 주소 500개가 전부 같은 이유로 걸리면 경고 500줄이 로그로 간다.
    const key = `${code}\u0000${detail}`;
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    warnings.push({ code, detail });
  };

  // --- 파트 구조 ----------------------------------------------------------
  const tree = readPartTree(parser);
  if (tree === null) warn('part_tree_unavailable', 'postal-mime 내부 모양이 기대와 다르다');
  const partCount = tree?.length ?? email.attachments.length;
  if (partCount > limits.maxParts) {
    return reject('too_many_parts', `${String(partCount)} > ${String(limits.maxParts)}`);
  }

  // --- 발신자 — 모호하면 거부 ----------------------------------------------
  const fromResult = resolveFrom(email, warn);
  if ('reason' in fromResult) return reject(fromResult.reason, fromResult.detail);

  for (const key of SINGLETON_HEADERS) {
    const count = email.headers.filter((header) => header.key === key).length;
    if (count > 1) warn('duplicate_header', `${key} × ${String(count)}`);
  }

  // --- charset 경고 -------------------------------------------------------
  const labels = new Set<string>();
  for (const part of tree ?? []) {
    if (part.multipart && !part.hasBoundary) warn('multipart_missing_boundary', part.mediaType);
    if (part.charset !== null && part.readText !== null) labels.add(part.charset);
  }
  for (const header of email.headers) {
    for (const match of header.value.matchAll(ENCODED_WORD_CHARSET)) {
      if (match[1] !== undefined) labels.add(match[1]);
    }
  }
  for (const label of labels) {
    if (classifyCharset(label) === 'unknown') warn('unknown_charset', describeCharsetLabel(label));
  }

  // --- 헤더 필드 -----------------------------------------------------------
  const firstHeader = (key: string): string | null =>
    email.headers.find((header) => header.key === key)?.value ?? null;

  const messageIdHeader = firstHeader('message-id');
  const messageId = messageIdHeader === null ? null : (extractMessageIds(messageIdHeader)[0] ?? null);
  if (messageIdHeader !== null && messageId === null) warn('invalid_message_id', 'message-id');

  const inReplyToHeader = firstHeader('in-reply-to');
  const inReplyTo = inReplyToHeader === null ? null : (extractMessageIds(inReplyToHeader)[0] ?? null);
  if (inReplyToHeader !== null && inReplyTo === null) warn('invalid_message_id', 'in-reply-to');

  let references = extractMessageIds(firstHeader('references') ?? '');
  if (references.length > limits.maxReferences) {
    warn('references_truncated', `${String(references.length)} > ${String(limits.maxReferences)}`);
    references = references.slice(-limits.maxReferences);
  }

  // 헤더의 인코딩 워드는 라이브러리가 풀되, 한국어 레거시 charset 워드만 먼저 UTF-8 로
  // 바꿔 쓴다(`parse-charset.ts` 머리말 — Node 의 euc-kr 디코더는 CP949 확장을 삼킨다).
  const c1Removed: C1Removal[] = [];
  const noteC1 = (value: string, field: C1Removal['field'], index: number, warnField: string): void => {
    const stats = c1Stats(value);
    if (stats === null) return;
    warn('c1_controls_removed', warnField);
    c1Removed.push({ field, index, ...stats });
  };

  const subjectHeader = firstHeader('subject');
  let subject: string | null = null;
  if (subjectHeader !== null) {
    const decodedSubject = decodeWords(rewriteKoreanEncodedWords(subjectHeader));
    noteC1(decodedSubject, 'subject', 0, 'subject');
    subject = sanitizeHeaderText(decodedSubject, 'subject', warn);
    if (subject.length > limits.maxSubjectChars) {
      warn('subject_truncated', `${String(subject.length)} > ${String(limits.maxSubjectChars)}`);
      subject = subject.slice(0, limits.maxSubjectChars);
    }
  }

  const dateHeader = firstHeader('date');
  let date: Date | null = null;
  if (dateHeader !== null) {
    const parsed = new Date(email.date ?? dateHeader);
    if (Number.isNaN(parsed.getTime())) warn('invalid_date', 'date');
    else date = parsed;
  }

  // 같은 헤더가 여럿이면 합집합(라이브러리와 같은 규칙). 라이브러리의 `email.to` 를 쓰지 않는
  // 이유는 제목과 같다 — 표시 이름의 인코딩 워드를 먼저 바꿔 써야 한다.
  const addressField = (field: 'to' | 'cc' | 'reply-to'): ParsedAddress[] => {
    // 주소 파서는 주소 안의 제어문자를 **조용히 지운다**(`a\x01b@x` → `ab@x`). From 은 그래서
    // 거부하고, 수신 필드는 신뢰 판정에 쓰이지 않으므로(라우팅은 SES 봉투 수신자) 경고만 남긴다.
    if (email.headerLines.some((line) => line.key === field && hasRawControl(line.line))) {
      warn('control_chars_removed', `${field} (원문)`);
    }
    return collectAddresses(
      field,
      email.headers
        .filter((header) => header.key === field)
        .flatMap((header) => addressParser(rewriteKoreanEncodedWords(header.value))),
      limits.maxAddressesPerField,
      warn,
    );
  };

  // --- 본문 ---------------------------------------------------------------
  // 트리가 있으면 본문은 **파트 바이트에서 직접** 모은다. 라이브러리의 `email.text` 를 쓰지
  // 않는 이유 둘: ① HTML 만 있는 메일에도 `text` 를 채워 주는데 그 변환은 `<style>` 을 남기고,
  // 그래서 "실제 text/plain 파트가 있었는가" 를 출력만으로는 모른다. ② 한국어 레거시 charset
  // 은 라이브러리 경로에서 조용히 깨진다(`parse-charset.ts`).
  const body = tree === null ? bodyFromLibrary(email) : bodyFromTree(tree);
  let htmlText: string | null = null;
  let hiddenText: string | null = null;
  if (body.html.length > 0) {
    const hidden = body.html.map(htmlHiddenText).filter((part) => part !== '').join('\n\n');
    if (hidden !== '') hiddenText = sanitizeBody(hidden, 'hiddenText', limits.maxTextChars, () => undefined);
    // 엔티티(`&#x8c;`)로 넣은 C1 도 변환 뒤에 보인다 — 변환한 뒤에 센다.
    const converted = body.html.map(htmlToText).join('\n\n');
    noteC1(converted, 'htmlText', 0, 'htmlText');
    htmlText = sanitizeBody(converted, 'htmlText', limits.maxTextChars, warn);
  }
  const plainJoined = body.plain.join('\n');
  noteC1(plainJoined, 'text', 0, 'text');
  const plainText = sanitizeBody(plainJoined, 'text', limits.maxTextChars, warn);

  let text = '';
  let textSource: ParsedInboundMessage['textSource'] = 'none';
  if (plainText.trim() !== '') {
    text = plainText;
    textSource = 'plain';
  } else if (htmlText !== null && htmlText !== '') {
    text = htmlText;
    textSource = 'html';
  }

  // --- 첨부 — 바이트는 싱크로, 출력에는 메타만 ----------------------------------
  const attachments: ParsedAttachment[] = [];
  for (const [index, attachment] of email.attachments.entries()) {
    if (attachment.rfc822DepthExceeded === true) {
      warn('nested_message_depth_exceeded', `attachments[${String(index)}]`);
    }
    const content = toBytes(attachment.content);
    if (attachment.filename !== null) noteC1(attachment.filename, 'attachmentName', index, 'attachment.filename');
    const meta: ParsedAttachment = {
      index,
      filename:
        attachment.filename === null
          ? null
          : sanitizeHeaderText(attachment.filename, 'attachment.filename', warn),
      // 발신자가 정한 값 — 제어문자를 거른다(NUL 은 22021 로 저장 실패 → unstorable 유실, C1 은 저장돼 에이전트에게 간다).
      contentType: sanitizeHeaderText(attachment.mimeType, 'attachment.contentType', warn).toLowerCase() || 'application/octet-stream',
      disposition: closedDisposition(attachment.disposition, index, warn),
      size: content.byteLength,
      contentId:
        attachment.contentId === undefined
          ? null
          : sanitizeHeaderText(attachment.contentId, 'attachment.contentId', warn),
    };
    attachments.push(meta);
    if (options.onAttachment !== undefined) await options.onAttachment(meta, content);
  }

  return {
    kind: 'parsed',
    message: {
      messageId,
      inReplyTo,
      references,
      from: fromResult.address,
      to: addressField('to'),
      cc: addressField('cc'),
      replyTo: addressField('reply-to'),
      subject,
      date,
      text,
      textSource,
      htmlText,
      hiddenText,
      attachments,
      warnings,
      c1Removed,
    },
  };
}

// ---------------------------------------------------------------------------
// 거부
// ---------------------------------------------------------------------------

function reject(reason: MimeRejectReason, detail: string): MimeParseResult {
  return { kind: 'rejected', reason, detail };
}

/**
 * 라이브러리 예외 → 거부 사유. postal-mime 은 한도 초과를 **메시지만 다른 `Error`** 로 던진다.
 * 문자열 대조가 취약한 것은 알고 있다 — 그래서 버전을 고정했고, 깊이·헤더 테스트가 사유를
 * `unparsable` 이 아니라 정확한 값으로 단언한다. 문구가 바뀌면 그 테스트가 빨개진다.
 */
function classifyParserError(error: unknown): MimeParseResult {
  const message = error instanceof Error ? error.message : String(error);
  if (/Maximum MIME nesting depth/i.test(message)) return reject('nesting_too_deep', message);
  if (/Maximum header size/i.test(message)) return reject('headers_too_large', message);
  const name = error instanceof Error ? error.name : typeof error;
  return reject('unparsable', `${name}: ${message.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// From
// ---------------------------------------------------------------------------

type FromResolution =
  | { readonly address: ParsedAddress }
  | { readonly reason: MimeRejectReason; readonly detail: string };

/**
 * `From` 은 **정확히 헤더 1개 · 메일박스 1개 · 제어문자 없음 · 주소 모양**이어야 한다.
 *
 * 왜 첫 번째를 믿지 않고 거부하는가: `From` 이 둘이면 수신 MTA·DMARC 검사기·메일 클라이언트가
 * 서로 다른 쪽을 고른다. 공격자는 검사기가 보는 쪽에 자기 도메인(통과)을, 사람이 보는 쪽에
 * 은행 주소를 둔다. 우리 뒤에는 Sender Trust(P4)와 "확인 코드 발신자 자동 승인" 규칙이
 * 있다 — 모호한 발신자를 하나로 골라 주는 순간 **그 선택이 신뢰 판정이 된다.**
 * 정상 메일은 이 조건을 어기지 않는다(RFC 5322 §3.6). 잃는 것이 거의 없다.
 *
 * 라이브러리의 `email.from` 을 쓰지 않는 이유: 그것은 **첫 번째 주소 하나**만 준다.
 * `From: a@x, b@y` 도, bare CR 로 만든 그룹(`From: a@b.com\rBcc: x@y.com` →
 * 그룹 "a@b.com Bcc" 안의 `x@y.com`)도 거기서는 멀쩡한 한 주소로 보인다.
 */
function resolveFrom(email: Email, warn: Warn): FromResolution {
  const headers = email.headers.filter((header) => header.key === 'from');
  if (headers.length === 0) return { reason: 'missing_from', detail: 'From 헤더가 없다' };
  if (headers.length > 1) {
    return { reason: 'ambiguous_from', detail: `From 헤더가 ${String(headers.length)}개다` };
  }

  // 주소 파서는 NUL 을 조용히 지우고(`adm\0in@x` → `admin@x`) 라이브러리는 헤더 값의 CR·LF 를 공백으로 바꾼다 — 제어문자는 가공 전 원문 줄에서 본다(`hasRawControl`).
  const rawLine = email.headerLines.find((line) => line.key === 'from')?.line ?? '';
  if (hasRawControl(rawLine)) {
    return { reason: 'invalid_from', detail: 'From 원문에 제어문자가 있다' };
  }

  const value = headers[0]?.value ?? '';
  const parsed = addressParser(rewriteKoreanEncodedWords(value));
  if (parsed.length !== 1) {
    return { reason: 'ambiguous_from', detail: `From 에 주소가 ${String(parsed.length)}개다` };
  }
  const mailbox = parsed[0];
  if (mailbox === undefined || mailbox.group !== undefined) {
    return { reason: 'ambiguous_from', detail: 'From 이 그룹 문법이다' };
  }
  const address = mailbox.address.trim();
  if (!isAddressShape(address) || HEADER_CONTROL.test(address)) {
    return { reason: 'invalid_from', detail: 'From 이 주소 모양이 아니다' };
  }
  return { address: { address, name: displayName(mailbox.name, 'from', warn) } };
}

// ---------------------------------------------------------------------------
// 주소 · msg-id · 문자열 정리
// ---------------------------------------------------------------------------

type Warn = (code: MimeParseWarningCode, detail: string) => void;

/**
 * postal-mime 은 `Content-Disposition` 토큰을 소문자로 바꿔 그대로 넘긴다(4.0 부터 타입도 `string`).
 * 출력은 닫힌 집합이어야 한다 — DB 의 `inbound_attachments.disposition` CHECK 가 둘만 받으므로, 낯선 토큰이
 * 그대로 가면 저장이 실패하고 메일이 unstorable 로 거부되어 유실된다. 낯선 값은 RFC 2183 §2.8 대로 `attachment`.
 */
function closedDisposition(value: string | null, index: number, warn: Warn): ParsedAttachment['disposition'] {
  if (value === null || value === 'attachment' || value === 'inline') return value;
  warn('unknown_disposition', `attachments[${String(index)}]`);
  return 'attachment';
}

/**
 * 가공 전 헤더 줄(`email.headerLines[].line`)에 제어문자가 있는가. 접힌 줄은 `\n` + 공백/탭으로
 * 이어져 있다 — 그 접힘과 탭만 걷어 내고 본다. bare CR·NUL 은 여기서만 보인다(라이브러리는
 * 헤더 값의 CR·LF 를 공백으로 바꾸고, 주소 파서는 NUL 을 지운다).
 */
function hasRawControl(line: string): boolean {
  return HEADER_CONTROL.test(line.replace(/\n(?=[ \t])/g, '').replace(/\t/g, ' '));
}

function displayName(raw: string, field: string, warn: Warn): string | null {
  const name = sanitizeHeaderText(raw, `${field}.name`, warn);
  return name === '' ? null : name;
}

/** 그룹은 펼친다(`undisclosed-recipients:;` 는 0개). 모양이 아닌 주소는 버리고 경고한다. */
function collectAddresses(
  field: string,
  parsed: readonly Address[],
  max: number,
  warn: Warn,
): ParsedAddress[] {
  const out: ParsedAddress[] = [];
  let invalid = 0;
  let total = 0;
  for (const entry of parsed) {
    const mailboxes = entry.group ?? [entry];
    for (const mailbox of mailboxes) {
      const address = (mailbox.address ?? '').trim();
      if (!isAddressShape(address) || HEADER_CONTROL.test(address)) {
        invalid += 1;
        continue;
      }
      total += 1;
      if (out.length < max) out.push({ address, name: displayName(mailbox.name, field, warn) });
    }
  }
  if (invalid > 0) warn('invalid_address', `${field} × ${String(invalid)}`);
  if (total > max) warn('addresses_truncated', `${field}: ${String(total)} > ${String(max)}`);
  return out;
}

/**
 * 헤더 값에서 msg-id 들을 꺼낸다. `messages.message_id_header` CHECK 와 같은 모양
 * (`isMessageIdHeader`)만 남긴다 — 그 CHECK 를 통과하지 못하는 값을 스레드 키로 쓰면
 * 나중에 조인이 조용히 비거나 INSERT 가 죽는다.
 *
 * 꺾쇠 없이 `id@host` 만 쓰는 망가진 MTA 가 있다. 값 전체가 그 모양일 때만 꺾쇠를 씌운다.
 */
function extractMessageIds(value: string): string[] {
  const bracketed = value.match(/<[^<>]*>/g);
  const candidates = bracketed ?? (/^\s*[^<>\s]+@[^<>\s]+\s*$/.test(value) ? [`<${value.trim()}>`] : []);
  return candidates.filter((id) => isMessageIdHeader(id) && !HEADER_CONTROL.test(id));
}

/** 헤더에서 온 문자열: 제어문자 → 공백, 한 줄, 앞뒤 공백 제거. 탭은 접힘의 흔적이라 경고하지 않는다. */
function sanitizeHeaderText(value: string, field: string, warn: Warn): string {
  const untabbed = value.replace(/\t/g, ' ');
  if (!HEADER_CONTROL.test(untabbed)) return untabbed.trim();
  warn('control_chars_removed', field);
  return untabbed.replace(HEADER_CONTROL_RUNS, ' ').trim();
}

/** 본문: 개행을 `\n` 으로 통일하고 탭·개행 외 제어문자를 지운 뒤 길이를 자른다. */
function sanitizeBody(value: string, field: string, max: number, warn: Warn): string {
  let text = value.replace(/\r\n?/g, '\n');
  if (TEXT_CONTROL.test(text)) {
    warn('control_chars_removed', field);
    text = text.replace(TEXT_CONTROL_ALL, '');
  }
  if (text.length > max) {
    warn('text_truncated', `${field}: ${String(text.length)} > ${String(max)}`);
    text = text.slice(0, max);
  }
  return text;
}

function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === 'string') return UTF8_ENCODER.encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

// ---------------------------------------------------------------------------
// 본문 조립
// ---------------------------------------------------------------------------

interface BodyPieces {
  /** text/plain 파트(와 인라인 message/rfc822 의 plain) — 문서 순서. */
  readonly plain: readonly string[];
  /** text/html 파트 원문 — 문서 순서. 변환은 호출자가 한다. */
  readonly html: readonly string[];
}

/**
 * 트리에서 본문을 모은다. plain 은 plain 끼리, html 은 html 끼리 문서 순서로 모은다.
 *
 * `multipart/alternative` 의 "둘 중 하나를 고른다" 를 여기서 하지 않는다 — **둘 다 내보낸다**
 * (`text` 와 `htmlText`). 고르는 순간 고르지 않은 쪽은 에이전트도 스캐너도 보지 않는데,
 * 공격자는 두 표현에 서로 다른 내용을 넣을 수 있다. 무엇을 볼지는 소비자가 정하되 스캐너는
 * 둘 다 본다.
 */
function bodyFromTree(tree: readonly PartInfo[]): BodyPieces {
  const plain: string[] = [];
  const html: string[] = [];
  for (const part of tree) {
    if (part.subMessage !== null) {
      if (part.subMessage.text !== null) plain.push(part.subMessage.text);
      if (part.subMessage.html !== null) html.push(part.subMessage.html);
      continue;
    }
    if (part.readText === null) continue;
    (part.mediaType === 'text/html' ? html : plain).push(part.readText());
  }
  return { plain, html };
}

/**
 * 트리를 못 읽었을 때의 축소 모드. HTML 이 있으면 라이브러리의 `text` 가 HTML 에서 왔는지
 * 모르므로 **HTML 쪽만 믿는다**(스타일이 섞인 텍스트를 plain 이라고 부르지 않는다).
 */
function bodyFromLibrary(email: Email): BodyPieces {
  if (email.html !== undefined) return { plain: [], html: [email.html] };
  return { plain: email.text === undefined ? [] : [email.text], html: [] };
}

// ---------------------------------------------------------------------------
// 파트 트리 (postal-mime 비공개 표면)
// ---------------------------------------------------------------------------

interface PartInfo {
  readonly mediaType: string;
  readonly multipart: boolean;
  readonly hasBoundary: boolean;
  readonly charset: string | null;
  /** 인라인 text/plain·text/html 이면 본문을 읽는 함수, 아니면 `null`(첨부·컨테이너). */
  readonly readText: (() => string) | null;
  /** 인라인으로 파싱된 message/rfc822 의 본문. 라이브러리가 이미 재귀 파싱했다. */
  readonly subMessage: { readonly text: string | null; readonly html: string | null } | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 인라인 텍스트 파트의 본문 읽기. 한국어 레거시 charset 이면 **디코딩된 바이트**(`node.content` —
 * 전송 인코딩만 푼 것)를 이 모듈이 풀고, 나머지는 라이브러리의 `getTextContent()` 를 쓴다
 * (format=flowed 처리를 잃지 않기 위해서다).
 */
function textReader(node: Record<string, unknown>, charset: string | null): (() => string) | null {
  const content = node['content'];
  const getTextContent = node['getTextContent'];
  if (typeof getTextContent !== 'function') return null;
  const handling = charset === null ? 'native' : classifyCharset(charset);
  if (handling === 'cp949' || handling === 'iso-2022-kr') {
    // 디코더가 끝난 뒤 `content` 는 ArrayBuffer 다(내용 없는 파트는 null·빈 값).
    const bytes =
      content instanceof Uint8Array
        ? content
        : content instanceof ArrayBuffer
          ? new Uint8Array(content)
          : content === null || content === undefined || content === false
            ? new Uint8Array(0)
            : null;
    if (bytes === null) return null;
    return () => decodeKoreanLegacy(handling, bytes);
  }
  return () => {
    const value: unknown = getTextContent.call(node);
    return typeof value === 'string' ? value : '';
  };
}

/**
 * `parser.root` (MimeNode) 를 문서 순서의 평평한 파트 목록으로 읽는다. 모양이 하나라도 다르면
 * `null` — 호출자는 경고를 남기고 공개 출력만으로 돈다. **추측으로 채우지 않는다.**
 *
 * 재귀가 아니라 스택이다. 깊이는 `maxNestingDepth` 가 이미 막았지만, 여기서 재귀를 쓰면
 * 그 상한이 바뀌는 날 이 함수가 새 공격 표면이 된다.
 *
 * 인라인 판정은 라이브러리(`isInlineTextNode`)와 같다: `Content-Disposition: attachment` 가
 * 아닌 text/plain·text/html. message/rfc822 는 라이브러리가 `subMessage` 를 붙였을 때만
 * 인라인이다(재귀 상한·보고서 메일이면 첨부로 남는다 — 그 판단을 다시 하지 않는다).
 */
function readPartTree(parser: PostalMime): PartInfo[] | null {
  const parts: PartInfo[] = [];
  const stack: unknown[] = [asRecord(parser)?.['root']];
  while (stack.length > 0) {
    const node = asRecord(stack.pop());
    const contentType = asRecord(node?.['contentType']);
    const parsed = asRecord(contentType?.['parsed']);
    const params = asRecord(parsed?.['params']);
    const children = node?.['childNodes'];
    const mediaType = parsed?.['value'];
    const multipart = contentType?.['multipart'];
    if (
      node === null ||
      params === null ||
      !Array.isArray(children) ||
      typeof mediaType !== 'string' ||
      (multipart !== false && typeof multipart !== 'string')
    ) {
      return null;
    }

    const charset = optionalString(params['charset']);
    const disposition = optionalString(asRecord(asRecord(node['contentDisposition'])?.['parsed'])?.['value']);
    const inlineText =
      multipart === false && disposition !== 'attachment' && (mediaType === 'text/plain' || mediaType === 'text/html');
    const sub = asRecord(node['subMessage']);

    let readText: (() => string) | null = null;
    if (inlineText) {
      readText = textReader(node, charset);
      if (readText === null) return null;
    }
    parts.push({
      mediaType,
      multipart: multipart !== false,
      hasBoundary: optionalString(params['boundary']) !== null,
      charset,
      readText,
      subMessage:
        sub === null ? null : { text: optionalString(sub['text']), html: optionalString(sub['html']) },
    });
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return parts;
}
