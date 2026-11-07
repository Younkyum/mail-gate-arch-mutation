/**
 * 마이그레이션 러너의 **비트랜잭션 파일** 규칙(`src/db/migrate.ts` 머리말 — 메일 기본기 1차 수정, 코드 리뷰 H1·M2·L10).
 *
 * 각 단언이 겨냥하는 것:
 *   - 형식: 지시자는 첫 줄에만 · 문장은 `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS …;` 하나뿐 · 트랜잭션 파일의 `CONCURRENTLY` 거부 ·
 *     **리포 전체**가 형식을 지키고 1차 색인 파일이 전부 비트랜잭션이며 나머지는 트랜잭션이다(러너는 대기 중인 파일만 보므로 — 재검토 N4-a —
 *     리포 전체 검사는 이 파일이 맡는다). 형식이 틀린 파일이 뒤에 있으면 앞의 파일도 적용하지 않는다 · 이미 적용된 파일의 형식은 보지 않는다.
 *   - 기록: 성공한 뒤에만 `schema_migrations` 한 줄(체크섬 포함) · 다시 돌리면 이미 적용 · 파일이 바뀌면 체크섬 불일치.
 *   - 잠금: 러너가 세션에 `lock_timeout`(`NO_TRANSACTION_LOCK_TIMEOUT` = 60초, N4-b)을 건다 — 5초를 넘게 쥔 트랜잭션도 기다려 성공하고,
 *     상한을 넘기면 55P03 으로 멈추고 기록하지 않는다(상한은 테스트가 1초로 줄여 본다). 끝나면(실패해도) 세션 설정이 들어올 때 값으로 돌아온다.
 *   - 회복: 빌드 실패가 남긴 INVALID 색인은 다음 실행이 치우고 다시 만든다 · 이름을 다른 관계가 쥐고 있으면 던진다.
 *
 * DB 부분은 **소유자 롤**(`TEST_MIGRATION_DATABASE_URL`)로, 매번 새 스키마를 만들어 그 안에서만 돈다(검색 경로 = 그 스키마 하나 — 이력
 * 표·표·색인이 모두 거기 생긴다). 끝나면 그 스키마만 지운다.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../../src/db/client';
import {
  loadMigrations,
  migrate,
  MigrationChecksumMismatchError,
  MigrationFormatError,
  MigrationIndexNotBuiltError,
  NO_TRANSACTION_DIRECTIVE,
  NO_TRANSACTION_LOCK_TIMEOUT,
  noTransactionStatementOf,
  type MigrationFile,
} from '../../../src/db/migrate';

const OWNER_URL = (process.env['TEST_MIGRATION_DATABASE_URL'] ?? '').trim();

function file(filename: string, sql: string): MigrationFile {
  return { filename, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}

const noTx = (filename: string, statement: string): MigrationFile => file(filename, `${NO_TRANSACTION_DIRECTIVE}\n-- ${filename}\n\n${statement}\n`);

describe('비트랜잭션 파일 형식', () => {
  it('지시자가 없으면 트랜잭션 파일 · 있으면 색인 이름과 표', () => {
    expect(noTransactionStatementOf(file('a.sql', 'SET LOCAL lock_timeout = \'5s\';\nCREATE TABLE t (id int);\n'))).toBeNull();
    expect(noTransactionStatementOf(noTx('b.sql', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS t_v_idx ON t (v) WHERE v IS NOT NULL;'))).toEqual({
      indexName: 't_v_idx',
      table: 't',
    });
    expect(noTransactionStatementOf(noTx('c.sql', 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS t_u ON public.t (v);'))).toEqual({ indexName: 't_u', table: 't' });
  });

  it('규칙을 어기면 MigrationFormatError', () => {
    const bad: readonly MigrationFile[] = [
      // 지시자가 첫 줄이 아니다.
      file('d1.sql', `-- 머리말\n${NO_TRANSACTION_DIRECTIVE}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (v);\n`),
      // 지시자가 두 번.
      file('d2.sql', `${NO_TRANSACTION_DIRECTIVE}\n${NO_TRANSACTION_DIRECTIVE}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (v);\n`),
      // 문장 둘.
      noTx('s1.sql', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (v);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS j ON t (id);'),
      // 허용 문장이 아니다.
      noTx('s2.sql', 'DROP TABLE t;'),
      noTx('s3.sql', 'CREATE INDEX CONCURRENTLY i ON t (v);'),
      noTx('s4.sql', 'CREATE INDEX IF NOT EXISTS i ON t (v);'),
      noTx('s5.sql', 'ALTER TABLE t ADD COLUMN x int;'),
      // 문장 안의 주석(줄 끝·블록)은 받지 않는다.
      noTx('s6.sql', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (v); -- 끝'),
      noTx('s7.sql', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t /* x */ (v);'),
      // 트랜잭션 파일의 CONCURRENTLY — 지시자를 잊었다.
      file('t1.sql', 'SET LOCAL lock_timeout = \'5s\';\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (v);\n'),
    ];
    for (const migration of bad) {
      expect(() => noTransactionStatementOf(migration), migration.filename).toThrow(MigrationFormatError);
    }
    // 트랜잭션 파일의 주석 속 CONCURRENTLY 는 괜찮다(본문만 본다).
    expect(noTransactionStatementOf(file('t2.sql', '-- 색인은 CONCURRENTLY 로 다음 파일에서\nSELECT 1;\n'))).toBeNull();
  });

  it('리포의 마이그레이션 전부가 형식을 지키고, 1차 색인 여섯 · 코드 후보 색인 둘 · 주소 색인 둘 · 고객 도메인 색인 셋은 비트랜잭션이다', () => {
    const noTransaction = loadMigrations()
      .filter((migration) => noTransactionStatementOf(migration) !== null)
      .map((migration) => migration.filename);
    expect(noTransaction).toEqual([
      '202609260107_scheduled_sends_agent_list_idx.sql',
      '202609260108_scheduled_sends_agent_cancel_idx.sql',
      '202609260117_webhook_deliveries_redelivery_of_idx.sql',
      '202609260118_webhook_deliveries_endpoint_created_idx.sql',
      '202609260119_webhook_endpoints_agent_created_idx.sql',
      '202609260121_inbound_messages_visible_from_domain_idx.sql',
      // 로그인·가입 코드 후보 부분 색인(2026-09-28 보안 검토 L4).
      '202609280103_owner_login_links_code_candidates_idx.sql',
      '202609280104_signup_links_code_candidates_idx.sql',
      // 별칭 재발급(ADR-0013 2026-09-29 개정) — 활성 주소 부분 UNIQUE · 주소 보통 색인. 옛 전역 UNIQUE 는 트랜잭션 파일 1002 가 지운다.
      '202609291000_agent_addresses_active_address_key.sql',
      '202609291001_agent_addresses_address_idx.sql',
      // 고객 도메인(ADR-0014) — 발신 도메인 카운터 부분 색인(L7) · 모르는 수신자 창 부분 색인(L10).
      '202609291122_messages_custom_from_domain_created_idx.sql',
      '202609291123_inbound_rejections_unknown_created_idx.sql',
      // 한 번에 설정(2026-10-06) — 도메인당 identity 관리자 하나(부분 UNIQUE).
      '202610061001_custom_domains_identity_claim_index.sql',
      // AI 의심 메일 감시(ADR-0017 초안) — 작업 → 메일 역조회(보류 풀기 · 보존의 FK SET NULL).
      '202610061102_inbound_messages_ai_watch_job_idx.sql',
      '202610061103_inbound_messages_ai_watch_created_idx.sql',
      // 격리 알림(ADR-0016 2026-10-07) — 틱 대조(최근 24시간 격리 메일 중 창에 묶이지 않은 수 · 보안 리뷰 L1).
      '202610071001_inbound_messages_quarantine_created_idx.sql',
      '202610081002_quarantine_notices_open_kind_idx.sql',
      '202610081006_inbound_messages_released_idx.sql',
      // 묶음 D — 자가 등록 요청 id UNIQUE(재생 방지, 부분 색인).
      '202610081104_agent_enrollments_request_id_idx.sql',
      // 묶음 B — 첨부 업로드 중복 방지 키(에이전트별 UNIQUE, 부분 색인).
      '202610081202_outbound_attachments_idempotency_idx.sql',
      // 공유 도메인 평판(재검증 I-1) — 신고자 해시가 남은 SES complaint 행만(보존 스윕).
      '202610131614_ses_events_complaint_hash_idx.sql',
    ]);
  });
});

describe.skipIf(OWNER_URL === '')('비트랜잭션 파일 적용 (소유자 롤 · 스크래치 스키마)', () => {
  let pool: Pool;
  let client: PoolClient;
  const schema = `x2_migrate_${randomBytes(6).toString('hex')}`;

  beforeAll(async () => {
    pool = createPool(OWNER_URL, { max: 3 });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
  });

  afterAll(async () => {
    if (client !== undefined) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
    await pool?.end();
  });

  async function history(): Promise<Map<string, string>> {
    const result = await client.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM schema_migrations ORDER BY filename');
    return new Map(result.rows.map((row) => [row.filename, row.checksum]));
  }

  async function indexUsable(name: string): Promise<boolean | null> {
    const result = await client.query<{ usable: boolean }>(
      'SELECT (indisvalid AND indisready) AS usable FROM pg_index WHERE indexrelid = to_regclass($1)',
      [name],
    );
    return result.rows[0]?.usable ?? null;
  }

  async function settings(): Promise<{ lock: string; statement: string }> {
    const result = await client.query<{ lock: string; statement: string }>(
      `SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement`,
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('설정 없음');
    return row;
  }

  const table = file('0001_table.sql', "SET LOCAL lock_timeout = '5s';\nCREATE TABLE t (id int PRIMARY KEY, v text);\nINSERT INTO t SELECT g, 'v' || g FROM generate_series(1, 50) g;\n");
  const index = noTx('0002_t_v_idx.sql', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS t_v_idx ON t (v DESC, id DESC) WHERE v IS NOT NULL;');

  it('트랜잭션 파일 → 비트랜잭션 파일 순서로 적용 · 이력에 체크섬 · 다시 돌리면 이미 적용 · 바뀌면 체크섬 불일치 · 세션 설정 복원', async () => {
    const before = await settings();
    const report = await migrate(client, [table, index]);
    expect(report).toEqual({ applied: [table.filename, index.filename], alreadyApplied: [] });
    expect(await history()).toEqual(new Map([[table.filename, table.checksum], [index.filename, index.checksum]]));
    expect(await indexUsable('t_v_idx')).toBe(true);
    // 트랜잭션 밖이었다 — 열린 트랜잭션이 남지 않았고, 러너가 건 lock_timeout·statement_timeout 은 들어올 때 값으로 돌아왔다.
    expect((await client.query<{ autocommit: boolean }>(`SELECT now() = statement_timestamp() AS autocommit`)).rows[0]?.autocommit).toBe(true);
    expect(await settings()).toEqual(before);
    expect(before.lock).not.toBe(NO_TRANSACTION_LOCK_TIMEOUT);

    expect(await migrate(client, [table, index])).toEqual({ applied: [], alreadyApplied: [table.filename, index.filename] });
    const changed = noTx(index.filename, 'CREATE INDEX CONCURRENTLY IF NOT EXISTS t_v_idx ON t (v);');
    await expect(migrate(client, [table, changed])).rejects.toThrow(MigrationChecksumMismatchError);
  });

  it('이미 적용된 파일의 형식은 보지 않는다(N4-a) — 규칙이 나중에 좁아져도 대기 중인 파일은 적용된다 · 체크섬은 그대로 지킨다', async () => {
    // 옛 규칙으로 적용된 파일 — 지금 규칙이면 형식 오류다(트랜잭션 파일의 CONCURRENTLY). 이력에는 그 내용의 체크섬이 있다.
    const legacy = file('0002a_legacy.sql', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS legacy_idx ON t (id);\n');
    expect(() => noTransactionStatementOf(legacy)).toThrow(MigrationFormatError);
    await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [legacy.filename, legacy.checksum]);
    const next = file('0002b_next.sql', 'CREATE TABLE after_legacy (id int);\n');
    const report = await migrate(client, [table, index, legacy, next]);
    expect(report).toEqual({ applied: [next.filename], alreadyApplied: [table.filename, index.filename, legacy.filename] });
    // 적용된 파일이 바뀌면 여전히 체크섬 불일치다(형식 검사를 건너뛴다고 내용 검사가 풀리지 않는다).
    const tampered = file(legacy.filename, 'DROP TABLE t;\n');
    await expect(migrate(client, [table, index, tampered, next])).rejects.toThrow(MigrationChecksumMismatchError);
  });

  it('형식이 틀린 파일이 뒤에 있으면 앞의 파일도 적용하지 않는다', async () => {
    const early = file('0003_early.sql', 'CREATE TABLE early (id int);\n');
    const broken = noTx('0004_broken.sql', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS e_idx ON early (id);\nDROP TABLE t;');
    await expect(migrate(client, [table, index, early, broken])).rejects.toThrow(MigrationFormatError);
    expect((await history()).has(early.filename)).toBe(false);
    expect((await client.query(`SELECT to_regclass('early') AS rel`)).rows[0]?.rel).toBeNull();
  });

  it('표를 쥔 트랜잭션이 5초를 넘게 있어도 기다려 성공한다(상한 60초 — N4-b) · 세션 설정 복원', async () => {
    expect(NO_TRANSACTION_LOCK_TIMEOUT).toBe('60s');
    const patient = noTx('0004a_t_v_id_idx.sql', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS t_v_id_idx ON t (v, id);');
    const before = await settings();
    const holder = await pool.connect();
    let released = 0;
    try {
      await holder.query(`SET search_path TO ${schema}`);
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE t IN SHARE UPDATE EXCLUSIVE MODE');
      const started = Date.now();
      // 옛 상한(5초)을 넘겨 6초 뒤에 푼다 — 러너가 그 사이 55P03 으로 멈추지 않아야 한다.
      const release = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          released = Date.now() - started;
          holder.query('ROLLBACK').then(() => resolve(), reject);
        }, 6_000);
      });
      const report = await migrate(client, [table, index, patient]);
      await release;
      expect(report.applied).toEqual([patient.filename]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(released);
      // 옛 상한(5초)을 확실히 넘겼는가만 본다 — setTimeout 은 Date.now() 기준으로 1ms 일찍 깰 수 있다(CI 에서 5999 관측).
      expect(released).toBeGreaterThan(5_500);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(await indexUsable('t_v_id_idx')).toBe(true);
    expect(await settings()).toEqual(before);
  }, 30_000);

  it('표를 쥔 트랜잭션이 상한을 넘기면 lock_timeout 으로 멈추고(55P03) 기록하지 않는다 · 풀리면 다시 돌려 성공', async () => {
    const waiting = noTx('0005_t_id_v_idx.sql', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS t_id_v_idx ON t (id, v);');
    const before = await settings();
    const holder = await pool.connect();
    try {
      await holder.query(`SET search_path TO ${schema}`);
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE t IN SHARE UPDATE EXCLUSIVE MODE');
      const started = Date.now();
      // 운영 상한(60초)을 기다리지 않게 1초로 줄인다 — 상한을 넘기면 멈추는 경로는 값과 무관하다.
      const failure = await migrate(client, [table, index, waiting], { noTransactionLockTimeout: '1s' }).then(
        () => null,
        (error: unknown) => error as { code?: string },
      );
      expect(failure?.code).toBe('55P03');
      // 준 상한(1초) 근처에서 멈췄다 — 무한정 기다리지 않았다.
      expect(Date.now() - started).toBeLessThan(10_000);
      expect((await history()).has(waiting.filename)).toBe(false);
      expect(await settings()).toEqual(before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await migrate(client, [table, index, waiting])).applied).toEqual([waiting.filename]);
    expect(await indexUsable('t_id_v_idx')).toBe(true);
  }, 30_000);

  it('빌드 실패가 남긴 INVALID 색인 — 기록하지 않고, 다음 실행이 DROP INDEX CONCURRENTLY 뒤 다시 만든다', async () => {
    await client.query(`INSERT INTO t VALUES (1001, 'dup'), (1002, 'dup')`);
    const unique = noTx('0006_t_v_unique.sql', 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS t_v_unique ON t (v);');
    await expect(migrate(client, [table, index, unique])).rejects.toMatchObject({ code: '23505' });
    expect((await history()).has(unique.filename)).toBe(false);
    // Postgres 가 남긴 INVALID 색인 — IF NOT EXISTS 만으로는 이것을 "있다" 며 건너뛴다.
    expect(await indexUsable('t_v_unique')).toBe(false);

    await client.query(`UPDATE t SET v = 'dup2' WHERE id = 1002`);
    expect((await migrate(client, [table, index, unique])).applied).toEqual([unique.filename]);
    expect(await indexUsable('t_v_unique')).toBe(true);
    expect((await history()).get(unique.filename)).toBe(unique.checksum);
  });

  it('유효한 색인이 이미 있으면(빌드 뒤 기록 전에 죽은 경우) 건너뛰고 이력만 적는다 · 이름을 다른 관계가 쥐면 던지고 기록하지 않는다', async () => {
    await client.query('CREATE INDEX t_prebuilt ON t (id, v)');
    const prebuilt = noTx('0007_t_prebuilt.sql', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS t_prebuilt ON t (id, v);');
    expect((await migrate(client, [table, index, prebuilt])).applied).toEqual([prebuilt.filename]);

    await client.query('CREATE TABLE squatter (id int)');
    const squatted = noTx('0008_squatter.sql', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS squatter ON t (v);');
    await expect(migrate(client, [table, index, prebuilt, squatted])).rejects.toThrow(MigrationIndexNotBuiltError);
    expect((await history()).has(squatted.filename)).toBe(false);
  });
});
