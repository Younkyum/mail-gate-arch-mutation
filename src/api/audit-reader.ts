/**
 * src/api/audit-reader.ts — audit 조회 모델 (AC-9).
 *
 * *"왜 이 메일이 나갔는가"* 에 답하는 데 필요한 것은 세 가지다 — **판정**(`decision`),
 * **근거**(`reasons`), **그 판정을 낸 정책이 무엇이었나**(`policy_version`). 계획 §4.3 이
 * 정책 스냅샷을 참조가 아니라 전문으로 저장하게 한 이유가 이것이다: 정책이 나중에
 * 바뀌어도 그 시점의 근거는 사후에 다시 쓰이지 않는다.
 *
 * **읽기 전용이다.** 이 파일에 INSERT/UPDATE 가 없는 것은 우연이 아니다 — audit 행을
 * 만드는 자리는 관문 하나이고(`gate.ts` 의 `recordAudit`), 해소하는 자리는 `AuditSink.resolve`
 * 하나다. 조회 경로가 쓰기를 갖는 순간 "시도당 정확히 1행" 을 보장하는 지점이 셋이 된다.
 */

import type { Pool } from 'pg';

import type { Queryable } from '../db/client';
import { toAgentId, type AgentId, type AuditDecision } from '../db/schema';

/** audit 한 행. 컬럼 이름이 아니라 **의미**로 옮긴다 — API 응답이 DB 스키마를 노출하지 않게. */
export interface AuditRecord {
  readonly id: string;
  readonly agentId: AgentId;
  readonly messageId: string | null;
  readonly decision: AuditDecision;
  readonly reasons: readonly string[];
  /** 평가 시점 정책 스냅샷. 정책을 **읽지 못한** 시도에서만 `null`(§4.3). */
  readonly policyVersion: number | null;
  readonly policyVersionId: string | null;
  readonly evaluatedAt: Date;
  readonly latencyMs: number | null;
  readonly traceId: string | null;
  /**
   * 해소 시각. `allowed` 인데 `null` 이면 뜻이 **하나로 확정돼 있다**:
   * 전송 도중에 프로세스가 죽었다(§4.5-5). 다른 뜻을 추가하면 그 구별이 깨진다.
   */
  readonly resolvedAt: Date | null;
  readonly resolutionReason: string | null;
}

export interface AuditReader {
  /** 한 메시지의 시도 이력. 보통 1행이지만 lease 만료 후 재시도는 새 시도이므로 여러 행일 수 있다. */
  byMessageId(messageId: string): Promise<readonly AuditRecord[]>;
  /** 한 에이전트의 최근 시도. 최신순. */
  byAgentId(agentId: AgentId, limit: number): Promise<readonly AuditRecord[]>;
}

interface AuditRowShape {
  id: string;
  agent_id: string;
  message_id: string | null;
  decision: AuditDecision;
  reasons: string[];
  policy_version: number | null;
  policy_version_id: string | null;
  evaluated_at: Date;
  latency_ms: number | null;
  trace_id: string | null;
  resolved_at: Date | null;
  resolution_reason: string | null;
}

const SELECT_COLUMNS = `id, agent_id, message_id, decision, reasons, policy_version, policy_version_id,
                        evaluated_at, latency_ms, trace_id, resolved_at, resolution_reason`;

function toRecord(row: AuditRowShape): AuditRecord {
  return {
    id: row.id,
    agentId: toAgentId(row.agent_id),
    messageId: row.message_id,
    decision: row.decision,
    reasons: row.reasons,
    policyVersion: row.policy_version,
    policyVersionId: row.policy_version_id,
    evaluatedAt: row.evaluated_at,
    latencyMs: row.latency_ms,
    traceId: row.trace_id,
    resolvedAt: row.resolved_at,
    resolutionReason: row.resolution_reason,
  };
}

async function select(db: Queryable, text: string, values: unknown[]): Promise<readonly AuditRecord[]> {
  const result = await db.query<AuditRowShape & Record<string, unknown>>(text, values);
  return result.rows.map(toRecord);
}

/** 조회 상한. 없으면 한 요청이 테이블 전체를 끌어온다 — audit 는 append-only 라 단조 증가한다. */
const MAX_AUDIT_PAGE = 200;

export function createPostgresAuditReader(pool: Pool): AuditReader {
  return {
    byMessageId(messageId: string): Promise<readonly AuditRecord[]> {
      return select(
        pool,
        `SELECT ${SELECT_COLUMNS} FROM audit_logs WHERE message_id = $1 ORDER BY evaluated_at`,
        [messageId],
      );
    },

    byAgentId(agentId: AgentId, limit: number): Promise<readonly AuditRecord[]> {
      const capped = Math.max(1, Math.min(limit, MAX_AUDIT_PAGE));
      return select(
        pool,
        `SELECT ${SELECT_COLUMNS} FROM audit_logs WHERE agent_id = $1 ORDER BY evaluated_at DESC LIMIT $2`,
        [agentId, capped],
      );
    },
  };
}
