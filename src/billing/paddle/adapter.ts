/**
 * src/billing/paddle/adapter.ts — **Paddle Billing → `BillingProviderApi`**(계획 §6-0 · §3-1 ②). Paddle 엔터티 JSON 을 여기서만 읽고,
 * 밖으로는 정규화한 구독·거래만 낸다. 네트워크는 `http.ts` 의 `PaddleHttp` 하나로만 나간다(이 파일에는 `fetch` 가 없다).
 *
 * 정규화 규칙:
 *   - **읽는 칸만 읽는다** — id · 상태 · 고객 id · 반복 가격 항목 · 청구 기간 · 예약 변경 · `updated_at` · `custom_data.atmark_organization_id`.
 *     금액·통화·주소·이메일·결제 수단·`management_urls` 는 읽지 않는다(표·로그·잎에 들어갈 길을 처음부터 없앤다).
 *   - id 는 모양을 확인한다(`sub_`·`ctm_`·`txn_`·`pri_` + 소문자 영숫자 26). 모양 밖이면 `provider_response_invalid`(던짐 — SQS 재시도 · 알람).
 *   - 가격: 반복(`recurring`) 이고 비활성이 아닌 항목이 **정확히 하나**일 때만 그 가격 id → 요금제(`prices.ts`). 없거나 둘 이상이면 가격 null ·
 *     요금제 null — "모르는 가격" 이지 "구독 없음" 이 아니다(결정 함수가 noop + `billing.unknown_price`).
 *   - `custom_data.atmark_organization_id` 는 UUID 모양일 때만. **결속 근거가 아니다**(결속은 `billing_checkouts` 의 우리 거래뿐 — 계획 §3-6).
 *   - 입력 id 가 모양 밖이면 부르지 않고 `ProviderNotFoundError`(그런 엔터티는 공급자에 없다).
 */

import { BILLING_PROVIDERS, type PaddleEnvironment } from '../constants';
import {
  PROVIDER_SCHEDULED_ACTIONS,
  PROVIDER_SUBSCRIPTION_STATUSES,
  ProviderNotFoundError,
  ProviderUnavailableError,
  type BillingProviderApi,
  type CreatePortalSessionInput,
  type CreateTransactionInput,
  type ListSubscriptionsQuery,
  type NormalizedSubscription,
  type NormalizedTransaction,
  type ProviderScheduledAction,
  type ProviderSubscriptionStatus,
  type SubscriptionPage,
} from '../provider';
import { PADDLE_ID_PATTERNS } from '../queue-message';
import type { PaddleHttp } from './http';
import { PADDLE_PRICE_ID_SHAPE, PADDLE_PRICE_PLANS, planForPrice, type PaddlePriceTable } from './prices';

const PADDLE_SUBSCRIPTION_ID_SHAPE = PADDLE_ID_PATTERNS.subscription;
const PADDLE_TRANSACTION_ID_SHAPE = PADDLE_ID_PATTERNS.transaction;
const PADDLE_CUSTOMER_ID_SHAPE = PADDLE_ID_PATTERNS.customer;
/** `custom_data` 에 우리가 넣는 유일한 키(계획 §3-6). */
export const CUSTOM_DATA_ORGANIZATION_KEY = 'atmark_organization_id';
/** 목록 한 페이지 크기(Paddle 최대 200 — 한 틱 예산 40초 안에서 작게). id 필터는 최대 50 개씩(계획 §3-5 `stale`). */
export const PADDLE_LIST_PAGE_SIZE = 50;
export const PADDLE_LIST_MAX_IDS = 50;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** RFC 3339(Paddle 은 마이크로초까지 준다) — 초 아래는 밀리초까지만 읽는다. */
const TIMESTAMP_SHAPE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const PROVIDER = BILLING_PROVIDERS[0];

type Json = Record<string, unknown>;

function invalid(detail: string): ProviderUnavailableError {
  return new ProviderUnavailableError('provider_response_invalid', detail);
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idOf(value: unknown, shape: RegExp, field: string): string {
  if (typeof value !== 'string' || !shape.test(value)) throw invalid(field);
  return value;
}

function optionalIdOf(value: unknown, shape: RegExp, field: string): string | null {
  return value === null || value === undefined ? null : idOf(value, shape, field);
}

function timeOf(value: unknown, field: string): Date {
  const match = typeof value === 'string' ? TIMESTAMP_SHAPE.exec(value) : null;
  if (match === null) throw invalid(field);
  const fraction = (match[2] ?? '').slice(0, 3);
  const at = new Date(`${match[1] ?? ''}${fraction === '' ? '' : `.${fraction}`}${match[3] ?? ''}`);
  if (Number.isNaN(at.getTime())) throw invalid(field);
  return at;
}

function optionalTimeOf(value: unknown, field: string): Date | null {
  return value === null || value === undefined ? null : timeOf(value, field);
}

function organizationOf(customData: unknown): string | null {
  if (!isObject(customData)) return null;
  const value = customData[CUSTOM_DATA_ORGANIZATION_KEY];
  return typeof value === 'string' && UUID_SHAPE.test(value) ? value : null;
}

function dataOf(envelope: unknown): unknown {
  if (!isObject(envelope) || !('data' in envelope)) throw invalid('envelope');
  return envelope['data'];
}

/** 반복 가격 항목이 정확히 하나면 그 가격 id, 아니면 null. */
function recurringPriceOf(items: unknown): string | null {
  if (!Array.isArray(items)) throw invalid('items');
  const prices: string[] = [];
  for (const item of items) {
    if (!isObject(item)) throw invalid('items');
    if (item['recurring'] !== true || item['status'] === 'inactive') continue;
    const price = item['price'];
    if (!isObject(price)) throw invalid('items.price');
    const id = price['id'];
    if (typeof id !== 'string' || !PADDLE_PRICE_ID_SHAPE.test(id)) throw invalid('items.price.id');
    prices.push(id);
  }
  return prices.length === 1 ? (prices[0] ?? null) : null;
}

function statusOf(value: unknown): ProviderSubscriptionStatus {
  const known = PROVIDER_SUBSCRIPTION_STATUSES.find((status) => status === value);
  if (known === undefined) throw invalid('status');
  return known;
}

function scheduledChangeOf(value: unknown): NormalizedSubscription['scheduledChange'] {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) throw invalid('scheduled_change');
  const action: ProviderScheduledAction | undefined = PROVIDER_SCHEDULED_ACTIONS.find((candidate) => candidate === value['action']);
  if (action === undefined) throw invalid('scheduled_change.action');
  return { action, effectiveAt: timeOf(value['effective_at'], 'scheduled_change.effective_at') };
}

/** Paddle 구독 엔터티 → 정규화. 모양이 틀리면 `provider_response_invalid`. */
export function normalizePaddleSubscription(raw: unknown, environment: PaddleEnvironment, prices: PaddlePriceTable): NormalizedSubscription {
  if (!isObject(raw)) throw invalid('subscription');
  const priceId = recurringPriceOf(raw['items']);
  const period = raw['current_billing_period'];
  if (period !== null && period !== undefined && !isObject(period)) throw invalid('current_billing_period');
  return {
    provider: PROVIDER,
    environment,
    id: idOf(raw['id'], PADDLE_SUBSCRIPTION_ID_SHAPE, 'id'),
    customerId: idOf(raw['customer_id'], PADDLE_CUSTOMER_ID_SHAPE, 'customer_id'),
    status: statusOf(raw['status']),
    priceId,
    planCode: planForPrice(prices, priceId),
    currentPeriodStart: isObject(period) ? optionalTimeOf(period['starts_at'], 'current_billing_period.starts_at') : null,
    currentPeriodEnd: isObject(period) ? optionalTimeOf(period['ends_at'], 'current_billing_period.ends_at') : null,
    scheduledChange: scheduledChangeOf(raw['scheduled_change']),
    updatedAt: timeOf(raw['updated_at'], 'updated_at'),
    customDataOrganizationId: organizationOf(raw['custom_data']),
  };
}

/** Paddle 거래 엔터티 → 정규화. */
export function normalizePaddleTransaction(raw: unknown, environment: PaddleEnvironment): NormalizedTransaction {
  if (!isObject(raw)) throw invalid('transaction');
  const status = raw['status'];
  if (typeof status !== 'string' || !/^[a-z_]{1,32}$/.test(status)) throw invalid('status');
  const checkout = raw['checkout'];
  const checkoutUrl = isObject(checkout) && typeof checkout['url'] === 'string' ? checkout['url'] : null;
  return {
    provider: PROVIDER,
    environment,
    id: idOf(raw['id'], PADDLE_TRANSACTION_ID_SHAPE, 'id'),
    status,
    subscriptionId: optionalIdOf(raw['subscription_id'], PADDLE_SUBSCRIPTION_ID_SHAPE, 'subscription_id'),
    customerId: optionalIdOf(raw['customer_id'], PADDLE_CUSTOMER_ID_SHAPE, 'customer_id'),
    customDataOrganizationId: organizationOf(raw['custom_data']),
    createdAt: timeOf(raw['created_at'], 'created_at'),
    checkoutUrl,
  };
}

function listOf(envelope: unknown): { items: unknown[]; hasMore: boolean } {
  const data = dataOf(envelope);
  if (!Array.isArray(data)) throw invalid('data');
  const meta = isObject(envelope) ? envelope['meta'] : undefined;
  const pagination = isObject(meta) ? meta['pagination'] : undefined;
  return { items: data, hasMore: isObject(pagination) && pagination['has_more'] === true };
}

function requireId(value: string, shape: RegExp): string {
  if (!shape.test(value)) throw new ProviderNotFoundError();
  return value;
}

export interface PaddleProviderOptions {
  readonly http: PaddleHttp;
  /** 가격표 — 기본은 `PADDLE_PRICE_PLANS[http.environment]`. 테스트가 가짜 표를 넣는다. */
  readonly prices?: PaddlePriceTable;
}

export function createPaddleProvider(options: PaddleProviderOptions): BillingProviderApi {
  const { http } = options;
  const environment = http.environment;
  const prices = options.prices ?? PADDLE_PRICE_PLANS[environment];

  return {
    provider: PROVIDER,
    environment,

    async fetchSubscription(subscriptionId: string): Promise<NormalizedSubscription> {
      const id = requireId(subscriptionId, PADDLE_SUBSCRIPTION_ID_SHAPE);
      const subscription = normalizePaddleSubscription(dataOf(await http.get(`/subscriptions/${id}`)), environment, prices);
      if (subscription.id !== id) throw invalid('id_mismatch');
      return subscription;
    },

    async listSubscriptions(query: ListSubscriptionsQuery): Promise<SubscriptionPage> {
      const params: Record<string, string> = { per_page: String(PADDLE_LIST_PAGE_SIZE), order_by: 'id[ASC]' };
      if (query.statuses !== undefined && query.statuses.length > 0) params['status'] = query.statuses.join(',');
      if (query.ids !== undefined) {
        if (query.ids.length === 0) return { items: [], next: null };
        if (query.ids.length > PADDLE_LIST_MAX_IDS) throw new RangeError(`id 필터는 ${String(PADDLE_LIST_MAX_IDS)}개까지다.`);
        params['id'] = query.ids.map((id) => requireId(id, PADDLE_SUBSCRIPTION_ID_SHAPE)).join(',');
      }
      if (query.customerId !== undefined) params['customer_id'] = requireId(query.customerId, PADDLE_CUSTOMER_ID_SHAPE);
      if (query.after !== undefined && query.after !== null) params['after'] = requireId(query.after, PADDLE_SUBSCRIPTION_ID_SHAPE);
      const { items, hasMore } = listOf(await http.get('/subscriptions', params));
      const normalized = items.map((item) => normalizePaddleSubscription(item, environment, prices));
      const last = normalized[normalized.length - 1];
      return { items: normalized, next: hasMore && last !== undefined ? last.id : null };
    },

    async fetchTransaction(transactionId: string): Promise<NormalizedTransaction> {
      const id = requireId(transactionId, PADDLE_TRANSACTION_ID_SHAPE);
      const transaction = normalizePaddleTransaction(dataOf(await http.get(`/transactions/${id}`)), environment);
      if (transaction.id !== id) throw invalid('id_mismatch');
      return transaction;
    },

    async listTransactionsBySubscription(subscriptionId: string): Promise<readonly NormalizedTransaction[]> {
      const id = requireId(subscriptionId, PADDLE_SUBSCRIPTION_ID_SHAPE);
      const { items } = listOf(await http.get('/transactions', { subscription_id: id, order_by: 'created_at[ASC]', per_page: String(PADDLE_LIST_PAGE_SIZE) }));
      const normalized = items.map((item) => normalizePaddleTransaction(item, environment));
      // 필터가 무시된 응답(미확인 ⑥)이 다른 구독의 거래를 섞어 오지 않게 한 번 더 거른다 · 만든 순.
      return normalized.filter((transaction) => transaction.subscriptionId === id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },

    async createTransaction(input: CreateTransactionInput): Promise<NormalizedTransaction> {
      if (!PADDLE_PRICE_ID_SHAPE.test(input.priceId)) throw new RangeError('가격 id 모양이 아니다.');
      if (!UUID_SHAPE.test(input.organizationId)) throw new RangeError('조직 id 모양이 아니다.');
      const body: Record<string, unknown> = {
        items: [{ price_id: input.priceId, quantity: 1 }],
        collection_mode: 'automatic',
        custom_data: { [CUSTOM_DATA_ORGANIZATION_KEY]: input.organizationId },
        checkout: { url: input.checkoutBaseUrl },
      };
      if (input.customerId !== null) body['customer_id'] = requireId(input.customerId, PADDLE_CUSTOMER_ID_SHAPE);
      const transaction = normalizePaddleTransaction(dataOf(await http.post('/transactions', body)), environment);
      if (transaction.customDataOrganizationId !== input.organizationId) throw invalid('custom_data');
      return transaction;
    },

    async fetchCustomerEmail(customerId: string): Promise<string> {
      const id = requireId(customerId, PADDLE_CUSTOMER_ID_SHAPE);
      const data = dataOf(await http.get(`/customers/${id}`));
      const email = isObject(data) ? data['email'] : undefined;
      // 값은 돌려주기만 한다(로그 · 오류 메시지에 싣지 않는다).
      if (typeof email !== 'string' || email.length === 0 || email.length > 320) throw invalid('email');
      return email;
    },

    async cancelTransaction(transactionId: string): Promise<void> {
      const id = requireId(transactionId, PADDLE_TRANSACTION_ID_SHAPE);
      await http.patch(`/transactions/${id}`, { status: 'canceled' });
    },

    async createPortalSession(input: CreatePortalSessionInput): Promise<{ readonly url: string }> {
      const customer = requireId(input.customerId, PADDLE_CUSTOMER_ID_SHAPE);
      const subscriptionIds = input.subscriptionIds.map((id) => requireId(id, PADDLE_SUBSCRIPTION_ID_SHAPE));
      // 구독 id 가 없으면 고객 단위 포털(일반 개요)만 연다.
      const data = dataOf(await http.post(`/customers/${customer}/portal-sessions`, subscriptionIds.length === 0 ? {} : { subscription_ids: subscriptionIds }));
      const urls = isObject(data) ? data['urls'] : undefined;
      const general = isObject(urls) ? urls['general'] : undefined;
      const overview = isObject(general) ? general['overview'] : undefined;
      if (typeof overview !== 'string') throw invalid('urls.general.overview');
      return { url: overview };
    },
  };
}
