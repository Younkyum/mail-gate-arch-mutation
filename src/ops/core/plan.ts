/**
 * src/ops/core/plan.ts — 조직 **요금제(엔타이틀먼트) 쓰기 연산**(ADR-0011 · ADR-0012). `scripts/admin/plan.ts` 에서 옮겼다(P0,
 * `.omc/plans/ops-console.md` §3.9). CLI(`pnpm admin:plan`) · 로컬 운영자 화면(`pnpm ops`) · 검토 활성화의 베타 부여가 **이 함수들**을 부른다.
 * 동작은 그대로다 — 호출자가 고른 롤 풀(결제 운영자 롤, 베타 부여는 소유자 롤)로 부른다. 호스팅 콘솔(`src/ops/hosted/**`)의 폐포에는
 * 들어가지 않는다(arch §3.9 — `writeEntitlementVersion` 금지).
 *
 * 한 번의 변경 = 한 트랜잭션: 조직 요금제 잠금 → 지금 행 → `writeEntitlementVersion`(같으면 쓰지 않는다 · 감사 행 · v1/v+1). 조직 행은 잠그지 않는다 —
 * 결제 운영자 롤은 조직 행 UPDATE 권한이 없어 `FOR UPDATE` 를 못 하고, 존재만 `SELECT id` 로 본다.
 */

import type { Pool } from 'pg';

import { ORGANIZATION_ID_PATTERN } from '../../admin/ops/agents';
import { AdminInputError } from '../../admin/ops/errors';
import {
  ENTITLEMENT_CEILINGS,
  ENTITLEMENTS_TABLE_MISSING,
  isPlanCode,
  LIMIT_COLUMNS,
  PLAN_CATALOG,
  type EntitlementLimits,
  type PlanCode,
} from '../../billing/plans';
import { withTransaction, type Queryable } from '../../db/client';
import {
  EntitlementsNotMigratedError,
  loadOrgEntitlementsControlRow,
  lockOrgEntitlements,
  writeEntitlementVersion,
  type EntitlementWriteInput,
  type EntitlementWriteResult,
} from '../../db/repositories/entitlements-write';
import type { OrgEntitlementsControlRow } from '../../db/schema';

const COLUMN_TO_KEY = new Map(LIMIT_COLUMNS.map(([key, column]) => [column, key] as const));

/** 샌드박스 되돌리기가 줄 수 있는 요금제 — 결제 전 상태(행 없음 = free · 베타 기간의 활성 조직 = beta). */
export const SANDBOX_REVERT_PLANS = ['free', 'beta'] as const;
export type SandboxRevertPlan = (typeof SANDBOX_REVERT_PLANS)[number];

export interface PlanChangeInput {
  readonly organizationId: string;
  readonly plan: PlanCode;
  /** 칸 이름(snake) → 값. 요금제 기본값 위의 덮어쓰기. */
  readonly overrides: Readonly<Record<string, number>>;
  /** `undefined` = 요금제가 같으면 지금 값을 둔다 · `null` = 없앤다 · Date = 그 시각. */
  readonly graceUntil: Date | null | undefined;
  readonly actor: string;
  readonly note: string | null;
}

export type PlanChangeResult = EntitlementWriteResult;

/** `--set 칸=값` → 덮어쓰기. 모르는 칸 · 정수 아님 · 천장 초과는 거부(exit 2). */
export function parseOverrides(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of values) {
    const match = /^([a-z_]+)=(\d{1,13})$/.exec(raw.trim());
    if (match === null) throw new AdminInputError(`--set 은 칸=정수: ${raw}`, 'invalid_override');
    const column = match[1] as string;
    const key = COLUMN_TO_KEY.get(column);
    if (key === undefined) throw new AdminInputError(`모르는 칸: ${column} (가능: ${LIMIT_COLUMNS.map(([, c]) => c).join(', ')})`, 'invalid_override');
    const value = Number(match[2]);
    if (value > ENTITLEMENT_CEILINGS[key]) {
      throw new AdminInputError(`${column}=${String(value)} 은 코드 천장 ${String(ENTITLEMENT_CEILINGS[key])} 을 넘는다 — 천장은 코드·리뷰로만 올린다.`, 'over_ceiling');
    }
    out[column] = value;
  }
  return out;
}

/** 요금제 기본값 + 덮어쓰기 → 한도. */
export function limitsFor(plan: PlanCode, overrides: Readonly<Record<string, number>>): EntitlementLimits {
  const base: EntitlementLimits = PLAN_CATALOG[plan];
  return Object.fromEntries(LIMIT_COLUMNS.map(([key, column]) => [key, overrides[column] ?? base[key]])) as unknown as EntitlementLimits;
}

/** 지금 행의 한도(칸 → 카멜). */
function limitsOfRow(row: OrgEntitlementsControlRow): EntitlementLimits {
  const record = row as unknown as Record<string, unknown>;
  return Object.fromEntries(LIMIT_COLUMNS.map(([key, column]) => [key, Number(record[column])])) as unknown as EntitlementLimits;
}

/** 조직 존재 확인(조직 행 잠금 없이 — 운영자 롤은 `organizations.id` SELECT 만 가진다). */
async function requireOrganization(client: Queryable, organizationId: string): Promise<void> {
  if (!ORGANIZATION_ID_PATTERN.test(organizationId)) throw new AdminInputError('조직 id(uuid)가 아니다.', 'invalid_organization');
  const org = await client.query('SELECT id FROM organizations WHERE id = $1', [organizationId]);
  if (org.rowCount === 0) throw new AdminInputError(`조직이 없다: ${organizationId}`, 'organization_not_found');
}

/** 잠금 뒤 지금 행. 표가 없으면(마이그레이션 전) 쓰지 않는다 — 런북 deploy §20: 마이그레이션이 먼저다. */
async function lockedRow(client: Queryable, organizationId: string): Promise<OrgEntitlementsControlRow | null> {
  await lockOrgEntitlements(client, organizationId);
  const current = await loadOrgEntitlementsControlRow(client, organizationId);
  if (current === ENTITLEMENTS_TABLE_MISSING) {
    throw new AdminInputError('org_entitlements 표가 없다 — 마이그레이션 202609250300 을 먼저 적용한다(런북 deploy §20).', 'entitlements_table_missing');
  }
  return current;
}

/** 운영자 출처 쓰기 — 이 파일의 세 연산은 출처·원인이 늘 `operator` 이고 공급자 이벤트가 없다. */
async function write(
  client: Queryable,
  input: Omit<EntitlementWriteInput, 'source' | 'cause' | 'providerEventId'>,
): Promise<EntitlementWriteResult> {
  try {
    return await writeEntitlementVersion(client, { ...input, source: 'operator', cause: 'operator', providerEventId: null });
  } catch (error) {
    if (error instanceof EntitlementsNotMigratedError) throw new AdminInputError(error.message, 'entitlements_table_missing');
    throw error;
  }
}

/**
 * 요금제 바꾸기 — 한 트랜잭션(요금제 잠금 · 엔타이틀먼트 행 · 감사 행). 아무것도 달라지지 않으면 쓰지 않는다(`changed: false`). 새 행은 넘기지
 * 않은 상태(`provider_override_allowed = false`) — 넘긴 행에 `--plan` 을 다시 주면 넘김이 풀린다. 운영자 롤 풀로 부른다(테스트는 소유자 풀도 쓴다).
 */
export async function setOrgPlanOp(pool: Pool, input: PlanChangeInput): Promise<PlanChangeResult> {
  return withTransaction(pool, async (client) => {
    await requireOrganization(client, input.organizationId);
    const current = await lockedRow(client, input.organizationId);
    const graceUntil =
      input.graceUntil !== undefined ? input.graceUntil : current !== null && current.plan_code === input.plan ? current.grace_until : null;
    return write(client, {
      organizationId: input.organizationId,
      plan: input.plan,
      limits: limitsFor(input.plan, input.overrides),
      graceUntil,
      providerOverrideAllowed: false,
      actor: input.actor,
      note: input.note,
    });
  });
}

/**
 * `--release-to-provider`(D-3) — 운영자·백필 행을 결제에 넘긴다: 요금제·한도·유예는 그대로, `provider_override_allowed = true`, v+1, 감사 note
 * `release_to_provider`. 이미 넘긴 행이면 쓰지 않는다. 행이 없거나(결제가 그냥 INSERT 한다) provider 행이면(이미 결제 소관) 거부.
 */
export async function releaseToProviderOp(pool: Pool, input: { readonly organizationId: string; readonly actor: string }): Promise<PlanChangeResult> {
  return withTransaction(pool, async (client) => {
    await requireOrganization(client, input.organizationId);
    const current = await lockedRow(client, input.organizationId);
    if (current === null) throw new AdminInputError('요금제 행이 없다(= free) — 넘길 운영자 결정이 없다. 결제가 행을 새로 만든다.', 'nothing_to_release');
    if (current.source === 'provider') throw new AdminInputError('이미 결제(provider) 출처 행이다 — 넘길 것이 없다.', 'already_provider');
    if (!isPlanCode(current.plan_code)) throw new AdminInputError(`모르는 요금제 코드: ${current.plan_code}`, 'invalid_plan');
    return write(client, {
      organizationId: input.organizationId,
      plan: current.plan_code,
      limits: limitsOfRow(current),
      graceUntil: current.grace_until,
      providerOverrideAllowed: true,
      actor: input.actor,
      note: 'release_to_provider',
    });
  });
}

export interface SandboxProviderRow {
  readonly organizationId: string;
  readonly planCode: string;
}

const SANDBOX_PROVIDER_SQL = `
  SELECT e.organization_id::text AS organization_id, e.plan_code
    FROM org_entitlements e
   WHERE e.source = 'provider'
     AND EXISTS (SELECT 1 FROM billing_subscriptions s WHERE s.organization_id = e.organization_id)
     AND NOT EXISTS (SELECT 1 FROM billing_subscriptions s WHERE s.organization_id = e.organization_id AND s.environment <> 'sandbox')`;

/** provider 출처 행 중 결속 구독이 **전부 샌드박스**인 조직(운영 전환 전에 되돌릴 목록, id 순). */
export async function listSandboxProviderOp(db: Queryable): Promise<SandboxProviderRow[]> {
  const rows = await db.query<{ organization_id: string; plan_code: string }>(`${SANDBOX_PROVIDER_SQL} ORDER BY 1`);
  return rows.rows.map((row) => ({ organizationId: row.organization_id, planCode: row.plan_code }));
}

/**
 * `--revert-sandbox-provider` — 샌드박스 결제로 올라간 provider 행을 operator 행(카탈로그 free|beta · 유예 없음)으로 되돌린다(감사 note
 * `sandbox_revert`). `listSandboxProviderOp` 의 조직만 된다(같은 잠금 아래에서 다시 본다) — 운영 결제 행을 되돌리는 길이 아니다.
 */
export async function revertSandboxProviderOp(
  pool: Pool,
  input: { readonly organizationId: string; readonly plan: SandboxRevertPlan; readonly actor: string },
): Promise<PlanChangeResult> {
  return withTransaction(pool, async (client) => {
    await requireOrganization(client, input.organizationId);
    await lockedRow(client, input.organizationId);
    const eligible = await client.query(`${SANDBOX_PROVIDER_SQL} AND e.organization_id = $1`, [input.organizationId]);
    if (eligible.rowCount === 0) {
      throw new AdminInputError('샌드박스 결제로만 올라간 provider 행이 아니다 — --list-sandbox-provider 의 조직만 되돌린다.', 'not_sandbox_provider');
    }
    return write(client, {
      organizationId: input.organizationId,
      plan: input.plan,
      limits: limitsFor(input.plan, {}),
      graceUntil: null,
      providerOverrideAllowed: false,
      actor: input.actor,
      note: 'sandbox_revert',
    });
  });
}

