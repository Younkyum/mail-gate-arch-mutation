/**
 * test/support/entitlements.ts — 테스트용 `org_entitlements` 행 · 해석된 엔타이틀먼트(ADR-0011).
 *
 * 기존 정책 테스트의 가짜 소스는 **beta** 행을 싣는다 — beta 는 도입 전 한도 그대로라(에이전트 10 · 발송은 정책·워밍업이 정한다) 기존
 * 단언이 바뀌지 않는다. Free(행 없음) · 유예 만료는 각 테스트가 따로 싣는다.
 */

import { PLAN_CATALOG, resolveEntitlements, type Entitlements, type PlanCode } from '../../src/billing/plans';
import type { OrgEntitlementsRow } from '../../src/db/schema';

const AT = new Date('2026-09-25T00:00:00.000Z');

export function entitlementRow(plan: PlanCode = 'beta', overrides: Partial<OrgEntitlementsRow> = {}): OrgEntitlementsRow {
  const limits = PLAN_CATALOG[plan];
  return {
    organization_id: '00000000-0000-4000-8000-000000000000',
    plan_code: plan,
    source: 'default',
    cause: 'backfill',
    max_agents: limits.maxAgents,
    org_daily_recipients: limits.orgDailyRecipients,
    agent_per_day_max: limits.agentPerDayMax,
    agent_per_minute_max: limits.agentPerMinuteMax,
    recipients_per_message_max: limits.recipientsPerMessageMax,
    tokens_per_agent_max: limits.tokensPerAgentMax,
    webhook_endpoints_per_agent_max: limits.webhookEndpointsPerAgentMax,
    org_api_keys_max: limits.orgApiKeysMax,
    inbound_storage_bytes: String(limits.inboundStorageBytes),
    aliases_per_agent_max: limits.aliasesPerAgentMax,
    attachment_bytes_total_max: limits.attachmentBytesTotalMax,
    grace_until: null,
    version: '1',
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
}

/** 해석된 엔타이틀먼트(행 그대로 — 유예 없음). */
export function entitlementsOf(plan: PlanCode = 'beta'): Entitlements {
  return resolveEntitlements(entitlementRow(plan), AT);
}

/** `Queryable` 모양(풀·클라이언트) — src/db/client 를 끌어오지 않으려고 최소 모양만. */
interface Db {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/**
 * 통합 테스트용 — 조직에 요금제 행 하나(version 1 · 감사 행 함께). **소유자 롤 풀**로만 부른다(앱·admin 롤은 쓰기가 없다). 기존 조직이 백필로
 * 받은 모양(`default`/`backfill`)과 같다 — 도입 전 한도를 전제로 쓴 테스트의 조직은 `beta` 를 받는다.
 */
export async function grantPlan(owner: Db, organizationId: string, plan: PlanCode = 'beta', overrides: Partial<OrgEntitlementsRow> = {}): Promise<void> {
  const row = entitlementRow(plan, overrides);
  // 한 문장(= 한 트랜잭션) — 감사 행은 같은 트랜잭션에서 써야 짝이 된다(`org_entitlements_audited`: created_at = now()). 풀은 문장마다 다른
  // 연결을 줄 수 있어 BEGIN/COMMIT 을 따로 보내지 않는다.
  await owner.query(
    `WITH audit AS (
       INSERT INTO billing_audit (organization_id, from_plan, to_plan, cause, actor, entitlement_version) VALUES ($1, NULL, $2, 'backfill', 'test', 1)
     )
     INSERT INTO org_entitlements (organization_id, plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max, agent_per_minute_max,
       recipients_per_message_max, tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes,
       aliases_per_agent_max, attachment_bytes_total_max, grace_until, version)
     VALUES ($1, $2, 'default', 'backfill', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1)`,
    [
      organizationId,
      plan,
      row.max_agents,
      row.org_daily_recipients,
      row.agent_per_day_max,
      row.agent_per_minute_max,
      row.recipients_per_message_max,
      row.tokens_per_agent_max,
      row.webhook_endpoints_per_agent_max,
      row.org_api_keys_max,
      row.inbound_storage_bytes,
      row.aliases_per_agent_max,
      row.attachment_bytes_total_max,
      row.grace_until,
    ],
  );
}
