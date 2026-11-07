/**
 * 가입 확인 메일 워커(`workers/signup-mailer` + `notify/signup-notifier`) — **login-mailer 롤로**, 가짜 SES(AWS 호출 0).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 수신자는 행의 `email` · 발신 `login@atmark.ai` · **코드만**(2026-10-10 — 링크 · 서명 토큰 없음) · 코드는 **가입 문맥**으로 그 행·만료에서 파생한다
 *     (로그인 문맥 코드와 다르다) · 한 통에 한 언어(가입 양식 언어 `signup_links.lang` → en) · `sent` 로 닫히고 두 번째 틱에 또 가지 않는다.
 *   - 억제 목록(어느 조직이든)의 주소 → `undeliverable`(`suppressed`), 발송 0.
 *   - 시스템 메일 억제(`system_mail_suppressions` — 로그인·가입·승인 알림의 하드 바운스·불만, 202609240900)의 주소 → 같은 결말.
 *   - 전역 시간당 상한 20(보안 검증 H2 — 60 에서 낮춤) — 창 안 시도 합이 20 이면 `undeliverable`(`global_cap`), 19 면 보낸다.
 *   - 만료 1분 전 → `obsolete`(`link_expired`).
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OWNER_LOGIN_FROM_ADDRESS } from '../../../src/notify/owner-login-notifier';
import { createSignupNotifier, SIGNUP_MAIL_GLOBAL_HOURLY_CAP } from '../../../src/notify/signup-notifier';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { mintLoginCode } from '../../../src/security/login-code';
import { runSignupMailer } from '../../../src/workers/signup-mailer';
import { adminPool, AVAILABLE, fakeSes, hex64, insertLinkAsAdmin, mailerPool, mailText, msTrunc, ownerPool, uniqueEmail } from './support';

const KEYS = parseHmacKeyring(`k1:${randomBytes(32).toString('base64url')}`, 'TEST_LOGIN');

describe.skipIf(!AVAILABLE)('가입 확인 메일 워커 (login-mailer 롤)', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminPool();
    mailer = mailerPool();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), mailer.end()]);
  });

  async function drain(email: string, now: () => Date = () => new Date()) {
    const ses = fakeSes();
    const notifier = createSignupNotifier({ pool: mailer, client: ses.client, keyring: KEYS, now, capPerHour: SIGNUP_MAIL_GLOBAL_HOURLY_CAP });
    const report = await runSignupMailer({ db: mailer, notifier, now }, { email });
    return { report, sent: ses.sent };
  }

  const linkRow = (id: string) =>
    owner
      .query<{ status: string; last_error: string | null; ses_message_id: string | null; attempt_count: number }>(
        'SELECT status::text, last_error, ses_message_id, attempt_count FROM signup_links WHERE id = $1',
        [id],
      )
      .then((r) => r.rows[0]);

  /**
   * 먼 미래의 한 시각 T 에 만든 대기 링크(소유자 롤) — 전역 시간당 상한(20)은 **공유 로컬 DB 전체**의 창 안 시도를 센다. 실제 시각으로
   * 보내면 같은 시간에 돈 다른 테스트의 발송이 창을 채워 `global_cap` 으로 떨어진다. T 의 창에는 이 테스트의 행만 있다.
   */
  async function isolatedLink(organizationName: string, lang: 'ko' | 'en' | null = null): Promise<{ id: string; email: string; expiresAt: Date; at: Date }> {
    const at = new Date(Date.now() + (1000 + Math.floor(Math.random() * 100_000)) * 86_400_000);
    const email = uniqueEmail();
    const createdAt = new Date(at.getTime() - 60 * 1000);
    const expiresAt = msTrunc(new Date(createdAt.getTime() + 25 * 60 * 1000));
    const row = await owner.query<{ id: string }>(
      `INSERT INTO signup_links (email, organization_name, browser_binding, client_key, created_at, expires_at, next_attempt_at, lang)
       VALUES ($1, $2, $3, $4, $5, $6, $5, $7) RETURNING id`,
      [email, organizationName, hex64(), hex64(), createdAt, expiresAt, lang],
    );
    return { id: row.rows[0]?.id ?? '', email, expiresAt, at };
  }

  it('행의 email 로 login@ 에서 보낸다 · 코드만(가입 문맥) · 양식 언어(없으면 en) · sent 로 닫히고 두 번째 틱엔 없다', async () => {
    const link = await isolatedLink('OO은행 보안팀: 즉시 클릭');
    const { report, sent } = await drain(link.email, () => link.at);
    expect(report.sent).toBe(1);
    expect(sent).toHaveLength(1);
    const [mail] = sent;
    expect(mail?.to).toEqual([link.email]);
    expect(mail?.from).toBe(OWNER_LOGIN_FROM_ADDRESS);
    const text = mail === undefined ? '' : mailText(mail);
    // 요청자가 고른 조직 이름은 본문에 없다.
    expect(text).not.toContain('OO은행');
    // 링크 · 서명 토큰이 없다(2026-10-10).
    expect(text).not.toMatch(/https?:\/\/|atk_signup_|atk_login_/);
    // 양식 언어가 없는 행(옛 행) → 기본 영어 한 언어.
    expect(text).toContain('Enter this code on the sign-up screen.');
    expect(text).not.toMatch(/[가-힣]/);
    // 6자리 코드 — 같은 링크 id·만료에서 가입 문맥으로 파생(저장하지 않는다). 한 번. 로그인 문맥 코드와 다르다.
    const code = mintLoginCode(KEYS, 'signup', { linkId: link.id, expiresAt: link.expiresAt });
    expect(text.split('\n').filter((line) => line === code)).toHaveLength(1);
    expect(mintLoginCode(KEYS, 'owner_login', { linkId: link.id, expiresAt: link.expiresAt })).not.toBe(code);
    expect(mail?.raw).toMatch(/Subject: /);
    const row = await linkRow(link.id);
    expect([row?.status, row?.last_error, row?.attempt_count]).toEqual(['sent', null, 1]);
    expect(row?.ses_message_id).toMatch(/^ses-/);
    expect((await drain(link.email, () => link.at)).sent).toEqual([]);

    // 가입 양식이 한국어였으면 한국어 한 통.
    const korean = await isolatedLink('Acme', 'ko');
    const [koMail] = (await drain(korean.email, () => korean.at)).sent;
    const koText = koMail === undefined ? '' : mailText(koMail);
    expect(koText).toContain('가입 화면에 입력해 주세요.');
    expect(koText).not.toContain('Enter this code');
  });

  it('억제 목록(어느 조직이든)의 주소는 undeliverable(suppressed) — 보내지 않는다', async () => {
    const link = await insertLinkAsAdmin(admin);
    const org = await owner.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('suppressing org') RETURNING id`);
    await owner.query(
      `INSERT INTO suppression_entries (organization_id, address, domain, source) VALUES ($1, $2, split_part($2, '@', 2), 'bounce')`,
      [org.rows[0]?.id, link.email],
    );
    const { report, sent } = await drain(link.email);
    expect([report.undeliverable, sent.length]).toEqual([1, 0]);
    const row = await linkRow(link.id);
    expect([row?.status, row?.last_error]).toEqual(['undeliverable', 'suppressed']);
  });

  it('시스템 메일 억제(하드 바운스·불만)의 주소도 undeliverable(suppressed) — 보내지 않는다', async () => {
    const link = await insertLinkAsAdmin(admin);
    await owner.query(`INSERT INTO system_mail_suppressions (address, reason) VALUES ($1, 'complaint')`, [link.email]);
    const { report, sent } = await drain(link.email);
    expect([report.undeliverable, sent.length]).toEqual([1, 0]);
    expect(await linkRow(link.id)).toMatchObject({ status: 'undeliverable', last_error: 'suppressed' });
  });

  /**
   * 전역 상한 — 먼 미래의 한 시각 T 를 창으로 쓴다(공유 DB 의 다른 테스트 행이 창에 들어오지 않게). 창 안에 `used` 번의 시도를
   * 소유자 롤로 심고, T 직전에 만든 대기 링크 하나를 T 에 보낸다.
   */
  async function capScenario(used: number): Promise<{ outcome: Awaited<ReturnType<typeof drain>>; linkId: string }> {
    const at = new Date(Date.now() + (1000 + Math.floor(Math.random() * 100_000)) * 86_400_000);
    for (let i = 0; i < used; i += 1) {
      const createdAt = new Date(at.getTime() - 20 * 60 * 1000);
      await owner.query(
        `INSERT INTO signup_links (email, organization_name, browser_binding, client_key, created_at, expires_at,
                                   status, attempt_count, next_attempt_at, claimed_at, sent_at, ses_message_id)
         VALUES ($1, 'cap', $2, $3, $4, $5, 'sent', 1, $4, $6, $6, $7)`,
        [uniqueEmail(), hex64(), hex64(), createdAt, msTrunc(new Date(createdAt.getTime() + 30 * 60 * 1000)), new Date(at.getTime() - 10 * 60 * 1000), `ses-${randomUUID()}`],
      );
    }
    const email = uniqueEmail();
    const createdAt = new Date(at.getTime() - 60 * 1000);
    const pending = await owner.query<{ id: string }>(
      `INSERT INTO signup_links (email, organization_name, browser_binding, client_key, created_at, expires_at, next_attempt_at)
       VALUES ($1, 'cap target', $2, $3, $4, $5, $4) RETURNING id`,
      [email, hex64(), hex64(), createdAt, msTrunc(new Date(createdAt.getTime() + 25 * 60 * 1000))],
    );
    return { outcome: await drain(email, () => at), linkId: pending.rows[0]?.id ?? '' };
  }

  it(`전역 시간당 상한 ${String(SIGNUP_MAIL_GLOBAL_HOURLY_CAP)} — 창 안 시도가 상한이면 undeliverable(global_cap), 하나 모자라면 보낸다`, async () => {
    expect(SIGNUP_MAIL_GLOBAL_HOURLY_CAP).toBe(20);
    const full = await capScenario(SIGNUP_MAIL_GLOBAL_HOURLY_CAP);
    expect([full.outcome.report.undeliverable, full.outcome.sent.length]).toEqual([1, 0]);
    expect(await linkRow(full.linkId)).toMatchObject({ status: 'undeliverable', last_error: 'global_cap' });

    const room = await capScenario(SIGNUP_MAIL_GLOBAL_HOURLY_CAP - 1);
    expect([room.outcome.report.sent, room.outcome.sent.length]).toEqual([1, 1]);
    expect(await linkRow(room.linkId)).toMatchObject({ status: 'sent' });
  });

  it('만료 1분 전 링크는 obsolete(link_expired) — 받는 순간 죽은 링크를 보내지 않는다', async () => {
    const link = await insertLinkAsAdmin(admin, { ttlMs: 30_000 });
    const { report, sent } = await drain(link.email);
    expect([report.obsolete, sent.length]).toEqual([1, 0]);
    expect(await linkRow(link.id)).toMatchObject({ status: 'obsolete', last_error: 'link_expired' });
  });
});
