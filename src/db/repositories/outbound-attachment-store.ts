/**
 * src/db/repositories/outbound-attachment-store.ts — 발신 첨부의 **DB 면**(메일 기본기 2차 A2, 마이그레이션 202609270130). 앱 롤.
 *
 *   - 업로드 행 INSERT — 에이전트 잠금(`outbound_attachments:<agent>`, DB 천장 트리거와 같은 키) 아래에서 24시간 개수·바이트를 먼저 센다
 *     (넘으면 `daily_limit` — 라우트가 429). 시각·만료 상한은 DB 트리거가 다시 적는다.
 *   - 에이전트 범위 조회 — id 와 에이전트를 **둘 다** 건다(남의 첨부는 없는 것과 같다).
 *   - 메시지 결속 — 자리마다 한 행(재시도가 같은 결속을 다시 적으면 그대로 둔다). 승인 릴리스의 Stage 6 메타는 이 행에서 나온다.
 *     결속 천장 트리거(23514)는 `AttachmentLinkLimitError` 로 옮긴다(보안 리뷰 N1).
 * 바이트·본문은 여기 없다(S3). 파일명은 행에 있지만 로그에는 싣지 않는다.
 */

import type { Pool } from 'pg';

import { sqlStateOf, withTransaction, type Queryable } from '../client';

/** 에이전트당 24시간 업로드 천장 — DB 트리거 `outbound_attachments_daily_ceiling` 과 같은 값. */
export const DAILY_ATTACHMENT_UPLOADS_PER_AGENT = 100;
export const DAILY_ATTACHMENT_BYTES_PER_AGENT = 200 * 1024 * 1024;
/** 조직당 24시간 업로드 바이트 천장(보안 리뷰 L7) — 에이전트를 여럿 두어 하루 상한을 곱하지 못한다. DB 트리거와 같은 값. */
export const DAILY_ATTACHMENT_BYTES_PER_ORG = 1024 * 1024 * 1024;
/** 첨부 하나를 결속할 수 있는 메시지 수(보안 리뷰 M2) — 영구본은 첨부 id 당 하나이고 여러 메일이 참조한다. DB 트리거와 같은 값. */
export const MAX_LINKS_PER_ATTACHMENT = 50;
/**
 * 결속 천장 트리거(`message_attachments_link_ceiling`, 202609270131)가 막았다 — 앱 선검사(`linkCounts`)는 잠금 없이 세므로 같은 첨부를 동시에
 * 보내면 여기까지 온다(보안 리뷰 N1). 발송 준비가 409 `attachment_link_limit` 로 옮긴다. `attachmentId` 는 트리거 메시지에서 읽은 것(없으면 `null`).
 */
export class AttachmentLinkLimitError extends Error {
  constructor(readonly attachmentId: string | null) {
    super('message_attachments: 첨부 결속 천장에 닿았다');
    this.name = 'AttachmentLinkLimitError';
  }
}

/** 트리거의 RAISE 문구(`message_attachments: attachment <id> already linked to <n> messages (max 50)`) — SQLSTATE 23514 와 함께 본다. */
const LINK_CEILING_MESSAGE = /^message_attachments: attachment ([0-9a-f-]{36}) already linked to \d+ messages \(max \d+\)$/;

/**
 * pg 오류가 결속 천장 트리거의 것인가 — SQLSTATE `23514` **이고** (문구가 트리거의 RAISE 모양이거나 `where` 문맥이 그 트리거 함수다).
 * 다른 23514(CHECK 제약)는 `constraint` 가 있고 문구가 다르다 — 여기 걸리지 않는다. 걸리면 첨부 id(문구에서), 아니면 `undefined`.
 */
export function linkCeilingViolation(error: unknown): { readonly attachmentId: string | null } | undefined {
  if (sqlStateOf(error) !== '23514') return undefined;
  const { message, where } = error as { message?: unknown; where?: unknown };
  const matched = typeof message === 'string' ? LINK_CEILING_MESSAGE.exec(message) : null;
  if (matched !== null) return { attachmentId: matched[1] ?? null };
  return typeof where === 'string' && where.includes('message_attachments_link_ceiling(') ? { attachmentId: null } : undefined;
}

export interface OutboundAttachmentRow {
  readonly id: string;
  readonly agentId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly stagingKey: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface NewAttachmentUpload {
  readonly id: string;
  readonly agentId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly stagingKey: string;
  readonly now: Date;
  /**
   * 선택 `Idempotency-Key`(묶음 B — 202610081200 ③). 있으면 에이전트 잠금 아래 같은 키의 행을 먼저 찾는다: 같은 요청 해시면 그 행(`replayed` — 새 행 ·
   * 하루 상한 소모 없음), 다르면 `idempotency_conflict`.
   */
  readonly idempotency?: { readonly key: string; readonly requestHash: string };
}

export type InsertUploadOutcome =
  | { readonly kind: 'inserted'; readonly row: OutboundAttachmentRow }
  | { readonly kind: 'replayed'; readonly row: OutboundAttachmentRow }
  | { readonly kind: 'idempotency_conflict'; readonly attachmentId: string }
  | { readonly kind: 'daily_limit' }
  | { readonly kind: 'org_daily_limit' };

/** 업로드 생성 전의 발송 가능 상태(보안 리뷰 L3) — Stage 0 과 같은 칸. */
export interface AttachmentSendingState {
  readonly agentStatus: string;
  readonly billingStatus: string;
  readonly abuseFreeze: boolean;
  readonly ownerPaused: boolean;
  readonly reviewStatus: string;
}

/** 메시지 한 통의 결속 한 줄(자리 0부터). */
export interface MessageAttachmentLink {
  readonly position: number;
  readonly attachmentId: string;
  readonly permanentKey: string;
}

/** Stage 6 메타 + 영구 키(릴리스·전송). */
export interface MessageAttachmentMeta {
  readonly position: number;
  readonly attachmentId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly permanentKey: string;
}

export interface OutboundAttachmentStore {
  insertUpload(upload: NewAttachmentUpload): Promise<InsertUploadOutcome>;
  /** 에이전트·조직의 발송 가능 상태. 에이전트가 없으면 `null`. */
  sendingState(agentId: string): Promise<AttachmentSendingState | null>;
  /** 첨부 id → 지금까지 결속된 메시지 수. */
  linkCounts(ids: readonly string[]): Promise<ReadonlyMap<string, number>>;
  findForAgent(agentId: string, ids: readonly string[]): Promise<readonly OutboundAttachmentRow[]>;
  linkToMessage(messageId: string, links: readonly MessageAttachmentLink[]): Promise<void>;
  metaForMessage(messageId: string): Promise<readonly MessageAttachmentMeta[]>;
}

interface Row {
  id: string;
  agent_id: string;
  filename: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  staging_key: string;
  created_at: Date;
  expires_at: Date;
}

const COLUMNS = 'id::text AS id, agent_id, filename, mime_type, bytes, sha256, staging_key, created_at, expires_at';

function toRow(row: Row): OutboundAttachmentRow {
  return {
    id: row.id,
    agentId: row.agent_id,
    filename: row.filename,
    mimeType: row.mime_type,
    bytes: row.bytes,
    sha256: row.sha256,
    stagingKey: row.staging_key,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function createPostgresOutboundAttachmentStore(pool: Pool): OutboundAttachmentStore {
  return {
    insertUpload(upload: NewAttachmentUpload): Promise<InsertUploadOutcome> {
      return withTransaction(pool, async (client) => {
        // 조직 잠금(보안 리뷰 L7) → 에이전트 잠금 — DB 천장 트리거와 같은 순서·키.
        const org = await client.query<{ organization_id: string }>('SELECT organization_id FROM agents WHERE id = $1', [upload.agentId]);
        const organizationId = org.rows[0]?.organization_id;
        if (organizationId === undefined) throw new Error('outbound_attachments: 에이전트가 없다');
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('outbound_attachments_org:' || $1::text, 0))`, [organizationId]);
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('outbound_attachments:' || $1, 0))`, [upload.agentId]);
        if (upload.idempotency !== undefined) {
          const existing = await client.query<Row & { request_hash: string }>(
            `SELECT ${COLUMNS}, request_hash FROM outbound_attachments WHERE agent_id = $1 AND idempotency_key = $2`,
            [upload.agentId, upload.idempotency.key],
          );
          const found = existing.rows[0];
          if (found !== undefined) {
            return found.request_hash === upload.idempotency.requestHash
              ? { kind: 'replayed', row: toRow(found) }
              : { kind: 'idempotency_conflict', attachmentId: found.id };
          }
        }
        const orgUsed = await client.query<{ total: string }>(
          `SELECT coalesce(sum(o.bytes), 0)::text AS total
             FROM outbound_attachments o JOIN agents a ON a.id = o.agent_id
            WHERE a.organization_id = $1 AND o.created_at > now() - interval '24 hours'`,
          [organizationId],
        );
        if (Number(orgUsed.rows[0]?.total ?? '0') + upload.bytes > DAILY_ATTACHMENT_BYTES_PER_ORG) return { kind: 'org_daily_limit' };
        const used = await client.query<{ uploads: number; total: string }>(
          `SELECT count(*)::int AS uploads, coalesce(sum(bytes), 0)::text AS total
             FROM outbound_attachments WHERE agent_id = $1 AND created_at > now() - interval '24 hours'`,
          [upload.agentId],
        );
        const uploads = used.rows[0]?.uploads ?? 0;
        const total = Number(used.rows[0]?.total ?? '0');
        if (uploads >= DAILY_ATTACHMENT_UPLOADS_PER_AGENT || total + upload.bytes > DAILY_ATTACHMENT_BYTES_PER_AGENT) {
          return { kind: 'daily_limit' };
        }
        const inserted = await client.query<Row>(
          `INSERT INTO outbound_attachments (id, agent_id, filename, mime_type, bytes, sha256, staging_key, expires_at, idempotency_key, request_hash)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, now() + interval '2 days', $8, $9)
           RETURNING ${COLUMNS}`,
          [
            upload.id,
            upload.agentId,
            upload.filename,
            upload.mimeType,
            upload.bytes,
            upload.sha256,
            upload.stagingKey,
            upload.idempotency?.key ?? null,
            upload.idempotency?.requestHash ?? null,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error('outbound_attachments INSERT 가 행을 돌려주지 않았다');
        return { kind: 'inserted', row: toRow(row) };
      });
    },

    async sendingState(agentId: string): Promise<AttachmentSendingState | null> {
      const result = await pool.query<{ status: string; billing_status: string; abuse_freeze: boolean; owner_paused: boolean; review_status: string }>(
        `SELECT a.status::text AS status, o.billing_status::text AS billing_status, o.abuse_freeze, o.owner_paused, o.review_status::text AS review_status
           FROM agents a JOIN organizations o ON o.id = a.organization_id WHERE a.id = $1`,
        [agentId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        agentStatus: row.status,
        billingStatus: row.billing_status,
        abuseFreeze: row.abuse_freeze,
        ownerPaused: row.owner_paused,
        reviewStatus: row.review_status,
      };
    },

    async linkCounts(ids: readonly string[]): Promise<ReadonlyMap<string, number>> {
      if (ids.length === 0) return new Map();
      const result = await pool.query<{ attachment_id: string; n: number }>(
        `SELECT attachment_id::text AS attachment_id, count(*)::int AS n FROM message_attachments WHERE attachment_id = ANY ($1::uuid[]) GROUP BY attachment_id`,
        [[...ids]],
      );
      return new Map(result.rows.map((row) => [row.attachment_id, row.n]));
    },

    async findForAgent(agentId: string, ids: readonly string[]): Promise<readonly OutboundAttachmentRow[]> {
      if (ids.length === 0) return [];
      const result = await pool.query<Row>(`SELECT ${COLUMNS} FROM outbound_attachments WHERE agent_id = $1 AND id = ANY ($2::uuid[])`, [
        agentId,
        [...ids],
      ]);
      return result.rows.map(toRow);
    },

    async linkToMessage(messageId: string, links: readonly MessageAttachmentLink[]): Promise<void> {
      if (links.length === 0) return;
      try {
        await pool.query(
          `INSERT INTO message_attachments (message_id, position, attachment_id, permanent_key)
           SELECT $1::uuid, l.position, l.attachment_id, l.permanent_key
             FROM unnest($2::smallint[], $3::uuid[], $4::text[]) AS l (position, attachment_id, permanent_key)
           ON CONFLICT (message_id, position) DO NOTHING`,
          [messageId, links.map((link) => link.position), links.map((link) => link.attachmentId), links.map((link) => link.permanentKey)],
        );
      } catch (error) {
        // 한 문장이라 한 행이라도 천장에 걸리면 이 메시지의 결속은 하나도 남지 않는다(부분 결속 없음).
        const ceiling = linkCeilingViolation(error);
        if (ceiling !== undefined) throw new AttachmentLinkLimitError(ceiling.attachmentId);
        throw error;
      }
    },

    async metaForMessage(messageId: string): Promise<readonly MessageAttachmentMeta[]> {
      return metaForMessage(pool, messageId);
    },
  };
}

export async function metaForMessage(db: Queryable, messageId: string): Promise<readonly MessageAttachmentMeta[]> {
  const result = await db.query<{
    position: number;
    attachment_id: string;
    filename: string;
    mime_type: string;
    bytes: number;
    sha256: string;
    permanent_key: string;
  }>(
    `SELECT l.position, l.attachment_id::text AS attachment_id, a.filename, a.mime_type, a.bytes, a.sha256, l.permanent_key
       FROM message_attachments l JOIN outbound_attachments a ON a.id = l.attachment_id
      WHERE l.message_id = $1::uuid
      ORDER BY l.position`,
    [messageId],
  );
  return result.rows.map((row) => ({
    position: row.position,
    attachmentId: row.attachment_id,
    filename: row.filename,
    mimeType: row.mime_type,
    bytes: row.bytes,
    sha256: row.sha256,
    permanentKey: row.permanent_key,
  }));
}
