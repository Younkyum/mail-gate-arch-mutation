/**
 * src/notify/welcome-notifier.ts — **셀프 가입 환영 메일의 전용 발송 경로** (2026-09-30).
 *
 * 다른 시스템 메일(로그인·가입·초대)과 **같은 규율**의 일곱 번째 시스템 메일이다:
 *
 *   1. **공개 API 는 `welcomeId` 하나만 받는다.** 수신자·제목·본문·URL 을 인자로 받는 함수가 이 모듈에 없다. 의존성에도 문자열이 없다
 *      (풀·SES 호출면·시계·숫자 상한). 발신 주소·표시 이름·콘솔 URL·문구는 상수다.
 *   2. **수신자는 DB 의 `users.email` 에서만 나온다** — 환영 메일 행 → 사용자(`welcome_mails.user_id`). 행은 `create_signup_organization`
 *      (SECURITY DEFINER)이 **새 가입**에서만, 사용자당 한 번 만든다 — 가입 링크를 쥔 브라우저가 링크·코드로 주소를 증명한 뒤다. 그래서 이 메일은
 *      임의 주소로 가지 않는다. 그래도 층을 둔다: 지운 사용자(`erased.invalid` 자리표시)·시스템 메일 억제 주소는 `undeliverable` · 48시간이 지난 행은
 *      `obsolete`(플래그를 늦게 켜도 오래된 가입자에게 한꺼번에 가지 않는다) · **전역 시간당 상한**(`WELCOME_MAIL_HOURLY_CAP`) — 넘으면 **버리지
 *      않고 미룬다**(`deferred` — 48시간 안이면 다음 창에 간다).
 *   3. **전송단에서 쓰는 것은 알림면뿐이다** — 에이전트 전송단을 참조하지 않는다.
 *
 * 발신은 `onve@atmark.ai`, 헤더는 `From: "Onve (Atmark)" <onve@atmark.ai>`(상수 `WELCOME_FROM_HEADER` 하나 — 전송단이 그 모양과 글자 그대로의
 * 헤더를 본다). 답장은 그 주소로 온다 — 받는 쪽 경로(지원 에이전트)는 이 모듈의 일이 아니다. 진입점은 `workers/welcome-mailer.ts` 하나이고
 * (`SYSTEM_MAIL_ENTRYPOINTS` 의 `welcome_notify`), 로그인·가입·초대 메일과 **같은 전용 Lambda `atmark-login-mailer`**(DB 롤 atmark_login_mailer —
 * 환영 메일 outbox 칸과 `users(id, email)` 만)에서, 기능 플래그 `ATMARK_WELCOME_MAIL_ENABLED` 가 켜졌을 때만 돈다.
 *
 * **사용자당 최대 1통(at-most-once).** claim 이 `last_error = 'sending'` 을 SES 호출 전에 적는다 — lease 가 끝난 행에 그 표식이 남아 있으면(호출 직후 `markSent` 전에 죽음) 다시 보내지 않고 `dead(send_unknown)` 로 닫는다. 표면 동결은 `test/arch/gate-chokepoint.arch.test.ts` 의 "환영 알림 경로" 절이 본다.
 */

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../db/client';
import { selectRow } from '../db/repositories/rows';
import { resolveMailLocale, type MailLocale } from '../i18n/locales';
import { createSesNotificationTransport, type SesSendClient } from '../mail/transport/ses-transport';
import { log } from '../observability/logger';
import { renderWelcomeMail } from './welcome-template';

/**
 * SES `FromEmailAddress`(IAM `ses:FromAddress` 가 보는 값). 로컬파트 `onve` 는 예약이라 일반 에이전트가 가질 수 없다 — 운영자가 지원 에이전트의
 * 별칭으로만 붙인다(`OPERATOR_ASSIGNABLE_ADDRESSES`, 202609301500). 그래서 이 메일에 온 답장은 지원 에이전트의 받은편지함으로 간다.
 */
export const WELCOME_FROM_ADDRESS = 'onve@atmark.ai';

/** raw MIME 의 헤더 `From` 값 — **이 상수 하나**에서만 나온다(전송단이 글자 그대로 대조한다). */
export const WELCOME_FROM_HEADER = `"Onve (Atmark)" <${WELCOME_FROM_ADDRESS}>`;

/** 관측 축의 `route_id` — `SYSTEM_MAIL_ENTRYPOINTS` 의 id 와 같다. */
export const WELCOME_NOTIFY_ROUTE_ID = 'welcome_notify';

/** 전역 시간당 상한 — 넘으면 미룬다(버리지 않는다). 운영 조립은 **항상** 이 상수를 넘긴다(arch 테스트). */
export const WELCOME_MAIL_HOURLY_CAP = 30;

const RATE_WINDOW_MS = 60 * 60 * 1000;
/** 이보다 오래된 행은 보내지 않는다(`obsolete`, `stale`) — 가입 직후의 편지다. */
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
/** 상한에 걸린 행을 다시 볼 때까지. */
const DEFER_MS = 10 * 60 * 1000;
/** SES 호출이 끝나기를 넉넉히 넘는 시간 — lease 가 호출 중에 끝나 다른 워커가 같은 행을 집는 일이 없게(연락 포워더와 같은 5분). */
const CLAIM_LEASE_MS = 5 * 60 * 1000;
/** `last_error` 에 적는 발송 표식 — SES 호출 **전에** claim 과 함께 적고, `markSent`·`markFailed` 가 지운다. lease 가 끝난 행에 이 표식이 남아 있으면 호출이 나갔는지 모른다. */
const SENDING_MARK = 'sending';
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30 * 1000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 지운 사용자 행의 주소 도메인(202609250220 — `users_erasure_guard` 가 이 자리표시만 허락한다). */
const ERASED_DOMAIN = 'erased.invalid';

/**
 * 결말. `obsolete` = 48시간이 지난 행, `undeliverable` = 지운 사용자 · 억제 주소(보내지 않는다), `dead` = 재시도 소진 또는 앞선 시도의 결과를 모른다(`send_unknown` — 다시 보내지 않는다), `deferred` = 전역 상한 — 다음 창으로 미뤘다.
 */
export type WelcomeNotifyOutcome = 'sent' | 'retry' | 'dead' | 'undeliverable' | 'obsolete' | 'deferred' | 'not_due';

/** 의존성 — **문자열이 하나도 없다**(속성 이름·타입은 arch 테스트가 동결한다). */
export interface WelcomeNotifierDependencies {
  readonly pool: Pool;
  readonly client: SesSendClient;
  readonly now: () => Date;
  /** 전역 시간당 상한. 운영 조립은 **항상** `WELCOME_MAIL_HOURLY_CAP` 을 넘긴다(arch 테스트). */
  readonly capPerHour: number;
}

/** 공개 API 전부. **메서드 하나, 인자 하나.** */
export interface WelcomeNotifier {
  send(welcomeId: string): Promise<WelcomeNotifyOutcome>;
}

interface CandidateRow {
  id: string;
  email: string;
  lang: string;
  mail_locale: string | null;
  attempt_count: number;
  last_error: string | null;
  created_at: Date;
}

interface Claimed {
  readonly kind: 'claimed';
  readonly welcomeId: string;
  readonly attempt: number;
  readonly email: string;
  readonly locale: MailLocale;
}

type ClaimResult =
  | Claimed
  | { readonly kind: 'not_due' }
  | { readonly kind: 'deferred'; readonly reason: 'global_cap' }
  | { readonly kind: 'undeliverable' | 'obsolete'; readonly reason: 'stale' | 'user_erased' | 'suppressed' }
  | { readonly kind: 'dead'; readonly reason: 'send_unknown' };

async function settle(client: PoolClient, welcomeId: string, status: 'undeliverable' | 'obsolete' | 'dead', reason: string, now: Date): Promise<void> {
  await client.query(
    `UPDATE welcome_mails SET status = $2, settled_at = $3, last_error = $4 WHERE id = $1 AND status = 'pending'`,
    [welcomeId, status, now, reason],
  );
}

async function claim(client: PoolClient, welcomeId: string, now: Date, capPerHour: number): Promise<ClaimResult> {
  // **수신자가 나오는 유일한 조회다.** 행 → 사용자(수신자). 조직은 읽지 않는다(이 롤은 그 칸을 읽을 수 없다).
  const row = await selectRow<CandidateRow>(
    client,
    `SELECT w.id, u.email, w.lang, u.mail_locale, w.attempt_count, w.last_error, w.created_at
       FROM welcome_mails w
       JOIN users u ON u.id = w.user_id
      WHERE w.id = $1 AND w.status = 'pending' AND w.next_attempt_at <= $2
      FOR UPDATE OF w SKIP LOCKED`,
    [welcomeId, now],
  );
  if (row === null) return { kind: 'not_due' };
  if (row.created_at.getTime() + STALE_AFTER_MS <= now.getTime()) {
    await settle(client, row.id, 'obsolete', 'stale', now);
    return { kind: 'obsolete', reason: 'stale' };
  }
  if (row.email.split('@')[1] === ERASED_DOMAIN) {
    await settle(client, row.id, 'undeliverable', 'user_erased', now);
    return { kind: 'undeliverable', reason: 'user_erased' };
  }
  // 시스템 메일 억제(202609240900 — 로그인·가입·승인·환영 알림의 하드 바운스·불만). 주소 칸 하나만 읽는다.
  const suppressed = await selectRow<{ suppressed: boolean }>(
    client,
    'SELECT EXISTS (SELECT 1 FROM system_mail_suppressions WHERE address = $1) AS suppressed',
    [row.email],
  );
  if (suppressed?.suppressed !== false) {
    await settle(client, row.id, 'undeliverable', 'suppressed', now);
    return { kind: 'undeliverable', reason: 'suppressed' };
  }
  // 앞선 시도가 SES 호출 직전·직후에 죽었다 — 호출이 나갔는지 알 수 없다. 두 번째 환영 메일을 보내느니 여기서 닫는다(최대 한 통 · 놓칠 수는 있다).
  if (row.last_error === SENDING_MARK) {
    await settle(client, row.id, 'dead', 'send_unknown', now);
    return { kind: 'dead', reason: 'send_unknown' };
  }
  // 전역 상한 — 한 시간 창 안에 집힌 행 수. 잠금 아래라 동시 워커가 함께 넘지 못한다. 넘으면 **미룬다**(시도 수는 그대로).
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('welcome_notify:global', 0))`);
  const usage = await selectRow<{ used: number }>(
    client,
    'SELECT count(*)::int AS used FROM welcome_mails WHERE claimed_at > $1 AND claimed_at <= $2',
    [new Date(now.getTime() - RATE_WINDOW_MS), now],
  );
  if ((usage?.used ?? 0) >= capPerHour) {
    await client.query(`UPDATE welcome_mails SET next_attempt_at = $2 WHERE id = $1 AND status = 'pending'`, [
      row.id,
      new Date(now.getTime() + DEFER_MS),
    ]);
    return { kind: 'deferred', reason: 'global_cap' };
  }
  const attempt = row.attempt_count + 1;
  await client.query(
    `UPDATE welcome_mails SET attempt_count = $2, claimed_at = $3, next_attempt_at = $4, last_error = $5 WHERE id = $1 AND status = 'pending'`,
    [row.id, attempt, now, new Date(now.getTime() + CLAIM_LEASE_MS), SENDING_MARK],
  );
  // 언어 = 사용자의 설정(가입 확정이 가입 언어로 채운다 — 그 뒤 콘솔에서 바꿨으면 그 값) → 가입 언어(`welcome_mails.lang`) → 'en'.
  return { kind: 'claimed', welcomeId: row.id, attempt, email: row.email, locale: resolveMailLocale(row.mail_locale, row.lang) };
}

async function markSent(pool: Pool, claimed: Claimed, sesMessageId: string, now: Date): Promise<boolean> {
  const result = await pool.query(
    `UPDATE welcome_mails SET status = 'sent', sent_at = $3, ses_message_id = $4, last_error = NULL
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.welcomeId, claimed.attempt, now, sesMessageId],
  );
  return result.rowCount === 1;
}

async function markFailed(pool: Pool, claimed: Claimed, now: Date): Promise<'retry' | 'dead'> {
  if (claimed.attempt >= MAX_ATTEMPTS) {
    await pool.query(
      `UPDATE welcome_mails SET status = 'dead', settled_at = $3, last_error = 'send_failed'
        WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
      [claimed.welcomeId, claimed.attempt, now],
    );
    return 'dead';
  }
  await pool.query(
    `UPDATE welcome_mails SET next_attempt_at = $3, last_error = 'send_failed'
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.welcomeId, claimed.attempt, new Date(now.getTime() + RETRY_BASE_MS * 2 ** (claimed.attempt - 1))],
  );
  return 'retry';
}

/** 알림기를 만든다. 반환하는 것은 `send(welcomeId)` **하나뿐**이다. */
export function createWelcomeNotifier(deps: WelcomeNotifierDependencies): WelcomeNotifier {
  if (!Number.isSafeInteger(deps.capPerHour) || deps.capPerHour < 1) {
    throw new Error(`capPerHour 은 1 이상의 정수여야 한다: ${String(deps.capPerHour)}`);
  }
  const transport = createSesNotificationTransport({ client: deps.client, now: deps.now });
  return {
    async send(welcomeId: string): Promise<WelcomeNotifyOutcome> {
      if (!ID_PATTERN.test(welcomeId)) throw new Error(`welcomeId 는 정규형 uuid 여야 한다: ${JSON.stringify(welcomeId)}`);
      const claimed = await withTransaction(deps.pool, (client) => claim(client, welcomeId, deps.now(), deps.capPerHour));
      if (claimed.kind !== 'claimed') {
        if (claimed.kind !== 'not_due') {
          // 주소는 싣지 않는다 — 행 id(추적)와 사유만.
          log(claimed.kind === 'dead' ? 'error' : claimed.kind === 'deferred' ? 'warn' : 'info', `welcome_notify.${claimed.kind}`, {
            route_id: WELCOME_NOTIFY_ROUTE_ID,
            trace_id: welcomeId,
            detail: claimed.reason,
          });
        }
        return claimed.kind;
      }
      let sesMessageId: string;
      try {
        const rendered = renderWelcomeMail(claimed.locale);
        ({ sesMessageId } = await transport.sendOwnerNotification({
          notificationId: claimed.welcomeId,
          fromAddress: WELCOME_FROM_ADDRESS,
          fromHeader: WELCOME_FROM_HEADER,
          toAddress: claimed.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        }));
      } catch (error) {
        const outcome = await markFailed(deps.pool, claimed, deps.now());
        log(outcome === 'dead' ? 'error' : 'warn', 'welcome_notify.failed', {
          route_id: WELCOME_NOTIFY_ROUTE_ID,
          trace_id: welcomeId,
          outcome,
          error_kind: error instanceof Error ? error.name : typeof error,
        });
        return outcome;
      }
      // 이미 나갔다 — 기록 실패로 던지면 재시도가 두 번째 메일을 만든다. 삼키되 **남긴다**: 표식이 남은 행은 lease 뒤 `dead(send_unknown)` 로 닫힌다(재발송 없음).
      const settled = await markSent(deps.pool, claimed, sesMessageId, deps.now()).catch((error: unknown) => {
        log('error', 'welcome_notify.mark_sent_failed', {
          route_id: WELCOME_NOTIFY_ROUTE_ID,
          trace_id: welcomeId,
          ses_message_id: sesMessageId,
          error_kind: error instanceof Error ? error.name : typeof error,
        });
        return false;
      });
      log(settled ? 'info' : 'warn', 'welcome_notify.sent', {
        route_id: WELCOME_NOTIFY_ROUTE_ID,
        trace_id: welcomeId,
        ses_message_id: sesMessageId,
        settled,
      });
      return 'sent';
    },
  };
}
