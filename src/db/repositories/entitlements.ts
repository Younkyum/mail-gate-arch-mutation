/**
 * src/db/repositories/entitlements.ts — `org_entitlements` **읽기**(202609250300, ADR-0011). 쓰기는 이 파일에 없다 — 앱·admin 롤은
 * 읽기만 하고(`RESTRICTED_ROLE_GRANTS`), 쓰기는 운영자 CLI(`scripts/admin/plan.ts`, 소유자 롤)와 WP-2 의 billing 롤뿐이다.
 *
 * **표가 아직 없으면 `table_missing`**(행 없음 = Free 와 다르다 — 해석은 도입 전 한도, `resolveEntitlements`). 새 코드가 마이그레이션보다
 * 먼저 배포된 몇 분(런북 deploy §20 — 순서 위반) 동안 조회가 `42P01` 로 트랜잭션을 깨뜨려 모든 발송이 `evaluation_error` 가 되지 않게,
 * 그리고 이미 승인된 봉투가 Free 한도로 영구 거부되지 않게 `to_regclass` 로 먼저 본다.
 */

import { ENTITLEMENTS_TABLE_MISSING, resolveEntitlements, type Entitlements, type EntitlementsTableMissing } from '../../billing/plans';
import type { Queryable } from '../client';
import type { OrgEntitlementsRow } from '../schema';
import { selectRow } from './rows';

/**
 * 읽는 칸. 메일 기본기 2차의 두 칸(202609270105)은 **행 JSON 에서** 꺼낸다 — 칸이 아직 없는 옛 스키마(새 코드가 마이그레이션보다 먼저 돈 몇 분)에서도
 * `42703` 없이 NULL 이 되고, 해석은 그 요금제의 카탈로그 값이다(`resolveEntitlements`). 표 이름으로 행을 가리키므로 `FROM org_entitlements` 에만 쓴다.
 */
export const ORG_ENTITLEMENTS_COLUMNS = `organization_id, plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max,
  agent_per_minute_max, recipients_per_message_max, tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max,
  inbound_storage_bytes::text AS inbound_storage_bytes,
  (to_jsonb(org_entitlements) ->> 'aliases_per_agent_max')::integer AS aliases_per_agent_max,
  (to_jsonb(org_entitlements) ->> 'attachment_bytes_total_max')::integer AS attachment_bytes_total_max,
  grace_until, version::text AS version, created_at, updated_at`;

/** 조직의 엔타이틀먼트 행. 행이 없으면 `null`, 표가 없으면 `'table_missing'`. */
export async function loadOrgEntitlementsRow(db: Queryable, organizationId: string): Promise<OrgEntitlementsRow | EntitlementsTableMissing | null> {
  const table = await selectRow<{ ok: boolean }>(db, `SELECT to_regclass('public.org_entitlements') IS NOT NULL AS ok`);
  if (table?.ok !== true) return ENTITLEMENTS_TABLE_MISSING;
  return selectRow<OrgEntitlementsRow>(db, `SELECT ${ORG_ENTITLEMENTS_COLUMNS} FROM org_entitlements WHERE organization_id = $1`, [organizationId]);
}

/** 조직의 **지금 적용할** 엔타이틀먼트(행이 없거나 유예가 끝났으면 Free · 천장으로 자른 값). */
export async function loadEntitlements(db: Queryable, organizationId: string, now: Date): Promise<Entitlements> {
  return resolveEntitlements(await loadOrgEntitlementsRow(db, organizationId), now);
}

/** 에이전트의 조직 엔타이틀먼트. 에이전트가 없으면 `null`(호출자가 404 를 정한다). */
export async function loadAgentEntitlements(db: Queryable, agentId: string, now: Date): Promise<Entitlements | null> {
  const agent = await selectRow<{ organization_id: string }>(db, 'SELECT organization_id FROM agents WHERE id = $1', [agentId]);
  if (agent === null) return null;
  return loadEntitlements(db, agent.organization_id, now);
}
