/**
 * src/contact/contact-store.ts — 문의 전달의 저장 어댑터 둘 (US-009, ADR-0009).
 *
 *   - `createPostgresContactIntake` — 수신 소비자 쪽(`ContactIntakePort`). 전달 문서를 S3 에 write-once 로 쓰고, 시간당 상한(차선별 ·
 *     발신자별)을 센 뒤 `contact_forwards` 에 차선과 함께 행을 적는다. 계수와 INSERT 는 **advisory lock 아래 한 트랜잭션**이다 — 수신
 *     소비자가 둘(SQS 동시성 2)이어도 상한을 넘지 않는다.
 *   - `createContactDocumentReader` — 전달 모듈 쪽. 키는 `contact/forward/{sesMessageId}.json` **하나의 모양**뿐이다(DB 에서 온
 *     id 로 유도한다 — 다른 접두사를 읽는 통로가 되지 않는다).
 *
 * 키에 발신자가 정한 문자열이 없다(SES 메시지 ID 는 SES 가 정하고 모양을 검사한다).
 */

import type { Pool } from 'pg';

import { withTransaction } from '../db/client';
import { selectRow } from '../db/repositories/rows';
import { SES_MESSAGE_ID_PATTERN } from '../inbound/receipt';
import {
  ObjectAlreadyExistsError,
  ObjectKeyFormatError,
  assertValidObjectKey,
  type ObjectStore,
} from '../storage/object-store';
import {
  CONTACT_DOCUMENT_PREFIX,
  type ContactAdmission,
  type ContactAdmitOutcome,
  type ContactIntakePort,
} from './intake';

/** 전달 문서의 읽기 상한 — 본문 50,000 코드포인트(최대 4바이트) + 머리 몇 칸. */
const CONTACT_DOCUMENT_MAX_BYTES = 512 * 1024;

const RATE_WINDOW_MS = 60 * 60 * 1000;

/** SES 메시지 ID → 전달 문서 키. 모양이 아니면 던진다. */
export function contactDocumentKey(sesMessageId: string): string {
  const key = `${CONTACT_DOCUMENT_PREFIX}${sesMessageId}.json`;
  if (!SES_MESSAGE_ID_PATTERN.test(sesMessageId)) throw new ObjectKeyFormatError(key, 'SES 메시지 ID 형식');
  assertValidObjectKey(key);
  return key;
}

export function createPostgresContactIntake(pool: Pool, objects: ObjectStore): ContactIntakePort {
  return {
    async isAdmitted(sesMessageId: string): Promise<boolean> {
      const row = await selectRow<{ id: string }>(pool, `SELECT id FROM contact_forwards WHERE ses_message_id = $1`, [sesMessageId]);
      return row !== null;
    },

    async putDocument(sesMessageId: string, json: string): Promise<{ readonly key: string; readonly created: boolean }> {
      const key = contactDocumentKey(sesMessageId);
      try {
        await objects.putIfAbsent(key, new TextEncoder().encode(json), 'application/json');
        return { key, created: true };
      } catch (error) {
        if (error instanceof ObjectAlreadyExistsError) return { key, created: false };
        throw error;
      }
    },

    async admit(input: ContactAdmission): Promise<ContactAdmitOutcome> {
      return withTransaction(pool, async (client) => {
        // 전역 직렬화 — 계수와 INSERT 사이에 다른 소비자가 끼지 못한다. 트랜잭션이 끝나면 풀린다.
        // **차선별 키로 나누지 않는다**(202610021000): 발신자 상한은 차선과 무관하게 세므로, 같은 발신자가 두 차선으로 동시에 보내면
        // 차선별 잠금 둘은 서로를 보지 못해 발신자 상한을 넘길 수 있다. 소비자 동시성 2 라 한 키의 경합 비용은 없다.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('contact_forward:admit', 0))`);
        const existing = await selectRow<{ id: string }>(client, `SELECT id FROM contact_forwards WHERE ses_message_id = $1`, [
          input.sesMessageId,
        ]);
        if (existing !== null) return 'duplicate';

        // 창은 SES 수신 시각 축 — (t - 1h, t]. 발신자가 정할 수 없는 값이고, 재전달이 늦게 와도 같은 판정이다.
        const windowStart = new Date(input.receivedAt.getTime() - RATE_WINDOW_MS);
        // 차선 상한은 같은 차선 행만, 발신자 상한은 차선과 무관하게 센다.
        const usage = await selectRow<{ lane: number; sender: number }>(
          client,
          `SELECT count(*) FILTER (WHERE lane = $4)::int AS lane,
                  count(*) FILTER (WHERE sender_hash = $3)::int AS sender
             FROM contact_forwards
            WHERE received_at > $1 AND received_at <= $2`,
          [windowStart, input.receivedAt, input.senderHash, input.lane],
        );
        if ((usage?.lane ?? 0) >= input.laneCap) return 'rate_global';
        if ((usage?.sender ?? 0) >= input.senderCap) return 'rate_sender';

        const inserted = await client.query(
          `INSERT INTO contact_forwards (ses_message_id, sender_hash, next_attempt_at, received_at, lane)
           VALUES ($1, $2, $3, $3, $4)
           ON CONFLICT (ses_message_id) DO NOTHING`,
          [input.sesMessageId, input.senderHash, input.receivedAt, input.lane],
        );
        return inserted.rowCount === 1 ? 'admitted' : 'duplicate';
      });
    },
  };
}

/** 전달 모듈이 보는 면 — 문서 바이트 하나. 모양 해석은 전달 모듈의 몫이다. */
export interface ContactDocumentReader {
  read(sesMessageId: string): Promise<Uint8Array>;
}

/** 읽기만 받는다 — 운영 조립은 접두사 하나(`contact/forward/`)에 묶인 읽기 전용 리더(`createS3ObjectReader`)를 준다. */
export function createContactDocumentReader(objects: Pick<ObjectStore, 'get'>): ContactDocumentReader {
  return {
    async read(sesMessageId: string): Promise<Uint8Array> {
      return objects.get(contactDocumentKey(sesMessageId), CONTACT_DOCUMENT_MAX_BYTES);
    },
  };
}
