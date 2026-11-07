/**
 * src/admin/ops/policy-requests.ts — **에이전트의 정책 변경 요청을 소유자가 본다 · 승인한다 · 거절한다**(ADR-0007 2026-10-13 개정 · 진윤겸 결정 A).
 *
 * 요청은 에이전트가 만든다(api λ · 앱 롤 정의자 `atmark_policy_request_create` — `api/routes/policy-requests.ts`). 이 파일은 콘솔(admin 롤)의 쪽이다:
 *   - **보기** — 그 에이전트의 요청 + 지금 정책과 견준 **정확한 차이**(지금 → 승인하면) · 이유(에이전트의 글자 — 표시 정화는 라우트) · 위험 경고
 *     (요청 직전 4시간 안에 위험 표시 메일을 읽었나 — 요청 때 DB 가 고정한 `tainted`, ADR-0016) · 요청 뒤 정책이 바뀌었나(`baseVersion` ≠ 지금).
 *   - **승인** — 소유자가 콘솔에서 직접 바꿀 때와 **같은 관리 연산**(`addRuleOp` · `removeRuleOp` · `changePolicyOp`)을 같은 트랜잭션에서 부른다 — 같은 검사
 *     (값 모양 · 플랫폼 도메인 · 자기 주소 · 중복 · 상한 · 관문 해석)와 같은 새 정책 버전. 버전의 `created_by` 는 `<소유자 세션> policy_request:<요청 id>`
 *     (감사의 연결고리)이고, 요청 행에 `applied_version` 이 남는다. 감사 1행(`agent.policy_request.approve`)은 라우트의 `audited` 가 같은 트랜잭션에 넣는다.
 *   - **낙관적 동시성** — 콘솔은 차이를 그린 정책 버전(`expectedVersion`)을 함께 보낸다. 지금 버전과 다르면 아무것도 쓰지 않고 409 `policy_changed`
 *     (콘솔이 다시 읽어 새 차이를 보인다). 같아도 지금 상태로 **다시 판정**한다 — 이미 그 상태(더할 항목이 있다 · 뺄 항목이 없다 · 이미 그 모드)거나
 *     관리 연산이 거부하면(자기 주소 · 상한 · 중복) 요청을 `stale`(+ 까닭 코드)로 닫는다.
 *   - **거절** — 결정 칸만.
 *   - 만료(7일)된 요청은 결정하지 못한다 — 그 자리에서 `expired` 로 닫는다.
 * 결정은 pending 에서 한 번(DB 트리거 `policy_change_requests_transition`). 에이전트 토큰은 이 표면에 닿지 않는다(콘솔은 세션 쿠키만 — `Authorization` 이 있으면 401).
 */

import type { Pool } from 'pg';

import { withTransaction } from '../../db/client';
import { toAgentId, type AgentId } from '../../db/schema';
import { consoleInboundModeOf, consoleOutboundModeOf, type ConsoleMode } from '../../policy/mode-names';
import {
  effectivePolicyRequestStatus,
  policyRequestChangeOf,
  policyRequestCreatedBy,
  type PolicyRequestChange,
  type PolicyRequestStatus,
} from '../../policy/policy-requests';
import { AdminInputError, notFound, UUID_PATTERN } from './errors';
import { changePolicyOp, lockPolicy, resolvePolicyChange, type PolicyView } from './policy';
import { addRuleOp, removeRuleOp, resolveContactRuleInput } from './rules';
import { transactionPool } from './transaction';

type PolicyState = Awaited<ReturnType<typeof lockPolicy>>;

/** 차이 — 지금 정책과 견준 "승인하면 무엇이 바뀌나". 이미 그 상태면 `inEffect`(승인은 stale 로 닫힌다). */
export type PolicyRequestDiff =
  | {
      readonly kind: 'mode';
      readonly direction: 'outbound' | 'inbound';
      /** 지금 모드(콘솔 이름 · 레거시 발신 모드는 `legacy`). */
      readonly before: ConsoleMode | 'legacy';
      readonly after: ConsoleMode;
      readonly inEffect: boolean;
    }
  | {
      readonly kind: 'rule';
      readonly direction: 'outbound' | 'inbound';
      readonly list: 'allow' | 'block';
      readonly op: 'add' | 'remove';
      readonly value: string;
      /** 그 목록의 지금 항목 수 → 승인하면. */
      readonly countBefore: number;
      readonly countAfter: number;
      readonly inEffect: boolean;
    };

export interface PolicyRequestView {
  readonly id: string;
  readonly agentId: AgentId;
  readonly change: PolicyRequestChange;
  /** 에이전트가 쓴 이유 — **표시 정화 전**(라우트가 `displaySubject` 로 거른다). */
  readonly reason: string;
  /** 지금 시각으로 본 상태(지난 pending 은 expired). */
  readonly status: PolicyRequestStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly baseVersion: number;
  readonly appliedVersion: number | null;
  readonly staleReason: string | null;
  /**
   * 위험 경고(ADR-0016) — 요청 직전 4시간 안에 위험 표시(T2) 메일을 읽었거나(만들 때 고정), **그 뒤에** 읽었다(지금 다시 읽은 값 — 재생 · 요청 뒤 오염,
   * 적대 검증 G07 · G08). 참이면 콘솔이 강한 경고를 보이고, 승인에 확인(`riskAcknowledged`)이 있어야 한다.
   */
  readonly tainted: boolean;
  /** 만들 때 고정한 값(요청 직전 4시간). */
  readonly taintedAtRequest: boolean;
  /** 마지막 T2 노출 시각(요청 전 7일 · 요청 뒤 — 둘 중 늦은 것, 없으면 `null`). */
  readonly lastRiskExposureAt: string | null;
  /** pending 일 때만 — 지금 정책과 견준 차이. */
  readonly diff: PolicyRequestDiff | null;
  /**
   * pending add_rule 일 때만 — 같은 에이전트 · 같은 방향 · 같은 목록에서 **24시간 안에 소유자가 거절한** add_rule 수(보안 감사 L-2 후속 · 적대 검토 L-3).
   * 콘솔이 "최근 거절한 요청이 있다" 를 보인다 — 거절된 값을 덮는 재요청은 DB 가 막지만(202610131600), 좁히거나 옆으로 돌린 요청은 사람이 본다.
   */
  readonly recentRejections: number;
}

export interface PolicyRequestList {
  readonly items: readonly PolicyRequestView[];
  /** 차이를 그린 정책 버전 — 승인 때 `expectedVersion` 으로 되돌려 보낸다. */
  readonly currentVersion: number;
}

interface RequestRow {
  id: string;
  agent_id: string;
  action: string;
  direction: string;
  list: string | null;
  value: string | null;
  mode: string | null;
  reason: string;
  status: PolicyRequestStatus;
  created_at: Date;
  expires_at: Date;
  decided_at: Date | null;
  base_version: number;
  applied_version: number | null;
  stale_reason: string | null;
  tainted: boolean;
  last_risk_exposure_at: Date | null;
  /** 요청 시각 − 4시간 이후의 마지막 T2 노출(지금 다시 읽은 값 — 정의자). */
  live_risk_at: Date | null;
  /** 같은 방향 · 목록에서 24시간 안에 거절된 다른 add_rule 수. */
  recent_rejections: number;
}

/**
 * 요청 행의 칸 + 지금 다시 읽은 위험 노출. 정의자 `atmark_agent_last_risk_exposure` 는 **부르는 쪽의 조직 id** 를 받아 에이전트가 그 조직의 것인지
 * 다시 본다(202610131500 — 보안 감사 L-3) — `orgParam` 은 그 조직 id 를 담은 자리표시자 번호다.
 */
function requestColumns(orgParam: number): string {
  return `id::text AS id, agent_id, action, direction, list, value, mode, reason, status, created_at, expires_at, decided_at, base_version,
       applied_version, stale_reason, tainted, last_risk_exposure_at,
       atmark_agent_last_risk_exposure($${String(orgParam)}::uuid, agent_id, created_at - interval '4 hours') AS live_risk_at,
       (SELECT count(*)::int FROM policy_change_requests j
         WHERE j.agent_id = policy_change_requests.agent_id AND j.id <> policy_change_requests.id AND j.status = 'rejected' AND j.action = 'add_rule'
           AND j.direction = policy_change_requests.direction AND j.list IS NOT DISTINCT FROM policy_change_requests.list
           AND j.decided_at > now() - interval '24 hours') AS recent_rejections`;
}

/** 목록에 싣는 상한 — pending 은 에이전트당 5 이하, 지난 것은 최근 순으로 이만큼. */
const LIST_LIMIT = 50;

function liveRules(state: PolicyState, direction: string, list: string): readonly string[] {
  return state.rules.filter((rule) => rule.direction === direction && rule.list === list).map((rule) => rule.value);
}

/** 지금 정책과 견준 차이. */
export function diffOf(change: PolicyRequestChange, state: PolicyState): PolicyRequestDiff {
  if (change.action === 'set_mode') {
    const before = change.direction === 'outbound' ? consoleOutboundModeOf(state.outboundMode) : consoleInboundModeOf(state.inboundMode);
    return { kind: 'mode', direction: change.direction, before, after: change.mode, inEffect: before === change.mode };
  }
  const values = liveRules(state, change.direction, change.list);
  const present = values.includes(change.value);
  const op = change.action === 'add_rule' ? 'add' : 'remove';
  const inEffect = op === 'add' ? present : !present;
  const countAfter = inEffect ? values.length : op === 'add' ? values.length + 1 : values.length - 1;
  return { kind: 'rule', direction: change.direction, list: change.list, op, value: change.value, countBefore: values.length, countAfter, inEffect };
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function viewOf(row: RequestRow, state: PolicyState, now: Date): PolicyRequestView | null {
  const change = policyRequestChangeOf(row);
  if (change === null) return null;
  const status = effectivePolicyRequestStatus(row.status, row.expires_at, now);
  return {
    id: row.id,
    agentId: toAgentId(row.agent_id),
    change,
    reason: row.reason,
    status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    decidedAt: status === 'expired' && row.decided_at === null ? row.expires_at.toISOString() : (row.decided_at?.toISOString() ?? null),
    baseVersion: row.base_version,
    appliedVersion: row.applied_version,
    staleReason: row.stale_reason,
    tainted: row.tainted || row.live_risk_at !== null,
    taintedAtRequest: row.tainted,
    lastRiskExposureAt: latest(row.last_risk_exposure_at, row.live_risk_at)?.toISOString() ?? null,
    diff: status === 'pending' ? diffOf(change, state) : null,
    recentRejections: status === 'pending' && change.action === 'add_rule' ? row.recent_rejections : 0,
  };
}

/** `?status=` — `pending`(기본) | `all`. */
export function resolvePolicyRequestFilter(raw: string | undefined): 'pending' | 'all' {
  if (raw === undefined || raw === '' || raw === 'pending') return 'pending';
  if (raw === 'all') return 'all';
  throw new AdminInputError('status 는 pending | all 이다.', 'invalid_status');
}

/** 그 에이전트의 요청 — 차이는 지금 정책(같은 스냅샷 읽기)과 견준다. 조직 범위는 라우트가 먼저 보고, 위험 노출 정의자가 한 번 더 본다. */
export async function listPolicyRequestsOp(
  pool: Pool,
  organizationId: string,
  agentId: AgentId,
  filter: 'pending' | 'all',
  now: Date,
): Promise<PolicyRequestList> {
  return withTransaction(pool, async (client) => {
    const state = await lockPolicy(client, agentId);
    const rows = await client.query<RequestRow>(
      `SELECT ${requestColumns(5)} FROM policy_change_requests
        WHERE agent_id = $1 AND ($2::boolean IS FALSE OR (status = 'pending' AND expires_at > $3))
        ORDER BY created_at DESC, id
        LIMIT $4`,
      [agentId, filter === 'pending', now, LIST_LIMIT, organizationId],
    );
    const items = rows.rows.flatMap((row) => {
      const view = viewOf(row, state, now);
      return view === null ? [] : [view];
    });
    return { items, currentVersion: state.version };
  });
}

export type PolicyRequestDecision = 'approve' | 'reject';

export type PolicyRequestOutcome =
  | { readonly kind: 'approved'; readonly request: PolicyRequestView; readonly policy: PolicyView }
  | { readonly kind: 'rejected'; readonly request: PolicyRequestView }
  /** 승인하려 했지만 지금 상태에서는 맞지 않았다(이미 그 상태 · 관리 연산의 거부) — 아무것도 바뀌지 않았다. */
  | { readonly kind: 'stale'; readonly request: PolicyRequestView; readonly reason: string }
  /** 7일이 지났다 — 그 자리에서 expired 로 닫았다. */
  | { readonly kind: 'expired'; readonly request: PolicyRequestView };

export interface DecidePolicyRequestInput {
  /** 결정하는 쪽의 조직(콘솔 세션 · CLI 는 그 에이전트의 조직) — 위험 노출 정의자가 에이전트가 이 조직의 것인지 본다(L-3). */
  readonly organizationId: string;
  readonly agentId: AgentId;
  readonly requestId: string;
  readonly decision: PolicyRequestDecision;
  /** 결정한 쪽 — `admin:session:<id>`(관리 연산의 `createdBy` 와 같은 모양) 또는 운영자 CLI `admin:policy-request:<운영자>`. */
  readonly actor: string;
  /** 결정한 사람(세션 사용자). 운영자 CLI 는 `null` — 사용자 세션을 흉내 내지 않는다(`decided_user_id` 는 NULL 허용). */
  readonly userId: string | null;
  /** 콘솔이 차이를 그린 정책 버전(승인만). 지금과 다르면 409 `policy_changed`. 없으면 확인하지 않는다(CLI 등). */
  readonly expectedVersion?: number;
  /** 위험 경고를 보고 승인한다는 확인(콘솔 확인란). 요청이 지금 오염돼 있으면(만들 때 또는 그 뒤) 없을 때 409 `risk_ack_required`. */
  readonly riskAcknowledged?: boolean;
  readonly now: Date;
}

/** 관리 연산이 거부하면(같은 코드) stale 의 까닭으로 남긴다 — 이 코드들만(나머지 오류는 그대로 던진다 · 트랜잭션은 되돌아간다). */
const STALE_CODES: ReadonlySet<string> = new Set([
  'rule_duplicate',
  'rule_not_found',
  'rule_limit',
  'rule_self_address',
  'rule_platform_domain',
  'invalid_rule_value',
  'legacy_mode_rejected',
  'policy_unevaluable',
]);

/** 승인 · 거절 하나. 결정과 (승인이면) 정책 새 버전은 **한 트랜잭션**이다(라우트의 `audited` 안에서 부르면 감사 1행도 같이). */
export async function decidePolicyRequestOp(pool: Pool, input: DecidePolicyRequestInput): Promise<PolicyRequestOutcome> {
  if (!UUID_PATTERN.test(input.requestId)) throw notFound('요청이 없다.', 'policy_request_not_found');
  return withTransaction(pool, async (client) => {
    // 만료는 DB 시각으로 본다(전이 트리거와 같은 시계 — 앱 시계와 어긋나 트리거가 거부하지 않게).
    const found = await client.query<RequestRow & { is_expired: boolean }>(
      `SELECT ${requestColumns(3)}, expires_at <= now() AS is_expired FROM policy_change_requests WHERE id = $1::uuid AND agent_id = $2 FOR UPDATE`,
      [input.requestId, input.agentId, input.organizationId],
    );
    const row = found.rows[0];
    const change = row === undefined ? null : policyRequestChangeOf(row);
    if (row === undefined || change === null) throw notFound('요청이 없다.', 'policy_request_not_found');
    if (row.status !== 'pending') {
      throw new AdminInputError(`이미 결정된 요청이다(${row.status}).`, 'policy_request_decided', 409);
    }

    const close = async (status: 'rejected' | 'stale' | 'expired', staleReason: string | null): Promise<RequestRow> => {
      const updated = await client.query<RequestRow>(
        `UPDATE policy_change_requests
            SET status = $2, decided_by = $3, decided_user_id = $4, stale_reason = $5
          WHERE id = $1::uuid
          RETURNING ${requestColumns(6)}`,
        [row.id, status, status === 'expired' ? 'system:expiry' : input.actor, status === 'expired' ? null : input.userId, staleReason, input.organizationId],
      );
      const next = updated.rows[0];
      if (next === undefined) throw new Error('policy_change_requests UPDATE 가 행을 돌려주지 않았다');
      return next;
    };

    if (row.is_expired) {
      const state = await lockPolicy(client, input.agentId);
      const view = viewOf(await close('expired', null), state, input.now);
      if (view === null) throw new Error('요청 행 모양이 틀렸다');
      return { kind: 'expired', request: view };
    }

    if (input.decision === 'reject') {
      const state = await lockPolicy(client, input.agentId);
      const view = viewOf(await close('rejected', null), state, input.now);
      if (view === null) throw new Error('요청 행 모양이 틀렸다');
      return { kind: 'rejected', request: view };
    }

    // ---- 승인 ----
    // 지운(disabled) 에이전트의 정책은 바꾸지 않는다 — 삭제가 pending 을 닫지만, 그 전에 연 콘솔 화면이 승인을 보내도 끊는다(쓰기 0).
    const agentStatus = await client.query<{ status: string; suspended_by: string | null; reserved: boolean }>(
      `SELECT a.status::text AS status, a.suspended_by::text AS suspended_by,
              EXISTS (SELECT 1 FROM agent_addresses d
                       WHERE d.agent_id = a.id AND d.retired_at IS NULL AND d.address = ANY (atmark_operator_assignable_addresses())) AS reserved
         FROM agents a WHERE a.id = $1`,
      [input.agentId],
    );
    const agent = agentStatus.rows[0];
    if (agent?.status === 'disabled') {
      throw new AdminInputError('삭제한 에이전트의 정책 변경 요청은 승인할 수 없다.', 'agent_deleted', 409);
    }
    // 운영자가 정지한 에이전트(보안 감사 L-1) — 소유자의 승인으로 정책을 넓히지 못한다(운영자가 풀기 전에는 쓰기 0). 콘솔 · CLI 가 같은 연산이다.
    if (agent?.status === 'suspended' && agent.suspended_by === 'operator') {
      throw new AdminInputError('운영자가 정지한 에이전트다 — 운영자가 풀기 전에는 정책 변경 요청을 승인할 수 없다.', 'operator_suspension', 409);
    }
    // 운영자 예약 주소 에이전트(보안 감사 M-1) — 정책은 운영자가 런북으로만 바꾼다. 만들기 정의자도 거부하고 마이그레이션이 pending 을 닫았다(쓰기 0).
    if (agent?.reserved === true) {
      throw new AdminInputError('운영자 예약 주소를 쥔 에이전트다 — 정책 변경 요청을 승인할 수 없다(운영자가 런북으로 바꾼다).', 'operator_reserved', 409);
    }
    // 위험 경고 확인은 서버가 강제한다(적대 검증 G07 · G08) — 만들 때의 오염 또는 그 뒤의 T2 노출(지금 다시 읽은 값). 쓰기 전에 끊는다.
    if ((row.tainted || row.live_risk_at !== null) && input.riskAcknowledged !== true) {
      throw new AdminInputError(
        '이 에이전트는 요청 직전 또는 그 뒤에 위험 표시된 메일을 읽었다 — 경고를 확인하고(ack) 승인하라.',
        'risk_ack_required',
        409,
      );
    }
    const current = await lockPolicy(client, input.agentId);
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new AdminInputError(
        `요청을 본 뒤 정책이 바뀌었다(본 버전 ${String(input.expectedVersion)} · 지금 ${String(current.version)}) — 다시 읽고 차이를 확인하라.`,
        'policy_changed',
        409,
      );
    }
    const stale = async (reason: string): Promise<PolicyRequestOutcome> => {
      const view = viewOf(await close('stale', reason), current, input.now);
      if (view === null) throw new Error('요청 행 모양이 틀렸다');
      return { kind: 'stale', request: view, reason };
    };
    if (diffOf(change, current).inEffect) return stale('already_applied');

    // 버전의 `created_by` 가 이 요청을 가리킨다(200자 이하 — 세션 actor 50자 남짓 + 요청 id).
    // 규칙 행의 `created_by` 도 같은 값이다 — 로더가 이 표지로 "에이전트가 요청한 규칙" 을 가려 위험 보류 면제에서 뺀다(보안 감사 H-1).
    const createdBy = policyRequestCreatedBy(input.actor, row.id);
    const tx = transactionPool(client);
    let policy: PolicyView;
    try {
      if (change.action === 'set_mode') {
        policy = await changePolicyOp(
          tx,
          input.agentId,
          resolvePolicyChange(change.direction === 'outbound' ? { outboundMode: change.mode } : { inboundMode: change.mode }),
          createdBy,
        );
      } else if (change.action === 'add_rule') {
        const rule = resolveContactRuleInput({ direction: change.direction, list: change.list, value: change.value });
        policy = (await addRuleOp(tx, input.agentId, rule, createdBy)).policy;
      } else {
        const target = current.rules.find((rule) => rule.direction === change.direction && rule.list === change.list && rule.value === change.value);
        if (target === undefined) return await stale('already_applied');
        policy = await removeRuleOp(tx, input.agentId, target.id, createdBy);
      }
    } catch (error) {
      // 관리 연산의 거부는 세이브포인트만 되돌린다(`transactionPool`) — 요청을 그 까닭으로 닫는다.
      if (error instanceof AdminInputError && STALE_CODES.has(error.code)) return stale(error.code);
      throw error;
    }

    const approved = await client.query<RequestRow>(
      `UPDATE policy_change_requests
          SET status = 'approved', decided_by = $2, decided_user_id = $3, applied_version = $4
        WHERE id = $1::uuid
        RETURNING ${requestColumns(5)}`,
      [row.id, input.actor, input.userId, policy.version, input.organizationId],
    );
    const next = approved.rows[0];
    if (next === undefined) throw new Error('policy_change_requests UPDATE 가 행을 돌려주지 않았다');
    const view = viewOf(next, await lockPolicy(client, input.agentId), input.now);
    if (view === null) throw new Error('요청 행 모양이 틀렸다');
    return { kind: 'approved', request: view, policy };
  });
}
