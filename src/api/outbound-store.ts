/**
 * src/api/outbound-store.ts — 발송 `messages` 행의 생성·조회. **멱등성의 뿌리다** (§4.5-1).
 *
 * 관문은 **이미 존재하는 행**에 조건부 UPDATE 로 lease 를 건다(§4.5-3). 그 행을 만드는
 * 것이 이 파일이고, 만드는 순간 두 가지가 확정된다:
 *
 *   ① **`(agent_id, idempotency_key)` 유니크 인덱스가 중복을 DB 에서 죽인다.**
 *      애플리케이션 선조회("있나 보고 없으면 넣는다")는 경합에서 진다 — AC-i1 이
 *      요구하는 "동일 키 100회 동시 호출 → 행 1개" 를 보장하는 것은 인덱스뿐이다.
 *      그래서 여기서는 **먼저 INSERT 하고, 진 쪽이 조회한다.**
 *
 *   ② **`recipient_count` 가 채워진다.** 이 값이 워밍업 캡(§3.3, R22)의 눈금을 공급한다 —
 *      `policy-source.ts` 의 `orgRecipientsLastDay` 가 이 컬럼을 `sum()` 한다.
 *      메시지 수를 넣으면 캡이 조용히 최대 50배 느슨해지고, 그 캡이 SES 계정 한도
 *      50,000통/일에 대한 **유일한 제동장치**다. DB CHECK `messages_outbound_has_recipients`
 *      가 `>= 1` 을 강제하지만, *올바른 값*까지는 강제하지 못한다. 그것이 이 파일의 책임이다.
 *
 *   ③ **스레드와 수신자 목록이 같은 트랜잭션으로 생긴다 (P3a).** 발송 행은 에이전트 스레드 하나를 열고
 *      (`messages_outbound_has_thread`), 수신자 전원이 `outbound_recipients` 에 남는다 — 상대의 회신이
 *      이 스레드에 권한으로 이어지는 유일한 근거다(`mail/thread/resolve.ts`).
 *
 * **`request_hash` 는 멱등 키의 나머지 절반이다.** 유니크 인덱스는 같은 키의 2회차를
 * 막을 뿐, 그 2회차가 *같은 요청*이었는지는 말해 주지 않는다. 수신자 집합은 이 테이블에
 * 컬럼 자체가 없으므로(PRD 제약), 해시를 INSERT 시점에 남기지 않으면 그 차이는 나중에
 * 어떤 방법으로도 복원되지 않는다. 불일치 시 409 판정은 `outbound-service.ts` 가 한다.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '../db/client';
import { SNIPPET_MAX_LENGTH, toAgentId, type AgentId, type OutboundMessageStatus } from '../db/schema';
import { normalizeSubject } from '../mail/thread/resolve';
import { contentKeyFor } from './content-store';

/** 발송 행 하나에 대해 API 층이 알아야 하는 전부. 행 전체를 들고 다니지 않는다. */
export interface OutboundMessageSnapshot {
  readonly id: string;
  readonly agentId: AgentId;
  readonly status: OutboundMessageStatus;
  readonly messageIdHeader: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly recipientCount: number;
  readonly sesMessageId: string | null;
  readonly failureReason: string | null;
  /**
   * 이 행이 관문을 지난 적이 있는가 — 이 행의 `audit_logs` 가 하나라도 있는가. 관문은 거부·승인 대기면 평가 직후,
   * 허용이면 lease 직후 audit 을 쓴다. `pending` 인데 `false` 면 **아무도 관문으로 데려가지 않은 행**이다
   * (앞단이 INSERT 뒤·관문 전에 실패했다 — 202609230510). `pending` 이면서 `true` 는 승인 대기다.
   */
  readonly gated: boolean;
}

export interface OutboundMessageInsert {
  readonly agentId: AgentId;
  /** 정규화된 발신 주소. 해시와 도메인이 여기서 파생된다. */
  readonly fromAddress: string;
  /** 제목. `messages.subject` 는 998자 상한이다(SMTP 한 줄 한계). */
  readonly subject: string | null;
  readonly messageIdHeader: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  /** **수신자 수.** 주소가 아니라 기수. 워밍업 캡의 눈금이다. */
  readonly recipientCount: number;
  /**
   * **수신자 전원** (P3a). `outbound_recipients` 에 같은 트랜잭션으로 들어간다 — 스레드 권한 판정
   * ("회신자가 원 메일의 수신자인가", `mail/thread/resolve.ts`)의 유일한 근거다. 개수(`recipientCount`)와
   * 따로 받는 이유: 캡의 눈금은 요청이 말한 수이고, 이 목록은 대조용 집합(소문자·중복 제거)이다.
   */
  readonly recipients: readonly string[];
  /**
   * **이미 있는 권한용 스레드에 붙인다**(P3b 회신). `null` 이면 이 발송이 새 에이전트 스레드를 연다(P3a 동작).
   * 값이 있으면 같은 트랜잭션에서 그 스레드가 **이 에이전트의 것**인지 확인하고(0행이면 던진다) 활동 시각만
   * 갱신한다 — `started_by` 는 바뀌지 않는다(트리거). 외부인이 연 스레드에 우리가 답해도 그 스레드는 여전히
   * `external` 이고, 그 스레드의 다음 회신도 `auto_approve_reply_within_thread` 로 열리지 않는다.
   */
  readonly threadId: string | null;
  /**
   * **본문 미리보기** (US-004) — `snippetOf(text)` 의 값(≤ `SNIPPET_MAX_LENGTH`, 한 줄). `messages.snippet` 에 INSERT 와 함께 들어간다.
   * 본문 전체는 여기 없다 — S3(`outbound/content/{id}.json`, `content-store.ts`)에만 있고 행은 그 키(`body_storage_key`)만 가진다.
   * 생략하면 `null`(테스트 지반).
   */
  readonly snippet?: string | null;
  /**
   * 발신 DLP 계열(ADR-0016 B — 닫힌 다섯 값, `messages.outbound_dlp`). 발송 서비스가 관문 앞에서 계산한다. 생략하면 `null`(테스트 지반 — 운영 경로는
   * `outbound-service.prepare` 하나이고 항상 채운다).
   */
  readonly outboundDlp?: readonly string[];
}

/**
 * INSERT 결과. `replayed` 는 **오류가 아니라 정상 경로**다 —
 * 같은 멱등 키의 재호출이 최초 결과를 그대로 받는 상태(§4.5-1).
 */
export type OutboundInsertOutcome =
  | { readonly kind: 'inserted'; readonly message: OutboundMessageSnapshot }
  | { readonly kind: 'replayed'; readonly message: OutboundMessageSnapshot };

export interface OutboundMessageStore {
  /** 먼저 INSERT 하고, 유니크 인덱스에 진 쪽이 기존 행을 읽어 온다. */
  insertOrReplay(input: OutboundMessageInsert): Promise<OutboundInsertOutcome>;
  /** 현재 상태 재조회. 전송 결과 확정 뒤 응답을 만들 때 쓴다. */
  findById(messageId: string): Promise<OutboundMessageSnapshot | null>;
  /**
   * **관문에 닿지 못한 `pending` 행을 이어서 진행할 권리**를 잡는다(202609230510). 잡으면 세대(≥1), 못 잡으면 `null`.
   *
   * 잡히는 조건 전부: 행이 `pending` · 그 행의 audit 이 없다 · 현재 보유자가 없다(INSERT 한 시도의 암묵 임대
   * `created_at + ttl` 이 지났거나 그 시도가 놓았고, 이어받은 시도의 `claimed_until` 도 지났다). 조건부 쓰기 한 번이라
   * 동시에 여럿이 와도 한 명만 잡는다. `now` 는 호출자의 시계다(관문·임대와 같은 시계).
   */
  claimUngated(messageId: string, now: Date, ttlSeconds: number): Promise<number | null>;
  /** 보유자가 **알고 실패했다** — 즉시 놓는다. `generation` 0 은 INSERT 한 시도. 남의 세대는 건드리지 않는다. */
  releaseClaim(messageId: string, generation: number): Promise<void>;
}

/** 요청 정규형 — 이 값의 sha256 이 `request_hash` 다. */
export interface OutboundRequestShape {
  readonly routeId: string;
  readonly fromAddress: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string | null;
  /** 회신이면 답하는 수신 메일의 id(`inbound_messages.id`), 아니면 `null`. */
  readonly inReplyTo: string | null;
  /** 첨부 id(자리 순, A2). 없거나 비면 해시에 키가 없다. */
  readonly attachmentIds?: readonly string[];
}

/**
 * 요청 해시. **수신자 순서를 정렬한다** — `[a, b]` 와 `[b, a]` 는 같은 발송이고,
 * 순서 차이로 409 를 내면 클라이언트가 재시도 때마다 다른 답을 받는다.
 * 나머지 필드는 그대로 쓴다: 제목 한 글자가 달라졌다면 그건 **다른 메일**이다.
 */
export function hashOutboundRequest(shape: OutboundRequestShape): string {
  const canonical = JSON.stringify({
    routeId: shape.routeId,
    fromAddress: shape.fromAddress,
    recipients: [...shape.recipients].sort(),
    subject: shape.subject,
    text: shape.text,
    html: shape.html,
    // **회신일 때만 키가 생긴다** — 회신이 아닌 요청의 해시는 P3b 이전과 바이트 단위로 같다(진행 중인 멱등
    // 재호출이 배포를 사이에 두고 409 가 되지 않게). 같은 키로 **다른 메일에 답하는** 재호출은 다른 요청이다.
    ...(shape.inReplyTo === null ? {} : { inReplyTo: shape.inReplyTo }),
    // **첨부가 있을 때만 키가 생긴다**(A2) — 첨부 없는 요청의 해시는 예전과 같다. 같은 키로 다른 첨부를 보내면 다른 요청(409).
    ...((shape.attachmentIds ?? []).length === 0 ? {} : { attachmentIds: [...(shape.attachmentIds ?? [])] }),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** `messages.from_address_hash` — sha256 hex 64자. 평문 주소는 이 테이블에 남지 않는다(§5.4). */
function hashAddress(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase(), 'utf8').digest('hex');
}

/** `agent@atmark.ai` → `atmark.ai`. `from_domain` CHECK 가 소문자를 요구한다. */
function domainPart(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) {
    throw new Error(`발신 주소에서 도메인을 뽑을 수 없다: ${JSON.stringify(address)}`);
  }
  return address.slice(at + 1).toLowerCase();
}

interface MessageRowShape {
  id: string;
  agent_id: string;
  status: OutboundMessageStatus;
  message_id_header: string;
  idempotency_key: string;
  request_hash: string;
  recipient_count: number;
  ses_message_id: string | null;
  failure_reason: string | null;
  gated: boolean;
}

const SELECT_COLUMNS =
  'id, agent_id, status, message_id_header, idempotency_key, request_hash, recipient_count, ses_message_id, failure_reason, ' +
  'EXISTS (SELECT 1 FROM audit_logs a WHERE a.message_id = messages.id) AS gated';

function toSnapshot(row: MessageRowShape): OutboundMessageSnapshot {
  return {
    id: row.id,
    agentId: toAgentId(row.agent_id),
    status: row.status,
    messageIdHeader: row.message_id_header,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    recipientCount: row.recipient_count,
    sesMessageId: row.ses_message_id,
    failureReason: row.failure_reason,
    gated: row.gated,
  };
}

async function selectOne<R = MessageRowShape>(db: Queryable, text: string, values: unknown[]): Promise<R | null> {
  const result = await db.query<R & Record<string, unknown>>(text, values);
  return result.rows[0] ?? null;
}

/** 멱등 키 충돌 — 트랜잭션을 되돌리기 위한 신호. `insertOrReplay` 밖으로 새지 않는다. */
class IdempotencyReplay extends Error {
  constructor() {
    super('idempotency replay');
    this.name = 'IdempotencyReplay';
  }
}

export function createPostgresOutboundMessageStore(pool: Pool): OutboundMessageStore {
  return {
    async insertOrReplay(input: OutboundMessageInsert): Promise<OutboundInsertOutcome> {
      if (!Number.isInteger(input.recipientCount) || input.recipientCount < 1) {
        // DB CHECK 가 어차피 막지만, 여기서 끊어야 메시지가 "무엇이 잘못됐는가" 를 말한다.
        // 그리고 이 값이 캡의 눈금이므로, 잘못된 값이 DB 까지 가는 경로를 만들지 않는다.
        throw new Error(
          `recipient_count 는 1 이상의 정수여야 한다 (워밍업 캡의 눈금): ${String(input.recipientCount)}`,
        );
      }

      const snippet = input.snippet ?? null;
      if (snippet !== null && [...snippet].length > SNIPPET_MAX_LENGTH) {
        // DB CHECK(512자)가 어차피 막지만, 여기서 끊어야 원인이 보인다 — 스니펫이 본문 컬럼으로 자라는 길이 없다.
        throw new Error(`snippet 은 ${String(SNIPPET_MAX_LENGTH)}자 이하여야 한다 (messages.snippet CHECK)`);
      }

      const recipients = [...new Set(input.recipients.map((address) => address.trim().toLowerCase()))];
      if (recipients.length === 0) {
        // 수신자 목록 없는 발송 행은 그 회신을 어떤 스레드에도 잇지 못한다(`resolve.ts` 강한 증거 1).
        throw new Error('recipients 가 비어 있다 — outbound_recipients 없이 발송 행을 만들지 않는다');
      }

      // **스레드 · 발송 행 · 수신자를 한 트랜잭션으로 (P3a).** 발송 행은 태어날 때 스레드를 갖는다
      // (DB CHECK `messages_outbound_has_thread`). 멱등 키 충돌(재호출)이면 이 트랜잭션이 만든 스레드는
      // 고아가 되므로 **통째로 되돌리고** 기존 행을 읽는다 — 그래서 `ON CONFLICT DO NOTHING` 의 0행을
      // 여기서는 예외로 바꿔 ROLLBACK 을 탄다.
      let inserted: MessageRowShape | null = null;
      try {
        inserted = await withTransaction(pool, async (client) => {
          const thread =
            input.threadId === null
              ? await selectOne<{ id: string }>(
                  client,
                  `INSERT INTO threads (agent_id, started_by, starter_address, subject_normalized)
                   VALUES ($1, 'agent', $2, $3)
                   RETURNING id`,
                  [
                    input.agentId,
                    input.fromAddress.trim().toLowerCase(),
                    input.subject === null ? null : normalizeSubject(input.subject).normalized || null,
                  ],
                )
              : // 에이전트 범위로 묶어 갱신한다 — 0행이면 스레드가 없거나 남의 것이다. 복합 FK 가 어차피 막지만,
                // 여기서 끊어야 오류가 원인을 말한다(`inbound-store.ts` 와 같은 모양).
                await selectOne<{ id: string }>(
                  client,
                  `UPDATE threads SET last_message_at = greatest(last_message_at, now())
                    WHERE id = $1::uuid AND agent_id = $2
                    RETURNING id`,
                  [input.threadId, input.agentId],
                );
          if (thread === null) {
            throw new Error(
              input.threadId === null
                ? 'threads INSERT 가 행을 돌려주지 않았다'
                : `스레드가 없거나 이 에이전트의 것이 아니다 (thread=${input.threadId})`,
            );
          }

          // **id 를 여기서 정한다** (US-004) — 본문 키(`outbound/content/{id}.json`)가 id 에서 유도되고, 그 키를 같은 INSERT 에
          // 싣기 위해서다. 본문 객체는 이 INSERT **뒤에** 쓰인다(`outbound-service.proceed` — 키가 id 이므로 앞일 수 없다).
          // 그래서 이 칸은 "본문이 여기 있다" 가 아니라 "이 발송의 본문 자리는 여기다" 이고, 쓰기가 실패한 행(관문 전
          // 실패)은 자리만 있다 — 읽는 쪽(관리 로그 상세)이 "없음" 을 그대로 말한다. DB CHECK(202609241320)가 키 모양을
          // id 에 묶는다 — 이 칸으로 다른 발송의 본문을 가리킬 수 없다.
          const id = randomUUID();
          const row = await selectOne<MessageRowShape>(
            client,
            `INSERT INTO messages
               (id, agent_id, direction, from_address_hash, from_domain, subject, status,
                message_id_header, idempotency_key, request_hash, recipient_count, thread_id, snippet, body_storage_key, outbound_dlp)
             VALUES ($1, $2, 'outbound', $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, $12, $13::text[])
             ON CONFLICT (agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL
               DO NOTHING
             RETURNING ${SELECT_COLUMNS}`,
            [
              id,
              input.agentId,
              hashAddress(input.fromAddress),
              domainPart(input.fromAddress),
              input.subject,
              input.messageIdHeader,
              input.idempotencyKey,
              input.requestHash,
              input.recipientCount,
              thread.id,
              snippet,
              contentKeyFor(id),
              input.outboundDlp === undefined ? null : [...input.outboundDlp],
            ],
          );
          if (row === null) throw new IdempotencyReplay();

          await client.query(
            `INSERT INTO outbound_recipients (message_id, address)
             SELECT $1, address FROM unnest($2::text[]) AS address`,
            [row.id, recipients],
          );
          return row;
        });
      } catch (error) {
        if (!(error instanceof IdempotencyReplay)) throw error;
      }

      if (inserted !== null) return { kind: 'inserted', message: toSnapshot(inserted) };

      // 0행 = 같은 (agent_id, idempotency_key) 가 이미 있다. **경합에서 진 쪽이다.**
      const existing = await selectOne(
        pool,
        `SELECT ${SELECT_COLUMNS} FROM messages WHERE agent_id = $1 AND idempotency_key = $2`,
        [input.agentId, input.idempotencyKey],
      );
      if (existing === null) {
        // INSERT 가 충돌로 0행인데 조회도 0행이다 — 유니크 인덱스가 사라졌거나 다른
        // 제약에 걸렸다는 뜻이다. 어느 쪽이든 멱등성이 집행되지 않는 상태이므로 던진다.
        throw new Error(
          `멱등 키 충돌인데 기존 행을 찾지 못했다 (agentId=${input.agentId}, key=${input.idempotencyKey}). ` +
            'messages_agent_idempotency_key 인덱스를 확인해라.',
        );
      }
      return { kind: 'replayed', message: toSnapshot(existing) };
    },

    async findById(messageId: string): Promise<OutboundMessageSnapshot | null> {
      const row = await selectOne(pool, `SELECT ${SELECT_COLUMNS} FROM messages WHERE id = $1`, [messageId]);
      return row === null ? null : toSnapshot(row);
    },

    async claimUngated(messageId: string, now: Date, ttlSeconds: number): Promise<number | null> {
      // 한 문장이다 — 판정(pending·audit 없음·암묵 임대 만료)과 쓰기가 갈라지면 둘이 같이 "비었다" 를 본다.
      // 표에 행이 없으면 INSERT 가, 있으면 ON CONFLICT 의 WHERE(만료)가 한 명만 통과시킨다.
      const row = await selectOne<{ generation: number }>(
        pool,
        `WITH target AS (
           SELECT m.id
             FROM messages m
            WHERE m.id = $1::uuid
              AND m.direction = 'outbound'
              AND m.status = 'pending'
              AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.message_id = m.id)
              AND (m.created_at <= $2::timestamptz - make_interval(secs => $3)
                   OR EXISTS (SELECT 1 FROM outbound_prepare_claims c WHERE c.message_id = m.id))
         )
         INSERT INTO outbound_prepare_claims AS c (message_id, claimed_until, generation, updated_at)
         SELECT id, $2::timestamptz + make_interval(secs => $3), 1, now() FROM target
         ON CONFLICT (message_id) DO UPDATE
           SET claimed_until = EXCLUDED.claimed_until, generation = c.generation + 1, updated_at = now()
           WHERE c.claimed_until <= $2::timestamptz
         RETURNING c.generation`,
        [messageId, now, ttlSeconds],
      );
      return row === null ? null : row.generation;
    },

    async releaseClaim(messageId: string, generation: number): Promise<void> {
      // 세대 0(INSERT 한 시도)은 표에 행이 없다 — 행을 만들며 놓는다. 이미 행이 있으면 누군가 이어받은 뒤이므로
      // 건드리지 않는다(DO NOTHING). 세대 ≥1 은 자기 세대일 때만 놓는다.
      await pool.query(
        generation === 0
          ? `INSERT INTO outbound_prepare_claims (message_id, claimed_until, generation)
             VALUES ($1::uuid, '-infinity', 0) ON CONFLICT (message_id) DO NOTHING`
          : `UPDATE outbound_prepare_claims SET claimed_until = '-infinity', updated_at = now()
              WHERE message_id = $1::uuid AND generation = $2`,
        generation === 0 ? [messageId] : [messageId, generation],
      );
    },
  };
}
