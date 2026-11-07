/**
 * src/db/repositories/signup-link-retention.ts — **쓰이지 않은 가입 링크 보존**(ADR-0010 L7 후속 M2, 마이그레이션 202609250240).
 *
 * 가입 링크(`signup_links`)는 주소·조직 이름을 담는다. 쓰이지 않고 발송이 끝난 링크는 만료 30일 뒤 SECURITY DEFINER
 * `purge_expired_signup_links()` 가 지운다 — 인자가 없어 무엇을 지울지 호출자가 고르지 못하고, 표의 DELETE 는 소유자만 그 조건으로만
 * 된다(`signup_links_no_delete` → `signup_links_delete_guard`). 쓰인 링크는 계정의 가입 기록이라 계정과 함께 남는다.
 *
 * 누가 부르나: TTL 스위퍼(`workers/approval-expiry.ts`, 앱 롤 — 하루 창). 앱 롤은 이 함수 EXECUTE 하나만 있고 표 권한은 0 이다.
 */

import type { Queryable } from '../client';

export interface SignupLinkRetention {
  /** 만료 30일이 지난 쓰이지 않은 가입 링크를 지운다(최대 5 000). 지운 행 수. */
  purge(): Promise<number>;
}

export function createPostgresSignupLinkRetention(db: Queryable): SignupLinkRetention {
  return {
    async purge() {
      const result = await db.query<{ purged: number }>('SELECT purge_expired_signup_links() AS purged');
      return result.rows[0]?.purged ?? 0;
    },
  };
}
