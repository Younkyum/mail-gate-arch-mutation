/**
 * 대기자 명단(202609301520) 통합 테스트의 공용 지반 — 소유자 롤로 초대를 **직접** 심는다(초대 코어의 전역 하루 상한·감사·메일 행을 태우지 않는다).
 * 초대 코어 자체는 `waitlist.test.ts` · `test/integration/ops/waitlist-ops.test.ts` 가 따로 본다.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

/** 테스트 주소 — 다른 테스트와 섞이지 않게. */
export const waitlistEmail = (): string => `wl-${randomBytes(5).toString('hex')}@example.com`;

/** 요청자 상한(시간당 5)이 테스트끼리 섞이지 않게 요청마다 새 소스 IP. */
export const uniqueIp = (): string => `203.0.113.${String(Math.floor(Math.random() * 250))}-${randomUUID()}`;

/**
 * 살아 있는(또는 `expiredDaysAgo` 만큼 지난) 초대 한 행을 심는다. 이미 행이 있으면 초대 상태로 바꾼다. 항목 id.
 */
export async function seedInvite(
  owner: Pool,
  email: string,
  options: { readonly lang?: 'ko' | 'en'; readonly expiredDaysAgo?: number; readonly note?: string | null } = {},
): Promise<string> {
  const ageDays = options.expiredDaysAgo === undefined ? 0 : 14 + options.expiredDaysAgo;
  const row = await owner.query<{ id: string }>(
    `INSERT INTO waitlist_entries (email, lang, note, source, status, invited_at, invite_expires_at, invited_by, created_at)
     VALUES ($1, $2, $3, 'site', 'invited', now() - make_interval(days => $4), now() - make_interval(days => $4) + interval '14 days', 'test:seed',
             now() - make_interval(days => $4) - interval '1 day')
     ON CONFLICT (email) DO UPDATE SET status = 'invited', invited_at = EXCLUDED.invited_at, invite_expires_at = EXCLUDED.invite_expires_at,
                                       invited_by = EXCLUDED.invited_by
     RETURNING id`,
    [email, options.lang ?? 'ko', options.note ?? null, ageDays],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error('waitlist_entries 심기 실패');
  return id;
}

export interface EntryRow {
  id: string;
  email: string | null;
  lang: string;
  note: string | null;
  source: string;
  status: string;
  joined_at: Date | null;
  invite_expires_at: Date | null;
  last_confirmation_sent_at: Date | null;
}

export async function entryOf(owner: Pool, email: string): Promise<EntryRow | null> {
  const row = await owner.query<EntryRow>(
    'SELECT id, email, lang, note, source, status, joined_at, invite_expires_at, last_confirmation_sent_at FROM waitlist_entries WHERE email = $1',
    [email],
  );
  return row.rows[0] ?? null;
}

export async function entryById(owner: Pool, id: string): Promise<EntryRow | null> {
  const row = await owner.query<EntryRow>(
    'SELECT id, email, lang, note, source, status, joined_at, invite_expires_at, last_confirmation_sent_at FROM waitlist_entries WHERE id = $1',
    [id],
  );
  return row.rows[0] ?? null;
}

export async function mailsOf(owner: Pool, entryId: string): Promise<{ id: string; kind: string; lang: string; status: string; last_error: string | null }[]> {
  const rows = await owner.query<{ id: string; kind: string; lang: string; status: string; last_error: string | null }>(
    'SELECT id, kind, lang, status, last_error FROM waitlist_mails WHERE entry_id = $1 ORDER BY created_at, id',
    [entryId],
  );
  return rows.rows;
}

export async function eventsOf(owner: Pool, entryId: string): Promise<{ action: string; actor: string }[]> {
  const rows = await owner.query<{ action: string; actor: string }>('SELECT action, actor FROM waitlist_events WHERE entry_id = $1 ORDER BY id', [entryId]);
  return rows.rows;
}
