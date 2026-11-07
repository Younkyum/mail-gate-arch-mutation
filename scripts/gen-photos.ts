/**
 * `pnpm gen:photos` — 홈 사진(`assets/site/photos/*.webp`, 출처 `assets/site/photos/ATTRIBUTION.md`)을 값 파일 하나
 * (`src/site/photo-data.ts`)로 쓴다. 폰트·스크린샷과 같은 방식이다 — base64 를 커밋하는 TS 모듈이라 vitest·tsx 미리보기·esbuild λ 번들이
 * 같은 import 하나로 같은 바이트를 본다(`scripts/gen-fonts.ts` 머리말). 사진 가공(줄이기·색 가라앉히기·WebP)은 ATTRIBUTION.md 의 절차로
 * 한 번 하고 결과 WebP 를 커밋한다 — 이 스크립트는 그 파일을 읽기만 한다(네트워크·Chrome 없음, 같은 입력이면 같은 출력).
 *
 * 파일 이름은 `<사진>-<가로 폭>.webp`. 경로는 `/img/<내용 해시 16자>/<파일>` — 해시가 URL 에 있으므로 1년 immutable(`images.ts`).
 * `--check` 는 쓰지 않고 다르면 실패한다. `test/unit/site/site-photos.test.ts` 가 값 파일과 디스크의 바이트가 같은지 본다.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PHOTO_SRC_DIR = join(REPO_ROOT, 'assets/site/photos');
export const PHOTO_DATA_OUT = join(REPO_ROOT, 'src/site/photo-data.ts');

/** 홈이 쓰는 사진 — 이름 순서가 값 파일의 순서다. */
export const PHOTO_NAMES = ['desk-window', 'window-light', 'post-boxes'] as const;

interface PhotoFile {
  readonly file: string;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

/** WebP 머리에서 가로·세로 — 손실(`VP8 `)·확장(`VP8X`)·무손실(`VP8L`). 그 밖이면 멈춘다. */
export function webpSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new Error('WebP 가 아니다');
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const b = bytes.readUInt32LE(21);
    return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
  }
  throw new Error(`모르는 WebP 청크 ${chunk}`);
}

export function photoHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function readPhotos(): Record<(typeof PHOTO_NAMES)[number], PhotoFile[]> {
  const files = readdirSync(PHOTO_SRC_DIR).filter((f) => f.endsWith('.webp'));
  const out = {} as Record<(typeof PHOTO_NAMES)[number], PhotoFile[]>;
  for (const name of PHOTO_NAMES) {
    const mine = files
      .filter((f) => new RegExp(`^${name}-\\d+\\.webp$`).test(f))
      .map((file) => {
        const bytes = readFileSync(join(PHOTO_SRC_DIR, file));
        const { width, height } = webpSize(bytes);
        if (`${name}-${String(width)}.webp` !== file) throw new Error(`${file} 의 실제 가로 폭은 ${String(width)} 이다`);
        return { file, bytes, width, height };
      })
      .sort((a, b) => a.width - b.width);
    if (mine.length < 2) throw new Error(`${name} 는 폭 두 벌 이상이어야 한다(srcset)`);
    out[name] = mine;
  }
  const known = new Set(Object.values(out).flatMap((l) => l.map((p) => p.file)));
  const stray = files.filter((f) => !known.has(f));
  if (stray.length > 0) throw new Error(`쓰지 않는 사진 파일: ${stray.join(', ')}`);
  return out;
}

export function renderPhotoData(): string {
  const photos = readPhotos();
  const entry = (p: PhotoFile): string =>
    '    {\n' +
    `      path: '/img/${photoHash(p.bytes)}/${p.file}',\n` +
    "      contentType: 'image/webp',\n" +
    `      width: ${String(p.width)},\n` +
    `      height: ${String(p.height)},\n` +
    `      hash: '${photoHash(p.bytes)}',\n` +
    `      bytes: ${String(p.bytes.length)},\n` +
    `      base64: '${p.bytes.toString('base64')}',\n` +
    '    }';
  return (
    '/**\n' +
    ' * 생성 파일 — 손으로 고치지 않는다. `pnpm gen:photos`(`scripts/gen-photos.ts`)가 `assets/site/photos/*.webp` 를 읽어 쓴다.\n' +
    ' * 출처(Unsplash License)는 `assets/site/photos/ATTRIBUTION.md`. import 는 없다(값 파일). 사진마다 폭 두 벌 이상(srcset), 좁은 것부터.\n' +
    ' */\n\n' +
    'export interface SitePhotoFile {\n' +
    '  readonly path: string;\n' +
    '  readonly contentType: string;\n' +
    '  readonly width: number;\n' +
    '  readonly height: number;\n' +
    '  readonly hash: string;\n' +
    '  readonly bytes: number;\n' +
    '  readonly base64: string;\n' +
    '}\n\n' +
    `export type SitePhotoName = ${PHOTO_NAMES.map((n) => `'${n}'`).join(' | ')};\n\n` +
    'export const SITE_PHOTOS: Readonly<Record<SitePhotoName, readonly SitePhotoFile[]>> = {\n' +
    PHOTO_NAMES.map((name) => `  '${name}': [\n${photos[name].map(entry).join(',\n')},\n  ],\n`).join('') +
    '};\n'
  );
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const next = renderPhotoData();
  if (process.argv.includes('--check')) {
    const current = readFileSync(PHOTO_DATA_OUT, 'utf8');
    if (current !== next) {
      console.error('src/site/photo-data.ts 가 assets/site/photos 와 다르다 — pnpm gen:photos');
      process.exit(1);
    }
    console.log('✓ photo-data.ts 최신');
  } else {
    writeFileSync(PHOTO_DATA_OUT, next);
    console.log(`✓ 씀: ${PHOTO_DATA_OUT.slice(REPO_ROOT.length)} (${(Buffer.byteLength(next) / 1024).toFixed(0)} KiB)`);
  }
}
