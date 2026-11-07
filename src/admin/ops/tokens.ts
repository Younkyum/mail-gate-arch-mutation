/**
 * src/admin/ops/tokens.ts — 에이전트 토큰 **목록·한 개 폐기·이름 바꾸기**(콘솔 v4 D7 · 명세 `console-v4-design.md` §(e) E3·E5·E6).
 * 발급(`issueAgentTokenOp`) · 한 개 교체(`supersedeAgentTokenOp`) · 전부 교체·전부 폐기(`revokeAgentTokensOp`)는 새 평문을 만들므로
 * `ops/agents.ts` 에 있고, 이 파일의 행 모양·상한·잠금을 쓴다.
 *
 * 가드:
 *   - **해시·평문은 모양에 없다** — `TokenView` 에 `token_hash` 가 없다(SELECT 도 하지 않는다). 평문은 발급 응답 1회뿐(`ops/agents.ts`).
 *   - **에이전트 범위** — 모든 조회·변경이 `agent_id` 와 토큰 `id` 를 **둘 다** 조건에 건다. 같은 조직의 다른 에이전트 토큰도 404
 *     (`token_not_found`). 조직 범위는 호출자(`requireAgentInOrganization`)가 먼저 본다.
 *   - **폐기 시각 불변** — `WHERE revoked_at IS NULL`(+ DB 트리거 `agent_api_keys_revoked_once`). 두 번째 폐기는 아무것도 바꾸지 않는다.
 *   - **활성 상한** `min(MAX_ACTIVE_TOKENS_PER_AGENT, 요금제 tokens_per_agent_max)`(ADR-0011) — 에이전트 단위 advisory 잠금 아래에서
 *     센다. DB 트리거(`agent_api_keys_active_limit`, 202609250010)가 **같은 잠금 키**로 천장 5 를 한 번 더 막는다.
 *   - **이름** — 1–60자, 앞뒤 공백 없음, 제어·보이지 않는 문자 없음(가입 조직 이름과 같은 문자 집합 · DB CHECK 의 상위 집합).
 *     이름 바꾸기는 **활성 토큰만**(폐기·만료 → 409 `token_not_active`).
 *   - **목록 상한이 활성 토큰을 숨기지 않는다** — 활성(≤ 5)이 먼저, 끝난 토큰은 그 뒤 최신순(`TOKEN_LIST_MAX_ROWS`).
 *   - **감사 상세** — 한 개 폐기·이름 바꾸기·한 개 교체는 감사 행(`owner_actions`, 대상 = 에이전트 id) 옆에 토큰 id · 이름 전·후 ·
 *     교체의 새 토큰 id 를 `agent_api_key_events` 한 행으로 남긴다(`recordTokenEvent`).
 *   - **조직당 속도** — 새 토큰·한 개 폐기·이름 바꾸기·한 개 교체는 조직당 분당 `TOKEN_CHANGES_PER_MINUTE` 번(감사 행을 센다, 조직 잠금
 *     아래) → 429.
 */

import type { Queryable } from '../../db/client';
import { OPERATOR_RESERVED_AGENT_SQL } from '../../db/repositories/agent-token-store';
import { loadAgentEntitlements } from '../../db/repositories/entitlements';
import type { AgentId } from '../../db/schema';
import {
  effectiveAgentTokenCapabilities,
  impliedAgentTokenCapabilities,
  withoutOperatorReservedExclusions,
  type AgentTokenCapability,
} from '../../identity/agent-token';
import { INVISIBLE_OR_CONTROL_CHARACTERS } from '../display';
import { AdminInputError, notFound, UUID_PATTERN } from './errors';

/** 에이전트당 활성(폐기·만료 전) 토큰 상한(D7). DB 트리거 `agent_api_keys_active_limit` 의 5 와 같아야 한다. */
export const MAX_ACTIVE_TOKENS_PER_AGENT = 5;
/** 토큰 이름 상한(코드 포인트) — DB CHECK `agent_api_keys_label_check` 와 같다. */
export const TOKEN_LABEL_MAX_LENGTH = 60;
/** `status=all` 이 보여 주는 끝난(폐기·만료) 토큰의 기간 — 끝난 지 이 일수 안. */
const TOKEN_HISTORY_DAYS = 90;
/** 목록 상한 — 끝난(폐기·만료) 토큰 행. 활성 토큰(≤ `MAX_ACTIVE_TOKENS_PER_AGENT`)은 이것과 별개로 늘 전부 실린다. */
export const TOKEN_LIST_MAX_ROWS = 50;
/** 조직당 분당 토큰 변경(새 토큰 · 한 개 폐기 · 이름 바꾸기 · 한 개 교체 — 감사된 것만) 상한. */
export const TOKEN_CHANGES_PER_MINUTE = 20;
/** 속도 상한이 세는 감사 행위. `agent.token.rotate_one` = 한 개 교체(전부 교체 `agent.token.rotate` 와 다르다). */
const TOKEN_CHANGE_ACTIONS = ['agent.token.issue', 'agent.token.revoke', 'agent.token.rename', 'agent.token.rotate_one'] as const;

type TokenStatus = 'active' | 'expired' | 'revoked';
export type TokenListScope = 'active' | 'all';

/** 토큰 한 행의 화면 모양(명세 E3). **해시가 없다.** */
export interface TokenView {
  readonly id: string;
  /** 소유자가 붙인 이름. 옛 토큰은 `null`("이름 없음"). */
  readonly label: string | null;
  /** 평문의 끝 4자. 옛 토큰은 `null`(복구 불가). */
  readonly hint: string | null;
  /** 발급 때 준 권한(열 그대로 — 불변). */
  readonly capabilities: readonly AgentTokenCapability[];
  /**
   * 열에는 없지만 인증 때 **함의되는** 권한(`impliedAgentTokenCapabilities` — 기본값 이전 토큰의 `policy:request`). 화면은 "포함(기존 토큰)"으로
   * 보인다. 인증이 쓰는 유효 권한 = `capabilities` + 이것.
   */
  readonly impliedCapabilities: readonly AgentTokenCapability[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  /** 폐기가 만료보다 앞선다. */
  readonly status: TokenStatus;
}

interface TokenListView {
  readonly tokens: readonly TokenView[];
  readonly activeCount: number;
  readonly maxActive: number;
}

interface TokenRow {
  id: string;
  label: string | null;
  hint: string | null;
  capabilities: string[];
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  status: TokenStatus;
  self_enrolled_agent: boolean;
  operator_reserved_agent: boolean;
}

/** 활성 술어 — `k` 별칭. 인증(`authenticateAgentToken`: 만료 시각 **도달**이면 만료)과 같은 경계. */
const ACTIVE_SQL = `k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())`;

/** 화면 칸만 — `token_hash` 는 읽지 않는다. ENUM 배열은 `::text[]`(node-postgres 가 사용자 ENUM 배열을 파싱하지 못한다). */
const TOKEN_SELECT_SQL = `SELECT k.id::text AS id, k.label, k.hint, k.capabilities::text[] AS capabilities, k.created_at, k.expires_at,
         k.last_used_at, k.revoked_at,
         EXISTS (SELECT 1 FROM agent_enrollments e WHERE e.child_agent_id = k.agent_id) AS self_enrolled_agent,
         ${OPERATOR_RESERVED_AGENT_SQL} AS operator_reserved_agent,
         CASE WHEN k.revoked_at IS NOT NULL THEN 'revoked'
              WHEN k.expires_at IS NOT NULL AND k.expires_at <= now() THEN 'expired'
              ELSE 'active' END AS status
    FROM agent_api_keys k`;

function toTokenView(row: TokenRow): TokenView {
  return {
    id: row.id,
    label: row.label,
    hint: row.hint,
    capabilities: row.capabilities as AgentTokenCapability[],
    impliedCapabilities: impliedAgentTokenCapabilities({
      capabilities: row.capabilities as AgentTokenCapability[],
      issuedAt: row.created_at,
      selfEnrolledAgent: row.self_enrolled_agent,
      operatorReservedAgent: row.operator_reserved_agent,
    }),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at === null ? null : row.last_used_at.toISOString(),
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    status: row.status,
  };
}

function tokenNotFound(): AdminInputError {
  return notFound('토큰이 없다.', 'token_not_found');
}

/** 이름 모양: 1–60 코드 포인트 · 앞뒤 공백 없음 · 제어·보이지 않는 문자 없음(가입 조직 이름과 같은 집합). */
export function isValidTokenLabel(label: string): boolean {
  const length = [...label].length;
  return length >= 1 && length <= TOKEN_LABEL_MAX_LENGTH && label.trim() === label && !INVISIBLE_OR_CONTROL_CHARACTERS.test(label);
}

/**
 * 요청 본문의 `label` → 저장할 값. 문자열이면 앞뒤 공백을 걷고 검사한다. `required` 가 아니면 없음(`undefined`·`null`)은 `null`.
 * 그 밖은 400 `invalid_label`.
 */
export function resolveTokenLabel(raw: unknown, required: boolean): string | null {
  if (raw === undefined || raw === null) {
    if (required) throw new AdminInputError(`label(토큰 이름, 1~${String(TOKEN_LABEL_MAX_LENGTH)}자)이 필요하다.`, 'invalid_label');
    return null;
  }
  if (typeof raw !== 'string') throw new AdminInputError('label 은 문자열이다.', 'invalid_label');
  const label = raw.trim();
  if (!isValidTokenLabel(label)) {
    throw new AdminInputError(`토큰 이름은 1~${String(TOKEN_LABEL_MAX_LENGTH)}자, 제어 문자·보이지 않는 문자 없이.`, 'invalid_label');
  }
  return label;
}

/**
 * 에이전트의 토큰 발급 잠금(트랜잭션 끝까지) — 상한 검사와 INSERT 사이에 다른 발급이 끼지 않게. 키는 DB 트리거
 * `agent_api_keys_active_limit` 과 **같다**(같은 세션은 다시 잡아도 된다).
 */
export async function lockAgentTokens(db: Queryable, agentId: AgentId): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('agent_api_keys_active:' || $1::text, 0))`, [agentId]);
}

async function countActiveTokens(db: Queryable, agentId: AgentId): Promise<number> {
  const result = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_api_keys k WHERE k.agent_id = $1 AND ${ACTIVE_SQL}`, [agentId]);
  return result.rows[0]?.n ?? 0;
}

/**
 * 이 에이전트의 활성 토큰 상한 = `min(MAX_ACTIVE_TOKENS_PER_AGENT, 요금제)`(ADR-0011). 에이전트가 없으면 천장(없는 에이전트는 호출자가 먼저
 * 404 로 거른다). 행이 없는 조직은 Free(fail-closed).
 */
async function tokenLimitOf(db: Queryable, agentId: AgentId): Promise<number> {
  const entitlements = await loadAgentEntitlements(db, agentId, new Date());
  return Math.min(MAX_ACTIVE_TOKENS_PER_AGENT, entitlements?.tokensPerAgentMax ?? MAX_ACTIVE_TOKENS_PER_AGENT);
}

/** 상한에 닿았으면 409 `token_limit`. 잠금(`lockAgentTokens`) 아래에서 부른다. */
export async function requireTokenCapacity(db: Queryable, agentId: AgentId): Promise<void> {
  const limit = await tokenLimitOf(db, agentId);
  if ((await countActiveTokens(db, agentId)) >= limit) {
    throw new AdminInputError(
      `에이전트당 활성 토큰은 ${String(limit)}개까지다(요금제 한도) — 쓰지 않는 토큰을 폐기하거나 전부 교체하라.`,
      'token_limit',
      409,
    );
  }
}

/** 토큰 한 행 INSERT(해시·끝 4자·이름) → 화면 모양. 평문은 받지 않는다. */
export async function insertAgentTokenRow(
  db: Queryable,
  input: {
    readonly agentId: AgentId;
    readonly tokenHash: string;
    readonly hint: string;
    readonly capabilities: readonly AgentTokenCapability[];
    readonly expiresAt: Date | null;
    readonly label: string | null;
  },
): Promise<TokenView> {
  // 운영자 예약 주소 에이전트(support@ 등)의 새 토큰에는 `policy:request` 를 넣지 않는다(보안 감사 M-1 — 기본값 · 명시 · 교체 모두).
  const reserved = await db.query<{ reserved: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM agent_addresses WHERE agent_id = $1 AND retired_at IS NULL AND address = ANY (atmark_operator_assignable_addresses())) AS reserved',
    [input.agentId],
  );
  const narrowed = reserved.rows[0]?.reserved === true ? withoutOperatorReservedExclusions(input.capabilities) : input.capabilities;
  if (narrowed.length === 0) {
    throw new AdminInputError('운영자 예약 주소 에이전트에는 policy:request 만 든 토큰을 발급할 수 없다.', 'invalid_capability');
  }
  const capabilities = narrowed;
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO agent_api_keys (agent_id, token_hash, capabilities, expires_at, hint, label)
     VALUES ($1, $2, $3::agent_token_capability[], $4, $5, $6)
     RETURNING id::text AS id`,
    [input.agentId, input.tokenHash, [...capabilities], input.expiresAt, input.hint, input.label],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error('agent_api_keys INSERT 가 행을 돌려주지 않았다');
  const item = await readAgentTokenOp(db, input.agentId, id);
  if (item === null) throw new Error('방금 넣은 토큰 행을 읽지 못했다');
  return item;
}

/** 이 에이전트의 토큰 하나(없거나 남의 것이면 `null`). */
export async function readAgentTokenOp(db: Queryable, agentId: AgentId, tokenId: string): Promise<TokenView | null> {
  if (!UUID_PATTERN.test(tokenId)) return null;
  const result = await db.query<TokenRow>(`${TOKEN_SELECT_SQL} WHERE k.id = $2::uuid AND k.agent_id = $1`, [agentId, tokenId]);
  const row = result.rows[0];
  return row === undefined ? null : toTokenView(row);
}

/**
 * 목록(E3). `active` = 활성 전부. `all` = 활성 + 끝난 지(폐기·만료 중 이른 시각) `TOKEN_HISTORY_DAYS` 안의 토큰. **활성이 먼저**, 그 안에서
 * 최신순. 상한은 `TOKEN_LIST_MAX_ROWS + MAX_ACTIVE_TOKENS_PER_AGENT` — 활성은 DB 트리거가 5개로 묶으므로 끝난 토큰이 아무리 많아도 활성은
 * 전부 실린다. `activeCount` 는 상한과 무관한 실제 활성 수.
 */
export async function listAgentTokensOp(db: Queryable, agentId: AgentId, scope: TokenListScope): Promise<TokenListView> {
  const scopeSql =
    scope === 'active'
      ? ACTIVE_SQL
      : `((${ACTIVE_SQL}) OR LEAST(k.revoked_at, k.expires_at) >= now() - make_interval(days => ${String(TOKEN_HISTORY_DAYS)}))`;
  const rows = await db.query<TokenRow>(
    `${TOKEN_SELECT_SQL} WHERE k.agent_id = $1 AND ${scopeSql} ORDER BY (${ACTIVE_SQL}) DESC, k.created_at DESC, k.id DESC
      LIMIT ${String(TOKEN_LIST_MAX_ROWS + MAX_ACTIVE_TOKENS_PER_AGENT)}`,
    [agentId],
  );
  return { tokens: rows.rows.map(toTokenView), activeCount: await countActiveTokens(db, agentId), maxActive: await tokenLimitOf(db, agentId) };
}

interface TokenChange {
  readonly item: TokenView;
  /** 실제로 바꿨는가(감사 대상). 이미 그 상태면 `false`. */
  readonly changed: boolean;
  /** 이름 바꾸기: 바꾸기 전 이름(옛 토큰은 `null`). 폐기는 `undefined`. */
  readonly previousLabel?: string | null;
}

/**
 * 한 개 폐기(E5). 다른 토큰은 그대로 산다. 이미 폐기된 토큰은 그대로 돌려준다(`changed: false` — 폐기 시각은 처음 것). 남의 토큰·없는
 * 토큰·모양이 아닌 id 는 404 `token_not_found`.
 */
export async function revokeAgentTokenOp(db: Queryable, agentId: AgentId, tokenId: string): Promise<TokenChange> {
  if (!UUID_PATTERN.test(tokenId)) throw tokenNotFound();
  const updated = await db.query('UPDATE agent_api_keys SET revoked_at = now() WHERE id = $2::uuid AND agent_id = $1 AND revoked_at IS NULL', [
    agentId,
    tokenId,
  ]);
  const item = await readAgentTokenOp(db, agentId, tokenId);
  if (item === null) throw tokenNotFound();
  return { item, changed: updated.rowCount === 1 };
}

/**
 * 이름 바꾸기(E6). **활성 토큰만** — 폐기·만료된 토큰은 409 `token_not_active`(끝난 토큰의 이름은 그때의 기록이다). 행을 잠그고 읽으므로
 * 같은 순간의 폐기와 엇갈리지 않는다. 같은 이름이면 `changed: false`. `previousLabel` = 바꾸기 전 이름(감사 상세).
 */
export async function renameAgentTokenOp(db: Queryable, agentId: AgentId, tokenId: string, label: string): Promise<TokenChange> {
  if (!UUID_PATTERN.test(tokenId)) throw tokenNotFound();
  const current = await db.query<{ label: string | null; active: boolean }>(
    `SELECT k.label, (${ACTIVE_SQL}) AS active FROM agent_api_keys k WHERE k.id = $2::uuid AND k.agent_id = $1 FOR UPDATE`,
    [agentId, tokenId],
  );
  const row = current.rows[0];
  if (row === undefined) throw tokenNotFound();
  if (!row.active) throw new AdminInputError('폐기·만료된 토큰은 이름을 바꿀 수 없다.', 'token_not_active', 409);
  const changed = row.label !== label;
  if (changed) await db.query('UPDATE agent_api_keys SET label = $3 WHERE id = $2::uuid AND agent_id = $1', [agentId, tokenId, label]);
  const item = await readAgentTokenOp(db, agentId, tokenId);
  if (item === null) throw tokenNotFound();
  return { item, changed, previousLabel: row.label };
}

/**
 * 한 개 교체(`supersedeAgentTokenOp`)가 옮길 옛 토큰의 값 — **활성 토큰만**. 행을 잠그고 읽으므로 같은 순간의 폐기·교체와 엇갈리지 않는다.
 * 없거나 남의 토큰 → 404 `token_not_found`, 폐기·만료 → 409 `token_not_active`. `renewedExpiresAt` = 옛 토큰과 **같은 수명**을 지금(DB
 * `now()` — 새 행의 `created_at` 과 같은 트랜잭션 시각)부터 센 만료(옛 토큰이 무기한이면 `null`).
 */
export async function lockActiveAgentToken(
  db: Queryable,
  agentId: AgentId,
  tokenId: string,
): Promise<{ readonly label: string | null; readonly capabilities: readonly AgentTokenCapability[]; readonly renewedExpiresAt: Date | null }> {
  if (!UUID_PATTERN.test(tokenId)) throw tokenNotFound();
  const current = await db.query<{
    label: string | null;
    capabilities: string[];
    created_at: Date;
    self_enrolled_agent: boolean;
    operator_reserved_agent: boolean;
    active: boolean;
    renewed_expires_at: Date | null;
  }>(
    `SELECT k.label, k.capabilities::text[] AS capabilities, k.created_at, (${ACTIVE_SQL}) AS active,
            EXISTS (SELECT 1 FROM agent_enrollments e WHERE e.child_agent_id = k.agent_id) AS self_enrolled_agent,
            ${OPERATOR_RESERVED_AGENT_SQL} AS operator_reserved_agent,
            CASE WHEN k.expires_at IS NULL THEN NULL ELSE now() + (k.expires_at - k.created_at) END AS renewed_expires_at
       FROM agent_api_keys k WHERE k.id = $2::uuid AND k.agent_id = $1 FOR UPDATE`,
    [agentId, tokenId],
  );
  const row = current.rows[0];
  if (row === undefined) throw tokenNotFound();
  if (!row.active) throw new AdminInputError('폐기·만료된 토큰은 교체할 수 없다.', 'token_not_active', 409);
  // 옮기는 권한은 **유효 권한**이다 — 기본값 이전 토큰을 교체해도 함의되던 `policy:request` 를 잃지 않는다(새 행의 열에 적힌다 — 옛 행은 그대로).
  const capabilities = effectiveAgentTokenCapabilities({
    capabilities: row.capabilities as AgentTokenCapability[],
    issuedAt: row.created_at,
    selfEnrolledAgent: row.self_enrolled_agent,
    operatorReservedAgent: row.operator_reserved_agent,
  });
  return { label: row.label, capabilities, renewedExpiresAt: row.renewed_expires_at };
}

/**
 * 감사 상세 한 행(`agent_api_key_events`) — 감사 행 id · 토큰 id · 이름 전·후(폐기는 이름 없음) · 한 개 교체면 새 토큰 id(`newKeyId` —
 * 그때 `change.item` 은 폐기한 옛 토큰이다, 202609270140). `audited` 의 `detail` 에서 부른다.
 */
export async function recordTokenEvent(db: Queryable, ownerActionId: string, change: TokenChange, newKeyId?: string): Promise<void> {
  const rename = change.previousLabel !== undefined;
  const values = [ownerActionId, change.item.id, rename ? change.previousLabel : null, rename ? change.item.label : null];
  // 폐기·이름 바꾸기는 새 칸을 적지 않는다 — 202609270140 이전 스키마에서도 그대로 돈다.
  if (newKeyId === undefined) {
    await db.query('INSERT INTO agent_api_key_events (owner_action_id, key_id, old_label, new_label) VALUES ($1::uuid, $2::uuid, $3, $4)', values);
    return;
  }
  await db.query(
    'INSERT INTO agent_api_key_events (owner_action_id, key_id, old_label, new_label, new_key_id) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)',
    [...values, newKeyId],
  );
}

/**
 * 조직당 토큰 변경 속도(L2) — 조직 advisory 잠금(트랜잭션 끝까지) 아래에서 지난 1분의 감사 행(`TOKEN_CHANGE_ACTIONS`)을 센다. 상한이면 429
 * `rate_limited`(트랜잭션이 되돌아가 감사 행도 남지 않는다). 번들 내려받기(`routes/integrity.ts`)와 같은 모양 — 감사 행이 원장이다.
 */
export async function limitTokenChanges(db: Queryable, organizationId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('admin_token_changes:' || $1::text, 0))`, [organizationId]);
  const recent = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM owner_actions
      WHERE organization_id = $1 AND action = ANY($2::text[]) AND created_at > now() - interval '1 minute'`,
    [organizationId, [...TOKEN_CHANGE_ACTIONS]],
  );
  if ((recent.rows[0]?.n ?? 0) >= TOKEN_CHANGES_PER_MINUTE) {
    throw new AdminInputError('이 조직의 토큰 변경이 너무 잦다 — 잠시 뒤 다시 시도하라.', 'rate_limited', 429);
  }
}
