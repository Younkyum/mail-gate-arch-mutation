/**
 * src/db/repositories/inbound-policy-store.ts — 수신 정책(정책 v2)의 Postgres 소스.
 *
 * 수신 소비자(앱 롤)가 에이전트마다 한 번 읽는다: 현재 버전 스냅샷의 `inbound_mode` + **그 스냅샷의** 수신 방향 연락처 규칙
 * (202609241040 — 살아 있는 테이블이 아니라 스냅샷. DB 제약 트리거가 둘을 같게 지킨다). **판정은 하지 않는다**
 * (`src/policy/inbound-policy.ts`). 발신 관문의 소스(`policy-source.ts`)와 같은 규율:
 *   - **한 트랜잭션(`REPEATABLE READ READ ONLY`)에서 읽는다** — 목록 변경은 새 버전과 한 트랜잭션이므로, 같은 스냅샷에서 읽은
 *     모드·목록이 그 버전의 것이다.
 *   - **모드는 행이 아니라 스냅샷**(`policy_versions.inbound_mode` at `current_version`) — 둘이 갈라진 창에서 판정 근거와 로그가
 *     가리키는 버전이 같아야 한다.
 *   - 정책·버전 행이 없으면 `PolicySourceUnavailableError` — 소비자가 **격리**로 끝낸다(판정할 수 없는 메일을 에이전트에게
 *     보이지 않는다; 재전달하지 않는다 — 같은 데이터면 같은 결과다).
 */

import type { Pool } from 'pg';

import { withTransaction } from '../client';
import type { InboundMode, JsonObject } from '../schema';
import { resolveInboundPolicy, type InboundPolicy, type InboundPolicyPort } from '../../policy/inbound-policy';
import { PolicySourceUnavailableError, snapshotContactRules } from '../../policy/policy-loader';
import { selectRow } from './rows';

export type { InboundPolicyPort };

export function createPostgresInboundPolicySource(pool: Pool): InboundPolicyPort {
  return {
    async loadInboundPolicy(agentId: string): Promise<InboundPolicy> {
      return withTransaction(
        pool,
        async (client) => {
          const version = await selectRow<{ version: number; inbound_mode: InboundMode; snapshot: JsonObject }>(
            client,
            `SELECT v.version, v.inbound_mode, v.snapshot
               FROM agent_policies p
               JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version
              WHERE p.agent_id = $1`,
            [agentId],
          );
          if (version === null) {
            throw new PolicySourceUnavailableError(`수신 정책을 읽을 수 없다 — 정책 또는 현재 버전 행이 없다 (agentId=${agentId})`);
          }
          // 목록은 **현재 버전 스냅샷**에서 — 발신 관문과 같은 근거(`snapshotContactRules`, 202609241040 · 검증 M3).
          const rules = snapshotContactRules(version.snapshot).filter((rule) => rule.direction === 'inbound');
          return resolveInboundPolicy(version.inbound_mode, rules, version.version);
        },
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
    },
  };
}
