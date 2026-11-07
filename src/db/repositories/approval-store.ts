/**
 * src/db/repositories/approval-store.ts — `ApprovalStore` 의 Postgres 구현 (계획 §3.4 · §4.3 · §4.5-6).
 *
 * **모든 전이가 `WHERE status='pending'` 조건부 UPDATE 로 시작하고, 그 UPDATE 가 0행이면
 * 트랜잭션의 나머지를 하지 않는다.** 먼저 이긴 쪽이 유일한 전이자이고 진 쪽은 no-op 이다(AC-i4).
 * 승인과 만료가 동시에 와도 `approval_requests` 행 잠금이 둘을 줄 세우고, 두 번째 UPDATE 는
 * 첫 번째가 커밋한 `status` 를 보고 0행이 된다(READ COMMITTED 의 재평가).
 *
 * **거절·만료는 세 테이블을 한 트랜잭션에서 닫는다** — 요청(`rejected`/`expired`), audit 행
 * (`denied` + `approval_rejected`/`approval_expired`, §4.3 표), messages(`denied`). 셋 중 하나만
 * 닫히면 "요청은 만료됐는데 메시지는 아직 `pending`" 인 행이 남고, 그 행에 릴리스 lease 가 걸릴 수
 * 있다. 같은 트랜잭션이면 그 창이 없다.
 *
 * **웹훅도 같은 트랜잭션이다** (outbox, `202609221910_webhooks.sql`). 서비스가 만든 이벤트를 전이를
 * **이긴 뒤에만** 적는다 — 전이에 지면(0행) 이벤트도 없고, 이벤트 INSERT 가 실패하면 전이도 롤백된다.
 * 이벤트의 `agent_id` 가 전이한 요청의 것과 다르면 던진다(롤백) — 한 에이전트의 사건이 다른 에이전트의
 * 웹훅으로 가는 경로를 저장소가 바닥에서 막는다.
 *
 * **두 가지 조립이 있다.** `createPostgresApprovalStore(pool)` 는 전이마다 자기 트랜잭션을 연다.
 * `createPostgresApprovalStoreOn(client)` 는 **호출자가 이미 연 트랜잭션** 위에서 돈다 — 매직링크 결정이
 * `FOR UPDATE` → 사용 기록 → 전이 → 웹훅을 한 커넥션·한 트랜잭션으로 묶어야 하기 때문이다
 * (`magic-link.ts` 의 `runInTransaction` 규약). 규칙(SQL)은 하나이고 트랜잭션 경계만 다르다.
 */

import type { Pool } from 'pg';

import type {
  ApprovalStore,
  ApproveCommand,
  ExpireCommand,
  RejectCommand,
  RelationshipGrant,
  ReleaseClaimRequest,
  ScheduledRelease,
} from '../../approval/service';
import { RELEASE_WINDOW_GRACE_SECONDS } from '../../policy/release-deferral';
import { RISK_HOLD_REASONS } from '../../policy/rules/risk-hold';
import type { WebhookEvent } from '../../webhooks/events';
import { withTransaction, type Queryable } from '../client';
import { toAgentId, type ApprovalRequestItemRow, type ApprovalRequestRow, type OrganizationReviewStatus } from '../schema';
import { selectRow, selectRows } from './rows';
import { enqueueWebhookEvent } from './webhook-store';

const REQUEST_COLUMNS =
  'id, agent_id, subject, status, created_at, expires_at, decided_at, decided_by, granted_scope';
const ITEM_COLUMNS =
  'approval_id, message_id, audit_id, from_address, recipients, is_thread_reply, thread_id, cost_cents, created_at';

/**
 * **조직이 정지(`owner_paused`)·동결(`abuse_freeze`) 중이면 승인이 성립하지 않는다** (2차 검증 L-A). 정지 중의 승인이
 * standing approval(관계)을 남기면, 정지를 푸는 순간 소유자가 정지 중에 누른 링크 하나가 그 상대를 영구히 연다 —
 * 정지는 "지금 아무것도 늘리지 마라" 여야 한다. 요청은 `pending` 으로 남고 링크는 소진되지 않는다(트랜잭션 롤백).
 * 거절·만료는 그대로 된다(안전 방향). DB 트리거(`approval_requests_reject_approve_while_paused`, 202609230750)가 같은
 * 것을 한 번 더 막는다 — 이 검사는 사유를 이름으로 돌려주기 위한 것이다.
 */
export class ApprovalBlockedByPauseError extends Error {
  constructor(
    readonly approvalId: string,
    readonly reason: 'org_owner_paused' | 'org_abuse_freeze',
  ) {
    super(`승인 ${approvalId} 는 조직이 정지·동결 중이라 성립하지 않는다 (${reason})`);
    this.name = 'ApprovalBlockedByPauseError';
  }
}

/** **삭제한 에이전트의 승인은 성립하지 않는다**(202610131000). 요청은 `pending` 으로 남고(트랜잭션 롤백) 만료 스위퍼가 닫는다. 거절은 된다. */
export class ApprovalBlockedByAgentDeletedError extends Error {
  constructor(readonly approvalId: string) {
    super(`승인 ${approvalId} 는 에이전트가 삭제돼 성립하지 않는다`);
    this.name = 'ApprovalBlockedByAgentDeletedError';
  }
}

/**
 * **운영자 검토 전·거절 조직에서는 승인이 성립하지 않는다** (셀프 가입, 202609240800). 정지 중 승인 불가(L-A)와 같은 규칙이다:
 * 검토 전 조직의 승인이 standing approval(관계)을 남기면, 운영자가 활성화하는 순간 검토 전에 누른 링크가 그 상대를 연다.
 * 요청은 `pending` 으로 남고 링크는 소진되지 않는다(트랜잭션 롤백) — 활성화 뒤 같은 링크로 다시 승인한다. 거절·만료는
 * 그대로 된다(안전 방향). DB 트리거(`approval_requests_reject_approve_while_unreviewed`)가 같은 것을 한 번 더 막는다.
 */
export class ApprovalBlockedByReviewError extends Error {
  constructor(
    readonly approvalId: string,
    readonly reason: 'org_pending_review' | 'org_review_rejected',
  ) {
    super(`승인 ${approvalId} 는 조직이 운영자 검토 전·거절 상태라 성립하지 않는다 (${reason})`);
    this.name = 'ApprovalBlockedByReviewError';
  }
}

/** `approval_releases` 집기 결과 한 행(DB 모양). */
interface ScheduledReleaseRow {
  approval_id: string;
  message_id: string;
  audit_id: string;
  agent_id: string;
  deadline_at: Date;
  claim_count: number;
}

function toScheduledRelease(row: ScheduledReleaseRow): ScheduledRelease {
  return {
    approvalId: row.approval_id,
    messageId: row.message_id,
    auditId: row.audit_id,
    agentId: toAgentId(row.agent_id),
    deadlineAt: row.deadline_at,
    claimCount: row.claim_count,
  };
}

function toRequestRow(row: ApprovalRequestRow): ApprovalRequestRow {
  return { ...row, agent_id: toAgentId(row.agent_id) };
}

/** audit 행과 messages 행을 요청의 종단 사유로 닫는다. 요청 전이에 이긴 트랜잭션 안에서만 부른다. */
async function closePendingAttempts(
  db: Queryable,
  approvalId: string,
  now: Date,
  reason: 'approval_rejected' | 'approval_expired',
): Promise<void> {
  // §4.3 표 — "거절 / TTL 만료 → 같은 행 갱신, decision='denied', reason=…". `reasons[]` 는
  // 평가 시점 값 그대로이고(트리거), 해소 사유는 `resolution_reason` 에 간다.
  await db.query(
    `UPDATE audit_logs
        SET decision = 'denied', resolved_at = $2, resolution_reason = $3
      WHERE approval_id = $1 AND decision = 'pending_approval'`,
    [approvalId, now, reason],
  );
  // `pending` 인 것만 닫는다. 릴리스가 이미 lease 를 잡은 행(`dispatching` 이후)은 이 트랜잭션이
  // 요청 전이에 이겼다면 존재할 수 없다 — 릴리스는 `approved` 요청만 잡기 때문이다.
  await db.query(
    `UPDATE messages SET status = 'denied'
      WHERE id IN (SELECT message_id FROM approval_request_items WHERE approval_id = $1)
        AND direction = 'outbound' AND status = 'pending'`,
    [approvalId],
  );
}

async function insertRelationship(
  db: Queryable,
  agentId: string,
  approvalId: string,
  decidedBy: string,
  grant: RelationshipGrant,
): Promise<void> {
  // `ON CONFLICT DO NOTHING` — 같은 상대가 이미 관계를 갖고 있으면(seed 이거나 다른 승인이 먼저
  // 만들었다) 새 행을 만들지 않는다. **기존 관계를 덮지 않는 것이 요점이다** — seed 를 `approved` 로
  // 덮으면 AC-a2 의 사유가 바뀌고, 좁은 관계를 넓은 관계로 덮으면 AC-d5 의 확인이 우회된다.
  await db.query(
    `INSERT INTO sender_relationships
       (agent_id, scope, address, domain, thread_id, trust_category, granted_via_approval_id, granted_by,
        domain_scope_confirmed_by)
     VALUES ($1, $2, $3, $4, $5, 'approved', $6, $7, $8)
     ON CONFLICT DO NOTHING`,
    [
      agentId,
      grant.scope,
      grant.address,
      grant.domain,
      grant.threadId,
      approvalId,
      decidedBy,
      grant.domainScopeConfirmedBy,
    ],
  );
}

/** 전이한 요청과 이벤트의 에이전트가 같아야 한다. 다르면 던져서 전이째 롤백한다. */
async function enqueueFor(db: Queryable, agentId: string, event: WebhookEvent, now: Date): Promise<void> {
  if (event.agentId !== agentId) {
    throw new Error(`웹훅 이벤트의 agent_id 가 전이한 요청의 것과 다르다 (approval agent=${agentId})`);
  }
  await enqueueWebhookEvent(db, event, now);
}

/** 트랜잭션 하나를 열어 `work` 를 돌리는 방법. 풀이면 새로 열고, 이미 열린 커넥션이면 그대로 쓴다. */
type TransactionRunner = <T>(work: (db: Queryable) => Promise<T>) => Promise<T>;

function buildApprovalStore(reader: Queryable, inTransaction: TransactionRunner): ApprovalStore {
  return {
    async find(approvalId: string): Promise<ApprovalRequestRow | null> {
      const row = await selectRow<ApprovalRequestRow>(
        reader,
        `SELECT ${REQUEST_COLUMNS} FROM approval_requests WHERE id = $1`,
        [approvalId],
      );
      return row === null ? null : toRequestRow(row);
    },

    async riskHoldReasons(approvalId: string): Promise<readonly string[]> {
      const rows = await selectRows<{ reason: string }>(
        reader,
        `SELECT DISTINCT r AS reason
           FROM approval_request_items i
           JOIN audit_logs a ON a.id = i.audit_id
           CROSS JOIN LATERAL unnest(a.reasons) AS r
          WHERE i.approval_id = $1 AND r = ANY($2::text[])
          ORDER BY 1`,
        [approvalId, [...RISK_HOLD_REASONS]],
      );
      return rows.map((row) => row.reason);
    },

    items(approvalId: string): Promise<readonly ApprovalRequestItemRow[]> {
      return selectRows<ApprovalRequestItemRow>(
        reader,
        `SELECT ${ITEM_COLUMNS} FROM approval_request_items WHERE approval_id = $1 ORDER BY created_at, message_id`,
        [approvalId],
      );
    },

    approve(command: ApproveCommand): Promise<ApprovalRequestRow | null> {
      return inTransaction(async (client) => {
        // L-A — 정지·동결 중에는 승인하지 않는다(위 `ApprovalBlockedByPauseError`). 동결이 소유자 정지보다 먼저 보인다.
        //   그 다음이 운영자 검토(`ApprovalBlockedByReviewError`) — 둘 다면 정지가 먼저 보인다(DB 트리거 순서와 같다).
        const pause = await selectRow<{ owner_paused: boolean; abuse_freeze: boolean; review_status: OrganizationReviewStatus; agent_deleted: boolean }>(
          client,
          `SELECT o.owner_paused, o.abuse_freeze, o.review_status, a.status = 'disabled' AS agent_deleted
             FROM approval_requests r
             JOIN agents a ON a.id = r.agent_id
             JOIN organizations o ON o.id = a.organization_id
            WHERE r.id = $1`,
          [command.approvalId],
        );
        // 삭제한 에이전트(202610131000)의 승인은 성립하지 않는다 — 정지보다 먼저(종단이라 기다려도 풀리지 않는다). DB 트리거
        //   `approval_requests_reject_approve_disabled_agent` 가 같은 것을 한 번 더 막는다.
        if (pause?.agent_deleted === true) throw new ApprovalBlockedByAgentDeletedError(command.approvalId);
        if (pause !== null && (pause.abuse_freeze || pause.owner_paused)) {
          throw new ApprovalBlockedByPauseError(command.approvalId, pause.abuse_freeze ? 'org_abuse_freeze' : 'org_owner_paused');
        }
        if (pause !== null && pause.review_status !== 'active') {
          throw new ApprovalBlockedByReviewError(
            command.approvalId,
            pause.review_status === 'rejected' ? 'org_review_rejected' : 'org_pending_review',
          );
        }
        // ★ `expires_at > $2` — **TTL 을 넘긴 요청은 스위퍼가 아직 안 돌았어도 승인되지 않는다.**
        //   DB CHECK(`approval_requests_approve_before_expiry`)가 같은 것을 한 번 더 막는다.
        const row = await selectRow<ApprovalRequestRow>(
          client,
          `UPDATE approval_requests
              SET status = 'approved', decided_at = $2, decided_by = $3, granted_scope = $4
            WHERE id = $1 AND status = 'pending' AND expires_at > $2
            RETURNING ${REQUEST_COLUMNS}`,
          [command.approvalId, command.now, command.decidedBy, command.scope],
        );
        if (row === null) return null;
        for (const grant of command.relationships) {
          await insertRelationship(client, row.agent_id, row.id, command.decidedBy, grant);
        }
        await enqueueFor(client, row.agent_id, command.event, command.now);
        return toRequestRow(row);
      });
    },

    reject(command: RejectCommand): Promise<boolean> {
      return inTransaction(async (client) => {
        const row = await selectRow<{ agent_id: string }>(
          client,
          `UPDATE approval_requests SET status = 'rejected', decided_at = $2, decided_by = $3
            WHERE id = $1 AND status = 'pending'
            RETURNING agent_id`,
          [command.approvalId, command.now, command.decidedBy],
        );
        if (row === null) return false;
        await closePendingAttempts(client, command.approvalId, command.now, 'approval_rejected');
        await enqueueFor(client, row.agent_id, command.event, command.now);
        return true;
      });
    },

    expire(command: ExpireCommand): Promise<boolean> {
      return inTransaction(async (client) => {
        const row = await selectRow<{ agent_id: string }>(
          client,
          `UPDATE approval_requests SET status = 'expired', decided_at = $2
            WHERE id = $1 AND status = 'pending' AND expires_at <= $2
            RETURNING agent_id`,
          [command.approvalId, command.now],
        );
        if (row === null) return false;
        await closePendingAttempts(client, command.approvalId, command.now, 'approval_expired');
        await enqueueFor(client, row.agent_id, command.event, command.now);
        return true;
      });
    },

    async listDue(now: Date, limit: number): Promise<readonly string[]> {
      const rows = await selectRows<{ id: string }>(
        reader,
        `SELECT id FROM approval_requests
          WHERE status = 'pending' AND expires_at <= $1
          ORDER BY expires_at LIMIT $2`,
        [now, limit],
      );
      return rows.map((row) => row.id);
    },

    async oldestPendingCreatedAt(): Promise<Date | null> {
      const row = await selectRow<{ oldest: Date | null }>(
        reader,
        `SELECT min(created_at) AS oldest FROM approval_requests WHERE status = 'pending'`,
      );
      return row?.oldest ?? null;
    },

    async countPendingOverdue(at: Date): Promise<number> {
      const row = await selectRow<{ n: number }>(reader, `SELECT count(*)::int AS n FROM audit_pending_overdue($1)`, [at]);
      return row?.n ?? 0;
    },

    async claimDueReleases(request: ReleaseClaimRequest): Promise<readonly ScheduledRelease[]> {
      // **창이 닫힌 항목은 관문에 세우지 않고 여기서 닫는다** (검증 V1 MINOR-1). 워커가 멈췄다가 창 끝 + 유예
      // (`releaseWindowClosed`)를 넘겨 스윕하면 재평가는 대부분 허용이다 — 창을 거부 쪽에서만 보면 그 승인분이
      // 전부 나간다. 닫는 모양은 거절·만료(`closePendingAttempts`)와 같다: 일정 `settled`, audit 행 `denied` +
      // `release_denied:release_window_expired`, messages `denied` — 한 문장(데이터 수정 CTE)이라 셋이 같이 닫힌다.
      // **아직 아무도 손대지 않은 항목만** 닫는다(audit `pending_approval` · messages `pending`). 관문이 lease 를
      // 잡은 뒤의 항목은 결말이 이미 관문 쪽에 있다 — 관문(`reserveRelease` 의 같은 창 검사)과 워커(lease 재예약의
      // 창 검사)가 닫는다.
      await reader.query(
        `WITH expired AS (
           SELECT r.message_id
             FROM approval_releases r
             JOIN audit_logs a ON a.id = r.audit_id
             JOIN messages m ON m.id = r.message_id
            WHERE r.status = 'scheduled' AND r.next_release_at <= $1
              AND r.deadline_at + make_interval(secs => $2) <= $1
              AND ($3::uuid IS NULL OR r.approval_id = $3::uuid)
              AND a.decision = 'pending_approval' AND m.status = 'pending'
            FOR UPDATE OF r SKIP LOCKED
         ), settled AS (
           UPDATE approval_releases r
              SET status = 'settled', settled_outcome = 'denied', settled_at = $1,
                  last_deferral_reason = 'release_window_expired'
             FROM expired
            WHERE r.message_id = expired.message_id
           RETURNING r.message_id, r.audit_id
         ), audit AS (
           UPDATE audit_logs a
              SET decision = 'denied', resolved_at = $1, resolution_reason = 'release_denied:release_window_expired'
             FROM settled
            WHERE a.id = settled.audit_id AND a.decision = 'pending_approval'
           RETURNING a.id
         )
         UPDATE messages m SET status = 'denied'
           FROM settled
          WHERE m.id = settled.message_id AND m.direction = 'outbound' AND m.status = 'pending'`,
        [request.now, RELEASE_WINDOW_GRACE_SECONDS, request.approvalId],
      );

      // **집기 = 임대.** `FOR UPDATE SKIP LOCKED` 로 동시 워커가 같은 행을 두 번 집지 않고, 집은 행은
      // `next_release_at` 을 임대 끝으로 민다 — 워커가 결말을 적기 전에 죽으면 그 시각에 다시 집힌다(그때
      // 관문의 lease·조건부 UPDATE 가 중복 발송을 막는다). 순서는 기한 → 항목 생성 순 — 배치의 페이싱이
      // 사람이 본 순서대로 흐른다.
      const rows = await selectRows<ScheduledReleaseRow & { due_at: Date; item_created_at: Date }>(
        reader,
        `WITH due AS (
           SELECT r.message_id, r.next_release_at AS due_at, i.created_at AS item_created_at
             FROM approval_releases r
             JOIN approval_request_items i ON i.approval_id = r.approval_id AND i.message_id = r.message_id
            WHERE r.status = 'scheduled' AND r.next_release_at <= $1
              AND ($3::uuid IS NULL OR r.approval_id = $3::uuid)
            ORDER BY r.next_release_at, i.created_at, r.message_id
            LIMIT $2
            FOR UPDATE OF r SKIP LOCKED
         )
         UPDATE approval_releases r
            SET next_release_at = $1::timestamptz + make_interval(secs => $4),
                claim_count = r.claim_count + 1
           FROM due
          WHERE r.message_id = due.message_id
         RETURNING r.approval_id, r.message_id, r.audit_id, r.agent_id, r.deadline_at, r.claim_count,
                   due.due_at, due.item_created_at`,
        [request.now, request.limit, request.approvalId, request.leaseSeconds],
      );
      // `UPDATE … RETURNING` 은 순서를 보장하지 않는다 — 집은 순서(기한 → 항목 순)로 다시 줄 세운다.
      return rows
        .sort(
          (left, right) =>
            left.due_at.getTime() - right.due_at.getTime() ||
            left.item_created_at.getTime() - right.item_created_at.getTime() ||
            left.message_id.localeCompare(right.message_id),
        )
        .map(toScheduledRelease);
    },

    async deferRelease(messageId: string, until: Date, reason: string): Promise<void> {
      await reader.query(
        `UPDATE approval_releases SET next_release_at = $2, last_deferral_reason = $3
          WHERE message_id = $1 AND status = 'scheduled'`,
        [messageId, until, reason],
      );
    },

    async settleRelease(messageId: string, outcome: string, now: Date): Promise<void> {
      await reader.query(
        `UPDATE approval_releases SET status = 'settled', settled_outcome = $2, settled_at = $3
          WHERE message_id = $1 AND status = 'scheduled'`,
        [messageId, outcome, now],
      );
    },
  };
}

/** 전이마다 풀에서 트랜잭션 하나를 연다. 스위퍼·테스트가 쓴다. */
export function createPostgresApprovalStore(pool: Pool): ApprovalStore {
  return buildApprovalStore(pool, (work) => withTransaction(pool, work));
}

/**
 * **호출자가 이미 `BEGIN` 한 커넥션** 위의 저장소. 전이는 새 트랜잭션을 열지 않고 그 커넥션에서 돈다 —
 * 커밋·롤백은 호출자의 몫이다. 이 저장소에서 던진 예외가 호출자의 트랜잭션을 롤백시켜야 원자성이 선다.
 */
export function createPostgresApprovalStoreOn(client: Queryable): ApprovalStore {
  return buildApprovalStore(client, (work) => work(client));
}
