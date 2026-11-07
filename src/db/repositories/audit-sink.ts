/**
 * src/db/repositories/audit-sink.ts — `AuditSink` 의 Postgres 구현.
 *
 * **규약 (§4.3 r3-V2): 발송 시도당 정확히 1행.** `record` 가 그 1행을 만들고,
 * `resolve` 는 **같은 행을 갱신한다** — 새 행을 만들지 않는다.
 * `count(audit_logs) === 발송 시도 수` 가 §5.4 의 완결성 단언이고, 여기서 INSERT 를
 * 한 번 더 하는 구현이 그 단언을 깬다.
 *
 * **`decision` 을 건드리지 않는다.** 전송 결과는 판정이 아니다 — `allowed` 였던 행은
 * 전송이 실패해도 `allowed` 다("보내도 된다고 판정했다"는 사실은 사후에 바뀌지 않는다).
 * DB 트리거 `audit_logs_decision_transition_guard` 가 `pending_approval` 밖에서의
 * `decision` 변경을 거부하므로, 결과를 거기 쓰려는 구현은 런타임에 실패한다.
 * 결과는 갱신이 허용된 컬럼 두 개(`resolved_at`, `resolution_reason`)에 담는다.
 */

import type { Pool } from 'pg';

import type {
  AuditEntry,
  AuditSink,
  PendingApprovalOpening,
  PendingAuditTarget,
  PendingResolution,
} from '../../policy/gate';
import { withTransaction, type Queryable } from '../client';
import { selectRow } from './rows';

/**
 * `resolution_reason` 에 쓰는 성공 표식.
 *
 * `null` 이 아니라 값을 쓰는 이유: `resolved_at IS NOT NULL AND resolution_reason IS NULL`
 * 인 행은 "성공했다" 와 "해소는 됐는데 사유를 못 썼다" 를 구분하지 못한다. 미해소
 * `allowed` 행의 뜻이 **"전송 중 사망" 하나로 확정돼 있다**는 §4.5-5 의 결론은
 * 해소된 행 쪽에서도 뜻이 하나일 때만 쓸모가 있다.
 */
export const AUDIT_OUTCOME_SENT = 'sent';

/** 실패 사유의 접두사. `resolution_reason` 하나로 결과와 사유를 같이 담는다. */
export const AUDIT_OUTCOME_FAILED_PREFIX = 'failed:';

interface AuditIdRow {
  id: string;
}

/** 전송 결과를 `resolution_reason` 한 컬럼의 문자열로 만든다. */
export function toResolutionReason(outcome: 'sent' | 'failed', reason: string | null): string {
  if (outcome === 'sent') return AUDIT_OUTCOME_SENT;
  return `${AUDIT_OUTCOME_FAILED_PREFIX}${reason ?? 'unknown'}`;
}

async function insertAuditRow(db: Queryable, entry: AuditEntry): Promise<string> {
  const { decision } = entry;
  const row = await selectRow<AuditIdRow>(
    db,
    `INSERT INTO audit_logs
       (agent_id, message_id, decision, reasons, policy_version_id, policy_version, evaluated_at, latency_ms, trace_id,
        approval_id, bootstrap_grace_remaining)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      entry.agentId,
      entry.messageId,
      decision.verdict,
      [...decision.reasons],
      // 두 컬럼은 항상 함께 있거나 함께 없다 — DB CHECK `audit_logs_policy_stamp_presence`
      // 가 그 예외를 `denied` + `evaluation_error` 한 가지로 좁힌다.
      decision.policyVersionId,
      decision.policyVersion,
      decision.evaluatedAt,
      entry.latencyMs,
      entry.traceId,
      entry.approval?.approvalId ?? null,
      decision.bootstrapGraceRemaining,
    ],
  );
  if (row === null) {
    // RETURNING 이 0행이면 INSERT 가 없었다는 뜻이다. 조용히 넘어가면 그 시도는
    // audit 에 0행을 남긴다 — "조용한 거부도 없다"(Principle P3)의 정반대다.
    throw new Error('audit_logs INSERT 가 행을 돌려주지 않았다');
  }
  return row.id;
}

/**
 * 승인 요청 행을 연다 — 배치면 **이미 열린 같은 배치에 합류**한다(§3.2 전환 공지, AC-b1 "요청 1개").
 *
 * 배치의 합류 조건은 셋이다: **같은 에이전트**, `subject='batch'`, **아직 `pending`**. 행 잠금(`FOR UPDATE`)
 * 아래에서 본다 — 승인·거절·만료의 조건부 UPDATE 가 이 트랜잭션 뒤로 줄을 서므로, 사람이 결정한 뒤의
 * 요청에 항목이 덧붙는 창이 없다. 조건이 하나라도 틀리면 던진다(트랜잭션 롤백 → 행도 항목도 없다) —
 * 이미 승인된 요청에 봉투를 붙이면 **사람이 본 적 없는 수신자가 승인된 것**이 된다.
 */
async function openOrJoinRequest(db: Queryable, entry: AuditEntry, opening: PendingApprovalOpening): Promise<void> {
  if (opening.subject === 'message') {
    await db.query(
      `INSERT INTO approval_requests (id, agent_id, subject, created_at, expires_at)
       VALUES ($1, $2, 'message', $3, $4)`,
      [opening.approvalId, entry.agentId, opening.createdAt, opening.expiresAt],
    );
    return;
  }
  await db.query(
    `INSERT INTO approval_requests (id, agent_id, subject, created_at, expires_at)
     VALUES ($1, $2, 'batch', $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [opening.approvalId, entry.agentId, opening.createdAt, opening.expiresAt],
  );
  const joined = await selectRow<{ id: string }>(
    db,
    `SELECT id FROM approval_requests
      WHERE id = $1 AND agent_id = $2 AND subject = 'batch' AND status = 'pending'
      FOR UPDATE`,
    [opening.approvalId, entry.agentId],
  );
  if (joined === null) {
    throw new Error(
      `배치 승인 요청에 합류할 수 없다 (approvalId=${opening.approvalId}) — 다른 에이전트의 요청이거나 ` +
        '이미 결정된 요청이다. 결정된 요청에 항목을 붙이면 사람이 보지 않은 봉투가 승인된 것이 된다.',
    );
  }
}

/**
 * `pending_approval` 행 + 승인 요청 + 항목을 **한 트랜잭션에서** 쓴다.
 *
 * 순서가 FK 의 순서다: 요청 → audit 행(`approval_id`) → 항목(`audit_id`). 어느 하나라도 실패하면
 * 전부 롤백되어 "행 없는 요청" 도 "요청 없는 대기 행" 도 남지 않는다. 대기 행이 요청 없이 남으면
 * TTL 스위퍼가 찾지 못해 **영원히 `pending`** 이 되고, 그것은 §4.3 보조 불변식("TTL 을 넘겨
 * pending 인 행 0개")의 정면 위반이다.
 */
async function insertPendingWithApproval(
  pool: Pool,
  entry: AuditEntry,
  opening: PendingApprovalOpening,
): Promise<string> {
  if (entry.messageId === null) {
    // 관문(`openApproval`)이 먼저 던진다. 저장소가 한 번 더 막는 이유: 항목 테이블의 NOT NULL 이
    // 막기 전에 요청 행이 이미 INSERT 되어 있어, 오류 메시지가 "무엇이 없었는가" 를 말하지 않는다.
    throw new Error('승인 요청을 열려면 messages 행이 필요하다');
  }
  const messageId = entry.messageId;
  return withTransaction(pool, async (client) => {
    await openOrJoinRequest(client, entry, opening);
    const auditId = await insertAuditRow(client, entry);
    await client.query(
      `INSERT INTO approval_request_items
         (approval_id, message_id, audit_id, from_address, recipients, is_thread_reply, thread_id, cost_cents)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8)`,
      [
        opening.approvalId,
        messageId,
        auditId,
        opening.envelope.fromAddress,
        [...opening.envelope.recipients],
        opening.envelope.isThreadReply,
        opening.envelope.threadId,
        opening.envelope.costCents,
      ],
    );
    return auditId;
  });
}

/**
 * 릴리스 재평가의 결말을 `pending_approval` 행에 적는다.
 *
 * **좌표 셋(`id`·`approval_id`·`message_id`)을 전부 WHERE 에 둔다.** 릴리스 잡이 싣고 온 id 가
 * 다른 요청의 행을 가리키는 실수(잡 직렬화 버그)가 그 행을 조용히 `allowed` 로 만들지 못하게 한다.
 * `decision='pending_approval'` 조건이 조건부 UPDATE 의 본체다 — 만료·거절이 먼저 이겼으면 0행.
 */
async function resolvePendingRow(
  pool: Pool,
  target: PendingAuditTarget,
  resolution: PendingResolution,
): Promise<boolean> {
  const result =
    resolution.kind === 'released'
      ? await pool.query(
          `UPDATE audit_logs SET decision = 'allowed', approved_by = $4
            WHERE id = $1 AND approval_id = $2 AND message_id = $3 AND decision = 'pending_approval'`,
          [target.auditId, target.approvalId, target.messageId, resolution.approvedBy],
        )
      : await pool.query(
          `UPDATE audit_logs SET decision = 'denied', resolved_at = $4, resolution_reason = $5
            WHERE id = $1 AND approval_id = $2 AND message_id = $3 AND decision = 'pending_approval'`,
          [target.auditId, target.approvalId, target.messageId, new Date(), resolution.reason],
        );
  return result.rowCount === 1;
}

/** 풀 하나를 받아 `AuditSink` 를 만든다. */
export function createPostgresAuditSink(pool: Pool): AuditSink {
  return {
    record(entry: AuditEntry): Promise<string> {
      if (entry.approval !== null) return insertPendingWithApproval(pool, entry, entry.approval);
      return insertAuditRow(pool, entry);
    },

    resolvePending(target: PendingAuditTarget, resolution: PendingResolution): Promise<boolean> {
      return resolvePendingRow(pool, target, resolution);
    },

    async resolve(auditId: string, outcome: 'sent' | 'failed', reason: string | null): Promise<void> {
      // **`WHERE resolved_at IS NULL` 이 요점이다.** 같은 시도를 두 번 해소하려는 호출은
      // 0행을 바꾸고 끝난다 — 첫 해소가 진실이고, 재전달이 그것을 덮어쓰지 않는다.
      await pool.query(
        `UPDATE audit_logs
            SET resolved_at = $2, resolution_reason = $3
          WHERE id = $1 AND resolved_at IS NULL`,
        [auditId, new Date(), toResolutionReason(outcome, reason)],
      );
    },
  };
}
