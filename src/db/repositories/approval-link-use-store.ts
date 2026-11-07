/**
 * src/db/repositories/approval-link-use-store.ts — `approval_link_uses` 의 Postgres 구현.
 *
 * 규칙(서명·만료·판정 순서)은 전부 `src/approval/magic-link.ts` 에 있다. 이 파일은 둘을 한다:
 * ① `recordApprovalLinkUse` — **행 하나를 넣고 "처음인가" 에 답한다.**
 * ② `createPostgresApprovalLinkPorts` — 매직링크 포트를 한 트랜잭션으로 조립한다(판정은 하지 않는다 —
 *    전이 판정은 `approval/service.ts`, 링크 판정은 `magic-link.ts` 의 몫이다).
 *
 * **`Queryable` 을 받는다(풀이 아니라).** 사용 기록은 approval 상태 전이와 **같은 트랜잭션**
 * 이어야 한다 — 기록만 커밋되고 전이가 실패하면 링크는 소진됐는데 결정은 없는 상태가 된다.
 * 호출자(아래 `createPostgresApprovalLinkPorts` 의 `runInTransaction`)가 잡은 커넥션을 그대로 넘긴다.
 */

import type { Pool } from 'pg';

import {
  ApprovalLinkScopeError,
  ApprovalLinkTransitionLostError,
  type ApprovalLinkPorts,
  type ApprovalLinkSummary,
  type ApprovalLinkTarget,
  type ApprovalLinkTransaction,
  type ApprovalLinkUse,
} from '../../approval/magic-link';
import {
  approveRequest,
  DomainScopeConfirmationRequiredError,
  rejectRequest,
  ThreadScopeUnavailableError,
} from '../../approval/service';
import type { HmacKeyring } from '../../security/hmac-keyring';
import { sqlStateOf, withTransaction, type Queryable } from '../client';
import { ApprovalBlockedByAgentDeletedError, ApprovalBlockedByPauseError, ApprovalBlockedByReviewError, createPostgresApprovalStoreOn } from './approval-store';
import { selectRow, selectRows } from './rows';

/**
 * 사용 기록. 같은 approval(또는 같은 jti)이 이미 있으면 `'already_used'` 이고 아무것도 바꾸지 않는다.
 *
 * `ON CONFLICT DO NOTHING` 에 대상을 적지 않는 이유: 유니크 인덱스가 둘(approval_id,
 * token_id_hash)이고 **어느 쪽에 걸려도** 답은 "이미 쓰였다" 다. 예외를 잡아 제약 이름을
 * 문자열로 검사하는 경로를 만들지 않는다.
 */
export async function recordApprovalLinkUse(
  db: Queryable,
  use: ApprovalLinkUse,
): Promise<'recorded' | 'already_used'> {
  const result = await db.query(
    `INSERT INTO approval_link_uses (approval_id, token_id_hash, key_id, decision, used_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [use.approvalId, use.tokenIdHash, use.keyId, use.decision, use.usedAt],
  );
  return result.rowCount === 1 ? 'recorded' : 'already_used';
}

// ---------------------------------------------------------------------------
// 매직링크 포트의 Postgres 조립 (`magic-link.ts` 의 `ApprovalLinkPorts`)
// ---------------------------------------------------------------------------

export interface PostgresApprovalLinkOptions {
  readonly keyring: HmacKeyring;
  /**
   * 승인이 **커밋된 뒤** 불린다 — 릴리스 잡을 넣는 자리다(`workers/approval-release`). 트랜잭션 안에서
   * 넣으면 롤백된 승인의 잡이 큐에 남는다. 이것이 던지면 결정은 이미 커밋된 뒤이므로 호출자에게 그대로
   * 전해진다(승인은 되돌리지 않는다 — 잡이 유실된 승인은 `approved` 로 남아 재투입할 수 있다).
   */
  readonly onApproved: (approvalId: string) => Promise<void>;
  /**
   * 결정(승인 · 거절)이 **커밋된 뒤** 불린다 — 실시간 `approval.resolved` 힌트(묶음 E — `realtime/push.ts`, 던지지 않는다). 선택 — 생략하면 아무것도
   * 하지 않는다.
   */
  readonly onResolved?: (approvalId: string) => Promise<void>;
}

/**
 * 결정자 표기. 매직링크가 아는 것은 "이 키로 서명된 소유자 링크를 가진 사람" 뿐이다 — 사람의 신원이
 * 아니다. 그 사실 그대로 적는다(`audit_logs.approved_by`·`approval_requests.decided_by` 로 간다).
 * 사람 신원은 P5 의 로그인된 대시보드가 채운다.
 */
export function magicLinkDecider(keyId: string): string {
  return `magic_link:${keyId}`;
}

interface SummaryHeadRow {
  status: string;
  expires_at: Date;
  subject: 'message' | 'batch';
  agent_name: string;
}

interface SummaryItemRow {
  from_address: string;
  recipients: string[];
}

async function findSummary(db: Queryable, approvalId: string): Promise<ApprovalLinkSummary | null> {
  const head = await selectRow<SummaryHeadRow>(
    db,
    `SELECT r.status, r.expires_at, r.subject, a.name AS agent_name
       FROM approval_requests r JOIN agents a ON a.id = r.agent_id
      WHERE r.id = $1`,
    [approvalId],
  );
  if (head === null) return null;
  // 첨부 요약(메일 기본기 2차 · 보안 리뷰 L5) — 이 요청의 항목 메일들에 걸린 첨부(자리 순).
  const attachment = await selectRow<{ count: number; bytes: string; names: string[] | null }>(
    db,
    `SELECT count(*)::int AS count, coalesce(sum(a.bytes), 0)::text AS bytes,
            array_agg(a.filename ORDER BY i.created_at, i.message_id, l.position) AS names
       FROM approval_request_items i
       JOIN message_attachments l ON l.message_id = i.message_id
       JOIN outbound_attachments a ON a.id = l.attachment_id
      WHERE i.approval_id = $1`,
    [approvalId],
  );
  const items = await selectRows<SummaryItemRow>(
    db,
    `SELECT from_address, recipients FROM approval_request_items
      WHERE approval_id = $1 ORDER BY created_at, message_id`,
    [approvalId],
  );
  // 위험 보류(ADR-0016) — 항목들의 audit 사유 중 위험 보류 사유(닫힌 코드). 페이지가 고정 문구로 보이고 범위 선택을 숨긴다(승인은 `once`).
  const risk = await createPostgresApprovalStoreOn(db).riskHoldReasons(approvalId);
  return {
    riskReasons: risk,
    state: head.status === 'pending' ? 'pending' : 'resolved',
    expiresAt: head.expires_at,
    subject: head.subject,
    agentName: head.agent_name,
    fromAddresses: [...new Set(items.map((item) => item.from_address))],
    recipients: [...new Set(items.flatMap((item) => item.recipients))],
    attemptCount: items.length,
    ...(attachment !== null && attachment.count > 0
      ? { attachments: { count: attachment.count, bytes: Number(attachment.bytes), names: attachment.names ?? [] } }
      : {}),
  };
}

/**
 * 한 풀 위의 매직링크 포트.
 *
 * `runInTransaction` 은 **커넥션 하나·트랜잭션 하나**다: `FOR UPDATE` → `recordApprovalLinkUse` →
 * 서비스의 전이(`approveRequest`/`rejectRequest`, 트랜잭션 안의 저장소 `createPostgresApprovalStoreOn`)
 * → 웹훅 outbox. 어느 하나가 던지면 전부 롤백된다 — 링크는 소진되지 않고 결정도 이벤트도 없다.
 *
 * `findApprovalSummary`(미리보기)는 풀에서 바로 읽는다 — 잠금도 트랜잭션도 없다.
 */
export function createPostgresApprovalLinkPorts(pool: Pool, options: PostgresApprovalLinkOptions): ApprovalLinkPorts {
  return {
    keyring: options.keyring,

    findApprovalSummary: (approvalId) => findSummary(pool, approvalId),

    async runInTransaction<T>(work: (tx: ApprovalLinkTransaction) => Promise<T>): Promise<T> {
      const approved: string[] = [];
      const resolved: string[] = [];
      const result = await withTransaction(pool, (client) => {
        const store = createPostgresApprovalStoreOn(client);
        return work({
          async findApprovalForUpdate(approvalId: string): Promise<ApprovalLinkTarget | null> {
            const row = await selectRow<{ status: string; expires_at: Date }>(
              client,
              'SELECT status, expires_at FROM approval_requests WHERE id = $1 FOR UPDATE',
              [approvalId],
            );
            if (row === null) return null;
            return { state: row.status === 'pending' ? 'pending' : 'resolved', expiresAt: row.expires_at };
          },

          recordUse: (use) => recordApprovalLinkUse(client, use),

          async resolveApproval(approvalId, decision, now, resolution): Promise<void> {
            const decidedBy = magicLinkDecider(resolution.keyId);
            if (decision === 'reject') {
              if (!(await rejectRequest(store, { approvalId, decidedBy, now }))) {
                throw new ApprovalLinkTransitionLostError(approvalId);
              }
              resolved.push(approvalId);
              return;
            }
            let outcome: Awaited<ReturnType<typeof approveRequest>>;
            try {
              outcome = await approveRequest(store, {
                approvalId,
                decidedBy,
                now,
                scope: resolution.scope,
                confirmScope: resolution.confirmScope,
              });
            } catch (error) {
              if (error instanceof DomainScopeConfirmationRequiredError) {
                throw new ApprovalLinkScopeError('scope_confirmation_required');
              }
              if (error instanceof ThreadScopeUnavailableError) throw new ApprovalLinkScopeError('scope_unavailable');
              // 삭제한 에이전트(202610131000) — 코드 검사를 지나 DB 트리거(55000)에 걸린 경합도 같은 응답.
              if (error instanceof ApprovalBlockedByAgentDeletedError || isApprovalTriggerError(error, 'the agent was deleted')) {
                throw new ApprovalLinkScopeError('agent_deleted');
              }
              // L-A — 정지·동결 중 승인. 코드 검사(ApprovalBlockedByPauseError)를 지나 DB 트리거(55000)에 걸린 경합도 같은 응답.
              if (error instanceof ApprovalBlockedByPauseError || isApprovalTriggerError(error, 'while the organization is paused or frozen')) {
                throw new ApprovalLinkScopeError('organization_paused');
              }
              // 운영자 검토 전·거절 조직(셀프 가입, 202609240800) — 같은 규칙, 다른 안내. DB 트리거 경합도 같은 응답.
              if (error instanceof ApprovalBlockedByReviewError || isApprovalTriggerError(error, 'while the organization is not active (review)')) {
                throw new ApprovalLinkScopeError('organization_not_active');
              }
              throw error;
            }
            if (outcome.kind !== 'approved') throw new ApprovalLinkTransitionLostError(approvalId);
            approved.push(approvalId);
            resolved.push(approvalId);
          },
        });
      });
      // 커밋된 뒤에만. 위 `withTransaction` 이 던졌으면 여기 오지 않는다.
      for (const approvalId of approved) await options.onApproved(approvalId);
      if (options.onResolved !== undefined) for (const approvalId of resolved) await options.onResolved(approvalId);
      return result;
    },
  };
}

/**
 * 승인 트리거가 던지는 오류인가(SQLSTATE 55000 + 그 트리거의 문구). 정지·동결 = 마이그레이션 0750,
 * 검토 전 = 202609240800.
 */
function isApprovalTriggerError(error: unknown, fragment: string): boolean {
  if (sqlStateOf(error) !== '55000') return false;
  const { message } = error as { message?: unknown };
  return typeof message === 'string' && message.includes(fragment);
}
