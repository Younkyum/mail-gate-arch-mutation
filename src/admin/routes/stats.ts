/**
 * src/admin/routes/stats.ts — 개요 통계 줄(콘솔 v4 E10, 계약 `.omc/handoffs/console-v4-api.md` §4):
 *   `GET /api/stats?days=1|7|30[&agent={agentId}]` → `{days, since, agentId, outbound:{…}, inbound:{…}, byAgent?}`
 *
 * **조직 범위와 판정은 로그 API 와 같은 SQL 조각이다**(`routes/logs.ts` — `OUTBOUND_DECISION_SQL` · `ORG_SCOPE_CTE` · `REJECTION_VISIBLE_SQL`).
 * 숫자가 로그 목록과 어긋나지 않게 복사하지 않고 가져온다. 발신은 세션 조직의 에이전트에서 출발하고, 수신 거부(에이전트 칸 없음)는 이 조직
 * 주소와 봉투 수신자가 겹치고 그 주소가 생긴 뒤 받은 행만 센다. `agent` 필터는 먼저 `requireAgentInOrganization`(다른 조직 → 404).
 *
 * 비용: 캐시 없음. **조직당 한 번에 하나**(L2 — 증명 슬롯 `routes/integrity.ts` `lockProofSlot` 과 같은 모양: `pg_try_advisory_xact_lock`,
 * 인스턴스를 넘어 DB 가 센다, 기다리지 않고 429 `rate_limited`) — 한 조직이 admin 동시성을 통계 계산으로 다 쓰지 못하게. 발신·수신은 로그 목록의 색인(`messages (agent_id, created_at DESC, id DESC) WHERE direction='outbound'` ·
 * `inbound_messages (agent_id, received_at DESC, id DESC)`, 202609241100)을 에이전트마다 창(`since`)까지만 탄다. 에이전트 상한 10.
 * 세지 않는 것: 본문·주소·제목(숫자만 싣는다).
 */

import { withTransaction, type Queryable } from '../../db/client';
import { requireAgentInOrganization, sessionOf, type AdminCall } from '../context';
import { jsonResponse, type AdminResponse } from '../http';
import { AdminInputError } from '../ops/errors';
import { ORG_SCOPE_CTE, OUTBOUND_DECISION_SQL, OUTBOUND_DECISIONS, REJECTION_VISIBLE_SQL } from './logs';

/** 받는 창(일). 개요 줄은 7, 나머지는 화면 선택지. */
const STATS_DAYS = [1, 7, 30] as const;
const DEFAULT_STATS_DAYS = 7;

const DAY_MS = 86_400_000;

type OutboundDecision = (typeof OUTBOUND_DECISIONS)[number];

interface OutboundCounts {
  total: number;
  sent: number;
  denied: number;
  pending: number;
  failed: number;
  sending: number;
  queued: number;
}

function parseDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_STATS_DAYS;
  const days = Number(raw);
  if (!/^\d{1,2}$/.test(raw) || !(STATS_DAYS as readonly number[]).includes(days)) {
    throw new AdminInputError(`days 는 ${STATS_DAYS.join(' | ')} 다.`, 'invalid_days');
  }
  return days;
}

/** 조직당 통계 계산 하나 — 잠금은 트랜잭션이 끝나면 풀린다. 잡지 못하면 기다리지 않고 429. */
async function lockStatsSlot(tx: Queryable, organizationId: string): Promise<void> {
  const got = await tx.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtextextended('admin_stats:' || $1::text, 0)) AS ok`, [organizationId]);
  if (got.rows[0]?.ok !== true) throw new AdminInputError('이 조직의 통계 요청이 이미 돌고 있다 — 잠시 뒤 다시 시도하라.', 'rate_limited', 429);
}

/** `GET /api/stats` */
export async function handleStats(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const days = parseDays(call.request.query['days']);
  const agentId = call.request.query['agent'] === undefined ? null : await requireAgentInOrganization(call.deps.pool, session, call.request.query['agent']);
  const body = await withTransaction(call.deps.pool, async (tx) => {
    await lockStatsSlot(tx, session.organizationId);
    return statsBody(tx, session.organizationId, days, agentId, call.deps.now());
  });
  return jsonResponse(200, body);
}

async function statsBody(db: Queryable, organizationId: string, days: number, agentId: string | null, now: Date): Promise<Record<string, unknown>> {
  const since = new Date(now.getTime() - days * DAY_MS);
  const values: unknown[] = [organizationId, since];
  const agentClause = agentId === null ? '' : 'AND ag.id = $3';
  if (agentId !== null) values.push(agentId);

  const outbound = await db.query<{ agent_id: string; decision: OutboundDecision; n: number }>(
    `SELECT m.agent_id, d.decision, count(*)::int AS n
       FROM agents ag
       JOIN messages m ON m.agent_id = ag.id AND m.direction = 'outbound' AND m.created_at >= $2
       LEFT JOIN LATERAL (
         SELECT al.decision::text AS decision FROM audit_logs al WHERE al.message_id = m.id ORDER BY al.created_at DESC, al.id DESC LIMIT 1
       ) a ON true
       CROSS JOIN LATERAL (SELECT ${OUTBOUND_DECISION_SQL} AS decision) d
      WHERE ag.organization_id = $1 ${agentClause}
      GROUP BY m.agent_id, d.decision`,
    values,
  );
  const inbound = await db.query<{ agent_id: string; quarantined: boolean; n: number }>(
    `SELECT i.agent_id, i.quarantined, count(*)::int AS n
       FROM agents ag
       JOIN inbound_messages i ON i.agent_id = ag.id AND i.received_at >= $2
      WHERE ag.organization_id = $1 ${agentClause}
      GROUP BY i.agent_id, i.quarantined`,
    values,
  );
  const rejected = await db.query<{ n: number }>(
    `WITH ${ORG_SCOPE_CTE(agentClause)}
     SELECT count(*)::int AS n FROM inbound_rejections r
      WHERE r.envelope_recipients && (SELECT coalesce(array_agg(address), '{}') FROM org_addresses)
        AND ${REJECTION_VISIBLE_SQL} AND r.received_at >= $2`,
    values,
  );

  const out: OutboundCounts = { total: 0, sent: 0, denied: 0, pending: 0, failed: 0, sending: 0, queued: 0 };
  for (const row of outbound.rows) {
    out.total += row.n;
    out[row.decision] += row.n;
  }
  const delivered = inbound.rows.filter((row) => !row.quarantined).reduce((sum, row) => sum + row.n, 0);
  const quarantined = inbound.rows.filter((row) => row.quarantined).reduce((sum, row) => sum + row.n, 0);
  const rejectedCount = rejected.rows[0]?.n ?? 0;
  const body: Record<string, unknown> = {
    days,
    since: since.toISOString(),
    agentId,
    outbound: out,
    inbound: { total: delivered + quarantined + rejectedCount, delivered, quarantined, rejected: rejectedCount },
  };

  if (agentId === null) {
    const agents = await db.query<{ id: string }>('SELECT id FROM agents WHERE organization_id = $1 ORDER BY created_at, id', [organizationId]);
    body['byAgent'] = agents.rows.map((agent) => ({
      agentId: agent.id,
      sent: outbound.rows.filter((row) => row.agent_id === agent.id && row.decision === 'sent').reduce((sum, row) => sum + row.n, 0),
      received: inbound.rows.filter((row) => row.agent_id === agent.id).reduce((sum, row) => sum + row.n, 0),
    }));
  }
  return body;
}
