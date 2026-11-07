/**
 * 대기자 명단 운영(202609301520) — CLI(`pnpm admin:waitlist` · 소유자 롤) · 로컬 운영 화면(`handleApi` · 소유자 롤) · 호스팅(`ops.atmark.ai` ·
 * `atmark_ops` 정의 함수)이 **같은 SQL 코어**로 초대 · 가장 오래 기다린 N 명 초대 · 지우기를 한다.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 초대: 상태 invited · 14일 · 초대 메일 한 통 · 감사 invite(행위자 = 표면별: `admin:waitlist:<이름>` · `admin:web:<이름>` · `ops:<uuid>`).
 *   - N 명: 등록 순(가장 오래 기다린 waiting) · 1~50 · 하루 상한을 넘기면 아무도 초대하지 않고 429 invite_cap.
 *   - 지우기: 행 DELETE(주소·메모가 남지 않는다) · 쌓인 메일 obsolete · 감사 remove(항목 id 만). 가입 끝난 항목은 409 already_joined.
 *   - 확인 입력이 틀리면 422 — 아무것도 바꾸지 않는다. 호스팅 읽기는 atmark_ops 의 칸 GRANT 로 돈다(메모는 정화해 싣는다).
 *   - 신청서(202609301530): 목록(CLI · 로컬 · 호스팅)에 용도 · 알게 된 곳 · ref · **등급 후보**(A = 보고·알림/답장 + 메모 · B = 그 밖 수신 · 보류 = 먼저 발송 ·
 *     용도 없음 = 후보 없음). 메모는 여전히 "본인 확인 안 됨" 으로 보인다.
 */

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AdminInputError, type AdminIo } from '../../../scripts/admin/common';
import { waitlist } from '../../../scripts/admin/waitlist';
import { handleApi, OPS, type ApiContext } from '../../../src/ops/console/api';
import { inviteOldestWaitlistOp, inviteWaitlistEntryOp, removeWaitlistEntryOp } from '../../../src/ops/core/waitlist';
import { entryById, entryOf, eventsOf, mailsOf, waitlistEmail } from '../signup/waitlist-support';

import { addCliOperator, APP_URL, Browser, inRolledBackOps, lockOps, OWNER_URL, openHarness, releaseOps, type OpsHarness } from './hosted-support';

const AVAILABLE = OWNER_URL.trim() !== '' && APP_URL.trim() !== '';

interface Io extends AdminIo {
  readonly outLines: string[];
  readonly errLines: string[];
}
function io(): Io {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return { outLines, errLines, out: (line) => outLines.push(line), err: (line) => errLines.push(line), interactive: false, ask: async () => '' };
}
const env = (): NodeJS.ProcessEnv => ({ DATABASE_MIGRATION_URL: OWNER_URL, USER: 'waitlist-test' });

async function waitingEntry(
  owner: Pool,
  options: { note?: string; createdAt?: string; useCase?: string; heardFrom?: string; ref?: string } = {},
): Promise<{ id: string; email: string }> {
  const email = waitlistEmail();
  const row = await owner.query<{ id: string }>(
    `INSERT INTO waitlist_entries (email, lang, note, source, created_at, use_case, heard_from, ref)
     VALUES ($1, 'ko', $2, 'site', coalesce($3::timestamptz, now()), $4, $5, $6) RETURNING id`,
    [email, options.note ?? null, options.createdAt ?? null, options.useCase ?? null, options.heardFrom ?? null, options.ref ?? null],
  );
  return { id: row.rows[0]?.id ?? '', email };
}

describe.skipIf(!AVAILABLE)('대기자 명단 운영 — CLI · 로컬 화면 · 호스팅(같은 SQL 코어)', () => {
  let h: OpsHarness;
  let owner: Pool;
  beforeAll(async () => {
    h = await openHarness();
    owner = h.owner;
  });
  afterAll(async () => {
    await h.close();
  });

  it('CLI — list(정화된 메모) · invite --email(초대 메일 · 감사) · remove --email(행 삭제 · 메일 obsolete · 감사) · 없는 주소는 입력 오류', async () => {
    // DB 는 제어·양방향·폭 없는 문자를 거부한다(CHECK) — 그 밖의 보이지 않는 문자(아랍 글자 표식 U+061C)는 들어오고, 출력이 정화한다.
    // 등록 시각을 먼 과거로 — `list` 는 오래 기다린 순 최대 1000건이라 공유 로컬 DB 에 대기 항목이 쌓여도 이 항목이 앞에 온다(끝에 지운다).
    const e = await waitingEntry(owner, { note: '악성\u061c메모', createdAt: '2001-01-01T00:00:00Z' });
    const listed = io();
    expect(await waitlist(['list', '--limit', '1000'], { env: env(), io: listed })).toBe(0);
    const line = listed.outLines.find((l) => l.startsWith(e.id));
    expect(line?.split('\t')).toEqual([
      e.id,
      e.email,
      'ko',
      'waiting',
      expect.any(String),
      '-',
      'use_case=-',
      'heard_from=-',
      'ref=-',
      'grade?=-',
      '[본인 확인 안 됨 · unverified] 악성메모',
    ]);

    const invited = io();
    expect(await waitlist(['invite', '--email', e.email.toUpperCase(), '--by', 'jin'], { env: env(), io: invited })).toBe(0);
    expect(await entryById(owner, e.id)).toMatchObject({ status: 'invited', invite_expires_at: expect.any(Date) });
    const entry = await owner.query<{ days: number; invited_by: string }>(
      `SELECT extract(epoch FROM invite_expires_at - invited_at)::int / 86400 AS days, invited_by FROM waitlist_entries WHERE id = $1`,
      [e.id],
    );
    expect(entry.rows[0]).toEqual({ days: 14, invited_by: 'admin:waitlist:jin' });
    expect((await mailsOf(owner, e.id)).map((m) => m.kind)).toEqual(['invitation']);
    expect(await eventsOf(owner, e.id)).toEqual([{ action: 'invite', actor: 'admin:waitlist:jin' }]);

    expect(await waitlist(['remove', '--email', e.email, '--by', 'jin'], { env: env(), io: io() })).toBe(0);
    expect(await entryById(owner, e.id)).toBeNull();
    expect((await mailsOf(owner, e.id)).map((m) => [m.kind, m.status])).toEqual([['invitation', 'obsolete']]);
    expect(await eventsOf(owner, e.id)).toEqual([
      { action: 'invite', actor: 'admin:waitlist:jin' },
      { action: 'remove', actor: 'admin:waitlist:jin' },
    ]);
    // 감사에는 항목 id · 행위자뿐 — 주소·메모 칸이 없다.
    const columns = await owner.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'waitlist_events' ORDER BY 1`);
    expect(columns.rows.map((r) => r.column_name)).toEqual(['action', 'actor', 'created_at', 'entry_id', 'id']);

    await expect(waitlist(['remove', '--email', e.email], { env: env(), io: io() })).rejects.toBeInstanceOf(AdminInputError);
    for (const argv of [['invite'], ['invite', '--oldest', '51'], ['invite', '--oldest', '2', '--email', e.email], ['list', '--status', 'removed'], ['nope']]) {
      await expect(waitlist(argv, { env: env(), io: io() }), argv.join(' ')).rejects.toBeInstanceOf(AdminInputError);
    }
  });

  it('코어 — 가장 오래 기다린 N 명(등록 순) · 하루 상한을 넘기면 아무도 초대하지 않는다(429 invite_cap) · 가입 끝난 항목은 409 · 다시 초대 = 새 14일 (롤백)', async () => {
    const client: PoolClient = await owner.connect();
    try {
      await client.query('BEGIN');
      // 이 트랜잭션에서만 — 가장 오래된 대기 둘을 우리 항목으로(아주 과거의 등록 시각).
      const a = await waitingEntry(client as unknown as Pool, { createdAt: '2000-01-01T00:00:00Z' });
      const b = await waitingEntry(client as unknown as Pool, { createdAt: '2000-01-02T00:00:00Z' });
      const c = await waitingEntry(client as unknown as Pool, { createdAt: '2000-01-03T00:00:00Z' });
      const invited = await inviteOldestWaitlistOp(client, 2, 'test:oldest');
      expect(invited.map((row) => row.entryId)).toEqual([a.id, b.id]);
      expect((await client.query<{ status: string }>('SELECT status FROM waitlist_entries WHERE id = $1', [c.id])).rows[0]?.status).toBe('waiting');
      await expect(inviteOldestWaitlistOp(client, 0, 'test:oldest')).rejects.toMatchObject({ code: 'invalid_count' });

      // 하루 상한 = 지금까지 쓴 수 → 한 명 더는 429 · 아무것도 바뀌지 않는다.
      await client.query(
        `UPDATE signup_limits SET waitlist_invite_daily_cap = (SELECT count(*) FROM waitlist_events WHERE action = 'invite' AND created_at > now() - interval '24 hours')`,
      );
      await client.query('SAVEPOINT cap');
      await expect(inviteWaitlistEntryOp(client, c.id, 'test:cap')).rejects.toMatchObject({ code: 'invite_cap', status: 429 });
      await client.query('ROLLBACK TO SAVEPOINT cap');
      await client.query('UPDATE signup_limits SET waitlist_invite_daily_cap = 1000000');

      // 다시 초대(살아 있는 초대) — 새 14일 · 메일 한 통 더.
      await client.query(`UPDATE waitlist_entries SET invited_at = invited_at - interval '2 days', invite_expires_at = invite_expires_at - interval '2 days' WHERE id = $1`, [a.id]);
      const again = await inviteWaitlistEntryOp(client, a.id, 'test:again');
      expect(again.fromStatus).toBe('invited');
      expect(new Date(again.inviteExpiresAt).getTime()).toBeGreaterThan(Date.now() + 13.9 * 86_400_000);
      expect((await client.query('SELECT 1 FROM waitlist_mails WHERE entry_id = $1 AND kind = $2', [a.id, 'invitation'])).rowCount).toBe(2);

      // 가입 끝난 항목(주소 없음) — 초대도 지우기도 409.
      await client.query(`UPDATE waitlist_entries SET status = 'joined', joined_at = now(), email = NULL, note = NULL WHERE id = $1`, [b.id]);
      const refused = async (run: () => Promise<unknown>): Promise<unknown> => {
        await client.query('SAVEPOINT r');
        const error = await run().then(
          () => null,
          (e: unknown) => e,
        );
        await client.query('ROLLBACK TO SAVEPOINT r');
        return error;
      };
      expect(await refused(() => inviteWaitlistEntryOp(client, b.id, 'test:joined'))).toMatchObject({ code: 'already_joined', status: 409 });
      expect(await refused(() => removeWaitlistEntryOp(client, b.id, 'test:joined'))).toMatchObject({ code: 'already_joined', status: 409 });
      expect(await refused(() => inviteWaitlistEntryOp(client, '00000000-0000-4000-8000-000000000000', 'test:none'))).toMatchObject({ code: 'entry_not_found', status: 404 });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('신청서(202609301530) — CLI list 는 용도 · 알게 된 곳 · ref · 등급 후보(A · B · 보류 · 후보 없음)를 찍고, 로컬 화면 읽기도 같은 후보를 싣는다', async () => {
    // 등록 시각을 먼 과거로 — CLI `list` 는 오래 기다린 순 최대 1000건(공유 로컬 DB 에서도 앞에 오게 · 끝에 지운다).
    const old = '2001-01-01T00:00:00Z';
    const a = await waitingEntry(owner, { note: '배포 알림을 받는 에이전트', useCase: 'alerts', heardFrom: 'github', ref: 'github', createdAt: old });
    const aNoNote = await waitingEntry(owner, { useCase: 'replies', ref: 'none', createdAt: old });
    const b = await waitingEntry(owner, { note: '가입 코드', useCase: 'codes', heardFrom: 'search', ref: 'recipe-alert-routing', createdAt: old });
    const hold = await waitingEntry(owner, { note: '콜드 메일', useCase: 'outreach', heardFrom: 'x', ref: 'devto', createdAt: old });
    const legacy = await waitingEntry(owner, { note: '1520 시절 항목', createdAt: old });
    const listed = io();
    expect(await waitlist(['list', '--limit', '1000'], { env: env(), io: listed })).toBe(0);
    const fields = (id: string): string[] => (listed.outLines.find((l) => l.startsWith(id)) ?? '').split('\t').slice(6, 10);
    expect(fields(a.id)).toEqual(['use_case=alerts [본인 확인 안 됨 · unverified]', 'heard_from=github', 'ref=github', 'grade?=A [본인 확인 안 됨 · unverified]']);
    expect(fields(aNoNote.id)).toEqual(['use_case=replies [본인 확인 안 됨 · unverified]', 'heard_from=-', 'ref=none', 'grade?=B [본인 확인 안 됨 · unverified]']);
    expect(fields(b.id)).toEqual(['use_case=codes [본인 확인 안 됨 · unverified]', 'heard_from=search', 'ref=recipe-alert-routing', 'grade?=B [본인 확인 안 됨 · unverified]']);
    expect(fields(hold.id)).toEqual(['use_case=outreach [본인 확인 안 됨 · unverified]', 'heard_from=x', 'ref=devto', 'grade?=보류 [본인 확인 안 됨 · unverified]']);
    expect(fields(legacy.id)).toEqual(['use_case=-', 'heard_from=-', 'ref=-', 'grade?=-']);
    const ctx: ApiContext = {
      owner,
      operator: null,
      target: { target: 'local', host: 'localhost', port: 5432, database: 'test', user: 'test', reasons: [] },
      actor: 'admin:web:tester',
      audit: () => undefined,
      idleMinutes: 30,
      maxHours: 8,
      ops: OPS,
      now: () => new Date(),
    };
    // `waiting` 은 오래 기다린 순 — 2001 년 항목이 200건 안에 든다(공유 DB 에서도).
    const body = (await handleApi(ctx, 'GET', '/api/waitlist', new URLSearchParams('status=waiting'), undefined)).body as {
      items: { id: string; useCase: string | null; heardFrom: string | null; ref: string | null; gradeHint: string | null }[];
    };
    const pick = (id: string) => body.items.find((i) => i.id === id);
    for (const [entry, want] of [
      [a, { useCase: 'alerts', heardFrom: 'github', ref: 'github', gradeHint: 'A' }],
      [hold, { useCase: 'outreach', heardFrom: 'x', ref: 'devto', gradeHint: 'hold' }],
      [legacy, { useCase: null, heardFrom: null, ref: null, gradeHint: null }],
    ] as const) {
      expect(pick(entry.id)).toMatchObject(want);
    }
    for (const entry of [a, aNoNote, b, hold, legacy]) await removeWaitlistEntryOp(owner, entry.id, 'test:waitlist');
  });

  it('로컬 운영 화면 — 읽기(상태 거르개 · 수 · 최근 기록) · 초대/지우기는 주소 확인 뒤 소유자 풀로 · 행위자 admin:web', async () => {
    const e = await waitingEntry(owner, { note: '고객 응대 봇' });
    const records: unknown[] = [];
    const ctx: ApiContext = {
      owner,
      operator: null,
      target: { target: 'local', host: 'localhost', port: 5432, database: 'test', user: 'test', reasons: [] },
      actor: 'admin:web:tester',
      audit: (record) => records.push(record),
      idleMinutes: 30,
      maxHours: 8,
      ops: OPS,
      now: () => new Date(),
    };
    const listed = await handleApi(ctx, 'GET', '/api/waitlist', new URLSearchParams('status=all'), undefined);
    const body = listed.body as { items: { id: string; email: string; note: string; status: string }[]; counts: Record<string, number> };
    expect(body.items.find((i) => i.id === e.id) ?? (await entryOf(owner, e.email))).toBeTruthy();
    expect(Object.keys(body.counts).sort()).toEqual(['expired', 'invited', 'invitedLastDay', 'joined', 'waiting']);
    await expect(handleApi(ctx, 'POST', `/api/waitlist/${e.id}/invite`, new URLSearchParams(), { confirm: 'wrong@example.com' })).rejects.toMatchObject({ status: 422 });
    expect((await entryById(owner, e.id))?.status).toBe('waiting');
    expect((await handleApi(ctx, 'POST', `/api/waitlist/${e.id}/invite`, new URLSearchParams(), { confirm: e.email })).status).toBe(200);
    expect((await handleApi(ctx, 'POST', `/api/waitlist/${e.id}/remove`, new URLSearchParams(), { confirm: e.email })).status).toBe(200);
    expect(await entryById(owner, e.id)).toBeNull();
    expect(await eventsOf(owner, e.id)).toEqual([
      { action: 'invite', actor: 'admin:web:tester' },
      { action: 'remove', actor: 'admin:web:tester' },
    ]);
    expect(records).toHaveLength(3);
  });

  describe('호스팅(ops.atmark.ai · atmark_ops)', () => {
    let operator: { id: string; email: string };
    beforeAll(async () => {
      await lockOps(owner);
      operator = await addCliOperator(owner);
    });
    afterAll(async () => {
      await releaseOps();
    });

    it('읽기는 atmark_ops 칸 GRANT 로 · 메모는 정화 · 초대/지우기는 주소 확인(틀리면 422, 정의 함수 0) · 행위자 ops:<uuid> · step-up 없음', async () => {
      const b = new Browser(h);
      await b.login(operator.email, owner);
      const e = await waitingEntry(owner, { note: '보이지\u061c않는 표식' });
      const list = await b.call('GET', '/api/waitlist', undefined, { query: 'status=waiting' });
      expect(list.status, JSON.stringify(list.json)).toBe(200);
      const item = (list.json['items'] as { id: string; note: string | null }[]).find((i) => i.id === e.id);
      if (item !== undefined) expect(item.note).toBe('보이지않는 표식');
      // 신청서 세 칸(202609301530)도 atmark_ops 의 칸 GRANT 로 읽힌다 — 칸이 빠지면 위 목록 읽기가 42501 로 깨진다.
      const intake = await waitingEntry(owner, { note: '알림', useCase: 'alerts', heardFrom: 'reddit', ref: 'github' });
      const all = await b.call('GET', '/api/waitlist', undefined, { query: 'status=all' });
      expect(all.status).toBe(200);
      const intakeItem = (all.json['items'] as { id: string }[]).find((i) => i.id === intake.id);
      expect(intakeItem).toMatchObject({ useCase: 'alerts', heardFrom: 'reddit', ref: 'github', gradeHint: 'A' });
      await removeWaitlistEntryOp(owner, intake.id, 'test:waitlist');
      expect((await b.call('GET', '/api/waitlist', undefined, { query: 'status=bogus' })).status).toBe(400);

      const wrong = await b.call('POST', `/api/waitlist/${e.id}/invite`, { confirm: 'nobody@example.com' });
      expect([wrong.status, wrong.json['error']]).toEqual([422, 'confirmation_required']);
      expect((await entryById(owner, e.id))?.status).toBe('waiting');
      const invited = await b.call('POST', `/api/waitlist/${e.id}/invite`, { confirm: e.email });
      expect(invited.status, JSON.stringify(invited.json)).toBe(200);
      expect(invited.json['waitlist']).toMatchObject({ entryId: e.id, fromStatus: 'waiting' });
      expect(h.kicks.n).toBeGreaterThanOrEqual(0);
      const removed = await b.call('POST', `/api/waitlist/${e.id}/remove`, { confirm: e.email });
      expect(removed.status).toBe(200);
      expect(await entryById(owner, e.id)).toBeNull();
      expect(await eventsOf(owner, e.id)).toEqual([
        { action: 'invite', actor: `ops:${operator.id}` },
        { action: 'remove', actor: `ops:${operator.id}` },
      ]);
      // 확인 대상이 없으면 404(정의 함수 전) — 정의 함수까지 간 실패는 실패 기록에 행위 이름으로 남는다(1520 이 허용 목록에 더했다).
      const gone = await b.call('POST', `/api/waitlist/${e.id}/remove`, { confirm: e.email });
      expect([gone.status, gone.json['error']]).toEqual([404, 'entry_not_found']);
      const other = await waitingEntry(owner);
      await owner.query(`UPDATE signup_limits SET waitlist_remove_daily_cap = 0`);
      try {
        const capped = await b.call('POST', `/api/waitlist/${other.id}/remove`, { confirm: other.email });
        expect([capped.status, capped.json['error']]).toEqual([429, 'remove_cap']);
      } finally {
        await owner.query(`UPDATE signup_limits SET waitlist_remove_daily_cap = 1000000`);
      }
      const failures = await owner.query<{ action: string | null; code: string }>(
        `SELECT action, code FROM ops_actions WHERE kind = 'failure' AND operator_id = $1 ORDER BY id DESC LIMIT 1`,
        [operator.id],
      );
      expect(failures.rows[0]).toEqual({ action: 'waitlist.remove', code: 'remove_cap' });
      // CSRF 없는 변경은 403.
      expect((await b.call('POST', `/api/waitlist/${e.id}/invite`, { confirm: e.email }, { csrf: null })).status).toBe(403);
    });

    it('가장 오래 기다린 N 명 — 확인 = 그 수 · 롤백되는 트랜잭션에서 atmark_ops 로', async () => {
      const b = new Browser(h);
      await b.login(operator.email, owner);
      await inRolledBackOps(h, async (harness) => {
        const hb = new Browser(harness, undefined, b.ip);
        for (const [k, v] of b.jar) hb.jar.set(k, v);
        hb.csrf = b.csrf;
        const wrong = await hb.call('POST', '/api/waitlist/invite-oldest', { n: 2, confirm: '3' });
        expect([wrong.status, wrong.json['error']]).toEqual([422, 'confirmation_required']);
        const ok = await hb.call('POST', '/api/waitlist/invite-oldest', { n: 1, confirm: '1' });
        expect(ok.status, JSON.stringify(ok.json)).toBe(200);
        expect((ok.json['waitlist'] as { invited: number }).invited).toBeLessThanOrEqual(1);
      });
    });
  });
});
