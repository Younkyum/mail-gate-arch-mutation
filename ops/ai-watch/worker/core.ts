/**
 * ops/ai-watch/worker/core.ts — 작업 하나 · 하트비트 하나의 규칙(I/O 는 주입). `main.ts` 가 실제 SQS·모델을 꽂는다.
 *
 * 작업(요청 큐 메시지 하나)의 결말은 다섯 중 하나다(`outcome` — 로그 어휘):
 *   - `done`     — 계약대로 파싱 · 마감 전 · 추론 · 결과 송신 · **송신 뒤** 요청 삭제.
 *   - `expired`  — 마감(`deadline`)이 지났다 → 추론하지 않고 지우기만(설계 §2.2, `ai_watch.expired_on_worker`).
 *   - `rejected` — 계약 위반(독 메시지). job_id 를 읽을 수 있으면 `verdict:"error"` 를 보내고 지운다. 못 읽으면 지우기만.
 *   - `error`    — 추론이 던졌다 → `verdict:"error"` 를 보내고 지운다(같은 입력은 다시 던진다 — 재시도 무의미, inbound ② 규율).
 *   - `send_failed` — 결과 송신 실패 → **지우지 않는다**(가시성 15초 뒤 다시 받고, 마감이 지나면 `expired` 로 끝난다).
 *
 * 로그에는 job_id · 지연 · 판정 · 밴드 · 결말만(`log.ts` 허용 키). 본문·점수는 어디에도 남지 않는다.
 */

import {
  AI_WATCH_MAX_LATENCY_MS,
  AI_WATCH_MAX_QUEUE_LAG_MS,
  isAiWatchJobId,
  parseAiWatchRequest,
  serializeAiWatchResult,
  type AiWatchBand,
} from '../../../src/inbound/ai-watch/contract';
import { errorKind, type Logger } from './log';
import { verdictOf } from './score';

export interface ReceivedMessage {
  readonly body: string;
  readonly receiptHandle: string;
  /** SQS `SentTimestamp`(ms). 없으면 null. */
  readonly sentTimestampMs: number | null;
}

export interface WorkQueue {
  receive(signal: AbortSignal): Promise<ReceivedMessage[]>;
  deleteRequest(receiptHandle: string): Promise<void>;
  sendResult(body: string): Promise<void>;
}

export type Outcome = 'done' | 'expired' | 'rejected' | 'error' | 'send_failed';

export interface CoreDeps {
  readonly queue: WorkQueue;
  /** 발췌문 → 밴드(점수는 이 함수 안에서 끝난다). */
  readonly bandOf: (text: string) => Promise<AiWatchBand>;
  readonly logger: Logger;
  readonly modelVersion: string;
  readonly workerId: string;
  readonly now: () => number;
}

export interface CoreState {
  selfTest: 'pass' | 'fail';
  draining: boolean;
  lastQueueLagMs: number;
}

function clampInt(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value), max);
}

/** 계약 위반 본문에서 job_id 만 건져 본다(본문 나머지는 보지 않는다). */
export function salvageJobId(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const id = (parsed as Record<string, unknown>)['job_id'];
      return isAiWatchJobId(id) ? id : null;
    }
  } catch {
    // 아래로.
  }
  return null;
}

export class WorkerCore {
  public readonly state: CoreState = { selfTest: 'fail', draining: false, lastQueueLagMs: 0 };

  public constructor(private readonly deps: CoreDeps) {}

  /** 작업을 받아도 되는가 — 자기 시험 통과 · 배수 중 아님. */
  public get accepting(): boolean {
    return this.state.selfTest === 'pass' && !this.state.draining;
  }

  private async sendVerdict(jobId: string, verdict: 'flagged' | 'clear' | 'error', band: AiWatchBand | null, startedAt: number): Promise<boolean> {
    const body = serializeAiWatchResult({
      v: 1,
      kind: 'verdict',
      job_id: jobId,
      verdict,
      band,
      model_version: this.deps.modelVersion,
      latency_ms: clampInt(this.deps.now() - startedAt, AI_WATCH_MAX_LATENCY_MS),
    });
    try {
      await this.deps.queue.sendResult(body);
      return true;
    } catch (error) {
      this.deps.logger.log('warn', { event: 'result_send_failed', job_id: jobId, error_kind: errorKind(error) });
      return false;
    }
  }

  private async remove(receiptHandle: string, jobId: string | null): Promise<void> {
    try {
      await this.deps.queue.deleteRequest(receiptHandle);
    } catch (error) {
      // 지우기 실패 → 가시성 뒤 다시 온다. 결과는 이미 갔고 결과 λ 는 멱등(두 번째 판정은 0행)이다.
      this.deps.logger.log('warn', { event: 'request_delete_failed', job_id: jobId, error_kind: errorKind(error) });
    }
  }

  public async handle(message: ReceivedMessage): Promise<Outcome> {
    const startedAt = this.deps.now();
    if (message.sentTimestampMs !== null) this.state.lastQueueLagMs = clampInt(startedAt - message.sentTimestampMs, AI_WATCH_MAX_QUEUE_LAG_MS);
    const parsed = parseAiWatchRequest(message.body);
    if (!parsed.ok) {
      const jobId = salvageJobId(message.body);
      if (jobId !== null && !(await this.sendVerdict(jobId, 'error', null, startedAt))) return this.finish('send_failed', jobId, startedAt);
      await this.remove(message.receiptHandle, jobId);
      return this.finish('rejected', jobId, startedAt, { reason: parsed.reason });
    }
    const request = parsed.value;
    if (Date.parse(request.deadline) <= startedAt) {
      await this.remove(message.receiptHandle, request.job_id);
      return this.finish('expired', request.job_id, startedAt);
    }
    let band: AiWatchBand;
    try {
      band = await this.deps.bandOf(request.text);
    } catch (error) {
      if (!(await this.sendVerdict(request.job_id, 'error', null, startedAt))) return this.finish('send_failed', request.job_id, startedAt);
      await this.remove(message.receiptHandle, request.job_id);
      return this.finish('error', request.job_id, startedAt, { error_kind: errorKind(error) });
    }
    const verdict = verdictOf(band);
    if (!(await this.sendVerdict(request.job_id, verdict, band, startedAt))) return this.finish('send_failed', request.job_id, startedAt);
    await this.remove(message.receiptHandle, request.job_id);
    return this.finish('done', request.job_id, startedAt, { verdict, band });
  }

  private finish(outcome: Outcome, jobId: string | null, startedAt: number, extra: Record<string, string> = {}): Outcome {
    this.deps.logger.log(outcome === 'done' || outcome === 'expired' ? 'info' : 'warn', {
      event: 'job',
      outcome,
      job_id: jobId,
      latency_ms: clampInt(this.deps.now() - startedAt, AI_WATCH_MAX_LATENCY_MS),
      ...extra,
    });
    return outcome;
  }

  public receive(signal: AbortSignal): Promise<ReceivedMessage[]> {
    return this.deps.queue.receive(signal);
  }

  /** 하트비트 하나 — 실패해도 던지지 않는다(다음 주기가 잇는다). */
  public async heartbeat(): Promise<boolean> {
    const body = serializeAiWatchResult({
      v: 1,
      kind: 'heartbeat',
      worker_id: this.deps.workerId,
      model_version: this.deps.modelVersion,
      at: new Date(this.deps.now()).toISOString(),
      queue_lag_ms: this.state.lastQueueLagMs,
      self_test: this.state.selfTest,
      draining: this.state.draining,
    });
    try {
      await this.deps.queue.sendResult(body);
      this.deps.logger.log('info', { event: 'heartbeat', self_test: this.state.selfTest, draining: this.state.draining, queue_lag_ms: this.state.lastQueueLagMs });
      return true;
    } catch (error) {
      this.deps.logger.log('warn', { event: 'heartbeat_failed', error_kind: errorKind(error) });
      return false;
    }
  }
}
