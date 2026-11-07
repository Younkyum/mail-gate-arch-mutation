/**
 * test/support/legacy/review-organization-v0.ts — **동결본**. `ops-pre-p1`(= HEAD 314aded) 의 TS 검토 전이 구현을 그대로 옮겨 적었다
 * (`scripts/admin/org-review.ts` `reviewOrganizationOp` + `scripts/admin/plan.ts` `grantActivationPlanOp` + 그것이 부르는
 * `src/db/repositories/entitlements-write.ts` `writeEntitlementVersion` 의 경로). **고치지 않는다** — 차분 테스트
 * (`test/integration/ops/review-differential.test.ts`, 계획 M3)가 이것과 SQL 코어(`ops_org_activate_core` · `ops_org_reject_core`)를 같은 픽스처에서 돌려
 * 결과 DB 를 대조한다. 카탈로그 값(`PLAN_CATALOG` · `LIMIT_COLUMNS`)만 살아 있는 상수를 쓴다 — 값이 바뀌면 SQL 카탈로그도 같이 바뀌어야 하므로
 * 차분 테스트가 그 어긋남을 잡는다.
 *
 * 스키마 분기(표·제어 칸·늦은 두 칸이 없을 때)는 P1 스키마에서 늘 참이라 참인 쪽만 남겼다(동작 동일).
 */

import type { Pool } from 'pg';

import { AdminInputError } from '../../../src/admin/ops/errors';
import { LIMIT_COLUMNS, PLAN_CATALOG, type EntitlementLimits } from '../../../src/billing/plans';
import { withTransaction, type Queryable } from '../../../src/db/client';

export type ActivationGrantV0 =
  | { readonly granted: true; readonly fromPlan: string | null; readonly version: number }
  | { readonly granted: false; readonly reason: 'disabled' | 'kept'; readonly plan: string | null };

export interface ReviewOutcomeV0 {
  readonly from: string;
  readonly changed: boolean;
  readonly suspended: readonly string[];
  readonly revokedTokens: number;
  readonly plan: ActivationGrantV0 | null;
}

const ORGANIZATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ControlRow {
  plan_code: string;
  source: string;
  version: string;
  grace_until: Date | null;
  provider_override_allowed: boolean;
  [column: string]: unknown;
}

async function lockOrgEntitlements(db: Queryable, organizationId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('org_entitlements:' || $1::text, 0))`, [organizationId]);
}

async function loadControlRow(db: Queryable, organizationId: string): Promise<ControlRow | null> {
  const result = await db.query<ControlRow>(
    `SELECT organization_id, plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max,
            agent_per_minute_max, recipients_per_message_max, tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max,
            inbound_storage_bytes::text AS inbound_storage_bytes,
            (to_jsonb(org_entitlements) ->> 'aliases_per_agent_max')::integer AS aliases_per_agent_max,
            (to_jsonb(org_entitlements) ->> 'attachment_bytes_total_max')::integer AS attachment_bytes_total_max,
            grace_until, version::text AS version, created_at, updated_at, provider_override_allowed
       FROM org_entitlements WHERE organization_id = $1`,
    [organizationId],
  );
  return result.rows[0] ?? null;
}

function limitsFor(plan: 'beta'): EntitlementLimits {
  return PLAN_CATALOG[plan];
}

/** `writeEntitlementVersion` v0 — 베타 부여가 쓰는 입력(beta · operator · review · 유예 없음 · 넘기지 않음)만. 같은 행이면 쓰지 않는다. */
async function writeBetaV0(db: Queryable, organizationId: string, actor: string): Promise<{ changed: boolean; fromPlan: string | null; version: number }> {
  await lockOrgEntitlements(db, organizationId);
  const current = await loadControlRow(db, organizationId);
  const limits = limitsFor('beta');
  if (
    current !== null &&
    current.plan_code === 'beta' &&
    current.source === 'operator' &&
    LIMIT_COLUMNS.every(([key, column]) => current[column] !== null && Number(current[column]) === limits[key]) &&
    current.grace_until === null &&
    current.provider_override_allowed === false
  ) {
    return { changed: false, fromPlan: current.plan_code, version: Number(current.version) };
  }
  const version = current === null ? 1 : Number(current.version) + 1;
  await db.query(
    `INSERT INTO billing_audit (organization_id, from_plan, to_plan, cause, actor, note, entitlement_version) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [organizationId, current?.plan_code ?? null, 'beta', 'review', actor, 'review activation (BETA_ON_ACTIVATION)', version],
  );
  const columns = ['plan_code', 'source', 'cause', ...LIMIT_COLUMNS.map(([, column]) => column), 'grace_until', 'provider_override_allowed'];
  const values: unknown[] = ['beta', 'operator', 'review', ...LIMIT_COLUMNS.map(([key]) => limits[key]), null, false];
  const placeholder = (index: number): string => `$${String(index + 2)}`;
  if (current === null) {
    await db.query(
      `INSERT INTO org_entitlements (organization_id, ${columns.join(', ')}, version)
       VALUES ($1, ${columns.map((_column, index) => placeholder(index)).join(', ')}, 1)`,
      [organizationId, ...values],
    );
  } else {
    await db.query(
      `UPDATE org_entitlements
          SET ${columns.map((column, index) => `${column} = ${placeholder(index)}`).join(', ')}, version = version + 1
        WHERE organization_id = $1`,
      [organizationId, ...values],
    );
  }
  return { changed: true, fromPlan: current?.plan_code ?? null, version };
}

/** `grantActivationPlanOp` v0. */
export async function grantActivationPlanOpV0(client: Queryable, organizationId: string, actor: string, enabled: boolean): Promise<ActivationGrantV0> {
  if (!enabled) return { granted: false, reason: 'disabled', plan: null };
  await lockOrgEntitlements(client, organizationId);
  const current = await loadControlRow(client, organizationId);
  if (current !== null && !(current.plan_code === 'free' && current.source === 'default')) {
    return { granted: false, reason: 'kept', plan: current.plan_code };
  }
  const result = await writeBetaV0(client, organizationId, actor);
  return { granted: true, fromPlan: result.fromPlan, version: result.version };
}

/** `reviewOrganizationOp` v0 — 스위치(`BETA_ON_ACTIVATION`)는 인자로 받는다(차분 테스트가 끈 경우도 돌린다). */
export async function reviewOrganizationOpV0(
  pool: Pool,
  org: string,
  target: 'active' | 'rejected',
  actor: string,
  betaOnActivation: boolean,
): Promise<ReviewOutcomeV0> {
  if (!ORGANIZATION_ID_PATTERN.test(org)) throw new AdminInputError('조직 id(uuid)가 아니다.', 'invalid_organization');
  return withTransaction(pool, async (client): Promise<ReviewOutcomeV0> => {
    const current = await client.query<{ review_status: string }>('SELECT review_status FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [org]);
    const from = current.rows[0]?.review_status;
    if (from === undefined) throw new AdminInputError(`조직이 없다: ${org}`, 'organization_not_found');
    if (from === target) return { from, changed: false, suspended: [], revokedTokens: 0, plan: null };
    await client.query('UPDATE organizations SET review_status = $2, reviewed_at = now() WHERE id = $1', [org, target]);
    if (target === 'active') {
      const plan = await grantActivationPlanOpV0(client, org, actor, betaOnActivation);
      return { from, changed: true, suspended: [], revokedTokens: 0, plan };
    }
    const suspended = await client.query<{ id: string }>(
      `UPDATE agents SET status = 'suspended', suspended_by = 'operator'
        WHERE organization_id = $1 AND (status = 'active' OR (status = 'suspended' AND suspended_by = 'owner'))
        RETURNING id`,
      [org],
    );
    const revoked = await client.query(
      `UPDATE agent_api_keys SET revoked_at = now()
        WHERE revoked_at IS NULL AND agent_id IN (SELECT id FROM agents WHERE organization_id = $1)`,
      [org],
    );
    return { from, changed: true, suspended: suspended.rows.map((row) => row.id).sort(), revokedTokens: revoked.rowCount ?? 0, plan: null };
  });
}
