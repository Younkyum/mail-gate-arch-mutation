/**
 * **H1 — api Lambda 탈취 → 소유자 세션 경로가 끊겼다** (ADR-0006, 2026-09-23 검증 F1 재현을 영구 테스트로).
 *
 * 검증자의 재현: api Lambda 를 쥔 공격자는 ① 앱 롤로 `organizations.owner_email` 을 읽고 ② 콘솔에 **자기 브라우저로** 로그인을
 * 요청해 논스 쿠키를 받고 ③ 앱 롤로 `owner_login_links(id, expires_at)` 을 읽고 ④ 발송 역할(api 와 같은 IAM 역할)이 읽는
 * 로그인 키로 토큰을 만들어 ⑤ 자기 논스로 verify → 소유자 세션. 메일함은 한 번도 필요 없었다.
 *
 * 이제 끊긴 곳이 **둘**이다(둘 중 하나만으로도 끊긴다):
 *   - DB: 앱 롤은 `owner_login_links` 에 권한이 0 이다(③ 불가) — 아래 실제 Postgres 단언.
 *   - IAM: 발송 역할은 로그인 키 비밀을 읽지 못하고, api·approval-notifier 환경에 그 ARN 도 없다(④ 불가) — 아래 템플릿 단언.
 * **우회 H1'** — 앱 롤이 `organizations.owner_email` 을 공격자 주소로 바꾸면 로그인 메일 자체가 공격자에게 간다. 앱 롤의
 * `organizations`·`agents` UPDATE 를 컬럼 단위로 좁혀(202609230730) 그 문장이 권한 오류다.
 * 그리고 **대조군**: 같은 절차를 로그인 메일 롤(링크 id·만료를 정당하게 읽는 유일한 런타임 롤)로 하면 세션이 나온다 — 이 테스트가
 * 공허하지 않다는 증거이자, 남은 위험이 정확히 "login-mailer Lambda 탈취" 하나라는 기록이다(HTTP 입구 0 · 스케줄러만 부른다).
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOGIN_BROWSER_COOKIE, SESSION_COOKIE } from '../../../src/admin/http';
import { mintLoginCode } from '../../../src/security/login-code';
import { SENDER_ROLE_LOGICAL_ID, SES_SENDING_HANDLERS } from '../../../infra/cdk/stacks/compute-stack';
import { actionsOf, readsSsmSecret, runtimeTemplates, statementsByRole } from '../../unit/infra/runtime-app';
import {
  adminDeps,
  adminRolePool,
  appPool,
  AVAILABLE,
  call,
  cookieValue,
  drainLoginMail,
  LOGIN_KEYS,
  loginMailerPool,
  newOrganization,
  ownerPool,
  uniqueCodeIp,
} from './support';

describe.skipIf(!AVAILABLE)('H1 — DB: 앱 롤(api Lambda)로는 로그인 링크를 읽을 수 없다', () => {
  let owner: Pool;
  let app: Pool;
  let admin: Pool;
  let mailer: Pool;
  beforeAll(() => {
    owner = ownerPool();
    app = appPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), app.end(), admin.end(), mailer.end()]);
  });

  /** ①② — 공격자가 스스로 로그인을 요청한다(공개 엔드포인트). 논스는 공격자 브라우저의 것. */
  async function attackerRequestsLogin(): Promise<{ orgId: string; nonce: string }> {
    const org = await newOrganization(owner);
    const email = (await app.query<{ owner_email: string }>('SELECT owner_email FROM organizations WHERE id = $1', [org.id])).rows[0]?.owner_email;
    expect(email).toBe(org.ownerEmail); // ① 은 여전히 된다 — 주소는 비밀이 아니다(승인 알림이 앱 롤로 읽는다)
    const requested = await call(adminDeps(admin), 'POST', '/api/login', { body: { email }, ip: '203.0.113.77' });
    expect(requested.statusCode).toBe(202);
    const nonce = cookieValue(requested, LOGIN_BROWSER_COOKIE);
    if (nonce === undefined) throw new Error('논스 쿠키가 없다');
    return { orgId: org.id, nonce };
  }

  it('③ 앱 롤: 링크 id·만료를 읽을 수 없다 — 어느 컬럼도, 어떤 모양의 문장으로도', async () => {
    const { orgId } = await attackerRequestsLogin();
    for (const sql of [
      'SELECT id, expires_at FROM owner_login_links WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1',
      'SELECT id FROM owner_login_links WHERE organization_id = $1',
      'SELECT expires_at FROM owner_login_links WHERE organization_id = $1',
      'SELECT count(*) FROM owner_login_links WHERE organization_id = $1',
    ]) {
      await expect(app.query(sql, [orgId]), sql).rejects.toThrow(/permission denied/);
    }
    // 행을 건드려 RETURNING 으로 꺼내는 길도 없다.
    await expect(
      app.query(`UPDATE owner_login_links SET last_error = 'x' WHERE organization_id = $1 RETURNING id, expires_at`, [orgId]),
    ).rejects.toThrow(/permission denied/);
    // 세션·감사도 0.
    await expect(app.query('SELECT 1 FROM owner_sessions LIMIT 1')).rejects.toThrow(/permission denied/);
  });

  it("H1' 앱 롤로 owner_email 을 공격자 주소로 바꿀 수 없다 — 로그인 링크를 자기 메일함으로 돌리는 우회 (202609230730)", async () => {
    const org = await newOrganization(owner);
    // 공격 ①: 수신자를 바꾼다 — 이것이 되면 로그인 메일이 공격자에게 간다(아래 대조가 보인다).
    await expect(
      app.query('UPDATE organizations SET owner_email = $2 WHERE id = $1', [org.id, 'attacker@example.net']),
    ).rejects.toThrow(/permission denied/);
    // 같은 권한으로 풀 수 있던 정지·동결도 막혔다.
    for (const sql of [
      'UPDATE organizations SET abuse_freeze = false WHERE id = $1',
      'UPDATE organizations SET owner_paused = false WHERE id = $1',
      "UPDATE agents SET status = 'active' WHERE organization_id = $1",
      'UPDATE agents SET suspended_by = NULL WHERE organization_id = $1',
    ]) {
      await expect(app.query(sql, [org.id]), sql).rejects.toThrow(/permission denied/);
    }
    // 비공허: 앱 코드가 실제로 쓰는 단 하나의 컬럼(첫 발송 기준일)은 된다.
    await expect(app.query('UPDATE organizations SET sending_started_at = sending_started_at WHERE id = $1', [org.id])).resolves.toBeDefined();

    // 대조: 주소가 바뀌면(소유자 롤로 — 운영에서는 소유자 셸만) 로그인 메일은 **새 주소**로 간다. 앱 롤이 이 UPDATE 를 할 수
    //   있었다면 api 탈취 → 로그인 요청 → 링크 수령 → 소유자 세션이었다.
    await owner.query('UPDATE organizations SET owner_email = $2 WHERE id = $1', [org.id, `moved-${org.id.slice(0, 8)}@example.net`]);
    const requested = await call(adminDeps(admin), 'POST', '/api/login', { body: { email: `moved-${org.id.slice(0, 8)}@example.net` } });
    expect(requested.statusCode).toBe(202);
    const mails = await drainLoginMail(mailer, org.id);
    expect(mails.map((mail) => mail.to)).toEqual([[`moved-${org.id.slice(0, 8)}@example.net`]]);
  });

  it('대조군: 링크 id·만료를 정당하게 읽는 로그인 메일 롤 + 로그인 키 → 공격자 논스로 세션이 나온다 (남은 위험 = login-mailer 탈취)', async () => {
    const { orgId, nonce } = await attackerRequestsLogin();
    // 메일은 소유자에게 나간다(코드는 `sent` 행만 후보다). 공격자는 그 메일을 보지 못하지만 키 + 행 id·만료로 같은 코드를 만든다.
    expect(await drainLoginMail(mailer, orgId)).toHaveLength(1);
    const link = (
      await mailer.query<{ id: string; expires_at: Date }>(
        'SELECT id, expires_at FROM owner_login_links WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1',
        [orgId],
      )
    ).rows[0];
    if (link === undefined) throw new Error('링크 행이 없다');
    const code = mintLoginCode(LOGIN_KEYS, 'owner_login', { linkId: link.id, expiresAt: link.expires_at });
    const verified = await call(adminDeps(admin), 'POST', '/api/login/verify', { body: { code }, cookies: { [LOGIN_BROWSER_COOKIE]: nonce }, ip: uniqueCodeIp() });
    expect(verified.statusCode).toBe(200);
    expect(cookieValue(verified, SESSION_COOKIE)).toMatch(/^atk_admin_/);
  });
});

describe('H1 — IAM: 발송 역할(api·approval-notifier 가 공유)은 로그인 키를 읽지 못한다', () => {
  it('④ 발송 역할의 어떤 문장도 로그인 키 비밀을 가리키지 않는다 · 읽는 역할은 admin·login-mailer 둘뿐', () => {
    const byRole = statementsByRole(runtimeTemplates().compute);
    const sender = byRole.get(SENDER_ROLE_LOGICAL_ID) ?? [];
    expect(sender.length).toBeGreaterThan(0);
    // 2026-10-12 비밀 → SSM 이전 — 로그인 키는 SSM `/atmark/owner-login-keys`. 옛 Secrets Manager 자리도, SSM 자리(읽기 · 복호 문맥)도 발송 역할에 없다.
    expect(sender.filter((statement) => JSON.stringify(statement.Resource).includes('OwnerLoginKeysSecret'))).toEqual([]);
    expect(sender.filter((statement) => JSON.stringify(statement).includes('/atmark/owner-login-keys'))).toEqual([]);
    const readers = [...byRole]
      .filter(([, statements]) => statements.some((s) => readsSsmSecret(s, 'atmark/owner-login-keys')))
      .map(([role]) => role);
    expect(
      [...byRole.values()].flat().some((s) => actionsOf(s).includes('secretsmanager:GetSecretValue') && JSON.stringify(s.Resource).includes('OwnerLoginKeysSecret')),
    ).toBe(false);
    expect(readers).toHaveLength(2);
    expect(readers).not.toContain(SENDER_ROLE_LOGICAL_ID);
  });

  it('④ 발송 4핸들러(api 포함) 환경에 로그인 키 ARN 이 없다', () => {
    const functions = runtimeTemplates().compute.findResources('AWS::Lambda::Function') as Record<
      string,
      { Properties: { FunctionName: string; Environment: { Variables: Record<string, unknown> } } }
    >;
    const byName = new Map(Object.values(functions).map((fn) => [fn.Properties.FunctionName, fn.Properties.Environment.Variables]));
    for (const handler of SES_SENDING_HANDLERS) {
      const variables = byName.get(`atmark-${handler}`);
      expect(variables, handler).toBeDefined();
      expect(Object.keys(variables ?? {}), handler).not.toContain('ATMARK_OWNER_LOGIN_KEYS_SECRET_ARN');
    }
  });
});
