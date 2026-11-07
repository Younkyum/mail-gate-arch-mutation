/**
 * `pnpm build:lambda` — `src/runtime/handlers/<name>.ts` 마다 번들 하나 → `dist/lambda/<name>/index.js`.
 * D2(CDK)가 `lambda.Code.fromAsset('dist/lambda/<name>')` + 핸들러 `index.handler` 로 올린다.
 *
 * 판단:
 *   - **ESM** (`format: 'esm'`, 디렉터리마다 `package.json {"type":"module"}`). `db/migrate.ts` 가 top-level await 를
 *     쓰고 `import.meta.url` 로 마이그레이션 디렉터리를 찾는다 — CJS 로는 번들이 안 되거나 경로가 깨진다. CJS 의존성
 *     (`pg` 등)이 부르는 `require` 는 `createRequire` 배너로 준다.
 *   - **`@aws-sdk/*` 를 번들한다**(external 아님). Lambda 런타임 내장 SDK 는 AWS 가 올리는 버전이라 우리 잠금 파일과
 *     갈라진다 — `s3-request-presigner` 를 정확한 버전으로 고정한 이유(서명 규칙)가 운영에서 무너진다. 크기 대가는 받는다.
 *   - `pg-native` 는 external — `pg` 가 네이티브 모드에서만 lazy require 하고, 우리는 쓰지 않는다.
 *   - `node22` 타깃, 압축하지 않는다(스택 추적이 로그에서 읽혀야 한다).
 *   - 핸들러 목록은 **디렉터리에서 읽는다** — 표를 따로 두면 새 핸들러가 번들 없이 배포된다. 계약 목록과 다르면 멈춘다.
 *   - `migrate` 번들 옆에 `migrations/*.sql` 을 복사한다(`MIGRATIONS_DIR` = 번들 파일 옆 `migrations/`).
 *   - 결제(WP-2): `billing-webhook`(VPC 밖 · **DB 0** — `bundle.test.ts` 가 metafile 로 `pg`·`src/db` 0 을 단언) · `billing-sync`(`atmark_billing` 롤).
 *   - **워커 스레드 진입점**(`LAMBDA_WORKER_ENTRIES`): 핸들러가 `new Worker(파일)` 로 띄우는 모듈은 import 그래프에 없어 핸들러 번들에
 *     들어가지 않는다 — 핸들러 번들 **옆에** 같은 설정으로 따로 묶는다(`<entry 이름>.js`). 부르는 쪽은 `import.meta.url`(번들에서는
 *     `index.js`) 옆에서 그 이름을 찾는다. 지금은 api 의 PDF 텍스트 추출(`src/api/pdf-text-worker.ts` — 해석기와 한국어 CMap 을 싣는다;
 *     api 번들 자체에는 해석기가 없다). `bundle.test.ts` 가 그 파일을 만들어 실제로 워커로 띄운다.
 *   - 사용자 문서(`docs`, docs.atmark.ai): 홈과 같은 격리 — DB·비밀·SDK 0(`test/unit/docs/docs-bundle.test.ts`). 콘텐츠는 `src/docs/generated/content.json`
 *     (esbuild 가 JSON 을 모듈로 싣는다), 스크린샷은 `src/docs/generated/shots.ts` 로 번들에 들어간다.
 */

import { copyFileSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build, type BuildOptions } from 'esbuild';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HANDLERS_DIR = join(REPO_ROOT, 'src/runtime/handlers');
const OUT_ROOT = join(REPO_ROOT, 'dist/lambda');
const MIGRATIONS_SRC = join(REPO_ROOT, 'src/db/migrations');

/** D2 와 공유한 계약의 핸들러 이름. 디렉터리와 다르면 빌드를 멈춘다(어느 쪽이 틀렸는지 사람이 정한다). */
export const LAMBDA_HANDLERS: readonly string[] = [
  'admin',
  // ADR-0017 초안 — AI 의심 메일 감시 결과 소비자(롤 atmark_ai_watch · SES 0 · S3 0).
  'ai-watch-result',
  'api',
  'approval-expiry',
  'approval-notifier',
  'approval-release',
  'billing-sync',
  'billing-webhook',
  'contact-forwarder',
  'docs',
  // ADR-0014 단계 2 — 고객 도메인 SES 제어면·DNS·RDAP(DB 없음 · VPC 밖).
  'domain-control',
  // ADR-0014 단계 2 — SES identity 자원 정책 독립 감사(읽기 전용 · DB 없음 · VPC 밖, 보안 리뷰 M2).
  'domain-policy-audit',
  'inbound',
  'login-mailer',
  'migrate',
  'ops',
  'passport-signer',
  // 묶음 E — 실시간 WebSocket(`$connect`·`$disconnect`·`$default`, 앱 롤 · 풀 1 · SES 0 · S3 0).
  'realtime',
  'scheduled-sender',
  'ses-events',
  'site',
  'transparency-anchor',
  'transparency-log',
  'webhook-dispatcher',
];

/** 핸들러 번들 옆에 따로 묶는 워커 스레드 진입점(저장소 기준 경로). 출력 이름은 `<basename>.js`. */
export const LAMBDA_WORKER_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  api: ['src/api/pdf-text-worker.ts'],
};

const REQUIRE_SHIM =
  "import { createRequire as __atmarkCreateRequire } from 'node:module';\n" +
  'const require = __atmarkCreateRequire(import.meta.url);';

/** 번들 설정 — `test/unit/runtime/bundle.test.ts` 가 같은 설정으로 메모리 번들을 만든다(설정이 둘이 되지 않게). */
export function lambdaBuildOptions(name: string): BuildOptions {
  return {
    entryPoints: [join(HANDLERS_DIR, `${name}.ts`)],
    // 번들 속 모듈 경로(`// node_modules/...` 주석 · `__commonJS` 키)는 이 디렉터리 기준 상대 경로다 — cwd 에 기대지 않는다.
    absWorkingDir: REPO_ROOT,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: { js: REQUIRE_SHIM },
    external: ['pg-native'],
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  };
}

/** 워커 진입점 하나의 번들 설정 — 핸들러와 같은 설정, 진입점만 다르다. 출력 파일 이름도 함께. */
export function lambdaWorkerBuildOptions(entry: string): { readonly options: BuildOptions; readonly fileName: string } {
  const fileName = `${basename(entry, '.ts')}.js`;
  return { options: { ...lambdaBuildOptions('api'), entryPoints: [join(REPO_ROOT, entry)] }, fileName };
}

export function discoveredHandlers(): string[] {
  return readdirSync(HANDLERS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => name.slice(0, -'.ts'.length))
    .sort();
}

/**
 * 번들 바이트가 **빌드한 자리에 따라 달라지지 않게** 쓴다(CDK 자산 해시 = 번들 바이트 → 다르면 Lambda 16개가 전부 재배포된다).
 * esbuild 는 모듈 경로를 realpath 기준으로 적는다. `node_modules` 가 저장소 밖을 가리키는 심링크면(본 체크아웃의
 * node_modules 를 빌려 쓰는 git worktree) 경로가 `../../…/Users/<사람>/…/node_modules/…` 가 되어 worktree 깊이·위치가
 * 바이트에 박힌다 — 2026-10-01 운영 번들(worktree 에서 배포)과 CI 번들의 해시가 전부 갈렸던 원인. 그 접두사를
 * `node_modules/` 로 되돌리고(경로는 주석과 `__commonJS` 키 이름에만 쓰인다 — 실행 의미 0), 그래도 저장소 밖 경로가
 * 남으면 멈춘다.
 */
const NODE_MODULES_SEEN_AS = relative(realpathSync(REPO_ROOT), realpathSync(join(REPO_ROOT, 'node_modules')));

async function emit(options: BuildOptions, outfile: string): Promise<void> {
  const result = await build({ ...options, outfile, write: false });
  for (const file of result.outputFiles ?? []) {
    let text = file.text;
    if (NODE_MODULES_SEEN_AS !== 'node_modules') {
      text = text.replaceAll(`${NODE_MODULES_SEEN_AS}/`, 'node_modules/');
    }
    if (/^\/\/ \.\.\//m.test(text)) {
      throw new Error(`${relative(REPO_ROOT, file.path)}: 저장소 밖 경로가 번들에 박혔다(빌드 위치마다 해시가 달라진다)`);
    }
    writeFileSync(file.path, NODE_MODULES_SEEN_AS === 'node_modules' ? file.contents : text);
  }
}

async function bundle(name: string): Promise<number> {
  const outdir = join(OUT_ROOT, name);
  mkdirSync(outdir, { recursive: true });
  await emit(lambdaBuildOptions(name), join(outdir, 'index.js'));
  writeFileSync(join(outdir, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
  for (const entry of LAMBDA_WORKER_ENTRIES[name] ?? []) {
    const worker = lambdaWorkerBuildOptions(entry);
    await emit(worker.options, join(outdir, worker.fileName));
    console.log(`  ${''.padEnd(20)} dist/lambda/${name}/${worker.fileName}  ${(statSync(join(outdir, worker.fileName)).size / 1024).toFixed(0)} KiB`);
  }
  if (name === 'migrate') {
    const target = join(outdir, 'migrations');
    mkdirSync(target, { recursive: true });
    for (const file of readdirSync(MIGRATIONS_SRC).filter((entry) => entry.endsWith('.sql'))) {
      copyFileSync(join(MIGRATIONS_SRC, file), join(target, file));
    }
  }
  return statSync(join(outdir, 'index.js')).size;
}

async function main(): Promise<void> {
  const found = discoveredHandlers();
  if (JSON.stringify(found) !== JSON.stringify([...LAMBDA_HANDLERS].sort())) {
    throw new Error(
      `핸들러 목록 불일치 — 디렉터리: ${found.join(', ')} / 계약: ${[...LAMBDA_HANDLERS].sort().join(', ')}. ` +
        'D2 와 공유한 계약을 바꾸는 일이면 리드에게 올려라.',
    );
  }
  rmSync(OUT_ROOT, { recursive: true, force: true });
  for (const name of found) {
    const bytes = await bundle(name);
    console.log(`  ${name.padEnd(20)} dist/lambda/${name}/index.js  ${(bytes / 1024).toFixed(0)} KiB`);
  }
  console.log(`\n번들 ${String(found.length)}개 → dist/lambda/`);
}

// 직접 실행됐을 때만 돈다(테스트가 설정을 import 한다).
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    console.error('✗ build:lambda 실패:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
