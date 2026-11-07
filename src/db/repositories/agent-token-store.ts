/**
 * src/db/repositories/agent-token-store.ts — `AgentTokenStore` 의 Postgres 구현.
 *
 * 규칙(형식·해시·만료·권한)은 전부 `src/identity/agent-token.ts` 에 있다. 이 파일은
 * **행 접근만** 한다 — 여기서 만료나 폐기를 한 번 더 판정하면 판정이 두 곳이 되고,
 * 한쪽만 고쳐진 상태가 곧 "폐기했는데 아직 되는 토큰" 이다.
 *
 * **평문을 받는 함수가 없다.** 조회는 해시로만 한다. 그 제약은 인터페이스가 이미
 * 걸고 있고(`findByHash`), 여기서 편의 함수를 하나 더 만드는 순간 무너진다.
 */

import type { Pool } from 'pg';

import type {
  AgentTokenCapability as IdentityCapability,
  AgentTokenRecord,
  AgentTokenStore,
} from '../../identity/agent-token';
import type { Queryable } from '../client';
import { toAgentId, type AgentId, type AgentTokenCapability as DbCapability } from '../schema';
import { selectRow } from './rows';

/**
 * **두 유니온이 같은 집합임을 컴파일 타임에 단언한다.**
 *
 * `src/db/schema.ts` 의 `AgentTokenCapability`(Postgres ENUM 대응)와
 * `src/identity/agent-token.ts` 의 같은 이름 유니온은 서로 import 할 수 없다 —
 * identity 가 db/schema 를 import 하므로 반대 방향은 순환이고 `no-circular` 가 error 다.
 * 그래서 **둘 다 import 하는 유일한 파일인 여기서** 양방향 대입으로 묶는다.
 * 한쪽에 값이 추가되면 이 두 줄이 컴파일 에러가 된다 — 주석이 아니라 타입이 지킨다.
 */
export type CapabilityUnionsAgree =
  (DbCapability extends IdentityCapability ? true : never) &
  (IdentityCapability extends DbCapability ? true : never);

const CAPABILITY_UNIONS_AGREE: CapabilityUnionsAgree = true;
export { CAPABILITY_UNIONS_AGREE };

interface TokenRow {
  agent_id: string;
  /** `capabilities::text[]` 로 캐스팅해 읽는다 — 아래 SELECT 주석 참조. */
  capabilities: string[];
  revoked_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  webhooks_legacy_eligible: boolean;
  self_enrolled_agent: boolean;
  operator_reserved_agent: boolean;
}

/**
 * ENUM 배열을 **`::text[]` 로 캐스팅해서 읽는 이유**: `node-postgres` 는 내장 타입의
 * 배열만 파싱한다. 사용자 정의 ENUM 배열은 OID 가 등록돼 있지 않아 `'{messages:send}'`
 * 같은 **원시 문자열**로 돌아온다. 그 문자열이 `capabilities.includes(...)` 를 통과할 일은
 * 없으므로, 증상은 "모든 요청이 권한 없음으로 거부됨" 이다 — 조용하지는 않지만
 * 원인이 SQL 한 줄에 있는 종류의 장애다(`findByHash` 의 `k.capabilities::text[]`).
 */

function toRecord(row: TokenRow, tokenHash: string): AgentTokenRecord {
  return {
    tokenHash,
    agentId: toAgentId(row.agent_id),
    // DB ENUM 이 값 집합을 이미 닫았다(`agent_token_capability`). 위 `CapabilityUnionsAgree`
    // 가 그 집합과 TS 유니온의 동일성을 단언하므로 여기서 런타임 재검증은 중복이다.
    capabilities: row.capabilities as readonly IdentityCapability[],
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    issuedAt: row.created_at,
    // 202609301410 전에 발급된 토큰만 true(불변) — 웹훅 관리 전환 경로의 자격.
    webhooksLegacyEligible: row.webhooks_legacy_eligible,
    // 자가 등록으로 태어난 에이전트인가 — 함의 권한(`policy:request`, 기본값 이전 토큰)을 막는 사실(앱 롤은 `agent_enrollments.child_agent_id` 를 읽는다).
    selfEnrolledAgent: row.self_enrolled_agent,
    // 운영자 예약 주소 에이전트(support@ 등)인가 — `policy:request` 를 빼는 사실(보안 감사 M-1).
    operatorReservedAgent: row.operator_reserved_agent,
  };
}

/** 토큰 발급 시 저장할 것. 평문은 여기 없다 — 호출자가 1회 반환하고 버린다. */
export interface AgentApiKeyInsert {
  readonly agentId: AgentId;
  readonly tokenHash: string;
  readonly capabilities: readonly IdentityCapability[];
  /** `null` 은 무기한. */
  readonly expiresAt: Date | null;
}

/** 조회 + 발급 + 폐기. `AgentTokenStore` 보다 넓다 — 인증 경로는 좁은 면만 본다. */
export interface AgentApiKeyRepository extends AgentTokenStore {
  /** 발급된 행의 id. 같은 해시가 이미 있으면 유니크 인덱스가 던진다. */
  insert(key: AgentApiKeyInsert): Promise<string>;
  /** 폐기. **행을 지우지 않는다.** 이미 폐기된 토큰이면 0행 → `false`. */
  revoke(tokenHash: string, now: Date): Promise<boolean>;
  /**
   * 마지막 사용 시각 갱신(US-007, `AgentTokenStore.touch` 를 **필수**로 좁힌다 — 반환 모양은 그대로 `Promise<void>`,
   * 그래야 이 타입이 여전히 `AgentTokenStore` 자리에 들어간다). **분 단위로 코얼레싱한다** — 같은 분 안의 반복
   * 호출은 쓰지 않는다(쓰기 증폭 방지, `agent_api_keys` 는 인증 경로에서 요청마다 지나는 테이블이다). 폐기된
   * 토큰은 갱신하지 않는다(WHERE 가드 — `authenticateAgentToken` 이 폐기 판정 뒤에만 부르므로 이중 방어). 인증
   * 경로의 곁가지이므로 결과를 보지 않는다 — 코얼레싱이 실제로 0행이 되는지는 테스트가 행을 직접 본다.
   */
  touch(tokenHash: string, now: Date): Promise<void>;
}

/**
 * 토큰(`k`)의 에이전트가 운영자 예약 주소를 활성으로 쥐었는가(보안 감사 M-1) — 목록은 SQL `atmark_operator_assignable_addresses()` 하나에서 온다.
 * 관리 연산의 토큰 화면 · 교체 · 발급도 같은 술어다(`admin/ops/tokens.ts`).
 */
export const OPERATOR_RESERVED_AGENT_SQL = `EXISTS (SELECT 1 FROM agent_addresses r
            WHERE r.agent_id = k.agent_id AND r.retired_at IS NULL AND r.address = ANY (atmark_operator_assignable_addresses()))`;

/**
 * **삭제한 에이전트(`disabled`, 202610131000)의 토큰은 폐기된 것으로 읽는다** — 삭제는 토큰을 전부 폐기하지만, 그 트랜잭션과 경합한 발급 · 옛 코드의
 * 발급이 살아 있는 행을 남겨도 인증은 401(`token_revoked`)이다. 값은 `revoked_at` 칸 하나로만 바꾼다(호출자 · 레코드 모양 그대로).
 */
async function findByHash(db: Queryable, tokenHash: string): Promise<AgentTokenRecord | null> {
  const row = await selectRow<TokenRow>(
    db,
    `SELECT k.agent_id, k.capabilities::text[] AS capabilities,
            CASE WHEN a.status = 'disabled' THEN coalesce(k.revoked_at, k.created_at) ELSE k.revoked_at END AS revoked_at,
            k.expires_at, k.created_at, k.webhooks_legacy_eligible,
            EXISTS (SELECT 1 FROM agent_enrollments e WHERE e.child_agent_id = k.agent_id) AS self_enrolled_agent,
            ${OPERATOR_RESERVED_AGENT_SQL} AS operator_reserved_agent
       FROM agent_api_keys k JOIN agents a ON a.id = k.agent_id
      WHERE k.token_hash = $1`,
    [tokenHash],
  );
  return row === null ? null : toRecord(row, tokenHash);
}

export function createPostgresAgentTokenStore(pool: Pool): AgentApiKeyRepository {
  return {
    findByHash(tokenHash: string): Promise<AgentTokenRecord | null> {
      return findByHash(pool, tokenHash);
    },

    async insert(key: AgentApiKeyInsert): Promise<string> {
      const row = await selectRow<{ id: string }>(
        pool,
        `INSERT INTO agent_api_keys (agent_id, token_hash, capabilities, expires_at)
         VALUES ($1, $2, $3::agent_token_capability[], $4)
         RETURNING id`,
        [key.agentId, key.tokenHash, [...key.capabilities], key.expiresAt],
      );
      if (row === null) throw new Error('agent_api_keys INSERT 가 행을 돌려주지 않았다');
      return row.id;
    },

    async revoke(tokenHash: string, now: Date): Promise<boolean> {
      // `WHERE revoked_at IS NULL` — 재폐기가 최초 폐기 시각을 덮어쓰면 "언제부터
      // 무효였는가" 가 사후에 바뀐다. 그 시각은 사고 조사의 경계선이다.
      const result = await pool.query(
        'UPDATE agent_api_keys SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL',
        [tokenHash, now],
      );
      return result.rowCount === 1;
    },

    async touch(tokenHash: string, now: Date): Promise<void> {
      // 분 단위 절삭은 주입된 시계(`now`)에다 한다 — SQL `now()` 를 쓰면 테스트가 시계를 고정해도 코얼레싱
      // 경계를 관찰할 수 없다(이 코드베이스는 어디서나 시계를 주입한다). `WHERE` 의 두 조건이 이중 가드다:
      // `revoked_at IS NULL` 은 폐기된 토큰을 건드리지 않고(202609241400 이 준 UPDATE 권한은 앱 롤도 있어
      // 이 가드가 없으면 SQL 층에서 "폐기 토큰도 계속 쓰인 것처럼" 보일 수 있다), `last_used_at < 분 절삭`
      // 은 같은 분의 반복 호출을 0행으로 만든다(쓰기 증폭 방지) — 그리고 뒤로 가지 않는다는 것은 DB 트리거
      // (`agent_api_keys_last_used_at_forward_only`)가 한 번 더 본다.
      await pool.query(
        `UPDATE agent_api_keys
            SET last_used_at = date_trunc('minute', $2::timestamptz)
          WHERE token_hash = $1
            AND revoked_at IS NULL
            AND (last_used_at IS NULL OR last_used_at < date_trunc('minute', $2::timestamptz))`,
        [tokenHash, now],
      );
    },
  };
}
