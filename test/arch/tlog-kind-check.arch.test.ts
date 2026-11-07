/**
 * **교체형 CHECK 목록의 역사 규칙**(ADR-0014 · 계획 §3.2 M5 · L3).
 *
 * 잎 종류 · outbox 원천 · outbox 스냅샷 · 수신 거부 사유 CHECK 는 새 값을 더할 때마다 `DROP CONSTRAINT` + `ADD CONSTRAINT` 로 **목록 전체를 다시
 * 적는다.** 다시 적을 때 과거 값 하나를 빠뜨리면 그 종류의 과거 행이 CHECK 에 걸리고(VALIDATE 실패), 그 종류를 새로 쓰는 경로(예: 옛 잎 종류의
 * 서열)가 조용히 죽는다. 그래서:
 *
 *   ① 마이그레이션을 파일 순서대로 읽어 같은 이름의 CHECK 정의가 **매번 앞 정의의 상위 집합**인지 본다(빠진 값 0).
 *   ② 마지막 정의 = 코드의 목록 — `ORG_LEAF_KINDS` · `TLOG_SOURCE_TABLES` · `INBOUND_REJECTION_REASONS`(빠진 것도 남는 것도 없다).
 *   ③ `tlog_enqueue()` 의 마지막 정의가 바로 앞 정의의 **모든 줄**을 담는다(기존 원천 분기를 깨지 않고 더하기만 했다 — 0115 · 1130 규율).
 *   ④ 스냅샷을 싣는 원천(스냅샷 CHECK) ⊆ 원천 CHECK.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { INBOUND_REJECTION_REASONS } from '../../src/db/schema';
import { ORG_LEAF_KINDS, TLOG_SOURCE_TABLES } from '../../src/tlog/constants';
import { repoPath } from './support/project';

interface Definition {
  readonly file: string;
  readonly values: readonly string[];
}

const MIGRATIONS = (() => {
  const directory = repoPath('src/db/migrations');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ file: name, sql: readFileSync(`${directory}/${name}`, 'utf8').replace(/--[^\n]*/g, '') }));
})();

/** 이름이 `constraint` 인 CHECK 의 정의를 파일 순서대로 — 인라인 칼럼 CHECK(`CREATE TABLE`)는 `inline` 으로 첫 정의를 준다. */
function definitionsOf(constraint: string, inline: { readonly table: string; readonly column: string } | null): Definition[] {
  const out: Definition[] = [];
  for (const { file, sql } of MIGRATIONS) {
    if (inline !== null) {
      const table = new RegExp(`CREATE TABLE ${inline.table} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
      const column = table === null ? null : new RegExp(`\\n\\s+${inline.column}\\s+text[^\\n]*CHECK \\(${inline.column} IN \\(([^)]*)\\)`).exec(table[1] ?? '');
      if (column !== null) out.push({ file, values: valuesOf(column[1] ?? '') });
    }
    for (const statement of sql.split(';')) {
      const match = new RegExp(`ADD CONSTRAINT ${constraint}\\s+CHECK \\(([\\s\\S]*)\\)`).exec(statement);
      if (match !== null) out.push({ file, values: valuesOf(match[1] ?? '') });
    }
  }
  return out;
}

function valuesOf(list: string): string[] {
  return [...new Set([...list.matchAll(/'([a-z0-9_.]+)'/g)].map((match) => match[1] ?? ''))].sort();
}

function expectMonotone(definitions: readonly Definition[]): void {
  expect(definitions.length, '정의를 하나도 찾지 못했다(공허한 통과 방지)').toBeGreaterThanOrEqual(2);
  for (let index = 1; index < definitions.length; index += 1) {
    const before = definitions[index - 1] as Definition;
    const after = definitions[index] as Definition;
    const dropped = before.values.filter((value) => !after.values.includes(value));
    expect(dropped, `${after.file} 가 ${before.file} 의 값을 빠뜨렸다`).toEqual([]);
  }
}

describe('① 교체형 CHECK 는 앞 정의의 상위 집합이다 · ② 마지막 정의 = 코드 목록', () => {
  it('tlog_leaves_kind_check = ORG_LEAF_KINDS', () => {
    const definitions = definitionsOf('tlog_leaves_kind_check', { table: 'tlog_leaves', column: 'kind' });
    expectMonotone(definitions);
    expect(definitions.at(-1)?.values).toEqual([...ORG_LEAF_KINDS].sort());
    expect(ORG_LEAF_KINDS).toContain('domain.status');
  });

  it('tlog_outbox_source_table_check = TLOG_SOURCE_TABLES', () => {
    const definitions = definitionsOf('tlog_outbox_source_table_check', { table: 'tlog_outbox', column: 'source_table' });
    expectMonotone(definitions);
    expect(definitions.at(-1)?.values).toEqual([...TLOG_SOURCE_TABLES].sort());
    expect(TLOG_SOURCE_TABLES).toContain('custom_domains');
  });

  it('tlog_outbox_snapshot_shape — 상위 집합 · 스냅샷 원천 ⊆ 원천 · custom_domains 는 스냅샷을 싣는다', () => {
    const definitions = definitionsOf('tlog_outbox_snapshot_shape', null);
    expectMonotone(definitions);
    const last = definitions.at(-1)?.values ?? [];
    for (const table of last) expect(TLOG_SOURCE_TABLES as readonly string[], table).toContain(table);
    expect(last).toEqual(['agents', 'audit_logs', 'custom_domains', 'org_entitlements']);
  });

  it('inbound_rejections_reason_check = INBOUND_REJECTION_REASONS(InboundRejectionReason)', () => {
    const definitions = definitionsOf('inbound_rejections_reason_check', { table: 'inbound_rejections', column: 'reason' });
    expectMonotone(definitions);
    expect(definitions.at(-1)?.values).toEqual([...INBOUND_REJECTION_REASONS].sort());
    expect(INBOUND_REJECTION_REASONS).toContain('domain_not_active');
  });
});

describe('③ tlog_enqueue() 는 더하기만 한다', () => {
  it('마지막 정의가 바로 앞 정의의 모든 줄을 담는다(202610021110 ⊇ 202609291130)', () => {
    const definitions = MIGRATIONS.flatMap(({ file }) => {
      const raw = readFileSync(repoPath('src/db/migrations', file), 'utf8');
      const body = /CREATE OR REPLACE FUNCTION tlog_enqueue\(\)[\s\S]*?\n\$\$;/.exec(raw)?.[0];
      return body === undefined ? [] : [{ file, body }];
    });
    expect(definitions.length).toBeGreaterThanOrEqual(2);
    const before = definitions.at(-2) as { file: string; body: string };
    const after = definitions.at(-1) as { file: string; body: string };
    expect(before.file).toBe('202609291130_tlog_domain_leaf.sql');
    expect(after.file).toBe('202610021110_tlog_primary_leaf.sql');
    expect(before.body.length).toBeGreaterThan(1000);
    const afterLines = new Set(after.body.split('\n'));
    for (const line of before.body.split('\n')) expect(afterLines.has(line), `${before.file}: ${line}`).toBe(true);
    // 1130 의 두 분기(조직·id · 스냅샷)가 남았다 · 도메인 이름은 스냅샷에 없다 · 대표 주소 선택은 조직·id 분기 하나(append-only — 스냅샷 없음).
    expect(after.body.match(/ELSIF TG_TABLE_NAME = 'custom_domains' THEN/g)).toHaveLength(2);
    expect(after.body).not.toMatch(/'domain', NEW\.domain/);
    expect(after.body.match(/ELSIF TG_TABLE_NAME = 'agent_primary_changes' THEN/g)).toHaveLength(1);
  });
});
