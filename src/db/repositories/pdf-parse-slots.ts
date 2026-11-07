/**
 * src/db/repositories/pdf-parse-slots.ts — **PDF 해석 동시 실행 칸**(함대 전체 + 조직마다 하나). 첨부 내용 조회(`api/attachment-content.ts`)가
 * PDF 를 풀기 전에 칸을 잡고, 풀고 나면 놓는다.
 *
 * ---------------------------------------------------------------------------
 * ## 판단 기록
 * ---------------------------------------------------------------------------
 *
 * **① 왜 함대 전체의 상한인가.** PDF 해석은 워커 스레드의 힙·시간 상한 안에서 돌지만(`api/pdf-text-worker.ts`), 그 동안 API 함수 한 칸이
 *   최대 몇 초 · 수백 MB 를 쥔다. API 함수의 동시 실행은 모든 테넌트가 REST 와 /mcp 로 나눠 쓰는 8 칸이다 — 한 테넌트가 PDF 를 연달아
 *   부르면 다른 테넌트의 메일 보내기가 칸을 못 얻는다. 그래서 **PDF 가 쥘 수 있는 칸을 2 로** 묶는다. 인스턴스 안의 세마포어로는 안 된다
 *   (λ 인스턴스는 요청을 하나씩만 받는다 — 상한은 인스턴스 **사이**에 걸려야 한다). 공유 상태는 Postgres 뿐이다.
 *
 * **② 조직마다 하나(공정성).** 함대 칸 둘만 있으면 한 조직이 두 칸을 다 쥐고 다른 조직의 PDF 는 늘 `busy` 다. 그래서 함대 칸보다 **먼저**
 *   조직 칸(조직당 동시 1)을 시도한다 — 이미 그 조직이 PDF 하나를 풀고 있으면 함대 칸을 건드리지도 않고 `busy`. 조직은 에이전트 id 로
 *   SQL 안에서 찾는다(`agents.organization_id` — 호출자는 조직 id 를 들고 있지 않다). 둘째 키는 `hashtext(조직 uuid)` — 서로 다른 조직이
 *   같은 해시에 걸리면 둘이 한 칸을 나눠 쓸 뿐이다(드물고, 결과는 `busy` 한 번).
 *
 * **③ 세션 advisory 잠금, 기다리지 않는다(`pg_try_advisory_lock`).** 둘 다 잡혀 있으면 곧바로 `null` — 호출자는 "잠시 뒤 다시" 를 정상
 *   결과로 돌려준다(기다리는 요청이 칸을 붙잡지 않게 — `admin/ops/billing.ts` 의 체크아웃 잠금과 같은 규율). 세션 잠금은 잡은 연결에서만
 *   풀리므로 **전용 연결**(`pool.connect()`)을 해석 내내 쥔다(트랜잭션은 열지 않는다).
 *
 * **④ 잡은 연결은 풀로 돌려보내지 않는다.** 잡은 뒤 그 세션에 `idle_session_timeout = 30s` · `tcp_keepalives_idle = 10` 을 건다 —
 *   λ 가 해석 도중 얼거나 죽어 연결이 매달리면 서버가 30 초(유휴) 또는 keepalive 로 세션을 끊어 **칸이 풀린다**(해석은 5 초 상한이라
 *   정상 경로에서는 걸리지 않는다). 이 설정이 풀의 다른 요청으로 새지 않게, 놓을 때는 잠금을 다 풀고(`pg_advisory_unlock_all`)
 *   **연결째 버린다**(`release(true)`). 조직 칸만 잡고 함대 칸을 못 잡았을 때도 같다(연결이 끊기면 잠금도 풀린다). 아무 잠금도 잡지
 *   못한 연결만 풀로 돌려준다(설정도 걸지 않았다). 두 GUC 는 사용자 수준 설정이라 API 롤(`atmark_app`)이 바꿀 수 있다(PG 14+ — RDS 17).
 *   쥔 연결의 `'error'` 는 삼킨다 — 풀은 빌려 간 연결의 오류를 듣지 않아서, 서버가 쥔 세션을 끊으면 듣는 이 없는 `'error'` 가 프로세스를
 *   죽인다.
 *
 * **⑤ 던지지 않는다 — DB 오류도 `null`(→ `busy`).** 칸 잡기는 부가 장치다. 연결·질의가 실패했다고 첨부 조회가 500 이 되면 안 된다.
 *   잠금을 잡았을 수도 있는 연결은 버린다.
 *
 * **⑥ 키는 두 int4 형식 `(분류, 둘째 키)`.** 함대 칸은 `(PDF_PARSE_LOCK_CLASS, 칸 번호)`, 조직 칸은 `(PDF_PARSE_ORG_LOCK_CLASS, 조직 해시)` —
 *   분류가 달라 서로 부딪히지 않는다. 이 저장소의 다른 advisory 잠금은 전부 bigint 한 개 형식이다(`hashtextextended(…)` · tlog 의 상수).
 *   Postgres 는 두 형식을 **다른 키 공간**으로 둔다(`pg_locks.objsubid` 1 과 2). API 롤은 내장 함수라 따로 권한이 필요 없다(PUBLIC 실행).
 */

import type { Pool, PoolClient } from 'pg';

/** 'apdf' — 함대 칸의 첫 키(⑥). int4 범위 안이다. */
export const PDF_PARSE_LOCK_CLASS = 0x61706466;
/** 'apdo' — 조직 칸의 첫 키(②·⑥). 함대 칸과 다르다. */
export const PDF_PARSE_ORG_LOCK_CLASS = 0x6170646f;
/** 함대 전체 동시 PDF 해석 수(①). */
export const PDF_PARSE_SLOT_COUNT = 2;

export interface PdfParseSlot {
  /** 잠금을 풀고 연결을 버린다(④). 두 번 불러도 한 번만 한다. 던지지 않는다. */
  release(): Promise<void>;
}

export interface PdfParseSlots {
  /** 이 에이전트 조직의 칸과 함대 칸을 잡는다. 어느 쪽이든 없거나 DB 가 실패하면 `null`(기다리지 않는다 · 던지지 않는다). */
  tryAcquire(agentId: string): Promise<PdfParseSlot | null>;
}

export interface PdfParseSlotOptions {
  /** 테스트가 운영 키와 겹치지 않는 키 공간을 쓰려고 바꾼다(동시에 도는 다른 통합 테스트가 칸을 빼앗기지 않게). */
  readonly lockClass?: number;
  readonly orgLockClass?: number;
  readonly slots?: number;
  /** 잡은 세션의 `idle_session_timeout`(④). 테스트가 짧게 줄여 "매달린 세션이 끊기면 칸이 풀린다" 를 본다. */
  readonly idleSessionTimeout?: string;
}

/** 잡은 세션에만 거는 설정(④). */
const SESSION_GUARD_SQL = "SELECT set_config('idle_session_timeout', $1, false), set_config('tcp_keepalives_idle', '10', false)";

/** 쥔 연결을 서버가 끊어도(④의 유휴 종료) 프로세스가 죽지 않게 — 풀은 빌려 간 연결의 'error' 를 듣지 않는다. 연결은 어차피 버린다. */
const ignoreHeldClientError = (): void => undefined;

export function createPostgresPdfParseSlots(pool: Pool, options: PdfParseSlotOptions = {}): PdfParseSlots {
  const lockClass = options.lockClass ?? PDF_PARSE_LOCK_CLASS;
  const orgLockClass = options.orgLockClass ?? PDF_PARSE_ORG_LOCK_CLASS;
  const slots = options.slots ?? PDF_PARSE_SLOT_COUNT;
  const idleSessionTimeout = options.idleSessionTimeout ?? '30s';
  return {
    async tryAcquire(agentId) {
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch {
        return null; // ⑤
      }
      let slot = -1;
      try {
        const org = await client.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock($1::int4, hashtext(organization_id::text)) AS ok FROM agents WHERE id = $2',
          [orgLockClass, agentId],
        );
        if (org.rows[0]?.ok !== true) {
          client.release(); // 잠금도 설정도 없다 — 풀로 돌려준다.
          return null;
        }
        client.on('error', ignoreHeldClientError); // 여기부터는 모든 길이 연결을 버린다
        for (let candidate = 0; candidate < slots && slot < 0; candidate += 1) {
          const result = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::int4, $2::int4) AS ok', [lockClass, candidate]);
          if (result.rows[0]?.ok === true) slot = candidate;
        }
        if (slot >= 0) await client.query(SESSION_GUARD_SQL, [idleSessionTimeout]);
      } catch {
        client.release(true); // 잠금을 잡았을 수도 있다 — 연결째 버려 푼다(⑤).
        return null;
      }
      if (slot < 0) {
        client.release(true); // 조직 칸을 쥐고 있다 — 연결째 버려 푼다(④).
        return null;
      }
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            await client.query('SELECT pg_advisory_unlock_all()');
          } catch {
            // 연결을 버리면 어차피 풀린다.
          } finally {
            client.release(true); // 설정이 풀로 새지 않게(④).
          }
        },
      };
    },
  };
}
