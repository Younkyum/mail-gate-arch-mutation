/**
 * `workers/approval-release` — **승인된 요청의 발송** (`OUTBOUND_ROUTES.approval_release`, 계획 §4.3).
 *
 * 승인(`approval/service.approveRequest`)은 상태만 바꾸고 보내지 않는다. 보내는 것은 이 워커이고,
 * **관문을 다시 지난다** — 승인과 발송 사이에 kill-switch·억제·예산·워밍업 캡이 바뀌었을 수 있다.
 * 관문은 이 시도가 릴리스임을 `release` 표지로 알고, 그 요청이 정말 `approved` 인지 DB 에서 읽고
 * (로더의 grant), `pending_approval` audit 행을 **새로 쓰지 않고 갱신**한다(§4.3 r3-V2).
 *
 * **이 워커는 요청의 상태를 판정하지 않는다.** `approved` 가 아니면 건너뛰는 한 줄을 여기 두면
 * 판정이 둘(여기와 관문)이 되고, 둘이 갈라진 날 느슨한 쪽이 이긴다. 판정은 관문 하나가 한다 —
 * 대기·거절·만료 요청의 릴리스는 관문이 아무것도 쓰지 않고 `pending_approval`(`approval: null`)로 돌려준다.
 *
 * **SQS 재전달에 안전하다.** 같은 잡이 두 번 와도 두 번째는 messages 행이 이미 `dispatching`/`sent`
 * 이므로 lease 에서 죽는다(§4.5-3). 멱등 키가 필요 없는 이유가 그것이다 — 이 워커는 새 messages 행을
 * 만들지 않고 **기존 행**에 lease 를 건다.
 *
 * **본문.** 전송단은 `MessageContentReader` 에서 본문을 읽는다. 운영 조립은 영속 저장소
 * (`createObjectContentStore(objects)`, `api/content-store.ts` — S3/로컬 파일시스템)이므로 릴리스가 최초
 * 시도와 **다른 프로세스**에서 돌아도 같은 본문을 읽는다. 프로세스 메모리 구현(`createInMemoryContentStore`)은
 * 테스트용이고, 그 조립에서만 "같은 프로세스" 제약이 남는다. 어느 쪽이든 본문이 없으면 전송단이
 * `MessageContentNotFoundError` 로 던지고 관문이 `failed` 로 닫는다 — 빈 메일을 보내지 않는 방향이다.
 *
 * **투입 — 일정은 DB 에 있다** (`approval_releases`, `202609222300_approval_release_schedule.sql`).
 * 승인 전이 트리거가 같은 트랜잭션에서 항목마다 일정 행을 만든다. 이 워커는 기한이 된 행을 **집어서**
 * 관문에 세운다 — 주기 스윕(`runApprovalReleaseSweep`, EventBridge 1분 주기 등)이 본체이고, 승인 직후의
 * `runApprovalRelease(approvalId)`(매직링크 `onApproved` · SQS)는 그 요청의 행만 **당겨 집는 깨우기**다.
 * 깨우기가 유실돼도 다음 스윕이 같은 행을 집는다 — 잡 유실이 곧 메일 유실이던 구조가 아니다.
 *
 * **일시적 거부는 닫지 않고 미룬다** (P2 수정). 재평가가 분당 한도·워밍업 캡·예산·평가 실패로 거부하면
 * 관문은 audit 행을 `pending_approval` 그대로 두고 재시도 시각을 돌려준다(`policy/release-deferral.ts` 의
 * 분류표). 이 워커는 그 시각을 일정 행에 적는다. 창 끝(`deadline_at`, 승인 + 48h)의 재평가가 마지막이고,
 * 그때도 거부면 관문이 `release_denied:<사유>` 로 닫는다. 영구 거부(억제·차단·kill-switch …)는 즉시 닫는다.
 *
 * **페이싱.** 한 번의 실행에서 한 에이전트의 항목이 일시적 거부를 받으면, 그 에이전트의 **남은 항목은 관문에
 * 세우지 않고** 같은 시각으로 미룬다. 분당 5 에 20통이면 분마다 5통이 나가고 4분에 끝난다 — 20개를 전부
 * 관문에 던져 15개가 각자 거부되는 것과 결과는 같지만, 거부 판정·로그·메트릭이 라운드당 1건으로 준다.
 * 창 끝에 닿은 항목은 페이싱으로 건너뛰지 않는다(마지막 재평가를 받을 권리가 있다).
 */

import { randomUUID } from 'node:crypto';

import { MessageContentNotFoundError } from '../api/content-store';
import { finalizeOutbound, gateDependenciesFor } from '../api/outbound-service';
import type { OutboundOutcome, OutboundServiceDependencies } from '../api/outbound-service';
import { measurePendingOverdue, type ApprovalStore, type ScheduledRelease } from '../approval/service';
import type { MessageAttachmentMeta } from '../db/repositories/outbound-attachment-store';
import { TERMINAL_OUTBOUND_MESSAGE_STATUSES, type ApprovalRequestItemRow, type MessageStatus } from '../db/schema';
import { log } from '../observability/logger';
import { dispatch, type DispatchRequest, type OutboundTransport } from '../policy/gate';
import type { ReleaseDeferral } from '../policy/release-deferral';
import type { Decision } from '../policy/types';

export const APPROVAL_RELEASE_ROUTE_ID = 'approval_release';

/** 한 번의 실행에서 집을 최대 항목 수. 넘치면 다음 실행이 이어받는다(기한 순). */
export const APPROVAL_RELEASE_BATCH = 50;

/**
 * lease 를 다른 워커가 쥐고 있을 때 일정 행에 적는 사유. 거부 사유가 아니라 "결말이 아직 남의 손에 있다" 는
 * 표지다 — lease TTL 뒤에 다시 집어 결말을 확인한다(그쪽이 죽었으면 관문의 lease 만료 경로가 이어받는다).
 */
export const RELEASE_LEASE_HELD = 'lease_held';

/** 큐에서 꺼낸 한 건 — 승인 라우트가 `approved` 를 받은 뒤 넣는다. **깨우기 신호**다. */
export interface ApprovalReleaseJob {
  readonly approvalId: string;
  readonly traceId: string | null;
}

export interface ApprovalReleaseDependencies {
  readonly service: OutboundServiceDependencies;
  readonly approvals: Pick<
    ApprovalStore,
    'find' | 'items' | 'claimDueReleases' | 'deferRelease' | 'settleRelease' | 'countPendingOverdue'
  >;
  /** **실제 전송단이다.** 이 경로는 스텁이 아니다 — 승인된 메일은 실제로 나가야 한다. */
  readonly transport: OutboundTransport;
}

/**
 * 릴리스 항목 하나의 결말. `OutboundOutcome` 에 **`deferred` 하나**를 더한다 — 관문이 아무것도 쓰지 않았고
 * (audit 행은 `pending_approval`, messages 행은 `pending`) 일정 행이 `retryAt` 으로 밀렸다.
 * `paced` 면 관문에 세우지도 않았다(같은 실행에서 같은 에이전트의 앞 항목이 이미 일시적 거부를 받았다).
 */
export type ApprovalReleaseOutcome =
  | OutboundOutcome
  | {
      readonly kind: 'deferred';
      readonly messageId: string;
      readonly retryAt: Date;
      readonly reason: string;
      readonly paced: boolean;
      /** 관문의 판정. 페이싱으로 건너뛴 항목은 판정이 없다(`null`). */
      readonly decision: Decision | null;
    };

/**
 * **승인 직후의 깨우기** — 그 요청의 기한이 된 항목만 집어 관문에 세운다. 배치면 N건, 단건이면 1건.
 * 기한이 안 된 항목(이미 미뤄진 것)은 집지 않는다 — 깨우기가 페이싱을 무너뜨리지 않는다.
 */
export async function runApprovalRelease(
  deps: ApprovalReleaseDependencies,
  job: ApprovalReleaseJob,
): Promise<readonly ApprovalReleaseOutcome[]> {
  const approval = await deps.approvals.find(job.approvalId);
  if (approval === null) {
    log('warn', 'worker.job_settled_before_gate', {
      route_id: APPROVAL_RELEASE_ROUTE_ID,
      approval_id: job.approvalId,
      trace_id: job.traceId,
      outcome: 'missing',
    });
    return [];
  }
  return releaseClaimed(deps, await claimDue(deps, job.approvalId), job.traceId);
}

/**
 * **주기 스윕** — 모든 요청의 기한이 된 항목을 집는다. 일정의 본체다(스케줄은 인프라의 일).
 *
 * 끝에 §4.3 보조 불변식을 잰다(`measurePendingOverdue`) — TTL 스위퍼도 같은 것을 잰다. 위반의 두 갈래를 닫는
 * 주체가 이 스윕과 TTL 스위퍼라서, 둘이 서로를 감시한다(한쪽이 멈추면 다른 쪽의 측정에 그 위반이 쌓인다).
 */
export async function runApprovalReleaseSweep(
  deps: ApprovalReleaseDependencies,
): Promise<readonly ApprovalReleaseOutcome[]> {
  const outcomes = await releaseClaimed(deps, await claimDue(deps, null), null);
  await measurePendingOverdue(deps.approvals, deps.service.now());
  return outcomes;
}

/** 기한이 된 일정 행을 집는다 — `approvalId` 가 있으면 그 요청의 행만(깨우기), 없으면 전부(스윕). */
function claimDue(deps: ApprovalReleaseDependencies, approvalId: string | null): Promise<readonly ScheduledRelease[]> {
  return deps.approvals.claimDueReleases({
    now: deps.service.now(),
    limit: APPROVAL_RELEASE_BATCH,
    approvalId,
    leaseSeconds: deps.service.leaseTtlSeconds,
  });
}

/** 집힌 항목들을 순서대로 관문에 세운다 — 에이전트마다 첫 일시적 거부에서 멈춘다(머리말 "페이싱"). */
async function releaseClaimed(
  deps: ApprovalReleaseDependencies,
  claimed: readonly ScheduledRelease[],
  traceId: string | null,
): Promise<readonly ApprovalReleaseOutcome[]> {
  const itemsByApproval = new Map<string, readonly ApprovalRequestItemRow[]>();
  const pacedAgents = new Map<string, ReleaseDeferral>();
  const outcomes: ApprovalReleaseOutcome[] = [];

  for (const entry of claimed) {
    const now = deps.service.now();
    const pace = pacedAgents.get(entry.agentId);
    if (pace !== undefined && now.getTime() < entry.deadlineAt.getTime()) {
      const retryAt = new Date(Math.min(pace.retryAt.getTime(), entry.deadlineAt.getTime()));
      await deps.approvals.deferRelease(entry.messageId, retryAt, pace.reason);
      outcomes.push({ kind: 'deferred', messageId: entry.messageId, retryAt, reason: pace.reason, paced: true, decision: null });
      continue;
    }
    outcomes.push(await releaseOne(deps, entry, await itemOf(deps, itemsByApproval, entry), now, traceId, pacedAgents));
  }
  return outcomes;
}

/** 일정 행이 가리키는 항목(사람이 본 봉투). FK 가 존재를 보장한다 — 없으면 조용히 건너뛰지 않고 던진다. */
async function itemOf(
  deps: ApprovalReleaseDependencies,
  cache: Map<string, readonly ApprovalRequestItemRow[]>,
  entry: ScheduledRelease,
): Promise<ApprovalRequestItemRow> {
  let items = cache.get(entry.approvalId);
  if (items === undefined) {
    items = await deps.approvals.items(entry.approvalId);
    cache.set(entry.approvalId, items);
  }
  const item = items.find((candidate) => candidate.message_id === entry.messageId);
  if (item === undefined) throw new Error(`릴리스 일정의 승인 항목이 없다 (message_id=${entry.messageId})`);
  return item;
}

async function releaseOne(
  deps: ApprovalReleaseDependencies,
  entry: ScheduledRelease,
  item: ApprovalRequestItemRow,
  now: Date,
  traceId: string | null,
  pacedAgents: Map<string, ReleaseDeferral>,
): Promise<ApprovalReleaseOutcome> {
  const message = await deps.service.messages.findById(item.message_id);
  if (message === null) throw new Error(`승인 항목의 messages 행이 없다 (id=${item.message_id})`);

  // 첨부(메일 기본기 2차 A2) — 최초 시도가 결속한 메타 그대로(`message_attachments`). Stage 6 이 릴리스 시점의 요금제로 다시 본다
  // (승인 대기 중 강등됐으면 여기서 막힌다). 바이트는 전송단이 영구본에서 읽어 체크섬을 대조한다.
  const attachmentMeta = await attachmentMetaOf(deps, item.message_id);
  const dispatchRequest: DispatchRequest = {
    agentId: entry.agentId,
    attempt: {
      routeId: APPROVAL_RELEASE_ROUTE_ID,
      // **사람이 본 봉투 그대로다**(`approval_request_items` 는 수정 불가). 판정용 정규화는 로더가 한다.
      fromAddress: item.from_address,
      recipients: item.recipients,
      attachments: attachmentMeta.map((meta) => ({ filename: meta.filename, mimeType: meta.mimeType, bytes: meta.bytes })),
      // 스레드는 **주장**으로만 싣는다 — 로더가 다시 검증한다(P3b). 본문은 관문에 없으므로 모양은 `other`
      // (좁은 쪽: verification 자동 승인 문이 열리지 않는다 — 이 시도는 이미 사람이 승인했다).
      threadId: item.thread_id,
      contentShape: 'other',
      // 위험 보류(ADR-0016)는 릴리스에 걸리지 않는다 — 사람이 이 봉투를 보고 승인했다(로더가 `riskHold` 를 싣지 않는다). 계열은 최초 시도의
      // `messages.outbound_dlp` 에 남아 있다.
      dlp: [], pinnedTaint: false,
    },
    now,
    traceId,
    thisAttemptCostCents: item.cost_cents,
    messageId: item.message_id,
    // 최초 시도가 **전송 전에** 확정한 값이다(§4.5-4). 재전송도 같은 값으로 나가야 수신측이 병합한다.
    messageIdHeader: message.messageIdHeader,
    leaseId: randomUUID(),
    release: { approvalId: item.approval_id, auditId: item.audit_id, deadlineAt: entry.deadlineAt },
  };

  const outcome = await dispatch(gateDependenciesFor(deps.service, deps.transport), dispatchRequest);

  if (outcome.kind === 'pending_approval' && outcome.deferral !== null) {
    // **닫지 않는다.** 관문은 아무것도 쓰지 않았다 — `finalizeOutbound` 에 넘기지 않는 것도 같은 이유다
    // (넘겨도 대기 변형은 행을 확정하지 않지만, 이 결말의 주인은 일정 행이다).
    const { retryAt, reason } = outcome.deferral;
    await deps.approvals.deferRelease(item.message_id, retryAt, reason);
    pacedAgents.set(entry.agentId, outcome.deferral);
    log('info', 'approval.release_deferred', {
      route_id: APPROVAL_RELEASE_ROUTE_ID,
      agent_id: entry.agentId,
      approval_id: item.approval_id,
      message_id: item.message_id,
      trace_id: traceId,
      reason,
      detail: `retry_at=${retryAt.toISOString()} claim=${String(entry.claimCount)}`,
    });
    return { kind: 'deferred', messageId: item.message_id, retryAt, reason, paced: false, decision: outcome.decision };
  }

  const settled = await finalizeOutbound(deps.service, { dispatchRequest }, outcome);

  if (settled.kind === 'replayed' && !isTerminal(settled.message.status)) {
    // 다른 워커가 lease 를 쥐고 있다(또는 관문이 lease 만료 재전송을 유보했다). 결말은 아직 그쪽 손에 있다 —
    // 일정을 닫으면 그쪽이 죽었을 때 이 항목을 다시 집을 주체가 없다. lease TTL 뒤에 다시 본다.
    //
    // **이 재예약에도 끝이 있다** (검증 V1 MINOR-5 — 증거 조회가 계속 `unknown` 이면 관문이 재전송을 영원히
    // 유보한다). 끝은 여기가 아니라 관문에 있다: 창(`releaseWindowClosed`)이 닫힌 뒤의 재평가는 lease 에 닿기
    // **전에** `release_window_expired` 로 닫힌다(`gate.reserveRelease`). 그때 audit 행은 이미 lease 쥔 쪽이 해소해
    // 갱신이 0행이고, messages 행은 `pending` 이 아니라 `settleDenied` 도 0행이다 — 닫히는 것은 이 일정뿐이다.
    // 여기에 같은 창 검사를 한 벌 더 두지 않는 이유: 입력(시각·창 끝)이 관문과 같아 그 분기는 도달할 수 없다.
    const retryAt = new Date(now.getTime() + deps.service.leaseTtlSeconds * 1000);
    await deps.approvals.deferRelease(item.message_id, retryAt, RELEASE_LEASE_HELD);
    return settled;
  }

  await deps.approvals.settleRelease(item.message_id, settlementOf(settled), now);
  // `denied` 는 **사람이 승인했는데 나가지 않은** 결말이다(영구 거부 또는 창 끝). audit 에만 남기지 않는다.
  log(settled.kind === 'denied' || settled.kind === 'pending_approval' ? 'warn' : 'info', 'worker.job', {
    route_id: APPROVAL_RELEASE_ROUTE_ID,
    agent_id: entry.agentId,
    approval_id: item.approval_id,
    message_id: item.message_id,
    trace_id: traceId,
    outcome: settled.kind,
    reason: settled.kind === 'denied' ? settled.decision.reasons[0] : null,
  });
  return settled;
}

/**
 * 릴리스의 첨부 메타. 첨부 서비스가 조립되지 않았으면(보안 리뷰 L6 — fail-closed) 본문 객체로 첨부가 있는지 보고, **있으면 던진다** — 메타 없이
 * 관문에 세우면 Stage 6 이 빈 배열을 보고 통과시킨다. 본문이 없으면(전송단이 어차피 `failed` 로 닫는다) 빈 메타로 둔다.
 */
async function attachmentMetaOf(deps: ApprovalReleaseDependencies, messageId: string): Promise<readonly MessageAttachmentMeta[]> {
  if (deps.service.attachments !== undefined) return deps.service.attachments.metaForMessage(messageId);
  let content;
  try {
    content = await deps.service.content.load(messageId);
  } catch (error) {
    if (error instanceof MessageContentNotFoundError) return [];
    throw error;
  }
  if ((content.attachments ?? []).length > 0) {
    throw new Error(`첨부가 결속된 메일인데 첨부 서비스가 조립되지 않았다 — 릴리스하지 않는다 (message_id=${messageId})`);
  }
  return [];
}

function isTerminal(status: MessageStatus): boolean {
  return (TERMINAL_OUTBOUND_MESSAGE_STATUSES as readonly MessageStatus[]).includes(status);
}

/**
 * 일정 행의 종단 사유 — `OutboundOutcome` 의 종류 그대로다. 하나만 이름을 바꾼다: 릴리스의 `pending_approval`
 * (재예약이 아닌 것)은 **관문이 이 봉투에 대한 승인을 찾지 못했다**는 뜻이다. 트리거가 승인 전이에서만 일정을
 * 만들므로 정상 경로에서는 오지 않는다 — 왔다면 audit 행이 `pending_approval` 로 남고
 * `audit_pending_overdue` 가 그 행을 보여 준다(숨기지 않는다).
 */
function settlementOf(outcome: OutboundOutcome): string {
  return outcome.kind === 'pending_approval' ? 'not_granted' : outcome.kind;
}
