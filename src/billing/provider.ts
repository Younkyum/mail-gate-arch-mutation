/**
 * src/billing/provider.ts — **결제 공급자 경계**(WP-2, 계획 `.omc/plans/wp2-paddle-adapter.md` §6-0). sync λ · reconcile · admin 체크아웃이
 * 공급자를 이 인터페이스로만 본다. Paddle 모양(엔터티 JSON · 호스트 · 가격 id)은 `src/billing/paddle/**` 밖으로 나오지 않는다 — 공급자를 바꾸면
 * 어댑터 하나를 이 인터페이스 뒤에 새로 끼운다.
 *
 * 정규화 결과는 **재조회한 공급자 상태**다. 이벤트 본문은 신호일 뿐이라 여기 없다(계획 원칙 2). 금액·이메일·주소·결제 수단은 정규화하지 않는다 —
 * 표·로그·잎 어디에도 들어가지 않게 처음부터 읽지 않는다.
 *
 * 오류는 **코드만** 싣는다(`BillingProviderError.code`) — 메시지에 고객 id·URL·키·응답 본문이 없다. 호출자는 코드로 갈린다:
 *   - `ProviderAuthError`(401/403) → `billing.provider_auth_failed` 알람(키 만료·권한 부족·자리표시)
 *   - `ProviderNotFoundError`(404) → sync 는 `ignored(not_found)`(계획 M7)
 *   - `ProviderRateLimitedError`(429) → 이번 틱·이번 시도를 멈춘다(SQS·다음 틱이 잇는다)
 *   - `ProviderUnavailableError`(5xx · 시간 초과 · 연결 실패 · 응답 모양 위반) → 던진다(SQS 재시도 · reconcile 다음 틱)
 */

import type { BillingProvider, PaddleEnvironment } from './constants';
import type { PaidPlanCode } from './plans';

/** 공급자 구독 상태 — 표 `billing_subscriptions.status` CHECK 와 같은 다섯(`src/db/schema.ts` `BillingSubscriptionStatus`). `canceled` 종단. */
export const PROVIDER_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'paused', 'canceled'] as const;
export type ProviderSubscriptionStatus = (typeof PROVIDER_SUBSCRIPTION_STATUSES)[number];

/** 예약된 변경(`scheduled_change.action`) — 표 `scheduled_change_action` 과 같은 셋. */
export const PROVIDER_SCHEDULED_ACTIONS = ['cancel', 'pause', 'resume'] as const;
export type ProviderScheduledAction = (typeof PROVIDER_SCHEDULED_ACTIONS)[number];

/** 재조회한 구독 하나(정규화). 이 λ 환경의 어댑터가 만든 것만 — `environment` 는 어댑터의 환경이다. */
export interface NormalizedSubscription {
  readonly provider: BillingProvider;
  readonly environment: PaddleEnvironment;
  /** `sub_…` */
  readonly id: string;
  /** `ctm_…` */
  readonly customerId: string;
  readonly status: ProviderSubscriptionStatus;
  /** 반복 가격 항목이 **정확히 하나**일 때의 `pri_…`. 아니면 null(→ `planCode` null → 결정 함수 noop `unknown_price`). */
  readonly priceId: string | null;
  /** 가격 id → 요금제(`paddle/prices.ts`). 모르는 가격이면 null — **구독 없음으로 해석하지 않는다**(사전 부검 2). */
  readonly planCode: PaidPlanCode | null;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly scheduledChange: { readonly action: ProviderScheduledAction; readonly effectiveAt: Date } | null;
  /** 공급자 엔터티의 `updated_at` — 순서 판단의 유일한 기준(앞으로만, 계획 §3-2). */
  readonly updatedAt: Date;
  /**
   * 거래에서 복사된 `custom_data.atmark_organization_id`(계획 §0 P12). **결속 근거가 아니다** — 결속은 우리 `billing_checkouts` 의 거래뿐이고,
   * 이 값은 그 행의 조직과 같은지 한 번 더 보는 데만 쓴다(모양이 UUID 가 아니면 null).
   */
  readonly customDataOrganizationId: string | null;
}

/** 재조회한 거래 하나(정규화) — 결속 검증(원 거래 찾기)과 체크아웃 생성 결과. */
export interface NormalizedTransaction {
  readonly provider: BillingProvider;
  readonly environment: PaddleEnvironment;
  /** `txn_…` */
  readonly id: string;
  /** 공급자 거래 상태(`draft`·`ready`·`billed`·`paid`·`completed`·`canceled`·`past_due`) — 모르는 값도 그대로(기록·판단은 칸만 본다). */
  readonly status: string;
  readonly subscriptionId: string | null;
  readonly customerId: string | null;
  readonly customDataOrganizationId: string | null;
  readonly createdAt: Date;
  /** 결제 체크아웃 URL(`checkout.url` — `https://pay.atmark.ai/?_ptxn=txn_…`). 없으면 null. 저장·로그하지 않는다. */
  readonly checkoutUrl: string | null;
}

export interface ListSubscriptionsQuery {
  /**
   * 상태 필터 — reconcile 의 `list` 단계는 `active,trialing,past_due,paused`, `stale` 단계는 다섯 모두(해지를 잡아야 한다). **비우면 공급자 기본값**이고
   * 그 기본값이 `canceled` 를 빼는지는 문서에 없다 — 해지를 보려는 호출은 상태를 늘 명시한다.
   */
  readonly statuses?: readonly ProviderSubscriptionStatus[];
  /** 고객 필터(`customer_id`) — 포털을 열기 전에 그 고객의 살아 있는 구독이 전부 이 조직 것인지 본다(H-1). */
  readonly customerId?: string;
  /** id 필터(최대 50) — reconcile 의 `stale` 단계. */
  readonly ids?: readonly string[];
  /** 앞 페이지가 준 커서. 첫 페이지는 null. */
  readonly after?: string | null;
}

export interface SubscriptionPage {
  readonly items: readonly NormalizedSubscription[];
  /** 다음 페이지 커서 — 마지막 페이지면 null. */
  readonly next: string | null;
}

export interface CreateTransactionInput {
  readonly priceId: string;
  /** **서버가 넣는** 세션 조직 id — 클라이언트 입력이 아니다(계획 §3-6). */
  readonly organizationId: string;
  /** 이미 결속된 고객이 있으면 그 `ctm_…`(없으면 체크아웃에서 새로 만든다). */
  readonly customerId: string | null;
  /** 체크아웃 페이지 출처 — `PAY_ORIGIN`(`https://pay.atmark.ai`). */
  readonly checkoutBaseUrl: string;
}

export interface CreatePortalSessionInput {
  readonly customerId: string;
  readonly subscriptionIds: readonly string[];
}

/**
 * 공급자 API — 계약(계획 §6-0). 구현은 `paddle/adapter.ts` 하나. sync·reconcile 은 **DB 트랜잭션 밖에서만** 부른다(계획 §3-5 — 가짜 공급자가
 * 호출 순간 열린 트랜잭션이 없음을 단언한다).
 */
export interface BillingProviderApi {
  readonly provider: BillingProvider;
  readonly environment: PaddleEnvironment;
  /** `GET /subscriptions/{id}`. 없으면 `ProviderNotFoundError`. */
  fetchSubscription(subscriptionId: string): Promise<NormalizedSubscription>;
  /** `GET /subscriptions` — 목록 엔터티를 그대로 정규화한다(항목마다 다시 부르지 않는다). */
  listSubscriptions(query: ListSubscriptionsQuery): Promise<SubscriptionPage>;
  /** `GET /transactions/{id}`. 없으면 `ProviderNotFoundError`. */
  fetchTransaction(transactionId: string): Promise<NormalizedTransaction>;
  /**
   * `GET /customers/{id}` 의 이메일(ADR-0014 결정 8 — `billing_email_is_agent` 판정 재료). **저장하지도 로그에 싣지도 않는다** — sync 가 DB 판정
   * 함수(`atmark_is_agent_mail_identity`)에 넘기고 버린다. 선택 메서드 — 없으면(가짜 공급자) 판정을 건너뛴다(칸은 그대로).
   */
  fetchCustomerEmail?(customerId: string): Promise<string>;
  /** `GET /transactions?subscription_id=…` — 만든 순(오래된 것 먼저). 결속의 원 거래 찾기(구독 이벤트일 때). */
  listTransactionsBySubscription(subscriptionId: string): Promise<readonly NormalizedTransaction[]>;
  /** `POST /transactions` — 체크아웃 거래(항목 하나 · `custom_data.atmark_organization_id` · `checkout.url`). */
  createTransaction(input: CreateTransactionInput): Promise<NormalizedTransaction>;
  /** 열린 거래 취소(best-effort — 중복 클릭 경쟁에서 진 거래 · superseded). */
  cancelTransaction(transactionId: string): Promise<void>;
  /** 고객 포털 세션 — 링크는 **임시**라 저장·캐시·로그하지 않는다(계획 §0 P19). */
  createPortalSession(input: CreatePortalSessionInput): Promise<{ readonly url: string }>;
}

/** 공급자 오류 코드 — 로그·`billing_events.last_error`(`provider_error`)·응답에 이 코드만 나간다. */
export type ProviderErrorCode = 'provider_auth_failed' | 'provider_not_found' | 'provider_rate_limited' | 'provider_unavailable' | 'provider_response_invalid';

export class BillingProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string = code) {
    super(message);
    this.name = 'BillingProviderError';
    this.code = code;
  }
}

/** 401/403 — 키가 자리표시·만료·권한 밖(계획 §0 P21). */
export class ProviderAuthError extends BillingProviderError {
  constructor() {
    super('provider_auth_failed');
    this.name = 'ProviderAuthError';
  }
}

/** 404 — 공급자에 그 엔터티가 없다(다른 환경의 id · 위조 봉투 · 지워진 것). */
export class ProviderNotFoundError extends BillingProviderError {
  constructor() {
    super('provider_not_found');
    this.name = 'ProviderNotFoundError';
  }
}

/** 429 — `Retry-After`(초, 0~3600 으로 자른 값 · 없으면 null). */
export class ProviderRateLimitedError extends BillingProviderError {
  readonly retryAfterSeconds: number | null;

  constructor(retryAfterSeconds: number | null) {
    super('provider_rate_limited');
    this.name = 'ProviderRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 5xx · 시간 초과 · 연결 실패 · 응답 크기 초과 · JSON 아님(`provider_unavailable`) — 또는 응답 모양 위반(`provider_response_invalid`). */
export class ProviderUnavailableError extends BillingProviderError {
  constructor(code: 'provider_unavailable' | 'provider_response_invalid' = 'provider_unavailable', detail?: string) {
    super(code, detail === undefined ? code : `${code}:${detail}`);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * admin λ 의 결제 의존성(콘솔 `GET /api/billing` · 체크아웃 · 포털 — `src/admin/ops/billing.ts`). `src/admin/context.ts` 의 `AdminDependencies.billing`
 * 이 이 타입이다 — 여기(공급자 경계, admin 을 모르는 파일)에 두어 `context.ts ↔ ops/billing.ts` 순환을 만들지 않는다. 조립은 `admin-composition.ts`.
 */
export interface AdminBillingDependencies {
  readonly environment: PaddleEnvironment;
  /** 결제 스위치(`ATMARK_BILLING_ENABLED`). */
  readonly enabled: boolean;
  /**
   * admin 키로 만든 어댑터를 준다. **키가 자리표시면 null**(잠김 `not_configured`). 요청마다 부른다 — 조립이 비밀을 5분 캐시하므로
   * 자리표시 뒤에 실제 키가 들어오면 λ 를 다시 띄우지 않아도 반영된다(코드 검토 M-5). admin 경로의 Paddle 시간 제한은 5초다(λ 25초 안).
   */
  readonly loadProvider: () => Promise<BillingProviderApi | null>;
  /** 이 환경의 가격표(가격 id → 요금제, `paddle/prices.ts` `PADDLE_PRICE_PLANS[environment]`) — 테스트가 가짜 표를 넣는다. */
  readonly prices: Readonly<Record<string, PaidPlanCode>>;
  readonly sandboxAllowlist: readonly string[];
}
