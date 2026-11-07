/**
 * 정책 엔진 테이블 테스트의 공용 픽스처.
 *
 * **기본값은 "전부 통과하는 정상 시도"** 다. 각 테스트는 자기가 검사하는 축 **하나만**
 * 비틀고 나머지는 건드리지 않는다 — 그래야 실패했을 때 "어느 축이 원인인가" 가
 * 케이스 이름에서 바로 읽힌다. 픽스처가 이미 어딘가 위반 상태면, 그 아래 모든 케이스가
 * 실은 Stage 0 에서 끝나면서 통과하고 있어도 아무도 모른다(공허한 통과).
 *
 * **이 파일은 단언을 하지 않는다.** `test/arch/support/project.ts` 와 같은 규약이다.
 */

import { entitlementsOf } from '../../support/entitlements';
import { toAgentId } from '../../../src/db/schema';
import type {
  ApprovalContext,
  BudgetSnapshot,
  DomainSnapshot,
  EvaluationContext,
  OutboundAttempt,
  RepliedInbound,
  ResolvedPolicy,
  SendCounters,
  ThreadStarter,
  VerifiedThreadReply,
} from '../../../src/policy/types';

export const AGENT_ID = toAgentId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
export const ORG_ID = '11111111-1111-4111-8111-111111111111';
export const POLICY_VERSION_ID = '22222222-2222-4222-8222-222222222222';

export const AGENT_ADDRESS = 'agent@atmark.ai';
export const ALLOWED_RECIPIENT = 'friend@example.com';
export const STRANGER_RECIPIENT = 'stranger@example.com';

/** 고정 시각. 워밍업 일차·`retry_after` 가 실행 시각에 따라 흔들리면 테이블 테스트가 깜빡인다. */
export const NOW = new Date('2026-10-15T12:00:00.000Z');

/** 워밍업 Day 16+ 구간(캡 1000)의 기준일. 한도 축을 검사하지 않는 케이스가 캡에 걸리면 안 된다. */
export const SENDING_STARTED_AT = new Date('2026-09-01T00:00:00.000Z');

export const baseCounters: SendCounters = {
  agentLastMinute: 0,
  agentLastHour: 0,
  agentLastDay: 0,
  /** **수신자 수**다 (`SendCounters` 규약). 0 이면 이번 시도의 수신자만 캡에 셈된다. */
  orgRecipientsLastDay: 0,
  /** 고객 도메인 발신이 아니다(ADR-0014) — 도메인 캡의 분자 0. */
  domainRecipientsLastDay: 0,
};

export const baseBudget: BudgetSnapshot = {
  monthlyBudgetCents: 10_000,
  monthToDateSpentCents: 0,
  thisAttemptCostCents: 10,
};

export const baseAttempt: OutboundAttempt = {
  routeId: 'fixture_send',
  fromAddress: AGENT_ADDRESS,
  recipients: [ALLOWED_RECIPIENT],
  attachments: [],
  threadId: null,
  contentShape: 'other',
  /** 발신 DLP 적중 없음(ADR-0016) — 계열 축은 `risk-hold-stage7.test.ts` 가 비튼다. */
  dlp: [], pinnedTaint: false,
};

/**
 * 승인 경로 입력의 기본값 — **관계 없음, grant 없음, grace 시계는 오늘 시작**.
 * `approval_required` 를 검사하지 않는 케이스는 이 값을 건드릴 일이 없다(모드가 `allowlist_only`).
 */
export const baseApproval: ApprovalContext = {
  /** 허용 비교형 수신자 — `baseAttempt.recipients` 와 같은 목록이다. 수신자를 비트는 Stage 7 케이스는 둘을 같이 비튼다. */
  recipients: [ALLOWED_RECIPIENT],
  /** 스레드 회신 아님 — 로더가 확인한 스레드 사실이 없다. 스레드 축은 `thread-reply.test.ts` 가 비튼다. */
  thread: null,
  relationships: [],
  grant: null,
  bootstrapGrace: { agentCreatedAt: NOW, outboundSentCount: 0 },
  /** 매니페스트 표지 없음 — 기존 경로 전부의 상태. 표지 축은 `transition-marker.test.ts` 가 비튼다. */
  humanApprovalRequired: null,
  /** 위험 신호 없음(로더가 포트를 부르지 않은 상태 — 릴리스·대역). 위험 축은 `risk-hold-stage7.test.ts` 가 비튼다. */
  riskHold: null,
};

export const THREAD_ID = '33333333-3333-4333-8333-333333333333';

/**
 * 로더가 확인한 스레드 회신 — 기본값은 **모든 전제가 참인** 답장 대상(판정 none · 격리 아님 · seen · 1시간 전 수신 ·
 * 수신자 = 그 발신자 · 첨부 없음). 각 테스트는 한 축만 비튼다.
 */
export function verifiedThread(
  startedBy: ThreadStarter,
  repliedTo: Partial<RepliedInbound> = {},
): VerifiedThreadReply {
  return {
    threadId: THREAD_ID,
    startedBy,
    repliedTo: {
      inboundMessageId: '55555555-5555-4555-8555-555555555555',
      injectionRisk: 'none',
      senderTrust: 'seen',
      quarantined: false,
      receivedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      attachmentCount: 0,
      recipientsAreItsSender: true,
      ...repliedTo,
    },
  };
}

/** 아무 Stage 에도 걸리지 않는 시도. */
export const baseContext: EvaluationContext = {
  now: NOW,
  traceId: 'trace-fixture',
  organization: {
    id: ORG_ID,
    billingStatus: 'active',
    abuseFreeze: false,
    ownerPaused: false,
    reviewStatus: 'active',
    sendingStartedAt: SENDING_STARTED_AT,
    entitlements: entitlementsOf('beta'),
  },
  agent: {
    id: AGENT_ID,
    status: 'active',
    boundAddresses: [AGENT_ADDRESS],
    /** 쓸 수 없는 이 에이전트의 주소 없음(폐기 별칭 · 잠든 앵커 — ADR-0014 개정). Stage 1 의 `from_inactive` 축은 단계 3 테스트가 비튼다. */
    inactiveAddresses: [],
    /** 바인딩 도메인은 `atmark.ai` 하나(`platform` — 도메인 축 없음, ADR-0014). 도메인 축은 단계 3 테스트가 비튼다. */
    boundDomains: new Map([['atmark.ai', 'platform']]),
  },
  attempt: baseAttempt,
  suppressedRecipients: [],
  sesSuppressedRecipients: [],
  counters: baseCounters,
  budget: baseBudget,
  /** `atmark.ai` 발신 — 도메인 워밍업 입력 없음(ADR-0014). */
  sendingDomain: null,
  approval: baseApproval,
};

/** `allowlist_only` + 수신자가 목록 안. P1a demo 와 같은 모드다(§4.4). */
export const basePolicy: ResolvedPolicy = {
  agentId: AGENT_ID,
  outboundMode: 'allowlist_only',
  version: 1,
  versionId: POLICY_VERSION_ID,
  limits: {
    perMinute: 10,
    perHour: 100,
    perDay: 500,
    recipientsPerMessage: 10,
  },
  content: {
    maxAttachmentBytesTotal: 5_000_000,
    allowedMimeTypes: ['application/pdf', 'text/plain'],
  },
  allowlist: [ALLOWED_RECIPIENT],
  agentRequestedAllowlist: [],
  blocklist: [],
  preApproval: { autoApproveReplyWithinThread: true, autoApproveDomains: [], autoApproveVerificationSenders: false },
  approvalTtlSeconds: 24 * 60 * 60,
  sendApproval: 'auto',
};

/** 배열에는 재귀하지 않는다 — 재귀하면 `readonly string[]` 이 `(string|undefined)[]` 가 된다. */
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** 축 하나만 비튼 컨텍스트. 중첩 한 겹까지만 병합한다 — 더 깊으면 픽스처가 읽기 어려워진다. */
export function contextWith(overrides: {
  readonly organization?: Partial<EvaluationContext['organization']>;
  readonly agent?: Partial<EvaluationContext['agent']>;
  readonly attempt?: Partial<OutboundAttempt>;
  readonly counters?: Partial<SendCounters>;
  readonly budget?: Partial<BudgetSnapshot>;
  readonly suppressedRecipients?: readonly string[];
  readonly sesSuppressedRecipients?: readonly string[];
  readonly approval?: Partial<ApprovalContext>;
  readonly sendingDomain?: DomainSnapshot | null;
  readonly now?: Date;
}): EvaluationContext {
  return {
    ...baseContext,
    now: overrides.now ?? baseContext.now,
    organization: { ...baseContext.organization, ...overrides.organization },
    agent: { ...baseContext.agent, ...overrides.agent },
    attempt: { ...baseContext.attempt, ...overrides.attempt },
    counters: { ...baseContext.counters, ...overrides.counters },
    budget: { ...baseContext.budget, ...overrides.budget },
    sendingDomain: overrides.sendingDomain === undefined ? baseContext.sendingDomain : overrides.sendingDomain,
    suppressedRecipients: overrides.suppressedRecipients ?? baseContext.suppressedRecipients,
    sesSuppressedRecipients: overrides.sesSuppressedRecipients ?? baseContext.sesSuppressedRecipients,
    approval: {
      ...baseContext.approval,
      // 시도의 수신자를 비틀면 허용 비교형도 같이 비튼다 — 픽스처 주소는 이미 소문자·태그 없음이라 두 형태가 같다.
      // `+tag` 축을 보는 케이스는 `approval.recipients` 를 직접 준다.
      recipients: overrides.attempt?.recipients ?? baseContext.approval.recipients,
      ...overrides.approval,
    },
  };
}

export function policyWith(overrides: DeepPartial<ResolvedPolicy>): ResolvedPolicy {
  return {
    ...basePolicy,
    ...(overrides as Partial<ResolvedPolicy>),
    limits: { ...basePolicy.limits, ...overrides.limits },
    content: { ...basePolicy.content, ...overrides.content },
    preApproval: { ...basePolicy.preApproval, ...(overrides.preApproval as Partial<ResolvedPolicy['preApproval']>) },
  };
}
