/**
 * src/notify/owner-login-notifier.ts — **소유자 로그인 코드 메일의 전용 발송 경로** (관리 계약).
 *
 * **코드만(2026-10-10)** — 메일에 로그인 링크(서명 토큰)가 없다. 6자리 코드는 링크 행 id · 만료에서 로그인 키로 파생한다(저장하지 않는다).
 * **한 언어** — 받는 사용자의 설정(`users.mail_locale`) → 'en'(`resolveMailLocale`).
 *
 * 승인 알림(`approval-notifier.ts`)과 **같은 규율**로 두 번째 시스템 메일을 연다:
 *
 *   1. **공개 API 는 `loginLinkId` 하나만 받는다.** 수신자·제목·본문·URL 을 인자로 받는 함수가 이 모듈에 없다.
 *      의존성에도 문자열이 없다(풀·SES 호출면·로그인 키·시계). 발신 주소·로그인 페이지 URL 은 상수다.
 *   2. **수신자는 DB 의 `users.email` 에서만 나온다** — 링크 → 사용자(202609250110, 확장성 P0 R-1: 조직이 여럿이어도 사람 한 명에게
 *      한 통). 로그인을 요청한 사람이 입력한 주소는 이 모듈에 도달하지도 않는다(admin 은 입력이 살아 있는 멤버십을 가진 사용자
 *      주소와 **정확히** 일치할 때만 링크 행을 만든다). 초대 로그인 링크(`invite_id`)도 같다 — 초대받은 사용자의 주소로만 간다.
 *      이 롤은 멤버십·조직 주소를 읽지 않는다(`users(id, email)` · `owner_login_links.user_id` 만).
 *   3. **전송단에서 쓰는 것은 알림면뿐이다** — 에이전트 전송단을 참조하지 않는다.
 *
 * 셋 다 `test/arch/gate-chokepoint.arch.test.ts` 의 "로그인 알림 경로" 절이 ts-morph 로 단언한다. 이 모듈을 부르는
 * 진입점은 `workers/owner-login-notifier.ts` 하나이고(`SYSTEM_MAIL_ENTRYPOINTS`), 그 워커는 **전용 Lambda
 * `atmark-login-mailer`**(역할 atmark-runtime-login-mailer · DB 롤 atmark_login_mailer)에서만 돈다 — ADR-0006. 로그인 키와
 * 링크 id·만료를 함께 쥐면 소유자 세션을 만들 수 있으므로, 그 둘을 에이전트 토큰이 닿는 api Lambda 의 역할(발송 역할)에서
 * 떼어 냈다. 그 대가로 SES 발송 주체가 둘이 됐고, 둘째는 발신 주소 하나(`OWNER_LOGIN_FROM_ADDRESS`)에 IAM 조건으로 묶인다
 * (Layer E `mustEqual: 2`).
 *
 * **링크당 정확히 1통(at-least-once 창 하나).** 집기는 `FOR UPDATE SKIP LOCKED` + 임대. SES 가 받은 뒤 `sent` 를 적기
 * 전에 죽으면 임대 만료 뒤 한 번 더 나간다 — 두 통의 토큰은 같은 링크 행을 가리키고 링크는 1회용이다.
 * **사용자(수신자)당 속도 상한 `OWNER_LOGIN_NOTIFY_HOURLY_CAP_PER_USER`** — admin 의 요청 상한(주소당)과 별개의 두 번째 층이다.
 */

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../db/client';
import { selectRow } from '../db/repositories/rows';
import { createSesNotificationTransport, type SesSendClient } from '../mail/transport/ses-transport';
import { log } from '../observability/logger';
import { resolveMailLocale, type MailLocale } from '../i18n/locales';
import type { HmacKeyring } from '../security/hmac-keyring';
import { mintLoginCode } from '../security/login-code';
import { renderOwnerLoginMail } from './owner-login-template';

/**
 * 발신 주소 — **로그인 메일 전용**. login-mailer 역할의 SES 권한이 `ses:FromAddress` = 정확히 이 값으로 묶여 있고
 * (`infra/cdk/stacks/compute-stack.ts` `LOGIN_MAILER_FROM_ADDRESS` — 값 일치는 `test/unit/infra/compute-stack.test.ts`),
 * 발송 역할은 이 주소로 보낼 수 없다(명시 Deny). 로컬파트 `login` 은 에이전트에게 발급할 수 없는 예약어다
 * (`identity/address.ts` `RESERVED_LOCAL_PARTS`). 상수다.
 */
export const OWNER_LOGIN_FROM_ADDRESS = 'login@atmark.ai';

/** 관측 축의 `route_id` — `SYSTEM_MAIL_ENTRYPOINTS` 의 id 와 같다. */
export const OWNER_LOGIN_NOTIFY_ROUTE_ID = 'owner_login_notify';

/**
 * 수신자(사용자)당 로그인 메일 상한: 롤링 60분 10통(시도 수 합). admin 요청 상한(사용자당 시간당 20링크)이 1차이고 이것은 2차다 —
 * 요청 상한이 코드 변경으로 풀려도 한 사람의 메일함이 폭격당하지 않게. 조직이 아니라 사람 기준인 이유: 링크가 사람에게 묶였다.
 */
export const OWNER_LOGIN_NOTIFY_HOURLY_CAP_PER_USER = 10;

const RATE_WINDOW_MS = 60 * 60 * 1000;
const CLAIM_LEASE_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30 * 1000;
const LINK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 결말. `obsolete` = 이미 쓰였거나 만료된 링크(보내지 않는다). */
export type OwnerLoginNotifyOutcome = 'sent' | 'deferred' | 'retry' | 'dead' | 'undeliverable' | 'obsolete' | 'not_due';

/** 의존성 — **문자열이 하나도 없다**(속성 이름·타입은 arch 테스트가 동결한다). */
export interface OwnerLoginNotifierDependencies {
  readonly pool: Pool;
  readonly client: SesSendClient;
  /** 로그인 키(`atmark/owner-login-keys`) — 6자리 코드를 파생한다. 승인 링크 키와 다른 비밀이다. */
  readonly keyring: HmacKeyring;
  readonly now: () => Date;
}

/** 공개 API 전부. **메서드 하나, 인자 하나.** */
export interface OwnerLoginNotifier {
  notify(loginLinkId: string): Promise<OwnerLoginNotifyOutcome>;
}

interface CandidateRow {
  id: string;
  user_id: string | null;
  attempt_count: number;
  expires_at: Date;
  email: string | null;
  mail_locale: string | null;
}

interface Claimed {
  readonly kind: 'claimed';
  readonly linkId: string;
  readonly attempt: number;
  readonly ownerEmail: string;
  readonly expiresAt: Date;
  readonly locale: MailLocale;
}

type ClaimResult = Claimed | { readonly kind: 'not_due' | 'deferred' | 'undeliverable' | 'obsolete' };

async function settle(client: PoolClient, linkId: string, status: 'undeliverable' | 'obsolete', reason: string, now: Date): Promise<void> {
  await client.query(
    `UPDATE owner_login_links SET status = $2, settled_at = $3, last_error = $4 WHERE id = $1 AND status = 'pending'`,
    [linkId, status, now, reason],
  );
}

async function claim(client: PoolClient, linkId: string, now: Date): Promise<ClaimResult> {
  // **수신자가 나오는 유일한 조회다.** 링크 → 사용자. `used_at` 은 로그인 메일 롤이 읽을 수 없다(컬럼 GRANT) — 알 필요도
  //   없다: 이미 쓰인 링크의 메일은 무해하다(1회용). 만료만 본다. 사용자 없는 링크(주 소유자 주소가 없는 조직 · 0110 이전의 옛 행)는
  //   보낼 곳이 없다 — undeliverable(`owner_email_missing`, 조용히 삼키지 않는다).
  const row = await selectRow<CandidateRow>(
    client,
    `SELECT l.id, l.user_id, l.attempt_count, l.expires_at, u.email, u.mail_locale
       FROM owner_login_links l
       LEFT JOIN users u ON u.id = l.user_id
      WHERE l.id = $1 AND l.status = 'pending' AND l.next_attempt_at <= $2
      FOR UPDATE OF l SKIP LOCKED`,
    [linkId, now],
  );
  if (row === null) return { kind: 'not_due' };
  // 만료까지 1분도 안 남았으면 보내지 않는다 — 받는 순간 죽은 링크다.
  if (row.expires_at.getTime() - 60_000 <= now.getTime()) {
    await settle(client, row.id, 'obsolete', 'link_expired', now);
    return { kind: 'obsolete' };
  }
  if (row.user_id === null || row.email === null) {
    await settle(client, row.id, 'undeliverable', 'owner_email_missing', now);
    return { kind: 'undeliverable' };
  }
  // 시스템 메일 억제(202609240900, 보안 검증 H2) — 이 주소로 간 로그인·가입·승인 알림이 하드 바운스됐거나 불만 신고됐다. 다시 보내면
  //   SES 계정의 반송·불만 율이 오른다. 주소 칸 하나만 읽는다(컬럼 GRANT). 해제는 운영자(소유자 셸) — 런북 §12.
  const suppressed = await selectRow<{ suppressed: boolean }>(
    client,
    'SELECT EXISTS (SELECT 1 FROM system_mail_suppressions WHERE address = $1) AS suppressed',
    [row.email],
  );
  if (suppressed?.suppressed !== false) {
    await settle(client, row.id, 'undeliverable', 'suppressed', now);
    return { kind: 'undeliverable' };
  }
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('owner_login_notify:' || $1::text, 0))`, [row.user_id]);
  const usage = await selectRow<{ used: number; oldest: Date | null }>(
    client,
    `SELECT coalesce(sum(attempt_count), 0)::int AS used, min(claimed_at) AS oldest
       FROM owner_login_links WHERE user_id = $1 AND claimed_at > $2`,
    [row.user_id, new Date(now.getTime() - RATE_WINDOW_MS)],
  );
  if (usage !== null && usage.used >= OWNER_LOGIN_NOTIFY_HOURLY_CAP_PER_USER && usage.oldest !== null) {
    // 로그인 링크는 15분이면 죽는다 — 상한 창이 풀릴 때까지 미루면 받는 순간 만료다. 그래서 미루지 않고 닫는다.
    await settle(client, row.id, 'obsolete', 'user_rate_cap', now);
    return { kind: 'deferred' };
  }
  const attempt = row.attempt_count + 1;
  await client.query(
    `UPDATE owner_login_links SET attempt_count = $2, claimed_at = $3, next_attempt_at = $4 WHERE id = $1 AND status = 'pending'`,
    [row.id, attempt, now, new Date(now.getTime() + CLAIM_LEASE_MS)],
  );
  return { kind: 'claimed', linkId: row.id, attempt, ownerEmail: row.email, expiresAt: row.expires_at, locale: resolveMailLocale(row.mail_locale) };
}

async function markSent(pool: Pool, claimed: Claimed, sesMessageId: string, now: Date): Promise<boolean> {
  const result = await pool.query(
    `UPDATE owner_login_links SET status = 'sent', sent_at = $3, ses_message_id = $4, last_error = NULL
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.linkId, claimed.attempt, now, sesMessageId],
  );
  return result.rowCount === 1;
}

async function markFailed(pool: Pool, claimed: Claimed, now: Date): Promise<'retry' | 'dead'> {
  if (claimed.attempt >= MAX_ATTEMPTS) {
    await pool.query(
      `UPDATE owner_login_links SET status = 'dead', settled_at = $3, last_error = 'send_failed'
        WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
      [claimed.linkId, claimed.attempt, now],
    );
    return 'dead';
  }
  await pool.query(
    `UPDATE owner_login_links SET next_attempt_at = $3, last_error = 'send_failed'
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.linkId, claimed.attempt, new Date(now.getTime() + RETRY_BASE_MS * 2 ** (claimed.attempt - 1))],
  );
  return 'retry';
}

/** 알림기를 만든다. 반환하는 것은 `notify(loginLinkId)` **하나뿐**이다. */
export function createOwnerLoginNotifier(deps: OwnerLoginNotifierDependencies): OwnerLoginNotifier {
  const transport = createSesNotificationTransport({ client: deps.client, now: deps.now });
  return {
    async notify(loginLinkId: string): Promise<OwnerLoginNotifyOutcome> {
      if (!LINK_ID_PATTERN.test(loginLinkId)) throw new Error(`loginLinkId 는 정규형 uuid 여야 한다: ${JSON.stringify(loginLinkId)}`);
      const claimed = await withTransaction(deps.pool, (client) => claim(client, loginLinkId, deps.now()));
      if (claimed.kind !== 'claimed') {
        if (claimed.kind !== 'not_due') {
          log(claimed.kind === 'undeliverable' ? 'error' : 'info', `owner_login_notify.${claimed.kind}`, {
            route_id: OWNER_LOGIN_NOTIFY_ROUTE_ID,
            trace_id: loginLinkId,
          });
        }
        return claimed.kind;
      }
      let sesMessageId: string;
      try {
        // 만료는 **방금 DB 에서 읽은 값** — 6자리 코드는 이 링크 행 id·만료에서 로그인 키로 파생한다(`security/login-code.ts` — 저장하지
        //   않는다. admin 이 verify 때 잠근 행의 만료로 다시 계산한다).
        const link = { linkId: claimed.linkId, expiresAt: claimed.expiresAt };
        const rendered = renderOwnerLoginMail(
          { code: mintLoginCode(deps.keyring, 'owner_login', link), expiresAt: claimed.expiresAt },
          claimed.locale,
        );
        ({ sesMessageId } = await transport.sendOwnerNotification({
          notificationId: claimed.linkId,
          fromAddress: OWNER_LOGIN_FROM_ADDRESS,
          toAddress: claimed.ownerEmail,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        }));
      } catch (error) {
        const outcome = await markFailed(deps.pool, claimed, deps.now());
        log(outcome === 'dead' ? 'error' : 'warn', 'owner_login_notify.failed', {
          route_id: OWNER_LOGIN_NOTIFY_ROUTE_ID,
          trace_id: loginLinkId,
          outcome,
          error_kind: error instanceof Error ? error.name : typeof error,
        });
        return outcome;
      }
      // 이미 나갔다 — 기록 실패로 던지면 재시도가 두 번째 메일을 만든다.
      const settled = await markSent(deps.pool, claimed, sesMessageId, deps.now()).catch(() => false);
      log(settled ? 'info' : 'warn', 'owner_login_notify.sent', {
        route_id: OWNER_LOGIN_NOTIFY_ROUTE_ID,
        trace_id: loginLinkId,
        ses_message_id: sesMessageId,
        settled,
      });
      return 'sent';
    },
  };
}
