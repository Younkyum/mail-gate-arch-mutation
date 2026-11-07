/**
 * `workers/ai-watch-result` — AI 의심 메일 감시 결과 큐(`atmark-ai-watch-result`) 소비자(ADR-0017 초안 · 설계 §1.3).
 *
 * **경고 전용 측정의 기록 끝.** 판정은 작업 행(`ai_watch_jobs`)에 적히고 보류(`ai_hold_until`)를 풀 뿐이다 — 격리·정책·관문·승인·위험 보류·오염
 * 등급으로 가는 길은 없다(arch `ai-watch-boundary`). 발송하지 않는다(SES 0 · S3 0).
 *
 * 규율(`inbound-consumer` 와 같은 셋):
 *   ① **멱등.** 같은 결과가 두 번 와도, 모르는 job 이어도, 이미 결말 난 작업이어도 DB 함수가 0행으로 삼킨다(`ignored`) — Mac 은 임의의 메일에
 *      경고를 붙일 수 없다(작업은 inbound 가 만든다). 마감 뒤 10분 안의 결과는 `late` 로 적고, 그 뒤는 버린다(작업 `expired`).
 *   ② **입력 때문에는 던지지 않는다.** 계약(`parseAiWatchResult`) 위반은 `rejected` + 메트릭(`ai_watch.result_rejected{reason}`) — 재전달해도 같다.
 *   ③ **DB 일시 장애만 `failed`**(재전달 → maxReceive 3 → DLQ — 결과 메시지에는 본문이 없어 DLQ 보관이 괜찮다).
 * 로그·메트릭에 본문·발췌·점수 원값이 없다(애초에 선로에 없다). 남기는 것은 job id · 결말 · 사유 코드 · 지연.
 */

import type { AiWatchResultStore } from '../db/repositories/ai-watch-result-store';
import { parseAiWatchResult } from '../inbound/ai-watch/contract';
import { log } from '../observability/logger';
import { countMetric, emitMetric, METRIC_NAMES } from '../observability/metrics';
import type { RealtimePusher } from '../realtime/push';

export const AI_WATCH_RESULT_ROUTE_ID = 'ai_watch_result';

export interface AiWatchResultDependencies {
  readonly store: AiWatchResultStore;
  /**
   * 실시간 힌트(묶음 E — `realtime/push.ts`) — 판정 기록이 보류를 풀면(`recorded` · `late`) 그 작업의 메일을 민다. 생략하면 밀지 않는다. 받을 대상은
   * DB 정의 함수(`atmark_realtime_job_targets`)가 정한다 — 이 λ 는 메일 · 연결을 고르지 않는다(판정 쪽으로 가는 길도 아니다 — 힌트일 뿐).
   */
  readonly realtime?: RealtimePusher;
}

export interface AiWatchResultMessage {
  readonly receiptId: string | null;
  readonly body: string;
}

/** 한 건의 결말. `failed` 만 재전달된다. */
export type AiWatchResultOutcome = 'recorded' | 'late' | 'ignored' | 'heartbeat' | 'rejected' | 'failed';

export async function consumeAiWatchResult(deps: AiWatchResultDependencies, message: AiWatchResultMessage): Promise<AiWatchResultOutcome> {
  const parsed = parseAiWatchResult(message.body);
  if (!parsed.ok) {
    countMetric(METRIC_NAMES.aiWatchResultRejected, { reason: parsed.reason });
    log('warn', 'ai_watch.result_rejected', { route_id: AI_WATCH_RESULT_ROUTE_ID, trace_id: message.receiptId, reason: parsed.reason });
    return 'rejected';
  }
  const result = parsed.value;
  try {
    if (result.kind === 'heartbeat') {
      await deps.store.recordHeartbeat({
        workerId: result.worker_id,
        modelVersion: result.model_version,
        selfTestOk: result.self_test === 'pass',
        draining: result.draining,
      });
      countMetric(METRIC_NAMES.aiWatchHeartbeat);
      // 보존(90일)도 하트비트에 얹는다(1분에 한 번 · 인자 없는 정의 함수). 실패해도 하트비트는 기록됐다 — 다음 하트비트가 이어받는다.
      await deps.store.purgeExpired().catch((error: unknown) => {
        log('warn', 'ai_watch.purge_failed', {
          route_id: AI_WATCH_RESULT_ROUTE_ID,
          trace_id: message.receiptId,
          error_kind: error instanceof Error ? error.name : typeof error,
        });
      });
      if (result.self_test === 'fail') countMetric(METRIC_NAMES.aiWatchSelfTestFail);
      log(result.self_test === 'fail' ? 'warn' : 'debug', 'ai_watch.heartbeat', {
        route_id: AI_WATCH_RESULT_ROUTE_ID,
        trace_id: message.receiptId,
        outcome: result.draining ? 'draining' : result.self_test,
        detail: result.model_version,
      });
      return 'heartbeat';
    }
    const recorded = await deps.store.recordVerdict({
      jobId: result.job_id,
      verdict: result.verdict,
      band: result.band,
      modelVersion: result.model_version,
    });
    if (recorded.outcome !== 'ignored') {
      countMetric(METRIC_NAMES.aiWatchVerdicts, { outcome: recorded.outcome === 'late' ? 'late' : 'ontime' });
      if (recorded.latencyMs !== null) emitMetric(METRIC_NAMES.aiWatchVerdictLatencyMs, recorded.latencyMs, 'Milliseconds');
      if (result.verdict === 'flagged' && (result.band === 'high' || result.band === 'mid')) {
        countMetric(METRIC_NAMES.aiWatchFlags, { outcome: result.band });
      }
    }
    log('info', 'ai_watch.verdict', {
      route_id: AI_WATCH_RESULT_ROUTE_ID,
      trace_id: message.receiptId,
      outcome: recorded.outcome,
      verdict: result.verdict,
      detail: result.job_id,
    });
    // 기록은 커밋됐다(정의 함수 한 번). 힌트는 던지지 않고 1초를 넘기지 않는다.
    if (recorded.outcome !== 'ignored' && deps.realtime !== undefined) await deps.realtime.aiWatchReleased(result.job_id);
    return recorded.outcome;
  } catch (error) {
    log('error', 'ai_watch.result_failed', {
      route_id: AI_WATCH_RESULT_ROUTE_ID,
      trace_id: message.receiptId,
      reason: 'transient_failure',
      error_kind: error instanceof Error ? error.name : typeof error,
    });
    return 'failed';
  }
}
