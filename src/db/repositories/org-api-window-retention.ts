/**
 * src/db/repositories/org-api-window-retention.ts — **`/org-api` 창 행 보존**(ADR-0010 후속 L5, 마이그레이션 202609250200).
 *
 * `org_api_request_windows`(키 × 분 창 요청 수)는 상한 판정에 지금 창만 쓴다. 7일 넘은 행은 SECURITY DEFINER
 * `purge_org_api_request_windows()` 가 지운다 — 인자가 없어 무엇을 지울지 호출자가 고르지 못하고, DELETE 권한은 아무 롤에도 없다.
 *
 * 누가 부르나: TTL 스위퍼(`workers/approval-expiry.ts`, EventBridge 5분 · 앱 롤 — 스니펫 보존과 같은 스케줄). 앱 롤은 이 함수
 * EXECUTE 하나만 있고 표 권한은 0 이다. 한 번에 최대 10 000 행(함수 안 상한) — 넘치면 다음 스윕이 이어받는다.
 */

import type { Queryable } from '../client';

export interface OrgApiWindowRetention {
  /** 7일 넘은 창 행을 지운다(최대 10 000). 지운 행 수. */
  purge(): Promise<number>;
}

export function createPostgresOrgApiWindowRetention(db: Queryable): OrgApiWindowRetention {
  return {
    async purge() {
      const result = await db.query<{ purged: number }>('SELECT purge_org_api_request_windows() AS purged');
      return result.rows[0]?.purged ?? 0;
    },
  };
}
