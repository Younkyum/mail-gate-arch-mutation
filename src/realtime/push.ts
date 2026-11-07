/**
 * src/realtime/push.ts — **커밋 뒤 힌트 푸시**(best-effort · 최대 한 번). 만드는 쪽(수신 소비자 · 승인 링크 · 콘솔 풀기 · AI 감시 결과)이 자기 트랜잭션을
 * 커밋한 **뒤에** 부른다. 이 모듈은:
 *
 *   - **던지지 않는다.** 조회 실패 · 전송 실패 · 시간 초과는 경고 한 줄 + 메트릭(`realtime.push_failed`)으로 끝난다 — 만드는 쪽의 결말은 바뀌지 않는다.
 *   - **1초를 넘기지 않는다**(`REALTIME_PUSH_TIMEOUT_MS`) — 조회 + 전송 전부. 넘기면 남은 일을 버린다(전송은 AbortSignal 로 끊는다).
 *   - **누구에게 보낼지 스스로 정하지 않는다.** 대상(연결 id · 그 연결의 에이전트 · 이벤트 재료)은 DB 정의 함수가 정한다
 *     (`atmark_realtime_inbound_targets` 등 — 202610081300): **에이전트에게 지금 보이는 메일만**(격리 · 위험 보류 · AI 보류 중이면 0행) · 그 메일의
 *     에이전트의 열린 연결만(만료 · 닫힘 · 폐기된 토큰 · 정지된 에이전트/조직 제외). 그래서 호출자가 엉뚱한 id 를 넘겨도 남의 에이전트에게 가지 않는다.
 *   - 410 Gone(이미 끊긴 연결) → 그 행을 닫는다(`gone`).
 */

import { log } from '../observability/logger';
import { countMetric, METRIC_NAMES } from '../observability/metrics';
import { REALTIME_PUSH_TIMEOUT_MS } from './contract';
import { realtimeApprovalResolved, realtimeMessageReceived, type RealtimeEvent } from './events';

/** 받은 메일 대상 한 줄(연결 하나 × 메일 하나). */
export interface RealtimeInboundTarget {
  readonly connectionId: string;
  readonly agentId: string;
  readonly inboundMessageId: string;
  readonly threadId: string;
  readonly receivedAt: Date;
  readonly riskLevel: string | null;
}

/** 승인 결과 대상 한 줄(연결 하나). */
export interface RealtimeApprovalTarget {
  readonly connectionId: string;
  readonly agentId: string;
  readonly approvalId: string;
  readonly decision: string;
  readonly resolvedAt: Date;
  readonly messageIds: readonly string[];
}

/**
 * 대상 조회 포트 — 만드는 λ 의 DB 롤마다 쓸 수 있는 함수가 다르다(앱 · admin = 받은 메일 · 승인, AI 감시 = 작업). 없는 메서드는 그 λ 가 부르지 않는다.
 */
export interface RealtimeTargetStore {
  inboundTargets?(inboundMessageIds: readonly string[]): Promise<readonly RealtimeInboundTarget[]>;
  jobTargets?(jobId: string): Promise<readonly RealtimeInboundTarget[]>;
  approvalTargets?(approvalId: string): Promise<readonly RealtimeApprovalTarget[]>;
  /** 410 Gone — 연결 행을 닫는다(`close_reason = 'gone'`). */
  markGone(connectionId: string): Promise<void>;
}

/** API Gateway `@connections` 로 프레임 하나. `gone` = 410(이미 끊긴 연결). 그 밖의 실패는 던진다. */
export interface RealtimeTransport {
  post(connectionId: string, frame: string, signal: AbortSignal): Promise<'sent' | 'gone'>;
}

export interface RealtimePusher {
  /** 받은 메일이 보이게 됐을 수 있다(수신 · 풀기). 보이지 않는 메일은 DB 가 걸러 낸다. */
  messagesVisible(inboundMessageIds: readonly string[]): Promise<void>;
  /** AI 감시 판정 기록(보류가 풀렸다) — 그 작업의 메일들. */
  aiWatchReleased(jobId: string): Promise<void>;
  /** 승인 요청이 결정됐다(승인 · 거절). */
  approvalResolved(approvalId: string): Promise<void>;
}

interface RealtimePusherOptions {
  readonly targets: RealtimeTargetStore;
  readonly transport: RealtimeTransport;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  /** 로그의 `route_id`(누가 밀었나 — `inbound_consumer` 등). */
  readonly routeId: string;
}

class PushTimeout extends Error {
  constructor() {
    super('realtime push timed out');
    this.name = 'PushTimeout';
  }
}

export function createRealtimePusher(options: RealtimePusherOptions): RealtimePusher {
  const now = options.now ?? ((): Date => new Date());
  const timeoutMs = options.timeoutMs ?? REALTIME_PUSH_TIMEOUT_MS;

  /** 시간 상한 안에서 `work` 를 돌린다. 어떤 결말이든 던지지 않는다. */
  async function bounded(kind: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PushTimeout());
      }, timeoutMs);
    });
    const running = work(controller.signal);
    // 시간 초과 뒤에 늦게 끝나는 실패가 처리되지 않은 거부로 남지 않게.
    running.catch(() => undefined);
    try {
      await Promise.race([running, deadline]);
    } catch (error) {
      countMetric(METRIC_NAMES.realtimePushFailed);
      log('warn', 'realtime.push_failed', {
        route_id: options.routeId,
        reason: kind,
        error_kind: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function send(events: readonly { readonly connectionId: string; readonly event: RealtimeEvent }[], signal: AbortSignal): Promise<void> {
    let failed = 0;
    await Promise.all(
      events.map(async ({ connectionId, event }) => {
        try {
          const outcome = await options.transport.post(connectionId, event.frame, signal);
          if (outcome === 'gone') {
            await options.targets.markGone(connectionId);
            return;
          }
          countMetric(METRIC_NAMES.realtimePushed);
        } catch (error) {
          failed += 1;
          log('warn', 'realtime.post_failed', {
            route_id: options.routeId,
            agent_id: event.agentId,
            error_kind: error instanceof Error ? error.name : typeof error,
          });
        }
      }),
    );
    if (failed > 0) countMetric(METRIC_NAMES.realtimePushFailed);
  }

  /**
   * 행마다 프레임을 만든다 — 한 행이 빌더 검증을 못 넘으면(깨진 대상) **그 행만** 건너뛰고 메트릭을 남긴다(적대 검증 E3-I-007 — 나머지 행은 나간다).
   * 이벤트 id 는 (종류, 대상 id)에서 유도한다(`realtimeEventId`) — 연결이 달라도 · 다시 밀어도 같다.
   */
  function framesOf<Row extends { readonly connectionId: string; readonly agentId: string }>(
    rows: readonly Row[],
    build: (row: Row) => RealtimeEvent,
  ): { connectionId: string; event: RealtimeEvent }[] {
    const frames: { connectionId: string; event: RealtimeEvent }[] = [];
    for (const row of rows) {
      try {
        frames.push({ connectionId: row.connectionId, event: build(row) });
      } catch (error) {
        countMetric(METRIC_NAMES.realtimePushRowSkipped);
        log('warn', 'realtime.row_skipped', {
          route_id: options.routeId,
          error_kind: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    return frames;
  }

  function inboundEvents(rows: readonly RealtimeInboundTarget[]): { connectionId: string; event: RealtimeEvent }[] {
    const at = now();
    return framesOf(rows, (row) => realtimeMessageReceived(row, at));
  }

  return {
    messagesVisible(inboundMessageIds: readonly string[]): Promise<void> {
      const lookup = options.targets.inboundTargets;
      if (inboundMessageIds.length === 0 || lookup === undefined) return Promise.resolve();
      return bounded('message_received', async (signal) => {
        const rows = await lookup.call(options.targets, inboundMessageIds);
        if (rows.length > 0) await send(inboundEvents(rows), signal);
      });
    },

    aiWatchReleased(jobId: string): Promise<void> {
      const lookup = options.targets.jobTargets;
      if (lookup === undefined) return Promise.resolve();
      return bounded('ai_watch_released', async (signal) => {
        const rows = await lookup.call(options.targets, jobId);
        if (rows.length > 0) await send(inboundEvents(rows), signal);
      });
    },

    approvalResolved(approvalId: string): Promise<void> {
      const lookup = options.targets.approvalTargets;
      if (lookup === undefined) return Promise.resolve();
      return bounded('approval_resolved', async (signal) => {
        const rows = await lookup.call(options.targets, approvalId);
        if (rows.length === 0) return;
        const at = now();
        const frames = framesOf(rows, (row) => realtimeApprovalResolved(row, at));
        if (frames.length > 0) await send(frames, signal);
      });
    },
  };
}
