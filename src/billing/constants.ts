/**
 * src/billing/constants.ts — **결제 공급자 연동(WP-2, Paddle Billing)의 공유 계약 상수**. 웹훅 λ · sync λ · admin λ · 홈 λ(`pay.atmark.ai`) ·
 * 운영자 CLI · CDK 가 같은 값을 본다(계획 `.omc/plans/wp2-paddle-adapter.md` §6-0).
 *
 * **import 가 없다** — 웹훅 λ 번들은 DB 를 몰라야 하고(번들 metafile 에 `pg`·`src/db` 0), 홈 λ 는 비밀·DB 가 없다. 이 파일이 무엇이든 끌어오면
 * 그 경계가 이 파일을 통해 새어 나간다. 같은 이유로 여기에는 **값만** 있다(함수·비밀·가격 id 없음 — 가격 id 는 `paddle/prices.ts`).
 *
 * 공급자 모양(가격 id · 이벤트 이름 · 환경)은 이 파일과 `src/billing/paddle/**` · 새 표 넷(`202609250400_billing_provider.sql`)에만 있다.
 * 엔타이틀먼트·정책 관문·콘솔 한도·투명성 잎은 공급자를 모른다(ADR-0011 · ADR-0012).
 */

/** 결제 공급자 — 표 `provider` CHECK 와 같은 집합. 공급자를 바꾸면 이 목록과 CHECK 를 함께 넓힌다(어댑터는 `BillingProviderApi` 뒤). */
export const BILLING_PROVIDERS = ['paddle'] as const;
export type BillingProvider = (typeof BILLING_PROVIDERS)[number];

/**
 * Paddle 환경 — 샌드박스와 운영은 데이터·자격증명·대시보드가 **완전히 분리**된다(계획 §0 P15). 표 `environment` CHECK 와 같은 집합이고,
 * 웹훅 봉투 · 큐 메시지 · 구독/거래 행 · 체크아웃 행이 모두 이 값을 싣는다 — 다른 환경의 행은 이 λ 의 결정에 들어가지 않는다.
 */
export const PADDLE_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type PaddleEnvironment = (typeof PADDLE_ENVIRONMENTS)[number];

/**
 * 코드의 기본 환경 — CDK 가 λ 환경 `ATMARK_PADDLE_ENV` 에 이 값을 넣는다. 운영 전환(런북 deploy §21-7)은 이 상수 · 운영 가격 id · 운영 CSP 호스트를
 * **한 커밋·한 배포**로 바꾼다 — 컨텍스트 플래그로 따로 돌리지 않는다(샌드박스 값과 운영 값이 섞이지 않게).
 */
export const PADDLE_ENVIRONMENT_DEFAULT: PaddleEnvironment = 'sandbox';

/**
 * 결제 페이지 호스트(진윤겸 결정 D-1). 홈 λ 가 Host 로 나눠 Paddle.js 페이지 하나만 낸다. `atmark.ai` 는 콘솔의 자격 포함 CORS 허용 출처라
 * 제3자 스크립트를 그 출처에 싣지 않는다 — 그래서 별도 호스트이고, **콘솔 CORS 허용 목록에 넣지 않는다**(`src/admin/http.ts` 무변경).
 */
export const PAY_HOST = 'pay.atmark.ai';

/** 결제 페이지 출처 — admin 이 Paddle 거래를 만들 때 `checkout.url` 로 주고, 돌아온 URL 의 출처가 이것이 아니면 502 로 거부한다(계획 §3-6). */
export const PAY_ORIGIN = `https://${PAY_HOST}`;

/**
 * 샌드박스 환경에서 체크아웃·sync 적용을 허용하는 조직 id(운영자 조직). **비어 있으면 샌드박스 결제는 어느 조직에도 적용되지 않는다**(fail-closed —
 * 샌드박스 테스트 카드로 운영 조직의 요금제를 올리지 못하게). 값은 진윤겸이 확인한 운영자 조직으로 리드가 커밋한다(계획 §8-8). 운영 환경에서는 보지 않는다.
 */
export const BILLING_SANDBOX_ORG_ALLOWLIST: readonly string[] = [
  // 2026-09-26 샌드박스 E2E 전용 조직 "Atmark Sandbox Test"(CLI 생성 · Free) — 진윤겸 결정: 운영 조직(Chronostasis, beta)은 넣지 않는다.
  '311cba94-4b5b-4047-be0e-8d140032c289',
];

/**
 * `past_due` 유예 일수(진윤겸 결정 D-2). `past_due_since` + 이 값 = 엔타이틀먼트 `grace_until`. 지나면 로더가 즉시 Free 로 해석한다
 * (`src/billing/plans.ts` `resolveEntitlements` — 쓰기와 무관하게 제시각).
 */
export const PROVIDER_GRACE_DAYS = 14;

/**
 * 웹훅 λ 가 큐에 넣는 이벤트 — **이 13종만**(나머지는 200 · 큐 0 · 고객 둘은 202610021203). sync 는 이벤트 본문을 믿지 않고 재조회하므로 "구독 상태가 바뀌었을 수 있다" 는
 * 신호만 있으면 된다(계획 §0 P10). 뺀 것과 이유:
 *   - `subscription.imported` — 다른 결제 시스템에서 옮겨 온 구독. 우리 거래(`billing_checkouts`)에서 나오지 않아 결속되지 않는다.
 *   - `transaction.paid` — 곧 `transaction.completed` 가 따른다. 같은 재조회를 두 번 부를 뿐이다.
 * 알림 목적지(Paddle 대시보드)에도 이 13종만 구독한다(진윤겸 할 일 §8-3 · 고객 둘은 ADR-0014 M3b 배포 때 더한다).
 */
export const BILLING_EVENT_TYPES = [
  'subscription.created',
  'subscription.activated',
  'subscription.updated',
  'subscription.trialing',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
  'subscription.canceled',
  'transaction.completed',
  'transaction.payment_failed',
  'transaction.past_due',
  // 고객 이메일(ADR-0014 결정 8 · 202610021203) — sync 가 결속된 조직의 `billing_email_is_agent` 를 다시 판정한다. 구독 상태와 무관(재계산 0).
  'customer.created',
  'customer.updated',
] as const;
export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];

/**
 * `billing_events.last_error` 에 적는 결과 코드 — 상태 `ignored`/`failed` 의 이유. **코드만** 적는다(고객 id·URL·응답 본문 없음 — 표와 로그가
 * 같은 규칙). `ignored` 는 종단(다시 처리해도 결과가 같다), `failed` 는 재시도·알람 대상이다(계획 §3-1 · §3-6 · §3-10).
 */
export const BILLING_EVENT_REASON_CODES = [
  /** 재조회 404 — Paddle 에 그 구독·거래가 없다(`billing.provider_not_found`). → `ignored` */
  'not_found',
  /** 샌드박스인데 조직이 `BILLING_SANDBOX_ORG_ALLOWLIST` 밖. → `ignored` */
  'sandbox_not_allowed',
  /** 봉투·재조회 결과의 환경이 이 λ 의 `ATMARK_PADDLE_ENV` 와 다르다. → `ignored` */
  'environment_mismatch',
  /** 구독의 원 거래가 우리 `billing_checkouts` 에 없거나 조직이 맞지 않는다(`billing.unbound_subscription` 알람).
   *  원 거래를 만든 지 30분 안이면 `failed`(재시도 — 목록 반영 지연), 30분이 지났으면 `ignored`(L-2 — 스팸이 DLQ 를 흔들지 않게). */
  'unbound_subscription',
  /** 공급자 호출 실패(5xx·시간 초과·인증 실패). 메시지는 SQS 재시도로 돌아온다. → `failed` */
  'provider_error',
  /** 우리 쪽 실패(DB 오류·예상 못 한 예외) — 공급자 탓이 아니다(코드 검토 M-6: `provider_error` 와 섞지 않는다). 메시지는 SQS 재시도로 돌아온다. → `failed` */
  'internal_error',
] as const;
export type BillingEventReasonCode = (typeof BILLING_EVENT_REASON_CODES)[number];
