/**
 * `pnpm ai-watch:bundle` — 워커를 파일 하나로(`ops/ai-watch/dist/worker.mjs`). `setup.sh` 가 이 파일 + `models.lock` + 네이티브
 * `node_modules`(hoisted — `pnpm --dir ops/ai-watch install`)를 `/Library/Application Support/AtmarkAiWatch/app/` 로 복사한다.
 *
 * 계약(`src/inbound/ai-watch/contract.ts`)과 `@aws-sdk/client-sqs` 는 번들에 들어가고, 네이티브 둘(`onnxruntime-node`·`tokenizers`)은
 * external — `model.ts` 가 동적 import 로 연다. Lambda 번들(`scripts/build-lambda.ts`)과 설정을 맞춘다(ESM · node22 · 압축 없음).
 */

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const AI_WATCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const OUT = join(AI_WATCH_DIR, 'dist', 'worker.mjs');

mkdirSync(dirname(OUT), { recursive: true });
const result = await build({
  entryPoints: [join(AI_WATCH_DIR, 'worker', 'main.ts')],
  absWorkingDir: resolve(AI_WATCH_DIR, '..', '..'),
  outfile: OUT,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: "import { createRequire as __atmarkCreateRequire } from 'node:module';\nconst require = __atmarkCreateRequire(import.meta.url);" },
  external: ['onnxruntime-node', 'tokenizers'],
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});
const inputs = Object.keys(result.metafile.inputs);
// 모델 런타임 · DB · 다른 AWS 서비스가 번들로 새지 않았는가(워커 권한 = SQS 둘).
const forbidden = inputs.filter((path) => /node_modules\/(pg|@aws-sdk\/client-(?!sqs)[a-z0-9-]+)\//.test(path) || /^src\/(db|runtime|gate|policy)\//.test(path));
if (forbidden.length > 0) {
  console.error(`✗ 워커 번들에 들어오면 안 되는 모듈: ${forbidden.slice(0, 5).join(', ')}`);
  process.exit(1);
}
console.log(`✓ ${OUT.slice(AI_WATCH_DIR.length + 1)} (${String(inputs.length)} inputs)`);
