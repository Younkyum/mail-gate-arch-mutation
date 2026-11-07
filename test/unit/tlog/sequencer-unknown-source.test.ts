/**
 * 적대적 검증 M1 — **배포 순서 위험**: 새 원천 테이블을 outbox 에 넓히는 마이그레이션이 그 테이블을 모르는 서열기보다 먼저 돌면, 옛 서열기의
 * `eventOf` 는 `undefined` 를 돌려주고 `buildOrgLeaf` 의 `TypeError` 가 `source.missing(unrepresentable)` 로 **되돌릴 수 없이** 커밋됐다.
 * 이제 모르는 원천은 `UnknownSourceTableError`(TypeError 아님)로 던져 **배치 트랜잭션이 통째로 되돌아가고**(잎·처리 표시 0) 다음 틱이 다시 본다.
 *
 * 가짜 풀 — `withTransaction` 이 보내는 BEGIN/ROLLBACK 과 서열기의 SQL 을 문장 모양으로 받아 기록한다.
 */

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { drainOutbox, UnknownSourceTableError } from '../../../src/tlog/sequencer';

interface Recorded {
  readonly statements: string[];
}

function fakePool(sourceTable: string, recorded: Recorded): Pool {
  const log = Buffer.alloc(16, 7);
  const client = {
    query: (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
      recorded.statements.push(text.trim().split(/\s+/).slice(0, 4).join(' '));
      if (/FROM tlog_outbox o/.test(text)) {
        return Promise.resolve({
          rows: [
            {
              id: '41',
              source_table: sourceTable,
              source_id: '0'.repeat(32),
              event: 'insert',
              rev: 0,
              organization_id: '00000000-0000-4000-8000-000000000001',
              snapshot: null,
              enqueued: '2026-09-24T00:00:00.000000Z',
            },
          ],
          rowCount: 1,
        });
      }
      if (/FROM tlog_logs l JOIN tlog_salt_keys/.test(text)) {
        return Promise.resolve({
          rows: [{ organization_id: '00000000-0000-4000-8000-000000000001', org_log_id: log, salt_key: Buffer.alloc(32, 1), next: '5' }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: (): void => undefined,
  };
  return { connect: () => Promise.resolve(client) } as unknown as Pool;
}

describe('서열기 — 모르는 원천 테이블(코드가 스키마보다 옛것)', () => {
  it('UnknownSourceTableError(TypeError 아님)로 던지고 배치를 되돌린다 — source.missing 잎도 처리 표시도 없다', async () => {
    const recorded: Recorded = { statements: [] };
    const error: unknown = await drainOutbox({ db: fakePool('agent_badges', recorded), now: () => new Date('2026-09-24T00:00:00Z') }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnknownSourceTableError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(/unknown source_table "agent_badges" \(code older than schema\)/);
    expect(recorded.statements[0]).toBe('BEGIN');
    expect(recorded.statements.at(-1)).toBe('ROLLBACK');
    expect(recorded.statements.some((statement) => statement.startsWith('INSERT INTO tlog_leaves'))).toBe(false);
    expect(recorded.statements.some((statement) => statement.startsWith('UPDATE tlog_outbox'))).toBe(false);
    expect(recorded.statements).not.toContain('COMMIT');
  });

  it('아는 원천은 그대로 처리한다(대조군) — 원천 행이 없으면 source.missing(not_found) 잎 + 처리 표시 + COMMIT', async () => {
    const recorded: Recorded = { statements: [] };
    const counts = await drainOutbox({ db: fakePool('owner_actions', recorded), now: () => new Date('2026-09-24T00:00:00Z') });
    expect(counts).toEqual({ processed: 1, logsCreated: 0, missingSources: 1 });
    expect(recorded.statements.some((statement) => statement.startsWith('INSERT INTO tlog_leaves'))).toBe(true);
    expect(recorded.statements.at(-1)).toBe('COMMIT');
  });
});
