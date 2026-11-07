/**
 * src/admin/ops/org-keys.ts — **조직 API 키**(`atk_org_*`) 발급·목록·폐기·교체·이름 · `/org-api/v1` 인증 · 키 행위자 감사
 * (확장성 P1 R-6, 계획 §3.7 · 창업자 결정 F-4).
 *
 * 가드:
 *   - **평문 1회** — 평문은 발급·교체 응답에만 있다. DB 에는 sha256(`token_hash`)만, 화면 모양(`OrgKeyView`)에는 해시가 없다(SELECT 도 하지 않는다).
 *   - **조직 범위** — 모든 조회·변경이 `organization_id` 와 키 `id` 를 **둘 다** 조건에 건다. 다른 조직의 키 = 없는 키(404 `org_key_not_found`).
 *   - **활성 상한** `min(MAX_ACTIVE_ORG_KEYS, 요금제 org_api_keys_max)`(ADR-0011) — 조직 advisory 잠금 아래에서 센다. DB 트리거
 *     (`org_api_keys_active_ceiling`, 천장 20)가 같은 잠금 키로 한 번 더 막는다. 교체는 활성 수를 늘리지 않으므로 강등 뒤에도 된다.
 *   - **권한** — 비지 않은 {agents:read, agents:create} 부분집합(DB CHECK 와 같은 집합). 생략 = 400(에이전트 토큰과 달리 기본값이 없다 —
 *     CI 키는 넓게 태어나지 않는다).
 *   - **인증**(`authenticateOrgKey`) — 모양 → 해시 조회 → 폐기·만료(DB `now()`) 순. 어떤 거부든 `null` 하나(호출자가 401 한 코드).
 *     `last_used_at` 은 분 단위로만 쓴다(`touchOrgKey`).
 *   - **감사** — 콘솔 관리 행위는 세션 행위자(`audited`), `/org-api` 행위는 **키 행위자**(`auditedByOrgKey` — `owner_actions.org_api_key_id`,
 *     202609250160). 둘 다 행위와 한 트랜잭션 → 투명성 로그 `owner.action` 잎(키 행위는 `c.api_key`, ADR-0008 추가 절).
 *   - **속도** — 조직당 분당 키 변경 `ORG_KEY_CHANGES_PER_MINUTE`(감사 행을 센다, 조직 잠금 아래) → 429.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../../db/client';
import { loadEntitlements } from '../../db/repositories/entitlements';
import {
  hashOrgApiKey,
  isOrgApiKeyCapability,
  isOrgApiKeyShape,
  issueOrgApiKey,
  ORG_API_KEY_CAPABILITIES,
  type OrgApiKeyCapability,
} from '../../identity/org-api-key';
import { AGENT_CREATE_TAKEN_ACTION } from './addresses';
import { AdminInputError, notFound, UUID_PATTERN } from './errors';
import { transactionPool } from './transaction';

/** 조직당 활성(폐기·만료 전) 조직 키의 **코드 천장** — 창업자 결정 F-4. DB 천장(20)보다 작다. 요금제(`org_api_keys_max`)가 이 안에서 조인다. */
export const MAX_ACTIVE_ORG_KEYS = 5;
/** 조직당 분당 키 변경(발급·폐기·교체·이름 — 감사된 것만). */
const ORG_KEY_CHANGES_PER_MINUTE = 10;
const ORG_KEY_CHANGE_ACTIONS = ['org_key.issue', 'org_key.revoke', 'org_key.rotate', 'org_key.rename'] as const;
/** `status=all` 이 보여 주는 끝난 키의 상한(활성 ≤ 5 는 별개로 늘 전부). */
const ORG_KEY_LIST_MAX_ROWS = 50;

/** 이 조직의 활성 조직 키 상한 = `min(MAX_ACTIVE_ORG_KEYS, 요금제)`(ADR-0011). 행이 없는 조직은 Free(fail-closed). */
async function orgKeyLimitOf(db: Queryable, organizationId: string): Promise<number> {
  return Math.min(MAX_ACTIVE_ORG_KEYS, (await loadEntitlements(db, organizationId, new Date())).orgApiKeysMax);
}

type OrgKeyStatus = 'active' | 'expired' | 'revoked';

/** 키 한 행의 화면 모양. **해시가 없다.** */
export interface OrgKeyView {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly capabilities: readonly OrgApiKeyCapability[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly status: OrgKeyStatus;
  /** 발급한 사람(콘솔 사용자). 사용자 행이 없으면 `null`. */
  readonly createdBy: { readonly email: string } | null;
  /** 교체로 태어난 키면 옛 키 id. */
  readonly previousKeyId: string | null;
}

interface OrgKeyListView {
  readonly keys: readonly OrgKeyView[];
  readonly activeCount: number;
  readonly maxActive: number;
}

interface OrgKeyRow {
  id: string;
  label: string;
  hint: string;
  capabilities: string[];
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  status: OrgKeyStatus;
  created_by_email: string | null;
  rotated_from_id: string | null;
}

const ACTIVE_SQL = `k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())`;

const KEY_SELECT_SQL = `SELECT k.id::text AS id, k.label, k.hint, k.capabilities, k.created_at, k.expires_at, k.last_used_at, k.revoked_at,
         CASE WHEN k.revoked_at IS NOT NULL THEN 'revoked'
              WHEN k.expires_at IS NOT NULL AND k.expires_at <= now() THEN 'expired'
              ELSE 'active' END AS status,
         u.email AS created_by_email, k.rotated_from_id::text AS rotated_from_id
    FROM org_api_keys k
    LEFT JOIN users u ON u.id = k.created_by_user_id`;

function toOrgKeyView(row: OrgKeyRow): OrgKeyView {
  return {
    id: row.id,
    label: row.label,
    hint: row.hint,
    capabilities: row.capabilities.filter(isOrgApiKeyCapability),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at === null ? null : row.last_used_at.toISOString(),
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    status: row.status,
    createdBy: row.created_by_email === null ? null : { email: row.created_by_email },
    previousKeyId: row.rotated_from_id,
  };
}

function keyNotFound(): AdminInputError {
  return notFound('조직 키가 없다.', 'org_key_not_found');
}

/** 본문의 `capabilities` — **필수**, 비지 않은 문자열 배열, 알려진 이름만(중복은 합친다). 아니면 400 `invalid_capability`. */
export function resolveOrgKeyCapabilities(value: unknown): readonly OrgApiKeyCapability[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) {
    throw new AdminInputError(`capabilities 는 비지 않은 배열이다(가능: ${ORG_API_KEY_CAPABILITIES.join(', ')}).`, 'invalid_capability');
  }
  const unknown = (value as string[]).find((item) => !isOrgApiKeyCapability(item));
  if (unknown !== undefined) {
    throw new AdminInputError(`알 수 없는 권한: ${unknown} (가능: ${ORG_API_KEY_CAPABILITIES.join(', ')})`, 'invalid_capability');
  }
  // 정규 순서로 — 같은 집합이면 같은 배열.
  return ORG_API_KEY_CAPABILITIES.filter((capability) => (value as string[]).includes(capability));
}

/** 조직의 키 발급 잠금(트랜잭션 끝까지) — DB 트리거 `org_api_keys_active_ceiling` 과 **같은 키**. */
async function lockOrgKeys(db: Queryable, organizationId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('org_api_keys_active:' || $1::text, 0))`, [organizationId]);
}

export async function countActiveOrgKeys(db: Queryable, organizationId: string): Promise<number> {
  const result = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM org_api_keys k WHERE k.organization_id = $1 AND ${ACTIVE_SQL}`, [
    organizationId,
  ]);
  return result.rows[0]?.n ?? 0;
}

async function readOrgKeyOp(db: Queryable, organizationId: string, keyId: string): Promise<OrgKeyView | null> {
  if (!UUID_PATTERN.test(keyId)) return null;
  const result = await db.query<OrgKeyRow>(`${KEY_SELECT_SQL} WHERE k.id = $2::uuid AND k.organization_id = $1`, [organizationId, keyId]);
  const row = result.rows[0];
  return row === undefined ? null : toOrgKeyView(row);
}

/** 목록 — `active` = 활성 전부, `all` = 활성 + 끝난 키 최신 `ORG_KEY_LIST_MAX_ROWS`. 활성이 먼저, 그 안에서 최신순. */
export async function listOrgKeysOp(db: Queryable, organizationId: string, scope: 'active' | 'all'): Promise<OrgKeyListView> {
  const rows = await db.query<OrgKeyRow>(
    `${KEY_SELECT_SQL}
      WHERE k.organization_id = $1 ${scope === 'active' ? `AND ${ACTIVE_SQL}` : ''}
      ORDER BY (${ACTIVE_SQL}) DESC, k.created_at DESC, k.id DESC
      LIMIT ${String(ORG_KEY_LIST_MAX_ROWS + MAX_ACTIVE_ORG_KEYS)}`,
    [organizationId],
  );
  return { keys: rows.rows.map(toOrgKeyView), activeCount: await countActiveOrgKeys(db, organizationId), maxActive: await orgKeyLimitOf(db, organizationId) };
}

interface IssuedOrgKey {
  /** **평문 1회.** */
  readonly key: string;
  readonly item: OrgKeyView;
}

async function insertOrgKey(
  db: Queryable,
  input: {
    readonly organizationId: string;
    readonly label: string;
    readonly capabilities: readonly OrgApiKeyCapability[];
    readonly createdByUserId: string;
    readonly expiresAt: Date | null;
    /** 주면 `expiresAt` 대신 DB `now()` + 이 초(교체 — 옛 키와 같은 수명). */
    readonly expiresInSeconds?: number;
    readonly previousKeyId: string | null;
  },
): Promise<IssuedOrgKey> {
  const issued = issueOrgApiKey();
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO org_api_keys (organization_id, label, hint, token_hash, capabilities, created_by_user_id, expires_at, rotated_from_id)
     VALUES ($1, $2, $3, $4, $5::text[], $6,
             CASE WHEN $9::int IS NULL THEN $7::timestamptz ELSE now() + make_interval(secs => $9::int) END, $8::uuid)
     RETURNING id::text AS id`,
    [
      input.organizationId,
      input.label,
      issued.hint,
      issued.keyHash,
      [...input.capabilities],
      input.createdByUserId,
      input.expiresInSeconds === undefined ? input.expiresAt : null,
      input.previousKeyId,
      input.expiresInSeconds ?? null,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error('org_api_keys INSERT 가 행을 돌려주지 않았다');
  const item = await readOrgKeyOp(db, input.organizationId, id);
  if (item === null) throw new Error('방금 넣은 조직 키 행을 읽지 못했다');
  return { key: issued.plaintext, item };
}

/** 발급 — 잠금 · 활성 상한(409 `org_key_limit`) · INSERT. 호출자가 트랜잭션(감사)을 연다. */
export async function issueOrgKeyOp(
  db: Queryable,
  input: {
    readonly organizationId: string;
    readonly label: string;
    readonly capabilities: readonly OrgApiKeyCapability[];
    readonly createdByUserId: string;
    readonly expiresAt: Date | null;
  },
): Promise<IssuedOrgKey> {
  await lockOrgKeys(db, input.organizationId);
  const limit = await orgKeyLimitOf(db, input.organizationId);
  if ((await countActiveOrgKeys(db, input.organizationId)) >= limit) {
    throw new AdminInputError(
      `조직당 활성 조직 키는 ${String(limit)}개까지다(요금제 한도) — 쓰지 않는 키를 폐기하라.`,
      'org_key_limit',
      409,
    );
  }
  return insertOrgKey(db, { ...input, previousKeyId: null });
}

interface OrgKeyChange {
  readonly item: OrgKeyView;
  readonly changed: boolean;
}

/** 폐기 — 멱등(이미 폐기면 `changed:false`, 폐기 시각은 처음 것). 남의 키·없는 키 = 404. */
export async function revokeOrgKeyOp(db: Queryable, organizationId: string, keyId: string): Promise<OrgKeyChange> {
  if (!UUID_PATTERN.test(keyId)) throw keyNotFound();
  const updated = await db.query('UPDATE org_api_keys SET revoked_at = now() WHERE id = $2::uuid AND organization_id = $1 AND revoked_at IS NULL', [
    organizationId,
    keyId,
  ]);
  const item = await readOrgKeyOp(db, organizationId, keyId);
  if (item === null) throw keyNotFound();
  return { item, changed: updated.rowCount === 1 };
}

/** 활성 키 한 행을 잠그고 읽는다 — 없으면 404, 끝났으면 409 `org_key_not_active`. */
async function lockActiveKey(
  db: Queryable,
  organizationId: string,
  keyId: string,
): Promise<{ label: string; capabilities: string[]; lifetime_seconds: number | null }> {
  if (!UUID_PATTERN.test(keyId)) throw keyNotFound();
  const current = await db.query<{ label: string; capabilities: string[]; active: boolean; lifetime_seconds: number | null }>(
    `SELECT k.label, k.capabilities, (${ACTIVE_SQL}) AS active,
            CASE WHEN k.expires_at IS NULL THEN NULL ELSE ceil(extract(epoch FROM k.expires_at - k.created_at))::int END AS lifetime_seconds
       FROM org_api_keys k WHERE k.id = $2::uuid AND k.organization_id = $1 FOR UPDATE`,
    [organizationId, keyId],
  );
  const row = current.rows[0];
  if (row === undefined) throw keyNotFound();
  if (!row.active) throw new AdminInputError('폐기·만료된 조직 키다.', 'org_key_not_active', 409);
  return row;
}

interface OrgKeyRotation extends IssuedOrgKey {
  readonly revoked: OrgKeyView;
}

/**
 * 교체 — 옛 키 폐기 + 같은 이름·권한의 새 키 발급이 **한 트랜잭션**(호출자). 새 키의 만료: `expiresAt` 을 주면 그 값, 아니면 옛 키와 **같은
 * 수명**(옛 키가 무기한이면 무기한). 새 키 `rotated_from_id` = 옛 키(UNIQUE — 한 키는 한 번만 교체된다). 폐기 뒤 INSERT 라 활성 수는 늘지 않는다.
 */
export async function supersedeOrgKeyOp(
  db: Queryable,
  input: { readonly organizationId: string; readonly keyId: string; readonly createdByUserId: string; readonly expiresAt: Date | null | undefined },
): Promise<OrgKeyRotation> {
  await lockOrgKeys(db, input.organizationId);
  const old = await lockActiveKey(db, input.organizationId, input.keyId);
  await db.query('UPDATE org_api_keys SET revoked_at = now() WHERE id = $2::uuid AND organization_id = $1 AND revoked_at IS NULL', [
    input.organizationId,
    input.keyId,
  ]);
  const capabilities = old.capabilities.filter(isOrgApiKeyCapability);
  const issued = await insertOrgKey(db, {
    organizationId: input.organizationId,
    label: old.label,
    capabilities,
    createdByUserId: input.createdByUserId,
    expiresAt: input.expiresAt ?? null,
    ...(input.expiresAt === undefined && old.lifetime_seconds !== null ? { expiresInSeconds: Math.max(1, Math.trunc(old.lifetime_seconds)) } : {}),
    previousKeyId: input.keyId,
  });
  const revoked = await readOrgKeyOp(db, input.organizationId, input.keyId);
  if (revoked === null) throw keyNotFound();
  return { ...issued, revoked };
}

/** 이름 바꾸기 — 활성 키만(끝난 키 → 409). 같은 이름이면 `changed:false`(감사 없음). */
export async function renameOrgKeyOp(db: Queryable, organizationId: string, keyId: string, label: string): Promise<OrgKeyChange> {
  const current = await lockActiveKey(db, organizationId, keyId);
  const changed = current.label !== label;
  if (changed) await db.query('UPDATE org_api_keys SET label = $3 WHERE id = $2::uuid AND organization_id = $1', [organizationId, keyId, label]);
  const item = await readOrgKeyOp(db, organizationId, keyId);
  if (item === null) throw keyNotFound();
  return { item, changed };
}

/** 조직당 키 변경 속도 — 조직 잠금 아래에서 지난 1분 감사 행을 센다. 상한이면 429 `rate_limited`. */
export async function limitOrgKeyChanges(db: Queryable, organizationId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('admin_org_key_changes:' || $1::text, 0))`, [organizationId]);
  const recent = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM owner_actions
      WHERE organization_id = $1 AND action = ANY($2::text[]) AND created_at > now() - interval '1 minute'`,
    [organizationId, [...ORG_KEY_CHANGE_ACTIONS]],
  );
  if ((recent.rows[0]?.n ?? 0) >= ORG_KEY_CHANGES_PER_MINUTE) {
    throw new AdminInputError('이 조직의 조직 키 변경이 너무 잦다 — 잠시 뒤 다시 시도하라.', 'rate_limited', 429);
  }
}

/** 조직당 분당 `/org-api` 에이전트 생성(키 행위자 `agent.create` 감사 행 — ADR-0010 L5 쓰기 상한). 요청 상한(분당 120)과 별개. */
export const ORG_API_AGENT_CREATES_PER_MINUTE = 10;

/**
 * `/org-api` 에이전트 생성 속도 — `limitOrgKeyChanges` 와 같은 원장 방식: 조직 잠금 아래에서 지난 1분의 **키 행위자** `agent.create`
 * · `agent.create.taken`(쓸 수 없는 주소로 한 시도 — 재발급 보안 리뷰 M2) 감사 행을 센다(콘솔 세션의 생성은 세지 않는다). 상한이면 429
 * `rate_limited`. 행위·감사와 같은 트랜잭션에서 부른다.
 */
export async function limitOrgApiAgentCreates(db: Queryable, organizationId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('org_api_agent_creates:' || $1::text, 0))`, [organizationId]);
  const recent = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM owner_actions
      WHERE organization_id = $1 AND action = ANY ($2::text[]) AND org_api_key_id IS NOT NULL AND created_at > now() - interval '1 minute'`,
    [organizationId, ['agent.create', AGENT_CREATE_TAKEN_ACTION]],
  );
  if ((recent.rows[0]?.n ?? 0) >= ORG_API_AGENT_CREATES_PER_MINUTE) {
    throw new AdminInputError('이 조직의 조직 키 에이전트 생성이 너무 잦다 — 잠시 뒤 다시 시도하라.', 'rate_limited', 429);
  }
}

// ---------------------------------------------------------------------------
// `/org-api/v1` 인증 · 키 행위자 감사
// ---------------------------------------------------------------------------

/** 인증된 조직 키. 평문·해시는 없다. */
export interface OrgKeyPrincipal {
  readonly id: string;
  readonly organizationId: string;
  readonly capabilities: readonly OrgApiKeyCapability[];
}

/**
 * `Bearer` 뒤의 값 → 활성 키. 모양 아님 · 모르는 해시 · 폐기 · 만료(DB `now()` — 만료 시각 **도달**이면 만료, 에이전트 토큰과 같은 경계)는
 * 모두 `null`(호출자가 401 한 코드). 조직 조건은 없다 — 키가 곧 조직이다.
 */
export async function authenticateOrgKey(db: Queryable, presented: string): Promise<OrgKeyPrincipal | null> {
  if (!isOrgApiKeyShape(presented)) return null;
  const result = await db.query<{ id: string; organization_id: string; capabilities: string[] }>(
    `SELECT k.id::text AS id, k.organization_id::text AS organization_id, k.capabilities
       FROM org_api_keys k WHERE k.token_hash = $1 AND ${ACTIVE_SQL}`,
    [hashOrgApiKey(presented)],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { id: row.id, organizationId: row.organization_id, capabilities: row.capabilities.filter(isOrgApiKeyCapability) };
}

/** `last_used_at` — 분 단위로만 쓴다(매 요청 쓰기를 1분 1회로). 앞으로만(DB 트리거). 실패는 인증을 막지 않는다(호출자가 삼킨다). */
export async function touchOrgKey(db: Queryable, keyId: string): Promise<void> {
  await db.query(
    `UPDATE org_api_keys SET last_used_at = date_trunc('minute', now())
      WHERE id = $1::uuid AND (last_used_at IS NULL OR last_used_at < date_trunc('minute', now()))`,
    [keyId],
  );
}

/**
 * **키 행위 + 감사 1행 = 한 트랜잭션** — `audited`(세션)와 같은 규율, 행위자만 `org_api_key_id`(202609250160 `owner_actions_one_actor`).
 * `target` 이 `undefined` 면 감사하지 않는다(아무것도 바꾸지 않은 호출).
 */
export async function auditedByOrgKey<T>(
  pool: Pool,
  principal: OrgKeyPrincipal,
  action: string | ((result: T) => string),
  run: (tx: Pool) => Promise<T>,
  target: (result: T) => string | null | undefined,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    const result = await run(transactionPool(client));
    const targetId = target(result);
    if (targetId !== undefined) {
      await client.query('INSERT INTO owner_actions (id, org_api_key_id, organization_id, action, target_id) VALUES ($1::uuid, $2::uuid, $3, $4, $5)', [
        randomUUID(),
        principal.id,
        principal.organizationId,
        typeof action === 'string' ? action : action(result),
        targetId,
      ]);
    }
    return result;
  });
}
