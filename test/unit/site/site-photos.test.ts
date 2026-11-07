/**
 * 홈 사진(홈 개편 2026-09-29 — 진윤겸 승인) — 값 파일(`src/site/photo-data.ts`)이 커밋된 WebP(`assets/site/photos/`)와 **바이트 단위로 같고**
 * (`pnpm gen:photos` 를 잊으면 빨개진다), 파일마다 출처가 적혀 있고(Unsplash License · 사진 페이지 · 작가), 메타데이터(EXIF·XMP·ICC)가 없고,
 * 크기가 예산 안인지 본다. 경로·캐시·응답은 `site-seo.test.ts`, 마크업(`srcset`·alt·lazy)은 `site-pages.test.ts` ③.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PHOTO_DATA_OUT, PHOTO_SRC_DIR, renderPhotoData, webpSize } from '../../../scripts/gen-photos';
import { SITE_PHOTOS } from '../../../src/site/photo-data';

const files = readdirSync(PHOTO_SRC_DIR).filter((f) => f.endsWith('.webp'));
const attribution = readFileSync(join(PHOTO_SRC_DIR, 'ATTRIBUTION.md'), 'utf8');

describe('홈 사진', () => {
  it('값 파일 = 커밋된 WebP 로 다시 만든 결과(재생성 누락 없음) · 값 파일의 바이트 = 디스크의 바이트', () => {
    expect(readFileSync(PHOTO_DATA_OUT, 'utf8')).toBe(renderPhotoData());
    const all = Object.values(SITE_PHOTOS).flat();
    expect(all.map((p) => p.path.split('/').pop()).sort()).toEqual([...files].sort());
    for (const p of all) {
      const disk = readFileSync(join(PHOTO_SRC_DIR, p.path.split('/').pop() ?? ''));
      expect(Buffer.from(p.base64, 'base64').equals(disk), p.path).toBe(true);
      expect(webpSize(disk)).toEqual({ width: p.width, height: p.height });
    }
  });

  it('예산 — 파일마다 500KB 미만, 합계 600KB 미만 · 히어로는 2400 폭까지', () => {
    const all = Object.values(SITE_PHOTOS).flat();
    for (const p of all) expect(p.bytes, p.path).toBeLessThan(500 * 1024);
    expect(all.reduce((n, p) => n + p.bytes, 0)).toBeLessThan(600 * 1024);
    expect(SITE_PHOTOS['desk-window'].map((p) => p.width)).toEqual([1200, 2400]);
  });

  it('메타데이터 없음 — WebP 청크에 EXIF·XMP·ICCP 가 없다(위치·기기 정보가 새지 않는다)', () => {
    for (const f of files) {
      const bytes = readFileSync(join(PHOTO_SRC_DIR, f));
      const chunks: string[] = [];
      for (let at = 12; at + 8 <= bytes.length; ) {
        const size = bytes.readUInt32LE(at + 4);
        chunks.push(bytes.toString('latin1', at, at + 4));
        at += 8 + size + (size % 2);
      }
      expect(chunks.filter((c) => /EXIF|XMP |ICCP/.test(c)), f).toEqual([]);
    }
  });

  it('출처 — ATTRIBUTION.md 가 파일마다 Unsplash 사진 페이지 · 작가 · 라이선스를 적는다', () => {
    expect(attribution).toContain('Unsplash License');
    for (const name of Object.keys(SITE_PHOTOS)) {
      const row = attribution.split('\n').find((l) => l.startsWith(`| \`${name}-`));
      expect(row, name).toBeDefined();
      expect(row).toMatch(/https:\/\/unsplash\.com\/photos\/[A-Za-z0-9_-]{11}/);
      expect(row).toMatch(/\| [^|]*[A-Za-z][^|]* \| `photo-/);
    }
  });
});
