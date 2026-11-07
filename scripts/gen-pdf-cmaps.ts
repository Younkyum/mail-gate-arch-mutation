/**
 * `pnpm gen:pdf-cmaps` — PDF 텍스트 추출(`src/api/pdf-text-worker.ts`)이 쓰는 **한국어 CMap** 데이터를 만든다.
 *
 *   입력: dependency `pdfjs-dist`(정확한 버전 고정 — 워커가 싣는 해석기 그 자체)의 `cmaps/*.bcmap` 중 한국어
 *         것만(`Adobe-Korea1-*` · `KSC*`(KSC-EUC · KSC-Johab · KSCms-UHC · KSCpc-EUC) · `UniKS-*`)과 `cmaps/LICENSE`(Adobe, BSD-3-Clause).
 *         `Identity-H/V` 는 해석기에 내장이라 파일이 필요 없다.
 *   출력: `src/api/pdf-korean-cmaps.json` — `{ license, source, cmaps: { 이름: base64 } }`. 커밋한다. `--check` 는 쓰지 않고 다르면 실패한다.
 *
 * 왜 CMap 을 싣는가: 오래된 한국어 PDF 는 글꼴이 글리프 번호 → 유니코드 표(ToUnicode)를 싣지 않고 `KSCms-UHC-H` 같은 이름만 댄다.
 * 표 없이 읽으면 텍스트가 빈다. 해석기는 표를 URL 로 가져오려 하는데 우리는 네트워크·파일 읽기를 하지 않는다 — 그래서 번들 안의
 * 데이터로 답한다(워커의 `InlineCMapFactory`). 한국어 것만 싣는 이유는 크기다(전체 169개 ≈ 1.6MB, 한국어 24개 ≈ 190KB).
 * JSON 인 이유: 워커는 번들(λ)과 원본 `.ts`(테스트 — Node 가 타입만 지우고 바로 돈다) 두 모양으로 돈다. 두 모양 모두 확장자 있는
 * import 속성(`with { type: 'json' }`) 하나로 같은 바이트를 본다(TS 모듈이면 원본 실행에서 `.ts` 확장자 import 가 필요해진다).
 * `test/unit/api/pdf-cmaps.test.ts` 가 이 파일이 node_modules 의 패키지와 바이트 단위로 같다는 것을 단언한다.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIR = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const CMAPS_DIR = join(PACKAGE_DIR, 'cmaps');

export const PDF_CMAPS_OUT = join(REPO_ROOT, 'src/api/pdf-korean-cmaps.json');

/** 한국어 CMap 파일 이름(확장자 제외). */
export const KOREAN_CMAP = /^(Adobe-Korea1-[A-Za-z0-9-]+|KSC[A-Za-z0-9-]*|UniKS-[A-Za-z0-9-]+)$/;

export function renderPdfCmaps(): string {
  const version = (JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string }).version;
  const cmaps: Record<string, string> = {};
  for (const file of readdirSync(CMAPS_DIR).filter((entry) => entry.endsWith('.bcmap')).sort()) {
    const name = file.slice(0, -'.bcmap'.length);
    if (KOREAN_CMAP.test(name)) cmaps[name] = readFileSync(join(CMAPS_DIR, file)).toString('base64');
  }
  const document = {
    source: `pdfjs-dist@${version} cmaps/ (Korean subset)`,
    license: readFileSync(join(CMAPS_DIR, 'LICENSE'), 'utf8'),
    cmaps,
  };
  return `${JSON.stringify(document, null, 1)}\n`;
}

function main(): void {
  const rendered = renderPdfCmaps();
  if (process.argv.includes('--check')) {
    if (readFileSync(PDF_CMAPS_OUT, 'utf8') !== rendered) {
      console.error('✗ src/api/pdf-korean-cmaps.json 이 pdfjs-dist 와 다르다 — pnpm gen:pdf-cmaps');
      process.exitCode = 1;
    }
    return;
  }
  writeFileSync(PDF_CMAPS_OUT, rendered);
  console.log(`  src/api/pdf-korean-cmaps.json  ${(rendered.length / 1024).toFixed(0)} KiB`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
