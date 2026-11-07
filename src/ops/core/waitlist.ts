/**
 * src/ops/core/waitlist.ts — 대기자 명단의 **운영 쓰기**(초대 · N 명 초대 · 지우기)와 CLI 조회(202609301520). CLI(`pnpm admin:waitlist`)와 로컬 운영자
 * 화면(소유자 롤)이 이 함수들을 부른다. 호스팅 콘솔은 같은 SQL 코어를 정의 함수(`ops_waitlist_*`, atmark_ops)로 부른다 — **전이 구현이 하나**다.
 *
 * 코어가 하는 일(SQL): 초대 = 상태 `invited` · 14일 · 초대 메일 한 통 · 감사 `invite`(전역 하루 5 — 202609301530 · 한 번에 50). 지우기 = 행 DELETE(주소·메모가
 * 남지 않는다) · 쌓인 메일 obsolete · 감사 `remove`(전역 하루 200). 가입 끝난 항목은 둘 다 409. 거부는 `opsSqlError` 가 `AdminInputError` 로 바꾼다.
 * 확인(운영 `yes` · 화면의 주소 입력)은 호출자가 먼저 한다.
 */

import { AdminInputError } from '../../admin/ops/errors';
import type { Queryable } from '../../db/client';
import { requireWaitlistEntryId, WAITLIST_INVITE_BATCH_MAX } from '../console/reads';
import { opsSqlError } from './review';

export interface WaitlistInviteResult {
  readonly entryId: string;
  /** 초대 전 상태(`waiting` · `invited` = 다시 보냄). */
  readonly fromStatus: string;
  readonly inviteExpiresAt: string;
}

/** 주소 → 항목 id(정규화: trim + 소문자). 없으면 `null`. CLI `--email` 이 쓴다. */
export async function findWaitlistEntryOp(db: Queryable, email: string): Promise<{ id: string; status: string } | null> {
  const row = await db.query<{ id: string; status: string }>('SELECT id, status FROM waitlist_entries WHERE email = $1', [email.trim().toLowerCase()]);
  return row.rows[0] ?? null;
}

export async function inviteWaitlistEntryOp(pool: Queryable, entryId: string, actor: string): Promise<WaitlistInviteResult> {
  const id = requireWaitlistEntryId(entryId);
  try {
    const result = await pool.query<{ entry_id: string; from_status: string; invite_expires_at: Date }>(
      'SELECT entry_id, from_status, invite_expires_at FROM waitlist_invite_core($1::uuid, $2::text)',
      [id, actor],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('waitlist_invite_core 가 행을 돌려주지 않았다');
    return { entryId: row.entry_id, fromStatus: row.from_status, inviteExpiresAt: row.invite_expires_at.toISOString() };
  } catch (error) {
    throw opsSqlError(error, id);
  }
}

export async function inviteOldestWaitlistOp(pool: Queryable, n: number, actor: string): Promise<{ entryId: string; inviteExpiresAt: string }[]> {
  if (!Number.isInteger(n) || n < 1 || n > WAITLIST_INVITE_BATCH_MAX) throw new AdminInputError(`수는 1~${String(WAITLIST_INVITE_BATCH_MAX)}.`, 'invalid_count');
  try {
    const result = await pool.query<{ entry_id: string; invite_expires_at: Date }>(
      'SELECT entry_id, invite_expires_at FROM waitlist_invite_oldest_core($1::int, $2::text)',
      [n, actor],
    );
    return result.rows.map((row) => ({ entryId: row.entry_id, inviteExpiresAt: row.invite_expires_at.toISOString() }));
  } catch (error) {
    throw opsSqlError(error, 'waitlist');
  }
}

export async function removeWaitlistEntryOp(pool: Queryable, entryId: string, actor: string): Promise<{ entryId: string; fromStatus: string }> {
  const id = requireWaitlistEntryId(entryId);
  try {
    const result = await pool.query<{ from_status: string }>('SELECT waitlist_remove_core($1::uuid, $2::text) AS from_status', [id, actor]);
    return { entryId: id, fromStatus: String(result.rows[0]?.from_status ?? '') };
  } catch (error) {
    throw opsSqlError(error, id);
  }
}

export interface WaitlistListRow {
  id: string;
  email: string | null;
  lang: string;
  note: string | null;
  source: string;
  use_case: string | null;
  heard_from: string | null;
  ref: string | null;
  status: string;
  created_at: Date;
  invite_expires_at: Date | null;
}

/** CLI `list` — 상태 하나(`waiting` 기본 · 오래 기다린 순) 최대 `limit`. `expired` = 초대가 끝난 `invited`. 이름·메모는 호출자가 정화해 찍는다. */
export async function listWaitlistOp(db: Queryable, status: 'waiting' | 'invited' | 'expired' | 'joined' | 'all', limit: number): Promise<WaitlistListRow[]> {
  const rows = await db.query<WaitlistListRow>(
    `SELECT id, email, lang, note, source, use_case, heard_from, ref, status, created_at, invite_expires_at
       FROM waitlist_entries
      WHERE CASE $1::text
              WHEN 'all' THEN true
              WHEN 'expired' THEN status = 'invited' AND invite_expires_at <= now()
              WHEN 'invited' THEN status = 'invited' AND invite_expires_at > now()
              ELSE status = $1
            END
      ORDER BY created_at, id
      LIMIT $2`,
    [status, limit],
  );
  return rows.rows;
}
