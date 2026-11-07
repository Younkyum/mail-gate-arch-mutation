/**
 * src/db/repositories/invited-user-erasure.ts — **초대만 받은 사용자 주소 지우기**(ADR-0010 후속 L7, 마이그레이션 202609250220).
 *
 * 초대받고 멤버가 된 적 없는 사용자 행의 주소를, 마지막 초대가 끝나고 30일 뒤 자리표시(`erased-<id>@erased.invalid`)로 바꾼다.
 * 행(id)은 남는다 — 감사·투명성 잎·초대 행이 id 로 가리킨다.
 *
 * 누가 부르나: TTL 스위퍼(`workers/approval-expiry.ts`, 앱 롤 — 하루 한 번으로 거른다). 앱 롤의 권한은 SECURITY DEFINER
 * `erase_invited_only_users(limit)` · `invited_user_erasure_backlog()` EXECUTE 둘이다 — 후보 선정과 조건 재검사가 전부 함수 안이라
 * 호출자가 사용자를 고르지 못하고, 크기는 함수가 1–500 으로 자른다. 표(users·org_invites) 권한은 0 이다.
 */

import type { Queryable } from '../client';

/** 한 번의 호출에서 지우기를 시도하는 최대 후보 수 — 함수 안 상한(500)과 같다. */
export const INVITED_USER_ERASURE_BATCH = 500;

export interface InvitedUserErasureResult {
  /** 주소를 지운 사용자 수. */
  readonly erased: number;
  /** 후보였지만 함수 안 재검사에서 조건이 어긋났거나(잠금·제약) 건너뛴 수. */
  readonly skipped: number;
}

export interface InvitedUserErasure {
  erase(limit: number): Promise<InvitedUserErasureResult>;
  /** 약속(30일)을 7일 넘긴 — 마지막 초대가 끝난 지 37일이 지났는데 아직 안 지운 — 사용자 수. 0 이 정상. */
  backlog(): Promise<number>;
}

export function createPostgresInvitedUserErasure(db: Queryable): InvitedUserErasure {
  return {
    async erase(limit) {
      const result = await db.query<{ erased: number; skipped: number }>('SELECT erased, skipped FROM erase_invited_only_users($1::int)', [limit]);
      const row = result.rows[0];
      return { erased: row?.erased ?? 0, skipped: row?.skipped ?? 0 };
    },
    async backlog() {
      const result = await db.query<{ backlog: number }>('SELECT invited_user_erasure_backlog() AS backlog');
      return result.rows[0]?.backlog ?? 0;
    },
  };
}
