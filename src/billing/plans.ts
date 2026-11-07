/**
 * src/billing/plans.ts — **요금제 카탈로그와 엔타이틀먼트 해석**(ADR-0011, `docs/research/billing-stripe-korea.md` Part B B2–B4).
 *
 * 카탈로그는 **코드 상수**다(워밍업 표 `policy/rules/limits.ts` 와 같은 이유 — 한도를 바꾸려면 커밋과 리뷰를 거친다). DB 의
 * `org_entitlements` 행은 "이 조직이 지금 어느 요금제의 어떤 한도를 받는가" 의 단일 진실 원천이고, 이 파일은 그 행을 **해석**한다:
 *
 *   - **행이 없으면 Free**(fail-closed). "행이 없어서 무제한" 인 경로는 없다 — 워밍업 `WARMUP_DAY_ZERO_CAP` 과 같은 원칙.
 *   - **표가 아직 없으면(`table_missing`) 도입 전 한도**(= beta 카탈로그). 새 코드가 마이그레이션보다 먼저 돈 몇 분 동안 활성 조직을 Free 로
 *     떨어뜨리면 이미 승인된 봉투가 Free 한도(메시지당 수신자 10 등)에 걸려 영구 거부될 수 있다 — 표가 없다는 것은 "요금제 도입 전" 이다.
 *     배포 순서(런북 deploy §20: 마이그레이션 먼저)가 이 창을 없애고, 이 규칙은 순서가 어긋났을 때의 바닥이다. 천장은 그대로 건다.
 *   - **유예가 끝났으면 Free**(`grace_until <= now`). 공급자 동기화(WP-2)가 늦어도 강등은 제시각에 걸린다.
 *   - **천장을 넘지 않는다** — 행의 값(운영자 덮어쓰기 포함)은 `ENTITLEMENT_CEILINGS` 로 `min()` 한다. 천장은 각 적용 지점의
 *     기존 코드 상수와 **같은 값**이다(에이전트당 토큰 5 · 조직 키 5 · 웹훅 10 · 메시지당 수신자 50 · 워밍업 정상상태 1000). 적용 지점도
 *     자기 상수로 한 번 더 `min()` 한다 — 이 파일이 되돌려져도 천장은 남는다. 두 값이 같은지는 `test/unit/billing/plans.test.ts` 가 본다.
 *
 * **이 파일은 금액을 모른다**(가격 id 는 `paddle/prices.ts`) — 금액·고객 id 는 엔타이틀먼트·정책 게이트·투명성 잎 어디에도 들어가지 않는다.
 *
 * **import 가 없다** — 정책 로더·관리 연산·API·CLI 가 모두 이 파일을 쓰므로, 여기서 그쪽을 가져오면 순환이 된다(depcruise `no-circular`).
 */

export const PLAN_CODES = ['free', 'beta', 'pro', 'team', 'scale'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === 'string' && (PLAN_CODES as readonly string[]).includes(value);
}

/** 행의 출처 — 기본값(백필) · 결제 공급자 동기화(WP-2) · 운영자 CLI(`pnpm admin:plan`). */
export const ENTITLEMENT_SOURCES = ['default', 'provider', 'operator'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

/**
 * 바뀐 원인 — `billing_audit.cause` · 투명성 잎 `billing.entitlement` 의 `cause`. `review` = 검토 활성화 때의 자동 부여(출처 `operator`,
 * `BETA_ON_ACTIVATION` · 202609250300).
 */
export const ENTITLEMENT_CAUSES = ['backfill', 'operator', 'review', 'provider_event', 'grace_expired', 'reconcile'] as const;
export type EntitlementCause = (typeof ENTITLEMENT_CAUSES)[number];

/** 한도 차원(B2 + 메일 기본기 2차 두 칸). 전부 정수 — `org_entitlements` 의 칸과 1:1. */
export interface EntitlementLimits {
  /** 조직당 에이전트 — **비활성(`disabled`) 제외**. 비활성 포함 총합은 `agentTotalCeiling` 이 따로 묶는다(B7). */
  readonly maxAgents: number;
  /** 조직 전체 하루(24시간 창) 수신자. 실제 상한은 `min(워밍업 캡, 이 값)` — 요금제로 워밍업을 풀 수 없다(R22). */
  readonly orgDailyRecipients: number;
  /** 에이전트 정책 `per_day` 의 상한. */
  readonly agentPerDayMax: number;
  /** 에이전트 정책 `per_minute` 의 상한(소유자 입력도 여기서 끊는다). */
  readonly agentPerMinuteMax: number;
  /** 메시지당 수신자 — 정책 `recipients_per_message` 의 상한. 절대 천장은 Stage 6 의 50. */
  readonly recipientsPerMessageMax: number;
  /** 에이전트당 활성 토큰. 절대 천장은 DB 트리거 `agent_api_keys_active_limit` 의 5. */
  readonly tokensPerAgentMax: number;
  /** 에이전트당 활성 웹훅 엔드포인트. 절대 천장은 API 의 10. */
  readonly webhookEndpointsPerAgentMax: number;
  /** 조직당 활성 조직 API 키. 절대 천장은 콘솔 연산의 5(DB 트리거 천장 20). */
  readonly orgApiKeysMax: number;
  /** 수신 저장 용량(바이트). **P0 에서는 표시만** — 적용은 저장 계측이 생긴 뒤(ADR-0011 §미룬 것). */
  readonly inboundStorageBytes: number;
  /**
   * 에이전트당 **활성 별칭**(대표 주소 제외, 폐기 제외 — 메일 기본기 2차 A6, ADR-0013 D6). 적용은 admin 별칭 연산이 같은 잠금 아래에서 센다.
   * 절대 천장 20 은 DB 트리거 `agent_addresses_alias_ceiling`(202609270110)도 건다. 강등으로 넘친 기존 별칭은 폐기하지 않는다(추가만 막는다).
   */
  readonly aliasesPerAgentMax: number;
  /**
   * 메일 하나의 **첨부 총량**(바이트, MiB 배수 — A2). 정책 로더가 `min(정책 max_attachment_bytes_total, 이 값, 천장 25 MiB)` 로 Stage 6 에
   * 넣는다(관문 코드 무변경). 업로드 생성도 이 값으로 빠르게 끊는다(최종 판정은 Stage 6).
   */
  readonly attachmentBytesTotalMax: number;
}

export interface Entitlements extends EntitlementLimits {
  readonly planCode: PlanCode;
  /**
   * 한도를 실제로 정한 것 — 행이 없거나(`missing`) 유예가 끝나(`grace_expired`) Free 로 떨어졌는지, 행 그대로(`row`)인지, 표가 아직 없어
   * 도입 전 한도(`table_missing`)인지.
   */
  readonly basis: 'row' | 'missing' | 'grace_expired' | 'table_missing';
}

const GB = 1024 ** 3;
/** MiB — 첨부 한도의 단위(1,048,576바이트). 표시는 "MB" 로 한다(기존 정책 기본값 10 MiB 와 같은 관례). */
export const MIB = 1024 * 1024;

/**
 * **코드 천장** — 요금제·운영자 덮어쓰기가 무엇이든 넘지 않는다. 적용 지점의 기존 상수와 같은 값이다(머리말).
 * DB CHECK(`202609250300_org_entitlements.sql`)도 같은 상한을 건다 — 천장을 올리려면 코드·마이그레이션·리뷰가 함께 든다.
 */
export const ENTITLEMENT_CEILINGS: EntitlementLimits = {
  // `MAX_AGENTS_PER_ORG`(src/admin/ops/agents.ts) — 비활성 포함 총합의 절대 천장이기도 하다.
  maxAgents: 1000,
  // `WARMUP_STEADY_STATE_DAILY_CAP`(src/policy/rules/limits.ts). Phase 1 의 절대 상한 — 넘기려면 코드·리뷰·SES 평판 작업(R22).
  orgDailyRecipients: 1000,
  agentPerDayMax: 10_000,
  // 소유자 입력 `per_minute` 의 옛 상한(1~9999, src/admin/ops/policy.ts).
  agentPerMinuteMax: 9999,
  // `MAX_RECIPIENTS_PER_MESSAGE`(src/policy/rules/content.ts).
  recipientsPerMessageMax: 50,
  // `MAX_ACTIVE_TOKENS_PER_AGENT`(src/admin/ops/tokens.ts) = DB 트리거 5.
  tokensPerAgentMax: 5,
  // `MAX_WEBHOOK_ENDPOINTS_PER_AGENT`(src/api/routes/webhook-endpoints.ts).
  webhookEndpointsPerAgentMax: 10,
  // `MAX_ACTIVE_ORG_KEYS`(src/admin/ops/org-keys.ts).
  orgApiKeysMax: 5,
  inboundStorageBytes: 1024 * GB,
  // `MAX_ACTIVE_ALIASES_PER_AGENT`(src/admin/ops/addresses.ts) = DB 트리거 `agent_addresses_alias_ceiling` 의 20.
  aliasesPerAgentMax: 20,
  // `ATTACHMENT_BYTES_CEILING`(src/api/outbound-attachments.ts) — 25 MiB × base64 1.37 ≈ 36 MB < SES 40 MB.
  attachmentBytesTotalMax: 25 * MIB,
};

/**
 * **베타 기간 스위치**(ADR-0011 §10) — 켜져 있으면 검토 활성화(`pnpm admin:org-review --activate`)가 같은 트랜잭션에서 `ACTIVATION_PLAN` 을 준다
 * (출처 `operator` · 원인 `review`). **꺼져 있다**(2026-09-30): 가입 조직은 바로 활성 + 행 없음 = Free 이고, Beta 는 운영자가 `pnpm admin:plan`
 * 으로만 준다. 끄는 것은 앞으로의 부여만이다(이미 받은 beta 행은 그대로). SQL 쪽 `ops_activation_beta_enabled()` 와 한 쌍이다.
 */
export const BETA_ON_ACTIVATION: boolean = false;

/** 검토 활성화 때 주는 요금제(`BETA_ON_ACTIVATION` 이 켜져 있을 때만). */
export const ACTIVATION_PLAN: PlanCode = 'beta';

/** 비활성 포함 에이전트 총합 = 요금제 한도 × 이 배수(천장 `ENTITLEMENT_CEILINGS.maxAgents` 로 자른다) — B7 "결정 필요" 의 제안. */
export const AGENT_TOTAL_MULTIPLIER = 3;

/**
 * 요금제 카탈로그(B2). **가격은 자리표시**라 여기 없다. `beta` 는 지금 활성 조직이 받는 한도 그대로다(에이전트 10 · 발송은 워밍업과
 * 정책이 정한다) — 조용히 한도를 낮추지 않는다(GA 후 60일까지 유예, ADR-0011). Team·Scale 의 조직 수신자/일은 B2 표의 5,000·20,000 이 아니라
 * 천장 1,000 이다 — 워밍업 정상상태를 넘기려면 코드 변경이 먼저다.
 */
export const PLAN_CATALOG: Readonly<Record<PlanCode, EntitlementLimits>> = {
  free: {
    maxAgents: 3,
    orgDailyRecipients: 100,
    agentPerDayMax: 100,
    agentPerMinuteMax: 5,
    recipientsPerMessageMax: 10,
    tokensPerAgentMax: 2,
    webhookEndpointsPerAgentMax: 1,
    orgApiKeysMax: 1,
    inboundStorageBytes: 1 * GB,
    aliasesPerAgentMax: 0,
    attachmentBytesTotalMax: 5 * MIB,
  },
  beta: {
    maxAgents: 10,
    orgDailyRecipients: 1000,
    agentPerDayMax: 10_000,
    agentPerMinuteMax: 9999,
    recipientsPerMessageMax: 50,
    tokensPerAgentMax: 5,
    webhookEndpointsPerAgentMax: 10,
    orgApiKeysMax: 5,
    inboundStorageBytes: 10 * GB,
    aliasesPerAgentMax: 3,
    attachmentBytesTotalMax: 10 * MIB,
  },
  pro: {
    maxAgents: 10,
    orgDailyRecipients: 1000,
    agentPerDayMax: 300,
    agentPerMinuteMax: 30,
    recipientsPerMessageMax: 25,
    tokensPerAgentMax: 5,
    webhookEndpointsPerAgentMax: 3,
    orgApiKeysMax: 2,
    inboundStorageBytes: 10 * GB,
    aliasesPerAgentMax: 5,
    attachmentBytesTotalMax: 10 * MIB,
  },
  team: {
    maxAgents: 50,
    orgDailyRecipients: 1000,
    agentPerDayMax: 1000,
    agentPerMinuteMax: 120,
    recipientsPerMessageMax: 50,
    tokensPerAgentMax: 5,
    webhookEndpointsPerAgentMax: 10,
    orgApiKeysMax: 5,
    inboundStorageBytes: 50 * GB,
    aliasesPerAgentMax: 10,
    attachmentBytesTotalMax: 20 * MIB,
  },
  scale: {
    maxAgents: 200,
    orgDailyRecipients: 1000,
    agentPerDayMax: 5000,
    agentPerMinuteMax: 600,
    recipientsPerMessageMax: 50,
    tokensPerAgentMax: 5,
    webhookEndpointsPerAgentMax: 10,
    orgApiKeysMax: 5,
    inboundStorageBytes: 200 * GB,
    aliasesPerAgentMax: 20,
    attachmentBytesTotalMax: 25 * MIB,
  },
};

/** 한도 차원의 이름(카멜) ↔ `org_entitlements` 칸(스네이크). CLI 덮어쓰기 · 잎 · 검증기가 같은 순서를 쓴다. */
export const LIMIT_COLUMNS: ReadonlyArray<readonly [keyof EntitlementLimits, string]> = [
  ['maxAgents', 'max_agents'],
  ['orgDailyRecipients', 'org_daily_recipients'],
  ['agentPerDayMax', 'agent_per_day_max'],
  ['agentPerMinuteMax', 'agent_per_minute_max'],
  ['recipientsPerMessageMax', 'recipients_per_message_max'],
  ['tokensPerAgentMax', 'tokens_per_agent_max'],
  ['webhookEndpointsPerAgentMax', 'webhook_endpoints_per_agent_max'],
  ['orgApiKeysMax', 'org_api_keys_max'],
  ['inboundStorageBytes', 'inbound_storage_bytes'],
  // 메일 기본기 2차(202609270105, ADR-0013 D6) — 이 순서로 **끝에** 붙인다(잎·검증기·카탈로그 일치 트리거 배열이 같은 순서).
  ['aliasesPerAgentMax', 'aliases_per_agent_max'],
  ['attachmentBytesTotalMax', 'attachment_bytes_total_max'],
];

/**
 * 메일 기본기 2차에 더한 두 칸(202609270105). 칸을 **NULL 허용으로 더한 뒤 백필**(202609270120)하므로, 그 사이(와 칸이 아직 없는 옛 스키마)의 행은
 * 이 칸이 비어 있다 — 해석은 그 행 요금제의 **카탈로그 값**이다(DB 트리거 `org_entitlements_fill_new_limits` 가 쓰기 때 채우는 값과 같다).
 */
export const LATE_LIMIT_KEYS: ReadonlySet<keyof EntitlementLimits> = new Set(['aliasesPerAgentMax', 'attachmentBytesTotalMax']);

/**
 * `org_entitlements` 표가 없다는 표시(`to_regclass` 가 NULL — 마이그레이션 전). 행 없음(`null` = Free)과 다르다 — 로더가 도입 전 한도를 쓴다.
 */
export const ENTITLEMENTS_TABLE_MISSING = 'table_missing' as const;
export type EntitlementsTableMissing = typeof ENTITLEMENTS_TABLE_MISSING;

/** `org_entitlements` 한 행 중 해석에 필요한 칸(행 타입 `OrgEntitlementsRow` 의 부분 — `src/db/schema.ts`). */
export interface EntitlementRowInput {
  readonly plan_code: string;
  readonly max_agents: number;
  readonly org_daily_recipients: number;
  readonly agent_per_day_max: number;
  readonly agent_per_minute_max: number;
  readonly recipients_per_message_max: number;
  readonly tokens_per_agent_max: number;
  readonly webhook_endpoints_per_agent_max: number;
  readonly org_api_keys_max: number;
  /** `bigint` 칸 — 드라이버가 문자열로 줄 수 있다. */
  readonly inbound_storage_bytes: number | string;
  /** 202609270105 — 백필(0120) 전·칸이 없는 옛 스키마면 NULL/없음(→ 카탈로그 값, `LATE_LIMIT_KEYS`). */
  readonly aliases_per_agent_max?: number | string | null;
  readonly attachment_bytes_total_max?: number | string | null;
  readonly grace_until: Date | null;
}

/** 0 이상 안전 정수로, 천장 이하로. 모양이 아니면 0(좁은 쪽 — 한도 0 은 "막는다" 이다). */
function clampLimit(value: unknown, ceiling: number): number {
  const n = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return 0;
  return Math.min(n, ceiling);
}

function freeEntitlements(basis: Entitlements['basis']): Entitlements {
  return { planCode: 'free', basis, ...PLAN_CATALOG.free };
}

/**
 * 행 → 지금 적용할 엔타이틀먼트. **행이 없거나 유예가 끝났으면 Free**, 모르는 요금제 코드도 Free(DB CHECK 가 막지만 한 번 더). **표가 없으면
 * 도입 전 한도**(beta 카탈로그 — `table_missing`). 모든 한도는 천장으로 자른다. 순수 함수 — 정책 로더·관리 연산·API 가 같은 함수를 부른다.
 */
export function resolveEntitlements(row: EntitlementRowInput | EntitlementsTableMissing | null, now: Date): Entitlements {
  if (row === ENTITLEMENTS_TABLE_MISSING) return { planCode: 'beta', basis: 'table_missing', ...PLAN_CATALOG.beta };
  if (row === null) return freeEntitlements('missing');
  if (!isPlanCode(row.plan_code)) return freeEntitlements('missing');
  if (row.grace_until !== null && row.grace_until.getTime() <= now.getTime()) return freeEntitlements('grace_expired');
  const limits = {} as Record<keyof EntitlementLimits, number>;
  const record = row as unknown as Record<string, unknown>;
  for (const [key, column] of LIMIT_COLUMNS) {
    const value = record[column];
    // 늦게 더한 칸이 비었다(백필 전·옛 스키마) — 그 요금제의 카탈로그 값. 다른 칸의 "모양 아님 = 0" 규칙은 그대로다.
    const filled = (value === null || value === undefined) && LATE_LIMIT_KEYS.has(key) ? PLAN_CATALOG[row.plan_code][key] : value;
    limits[key] = clampLimit(filled, ENTITLEMENT_CEILINGS[key]);
  }
  return { planCode: row.plan_code, basis: 'row', ...limits };
}

/** 비활성 포함 에이전트 총합의 천장 — 요금제 한도 × 3, 절대 천장 이하. */
export function agentTotalCeiling(entitlements: Pick<EntitlementLimits, 'maxAgents'>): number {
  return Math.min(entitlements.maxAgents * AGENT_TOTAL_MULTIPLIER, ENTITLEMENT_CEILINGS.maxAgents);
}

// ---------------------------------------------------------------------------
// 결제 공급자(WP-2) — 결제로 살 수 있는 요금제 · 순위 · 칸별 지배 비교
// ---------------------------------------------------------------------------

/**
 * **결제로 살 수 있는 요금제** — `free`(행 없음)·`beta`(운영자 부여)는 결제로 얻지 못한다. `src/db/schema.ts` 의 `BillingPlanCode` 와 같은
 * 집합이다(이 파일은 import 가 없어 그 타입을 끌어오지 않는다 — 두 타입이 같은지는 `test/unit/billing/plans.test.ts` 가 본다). 표
 * `billing_subscriptions.plan_code`·`billing_checkouts.plan_code` CHECK 와 가격 매핑(`paddle/prices.ts`)도 이 집합이다.
 */
export const PAID_PLAN_CODES = ['pro', 'team', 'scale'] as const satisfies readonly Exclude<PlanCode, 'free' | 'beta'>[];
export type PaidPlanCode = (typeof PAID_PLAN_CODES)[number];

export function isPaidPlanCode(value: unknown): value is PaidPlanCode {
  return typeof value === 'string' && (PAID_PLAN_CODES as readonly string[]).includes(value);
}

/**
 * 요금제 순위(계획 §3-3.7) — **구독 후보 고르기와 표시에만** 쓴다. `beta` 가 들어 있다(누락은 타입 오류): beta 는 Pro 와 같은 자리지만
 * 한도 모양이 다르다(하루 발송·분당 발송이 훨씬 크다). 그래서 결제가 운영자·백필 행을 덮을지는 **순위가 아니라 칸별 지배 비교**
 * (`dominatesLimits`)로 정한다 — "beta 행 + pro 활성" 은 순위가 같아도 pro 가 beta 를 지배하지 못해 덮지 않는다(D-3).
 */
export const PLAN_RANK: Readonly<Record<PlanCode, number>> = { free: 0, pro: 1, beta: 1, team: 2, scale: 3 };

/** `a` 가 `b` 를 **칸별로** 지배하는가 — 한도 열한 칸이 모두 `a ≥ b`. 하나라도 작으면 거짓(결제가 한도를 낮추는 쪽으로 덮지 않게). */
export function dominatesLimits(a: EntitlementLimits, b: EntitlementLimits): boolean {
  return LIMIT_COLUMNS.every(([key]) => a[key] >= b[key]);
}

// ---------------------------------------------------------------------------
// 고객 도메인(ADR-0014 결정 10 · 진윤겸 J3 2026-09-29) — 코드 카탈로그, `org_entitlements` 칸 없음
// ---------------------------------------------------------------------------

/**
 * 요금제별 **살아 있는 고객 도메인 수** 상한 — free 0 · beta 1 · pro 1 · team 3 · scale 10. "살아 있는" = pending · verifying · verified ·
 * suspended(removed 만 제외 — pending 도 센다: 선점·SES identity 한도 소모 방지). `org_entitlements` 에 칸을 두지 않는다 — 두면 잎
 * `billing.entitlement` 모양과 검증기 판이 바뀐다(메일 기본기 F17 과 같은 판단, ADR-0014). 앱(admin)이 조직 advisory 잠금 아래 센다.
 * **기능 허용 목록(`org_features`)이 먼저다** — 여기 수가 있어도 허용되지 않은 조직은 0 이다(M13).
 */
export const CUSTOM_DOMAIN_LIMITS: Readonly<Record<PlanCode, number>> = { free: 0, beta: 1, pro: 1, team: 3, scale: 10 };

/**
 * 조직당 살아 있는 도메인의 **코드 천장**(요금제와 무관) — DB 트리거 `custom_domains_limits_guard` 가 같은 값으로 집행한다(SQL 함수
 * `atmark_custom_domains_ceiling()` · 단위 테스트가 대조). 요금제 한도는 이 값 이하다.
 */
export const CUSTOM_DOMAINS_CEILING = 20;

/** 조직당 동시 `pending` 도메인 상한(DB `atmark_custom_domains_pending_max()` 와 같다). 소유 증명 전 선점을 줄인다. */
export const CUSTOM_DOMAIN_PENDING_MAX = 2;

/** 요금제의 도메인 상한 — 천장으로 자른다(카탈로그가 천장을 넘어도 넓어지지 않는다). */
export function customDomainLimitOf(planCode: PlanCode): number {
  return Math.min(CUSTOM_DOMAIN_LIMITS[planCode], CUSTOM_DOMAINS_CEILING);
}
