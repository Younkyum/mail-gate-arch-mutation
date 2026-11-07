/**
 * src/ui/favicon.ts — 콘솔(`console.atmark.ai`)·홈(`atmark.ai`)·문서(`docs.atmark.ai`)가 같은 파비콘을 낸다: 검은 둥근 사각형(#111111) 위
 * 흰 **로고 심볼**(로고 05 "Continuity" — 3/4 고리 둘 + L 괄호, 진윤겸 2026-09-30). 도형은 `src/ui/brand.ts` 한 곳에서 온다 — SVG 는 그 경로를
 * 그대로 싣고, ICO·PNG 는 같은 도형을 **정확한 점-도형 판정**(`inBrandSymbol` — 고리 띠 · 오른쪽 위 사분면 제외 · L 직사각형 둘)으로
 * 4×4 슈퍼샘플해 칠한다. 글꼴·외부 자원이 없다(예전 `@` 선 도형 · 거리 함수는 2026-09-30 에 거뒀다).
 *
 * **해시 URL(2026-09-30, 진윤겸).** 예전 `<link rel="icon" href="/favicon.svg">` 는 고정 URL 에 30일 캐시라 그림을 바꿔도 방문자에게 옛 그림이
 * 남았다. 이제 `<head>` 는 **내용 해시가 든 URL**(`FAVICON_LINK`)을 가리킨다 — 그림이 바뀌면 URL 이 바뀌므로 1년 immutable 로 캐시한다.
 *   - `/favicon-<해시>.svg` — 벡터 한 벌(`<link rel="icon" type="image/svg+xml">`).
 *   - `/favicon-<해시>.ico` — SVG 파비콘을 못 쓰는 브라우저용(`sizes="32x32"`). 32×32 BGRA 비트맵 하나를 ICO 로 감싼다 — 같은 도형을
 *     4×4 슈퍼샘플로 **이 모듈이 직접 래스터화**한다(이미지 도구·의존성 없음, 결정적).
 *   - `/apple-touch-icon-<해시>.png` — iOS 홈 화면 아이콘(180×180 · 불투명 정사각형 — iOS 가 모서리를 깎는다). 같은 래스터화로 PNG 를 만든다
 *     (`node:zlib` deflate + CRC32 — 이것도 의존성 없음, 결정적).
 *   - 옛 고정 경로 `/favicon.svg`·`/favicon.ico`·`/apple-touch-icon.png`(`<link>` 없이 먼저 찾는 요청 — 북마크·RSS·iOS)도 **같은 지금 그림**을
 *     낸다. 이 경로들은 하루 캐시(`FAVICON_LEGACY_CACHE_CONTROL`)다 — 다음에 그림이 바뀌어도 하루면 퍼진다.
 * 해시는 SVG 원문 + 래스터 판(`RASTER_VERSION`)에서 잰다 — 래스터 셋은 SVG 와 같은 상수(색·반경·심볼 자리·경로)에서 나오므로 SVG 가 바뀌면 함께 바뀐다.
 * 래스터 코드만 고치면 `RASTER_VERSION` 을 올린다.
 * 세 핸들러(`src/admin/router.ts` · `src/site/http.ts` · `src/docs/http.ts`)가 `faviconAsset(경로)` 하나만 부른다. 세션·DB·환경을 보지 않는다.
 */

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import { BRAND_SYMBOL_PATHS, BRAND_SYMBOL_VIEWBOX, inBrandSymbol } from './brand';

/**
 * 도형(40×40 좌표) — SVG 와 래스터가 같은 값을 쓴다. 심볼(도형 상자 208)을 한 변 `SYMBOL_SIZE` 로 줄여 `SYMBOL_OFFSET` 에 둔다 —
 * 여백 7.5/40 = 18.75%(32px ICO 에서 6px, 16px 탭에서 3px). 16px 에서도 바깥 고리 띠가 1.5px 로 남는다.
 */
const BG = '#111111';
const INK = '#FFFFFF';
const RADIUS = 9;
const SYMBOL_OFFSET = 7.5;
const SYMBOL_SIZE = 25;
/** 심볼 도형 상자의 원점·한 변(256 격자) — `BRAND_SYMBOL_VIEWBOX`(`24 24 208 208`). */
const [SYMBOL_BOX_X, SYMBOL_BOX_Y, SYMBOL_BOX_SIZE] = BRAND_SYMBOL_VIEWBOX.split(' ').map(Number) as [number, number, number, number];

export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
  `<rect width="40" height="40" rx="${String(RADIUS)}" fill="${BG}"/>` +
  `<svg x="${String(SYMBOL_OFFSET)}" y="${String(SYMBOL_OFFSET)}" width="${String(SYMBOL_SIZE)}" height="${String(SYMBOL_SIZE)}" viewBox="${BRAND_SYMBOL_VIEWBOX}">` +
  `<g fill="${INK}"><path fill-rule="evenodd" d="${BRAND_SYMBOL_PATHS.rings}"/><path d="${BRAND_SYMBOL_PATHS.bracket}"/></g>` +
  '</svg></svg>';

type Pt = readonly [number, number];

/** 40 좌표의 점이 흰 심볼 위인가 — 256 격자로 되돌려 `inBrandSymbol`(고리 띠 · 오른쪽 위 사분면 제외 · L 직사각형 둘)로 정확히 판정한다. */
function onSymbol(p: Pt): boolean {
  const k = SYMBOL_BOX_SIZE / SYMBOL_SIZE;
  return inBrandSymbol(SYMBOL_BOX_X + (p[0] - SYMBOL_OFFSET) * k, SYMBOL_BOX_Y + (p[1] - SYMBOL_OFFSET) * k);
}

function inRoundedRect(p: Pt): boolean {
  const [x, y] = p;
  if (x < 0 || y < 0 || x > 40 || y > 40) return false;
  const cx = Math.min(Math.max(x, RADIUS), 40 - RADIUS);
  const cy = Math.min(Math.max(y, RADIUS), 40 - RADIUS);
  return Math.hypot(x - cx, y - cy) <= RADIUS;
}

const hex = (h: string): readonly [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** 32×32 ICO(BITMAPINFOHEADER + BGRA 아래→위 + AND 마스크 0) — 알파가 모양을 정한다. */
export function renderFaviconIco(size = 32, samples = 4): Buffer {
  const bg = hex(BG);
  const ink = hex(INK);
  const pixels = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      let inside = 0;
      let on = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const p: Pt = [((col + (sx + 0.5) / samples) * 40) / size, ((row + (sy + 0.5) / samples) * 40) / size];
          if (!inRoundedRect(p)) continue;
          inside += 1;
          if (onSymbol(p)) on += 1;
        }
      }
      const alpha = inside / (samples * samples);
      const mix = inside === 0 ? 0 : on / inside;
      const [r, g, b] = [0, 1, 2].map((i) => Math.round((bg[i] ?? 0) * (1 - mix) + (ink[i] ?? 0) * mix));
      const o = ((size - 1 - row) * size + col) * 4; // 비트맵은 아래 줄부터
      pixels[o] = b ?? 0;
      pixels[o + 1] = g ?? 0;
      pixels[o + 2] = r ?? 0;
      pixels[o + 3] = Math.round(alpha * 255);
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // 색 + AND 마스크
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(pixels.length + mask.length, 20);
  const image = Buffer.concat([header, pixels, mask]);
  const dir = Buffer.alloc(6 + 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(1, 4);
  dir.writeUInt8(size >= 256 ? 0 : size, 6);
  dir.writeUInt8(size >= 256 ? 0 : size, 7);
  dir.writeUInt8(0, 8);
  dir.writeUInt8(0, 9);
  dir.writeUInt16LE(1, 10);
  dir.writeUInt16LE(32, 12);
  dir.writeUInt32LE(image.length, 14);
  dir.writeUInt32LE(dir.length, 18);
  return Buffer.concat([dir, image]);
}

let icoBase64: string | null = null;

/** ICO 본문(base64 — 핸들러가 `isBase64Encoded` 로 낸다). 첫 요청 때 한 번 만든다. */
export function faviconIcoBase64(): string {
  if (icoBase64 === null) icoBase64 = renderFaviconIco().toString('base64');
  return icoBase64;
}

// ---------------------------------------------------------------------------
// PNG(apple-touch-icon) — 불투명 정사각형(iOS 가 모서리를 깎는다). 40 격자를 한 변 전체에 펴므로 심볼 여백도 ICO 와 같은 18.75% —
// iOS 의 둥근 모서리(한 변의 ~22% 반경)가 L 괄호의 바깥 모서리(81.25%, 18.75%)에 닿지 않는다.
// ---------------------------------------------------------------------------

const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 180×180 RGB PNG(필터 0 · deflate 9) — 바탕 `BG` 위 흰 심볼. 결정적. */
export function renderAppleTouchPng(size = 180, samples = 4): Buffer {
  const bg = hex(BG);
  const ink = hex(INK);
  const row = 1 + size * 3;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * row] = 0;
    for (let x = 0; x < size; x += 1) {
      let on = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const p: Pt = [((x + (sx + 0.5) / samples) * 40) / size, ((y + (sy + 0.5) / samples) * 40) / size];
          if (onSymbol(p)) on += 1;
        }
      }
      const mix = on / (samples * samples);
      const o = y * row + 1 + x * 3;
      for (let i = 0; i < 3; i += 1) raw[o + i] = Math.round((bg[i] ?? 0) * (1 - mix) + (ink[i] ?? 0) * mix);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // 비트 깊이
  ihdr.writeUInt8(2, 9); // RGB
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

let pngBase64: string | null = null;

/** apple-touch-icon 본문(base64). 첫 요청 때 한 번 만든다. */
export function appleTouchPngBase64(): string {
  if (pngBase64 === null) pngBase64 = renderAppleTouchPng().toString('base64');
  return pngBase64;
}

// ---------------------------------------------------------------------------
// 경로 · 링크 · 조회
// ---------------------------------------------------------------------------

/** 래스터(ICO·PNG) 코드의 판 — 래스터화만 고쳤을 때 올린다(해시가 바뀌게). */
const RASTER_VERSION = '2';

/** 그림의 내용 해시(16진 10자리) — SVG 원문 + 래스터 판. */
export const FAVICON_HASH = createHash('sha256').update(`${FAVICON_SVG}\u0000raster-${RASTER_VERSION}`, 'utf8').digest('hex').slice(0, 10);

export const FAVICON_SVG_PATH = `/favicon-${FAVICON_HASH}.svg`;
export const FAVICON_ICO_PATH = `/favicon-${FAVICON_HASH}.ico`;
export const APPLE_TOUCH_ICON_PATH = `/apple-touch-icon-${FAVICON_HASH}.png`;

/** 옛 고정 경로 셋 — 링크 없이 먼저 찾는 요청용. 지금 그림을 낸다(하루 캐시). */
export const FAVICON_LEGACY_SVG_PATH = '/favicon.svg';
export const FAVICON_LEGACY_ICO_PATH = '/favicon.ico';
export const APPLE_TOUCH_ICON_LEGACY_PATH = '/apple-touch-icon.png';

/** 해시 경로 — 1년 immutable(그림이 바뀌면 URL 이 바뀐다). */
export const FAVICON_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** 옛 고정 경로 — 하루. */
export const FAVICON_LEGACY_CACHE_CONTROL = 'public, max-age=86400';

/**
 * `<head>` 의 아이콘 링크 셋 — ICO(32×32) · SVG · apple-touch-icon. 브라우저는 SVG 를 아는 한 SVG 를 쓰고, 모르면 ICO 로 떨어진다.
 * 세 페이지 묶음(홈·콘솔·문서)이 이 한 문자열을 싣는다(테스트가 페이지마다 정확히 한 번인지 본다).
 */
export const FAVICON_LINK =
  `<link rel="icon" href="${FAVICON_ICO_PATH}" sizes="32x32">` +
  `<link rel="icon" href="${FAVICON_SVG_PATH}" type="image/svg+xml">` +
  `<link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON_PATH}">`;

/** 파비콘 응답 한 벌 — 핸들러가 호스트별 헤더(HSTS·nosniff 등)를 더해 낸다. */
export interface FaviconAsset {
  readonly contentType: string;
  readonly cacheControl: string;
  /** 본문 — `base64` 가 참이면 base64(ICO·PNG), 아니면 글(SVG). */
  readonly body: () => string;
  readonly base64: boolean;
}

const svgAsset = (cacheControl: string): FaviconAsset => ({ contentType: 'image/svg+xml', cacheControl, body: () => FAVICON_SVG, base64: false });
const icoAsset = (cacheControl: string): FaviconAsset => ({ contentType: 'image/x-icon', cacheControl, body: faviconIcoBase64, base64: true });
const pngAsset = (cacheControl: string): FaviconAsset => ({ contentType: 'image/png', cacheControl, body: appleTouchPngBase64, base64: true });

const ASSETS: ReadonlyMap<string, FaviconAsset> = new Map([
  [FAVICON_SVG_PATH, svgAsset(FAVICON_CACHE_CONTROL)],
  [FAVICON_ICO_PATH, icoAsset(FAVICON_CACHE_CONTROL)],
  [APPLE_TOUCH_ICON_PATH, pngAsset(FAVICON_CACHE_CONTROL)],
  [FAVICON_LEGACY_SVG_PATH, svgAsset(FAVICON_LEGACY_CACHE_CONTROL)],
  [FAVICON_LEGACY_ICO_PATH, icoAsset(FAVICON_LEGACY_CACHE_CONTROL)],
  [APPLE_TOUCH_ICON_LEGACY_PATH, pngAsset(FAVICON_LEGACY_CACHE_CONTROL)],
]);

/** 파비콘 경로 여섯(해시 셋 + 옛 셋) — 라우트 표·CDN 캐시 경로가 이 목록을 쓴다. */
export const FAVICON_PATHS: readonly string[] = [...ASSETS.keys()];

/** 경로 → 파비콘(없으면 `undefined`). 정확히 일치만. */
export function faviconAsset(path: string): FaviconAsset | undefined {
  return ASSETS.get(path);
}
