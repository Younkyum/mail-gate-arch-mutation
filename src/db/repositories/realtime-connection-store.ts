/**
 * src/db/repositories/realtime-connection-store.ts — 실시간 연결 표(202610081300)의 **정의 함수 호출만**. 표 권한은 어느 제한 롤에도 없다 — SQL 은
 * 함수 이름뿐이다. 대상 선택(보이는 메일 · 그 에이전트의 살아 있는 연결)은 함수 안에 있다(`src/realtime/push.ts` 머리말).
 *
 * 롤마다 쓸 수 있는 함수가 다르다(EXECUTE): 앱 = 연결 · 끊김 · 핑 · 받은 메일 대상 · 승인 대상 · 스윕, admin = 받은 메일 대상 · 끊김,
 * AI 감시 = 작업 대상 · 끊김. 그래서 포트를 롤별로 나눠 만든다(없는 함수를 부르는 객체가 생기지 않게).
 */

import { sqlStateOf, type Queryable } from '../client';
import type { RealtimeConnectionStore, RealtimeConnectOutcome } from '../../realtime/gateway';
import type { RealtimeApprovalTarget, RealtimeInboundTarget, RealtimeTargetStore } from '../../realtime/push';

const CONNECT_OUTCOMES: ReadonlySet<string> = new Set<RealtimeConnectOutcome>(['connected', 'duplicate', 'limit', 'inactive', 'token_invalid']);

interface InboundTargetRow {
  connection_id: string;
  agent_id: string;
  inbound_message_id: string;
  thread_id: string;
  received_at: Date;
  risk_level: string | null;
}

interface ApprovalTargetRow {
  connection_id: string;
  agent_id: string;
  approval_id: string;
  decision: string;
  resolved_at: Date;
  message_ids: string[];
}

function inboundTarget(row: InboundTargetRow): RealtimeInboundTarget {
  return {
    connectionId: row.connection_id,
    agentId: row.agent_id,
    inboundMessageId: row.inbound_message_id,
    threadId: row.thread_id,
    receivedAt: row.received_at,
    riskLevel: row.risk_level,
  };
}

const INBOUND_COLUMNS = 'connection_id, agent_id, inbound_message_id, thread_id, received_at, risk_level';

async function markGone(db: Queryable, connectionId: string): Promise<void> {
  await db.query('SELECT public.atmark_realtime_disconnect($1, $2)', [connectionId, 'gone']);
}

/** 실시간 λ(앱 롤) — 연결 · 끊김 · 핑. */
export function createPostgresRealtimeConnectionStore(db: Queryable): RealtimeConnectionStore {
  return {
    async connect(input): Promise<RealtimeConnectOutcome> {
      const result = await db.query<{ outcome: string }>('SELECT public.atmark_realtime_connect($1, $2, $3) AS outcome', [
        input.connectionId,
        input.agentId,
        input.tokenHash,
      ]);
      const outcome = result.rows[0]?.outcome;
      if (outcome === undefined || !CONNECT_OUTCOMES.has(outcome)) throw new Error(`atmark_realtime_connect: 모르는 결과 ${String(outcome)}`);
      return outcome as RealtimeConnectOutcome;
    },
    async disconnect(connectionId: string): Promise<void> {
      await db.query('SELECT public.atmark_realtime_disconnect($1, $2)', [connectionId, 'disconnect']);
    },
    async seen(connectionId: string): Promise<void> {
      await db.query('SELECT public.atmark_realtime_seen($1)', [connectionId]);
    },
  };
}

/** 받은 메일이 보이게 된 쪽(앱 롤의 수신 소비자 · admin 의 풀기) — 받은 메일 대상 + 410. */
export function createPostgresRealtimeInboundTargets(db: Queryable): RealtimeTargetStore {
  return {
    async inboundTargets(inboundMessageIds: readonly string[]): Promise<readonly RealtimeInboundTarget[]> {
      const result = await db.query<InboundTargetRow>(`SELECT ${INBOUND_COLUMNS} FROM public.atmark_realtime_inbound_targets($1::uuid[])`, [
        [...inboundMessageIds],
      ]);
      return result.rows.map(inboundTarget);
    },
    markGone: (connectionId) => markGone(db, connectionId),
  };
}

/** api λ(앱 롤 — 승인 링크) — 승인 대상 + 410. */
export function createPostgresRealtimeApprovalTargets(db: Queryable): RealtimeTargetStore {
  return {
    async approvalTargets(approvalId: string): Promise<readonly RealtimeApprovalTarget[]> {
      const result = await db.query<ApprovalTargetRow>(
        'SELECT connection_id, agent_id, approval_id, decision, resolved_at, message_ids FROM public.atmark_realtime_approval_targets($1)',
        [approvalId],
      );
      return result.rows.map((row) => ({
        connectionId: row.connection_id,
        agentId: row.agent_id,
        approvalId: row.approval_id,
        decision: row.decision,
        resolvedAt: row.resolved_at,
        messageIds: row.message_ids,
      }));
    },
    markGone: (connectionId) => markGone(db, connectionId),
  };
}

/** AI 감시 결과 λ(`atmark_ai_watch`) — 작업 대상 + 410. */
export function createPostgresRealtimeJobTargets(db: Queryable): RealtimeTargetStore {
  return {
    async jobTargets(jobId: string): Promise<readonly RealtimeInboundTarget[]> {
      const result = await db.query<InboundTargetRow>(`SELECT ${INBOUND_COLUMNS} FROM public.atmark_realtime_job_targets($1)`, [jobId]);
      return result.rows.map(inboundTarget);
    },
    markGone: (connectionId) => markGone(db, connectionId),
  };
}

/** approval-expiry 틱(앱 롤) — 만료 · 핑 없는 행 닫기 · 7일 넘게 닫힌 행 지우기. **마이그레이션 전(함수 없음 42883)이면 `null`**(`injection-signal-retention.ts` 와 같은 규율). */
export interface RealtimeConnectionRetention {
  sweep(): Promise<{ readonly closed: number; readonly purged: number } | null>;
}

export function createPostgresRealtimeConnectionRetention(db: Queryable): RealtimeConnectionRetention {
  return {
    async sweep() {
      try {
        const result = await db.query<{ closed: number; purged: number }>('SELECT closed, purged FROM public.atmark_realtime_sweep()');
        const row = result.rows[0];
        return { closed: row?.closed ?? 0, purged: row?.purged ?? 0 };
      } catch (error) {
        if (sqlStateOf(error) === '42883') return null;
        throw error;
      }
    },
  };
}
