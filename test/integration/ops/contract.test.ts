/**
 * 운영자 콘솔 SQL **계약** — `src/ops/contract.ts` `OPS_SQL_FUNCTIONS` · `docs/contracts/ops-sql.md` ↔ 실제 `pg_proc`(`.omc/plans/ops-console.md` §4.0 · §7 계약).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 이름 → `pg_get_function_identity_arguments` 가 **정확히** 같다 · 반환형이 계약과 같다 · P2 함수는 아직 없다.
 *   - EXECUTE 받은 롤(소유자 제외)이 계약의 EXECUTE 칸과 **정확히** 같다(PUBLIC 0) · 코어·티켓·내부 함수는 소유자만.
 *   - `atmark_ops` 의 실제 권한 = `RESTRICTED_ROLE_GRANTS[atmark_ops]`(양방향 — ACL 정확히 일치).
 *   - 스위치·카탈로그·다이제스트·대상 참조가 TS 와 같다.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BETA_ON_ACTIVATION, LIMIT_COLUMNS, PLAN_CATALOG } from '../../../src/billing/plans';
import { OPS_SQL_FUNCTIONS, OPS_SQL_FUNCTIONS_P2 } from '../../../src/ops/contract';
import { OPS_FUNCTION_EXECUTORS } from '../../../src/runtime/handlers/migrate';
import { inspectRestrictedRole, OPS_ROLE, RESTRICTED_ROLE_GRANTS } from '../../../src/runtime/role-bootstrap';
import { opsCodeDigest, opsTargetRef } from '../../../src/security/login-code';
import { AVAILABLE, ownerPool } from './db-support';

/** 계약 표의 반환형(`pg_get_function_result`). */
const RESULTS: Readonly<Record<string, string>> = {
  ops_request_code: 'void',
  ops_login_verify: 'TABLE(outcome text, operator_id uuid, session_id uuid)',
  ops_session_touch: 'TABLE(operator_id uuid, session_id uuid, email text, expires_at timestamp with time zone)',
  ops_session_revoke: 'integer',
  ops_request_stepup: 'text',
  ops_stepup_verify: 'TABLE(outcome text, action text, target_ref text)',
  ops_decide_request: 'text',
  ops_revoke_operator: 'text',
  ops_record_failure: 'void',
  ops_org_activate: 'TABLE(from_status text, changed boolean, "grant" text, from_plan text, kept_plan text, version integer)',
  ops_org_reject: 'TABLE(from_status text, changed boolean, suspended text[], revoked_tokens integer)',
  ops_waitlist_invite: 'TABLE(entry_id uuid, from_status text, invite_expires_at timestamp with time zone)',
  ops_waitlist_invite_oldest: 'TABLE(entry_id uuid, invite_expires_at timestamp with time zone)',
  ops_waitlist_remove: 'text',
  ops_weekly_board: 'jsonb',
  ops_mailer_set_digest: 'text',
  ops_org_activate_core: 'TABLE(from_status text, changed boolean, "grant" text, from_plan text, kept_plan text, version integer)',
  ops_org_reject_core: 'TABLE(from_status text, changed boolean, suspended text[], revoked_tokens integer)',
  ops_activation_beta_enabled: 'boolean',
  ops_beta_catalog: 'bigint[]',
  purge_ops_login_records: 'integer',
  expire_ops_requests: 'integer',
  ops_operator_census: 'TABLE(active integer, pending integer, addresses_failing_today integer, addresses_locked integer)',
};

interface ProcRow {
  name: string;
  args: string;
  result: string;
  volatility: string;
  grantees: string[];
}

describe.skipIf(!AVAILABLE)('운영자 콘솔 SQL 계약(pg_proc)', () => {
  let owner: Pool;
  let procs: Map<string, ProcRow[]>;
  beforeAll(async () => {
    owner = ownerPool(2);
    const rows = await owner.query<ProcRow>(
      `SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS result,
              p.provolatile::text AS volatility,
              coalesce((SELECT array_agg((CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END) ORDER BY 1)
                          FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner), ARRAY[]::text[]) AS grantees
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND (p.proname LIKE 'ops\\_%' OR p.proname LIKE 'zz\\_ops\\_%' OR p.proname IN ('purge_ops_login_records', 'expire_ops_requests'))`,
    );
    procs = new Map();
    for (const row of rows.rows) procs.set(row.name, [...(procs.get(row.name) ?? []), row]);
  });
  afterAll(async () => {
    await owner.end();
  });

  it('계약의 P1 함수 — 이름 하나에 오버로드 하나 · identity args 와 반환형이 정확히 같다 · P2 함수는 없다', () => {
    for (const [name, args] of Object.entries(OPS_SQL_FUNCTIONS)) {
      const found = procs.get(name) ?? [];
      if ((OPS_SQL_FUNCTIONS_P2 as readonly string[]).includes(name)) {
        expect(found, name).toEqual([]);
        continue;
      }
      expect(found.map((row) => row.args), name).toEqual([args]);
      expect(found[0]?.result, name).toBe(RESULTS[name]);
    }
    expect(procs.get('ops_activation_beta_enabled')?.[0]?.volatility).toBe('i');
  });

  it('EXECUTE = 계약의 EXECUTE 칸 정확히(PUBLIC 0) · 나머지 ops 함수(코어 · 티켓 · 내부 · 트리거)는 소유자만', () => {
    for (const [name, rows] of procs) {
      const expected = [...(OPS_FUNCTION_EXECUTORS[name] ?? [])].sort();
      for (const row of rows) expect(row.grantees, name).toEqual(expected);
    }
    // 계약의 EXECUTE 칸과 migrate 의 허용 표가 같다(P1 함수).
    const contractExecutors: Readonly<Record<string, string>> = {
      ops_mailer_set_digest: 'atmark_login_mailer',
      purge_ops_login_records: 'atmark_app',
      expire_ops_requests: 'atmark_app',
      ops_operator_census: 'atmark_app',
    };
    for (const name of Object.keys(OPS_SQL_FUNCTIONS)) {
      if ((OPS_SQL_FUNCTIONS_P2 as readonly string[]).includes(name)) continue;
      const owners = name.endsWith('_core') || name === 'ops_activation_beta_enabled' || name === 'ops_beta_catalog';
      const expected = owners ? [] : [contractExecutors[name] ?? 'atmark_ops'];
      expect([...(OPS_FUNCTION_EXECUTORS[name] ?? [])], name).toEqual(expected);
    }
    for (const internal of ['ops_authorize', 'ops_ticket_allows', 'ops_session_resolve', 'ops_upsert_access_request', 'zz_ops_require_ticket']) {
      expect(procs.get(internal)?.[0]?.grantees, internal).toEqual([]);
    }
  });

  it('atmark_ops 의 실제 권한 = RESTRICTED_ROLE_GRANTS[atmark_ops] (양방향) · 소유·멤버십·위험 속성 0', async () => {
    const client = await owner.connect();
    try {
      const report = await inspectRestrictedRole(client, OPS_ROLE);
      expect(report.problems).toEqual([]);
      expect(report.grants).toEqual([...RESTRICTED_ROLE_GRANTS[OPS_ROLE]].sort());
      // 쓰기 권한은 한 칸도 없다(도메인 · ops 표 모두).
      expect(report.grants.filter((grant) => /:(INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)$/.test(grant))).toEqual([]);
      // 비밀 칸은 읽지 못한다.
      for (const secret of ['ops_sessions.token_hash', 'ops_sessions.ua_hash', 'ops_sessions.client_key', 'ops_actions.client_key', 'ops_settings.failure_salt',
        'agent_api_keys.token_hash', 'org_api_keys.token_hash', 'owner_sessions.token_hash']) {
        expect(report.grants, secret).not.toContain(`${secret}:SELECT`);
      }
      expect(report.grants.some((grant) => grant.startsWith('ops_login_challenges'))).toBe(false);
    } finally {
      client.release();
    }
  });

  it('스위치 · 카탈로그 · 다이제스트 · 대상 참조가 TS 와 같다', async () => {
    const values = await owner.query<{ enabled: boolean; catalog: string[] }>('SELECT ops_activation_beta_enabled() AS enabled, ops_beta_catalog()::text[] AS catalog');
    expect(values.rows[0]?.enabled).toBe(BETA_ON_ACTIVATION);
    expect(values.rows[0]?.catalog.map(Number)).toEqual(LIMIT_COLUMNS.map(([key]) => PLAN_CATALOG.beta[key]));
    for (let i = 0; i < 20; i += 1) {
      const id = randomUUID();
      const target = randomUUID();
      const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
      const row = (
        await owner.query<{ digest: string; ref: string }>('SELECT ops_code_digest($1, $2) AS digest, ops_target_ref($1, $3, $4) AS ref', [id, code, 'org.activate', target])
      ).rows[0];
      expect(row?.digest).toBe(opsCodeDigest(id, code));
      expect(row?.ref).toBe(opsTargetRef(id, 'org.activate', target));
    }
  });
});
