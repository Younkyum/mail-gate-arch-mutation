/**
 * src/notify/domain-notifier.ts — **고객 도메인 알림의 전용 발송 경로**(ADR-0014 단계 4 M3b · 계획 §3.11 M14). 시스템 메일 범주의 아홉째
 * (`SYSTEM_MAIL_ENTRYPOINTS` 의 `domain_notice` — 진입점 `workers/domain-notifier.ts`).
 *
 * 다른 시스템 메일과 같은 규율:
 *   1. **공개 API 는 `noticeId` 하나만 받는다.** 수신자 · 제목 · 본문 · URL 을 인자로 받는 함수가 이 모듈에 없다. 의존성에도 문자열이 없다(풀 · SES
 *      호출면 · 시계). 발신 주소 · 콘솔 URL · 문구는 상수다.
 *   2. **수신자는 DB 정의자 함수 `atmark_claim_domain_notice(id)` 에서만 나온다** — 집기(임대 · 시도 수 +1)와 같은 문장에서 그 조직의 살아 있는
 *      owner · admin 주소(지운 사용자 제외 · 최대 20)를 돌려준다(보안 L3 — 앱 롤은 users · memberships 권한이 0). 행은 틱만 적는다(조직 하루 10 —
 *      `insertNotice` · 같은 사건 1번 — UNIQUE).
 *   3. **전송단에서 쓰는 것은 알림면뿐이다**(`createSesNotificationTransport`) — 에이전트 전송단 · 관문을 import 하지 않는다. 워밍업 캡을 먹지 않는다.
 *
 * 보내기 전에 **사건이 아직 사실인지** 본다 — 정지 알림인데 도메인이 이미 풀렸으면 · 제거 예고인데 정지가 풀렸으면 · 확인 완료인데 다시 정지 · 제거됐으면 ·
 * 7일 넘게 묵었으면 `obsolete`(보내지
 * 않는다). 조직의 지난 24시간 보낸 알림이 `DOMAIN_NOTICES_PER_ORG_PER_DAY` 에 닿았으면 미룬다(`deferred`). 수신자가 없으면 `dead(no_recipients)`.
 * 수신자마다 한 통(받는 사람 1명 — 알림면 규약). 일부만 나가고 실패하면 다음 시도가 전원에게 다시 보낸다(at-least-once — 유실보다 중복이 낫다).
 * 로그에 도메인 이름 · 주소가 없다(알림 id · 도메인 id 만 — 관측 PII 규칙).
 */

import type { Pool } from 'pg';

import { withTransaction } from '../db/client';
import { selectRow, selectRows } from '../db/repositories/rows';
import { DOMAIN_NOTICE_ROUTE_ID as CONTRACT_ROUTE_ID, DOMAIN_NOTICES_PER_ORG_PER_DAY, type CustomDomainStatus, type CustomDomainSuspendedReason, type DomainNoticeKind } from '../domains/contract';
import { createSesNotificationTransport, type SesSendClient } from '../mail/transport/ses-transport';
import { DEFAULT_MAIL_LOCALE } from '../i18n/locales';
import { log } from '../observability/logger';
import { MAX_AGENTS_SHOWN, renderDomainNotice, type DomainNoticeView } from './domain-notice-template';
import { recipientLocales, renderPerLocale } from './recipient-locale';

/** 발신 주소 — 승인 알림과 같은 `notify@atmark.ai`(예약 로컬파트 — 에이전트가 가질 수 없다). 상수다. */
export const DOMAIN_NOTICE_FROM_ADDRESS = 'notify@atmark.ai';
/** raw MIME 헤더 `From` — 표시 이름 "Atmark"(승인 알림과 같은 모양). */
export const DOMAIN_NOTICE_FROM_HEADER = `"Atmark" <${DOMAIN_NOTICE_FROM_ADDRESS}>`;

/** 관측 축의 `route_id` — `SYSTEM_MAIL_ENTRYPOINTS` 의 id · 계약 `DOMAIN_NOTICE_ROUTE_ID` 와 같다. */
export const DOMAIN_NOTICE_ROUTE_ID = CONTRACT_ROUTE_ID;

/** 이보다 묵은 알림은 보내지 않는다(`obsolete`) — 틱이 같은 사건을 다시 적지 않으므로 오래된 정지 알림이 뒤늦게 나가지 않게. */
const STALE_AFTER_MS = 7 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
/** 조직 상한에 걸린 알림을 다시 볼 때까지. */
const DEFER_MS = 3_600_000;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 60_000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 알림 한 건의 결말. */
export type DomainNoticeOutcome = 'sent' | 'retry' | 'dead' | 'obsolete' | 'deferred' | 'not_due';

/** 의존성 — **문자열이 하나도 없다**(`test/arch/gate-chokepoint.arch.test.ts` "도메인 알림 경로" 절이 동결한다). */
export interface DomainNotifierDependencies {
  readonly pool: Pool;
  readonly client: SesSendClient;
  readonly now: () => Date;
}

/** 이 모듈의 공개 API 전부 — 메서드 하나 · 인자 하나. */
export interface DomainNotifier {
  send(noticeId: string): Promise<DomainNoticeOutcome>;
}

interface NoticeRow {
  id: string;
  domain_id: string;
  organization_id: string;
  kind: DomainNoticeKind;
  event_key: string;
  created_at: Date;
  attempt_count: number;
  domain: string;
  domain_status: CustomDomainStatus;
  suspended_reason: CustomDomainSuspendedReason | null;
}

/** 사건이 아직 사실인가 — 아니면 `obsolete` 의 이유. */
function staleReason(row: NoticeRow, now: Date): string | null {
  if (now.getTime() - row.created_at.getTime() > STALE_AFTER_MS) return 'stale';
  switch (row.kind) {
    case 'suspended':
      return row.domain_status === 'suspended' ? null : 'state_changed';
    case 'removal_d3':
      return row.domain_status === 'suspended' && row.suspended_reason === 'ownership_lost' ? null : 'state_changed';
    case 'expiry_warning':
      return row.domain_status === 'removed' ? 'state_changed' : null;
    case 'removed':
      return null;
    case 'verified':
      // 확인 완료 — 보내기 전에 다시 정지 · 제거됐으면 보내지 않는다(그 사이 정지 알림이 따로 간다).
      return row.domain_status === 'verified' ? null : 'state_changed';
  }
}

/** 만료 예고의 남은 날 — 사건 키 `d30:<만료일 yyyymmdd>` · `d7:…`(틱이 적는 모양 — `lifecycle.ts`) 또는 옛 모양 `d30` · `d7`. 모르면 `null`. */
function daysLeftOf(eventKey: string): number | null {
  const match = /^d([0-9]{1,3})(?::[0-9]{8})?$/.exec(eventKey);
  return match === null ? null : Number(match[1]);
}

async function settle(pool: Pool, id: string, status: 'obsolete' | 'dead', reason: string): Promise<void> {
  await pool.query(`UPDATE domain_notices SET status = $2, last_error = $3 WHERE id = $1 AND status = 'pending'`, [id, status, reason]);
}

export function createDomainNotifier(deps: DomainNotifierDependencies): DomainNotifier {
  const transport = createSesNotificationTransport({ client: deps.client, now: deps.now });

  return {
    async send(noticeId: string): Promise<DomainNoticeOutcome> {
      if (!ID_PATTERN.test(noticeId)) throw new Error('noticeId 는 정규형 uuid 여야 한다');
      const now = deps.now();
      const row = await selectRow<NoticeRow>(
        deps.pool,
        `SELECT n.id::text AS id, n.domain_id::text AS domain_id, n.organization_id::text AS organization_id, n.kind, n.event_key, n.created_at,
                n.attempt_count, d.domain, d.status AS domain_status, d.suspended_reason
           FROM domain_notices n JOIN custom_domains d ON d.id = n.domain_id AND d.organization_id = n.organization_id
          WHERE n.id = $1 AND n.status = 'pending' AND n.next_attempt_at <= $2`,
        [noticeId, now],
      );
      if (row === null) return 'not_due';

      const stale = staleReason(row, now);
      if (stale !== null) {
        await settle(deps.pool, row.id, 'obsolete', stale);
        log('info', 'domain_notice.obsolete', { route_id: DOMAIN_NOTICE_ROUTE_ID, outcome: 'obsolete', reason: stale, detail: `notice_id=${row.id} domain_id=${row.domain_id}` });
        return 'obsolete';
      }

      // 조직의 지난 24시간 보낸 알림 — 상한이면 미룬다(틱의 적기 상한과 두 겹).
      const deferred = await withTransaction(deps.pool, async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('domain_notice:' || $1::text, 0))`, [row.organization_id]);
        const sent = await client.query<{ n: number }>(
          // 보낸 시각 칸(sent_at)은 앱 롤이 읽지 못한다(GRANT 칸 최소) — 집은 시각(보내기 직전)으로 센다. 상한은 틱(`insertNotice`)과 같이 두 칸 —
          // 확인 완료(verified)와 정지 · 제거 · 만료 계열이 서로의 몫을 먹지 않는다.
          `SELECT count(*)::int AS n FROM domain_notices WHERE organization_id = $1 AND status = 'sent' AND claimed_at > $2 AND (kind = 'verified') = $3`,
          [row.organization_id, new Date(now.getTime() - DAY_MS), row.kind === 'verified'],
        );
        if ((sent.rows[0]?.n ?? 0) < DOMAIN_NOTICES_PER_ORG_PER_DAY) return false;
        await client.query(`UPDATE domain_notices SET next_attempt_at = $2 WHERE id = $1 AND status = 'pending'`, [row.id, new Date(now.getTime() + DEFER_MS)]);
        return true;
      });
      if (deferred) {
        log('warn', 'domain_notice.deferred', { route_id: DOMAIN_NOTICE_ROUTE_ID, outcome: 'deferred', detail: `notice_id=${row.id}` });
        return 'deferred';
      }

      // 집기 + 수신자(정의자 함수 — 같은 문장). 집지 못하면(다른 워커 · 임대 중) not_due.
      const claimed = await selectRow<{ recipients: string[] | null }>(deps.pool, 'SELECT atmark_claim_domain_notice($1) AS recipients', [row.id]);
      const recipients = claimed?.recipients ?? null;
      if (recipients === null) return 'not_due';
      const attempt = row.attempt_count + 1;
      if (recipients.length === 0) {
        await settle(deps.pool, row.id, 'dead', 'no_recipients');
        log('error', 'domain_notice.undeliverable', { route_id: DOMAIN_NOTICE_ROUTE_ID, outcome: 'dead', reason: 'no_recipients', detail: `notice_id=${row.id}` });
        return 'dead';
      }

      // 그 도메인 주소를 대표로 쓰는 이 조직 에이전트(마지막 선택 기준 — 유효 여부와 무관: 도메인을 잃으면 그 에이전트가 "주소 없음" 이 된다).
      const agents = await selectRows<{ name: string; address: string }>(
        deps.pool,
        `SELECT a.name, x.address
           FROM (SELECT DISTINCT ON (p.agent_id) p.agent_id, p.address_id
                   FROM agent_primary_changes p JOIN agents g ON g.id = p.agent_id
                  WHERE g.organization_id = $1
                  ORDER BY p.agent_id, p.created_at DESC, p.id DESC) AS last
           JOIN agent_addresses x ON x.id = last.address_id AND x.domain = $2
           JOIN agents a ON a.id = last.agent_id
          ORDER BY a.created_at, a.id`,
        [row.organization_id, row.domain],
      );

      let sesMessageId = '';
      try {
        const locales = await recipientLocales(deps.pool, row.organization_id, recipients);
        const view: DomainNoticeView = {
          kind: row.kind,
          domain: row.domain,
          suspendedReason: row.kind === 'suspended' ? row.suspended_reason : null,
          daysLeft: row.kind === 'expiry_warning' ? daysLeftOf(row.event_key) : null,
          recovered: row.kind === 'verified' && row.event_key.startsWith('recovered:'),
          primaryAgents: agents.slice(0, MAX_AGENTS_SHOWN),
          primaryAgentCount: agents.length,
        };
        const renderFor = renderPerLocale((locale) => renderDomainNotice(view, locale));
        for (const recipient of recipients) {
          const rendered = renderFor(locales.get(recipient) ?? DEFAULT_MAIL_LOCALE);
          ({ sesMessageId } = await transport.sendOwnerNotification({
            notificationId: row.id,
            fromAddress: DOMAIN_NOTICE_FROM_ADDRESS,
            fromHeader: DOMAIN_NOTICE_FROM_HEADER,
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
            ? `UPDATE domain_notices SET status = 'dead', last_error = 'send_failed' WHERE id = $1 AND status = 'pending' AND attempt_count = $2`
            : `UPDATE domain_notices SET next_attempt_at = $3, last_error = 'send_failed' WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
          dead ? [row.id, attempt] : [row.id, attempt, new Date(now.getTime() + RETRY_BASE_MS * 2 ** (attempt - 1))],
        );
        log(dead ? 'error' : 'warn', 'domain_notice.failed', {
          route_id: DOMAIN_NOTICE_ROUTE_ID,
          outcome: dead ? 'dead' : 'retry',
          error_kind: error instanceof Error ? error.name : typeof error,
          detail: `notice_id=${row.id}`,
        });
        return dead ? 'dead' : 'retry';
      }

      // 여기부터 알림은 이미 나갔다 — 기록 실패로 던지지 않는다(던지면 다음 틱이 다시 보낸다).
      const settled = await deps.pool
        .query(
          `UPDATE domain_notices SET status = 'sent', sent_at = $3, ses_message_id = $4, last_error = NULL
            WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
          [row.id, attempt, deps.now(), sesMessageId],
        )
        .then((result) => result.rowCount === 1)
        .catch(() => false);
      log(settled ? 'info' : 'warn', 'domain_notice.sent', {
        route_id: DOMAIN_NOTICE_ROUTE_ID,
        outcome: 'sent',
        detail: `notice_id=${row.id} recipients=${String(recipients.length)} settled=${String(settled)}`,
      });
      return 'sent';
    },
  };
}
