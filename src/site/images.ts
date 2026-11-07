/**
 * src/site/images.ts — 홈이 내는 이미지의 조회와 마크업. 바이트는 생성 값 파일 둘에 있다.
 *
 *   - `/img/<해시>/<사진>-<폭>.webp` — 홈 사진(Unsplash License, 출처 `assets/site/photos/ATTRIBUTION.md` · `pnpm gen:photos` →
 *     `photo-data.ts`). 해시가 경로에 있으므로 1년 immutable. 사진마다 폭 두 벌 이상 — `srcset`·`sizes` 로 화면에 맞는 한 장만 받는다.
 *   - `/og/<해시>/<lang>.png` — OG·Twitter 카드 이미지(1200×630, `pnpm gen:images` → `image-data.ts`). 메타 태그가 가리키는 정본 —
 *     링크 미리보기(카카오톡·슬랙·X)가 URL 로 기억하므로 그림이 바뀌면 URL 이 바뀐다(2026-09-30) → 1년 immutable.
 *   - `/og/<lang>.png` — 옛 고정 경로(이미 퍼진 링크·수동 입력). 같은 지금 그림 · 하루 캐시.
 * 페이지 CSP 는 이미 `img-src 'self'` 다(파비콘). 이미지는 같은 출처에서만 온다 — 핫링크 없음.
 */

import { OG_IMAGES, type SiteImage } from './image-data';
import { SITE_PHOTOS, type SitePhotoName } from './photo-data';

export const IMAGE_IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const OG_IMAGE_CACHE = 'public, max-age=86400';

/** OG 정본 경로 — 내용 해시가 든 `/og/<해시>/<lang>.png`. */
export function ogHashedPath(lang: 'ko' | 'en'): string {
  return `/og/${OG_IMAGES[lang].hash}/${lang}.png`;
}

const BY_PATH: ReadonlyMap<string, SiteImage> = new Map([
  ...[...Object.values(SITE_PHOTOS).flat(), ...Object.values(OG_IMAGES)].map((img): [string, SiteImage] => [img.path, img]),
  ...(['ko', 'en'] as const).map((lang): [string, SiteImage] => [ogHashedPath(lang), OG_IMAGES[lang]]),
]);

/** 옛 고정 OG 경로인가(하루 캐시) — 해시 경로·사진은 1년 immutable. */
export function isLegacyOgPath(path: string): boolean {
  return path === OG_IMAGES.ko.path || path === OG_IMAGES.en.path;
}

/** 경로 → 이미지. 표에 없으면 `undefined`(→ 404). */
export function siteImage(path: string): SiteImage | undefined {
  return BY_PATH.get(path);
}

/** 이미지 경로 아래인가(표에 있든 없든 — 없으면 핸들러가 404 한 줄). */
export function isImagePath(path: string): boolean {
  return path.startsWith('/img/') || path.startsWith('/og/');
}

export interface PhotoOptions {
  /** 레이아웃에서 이 사진이 차지하는 폭(`sizes`). */
  readonly sizes: string;
  /** 첫 화면의 가장 큰 그림(히어로) — 늦게 싣지 않는다(`fetchpriority="high"`). 나머지는 `loading="lazy"`. */
  readonly priority?: boolean;
  readonly className?: string;
}

/**
 * 사진 한 장 — `<img>` 하나에 `srcset`(폭 기술자)·`sizes`. 크기(`width`·`height`)는 좁은 벌의 값이라 자리가 미리 잡힌다(CLS 없음 —
 * 모든 벌이 같은 비율). `alt` 는 언어별 문구(정적 코드 상수). 해독은 비동기.
 */
export function photoImg(name: SitePhotoName, alt: string, options: PhotoOptions): string {
  const set = SITE_PHOTOS[name];
  const base = set[0];
  if (base === undefined) throw new Error(`사진 ${name} 이 없다`);
  const srcset = set.map((p) => `${p.path} ${String(p.width)}w`).join(', ');
  return (
    `<img${options.className === undefined ? '' : ` class="${options.className}"`} src="${base.path}" srcset="${srcset}" sizes="${options.sizes}"` +
    ` width="${String(base.width)}" height="${String(base.height)}" alt="${alt}" decoding="async"` +
    (options.priority === true ? ' fetchpriority="high">' : ' loading="lazy">')
  );
}
