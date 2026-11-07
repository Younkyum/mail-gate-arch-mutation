/**
 * 소유자 수동 분류(`sender_marks`)의 **쓰기 표면**과 **Stage 7 분리**를 정적으로 단언한다 (계획 §6 P4).
 *
 * 런타임 층(`test/integration/inbound/sender-trust.test.ts`)이 두 명제를 DB 로 본다 — 앱 롤은 INSERT 권한이
 * 없고, seen 으로 표시한 수신자에게 보내도 승인 대기다. 이 층은 **코드가 그 경계를 향해 자라는 것**을 본다:
 *
 *   ① 쓰기 함수 `recordSenderMark` 를 가져다 쓰는 곳은 공유 연산(`src/admin/ops/sender-marks.ts`) 하나이고, **그 연산을 부르는
 *      곳은 소유자 표면 둘뿐이다** — 운영자 CLI(`scripts/sender-mark.ts`)와 관리 API(`src/admin/routes/senders.ts`, 소유자
 *      세션 · admin Lambda · 소유자 DB 롤, 2026-09-23 관리 백엔드). 에이전트 토큰으로 닿는 경로(api Lambda·워커·MCP)가 생기면
 *      **에이전트가 자기 신뢰를 올린다.** 관리 API 가 api 번들에 없다는 것은 `admin-separation.arch.test.ts` 가 import 폐포로
 *      본다. (DB GRANT — 앱 롤 SELECT 만 — 가 2차 방어지만, 누가 GRANT 를 "고치는" 날 1차가 남는다.)
 *   ② `INSERT INTO sender_marks` 문자열은 `sender-marks-store.ts` 에만 있다.
 *   ③ Stage 7 의 소스(`src/policy/**`, `policy-source.ts`)는 `sender_marks` 를 모른다 — 수신 신뢰가 발신 허가로
 *      새는 길(마이그레이션 202609230020 머리말)이 코드에 없다.
 *
 * 한계: 템플릿 리터럴·문자열 연결로 SQL 을 조립하면 ②③ 은 못 본다(정적 층의 공통 한계).
 */

import { describe, expect, it } from 'vitest';
import { SyntaxKind, type SourceFile } from 'ts-morph';

import { getProject, toRepoRelative } from './support/project';

const STORE = 'src/db/repositories/sender-marks-store.ts';
const OP = 'src/admin/ops/sender-marks.ts';
/** 소유자 표면 — 이름으로 적는다(와일드카드 없음). */
const OWNER_SURFACES = ['scripts/sender-mark.ts', 'src/admin/routes/senders.ts'];

function productionFiles(): SourceFile[] {
  return getProject()
    .getSourceFiles()
    .filter((f) => {
      const path = toRepoRelative(f.getFilePath());
      return path.startsWith('src/') || path.startsWith('scripts/');
    });
}

function stringsOf(file: SourceFile): string[] {
  return [
    ...file.getDescendantsOfKind(SyntaxKind.StringLiteral).map((l) => l.getLiteralValue()),
    ...file.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral).map((l) => l.getLiteralValue()),
    ...file.getDescendantsOfKind(SyntaxKind.TemplateExpression).map((t) => t.getText()),
  ];
}

/** `module` 에서 `name` 을 가져오는(import 또는 재수출) 파일. */
function importersOf(module: string, name: string): string[] {
  const out: string[] = [];
  for (const file of productionFiles()) {
    const path = toRepoRelative(file.getFilePath());
    for (const declaration of file.getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (target === undefined || toRepoRelative(target.getFilePath()) !== module) continue;
      if (declaration.getNamespaceImport() !== undefined) out.push(path);
      if (declaration.getNamedImports().some((n) => n.getName() === name)) out.push(path);
    }
    for (const declaration of file.getExportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (target === undefined || toRepoRelative(target.getFilePath()) !== module) continue;
      if (!declaration.hasNamedExports() || declaration.getNamedExports().some((n) => n.getName() === name)) {
        out.push(path);
      }
    }
  }
  return [...new Set(out)].sort();
}

describe('sender_marks 쓰기 표면 (§6 P4 — 에이전트가 자기 신뢰를 올리지 못한다)', () => {
  it('① recordSenderMark 를 가져다 쓰는 프로덕션 파일은 공유 연산 하나이고, 그 연산을 부르는 곳은 소유자 표면 둘(CLI·관리 API)뿐이다', () => {
    // 비공허성: 검사가 실제 사용처를 찾아낸다.
    expect(importersOf(STORE, 'recordSenderMark')).toEqual([OP]);
    expect(importersOf(OP, 'markSenderOp')).toEqual([...OWNER_SURFACES].sort());
    // 공유 연산 모듈을 **통째로** 들이는(네임스페이스) 곳도 같은 둘 안이어야 한다 — 위 importersOf 가 네임스페이스도 센다.
  });

  it('② INSERT INTO sender_marks 는 저장소 파일에만 있다', () => {
    const writers = productionFiles()
      .filter((file) => stringsOf(file).some((s) => /insert\s+into\s+sender_marks\b/i.test(s)))
      .map((file) => toRepoRelative(file.getFilePath()));
    expect(writers).toEqual([STORE]);
  });

  it('③ Stage 7 의 소스(src/policy/**, policy-source.ts)는 sender_marks 를 모른다', () => {
    const stage7 = productionFiles().filter((file) => {
      const path = toRepoRelative(file.getFilePath());
      return path.startsWith('src/policy/') || path === 'src/db/repositories/policy-source.ts';
    });
    // 비공허성: 이 검사가 관계 SQL 을 실제로 읽고 있다.
    expect(
      stage7.some((file) => stringsOf(file).some((s) => s.includes('sender_relationships'))),
    ).toBe(true);
    const leaks = stage7
      .filter(
        (file) =>
          stringsOf(file).some((s) => s.includes('sender_marks')) ||
          file.getImportDeclarations().some((d) => {
            const target = d.getModuleSpecifierSourceFile();
            return target !== undefined && toRepoRelative(target.getFilePath()) === STORE;
          }),
      )
      .map((file) => toRepoRelative(file.getFilePath()));
    expect(leaks).toEqual([]);
  });
});
