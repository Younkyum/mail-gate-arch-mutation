/**
 * **고객 도메인 확인 틱의 경계**(ADR-0014 결정 12 · 단계 4).
 *
 *   ① 틱(`runDomainTick`)을 값으로 import 하는 src 파일은 admin λ 핸들러 하나다 — 스케줄러 과제(`{task:'domain-recheck'}`)만 틱을 돈다. 그 함수를
 *      부를 수 있는 런타임 역할이 Scheduler 뿐이라는 것은 인프라 테스트(`compute-stack.test.ts` "admin 함수를 부를 수 있는 런타임 역할은 없다")가 본다.
 *   ② 틱 롤 비밀(`RUNTIME_ENV.dbDomainTickSecretArn`)을 읽는 src 파일은 admin 조립(틱 풀)과 migrate 조립(bootstrap-roles 가 채운다) 둘이다.
 *   ③ 앵커를 넣는 정의자 함수(`atmark_provision_custom_primary`)를 부르는 src 파일은 `src/identity/primary.ts` 하나다(재시도 · 이름 공간 규율이 거기 있다).
 *   ④ 상태를 바꾸는 틱 저장소 쓰기(`updateRow`)는 수명주기 파일만 부른다 — 콘솔 경로(`src/admin/**`)가 틱 패치를 만들지 않는다.
 * **비공허:** 각 목록이 실제로 비어 있지 않다.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { getProject, repoPath, toRepoRelative } from './support/project';

function srcFiles(): { path: string; text: string }[] {
  return getProject()
    .getSourceFiles()
    .map((file) => ({ path: toRepoRelative(file.getFilePath()), text: file.getFullText() }))
    .filter((file) => file.path.startsWith('src/'));
}

/** `from` 파일을 `name` 으로 값 import 하는 파일들. */
function importers(definingFile: string, name: string): string[] {
  const found: string[] = [];
  for (const file of getProject().getSourceFiles()) {
    const path = toRepoRelative(file.getFilePath());
    for (const declaration of file.getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (target === undefined || toRepoRelative(target.getFilePath()) !== definingFile || declaration.isTypeOnly()) continue;
      if (declaration.getNamedImports().some((named) => !named.isTypeOnly() && named.getName() === name)) found.push(path);
    }
  }
  return found.sort();
}

describe('확인 틱 경계', () => {
  it('① runDomainTick 은 admin 핸들러만(src) — 테스트 밖 소비자 하나', () => {
    const consumers = importers('src/domains/lifecycle.ts', 'runDomainTick').filter((path) => path.startsWith('src/'));
    expect(consumers).toEqual(['src/runtime/handlers/admin.ts']);
  });

  it('② 틱 롤 비밀은 admin 조립(틱 풀)과 migrate 조립(bootstrap-roles)만 읽는다', () => {
    const readers = srcFiles()
      .filter((file) => file.path !== 'src/runtime/config.ts' && /RUNTIME_ENV\.dbDomainTickSecretArn/.test(file.text))
      .map((file) => file.path)
      .sort();
    expect(readers).toEqual(['src/runtime/admin-composition.ts', 'src/runtime/composition.ts']);
    // migrate 쪽은 롤 부트스트랩(쓰기) 경로다 — 그 파일에서 틱 롤로 풀을 열지 않는다.
    expect(readFileSync(repoPath('src/runtime/composition.ts'), 'utf8')).not.toMatch(/DOMAIN_TICK_POOL_MAX/);
  });

  it('③ atmark_provision_custom_primary 는 src/identity/primary.ts 만 부른다', () => {
    const callers = srcFiles()
      .filter((file) => file.text.includes('atmark_provision_custom_primary('))
      .map((file) => file.path);
    expect(callers).toEqual(['src/identity/primary.ts']);
  });

  it('④ 틱 패치(updateRow)는 수명주기만 — 콘솔 경로는 상태 칸을 만들지 않는다', () => {
    expect(importers('src/domains/store.ts', 'updateRow').filter((path) => path.startsWith('src/'))).toEqual(['src/domains/lifecycle.ts']);
  });
});
