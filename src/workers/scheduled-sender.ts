/**
 * `workers/scheduled-sender` — 예약 발송 소비자 (`OUTBOUND_ROUTES.scheduled_send`).
 *
 * **워커에는 `Idempotency-Key` 헤더가 없다.** 매니페스트가 `kind: 'worker'` 에 그 필드를
 * 요구하지 않는 이유이고(§4.5-3), 중복 억제의 집행 지점이 헤더가 아니라 **조건부 UPDATE
 * lease** 라는 뜻이다. 그렇다고 멱등 키가 필요 없는 것은 아니다 — `messages` 의 outbound
 * 행은 DB CHECK `messages_outbound_requires_idempotency` 가 키를 NOT NULL 로 못박는다.
 * 그래서 **잡(job) 자신이 안정적인 키를 들고 와야 한다**(`scheduledIdempotencyKey` — `scheduled:{id}`).
 * 매 소비마다 새 키를 만들면 SQS 재전달 3회가 `messages` 3행이 되고, lease 는 서로 다른
 * 행에 걸리므로 아무것도 막지 못한다. **at-least-once 를 이기는 것은 키의 안정성이다.**
 *
 * 전송단은 주입받는다(`send.ts` 와 같은 이유 — 이 파일이 `ses-transport.ts` 를 import
 * 하면 Layer B 가 깨진다). 잡의 출처는 `scheduled_sends`(`runScheduledSenderTick`)다.
 *
 * ★ **평가 시점 = 발송 시점.** `runScheduledSend` 는 기한이 된 잡을 **지금** `prepareOutbound` → `dispatch` 에 넣는다.
 *   예약 생성 시점의 판정은 존재하지 않는다(`scheduled_sends` 에 판정 컬럼이 없다). 그 사이 kill-switch·억제·
 *   차단·예산이 바뀌면 지금의 판정을 따른다 — 승인 릴리스가 관문을 재통과하는 것과 같은 이유(§4.3).
 */

import { dispatch, type OutboundTransport } from '../policy/gate';
import { log } from '../observability/logger';
import { finalizeOutbound, gateDependenciesFor, prepareOutbound } from '../api/outbound-service';
import type { OutboundOutcome, OutboundServiceDependencies, PinnedRisk } from '../api/outbound-service';
import { DLP_FAMILIES, type DlpFamily } from '../security/dlp/scan';
import {
  MAX_SCHEDULED_ATTEMPTS,
  type ScheduledSendRecord,
  type ScheduledSendStore,
} from '../db/repositories/scheduled-send-store';
import type { AgentId } from '../db/schema';
import type { ScheduledContentStore } from '../storage/scheduled-content-store';

export const SCHEDULED_SEND_ROUTE_ID = 'scheduled_send';

/** 큐에서 꺼낸 한 건. HTTP 본문이 아니라 **잡**이므로 헤더도 토큰도 없다. */
export interface ScheduledSendJob {
  readonly agentId: AgentId;
  /** **잡마다 안정적인 값.** 재전달이 같은 값을 가져와야 유니크 인덱스가 중복을 죽인다. */
  readonly idempotencyKey: string;
  readonly fromAddress: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string | null;
  readonly traceId: string | null;
  readonly costCents: number;
  /** 예약을 만들 때 고정한 위험(ADR-0016 리뷰 H1). 틱이 예약 행에서 옮긴다. */
  readonly pinnedRisk?: PinnedRisk;
}

export interface ScheduledSenderDependencies {
  readonly service: OutboundServiceDependencies;
  /** 전송단. **주입받는다** — 조립은 프로세스 진입 지점(워커 런타임·데모)이 한다. */
  readonly transport: OutboundTransport;
}

/**
 * 잡 하나를 처리한다. **인증이 없다** — 워커는 이미 우리 컴퓨트 안이고, 대신 잡이
 * 가리키는 `agentId` 로 정책이 평가된다. 즉 권한의 출처가 토큰이 아니라 **정책**이다.
 * 그래서 워커라고 해서 관문을 건너뛸 수 있는 것이 아니다(AC-8: 우회 경로 0개).
 */
export async function runScheduledSend(
  deps: ScheduledSenderDependencies,
  job: ScheduledSendJob,
): Promise<OutboundOutcome> {
  const prepared = await prepareOutbound(deps.service, {
    routeId: SCHEDULED_SEND_ROUTE_ID,
    agentId: job.agentId,
    idempotencyKey: job.idempotencyKey,
    fromAddress: job.fromAddress,
    recipients: job.recipients,
    subject: job.subject,
    text: job.text,
    html: job.html,
    isThreadReply: false,
    traceId: job.traceId,
    costCents: job.costCents,
    ...(job.pinnedRisk === undefined ? {} : { pinnedRisk: job.pinnedRisk }),
  });
  if (prepared.kind === 'settled') {
    // **관문에 닿지 못하고 끝난 잡.** HTTP 경로에는 응답이 남지만 워커에는 아무것도
    // 남지 않는다 — 반환값은 큐 소비자가 버리면 그대로 사라진다. `invalid`·`conflict`
    // 가 조용히 쌓이면 "예약 발송이 안 나간다" 는 신고가 들어올 때까지 아무 데도
    // 안 보인다. `gate.attempt` 는 이 축을 볼 수 없다(관문을 지나지 않았으므로).
    log('warn', 'worker.job_settled_before_gate', {
      route_id: SCHEDULED_SEND_ROUTE_ID,
      agent_id: job.agentId,
      trace_id: job.traceId,
      outcome: prepared.outcome.kind,
    });
    return prepared.outcome;
  }

  // **지금** 평가한다(머리말 ★). `prepareOutbound` 가 만든 `DispatchRequest.now` 는 이 잡을 집은 시각이다.
  const outcome = await dispatch(gateDependenciesFor(deps.service, deps.transport), prepared.dispatchRequest);

  const settled = await finalizeOutbound(deps.service, prepared, outcome);

  // 잡 하나의 결말. `gate.attempt` 와 중복처럼 보이지만 축이 다르다 — 저쪽은
  // **관문의 판정**이고 이쪽은 **잡의 결말**이며, 둘은 `finalizeOutbound` 에서
  // 갈릴 수 있다(`sent` + `settled:false`).
  log('info', 'worker.job', {
    route_id: SCHEDULED_SEND_ROUTE_ID,
    agent_id: job.agentId,
    trace_id: job.traceId,
    message_id: prepared.dispatchRequest.messageId,
    outcome: settled.kind,
  });

  return settled;
}

// ---------------------------------------------------------------------------
// 틱 — `scheduled_sends` 에서 기한 된 예약을 집어 관문에 넣는다 (P3c)
// ---------------------------------------------------------------------------

export interface ScheduledSenderTickDependencies extends ScheduledSenderDependencies {
  readonly schedules: ScheduledSendStore;
  readonly content: ScheduledContentStore;
  /**
   * 임대 길이. 잡 하나(관문 + SES)의 최대 실행 시간보다 길어야 한다. 운영값 `LEASE_TTL_SECONDS`(300s) > Lambda 타임아웃(50s) —
   * 예약 **취소**(`scheduled-queries.ts`, 메일 기본기 A3)가 "임대가 풀렸으면 잡던 워커는 끝났다" 에 기대어 취소 여부를 정한다. 이 부등식은
   * `test/integration/workers/scheduled-cancel-race.test.ts`(AC-A3-5)가 단언한다.
   */
  readonly leaseSeconds: number;
  /** 에이전트 하나만 처리한다(`ScheduledSendStore.claimDue` 의 scope). 운영 워커는 비운다. */
  readonly onlyAgentId?: AgentId;
}

export interface ScheduledTickResult {
  readonly scheduleId: string;
  /** `OutboundOutcome.kind`, 또는 `abandoned`(시도 상한) · `retry`(일시 장애 — 임대 만료 뒤 다시 집힌다). */
  readonly outcome: string;
  readonly messageId: string | null;
}

/** 예약 행의 **안정적인** 멱등 키. 재전달·임대 만료 재시도가 같은 `messages` 행을 만난다. */
export function scheduledIdempotencyKey(scheduleId: string): string {
  return `scheduled:${scheduleId}`;
}

function messageIdOf(outcome: OutboundOutcome): string | null {
  switch (outcome.kind) {
    case 'replayed':
      return outcome.message.id;
    case 'invalid':
    case 'attachment_rejected':
      return null;
    default:
      return outcome.messageId;
  }
}

async function runOne(deps: ScheduledSenderTickDependencies, record: ScheduledSendRecord): Promise<ScheduledTickResult> {
  if (record.attemptCount > MAX_SCHEDULED_ATTEMPTS) {
    await deps.schedules.markDispatched(record.id, record.attemptCount, 'abandoned', null, deps.service.now());
    log('error', 'worker.job', {
      route_id: SCHEDULED_SEND_ROUTE_ID,
      agent_id: record.agentId,
      trace_id: record.traceId,
      outcome: 'abandoned',
      reason: 'max_attempts',
    });
    return { scheduleId: record.id, outcome: 'abandoned', messageId: null };
  }

  const content = await deps.content.load(record.id);
  const outcome = await runScheduledSend(deps, {
    agentId: record.agentId,
    idempotencyKey: scheduledIdempotencyKey(record.id),
    fromAddress: record.fromAddress,
    recipients: record.recipients,
    subject: content.subject,
    text: content.text,
    html: content.html,
    traceId: record.traceId,
    costCents: record.costCents,
    // ADR-0016 리뷰 H1 — 만들 때 고정한 위험. 발송 때의 판정과 합쳐 엄한 쪽이 이긴다.
    pinnedRisk: { tainted: record.riskTainted, dlp: record.riskDlp.filter((family): family is DlpFamily => (DLP_FAMILIES as readonly string[]).includes(family)) },
  });
  const messageId = messageIdOf(outcome);
  if (outcome.kind === 'replayed' && outcome.message.status === 'pending' && !outcome.message.gated) {
    // ★ **관문에 아직 닿지 않은 행의 재생이다** — 앞 시도가 INSERT 뒤·관문 전에 멈췄고, 그 관문 앞 임대가 아직 살아
    //   있어 이어받지 못했다(`PREPARE_CLAIM_SECONDS`). 여기서 `replayed` 로 닫으면 예약은 `dispatched` 인데 메일은
    //   `pending` 으로 영원히 남는다(검증 V2). 기록하지 않고 둔다 — 임대가 풀리면 다음 틱이 다시 집어 이어서 진행한다.
    log('warn', 'worker.job', {
      route_id: SCHEDULED_SEND_ROUTE_ID,
      agent_id: record.agentId,
      trace_id: record.traceId,
      message_id: messageId,
      outcome: 'retry',
      reason: 'ungated_pending',
    });
    return { scheduleId: record.id, outcome: 'retry', messageId };
  }
  // 0행이면 임대를 잃었다 — 다른 워커가 같은 멱등 키로 같은 결말을 기록한다.
  await deps.schedules.markDispatched(record.id, record.attemptCount, outcome.kind, messageId, deps.service.now());
  return { scheduleId: record.id, outcome: outcome.kind, messageId };
}

/**
 * 기한 된 예약을 최대 `limit` 개 처리한다. 잡 하나의 예외(DB·S3 일시 장애)는 그 잡만 `retry` 로 남기고 나머지를
 * 계속한다 — 임대가 만료되면 다음 틱이 다시 집는다(멱등 키가 중복 발송을 막는다).
 */
export async function runScheduledSenderTick(
  deps: ScheduledSenderTickDependencies,
  limit = 25,
): Promise<readonly ScheduledTickResult[]> {
  const due = await deps.schedules.claimDue(
    deps.service.now(),
    limit,
    deps.leaseSeconds,
    deps.onlyAgentId === undefined ? undefined : { agentId: deps.onlyAgentId },
  );
  const results: ScheduledTickResult[] = [];
  for (const record of due) {
    try {
      results.push(await runOne(deps, record));
    } catch (error) {
      log('error', 'worker.job', {
        route_id: SCHEDULED_SEND_ROUTE_ID,
        agent_id: record.agentId,
        trace_id: record.traceId,
        outcome: 'retry',
        error_kind: error instanceof Error ? error.name : typeof error,
      });
      results.push({ scheduleId: record.id, outcome: 'retry', messageId: null });
    }
  }
  return results;
}
