/**
 * HTTP API `atmark-billing`(payload v2, 라우트 `POST /paddle/webhook` 하나) → **Paddle 웹훅 수신**(WP-2, 계획 §3-1 · §3-2).
 *
 * **DB 없음 · VPC 밖 · 비밀 하나(웹훅 서명 비밀).** 하는 일은 넷뿐이다:
 *   ① 원문 바이트로 서명 검증(`src/billing/paddle/signature.ts` — HMAC-SHA256 · 상수 시간 비교 · 5초 창)
 *   ② 봉투에서 식별자만 뽑기(이메일·주소·금액·원문은 버린다)
 *   ③ 허용 이벤트(`BILLING_EVENT_TYPES`)만 SQS FIFO 에(`dedup = event_id` · 그룹 `sub:<id>`|`txn:<id>`|`ctm:<id>`)
 *   ④ 200. 판단(재조회·결속·엔타이틀먼트)은 sync λ 가 한다.
 *
 * 응답: 서명·창·헤더 실패 401 · 바디 1 MiB 초과 413 · 서명은 맞는데 봉투 모양이 틀림 400 · 허용 밖 이벤트 200(큐 0) ·
 * 비밀 자리표시·설정 오류 503 · SQS 실패 500 · 성공 200. Paddle 은 200 이 아니면 재시도한다(샌드박스 15분 · 운영 3일, P5) —
 * 그래서 우리 쪽 일시 실패(503·500)는 잃지 않는다. 401 은 알람 `atmark-billing-webhook-rejected`(5분 5건)가 본다.
 *
 * **로그에 바디·헤더가 없다.** 남는 것은 `event_id`(서명이 맞은 뒤에만) · 이벤트 종류 · 결과 코드 · 상태 코드뿐이다.
 * 발신 IP 는 Paddle 공개 목록과 대조해 **기록만** 한다(D-6 — 거부하지 않는다. 서명이 진짜 경계다).
 */

import { createHash } from 'node:crypto';

import { BILLING_EVENT_TYPES, type BillingEventType, type PaddleEnvironment } from '../../billing/constants';
import { PADDLE_SIGNATURE_HEADER, verifyPaddleSignature } from '../../billing/paddle/signature';
import {
  BILLING_QUEUE_MESSAGE_VERSION,
  billingMessageGroupId,
  diagnosticOrganizationId,
  isIsoInstant,
  PADDLE_ID_PATTERNS,
  serializeBillingQueueMessage,
  type BillingQueueMessage,
} from '../../billing/queue-message';
import { log } from '../../observability/logger';
import { countMetric, METRIC_NAMES } from '../../observability/metrics';
import {
  BillingWebhookNotConfiguredError,
  composeBillingWebhook,
  type BillingWebhookDependencies,
} from '../billing-webhook-composition';

export const BILLING_WEBHOOK_ROUTE_ID = 'billing-webhook';

/** 원문 바디 상한(바이트). Paddle 봉투는 수 KiB 다 — 넘으면 413(서명 계산 전). */
export const BILLING_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Paddle 웹훅 발신 IP(계획 §0 P9 · D-6 — **기록만**). 목록 밖이면 `billing.webhook_foreign_ip` +1 과 경고 로그 한 줄. 요청은 거부하지 않는다.
 * 값은 Paddle 문서 "Allow Paddle IP addresses"(2026-09-25 조회)이고, 샌드박스 E2E 에서 실제 발신 IP 와 대조해 확정한다(런북 billing.md).
 */
export const PADDLE_WEBHOOK_SOURCE_IPS: Readonly<Record<PaddleEnvironment, readonly string[]>> = {
  sandbox: ['34.194.127.46', '54.234.237.108', '3.208.120.145', '44.226.236.210', '44.241.183.62', '100.20.172.113'],
  production: ['34.232.58.13', '34.195.105.136', '34.237.3.244', '35.155.119.135', '52.11.166.252', '34.212.5.7'],
};

/** payload v2 중 읽는 필드. */
export interface BillingWebhookEvent {
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly requestContext?: { readonly http?: { readonly method?: string; readonly sourceIp?: string } };
}

export interface BillingWebhookResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function reply(statusCode: number, code: string): BillingWebhookResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    body: JSON.stringify({ result: code }),
  };
}

function headerOf(event: BillingWebhookEvent, name: string): string | undefined {
  const entry = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

/** 바디 바이트. 길이 상한은 디코드 **전에** 대략(문자 수) 보고 뒤에 정확히 본다. */
function rawBodyOf(event: BillingWebhookEvent): Buffer | 'too_large' {
  const body = event.body ?? '';
  if (body.length > (event.isBase64Encoded === true ? Math.ceil((BILLING_WEBHOOK_MAX_BODY_BYTES * 4) / 3) + 4 : BILLING_WEBHOOK_MAX_BODY_BYTES * 4)) {
    return 'too_large';
  }
  const bytes = event.isBase64Encoded === true ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
  return bytes.length > BILLING_WEBHOOK_MAX_BODY_BYTES ? 'too_large' : bytes;
}

type Envelope =
  | { readonly kind: 'ignored'; readonly eventId: string; readonly eventType: string }
  | { readonly kind: 'queued'; readonly message: BillingQueueMessage; readonly groupId: string };

function idOrNull(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

/**
 * 서명이 맞은 봉투를 읽는다. 모양이 틀리면 `null`(→ 400). **식별자만** 꺼낸다 — `data` 의 나머지(이메일·주소·금액·품목)는 어디에도 옮기지 않는다.
 */
function readPaddleEnvelope(
  rawBody: Buffer,
  environment: PaddleEnvironment,
  receivedAt: Date,
): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const envelope = parsed as Record<string, unknown>;
  const eventId = envelope['event_id'];
  const eventType = envelope['event_type'];
  const occurredAt = envelope['occurred_at'];
  const data = envelope['data'];
  if (typeof eventId !== 'string' || !PADDLE_ID_PATTERNS.event.test(eventId)) return null;
  if (typeof eventType !== 'string' || eventType.length === 0 || eventType.length > 64) return null;
  const allowed = BILLING_EVENT_TYPES.find((candidate): candidate is BillingEventType => candidate === eventType);
  if (allowed === undefined) return { kind: 'ignored', eventId, eventType };
  if (!isIsoInstant(occurredAt)) return null;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const entity = data as Record<string, unknown>;
  const customData = entity['custom_data'];
  const isSubscription = allowed.startsWith('subscription.');
  // 고객 이벤트(ADR-0014 M3b) — 엔터티가 고객이다. 구독 · 거래 id 는 싣지 않는다(이메일 · 이름도 싣지 않는다 — sync 가 재조회한다).
  const isCustomer = allowed.startsWith('customer.');
  const subscriptionId = isCustomer
    ? null
    : isSubscription
      ? idOrNull(entity['id'], PADDLE_ID_PATTERNS.subscription)
      : idOrNull(entity['subscription_id'], PADDLE_ID_PATTERNS.subscription);
  const transactionId = isCustomer
    ? null
    : isSubscription
      ? idOrNull(entity['transaction_id'], PADDLE_ID_PATTERNS.transaction)
      : idOrNull(entity['id'], PADDLE_ID_PATTERNS.transaction);
  const customerId = isCustomer ? idOrNull(entity['id'], PADDLE_ID_PATTERNS.customer) : idOrNull(entity['customer_id'], PADDLE_ID_PATTERNS.customer);
  // 엔터티 id 가 그 이벤트의 종류(구독 · 거래 · 고객)가 아니면 봉투가 틀렸다.
  if (isCustomer ? customerId === null : isSubscription ? subscriptionId === null : transactionId === null) return null;
  const message: BillingQueueMessage = {
    v: BILLING_QUEUE_MESSAGE_VERSION,
    provider: 'paddle',
    environment,
    eventId,
    eventType: allowed,
    occurredAt,
    notificationId: idOrNull(envelope['notification_id'], PADDLE_ID_PATTERNS.notification),
    payloadSha256: createHash('sha256').update(rawBody).digest('hex'),
    subscriptionId,
    transactionId,
    customerId,
    diagnostic: {
      customDataOrganizationId:
        typeof customData === 'object' && customData !== null && !Array.isArray(customData)
          ? diagnosticOrganizationId((customData as Record<string, unknown>)['atmark_organization_id'])
          : null,
    },
    receivedAt: receivedAt.toISOString(),
  };
  const groupId = billingMessageGroupId(message);
  if (groupId === null) return null;
  return { kind: 'queued', message, groupId };
}

/** 핸들러 — 조립은 첫 호출 때 한 번(성공한 것만 캐시). 테스트는 가짜 조립을 준다. */
export function createBillingWebhookHandler(compose: () => BillingWebhookDependencies) {
  let deps: BillingWebhookDependencies | undefined;
  return async (event: BillingWebhookEvent): Promise<BillingWebhookResult> => {
    const done = (status: number, outcome: string, fields: { reason?: string; trace_id?: string; detail?: string } = {}): BillingWebhookResult => {
      log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'billing.webhook', {
        route_id: BILLING_WEBHOOK_ROUTE_ID,
        http_status: status,
        outcome,
        reason: fields.reason ?? null,
        trace_id: fields.trace_id ?? null,
        detail: fields.detail ?? null,
      });
      return reply(status, outcome);
    };

    if ((event.requestContext?.http?.method ?? '').toUpperCase() !== 'POST') return done(405, 'method_not_allowed');

    try {
      deps ??= compose();
    } catch (error) {
      return done(503, 'unavailable', { reason: error instanceof Error ? error.name : 'unknown' });
    }

    const rawBody = rawBodyOf(event);
    if (rawBody === 'too_large') {
      countMetric(METRIC_NAMES.billingWebhookRejected);
      return done(413, 'too_large');
    }

    let secrets;
    try {
      secrets = await deps.loadSecrets();
    } catch (error) {
      const notConfigured = error instanceof BillingWebhookNotConfiguredError;
      return done(503, 'unavailable', { reason: notConfigured ? 'secret_not_configured' : 'secret_read_failed' });
    }

    const now = deps.now();
    const verdict = verifyPaddleSignature({
      header: headerOf(event, PADDLE_SIGNATURE_HEADER),
      rawBody,
      secrets,
      nowSeconds: Math.floor(now.getTime() / 1000),
    });
    if (!verdict.ok) {
      countMetric(METRIC_NAMES.billingWebhookRejected);
      return done(401, 'rejected', { reason: verdict.reason });
    }

    const envelope = readPaddleEnvelope(rawBody, deps.environment, now);
    if (envelope === null) {
      countMetric(METRIC_NAMES.billingWebhookRejected);
      return done(400, 'malformed');
    }

    const sourceIp = event.requestContext?.http?.sourceIp ?? '';
    if (!PADDLE_WEBHOOK_SOURCE_IPS[deps.environment].includes(sourceIp)) {
      countMetric(METRIC_NAMES.billingWebhookForeignIp);
      log('warn', 'billing.webhook_foreign_ip', { route_id: BILLING_WEBHOOK_ROUTE_ID, trace_id: envelope.kind === 'ignored' ? envelope.eventId : envelope.message.eventId });
    }

    if (envelope.kind === 'ignored') {
      countMetric(METRIC_NAMES.billingWebhookIgnored);
      return done(200, 'ignored', { trace_id: envelope.eventId, detail: envelope.eventType });
    }

    const { message, groupId } = envelope;
    try {
      await deps.queue.sendFifo({
        queueUrl: deps.queueUrl,
        body: serializeBillingQueueMessage(message),
        groupId,
        deduplicationId: message.eventId,
      });
    } catch (error) {
      return done(500, 'queue_failed', { trace_id: message.eventId, reason: error instanceof Error ? error.name : 'unknown' });
    }
    countMetric(METRIC_NAMES.billingWebhookAccepted);
    return done(200, 'accepted', { trace_id: message.eventId, detail: message.eventType });
  };
}

export const handler = createBillingWebhookHandler(() => composeBillingWebhook({ env: process.env }));
