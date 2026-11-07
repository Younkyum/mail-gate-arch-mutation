/**
 * src/db/repositories/message-state-store.ts — 받은 메일의 **에이전트 상태**(라벨 · 처음 읽은 시각 — `inbound_message_state`, 202610081200)와
 * 응답의 **`risk` 재료**(묶음 B).
 *
 * ★ 이 파일의 `inbound_messages` 조회는 전부 `visibleToAgent(...)` 를 건다 — 격리 메일은 라벨을 붙일 수도, 라벨 목록에 셀 수도, 위험 재료로 읽을 수도
 *   없다(없는 메일과 같다). `test/arch/inbound-visibility.arch.test.ts` ①-b 가 이 파일의 SQL 을 훑는다.
 *
 * **위험 재료**(`riskFacts`) — 목록 · 상세 · 스레드가 이미 보여 준 메일 id 들의 격리 사실 · 스캐너 판정 · 적중(계열 · 완화) · 신뢰 발신자 우회를 한 번에
 * 읽는다. 등급은 `security/levels.ts` `classifyInboundLevel` 이 매긴다(이 파일은 사실만). 적중은 노출 기록(`exposure-store.ts`)과 같은 읽기다(같은
 * 스캐너 판의 `security_findings`).
 *
 * **신뢰 발신자 우회 칸**(`trusted_bypass`)은 묶음 A 가 `inbound_messages` 에 더한다(2026100810xx). 이 파일은 그 칸이 **없어도** 돌게 한 곳에서만 읽는다
 * (`trustedBypassColumn` — 묶음 A 의 `inbound_messages.trusted_bypass`).
 */

import type { ReleasedFrom } from '../../security/levels';
import type { Pool, PoolClient } from 'pg';

import type { AgentId, InjectionRisk } from '../schema';
import type { RuleFamily } from '../../security/injection/rule-types';
import type { QuarantineReason } from '../../security/levels';
import { withTransaction } from '../client';
import { visibleToAgent } from './inbound-read-store';
import { selectRows } from './rows';

/** 라벨 모양 — DB CHECK(`inbound_message_state_labels_check`)와 같다. */
export const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_LABELS_PER_MESSAGE = 20;
export const MAX_DISTINCT_LABELS_PER_AGENT = 200;

/** 한 메일의 위험 재료 + 상태. */
export interface MessageFacts {
  readonly id: string;
  readonly quarantined: boolean;
  readonly quarantineReason: QuarantineReason | null;
  readonly injectionRisk: InjectionRisk | null;
  readonly findings: readonly { readonly family: RuleFamily; readonly damped: boolean }[];
  readonly trustedBypass: boolean;
  /** 소유자가 풀어 준 메일이면 풀기 전 사유(묶음 A). */
  readonly releasedFrom: ReleasedFrom | null;
  readonly labels: readonly string[];
  readonly firstReadAt: Date | null;
}

export interface LabelCount {
  readonly label: string;
  /** 이 라벨이 붙은 **보이는** 메일 수. */
  readonly count: number;
  /** 그중 아직 읽지 않은(`first_read_at` 없음) 수. */
  readonly unread: number;
}

export type SetLabelsOutcome =
  | { readonly kind: 'ok'; readonly labels: readonly string[] }
  | { readonly kind: 'not_found' }
  /** 메일 한 통의 라벨이 상한(20)을 넘는다(더하기 · 빼기의 결과). */
  | { readonly kind: 'message_label_limit' }
  /** 에이전트의 서로 다른 라벨이 상한을 넘는다. */
  | { readonly kind: 'agent_label_limit' };

export interface MessageStateStore {
  /** 보이는 메일만 — 보이지 않는(격리 · 남의) id 는 결과에 없다. */
  riskFacts(agentId: AgentId, ids: readonly string[]): Promise<ReadonlyMap<string, MessageFacts>>;
  /**
   * 라벨 바꾸기. `replace` 가 있으면 그 집합으로, 아니면 `add` 를 더하고 `remove` 를 뺀다. 메일당 상한은 호출자가 먼저 보고(400), 에이전트 상한은
   * 여기서 에이전트 잠금 아래 본다.
   */
  setLabels(
    agentId: AgentId,
    messageId: string,
    change: { readonly replace?: readonly string[]; readonly add?: readonly string[]; readonly remove?: readonly string[] },
  ): Promise<SetLabelsOutcome>;
  listLabels(agentId: AgentId): Promise<readonly LabelCount[]>;
  /** 처음 읽은 시각을 적는다(이미 있으면 그대로). 보이는 메일만. */
  markRead(agentId: AgentId, messageId: string): Promise<void>;
}

/** **신뢰 발신자 우회 칸의 유일한 읽기** — 묶음 A 의 `inbound_messages.trusted_bypass`(202610081000). */
export function trustedBypassColumn(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`SQL 별칭이 아니다: ${alias}`);
  return `coalesce(${alias}.trusted_bypass, false)`;
}

interface FactRow {
  id: string;
  quarantined: boolean;
  quarantine_reason: QuarantineReason | null;
  injection_risk: InjectionRisk | null;
  trusted_bypass: boolean;
  released_from: ReleasedFrom | null;
  findings: string[];
  labels: string[] | null;
  first_read_at: Date | null;
}

/** `family:damped(0|1)` → 적중(`exposure-store.ts` 와 같은 읽기 — 모양이 틀리면 완화되지 않은 적중으로 읽는다, fail closed). */
function findingOf(raw: string): { readonly family: RuleFamily; readonly damped: boolean } {
  const at = raw.lastIndexOf(':');
  return { family: raw.slice(0, at) as RuleFamily, damped: raw.slice(at + 1) === '1' };
}

const RISK_FACTS_SQL = `SELECT m.id::text AS id, m.quarantined, m.quarantine_reason, m.injection_risk, ${trustedBypassColumn('m')} AS trusted_bypass, m.released_from,
       coalesce((SELECT array_agg(f.family || ':' || CASE WHEN f.damped THEN '1' ELSE '0' END ORDER BY f.ordinal)
                   FROM security_findings f
                  WHERE f.inbound_message_id = m.id AND f.scanner_version = m.scanner_version), '{}') AS findings,
       s.labels, s.first_read_at
  FROM inbound_messages m
  LEFT JOIN inbound_message_state s ON s.inbound_message_id = m.id
 WHERE m.id = ANY($1::uuid[]) AND m.agent_id = $2 AND ${visibleToAgent('m')}`;

/** 보이는 메일 하나의 상태 행(라벨)을 읽는다. 없으면 `null`. 경합은 호출자의 에이전트 잠금이 줄 세운다. */
async function visibleState(client: PoolClient, agentId: AgentId, messageId: string): Promise<{ labels: string[] } | null> {
  const rows = await selectRows<{ labels: string[] | null }>(
    client,
    `SELECT s.labels
       FROM inbound_messages m
       LEFT JOIN inbound_message_state s ON s.inbound_message_id = m.id
      WHERE m.id = $1::uuid AND m.agent_id = $2 AND ${visibleToAgent('m')}`,
    [messageId, agentId],
  );
  const row = rows[0];
  return row === undefined ? null : { labels: row.labels ?? [] };
}

export function createPostgresMessageStateStore(pool: Pool): MessageStateStore {
  return {
    async riskFacts(agentId, ids) {
      if (ids.length === 0) return new Map();
      const rows = await selectRows<FactRow>(pool, RISK_FACTS_SQL, [[...new Set(ids)], agentId]);
      return new Map(
        rows.map((row) => [
          row.id,
          {
            id: row.id,
            quarantined: row.quarantined,
            quarantineReason: row.quarantine_reason,
            injectionRisk: row.injection_risk,
            findings: row.findings.map(findingOf),
            trustedBypass: row.trusted_bypass,
            releasedFrom: row.released_from,
            labels: row.labels ?? [],
            firstReadAt: row.first_read_at,
          },
        ]),
      );
    },

    async setLabels(agentId, messageId, change) {
      return withTransaction(pool, async (client) => {
        // 에이전트 잠금 — 서로 다른 라벨 상한(200)을 두 요청이 동시에 넘기지 않게.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('inbound_message_labels:' || $1, 0))`, [agentId]);
        const current = await visibleState(client, agentId, messageId);
        if (current === null) return { kind: 'not_found' } as const;
        const next =
          change.replace !== undefined
            ? new Set(change.replace)
            : new Set([...current.labels, ...(change.add ?? [])].filter((label) => !(change.remove ?? []).includes(label)));
        const labels = [...next].sort();
        if (labels.length > MAX_LABELS_PER_MESSAGE) return { kind: 'message_label_limit' } as const;
        const added = labels.filter((label) => !current.labels.includes(label));
        if (added.length > 0) {
          const known = await selectRows<{ label: string }>(
            client,
            `SELECT DISTINCT unnest(labels) AS label FROM inbound_message_state WHERE agent_id = $1`,
            [agentId],
          );
          const distinct = new Set([...known.map((row) => row.label), ...added]);
          if (distinct.size > MAX_DISTINCT_LABELS_PER_AGENT) return { kind: 'agent_label_limit' } as const;
        }
        await client.query(
          `INSERT INTO inbound_message_state (inbound_message_id, agent_id, labels) VALUES ($1::uuid, $2, $3::text[])
           ON CONFLICT (inbound_message_id) DO UPDATE SET labels = EXCLUDED.labels`,
          [messageId, agentId, labels],
        );
        return { kind: 'ok', labels } as const;
      });
    },

    async listLabels(agentId) {
      const rows = await selectRows<{ label: string; count: number; unread: number }>(
        pool,
        `SELECT l.label, count(*)::int AS count, count(*) FILTER (WHERE s.first_read_at IS NULL)::int AS unread
           FROM inbound_message_state s
           JOIN inbound_messages m ON m.id = s.inbound_message_id
           CROSS JOIN LATERAL unnest(s.labels) AS l(label)
          WHERE s.agent_id = $1 AND m.agent_id = $1 AND ${visibleToAgent('m')}
          GROUP BY l.label
          ORDER BY l.label`,
        [agentId],
      );
      return rows;
    },

    async markRead(agentId, messageId) {
      await pool.query(
        `INSERT INTO inbound_message_state (inbound_message_id, agent_id, first_read_at)
         SELECT m.id, m.agent_id, now() FROM inbound_messages m
          WHERE m.id = $1::uuid AND m.agent_id = $2 AND ${visibleToAgent('m')}
         ON CONFLICT (inbound_message_id) DO UPDATE SET first_read_at = coalesce(inbound_message_state.first_read_at, now())
          WHERE inbound_message_state.first_read_at IS NULL`,
        [messageId, agentId],
      );
    },
  };
}
