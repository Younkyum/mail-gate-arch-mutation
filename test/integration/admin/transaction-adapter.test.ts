/**
 * **감사 트랜잭션 어댑터(`transactionPool`)는 어떤 모양의 트랜잭션 제어로도 바깥 트랜잭션을 끝내지 못한다** (2차 검증 M-A).
 *
 * 예전 어댑터는 문자열이 **정확히** `'BEGIN'`·`'COMMIT'`·`'ROLLBACK'` 일 때만 가로챘다. 검증자가 보인 탈출:
 *   - `{ text: 'COMMIT' }`(QueryConfig) — 바깥 트랜잭션이 커밋되고, 뒤이은 감사 실패가 행위를 되돌리지 못한다.
 *   - `'COMMIT;'` · 소문자 · 공백 — 같은 결과.
 * 이제 분류는 한 함수(`classifyTransactionControl`)이고, 풀 모양의 `query` 는 트랜잭션 제어를 전부 거부한다.
 *
 * 앞 절은 분류표(DB 없음), 뒤 절은 실제 Postgres 에서 검증자 시나리오를 그대로 재현한다(소유자 롤 · 세션 임시 테이블).
 */

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classifyTransactionControl, transactionPool } from '../../../src/admin/ops/transaction';
import { createPool, withTransaction } from '../../../src/db/client';
import { OWNER_URL } from './support';

describe('classifyTransactionControl — 분류표', () => {
  it.each([
    ['BEGIN', 'begin'],
    ['begin', 'begin'],
    ['  Begin Work ; ', 'begin'],
    ['BEGIN TRANSACTION', 'begin'],
    ['START TRANSACTION', 'begin'],
    ['COMMIT', 'commit'],
    ['COMMIT;', 'commit'],
    ['commit work', 'commit'],
    ['END', 'commit'],
    ['end transaction;', 'commit'],
    ['-- 주석\nCOMMIT', 'commit'],
    ['/* x */ COMMIT', 'commit'],
    ['ROLLBACK', 'rollback'],
    ['rollback;', 'rollback'],
    ['ABORT', 'rollback'],
  ] as const)('%j → %s', (text, kind) => {
    expect(classifyTransactionControl(text)).toEqual({ kind });
  });

  it.each([
    'BEGIN ISOLATION LEVEL SERIALIZABLE',
    'BEGIN READ ONLY',
    'START TRANSACTION ISOLATION LEVEL REPEATABLE READ',
    'COMMIT AND CHAIN',
    'ROLLBACK AND CHAIN',
    "COMMIT PREPARED 'x'",
    "ROLLBACK PREPARED 'x'",
    "PREPARE TRANSACTION 'x'",
    'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
    'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
    'INSERT INTO t VALUES (1); COMMIT',
    'COMMIT; BEGIN',
    'select 1; rollback',
  ])('%j → 거부', (text) => {
    expect(classifyTransactionControl(text)?.kind).toBe('reject');
  });

  it.each([
    'SELECT 1',
    'ROLLBACK TO SAVEPOINT s',
    'rollback to s',
    'SAVEPOINT s',
    'RELEASE SAVEPOINT s',
    'PREPARE q AS SELECT 1',
    "UPDATE t SET note = 'begin' WHERE id = 1",
    'SELECT 1; SELECT 2',
    '',
  ])('%j → 트랜잭션 제어 아님(그대로 보낸다)', (text) => {
    expect(classifyTransactionControl(text)).toBeNull();
  });
});

describe.skipIf(OWNER_URL.trim() === '')('transactionPool — 실제 Postgres, 검증자 시나리오', () => {
  // 커넥션 하나 — 세션 임시 테이블이 모든 호출에서 보이게.
  let pool: Pool;
  let table: string;
  beforeAll(async () => {
    pool = createPool(OWNER_URL, { max: 1 });
    table = `pg_temp.tx_probe_${String(process.pid)}`;
    await pool.query(`CREATE TEMP TABLE tx_probe_${String(process.pid)} (v text)`);
  });
  afterAll(async () => {
    await pool.end();
  });

  async function rows(): Promise<string[]> {
    const result = await pool.query<{ v: string }>(`SELECT v FROM ${table} ORDER BY v`);
    return result.rows.map((row) => row.v);
  }

  /** 바깥 트랜잭션 안에서 `inner` 를 돌린 뒤 "감사 실패" 로 던진다 — 바깥이 살아 있으면 전부 롤백돼야 한다. */
  async function outerFailsAfter(inner: (tx: Pool) => Promise<void>): Promise<void> {
    await expect(
      withTransaction(pool, async (client: PoolClient) => {
        await inner(transactionPool(client));
        throw new Error('audit failed');
      }),
    ).rejects.toThrow();
  }

  it('안쪽 withTransaction 의 COMMIT 은 RELEASE 다 — 바깥이 실패하면 안쪽 쓰기도 사라진다', async () => {
    await outerFailsAfter(async (tx) => {
      await withTransaction(tx, async (c) => {
        await c.query(`INSERT INTO ${table} VALUES ('inner')`);
      });
    });
    expect(await rows()).toEqual([]);
  });

  it.each([
    ['QueryConfig { text: COMMIT }', { text: 'COMMIT' }],
    ['QueryConfig { text: commit; }', { text: ' commit; ' }],
    ["'COMMIT;'", 'COMMIT;'],
    ["'end'", 'end'],
  ] as const)('%s 는 바깥을 커밋하지 못한다 — 안쪽 BEGIN 없이 보내면 거부 · 바깥 실패로 전부 롤백', async (_label, commit) => {
    await outerFailsAfter(async (tx) => {
      const c = await tx.connect();
      await c.query(`INSERT INTO ${table} VALUES ('escaped')`);
      await expect(c.query(commit as never)).rejects.toThrow(/열린 세이브포인트 없이/);
    });
    expect(await rows()).toEqual([]);
  });

  it('BEGIN(QueryConfig) … COMMIT; 짝은 세이브포인트로 돈다 — 바깥 실패면 여전히 전부 롤백', async () => {
    await outerFailsAfter(async (tx) => {
      const c = await tx.connect();
      await c.query({ text: 'begin' });
      await c.query(`INSERT INTO ${table} VALUES ('paired')`);
      await c.query('COMMIT;');
    });
    expect(await rows()).toEqual([]);
  });

  it('격리 수준 · 여러 문장 · 풀 query 의 트랜잭션 제어는 던진다', async () => {
    await outerFailsAfter(async (tx) => {
      const c = await tx.connect();
      await expect(c.query('BEGIN ISOLATION LEVEL SERIALIZABLE')).rejects.toThrow(/옵션이 붙은 BEGIN/);
      await expect(c.query(`INSERT INTO ${table} VALUES ('x'); COMMIT`)).rejects.toThrow(/여러 문장/);
      await expect(tx.query('COMMIT')).rejects.toThrow(/풀 query 로 트랜잭션 제어/);
      await expect(tx.query({ text: 'ROLLBACK' } as never)).rejects.toThrow(/풀 query 로 트랜잭션 제어/);
    });
    expect(await rows()).toEqual([]);
  });

  it('통제군 — 바깥이 성공하면 안쪽 쓰기가 남는다', async () => {
    await withTransaction(pool, async (client: PoolClient) => {
      await withTransaction(transactionPool(client), async (c) => {
        await c.query(`INSERT INTO ${table} VALUES ('kept')`);
      });
    });
    expect(await rows()).toEqual(['kept']);
  });
});
