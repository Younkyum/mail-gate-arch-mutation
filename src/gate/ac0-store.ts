/**
 * src/gate/ac0-store.ts — AC-0 게이트의 DB 읽기·쓰기 (계획 §3.2, AC-b3~b6).
 *
 * `src/observability/ac0-metrics.ts` 가 DB 를 읽을 수 없으므로(arch 규칙 — 그 파일 머리말) 조회가 여기 있다.
 *
 * **쓰기는 세 테이블에 INSERT 뿐이다**(`202609230100_ac0_gate.sql` — append-only). 기록 시각은 전부 DB 의
 * `now()` 다 — 이 모듈의 쓰기 함수는 시각 인자를 받지 않는다. 소급 기록 경로를 코드에 두지 않는다.
 *
 * **읽기는 판정의 원자료를 그대로 가져온다.** 전달 판정(`forwarded.ts`)과 활동 분모(`ac0-metrics.ts`)는
 * TS 에서 계산한다 — 판정식이 실측으로 바뀌면 SQL 이 아니라 그 함수 하나가 바뀌어야 하고, 과거 행에도
 * 소급돼야 하기 때문이다.
 */

import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../db/client';
import { selectRow, selectRows } from '../db/repositories/rows';
import type { AgentId } from '../db/schema';
import type { Ac0Window, RecipientFirstSentFact, SentMessageFact, ThreadMessageFact } from '../observability/ac0-metrics';
import type { ForwardedEvidence } from './forwarded';
import { Ac0InputError, type GateEvent, type InterventionCategory, type InterventionRecord, type RestartCause } from './ac0-verdict';

export interface Ac0Gate {
  readonly id: string;
  readonly organizationId: string;
  /** `null` = 조직 전체. */
  readonly agentId: AgentId | null;
  readonly humanMailboxes: readonly string[];
  readonly createdAt: Date;
}

interface GateRow {
  id: string;
  organization_id: string;
  agent_id: string | null;
  human_mailboxes: string[];
  created_at: Date;
}

function toGate(row: GateRow): Ac0Gate {
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id as AgentId | null,
    humanMailboxes: row.human_mailboxes,
    createdAt: row.created_at,
  };
}

const GATE_COLUMNS = 'id, organization_id, agent_id, human_mailboxes, created_at';

export async function dbNow(db: Queryable): Promise<Date> {
  const row = await selectRow<{ now: Date }>(db, 'SELECT now() AS now');
  if (row === null) throw new Error('SELECT now() 가 행을 돌려주지 않았다');
  return row.now;
}

// ---------------------------------------------------------------------------
// 게이트
// ---------------------------------------------------------------------------

export interface CreateAc0GateInput {
  /** 에이전트 범위. `organizationId` 와 둘 중 하나. */
  readonly agentId: AgentId | null;
  readonly organizationId: string | null;
  readonly humanMailboxes: readonly string[];
  /** 1일차 00:00 KST. DB CHECK 가 자정·미래를 집행한다. */
  readonly day1At: Date;
}

/** 게이트 + start 이벤트를 한 트랜잭션에서. start 없는 게이트는 판정 불가(exit 2)이므로 둘은 같이 태어난다. */
export async function createAc0Gate(pool: Pool, input: CreateAc0GateInput): Promise<Ac0Gate> {
  return withTransaction(pool, async (client) => {
    let organizationId = input.organizationId;
    if (input.agentId !== null) {
      const agentOrganization = await loadAgentOrganization(client, input.agentId);
      if (agentOrganization === null) throw new Ac0InputError(`에이전트 ${input.agentId} 가 없다.`);
      if (organizationId !== null && organizationId !== agentOrganization) {
        throw new Ac0InputError('에이전트가 지정한 조직에 속하지 않는다.');
      }
      organizationId = agentOrganization;
    }
    if (organizationId === null) throw new Ac0InputError('--agent 또는 --org 중 하나가 필요하다.');

    const gate = await selectRow<GateRow>(
      client,
      `INSERT INTO ac0_gates (organization_id, agent_id, human_mailboxes)
       VALUES ($1, $2, $3::text[]) RETURNING ${GATE_COLUMNS}`,
      [organizationId, input.agentId, [...input.humanMailboxes]],
    );
    if (gate === null) throw new Error('ac0_gates INSERT 가 행을 돌려주지 않았다');
    await client.query(
      `INSERT INTO ac0_gate_events (gate_id, kind, effective_at, return_day) VALUES ($1, 'start', $2, 1)`,
      [gate.id, input.day1At],
    );
    return toGate(gate);
  });
}

export async function loadAc0Gate(db: Queryable, gateId: string): Promise<Ac0Gate | null> {
  const row = await selectRow<GateRow>(db, `SELECT ${GATE_COLUMNS} FROM ac0_gates WHERE id = $1`, [gateId]);
  return row === null ? null : toGate(row);
}

/** 에이전트의 조직(게이트 없이 도는 `ac0:probe` 용). 없으면 `null`. */
export async function loadAgentOrganization(db: Queryable, agentId: AgentId): Promise<string | null> {
  const row = await selectRow<{ organization_id: string }>(db, 'SELECT organization_id FROM agents WHERE id = $1', [agentId]);
  return row?.organization_id ?? null;
}

export async function listAc0Gates(db: Queryable, organizationId: string | null = null): Promise<Ac0Gate[]> {
  const rows = await selectRows<GateRow>(
    db,
    `SELECT ${GATE_COLUMNS} FROM ac0_gates
      WHERE $1::uuid IS NULL OR organization_id = $1
      ORDER BY created_at DESC, id`,
    [organizationId],
  );
  return rows.map(toGate);
}

// ---------------------------------------------------------------------------
// 이벤트 · 개입 (쓰기 — 시각 인자 없음)
// ---------------------------------------------------------------------------

export async function recordForwarding(db: Queryable, gateId: string, state: 'on' | 'off'): Promise<Date> {
  const row = await selectRow<{ recorded_at: Date }>(
    db,
    `INSERT INTO ac0_gate_events (gate_id, kind) VALUES ($1, $2::ac0_gate_event_kind) RETURNING recorded_at`,
    [gateId, state === 'on' ? 'forwarding_on' : 'forwarding_off'],
  );
  if (row === null) throw new Error('ac0_gate_events INSERT 가 행을 돌려주지 않았다');
  return row.recorded_at;
}

export async function recordIntervention(
  db: Queryable,
  gateId: string,
  category: InterventionCategory,
  reason: string,
): Promise<Date> {
  const row = await selectRow<{ recorded_at: Date }>(
    db,
    `INSERT INTO human_mailbox_interventions (gate_id, category, reason)
     VALUES ($1, $2::human_mailbox_intervention_category, $3) RETURNING recorded_at`,
    [gateId, category, reason],
  );
  if (row === null) throw new Error('human_mailbox_interventions INSERT 가 행을 돌려주지 않았다');
  return row.recorded_at;
}

export async function recordRestart(
  db: Queryable,
  gateId: string,
  returnDay: 1 | 8,
  cause: RestartCause,
  effectiveAt: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO ac0_gate_events (gate_id, kind, effective_at, return_day, cause)
     VALUES ($1, 'restart', $2, $3, $4)`,
    [gateId, effectiveAt, returnDay, cause],
  );
}

// ---------------------------------------------------------------------------
// 읽기 — 판정 원자료
// ---------------------------------------------------------------------------

interface EventRow {
  kind: GateEvent['kind'];
  recorded_at: Date;
  effective_at: Date | null;
  return_day: number | null;
  cause: string | null;
}

export async function loadGateEvents(db: Queryable, gateId: string): Promise<GateEvent[]> {
  const rows = await selectRows<EventRow>(
    db,
    `SELECT kind, recorded_at, effective_at, return_day, cause
       FROM ac0_gate_events WHERE gate_id = $1 ORDER BY recorded_at, id`,
    [gateId],
  );
  return rows.map((row): GateEvent => {
    if (row.kind === 'start') return { kind: 'start', recordedAt: row.recorded_at, effectiveAt: row.effective_at as Date };
    if (row.kind === 'restart') {
      return {
        kind: 'restart',
        recordedAt: row.recorded_at,
        effectiveAt: row.effective_at as Date,
        returnDay: row.return_day === 8 ? 8 : 1,
        cause: row.cause as RestartCause,
      };
    }
    return { kind: row.kind, recordedAt: row.recorded_at };
  });
}

export async function loadInterventions(db: Queryable, gateId: string): Promise<InterventionRecord[]> {
  const rows = await selectRows<{ recorded_at: Date; category: InterventionCategory; reason: string }>(
    db,
    `SELECT recorded_at, category, reason FROM human_mailbox_interventions WHERE gate_id = $1 ORDER BY recorded_at, id`,
    [gateId],
  );
  return rows.map((row) => ({ recordedAt: row.recorded_at, category: row.category, reason: row.reason }));
}

/** 범위 조건. `$1` = organization_id, `$2` = agent_id(NULL 이면 조직 전체). */
const SCOPE = `a.organization_id = $1 AND ($2::char(32) IS NULL OR a.id = $2)`;

export interface InboundEvidenceRow extends ForwardedEvidence {
  readonly id: string;
  readonly receivedAt: Date;
}

/** 판정 범위 — 게이트, 또는 게이트 전의 실측(`ac0:probe --agent`)용 임시 범위. */
export type Ac0Scope = Pick<Ac0Gate, 'organizationId' | 'agentId'>;

/** 범위의 수신 메일 원자료 — 전달 판정에 필요한 컬럼만(본문 없음). `[from, to)`. */
export async function loadInboundEvidence(
  db: Queryable,
  gate: Ac0Scope,
  from: Date,
  to: Date,
  limit: number | null = null,
): Promise<InboundEvidenceRow[]> {
  const rows = await selectRows<{
    id: string;
    received_at: Date;
    envelope_sender: string | null;
    from_address: string;
    forwarded_for_header: string | null;
    forwarded_to_header: string | null;
    envelope_recipient: string;
  }>(
    db,
    `SELECT i.id, i.received_at, i.envelope_sender, i.from_address, i.forwarded_for_header,
            i.forwarded_to_header, i.envelope_recipient
       FROM inbound_messages i JOIN agents a ON a.id = i.agent_id
      WHERE ${SCOPE} AND i.received_at >= $3 AND i.received_at < $4
      ORDER BY i.received_at DESC, i.id
      LIMIT $5`,
    [gate.organizationId, gate.agentId, from, to, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    receivedAt: row.received_at,
    envelopeSender: row.envelope_sender,
    fromAddress: row.from_address,
    forwardedForHeader: row.forwarded_for_header,
    forwardedToHeader: row.forwarded_to_header,
    envelopeRecipient: row.envelope_recipient,
  }));
}

/** 범위 에이전트들의 주소 도메인(`atmark.ai` 등) — "외부 상대" 에서 뺀다. */
export async function loadAgentDomains(db: Queryable, gate: Ac0Gate): Promise<string[]> {
  const rows = await selectRows<{ domain: string }>(
    db,
    `SELECT DISTINCT d.domain FROM agent_addresses d JOIN agents a ON a.id = d.agent_id
      WHERE a.organization_id = $1 ORDER BY d.domain`,
    [gate.organizationId],
  );
  return rows.map((row) => row.domain);
}

/**
 * **어느 조직이든 에이전트 전용으로 쥔 고객 도메인**(ADR-0014) — 수신 판정(`domainAcceptsInboundOf`)과 같은 표: verified 또는
 * suspended(reputation · operator · plan_limit), 보안 리뷰 L2. ownership_lost · dkim_failed 는 뺀다 — 소유를 잃은 도메인은 이미
 * 다른 이의 메일일 수 있다. 쥔 도메인의 주소는 사람이 될 수 없으므로(결정 8) `atmark.ai` 처럼 다른 조직의 고객 도메인 에이전트도
 * AC-0 의 "거래 상대" 가 아니다.
 */
export async function loadHeldCustomerDomains(db: Queryable): Promise<string[]> {
  const rows = await selectRows<{ domain: string }>(
    db,
    `SELECT DISTINCT d.domain FROM custom_domains d
      WHERE d.status = 'verified' OR (d.status = 'suspended' AND d.suspended_reason IN ('reputation', 'operator', 'plan_limit'))
      ORDER BY d.domain`,
    [],
  );
  return rows.map((row) => row.domain);
}

export interface ActivityRows {
  readonly sentMessages: SentMessageFact[];
  readonly recipientFirstSent: RecipientFirstSentFact[];
  readonly threadMessages: ThreadMessageFact[];
}

/**
 * 반송·거부된 발송 제외 조건(V3 H2①). `status='sent'` 는 SES 가 받았다는 뜻일 뿐 상대에게 닿았다는 뜻이 아니다.
 * `ses_events` 는 ADR-0004 조인 키(우리 `messages.id`)만 알고 **수신자 주소를 담지 않는다** — 그래서 수신자
 * 단위가 아니라 **발송 단위**로 뺀다: bounce/reject 이벤트가 하나라도 있으면 그 발송과 수신자 전원이 분모에서
 * 빠진다. 여러 수신자 중 한 명만 반송돼도 전부 빠지는 과소 계상이고, 그 방향이 안전하다(통과를 막는 쪽).
 * bounce 유형(영구·일시)도 저장되지 않으므로 구분하지 않는다.
 */
const DELIVERED = `NOT EXISTS (SELECT 1 FROM ses_events e WHERE e.message_id = m.id AND e.event_type IN ('bounce', 'reject'))`;

/**
 * 활동 분모의 원자료(AC-b5). **성공 발송만**(`status='sent'`, 시각 = `sent_at`, 반송·거부 이벤트 없음) —
 * 시도·거부·실패·반송은 일이 아니다.
 *
 *   - sentMessages       : 창 안의 성공 발송과 수신자 전원
 *   - recipientFirstSent : 범위 **전체 이력**의 원 주소별 첫 성공 발송 시각(창 필터 없음). "처음" 은 정규화 주소
 *                          단위로 판정해야 하는데(`bob+1`·`bob+2` 는 한 상대) 정규화는 TS(`contactKey`)에 있으므로,
 *                          원 주소별 최소값을 전부 가져와 `computeAc0Activity` 가 키로 접는다.
 *   - threadMessages     : 창 안의 권한용 스레드 메시지(성공 발송 + 수신). 수신은 From·자동응답 여부 포함
 */
export async function loadActivityRows(db: Queryable, gate: Ac0Gate, window: Ac0Window): Promise<ActivityRows> {
  const params = [gate.organizationId, gate.agentId, window.start, window.end];

  const sent = await selectRows<{ sent_at: Date; recipients: (string | null)[] }>(
    db,
    `SELECT m.sent_at, array_agg(r.address) AS recipients
       FROM messages m JOIN agents a ON a.id = m.agent_id
       LEFT JOIN outbound_recipients r ON r.message_id = m.id
      WHERE ${SCOPE} AND m.direction = 'outbound' AND m.status = 'sent' AND ${DELIVERED}
        AND m.sent_at >= $3 AND m.sent_at < $4
      GROUP BY m.id, m.sent_at`,
    params,
  );

  const firstSent = await selectRows<{ address: string; first_sent_at: Date }>(
    db,
    `SELECT r.address, min(m.sent_at) AS first_sent_at
       FROM outbound_recipients r
       JOIN messages m ON m.id = r.message_id
       JOIN agents a ON a.id = m.agent_id
      WHERE ${SCOPE} AND m.direction = 'outbound' AND m.status = 'sent' AND ${DELIVERED}
        AND m.sent_at < $3
      GROUP BY r.address`,
    [gate.organizationId, gate.agentId, window.end],
  );

  const thread = await selectRows<{
    thread_id: string;
    direction: 'outbound' | 'inbound';
    occurred_at: Date;
    automated: boolean;
    inbound_from: string | null;
  }>(
    db,
    `SELECT m.thread_id, 'outbound' AS direction, m.sent_at AS occurred_at, false AS automated, NULL::text AS inbound_from
       FROM messages m JOIN agents a ON a.id = m.agent_id
      WHERE ${SCOPE} AND m.direction = 'outbound' AND m.status = 'sent' AND m.thread_id IS NOT NULL AND ${DELIVERED}
        AND m.sent_at >= $3 AND m.sent_at < $4
     UNION ALL
     SELECT i.thread_id, 'inbound', i.received_at, i.auto_submitted, i.from_address
       FROM inbound_messages i JOIN agents a ON a.id = i.agent_id
      WHERE ${SCOPE} AND i.received_at >= $3 AND i.received_at < $4`,
    params,
  );

  return {
    sentMessages: sent.map((row) => ({
      sentAt: row.sent_at,
      recipients: row.recipients.filter((address): address is string => address !== null),
    })),
    recipientFirstSent: firstSent.map((row) => ({ address: row.address, firstSentAt: row.first_sent_at })),
    threadMessages: thread.map((row) => ({
      threadId: row.thread_id,
      direction: row.direction,
      occurredAt: row.occurred_at,
      automated: row.automated,
      inboundFrom: row.inbound_from,
    })),
  };
}
