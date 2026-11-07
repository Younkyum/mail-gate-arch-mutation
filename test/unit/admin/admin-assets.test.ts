/**
 * 콘솔 정적 자산(`/_assets/<내용 해시>/<파일>` — `src/admin/ui/page.ts`) — 스타일시트·페이지 스크립트를 인라인에서 뺀 뒤의 서빙 계약.
 *
 *   ① 핸들러가 **조립(DB·비밀) 전에** 답한다 — 조립이 실패해도 자산은 200 이고 조립을 부르지 않는다(자산이 아닌 경로는 평소대로 조립).
 *   ② 200 · 정확한 content-type · `public, max-age=31536000, immutable` · nosniff · CORP same-origin · 본문 = 자산 · SRI = 본문의 sha384.
 *   ③ gzip — `Accept-Encoding` 에 따라(base64 본문 · `Vary: Accept-Encoding`).
 *   ④ 없는 자산 경로·모양이 다른 경로는 404(`no-store` — 옛 해시가 캐시에 박히지 않게) · GET 이 아니면 405.
 *   ⑤ 경로가 곧 본문 — 여섯 페이지 × 두 언어가 스타일시트 하나를 같이 쓰고, 페이지 스크립트는 페이지·언어마다 따로다.
 *   ⑥ 미리보기 출처(`consoleOrigin`)로 렌더한 페이지는 CSP 의 자산 URL 만 그 출처로 바뀐다(자산 경로·HTML 은 운영과 같다).
 */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { ASSET_CACHE_CONTROL, type AdminHttpEvent, type AdminHttpResult } from '../../../src/admin/http';
import { routeAdminAssetEvent } from '../../../src/admin/router';
import {
  adminUiAsset,
  renderAppPage,
  renderInvitePage,
  renderLoginLandingPage,
  renderLoginPage,
  renderSignupLandingPage,
  renderSignupPage,
  type AdminUiPage,
  type Lang,
} from '../../../src/admin/ui/index';
import { createAdminHandler } from '../../../src/runtime/handlers/admin';
import type { LambdaContext } from '../../../src/runtime/lambda';

const RENDERERS: readonly ((lang?: Lang, options?: { fontOrigin?: string; consoleOrigin?: string }) => AdminUiPage)[] = [
  renderLoginPage,
  renderLoginLandingPage,
  renderAppPage,
  renderSignupPage,
  renderSignupLandingPage,
  renderInvitePage,
];

const event = (path: string, method = 'GET', headers: Record<string, string> = {}): AdminHttpEvent => ({
  rawPath: path,
  headers,
  requestContext: { requestId: 'req-asset', stage: '$default', apiId: 'consoleapi1', http: { method } },
});

const CONTEXT = { invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:000000000000:function:atmark-admin', getRemainingTimeInMillis: () => 10_000 } as unknown as LambdaContext;

function adminWithoutDb(): { handler: ReturnType<typeof createAdminHandler>; calls: () => number } {
  let calls = 0;
  const handler = createAdminHandler(() => {
    calls += 1;
    return Promise.reject(new Error('no db in unit test'));
  }, undefined, () => 'consoleapi1');
  return { handler, calls: () => calls };
}

function assetPaths(page: AdminUiPage): { readonly css: string; readonly js: string } {
  return {
    css: /<link rel="stylesheet" href="([^"]+)"/.exec(page.html)?.[1] ?? '∅',
    js: /<script src="([^"]+)"/.exec(page.html)?.[1] ?? '∅',
  };
}

const APP = assetPaths(renderAppPage('ko'));

describe('① 조립 전에 답한다', () => {
  it('조립이 실패해도 자산은 200 이고 조립을 부르지 않는다 · 자산이 아닌 경로는 조립으로 간다(503)', async () => {
    const { handler, calls } = adminWithoutDb();
    for (const path of [APP.css, APP.js]) {
      const result = (await handler(event(path), CONTEXT)) as AdminHttpResult;
      expect(result.statusCode, path).toBe(200);
    }
    expect(calls()).toBe(0);
    const page = (await handler(event('/app'), CONTEXT)) as AdminHttpResult;
    expect(page.statusCode).toBe(503);
    expect(calls()).toBe(1);
  });
});

describe('② 응답 헤더 · 본문 · SRI', () => {
  it.each([
    ['css', APP.css, 'text/css; charset=utf-8'],
    ['js', APP.js, 'text/javascript; charset=utf-8'],
  ] as const)('%s — 200 · content-type · 1년 immutable · nosniff · CORP · 본문 = 자산 · SRI 가 본문과 맞다', (_kind, path, type) => {
    const result = routeAdminAssetEvent(event(path));
    expect(result?.statusCode).toBe(200);
    expect(result?.isBase64Encoded).toBe(false);
    expect(result?.headers).toMatchObject({
      'content-type': type,
      'cache-control': ASSET_CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'strict-transport-security': 'max-age=63072000; includeSubDomains',
      vary: 'Accept-Encoding',
    });
    expect(ASSET_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
    expect(result?.headers['set-cookie']).toBeUndefined();
    expect(result?.cookies).toBeUndefined();
    const asset = adminUiAsset(path);
    expect(result?.body).toBe(asset?.body);
    const sri = `sha384-${createHash('sha384').update(result?.body ?? '', 'utf8').digest('base64')}`;
    expect(renderAppPage('ko').html).toContain(`${path}" integrity="${sri}"`);
    // 경로의 해시는 본문의 sha384 앞 16 hex — URL 하나가 본문 하나.
    expect(path.split('/')[2]).toBe(createHash('sha384').update(result?.body ?? '', 'utf8').digest('hex').slice(0, 16));
  });
});

describe('③ gzip', () => {
  it('Accept-Encoding: gzip 이면 base64 gzip 본문 · content-encoding · 아니면 그대로', () => {
    const plain = routeAdminAssetEvent(event(APP.js));
    for (const ae of ['gzip, deflate, br', '*']) {
      const packed = routeAdminAssetEvent(event(APP.js, 'GET', { 'accept-encoding': ae }));
      expect(packed?.isBase64Encoded, ae).toBe(true);
      expect(packed?.headers['content-encoding'], ae).toBe('gzip');
      expect(packed?.headers['vary'], ae).toBe('Accept-Encoding');
      expect(gunzipSync(Buffer.from(packed?.body ?? '', 'base64')).toString('utf8'), ae).toBe(plain?.body);
    }
    const off = routeAdminAssetEvent(event(APP.css, 'GET', { 'accept-encoding': 'gzip;q=0' }));
    expect(off?.isBase64Encoded).toBe(false);
    expect(off?.headers['content-encoding']).toBeUndefined();
  });
});

describe('④ 없는 자산 · 메서드', () => {
  it('없는 자산·모양이 다른 경로는 404 route_not_found(no-store) · 자산 밖 경로는 null(평소 라우팅)', () => {
    const [, , hash = '', file = ''] = APP.js.split('/');
    for (const path of [
      '/_assets/',
      `/_assets/${hash}`,
      `/_assets/${hash}/`,
      `/_assets/0000000000000000/${file}`,
      `/_assets/${hash}/console.css`,
      `/_assets/${hash}/${file}/`,
      `/_assets/${hash.toUpperCase()}/${file}`,
      `/_assets/../app`,
    ]) {
      const result = routeAdminAssetEvent(event(path));
      expect(result?.statusCode, path).toBe(404);
      expect(result?.headers['cache-control'], path).toBe('no-store');
      expect(JSON.parse(result?.body ?? '{}'), path).toMatchObject({ error: 'route_not_found' });
    }
    for (const path of ['/app', '/_asset/x', '/api/me', '/x/_assets/a']) expect(routeAdminAssetEvent(event(path)), path).toBeNull();
  });

  it.each(['HEAD', 'POST', 'OPTIONS', 'DELETE'])('%s 는 405 · allow: GET', (method) => {
    const result = routeAdminAssetEvent(event(APP.css, method));
    expect(result?.statusCode).toBe(405);
    expect(result?.headers['allow']).toBe('GET');
  });
});

describe('⑤ 경로가 곧 본문', () => {
  it('여섯 페이지 × 두 언어가 스타일시트 하나를 같이 쓰고, 페이지 스크립트는 페이지·언어마다 따로다', () => {
    const pages = RENDERERS.flatMap((render) => (['ko', 'en'] as const).map((lang) => assetPaths(render(lang))));
    expect(new Set(pages.map((p) => p.css))).toEqual(new Set([APP.css]));
    expect(new Set(pages.map((p) => p.js)).size).toBe(pages.length);
    for (const p of pages) {
      expect(adminUiAsset(p.css)?.contentType).toBe('text/css; charset=utf-8');
      expect(adminUiAsset(p.js)?.contentType).toBe('text/javascript; charset=utf-8');
      expect(adminUiAsset(p.js)?.body).toMatch(/^var LANG='(ko|en)';/);
    }
  });
});

describe('⑥ 미리보기 출처', () => {
  it('consoleOrigin 을 주면 CSP 의 자산 URL 만 그 출처 · 자산 경로와 HTML 은 운영과 같다 · 폰트 출처를 바꾸면 스타일시트만 새 자산', () => {
    const local = 'http://127.0.0.1:4173';
    const prod = renderAppPage('ko');
    const preview = renderAppPage('ko', { consoleOrigin: local });
    expect(preview.html).toBe(prod.html);
    expect(preview.csp).toBe(prod.csp.split('https://console.atmark.ai/').join(`${local}/`));
    const fonts = renderAppPage('ko', { consoleOrigin: local, fontOrigin: 'http://127.0.0.1:4174' });
    const paths = assetPaths(fonts);
    expect(paths.js).toBe(APP.js);
    expect(paths.css).not.toBe(APP.css);
    expect(adminUiAsset(paths.css)?.body).toContain('url(http://127.0.0.1:4174/_fonts/');
    expect(fonts.csp).toContain(`style-src ${local}${paths.css};`);
    expect(fonts.csp).toContain('font-src http://127.0.0.1:4174;');
  });
});
