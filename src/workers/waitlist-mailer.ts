/**
 * `workers/waitlist-mailer` — **대기 확인 · 초대 메일 outbox 를 비운다** (202609301520).
 *
 * 환영 메일 워커(`welcome-mailer.ts`)와 같은 범주(`SYSTEM_MAIL_ENTRYPOINTS` 의 `waitlist_notify`)다: 관문을 import 하지 않고 등록된 시스템 메일
 * 모듈(`src/notify/waitlist-notifier.ts`) 하나로만 보낸다. **이 파일은 무엇을 누구에게 보낼지 모른다** — 기한이 된 행 id 를 골라
 * `notifier.send(id)` 를 부를 뿐이다. 수신자·언어·억제·상태 재확인·전역 상한은 알림기의 집기 트랜잭션 안에서 정해진다.
 *
 * 로그인·가입·초대·환영 메일과 **같은 전용 Lambda `atmark-login-mailer`**(`runtime/handlers/login-mailer.ts`, 1분 틱 + admin·ops 의 깨우기)에서 돈다.
 */

import type { Queryable } from '../db/client';
import { selectRows } from '../db/repositories/rows';
import type { WaitlistNotifier, WaitlistNotifyOutcome } from '../notify/waitlist-notifier';

const WAITLIST_NOTIFY_BATCH = 20;

export interface WaitlistMailerWorkerDependencies {
  /** 기한이 된 행 id 를 고르는 읽기 전용 조회에만 쓴다. */
  readonly db: Queryable;
  readonly notifier: WaitlistNotifier;
  readonly now: () => Date;
}

export type WaitlistNotifyReport = Readonly<Record<WaitlistNotifyOutcome, number>>;

/** 범위 — 행 id 들을 주면 그 행만(공유 DB 테스트가 남의 행을 비우지 않게). 좁히기만 한다. 초대 메일을 확인 메일보다 먼저. */
export async function runWaitlistMailer(
  deps: WaitlistMailerWorkerDependencies,
  scope?: { readonly mailIds: readonly string[] },
): Promise<WaitlistNotifyReport> {
  const due = await selectRows<{ id: string }>(
    deps.db,
    `SELECT id FROM waitlist_mails
      WHERE status = 'pending' AND next_attempt_at <= $1
        AND ($3::uuid[] IS NULL OR id = ANY ($3::uuid[]))
      ORDER BY (kind = 'invitation') DESC, next_attempt_at, created_at
      LIMIT $2`,
    [deps.now(), WAITLIST_NOTIFY_BATCH, scope === undefined ? null : [...scope.mailIds]],
  );
  const report: Record<WaitlistNotifyOutcome, number> = { sent: 0, retry: 0, dead: 0, undeliverable: 0, obsolete: 0, deferred: 0, not_due: 0 };
  for (const { id } of due) report[await deps.notifier.send(id)] += 1;
  return report;
}
