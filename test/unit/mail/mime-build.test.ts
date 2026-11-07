/**
 * `src/mail/mime/build.ts` — raw MIME 조립.
 *
 * 이 층이 지키는 것은 두 가지다: **`Message-ID` 가 실제로 바이트에 들어간다**(§4.5-4)와
 * **같은 입력이 같은 바이트를 낸다**(재시도가 다른 본문을 내면 수신측 병합이 무의미해진다).
 */

import { describe, expect, it } from 'vitest';

import {
  assertHeaderSafe,
  attachmentDispositionParams,
  buildRawMessage,
  encodeHeaderValue,
  type RawMessageInput,
} from '../../../src/mail/mime/build';
import { ADDRESS_SHAPE } from '../../../src/policy/policy-loader';

const BASE: RawMessageInput = {
  fromAddress: 'agent@atmark.ai',
  recipients: ['jinyounkyum@gmail.com'],
  subject: 'hello',
  messageIdHeader: '<1x.deadbeef@atmark.ai>',
  date: new Date('2026-10-01T00:00:00.000Z'),
  text: 'body',
  html: null,
  threading: null,
  replyTo: null,
};

function decodeBase64Parts(raw: string): string[] {
  // 헤더 블록과 각 파트의 본문을 base64 로만 실어 보내므로, 빈 줄 뒤 덩어리를 디코드한다.
  return raw
    .split('\r\n\r\n')
    .slice(1)
    .map((chunk) => Buffer.from(chunk.split('\r\n--')[0] ?? '', 'base64').toString('utf8'));
}

describe('buildRawMessage', () => {
  it('Message-ID 를 주어진 값 그대로 헤더에 쓴다', () => {
    expect(buildRawMessage(BASE)).toContain('Message-ID: <1x.deadbeef@atmark.ai>');
  });

  it('형식이 깨진 Message-ID 는 조립 전에 던진다', () => {
    expect(() => buildRawMessage({ ...BASE, messageIdHeader: 'deadbeef@atmark.ai' })).toThrow(
      /Message-ID/,
    );
  });

  it('수신자 0명은 조립하지 않는다 — DB CHECK 와 같은 명제', () => {
    expect(() => buildRawMessage({ ...BASE, recipients: [] })).toThrow(/수신자/);
  });

  it('같은 입력은 같은 바이트를 낸다 — 재시도가 다른 본문을 내면 병합이 무의미하다', () => {
    expect(buildRawMessage(BASE)).toBe(buildRawMessage(BASE));
  });

  it('줄 끝이 전부 CRLF 다', () => {
    const raw = buildRawMessage(BASE);
    expect(raw.split('\n').length - 1).toBe(raw.split('\r\n').length - 1);
  });

  it('본문을 base64 로 싣고 디코드하면 원문이다', () => {
    const raw = buildRawMessage({ ...BASE, text: '한글 본문 — 8bit 로 나가면 깨진다' });
    expect(decodeBase64Parts(raw)[0]).toBe('한글 본문 — 8bit 로 나가면 깨진다');
  });

  it('여러 수신자는 쉼표로 이어 붙인다', () => {
    const raw = buildRawMessage({ ...BASE, recipients: ['a@example.com', 'b@example.com'] });
    expect(raw).toContain('To: a@example.com, b@example.com');
  });

  it('html 이 있으면 multipart/alternative 로 두 파트를 낸다', () => {
    const raw = buildRawMessage({ ...BASE, html: '<p>body</p>' });
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="--atmark-');
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(raw).toContain('Content-Type: text/html; charset=UTF-8');
    const parts = decodeBase64Parts(raw);
    expect(parts).toContain('body');
    expect(parts).toContain('<p>body</p>');
  });

  it('경계는 Message-ID 에서 파생한다 — 재시도마다 새 난수를 뽑지 않는다', () => {
    const first = buildRawMessage({ ...BASE, html: '<p>x</p>' });
    const second = buildRawMessage({ ...BASE, html: '<p>x</p>' });
    expect(first).toBe(second);

    const other = buildRawMessage({
      ...BASE,
      html: '<p>x</p>',
      messageIdHeader: '<2y.cafebabe@atmark.ai>',
    });
    expect(other).not.toBe(first);
  });
});

describe('encodeHeaderValue', () => {
  it('ASCII 제목은 건드리지 않는다 — 불필요한 인코딩도 스팸 시그널이다', () => {
    expect(encodeHeaderValue('Weekly digest')).toBe('Weekly digest');
  });

  it('비-ASCII 제목은 RFC 2047 base64 로 감싼다', () => {
    const encoded = encodeHeaderValue('안녕하세요');
    expect(encoded).toBe(`=?UTF-8?B?${Buffer.from('안녕하세요', 'utf8').toString('base64')}?=`);
  });

  it('개행을 접어 헤더 주입을 막는다', () => {
    expect(encodeHeaderValue('a\r\nBcc: victim@example.com')).toBe('a Bcc: victim@example.com');
  });
});

describe('assertHeaderSafe — From·To 도 subject 와 같은 규율을 받는다 (MAJOR 4)', () => {
  it('깨끗한 값은 그대로 돌려준다', () => {
    expect(assertHeaderSafe('From', 'agent@atmark.ai')).toBe('agent@atmark.ai');
  });

  it('CRLF 가 있으면 던진다 — 치환하면 그 사실이 아무 데도 안 남는다', () => {
    expect(() => assertHeaderSafe('To[0]', 'victim@x.com\r\nBcc: everyone@y.com')).toThrow(
      /헤더 인젝션/,
    );
  });

  it('LF 하나로도 던진다 — 헤더 하나를 끝내는 데 CR 은 필요 없다', () => {
    expect(() => assertHeaderSafe('From', 'a@b.com\nX-Spoof: 1')).toThrow(/헤더 인젝션/);
  });

  it('NUL 도 막는다', () => {
    expect(() => assertHeaderSafe('From', 'a@b.com\0')).toThrow(/헤더 인젝션/);
  });

  /**
   * **여기부터가 "`\s` 가 제어문자를 다 잡는다" 가 거짓인 구간이다.**
   *
   * 관문 앞의 `ADDRESS_SHAPE`(`[^@\s]+@[^@\s]+`)가 1차로 거른다는 이야기는 개행에만
   * 참이다. JS 의 `\s` 는 WhiteSpace + LineTerminator 이고 제어문자 범주가 아니다 —
   * 아래 값들은 예전 `[\r\n\0]` 판정에서 **두 층을 모두 통과해** `From`·`To` 헤더로
   * 나갔다. 헤더를 끊지는 못하므로 인젝션은 아니지만 RFC 5322 위반이다.
   */
  it.each([
    ['BEL', '\x07'],
    ['ESC', '\x1b'],
    ['DEL', '\x7f'],
    // C1. `\s` 도 `[\r\n\0]` 도 잡지 못하던 **유일한** 값이라 범위에 넣었다
    // (`build.ts` 의 `HEADER_UNSAFE` 주석에 근거를 적었다).
    ['NEL', ''],
  ])('%s 도 막는다 — `\\s` 는 이 문자를 잡지 못한다', (_name, char) => {
    expect(ADDRESS_SHAPE.test(`a${char}@b.com`)).toBe(true); // 1층은 통과한다
    expect(() => assertHeaderSafe('From', `a${char}@b.com`)).toThrow(/헤더 인젝션/); // 2층이 잡는다
  });

  it('비-ASCII 는 제어문자가 아니다 — 한국어 주소를 막지 않는다', () => {
    // 범위를 `\x00-\x1f\x7f-\x9f` 로 둔 것이 "ASCII 만 허용" 이 아님을 못 박는다.
    // 주소의 ASCII 여부는 `ADDRESS_SHAPE` 와 `agent_addresses` 의 일이다.
    expect(assertHeaderSafe('From', '한글@atmark.ai')).toBe('한글@atmark.ai');
  });
});

describe('buildRawMessage — 주소 헤더의 인젝션 표면', () => {
  it('개행이 든 From 으로는 조립되지 않는다', () => {
    // **예전에는 조립됐다.** `encodeHeaderValue` 의 CRLF 제거는 `subject` 에만 있었고,
    // `From:`·`To:` 는 원본을 그대로 연결했다.
    expect(() => buildRawMessage({ ...BASE, fromAddress: 'a@b.com\r\nX-Spoof: 1' })).toThrow(
      /헤더 인젝션/,
    );
  });

  it('개행이 든 수신자로는 조립되지 않고, 몇 번째인지 말한다', () => {
    expect(() =>
      buildRawMessage({ ...BASE, recipients: ['ok@example.com', 'victim@x.com\r\nBcc: z@y.com'] }),
    ).toThrow(/To\[1\]/);
  });
});

describe('예약 주소 사이에 낀 제어문자 — IAM 이 막지 못하는 몫을 런타임이 막는다 (ADR-0006 M3, 2026-09-24)', () => {
  // IAM API 는 정책 문서에 인쇄 가능 ASCII 만 받는다 — `*\t*` 같은 Deny 패턴을 적을 수 없다(운영 배포 거부 실측).
  // 앞에 붙은 제어문자는 IAM 접미사 Deny 가, **사이**에 낀 것은 이 가드가 막는다(test/unit/infra/compute-stack.test.ts 가 IAM 쪽 한계를 단언).
  it.each(['lo\tgin@atmark.ai', 'login\t@atmark.ai', 'login\r\n@atmark.ai', 'sup\u007fport@atmark.ai', 'lo\u000bgin@atmark.ai', 'supp\u0085ort@atmark.ai'])(
    'From %j 은 던진다',
    (from) => {
      expect(() => assertHeaderSafe('From', from)).toThrow(/헤더 인젝션/);
      expect(() => buildRawMessage({ ...BASE, fromAddress: from })).toThrow();
    },
  );
});

describe('첨부 파일명 — 비-ASCII 의 ASCII 대체 이름에 MIME 의 확장자 (보안 리뷰 N4)', () => {
  it.each([
    ['application/pdf', 'attachment-1.pdf'],
    ['image/png', 'attachment-1.png'],
    ['image/jpeg', 'attachment-1.jpg'],
    ['text/plain', 'attachment-1.txt'],
  ])('%s → %s (name · filename 둘 다) · RFC 2231 원래 이름은 그대로', (mimeType, fallback) => {
    const params = attachmentDispositionParams('견적서.bin', 0, mimeType);
    expect(params.contentTypeName).toBe(`name="${fallback}"`);
    expect(params.disposition).toContain(`filename="${fallback}"`);
    expect(params.disposition).toContain("filename*=UTF-8''%EA%B2%AC%EC%A0%81%EC%84%9C.bin");
  });

  it('자리 번호는 1부터 · ASCII 파일명은 대체 이름 없이 그대로 · 표 밖 MIME 은 확장자 없이', () => {
    expect(attachmentDispositionParams('사진.png', 2, 'image/png').contentTypeName).toBe('name="attachment-3.png"');
    expect(attachmentDispositionParams('photo.png', 0, 'image/png')).toEqual({ contentTypeName: 'name="photo.png"', disposition: 'attachment; filename="photo.png"' });
    expect(attachmentDispositionParams('문서', 0, 'application/zip').contentTypeName).toBe('name="attachment-1"');
  });

  it('buildRawMessage 가 파트의 MIME 으로 대체 이름을 만든다', () => {
    const raw = buildRawMessage({
      ...BASE,
      attachments: [
        { filename: '보고서.pdf', mimeType: 'application/pdf', data: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) },
        { filename: '메모.txt', mimeType: 'text/plain', data: new TextEncoder().encode('hi') },
      ],
    });
    expect(raw).toContain('Content-Type: application/pdf; name="attachment-1.pdf"');
    expect(raw).toContain('Content-Disposition: attachment; filename="attachment-1.pdf";');
    expect(raw).toContain('Content-Type: text/plain; name="attachment-2.txt"');
  });
});
