/**
 * src/identity/agent-id.ts — `agentId` 생성(계획 §4B.1). 형식: 16바이트 난수의 소문자 hex 32자. 형식 검증·브랜디드 타입은 `src/db/schema.ts` 가
 * 단일 원천이다.
 *
 * 왜 이 규격인가:
 *   ① did:web 경로 세그먼트(`did:web:id.atmark.ai:agents:{agentId}`)에서 표현이 하나뿐이다(대시·퍼센트인코딩 없음).
 *   ② 온체인 `bytes32` 에 제로패딩으로 무손실 매핑된다(AC-13).
 *   ③ `agents.id` = `agentId` — 별도 내부 PK 를 두면 둘 중 하나가 조인 키로 새어 나갈 표면이 생긴다.
 *
 * **재생성 경로는 존재하지 않는다**(D4) — `regenerate`·`rotate` 류 함수를 두지 않는다. DB 대응물은 `agents_id_immutable` 트리거다.
 */

import { randomBytes } from 'node:crypto';
import { toAgentId, type AgentId } from '../db/schema';

/** 16바이트 = hex 32자. 바꾸면 `AGENT_ID_PATTERN`·DB CHECK·`char(32)` 가 동시에 틀려진다. */
export const AGENT_ID_BYTES = 16;

/**
 * 새 `agentId`(프로비저닝 트랜잭션 안에서만). CSPRNG 인 이유: 예측 가능한 식별자는 남의 DID 경로를 선점할 수 있게 한다. `toAgentId` 로 바로
 * 승격해 `AGENT_ID_BYTES` 를 잘못 바꾼 날 트랜잭션 한복판이 아니라 여기서 터진다.
 */
export function generateAgentId(): AgentId {
  return toAgentId(randomBytes(AGENT_ID_BYTES).toString('hex'));
}
