/**
 * scripts/sdk/common.ts — `pnpm sdk:build` · `pnpm sdk:verify` 가 같이 쓰는 경로와 실행 도우미.
 *
 * 산출물은 `sdk/dist/`(gitignore `dist/`). Python 빌드 도구(build · twine)는 리포 밖으로 새지 않게 `.omc/state/sdk/venv` 의
 * 버리는 venv 에 둔다(`.omc/state/` 는 gitignore). 게시(`npm publish` · `twine upload`)는 이 스크립트가 하지 않는다 — 진윤겸이 자기 기기·계정으로
 * 한다(런북 `docs/runbooks/sdk-publish.md`).
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TS_DIR = join(ROOT, 'sdk', 'typescript');
export const PY_DIR = join(ROOT, 'sdk', 'python');
export const OUT_DIR = join(ROOT, 'sdk', 'dist');
export const TOOLS_VENV = join(ROOT, '.omc', 'state', 'sdk', 'venv');
export const TOOLS_PYTHON = join(TOOLS_VENV, 'bin', 'python');

/** Python 실행 파일 — `ATMARK_PYTHON` 이 있으면 그것, 없으면 Homebrew 의 것, 그것도 없으면 PATH 의 `python3`. */
export function basePython(): string {
  const fromEnv = process.env['ATMARK_PYTHON'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return existsSync('/opt/homebrew/bin/python3') ? '/opt/homebrew/bin/python3' : 'python3';
}

export function run(command: string, args: readonly string[], options: ExecFileSyncOptions = {}): void {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

export function capture(command: string, args: readonly string[], options: ExecFileSyncOptions = {}): string {
  return execFileSync(command, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options }).toString();
}

interface TsPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
}

export function tsPackage(): TsPackage {
  return JSON.parse(readFileSync(join(TS_DIR, 'package.json'), 'utf8')) as TsPackage;
}

/** `pyproject.toml` 의 `[project]` 한 줄 값(name · version · license) — 3.9 의 표준 라이브러리에 TOML 파서가 없어 정규식으로 읽는다. */
export function pyField(name: string): string {
  const match = new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm').exec(readFileSync(join(PY_DIR, 'pyproject.toml'), 'utf8'));
  if (match?.[1] === undefined) throw new Error(`pyproject.toml 에 ${name} 이 없다`);
  return match[1];
}

/** 산출물 이름 — npm 은 `atmark-sdk` → `atmark-sdk-<v>.tgz`, Python 은 정규화된 이름 `atmark_sdk-<v>`. */
export function artifactNames(): { readonly tarball: string; readonly wheel: string; readonly sdist: string } {
  const ts = tsPackage();
  const tarball = `${ts.name.replace(/^@/, '').replace('/', '-')}-${ts.version}.tgz`;
  const py = `${pyField('name').replace(/[-.]+/g, '_')}-${pyField('version')}`;
  return { tarball, wheel: `${py}-py3-none-any.whl`, sdist: `${py}.tar.gz` };
}

export function step(title: string): void {
  process.stdout.write(`\n▶ ${title}\n`);
}
