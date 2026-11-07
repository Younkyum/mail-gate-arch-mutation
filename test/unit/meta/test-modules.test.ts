/**
 * 테스트 모듈 지도(`test/modules.ts`)의 빈틈 검사 — `pnpm test:mod`·`pnpm test:changed` 로 **영영 돌지 않는 테스트**가 없어야 한다.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { allTestFiles, CORE_TESTS, MODULE_NAMES, MODULES, modulesOfPath, projectOf, REPO_ROOT, selectForChanged, testsOfModule, type TestModule } from '../../modules';

describe('테스트 모듈 지도', () => {
  const files = allTestFiles();

  it('모든 .test.ts 는 적어도 한 모듈에 속한다', () => {
    const covered = new Set(MODULE_NAMES.flatMap((name) => testsOfModule(name, files)));
    expect(files.length).toBeGreaterThan(200);
    expect(files.filter((file) => !covered.has(file))).toEqual([]);
  });

  it('모든 .test.ts 는 unit · arch · integration 중 한 프로젝트에 속한다 (vitest.workspace.ts 의 글롭과 같다)', () => {
    expect(files.filter((file) => projectOf(file) === undefined)).toEqual([]);
  });

  it('src 의 최상위 디렉터리는 전부 어떤 모듈의 소스다', () => {
    const dirs = readdirSync(join(REPO_ROOT, 'src'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `src/${entry.name}/x.ts`);
    expect(dirs.filter((path) => modulesOfPath(path).length === 0)).toEqual([]);
  });

  it('지도에 죽은 항목이 없다 — 테스트 접두사는 파일을 하나 이상 고르고, arch 항목과 소스 경로는 실재한다', () => {
    const dead: string[] = [];
    for (const name of MODULE_NAMES) {
      const module: TestModule = MODULES[name];
      for (const prefix of module.tests) if (!files.some((file) => file.startsWith(prefix))) dead.push(`${name}.tests: ${prefix}`);
      for (const file of module.arch) if (!files.includes(file)) dead.push(`${name}.arch: ${file}`);
      for (const source of module.sources) {
        const exists = existsSync(join(REPO_ROOT, source)) || readdirSync(join(REPO_ROOT, source, '..')).some((entry) => `${source.replace(/[^/]*$/, '')}${entry}`.startsWith(source));
        if (!exists) dead.push(`${name}.sources: ${source}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it('CORE_TESTS 는 모두 실재하고, sdk 밖의 경로는 어느 모듈에 속한다', () => {
    const covered = new Set(MODULE_NAMES.flatMap((name) => testsOfModule(name, files)));
    expect(new Set(CORE_TESTS).size).toBe(CORE_TESTS.length);
    expect(CORE_TESTS.filter((path) => !existsSync(join(REPO_ROOT, path)))).toEqual([]);
    expect(CORE_TESTS.filter((path) => projectOf(path) === undefined)).toEqual([]);
    expect(CORE_TESTS.filter((path) => projectOf(path) !== 'sdk' && !covered.has(path))).toEqual([]);
  });

  it('바뀐 파일 → 모듈: 소스는 그 모듈 · 테스트는 그 파일만 · 전역 설정은 전부 · 문서는 무시', () => {
    const policy = selectForChanged(['src/policy/gate.ts']);
    expect(policy.everything).toBe(false);
    expect(policy.modules).toEqual(['policy']);
    expect(policy.files).toEqual(expect.arrayContaining(['test/arch/deny-all-matrix.arch.test.ts']));
    expect(policy.files.some((file) => file.startsWith('test/unit/policy/'))).toBe(true);
    expect(policy.files.some((file) => file.startsWith('test/unit/admin/'))).toBe(false);

    const single = selectForChanged(['test/unit/admin/admin-ui.test.ts']);
    expect(single.modules).toEqual([]);
    expect(single.files).toEqual(['test/unit/admin/admin-ui.test.ts']);

    expect(selectForChanged(['vitest.config.ts']).everything).toBe(true);
    expect(selectForChanged(['docs/runbooks/deploy.md']).ignored).toEqual(['docs/runbooks/deploy.md']);
  });
});
