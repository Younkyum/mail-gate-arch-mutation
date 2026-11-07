/**
 * src/db/repositories/draft-store.ts — **초안**(`drafts`, 202610081200 — 묶음 B).
 *
 * 모든 조회 · 쓰기가 **에이전트 범위**다(`agent_id = $1`) — 남의 에이전트의 초안 id 는 없는 것과 같다(라우트가 인가를 먼저 끝낸다). 본문은 여기 없다
 * (`storage/draft-content-store.ts`). 고치기는 **낙관적**이다 — 읽은 판(`revision`)이 그대로일 때만 바뀐다(아니면 `conflict`). 보내기는 두 단계다:
 * `claimSend`(키를 잡는다 — 그 뒤로 내용이 굳는다, 트리거) → 관문 → `markSent`(메시지 id) 또는 `releaseClaim`(관문 앞에서 멈췄다 — 고쳐서 다시 보낼 수
 * 있다). 지우지 않는다 — `discard` 는 `discarded_at` 하나다.
 */

import type { Pool } from 'pg';

import { sqlStateOf, withTransaction } from '../client';
import type { AgentId } from '../schema';
import { selectRow, selectRows } from './rows';

export interface DraftRow {
  readonly id: string;
  readonly agentId: AgentId;
  readonly revision: number;
  readonly fromAddress: string | null;
  readonly recipients: readonly string[];
  readonly subject: string | null;
  readonly inReplyTo: string | null;
  readonly attachmentIds: readonly string[];
  readonly contentStorageKey: string;
  readonly contentBytes: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly discardedAt: Date | null;
  readonly sendIdempotencyKey: string | null;
  readonly sentMessageId: string | null;
  readonly sentAt: Date | null;
}

/** 초안의 내용 칸(본문 키 · 크기 포함). 만들기 · 고치기가 같은 모양을 넘긴다. */
export interface DraftFields {
  readonly fromAddress: string | null;
  readonly recipients: readonly string[];
  readonly subject: string | null;
  readonly inReplyTo: string | null;
  readonly attachmentIds: readonly string[];
  readonly contentStorageKey: string;
  readonly contentBytes: number;
}

export interface DraftCursor {
  readonly updatedAt: Date;
  readonly id: string;
}

/** 목록의 상태 필터 — `active`(기본: 버리지도 보내지도 않은 것) · `sent` · `discarded` · `all`. */
export type DraftListStatus = 'active' | 'sent' | 'discarded' | 'all';

export type DraftInsertOutcome =
  | { readonly kind: 'inserted'; readonly row: DraftRow }
  | { readonly kind: 'limit' }
  /** 살아 있는 초안 본문 합계가 에이전트 상한(100 MiB — `drafts_integrity`, 202610081210)을 넘는다. */
  | { readonly kind: 'storage_limit' };
export type DraftUpdateOutcome =
  | { readonly kind: 'updated'; readonly row: DraftRow }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'storage_limit' }
  /** 판이 그새 바뀌었거나 굳었다(보내는 중 · 보냄 · 버림). 호출자가 다시 읽어 이유를 고른다. */
  | { readonly kind: 'conflict'; readonly row: DraftRow };
export type DraftClaimOutcome =
  | { readonly kind: 'claimed'; readonly row: DraftRow }
  | { readonly kind: 'not_found' }
  /** 다른 키가 잡았거나(보내는 중 · 보냄) 버린 초안이다. */
  | { readonly kind: 'unavailable'; readonly row: DraftRow };

export interface DraftStore {
  /**
   * 행을 넣는다. `beforeCommit` 이 있으면 **행을 넣은 같은 트랜잭션 안에서** 커밋 전에 부른다(본문 객체 쓰기 — 배포 전 보안 리뷰: 상한 · 오류로 행이 못 들어가면
   * 객체도 쓰지 않는다; 객체 쓰기가 실패하면 행도 되돌린다).
   */
  insert(agentId: AgentId, id: string, fields: DraftFields, beforeCommit?: () => Promise<void>): Promise<DraftInsertOutcome>;
  find(agentId: AgentId, id: string): Promise<DraftRow | null>;
  list(agentId: AgentId, options: { readonly limit: number; readonly cursor: DraftCursor | null; readonly status: DraftListStatus }): Promise<readonly DraftRow[]>;
  /** `expectedRevision` 이 그대로이고 굳지 않았을 때만 `fields` 로 바꾸고 판을 하나 올린다(`fields.contentStorageKey` 는 새 판의 키). */
  /**
   * `nextRevision`(기본 `expectedRevision + 1`)은 새 판 번호다 — 앞선 판 번호에 참조되지 않은 객체가 남아 있으면(쓰기와 행 갱신 사이의 장애) 호출자가 그 뒤 번호를
   * 고른다(초안이 영영 `draft_revision_conflict` 에 묶이지 않게). 판은 앞으로만(트리거).
   */
  update(agentId: AgentId, id: string, expectedRevision: number, fields: DraftFields, nextRevision?: number): Promise<DraftUpdateOutcome>;
  discard(agentId: AgentId, id: string): Promise<DraftUpdateOutcome>;
  /** 보내기 키를 잡는다 — 같은 키가 이미 잡았으면 그대로 `claimed`(재시도). */
  claimSend(agentId: AgentId, id: string, idempotencyKey: string): Promise<DraftClaimOutcome>;
  /** 관문이 평가한 시도의 메시지 id 를 적는다 — 그 키가 잡고 있을 때만. 이미 같은 메시지로 적혔으면 그대로. */
  markSent(agentId: AgentId, id: string, idempotencyKey: string, messageId: string): Promise<DraftRow | null>;
  /** 관문 앞에서 멈춘 시도의 키를 놓는다(보내지 않은 초안만). */
  releaseClaim(agentId: AgentId, id: string, idempotencyKey: string): Promise<void>;
}

interface Row {
  id: string;
  agent_id: AgentId;
  revision: number;
  from_address: string | null;
  recipients: string[];
  subject: string | null;
  in_reply_to: string | null;
  attachment_ids: string[];
  content_storage_key: string;
  content_bytes: number;
  created_at: Date;
  updated_at: Date;
  discarded_at: Date | null;
  send_idempotency_key: string | null;
  sent_message_id: string | null;
  sent_at: Date | null;
}

const COLUMNS = `id::text AS id, agent_id, revision, from_address, recipients, subject, in_reply_to::text AS in_reply_to,
                 attachment_ids::text[] AS attachment_ids, content_storage_key, content_bytes, created_at, updated_at, discarded_at,
                 send_idempotency_key, sent_message_id::text AS sent_message_id, sent_at`;

function toRow(row: Row): DraftRow {
  return {
    id: row.id,
    agentId: row.agent_id,
    revision: row.revision,
    fromAddress: row.from_address,
    recipients: row.recipients,
    subject: row.subject,
    inReplyTo: row.in_reply_to,
    attachmentIds: row.attachment_ids,
    contentStorageKey: row.content_storage_key,
    contentBytes: row.content_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    discardedAt: row.discarded_at,
    sendIdempotencyKey: row.send_idempotency_key,
    sentMessageId: row.sent_message_id,
    sentAt: row.sent_at,
  };
}

/** 트리거의 상한 거부(`drafts_guard` — P0001 · HINT `draft_limit` · `drafts_integrity` — HINT `draft_storage_limit`). */
function isHint(error: unknown, wanted: string): boolean {
  return sqlStateOf(error) === 'P0001' && (error as { hint?: unknown }).hint === wanted;
}
const isDraftLimit = (error: unknown): boolean => isHint(error, 'draft_limit');
const isStorageLimit = (error: unknown): boolean => isHint(error, 'draft_storage_limit');

const STATUS_PREDICATE: Readonly<Record<DraftListStatus, string>> = {
  active: 'discarded_at IS NULL AND sent_message_id IS NULL',
  sent: 'sent_message_id IS NOT NULL',
  discarded: 'discarded_at IS NOT NULL',
  all: 'TRUE',
};

export function createPostgresDraftStore(pool: Pool): DraftStore {
  async function find(agentId: AgentId, id: string): Promise<DraftRow | null> {
    const row = await selectRow<Row>(pool, `SELECT ${COLUMNS} FROM drafts WHERE agent_id = $1 AND id = $2::uuid`, [agentId, id]);
    return row === null ? null : toRow(row);
  }

  async function settledUpdate(agentId: AgentId, id: string, updated: Row | null): Promise<DraftUpdateOutcome> {
    if (updated !== null) return { kind: 'updated', row: toRow(updated) };
    const current = await find(agentId, id);
    return current === null ? { kind: 'not_found' } : { kind: 'conflict', row: current };
  }

  return {
    async insert(agentId, id, fields, beforeCommit) {
      try {
        return await withTransaction(pool, async (client) => {
          const row = await selectRow<Row>(
            client,
            `INSERT INTO drafts (id, agent_id, from_address, recipients, subject, in_reply_to, attachment_ids, content_storage_key, content_bytes)
             VALUES ($1::uuid, $2, $3, $4::text[], $5, $6::uuid, $7::uuid[], $8, $9)
             RETURNING ${COLUMNS}`,
            [id, agentId, fields.fromAddress, [...fields.recipients], fields.subject, fields.inReplyTo, [...fields.attachmentIds], fields.contentStorageKey, fields.contentBytes],
          );
          if (row === null) throw new Error('drafts INSERT 가 행을 돌려주지 않았다');
          if (beforeCommit !== undefined) await beforeCommit();
          return { kind: 'inserted', row: toRow(row) } as const;
        });
      } catch (error) {
        if (isDraftLimit(error)) return { kind: 'limit' };
        if (isStorageLimit(error)) return { kind: 'storage_limit' };
        throw error;
      }
    },

    find,

    async list(agentId, options) {
      // 상태 술어는 닫힌 표의 상수 문자열이다(입력이 SQL 에 닿지 않는다).
      const rows = await selectRows<Row>(
        pool,
        `SELECT ${COLUMNS} FROM drafts
          WHERE agent_id = $1 AND ${STATUS_PREDICATE[options.status]}
            AND ($2::timestamptz IS NULL OR (updated_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY updated_at DESC, id DESC
          LIMIT $4`,
        [agentId, options.cursor?.updatedAt ?? null, options.cursor?.id ?? null, options.limit],
      );
      return rows.map(toRow);
    },

    async update(agentId, id, expectedRevision, fields, nextRevision) {
      let row: Row | null;
      try {
        row = await selectRow<Row>(
        pool,
        `UPDATE drafts
            SET revision = $11, from_address = $4, recipients = $5::text[], subject = $6, in_reply_to = $7::uuid,
                attachment_ids = $8::uuid[], content_storage_key = $9, content_bytes = $10
          WHERE agent_id = $1 AND id = $2::uuid AND revision = $3
            AND discarded_at IS NULL AND sent_message_id IS NULL AND send_idempotency_key IS NULL
          RETURNING ${COLUMNS}`,
        [agentId, id, expectedRevision, fields.fromAddress, [...fields.recipients], fields.subject, fields.inReplyTo, [...fields.attachmentIds], fields.contentStorageKey, fields.contentBytes, nextRevision ?? expectedRevision + 1],
      );
      } catch (error) {
        if (isStorageLimit(error)) return { kind: 'storage_limit' };
        throw error;
      }
      return settledUpdate(agentId, id, row);
    },

    async discard(agentId, id) {
      // 보내는 중(키를 잡은 뒤)인 초안은 버리지 않는다 — 관문이 평가하는 동안 "버렸다" 와 "보냈다" 가 함께 서지 않게.
      const row = await selectRow<Row>(
        pool,
        `UPDATE drafts SET discarded_at = now()
          WHERE agent_id = $1 AND id = $2::uuid AND discarded_at IS NULL AND sent_message_id IS NULL AND send_idempotency_key IS NULL
          RETURNING ${COLUMNS}`,
        [agentId, id],
      );
      return settledUpdate(agentId, id, row);
    },

    async claimSend(agentId, id, idempotencyKey) {
      const row = await selectRow<Row>(
        pool,
        `UPDATE drafts SET send_idempotency_key = $3, send_claimed_at = now()
          WHERE agent_id = $1 AND id = $2::uuid AND discarded_at IS NULL AND sent_message_id IS NULL
            AND (send_idempotency_key IS NULL OR send_idempotency_key = $3)
          RETURNING ${COLUMNS}`,
        [agentId, id, idempotencyKey],
      );
      if (row !== null) return { kind: 'claimed', row: toRow(row) };
      const current = await find(agentId, id);
      if (current === null) return { kind: 'not_found' };
      // 같은 키로 이미 보낸 초안 — 재시도다(관문 앞 재생이 같은 결과를 돌려준다).
      if (current.sentMessageId !== null && current.sendIdempotencyKey === idempotencyKey) return { kind: 'claimed', row: current };
      return { kind: 'unavailable', row: current };
    },

    async markSent(agentId, id, idempotencyKey, messageId) {
      const row = await selectRow<Row>(
        pool,
        `UPDATE drafts SET sent_message_id = $4::uuid, sent_at = now()
          WHERE agent_id = $1 AND id = $2::uuid AND send_idempotency_key = $3 AND sent_message_id IS NULL
          RETURNING ${COLUMNS}`,
        [agentId, id, idempotencyKey, messageId],
      );
      if (row !== null) return toRow(row);
      const current = await find(agentId, id);
      return current !== null && current.sentMessageId === messageId ? current : null;
    },

    async releaseClaim(agentId, id, idempotencyKey) {
      await pool.query(
        `UPDATE drafts SET send_idempotency_key = NULL, send_claimed_at = NULL
          WHERE agent_id = $1 AND id = $2::uuid AND send_idempotency_key = $3 AND sent_message_id IS NULL`,
        [agentId, id, idempotencyKey],
      );
    },
  };
}
