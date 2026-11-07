/**
 * **제한 롤 셋(`atmark_app` · `atmark_admin` · `atmark_login_mailer`)의 실제 권한 = 허용 목록** — 실제 Postgres 위에서
 * (ADR-0006, 검증 H1·H2 · 2차 검증 H-A·H-B — 앱 롤은 202609230750 부터 목록에 있다).
 *
 *   - ① 마이그레이션 202609230720 이 준 권한(카탈로그 ACL)이 `RESTRICTED_ROLE_GRANTS` 와 **정확히** 같다. 넘치면 status 가
 *     빨개지고, 모자라면 목록이 거짓말을 한다 — 두 방향을 한 단언이 본다.
 *   - ② 둘 다 아무것도 소유하지 않고, 다른 롤의 멤버가 아니며, 슈퍼유저·CREATEROLE·BYPASSRLS 가 아니다.
 *   - ③ 검사가 잠들지 않았다: 허용 목록 밖 권한 · 소유 · 멤버십을 **트랜잭션 안에서** 만들면(롤백) 위반으로 잡는다.
 *   - ④ migrate `status` 가 같은 위반(제한 롤의 여분 권한 · 앱 롤의 로그인 테이블 권한 · 앱 롤의 금지 컬럼 UPDATE —
 *     `owner_email`·동결·정지)을 ok=false 로 보고한다.
 *   - ⑥ 202609230750 이 거둔 앱 롤 권한을 **하나씩 되돌려 주면** status 가 그 이름으로 ok=false 가 된다 · 가드 트리거를
 *     지우거나 끄면 `missingGuards` · PUBLIC 에 TEMP 를 돌려주면 `databaseTempRoles`.
 *   - ⑤ admin 롤은 DDL 을 못 한다 — 감사 트리거 DROP · 권한 재부여 · 운영자 동결(abuse_freeze) 해제 · 감사 행 삭제가 거부된다.
 *
 * `TEST_DATABASE_URL` / `TEST_MIGRATION_DATABASE_URL` 이 없으면 건너뛴다. 로컬 준비: `docs/runbooks/admin.md` §8-2.
 */

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../../src/db/client';
import {
  ADMIN_ROLE,
  APP_ROLE_NAME,
  DOMAIN_TICK_ROLE,
  BILLING_OPERATOR_ROLE,
  BILLING_ROLE,
  inspectRestrictedRole,
  LOGIN_MAILER_ROLE,
  RESTRICTED_ROLE_GRANTS,
} from '../../../src/runtime/role-bootstrap';
import { ADMIN_ROLE_URL } from '../admin/support';
import { statusOn } from './support';

const ownerUrl = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
const AVAILABLE = ownerUrl.trim() !== '' && ADMIN_ROLE_URL.trim() !== '';

/**
 * 트랜잭션 안에서 `run` 을 돌리고 **언제나 롤백**한다. 이 파일의 DDL(트리거·제약 DROP)은 병렬로 도는 다른 통합 테스트 파일의 DML 과
 * 잠금 순서가 엇갈려 가끔 `deadlock detected`(40P01)로 진다(CI 에서 반복 관측). 본문 전체가 롤백되므로 **같은 본문을 처음부터 다시** 돌려도 안전하다 —
 * 교착에서만 최대 3번.
 */
async function inRolledBackTransaction(pool: Pool, run: (client: PoolClient) => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await run(client);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== '40P01' || attempt >= 3) throw error;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }
}

describe.skipIf(!AVAILABLE)('제한 롤 — 실제 권한 = 허용 목록 (ADR-0006)', () => {
  let owner: Pool;
  beforeAll(() => {
    owner = createPool(ownerUrl, { max: 2 });
  });
  afterAll(async () => {
    await owner.end();
  });

  it.each([APP_ROLE_NAME, ADMIN_ROLE, LOGIN_MAILER_ROLE, BILLING_ROLE, BILLING_OPERATOR_ROLE] as const)('① %s 의 실제 권한은 허용 목록과 정확히 같다 · ② 소유·멤버십·위험 속성 0', async (role) => {
    const report = await inspectRestrictedRole(owner, role);
    expect(report.exists).toBe(true);
    expect(report.grants).toEqual([...RESTRICTED_ROLE_GRANTS[role]].sort());
    expect(report.problems).toEqual([]);
  });

  it('틱 롤(ADR-0014 · #13 L4) — 허용 목록 그대로 · 연결 한도 1 · 다르면 위반(롤백)', async () => {
    const report = await inspectRestrictedRole(owner, DOMAIN_TICK_ROLE);
    expect(report.grants).toEqual([...RESTRICTED_ROLE_GRANTS[DOMAIN_TICK_ROLE]].sort());
    expect(report.problems).toEqual([]);
    await inRolledBackTransaction(owner, async (client) => {
      await client.query(`ALTER ROLE ${DOMAIN_TICK_ROLE} CONNECTION LIMIT -1`);
      expect((await inspectRestrictedRole(client, DOMAIN_TICK_ROLE)).problems).toEqual(['연결 한도: -1']);
    });
  });

  it('로그인 메일 롤은 결속·사용 시각·요청자 키를 읽지 못하고 링크를 만들 수 없다 — 허용 목록이 그렇게 생겼다', () => {
    const mailer = RESTRICTED_ROLE_GRANTS[LOGIN_MAILER_ROLE];
    for (const column of ['browser_binding', 'used_at', 'client_key']) expect(mailer).not.toContain(`owner_login_links.${column}:SELECT`);
    expect(mailer.filter((grant) => /:INSERT$|:DELETE$|:TRUNCATE$/.test(grant))).toEqual([]);
    expect(mailer.filter((grant) => grant.startsWith('owner_sessions') || grant.startsWith('owner_actions'))).toEqual([]);
    // admin 은 운영자 동결(abuse_freeze)을 바꾸지 못한다 — 소유자 정지(owner_paused)만.
    expect(RESTRICTED_ROLE_GRANTS[ADMIN_ROLE]).not.toContain('organizations.abuse_freeze:UPDATE');
    expect(RESTRICTED_ROLE_GRANTS[ADMIN_ROLE].filter((grant) => /:DELETE$|:TRUNCATE$|:TRIGGER$|:REFERENCES$/.test(grant))).toEqual([]);
  });

  it('③ 허용 목록 밖 권한 · 소유 · 멤버십을 만들면 위반으로 잡는다 (트랜잭션 안에서, 롤백)', async () => {
    await inRolledBackTransaction(owner, async (client) => {
      await client.query(`GRANT DELETE ON audit_logs TO ${ADMIN_ROLE}`);
      await client.query(`GRANT SELECT (browser_binding) ON owner_login_links TO ${LOGIN_MAILER_ROLE}`);
      await client.query(`CREATE TABLE restricted_role_probe (id int)`);
      await client.query(`ALTER TABLE restricted_role_probe OWNER TO ${ADMIN_ROLE}`);
      await client.query(`GRANT atmark_app TO ${LOGIN_MAILER_ROLE}`);
      const admin = await inspectRestrictedRole(client, ADMIN_ROLE);
      const mailer = await inspectRestrictedRole(client, LOGIN_MAILER_ROLE);
      expect(admin.problems).toEqual(expect.arrayContaining(['허용 목록 밖 권한 audit_logs:DELETE', '소유: relation restricted_role_probe']));
      expect(mailer.problems).toEqual(
        expect.arrayContaining(['허용 목록 밖 권한 owner_login_links.browser_binding:SELECT', '멤버십: atmark_app']),
      );
    });
  });

  it('④ migrate status: 깨끗하면 ok · 제한 롤의 여분 권한이나 앱 롤의 로그인 테이블 권한이 생기면 ok=false (롤백)', async () => {
    await inRolledBackTransaction(owner, async (client) => {
      const clean = await statusOn(client);
      expect([
        clean.ok,
        clean.appLoginPrivileges,
        clean.appForbiddenColumnUpdates,
        clean.restrictedRoles.flatMap((report) => report.problems),
        clean.unsafeSecurityDefiners,
      ]).toEqual([true, [], [], [], []]);

      // H1 이 되살아나는 모양 — 앱 롤이 링크 id·만료를 다시 읽을 수 있게 된다.
      await client.query('GRANT SELECT (id, expires_at) ON owner_login_links TO atmark_app');
      const leaked = await statusOn(client);
      expect(leaked.ok).toBe(false);
      expect(leaked.appLoginPrivileges).toEqual(['owner_login_links:SELECT']);
      await client.query('REVOKE SELECT (id, expires_at) ON owner_login_links FROM atmark_app');

      // H1' 이 되살아나는 모양 — 앱 롤이 소유자 주소(로그인 메일 수신자)를 바꿀 수 있게 된다.
      await client.query('GRANT UPDATE (owner_email) ON organizations TO atmark_app');
      const hijack = await statusOn(client);
      expect(hijack.ok).toBe(false);
      expect(hijack.appForbiddenColumnUpdates).toEqual(['organizations.owner_email']);
      await client.query('REVOKE UPDATE (owner_email) ON organizations FROM atmark_app');
      // 테이블 단위 UPDATE(마이그레이션 4 의 옛 모양)면 금지 컬럼이 전부 보인다.
      await client.query('GRANT UPDATE ON organizations, agents TO atmark_app');
      const wide = await statusOn(client);
      expect(wide.appForbiddenColumnUpdates).toEqual([
        'agents.status',
        'agents.suspended_by',
        'organizations.abuse_freeze',
        // 과금 P0(ADR-0011) — 결제 상태(Stage 0 킬 스위치).
        'organizations.billing_status',
        'organizations.owner_email',
        'organizations.owner_paused',
        'organizations.review_status',
        'organizations.reviewed_at',
        'organizations.signup_source',
      ]);
      await client.query('REVOKE UPDATE ON organizations, agents FROM atmark_app');
      await client.query('GRANT UPDATE (sending_started_at) ON organizations TO atmark_app');

      // 과금 P0(ADR-0011) — 앱 롤이 요금제를 스스로 올릴 수 있게 되는 모양.
      await client.query('GRANT UPDATE (plan_code) ON org_entitlements TO atmark_app');
      const upgraded = await statusOn(client);
      expect(upgraded.ok).toBe(false);
      expect(upgraded.appForbiddenPrivileges).toContain('org_entitlements:UPDATE');
      await client.query('REVOKE UPDATE (plan_code) ON org_entitlements FROM atmark_app');

      // H2 가 되살아나는 모양 — admin 롤이 감사 테이블을 지울 수 있게 된다.
      await client.query(`GRANT DELETE ON owner_actions TO ${ADMIN_ROLE}`);
      const widened = await statusOn(client);
      expect(widened.ok).toBe(false);
      expect(widened.restrictedRoles.find((report) => report.role === ADMIN_ROLE)?.problems).toEqual(['허용 목록 밖 권한 owner_actions:DELETE']);
    });
  });

  it('⑥ 202609230750 이 거둔 앱 롤 권한 · 가드 · TEMP 가 되살아나면 status 가 이름으로 ok=false (롤백)', async () => {
    // 각 GRANT 는 검증자가 앱 롤로 해 보인 공격 하나에 대응한다(H-A · H-B). 기대값은 status 의 표기.
    const regrants: readonly (readonly [string, string])[] = [
      ['GRANT INSERT ON organizations TO atmark_app', 'organizations:INSERT'],
      ['GRANT INSERT ON agents TO atmark_app', 'agents:INSERT'],
      ['GRANT INSERT (agent_id, address, domain) ON agent_addresses TO atmark_app', 'agent_addresses:INSERT'],
      ['GRANT UPDATE (agent_id) ON agent_addresses TO atmark_app', 'agent_addresses:UPDATE'],
      ['GRANT INSERT ON agent_api_keys TO atmark_app', 'agent_api_keys:INSERT'],
      // 202609241400(US-007)이 `last_used_at` 만 열었다 — `revoked_at` UPDATE 는 여전히 이름 있는 금지 항목.
      ['GRANT UPDATE (revoked_at) ON agent_api_keys TO atmark_app', 'agent_api_keys.revoked_at:UPDATE'],
      ['GRANT INSERT ON agent_keypairs TO atmark_app', 'agent_keypairs:INSERT'],
      ['GRANT INSERT ON passports TO atmark_app', 'passports:INSERT'],
      ['GRANT INSERT ON agent_policies TO atmark_app', 'agent_policies:INSERT'],
      ['GRANT UPDATE (outbound_mode) ON agent_policies TO atmark_app', 'agent_policies:UPDATE'],
      ['GRANT INSERT ON policy_versions TO atmark_app', 'policy_versions:INSERT'],
      ['GRANT DELETE ON suppression_entries TO atmark_app', 'suppression_entries:DELETE'],
      ['GRANT INSERT ON approval_releases TO atmark_app', 'approval_releases:INSERT'],
      ['GRANT INSERT ON approval_notifications TO atmark_app', 'approval_notifications:INSERT'],
      ['GRANT INSERT (status) ON approval_requests TO atmark_app', 'approval_requests.status:INSERT'],
      ['GRANT UPDATE ON webhook_endpoints TO atmark_app', 'webhook_endpoints:UPDATE'],
    ];
    await inRolledBackTransaction(owner, async (client) => {
      for (const [grant, expected] of regrants) {
        await client.query('SAVEPOINT regrant');
        await client.query(grant);
        const status = await statusOn(client);
        expect([status.ok, status.appForbiddenPrivileges], grant).toEqual([false, [expected]]);
        // 허용 목록(앱 롤)도 같은 권한을 넘침으로 본다 — 이름 없는 새 권한도 여기서 걸린다.
        expect(status.restrictedRoles.find((report) => report.role === APP_ROLE_NAME)?.problems.length, grant).toBeGreaterThan(0);
        await client.query('ROLLBACK TO SAVEPOINT regrant');
      }
      // 목록에 이름이 없는 넘침(예: audit_logs 의 가변 밖 컬럼 UPDATE)도 허용 목록이 잡는다.
      await client.query('SAVEPOINT extra');
      await client.query('GRANT UPDATE (reasons) ON audit_logs TO atmark_app');
      const extra = await statusOn(client);
      expect(extra.ok).toBe(false);
      expect(extra.restrictedRoles.find((report) => report.role === APP_ROLE_NAME)?.problems).toEqual(['허용 목록 밖 권한 audit_logs.reasons:UPDATE']);
      await client.query('ROLLBACK TO SAVEPOINT extra');

      // 가드: 지우거나 끄면 빠진 것으로 보인다.
      await client.query('SAVEPOINT guards');
      await client.query('DROP TRIGGER agent_api_keys_revoked_once ON agent_api_keys');
      await client.query('ALTER TABLE sender_relationships DISABLE TRIGGER sender_relationships_insert_guard');
      await client.query('ALTER TABLE agent_addresses DROP CONSTRAINT agent_addresses_not_reserved_local_part');
      const unguarded = await statusOn(client);
      expect([unguarded.ok, unguarded.missingGuards]).toEqual([
        false,
        [
          'trigger:agent_api_keys.agent_api_keys_revoked_once',
          'trigger:sender_relationships.sender_relationships_insert_guard',
          'constraint:agent_addresses.agent_addresses_not_reserved_local_part',
        ],
      ]);
      await client.query('ROLLBACK TO SAVEPOINT guards');

      // 발신 스니펫 보존 가드(202609241700, 검증 F3) — 끄면 앱 롤의 `snippet` UPDATE 가 위조·조기 삭제가 된다.
      await client.query('SAVEPOINT snippet_guard');
      await client.query('ALTER TABLE messages DISABLE TRIGGER messages_snippet_retention_only');
      const snippetUnguarded = await statusOn(client);
      expect([snippetUnguarded.ok, snippetUnguarded.missingGuards]).toEqual([false, ['trigger:messages.messages_snippet_retention_only']]);
      await client.query('ROLLBACK TO SAVEPOINT snippet_guard');

      // L-D: PUBLIC 에 TEMP 가 돌아오면 세 롤 전부 보인다.
      const database = (await client.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name ?? '';
      await client.query(`GRANT TEMPORARY ON DATABASE ${client.escapeIdentifier(database)} TO PUBLIC`);
      const temp = await statusOn(client);
      expect([temp.ok, temp.databaseTempRoles]).toEqual([
        false,
        [
          'atmark_admin',
          // AI 의심 메일 감시 결과 λ 롤(202610061100, ADR-0017 초안).
          'atmark_ai_watch',
          'atmark_app',
          'atmark_billing',
          'atmark_billing_operator',
          // 고객 도메인 확인 틱 롤(202609291100, ADR-0014).
          'atmark_domain_tick',
          'atmark_login_mailer',
          // 호스팅 운영자 콘솔 롤(202609290500).
          'atmark_ops',
          'atmark_passport_signer',
          'atmark_tlog',
          'atmark_tlog_anchor',
        ],
      ]);
    });
  }, 30_000); // status 를 열 번 넘게 부른다 — 단독 ~1.2s, 전체 병렬 실행(커버리지)에서는 기본 5초를 넘긴다.

  it('⑤-2 보안 M2 심층 방어 — GRANT 가 실수로 되살아나도 admin 롤의 웹훅 두 표 직접 쓰기는 가드 트리거가 막는다(롤백되는 트랜잭션)', async () => {
    await inRolledBackTransaction(owner, async (client) => {
      await client.query('GRANT INSERT ON webhook_deliveries, webhook_endpoints TO atmark_admin');
      await client.query('SET LOCAL ROLE atmark_admin');
      await client.query('SAVEPOINT a');
      await expect(
        client.query(`INSERT INTO webhook_deliveries (event_id, endpoint_id, event_type, dedupe_key, body, next_attempt_at)
                      VALUES (gen_random_uuid(), gen_random_uuid(), 'message.sent', 'x', '{}', now())`),
      ).rejects.toThrow(/written only through its definer functions/);
      await client.query('ROLLBACK TO SAVEPOINT a');
      await expect(
        client.query(`INSERT INTO webhook_endpoints (agent_id, url, secret_kid) VALUES (repeat('a', 32), 'https://x.example.com/', 'w1')`),
      ).rejects.toThrow(/written only through its definer functions/);
    });
  });

  it('⑤-3 앱 롤은 경로 console 로 등록·회전을 꾸미지 못하고 콘솔 감사 상세·회전 원장에 권한이 없다', async () => {
    const app = createPool(process.env['TEST_DATABASE_URL'] ?? '', { max: 1 });
    try {
      await expect(app.query(`SELECT register_webhook_endpoint(repeat('a', 32), 'https://x.example.com/', 'w1', NULL, 'console')`)).rejects.toThrow(
        /does not match the calling role/,
      );
      await expect(app.query(`SELECT * FROM rotate_webhook_endpoint_secret(repeat('a', 32), gen_random_uuid(), 'w1', 'console')`)).rejects.toThrow(
        /does not match the calling role/,
      );
      await expect(app.query('SELECT 1 FROM webhook_owner_action_details LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(app.query('SELECT 1 FROM webhook_secret_rotations LIMIT 1')).rejects.toThrow(/permission denied/);
      // 재검토 L-1 — 발급 원장은 정의자 함수만 쓴다(앱 롤 읽기·쓰기 0).
      await expect(app.query('SELECT 1 FROM webhook_console_secret_issues LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(
        app.query(`INSERT INTO webhook_console_secret_issues (endpoint_id, version) VALUES (gen_random_uuid(), 1)`),
      ).rejects.toThrow(/permission denied/);
      // 비공허: 발급 확인 함수는 부를 수 있다(없는 행 → 0행).
      expect((await app.query(`SELECT * FROM console_webhook_secret_ref(repeat('a', 32), gen_random_uuid())`)).rows).toEqual([]);
    } finally {
      await app.end();
    }
  });

  it('⑤ admin 롤은 DDL·재부여·동결 해제·감사 삭제를 못 한다 (소유자 롤이 아니다)', async () => {
    const admin = createPool(ADMIN_ROLE_URL, { max: 1 });
    try {
      for (const sql of [
        'DROP TRIGGER owner_actions_no_delete ON owner_actions',
        'ALTER TABLE owner_actions DISABLE TRIGGER USER',
        'DROP TRIGGER audit_logs_no_delete ON audit_logs',
        `CREATE TABLE admin_probe (id int)`,
      ]) {
        await expect(admin.query(sql), sql).rejects.toThrow(/must be owner|permission denied/);
      }
      // 재부여: GRANT OPTION 이 없으면 Postgres 는 경고만 내고 아무것도 주지 않는다 — 결과(권한 없음)로 본다.
      await admin.query('GRANT SELECT ON owner_sessions TO atmark_app').catch(() => undefined);
      const regranted = await owner.query<{ can: boolean }>(`SELECT has_table_privilege('atmark_app', 'owner_sessions', 'SELECT') AS can`);
      expect(regranted.rows[0]?.can).toBe(false);
      await expect(admin.query('UPDATE organizations SET abuse_freeze = false WHERE false')).rejects.toThrow(/permission denied/);
      await expect(admin.query('DELETE FROM owner_actions WHERE false')).rejects.toThrow(/permission denied/);
      // 202609241100(콘솔 로그 API)부터 감사 두 표는 **보여 줄 칸만** 읽는다 — 세션 id·추적 id·승인자 칸은 여전히 못 읽는다.
      await expect(admin.query('SELECT session_id FROM owner_actions LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(admin.query('SELECT * FROM owner_actions LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(admin.query('SELECT trace_id, approved_by FROM audit_logs LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(admin.query('SELECT * FROM audit_logs LIMIT 1')).rejects.toThrow(/permission denied/);
      // 콘솔 웹훅 화면(202609301410)부터 웹훅 두 표는 읽고 칸 단위 INSERT 만 한다 — 표 UPDATE·DELETE 와 회전 원장은 여전히 0(회전·삭제는 정의자 함수).
      await expect(admin.query('UPDATE webhook_endpoints SET secret_version = secret_version WHERE false')).rejects.toThrow(/permission denied/);
      await expect(admin.query('DELETE FROM webhook_endpoints WHERE false')).rejects.toThrow(/permission denied/);
      await expect(admin.query('UPDATE webhook_deliveries SET status = status WHERE false')).rejects.toThrow(/permission denied/);
      await expect(admin.query('SELECT 1 FROM webhook_secret_rotations LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(admin.query('SELECT 1 FROM webhook_console_secret_issues LIMIT 1')).rejects.toThrow(/permission denied/);
      // 재검토 L-3 — 전달 표는 `body` 를 뺀 칸만 읽는다(비공허: 목록 칸은 읽힌다).
      await expect(admin.query('SELECT body FROM webhook_deliveries LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(admin.query('SELECT * FROM webhook_deliveries LIMIT 1')).rejects.toThrow(/permission denied/);
      await admin.query('SELECT id, event_id, status, last_attempt_at, redelivery_of FROM webhook_deliveries LIMIT 1');
      // 보안 M2 — admin 은 두 웹훅 표에 직접 INSERT 할 수 없다(정의자 함수만) · 콘솔 시크릿 발급 확인 함수는 api λ(앱 롤) 몫이다(보안 M1).
      await expect(
        admin.query(`INSERT INTO webhook_deliveries (event_id, endpoint_id, event_type, dedupe_key, body, next_attempt_at)
                     VALUES (gen_random_uuid(), gen_random_uuid(), 'message.sent', 'x', '{}', now())`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        admin.query(`INSERT INTO webhook_endpoints (agent_id, url, secret_kid) VALUES (repeat('a', 32), 'https://x.example.com/', 'w1')`),
      ).rejects.toThrow(/permission denied/);
      await expect(admin.query(`SELECT * FROM console_webhook_secret_ref(repeat('a', 32), gen_random_uuid())`)).rejects.toThrow(/permission denied/);
      // 경로 이름은 호출 롤과 맞아야 한다 — admin 은 'api' 로 등록·회전을 꾸미지 못한다.
      await expect(
        admin.query(`SELECT register_webhook_endpoint(repeat('a', 32), 'https://x.example.com/', 'w1', NULL, 'api')`),
      ).rejects.toThrow(/does not match the calling role/);
      await expect(
        admin.query(`SELECT * FROM rotate_webhook_endpoint_secret(repeat('a', 32), gen_random_uuid(), 'w1', 'api')`),
      ).rejects.toThrow(/does not match the calling role/);
      // 비공허: 허용된 읽기는 된다.
      await expect(admin.query('SELECT count(*) FROM organizations')).resolves.toBeDefined();
    } finally {
      await admin.end();
    }
  });
});

describe.skipIf(!AVAILABLE)('셀프 가입(202609240800) — migrate status 가 가입 표면의 권한 경계를 본다', () => {
  let owner: Pool;
  beforeAll(() => {
    owner = createPool(ownerUrl, { max: 2 });
  });
  afterAll(async () => {
    await owner.end();
  });

  it('앱 롤은 가입 테이블 권한 0 · 가입 함수 실행 불가 — 되살아나면 status 가 이름으로 ok=false (롤백)', async () => {
    const has = await owner.query<{ links: boolean; requests: boolean; create: boolean; suppressed: boolean }>(
      `SELECT has_any_column_privilege('atmark_app', 'signup_links', 'SELECT') OR has_table_privilege('atmark_app', 'signup_links', 'INSERT') AS links,
              has_table_privilege('atmark_app', 'signup_requests', 'SELECT') OR has_table_privilege('atmark_app', 'signup_requests', 'INSERT') AS requests,
              has_function_privilege('atmark_app', 'create_signup_organization(uuid, text, timestamptz)', 'EXECUTE') AS create,
              has_function_privilege('atmark_app', 'signup_email_suppressed(text)', 'EXECUTE') AS suppressed`,
    );
    expect(has.rows[0]).toEqual({ links: false, requests: false, create: false, suppressed: false });

    await inRolledBackTransaction(owner, async (client) => {
      await client.query('SAVEPOINT s');
      await client.query('GRANT SELECT (id, expires_at) ON signup_links TO atmark_app');
      const leaked = await statusOn(client);
      expect([leaked.ok, leaked.appLoginPrivileges]).toEqual([false, ['signup_links:SELECT']]);
      await client.query('ROLLBACK TO SAVEPOINT s');

      // EXECUTE 를 PUBLIC 에 돌려주면(= 앱 롤이 조직을 만든다) 이름으로 보인다.
      await client.query('GRANT EXECUTE ON FUNCTION create_signup_organization(uuid, text, timestamptz) TO PUBLIC');
      const opened = await statusOn(client);
      expect([opened.ok, opened.unsafeSecurityDefiners]).toEqual([false, ['create_signup_organization:public_execute']]);
      await client.query('ROLLBACK TO SAVEPOINT s');

      // search_path 고정을 풀면 이름으로 보인다.
      await client.query('ALTER FUNCTION create_signup_organization(uuid, text, timestamptz) RESET search_path');
      const unpinned = await statusOn(client);
      expect([unpinned.ok, unpinned.unsafeSecurityDefiners]).toEqual([false, ['create_signup_organization:search_path']]);
      await client.query('ROLLBACK TO SAVEPOINT s');

      // 고정했어도 pg_temp 가 마지막이 아니면(빠졌거나 앞에 있으면) 이름으로 보인다(적대적 검토 L1).
      for (const path of ['pg_catalog, public', 'pg_temp, pg_catalog, public', 'pg_catalog, pg_temp, public']) {
        await client.query(`ALTER FUNCTION create_signup_organization(uuid, text, timestamptz) SET search_path = ${path}`);
        const loose = await statusOn(client);
        expect([path, loose.ok, loose.unsafeSecurityDefiners]).toEqual([path, false, ['create_signup_organization:search_path']]);
        await client.query('ROLLBACK TO SAVEPOINT s');
      }
      // 지금의 모든 SECURITY DEFINER 함수는 통과한다(202609250240 이 기존 것을 맞췄다).
      const clean = await statusOn(client);
      expect(clean.unsafeSecurityDefiners).toEqual([]);

      // 앱 롤이 검토 상태를 바꿀 수 있게 되면 이름으로 보인다.
      await client.query('GRANT UPDATE (review_status) ON organizations TO atmark_app');
      const review = await statusOn(client);
      expect([review.ok, review.appForbiddenColumnUpdates]).toEqual([false, ['organizations.review_status']]);
      await client.query('ROLLBACK TO SAVEPOINT s');

      // 가드가 꺼지면 이름으로 보인다.
      await client.query('ALTER TABLE organizations DISABLE TRIGGER organizations_review_guard');
      await client.query('ALTER TABLE approval_requests DISABLE TRIGGER approval_requests_reject_approve_while_unreviewed');
      const unguarded = await statusOn(client);
      expect([unguarded.ok, unguarded.missingGuards]).toEqual([
        false,
        ['trigger:organizations.organizations_review_guard', 'trigger:approval_requests.approval_requests_reject_approve_while_unreviewed'],
      ]);
    });
  });

  it('가입 함수: SECURITY DEFINER · search_path 고정 · PUBLIC 실행 불가 · EXECUTE 는 admin 만(억제 함수는 login-mailer 만)', async () => {
    const functions = await owner.query<{ name: string; definer: boolean; config: string[] | null; public_exec: boolean; admin: boolean; mailer: boolean; app: boolean }>(
      `SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('atmark_admin', p.oid, 'EXECUTE') AS admin,
              has_function_privilege('atmark_login_mailer', p.oid, 'EXECUTE') AS mailer,
              has_function_privilege('atmark_app', p.oid, 'EXECUTE') AS app
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('create_signup_organization', 'signup_email_suppressed') ORDER BY 1`,
    );
    expect(functions.rows).toEqual([
      // pg_temp 를 **마지막**에 적는다(적대적 검토 L1, 202609250240) — 적지 않으면 pg_temp 가 암묵으로 맨 앞이다.
      { name: 'create_signup_organization', definer: true, config: ['search_path=pg_catalog, public, pg_temp'], public_exec: false, admin: true, mailer: false, app: false },
      { name: 'signup_email_suppressed', definer: true, config: ['search_path=pg_catalog, public, pg_temp'], public_exec: false, admin: false, mailer: true, app: false },
    ]);
  });
});

describe.skipIf(!AVAILABLE)('결제 롤(202609250400, WP-2) — migrate status 가 두 롤 · 새 표 · 가드를 본다', () => {
  let owner: Pool;
  beforeAll(() => {
    owner = createPool(ownerUrl, { max: 2 });
  });
  afterAll(async () => {
    await owner.end();
  });

  it('깨끗하면 두 롤 위반 0 · 결제 정보 칸이 있다 — 허용 목록 밖 권한 · 앱 롤의 새 표 권한 · 꺼진 가드는 이름으로 ok=false (롤백)', async () => {
    await inRolledBackTransaction(owner, async (client) => {
      // **DDL 블록마다 SAVEPOINT … ROLLBACK TO** (코드 리뷰 M10 가설 B). ALTER TABLE 의 잠금(DISABLE TRIGGER = SHARE ROW EXCLUSIVE,
      //   DROP CONSTRAINT = ACCESS EXCLUSIVE)은 다시 ENABLE 해도 풀리지 않고 트랜잭션 끝까지 남는다 — 이 테스트가 도는 내내 병렬 파일의 결제
      //   쓰기(reconcile·sync·grantPlan)가 그 뒤에 줄을 서다 statement_timeout(57014)에 걸린다. ROLLBACK TO SAVEPOINT 는 그 뒤에 잡은 잠금을
      //   바로 푼다. 블록의 판정은 되돌리기 **전에** 읽는다.
      const clean = await statusOn(client);
      expect(clean.ok).toBe(true);
      for (const role of [BILLING_ROLE, BILLING_OPERATOR_ROLE]) {
        expect(clean.restrictedRoles.find((report) => report.role === role)).toMatchObject({ exists: true, problems: [] });
      }
      expect(clean.billing).toMatchObject({ pendingEvents: expect.any(Number), failedEvents: expect.any(Number), openCheckouts: expect.any(Number) });

      // 동기화 롤이 감사 원장을 읽게 되면 — 감사 짝 검사를 우회할 재료가 생긴다.
      await client.query('GRANT SELECT ON billing_audit TO atmark_billing');
      const audit = await statusOn(client);
      expect(audit.ok).toBe(false);
      expect(audit.restrictedRoles.find((report) => report.role === BILLING_ROLE)?.problems).toEqual(['허용 목록 밖 권한 billing_audit:SELECT']);
      await client.query('REVOKE SELECT ON billing_audit FROM atmark_billing');

      // 운영자 롤이 이벤트 원장을 쓰게 되면.
      await client.query('GRANT UPDATE (status) ON billing_events TO atmark_billing_operator');
      const operator = await statusOn(client);
      expect(operator.restrictedRoles.find((report) => report.role === BILLING_OPERATOR_ROLE)?.problems).toEqual([
        '허용 목록 밖 권한 billing_events.status:UPDATE',
      ]);
      await client.query('REVOKE UPDATE (status) ON billing_events FROM atmark_billing_operator');

      // 앱 롤이 새 표를 읽게 되면 — 전 조직의 공급자 고객.
      await client.query('GRANT SELECT ON billing_customers TO atmark_app');
      const app = await statusOn(client);
      expect(app.ok).toBe(false);
      expect(app.appLoginPrivileges).toEqual(['billing_customers:SELECT']);
      await client.query('REVOKE SELECT ON billing_customers FROM atmark_app');

      // 출처-롤 가드가 꺼지면.
      await client.query('SAVEPOINT guard_trigger');
      // 아래 DDL(트리거 끄기)은 org_entitlements → billing_audit 순으로 잠금을 올린다. 병렬 파일의 `grantPlan` 은 billing_audit →
      // org_entitlements 순으로 쓰므로 순서가 엇갈려 교착(40P01)한다 — 둘을 쓰는 쪽과 같은 순서로 **먼저** 한 번에 잡는다(savepoint 안 — 함께 풀린다).
      await client.query('LOCK TABLE billing_audit, org_entitlements IN SHARE ROW EXCLUSIVE MODE');
      await client.query('ALTER TABLE org_entitlements DISABLE TRIGGER org_entitlements_source_by_role');
      const unguarded = await statusOn(client);
      await client.query('ROLLBACK TO SAVEPOINT guard_trigger');
      expect(unguarded.ok).toBe(false);
      expect(unguarded.missingGuards).toEqual(['trigger:org_entitlements.org_entitlements_source_by_role']);

      // CHECK 가 아닌 가드(L-3) — 결속 FK · 거래 결속 키 · 고객 키가 사라지거나 감사 행위자 트리거가 꺼지면 이름으로 잡는다.
      await client.query('SAVEPOINT guard_keys');
      await client.query('ALTER TABLE billing_subscriptions DROP CONSTRAINT billing_subscriptions_origin_checkout');
      await client.query('ALTER TABLE billing_checkouts DROP CONSTRAINT billing_checkouts_binding_key');
      await client.query('ALTER TABLE billing_customers DROP CONSTRAINT billing_customers_pkey');
      await client.query('ALTER TABLE billing_audit DISABLE TRIGGER billing_audit_actor_by_role');
      await client.query('ALTER TABLE billing_reconcile_state DISABLE TRIGGER billing_reconcile_state_no_truncate');
      const keys = await statusOn(client);
      await client.query('ROLLBACK TO SAVEPOINT guard_keys');
      expect(keys.ok).toBe(false);
      expect([...keys.missingGuards].sort()).toEqual(
        [
          'constraint:billing_checkouts.billing_checkouts_binding_key',
          'constraint:billing_customers.billing_customers_pkey',
          'constraint:billing_subscriptions.billing_subscriptions_origin_checkout',
          'trigger:billing_audit.billing_audit_actor_by_role',
          'trigger:billing_reconcile_state.billing_reconcile_state_no_truncate',
        ].sort(),
      );
    });
  });
});
