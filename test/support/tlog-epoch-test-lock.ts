/**
 * 에폭을 닫는 통합 테스트 파일끼리 **직렬화**한다 — 에폭 번호는 DB 전역 순번이라, 두 파일이 같은 로컬 DB 에서 동시에 에폭을 닫으면
 * "거부된 시도가 에폭을 만들지 않았다(max(epoch) = e)" 같은 단언이 이웃 파일 때문에 흔들린다(2026-09-25 test:coverage 에서 관찰).
 * 세션 advisory lock 하나를 파일 전체 동안 잡는다. 제품 코드의 에폭 잠금(`TLOG_ADVISORY_LOCK`, xact)과는 다른 키다.
 */
import type { Pool, PoolClient } from 'pg';

const EPOCH_TEST_LOCK = 7_300_925_001;

/**
 * 잠금을 기다리는 상한. 한 실행 안의 tlog 파일은 `vitest.config.ts` 의 `integration-tlog` 프로젝트가 **한 번에 하나씩** 돌리므로
 * 여기서 기다릴 일은 다른 실행(동시에 돈 `test:mod tlog` · 커버리지)뿐이다. 무한정 매달려 훅 시간 상한(300s)에 걸리는 대신 이 상한에서
 * **누가 쥐고 있는지** 적어 던진다. 호출하는 `beforeAll` 의 상한보다 짧아야 한다.
 */
export const EPOCH_TEST_LOCK_WAIT_MS = 240_000;

export async function holdEpochTestLock(owner: Pool, waitMs: number = EPOCH_TEST_LOCK_WAIT_MS): Promise<() => Promise<void>> {
  const client: PoolClient = await owner.connect();
  try {
    // 풀의 statement_timeout(10초)이 잠금 대기를 끊지 않게 — 이 연결에서만 끈다(세션 잠금 대기용 연결이다).
    await client.query('SET statement_timeout = 0');
    // 쥔 쪽을 pg_stat_activity 에서 알아볼 수 있게(시간 초과 메시지 · 수동 진단).
    await client.query(`SELECT set_config('application_name', $1, false)`, [`atmark-epoch-test-lock:${process.env['VITEST_POOL_ID'] ?? '?'}:${String(process.pid)}`]);
    // 막는 `pg_advisory_lock` 대신 짧은 try 를 되풀이한다 — 막힌 문장은 기다리는 내내 스냅숏을 쥔 트랜잭션이라, 같은 때 도는 이웃 파일의
    // `CREATE INDEX CONCURRENTLY`(migrate-runner)가 그 트랜잭션이 끝나기를 기다리다 시간 초과가 난다(vitest 4 의 파일 순서에서 재현).
    const deadline = Date.now() + waitMs;
    for (;;) {
      const attempt = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [EPOCH_TEST_LOCK]);
      if (attempt.rows[0]?.locked === true) break;
      if (Date.now() >= deadline) {
        const holders = await client.query<{ pid: number; application_name: string; held_s: string }>(
          `SELECT a.pid, a.application_name, round(extract(epoch FROM now() - a.backend_start))::text AS held_s
             FROM pg_locks l JOIN pg_stat_activity a USING (pid)
            WHERE l.locktype = 'advisory' AND l.granted AND l.classid = ($1::bigint >> 32)::oid AND l.objid = ($1::bigint & 4294967295)::oid`,
          [EPOCH_TEST_LOCK],
        );
        const who = holders.rows.map((row) => `pid ${String(row.pid)} (${row.application_name || '이름 없음'}, 연결 ${row.held_s}s)`).join(', ') || '알 수 없음';
        throw new Error(`tlog 에폭 테스트 잠금을 ${String(waitMs / 1000)}초 안에 얻지 못했다 — 쥔 쪽: ${who}. 같은 DB 에서 tlog 통합 테스트를 도는 다른 실행이 있는지 본다.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    // 얻지 못했으면 연결을 돌려준다 — 연결이 끊기면 혹시 얻은 세션 잠금도 함께 풀린다.
    client.release(true);
    throw error;
  }
  return async () => {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [EPOCH_TEST_LOCK]);
      await client.query('RESET statement_timeout');
      await client.query('RESET application_name');
    } finally {
      client.release();
    }
  };
}

/** `afterAll` 용 — `beforeAll` 이 중간에 실패해 만들지 못한 풀(undefined)은 건너뛰고 나머지를 닫는다(원인 오류를 가리는 TypeError 대신). */
export async function endPools(...pools: readonly (Pool | undefined)[]): Promise<void> {
  await Promise.all(pools.map((pool) => pool?.end()));
}

/** 같은 DB 의 다른 롤로 붙는 URL(비밀번호 없음). */
export function roleUrlOf(baseUrl: string, role: string): string {
  const url = new URL(baseUrl);
  url.username = role;
  url.password = '';
  return url.toString();
}
