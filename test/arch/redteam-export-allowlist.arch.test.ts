/**
 * **레드팀 내보내기는 레드팀 메일함만 향한다**(`pnpm admin:redteam-export`, 2026-10-09). 이 CLI 는 격리 메일까지 본문째 노트북 디스크로 옮긴다 —
 * 고객 메일함을 가리킬 수 있으면 그것이 곧 유출 도구다. 코드 모양으로 단언한다:
 *
 *   ① 허용 목록은 **정확히** 레드팀 에이전트 하나다(값 · 얼어 있음). 늘리려면 이 테스트를 함께 고친다(리뷰에 보인다).
 *   ② 진입점은 허용 목록 검사(`assertExportAllowed`)를 **접속(`withAdminConnection`) 전에** 부른다.
 *   ③ SQL 은 에이전트 id **와** 운영 조직을 함께 건다(`m.agent_id = $1` · `a.organization_id = $2`) — 인자 검사가 빠져도 조직 밖은 나오지 않는다.
 *   ④ 읽기 전용 — 트랜잭션을 `READ ONLY` 로 열고, SQL 리터럴에 INSERT · UPDATE · DELETE · TRUNCATE · 쓰기 정의자 함수 호출이 없다.
 *   ⑤ 파일 안의 32자리 hex 에이전트 id 리터럴은 레드팀 에이전트 하나뿐이다(다른 id 를 몰래 기본값으로 둘 수 없다).
 *   ⑥ 이 CLI 를 import 하는 것은 평가 스크립트와 테스트뿐이다 — 다른 표면(src/**)이 내보내기를 재사용하지 않는다.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { SyntaxKind } from 'ts-morph';

import { REDTEAM_AGENT_ID, REDTEAM_EXPORT_AGENTS, REDTEAM_ORGANIZATION_ID } from '../../scripts/admin/redteam-export';
import { getProject, repoPath, toRepoRelative } from './support/project';

const CLI = 'scripts/admin/redteam-export.ts';

function source(): string {
  return readFileSync(repoPath(CLI), 'utf8');
}

function sqlLiterals(): string[] {
  const file = getProject()
    .getSourceFiles()
    .find((f) => toRepoRelative(f.getFilePath()) === CLI);
  if (file === undefined) throw new Error(`파일이 없다: ${CLI}`);
  return [
    ...file.getDescendantsOfKind(SyntaxKind.StringLiteral).map((l) => l.getLiteralValue()),
    ...file.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral).map((l) => l.getLiteralValue()),
    ...file.getDescendantsOfKind(SyntaxKind.TemplateExpression).map((t) => t.getText()),
  ].filter((text) => /\b(?:SELECT|BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE)\b/.test(text));
}

describe('레드팀 내보내기 — 허용 목록 · 읽기 전용', () => {
  it('① 허용 목록은 정확히 레드팀 에이전트 하나다', () => {
    expect(REDTEAM_AGENT_ID).toBe('d7770ab13168aa288d5eb1f69a4571d7');
    expect(REDTEAM_ORGANIZATION_ID).toBe('f37fa0fd-231f-4cfe-8540-067eee3e7538');
    expect([...REDTEAM_EXPORT_AGENTS]).toEqual([REDTEAM_AGENT_ID]);
    expect(Object.isFrozen(REDTEAM_EXPORT_AGENTS)).toBe(true);
  });

  it('② 진입점은 접속 전에 허용 목록을 검사한다', () => {
    const text = source();
    const body = text.slice(text.indexOf('export async function redteamExport('));
    const check = body.indexOf('assertExportAllowed(');
    const connect = body.indexOf('withAdminConnection(');
    expect(check).toBeGreaterThan(0);
    expect(connect).toBeGreaterThan(check);
  });

  it('③ SQL 은 에이전트 id 와 운영 조직을 함께 건다', () => {
    const selects = sqlLiterals().filter((sql) => /\bFROM inbound_messages\b/.test(sql));
    expect(selects.length).toBeGreaterThan(0);
    for (const sql of selects) {
      expect(sql).toMatch(/m\.agent_id = \$1/);
      expect(sql).toMatch(/a\.organization_id = \$2/);
    }
    expect(source()).toMatch(/\[agentId, REDTEAM_ORGANIZATION_ID, since\]/);
  });

  it('④ 읽기 전용 — READ ONLY 트랜잭션 · 쓰기 SQL 없음', () => {
    const sqls = sqlLiterals();
    expect(sqls.some((sql) => /^BEGIN TRANSACTION .*READ ONLY$/.test(sql))).toBe(true);
    for (const sql of sqls) {
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|GRANT)\b/i);
      expect(sql).not.toMatch(/\batmark_\w+\s*\(/); // 정의자 함수(쓰기 코어)를 부르지 않는다
    }
    // 객체 저장소도 읽기만 — 쓰기 저장소를 만들지 않는다.
    expect(source()).not.toMatch(/createS3ObjectStore\(|createInboundArtifactStore\(/);
  });

  it('⑤ 에이전트 id 리터럴은 레드팀 하나뿐이다', () => {
    const ids = [...new Set(source().match(/\b[0-9a-f]{32}\b/g) ?? [])];
    expect(ids).toEqual([REDTEAM_AGENT_ID]);
  });

  it('⑥ 이 CLI 를 import 하는 것은 평가 스크립트와 테스트뿐이다', () => {
    const importers = getProject()
      .getSourceFiles()
      .filter((f) => f.getImportDeclarations().some((d) => /redteam-export$/.test(d.getModuleSpecifierValue())))
      .map((f) => toRepoRelative(f.getFilePath()))
      .sort();
    const allowed = (path: string): boolean => path === 'scripts/redteam-eval.ts' || path.startsWith('test/');
    expect(importers.filter((path) => !allowed(path))).toEqual([]);
    expect(importers).toContain('scripts/redteam-eval.ts');
  });
});
