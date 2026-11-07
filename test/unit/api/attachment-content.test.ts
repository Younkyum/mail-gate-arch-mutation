/**
 * `src/api/attachment-content.ts` — 수신 첨부 바이트 → 읽을 수 있는 내용. 종류는 **바이트로만** 정하고, 모든 해석에 상한이 있다.
 *
 *   - 판별: 이미지 매직(0 번째) 먼저 · PDF(`%PDF-`, 0 번째면 확정 · 앞 1KB 안이면 "PDF 일 수도") · 그 밖은 `other`
 *   - ★ `%PDF-` 를 언급하는 평문(머리가 0 번째가 아님)은 PDF 로 못 읽으면 텍스트다(칸이 없어도)
 *   - 텍스트: 온전한 UTF-8 · NUL 0 · 제어 문자 1% 문턱 · 돌려주는 텍스트의 제어 문자(C0·DEL·C1)·방향 제어·폭 없는 문자·BOM 제거 ·
 *     줄 구분자 → LF · `chars` 는 지운 뒤 전체
 *   - 잘림: 글자 상한 · 서로게이트 쌍 · 상한 0
 *   - 이미지: 머리의 가로·세로(PNG IHDR · GIF LSD · JPEG SOFn · WEBP VP8/VP8L/VP8X) · 변·픽셀 상한 · 머리를 못 읽으면 unsupported ·
 *     가로·세로 0 거부 · ★ 움직이는 이미지(GIF 서술자 걷기 · APNG acTL/fcTL · WEBP ANMF)의 프레임 수·프레임 크기·프레임 넓이 합 상한 · 바이트 끝 안전
 *   - PDF(워커 스레드): 쪽 · 쪽 상한(20) · 글자 상한에서 멈춤(뒤 쪽을 읽지 않는다) · 텍스트 층 없음 · 깨진·암호 PDF · 한국어 CID 글꼴(CMap)
 *   - ★ PDF 상한: 시간(`terminate`) · 힙(워커 OOM) · RSS 감시 → 정상 결과(`pdf_time_limit`·`pdf_limit`) · 읽은 쪽이 있으면 부분 결과 ·
 *     1쪽 뒤 쪽 오류도 부분 결과 · 처리되지 않은 거부 0
 *   - ★ PDF RSS: 시작 RSS 상한을 넘으면 `busy`(칸도 잡지 않는다) · 절대 상한에 걸리면 `pdf_limit`
 *   - ★ 함대 칸: 없으면 `busy`(워커를 띄우지 않는다) · 칸 저장소가 던져도 `busy` · 에이전트 id 로 잡는다 · 칸은 결과가 무엇이든 한 번 놓는다
 *   - ★ 실패 기억: `pdf_limit`·`pdf_time_limit`·`unreadable_pdf` 는 같은 저장 키면 다시 풀지 않는다(칸도 잡지 않는다) · 성공·암호 PDF 는 기억하지 않는다
 *   (결과가 워커 `'exit'` 뒤에 나는지는 `attachment-content-exit.test.ts`)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ATTACHMENT_CONTENT_LIMITS,
  UNSUPPORTED_DETAIL,
  capText,
  decodeTextAttachment,
  imageDimensions,
  readAttachmentContent,
  sniffAttachment,
  stripControlChars,
  type AttachmentContentLimits,
  type PdfParseContext,
} from '../../../src/api/attachment-content';
import type { PdfParseSlots } from '../../../src/db/repositories/pdf-parse-slots';
import { koreanCidPdf, minimalPdf, missingSecondPagePdf, textBombPdf } from '../../support/minimal-pdf';

const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u16be = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u24le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (text: string): number[] => [...Buffer.from(text, 'latin1')];

function png(width: number, height: number): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii('IHDR'), ...u32be(width), ...u32be(height), 8, 2, 0, 0, 0, 0, 0, 0, 0]);
}
function gif(width: number, height: number, version = '89a'): Uint8Array {
  return Uint8Array.from([...ascii(`GIF${version}`), ...u16le(width), ...u16le(height), 0, 0, 0]);
}
/** GIF 프레임 하나 — 그래픽 제어 확장 · 이미지 서술자(지역 색표 2색) · LZW 최소 코드 크기 · 하위 블록 하나 · 끝. */
function gifFrame(width: number, height: number, left = 0, top = 0): number[] {
  return [0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, ...u16le(left), ...u16le(top), ...u16le(width), ...u16le(height), 0x80, 0, 0, 0, 0, 0, 0, 2, 2, 0x4c, 0x01, 0];
}
function animatedGif(width: number, height: number, frames: readonly number[][]): Uint8Array {
  // 전역 색표 2색(묶음 0x80) · 애플리케이션 확장(NETSCAPE 반복) · 프레임들 · 끝(0x3B)
  const netscape = [0x21, 0xff, 11, ...ascii('NETSCAPE2.0'), 3, 1, 0, 0, 0];
  return Uint8Array.from([...ascii('GIF89a'), ...u16le(width), ...u16le(height), 0x80, 0, 0, 0, 0, 0, 0, 0, 0, ...netscape, ...frames.flat(), 0x3b]);
}
function pngChunk(type: string, data: number[]): number[] {
  return [...u32be(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
}
interface FrameSpec {
  readonly w: number;
  readonly h: number;
  readonly x?: number;
  readonly y?: number;
}
/** APNG — IHDR · acTL(선언 프레임 수) · 프레임마다 fcTL · IEND. */
function apng(width: number, height: number, declared: number, frames: readonly FrameSpec[]): Uint8Array {
  const ihdr = pngChunk('IHDR', [...u32be(width), ...u32be(height), 8, 2, 0, 0, 0]);
  const actl = pngChunk('acTL', [...u32be(declared), ...u32be(0)]);
  const fctls = frames.flatMap((frame, i) =>
    pngChunk('fcTL', [...u32be(i), ...u32be(frame.w), ...u32be(frame.h), ...u32be(frame.x ?? 0), ...u32be(frame.y ?? 0), 0, 1, 0, 10, 0, 0]),
  );
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...actl, ...fctls, ...pngChunk('IEND', [])]);
}
/** 움직이는 WEBP — VP8X(애니메이션 표지) · ANIM · 프레임마다 ANMF(프레임 자료 없음 — 머리만 본다). */
function animatedWebp(width: number, height: number, frames: readonly FrameSpec[]): Uint8Array {
  const chunk = (type: string, data: number[]): number[] => [...ascii(type), ...u32le(data.length), ...data, ...(data.length % 2 === 1 ? [0] : [])];
  const vp8x = chunk('VP8X', [0x02, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
  const anim = chunk('ANIM', [0, 0, 0, 0, 0, 0]);
  const anmfs = frames.flatMap((f) => chunk('ANMF', [...u24le((f.x ?? 0) / 2), ...u24le((f.y ?? 0) / 2), ...u24le(f.w - 1), ...u24le(f.h - 1), 100, 0, 0, 0]));
  const body = [...ascii('WEBP'), ...vp8x, ...anim, ...anmfs];
  return Uint8Array.from([...ascii('RIFF'), ...u32le(body.length), ...body]);
}
/** APP0(JFIF) 뒤에 SOF — `sof` 로 표지를 고른다(C0 기본, C2 진행형). */
function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...u16be(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, sof, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
}
function webp(chunk: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): Uint8Array {
  let payload: number[];
  if (chunk === 'VP8 ') payload = [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)];
  else if (chunk === 'VP8L') {
    const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
    payload = [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff];
  } else payload = [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)];
  return Uint8Array.from([...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBP'), ...ascii(chunk), payload.length, 0, 0, 0, ...payload]);
}

const PNG = png(64, 48);
const JPEG = jpeg(640, 480);
const GIF87 = gif(10, 10, '87a');
const GIF89 = gif(10, 10);
const WEBP = webp('VP8 ', 320, 200);
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0]);
const ELF = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

function limits(overrides: Partial<AttachmentContentLimits>): AttachmentContentLimits {
  return { ...ATTACHMENT_CONTENT_LIMITS, ...overrides };
}

/** 칸 가짜 — 잡기·놓기 횟수와 잡은 에이전트를 센다. `free: false` 면 늘 칸이 없다. */
function slots(free = true): PdfParseSlots & { acquired: number; released: number; agents: string[] } {
  const counter = {
    acquired: 0,
    released: 0,
    agents: [] as string[],
    tryAcquire(agentId: string) {
      if (!free) return Promise.resolve(null);
      counter.acquired += 1;
      counter.agents.push(agentId);
      return Promise.resolve({
        release: () => {
          counter.released += 1;
          return Promise.resolve();
        },
      });
    },
  };
  return counter;
}

const AGENT = 'a'.repeat(32);
let keys = 0;
/** 부를 때마다 새 저장 키 — 실패 기억(같은 키)이 다른 단언에 끼어들지 않게. 같은 키를 쓰려면 `key` 를 준다. */
const pdfContext = (slotStore: PdfParseSlots, key = `inbound/attachments/test-${String((keys += 1))}`): PdfParseContext => ({
  slots: slotStore,
  agentId: AGENT,
  cacheKey: key,
});
const FREE = slots();
const read = (bytes: Uint8Array, overrides: Partial<AttachmentContentLimits> = {}) => readAttachmentContent(bytes, pdfContext(FREE), limits(overrides));

/** 워커를 끊는 경로(시간·메모리)가 뒤늦게 거부되는 약속을 남기지 않는지 — 이 파일 전체에서 모은다. */
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeAll(() => {
  process.on('unhandledRejection', onUnhandled);
});
afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
});

/** 사용자 암호가 빈 문자열이 아닌 표준 보안 처리기 — 판독기가 빈 암호로 열어 보고 암호 오류를 낸다. */
function encryptedPdf(): Uint8Array {
  const plain = new TextDecoder().decode(minimalPdf(['secret']));
  const hex32 = 'ab'.repeat(32);
  const encryptObject = `<< /Filter /Standard /V 1 /R 2 /O <${hex32}> /U <${hex32}> /P -4 >>`;
  const xrefAt = plain.indexOf('xref\n');
  const body = `${plain.slice(0, xrefAt)}6 0 obj\n${encryptObject}\nendobj\n`; // 한 쪽짜리 최소 PDF 는 객체 다섯
  const offsets = [...body.matchAll(/^(\d+) 0 obj$/gm)].map((match) => match.index);
  const xref = body.length;
  let out = `${body}xref\n0 ${String(offsets.length + 1)}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${String(offsets.length + 1)} /Root 1 0 R /Encrypt 6 0 R /ID [<${'00'.repeat(16)}> <${'00'.repeat(16)}>] >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('종류 판별 — 바이트로만', () => {
  it.each([
    ['PNG', PNG, { kind: 'image', mimeType: 'image/png' }],
    ['JPEG', JPEG, { kind: 'image', mimeType: 'image/jpeg' }],
    ['GIF87a', GIF87, { kind: 'image', mimeType: 'image/gif' }],
    ['GIF89a', GIF89, { kind: 'image', mimeType: 'image/gif' }],
    ['WEBP', WEBP, { kind: 'image', mimeType: 'image/webp' }],
    ['PDF', minimalPdf(['x']), { kind: 'pdf', headerAtStart: true }],
    ['ZIP(docx 등)', ZIP, { kind: 'other' }],
    ['ELF', ELF, { kind: 'other' }],
    ['평문', new TextEncoder().encode('hello'), { kind: 'other' }],
    ['빈 파일', new Uint8Array(0), { kind: 'other' }],
  ])('%s', (_label, bytes, expected) => {
    expect(sniffAttachment(bytes)).toEqual(expected);
  });

  it('PDF 머리는 앞 1KB 안이면 "PDF 일 수도"(0 번째가 아님), 그 뒤면 PDF 가 아니다', () => {
    const pdf = new TextEncoder().encode('%PDF-1.4\n');
    const near = new Uint8Array(1000 + pdf.length);
    near.fill(0x20);
    near.set(pdf, 1000);
    expect(sniffAttachment(near)).toEqual({ kind: 'pdf', headerAtStart: false });
    const far = new Uint8Array(2000 + pdf.length);
    far.fill(0x20);
    far.set(pdf, 2000);
    expect(sniffAttachment(far)).toEqual({ kind: 'other' });
  });

  it('이미지 매직이 먼저다 — 앞 1KB 에 `%PDF-` 가 있어도 0 번째가 PNG 면 이미지', () => {
    const bytes = new Uint8Array(200);
    bytes.set(PNG, 0);
    bytes.set(new TextEncoder().encode('%PDF-1.7'), 100);
    expect(sniffAttachment(bytes)).toEqual({ kind: 'image', mimeType: 'image/png' });
  });

  it('RIFF 이지만 WEBP 가 아니면(WAV) 이미지가 아니다 · 잘린 시그니처도 아니다', () => {
    const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(sniffAttachment(wav)).toEqual({ kind: 'other' });
    expect(sniffAttachment(PNG.slice(0, 4))).toEqual({ kind: 'other' });
  });
});

describe('텍스트 판정', () => {
  it('UTF-8(한글·이모지·CSV·JSON·HTML) 은 텍스트 — BOM 은 벗긴다', () => {
    for (const value of ['이름,금액\n홍길동,1000\n', '{"a":1}', '<p>hi</p>', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', '🙂 ok\t\f']) {
      expect(decodeTextAttachment(new TextEncoder().encode(value))).toBe(value);
    }
    expect(decodeTextAttachment(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
  });

  it('NUL 이 하나라도 · 깨진 UTF-8 · UTF-16 · 제어 문자 투성이면 텍스트가 아니다', () => {
    expect(decodeTextAttachment(Uint8Array.from([0x61, 0x00, 0x62]))).toBeNull();
    expect(decodeTextAttachment(Uint8Array.from([0xc3, 0x28]))).toBeNull();
    expect(decodeTextAttachment(Uint8Array.from([0xff, 0xfe, 0x61, 0x00]))).toBeNull();
    expect(decodeTextAttachment(Uint8Array.from([0xe9, 0x74, 0xe9]))).toBeNull(); // Latin-1 "été"
    expect(decodeTextAttachment(new TextEncoder().encode(`${'\u0001\u0002'.repeat(10)}abc`))).toBeNull();
    expect(decodeTextAttachment(ZIP)).toBeNull();
  });

  it('제어 문자 1% 문턱 — 100자 중 1개는 텍스트, 2개는 아니다(탭·개행·CR·폼피드·ESC 는 세지 않는다)', () => {
    expect(decodeTextAttachment(new TextEncoder().encode(`${'a'.repeat(99)}\u0007`))).toBe(`${'a'.repeat(99)}\u0007`);
    expect(decodeTextAttachment(new TextEncoder().encode(`${'a'.repeat(98)}\u0007\u0008`))).toBeNull();
    expect(decodeTextAttachment(new TextEncoder().encode(`${'a'.repeat(90)}\t\n\r\f\u001b\t\n\r\f\u001b`))).not.toBeNull();
  });

  it('stripControlChars — 탭·LF·CR 밖의 C0 · DEL · C1 을 지운다(MCP 블록과 같은 범주)', () => {
    expect(stripControlChars('a\u0000b\u0007c\u001bd\u007fe\u0085f\u009bg\th\ni\rj k')).toBe('abcdefg\th\ni\rj k');
  });

  it('★ stripControlChars — 방향 제어(U+202A–202E · U+2066–2069) · 폭 없는 문자·방향 표지(U+200B–200F) · 본문 안 BOM 을 지우고 줄 구분자는 LF', () => {
    const hidden = ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩', '​', '‌', '‍', '‎', '‏', '﻿'];
    expect(stripControlChars(`pay${hidden.join('')}ment`)).toBe('payment');
    expect(stripControlChars('invoice ‮gnp.exe')).toBe('invoice gnp.exe');
    expect(stripControlChars('one two three')).toBe('one\ntwo\nthree');
    // 이웃 글자(U+2010 하이픈 · U+2030 퍼밀)는 그대로.
    expect(stripControlChars('a‐b‰c')).toBe('a‐b‰c');
  });

  it('★ 평문 첨부도 방향 제어를 지운 뒤 돌려준다 · chars 는 지운 뒤 길이', async () => {
    expect(await read(new TextEncoder().encode('﻿safe‮.txt next'))).toEqual({ kind: 'text', text: 'safe.txt\nnext', chars: 13, truncated: false });
  });

  it('capText — 상한에서 자르되 서로게이트 쌍을 가르지 않는다 · 상한 0', () => {
    expect(capText('abcdef', 10)).toEqual({ text: 'abcdef', truncated: false });
    expect(capText('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(capText('ab🙂c', 3)).toEqual({ text: 'ab', truncated: true });
    expect(capText('abc', 0)).toEqual({ text: '', truncated: true });
    expect(capText('', 0)).toEqual({ text: '', truncated: false });
  });
});

describe('이미지 크기 — 머리만 읽는다', () => {
  it.each([
    ['PNG', png(1234, 567), 'image/png'],
    ['GIF', gif(1234, 567), 'image/gif'],
    ['JPEG(SOF0)', jpeg(1234, 567), 'image/jpeg'],
    ['JPEG(SOF2 진행형)', jpeg(1234, 567, 0xc2), 'image/jpeg'],
    ['WEBP(VP8)', webp('VP8 ', 1234, 567), 'image/webp'],
    ['WEBP(VP8L)', webp('VP8L', 1234, 567), 'image/webp'],
    ['WEBP(VP8X)', webp('VP8X', 1234, 567), 'image/webp'],
  ] as const)('%s — 가로·세로', (_label, bytes, mimeType) => {
    expect(imageDimensions(bytes, mimeType)).toEqual({ width: 1234, height: 567, frames: 1, framePixels: 1234 * 567 });
  });

  it.each([
    ['PNG 0×10', png(0, 10), 'image/png'],
    ['PNG 10×0', png(10, 0), 'image/png'],
    ['GIF 0×10', gif(0, 10), 'image/gif'],
    ['JPEG 10×0', jpeg(10, 0), 'image/jpeg'],
    ['WEBP(VP8) 0×10', webp('VP8 ', 0, 10), 'image/webp'],
  ] as const)('★ %s — 가로나 세로가 0 이면 이미지가 아니다(unsupported_type)', async (_label, bytes, mimeType) => {
    expect(imageDimensions(bytes, mimeType)).toBeNull();
    expect(await read(bytes)).toEqual({ kind: 'unsupported', reason: 'unsupported_type' });
  });

  it('잘린·깨진 머리는 null — 이미지로 인정하지 않는다(unsupported_type)', async () => {
    expect(imageDimensions(PNG.slice(0, 20), 'image/png')).toBeNull();
    expect(imageDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 8]), 'image/jpeg')).toBeNull();
    expect(imageDimensions(webp('VP8X', 10, 10).slice(0, 26), 'image/webp')).toBeNull();
    expect(await read(PNG.slice(0, 16))).toEqual({ kind: 'unsupported', reason: 'unsupported_type' });
  });

  it.each([
    ['PNG 한 변 8001', png(8001, 10)],
    ['GIF 한 변 8001', gif(10, 8001)],
    ['JPEG 7000×7000(49MP)', jpeg(7000, 7000)],
    ['WEBP(VP8L) 한 변 8001', webp('VP8L', 8001, 10)],
    ['WEBP(VP8X) 16383×16383', webp('VP8X', 16383, 16383)],
    ['WEBP(VP8) 8001', webp('VP8 ', 8001, 1)],
  ])('★ %s → image_too_large(작은 파일의 거대한 캔버스)', async (_label, bytes) => {
    expect(await read(bytes)).toEqual({ kind: 'unsupported', reason: 'image_too_large' });
  });

  it('상한 경계 — 8000×5000(40MP) 은 통과한다', async () => {
    expect(await read(png(8000, 5000))).toMatchObject({ kind: 'image', mimeType: 'image/png' });
  });
});

describe('움직이는 이미지 — 프레임 수·크기', () => {
  const frames = (count: number, w: number, h: number): FrameSpec[] => Array.from({ length: count }, () => ({ w, h }));

  it('GIF — 서술자를 끝까지 걸어 프레임을 센다(확장·색표·하위 블록을 건너뛴다)', () => {
    const three = animatedGif(100, 80, [gifFrame(100, 80), gifFrame(50, 40, 10, 10), gifFrame(100, 80)]);
    expect(imageDimensions(three, 'image/gif')).toEqual({ width: 100, height: 80, frames: 3, framePixels: 100 * 80 * 2 + 50 * 40 });
  });

  it('★ GIF — 프레임 상한(100) · 프레임이 한 변 상한을 넘거나 캔버스 밖으로 커지면 image_too_large', async () => {
    expect(ATTACHMENT_CONTENT_LIMITS.maxImageFrames).toBe(100);
    expect(await read(animatedGif(10, 10, Array.from({ length: 100 }, () => gifFrame(10, 10))))).toMatchObject({ kind: 'image' });
    expect(await read(animatedGif(10, 10, Array.from({ length: 101 }, () => gifFrame(10, 10))))).toEqual({ kind: 'unsupported', reason: 'image_too_large' });
    expect(await read(animatedGif(10, 10, [gifFrame(10, 10), gifFrame(9000, 10)]))).toEqual({ kind: 'unsupported', reason: 'image_too_large' });
    expect(await read(animatedGif(10, 10, [gifFrame(10, 10, 7995, 0)]))).toEqual({ kind: 'unsupported', reason: 'image_too_large' });
  });

  it('★ GIF — 프레임 넓이의 합이 상한(160MP)을 넘으면 image_too_large(한 장씩은 통과해도)', async () => {
    const big = Array.from({ length: 5 }, () => gifFrame(8000, 5000)); // 5 × 40MP = 200MP
    expect(await read(animatedGif(8000, 5000, big))).toEqual({ kind: 'unsupported', reason: 'image_too_large' });
    expect(await read(animatedGif(8000, 5000, big.slice(0, 4)))).toMatchObject({ kind: 'image' }); // 160MP
  });

  it('GIF — 잘린 파일은 거기까지 본 프레임으로 · 모르는 블록은 깨진 파일 · 바이트 끝을 넘지 않는다', () => {
    const whole = animatedGif(20, 20, [gifFrame(20, 20), gifFrame(20, 20)]);
    for (let cut = 13; cut < whole.length; cut += 1) {
      const size = imageDimensions(whole.slice(0, cut), 'image/gif');
      expect(size?.frames ?? 0).toBeLessThanOrEqual(2);
    }
    expect(imageDimensions(whole.slice(0, whole.length - 1), 'image/gif')).toMatchObject({ frames: 2 });
    expect(imageDimensions(Uint8Array.from([...gif(20, 20), 0x99, 0, 0]), 'image/gif')).toBeNull();
    // 하위 블록 크기가 파일 끝을 한참 넘어도 멈춘다.
    expect(imageDimensions(Uint8Array.from([...gif(20, 20), 0x21, 0xfe, 0xff, 1, 2]), 'image/gif')).toMatchObject({ frames: 1 });
  });

  it('★ APNG — acTL 이 선언한 프레임 수 · fcTL 마다의 크기', async () => {
    expect(imageDimensions(apng(64, 48, 2, [{ w: 64, h: 48 }, { w: 32, h: 24, x: 8, y: 8 }]), 'image/png')).toEqual({
      width: 64,
      height: 48,
      frames: 2,
      framePixels: 64 * 48 + 32 * 24,
    });
    expect(await read(apng(64, 48, 100, frames(1, 64, 48)))).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    expect(await read(apng(64, 48, 101, frames(1, 64, 48)))).toEqual({ kind: 'unsupported', reason: 'image_too_large' });
    expect(await read(apng(64, 48, 0xffffffff, []))).toEqual({ kind: 'unsupported', reason: 'image_too_large' });
    // 선언이 적어도 fcTL 이 더 많으면 fcTL 수로.
    expect(await read(apng(8, 8, 1, frames(101, 8, 8)))).toEqual({ kind: 'unsupported', reason: 'image_too_large' });
    expect(await read(apng(64, 48, 2, [{ w: 64, h: 48 }, { w: 9000, h: 48 }]))).toEqual({ kind: 'unsupported', reason: 'image_too_large' });
    expect(await read(apng(8000, 5000, 5, frames(5, 8000, 5000)))).toEqual({ kind: 'unsupported', reason: 'image_too_large' });
  });

  it('APNG — 잘린 청크도 바이트 끝을 넘지 않는다', () => {
    const whole = apng(16, 16, 3, frames(3, 16, 16));
    for (let cut = 24; cut < whole.length; cut += 1) {
      const size = imageDimensions(whole.slice(0, cut), 'image/png');
      expect(size?.frames ?? 1).toBeLessThanOrEqual(3);
    }
  });

  it('★ WEBP — ANMF 마다 프레임을 센다 · 프레임 상한 · 프레임 크기', async () => {
    expect(imageDimensions(animatedWebp(100, 80, [{ w: 100, h: 80 }, { w: 50, h: 40, x: 10, y: 20 }]), 'image/webp')).toEqual({
      width: 100,
      height: 80,
      frames: 2,
      framePixels: 100 * 80 + 50 * 40,
    });
    expect(await read(animatedWebp(10, 10, frames(100, 10, 10)))).toMatchObject({ kind: 'image', mimeType: 'image/webp' });
    expect(await read(animatedWebp(10, 10, frames(101, 10, 10)))).toEqual({ kind: 'unsupported', reason: 'image_too_large' });
    expect(await read(animatedWebp(10, 10, [{ w: 9000, h: 10 }]))).toEqual({ kind: 'unsupported', reason: 'image_too_large' });
    expect(await read(animatedWebp(8000, 5000, frames(5, 8000, 5000)))).toEqual({ kind: 'unsupported', reason: 'image_too_large' });
  });

  it('WEBP — 잘린 청크도 바이트 끝을 넘지 않는다', () => {
    const whole = animatedWebp(16, 16, frames(3, 16, 16));
    for (let cut = 30; cut < whole.length; cut += 1) {
      const size = imageDimensions(whole.slice(0, cut), 'image/webp');
      expect(size?.frames ?? 1).toBeLessThanOrEqual(3);
    }
  });
});

describe('readAttachmentContent — 텍스트·이미지', () => {
  it('텍스트 — 상한까지 돌려주고 chars 는 전체, truncated 를 말한다', async () => {
    const text = 'x'.repeat(250);
    expect(await read(new TextEncoder().encode(text), { maxTextChars: 100 })).toEqual({ kind: 'text', text: 'x'.repeat(100), chars: 250, truncated: true });
    expect(await read(new TextEncoder().encode('짧은 글'))).toEqual({ kind: 'text', text: '짧은 글', chars: 4, truncated: false });
  });

  it('★ 돌려주는 텍스트에서 제어 문자를 지운다 · chars 는 지운 뒤 길이', async () => {
    const bytes = new TextEncoder().encode(`${'a'.repeat(200)}\u001b[31m\u0085\u007f\ttail`);
    expect(await read(bytes)).toEqual({ kind: 'text', text: `${'a'.repeat(200)}[31m\ttail`, chars: 209, truncated: false });
  });

  it('이미지 — 판별한 MIME 과 base64(왕복 동일) · 바이트 상한을 넘으면 image_too_large', async () => {
    const result = await read(PNG);
    expect(result).toEqual({ kind: 'image', mimeType: 'image/png', dataBase64: Buffer.from(PNG).toString('base64') });
    if (result.kind === 'image') expect(Buffer.from(result.dataBase64, 'base64')).toEqual(Buffer.from(PNG));
    expect(await read(PNG, { maxImageBytes: 8 })).toEqual({ kind: 'unsupported', reason: 'image_too_large' });
    for (const [bytes, mimeType] of [[JPEG, 'image/jpeg'], [GIF87, 'image/gif'], [WEBP, 'image/webp']] as const) {
      expect(await read(bytes)).toMatchObject({ kind: 'image', mimeType });
    }
  });

  it('ZIP·실행 파일은 unsupported_type · 읽기 상한을 넘는 바이트는 too_large', async () => {
    expect(await read(ZIP)).toEqual({ kind: 'unsupported', reason: 'unsupported_type' });
    expect(await read(ELF)).toEqual({ kind: 'unsupported', reason: 'unsupported_type' });
    expect(await read(new Uint8Array(11), { maxReadBytes: 10 })).toEqual({ kind: 'unsupported', reason: 'too_large' });
  });

  it('★ `%PDF-` 를 언급하는 평문(머리가 0 번째가 아님)은 텍스트다 — PDF 로 못 읽으면 넘어간다 · 칸이 없어도', async () => {
    const note = 'Upload log: the scanner saw a %PDF-1.7 header in invoice.pdf and accepted it.\n';
    const bytes = new TextEncoder().encode(note);
    expect(await read(bytes)).toEqual({ kind: 'text', text: note, chars: note.length, truncated: false });
    expect(await readAttachmentContent(bytes, pdfContext(slots(false)))).toEqual({ kind: 'text', text: note, chars: note.length, truncated: false });
    // 0 번째 머리는 PDF 로 확정 — 못 읽으면 unreadable_pdf(텍스트로 넘어가지 않는다).
    expect(await read(new TextEncoder().encode('%PDF-1.7\nnot really a pdf'))).toEqual({ kind: 'unsupported', reason: 'unreadable_pdf' });
    // 앞에 쓰레기가 붙은 **진짜** PDF 는 PDF 로 읽는다.
    const prefixed = new Uint8Array([...new TextEncoder().encode('junk\n'), ...minimalPdf(['Prefixed invoice text here'])]);
    expect(await read(prefixed)).toMatchObject({ kind: 'pdf_text', pages: 1 });
  });
});

describe('readAttachmentContent — PDF(워커 스레드)', () => {
  it('쪽마다 텍스트를 뽑는다(쪽 수·읽은 쪽 수) · 전체 글자 수는 싣지 않는다', async () => {
    const result = await read(minimalPdf(['Invoice number 4217 total 99000 KRW', 'Second page payment terms net 30']));
    expect(result).toMatchObject({ kind: 'pdf_text', pages: 2, pagesRead: 2, truncated: false, noTextLayer: false });
    if (result.kind !== 'pdf_text') throw new Error(result.kind);
    expect(result.text).toContain('Invoice number 4217 total 99000 KRW');
    expect(result.text).toContain('Second page payment terms net 30');
    expect(result.text.indexOf('Invoice')).toBeLessThan(result.text.indexOf('Second'));
    expect(Object.keys(result)).not.toContain('chars');
  });

  it('쪽 상한을 넘으면 앞쪽만 읽고 truncated · 기본 쪽 상한은 20', async () => {
    expect(ATTACHMENT_CONTENT_LIMITS.maxPdfPages).toBe(20);
    const result = await read(minimalPdf(['page one text here', 'page two text here', 'page three text here']), { maxPdfPages: 2 });
    expect(result).toMatchObject({ kind: 'pdf_text', pages: 3, pagesRead: 2, truncated: true });
    if (result.kind === 'pdf_text') expect(result.text).not.toContain('three');
  });

  it('★ 글자 상한에서 자르고 **멈춘다** — 뒤 쪽은 읽지 않는다(pagesRead) · truncated', async () => {
    const result = await read(minimalPdf(['abcdefghijklmnopqrstuvwxyz0123456789', 'second page', 'third page']), { maxTextChars: 10 });
    expect(result).toEqual({ kind: 'pdf_text', text: 'abcdefghij', truncated: true, pages: 3, pagesRead: 1, noTextLayer: false });
  });

  it('텍스트가 (거의) 없으면 no_text_layer(스캔본)', async () => {
    expect(await read(minimalPdf(['', '']))).toMatchObject({ kind: 'pdf_text', pages: 2, pagesRead: 2, noTextLayer: true, text: expect.any(String) });
  });

  it('★ 한국어 CID 글꼴(KSCms-UHC-H · ToUnicode 없음)도 텍스트가 나온다 — 번들 안 CMap', async () => {
    const cp949 = Uint8Array.from([0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4]); // 안녕하세요
    expect(await read(koreanCidPdf(cp949))).toMatchObject({ kind: 'pdf_text', text: '안녕하세요', pagesRead: 1 });
  });

  it('깨진 PDF 는 unreadable_pdf · 암호 PDF 는 encrypted_pdf', async () => {
    expect(await read(new TextEncoder().encode('%PDF-1.7\nnot really a pdf'))).toEqual({ kind: 'unsupported', reason: 'unreadable_pdf' });
    expect(await read(encryptedPdf())).toEqual({ kind: 'unsupported', reason: 'encrypted_pdf' });
  });

  it('★ 1쪽을 읽은 뒤의 쪽 오류는 부분 결과(truncated) — 읽은 쪽을 버리지 않는다', async () => {
    expect(await read(missingSecondPagePdf('First page survives'))).toMatchObject({
      kind: 'pdf_text',
      text: 'First page survives',
      pages: 2,
      pagesRead: 1,
      truncated: true,
    });
  });

  it('★ 시간 상한 — 쪽을 읽기 전이면 pdf_time_limit', async () => {
    expect(await read(minimalPdf(['slow']), { pdfTimeoutMs: 0 })).toEqual({ kind: 'unsupported', reason: 'pdf_time_limit' });
  });

  it('★ 워커 힙 상한(OOM) · RSS 감시(증가 · 절대)에 걸리면 pdf_limit — 프로세스는 멀쩡하다', async () => {
    // 8MB 힙은 해석기를 싣다가 넘친다(ERR_WORKER_OUT_OF_MEMORY). 더 작게(1MB) 주면 V8 이 스레드를 **만들다가** 프로세스째 죽는다 —
    // 상한은 그 아래로 내리지 않는다(기본 128/32).
    expect(await read(minimalPdf(['tiny heap']), { pdfHeapMb: 8, pdfYoungHeapMb: 2 })).toEqual({ kind: 'unsupported', reason: 'pdf_limit' });
    expect(await read(minimalPdf(['no room']), { pdfMaxRssGrowthBytes: 0 })).toEqual({ kind: 'unsupported', reason: 'pdf_limit' });
    // 증가 상한이 넉넉해도 절대 상한(지금 RSS 보다 낮게)이 먼저 걸린다 — 둘 중 낮은 쪽.
    expect(await read(minimalPdf(['ceiling']), { pdfMaxRssGrowthBytes: 4 * 1024 ** 3, pdfMaxRssBytes: 1 })).toEqual({ kind: 'unsupported', reason: 'pdf_limit' });
  });

  it('★ 1024MB 전제의 RSS 값 — 시작 상한 + 증가 < 절대 상한 < 1024MiB', () => {
    const { pdfStartMaxRssBytes, pdfMaxRssGrowthBytes, pdfMaxRssBytes } = ATTACHMENT_CONTENT_LIMITS;
    expect([pdfStartMaxRssBytes, pdfMaxRssGrowthBytes, pdfMaxRssBytes].map((bytes) => bytes / 1024 ** 2)).toEqual([384, 192, 640]);
    expect(pdfStartMaxRssBytes + pdfMaxRssGrowthBytes).toBeLessThan(pdfMaxRssBytes);
    expect(pdfMaxRssBytes).toBeLessThan(1024 * 1024 ** 2);
  });

  it('★ 1쪽을 읽은 뒤 끊기면(폭탄 쪽에서 시간·메모리) 부분 결과 — 1쪽 텍스트 · truncated', async () => {
    // 2쪽은 60KB 가 20MB 로 풀리는 텍스트 폭탄. 글자 상한을 풀어 워커가 끝까지 읽으려 하게 한다 — 시간(1.5초)·힙·RSS 중 먼저 걸리는 것이 끊는다.
    const result = await read(textBombPdf('Cover page before the bomb', 20), { maxTextChars: 1_000_000_000, pdfTimeoutMs: 1_500 });
    expect(result).toMatchObject({ kind: 'pdf_text', pages: 2, pagesRead: 1, truncated: true });
    if (result.kind === 'pdf_text') expect(result.text).toBe('Cover page before the bomb');
  });

  it('★ 폭탄도 기본 상한 안에서 끝난다 — 글자 상한에서 멈춘 부분 결과', async () => {
    const result = await read(textBombPdf('Cover', 20));
    expect(result).toMatchObject({ kind: 'pdf_text', pages: 2, pagesRead: 2, truncated: true });
    if (result.kind === 'pdf_text') expect(result.text.length).toBe(ATTACHMENT_CONTENT_LIMITS.maxTextChars);
  });

  it('★ 끊는 경로들이 처리되지 않은 거부를 남기지 않는다', async () => {
    await read(minimalPdf(['late']), { pdfTimeoutMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(unhandled).toEqual([]);
  });
});

describe('readAttachmentContent — 함대 칸 · 시작 RSS', () => {
  it('★ 칸이 없으면 busy — PDF 를 풀지 않는다', async () => {
    const none = slots(false);
    expect(await readAttachmentContent(minimalPdf(['queued']), pdfContext(none))).toEqual({ kind: 'unsupported', reason: 'busy' });
  });

  it('★ 칸 저장소가 던져도(DB 오류) busy — 500 이 아니다', async () => {
    const broken: PdfParseSlots = { tryAcquire: () => Promise.reject(new Error('connection terminated')) };
    expect(await readAttachmentContent(minimalPdf(['db down']), pdfContext(broken))).toEqual({ kind: 'unsupported', reason: 'busy' });
  });

  it('★ 시작 RSS 가 상한을 넘으면 busy — 칸도 잡지 않는다', async () => {
    const counted = slots();
    expect(await readAttachmentContent(minimalPdf(['warm']), pdfContext(counted), limits({ pdfStartMaxRssBytes: 1 }))).toEqual({
      kind: 'unsupported',
      reason: 'busy',
    });
    expect(counted.acquired).toBe(0);
  });

  it('★ 칸은 결과가 무엇이든 한 번 잡고 한 번 놓는다(성공 · 시간 초과 · 깨진 PDF) · 에이전트 id 로 잡는다 · PDF 가 아니면 잡지 않는다', async () => {
    const counted = slots();
    await readAttachmentContent(minimalPdf(['ok']), pdfContext(counted));
    await readAttachmentContent(minimalPdf(['slow']), pdfContext(counted), limits({ pdfTimeoutMs: 0 }));
    await readAttachmentContent(new TextEncoder().encode('%PDF-1.7\nbroken'), pdfContext(counted));
    expect([counted.acquired, counted.released]).toEqual([3, 3]);
    expect(counted.agents).toEqual([AGENT, AGENT, AGENT]);
    await readAttachmentContent(PNG, pdfContext(counted));
    await readAttachmentContent(new TextEncoder().encode('plain'), pdfContext(counted));
    expect([counted.acquired, counted.released]).toEqual([3, 3]);
  });
});

describe('readAttachmentContent — 실패 기억(같은 저장 키)', () => {
  it.each([
    ['pdf_time_limit', () => minimalPdf(['slow']), { pdfTimeoutMs: 0 }],
    ['pdf_limit', () => minimalPdf(['no room']), { pdfMaxRssGrowthBytes: 0 }],
    ['unreadable_pdf', () => new TextEncoder().encode('%PDF-1.7\nbroken'), {}],
  ] as const)('★ %s 는 기억한다 — 같은 키는 다시 풀지 않고 칸도 잡지 않는다 · 다른 키는 푼다', async (reason, bytes, overrides) => {
    const counted = slots();
    const key = `inbound/attachments/remembered-${reason}`;
    expect(await readAttachmentContent(bytes(), pdfContext(counted, key), limits(overrides))).toEqual({ kind: 'unsupported', reason });
    // 두 번째는 상한을 풀어도 기억한 결과 — 워커도 칸도 없다.
    expect(await readAttachmentContent(bytes(), pdfContext(counted, key))).toEqual({ kind: 'unsupported', reason });
    expect(counted.acquired).toBe(1);
    await readAttachmentContent(bytes(), pdfContext(counted), limits(overrides));
    expect(counted.acquired).toBe(2);
  });

  it('성공 · 암호 PDF · busy 는 기억하지 않는다', async () => {
    const counted = slots();
    const ok = 'inbound/attachments/remembered-ok';
    await readAttachmentContent(minimalPdf(['fine']), pdfContext(counted, ok));
    await readAttachmentContent(minimalPdf(['fine']), pdfContext(counted, ok));
    const locked = 'inbound/attachments/remembered-encrypted';
    await readAttachmentContent(encryptedPdf(), pdfContext(counted, locked));
    await readAttachmentContent(encryptedPdf(), pdfContext(counted, locked));
    expect(counted.acquired).toBe(4);
    const later = 'inbound/attachments/remembered-busy';
    expect(await readAttachmentContent(minimalPdf(['queued']), pdfContext(slots(false), later))).toEqual({ kind: 'unsupported', reason: 'busy' });
    expect(await readAttachmentContent(minimalPdf(['queued now free']), pdfContext(counted, later))).toMatchObject({ kind: 'pdf_text' });
  });
});

describe('사유 문장', () => {

  it('사유마다 사람용 문장이 있다(고정 문장 — 입력 조각 없음)', () => {
    for (const reason of Object.keys(UNSUPPORTED_DETAIL) as (keyof typeof UNSUPPORTED_DETAIL)[]) {
      expect(UNSUPPORTED_DETAIL[reason]).toMatch(/^[A-Z][^가-힣]+\.$/);
    }
    expect(Object.keys(UNSUPPORTED_DETAIL).sort()).toEqual(
      ['busy', 'encrypted_pdf', 'image_too_large', 'pdf_limit', 'pdf_time_limit', 'too_large', 'unreadable_pdf', 'unsupported_type'].sort(),
    );
  });
});
