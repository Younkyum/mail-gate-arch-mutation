/**
 * `workers/welcome-mailer` — **셀프 가입 환영 메일 outbox 를 비운다** (2026-09-30).
 *
 * 초대 메일 워커(`invite-mailer.ts`)와 같은 범주(`SYSTEM_MAIL_ENTRYPOINTS` 의 `welcome_notify`)다: 관문을 import 하지 않고 등록된 시스템
 * 메일 모듈(`src/notify/welcome-notifier.ts`) 하나로만 보낸다. **이 파일은 무엇을 누구에게 보낼지 모른다** — 기한이 된 행 id 를 골라
 * `notifier.send(id)` 를 부를 뿐이다. 수신자·언어·억제·48시간·전역 상한은 알림기의 집기 트랜잭션 안에서 정해진다.
 *
 * 로그인·가입·초대 메일과 **같은 전용 Lambda `atmark-login-mailer`**(`runtime/handlers/login-mailer.ts`, 1분 틱)에서 돈다 — 기능 플래그
 * `ATMARK_WELCOME_MAIL_ENABLED` 가 켜졌을 때만(꺼져 있으면 그 λ 가 이 워커를 부르지 않는다).
 */

import type { Queryable } from '../db/client';
import { selectRows } from '../db/repositories/rows';
import type { WelcomeNotifier, WelcomeNotifyOutcome } from '../notify/welcome-notifier';

const WELCOME_NOTIFY_BATCH = 20;

export interface WelcomeMailerWorkerDependencies {
  /** 기한이 된 행 id 를 고르는 읽기 전용 조회에만 쓴다. */
  readonly db: Queryable;
  readonly notifier: WelcomeNotifier;
  readonly now: () => Date;
}

export type WelcomeNotifyReport = Readonly<Record<WelcomeNotifyOutcome, number>>;

/** 범위 — 행 id 들을 주면 그 행만(공유 DB 테스트가 남의 행을 비우지 않게). 좁히기만 한다. */
export async function runWelcomeMailer(
  deps: WelcomeMailerWorkerDependencies,
  scope?: { readonly welcomeIds: readonly string[] },
): Promise<WelcomeNotifyReport> {
  const due = await selectRows<{ id: string }>(
    deps.db,
    `SELECT id FROM welcome_mails
      WHERE status = 'pending' AND next_attempt_at <= $1
        AND ($3::uuid[] IS NULL OR id = ANY ($3::uuid[]))
      ORDER BY next_attempt_at, created_at
      LIMIT $2`,
    [deps.now(), WELCOME_NOTIFY_BATCH, scope === undefined ? null : [...scope.welcomeIds]],
  );
  const report: Record<WelcomeNotifyOutcome, number> = { sent: 0, retry: 0, dead: 0, undeliverable: 0, obsolete: 0, deferred: 0, not_due: 0 };
  for (const { id } of due) report[await deps.notifier.send(id)] += 1;
  return report;
}
