/**
 * arch 테스트 공용 지반 — ts-morph Project 로딩과 경로 정규화.
 *
 * Project 를 층마다 새로 만들면 같은 소스를 6번 파싱한다. 모듈 수준에서 한 번 만들고
 * 재사용한다(vitest 는 파일별로 모듈을 격리하므로 층당 1회가 된다).
 *
 * **이 파일은 단언을 하지 않는다.** 단언은 각 층의 테스트 파일에 있고, 여기에는
 * "무엇을 읽는가"만 있다 — 공용 헬퍼에 단언이 섞이면 어느 층이 무엇을 증명하는지가
 * 흐려지고, 그게 Layer C 가 한 번 잘못 구현됐던 방식이다.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project, type SourceFile } from 'ts-morph';

/** `test/arch/support/project.ts` → 리포 루트. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let cached: Project | undefined;

/** tsconfig 기반 ts-morph Project. 층 간 공유한다. */
export function getProject(): Project {
  cached ??= new Project({
    tsConfigFilePath: join(REPO_ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: false,
  });
  return cached;
}

/** 절대 경로 → 리포 루트 기준 POSIX 상대 경로. 매니페스트의 `file` 과 같은 표기. */
export function toRepoRelative(absolutePath: string): string {
  return relative(REPO_ROOT, absolutePath).split(sep).join('/');
}

export function repoPath(...segments: readonly string[]): string {
  return join(REPO_ROOT, ...segments);
}

export function repoFileExists(relativePath: string): boolean {
  return existsSync(repoPath(relativePath));
}

/**
 * 디렉터리 하위의 `.ts` 파일을 재귀 수집한다(리포 상대 경로).
 * 디렉터리가 없으면 빈 배열 — **P1a 에서 `src/api/routes` 는 아직 없다.**
 * 그 경우 대상 0건이 되며, 그 공허함을 Layer F 가 별도로 감시한다.
 */
export function listTsFilesUnder(relativeDir: string): string[] {
  const absolute = repoPath(relativeDir);
  if (!existsSync(absolute)) return [];

  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(toRepoRelative(full));
    }
  };
  walk(absolute);
  return out.sort();
}

/** SourceFile 의 import 선언 모듈 스펙 전체(정적 import + `export ... from`). */
export function moduleSpecifiersOf(sourceFile: SourceFile): string[] {
  return [
    ...sourceFile.getImportDeclarations().map((d) => d.getModuleSpecifierValue()),
    ...sourceFile.getExportDeclarations().map((d) => d.getModuleSpecifierValue() ?? ''),
  ].filter((s) => s.length > 0);
}

/**
 * `sourceFile` 이 리포 상대 경로 `targetRelative` 모듈을 정적 import 하는가.
 * 모듈 스펙을 해석한 실제 파일로 비교한다 — 상대 경로 표기(`../policy/gate.js` 등)에
 * 흔들리지 않게 하기 위해서다.
 */
export function importsModule(sourceFile: SourceFile, targetRelative: string): boolean {
  for (const declaration of sourceFile.getImportDeclarations()) {
    const resolved = declaration.getModuleSpecifierSourceFile();
    if (resolved && toRepoRelative(resolved.getFilePath()) === targetRelative) return true;
  }
  return false;
}

/** ts-morph 가 로드한 `src/**` 소스 파일. */
export function srcSourceFiles(): SourceFile[] {
  return getProject()
    .getSourceFiles()
    .filter((f) => toRepoRelative(f.getFilePath()).startsWith('src/'));
}
