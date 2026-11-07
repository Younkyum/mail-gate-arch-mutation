/**
 * 운영 런타임의 DB 쪽 단언 — **실제 Postgres** 위에서.
 *
 *   - `/healthz` 프로브: 앱 롤로 붙으면 database·appRole·appRoleNotOwner 는 참이다. **로컬 Postgres 는 TLS 가 아니므로
 *     `tls=false` → `ok=false`** — 즉 이 프로브는 평문 연결을 초록으로 보고하지 않는다(운영에서의 fail-closed).
 *     소유자 롤로 붙으면 appRole·appRoleNotOwner 가 거짓이다.
 *   - migrate 핸들러: 소유자 롤 풀로 `migrate` 를 돌리고 적용/기존 수를 돌려준다 · 풀을 닫는다 · `Delete` 는 DB 를 안 건드린다
 *     · `status` 는 읽기만 · 모르는 action 은 던진다.
 *   - ★ 롤 부트스트랩: **슈퍼유저가 아닌 CREATEROLE·CREATEDB 롤(= RDS 마스터의 모양)** 로 소유자 롤을 만들고 DB 소유권을
 *     넘긴다(PG16+ 의 SET 권한 절차까지) — 트랜잭션 안에서, 롤백.
 *   - ★ SCRAM 검증자: Postgres 가 같은 비밀번호·솔트로 만든 `rolpassword` 와 바이트 단위로 같다.
 *   - ★ `verifyAppRoleIsNotOwner`: 앱 롤을 소유자 롤의 **멤버**로 만들면(트랜잭션 안에서, 롤백) 던진다 — 마이그레이션 4 의
 *     "소유자 ≠ atmark_app" 단언이 못 보는 구멍이다.
 *
 * `TEST_DATABASE_URL` / `TEST_MIGRATION_DATABASE_URL` 이 없으면 건너뛴다.
 */

import { readdirSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { createPool } from '../../../src/db/client';
import { MIGRATIONS_DIR } from '../../../src/db/migrate';
import type { RoleBootstrapDependencies } from '../../../src/runtime/composition';
import {
  AppRoleOwnershipError,
  createMigrateHandler,
  MIGRATION_RESOURCE_ID,
  verifyAppRoleIsNotOwner,
  type MigrateResult,
  type MigrationStatus,
  type RoleBootstrapResult,
} from '../../../src/runtime/handlers/migrate';
import { bootstrapRoles, OWNER_ROLE, scramSha256Verifier } from '../../../src/runtime/role-bootstrap';
import { createHealthProbe } from '../../../src/runtime/health';
import { closeTestPool, DATABASE_AVAILABLE, testPool } from '../db/support/harness';
import { context } from './support';

const ownerUrl = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';

/** 제한 롤 둘(ADR-0006)은 로컬에 이미 있고 비밀이 채워진 것으로 본다 — 이 테스트의 관심은 소유자 롤이다. */
const RESTRICTED_FILLED = {
  admin: { secretFilled: true },
  billing: { secretFilled: true },
  billingOperator: { secretFilled: true },
  loginMailer: { secretFilled: true },
  passportSigner: { secretFilled: true },
  tlog: { secretFilled: true },
  tlogAnchor: { secretFilled: true },
  ops: { secretFilled: true },
  domainTick: { secretFilled: true },
  aiWatch: { secretFilled: true },
} as const;
const OWNER_AVAILABLE = DATABASE_AVAILABLE && ownerUrl.trim() !== '';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

describe.skipIf(!DATABASE_AVAILABLE)('/healthz 프로브 — 실제 DB', () => {
  it('앱 롤 · 평문 연결 → database·appRole·appRoleNotOwner 참, tls 거짓 → ok=false (평문을 초록으로 보고하지 않는다)', async () => {
    const report = await createHealthProbe(testPool()).check();
    expect(report.checks).toEqual({ database: true, tls: false, appRole: true, appRoleNotOwner: true });
    expect(report.ok).toBe(false);
  });

  it.skipIf(!OWNER_AVAILABLE)('소유자 롤로 붙으면 appRole·appRoleNotOwner 가 거짓이다', async () => {
    const pool = createPool(ownerUrl, { max: 1 });
    try {
      const report = await createHealthProbe(pool).check();
      expect(report.checks.database).toBe(true);
      expect(report.checks.appRole).toBe(false);
      expect(report.checks.appRoleNotOwner).toBe(false);
      expect(report.ok).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it('DB 에 닿지 못하면 ok=false 이고 던지지 않는다', async () => {
    const pool = createPool('postgres://atmark_app:x@127.0.0.1:1/atmark', { max: 1, connectionTimeoutMillis: 1000 });
    pool.on('error', () => undefined);
    try {
      const report = await createHealthProbe(pool).check();
      expect(report).toEqual({ ok: false, checks: { database: false, tls: false, appRole: false, appRoleNotOwner: false } });
    } finally {
      await pool.end();
    }
  });
});

/** 부트스트랩 조립은 이 절에서 부르지 않는다 — 부르면 실패. */
const NO_BOOTSTRAP = (): Promise<never> => Promise.reject(new Error('bootstrap 조립이 불리면 안 된다'));

function ownerHandler(pool = createPool(ownerUrl, { max: 1 })) {
  return { pool, handler: createMigrateHandler({ owner: () => Promise.resolve({ deps: null, pool }), bootstrap: NO_BOOTSTRAP }) };
}

describe.skipIf(!OWNER_AVAILABLE)('migrate 핸들러 — 소유자 롤', () => {
  it('적용/기존 수를 돌려주고, 끝나면 풀을 닫는다', async () => {
    const { pool, handler } = ownerHandler();
    const ctx = context();
    const result = (await handler({ action: 'migrate' }, ctx)) as MigrateResult;
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'));
    expect(result.PhysicalResourceId).toBe(MIGRATION_RESOURCE_ID);
    expect(result.Data.applied + result.Data.alreadyApplied).toBe(files.length);
    expect(result.appliedFiles).toHaveLength(result.Data.applied);
    expect(pool.ended).toBe(true);
    expect(ctx.callbackWaitsForEmptyEventLoop).toBe(false);
  });

  it('커스텀 리소스 Delete 는 DB 를 건드리지 않는다(조립도 하지 않는다)', async () => {
    let composed = false;
    const handler = createMigrateHandler({
      owner: () => {
        composed = true;
        return Promise.reject(new Error('조립되면 안 된다'));
      },
      bootstrap: NO_BOOTSTRAP,
    });
    const result = await handler({ RequestType: 'Delete', PhysicalResourceId: 'keep-me' }, context());
    expect(result).toEqual({ PhysicalResourceId: 'keep-me', Data: { applied: 0, alreadyApplied: 0 }, appliedFiles: [] });
    expect(composed).toBe(false);
  });

  it('커스텀 리소스 Create 는 migrate 다(부트스트랩이 아니다)', async () => {
    const { handler } = ownerHandler();
    const result = (await handler({ RequestType: 'Create' }, context())) as MigrateResult;
    expect(result.PhysicalResourceId).toBe(MIGRATION_RESOURCE_ID);
  });

  it('status — 미적용 0 · 앱 롤 검사 통과 · 앱 롤은 sender_marks 에 INSERT 할 수 없다', async () => {
    const { pool, handler } = ownerHandler();
    const status = (await handler({ action: 'status' }, context())) as MigrationStatus;
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'));
    expect(status).toMatchObject({
      action: 'status',
      ok: true,
      migrationFiles: files.length,
      pending: [],
      appRoleOk: true,
      appCanInsertSenderMarks: false,
      appLoginPrivileges: [],
      appForbiddenColumnUpdates: [],
      appForbiddenPrivileges: [],
      missingGuards: [],
      databaseTempRoles: [],
    });
    // 제한 롤 셋(앱 롤 포함, 202609230750) — 있고, 위반 0(허용 목록 밖 권한·소유·멤버십·위험 속성 없음).
    expect(status.restrictedRoles.map((report) => [report.role, report.exists, report.problems])).toEqual([
      ['atmark_app', true, []],
      ['atmark_admin', true, []],
      ['atmark_login_mailer', true, []],
      ['atmark_passport_signer', true, []],
      // 투명성 로그 롤 둘(202609241600, ADR-0008).
      ['atmark_tlog', true, []],
      ['atmark_tlog_anchor', true, []],
      // 결제 롤 둘(202609250400, ADR-0012).
      ['atmark_billing', true, []],
      ['atmark_billing_operator', true, []],
      // 호스팅 운영자 콘솔(202609290500, `.omc/plans/ops-console.md` §3.2).
      ['atmark_ops', true, []],
      // 고객 도메인 확인 틱(202609291100, ADR-0014 · 보안 M2) — 단계 0 NOLOGIN, 단계 2 부터 비밀 계획(LOGIN). 권한 허용 목록은 같다.
      ['atmark_domain_tick', true, []],
      // AI 의심 메일 감시 결과 λ 롤(202610061100, ADR-0017 초안) — 정의 함수 셋 EXECUTE 만 · 연결 한도 2.
      ['atmark_ai_watch', true, []],
    ]);
    // 운영자 콘솔 검사 1~6 은 ok 에 들어간다(7 은 경고).
    expect(status.ops).toMatchObject({
      opsRoleWrites: [],
      foreignOpsTablePrivileges: [],
      functionProblems: [],
      roleConfigProblems: [],
      hardLockedButCanLogin: false,
      betaSwitchMismatch: false,
    });
    expect(pool.ended).toBe(true);
  });

  it('모르는 action 은 던진다 — 기본 동작(migrate)으로 흘러가지 않는다', async () => {
    const { pool, handler } = ownerHandler();
    await expect(handler({ action: 'migrat' }, context())).rejects.toThrow(/알 수 없는 action/);
    await pool.end();
  });

  it('로컬 앱 롤은 소유자가 아니다 — 검사가 통과한다', async () => {
    const pool = createPool(ownerUrl, { max: 1 });
    const client = await pool.connect();
    try {
      await expect(verifyAppRoleIsNotOwner(client)).resolves.toBeUndefined();
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('★ 앱 롤이 audit_logs 소유자 롤의 멤버가 되면 던진다 (트랜잭션 안에서, 롤백)', async () => {
    const pool = createPool(ownerUrl, { max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query<{ owner: string }>(
        `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'public.audit_logs'::regclass`,
      );
      const ownerRole = owner.rows[0]?.owner;
      expect(ownerRole).toBeDefined();
      await client.query(`GRANT "${String(ownerRole)}" TO atmark_app`);
      await expect(verifyAppRoleIsNotOwner(client)).rejects.toThrow(AppRoleOwnershipError);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      await pool.end();
    }
  });
});

describe.skipIf(!OWNER_AVAILABLE)('★ 롤 부트스트랩 — RDS 마스터 모양(슈퍼유저 아님)으로, 트랜잭션 안에서 롤백', () => {
  it('소유자 롤을 만들고 DB 소유권을 넘긴다 · 채워진 앱 롤은 건드리지 않는다 · 마스터에 소유자 멤버십이 남지 않는다', async () => {
    const pool = createPool(ownerUrl, { max: 1 });
    const client = await pool.connect();
    const master = `atmark_test_master_${String(process.pid)}`;
    try {
      await client.query('BEGIN');
      const database = (await client.query<{ db: string }>('SELECT current_database() AS db')).rows[0]?.db ?? '';
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [OWNER_ROLE]);
      expect(exists.rowCount).toBe(0); // 로컬에는 소유자 롤이 없다 — created 경로를 탄다
      // RDS 마스터: CREATEROLE·CREATEDB, 슈퍼유저 아님, DB 소유자.
      await client.query(`CREATE ROLE ${master} NOSUPERUSER CREATEROLE CREATEDB`);
      await client.query(`ALTER DATABASE ${client.escapeIdentifier(database)} OWNER TO ${master}`);
      await client.query(`SET ROLE ${master}`);

      const result = await bootstrapRoles(client, database, { owner: { secretFilled: false }, app: { secretFilled: true }, ...RESTRICTED_FILLED });
      expect(result.owner.action).toBe('created');
      expect(result.owner.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.app).toEqual({ action: 'unchanged', password: null });
      expect(result.admin).toEqual({ action: 'unchanged', password: null });
      expect(result.loginMailer).toEqual({ action: 'unchanged', password: null });
      expect(result.passportSigner).toEqual({ action: 'unchanged', password: null });

      await client.query('RESET ROLE');
      const owner = await client.query<{ owner: string }>('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [database]);
      expect(owner.rows[0]?.owner).toBe(OWNER_ROLE);
      const role = await client.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolcanlogin: boolean; stored: string }>(
        `SELECT rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolpassword AS stored FROM pg_authid WHERE rolname = $1`,
        [OWNER_ROLE],
      );
      expect(role.rows[0]).toMatchObject({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true });
      expect(role.rows[0]?.stored.startsWith('SCRAM-SHA-256$4096:')).toBe(true);
      // 마스터가 소유자 권한을 상시로 쥐지 않는다(SET 은 거뒀다).
      const setRole = await client.query<{ can: boolean }>(`SELECT pg_has_role($1, $2, 'SET') AS can`, [master, OWNER_ROLE]);
      expect(setRole.rows[0]?.can).toBe(false);

      // 두 번째 호출(비밀이 여전히 비었다 = 비밀 쓰기가 실패했던 재시도) → 새 비밀번호로 다시 건다.
      await client.query(`SET ROLE ${master}`);
      const again = await bootstrapRoles(client, database, { owner: { secretFilled: false }, app: { secretFilled: true }, ...RESTRICTED_FILLED });
      expect(again.owner.action).toBe('password_set');
      expect(again.owner.password).not.toBe(result.owner.password);
      // 채워진 뒤의 호출은 아무것도 바꾸지 않는다.
      const settled = await bootstrapRoles(client, database, { owner: { secretFilled: true }, app: { secretFilled: true }, ...RESTRICTED_FILLED });
      expect(settled.owner.action).toBe('unchanged');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      await pool.end();
    }
  });

  it('핸들러: 커밋 뒤에 새 비밀번호를 가진 롤의 비밀만 쓴다(비밀번호는 결과에 없다)', async () => {
    // DB 쪽은 가짜 클라이언트 — 핸들러의 순서(BEGIN → 부트스트랩 → COMMIT → 비밀 쓰기)만 본다.
    const statements: string[] = [];
    const createdRoles: string[] = [];
    const writes: { id: string; value: string }[] = [];
    const fakeClient = {
      query: (text: string, values: unknown[] = []) => {
        statements.push(text.split(' ').slice(0, 2).join(' '));
        if (text.startsWith('CREATE ROLE')) createdRoles.push(text);
        // 앱·로그인 메일 롤은 이미 있다(그리고 비밀이 채워져 있다 → unchanged). 소유자·admin 롤은 없다 → created.
        if (text.startsWith('SELECT 1 FROM pg_roles')) {
          return Promise.resolve({
            rowCount: ['atmark_app', 'atmark_login_mailer', 'atmark_passport_signer', 'atmark_tlog', 'atmark_tlog_anchor', 'atmark_billing'].includes(
              String(values[0]),
            )
              ? 1
              : 0,
            rows: [],
          });
        }
        if (text.startsWith('SELECT pg_get_userbyid')) return Promise.resolve({ rowCount: 1, rows: [{ owner: OWNER_ROLE }] });
        return Promise.resolve({ rowCount: 0, rows: [] });
      },
      escapeLiteral: (value: string) => `'${value}'`,
      escapeIdentifier: (value: string) => `"${value}"`,
      release: () => undefined,
    };
    const fakePool = { connect: () => Promise.resolve(fakeClient), end: () => Promise.resolve() };
    const deps: RoleBootstrapDependencies = {
      master: { host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_master' },
      ownerSecretArn: 'arn:owner',
      appSecretArn: 'arn:app',
      adminSecretArn: 'arn:admin',
      loginMailerSecretArn: 'arn:login-mailer',
      passportSignerSecretArn: 'arn:passport-signer',
      tlogSecretArn: 'arn:tlog',
      tlogAnchorSecretArn: 'arn:tlog-anchor',
      billingSecretArn: 'arn:billing',
      billingOperatorSecretArn: 'arn:billing-operator',
      opsSecretArn: 'arn:ops',
      domainTickSecretArn: 'arn:domain-tick',
      aiWatchSecretArn: 'arn:ai-watch',
      ownerFilled: false,
      appFilled: true,
      adminFilled: false,
      loginMailerFilled: true,
      passportSignerFilled: true,
      tlogFilled: true,
      tlogAnchorFilled: true,
      // 결제 롤(WP-2): 동기화 롤은 있고 채워졌다 → unchanged · 운영자 롤은 없다 → created, 비밀은 커밋 뒤에.
      billingFilled: true,
      billingOperatorFilled: false,
      // 운영자 콘솔 롤 — 없다 → created(연결 한도·타임아웃과 함께), 비밀은 커밋 뒤에.
      opsFilled: false,
      // 고객 도메인 틱 롤(ADR-0014 단계 2) — 비밀이 자리표시 → 다른 제한 롤처럼 created(LOGIN + 새 비밀번호), 비밀은 커밋 뒤에.
      domainTickFilled: false,
      // AI 감시 결과 λ 롤(ADR-0017 초안) — 비밀이 자리표시 → created(연결 한도 2), 비밀은 커밋 뒤에.
      aiWatchFilled: false,
      writer: {
        putSecretString: (id, value) => {
          statements.push(`PUT ${id}`);
          writes.push({ id, value });
          return Promise.resolve();
        },
      },
    };
    const handler = createMigrateHandler({
      owner: () => Promise.reject(new Error('owner 조립이 불리면 안 된다')),
      bootstrap: () => Promise.resolve({ deps, pool: fakePool as never }),
    });
    const result = (await handler({ action: 'bootstrap-roles' }, context())) as RoleBootstrapResult;
    expect(result).toEqual({
      action: 'bootstrap-roles',
      owner: 'created',
      app: 'unchanged',
      admin: 'created',
      loginMailer: 'unchanged',
      passportSigner: 'unchanged',
      tlog: 'unchanged',
      tlogAnchor: 'unchanged',
      billing: 'unchanged',
      billingOperator: 'created',
      ops: 'created',
      // 고객 도메인 틱 롤(ADR-0014 단계 2) — 비밀 계획을 따른다(가짜 클라이언트에는 롤이 없다 → created · 비밀 쓰기 있음).
      domainTick: 'created',
      aiWatch: 'created',
      databaseOwner: OWNER_ROLE,
      secretsWritten: ['arn:owner', 'arn:admin', 'arn:billing-operator', 'arn:ops', 'arn:domain-tick', 'arn:ai-watch'],
    });
    expect(JSON.stringify(result)).not.toMatch(/password/);
    expect(statements.indexOf('COMMIT')).toBeGreaterThan(-1);
    expect(statements.indexOf('PUT arn:owner')).toBeGreaterThan(statements.indexOf('COMMIT'));
    expect(statements.indexOf('PUT arn:admin')).toBeGreaterThan(statements.indexOf('COMMIT'));
    const written = JSON.parse(writes[0]?.value ?? '{}') as Record<string, unknown>;
    expect(written).toMatchObject({ engine: 'postgres', host: 'db.internal', port: 5432, dbname: 'atmark', username: OWNER_ROLE });
    expect(String(written['password'])).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const admin = JSON.parse(writes[1]?.value ?? '{}') as Record<string, unknown>;
    expect(admin).toMatchObject({ username: 'atmark_admin', host: 'db.internal' });
    expect(admin['password']).not.toBe(written['password']);
    expect(statements.indexOf('PUT arn:billing-operator')).toBeGreaterThan(statements.indexOf('COMMIT'));
    expect(JSON.parse(writes[2]?.value ?? '{}')).toMatchObject({ username: 'atmark_billing_operator', host: 'db.internal' });
    // 틱 롤(ADR-0014 단계 2) — 다른 제한 롤과 같은 모양(LOGIN · NOINHERIT · SCRAM), 비밀은 커밋 뒤에.
    expect(statements.indexOf('PUT arn:domain-tick')).toBeGreaterThan(statements.indexOf('COMMIT'));
    expect(JSON.parse(writes[4]?.value ?? '{}')).toMatchObject({ username: 'atmark_domain_tick', host: 'db.internal' });
    const tickCreate = createdRoles.find((statement) => statement.startsWith('CREATE ROLE "atmark_domain_tick"')) ?? '';
    expect(tickCreate).toMatch(/ LOGIN /);
    expect(tickCreate).toMatch(/ NOINHERIT /);
    expect(tickCreate).not.toMatch(/NOLOGIN/);
    // AI 감시 결과 λ 롤 — 같은 모양 + 연결 한도 2, 비밀은 커밋 뒤에.
    expect(statements.indexOf('PUT arn:ai-watch')).toBeGreaterThan(statements.indexOf('COMMIT'));
    expect(JSON.parse(writes[5]?.value ?? '{}')).toMatchObject({ username: 'atmark_ai_watch', host: 'db.internal' });
    const aiWatchCreate = createdRoles.find((statement) => statement.startsWith('CREATE ROLE "atmark_ai_watch"')) ?? '';
    expect(aiWatchCreate).toMatch(/ LOGIN /);
    expect(aiWatchCreate).toMatch(/ NOINHERIT CONNECTION LIMIT 2 /);
  });

  it('★ SCRAM 검증자는 Postgres 가 같은 비밀번호·솔트로 만든 것과 같다', async () => {
    const pool = createPool(ownerUrl, { max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL password_encryption = 'scram-sha-256'");
      const probe = `atmark_scram_probe_${String(process.pid)}`;
      await client.query(`CREATE ROLE ${probe} PASSWORD 'correct horse battery staple'`);
      const stored = (await client.query<{ p: string }>('SELECT rolpassword AS p FROM pg_authid WHERE rolname = $1', [probe])).rows[0]?.p ?? '';
      const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(stored);
      expect(match).not.toBeNull();
      const iterations = Number(match?.[1]);
      const salt = Buffer.from(match?.[2] ?? '', 'base64');
      expect(scramSha256Verifier('correct horse battery staple', salt, iterations)).toBe(stored);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      await pool.end();
    }
  });
});
