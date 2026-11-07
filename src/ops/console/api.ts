/**
 * src/ops/console/api.ts — 운영자 화면의 `/api/*` 라우트 코어(P0 에 `scripts/ops-web/api.ts` 에서 옮겼다 — 로컬 셸 `scripts/ops-web/server.ts` 가 부른다). **읽기는 자유, 쓰기는 CLI 와 같은 함수**(`OPS` — 테스트가 CLI 의 그 함수와 같은 참조임을 본다).
 *
 * 쓰기마다 확인 입력이 필요하다(서버가 검사 — 화면의 대화상자는 편의일 뿐, `requireConfirmation`):
 *   - `confirm` = 그 조직의 **표시 이름**(정화된 한 줄, 비면 조직 id · NFC 비교) — 대상을 잘못 고른 클릭을 막는다.
 *   - 되돌릴 수 없거나 조직 전체를 멈추는 것(검토 거절 = 토큰 폐기 · 조직 동결 켜기)은 이름 대신 조직 id 앞 8자리 + `ack` = `CONFIRM`.
 * 쓰기는 성공·실패 모두 `ctx.audit` 로 기록한다(stderr + `~/.atmark/ops-web-audit.jsonl`).
 * CLI 의 운영 `yes` 확인이 이 입력으로 바뀐다(화면 머리에 접속 대상 — 운영 DB 근거 — 이 늘 보인다).
 *
 * 롤: 읽기·검토·킬스위치는 소유자 롤 풀(`admin:org-review`·`admin:kill-switch` 와 같다). 요금제 **쓰기**는 결제 운영자 롤 풀만
 * (`admin:plan` 과 같다 — `eval "$(pnpm -s admin:db-env --billing-operator)"` 로 띄웠을 때만 열린다). 소유자 풀로 떨어지지 않는다.
 *
 * 행위자(감사 행 `billing_audit.actor` — 요금제 쓰기 · 검토 활성화의 베타 부여): `admin:web:<운영자>`(`actorOf` — CLI 의 `admin:<명령>:<운영자>` 규칙).
 * 킬스위치·검토 전이는 CLI 처럼 감사 행을 따로 쓰지 않는다(CLI 와 같은 행만 — 그 함수가 쓰는 것).
 */

import type { Pool } from 'pg';

import { ORGANIZATION_ID_PATTERN, setAgentSuspendedOp, setOrganizationFreezeAuditedOp } from '../../admin/ops/agents';
import { AdminInputError } from '../../admin/ops/errors';
import { isPlanCode, PLAN_CODES, type PlanCode } from '../../billing/plans';
import { isAgentId, type AgentId } from '../../db/schema';
import { parseOverrides, releaseToProviderOp, setOrgPlanOp } from '../core/plan';
import { reviewOrganizationOp } from '../core/review';
import { describeTarget, type TargetInfo } from '../core/target';
import { inviteOldestWaitlistOp, inviteWaitlistEntryOp, removeWaitlistEntryOp } from '../core/waitlist';
import type { AuditSink } from './audit';
import { readWeeklyBoard } from './board';
import {
  confirmTarget,
  ok,
  readAudit,
  readCatalog,
  readDashboard,
  readKillSwitch,
  readOrganization,
  readOrganizations,
  readPlans,
  readReviewQueue,
  readWaitlist,
  record,
  requireAddressConfirmation,
  requireConfirmation,
  requireInviteCount,
  requireOrgId,
  requireWaitlistEntryId,
  waitlistConfirmTarget,
  type ApiResult,
} from './reads';

/** 읽기·확인 검사는 `reads.ts` 에 있다(호스팅과 같이 쓴다). 기존 import 경로를 위해 다시 내보낸다. */
export { ACK_WORD, displayName, ID_PREFIX_LENGTH, requireConfirmation, type ApiResult, type ConfirmTarget } from './reads';

/** 쓰기 함수 — CLI 가 부르는 바로 그것. 테스트만 가짜를 넣는다. */
export interface OpsFunctions {
  readonly reviewOrganization: typeof reviewOrganizationOp;
  readonly setOrgPlan: typeof setOrgPlanOp;
  readonly releaseToProvider: typeof releaseToProviderOp;
  readonly setOrganizationFreeze: typeof setOrganizationFreezeAuditedOp;
  readonly setAgentSuspended: typeof setAgentSuspendedOp;
  readonly inviteWaitlistEntry: typeof inviteWaitlistEntryOp;
  readonly inviteOldestWaitlist: typeof inviteOldestWaitlistOp;
  readonly removeWaitlistEntry: typeof removeWaitlistEntryOp;
}

export const OPS: OpsFunctions = {
  reviewOrganization: reviewOrganizationOp,
  setOrgPlan: setOrgPlanOp,
  releaseToProvider: releaseToProviderOp,
  setOrganizationFreeze: setOrganizationFreezeAuditedOp,
  setAgentSuspended: setAgentSuspendedOp,
  inviteWaitlistEntry: inviteWaitlistEntryOp,
  inviteOldestWaitlist: inviteOldestWaitlistOp,
  removeWaitlistEntry: removeWaitlistEntryOp,
};

export interface ApiContext {
  /** 소유자 롤 풀 — 읽기 · 검토 · 킬스위치. */
  readonly owner: Pool;
  /** 결제 운영자 롤 풀 — 요금제 쓰기. 없으면 요금제 쓰기는 409 `billing_operator_missing`. */
  readonly operator: Pool | null;
  readonly target: TargetInfo;
  /** `admin:web:<운영자>`. */
  readonly actor: string;
  /** 쓰기 기록(성공·실패) — stderr + `~/.atmark/ops-web-audit.jsonl`(`audit-log.ts`). */
  readonly audit: AuditSink;
  readonly idleMinutes: number;
  readonly maxHours: number;
  readonly ops: OpsFunctions;
  readonly now: () => Date;
}

// ---------------------------------------------------------------------------
// 읽기 — `reads.ts`(호스팅과 같은 조회)를 소유자 롤 풀로
// ---------------------------------------------------------------------------

function session(ctx: ApiContext): ApiResult {
  return ok({
    actor: ctx.actor,
    target: { kind: ctx.target.target, where: describeTarget(ctx.target) },
    billingOperator: ctx.operator !== null,
    idleMinutes: ctx.idleMinutes,
    maxHours: ctx.maxHours,
  });
}

// ---------------------------------------------------------------------------
// 쓰기 — 확인 입력 → CLI 와 같은 함수
// ---------------------------------------------------------------------------

async function review(ctx: ApiContext, organizationId: string, body: Record<string, unknown>): Promise<ApiResult> {
  const decision = body['decision'];
  if (decision !== 'activate' && decision !== 'reject') throw new AdminInputError('decision 은 activate|reject.', 'invalid_decision');
  requireConfirmation(body, await confirmTarget(ctx.owner, organizationId), decision === 'reject' ? 'irreversible' : 'name');
  const outcome = await ctx.ops.reviewOrganization(ctx.owner, organizationId, decision === 'activate' ? 'active' : 'rejected', ctx.actor);
  return ok({ outcome });
}

function parseGraceBody(value: unknown): Date | null | undefined {
  if (value === undefined || value === 'keep') return undefined;
  if (value === null || value === 'clear') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new AdminInputError('graceUntil 은 ISO 시각(2026-12-01T00:00:00Z) · "clear" · "keep".', 'invalid_grace');
  }
  return new Date(value);
}

function requireOperator(ctx: ApiContext): Pool {
  if (ctx.operator === null) {
    throw new AdminInputError(
      '요금제 쓰기는 결제 운영자 롤로만 한다 — eval "$(pnpm -s admin:db-env --billing-operator)" 뒤 pnpm admin:web 을 다시 띄운다.',
      'billing_operator_missing',
      409,
    );
  }
  return ctx.operator;
}

async function setPlan(ctx: ApiContext, organizationId: string, body: Record<string, unknown>): Promise<ApiResult> {
  const plan = body['plan'];
  if (!isPlanCode(plan)) throw new AdminInputError(`plan 은 ${PLAN_CODES.join('|')}.`, 'invalid_plan');
  const rawOverrides = body['overrides'] ?? {};
  if (typeof rawOverrides !== 'object' || rawOverrides === null || Array.isArray(rawOverrides)) throw new AdminInputError('overrides 는 {칸: 정수}.', 'invalid_override');
  // CLI `--set 칸=값` 과 같은 파서(모르는 칸 · 정수 아님 · 천장 초과 거부).
  const overrides = parseOverrides(Object.entries(rawOverrides).map(([column, value]) => `${column}=${String(value)}`));
  const graceUntil = parseGraceBody(body['graceUntil']);
  const noteRaw = body['note'];
  if (noteRaw !== undefined && noteRaw !== null && typeof noteRaw !== 'string') throw new AdminInputError('note 는 문자열.', 'invalid_note');
  const note = typeof noteRaw === 'string' ? noteRaw.trim() : '';
  if (note.length > 500) throw new AdminInputError('note 는 500자 이하.', 'invalid_note');
  const operator = requireOperator(ctx);
  requireConfirmation(body, await confirmTarget(ctx.owner, organizationId), 'name');
  const result = await ctx.ops.setOrgPlan(operator, {
    organizationId,
    plan: plan as PlanCode,
    overrides,
    graceUntil,
    actor: ctx.actor,
    note: note === '' ? null : note,
  });
  return ok({ result });
}

async function release(ctx: ApiContext, organizationId: string, body: Record<string, unknown>): Promise<ApiResult> {
  const operator = requireOperator(ctx);
  requireConfirmation(body, await confirmTarget(ctx.owner, organizationId), 'name');
  const result = await ctx.ops.releaseToProvider(operator, { organizationId, actor: ctx.actor });
  return ok({ result });
}

async function freeze(ctx: ApiContext, organizationId: string, body: Record<string, unknown>): Promise<ApiResult> {
  const on = body['on'];
  if (typeof on !== 'boolean') throw new AdminInputError('on 은 true|false.', 'invalid_state');
  const rawReason = body['reason'];
  if (rawReason !== undefined && rawReason !== null && typeof rawReason !== 'string') throw new AdminInputError('reason 은 문자열.', 'invalid_reason');
  const reason = typeof rawReason === 'string' ? rawReason : null;
  // 해제는 사유 필수(CLI 와 같은 함수가 다시 검사한다) — 확인 입력보다 먼저 거부해 쓰기 전에 알린다.
  if (!on && (reason ?? '').trim() === '') throw new AdminInputError('조직 동결 해제에는 사유가 필요하다(감사 · 조직의 투명성 로그에 남는다).', 'reason_required');
  requireConfirmation(body, await confirmTarget(ctx.owner, organizationId), on ? 'irreversible' : 'name');
  // 감사되는 동결 · 해제(202610131610) — CLI `admin:kill-switch --org` 와 같은 함수 · 행위자 `admin:web:<운영자>`.
  const result = await ctx.ops.setOrganizationFreeze(ctx.owner, { organizationId, on, actor: ctx.actor, reason });
  return ok({ organizationId, abuseFreeze: on, result });
}

async function suspendAgent(ctx: ApiContext, agentId: AgentId, body: Record<string, unknown>): Promise<ApiResult> {
  const on = body['on'];
  if (typeof on !== 'boolean') throw new AdminInputError('on 은 true|false.', 'invalid_state');
  const owner = await ctx.owner.query<{ organization_id: string }>('SELECT organization_id FROM agents WHERE id = $1', [agentId]);
  const organizationId = owner.rows[0]?.organization_id;
  if (organizationId === undefined) throw new AdminInputError('에이전트가 없다.', 'agent_not_found', 404);
  requireConfirmation(body, await confirmTarget(ctx.owner, organizationId), 'name');
  const result = await ctx.ops.setAgentSuspended(ctx.owner, agentId, on, 'operator');
  return ok({ agentId, result });
}

// 대기자 명단 — 확인 입력 = 대상 주소(한 항목) · 초대할 수(N 명). 행위자는 `admin:web:<운영자>`.
async function waitlistEntryWrite(ctx: ApiContext, sub: 'invite' | 'remove', entryId: string, body: Record<string, unknown>): Promise<ApiResult> {
  requireAddressConfirmation(body, (await waitlistConfirmTarget(ctx.owner, entryId)).email);
  const waitlist = sub === 'invite' ? await ctx.ops.inviteWaitlistEntry(ctx.owner, entryId, ctx.actor) : await ctx.ops.removeWaitlistEntry(ctx.owner, entryId, ctx.actor);
  return ok({ waitlist });
}

async function waitlistInviteOldest(ctx: ApiContext, body: Record<string, unknown>): Promise<ApiResult> {
  const n = requireInviteCount(body);
  const invited = await ctx.ops.inviteOldestWaitlist(ctx.owner, n, ctx.actor);
  return ok({ waitlist: { invited: invited.length } });
}

// ---------------------------------------------------------------------------
// 라우팅
// ---------------------------------------------------------------------------

interface WriteRoute {
  /** 기록용 행위 이름(`review.reject` · `plan.set` …). */
  readonly action: string;
  /** 기록용 대상 — 모양이 맞는 id 만, 아니면 `invalid`. */
  readonly target: string;
  readonly run: (ctx: ApiContext) => Promise<ApiResult>;
}

const onOff = (body: unknown, on: string, off: string): string => {
  const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['on'] : undefined;
  return value === true ? on : value === false ? off : `${on}|${off}`;
};

function writeRoute(head: string | undefined, id: string | undefined, sub: string | undefined, extra: string | undefined, body: unknown): WriteRoute | null {
  if (head === 'orgs' && id !== undefined) {
    const target = ORGANIZATION_ID_PATTERN.test(id) ? id.toLowerCase() : 'invalid';
    const decision = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['decision'] : undefined;
    if (sub === 'review' && extra === undefined) {
      return { action: `review.${typeof decision === 'string' && /^[a-z]{1,20}$/.test(decision) ? decision : 'invalid'}`, target, run: (ctx) => review(ctx, requireOrgId(id), record(body)) };
    }
    if (sub === 'plan' && extra === undefined) return { action: 'plan.set', target, run: (ctx) => setPlan(ctx, requireOrgId(id), record(body)) };
    if (sub === 'plan' && extra === 'release') return { action: 'plan.release', target, run: (ctx) => release(ctx, requireOrgId(id), record(body)) };
    if (sub === 'freeze' && extra === undefined) return { action: onOff(body, 'freeze.on', 'freeze.off'), target, run: (ctx) => freeze(ctx, requireOrgId(id), record(body)) };
  }
  if (head === 'waitlist' && id === 'invite-oldest' && sub === undefined) {
    return { action: 'waitlist.invite_oldest', target: 'waitlist', run: (ctx) => waitlistInviteOldest(ctx, record(body)) };
  }
  if (head === 'waitlist' && id !== undefined && (sub === 'invite' || sub === 'remove') && extra === undefined) {
    const target = ORGANIZATION_ID_PATTERN.test(id) ? id.toLowerCase() : 'invalid';
    return {
      action: `waitlist.${sub}`,
      target,
      run: (ctx) => waitlistEntryWrite(ctx, sub, requireWaitlistEntryId(id), record(body)),
    };
  }
  if (head === 'agents' && id !== undefined && sub === 'suspend' && extra === undefined) {
    return {
      action: onOff(body, 'agent.suspend', 'agent.resume'),
      target: isAgentId(id) ? id : 'invalid',
      run: (ctx) => {
        if (!isAgentId(id)) throw new AdminInputError('에이전트 id(hex 32)가 아니다.', 'invalid_agent');
        return suspendAgent(ctx, id, record(body));
      },
    };
  }
  return null;
}

/** 성공 요약 — 이름·이메일·사유 없이 상태·버전만. */
function summarize(body: unknown): string | undefined {
  const b = body as { outcome?: { changed: boolean; from: string; revokedTokens: number; suspended: readonly string[]; plan: { granted: boolean; version?: number } | null }; result?: { changed?: boolean; version?: number; status?: string }; abuseFreeze?: boolean };
  if (b.outcome !== undefined) {
    const o = b.outcome;
    return `changed=${String(o.changed)} from=${o.from} suspended=${String(o.suspended.length)} revoked=${String(o.revokedTokens)}${o.plan?.granted === true ? ` beta_v=${String(o.plan.version)}` : ''}`;
  }
  if (b.result !== undefined) {
    return [`changed=${String(b.result.changed)}`, b.result.version === undefined ? '' : `v=${String(b.result.version)}`, b.result.status === undefined ? '' : `status=${b.result.status}`].filter((x) => x !== '').join(' ');
  }
  if (b.abuseFreeze !== undefined) return `abuse_freeze=${String(b.abuseFreeze)}`;
  const w = (body as { waitlist?: { fromStatus?: string; invited?: number } }).waitlist;
  if (w !== undefined) return w.invited === undefined ? `from=${String(w.fromStatus)}` : `invited=${String(w.invited)}`;
  return undefined;
}

/** 쓰기 한 번 — 성공·실패 모두 기록한다(`audit-log.ts`). 예외는 그대로 다시 던진다(응답은 서버가 만든다). */
async function recorded(ctx: ApiContext, route: WriteRoute): Promise<ApiResult> {
  const base = { at: ctx.now().toISOString(), actor: ctx.actor, action: route.action, target: route.target };
  try {
    const result = await route.run(ctx);
    const summary = summarize(result.body);
    ctx.audit(summary === undefined ? { ...base, result: 'ok' } : { ...base, result: 'ok', summary });
    return result;
  } catch (error) {
    const sqlState = (error as { code?: unknown }).code;
    const code =
      error instanceof AdminInputError ? error.code : typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState) ? `db_${sqlState}` : 'internal_error';
    ctx.audit({ ...base, result: code });
    throw error;
  }
}

/** `/api/*` 한 요청. Host·Origin·세션 토큰은 서버가 이미 봤다. 예외는 서버가 `{error, detail}` 로 바꾼다. */
export async function handleApi(ctx: ApiContext, method: string, path: string, query: URLSearchParams, body: unknown): Promise<ApiResult> {
  const parts = path.split('/').filter((part) => part !== '').slice(1); // 'api' 를 뗀다
  const [head, id, sub, extra] = parts;
  if (method === 'GET') {
    if (head === 'session' && id === undefined) return session(ctx);
    if (head === 'review' && id === undefined) return readReviewQueue(ctx.owner);
    if (head === 'catalog' && id === undefined) return readCatalog();
    if (head === 'dashboard' && id === undefined) return readDashboard(ctx.owner, ctx.now());
    if (head === 'board' && id === undefined) return readWeeklyBoard(ctx.owner, ctx.now());
    if (head === 'plans' && id === undefined) return readPlans(ctx.owner, ctx.now());
    if (head === 'killswitch' && id === undefined) return readKillSwitch(ctx.owner);
    if (head === 'audit' && id === undefined) return readAudit(ctx.owner, query);
    if (head === 'waitlist' && id === undefined) return readWaitlist(ctx.owner, query, ctx.now());
    if (head === 'orgs' && id === undefined) return readOrganizations(ctx.owner, query, ctx.now());
    if (head === 'orgs' && id !== undefined && sub === undefined) return readOrganization(ctx.owner, requireOrgId(id), ctx.now());
  }
  if (method === 'POST') {
    const write = writeRoute(head, id, sub, extra, body);
    if (write !== null) return recorded(ctx, write);
  }
  return { status: 404, body: { error: 'not_found' } };
}
