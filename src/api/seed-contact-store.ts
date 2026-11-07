/**
 * src/api/seed-contact-store.ts — 전환 공지(계획 §3.2 2단계)의 수신자 목록.
 *
 * **수신자는 요청 본문이 아니라 여기서 온다.** 전환 공지는 "소유자가 프로비저닝 때 이름으로 적은 상대"
 * 에게만 가는 발송이다 — 본문에 `to` 를 받으면 이 경로가 임의 수신자에게 보내는 두 번째 `send` 가 된다.
 * 목록은 `sender_relationships(trust_category='seed')` 이고, 그 행은 프로비저닝 트랜잭션만 만든다
 * (`provisioning-store.ts`; DB CHECK 가 seed 를 `recipient` 스코프·승인 id 없음으로 고정한다).
 */

import type { Pool } from 'pg';

import type { AgentId } from '../db/schema';

export interface SeedContactReader {
  /** 에이전트의 seed contact 주소(정규형). 순서는 고정이다 — 응답·audit 순서가 호출마다 흔들리지 않게. */
  listSeedContacts(agentId: AgentId): Promise<readonly string[]>;
}

export function createPostgresSeedContactReader(pool: Pool): SeedContactReader {
  return {
    async listSeedContacts(agentId: AgentId): Promise<readonly string[]> {
      const result = await pool.query<{ address: string }>(
        `SELECT address FROM sender_relationships
          WHERE agent_id = $1 AND trust_category = 'seed' AND scope = 'recipient'
          ORDER BY created_at, address`,
        [agentId],
      );
      return result.rows.map((row) => row.address);
    },
  };
}
