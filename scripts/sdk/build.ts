/**
 * `pnpm sdk:build` — 두 SDK 의 게시용 산출물을 `sdk/dist/` 에 만든다(게시는 하지 않는다).
 *
 *   - TypeScript: `sdk/typescript/dist` 를 새로 빌드(tsc) → `npm pack` → `sdk/dist/atmark-sdk-<v>.tgz`.
 *   - Python: 버리는 venv(`.omc/state/sdk/venv`, build · twine)에서 `python -m build` → `sdk/dist/atmark_sdk-<v>.tar.gz` · `…-py3-none-any.whl`.
 *
 * 확인은 `pnpm sdk:verify`. 런북 `docs/runbooks/sdk-publish.md`.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { artifactNames, basePython, OUT_DIR, PY_DIR, ROOT, run, step, TOOLS_PYTHON, TOOLS_VENV, TS_DIR } from './common';

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

step('TypeScript — tsc → sdk/typescript/dist');
rmSync(join(TS_DIR, 'dist'), { recursive: true, force: true });
run(join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', join(TS_DIR, 'tsconfig.json')]);

step('TypeScript — npm pack → sdk/dist');
// 방금 빌드했으니 prepack(같은 tsc)은 건너뛴다. 게시(`npm publish`) 때는 prepack 이 다시 빌드한다.
run('npm', ['pack', '--ignore-scripts', '--pack-destination', OUT_DIR], { cwd: TS_DIR });

step(`Python — 빌드 도구 venv (${TOOLS_VENV})`);
if (!existsSync(TOOLS_PYTHON)) run(basePython(), ['-m', 'venv', TOOLS_VENV]);
run(TOOLS_PYTHON, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--upgrade', 'build', 'twine']);

step('Python — sdist · wheel → sdk/dist');
for (const leftover of ['build', join('src', 'atmark_sdk.egg-info')]) rmSync(join(PY_DIR, leftover), { recursive: true, force: true });
run(TOOLS_PYTHON, ['-m', 'build', '--sdist', '--wheel', '--outdir', OUT_DIR, PY_DIR]);
for (const leftover of ['build', join('src', 'atmark_sdk.egg-info')]) rmSync(join(PY_DIR, leftover), { recursive: true, force: true });

const expected = artifactNames();
const built = readdirSync(OUT_DIR).sort();
for (const name of [expected.tarball, expected.sdist, expected.wheel]) {
  if (!built.includes(name)) throw new Error(`산출물이 없다: ${name} (있는 것: ${built.join(', ')})`);
}
process.stdout.write(`\n✓ sdk/dist: ${built.join(' · ')}\n  다음: pnpm sdk:verify\n`);
