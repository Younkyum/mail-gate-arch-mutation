/**
 * src/mail/mime/build.ts — raw MIME 조립.
 *
 * **왜 SESv2 의 `Content.Simple` 이 아니라 `Content.Raw` 인가:**
 * 우리는 `Message-ID` 를 **우리가 정한 값으로** 내보내야 한다(§4.5-4 — 재시도가 같은
 * 값으로 나가야 수신측이 중복을 병합한다). `Simple` 은 헤더를 우리가 쓰지 못하고,
 * `Simple.Headers` 는 `Message-ID` 를 예약 헤더로 거부한다. raw 만이 그 한 줄을 쓸 수 있다.
 *
 * > **알려진 한계 — 리드 확인 필요.** SES 는 수신한 raw 메시지의 `Message-ID` 를
 * > 자체 값으로 덮어쓸 수 있다. 그 경우 §4.5-4 의 **2차** 방어선(수신측 병합)만
 * > 약해지고 1차 방어선(조건부 UPDATE lease)은 그대로다. 실제 동작은 `demo:p1b` 에서
 * > 실제 발송된 메일의 원문 헤더로 확인해야 한다 — 이 파일이 값을 쓰는 것과
 * > 그 값이 살아서 나가는 것은 다른 명제다.
 *
 * **본문은 여기 없다.** 이 함수는 호출자가 이미 렌더한 텍스트를 받는다. 본문 저장소는
 * S3 이고(PRD 제약), 어디서 읽어 오는지는 `MessageContentSource` 의 구현이 정한다.
 */

import { createHash } from 'node:crypto';

import { assertMessageIdHeader, isMessageIdHeader } from '../message-id';

/** 조립에 필요한 것 전부. optional 은 쓰지 않는다 — 없는 값은 `null` 이다. */
export interface RawMessageInput {
  readonly fromAddress: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  /** `<...>` 를 포함한 완성된 헤더 값. 전송 전에 이미 저장돼 있다. */
  readonly messageIdHeader: string;
  readonly date: Date;
  readonly text: string;
  /** `null` 이면 text/plain 단일 파트. 값이 있으면 multipart/alternative. */
  readonly html: string | null;
  /** 회신이면 `In-Reply-To`·`References`. 새 대화면 `null` — 두 헤더를 쓰지 않는다. */
  readonly threading: MessageThreading | null;
  /**
   * `Reply-To` 한 주소. `null` 이면 헤더를 쓰지 않는다. 문의 전달(US-009 — 원 발신자에게 바로 회신)만 채운다. From·To 와 같은
   * 헤더 안전 검사를 지난다.
   */
  readonly replyTo: string | null;
  /**
   * 첨부(메일 기본기 2차 A2). 없거나 비면 예전 모양 그대로(바이트 동일). 있으면 `multipart/mixed` 로 감싼다 — 첫 파트는 본문(평문 또는
   * `multipart/alternative`), 그 뒤 첨부마다 base64 파트 하나. MIME·파일명은 **발송 준비가 검증한 값**이다(서명표 · 제어문자 없음).
   */
  readonly attachments?: readonly RawAttachment[];
}

/** 첨부 파트 하나 — 파일명 · MIME(서명표) · 바이트. */
export interface RawAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/**
 * 회신 헤더 (RFC 5322 §3.6.4). **값은 전부 상대가 정한 문자열에서 왔다** — 받은 메일의 `Message-ID`·
 * `In-Reply-To` 는 외부인이 쓴다. 그래서 조립 직전에 한 번 더 검사한다(`buildRawMessage`).
 */
export interface MessageThreading {
  /** 답하는 메일의 `Message-ID`(`<…>` 포함). */
  readonly inReplyTo: string;
  /** 오래된 것부터. 마지막 원소가 `inReplyTo` 다(`replyThreading` 이 그렇게 만든다). */
  readonly references: readonly string[];
}

/**
 * `References` 에 싣는 id 상한. 받은 메일의 `References` 는 발신자가 원하는 만큼 늘릴 수 있다 — 상한이 없으면
 * 우리 회신 헤더가 상대가 정한 길이가 된다. 최근 쪽(끝)을 남긴다(부모가 마지막).
 */
export const MAX_REFERENCES = 20;

/**
 * 받은 메일 → 회신 헤더. **모양이 아닌 id 는 버린다**(던지지 않는다): 상대의 `In-Reply-To` 가 깨져 있다고
 * 회신을 못 하게 할 이유는 없다. 부모 자신의 `Message-ID` 가 모양이 아니면 `null` — 잇는 헤더 없이 보낸다.
 *
 * 부모에게 `References` 가 없으면 부모의 `In-Reply-To` 를 조상으로 쓴다(RFC 5322 §3.6.4). 우리는 받은
 * 메일의 `References` 를 저장하지 않으므로(`inbound_messages` 에 컬럼이 없다) 이 경로가 기본이다.
 */
export function replyThreading(
  parentMessageId: string | null,
  parentAncestors: readonly string[],
): MessageThreading | null {
  const isSafeId = (value: string): boolean => isMessageIdHeader(value) && !HEADER_UNSAFE.test(value);
  if (parentMessageId === null || !isSafeId(parentMessageId)) return null;
  const ancestors = [...new Set(parentAncestors.filter(isSafeId))].filter((id) => id !== parentMessageId);
  const references = [...ancestors, parentMessageId].slice(-MAX_REFERENCES);
  return { inReplyTo: parentMessageId, references };
}

const CRLF = '\r\n';

/**
 * 비-ASCII 제목을 RFC 2047 base64 로 인코딩한다.
 *
 * 한국어 제목이 그대로 나가면 8bit 헤더가 되어 일부 MTA 가 깨뜨린다 — 깨진 제목은
 * 스팸 판정의 입력이고, 평판이 이 프로젝트의 AC-2 다. ASCII 는 건드리지 않는다
 * (불필요한 인코딩도 그 자체로 스팸 시그널이다).
 */
export function encodeHeaderValue(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ').trim();
  // eslint 친화적 범위 검사 대신 코드포인트로 본다 — 정규식 이스케이프보다 오독이 적다.
  const isAscii = [...oneLine].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code <= 0x7e;
  });
  if (isAscii) return oneLine;
  return `=?UTF-8?B?${Buffer.from(oneLine, 'utf8').toString('base64')}?=`;
}

/**
 * 헤더 값에 들어가면 안 되는 문자 — **제어문자 전부**(C0 `\x00-\x1f` · DEL `\x7f` · C1 `\x80-\x9f`).
 *
 *   - CRLF 는 헤더를 끊는다 — `To: victim@x.com\r\nBcc: everyone@y.com` 은 조립된 메시지 안에서 합법적인 두 헤더이고 SES 는 그대로 보낸다.
 *   - 나머지 C0·DEL 은 헤더를 끊지 못하지만 RFC 5322 `atext`·`dtext` 밖이다 — 중간 MTA 의 관용도에 맡기지 않는다. 관문 앞의
 *     `ADDRESS_SHAPE`(`[^@\s]+@[^@\s]+`)는 이것을 거르지 못한다(JS `\s` 는 제어문자가 아니다) — 그래서 여기가 마지막 층이다.
 *   - C1 — NEL(U+0085)은 `\s` 에 들지 않고 일부 처리기에서 줄바꿈으로 정규화된다(NEL→CRLF 순간 인젝션). 특례 대신 C1 전체를 닫았다.
 *     U+2028·U+2029 는 `\s` 가 이미 잡는다.
 */
const HEADER_UNSAFE = /[\x00-\x1f\x7f-\x9f]/;

/**
 * 헤더에 그대로 연결되는 값(주소 — `encodeHeaderValue` 를 거치지 않는다)의 안전 검사.
 *
 * 치환이 아니라 **던진다**: 주소에 개행이 있다는 것은 공격이거나 상위 검증의 부재다 — 공백으로 바꿔 보내면 그 사실이 아무 데도 안 남는다.
 * 관문 앞의 `isAddressShape`(`src/api/outbound-http.ts`)와 이중이다 — 한쪽 호출부가 빠지는 날 다른 쪽이 남는다.
 */
export function assertHeaderSafe(field: string, value: string): string {
  if (HEADER_UNSAFE.test(value)) {
    throw new Error(
      `${field} 헤더 값에 제어문자가 있다 (헤더 인젝션·RFC 5322 위반): ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** 76자로 접은 base64. 긴 줄은 SMTP 998자 제한에 걸린다. */
function foldedBase64(bytes: Buffer): string {
  return (bytes.toString('base64').match(/.{1,76}/g) ?? ['']).join(CRLF);
}

function base64Body(value: string): string {
  return foldedBase64(Buffer.from(value, 'utf8'));
}

/**
 * 경계 문자열은 `Message-ID` 에서 파생한다.
 *
 * 난수를 새로 뽑지 않는 이유: **재시도는 같은 바이트를 내야 한다.** 경계가 매번 달라지면
 * 같은 `Message-ID` 를 단 메일이 바이트 수준에서 서로 다른 본문으로 두 번 나가고,
 * 그 상태에서 수신측 병합은 구현에 따라 실패한다 — §4.5-4 가 사려던 것을 되돌린다.
 */
function boundaryFor(messageIdHeader: string, part = ''): string {
  return `--atmark-${createHash('sha256').update(messageIdHeader + part).digest('hex').slice(0, 24)}`;
}

/** 첨부 MIME — 서명표(`src/api/outbound-attachments.ts` `ATTACHMENT_MIME_TYPES`)만. 여기서 한 번 더 막는다(헤더에 그대로 들어간다). */
const ATTACHMENT_MIME = /^(application\/pdf|image\/png|image\/jpeg|text\/plain)$/;

/**
 * ASCII 대체 이름의 확장자(보안 리뷰 N4) — 옛 클라이언트도 확장자로 여는 앱을 고른다. 서명표(`ATTACHMENT_EXTENSIONS` 의 첫 확장자)와 같은 표를
 * 여기 따로 둔다(`mail/` 이 `api/` 를 import 하지 않는다). 표 밖이면 확장자 없이.
 */
const FALLBACK_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['application/pdf', '.pdf'],
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['text/plain', '.txt'],
]);

/**
 * 파일명 → `Content-Type` 의 `name` 과 `Content-Disposition` 의 `filename`·`filename*`. ASCII 인쇄 가능 문자(따옴표·역슬래시 제외)면
 * `filename="…"` 하나, 아니면 **RFC 2231** `filename*=UTF-8''<퍼센트 인코딩>` 과 ASCII 대체 이름(`attachment-<자리><MIME 의 확장자>`)을 함께
 * 싣는다(옛 클라이언트는 대체 이름을 본다). 긴 인코딩은 RFC 2231 연속(`filename*0*=`…)으로 접어 한 줄 998자 한계를 지킨다.
 */
export function attachmentDispositionParams(
  filename: string,
  position: number,
  mimeType: string,
): { readonly contentTypeName: string; readonly disposition: string } {
  assertHeaderSafe(`attachments[${String(position)}].filename`, filename);
  // RFC 2047 encoded-word 는 받는 쪽이 다시 풀어 다른 이름으로 보인다(보안 리뷰 M1) — 업로드·DB 가 막지만 조립에서 한 번 더.
  if (/=\?[^?]*\?[bq]\?/i.test(filename)) throw new Error(`attachments[${String(position)}].filename 에 encoded-word 가 있다`);
  const plainAscii = /^[\x20-\x7e]+$/.test(filename) && !/["\\]/.test(filename);
  if (plainAscii) return { contentTypeName: `name="${filename}"`, disposition: `attachment; filename="${filename}"` };
  const encoded = encodeURIComponent(filename).replace(/['()*!]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const fallback = `attachment-${String(position + 1)}${FALLBACK_EXTENSIONS.get(mimeType) ?? ''}`;
  const chunks = encoded.match(/.{1,60}(?=%|$)|.{1,60}/g) ?? [encoded];
  const continued =
    chunks.length === 1
      ? `filename*=UTF-8''${encoded}`
      : chunks.map((chunk, index) => `filename*${String(index)}*=${index === 0 ? "UTF-8''" : ''}${chunk}`).join(`;${CRLF} `);
  return {
    contentTypeName: `name="${fallback}"`,
    disposition: `attachment; filename="${fallback}";${CRLF} ${continued}`,
  };
}

/**
 * `In-Reply-To`·`References` 두 줄. **id 하나하나를 헤더 안전 검사 + `Message-ID` 모양 검사**한다 — 저장소를
 * 거쳐 왔어도 원래는 외부인이 쓴 값이다. 하나라도 어긋나면 던진다(조용히 빼고 보내면 "무엇이 빠졌는가" 가
 * 어디에도 안 남는다; 거르기는 `replyThreading` 에서 이미 끝났어야 한다).
 *
 * `References` 는 id 마다 줄을 접는다(CRLF + 공백) — 한 줄 998자 한계(RFC 5322 §2.1.1)를 id 수와 무관하게 지킨다.
 */
function threadingHeaders(threading: MessageThreading | null): string[] {
  if (threading === null) return [];
  const checked = (field: string, value: string): string => assertMessageIdHeader(assertHeaderSafe(field, value));
  const inReplyTo = checked('In-Reply-To', threading.inReplyTo);
  if (threading.references.length > MAX_REFERENCES) {
    throw new Error(`References 가 ${String(MAX_REFERENCES)}개를 넘는다: ${String(threading.references.length)}`);
  }
  const references = threading.references.map((id, index) => checked(`References[${String(index)}]`, id));
  const lines = [`In-Reply-To: ${inReplyTo}`];
  if (references.length > 0) lines.push(`References: ${references.join(`${CRLF} `)}`);
  return lines;
}

/** raw MIME 한 통. SESv2 `Content.Raw.Data` 에 그대로 들어간다. */
export function buildRawMessage(input: RawMessageInput): string {
  if (input.recipients.length === 0) {
    // 수신자 0명 발송은 표현 불가능해야 한다. DB CHECK `messages_outbound_has_recipients`
    // 와 같은 명제를 전송 직전에 한 번 더 세운다.
    throw new Error('수신자가 없는 메시지는 조립하지 않는다');
  }

  const messageId = assertMessageIdHeader(input.messageIdHeader);
  const headers: string[] = [
    `From: ${assertHeaderSafe('From', input.fromAddress)}`,
    // **수신자는 하나씩 검사한다.** 합친 뒤에 검사하면 어느 주소가 문제인지 사라지고,
    // 그 정보가 없으면 사고 조사가 "요청 본문을 다시 찾아보기" 에서 시작한다.
    `To: ${input.recipients.map((address, index) => assertHeaderSafe(`To[${String(index)}]`, address)).join(', ')}`,
    ...(input.replyTo === null ? [] : [`Reply-To: ${assertHeaderSafe('Reply-To', input.replyTo)}`]),
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Message-ID: ${messageId}`,
    ...threadingHeaders(input.threading),
    `Date: ${input.date.toUTCString()}`,
    'MIME-Version: 1.0',
  ];

  const attachments = input.attachments ?? [];
  const bodyLines = bodyPart(input, messageId);
  if (attachments.length === 0) return [...headers, ...bodyLines].join(CRLF);

  const mixed = boundaryFor(messageId, ':mixed');
  const lines = [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, '', `--${mixed}`, ...bodyLines];
  attachments.forEach((attachment, position) => {
    if (!ATTACHMENT_MIME.test(attachment.mimeType)) {
      throw new Error(`첨부 MIME 이 서명표 밖이다 (attachments[${String(position)}])`);
    }
    const params = attachmentDispositionParams(attachment.filename, position, attachment.mimeType);
    lines.push(
      `--${mixed}`,
      `Content-Type: ${attachment.mimeType}; ${params.contentTypeName}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: ${params.disposition}`,
      '',
      foldedBase64(Buffer.from(attachment.data.buffer, attachment.data.byteOffset, attachment.data.byteLength)),
      '',
    );
  });
  lines.push(`--${mixed}--`, '');
  return lines.join(CRLF);
}

/** 본문 파트(헤더 뒤) — 평문 단일 또는 `multipart/alternative`. 첨부가 없으면 이것이 메시지 본체 그대로다(예전과 같은 바이트). */
function bodyPart(input: RawMessageInput, messageId: string): string[] {
  if (input.html === null) {
    return ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Body(input.text), ''];
  }
  const boundary = boundaryFor(messageId);
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(input.text),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(input.html),
    '',
    `--${boundary}--`,
    '',
  ];
}
