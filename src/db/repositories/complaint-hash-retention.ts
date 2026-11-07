/**
 * src/db/repositories/complaint-hash-retention.ts — **신고자 해시 보존**(공유 도메인 평판 · 재검증 I-1, 마이그레이션 202610131612 · 1614).
 *
 * `ses_events.complaint_recipient_hashes` · `complaint_domain_hashes`(신고자 · 신고 도메인 계열의 sha256)는 평판 창(7일)에만 필요하다. SECURITY DEFINER
 * `atmark_purge_complaint_hashes()`(인자 없음 · 한 번에 5 000)가 받은 지 8일 넘은 행의 두 칸을 NULL 로 만든다 — 호출자는 무엇을 지울지 고르지 못하고,
 * 앱 롤은 `ses_events` UPDATE 권한이 없다.
 *
 * 누가 부르나: TTL 스위퍼(`workers/approval-expiry.ts`, EventBridge 5분 · 앱 롤). **마이그레이션 전(함수 없음 42883)이면 `null`**(다른 보존과 같은 규율).
 */

import { sqlStateOf, type Queryable } from '../client';

export interface ComplaintHashRetention {
  /** 보존 기간을 넘긴 행의 해시를 지운다. 지운 행 수, 마이그레이션 전이면 `null`. */
  purge(): Promise<number | null>;
}

export function createPostgresComplaintHashRetention(db: Queryable): ComplaintHashRetention {
  return {
    async purge() {
      try {
        const result = await db.query<{ purged: number }>('SELECT atmark_purge_complaint_hashes() AS purged');
        return result.rows[0]?.purged ?? 0;
      } catch (error) {
        if (sqlStateOf(error) === '42883') return null;
        throw error;
      }
    },
  };
}
