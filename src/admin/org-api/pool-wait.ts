/**
 * src/admin/org-api/pool-wait.ts — **`/org-api` 요청의 DB 풀 대기 상한**(ADR-0010 후속 L5 ③).
 *
 * admin Lambda 는 콘솔과 `/org-api` 가 예약 동시성·풀(`ADMIN_POOL_MAX`)·DB 연결 예산을 함께 쓴다. CI 부하로 커넥션이 늦게 나오면
 * `/org-api` 요청이 기본 대기(`connectionTimeoutMillis` 5초) 동안 실행 환경을 쥐고 있는다. 그래서 `/org-api` 요청만 커넥션을
 * **`ORG_API_POOL_WAIT_MS` 안에** 못 받으면 503 `database_busy` 로 빨리 놓는다(콘솔 경로는 그대로 5초).
 *
 * **이것은 콘솔 굶주림을 막지 못한다**(적대적 검토 H1). 상한은 **호출 하나 안의** 대기를 5초에서 1초로 줄일 뿐이다 — 굶는 자원은 풀이
 * 아니라 **예약 동시성(실행 환경 3개)** 이고, 호출마다 새 풀 대기가 시작되므로 CI 가 동시성 3 을 계속 채우면 콘솔 호출은 여전히 스로틀된다.
 * 콘솔을 지키는 것은 API Gateway 천장(`CONSOLE_ROUTE_THROTTLES['ANY /org-api/{proxy+}']` — `$default` 의 절반 이하)이고, 올바른 해법은
 * DB 연결 예산을 다시 나눈 뒤의 org-api 전용 Lambda 다(ADR-0010 "L5 후속 — org-api 전용 Lambda"). 이 상한은 그 사이 한 호출이 실행 환경을
 * 쥐는 시간을 줄이는 보조 장치다.
 *
 * 풀 모양을 감싼다: `connect()` 는 상한과 경주하고(지면 늦게 온 커넥션은 받자마자 돌려준다), `query()` 는 그 `connect()` 로 빌려
 * 한 문장 돌리고 돌려준다. `withTransaction` 은 `connect()` 를 부르므로 트랜잭션도 같은 상한을 탄다.
 */

import type { Pool, PoolClient } from 'pg';

/** `/org-api` 요청이 풀에서 커넥션을 기다리는 최대 시간. */
const ORG_API_POOL_WAIT_MS = 1_000;

/** 상한 안에 커넥션을 받지 못했다 — 라우터가 503 `database_busy` 로 바꾼다. */
export class OrgApiPoolBusyError extends Error {
  constructor() {
    super(`DB 커넥션을 ${String(ORG_API_POOL_WAIT_MS)}ms 안에 받지 못했다`);
    this.name = 'OrgApiPoolBusyError';
  }
}

/** `pool` 을 대기 상한이 붙은 풀 모양으로. */
export function withPoolWaitCap(pool: Pool, waitMs: number = ORG_API_POOL_WAIT_MS): Pool {
  const connect = (): Promise<PoolClient> => {
    const pending = pool.connect();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // 늦게 온 커넥션은 받자마자 돌려준다(새지 않게). 늦게 온 실패는 삼킨다(이미 503 으로 답했다).
        pending.then((client) => client.release(), () => undefined);
        reject(new OrgApiPoolBusyError());
      }, waitMs);
    });
    return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
  };
  const query = async (...args: unknown[]): Promise<unknown> => {
    const client = await connect();
    try {
      return await (client.query as (...values: unknown[]) => Promise<unknown>)(...args);
    } finally {
      client.release();
    }
  };
  return { connect, query } as unknown as Pool;
}
