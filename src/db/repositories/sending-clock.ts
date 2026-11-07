/**
 * src/db/repositories/sending-clock.ts — `organizations.sending_started_at` 최초 세팅 (§3.3 M7).
 *
 * DB 컬럼 주석이 규약을 그대로 적어 놓았다:
 *   *"워밍업 기준일. ses-transport.ts 의 최초 성공 경로에서 null 일 때만 1회 세팅한다."*
 *
 * **왜 최초 SES 발송 *성공* 시점인가:** P0 나 프로비저닝 시점에 세팅하면 램프가
 * **한 통도 안 보낸 채 소진된다** — Day 16 에 첫 발송을 하면 그 날 상한이 이미 1000이다.
 * 워밍업은 달력이 아니라 실제 발송 이력에 대한 통제다.
 *
 * **왜 `WHERE sending_started_at IS NULL` 인가:** 조건 없는 UPDATE 는 발송마다 기준일을
 * 오늘로 밀어 램프를 영구히 Day 1 에 묶는다 — 그러면 조직은 하루 20 수신자를 영원히
 * 넘지 못한다. 반대로 애플리케이션에서 먼저 읽고 판단하면 동시 발송 두 건이 경합해
 * 늦은 쪽 값이 이긴다. **조건부 UPDATE 하나가 두 실패를 동시에 닫는다.**
 */

import type { Pool } from 'pg';

import { AGENT_ADDRESS_DOMAIN } from '../../identity/address';
import type { Queryable } from '../client';

/** 최초 발송 성공 시점을 기록하는 면. 전송단이 주입받는다. */
export interface SendingClock {
  /**
   * `messageId` 가 속한 조직의 기준일을 **아직 없을 때만** 세팅한다.
   * 이미 있으면 0행을 바꾸고 `false` 를 돌려준다 — 예외가 아니라 정상 경로다.
   */
  markFirstSend(messageId: string, now: Date): Promise<boolean>;
}

/**
 * 아무것도 하지 않는 시계.
 *
 * 단위 테스트에서 DB 없이 전송단을 돌릴 때 쓴다. **프로덕션 조립에서 이 값을 쓰면
 * 워밍업 램프가 영원히 Day 1 캡(20 수신자)에 머문다** — 조용히 느슨해지는 방향이
 * 아니라 조용히 막히는 방향이라, 사고가 아니라 장애로 드러난다(의도된 방향이다).
 */
export function noopSendingClock(): SendingClock {
  return { markFirstSend: () => Promise.resolve(false) };
}

export function createPostgresSendingClock(pool: Pool): SendingClock {
  return {
    async markFirstSend(messageId: string, now: Date): Promise<boolean> {
      const result = await pool.query(
        `UPDATE organizations o
            SET sending_started_at = $2::timestamptz
           FROM agents a, messages m
          WHERE m.id = $1
            AND a.id = m.agent_id
            AND o.id = a.organization_id
            AND o.sending_started_at IS NULL`,
        [messageId, now],
      );
      return result.rowCount === 1;
    },
  };
}

/**
 * **도메인 워밍업 시계**(ADR-0014 결정 13 · 계획 §3.7 M4) — 보낸 메시지의 발신 도메인이 고객 도메인이면 그 조직의 살아 있는 `custom_domains`
 * 행에 첫 발송 성공 시각을 **한 번** 적는다. 쓰는 것은 DEFINER 함수 `atmark_mark_domain_sending_started(message_id)` 하나뿐이다 — 앱 롤에는
 * `sending_started_at` UPDATE 권한이 없고(42501), 함수는 메시지 id 만 받는다(시각·도메인·조직을 호출자가 고르지 못한다).
 *
 * **왜 `markFirstSend` 가 아니라 여기인가:** 함수는 `status = 'sent'` 인 메시지만 센다(보안 L5 — 아직 안 나간 메시지로 시계를 당길 수 없다).
 * 전송단의 `markFirstSend` 는 SES 응답 직후, 행이 아직 `dispatching` 일 때 불리므로 그 자리에서 부르면 언제나 0행이다. 그래서 발송 확정
 * (`lease-store.ts` `settleSent` — `sent` 로 바꾼 커밋 **뒤**)이 부른다. `ses-transport.ts` 는 바꾸지 않는다(계획 §13 해석 4).
 *
 * `atmark.ai` 발신이면 DB 를 부르지 않는다(질의 0 — 고객 도메인이 없는 운영의 발송 경로는 이전과 같다). 참 = 이번에 적었다.
 */
export async function markDomainSendingStarted(db: Queryable, messageId: string, fromDomain: string): Promise<boolean> {
  if (fromDomain === AGENT_ADDRESS_DOMAIN) return false;
  const result = await db.query<{ marked: boolean }>('SELECT atmark_mark_domain_sending_started($1::uuid) AS marked', [messageId]);
  return result.rows[0]?.marked === true;
}
