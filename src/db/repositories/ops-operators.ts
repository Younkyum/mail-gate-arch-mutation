/**
 * src/db/repositories/ops-operators.ts — 호스팅 운영자 콘솔의 **소유자 롤 연산**(부트스트랩 · break-glass). CLI `pnpm admin:ops-operator` 가 부른다
 * (`scripts/admin/ops-operator.ts`, 소유자 롤 풀 — `.omc/plans/ops-console.md` §3.3). 호스팅 λ(`atmark_ops`)는 이 파일을 부르지 않는다 — 그 롤은
 * 표 쓰기 권한이 0 이고, 운영자 결정은 정의 함수(`ops_decide_request` · `ops_revoke_operator`)로만 한다.
 *
 * 소유자 롤이라 가드가 넓게 허용한다(H1 — CLI 출신 행은 소유자 세션만 바꾼다 · 상태 기계는 소유자에게 열려 있다). 그래서 여기 연산은 **좁게** 쓴다:
 *   - `--add`: 없으면 active · origin cli 로 만든다. 있으면 active 로 만들고 origin 을 cli 로 넘겨받는다(CLI 가 책임진다 — 콘솔에서 폐기되지 않는다).
 *   - `--revoke`: active → revoked · 그 운영자의 세션 폐기 · 도전 무효(콘솔 폐기와 같은 효과). CLI 출신도 된다(break-glass). 마지막 운영자도 된다.
 *   - `--reinstate`: revoked·denied·expired → active.
 *   - `--unlock <주소>`: 주소 실패 잠금 해제(오늘 행의 수도 0 으로 — 곧바로 다시 잠기지 않게).
 *   - 설정: `console_enabled`(소프트 킬 스위치) · `hard_locked`(하드 킬 스위치 영속 — migrate `ops-role-lock` 전에).
 * 사건 원장의 행위자는 트랜잭션 설정 `atmark.ops_actor` = `cli:<명령>:<운영자>`.
 */

import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../client';
import type { OpsOperatorOrigin, OpsOperatorStatus } from '../schema';

/** 운영자 주소 정규화 — DB CHECK(`lower(btrim())` · 모양)와 같다. 모양이 아니면 `null`. */
export function normalizeOperatorEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

export interface OpsOperatorListRow {
  readonly id: string;
  readonly email: string;
  readonly status: OpsOperatorStatus;
  readonly origin: OpsOperatorOrigin;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly activeSessions: number;
}

export interface OpsSettingsView {
  readonly consoleEnabled: boolean;
  readonly hardLocked: boolean;
  readonly updatedAt: Date;
}

export type OpsOperatorChange =
  | { readonly kind: 'created' | 'changed'; readonly id: string; readonly from: OpsOperatorStatus | null; readonly to: OpsOperatorStatus }
  | { readonly kind: 'unchanged'; readonly id: string; readonly status: OpsOperatorStatus }
  | { readonly kind: 'not_found' };

async function setActor(db: Queryable, actor: string): Promise<void> {
  await db.query(`SELECT set_config('atmark.ops_actor', $1, true)`, [`cli:${actor}`.slice(0, 200)]);
}

export async function listOperatorsOp(db: Queryable): Promise<OpsOperatorListRow[]> {
  const rows = await db.query<{
    id: string;
    email: string;
    status: OpsOperatorStatus;
    origin: OpsOperatorOrigin;
    created_at: Date;
    decided_at: Date | null;
    sessions: number;
  }>(
    `SELECT o.id, o.email, o.status, o.origin, o.created_at, o.decided_at,
            (SELECT count(*)::int FROM ops_sessions s
              WHERE s.operator_id = o.id AND s.revoked_at IS NULL AND s.expires_at > now() AND s.last_seen_at > now() - interval '30 minutes') AS sessions
       FROM ops_operators o
      ORDER BY o.created_at, o.id`,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    email: row.email,
    status: row.status,
    origin: row.origin,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    activeSessions: row.sessions,
  }));
}

/** `--add` — active · origin cli. 이미 active 면 그대로(origin 만 cli 로 넘겨받는다). */
export async function addOperatorOp(pool: Pool, email: string, actor: string): Promise<OpsOperatorChange> {
  return withTransaction(pool, async (client) => {
    await setActor(client, actor);
    const current = await client.query<{ id: string; status: OpsOperatorStatus; origin: OpsOperatorOrigin }>(
      'SELECT id, status, origin FROM ops_operators WHERE email = $1 FOR UPDATE',
      [email],
    );
    const row = current.rows[0];
    if (row === undefined) {
      const created = await client.query<{ id: string }>(
        `INSERT INTO ops_operators (email, status, origin, decided_at) VALUES ($1, 'active', 'cli', now()) RETURNING id`,
        [email],
      );
      return { kind: 'created', id: created.rows[0]?.id ?? '', from: null, to: 'active' };
    }
    if (row.status === 'active' && row.origin === 'cli') return { kind: 'unchanged', id: row.id, status: row.status };
    await client.query(
      `UPDATE ops_operators SET status = 'active', origin = 'cli', decided_at = now(), decided_by = NULL WHERE id = $1`,
      [row.id],
    );
    return { kind: 'changed', id: row.id, from: row.status, to: 'active' };
  });
}

/** `--revoke` — active → revoked · 세션 폐기 · 도전 무효(같은 트랜잭션). */
export async function revokeOperatorOp(pool: Pool, email: string, actor: string): Promise<OpsOperatorChange> {
  return withTransaction(pool, async (client) => {
    await setActor(client, actor);
    const current = await client.query<{ id: string; status: OpsOperatorStatus }>(
      'SELECT id, status FROM ops_operators WHERE email = $1 FOR UPDATE',
      [email],
    );
    const row = current.rows[0];
    if (row === undefined) return { kind: 'not_found' };
    if (row.status !== 'active') return { kind: 'unchanged', id: row.id, status: row.status };
    await client.query(`UPDATE ops_operators SET status = 'revoked', decided_at = now(), decided_by = NULL WHERE id = $1`, [row.id]);
    await client.query(
      `UPDATE ops_sessions SET revoked_at = now(), revoke_reason = 'operator_revoked' WHERE operator_id = $1 AND revoked_at IS NULL`,
      [row.id],
    );
    await client.query(
      `UPDATE ops_login_challenges SET invalidated_at = now()
        WHERE (operator_id = $1 OR email = $2) AND used_at IS NULL AND invalidated_at IS NULL`,
      [row.id, email],
    );
    return { kind: 'changed', id: row.id, from: row.status, to: 'revoked' };
  });
}

/** `--reinstate` — 끝난 행(revoked·denied·expired) → active. requested 는 콘솔 승인 또는 `--add` 로. */
export async function reinstateOperatorOp(pool: Pool, email: string, actor: string): Promise<OpsOperatorChange> {
  return withTransaction(pool, async (client) => {
    await setActor(client, actor);
    const current = await client.query<{ id: string; status: OpsOperatorStatus }>(
      'SELECT id, status FROM ops_operators WHERE email = $1 FOR UPDATE',
      [email],
    );
    const row = current.rows[0];
    if (row === undefined) return { kind: 'not_found' };
    if (row.status === 'active' || row.status === 'requested') return { kind: 'unchanged', id: row.id, status: row.status };
    await client.query(`UPDATE ops_operators SET status = 'active', decided_at = now(), decided_by = NULL WHERE id = $1`, [row.id]);
    return { kind: 'changed', id: row.id, from: row.status, to: 'active' };
  });
}

/** `--unlock <주소>` — 그 주소의 잠금을 풀고 실패 수를 0 으로. 푼 행 수(0 = 잠겨 있지 않았다). */
export async function unlockAddressOp(db: Queryable, email: string): Promise<number> {
  const result = await db.query(
    `UPDATE ops_address_failures SET locked_until = NULL, failures = 0
      WHERE address_hash = ops_address_hash($1) AND (locked_until IS NOT NULL OR failures > 0)`,
    [email],
  );
  return result.rowCount ?? 0;
}

/** 주소가 지금 잠겨 있는가(`--unlock` 전후 확인용). */
export async function addressLockedUntilOp(db: Queryable, email: string): Promise<Date | null> {
  const result = await db.query<{ locked_until: Date | null }>(
    `SELECT max(locked_until) AS locked_until FROM ops_address_failures WHERE address_hash = ops_address_hash($1) AND locked_until > now()`,
    [email],
  );
  return result.rows[0]?.locked_until ?? null;
}

export async function readOpsSettingsOp(db: Queryable): Promise<OpsSettingsView> {
  const result = await db.query<{ console_enabled: boolean; hard_locked: boolean; updated_at: Date }>(
    'SELECT console_enabled, hard_locked, updated_at FROM ops_settings WHERE id',
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('ops_settings 행이 없다 — 마이그레이션 202609290500 을 먼저 적용한다.');
  return { consoleEnabled: row.console_enabled, hardLocked: row.hard_locked, updatedAt: row.updated_at };
}

/** 소프트 킬 스위치. 바뀌었으면 `true`. */
export async function setConsoleEnabledOp(db: Queryable, enabled: boolean): Promise<boolean> {
  const result = await db.query('UPDATE ops_settings SET console_enabled = $1 WHERE id AND console_enabled <> $1', [enabled]);
  return (result.rowCount ?? 0) > 0;
}

/** 하드 킬 스위치의 영속 칸(migrate `ops-role-lock` 전에 참으로 · `ops-role-unlock` 뒤에 거짓으로). 바뀌었으면 `true`. */
export async function setHardLockedOp(db: Queryable, locked: boolean): Promise<boolean> {
  const result = await db.query('UPDATE ops_settings SET hard_locked = $1 WHERE id AND hard_locked <> $1', [locked]);
  return (result.rowCount ?? 0) > 0;
}

/** `atmark_ops` 가 지금 로그인할 수 있는가(`--hard-lock-status`). 롤이 없으면 `null`. */
export async function opsRoleCanLoginOp(db: Queryable): Promise<boolean | null> {
  const result = await db.query<{ rolcanlogin: boolean }>(`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'atmark_ops'`);
  return result.rows[0]?.rolcanlogin ?? null;
}
