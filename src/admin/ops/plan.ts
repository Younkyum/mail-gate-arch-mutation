/**
 * src/admin/ops/plan.ts — **요금제·사용량 보기**(ADR-0011). 콘솔 `GET /api/plan` 과 운영자 CLI `pnpm admin:plan --org` 가 같은 함수를 부른다.
 *
 * 읽기만 한다 — admin 롤은 `org_entitlements` 를 SELECT 만 가진다(요금제를 바꾸는 길은 운영자 CLI · WP-2 billing 롤). 보여 주는 한도는
 * **지금 적용되는 값**(`resolveEntitlements` — 행이 없거나 유예가 끝났으면 Free · 천장으로 자른 값)이고, 각 적용 지점의 코드 천장으로 한 번 더
 * 자른다(에이전트 · 토큰 · 조직 키 · 웹훅) — 화면의 숫자와 409 를 내는 숫자가 같다.
 *
 * 사용량: 에이전트(비활성 제외 / 전부) · 최근 24시간 조직 수신자(정책 로더의 카운터와 같은 SQL — 발송 중·보낸 것) · 활성 조직 키 · 요금제 토큰
 * 한도를 넘는 에이전트 수. 하루 상한은 `organizationDailyCap`(= min(워밍업, 요금제)) — 그 사유가 `plan_daily_cap` 일 때만 업그레이드로 풀린다.
 * 금액은 없다(가격은 자리표시 — 결제 공급자가 없다: `upgradeAvailable: false`).
 *
 * `/api/me` 는 `planSummaryOp`(요금제 · 분모 · 초과 항목 — 싼 조회만)를 부른다. 24시간 수신자 합(메시지 표 훑기)은 `GET /api/plan` 에서만.
 */

import {
  agentTotalCeiling,
  ENTITLEMENT_CEILINGS,
  ENTITLEMENTS_TABLE_MISSING,
  resolveEntitlements,
  type EntitlementLimits,
  type Entitlements,
} from '../../billing/plans';
import type { Queryable } from '../../db/client';
import { loadOrgEntitlementsRow } from '../../db/repositories/entitlements';
import { organizationDailyCap, warmupDailyCap } from '../../policy/rules/limits';
import { countAgentsOverAliasLimit, MAX_ACTIVE_ALIASES_PER_AGENT } from './addresses';
import { countAgents, MAX_AGENTS_PER_ORG } from './agents';
import { iso } from '../display';
import { notFound } from './errors';
import { countActiveOrgKeys, MAX_ACTIVE_ORG_KEYS } from './org-keys';
import { MAX_ACTIVE_TOKENS_PER_AGENT } from './tokens';

/** 초과 항목 — 강등·운영자 조정 뒤에 이미 가진 것이 새 한도를 넘는다(지우지 않는다 — 새로 만들지 못할 뿐, B7). */
type OverLimit = 'agents' | 'agents_total' | 'org_keys' | 'tokens' | 'aliases';

export interface PlanUsageView {
  readonly plan: {
    readonly code: Entitlements['planCode'];
    /** `row` 행 그대로 · `missing` 행 없음(Free) · `grace_expired` 유예가 끝나 Free · `table_missing` 표가 없어 도입 전 한도(beta 값). */
    readonly basis: Entitlements['basis'];
    /** 행의 요금제 코드(유예 만료로 Free 가 됐어도 행에 적힌 것). 행이 없으면 `null`. */
    readonly rowCode: string | null;
    readonly source: string | null;
    readonly version: number | null;
    readonly graceUntil: string | null;
    readonly updatedAt: string | null;
  };
  /** 지금 적용되는 한도(적용 지점 천장까지 자른 값). */
  readonly limits: EntitlementLimits & { readonly agentsTotalMax: number };
  readonly usage: {
    readonly agents: number;
    readonly agentsTotal: number;
    readonly orgKeys: number;
    /** 요금제 토큰 한도보다 활성 토큰이 많은 에이전트 수(강등 뒤). */
    readonly agentsOverTokenLimit: number;
    readonly recipientsLastDay: number;
    /** 오늘의 조직 하루 상한 = min(워밍업, 요금제). */
    readonly dailyCap: number;
    readonly dailyCapReason: 'warmup_daily_cap' | 'plan_daily_cap';
    readonly warmupCap: number;
  };
  readonly overLimit: readonly OverLimit[];
  /** 결제 공급자가 붙기 전까지 `false` — 콘솔 "업그레이드" 는 잠긴다(ⓘ 결제 준비 중). */
  readonly upgradeAvailable: boolean;
}

/** 요금제 · 적용 한도 · 초과 항목 — 싼 조회만(엔타이틀먼트 행 · 에이전트 수 · 조직 키 수 · 토큰 초과 에이전트 수). */
async function planCore(db: Queryable, organizationId: string, now: Date) {
  const loaded = await loadOrgEntitlementsRow(db, organizationId);
  const entitlements = resolveEntitlements(loaded, now);
  const row = loaded === ENTITLEMENTS_TABLE_MISSING ? null : loaded;
  const limits = {
    ...entitlements,
    maxAgents: Math.min(entitlements.maxAgents, MAX_AGENTS_PER_ORG),
    tokensPerAgentMax: Math.min(entitlements.tokensPerAgentMax, MAX_ACTIVE_TOKENS_PER_AGENT),
    orgApiKeysMax: Math.min(entitlements.orgApiKeysMax, MAX_ACTIVE_ORG_KEYS),
    // 웹훅 천장은 에이전트 API(`MAX_WEBHOOK_ENDPOINTS_PER_AGENT`)에 있다 — admin 은 api 를 import 하지 않으므로 같은 값인 코드 천장을 쓴다.
    webhookEndpointsPerAgentMax: Math.min(entitlements.webhookEndpointsPerAgentMax, ENTITLEMENT_CEILINGS.webhookEndpointsPerAgentMax),
    // 메일 기본기 2차 A6 — 별칭 연산(`ops/addresses.ts`)과 같은 천장.
    aliasesPerAgentMax: Math.min(entitlements.aliasesPerAgentMax, MAX_ACTIVE_ALIASES_PER_AGENT),
  };
  const agentsTotalMax = agentTotalCeiling(limits);
  const counts = await countAgents(db, organizationId);
  const orgKeys = await countActiveOrgKeys(db, organizationId);
  const overTokens = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (
       SELECT k.agent_id FROM agent_api_keys k JOIN agents a ON a.id = k.agent_id
        WHERE a.organization_id = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
        GROUP BY k.agent_id HAVING count(*) > $2) over_limit`,
    [organizationId, limits.tokensPerAgentMax],
  );
  const agentsOverTokenLimit = overTokens.rows[0]?.n ?? 0;
  const overLimit: OverLimit[] = [];
  if (counts.nonDisabled > limits.maxAgents) overLimit.push('agents');
  if (counts.total > agentsTotalMax) overLimit.push('agents_total');
  if (orgKeys > limits.orgApiKeysMax) overLimit.push('org_keys');
  if (agentsOverTokenLimit > 0) overLimit.push('tokens');
  // 강등 뒤 활성 별칭이 새 한도를 넘는 에이전트(폐기하지 않는다 — 새 별칭만 409, 계획 R18).
  if ((await countAgentsOverAliasLimit(db, organizationId, limits.aliasesPerAgentMax)) > 0) overLimit.push('aliases');
  return { row, entitlements, limits, agentsTotalMax, counts, orgKeys, agentsOverTokenLimit, overLimit };
}

/** `/api/me` 의 요금제 요약 — 에이전트 분모와 초과 배너. 24시간 수신자 합은 싣지 않는다(무거운 조회는 `GET /api/plan` 에서만). */
interface PlanSummaryView {
  readonly code: Entitlements['planCode'];
  readonly basis: Entitlements['basis'];
  readonly maxAgents: number;
  readonly overLimit: readonly OverLimit[];
}

export async function planSummaryOp(db: Queryable, organizationId: string, now: Date): Promise<PlanSummaryView> {
  const core = await planCore(db, organizationId, now);
  return { code: core.entitlements.planCode, basis: core.entitlements.basis, maxAgents: core.limits.maxAgents, overLimit: core.overLimit };
}

export async function planUsageOp(db: Queryable, organizationId: string, now: Date): Promise<PlanUsageView> {
  const org = await db.query<{ sending_started_at: Date | null }>('SELECT sending_started_at FROM organizations WHERE id = $1', [organizationId]);
  const organization = org.rows[0];
  if (organization === undefined) throw notFound('조직이 없다.', 'organization_not_found');
  const { row, entitlements, limits, agentsTotalMax, counts, orgKeys, agentsOverTokenLimit, overLimit } = await planCore(db, organizationId, now);
  // 정책 로더(`db/repositories/policy-source.ts` loadCounters)와 같은 창·상태 — 화면의 "오늘" 과 관문의 "오늘" 이 같다.
  const recipients = await db.query<{ n: number }>(
    `SELECT coalesce(sum(m.recipient_count), 0)::int AS n
       FROM messages m JOIN agents a ON a.id = m.agent_id
      WHERE a.organization_id = $1 AND m.direction = 'outbound' AND m.status IN ('dispatching', 'sent')
        AND coalesce(m.sent_at, m.created_at) >= $2::timestamptz - interval '24 hours'`,
    [organizationId, now],
  );
  const daily = organizationDailyCap(now, organization.sending_started_at, limits.orgDailyRecipients);
  const { planCode: _planCode, basis: _basis, ...limitValues } = limits;
  return {
    plan: {
      code: entitlements.planCode,
      basis: entitlements.basis,
      rowCode: row?.plan_code ?? null,
      source: row?.source ?? null,
      version: row === null ? null : Number(row.version),
      graceUntil: iso(row?.grace_until ?? null),
      updatedAt: iso(row?.updated_at ?? null),
    },
    limits: { ...limitValues, agentsTotalMax },
    usage: {
      agents: counts.nonDisabled,
      agentsTotal: counts.total,
      orgKeys,
      agentsOverTokenLimit,
      recipientsLastDay: recipients.rows[0]?.n ?? 0,
      dailyCap: daily.cap,
      dailyCapReason: daily.reason,
      warmupCap: warmupDailyCap(now, organization.sending_started_at),
    },
    overLimit,
    upgradeAvailable: false,
  };
}
