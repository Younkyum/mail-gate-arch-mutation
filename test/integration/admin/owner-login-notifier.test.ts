/**
 * **로그인 링크 알림기 — 로그인 메일 롤(`atmark_login_mailer`) 위에서** (`src/notify/owner-login-notifier.ts`). 실메일 0.
 *
 *   - 수신자는 `users.email` 하나(링크 → 사용자, 202609250110·0190) — `organizations.owner_email` 과 무관하다
 *   - 만료가 1분 안이면 보내지 않는다(obsolete) · 전송 실패는 retry, 시도를 다 쓰면 dead
 *   - 사용자당 시간당 상한 — 넘으면 보내지 않고 닫는다(15분짜리 링크를 미루면 받는 순간 죽는다)
 *   - 종단 행은 다시 열리지 않는다(같은 링크의 두 번째 메일 없음)
 *   - 시스템 메일 억제(`system_mail_suppressions` — 하드 바운스·불만, 202609240900)의 주소 → undeliverable(`suppressed`), 메일 0
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOwnerLoginNotifier, OWNER_LOGIN_NOTIFY_HOURLY_CAP_PER_USER } from '../../../src/notify/owner-login-notifier';
import { runOwnerLoginNotifier } from '../../../src/workers/owner-login-notifier';
import { afterDbNow } from '../../support/db-clock';
import { AVAILABLE, drainLoginMail, fakeSes, LOGIN_KEYS, loginMailerPool, newOrganization, ownerPool, suffix, userIdOf } from './support';

/** `userId` 를 반드시 적는다(202609250190 — 자동 채움 트리거가 걷혔고 `owner_login_links_user_required` CHECK 가 새 행을 막는다). */
async function insertLink(owner: Pool, organizationId: string, userId: string, ttl = '15 minutes'): Promise<string> {
  const row = await owner.query<{ id: string }>(
    `INSERT INTO owner_login_links (organization_id, user_id, browser_binding, expires_at, next_attempt_at)
     VALUES ($1, $2, $3, date_trunc('milliseconds', now() + $4::interval), date_trunc('milliseconds', now())) RETURNING id`,
    [organizationId, userId, 'c'.repeat(64), ttl],
  );
  return row.rows[0]?.id ?? '';
}

async function statusOf(owner: Pool, id: string): Promise<{ status: string; last_error: string | null; attempt_count: number }> {
  const row = await owner.query<{ status: string; last_error: string | null; attempt_count: number }>(
    'SELECT status, last_error, attempt_count FROM owner_login_links WHERE id = $1',
    [id],
  );
  const found = row.rows[0];
  if (found === undefined) throw new Error('link');
  return found;
}

describe.skipIf(!AVAILABLE)('로그인 링크 알림기 (로그인 메일 롤)', () => {
  let owner: Pool;
  let app: Pool;
  beforeAll(() => {
    owner = ownerPool();
    app = loginMailerPool();
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  /**
   * 0190 이전에는 이 자리가 "owner_email 이 없는 조직" 을 시험했다 — organizations.owner_email 을 지운 뒤 링크를 넣으면
   * 옛 자동 채움 트리거가 그 사용자를 못 찾아 `user_id` 가 NULL 로 남았고, 그러면 notifier 가 `undeliverable
   * (owner_email_missing)` 로 닫았다. 0190 이 그 자동 채움 트리거를 걷고 `owner_login_links_user_required` CHECK 로
   * `user_id NOT NULL` 을 강제하면서 그 모양의 행은 더는 INSERT 로 만들 수 없다 — 그리고 `users.email` 도 NOT NULL 이라
   * "user_id 는 있는데 email 이 없다" 는 경로도 없다. `owner_email_missing` 분기는 이제 0110 이전의 옛 프로덕션 행(테스트로
   * 재현 불가)에만 닿는 죽은 경로다.
   *
   * 대신 이 자리는 0190 이 세우는 계약을 직접 증명한다: 수신자는 **오직** 링크의 `user_id → users.email` 에서 나오고
   * `organizations.owner_email` 과는 아예 무관하다 — 조직에 주 소유자 주소가 없어도(=owner_email 이 처음부터 NULL) 그
   * 조직의 멤버가 받은 로그인 링크는 그 멤버의 주소로 나간다.
   */
  it('organizations.owner_email 이 없어도 보낸다 — 수신자는 users.email(링크→사용자), 조직 표와 무관(0190)', async () => {
    // owner_email 없이 조직을 만든다 — 조직 INSERT 트리거(0100 ③)는 owner_email 이 NULL 이면 사용자·멤버십을 만들지 않는다.
    const org = await owner.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`notifier-noowner-${suffix()}`]);
    const organizationId = org.rows[0]?.id ?? '';
    const address = `notify-member-${suffix()}@example.com`;
    await owner.query('INSERT INTO users (email) VALUES ($1)', [address]);
    const userId = await userIdOf(owner, address);
    // 멤버십은 SECURITY DEFINER 함수 밖에서는 admin 롤도 못 만든다 — 소유자 롤로 직접(지반, 운영에는 없는 경로).
    await owner.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, 'member', 'invite')`, [userId, organizationId]);
    const id = await insertLink(owner, organizationId, userId);
    const mails = await drainLoginMail(app, organizationId);
    expect(mails.map((mail) => mail.to)).toEqual([[address]]);
    expect(await statusOf(owner, id)).toMatchObject({ status: 'sent' });
    // organizations.owner_email 은 이 조직에서 한 번도 값을 가진 적이 없다 — 그런데도 메일은 나갔다.
    expect((await owner.query<{ owner_email: string | null }>('SELECT owner_email FROM organizations WHERE id = $1', [organizationId])).rows[0]?.owner_email).toBeNull();
  });

  it('시스템 메일 억제(하드 바운스·불만)의 owner_email → undeliverable(suppressed) · 메일 0 · 억제 없는 조직은 보낸다', async () => {
    const org = await newOrganization(owner);
    const user = await userIdOf(owner, org.ownerEmail);
    await owner.query(`INSERT INTO system_mail_suppressions (address, reason) VALUES ($1, 'hard_bounce')`, [org.ownerEmail]);
    const id = await insertLink(owner, org.id, user);
    expect(await drainLoginMail(app, org.id)).toHaveLength(0);
    expect(await statusOf(owner, id)).toMatchObject({ status: 'undeliverable', last_error: 'suppressed' });
    // 비공허: 억제되지 않은 주소면 나간다.
    const clean = await newOrganization(owner);
    const cleanUser = await userIdOf(owner, clean.ownerEmail);
    await insertLink(owner, clean.id, cleanUser);
    expect((await drainLoginMail(app, clean.id)).map((mail) => mail.to)).toEqual([[clean.ownerEmail]]);
  });

  it('만료가 1분 안이면 보내지 않는다(obsolete)', async () => {
    const org = await newOrganization(owner);
    const user = await userIdOf(owner, org.ownerEmail);
    const id = await insertLink(owner, org.id, user, '30 seconds');
    expect(await drainLoginMail(app, org.id)).toHaveLength(0);
    expect(await statusOf(owner, id)).toMatchObject({ status: 'obsolete', last_error: 'link_expired' });
  });

  it('전송 실패는 retry(뒤로 미룸) — 조용히 sent 가 되지 않는다', async () => {
    const org = await newOrganization(owner);
    const user = await userIdOf(owner, org.ownerEmail);
    const id = await insertLink(owner, org.id, user);
    await afterDbNow(owner); // next_attempt_at 은 ms 로 잘린 DB now() — JS 시계가 DB 시계보다 뒤면 기한 전으로 본다(시계 어긋남 방어)
    const failing = { send: () => Promise.reject(new Error('Throttling')) };
    const notifier = createOwnerLoginNotifier({ pool: app, client: failing, keyring: LOGIN_KEYS, now: () => new Date() });
    const report = await runOwnerLoginNotifier({ db: app, notifier, now: () => new Date() }, { organizationId: org.id });
    expect(report.retry).toBe(1);
    expect(await statusOf(owner, id)).toMatchObject({ status: 'pending', last_error: 'send_failed', attempt_count: 1 });
  });

  it(`수신자(사용자)당 시간당 상한(${String(OWNER_LOGIN_NOTIFY_HOURLY_CAP_PER_USER)}통) — 넘는 링크는 보내지 않고 닫는다`, async () => {
    const org = await newOrganization(owner);
    const user = await userIdOf(owner, org.ownerEmail);
    const ids: string[] = [];
    for (let i = 0; i < OWNER_LOGIN_NOTIFY_HOURLY_CAP_PER_USER + 2; i += 1) ids.push(await insertLink(owner, org.id, user));
    await afterDbNow(owner); // 위와 같은 방어 — 마지막 링크들이 기한 전으로 읽히면 보낸 수가 상한보다 적게 나온다
    const ses = fakeSes();
    const notifier = createOwnerLoginNotifier({ pool: app, client: ses.client, keyring: LOGIN_KEYS, now: () => new Date() });
    const report = await runOwnerLoginNotifier({ db: app, notifier, now: () => new Date() }, { organizationId: org.id });
    expect(ses.sent).toHaveLength(OWNER_LOGIN_NOTIFY_HOURLY_CAP_PER_USER);
    expect(report.sent).toBe(OWNER_LOGIN_NOTIFY_HOURLY_CAP_PER_USER);
    expect(report.deferred).toBe(2);
    for (const mail of ses.sent) expect(mail.to).toEqual([org.ownerEmail]);
  });
});
