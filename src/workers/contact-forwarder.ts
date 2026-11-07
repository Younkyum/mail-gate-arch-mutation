/**
 * `workers/contact-forwarder` — **문의 전달 outbox 를 비운다** (US-009, ADR-0009).
 *
 * 시스템 메일 범주(`SYSTEM_MAIL_ENTRYPOINTS` 의 `contact_forward`): 관문을 import 하지 않고, 등록된 시스템 메일 모듈
 * (`src/notify/contact-forwarder.ts`)을 통해서만 보낸다. **이 파일은 무엇을 누구에게 보낼지 모른다** — 기한이 된 `contact_forwards.id`
 * 를 골라 `forwarder.forward(id)` 를 부를 뿐이다. 수신자·상한·멱등·루프 판정은 전부 모듈 안에 있다.
 *
 * 스케줄은 인프라의 일이다(Lambda `atmark-contact-forwarder`, EventBridge 1분). 이 함수는 한 번의 배출만 한다.
 */

import type { Queryable } from '../db/client';
import { selectRows } from '../db/repositories/rows';
import type { ContactForwarder, ContactForwardOutcome } from '../notify/contact-forwarder';

/** 한 번의 배출에서 집을 최대 건수 — 전역 상한(시간당 30)보다 작다. */
const CONTACT_FORWARD_BATCH = 20;

export interface ContactForwarderWorkerDependencies {
  /** 기한이 된 id 를 고르는 읽기 전용 조회에만 쓴다. */
  readonly db: Queryable;
  readonly forwarder: ContactForwarder;
  readonly now: () => Date;
}

export type ContactForwardReport = Readonly<Record<ContactForwardOutcome, number>>;

export async function runContactForwarder(deps: ContactForwarderWorkerDependencies): Promise<ContactForwardReport> {
  const due = await selectRows<{ id: string }>(
    deps.db,
    `SELECT id FROM contact_forwards
      WHERE status = 'pending' AND next_attempt_at <= $1
      ORDER BY next_attempt_at, created_at
      LIMIT $2`,
    [deps.now(), CONTACT_FORWARD_BATCH],
  );

  const report: Record<ContactForwardOutcome, number> = { sent: 0, deferred: 0, retry: 0, dead: 0, suppressed: 0, unconfigured: 0, not_due: 0 };
  for (const { id } of due) {
    const outcome = await deps.forwarder.forward(id);
    report[outcome] += 1;
    // 전달 주소가 없으면 나머지도 같다 — 이번 틱은 여기서 멈춘다(로그·메트릭을 행 수만큼 뿜지 않는다).
    if (outcome === 'unconfigured') break;
  }
  return report;
}
