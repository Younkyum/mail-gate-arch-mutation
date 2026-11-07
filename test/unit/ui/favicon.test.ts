/**
 * 파비콘(콘솔 v5 — `src/ui/favicon.ts`): 세 호스트(콘솔·홈·문서)가 같은 그림을 같은 경로로 낸다. 그림은 검은 둥근 사각형 위 흰 로고 심볼
 * (`src/ui/brand.ts` — 2026-09-30). SVG 는 글꼴에 기대지 않는 도형이고, ICO 는
 * 32×32 BGRA 하나를 감싼 결정적 산출물, apple-touch-icon 은 180×180 RGB PNG 다. 2026-09-30 부터 `<head>` 는 내용 해시가 든 경로를 가리키고
 * (1년 immutable), 옛 고정 경로 셋은 같은 그림을 하루 캐시로 낸다. 페이지 `<head>` 의 아이콘 링크 묶음(`FAVICON_LINK`)은 정확히 한 번 —
 * 다른 `<link>` 금지 단언의 유일한 예외.
 */
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import type { AdminHttpEvent } from '../../../src/admin/http';
import { renderAppPage, renderLoginPage } from '../../../src/admin/ui/index';
import { routeAdminEvent } from '../../../src/admin/router';
import { handleDocsRequest } from '../../../src/docs/http';
import { handleSiteRequest, SITE_ROUTES } from '../../../src/site/http';
import {
  APPLE_TOUCH_ICON_PATH,
  appleTouchPngBase64,
  FAVICON_CACHE_CONTROL,
  FAVICON_HASH,
  FAVICON_ICO_PATH,
  FAVICON_LEGACY_CACHE_CONTROL,
  FAVICON_LINK,
  FAVICON_PATHS,
  FAVICON_SVG,
  FAVICON_SVG_PATH,
  faviconAsset,
  faviconIcoBase64,
  renderAppleTouchPng,
  renderFaviconIco,
} from '../../../src/ui/favicon';
import { BRAND_SYMBOL_PATHS, BRAND_SYMBOL_VIEWBOX, inBrandSymbol } from '../../../src/ui/brand';

const siteGet = (path: string, method = 'GET') => handleSiteRequest({ rawPath: path, headers: { host: 'atmark.ai' }, requestContext: { domainName: 'atmark.ai', http: { method } } });

describe('파비콘', () => {
  it('SVG — 검은 둥근 사각형 위 흰 로고 심볼(무채색) · 경로는 로고 원천(brand.ts) 그대로 · 글꼴 <text>·외부 참조 없음', () => {
    expect(FAVICON_SVG).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 40 40">/);
    expect(FAVICON_SVG).toContain('<rect width="40" height="40" rx="9" fill="#111111"/>');
    // 심볼은 여백 7.5/40(18.75%) 안쪽 25×25 — 도형 상자(208)를 그대로 줄인다.
    expect(FAVICON_SVG).toContain(`<svg x="7.5" y="7.5" width="25" height="25" viewBox="${BRAND_SYMBOL_VIEWBOX}"><g fill="#FFFFFF">`);
    expect(FAVICON_SVG).toContain(`<path fill-rule="evenodd" d="${BRAND_SYMBOL_PATHS.rings}"/><path d="${BRAND_SYMBOL_PATHS.bracket}"/>`);
    expect(FAVICON_SVG).not.toMatch(/F97316|stroke=/i);
    expect(FAVICON_SVG).not.toMatch(/<text|<image|href=|url\(|<script|on[a-z]+=/i);
  });

  it('ICO — 헤더(아이콘 1개 · 32×32 · 32비트) · 결정적 · 모서리는 투명 · 고리·L 은 흰색 · 열린 사분면은 바탕', () => {
    const ico = renderFaviconIco();
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(1);
    expect(ico.readUInt8(6)).toBe(32);
    expect(ico.readUInt16LE(12)).toBe(32);
    expect(ico.readUInt32LE(14)).toBe(ico.length - 22);
    expect(renderFaviconIco().equals(ico)).toBe(true);
    expect(Buffer.from(faviconIcoBase64(), 'base64').equals(ico)).toBe(true);
    const px = (x: number, y: number): number[] => {
      const o = 22 + 40 + ((31 - y) * 32 + x) * 4;
      return [ico[o + 2] ?? -1, ico[o + 1] ?? -1, ico[o] ?? -1, ico[o + 3] ?? -1];
    };
    expect(px(0, 0)[3]).toBe(0);
    expect(px(7, 16)).toEqual([255, 255, 255, 255]); // 바깥 고리 왼쪽 — 흰색
    expect(px(24, 7)).toEqual([255, 255, 255, 255]); // L 위 막대 — 흰색
    expect(px(18, 11)).toEqual([17, 17, 17, 255]); // 오른쪽 위 사분면(고리가 열린 자리) — 바탕
    expect(px(3, 16)).toEqual([17, 17, 17, 255]); // 여백 — 바탕
  });

  it('래스터는 SVG 와 같은 도형 — 32×32 픽셀 가운데가 inBrandSymbol 판정과 맞는다(가장자리 걸친 픽셀 제외)', () => {
    const ico = renderFaviconIco();
    let checked = 0;
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        // 픽셀 네 모서리가 모두 같은 쪽이면(가장자리에 걸치지 않으면) 그 픽셀은 온전히 흰색이거나 온전히 바탕이다.
        const toSym = (px: number): number => 24 + ((px * 40) / 32 - 7.5) * (208 / 25);
        const corners = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1], [x + 0.5, y + 0.5]].map(([cx, cy]) => inBrandSymbol(toSym(cx ?? 0), toSym(cy ?? 0)));
        if (new Set(corners).size !== 1 || x < 2 || y < 2 || x > 29 || y > 29) continue;
        const o = 22 + 40 + ((31 - y) * 32 + x) * 4;
        expect([ico[o + 2], ico[o + 1], ico[o]], `${String(x)},${String(y)}`).toEqual(corners[0] === true ? [255, 255, 255] : [17, 17, 17]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('해시 경로 — FAVICON_HASH(16진 10자리)가 든 세 경로 · 옛 고정 경로 셋과 합쳐 여섯', () => {
    expect(FAVICON_HASH).toMatch(/^[0-9a-f]{10}$/);
    expect(FAVICON_SVG_PATH).toBe(`/favicon-${FAVICON_HASH}.svg`);
    expect(FAVICON_ICO_PATH).toBe(`/favicon-${FAVICON_HASH}.ico`);
    expect(APPLE_TOUCH_ICON_PATH).toBe(`/apple-touch-icon-${FAVICON_HASH}.png`);
    expect([...FAVICON_PATHS].sort()).toEqual(
      [FAVICON_SVG_PATH, FAVICON_ICO_PATH, APPLE_TOUCH_ICON_PATH, '/favicon.svg', '/favicon.ico', '/apple-touch-icon.png'].sort(),
    );
    expect(FAVICON_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
    expect(FAVICON_LEGACY_CACHE_CONTROL).toBe('public, max-age=86400');
    expect(faviconAsset('/favicon-0000000000.svg')).toBeUndefined();
    expect(faviconAsset('/favicon.png')).toBeUndefined();
  });

  it('PNG(apple-touch-icon) — 시그니처 · IHDR 180×180 RGB · 결정적 · 모서리는 바탕 #111111, 가운데 링 위는 흰색', () => {
    const png = renderAppleTouchPng();
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(180);
    expect(png.readUInt32BE(20)).toBe(180);
    expect(png.readUInt8(24)).toBe(8); // 비트 깊이
    expect(png.readUInt8(25)).toBe(2); // RGB
    expect(renderAppleTouchPng().equals(png)).toBe(true);
    expect(Buffer.from(appleTouchPngBase64(), 'base64').equals(png)).toBe(true);
    // IDAT 를 풀어 픽셀을 본다(줄마다 필터 바이트 0 + RGB).
    const idatLen = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    const row = 1 + 180 * 3;
    expect(raw.length).toBe(row * 180);
    const px = (x: number, y: number): number[] => [raw[y * row + 1 + x * 3] ?? -1, raw[y * row + 2 + x * 3] ?? -1, raw[y * row + 3 + x * 3] ?? -1];
    expect(px(0, 0)).toEqual([17, 17, 17]);
    expect(px(179, 179)).toEqual([17, 17, 17]);
    expect(px(90, 90)).toEqual([17, 17, 17]); // 안쪽 고리의 구멍 — 바탕
    expect(px(40, 92)).toEqual([255, 255, 255]); // 바깥 고리 왼쪽 — 흰색
    expect(px(124, 40)).toEqual([255, 255, 255]); // L 위 막대 — 흰색
    expect(px(110, 55)).toEqual([17, 17, 17]); // 오른쪽 위 사분면 — 바탕
    expect(new Set([...Array(180).keys()].map((x) => px(x, 90).join(','))).has('255,255,255')).toBe(true); // 가운데 줄 어딘가에 흰 고리
  });

  it('세 호스트 — 파비콘 여섯 경로 모두 200 · 맞는 content-type · 해시 경로 1년 immutable · 옛 경로 하루 · 옛 경로는 같은 바이트 · 쿠키 없음', async () => {
    const hashed: readonly (readonly [string, string, string])[] = [
      [FAVICON_SVG_PATH, '/favicon.svg', 'image/svg+xml'],
      [FAVICON_ICO_PATH, '/favicon.ico', 'image/x-icon'],
      [APPLE_TOUCH_ICON_PATH, '/apple-touch-icon.png', 'image/png'],
    ];
    const bodyOf: Record<string, string> = { 'image/svg+xml': FAVICON_SVG, 'image/x-icon': faviconIcoBase64(), 'image/png': appleTouchPngBase64() };
    const event = (path: string): AdminHttpEvent => ({ rawPath: path, requestContext: { requestId: 'fav', stage: '$default', http: { method: 'GET' } } });
    const deps = {} as Parameters<typeof routeAdminEvent>[0];
    const docsGet = (path: string) => handleDocsRequest({ rawPath: path, headers: { host: 'docs.atmark.ai' }, requestContext: { http: { method: 'GET' } } });
    for (const [path, legacy, type] of hashed) {
      for (const [p, cache] of [[path, FAVICON_CACHE_CONTROL], [legacy, FAVICON_LEGACY_CACHE_CONTROL]] as const) {
        const responses = [siteGet(p), docsGet(p), await routeAdminEvent(deps, event(p))];
        for (const r of responses) {
          expect(r.statusCode, p).toBe(200);
          expect(r.headers['content-type'], p).toBe(type);
          expect(r.headers['cache-control'], p).toBe(cache);
          expect(r.isBase64Encoded, p).toBe(type !== 'image/svg+xml');
          expect(r.body, p).toBe(bodyOf[type]);
          expect(JSON.stringify(r.headers).toLowerCase()).not.toContain('set-cookie');
        }
        expect((responses[2] as { cookies?: unknown }).cookies, p).toBeUndefined();
      }
    }
    expect(siteGet(FAVICON_ICO_PATH, 'HEAD').body).toBe('');
    expect(siteGet(APPLE_TOUCH_ICON_PATH, 'HEAD').statusCode).toBe(200);
  });

  it('FAVICON_LINK 는 세 줄(ICO 32×32 · SVG · apple-touch-icon — 모두 해시 경로)', () => {
    expect(FAVICON_LINK).toBe(
      `<link rel="icon" href="${FAVICON_ICO_PATH}" sizes="32x32">` +
        `<link rel="icon" href="${FAVICON_SVG_PATH}" type="image/svg+xml">` +
        `<link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON_PATH}">`,
    );
  });

  it('페이지 <head> 에 아이콘 링크 묶음(FAVICON_LINK) 정확히 한 번 — 콘솔·홈 모두', () => {
    for (const html of [renderAppPage('ko').html, renderLoginPage('en').html, ...Object.values(SITE_ROUTES).map((p) => p.html)]) {
      expect(html.split(FAVICON_LINK)).toHaveLength(2);
      expect(html.indexOf(FAVICON_LINK)).toBeLessThan(html.indexOf('</head>'));
    }
  });
});
