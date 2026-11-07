/**
 * `workers/domain-notifier` — **고객 도메인 알림 outbox 를 비운다**(ADR-0014 단계 4 M3b · `SYSTEM_MAIL_ENTRYPOINTS` 의 `domain_notice`).
 *
 * 이 워커는 메일을 보내지만 에이전트 메일이 아니다(시스템 메일 범주 — 관문을 import 하지 않고 등록된 발송 모듈 `src/notify/domain-notifier.ts` 만 부른다).
 * **무엇을 누구에게 보낼지 모른다** — 기한이 된 `domain_notices.id` 를 골라 `notifier.send(noticeId)` 를 부를 뿐이다. 수신자(정의자 함수) · 사건 확인 ·
 * 조직 상한 · 재시도는 전부 알림기 안이다. 행은 틱(`src/domains/lifecycle.ts` → `insertNotice`)만 적는다 — 조직 하루 10 · 같은 사건 1번.
 * 승인 알림과 같은 Lambda(`atmark-approval-notifier`, 발송 역할 하나 · DB 앱 롤)의 1분 틱에서 돈다(`handlers/approval-notifier.ts`).
 */

import type { Queryable } from '../db/client';
import { selectRows } from '../db/repositories/rows';
import type { DomainNoticeOutcome, DomainNotifier } from '../notify/domain-notifier';

/** 한 번의 배출에서 집을 최대 건수 — 넘치면 다음 배출이 잇는다(기한 순). */
const DOMAIN_NOTICE_BATCH = 20;

export interface DomainNotifierWorkerDependencies {
  /** 기한이 된 알림 id 를 고르는 읽기 전용 조회에만 쓴다. */
  readonly db: Queryable;
  readonly notifier: DomainNotifier;
  readonly now: () => Date;
}

export type DomainNoticeReport = Readonly<Record<DomainNoticeOutcome, number>>;

/** 배출 범위 — 없으면 전체(운영). 조직을 주면 그 조직의 행만(공유 DB 테스트가 남의 행을 비우지 않게). */
export interface DomainNoticeScope {
  readonly organizationId: string;
}

export async function runDomainNotifier(deps: DomainNotifierWorkerDependencies, scope?: DomainNoticeScope): Promise<DomainNoticeReport> {
  const due = await selectRows<{ id: string }>(
    deps.db,
    `SELECT id::text AS id FROM domain_notices
      WHERE status = 'pending' AND next_attempt_at <= $1
        AND ($3::uuid IS NULL OR organization_id = $3::uuid)
      ORDER BY next_attempt_at, created_at, id
      LIMIT $2`,
    [deps.now(), DOMAIN_NOTICE_BATCH, scope?.organizationId ?? null],
  );
  const report: Record<DomainNoticeOutcome, number> = { sent: 0, retry: 0, dead: 0, obsolete: 0, deferred: 0, not_due: 0 };
  for (const { id } of due) report[await deps.notifier.send(id)] += 1;
  return report;
}
