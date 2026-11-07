/**
 * src/ops/core/review.ts — 셀프 가입 조직의 **검토 상태 전이**(활성화 · 거절)와 검토 대기열. `scripts/admin/org-review.ts` 에서 옮겼다(P0,
 * `.omc/plans/ops-console.md` §3.9). CLI(`pnpm admin:org-review`)와 로컬 운영자 화면이 **이 함수 하나**를 부른다. 동작은 그대로다.
 *
 * **소유자 롤이다.** `organizations.review_status`·`reviewed_at` 은 테이블 소유자만 바꿀 수 있다(트리거 `organizations_review_guard`, 202609240800).
 * 거절은 그 조직 에이전트를 운영자 정지로 걸고 살아 있는 API 토큰을 전부 폐기한다(같은 트랜잭션, 되돌릴 수 없다). 활성화는 같은 트랜잭션에서
 * 베타를 자동 부여한다. 자세한 규칙은 CLI 머리말(`scripts/admin/org-review.ts`)에 있다.
 *
 * **P1(`.omc/plans/ops-console.md` §3.2 M2)부터 전이는 SQL 코어다** — `ops_org_activate_core(p_org, p_actor)` · `ops_org_reject_core(p_org)`(소유자만
 * EXECUTE). 이 파일은 얇은 래퍼(반환 매핑 · SQLSTATE → `AdminInputError`)다. 베타 스위치는 TS `BETA_ON_ACTIVATION` 과 SQL
 * `ops_activation_beta_enabled()` 한 쌍이다(단위 테스트 · migrate status 가 둘을 묶는다 — 끄려면 커밋 + 마이그레이션).
 * 0510 이 없으면(42883) "마이그레이션 먼저" 로 크게 실패한다(M1).
 */

import type { Pool } from 'pg';

import { ORGANIZATION_ID_PATTERN } from '../../admin/ops/agents';
import { AdminInputError, type AdminErrorStatus } from '../../admin/ops/errors';
import type { Queryable } from '../../db/client';
import { activateOutcomeOf, activationGrantOf, rejectOutcomeOf, type ActivateCoreRow, type RejectCoreRow, type ReviewOutcome } from '../review-shape';

/** 모양은 `src/ops/review-shape.ts` 하나(호스팅 백엔드와 같이 쓴다) — 옛 import 경로를 위해 다시 내보낸다. */
export { activationGrantOf, type ReviewOutcome };

export interface PendingRow {
  id: string;
  name: string;
  owner_email: string | null;
  created_at: Date;
  agents: number;
}

/** 검토 대기(pending_review) 조직 — 가입 순. CLI `--list` 와 운영자 웹 화면의 검토 대기열이 같은 조회다. 이름·주소는 호출자가 정화해 그린다. */
export async function listPendingReviewOp(db: Queryable): Promise<PendingRow[]> {
  const pending = await db.query<PendingRow>(
    `SELECT o.id, o.name, o.owner_email, o.created_at, count(a.id)::int AS agents
       FROM organizations o
       LEFT JOIN agents a ON a.organization_id = o.id
      WHERE o.review_status = 'pending_review'
      GROUP BY o.id
      ORDER BY o.created_at, o.id`,
  );
  return pending.rows;
}

/** 0510 이 없다 — 새 CLI 는 migrate 뒤에만 쓴다(M1). 입력 오류가 아니다(exit 1) — 조용히 오동작하지 않고 크게 실패한다. */
export class OpsCoreNotMigratedError extends Error {
  constructor() {
    super(
      '마이그레이션 먼저 — 런북 deploy §ops: 검토 전이의 SQL 코어(202609290510 ops_org_activate_core · ops_org_reject_core)가 이 DB 에 없다. ' +
        'migrate 를 먼저 적용하거나, 그 전이라면 ops-pre-p1 태그의 CLI 를 쓴다.',
    );
    this.name = 'OpsCoreNotMigratedError';
  }
}

const OPS_SQLSTATE_STATUS: Readonly<Record<string, AdminErrorStatus>> = { AT401: 401, AT403: 403, AT404: 404, AT409: 409, AT429: 429 };

/**
 * SQL 코어·정의 함수의 거부(SQLSTATE `AT4xx` · DETAIL = 코드, 계약 §3.2 표)를 기존 `AdminInputError(code, status)` 로 되돌린다. `42883`(함수 없음)은
 * `OpsCoreNotMigratedError`. 그 밖은 그대로 던진다. `organization_not_found` 는 옛 CLI 와 문구·상태(400)까지 같다.
 */
export function opsSqlError(error: unknown, org: string): unknown {
  const pgError = error as { code?: unknown; detail?: unknown } | null;
  if (pgError?.code === '42883') return new OpsCoreNotMigratedError();
  const status = typeof pgError?.code === 'string' ? OPS_SQLSTATE_STATUS[pgError.code] : undefined;
  if (status === undefined) return error;
  const code = typeof pgError?.detail === 'string' && /^[a-z_]{1,40}$/.test(pgError.detail) ? pgError.detail : 'invalid_request';
  // 옛 CLI(ops-pre-p1)와 같게 — 없는 조직은 400 · 같은 문구(로컬 화면은 확인 단계에서 이미 404 를 준다).
  if (code === 'organization_not_found') return new AdminInputError(`조직이 없다: ${org}`, code);
  return new AdminInputError(`거부: ${code}`, code, status);
}

/**
 * 검토 상태 전이 한 번 = 한 문장(= 한 트랜잭션) — **소유자 전용 SQL 코어**(`ops_org_activate_core` · `ops_org_reject_core`, 202609290510)를 부른다.
 * 호스팅 콘솔(`ops_org_activate` · `ops_org_reject` → 티켓 → 같은 코어)과 **전이 구현이 하나**다(N7). CLI(`--activate`/`--reject`)와 로컬 운영자 화면이
 * 이 함수를 부른다. 확인(운영 `yes` · 웹의 이름 입력)은 호출자가 먼저 한다. `actor` 는 베타 자동 부여의 감사 행위자(`admin:<명령>:<운영자>`).
 * 반환 모양은 옛 TS 구현(ops-pre-p1)과 같다 — 차분 테스트 `test/integration/ops/review-differential.test.ts`.
 */
export async function reviewOrganizationOp(pool: Pool, org: string, target: 'active' | 'rejected', actor: string): Promise<ReviewOutcome> {
  if (!ORGANIZATION_ID_PATTERN.test(org)) throw new AdminInputError('조직 id(uuid)가 아니다.', 'invalid_organization');
  try {
    if (target === 'active') {
      const result = await pool.query<ActivateCoreRow>(
        'SELECT from_status, changed, "grant", from_plan, kept_plan, version FROM ops_org_activate_core($1::uuid, $2::text)',
        [org, actor],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('ops_org_activate_core 가 행을 돌려주지 않았다');
      return activateOutcomeOf(row);
    }
    const result = await pool.query<RejectCoreRow>('SELECT from_status, changed, suspended, revoked_tokens FROM ops_org_reject_core($1::uuid)', [org]);
    const row = result.rows[0];
    if (row === undefined) throw new Error('ops_org_reject_core 가 행을 돌려주지 않았다');
    return rejectOutcomeOf(row);
  } catch (error) {
    throw opsSqlError(error, org);
  }
}
