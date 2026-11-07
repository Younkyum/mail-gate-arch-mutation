/**
 * src/db/schema.ts — P1a DB 스키마의 TypeScript 대응물.
 *
 * `src/db/migrations/2026092214*.sql` 의 8개 테이블과 1:1로 대응한다.
 * 정책 엔진(`src/policy/**`)이 이 파일을 import 한다 — 열거형과 행 타입의 단일
 * 진실 원천이며, 같은 유니온을 두 곳에서 정의하면 DB 와 엔진이 조용히 갈라진다.
 *
 * 규약 (`exactOptionalPropertyTypes: true` 대응):
 *   NULL 가능 컬럼은 전부 `T | null` 로 쓰고 optional(`?`)은 **쓰지 않는다**.
 *   DB 행은 "속성이 없는" 상태가 존재하지 않는다 — 값이 NULL 이거나 값이 있거나 둘뿐이다.
 *   둘을 섞으면 `exactOptionalPropertyTypes` 아래에서 대입 규칙이 갈라진다.
 *
 * 과금 유니온(요금제·공급자·환경·이벤트 종류)은 **타입만** `src/billing/` 에서 가져온다 — 그 두 파일은 import 가 없어 순환이 생기지 않고,
 * 같은 집합을 여기서 다시 쓰면 CHECK·결정 함수·웹훅 허용 목록이 조용히 갈라진다.
 */

import type { BillingEventType, BillingProvider, PaddleEnvironment } from '../billing/constants';
import type { PlanCode } from '../billing/plans';
import type { WebhookEventType } from '../webhooks/events';

import type {
  CustomDomainPendingReason,
  CustomDomainRemovalStep,
  CustomDomainSagaStep,
  CustomDomainSesStatus,
  CustomDomainStatus,
  CustomDomainSuspendedReason,
  CUSTOM_DOMAINS_FEATURE,
  DomainNoticeKind,
  InboundMxStatus,
  MailClaimKind,
} from '../domains/contract';

// ---------------------------------------------------------------------------
// 식별자 — agents.id (§4B.1)
// ---------------------------------------------------------------------------

/**
 * `agents.id` 의 형식. 16바이트 난수의 소문자 hex 32자.
 * did:web 경로 세그먼트에 안전하고, 온체인 bytes32 에 제로패딩으로 무손실 매핑된다.
 */
export const AGENT_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * 테이블: `agents.id` (그리고 모든 `agent_id` FK).
 *
 * 브랜디드 타입을 쓰는 이유: 이 프로젝트에는 문자열 식별자가 여럿이고(uuid PK,
 * `ses_message_id`, `message_id_header`, 주소) 그중 `agentId` 만이 공개 식별자이자
 * DID 문자열의 구성 요소다(§4B.1 — 내부 PK 와 공개 식별자를 하나로 합친 결과,
 * 이 값이 새는 표면이 곧 AC-12 의 노출 경계다). `string` 별칭으로 두면 uuid 를
 * `agent_id` 자리에 넣어도 컴파일이 통과하고, 그 오류는 런타임 CHECK 제약에서야 드러난다.
 */
export type AgentId = string & { readonly __brand: 'AgentId' };

/** `AGENT_ID_PATTERN` 을 만족하는지 검사하는 타입 가드. */
export function isAgentId(value: string): value is AgentId {
  return AGENT_ID_PATTERN.test(value);
}

/** 형식 검증 후 `AgentId` 로 승격한다. 위반은 예외 — fail closed (Principle P3). */
export function toAgentId(value: string): AgentId {
  if (!isAgentId(value)) {
    throw new Error(`invalid agentId: expected [0-9a-f]{32}, got ${JSON.stringify(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 열거형 — Postgres ENUM 과 1:1
// ---------------------------------------------------------------------------

/** 테이블: `organizations.billing_status`. Stage 0 킬 스위치가 읽는다. */
export type BillingStatus = 'trialing' | 'active' | 'delinquent' | 'suspended';

/** Stage 0 이 DENY 하는 `billing_status` 값들 (§4.2). */
export const BILLING_STATUSES_BLOCKING_OUTBOUND = ['delinquent', 'suspended'] as const;

/**
 * 테이블: `organizations.review_status`(`202609240800_self_signup.sql`). 셀프 가입 조직은 `pending_review` 로 태어나고 운영자
 * CLI(`admin:org-review`)만 바꾼다. Stage 0 은 `'active'` 가 **아니면** 전건 DENY(허용목록 방식 — 값이 늘면 기본이 거부).
 */
export type OrganizationReviewStatus = 'pending_review' | 'active' | 'rejected';

/** 테이블: `organizations.signup_source`. 조직을 만든 경로. */
export type OrganizationSignupSource = 'operator' | 'self_signup';

/** 테이블: `agents.status`. Stage 0 은 `'active'` 가 아니면 전건 DENY. */
export type AgentStatus = 'provisioning' | 'active' | 'suspended' | 'disabled';

/**
 * 테이블: `agent_keypairs.algorithm`. **값이 하나뿐인 것이 설계다** (계획 §3.5).
 * ed25519 를 고른 대가로 KMS 의 HSM 비수출성을 포기했고, 얻은 것은 AC-11 의 외부
 * 라이브러리 호환성이다. 값을 늘리려면 ENUM 을 ALTER 해야 하고 — 그때 §3.5 를 다시 읽게 된다.
 */
export type KeypairAlgorithm = 'ed25519';

/**
 * 테이블: `passports.status` (계획 §4B.1b 통합 상태값).
 *
 * **`AgentStatus` 와 축이 다르다.** 저쪽은 에이전트의 운영 상태, 이쪽은 신분증 문서의
 * 게시 상태다. 에이전트가 `'active'` 인데 passport 가 `'draft'` 인 상태는 P1~P5 내내
 * 정상이다 — PP-A 가 P1c 이고 게시는 P6 이기 때문이다(§4B.3 r4).
 *
 * 전이: `draft → published → suspended → published`, `published|suspended → revoked`(종단).
 * **어떤 상태에서도 문서를 삭제하지 않는다** — 삭제는 검증자에게 "이 DID 는 존재한 적
 * 없다"로 읽히고, 그것은 사칭보다 나쁜 실패 모드다.
 */
export type PassportStatus = 'draft' | 'published' | 'suspended' | 'revoked';

/** PP-A 가 만드는 유일한 상태 (§4B.2 — "서빙·서명·공개 API 없음"). */
export const INITIAL_PASSPORT_STATUS: PassportStatus = 'draft';

/**
 * 테이블: `agent_policies.outbound_mode`, `policy_versions.outbound_mode` (§4.1 · 정책 v2 — ADR-0007).
 *
 * 콘솔이 고르는 넷(`CONSOLE_OUTBOUND_MODES` — `src/admin/ops/policy.ts`)과 **레거시 둘**이다. 레거시(`approval_required`·`reply_only`)는
 * 엔진 분기·승인 흐름이 그대로 남지만 콘솔·API·CLI 로는 새로 고를 수 없다(`LEGACY_OUTBOUND_MODES`). 202609241010 이 기존 레거시
 * 에이전트를 `allowlist_only` 로 옮겼다 — 지금 레거시 모드는 소유자 롤(데모·테스트)만 만든다.
 */
export type OutboundMode =
  | 'disabled'           // 전부 X · None — Stage 0 에서 전건 DENY(`outbound_disabled`).
  | 'reply_only'         // 레거시. 기존 스레드 내 회신만 (+ bootstrap_grace, P2).
  | 'approval_required'  // 레거시. 관계 없는 상대는 사람 승인(P2 의 주력이었다 — ADR-0007 이 뒤집었다).
  | 'allowlist_only'     // 화이트리스트 · Allowlist — allow 목록의 상대만(밖 = `recipient_not_allowlisted`). **v2 기본값.**
  | 'unrestricted'       // 전체 · All — 수신자 제한 없음(Stage 0~6 은 그대로).
  | 'blocklist_only';    // 블랙리스트 · Blocklist — block 목록의 상대만 거부(`recipient_blocklisted`). 202609241000.

export const OUTBOUND_MODES = [
  'disabled',
  'reply_only',
  'approval_required',
  'allowlist_only',
  'unrestricted',
  'blocklist_only',
] as const satisfies readonly OutboundMode[];

/**
 * 신규 에이전트의 기본값 — **발신 화이트리스트(빈 목록)** (진윤겸 결정 ②, 계약 v2 §1). **DB 기본값과 같아야 한다** —
 * `202609241010_policy_v2.sql` 이 `agent_policies.outbound_mode` 의 DEFAULT 를 같은 값으로 옮겼다. 프로비저닝은 두 행
 * (`agent_policies`·`policy_versions`)에 이 상수를 명시한다 — 둘이 갈라지면 "정책 행은 A 인데 판정 근거는 B" 가 된다.
 *
 * P2 는 `approval_required` 였다(AC-a1). ADR-0007 이 그 결정을 뒤집었다 — 빈 화이트리스트는 "아무에게도 못 보냄" 이고,
 * 소유자가 콘솔에서 목록을 채운다.
 */
export const DEFAULT_OUTBOUND_MODE: OutboundMode = 'allowlist_only';

/**
 * **콘솔 세션에서 소유자가 만드는 새 에이전트**(`POST /api/agents`)의 발신 기본값 — **전체**(`unrestricted`). 진윤겸 결정 B(2026-10-13 — "초기 세팅은
 * 전체 허용 · 전체 수신으로", ADR-0007 개정). 수신은 그대로 `DEFAULT_INBOUND_MODE`(전체). 이 값은 콘솔 라우트(`admin/routes/agents.ts`)만 명시한다 —
 * 조직 API 키(`agents:create`) · 운영자 CLI(`admin:agent-provision` · 예약 주소) · 자가 등록은 `allowlist_only` 를 명시하고, 관리 연산의 기본(명시 없음)도
 * `allowlist_only` 다(적대 검증 I08 — 키가 새도 바로 아무에게나 보내는 에이전트를 만들 수 없게). `DEFAULT_OUTBOUND_MODE`(프로비저닝 함수 · DB 기본값)도
 * 좁은 쪽 그대로. 이미 있는 에이전트는 바뀌지 않는다. "전체" 도 Stage 0~6 · 위험 보류(ADR-0016) · DLP · 한도 · 워밍업은 그대로 지난다.
 */
export const OWNER_CREATED_OUTBOUND_MODE: OutboundMode = 'unrestricted';

/**
 * **레거시 발신 모드** — 엔진 분기·승인 흐름은 남고, 콘솔·API·CLI 로는 고를 수 없다(`legacy_mode_rejected`). 소유자 롤로
 * 프로비저닝할 때(`provisionAgent` 의 `outboundMode`)만 생긴다 — 데모·테스트가 승인 장면을 보여 줄 때.
 */
export const LEGACY_OUTBOUND_MODES = ['approval_required', 'reply_only'] as const satisfies readonly OutboundMode[];

/**
 * 테이블: `agent_policies.inbound_mode`, `policy_versions.inbound_mode` (정책 v2, 202609241010). 수신 소비자가 저장 때 판정한다
 * (`src/policy/inbound-policy.ts`) — 막힌 메일은 격리(`quarantine_reason = 'policy_blocked'`)되고 에이전트에게 보이지 않는다.
 */
export type InboundMode = 'all' | 'allowlist_only' | 'blocklist_only' | 'disabled';

export const INBOUND_MODES = ['all', 'allowlist_only', 'blocklist_only', 'disabled'] as const satisfies readonly InboundMode[];

/** 신규 에이전트의 수신 기본값 — **전체**(진윤겸 결정 ②). DB 기본값과 같다. */
export const DEFAULT_INBOUND_MODE: InboundMode = 'all';

/** `agent_contact_rules.direction` — 목록이 거르는 방향. */
export type ContactRuleDirection = 'inbound' | 'outbound';
export const CONTACT_RULE_DIRECTIONS = ['inbound', 'outbound'] as const satisfies readonly ContactRuleDirection[];

/** `agent_contact_rules.list`. */
export type ContactRuleList = 'allow' | 'block';
export const CONTACT_RULE_LISTS = ['allow', 'block'] as const satisfies readonly ContactRuleList[];

/** `agent_contact_rules.kind` — 값에서 정해진다(`@` 가 있으면 주소). DB CHECK `agent_contact_rules_value_kind`. */
export type ContactRuleKind = 'address' | 'domain';

/** 에이전트·방향·목록마다 규칙 상한 — DB 트리거 `agent_contact_rules_limit` 과 같은 값. */
export const MAX_CONTACT_RULES_PER_LIST = 1000;

/**
 * 테이블: `agent_contact_rules` — 더하기·지우기만. **지우기는 표시다**(`removed_at`·`removed_by` 를 한 번 — 202609241020, admin 롤
 * DELETE 0). 그 밖의 UPDATE·DELETE 는 트리거가 거부한다. 변경 = 새 `policy_versions` 행. 판정은 살아 있는 행(`removed_at IS NULL`)만.
 */
export interface ContactRuleRow {
  id: string;
  agent_id: AgentId;
  direction: ContactRuleDirection;
  list: ContactRuleList;
  kind: ContactRuleKind;
  /** 소문자·ASCII. 주소는 `+tag` 보존, 도메인은 `example.com` 또는 `*.example.com`. */
  value: string;
  created_at: Date;
  created_by: string | null;
  /** 지운 시각. `null` = 살아 있는 규칙(읽는 쪽은 전부 이것만 본다). */
  removed_at: Date | null;
  removed_by: string | null;
}

/**
 * `inbound_messages.quarantine_reason` (202609241010). v2 이전 격리 행은 NULL 이다. `risk_hold`(202610081000) = 위험 등급 + 에이전트 설정 `hold`
 * (에이전트에게 격리와 똑같이 숨는다 — 소유자가 풀 때까지). 풀린 행은 NULL 로 돌아가고 `released_from` 이 무엇에서 풀렸는지 남긴다.
 */
export type InboundQuarantineReason = 'injection_risk' | 'scanner_error' | 'policy_blocked' | 'risk_hold';

/** `inbound_messages.watch_level`(202610081000) — 수신 시점 사용자 등급(`src/security/levels.ts`). 옛 행은 NULL. */
export type InboundWatchLevel = 'none' | 'risk' | 'block';

/** `agent_watch_settings.risk_handling` — 위험 등급 메일을 에이전트에게 바로 보이나(`deliver`) 숨기나(`hold`). */
export type RiskHandling = 'deliver' | 'hold';

/** `org_trusted_senders.kind` — 정확한 주소 또는 정확한 도메인. */
export type TrustedSenderKind = 'address' | 'domain';

/** `inbound_messages.policy_reason` — 수신 정책이 막은 이유. `quarantine_reason = 'policy_blocked'` 일 때만. */
export type InboundPolicyReason = 'sender_not_allowlisted' | 'sender_blocklisted' | 'inbound_disabled';

/** 테이블: `messages.direction`. */
export type MessageDirection = 'outbound' | 'inbound';

/**
 * 테이블: `messages.status` 중 **발송 상태기계** 부분 (§4.5 2번).
 *   `pending → dispatching(lease_id, lease_expires_at, attempt) → sent(ses_message_id) | failed(reason)`
 *   `pending → denied`  — 정책이 막았다. lease 도 SES 호출도 없었다.
 * SQS 는 at-least-once 이므로 이 전이를 조건부 UPDATE 로 묶는 것이 중복 발송 방어의 뿌리다.
 *
 * **`'denied'` 가 P1b 리뷰에서 추가된 이유** (마이그레이션 `202609221500`·`202609221510`):
 * 정책이 막은 시도는 `pending` 으로 영구히 남았고, 그래서 같은 멱등 키의 재호출이
 * 최초의 403 대신 202 를 받았다 — §4.5-1(*"동일 키 재호출은 최초 결과를 그대로 반환"*)
 * 위반이며, 클라이언트는 영원히 나가지 않을 메일을 기다렸다. `messages` 가
 * "정책이 막았다" 를 말할 수 있어야 그 계약이 성립한다.
 */
export type OutboundMessageStatus = 'pending' | 'dispatching' | 'sent' | 'failed' | 'denied';

/**
 * 발송 상태기계의 종단 상태. 여기 도달하면 lease 재취득이 없다.
 * `'denied'` 가 여기 있는 것이 요점이다 — 거부된 행에 재전달이 lease 를 거는 경로가
 * 남아 있으면, 그 행은 "종단" 이라 부르면서 실제로는 다시 평가를 받는다.
 */
export const TERMINAL_OUTBOUND_MESSAGE_STATUSES = [
  'sent',
  'failed',
  'denied',
] as const satisfies readonly OutboundMessageStatus[];

/**
 * 테이블: `messages.status` 전체.
 * `'received'` 는 `direction = 'inbound'` 전용 종단 상태다 — P1a 에 inbound 경로는
 * 없지만 `direction` 컬럼을 가진 채 표현 불가능한 행을 남기지 않기 위해 지금 정의한다(P3 사용).
 */
export type MessageStatus = OutboundMessageStatus | 'received';

/**
 * 테이블: `messages.sender_trust`. **폐기(202609230020)** — 격자와 값이 다른 P1a 열거형이고 항상 `'unknown'`
 * 이다(CHECK `messages_sender_trust_deprecated`). 수신 신뢰는 `InboundSenderTrust`(`inbound_messages.sender_trust`).
 */
export type SenderTrust = 'unknown' | 'untrusted' | 'known' | 'trusted';

/**
 * 테이블: `inbound_messages.sender_trust` (DB 타입 `sender_trust_category`). `src/security/sender-trust.ts` 의
 * `SenderTrustCategory` 와 같은 집합이다 — 소비자(`inbound-consumer`)가 그 값을 이 자리에 넘기므로 한쪽에만
 * 값이 늘면 typecheck 가 깨진다.
 */
export type InboundSenderTrust = 'blocked' | 'unknown' | 'seen' | 'seed' | 'approved';

/** 테이블: `messages.injection_risk`·`inbound_messages.injection_risk`. P4 의 injection 스캐너가 채운다. */
export type InjectionRisk = 'none' | 'low' | 'medium' | 'high';

/** 테이블: `audit_logs.decision`. Stage 8 의 `verdict` 와 같은 집합이다 (§4.2). */
export type AuditDecision = 'allowed' | 'denied' | 'pending_approval';

/** 테이블: `suppression_entries.source`. */
export type SuppressionSource = 'bounce' | 'complaint' | 'manual' | 'ses_account_level';

// ---------------------------------------------------------------------------
// 예약 발송 취소 (메일 기본기 1차 A3 — `.omc/plans/mail-basics.md` §4 A3, 마이그레이션 202609260100·0105)
// ---------------------------------------------------------------------------

/**
 * 테이블: `scheduled_sends.status`(enum `scheduled_send_status` — 202609230310, `cancelled` 는 202609260100).
 * `dispatched`·`cancelled` 는 종단이다 — 워커는 `scheduled` 만 집고, `cancelled → scheduled` 는 DB 가드가 거부한다.
 */
export type ScheduledSendStatus = 'scheduled' | 'dispatched' | 'cancelled';

export const SCHEDULED_SEND_STATUSES = ['scheduled', 'dispatched', 'cancelled'] as const satisfies readonly ScheduledSendStatus[];

/** `scheduled_sends.cancel_reason_code` — 취소 사유(취소 본문의 필수 `reason_code`). DB CHECK 와 같은 값이다. */
export type CancelReasonCode =
  | 'no_longer_needed'
  | 'wrong_recipient'
  | 'wrong_content'
  | 'wrong_time'
  | 'duplicate'
  | 'owner_request'
  | 'other';

export const CANCEL_REASON_CODES = [
  'no_longer_needed',
  'wrong_recipient',
  'wrong_content',
  'wrong_time',
  'duplicate',
  'owner_request',
  'other',
] as const satisfies readonly CancelReasonCode[];

/**
 * `scheduled_sends.cancelled_via` — 취소가 들어온 경로. **라우터가 리터럴로 정한다**(HTTP 표 = `'http'`, `mcpDependenciesOf` = `'mcp'`).
 * 헤더로 받지 않는 것이 요점이다 — HTTP 클라이언트가 위조할 수 있다. 누가(어느 토큰) 취소했는지는 기록하지 않는다(`AgentPrincipal` 에 토큰 id 가 없다).
 */
export type ScheduledCancelChannel = 'http' | 'mcp';

export const SCHEDULED_CANCEL_CHANNELS = ['http', 'mcp'] as const satisfies readonly ScheduledCancelChannel[];

/**
 * 행의 `cancelled_via` 가 가질 수 있는 값 전부 — 에이전트 경로 둘 + 소유자 콘솔(`console`, 202609260125 의 정의자 함수가 리터럴로 적는다).
 * DB CHECK `scheduled_sends_cancelled_via_check` 와 같은 집합이다. 에이전트 시간당 상한은 `SCHEDULED_CANCEL_CHANNELS` 만 센다.
 */
export type ScheduledCancelledVia = ScheduledCancelChannel | 'console';

export const SCHEDULED_CANCELLED_VIA = ['http', 'mcp', 'console'] as const satisfies readonly ScheduledCancelledVia[];

/** `scheduled_sends.cancel_note` 상한(글자) — DB CHECK(길이 ≤ 200 · 제어문자 없음)와 같다. */
export const MAX_CANCEL_NOTE_LENGTH = 200;

/**
 * 에이전트 취소 하드 상한 — 에이전트 토큰으로 들어온 취소(`cancelled_via IN ('http','mcp')`)가 에이전트당 최근 1시간 이 수 **이상**이면
 * 429 `cancel_rate_limited`(새 표 없이 부분 인덱스 `scheduled_sends_agent_cancel_idx` 로 센다). 경로를 가리지 않는다 — 주입 메일이
 * 취소를 유도하는 위험(계획 R5)은 도구가 MCP 든 HTTP 든 같다(1차 수정 리드 결정, 보안 M1). 우회는 소유자 콘솔 취소(상한 없음)뿐이다.
 * 에이전트별 알람 `atmark-scheduled-cancels-agent-hourly` 는 이 상한이 아니라 **거부된 시도**를 센다(임계 3/시간 — observability-stack).
 */
export const AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT = 5;

/**
 * `webhook_endpoints.event_types`(enum `webhook_event_type` 배열, 202609260115 — 메일 기본기 1차 A4). **`NULL` 은 옛 4종**
 * (`LEGACY_EVENT_TYPES`)이다 — 새 세 종(`message.delivered`·`bounced`·`complained`)은 엔드포인트별 opt-in 이라 기존 수신측은 그대로다.
 */
export type WebhookEndpointEventTypes = readonly WebhookEventType[] | null;

/**
 * 테이블: `agent_api_keys.capabilities` (Postgres ENUM `agent_token_capability`).
 *
 * **`src/identity/agent-token.ts` 의 `AgentTokenCapability` 와 같은 집합이어야 한다.**
 * 여기서 한 번 더 정의하는 이유는 방향 때문이다 — `identity` 가 `db/schema` 를
 * import 하므로 그 반대 방향 import 는 순환이 되고, `no-circular` 가 error 다.
 * 두 유니온이 갈라지지 않는다는 사실은 `src/db/repositories/agent-token-store.ts` 가
 * **컴파일 타임 양방향 대입**으로 단언한다 — 주석이 아니라 타입이 지킨다.
 */
export type AgentTokenCapability =
  | 'messages:send'
  | 'messages:read'
  | 'audit:read'
  | 'agent:read_self'
  | 'webhooks:manage'
  /** 자가 등록(202610081100). */
  | 'agents:enroll'
  /** 정책 변경 요청(202610131200). */
  | 'policy:request';

export const AGENT_TOKEN_CAPABILITY_VALUES = [
  'messages:send',
  'messages:read',
  'audit:read',
  'agent:read_self',
  // 202609301400 — 웹훅 관리(등록·삭제·시크릿 회전·재전송).
  'webhooks:manage',
  // 202610081100 — 자가 등록(안전 기본값의 형제 에이전트 하나 — ADR-0016 2026-10-08).
  'agents:enroll',
  // 202610131200 — 정책 변경 **요청**(바꾸지 않는다 — 소유자가 콘솔에서 승인한다, ADR-0007 2026-10-13).
  'policy:request',
] as const satisfies readonly AgentTokenCapability[];

// ---------------------------------------------------------------------------
// 행 타입
// ---------------------------------------------------------------------------

/** jsonb 컬럼. 구조는 각 소비자(정책 로더)가 파싱 시점에 좁힌다. */
export type JsonObject = Record<string, unknown>;

/** 테이블: `organizations` */
export interface OrganizationRow {
  id: string;
  name: string;
  ses_tenant_id: string | null;
  billing_status: BillingStatus;
  /** Stage 0 — abuse 알람(§5.4)·운영자 CLI 가 켜는 조직 단위 **플랫폼** 동결. 소유자(콘솔)는 바꾸지 못한다. */
  abuse_freeze: boolean;
  /** Stage 0 — 소유자가 콘솔에서 켜고 끄는 조직 정지(`202609230710_owner_pause.sql`). `abuse_freeze` 와 별개. */
  owner_paused: boolean;
  /** Stage 0 — 운영자 검토 상태(`202609240800_self_signup.sql`). `active` 가 아니면 발송 거부. 소유자 롤(CLI)만 바꾼다. */
  review_status: OrganizationReviewStatus;
  /** 워밍업 램프 기준일. 최초 SES 발송 성공 시점에 null 일 때만 1회 세팅 (§3.3 M7). */
  sending_started_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * 테이블: `org_entitlements`(202609250300, ADR-0011) — 조직 하나의 요금제 한도. **행이 없으면 Free**(`src/billing/plans.ts`
 * `resolveEntitlements`). 앱·admin 롤은 읽기만 하고, 쓰기는 소유자 롤(운영자 CLI `pnpm admin:plan`)과 WP-2 의 billing 롤뿐이다.
 */
export interface OrgEntitlementsRow {
  organization_id: string;
  plan_code: string;
  source: string;
  cause: string;
  max_agents: number;
  org_daily_recipients: number;
  agent_per_day_max: number;
  agent_per_minute_max: number;
  recipients_per_message_max: number;
  tokens_per_agent_max: number;
  webhook_endpoints_per_agent_max: number;
  org_api_keys_max: number;
  /** `bigint` — node-postgres 는 문자열로 준다. */
  inbound_storage_bytes: string;
  /**
   * 메일 기본기 2차(202609270105, ADR-0013 D6) — 에이전트당 활성 별칭 · 메일당 첨부 총량(바이트). 칸을 NULL 허용으로 더한 뒤 백필(0120)해
   * NOT NULL 로 조인다 — 그 사이와 칸이 없는 옛 스키마에서는 null(해석 = 그 요금제의 카탈로그 값, `resolveEntitlements`).
   */
  aliases_per_agent_max: number | null;
  attachment_bytes_total_max: number | null;
  grace_until: Date | null;
  version: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * `org_entitlements` 를 **쓰는 쪽**이 보는 행 — 제어 칸 `provider_override_allowed`(202609250400, WP-2)를 더한다.
 *
 * `OrgEntitlementsRow` 에 넣지 않는 이유: 그 타입은 정책 로더·콘솔의 **읽기** 모양이고(`repositories/entitlements.ts`
 * `ORG_ENTITLEMENTS_COLUMNS`), 그 SELECT 는 마이그레이션 전에도 돌아야 한다 — 없는 칸을 읽으면 `42703` 으로 모든 발송이 깨진다. 이 칸은
 * 한도가 아니라 "공급자가 이 운영자·백필 행을 덮어도 되는가"(D-3 · `admin:plan --release-to-provider`)라서 해석(`resolveEntitlements`)·
 * 투명성 잎·스냅샷에 들어가지 않는다. 읽는 곳은 `writeEntitlementVersion`(CLI·sync 공용)과 sync 결정 함수뿐이다.
 */
export interface OrgEntitlementsControlRow extends OrgEntitlementsRow {
  /** 기본 false. operator 출처 행에서만 true 가 될 수 있다(트리거 `org_entitlements_source_by_role`). */
  provider_override_allowed: boolean;
}

/** 테이블: `agents` */
export interface AgentRow {
  /** = agentId. 별도 내부 PK 없음 (§4B.1). DB 트리거가 UPDATE 를 거부한다. */
  id: AgentId;
  organization_id: string;
  name: string;
  status: AgentStatus;
  plan: string;
  /** Stage 5 예산. 센트 단위 정수 — 부동소수 통화는 감사 불가능한 차이를 만든다. */
  monthly_budget_cents: number;
  created_at: Date;
  updated_at: Date;
}

/** 테이블: `agent_addresses`. Stage 1(identity binding, AC-1)의 판정 대상. */
export interface AgentAddressRow {
  id: string;
  agent_id: AgentId;
  /** 소문자 정규화. 주소는 전역 유니크 — 두 에이전트가 같은 from 을 주장할 수 없다. */
  address: string;
  domain: string;
  is_primary: boolean;
  created_at: Date;
}

/** 테이블: `agent_policies`. agent 당 정확히 1행(agent_id 가 PK). */
export interface AgentPolicyRow {
  agent_id: AgentId;
  outbound_mode: OutboundMode;
  /** 정책 v2(202609241010). 판정 근거는 스냅샷 쪽(`PolicyVersionRow.inbound_mode`)이다 — 발신 모드와 같은 규율. */
  inbound_mode: InboundMode;
  require_approval: boolean;
  /** Stage 4 의 분/시/일 한도와 수신자 수 상한. `warmup_daily_cap` 은 여기 없다 — 코드 상수다(§3.3). */
  limits: JsonObject;
  /**
   * 콘텐츠 가드·pre-approval(레거시) 설정. **목록은 여기 없다** — 정책 v2 부터 `agent_contact_rules` 다(202609241010 이
   * `allowlist`·`blocklist` 키를 옮기고 지웠다).
   */
  config_json: JsonObject;
  /** 현재 적용 중인 `policy_versions.version`. 모든 Decision 에 스탬프된다. */
  current_version: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * 테이블: `policy_versions`. **불변 append-only** — UPDATE/DELETE 를 DB 트리거가 거부한다(§4.3, R8).
 * 정책 변경은 새 행 생성이다. audit 이 참조하는 근거가 사후에 바뀌면 AC-9 가 답할 수 없다.
 */
export interface PolicyVersionRow {
  id: string;
  agent_id: AgentId;
  version: number;
  outbound_mode: OutboundMode;
  inbound_mode: InboundMode;
  /**
   * 평가 시점 정책 전문 스냅샷 — `outbound_mode`·`inbound_mode`·`limits`·`config_json`·`contact_rules`(정책 v2: 그 버전의 목록 전문,
   * `[{id, direction, list, kind, value}]` 방향·목록·값 순). 모양은 `src/admin/ops/policy.ts` `policySnapshotOf` 와 202609241010 이 같다.
   */
  snapshot: JsonObject;
  created_by: string | null;
  created_at: Date;
}

/**
 * 테이블: `messages`.
 *
 * raw email 본문은 여기 없다 — 본문·원문은 `body_storage_key` / `raw_storage_key`(S3)
 * 로만 참조된다(PRD 제약, §10 · §5.2 V5 컬럼 화이트리스트).
 */
export interface MessageRow {
  id: string;
  agent_id: AgentId;
  /** Thread 테이블은 P3 범위. P1a 에는 FK 가 없다. */
  thread_id: string | null;
  direction: MessageDirection;
  /** inbound 의 from 은 제3자 PII 다. sha256 hex 64자. 도메인만 평문으로 남는다(§5.4). */
  from_address_hash: string;
  from_domain: string;
  subject: string | null;
  /** 512자 상한. 상한이 없으면 snippet 이 사실상 본문 컬럼으로 자라 PRD 제약을 우회한다. */
  snippet: string | null;
  /**
   * 발신 DLP 계열(202610041000, ADR-0016 B — `src/security/dlp/scan.ts` `DlpFamily` 닫힌 다섯 값). **값·위치가 없다** — 계열 이름뿐.
   * NULL = 그 마이그레이션 전의 행(또는 수신 행).
   */
  outbound_dlp: string[] | null;
  body_storage_key: string | null;
  raw_storage_key: string | null;
  sender_trust: SenderTrust;
  injection_risk: InjectionRisk;
  status: MessageStatus;
  /** 전송 *전에* 생성·저장한다 (§4.5 4번). 재시도가 같은 Message-ID 로 나가야 수신측이 병합한다. */
  message_id_header: string;
  /**
   * `(agent_id, idempotency_key)` 유니크 — 중복 발송 방어의 뿌리 (§4.5 1번).
   * `direction = 'outbound'` 행에서는 DB CHECK 가 NOT NULL 을 강제한다
   * (`messages_outbound_requires_idempotency`) — 아래 `OutboundMessageRow` 가 그 사실이다.
   */
  idempotency_key: string | null;
  /**
   * 정규화된 요청의 sha256 hex 64자. 같은 멱등 키의 재호출이 *같은 요청*이었는지를
   * 나중에 물을 수 있게 하는 유일한 흔적 — 수신자 집합은 이 테이블에 컬럼이 없다.
   * 불일치 시 409 판정은 P1b API 층의 일이고, P1a 는 저장만 한다.
   */
  request_hash: string | null;
  /**
   * 이 발송의 **수신자 수**(주소가 아니라 기수). P1b 마이그레이션
   * `202609221440_message_recipient_count.sql` 이 추가한다.
   *
   * 왜 필요한가: `SendCounters.orgRecipientsLastDay` 의 눈금이 수신자 수이고
   * (`rules/limits.ts` 워밍업 캡, R22), P1a 의 messages 에는 수신자에 관한 컬럼이
   * 하나도 없었다 — 수신자·본문은 S3 에만 있다. 그 상태에서 카운터를 Postgres 로
   * 구하려면 메시지 수를 쓰는 수밖에 없고, 그러면 캡이 최대 50배 느슨해진다.
   * **개수는 PII 가 아니므로** §5.2 V5 화이트리스트의 취지와 충돌하지 않는다.
   */
  recipient_count: number;
  /** lease 3종. `gate.dispatch` 가 조건부 UPDATE 로 취득한 뒤에만 transport 를 호출한다(§4.5 3번). */
  lease_id: string | null;
  lease_expires_at: Date | null;
  attempt: number;
  ses_message_id: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
  sent_at: Date | null;
  failed_at: Date | null;
}

/** `direction = 'outbound'` 인 `messages` 행. 발송 상태기계만 취한다. */
export interface OutboundMessageRow extends MessageRow {
  direction: 'outbound';
  status: OutboundMessageStatus;
  /** DB CHECK `messages_outbound_requires_idempotency` 가 강제한다 — 발송 행에 키 없는 상태는 없다. */
  idempotency_key: string;
  request_hash: string;
}

/**
 * 테이블: `audit_logs`.
 *
 * 규약 (§4.3 r3-V2): **발송 시도당 정확히 1행. 릴리스는 새 행을 만들지 않고 같은 행을
 * 갱신한다.** 배치 승인 20건은 audit 20행이고 각 행이 동일 `approval_id` 를 공유한다 —
 * 승인은 사람의 단위이고 audit 는 발송의 단위다. `count(audit_logs) === 발송 시도 수`
 * 가 §5.4 의 완결성 단언이다.
 */
export interface AuditLogRow {
  id: string;
  agent_id: AgentId;
  /** Stage 0~1 거부는 messages 행이 생기기 전에 끝난다 — 그래도 audit 에는 남는다. */
  message_id: string | null;
  decision: AuditDecision;
  /** 평가 시점 근거. DB 트리거가 UPDATE 를 거부한다. */
  reasons: readonly string[];
  /**
   * 평가 시점 정책 스냅샷. 승인 중 정책이 바뀌어도 이 값은 유지된다(§4.3).
   *
   * `null` 이 되는 경우는 하나뿐이다 — PolicySource 가 정책을 읽지 못해 스탬프할 버전이
   * 애초에 존재하지 않는 시도. 그 경우에도 audit 행은 **남아야 한다**("조용한 거부도
   * 없다", Principle P3). DB CHECK `audit_logs_policy_stamp_presence` 가 그 예외를
   * `decision='denied'` + `reasons ∋ 'evaluation_error'` 하나로 좁힌다.
   * 두 컬럼은 항상 함께 있거나 함께 없다.
   */
  policy_version_id: string | null;
  policy_version: number | null;
  evaluated_at: Date;
  latency_ms: number | null;
  trace_id: string | null;
  /**
   * `approval_requests.id` (P2 에서 FK). `pending_approval` 행은 **INSERT 시점에** 이 값을 갖는다 —
   * 갱신 불가 컬럼이므로 나중에 붙일 수 없다. 배치 승인에서 여러 행이 공유하므로 유니크가 아니다.
   */
  approval_id: string | null;
  resolved_at: Date | null;
  approved_by: string | null;
  /**
   * 해소 시점 사유(`approval_rejected` / `approval_expired`).
   * `reasons[]` 와 분리한 이유: §4.3 은 거절·만료 시 같은 행에 사유를 기록하라고 하면서
   * 동시에 `reasons[]` 의 UPDATE 를 거부하라고 한다. 두 요구를 다 지키는 유일한 방법이다.
   */
  resolution_reason: string | null;
  /**
   * `reply_only` 의 bootstrap_grace 잔여 카운트 — **이 시도가 나가면 남는 수**(§3.1 층 3, AC-a4).
   * grace 가 판정에 관여하지 않은 행은 `null`. 갱신 불가(allow-list 트리거).
   */
  bootstrap_grace_remaining: number | null;
  created_at: Date;
}

/** 테이블: `approval_requests.status` (§3.4 4조). **발송 상태가 없다** — 그건 messages 의 일이다. */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
] as const satisfies readonly ApprovalStatus[];

/** 테이블: `approval_requests.subject`. 배치는 §3.2 전환 공지(AC-b1)다. */
export type ApprovalSubject = 'message' | 'batch';

/** 테이블: `sender_relationships.scope` (§3.4 2조). `domain` 은 소유자 확인이 필요하다(AC-d5). */
export type RelationshipScope = 'recipient' | 'thread' | 'domain';

/**
 * 테이블: `approval_requests.granted_scope`. 관계 범위 셋 + **`once`**(202610041000, ADR-0016) — 위험 보류의 승인은 그 메일 한 통만 내보내고
 * standing approval 을 만들지 않는다(DB 트리거 `approval_requests_risk_hold_once` · `sender_relationships_reject_once_grant`).
 */
export type GrantedScope = RelationshipScope | 'once';

/** 테이블: `sender_relationships.trust_category`. `inbound_established` 는 P3 가 더한다. */
export type TrustCategory = 'seed' | 'approved';

/**
 * 테이블: `approval_requests`. **사람의 단위**다(§4.3 — "승인은 사람의 단위이고 audit 는 발송의 단위").
 * 상태 전이는 `WHERE status='pending'` 조건부 UPDATE 로만, 종단 상태는 트리거가 동결한다(AC-i4).
 */
export interface ApprovalRequestRow {
  id: string;
  agent_id: AgentId;
  subject: ApprovalSubject;
  status: ApprovalStatus;
  created_at: Date;
  /** TTL 을 넘긴 요청은 **승인될 수 없다** — DB CHECK `approval_requests_approve_before_expiry`. */
  expires_at: Date;
  decided_at: Date | null;
  /** 만료에는 결정자가 없다. 사람의 결정처럼 적으면 audit 가 거짓말을 한다. */
  decided_by: string | null;
  granted_scope: GrantedScope | null;
}

/**
 * 테이블: `approval_request_items`. 요청 1건이 덮는 발송 시도 — 릴리스가 관문을 재통과할 봉투.
 * 수정·삭제 불가(사람이 본 봉투다).
 */
export interface ApprovalRequestItemRow {
  approval_id: string;
  message_id: string;
  audit_id: string;
  /** 호출자가 넘긴 **원본** 주소(+tag 보존). 판정용 정규화는 로더가 매번 다시 한다. */
  from_address: string;
  recipients: readonly string[];
  is_thread_reply: boolean;
  thread_id: string | null;
  cost_cents: number;
  created_at: Date;
}

/** 테이블: `sender_relationships`. standing approval + seed contacts. */
export interface SenderRelationshipRow {
  id: string;
  agent_id: AgentId;
  scope: RelationshipScope;
  /** `recipient`·`thread` 스코프의 키. 로더의 `normalizeAddress` 결과와 같은 모양이다. */
  address: string | null;
  /** `domain` 스코프의 키. */
  domain: string | null;
  thread_id: string | null;
  trust_category: TrustCategory;
  granted_via_approval_id: string | null;
  granted_by: string;
  /** `domain` 스코프에서만 값이 있고, 그때는 **반드시** 있다(DB CHECK, AC-d5). */
  domain_scope_confirmed_by: string | null;
  created_at: Date;
}

/**
 * 테이블: `agent_api_keys`. agent-scoped 토큰 (§47, `src/identity/agent-token.ts`).
 *
 * **평문 컬럼이 없다는 것이 이 타입의 요점이다.** 있으면 언젠가 채워진다.
 * 폐기는 `revoked_at` 을 찍는 것이고 행 삭제가 아니다 — DB 트리거가 DELETE 를 거부한다.
 * audit 가 "어느 토큰이 이 메일을 보냈는가"(AC-9)에 답해야 하기 때문이다.
 */
export interface AgentApiKeyRow {
  id: string;
  agent_id: AgentId;
  /** sha256 hex 64자. 평문은 발급 응답에서 1회 반환된 뒤 어디에도 남지 않는다. */
  token_hash: string;
  /** 비어 있을 수 없다 — DB CHECK `cardinality(capabilities) > 0`. */
  capabilities: readonly AgentTokenCapability[];
  revoked_at: Date | null;
  /** `null` 은 무기한. P1b 의 데모 토큰이 그렇다. */
  expires_at: Date | null;
  last_used_at: Date | null;
  /** 처음 쓰인 분(202609301530) — `last_used_at` 이 NULL 에서 값이 될 때 DB 트리거가 한 번 적는다. 직접 쓰지 않는다(불변 트리거). 옛 토큰은 `null`. */
  first_used_at: Date | null;
  created_at: Date;
  /** 소유자가 붙인 이름(1–60자, 202609250010). 옛 행은 `null`("이름 없음"). 바꿀 수 있다(이름 바꾸기). */
  label: string | null;
  /** 평문의 끝 4자(202609250010). 옛 행은 `null`(복구 불가). INSERT 뒤 불변. */
  hint: string | null;
}

/** `agent_api_keys` 에서 UPDATE 가 허용되는 유일한 컬럼들. 나머지는 DB 트리거가 거부한다. */
export const AGENT_API_KEY_MUTABLE_COLUMNS = [
  'revoked_at',
  'last_used_at',
  'label',
] as const satisfies readonly (keyof AgentApiKeyRow)[];

/** 테이블: `suppression_entries`. Stage 2 가 읽고 `ses-event-consumer` 가 쓴다. */
export interface SuppressionEntryRow {
  id: string;
  /** 조직 스코프. 에이전트 스코프면 같은 조직의 다른 에이전트가 바운스 주소로 다시 보낸다. */
  organization_id: string;
  address: string;
  domain: string;
  source: SuppressionSource;
  reason: string | null;
  /** soft bounce 는 영구가 아니다. 만료가 없으면 목록이 단조 증가해 정상 수신자를 영구 차단한다. */
  expires_at: Date | null;
  created_at: Date;
}

/**
 * 테이블: `agent_keypairs` (PP-A, 계획 §4B.1).
 *
 * **에이전트당 정확히 1행이고 절대 바뀌지 않는다.** `agent_id` 가 PK 인 것이 "두 번째
 * 키" 경로를 닫고, DB 트리거가 UPDATE·DELETE·TRUNCATE 를 거부한다.
 *
 * **개인키 필드가 없는 것이 이 인터페이스의 요점이다.** 평문 개인키는 서명 프로세스
 * 메모리에만 존재하고, DB 에는 Secrets Manager 참조(`key_ref`)만 남는다(§3.5 AC-e1).
 */
export interface AgentKeypairRow {
  agent_id: AgentId;
  /** ed25519 공개키 원시 32바이트의 base64url(패딩 없음) = JWK 의 `x` 값 그대로. */
  public_key: string;
  algorithm: KeypairAlgorithm;
  /** `awssm://<secret-arn>` 또는 `devfile://<agentId>`. **암호문도 개인키도 아니다.** */
  key_ref: string;
  created_at: Date;
}

/**
 * 테이블: `passports` (PP-A, 계획 §4B.1 · §4B.1b).
 *
 * 스펙의 온체인 레코드 5필드에 대응하는 컬럼을 **지금** 들고 있다. 나중에 넣으면 이미
 * 발급된 문서에 값이 없고, 특히 해시는 사후 재계산이 불가능하다.
 */
export interface PassportRow {
  id: string;
  agent_id: AgentId;
  /**
   * `did:web:id.atmark.ai:agents:{agentId}`. 경로 스킴은 **영구 동결**(ADR-0002).
   *
   * **B5 — `status !== 'published'` 인 passport 의 이 값은 어떤 외부 표면에도
   * 직렬화하지 않는다.** PP-A 가 만드는 것은 전부 `draft` 이고 그 DID 는 P6 까지
   * 404 다. 그 사이 문자열이 API 응답·웹훅·로그로 새면 **해석되지 않는 DID 가 외부로
   * 나간다** — 계획 자신의 논리대로 그건 DID 가 없는 것보다 나쁘다.
   * 읽는 경로는 `src/passport/did.ts` 의 `externalDidOf` 하나다.
   */
  did: string;
  status: PassportStatus;
  /** Phase 1 = Atmark 조직 DID. 고객 이양은 Phase 2 (§3.5). */
  controller: string;
  /** = passport_url. P6 게시 시점에 1회 채워진다(쓰기 1회, 트리거가 덮어쓰기를 거부). */
  metadata_uri: string | null;
  /** RFC 8785 JCS 정규 직렬화 후 SHA-256, 소문자 hex 64자. 규칙은 P1c 에서 동결됐다. */
  content_hash: string | null;
  /** 1부터. 재서명은 행 갱신이 아니라 **새 버전 행 생성**이다 (§4B.1b). */
  version: number;
  issued_at: Date;
  superseded_at: Date | null;
}

// ---------------------------------------------------------------------------
// 스키마 불변식 상수 — arch/integration 테스트가 읽는다
// ---------------------------------------------------------------------------

/**
 * §5.2 V5 — `messages` 의 컬럼 집합은 이 화이트리스트의 부분집합이어야 한다.
 * 검증이 "크기 상한"이 아니라 화이트리스트인 이유: 40KB 평문 본문은 크기 검사를
 * 통과하면서 PRD 제약(raw email 을 Postgres 에 저장 금지)을 위반한다.
 */
export const MESSAGES_COLUMN_WHITELIST = [
  'id',
  'agent_id',
  'thread_id',
  'direction',
  'from_address_hash',
  'from_domain',
  'subject',
  'snippet',
  'outbound_dlp',
  'body_storage_key',
  'raw_storage_key',
  'sender_trust',
  'injection_risk',
  'status',
  'message_id_header',
  'idempotency_key',
  'request_hash',
  'recipient_count',
  'lease_id',
  'lease_expires_at',
  'attempt',
  'ses_message_id',
  'failure_reason',
  'created_at',
  'updated_at',
  'sent_at',
  'failed_at',
] as const satisfies readonly (keyof MessageRow)[];

/** `messages.snippet` 상한 (§5.2 V5 별도 단언). */
export const SNIPPET_MAX_LENGTH = 512;

/** §4.3 — `audit_logs` 에서 UPDATE 가 허용되는 유일한 컬럼들. 나머지는 DB 트리거가 거부한다. */
export const AUDIT_LOG_MUTABLE_COLUMNS = [
  'decision',
  'resolved_at',
  'approved_by',
  'resolution_reason',
] as const satisfies readonly (keyof AuditLogRow)[];

/** P1a 가 생성하는 8개 테이블. 마이그레이션과 테스트가 같은 목록을 본다. */
export const P1A_TABLES = [
  'organizations',
  'agents',
  'agent_addresses',
  'agent_policies',
  'policy_versions',
  'messages',
  'audit_logs',
  'suppression_entries',
] as const;

/** §3.4 — `approval_requests` 에서 UPDATE 가 허용되는 유일한 컬럼들. 나머지는 DB 트리거가 거부한다. */
export const APPROVAL_REQUEST_MUTABLE_COLUMNS = [
  'status',
  'decided_at',
  'decided_by',
  'granted_scope',
] as const satisfies readonly (keyof ApprovalRequestRow)[];

/** P1c PP-A 가 생성하는 2개 테이블 (`202609221600_agent_keypairs_and_passports.sql`). */
export const PP_A_TABLES = ['agent_keypairs', 'passports'] as const;

/**
 * §3.5 AC-e1 — `agent_keypairs` 의 컬럼 집합은 **정확히** 이것이다.
 *
 * 부분집합이 아니라 **동일**을 단언하는 이유: 여기서 잡으려는 사고는 "컬럼이 빠지는 것"이
 * 아니라 **개인키 자료를 담는 컬럼이 늘어나는 것**이다(`private_key`·`ciphertext`·
 * `encrypted_key` …). 부분집합 단언은 그 사고를 통과시킨다.
 */
export const AGENT_KEYPAIR_COLUMNS = [
  'agent_id',
  'public_key',
  'algorithm',
  'key_ref',
  'created_at',
] as const satisfies readonly (keyof AgentKeypairRow)[];

/**
 * §4B.1b — `passports` 에서 UPDATE 가 허용되는 유일한 컬럼들. 나머지는 DB 트리거가
 * 거부한다(allow-list 이므로 P6 이 추가하는 컬럼의 기본도 불변이다).
 */
export const PASSPORT_MUTABLE_COLUMNS = [
  'status',
  'metadata_uri',
  'content_hash',
  'superseded_at',
] as const satisfies readonly (keyof PassportRow)[];

// ---------------------------------------------------------------------------
// P3a — 스레드 · 수신 메일 (`202609222400_*`, `202609222410_*`)
// ---------------------------------------------------------------------------

/** DB ENUM `thread_starter`. */
export type ThreadStarter = 'agent' | 'external';

/**
 * 테이블: `threads`. 스레드 소속은 **권한 판단의 입력**이다(`src/mail/thread/resolve.ts`).
 * `last_message_at` 외의 컬럼은 DB 트리거가 UPDATE 를 거부한다.
 */
export interface ThreadRow {
  id: string;
  agent_id: AgentId;
  started_by: ThreadStarter;
  /** 새 행은 항상 채운다. `NULL` 은 P3a 이전 발송 행의 백필 스레드뿐이다(평문 주소가 없었다). */
  starter_address: string | null;
  /** **표시용.** 권한 판정은 읽지 않는다. */
  subject_normalized: string | null;
  created_at: Date;
  last_message_at: Date;
}

/** 테이블: `outbound_recipients` — 보낸 메일의 수신자 전원. append-only. */
export interface OutboundRecipientRow {
  message_id: string;
  /** 소문자. */
  address: string;
  created_at: Date;
}

/** DB ENUM `ses_verdict` — SES receipt 판정의 소문자형. `unknown` 은 통과가 아니다. */
export type SesVerdict = 'pass' | 'fail' | 'gray' | 'processing_failed' | 'disabled' | 'unknown';

/**
 * 테이블: `inbound_messages` — 수신 메일 **메타**. 원문·본문은 S3 키로만(PRD).
 * `display_thread_id` 외의 컬럼은 DB 트리거가 UPDATE 를 거부한다.
 */
export interface InboundMessageRow {
  id: string;
  agent_id: AgentId;
  envelope_recipient: string;
  ses_message_id: string;
  /** **권한용.** */
  thread_id: string;
  /** **표시용 — 정책은 절대 읽지 않는다.** */
  display_thread_id: string | null;
  matched_by: 'message_id_header' | 'ses_message_id' | null;
  matched_message_id: string | null;
  matched_direction: MessageDirection | null;
  new_thread_reason: string | null;
  message_id_header: string | null;
  in_reply_to: string | null;
  from_address: string;
  from_domain: string;
  /** DMARC 통과만이 `true` 다 — DB CHECK `inbound_messages_authentication_is_dmarc`. */
  from_authenticated: boolean;
  subject: string | null;
  header_date: Date | null;
  auto_submitted: boolean;
  /** GATE B2③ 원자료 — SES `mail.source`(Return-Path). 정규화하지 않은 값. */
  envelope_sender: string | null;
  forwarded_for_header: string | null;
  forwarded_to_header: string | null;
  spf_verdict: SesVerdict;
  dkim_verdict: SesVerdict;
  dmarc_verdict: SesVerdict;
  spam_verdict: SesVerdict;
  virus_verdict: SesVerdict;
  headers_truncated: boolean;
  raw_storage_key: string;
  parsed_storage_key: string;
  text_source: 'plain' | 'html' | 'none';
  has_html_text: boolean;
  attachment_count: number;
  received_at: Date;
  created_at: Date;
  // ---- P4 (202609230010 · 202609230020). 셋 다 NULL 이면 P4 이전 행 ----
  /** 판정을 시도한 스캐너. 이후의 INSERT 는 필수(트리거). */
  scanner_version: string | null;
  /** **NULL = 판정 없음**(스캐너 예외 또는 P4 이전). `'none'` 으로 읽지 마라. */
  injection_risk: InjectionRisk | null;
  /** 판정 없음 ⇒ `true` (CHECK `inbound_messages_unscanned_is_quarantined`). */
  quarantined: boolean;
  /** **수신 시점의** Sender Trust. */
  sender_trust: InboundSenderTrust | null;
  sender_trust_decided_by: string | null;
  // ---- 정책 v2 (202609241010). v2 이전 행은 둘 다 NULL ----
  /** 격리 사유. 보이는 메일은 NULL. */
  quarantine_reason: InboundQuarantineReason | null;
  /** 수신 정책 판정 사유 — 정책 격리일 때만. */
  policy_reason: InboundPolicyReason | null;
  /** AI 의심 메일 감시(202610061100, ADR-0017 초안) — 작업 연결(`ai_watch_jobs`)과 에이전트에게 보이는 시각의 보류(최대 30초). 원문 아님. */
  ai_watch_job_id: string | null;
  ai_hold_until: Date | null;
  // ---- 받기 등급 (202610081000, ADR-0016 2026-10-08) ----
  /** 수신 시점 등급. 옛 행은 NULL. 풀어도 바뀌지 않는다. */
  watch_level: InboundWatchLevel | null;
  /** 신뢰 발신자 우회가 적용됐다(DMARC 인증된 From 만 — CHECK). 스캐너 판정 · 적중은 그대로 남는다. */
  trusted_bypass: boolean;
  /** 소유자가 콘솔에서 풀어 준 시각 · 사용자 · 무엇에서 풀었나. 세 칸이 함께(CHECK). */
  released_at: Date | null;
  released_by: string | null;
  released_from: 'injection_risk' | 'risk_hold' | null;
}

/** 테이블: `inbound_attachments` — 첨부 메타. 바이트는 S3(`storage_key`). */
export interface InboundAttachmentRow {
  id: string;
  inbound_message_id: string;
  part_index: number;
  /** **표시 전용** — 경로 문자가 있을 수 있다. 키로 쓰지 않는다. */
  filename: string | null;
  content_type: string;
  disposition: 'attachment' | 'inline' | null;
  size_bytes: string;
  content_id: string | null;
  storage_key: string;
  sha256: string;
  created_at: Date;
}

/** 저장하지 않은 수신의 결말 코드. */
export type InboundRejectionReason =
  | 'unknown_recipient'
  | 'virus'
  | 'mime_rejected'
  | 'raw_too_large'
  /** DB 가 입력 때문에 거부했다(CHECK·데이터 예외 — 202609230500). */
  | 'unstorable'
  /** 수신 에이전트의 조직이 운영자 검토 전·거절(`review_status <> 'active'` — 202609240900, 보안 검증 M3). */
  | 'org_not_active'
  /**
   * `support@atmark.ai` 문의를 운영자에게 전달하지 않았다(US-009, ADR-0009 — 202609241500). 사유 코드는 `detail` 에
   * (`CONTACT_REJECTION_CODES` — `src/contact/intake.ts`): 스팸·바이러스 판정 PASS 아님 · DMARC fail · 루프 · 상한 · 크기 · MIME.
   */
  | 'contact_not_forwarded'
  /**
   * 수신자의 주소가 **고객 도메인**에 있고 그 도메인이 수신 가능한 상태가 아니다(ADR-0014 · 202609291120) — 같은 조직의 도메인이
   * suspended(ownership_lost·dkim_failed)·removed·없음. suspended(reputation·operator·plan_limit)는 받는다. **단계 0 에서는 아무도 쓰지 않는다**
   * (수신 소비자가 단계 3 에서 원문을 읽기 전에 거른다).
   */
  | 'domain_not_active';

/**
 * `inbound_rejections_reason_check` 의 값 전부 — `InboundRejectionReason` 과 같은 집합(`test/arch/tlog-kind-check.arch.test.ts` 가 최신
 * 마이그레이션의 CHECK 와 대조한다).
 */
export const INBOUND_REJECTION_REASONS = [
  'unknown_recipient',
  'virus',
  'mime_rejected',
  'raw_too_large',
  'unstorable',
  'org_not_active',
  'contact_not_forwarded',
  'domain_not_active',
] as const satisfies readonly InboundRejectionReason[];

/** 테이블: `inbound_rejections` — 내용 없이 결말만. */
export interface InboundRejectionRow {
  id: string;
  ses_message_id: string;
  reason: InboundRejectionReason;
  detail: string | null;
  envelope_recipients: string[];
  virus_verdict: SesVerdict;
  spam_verdict: SesVerdict;
  raw_storage_key: string;
  received_at: Date;
  created_at: Date;
}

/** P3a 가 생성하는 테이블. */
export const P3A_TABLES = [
  'threads',
  'outbound_recipients',
  'inbound_messages',
  'inbound_attachments',
  'inbound_rejections',
] as const;

/**
 * PRD "raw email 을 Postgres 에 저장하지 않는다" — P3a 테이블의 컬럼 집합은 **정확히** 이것이다.
 *
 * `messages` 는 부분집합(§5.2 V5)인데 여기는 **동일**이다: 잡으려는 사고가 "본문성 컬럼이 늘어나는 것"
 * 이고 부분집합 단언은 새 컬럼을 통과시킨다(`AGENT_KEYPAIR_COLUMNS` 와 같은 이유).
 * 컬럼을 늘리려면 여기를 고쳐야 하고, 그 diff 가 리뷰 대상이다.
 */
export const P3A_TABLE_COLUMNS = {
  threads: [
    'id',
    'agent_id',
    'started_by',
    'starter_address',
    'subject_normalized',
    'created_at',
    'last_message_at',
  ] as const satisfies readonly (keyof ThreadRow)[],
  outbound_recipients: ['message_id', 'address', 'created_at'] as const satisfies readonly (keyof OutboundRecipientRow)[],
  inbound_messages: [
    'id',
    'agent_id',
    'envelope_recipient',
    'ses_message_id',
    'thread_id',
    'display_thread_id',
    'matched_by',
    'matched_message_id',
    'matched_direction',
    'new_thread_reason',
    'message_id_header',
    'in_reply_to',
    'from_address',
    'from_domain',
    'from_authenticated',
    'subject',
    'header_date',
    'auto_submitted',
    'envelope_sender',
    'forwarded_for_header',
    'forwarded_to_header',
    'spf_verdict',
    'dkim_verdict',
    'dmarc_verdict',
    'spam_verdict',
    'virus_verdict',
    'headers_truncated',
    'raw_storage_key',
    'parsed_storage_key',
    'text_source',
    'has_html_text',
    'attachment_count',
    'received_at',
    'created_at',
    // P4 — 판정 메타(원문 아님).
    'scanner_version',
    'injection_risk',
    'quarantined',
    'sender_trust',
    'sender_trust_decided_by',
    // 정책 v2 — 격리 사유(판정 메타, 원문 아님).
    'quarantine_reason',
    'policy_reason',
    // AI 의심 메일 감시(202610061100, ADR-0017 초안) — 작업 id · 보류 시각(원문 아님 — 발췌문은 DB 어디에도 없다).
    'ai_watch_job_id',
    'ai_hold_until',
    // 받기 등급(202610081000) — 등급 · 우회 · 풀기(시각 · 사용자 id · 무엇에서). 본문성 칸 아님.
    'watch_level',
    'trusted_bypass',
    'released_at',
    'released_by',
    'released_from',
  ] as const satisfies readonly (keyof InboundMessageRow)[],
  inbound_attachments: [
    'id',
    'inbound_message_id',
    'part_index',
    'filename',
    'content_type',
    'disposition',
    'size_bytes',
    'content_id',
    'storage_key',
    'sha256',
    'created_at',
  ] as const satisfies readonly (keyof InboundAttachmentRow)[],
  inbound_rejections: [
    'id',
    'ses_message_id',
    'reason',
    'detail',
    'envelope_recipients',
    'virus_verdict',
    'spam_verdict',
    'raw_storage_key',
    'received_at',
    'created_at',
  ] as const satisfies readonly (keyof InboundRejectionRow)[],
} as const;

// ---------------------------------------------------------------------------
// P4 — injection 판정 좌표 · 소유자 수동 분류
// ---------------------------------------------------------------------------

/**
 * 테이블: `security_findings` — 룰 적중의 **좌표**. 매칭 원문은 없다(문자열 컬럼 전부 모양 CHECK).
 * `weight` 는 `numeric` 이라 pg 가 문자열로 돌려준다.
 */
export interface SecurityFindingRow {
  id: string;
  inbound_message_id: string;
  scanner_version: string;
  ordinal: number;
  rule_id: string;
  family: string;
  field: string;
  field_index: number;
  view: string;
  start_offset: number;
  end_offset: number;
  weight: string;
  damped: boolean;
  created_at: Date;
}

/** 테이블: `sender_marks` — 소유자 수동 분류(append-only, 최신 행 우선). 앱 롤은 SELECT 만. */
export interface SenderMarkRow {
  id: string;
  agent_id: AgentId;
  scope: 'address' | 'domain';
  address: string | null;
  domain: string | null;
  mark: 'seen' | 'cleared';
  marked_by: string;
  domain_scope_confirmed_by: string | null;
  marked_at: Date;
}

/** P4 가 생성하는 테이블. */
export const P4_TABLES = ['security_findings', 'sender_marks'] as const;

/** P4 테이블의 컬럼 집합 — **동일** 단언(`P3A_TABLE_COLUMNS` 와 같은 이유: 본문성 컬럼이 늘어나는 사고). */
export const P4_TABLE_COLUMNS = {
  security_findings: [
    'id',
    'inbound_message_id',
    'scanner_version',
    'ordinal',
    'rule_id',
    'family',
    'field',
    'field_index',
    'view',
    'start_offset',
    'end_offset',
    'weight',
    'damped',
    'created_at',
  ] as const satisfies readonly (keyof SecurityFindingRow)[],
  sender_marks: [
    'id',
    'agent_id',
    'scope',
    'address',
    'domain',
    'mark',
    'marked_by',
    'domain_scope_confirmed_by',
    'marked_at',
  ] as const satisfies readonly (keyof SenderMarkRow)[],
} as const;

// ---------------------------------------------------------------------------
// WP-2 — 결제 공급자 연동 (`202609250400_billing_provider.sql`, 계획 `.omc/plans/wp2-paddle-adapter.md` §4-2)
// ---------------------------------------------------------------------------
//
// 공급자 모양은 이 다섯 표에만 있다 — 엔타이틀먼트·정책 관문·투명성 잎은 공급자를 모른다. **이메일·주소·금액·포털 URL 은 어느 표에도 없다.**
// 공통 CHECK: `provider IN ('paddle')` · `environment IN ('sandbox','production')`(`src/billing/constants.ts` 의 두 목록과 같은 집합).
// 쓰는 롤: `atmark_billing`(sync λ) · `atmark_admin`(체크아웃 INSERT·status UPDATE 만) · `atmark_billing_operator`(구독 세 칸 SELECT 만).
// `atmark_app` 은 다섯 표 모두 권한 0.

/** 공급자 구독으로 살 수 있는 요금제 — `free`(행 없음)·`beta`(운영자 부여)는 결제로 얻지 못한다. 표 `plan_code` CHECK 와 같은 집합. */
export type BillingPlanCode = Exclude<PlanCode, 'free' | 'beta'>;

/**
 * `billing_events.status`. `done`·`ignored` 는 **종단**(트리거 `billing_events_guard`) — 같은 `event_id` 가 다시 와도 처리하지 않는다.
 * `failed` 는 종단이 아니다(SQS 재시도가 `attempts` 를 올리며 다시 처리한다). 이유 코드는 `last_error`(`BillingEventReasonCode`).
 */
export type BillingEventStatus = 'pending' | 'done' | 'ignored' | 'failed';

/**
 * 테이블: `billing_events` — 받은 웹훅 이벤트의 멱등 원장(PK `(provider, event_id)`, 영구). 봉투의 **좌표만** 싣는다 — 본문은 없고
 * 원문 바이트의 SHA-256 만. append-only(`_no_delete`·`_no_truncate`) · 핵심 칸 불변 · `attempts` 앞으로만.
 */
export interface BillingEventRow {
  provider: BillingProvider;
  /** `^evt_[a-z0-9]{26}$`(CHECK `billing_events_event_id_shape`). */
  event_id: string;
  event_type: BillingEventType;
  /** 공급자가 적은 발생 시각 — 기록·진단·웹훅 누락 탐지용. 순서 판단에는 쓰지 않는다(재조회한 `updated_at` 이 기준). */
  occurred_at: Date;
  notification_id: string | null;
  environment: PaddleEnvironment;
  /** 원문 바디 SHA-256(소문자 hex 64). */
  payload_sha256: string;
  subscription_id: string | null;
  transaction_id: string | null;
  status: BillingEventStatus;
  attempts: number;
  /** `BillingEventReasonCode`(`src/billing/constants.ts`) — 코드만. `pending`·`done` 이면 NULL. */
  last_error: string | null;
  received_at: Date;
  processed_at: Date | null;
}

/**
 * 테이블: `billing_customers` — 조직 ↔ 공급자 고객 결속(PK `(organization_id, provider, environment)`). 고치기·지우기 거부. 고객 id 는 키가 아니다 —
 * 한 공급자 고객이 여러 조직에 붙을 수 있다(H-1/M-4, 인덱스 `billing_customers_customer_idx`).
 */
export interface BillingCustomerRow {
  organization_id: string;
  provider: BillingProvider;
  /** `^ctm_[a-z0-9]{26}$`(CHECK `billing_customers_customer_id_shape`). */
  provider_customer_id: string;
  environment: PaddleEnvironment;
  created_at: Date;
}

/** `billing_subscriptions.status` — Paddle 구독 상태 다섯(계획 §0 P11). `canceled` 는 종단(P13, 트리거). */
export type BillingSubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled';

/** Paddle `scheduled_change.action`. */
export type BillingScheduledChangeAction = 'cancel' | 'pause' | 'resume';

/**
 * 테이블: `billing_subscriptions` — **재조회한** 공급자 구독의 정규화(PK `(provider, provider_subscription_id)`). 우리가 만든 거래
 * (`billing_checkouts`)에서 나온 구독만 결속된다. 조직·고객·원 거래·환경은 불변 · `provider_updated_at` 은 같거나 커질 때만 · `canceled` 종단.
 */
export interface BillingSubscriptionRow {
  provider: BillingProvider;
  /** `^sub_[a-z0-9]{26}$`(CHECK `billing_subscriptions_id_shape`). */
  provider_subscription_id: string;
  environment: PaddleEnvironment;
  organization_id: string;
  provider_customer_id: string;
  /** 결속 근거 — 이 구독을 만든 우리 거래(`billing_checkouts.transaction_id`). */
  origin_transaction_id: string;
  status: BillingSubscriptionStatus;
  /** 가격 id → 요금제(`src/billing/paddle/prices.ts`). **NULL = 모르는 가격** — 결정 함수가 noop(`unknown_price`) + 알람. */
  plan_code: BillingPlanCode | null;
  /** 반복 가격 항목이 정확히 하나일 때의 `pri_…`. 아니면 NULL(→ `plan_code` NULL). */
  price_id: string | null;
  /** `current_billing_period.ends_at` — 일시정지·해지면 NULL. */
  current_period_end: Date | null;
  scheduled_change_action: BillingScheduledChangeAction | null;
  scheduled_change_at: Date | null;
  /** min(실패한 갱신 거래 시각, `current_billing_period.starts_at`) — `past_due` 가 아니면 NULL(계획 §3-4). */
  past_due_since: Date | null;
  /** 공급자 엔터티의 `updated_at` — 순서 판단의 유일한 기준(앞으로만). */
  provider_updated_at: Date;
  /** 이 행을 마지막으로 재조회해 쓴 시각. */
  synced_at: Date;
  created_at: Date;
}

/** `billing_checkouts.status` — `open → completed | superseded` 만(트리거 `billing_checkouts_guard`). */
export type BillingCheckoutStatus = 'open' | 'completed' | 'superseded';

/**
 * 테이블: `billing_checkouts` — admin 이 만든 Paddle 거래(txn). **결속의 유일한 근거**다 — 여기 없는 거래에서 나온 구독은 어느 조직에도
 * 결속되지 않는다(공개 클라이언트 토큰으로 만든 체크아웃 차단, 계획 §3-6). 중복 클릭은 같은 조직·환경·요금제의 `open`(30분 안) 행을 재사용한다.
 */
export interface BillingCheckoutRow {
  id: string;
  organization_id: string;
  provider: BillingProvider;
  environment: PaddleEnvironment;
  /** `^txn_[a-z0-9]{26}$`(CHECK `billing_checkouts_transaction_id_shape`) · UNIQUE. */
  transaction_id: string;
  plan_code: BillingPlanCode;
  /** 콘솔 세션의 사용자(owner·admin, D-5). */
  created_by_user_id: string;
  status: BillingCheckoutStatus;
  created_at: Date;
  completed_at: Date | null;
}

/**
 * `billing_reconcile_state.phase` — 하루 1회 대조의 단계(계획 §3-5). `list`(공급자 목록 페이지) → `stale`(표에만 남은 비종단 구독 재조회)
 * → `orgs`(조직 청크 50개씩 재계산) → `done`. 마지막 `completed_at` 이 24시간을 넘으면 새 판이 `list` 로 연다.
 */
export type BillingReconcilePhase = 'list' | 'stale' | 'orgs' | 'done';

/** 테이블: `billing_reconcile_state` — 15분 틱이 이어 가는 reconcile 커서. **한 행**(`id = 1`, CHECK `_singleton`) · 지우기 거부. */
export interface BillingReconcileStateRow {
  id: 1;
  run_id: string;
  phase: BillingReconcilePhase;
  /** 공급자 목록 API 의 `after` 커서 — `list` 단계가 아니거나 첫 페이지면 NULL. */
  paddle_cursor: string | null;
  /** `orgs` 단계에서 마지막으로 끝낸 조직 id(id 순) — 아니면 NULL. */
  org_cursor: string | null;
  started_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

/** WP-2 가 만드는 표 다섯 — migrate `APP_FORBIDDEN_LOGIN_TABLES` · 롤 권한 행렬 테스트가 같은 목록을 본다. */
export const BILLING_PROVIDER_TABLES = [
  'billing_events',
  'billing_customers',
  'billing_subscriptions',
  'billing_checkouts',
  'billing_reconcile_state',
] as const;
export type BillingProviderTable = (typeof BILLING_PROVIDER_TABLES)[number];

/** WP-2 표의 컬럼 집합 — 마이그레이션과 **동일** 단언(`P4_TABLE_COLUMNS` 와 같은 이유: 이메일·금액 같은 칸이 조용히 늘어나는 사고). */
export const BILLING_PROVIDER_TABLE_COLUMNS = {
  billing_events: [
    'provider',
    'event_id',
    'event_type',
    'occurred_at',
    'notification_id',
    'environment',
    'payload_sha256',
    'subscription_id',
    'transaction_id',
    'status',
    'attempts',
    'last_error',
    'received_at',
    'processed_at',
  ] as const satisfies readonly (keyof BillingEventRow)[],
  billing_customers: [
    'organization_id',
    'provider',
    'provider_customer_id',
    'environment',
    'created_at',
  ] as const satisfies readonly (keyof BillingCustomerRow)[],
  billing_subscriptions: [
    'provider',
    'provider_subscription_id',
    'environment',
    'organization_id',
    'provider_customer_id',
    'origin_transaction_id',
    'status',
    'plan_code',
    'price_id',
    'current_period_end',
    'scheduled_change_action',
    'scheduled_change_at',
    'past_due_since',
    'provider_updated_at',
    'synced_at',
    'created_at',
  ] as const satisfies readonly (keyof BillingSubscriptionRow)[],
  billing_checkouts: [
    'id',
    'organization_id',
    'provider',
    'environment',
    'transaction_id',
    'plan_code',
    'created_by_user_id',
    'status',
    'created_at',
    'completed_at',
  ] as const satisfies readonly (keyof BillingCheckoutRow)[],
  billing_reconcile_state: [
    'id',
    'run_id',
    'phase',
    'paddle_cursor',
    'org_cursor',
    'started_at',
    'updated_at',
    'completed_at',
  ] as const satisfies readonly (keyof BillingReconcileStateRow)[],
} as const satisfies Record<BillingProviderTable, readonly string[]>;

// ---------------------------------------------------------------------------
// 호스팅 운영자 콘솔(ops.atmark.ai — 202609290500, `.omc/plans/ops-console.md` §3.3)
// ---------------------------------------------------------------------------

export type OpsOperatorStatus = 'requested' | 'active' | 'denied' | 'revoked' | 'expired';
export type OpsOperatorOrigin = 'cli' | 'console';
export type OpsChallengePurpose = 'login' | 'access_request' | 'step_up';
export type OpsChallengeStatus = 'pending' | 'sent' | 'dead' | 'undeliverable' | 'obsolete';
export type OpsActionKind = 'ticket' | 'failure' | 'session_event' | 'operator_event';

export interface OpsOperatorRow {
  id: string;
  email: string;
  status: OpsOperatorStatus;
  origin: OpsOperatorOrigin;
  requested_at: Date | null;
  decided_at: Date | null;
  decided_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OpsLoginChallengeRow {
  id: string;
  purpose: OpsChallengePurpose;
  email: string;
  operator_id: string | null;
  session_id: string | null;
  action: string | null;
  organization_id: string | null;
  target_operator_id: string | null;
  target_ref: string | null;
  binding: string | null;
  client_key: string;
  lang: 'ko' | 'en';
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  invalidated_at: Date | null;
  code_failures: number;
  code_digest: string | null;
  status: OpsChallengeStatus;
  attempt_count: number;
  next_attempt_at: Date;
  claimed_at: Date | null;
  last_error: string | null;
  ses_message_id: string | null;
  sent_at: Date | null;
  settled_at: Date | null;
}

/** 202609290500 이 만드는 표 — migrate `APP_FORBIDDEN_LOGIN_TABLES` · status 검사 2(다른 롤의 ops 표 권한 0)가 같은 목록을 본다. */
export const OPS_TABLES = [
  'ops_settings',
  'ops_operators',
  'ops_operator_events',
  'ops_sessions',
  'ops_login_challenges',
  'ops_login_attempts',
  'ops_address_failures',
  'ops_step_up_grants',
  'ops_actions',
  'ops_action_effects',
] as const;
export type OpsTable = (typeof OPS_TABLES)[number];

/** ops 표의 컬럼 집합 — 마이그레이션과 **동일** 단언(`test/integration/ops/identity.test.ts`). 비밀 칸이 조용히 늘어나는 사고를 막는다. */
export const OPS_TABLE_COLUMNS = {
  ops_settings: ['id', 'console_enabled', 'hard_locked', 'failure_salt', 'updated_at'],
  ops_operators: ['id', 'email', 'status', 'origin', 'requested_at', 'decided_at', 'decided_by', 'created_at', 'updated_at'] as const satisfies readonly (keyof OpsOperatorRow)[],
  ops_operator_events: ['id', 'operator_id', 'from_status', 'to_status', 'actor', 'created_at'],
  ops_sessions: ['id', 'operator_id', 'token_hash', 'ua_hash', 'client_key', 'created_at', 'expires_at', 'last_seen_at', 'step_up_failures', 'revoked_at', 'revoke_reason'],
  ops_login_challenges: [
    'id',
    'purpose',
    'email',
    'operator_id',
    'session_id',
    'action',
    'organization_id',
    'target_operator_id',
    'target_ref',
    'binding',
    'client_key',
    'lang',
    'created_at',
    'expires_at',
    'used_at',
    'invalidated_at',
    'code_failures',
    'code_digest',
    'status',
    'attempt_count',
    'next_attempt_at',
    'claimed_at',
    'last_error',
    'ses_message_id',
    'sent_at',
    'settled_at',
  ] as const satisfies readonly (keyof OpsLoginChallengeRow)[],
  ops_login_attempts: ['id', 'client_key', 'kind', 'address_hash', 'created_at'],
  ops_address_failures: ['address_hash', 'day', 'failures', 'locked_until', 'updated_at'],
  ops_step_up_grants: ['id', 'session_id', 'action', 'organization_id', 'target_operator_id', 'target_ref', 'mode', 'created_at', 'expires_at', 'used_at'],
  ops_actions: [
    'id',
    'kind',
    'result',
    'operator_id',
    'session_id',
    'client_key',
    'action',
    'organization_id',
    'agent_id',
    'target_operator_id',
    'code',
    'xact_id',
    'created_at',
  ],
  ops_action_effects: ['id', 'action_id', 'table_name', 'row_key', 'op', 'created_at'],
} as const satisfies Record<OpsTable, readonly string[]>;

// ---------------------------------------------------------------------------
// 고객 도메인(ADR-0014 — 202609291100 · 1110 · 1120 · 1130). 값의 유니온은 `src/domains/contract.ts` 가 단일 원천이다.
// ---------------------------------------------------------------------------

/**
 * 테이블: `custom_domains` — 조직의 에이전트 전용 서브도메인 하나(행 = 한 번의 등록 시도, 제거되면 새 행). DELETE 는 아무 롤에도 없다.
 * `id · organization_id · domain · registrable_domain · challenge_token · created_by_user_id · created_at` 는 불변(트리거). 상태 전이는
 * `custom_domains_transition_guard` 가, 교차 조직 apex 점유는 `custom_domains_registrable_guard` 가, 조직 천장·pending 상한은
 * `custom_domains_limits_guard` 가 집행한다. 상태·확인·사가 칸은 틱 롤(`atmark_domain_tick`)만 고치고, admin 은 행 만들기 · 수동 확인 칸 ·
 * 제거 요청만, 앱 롤은 읽기 + 워밍업 시계 함수 EXECUTE 하나(ADR-0014 · 보안 M2).
 */
export interface CustomDomainRow {
  id: string;
  organization_id: string;
  /** 소문자 LDH, 끝 점 없음, R-LDH 없음(CHECK). 앱이 `judgeCustomDomain` 을 통과한 값만 넣는다. */
  domain: string;
  /** PSL(ICANN+PRIVATE) 등록 가능 apex — 앱이 채운다. CHECK: `domain` 이 `.registrable` 로 끝나고 같지 않다. */
  registrable_domain: string;
  status: CustomDomainStatus;
  suspended_reason: CustomDomainSuspendedReason | null;
  pending_reason: CustomDomainPendingReason | null;
  /** 32바이트 base64url. apex TXT `atmark-domain-verification=<token>`. */
  challenge_token: string;
  txt_verified_at: Date | null;
  saga_step: CustomDomainSagaStep;
  saga_attempts: number;
  removal_step: CustomDomainRemovalStep;
  /** 마지막 사가·제거·동기화 오류 코드(도메인명·DNS 원문 없음). */
  last_error: string | null;
  /** identity 에 붙인 행 태그(`atmark:row`) — 이 행 또는 양도받은 옛 행. */
  ses_identity_row_tag: string | null;
  /** 양도(M11)로 이 행을 대체한 새 행. */
  superseded_by: string | null;
  dkim_status: CustomDomainSesStatus;
  dkim_tokens: string[];
  mail_from_status: CustomDomainSesStatus;
  inbound_mx_status: InboundMxStatus;
  /** 마지막으로 쓴 identity policy 정규화본의 SHA-256(hex). */
  policy_digest: string | null;
  /** NOT NULL = I2+ 정책 동기화가 밀려 있다(주소 발급·폐기·상태 전이 트리거가 적는다, 틱이 비운다). */
  policy_sync_requested_at: Date | null;
  last_checked_at: Date | null;
  next_check_at: Date;
  consecutive_definitive_failures: number;
  last_manual_check_at: Date | null;
  /** 도메인 워밍업 Day 1 — 첫 발송 성공(DEFINER `atmark_mark_domain_sending_started`, 1회). */
  sending_started_at: Date | null;
  /** RDAP 만료일(등록 가능 apex, §3.13)과 마지막 확인. */
  registration_expires_at: Date | null;
  registration_checked_at: Date | null;
  verified_at: Date | null;
  suspended_at: Date | null;
  removed_at: Date | null;
  /** ownership_lost 정지 + 14일. */
  removal_due_at: Date | null;
  /**
   * 소유자의 제거 요청(쓰기 1회 — admin 이 적는 유일한 상태 칸). 적는 순간 트리거가 행을 removed 로 바꾼다(관문은 커밋 즉시 막는다). 주소는
   * 남는다(자발적 제거 — ADR-0014 D-H).
   */
  removal_requested_at: Date | null;
  /**
   * 동결 톰스톤(재리뷰 M1) — reputation·operator 정지 상태에서 removed 로 나간 행의 그 사유. 같은 도메인·apex 에 있으면 새 등록과 verifying 진입이
   * 42501 이다(소유자 롤 예외). 전이 가드만 적고 소유자 롤(운영자 해제)만 지운다.
   */
  frozen_reason_at_removal: 'reputation' | 'operator' | null;
  identity_deleted_at: Date | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** 테이블: `org_features` — 운영자 기능 허용 목록(M13). 쓰기는 테이블 소유자(운영자 CLI)뿐, admin 은 읽기만. 기본 비어 있음. */
export interface OrgFeatureRow {
  organization_id: string;
  feature: typeof CUSTOM_DOMAINS_FEATURE;
  enabled_at: Date;
  enabled_by: string;
}

/** 테이블: `domain_notices` — 도메인 알림 outbox(M14). 수신자·본문 칸이 없다(보낼 때 DEFINER 함수가 owner·admin 주소를 준다). */
export interface DomainNoticeRow {
  id: string;
  domain_id: string;
  organization_id: string;
  kind: DomainNoticeKind;
  /** 같은 사건의 알림을 한 번만 — `(domain_id, kind, event_key)` UNIQUE. 정지·제거 = 그 시각, 만료 예고 = 예고 일수. */
  event_key: string;
  lang: 'ko' | 'en';
  created_at: Date;
  status: 'pending' | 'sent' | 'dead' | 'obsolete';
  attempt_count: number;
  next_attempt_at: Date;
  claimed_at: Date | null;
  last_error: string | null;
  ses_message_id: string | null;
  sent_at: Date | null;
}

/** 테이블: `quarantine_notices` — 격리 알림 outbox(ADR-0016 2026-10-07). 에이전트당 열린 창 하나 · 수신자·본문 칸 없음(집기 DEFINER 가 owner_email). */
export interface QuarantineNoticeRow {
  id: string;
  agent_id: string;
  organization_id: string;
  first_at: Date;
  last_at: Date;
  message_count: number;
  status: 'pending' | 'sent' | 'suppressed' | 'dead' | 'obsolete';
  attempt_count: number;
  next_attempt_at: Date;
  claimed_at: Date | null;
  last_error: string | null;
  ses_message_id: string | null;
  sent_at: Date | null;
  /** 알림 종류(202610081000) — block(차단 등급 · 항상) | risk(위험 등급 · `risk_notify`). 에이전트 · 종류마다 열린 창 하나. */
  kind: 'block' | 'risk';
}

/** 테이블: `quarantine_notice_items` — 창에 묶인 격리 메일(메일 하나에 한 줄). 검사를 통과한 보낸 사람 도메인 · 사유만. */
export interface QuarantineNoticeItemRow {
  inbound_message_id: string;
  notice_id: string;
  sender_domain: string | null;
  /** From 이 DMARC 인증됐는가 — 거짓이면 도메인은 본문에 싣지 않는다(수로만). */
  sender_authenticated: boolean;
  /** 차단 창(`kind = block`)은 격리 사유 둘, 위험 창(`kind = risk`)은 `risk_hold` | `risk_delivered`(202610081000). */
  reason: 'injection_risk' | 'scanner_error' | 'risk_hold' | 'risk_delivered';
  created_at: Date;
}

/** 테이블: `agent_watch_settings`(202610081000) — 감시 탭의 에이전트별 받기 설정. 행이 없으면 기본값(deliver · 알림 켬). */
export interface AgentWatchSettingsRow {
  agent_id: string;
  risk_handling: RiskHandling;
  risk_notify: boolean;
  updated_at: Date;
  updated_by: string | null;
}

/** 테이블: `org_watch_settings`(202610081000) — 감시 탭의 조직 설정(칸은 다음 묶음이 더한다). */
export interface OrgWatchSettingsRow {
  organization_id: string;
  updated_at: Date;
  updated_by: string | null;
}

/** 테이블: `org_trusted_senders`(202610081000) — 신뢰 발신자. 지우기는 표시 한 번 · 살아 있는 항목 200. */
export interface OrgTrustedSenderRow {
  id: string;
  organization_id: string;
  kind: TrustedSenderKind;
  /** 소문자. 주소는 `local@domain`, 도메인은 정확한 이름(하위 도메인을 포함하지 않는다). */
  value: string;
  created_at: Date;
  created_by: string | null;
  removed_at: Date | null;
  removed_by: string | null;
}

/**
 * 테이블: `mail_identity_claims`(ADR-0014 결정 7 · M9) — 에이전트 주소와 사람 이메일의 **상호 배제**. 평문이 없다(`claim_hash` =
 * SHA-256(`atmark_mail_claim_key(address)`)). 종류 셋(`MailClaimKind`): 에이전트(톰스톤) · 멤버였던 사람 · 초대만 받은 사람(에이전트 발급이
 * 이긴다). 사람 claim 은 그 행의 주소가 바뀌거나 지워질 때(초대만 받은 사용자 지우기) 트리거가 푼다.
 */
export interface MailIdentityClaimRow {
  claim_hash: Buffer;
  kind: MailClaimKind;
  source_table: 'agent_addresses' | 'users' | 'organizations';
  source_id: string;
  created_at: Date;
}
