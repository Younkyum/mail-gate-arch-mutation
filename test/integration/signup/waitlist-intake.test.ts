/**
 * 대기자 명단 신청서 · 가입 계측(202609301530 — 마케팅 계획 §4.1–4.2 · §6.2 "계측 선행조건") — 실제 Postgres, 가짜 SES(AWS 호출 0).
 * 라우터는 `atmark_admin`, 메일러는 `atmark_login_mailer`, 지반(심기·검사)만 소유자 롤.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 신청서: 용도(필수 · 닫힌 값 넷) · 알게 된 곳(선택 · 닫힌 값 일곱) · ref(허용목록 — 목록 밖은 none, 400 없음)를 항목에 적는다. 용도가 없거나 목록 밖이면
 *     400 invalid_use_case, 알게 된 곳이 목록 밖이면 400 invalid_heard_from — 둘 다 아무것도 적지 않는다.
 *   - 다시 등록: 세 칸은 비어 있을 때만 채운다(먼저 적은 답이 남는다) · 한 번 적힌 값은 소유자 롤도 바꾸지 못한다(트리거).
 *   - "먼저 발송"(outreach)도 응답은 똑같다(본문 · 헤더 · 쿠키) — 보류는 화면이 자기 입력으로 그리고, 확인 메일이 조건부 문단 + 문서 링크 하나로 알린다.
 *     다른 용도의 확인 메일에는 링크가 없다. 확인 메일에는 "요청하지 않았다면" 줄과 "용도를 보고 조금씩 초대" 가 있다.
 *   - 상한: 초대 하루 5 · 새 항목 하루 50(행 값의 기본값 · 행이 없을 때 함수 값). 상한 안에서 5 명까지만 초대된다(롤백).
 *   - 가입: 조직 행에 ref · 알게 된 곳 · 용도 · 초대 ISO 주(KST)를 **한 번** 복사한다 · 항목 id · 주소 · 메모는 옮기지 않는다 · 뒤로 바꿀 수 없다.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SIGNUP_BROWSER_COOKIE } from '../../../src/admin/http';
import { createWaitlistNotifier } from '../../../src/notify/waitlist-notifier';
import { WAITLIST_NOT_FOR_URLS } from '../../../src/notify/waitlist-template';
import { inviteWaitlistEntryOp } from '../../../src/ops/core/waitlist';
import { runWaitlistMailer } from '../../../src/workers/waitlist-mailer';
import { adminDeps, adminRolePool, AVAILABLE, call, cookieValue, fakeSes, LOGIN_KEYS, loginMailerPool, mailText, newOrganization, ownerPool, uniqueCodeIp, type SentMail } from '../admin/support';
import { entryOf, mailsOf, seedInvite, uniqueIp, waitlistEmail } from './waitlist-support';
import { signupCodeOf } from './support';

interface IntakeRow {
  id: string;
  use_case: string | null;
  heard_from: string | null;
  ref: string | null;
  note: string | null;
}

describe.skipIf(!AVAILABLE)('대기자 명단 신청서 · 가입 계측 (202609301530)', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), mailer.end()]);
  });

  const deps = () => adminDeps(admin);
  const post = (body: Record<string, unknown>, ip: string = uniqueIp()) => call(deps(), 'POST', '/api/waitlist', { body, ip });
  const intakeOf = async (email: string): Promise<IntakeRow | null> =>
    (await owner.query<IntakeRow>('SELECT id, use_case, heard_from, ref, note FROM waitlist_entries WHERE email = $1', [email])).rows[0] ?? null;

  async function drain(ids: readonly string[]) {
    const ses = fakeSes();
    // 시계 1초 앞 — 방금 쌓인 행의 next_attempt_at(DB now(), 마이크로초)을 JS 밀리초 시각이 앞지르지 못해 건너뛰는 경합을 없앤다.
    const now = () => new Date(Date.now() + 1_000);
    const notifier = createWaitlistNotifier({ pool: mailer, client: ses.client as never, now, capPerHour: 1_000_000, confirmationCapPerHour: 1_000_000 });
    const report = await runWaitlistMailer({ db: mailer, notifier, now }, { mailIds: ids });
    return { report, sent: ses.sent };
  }

  // -------------------------------------------------------------------------
  // 신청서
  // -------------------------------------------------------------------------

  it('세 칸을 적는다 — 용도 · 알게 된 곳 · ref(허용목록 · recipe-<슬러그>) · 목록 밖 ref 는 none · 알게 된 곳이 비면 NULL', async () => {
    const cases: [Record<string, unknown>, Omit<IntakeRow, 'id' | 'note'>][] = [
      [{ useCase: 'alerts', heardFrom: 'github', ref: 'github' }, { use_case: 'alerts', heard_from: 'github', ref: 'github' }],
      [{ useCase: 'replies', heardFrom: 'directory', ref: 'recipe-alert-routing' }, { use_case: 'replies', heard_from: 'directory', ref: 'recipe-alert-routing' }],
      [{ useCase: 'codes', ref: 'devto' }, { use_case: 'codes', heard_from: null, ref: 'devto' }],
      [{ useCase: 'outreach', heardFrom: '', ref: 'referral' }, { use_case: 'outreach', heard_from: null, ref: 'referral' }],
      // 목록 밖 ref — 400 없이 none(대문자 · UTM 모양 · 긴 슬러그 · 문자열이 아님 · 없음).
      [{ useCase: 'alerts', ref: 'GitHub' }, { use_case: 'alerts', heard_from: null, ref: 'none' }],
      [{ useCase: 'alerts', ref: 'utm_source=hn' }, { use_case: 'alerts', heard_from: null, ref: 'none' }],
      [{ useCase: 'alerts', ref: `recipe-${'a'.repeat(41)}` }, { use_case: 'alerts', heard_from: null, ref: 'none' }],
      [{ useCase: 'alerts', ref: 7 }, { use_case: 'alerts', heard_from: null, ref: 'none' }],
      [{ useCase: 'alerts' }, { use_case: 'alerts', heard_from: null, ref: 'none' }],
    ];
    for (const [fields, want] of cases) {
      const email = waitlistEmail();
      const result = await post({ email, ...fields });
      expect([result.statusCode, result.body], JSON.stringify(fields)).toEqual([202, '{"ok":true}']);
      expect(await intakeOf(email), JSON.stringify(fields)).toMatchObject(want);
    }
  });

  it('용도는 필수 · 닫힌 값 — 없거나 목록 밖이면 400 invalid_use_case · 알게 된 곳이 목록 밖이면 400 invalid_heard_from · 아무것도 적지 않는다', async () => {
    const email = waitlistEmail();
    for (const [body, code] of [
      [{ email }, 'invalid_use_case'],
      [{ email, useCase: '' }, 'invalid_use_case'],
      [{ email, useCase: 'spam' }, 'invalid_use_case'],
      [{ email, useCase: ['alerts'] }, 'invalid_use_case'],
      [{ email, useCase: 'alerts', heardFrom: 'hackernews' }, 'invalid_heard_from'],
      [{ email, useCase: 'alerts', heardFrom: 3 }, 'invalid_heard_from'],
    ] as const) {
      const result = await post(body);
      expect([result.statusCode, (result.json() as { error: string }).error], JSON.stringify(body)).toEqual([400, code]);
    }
    expect(await entryOf(owner, email)).toBeNull();
  });

  it('다시 등록 — 비어 있는 칸만 채운다(먼저 적은 답이 남는다) · 한 번 적힌 답은 소유자 롤도 바꾸지 못한다', async () => {
    const email = waitlistEmail();
    await post({ email, useCase: 'alerts', ref: 'github' });
    await post({ email, useCase: 'outreach', heardFrom: 'x', ref: 'devto', note: '두 번째 메모' });
    expect(await intakeOf(email)).toMatchObject({ use_case: 'alerts', heard_from: 'x', ref: 'github', note: '두 번째 메모' });
    await post({ email, useCase: 'codes', heardFrom: 'reddit', note: '세 번째' });
    expect(await intakeOf(email)).toMatchObject({ use_case: 'alerts', heard_from: 'x', ref: 'github', note: '두 번째 메모' });
    const state = async (sql: string): Promise<string> =>
      owner.query(sql, [email]).then(
        () => 'ok',
        (error: { code?: string }) => String(error.code),
      );
    expect(await state(`UPDATE waitlist_entries SET use_case = 'outreach' WHERE email = $1`)).toBe('23514');
    expect(await state(`UPDATE waitlist_entries SET heard_from = NULL WHERE email = $1`)).toBe('23514');
    expect(await state(`UPDATE waitlist_entries SET ref = 'none' WHERE email = $1`)).toBe('23514');
    // DB CHECK — 목록 밖 값은 소유자 롤도 넣지 못한다.
    expect(await state(`INSERT INTO waitlist_entries (email, lang, source, use_case) VALUES ('x' || $1, 'ko', 'site', 'spam')`)).toBe('23514');
    expect(await state(`INSERT INTO waitlist_entries (email, lang, source, ref) VALUES ('x' || $1, 'ko', 'site', 'recipe-Bad')`)).toBe('23514');
    // 1520 시절 항목(세 칸 NULL)은 다시 등록하면 채워진다.
    const legacy = waitlistEmail();
    await owner.query(`INSERT INTO waitlist_entries (email, lang, note, source) VALUES ($1, 'ko', '옛 메모', 'site')`, [legacy]);
    await post({ email: legacy, useCase: 'replies', heardFrom: 'friend', ref: 'referral' });
    expect(await intakeOf(legacy)).toMatchObject({ use_case: 'replies', heard_from: 'friend', ref: 'referral', note: '옛 메모' });
  });

  it('확인 메일 재발송 30일 — 30일 안에 다시 등록하면 두 번째 확인 메일이 없다 · 가입 요청(초대 없음) 경로도 같은 규칙', async () => {
    const email = waitlistEmail();
    await post({ email, useCase: 'codes' });
    const entry = await entryOf(owner, email);
    expect(await mailsOf(owner, entry?.id ?? '')).toHaveLength(1);
    await owner.query(`UPDATE waitlist_entries SET last_confirmation_sent_at = now() - interval '29 days' WHERE id = $1`, [entry?.id]);
    await post({ email, useCase: 'codes' });
    // 가입 요청(초대 없는 주소)도 같은 정의 함수(4인자 껍질)를 지난다.
    const signUp = await call(deps(), 'POST', '/api/signup', { body: { email, organizationName: 'Intake', consent: true }, ip: uniqueIp() });
    expect(signUp.statusCode).toBe(202);
    expect(await mailsOf(owner, entry?.id ?? '')).toHaveLength(1);
    await owner.query(`UPDATE waitlist_entries SET last_confirmation_sent_at = now() - interval '31 days' WHERE id = $1`, [entry?.id]);
    await post({ email, useCase: 'codes' });
    expect(await mailsOf(owner, entry?.id ?? '')).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 먼저 발송(outreach) — 보류
  // -------------------------------------------------------------------------

  it('먼저 발송도 응답은 똑같다(본문 · 헤더 · 쿠키 — 새 주소 · 이미 대기 · 초대받음 · 이미 가입) · 확인 메일에만 보류 문단 + 문서 링크', async () => {
    const waiting = waitlistEmail();
    await post({ email: waiting, useCase: 'alerts' });
    const invited = waitlistEmail();
    await seedInvite(owner, invited);
    const member = await newOrganization(owner);
    const results = [];
    for (const email of [waitlistEmail(), waiting, invited, member.ownerEmail]) {
      for (const useCase of ['alerts', 'outreach']) results.push(await post({ email, useCase }));
    }
    for (const result of results) {
      expect(result.statusCode).toBe(202);
      expect(result.body).toBe(results[0]?.body);
      expect(Object.keys(result.headers).sort()).toEqual(Object.keys(results[0]?.headers ?? {}).sort());
      expect(result.cookies ?? []).toEqual([]);
    }

    for (const lang of ['ko', 'en'] as const) {
      const hold = waitlistEmail();
      const plain = waitlistEmail();
      await post({ email: hold, useCase: 'outreach', lang });
      await post({ email: plain, useCase: 'replies', lang });
      const holdMails = await mailsOf(owner, (await entryOf(owner, hold))?.id ?? '');
      const plainMails = await mailsOf(owner, (await entryOf(owner, plain))?.id ?? '');
      const out = await drain([...holdMails, ...plainMails].map((m) => m.id));
      expect(out.report.sent).toBe(2);
      const holdText = mailText(out.sent.find((m) => m.to[0] === hold) as SentMail);
      const plainText = mailText(out.sent.find((m) => m.to[0] === plain) as SentMail);
      expect(holdText).toContain(WAITLIST_NOT_FOR_URLS[lang]);
      expect(holdText).toContain(lang === 'ko' ? '지금은 초대해 드리기 어렵습니다' : "so we can't invite you for that use.");
      expect(plainText).not.toContain('https://');
      for (const text of [holdText, plainText]) {
        expect(text).toContain(lang === 'ko' ? '서비스 안정성을 위해 이용 범위를 조금씩 넓히고 있습니다' : "we're opening access gradually to keep the service stable");
        expect(text).toContain(lang === 'ko' ? '직접 등록하지 않았다면 이 메일은 무시하셔도 됩니다.' : "If this wasn't you, you can ignore this email.");
        expect(text).not.toMatch(/빼 달라고|remove you/);
      }
    }
  });

  // -------------------------------------------------------------------------
  // 상한
  // -------------------------------------------------------------------------

  it('상한 — 초대 하루 5 · 새 항목 하루 50(기본값 · 행이 없을 때 함수 값) · 남은 방이 5 면 5 명까지만(여섯째 429 invite_cap, 롤백)', async () => {
    const defaults = await owner.query<{ column_name: string; column_default: string }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'signup_limits' AND column_name IN ('waitlist_invite_daily_cap', 'waitlist_daily_cap') ORDER BY 1`,
    );
    expect(defaults.rows).toEqual([
      { column_name: 'waitlist_daily_cap', column_default: '50' },
      { column_name: 'waitlist_invite_daily_cap', column_default: '5' },
    ]);
    const fallbacks = await owner.query<{ proname: string; src: string }>(
      `SELECT proname, prosrc AS src FROM pg_proc WHERE proname IN ('waitlist_require_invite_room', 'waitlist_join', 'waitlist_queue_confirmation') AND pronamespace = 'public'::regnamespace`,
    );
    expect(fallbacks.rows.find((r) => r.proname === 'waitlist_require_invite_room')?.src).toContain('coalesce(v_cap, 5)');
    // 확인 메일 하루 상한(행이 없을 때 50)은 두 길이 함께 지나는 `waitlist_queue_confirmation` 이 본다 · 30일 주기는 `waitlist_join` 이 본다.
    expect(fallbacks.rows.find((r) => r.proname === 'waitlist_queue_confirmation')?.src).toContain('coalesce(v_cap, 50)');
    expect(fallbacks.rows.some((r) => r.proname === 'waitlist_join' && r.src.includes("interval '30 days'") && !r.src.includes('waitlist_daily_cap'))).toBe(true);

    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      // 전역 초대 잠금을 먼저 쥔다 — 병렬로 도는 다른 파일의 초대가 이 트랜잭션이 끝날 때까지 기다려 "남은 방" 이 흔들리지 않게.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('waitlist_invite_global', 0))`);
      await client.query(
        `UPDATE signup_limits SET waitlist_invite_daily_cap = 5 + (SELECT count(*) FROM waitlist_events WHERE action = 'invite' AND created_at > now() - interval '24 hours')`,
      );
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const row = await client.query<{ id: string }>(`INSERT INTO waitlist_entries (email, lang, source, use_case) VALUES ($1, 'ko', 'site', 'alerts') RETURNING id`, [waitlistEmail()]);
        ids.push(row.rows[0]?.id ?? '');
      }
      for (const id of ids.slice(0, 5)) await inviteWaitlistEntryOp(client, id, 'test:intake');
      await expect(inviteWaitlistEntryOp(client, ids[5] ?? '', 'test:intake')).rejects.toMatchObject({ code: 'invite_cap' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // 가입 → 조직 행 복사
  // -------------------------------------------------------------------------

  async function signUpInvited(email: string): Promise<string> {
    const requested = await call(deps(), 'POST', '/api/signup', {
      body: { email, organizationName: `Intake ${randomUUID().slice(0, 6)}`, consent: true, lang: 'en' },
      ip: uniqueIp(),
    });
    expect(requested.statusCode).toBe(202);
    const link = (await owner.query<{ id: string; expires_at: Date }>('SELECT id, expires_at FROM signup_links WHERE email = $1', [email])).rows[0];
    const verified = await call(deps(), 'POST', '/api/signup/verify', {
      body: { code: await signupCodeOf(owner, LOGIN_KEYS, { id: link?.id ?? '', expires_at: link?.expires_at ?? new Date() }) },
      ip: uniqueCodeIp(),
      cookies: { [SIGNUP_BROWSER_COOKIE]: cookieValue(requested, SIGNUP_BROWSER_COOKIE) ?? '' },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const org = (await owner.query<{ id: string }>('SELECT id FROM organizations WHERE owner_email = $1', [email])).rows[0];
    return org?.id ?? '';
  }

  interface OrgAttribution {
    signup_ref: string | null;
    signup_heard_from: string | null;
    signup_use_case: string | null;
    signup_invite_week: string | null;
  }
  const attributionOf = async (orgId: string): Promise<OrgAttribution | undefined> =>
    (
      await owner.query<OrgAttribution>('SELECT signup_ref, signup_heard_from, signup_use_case, signup_invite_week FROM organizations WHERE id = $1', [orgId])
    ).rows[0];

  it('초대받은 가입 → 조직 행에 ref · 알게 된 곳 · 용도 · 초대 ISO 주(KST)를 한 번 복사 · 항목 id · 주소 · 메모는 옮기지 않는다 · 뒤로 바꿀 수 없다', async () => {
    const email = waitlistEmail();
    const entryId = await seedInvite(owner, email, { note: '배포 알림 에이전트' });
    // 초대 시각을 일요일 23:30 UTC(= 월요일 08:30 KST)로 — ISO 주는 KST 로 센다(2026-10-11 일 → 2026-W41 월요일 10-12 KST 는 W42).
    await owner.query(
      `UPDATE waitlist_entries SET use_case = 'replies', heard_from = 'directory', ref = 'recipe-alert-routing',
              invited_at = '2026-10-11T23:30:00Z', invite_expires_at = '2026-10-25T23:30:00Z'
        WHERE id = $1`,
      [entryId],
    );
    // 초대가 살아 있어야 한다 — 만료가 지난 날짜면 가입 링크가 서지 않으므로, 시계가 그 뒤라면 오늘 기준으로 다시 둔다.
    const live = (await owner.query<{ live: boolean }>('SELECT invite_expires_at > now() AS live FROM waitlist_entries WHERE id = $1', [entryId])).rows[0]?.live;
    let expectedWeek = '2026-W42';
    if (live !== true) {
      await owner.query(`UPDATE waitlist_entries SET invited_at = now() - interval '1 hour', invite_expires_at = now() - interval '1 hour' + interval '14 days' WHERE id = $1`, [entryId]);
      expectedWeek = (await owner.query<{ w: string }>(`SELECT to_char((now() - interval '1 hour') AT TIME ZONE 'Asia/Seoul', 'IYYY-"W"IW') AS w`)).rows[0]?.w ?? '';
    }
    const orgId = await signUpInvited(email);
    expect(await attributionOf(orgId)).toEqual({
      signup_ref: 'recipe-alert-routing',
      signup_heard_from: 'directory',
      signup_use_case: 'replies',
      signup_invite_week: expectedWeek,
    });
    // 조직 행에는 대기 항목을 가리키는 칸이 없다(항목 id · 메모).
    const columns = (await owner.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'organizations'`)).rows.map(
      (r) => r.column_name,
    );
    expect(columns.filter((c) => /entry|waitlist|note/.test(c))).toEqual([]);
    const row = (await owner.query<Record<string, unknown>>('SELECT * FROM organizations WHERE id = $1', [orgId])).rows[0] ?? {};
    expect(Object.values(row).map(String)).not.toContain(entryId);
    expect(Object.values(row).map(String)).not.toContain('배포 알림 에이전트');
    // 항목은 joined(주소 · 메모 비움) — 신청서 답은 통계로 남는다.
    expect((await owner.query('SELECT use_case, email, note FROM waitlist_entries WHERE id = $1', [entryId])).rows[0]).toEqual({ use_case: 'replies', email: null, note: null });
    // 한 번 복사 — 소유자 롤도 바꾸지 못한다.
    for (const sql of [
      `UPDATE organizations SET signup_ref = 'none' WHERE id = $1`,
      `UPDATE organizations SET signup_use_case = NULL WHERE id = $1`,
      `UPDATE organizations SET signup_invite_week = '2026-W01' WHERE id = $1`,
      `UPDATE organizations SET signup_heard_from = 'other' WHERE id = $1`,
    ]) {
      await expect(owner.query(sql, [orgId]), sql).rejects.toMatchObject({ code: '23514' });
    }
    // 다른 칸은 그대로 고칠 수 있다(트리거는 네 칸만 본다).
    await owner.query(`UPDATE organizations SET name = name || '' WHERE id = $1`, [orgId]);
  });

  it('1520 시절 초대(세 칸 NULL) → 조직 행은 초대 주만 · 대기 명단을 거치지 않은 조직은 넷 다 NULL', async () => {
    const email = waitlistEmail();
    const entryId = await seedInvite(owner, email);
    const week = (
      await owner.query<{ w: string }>(`SELECT to_char(invited_at AT TIME ZONE 'Asia/Seoul', 'IYYY-"W"IW') AS w FROM waitlist_entries WHERE id = $1`, [entryId])
    ).rows[0]?.w;
    const orgId = await signUpInvited(email);
    expect(await attributionOf(orgId)).toEqual({ signup_ref: null, signup_heard_from: null, signup_use_case: null, signup_invite_week: week });
    expect(week).toMatch(/^\d{4}-W\d{2}$/);
    const operatorMade = await newOrganization(owner);
    expect(await attributionOf(operatorMade.id)).toEqual({ signup_ref: null, signup_heard_from: null, signup_use_case: null, signup_invite_week: null });
  });
});
