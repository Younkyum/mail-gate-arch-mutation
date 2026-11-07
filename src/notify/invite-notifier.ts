/**
 * src/notify/invite-notifier.ts — **조직 초대 메일의 전용 발송 경로** (확장성 P1 R-1 · 창업자 결정 F-2).
 *
 * 가입 확인 메일(`signup-notifier.ts`)과 **같은 규율**의 다섯 번째 시스템 메일이다:
 *
 *   1. **공개 API 는 `inviteId` 하나만 받는다.** 수신자·제목·본문·URL 을 인자로 받는 함수가 이 모듈에 없다. 의존성에도 문자열이
 *      없다(풀·SES 호출면·키링·시계·숫자 상한). 발신 주소·초대 페이지 URL 은 상수다.
 *   2. **수신자는 DB 의 `users.email` 에서만 나온다** — 초대 → 사용자(`org_invites.user_id`). owner 가 입력한 주소가 곧 수신자라
 *      **임의 주소로 가는 메일**이다. 폭탄을 막는 층: admin 의 조직 하루 20 · 한 조직이 같은 주소에 하루 3 · 대기 10(DB) · **검토 끝난
 *      (active)·동결되지 않은 조직만**(DB, 그리고 **보내는 순간** 다시 — `org_invite_sendable`) · 이 모듈의 **주소당 하루 상한**(조직 무관,
 *      실제로 보낸 메일만 센다 — `INVITE_MAILS_PER_RECIPIENT_PER_DAY`) · **전역 시간당 상한**(가입 메일과 **같은 창·같은 잠금**을 센다 —
 *      `SIGNUP_MAIL_GLOBAL_HOURLY_CAP`) · 억제 목록(`signup_email_suppressed`). 본문에 조직 이름이 없다(`invite-template.ts`) — 초대자의 증명된 주소만.
 *   3. **전송단에서 쓰는 것은 알림면뿐이다** — 에이전트 전송단을 참조하지 않는다.
 *
 * 셋 다 `test/arch/gate-chokepoint.arch.test.ts` 의 "초대 알림 경로" 절이 본다. 진입점은 `workers/invite-mailer.ts` 하나이고
 * (`SYSTEM_MAIL_ENTRYPOINTS` 의 `invite_notify`), 로그인·가입 메일과 **같은 전용 Lambda `atmark-login-mailer`**(SES 는 `login@atmark.ai`
 * 하나 · DB 롤 atmark_login_mailer — 초대 outbox 칸과 `users(id, email)` 만)에서 돈다. 발송 주체를 늘리지 않는다(ADR-0006).
 *
 * **토큰은 로그인 키링으로, 다른 서명 문맥으로**(`security/invite-token.ts`, `atmark-invite-v1`). 토큰은 세션을 만들지 않는다 — claim 은
 * 초대받은 주소로 로그인 코드 메일을 한 통 더 보낼 뿐이다(두 통 흐름).
 *
 * **초대당 정확히 1통(at-least-once 창 하나).** 끝난 초대(취소·수락)의 대기 메일은 DB 가드가 `obsolete` 로 닫는다.
 */

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../db/client';
import { selectRow } from '../db/repositories/rows';
import { createSesNotificationTransport, type SesSendClient } from '../mail/transport/ses-transport';
import { log } from '../observability/logger';
import type { HmacKeyring } from '../security/hmac-keyring';
import { resolveMailLocale, type MailLocale } from '../i18n/locales';
import { buildInviteUrl, mintInviteToken } from '../security/invite-token';
import { OWNER_LOGIN_FROM_ADDRESS } from './owner-login-notifier';
import { renderInviteMail } from './invite-template';

/**
 * 초대 착지 페이지(`GET /invite` — `console.atmark.ai` 의 admin Lambda). 토큰은 fragment(`#t=`)에 실린다. **상수다** — 주입 가능한
 * URL 은 피싱 링크의 입구다. 호스트는 콘솔(`console.atmark.ai`)이다.
 */
export const INVITE_PAGE_URL = 'https://console.atmark.ai/invite';

/** 관측 축의 `route_id` — `SYSTEM_MAIL_ENTRYPOINTS` 의 id 와 같다. */
export const INVITE_NOTIFY_ROUTE_ID = 'invite_notify';

const RATE_WINDOW_MS = 60 * 60 * 1000;
/**
 * 같은 주소로 하루(24시간)에 보내는 초대 메일 — **조직 무관**, 실제로 보냈거나 보내는 중인 것만 센다(적대적 검토 L2). 만들어지기만 한 초대
 * (동결·검토 전 조직 · 취소 · 발송 전)는 세지 않는다 — 그러면 남의 조직이 초대 행만 쌓아 한 주소를 하루 잠글 수 있다. 넘으면 `undeliverable`
 * (`recipient_cap`). export 하지 않는다 — 이 모듈의 공개 표면은 arch 가 동결한다(`gate-chokepoint` "초대 알림 경로").
 */
const INVITE_MAILS_PER_RECIPIENT_PER_DAY = 3;
const RECIPIENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLAIM_LEASE_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30 * 1000;
const LINK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 결말. `obsolete` = 만료 직전·만료된 초대 또는 보낼 수 없게 된 초대(조직 동결·검토 전 · 초대자 owner 아님), `undeliverable` = 억제 주소 · 주소당 상한 · 전역 상한(보내지 않는다). */
export type InviteNotifyOutcome = 'sent' | 'retry' | 'dead' | 'undeliverable' | 'obsolete' | 'not_due';

/** 의존성 — **문자열이 하나도 없다**(속성 이름·타입은 arch 테스트가 동결한다). */
export interface InviteNotifierDependencies {
  readonly pool: Pool;
  readonly client: SesSendClient;
  /** 로그인 키링(`atmark/owner-login-keys`) — 초대 토큰은 같은 키, 다른 서명 문맥이다. */
  readonly keyring: HmacKeyring;
  readonly now: () => Date;
  /** 전역 시간당 상한(가입 메일과 공유하는 창). 운영 조립은 **항상** `SIGNUP_MAIL_GLOBAL_HOURLY_CAP` 을 넘긴다(arch 테스트). */
  readonly capPerHour: number;
}

/** 공개 API 전부. **메서드 하나, 인자 하나.** */
export interface InviteNotifier {
  notify(inviteId: string): Promise<InviteNotifyOutcome>;
}

interface CandidateRow {
  id: string;
  user_id: string;
  email: string;
  inviter_email: string;
  attempt_count: number;
  expires_at: Date;
  mail_locale: string | null;
}

interface Claimed {
  readonly kind: 'claimed';
  readonly linkId: string;
  readonly attempt: number;
  readonly email: string;
  readonly inviterEmail: string;
  readonly expiresAt: Date;
  readonly locale: MailLocale;
}

type ClaimResult =
  | Claimed
  | { readonly kind: 'not_due' }
  | { readonly kind: 'undeliverable' | 'obsolete'; readonly reason: 'link_expired' | 'org_not_sendable' | 'suppressed' | 'recipient_cap' | 'global_cap' };

async function settle(client: PoolClient, linkId: string, status: 'undeliverable' | 'obsolete', reason: string, now: Date): Promise<void> {
  await client.query(
    `UPDATE org_invites SET status = $2, settled_at = $3, last_error = $4 WHERE id = $1 AND status = 'pending'`,
    [linkId, status, now, reason],
  );
}

async function claim(client: PoolClient, linkId: string, now: Date, capPerHour: number): Promise<ClaimResult> {
  // **수신자가 나오는 유일한 조회다.** 초대 → 사용자(수신자)·초대자. 조직·역할·수락·취소는 이 롤이 읽을 수 없다(컬럼 GRANT) — 알 필요도
  //   없다: 끝난 초대의 대기 메일은 DB 가드가 이미 obsolete 로 닫았다(status <> 'pending').
  const row = await selectRow<CandidateRow>(
    client,
    `SELECT i.id, i.user_id, u.email, inviter.email AS inviter_email, i.attempt_count, i.expires_at, u.mail_locale
       FROM org_invites i
       JOIN users u ON u.id = i.user_id
       JOIN users inviter ON inviter.id = i.invited_by_user_id
      WHERE i.id = $1 AND i.status = 'pending' AND i.next_attempt_at <= $2
      FOR UPDATE OF i SKIP LOCKED`,
    [linkId, now],
  );
  if (row === null) return { kind: 'not_due' };
  // 만료까지 1분도 안 남았으면 보내지 않는다 — 받는 순간 죽은 초대다.
  if (row.expires_at.getTime() - 60_000 <= now.getTime()) {
    await settle(client, row.id, 'obsolete', 'link_expired', now);
    return { kind: 'obsolete', reason: 'link_expired' };
  }
  // 보내는 순간의 조직·초대자 상태(적대적 검토 M3) — 초대 뒤 조직이 동결·검토 전으로 돌아갔거나 초대자가 owner 가 아니게 됐으면 닫는다. 이 롤은
  //   조직·멤버십 칸을 읽지 못한다 — SECURITY DEFINER 함수(202609250180)에 참/거짓만 묻는다.
  const sendable = await selectRow<{ ok: boolean }>(client, 'SELECT org_invite_sendable($1) AS ok', [row.id]);
  if (sendable?.ok !== true) {
    await settle(client, row.id, 'obsolete', 'org_not_sendable', now);
    return { kind: 'obsolete', reason: 'org_not_sendable' };
  }
  // 억제 목록 — 주소 하나에 대한 참/거짓만 묻는다(SECURITY DEFINER, 202609240800). 억제 테이블 자체는 읽지 못한다. 202609240900 부터
  //   이 함수는 시스템 메일 억제(`system_mail_suppressions` — 로그인·가입·승인 알림의 하드 바운스·불만)도 본다(보안 검증 H2).
  const suppressed = await selectRow<{ suppressed: boolean }>(client, 'SELECT signup_email_suppressed($1) AS suppressed', [row.email]);
  if (suppressed?.suppressed !== false) {
    await settle(client, row.id, 'undeliverable', 'suppressed', now);
    return { kind: 'undeliverable', reason: 'suppressed' };
  }
  // 전역 상한 — **가입 메일과 같은 잠금·같은 창**(두 outbox 의 시도 수 합). 임의 주소로 가는 두 메일이 SES 평판을 함께 쓴다.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('signup_notify:global', 0))`);
  const usage = await selectRow<{ used: number }>(
    client,
    `SELECT ((SELECT coalesce(sum(attempt_count), 0) FROM signup_links WHERE claimed_at > $1 AND claimed_at <= $2)
           + (SELECT coalesce(sum(attempt_count), 0) FROM org_invites WHERE claimed_at > $1 AND claimed_at <= $2))::int AS used`,
    [new Date(now.getTime() - RATE_WINDOW_MS), now],
  );
  if ((usage?.used ?? 0) >= capPerHour) {
    await settle(client, row.id, 'undeliverable', 'global_cap', now);
    return { kind: 'undeliverable', reason: 'global_cap' };
  }
  // 주소당 하루 상한 — 조직 무관, 보냈거나(sent) 보내는 중인(pending 이고 한 번 이상 집힌) 초대만. 전역 잠금 아래라 동시 워커가 함께 넘지 못한다.
  const recipient = await selectRow<{ n: number }>(
    client,
    `SELECT count(*)::int AS n FROM org_invites
      WHERE user_id = $1 AND id <> $2 AND claimed_at > $3
        AND (status = 'sent' OR (status = 'pending' AND attempt_count > 0))`,
    [row.user_id, row.id, new Date(now.getTime() - RECIPIENT_WINDOW_MS)],
  );
  if ((recipient?.n ?? 0) >= INVITE_MAILS_PER_RECIPIENT_PER_DAY) {
    await settle(client, row.id, 'undeliverable', 'recipient_cap', now);
    return { kind: 'undeliverable', reason: 'recipient_cap' };
  }
  const attempt = row.attempt_count + 1;
  await client.query(
    `UPDATE org_invites SET attempt_count = $2, claimed_at = $3, next_attempt_at = $4 WHERE id = $1 AND status = 'pending'`,
    [row.id, attempt, now, new Date(now.getTime() + CLAIM_LEASE_MS)],
  );
  // 언어 = 초대받은 사용자의 설정(이미 다른 조직에서 쓰는 사용자일 수 있다) → 'en'.
  return {
    kind: 'claimed',
    linkId: row.id,
    attempt,
    email: row.email,
    inviterEmail: row.inviter_email,
    expiresAt: row.expires_at,
    locale: resolveMailLocale(row.mail_locale),
  };
}

async function markSent(pool: Pool, claimed: Claimed, sesMessageId: string, now: Date): Promise<boolean> {
  const result = await pool.query(
    `UPDATE org_invites SET status = 'sent', sent_at = $3, ses_message_id = $4, last_error = NULL
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.linkId, claimed.attempt, now, sesMessageId],
  );
  return result.rowCount === 1;
}

async function markFailed(pool: Pool, claimed: Claimed, now: Date): Promise<'retry' | 'dead'> {
  if (claimed.attempt >= MAX_ATTEMPTS) {
    await pool.query(
      `UPDATE org_invites SET status = 'dead', settled_at = $3, last_error = 'send_failed'
        WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
      [claimed.linkId, claimed.attempt, now],
    );
    return 'dead';
  }
  await pool.query(
    `UPDATE org_invites SET next_attempt_at = $3, last_error = 'send_failed'
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.linkId, claimed.attempt, new Date(now.getTime() + RETRY_BASE_MS * 2 ** (claimed.attempt - 1))],
  );
  return 'retry';
}

/** 알림기를 만든다. 반환하는 것은 `notify(inviteId)` **하나뿐**이다. */
export function createInviteNotifier(deps: InviteNotifierDependencies): InviteNotifier {
  if (!Number.isSafeInteger(deps.capPerHour) || deps.capPerHour < 1) {
    throw new Error(`capPerHour 은 1 이상의 정수여야 한다: ${String(deps.capPerHour)}`);
  }
  const transport = createSesNotificationTransport({ client: deps.client, now: deps.now });
  return {
    async notify(inviteId: string): Promise<InviteNotifyOutcome> {
      if (!LINK_ID_PATTERN.test(inviteId)) throw new Error(`inviteId 는 정규형 uuid 여야 한다: ${JSON.stringify(inviteId)}`);
      const claimed = await withTransaction(deps.pool, (client) => claim(client, inviteId, deps.now(), deps.capPerHour));
      if (claimed.kind !== 'claimed') {
        if (claimed.kind !== 'not_due') {
          // 주소는 싣지 않는다 — 링크 id(추적)와 사유만.
          log(claimed.reason === 'global_cap' ? 'warn' : 'info', `invite_notify.${claimed.kind}`, {
            route_id: INVITE_NOTIFY_ROUTE_ID,
            trace_id: inviteId,
            detail: claimed.reason,
          });
        }
        return claimed.kind;
      }
      let sesMessageId: string;
      try {
        // 만료는 **방금 DB 에서 읽은 값** — 토큰의 만료와 행의 만료가 같다.
        const token = mintInviteToken(deps.keyring, { inviteId: claimed.linkId, expiresAt: claimed.expiresAt });
        const rendered = renderInviteMail(
          { link: buildInviteUrl(INVITE_PAGE_URL, token), inviterEmail: claimed.inviterEmail, expiresAt: claimed.expiresAt },
          claimed.locale,
        );
        ({ sesMessageId } = await transport.sendOwnerNotification({
          notificationId: claimed.linkId,
          fromAddress: OWNER_LOGIN_FROM_ADDRESS,
          toAddress: claimed.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        }));
      } catch (error) {
        const outcome = await markFailed(deps.pool, claimed, deps.now());
        log(outcome === 'dead' ? 'error' : 'warn', 'invite_notify.failed', {
          route_id: INVITE_NOTIFY_ROUTE_ID,
          trace_id: inviteId,
          outcome,
          error_kind: error instanceof Error ? error.name : typeof error,
        });
        return outcome;
      }
      // 이미 나갔다 — 기록 실패로 던지면 재시도가 두 번째 메일을 만든다.
      const settled = await markSent(deps.pool, claimed, sesMessageId, deps.now()).catch(() => false);
      log(settled ? 'info' : 'warn', 'invite_notify.sent', {
        route_id: INVITE_NOTIFY_ROUTE_ID,
        trace_id: inviteId,
        ses_message_id: sesMessageId,
        settled,
      });
      return 'sent';
    },
  };
}
