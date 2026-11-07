/**
 * **소유자 주소가 바뀌면 쓰지 않은 로그인 링크가 죽는다** (202609230750 ⑨ — 2차 검증 M-C). 실메일 0.
 *
 * 202609230710 의 트리거는 `owner_email` 이 바뀔 때 **세션**만 폐기했다. 그 사이 발급된 링크는 살아 있었다:
 *   ① 이미 보낸 링크 — 옛 주소의 메일함에 남은 링크로 새 소유자의 조직에 로그인할 수 있었다.
 *   ② 아직 안 보낸 링크 — 로그인 메일 워커는 보낼 때 `owner_email` 을 읽으므로 **옛 주소가 요청한 링크를 새 주소로** 보냈다.
 * 이제 ① verify 는 401 · ② 링크는 `obsolete` 로 닫히고 아무 데로도 가지 않는다. 주소가 바뀐 뒤의 새 요청은 정상이다.
 * 판정은 운영과 같은 롤로 한다 — admin 경로는 `atmark_admin`, 워커는 `atmark_login_mailer`, 주소 변경은 소유자 롤(CLI).
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOGIN_BROWSER_COOKIE } from '../../../src/admin/http';
import {
  adminDeps,
  adminRolePool,
  AVAILABLE,
  call,
  cookieValue,
  drainLoginMail,
  login,
  loginMailerPool,
  newOrganization,
  ownerPool,
  suffix,
  codeFromMail,
  uniqueCodeIp,
} from './support';

describe.skipIf(!AVAILABLE)('owner_email 변경 → 쓰지 않은 로그인 링크 무효 (M-C)', () => {
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

  async function changeOwnerEmail(organizationId: string): Promise<string> {
    const next = `owner-next-${suffix()}@example.com`;
    await owner.query('UPDATE organizations SET owner_email = $2 WHERE id = $1', [organizationId, next]);
    return next;
  }

  async function linkState(organizationId: string): Promise<{ status: string; invalidated: boolean; used: boolean }[]> {
    const rows = await owner.query<{ status: string; invalidated: boolean; used: boolean }>(
      `SELECT status::text AS status, invalidated_at IS NOT NULL AS invalidated, used_at IS NOT NULL AS used
         FROM owner_login_links WHERE organization_id = $1 ORDER BY created_at`,
      [organizationId],
    );
    return rows.rows;
  }

  it('① 보낸 링크 → 주소 변경 → 같은 브라우저의 verify 도 401 · 세션 0', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const requested = await call(deps, 'POST', '/api/login', { body: { email: org.ownerEmail } });
    expect(requested.statusCode).toBe(202);
    const nonce = cookieValue(requested, LOGIN_BROWSER_COOKIE);
    const [mail] = await drainLoginMail(mailer, org.id);
    if (mail === undefined || nonce === undefined) throw new Error('링크가 나가지 않았다');
    expect(mail.to).toEqual([org.ownerEmail]);

    await changeOwnerEmail(org.id);
    const verified = await call(deps, 'POST', '/api/login/verify', {
      body: { code: codeFromMail(mail) },
      ip: uniqueCodeIp(),
      cookies: { [LOGIN_BROWSER_COOKIE]: nonce },
    });
    expect(verified.statusCode).toBe(401);
    expect(await linkState(org.id)).toEqual([{ status: 'sent', invalidated: true, used: false }]);
    const sessions = await owner.query('SELECT 1 FROM owner_sessions WHERE organization_id = $1', [org.id]);
    expect(sessions.rowCount).toBe(0);
  });

  it('② 안 보낸 링크 → 주소 변경 → 워커는 아무 데로도 보내지 않는다(새 주소 포함) · obsolete', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const requested = await call(deps, 'POST', '/api/login', { body: { email: org.ownerEmail } });
    expect(requested.statusCode).toBe(202);

    await changeOwnerEmail(org.id);
    expect(await drainLoginMail(mailer, org.id)).toEqual([]);
    expect(await linkState(org.id)).toEqual([{ status: 'obsolete', invalidated: true, used: false }]);
  });

  it('통제군 — 주소가 바뀐 뒤 새 주소로 요청한 링크는 정상으로 로그인된다', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    await call(deps, 'POST', '/api/login', { body: { email: org.ownerEmail } });
    const next = await changeOwnerEmail(org.id);
    const session = await login(deps, mailer, { id: org.id, ownerEmail: next });
    expect(session.token).toMatch(/.+/);
  });

  it('invalidated_at 은 쓰기 1회 · 무효 링크의 used_at 기록은 소유자 롤로 보내도 0행', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    await call(deps, 'POST', '/api/login', { body: { email: org.ownerEmail } });
    await drainLoginMail(mailer, org.id);
    await changeOwnerEmail(org.id);
    await expect(
      owner.query('UPDATE owner_login_links SET invalidated_at = NULL WHERE organization_id = $1', [org.id]),
    ).rejects.toThrow(/write-once column owner_login_links\.invalidated_at/);
    const used = await owner.query('UPDATE owner_login_links SET used_at = now() WHERE organization_id = $1 AND used_at IS NULL', [org.id]);
    expect(used.rowCount).toBe(0);
  });
});
