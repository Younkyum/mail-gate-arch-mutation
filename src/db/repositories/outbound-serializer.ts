/**
 * src/db/repositories/outbound-serializer.ts — `DispatchSerializer` 의 Postgres 구현.
 * **R22 의 제동장치가 실제로 제동을 걸게 하는 것.**
 *
 * 평가~lease 구간은 교과서적인 check-then-act 다(근거는 `src/policy/gate.ts` 의
 * `DispatchSerializer` 주석). 여기서 하는 일은 그 구간을 **조직 단위로 직렬화**하는 것뿐이다.
 *
 * **`pg_advisory_xact_lock` 을 쓰는 이유.** 잠글 대상이 되는 행이 없다 —
 * 캡은 `messages` 여러 행의 합계이고, 이번 시도의 행은 아직 `pending` 이라 합계에
 * 들어가지도 않는다. `organizations` 행을 `FOR UPDATE` 로 잡는 선택지도 있지만 그러면
 * 읽기 트랜잭션을 쓰기 트랜잭션으로 승격해야 하고, 정책 읽기 경로 전체의 격리 수준이
 * 바뀐다. advisory lock 은 **아무 행도 건드리지 않으면서** 같은 상호배제를 준다.
 *
 * ---
 *
 * **왜 프로세스 내 큐가 함께 있는가 — 이것이 없으면 풀이 굶는다.**
 *
 * advisory lock 은 커넥션에 붙는다. 즉 잠금을 기다리는 시도는 **커넥션을 쥔 채** 기다린다.
 * 큐가 없으면 같은 조직의 동시 시도 N 개가 커넥션 N 개를 잡고, 그중 이긴 하나가
 * `run()` 안에서 정책을 읽으려고 **또 커넥션을 요청한다.** `max` 가 N 이하면 그 요청은
 * 영원히 오지 않는 커넥션을 기다리다 `connectionTimeoutMillis` 로 죽는다 — 캡을 지키려던
 * 잠금이 모든 발송을 죽이는 교착이 된다.
 *
 * 그래서 **조직당 한 번에 하나만** 잠금 커넥션을 잡게 큐를 세운다. 큐는 프로세스 안에서만
 * 유효하고 정확성의 근거가 아니다 — **정확성은 advisory lock 이 책임진다**(다중 프로세스).
 * 큐는 풀 안전장치다. 둘의 역할을 섞으면 람다가 여러 개 뜨는 순간 캡이 다시 열린다.
 */

import type { Pool, PoolClient } from 'pg';

import type { AgentId } from '../schema';
import { SerializationUnavailableError, type DispatchSerializer } from '../../policy/gate';
import { selectRow } from './rows';

/**
 * advisory lock 의 네임스페이스(classid). `0x4154` = ASCII `"AT"`.
 *
 * 두 인자 형태(`pg_advisory_xact_lock(int, int)`)를 쓰는 이유는 **충돌 분리**다.
 * 한 인자 형태는 64비트 공간을 다른 용도(배치 잡, 확장 모듈)와 공유하므로, 우연히
 * 같은 키를 쓰는 잠금이 생기면 발송이 무관한 작업 뒤에 줄을 선다. 그 증상은
 * "가끔 발송이 느리다" 로만 보이고 원인은 어디에도 안 적힌다.
 *
 * **export 하는 이유는 테스트다.** 잠금 경합을 재현하려면 다른 세션이 *같은* 키를 잡아야
 * 하는데, 테스트가 `0x4154` 를 베껴 적으면 네임스페이스를 바꾸는 날 그 테스트는 아무것도
 * 잡지 않은 채 초록으로 남는다.
 */
export const ADVISORY_LOCK_NAMESPACE = 0x4154;

interface OrganizationRef {
  organization_id: string;
}

/**
 * 잠글 조직을 찾는다. **잠금 커넥션을 잡기 전에**, 풀에서 빌렸다 곧바로 돌려주는
 * 조회로 한다 — 이 조회까지 잠금 커넥션 위에서 하면 조직당 큐를 세울 수가 없다
 * (키를 알아야 줄을 서는데, 키를 알려면 커넥션을 이미 쥐고 있어야 하는 순환).
 */
async function organizationOf(pool: Pool, agentId: AgentId): Promise<string> {
  let row: OrganizationRef | null;
  try {
    row = await selectRow<OrganizationRef>(
      pool,
      'SELECT organization_id FROM agents WHERE id = $1',
      [agentId],
    );
  } catch (error) {
    throw new SerializationUnavailableError(
      `잠글 조직을 찾지 못했다 (agentId=${agentId}). 잠그지 못한 채 보내지 않는다.`,
      { cause: error },
    );
  }
  if (row === null) {
    // 에이전트가 없으면 뒤이은 정책 읽기도 실패한다. 그래도 **여기서 끊는 편이 낫다** —
    // 잠그지 못한 이유가 "행이 없다" 인 것과 "DB 가 죽었다" 인 것은 사후 조사에서 다르다.
    throw new SerializationUnavailableError(`agents 행이 없다 (agentId=${agentId})`);
  }
  return row.organization_id;
}

export function createPostgresOutboundSerializer(pool: Pool): DispatchSerializer {
  /** 조직 → 그 조직의 마지막 시도가 끝나는 시점. 정착하면 지운다(무한 증식 방지). */
  const queues = new Map<string, Promise<void>>();

  /**
   * 잠금 **획득**(커넥션 대여 → `BEGIN` → `pg_advisory_xact_lock`)만 한다.
   *
   * 이 구간을 따로 뗀 이유가 갭 2 의 전부다. 예전에는 셋 다 `withOrganizationLock` 안에
   * 있었고 **날것의 pg 에러**를 던졌다. `gate.dispatch` 는 `SerializationUnavailableError`
   * **만** fail-closed `denied` + `evaluation_error` 로 바꾸고 나머지는 그대로 올리므로,
   * 가장 현실적인 두 실패 — **풀 고갈**(`connectionTimeoutMillis`)과 **잠금 대기
   * 타임아웃**(`statement_timeout`) — 이 그 클래스를 위해 만든 audit 경로를 통째로
   * 건너뛰었다. 메일 기준으로는 안 나가니 fail-closed 지만 **audit 행이 0개**였고,
   * 그건 Principle P3("조용한 거부는 없다")가 금지하는 상태다.
   *
   * 획득 실패 시 정리(ROLLBACK·release)까지 여기서 끝낸다 — 커넥션은 못 빌렸을 수도,
   * `BEGIN` 만 되어 있을 수도 있어서 호출부의 `finally` 하나로는 두 경우가 갈린다.
   */
  async function acquireOrganizationLock(organizationId: string): Promise<PoolClient> {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      // 풀 고갈. 잠그지 못했으므로 **보내지 않는다.**
      throw new SerializationUnavailableError(
        `잠금 커넥션을 빌리지 못했다 (organizationId=${organizationId}). 잠그지 못한 채 보내지 않는다.`,
        { cause: error },
      );
    }
    try {
      await client.query('BEGIN');
      // `hashtext` 는 int4 를 돌려준다. 해시 충돌은 **무해하다** — 서로 다른 두 조직이
      // 같은 잠금을 공유하면 불필요하게 줄을 설 뿐이고, 캡이 느슨해지는 방향이 아니다.
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        ADVISORY_LOCK_NAMESPACE,
        organizationId,
      ]);
      return client;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      throw new SerializationUnavailableError(
        `조직 잠금을 잡지 못했다 (organizationId=${organizationId}). 잠그지 못한 채 보내지 않는다.`,
        { cause: error },
      );
    }
  }

  async function withOrganizationLock<T>(organizationId: string, run: () => Promise<T>): Promise<T> {
    const client = await acquireOrganizationLock(organizationId);
    try {
      // ─── 경계: 여기부터 `SerializationUnavailableError` 로 감싸지 않는다 ───────────
      //
      // **`run()` 을 감싸면 안 된다.** 잠금은 이미 잡혔고, 여기서 나는 예외는 평가·lease·
      // audit 의 실패다. 그것을 "직렬화 실패" 로 둔갑시키면 관문이 `denied` +
      // `evaluation_error` audit 행을 쓰는데 — audit INSERT 가 실패해서 온 예외였다면
      // 그 쓰기도 실패한다. 갭 2 를 고치면서 **행을 남기지 못한 거부**를 새로 만드는 셈이다.
      // `gate.dispatch` 의 주석이 이 타입만 받는다고 못 박은 이유가 정확히 이것이다.
      const result = await run();
      // **COMMIT 도 감싸지 않는다.** 여기 도달했다는 것은 `run()` 이 이미 lease 를 잡고
      // audit 행을 **썼다**는 뜻이다(`gate.reserve` 가 잠금 안에서 둘 다 한다). COMMIT
      // 실패를 직렬화 실패로 바꾸면 그 메시지에 대해 audit 행이 둘이 되고, 앞의 행은
      // `allowed` 인데 뒤의 행은 `denied` 인 모순이 남는다 — §4.3 의 "시도당 정확히 1행"
      // 을 깨는 쪽이 더 나쁘다. P3 는 이미 만족돼 있다(행이 하나 있다).
      //
      // COMMIT 이 잠금을 푼다(`_xact_`). 명시적 unlock 이 없으므로 **경로가 어디로 빠지든
      // 잠금이 남지 않는다** — 세션 잠금이었다면 unlock 을 빠뜨린 경로 하나가 조직 전체를
      // 영구히 막는다.
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async serialize<T>(agentId: AgentId, run: () => Promise<T>): Promise<T> {
      const organizationId = await organizationOf(pool, agentId);

      const previous = queues.get(organizationId) ?? Promise.resolve();
      // 앞 시도의 **실패가 뒤를 막지 않는다.** `then(run, run)` 이 아니라 정착 프라미스를
      // 따로 두는 이유이기도 하다 — 큐에 들어가는 것은 결과가 아니라 "끝났다" 뿐이다.
      const attempt = previous.then(() => withOrganizationLock(organizationId, run));
      const settled = attempt.then(
        () => undefined,
        () => undefined,
      );
      queues.set(organizationId, settled);
      void settled.then(() => {
        if (queues.get(organizationId) === settled) queues.delete(organizationId);
      });

      return attempt;
    },
  };
}
