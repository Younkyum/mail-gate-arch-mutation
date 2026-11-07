/**
 * 자체 호스팅 폰트(Pretendard Variable, SIL OFL 1.1) — `src/ui/fonts.ts` · 생성 파일 `src/ui/pretendard-data.ts` · 두 핸들러의 `/_fonts/…`.
 *
 *   ① 생성 파일이 devDependency `pretendard`(정확한 버전)와 **바이트 단위로 같다** — 패키지를 올리고 `pnpm gen:fonts` 를 잊으면 빨개진다.
 *   ② OFL 전문이 자산 옆(`src/ui/pretendard-LICENSE.txt`)에 있다.
 *   ③ `@font-face` CSS 의 모든 `url()` 이 두 핸들러에서 200 으로 풀린다(없는 경로를 가리키지 않는다) · 홈의 하나뿐인 `<style>`·콘솔의 스타일시트 자산 맨 앞에 있다.
 *   ④ 홈 핸들러: 200 · `font/woff2` · 1년 immutable · base64 본문 / 없는 폰트 경로 404 / HEAD / 다른 호스트.
 *   ⑤ 콘솔 핸들러는 폰트를 내지 않는다(리뷰 M4) — 콘솔 CSS 는 사이트 출처의 절대 URL 을 쓰고, `/_fonts/…` 는 평소 라우팅(조립)으로 간다.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { contentHash, packageLicense, packageSubsetCss, packageVersion, parseSubsetCss, readPackageChunk, renderFontFaces } from '../../../scripts/gen-fonts';
import type { AdminHttpEvent } from '../../../src/admin/http';
import { adminUiAsset, renderAppPage, renderLoginPage } from '../../../src/admin/ui/index';
import { ADMIN_UI_CSS } from '../../../src/admin/ui/styles';
import { createAdminHandler } from '../../../src/runtime/handlers/admin';
import type { LambdaContext } from '../../../src/runtime/lambda';
import { CONSOLE_ORIGIN, SITE_ORIGIN } from '../../../src/site/constants';
import { handleSiteRequest, SITE_ROUTES, type SiteHttpEvent } from '../../../src/site/http';
import { PAY_INFO_PAGES } from '../../../src/site/pay';
import { SITE_CSS, SITE_CSS_NO_FONTS } from '../../../src/site/styles';
import { FONT_FACE_CSS, fontAsset, fontFaceCss, fontPath } from '../../../src/ui/fonts';
import { PRETENDARD_CHUNKS, PRETENDARD_VERSION } from '../../../src/ui/pretendard-data';
import { PRETENDARD_FACES } from '../../../src/ui/pretendard-faces';

const REPO_ROOT = join(__dirname, '../../..');
const FIRST = PRETENDARD_CHUNKS[0];
if (FIRST === undefined) throw new Error('청크가 없다');
const FIRST_PATH = fontPath(FIRST);

const siteEvent = (path: string, method = 'GET', host = 'atmark.ai'): SiteHttpEvent => ({
  rawPath: path,
  headers: { host },
  requestContext: { domainName: host, http: { method } },
});

const adminEvent = (path: string, method = 'GET'): AdminHttpEvent => ({
  rawPath: path,
  requestContext: { requestId: 'req-font', stage: '$default', apiId: 'consoleapi1', http: { method } },
});

const lambdaContext = (): LambdaContext => ({ awsRequestId: 'aws-1', invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:x', callbackWaitsForEmptyEventLoop: true });

/** 조립이 늘 실패하는 콘솔 핸들러 — 불린 횟수를 센다. */
function adminWithoutDb(): { handler: ReturnType<typeof createAdminHandler>; calls: () => number } {
  let calls = 0;
  const handler = createAdminHandler(() => {
    calls += 1;
    return Promise.reject(new Error('no db in unit test'));
  }, undefined, () => 'consoleapi1');
  return { handler, calls: () => calls };
}

const urlsOf = (css: string): string[] => [...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1] ?? '');
const styleBlocks = (html: string): string[] => [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '');

describe('① 생성 파일 = 패키지', () => {
  it('버전이 package.json 의 정확한 고정 버전과 같다', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies['pretendard']).toBe(PRETENDARD_VERSION);
    expect(packageVersion()).toBe(PRETENDARD_VERSION);
  });

  it('청크 목록(파일·unicode-range·순서)이 패키지 CSS 와 같고, 본문·해시·크기가 파일과 같다', () => {
    const parsed = parseSubsetCss(packageSubsetCss());
    expect(parsed.length).toBeGreaterThan(50);
    expect(PRETENDARD_CHUNKS.map((c) => ({ file: c.file, unicodeRange: c.unicodeRange }))).toEqual(parsed);
    for (const chunk of PRETENDARD_CHUNKS) {
      const bytes = readPackageChunk(chunk.file);
      expect(chunk.bytes, chunk.file).toBe(bytes.length);
      expect(chunk.hash, chunk.file).toBe(contentHash(bytes));
      expect(chunk.base64 === bytes.toString('base64'), chunk.file).toBe(true);
    }
  });

  it('메타 표(pretendard-faces.ts — 본문 없음)가 생성기 출력과 같고, 데이터 표와 같은 순서·파일·해시·범위다(M4 — 콘솔 번들용)', () => {
    expect(readFileSync(join(REPO_ROOT, 'src/ui/pretendard-faces.ts'), 'utf8')).toBe(renderFontFaces());
    expect(PRETENDARD_FACES).toEqual(PRETENDARD_CHUNKS.map((c) => ({ file: c.file, hash: c.hash, unicodeRange: c.unicodeRange })));
    expect(readFileSync(join(REPO_ROOT, 'src/ui/pretendard-faces.ts'), 'utf8')).not.toMatch(/base64:/);
  });

  it('한글 음절 전체(U+AC00–U+D7A3)가 어느 청크의 unicode-range 에 든다', () => {
    const ranges = PRETENDARD_CHUNKS.flatMap((c) =>
      c.unicodeRange.split(',').map((part) => {
        const [lo, hi] = part.replace('U+', '').split('-');
        return [Number.parseInt(lo ?? '', 16), Number.parseInt(hi ?? lo ?? '', 16)] as const;
      }),
    );
    const missing: number[] = [];
    for (let cp = 0xac00; cp <= 0xd7a3; cp += 1) if (!ranges.some(([lo, hi]) => cp >= lo && cp <= hi)) missing.push(cp);
    expect(missing).toEqual([]);
  });
});

describe('② 라이선스', () => {
  it('OFL 전문이 자산 옆에 있고 패키지의 것과 같다', () => {
    const text = readFileSync(join(REPO_ROOT, 'src/ui/pretendard-LICENSE.txt'), 'utf8');
    expect(text).toBe(packageLicense());
    expect(text).toContain('SIL OPEN FONT LICENSE');
    expect(text).toContain('Version 1.1');
    expect(text).toContain('Pretendard');
    expect(readFileSync(join(REPO_ROOT, 'src/ui/pretendard-data.ts'), 'utf8')).toMatch(/SIL Open Font License 1\.1/);
  });
});

describe('③ CSS', () => {
  it('청크마다 @font-face 하나 · 가족·굵기·swap · ASCII 만', () => {
    const rules = FONT_FACE_CSS.split('\n');
    expect(rules).toHaveLength(PRETENDARD_CHUNKS.length);
    for (const rule of rules) {
      expect(rule).toMatch(/^@font-face\{font-family:"Pretendard Variable";font-display:swap;font-weight:45 920;src:url\(\/_fonts\/[0-9a-f]{10}\/[A-Za-z0-9.-]+\.woff2\) format\("woff2-variations"\);unicode-range:[U+0-9a-f,-]+\}$/);
    }
    expect(FONT_FACE_CSS).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it('모든 url() 이 표에 있고 홈 핸들러에서 200 으로 풀린다 · 콘솔 CSS 의 url 은 같은 경로의 사이트 절대 URL 이다(M4)', () => {
    const urls = urlsOf(FONT_FACE_CSS);
    expect(urls).toHaveLength(PRETENDARD_CHUNKS.length);
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) {
      expect(fontAsset(url), url).toBeDefined();
      expect(handleSiteRequest(siteEvent(url)).statusCode, url).toBe(200);
    }
    expect(urlsOf(ADMIN_UI_CSS)).toEqual(urls.map((url) => `${SITE_ORIGIN}${url}`));
  });

  it('콘솔·홈 스타일의 맨 앞에 있다 · 홈은 페이지마다 인라인 <style> 하나 · 콘솔은 스타일시트 자산 하나 · 결제 호스트 시트에는 없다', () => {
    expect(ADMIN_UI_CSS.startsWith(`\n${fontFaceCss(SITE_ORIGIN)}\n`)).toBe(true);
    expect(SITE_CSS.startsWith(`\n${FONT_FACE_CSS}\n`)).toBe(true);
    const fontUrlsResolve = (css: string): boolean =>
      urlsOf(css).every((url) => fontAsset(url.startsWith(SITE_ORIGIN) ? url.slice(SITE_ORIGIN.length) : url) !== undefined);
    for (const html of Object.values(SITE_ROUTES).map((p) => p.html)) {
      const styles = styleBlocks(html);
      expect(styles).toHaveLength(1);
      expect(fontUrlsResolve(styles[0] ?? '')).toBe(true);
      expect(html).not.toMatch(/<link\b[^>]*rel="?(preload|stylesheet)/i);
    }
    // 콘솔(`admin/ui/page.ts`)은 인라인 <style> 이 없고, 같은 출처의 스타일시트 자산 하나가 그 CSS(폰트 면이 맨 앞)를 낸다. 폰트 preload 없음.
    for (const html of [renderLoginPage('ko').html, renderAppPage('en').html]) {
      expect(styleBlocks(html)).toEqual([]);
      const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)" integrity="[^"]+">/g)].map((m) => m[1] ?? '');
      expect(sheets).toHaveLength(1);
      expect(adminUiAsset(sheets[0] ?? '')?.body).toBe(ADMIN_UI_CSS);
      expect(fontUrlsResolve(ADMIN_UI_CSS)).toBe(true);
      expect(html).not.toMatch(/<link\b[^>]*rel="?preload/i);
    }
    expect(SITE_CSS_NO_FONTS).not.toMatch(/@font-face|url\(/);
    for (const page of Object.values(PAY_INFO_PAGES)) expect(page.html).not.toContain('@font-face');
  });
});

describe('③-출처 fontFaceCss(origin) — 콘솔이 홈 출처에서 받는 판(배포 전 리뷰 M4)', () => {
  it("'' 는 같은 출처 판(FONT_FACE_CSS) · 출처를 주면 url 만 그 절대 URL 로 바뀐다", () => {
    expect(fontFaceCss('')).toBe(FONT_FACE_CSS);
    const abs = fontFaceCss(SITE_ORIGIN);
    expect(abs.replaceAll(`url(${SITE_ORIGIN}/_fonts/`, 'url(/_fonts/')).toBe(FONT_FACE_CSS);
    expect(abs).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
  });

  it.each(['https://atmark.ai/', 'https://atmark.ai/x', 'http://atmark.ai', 'https://evil.example)', 'javascript:x', '*', 'https://a b'])('출처가 아닌 값 %j 는 거부한다', (origin) => {
    expect(() => fontFaceCss(origin)).toThrow();
  });
});

describe('④ 홈 핸들러 /_fonts/…', () => {
  it('GET 실제 청크 → 200 · font/woff2 · 1년 immutable · base64 본문 = 패키지 파일', () => {
    const res = handleSiteRequest(siteEvent(FIRST_PATH));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('font/woff2');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // 콘솔이 이 폰트를 교차 출처로 받는다(배포 전 리뷰 M4) — 허용은 콘솔 출처 **하나**(반사·`*` 아님 → vary: origin 불필요).
    expect(res.headers['access-control-allow-origin']).toBe(CONSOLE_ORIGIN);
    expect(res.headers['vary']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    // 문서용 헤더는 물려받지 않는다(I-2) — 페이지 캐시 5분·프레임 금지·리퍼러는 폰트에 뜻이 없다.
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['referrer-policy']).toBeUndefined();
    expect(res.isBase64Encoded).toBe(true);
    expect(Buffer.from(res.body, 'base64').equals(readPackageChunk(FIRST.file))).toBe(true);
  });

  it('HEAD → 200 · 빈 본문 · 같은 헤더', () => {
    const res = handleSiteRequest(siteEvent(FIRST_PATH, 'HEAD'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-type']).toBe('font/woff2');
  });

  it.each([
    '/_fonts/',
    '/_fonts/0000000000/PretendardVariable.subset.0.woff2',
    `/_fonts/${FIRST.hash}/nope.woff2`,
    `${FIRST_PATH}/`,
    `/_fonts/${FIRST.hash}/${FIRST.file.toUpperCase()}`,
  ])('없는 폰트 경로 %s → 404 텍스트(HTML 404 페이지가 아니다)', (path) => {
    const res = handleSiteRequest(siteEvent(path));
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.isBase64Encoded).toBe(false);
  });

  it('POST → 405 · www → 301 apex · pay 호스트에는 폰트가 없다(404)', () => {
    expect(handleSiteRequest(siteEvent(FIRST_PATH, 'POST')).statusCode).toBe(405);
    const www = handleSiteRequest(siteEvent(FIRST_PATH, 'GET', 'www.atmark.ai'));
    expect(www.statusCode).toBe(301);
    expect(www.headers['location']).toBe(`https://atmark.ai${FIRST_PATH}`);
    expect(handleSiteRequest(siteEvent(FIRST_PATH, 'GET', 'pay.atmark.ai')).statusCode).toBe(404);
  });
});

describe('⑤ 콘솔 핸들러는 폰트를 내지 않는다(리뷰 M4)', () => {
  it('/_fonts/… 도 평소 라우팅 — 조립을 부른다(여기선 조립이 실패해 503) · 폰트 본문·base64 가 없다', async () => {
    const { handler, calls } = adminWithoutDb();
    const res = await handler(adminEvent(FIRST_PATH), lambdaContext());
    expect(res.statusCode).toBe(503);
    expect(res.isBase64Encoded).toBe(false);
    expect(res.headers['content-type']).not.toBe('font/woff2');
    expect(calls()).toBe(1);
  });
});
