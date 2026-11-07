/**
 * `pnpm gen:blog` — 블로그 원문(`src/site/blog/posts/<slug>/<lang>.md` · `figures/*.svg`)을 검사하고, **공개 글(`draft: false`)만** 값 파일
 * `src/site/blog-data.ts` 로 렌더해 쓴다(사이트 λ 번들은 파일 시스템을 읽지 않는다 — 문서의 `gen:docs` 와 같은 패턴). 생성 파일은 커밋한다.
 * `test/unit/site/blog-build.test.ts` 가 원문에서 다시 만든 결과와 커밋된 파일이 같은지 본다(글을 고치고 이걸 안 돌리면 빨갛다).
 *
 * 검사 항목은 `scripts/blog/build.ts` 머리말. 공개 글의 오류는 종료 코드 1(파일은 그래도 쓴다 — 오류 목록을 보며 고치게). 초안의 오류는 보고만 한다
 * (작성 중) — `--strict` 면 초안 오류도 실패. `--check` 는 쓰지 않고 검사만 한다.
 *
 * 초안은 운영에 나가지 않는다: 값 파일에 없고, 로컬 미리보기(`pnpm ui:preview`)만 원문에서 초안을 포함해 바로 그린다.
 * 스크린샷·OG 카드 바이트는 `pnpm gen:blog-images`(헤드리스 Chrome).
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { SITE_ROUTES } from '../src/site/http';
import { BLOG_DATA_OUT, buildBlog, readBlogSources, rel, renderBlogDataFile } from './blog/build';

function main(): void {
  const check = process.argv.includes('--check');
  const strict = process.argv.includes('--strict');
  const sources = readBlogSources();
  const build = buildBlog(sources, { drafts: false, sitePaths: new Set(Object.keys(SITE_ROUTES)) });
  const drafts = sources.posts.length - build.posts.length;
  if (!check) {
    writeFileSync(BLOG_DATA_OUT, renderBlogDataFile(build.posts));
    console.log(`${rel(BLOG_DATA_OUT)} ← 공개 글 ${String(build.posts.length)}(초안 ${String(drafts)}은 싣지 않음)`);
  }
  for (const w of build.warnings) console.warn(`! ${w}`);
  if (build.draftErrors.length > 0) {
    console.warn(`\n초안 문제 ${String(build.draftErrors.length)}건(공개 전에 고친다):`);
    for (const e of build.draftErrors) console.warn(`  - ${e}`);
  }
  const failed = [...build.errors, ...(strict ? build.draftErrors : [])];
  if (failed.length > 0) {
    console.error(`\n✗ 검증 실패 ${String(failed.length)}건:`);
    for (const e of failed) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log('✓ 검증 통과(머리말 · ko/en 짝 · 링크·앵커 · 그림 · 스크린샷 id · copy-guard)');
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
