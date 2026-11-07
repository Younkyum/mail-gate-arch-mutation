/**
 * 모듈 단위 테스트 실행기 — `pnpm test:mod <모듈…>` · `pnpm test:changed`.
 *
 *   pnpm test:mod admin policy        admin·policy 모듈의 unit → arch → integration 테스트만
 *   pnpm test:mod --list              모듈 목록과 각 모듈의 테스트 파일 수
 *   pnpm test:changed                 HEAD 대비 바뀐 파일(스테이징·워킹트리·미추적)에서 모듈을 골라 돌린다
 *   pnpm test:changed --base=main     비교 기준을 바꾼다
 *   pnpm test:mod --core              핵심 테스트(`CORE_TESTS`)만 — unit → arch → integration → sdk
 *   … --dry                           고른 파일만 출력하고 돌리지 않는다
 *   … -- <vitest 인자>                 `--` 뒤는 vitest 에 그대로 넘긴다 (예: `-- --reporter=verbose`)
 *
 * 프로젝트를 순서대로 돌리고 앞이 빨강이면 멈춘다. integration 워커는 2. 모듈 지도는 `test/modules.ts`.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { allTestFiles, CORE_TESTS, MODULE_NAMES, MODULES, projectOf, REPO_ROOT, selectForChanged, testsOfModule, type ModuleName, type Project } from './modules';

const PROJECTS: readonly Project[] = ['unit', 'arch', 'integration'];
const VITEST_CLI = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(2);
}

function git(args: readonly string[]): string[] {
  const result = spawnSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) fail(`git ${args.join(' ')} 실패: ${result.stderr}`);
  return result.stdout.split('\n').filter((line) => line.length > 0);
}

function changedPaths(base: string): string[] {
  return [...new Set([...git(['diff', '--name-only', base]), ...git(['ls-files', '--others', '--exclude-standard'])])].sort();
}

function runProject(project: Project, files: readonly string[], passthrough: readonly string[]): boolean {
  const workers = project === 'integration' ? ['--maxWorkers=2'] : [];
  // tlog 통합 파일은 순차 프로젝트 `integration-tlog` 에 있다(vitest.config.ts) — 통합을 돌 때 함께 고른다.
  const projects = project === 'integration' ? ['--project', 'integration', '--project', 'integration-tlog'] : ['--project', project];
  console.log(`\n▶ ${project} — 파일 ${files.length}개`);
  const result = spawnSync(process.execPath, [VITEST_CLI, 'run', ...projects, ...workers, ...passthrough, ...files], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.signal !== null) process.exit(1);
  return result.status === 0;
}

function main(): void {
  const argv = process.argv.slice(2);
  const dashDash = argv.indexOf('--');
  const own = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const passthrough = dashDash === -1 ? [] : argv.slice(dashDash + 1);

  if (own.includes('--list')) {
    const files = allTestFiles();
    for (const name of MODULE_NAMES) console.log(`${name.padEnd(14)} ${String(testsOfModule(name, files).length).padStart(3)} 파일`);
    return;
  }

  const core = own.includes('--core');
  let files: string[];
  if (core) {
    files = [...CORE_TESTS];
    console.log(`핵심 테스트 ${files.length}개`);
  } else if (own.includes('--changed')) {
    const base = own.find((arg) => arg.startsWith('--base='))?.slice('--base='.length) ?? 'HEAD';
    const changed = changedPaths(base);
    const selection = selectForChanged(changed);
    console.log(`바뀐 파일 ${changed.length}개 (기준 ${base})`);
    if (selection.everything) console.log('  전역 설정(package.json·vitest·tsconfig·arch 공용 도구)이 바뀌었다 → 전부 돌린다');
    else {
      console.log(`  모듈: ${selection.modules.join(', ') || '(없음)'}`);
      if (selection.extraTests.length > 0) console.log(`  직접 고른 테스트: ${selection.extraTests.join(', ')}`);
      if (selection.ignored.length > 0) console.log(`  모듈 밖이라 무시: ${selection.ignored.join(', ')}`);
    }
    files = [...selection.files];
  } else {
    const names = own.filter((arg) => !arg.startsWith('--'));
    if (names.length === 0) fail(`모듈을 하나 이상 적는다: ${MODULE_NAMES.join(' ')}  (또는 --list · --changed · --core)`);
    const unknown = names.filter((name) => !(name in MODULES));
    if (unknown.length > 0) fail(`모르는 모듈: ${unknown.join(', ')}. 있는 모듈: ${MODULE_NAMES.join(' ')}`);
    const all = allTestFiles();
    files = [...new Set(names.flatMap((name) => testsOfModule(name as ModuleName, all)))].sort();
    console.log(`모듈: ${names.join(', ')}`);
  }

  if (files.length === 0) {
    console.log('✓ 돌릴 테스트가 없다.');
    return;
  }

  // sdk 파일은 `CORE_TESTS` 에만 있다 — 모듈·changed 출력은 세 프로젝트 그대로.
  const projects: readonly Project[] = core ? [...PROJECTS, 'sdk'] : PROJECTS;
  if (own.includes('--dry')) {
    for (const project of projects) {
      const selected = files.filter((file) => projectOf(file) === project);
      console.log(`${project} (${selected.length}):\n${selected.map((file) => `  ${file}`).join('\n')}`);
    }
    return;
  }

  for (const project of projects) {
    const selected = files.filter((file) => projectOf(file) === project);
    if (selected.length === 0) continue;
    if (!runProject(project, selected, passthrough)) {
      console.error(`\n✗ ${project} 빨강 — 뒤 프로젝트는 돌리지 않는다.`);
      process.exit(1);
    }
  }
  console.log(`\n✓ 테스트 파일 ${files.length}개 green`);
}

main();
