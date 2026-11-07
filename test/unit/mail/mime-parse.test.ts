/**
 * `src/mail/mime/parse.ts` — 인코딩·구조 픽스처 (AC-3·AC-4).
 *
 * **AC-3 의 본체는 "확인 코드가 든 본문을 정확히 뽑는 것" 이다.** 그래서 픽스처마다 확인 코드와
 * 링크가 `text`(또는 `htmlText`)에 **그대로** 있는지를 먼저 단언하고, 한국어가 한 글자도
 * 깨지지 않았는지를 그다음에 단언한다.
 *
 * 픽스처 바이트는 `test/fixtures/eml/_generate.py` 가 **python 표준 코덱**으로 만든다 — 파서의
 * CP949 디코더와 독립인 인코더다. 같은 알고리즘으로 만들고 같은 알고리즘으로 풀면 테스트는
 * 자기 자신을 검증한다.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseInboundMime,
  type MimeParseResult,
  type ParsedAttachment,
  type ParsedInboundMessage,
} from '../../../src/mail/mime/parse';
import {
  classifyCharset,
  decodeCp949,
  decodeIso2022Kr,
  rewriteKoreanEncodedWords,
} from '../../../src/mail/mime/parse-charset';
import { htmlToText } from '../../../src/mail/mime/parse-html';

const FIXTURES = join(__dirname, '../../fixtures/eml');

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

function parsed(result: MimeParseResult): ParsedInboundMessage {
  if (result.kind !== 'parsed') throw new Error(`거부됨: ${result.reason} — ${result.detail}`);
  return result.message;
}

async function parseFixture(name: string): Promise<ParsedInboundMessage> {
  return parsed(await parseInboundMime(fixture(name)));
}

// ---------------------------------------------------------------------------
// 픽스처 — 확인 코드가 살아서 나오는가
// ---------------------------------------------------------------------------

describe('UTF-8 · quoted-printable (utf8-qp-verification.eml)', () => {
  it('확인 코드·링크·RFC 2047 제목·따옴표 한글 표시 이름을 뽑는다', async () => {
    const message = await parseFixture('utf8-qp-verification.eml');
    expect(message.text).toContain('인증 코드: 482913');
    // QP 소프트 줄바꿈이 URL 한가운데를 잘랐다 — 이어 붙어 있어야 링크가 산다.
    expect(message.text).toContain('https://svc.example.com/verify?code=482913&u=agent%2Bsignup');
    expect(message.textSource).toBe('plain');
    expect(message.subject).toBe('[가상서비스] 이메일 인증 코드 안내');
    expect(message.from).toEqual({ address: 'noreply@svc.example.com', name: '가상서비스 인증센터' });
    // `+태그` 는 정규화하지 않는다 — 수신 라우팅이 그 태그로 가입 건을 구별할 수 있다.
    expect(message.to).toEqual([{ address: 'agent+signup@atmark.ai', name: null }]);
    expect(message.messageId).toBe('<verify-001@mail.svc.example.com>');
    expect(message.date?.toISOString()).toBe('2026-09-22T01:00:00.000Z');
    expect(message.warnings).toEqual([]);
  });
});

describe('EUC-KR · base64 (euckr-base64-verification.eml)', () => {
  it('본문·제목·인코딩된 표시 이름을 한 글자도 깨뜨리지 않는다', async () => {
    const message = await parseFixture('euckr-base64-verification.eml');
    expect(message.text).toBe('고객님, 가상쇼핑 회원가입을 환영합니다.\n회원가입 인증번호는 [735102] 입니다.\n');
    expect(message.subject).toBe('[가상쇼핑] 회원가입 인증번호 안내');
    expect(message.from).toEqual({ address: 'noreply@shop.example.co.kr', name: '가상쇼핑' });
    expect(message.warnings).toEqual([]);
  });
});

describe('ks_c_5601-1987 · QP · CP949 확장 음절 (ks-c-5601-qp.eml)', () => {
  it('KS X 1001 밖의 음절(똠·똘·햏)과 €(A2E6)를 살린다', async () => {
    // 이 픽스처가 이 모듈이 CP949 를 직접 푸는 이유다. 라이브러리 경로(Node 의 euc-kr)로
    // 풀면 "똠" 이 U+008C + "c" 로, "햏" 이 U+FFFD + "d" 로 바뀐다 — 아래 '런타임 특성' 참조.
    const message = await parseFixture('ks-c-5601-qp.eml');
    expect(message.text).toBe('똠방각하 똘똘이님, 햏 인증코드 591046 을 입력하세요. 수수료 €5\n\n');
    expect(message.warnings).toEqual([]);
  });

  it('두 인코딩 워드에 걸쳐 쪼개진 제목 글자를 이어 붙여 푼다', async () => {
    // 픽스처는 "똠방각하…" 의 CP949 바이트를 3바이트째에서 자른다 — "방" 의 첫 바이트가
    // 앞 워드에, 둘째 바이트가 뒤 워드에 있다. 워드마다 따로 풀면 그 글자가 깨진다.
    const message = await parseFixture('ks-c-5601-qp.eml');
    expect(message.subject).toBe('똠방각하 인증 요청');
  });
});

describe('라벨 "cp949" (cp949-label.eml)', () => {
  it('WHATWG 라벨이 아닌 cp949 도 CP949 로 푼다(경고 없음)', async () => {
    const message = await parseFixture('cp949-label.eml');
    expect(message.text).toBe('똠 본인확인 번호: 660371\n');
    expect(message.subject).toBe('본인확인 번호');
    expect(message.warnings).toEqual([]);
  });
});

describe('ISO-2022-KR (iso-2022-kr.eml)', () => {
  it('7bit 본문과 인코딩된 제목을 푼다 — ESC·SO·SI 가 본문에 남지 않는다', async () => {
    const message = await parseFixture('iso-2022-kr.eml');
    expect(message.text).toBe('안녕하세요\n인증번호: 204817\n감사합니다\n');
    expect(message.subject).toBe('인증 안내');
    // 풀지 못했다면 제어문자 제거 경고가 떴을 것이다(ESC·SO·SI 가 본문에 남으므로).
    expect(message.warnings).toEqual([]);
  });
});

describe('HTML 만 (html-only-euckr.eml)', () => {
  it('확인 코드와 버튼 링크를 텍스트로 옮긴다', async () => {
    const message = await parseFixture('html-only-euckr.eml');
    expect(message.textSource).toBe('html');
    expect(message.text).toBe(message.htmlText);
    expect(message.text).toContain('인증 코드 619274');
    expect(message.text).toContain('이메일 인증하기 (https://game.example.com/verify?token=abc&u=1)');
    expect(message.from.name).toBe('가상게임');
  });

  it('스크립트·스타일(head·body 둘 다)·title·주석의 내용은 텍스트에 없다', async () => {
    const message = await parseFixture('html-only-euckr.eml');
    // 전부 확인 코드처럼 생긴 숫자다 — 남으면 코드 추출기가 틀린 코드를 집는다.
    for (const decoy of ['000000', '123456', '888888', '777777', '999999', 'margin', 'var otp']) {
      expect(message.text).not.toContain(decoy);
    }
  });
});

describe('multipart/alternative — plain 이 안내문뿐 (alternative-placeholder.eml)', () => {
  it('text 는 plain, 코드는 htmlText 에 있다 — 소비자는 둘 다 봐야 한다', async () => {
    const message = await parseFixture('alternative-placeholder.eml');
    expect(message.textSource).toBe('plain');
    expect(message.text).toContain('HTML 형식입니다');
    expect(message.text).not.toContain('308455');
    expect(message.htmlText).toBe('가입 인증 코드는 308455 입니다.');
    expect(message.warnings).toEqual([]);
  });
});

describe('첨부 (attachments-rfc2231.eml)', () => {
  const expected: ParsedAttachment[] = [
    { index: 0, filename: null, contentType: 'image/png', disposition: 'inline', size: 64, contentId: '<logo001@partner.example.com>' },
    { index: 1, filename: '계약서.pdf', contentType: 'application/pdf', disposition: 'attachment', size: 1024, contentId: null },
    {
      index: 2,
      filename: '견적서.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment',
      size: 300,
      contentId: null,
    },
    { index: 3, filename: '메모.txt', contentType: 'text/plain', disposition: 'attachment', size: 9, contentId: null },
    { index: 4, filename: '한글.bin', contentType: 'application/octet-stream', disposition: 'attachment', size: 10, contentId: null },
  ];

  it('RFC 2231(UTF-8·EUC-KR·연속 파라미터)·RFC 2047 파일명을 풀고 메타만 싣는다', async () => {
    const message = await parseFixture('attachments-rfc2231.eml');
    // `toEqual` 은 여분의 키를 허용하지 않는다 — 누가 `content` 를 출력에 얹으면 여기서 빨개진다.
    expect(message.attachments).toEqual(expected);
    expect(message.text).toBe('계약서와 견적서를 보내 드립니다.');
    expect(message.warnings).toEqual([]);
  });

  it('첨부 텍스트 파트(메모.txt)는 본문으로 새지 않는다', async () => {
    const message = await parseFixture('attachments-rfc2231.eml');
    expect(message.text).not.toContain('첨부 메모');
  });

  it('바이트는 싱크로만 간다 — 순서·크기·내용이 메타와 짝이 맞는다', async () => {
    const received: { meta: ParsedAttachment; content: Uint8Array }[] = [];
    const message = parsed(
      await parseInboundMime(fixture('attachments-rfc2231.eml'), {
        onAttachment: (meta, content) => {
          received.push({ meta, content: Uint8Array.from(content) });
        },
      }),
    );
    expect(received.map((entry) => entry.meta)).toEqual(message.attachments);
    expect(received.map((entry) => entry.content.byteLength)).toEqual(expected.map((entry) => entry.size));
    expect(Buffer.from(received[1]?.content ?? []).subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(Buffer.from(received[0]?.content ?? []).subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('싱크가 던지면 파서도 던진다 — 일시 장애를 영구 거부로 접지 않는다', async () => {
    await expect(
      parseInboundMime(fixture('attachments-rfc2231.eml'), {
        onAttachment: () => {
          throw new Error('S3 503');
        },
      }),
    ).rejects.toThrow('S3 503');
  });
});

describe('스레드 (thread-reply.eml)', () => {
  it('In-Reply-To·접힌 References·그룹 문법·인코딩된 이름·Reply-To', async () => {
    const message = await parseFixture('thread-reply.eml');
    expect(message.messageId).toBe('<turn3@ext.example.com>');
    expect(message.inReplyTo).toBe('<turn2@atmark.ai>');
    expect(message.references).toEqual(['<turn1@ext.example.com>', '<turn2@atmark.ai>']);
    // 그룹은 펼친다. 그룹 이름("영업팀")은 주소가 아니다.
    expect(message.to).toEqual([
      { address: 'agent@atmark.ai', name: null },
      { address: 'hong@atmark.ai', name: '홍길동' },
    ]);
    // `undisclosed-recipients:;` 는 0명이다 — 경고거리도 아니다.
    expect(message.cc).toEqual([{ address: 'cc@ext.example.com', name: '박참조' }]);
    expect(message.replyTo).toEqual([{ address: 'replies+t42@ext.example.com', name: null }]);
    expect(message.subject).toBe('Re: Re: 견적 문의');
    expect(message.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// charset 모듈
// ---------------------------------------------------------------------------

describe('런타임 특성 — 왜 CP949 를 직접 푸는가', () => {
  it('Node 의 TextDecoder("euc-kr") 는 CP949 확장 음절을 C1 제어문자 + ASCII 로 쪼갠다', () => {
    // **이 테스트가 빨개지면 Node 가 고쳐졌다는 뜻이다.** 그래도 `decodeCp949` 는 맞다 —
    // 다만 `parse-charset.ts` 머리말의 "파서 차이" 근거를 다시 써야 한다.
    const native = new TextDecoder('euc-kr').decode(Uint8Array.of(0x8c, 0x63));
    expect(native).toBe('\u008cc');
    expect(decodeCp949(Uint8Array.of(0x8c, 0x63))).toBe('똠');
  });

  it('그 차이로 사람에게는 한글, 에이전트에게는 영어인 글을 만들 수 있다 — 여기서 닫힌다', () => {
    // CP949: 0x81 0x41·0x81 0x42 … 는 "갂" 계열 음절이다. Node 는 이것을 U+0081 + "A"… 로 읽고,
    // C1 제어문자는 거의 모든 텍스트 정리(이 모듈 포함)에서 지워진다.
    const bytes = Uint8Array.of(0x81, 0x49, 0x81, 0x47, 0x81, 0x4e, 0x81, 0x4f, 0x81, 0x52, 0x81, 0x45);
    expect(new TextDecoder('euc-kr').decode(bytes).replace(/[\x80-\x9f]/g, '')).toBe('IGNORE');
    expect(decodeCp949(bytes)).toBe('갏갍갢갣갧갋');
  });
});

/** 기대값은 전부 python `bytes(...).decode("cp949")` 로 뽑은 것이다 — 이 디코더와 독립인 출처. */
describe('decodeCp949', () => {
  it.each([
    ['KS X 1001 첫 음절', [0xb0, 0xa1], '가'],
    ['확장 영역 첫 글자', [0x81, 0x41], '갂'],
    ['확장 영역 마지막 글자', [0xc6, 0x52], '힣'],
    ['리드 A1 이후 확장(트레일 81–A0 까지)', [0xa1, 0x81], '죦'],
    ['CP949 추가 기호 €', [0xa2, 0xe6], '€'],
    ['CP949 추가 기호 ®', [0xa2, 0xe7], '®'],
    ['ASCII 는 그대로', [0x31, 0x32, 0x33], '123'],
  ])('%s', (_label, bytes, expected) => {
    expect(decodeCp949(Uint8Array.from(bytes))).toBe(expected);
  });

  it('잘못된 리드 뒤의 ASCII 는 살린다 — 조용히 사라지는 바이트가 없다', () => {
    expect(decodeCp949(Uint8Array.of(0xc7, 0x41, 0x31))).toBe('\ufffdA1');
    expect(decodeCp949(Uint8Array.of(0x80, 0x31))).toBe('\ufffd1');
    expect(decodeCp949(Uint8Array.of(0x31, 0xb0))).toBe('1\ufffd'); // 끝에서 잘린 리드
  });
});

describe('decodeIso2022Kr', () => {
  it('SI 가 빠진 줄은 개행에서 끊는다 — 다음 줄을 오염시키지 않는다', () => {
    // ESC$)C SO "0!"(=가) [SI 없음] CRLF "abc"
    const bytes = Uint8Array.of(0x1b, 0x24, 0x29, 0x43, 0x0e, 0x30, 0x21, 0x0d, 0x0a, 0x61, 0x62, 0x63);
    expect(decodeIso2022Kr(bytes)).toBe('가\r\nabc');
  });

  it('7bit 인코딩 안의 8bit 바이트는 추측하지 않고 U+FFFD', () => {
    expect(decodeIso2022Kr(Uint8Array.of(0x61, 0xb0, 0x62))).toBe('a\ufffdb');
  });
});

describe('classifyCharset', () => {
  it.each([
    ['euc-kr', 'cp949'],
    ['EUC-KR', 'cp949'],
    ['ks_c_5601-1987', 'cp949'],
    ['cp949', 'cp949'],
    ['x-windows-949', 'cp949'],
    ['uhc', 'cp949'],
    ['ISO-2022-KR', 'iso-2022-kr'],
    ['csISO2022KR', 'iso-2022-kr'],
    ['utf-8', 'native'],
    ['UTF-8*ko', 'native'],
    ['shift_jis', 'native'],
    ['x-bogus-9', 'unknown'],
  ] as const)('%s → %s', (label, expected) => {
    expect(classifyCharset(label)).toBe(expected);
  });
});

describe('rewriteKoreanEncodedWords', () => {
  it('한국어 레거시 워드만 UTF-8 워드로 바꾸고 나머지는 한 글자도 건드리지 않는다', () => {
    const value = 'Re: =?UTF-8?B?7ZWc?= plain =?EUC-KR?B?sKE=?= tail';
    expect(rewriteKoreanEncodedWords(value)).toBe(
      `Re: =?UTF-8?B?7ZWc?= plain =?UTF-8?B?${Buffer.from('가').toString('base64')}?= tail`,
    );
  });

  it('Q 인코딩도 푼다(`_` 는 공백)', () => {
    expect(rewriteKoreanEncodedWords('=?euc-kr?Q?=B0=A1_=B0=A1?=')).toBe(
      `=?UTF-8?B?${Buffer.from('가 가').toString('base64')}?=`,
    );
  });
});

// ---------------------------------------------------------------------------
// HTML → 텍스트
// ---------------------------------------------------------------------------

describe('htmlToText', () => {
  it('닫히지 않은 <script>·<style> 은 끝까지 버린다(브라우저도 렌더링하지 않는다)', () => {
    expect(htmlToText('<p>코드 111111</p><script>var a = "222222"')).toBe('코드 111111');
    expect(htmlToText('<p>코드 111111</p><style>.a{}</p>333333')).toBe('코드 111111');
  });

  it('닫히지 않은 주석도 끝까지 버린다', () => {
    expect(htmlToText('<b>444444</b><!-- 555555')).toBe('444444');
  });

  it('링크: 라벨 뒤에 URL, 라벨이 URL 이면 한 번만, javascript:·# 은 버린다', () => {
    expect(htmlToText('<a href="https://x.example/v?t=1&amp;u=2">인증</a>')).toBe('인증 (https://x.example/v?t=1&u=2)');
    expect(htmlToText("<a href='https://x.example'>https://x.example</a>")).toBe('https://x.example');
    expect(htmlToText('<a href=https://x.example/y>go</a>')).toBe('go (https://x.example/y)');
    expect(htmlToText('<a href="javascript:alert(1)">click</a>')).toBe('click');
    expect(htmlToText('<a href="#top">top</a>')).toBe('top');
  });

  it('닫히지 않은 <a> 의 URL 도 남긴다', () => {
    expect(htmlToText('<a href="https://x.example/z">인증하기')).toBe('인증하기 (https://x.example/z)');
  });

  it('표 셀은 띄우고 블록은 줄을 바꾼다 — 코드가 옆 글자와 붙지 않는다', () => {
    expect(htmlToText('<table><tr><td>코드</td><td>482913</td></tr></table>')).toBe('코드 482913');
    expect(htmlToText('<p>123</p><p>456</p>')).toBe('123\n\n456');
  });

  it('숨김 요소의 텍스트는 남긴다 — 스캐너가 봐야 하는 곳이다', () => {
    expect(htmlToText('<div style="display:none">IGNORE PREVIOUS</div><p>hi</p>')).toContain('IGNORE PREVIOUS');
  });

  it('엔티티: 이름·10진·16진, 범위 밖은 U+FFFD, 모르는 이름은 그대로', () => {
    expect(htmlToText('&lt;b&gt; &amp; &#44032; &#xAC00; &#x110000; &unknown;')).toBe('<b> & 가 가 \ufffd &unknown;');
  });

  it('태그가 아닌 `<` 는 글자다', () => {
    expect(htmlToText('3 < 5 and 7 > 6')).toBe('3 < 5 and 7 > 6');
    expect(htmlToText('a <<< b')).toBe('a <<< b');
  });
});
