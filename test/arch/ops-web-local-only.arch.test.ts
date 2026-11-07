/**
 * **운영자 웹 화면은 로컬 전용이다**(`pnpm admin:web` — `scripts/ops-web/**` · `scripts/admin/web.ts`). 소유자 롤·결제 운영자 롤을 쥐는 표면이
 * 인터넷에 나가는 길이 코드에 없어야 한다.
 *
 *   ① `src/**` 의 어떤 파일도 `scripts/**` 를 import 하지 않는다 — 그래서 Lambda 번들(`src/runtime/handlers/*` 의 import 폐포)에 ops-web 이
 *      들어갈 수 없다(비공허: 핸들러 폐포를 실제로 훑어 `scripts/` 가 0 임을 본다).
 *   ② 번들러(`scripts/build-lambda.ts`)의 입구는 `src/runtime/handlers` 뿐이다.
 *   ③ 인프라(`infra/**`)가 ops-web·admin:web 을 언급하지 않는다(라우트·함수·배포 없음).
 *   ④ 서버는 `BIND_HOST`(= 127.0.0.1)에만 `listen` 한다 — 다른 호스트 리터럴·와일드카드 주소가 소스에 없다.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { SourceFile } from 'ts-morph';

import { BIND_HOST } from '../../scripts/ops-web/security';
import { getProject, listTsFilesUnder, repoPath, toRepoRelative } from './support/project';

function importTargets(file: SourceFile): string[] {
  const out: string[] = [];
  for (const declaration of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
    const target = declaration.getModuleSpecifierSourceFile();
    if (target !== undefined) out.push(toRepoRelative(target.getFilePath()));
  }
  // 동적 import('…') 도 본다(문자열로 — 모든 노드를 훑지 않는다).
  for (const match of file.getFullText().matchAll(/import\(\s*['"`]([^'"`]+)['"`]/g)) out.push(match[1] as string);
  return out;
}

describe('운영자 웹 화면 — 로컬 전용', () => {
  it('① src/** 는 scripts/** 를 import 하지 않는다 · 핸들러 폐포에 scripts/ 가 없다', () => {
    const project = getProject();
    const srcFiles = project.getSourceFiles().filter((file) => toRepoRelative(file.getFilePath()).startsWith('src/'));
    expect(srcFiles.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const file of srcFiles) {
      for (const target of importTargets(file)) {
        if (target.startsWith('scripts/') || /scripts\/|ops-web/.test(target)) offenders.push(`${toRepoRelative(file.getFilePath())} → ${target}`);
      }
    }
    expect(offenders).toEqual([]);

    // 비공허: 핸들러 폐포를 훑는다(런타임 import 만).
    const handlers = listTsFilesUnder('src/runtime/handlers');
    expect(handlers.length).toBeGreaterThan(5);
    const byPath = new Map(project.getSourceFiles().map((file) => [toRepoRelative(file.getFilePath()), file]));
    const seen = new Set<string>();
    const queue = [...handlers];
    while (queue.length > 0) {
      const path = queue.pop() as string;
      if (seen.has(path)) continue;
      seen.add(path);
      const file = byPath.get(path);
      if (file === undefined) continue;
      for (const declaration of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
        const target = declaration.getModuleSpecifierSourceFile();
        if (target !== undefined) queue.push(toRepoRelative(target.getFilePath()));
      }
    }
    expect(seen.has('src/runtime/handlers/admin.ts')).toBe(true);
    expect([...seen].filter((path) => !path.startsWith('src/') && !path.includes('node_modules'))).toEqual([]);
  });

  it('② Lambda 번들 입구는 src/runtime/handlers 뿐', () => {
    const build = readFileSync(repoPath('scripts/build-lambda.ts'), 'utf8');
    expect(build).toContain("join(REPO_ROOT, 'src/runtime/handlers')");
    expect(build).not.toMatch(/ops-web|scripts\/admin/);
  });

  it('③ 인프라는 ops-web·admin:web 을 모른다', () => {
    const infra = listTsFilesUnder('infra');
    expect(infra.length).toBeGreaterThan(3);
    for (const path of infra) {
      expect(readFileSync(repoPath(path), 'utf8'), path).not.toMatch(/ops-web|admin:web|scripts\/admin\/web|scripts\/admin\/ops|ui:ops/);
    }
  });

  it('④ 127.0.0.1 에만 listen — 와일드카드·다른 호스트 리터럴 없음', () => {
    expect(BIND_HOST).toBe('127.0.0.1');
    // `pnpm ops`(터널 + 화면)와 가짜 데이터 미리보기(`ui:ops`)도 같은 규칙 — 루프백 말고 묶는 길이 없다.
    const files = [...listTsFilesUnder('scripts/ops-web'), 'scripts/admin/web.ts', 'scripts/admin/ops.ts', 'scripts/ui/ops-preview.ts'];
    expect(files).toContain('scripts/ops-web/server.ts');
    const server = readFileSync(repoPath('scripts/ops-web/server.ts'), 'utf8');
    expect(server).toMatch(/server\.listen\(\{ port: options\.port, host: BIND_HOST, exclusive: true \}/);
    expect(server.match(/\.listen\(/g)).toHaveLength(1);
    for (const path of files) {
      const source = readFileSync(repoPath(path), 'utf8');
      expect(source, path).not.toMatch(/0\.0\.0\.0|'::'|"::"|INADDR_ANY/);
    }
  });
});
