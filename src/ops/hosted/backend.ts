/**
 * src/ops/hosted/backend.ts — ops λ 의 DB 면. **`atmark_ops` 롤 하나**(도메인 표 쓰기 0 · 계약의 definer EXECUTE 만, `docs/contracts/ops-sql.md`).
 *
 * - 세션 뒤 모든 일은 `OpsBackend` 로만 한다. `OpsBackend` 는 `VerifiedSession` 이 있어야 만들 수 있고, `VerifiedSession` 은 **`ops_session_touch`
 *   가 행을 돌려줬을 때만** 이 모듈이 만든다(§3.7 — 모든 인증 요청의 첫 DB 문장이 touch 다).
 * - 읽기는 로컬 화면과 같은 조회(`console/reads.ts`)를 이 롤의 컬럼 GRANT 로 돈다.
 * - 쓰기는 definer 하나를 **한 트랜잭션**으로 부른다(티켓 · 코어 · 효과가 같은 커밋). 실패하면 ROLLBACK 한 뒤 **별도 트랜잭션**(autocommit)으로
 *   `ops_record_failure` 를 부른다(§3.2 실패 기록). 기록 실패는 삼킨다.
 * - SQLSTATE `AT4xx`/`AT503` 은 DETAIL 의 코드로 HTTP 오류가 된다(`OPS_SQLSTATE`). 표·함수가 없거나(`42P01`·`42883`) 권한이 없으면(`42501`)
 *   **503 `ops_unavailable`** — 배포 순서의 중간(§5)에서 λ 는 크래시하지 않는다.
 */

import type { Pool } from 'pg';

import { AdminInputError } from '../../admin/ops/errors';
import type { Queryable } from '../../db/client';
import { sanitizeDisplayText } from '../../notify/approval-notification-template';
import { log } from '../../observability/logger';
import { OPS_SQLSTATE, type OpsAction } from '../contract';
import type { OpsWaitlistAction } from '../metrics';
import { readWeeklyBoard } from '../console/board';
import { activateOutcomeOf, rejectOutcomeOf, type ActivateCoreRow, type RejectCoreRow, type ReviewOutcome } from '../review-shape';
import {
  confirmTarget,
  HOSTED_AUDIT,
  iso,
  readAudit,
  readCatalog,
  readDashboard,
  readOrganization,
  readOrganizations,
  readReviewQueue,
  readWaitlist,
  waitlistConfirmTarget,
  type ApiResult,
  type ConfirmTarget,
} from '../console/reads';

/** 호스팅 오류 — 상태 · 기계 코드 · 사람 문장(값 · 비밀 없음). */
export class OpsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpsError';
  }
}

export const INTERNAL_MESSAGE = '처리하지 못했습니다. 잠시 뒤 다시 시도하세요.';

const internalError = (): OpsError => new OpsError(500, 'internal_error', INTERNAL_MESSAGE);

export const unavailable = (): OpsError => new OpsError(503, 'ops_unavailable', '운영 콘솔을 지금 쓸 수 없습니다. 잠시 뒤 다시 시도하세요.');

/** definer 안에서 `zz_ops_require_ticket`(42501)이 쓰기를 거부했다 — 티켓 없는 도메인 쓰기. */
const ticketViolation = (): OpsError => new OpsError(500, 'ticket_violation', INTERNAL_MESSAGE);

const DETAIL_CODE = /^[a-z_]{1,40}$/;
/** 배포 순서의 중간 — 표·함수 없음 · 권한 없음 · 롤 접속 불가. */
const UNAVAILABLE_SQLSTATES = new Set(['42P01', '42883', '42501', '28000', '28P01', '3D000', '57P01', '57P03', '53300']);

const DEFAULT_CODES: Readonly<Record<keyof typeof OPS_SQLSTATE, string>> = {
  AT401: 'session_invalid',
  AT403: 'forbidden',
  AT404: 'not_found',
  AT409: 'invalid_transition',
  AT429: 'rate_limited',
  AT503: 'ops_disabled',
};

/** DB 예외 → `OpsError`. 이미 `OpsError` 면 그대로. 모르는 예외는 500 `internal_error`(메시지는 싣지 않는다). */
export function mapDbError(error: unknown): OpsError {
  if (error instanceof OpsError) return error;
  const code = (error as { code?: unknown }).code;
  const detail = (error as { detail?: unknown }).detail;
  if (typeof code === 'string') {
    if (code in OPS_SQLSTATE) {
      const key = code as keyof typeof OPS_SQLSTATE;
      const reason = typeof detail === 'string' && DETAIL_CODE.test(detail.trim()) ? detail.trim() : DEFAULT_CODES[key];
      return new OpsError(OPS_SQLSTATE[key], reason, reason);
    }
    if (UNAVAILABLE_SQLSTATES.has(code)) return unavailable();
    if (code === '22023' || code === '22P02') return new OpsError(400, 'invalid_input', '입력 형식이 맞지 않습니다.');
  }
  // 풀 접속 실패(네트워크 · 시간 초과)도 쓸 수 없는 상태로 본다.
  if (error instanceof Error && /ECONNREFUSED|ETIMEDOUT|timeout exceeded when trying to connect|Connection terminated/i.test(error.message)) return unavailable();
  return internalError();
}

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw mapDbError(error);
  }
}

// ---------------------------------------------------------------------------
// 세션 전 — 코드 요청 · 검증
// ---------------------------------------------------------------------------

export interface CodeRequest {
  readonly email: string;
  readonly binding: string;
  readonly clientKey: string;
  readonly lang: 'ko' | 'en';
}

/** 코드 요청 — 받아들였는지는 알려 주지 않는다(열거 방지 · DB 가 조용한 상한을 판정). */
export async function requestCode(db: Queryable, input: CodeRequest): Promise<void> {
  await run(() => db.query('SELECT ops_request_code($1, $2, $3, $4)', [input.email, input.binding, input.clientKey, input.lang]));
}

export type LoginOutcome = 'session' | 'requested' | 'pending' | 'cooldown' | 'pending_cap' | 'already_operator' | 'invalid';
const LOGIN_OUTCOMES: readonly string[] = ['session', 'requested', 'pending', 'cooldown', 'pending_cap', 'already_operator', 'invalid'];

export interface LoginVerify {
  readonly binding: string;
  readonly clientKey: string;
  readonly code: string;
  readonly sessionHash: string;
  readonly uaHash: string;
}

export async function loginVerify(db: Queryable, input: LoginVerify): Promise<LoginOutcome> {
  const result = await run(() =>
    db.query<{ outcome: string; operator_id: string | null; session_id: string | null }>(
      'SELECT outcome, operator_id, session_id FROM ops_login_verify($1, $2, $3, $4, $5)',
      [input.binding, input.clientKey, input.code, input.sessionHash, input.uaHash],
    ),
  );
  const row = result.rows[0];
  const outcome = row?.outcome ?? 'invalid';
  if (!LOGIN_OUTCOMES.includes(outcome)) return 'invalid';
  if (outcome === 'session' && (row?.session_id === null || row?.session_id === undefined)) return 'invalid';
  return outcome as LoginOutcome;
}

/** 로그아웃 — 콘솔이 닫혀 있어도 된다(`ops_session_revoke` 는 `console_enabled` 를 보지 않는다). */
export async function revokeSession(db: Queryable, hash: string, all: boolean): Promise<number> {
  const result = await run(() => db.query<{ n: number }>('SELECT ops_session_revoke($1, $2) AS n', [hash, all]));
  return Number(result.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// 세션
// ---------------------------------------------------------------------------

declare const verified: unique symbol;

/** `ops_session_touch` 가 살아 있다고 답한 세션. 이 모듈 밖에서는 만들 수 없다. */
export interface VerifiedSession {
  readonly [verified]: true;
  readonly operatorId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly hash: string;
  readonly clientKey: string;
}

export interface TouchInput {
  readonly sessionHash: string;
  readonly uaHash: string;
  readonly clientKey: string;
}

/** 첫 DB 문장. 0행 = 세션 무효(없음 · 만료 · 유휴 · 폐기 · 운영자 비활성 · UA 변경 — DB 가 판정). */
export async function touchSession(db: Queryable, input: TouchInput): Promise<VerifiedSession | null> {
  const result = await run(() =>
    db.query<{ operator_id: string; session_id: string; email: string; expires_at: Date }>(
      'SELECT operator_id, session_id, email, expires_at FROM ops_session_touch($1, $2, $3)',
      [input.sessionHash, input.uaHash, input.clientKey],
    ),
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    operatorId: row.operator_id,
    sessionId: row.session_id,
    email: row.email,
    expiresAt: new Date(row.expires_at),
    hash: input.sessionHash,
    clientKey: input.clientKey,
  } as VerifiedSession;
}

export interface OperatorRow {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly origin: string;
  readonly requestedAt: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string | null;
}

export const OPERATOR_LIST_LIMIT = 200;

/** 대기자 명단 쓰기(202609301520) — 실패 기록(`ops_record_failure`)의 행위 칸에 그대로 적힌다(1520 이 `ops_actions.action` 허용 목록에 더했다). */
export type WaitlistWriteAction = OpsWaitlistAction;

export interface WriteTarget {
  readonly org?: string;
  readonly agent?: string;
}

/**
 * 세션 뒤 DB 면. 읽기(로컬과 같은 조회) · 쓰기(definer, 한 트랜잭션 + 실패 기록) · step-up.
 * `pool` 은 `atmark_ops` 풀(λ 당 1 연결, `OPS_POOL_MAX`).
 */
export class OpsBackend {
  private constructor(
    private readonly pool: Pool,
    readonly session: VerifiedSession,
  ) {}

  static of(pool: Pool, session: VerifiedSession): OpsBackend {
    return new OpsBackend(pool, session);
  }

  // ---- 읽기 ----

  dashboard(now: Date): Promise<ApiResult> {
    return run(() => readDashboard(this.pool, now));
  }

  /** 주간 운영판(202610010900 — 정의 함수 `ops_weekly_board` + 대기자 명단 칸 GRANT). 읽기뿐. */
  board(now: Date): Promise<ApiResult> {
    return run(() => readWeeklyBoard(this.pool, now));
  }

  reviewQueue(): Promise<ApiResult> {
    return run(() => readReviewQueue(this.pool));
  }

  organizations(query: URLSearchParams, now: Date): Promise<ApiResult> {
    return run(() => readOrganizations(this.pool, query, now));
  }

  organization(id: string, now: Date): Promise<ApiResult> {
    return run(() => readOrganization(this.pool, id, now, HOSTED_AUDIT));
  }

  audit(query: URLSearchParams): Promise<ApiResult> {
    return run(() => readAudit(this.pool, query, HOSTED_AUDIT));
  }

  catalog(): ApiResult {
    return readCatalog();
  }

  confirmOrganization(id: string): Promise<ConfirmTarget> {
    return run(() => confirmTarget(this.pool, id));
  }

  /** 대기자 명단 읽기 — 거르개 모양 오류(`AdminInputError`, 400)는 그대로 · DB 오류만 매핑. */
  async waitlist(query: URLSearchParams, now: Date): Promise<ApiResult> {
    try {
      return await readWaitlist(this.pool, query, now);
    } catch (error) {
      if (error instanceof AdminInputError) throw error;
      throw mapDbError(error);
    }
  }

  /** 대기 항목의 주소(확인 입력 대조용). 없으면 404 · 가입 끝남 409(`AdminInputError` 그대로). */
  async waitlistEntryEmail(id: string): Promise<string> {
    try {
      return (await waitlistConfirmTarget(this.pool, id)).email;
    } catch (error) {
      if (error instanceof AdminInputError) throw error;
      throw mapDbError(error);
    }
  }

  async operators(): Promise<{ items: OperatorRow[]; pending: number; limit: number }> {
    const rows = await run(() =>
      this.pool.query<{ id: string; email: string; status: string; origin: string; requested_at: Date | null; decided_at: Date | null; created_at: Date | null }>(
        `SELECT id, email, status, origin, requested_at, decided_at, created_at
           FROM ops_operators
          ORDER BY (status = 'requested') DESC, (status = 'active') DESC, created_at DESC, id
          LIMIT ${String(OPERATOR_LIST_LIMIT)}`,
      ),
    );
    const items = rows.rows.map((row) => ({
      id: row.id,
      email: sanitizeDisplayText(row.email, 254),
      status: row.status,
      origin: row.origin,
      requestedAt: iso(row.requested_at),
      decidedAt: iso(row.decided_at),
      createdAt: iso(row.created_at),
    }));
    return { items, pending: items.filter((item) => item.status === 'requested').length, limit: OPERATOR_LIST_LIMIT };
  }

  async pendingOperators(): Promise<number> {
    const rows = await run(() => this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ops_operators WHERE status = 'requested'"));
    return Number(rows.rows[0]?.n ?? 0);
  }

  async operator(id: string): Promise<{ id: string; email: string; status: string; origin: string } | null> {
    const rows = await run(() =>
      this.pool.query<{ id: string; email: string; status: string; origin: string }>('SELECT id, email, status, origin FROM ops_operators WHERE id = $1', [id]),
    );
    return rows.rows[0] ?? null;
  }

  // ---- step-up ----

  async requestStepUp(action: OpsAction, org: string | null, operator: string | null): Promise<string> {
    const rows = await run(() =>
      this.pool.query<{ ref: string }>('SELECT ops_request_stepup($1, $2, $3, $4, $5) AS ref', [this.session.hash, this.session.clientKey, action, org, operator]),
    );
    return String(rows.rows[0]?.ref ?? '');
  }

  async verifyStepUp(code: string): Promise<{ outcome: 'ok' | 'invalid'; action: string | null; targetRef: string | null }> {
    const rows = await run(() =>
      this.pool.query<{ outcome: string; action: string | null; target_ref: string | null }>(
        'SELECT outcome, action, target_ref FROM ops_stepup_verify($1, $2, $3)',
        [this.session.hash, this.session.clientKey, code],
      ),
    );
    const row = rows.rows[0];
    return row?.outcome === 'ok' ? { outcome: 'ok', action: row.action, targetRef: row.target_ref } : { outcome: 'invalid', action: null, targetRef: null };
  }

  // ---- 쓰기 ----

  async activate(org: string): Promise<ReviewOutcome> {
    const rows = await this.write<ActivateCoreRow>('org.activate', { org }, 'SELECT * FROM ops_org_activate($1, $2)', [this.session.hash, org]);
    const row = rows[0];
    if (row === undefined) throw internalError();
    return activateOutcomeOf(row);
  }

  async reject(org: string): Promise<ReviewOutcome> {
    const rows = await this.write<RejectCoreRow>('org.reject', { org }, 'SELECT * FROM ops_org_reject($1, $2)', [this.session.hash, org]);
    const row = rows[0];
    if (row === undefined) throw internalError();
    return rejectOutcomeOf(row);
  }

  // ---- 대기자 명단(202609301520) — 정의 함수 셋(콘솔 열림 → 세션 → 소유자 코어, 행위자 `ops:<운영자>`) ----

  async waitlistInvite(entry: string): Promise<{ entryId: string; fromStatus: string; inviteExpiresAt: string }> {
    const rows = await this.write<{ entry_id: string; from_status: string; invite_expires_at: Date }>(
      'waitlist.invite',
      {},
      'SELECT entry_id, from_status, invite_expires_at FROM ops_waitlist_invite($1, $2)',
      [this.session.hash, entry],
    );
    const row = rows[0];
    if (row === undefined) throw internalError();
    return { entryId: row.entry_id, fromStatus: row.from_status, inviteExpiresAt: new Date(row.invite_expires_at).toISOString() };
  }

  async waitlistInviteOldest(n: number): Promise<number> {
    const rows = await this.write<{ entry_id: string }>('waitlist.invite_oldest', {}, 'SELECT entry_id FROM ops_waitlist_invite_oldest($1, $2)', [
      this.session.hash,
      n,
    ]);
    return rows.length;
  }

  async waitlistRemove(entry: string): Promise<{ entryId: string; fromStatus: string }> {
    const rows = await this.write<{ from_status: string }>('waitlist.remove', {}, 'SELECT ops_waitlist_remove($1, $2) AS from_status', [this.session.hash, entry]);
    return { entryId: entry, fromStatus: String(rows[0]?.from_status ?? '') };
  }

  async decideOperator(id: string, decision: 'approve' | 'deny'): Promise<string> {
    const rows = await this.write<{ result: string }>(decision === 'approve' ? 'operator.approve' : 'operator.deny', {}, 'SELECT ops_decide_request($1, $2, $3) AS result', [
      this.session.hash,
      id,
      decision,
    ]);
    return String(rows[0]?.result ?? '');
  }

  async revokeOperator(id: string): Promise<string> {
    const rows = await this.write<{ result: string }>('operator.revoke', {}, 'SELECT ops_revoke_operator($1, $2) AS result', [this.session.hash, id]);
    return String(rows[0]?.result ?? '');
  }

  /**
   * definer 한 번 = 한 트랜잭션. 실패하면 ROLLBACK → 별도 트랜잭션으로 실패 기록 → 매핑한 오류를 던진다.
   * **`zz_ops_require_ticket` 의 거부(42501 + DETAIL `ticket_violation`)는 배포 중간이 아니다** — 세션을 지난 뒤 도메인 쓰기가 티켓 없이(또는 다른
   * 조직의 티켓으로) 거부됐다는 뜻이라 `ticket_violation`(500)으로 따로 가르고 error 로 남긴다(심층 방어가 걸렸다 = 코드 결함 신호). DETAIL 이 없는
   * 42501(권한이 빠진 배포)은 `mapDbError` 대로 503 `ops_unavailable` 이다. ROLLBACK 이 실패한 연결은 풀에 돌려주지 않는다.
   */
  private async write<R extends object>(action: OpsAction | WaitlistWriteAction, target: WriteTarget, sql: string, params: unknown[]): Promise<R[]> {
    let client;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw mapDbError(error);
    }
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result.rows as R[];
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        broken = rollbackError instanceof Error ? rollbackError : new Error('rollback failed');
      }
      // `zz_ops_require_ticket` 의 거부만 — DETAIL 'ticket_violation' 이 붙은 42501. 권한이 빠진 배포(맨 42501)는 그대로 503 ops_unavailable.
      const pgError = error as { code?: unknown; detail?: unknown };
      const failure = pgError.code === '42501' && pgError.detail === 'ticket_violation' ? ticketViolation() : mapDbError(error);
      if (failure.code === 'ticket_violation') log('error', 'ops.ticket_violation', { route_id: 'ops', error_code: failure.code, http_status: failure.status });
      if (failure.code !== 'ops_unavailable' && broken === undefined) {
        await client
          .query('SELECT ops_record_failure($1, $2, $3, $4, $5, $6)', [
            this.session.hash,
            this.session.clientKey,
            action,
            target.org ?? null,
            target.agent ?? null,
            failure.code,
          ])
          .catch(() => undefined);
      }
      throw failure;
    } finally {
      client.release(broken);
    }
  }
}
