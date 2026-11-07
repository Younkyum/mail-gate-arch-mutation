/**
 * src/db/repositories/injection-signal-retention.ts — **인젝션 구조 방어 신호의 보존**(ADR-0016, 마이그레이션 202610041000).
 *
 * 노출(`agent_exposures`) 8일 · 복사 지문(`inbound_fingerprints`) 30일 · 코드 지문(`agent_code_fingerprints`) 24시간 넘은 행을 SECURITY DEFINER
 * `purge_injection_signals()` 가 지운다 — 인자가 없어 무엇을 지울지 호출자가 고르지 못하고, 세 표의 DELETE 는 아무 롤에도 없다.
 *
 * 누가 부르나: TTL 스위퍼(`workers/approval-expiry.ts`, EventBridge 5분 · 앱 롤). 표마다 한 번에 최대 10 000 행 — 넘치면 다음 스윕이 이어받는다.
 * **마이그레이션 전(함수 없음 42883)이면 `null`** — 새 스위퍼가 migrate 보다 먼저 배포돼도 스위퍼가 실패하지 않는다(`ops-retention.ts` 와 같은 규율).
 */

import { sqlStateOf, type Queryable } from '../client';

export interface InjectionSignalRetention {
  /** 보존 기간을 넘긴 행을 지운다. 지운 행 수, 마이그레이션 전이면 `null`. */
  purge(): Promise<number | null>;
}

export function createPostgresInjectionSignalRetention(db: Queryable): InjectionSignalRetention {
  return {
    async purge() {
      try {
        const result = await db.query<{ purged: number }>('SELECT purge_injection_signals() AS purged');
        return result.rows[0]?.purged ?? 0;
      } catch (error) {
        if (sqlStateOf(error) === '42883') return null;
        throw error;
      }
    },
  };
}
