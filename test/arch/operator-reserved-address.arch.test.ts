/**
 * **운영자 예약 주소의 브랜드는 운영자 CLI 만 만든다**(2026-09-30, 202609301500).
 *
 * `buildOperatorReservedAddress`(`src/identity/address.ts`)는 예약 로컬파트 판정을 건너뛰는 유일한 길이다(`support@`·`onve@`·`abuse@`·`postmaster@atmark.ai`).
 * 이 함수를 값으로 import 하는 파일은 `scripts/admin/reserved-address.ts` 하나여야 한다 — 콘솔·API·운영자 콘솔·MCP(`src/admin`·`src/api`·`src/ops`·
 * `src/mcp`)는 **타입**(`OperatorReservedAddress`)만 쓴다. 브랜드를 `as` 로 위조하는 곳도 없어야 한다. DB 는 따로 운영자 허가 행을 요구한다
 * (`agent_addresses_operator_grant_guard`) — 이 층은 코드 표면이 넓어지지 않게 한다.
 *
 * **비공허:** CLI 가 실제로 import 해야 한다(입구가 사라지면 금지 목록이 빈 집합과 비교하며 영원히 초록이 된다).
 */

import { SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import { getProject, toRepoRelative } from './support/project';

const DEFINING_FILE = 'src/identity/address.ts';
const CLI_FILE = 'scripts/admin/reserved-address.ts';
const FORBIDDEN_DIRS = ['src/admin/', 'src/api/', 'src/ops/', 'src/mcp/'];
const BUILDER = 'buildOperatorReservedAddress';
const BRAND = 'OperatorReservedAddress';

/** 파일이 `src/identity/address.ts` 에서 `name` 을 **값으로** import 하는가(타입 전용 import 제외). */
function valueImports(name: string): string[] {
  const importers: string[] = [];
  for (const file of getProject().getSourceFiles()) {
    const path = toRepoRelative(file.getFilePath());
    for (const declaration of file.getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (target === undefined || toRepoRelative(target.getFilePath()) !== DEFINING_FILE) continue;
      if (declaration.isTypeOnly()) continue;
      if (declaration.getNamespaceImport() !== undefined) importers.push(`${path} (namespace)`);
      if (declaration.getNamedImports().some((named) => !named.isTypeOnly() && named.getName() === name)) importers.push(path);
    }
    for (const declaration of file.getExportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (target !== undefined && toRepoRelative(target.getFilePath()) === DEFINING_FILE && !declaration.isTypeOnly()) {
        if (declaration.getNamedExports().length === 0 || declaration.getNamedExports().some((named) => named.getName() === name)) importers.push(`${path} (re-export)`);
      }
    }
  }
  return importers.sort();
}

describe('운영자 예약 주소 — 브랜드는 운영자 CLI 만 만든다', () => {
  it(`${BUILDER} 를 값으로 import 하는 곳은 ${CLI_FILE} 하나 · src/admin·src/api·src/ops·src/mcp 에는 없다`, () => {
    const importers = valueImports(BUILDER);
    expect(importers).toContain(CLI_FILE);
    expect(importers.filter((path) => FORBIDDEN_DIRS.some((dir) => path.startsWith(dir)))).toEqual([]);
    expect(importers).toEqual([CLI_FILE].concat(importers.filter((path) => path.startsWith('test/'))).sort());
  });

  it(`${BRAND} 로의 형 단언(as)은 정의 파일에만 있다 — 브랜드를 위조하는 곳이 없다`, () => {
    const offenders: string[] = [];
    for (const file of getProject().getSourceFiles()) {
      const path = toRepoRelative(file.getFilePath());
      if (path === DEFINING_FILE || path.startsWith('test/')) continue;
      for (const assertion of [...file.getDescendantsOfKind(SyntaxKind.AsExpression), ...file.getDescendantsOfKind(SyntaxKind.TypeAssertionExpression)]) {
        if (assertion.getTypeNode()?.getText().includes(BRAND) === true) offenders.push(`${path}:${String(assertion.getStartLineNumber())}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
