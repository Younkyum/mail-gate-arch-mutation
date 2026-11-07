/**
 * src/admin/ops/policy.ts — 에이전트 정책 보기·바꾸기(정책 v2 — 계약 `.omc/handoffs/v2-contract.md` §1 · ADR-0007).
 * **바꾸는 것은 언제나 새 `policy_versions` 행이다**(§4.3). CLI(`pnpm admin:policy`·`admin:rules`)와 관리 API
 * (`PATCH /api/agents/{id}/policy` · `POST/DELETE /api/agents/{id}/rules`)가 이 함수들을 부른다.
 *
 * 콘솔 이름 ↔ 내부 enum 매핑표(`src/policy/mode-names.ts` — 에이전트 표면과 공유):
 *   | 콘솔 | 발신 `outbound_mode` | 수신 `inbound_mode` |
 *   |---|---|---|
 *   | `all` (전체)          | `unrestricted`   | `all` |
 *   | `allowlist` (화이트리스트) | `allowlist_only` | `allowlist_only` |
 *   | `blocklist` (블랙리스트)   | `blocklist_only` | `blocklist_only` |
 *   | `none` (전부 X)       | `disabled`       | `disabled` |
 * 레거시 발신 모드(`approval_required`·`reply_only`)는 **보기 전용** `legacy` 로 보이고 어느 표면으로도 고를 수 없다
 * (`legacy_mode_rejected`). 소유자 롤로 프로비저닝할 때만 생긴다(데모·테스트).
 *
 * 가드(두 표면 동일):
 *   - 모르는 모드 거부 · 레거시 모드 거부 · 분당 한도 1~9999 정수 · **요금제 상한 이하**(`agent_per_minute_max`, ADR-0011 → 409
 *     `plan_per_minute_limit` — Stage 4 도 min() 하지만 소유자가 적은 값이 조용히 무시되지 않게 입력에서 끊는다).
 *   - `auto_approve_verification_senders` ON 은 **AC-7 확인 없이 거부**(레거시 승인 모드 전용 손잡이 — CLI 만 노출).
 *   - 쓰기 전에 관문의 `resolvePolicy` 로 새 정책을 해석해 본다 — 해석 안 되는 정책을 쓰면 그 에이전트의 발송이 전부
 *     `evaluation_error` 가 되고, 그 사실은 다음 발송 때에야 드러난다.
 *
 * `policy_versions` 새 행과 `agent_policies` 갱신은 **한 트랜잭션**(관문은 `current_version` 이 스냅샷 버전과 같은지 대조한다).
 * 스냅샷은 그 트랜잭션 안에서 **다시 읽은** 목록 전량을 싣는다(`policySnapshotOf`) — 목록 변경과 버전이 갈라지지 않는다.
 */

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../db/client';
import { loadAgentEntitlements } from '../../db/repositories/entitlements';
import {
  LEGACY_OUTBOUND_MODES,
  MAX_CONTACT_RULES_PER_LIST,
  toAgentId,
  type AgentId,
  type AgentPolicyRow,
  type ContactRuleRow,
  type InboundMode,
  type JsonObject,
  type OutboundMode,
  type PolicyVersionRow,
} from '../../db/schema';
import { PolicyShapeError, resolvePolicy } from '../../policy/policy-loader';
import {
  CONSOLE_INBOUND_MODES,
  CONSOLE_MODES,
  CONSOLE_OUTBOUND_MODES,
  consoleInboundModeOf,
  consoleOutboundModeOf,
  type ConsoleMode,
} from '../../policy/mode-names';
import { policySnapshotOf } from '../../policy/policy-snapshot';
import { AdminInputError, notFound } from './errors';

// 콘솔 이름 ↔ enum — 표는 `src/policy/mode-names.ts` 하나(에이전트 표면도 같은 이름을 말한다). CLI(`scripts/admin/policy.ts`)가 여기서 읽는다.
export { CONSOLE_MODES } from '../../policy/mode-names';

// ---------------------------------------------------------------------------
// 상태 · 버전
// ---------------------------------------------------------------------------

interface PolicyState {
  readonly outboundMode: OutboundMode;
  readonly inboundMode: InboundMode;
  readonly limits: JsonObject;
  readonly configJson: JsonObject;
  /** 소유자 발신 승인 `always`(`agent_policies.require_approval` — ADR-0016 2026-10-08). 스냅샷에도 같은 값을 싣는다. */
  readonly requireApproval: boolean;
  readonly version: number;
  /** 이 에이전트의 연락처 규칙 전량(두 방향). */
  readonly rules: readonly ContactRuleRow[];
}

/** 새 버전의 내용 — 목록은 버전을 쓰는 순간 테이블에서 다시 읽는다(`appendPolicyVersion`). */
type PolicyContent = Omit<PolicyState, 'version' | 'rules'>;

async function loadRules(client: PoolClient, agentId: AgentId): Promise<ContactRuleRow[]> {
  const result = await client.query<ContactRuleRow>(
    `SELECT id, agent_id, direction, list, kind, value, created_at, created_by, removed_at, removed_by
       FROM agent_contact_rules WHERE agent_id = $1 AND removed_at IS NULL ORDER BY direction, list, value`,
    [agentId],
  );
  return result.rows.map((row) => ({ ...row, agent_id: toAgentId(row.agent_id) }));
}

/** 현재 정책을 잠그고 읽는다(`FOR UPDATE` — 동시 변경이 같은 다음 버전 번호를 두 번 쓰지 않게, 목록 변경도 이 잠금으로 직렬화). */
export async function lockPolicy(client: PoolClient, agentId: AgentId): Promise<PolicyState> {
  const result = await client.query<{ limits: JsonObject; config_json: JsonObject; require_approval: boolean; current_version: number }>(
    'SELECT limits, config_json, require_approval, current_version FROM agent_policies WHERE agent_id = $1 FOR UPDATE',
    [agentId],
  );
  const row = result.rows[0];
  if (row === undefined) throw notFound(`에이전트 ${agentId} 의 정책 행이 없다(에이전트가 없다).`, 'agent_not_found');
  // 모드의 진실은 현재 버전의 스냅샷이다(`resolvePolicy`). 행의 모드가 아니라 그걸 이어받는다.
  const version = await client.query<{ outbound_mode: OutboundMode; inbound_mode: InboundMode }>(
    'SELECT outbound_mode, inbound_mode FROM policy_versions WHERE agent_id = $1 AND version = $2',
    [agentId, row.current_version],
  );
  const modes = version.rows[0];
  if (modes === undefined) {
    throw new AdminInputError(`에이전트 ${agentId} 의 현재 정책 버전(${String(row.current_version)}) 행이 없다.`, 'policy_corrupt', 409);
  }
  return {
    outboundMode: modes.outbound_mode,
    inboundMode: modes.inbound_mode,
    limits: row.limits,
    configJson: row.config_json,
    requireApproval: row.require_approval,
    version: row.current_version,
    rules: await loadRules(client, agentId),
  };
}

/** 새 정책이 관문에서 해석되는지 — 관문과 같은 함수로 본다. */
export function assertEvaluable(agentId: AgentId, next: PolicyContent, version: number, rules: readonly ContactRuleRow[]): void {
  const now = new Date();
  const policy: AgentPolicyRow = {
    agent_id: agentId,
    outbound_mode: next.outboundMode,
    inbound_mode: next.inboundMode,
    require_approval: next.requireApproval,
    limits: next.limits,
    config_json: next.configJson,
    current_version: version,
    created_at: now,
    updated_at: now,
  };
  const snapshot: PolicyVersionRow = {
    id: '00000000-0000-0000-0000-000000000000',
    agent_id: agentId,
    version,
    outbound_mode: next.outboundMode,
    inbound_mode: next.inboundMode,
    snapshot: policySnapshotOf({ ...next, rules }),
    created_by: null,
    created_at: now,
  };
  try {
    // 해석 가능성만 본다(관문 판정 아님) — 요청 출처는 판정에만 쓰여 비워 둔다.
    resolvePolicy(policy, snapshot, []);
  } catch (error) {
    if (error instanceof PolicyShapeError) throw new AdminInputError(`새 정책을 관문이 해석할 수 없다: ${error.message}`, 'policy_unevaluable');
    throw error;
  }
}

/**
 * 한 버전 올린다. `lockPolicy` 를 부른 같은 트랜잭션 안에서만 부른다 — 목록을 바꿨다면 **바꾼 뒤에** 부른다(스냅샷이 이 순간의
 * 목록을 다시 읽어 싣는다). 새 버전 번호와 그 목록을 돌려준다.
 */
export async function appendPolicyVersion(
  client: PoolClient,
  agentId: AgentId,
  current: Pick<PolicyState, 'version'>,
  next: PolicyContent,
  createdBy: string,
): Promise<{ readonly version: number; readonly rules: readonly ContactRuleRow[] }> {
  const version = current.version + 1;
  const rules = await loadRules(client, agentId);
  assertEvaluable(agentId, next, version, rules);
  await client.query(
    `INSERT INTO policy_versions (agent_id, version, outbound_mode, inbound_mode, snapshot, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [agentId, version, next.outboundMode, next.inboundMode, JSON.stringify(policySnapshotOf({ ...next, rules })), createdBy],
  );
  await client.query(
    `UPDATE agent_policies
        SET outbound_mode = $2, inbound_mode = $3, limits = $4::jsonb, config_json = $5::jsonb, current_version = $6, require_approval = $7
      WHERE agent_id = $1`,
    [agentId, next.outboundMode, next.inboundMode, JSON.stringify(next.limits), JSON.stringify(next.configJson), version, next.requireApproval],
  );
  return { version, rules };
}

// ---------------------------------------------------------------------------
// 변경 요청 — 두 표면 공통 검증
// ---------------------------------------------------------------------------

interface PolicyChangeRequest {
  /** 콘솔 이름(`all|allowlist|blocklist|none`). */
  readonly outboundMode?: string | undefined;
  readonly inboundMode?: string | undefined;
  /** CLI 는 문자열, API 는 숫자 — 같은 규칙(1~9999 정수)으로 본다. */
  readonly perMinute?: string | number | undefined;
  /** 레거시 승인 모드 전용(`auto_approve_verification_senders`) — CLI 만 넘긴다. */
  readonly verificationSenders?: boolean | undefined;
  /** AC-7 미검증을 알고 켠다는 명시 확인. */
  readonly ac7Acknowledged?: boolean | undefined;
}

export interface PolicyChange {
  readonly outboundMode: OutboundMode | undefined;
  readonly inboundMode: InboundMode | undefined;
  readonly perMinute: number | undefined;
  readonly verificationSenders: boolean | undefined;
  /** 소유자 발신 승인(`auto` → false · `always` → true). 감시 탭 `PATCH /api/agents/{id}/watch {sendApproval}` 가 넘긴다. */
  readonly requireApproval?: boolean | undefined;
}

const AC7_UNACKNOWLEDGED_MESSAGE =
  'auto_approve_verification_senders 를 켜지 않는다 — 전제인 injection 스캐너(AC-7)가 판정 보류다 ' +
  '(gate-readiness "AC-7 판정 보류": GATE 중에는 켜지 않는다). 그래도 켜려면 명시 확인을 함께 준다 ' +
  '(CLI --i-know-ac7-is-unverified). 레거시 승인 모드에서만 의미가 있다.';

const LEGACY_MODE_REJECTED_MESSAGE =
  '승인 모드(approval_required·reply_only)는 레거시다 — 새로 고를 수 없다(ADR-0007). 목록 밖을 막으려면 allowlist, ' +
  '특정 상대만 막으려면 blocklist 를 쓴다.';

const CONSOLE_MODE_LIST = CONSOLE_MODES.join(' | ');

function resolveConsoleMode(raw: string, direction: 'outbound' | 'inbound'): ConsoleMode {
  if ((CONSOLE_MODES as readonly string[]).includes(raw)) return raw as ConsoleMode;
  if (direction === 'outbound' && (raw === 'legacy' || (LEGACY_OUTBOUND_MODES as readonly string[]).includes(raw))) {
    throw new AdminInputError(LEGACY_MODE_REJECTED_MESSAGE, 'legacy_mode_rejected');
  }
  throw new AdminInputError(`${direction} mode 는 ${CONSOLE_MODE_LIST}: ${raw}`, 'invalid_mode');
}

export function resolvePolicyChange(request: PolicyChangeRequest): PolicyChange {
  const outboundMode =
    request.outboundMode === undefined ? undefined : CONSOLE_OUTBOUND_MODES[resolveConsoleMode(request.outboundMode, 'outbound')];
  const inboundMode =
    request.inboundMode === undefined ? undefined : CONSOLE_INBOUND_MODES[resolveConsoleMode(request.inboundMode, 'inbound')];
  let perMinute: number | undefined;
  if (request.perMinute !== undefined) {
    const raw = request.perMinute;
    const ok = typeof raw === 'string' ? /^[1-9]\d{0,3}$/.test(raw) : Number.isInteger(raw) && raw >= 1 && raw <= 9999;
    if (!ok) throw new AdminInputError(`per_minute 는 1~9999 정수: ${String(raw)}`, 'invalid_per_minute');
    perMinute = Number(raw);
  }
  const verificationSenders = request.verificationSenders;
  if (verificationSenders === true && request.ac7Acknowledged !== true) {
    throw new AdminInputError(AC7_UNACKNOWLEDGED_MESSAGE, 'ac7_unacknowledged');
  }
  return { outboundMode, inboundMode, perMinute, verificationSenders };
}

function isPolicyChangeEmpty(change: PolicyChange): boolean {
  return (
    change.outboundMode === undefined &&
    change.inboundMode === undefined &&
    change.perMinute === undefined &&
    change.verificationSenders === undefined &&
    change.requireApproval === undefined
  );
}

function applyPolicyChange(current: PolicyState, change: PolicyChange): PolicyContent {
  const limits: JsonObject = change.perMinute === undefined ? current.limits : { ...current.limits, per_minute: change.perMinute };
  const configJson: JsonObject =
    change.verificationSenders === undefined
      ? current.configJson
      : { ...current.configJson, auto_approve_verification_senders: change.verificationSenders };
  return {
    outboundMode: change.outboundMode ?? current.outboundMode,
    inboundMode: change.inboundMode ?? current.inboundMode,
    limits,
    configJson,
    requireApproval: change.requireApproval ?? current.requireApproval,
  };
}

// ---------------------------------------------------------------------------
// 보기
// ---------------------------------------------------------------------------

/** 목록 한 행 — 관리 API 모양(`rule = {id, kind, value, createdAt}`). 표시 정화는 라우트가 한다. */
export interface RuleView {
  readonly id: string;
  readonly kind: ContactRuleRow['kind'];
  readonly value: string;
  readonly createdAt: string;
}

interface DirectionView<Mode extends string> {
  readonly mode: Mode;
  readonly allow: readonly RuleView[];
  readonly block: readonly RuleView[];
}

/** 관리 API·CLI 가 보여 주는 정책 모양(계약 v2 §1 · T1 메모). */
export interface PolicyView {
  readonly outbound: DirectionView<ConsoleMode | 'legacy'> & { readonly legacyMode: (typeof LEGACY_OUTBOUND_MODES)[number] | null };
  readonly inbound: DirectionView<ConsoleMode>;
  readonly limits: JsonObject;
  readonly version: number;
  readonly ruleLimit: number;
  /** CLI 만 쓴다(레거시 승인 모드의 손잡이). API 응답에는 싣지 않는다. */
  readonly autoApproveVerificationSenders: boolean;
  /** 소유자 발신 승인(ADR-0016 2026-10-08). */
  readonly sendApproval: 'auto' | 'always';
}

function ruleViewOf(rule: ContactRuleRow): RuleView {
  return { id: rule.id, kind: rule.kind, value: rule.value, createdAt: rule.created_at.toISOString() };
}

function listOf(rules: readonly ContactRuleRow[], direction: ContactRuleRow['direction'], list: ContactRuleRow['list']): RuleView[] {
  return rules
    .filter((rule) => rule.direction === direction && rule.list === list)
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .map(ruleViewOf);
}

/** `ruleLimit` — 에이전트·방향·목록마다 규칙 상한(콘솔이 "n/1000" 을 보인다). */
export function policyViewOf(state: PolicyState, ruleLimit: number = MAX_CONTACT_RULES_PER_LIST): PolicyView {
  const outboundMode = consoleOutboundModeOf(state.outboundMode);
  return {
    outbound: {
      mode: outboundMode,
      legacyMode: outboundMode === 'legacy' ? (state.outboundMode as (typeof LEGACY_OUTBOUND_MODES)[number]) : null,
      allow: listOf(state.rules, 'outbound', 'allow'),
      block: listOf(state.rules, 'outbound', 'block'),
    },
    inbound: {
      mode: consoleInboundModeOf(state.inboundMode),
      allow: listOf(state.rules, 'inbound', 'allow'),
      block: listOf(state.rules, 'inbound', 'block'),
    },
    limits: state.limits,
    version: state.version,
    ruleLimit,
    autoApproveVerificationSenders: state.configJson['auto_approve_verification_senders'] === true,
    sendApproval: state.requireApproval ? 'always' : 'auto',
  };
}

export async function readPolicyOp(pool: Pool, agentId: AgentId): Promise<PolicyView> {
  return policyViewOf(await withTransaction(pool, (client) => lockPolicy(client, agentId)));
}

/** `per_minute` 가 요금제 상한(`agent_per_minute_max`) 이하인가 — 넘으면 409 `plan_per_minute_limit`. 행이 없는 조직은 Free(5). */
export async function requirePerMinuteWithinPlan(db: Pick<PoolClient, 'query'>, agentId: AgentId, perMinute: number): Promise<void> {
  const entitlements = await loadAgentEntitlements(db, agentId, new Date());
  if (entitlements === null) return; // 없는 에이전트 — lockPolicy 가 이미 404 로 거른다.
  if (perMinute > entitlements.agentPerMinuteMax) {
    throw new AdminInputError(
      `per_minute 는 요금제(${entitlements.planCode}) 상한 ${String(entitlements.agentPerMinuteMax)} 이하다: ${String(perMinute)}`,
      'plan_per_minute_limit',
      409,
    );
  }
}

/** 새 버전 하나. 변경이 비었으면 거부한다(버전만 느는 빈 행을 만들지 않는다). */
export async function changePolicyOp(pool: Pool, agentId: AgentId, change: PolicyChange, createdBy: string): Promise<PolicyView> {
  if (isPolicyChangeEmpty(change)) throw new AdminInputError('바꿀 것이 없다(outbound·inbound 모드·perMinute 중 하나 이상).', 'no_change');
  return withTransaction(pool, async (client) => {
    const current = await lockPolicy(client, agentId);
    if (change.perMinute !== undefined) await requirePerMinuteWithinPlan(client, agentId, change.perMinute);
    const next = applyPolicyChange(current, change);
    const { version, rules } = await appendPolicyVersion(client, agentId, current, next, createdBy);
    return policyViewOf({ ...next, version, rules });
  });
}

// ---------------------------------------------------------------------------
// 운영 명령 — 정책 첨부 총량 기본값을 "요금제를 따른다"(null)로 (메일 기본기 2차 · 보안 리뷰 M3)
// ---------------------------------------------------------------------------

/** 옛 프로비저닝 기본값 — 이 값 그대로인 정책만 옮긴다(`src/identity/provisioning.ts` `DEFAULT_MAX_ATTACHMENT_BYTES_TOTAL`). */
export const LEGACY_ATTACHMENT_DEFAULT_BYTES = 10 * 1024 * 1024;

interface PolicyAttachmentDefaultResult {
  /** 대상(값이 옛 기본값 그대로인 정책) 수. */
  readonly candidates: number;
  /** 새 버전을 쓴 에이전트(`dryRun` 이면 0). */
  readonly changed: readonly AgentId[];
}

/**
 * 값이 옛 기본값(10 MiB) 그대로인 정책을 `null`("요금제를 따른다")로 옮긴다 — **에이전트마다 한 트랜잭션 · 정책 새 버전**(관리 연산과 같은
 * `appendPolicyVersion` — 스냅샷·연락처 목록·평가 가능 검사가 같다, `policy.version` 잎 하나). 소유자가 이 칸을 바꿀 입력 경로가 없었으므로 그
 * 값 그대로인 행은 전부 기본값이다. 잠근 뒤 다시 보고(동시 변경) 값이 달라졌으면 건너뛴다. **새 정책 로더가 모든 λ 에 배포된 뒤에만** 부른다
 * (옛 로더는 null 을 읽지 못한다 — 런북 deploy §23). `dryRun` 이면 세기만 한다.
 */
export async function policyAttachmentDefaultOp(
  pool: Pool,
  options: {
    readonly dryRun: boolean;
    readonly createdBy: string;
    readonly limit?: number;
    /** 이 에이전트들로만 좁힌다(카나리 · 테스트). 없으면 전체. */
    readonly agentIds?: readonly string[];
  },
): Promise<PolicyAttachmentDefaultResult> {
  const found = await pool.query<{ agent_id: string }>(
    `SELECT agent_id FROM agent_policies
      WHERE config_json -> 'max_attachment_bytes_total' = to_jsonb($1::int) AND ($3::text[] IS NULL OR agent_id = ANY($3::text[]))
      ORDER BY agent_id LIMIT $2`,
    [LEGACY_ATTACHMENT_DEFAULT_BYTES, options.limit ?? 100_000, options.agentIds ?? null],
  );
  const candidates = found.rows.map((row) => toAgentId(row.agent_id));
  if (options.dryRun) return { candidates: candidates.length, changed: [] };
  const changed: AgentId[] = [];
  for (const agentId of candidates) {
    const did = await withTransaction(pool, async (client) => {
      const current = await lockPolicy(client, agentId);
      if (current.configJson['max_attachment_bytes_total'] !== LEGACY_ATTACHMENT_DEFAULT_BYTES) return false;
      await appendPolicyVersion(
        client,
        agentId,
        current,
        {
          outboundMode: current.outboundMode,
          inboundMode: current.inboundMode,
          limits: current.limits,
          configJson: { ...current.configJson, max_attachment_bytes_total: null },
          requireApproval: current.requireApproval,
        },
        options.createdBy,
      );
      return true;
    });
    if (did) changed.push(agentId);
  }
  return { candidates: candidates.length, changed };
}
