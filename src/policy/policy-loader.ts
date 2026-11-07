/**
 * 평가에 필요한 모든 데이터의 **선적재**. 조회·정규화·jsonb 좁히기가 전부 여기서 끝나고, 엔진은 완성된
 * `EvaluationContext`·`ResolvedPolicy` 만 본다 — 그래서 `engine.ts` 가 순수 함수일 수 있다(§4.2).
 */

import { resolveEntitlements, type EntitlementsTableMissing } from '../billing/plans';
import type {
  AgentAddressRow,
  AgentId,
  AgentPolicyRow,
  AgentRow,
  ApprovalRequestRow,
  JsonObject,
  OrganizationRow,
  OrgEntitlementsRow,
  PolicyVersionRow,
  InboundSenderTrust,
  InjectionRisk,
  SenderRelationshipRow,
  SuppressionEntryRow,
  ThreadRow,
} from '../db/schema';
import { domainGateStatusOf, type CustomDomainStatus, type CustomDomainSuspendedReason } from '../domains/contract';
import { AGENT_ADDRESS_DOMAIN } from '../identity/address';
import { isOutboundRecipientAddress, isPlatformDomainRule } from './contact-rules';
import { DLP_FAMILIES } from '../security/dlp/scan';
import { OUTBOUND_ROUTES } from './manifest';
import type { SnapshotRule } from './policy-snapshot';
import { resolveRiskHold, type RiskSignalSource } from './risk-signals';
import type {
  ApprovalContext,
  ApprovalGrant,
  BudgetSnapshot,
  ContentPolicy,
  DomainGateStatus,
  DomainSnapshot,
  EvaluationContext,
  HumanApprovalReason,
  OutboundAttempt,
  PolicyLimits,
  PreApprovalRules,
  RelationshipMatch,
  ResolvedPolicy,
  SendCounters,
  VerifiedThreadReply,
} from './types';

// ---------------------------------------------------------------------------
// 소스 인터페이스
// ---------------------------------------------------------------------------

/** 한 번의 평가를 위해 읽어야 하는 것(N+1 을 피하려고 한 번에 묶는다). */
export interface PolicySourceQuery {
  readonly agentId: AgentId;
  /** 억제 목록 교집합을 DB 쪽에서 구하려고 넘긴다. */
  readonly recipients: readonly string[];
  /** 억제 만료와 카운터 윈도의 기준 시각. */
  readonly now: Date;
  /** 시도가 **주장한** 스레드. 소스는 읽기만 하고 검증은 로더가 한다(`resolveThreadReply`). */
  readonly threadId: string | null;
  /** 릴리스 중인 승인 요청. `null` 이면 grant 를 조회하지 않는다. */
  readonly releaseApprovalId: string | null;
}

/** 스레드의 최신 인증 수신 메일 — 행 그대로. */
export interface ThreadInboundSource {
  readonly id: string;
  /** 소문자(`inbound_messages` CHECK). `+tag` 는 보존돼 있다. */
  readonly from_address: string;
  readonly injection_risk: InjectionRisk | null;
  readonly sender_trust: InboundSenderTrust | null;
  readonly quarantined: boolean;
  readonly received_at: Date;
  readonly attachment_count: number;
}

/** 주장된 스레드에 관해 소스가 읽은 것 — 권한용 `thread_id` 로만(`display_thread_id` 는 정책 입력이 아니다), 인증 수신만. */
export interface ThreadSource {
  /** `threads` 행(로더가 `agent_id` 를 한 번 더 대조한다). */
  readonly thread: ThreadRow;
  /** 이 스레드에 인증된 수신 메일을 보낸 발신자 전량(소문자, 원형). */
  readonly authenticatedSenders: readonly string[];
  /** 최신 인증 수신. 없으면 `null`(답할 메일이 없다). */
  readonly latestAuthenticatedInbound: ThreadInboundSource | null;
  /**
   * 이 스레드에서 위험 보류를 `once` 로 승인받아 나간 발신이 최근 7일 안에 있다(리뷰 H2 · N3). 참이면 외부가 연 스레드로 친다 —
   * `once` 승인 한 번이 `auto_approve_reply_within_thread` 상시 채널이 되지 않게. 생략은 거짓(가짜 소스).
   */
  readonly onceApproved?: boolean;
}

/**
 * 에이전트의 살아 있는 고객 도메인 하나의 행(ADR-0014) — 같은 조직의 removed 아닌 행, 없으면 최근 removed 행, 그것도 없으면 `missing`.
 * `atmark.ai` 는 오지 않는다. 해석은 로더가 한다.
 */
export interface BoundDomainSource {
  /** 소문자 도메인 = `agent_addresses.domain`. */
  readonly domain: string;
  readonly status: CustomDomainStatus | 'missing';
  readonly suspended_reason: CustomDomainSuspendedReason | null;
  /** 도메인 워밍업 기준일(첫 발송 성공). */
  readonly sending_started_at: Date | null;
  /** 최근 24시간 이 조직이 이 도메인으로 보낸 수신자 수. */
  readonly recipients_last_day: number;
}

/** 소스가 채우는 카운터 — 도메인 카운터는 로더가 `BoundDomainSource` 에서 고른다. */
export type SourceSendCounters = Omit<SendCounters, 'domainRecipientsLastDay'>;

/** 릴리스 중인 승인 요청과, 그 요청이 덮는 수신자(원본 주소 — 정규화는 로더가 한다). */
export interface ApprovalGrantSource {
  readonly request: ApprovalRequestRow;
  readonly recipients: readonly string[];
}

/** 조회 결과 원본 — 행 타입 그대로(소스 구현마다 가공이 달라지면 판정이 달라진다). */
export interface PolicySourceResult {
  readonly organization: OrganizationRow;
  /**
   * `org_entitlements` 행(ADR-0011). 없으면 `null`(Free — fail closed), 표가 없으면(배포 순서 위반) `'table_missing'`(도입 전 한도).
   * 해석은 로더(`resolveEntitlements`).
   */
  readonly entitlements: OrgEntitlementsRow | EntitlementsTableMissing | null;
  readonly agent: AgentRow;
  readonly addresses: readonly AgentAddressRow[];
  /** 이 에이전트의 주소지만 지금 쓸 수 없는 것(폐기된 별칭 등) — Stage 1 이 `from_inactive` 로 가른다. */
  readonly inactiveAddresses: readonly string[];
  /**
   * 유효 대표 주소(SQL `atmark_agent_primary_address`, 무효면 `null`). 기본 From 을 고르는 읽기만 쓰고 관문 판정은 보지 않는다.
   * 없으면(가짜 소스) `is_primary` 행.
   */
  readonly primaryAddress?: string | null;
  readonly policy: AgentPolicyRow;
  /** `policy.current_version` 의 불변 스냅샷 행(§4.3). */
  readonly policyVersion: PolicyVersionRow;
  /**
   * 그 스냅샷의 규칙 중 **에이전트의 정책 변경 요청을 승인해 생긴 것**의 id(규칙 행 `created_by` 의 `policy_request:` 표지 — 보안 감사 H-1).
   * 위험 보류 면제에서 뺄 주소를 고르는 데만 쓴다(`ResolvedPolicy.agentRequestedAllowlist`). 넘치게 줘도 된다(스냅샷에 있는 id 만 본다).
   */
  readonly agentRequestedRuleIds: readonly string[];
  /** `query.recipients` 중 현재 유효한 억제 항목만(만료 판정은 소스). */
  readonly suppressions: readonly SuppressionEntryRow[];
  /** 이번 시도를 포함하지 않은 카운터. 눈금은 `SendCounters` 규약(`orgRecipientsLastDay` 는 수신자 수)이다. */
  readonly counters: SourceSendCounters;
  /** 살아 있는 주소의 고객 도메인마다 한 행. 전부 `atmark.ai` 면 빈 배열(`custom_domains` 를 읽지도 않는다). */
  readonly customDomains: readonly BoundDomainSource[];
  /** 이번 달 누적 사용액(센트). */
  readonly monthToDateSpentCents: number;
  /** 이번 수신자들에 걸릴 수 있는 관계 행 — 소스는 넓게 읽어도 된다(매칭은 로더가 다시 한다). */
  readonly relationships: readonly SenderRelationshipRow[];
  /** `query.releaseApprovalId` 의 요청. 상태 판정은 로더가 한다. */
  readonly approvalGrant: ApprovalGrantSource | null;
  /** 지금까지 내보낸 outbound 수 — bootstrap_grace 의 분자. */
  readonly outboundSentCount: number;
  /** `query.threadId` 의 스레드 사실(이 에이전트의 것이 아니면 `null`). 회신 인정은 로더가 정한다. */
  readonly thread: ThreadSource | null;
}

/** 평가 데이터의 출처. 운영은 `db/repositories/policy-source.ts`. */
export interface PolicySource {
  load(query: PolicySourceQuery): Promise<PolicySourceResult>;
}

/** 평가 데이터를 읽을 수 없다 — 관문이 `evaluation_error` 로 닫는다. */
export class PolicySourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicySourceUnavailableError';
  }
}

/** 항상 던지는 소스. 빈 결과를 돌려주지 않는다 — 빈 정책이 "제약 없음" 으로 읽힐 여지를 두지 않는다. */
export function unavailablePolicySource(): PolicySource {
  return {
    load(query: PolicySourceQuery): Promise<PolicySourceResult> {
      return Promise.reject(
        new PolicySourceUnavailableError(
          `P1a 에는 정책 데이터 소스가 없다 (agentId=${query.agentId}). P1b 에서 Postgres 구현이 들어온다.`,
        ),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 정규화
// ---------------------------------------------------------------------------

/**
 * **판정형** 주소 — 정규화의 유일한 지점(엔진은 다시 소문자화하지 않는다). **`+tag` 를 절단한다**: `victim+x@` 와 `victim@` 는
 * 같은 메일함이라, 자르지 않으면 불만 신고한 사람에게 다시 보내는 평판 사건이 된다. 거부(억제·차단)는 넓게 묶는다.
 * 도메인별 규칙(Gmail 의 `.` 무시 등)은 두지 않는다 — 표에 없는 도메인이 통과 경로가 된다. 판정에만 쓰고 전송은 원본 주소로 한다.
 */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf('@');
  // 주소가 아니면 손대지 않는다 — `@x` 같은 값이 도메인 항목과 우연히 맞지 않게.
  if (atIndex <= 0) return trimmed;

  const local = trimmed.slice(0, atIndex);
  const plusIndex = local.indexOf('+');
  // `+` 가 맨 앞이면 빈 로컬파트가 된다 — 그대로 둔다.
  if (plusIndex <= 0) return trimmed;

  return `${local.slice(0, plusIndex)}@${trimmed.slice(atIndex + 1)}`;
}

/**
 * 주소 모양 최소 검사(`agent_addresses` DB CHECK 와 같은 정규식). `\s` 가 `\r`·`\n` 을 포함해 헤더 인젝션이 여기서 죽고
 * (`build.ts` `assertHeaderSafe` 가 한 번 더), `@` 없는 조용한 무효값을 막는다. 실제 유효성은 bounce 가 알려 준다.
 */
export const ADDRESS_SHAPE = /^[^@\s]+@[^@\s]+$/;

/** `ADDRESS_SHAPE` 판정. */
export function isAddressShape(address: string): boolean {
  return ADDRESS_SHAPE.test(address);
}

/** MIME 타입 정규화 — 정책 쪽과 시도 쪽이 같은 함수를 쓴다(비대칭이면 "왜 막혔는지" 를 설명할 수 없다). */
function normalizeMimeType(mimeType: string): string {
  return mimeType.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// jsonb 좁히기 — 실패는 여기서 끝난다
// ---------------------------------------------------------------------------

/** 잘못된 정책 jsonb·시도 입력 — 엔진에 닿기 전에 끊는다(관문 `evaluation_error`). */
export class PolicyShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyShapeError';
  }
}

/**
 * 0 이상의 정수인가(`NaN`·`Infinity`·소수도 거른다). 정책 jsonb 와 **시도 입력**이 같은 검증을 쓴다 — 시도는 에이전트가 쓰고,
 * 음수 하나가 Stage 5·6 의 부등호를 뒤집는다(첨부 상한 통과·예산 무제한).
 */
function requireNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new PolicyShapeError(`${label} 는 0 이상의 정수여야 한다: ${JSON.stringify(value)}`);
  }
  return value;
}

function requirePositiveInt(source: JsonObject, key: string): number {
  return requireNonNegativeInt(source[key], `정책 필드 "${key}"`);
}

/** MIME 타입 배열 — 시도 쪽과 같은 정규화. */
function requireMimeTypeArray(source: JsonObject, key: string): readonly string[] {
  const value = source[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new PolicyShapeError(`정책 필드 "${key}" 는 문자열 배열이어야 한다: ${JSON.stringify(value)}`);
  }
  return (value as readonly string[]).map(normalizeMimeType);
}

/** `agent_policies.limits` (jsonb) → Stage 4 의 한도. */
export function resolveLimits(limits: JsonObject): PolicyLimits {
  return {
    perMinute: requirePositiveInt(limits, 'per_minute'),
    perHour: requirePositiveInt(limits, 'per_hour'),
    perDay: requirePositiveInt(limits, 'per_day'),
    recipientsPerMessage: requirePositiveInt(limits, 'recipients_per_message'),
  };
  // `warmup_daily_cap` 은 여기 없다 — 코드 상수다(`rules/limits.ts`).
}

// ---------------------------------------------------------------------------
// pre-approval 규칙 · 승인 TTL (§3.4 3조 · 4조)
// ---------------------------------------------------------------------------

/** 승인 TTL 기본 24시간(§3.4 4조). */
export const DEFAULT_APPROVAL_TTL_SECONDS = 24 * 60 * 60;
/** 1시간 미만은 사람이 못 본다(DB CHECK `approval_requests_ttl_range` 와 같은 범위). */
export const MIN_APPROVAL_TTL_SECONDS = 60 * 60;
/** 7일 초과는 사실상 영구 보류다. */
export const MAX_APPROVAL_TTL_SECONDS = 7 * 24 * 60 * 60;

function optionalBoolean(source: JsonObject, key: string, fallback: boolean): boolean {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new PolicyShapeError(`정책 필드 "${key}" 는 boolean 이어야 한다: ${JSON.stringify(value)}`);
  }
  return value;
}

/** `config_json` → pre-approval 규칙 3종. 키가 없으면 기본값, 있는데 모양이 틀리면 던진다(소유자가 적은 것과 판정이 갈라지지 않게). */
export function resolvePreApprovalRules(config: JsonObject): PreApprovalRules {
  const domainsRaw = config['auto_approve_domains'];
  let autoApproveDomains: readonly string[] = [];
  if (domainsRaw !== undefined) {
    if (!Array.isArray(domainsRaw) || domainsRaw.some((item) => typeof item !== 'string')) {
      throw new PolicyShapeError(
        `정책 필드 "auto_approve_domains" 는 문자열 배열이어야 한다: ${JSON.stringify(domainsRaw)}`,
      );
    }
    autoApproveDomains = (domainsRaw as readonly string[]).map((domain) => {
      const normalized = domain.trim().toLowerCase();
      // 주소를 적은 실수(`ceo@partner.com`)를 도메인으로 잘라 읽으면 의도보다 넓어진다 — 던진다.
      if (normalized === '' || /[@\s]/.test(normalized)) {
        throw new PolicyShapeError(`auto_approve_domains 의 항목이 도메인이 아니다: ${JSON.stringify(domain)}`);
      }
      return normalized;
    });
  }

  return {
    autoApproveReplyWithinThread: optionalBoolean(config, 'auto_approve_reply_within_thread', true),
    autoApproveDomains,
    // 기본 OFF. 켜져도 전제 전부가 참일 때만 열린다(`rules/outbound-mode.ts`).
    autoApproveVerificationSenders: optionalBoolean(config, 'auto_approve_verification_senders', false),
  };
}

/** `config_json.approval_ttl_seconds` → 승인 TTL. 없으면 24h, 범위 밖이면 던진다. */
export function resolveApprovalTtlSeconds(config: JsonObject): number {
  const value = config['approval_ttl_seconds'];
  if (value === undefined) return DEFAULT_APPROVAL_TTL_SECONDS;
  const ttl = requireNonNegativeInt(value, '정책 필드 "approval_ttl_seconds"');
  if (ttl < MIN_APPROVAL_TTL_SECONDS || ttl > MAX_APPROVAL_TTL_SECONDS) {
    throw new PolicyShapeError(
      `approval_ttl_seconds 는 ${String(MIN_APPROVAL_TTL_SECONDS)}~${String(MAX_APPROVAL_TTL_SECONDS)} 이어야 한다: ${String(ttl)}`,
    );
  }
  return ttl;
}

/**
 * `config_json` → Stage 6 의 콘텐츠 가드. `max_attachment_bytes_total` 이 JSON `null` 이면 "요금제를 따른다" — 천장을 넣고
 * `loadEvaluationInput` 이 `min(정책, 요금제, 천장)` 으로 좁힌다. 키가 없거나 모양이 틀리면 던진다(fail closed).
 */
export function resolveContentPolicy(config: JsonObject): ContentPolicy {
  return {
    maxAttachmentBytesTotal:
      config['max_attachment_bytes_total'] === null ? ATTACHMENT_BYTES_TOTAL_CEILING : requirePositiveInt(config, 'max_attachment_bytes_total'),
    allowedMimeTypes: requireMimeTypeArray(config, 'allowed_mime_types'),
  };
}

const CONTACT_RULE_DIRECTION_VALUES: readonly string[] = ['inbound', 'outbound'];
const CONTACT_RULE_LIST_VALUES: readonly string[] = ['allow', 'block'];
const CONTACT_RULE_KIND_VALUES: readonly string[] = ['address', 'domain'];

/**
 * **정책 버전 스냅샷의 목록**(`snapshot.contact_rules`) → 규칙들 — 발신 관문과 수신 판정의 근거다(검증 M3). 살아 있는 테이블을
 * 읽으면 버전 없이 행만 바뀐 창에서 판정과 스탬프된 버전의 목록이 갈라진다. DB 는 반대쪽을 지킨다(목록이 바뀌면 같은 트랜잭션에
 * 새 버전이 있어야 커밋 — 202609241040 트리거).
 * - 키가 없으면 빈 목록(정책 v2 이전 스냅샷). 모양이 틀리면 던진다(관문 `evaluation_error`, 수신 격리).
 * - 값의 모양은 다시 보지 않는다(DB CHECK 가 봤다 — 좁아지기 전 값은 어떤 정규 수신자와도 맞지 않아 무해하다).
 */
export function snapshotContactRules(snapshot: JsonObject): readonly SnapshotRule[] {
  const raw = snapshot['contact_rules'];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new PolicyShapeError(`스냅샷 "contact_rules" 는 배열이어야 한다: ${JSON.stringify(raw)}`);
  return raw.map((item: unknown, index): SnapshotRule => {
    const rule = typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    const id = rule?.['id'];
    const direction = rule?.['direction'];
    const list = rule?.['list'];
    const kind = rule?.['kind'];
    const value = rule?.['value'];
    if (
      typeof id !== 'string' ||
      typeof direction !== 'string' ||
      !CONTACT_RULE_DIRECTION_VALUES.includes(direction) ||
      typeof list !== 'string' ||
      !CONTACT_RULE_LIST_VALUES.includes(list) ||
      typeof kind !== 'string' ||
      !CONTACT_RULE_KIND_VALUES.includes(kind) ||
      typeof value !== 'string' ||
      value === '' ||
      (kind === 'address') !== value.includes('@')
    ) {
      throw new PolicyShapeError(`스냅샷 "contact_rules[${String(index)}]" 모양이 틀렸다: ${JSON.stringify(item)}`);
    }
    return { id, direction, list, kind, value } as SnapshotRule;
  });
}

/**
 * 발신 규칙 → Stage 3·7 의 목록. allow 는 허용 비교형(`+tag` 보존), block 주소는 판정형(`+tag` 절단) — 허용은 좁게, 거부는 넓게.
 * **플랫폼 도메인 allow 규칙은 버린다**(검증 L1 — 그 한 줄이 플랫폼의 모든 에이전트를 연다. 콘솔·이전에 이은 세 번째 벽).
 * 수신 방향 행이 섞이면 던진다("받아도 되는 상대" 가 "보내도 되는 상대" 로 새지 않게).
 */
export function resolveOutboundRules(
  rules: readonly SnapshotRule[],
  /** 요청 출처 규칙 id — **필수**(기본값 없음: 빠뜨린 호출자가 요청 규칙을 소유자 규칙으로 읽어 위험 보류 면제를 주지 않게). 없으면 `[]` 를 명시한다. */
  agentRequestedRuleIds: readonly string[],
): { readonly allowlist: readonly string[]; readonly blocklist: readonly string[]; readonly agentRequestedAllowlist: readonly string[] } {
  const requested = new Set(agentRequestedRuleIds);
  const allowlist: string[] = [];
  const agentRequestedAllowlist: string[] = [];
  const blocklist: string[] = [];
  for (const rule of rules) {
    if (rule.direction !== 'outbound') throw new PolicyShapeError(`발신 정책에 ${rule.direction} 규칙이 섞였다 (rule=${rule.id})`);
    if (rule.list === 'allow') {
      if (rule.kind === 'domain' && isPlatformDomainRule(rule.value)) continue;
      allowlist.push(rule.kind === 'address' ? comparableAddress(rule.value) : rule.value);
      if (rule.kind === 'address' && requested.has(rule.id)) agentRequestedAllowlist.push(comparableAddress(rule.value));
    } else blocklist.push(rule.kind === 'address' ? normalizeAddress(rule.value) : rule.value);
  }
  return { allowlist, blocklist, agentRequestedAllowlist };
}

/**
 * 정책 행 + 버전 행 → 확정된 정책. `outbound_mode` 와 목록은 **버전 스냅샷**에서 온다 — 감사에 남는 `policy_version` 과
 * 판정 근거가 갈라지지 않게(§4.3). `config_json.allowlist/blocklist` 는 판정에 들어오지 않는다.
 */
export function resolvePolicy(
  policy: AgentPolicyRow,
  policyVersion: PolicyVersionRow,
  /** 요청 출처 규칙 id(`PolicySourceResult.agentRequestedRuleIds`). 관문 판정 밖의 읽기(표시 · 검증)만 비워 둔다. */
  agentRequestedRuleIds: readonly string[],
): ResolvedPolicy {
  if (policyVersion.version !== policy.current_version) {
    throw new PolicyShapeError(
      `policy_versions.version(${policyVersion.version}) 이 agent_policies.current_version(${policy.current_version}) 과 다르다`,
    );
  }

  const outboundRules = snapshotContactRules(policyVersion.snapshot).filter((rule) => rule.direction === 'outbound');
  const { allowlist, blocklist, agentRequestedAllowlist } = resolveOutboundRules(outboundRules, agentRequestedRuleIds);
  return {
    agentId: policy.agent_id,
    outboundMode: policyVersion.outbound_mode,
    version: policyVersion.version,
    versionId: policyVersion.id,
    limits: resolveLimits(policy.limits),
    content: resolveContentPolicy(policy.config_json),
    allowlist,
    agentRequestedAllowlist,
    blocklist,
    preApproval: resolvePreApprovalRules(policy.config_json),
    approvalTtlSeconds: resolveApprovalTtlSeconds(policy.config_json),
    // 좁은 쪽 — 행·스냅샷 중 하나라도 참이면 승인(옛 스냅샷에는 칸이 없다 = auto).
    sendApproval: policy.require_approval || policyVersion.snapshot['require_approval'] === true ? 'always' : 'auto',
  };
}

// ---------------------------------------------------------------------------
// 조립
// ---------------------------------------------------------------------------

/**
 * 승인된 요청의 릴리스 표지(§4.3) — id 두 개뿐, "승인됐다" 는 주장은 없다. `approved` 여부는 로더가 DB 에서 읽고,
 * 관문은 `auditId` 의 대기 행을 갱신한다.
 */
export interface ReleaseBinding {
  readonly approvalId: string;
  readonly auditId: string;
}

/** 관문이 로더에게 넘기는 이번 시도. */
export interface LoadRequest {
  readonly agentId: AgentId;
  readonly attempt: OutboundAttempt;
  readonly now: Date;
  readonly traceId: string | null;
  /** 이번 시도의 예상 비용(센트). */
  readonly thisAttemptCostCents: number;
  /** 릴리스면 그 요청, 아니면 `null`(optional 이 아니다 — 모든 호출자가 적는다). */
  readonly release: ReleaseBinding | null;
}

/**
 * 관계 행 → 수신자별 매칭 — 스코프 매칭은 여기 한 곳에서만 한다. `thread` 스코프는 **검증된** 스레드 id 로만 맞춘다.
 * 주소는 허용 비교형으로 정확히 맞춘다(판정형이면 `sales+eu@` 의 관계가 모든 `sales+*` 를 덮는다 — 검증 V1 MINOR-2).
 */
export function matchRelationships(
  rows: readonly SenderRelationshipRow[],
  recipients: readonly string[],
  threadId: string | null,
): readonly RelationshipMatch[] {
  const matches: RelationshipMatch[] = [];
  for (const recipient of recipients) {
    const domain = recipient.slice(recipient.lastIndexOf('@') + 1);
    for (const row of rows) {
      const hit =
        row.scope === 'recipient'
          ? row.address !== null && comparableAddress(row.address) === recipient
          : row.scope === 'domain'
            ? row.domain !== null && row.domain.toLowerCase() === domain
            : threadId !== null &&
              row.thread_id === threadId &&
              row.address !== null &&
              comparableAddress(row.address) === recipient;
      if (hit) matches.push({ recipient, trustCategory: row.trust_category, scope: row.scope });
    }
  }
  return matches;
}

/** 릴리스 grant — `approved` 이고 같은 에이전트의 요청일 때만. 그 밖은 `null`(만료된 요청의 발송을 닫는다 — AC-i4). */
export function resolveApprovalGrant(
  source: ApprovalGrantSource | null,
  agentId: AgentId,
): ApprovalGrant | null {
  if (source === null) return null;
  const { request } = source;
  // 승인자 없는 `approved` 는 DB CHECK 가 막지만 한 번 더 좁힌다 — "누가 허락했는가" 에 답할 수 없는 릴리스는 없다.
  if (request.status !== 'approved' || request.agent_id !== agentId || request.decided_by === null) return null;
  return {
    approvalId: request.id,
    // 허용 비교형 — 사람이 본 봉투의 주소만 덮는다.
    recipients: source.recipients.map(comparableAddress),
    approvedBy: request.decided_by,
  };
}

/**
 * **허용 비교형** 주소 — 소문자화만, `+tag` 를 자르지 않는다(허용은 좁게). 허용 쪽의 모든 매칭(관계·grant·allowlist·스레드 발신자)과
 * 그 저장(`approval/service.ts`·`identity/seed-contacts.ts`)이 이 형태다 — 둘이 갈라지면 막히거나 본 적 없는 주소가 통과한다.
 */
export function comparableAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * **스레드 회신인가 — 로더만 답한다**(P3b). 시도의 `threadId` 는 주장이다. 전부 참일 때만 검증된 회신:
 *   ① 그 스레드가 이 에이전트의 것이고 id 가 주장과 같다(소스를 믿지 않는다) ② 인증된 수신 메일이 있다
 *   ③ 수신자 전원이 그 스레드의 인증된 발신자다(제3자를 끼운 시도는 승인 쪽으로 떨어진다).
 * 비교는 허용 비교형(`+tag` 보존) — `bob+x@` 가 `bob@` 의 스레드 권한을 빌리지 못하게.
 */
export function resolveThreadReply(
  source: ThreadSource | null,
  agentId: AgentId,
  claimedThreadId: string | null,
  rawRecipients: readonly string[],
): VerifiedThreadReply | null {
  if (claimedThreadId === null || source === null) return null;
  const { thread, latestAuthenticatedInbound: latest } = source;
  if (thread.id !== claimedThreadId || thread.agent_id !== agentId || latest === null) return null;

  const recipients = rawRecipients.map(comparableAddress);
  const senders = new Set(source.authenticatedSenders.map(comparableAddress));
  if (recipients.length === 0 || !recipients.every((recipient) => senders.has(recipient))) return null;

  const latestSender = comparableAddress(latest.from_address);
  return {
    threadId: thread.id,
    // 리뷰 H2 — `once` 승인 발송이 든 스레드는 에이전트가 연 스레드로 치지 않는다(승인한 것은 그 한 통뿐).
    startedBy: source.onceApproved === true ? 'external' : thread.started_by,
    repliedTo: {
      inboundMessageId: latest.id,
      injectionRisk: latest.injection_risk,
      senderTrust: latest.sender_trust,
      quarantined: latest.quarantined,
      receivedAt: latest.received_at,
      attachmentCount: requireNonNegativeInt(latest.attachment_count, '소스 필드 "attachment_count"'),
      recipientsAreItsSender: recipients.every((recipient) => recipient === latestSender),
    },
  };
}

/** 경로의 사람 승인 필수 표지 — 매니페스트에서만 읽는다(AC-b1). 미등록 id 는 `null`(관문이 `unregistered_route` 로 거부한다). */
export function humanApprovalRequirementOf(routeId: string): HumanApprovalReason | null {
  const route = OUTBOUND_ROUTES.find((candidate) => candidate.id === routeId);
  if (route?.kind !== 'http') return null;
  return route.requiresHumanApproval ?? null;
}

/** 엔진 호출에 필요한 두 값 — 항상 같이 만든다. */
export interface EvaluationInput {
  readonly ctx: EvaluationContext;
  readonly policy: ResolvedPolicy;
}

/** 평가 입력 선적재 — 유일한 I/O 지점. 정규화와 억제 교집합(출처별)을 여기서 한다. */
export async function loadEvaluationInput(
  source: PolicySource,
  request: LoadRequest,
  /** 위험 신호 포트. `null` 이면 위험 보류 없음. 읽기가 던지면 관문이 `evaluation_error` 로 닫는다. */
  riskSignals: RiskSignalSource | null = null,
): Promise<EvaluationInput> {
  // 시도 입력의 수치도 정책 jsonb 와 같은 규율로 검증한다(음수 비용·바이트가 Stage 5·6 을 연다).
  const thisAttemptCostCents = requireNonNegativeInt(request.thisAttemptCostCents, '시도 필드 "thisAttemptCostCents"');

  // 수신자 모양 — 모든 발신 경로의 마지막 공통 지점(검증 M2). 릴리스·예약·전환 공지·회신은 본문 파서를 지나지 않는다.
  // 같은 메일함의 다른 철자(따옴표·끝 점·역슬래시)는 억제·차단의 문자열 비교를 비껴가므로 판정하지 않고 끊는다.
  const malformed = request.attempt.recipients.filter((recipient) => !isOutboundRecipientAddress(recipient));
  if (malformed.length > 0) {
    throw new PolicyShapeError(`시도 수신자가 발신 주소 모양(ASCII dot-atom)이 아니다: ${JSON.stringify(malformed)}`);
  }

  const attempt: OutboundAttempt = {
    routeId: request.attempt.routeId,
    fromAddress: normalizeAddress(request.attempt.fromAddress),
    recipients: request.attempt.recipients.map(normalizeAddress),
    attachments: request.attempt.attachments.map((attachment, index) => ({
      filename: attachment.filename,
      mimeType: normalizeMimeType(attachment.mimeType),
      bytes: requireNonNegativeInt(attachment.bytes, `시도 필드 "attachments[${index}].bytes"`),
    })),
    threadId: request.attempt.threadId,
    // 모르는 값은 `other`(어떤 문도 열지 않는다).
    contentShape: request.attempt.contentShape === 'code_only' ? 'code_only' : 'other',
    // 닫힌 계열만. 모르는 값은 `scan_limit` 으로 접는다 — 모르는 결과를 깨끗하다고 읽지 않는다.
    dlp: normalizeDlpFamilies(request.attempt.dlp),
    // 예약 행에 고정된 오염 맥락(리뷰 H1).
    pinnedTaint: request.attempt.pinnedTaint === true,
  };

  // 허용 판정용 수신자 — `attempt.recipients` 와 같은 순서·길이.
  const allowRecipients = request.attempt.recipients.map(comparableAddress);

  const result = await source.load({
    agentId: request.agentId,
    // 억제(판정형)·관계(허용 비교형) 두 형태를 다 넘긴다 — 넘치게 읽어도 아래에서 다시 거른다.
    recipients: [...new Set([...attempt.recipients, ...allowRecipients])],
    now: request.now,
    threadId: attempt.threadId,
    releaseApprovalId: request.release?.approvalId ?? null,
  });

  const recipientSet = new Set(attempt.recipients);
  const suppressed: string[] = [];
  const sesSuppressed: string[] = [];
  for (const entry of result.suppressions) {
    const address = normalizeAddress(entry.address);
    if (!recipientSet.has(address)) continue;
    if (entry.source === 'ses_account_level') sesSuppressed.push(address);
    else suppressed.push(address);
  }

  const budget: BudgetSnapshot = {
    monthlyBudgetCents: result.agent.monthly_budget_cents,
    monthToDateSpentCents: result.monthToDateSpentCents,
    thisAttemptCostCents,
  };

  // 확인된 스레드로만 스레드 사실과 `thread` 스코프 관계를 싣는다.
  const thread = resolveThreadReply(result.thread, request.agentId, attempt.threadId, request.attempt.recipients);

  const approval: ApprovalContext = {
    recipients: allowRecipients,
    thread,
    relationships: matchRelationships(result.relationships, allowRecipients, thread?.threadId ?? null),
    grant: resolveApprovalGrant(result.approvalGrant, request.agentId),
    bootstrapGrace: {
      agentCreatedAt: result.agent.created_at,
      outboundSentCount: requireNonNegativeInt(result.outboundSentCount, '소스 필드 "outboundSentCount"'),
    },
    // 매니페스트에서만 — DB·호출자 어느 쪽도 바꿀 수 없다.
    humanApprovalRequired: humanApprovalRequirementOf(attempt.routeId),
    // 위험 신호는 별도 포트에서만. 릴리스는 사람이 그 봉투를 승인했다 — 건너뛴다.
    riskHold:
      riskSignals === null || request.release !== null
        ? null
        : resolveRiskHold(
            await riskSignals.load({ agentId: request.agentId, now: request.now }),
            thread?.threadId ?? attempt.threadId,
            request.now,
            attempt.pinnedTaint,
          ),
  };

  // 고객 도메인(ADR-0014) — Stage 0(도메인 정지)·Stage 4(도메인 워밍업)의 입력.
  const { boundDomains, sendingDomain, domainRecipientsLastDay } = resolveBoundDomains(result.addresses, result.customDomains, attempt.fromAddress);

  const ctx: EvaluationContext = {
    now: request.now,
    traceId: request.traceId,
    organization: {
      id: result.organization.id,
      billingStatus: result.organization.billing_status,
      abuseFreeze: result.organization.abuse_freeze,
      ownerPaused: result.organization.owner_paused,
      reviewStatus: result.organization.review_status,
      sendingStartedAt: result.organization.sending_started_at,
      entitlements: resolveEntitlements(result.entitlements, request.now),
    },
    agent: {
      id: result.agent.id,
      status: result.agent.status,
      boundAddresses: result.addresses.map((row) => normalizeAddress(row.address)),
      inactiveAddresses: result.inactiveAddresses.map(normalizeAddress),
      boundDomains,
    },
    attempt,
    suppressedRecipients: suppressed,
    sesSuppressedRecipients: sesSuppressed,
    counters: { ...result.counters, domainRecipientsLastDay },
    budget,
    sendingDomain,
    approval,
  };

  const policy = resolvePolicy(result.policy, result.policyVersion, result.agentRequestedRuleIds);
  // Stage 6 첨부 총량 = min(정책, 요금제, 천장). 요금제 값도 이미 천장으로 잘렸지만 한 번 더 건다.
  const maxAttachmentBytesTotal = Math.min(
    policy.content.maxAttachmentBytesTotal,
    ctx.organization.entitlements.attachmentBytesTotalMax,
    ATTACHMENT_BYTES_TOTAL_CEILING,
  );
  return { ctx, policy: { ...policy, content: { ...policy.content, maxAttachmentBytesTotal } } };
}

/** 시도의 DLP 계열 → 닫힌 집합·순서. 모르는 값이 있으면 `scan_limit` 을 더한다. */
function normalizeDlpFamilies(raw: readonly string[]): OutboundAttempt['dlp'] {
  const known = new Set<string>(DLP_FAMILIES);
  const present = new Set(raw);
  if ([...present].some((family) => !known.has(family))) present.add('scan_limit');
  return DLP_FAMILIES.filter((family) => present.has(family));
}

/**
 * 바인딩 도메인 접기(ADR-0014). `atmark.ai` → `platform`, 고객 도메인 → 행의 상태(없으면 `blocked`). 발신 도메인이 고객 도메인이면
 * 워밍업 입력을 싣는다. 같은 도메인 행이 둘이면 던진다(어느 행을 믿을지 고르지 않는다).
 */
function resolveBoundDomains(
  addresses: readonly AgentAddressRow[],
  customDomains: readonly BoundDomainSource[],
  fromAddress: string,
): { readonly boundDomains: ReadonlyMap<string, DomainGateStatus>; readonly sendingDomain: DomainSnapshot | null; readonly domainRecipientsLastDay: number } {
  const rows = new Map<string, BoundDomainSource>();
  for (const row of customDomains) {
    if (rows.has(row.domain)) throw new PolicyShapeError(`소스가 고객 도메인 행을 두 번 줬다 (domain 행 ${String(customDomains.length)}개)`);
    rows.set(row.domain, row);
  }
  const boundDomains = new Map<string, DomainGateStatus>();
  for (const address of addresses) {
    const domain = address.domain.toLowerCase();
    if (domain === AGENT_ADDRESS_DOMAIN) {
      boundDomains.set(domain, 'platform');
      continue;
    }
    const row = rows.get(domain);
    boundDomains.set(
      domain,
      domainGateStatusOf(row === undefined ? { status: 'missing', suspendedReason: null } : { status: row.status, suspendedReason: row.suspended_reason }),
    );
  }
  const fromDomain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1);
  const sending = fromDomain !== AGENT_ADDRESS_DOMAIN && boundDomains.has(fromDomain) ? rows.get(fromDomain) : undefined;
  if (sending === undefined) return { boundDomains, sendingDomain: null, domainRecipientsLastDay: 0 };
  return {
    boundDomains,
    sendingDomain: { domain: sending.domain, sendingStartedAt: sending.sending_started_at },
    domainRecipientsLastDay: requireNonNegativeInt(sending.recipients_last_day, '소스 필드 "recipients_last_day"'),
  };
}

/** 첨부 총량 천장 25 MiB(요금제 천장·`ATTACHMENT_BYTES_CEILING` 과 같은 값 — 단위 테스트가 대조). base64 후에도 SES raw 40 MB 아래. */
export const ATTACHMENT_BYTES_TOTAL_CEILING = 25 * 1024 * 1024;
