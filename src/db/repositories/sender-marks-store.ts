/**
 * src/db/repositories/sender-marks-store.ts — 소유자 수동 발신자 분류(`sender_marks`, 계획 §6 P4 thin slice).
 *
 * **`seen` 의 유일한 출처**다(`sender-trust.ts` "자동 승격을 하지 않는다"). 그리고 **발신 허가가 아니다** —
 * Stage 7 의 소스(`policy-source.ts`)는 이 테이블을 읽지 않는다(마이그레이션 202609230020 머리말).
 *
 * ## 쓰기는 운영자 전용
 *
 * `recordSenderMark` 는 **소유자 롤 풀**로만 성공한다. 앱 롤(`atmark_app`)에는 INSERT 권한이 없다 — API 는
 * 전부 앱 롤로 돌기 때문에, 에이전트 토큰으로 이 테이블에 쓰는 경로는 **라우트가 있든 없든** 물리적으로 없다.
 * 이 함수를 부르는 곳은 `scripts/sender-mark.ts`(`pnpm sender:mark`) 하나다.
 *
 * ## 유효 분류 = (agent, scope, 키)별 최신 행
 *
 * append-only 라 되돌림은 `mark = 'cleared'` 새 행이다. **최신 행을 먼저 고르고 그다음에 `seen` 을 거른다** —
 * 순서를 바꾸면(`WHERE mark = 'seen'` 후 최신) 지운 분류의 옛 `seen` 행이 되살아난다.
 */

import type { Pool } from 'pg';

import type { Queryable } from '../client';
import { hostedEvidenceSql } from './hosted-evidence';
import type { OwnerClassificationFact } from '../../security/trust-signals';

export type SenderMarkScope = 'address' | 'domain';
export type SenderMarkValue = 'seen' | 'cleared';

export type SenderMarkInput =
  | {
      readonly agentId: string;
      readonly scope: 'address';
      /** 소문자화만 한 전체 주소(`+tag` 유지). */
      readonly address: string;
      readonly mark: SenderMarkValue;
      readonly markedBy: string;
    }
  | {
      readonly agentId: string;
      readonly scope: 'domain';
      readonly domain: string;
      readonly mark: SenderMarkValue;
      readonly markedBy: string;
      /** 도메인 스코프 `seen` 의 명시 확인(AC-d5 와 같은 모양). `cleared` 면 `null` 이어도 된다. */
      readonly domainScopeConfirmedBy: string | null;
    };

/** **운영자 전용.** 앱 롤 풀로 부르면 DB 가 permission denied 로 막는다. */
export async function recordSenderMark(ownerPool: Pool, input: SenderMarkInput): Promise<string> {
  const result = await ownerPool.query<{ id: string }>(
    `INSERT INTO sender_marks (agent_id, scope, address, domain, mark, marked_by, domain_scope_confirmed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.agentId,
      input.scope,
      input.scope === 'address' ? input.address : null,
      input.scope === 'domain' ? input.domain : null,
      input.mark,
      input.markedBy,
      input.scope === 'domain' ? input.domainScopeConfirmedBy : null,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('sender_marks INSERT 가 행을 돌려주지 않았다');
  return id;
}

/**
 * `agentId` 범위에서 이 주소·도메인에 걸리는 **유효한 `seen`** 분류. 트러스트 포트가 부른다.
 * `address` 는 소문자화만 한 전체 주소, `domain` 은 그 도메인.
 *
 * **Atmark 주소의 분류는 그 주소의 지금 활성 행이 생긴 뒤에 매긴 것만** 센다(`hostedEvidenceSql` — 별칭 재발급 보안 리뷰 M3). 최신 행을 고른
 * **뒤에** 거른다 — 재발급 전의 `seen` 이 최신이면 없는 것과 같고, 재발급 뒤의 `cleared` 가 최신이면 여전히 없다.
 */
export async function loadEffectiveSeenMarks(
  db: Queryable,
  agentId: string,
  address: string,
  domain: string,
): Promise<OwnerClassificationFact[]> {
  const result = await db.query<{
    agent_id: string;
    scope: SenderMarkScope;
    address: string | null;
    domain: string | null;
    mark: SenderMarkValue;
  }>(
    `SELECT latest.agent_id, latest.scope, latest.address, latest.domain, latest.mark
       FROM (SELECT DISTINCT ON (scope, coalesce(address, domain)) agent_id, scope, address, domain, mark, marked_at
               FROM sender_marks
              WHERE agent_id = $1
                AND ((scope = 'address' AND address = $2) OR (scope = 'domain' AND domain = $3))
              ORDER BY scope, coalesce(address, domain), marked_at DESC, id DESC) latest
      WHERE ${hostedEvidenceSql('$2::text', 'latest.marked_at')}
      ORDER BY latest.scope, coalesce(latest.address, latest.domain)`,
    [agentId, address, domain],
  );
  const facts: OwnerClassificationFact[] = [];
  for (const row of result.rows) {
    if (row.mark !== 'seen') continue;
    facts.push({ agentId: row.agent_id, scope: row.scope, address: row.address, domain: row.domain, category: 'seen' });
  }
  return facts;
}
