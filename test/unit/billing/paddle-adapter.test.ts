/**
 * Paddle 어댑터(`src/billing/paddle/adapter.ts`)와 HTTP 문(`src/billing/paddle/http.ts`) — 가짜 `fetch`(실제 Paddle 호출 0).
 *
 *   ① HTTP: 환경별 고정 호스트 · Bearer 키 · `Paddle-Version` · 리다이렉트 거부 · 상태 → 오류(401/403 auth · 404 not_found · 429 Retry-After ·
 *      5xx · 연결 실패 · 크기 초과 · JSON 아님) · 오류 메시지에 키·URL·본문 없음 · 경로 모양 밖은 보내지 않는다.
 *   ② 구독 정규화: 반복 가격 하나 → 요금제 · 모르는 가격 → null(모름) · 반복 둘 이상 → null · 기간 · 예약 변경 · `updated_at`(마이크로초) ·
 *      `custom_data` 조직(UUID 만) · 금액·주소·이메일은 결과에 없다 · 모양 위반은 `provider_response_invalid`.
 *   ③ 목록·거래: 페이지 커서 · id 필터 · 거래의 구독 필터 재확인 · 체크아웃 거래 요청 모양(custom_data 는 서버가 넣은 조직) · 취소 · 포털.
 *   ④ 입력 id 가 모양 밖이면 부르지 않는다(`ProviderNotFoundError`).
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import { createPaddleProvider, normalizePaddleSubscription } from '../../../src/billing/paddle/adapter';
import { createPaddleHttp, PADDLE_API_ORIGINS, PADDLE_MAX_RESPONSE_BYTES, type PaddleFetch } from '../../../src/billing/paddle/http';
import type { PaddlePriceTable } from '../../../src/billing/paddle/prices';
import {
  BillingProviderError,
  ProviderAuthError,
  ProviderNotFoundError,
  ProviderRateLimitedError,
  ProviderUnavailableError,
  type ProviderScheduledAction,
  type ProviderSubscriptionStatus,
} from '../../../src/billing/provider';
import type { BillingScheduledChangeAction, BillingSubscriptionStatus } from '../../../src/db/schema';

/** 가짜 벡터 — 실제 키 형식(`pdl_…`)이 아니다. */
const KEY = 'test-sync-key-0000000000000001';
const SUB = `sub_${'1'.repeat(26)}`;
const SUB2 = `sub_${'2'.repeat(26)}`;
const CTM = `ctm_${'3'.repeat(26)}`;
const TXN = `txn_${'4'.repeat(26)}`;
const TXN2 = `txn_${'5'.repeat(26)}`;
const PRO = `pri_${'a'.repeat(26)}`;
const TEAM = `pri_${'b'.repeat(26)}`;
const ADDON = `pri_${'c'.repeat(26)}`;
const ORG = '0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const PRICES: PaddlePriceTable = { [PRO]: 'pro', [TEAM]: 'team' };
/** 금액·주소·이메일 센티넬 — 정규화 결과에 나타나면 안 된다. */
const AMOUNT = '98765';
const EMAIL = 'payer@example.com';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly redirect: string;
}

type Reply = { status: number; json?: unknown; raw?: string; headers?: Record<string, string> } | Error;

function fakeFetch(replies: Reply[]): { fetchImpl: PaddleFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: PaddleFetch = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown), redirect: init.redirect });
    const reply = replies.length > 1 ? replies.shift() : replies[0];
    if (reply === undefined) return Promise.reject(new Error('응답 없음'));
    if (reply instanceof Error) return Promise.reject(reply);
    const text = reply.raw ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
    const headers = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return Promise.resolve({
      status: reply.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer as ArrayBuffer),
    });
  };
  return { fetchImpl, calls };
}

function item(priceId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'active',
    quantity: 1,
    recurring: true,
    price: { id: priceId, product_id: `pro_${'6'.repeat(26)}`, unit_price: { amount: AMOUNT, currency_code: 'USD' }, billing_cycle: { interval: 'month', frequency: 1 } },
    ...extra,
  };
}

function subscription(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SUB,
    status: 'active',
    customer_id: CTM,
    address_id: `add_${'7'.repeat(26)}`,
    currency_code: 'USD',
    created_at: '2026-10-01T00:00:00.000000Z',
    updated_at: '2026-10-02T03:04:05.123456Z',
    current_billing_period: { starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z' },
    scheduled_change: null,
    items: [item(PRO)],
    custom_data: { atmark_organization_id: ORG },
    billing_details: { enable_checkout: false, purchase_order_number: '', additional_information: EMAIL },
    management_urls: { update_payment_method: 'https://example.com/secret', cancel: 'https://example.com/secret' },
    ...overrides,
  };
}

function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TXN,
    status: 'completed',
    customer_id: CTM,
    subscription_id: SUB,
    custom_data: { atmark_organization_id: ORG },
    created_at: '2026-10-01T00:00:00.5Z',
    checkout: { url: `https://pay.atmark.ai/?_ptxn=${TXN}` },
    details: { totals: { total: AMOUNT } },
    ...overrides,
  };
}

function provider(replies: Reply[], environment: 'sandbox' | 'production' = 'sandbox') {
  const { fetchImpl, calls } = fakeFetch(replies);
  return { api: createPaddleProvider({ http: createPaddleHttp({ environment, apiKey: KEY, fetchImpl }), prices: PRICES }), calls };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('거부되지 않았다');
}

describe('① HTTP 문', () => {
  it('환경별 고정 호스트 · Bearer 키 · Paddle-Version · 리다이렉트 거부 · 쿼리는 인코딩', async () => {
    for (const environment of ['sandbox', 'production'] as const) {
      const { api, calls } = provider([{ status: 200, json: { data: [], meta: { pagination: { has_more: false } } } }], environment);
      await api.listSubscriptions({ statuses: ['active', 'past_due'] });
      const call = calls[0];
      expect(call?.url.startsWith(`${PADDLE_API_ORIGINS[environment]}/subscriptions?`)).toBe(true);
      expect(new URL(call?.url ?? '').searchParams.get('status')).toBe('active,past_due');
      expect(call?.headers['authorization']).toBe(`Bearer ${KEY}`);
      expect(call?.headers['paddle-version']).toBe('1');
      expect(call?.redirect).toBe('error');
    }
    expect(PADDLE_API_ORIGINS).toEqual({ sandbox: 'https://sandbox-api.paddle.com', production: 'https://api.paddle.com' });
  });

  it('상태 → 오류: 401·403 auth · 404 not_found · 429 Retry-After(자른 초) · 5xx · 연결 실패 · 크기 초과 · JSON 아님', async () => {
    const cases: Array<[Reply, (error: unknown) => void]> = [
      [{ status: 401 }, (e) => expect(e).toBeInstanceOf(ProviderAuthError)],
      [{ status: 403 }, (e) => expect(e).toBeInstanceOf(ProviderAuthError)],
      [{ status: 404 }, (e) => expect(e).toBeInstanceOf(ProviderNotFoundError)],
      [{ status: 429, headers: { 'retry-after': '30' } }, (e) => expect((e as ProviderRateLimitedError).retryAfterSeconds).toBe(30)],
      [{ status: 429, headers: { 'retry-after': '999999' } }, (e) => expect((e as ProviderRateLimitedError).retryAfterSeconds).toBe(3600)],
      [{ status: 429 }, (e) => expect((e as ProviderRateLimitedError).retryAfterSeconds).toBeNull()],
      [{ status: 503 }, (e) => expect((e as ProviderUnavailableError).code).toBe('provider_unavailable')],
      [{ status: 400, json: { error: { detail: EMAIL } } }, (e) => expect((e as ProviderUnavailableError).code).toBe('provider_unavailable')],
      [new Error('ECONNRESET'), (e) => expect((e as ProviderUnavailableError).code).toBe('provider_unavailable')],
      [{ status: 200, raw: 'x'.repeat(PADDLE_MAX_RESPONSE_BYTES + 1) }, (e) => expect((e as Error).message).toContain('response_too_large')],
      [{ status: 200, raw: '{}', headers: { 'content-length': String(PADDLE_MAX_RESPONSE_BYTES + 1) } }, (e) => expect((e as Error).message).toContain('response_too_large')],
      [{ status: 200, raw: '<html>' }, (e) => expect((e as ProviderUnavailableError).code).toBe('provider_response_invalid')],
    ];
    for (const [reply, check] of cases) {
      const { api } = provider([reply]);
      const error = await rejection(api.fetchSubscription(SUB));
      expect(error).toBeInstanceOf(BillingProviderError);
      check(error);
      // 오류 메시지에 키·호스트·본문이 없다 — 코드뿐.
      const message = (error as Error).message;
      for (const secret of [KEY, 'paddle.com', SUB, EMAIL]) expect(message, secret).not.toContain(secret);
    }
  });

  it('키 모양이 헤더를 깨면(공백·줄바꿈·빈 값) 만들지 않는다 · 경로 모양 밖은 보내지 않는다', async () => {
    for (const apiKey of ['', 'short', `${KEY}\r\nx-evil: 1`, `${KEY} `]) {
      expect(() => createPaddleHttp({ environment: 'sandbox', apiKey })).toThrow(ProviderAuthError);
    }
    const { fetchImpl, calls } = fakeFetch([{ status: 200, json: { data: null } }]);
    const http = createPaddleHttp({ environment: 'sandbox', apiKey: KEY, fetchImpl });
    for (const path of ['subscriptions', '/subscriptions/../customers', '/x?y=1', '//evil.example/a', '/a%2fb']) {
      await expect(http.get(path), path).rejects.toBeInstanceOf(ProviderUnavailableError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('② 구독 정규화', () => {
  it('반복 가격 하나 → 요금제 · 기간 · 예약 변경 없음 · updated_at 은 밀리초까지 · custom_data 조직', async () => {
    const { api, calls } = provider([{ status: 200, json: { data: subscription() } }]);
    const result = await api.fetchSubscription(SUB);
    expect(calls[0]?.url).toBe(`${PADDLE_API_ORIGINS.sandbox}/subscriptions/${SUB}`);
    expect(result).toEqual({
      provider: 'paddle',
      environment: 'sandbox',
      id: SUB,
      customerId: CTM,
      status: 'active',
      priceId: PRO,
      planCode: 'pro',
      currentPeriodStart: new Date('2026-10-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
      scheduledChange: null,
      updatedAt: new Date('2026-10-02T03:04:05.123Z'),
      customDataOrganizationId: ORG,
    });
    // 금액·주소·이메일·관리 URL 은 정규화 결과에 없다.
    const text = JSON.stringify(result);
    for (const sentinel of [AMOUNT, EMAIL, 'example.com/secret', 'add_']) expect(text, sentinel).not.toContain(sentinel);
  });

  it('모르는 가격 → planCode null(priceId 는 남긴다) · 반복 둘 이상 → 둘 다 null · 일회성·비활성 항목은 세지 않는다', () => {
    expect(normalizePaddleSubscription(subscription({ items: [item(ADDON)] }), 'sandbox', PRICES)).toMatchObject({ priceId: ADDON, planCode: null });
    expect(normalizePaddleSubscription(subscription({ items: [item(PRO), item(TEAM)] }), 'sandbox', PRICES)).toMatchObject({ priceId: null, planCode: null });
    expect(normalizePaddleSubscription(subscription({ items: [] }), 'sandbox', PRICES)).toMatchObject({ priceId: null, planCode: null });
    expect(
      normalizePaddleSubscription(subscription({ items: [item(TEAM), item(ADDON, { recurring: false }), item(PRO, { status: 'inactive' })] }), 'sandbox', PRICES),
    ).toMatchObject({ priceId: TEAM, planCode: 'team' });
    // 표가 비어 있으면(지금의 커밋된 가격표) 모든 가격이 "모름" 이다.
    expect(normalizePaddleSubscription(subscription(), 'sandbox', {})).toMatchObject({ priceId: PRO, planCode: null });
  });

  it('상태 다섯 · 예약 변경 · 해지·일시정지면 기간 없음 · custom_data 가 UUID 가 아니면 null', () => {
    for (const status of ['active', 'trialing', 'past_due', 'paused', 'canceled'] as const) {
      expect(normalizePaddleSubscription(subscription({ status }), 'production', PRICES)).toMatchObject({ status, environment: 'production' });
    }
    expect(
      normalizePaddleSubscription(subscription({ scheduled_change: { action: 'cancel', effective_at: '2026-11-01T00:00:00Z', resume_at: null } }), 'sandbox', PRICES)
        .scheduledChange,
    ).toEqual({ action: 'cancel', effectiveAt: new Date('2026-11-01T00:00:00Z') });
    expect(normalizePaddleSubscription(subscription({ status: 'canceled', current_billing_period: null }), 'sandbox', PRICES)).toMatchObject({
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
    for (const customData of [null, {}, { atmark_organization_id: 'o1' }, { atmark_organization_id: ORG.toUpperCase() }, 'x']) {
      expect(normalizePaddleSubscription(subscription({ custom_data: customData }), 'sandbox', PRICES).customDataOrganizationId).toBeNull();
    }
  });

  it('모양 위반 → provider_response_invalid(모르는 상태 · id 모양 · 시각 · 예약 변경 동작 · items 없음)', () => {
    const bad: Array<Record<string, unknown>> = [
      { status: 'deleted' },
      { id: 'sub_SHORT' },
      { customer_id: null },
      { updated_at: 'yesterday' },
      { updated_at: '2026-10-02 03:04:05' },
      { scheduled_change: { action: 'upgrade', effective_at: '2026-11-01T00:00:00Z' } },
      { items: undefined },
      { items: [{ recurring: true, price: { id: 'price_1' } }] },
      { current_billing_period: 'now' },
    ];
    for (const overrides of bad) {
      let error: unknown;
      try {
        normalizePaddleSubscription(subscription(overrides), 'sandbox', PRICES);
      } catch (caught) {
        error = caught;
      }
      expect((error as BillingProviderError | undefined)?.code, JSON.stringify(overrides)).toBe('provider_response_invalid');
    }
  });

  it('다른 id 의 엔터티가 오면 거부(id_mismatch)', async () => {
    const { api } = provider([{ status: 200, json: { data: subscription({ id: SUB2 }) } }]);
    await expect(api.fetchSubscription(SUB)).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });

  it('정규화 상태·예약 동작 집합 = 표 CHECK 의 타입(schema)', () => {
    expectTypeOf<ProviderSubscriptionStatus>().toEqualTypeOf<BillingSubscriptionStatus>();
    expectTypeOf<ProviderScheduledAction>().toEqualTypeOf<BillingScheduledChangeAction>();
  });
});

describe('③ 목록 · 거래 · 체크아웃 · 포털', () => {
  it('목록 — has_more 면 마지막 id 가 다음 커서 · 커서·id 필터가 쿼리로 · id 필터 0 개면 부르지 않는다', async () => {
    const { api, calls } = provider([
      { status: 200, json: { data: [subscription(), subscription({ id: SUB2, status: 'past_due' })], meta: { pagination: { has_more: true } } } },
      { status: 200, json: { data: [subscription({ id: SUB2 })], meta: { pagination: { has_more: false } } } },
    ]);
    const first = await api.listSubscriptions({ statuses: ['active', 'trialing', 'past_due', 'paused'] });
    expect(first.items.map((s) => s.id)).toEqual([SUB, SUB2]);
    expect(first.next).toBe(SUB2);
    const second = await api.listSubscriptions({ ids: [SUB2], after: first.next, customerId: CTM });
    expect(second.next).toBeNull();
    const query = new URL(calls[1]?.url ?? '').searchParams;
    expect(query.get('id')).toBe(SUB2);
    expect(query.get('customer_id')).toBe(CTM);
    expect(new URL(calls[0]?.url ?? '').searchParams.get('customer_id')).toBeNull();
    expect(query.get('after')).toBe(SUB2);
    expect(query.get('per_page')).toBe('50');
    expect(await api.listSubscriptions({ ids: [] })).toEqual({ items: [], next: null });
    expect(calls).toHaveLength(2);
    await expect(api.listSubscriptions({ ids: Array.from({ length: 51 }, () => SUB) })).rejects.toBeInstanceOf(RangeError);
  });

  it('거래 — 재조회 정규화 · 구독의 거래 목록은 그 구독의 것만 · 만든 순', async () => {
    const { api, calls } = provider([
      { status: 200, json: { data: transaction() } },
      {
        status: 200,
        json: {
          data: [
            transaction({ id: TXN2, created_at: '2026-11-01T00:00:00Z' }),
            transaction({ id: `txn_${'9'.repeat(26)}`, subscription_id: SUB2 }),
            transaction({ created_at: '2026-10-01T00:00:00Z' }),
          ],
        },
      },
    ]);
    const fetched = await api.fetchTransaction(TXN);
    expect(fetched).toEqual({
      provider: 'paddle',
      environment: 'sandbox',
      id: TXN,
      status: 'completed',
      subscriptionId: SUB,
      customerId: CTM,
      customDataOrganizationId: ORG,
      createdAt: new Date('2026-10-01T00:00:00.500Z'),
      checkoutUrl: `https://pay.atmark.ai/?_ptxn=${TXN}`,
    });
    expect(JSON.stringify(fetched)).not.toContain(AMOUNT);
    const listed = await api.listTransactionsBySubscription(SUB);
    expect(listed.map((t) => t.id)).toEqual([TXN, TXN2]);
    expect(new URL(calls[1]?.url ?? '').searchParams.get('subscription_id')).toBe(SUB);
  });

  it('체크아웃 거래 — 항목 하나 · custom_data 는 넘긴 조직 · checkout.url · 고객이 있으면 customer_id · 돌아온 조직이 다르면 거부', async () => {
    const { api, calls } = provider([
      { status: 201, json: { data: transaction({ status: 'ready', subscription_id: null }) } },
      { status: 201, json: { data: transaction({ status: 'ready', subscription_id: null, custom_data: { atmark_organization_id: '11111111-1111-4111-8111-111111111111' } }) } },
    ]);
    const created = await api.createTransaction({ priceId: PRO, organizationId: ORG, customerId: CTM, checkoutBaseUrl: 'https://pay.atmark.ai/' });
    expect(created.checkoutUrl).toBe(`https://pay.atmark.ai/?_ptxn=${TXN}`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${PADDLE_API_ORIGINS.sandbox}/transactions`);
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body).toEqual({
      items: [{ price_id: PRO, quantity: 1 }],
      collection_mode: 'automatic',
      custom_data: { atmark_organization_id: ORG },
      checkout: { url: 'https://pay.atmark.ai/' },
      customer_id: CTM,
    });
    await expect(api.createTransaction({ priceId: PRO, organizationId: ORG, customerId: null, checkoutBaseUrl: 'https://pay.atmark.ai/' })).rejects.toMatchObject({
      code: 'provider_response_invalid',
    });
    expect(calls[1]?.body).not.toHaveProperty('customer_id');
    await expect(api.createTransaction({ priceId: 'pri_x', organizationId: ORG, customerId: null, checkoutBaseUrl: 'https://pay.atmark.ai/' })).rejects.toBeInstanceOf(RangeError);
    await expect(api.createTransaction({ priceId: PRO, organizationId: 'o1', customerId: null, checkoutBaseUrl: 'https://pay.atmark.ai/' })).rejects.toBeInstanceOf(RangeError);
  });

  it('거래 취소 = PATCH status canceled · 포털 = 고객·구독 id 로 세션 → overview URL', async () => {
    const { api, calls } = provider([
      { status: 200, json: { data: transaction({ status: 'canceled' }) } },
      { status: 201, json: { data: { id: 'cpls_x', urls: { general: { overview: 'https://sandbox-customer-portal.paddle.com/cpl_x?token=t' } } } } },
      { status: 201, json: { data: { urls: {} } } },
    ]);
    await api.cancelTransaction(TXN);
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `${PADDLE_API_ORIGINS.sandbox}/transactions/${TXN}`, body: { status: 'canceled' } });
    expect(await api.createPortalSession({ customerId: CTM, subscriptionIds: [SUB] })).toEqual({ url: 'https://sandbox-customer-portal.paddle.com/cpl_x?token=t' });
    expect(calls[1]).toMatchObject({ method: 'POST', url: `${PADDLE_API_ORIGINS.sandbox}/customers/${CTM}/portal-sessions`, body: { subscription_ids: [SUB] } });
    await expect(api.createPortalSession({ customerId: CTM, subscriptionIds: [] })).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });
});

describe('④ 입력 id 가 모양 밖이면 부르지 않는다', () => {
  it('fetch·list·cancel·portal 모두 ProviderNotFoundError · 호출 0', async () => {
    const { api, calls } = provider([{ status: 200, json: { data: subscription() } }]);
    const attempts = [
      api.fetchSubscription('sub_../customers'),
      api.fetchSubscription(TXN),
      api.fetchTransaction(SUB),
      api.listTransactionsBySubscription('sub_1'),
      api.listSubscriptions({ after: 'sub_x&status=canceled' }),
      api.listSubscriptions({ customerId: 'ctm_x&status=canceled' }),
      api.cancelTransaction('txn_/x'),
      api.createPortalSession({ customerId: 'ctm_x', subscriptionIds: [SUB] }),
      api.createPortalSession({ customerId: CTM, subscriptionIds: ['sub_x'] }),
    ];
    for (const attempt of attempts) await expect(attempt).rejects.toBeInstanceOf(ProviderNotFoundError);
    expect(calls).toHaveLength(0);
  });
});
