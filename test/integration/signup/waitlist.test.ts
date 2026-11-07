/**
 * 대기자 명단 · 초대 전용 가입(202609301520) — 실제 Postgres, 가짜 SES(AWS 호출 0). 라우터는 `atmark_admin`, 메일러는 `atmark_login_mailer`,
 * 지반(심기·검사)만 소유자 롤.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 등록(`POST /api/waitlist`): 202 · 항목 한 행(정규화 주소 · 언어 · 메모 · 출처 site) · 확인 메일 한 통 · 다시 등록해도 30일 안엔 메일 0(202609301530) ·
 *     응답은 새 주소 · 이미 대기 · 초대받음 · 이미 가입한 사람 모두 같다(열거 방지) · 꿀단지는 같은 202 에 등록 0 · 모양 오류만 400 · 요청자 상한 429
 *     (가입 요청과 같은 원장).
 *   - 초대받지 않은 가입 요청 → 같은 202 · 가입 링크 0 · 대기자 명단(출처 signup) + 확인 메일.
 *   - 초대받은 가입 → active 조직(요금제 행 없음 = Free · 베타 없음) · 항목 joined(주소·메모 비움) · 감사 join · 환영 메일 행 정확히 하나.
 *   - 끝난 초대 → 가입 링크 0(대기자 명단 확인 메일로) · 링크를 받은 뒤 초대가 끝나면 verify 거부(조직 없음 · 링크 미소진).
 *   - 메일(워커): 확인·초대 한 통씩(두 번째 틱엔 없다) · 발신 onve@ · 초대 링크 = 가입 화면 #invite=base64url(주소) · 억제 주소 undeliverable ·
 *     지운 항목 obsolete · 다시 초대하면 앞 초대 메일 obsolete · 보낸 뒤 기록 전에 죽은 행(sending 표식)은 다시 보내지 않는다(dead send_unknown).
 *   - 보존(`purge_expired_signup_links`): 초대 만료 30일 지난 항목 · 멤버가 된 주소의 항목을 지운다 · 대기 중·최근 만료는 그대로.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SESSION_COOKIE, SIGNUP_BROWSER_COOKIE } from '../../../src/admin/http';
import { SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR } from '../../../src/security/login-limits';
import { createWaitlistNotifier, WAITLIST_MAIL_HOURLY_CAP } from '../../../src/notify/waitlist-notifier';
import { waitlistInviteLink } from '../../../src/notify/waitlist-template';
import { inviteWaitlistEntryOp, removeWaitlistEntryOp } from '../../../src/ops/core/waitlist';
import { runWaitlistMailer } from '../../../src/workers/waitlist-mailer';
import { adminDeps, adminRolePool, AVAILABLE, call, cookieValue, fakeSes, LOGIN_KEYS, loginMailerPool, mailText, newOrganization, ownerPool, uniqueCodeIp, type SentMail } from '../admin/support';
import { entryById, entryOf, eventsOf, mailsOf, seedInvite, uniqueIp, waitlistEmail } from './waitlist-support';
import { signupCodeOf } from './support';

describe.skipIf(!AVAILABLE)('대기자 명단 · 초대 전용 가입 (202609301520)', () => {
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
  // 신청서의 용도는 필수다(202609301530) — 이 파일의 등록은 기본값 alerts 로 채운다(신청서 자체는 `waitlist-intake.test.ts`).
  const join = (body: Record<string, unknown>, ip: string = uniqueIp()) => call(deps(), 'POST', '/api/waitlist', { body: { useCase: 'alerts', ...body }, ip });

  // 시계 1초 앞 — `next_attempt_at` 기본값(DB now(), 마이크로초)이 JS 시각(밀리초 절삭)보다 뒤라 방금 쌓인 행을 "아직" 으로 건너뛰던 경합을 없앤다.
  async function drain(ids: readonly string[], now: () => Date = () => new Date(Date.now() + 1_000)) {
    const ses = fakeSes();
    // 전역 시간당 상한은 공유 DB 전체의 창이라(다른 파일·이전 실행의 집기도 센다) 여기서는 넉넉히 — 운영 값(WAITLIST_MAIL_HOURLY_CAP)은 arch 테스트가 본다.
    const notifier = createWaitlistNotifier({ pool: mailer, client: ses.client as never, now, capPerHour: Math.max(WAITLIST_MAIL_HOURLY_CAP, 1_000_000), confirmationCapPerHour: 1_000_000 });
    const report = await runWaitlistMailer({ db: mailer, notifier, now }, { mailIds: ids });
    return { report, sent: ses.sent };
  }

  async function signUp(email: string, lang?: 'ko' | 'en') {
    const requested = await call(deps(), 'POST', '/api/signup', {
      body: { email, organizationName: `Wait ${randomUUID().slice(0, 6)}`, consent: true, ...(lang === undefined ? {} : { lang }) },
      ip: uniqueIp(),
    });
    return requested;
  }

  // -------------------------------------------------------------------------
  // 등록
  // -------------------------------------------------------------------------

  it('등록 → 202 {ok:true} · 쿠키 없음 · 항목(정규화 · 언어 · 메모 · site) + 확인 메일 한 통 · 다시 등록해도 30일 안엔 메일 0 · 빈 메모는 채운다', async () => {
    const email = waitlistEmail();
    const first = await join({ email: `  ${email.toUpperCase()} `, lang: 'en' });
    expect([first.statusCode, first.body]).toEqual([202, '{"ok":true}']);
    expect(first.cookies ?? []).toEqual([]);
    const entry = await entryOf(owner, email);
    expect(entry).toMatchObject({ email, lang: 'en', note: null, source: 'site', status: 'waiting' });
    expect(entry?.last_confirmation_sent_at).toBeInstanceOf(Date);
    expect(await mailsOf(owner, entry?.id ?? '')).toMatchObject([{ kind: 'confirmation', lang: 'en', status: 'pending' }]);
    const again = await join({ email, note: '  고객 문의에 답하는 에이전트 ' });
    expect([again.statusCode, again.body]).toEqual([202, '{"ok":true}']);
    expect(await mailsOf(owner, entry?.id ?? '')).toHaveLength(1);
    expect((await entryOf(owner, email))?.note).toBe('고객 문의에 답하는 에이전트');
    // 재발송 주기 30일(202609301530) — 25시간 · 29일 뒤엔 여전히 0, 30일이 지났으면(소유자 롤로 시각을 되돌린다) 한 통 더.
    for (const ago of ['25 hours', '29 days 23 hours']) {
      await owner.query(`UPDATE waitlist_entries SET last_confirmation_sent_at = now() - $2::interval WHERE id = $1`, [entry?.id, ago]);
      await join({ email });
      expect(await mailsOf(owner, entry?.id ?? ''), ago).toHaveLength(1);
    }
    await owner.query(`UPDATE waitlist_entries SET last_confirmation_sent_at = now() - interval '30 days 1 minute' WHERE id = $1`, [entry?.id]);
    await join({ email });
    expect(await mailsOf(owner, entry?.id ?? '')).toHaveLength(2);
  });

  it('열거 방지 — 새 주소 · 이미 대기 · 살아 있는 초대 · 이미 가입한 사람: 같은 202 · 같은 본문 · 같은 헤더 · 초대·가입한 사람에게는 행·메일 0', async () => {
    const waiting = waitlistEmail();
    await join({ email: waiting });
    const invited = waitlistEmail();
    const invitedId = await seedInvite(owner, invited);
    const member = await newOrganization(owner);
    const results = [];
    for (const email of [waitlistEmail(), waiting, invited, member.ownerEmail]) results.push(await join({ email }));
    for (const result of results) {
      expect(result.statusCode).toBe(202);
      expect(result.body).toBe(results[0]?.body);
      expect(Object.keys(result.headers).sort()).toEqual(Object.keys(results[0]?.headers ?? {}).sort());
      expect(result.cookies ?? []).toEqual([]);
    }
    expect(await mailsOf(owner, invitedId)).toEqual([]);
    expect((await entryOf(owner, invited))?.status).toBe('invited');
    expect(await entryOf(owner, member.ownerEmail)).toBeNull();
  });

  it('꿀단지(website)가 차 있으면 같은 202 · 등록 0 · 요청자 상한은 똑같이 태운다(가입 요청과 같은 원장 — 시간당 5 → 429)', async () => {
    const ip = uniqueIp();
    const bot = waitlistEmail();
    const trapped = await join({ email: bot, website: 'http://spam.example' }, ip);
    expect([trapped.statusCode, trapped.body]).toEqual([202, '{"ok":true}']);
    expect(await entryOf(owner, bot)).toBeNull();
    for (let i = 1; i < SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR; i += 1) expect((await join({ email: waitlistEmail() }, ip)).statusCode).toBe(202);
    const limited = await join({ email: waitlistEmail() }, ip);
    expect([limited.statusCode, (limited.json() as { error: string }).error]).toEqual([429, 'rate_limited']);
    // 가입 요청과 한 원장 — 같은 요청자의 가입 요청도 429.
    expect((await signUp(waitlistEmail())).statusCode).toBe(202); // 다른 IP(새 요청자)는 된다
    const sameClient = await call(deps(), 'POST', '/api/signup', { body: { email: waitlistEmail(), organizationName: 'x', consent: true }, ip });
    expect(sameClient.statusCode).toBe(429);
  });

  it('모양 오류만 400 — 주소 모양 · 에이전트 도메인 · 메모 201자 · 메모 줄바꿈/보이지 않는 문자 · DB 에 아무것도 적지 않는다', async () => {
    const email = waitlistEmail();
    for (const [body, code] of [
      [{ email: 'not-an-email' }, 'invalid_email'],
      [{ email: 'bot@atmark.ai' }, 'invalid_email'],
      [{ email, note: 'x'.repeat(201) }, 'invalid_note'],
      [{ email, note: '한 줄\n두 줄' }, 'invalid_note'],
      [{ email, note: 'zero​width' }, 'invalid_note'],
      [{ email, note: 5 }, 'invalid_note'],
    ] as const) {
      const result = await join(body);
      expect([result.statusCode, (result.json() as { error: string }).error], JSON.stringify(body)).toEqual([400, code]);
    }
    expect(await entryOf(owner, email)).toBeNull();
    expect((await join({ email, note: '가'.repeat(200) })).statusCode).toBe(202);
  });

  // -------------------------------------------------------------------------
  // 초대 전용 가입
  // -------------------------------------------------------------------------

  it('초대받지 않은 가입 요청 → 같은 202 · 같은 쿠키 모양 · 가입 링크 0 · 대기자 명단(출처 signup · 요청 언어) + 확인 메일', async () => {
    const invited = waitlistEmail();
    await seedInvite(owner, invited);
    const stranger = waitlistEmail();
    const a = await signUp(invited, 'en');
    const b = await signUp(stranger, 'en');
    const shape = (cookies: readonly string[] | undefined): string[] => (cookies ?? []).map((c) => c.replace(/=[^;]+;/, '=X;'));
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(b.body).toBe(a.body);
    expect(shape(b.cookies)).toEqual(shape(a.cookies));
    expect((await owner.query('SELECT 1 FROM signup_links WHERE email = $1', [invited])).rowCount).toBe(1);
    expect((await owner.query('SELECT 1 FROM signup_links WHERE email = $1', [stranger])).rowCount).toBe(0);
    const entry = await entryOf(owner, stranger);
    expect(entry).toMatchObject({ source: 'signup', status: 'waiting', lang: 'en' });
    expect(await mailsOf(owner, entry?.id ?? '')).toMatchObject([{ kind: 'confirmation', lang: 'en' }]);
  });

  it('초대받은 가입 → active 조직 · 요금제 행 없음(Free · 베타 없음) · 항목 joined(주소·메모 비움) · 감사 join · 환영 메일 행 정확히 하나', async () => {
    const email = waitlistEmail();
    const entryId = await seedInvite(owner, email, { note: '비서 에이전트' });
    const requested = await signUp(email, 'en');
    expect(requested.statusCode).toBe(202);
    const link = (await owner.query<{ id: string; expires_at: Date }>('SELECT id, expires_at FROM signup_links WHERE email = $1', [email])).rows[0];
    const verified = await call(deps(), 'POST', '/api/signup/verify', {
      body: { code: await signupCodeOf(owner, LOGIN_KEYS, { id: link?.id ?? '', expires_at: link?.expires_at ?? new Date() }) },
      ip: uniqueCodeIp(),
      cookies: { [SIGNUP_BROWSER_COOKIE]: cookieValue(requested, SIGNUP_BROWSER_COOKIE) ?? '' },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(cookieValue(verified, SESSION_COOKIE)).toBeDefined();
    const org = (await owner.query<{ id: string; review_status: string; reviewed_at: Date | null; signup_source: string }>(
      'SELECT id, review_status::text, reviewed_at, signup_source FROM organizations WHERE owner_email = $1',
      [email],
    )).rows;
    expect(org).toEqual([{ id: expect.any(String), review_status: 'active', reviewed_at: null, signup_source: 'self_signup' }]);
    expect((await owner.query('SELECT 1 FROM org_entitlements WHERE organization_id = $1', [org[0]?.id])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM billing_audit WHERE organization_id = $1', [org[0]?.id])).rowCount).toBe(0);
    expect(await entryById(owner, entryId)).toMatchObject({ email: null, note: null, status: 'joined', joined_at: expect.any(Date) });
    expect(await entryOf(owner, email)).toBeNull();
    expect(await eventsOf(owner, entryId)).toEqual([{ action: 'join', actor: 'signup' }]);
    const welcome = await owner.query<{ lang: string }>('SELECT w.lang FROM welcome_mails w JOIN users u ON u.id = w.user_id WHERE u.email = $1', [email]);
    expect(welcome.rows).toEqual([{ lang: 'en' }]);
    // 이미 가입한 사람이 다시 대기 등록 — 행 0(멤버).
    await join({ email });
    expect(await entryOf(owner, email)).toBeNull();
  });

  it('끝난 초대 → 가입 링크 0 · 대기 확인 메일로 · 링크를 받은 뒤 초대가 끝나면 verify 401(조직 없음 · 링크 미소진)', async () => {
    const expired = waitlistEmail();
    const expiredId = await seedInvite(owner, expired, { expiredDaysAgo: 1 });
    expect((await signUp(expired)).statusCode).toBe(202);
    expect((await owner.query('SELECT 1 FROM signup_links WHERE email = $1', [expired])).rowCount).toBe(0);
    expect(await mailsOf(owner, expiredId)).toMatchObject([{ kind: 'confirmation' }]);
    // 끝난 초대로 다시 오면 대기로 되돌린다(보안 검토 L — 초대 칸을 비운다 · 등록 순서는 그대로 · 보존 과제의 "만료 30일" 에서 빠진다).
    expect(await entryById(owner, expiredId)).toMatchObject({ status: 'waiting', invite_expires_at: null });

    const late = waitlistEmail();
    await seedInvite(owner, late);
    const requested = await signUp(late);
    const link = (await owner.query<{ id: string; expires_at: Date }>('SELECT id, expires_at FROM signup_links WHERE email = $1', [late])).rows[0];
    await owner.query(
      `UPDATE waitlist_entries SET invited_at = now() - interval '15 days', invite_expires_at = now() - interval '1 day' WHERE email = $1`,
      [late],
    );
    const verified = await call(deps(), 'POST', '/api/signup/verify', {
      body: { code: await signupCodeOf(owner, LOGIN_KEYS, { id: link?.id ?? '', expires_at: link?.expires_at ?? new Date() }) },
      ip: uniqueCodeIp(),
      cookies: { [SIGNUP_BROWSER_COOKIE]: cookieValue(requested, SIGNUP_BROWSER_COOKIE) ?? '' },
    });
    expect([verified.statusCode, (verified.json() as { error: string }).error]).toEqual([401, 'signup_code_invalid']);
    expect((await owner.query('SELECT 1 FROM organizations WHERE owner_email = $1', [late])).rowCount).toBe(0);
    expect((await owner.query<{ used_at: Date | null }>('SELECT used_at FROM signup_links WHERE id = $1', [link?.id])).rows[0]?.used_at).toBeNull();
  });

  it('끝난 초대로 다시 등록(대기 폼) → waiting · 초대 칸 비움 · 확인 메일은 30일 규칙대로 · 가장 오래 기다린 N 명의 대상이 된다', async () => {
    const email = waitlistEmail();
    const id = await seedInvite(owner, email, { expiredDaysAgo: 3 });
    expect((await join({ email })).statusCode).toBe(202);
    const row = await owner.query<{ status: string; invited_at: Date | null; invite_expires_at: Date | null; invited_by: string | null }>(
      'SELECT status, invited_at, invite_expires_at, invited_by FROM waitlist_entries WHERE id = $1',
      [id],
    );
    expect(row.rows[0]).toEqual({ status: 'waiting', invited_at: null, invite_expires_at: null, invited_by: null });
    expect((await mailsOf(owner, id)).map((m) => m.kind)).toEqual(['confirmation']);
    // 다시 초대할 수 있다(대기 → 초대).
    expect((await inviteWaitlistEntryOp(owner, id, 'test:waitlist')).fromStatus).toBe('waiting');
  });

  it('전역 하루 상한(waitlist_daily_cap)은 롤링 24시간 확인 메일 수다 — 넘으면 항목은 조용히 저장하고 확인 메일만 쌓지 않는다 (롤백)', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      const used = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM waitlist_mails WHERE kind = 'confirmation' AND created_at > now() - interval '24 hours'`)).rows[0]?.n ?? 0;
      await client.query('UPDATE signup_limits SET waitlist_daily_cap = $1', [used]);
      const over = waitlistEmail();
      await client.query(`SELECT waitlist_join($1, 'ko', '넘침', 'site')`, [over]);
      const stored = await client.query<{ id: string; last_confirmation_sent_at: Date | null }>('SELECT id, last_confirmation_sent_at FROM waitlist_entries WHERE email = $1', [over]);
      expect(stored.rows[0]?.last_confirmation_sent_at).toBeNull();
      expect((await client.query('SELECT 1 FROM waitlist_mails WHERE entry_id = $1', [stored.rows[0]?.id])).rowCount).toBe(0);
      await client.query('UPDATE signup_limits SET waitlist_daily_cap = 1000000');
      const under = waitlistEmail();
      await client.query(`SELECT waitlist_join($1, 'ko', NULL, 'site')`, [under]);
      expect((await client.query(`SELECT 1 FROM waitlist_mails m JOIN waitlist_entries e ON e.id = m.entry_id WHERE e.email = $1`, [under])).rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('보안 검토 L2 — 하루 상한은 다시 등록하는 길(30일 주기 재발송)에도 걸린다: 상한을 넘으면 옛 항목의 재발송도 쌓지 않고 · 올리면 쌓는다 (롤백)', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      // 30일 넘게 전에 확인 메일을 받은 옛 항목 — 주기로는 한 통 더 나갈 차례다.
      const email = waitlistEmail();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO waitlist_entries (email, lang, source, created_at, last_confirmation_sent_at)
         VALUES ($1, 'ko', 'site', now() - interval '40 days', now() - interval '31 days') RETURNING id`,
        [email],
      );
      const id = inserted.rows[0]?.id ?? '';
      const used = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM waitlist_mails WHERE kind = 'confirmation' AND created_at > now() - interval '24 hours'`)).rows[0]?.n ?? 0;
      await client.query('UPDATE signup_limits SET waitlist_daily_cap = $1', [used]);
      await client.query(`SELECT waitlist_join($1, 'ko', NULL, 'site')`, [email]);
      expect((await client.query('SELECT 1 FROM waitlist_mails WHERE entry_id = $1', [id])).rowCount).toBe(0);
      // 응답이 같다 — 항목은 그대로 대기(메일만 없다) · 재발송 시각은 옛 값 그대로라 다음 등록이 다시 시도한다.
      const held = await client.query<{ status: string; stale: boolean }>(
        `SELECT status, last_confirmation_sent_at <= now() - interval '30 days' AS stale FROM waitlist_entries WHERE id = $1`,
        [id],
      );
      expect(held.rows[0]).toEqual({ status: 'waiting', stale: true });
      await client.query('UPDATE signup_limits SET waitlist_daily_cap = $1', [used + 1]);
      await client.query(`SELECT waitlist_join($1, 'ko', NULL, 'site')`, [email]);
      expect((await client.query('SELECT 1 FROM waitlist_mails WHERE entry_id = $1', [id])).rowCount).toBe(1);
      // 30일 주기는 그대로 — 방금 쌓았으니 상한이 넉넉해도 두 번째는 없다.
      await client.query('UPDATE signup_limits SET waitlist_daily_cap = 1000000');
      await client.query(`SELECT waitlist_join($1, 'ko', NULL, 'site')`, [email]);
      expect((await client.query('SELECT 1 FROM waitlist_mails WHERE entry_id = $1', [id])).rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // 메일
  // -------------------------------------------------------------------------

  it('확인 메일은 초대와 따로 센다 — 확인 창이 차면 확인은 deferred · 초대는 그대로 나간다(초대 우선)', async () => {
    const warm = waitlistEmail();
    await join({ email: warm });
    const warmEntry = await entryOf(owner, warm);
    await drain((await mailsOf(owner, warmEntry?.id ?? '')).map((m) => m.id)); // 확인 창에 한 통 이상
    const usedConfirmations = (
      await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM waitlist_mails WHERE kind = 'confirmation' AND claimed_at > now() - interval '1 hour'`)
    ).rows[0]?.n ?? 0;
    const pendingConfirm = waitlistEmail();
    await join({ email: pendingConfirm });
    const p = await entryOf(owner, pendingConfirm);
    const confirmation = (await mailsOf(owner, p?.id ?? ''))[0];
    const invited = waitlistEmail();
    await join({ email: invited });
    const i = await entryOf(owner, invited);
    await inviteWaitlistEntryOp(owner, i?.id ?? '', 'test:waitlist');
    const invitation = (await mailsOf(owner, i?.id ?? '')).find((m) => m.kind === 'invitation');
    const ses = fakeSes();
    const now = () => new Date(Date.now() + 1_000); // drain 과 같은 시계(앞선 집기가 창 안에 든다)
    const notifier = createWaitlistNotifier({ pool: mailer, client: ses.client as never, now, capPerHour: 1_000_000, confirmationCapPerHour: Math.max(usedConfirmations, 1) });
    const report = await runWaitlistMailer({ db: mailer, notifier, now }, { mailIds: [confirmation?.id ?? '', invitation?.id ?? ''] });
    expect([report.sent, report.deferred]).toEqual([1, 1]);
    expect(ses.sent.map((m) => m.to[0])).toEqual([invited]);
    expect((await mailsOf(owner, p?.id ?? ''))[0]?.status).toBe('pending');
  });

  it('워커: 확인 메일 한 통(onve@ · 헤더 표시 이름 · 등록 언어) · 두 번째 틱엔 없다 · 초대 메일 한 통 — 링크 = 가입 화면 #invite=base64url(주소)', async () => {
    const email = waitlistEmail();
    await join({ email, lang: 'ko' });
    const entry = await entryOf(owner, email);
    const [confirmation] = await mailsOf(owner, entry?.id ?? '');
    const first = await drain([confirmation?.id ?? '']);
    expect(first.report.sent).toBe(1);
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]?.from).toBe('onve@atmark.ai');
    expect(first.sent[0]?.to).toEqual([email]);
    expect(first.sent[0]?.raw).toMatch(/^From: "Onve \(Atmark\)" <onve@atmark\.ai>\r$/m);
    expect(mailText(first.sent[0] as SentMail)).toContain('대기자 명단에 등록되었습니다');
    const second = await drain([confirmation?.id ?? '']);
    expect([second.report.sent, second.sent.length]).toEqual([0, 0]);

    const invited = await inviteWaitlistEntryOp(owner, entry?.id ?? '', 'test:waitlist');
    expect(invited.fromStatus).toBe('waiting');
    const invitation = (await mailsOf(owner, entry?.id ?? '')).find((m) => m.kind === 'invitation');
    const out = await drain([invitation?.id ?? '']);
    expect(out.report.sent).toBe(1);
    expect(mailText(out.sent[0] as SentMail)).toContain(waitlistInviteLink('ko', email));
    expect(mailText(out.sent[0] as SentMail)).toContain('14일');
    expect((await drain([invitation?.id ?? ''])).sent).toHaveLength(0);
    expect((await mailsOf(owner, entry?.id ?? '')).map((m) => [m.kind, m.status])).toEqual([
      ['confirmation', 'sent'],
      ['invitation', 'sent'],
    ]);
  });

  it('억제 주소 → undeliverable · 지운 항목 → obsolete · 다시 초대하면 앞 초대 메일 obsolete · 앞선 시도의 sending 표식 → dead(send_unknown), 발송 0', async () => {
    const suppressed = waitlistEmail();
    await join({ email: suppressed });
    await owner.query(`INSERT INTO system_mail_suppressions (address, reason) VALUES ($1, 'hard_bounce') ON CONFLICT DO NOTHING`, [suppressed]);
    const s = await entryOf(owner, suppressed);
    const sOut = await drain((await mailsOf(owner, s?.id ?? '')).map((m) => m.id));
    expect([sOut.report.undeliverable, sOut.sent.length]).toEqual([1, 0]);

    const removed = waitlistEmail();
    await join({ email: removed });
    const r = await entryOf(owner, removed);
    const rMail = (await mailsOf(owner, r?.id ?? ''))[0];
    await removeWaitlistEntryOp(owner, r?.id ?? '', 'test:waitlist');
    expect(await entryById(owner, r?.id ?? '')).toBeNull();
    expect((await mailsOf(owner, r?.id ?? ''))[0]).toMatchObject({ id: rMail?.id, status: 'obsolete', last_error: 'entry_removed' });
    expect((await drain([rMail?.id ?? ''])).sent).toHaveLength(0);

    const twice = waitlistEmail();
    await join({ email: twice });
    const t = await entryOf(owner, twice);
    await inviteWaitlistEntryOp(owner, t?.id ?? '', 'test:waitlist');
    await owner.query(`UPDATE waitlist_entries SET invited_at = invited_at - interval '1 hour', invite_expires_at = invite_expires_at - interval '1 hour' WHERE id = $1`, [t?.id]);
    await inviteWaitlistEntryOp(owner, t?.id ?? '', 'test:waitlist');
    const invites = (await mailsOf(owner, t?.id ?? '')).filter((m) => m.kind === 'invitation');
    expect(invites).toHaveLength(2);
    const tOut = await drain(invites.map((m) => m.id));
    expect([tOut.report.obsolete, tOut.report.sent, tOut.sent.length]).toEqual([1, 1, 1]);
    expect((await mailsOf(owner, t?.id ?? '')).find((m) => m.id === invites[0]?.id)).toMatchObject({ status: 'obsolete', last_error: 'invite_changed' });

    // 앞선 시도가 SES 호출 뒤 기록 전에 죽었다(표식 · lease 끝) — 다시 보내지 않는다.
    const crashed = waitlistEmail();
    await join({ email: crashed });
    const c = await entryOf(owner, crashed);
    const cMail = (await mailsOf(owner, c?.id ?? ''))[0];
    await owner.query(`UPDATE waitlist_mails SET attempt_count = 1, claimed_at = now() - interval '5 minutes', next_attempt_at = now() - interval '4 minutes', last_error = 'sending' WHERE id = $1`, [cMail?.id]);
    const cOut = await drain([cMail?.id ?? '']);
    expect([cOut.report.dead, cOut.sent.length]).toEqual([1, 0]);
    expect((await mailsOf(owner, c?.id ?? ''))[0]).toMatchObject({ status: 'dead', last_error: 'send_unknown' });
  });

  // -------------------------------------------------------------------------
  // 보존 · 권한
  // -------------------------------------------------------------------------

  it('보존(가입 링크 보존 과제) — 초대 만료 30일 지난 항목 · 멤버가 된 주소의 항목을 지운다 · 대기 중 · 만료 29일은 그대로 · 쌓인 메일 obsolete', async () => {
    const old = waitlistEmail();
    const oldId = await seedInvite(owner, old, { expiredDaysAgo: 31 });
    await owner.query(`INSERT INTO waitlist_mails (entry_id, kind, lang, invite_expires_at) SELECT id, 'invitation', lang, invite_expires_at FROM waitlist_entries WHERE id = $1`, [oldId]);
    const recent = waitlistEmail();
    const recentId = await seedInvite(owner, recent, { expiredDaysAgo: 29 });
    const waiting = waitlistEmail();
    await join({ email: waiting });
    const member = await newOrganization(owner);
    await owner.query(`INSERT INTO waitlist_entries (email, lang, source) VALUES ($1, 'ko', 'site')`, [member.ownerEmail]);
    const app = (await import('../admin/support')).appPool();
    try {
      const purged = await app.query<{ n: number }>('SELECT purge_expired_signup_links() AS n');
      expect(purged.rows[0]?.n).toBeGreaterThanOrEqual(2);
    } finally {
      await app.end();
    }
    expect(await entryById(owner, oldId)).toBeNull();
    expect(await entryOf(owner, member.ownerEmail)).toBeNull();
    expect(await entryById(owner, recentId)).not.toBeNull();
    expect(await entryOf(owner, waiting)).not.toBeNull();
    expect((await mailsOf(owner, oldId)).map((m) => [m.status, m.last_error])).toEqual([['obsolete', 'entry_purged']]);
  });

  it('권한 — admin 은 표 권한 0(정의 함수 둘만) · 로그인 메일 롤은 메모·출처를 읽지 못하고 쓰지 못한다 · 앱 롤 0', async () => {
    const state = async (pool: Pool, sql: string): Promise<string> =>
      pool.query(sql).then(
        () => 'ok',
        (error: { code?: string }) => String(error.code),
      );
    expect(await state(admin, 'SELECT email FROM waitlist_entries LIMIT 1')).toBe('42501');
    expect(await state(admin, `INSERT INTO waitlist_entries (email, lang, source) VALUES ('x@example.com', 'ko', 'site')`)).toBe('42501');
    expect(await state(admin, 'SELECT 1 FROM waitlist_mails LIMIT 1')).toBe('42501');
    expect(await state(mailer, 'SELECT note FROM waitlist_entries LIMIT 1')).toBe('42501');
    expect(await state(mailer, 'SELECT source FROM waitlist_entries LIMIT 1')).toBe('42501');
    // 신청서(202609301530) — 로그인 메일 롤은 용도 한 칸만(보류 문단) · 알게 된 곳 · ref 는 읽지 못한다.
    expect(await state(mailer, 'SELECT use_case FROM waitlist_entries LIMIT 1')).toBe('ok');
    expect(await state(mailer, 'SELECT heard_from FROM waitlist_entries LIMIT 1')).toBe('42501');
    expect(await state(mailer, 'SELECT ref FROM waitlist_entries LIMIT 1')).toBe('42501');
    expect(await state(mailer, `UPDATE waitlist_entries SET use_case = 'alerts' WHERE false`)).toBe('42501');
    expect(await state(mailer, 'SELECT id, email, status, invite_expires_at FROM waitlist_entries LIMIT 1')).toBe('ok');
    expect(await state(mailer, `UPDATE waitlist_entries SET status = 'invited' WHERE false`)).toBe('42501');
    expect(await state(mailer, `INSERT INTO waitlist_mails (entry_id, kind, lang) VALUES (gen_random_uuid(), 'confirmation', 'ko')`)).toBe('42501');
    const app = (await import('../admin/support')).appPool();
    try {
      expect(await state(app, 'SELECT 1 FROM waitlist_entries LIMIT 1')).toBe('42501');
      expect(await state(app, 'SELECT 1 FROM waitlist_events LIMIT 1')).toBe('42501');
      expect(await state(app, `SELECT waitlist_join('a@example.com', 'ko', NULL, 'site')`)).toBe('42501');
    } finally {
      await app.end();
    }
  });
});
