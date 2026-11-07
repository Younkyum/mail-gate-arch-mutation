/**
 * 정책 엔진의 타입 기반. 계획 §4.2 원칙 2 — "후단 규칙은 선행 거부를 넓힐 수 없다" — 를 **타입으로** 강제한다:
 * Stage 0~6 에는 허용을 표현할 타입(`DenyOnly` 뿐)을 주지 않아, 하드 거부 단계가 허용을 내는 코드는 컴파일되지 않는다.
 *
 * 규약(`exactOptionalPropertyTypes`): nullable 은 `T | null`, `EvaluationContext` 에 optional 은 쓰지 않는다 — optional 은
 * "채우지 않는 호출자" 를 허락하고, 그 호출자가 관문을 얇게 지나가는 경로가 된다(§5.0).
 */

// ---------------------------------------------------------------------------
// DB 타입 re-export — **재정의 금지**
// ---------------------------------------------------------------------------

/** 열거형·행 타입의 원천은 `src/db/schema.ts` 다 — 여기서 다시 쓰면 DB 와 엔진이 갈라진다. 통과만 시킨다. */
export type {
  AgentId,
  AgentStatus,
  AuditDecision,
  BillingStatus,
  InboundMode,
  InboundPolicyReason,
  InboundSenderTrust,
  InjectionRisk,
  JsonObject,
  OrganizationReviewStatus,
  OutboundMode,
  ThreadStarter,
} from '../db/schema';

export {
  BILLING_STATUSES_BLOCKING_OUTBOUND,
  DEFAULT_INBOUND_MODE,
  DEFAULT_OUTBOUND_MODE,
  INBOUND_MODES,
  isAgentId,
  LEGACY_OUTBOUND_MODES,
  OUTBOUND_MODES,
  toAgentId,
} from '../db/schema';

/** 바인딩 주소 도메인의 관문 상태(ADR-0014). 정의는 `domains/contract.ts`(순환 회피) — 다시 내보내기만 한다. */
export type { DomainGateStatus } from '../domains/contract';

import type { Entitlements } from '../billing/plans';
import type { DomainGateStatus } from '../domains/contract';
import type { DlpFamily } from '../security/dlp/scan';
import type {
  AgentId,
  AgentStatus,
  AuditDecision,
  BillingStatus,
  InboundSenderTrust,
  InjectionRisk,
  OrganizationReviewStatus,
  OutboundMode,
  ThreadStarter,
} from '../db/schema';

// ---------------------------------------------------------------------------
// 거부 사유 코드
// ---------------------------------------------------------------------------

/** 거부 사유는 닫힌 유니온이다 — audit `reasons[]` 가 운영 질의(AC-9)의 축이라 오타 하나가 집계 축을 빠뜨린다. */
export type DenyReason =
  // Stage 0 — kill switches
  | 'org_billing_blocked'
  | 'org_abuse_freeze'
  /** 소유자 조직 정지(`owner_paused`). 플랫폼 동결과 나눈다 — 누가 푸는지가 다르다. */
  | 'org_owner_paused'
  /** 셀프 가입 조직이 운영자 검토 전이다 — 가입하자마자 우리 도메인으로 내보내는 길을 닫는다. */
  | 'org_pending_review'
  /** 운영자가 가입을 거절했다. */
  | 'org_review_rejected'
  | 'agent_not_active'
  /** 발신 모드 "전부 X"(`disabled`). 옛 이름 `outbound_mode_disabled`. */
  | 'outbound_disabled'
  /**
   * 발신 고객 도메인이 발신할 수 없다(ADR-0014 — suspended·removed·행 없음). 영구 — 소유권·평판 사건은 "나중에 몰아서" 가 아니다.
   * 운영 제동이라 `POLICY_VIOLATION_REASONS` 밖이다.
   */
  | 'domain_suspended'
  /** 발신 도메인이 요금제 강등으로 정지됐다 — 업그레이드로 풀리므로 transient. */
  | 'domain_plan_limit'
  // Stage 1 — identity binding (AC-1)
  | 'from_forgery'
  /**
   * From 이 이 에이전트의 주소지만 지금 쓸 수 없다(폐기된 별칭 · 잠든 앵커 — ADR-0014 개정). 영구. **위반이 아니다** —
   * 플랫폼·소유자의 폐기가 여권 `no_policy_violations` 를 깨면 안 된다.
   */
  | 'from_inactive'
  /**
   * 수신자에 자기 주소가 있다(`+tag` 포함, 검증 L1). 모든 모드에서 막는다 — 자기 입력을 자기 컨텍스트로 되먹이는 루프이고,
   * 수신 필터(정책·스캐너)를 자기 발신으로 세탁하는 길이다.
   */
  | 'recipient_is_self'
  // Stage 2 — suppression
  | 'suppression_list'
  | 'ses_account_level_suppression'
  // Stage 3 — 발신 차단 목록. 옛 이름 `blocklist`.
  | 'recipient_blocklisted'
  // Stage 4 — rate & volume
  | 'rate_limit_per_minute'
  | 'rate_limit_per_hour'
  | 'rate_limit_per_day'
  /** 메시지당 수신자가 소유자 정책 한도를 넘었다 — 봉투의 성질(영구). */
  | 'recipients_per_message'
  /** 정책 한도 안이지만 요금제 한도(ADR-0011)를 넘었다 — 요금제가 풀리면 나간다(강등 뒤 승인된 봉투를 죽이지 않는다). */
  | 'plan_recipients_per_message'
  | 'warmup_daily_cap'
  /** 조직 하루 수신자가 요금제 한도에 닿았다 — 그 한도가 워밍업 캡보다 작을 때만(콘솔이 업그레이드를 안내할 수 있는 경우). */
  | 'plan_daily_cap'
  /** 고객 도메인의 워밍업 캡(ADR-0014). transient. `atmark.ai` 에는 적용하지 않는다. */
  | 'domain_warmup_daily_cap'
  // Stage 5 — budget
  | 'budget_exhausted'
  // Stage 6 — content guards
  | 'attachment_bytes_exceeded'
  | 'mime_type_not_allowed'
  | 'recipient_ceiling_exceeded'
  // Stage 7 — outbound_mode
  /** `allowlist_only` 의 목록 밖 수신자 — 승인 경로 없음(진윤겸 결정 ①). 옛 이름 `recipient_not_in_allowlist`. */
  | 'recipient_not_allowlisted'
  /** `reply_only` 에서 검증된 인바운드 스레드 밖 발송이고 grace 도 끝났다(§3.1 층 3, AC-a3). */
  | 'reply_only_no_inbound_thread'
  /**
   * `reply_only` 의 스레드 회신인데 답하는 메일이 격리돼 있다(grace 도 끝났다). injection 의심 메일에 사람 없이 답하지 않는다.
   * 스레드는 있으므로 `reply_only_no_inbound_thread` 와 나눈다.
   */
  | 'reply_only_inbound_quarantined'
  // 관문 단계 (engine 밖)
  | 'unregistered_route'
  | 'evaluation_error'
  /**
   * 릴리스 전용 — 재평가는 허용했지만 재시도 창(승인 + 48h)과 유예가 지났다("승인한 메일이 사흘 뒤 나간다" 를 막는다).
   * 엔진은 만들지 않는다 — 관문(`reserveRelease`)과 일정 저장소(`claimDueReleases`)가 닫는다.
   */
  | 'release_window_expired'
  /** `reply_only` 의 사람 없는 회신에 위험 신호(오염 · DLP)가 걸렸다 — 보류할 사람이 없어 거부(ADR-0016). */
  | 'reply_only_risk_hold'
  /** `reply_only` 의 사람 없는 회신인데 소유자가 발신 승인 `always` 를 골랐다 — 같은 이유로 거부. */
  | 'reply_only_owner_approval';

/** 허용 사유. `reasons[]` 는 `allowed` 에서도 비지 않는다 (§5.1 속성 불변식 ④). */
export type AllowReason =
  | 'allowlist_match'
  | 'unrestricted_mode'
  /** `blocklist_only` 에서 Stage 3 을 지났다. */
  | 'not_blocklisted'
  // Stage 7 — approval_required / reply_only (P2)
  /** seed contact(§3.1 층 2, AC-a2) — 소유자가 프로비저닝 때 적은 상대. */
  | 'seed_relationship'
  /** standing approval(§3.4 2조) — 이전 승인이 상환된 상대. */
  | 'standing_approval'
  /** pre-approval `auto_approve_reply_within_thread`(기본 true) — 에이전트가 시작한 스레드에서만. */
  | 'auto_approve_reply_within_thread'
  /** pre-approval `auto_approve_verification_senders`(기본 false) — 외부 스레드 회신이 사람 없이 나가는 유일한 문. */
  | 'auto_approve_verification_sender'
  /** pre-approval `auto_approve_domains`(기본 []). */
  | 'auto_approve_domain'
  /** 사람이 승인한 요청의 릴리스 — 로더가 DB 에서 `approved` 를 확인했을 때만(호출자가 주장할 수 없다). */
  | 'approval_granted'
  /** `reply_only` 의 스레드 내 회신. */
  | 'reply_within_thread';

/** 승인 대기 사유 — 허용도 거부도 아닌 세 번째 어휘(거부 집계에 섞이지 않게). */
export type PendingReason = 'new_recipient' | HumanApprovalReason | RiskHoldReason | OwnerApprovalReason;

/** 소유자 발신 승인(`send_approval = always`) — 엔진이 허용했을 발송을 소유자가 모두 본다. */
export type OwnerApprovalReason = 'owner_requires_approval';

/** 위험 보류 사유(ADR-0016) — 오염 맥락 또는 발신 DLP 계열(`DlpFamily` 와 1:1). 그 승인은 `once` 다. */
export type RiskHoldReason =
  | 'tainted_context'
  | 'dlp_atmark_credential'
  | 'dlp_third_party_secret'
  | 'dlp_verification_code'
  | 'dlp_secret_link'
  | 'dlp_inbound_copy'
  | 'dlp_scan_limit';

/**
 * 경로가 사람 승인을 요구한다 — 매니페스트 `requiresHumanApproval` 이 선언하는 사유(§3.2 2단계, AC-b1).
 * 경로 이름을 사유로 쓴다(AC-b2) — 최초 평가 행에 박혀 릴리스 뒤에도 남으므로 사유 하나로 집계된다.
 */
export type HumanApprovalReason = 'transition_announcement';

/** 허용·승인 대기 양쪽에 붙는 grace 표지(§3.1 층 3). 잔여는 `Decision.bootstrapGraceRemaining`. */
export type GraceReason = 'bootstrap_grace';

export type DecisionReason = DenyReason | AllowReason | PendingReason | GraceReason;

/** 최소 1개 — `reasons` 가 비어 있는 결정은 표현 불가능하다. */
export type NonEmptyReasons = readonly [DecisionReason, ...DecisionReason[]];

// ---------------------------------------------------------------------------
// DenyOnly — Stage 0~6 이 만들 수 있는 유일한 값
// ---------------------------------------------------------------------------

/** 하드 거부 단계의 결과 — 허용을 표현할 수단(`verdict`)이 없다. */
export interface DenyOnly {
  readonly kind: 'deny';
  readonly reasons: NonEmptyReasons;
  /** 한도·워밍업 거부에만 값이 있다. 그 외에는 `null` (§3.3 `retry_after` 헤더). */
  readonly retryAfterSeconds: number | null;
}

/**
 * 하드 Stage 의 반환값. `null` 은 허용이 아니라 "거부 사유 없음" 이다 — 긍정 값(`true`·`'allow'`)을 두면
 * "Stage 3 이 allow 했으니 보내자" 가 컴파일된다. 승인은 Stage 7 만 만든다.
 */
export type HardStageResult = DenyOnly | null;

/** Stage 0~6 규칙 모듈의 공통 시그니처. 순수 함수 — I/O 금지. */
export type HardStageRule = (ctx: EvaluationContext, policy: ResolvedPolicy) => HardStageResult;

/** 하드 거부 결과 생성자. 사유가 최소 1개임을 호출부에서 강제한다. */
export function deny(reasons: NonEmptyReasons, retryAfterSeconds: number | null = null): DenyOnly {
  return { kind: 'deny', reasons, retryAfterSeconds };
}

/** 누적한 사유를 `DenyOnly | null` 로 좁힌다(비면 `null`). 사유는 전부 남긴다 — 동시에 걸린 축마다 다음 행동이 다르다. */
export function denyIfAny(
  reasons: readonly DecisionReason[],
  retryAfterSeconds: number | null = null,
): HardStageResult {
  const [first, ...rest] = reasons;
  if (first === undefined) return null;
  return deny([first, ...rest], retryAfterSeconds);
}

// ---------------------------------------------------------------------------
// Decision — Stage 7 만이 만들 수 있는 최종 판정
// ---------------------------------------------------------------------------

/**
 * `Decision` 을 모듈 밖에서 객체 리터럴로 위조할 수 없게 하는 브랜드(export 하지 않는 `unique symbol`).
 * `Decision` 은 이 파일의 생성자로만 얻고, `allowed`·`pendingApproval` 은 Stage 7 만 부른다(`type-discipline.test.ts`).
 */
declare const DECISION_BRAND: unique symbol;

/** 관문이 audit 에 적고 돌려주는 최종 판정(§4.2 Stage 8). `verdict` 는 `audit_logs.decision` 과 같은 어휘다. */
export interface Decision {
  /** 위조 방지 브랜드. 런타임 값이 아니라 타입 전용이다. */
  readonly [DECISION_BRAND]: true;
  readonly verdict: AuditDecision;
  readonly reasons: NonEmptyReasons;
  /**
   * 평가 시점 정책 스냅샷(승인 중 정책이 바뀌어도 유지 — §4.3). `null` 은 정책을 읽지 못한 시도뿐이다
   * (`UNRESOLVED_POLICY_STAMP` — DB CHECK 가 `denied` + `evaluation_error` 로 좁힌다). 두 필드는 함께 있거나 함께 없다.
   */
  readonly policyVersion: number | null;
  readonly policyVersionId: string | null;
  readonly evaluatedAt: Date;
  readonly retryAfterSeconds: number | null;
  /** `reply_only` grace 잔여 — 이 시도가 나가면 남는 수(AC-a4). grace 와 무관한 결정은 `null`. */
  readonly bootstrapGraceRemaining: number | null;
}

/** 모든 `Decision` 에 찍는 평가 시점 정책 스탬프. */
export interface PolicyStamp {
  /** 정책을 읽지 못한 시도에서만 `null`. */
  readonly policyVersion: number | null;
  readonly policyVersionId: string | null;
  readonly evaluatedAt: Date;
}

function decision(
  verdict: AuditDecision,
  reasons: NonEmptyReasons,
  stamp: PolicyStamp,
  retryAfterSeconds: number | null,
  bootstrapGraceRemaining: number | null,
): Decision {
  // 브랜드는 타입 전용 — 캐스트가 이 한 곳뿐이라는 것이 위조 방지의 실체다.
  const value = {
    verdict,
    reasons,
    policyVersion: stamp.policyVersion,
    policyVersionId: stamp.policyVersionId,
    evaluatedAt: stamp.evaluatedAt,
    retryAfterSeconds,
    bootstrapGraceRemaining,
  };
  return value as unknown as Decision;
}

/** `DenyOnly` → `Decision`(거부). 사유·`retry_after` 를 그대로 옮기기만 한다 — Stage 의 근거와 audit 의 근거가 같아야 한다. */
export function toDeniedDecision(
  result: DenyOnly,
  stamp: PolicyStamp,
  bootstrapGraceRemaining: number | null = null,
): Decision {
  return decision('denied', result.reasons, stamp, result.retryAfterSeconds, bootstrapGraceRemaining);
}

/** 허용 판정 — **Stage 7(`rules/outbound-mode.ts`) 전용**(§4.2 원칙 2). */
export function allowed(
  reasons: NonEmptyReasons,
  stamp: PolicyStamp,
  bootstrapGraceRemaining: number | null = null,
): Decision {
  return decision('allowed', reasons, stamp, null, bootstrapGraceRemaining);
}

/** 승인 대기 판정 — **Stage 7 전용**. 찍는 자리가 둘이면 "사람에게 무엇을 물을까" 의 판정이 둘이 된다. */
export function pendingApproval(
  reasons: NonEmptyReasons,
  stamp: PolicyStamp,
  bootstrapGraceRemaining: number | null = null,
): Decision {
  return decision('pending_approval', reasons, stamp, null, bootstrapGraceRemaining);
}

/** Stage 7 의 시그니처 — `Decision` 을 반환하는 유일한 Stage 타입. */
export type TerminalStageRule = (
  ctx: EvaluationContext,
  policy: ResolvedPolicy,
  stamp: PolicyStamp,
) => Decision;

// ---------------------------------------------------------------------------
// EvaluationContext — optional 필드 0개
// ---------------------------------------------------------------------------

/** Stage 0 이 읽는 조직 상태. */
export interface OrganizationSnapshot {
  readonly id: string;
  readonly billingStatus: BillingStatus;
  readonly abuseFreeze: boolean;
  /** 소유자 조직 정지(콘솔). */
  readonly ownerPaused: boolean;
  /** 운영자 검토 상태(셀프 가입). `active` 가 아니면 Stage 0 이 거부한다. */
  readonly reviewStatus: OrganizationReviewStatus;
  /** 워밍업 램프 기준일. `null` 이면 아직 보낸 적이 없다. */
  readonly sendingStartedAt: Date | null;
  /** 요금제 한도(ADR-0011). 행이 없거나 유예가 끝났으면 Free(fail closed). 요금제는 조일 뿐 넓히지 못한다(`min`). */
  readonly entitlements: Entitlements;
}

/** Stage 0·1 이 읽는 에이전트 상태. */
export interface AgentSnapshot {
  readonly id: AgentId;
  readonly status: AgentStatus;
  /** `agent_addresses.address` 전량(판정형 — AC-1). */
  readonly boundAddresses: readonly string[];
  /** 이 에이전트의 주소지만 지금 쓸 수 없는 것(폐기된 별칭 등). Stage 1 이 `from_inactive`·`from_forgery` 를 가른다. */
  readonly inactiveAddresses: readonly string[];
  /** 살아 있는 바인딩 주소의 도메인마다 관문 상태(ADR-0014). 키 = 소문자 도메인. */
  readonly boundDomains: ReadonlyMap<string, DomainGateStatus>;
}

/** 이번 시도의 발신 고객 도메인(ADR-0014 — Stage 4 도메인 워밍업). */
export interface DomainSnapshot {
  /** 소문자 도메인(`custom_domains.domain`). */
  readonly domain: string;
  /** 도메인 워밍업 Day 1 = 그 도메인의 첫 발송 성공일. 없으면 `null`. */
  readonly sendingStartedAt: Date | null;
}

/** Stage 6 이 읽는 첨부 메타. 본문·바이트는 관문에 들어오지 않는다. */
export interface AttachmentMeta {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: number;
}

/** 이번 발송 시도 그 자체. */
export interface OutboundAttempt {
  /** `OUTBOUND_ROUTES` 의 `id`. */
  readonly routeId: string;
  /** 판정형 발신 주소. */
  readonly fromAddress: string;
  /** 판정형 수신 주소 전량(`+tag` 절단). */
  readonly recipients: readonly string[];
  readonly attachments: readonly AttachmentMeta[];
  /**
   * 회신 대상 스레드 — **호출자의 주장이라 정책은 믿지 않는다**(P3b). "스레드 회신인가" 는 로더만 답한다
   * (`ApprovalContext.thread`). 엔진(`rules/**`)은 이 필드를 읽지 않는다(`thread-reply.test.ts`). `thread` 스코프 관계 매칭도
   * 검증된 id 로만 한다 — 주장된 id 로 매칭하면 남의 스레드 관계를 빌려 쓴다.
   */
  readonly threadId: string | null;
  /**
   * 본문 모양 — 호출자가 아니라 발송 서비스가 실제 본문에서 계산한다(`classifyContentShape`). `auto_approve_verification_senders`
   * 의 전제가 읽는다. 본문을 모르는 경로(릴리스)는 `'other'`.
   */
  readonly contentShape: ContentShape;
  /**
   * 발신 DLP 계열(ADR-0016 B) — 발송 서비스가 서버가 조립한 최종 내용에서 계산한다(값 없이 계열 이름만). 위험 보류가 좁히는 방향으로만
   * 읽는다. 릴리스는 빈 배열(grant 로 위험 보류를 건너뛴다).
   */
  readonly dlp: readonly DlpFamily[];
  /**
   * 고정된 오염 맥락(리뷰 H1) — 예약이 만들어질 때 오염 맥락이었다(`scheduled_sends.risk_tainted`, 발송 서비스가 옮긴다).
   * 참이면 에이전트 창이 열린 것으로 친다 — 예약을 오염 창 밖으로 미뤄 우회하지 못하게. 예약이 아니면 `false`.
   */
  readonly pinnedTaint: boolean;
}

/** `code_only` — 짧은 확인 코드 한 줄(평문, 링크·html 없음). 모르면 `other`(어떤 문도 열지 않는다). */
export type ContentShape = 'code_only' | 'other';

/**
 * Stage 4 가 읽는 카운터(로더가 선적재). **눈금:** `agent*` 셋은 메시지 수, `*RecipientsLastDay` 는 수신자 수다 — 이름이 눈금을
 * 진다(메시지 수로 읽으면 워밍업 캡이 최대 50배 느슨해진다). 전부 이번 시도를 포함하지 않는다.
 */
export interface SendCounters {
  readonly agentLastMinute: number;
  readonly agentLastHour: number;
  readonly agentLastDay: number;
  /** 최근 24시간 조직 전체가 보낸 수신자 수. */
  readonly orgRecipientsLastDay: number;
  /** 최근 24시간 이 조직이 발신 고객 도메인으로 보낸 수신자 수(ADR-0014). 고객 도메인 발신이 아니면 0. */
  readonly domainRecipientsLastDay: number;
}

/** Stage 5 가 읽는 예산(센트 단위 정수). */
export interface BudgetSnapshot {
  readonly monthlyBudgetCents: number;
  readonly monthToDateSpentCents: number;
  readonly thisAttemptCostCents: number;
}

/**
 * 평가에 필요한 **모든** 입력 — `evaluate` 는 이것 말고 읽지 않는다. optional 필드 0개(`type-discipline.test.ts`) —
 * optional 은 케이스 공간을 배로 늘리고 그 절반이 테스트 없이 `undefined` 분기를 탄다.
 */
export interface EvaluationContext {
  readonly now: Date;
  readonly traceId: string | null;
  readonly organization: OrganizationSnapshot;
  readonly agent: AgentSnapshot;
  readonly attempt: OutboundAttempt;
  /** 조직 억제 목록에 걸린 수신자(Stage 2). */
  readonly suppressedRecipients: readonly string[];
  /** SES 계정 수준 억제에 걸린 수신자(Stage 2). */
  readonly sesSuppressedRecipients: readonly string[];
  readonly counters: SendCounters;
  readonly budget: BudgetSnapshot;
  /** 발신 고객 도메인의 워밍업 입력. `atmark.ai` 발신이면 `null`. */
  readonly sendingDomain: DomainSnapshot | null;
  /** Stage 7 이 읽는 승인 맥락. */
  readonly approval: ApprovalContext;
}

/** 수신자 하나에 매칭된 관계 — 스코프 매칭은 로더가 끝냈다(정규화 지점은 하나). */
export interface RelationshipMatch {
  /** 허용 비교형 수신자(소문자, `+tag` 보존). */
  readonly recipient: string;
  readonly trustCategory: 'seed' | 'approved';
  readonly scope: 'recipient' | 'thread' | 'domain';
}

/** 사람이 승인한 요청의 릴리스임을 로더가 DB 에서 확인한 결과(`approved` · 같은 에이전트). 호출자는 id 만 싣는다. */
export interface ApprovalGrant {
  readonly approvalId: string;
  /** 승인이 덮는 수신자(허용 비교형). 밖의 수신자는 grant 로 통과하지 않는다. */
  readonly recipients: readonly string[];
  /** `approval_requests.decided_by` — audit `approved_by` 로 간다. */
  readonly approvedBy: string;
}

/** `reply_only` bootstrap_grace 의 입력(§3.1 층 3). */
export interface BootstrapGraceInput {
  /** `agents.created_at` — 14일 시계의 기준. */
  readonly agentCreatedAt: Date;
  /** 지금까지 내보낸 outbound 수(`dispatching`+`sent`, 이번 시도 제외). */
  readonly outboundSentCount: number;
}

/** 이 회신이 답하는 수신 메일 — 스레드의 최신 인증(DMARC pass) 수신. 수신 시점에 저장된 값 그대로다. */
export interface RepliedInbound {
  readonly inboundMessageId: string;
  /** `null` = 판정 없음 — `'none'` 이 아니다(전제 불성립). */
  readonly injectionRisk: InjectionRisk | null;
  /** `null` = P4 이전 행 — `seen` 미만으로 읽는다. */
  readonly senderTrust: InboundSenderTrust | null;
  readonly quarantined: boolean;
  readonly receivedAt: Date;
  readonly attachmentCount: number;
  /** 이번 수신자 전원이 이 메일의 발신자인가(허용 비교형 — 좁은 쪽이 안전). */
  readonly recipientsAreItsSender: boolean;
}

/**
 * 로더가 확인한 스레드 회신(P3b) — ① 이 에이전트의 스레드 ② 권한용 스레드에 인증 수신이 있다 ③ 수신자 전원이 그 스레드의 인증 발신자.
 * 하나라도 거짓이면 `null`.
 */
export interface VerifiedThreadReply {
  readonly threadId: string;
  /** 스레드를 연 쪽. `auto_approve_reply_within_thread` 는 `'agent'` 에서만 열린다. */
  readonly startedBy: ThreadStarter;
  readonly repliedTo: RepliedInbound;
}

/** Stage 7 의 승인 경로가 읽는 입력 전부. */
export interface ApprovalContext {
  /**
   * 허용 판정용 수신자 — `attempt.recipients` 와 같은 순서·길이, 소문자화만(`+tag` 보존). **허용은 좁게, 거부는 넓게**:
   * 판정형으로 허용을 매칭하면 `sales+eu@` 승인이 `sales@`·모든 `sales+*` 를 연다(검증 V1 MINOR-2). Stage 7 은 이 목록만 읽는다.
   */
  readonly recipients: readonly string[];
  /** 검증된 스레드 회신. `null` 이면 스레드 회신이 아니다(주장만 있는 경우 포함). */
  readonly thread: VerifiedThreadReply | null;
  /** 이번 수신자들에 매칭된 관계. */
  readonly relationships: readonly RelationshipMatch[];
  /** 릴리스가 아니면 `null`. */
  readonly grant: ApprovalGrant | null;
  readonly bootstrapGrace: BootstrapGraceInput;
  /**
   * 이 경로는 사람 승인 없이 나갈 수 없다(값이 있으면 Stage 7 이 `allowed` 를 내지 않는다). 출처는 **매니페스트뿐** —
   * 시도(호출자가 만든다)가 아니라 로더가 만드는 맥락에 있어 에이전트가 끌 수 없다. 좁히는 방향으로만 읽힌다.
   */
  readonly humanApprovalRequired: HumanApprovalReason | null;
  /**
   * 위험 신호(ADR-0016 A) — 로더가 별도 포트(`RiskSignalSource`)로 계산한다. 호출자가 실을 자리가 없다(`risk-signals.arch.test.ts`).
   * `null` 이면 위험 보류 없음: 릴리스(grant 가 건너뛴다) 또는 포트 미배선(테스트 대역 — 운영 조립은 타입이 강제한다).
   */
  readonly riskHold: RiskHoldContext | null;
}

/** 위험 신호 — 창 계산이 끝난 사실(`security/taint.ts`). DLP 계열은 시도(`OutboundAttempt.dlp`)에 있다. */
export interface RiskHoldContext {
  /** 운영자 킬 스위치(`ATMARK_RISK_HOLD_ENFORCE`, 기본 enforce). `false`(관찰)면 판정을 바꾸지 않고 관문이 센다. */
  readonly enforce: boolean;
  /** 에이전트 4시간 창 안에 T2 노출이 있다. */
  readonly agentTainted: boolean;
  /** 이번 시도의 스레드(검증된 회신, 아니면 주장 — 좁히는 방향이라 주장도 쓴다)가 7일 창 안에서 오염됐다. */
  readonly threadTainted: boolean;
  /** 7일 창의 오염 발신자(허용 비교형 — 소문자, `+tag` 보존). */
  readonly taintedSenders: readonly string[];
}

// ---------------------------------------------------------------------------
// ResolvedPolicy — 평가 시점에 확정된 정책
// ---------------------------------------------------------------------------

/** Stage 4 의 한도(`agent_policies.limits` 를 로더가 좁힌 값). */
export interface PolicyLimits {
  readonly perMinute: number;
  readonly perHour: number;
  readonly perDay: number;
  readonly recipientsPerMessage: number;
}

/** Stage 6 의 콘텐츠 가드. `agent_policies.config_json` 에서 온다. */
export interface ContentPolicy {
  readonly maxAttachmentBytesTotal: number;
  readonly allowedMimeTypes: readonly string[];
}

/** 평가 시점에 확정된 정책 — DB 행(`AgentPolicyRow`)이 아니라 해석된 값이다. jsonb 좁히기는 로더가 끝낸다(fail closed). */
export interface ResolvedPolicy {
  readonly agentId: AgentId;
  readonly outboundMode: OutboundMode;
  /** `policy_versions.version` / `.id` — 모든 `Decision` 에 스탬프된다. */
  readonly version: number;
  readonly versionId: string;
  readonly limits: PolicyLimits;
  readonly content: ContentPolicy;
  /** Stage 7 `allowlist_only` 목록 — 주소는 허용 비교형(`+tag` 보존), 도메인은 그대로(`contact-rules.ts`). */
  readonly allowlist: readonly string[];
  /**
   * `allowlist` 의 주소 항목 중 **에이전트의 정책 변경 요청을 승인해 생긴 것**(허용 비교형 · 보안 감사 H-1). Stage 7 의 허용 판정은 그대로 열지만,
   * 위험 보류(ADR-0016)의 "소유자가 이름으로 신뢰한 상대" 면제는 주지 않는다(`rules/risk-hold.ts`). 출처는 로더(규칙 행의 요청 표지)만 안다.
   */
  readonly agentRequestedAllowlist: readonly string[];
  /** Stage 3 목록 — 주소는 판정형(`+tag` 절단), 도메인은 그대로. `unrestricted` 를 뺀 모든 모드에서 읽는다. */
  readonly blocklist: readonly string[];
  /** Stage 7 pre-approval 규칙(§3.4 3조). */
  readonly preApproval: PreApprovalRules;
  /** 승인 요청 TTL(초). 기본 24h, 범위 1h–7d(§3.4 4조). */
  readonly approvalTtlSeconds: number;
  /** 소유자 발신 승인. 로더는 행·스냅샷 중 하나라도 참이면 `always` 로 읽는다(좁은 쪽). */
  readonly sendApproval: 'auto' | 'always';
}

/**
 * pre-approval 규칙 3종(§3.4 3조). `autoApproveVerificationSenders` 는 기본 `false` 이고 GATE 동안 켜지 않는다(운영 결정).
 * 켜도 전제 전부(`verificationSenderQualifies`)가 참일 때만 열린다.
 */
export interface PreApprovalRules {
  readonly autoApproveReplyWithinThread: boolean;
  /** 소문자 도메인 — 수신자 도메인이 여기 있으면 승인 없이 통과한다. */
  readonly autoApproveDomains: readonly string[];
  readonly autoApproveVerificationSenders: boolean;
}

// ---------------------------------------------------------------------------
// 오류
// ---------------------------------------------------------------------------

/** 분기가 없는 `outbound_mode`(DB 의 열거형 밖 값)로 평가가 들어왔다 — 관문이 `evaluation_error` 로 닫는다. */
export class UnimplementedOutboundModeError extends Error {
  constructor(readonly mode: OutboundMode) {
    super(`outbound_mode "${String(mode)}" 에 대한 Stage 7 분기가 없다`);
    this.name = 'UnimplementedOutboundModeError';
  }
}
