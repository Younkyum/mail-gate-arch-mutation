/**
 * src/db/repositories/risk-signal-store.ts — 위험 신호 포트(`policy/risk-signals.ts`)의 Postgres 구현(ADR-0016 A).
 *
 * 에이전트의 최근 **T2** 노출(`agent_exposures`, 202610041000)만 읽는다 — 창 판정(4시간 · 7일)은 로더가 `security/taint.ts` 로 다시 한다. 기준 시각은
 * 관문의 `request.now` 다(노출 시각은 DB `now()`). 부분 색인 `agent_exposures_tainted_idx (agent_id, last_at DESC) WHERE level >= 2`.
 *
 * 허용 한도(5분)보다 먼 미래 시각의 행은 잘라서 유효로 둔다(`security/taint.ts` — fail closed). 그런 행이 있으면 메트릭·경고 한 줄로 드러낸다 —
 * 기록 시각이 DB `now()` 라 정상 경로에서는 생기지 않는다(DB 시계가 뒤로 갔거나 누가 손으로 썼다).
 *
 * 모드(관찰/강제)는 운영자 킬 스위치(`ATMARK_RISK_HOLD_ENFORCE`)를 조립 루트가 읽어 넘긴다 — 소유자·에이전트가 바꿀 자리가 없다.
 */

import { log } from '../../observability/logger';
import { emitMetric, METRIC_NAMES } from '../../observability/metrics';
import type { RiskHoldMode, RiskSignalSource } from '../../policy/risk-signals';
import { futureExposureCount, THREAD_SENDER_TAINT_WINDOW_MS, type TaintExposure } from '../../security/taint';
import type { Queryable } from '../client';
import { selectRows } from './rows';

interface ExposureRow {
  last_at: Date;
  thread_id: string;
  sender: string;
  reply_to: string[];
}

/** 한 번에 읽는 T2 노출 상한 — 창 판정에는 넉넉하다(에이전트 4시간 창은 한 행이면 열린다). 넘치면 가장 최근 것부터. */
export const RISK_SIGNAL_EXPOSURE_LIMIT = 5_000;

export function createPostgresRiskSignalSource(db: Queryable, options: { readonly mode: RiskHoldMode }): RiskSignalSource {
  return {
    async load({ agentId, now }) {
      const since = new Date(now.getTime() - THREAD_SENDER_TAINT_WINDOW_MS);
      const rows = await selectRows<ExposureRow>(
        db,
        `SELECT last_at, thread_id, sender, reply_to
           FROM agent_exposures
          WHERE agent_id = $1 AND level >= 2 AND last_at > $2
          ORDER BY last_at DESC
          LIMIT $3`,
        [agentId, since, RISK_SIGNAL_EXPOSURE_LIMIT],
      );
      // Reply-To 도 발신자 창에 든다(리뷰 M4) — 주소마다 같은 시각·스레드의 노출 한 줄로 편다.
      const exposures: TaintExposure[] = rows.flatMap((row) =>
        [row.sender, ...row.reply_to].map((address) => ({ level: 'T2' as const, exposedAt: row.last_at, threadId: row.thread_id, senderAddress: address })),
      );
      const future = futureExposureCount(exposures, now);
      if (future > 0) {
        emitMetric(METRIC_NAMES.exposureFuture, future, 'Count');
        log('warn', 'risk_hold.future_exposure', { route_id: 'risk_signals', agent_id: agentId, detail: `future_rows=${String(future)}` });
      }
      return { mode: options.mode, exposures };
    },
  };
}
