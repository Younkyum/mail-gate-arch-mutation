/**
 * src/notify/ops-code-notifier.ts — **호스팅 운영자 콘솔 코드 메일의 전용 발송 경로**(`.omc/plans/ops-console.md` §3.4 결정 C2).
 *
 * 소유자 로그인 메일(`owner-login-notifier.ts`)과 같은 규율의 시스템 메일이다:
 *   1. **공개 API 는 `challengeId` 하나만 받는다.** 수신자·제목·본문을 인자로 받는 함수가 없다. 의존성에도 문자열이 없다(풀 · SES 호출면 ·
 *      운영 코드 키링 · 시계). 발신 주소는 상수(`login@atmark.ai` — login-mailer 역할의 SES 권한이 이 주소 하나로 묶여 있다).
 *   2. **수신자는 DB 에서만 나온다.** 로그인·step-up 은 **보내는 순간** `ops_operators` 에서 읽는다(그때 active 가 아니면 `obsolete`) ·
 *      접근 요청은 도전의 주소(요청자가 입력 — 그래서 전역 시간당 5 · 대기 5 · 주소·요청자 상한 · 억제 목록이 DB 에서 먼저 막는다).
 *   3. **코드는 저장하지 않는다.** 보낼 때 운영 코드 키(`atmark/ops-login-keys`, login-mailer 만)로 파생하고(`mintLoginCode(…, 'ops_login', …)`),
 *      다이제스트를 `ops_mailer_set_digest` 로 **먼저** 적은 뒤에만 보낸다. `'dead'`(재시도 사이에 활성 키가 바뀌었다 — 다른 다이제스트)면 보내지
 *      않는다(메일 0통, 리드 결정). 같은 키로 재시도하면 같은 코드다. 이 롤은 다이제스트 칸을 읽지도 쓰지도 못한다(정의 함수 하나로만).
 *
 * 도전당 1통(at-least-once 창 하나) — 집기는 `FOR UPDATE SKIP LOCKED` + 임대. 전용 Lambda `atmark-login-mailer` 의 운영 워커
 * (`workers/ops-code-mailer.ts`)에서만 돈다.
 */

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../db/client';
import { selectRow } from '../db/repositories/rows';
import { resolveMailLocale, type MailLocale } from '../i18n/locales';
import { createSesNotificationTransport, type SesSendClient } from '../mail/transport/ses-transport';
import { OPS_ACTIONS, type OpsAction } from '../ops/contract';
import { log } from '../observability/logger';
import type { HmacKeyring } from '../security/hmac-keyring';
import { mintLoginCode, opsCodeDigest } from '../security/login-code';
import { renderOpsCodeMail, type OpsCodeMailPurpose } from './ops-code-template';

/** 발신 주소 — 로그인 메일과 같은 주소(발송 주체를 늘리지 않는다 · login-mailer 역할의 `ses:FromAddress` 조건). 상수다. */
export const OPS_CODE_FROM_ADDRESS = 'login@atmark.ai';

/** 관측 축의 `route_id` — `SYSTEM_MAIL_ENTRYPOINTS` 의 id 와 같다. */
export const OPS_CODE_NOTIFY_ROUTE_ID = 'ops_code_notify';

const CLAIM_LEASE_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 15 * 1000;
const CHALLENGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 결말. `dead` = 키 회전으로 다이제스트가 어긋났거나 재시도를 다 썼다 · `obsolete` = 이미 쓰였거나 무효·만료 · 운영자가 active 가 아니다. */
export type OpsCodeNotifyOutcome = 'sent' | 'retry' | 'dead' | 'undeliverable' | 'obsolete' | 'not_due';

/** 의존성 — **문자열이 하나도 없다.** */
export interface OpsCodeNotifierDependencies {
  readonly pool: Pool;
  readonly client: SesSendClient;
  /** 운영 코드 키링(`atmark/ops-login-keys`) — 소유자 로그인 키와 다른 비밀이다. */
  readonly keyring: HmacKeyring;
  readonly now: () => Date;
}

/** 공개 API 전부. **메서드 하나, 인자 하나.** */
export interface OpsCodeNotifier {
  notify(challengeId: string): Promise<OpsCodeNotifyOutcome>;
}

interface CandidateRow {
  id: string;
  purpose: OpsCodeMailPurpose;
  email: string;
  operator_id: string | null;
  action: string | null;
  target_ref: string | null;
  lang: 'ko' | 'en';
  expires_at: Date;
  used_at: Date | null;
  invalidated_at: Date | null;
  attempt_count: number;
  operator_email: string | null;
  operator_status: string | null;
  /** 받는 주소의 사용자(있으면)가 고른 메일 언어. */
  mail_locale: string | null;
}

interface Claimed {
  readonly kind: 'claimed';
  readonly id: string;
  readonly attempt: number;
  readonly to: string;
  readonly purpose: OpsCodeMailPurpose;
  readonly action: OpsAction | null;
  readonly targetRef: string | null;
  readonly locale: MailLocale;
  readonly expiresAt: Date;
}

type ClaimResult = Claimed | { readonly kind: 'not_due' | 'undeliverable' | 'obsolete' };

function actionOf(raw: string | null): OpsAction | null {
  return OPS_ACTIONS.find((action) => action === raw) ?? null;
}

async function settle(client: PoolClient, id: string, status: 'undeliverable' | 'obsolete', reason: string, now: Date): Promise<void> {
  await client.query(`UPDATE ops_login_challenges SET status = $2, settled_at = $3, last_error = $4 WHERE id = $1 AND status = 'pending'`, [
    id,
    status,
    now,
    reason,
  ]);
}

async function claim(client: PoolClient, id: string, now: Date): Promise<ClaimResult> {
  // **수신자가 나오는 유일한 조회다.** 로그인·step-up → 운영자 행(보내는 순간의 상태) · 접근 요청 → 도전의 주소.
  const row = await selectRow<CandidateRow>(
    client,
    `SELECT c.id, c.purpose, c.email, c.operator_id, c.action, c.target_ref, c.lang, c.expires_at, c.used_at, c.invalidated_at, c.attempt_count,
            o.email AS operator_email, o.status AS operator_status,
            (SELECT u.mail_locale FROM users u
              WHERE u.email = CASE WHEN c.purpose = 'access_request' THEN c.email ELSE o.email END) AS mail_locale
       FROM ops_login_challenges c
       LEFT JOIN ops_operators o ON o.id = c.operator_id
      WHERE c.id = $1 AND c.status = 'pending' AND c.next_attempt_at <= $2
      FOR UPDATE OF c SKIP LOCKED`,
    [id, now],
  );
  if (row === null) return { kind: 'not_due' };
  // 만료까지 1분도 안 남았으면 보내지 않는다 — 받는 순간 죽은 코드다.
  if (row.expires_at.getTime() - 60_000 <= now.getTime()) {
    await settle(client, row.id, 'obsolete', 'challenge_expired', now);
    return { kind: 'obsolete' };
  }
  if (row.used_at !== null || row.invalidated_at !== null) {
    await settle(client, row.id, 'obsolete', 'challenge_closed', now);
    return { kind: 'obsolete' };
  }
  let to: string;
  if (row.purpose === 'access_request') {
    to = row.email;
  } else {
    if (row.operator_status !== 'active' || row.operator_email === null) {
      await settle(client, row.id, 'obsolete', 'operator_inactive', now);
      return { kind: 'obsolete' };
    }
    to = row.operator_email;
  }
  // 시스템 메일 억제(202609240900) — 하드 바운스·불만 주소로는 보내지 않는다(주소 칸 하나).
  const suppressed = await selectRow<{ suppressed: boolean }>(
    client,
    'SELECT EXISTS (SELECT 1 FROM system_mail_suppressions WHERE address = $1) AS suppressed',
    [to],
  );
  if (suppressed?.suppressed !== false) {
    await settle(client, row.id, 'undeliverable', 'suppressed', now);
    return { kind: 'undeliverable' };
  }
  const attempt = row.attempt_count + 1;
  await client.query(
    `UPDATE ops_login_challenges SET attempt_count = $2, claimed_at = $3, next_attempt_at = $4 WHERE id = $1 AND status = 'pending'`,
    [row.id, attempt, now, new Date(now.getTime() + CLAIM_LEASE_MS)],
  );
  return {
    kind: 'claimed',
    id: row.id,
    attempt,
    to,
    purpose: row.purpose,
    action: actionOf(row.action),
    targetRef: row.target_ref,
    // 언어 = 운영자 사용자의 설정(받는 주소가 콘솔 사용자면) → 요청 화면 언어(`ops_request_code(p_lang)`) → 'en'.
    locale: resolveMailLocale(row.mail_locale, row.lang),
    expiresAt: row.expires_at,
  };
}

async function markSent(pool: Pool, claimed: Claimed, sesMessageId: string, now: Date): Promise<boolean> {
  const result = await pool.query(
    `UPDATE ops_login_challenges SET status = 'sent', sent_at = $3, ses_message_id = $4, last_error = NULL
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.id, claimed.attempt, now, sesMessageId],
  );
  return result.rowCount === 1;
}

async function markFailed(pool: Pool, claimed: Claimed, now: Date): Promise<'retry' | 'dead'> {
  if (claimed.attempt >= MAX_ATTEMPTS) {
    await pool.query(
      `UPDATE ops_login_challenges SET status = 'dead', settled_at = $3, last_error = 'send_failed'
        WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
      [claimed.id, claimed.attempt, now],
    );
    return 'dead';
  }
  await pool.query(
    `UPDATE ops_login_challenges SET next_attempt_at = $3, last_error = 'send_failed'
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.id, claimed.attempt, new Date(now.getTime() + RETRY_BASE_MS * 2 ** (claimed.attempt - 1))],
  );
  return 'retry';
}

/** 알림기를 만든다. 반환하는 것은 `notify(challengeId)` **하나뿐**이다. */
export function createOpsCodeNotifier(deps: OpsCodeNotifierDependencies): OpsCodeNotifier {
  const transport = createSesNotificationTransport({ client: deps.client, now: deps.now });
  return {
    async notify(challengeId: string): Promise<OpsCodeNotifyOutcome> {
      if (!CHALLENGE_ID_PATTERN.test(challengeId)) throw new Error('challengeId 는 정규형 uuid 여야 한다');
      const claimed = await withTransaction(deps.pool, (client) => claim(client, challengeId, deps.now()));
      if (claimed.kind !== 'claimed') {
        if (claimed.kind !== 'not_due') {
          log(claimed.kind === 'undeliverable' ? 'error' : 'info', `ops_code_notify.${claimed.kind}`, {
            route_id: OPS_CODE_NOTIFY_ROUTE_ID,
            trace_id: challengeId,
          });
        }
        return claimed.kind;
      }
      // 코드 파생 → 다이제스트를 **먼저** 적는다. 'dead' 면(키 회전 · 이미 닫힘) 보내지 않는다 — 정의 함수가 도전을 닫았다.
      const code = mintLoginCode(deps.keyring, 'ops_login', { linkId: claimed.id, expiresAt: claimed.expiresAt });
      const digest = await deps.pool.query<{ result: string }>('SELECT ops_mailer_set_digest($1, $2) AS result', [
        claimed.id,
        opsCodeDigest(claimed.id, code),
      ]);
      if (digest.rows[0]?.result !== 'ok') {
        log('warn', 'ops_code_notify.dead', { route_id: OPS_CODE_NOTIFY_ROUTE_ID, trace_id: challengeId, reason: 'digest_mismatch' });
        return 'dead';
      }
      let sesMessageId: string;
      try {
        const rendered = renderOpsCodeMail(
          { purpose: claimed.purpose, code, expiresAt: claimed.expiresAt, action: claimed.action, targetRef: claimed.targetRef },
          claimed.locale,
        );
        ({ sesMessageId } = await transport.sendOwnerNotification({
          notificationId: claimed.id,
          fromAddress: OPS_CODE_FROM_ADDRESS,
          toAddress: claimed.to,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        }));
      } catch (error) {
        const outcome = await markFailed(deps.pool, claimed, deps.now());
        log(outcome === 'dead' ? 'error' : 'warn', 'ops_code_notify.failed', {
          route_id: OPS_CODE_NOTIFY_ROUTE_ID,
          trace_id: challengeId,
          outcome,
          error_kind: error instanceof Error ? error.name : typeof error,
        });
        return outcome;
      }
      // 이미 나갔다 — 기록 실패로 던지면 재시도가 두 번째 메일을 만든다.
      const settled = await markSent(deps.pool, claimed, sesMessageId, deps.now()).catch(() => false);
      log(settled ? 'info' : 'warn', 'ops_code_notify.sent', {
        route_id: OPS_CODE_NOTIFY_ROUTE_ID,
        trace_id: challengeId,
        ses_message_id: sesMessageId,
        settled,
      });
      return 'sent';
    },
  };
}
