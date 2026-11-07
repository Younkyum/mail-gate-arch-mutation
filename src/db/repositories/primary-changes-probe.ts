/**
 * src/db/repositories/primary-changes-probe.ts — 대표 주소 선택 표(`agent_primary_changes`, 202610021100)가 **있는가**.
 *
 * 잠든 앵커 술어(정책 소스 `usable` · 수신 조회)는 이 표를 읽는다. 표가 없는 스키마(그 마이그레이션 전 — 옛 스키마로 도는 스크래치 테스트 ·
 * 마이그레이션보다 먼저 뜬 새 코드)에서는 술어를 빼고 예전 질의를 보낸다(42P01 없음 — 그때는 선택 행이 있을 수 없으니 잠든 앵커도 없다).
 * 한 번 "있다" 를 보면 그 풀에서는 다시 묻지 않는다(표는 지워지지 않는다). "없다" 는 기억하지 않는다 — 마이그레이션 뒤 곧바로 술어가 켜진다.
 */

import type { Queryable } from '../client';

const present = new WeakMap<object, true>();

export async function hasPrimaryChanges(key: object, db: Queryable): Promise<boolean> {
  if (present.has(key)) return true;
  const result = await db.query<{ ok: boolean }>(`SELECT to_regclass('public.agent_primary_changes') IS NOT NULL AS ok`);
  if (result.rows[0]?.ok !== true) return false;
  present.set(key, true);
  return true;
}

/** 잠든 앵커 술어(SQL 조각) — `alias` 는 agent_addresses 의 별칭. 계약 `anchorDormantOf` 와 같다. */
export function dormantAnchorSql(alias: string): string {
  return `(${alias}.is_primary AND coalesce((SELECT p.address_id <> ${alias}.id FROM agent_primary_changes p WHERE p.agent_id = ${alias}.agent_id
                                             ORDER BY p.created_at DESC, p.id DESC LIMIT 1), false))`;
}
