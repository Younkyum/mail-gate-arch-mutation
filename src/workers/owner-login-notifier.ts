/**
 * `workers/owner-login-notifier` — **소유자 로그인 링크 outbox 를 비운다** (관리 계약).
 *
 * 승인 알림 워커(`approval-notifier.ts`)와 같은 범주(`SYSTEM_MAIL_ENTRYPOINTS`)다: 관문을 import 하지 않고 등록된 시스템
 * 메일 모듈(`src/notify/owner-login-notifier.ts`) 하나로만 보낸다. **이 파일은 무엇을 누구에게 보낼지 모른다** — 기한이
 * 된 링크 id 를 골라 `notifier.notify(id)` 를 부를 뿐이다. 수신자·만료·상한은 알림기의 집기 트랜잭션 안에서 정해진다.
 *
 * **전용 Lambda `atmark-login-mailer`**(`runtime/handlers/login-mailer.ts`, 1분 틱)에서만 돈다 — 역할 atmark-runtime-login-mailer,
 * DB 롤 atmark_login_mailer(ADR-0006). 승인 알림 Lambda(발송 역할 = api 와 같은 역할)에서 돌리지 않는 이유: 이 경로는 로그인
 * 키를 쥐어야 하고, 로그인 키 + 링크 id·만료는 곧 소유자 세션이다.
 */

import type { Queryable } from '../db/client';
import { selectRows } from '../db/repositories/rows';
import type { OwnerLoginNotifier, OwnerLoginNotifyOutcome } from '../notify/owner-login-notifier';

const OWNER_LOGIN_NOTIFY_BATCH = 20;

export interface OwnerLoginNotifierWorkerDependencies {
  /** 기한이 된 링크 id 를 고르는 읽기 전용 조회에만 쓴다. */
  readonly db: Queryable;
  readonly notifier: OwnerLoginNotifier;
  readonly now: () => Date;
}

export type OwnerLoginNotifyReport = Readonly<Record<OwnerLoginNotifyOutcome, number>>;

/** 범위 — 조직을 주면 그 조직의 행만(공유 DB 테스트가 남의 행을 비우지 않게). 좁히기만 한다. */
export async function runOwnerLoginNotifier(
  deps: OwnerLoginNotifierWorkerDependencies,
  scope?: { readonly organizationId: string },
): Promise<OwnerLoginNotifyReport> {
  const due = await selectRows<{ id: string }>(
    deps.db,
    `SELECT id FROM owner_login_links
      WHERE status = 'pending' AND next_attempt_at <= $1
        AND ($3::uuid IS NULL OR organization_id = $3::uuid)
      ORDER BY next_attempt_at, created_at
      LIMIT $2`,
    [deps.now(), OWNER_LOGIN_NOTIFY_BATCH, scope?.organizationId ?? null],
  );
  const report: Record<OwnerLoginNotifyOutcome, number> = { sent: 0, deferred: 0, retry: 0, dead: 0, undeliverable: 0, obsolete: 0, not_due: 0 };
  for (const { id } of due) report[await deps.notifier.notify(id)] += 1;
  return report;
}
