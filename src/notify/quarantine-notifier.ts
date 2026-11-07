/**
 * src/notify/quarantine-notifier.ts — **격리 알림의 전용 발송 경로**(ADR-0016 2026-10-07 개정). 시스템 메일 범주의 열째
 * (`SYSTEM_MAIL_ENTRYPOINTS` 의 `quarantine_notice` — 진입점 `workers/quarantine-notifier.ts`).
 *
 * 다른 시스템 메일과 같은 규율:
 *   1. **공개 API 는 `noticeId` 하나만 받는다.** 수신자 · 제목 · 본문 · URL 을 인자로 받는 함수가 이 모듈에 없다. 의존성에도 문자열이 없다(풀 · SES
 *      호출면 · 시계). 발신 주소 · 콘솔 URL · 문구는 상수다.
 *   2. **수신자는 DB 정의자 함수 `atmark_claim_quarantine_notice(id)` 에서만 나온다** — 집기(임대 · 시도 수 +1)와 같은 문장에서 그 조직의
 *      소유자 주소(승인 알림과 같은 수신자 — 조직 행의 소유자 칸)를 돌려준다(이 모듈의 SQL 은 그 칸을 읽지 않는다 — arch). 행은 수신 트리거(정의자)만 적는다 — 앱 롤 INSERT 0.
 *   3. **전송단에서 쓰는 것은 알림면뿐이다**(`createSesNotificationTransport`) — 에이전트 전송단 · 관문을 import 하지 않는다. 워밍업 캡을 먹지 않는다.
 *
 * 창(에이전트당 15분에 한 통)은 DB 가 정한다(`quarantine_notice_record()` — 첫 격리 2분 뒤 · 직전 집기 15분 뒤). 여기서 정하는 것:
 *   - 24시간 넘게 묵은 창(킬 스위치가 꺼져 있었다)은 `obsolete` — 늦은 알림을 한꺼번에 쏟지 않는다.
 *   - 조직 하루 상한 `QUARANTINE_NOTICES_PER_ORG_PER_DAY`(롤링 24시간 · 집힌 행 기준 — 진행 중 포함) — 넘으면 `suppressed`(보내지 않는다). 계수와 판정은
 *     조직 advisory lock 아래 한 트랜잭션. 상한에 닿는 마지막 한 통은 "이후 최대 24시간 멈춘다 — 콘솔 수신 로그를 보라" 를 싣고, 상한이 풀린 뒤 **그 조직의
 *     다음 알림(어느 에이전트든)** 이 그사이 알리지 못한 격리의 수 · 에이전트 수를 말한다(보안 리뷰 M1 — 한 에이전트의 홍수가 다른 에이전트를 가리지 않게).
 *   - 보낸 사람 도메인은 **DMARC 인증된 From 의 것만** 싣는다(보안 리뷰 M2 — 위조 From 이 notify@ 메일에 우리 도메인 · 그럴듯한 도메인을 싣지 못하게). 나머지는 수로만.
 *   - 보내기 **직전에** `last_error = 'sending'` 을 적는다 — 보낸 뒤 기록이 실패하면 다음 집기가 그 행을 다시 보내지 않고 `obsolete(unsettled_send)` 로 닫는다
 *     (정의자 함수 · at-most-once, 보안 리뷰 L3). 시도 5번을 다 쓴 행은 집지 않는다.
 *   - 소유자 주소가 없으면 `dead(no_recipients)`. 실패는 재시도(최대 5 — 그 뒤 dead).
 * 본문에 격리된 메일의 제목 · 본문 · 보낸 사람 주소가 없다 — 검사한 도메인만(`quarantine-notice-template.ts`).
 * **종류(2026-10-08):** 창은 에이전트 · 종류(`block` 차단 등급 — 항상 · `risk` 위험 등급 — 에이전트 설정 `risk_notify`)마다 하나다(202610081003). 위의 규칙은
 * 종류와 무관하게 같고, 문구만 종류를 따른다(위험 알림은 보류 · 전달 수). **하루 상한은 종류마다 따로 센다**(적대적 검증 N-001 — 위험 알림이 상한을 채워
 * 차단 알림을 밀어내면 "차단은 항상 알린다" 가 깨진다). 상한 누락 합산("따로 알리지 못한 N통")도 같은 종류 안에서만.
 * 로그에 주소 · 도메인이 없다(알림 id · 에이전트 id · 수만 — 관측 PII 규칙).
 */

import type { Pool } from 'pg';

import { withTransaction } from '../db/client';
import { selectRow, selectRows } from '../db/repositories/rows';
import { createSesNotificationTransport, type SesSendClient } from '../mail/transport/ses-transport';
import { DEFAULT_MAIL_LOCALE } from '../i18n/locales';
import { log } from '../observability/logger';
import { countMetric, METRIC_NAMES } from '../observability/metrics';
import {
  MAX_ENROLLED_AGENTS_SHOWN,
  MAX_SENDER_DOMAINS_SHOWN,
  noticeKindsOfGroup,
  orgDailyCapOf,
  renderQuarantineNotice,
  type QuarantineNoticeKind,
  type QuarantineNoticeView,
} from './quarantine-notice-template';
import { recipientLocales, renderPerLocale } from './recipient-locale';

/** 발신 주소 — 승인 · 도메인 알림과 같은 `notify@atmark.ai`(예약 로컬파트 — 에이전트가 가질 수 없다). 상수다. */
export const QUARANTINE_NOTICE_FROM_ADDRESS = 'notify@atmark.ai';
/** raw MIME 헤더 `From` — 표시 이름 "Atmark"(승인 알림과 같은 모양). */
export const QUARANTINE_NOTICE_FROM_HEADER = `"Atmark" <${QUARANTINE_NOTICE_FROM_ADDRESS}>`;

/** 관측 축의 `route_id` — `SYSTEM_MAIL_ENTRYPOINTS` 의 id 와 같다. */
export const QUARANTINE_NOTICE_ROUTE_ID = 'quarantine_notice';

/** 이보다 묵은 창은 보내지 않는다(`obsolete`). */
const STALE_AFTER_MS = 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 60_000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 알림 한 건의 결말. */
export type QuarantineNoticeOutcome = 'sent' | 'suppressed' | 'retry' | 'dead' | 'obsolete' | 'not_due';

/** 의존성 — **문자열이 하나도 없다**(`test/arch/gate-chokepoint.arch.test.ts` "격리 알림 경로" 절이 동결한다). */
export interface QuarantineNotifierDependencies {
  readonly pool: Pool;
  readonly client: SesSendClient;
  readonly now: () => Date;
}

/** 이 모듈의 공개 API 전부 — 메서드 하나 · 인자 하나. */
export interface QuarantineNotifier {
  send(noticeId: string): Promise<QuarantineNoticeOutcome>;
}

interface NoticeRow {
  id: string;
  agent_id: string;
  organization_id: string;
  first_at: Date;
  attempt_count: number;
  kind: QuarantineNoticeKind;
}

async function settle(pool: Pool, id: string, status: 'obsolete' | 'dead', reason: string): Promise<void> {
  await pool.query(`UPDATE quarantine_notices SET status = $2, last_error = $3 WHERE id = $1 AND status = 'pending'`, [id, status, reason]);
}

export function createQuarantineNotifier(deps: QuarantineNotifierDependencies): QuarantineNotifier {
  const transport = createSesNotificationTransport({ client: deps.client, now: deps.now });

  return {
    async send(noticeId: string): Promise<QuarantineNoticeOutcome> {
      if (!ID_PATTERN.test(noticeId)) throw new Error('noticeId 는 정규형 uuid 여야 한다');
      const now = deps.now();
      const row = await selectRow<NoticeRow>(
        deps.pool,
        `SELECT id::text AS id, agent_id, organization_id::text AS organization_id, first_at, attempt_count, kind
           FROM quarantine_notices
          WHERE id = $1 AND status = 'pending' AND next_attempt_at <= $2`,
        [noticeId, now],
      );
      if (row === null) return 'not_due';

      if (now.getTime() - row.first_at.getTime() > STALE_AFTER_MS) {
        await settle(deps.pool, row.id, 'obsolete', 'stale');
        log('info', 'quarantine_notice.obsolete', { route_id: QUARANTINE_NOTICE_ROUTE_ID, agent_id: row.agent_id, outcome: 'obsolete', reason: 'stale', detail: `notice_id=${row.id}` });
        return 'obsolete';
      }

      // 집기 + 수신자(정의자 함수 — 같은 문장). 집는 순간 창이 닫힌다(새 격리는 새 창). 집지 못하면(다른 워커 · 임대 중) not_due.
      const claimed = await selectRow<{ recipients: string[] | null; unsettled: boolean }>(
        deps.pool,
        'SELECT recipients, unsettled FROM atmark_claim_quarantine_notice($1)',
        [row.id],
      );
      if (claimed?.unsettled === true) {
        // 보내기 직전 표지가 남은 채 임대가 끝났다 — 나갔는지 모른다. 정의자 함수가 obsolete(unsettled_send) 로 닫았다(다시 보내지 않는다).
        countMetric(METRIC_NAMES.quarantineNoticeUnsettledSend, { route_id: QUARANTINE_NOTICE_ROUTE_ID });
        log('warn', 'quarantine_notice.unsettled_send', { route_id: QUARANTINE_NOTICE_ROUTE_ID, agent_id: row.agent_id, outcome: 'obsolete', reason: 'unsettled_send', detail: `notice_id=${row.id}` });
        return 'obsolete';
      }
      const recipients = claimed?.recipients ?? null;
      if (recipients === null) return 'not_due';
      const attempt = row.attempt_count + 1;

      // 조직 하루 상한 — 종류 묶음(차단 · 위험 / 가입 · 자가 등록 — 2026-10-08)마다 따로. 정보 알림이 차단 알림을 밀어내지 않는다.
      const group = noticeKindsOfGroup(row.kind);
      const cap = orgDailyCapOf(row.kind);
      // 조직 하루 상한 — 집힌(진행 중 포함) 행을 조직 잠금 아래 센다. 넘으면 이 창은 보내지 않는다(suppressed — 조직의 다음 알림이 수를 말한다).
      //   이 한 통이 상한에 닿는 마지막이면(capReached) 본문이 "멈춘다" 를 말한다.
      let capReached = false;
      const suppressed = await withTransaction(deps.pool, async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('quarantine_notice_org:' || $1::text, 0))`, [row.organization_id]);
        const used = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM quarantine_notices
            WHERE organization_id = $1 AND id <> $2 AND status IN ('sent', 'pending') AND claimed_at > $3 AND kind = ANY($4::text[])`,
          [row.organization_id, row.id, new Date(now.getTime() - DAY_MS), group],
        );
        const n = used.rows[0]?.n ?? 0;
        capReached = n === cap - 1;
        if (n < cap) return false;
        await client.query(`UPDATE quarantine_notices SET status = 'suppressed', last_error = 'org_daily_cap' WHERE id = $1 AND status = 'pending'`, [row.id]);
        return true;
      });
      if (suppressed) {
        countMetric(METRIC_NAMES.quarantineNoticeSuppressed, { route_id: QUARANTINE_NOTICE_ROUTE_ID });
        log('warn', 'quarantine_notice.suppressed', { route_id: QUARANTINE_NOTICE_ROUTE_ID, agent_id: row.agent_id, outcome: 'suppressed', reason: 'org_daily_cap', detail: `notice_id=${row.id}` });
        return 'suppressed';
      }

      if (recipients.length === 0) {
        await settle(deps.pool, row.id, 'dead', 'no_recipients');
        log('error', 'quarantine_notice.undeliverable', { route_id: QUARANTINE_NOTICE_ROUTE_ID, agent_id: row.agent_id, outcome: 'dead', reason: 'no_recipients', detail: `notice_id=${row.id}` });
        return 'dead';
      }

      // 렌더 재료 — 집은 뒤에 읽는다(집힌 창의 수는 더 늘지 않는다 — DB 가드).
      // 도메인은 DMARC 인증된 From 의 것만(M2) — 인증되지 않은 보낸 곳은 도메인 종류 수 + 모양이 틀려 도메인이 없는 메일 수로만 센다.
      const window = await selectRow<{
        message_count: number;
        first_at: Date;
        last_at: Date;
        kind: QuarantineNoticeKind;
        held: number;
        scanner_errors: number;
        domain_count: number;
        unverified: number;
        name: string;
        address: string | null;
      }>(
        deps.pool,
        `SELECT n.message_count, n.first_at, n.last_at, n.kind,
                (SELECT count(*)::int FROM quarantine_notice_items i WHERE i.notice_id = n.id AND i.reason = 'risk_hold') AS held,
                (SELECT count(*)::int FROM quarantine_notice_items i WHERE i.notice_id = n.id AND i.reason = 'scanner_error') AS scanner_errors,
                (SELECT count(DISTINCT i.sender_domain)::int FROM quarantine_notice_items i WHERE i.notice_id = n.id AND i.sender_authenticated) AS domain_count,
                (SELECT (count(DISTINCT i.sender_domain) FILTER (WHERE NOT i.sender_authenticated) + count(*) FILTER (WHERE i.sender_domain IS NULL))::int
                   FROM quarantine_notice_items i WHERE i.notice_id = n.id) AS unverified,
                a.name, atmark_agent_primary_address(a.id) AS address
           FROM quarantine_notices n JOIN agents a ON a.id = n.agent_id
          WHERE n.id = $1`,
        [row.id],
      );
      const domains = await selectRows<{ sender_domain: string }>(
        deps.pool,
        `SELECT sender_domain FROM quarantine_notice_items
          WHERE notice_id = $1 AND sender_domain IS NOT NULL AND sender_authenticated
          GROUP BY sender_domain ORDER BY count(*) DESC, sender_domain
          LIMIT $2`,
        [row.id, MAX_SENDER_DOMAINS_SHOWN],
      );
      // 하루 상한으로 알리지 못한 **이 조직**의 격리(M1 — 어느 에이전트든) — 조직이 직전에 보낸 알림 뒤의 것만(한 번만 말한다).
      const quiet = await selectRow<{ n: number; agents: number }>(
        deps.pool,
        `SELECT coalesce(sum(message_count), 0)::int AS n, count(DISTINCT agent_id)::int AS agents FROM quarantine_notices
          WHERE organization_id = $1 AND status = 'suppressed' AND kind = ANY($2::text[])
            AND claimed_at > coalesce((SELECT max(claimed_at) FROM quarantine_notices
                                        WHERE organization_id = $1 AND status = 'sent' AND kind = ANY($2::text[])), '-infinity'::timestamptz)`,
        [row.organization_id, group],
      );
      // 자가 등록 창 — 만든 에이전트(이름 · 유효 대표 주소, 최대 MAX_ENROLLED_AGENTS_SHOWN). 다른 종류는 읽지 않는다.
      const enrolled =
        row.kind === 'enroll'
          ? await selectRows<{ name: string; address: string | null }>(
              deps.pool,
              `SELECT a.name, atmark_agent_primary_address(a.id) AS address
                 FROM agent_enrollments e JOIN agents a ON a.id = e.child_agent_id
                WHERE e.notice_id = $1
                ORDER BY a.created_at, a.id
                LIMIT $2`,
              [row.id, MAX_ENROLLED_AGENTS_SHOWN],
            )
          : [];
      if (window === null || window.message_count < 1) {
        // 트리거가 수를 올리기 전에 실패한 창(WARNING) — 보낼 것이 없다.
        await settle(deps.pool, row.id, 'obsolete', 'empty');
        return 'obsolete';
      }

      // 보내기 직전 표지(L3) — 이 뒤에 무슨 일이 있어도(기록 실패 · 죽음) 다음 집기는 다시 보내지 않는다. 자기가 집은 시도일 때만.
      const marked = await deps.pool.query(
        `UPDATE quarantine_notices SET last_error = 'sending' WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
        [row.id, attempt],
      );
      if (marked.rowCount !== 1) return 'not_due';

      let sesMessageId = '';
      try {
        const locales = await recipientLocales(deps.pool, row.organization_id, recipients);
        const view: QuarantineNoticeView = {
          agentId: row.agent_id,
          agentName: window.name,
          agentAddress: window.address,
          messageCount: window.message_count,
          scannerErrorCount: window.scanner_errors,
          firstAt: window.first_at,
          lastAt: window.last_at,
          senderDomains: domains.map((domain) => domain.sender_domain),
          senderDomainCount: window.domain_count,
          unverifiedSenderCount: window.unverified,
          suppressedCount: quiet?.n ?? 0,
          suppressedAgentCount: quiet?.agents ?? 0,
          capReached,
          kind: window.kind,
          heldCount: window.held,
          enrolledAgents: enrolled,
        };
        const renderFor = renderPerLocale((locale) => renderQuarantineNotice(view, locale));
        for (const recipient of recipients) {
          const rendered = renderFor(locales.get(recipient) ?? DEFAULT_MAIL_LOCALE);
          ({ sesMessageId } = await transport.sendOwnerNotification({
            notificationId: row.id,
            fromAddress: QUARANTINE_NOTICE_FROM_ADDRESS,
            fromHeader: QUARANTINE_NOTICE_FROM_HEADER,
            toAddress: recipient,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
          }));
        }
      } catch (error) {
        const dead = attempt >= MAX_ATTEMPTS;
        await deps.pool.query(
          dead
            ? `UPDATE quarantine_notices SET status = 'dead', last_error = 'send_failed' WHERE id = $1 AND status = 'pending' AND attempt_count = $2`
            : `UPDATE quarantine_notices SET next_attempt_at = $3, last_error = 'send_failed' WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
          dead ? [row.id, attempt] : [row.id, attempt, new Date(now.getTime() + RETRY_BASE_MS * 2 ** (attempt - 1))],
        );
        log(dead ? 'error' : 'warn', 'quarantine_notice.failed', {
          route_id: QUARANTINE_NOTICE_ROUTE_ID,
          agent_id: row.agent_id,
          outcome: dead ? 'dead' : 'retry',
          error_kind: error instanceof Error ? error.name : typeof error,
          detail: `notice_id=${row.id}`,
        });
        return dead ? 'dead' : 'retry';
      }

      // 여기부터 알림은 이미 나갔다 — 기록 실패로 던지지 않는다(던지면 다음 틱이 다시 보낸다).
      const settled = await deps.pool
        .query(
          `UPDATE quarantine_notices SET status = 'sent', sent_at = $3, ses_message_id = $4, last_error = NULL
            WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
          [row.id, attempt, deps.now(), sesMessageId],
        )
        .then((result) => result.rowCount === 1)
        .catch(() => false);
      countMetric(METRIC_NAMES.quarantineNoticeSent, { route_id: QUARANTINE_NOTICE_ROUTE_ID });
      log(settled ? 'info' : 'warn', 'quarantine_notice.sent', {
        route_id: QUARANTINE_NOTICE_ROUTE_ID,
        agent_id: row.agent_id,
        outcome: 'sent',
        detail: `notice_id=${row.id} messages=${String(window.message_count)} settled=${String(settled)}`,
      });
      return 'sent';
    },
  };
}
