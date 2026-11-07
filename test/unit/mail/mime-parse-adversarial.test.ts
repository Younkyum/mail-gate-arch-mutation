/**
 * `src/mail/mime/parse.ts` — 적대적 입력. **이것은 인터넷에서 들어오는 공격 표면이다.**
 *
 * 입력마다 "무엇을 하는가" 를 하나로 정한다: 구조화된 거부(`rejected` + 사유) 또는 경고를 단
 * 파싱. **던지는 경우는 없다**(첨부 싱크의 예외만 예외 — 픽스처 테스트 참조). 큐 소비자에서
 * 던지면 같은 메일이 영원히 재전달된다.
 *
 * **이 저장소의 심각한 결함 9건이 전부 "초록인데 아무것도 안 지킨다" 였다.** 그래서 방어마다
 * 짝이 되는 대조군을 둔다 — 같은 입력을 방어가 풀린 설정(라이브러리 기본값 등)으로 돌리면
 * 결과가 **달라진다**는 것을 테스트 안에서 보인다. 대조군이 없으면 상한이 아무것도 막지 않는
 * 상태와 막는 상태가 같은 초록으로 보인다.
 */

import PostalMime from 'postal-mime';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIME_PARSE_LIMITS,
  parseInboundMime,
  type MimeParseResult,
  type ParsedInboundMessage,
} from '../../../src/mail/mime/parse';
import { htmlToText } from '../../../src/mail/mime/parse-html';

const CRLF = '\r\n';

/** 헤더 줄 + 빈 줄 + 본문. 문자열은 latin1 로 — 바이트를 테스트가 정한다. */
function raw(headers: readonly string[], body = 'hello'): Buffer {
  return Buffer.from([...headers, '', body].join(CRLF), 'latin1');
}

/** UTF-8 로 쓴 헤더가 필요할 때. */
function rawUtf8(headers: readonly string[], body = 'hello'): Buffer {
  return Buffer.from([...headers, '', body].join(CRLF), 'utf8');
}

const FROM = 'From: sender@example.com';
const TO = 'To: agent@atmark.ai';

function parsed(result: MimeParseResult): ParsedInboundMessage {
  if (result.kind !== 'parsed') throw new Error(`거부됨: ${result.reason} — ${result.detail}`);
  return result.message;
}

function reasonOf(result: MimeParseResult): string {
  return result.kind === 'rejected' ? result.reason : 'parsed';
}

// ---------------------------------------------------------------------------
// 상한 — 기본값 자체를 고정한다
// ---------------------------------------------------------------------------

describe('기본 상한', () => {
  it('값이 고정돼 있다 — 조용히 넓어지면 여기서 빨개진다', () => {
    expect(DEFAULT_MIME_PARSE_LIMITS).toEqual({
      maxRawBytes: 40 * 1024 * 1024,
      maxHeaderBytes: 256 * 1024,
      maxNestingDepth: 16,
      maxRfc822NestingDepth: 3,
      maxParts: 500,
      maxTextChars: 1_000_000,
      maxSubjectChars: 2_000,
      maxAddressesPerField: 500,
      maxReferences: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// 크기
// ---------------------------------------------------------------------------

describe('원문 크기', () => {
  it('0바이트는 empty 로 거부한다', async () => {
    expect(reasonOf(await parseInboundMime(new Uint8Array(0)))).toBe('empty');
  });

  it('상한을 넘으면 파싱 전에 too_large 로 거부한다(기본 40 MiB)', async () => {
    const huge = Buffer.alloc(DEFAULT_MIME_PARSE_LIMITS.maxRawBytes + 1, 0x61);
    const result = await parseInboundMime(huge);
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'too_large',
      detail: `${String(huge.byteLength)} > ${String(DEFAULT_MIME_PARSE_LIMITS.maxRawBytes)} 바이트`,
    });
  });

  it('상한 바로 아래는 통과한다 — 대조군(상한이 실제 경계다)', async () => {
    const message = raw([FROM, TO]);
    expect(reasonOf(await parseInboundMime(message, { limits: { maxRawBytes: message.byteLength } }))).toBe('parsed');
    expect(reasonOf(await parseInboundMime(message, { limits: { maxRawBytes: message.byteLength - 1 } }))).toBe(
      'too_large',
    );
  });
});

describe('과대 헤더', () => {
  // 300 KB — 기본 상한(256 KiB)은 넘고 라이브러리 기본(2 MiB)은 안 넘는다.
  const padded = raw([FROM, TO, ...Array.from({ length: 3000 }, (_, i) => `X-Pad-${String(i)}: ${'x'.repeat(90)}`)]);

  it('헤더 합계가 상한을 넘으면 headers_too_large 로 거부한다(던지지 않는다)', async () => {
    expect(reasonOf(await parseInboundMime(padded))).toBe('headers_too_large');
  });

  it('대조군: 라이브러리 기본 상한(2 MiB)으로는 통과한다 — 우리 상한이 실제로 일하고 있다', async () => {
    expect(reasonOf(await parseInboundMime(padded, { limits: { maxHeaderBytes: 2 * 1024 * 1024 } }))).toBe('parsed');
  });

  it('파트마다 헤더를 나눠 실어도 합계로 센다', async () => {
    const parts = Array.from(
      { length: 40 },
      (_, i) => `--B${CRLF}${Array.from({ length: 80 }, (_, j) => `X-P${String(i)}-${String(j)}: ${'y'.repeat(80)}`).join(CRLF)}${CRLF}${CRLF}z`,
    ).join(CRLF);
    const message = raw([FROM, TO, 'Content-Type: multipart/mixed; boundary="B"'], `${parts}${CRLF}--B--`);
    expect(reasonOf(await parseInboundMime(message))).toBe('headers_too_large');
  });
});

// ---------------------------------------------------------------------------
// 중첩
// ---------------------------------------------------------------------------

/** multipart 를 `depth` 단 중첩하고 가장 안쪽에 text/plain 을 둔다. */
function nestedMultipart(depth: number): Buffer {
  let part = `Content-Type: text/plain${CRLF}${CRLF}CODE 111111`;
  for (let level = depth; level >= 1; level -= 1) {
    part = `Content-Type: multipart/mixed; boundary="n${String(level)}"${CRLF}${CRLF}--n${String(level)}${CRLF}${part}${CRLF}--n${String(level)}--`;
  }
  return Buffer.from(`${FROM}${CRLF}${TO}${CRLF}${part}`, 'latin1');
}

describe('깊은 multipart 중첩', () => {
  it('50단은 nesting_too_deep 로 거부한다(던지지 않는다)', async () => {
    const result = await parseInboundMime(nestedMultipart(50));
    expect(reasonOf(result)).toBe('nesting_too_deep');
  });

  it('상한(16단) 안의 정상 중첩은 본문을 뽑는다', async () => {
    const message = parsed(await parseInboundMime(nestedMultipart(16)));
    expect(message.text).toBe('CODE 111111\n');
  });

  it('대조군: 라이브러리 기본 깊이(256)로는 50단이 통과한다 — 우리 상한이 실제로 일하고 있다', async () => {
    expect(reasonOf(await parseInboundMime(nestedMultipart(50), { limits: { maxNestingDepth: 256 } }))).toBe('parsed');
  });
});

/** message/rfc822 를 `depth` 겹 감싼다. 가장 안쪽 본문에 코드가 있다. */
function nestedRfc822(depth: number): Buffer {
  let message = `From: inner@example.com${CRLF}Subject: deepest${CRLF}${CRLF}DEEP-CODE 424242`;
  for (let level = depth; level >= 1; level -= 1) {
    message = [
      `From: level${String(level)}@example.com`,
      `Content-Type: multipart/mixed; boundary="r${String(level)}"`,
      '',
      `--r${String(level)}`,
      'Content-Type: message/rfc822',
      '',
      message,
      `--r${String(level)}--`,
    ].join(CRLF);
  }
  return Buffer.from(message.replace(/^From: level1@example.com/, `${FROM}${CRLF}${TO}`), 'latin1');
}

describe('message/rfc822 재귀 (zip bomb 류)', () => {
  it('상한(3겹)을 넘는 전달 메일은 파싱하지 않고 첨부로 남긴다 + 경고', async () => {
    const message = parsed(await parseInboundMime(nestedRfc822(6)));
    expect(message.warnings.map((warning) => warning.code)).toContain('nested_message_depth_exceeded');
    expect(message.text).not.toContain('DEEP-CODE');
    expect(message.attachments.some((attachment) => attachment.contentType === 'message/rfc822')).toBe(true);
  });

  it('대조군: 라이브러리 기본(10겹)으로는 끝까지 파싱된다', async () => {
    const message = parsed(await parseInboundMime(nestedRfc822(6), { limits: { maxRfc822NestingDepth: 10 } }));
    expect(message.text).toContain('DEEP-CODE 424242');
    expect(message.warnings.map((warning) => warning.code)).not.toContain('nested_message_depth_exceeded');
  });
});

describe('파트 수 폭증', () => {
  const manyParts = (count: number): Buffer =>
    raw(
      [FROM, TO, 'Content-Type: multipart/mixed; boundary="P"'],
      `${Array.from({ length: count }, () => `--P${CRLF}Content-Type: application/octet-stream${CRLF}Content-Disposition: attachment${CRLF}${CRLF}x`).join(CRLF)}${CRLF}--P--`,
    );

  it('상한(500)을 넘으면 too_many_parts 로 거부한다 — 파트마다 첨부 행·S3 객체가 생긴다', async () => {
    expect(reasonOf(await parseInboundMime(manyParts(600)))).toBe('too_many_parts');
  });

  it('상한 안은 통과한다 — 대조군', async () => {
    const message = parsed(await parseInboundMime(manyParts(400)));
    expect(message.attachments).toHaveLength(400);
  });
});

// ---------------------------------------------------------------------------
// 구조 결함
// ---------------------------------------------------------------------------

describe('경계(boundary) 결함', () => {
  it('boundary 파라미터가 없는 multipart: 파싱하되 경고한다(본문은 비어 있다)', async () => {
    const message = parsed(
      await parseInboundMime(raw([FROM, TO, 'Content-Type: multipart/mixed'], `--X${CRLF}Content-Type: text/plain${CRLF}${CRLF}lost`)),
    );
    expect(message.warnings).toContainEqual({ code: 'multipart_missing_boundary', detail: 'multipart/mixed' });
    expect(message.textSource).toBe('none');
  });

  it('종결 경계(--B--)가 없어도 본문을 뽑는다', async () => {
    const message = parsed(
      await parseInboundMime(
        raw([FROM, TO, 'Content-Type: multipart/mixed; boundary="B"'], `--B${CRLF}Content-Type: text/plain${CRLF}${CRLF}CODE 222222`),
      ),
    );
    expect(message.text).toBe('CODE 222222\n');
  });
});

describe('낯선 Content-Disposition 토큰 (DB CHECK 는 attachment·inline 만 받는다)', () => {
  const mime = raw(
    [FROM, TO, 'Content-Type: multipart/mixed; boundary="B"'],
    [
      '--B',
      'Content-Type: text/plain',
      '',
      'body',
      '--B',
      'Content-Type: application/octet-stream',
      'Content-Disposition: Form-Data; name="x"; filename="a.bin"',
      '',
      'payload',
      '--B',
      'Content-Type: image/png',
      'Content-Disposition: INLINE; filename="b.png"',
      '',
      'png',
      '--B--',
    ].join(CRLF),
  );

  it('attachment·inline 밖의 토큰은 attachment 로 닫고 경고한다(토큰 원문은 싣지 않는다)', async () => {
    const message = parsed(await parseInboundMime(mime));
    expect(message.attachments.map((attachment) => attachment.disposition)).toEqual(['attachment', 'inline']);
    expect(message.warnings).toContainEqual({ code: 'unknown_disposition', detail: 'attachments[0]' });
    expect(message.warnings.filter((warning) => warning.code === 'unknown_disposition')).toHaveLength(1);
  });

  it('대조군: 라이브러리는 토큰을 소문자로 바꿔 그대로 넘긴다', async () => {
    const email = await PostalMime.parse(mime);
    expect(email.attachments.map((attachment) => attachment.disposition)).toEqual(['form-data', 'inline']);
  });
});

describe('첨부 Content-Type 의 제어문자 (NUL 은 22021 저장 실패, C1 은 에이전트에게 간다)', () => {
  const withType = (contentType: string): Buffer =>
    rawUtf8(
      [FROM, TO, 'Content-Type: multipart/mixed; boundary="B"'],
      [
        '--B',
        'Content-Type: text/plain',
        '',
        'body',
        '--B',
        `Content-Type: ${contentType}`,
        'Content-Disposition: attachment; filename="a.bin"',
        '',
        'payload',
        '--B--',
      ].join(CRLF),
    );

  it('NUL·C1(U+0085) 은 공백으로 바뀌고 경고한다', async () => {
    for (const contentType of ['application/x\u0000y', 'application/x\u0085y']) {
      const message = parsed(await parseInboundMime(withType(contentType)));
      expect(message.attachments.map((attachment) => attachment.contentType)).toEqual(['application/x y']);
      expect(message.warnings).toContainEqual({ code: 'control_chars_removed', detail: 'attachment.contentType' });
    }
  });

  it('정리한 뒤 비면 application/octet-stream', async () => {
    const message = parsed(await parseInboundMime(withType('\u0001')));
    expect(message.attachments.map((attachment) => attachment.contentType)).toEqual(['application/octet-stream']);
  });

  it('대조군: 라이브러리는 NUL·C1 을 mimeType 에 그대로 넘긴다', async () => {
    const [nul, c1] = [await PostalMime.parse(withType('application/x\u0000y')), await PostalMime.parse(withType('application/x\u0085y'))];
    expect([nul.attachments[0]?.mimeType, c1.attachments[0]?.mimeType]).toEqual(['application/x\u0000y', 'application/x\u0085y']);
  });
});

describe('잘못된 charset 이름', () => {
  it('모르는 charset: windows-1252 로 읽되 경고한다 — ASCII 확인 코드는 살아 있다', async () => {
    const message = parsed(
      await parseInboundMime(raw([FROM, TO, 'Content-Type: text/plain; charset=x-bogus-9'], 'code 333333 \xe9')),
    );
    expect(message.text).toBe('code 333333 é\n');
    expect(message.warnings).toContainEqual({ code: 'unknown_charset', detail: 'x-bogus-9' });
  });

  it('인코딩 워드의 모르는 charset 도 경고한다', async () => {
    const message = parsed(await parseInboundMime(raw([FROM, TO, 'Subject: =?x-klingon?B?aGk=?='])));
    expect(message.warnings).toContainEqual({ code: 'unknown_charset', detail: 'x-klingon' });
  });

  it('경고에 싣는 라벨은 잘리고 라벨 문자 밖은 ? 로 바뀐다(로그 인젝션)', async () => {
    const label = `${'a'.repeat(100)}"<script>`;
    const message = parsed(await parseInboundMime(raw([FROM, TO, `Content-Type: text/plain; charset='${label}'`])));
    const warning = message.warnings.find((entry) => entry.code === 'unknown_charset');
    expect(warning?.detail).toHaveLength(64);
    expect(warning?.detail).toMatch(/^[\w.:+?-]+$/);
  });
});

// ---------------------------------------------------------------------------
// NUL · 제어문자 · 헤더 인젝션
// ---------------------------------------------------------------------------

describe('NUL·제어문자', () => {
  it('본문의 NUL·ESC·C1 은 지우고 경고한다 — 탭·개행은 남긴다', async () => {
    const message = parsed(await parseInboundMime(raw([FROM, TO], 'a\x00b\x1bc\x85d\te\r\nf')));
    // \x85 는 latin1 바이트다 — utf-8 로 디코딩되면 U+FFFD 이고 그건 제어문자가 아니다.
    expect(message.text).toBe('abc\ufffdd\te\nf\n');
    expect(message.warnings).toContainEqual({ code: 'control_chars_removed', detail: 'text' });
  });

  it('제목의 NUL 은 공백이 된다 — Postgres text 가 NUL 을 거부한다(메타 INSERT poison pill)', async () => {
    const message = parsed(await parseInboundMime(raw([FROM, TO, 'Subject: code\x00 444444'])));
    expect(message.subject).toBe('code  444444');
    expect(message.warnings).toContainEqual({ code: 'control_chars_removed', detail: 'subject' });
  });

  it('From 원문의 NUL 은 invalid_from — 주소 파서는 NUL 을 조용히 지워 다른 주소를 만든다', async () => {
    // `adm\0in@corp.example` 을 라이브러리 주소 파서에 넣으면 `admin@corp.example` 이 나온다.
    const result = await parseInboundMime(raw(['From: <adm\x00in@corp.example>', TO]));
    expect(reasonOf(result)).toBe('invalid_from');
  });
});

describe('C1 제어문자 — 지우되 흔적(c1Removed)을 남긴다(스캐너 입력)', () => {
  // 파서 차이 공격의 모양: C1 과 ASCII 가 교대한다. 코드 포인트로 만든다(편집기가 C1 을 지우지 않게).
  const interleaved = [...'IGNOREPREV'].map((c) => `${String.fromCodePoint(0x8c)}${c}`).join('');

  it('본문(UTF-8 로 인코딩된 C1): 지우고 개수·교대 길이를 남긴다', async () => {
    const message = parsed(await parseInboundMime(rawUtf8([FROM, TO, 'Content-Type: text/plain; charset=utf-8'], `견적 ${interleaved} 끝`)));
    expect(message.text).not.toMatch(/[\u0080-\u009f]/);
    expect(message.text).toContain('IGNOREPREV');
    expect(message.warnings).toContainEqual({ code: 'c1_controls_removed', detail: 'text' });
    expect(message.c1Removed).toEqual([{ field: 'text', index: 0, count: 10, longestAlternation: 10 }]);
  });

  it('제목(인코딩 워드)·HTML 엔티티·첨부 파일명의 C1 도 필드별로 남는다', async () => {
    const encodedSubject = `=?UTF-8?B?${Buffer.from(`Re ${interleaved}`).toString('base64')}?=`;
    const entityHtml = `<p>hi ${[...'ABCD'].map((c) => `&#x8c;${c}`).join('')}</p>`;
    const filename = `=?UTF-8?B?${Buffer.from(`a${String.fromCodePoint(0x85)}.pdf`).toString('base64')}?=`;
    const boundary = 'b1';
    const body = [
      `--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', entityHtml,
      `--${boundary}`, `Content-Type: application/pdf; name="${filename}"`, 'Content-Disposition: attachment', 'Content-Transfer-Encoding: base64', '', 'JVBERi0=',
      `--${boundary}--`, '',
    ].join(CRLF);
    const message = parsed(
      await parseInboundMime(rawUtf8([FROM, TO, `Subject: ${encodedSubject}`, `Content-Type: multipart/mixed; boundary="${boundary}"`], body)),
    );
    expect(message.subject).not.toMatch(/[\u0080-\u009f]/);
    expect(message.c1Removed).toEqual(
      expect.arrayContaining([
        { field: 'subject', index: 0, count: 10, longestAlternation: 10 },
        { field: 'htmlText', index: 0, count: 4, longestAlternation: 4 },
        { field: 'attachmentName', index: 0, count: 1, longestAlternation: 1 },
      ]),
    );
    expect(message.warnings).toContainEqual({ code: 'c1_controls_removed', detail: 'subject' });
    expect(message.warnings).toContainEqual({ code: 'c1_controls_removed', detail: 'htmlText' });
    expect(message.warnings).toContainEqual({ code: 'c1_controls_removed', detail: 'attachment.filename' });
  });

  it('대조군: C0 만 있으면 control_chars_removed 뿐이고 c1Removed 는 비어 있다', async () => {
    const message = parsed(await parseInboundMime(raw([FROM, TO], 'a\x00b\x1bc')));
    expect(message.warnings).toContainEqual({ code: 'control_chars_removed', detail: 'text' });
    expect(message.warnings.map((w) => w.code)).not.toContain('c1_controls_removed');
    expect(message.c1Removed).toEqual([]);
  });
});

describe('헤더 인젝션 모양', () => {
  it('From 의 bare CR: invalid_from — 풀어 두면 CR 뒤의 주소가 발신자로 둔갑한다', async () => {
    // 라이브러리는 bare CR 을 공백으로 바꾸고, 그러면 `a@b.example Bcc: x@evil.example` 이
    // 그룹 "a@b.example Bcc" 안의 `x@evil.example` 로 파싱된다. 첫 주소를 믿으면 발신자가 공격자다.
    const result = await parseInboundMime(raw(['From: a@b.example\rBcc: x@evil.example', TO]));
    expect(reasonOf(result)).toBe('invalid_from');
  });

  it('인코딩 워드로 숨긴 CRLF(표시 이름·제목): 값에 개행이 남지 않는다 + 경고', async () => {
    const crlfBcc = Buffer.from('evil\r\nBcc: x@evil.example').toString('base64');
    const message = parsed(
      await parseInboundMime(raw([`From: =?UTF-8?B?${crlfBcc}?= <a@b.example>`, TO, `Subject: =?UTF-8?B?${crlfBcc}?=`])),
    );
    expect(message.from).toEqual({ address: 'a@b.example', name: 'evil Bcc: x@evil.example' });
    expect(message.subject).toBe('evil Bcc: x@evil.example');
    expect(message.warnings).toContainEqual({ code: 'control_chars_removed', detail: 'from.name' });
    expect(message.warnings).toContainEqual({ code: 'control_chars_removed', detail: 'subject' });
  });

  it('인코딩 워드로 만든 주소(=?UTF-8?B?YUBiLmNvbQ==?=)는 주소가 아니다 — invalid_from', async () => {
    expect(reasonOf(await parseInboundMime(raw(['From: =?UTF-8?B?YUBiLmNvbQ==?=', TO])))).toBe('invalid_from');
  });
});

// ---------------------------------------------------------------------------
// 동일 헤더 중복 — 어느 것을 믿는가
// ---------------------------------------------------------------------------

describe('From 중복·모호', () => {
  it('From 이 둘이면 어느 것도 믿지 않는다 — ambiguous_from', async () => {
    const message = raw(['From: ceo@bank.example', 'From: attacker@evil.example', TO]);
    expect(reasonOf(await parseInboundMime(message))).toBe('ambiguous_from');
  });

  it('From 한 줄에 주소가 둘이어도 ambiguous_from', async () => {
    expect(reasonOf(await parseInboundMime(raw(['From: a@x.example, b@y.example', TO])))).toBe('ambiguous_from');
  });

  it('From 이 그룹 문법이면 ambiguous_from', async () => {
    expect(reasonOf(await parseInboundMime(raw(['From: team: a@x.example;', TO])))).toBe('ambiguous_from');
  });

  it('From 이 없으면 missing_from, 주소 모양이 아니면 invalid_from', async () => {
    expect(reasonOf(await parseInboundMime(raw([TO])))).toBe('missing_from');
    expect(reasonOf(await parseInboundMime(raw(['From: MAILER-DAEMON', TO])))).toBe('invalid_from');
  });

  it('NBSP 로 시작하는 두 번째 "From" 은 From 이 아니다(라이브러리 3.0.0 규칙을 고정)', async () => {
    // 라이브러리가 ` From:` 을 `from` 으로 접어 주던 시절에는 이것이 first-wins 를 뚫는 방법이었다.
    const message = parsed(await parseInboundMime(rawUtf8(['From: real@bank.example', '\u00a0From: evil@evil.example', TO])));
    expect(message.from.address).toBe('real@bank.example');
  });
});

describe('다른 단일 헤더의 중복', () => {
  it('Subject·Message-ID 중복: 첫 번째를 쓰고 경고한다', async () => {
    const message = parsed(
      await parseInboundMime(
        raw([FROM, TO, 'Subject: first', 'Subject: second', 'Message-ID: <one@x.example>', 'Message-ID: <two@x.example>']),
      ),
    );
    expect(message.subject).toBe('first');
    expect(message.messageId).toBe('<one@x.example>');
    expect(message.warnings).toContainEqual({ code: 'duplicate_header', detail: 'subject × 2' });
    expect(message.warnings).toContainEqual({ code: 'duplicate_header', detail: 'message-id × 2' });
  });

  it('To 중복: 합집합 + 경고', async () => {
    const message = parsed(await parseInboundMime(raw([FROM, 'To: a@x.example', 'To: b@x.example'])));
    expect(message.to.map((entry) => entry.address)).toEqual(['a@x.example', 'b@x.example']);
    expect(message.warnings).toContainEqual({ code: 'duplicate_header', detail: 'to × 2' });
  });
});

// ---------------------------------------------------------------------------
// 주소·스레드 헤더의 증폭
// ---------------------------------------------------------------------------

describe('주소·msg-id 정리', () => {
  it('모양이 아닌 수신 주소는 버리고 경고한다 — 나머지는 isAddressShape 를 통과한다', async () => {
    // 빈 주소만 넣으면 이 테스트는 `address !== ''` 검사로도 초록이다(실제로 그랬다 — 되돌리기
    // 실험 R15). 비어 있지 않은데 모양이 아닌 값을 넣어야 isAddressShape 가 일한다.
    const message = parsed(
      await parseInboundMime(
        raw([FROM, 'To: ok@x.example, not-an-address, "Name" <>, <@x.example>, <user@>, <a@b@c.example>, <a b@x.example>']),
      ),
    );
    expect(message.to).toEqual([{ address: 'ok@x.example', name: null }]);
    expect(message.warnings).toContainEqual({ code: 'invalid_address', detail: 'to × 6' });
  });

  it('수신 주소 원문의 제어문자: 주소 파서가 조용히 지운 것을 경고로 남긴다', async () => {
    const message = parsed(await parseInboundMime(raw([FROM, 'To: <a\x01b@x.example>'])));
    expect(message.warnings).toContainEqual({ code: 'control_chars_removed', detail: 'to (원문)' });
  });

  it('수신 주소 수천 개는 500개로 자르고 경고한다', async () => {
    const addresses = Array.from({ length: 700 }, (_, i) => `r${String(i)}@x.example`).join(', ');
    const message = parsed(await parseInboundMime(raw([FROM, `To: ${addresses}`])));
    expect(message.to).toHaveLength(500);
    expect(message.warnings).toContainEqual({ code: 'addresses_truncated', detail: 'to: 700 > 500' });
  });

  it('References 는 뒤쪽 100개(가까운 조상)를 남긴다', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `<m${String(i)}@x.example>`).join(' ');
    const message = parsed(await parseInboundMime(raw([FROM, TO, `References: ${ids}`])));
    expect(message.references).toHaveLength(100);
    expect(message.references[0]).toBe('<m50@x.example>');
    expect(message.references[99]).toBe('<m149@x.example>');
  });

  it('DB CHECK 모양이 아닌 Message-ID 는 null + 경고, 꺾쇠 없는 id@host 는 감싼다', async () => {
    const broken = parsed(await parseInboundMime(raw([FROM, TO, 'Message-ID: <no-at-sign>'])));
    expect(broken.messageId).toBeNull();
    expect(broken.warnings).toContainEqual({ code: 'invalid_message_id', detail: 'message-id' });
    const bare = parsed(await parseInboundMime(raw([FROM, TO, 'Message-ID: bare@host.example'])));
    expect(bare.messageId).toBe('<bare@host.example>');
  });

  it('깨진 Date 는 null + 경고', async () => {
    const message = parsed(await parseInboundMime(raw([FROM, TO, 'Date: not a date'])));
    expect(message.date).toBeNull();
    expect(message.warnings).toContainEqual({ code: 'invalid_date', detail: 'date' });
  });

  it('긴 제목은 잘리고 경고한다', async () => {
    const message = parsed(await parseInboundMime(raw([FROM, TO, `Subject: ${'s'.repeat(5000)}`])));
    expect(message.subject).toHaveLength(2000);
    expect(message.warnings).toContainEqual({ code: 'subject_truncated', detail: '5000 > 2000' });
  });
});

// ---------------------------------------------------------------------------
// 거대 첨부 · 거대 본문
// ---------------------------------------------------------------------------

describe('거대 첨부', () => {
  const size = 5 * 1024 * 1024;
  const payload = Buffer.alloc(size, 0x5a);
  const message = raw(
    [FROM, TO, 'Content-Type: multipart/mixed; boundary="G"'],
    [
      '--G',
      'Content-Type: text/plain',
      '',
      'see attached',
      '--G',
      'Content-Type: application/zip',
      'Content-Disposition: attachment; filename="big.zip"',
      'Content-Transfer-Encoding: base64',
      '',
      (payload.toString('base64').match(/.{1,76}/g) ?? []).join(CRLF),
      '--G--',
    ].join(CRLF),
  );

  it('크기만 싣고 바이트는 싣지 않는다 — 출력 직렬화가 작다', async () => {
    const result = parsed(await parseInboundMime(message));
    expect(result.attachments).toEqual([
      { index: 0, filename: 'big.zip', contentType: 'application/zip', disposition: 'attachment', size, contentId: null },
    ]);
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
  });

  it('바이트는 싱크로 온전히 넘어간다', async () => {
    let received = 0;
    let allZ = true;
    await parseInboundMime(message, {
      onAttachment: (_meta, content) => {
        received = content.byteLength;
        allZ = content.every((byte) => byte === 0x5a);
      },
    });
    expect(received).toBe(size);
    expect(allZ).toBe(true);
  });
});

describe('거대 본문', () => {
  it('본문은 maxTextChars 로 자르고 경고한다 — 앞쪽(확인 코드)은 남는다', async () => {
    const message = parsed(await parseInboundMime(raw([FROM, TO], `CODE 555555 ${'x'.repeat(50_000)}`), {
      limits: { maxTextChars: 1_000 },
    }));
    expect(message.text).toHaveLength(1_000);
    expect(message.text.startsWith('CODE 555555')).toBe(true);
    expect(message.warnings).toContainEqual({ code: 'text_truncated', detail: 'text: 50013 > 1000' });
  });
});

// ---------------------------------------------------------------------------
// 쓰레기 입력 · 시간
// ---------------------------------------------------------------------------

describe('쓰레기 입력', () => {
  it('무작위 바이트는 던지지 않고 거부로 끝난다', async () => {
    // 결정적인 의사 난수(LCG) — 실패를 재현할 수 있어야 한다.
    let seed = 42;
    const bytes = Uint8Array.from({ length: 64 * 1024 }, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed & 0xff;
    });
    const result = await parseInboundMime(bytes);
    expect(result.kind).toBe('rejected');
  });
});

describe('HTML 변환은 선형 시간이다 (타임아웃 = poison pill)', () => {
  const MB = 1024 * 1024;
  it.each([
    ['닫히지 않은 <script 반복', '<script>'.repeat(MB / 8)],
    ['> 없는 < 반복', '<'.repeat(MB)],
    ['> 없는 태그 이름 반복', '<a href=x '.repeat(MB / 10)],
    ['> 없는 닫는 태그 반복', `<style>${'</style'.repeat(MB / 7)}`],
    ['닫히지 않은 주석 여는 것 반복', '<!--'.repeat(MB / 4)],
    ['중첩된 <a> 반복', '<a href="https://x.example">'.repeat(MB / 28)],
  ])('%s (1 MB) — 2초 안에 끝난다', (_label, html) => {
    const started = Date.now();
    htmlToText(html);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('파서 전체 경로(HTML 만 있는 4 MB 메일)도 5초 안에 끝난다', async () => {
    const started = Date.now();
    await parseInboundMime(raw([FROM, TO, 'Content-Type: text/html'], '<script>'.repeat(512 * 1024)));
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
