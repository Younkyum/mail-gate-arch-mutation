/**
 * src/db/client.ts — Postgres 커넥션 풀. **DB 접속을 만드는 유일한 파일이다.**
 *
 * 여기 말고 다른 곳에서 `new Pool(...)` 을 부르면 풀이 둘이 되고, 그러면
 * `max` 도 `statement_timeout` 도 두 벌이 된다 — 그중 한 벌만 고쳐진 상태가
 * 곧 "스테이징에서는 안 나던 커넥션 고갈" 이다. 리포지토리는 전부 풀을 **주입받는다**.
 *
 * 기본값은 SSL 없음(로컬 Postgres)이고, `PGSSLMODE=require` 를 준 경우에만 TLS 를 켠다(운영 Lambda 는 CDK 가 준다) —
 * 로컬에서 SSL 을 강제하면 개발자가 연결 실패를 피하려고 `rejectUnauthorized: false`
 * 를 코드에 박게 되고, 그 한 줄이 운영으로 따라간다.
 *
 * **두 개의 접속 URL 을 구분한다** (계획 §4.3 · 마이그레이션 4의 소유권 단언):
 *   - `DATABASE_URL`            — 앱 롤 `atmark_app`. 테이블 소유자가 **아니다**.
 *   - `DATABASE_MIGRATION_URL`  — 소유자 롤. DDL 과 GRANT 를 실행한다.
 * 한 URL 로 합치면 앱이 테이블 소유자가 되고, 소유자는 audit 불변성 트리거를 DROP 할
 * 수 있다 — 마이그레이션 4가 그 상태를 명시적으로 거부하는 이유다.
 */

import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

/** 접속 설정이 없거나 형식이 아닌 경우. 읽을 수 없으면 아무것도 하지 않는다(fail closed). */
export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

/** 앱 롤 접속 문자열. */
const DATABASE_URL_ENV = 'DATABASE_URL';

/** 소유자 롤 접속 문자열. 없으면 `DATABASE_URL` 로 떨어진다(로컬 단일 롤 개발 편의). */
export const MIGRATION_DATABASE_URL_ENV = 'DATABASE_MIGRATION_URL';

/**
 * 쿼리를 받을 수 있는 것 — `Pool` 과 `PoolClient` 의 공통 부분.
 *
 * 리포지토리가 이 타입을 받는 이유는 테스트 편의가 아니라 **트랜잭션 때문**이다.
 * `PolicySource.load` 는 여러 조회를 한 트랜잭션에서 해야 하므로 풀이 아니라
 * 잡아 둔 커넥션 위에서 돌아야 하고, 같은 함수가 풀 위에서도 돌아야 한다.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** 환경변수에서 접속 문자열을 읽는다. 비어 있으면 던진다 — 기본값을 만들지 않는다. */
export function requireDatabaseUrl(
  variable: string = DATABASE_URL_ENV,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[variable];
  if (value === undefined || value.trim() === '') {
    throw new DatabaseConfigError(
      `${variable} 이 비어 있다. .env.example 을 .env 로 복사하고 로컬 Postgres URL 을 채워라 ` +
        `(예: postgres://atmark_app:atmark@localhost:5432/atmark).`,
    );
  }
  return value;
}

/** 마이그레이션용 접속 문자열. 없으면 앱 URL 로 떨어진다. */
export function migrationDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const owner = env[MIGRATION_DATABASE_URL_ENV];
  if (owner !== undefined && owner.trim() !== '') return owner;
  return requireDatabaseUrl(DATABASE_URL_ENV, env);
}

/**
 * 풀 하나를 만든다. **싱글턴이 아니다** — 만든 쪽이 닫을 책임을 진다.
 *
 * `statement_timeout` 을 기본으로 거는 이유: 관문은 발송 경로 위에 있고, 잠금 대기로
 * 무한정 매달린 쿼리는 워커 슬롯을 점유한 채 lease 만 만료시킨다. 그러면 다른 워커가
 * 같은 메시지를 다시 집는다 — 타임아웃 없는 쿼리가 중복 발송의 입구가 된다.
 */
export function createPool(connectionString: string, overrides: PoolConfig = {}): Pool {
  const ssl = process.env['PGSSLMODE'] === 'require' ? { rejectUnauthorized: true } : false;
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    ssl,
    ...overrides,
  });
}

/** `DATABASE_URL` 로 앱 롤 풀을 만든다. */
export function createAppPool(overrides: PoolConfig = {}): Pool {
  return createPool(requireDatabaseUrl(), overrides);
}

/**
 * 한 커넥션 위에서 트랜잭션을 돌린다. 예외가 나면 ROLLBACK 하고 그대로 던진다 —
 * **삼키지 않는다.** 정책 데이터를 반쯤 읽고 평가로 넘어가는 경로가 fail open 이다.
 */
export async function withTransaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
  beginStatement = 'BEGIN',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(beginStatement);
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // ROLLBACK 자체가 실패해도(커넥션이 이미 끊긴 경우) 원래 예외를 덮지 않는다.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** pg 오류의 SQLSTATE(`code`). 없거나 문자열이 아니면 `undefined`. */
export function sqlStateOf(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}
