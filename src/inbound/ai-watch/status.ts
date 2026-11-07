/**
 * src/inbound/ai-watch/status.ts — 작업 행(`ai_watch_jobs`) → 표시 상태. **순수 함수.** 소유자 콘솔(WP-C)과 에이전트 조회(REST·MCP provenance)가 같은
 * 함수를 쓴다 — 둘이 따로 매핑하면 "콘솔은 flagged, 에이전트는 unavailable" 같은 어긋남이 생긴다.
 *
 *   - 소유자: `pending`(마감 전) · `flagged` · `clear` · `skipped`(그 밖 — 마감 초과 · 큐 실패 · 워커 error · 만료) + 밴드 · 모델 버전 · 늦음.
 *   - 에이전트: `flagged` · `clear` · `unavailable`. **밴드는 없다**(회피 단서). 감시를 끈 조직 · 작업 없음(off · 승격 밖) · 그림자 작업은 키 자체가
 *     없다(호출자가 null 을 받는다 — 보안 리뷰 L8).
 */

import type { AiWatchAgentStatus, AiWatchBand, AiWatchJobState, AiWatchStatus, AiWatchVerdict } from './contract';

/** 표시에 필요한 작업 칸. */
export interface AiWatchJobFacts {
  readonly state: AiWatchJobState;
  readonly verdict: AiWatchVerdict | null;
  readonly band: AiWatchBand | null;
  readonly modelVersion: string | null;
  readonly late: boolean;
  readonly shadow: boolean;
  readonly deadline: Date;
}

export interface AiWatchOwnerView {
  readonly status: AiWatchStatus;
  readonly band: AiWatchBand | null;
  readonly modelVersion: string | null;
  readonly late: boolean;
}

export interface AiWatchAgentView {
  readonly status: AiWatchAgentStatus;
  /** `flagged`·`clear` 일 때만. */
  readonly modelVersion: string | null;
}

export function aiWatchOwnerStatus(job: AiWatchJobFacts, now: Date): AiWatchOwnerView {
  if (job.state === 'pending' && now.getTime() < job.deadline.getTime()) {
    return { status: 'pending', band: null, modelVersion: null, late: false };
  }
  if (job.state === 'done' && (job.verdict === 'flagged' || job.verdict === 'clear')) {
    return { status: job.verdict, band: job.band, modelVersion: job.modelVersion, late: job.late };
  }
  return { status: 'skipped', band: null, modelVersion: job.state === 'done' ? job.modelVersion : null, late: job.late };
}

/** 조직이 끈 때 · 작업이 없을 때 · 그림자 작업이면 null(키 없음). */
export function aiWatchAgentStatus(orgEnabled: boolean, job: AiWatchJobFacts | null): AiWatchAgentView | null {
  if (!orgEnabled) return null;
  if (job === null || job.shadow) return null;
  if (job.state === 'done' && (job.verdict === 'flagged' || job.verdict === 'clear')) {
    return { status: job.verdict, modelVersion: job.modelVersion };
  }
  return { status: 'unavailable', modelVersion: null };
}
