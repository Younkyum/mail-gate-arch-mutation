/**
 * src/api/attachment-content.ts — 수신 첨부 바이트 → **에이전트가 읽을 수 있는 내용**(텍스트 · PDF 텍스트 · 이미지).
 * `GET /v1/messages/inbound/{id}/attachments/{index}/content`(`routes/attachments.ts`)와 MCP `read_attachment` 가 쓴다.
 *
 * ---------------------------------------------------------------------------
 * ## 판단 기록
 * ---------------------------------------------------------------------------
 *
 * **① 종류는 바이트로 정한다 — 선언값·파일명을 보지 않는다.** `declared_content_type`·파일명은 발신자가 쓴 문자열이다.
 *   `invoice.pdf` 라는 이름의 실행 파일, `text/plain` 이라 선언된 ZIP 이 온다. 그래서 선두 바이트(매직)로 가린다. 순서가 있다:
 *   이미지 매직(PNG·JPEG·GIF·WEBP, 0 번째 바이트)을 먼저 보고, 그다음 `%PDF-`. PDF 머리는 앞 1KB 안 어디든 인정한다(판독기들이
 *   머리 앞 쓰레기를 허용한다) — 대신 **0 번째가 아닌 머리**는 "PDF 일 수도 있다" 일 뿐이다: `%PDF-` 를 언급하는 평문(메일 로그·
 *   설명서)도 거기 걸린다. 그래서 그런 파일은 PDF 로 읽어 보고 **읽지 못하면 텍스트 판정으로 넘어간다**. 나머지는 "UTF-8 로 온전히
 *   풀리고 NUL 이 없으며 제어 문자가 드물다" 일 때만 텍스트다. 그 밖은 `unsupported` — 에이전트는 다운로드 URL 라우트로 받는다.
 *
 * **② 파싱은 전부 상한 안에서 — PDF 는 진짜 상한.** 바이트는 외부인이 정했다. 읽기 전에 크기(`maxReadBytes`, 저장소도 다 읽기 전에
 *   거부), 텍스트는 돌려줄 글자 수(`maxTextChars`), 이미지는 원본 크기(`maxImageBytes` — Lambda 응답 6MB 안에 base64 로 들어가는 값)
 *   와 **머리에 적힌 가로·세로**(`maxImageSide`·`maxImagePixels` — 작은 파일이 거대한 캔버스로 풀리는 이미지 폭탄을 받는 쪽 모델·
 *   클라이언트에 넘기지 않는다. 머리를 읽지 못하거나 가로·세로가 0 이면 이미지로 인정하지 않는다). **움직이는 이미지**는 프레임마다
 *   풀리므로 프레임 수(`maxImageFrames`)와 프레임 넓이의 합(`maxImageFramePixels`)도 센다 — GIF 는 블록을 끝까지 걸으며 이미지 서술자
 *   마다, APNG 는 `acTL` 의 프레임 수와 `fcTL` 마다, WEBP 는 `ANMF` 마다. 각 프레임의 가로·세로도 한 변 상한 안이어야 한다. 모든 걷기는
 *   바이트 끝을 넘지 않고, 잘린 파일은 거기까지 본 프레임으로 판정한다(판독기도 거기까지 그린다).
 *   PDF 는 **워커 스레드**(`pdf-text-worker.ts`)에서 푼다 — 같은 스레드의 협조적 시간 경주는 동기 구간을 끊지 못하고 메모리를 막지
 *   못했다(60KB 압축 폭탄 → RSS 362MB, 179KB → 783MB). 부모가 거는 상한은 셋이다:
 *     - **힙:** `resourceLimits`(old `pdfHeapMb` · young `pdfYoungHeapMb`) — 넘으면 V8 이 그 스레드만 죽인다(`ERR_WORKER_OUT_OF_MEMORY`).
 *     - **시간:** `pdfTimeoutMs` 에 `terminate()` — 동기 구간 한가운데서도 끊긴다(협조가 필요 없다).
 *     - **RSS:** 힙 밖(ArrayBuffer — 풀린 스트림 바이트)은 힙 상한이 세지 않는다. 부모가 `PDF_RSS_POLL_MS` 마다 프로세스 RSS 를 보고
 *       **시작 때보다 `pdfMaxRssGrowthBytes` 넘게 늘거나 절대값 `pdfMaxRssBytes` 를 넘으면**(둘 중 낮은 쪽) 끊는다.
 *   **따뜻한 인스턴스의 누적(검증 M1).** 상대 상한만 있으면 폭탄을 연달아 받을 때 기준선이 매번 올라간다(로컬 88 → 268 → 449 →
 *   641MB — 끊긴 워커가 다 내려가기 전에 다음 해석의 기준선을 쟀다). 그래서 셋을 더 건다:
 *     - 시작 RSS 가 이미 `pdfStartMaxRssBytes` 를 넘으면 **해석을 시작하지 않는다**(`busy` — 칸도 잡지 않는다).
 *     - 위의 절대 상한 — 기준선이 높아도 넘지 못하는 천장.
 *     - 결과는 워커의 `'exit'` 뒤에 낸다(`PDF_EXIT_WAIT_MS` 상한) — 다음 요청의 기준선이 끊긴 워커를 세지 않게.
 *   값은 API 함수 **1024MB** 를 전제로 한다(`infra/cdk/stacks/compute-stack.ts`): 평소 RSS 는 100~150MB 다. 시작 상한 384MiB 는
 *   평소의 두 배를 넘는 "앞선 해석이 아직 안 내려간" 상태를 거른다. 천장 640MiB 는 1024MB 까지 384MiB 를 남긴다 — 감시 간격(10ms)
 *   사이의 증가 · 워커가 끊겨 내려가는 동안 · 응답 JSON(텍스트 10만 자)을 만들 몫이다. 증가 상한 192MiB 는 이미지가 든 정상 PDF 의
 *   텍스트 추출에 넉넉하다(텍스트 추출은 이미지를 풀지 않는다). 시작 상한(384) + 증가(192) < 천장(640) 이라 평소에는 증가 상한이, 기준선이
 *   높을 때만 천장이 먼저 걸린다.
 *   **실패 기억:** 끊긴 해석(`pdf_limit`·`pdf_time_limit`)과 `unreadable_pdf` 는 저장 키마다 인스턴스 안에서 `PDF_FAILURE_TTL_MS` 동안
 *   기억한다(최대 `PDF_FAILURE_CACHE_SIZE` 개, 오래된 것부터 버린다) — 같은 폭탄을 되풀이 불러도 따뜻한 인스턴스는 다시 풀지 않는다.
 *   잘못 기억한 대가(기준선이 높아 걸린 정상 PDF)는 그 인스턴스에서 몇 분 동안 "다운로드 링크를 쓰라" 뿐이다.
 *   **워커 환경 변수는 비운다(`env: {}`).** 워커의 `process.env` 는 기본으로 부모의 사본이다 — λ 의 임시 AWS 자격 증명이 든다.
 *   해석기(pdfjs-dist)는 환경 변수를 읽지 않는다.
 *   워커 안에서는 쪽 수(`maxPdfPages`)와 글자 수에서 멈춘다(스트림 reader 를 취소 — 폭탄의 나머지는 풀리지도 않는다). 워커가 어떻게
 *   끝나든(오류·메모리·시간·비정상 종료) 결과는 정상 값이다: 읽은 쪽이 있으면 부분 결과(`truncated`), 없으면 `unsupported`. 약속은
 *   `extractPdfText` 의 하나뿐이고 한 번만 결정된다 — 버려지는 약속이 없다.
 *   **함대 전체 상한:** PDF 해석 동안 API 함수 한 칸이 묶인다. 동시 PDF 해석은 모든 인스턴스를 합쳐 `PDF_PARSE_SLOT_COUNT`(2),
 *   조직마다 하나 — `db/repositories/pdf-parse-slots.ts`. 칸이 없거나 칸을 잡다 DB 가 실패하면 기다리지 않고 `busy`(잠시 뒤 다시).
 *   PDF 최대 바이트는 따로 낮추지 않았다(`maxReadBytes` 그대로): 입력 크기가 아니라 위 셋이 상한이고, 이미지가 든 정상 PDF 는 수 MB 다
 *   (텍스트 추출은 이미지를 풀지 않는다).
 *
 * **③ PDF 해석기는 아무것도 실행하지 않고 바깥에 닿지 않는다.** `pdf-text-worker.ts` ③ — CMap 은 번들 안의 한국어 표만. 그 밖의
 *   글꼴 중 글리프에 유니코드 대응이 없는 것은 텍스트가 비거나 깨진다 — `no_text_layer` 로 알린다.
 *
 * **④ 오류 문장을 싣지 않는다.** 해석기의 예외 메시지는 입력에서 온 조각을 담을 수 있다. 결과는 우리가 정한 `reason` 코드와
 *   고정 문장뿐이다(워커도 사유 코드만 보낸다). 로그에는 종류·사유 코드만 남는다(`routes/attachments.ts`).
 *
 * **⑤ 돌려주는 텍스트에서 제어·보이지 않는 서식 문자를 지운다.** 탭·LF·CR 밖의 C0, DEL, C1, 그리고 방향 제어(U+202A–202E ·
 *   U+2066–2069)·폭 없는 문자와 방향 표지(U+200B–200F)·U+FEFF(본문 안의 BOM) — 사람 눈에 보이는 글과 기계가 읽는 글을 갈라 놓는
 *   재료다(트로이 소스식 재배열 · 스캐너를 피하는 쪼갠 낱말). 줄 구분자(U+2028·U+2029)는 지우지 않고 LF 로 바꾼다(줄이 붙지 않게).
 *   MCP 렌더러(`mcp/render.ts` ③)가 블록에 넣을 때 하는 일(Cc·Cf 제거 · 줄 구분자 → 개행)의 부분집합이라, REST 와 MCP 가 같은 글자를
 *   받는다. 텍스트 판정(1% 문턱)은 지우기 **전** 원문으로 한다. `chars`(평문)는 지운 뒤의 전체 길이다.
 */

import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

import type { PdfParseSlots } from '../db/repositories/pdf-parse-slots';
import { log } from '../observability/logger';
import type { PdfWorkerInput, PdfWorkerMessage } from './pdf-text-worker';

export interface AttachmentContentLimits {
  /** 저장소에서 읽을 최대 바이트. 넘으면 읽지 않는다. */
  readonly maxReadBytes: number;
  /** 돌려줄 텍스트(평문·PDF)의 최대 글자 수(UTF-16 단위). */
  readonly maxTextChars: number;
  readonly maxPdfPages: number;
  /** PDF 워커의 벽시계 상한 — 넘으면 `terminate()`. */
  readonly pdfTimeoutMs: number;
  /** PDF 워커 old generation 힙 상한(MB). 8 아래로 내리지 않는다 — 1MB 쯤이면 V8 이 워커를 **만들다가** 프로세스째 죽는다(넘침이 아니라 생성 실패). */
  readonly pdfHeapMb: number;
  /** PDF 워커 young generation 힙 상한(MB). */
  readonly pdfYoungHeapMb: number;
  /** PDF 해석 중 프로세스 RSS 증가 상한(바이트) — 힙 밖 버퍼까지 센다. */
  readonly pdfMaxRssGrowthBytes: number;
  /** PDF 해석 중 프로세스 RSS 절대 상한(바이트) — 증가 상한과 둘 중 낮은 쪽에서 끊는다. */
  readonly pdfMaxRssBytes: number;
  /** 해석을 시작할 때 프로세스 RSS 가 이보다 크면 시작하지 않는다(`busy`). */
  readonly pdfStartMaxRssBytes: number;
  /** 이미지 원본 최대 바이트 — base64 로 부풀어도 응답 상한 안. */
  readonly maxImageBytes: number;
  /** 이미지 머리에 적힌 가로·세로 각각의 상한(픽셀). */
  readonly maxImageSide: number;
  /** 가로 × 세로 상한(픽셀). */
  readonly maxImagePixels: number;
  /** 움직이는 이미지(GIF · APNG · WEBP)의 프레임 수 상한. */
  readonly maxImageFrames: number;
  /** 프레임마다의 가로 × 세로를 모두 더한 상한(픽셀) — 판독기가 풀어야 하는 총량. */
  readonly maxImageFramePixels: number;
}

const MIB = 1024 * 1024;

export const ATTACHMENT_CONTENT_LIMITS: AttachmentContentLimits = {
  maxReadBytes: 10 * MIB,
  maxTextChars: 100_000,
  maxPdfPages: 20,
  pdfTimeoutMs: 5_000,
  pdfHeapMb: 128,
  pdfYoungHeapMb: 32,
  // 세 RSS 값의 근거는 머리말 ② — API 함수 1024MB 전제.
  pdfMaxRssGrowthBytes: 192 * MIB,
  pdfMaxRssBytes: 640 * MIB,
  pdfStartMaxRssBytes: 384 * MIB,
  maxImageBytes: 3 * MIB,
  maxImageSide: 8_000,
  maxImagePixels: 40_000_000,
  maxImageFrames: 100,
  // 한 장 상한의 네 배 — 1000×1000 백 장(100MP)은 들어오고, 한 장 상한 크기의 프레임을 백 장 쌓는 폭탄은 막는다.
  maxImageFramePixels: 160_000_000,
};

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export type SniffedKind =
  | { readonly kind: 'pdf'; readonly headerAtStart: boolean }
  | { readonly kind: 'image'; readonly mimeType: ImageMimeType }
  | { readonly kind: 'other' };

export type UnsupportedReason =
  | 'too_large'
  | 'image_too_large'
  | 'unsupported_type'
  | 'encrypted_pdf'
  | 'unreadable_pdf'
  | 'pdf_time_limit'
  | 'pdf_limit'
  | 'busy';

/**
 * 결과. 글자 수의 뜻이 종류마다 다르다:
 *   - `text.chars` = 파일 전체의 글자 수(제어 문자를 지운 뒤, 자르기 전). `truncated` 면 `text` 는 그 앞부분이다.
 *   - `pdf_text` 에는 전체 글자 수가 **없다** — 글자 상한에 닿으면 추출을 멈추므로(②) 문서 전체 길이를 모른다. `truncated` 가 "더 있다".
 */
export type AttachmentContent =
  | { readonly kind: 'text'; readonly text: string; readonly chars: number; readonly truncated: boolean }
  | {
      readonly kind: 'pdf_text';
      readonly text: string;
      readonly truncated: boolean;
      readonly pages: number;
      readonly pagesRead: number;
      readonly noTextLayer: boolean;
    }
  | { readonly kind: 'image'; readonly mimeType: ImageMimeType; readonly dataBase64: string }
  | { readonly kind: 'unsupported'; readonly reason: UnsupportedReason };

/** 사람용 문장 — 고정 문장뿐(④). 에이전트·사용자 문서로 복제되므로 내부 사정을 말하지 않는다. */
export const UNSUPPORTED_DETAIL: Readonly<Record<UnsupportedReason, string>> = {
  too_large: 'The attachment is too large to read here. Use the download link instead.',
  image_too_large: 'The image is too large to return here. Use the download link instead.',
  unsupported_type: 'Only text, PDF and image (PNG, JPEG, GIF, WEBP) attachments can be read here. Use the download link instead.',
  encrypted_pdf: 'The PDF is password protected, so its text cannot be read.',
  unreadable_pdf: 'The PDF could not be read. It may be damaged. Use the download link instead.',
  pdf_time_limit: 'Reading the PDF took too long. Use the download link instead.',
  pdf_limit: 'The PDF is too complex to read here. Use the download link instead.',
  busy: 'PDF reading is busy right now. Try again in a few seconds.',
};

// ---------------------------------------------------------------------------
// 종류 판별 (①)
// ---------------------------------------------------------------------------

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (bytes.length < at + signature.length) return false;
  return signature.every((value, offset) => bytes[at + offset] === value);
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
/** PDF 머리가 이 안에 있으면 PDF 일 수 있다 — 판독기들은 머리 앞의 쓰레기 1KB 를 허용한다(해석기도 그렇게 찾는다). */
const PDF_HEADER_WINDOW = 1024;

function pdfHeaderOffset(bytes: Uint8Array): number | null {
  const end = Math.min(bytes.length, PDF_HEADER_WINDOW) - PDF_MAGIC.length;
  for (let at = 0; at <= end; at += 1) {
    if (startsWith(bytes, PDF_MAGIC, at)) return at;
  }
  return null;
}

function sniffImage(bytes: Uint8Array): ImageMimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

export function sniffAttachment(bytes: Uint8Array): SniffedKind {
  const image = sniffImage(bytes);
  if (image !== null) return { kind: 'image', mimeType: image };
  const pdfAt = pdfHeaderOffset(bytes);
  if (pdfAt !== null) return { kind: 'pdf', headerAtStart: pdfAt === 0 };
  return { kind: 'other' };
}

// ---------------------------------------------------------------------------
// 이미지 크기 (②) — 머리만 읽는다(픽셀을 풀지 않는다)
// ---------------------------------------------------------------------------

/** 머리에서 읽은 크기. 움직이는 이미지는 프레임이 캔버스 밖으로 나가면 캔버스를 그만큼 넓혀 센다(판독기에 따라 넓힌다). */
export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
  /** 프레임 수 — 움직이지 않는 이미지는 1. */
  readonly frames: number;
  /** 프레임마다의 가로 × 세로의 합(움직이지 않는 이미지는 가로 × 세로). */
  readonly framePixels: number;
}

const u16be = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number): number => (((b[at] ?? 0) << 24) >>> 0) + (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0));
const u32le = (b: Uint8Array, at: number): number => u24le(b, at) + (b[at + 3] ?? 0) * 0x1000000;
const fourcc = (b: Uint8Array, at: number): string => String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);

/** 한 장짜리 — 가로·세로가 0 이면 이미지가 아니다. */
function still(width: number, height: number): ImageDimensions | null {
  if (width === 0 || height === 0) return null;
  return { width, height, frames: 1, framePixels: width * height };
}

/** JPEG 의 프레임 머리(SOFn) 표지 — C4(DHT)·C8(JPG)·CC(DAC)는 SOF 가 아니다. */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(b: Uint8Array): ImageDimensions | null {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1; // 채움 바이트
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2; // 길이 없는 표지
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // 끝·스캔 시작 전에 SOF 가 없었다
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    if (JPEG_SOF.has(marker)) {
      if (at + 9 > b.length) return null;
      return still(u16be(b, at + 7), u16be(b, at + 5));
    }
    at += 2 + length;
  }
  return null;
}

/** 색표(GIF 전역·지역) 바이트 수 — 묶음 바이트의 최상위 비트가 있을 때만. */
const gifColorTable = (packed: number): number => ((packed & 0x80) === 0 ? 0 : 3 * (1 << ((packed & 0x07) + 1)));

/** GIF 하위 블록 열(크기 바이트 + 자료, 크기 0 에서 끝)을 건너뛴 자리. */
function skipGifSubBlocks(b: Uint8Array, from: number): number {
  let at = from;
  while (at < b.length) {
    const size = b[at] ?? 0;
    at += 1 + size;
    if (size === 0) break;
  }
  return at;
}

/** GIF — 논리 화면(LSD) 뒤 블록을 끝(0x3B)까지 걷는다. 이미지 서술자(0x2C)마다 한 프레임. 모르는 블록이면 깨진 파일. */
function gifDimensions(b: Uint8Array): ImageDimensions | null {
  if (b.length < 13) return null; // 헤더(6) + LSD(7)
  const screen = still(u16le(b, 6), u16le(b, 8));
  if (screen === null) return null;
  let { width, height } = screen;
  let frames = 0;
  let framePixels = 0;
  let at = 13 + gifColorTable(b[10] ?? 0);
  while (at < b.length) {
    const block = b[at];
    if (block === 0x3b) break; // 끝
    if (block === 0x21) {
      at = skipGifSubBlocks(b, at + 2); // 확장: 도입(1) · 이름표(1) · 하위 블록
    } else if (block === 0x2c) {
      if (at + 10 > b.length) break; // 잘린 서술자 — 판독기도 여기서 멈춘다
      const frameWidth = u16le(b, at + 5);
      const frameHeight = u16le(b, at + 7);
      frames += 1;
      framePixels += frameWidth * frameHeight;
      width = Math.max(width, u16le(b, at + 1) + frameWidth);
      height = Math.max(height, u16le(b, at + 3) + frameHeight);
      at = skipGifSubBlocks(b, at + 10 + gifColorTable(b[at + 9] ?? 0) + 1); // 서술자(10) · 지역 색표 · LZW 최소 코드 크기(1)
    } else {
      return null;
    }
  }
  return { width, height, frames: Math.max(frames, 1), framePixels: Math.max(framePixels, width * height) };
}

/** PNG — 서명(8) 다음 첫 청크가 IHDR. 청크를 IEND 까지 걸으며 APNG 의 `acTL`(선언한 프레임 수)과 `fcTL`(프레임마다)을 센다. */
function pngDimensions(b: Uint8Array): ImageDimensions | null {
  if (b.length < 24 || !startsWith(b, [0x49, 0x48, 0x44, 0x52], 12)) return null;
  const canvas = still(u32be(b, 16), u32be(b, 20));
  if (canvas === null) return null;
  let { width, height } = canvas;
  let declared = 0;
  let controls = 0;
  let controlPixels = 0;
  for (let at = 8; at + 8 <= b.length; ) {
    const data = at + 8;
    const type = fourcc(b, at + 4);
    if (type === 'IEND') break;
    if (type === 'acTL' && data + 4 <= b.length) declared = u32be(b, data);
    if (type === 'fcTL' && data + 20 <= b.length) {
      // 순번(4) · 가로(4) · 세로(4) · x(4) · y(4) …
      const frameWidth = u32be(b, data + 4);
      const frameHeight = u32be(b, data + 8);
      controls += 1;
      controlPixels += frameWidth * frameHeight;
      width = Math.max(width, u32be(b, data + 12) + frameWidth);
      height = Math.max(height, u32be(b, data + 16) + frameHeight);
    }
    at = data + u32be(b, at) + 4; // 자료 · CRC(4)
  }
  return { width, height, frames: Math.max(1, declared, controls), framePixels: Math.max(canvas.framePixels, controlPixels) };
}

/** WEBP — 단순형(VP8 · VP8L)은 한 장. 확장형(VP8X)은 RIFF 청크를 걸으며 `ANMF`(프레임마다)를 센다. */
function webpDimensions(b: Uint8Array): ImageDimensions | null {
  const chunk = fourcc(b, 12);
  if (chunk === 'VP8 ' && b.length >= 30 && startsWith(b, [0x9d, 0x01, 0x2a], 23)) {
    return still(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
    return still((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk !== 'VP8X' || b.length < 30) return null;
  const canvas = still(u24le(b, 24) + 1, u24le(b, 27) + 1);
  if (canvas === null) return null;
  let { width, height } = canvas;
  let frames = 0;
  let framePixels = 0;
  for (let at = 12; at + 8 <= b.length; ) {
    const size = u32le(b, at + 4);
    const data = at + 8;
    if (fourcc(b, at) === 'ANMF' && data + 12 <= b.length) {
      // x/2(3) · y/2(3) · 가로-1(3) · 세로-1(3) · 길이(3) · 표지(1) · 프레임 자료
      const frameWidth = u24le(b, data + 6) + 1;
      const frameHeight = u24le(b, data + 9) + 1;
      frames += 1;
      framePixels += frameWidth * frameHeight;
      width = Math.max(width, u24le(b, data) * 2 + frameWidth);
      height = Math.max(height, u24le(b, data + 3) * 2 + frameHeight);
    }
    at = data + size + (size % 2); // 홀수 길이는 한 바이트 채움
  }
  return { width, height, frames: Math.max(frames, 1), framePixels: Math.max(canvas.framePixels, framePixels) };
}

/** 머리(와 프레임 서술)에 적힌 크기. 읽을 수 없으면(잘린·깨진 머리 · 가로나 세로 0) `null`. 픽셀은 풀지 않는다. */
export function imageDimensions(bytes: Uint8Array, mimeType: ImageMimeType): ImageDimensions | null {
  switch (mimeType) {
    case 'image/png':
      return pngDimensions(bytes);
    case 'image/gif':
      return gifDimensions(bytes);
    case 'image/jpeg':
      return jpegDimensions(bytes);
    case 'image/webp':
      return webpDimensions(bytes);
  }
}

// ---------------------------------------------------------------------------
// 텍스트 (①·⑤)
// ---------------------------------------------------------------------------

/** 텍스트로 칠 수 있는 제어 문자의 비율 상한 — 탭·개행·CR·폼피드·ESC 밖의 C0 가 이보다 많으면 바이너리로 본다. */
const MAX_CONTROL_RATIO = 0.01;

/** UTF-8 텍스트면 풀린 문자열(BOM 제거), 아니면 `null`. NUL 이 하나라도 있으면 텍스트가 아니다. */
export function decodeTextAttachment(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  let controls = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c && code !== 0x1b) controls += 1;
  }
  if (controls > text.length * MAX_CONTROL_RATIO) return null;
  return text;
}

/** 탭·LF·CR 밖의 C0 · DEL · C1 · 폭 없는 문자와 방향 표지(U+200B–200F) · 방향 제어(U+202A–202E · U+2066–2069) · U+FEFF (⑤). */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
/** 줄 구분자 · 문단 구분자 — 지우지 않고 LF 로(⑤, MCP 렌더러와 같게). */
const LINE_SEPARATORS = /[\u2028\u2029]/g;

export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, '').replace(LINE_SEPARATORS, '\n');
}

/** 앞 `max` 글자 — 서로게이트 쌍을 가르지 않는다. */
export function capText(text: string, max: number): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = Math.max(0, max);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

// ---------------------------------------------------------------------------
// PDF (②·③) — 워커 스레드
// ---------------------------------------------------------------------------

/**
 * 워커 파일 — 이 모듈 옆. λ 번들에서는 `index.js` 옆의 `pdf-text-worker.js`(`scripts/build-lambda.ts` 가 따로 묶는다), 원본 실행(테스트)
 * 에서는 `src/api/pdf-text-worker.ts`(Node 가 타입을 지우고 바로 돈다). `import.meta.url` 은 번들에서는 `index.js`, 원본에서는 이 파일이다.
 */
export const PDF_WORKER_FILES = ['pdf-text-worker.js', 'pdf-text-worker.ts'] as const;

/** 찾은 워커 파일(인스턴스마다 한 번 찾는다). `undefined` = 아직 찾지 않음, `null` = 없음. */
let workerUrl: URL | null | undefined;

function pdfWorkerUrl(): URL | null {
  if (workerUrl !== undefined) return workerUrl;
  workerUrl = null;
  for (const file of PDF_WORKER_FILES) {
    const url = new URL(`./${file}`, import.meta.url);
    if (existsSync(url)) {
      workerUrl = url;
      break;
    }
  }
  // 없으면 PDF 가 전부 `pdf_limit` 이 된다 — 배포 사고다. 인스턴스(콜드 스타트)마다 한 번만 남긴다(다시 찾지 않으므로).
  if (workerUrl === null) log('error', 'api.pdf_worker_missing', { route_id: 'inbound_attachment_content', reason: 'pdf_worker_missing' });
  return workerUrl;
}

/** 부모가 RSS 를 보는 간격(②). */
const PDF_RSS_POLL_MS = 10;
/** 결정 뒤 워커의 `'exit'` 를 기다리는 상한(②) — 넘으면 기다리지 않고 결과를 낸다. */
const PDF_EXIT_WAIT_MS = 500;

/** 뽑은 글자가 이보다 적으면(공백 제외) 텍스트 층이 없다고 본다 — 스캔한 PDF. */
const MIN_TEXT_LAYER_CHARS = 16;

/** 워커가 끝난 모양 — 정상(`end`), 사유 있는 실패(`fail`), 부모가 끊음(시간·메모리·비정상 종료). */
type PdfEnd =
  | { readonly how: 'end'; readonly stoppedAtCharLimit: boolean }
  | { readonly how: 'fail'; readonly reason: 'encrypted_pdf' | 'unreadable_pdf' }
  | { readonly how: 'aborted'; readonly reason: 'pdf_time_limit' | 'pdf_limit' };

function pdfResult(pages: number | null, pageTexts: readonly string[], end: PdfEnd, limits: AttachmentContentLimits): AttachmentContent {
  if (pages === null || pageTexts.length === 0) {
    if (end.how === 'end' && pages !== null) {
      // 쪽이 0 이거나 하나도 읽지 않고 끝났다 — 빈 결과(텍스트 층 없음).
      return { kind: 'pdf_text', text: '', truncated: false, pages, pagesRead: 0, noTextLayer: true };
    }
    if (end.how === 'end') return { kind: 'unsupported', reason: 'unreadable_pdf' };
    return { kind: 'unsupported', reason: end.reason };
  }
  const joined = stripControlChars(pageTexts.join('\n\n'));
  const capped = capText(joined, limits.maxTextChars);
  const stoppedEarly = end.how !== 'end' || end.stoppedAtCharLimit;
  return {
    kind: 'pdf_text',
    text: capped.text,
    truncated: capped.truncated || stoppedEarly || pageTexts.length < pages,
    pages,
    pagesRead: pageTexts.length,
    noTextLayer: joined.replace(/\s/g, '').length < MIN_TEXT_LAYER_CHARS,
  };
}

/**
 * PDF 텍스트 — 워커 하나를 띄워 기다린다. **던지지 않고 한 번만 결정된다**: 워커 메시지·오류·종료·시간·RSS 중 먼저 온 것이 결과를
 * 정하고, 나머지는 `settled` 에 막혀 아무것도 하지 않는다. 워커는 결정 즉시 `terminate()` 하고, 약속은 워커의 `'exit'` 뒤에
 * (`PDF_EXIT_WAIT_MS` 상한) 풀린다 — 다음 해석의 RSS 기준선이 이 워커를 세지 않게(②). `terminate()` 의 거부도 삼킨다.
 */
export function extractPdfText(bytes: Uint8Array, limits: AttachmentContentLimits): Promise<AttachmentContent> {
  return new Promise<AttachmentContent>((resolve) => {
    const url = pdfWorkerUrl();
    if (url === null) {
      resolve({ kind: 'unsupported', reason: 'pdf_limit' });
      return;
    }
    const data = new Uint8Array(bytes); // 떼어 보낼 제 버퍼(호출자의 바이트는 그대로 둔다)
    const input: PdfWorkerInput = { bytes: data, maxPages: limits.maxPdfPages, maxChars: limits.maxTextChars };
    // 증가 상한과 절대 상한 중 낮은 쪽(②).
    const rssCeiling = Math.min(process.memoryUsage.rss() + limits.pdfMaxRssGrowthBytes, limits.pdfMaxRssBytes);
    let worker: Worker;
    try {
      worker = new Worker(url, {
        workerData: input,
        transferList: [data.buffer],
        resourceLimits: { maxOldGenerationSizeMb: limits.pdfHeapMb, maxYoungGenerationSizeMb: limits.pdfYoungHeapMb },
        env: {}, // 부모의 환경 변수(λ 자격 증명)를 물려주지 않는다(②)
      });
    } catch {
      resolve({ kind: 'unsupported', reason: 'pdf_limit' });
      return;
    }

    let pages: number | null = null;
    const pageTexts: string[] = [];
    let settled = false;
    let exited = false;
    /** 결정이 난 뒤 `'exit'` 를 기다리는 중이면 결과를 내는 함수. */
    let onExit: (() => void) | null = null;
    const finish = (end: PdfEnd): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      const result = pdfResult(pages, pageTexts, end, limits);
      if (exited) {
        resolve(result);
        return;
      }
      const cap = setTimeout(() => {
        onExit = null;
        resolve(result);
      }, PDF_EXIT_WAIT_MS);
      onExit = () => {
        clearTimeout(cap);
        resolve(result);
      };
      worker.terminate().catch(() => undefined);
    };

    worker.on('message', (message: PdfWorkerMessage) => {
      switch (message.type) {
        case 'open':
          pages = message.pages;
          break;
        case 'page':
          pageTexts.push(message.text);
          break;
        case 'end':
          finish({ how: 'end', stoppedAtCharLimit: message.stoppedAtCharLimit });
          break;
        case 'fail':
          finish({ how: 'fail', reason: message.reason });
          break;
      }
    });
    // 힙 상한(`ERR_WORKER_OUT_OF_MEMORY`) · 잡히지 않은 예외 · 우리가 끊은 뒤의 종료 — 모두 여기로 온다. 리스너는 떼지 않는다
    // (결정 뒤의 'error' 도 받아서 버려야 프로세스가 죽지 않는다).
    worker.on('error', () => finish({ how: 'aborted', reason: 'pdf_limit' }));
    worker.on('exit', () => {
      exited = true;
      finish({ how: 'aborted', reason: 'pdf_limit' }); // 결정 전의 종료면 이것이 결정이다(곧바로 풀린다)
      const done = onExit;
      onExit = null;
      done?.();
    });
    const timer = setTimeout(() => finish({ how: 'aborted', reason: 'pdf_time_limit' }), limits.pdfTimeoutMs);
    const watch = setInterval(() => {
      if (process.memoryUsage.rss() > rssCeiling) finish({ how: 'aborted', reason: 'pdf_limit' });
    }, PDF_RSS_POLL_MS);
  });
}

// ---------------------------------------------------------------------------
// 입구
// ---------------------------------------------------------------------------

function textContent(text: string, limits: AttachmentContentLimits): AttachmentContent {
  const clean = stripControlChars(text);
  const capped = capText(clean, limits.maxTextChars);
  return { kind: 'text', text: capped.text, chars: clean.length, truncated: capped.truncated };
}

/** PDF 해석에 필요한 것 — 칸(②), 칸을 가를 에이전트(조직은 칸 저장소가 찾는다), 실패 기억의 키(첨부 저장 키). */
export interface PdfParseContext {
  readonly slots: PdfParseSlots;
  readonly agentId: string;
  readonly cacheKey: string;
}

/** 실패 기억(②) — 저장 키 → (결과, 기억한 시각). `Map` 의 넣은 순서가 곧 오래된 순서다. */
const PDF_FAILURE_TTL_MS = 5 * 60_000;
const PDF_FAILURE_CACHE_SIZE = 128;
const pdfFailures = new Map<string, { readonly content: AttachmentContent; readonly at: number }>();

function rememberedPdfFailure(key: string, now: number): AttachmentContent | null {
  const hit = pdfFailures.get(key);
  if (hit === undefined) return null;
  if (now - hit.at > PDF_FAILURE_TTL_MS) {
    pdfFailures.delete(key);
    return null;
  }
  return hit.content;
}

function rememberPdfFailure(key: string, content: AttachmentContent, now: number): void {
  if (content.kind !== 'unsupported') return;
  if (content.reason !== 'pdf_limit' && content.reason !== 'pdf_time_limit' && content.reason !== 'unreadable_pdf') return;
  pdfFailures.delete(key);
  pdfFailures.set(key, { content, at: now });
  for (const oldest of pdfFailures.keys()) {
    if (pdfFailures.size <= PDF_FAILURE_CACHE_SIZE) break;
    pdfFailures.delete(oldest);
  }
}

/**
 * 기억한 실패 → 시작 RSS → 칸(②) 순서로 보고 PDF 를 푼다. 시작 RSS 가 높거나 칸이 없거나 칸 저장소가 던지면 `busy`. 칸은 무슨 일이
 * 있어도 놓는다.
 */
async function pdfContent(bytes: Uint8Array, pdf: PdfParseContext, limits: AttachmentContentLimits): Promise<AttachmentContent> {
  const remembered = rememberedPdfFailure(pdf.cacheKey, Date.now());
  if (remembered !== null) return remembered;
  if (process.memoryUsage.rss() > limits.pdfStartMaxRssBytes) return { kind: 'unsupported', reason: 'busy' };
  let slot: Awaited<ReturnType<PdfParseSlots['tryAcquire']>>;
  try {
    slot = await pdf.slots.tryAcquire(pdf.agentId);
  } catch {
    slot = null; // 칸 저장소는 던지지 않기로 했다 — 그래도 500 이 아니라 busy 다.
  }
  if (slot === null) return { kind: 'unsupported', reason: 'busy' };
  let content: AttachmentContent;
  try {
    content = await extractPdfText(bytes, limits);
  } finally {
    await slot.release();
  }
  rememberPdfFailure(pdf.cacheKey, content, Date.now());
  return content;
}

/** 읽은 바이트 → 내용. 크기 상한(읽기 전 거부)은 호출자가 `maxReadBytes` 로 이미 걸었다. */
export async function readAttachmentContent(
  bytes: Uint8Array,
  pdfContext: PdfParseContext,
  limits: AttachmentContentLimits = ATTACHMENT_CONTENT_LIMITS,
): Promise<AttachmentContent> {
  if (bytes.length > limits.maxReadBytes) return { kind: 'unsupported', reason: 'too_large' };
  const sniffed = sniffAttachment(bytes);
  if (sniffed.kind === 'image') {
    if (bytes.length > limits.maxImageBytes) return { kind: 'unsupported', reason: 'image_too_large' };
    const size = imageDimensions(bytes, sniffed.mimeType);
    if (size === null) return { kind: 'unsupported', reason: 'unsupported_type' };
    if (
      size.width > limits.maxImageSide ||
      size.height > limits.maxImageSide ||
      size.width * size.height > limits.maxImagePixels ||
      size.frames > limits.maxImageFrames ||
      size.framePixels > limits.maxImageFramePixels
    ) {
      return { kind: 'unsupported', reason: 'image_too_large' };
    }
    return { kind: 'image', mimeType: sniffed.mimeType, dataBase64: Buffer.from(bytes).toString('base64') };
  }
  if (sniffed.kind === 'pdf') {
    const pdf = await pdfContent(bytes, pdfContext, limits);
    // 머리가 0 번째가 아니면 "PDF 일 수도" 였다(①) — 읽지 못했으면(칸이 없었어도) 텍스트 판정으로 넘어간다.
    const fallBack = !sniffed.headerAtStart && pdf.kind === 'unsupported' && (pdf.reason === 'unreadable_pdf' || pdf.reason === 'busy');
    if (!fallBack) return pdf;
    const text = decodeTextAttachment(bytes);
    return text === null ? pdf : textContent(text, limits);
  }
  const text = decodeTextAttachment(bytes);
  if (text === null) return { kind: 'unsupported', reason: 'unsupported_type' };
  return textContent(text, limits);
}
