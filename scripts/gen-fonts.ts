/**
 * `pnpm gen:fonts` — 자체 호스팅 폰트(Pretendard Variable, SIL OFL 1.1 · orioncactus) 데이터 모듈을 만든다.
 *
 *   입력: devDependency `pretendard`(정확한 버전 고정)의 `dist/web/variable/pretendardvariable-dynamic-subset.css`(청크마다
 *         `unicode-range`)와 `woff2-dynamic-subset/*.woff2`, 그리고 `dist/LICENSE.txt`.
 *   출력: `src/ui/pretendard-data.ts`(청크마다 파일 이름 · 내용 해시 · unicode-range · 바이트 수 · **base64 본문**)와
 *         `src/ui/pretendard-LICENSE.txt`(OFL 전문). 둘 다 커밋한다. `--check` 는 쓰지 않고 다르면 실패한다.
 *
 * 왜 base64 를 **커밋하는 TS 모듈**인가(파일을 번들 옆에 복사해 콜드 스타트에 읽는 대신):
 *   - vitest · tsx(`scripts/ui/preview.ts`) · esbuild λ 번들 **세 환경이 같은 import 하나로** 같은 바이트를 본다. 파일 복사 방식은
 *     "번들 옆 `fonts/` 가 있으면 거기, 없으면 node_modules" 같은 환경별 경로 추측이 필요하고, 그 분기가 운영에서만 틀릴 수 있다.
 *   - λ 응답은 어차피 base64(`isBase64Encoded: true`)다 — 요청마다 인코딩하지 않고 문자열을 그대로 싣는다. fs 접근 0.
 *   - import 한 번들(admin·site)만 폰트를 싣는다 — 다른 λ 는 import 그래프에 없으므로 0 바이트(`pnpm build:lambda` 크기로 확인).
 *   - 대가: 저장소에 ~4MB 생성 파일 하나 · 두 번들이 각각 ~4MB 커진다(zip 으로는 원본 woff2 ≈ 3MB 수준).
 *   - 내용 해시가 URL 에 들어가므로(`/_fonts/<hash>/<file>`) 캐시는 1년 immutable 이고, 폰트가 바뀌면 URL 이 바뀐다.
 * `test/unit/ui/fonts.test.ts` 가 이 파일이 node_modules 의 패키지와 **바이트 단위로 같다**는 것을 단언한다(재생성을 잊으면 빨개진다).
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIR = dirname(createRequire(import.meta.url).resolve('pretendard/package.json'));
const VARIABLE_DIR = join(PACKAGE_DIR, 'dist/web/variable');
const SUBSET_CSS = join(VARIABLE_DIR, 'pretendardvariable-dynamic-subset.css');
const LICENSE_SRC = join(PACKAGE_DIR, 'dist/LICENSE.txt');

export const FONT_DATA_OUT = join(REPO_ROOT, 'src/ui/pretendard-data.ts');
export const FONT_LICENSE_OUT = join(REPO_ROOT, 'src/ui/pretendard-LICENSE.txt');
/** 메타만(파일·해시·unicode-range — base64 없음). 콘솔 번들이 `@font-face` 를 만들 때 폰트 바이트를 싣지 않게(배포 전 리뷰 M4). */
export const FONT_FACES_OUT = join(REPO_ROOT, 'src/ui/pretendard-faces.ts');

export interface ParsedChunk {
  readonly file: string;
  readonly unicodeRange: string;
}

/** 패키지 CSS → 청크 목록(원래 순서). 각 `@font-face` 의 `url(./woff2-dynamic-subset/<file>)` 과 `unicode-range`. */
export function parseSubsetCss(css: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    const file = /url\(\.\/woff2-dynamic-subset\/([A-Za-z0-9.-]+\.woff2)\)/.exec(block)?.[1];
    const range = /unicode-range:\s*([^;}]+)/.exec(block)?.[1]?.trim().replace(/\s+/g, '');
    if (file === undefined || range === undefined) throw new Error(`@font-face 를 읽지 못했다: ${block.slice(0, 120)}`);
    if (!/^[U+0-9a-fA-F?,-]+$/.test(range)) throw new Error(`unicode-range 형식이 예상과 다르다: ${file}`);
    chunks.push({ file, unicodeRange: range });
  }
  if (chunks.length === 0) throw new Error('청크가 0 개 — 패키지 구조가 바뀌었다.');
  return chunks;
}

/** 파일 내용 해시(sha256 앞 10 hex) — URL 의 캐시 키. */
export function contentHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 10);
}

export function packageVersion(): string {
  return (JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string }).version;
}

export function readPackageChunk(file: string): Buffer {
  return readFileSync(join(VARIABLE_DIR, 'woff2-dynamic-subset', file));
}

export function packageSubsetCss(): string {
  return readFileSync(SUBSET_CSS, 'utf8');
}

export function packageLicense(): string {
  return readFileSync(LICENSE_SRC, 'utf8');
}

export function renderFontData(): string {
  const chunks = parseSubsetCss(packageSubsetCss()).map((chunk) => {
    const bytes = readPackageChunk(chunk.file);
    return { ...chunk, hash: contentHash(bytes), bytes: bytes.length, base64: bytes.toString('base64') };
  });
  const rows = chunks
    .map((c) => `  { file: '${c.file}', hash: '${c.hash}', bytes: ${String(c.bytes)}, unicodeRange: '${c.unicodeRange}', base64: '${c.base64}' },`)
    .join('\n');
  return (
    '/**\n' +
    ' * 생성 파일 — 손으로 고치지 않는다. `pnpm gen:fonts`(`scripts/gen-fonts.ts`)가 devDependency `pretendard` 에서 만든다.\n' +
    ` * Pretendard Variable ${packageVersion()} (dynamic subset, woff2) — Copyright (c) 2021 Kil Hyung-jin, with Reserved Font Name Pretendard.\n` +
    ' * https://github.com/orioncactus/pretendard — SIL Open Font License 1.1, 전문은 `src/ui/pretendard-LICENSE.txt`.\n' +
    ' * import 는 없다(값 파일). 쓰는 곳은 `src/ui/fonts.ts` 하나.\n' +
    ' */\n\n' +
    `export const PRETENDARD_VERSION = '${packageVersion()}';\n\n` +
    'export interface PretendardChunk {\n' +
    '  readonly file: string;\n' +
    '  readonly hash: string;\n' +
    '  readonly bytes: number;\n' +
    '  readonly unicodeRange: string;\n' +
    '  readonly base64: string;\n' +
    '}\n\n' +
    'export const PRETENDARD_CHUNKS: readonly PretendardChunk[] = [\n' +
    `${rows}\n` +
    '];\n'
  );
}

/** `src/ui/pretendard-faces.ts` — `PRETENDARD_CHUNKS` 와 같은 순서·값의 메타 표(본문 없음). `src/ui/font-faces.ts` 만 import 한다. */
export function renderFontFaces(): string {
  const rows = parseSubsetCss(packageSubsetCss())
    .map((chunk) => `  { file: '${chunk.file}', hash: '${contentHash(readPackageChunk(chunk.file))}', unicodeRange: '${chunk.unicodeRange}' },`)
    .join('\n');
  return (
    '/**\n' +
    ' * 생성 파일 — 손으로 고치지 않는다. `pnpm gen:fonts`(`scripts/gen-fonts.ts`)가 devDependency `pretendard` 에서 만든다.\n' +
    ` * Pretendard Variable ${packageVersion()} 청크의 메타(파일 · 내용 해시 · unicode-range)만 — 본문(base64)은 \`pretendard-data.ts\` 에 있다.\n` +
    ' * import 는 없다(값 파일). 쓰는 곳은 `src/ui/font-faces.ts` 하나 — 콘솔 번들이 폰트 바이트 없이 `@font-face` 를 만든다.\n' +
    ' */\n\n' +
    'export interface PretendardFace {\n' +
    '  readonly file: string;\n' +
    '  readonly hash: string;\n' +
    '  readonly unicodeRange: string;\n' +
    '}\n\n' +
    'export const PRETENDARD_FACES: readonly PretendardFace[] = [\n' +
    `${rows}\n` +
    '];\n'
  );
}

function main(): void {
  const check = process.argv.includes('--check');
  const outputs: ReadonlyArray<readonly [string, string]> = [
    [FONT_DATA_OUT, renderFontData()],
    [FONT_FACES_OUT, renderFontFaces()],
    [FONT_LICENSE_OUT, packageLicense()],
  ];
  let stale = 0;
  for (const [path, text] of outputs) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = '';
    }
    if (current === text) continue;
    stale += 1;
    if (!check) writeFileSync(path, text);
    console.log(`${check ? '✗ 낡음' : '✓ 씀'}: ${path.slice(REPO_ROOT.length + 1)} (${(Buffer.byteLength(text) / 1024).toFixed(0)} KiB)`);
  }
  if (stale === 0) console.log('✓ 폰트 데이터가 패키지와 같다.');
  if (check && stale > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
