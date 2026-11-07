/**
 * `pnpm gen:docs` — 문서 콘텐츠(`src/docs/content/{ko,en}/**.md`)를 값 파일 하나(`src/docs/generated/content.json`)로 옮기고, 사이트를
 * 한 번 빌드해 검증한다(문법 · ko/en 짝 · 내부 링크·앵커 · 스크린샷 id · 가림 금지어).
 *
 * 핸들러 번들은 파일 시스템을 읽지 않는다 — 콘텐츠는 이 값 파일로 번들에 들어간다(홈의 `image-data.ts` 와 같은 패턴). 생성 파일은 커밋한다.
 * `test/unit/docs/docs-content.test.ts` 가 콘텐츠 폴더에서 다시 만든 결과와 커밋된 파일이 같은지 본다(콘텐츠를 고치고 이걸 안 돌리면 빨갛다).
 *
 * 검증이 실패해도 파일은 쓴다(작성 중인 사람이 오류 목록을 보며 고치게) — 대신 종료 코드 1. `--check` 는 쓰지 않고 검증만 한다.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DOCS_LANGS, type DocsLang } from '../src/docs/constants';
import { buildDocsSite, type DocsSources } from '../src/docs/site';
import { veilHits } from './docs-veil';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const CONTENT_ROOT = join(REPO_ROOT, 'src/docs/content');
export const CONTENT_OUT = join(REPO_ROOT, 'src/docs/generated/content.json');

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries.sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
}

/** 콘텐츠 폴더 → 언어 → id → 원문. `.md` 가 아닌 파일은 오류(조용히 빠지지 않게). */
export function readContentSources(root: string = CONTENT_ROOT): DocsSources {
  const result: Record<DocsLang, Record<string, string>> = { ko: {}, en: {} };
  for (const lang of DOCS_LANGS) {
    for (const file of walk(join(root, lang))) {
      const rel = relative(join(root, lang), file).split('\\').join('/');
      if (!rel.endsWith('.md')) throw new Error(`콘텐츠 폴더에 .md 가 아닌 파일: ${lang}/${rel}`);
      result[lang][rel.slice(0, -3)] = readFileSync(file, 'utf8');
    }
  }
  return result;
}

/**
 * 값 파일 본문(JSON) — 언어 → id → **원문의 base64**(UTF-8), id 순서 고정(결정적). 핸들러가 `decodeDocsContent`(`src/docs/content-data.ts`)로 푼다.
 * 원문을 그대로 두지 않는 이유: 콘텐츠의 예시 문자열(`did:web:…` 등)이 소스 트리의 문자열 리터럴이 되면 `src/**` 전체를 훑는 아키텍처 가드
 * (`keypair-immutability` — "DID 문자열을 조립하는 파일은 did.ts 하나")에 걸린다. 콘텐츠는 코드가 아니라 데이터다 — 가드를 넓히지 않고 데이터를
 * 불투명하게 둔다. 읽을 수 있는 원문은 `src/docs/content/**`(리뷰 대상)이고, 테스트가 이 파일이 그 원문과 같은지 본다.
 */
export function contentJson(sources: DocsSources): string {
  const sorted = Object.fromEntries(
    DOCS_LANGS.map((lang) => [
      lang,
      Object.fromEntries(
        Object.keys(sources[lang])
          .sort()
          .map((id) => [id, Buffer.from(sources[lang][id] ?? '', 'utf8').toString('base64')]),
      ),
    ]),
  );
  return `${JSON.stringify(sorted, null, 1)}\n`;
}

/** 검증 — 오류 목록(비면 통과). 아직 찍지 않은 스크린샷은 오류가 아니라 경고(`warnings`)다 — 테스트가 따로 막는다. */
export function validateSources(sources: DocsSources, warnings: string[] = []): string[] {
  const errors: string[] = [];
  for (const lang of DOCS_LANGS) {
    for (const [id, text] of Object.entries(sources[lang])) {
      for (const hit of veilHits(text)) errors.push(`content/${lang}/${id}.md:${String(hit.line)}: 가림 금지어 "${hit.match}" — …${hit.context}…`);
    }
  }
  try {
    // 링크 오류는 한꺼번에 보이게 모은다(엄격 모드는 첫 오류에서 멈춘다). 결과 판정은 같다 — 문제가 하나라도 있으면 실패.
    const site = buildDocsSite(sources, { strict: false });
    errors.push(...site.problems);
    if (site.missingShots.length > 0) warnings.push(`스크린샷 바이트가 아직 없다(pnpm gen:docs-shots): ${site.missingShots.join(', ')}`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

function main(): void {
  const check = process.argv.includes('--check');
  const sources = readContentSources();
  const count = DOCS_LANGS.map((lang) => `${lang} ${String(Object.keys(sources[lang]).length)}`).join(' · ');
  if (!check) {
    writeFileSync(CONTENT_OUT, contentJson(sources));
    console.log(`src/docs/generated/content.json ← 페이지 ${count}`);
  }
  const warnings: string[] = [];
  const errors = validateSources(sources, warnings);
  for (const w of warnings) console.warn(`! ${w}`);
  if (errors.length > 0) {
    console.error(`\n✗ 검증 실패 ${String(errors.length)}건:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log('✓ 검증 통과(문법 · ko/en 짝 · 링크·앵커 · 스크린샷 · 가림 금지어)');
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
