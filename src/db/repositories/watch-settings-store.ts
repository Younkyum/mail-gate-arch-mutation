/**
 * src/db/repositories/watch-settings-store.ts — 수신 소비자가 읽는 **감시 탭 받기 설정**(202610081000 — 앱 롤은 읽기만).
 *
 * 에이전트 하나 → 그 에이전트의 설정(행이 없으면 기본값) + 그 조직의 살아 있는 신뢰 발신자. 한 문장이다(에이전트 · 조직이 어긋날 틈이 없다).
 * 에이전트가 없으면(소비자가 막 찾은 에이전트라 버그 · 경합) 던진다 — 소비자는 일시 장애로 보고 재전달한다(설정 없이 기본값으로 넘기지 않는다:
 * 소유자가 `hold` 를 골랐는데 기본 `deliver` 로 보이면 좁히기가 깨진다).
 */

import type { Pool } from 'pg';

import type { RiskHandling, TrustedSenderKind } from '../schema';
import { DEFAULT_AGENT_WATCH_SETTINGS, type InboundWatchContext } from '../../watch/settings';

export interface InboundWatchPort {
  loadInboundWatch(agentId: string): Promise<InboundWatchContext>;
}

export function createPostgresInboundWatchSource(pool: Pool): InboundWatchPort {
  return {
    async loadInboundWatch(agentId: string): Promise<InboundWatchContext> {
      const result = await pool.query<{
        risk_handling: RiskHandling | null;
        risk_notify: boolean | null;
        trusted: { kind: TrustedSenderKind; value: string }[] | null;
      }>(
        `SELECT s.risk_handling, s.risk_notify,
                (SELECT json_agg(json_build_object('kind', t.kind, 'value', t.value) ORDER BY t.kind, t.value)
                   FROM org_trusted_senders t
                  WHERE t.organization_id = a.organization_id AND t.removed_at IS NULL) AS trusted
           FROM agents a
           LEFT JOIN agent_watch_settings s ON s.agent_id = a.id
          WHERE a.id = $1`,
        [agentId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error(`감시 설정을 읽을 에이전트가 없다 (agent=${agentId})`);
      return {
        settings: {
          riskHandling: row.risk_handling ?? DEFAULT_AGENT_WATCH_SETTINGS.riskHandling,
          riskNotify: row.risk_notify ?? DEFAULT_AGENT_WATCH_SETTINGS.riskNotify,
        },
        trustedSenders: (row.trusted ?? []).map((entry) => ({ kind: entry.kind, value: entry.value })),
      };
    },
  };
}
