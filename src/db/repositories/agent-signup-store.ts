/**
 * src/db/repositories/agent-signup-store.ts — 바깥 가입 감지 기록(202610081101 — ADR-0016 2026-10-08). 수신 소비자(앱 롤)가 메일을 적은 **뒤** 부른다.
 *
 * 쓰기는 정의자 `atmark_record_agent_signup` 하나다(표 쓰기 0 — 앱 롤 GRANT 는 EXECUTE 뿐). 함수가 그 메일이 그 에이전트의 것 · DMARC 인증 · 보임 · From 도메인이
 * 서비스 도메인(또는 그 하위)인지 다시 보고, 처음 본 서비스면 조직 설정(`notify_on_signup`)에 따라 알림 창(kind `signup`)에 넣는다. 제목 · 본문은 넘기지 않는다.
 */

import type { Queryable } from '../client';
import type { SignupDetection } from '../../mail/signup/classify';

export type AgentSignupOutcome = 'new' | 'seen' | 'ignored';

export interface AgentSignupPort {
  recordSignup(agentId: string, inboundMessageId: string, detection: SignupDetection): Promise<AgentSignupOutcome>;
}

export function createPostgresAgentSignupStore(db: Queryable): AgentSignupPort {
  return {
    async recordSignup(agentId, inboundMessageId, detection) {
      const result = await db.query<{ outcome: AgentSignupOutcome }>('SELECT atmark_record_agent_signup($1, $2, $3, $4) AS outcome', [
        agentId,
        inboundMessageId,
        detection.serviceDomain,
        detection.kind,
      ]);
      const outcome = result.rows[0]?.outcome;
      if (outcome !== 'new' && outcome !== 'seen' && outcome !== 'ignored') throw new Error('atmark_record_agent_signup 가 모르는 결과를 돌려주었다');
      return outcome;
    },
  };
}
