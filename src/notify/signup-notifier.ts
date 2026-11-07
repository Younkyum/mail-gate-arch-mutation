/**
 * src/notify/signup-notifier.ts — **가입 확인 메일의 전용 발송 경로** (`.omc/handoffs/signup-contract.md` §4).
 *
 * 로그인 링크 알림(`owner-login-notifier.ts`)과 **같은 규율**의 세 번째 시스템 메일이다:
 *
 *   1. **공개 API 는 `signupLinkId` 하나만 받는다.** 수신자·제목·본문·URL 을 인자로 받는 함수가 이 모듈에 없다. 의존성에도
 *      문자열이 없다(풀·SES 호출면·키링·시계). 발신 주소·가입 확인 페이지 URL 은 상수다.
 *   2. **수신자는 DB 의 `signup_links.email` 에서만 나온다** — 로그인 메일과 다른 점이고 가입의 본질이다(아직 조직이 없다).
 *      그래서 이 메일은 **임의 주소로 간다**. 메일 폭탄을 막는 층은 셋이다: admin 의 요청자·같은 주소 상한(`signup_requests`) ·
 *      이 모듈의 **전역 시간당 상한**(`SIGNUP_MAIL_GLOBAL_HOURLY_CAP`) · 억제 목록(`signup_email_suppressed` — 어느 조직에서든
 *      바운스·불만·수신 거부된 주소). 본문에는 요청자가 고른 문자열이 없다(`signup-template.ts`).
 *   3. **전송단에서 쓰는 것은 알림면뿐이다** — 에이전트 전송단을 참조하지 않는다.
 *
 * 셋 다 `test/arch/gate-chokepoint.arch.test.ts` 의 "가입 알림 경로" 절이 본다. 이 모듈을 부르는 진입점은
 * `workers/signup-mailer.ts` 하나이고(`SYSTEM_MAIL_ENTRYPOINTS` 의 `signup_notify`), 그 워커는 로그인 메일과 **같은 전용
 * Lambda `atmark-login-mailer`**(역할 atmark-runtime-login-mailer — SES 는 `login@atmark.ai` 하나 · DB 롤 atmark_login_mailer)에서
 * 돈다. 발송 주체를 늘리지 않는다(계약 §0).
 *
 * **코드만(2026-10-10)** — 메일에 가입 확인 링크(서명 토큰)가 없다. 6자리 코드는 로그인 키링으로, 가입 문맥으로 파생한다
 * (`security/login-code.ts` — 로그인 코드와 통하지 않는다). **한 언어** — 받는 사람은 아직 사용자가 아니다: 가입 양식의 화면 언어
 * (`signup_links.lang`) → 'en'(`resolveMailLocale`).
 *
 * **링크 행당 정확히 1통(at-least-once 창 하나).** 집기는 `FOR UPDATE SKIP LOCKED` + 임대. 두 통이 나가도 코드는 같은 행에서 파생한 같은
 * 값이고 행은 1회용이다.
 */

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../db/client';
import { selectRow } from '../db/repositories/rows';
import { createSesNotificationTransport, type SesSendClient } from '../mail/transport/ses-transport';
import { log } from '../observability/logger';
import type { HmacKeyring } from '../security/hmac-keyring';
import { resolveMailLocale, type MailLocale } from '../i18n/locales';
import { mintLoginCode } from '../security/login-code';
import { OWNER_LOGIN_FROM_ADDRESS } from './owner-login-notifier';
import { renderSignupMail } from './signup-template';

/** 관측 축의 `route_id` — `SYSTEM_MAIL_ENTRYPOINTS` 의 id 와 같다. */
export const SIGNUP_NOTIFY_ROUTE_ID = 'signup_notify';

/**
 * **전역** 가입 메일 상한: 롤링 60분 20통(시도 수 합). 수신자가 임의 주소이므로 조직 단위 상한이 성립하지 않는다 — admin 의
 * 요청자·같은 주소 상한이 1차이고 이것은 2차다(요청자 키를 바꿔 가며 흩뿌리는 폭탄의 총량을 여기서 자른다). 넘으면
 * `undeliverable`(`global_cap`) — 미루지 않는다: 링크는 30분이면 죽고, 밀린 대기열이 창이 풀리는 순간 몰려 나가면 그것이 곧 폭탄이다.
 * 60 → 20(보안 검증 H2, 2026-09-24): 이 메일은 없는 주소·신고하는 주소로도 간다 — 시간당 총량이 곧 SES 계정의 반송·불만 율에 얹힐
 * 수 있는 최대치다. 초기 가입 흐름(사람이 손으로 누르는 속도)에는 20 이면 넉넉하다.
 */
export const SIGNUP_MAIL_GLOBAL_HOURLY_CAP = 20;

const RATE_WINDOW_MS = 60 * 60 * 1000;
const CLAIM_LEASE_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30 * 1000;
const LINK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 결말. `obsolete` = 만료 직전·만료된 링크, `undeliverable` = 억제 주소 또는 전역 상한(보내지 않는다). */
export type SignupNotifyOutcome = 'sent' | 'retry' | 'dead' | 'undeliverable' | 'obsolete' | 'not_due';

/** 의존성 — **문자열이 하나도 없다**(속성 이름·타입은 arch 테스트가 동결한다). */
export interface SignupNotifierDependencies {
  readonly pool: Pool;
  readonly client: SesSendClient;
  /** 로그인 키링(`atmark/owner-login-keys`) — 가입 코드는 같은 키, 다른 파생 문맥이다. */
  readonly keyring: HmacKeyring;
  readonly now: () => Date;
  /**
   * 전역 시간당 상한. 운영 조립은 **항상** `SIGNUP_MAIL_GLOBAL_HOURLY_CAP` 을 넘긴다(arch 테스트가 조립 소스를 본다).
   * 주입인 이유: 상한은 DB 전체의 창을 세므로, 공유 로컬 DB 에서 실제 시각으로 도는 흐름 테스트가 앞선 실행분 때문에
   * `global_cap` 으로 떨어졌다(2026-09-24). 상한 동작 자체는 상한 테스트가 이 값으로 직접 본다.
   */
  readonly capPerHour: number;
}

/** 공개 API 전부. **메서드 하나, 인자 하나.** */
export interface SignupNotifier {
  notify(signupLinkId: string): Promise<SignupNotifyOutcome>;
}

interface CandidateRow {
  id: string;
  email: string;
  attempt_count: number;
  expires_at: Date;
  lang: string | null;
}

interface Claimed {
  readonly kind: 'claimed';
  readonly linkId: string;
  readonly attempt: number;
  readonly email: string;
  readonly expiresAt: Date;
  readonly locale: MailLocale;
}

type ClaimResult =
  | Claimed
  | { readonly kind: 'not_due' }
  | { readonly kind: 'undeliverable' | 'obsolete'; readonly reason: 'link_expired' | 'suppressed' | 'global_cap' };

async function settle(client: PoolClient, linkId: string, status: 'undeliverable' | 'obsolete', reason: string, now: Date): Promise<void> {
  await client.query(
    `UPDATE signup_links SET status = $2, settled_at = $3, last_error = $4 WHERE id = $1 AND status = 'pending'`,
    [linkId, status, now, reason],
  );
}

async function claim(client: PoolClient, linkId: string, now: Date, capPerHour: number): Promise<ClaimResult> {
  // **수신자가 나오는 유일한 조회다.** 조직 이름·결속·사용 시각은 로그인 메일 롤이 읽을 수 없다(컬럼 GRANT) — 알 필요도
  //   없다: 이미 쓰인 링크의 메일은 무해하다(1회용). 만료만 본다.
  const row = await selectRow<CandidateRow>(
    client,
    `SELECT id, email, attempt_count, expires_at, lang
       FROM signup_links
      WHERE id = $1 AND status = 'pending' AND next_attempt_at <= $2
      FOR UPDATE SKIP LOCKED`,
    [linkId, now],
  );
  if (row === null) return { kind: 'not_due' };
  // 만료까지 1분도 안 남았으면 보내지 않는다 — 받는 순간 죽은 링크다.
  if (row.expires_at.getTime() - 60_000 <= now.getTime()) {
    await settle(client, row.id, 'obsolete', 'link_expired', now);
    return { kind: 'obsolete', reason: 'link_expired' };
  }
  // 억제 목록 — 주소 하나에 대한 참/거짓만 묻는다(SECURITY DEFINER, 202609240800). 억제 테이블 자체는 읽지 못한다. 202609240900 부터
  //   이 함수는 시스템 메일 억제(`system_mail_suppressions` — 로그인·가입·승인 알림의 하드 바운스·불만)도 본다(보안 검증 H2).
  const suppressed = await selectRow<{ suppressed: boolean }>(client, 'SELECT signup_email_suppressed($1) AS suppressed', [row.email]);
  if (suppressed?.suppressed !== false) {
    await settle(client, row.id, 'undeliverable', 'suppressed', now);
    return { kind: 'undeliverable', reason: 'suppressed' };
  }
  // 전역 상한 — 모든 가입 메일이 한 줄로 선다(잠금 하나). 계수는 창 안에서 집힌 행의 시도 수 합. **초대 메일(`invite-notifier.ts`)과
  //   같은 잠금·같은 창**을 센다(202609250120) — 임의 주소로 가는 두 메일이 SES 평판을 함께 쓴다.
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
  const attempt = row.attempt_count + 1;
  await client.query(
    `UPDATE signup_links SET attempt_count = $2, claimed_at = $3, next_attempt_at = $4 WHERE id = $1 AND status = 'pending'`,
    [row.id, attempt, now, new Date(now.getTime() + CLAIM_LEASE_MS)],
  );
  return { kind: 'claimed', linkId: row.id, attempt, email: row.email, expiresAt: row.expires_at, locale: resolveMailLocale(row.lang) };
}

async function markSent(pool: Pool, claimed: Claimed, sesMessageId: string, now: Date): Promise<boolean> {
  const result = await pool.query(
    `UPDATE signup_links SET status = 'sent', sent_at = $3, ses_message_id = $4, last_error = NULL
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.linkId, claimed.attempt, now, sesMessageId],
  );
  return result.rowCount === 1;
}

async function markFailed(pool: Pool, claimed: Claimed, now: Date): Promise<'retry' | 'dead'> {
  if (claimed.attempt >= MAX_ATTEMPTS) {
    await pool.query(
      `UPDATE signup_links SET status = 'dead', settled_at = $3, last_error = 'send_failed'
        WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
      [claimed.linkId, claimed.attempt, now],
    );
    return 'dead';
  }
  await pool.query(
    `UPDATE signup_links SET next_attempt_at = $3, last_error = 'send_failed'
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.linkId, claimed.attempt, new Date(now.getTime() + RETRY_BASE_MS * 2 ** (claimed.attempt - 1))],
  );
  return 'retry';
}

/** 알림기를 만든다. 반환하는 것은 `notify(signupLinkId)` **하나뿐**이다. */
export function createSignupNotifier(deps: SignupNotifierDependencies): SignupNotifier {
  if (!Number.isSafeInteger(deps.capPerHour) || deps.capPerHour < 1) {
    throw new Error(`capPerHour 은 1 이상의 정수여야 한다: ${String(deps.capPerHour)}`);
  }
  const transport = createSesNotificationTransport({ client: deps.client, now: deps.now });
  return {
    async notify(signupLinkId: string): Promise<SignupNotifyOutcome> {
      if (!LINK_ID_PATTERN.test(signupLinkId)) throw new Error(`signupLinkId 는 정규형 uuid 여야 한다: ${JSON.stringify(signupLinkId)}`);
      const claimed = await withTransaction(deps.pool, (client) => claim(client, signupLinkId, deps.now(), deps.capPerHour));
      if (claimed.kind !== 'claimed') {
        if (claimed.kind !== 'not_due') {
          // 주소는 싣지 않는다 — 링크 id(추적)와 사유만.
          log(claimed.reason === 'global_cap' ? 'warn' : 'info', `signup_notify.${claimed.kind}`, {
            route_id: SIGNUP_NOTIFY_ROUTE_ID,
            trace_id: signupLinkId,
            detail: claimed.reason,
          });
        }
        return claimed.kind;
      }
      let sesMessageId: string;
      try {
        // 만료는 **방금 DB 에서 읽은 값** — 6자리 코드는 이 링크 행 id·만료에서 로그인 키로 파생한다(가입 문맥 — `security/login-code.ts`,
        //   저장하지 않는다).
        const link = { linkId: claimed.linkId, expiresAt: claimed.expiresAt };
        const rendered = renderSignupMail({ code: mintLoginCode(deps.keyring, 'signup', link), expiresAt: claimed.expiresAt }, claimed.locale);
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
        log(outcome === 'dead' ? 'error' : 'warn', 'signup_notify.failed', {
          route_id: SIGNUP_NOTIFY_ROUTE_ID,
          trace_id: signupLinkId,
          outcome,
          error_kind: error instanceof Error ? error.name : typeof error,
        });
        return outcome;
      }
      // 이미 나갔다 — 기록 실패로 던지면 재시도가 두 번째 메일을 만든다.
      const settled = await markSent(deps.pool, claimed, sesMessageId, deps.now()).catch(() => false);
      log(settled ? 'info' : 'warn', 'signup_notify.sent', {
        route_id: SIGNUP_NOTIFY_ROUTE_ID,
        trace_id: signupLinkId,
        ses_message_id: sesMessageId,
        settled,
      });
      return 'sent';
    },
  };
}
