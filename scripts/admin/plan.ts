#!/usr/bin/env tsx
/**
 * scripts/admin/plan.ts — 조직 **요금제(엔타이틀먼트) 보기·바꾸기**(ADR-0011 · ADR-0012, 런북 admin §요금제).
 *
 *   pnpm admin:plan --catalog                                    # 요금제 카탈로그(코드 상수 — 가격은 자리표시라 없다)
 *   pnpm admin:plan --org <조직 id>                               # 지금 적용되는 요금제 · 한도 · 사용량(콘솔 "요금제·사용량" 과 같은 함수)
 *   pnpm admin:plan --org <조직 id> --plan <free|beta|pro|team|scale> [--set 칸=값 …] [--grace-until <ISO 시각> | --clear-grace]
 *        [--note "<사유>"] [--by <운영자>] [--yes]
 *   pnpm admin:plan --org <조직 id> --release-to-provider [--by <운영자>] [--yes]     # 이 운영자 행을 결제가 덮어도 된다(D-3)
 *   pnpm admin:plan --list-sandbox-provider                      # 샌드박스 결제로만 올라간 provider 행(운영 전환 전 되돌릴 것)
 *   pnpm admin:plan --org <조직 id> --revert-sandbox-provider --plan <free|beta> --by <운영자> --yes
 *
 * **결제 운영자 롤이다**(`atmark_billing_operator`, `DATABASE_BILLING_OPERATOR_URL` — `eval "$(pnpm -s admin:db-env --billing-operator)"`).
 * 소유자 URL 로 떨어지지 않는다(없으면 입력 오류, 다른 롤이면 거부 — `common.ts` `BILLING_OPERATOR_ROLE_SPEC`). 이 롤은 보기(`planUsageOp` 의
 * 칸)와 operator 출처 쓰기 · 감사 INSERT 만 가진다 — DB 가드가 operator 출처·원인 밖의 쓰기를 거부한다(202609250400). 요금제를 바꾸는 다른 길은
 * 검토 활성화의 베타 부여(`admin:org-review --activate` → SQL 코어 `ops_org_activate_core`, 소유자 롤 — 202609290510) · 결제 동기화(`atmark_billing`)뿐이다.
 *
 * 한 번의 변경 = 한 트랜잭션: 조직 요금제 잠금 → 지금 행 → `writeEntitlementVersion`(같으면 쓰지 않는다 · 감사 행 · v1/v+1). 조직 행은 잠그지 않는다 —
 * 이 롤은 조직 행 UPDATE 권한이 없어 `FOR UPDATE` 를 못 하고, 존재만 `SELECT id` 로 본다. DB 가 지킨다: version 하나씩 · 버전마다 감사 행 ·
 * 칸 상한 = 코드 천장 · 출처-롤 가드. 투명성 로그에는 트리거가 `billing.entitlement` 잎(요금제 · 한도 · 버전 · 원인)을 남긴다.
 *
 * `--set` 은 요금제 기본값 위의 **덮어쓰기**다(칸 이름은 `org_entitlements` 그대로 — `max_agents=20`). 코드 천장을 넘으면 거부한다.
 * 유예: `--grace-until` 이 주어지면 그 시각, `--clear-grace` 면 없앤다. 둘 다 없으면 **요금제가 같을 때만** 지금 값을 둔다(요금제를 바꾸면 없앤다).
 * `--plan` 으로 새로 정한 행은 넘기지 않은 상태다(`provider_override_allowed = false`) — 결제는 이 행을 한도 열한 칸이 모두 크거나 같을 때만 덮는다.
 * `--release-to-provider` 는 요금제·한도·유예를 그대로 두고 그 표시만 켠다(감사 note `release_to_provider`) — 그 뒤 결제 이벤트가 이 행을 자유롭게
 * 바꾸고(강등 포함), reconcile 은 여전히 운영자 행을 덮지 않는다.
 * 샌드박스 되돌리기: 운영 전환 때 샌드박스 결제로 올라간 provider 행을 operator 행(free|beta)으로 되돌린다(감사 note `sandbox_revert`) —
 * 결속 구독이 전부 `sandbox` 인 조직만 된다.
 */

import { parseArgs } from 'node:util';

import { ORGANIZATION_ID_PATTERN } from '../../src/admin/ops/agents';
import { planUsageOp, type PlanUsageView } from '../../src/admin/ops/plan';
import { isPlanCode, LIMIT_COLUMNS, PLAN_CATALOG, PLAN_CODES, type PlanCode } from '../../src/billing/plans';
import {
  limitsFor,
  listSandboxProviderOp,
  parseOverrides,
  releaseToProviderOp,
  revertSandboxProviderOp,
  SANDBOX_REVERT_PLANS,
  setOrgPlanOp,
  type PlanChangeInput,
  type PlanChangeResult,
  type SandboxProviderRow,
  type SandboxRevertPlan,
} from '../../src/ops/core/plan';
import {
  actorOf,
  AdminInputError,
  BILLING_OPERATOR_ROLE_SPEC,
  confirmProduction,
  EXIT_OK,
  isMain,
  runAdminMain,
  withAdminConnection,
  type AdminDeps,
} from './common';

/** 연산은 `src/ops/core/plan.ts` 로 옮겼다(P0 — 운영자 화면 코어가 같이 쓴다). 이 CLI 는 그것을 부르고, 기존 import 경로를 위해 다시 내보낸다. */
export {
  limitsFor,
  listSandboxProviderOp,
  parseOverrides,
  releaseToProviderOp,
  revertSandboxProviderOp,
  SANDBOX_REVERT_PLANS,
  setOrgPlanOp,
  type PlanChangeInput,
  type PlanChangeResult,
  type SandboxProviderRow,
  type SandboxRevertPlan,
};

const USAGE =
  'pnpm admin:plan (--catalog | --list-sandbox-provider | --org <조직 id> [--plan <' +
  PLAN_CODES.join('|') +
  '> [--set 칸=값 …] [--grace-until <ISO> | --clear-grace] [--note <사유>] | --release-to-provider | --revert-sandbox-provider --plan <free|beta>]' +
  ' [--by <운영자>] [--yes])';

function describe(view: PlanUsageView): string[] {
  const l = view.limits;
  const u = view.usage;
  return [
    `plan ${view.plan.code} (basis=${view.plan.basis}${view.plan.rowCode !== null && view.plan.rowCode !== view.plan.code ? ` row=${view.plan.rowCode}` : ''}` +
      ` source=${String(view.plan.source)} version=${String(view.plan.version)} grace_until=${String(view.plan.graceUntil)})`,
    `agents ${String(u.agents)}/${String(l.maxAgents)} (비활성 제외) · total ${String(u.agentsTotal)}/${String(l.agentsTotalMax)}`,
    `recipients_24h ${String(u.recipientsLastDay)}/${String(u.dailyCap)} (${u.dailyCapReason === 'plan_daily_cap' ? '요금제' : '워밍업'} · warmup ${String(u.warmupCap)} · plan ${String(l.orgDailyRecipients)})`,
    `per_minute ≤ ${String(l.agentPerMinuteMax)} · per_day ≤ ${String(l.agentPerDayMax)} · recipients/message ≤ ${String(l.recipientsPerMessageMax)}`,
    `tokens/agent ≤ ${String(l.tokensPerAgentMax)} (over=${String(u.agentsOverTokenLimit)}) · webhooks/agent ≤ ${String(l.webhookEndpointsPerAgentMax)} · org_keys ${String(u.orgKeys)}/${String(l.orgApiKeysMax)}`,
    `over_limit ${view.overLimit.length === 0 ? '-' : view.overLimit.join(',')}`,
  ];
}

function parseGrace(raw: string | undefined, clear: boolean): Date | null | undefined {
  if (raw !== undefined && clear) throw new AdminInputError('--grace-until 과 --clear-grace 중 하나만.', 'invalid_grace');
  if (clear) return null;
  if (raw === undefined) return undefined;
  const at = new Date(raw);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || Number.isNaN(at.getTime())) throw new AdminInputError(`--grace-until 은 ISO 시각(2026-12-01T00:00:00Z): ${raw}`, 'invalid_grace');
  return at;
}

function isSandboxRevertPlan(value: unknown): value is SandboxRevertPlan {
  return typeof value === 'string' && (SANDBOX_REVERT_PLANS as readonly string[]).includes(value);
}

export async function plan(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      catalog: { type: 'boolean', default: false },
      org: { type: 'string' },
      plan: { type: 'string' },
      set: { type: 'string', multiple: true },
      'grace-until': { type: 'string' },
      'clear-grace': { type: 'boolean', default: false },
      note: { type: 'string' },
      'release-to-provider': { type: 'boolean', default: false },
      'list-sandbox-provider': { type: 'boolean', default: false },
      'revert-sandbox-provider': { type: 'boolean', default: false },
      by: { type: 'string' },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  if (values.catalog) {
    for (const code of PLAN_CODES) {
      deps.io.out([code, ...LIMIT_COLUMNS.map(([key, column]) => `${column}=${String(PLAN_CATALOG[code][key])}`)].join('\t'));
    }
    deps.io.err('가격은 자리표시라 카탈로그에 없다(ADR-0011). 한도는 코드 천장 이하다.');
    return EXIT_OK;
  }
  if (values['list-sandbox-provider']) {
    return withAdminConnection(
      deps,
      async ({ pool }) => {
        const rows = await listSandboxProviderOp(pool);
        for (const row of rows) deps.io.out(`${row.organizationId}\t${row.planCode}`);
        deps.io.err(`샌드박스 결제로만 올라간 provider 행 ${String(rows.length)}개 — 조직마다 --revert-sandbox-provider --plan <free|beta> 로 되돌린다.`);
        return EXIT_OK;
      },
      BILLING_OPERATOR_ROLE_SPEC,
    );
  }
  const org = values.org?.trim() ?? '';
  if (!ORGANIZATION_ID_PATTERN.test(org)) throw new AdminInputError(`--org 는 조직 id(uuid). ${USAGE}`);
  const release = values['release-to-provider'];
  const revert = values['revert-sandbox-provider'];
  if (release && revert) throw new AdminInputError(`--release-to-provider 와 --revert-sandbox-provider 는 함께 쓰지 않는다. ${USAGE}`);
  const changing = values.plan !== undefined && !revert;
  const tuning = values.set !== undefined || values['grace-until'] !== undefined || values['clear-grace'] || values.note !== undefined;
  if (tuning && !changing) throw new AdminInputError(`--set · --grace-until · --clear-grace · --note 는 --plan 과 함께(되돌리기·넘기기에는 쓰지 않는다). ${USAGE}`);
  if (release && values.plan !== undefined) throw new AdminInputError(`--release-to-provider 는 요금제를 바꾸지 않는다 — --plan 과 함께 쓰지 않는다. ${USAGE}`);
  if (revert && !isSandboxRevertPlan(values.plan)) throw new AdminInputError(`--revert-sandbox-provider 는 --plan ${SANDBOX_REVERT_PLANS.join('|')} 과 함께.`, 'invalid_plan');
  if (revert && (values.by === undefined || values.by.trim() === '')) throw new AdminInputError('--revert-sandbox-provider 는 --by <운영자> 가 필요하다.', 'invalid_actor');
  if (changing && !isPlanCode(values.plan)) throw new AdminInputError(`--plan 은 ${PLAN_CODES.join('|')}: ${String(values.plan)}`, 'invalid_plan');
  const overrides = parseOverrides(values.set ?? []);
  const graceUntil = parseGrace(values['grace-until'], values['clear-grace']);
  const note = values.note?.trim() ?? '';
  if (note.length > 500) throw new AdminInputError('--note 는 500자 이하.', 'invalid_note');
  const actor = actorOf('admin:plan', values.by, deps.env);

  return withAdminConnection(
    deps,
    async ({ pool, target }) => {
      if (release) {
        await confirmProduction(target, `조직 ${org} 요금제 행을 결제에 넘긴다(--release-to-provider)`, values.yes, deps.io);
        const result = await releaseToProviderOp(pool, { organizationId: org, actor });
        deps.io.out(`organization ${org} released_to_provider version=${String(result.version)} changed=${String(result.changed)}`);
        deps.io.err(result.changed ? '결제가 이 행을 바꿀 수 있다(강등 포함). reconcile 은 여전히 덮지 않는다.' : '이미 넘긴 행이다 — 바꾸지 않았다.');
      } else if (revert) {
        const revertPlan = values.plan as SandboxRevertPlan;
        await confirmProduction(target, `조직 ${org} 샌드박스 provider 행 → operator ${revertPlan}`, values.yes, deps.io);
        const result = await revertSandboxProviderOp(pool, { organizationId: org, plan: revertPlan, actor });
        deps.io.out(`organization ${org} plan=${revertPlan} version=${String(result.version)} changed=${String(result.changed)} note=sandbox_revert`);
      } else if (changing) {
        const planCode = values.plan as PlanCode;
        await confirmProduction(target, `조직 ${org} 요금제 → ${planCode}${Object.keys(overrides).length > 0 ? ` (덮어쓰기 ${Object.keys(overrides).join(',')})` : ''}`, values.yes, deps.io);
        const result = await setOrgPlanOp(pool, { organizationId: org, plan: planCode, overrides, graceUntil, actor, note: note === '' ? null : note });
        deps.io.out(`organization ${org} plan=${planCode} version=${String(result.version)} changed=${String(result.changed)}`);
        deps.io.err(result.changed ? `${String(result.fromPlan ?? '(행 없음 = free)')} → ${planCode}. billing_audit 한 행 · 투명성 잎 billing.entitlement.` : '이미 그 요금제·한도다 — 바꾸지 않았다.');
      }
      for (const line of describe(await planUsageOp(pool, org, new Date()))) deps.io.out(line);
      return EXIT_OK;
    },
    BILLING_OPERATOR_ROLE_SPEC,
  );
}

if (isMain(import.meta.url)) await runAdminMain(plan);
