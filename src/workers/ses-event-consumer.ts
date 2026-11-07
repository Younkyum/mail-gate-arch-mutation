/**
 * `workers/ses-event-consumer` — SES 이벤트 소비자 (ADR-0004 결정 1, 계획 §11B B9).
 *
 * **발송하지 않는다.** 관문을 import 하지 않으며 `NON_SENDING_ENTRYPOINTS` 에 등록돼 있다.
 * 이 워커가 하는 일은 하나다: SNS 가 실어 온 SES 이벤트를 **우리 `message_id` 로** 기록한다.
 * 그 기록이 두 가지를 먹여 살린다 —
 *
 *   ① lease 만료 재전송 직전의 조회(`gate.consultSendEvidence`). ADR-0004 의 본문.
 *   ② bounce·complaint 율. SES 계정 정지로 직결되는 수치의 출처가 이 스트림이다
 *      (ADR-0004 Consequences: *"같은 조각이 알람 4·5 를 먹여 살린다"*).
 *
 * ---------------------------------------------------------------------------
 * ## 규율 셋
 * ---------------------------------------------------------------------------
 *
 * **① 소비자 자신이 멱등하다.** SNS/SQS 는 at-least-once 다. 같은 이벤트를 세 번 받아도
 * 기록은 한 벌이어야 하고, 그 집행은 애플리케이션 선조회가 아니라 유니크 인덱스다
 * (`ses_events_dedupe_key`). §4.5 가 발송 경로에 요구한 규율이 그대로 여기 온다.
 *
 * **② 페이로드는 외부 입력이다.** 형태를 믿지 않고, 파싱 실패로 던지지 않는다.
 * 큐 소비자에서 던지면 메시지가 재전달되는데 **파싱할 수 없는 메시지는 재전달해도
 * 영원히 파싱되지 않는다** — poison pill 이고 큐가 거기서 멈춘다. 그래서 파싱 실패는
 * `handled: false` 로 **드러내고 넘어간다**(호출자가 DLQ 로 보낼지 결정한다).
 *
 * **③ 정지가 조용하지 않게 한다.** 소비자가 죽으면 ①의 조회가 항상 비고, 우리는 그것을
 * "안 나갔다" 로 읽는다(ADR-0004 Consequences). 그래서 매 배치가 끝날 때 발송 시각과
 * 이벤트 시각을 대조해 판정하고(`mail/events/health.ts`), 정지면 error 로 올린다.
 * **판정은 이 파일 밖에 있다** — I/O 없는 함수라야 "유예를 넘겼는데도 ok 를 낸다" 같은
 * 회귀를 테스트가 잡을 수 있다.
 */

import { CONSUMER_STALE_AFTER_SECONDS, evaluateConsumerHealth } from '../mail/events/health';
import { parseSesEvent, sesEventFromAlignment } from '../mail/events/ses-event';
import { ATMARK_MESSAGE_ID_TAG } from '../mail/events/tag';
import { log } from '../observability/logger';
import { countMetric, METRIC_NAMES } from '../observability/metrics';
import type { SesEventRecordOutcome, SesEventStore } from '../db/repositories/ses-event-store';
import type { PlatformReputationResult } from '../mail/events/platform-reputation';

/** 매니페스트의 `NON_SENDING_ENTRYPOINTS` 항목과 같은 값. 로그의 `route_id` 축이다. */
export const SES_EVENT_CONSUMER_ROUTE_ID = 'ses_event_consumer';

export interface SesEventConsumerDependencies {
  readonly events: SesEventStore;
  readonly now: () => Date;
  /** 소비자 정지 판정의 유예(초). 기본은 `CONSUMER_STALE_AFTER_SECONDS`. */
  readonly staleAfterSeconds?: number;
}

/** 큐에서 꺼낸 한 건. **본문 문자열 그대로다** — 파싱은 이 워커의 일이다. */
export interface SesEventMessage {
  /** 큐가 부여한 식별자. 로그에만 쓰고 멱등성 판정에는 쓰지 않는다(봉투의 값이므로). */
  readonly receiptId: string | null;
  readonly body: string;
}

/** 한 건의 처리 결과. **넷인 것이 요점이다** — 넷의 운영적 의미가 전부 다르다. */
export type SesEventMessageOutcome =
  /** 처음 본 이벤트를 기록했다. */
  | 'recorded'
  /** 같은 이벤트의 재전달이었다. **정상이다**(at-least-once). */
  | 'duplicate'
  /** 우리가 구독하지 않는 종류였다. 정상이지만 급증은 구독 설정이 바뀌었다는 뜻이다. */
  | 'ignored'
  /** 파싱할 수 없었다. 재전달해도 결과가 같다 — 호출자가 DLQ 로 보낼 건. */
  | 'unparsable'
  /** 기록에 실패했다(DB). **재전달되어야 한다** — 이것만이 재시도가 의미 있는 실패다. */
  | 'failed';

/**
 * 메시지 한 건. **던지지 않는다** — DB 실패까지 값으로 돌려준다.
 *
 * DB 실패를 `'failed'` 로 구분하는 이유: 그것만이 **재전달이 도움이 되는** 실패다.
 * 파싱 실패와 한 통에 담으면 둘 중 하나는 잘못 다뤄진다 — poison pill 을 영원히
 * 재시도하거나, 일시적 DB 장애로 이벤트를 영영 잃거나.
 */
export async function consumeSesEvent(
  deps: SesEventConsumerDependencies,
  message: SesEventMessage,
): Promise<SesEventMessageOutcome> {
  const parsed = parseSesEvent(message.body, ATMARK_MESSAGE_ID_TAG);
  checkFromAlignment(message);

  if (parsed.kind === 'unparsable') {
    log('error', 'ses_event.unparsable', {
      route_id: SES_EVENT_CONSUMER_ROUTE_ID,
      trace_id: message.receiptId,
      reason: 'unparsable',
      detail: parsed.detail,
    });
    return 'unparsable';
  }

  if (parsed.kind === 'ignored') {
    log('debug', 'ses_event.ignored', {
      route_id: SES_EVENT_CONSUMER_ROUTE_ID,
      trace_id: message.receiptId,
      reason: parsed.eventType,
    });
    return 'ignored';
  }

  if (parsed.kind === 'system_suppression') {
    // 시스템 메일(로그인·가입·승인 알림)의 하드 바운스·불만(보안 검증 H2). 주소는 로그에 싣지 않는다 — 개수와 사유만.
    const { suppression } = parsed;
    let outcome: 'recorded' | 'duplicate';
    try {
      outcome = await deps.events.recordSystemMailSuppression(suppression);
    } catch (error) {
      log('error', 'ses_event.system_suppression_failed', {
        route_id: SES_EVENT_CONSUMER_ROUTE_ID,
        trace_id: message.receiptId,
        reason: suppression.reason,
        detail: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }
    log('warn', 'ses_event.system_suppression', {
      route_id: SES_EVENT_CONSUMER_ROUTE_ID,
      trace_id: message.receiptId,
      reason: suppression.reason,
      outcome,
      recipient_count: suppression.addresses.length,
    });
    return outcome;
  }

  const { event } = parsed;

  if (event.messageId === null) {
    // **조인할 수 없는 이벤트.** 버리지 않고 기록한다 — 이런 행이 쌓이는 것 자체가
    // `EmailTags` 배선이 끊겼다는 신호이고, 버리면 그 신호도 함께 사라진다.
    // 그리고 조용히 기록만 하지도 않는다: 이 상태가 지속되면 조회는 영원히 비고,
    // 우리는 그것을 "안 나갔다" 로 읽는다 — ADR-0004 이 없애려는 바로 그 상태다.
    log('warn', 'ses_event.unjoinable', {
      route_id: SES_EVENT_CONSUMER_ROUTE_ID,
      trace_id: message.receiptId,
      ses_message_id: event.sesMessageId,
      reason: event.eventType,
      detail: `${ATMARK_MESSAGE_ID_TAG} 태그가 없다 — 이 이벤트는 어떤 messages 행에도 붙지 않는다.`,
    });
  }

  let recorded: SesEventRecordOutcome;
  try {
    // 발송 결과(delivery·bounce·complaint)면 수신자를 함께 넘긴다 — 저장소가 기록과 같은 트랜잭션의 savepoint 에서 구독자에게 웹훅을 적는다
    // (메일 기본기 A4). 수신자 주소는 위치 계산에만 쓰이고 저장·로그되지 않는다.
    recorded = await deps.events.record(
      event,
      parsed.recipients === null ? undefined : { recipients: parsed.recipients, now: deps.now() },
    );
  } catch (error) {
    log('error', 'ses_event.record_failed', {
      route_id: SES_EVENT_CONSUMER_ROUTE_ID,
      message_id: event.messageId,
      ses_message_id: event.sesMessageId,
      trace_id: message.receiptId,
      reason: event.eventType,
      detail: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }

  const outcome = recorded === 'duplicate' ? 'duplicate' : 'recorded';
  if (typeof recorded === 'object') {
    // 기록은 커밋됐다. 그 사건의 웹훅만 savepoint 로 되돌렸다 — 영구 유실이므로 조용히 두지 않는다(0 이 정상인 메트릭).
    //   원인은 기존 어휘 둘로만 싣는다(코드 리뷰 M9): `error_kind`(오류 이름) · `error_code`(SQLSTATE — 알람 23 과 같은 규율). 메시지 본문은 없다.
    log('warn', 'ses_event.webhook_enqueue_failed', {
      route_id: SES_EVENT_CONSUMER_ROUTE_ID,
      message_id: event.messageId,
      ses_message_id: event.sesMessageId,
      trace_id: message.receiptId,
      reason: event.eventType,
      error_kind: recorded.errorKind,
      error_code: recorded.errorCode,
    });
    countMetric(METRIC_NAMES.webhookEnqueueFailed);
  }

  // 공유 도메인 조직 평판(202610131620) — bounce · complaint 를 기록했으면(재전달 포함 — 앞 판정이 실패했을 수 있다) 그 메시지의 조직을 판정한다.
  //   던지면 `failed`: 기록은 이미 커밋됐고 재전달은 `duplicate` 로 와서 판정만 다시 돈다(정의자 함수는 멱등 — 이미 동결이면 쓰기 0).
  if (event.messageId !== null && (event.eventType === 'bounce' || event.eventType === 'complaint')) {
    if (!(await checkPlatformReputation(deps, event.messageId, message.receiptId))) return 'failed';
  }

  log(outcome === 'recorded' ? 'info' : 'debug', 'ses_event.consumed', {
    route_id: SES_EVENT_CONSUMER_ROUTE_ID,
    message_id: event.messageId,
    ses_message_id: event.sesMessageId,
    trace_id: message.receiptId,
    reason: event.eventType,
    outcome,
  });
  return outcome;
}

/** Postgres SQLSTATE(5자) — 드라이버 오류가 아니면 `null`(메시지 본문은 싣지 않는다). */
function sqlStateCode(error: unknown): string | null {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/**
 * 공유 도메인 조직 평판 판정 하나(`src/mail/events/platform-reputation.ts`). 경고 · 동결 · 운영자 조직 예외는 로그(조직 id · 걸린 선 — 주소 없음) +
 * `platformReputationFlagged`(알람). 이미 동결 · 고객 도메인 · 판정 ok 는 조용하다. 던지면 error + `platformReputationCheckFailed` 이고 `false`.
 */
async function checkPlatformReputation(deps: SesEventConsumerDependencies, messageId: string, receiptId: string | null): Promise<boolean> {
  let result: PlatformReputationResult | null;
  try {
    result = await deps.events.checkPlatformReputation(messageId);
  } catch (error) {
    log('error', 'ses_event.platform_reputation_failed', {
      route_id: SES_EVENT_CONSUMER_ROUTE_ID,
      message_id: messageId,
      trace_id: receiptId,
      error_kind: error instanceof Error ? error.name : typeof error,
      error_code: sqlStateCode(error),
    });
    countMetric(METRIC_NAMES.platformReputationCheckFailed);
    return false;
  }
  if (result === null || result.outcome === 'ok' || result.outcome === 'not_platform' || result.outcome === 'already_frozen') return true;
  log(result.outcome === 'warn' ? 'warn' : 'error', 'ses_event.platform_reputation', {
    route_id: SES_EVENT_CONSUMER_ROUTE_ID,
    message_id: messageId,
    trace_id: receiptId,
    outcome: result.outcome,
    detail: `organization_id=${result.organizationId} reasons=${result.reasons.join(',')}`,
  });
  countMetric(METRIC_NAMES.platformReputationFlagged);
  return true;
}

/**
 * **헤더 From 대 발신 주소**(2026-09-24 최종 검증 M3b). 기록 결과와 무관하게 먼저 본다 — 사칭 메일은 이미 나갔고, 이 판정이 그것을
 * 아는 유일한 창이다. 어긋나면 `atmark.ses.from_mismatch`(알람 10) + error 로그. 주소는 싣지 않는다(판정 종류만).
 * `unknown`(헤더·발신 주소가 이벤트에 없다)은 세지 않는다 — 형태가 바뀐 것이지 사칭의 증거가 아니다.
 */
function checkFromAlignment(message: SesEventMessage): void {
  const alignment = sesEventFromAlignment(message.body);
  if (alignment !== 'mismatch' && alignment !== 'reserved') return;
  log('error', 'ses_event.from_mismatch', {
    route_id: SES_EVENT_CONSUMER_ROUTE_ID,
    trace_id: message.receiptId,
    reason: alignment,
    detail: '헤더 From 이 발신 주소(FromEmailAddress)와 다르거나 예약 주소(login@·support@)를 담았다 — ADR-0006 M3b.',
  });
  countMetric(METRIC_NAMES.sesFromMismatch);
}

/**
 * 소비자 정지 감지 (ADR-0004 Consequences 의 두 번째 창). 핸들러가 **배치마다 한 번** 부른다 — `freshness()` 는 `max()` 집계 둘이라
 * 건마다 부르면 이벤트 하나당 왕복이 하나 는다(정지 유예는 900초라 초 단위 판정이 필요 없다).
 *
 * **조회 실패를 `ok` 로 읽지 않는다.** `freshness()` 가 던지면 우리는 소비자가 도는지
 * 아닌지 모르는 상태이고, 그 모름을 "건강" 으로 바꾸면 알람이 정확히 필요한 순간에
 * 조용해진다 — 이 함수가 존재하는 이유가 그 조용함이다. `idle` 로 돌려주고 error 를 남긴다.
 */
export async function reportHealth(
  deps: SesEventConsumerDependencies,
): Promise<ReturnType<typeof evaluateConsumerHealth>> {
  const staleAfterSeconds = deps.staleAfterSeconds ?? CONSUMER_STALE_AFTER_SECONDS;

  let health: ReturnType<typeof evaluateConsumerHealth>;
  try {
    health = evaluateConsumerHealth(await deps.events.freshness(), deps.now(), staleAfterSeconds);
  } catch (error) {
    log('error', 'ses_event.health_unavailable', {
      route_id: SES_EVENT_CONSUMER_ROUTE_ID,
      reason: 'freshness_query_failed',
      detail: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'idle' };
  }

  if (health.kind === 'stalled') {
    // **이 한 줄이 "조용한 실패" 를 시끄럽게 만든다.**
    // 나간 메일이 있는데 그에 대한 이벤트가 유예를 넘겨 오지 않았다 — 그동안 관문의
    // 조회는 전부 비고, 그 빈 결과는 lease 만료 재전송을 유보시킨다(fail closed).
    // 즉 증상은 "메일이 안 나간다" 이지 "메일이 두 번 나간다" 가 아니다. 방향은 안전하지만
    // 원인은 여기에 있고, 여기서 말하지 않으면 아무 데서도 말하지 않는다.
    log('error', 'ses_event.consumer_stalled', {
      route_id: SES_EVENT_CONSUMER_ROUTE_ID,
      reason: 'consumer_stalled',
      latency_ms: health.staleSeconds * 1000,
      detail:
        `마지막 발송 이후 ${String(health.staleSeconds)}초 동안 SES 이벤트가 한 건도 들어오지 않았다 ` +
        `(유예 ${String(staleAfterSeconds)}초). 이 상태에서 lease 만료 재전송은 전부 유보된다 (ADR-0004).`,
    });
  }

  return health;
}
