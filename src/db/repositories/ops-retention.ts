/**
 * src/db/repositories/ops-retention.ts — 호스팅 운영자 콘솔(202609290500)의 **보존 · 요청 만료 · census**. TTL 스위퍼(`workers/approval-expiry.ts`,
 * 앱 롤 · 5분)가 부른다. 앱 롤은 함수 셋 EXECUTE 만 있고 ops 표 권한은 0 이다(`APP_FORBIDDEN_LOGIN_TABLES`, I-6) — 무엇을 지울지·만료할지
 * 호출자가 고르지 못한다(인자 없음).
 *
 *   - `purge_ops_login_records()` — 하루 넘은 도전·요청자 원장·step-up 허가, 30일 넘은(잠기지 않은) 주소 실패. 표마다 한 번에 10 000.
 *   - `expire_ops_requests()` — 7일 넘은 접근 요청 → expired.
 *   - `ops_operator_census()` — active · pending · 오늘 실패가 있는 주소 수 · 잠긴 주소 수(알람 #31 · #32). 주소·식별자는 없다(수만).
 *
 * **마이그레이션 전(함수 없음 42883 · 표 없음 42P01)에는 `null`** — 새 스위퍼가 migrate 보다 먼저 배포돼도(§5 2단계) 스위퍼가 실패하지 않는다(M1).
 */

import { sqlStateOf, type Queryable } from '../client';

export interface OpsCensus {
  readonly active: number;
  readonly pending: number;
  readonly addressesFailingToday: number;
  readonly addressesLocked: number;
}

export interface OpsRetention {
  /** 보존 — 지운 행 수. 마이그레이션 전이면 `null`. */
  purge(): Promise<number | null>;
  /** 7일 넘은 접근 요청을 expired 로 — 바꾼 수. 마이그레이션 전이면 `null`. */
  expire(): Promise<number | null>;
  /** census — 마이그레이션 전이면 `null`. */
  census(): Promise<OpsCensus | null>;
}

/** 마이그레이션 전의 모양(함수·표 없음). 그 밖의 오류(권한 42501 포함)는 그대로 던진다 — 권한이 빠진 배포는 조용히 넘기지 않는다. */
function notMigrated(error: unknown): boolean {
  const code = sqlStateOf(error);
  return code === '42883' || code === '42P01';
}

async function orNull<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (notMigrated(error)) return null;
    throw error;
  }
}

export function createPostgresOpsRetention(db: Queryable): OpsRetention {
  return {
    purge: () => orNull(async () => (await db.query<{ n: number }>('SELECT purge_ops_login_records() AS n')).rows[0]?.n ?? 0),
    expire: () => orNull(async () => (await db.query<{ n: number }>('SELECT expire_ops_requests() AS n')).rows[0]?.n ?? 0),
    census: () =>
      orNull(async () => {
        const row = (
          await db.query<{ active: number; pending: number; addresses_failing_today: number; addresses_locked: number }>(
            'SELECT active, pending, addresses_failing_today, addresses_locked FROM ops_operator_census()',
          )
        ).rows[0];
        return {
          active: row?.active ?? 0,
          pending: row?.pending ?? 0,
          addressesFailingToday: row?.addresses_failing_today ?? 0,
          addressesLocked: row?.addresses_locked ?? 0,
        };
      }),
  };
}
