/**
 * src/db/migrate.ts — `pnpm db:migrate`. `src/db/migrations/*.sql` 을 **파일명 순서로**
 * 적용하고 이력을 `schema_migrations` 에 남긴다.
 *
 * **파일명 순서 = 타임스탬프 순서다** (계획 r3 M9). 순번(`0001_`)은 단계 재배치 때
 * 비단조가 되므로 `YYYYMMDDHHMM_name.sql` 로 고정돼 있고, 정렬은 문자열 정렬로 충분하다.
 *
 * **소유자 롤로 실행한다.** `DATABASE_MIGRATION_URL`(없으면 `DATABASE_URL`)을 쓴다.
 * 네 번째 마이그레이션이 `atmark_app` 롤에 GRANT 하고, **그 롤이 없으면 실패하는 것이
 * 의도된 동작이다** — 권한 부여를 조용히 건너뛴 DB 는 audit 불변성·append-only·상태 전이
 * 가드가 하나도 집행되지 않는 상태로 "성공" 을 보고한다. 그래서 **이 러너는 롤을 만들지
 * 않는다.** 없으면 만드는 방법을 알려 주고 멈춘다.
 *
 * **체크섬을 기록하고 대조한다.** 이미 적용된 파일이 나중에 바뀌면 그 DB 의 실제 스키마는
 * 리포의 SQL 과 다른데 이력은 같다고 말한다. 마이그레이션은 append-only 다 — 고칠 것이
 * 있으면 새 파일을 만든다.
 *
 * **비트랜잭션 파일**(메일 기본기 1차 수정 — 코드 리뷰 H1·M2). 기본은 "파일 하나 = 트랜잭션 하나" 다. 첫 줄이
 * `-- atmark:no-transaction` 인 파일만 BEGIN/COMMIT 없이 돈다 — `CREATE INDEX CONCURRENTLY` 는 트랜잭션 안에서 돌 수 없고,
 * 비동시 빌드는 바쁜 표(수신·웹훅 outbox)의 쓰기를 빌드 내내 막는다. 트랜잭션이 없으면 "실패하면 아무것도 바뀌지 않는다" 가
 * 사라지므로 이런 파일에는 **문장 하나만** 허용한다(`noTransactionStatementOf`):
 *   `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <이름> ON <표> …;` — 주석 줄 말고는 이것뿐.
 * 규칙:
 *   - **형식은 대기 중인 파일만, 적용 전에 전부 본다.** 대기 중인 파일 하나라도 틀리면 아무것도 적용하지 않고 멈춘다. 이미 적용된
 *     파일은 보지 않는다(재검토 N4-a) — 그 파일은 체크섬이 지킨다. 형식 규칙이 나중에 좁아져도 운영 DB 의 배포가 옛 파일 때문에 서지 않게
 *     한다. 리포 전체가 형식을 지키는지는 `test/integration/db/migrate-runner.test.ts` 가 본다.
 *   - **잠금 대기 상한은 러너가 건다.** `SET LOCAL` 은 트랜잭션 밖에서 뜻이 없어서, 러너가 세션에 `lock_timeout`
 *     (`NO_TRANSACTION_LOCK_TIMEOUT` = 60초)을 걸고 `statement_timeout` 을 끈 뒤(빌드는 풀의 10초보다 길 수 있다) 끝나면 되돌린다.
 *     `CONCURRENTLY` 의 대기(SHARE UPDATE EXCLUSIVE · 앞선 트랜잭션 끝나기 = virtualxid 잠금)는 쓰기를 막지 않으므로 트랜잭션 파일의
 *     5초보다 길게 기다린다(재검토 N4-b) — 5초면 바쁜 운영 DB 에서 긴 읽기 하나에도 55P03 으로 멈춘다. virtualxid 대기 중 55P03 이
 *     나면 Postgres 는 INVALID 색인을 남기고, 다음 실행이 아래 규칙대로 치운다.
 *   - **실패가 남긴 INVALID 색인은 다음 실행에서 치운다.** 빌드가 중간에 죽으면 Postgres 는 `indisvalid = false` 인 색인을
 *     남기고, `IF NOT EXISTS` 는 그 이름을 보고 건너뛴다(쓸모없는 색인이 "성공" 한다). 그래서 러너는 먼저 그 이름의 색인이
 *     INVALID 인지 보고, 그렇다면 `DROP INDEX CONCURRENTLY IF EXISTS` 뒤에 다시 만든다. 유효한 색인이 이미 있으면(빌드는 됐는데
 *     이력 기록 전에 죽은 경우) `IF NOT EXISTS` 가 건너뛰고 이력만 적는다.
 *   - **만든 뒤 확인한다.** 그 이름이 **그 표의 유효한 색인**이 아니면(다른 관계가 이름을 쥐고 있어 `IF NOT EXISTS` 가 건너뛴 경우)
 *     던지고 이력을 적지 않는다.
 *   - 이력(`schema_migrations`)은 성공한 뒤에만 한 줄 — 체크섬 대조는 트랜잭션 파일과 같다.
 * 표의 기존 행을 훑는 제약은 `NOT VALID` 로 더하고 `VALIDATE CONSTRAINT` 를 다음 파일로 둔다(트랜잭션 파일이지만 쓰기를 막지 않는 잠금이다).
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Pool, PoolClient } from 'pg';

import { createPool, migrationDatabaseUrl, type Queryable } from './client';

/** 앱 롤 이름. 마이그레이션 4의 `DO $$` 블록이 이 이름을 찾는다. */
export const APP_ROLE = 'atmark_app';

/** admin Lambda 의 DB 롤(ADR-0006). 마이그레이션 202609230720 이 GRANT 한다(없으면 멈춘다). */
export const ADMIN_ROLE_NAME = 'atmark_admin';

/** 로그인 메일 Lambda 의 DB 롤(ADR-0006). 마이그레이션 202609230720 이 GRANT 한다(없으면 멈춘다). */
export const LOGIN_MAILER_ROLE_NAME = 'atmark_login_mailer';

/** passport 서명 Lambda 의 DB 롤(계약 §3 T4). 마이그레이션 202609241200 이 GRANT 한다(없으면 멈춘다). */
export const PASSPORT_SIGNER_ROLE_NAME = 'atmark_passport_signer';

/** 투명성 로그 서열기·에폭·게시 Lambda 의 DB 롤(ADR-0008, US-010). 마이그레이션 202609241600 이 GRANT 한다(없으면 멈춘다). */
export const TLOG_ROLE_NAME = 'atmark_tlog';

/** 투명성 로그 외부 앵커 Lambda 의 DB 롤(ADR-0008 Phase B). 마이그레이션 202609241600 이 GRANT 한다(없으면 멈춘다). */
export const TLOG_ANCHOR_ROLE_NAME = 'atmark_tlog_anchor';

/** 결제 동기화 Lambda(billing-sync)의 DB 롤(WP-2, ADR-0012). 마이그레이션 202609250400 이 GRANT 한다(없으면 멈춘다). */
export const BILLING_ROLE_NAME = 'atmark_billing';

/** 결제 운영자 CLI(`pnpm admin:plan`)의 DB 롤(WP-2, ADR-0012). 마이그레이션 202609250400 이 GRANT 한다(없으면 멈춘다). */
export const BILLING_OPERATOR_ROLE_NAME = 'atmark_billing_operator';

/** 호스팅 운영자 콘솔(ops.atmark.ai, ADR-0015 초안)의 DB 롤 — 읽기와 정의 함수 EXECUTE 만. 도메인 표 쓰기 0. */
export const OPS_ROLE_NAME = 'atmark_ops';

/**
 * 고객 도메인 확인 틱의 DB 롤(ADR-0014 · 보안 M2) — `custom_domains` 의 상태·확인·사가 칸을 고치는 유일한 롤. 마이그레이션 202609291100 이
 * GRANT 한다(없으면 멈춘다). 단계 0 에서는 `bootstrap-roles` 가 **NOLOGIN** 으로만 만든다(비밀 없음 — 단계 2 가 비밀과 LOGIN 을 붙인다).
 */
export const DOMAIN_TICK_ROLE_NAME = 'atmark_domain_tick';

/**
 * AI 의심 메일 감시 결과 λ 의 DB 롤(ADR-0017 초안) — 정의 함수 둘(`ai_watch_record_verdict`·`ai_watch_record_heartbeat`) EXECUTE 만, 표 권한 0.
 * 마이그레이션 202610061100 이 GRANT 한다(없으면 멈춘다). 이름은 계약 `AI_WATCH_DB_ROLE` 과 같다(단위 테스트가 대조).
 */
export const AI_WATCH_ROLE_NAME = 'atmark_ai_watch';

const RESTRICTED_ROLES = [
  ADMIN_ROLE_NAME,
  LOGIN_MAILER_ROLE_NAME,
  PASSPORT_SIGNER_ROLE_NAME,
  TLOG_ROLE_NAME,
  TLOG_ANCHOR_ROLE_NAME,
  BILLING_ROLE_NAME,
  BILLING_OPERATOR_ROLE_NAME,
  OPS_ROLE_NAME,
  DOMAIN_TICK_ROLE_NAME,
  AI_WATCH_ROLE_NAME,
] as const;

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** 마이그레이션 파일 한 장. */
export interface MigrationFile {
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

/** 적용 결과 — 이번 실행에서 실제로 적용한 것과 이미 적용돼 있던 것. */
export interface MigrationReport {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

/** 비트랜잭션 파일의 첫 줄 지시자. 첫 줄에만 쓸 수 있다. */
export const NO_TRANSACTION_DIRECTIVE = '-- atmark:no-transaction';

/**
 * 비트랜잭션 파일의 잠금 대기 상한(재검토 N4-b). 트랜잭션 파일의 `'5s'` 보다 길다 — `CONCURRENTLY` 는 쓰기를 막지 않고 기다리므로(앞선
 * 트랜잭션이 끝나기를 virtualxid 잠금으로 기다린다) 짧게 끊을 이유가 없고, 짧으면 긴 읽기 하나에 멈춰 INVALID 색인만 남긴다.
 */
export const NO_TRANSACTION_LOCK_TIMEOUT = '60s';

/** `migrate` 의 선택 — 테스트가 비트랜잭션 파일의 잠금 대기 상한을 줄인다(55P03 경로를 60초 기다리지 않고 본다). */
export interface MigrateOptions {
  readonly noTransactionLockTimeout?: string;
}

/**
 * 비트랜잭션 파일이 허용하는 유일한 문장. 주석 줄을 뺀 본문 전체가 이것이어야 한다 — `;` 는 끝에 하나뿐이다(두 문장 금지).
 * 이름·표는 따옴표 없는 소문자 식별자만(러너가 그 이름으로 INVALID 색인을 찾고 지운다).
 */
const NO_TRANSACTION_STATEMENT =
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\s+ON\s+(?:public\.)?([a-z_][a-z0-9_]*)\s[^;]*;$/s;

/** 비트랜잭션 파일 한 장의 문장 — 만들 색인과 그 표. */
export interface NoTransactionStatement {
  readonly indexName: string;
  readonly table: string;
}

/** 마이그레이션 파일 형식이 러너 규칙을 어겼다. 적용을 시작하기 전에 던진다. */
export class MigrationFormatError extends Error {
  constructor(filename: string, detail: string) {
    super(`마이그레이션 ${filename} 형식 오류: ${detail}`);
    this.name = 'MigrationFormatError';
  }
}

/** 비트랜잭션 색인이 만들어진 뒤에도 그 표의 유효한 색인이 아니다. 이력을 적지 않는다. */
export class MigrationIndexNotBuiltError extends Error {
  constructor(filename: string, indexName: string, table: string) {
    super(
      `마이그레이션 ${filename}: 색인 ${indexName} 이 표 ${table} 의 유효한 색인이 아니다 — 같은 이름의 다른 관계가 있거나 빌드가 끝나지 않았다. ` +
        '원인을 확인하고 다시 돌려라(INVALID 색인은 다음 실행이 치운다).',
    );
    this.name = 'MigrationIndexNotBuiltError';
  }
}

/** 주석 줄(`--` 로 시작)을 뺀 본문. 비트랜잭션 문장에는 줄 끝 주석·블록 주석을 쓰지 않는다(아래에서 거부). */
function bodyOf(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim();
}

/**
 * 파일의 실행 방식을 정한다. 지시자가 없으면 `null`(트랜잭션 파일), 있으면 그 문장. 규칙을 어기면 `MigrationFormatError`:
 *   - 지시자는 첫 줄에만 — 다른 줄에 있으면 파일을 읽는 사람과 러너가 다르게 이해한다.
 *   - 트랜잭션 파일의 본문에 `CONCURRENTLY` 가 있으면 거부한다(트랜잭션 안에서 실패한다 — 지시자를 잊은 것이다).
 *   - 비트랜잭션 파일의 본문은 `NO_TRANSACTION_STATEMENT` 하나뿐이다.
 */
export function noTransactionStatementOf(migration: Pick<MigrationFile, 'filename' | 'sql'>): NoTransactionStatement | null {
  const lines = migration.sql.split('\n');
  const directiveLines = lines.flatMap((line, index) => (line.trim() === NO_TRANSACTION_DIRECTIVE ? [index] : []));
  const body = bodyOf(migration.sql);
  if (directiveLines.length === 0) {
    if (/\bCONCURRENTLY\b/i.test(body)) {
      throw new MigrationFormatError(migration.filename, `CONCURRENTLY 는 트랜잭션 안에서 돌 수 없다 — 첫 줄에 ${NO_TRANSACTION_DIRECTIVE} 를 적어라.`);
    }
    return null;
  }
  if (directiveLines.length !== 1 || directiveLines[0] !== 0 || lines[0] !== NO_TRANSACTION_DIRECTIVE) {
    throw new MigrationFormatError(migration.filename, `${NO_TRANSACTION_DIRECTIVE} 는 첫 줄에 한 번만 쓴다.`);
  }
  const match = NO_TRANSACTION_STATEMENT.exec(body);
  if (match === null || body.includes('--') || body.includes('/*')) {
    throw new MigrationFormatError(
      migration.filename,
      '비트랜잭션 파일은 주석 줄과 문장 하나(`CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <이름> ON <표> …;`)뿐이어야 한다.',
    );
  }
  return { indexName: match[1] as string, table: match[2] as string };
}

/** 이미 적용된 파일이 사후에 바뀌었다. 새 파일을 만들어야 할 일을 파일 수정으로 했다는 뜻. */
export class MigrationChecksumMismatchError extends Error {
  constructor(filename: string) {
    super(
      `마이그레이션 ${filename} 의 내용이 적용 시점과 다르다. 마이그레이션은 append-only 다 — ` +
        '이미 적용된 파일을 고치지 말고 새 파일을 추가해라.',
    );
    this.name = 'MigrationChecksumMismatchError';
  }
}

export function loadMigrations(directory: string = MIGRATIONS_DIR): readonly MigrationFile[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(directory, filename), 'utf8');
      return { filename, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * 이력 테이블. **마이그레이션 4의 `REVOKE ALL ... FROM PUBLIC` 대상이 되어도 괜찮다** —
 * 이 테이블을 읽는 것은 소유자 롤뿐이고, `atmark_app` 이 자기 마이그레이션 이력을
 * 고칠 수 있어야 할 이유가 없다.
 */
async function ensureHistoryTable(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

interface HistoryRow extends Record<string, unknown> {
  filename: string;
  checksum: string;
}

interface IndexStateRow extends Record<string, unknown> {
  usable: boolean;
  table_name: string;
}

/** 이 이름의 색인(검색 경로 기준). 없으면 `null`. `usable` = 유효하고 준비됨(`CONCURRENTLY` 빌드가 끝까지 갔다). */
async function indexState(client: PoolClient, indexName: string): Promise<IndexStateRow | null> {
  const result = await client.query<IndexStateRow>(
    `SELECT (i.indisvalid AND i.indisready) AS usable, t.relname AS table_name
       FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
      WHERE i.indexrelid = to_regclass($1)`,
    [indexName],
  );
  return result.rows[0] ?? null;
}

/**
 * 비트랜잭션 파일 하나 — 머리말 "비트랜잭션 파일" 의 규칙. 세션 설정은 끝나면(실패해도) 들어올 때의 값으로 되돌린다.
 */
async function applyWithoutTransaction(
  client: PoolClient,
  migration: MigrationFile,
  statement: NoTransactionStatement,
  lockTimeout: string,
): Promise<void> {
  const previous = await client.query<{ lock_timeout: string; statement_timeout: string }>(
    `SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout`,
  );
  const saved = previous.rows[0];
  await client.query(`SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', '0', false)`, [lockTimeout]);
  try {
    const before = await indexState(client, statement.indexName);
    if (before !== null && !before.usable) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${statement.indexName}"`);
    }
    await client.query(migration.sql);
    const after = await indexState(client, statement.indexName);
    if (after === null || !after.usable || after.table_name !== statement.table) {
      throw new MigrationIndexNotBuiltError(migration.filename, statement.indexName, statement.table);
    }
    await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [migration.filename, migration.checksum]);
  } finally {
    if (saved !== undefined) {
      await client.query(`SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)`, [
        saved.lock_timeout,
        saved.statement_timeout,
      ]);
    }
  }
}

/**
 * 마이그레이션을 적용한다.
 *
 * **파일 하나 = 트랜잭션 하나다.** 여러 파일을 한 트랜잭션에 묶으면 중간에서 깨졌을 때
 * 이력이 통째로 사라져 "어디까지 적용됐는가" 를 파일 내용으로 추측하게 된다. 예외는 첫 줄 지시자가 있는
 * 비트랜잭션 파일뿐이다(머리말).
 */
export async function migrate(
  client: PoolClient,
  migrations: readonly MigrationFile[] = loadMigrations(),
  options: MigrateOptions = {},
): Promise<MigrationReport> {
  const lockTimeout = options.noTransactionLockTimeout ?? NO_TRANSACTION_LOCK_TIMEOUT;
  await ensureHistoryTable(client);

  const history = await client.query<HistoryRow>('SELECT filename, checksum FROM schema_migrations');
  const applied = new Map(history.rows.map((row) => [row.filename, row.checksum]));

  const justApplied: string[] = [];
  const alreadyApplied: string[] = [];

  // 형식은 **대기 중인 파일만**, 적용 전에 전부 본다(N4-a) — 틀린 파일이 뒤에 있으면 앞의 것도 적용하지 않는다. 적용된 파일은 체크섬이 지킨다.
  const modes = new Map(
    migrations.filter((migration) => !applied.has(migration.filename)).map((migration) => [migration.filename, noTransactionStatementOf(migration)]),
  );

  for (const migration of migrations) {
    const recorded = applied.get(migration.filename);
    if (recorded !== undefined) {
      if (recorded !== migration.checksum) throw new MigrationChecksumMismatchError(migration.filename);
      alreadyApplied.push(migration.filename);
      continue;
    }

    const noTransaction = modes.get(migration.filename) ?? null;
    if (noTransaction !== null) {
      await applyWithoutTransaction(client, migration, noTransaction, lockTimeout);
      justApplied.push(migration.filename);
      continue;
    }

    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
        migration.filename,
        migration.checksum,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    justApplied.push(migration.filename);
  }

  return { applied: justApplied, alreadyApplied };
}

/**
 * 앱 롤 부재를 사람이 고칠 수 있는 문장으로 바꾼다.
 *
 * **러너가 롤을 만들어 주지 않는 이유**: 러너가 만들면 그 롤은 마이그레이션이 도는 롤과
 * 같은 세션에서 태어나고, "앱 롤은 소유자가 아니다" 를 검사하는 마이그레이션 4의 단언이
 * 자기가 만든 것을 검사하는 꼴이 된다. 롤 프로비저닝은 CDK/RDS 의 일이다.
 */
export function appRoleMissingGuidance(): string {
  return [
    `롤 ${APP_ROLE} 가 없다. 마이그레이션은 이 롤에 GRANT 하므로 먼저 만들어야 한다.`,
    '러너는 롤을 만들지 않는다 — 앱 롤이 테이블 소유자가 되면 audit 불변성 트리거를 스스로 DROP 할 수 있다.',
    '',
    '  로컬 (소유자 = 현재 superuser, 앱 롤·제한 롤 둘은 별도 — 제한 롤은 202609230720 이 GRANT 한다, ADR-0006):',
    `    psql -d postgres -c "CREATE ROLE ${APP_ROLE} LOGIN PASSWORD 'atmark';"`,
    ...RESTRICTED_ROLES.map((role) => `    psql -d postgres -c "CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD 'atmark';"`),
    '',
    '  그 다음:',
    '    pnpm db:migrate        # DATABASE_MIGRATION_URL(소유자 롤)로 실행된다',
  ].join('\n');
}

function isAppRoleMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // 마이그레이션 4의 `RAISE EXCEPTION` 문구와 Postgres 자신의 GRANT 실패 문구
  // (`role "atmark_app" does not exist`)를 함께 잡는다 — 따옴표 유무만 다르다. 제한 롤 둘(202609230720)도 같다.
  return [APP_ROLE, ...RESTRICTED_ROLES].some((role) => new RegExp(`role "?${role}"?(, [a-z_]+)? does not exist`).test(error.message));
}

async function main(): Promise<void> {
  let pool: Pool | undefined;
  try {
    pool = createPool(migrationDatabaseUrl());
    const client = await pool.connect();
    try {
      const report = await migrate(client);
      for (const filename of report.alreadyApplied) console.log(`  = ${filename}`);
      for (const filename of report.applied) console.log(`  + ${filename}`);
      console.log(
        `\n적용 ${report.applied.length}건 / 기존 ${report.alreadyApplied.length}건 — schema_migrations 갱신됨.`,
      );
    } finally {
      client.release();
    }
  } catch (error) {
    if (isAppRoleMissing(error)) {
      console.error(`\n${appRoleMissingGuidance()}\n`);
    } else {
      console.error(`\n마이그레이션 실패: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}

// tsx 로 직접 실행됐을 때만 돈다. import 될 때는 아무 일도 하지 않는다.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
