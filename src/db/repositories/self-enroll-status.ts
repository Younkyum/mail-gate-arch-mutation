/**
 * src/db/repositories/self-enroll-status.ts — 발견(`get_capabilities` · `GET /v1/agents/{id}/capabilities`)이 읽는 **자가 등록 상태**(202610081101 — 앱 롤은
 * 조직 설정 두 칸 · 시도 행의 조직 · 시각만 읽는다). 판정은 admin λ 와 DB 트리거가 한다 — 이것은 에이전트에게 "지금 부를 수 있나" 를 말해 줄 뿐이다.
 */

import type { Queryable } from '../client';

export interface SelfEnrollStatus {
  readonly enabled: boolean;
  readonly dailyCap: number;
  /** 조직의 지난 24시간 시도 수(만들었든 쓸 수 없는 주소였든). */
  readonly usedLast24h: number;
}

/** 앞 거르개 결과(202610081105 `atmark_enroll_precheck`). ok 일 때만 시도가 하나 세어진다. */
export type EnrollPrecheck = 'ok' | 'not_found' | 'disabled' | 'daily_cap' | 'rate_limited';

export interface SelfEnrollStatusPort {
  load(agentId: string): Promise<SelfEnrollStatus | null>;
  /** admin 을 부르기 전 거르개 — 설정 · 조직 하루 상한 · 에이전트당 분당 3. */
  precheck(agentId: string): Promise<EnrollPrecheck>;
}

export function createPostgresSelfEnrollStatus(db: Queryable): SelfEnrollStatusPort {
  return {
    async load(agentId) {
      const result = await db.query<{ enabled: boolean | null; cap: number | null; used: number }>(
        `SELECT s.agent_self_enroll AS enabled, s.enroll_daily_cap AS cap,
                (SELECT count(*)::int FROM agent_enrollments e WHERE e.organization_id = a.organization_id AND e.created_at > now() - interval '24 hours') AS used
           FROM agents a LEFT JOIN org_watch_settings s ON s.organization_id = a.organization_id
          WHERE a.id = $1`,
        [agentId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return { enabled: row.enabled ?? false, dailyCap: row.cap ?? 5, usedLast24h: row.used };
    },
    async precheck(agentId) {
      const result = await db.query<{ outcome: string }>('SELECT atmark_enroll_precheck($1) AS outcome', [agentId]);
      const outcome = result.rows[0]?.outcome;
      if (outcome !== 'ok' && outcome !== 'not_found' && outcome !== 'disabled' && outcome !== 'daily_cap' && outcome !== 'rate_limited') {
        throw new Error('atmark_enroll_precheck 가 모르는 결과를 돌려주었다');
      }
      return outcome;
    },
  };
}
