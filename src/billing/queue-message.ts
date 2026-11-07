/**
 * src/billing/queue-message.ts — **결제 이벤트 큐 메시지 계약**(웹훅 λ → SQS FIFO `atmark-billing-events.fifo` → sync λ, 계획 §3-1 · §6-0).
 *
 * 웹훅 λ 는 Paddle 봉투에서 **식별자만** 뽑아 이 모양으로 넣는다 — 이메일·주소·금액·원문 바디·헤더는 싣지 않는다(개인정보 없는 작은 봉투).
 * sync λ 는 이 메시지를 "이 구독·거래가 바뀌었을 수 있다" 는 **신호**로만 쓰고 공급자 API 로 재조회한다(이벤트 본문을 믿지 않는다).
 *
 * **`diagnostic.customDataOrganizationId` 는 진단용이다.** 거래의 `custom_data` 는 공개 클라이언트 토큰으로도 채울 수 있다 — 결속의 근거가
 * 될 수 없다(결속 = 우리가 만든 거래 `billing_checkouts` 에서 나온 구독만, 계획 §3-6). 그래서 sync 가 받는 타입(`BillingSyncMessage`)에는
 * 그 칸이 **없다**: `parseBillingQueueMessage` 가 벗겨 낸다. sync 모듈이 그 필드를 읽지 않음은 C 의 단위 테스트가 소스로 단언한다.
 *
 * FIFO 규칙: `MessageDeduplicationId = eventId`(5분 창 — 영구 중복 제거는 `billing_events` PK) · `MessageGroupId = sub:<id>`(구독을 알면)
 * 아니면 `txn:<id>` — 같은 구독의 이벤트가 순서대로 한 번에 하나씩 처리된다(sync 동시성 1 과 겹쳐 조직 재계산이 경합하지 않는다).
 *
 * import 는 `constants.ts`(값만) 하나 — 웹훅 λ 번들이 DB 를 모르게.
 */

import {
  BILLING_EVENT_TYPES,
  BILLING_PROVIDERS,
  PADDLE_ENVIRONMENTS,
  type BillingEventType,
  type BillingProvider,
  type PaddleEnvironment,
} from './constants';

/** 메시지 형식 버전 — 바꾸면 sync 가 옛 형식을 거부한다(큐에 14일 남을 수 있으므로 올릴 때는 두 형식을 함께 읽는 판을 먼저 배포한다). */
export const BILLING_QUEUE_MESSAGE_VERSION = 1;

/** Paddle 식별자 모양(`evt_`·`ntf_`·`sub_`·`txn_`·`ctm_` + 소문자·숫자 26자). */
export const PADDLE_ID_PATTERNS = {
  event: /^evt_[a-z0-9]{26}$/,
  notification: /^ntf_[a-z0-9]{26}$/,
  subscription: /^sub_[a-z0-9]{26}$/,
  transaction: /^txn_[a-z0-9]{26}$/,
  customer: /^ctm_[a-z0-9]{26}$/,
} as const;

/** 진단용 조직 id 모양 — 모양이 아니면 `null` 로 적는다(임의 문자열을 큐·로그로 옮기지 않는다). */
const DIAGNOSTIC_ORG_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 웹훅 λ 가 쓰는 전체 메시지. */
export interface BillingQueueMessage {
  readonly v: typeof BILLING_QUEUE_MESSAGE_VERSION;
  readonly provider: BillingProvider;
  readonly environment: PaddleEnvironment;
  readonly eventId: string;
  readonly eventType: BillingEventType;
  /** 봉투의 `occurred_at`(ISO 8601) — 기록·진단용. 순서 판단은 재조회한 엔터티의 `updated_at` 이 한다(계획 §3-2). */
  readonly occurredAt: string;
  readonly notificationId: string | null;
  /** 원문 바디의 SHA-256(hex) — `billing_events.payload_sha256`. 원문은 어디에도 남지 않는다. */
  readonly payloadSha256: string;
  readonly subscriptionId: string | null;
  readonly transactionId: string | null;
  readonly customerId: string | null;
  readonly diagnostic: { readonly customDataOrganizationId: string | null };
  /** 웹훅 λ 가 받은 시각(ISO 8601). */
  readonly receivedAt: string;
}

/** sync λ 가 받는 모양 — `diagnostic` 이 **없다**(타입으로 분리 — 위 머리말). */
export type BillingSyncMessage = Omit<BillingQueueMessage, 'diagnostic'>;

/** FIFO 그룹 — 구독을 알면 구독, 아니면 거래, 고객 이벤트면 고객. 셋 다 없으면 만들 수 없다(웹훅 λ 가 그 봉투를 거부한다). */
export function billingMessageGroupId(
  message: Pick<BillingQueueMessage, 'subscriptionId' | 'transactionId'> & { readonly customerId?: string | null },
): string | null {
  if (message.subscriptionId !== null) return `sub:${message.subscriptionId}`;
  if (message.transactionId !== null) return `txn:${message.transactionId}`;
  if (message.customerId !== undefined && message.customerId !== null) return `ctm:${message.customerId}`;
  return null;
}

/** 진단 칸 값 — 모양이 아니면 `null`. */
export function diagnosticOrganizationId(value: unknown): string | null {
  return typeof value === 'string' && DIAGNOSTIC_ORG_ID_PATTERN.test(value) ? value : null;
}

/** 큐 본문(JSON). 키 순서는 고정(위 인터페이스 순서) — 같은 메시지는 같은 바이트다. */
export function serializeBillingQueueMessage(message: BillingQueueMessage): string {
  return JSON.stringify({
    v: message.v,
    provider: message.provider,
    environment: message.environment,
    eventId: message.eventId,
    eventType: message.eventType,
    occurredAt: message.occurredAt,
    notificationId: message.notificationId,
    payloadSha256: message.payloadSha256,
    subscriptionId: message.subscriptionId,
    transactionId: message.transactionId,
    customerId: message.customerId,
    diagnostic: { customDataOrganizationId: message.diagnostic.customDataOrganizationId },
    receivedAt: message.receivedAt,
  });
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** ISO 8601 시각 문자열(오프셋 필수) — 웹훅 봉투의 `occurred_at` 도 같은 규칙으로 본다. */
export function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

function nullableMatching(value: unknown, pattern: RegExp): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

/**
 * sync 쪽 파서 — 모양이 하나라도 어긋나면 `null`(던지지 않는다). **`diagnostic` 은 읽지도 돌려주지도 않는다.**
 * 구독·거래 id 가 둘 다 없는 메시지는 거부한다(재조회할 대상이 없다).
 */
export function parseBillingQueueMessage(body: string): BillingSyncMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (r['v'] !== BILLING_QUEUE_MESSAGE_VERSION) return null;
  const provider = BILLING_PROVIDERS.find((candidate) => candidate === r['provider']);
  const environment = PADDLE_ENVIRONMENTS.find((candidate) => candidate === r['environment']);
  const eventType = BILLING_EVENT_TYPES.find((candidate) => candidate === r['eventType']);
  const eventId = r['eventId'];
  const payloadSha256 = r['payloadSha256'];
  const notificationId = nullableMatching(r['notificationId'], PADDLE_ID_PATTERNS.notification);
  const subscriptionId = nullableMatching(r['subscriptionId'], PADDLE_ID_PATTERNS.subscription);
  const transactionId = nullableMatching(r['transactionId'], PADDLE_ID_PATTERNS.transaction);
  const customerId = nullableMatching(r['customerId'], PADDLE_ID_PATTERNS.customer);
  if (
    provider === undefined ||
    environment === undefined ||
    eventType === undefined ||
    typeof eventId !== 'string' ||
    !PADDLE_ID_PATTERNS.event.test(eventId) ||
    typeof payloadSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(payloadSha256) ||
    !isIsoInstant(r['occurredAt']) ||
    !isIsoInstant(r['receivedAt']) ||
    notificationId === undefined ||
    subscriptionId === undefined ||
    transactionId === undefined ||
    customerId === undefined ||
    // 구독 · 거래 이벤트는 둘 중 하나가 있어야 하고, 고객 이벤트(ADR-0014 M3b)는 고객 id 만 — 구독 · 거래 id 가 없다.
    (eventType.startsWith('customer.')
      ? customerId === null || subscriptionId !== null || transactionId !== null
      : subscriptionId === null && transactionId === null)
  ) {
    return null;
  }
  return {
    v: BILLING_QUEUE_MESSAGE_VERSION,
    provider,
    environment,
    eventId,
    eventType,
    occurredAt: r['occurredAt'] as string,
    notificationId,
    payloadSha256,
    subscriptionId,
    transactionId,
    customerId,
    receivedAt: r['receivedAt'] as string,
  };
}
