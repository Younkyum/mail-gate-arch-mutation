/**
 * `workers/invite-mailer` — **조직 초대 outbox 를 비운다** (확장성 P1 R-1).
 *
 * 가입 메일 워커(`signup-mailer.ts`)와 같은 범주(`SYSTEM_MAIL_ENTRYPOINTS` 의 `invite_notify`)다: 관문을 import 하지 않고 등록된 시스템
 * 메일 모듈(`src/notify/invite-notifier.ts`) 하나로만 보낸다. **이 파일은 무엇을 누구에게 보낼지 모른다** — 기한이 된 초대 id 를 골라
 * `notifier.notify(id)` 를 부를 뿐이다. 수신자·만료·억제·전역 상한은 알림기의 집기 트랜잭션 안에서 정해진다.
 *
 * 로그인·가입 메일과 **같은 전용 Lambda `atmark-login-mailer`**(`runtime/handlers/login-mailer.ts`, 1분 틱)에서 돈다 — 발송 주체를
 * 늘리지 않는다(ADR-0006).
 */

import type { Queryable } from '../db/client';
import { selectRows } from '../db/repositories/rows';
import type { InviteNotifier, InviteNotifyOutcome } from '../notify/invite-notifier';

const INVITE_NOTIFY_BATCH = 20;

export interface InviteMailerWorkerDependencies {
  /** 기한이 된 초대 id 를 고르는 읽기 전용 조회에만 쓴다. */
  readonly db: Queryable;
  readonly notifier: InviteNotifier;
  readonly now: () => Date;
}

export type InviteNotifyReport = Readonly<Record<InviteNotifyOutcome, number>>;

/** 범위 — 초대 id 들을 주면 그 행만(공유 DB 테스트가 남의 행을 비우지 않게). 좁히기만 한다. */
export async function runInviteMailer(
  deps: InviteMailerWorkerDependencies,
  scope?: { readonly inviteIds: readonly string[] },
): Promise<InviteNotifyReport> {
  const due = await selectRows<{ id: string }>(
    deps.db,
    `SELECT id FROM org_invites
      WHERE status = 'pending' AND next_attempt_at <= $1
        AND ($3::uuid[] IS NULL OR id = ANY ($3::uuid[]))
      ORDER BY next_attempt_at, created_at
      LIMIT $2`,
    [deps.now(), INVITE_NOTIFY_BATCH, scope === undefined ? null : [...scope.inviteIds]],
  );
  const report: Record<InviteNotifyOutcome, number> = { sent: 0, retry: 0, dead: 0, undeliverable: 0, obsolete: 0, not_due: 0 };
  for (const { id } of due) report[await deps.notifier.notify(id)] += 1;
  return report;
}
