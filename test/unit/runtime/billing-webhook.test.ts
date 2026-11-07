/**
 * 결제 웹훅 λ 핸들러(`src/runtime/handlers/billing-webhook.ts`) — 계획 수용 기준 B-2.
 *
 * 가짜 조립(비밀 · 큐 · 시계)으로 HTTP API payload v2 를 넣고 응답·큐·메트릭·로그를 본다. 센티넬(이메일·주소·금액·헤더 값)이
 * 큐 본문과 로그 어디에도 나오지 않음을 단언한다.
 */

import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { BILLING_EVENT_TYPES } from '../../../src/billing/constants';
import type { PaddleWebhookSecrets } from '../../../src/billing/paddle/signature';
import { parseBillingQueueMessage } from '../../../src/billing/queue-message';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { METRIC_NAMES } from '../../../src/observability/metrics';
import { BillingWebhookNotConfiguredError, type BillingWebhookDependencies } from '../../../src/runtime/billing-webhook-composition';
import {
  BILLING_WEBHOOK_MAX_BODY_BYTES,
  createBillingWebhookHandler,
  PADDLE_WEBHOOK_SOURCE_IPS,
  type BillingWebhookEvent,
} from '../../../src/runtime/handlers/billing-webhook';

const SECRET = 'test-webhook-secret-current-0123456789';
const NOW = new Date('2026-09-25T09:00:00.000Z');
const TS = Math.floor(NOW.getTime() / 1000);
const EVENT_ID = 'evt_01hv0000000000000000000abc';
const SUB_ID = 'sub_01hv0000000000000000000abc';
const TXN_ID = 'txn_01hv0000000000000000000abc';
const CTM_ID = 'ctm_01hv0000000000000000000abc';
const NTF_ID = 'ntf_01hv0000000000000000000abc';
const ORG_ID = '7f1c2a90-1111-4222-8333-444455556666';
const SANDBOX_IP = PADDLE_WEBHOOK_SOURCE_IPS.sandbox[0] ?? '';

/** 봉투에 섞는 개인정보 센티넬 — 큐·로그 어디에도 나오면 안 된다. */
const SENTINELS = ['sentinel-buyer@example.com', 'Sentinel Street 42', '987654321', 'SENTINEL-CARD-4242'];

interface Sent {
  readonly queueUrl: string;
  readonly body: string;
  readonly groupId: string;
  readonly deduplicationId: string;
}

function envelope(eventType: string, data: Record<string, unknown>): string {
  return JSON.stringify({
    event_id: EVENT_ID,
    event_type: eventType,
    occurred_at: '2026-09-25T08:59:58.123456Z',
    notification_id: NTF_ID,
    data: {
      ...data,
      customer: { email: SENTINELS[0], address: { first_line: SENTINELS[1] } },
      details: { totals: { grand_total: SENTINELS[2] } },
      payments: [{ method_details: { card: { last4: SENTINELS[3] } } }],
    },
  });
}

const SUBSCRIPTION_BODY = envelope('subscription.updated', {
  id: SUB_ID,
  customer_id: CTM_ID,
  transaction_id: TXN_ID,
  custom_data: { atmark_organization_id: ORG_ID },
  status: 'active',
});
const TRANSACTION_BODY = envelope('transaction.completed', { id: TXN_ID, subscription_id: SUB_ID, customer_id: CTM_ID });
const TRANSACTION_NO_SUB_BODY = envelope('transaction.payment_failed', { id: TXN_ID, subscription_id: null, customer_id: CTM_ID });

function signed(body: string, options: { secret?: string; ts?: number; base64?: boolean; ip?: string; header?: string } = {}): BillingWebhookEvent {
  const ts = options.ts ?? TS;
  const h1 = createHmac('sha256', options.secret ?? SECRET).update(`${String(ts)}:`).update(Buffer.from(body, 'utf8')).digest('hex');
  return {
    body: options.base64 === true ? Buffer.from(body, 'utf8').toString('base64') : body,
    isBase64Encoded: options.base64 === true,
    headers: { 'Paddle-Signature': options.header ?? `ts=${String(ts)};h1=${h1}`, 'content-type': 'application/json' },
    requestContext: { http: { method: 'POST', sourceIp: options.ip ?? SANDBOX_IP } },
  };
}

function harness(overrides: { secrets?: () => Promise<PaddleWebhookSecrets>; queueFails?: boolean; compose?: () => BillingWebhookDependencies } = {}) {
  const sent: Sent[] = [];
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  const deps: BillingWebhookDependencies = {
    environment: 'sandbox',
    queueUrl: 'https://sqs.ap-northeast-2.amazonaws.com/123456789012/atmark-billing-events.fifo',
    queue: {
      async sendFifo(input) {
        if (overrides.queueFails === true) throw Object.assign(new Error('sqs down'), { name: 'ServiceUnavailable' });
        sent.push(input);
      },
    },
    loadSecrets: overrides.secrets ?? (async () => ({ current: SECRET, previous: null })),
    now: () => NOW,
  };
  const handler = createBillingWebhookHandler(overrides.compose ?? (() => deps));
  const metrics = (): string[] =>
    lines
      .map((line) => JSON.parse(line) as { _aws?: { CloudWatchMetrics: { Metrics: { Name: string }[] }[] } })
      .filter((entry) => entry._aws !== undefined)
      .map((entry) => entry._aws?.CloudWatchMetrics[0]?.Metrics[0]?.Name ?? '');
  return { handler, sent, lines, metrics };
}

afterEach(() => {
  resetLogSink();
});

describe('결제 웹훅 — 성공 경로', () => {
  it('구독 이벤트: 200 · 큐 1 · dedup = event_id · 그룹 sub:<id> · 메시지는 sync 파서가 읽는다', async () => {
    const h = harness();
    const response = await h.handler(signed(SUBSCRIPTION_BODY));
    expect(response.statusCode).toBe(200);
    expect(h.sent).toHaveLength(1);
    const [message] = h.sent;
    expect(message?.deduplicationId).toBe(EVENT_ID);
    expect(message?.groupId).toBe(`sub:${SUB_ID}`);
    expect(message?.queueUrl).toMatch(/\.fifo$/);
    const parsed = parseBillingQueueMessage(message?.body ?? '');
    expect(parsed).toMatchObject({
      v: 1,
      provider: 'paddle',
      environment: 'sandbox',
      eventId: EVENT_ID,
      eventType: 'subscription.updated',
      notificationId: NTF_ID,
      subscriptionId: SUB_ID,
      transactionId: TXN_ID,
      customerId: CTM_ID,
      receivedAt: NOW.toISOString(),
    });
    expect(parsed?.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    // 진단 칸은 큐에 실리지만 sync 파서가 벗겨 낸다.
    expect(JSON.parse(message?.body ?? '{}')).toMatchObject({ diagnostic: { customDataOrganizationId: ORG_ID } });
    expect(parsed).not.toHaveProperty('diagnostic');
    expect(h.metrics()).toEqual([METRIC_NAMES.billingWebhookAccepted]);
  });

  it('거래 이벤트: 구독을 알면 그룹 sub:<id> · 모르면 txn:<id>', async () => {
    const withSub = harness();
    expect((await withSub.handler(signed(TRANSACTION_BODY))).statusCode).toBe(200);
    expect(withSub.sent[0]?.groupId).toBe(`sub:${SUB_ID}`);
    resetLogSink();
    const noSub = harness();
    expect((await noSub.handler(signed(TRANSACTION_NO_SUB_BODY))).statusCode).toBe(200);
    expect(noSub.sent[0]?.groupId).toBe(`txn:${TXN_ID}`);
    expect(parseBillingQueueMessage(noSub.sent[0]?.body ?? '')).toMatchObject({ subscriptionId: null, transactionId: TXN_ID });
  });

  it('base64 바디(isBase64Encoded)도 원문 바이트로 검증한다', async () => {
    const h = harness();
    expect((await h.handler(signed(SUBSCRIPTION_BODY, { base64: true }))).statusCode).toBe(200);
    expect(h.sent).toHaveLength(1);
  });

  it('허용 13종 모두 큐에 간다(고객 둘 — ADR-0014 M3b)', async () => {
    for (const type of BILLING_EVENT_TYPES) {
      resetLogSink();
      const h = harness();
      const body = type.startsWith('subscription.')
        ? envelope(type, { id: SUB_ID, customer_id: CTM_ID })
        : type.startsWith('customer.')
          ? envelope(type, { id: CTM_ID, email: 'person@example.com' })
          : envelope(type, { id: TXN_ID, subscription_id: SUB_ID, customer_id: CTM_ID });
      expect((await h.handler(signed(body))).statusCode, type).toBe(200);
      expect(h.sent, type).toHaveLength(1);
    }
  });

  it('고객 이벤트: 그룹 ctm:<id> · 구독 · 거래 id 없음 · 이메일은 큐 메시지에 없다 · 엔터티가 고객이 아니면 400', async () => {
    const h = harness();
    expect((await h.handler(signed(envelope('customer.updated', { id: CTM_ID, email: 'person@example.com' })))).statusCode).toBe(200);
    expect(h.sent[0]?.groupId).toBe(`ctm:${CTM_ID}`);
    expect(h.sent[0]?.body ?? '').not.toContain('person@example.com');
    expect(parseBillingQueueMessage(h.sent[0]?.body ?? '')).toMatchObject({ eventType: 'customer.updated', subscriptionId: null, transactionId: null, customerId: CTM_ID });
    const wrong = harness();
    expect((await wrong.handler(signed(envelope('customer.updated', { id: SUB_ID })))).statusCode).toBe(400);
    expect(wrong.sent).toEqual([]);
  });
});

describe('결제 웹훅 — 거부·무시', () => {
  it('허용 밖 이벤트: 200 · 큐 0 · ignored 메트릭', async () => {
    const h = harness();
    for (const type of ['subscription.imported', 'transaction.paid', 'customer.imported', 'address.created']) {
      const response = await h.handler(signed(envelope(type, { id: SUB_ID })));
      expect(response.statusCode, type).toBe(200);
    }
    expect(h.sent).toEqual([]);
    expect(new Set(h.metrics())).toEqual(new Set([METRIC_NAMES.billingWebhookIgnored]));
  });

  it('서명 실패: 401 · 큐 0 · rejected 메트릭 — 헤더 없음 · 다른 비밀 · 창 밖 · 바디 변조', async () => {
    const h = harness();
    const cases: BillingWebhookEvent[] = [
      { ...signed(SUBSCRIPTION_BODY), headers: {} },
      signed(SUBSCRIPTION_BODY, { secret: 'another-secret-value-000000000' }),
      signed(SUBSCRIPTION_BODY, { ts: TS - 6 }),
      { ...signed(SUBSCRIPTION_BODY), body: SUBSCRIPTION_BODY.replace('active', 'paused') },
    ];
    for (const event of cases) expect((await h.handler(event)).statusCode).toBe(401);
    expect(h.sent).toEqual([]);
    expect(h.metrics()).toEqual(Array(cases.length).fill(METRIC_NAMES.billingWebhookRejected));
  });

  it('서명은 맞는데 봉투 모양이 틀림: 400 · 큐 0', async () => {
    const h = harness();
    for (const body of [
      'not json',
      JSON.stringify({ event_id: 'evt_bad', event_type: 'subscription.updated', occurred_at: '2026-09-25T08:59:58Z', data: { id: SUB_ID } }),
      JSON.stringify({ event_id: EVENT_ID, event_type: 'subscription.updated', occurred_at: 'yesterday', data: { id: SUB_ID } }),
      JSON.stringify({ event_id: EVENT_ID, event_type: 'subscription.updated', occurred_at: '2026-09-25T08:59:58Z', data: { id: TXN_ID } }),
      JSON.stringify({ event_id: EVENT_ID, event_type: 'transaction.completed', occurred_at: '2026-09-25T08:59:58Z', data: { id: SUB_ID } }),
      JSON.stringify({ event_id: EVENT_ID, event_type: 'subscription.updated', occurred_at: '2026-09-25T08:59:58Z', data: [] }),
    ]) {
      expect((await h.handler(signed(body))).statusCode, body).toBe(400);
    }
    expect(h.sent).toEqual([]);
  });

  it('바디 1 MiB 초과: 413 · 서명 계산 전 · 큐 0', async () => {
    const h = harness();
    const big = 'x'.repeat(BILLING_WEBHOOK_MAX_BODY_BYTES + 1);
    expect((await h.handler(signed(big))).statusCode).toBe(413);
    expect((await h.handler(signed(big, { base64: true }))).statusCode).toBe(413);
    expect(h.sent).toEqual([]);
  });

  it('POST 가 아니면 405', async () => {
    const h = harness();
    expect((await h.handler({ ...signed(SUBSCRIPTION_BODY), requestContext: { http: { method: 'GET' } } })).statusCode).toBe(405);
  });
});

describe('결제 웹훅 — 설정 전 · 일시 실패', () => {
  it('비밀 자리표시(설정 전): 503 · 큐 0', async () => {
    const h = harness({
      secrets: async () => {
        throw new BillingWebhookNotConfiguredError('placeholder');
      },
    });
    const response = await h.handler(signed(SUBSCRIPTION_BODY));
    expect(response.statusCode).toBe(503);
    expect(h.sent).toEqual([]);
    expect(h.lines.join('\n')).toContain('secret_not_configured');
  });

  it('비밀 읽기 실패: 503(Paddle 이 재시도)', async () => {
    const h = harness({
      secrets: async () => {
        throw new Error('throttled');
      },
    });
    expect((await h.handler(signed(SUBSCRIPTION_BODY))).statusCode).toBe(503);
  });

  it('조립 실패(환경 오류): 503 — 다음 호출이 다시 조립한다', async () => {
    let calls = 0;
    const h = harness({
      compose: () => {
        calls += 1;
        throw new Error('ATMARK_PADDLE_ENV missing');
      },
    });
    expect((await h.handler(signed(SUBSCRIPTION_BODY))).statusCode).toBe(503);
    expect((await h.handler(signed(SUBSCRIPTION_BODY))).statusCode).toBe(503);
    expect(calls).toBe(2);
  });

  it('SQS 실패: 500(Paddle 이 재시도) · accepted 메트릭 없음', async () => {
    const h = harness({ queueFails: true });
    expect((await h.handler(signed(SUBSCRIPTION_BODY))).statusCode).toBe(500);
    expect(h.metrics()).not.toContain(METRIC_NAMES.billingWebhookAccepted);
  });
});

describe('결제 웹훅 — 개인정보 · 로그', () => {
  it('큐 본문에 이메일·주소·금액·카드·원문이 없다(센티넬)', async () => {
    const h = harness();
    await h.handler(signed(SUBSCRIPTION_BODY));
    const body = h.sent[0]?.body ?? '';
    for (const sentinel of SENTINELS) expect(body).not.toContain(sentinel);
    expect(body).not.toContain('"customer"');
    expect(body).not.toContain('"status"');
    expect(body.length).toBeLessThan(1024);
  });

  it('로그에 바디·서명 헤더·센티넬이 없다 — 성공·거부·무시 모두', async () => {
    const h = harness();
    const ok = signed(SUBSCRIPTION_BODY);
    const bad = signed(SUBSCRIPTION_BODY, { secret: 'another-secret-value-000000000' });
    await h.handler(ok);
    await h.handler(bad);
    await h.handler(signed(envelope('customer.updated', { id: SUB_ID })));
    const text = h.lines.join('\n');
    for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
    expect(text).not.toContain(ok.headers?.['Paddle-Signature'] ?? 'x');
    expect(text).not.toContain(bad.headers?.['Paddle-Signature'] ?? 'x');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(ORG_ID);
    expect(text).not.toContain(CTM_ID);
  });

  it('발신 IP 가 Paddle 목록 밖이면 기록만 한다(200 · foreign_ip 메트릭)', async () => {
    const h = harness();
    expect((await h.handler(signed(SUBSCRIPTION_BODY, { ip: '198.51.100.7' }))).statusCode).toBe(200);
    expect(h.sent).toHaveLength(1);
    expect(h.metrics()).toContain(METRIC_NAMES.billingWebhookForeignIp);
    expect(h.lines.join('\n')).not.toContain('198.51.100.7');
  });

  it('Paddle 발신 IP 목록은 환경마다 여섯 개 · 형식이 IPv4 · 서로 겹치지 않는다', () => {
    const all = [...PADDLE_WEBHOOK_SOURCE_IPS.sandbox, ...PADDLE_WEBHOOK_SOURCE_IPS.production];
    expect(PADDLE_WEBHOOK_SOURCE_IPS.sandbox).toHaveLength(6);
    expect(PADDLE_WEBHOOK_SOURCE_IPS.production).toHaveLength(6);
    for (const ip of all) expect(ip).toMatch(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    expect(new Set(all).size).toBe(all.length);
  });
});
