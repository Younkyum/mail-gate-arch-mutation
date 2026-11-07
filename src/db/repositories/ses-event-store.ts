/**
 * src/db/repositories/ses-event-store.ts — `ses_events` 의 Postgres 구현 (ADR-0004).
 *
 * 세 가지 질문에 답한다. **셋이 서로 다른 질문이라는 것이 이 파일의 설계다:**
 *
 *   ① `record`      — "이 이벤트를 처음 보는가?" (멱등성. 집행은 유니크 인덱스)
 *   ② `findSendEvidence` — "**이 메일은 나갔는가?**" (ADR-0004 결정 2. lease 만료 재전송 직전)
 *   ③ `freshness`   — "**소비자가 살아 있는가?**" (ADR-0004 Consequences 의 두 번째 창)
 *
 * ②와 ③을 한 함수로 합치고 싶은 유혹이 있다 — 둘 다 `ses_events` 를 읽으니까. 합치면
 * **조회 실패와 소비자 정지가 한 값으로 접힌다.** 그 둘의 올바른 대응이 정반대라서
 * 접으면 안 된다: 조회 실패는 *그 한 건*의 판단을 유보하는 일이고, 소비자 정지는
 * *전건*에 대해 사람을 부르는 일이다.
 */

import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { sqlStateOf, withTransaction } from '../client';
import type { ConsumerFreshness } from '../../mail/events/health';
import {
  SEND_EVIDENCE_EVENT_TYPES,
  type SesEvent,
  type SesEventRecipients,
  type SesEventType,
  type SystemMailSuppression,
} from '../../mail/events/ses-event';
import {
  canonicalComplainant,
  complaintDomainFamily,
  type PlatformReputationOutcome,
  type PlatformReputationResult,
} from '../../mail/events/platform-reputation';
import type { SendEvidence, SendEvidenceLookup } from '../../policy/gate';
import {
  messageBouncedEvent,
  messageComplainedEvent,
  messageDeliveredEvent,
  recipientPositions,
  type WebhookEvent,
  type WebhookEventType,
} from '../../webhooks/events';
import { selectRow } from './rows';
import { enqueueWebhookEvent } from './webhook-store';

/** 같은 이벤트의 재전달이었는가. **예외가 아니라 정상 경로다** — SNS/SQS 는 at-least-once 다. */
export type RecordOutcome = 'recorded' | 'duplicate';

/**
 * 웹훅 적재가 savepoint 로 되돌려졌다 — **기록은 커밋됐다**(메일 기본기 A4, AC-A4-4). 그 웹훅은 영구 유실이고 소비자가 `webhookEnqueueFailed`
 * 메트릭과 경고 로그로 드러낸다. 원인을 버리지 않는다(코드 리뷰 M9): `errorKind` 는 오류 이름(`Error.name`), `errorCode` 는 Postgres SQLSTATE
 * (드라이버 오류가 아니면 `null`). 메시지 본문은 싣지 않는다 — 값(주소·URL)이 섞일 수 있다.
 */
export interface WebhookEnqueueFailure {
  readonly kind: 'recorded_webhook_failed';
  readonly errorKind: string;
  readonly errorCode: string | null;
}

/**
 * `record` 의 결과. 기록이 웹훅보다 먼저다: 반송·불만 기록은 SES 평판 알람과 재전송 판단(ADR-0004)의 원천이라 웹훅 한 건 때문에 잃을 수 없다
 * — 적재 실패는 `WebhookEnqueueFailure` 로 따로 돌려준다.
 */
export type SesEventRecordOutcome = RecordOutcome | WebhookEnqueueFailure;

/** 발송 결과 웹훅의 입력 — 파서가 읽은 수신자(`SesEventRecipients`)와 적재 시각(outbox `next_attempt_at`). */
export interface SesEventWebhookInput {
  readonly recipients: SesEventRecipients;
  readonly now: Date;
}

export interface SesEventStore extends SendEvidenceLookup {
  /**
   * 이벤트 한 건. 같은 `dedupeKey` 가 이미 있으면 `'duplicate'` 이고 **아무것도 바꾸지 않는다**(웹훅도 다시 적지 않는다 — 재전달 0행).
   * `webhook` 이 있고 종류가 delivery·bounce·complaint 이면 **같은 트랜잭션의 savepoint 안에서** 구독한 엔드포인트에 발송 결과 웹훅을 적는다.
   */
  record(event: SesEvent, webhook?: SesEventWebhookInput): Promise<SesEventRecordOutcome>;
  /** 소비자 정지 감지의 입력. 판정 자체는 `mail/events/health.ts` 가 한다(I/O 없이). */
  freshness(): Promise<ConsumerFreshness>;
  /**
   * 시스템 메일의 하드 바운스·불만 주소를 `system_mail_suppressions` 에 적는다(보안 검증 H2). 이미 있는 주소는 그대로 —
   * 하나라도 새로 적었으면 `'recorded'`, 전부 있었으면 `'duplicate'`.
   */
  recordSystemMailSuppression(suppression: SystemMailSuppression): Promise<RecordOutcome>;
  /**
   * 공유 도메인 조직 평판(202610131620 `atmark_platform_reputation_check`) — 그 메시지의 조직을 판정하고 선을 넘으면 동결한다(정의자 함수 하나 ·
   * 판정 · 동결 · 감사가 한 트랜잭션). 메시지 행이 없으면 `null`. 던지면 소비자가 `failed`(재전달 — 함수는 멱등이다).
   */
  checkPlatformReputation(messageId: string): Promise<PlatformReputationResult | null>;
}

interface EvidenceRow {
  event_type: SesEventType;
  ses_message_id: string | null;
}

interface FreshnessRow {
  last_event_at: Date | null;
  last_sent_at: Date | null;
}

/** SES 이벤트 종류 → 발송 결과 웹훅 종류. 여기 없는 종류(send·reject·rendering_failure·delivery_delay)는 웹훅이 없다. */
const OUTCOME_WEBHOOK_TYPES: Readonly<Partial<Record<SesEventType, WebhookEventType>>> = {
  delivery: 'message.delivered',
  bounce: 'message.bounced',
  complaint: 'message.complained',
};

/** savepoint 이름 — 한 트랜잭션에 하나뿐이다. */
const WEBHOOK_SAVEPOINT = 'webhook_enqueue';

/** Postgres SQLSTATE 모양(5자, 숫자·대문자). 드라이버 오류의 `code` 만 이 모양이다 — 그 밖(`ECONNRESET` 등)은 `null`. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

function webhookEnqueueFailure(error: unknown): WebhookEnqueueFailure {
  const code = sqlStateOf(error);
  return {
    kind: 'recorded_webhook_failed',
    errorKind: error instanceof Error ? error.name : typeof error,
    errorCode: code !== undefined && SQLSTATE.test(code) ? code : null,
  };
}

/**
 * 발송 결과 웹훅 적재(savepoint 안에서 불린다). 메일의 에이전트와 수신자 전원을 읽고, 그 에이전트에 **이 종류를 구독한** 켜진 엔드포인트가
 * 없으면 아무것도 하지 않는다(0) — 구독자가 없는 에이전트에게는 위치 계산조차 하지 않는다. 반환값은 적은 outbox 행 수. 던지면 호출자가
 * savepoint 로 되돌린다.
 */
export async function enqueueOutcomeWebhook(
  client: PoolClient,
  event: SesEvent & { readonly messageId: string },
  type: WebhookEventType,
  webhook: SesEventWebhookInput,
): Promise<number> {
  const row = await selectRow<{ agent_id: string; recipients: string[] }>(
    client,
    `SELECT m.agent_id, ARRAY(SELECT r.address FROM outbound_recipients r WHERE r.message_id = m.id) AS recipients
       FROM messages m
      WHERE m.id = $1 AND m.direction = 'outbound'
        AND EXISTS (SELECT 1 FROM webhook_endpoints e
                     WHERE e.agent_id = m.agent_id AND e.disabled_at IS NULL AND $2::webhook_event_type = ANY (e.event_types))`,
    [event.messageId, type],
  );
  if (row === null) return 0;
  const input = {
    agentId: row.agent_id,
    messageId: event.messageId,
    sesDedupeKey: event.dedupeKey,
    occurredAt: event.eventAt,
    recipientPositions: recipientPositions(row.recipients, webhook.recipients.addresses),
  };
  let built: WebhookEvent;
  if (type === 'message.bounced') {
    built = messageBouncedEvent({ ...input, bounceType: webhook.recipients.bounceType ?? 'undetermined' });
  } else if (type === 'message.complained') {
    built = messageComplainedEvent(input);
  } else {
    built = messageDeliveredEvent(input);
  }
  return enqueueWebhookEvent(client, built, webhook.now);
}

/**
 * 구독 선조회(자동 커밋 한 문장) — 메일의 에이전트에게 이 종류를 구독한 켜진 엔드포인트가 있는가. `enqueueOutcomeWebhook` 의 EXISTS 와 같은
 * 조건이다(그쪽이 savepoint 안에서 한 번 더 거른다). 색인: `messages` PK → `webhook_endpoints_agent_id_idx`(부분, 켜진 행).
 */
async function hasOutcomeSubscriber(pool: Pool, messageId: string, type: WebhookEventType): Promise<boolean> {
  const row = await selectRow<{ subscribed: boolean }>(
    pool,
    `SELECT EXISTS (
       SELECT 1 FROM messages m JOIN webhook_endpoints e ON e.agent_id = m.agent_id
        WHERE m.id = $1 AND m.direction = 'outbound'
          AND e.disabled_at IS NULL AND $2::webhook_event_type = ANY (e.event_types)
     ) AS subscribed`,
    [messageId, type],
  );
  return row?.subscribed === true;
}

/** 수신자 단위 집계의 수(202610131612) — delivery · bounce · complaint 는 알림의 수신자 칸 수(1~100), 그 밖은 1. */
export function recipientCountOf(eventType: SesEventType, recipients: SesEventRecipients | undefined): number {
  if (eventType !== 'delivery' && eventType !== 'bounce' && eventType !== 'complaint') return 1;
  const count = recipients?.count ?? Math.max(recipients?.addresses.length ?? 1, 1);
  return Math.min(Math.max(Math.trunc(count), 1), 100);
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * 신고자 · 신고 도메인 계열의 sha256(재검증 R-1 — 정규형 `canonicalComplainant` · 계열 `complaintDomainFamily`). 평판은 **서로 다른** 신고자 · 계열 수로
 * 센다 — 한 사람의 반복 · 같은 메일함의 `+tag` · 한 서비스의 별칭 도메인은 하나다. 주소가 하나도 없으면 `null`(옛 행처럼 신고자 1 · 도메인 0).
 * 해시는 7일 창 + 하루 뒤 스위퍼가 지운다(재검증 I-1 — `atmark_purge_complaint_hashes`).
 */
export function complaintHashes(addresses: readonly string[]): { readonly recipients: string[]; readonly domains: string[] } | null {
  const canonical = [...new Set(addresses.flatMap((address) => {
    const value = canonicalComplainant(address);
    return value === null ? [] : [value];
  }))].slice(0, 100);
  if (canonical.length === 0) return null;
  return {
    recipients: canonical.map(sha256Hex),
    domains: [...new Set(canonical.map((address) => complaintDomainFamily(address.slice(address.lastIndexOf('@') + 1))))].map(sha256Hex),
  };
}

/** 테스트 이음새 — 적재 실패 주입(AC-A4-4). 운영 조립은 기본값(`enqueueOutcomeWebhook`)을 쓴다. */
export interface SesEventStoreOptions {
  readonly enqueueOutcomeWebhook?: typeof enqueueOutcomeWebhook;
}

export function createPostgresSesEventStore(pool: Pool, options: SesEventStoreOptions = {}): SesEventStore {
  const enqueueOutcome = options.enqueueOutcomeWebhook ?? enqueueOutcomeWebhook;
  return {
    async record(event: SesEvent, webhook?: SesEventWebhookInput): Promise<SesEventRecordOutcome> {
      // `ON CONFLICT DO NOTHING` 이 멱등성의 전부다. 선조회("있나 보고 없으면 넣는다")로
      // 바꾸면 동시에 도착한 같은 이벤트 둘이 모두 "없다" 를 읽고 둘 다 INSERT 한다 —
      // §4.5-1 이 `messages_agent_idempotency_key` 에 대해 쓴 것과 같은 경합이다.
      // bounce 종류(202610021104 — 고객 도메인 평판은 영구 bounce 만 센다, #13 M3). 소비자가 넘긴 수신자 묶음에 파싱돼 있다 — bounce 가 아니면 NULL.
      // 수신자 단위 평판(202610131612) — 수신자 수 · bounce 하위 종류 · 신고자 · 신고 도메인 해시(평문 없음).
      const insert = `INSERT INTO ses_events (message_id, event_type, ses_message_id, event_at, dedupe_key, bounce_type,
                                              recipient_count, bounce_subtype, complaint_recipient_hashes, complaint_domain_hashes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (dedupe_key) DO NOTHING`;
      const recipients = webhook?.recipients;
      const bounceType = event.eventType === 'bounce' ? (recipients?.bounceType ?? null) : null;
      const bounceSubType = event.eventType === 'bounce' ? (recipients?.bounceSubType ?? null) : null;
      const complaint = event.eventType === 'complaint' ? complaintHashes(recipients?.addresses ?? []) : null;
      const values = [
        event.messageId,
        event.eventType,
        event.sesMessageId,
        event.eventAt,
        event.dedupeKey,
        bounceType,
        recipientCountOf(event.eventType, recipients),
        bounceSubType,
        complaint?.recipients ?? null,
        complaint?.domains ?? null,
      ];
      const type = OUTCOME_WEBHOOK_TYPES[event.eventType];
      const { messageId } = event;
      // 구독 선조회(코드 리뷰 M3) — 트랜잭션을 열기 전에 자동 커밋 한 문장으로 "이 메일의 에이전트에게 이 종류를 구독한 켜진 엔드포인트가
      //   있는가" 만 묻는다. 대부분의 이벤트(구독 없음)는 예전처럼 INSERT 한 문장으로 끝난다(합계 2왕복, BEGIN·SAVEPOINT·COMMIT 없음).
      //   선조회와 INSERT 사이에 구독이 생기면 그 한 건은 웹훅이 없다 — opt-in 은 "지금부터" 라 허용한다. 반대(사이에 삭제)는 savepoint 경로
      //   안의 `enqueueOutcomeWebhook` 이 다시 거르므로 0행이다.
      if (webhook === undefined || type === undefined || messageId === null || !(await hasOutcomeSubscriber(pool, messageId, type))) {
        const result = await pool.query(insert, values);
        return result.rowCount === 1 ? 'recorded' : 'duplicate';
      }
      // ★ 기록 → SAVEPOINT → 적재. 적재(메일 조회·위치 계산·빌더·INSERT)가 무엇으로 실패하든 savepoint 까지만 되돌리고 **기록은 커밋한다**
      //   (계획 §4 A4 · R8). SQL 오류로 트랜잭션이 aborted(25P02)가 돼도 `ROLLBACK TO SAVEPOINT` 가 되살린다. 기록 자체가 실패하면 전체가
      //   롤백되고 던진다 — 소비자가 `failed` 로 재전달을 받는다.
      return withTransaction(pool, async (client): Promise<SesEventRecordOutcome> => {
        const result = await client.query(insert, values);
        if (result.rowCount !== 1) return 'duplicate';
        await client.query(`SAVEPOINT ${WEBHOOK_SAVEPOINT}`);
        try {
          await enqueueOutcome(client, { ...event, messageId }, type, webhook);
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${WEBHOOK_SAVEPOINT}`);
          return webhookEnqueueFailure(error);
        }
        await client.query(`RELEASE SAVEPOINT ${WEBHOOK_SAVEPOINT}`);
        return 'recorded';
      });
    },

    async findSendEvidence(messageId: string): Promise<SendEvidence | null> {
      // **`delivery` 를 먼저 본다.** 둘 다 "나갔다" 의 증거지만 `Delivery` 가 더 강한
      // 사실이고(수신측 MTA 가 받았다), 사후 조사에서 그쪽이 더 쓸모 있다.
      // 정렬을 `event_at DESC` 로 하지 않는 이유: bounce 가 며칠 뒤에 오듯 이벤트 시각은
      // 도착 순서와 무관하고, 여기서 묻는 것은 "언제" 가 아니라 "있는가" 다.
      const row = await selectRow<EvidenceRow>(
        pool,
        `SELECT event_type, ses_message_id
           FROM ses_events
          WHERE message_id = $1
            AND event_type = ANY($2::ses_event_type[])
          ORDER BY (event_type = 'delivery') DESC, ses_message_id IS NULL
          LIMIT 1`,
        [messageId, [...SEND_EVIDENCE_EVENT_TYPES]],
      );
      if (row === null) return null;
      return { eventType: row.event_type, sesMessageId: row.ses_message_id };
    },

    async freshness(): Promise<ConsumerFreshness> {
      // 한 왕복으로 읽는다. 두 번에 나누면 그 사이에 발송이 하나 끼어들어
      // `lastSentAt > lastEventAt` 이 되고, **정상 동작이 정지로 오판된다.**
      const row = await selectRow<FreshnessRow>(
        pool,
        `SELECT (SELECT max(received_at) FROM ses_events)              AS last_event_at,
                (SELECT max(sent_at) FROM messages WHERE status = 'sent') AS last_sent_at`,
      );
      return {
        lastEventAt: row?.last_event_at ?? null,
        lastSentAt: row?.last_sent_at ?? null,
      };
    },

    async recordSystemMailSuppression(suppression: SystemMailSuppression): Promise<RecordOutcome> {
      // 앱 롤은 이 표에 INSERT(address, reason)만 있다 — SELECT 가 없으므로 충돌 대상 없는 `ON CONFLICT DO NOTHING`
      //   (대상을 적으면 SELECT 권한이 필요하다). 먼저 적힌 사유가 남는다(행은 바뀌지 않는다 — 트리거).
      const result = await pool.query(
        `INSERT INTO system_mail_suppressions (address, reason)
         SELECT address, $2 FROM unnest($1::text[]) AS a(address)
         ON CONFLICT DO NOTHING`,
        [[...suppression.addresses], suppression.reason],
      );
      return (result.rowCount ?? 0) > 0 ? 'recorded' : 'duplicate';
    },
    async checkPlatformReputation(messageId: string): Promise<PlatformReputationResult | null> {
      const row = await selectRow<{ organization_id: string; outcome: PlatformReputationOutcome; reasons: string[] }>(
        pool,
        'SELECT organization_id::text AS organization_id, outcome, reasons FROM atmark_platform_reputation_check($1::uuid)',
        [messageId],
      );
      return row === null ? null : { organizationId: row.organization_id, outcome: row.outcome, reasons: row.reasons };
    },
  };
}
