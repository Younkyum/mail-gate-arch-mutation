/**
 * src/db/repositories/ai-watch-result-store.ts — AI 의심 메일 감시 **결과 λ** 의 DB 면(ADR-0017 초안 · 202610061100). 롤 `atmark_ai_watch` 로 붙고,
 * 표 권한이 0 이라 할 수 있는 일은 정의 함수 둘뿐이다: 판정 하나를 pending 작업에 적기(멱등 — 두 번째·모르는 job·10분 넘은 결과는 `ignored`) ·
 * 하트비트 한 행 · 보존(90일, 하트비트마다). `ai_watch_jobs` 를 쓰는 프로덕션 파일은 이 파일과 `inbound-store.ts`(작업 생성 · 전송 실패 skip) 둘뿐이다.
 */

import type { Pool } from 'pg';

import type { AiWatchBand, AiWatchVerdict } from '../../inbound/ai-watch/contract';

export type AiWatchVerdictOutcome = 'recorded' | 'late' | 'ignored';

export interface AiWatchResultStore {
  recordVerdict(input: {
    readonly jobId: string;
    readonly verdict: AiWatchVerdict;
    readonly band: AiWatchBand | null;
    readonly modelVersion: string;
  }): Promise<{ readonly outcome: AiWatchVerdictOutcome; readonly latencyMs: number | null }>;
  recordHeartbeat(input: {
    readonly workerId: string;
    readonly modelVersion: string;
    readonly selfTestOk: boolean;
    readonly draining: boolean;
  }): Promise<void>;
  /** 보존 — 90일 넘은 작업(한 번에 10 000). 지운 수. 하트비트마다 부른다. */
  purgeExpired(): Promise<number>;
}

export function createPostgresAiWatchResultStore(pool: Pool): AiWatchResultStore {
  return {
    async recordVerdict(input) {
      const result = await pool.query<{ outcome: string; latency_ms: number | null }>(
        'SELECT outcome, latency_ms FROM ai_watch_record_verdict($1, $2, $3, $4)',
        [input.jobId, input.verdict, input.band, input.modelVersion],
      );
      const row = result.rows[0];
      const outcome: AiWatchVerdictOutcome = row?.outcome === 'recorded' || row?.outcome === 'late' ? row.outcome : 'ignored';
      return { outcome, latencyMs: outcome === 'ignored' ? null : (row?.latency_ms ?? null) };
    },
    async recordHeartbeat(input) {
      await pool.query('SELECT ai_watch_record_heartbeat($1, $2, $3, $4)', [input.workerId, input.modelVersion, input.selfTestOk, input.draining]);
    },
    async purgeExpired() {
      const result = await pool.query<{ purged: number }>('SELECT purge_ai_watch_jobs() AS purged');
      return result.rows[0]?.purged ?? 0;
    },
  };
}
