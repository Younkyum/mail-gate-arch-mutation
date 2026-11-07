/**
 * src/db/repositories/login-code-attempt-retention.ts — **코드 verify 시도 원장 보존**(2026-09-28 보안 검토 L2·L3, 마이그레이션 202609280102).
 *
 * `login_code_attempts`(요청자 키 × 시각)는 상한 판정에 지난 15분만 쓴다. 하루 넘은 행은 SECURITY DEFINER `purge_login_code_attempts()` 가
 * 지운다 — 인자가 없어 무엇을 지울지 호출자가 고르지 못하고, 표의 DELETE 는 아무 롤에도 없다(admin 포함 — ADR-0006 admin DELETE 0).
 *
 * 누가 부르나: TTL 스위퍼(`workers/approval-expiry.ts`, EventBridge 5분 · 앱 롤). 앱 롤은 이 함수 EXECUTE 하나만 있고 표 권한은 0 이다
 * (`APP_FORBIDDEN_LOGIN_TABLES`). 한 번에 최대 10 000 행(함수 안 상한) — 넘치면 다음 스윕이 이어받는다.
 */

import type { Queryable } from '../client';

export interface LoginCodeAttemptRetention {
  /** 하루 넘은 시도 행을 지운다(최대 10 000). 지운 행 수. */
  purge(): Promise<number>;
}

export function createPostgresLoginCodeAttemptRetention(db: Queryable): LoginCodeAttemptRetention {
  return {
    async purge() {
      const result = await db.query<{ purged: number }>('SELECT purge_login_code_attempts() AS purged');
      return result.rows[0]?.purged ?? 0;
    },
  };
}
