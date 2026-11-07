/**
 * src/approval/service.ts — **승인 요청의 상태 전이** (계획 §3.4 · §4.3 · §4.5-6).
 *
 * 이 파일이 하는 일은 셋뿐이다 — 승인·거절·만료. 셋 다 `approval_requests` 에 대한
 * **`WHERE status='pending'` 조건부 UPDATE** 이고, 먼저 이긴 쪽이 유일한 전이자이며 진 쪽은
 * no-op 이다(AC-i4). 종단 상태는 DB 트리거가 동결한다.
 *
 * ---
 *
 * **이 파일은 관문(`policy/gate.ts`)을 import 하지 않는다 — 그것이 설계다.**
 *
 * 1. **만료·거절은 구조적으로 발송할 수 없다.** 발송은 관문을 통해서만 일어나고(AC-8), 이 파일은
 *    관문에 닿지 않는다. "만료는 절대 발송하지 않는다 — auto-send 는 설정으로도 불허" (§3.4 4조)
 *    가 주석이 아니라 import 그래프의 성질이 된다. `test/arch/approval-boundary.arch.test.ts` 가
 *    그 성질(이 파일과 만료 워커의 **전이적** import 폐포에 관문이 없다)을 단언한다.
 * 2. **릴리스는 워커 진입점에 있다** (`src/workers/approval-release.ts`, 매니페스트 `approval_release`).
 *    Layer C 의 전수 분할은 `src/api/routes`·`src/workers` 만 덮는다(`ARCH_PARTITIONED_DIRS`).
 *    관문 호출이 `src/approval/` 에 있으면 그 발송 경로는 분할 밖에 서고, Layer C 는 그것을 못 본다.
 *
 * **웹훅 이벤트는 이 파일이 만든다 — 적는 것은 저장소다** (§3.4 1조·4조). 승인·거절·만료마다 무엇을
 * 알릴지(`approval.resolved`/`approval.expired`, 그 요청의 메시지 id 들)는 여기서 정하고, 저장소는
 * 그 이벤트를 **전이를 이긴 그 트랜잭션 안에서만** outbox 에 적는다. 전이에 지면 이벤트도 없다 — 그래서
 * "일어나지 않은 결정을 알리는 웹훅" 이 구조적으로 없다. 이벤트 빌더(`webhooks/events.ts`)는 순수
 * 직렬화라 이 파일의 import 폐포에 관문·전송단을 끌어오지 않는다.
 *
 * **승인 요청을 여는 것도 이 파일이 아니다.** 요청은 관문이 `pending_approval` 판정과 같은
 * 트랜잭션에서 연다(`gate.ts` 의 `openApproval` · `audit-sink.ts`). 여기서 열면 관문 밖에서 승인
 * 대기가 생길 수 있게 되고, 그 순간 "관문이 유일한 병목" 이라는 AC-8 이 흐려진다.
 */

import type {
  AgentId,
  ApprovalRequestItemRow,
  ApprovalRequestRow,
  ApprovalStatus,
  GrantedScope,
  RelationshipScope,
} from '../db/schema';
import { emitMetric, METRIC_NAMES } from '../observability/metrics';
import { log } from '../observability/logger';
import { comparableAddress } from '../policy/policy-loader';
import { approvalExpiredEvent, approvalResolvedEvent, type WebhookEvent } from '../webhooks/events';

// ---------------------------------------------------------------------------
// 저장소 인터페이스 — `src/db/repositories/approval-store.ts` 가 구현한다
// ---------------------------------------------------------------------------

/** 승인이 만들 standing approval 한 행 (§3.4 2조). 서비스가 계산하고 저장소는 쓰기만 한다. */
export interface RelationshipGrant {
  readonly scope: RelationshipScope;
  /** `recipient`·`thread` 스코프. **허용 비교형**(`comparableAddress` — 소문자, `+tag` 보존) — 사람이 본 주소 그대로다. */
  readonly address: string | null;
  /** `domain` 스코프. 소문자 도메인. */
  readonly domain: string | null;
  readonly threadId: string | null;
  /** `domain` 스코프에서만. **없으면 DB CHECK 가 INSERT 를 거부한다**(AC-d5 의 2차 방어선). */
  readonly domainScopeConfirmedBy: string | null;
}

export interface ApproveCommand {
  readonly approvalId: string;
  readonly decidedBy: string;
  readonly now: Date;
  /** `approval_requests.granted_scope`. 위험 보류는 언제나 `once`(관계 0 — DB 트리거가 한 번 더 막는다). */
  readonly scope: GrantedScope;
  readonly relationships: readonly RelationshipGrant[];
  /** `approval.resolved`(approved). **전이를 이겼을 때만** 같은 트랜잭션에서 outbox 에 적힌다. */
  readonly event: WebhookEvent;
}

export interface DecideCommand {
  readonly approvalId: string;
  readonly decidedBy: string;
  readonly now: Date;
}

/** 거절 — 호출자 입력(`DecideCommand`) + 서비스가 만든 `approval.resolved`(rejected). */
export interface RejectCommand extends DecideCommand {
  readonly event: WebhookEvent;
}

export interface ExpireCommand {
  readonly approvalId: string;
  readonly now: Date;
  /** `approval.expired` (AC-d3). 전이를 이겼을 때만 적힌다 — 스위퍼가 두 번 돌아도 1회. */
  readonly event: WebhookEvent;
}

export interface ApprovalStore {
  find(approvalId: string): Promise<ApprovalRequestRow | null>;
  items(approvalId: string): Promise<readonly ApprovalRequestItemRow[]>;
  /**
   * 이 요청의 항목들이 평가될 때 걸린 **위험 보류 사유**(ADR-0016 — `tainted_context`·`dlp_*`, audit 행의 `reasons` 에서). 비어 있으면 위험 보류가
   * 아니다. 승인 범위를 정한다(`once`) — 이 값이 거짓말해도 DB 트리거(`approval_requests_risk_hold_once`)가 같은 사실로 막는다.
   */
  riskHoldReasons(approvalId: string): Promise<readonly string[]>;
  /**
   * **한 트랜잭션:** `pending → approved` 조건부 UPDATE(`expires_at > now` 포함) → 관계 INSERT →
   * 웹훅 outbox(`command.event`). 전이에 졌으면(이미 결정됐거나 TTL 을 넘겼으면) `null` 이고 관계도
   * 이벤트도 쓰지 않는다.
   */
  approve(command: ApproveCommand): Promise<ApprovalRequestRow | null>;
  /**
   * **한 트랜잭션:** `pending → rejected` → audit 행 `denied`/`approval_rejected` → messages `denied` →
   * 웹훅 outbox. 전이에 졌으면 `false` 이고 아무것도 바꾸지 않는다.
   */
  reject(command: RejectCommand): Promise<boolean>;
  /**
   * **한 트랜잭션:** `pending → expired`(`expires_at <= now` 일 때만) → audit 행
   * `denied`/`approval_expired` → messages `denied` → 웹훅 outbox. 전이에 졌으면 `false`.
   */
  expire(command: ExpireCommand): Promise<boolean>;
  /** TTL 을 넘긴 `pending` 요청 id(오래된 순). 스위퍼의 입력이다. */
  listDue(now: Date, limit: number): Promise<readonly string[]>;
  /** 가장 오래된 `pending` 요청의 생성 시각. 없으면 `null`. §4.3 보조 불변식의 측정 입력. */
  oldestPendingCreatedAt(): Promise<Date | null>;
  /**
   * §4.3 보조 불변식(재정의)의 위반 수 — `audit_pending_overdue(at)` 의 행 수. 승인 대기(요청 `pending`, TTL 전)도
   * 릴리스 대기(요청 `approved`, 일정 `scheduled`, 창 전)도 아닌 `pending_approval` audit 행. **0 이 불변식이다.**
   */
  countPendingOverdue(at: Date): Promise<number>;

  // ---- 릴리스 일정 (`approval_releases`) — 승인된 요청의 항목이 **아직 나가지 않은** 상태의 표지 ----
  //
  // 행은 **승인 전이의 트리거가 같은 트랜잭션에서** 만든다(`202609222300_approval_release_schedule.sql`) —
  // 이 저장소도 서비스도 만들지 않는다. 승인 경로가 몇 개든 "승인됐는데 릴리스 일정이 없는" 요청은 없다.
  // 아래 셋은 릴리스 워커(`workers/approval-release.ts`)만 부른다. **발송하지 않는다** — 기한이 된 항목을
  // 집고(임대), 관문이 돌려준 결말을 적을 뿐이다.

  /**
   * 기한(`next_release_at <= now`)이 된 `scheduled` 항목을 집는다. 집은 항목은 `next_release_at` 을
   * `now + leaseSeconds` 로 민다 — 그것이 임대다(워커가 죽으면 그 시각에 다시 집힌다). `approvalId` 가
   * 있으면 그 요청의 항목만 본다(승인 직후의 깨우기), `null` 이면 전체(주기 스윕).
   */
  claimDueReleases(request: ReleaseClaimRequest): Promise<readonly ScheduledRelease[]>;
  /** 재평가가 일시적으로 거부했다 — `until` 에 다시 집히게 한다. `scheduled` 가 아니면 0행. */
  deferRelease(messageId: string, until: Date, reason: string): Promise<void>;
  /** 관문이 결말을 냈다(발송·실패·영구 거부·창 끝) — 다시 집히지 않는다. `scheduled` 가 아니면 0행. */
  settleRelease(messageId: string, outcome: string, now: Date): Promise<void>;
}

/**
 * **재시도 창** — 승인 시각부터 이 시간 안에 나가지 못한 항목은 `release_denied:<사유>` 로 닫힌다.
 *
 * DB 트리거(`approval_requests_schedule_release`)가 `deadline_at = decided_at + 48h` 로 적는다 — **값의 출처는
 * 그 SQL 이고**, 이 상수는 인메모리 대역과 테스트가 같은 값을 쓰도록 둔 사본이다(통합 테스트가 둘을 맞붙인다).
 *
 * 왜 48시간인가: 일 단위 축(`rate_limit_per_day`·`warmup_daily_cap`)은 **24시간 롤링 창**인데 `retry_after` 는
 * 다음 UTC 자정까지다. 24시간 창이면 "하루치를 다 쓴 날 승인" 이 경계에서 체계적으로 닫힌다 — 자정 재시도는
 * 아직 창 안의 발송을 보고, 그다음 재시도가 곧 창 끝이다. 48시간은 UTC 자정을 두 번 덮는다. 그보다 길면
 * "사람이 승인한 메일이 사흘 뒤에 나간다" 가 되고, 그때는 맥락이 바뀌었을 공산이 크다.
 */
export const APPROVAL_RELEASE_WINDOW_HOURS = 48;

export interface ReleaseClaimRequest {
  readonly now: Date;
  readonly limit: number;
  readonly approvalId: string | null;
  /** 임대 길이(초). 관문의 lease TTL 보다 짧으면 전송 중인 항목을 다른 워커가 다시 집는다. */
  readonly leaseSeconds: number;
}

/** 집힌 릴리스 항목 하나. */
export interface ScheduledRelease {
  readonly approvalId: string;
  readonly messageId: string;
  readonly auditId: string;
  readonly agentId: AgentId;
  /** 이 시각 이후의 재평가가 마지막이다(`APPROVAL_RELEASE_WINDOW_HOURS`). */
  readonly deadlineAt: Date;
  /** 이번 집기를 포함한 누적 집기 수. */
  readonly claimCount: number;
}

// ---------------------------------------------------------------------------
// 오류
// ---------------------------------------------------------------------------

/**
 * **AC-d5** — `domain` 스코프 승인에 소유자 확인 파라미터(`confirm_scope: "domain"`)가 없다.
 *
 * 라우트는 이 오류를 `400` 으로 옮긴다. 기본값으로 `recipient` 에 떨어뜨리지 않는 이유: 소유자는
 * 도메인을 열려 했고 우리는 한 명만 열었다 — 그 차이는 "왜 다음 메일이 또 승인을 묻는가" 로
 * 나타나고 아무도 원인을 모른다. 좁히는 쪽이라도 **조용한 변환은 하지 않는다.**
 */
export class DomainScopeConfirmationRequiredError extends Error {
  constructor() {
    super('domain 스코프 승인은 confirm_scope: "domain" 이 필요하다 (§3.4 2조, AC-d5)');
    this.name = 'DomainScopeConfirmationRequiredError';
  }
}

/**
 * `thread` 스코프를 골랐는데 스레드가 없는 시도다. 스레드는 인바운드(P3)가 만든다 — P2 의 시도는
 * 전부 `thread_id = null` 이므로 이 스코프는 **P3 전까지 고를 수 없다.** 조용히 `recipient` 로 넓히면
 * 소유자가 원한 것보다 넓은 관계가 생긴다.
 */
export class ThreadScopeUnavailableError extends Error {
  constructor(readonly approvalId: string) {
    super(`thread 스코프를 만들 스레드가 없다 (approvalId=${approvalId}) — 스레드는 P3 인바운드가 만든다`);
    this.name = 'ThreadScopeUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// 승인
// ---------------------------------------------------------------------------

export interface ApproveInput {
  readonly approvalId: string;
  readonly decidedBy: string;
  readonly now: Date;
  /** 기본은 `recipient`(§3.4 2조 — "그 주소 한정, 무기한"). */
  readonly scope: RelationshipScope;
  /** **AC-d5.** `scope === 'domain'` 이면 이 값도 `'domain'` 이어야 한다. */
  readonly confirmScope: RelationshipScope | null;
}

export type ApproveOutcome =
  | {
      readonly kind: 'approved';
      readonly request: ApprovalRequestRow;
      /** 위험 보류였다 — 범위는 `once`(관계를 만들지 않았다). 고른 범위는 무시됐다. */
      readonly riskHold: boolean;
      /** 릴리스가 관문을 재통과할 항목들. 릴리스는 `workers/approval-release` 가 한다. */
      readonly items: readonly ApprovalRequestItemRow[];
    }
  /** 전이에 졌다 — 이미 결정됐거나(`status`), TTL 을 넘겼거나, 요청이 없다. **발송하지 않는다.** */
  | { readonly kind: 'not_pending'; readonly status: ApprovalStatus | 'missing' | 'past_ttl' };

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

/**
 * 승인이 만들 관계 — **상대방당 1행** (§3.4 설계의 전부).
 *
 * AC-d2 "신규 상대 1명과 5턴이면 ApprovalRequest 총 1개" 는 여기서 성립한다: 첫 턴의 승인이
 * 그 상대의 `recipient` 관계를 만들고, 2~5턴은 Stage 7 에서 `standing_approval` 로 통과한다.
 */
export function relationshipsFor(
  items: readonly ApprovalRequestItemRow[],
  scope: RelationshipScope,
  /**
   * `domain` 스코프의 확인자 — **확인 파라미터가 있을 때만** 값이다. 결정자를 자동으로 채우지 않는
   * 이유: 그렇게 하면 DB CHECK(`sender_relationships_domain_requires_confirmation`)가 "확인했는가"
   * 가 아니라 "결정자가 있는가" 를 검사하게 되어, 위 서비스 검사가 빠지는 날 2차 방어선이 공허해진다.
   */
  domainConfirmedBy: string | null,
  approvalId: string,
): readonly RelationshipGrant[] {
  const grants = new Map<string, RelationshipGrant>();
  for (const item of items) {
    for (const raw of item.recipients) {
      // **소유자가 본 주소 그대로**(소문자만) 저장한다. 판정형(`normalizeAddress` — `+tag` 절단)으로 저장하면
      // `Sales+EU@Corp.com` 의 승인이 `sales@`·모든 `sales+*` 를 여는 관계가 된다(검증 V1 MINOR-2).
      const address = comparableAddress(raw);
      if (scope === 'recipient') {
        grants.set(address, { scope, address, domain: null, threadId: null, domainScopeConfirmedBy: null });
      } else if (scope === 'domain') {
        const domain = domainOf(address);
        grants.set(domain, { scope, address: null, domain, threadId: null, domainScopeConfirmedBy: domainConfirmedBy });
      } else {
        if (item.thread_id === null) throw new ThreadScopeUnavailableError(approvalId);
        grants.set(`${item.thread_id}::${address}`, {
          scope,
          address,
          domain: null,
          threadId: item.thread_id,
          domainScopeConfirmedBy: null,
        });
      }
    }
  }
  return [...grants.values()];
}

/**
 * 승인 — `pending → approved` + standing approval 생성. **발송은 하지 않는다.**
 *
 * 발송은 릴리스 워커가 관문을 다시 지나며 한다. 승인과 발송을 한 함수에 묶지 않는 이유는 위
 * 머리말 1·2와 같다. 호출자(승인 라우트)는 `approved` 를 받으면 릴리스 잡을 큐에 넣는다.
 */
export async function approveRequest(store: ApprovalStore, input: ApproveInput): Promise<ApproveOutcome> {
  if (input.scope === 'domain' && input.confirmScope !== 'domain') {
    throw new DomainScopeConfirmationRequiredError();
  }

  const current = await store.find(input.approvalId);
  if (current === null) return { kind: 'not_pending', status: 'missing' };
  if (current.status !== 'pending') return { kind: 'not_pending', status: current.status };

  const items = await store.items(input.approvalId);
  // ADR-0016 — **위험 보류의 승인은 `once`**: 이 메일 한 통만 나간다. standing approval 을 만들지 않는다(진윤겸 결정 — 오염 맥락의 상대가 승인 한 번으로
  // 상시 상대가 되면 다음 인젝션은 사람을 거치지 않는다). 소유자가 고른 범위는 무시한다 — 좁히는 쪽이고, 페이지는 위험 보류에 범위 선택을 보이지
  // 않는다(`magic-link.ts`).
  const riskHold = (await store.riskHoldReasons(input.approvalId)).length > 0;
  const scope: GrantedScope = riskHold ? 'once' : input.scope;
  const relationships = riskHold
    ? []
    : relationshipsFor(items, input.scope, input.confirmScope === 'domain' ? input.decidedBy : null, input.approvalId);

  const approved = await store.approve({
    approvalId: input.approvalId,
    decidedBy: input.decidedBy,
    now: input.now,
    scope,
    relationships,
    event: approvalResolvedEvent({
      agentId: current.agent_id,
      approvalId: input.approvalId,
      decision: 'approved',
      resolvedAt: input.now,
      messageIds: items.map((entry) => entry.message_id),
    }),
  });
  if (approved === null) {
    // 위에서 `pending` 을 봤는데 전이에 졌다 — 그 사이 만료·거절이 이겼거나 TTL 을 넘겼다.
    // **이것이 AC-i4 의 진 쪽이다.** 다시 읽어 누가 이겼는지 돌려준다(TTL 초과면 아직 `pending`).
    const after = await store.find(input.approvalId);
    const status = after === null ? 'missing' : after.status === 'pending' ? 'past_ttl' : after.status;
    return { kind: 'not_pending', status };
  }

  log('info', 'approval.approved', {
    agent_id: approved.agent_id,
    approval_id: approved.id,
    outcome: 'approved',
    reason: scope,
    recipient_count: relationships.length,
  });
  return { kind: 'approved', request: approved, items, riskHold };
}

// ---------------------------------------------------------------------------
// 거절 · 만료
// ---------------------------------------------------------------------------

/**
 * 거절 — 같은 audit 행을 `denied`/`approval_rejected` 로, messages 를 `denied` 로(§4.3 표).
 *
 * 전이 전에 요청을 **읽는다** — 웹훅의 `agent_id`·`message_ids` 가 거기 있다. 둘 다 불변(트리거)이라
 * 읽기와 조건부 UPDATE 사이에 바뀌지 않는다. 요청이 없거나 이미 결정됐으면 저장소를 부르지 않는다
 * (그래도 판정은 저장소의 조건부 UPDATE 가 한다 — 여기서 `pending` 을 봤어도 질 수 있다).
 */
export async function rejectRequest(store: ApprovalStore, command: DecideCommand): Promise<boolean> {
  const current = await store.find(command.approvalId);
  let rejected = false;
  if (current !== null && current.status === 'pending') {
    const items = await store.items(command.approvalId);
    rejected = await store.reject({
      ...command,
      event: approvalResolvedEvent({
        agentId: current.agent_id,
        approvalId: command.approvalId,
        decision: 'rejected',
        resolvedAt: command.now,
        messageIds: items.map((entry) => entry.message_id),
      }),
    });
  }
  log('info', 'approval.rejected', {
    approval_id: command.approvalId,
    outcome: rejected ? 'rejected' : 'not_pending',
  });
  return rejected;
}

/**
 * 요청 하나를 만료시킨다. **TTL 이 지나지 않았으면 아무것도 하지 않는다** — 저장소의 조건부
 * UPDATE 와 DB CHECK(`approval_requests_expire_after_ttl`)가 둘 다 막는다. 거절과 같은 이유로 먼저 읽는다.
 */
export async function expireRequest(store: ApprovalStore, approvalId: string, now: Date): Promise<boolean> {
  const current = await store.find(approvalId);
  if (current === null || current.status !== 'pending') return false;
  const items = await store.items(approvalId);
  return store.expire({
    approvalId,
    now,
    event: approvalExpiredEvent({
      agentId: current.agent_id,
      approvalId,
      expiredAt: now,
      messageIds: items.map((entry) => entry.message_id),
    }),
  });
}

/**
 * 보조 불변식 측정의 **허용 폭(초)** — `audit_pending_overdue(now - 이 값)` 을 잰다. 즉 "이 값보다 오래 위반인 행".
 *
 * 위반은 정상 운영에서도 잠깐 생긴다: TTL 을 넘긴 `pending` 요청은 5분 주기 스위퍼가 닫을 때까지, 창 끝을 넘긴
 * 일정은 창 끝 + 유예(`RELEASE_WINDOW_GRACE_SECONDS`, 15분)에 릴리스 스윕이 닫을 때까지 보인다. 30분은 그 둘을
 * 덮는다 — 이 값보다 오래 남은 위반은 주기의 지연이 아니라 **닫는 주체가 없다**는 뜻이다(워커 정지·결함).
 */
export const PENDING_OVERDUE_TOLERANCE_SECONDS = 30 * 60;

/**
 * **§4.3 보조 불변식의 자동 감시** — 위반 수를 메트릭(`approvalPendingOverdue`)으로 낸다. 알람 7이 그 위에 선다.
 *
 * 두 주기 워커가 **둘 다** 부른다: TTL 스위퍼(이 파일의 `sweepExpiredRequests`)와 릴리스 스윕
 * (`workers/approval-release.ts`). 위반의 두 갈래(만료 안 된 대기 · 닫히지 않은 릴리스)를 닫는 주체가 각각 그
 * 둘이라, 한쪽이 멈추면 **다른 쪽이** 그 위반을 본다 — 자기가 닫아야 할 행을 자기만 재면 자기가 멈춘 날 아무도
 * 재지 않는다. 같은 값을 둘이 내도 알람은 `Maximum` 이라 두 번 세지 않는다.
 */
export async function measurePendingOverdue(
  store: Pick<ApprovalStore, 'countPendingOverdue'>,
  now: Date,
): Promise<number> {
  const overdue = await store.countPendingOverdue(new Date(now.getTime() - PENDING_OVERDUE_TOLERANCE_SECONDS * 1000));
  emitMetric(METRIC_NAMES.approvalPendingOverdue, overdue, 'Count', {});
  if (overdue > 0) {
    log('error', 'approval.pending_overdue', {
      outcome: 'overdue',
      detail:
        `overdue=${String(overdue)} — §4.3 보조 불변식 위반: 승인 대기도 릴리스 대기도 아닌 pending_approval audit 행이 ` +
        '허용 폭보다 오래 남았다. SELECT * FROM audit_pending_overdue(now()) 로 행을 본다.',
    });
  }
  return overdue;
}

export interface SweepResult {
  readonly expired: readonly string[];
  /** 전이에 진 요청(그 사이 승인·거절됐다). 정상이다 — AC-i4 의 진 쪽. */
  readonly lost: readonly string[];
}

/**
 * **TTL 스위퍼** (§3.4 4조 — "타임아웃 기본동작 = 만료. 절대 auto-send 아님").
 *
 * 만료는 **발송을 하지 않는 것**이 전부다. 어떤 설정도 만료를 발송으로 바꾸지 못한다 — 이 함수에는
 * 그런 분기가 없고, 이 파일은 관문을 import 하지 않는다(머리말 1).
 *
 * 스윕마다 §4.3 보조 불변식의 측정값을 방출한다: 가장 오래된 `pending` 의 나이. 스윕 **뒤**에 재므로
 * 그 값이 TTL 상한(7일)을 넘으면 스위퍼가 무언가를 못 만료시키고 있다는 뜻이다.
 */
export async function sweepExpiredRequests(
  store: ApprovalStore,
  now: Date,
  limit: number,
): Promise<SweepResult> {
  const due = await store.listDue(now, limit);
  const expired: string[] = [];
  const lost: string[] = [];
  for (const approvalId of due) {
    if (await expireRequest(store, approvalId, now)) expired.push(approvalId);
    else lost.push(approvalId);
  }

  const oldest = await store.oldestPendingCreatedAt();
  emitMetric(
    METRIC_NAMES.approvalPendingAgeSeconds,
    oldest === null ? 0 : Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000)),
    'Seconds',
    {},
  );
  await measurePendingOverdue(store, now);
  log('info', 'approval.sweep', {
    outcome: 'swept',
    detail: `expired=${String(expired.length)} lost=${String(lost.length)}`,
  });
  return { expired, lost };
}
