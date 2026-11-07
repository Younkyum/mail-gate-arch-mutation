/**
 * `src/api/pdf-korean-cmaps.json` — PDF 워커가 싣는 한국어 CMap(`scripts/gen-pdf-cmaps.ts`).
 *
 *   - 커밋한 파일이 devDependency `pdfjs-dist` 의 `cmaps/` 와 바이트 단위로 같다(재생성을 잊으면 빨개진다)
 *   - `pdfjs-dist` 는 운영 의존성 · 정확한 버전 고정 · GHSA-hq66-cqwq-w95j 패치판(6.2.108) 이상(CMap 과 해석기가 같은 패키지 — 같은 판)
 *   - 한국어 것만(일본어·중국어 CMap 이 섞여 번들이 부풀지 않는다) · 흔한 이름이 다 있다 · 저작권 고지가 함께 실린다
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { KOREAN_CMAP, PDF_CMAPS_OUT, renderPdfCmaps } from '../../../scripts/gen-pdf-cmaps';

describe('한국어 CMap 데이터', () => {
  it('커밋한 파일 = pdfjs-dist 에서 다시 만든 것', () => {
    expect(readFileSync(PDF_CMAPS_OUT, 'utf8')).toBe(renderPdfCmaps());
  });

  it('pdfjs-dist — 운영 의존성 · 정확한 버전 고정 = 설치된 판 · 패치판(≥ 6.2.108) 이상', () => {
    const require = createRequire(import.meta.url);
    const version = (require('pdfjs-dist/package.json') as { version: string }).version;
    const manifest = JSON.parse(readFileSync(join(dirname(PDF_CMAPS_OUT), '../../package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.dependencies['pdfjs-dist']).toBe(version);
    expect(manifest.devDependencies['pdfjs-dist']).toBeUndefined();
    expect(manifest.dependencies['unpdf']).toBeUndefined(); // 옛 판을 번들한 래퍼 — 다시 들어오면 해석기가 둘이 된다
    const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(6_002_108);
  });

  it('한국어 것만 · 흔한 이름이 다 있다 · 저작권 고지', () => {
    const document = JSON.parse(readFileSync(PDF_CMAPS_OUT, 'utf8')) as { license: string; cmaps: Record<string, string> };
    const names = Object.keys(document.cmaps);
    expect(names.every((name) => KOREAN_CMAP.test(name))).toBe(true);
    for (const name of ['Adobe-Korea1-UCS2', 'KSCms-UHC-H', 'KSC-EUC-H', 'UniKS-UCS2-H', 'UniKS-UTF16-H']) expect(names).toContain(name);
    expect(names.some((name) => /Japan|GB|CNS|Identity/.test(name))).toBe(false);
    expect(document.license).toContain('Adobe Systems Incorporated');
  });
});
