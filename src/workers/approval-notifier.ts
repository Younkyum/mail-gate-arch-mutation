/**
 * `workers/approval-notifier` — **소유자 승인 알림 outbox 를 비운다** (P2, §3.4 5조).
 *
 * **이 워커는 메일을 보내지만 에이전트 메일이 아니다.** 그래서 Layer C 의 두 범주 어디에도 정확히 맞지
 * 않는다 — `OUTBOUND_ROUTES`(관문을 지나는 에이전트 발송)도, `NON_SENDING_ENTRYPOINTS`(발송 없음)도 거짓이다.
 * 세 번째 범주 `SYSTEM_MAIL_ENTRYPOINTS` 에 있다(`policy/manifest.ts`): 관문을 import 하지 **않고**, 등록된
 * 시스템 메일 모듈(`src/notify/approval-notifier.ts`)을 통해서만 보낸다.
 *
 * **이 파일은 무엇을 보낼지도 누구에게 보낼지도 모른다.** 하는 일은 기한이 된 `approval_id` 를 골라
 * `notifier.notify(approvalId)` 를 부르는 것뿐이다 — 알림기의 공개 API 가 그것 하나다. 멱등성·속도 상한·
 * 수신자 결정은 전부 알림기 안(한 트랜잭션의 집기)에 있으므로, 이 워커가 두 번 돌거나 여럿이 동시에 돌아도
 * 요청당 1통·조직당 상한이 유지된다.
 *
 * **워밍업 캡을 먹지 않는다.** 캡은 에이전트 메일(관문 Stage 3)의 제동장치다. 알림이 캡을 먹으면 Day 0 에
 * 전환 공지 20통 + 알림 1통에서 알림이 막히고 요청이 만료된다(리드 결정 (b) 의 근거). 대신 조직당 속도 상한이
 * 스팸 벡터를 닫는다(`APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG`).
 *
 * 스케줄(EventBridge 1분 주기 등)은 인프라의 일이다. 이 함수는 한 번의 배출만 한다.
 */

import type { Queryable } from '../db/client';
import { selectRows } from '../db/repositories/rows';
import type { ApprovalNotifier, ApprovalNotifyOutcome } from '../notify/approval-notifier';

/** 한 번의 배출에서 집을 최대 건수. 넘치면 다음 배출이 이어받는다(기한 순). */
const APPROVAL_NOTIFY_BATCH = 50;

export interface ApprovalNotifierWorkerDependencies {
  /** 기한이 된 `approval_id` 를 고르는 읽기 전용 조회에만 쓴다. */
  readonly db: Queryable;
  readonly notifier: ApprovalNotifier;
  readonly now: () => Date;
}

export type ApprovalNotifyReport = Readonly<Record<ApprovalNotifyOutcome, number>>;

/**
 * 배출 범위. 없으면 전체(운영 스케줄). 조직을 주면 **그 조직의 행만** 고른다 — 공유 DB 에서 도는 테스트·데모가
 * 남의 기한 된 행을 대신 비우지 않게(`scheduled-send-store.claimDue` 의 `scope` 와 같은 이유). 좁히기만 한다 —
 * 멱등성·상한·수신자는 여전히 알림기 안에서 정해진다.
 */
export interface ApprovalNotifyScope {
  readonly organizationId: string;
}

export async function runApprovalNotifier(
  deps: ApprovalNotifierWorkerDependencies,
  scope?: ApprovalNotifyScope,
): Promise<ApprovalNotifyReport> {
  const due = await selectRows<{ approval_id: string }>(
    deps.db,
    `SELECT approval_id FROM approval_notifications
      WHERE status = 'pending' AND next_attempt_at <= $1
        AND ($3::uuid IS NULL OR organization_id = $3::uuid)
      ORDER BY next_attempt_at, created_at
      LIMIT $2`,
    [deps.now(), APPROVAL_NOTIFY_BATCH, scope?.organizationId ?? null],
  );

  const report: Record<ApprovalNotifyOutcome, number> = { sent: 0, deferred: 0, retry: 0, dead: 0, undeliverable: 0, obsolete: 0, not_due: 0 };
  for (const { approval_id: approvalId } of due) {
    report[await deps.notifier.notify(approvalId)] += 1;
  }
  return report;
}
