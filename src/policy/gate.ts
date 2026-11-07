/**
 * **유일한 발송 경로**(계획 §4.2, §4.5, AC-8). 순서: 평가 → lease → audit → 전송.
 *
 * audit 1행을 언제 쓰는가(§4.3 · §4.5-5):
 *   - **거부·승인 대기**는 lease 가 없다 — 평가 직후가 종단이므로 그때 1행을 쓴다.
 *   - **허용**은 **lease 를 얻은 워커만** 1행을 쓴다. 그래야 SQS 재전달이 audit 을 늘리지 않고(AC-i1), 해소되지 않은
 *     `allowed` 행의 뜻이 하나로 확정된다: "전송 중에 죽었다". lease 앞에서 쓰면 "중복이라 안 보냈다" 와 구별되지 않는다.
 *
 * 승인 요청도 여기서 연다 — `pending_approval` audit 행과 `ApprovalRequest` 가 같은 `record` 한 번(한 트랜잭션)으로 쓰인다
 * (`audit_logs.approval_id` 는 갱신 불가이고, 관문 밖에서 열면 요청 없는 영구 대기 행이 생긴다). 릴리스(`request.release`)는
 * 같은 평가를 거친 뒤 새 행 대신 그 대기 행을 갱신한다(`reserveRelease`).
 */

import { randomUUID } from 'node:crypto';

import { toAgentId, TERMINAL_OUTBOUND_MESSAGE_STATUSES, type MessageStatus } from '../db/schema';
import { log } from '../observability/logger';
import { ALARM_LOG_EVENTS, countMetric, emitMetric, METRIC_NAMES } from '../observability/metrics';
import { evaluate } from './engine';
import { OUTBOUND_ROUTES } from './manifest';
import { planReleaseRetry, releaseWindowClosed, type ReleaseDeferral } from './release-deferral';
import {
  loadEvaluationInput,
  type EvaluationInput,
  type LoadRequest,
  type PolicySource,
  type ReleaseBinding,
} from './policy-loader';
import type { RiskSignalSource } from './risk-signals';
import { applyRiskHold, RISK_HOLD_REASONS, riskHoldInputOf, riskHoldReasons } from './rules/risk-hold';
import {
  deny,
  toDeniedDecision,
  type AgentId,
  type ApprovalGrant,
  type Decision,
  type PolicyStamp,
} from './types';

// ---------------------------------------------------------------------------
// 협력자 인터페이스
// ---------------------------------------------------------------------------

/**
 * `pending_approval` 판정과 **같은 트랜잭션에서** 여는 승인 요청(§3.4 · §4.3). `audit_logs.approval_id` 는 갱신 불가라
 * 나중에 붙일 수 없고, 요청을 따로 먼저 만들면 audit INSERT 실패 시 행 없는 요청이 남는다.
 */
export interface PendingApprovalOpening {
  /** 관문이 정한다(배치면 라우트가 정한 공유 id). */
  readonly approvalId: string;
  /**
   * `'message'` = 시도 1건당 요청 1건. `'batch'` = 시도 N건이 요청 1건을 공유(§3.2 전환 공지, AC-b1) — 항목은 같은 에이전트의
   * `pending` 배치 요청에만 붙는다(`audit-sink.ts` — 결정된 요청에 사람이 못 본 봉투를 덧붙이지 못하게).
   */
  readonly subject: 'message' | 'batch';
  /** 평가 시각. `expiresAt` 과 같은 시계여야 DB 의 TTL 범위 CHECK 가 흔들리지 않는다. */
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** 승인 뒤 릴리스가 관문을 재통과할 봉투 — 사람이 본 그대로(원본 주소). 정규화는 재평가 때 로더가 한다. */
  readonly envelope: {
    readonly fromAddress: string;
    readonly recipients: readonly string[];
    readonly isThreadReply: boolean;
    readonly threadId: string | null;
    readonly costCents: number;
  };
}

/** audit 행 1개(§4.3: 발송 시도당 정확히 1행). 릴리스는 같은 행 갱신이다. */
export interface AuditEntry {
  readonly agentId: AgentId;
  readonly messageId: string | null;
  readonly decision: Decision;
  readonly traceId: string | null;
  readonly latencyMs: number;
  /** `pending_approval` 일 때만 값이 있다. */
  readonly approval: PendingApprovalOpening | null;
}

/** 릴리스가 갱신할 `pending_approval` 행의 좌표. 세 값이 전부 맞아야 갱신된다. */
export interface PendingAuditTarget {
  readonly auditId: string;
  readonly approvalId: string;
  readonly messageId: string;
}

/**
 * 릴리스 재평가의 결말 — 같은 행에 적는다(§4.3).
 * - `released`: `allowed` + `approved_by`. **`resolved_at` 은 비워 둔다** — 찍으면 전송 결과(`resolve` 의
 *   `WHERE resolved_at IS NULL`)가 0행이 되어 나간 메일의 결과가 audit 에 남지 않는다.
 * - `denied`: 재평가가 거부했다. `reasons[]`·`policy_version` 은 최초 값 그대로(트리거) — 근거는 `resolution_reason` 에.
 */
export type PendingResolution =
  | { readonly kind: 'released'; readonly approvedBy: string }
  | { readonly kind: 'denied'; readonly reason: string };

export interface AuditSink {
  /** 시도 1건당 1행을 쓰고 id 를 돌려준다. `entry.approval` 이 있으면 승인 요청·항목을 같은 트랜잭션에서 연다. */
  record(entry: AuditEntry): Promise<string>;
  /** 릴리스 결말을 `pending_approval` 행에 적는 조건부 UPDATE. 0행이면 `false`(이미 해소됐다). */
  resolvePending(target: PendingAuditTarget, resolution: PendingResolution): Promise<boolean>;
  /** 전송 결과로 같은 행을 갱신한다. 두 값뿐이다 — 중복 억제된 재전달은 애초에 행을 쓰지 않는다(AC-i1). */
  resolve(auditId: string, outcome: 'sent' | 'failed', reason: string | null): Promise<void>;
}

/** §4.5-3 의 조건부 UPDATE lease — 중복 SQS 전달이 여기서 죽는다. */
export interface LeaseRequest {
  readonly messageId: string;
  readonly leaseId: string;
  readonly now: Date;
  readonly ttlSeconds: number;
}

export interface LeaseStore {
  /** `pending` 또는 만료된 `dispatching` 행만 `dispatching` 으로 올린다. 0행이면 `false`(다른 워커가 잡았다). */
  acquire(request: LeaseRequest): Promise<boolean>;
  /** 현재 상태. 종단 상태면 lease 를 시도조차 하지 않는다. */
  statusOf(messageId: string): Promise<MessageStatus>;
}

export interface TransportRequest {
  readonly messageId: string;
  /** 전송 전에 생성·저장된 값(§4.5-4) — 재시도가 같은 값으로 나가야 수신측이 병합한다. */
  readonly messageIdHeader: string;
  readonly fromAddress: string;
  readonly recipients: readonly string[];
}

/** 전송 증거 — 이 값을 받은 순간부터 "메일이 나갔다" 는 되돌릴 수 없다(`deliver` 의 성공 경로가 try 밖인 이유). */
export interface TransportResult {
  readonly sesMessageId: string;
}

export interface OutboundTransport {
  send(request: TransportRequest): Promise<TransportResult>;
}

// ---------------------------------------------------------------------------
// 이벤트 평면 — "그 메일은 나갔는가" (ADR-0004)
// ---------------------------------------------------------------------------

/** 이벤트 평면의 전송 증거. `eventType` 은 로그에만 쓰므로 열린 `string` 이다(관문이 메일 구현의 어휘를 import 하지 않는다). */
export interface SendEvidence {
  /** `'send'` 또는 `'delivery'` — 어느 쪽이든 메일은 나갔다. */
  readonly eventType: string;
  /** SES id. 없으면 행을 `sent` 로 확정할 수 없다. */
  readonly sesMessageId: string | null;
}

/**
 * lease 만료 재전송 직전에 묻는 곳(ADR-0004 결정 2). **조회 실패는 던져라** — `null`("이벤트 없음")은 곧 재전송이고,
 * "DB 가 잠깐 느렸다" 가 중복 발송의 원인이 되면 안 된다. 관문은 예외와 `null` 을 다르게 다룬다.
 */
export interface SendEvidenceLookup {
  findSendEvidence(messageId: string): Promise<SendEvidence | null>;
}

/** 항상 던지는 전송단(테스트 대역). 조용히 성공하는 스텁이면 "SES 호출 0회" 단언이 아무것도 증명하지 못한다. */
export function unavailableTransport(): OutboundTransport {
  return {
    send(request: TransportRequest): Promise<TransportResult> {
      return Promise.reject(
        new Error(`P1a 에는 전송단이 없다 (messageId=${request.messageId}). P1b 에서 ses-transport 가 들어온다.`),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 평가~lease 구간의 직렬화(R22)
// ---------------------------------------------------------------------------

/**
 * 직렬화 자체가 실패했다 — 잠그지 못한 채 보내지 않는다(관문이 `evaluation_error` 로 바꾼다). 관문은 **이 타입만** 받는다 —
 * `reserve` 안의 예외(audit INSERT 실패 등)까지 삼키면 행 없는 거부, 즉 조용한 거부가 된다(Principle P3).
 */
export class SerializationUnavailableError extends Error {
  constructor(message: string, options?: { readonly cause: unknown }) {
    super(message, options);
    this.name = 'SerializationUnavailableError';
  }
}

/**
 * **평가~lease 구간을 조직 단위로 직렬화한다**(R22). 이 구간은 check-then-act 다 — 카운터는 `dispatching`·`sent` 만 세므로
 * 동시 진행 중인 시도가 보이지 않고, lease 를 잡은 뒤에야 카운터에 들어간다. 잠금이 없으면 캡 20·현재 19 에서 동시 요청 N 개가
 * 전부 통과한다. 캡이 조직 단위라 잠금도 조직 단위다. 전송은 구간 밖이다 — lease 를 잡은 행은 이미 카운터에 들어가 있다.
 */
export interface DispatchSerializer {
  serialize<T>(agentId: AgentId, run: () => Promise<T>): Promise<T>;
}

/** 직렬화하지 않는 구현 — 인메모리 테스트·단일 시도 데모 전용. 운영은 `createPostgresOutboundSerializer`(없으면 캡은 순차 실행에서만 성립). */
export function unserialized(): DispatchSerializer {
  return {
    serialize<T>(_agentId: AgentId, run: () => Promise<T>): Promise<T> {
      return run();
    },
  };
}

export interface GateDependencies {
  readonly source: PolicySource;
  readonly audit: AuditSink;
  readonly leases: LeaseStore;
  readonly transport: OutboundTransport;
  /** 평가~lease 구간의 조직 단위 직렬화(R22). */
  readonly serializer: DispatchSerializer;
  /**
   * lease TTL(ADR-0004). 300초는 정상 `Send` 이벤트 지연(초 단위)에 두 자릿수 여유를 준다. 소비자가 죽은 경우는 TTL 을 올려도
   * 못 덮고, 올리면 죽은 발송이 그만큼 인질이 된다(AC-i3) — 소비자 정지는 감지로 다룬다(`mail/events/health.ts`).
   */
  readonly leaseTtlSeconds: number;
  /**
   * "그 메일은 나갔는가" 를 물을 곳(ADR-0004 결정 2). optional 인 근거는 부재의 방향이다 — 없으면 재전송하지 않는다
   * (`unknown` → 유보, error 로그). 미배선은 막히는 쪽으로 실패한다.
   */
  readonly sendEvidence?: SendEvidenceLookup;
  /**
   * 위험 신호(ADR-0016 A — 별도 포트). 여기서는 optional 이고 발송 서비스(`OutboundServiceDependencies.riskSignals`)에서 필수다 —
   * 운영 조립 루트에서 타입이 배선을 강제한다. 읽기가 던지면 `evaluation_error`(fail closed).
   */
  readonly riskSignals?: RiskSignalSource;
}

/** 배치 승인의 공유 요청(§3.2 전환 공지, AC-b1) — 라우트가 서버에서 만든 id(요청 본문에서 오지 않는다). */
export interface BatchApprovalBinding {
  readonly approvalId: string;
}

/**
 * 릴리스 시도의 표지 — `ReleaseBinding` + 재시도 창의 끝. `deadlineAt` 이 없으면 일시적 거부를 미루면 무한 재시도,
 * 닫으면 승인분이 영구 종결된다 — 그래서 필수다.
 */
export interface ReleaseAttempt extends ReleaseBinding {
  /** 이 시각 이후의 재평가는 마지막이다 — 일시적 거부도 닫는다. */
  readonly deadlineAt: Date;
}

export interface DispatchRequest extends LoadRequest {
  /** 릴리스면 그 요청과 재시도 창 끝, 아니면 `null`. */
  readonly release: ReleaseAttempt | null;
  /**
   * 배치 승인에 속하면 그 공유 요청. optional — 없으면 시도마다 요청을 연다(사람의 승인이 늘어나는 쪽이라 느슨해지지 않는다).
   * 판정에는 관여하지 않는다.
   */
  readonly batch?: BatchApprovalBinding;
  /** `messages.id`. 행이 없을 수도 있다 — 그때는 `null`. */
  readonly messageId: string | null;
  readonly messageIdHeader: string;
  readonly leaseId: string;
}

export type DispatchOutcome =
  | { readonly kind: 'denied'; readonly decision: Decision }
  /**
   * 승인 대기 — audit 행이 `pending_approval` 로 남아 있다. `approval === null` 이면 릴리스 시도였고 관문은 아무것도 쓰지 않았다:
   *   - `deferral === null`: 요청이 승인 상태가 아니었다.
   *   - `deferral !== null`: 승인됐지만 재평가가 **일시적으로** 거부했다 — `retryAt` 에 다시 지난다. `decision` 은 그 거부 그대로다.
   * 이 변형에서 `finalizeOutbound` 는 행을 확정하지 않으므로 재예약된 릴리스를 `denied` 로 굳히는 경로가 없다.
   */
  | {
      readonly kind: 'pending_approval';
      readonly decision: Decision;
      readonly approval: { readonly approvalId: string; readonly expiresAt: Date } | null;
      readonly deferral: ReleaseDeferral | null;
    }
  | { readonly kind: 'sent'; readonly decision: Decision; readonly sesMessageId: string }
  | { readonly kind: 'failed'; readonly decision: Decision; readonly reason: string }
  /** 다른 워커가 이미 잡았다 — 재전송도 audit 행도 없다(§4.5-3). */
  | { readonly kind: 'duplicate_suppressed'; readonly decision: Decision };

/**
 * 정책을 읽기도 전에 실패한 시도의 스탬프 — 둘 다 `null`. DB CHECK `audit_logs_policy_stamp_presence` 가 이를
 * `denied` + `evaluation_error` 로 좁히므로, 정책을 못 읽은 시도도 audit 행을 남긴다(조용한 거부 없음 — Principle P3).
 * `0`·`''` 이 아닌 이유: "버전 0 이 있었다" 로 읽히고, uuid 칸에 빈 문자열은 들어가지 않는다.
 */
const UNRESOLVED_POLICY_STAMP = (now: Date): PolicyStamp => ({
  policyVersion: null,
  policyVersionId: null,
  evaluatedAt: now,
});

/** 잠금 구간이 끝난 시점의 상태. `reserved` = lease 와 audit 행을 쥐었다 — 남은 것은 잠금 밖의 전송뿐. */
type Reservation =
  | { readonly kind: 'settled'; readonly outcome: DispatchOutcome }
  | {
      readonly kind: 'reserved';
      readonly messageId: string;
      readonly auditId: string;
      readonly decision: Decision;
    };

/**
 * 관문 — 직렬화(평가 → lease → audit) → 전송. **예외를 삼켜 통과시키는 경로는 없다**(§4.2) — `evaluate` 가 던지면
 * `denied` + `evaluation_error`. 잠금은 평가 전에 잡고 lease 취득 직후에 푼다(R22).
 */
export async function dispatch(
  deps: GateDependencies,
  request: DispatchRequest,
): Promise<DispatchOutcome> {
  const startedAt = Date.now();
  const agentId = toAgentId(request.agentId);

  const outcome = await settle(deps, request, agentId, startedAt);

  // 관측은 결말이 확정된 뒤, 모든 try 밖에서 한 번 — 경로마다 흩으면 빠지는 경로가 생기고, 발송 성공 직후의 try 안으로
  // 들어가면 기록 실패가 결말을 뒤집는다. `observeAttempt` 는 던지지 않는다.
  observeAttempt(request, agentId, outcome, Date.now() - startedAt);

  return outcome;
}

/** `dispatch` 의 본체 — 결말을 만든다. 관측하지 않는다. */
async function settle(
  deps: GateDependencies,
  request: DispatchRequest,
  agentId: AgentId,
  startedAt: number,
): Promise<DispatchOutcome> {
  let reservation: Reservation;
  try {
    reservation = await deps.serializer.serialize(agentId, () =>
      reserve(deps, request, agentId, startedAt),
    );
  } catch (error) {
    // 직렬화 실패만 받는다 — `reserve` 안의 예외까지 삼키면 행 없는 거부(조용한 거부)가 된다.
    if (!(error instanceof SerializationUnavailableError)) throw error;

    // 알람 3의 유일한 방출 지점 — 잠금 경로가 죽으면 그 조직의 전건이 "정책이 막았다" 와 구별되지 않게 거부된다.
    countMetric(METRIC_NAMES.serializationUnavailable, { route_id: request.attempt.routeId });
    log('error', 'gate.serialization_unavailable', {
      route_id: request.attempt.routeId,
      agent_id: agentId,
      message_id: request.messageId,
      trace_id: request.traceId,
      detail: error.message,
    });

    const decision = toDeniedDecision(deny(['evaluation_error']), UNRESOLVED_POLICY_STAMP(request.now));
    // 릴리스는 새 행을 쓰지 않는다 — 기존 대기 행을 미루거나 닫는다(새 행 + denied 면 대기 행이 영원히 남는다).
    if (request.release !== null) return closeOrDeferRelease(deps, request, request.release, decision);
    await recordAudit(deps, request, agentId, decision, startedAt, null);
    return { kind: 'denied', decision };
  }

  if (reservation.kind === 'settled') return reservation.outcome;
  return deliver(deps, request, reservation);
}

/**
 * 잠금 안에서 일어나는 전부 — 평가 → lease → audit. `reserved` 를 돌려주는 순간 행은 `dispatching` 이라 이미 조직 카운터에
 * 들어가 있다 — 잠금을 풀어도 다음 시도가 같은 여유를 두 번 읽지 못한다.
 */
async function reserve(
  deps: GateDependencies,
  request: DispatchRequest,
  agentId: AgentId,
  startedAt: number,
): Promise<Reservation> {
  let input;
  try {
    input = await loadEvaluationInput(deps.source, { ...request, agentId }, deps.riskSignals ?? null);
  } catch {
    // 정책을 읽지 못했다 → 보내지 않지만 행은 남긴다(`UNRESOLVED_POLICY_STAMP`).
    const decision = toDeniedDecision(deny(['evaluation_error']), UNRESOLVED_POLICY_STAMP(request.now));
    // 릴리스는 기존 행 — `settle` 의 잠금 실패와 같은 이유.
    if (request.release !== null) {
      return { kind: 'settled', outcome: await closeOrDeferRelease(deps, request, request.release, decision) };
    }
    await recordAudit(deps, request, agentId, decision, startedAt, null);
    return { kind: 'settled', outcome: { kind: 'denied', decision } };
  }

  const stamp: PolicyStamp = {
    policyVersion: input.policy.version,
    policyVersionId: input.policy.versionId,
    evaluatedAt: request.now,
  };

  // 매니페스트 대조 — 등록되지 않은 경로는 평가하지 않는다(Layer C 의 명제를 런타임에서 한 번 더).
  const route = OUTBOUND_ROUTES.find((candidate) => candidate.id === request.attempt.routeId);
  const decision =
    route === undefined
      ? toDeniedDecision(deny(['unregistered_route']), stamp)
      : safeEvaluate(input.ctx, input.policy, stamp);

  // 위험 보류 관측(ADR-0016) — 강제든 관찰이든 "보류했다/했을 것" 을 센다. 던지지 않는다.
  observeRiskHold(request, agentId, input, decision);

  // 릴리스는 같은 평가를 거친 뒤 새 행 대신 기존 행을 갱신한다.
  if (request.release !== null) {
    return reserveRelease(deps, request, request.release, agentId, decision, input.ctx.approval.grant, startedAt, stamp);
  }

  // 거부는 lease 가 없다 — 평가 직후가 종단이다(§4.3).
  if (decision.verdict === 'denied') {
    await recordAudit(deps, request, agentId, decision, startedAt, null);
    return { kind: 'settled', outcome: { kind: 'denied', decision } };
  }

  // 승인 대기도 lease 가 없다. 요청은 여기(관문 안)서 연다(`PendingApprovalOpening`).
  if (decision.verdict === 'pending_approval') {
    const opening = openApproval(request, input.policy.approvalTtlSeconds);
    await recordAudit(deps, request, agentId, decision, startedAt, opening);
    return {
      kind: 'settled',
      outcome: {
        kind: 'pending_approval',
        decision,
        approval: { approvalId: opening.approvalId, expiresAt: opening.expiresAt },
        deferral: null,
      },
    };
  }

  return acquire(deps, request, agentId, decision, startedAt, null);
}

/**
 * `pending_approval` 판정에 붙일 승인 요청. messages 행이 없으면 던진다 — 릴리스가 lease 를 걸 행이 없고 항목은
 * `message_id NOT NULL` 이다(`prepareOutbound` 를 거치지 않은 호출자의 계약 위반).
 */
function openApproval(request: DispatchRequest, ttlSeconds: number): PendingApprovalOpening {
  if (request.messageId === null) {
    throw new Error('승인 대기 판정에 messages 행이 없다 — 릴리스할 대상이 없는 승인 요청은 열지 않는다.');
  }
  return {
    approvalId: request.batch?.approvalId ?? randomUUID(),
    subject: request.batch === undefined ? 'message' : 'batch',
    createdAt: request.now,
    expiresAt: new Date(request.now.getTime() + ttlSeconds * 1000),
    envelope: {
      fromAddress: request.attempt.fromAddress,
      recipients: request.attempt.recipients,
      // 주장의 기록일 뿐이다 — 릴리스 재평가는 `threadId` 를 로더가 다시 검증한다.
      isThreadReply: request.attempt.threadId !== null,
      threadId: request.attempt.threadId,
      costCents: request.thisAttemptCostCents,
    },
  };
}

/**
 * **릴리스 — 승인된 요청의 시도가 관문을 다시 지난다**(§4.3). 승인은 "이 상대에게 보내도 된다" 이지 "그 사이 무슨 일이
 * 있었든 보내라" 가 아니다 — Stage 0~6 이 전부 다시 돌고, grant 는 Stage 7 의 질문 하나에만 답한다.
 *   - grant 없음(대기·거절·만료) → 아무것도 쓰지 않는다(만료된 요청의 발송을 닫는다 — AC-i4).
 *   - 일시적 거부 → 쓰지 않고 미룬다(`release-deferral.ts`). 영구 종결하면 승인한 메일이 조용히 안 나간다.
 *   - 영구 거부·창 끝 → 같은 행을 `release_denied:<첫 사유>` 로 닫는다(요청은 `approved` 그대로 — 막은 것은 시스템이다).
 *   - 허용인데 창이 닫혔다(창 끝 + 유예) → `release_window_expired` 로 닫는다(멈췄던 워커가 사흘 뒤 승인분을 내보내지 않게 — V1 MINOR-1).
 *   - 허용 → lease → 같은 행을 `allowed`(+`approved_by`)로 → 전송.
 */
async function reserveRelease(
  deps: GateDependencies,
  request: DispatchRequest,
  release: ReleaseAttempt,
  agentId: AgentId,
  decision: Decision,
  grant: ApprovalGrant | null,
  startedAt: number,
  stamp: PolicyStamp,
): Promise<Reservation> {
  // grant 가 있는데 승인 대기면 봉투가 사람이 본 것과 다르다 — 어느 쪽이든 허락의 근거가 없다.
  if (grant === null || decision.verdict === 'pending_approval') {
    return { kind: 'settled', outcome: { kind: 'pending_approval', decision, approval: null, deferral: null } };
  }

  if (decision.verdict === 'denied') {
    return { kind: 'settled', outcome: await closeOrDeferRelease(deps, request, release, decision) };
  }

  if (releaseWindowClosed(request.now, release.deadlineAt)) {
    const expired = toDeniedDecision(deny(['release_window_expired']), stamp);
    return { kind: 'settled', outcome: await closeOrDeferRelease(deps, request, release, expired) };
  }

  const target = releaseTarget(request, release);
  return acquire(deps, request, agentId, decision, startedAt, { target, approvedBy: grant.approvedBy });
}

/** 릴리스가 갱신할 대기 행의 좌표. 릴리스는 항상 기존 messages 행을 가리킨다. */
function releaseTarget(request: DispatchRequest, release: ReleaseAttempt): PendingAuditTarget {
  if (request.messageId === null) {
    throw new Error('릴리스에 messages 행이 없다 — 릴리스는 항상 기존 행을 가리킨다.');
  }
  return { auditId: release.auditId, approvalId: release.approvalId, messageId: request.messageId };
}

/**
 * 릴리스가 거부됐다 — 미루거나(아무것도 쓰지 않음, 워커가 `retryAt` 에 다시 부른다) 닫는다(같은 행을 `release_denied:<첫 사유>`).
 * 판정은 `planReleaseRetry` 한 곳. 거부 경로(재평가·정책 읽기·잠금·lease 저장소 실패)가 여럿이라도 규칙은 여기 하나다.
 */
async function closeOrDeferRelease(
  deps: GateDependencies,
  request: DispatchRequest,
  release: ReleaseAttempt,
  decision: Decision,
): Promise<DispatchOutcome> {
  const target = releaseTarget(request, release);
  const deferral = planReleaseRetry(decision, request.now, release.deadlineAt);
  if (deferral !== null) return { kind: 'pending_approval', decision, approval: null, deferral };

  await deps.audit.resolvePending(target, {
    kind: 'denied',
    reason: `release_denied:${decision.reasons[0]}`,
  });
  return { kind: 'denied', decision };
}

/** audit 행 1개를 쓴다 — 관문에서 `record` 를 부르는 자리는 여기 하나다(변이 F 가 이 한 줄을 겨냥한다). */
async function recordAudit(
  deps: GateDependencies,
  request: DispatchRequest,
  agentId: AgentId,
  decision: Decision,
  startedAt: number,
  approval: PendingApprovalOpening | null,
): Promise<string> {
  const auditId = await deps.audit.record({
    agentId,
    messageId: request.messageId,
    decision,
    traceId: request.traceId,
    latencyMs: Date.now() - startedAt,
    approval,
  });
  return auditId;
}

/** 릴리스가 lease 를 쥔 뒤 갱신할 행과 승인자. 일반 시도에서는 `null`. */
interface ReleaseClaim {
  readonly target: PendingAuditTarget;
  readonly approvedBy: string;
}

/**
 * lease 를 쥔 시도의 audit 행 — 일반 시도는 새 행, 릴리스는 기존 행 갱신. `null` 이면 갱신할 행이 없다(보내지 않는다).
 * 릴리스의 lease 만료 재전송에서는 행이 이미 `allowed` 라 갱신 0행이 정상이다 — 같은 행을 쓴다.
 */
async function claimAttemptAudit(
  deps: GateDependencies,
  request: DispatchRequest,
  agentId: AgentId,
  decision: Decision,
  startedAt: number,
  claim: ReleaseClaim | null,
  leaseExpiryResend: boolean,
): Promise<string | null> {
  if (claim === null) return recordAudit(deps, request, agentId, decision, startedAt, null);
  const released = await deps.audit.resolvePending(claim.target, { kind: 'released', approvedBy: claim.approvedBy });
  return released || leaseExpiryResend ? claim.target.auditId : null;
}

/** 평가 예외 → `denied` + `evaluation_error`(§4.2). */
function safeEvaluate(
  ctx: Parameters<typeof evaluate>[0],
  policy: Parameters<typeof evaluate>[1],
  stamp: PolicyStamp,
): Decision {
  try {
    return evaluate(ctx, policy);
  } catch {
    return toDeniedDecision(deny(['evaluation_error']), stamp);
  }
}

/** 허용된 시도의 예약 — lease 를 취득한 뒤 audit 을 쓴다(§4.5-3, §4.5-5). 아직 잠금 안이다. */
async function acquire(
  deps: GateDependencies,
  request: DispatchRequest,
  agentId: AgentId,
  decision: Decision,
  startedAt: number,
  claim: ReleaseClaim | null,
): Promise<Reservation> {
  const { messageId } = request;
  if (messageId === null) {
    // 허용인데 메시지 행이 없다(호출자 계약 위반) — 보내지 않고, 실패한 시도로 행을 쓰고 곧바로 해소한다.
    const auditId = await recordAudit(deps, request, agentId, decision, startedAt, null);
    await deps.audit.resolve(auditId, 'failed', 'missing_message_row');
    return { kind: 'settled', outcome: { kind: 'failed', decision, reason: 'missing_message_row' } };
  }

  let status: MessageStatus;
  let acquired: boolean;
  try {
    status = await deps.leases.statusOf(messageId);
    if ((TERMINAL_OUTBOUND_MESSAGE_STATUSES as readonly MessageStatus[]).includes(status)) {
      // 이미 끝난 메시지 — SQS 재전달이 여기서 죽는다(행은 처음 lease 를 잡은 워커가 이미 썼다).
      return { kind: 'settled', outcome: { kind: 'duplicate_suppressed', decision } };
    }
    acquired = await deps.leases.acquire({
      messageId,
      leaseId: request.leaseId,
      now: request.now,
      ttlSeconds: deps.leaseTtlSeconds,
    });
  } catch (error) {
    return { kind: 'settled', outcome: await leaseUnavailable(deps, request, agentId, decision, startedAt, error) };
  }

  // `dispatching` 행을 잡았다 = 이전 lease 가 만료됐다(이전 시도가 전송 뒤 돌아오지 못했을 수 있다 — AC-i3, ADR-0004).
  const leaseExpiryResend = status === 'dispatching';
  // 진 쪽은 no-op.
  if (!acquired) return { kind: 'settled', outcome: { kind: 'duplicate_suppressed', decision } };

  if (leaseExpiryResend) {
    // lease 를 쥔 뒤에 묻는다 — 먼저 물으면 그 사이 다른 워커가 보낼 수 있다.
    const evidence = await consultSendEvidence(deps, request, messageId);

    if (evidence.kind === 'sent') {
      // 재전송하지 않고 `sent` 로 확정한다(ADR-0004 결정 2). 재전송을 막은 사실이 남도록 audit 행은 쓴다.
      const auditId = await claimAttemptAudit(deps, request, agentId, decision, startedAt, claim, true);
      if (auditId !== null) await resolveSent(deps, request, auditId, messageId, evidence.sesMessageId);
      return {
        kind: 'settled',
        outcome: { kind: 'sent', decision, sesMessageId: evidence.sesMessageId },
      };
    }

    if (evidence.kind === 'unknown') {
      // 모른다 → 유보한다. 조회 실패를 "이벤트 없음" 으로 읽으면 곧 재전송(중복 발송)이다. 행은 TTL 만큼 다시 잠긴 채
      // `dispatching`("아직 모른다")으로 남고, audit 행도 쓰지 않는다(미해소 `allowed` 의 뜻을 흐리지 않게).
      return { kind: 'settled', outcome: { kind: 'duplicate_suppressed', decision } };
    }
    // `none` — 증거 없음. AC-i3 대로 재전송한다.
  }

  // §4.5-5 의 "lease 취득 시점" — 이 뒤로 미해소 `allowed` 행의 뜻은 "전송 도중에 죽었다" 하나다.
  const auditId = await claimAttemptAudit(deps, request, agentId, decision, startedAt, claim, leaseExpiryResend);
  if (auditId === null) {
    // 릴리스가 lease 를 쥐었는데 갱신할 대기 행이 없다(정상 경로에서는 오지 않는다). 무엇이 해소했는지 모르는 채 보내지 않는다.
    return {
      kind: 'settled',
      outcome: { kind: 'failed', decision, reason: 'approval_release_audit_not_pending' },
    };
  }

  return { kind: 'reserved', messageId, auditId, decision };
}

/**
 * lease 저장소가 던졌다 — 보내지 않고 행을 남긴다. 그대로 올리면 messages 행이 audit 없이 `pending` 으로 영원히 남는다.
 * 일반 시도는 `denied` + `evaluation_error`(스탬프는 그 판정의 것), 릴리스는 미루거나 닫는다. audit INSERT 실패는 그대로 올라간다.
 */
async function leaseUnavailable(
  deps: GateDependencies,
  request: DispatchRequest,
  agentId: AgentId,
  decision: Decision,
  startedAt: number,
  error: unknown,
): Promise<DispatchOutcome> {
  log('error', 'gate.lease_unavailable', {
    route_id: request.attempt.routeId,
    agent_id: agentId,
    message_id: request.messageId,
    trace_id: request.traceId,
    detail: error instanceof Error ? error.message : String(error),
  });
  const failed = toDeniedDecision(deny(['evaluation_error']), {
    policyVersion: decision.policyVersion,
    policyVersionId: decision.policyVersionId,
    evaluatedAt: decision.evaluatedAt,
  });
  if (request.release !== null) return closeOrDeferRelease(deps, request, request.release, failed);
  await recordAudit(deps, request, agentId, failed, startedAt, null);
  return { kind: 'denied', decision: failed };
}

/** 이벤트 평면에 물은 결과 — `none`(재전송해도 좋다)과 `unknown`(보내지 않는다)은 다르다. */
type EvidenceVerdict =
  /** 나갔다. */
  | { readonly kind: 'sent'; readonly sesMessageId: string }
  /** 조회에 성공했고 증거가 없다. */
  | { readonly kind: 'none' }
  /** 답을 얻지 못했다(미배선·조회 실패·id 없는 증거). */
  | { readonly kind: 'unknown' };

/** lease 만료 재전송 직전의 조회. 던지지 않는다. 모든 경로가 로그를 남긴다 — 막은 횟수 0 과 코드가 안 도는 것을 가르기 위해. */
async function consultSendEvidence(
  deps: GateDependencies,
  request: DispatchRequest,
  messageId: string,
): Promise<EvidenceVerdict> {
  const routeId = request.attempt.routeId;

  if (deps.sendEvidence === undefined) {
    // 미배선은 막히는 쪽으로 실패한다(`none` 이면 조용히 무조건 재전송으로 돌아간다).
    log('error', 'gate.send_evidence_unwired', {
      route_id: routeId,
      message_id: messageId,
      trace_id: request.traceId,
      reason: 'evidence_plane_missing',
      detail:
        'sendEvidence 가 주입되지 않았다. lease 만료 재전송을 유보한다 — ' +
        'SES 가 Message-ID 를 덮어쓰므로 이 평면 없이는 "그 메일은 나갔는가" 에 답할 수 없다 (ADR-0004).',
    });
    return { kind: 'unknown' };
  }

  let evidence: SendEvidence | null;
  try {
    evidence = await deps.sendEvidence.findSendEvidence(messageId);
  } catch (error) {
    log('error', 'gate.send_evidence_unavailable', {
      route_id: routeId,
      message_id: messageId,
      trace_id: request.traceId,
      reason: 'lookup_failed',
      detail: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'unknown' };
  }

  if (evidence === null) {
    log('info', 'gate.send_evidence_absent', {
      route_id: routeId,
      message_id: messageId,
      trace_id: request.traceId,
      reason: 'no_send_event',
    });
    return { kind: 'none' };
  }

  if (evidence.sesMessageId === null || evidence.sesMessageId === '') {
    // 나갔지만 `sent` 행에 필요한 `ses_message_id` 가 없다 — 확정할 수 없으니 유보(보내지 않는다).
    log('warn', 'gate.send_evidence_incomplete', {
      route_id: routeId,
      message_id: messageId,
      trace_id: request.traceId,
      reason: evidence.eventType,
    });
    return { kind: 'unknown' };
  }

  log('warn', 'gate.resend_suppressed_by_event', {
    route_id: routeId,
    message_id: messageId,
    trace_id: request.traceId,
    ses_message_id: evidence.sesMessageId,
    reason: evidence.eventType,
    outcome: 'sent',
  });
  return { kind: 'sent', sesMessageId: evidence.sesMessageId };
}

/**
 * audit 행을 `sent` 로 해소한다 — **던지지 않고 결말을 뒤집지 않는다**. 메일이 이미 나간 뒤라 어떤 실패도 `failed` 가 되면 안 된다.
 * 실패는 알람(임계 1 — "시도당 정확히 1행" 은 등식이다)으로 올린다. `deliver` 와 이벤트 증거 경로가 같이 쓴다.
 */
async function resolveSent(
  deps: GateDependencies,
  request: DispatchRequest,
  auditId: string,
  messageId: string,
  sesMessageId: string,
): Promise<void> {
  await deps.audit.resolve(auditId, 'sent', null).catch((error: unknown) => {
    countMetric(METRIC_NAMES.auditResolveFailed, { route_id: request.attempt.routeId });
    log('error', 'audit.resolve_failed', {
      route_id: request.attempt.routeId,
      audit_id: auditId,
      message_id: messageId,
      ses_message_id: sesMessageId,
      trace_id: request.traceId,
      detail: error instanceof Error ? error.message : String(error),
    });
  });
}

/** 예약된 시도의 전송 — 잠금 밖이다(SES 왕복을 잠금 안에 두면 캡과 무관한 직렬화 비용만 생긴다). */
async function deliver(
  deps: GateDependencies,
  request: DispatchRequest,
  reservation: Extract<Reservation, { kind: 'reserved' }>,
): Promise<DispatchOutcome> {
  const { messageId, auditId, decision } = reservation;

  // 전송 시도만 try 안에 둔다 — 성공 뒤의 기록은 밖이다(아래).
  let result: TransportResult;
  try {
    result = await deps.transport.send({
      messageId,
      messageIdHeader: request.messageIdHeader,
      fromAddress: request.attempt.fromAddress,
      recipients: request.attempt.recipients,
    });
  } catch (error) {
    // 메일이 나가지 않았다. 여기서는 `failed` 가 참이다.
    const reason = error instanceof Error ? error.message : String(error);
    await deps.audit.resolve(auditId, 'failed', reason).catch(() => undefined);
    return { kind: 'failed', decision, reason };
  }

  // **이 줄 뒤로는 메일이 이미 나갔다 — 어떤 기록 실패도 결말을 뒤집지 못한다.** 기록을 위 try 안에 두면 UPDATE 실패가
  // 나간 메일에 `failed` 를 찍고, 호출자의 재시도가 같은 사람에게 두 번째 메일을 보낸다(§4.5). 해소 실패 시 남는 미해소
  // `allowed` 행의 뜻은 여전히 "전송 이후" 다.
  await resolveSent(deps, request, auditId, messageId, result.sesMessageId);
  return { kind: 'sent', decision, sesMessageId: result.sesMessageId };
}

// ---------------------------------------------------------------------------
// 관측 — 모든 발송이 관문을 지나므로(AC-8) 여기 한 곳만 배선하면 모든 경로가 보인다
// ---------------------------------------------------------------------------

/** 위험 보류 사유인가(`RiskHoldReason` + `reply_only_risk_hold`). */
const RISK_DECISION_REASONS: ReadonlySet<string> = new Set([...RISK_HOLD_REASONS, 'reply_only_risk_hold']);

/**
 * 위험 보류 관측(ADR-0016 — `risk_hold.evaluated`). 위험 신호가 실린 시도마다 한 번: `clear`(사유 없음) · `held`(강제 모드에서
 * 사유가 실렸다) · `observed`(관찰 모드에서 보류했을 판정) · `skipped`(앞 Stage 가 이미 거부). `held`·`observed` 는 에이전트별
 * 알람(`ALARM_LOG_EVENTS.riskHold`) 로그도 남긴다. 사유는 첫 하나만 차원에 싣는다(기수).
 */
function observeRiskHold(request: DispatchRequest, agentId: AgentId, input: EvaluationInput, decision: Decision): void {
  const risk = input.ctx.approval.riskHold;
  if (risk === null) return;
  const routeId = request.attempt.routeId;
  const holdInput = riskHoldInputOf(input.ctx, input.policy, {
    agentTainted: risk.agentTainted,
    threadTainted: risk.threadTainted,
    taintedSenders: risk.taintedSenders,
    dlp: input.ctx.attempt.dlp,
  });
  const [first] = riskHoldReasons(holdInput);
  if (first === undefined) {
    countMetric(METRIC_NAMES.riskHoldEvaluated, { route_id: routeId, outcome: 'clear' });
    return;
  }
  const outcome = risk.enforce
    ? decision.reasons.some((reason) => RISK_DECISION_REASONS.has(reason))
      ? 'held'
      : 'skipped'
    : applyRiskHold(decision, holdInput).kind === 'unchanged'
      ? 'skipped'
      : 'observed';
  // 강제로 찍힌 사유(reply_only 거부 포함)가 있으면 그것, 아니면 위험 보류가 낼 첫 사유.
  const reason = decision.reasons.find((candidate) => RISK_DECISION_REASONS.has(candidate)) ?? first;
  countMetric(METRIC_NAMES.riskHoldEvaluated, { route_id: routeId, outcome, reason });
  if (outcome === 'skipped') return;
  log('warn', ALARM_LOG_EVENTS.riskHold, { route_id: routeId, agent_id: agentId, message_id: request.messageId, trace_id: request.traceId, reason, outcome });
}

/**
 * 시도 하나의 결말을 로그 1줄 + 메트릭으로 방출한다. 던지지 않는다. audit 을 대신하지 않는다 — `message_id` 가 두 평면의 조인 키다.
 */
function observeAttempt(
  request: DispatchRequest,
  agentId: AgentId,
  outcome: DispatchOutcome,
  latencyMs: number,
): void {
  const routeId = request.attempt.routeId;
  const { verdict } = outcome.decision;
  // 사유는 첫 하나만 차원에 싣는다(기수 — 전체는 audit 행에). `NonEmptyReasons` 라 0번은 타입상 존재한다.
  const reason = outcome.decision.reasons[0];

  countMetric(METRIC_NAMES.attempts, { route_id: routeId, verdict, reason });
  // `from_inactive`(위반 아님)는 첫 사유가 아니어도 따로 센다(보안 리뷰 L1 — 반복 시도가 관측에서 사라지지 않게).
  if (outcome.decision.reasons.includes('from_inactive')) {
    countMetric(METRIC_NAMES.fromInactive, { route_id: routeId });
    log('warn', 'gate.from_inactive', { route_id: routeId, agent_id: agentId, message_id: request.messageId, trace_id: request.traceId });
  }
  emitMetric(METRIC_NAMES.latencyMs, latencyMs, 'Milliseconds', { route_id: routeId, verdict });

  if (outcome.kind === 'sent') {
    // 눈금은 수신자 수 — 알람 2의 임계값(워밍업 캡)과 같은 단위다.
    emitMetric(METRIC_NAMES.recipients, request.attempt.recipients.length, 'Count', {
      route_id: routeId,
    });
  }

  // `duplicate_suppressed` 도 센다 — 재전달 빈도가 큐의 건강이다.
  log(outcome.kind === 'failed' ? 'warn' : 'info', 'gate.attempt', {
    route_id: routeId,
    agent_id: agentId,
    message_id: request.messageId,
    trace_id: request.traceId,
    verdict,
    reason,
    outcome: outcome.kind === 'sent' || outcome.kind === 'failed' ? outcome.kind : null,
    recipient_count: request.attempt.recipients.length,
    policy_version: outcome.decision.policyVersion,
    ses_message_id: outcome.kind === 'sent' ? outcome.sesMessageId : null,
    // 승인 대기로 연 요청 또는 릴리스 중인 요청 — 로그와 audit 을 잇는 키.
    approval_id: outcome.kind === 'pending_approval' && outcome.approval !== null
      ? outcome.approval.approvalId
      : (request.release?.approvalId ?? null),
    latency_ms: latencyMs,
  });
}
