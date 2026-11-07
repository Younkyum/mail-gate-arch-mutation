/**
 * src/notify/waitlist-notifier.ts — **대기 확인 · 초대 메일의 전용 발송 경로** (202609301520).
 *
 * 다른 시스템 메일(로그인·가입·초대·환영)과 **같은 규율**의 여덟 번째 시스템 메일이다:
 *
 *   1. **공개 API 는 `mailId` 하나만 받는다.** 수신자·제목·본문·URL 을 인자로 받는 함수가 이 모듈에 없다. 의존성에도 문자열이 없다(풀·SES 호출면·
 *      시계·숫자 상한). 발신 주소·표시 이름·문구는 상수다(발신은 환영 메일과 같은 `onve@atmark.ai` — `welcome-notifier.ts` 의 상수를 그대로 쓴다).
 *   2. **수신자는 DB 의 `waitlist_entries.email` 에서만 나온다** — 메일 행 → 항목. 행은 소유자 함수만 만든다: 확인 메일은 `waitlist_join`(대기 등록 —
 *      주소당 30일에 한 통, admin 의 요청자·같은 주소 상한 뒤), 초대 메일은 운영자 초대(`waitlist_invite_core` — 전역 하루 5, 202609301530). 층을 둔다: 항목이
 *      지워졌거나 비었으면(가입 · 지우기 · 보존 과제) `obsolete` · 초대 메일은 항목의 초대가 쌓을 때와 같고 살아 있을 때만(다시 초대 · 만료면 `obsolete`) ·
 *      확인 메일은 아직 기다리는 항목에만 · 48시간이 지난 확인 메일은 `obsolete` · 시스템 메일 억제 주소는 `undeliverable` · **전역 시간당 상한 둘**
 *      (초대 `WAITLIST_MAIL_HOURLY_CAP` 60 · 확인 `WAITLIST_CONFIRMATION_HOURLY_CAP` 20 — 따로 센다) — 넘으면 **버리지 않고 미룬다**(`deferred`).
 *   3. **전송단에서 쓰는 것은 알림면뿐이다** — 에이전트 전송단을 참조하지 않는다.
 *
 * 진입점은 `workers/waitlist-mailer.ts` 하나이고(`SYSTEM_MAIL_ENTRYPOINTS` 의 `waitlist_notify`), 로그인·가입·초대·환영 메일과 **같은 전용 Lambda
 * `atmark-login-mailer`**(DB 롤 atmark_login_mailer — 이 outbox 의 발송 칸과 항목의 id·주소·상태·초대 만료·용도만 — 용도는 확인 메일의 보류 문단,
 * 202609301530)에서 돈다.
 */

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../db/client';
import { selectRow } from '../db/repositories/rows';
import { resolveMailLocale, type MailLocale } from '../i18n/locales';
import { createSesNotificationTransport, type SesSendClient } from '../mail/transport/ses-transport';
import { log } from '../observability/logger';
import { renderWaitlistMail, type WaitlistMailKind } from './waitlist-template';
import { WELCOME_FROM_ADDRESS, WELCOME_FROM_HEADER } from './welcome-notifier';

/** 관측 축의 `route_id` — `SYSTEM_MAIL_ENTRYPOINTS` 의 id 와 같다. */
export const WAITLIST_NOTIFY_ROUTE_ID = 'waitlist_notify';

/** 초대 메일의 전역 시간당 상한 — 넘으면 미룬다(버리지 않는다). 운영 조립은 **항상** 이 상수를 넘긴다(arch 테스트). */
export const WAITLIST_MAIL_HOURLY_CAP = 60;

/**
 * 대기 확인 메일의 전역 시간당 상한 — 초대와 **따로 센다**(보안 검토 2026-09-30: 남이 아무 주소나 등록해 onve@ 로 메일을 보내게 하는 길의 총량을 좁게
 * 묶고, 그 남용이 초대 메일의 창을 비우지 못하게). 넘으면 미룬다 — 48시간이 지나면 obsolete. 운영 조립은 **항상** 이 상수를 넘긴다(arch 테스트).
 */
export const WAITLIST_CONFIRMATION_HOURLY_CAP = 20;

const RATE_WINDOW_MS = 60 * 60 * 1000;
/** 이보다 오래된 확인 메일은 보내지 않는다(`obsolete`, `stale`) — 등록 직후의 편지다. 초대 메일은 초대 만료가 기한이다. */
const CONFIRMATION_STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const DEFER_MS = 10 * 60 * 1000;
const CLAIM_LEASE_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30 * 1000;
/** `last_error` 에 적는 발송 표식(환영 메일과 같은 규율) — SES 호출 **전에** claim 과 함께 적고, `markSent`·`markFailed` 가 지운다. lease 가 끝난 행에
 * 이 표식이 남아 있으면 호출이 나갔는지 모른다 — 다시 보내지 않고 `dead(send_unknown)`(**최대 1통**). */
const SENDING_MARK = 'sending';
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 결말. `obsolete` = 항목이 없거나 · 상태가 바뀌었거나 · 오래됨, `undeliverable` = 억제 주소, `dead` = 재시도 소진 또는 앞선 시도의 결과를 모른다
 * (`send_unknown` — 다시 보내지 않는다), `deferred` = 전역 상한 — 다음 창으로 미뤘다.
 */
export type WaitlistNotifyOutcome = 'sent' | 'retry' | 'dead' | 'undeliverable' | 'obsolete' | 'deferred' | 'not_due';

/** 의존성 — **문자열이 하나도 없다**(속성 이름·타입은 arch 테스트가 동결한다). */
export interface WaitlistNotifierDependencies {
  readonly pool: Pool;
  readonly client: SesSendClient;
  readonly now: () => Date;
  /** 초대 메일의 전역 시간당 상한. 운영 조립은 **항상** `WAITLIST_MAIL_HOURLY_CAP` 을 넘긴다(arch 테스트). */
  readonly capPerHour: number;
  /** 확인 메일의 전역 시간당 상한(초대와 따로). 운영 조립은 **항상** `WAITLIST_CONFIRMATION_HOURLY_CAP` 을 넘긴다(arch 테스트). */
  readonly confirmationCapPerHour: number;
}

/** 공개 API 전부. **메서드 하나, 인자 하나.** */
export interface WaitlistNotifier {
  send(mailId: string): Promise<WaitlistNotifyOutcome>;
}

interface CandidateRow {
  id: string;
  kind: WaitlistMailKind;
  lang: string;
  invite_expires_at: Date | null;
  attempt_count: number;
  last_error: string | null;
  created_at: Date;
  entry_email: string | null;
  entry_status: string | null;
  entry_invite_expires_at: Date | null;
  entry_use_case: string | null;
  /** 쌓을 때의 초대 만료 = 항목의 지금 초대 만료(DB 가 마이크로초로 비교 — JS Date 는 밀리초라 1ms 안의 다시 초대를 같게 본다). */
  invite_same: boolean;
}

interface Claimed {
  readonly kind: 'claimed';
  readonly mailId: string;
  readonly mailKind: WaitlistMailKind;
  readonly attempt: number;
  readonly email: string;
  readonly locale: MailLocale;
  /** 확인 메일의 보류 조건부 문단(항목의 용도가 `outreach` — 202609301530). */
  readonly hold: boolean;
}

type ObsoleteReason = 'entry_gone' | 'stale' | 'not_waiting' | 'invite_changed';

type ClaimResult =
  | Claimed
  | { readonly kind: 'not_due' }
  | { readonly kind: 'deferred'; readonly reason: 'global_cap' }
  | { readonly kind: 'obsolete'; readonly reason: ObsoleteReason }
  | { readonly kind: 'undeliverable'; readonly reason: 'suppressed' }
  | { readonly kind: 'dead'; readonly reason: 'send_unknown' };

async function settle(client: PoolClient, mailId: string, status: 'undeliverable' | 'obsolete' | 'dead', reason: string, now: Date): Promise<void> {
  await client.query(`UPDATE waitlist_mails SET status = $2, settled_at = $3, last_error = $4 WHERE id = $1 AND status = 'pending'`, [
    mailId,
    status,
    now,
    reason,
  ]);
}

/** 이 메일을 지금 보내도 되나 — 안 되면 그 이유(obsolete). */
function obsoleteReason(row: CandidateRow, now: Date): ObsoleteReason | null {
  if (row.entry_email === null || row.entry_status === null) return 'entry_gone';
  if (row.kind === 'confirmation') {
    if (row.created_at.getTime() + CONFIRMATION_STALE_AFTER_MS <= now.getTime()) return 'stale';
    const inviteLive = row.entry_status === 'invited' && row.entry_invite_expires_at !== null && row.entry_invite_expires_at.getTime() > now.getTime();
    return row.entry_status === 'waiting' || (row.entry_status === 'invited' && !inviteLive) ? null : 'not_waiting';
  }
  // 초대 메일 — 쌓을 때의 초대 그대로이고 아직 살아 있을 때만(다시 초대했으면 새 메일 행이 간다).
  if (
    row.entry_status !== 'invited' ||
    row.invite_expires_at === null ||
    row.entry_invite_expires_at === null ||
    !row.invite_same ||
    row.invite_expires_at.getTime() <= now.getTime()
  ) {
    return 'invite_changed';
  }
  return null;
}

async function claim(client: PoolClient, mailId: string, now: Date, caps: { readonly invitation: number; readonly confirmation: number }): Promise<ClaimResult> {
  // **수신자가 나오는 유일한 조회다.** 메일 행 → 항목(수신자). 항목이 없으면(지웠다) 주소도 없다.
  const row = await selectRow<CandidateRow>(
    client,
    `SELECT m.id, m.kind, m.lang, m.invite_expires_at, m.attempt_count, m.last_error, m.created_at,
            e.email AS entry_email, e.status AS entry_status, e.invite_expires_at AS entry_invite_expires_at, e.use_case AS entry_use_case,
            (m.invite_expires_at IS NOT DISTINCT FROM e.invite_expires_at) AS invite_same
       FROM waitlist_mails m
       LEFT JOIN waitlist_entries e ON e.id = m.entry_id
      WHERE m.id = $1 AND m.status = 'pending' AND m.next_attempt_at <= $2
      FOR UPDATE OF m SKIP LOCKED`,
    [mailId, now],
  );
  if (row === null) return { kind: 'not_due' };
  // 앞선 시도가 SES 호출 뒤 기록 전에 죽었다 — 나갔는지 모른다. 다시 보내지 않는다(최대 1통).
  if (row.last_error === SENDING_MARK) {
    await settle(client, row.id, 'dead', 'send_unknown', now);
    return { kind: 'dead', reason: 'send_unknown' };
  }
  const reason = obsoleteReason(row, now);
  if (reason !== null) {
    await settle(client, row.id, 'obsolete', reason, now);
    return { kind: 'obsolete', reason };
  }
  const email = row.entry_email ?? '';
  // 시스템 메일 억제(202609240900 — 하드 바운스·불만). 주소 칸 하나만 읽는다.
  const suppressed = await selectRow<{ suppressed: boolean }>(
    client,
    'SELECT EXISTS (SELECT 1 FROM system_mail_suppressions WHERE address = $1) AS suppressed',
    [email],
  );
  if (suppressed?.suppressed !== false) {
    await settle(client, row.id, 'undeliverable', 'suppressed', now);
    return { kind: 'undeliverable', reason: 'suppressed' };
  }
  // 전역 상한 — 한 시간 창 안에 집힌 **같은 종류** 행 수(초대 · 확인 따로). 종류마다 잠금 아래라 동시 워커가 함께 넘지 못한다. 넘으면 **미룬다**.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('waitlist_notify:global:' || $1::text, 0))`, [row.kind]);
  const usage = await selectRow<{ used: number }>(
    client,
    'SELECT count(*)::int AS used FROM waitlist_mails WHERE kind = $3 AND claimed_at > $1 AND claimed_at <= $2',
    [new Date(now.getTime() - RATE_WINDOW_MS), now, row.kind],
  );
  if ((usage?.used ?? 0) >= (row.kind === 'invitation' ? caps.invitation : caps.confirmation)) {
    await client.query(`UPDATE waitlist_mails SET next_attempt_at = $2 WHERE id = $1 AND status = 'pending'`, [row.id, new Date(now.getTime() + DEFER_MS)]);
    return { kind: 'deferred', reason: 'global_cap' };
  }
  const attempt = row.attempt_count + 1;
  await client.query(
    `UPDATE waitlist_mails SET attempt_count = $2, claimed_at = $3, next_attempt_at = $4, last_error = $5 WHERE id = $1 AND status = 'pending'`,
    [row.id, attempt, now, new Date(now.getTime() + CLAIM_LEASE_MS), SENDING_MARK],
  );
  return {
    kind: 'claimed',
    mailId: row.id,
    mailKind: row.kind,
    attempt,
    email,
    // 받는 사람은 아직 사용자가 아니다 — 대기 등록 때의 화면 언어 → 'en'.
    locale: resolveMailLocale(row.lang),
    hold: row.entry_use_case === 'outreach',
  };
}

async function markSent(pool: Pool, claimed: Claimed, sesMessageId: string, now: Date): Promise<boolean> {
  const result = await pool.query(
    `UPDATE waitlist_mails SET status = 'sent', sent_at = $3, ses_message_id = $4, last_error = NULL
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.mailId, claimed.attempt, now, sesMessageId],
  );
  return result.rowCount === 1;
}

async function markFailed(pool: Pool, claimed: Claimed, now: Date): Promise<'retry' | 'dead'> {
  if (claimed.attempt >= MAX_ATTEMPTS) {
    await pool.query(
      `UPDATE waitlist_mails SET status = 'dead', settled_at = $3, last_error = 'send_failed'
        WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
      [claimed.mailId, claimed.attempt, now],
    );
    return 'dead';
  }
  await pool.query(
    `UPDATE waitlist_mails SET next_attempt_at = $3, last_error = 'send_failed'
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.mailId, claimed.attempt, new Date(now.getTime() + RETRY_BASE_MS * 2 ** (claimed.attempt - 1))],
  );
  return 'retry';
}

/** 알림기를 만든다. 반환하는 것은 `send(mailId)` **하나뿐**이다. */
export function createWaitlistNotifier(deps: WaitlistNotifierDependencies): WaitlistNotifier {
  for (const [name, cap] of [['capPerHour', deps.capPerHour], ['confirmationCapPerHour', deps.confirmationCapPerHour]] as const) {
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error(`${name} 은 1 이상의 정수여야 한다: ${String(cap)}`);
  }
  const caps = { invitation: deps.capPerHour, confirmation: deps.confirmationCapPerHour };
  const transport = createSesNotificationTransport({ client: deps.client, now: deps.now });
  return {
    async send(mailId: string): Promise<WaitlistNotifyOutcome> {
      if (!ID_PATTERN.test(mailId)) throw new Error(`mailId 는 정규형 uuid 여야 한다: ${JSON.stringify(mailId)}`);
      const claimed = await withTransaction(deps.pool, (client) => claim(client, mailId, deps.now(), caps));
      if (claimed.kind !== 'claimed') {
        if (claimed.kind !== 'not_due') {
          // 주소는 싣지 않는다 — 행 id(추적)와 사유만.
          log(claimed.kind === 'dead' ? 'error' : claimed.kind === 'deferred' ? 'warn' : 'info', `waitlist_notify.${claimed.kind}`, {
            route_id: WAITLIST_NOTIFY_ROUTE_ID,
            trace_id: mailId,
            detail: claimed.reason,
          });
        }
        return claimed.kind;
      }
      let sesMessageId: string;
      try {
        const rendered = renderWaitlistMail({ kind: claimed.mailKind, email: claimed.email, hold: claimed.hold }, claimed.locale);
        ({ sesMessageId } = await transport.sendOwnerNotification({
          notificationId: claimed.mailId,
          fromAddress: WELCOME_FROM_ADDRESS,
          fromHeader: WELCOME_FROM_HEADER,
          toAddress: claimed.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        }));
      } catch (error) {
        const outcome = await markFailed(deps.pool, claimed, deps.now());
        log(outcome === 'dead' ? 'error' : 'warn', 'waitlist_notify.failed', {
          route_id: WAITLIST_NOTIFY_ROUTE_ID,
          trace_id: mailId,
          outcome,
          error_kind: error instanceof Error ? error.name : typeof error,
        });
        return outcome;
      }
      // 이미 나갔다 — 기록 실패로 던지면 재시도가 두 번째 메일을 만든다.
      const settled = await markSent(deps.pool, claimed, sesMessageId, deps.now()).catch(() => false);
      log(settled ? 'info' : 'warn', 'waitlist_notify.sent', {
        route_id: WAITLIST_NOTIFY_ROUTE_ID,
        trace_id: mailId,
        detail: claimed.mailKind,
        ses_message_id: sesMessageId,
        settled,
      });
      return 'sent';
    },
  };
}
