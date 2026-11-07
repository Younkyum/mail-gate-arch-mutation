/**
 * src/db/repositories/thread-store.ts — `ThreadLookupPort`(src/mail/thread/resolve.ts)의 Postgres 구현.
 *
 * 해석기는 이 포트를 **믿지 않는다**(범위 밖 에이전트·요청하지 않은 키의 행을 다시 거른다). 그래도 이
 * 구현은 스스로 좁다 — 모든 조회가 `agent_id = $1` 로 시작한다. 두 층이 각자 막는다.
 *
 * 두 테이블을 본다:
 *   - `messages`(outbound) — `message_id_header` 와 `ses_message_id` 로. 수신자는 `outbound_recipients`,
 *     `sent` 는 `status = 'sent'`. **나간 적 없는 행도 돌려준다** — 거르는 것은 해석기의 `sent` 판정이다
 *     (여기서 거르면 해석기의 그 단언이 공허해진다).
 *   - `inbound_messages` — `message_id_header` 로. 발신자는 `from_address`, 인증은 `from_authenticated`
 *     (인증 안 된 행도 돌려준다 — 거르는 것은 해석기의 `senderAuthenticated` 판정이다).
 *
 * 상한(`LOOKUP_ROW_LIMIT`): 수신 `Message-ID` 는 외부가 정한다 — 같은 id 로 수천 통을 보내면 한 키의
 * 행이 수천이다. 해석기는 후보 50개 × 키 2종으로 조회를 이미 묶지만, 행 수는 여기서 묶는다.
 *
 * **Atmark 주소 상대**(별칭 재발급 보안 리뷰 M3 · `hosted-evidence.ts`): 발신자가 Atmark 주소면 그 주소의 지금 활성 행이 생기기 전의 메시지
 * (outbound 는 보낸 시각, inbound 는 받은 시각)는 근거로 돌려주지 않는다 — 재발급된 주소의 새 주인이 예전 주인이 받은 메일의 id 로 기존 스레드의
 * 권한을 얻지 못하게. 폐기·보류 중(활성 행 없음)이면 아무 행도 돌려주지 않는다. 다른 도메인의 발신자는 그대로다.
 */

import type { Queryable } from '../client';
import { hostedEvidenceSql } from './hosted-evidence';
import type {
  HeaderLookupKey,
  KnownMessage,
  ThreadLookupPort,
} from '../../mail/thread/resolve';

export const LOOKUP_ROW_LIMIT = 200;

interface OutboundRow {
  id: string;
  agent_id: string;
  thread_id: string;
  status: string;
  message_id_header: string;
  ses_message_id: string | null;
  recipients: string[];
}

interface InboundRow {
  id: string;
  agent_id: string;
  thread_id: string;
  from_address: string;
  from_authenticated: boolean;
  message_id_header: string;
}

export function createPostgresThreadLookup(db: Queryable): ThreadLookupPort {
  return {
    async findByHeaderKeys(agentId: string, keys: readonly HeaderLookupKey[], counterpart: string | null): Promise<readonly KnownMessage[]> {
      const headerIds = keys.filter((key) => key.kind === 'message_id_header').map((key) => key.value);
      const sesIds = keys.filter((key) => key.kind === 'ses_message_id').map((key) => key.value);
      if (headerIds.length === 0 && sesIds.length === 0) return [];

      const outbound = await db.query<OutboundRow & Record<string, unknown>>(
        `SELECT m.id, m.agent_id, m.thread_id, m.status::text AS status, m.message_id_header, m.ses_message_id,
                COALESCE(
                  (SELECT array_agg(r.address ORDER BY r.address) FROM outbound_recipients r WHERE r.message_id = m.id),
                  '{}'::text[]
                ) AS recipients
           FROM messages m
          WHERE m.agent_id = $1
            AND m.direction = 'outbound'
            AND m.thread_id IS NOT NULL
            AND (m.message_id_header = ANY($2::text[]) OR m.ses_message_id = ANY($3::text[]))
            AND ${hostedEvidenceSql('$4::text', 'coalesce(m.sent_at, m.created_at)')}
          LIMIT ${String(LOOKUP_ROW_LIMIT)}`,
        [agentId, headerIds, sesIds, counterpart],
      );

      const inbound =
        headerIds.length === 0
          ? { rows: [] as InboundRow[] }
          : await db.query<InboundRow & Record<string, unknown>>(
              `SELECT id, agent_id, thread_id, from_address, from_authenticated, message_id_header
                 FROM inbound_messages
                WHERE agent_id = $1 AND message_id_header = ANY($2::text[])
                  AND ${hostedEvidenceSql('$3::text', 'inbound_messages.received_at')}
                ORDER BY received_at
                LIMIT ${String(LOOKUP_ROW_LIMIT)}`,
              [agentId, headerIds, counterpart],
            );

      const found: KnownMessage[] = [];
      for (const row of outbound.rows) {
        const base = {
          messageId: row.id,
          agentId: row.agent_id,
          threadId: row.thread_id,
          direction: 'outbound' as const,
          recipients: row.recipients,
          // 쓰지 않는다(resolve.ts: outbound 의 sender 는 에이전트 주소). 해시만 있으므로 비워 둔다.
          sender: '',
          sent: row.status === 'sent',
          senderAuthenticated: true,
        };
        // 한 행이 두 키에 동시에 맞을 수 있다 — 키마다 한 건씩(해석기가 키로 후보를 되짚는다).
        if (headerIds.includes(row.message_id_header)) {
          found.push({ ...base, matchedKey: { kind: 'message_id_header', value: row.message_id_header } });
        }
        if (row.ses_message_id !== null && sesIds.includes(row.ses_message_id)) {
          found.push({ ...base, matchedKey: { kind: 'ses_message_id', value: row.ses_message_id } });
        }
      }
      for (const row of inbound.rows) {
        found.push({
          messageId: row.id,
          agentId: row.agent_id,
          threadId: row.thread_id,
          direction: 'inbound',
          recipients: [],
          sender: row.from_address,
          sent: true,
          // 인증 안 된 행도 돌려준다 — 표시용 묶음(`header_unverified`)에는 쓰이고, 권한 판정은 해석기가 이 값으로 한다.
          senderAuthenticated: row.from_authenticated,
          matchedKey: { kind: 'message_id_header', value: row.message_id_header },
        });
      }
      return found;
    },

    /**
     * **표시용 전용.** 같은 정규화 제목이고 `counterpart` 가 참여한(= 우리가 실제로 보낸 수신자였거나,
     * 그 스레드에 메일을 보낸) 스레드. 해석기는 "정확히 하나" 일 때만 묶으므로 2건이면 충분하다.
     */
    async findThreadIdsBySubject(
      agentId: string,
      normalizedSubject: string,
      counterpart: string,
    ): Promise<readonly string[]> {
      const result = await db.query<{ id: string }>(
        `SELECT t.id
           FROM threads t
          WHERE t.agent_id = $1
            AND t.subject_normalized = $2
            AND (
              EXISTS (SELECT 1
                        FROM messages m
                        JOIN outbound_recipients r ON r.message_id = m.id
                       WHERE m.thread_id = t.id AND m.agent_id = $1 AND m.status = 'sent' AND r.address = $3
                         AND ${hostedEvidenceSql('$3::text', 'coalesce(m.sent_at, m.created_at)')})
              OR EXISTS (SELECT 1
                           FROM inbound_messages i
                          WHERE i.thread_id = t.id AND i.agent_id = $1 AND i.from_address = $3
                            AND ${hostedEvidenceSql('$3::text', 'i.received_at')})
            )
          ORDER BY t.last_message_at DESC
          LIMIT 2`,
        [agentId, normalizedSubject, counterpart],
      );
      return result.rows.map((row) => row.id);
    },
  };
}
