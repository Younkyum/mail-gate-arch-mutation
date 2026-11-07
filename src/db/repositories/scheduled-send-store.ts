/**
 * src/db/repositories/scheduled-send-store.ts — `scheduled_sends` (P3c, 예약 발송).
 *
 * 세 쪽이 쓴다:
 *   - 생성 라우트(`api/routes/scheduled-messages.ts`) — `create`. **판정하지 않는다.**
 *   - 워커(`workers/scheduled-sender.ts`) — `claimDue` → (관문) → `markDispatched`.
 *   - 조회·취소 라우트(`api/routes/scheduled-queries.ts`, 메일 기본기 A3) — `listForAgent` · `findForAgent` · `cancel`.
 *   - 콘솔 취소 라우트(`admin/routes/scheduled.ts`, 메일 기본기 1차 Y2) — `cancelScheduledFromConsole`(정의자 함수 하나, 202609260125).
 *
 * **판정 컬럼이 없다**(마이그레이션 202609230310 머리말) — 관문 평가는 발송 시점의 일이다. 이 파일에도 정책을
 * 읽는 코드가 없다.
 *
 * **임대(lease) + 펜싱.** `claimDue` 는 `attempt_count` 를 먼저 올리고 `lease_expires_at` 을 민다(`FOR UPDATE SKIP
 * LOCKED`). 보내다 죽으면 임대가 풀린 뒤 다시 집히고, 그때 워커는 **같은 멱등 키**(`scheduled:{id}`)로
 * `prepareOutbound` 를 부르므로 `messages` 가 재생(replay)을 돌려준다 — 두 번 나가지 않는다. 결과 기록은
 * `(id, attempt_count)` 로 펜싱한다: 임대를 잃은 워커의 늦은 기록은 0행이다.
 *
 * **취소와 워커의 경합**(계획 R6). `cancel` 은 한 트랜잭션에서 행을 `FOR UPDATE` 로 잡고, 임대가 살아 있거나 `scheduled:{id}` 발송행이
 * 이미 있으면 `in_flight` 로 물러난다. 임대(`LEASE_TTL_SECONDS` 300s)가 워커 타임아웃(50s)보다 길므로 "임대가 풀렸다" 는 곧 "잡던 워커가
 * 끝났다(죽었다)" 이고, 그 워커가 `prepareOutbound` 까지 갔으면 발송행이 남는다 — 둘 다 없을 때만 취소한다. 반대 방향: 취소가 행을 쥔
 * 동안 `claimDue` 는 `SKIP LOCKED` 로 건너뛰고, 커밋 뒤에는 `status = 'scheduled'` 가 아니라 집지 않는다. 늦은 `markDispatched` 도
 * 같은 조건이라 0행이다(펜싱).
 */

import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../client';
import type { AgentId, CancelReasonCode, ScheduledCancelChannel, ScheduledCancelledVia, ScheduledSendStatus } from '../schema';

/** 집어 간 뒤 이 횟수를 넘기면 포기한다(본문 손상 등 재시도로 낫지 않는 실패의 무한 루프 방지). */
export const MAX_SCHEDULED_ATTEMPTS = 5;

export interface ScheduledSendInsert {
  /** 호출자가 만든 uuid — 본문 객체를 **먼저** 이 id 로 쓰고 행을 만든다(행이 있으면 본문도 있다). */
  readonly id: string;
  readonly agentId: AgentId;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly fromAddress: string;
  readonly recipients: readonly string[];
  readonly sendAt: Date;
  readonly contentStorageKey: string;
  readonly traceId: string | null;
  readonly costCents: number;
  /** 생성 때만 정한다(불변). `false` 면 에이전트 토큰(HTTP·MCP)으로 취소할 수 없다 — 소유자 콘솔만(메일 기본기 A3 완화 ④). 생략 = `true`(DB 기본값). */
  readonly agentCancellable?: boolean;
  /**
   * 만들 때 고정한 위험(ADR-0016 리뷰 H1 — `scheduled_sends.risk_tainted` · `risk_dlp`, 불변). 발송 워커가 그때의 판정과 합친다. 생략 = 위험 없음
   * (테스트 지반 — 운영 경로 `routes/scheduled-messages.ts` 는 언제나 채운다).
   */
  readonly risk?: { readonly tainted: boolean; readonly dlp: readonly string[] };
}

export interface ScheduledSendRecord {
  readonly id: string;
  readonly agentId: AgentId;
  readonly requestHash: string;
  readonly fromAddress: string;
  readonly recipients: readonly string[];
  readonly sendAt: Date;
  readonly traceId: string | null;
  readonly costCents: number;
  readonly status: ScheduledSendStatus;
  readonly attemptCount: number;
  readonly dispatchOutcome: string | null;
  readonly messageId: string | null;
  readonly createdAt: Date;
  readonly agentCancellable: boolean;
  readonly cancelledAt: Date | null;
  readonly cancelReasonCode: CancelReasonCode | null;
  /** 소유자에게만 보인다(콘솔). 에이전트 응답·구조화 로그에는 싣지 않는다. */
  readonly cancelNote: string | null;
  /** `console` = 소유자 콘솔(202609260125) — 에이전트 경로(`http`·`mcp`)가 아니다. */
  readonly cancelledVia: ScheduledCancelledVia | null;
  /** 만들 때 고정한 위험(리뷰 H1). 202610041002 전의 행은 false · []. */
  readonly riskTainted: boolean;
  readonly riskDlp: readonly string[];
}

/** 목록 커서 — `(send_at DESC, id DESC)` 의 마지막 행. */
export interface ScheduledListCursor {
  readonly sendAt: Date;
  readonly id: string;
}

export interface ScheduledListQuery {
  readonly status: ScheduledSendStatus | null;
  readonly cursor: ScheduledListCursor | null;
  readonly limit: number;
}

export interface ScheduledCancelInput {
  readonly id: string;
  /** 요청한 에이전트. 다른 에이전트의 예약은 `not_found` 다(존재를 알리지 않는다). */
  readonly agentId: AgentId;
  /** 라우터가 리터럴로 정한 경로 — 행의 `cancelled_via`. */
  readonly channel: ScheduledCancelChannel;
  readonly reasonCode: CancelReasonCode;
  readonly note: string | null;
  readonly now: Date;
  /** 이 에이전트의 최근 1시간 에이전트 취소(`http`·`mcp` 합)가 이 수 이상이면 `rate_limited`. */
  readonly agentHourlyLimit: number;
}

/**
 * 취소 판정 — **순서가 계약이다**(계획 §4 A3 표): 이미 취소 → `replayed` · 발송됨 → `already_dispatched` · 임대 중이거나 발송행 있음 →
 * `in_flight` · `agent_cancellable = false` → `not_agent_cancellable` · 에이전트 시간당 상한 → `rate_limited` · 그 밖 → `cancelled`.
 *
 * **보호는 경로를 가리지 않는다**(1차 수정 리드 결정, 보안 M1): 두 경로(`http`·`mcp`)는 모두 에이전트 토큰이고, 주입 메일이 유도한 취소는
 * 에이전트가 어느 도구를 부르든 같다. 경로 한정이면 토큰을 쥔 에이전트가 HTTP 도구로 우회한다. 우회는 소유자 콘솔뿐이다
 * (`cancelScheduledFromConsole` — 보호 플래그·상한 단계가 없다).
 */
export type ScheduledCancelOutcome =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'replayed'; readonly record: ScheduledSendRecord }
  | { readonly kind: 'already_dispatched' }
  | { readonly kind: 'in_flight' }
  | { readonly kind: 'not_agent_cancellable' }
  | { readonly kind: 'rate_limited' }
  | { readonly kind: 'cancelled'; readonly record: ScheduledSendRecord };

export type ScheduledCreateOutcome =
  | { readonly kind: 'created'; readonly record: ScheduledSendRecord }
  /** 같은 `(agent_id, idempotency_key)` 가 이미 있다. 요청 해시 비교는 호출자가 한다. */
  | { readonly kind: 'existing'; readonly record: ScheduledSendRecord };

export interface ScheduledSendStore {
  create(insert: ScheduledSendInsert): Promise<ScheduledCreateOutcome>;
  /**
   * 기한이 된(`send_at <= now`) 미발송 예약을 집는다. 반환된 `attemptCount` 가 펜싱 토큰이다.
   * `agentId` 를 주면 그 에이전트의 예약만 — 운영 워커는 주지 않는다(전역). 에이전트 하나를 비우는 운영 작업과,
   * 같은 DB 를 병렬로 쓰는 테스트·데모가 **남의 예약을 집어 자기 전송단으로 보내지 않게** 하는 데 쓴다.
   */
  claimDue(
    now: Date,
    limit: number,
    leaseSeconds: number,
    scope?: { readonly agentId: AgentId },
  ): Promise<readonly ScheduledSendRecord[]>;
  /** `false` = 임대를 잃었다(다른 워커가 집었다) — 그쪽이 기록한다. */
  markDispatched(
    id: string,
    attempt: number,
    outcome: string,
    messageId: string | null,
    now: Date,
  ): Promise<boolean>;
  /** 에이전트 하나의 예약, `(send_at DESC, id DESC)`. 호출자가 `limit + 1` 을 넘겨 다음 쪽 유무를 안다. */
  listForAgent(agentId: AgentId, query: ScheduledListQuery): Promise<readonly ScheduledSendRecord[]>;
  /** 그 에이전트의 예약이 아니면 `null` — 남의 id 와 없는 id 를 가르지 않는다. */
  findForAgent(id: string, agentId: AgentId): Promise<ScheduledSendRecord | null>;
  /** 한 트랜잭션 · 행 `FOR UPDATE`. 판정 순서는 `ScheduledCancelOutcome`. */
  cancel(input: ScheduledCancelInput): Promise<ScheduledCancelOutcome>;
}

interface Row {
  id: string;
  agent_id: AgentId;
  request_hash: string;
  from_address: string;
  recipients: string[];
  send_at: Date;
  trace_id: string | null;
  cost_cents: number;
  status: ScheduledSendStatus;
  attempt_count: number;
  dispatch_outcome: string | null;
  message_id: string | null;
  created_at: Date;
  agent_cancellable: boolean;
  cancelled_at: Date | null;
  cancel_reason_code: CancelReasonCode | null;
  cancel_note: string | null;
  cancelled_via: ScheduledCancelledVia | null;
  risk_tainted: boolean;
  risk_dlp: string[];
}

const COLUMNS = `id, agent_id, request_hash, from_address, recipients, send_at, trace_id, cost_cents, status,
                 attempt_count, dispatch_outcome, message_id, created_at,
                 agent_cancellable, cancelled_at, cancel_reason_code, cancel_note, cancelled_via, risk_tainted, risk_dlp`;

/**
 * 워커가 이 예약으로 만드는 발송행의 멱등 키 — `workers/scheduled-sender.ts` `scheduledIdempotencyKey` 와 **같은 모양**이다(이 저장소는
 * 워커를 import 하지 않는다 — 워커가 관문을 import 한다). 두 곳이 같다는 것은 `test/integration/workers/scheduled-cancel-race.test.ts` 가
 * `scheduledIdempotencyKey(id)` 로 만든 발송행이 취소를 `in_flight` 로 돌려보내는지로 확인한다.
 */
const SCHEDULED_IDEMPOTENCY_KEY_SQL = `'scheduled:' || s.id::text`;

function toRecord(row: Row): ScheduledSendRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    requestHash: row.request_hash,
    fromAddress: row.from_address,
    recipients: row.recipients,
    sendAt: row.send_at,
    traceId: row.trace_id,
    costCents: row.cost_cents,
    status: row.status,
    attemptCount: row.attempt_count,
    dispatchOutcome: row.dispatch_outcome,
    messageId: row.message_id,
    createdAt: row.created_at,
    agentCancellable: row.agent_cancellable,
    cancelledAt: row.cancelled_at,
    cancelReasonCode: row.cancel_reason_code,
    cancelNote: row.cancel_note,
    cancelledVia: row.cancelled_via,
    riskTainted: row.risk_tainted,
    riskDlp: row.risk_dlp,
  };
}

export function createPostgresScheduledSendStore(pool: Pool): ScheduledSendStore {
  return {
    async create(insert) {
      const inserted = await pool.query<Row>(
        `INSERT INTO scheduled_sends
           (id, agent_id, idempotency_key, request_hash, from_address, recipients, send_at, content_storage_key,
            trace_id, cost_cents, agent_cancellable, risk_tainted, risk_dlp)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11, $12, $13::text[])
         ON CONFLICT (agent_id, idempotency_key) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          insert.id,
          insert.agentId,
          insert.idempotencyKey,
          insert.requestHash,
          insert.fromAddress,
          [...insert.recipients],
          insert.sendAt,
          insert.contentStorageKey,
          insert.traceId,
          insert.costCents,
          insert.agentCancellable ?? true,
          insert.risk?.tainted ?? false,
          [...(insert.risk?.dlp ?? [])],
        ],
      );
      const created = inserted.rows[0];
      if (created !== undefined) return { kind: 'created', record: toRecord(created) };
      const existing = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM scheduled_sends WHERE agent_id = $1 AND idempotency_key = $2`,
        [insert.agentId, insert.idempotencyKey],
      );
      const row = existing.rows[0];
      if (row === undefined) throw new Error('scheduled_sends 충돌 행이 사라졌다');
      return { kind: 'existing', record: toRecord(row) };
    },

    async claimDue(now, limit, leaseSeconds, scope) {
      const result = await pool.query<Row>(
        `UPDATE scheduled_sends s
            SET attempt_count = s.attempt_count + 1,
                lease_expires_at = $1::timestamptz + make_interval(secs => $3)
          WHERE s.id IN (
                SELECT id FROM scheduled_sends
                 WHERE status = 'scheduled' AND send_at <= $1
                   AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
                   AND ($4::char(32) IS NULL OR agent_id = $4)
                 ORDER BY send_at, id
                 LIMIT $2
                 FOR UPDATE SKIP LOCKED)
          RETURNING ${COLUMNS}`,
        [now, limit, leaseSeconds, scope?.agentId ?? null],
      );
      return result.rows.map(toRecord).sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
    },

    async markDispatched(id, attempt, outcome, messageId, now) {
      const result = await pool.query(
        `UPDATE scheduled_sends
            SET status = 'dispatched', dispatched_at = $4, dispatch_outcome = $3, message_id = $5, lease_expires_at = NULL
          WHERE id = $1 AND attempt_count = $2 AND status = 'scheduled'`,
        [id, attempt, outcome, now, messageId],
      );
      return result.rowCount === 1;
    },

    async listForAgent(agentId, query) {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM scheduled_sends
          WHERE agent_id = $1
            AND ($2::scheduled_send_status IS NULL OR status = $2::scheduled_send_status)
            AND ($3::timestamptz IS NULL OR (send_at, id) < ($3::timestamptz, $4::uuid))
          ORDER BY send_at DESC, id DESC
          LIMIT $5`,
        [agentId, query.status, query.cursor?.sendAt ?? null, query.cursor?.id ?? null, query.limit],
      );
      return result.rows.map(toRecord);
    },

    async findForAgent(id, agentId) {
      const result = await pool.query<Row>(`SELECT ${COLUMNS} FROM scheduled_sends WHERE id = $1 AND agent_id = $2`, [id, agentId]);
      const row = result.rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async cancel(input) {
      return withTransaction(pool, async (client) => {
        // 상한은 "세고 → 쓰기" 라 에이전트별로 줄 세운다 — 경로를 섞은 동시 요청 여섯이 모두 넷을 세고 통과하지 않게. 잠금 순서는
        // 언제나 advisory → 행이다(교착 없음).
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('scheduled_cancel_agent:' || $1::text, 0))`, [input.agentId]);
        const locked = await client.query<Row & { lease_active: boolean; send_row_exists: boolean }>(
          `SELECT ${COLUMNS},
                  (s.lease_expires_at IS NOT NULL AND s.lease_expires_at > $3) AS lease_active,
                  EXISTS (SELECT 1 FROM messages m WHERE m.agent_id = s.agent_id AND m.idempotency_key = ${SCHEDULED_IDEMPOTENCY_KEY_SQL})
                    AS send_row_exists
             FROM scheduled_sends s
            WHERE s.id = $1 AND s.agent_id = $2
            FOR UPDATE OF s`,
          [input.id, input.agentId, input.now],
        );
        const row = locked.rows[0];
        if (row === undefined) return { kind: 'not_found' };
        if (row.status === 'cancelled') return { kind: 'replayed', record: toRecord(row) };
        if (row.status === 'dispatched') return { kind: 'already_dispatched' };
        if (row.lease_active || row.send_row_exists) return { kind: 'in_flight' };
        if (!row.agent_cancellable) return { kind: 'not_agent_cancellable' };
        // 부분 인덱스 `scheduled_sends_agent_cancel_idx`(술어가 이 조건과 글자 그대로 같다)로 센다(새 표 없음).
        const recent = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM scheduled_sends
            WHERE agent_id = $1 AND cancelled_via IN ('http', 'mcp') AND cancelled_at > $2::timestamptz - interval '1 hour'`,
          [input.agentId, input.now],
        );
        if (Number(recent.rows[0]?.count ?? '0') >= input.agentHourlyLimit) return { kind: 'rate_limited' };
        const updated = await client.query<Row>(
          `UPDATE scheduled_sends
              SET status = 'cancelled', cancelled_at = $2, cancel_reason_code = $3, cancel_note = $4, cancelled_via = $5
            WHERE id = $1 AND status = 'scheduled'
            RETURNING ${COLUMNS}`,
          [input.id, input.now, input.reasonCode, input.note, input.channel],
        );
        const cancelled = updated.rows[0];
        // 행을 쥐고 있으므로 0행일 수 없다 — 있으면 판정 순서가 깨진 것이라 던진다(조용히 성공처럼 보이지 않게).
        if (cancelled === undefined) throw new Error('scheduled_sends 취소가 잠근 행을 바꾸지 못했다');
        return { kind: 'cancelled', record: toRecord(cancelled) };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 소유자 콘솔 취소(메일 기본기 1차 Y2 — 진윤겸 결정 2026-09-26)
// ---------------------------------------------------------------------------

export interface ConsoleScheduledCancelInput {
  /** 세션 조직 — 이 조직 에이전트의 예약만 잡힌다(다른 조직·없는 id 는 `not_found`, 둘을 가르지 않는다). 인가는 라우트가 먼저 한다. */
  readonly organizationId: string;
  readonly id: string;
  readonly reasonCode: CancelReasonCode;
  readonly note: string | null;
}

/**
 * 콘솔 취소 판정 — 에이전트 경로(`ScheduledCancelOutcome`)와 **같은 순서**에서 보호 플래그·시간당 상한 두 단계만 없다: 없음 → 이미 취소
 * (`replayed`) → 발송됨 → 임대 중이거나 발송행 있음(`in_flight`) → `cancelled`(경로 `console`).
 */
export type ConsoleScheduledCancelOutcome =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'already_dispatched' }
  | { readonly kind: 'in_flight' }
  | {
      readonly kind: 'replayed' | 'cancelled';
      readonly cancelledAt: Date;
      readonly reasonCode: CancelReasonCode;
      readonly cancelledVia: ScheduledCancelledVia;
    };

/**
 * 정의자 함수 `console_cancel_scheduled_send`(202609260125) 한 번 — admin 롤은 `scheduled_sends` 에 쓰기 권한이 없고 이 함수 EXECUTE 만
 * 있다. 판정·행 잠금·경로 리터럴은 함수 안에 있다. 호출자의 트랜잭션(감사 행과 같은 것)에서 돈다 — 이 함수는 트랜잭션을 열지 않는다.
 */
export async function cancelScheduledFromConsole(db: Queryable, input: ConsoleScheduledCancelInput): Promise<ConsoleScheduledCancelOutcome> {
  const result = await db.query<{
    outcome: string;
    result_cancelled_at: Date | null;
    result_reason_code: CancelReasonCode | null;
    result_cancelled_via: ScheduledCancelledVia | null;
  }>(
    `SELECT outcome, result_cancelled_at, result_reason_code, result_cancelled_via
       FROM console_cancel_scheduled_send($1::uuid, $2::uuid, $3, $4)`,
    [input.organizationId, input.id, input.reasonCode, input.note],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('console_cancel_scheduled_send 가 행을 돌려주지 않았다');
  switch (row.outcome) {
    case 'not_found':
    case 'already_dispatched':
    case 'in_flight':
      return { kind: row.outcome };
    case 'replayed':
    case 'cancelled':
      if (row.result_cancelled_at === null || row.result_reason_code === null || row.result_cancelled_via === null) {
        throw new Error('console_cancel_scheduled_send 취소 칸이 비었다');
      }
      return { kind: row.outcome, cancelledAt: row.result_cancelled_at, reasonCode: row.result_reason_code, cancelledVia: row.result_cancelled_via };
    default:
      throw new Error(`console_cancel_scheduled_send 가 모르는 결과를 돌려줬다: ${row.outcome}`);
  }
}
