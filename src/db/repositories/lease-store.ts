/**
 * src/db/repositories/lease-store.ts — `LeaseStore` 의 Postgres 구현. **§4.5-3 그 자체다.**
 *
 *   `UPDATE messages SET status='dispatching', lease_id=$2, lease_expires_at=..., attempt=attempt+1
 *    WHERE id=$1 AND (status='pending' OR (status='dispatching' AND lease_expires_at < now()))`
 *
 * **영향 행이 0이면 즉시 실패를 돌려준다.** 중복 SQS 전달이 여기서 죽는다 —
 * 진 쪽은 no-op 이고, audit 행도 쓰지 않으며(gate 가 그렇게 짜여 있다), 전송도 없다.
 * "먼저 읽고 판단한 뒤 쓴다" 로 바꾸면 그 사이에 다른 워커가 끼어들 수 있고,
 * 그 경합이 곧 같은 사람에게 세 번 가는 메일이다.
 *
 * **`now` 를 호출자가 준다.** `now()` 를 SQL 안에서 부르면 테스트가 만료를 재현할 수
 * 없고, 재현할 수 없는 만료 로직은 AC-i3("만료 전에는 재전송하지 않고 만료 후에는
 * 같은 Message-ID 로 재전송")을 증명할 방법이 없다.
 */

import type { Pool } from 'pg';

import type { LeaseRequest, LeaseStore } from '../../policy/gate';
import { messageSentEvent } from '../../webhooks/events';
import { withTransaction } from '../client';
import type { MessageStatus } from '../schema';
import { selectRow } from './rows';
import { markDomainSendingStarted } from './sending-clock';
import { enqueueWebhookEvent } from './webhook-store';

/** `messages` 행이 없다. lease 를 잡을 대상이 애초에 없으므로 보내지 않는다(fail closed). */
export class MessageNotFoundError extends Error {
  constructor(messageId: string) {
    super(`messages 행이 없다 (id=${messageId})`);
    this.name = 'MessageNotFoundError';
  }
}

interface StatusRow {
  status: MessageStatus;
}

/**
 * 전송 결과 확정까지 포함하는 리포지토리.
 *
 * `LeaseStore`(관문이 보는 면)에는 `acquire`/`statusOf` 만 있다 — 관문은 결과를
 * **반환**하고 저장은 호출자의 일이다. 그런데 그 저장이 호출자마다 다른 SQL 이 되면
 * 상태기계 CHECK 를 통과하는 조합을 각자 찾아 헤매게 되므로, 여기서 두 개만 더 낸다.
 * **`lease_id` 를 WHERE 에 넣는 것이 핵심이다** — lease 를 잃은 워커(만료 후 다른
 * 워커가 가져간 경우)가 돌아와 결과를 덮어쓰지 못한다.
 */
export interface MessageDispatchStore extends LeaseStore {
  /**
   * 전송 성공 확정. lease 를 여전히 쥐고 있을 때만 1행 — 그리고 **그 1행과 같은 트랜잭션에서**
   * `message.sent` 웹훅을 outbox 에 적는다(§3.4 1조). 0행이면(lease 를 잃었다) 이벤트도 없다 —
   * lease 를 가져간 쪽이 확정하고 그쪽이 적는다. 그래서 같은 메일의 `message.sent` 는 확정 1회당 1번이고,
   * 생산 쪽 중복은 `dedupe_key`(`message.sent:<id>`)가 outbox 에서 한 번 더 죽인다.
   */
  settleSent(messageId: string, leaseId: string, sesMessageId: string, now: Date): Promise<boolean>;
  /** 전송 실패 확정. 같은 조건. */
  settleFailed(messageId: string, leaseId: string, reason: string, now: Date): Promise<boolean>;
  /**
   * **정책 거부 확정** — `pending → denied` (P1b 리뷰 MAJOR 3).
   *
   * `lease_id` 가 WHERE 에 없는 것이 다른 둘과의 차이다: 거부된 시도는 lease 를 잡은 적이
   * 없다. 대신 `status='pending'` 을 조건으로 건다 — 그 사이에 누군가 lease 를 잡았다면
   * 그 시도는 **이미 나가고 있고**, 그 행을 "정책이 막았다" 로 되돌리는 것은 거짓말이다.
   */
  settleDenied(messageId: string): Promise<boolean>;
}

export function createPostgresLeaseStore(pool: Pool): MessageDispatchStore {
  return {
    async acquire(request: LeaseRequest): Promise<boolean> {
      const result = await pool.query(
        `UPDATE messages
            SET status = 'dispatching',
                lease_id = $2,
                lease_expires_at = $3::timestamptz + make_interval(secs => $4::double precision),
                attempt = attempt + 1
          WHERE id = $1
            AND direction = 'outbound'
            AND (status = 'pending'
                 OR (status = 'dispatching' AND lease_expires_at < $3::timestamptz))`,
        [request.messageId, request.leaseId, request.now, request.ttlSeconds],
      );
      return result.rowCount === 1;
    },

    async statusOf(messageId: string): Promise<MessageStatus> {
      const row = await selectRow<StatusRow>(pool, 'SELECT status FROM messages WHERE id = $1', [
        messageId,
      ]);
      // 없는 메시지를 "종단" 으로 취급하면 조용한 중복 억제가 되고, "pending" 으로
      // 취급하면 존재하지 않는 행에 lease 를 시도한다. 둘 다 거짓말이라 던진다.
      if (row === null) throw new MessageNotFoundError(messageId);
      return row.status;
    },

    async settleSent(
      messageId: string,
      leaseId: string,
      sesMessageId: string,
      now: Date,
    ): Promise<boolean> {
      // 상태기계 CHECK(`messages_state_machine`)가 'sent' 행에 요구하는 조합 그대로다:
      // ses_message_id 있음 / failure_reason 없음 / sent_at 있음 / failed_at 없음.
      // lease 컬럼은 남겨 둔다 — 누가 보냈는지가 사후 조사의 출발점이다.
      const fromDomain = await withTransaction(pool, async (client) => {
        const row = await selectRow<{ agent_id: string; from_domain: string }>(
          client,
          `UPDATE messages
              SET status = 'sent', ses_message_id = $3, sent_at = $4
            WHERE id = $1 AND lease_id = $2 AND status = 'dispatching'
            RETURNING agent_id, from_domain`,
          [messageId, leaseId, sesMessageId, now],
        );
        if (row === null) return null;
        // 이벤트가 적히지 않으면 확정도 롤백된다 — "sent 인데 알림이 영영 없다" 는 행을 만들지 않는다.
        // 그때의 결말은 UPDATE 자체가 DB 오류로 실패한 경우와 같다: 예외가 호출자에게 가고 행은
        // `dispatching` 으로 남으며, lease 만료 뒤의 재전송은 관문이 SES 증거(ADR-0004)로 막는다.
        await enqueueWebhookEvent(client, messageSentEvent({ agentId: row.agent_id, messageId, sentAt: now }), now);
        return row.from_domain;
      });
      if (fromDomain === null) return false;
      // 도메인 워밍업 시계(ADR-0014) — `sent` 커밋 **뒤**(함수가 sent 만 센다). 확정과 묶지 않는다: 시계 기록 실패가 확정을 되돌리면 나간 메일이
      // `dispatching` 으로 남는다. 실패는 삼킨다 — 시계가 없으면 도메인 캡은 첫 구간(20)에 머문다(막히는 방향, `markFirstSend` 와 같은 규율).
      // `atmark.ai` 발신이면 질의하지 않는다.
      await markDomainSendingStarted(pool, messageId, fromDomain).catch((error: unknown) => {
        console.error(
          `custom_domains.sending_started_at 세팅 실패 (messageId=${messageId}): ${error instanceof Error ? error.message : String(error)}. ` +
            '도메인 워밍업 램프는 기준일이 생길 때까지 첫 구간에 머문다.',
        );
        return false;
      });
      return true;
    },

    async settleFailed(
      messageId: string,
      leaseId: string,
      reason: string,
      now: Date,
    ): Promise<boolean> {
      const result = await pool.query(
        `UPDATE messages
            SET status = 'failed', failure_reason = $3, failed_at = $4
          WHERE id = $1 AND lease_id = $2 AND status = 'dispatching'`,
        [messageId, leaseId, reason, now],
      );
      return result.rowCount === 1;
    },

    async settleDenied(messageId: string): Promise<boolean> {
      // 상태기계 CHECK 가 'denied' 행에 요구하는 것: 결과 컬럼 전부 NULL. 그래서 이
      // UPDATE 는 status 만 바꾼다 — 거부 사유는 `audit_logs` 가 단일 출처다(§4.3, AC-9).
      // **`now` 를 받지 않는다.** `messages_set_updated_at` 트리거가 `updated_at` 을
      // 자기가 찍으므로, 인자로 받으면 무시되는 값을 받는 셈이고 그 자체가 거짓말이다.
      const result = await pool.query(
        `UPDATE messages
            SET status = 'denied'
          WHERE id = $1 AND direction = 'outbound' AND status = 'pending'`,
        [messageId],
      );
      return result.rowCount === 1;
    },
  };
}
