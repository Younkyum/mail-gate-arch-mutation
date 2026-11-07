/**
 * `workers/quarantine-notifier` — **격리 알림 outbox 를 비운다**(ADR-0016 2026-10-07 개정 · `SYSTEM_MAIL_ENTRYPOINTS` 의 `quarantine_notice`).
 *
 * 이 워커는 메일을 보내지만 에이전트 메일이 아니다(시스템 메일 범주 — 관문을 import 하지 않고 등록된 발송 모듈 `src/notify/quarantine-notifier.ts` 만 부른다).
 * **무엇을 누구에게 보낼지 모른다** — 기한이 된 `quarantine_notices.id` 를 골라 `notifier.send(noticeId)` 를 부를 뿐이다. 수신자(정의자 함수) · 묵은 창 ·
 * 조직 상한 · 재시도는 전부 알림기 안이다. 행은 수신 트리거(`quarantine_notice_record()` — 에이전트당 열린 창 하나 · 15분 간격)만 적는다.
 * 승인 알림과 같은 Lambda(`atmark-approval-notifier`, 발송 역할 하나 · DB 앱 롤)의 1분 틱에서 돈다(`handlers/approval-notifier.ts`) —
 * 운영자 킬 스위치 `ATMARK_QUARANTINE_NOTICE=off` 면 조립 루트가 이 워커를 싣지 않는다.
 *
 * **대조(보안 리뷰 L1):** 수신 트리거는 실패를 삼키고(메일 기록이 먼저다) 에이전트 잠금을 기다리지 않는다 — 그렇게 세지 못한 격리가 조용히 사라지지 않게,
 * 틱마다 최근 24시간 격리 메일(스캐너 격리 · 판정 없음) 중 항목 행이 없는 수를 메트릭 `atmark.quarantine_notice.unrecorded` 로 내고 0 보다 크면 warn 로그.
 * 하한은 24시간 전과 트리거가 생긴 시각(`quarantine_notice_started_at()` — 202610071000 적용 시각) 중 늦은 쪽이다(트리거 전 격리 메일을 세지 않는다).
 * 알람은 두지 않는다(비용 — 대시보드). 부분 색인 `inbound_messages_quarantine_created_idx`(202610071001)를 탄다. 메일의 내용 칸은 읽지 않는다(수 하나).
 */

import type { Queryable } from '../db/client';
import { selectRow, selectRows } from '../db/repositories/rows';
import type { QuarantineNoticeOutcome, QuarantineNotifier } from '../notify/quarantine-notifier';
import { log } from '../observability/logger';
import { emitMetric, METRIC_NAMES } from '../observability/metrics';

/** 한 번의 배출에서 집을 최대 건수 — 넘치면 다음 배출이 잇는다(기한 순). */
const QUARANTINE_NOTICE_BATCH = 20;

export interface QuarantineNotifierWorkerDependencies {
  /** 기한이 된 알림 id 를 고르는 읽기 전용 조회에만 쓴다. */
  readonly db: Queryable;
  readonly notifier: QuarantineNotifier;
  readonly now: () => Date;
}

/** 결말별 수 + 대조(`unrecorded` — 최근 24시간 격리 중 창에 묶이지 않은 메일 수). */
export type QuarantineNoticeReport = Readonly<Record<QuarantineNoticeOutcome | 'unrecorded', number>>;

const ROUTE_ID = 'quarantine_notice';

/** 배출 범위 — 없으면 전체(운영). 조직을 주면 그 조직의 행만(공유 DB 테스트가 남의 행을 비우지 않게). */
export interface QuarantineNoticeScope {
  readonly organizationId: string;
}

export async function runQuarantineNotifier(deps: QuarantineNotifierWorkerDependencies, scope?: QuarantineNoticeScope): Promise<QuarantineNoticeReport> {
  const due = await selectRows<{ id: string }>(
    deps.db,
    `SELECT id::text AS id FROM quarantine_notices
      WHERE status = 'pending' AND next_attempt_at <= $1
        AND ($3::uuid IS NULL OR organization_id = $3::uuid)
      ORDER BY next_attempt_at, first_at, id
      LIMIT $2`,
    [deps.now(), QUARANTINE_NOTICE_BATCH, scope?.organizationId ?? null],
  );
  const report: Record<QuarantineNoticeOutcome | 'unrecorded', number> = { sent: 0, suppressed: 0, retry: 0, dead: 0, obsolete: 0, not_due: 0, unrecorded: 0 };
  for (const { id } of due) report[await deps.notifier.send(id)] += 1;

  const missing = await selectRow<{ n: number }>(
    deps.db,
    `SELECT count(*)::int AS n FROM inbound_messages m
      WHERE m.quarantine_reason IN ('injection_risk', 'scanner_error')
        AND m.created_at > greatest($1::timestamptz, quarantine_notice_started_at())
        AND ($2::uuid IS NULL OR m.agent_id IN (SELECT a.id FROM agents a WHERE a.organization_id = $2::uuid))
        AND NOT EXISTS (SELECT 1 FROM quarantine_notice_items i WHERE i.inbound_message_id = m.id)`,
    [new Date(deps.now().getTime() - 24 * 3_600_000), scope?.organizationId ?? null],
  );
  report.unrecorded = missing?.n ?? 0;
  emitMetric(METRIC_NAMES.quarantineNoticeUnrecorded, report.unrecorded, 'Count', { route_id: ROUTE_ID });
  if (report.unrecorded > 0) {
    log('warn', 'quarantine_notice.unrecorded', { route_id: ROUTE_ID, outcome: 'unrecorded', detail: `count=${String(report.unrecorded)} window=24h` });
  }
  return report;
}
