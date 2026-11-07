/**
 * 호스팅 운영자 콘솔 SQL(202609290500 · 0510)의 **정적 대조** — DB 없음(`.omc/plans/ops-console.md` §4 P1 W-DB · §7 단위).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - beta 카탈로그: `ops_beta_catalog()` 의 11칸 = `LIMIT_COLUMNS` 순서의 `PLAN_CATALOG.beta`(H6 — 호출자가 값을 넘기지 못한다).
 *   - 스위치 쌍(M3): `ops_activation_beta_enabled()` = TS `BETA_ON_ACTIVATION`. 베타를 끝낼 때는 커밋과 마이그레이션이 함께다.
 *   - prosrc 규율: 인증·행위·내부 함수는 `ops_*` 표에만 쓴다 · 도메인 표(다섯)에는 `ops_*_core` 만 쓴다 · 코어는 SECURITY DEFINER 가 아니다.
 *   - `OPS_STEP_UP` ↔ SQL: window 는 활성화뿐(허가 CHECK · 검증 함수 · 티켓).
 *   - 계약의 함수(P1)가 전부 마이그레이션에 있고, P2 함수는 없다.
 *   - 래퍼 매핑: 코어의 `grant` → `ActivationGrant` · SQLSTATE → `AdminInputError(code, status)` · 42883 → "마이그레이션 먼저".
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AdminInputError } from '../../../src/admin/ops/errors';
import { BETA_ON_ACTIVATION, LIMIT_COLUMNS, PLAN_CATALOG } from '../../../src/billing/plans';
import { MIGRATIONS_DIR } from '../../../src/db/migrate';
import { OPS_SQL_FUNCTIONS, OPS_SQL_FUNCTIONS_P2, OPS_SQLSTATE, OPS_STEP_UP } from '../../../src/ops/contract';
import { activationGrantOf, OpsCoreNotMigratedError, opsSqlError } from '../../../src/ops/core/review';

const IDENTITY = readFileSync(join(MIGRATIONS_DIR, '202609290500_ops_identity.sql'), 'utf8');
const ACTIONS = readFileSync(join(MIGRATIONS_DIR, '202609290510_ops_actions.sql'), 'utf8');
/** 스위치 함수의 **마지막** 정의 — 베타를 끄거나 켜는 것은 `CREATE OR REPLACE` 마이그레이션이라 최초 정의(0510)만 읽으면 어긋난다. */
const ACTIVATION_SWITCH_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))
  .filter((sql) => /FUNCTION ops_activation_beta_enabled\(\) RETURNS boolean/.test(sql))
  .at(-1) as string;
const DOMAIN_TABLES = ['organizations', 'agents', 'agent_api_keys', 'org_entitlements', 'billing_audit'] as const;

interface SqlFunction {
  readonly name: string;
  readonly header: string;
  readonly body: string;
}

/** `CREATE FUNCTION name(...) ... AS $$ body $$;` — 주석을 걷어 낸 본문. */
function functionsOf(sql: string): SqlFunction[] {
  const out: SqlFunction[] = [];
  const pattern = /CREATE (?:OR REPLACE )?FUNCTION ([a-z_]+)\(([\s\S]*?)AS \$\$([\s\S]*?)\$\$;/g;
  for (const match of sql.matchAll(pattern)) {
    out.push({ name: match[1] as string, header: match[2] as string, body: (match[3] as string).replace(/--[^\n]*/g, '') });
  }
  return out;
}

const NOT_TABLES = new Set(['set', 'of', 'skip', 'nowait']);

/** 본문이 쓰는 표(INSERT INTO · UPDATE · DELETE FROM). */
function writesOf(body: string): string[] {
  const tables = new Set<string>();
  for (const match of body.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?([A-Za-z_]+)/g)) {
    const table = (match[1] as string).toLowerCase();
    if (!NOT_TABLES.has(table)) tables.add(table);
  }
  return [...tables].sort();
}

/** 대기자 명단(202609301520) — 계약에 든 호스팅 정의 함수 셋(`ops_waitlist_*`)만. 그 파일의 소유자 코어는 `waitlist_*` 이름이라 ops 규율 밖이다. */
const WAITLIST = readFileSync(join(MIGRATIONS_DIR, '202609301520_waitlist.sql'), 'utf8');
/** 주간 운영판(202610010900) — 읽기 definer 하나 + 내부 술어 하나. 둘 다 아무 표에도 쓰지 않는다. */
const WEEKLY_BOARD = readFileSync(join(MIGRATIONS_DIR, '202610010900_ops_weekly_board.sql'), 'utf8');
const FUNCTIONS = [
  ...functionsOf(IDENTITY),
  ...functionsOf(ACTIONS),
  ...functionsOf(WAITLIST).filter((fn) => fn.name.startsWith('ops_waitlist_')),
  ...functionsOf(WEEKLY_BOARD),
];

describe('ops SQL — 카탈로그 · 스위치 쌍(M3 · H6)', () => {
  it('ops_beta_catalog() = LIMIT_COLUMNS 순서의 PLAN_CATALOG.beta (11칸)', () => {
    const literal = /ops_beta_catalog\(\)[\s\S]*?SELECT ARRAY\[([^\]]+)\]::bigint\[\]/.exec(ACTIONS);
    expect(literal).not.toBeNull();
    const values = (literal?.[1] ?? '').split(',').map((value) => Number(value.trim()));
    expect(values).toEqual(LIMIT_COLUMNS.map(([key]) => PLAN_CATALOG.beta[key]));
    expect(values).toHaveLength(11);
  });

  it('ops_activation_beta_enabled() 는 TS BETA_ON_ACTIVATION 과 같다 — 끄려면 커밋 + 마이그레이션', () => {
    const literal = /FUNCTION ops_activation_beta_enabled\(\) RETURNS boolean[\s\S]*?\$\$\s*SELECT (true|false)\s*\$\$/.exec(ACTIVATION_SWITCH_SQL);
    expect(literal?.[1]).toBe(String(BETA_ON_ACTIVATION));
    expect(/FUNCTION ops_activation_beta_enabled\(\) RETURNS boolean\s+LANGUAGE sql IMMUTABLE/.test(ACTIVATION_SWITCH_SQL)).toBe(true);
  });
});

describe('ops SQL — prosrc 규율(정의 함수는 ops_* 표에만 · 도메인 표에는 코어만)', () => {
  it('함수를 읽었다(비공허) — 계약의 P1 함수가 전부 있고 P2 함수는 없다', () => {
    const names = new Set(FUNCTIONS.map((fn) => fn.name));
    for (const name of Object.keys(OPS_SQL_FUNCTIONS)) {
      if ((OPS_SQL_FUNCTIONS_P2 as readonly string[]).includes(name)) expect(names.has(name), name).toBe(false);
      else expect(names.has(name), name).toBe(true);
    }
    expect(FUNCTIONS.length).toBeGreaterThan(25);
  });

  it('코어(ops_*_core)만 도메인 표에 쓴다 · 다른 함수는 ops_* 표에만 쓴다', () => {
    const offenders: string[] = [];
    const coreWrites = new Set<string>();
    for (const fn of FUNCTIONS) {
      const writes = writesOf(fn.body);
      if (fn.name.endsWith('_core')) {
        for (const table of writes) {
          if (!(DOMAIN_TABLES as readonly string[]).includes(table)) offenders.push(`${fn.name} → ${table}`);
          coreWrites.add(table);
        }
        continue;
      }
      for (const table of writes) if (!table.startsWith('ops_')) offenders.push(`${fn.name} → ${table}`);
    }
    expect(offenders).toEqual([]);
    // 비공허 — 코어가 실제로 다섯 표에 쓴다.
    expect([...coreWrites].sort()).toEqual([...DOMAIN_TABLES].sort());
  });

  it('코어·티켓·내부 함수는 SECURITY DEFINER 가 아니다 · 계약의 정의 함수는 전부 SECURITY DEFINER · search_path 고정', () => {
    const definers = new Set(FUNCTIONS.filter((fn) => /SECURITY DEFINER/.test(fn.header)).map((fn) => fn.name));
    for (const name of ['ops_org_activate_core', 'ops_org_reject_core', 'ops_authorize', 'ops_ticket_allows', 'ops_activation_beta_enabled', 'ops_beta_catalog']) {
      expect(definers.has(name), name).toBe(false);
    }
    const contractDefiners = Object.keys(OPS_SQL_FUNCTIONS).filter(
      (name) => !(OPS_SQL_FUNCTIONS_P2 as readonly string[]).includes(name) && !name.endsWith('_core') && !['ops_activation_beta_enabled', 'ops_beta_catalog'].includes(name),
    );
    for (const name of contractDefiners) expect(definers.has(name), name).toBe(true);
    for (const fn of FUNCTIONS.filter((candidate) => definers.has(candidate.name))) {
      expect(fn.header, fn.name).toMatch(/SET search_path = pg_catalog, public, pg_temp/);
    }
  });

  it('zz_ 트리거 함수는 session_user 가 atmark_ops 가 아니면 첫 줄에서 돌아간다(다른 롤에서는 no-op, I-3)', () => {
    for (const name of ['zz_ops_require_ticket', 'zz_ops_record_effect']) {
      const fn = FUNCTIONS.find((candidate) => candidate.name === name);
      expect(fn, name).toBeDefined();
      const firstStatement = (fn?.body ?? '').split('BEGIN')[1]?.trim().split('\n')[0] ?? '';
      expect(firstStatement, name).toMatch(/^IF session_user <> 'atmark_ops' THEN RETURN (NEW|NULL); END IF;$/);
    }
    for (const table of DOMAIN_TABLES) {
      expect(ACTIONS).toContain(`CREATE TRIGGER zz_ops_require_ticket BEFORE INSERT OR UPDATE ON ${table}`);
      expect(ACTIONS).toContain(`CREATE TRIGGER zz_ops_record_effect AFTER INSERT OR UPDATE ON ${table}`);
    }
  });

  it('주간 운영판(202610010900) — 첫 문장 lock_timeout · 정의 함수는 STABLE · 두 함수 모두 쓰기 0 · PUBLIC 0 · EXECUTE 는 atmark_ops 하나', () => {
    expect(WEEKLY_BOARD.replace(/--[^\n]*/g, '').split(';')[0]?.trim()).toBe("SET LOCAL lock_timeout = '5s'");
    const board = functionsOf(WEEKLY_BOARD);
    expect(board.map((fn) => fn.name).sort()).toEqual(['ops_board_external_sender', 'ops_weekly_board']);
    for (const fn of board) expect(writesOf(fn.body), fn.name).toEqual([]);
    expect(board.find((fn) => fn.name === 'ops_weekly_board')?.header).toMatch(/STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp/);
    expect(board.find((fn) => fn.name === 'ops_board_external_sender')?.header).not.toMatch(/SECURITY DEFINER/);
    const sql = WEEKLY_BOARD.replace(/--[^\n]*/g, '');
    expect(sql).toContain('REVOKE ALL ON FUNCTION ops_weekly_board(timestamptz, uuid[]) FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION ops_board_external_sender(uuid, text, text) FROM PUBLIC;');
    expect([...sql.matchAll(/GRANT EXECUTE ON FUNCTION ([a-z_]+)\([^)]*\) TO ([a-z_]+);/g)].map((m) => `${m[1] as string}:${m[2] as string}`)).toEqual(['ops_weekly_board:atmark_ops']);
  });

  it('0510 의 첫 문장은 SET LOCAL lock_timeout (I-4) · 0500 도', () => {
    for (const sql of [IDENTITY, ACTIONS]) expect(sql.replace(/--[^\n]*/g, '').split(';')[0]?.trim()).toBe("SET LOCAL lock_timeout = '5s'");
  });
});

describe('OPS_STEP_UP ↔ SQL', () => {
  it('window 는 활성화뿐 · once 는 거절·운영자 셋 · none 은 P2 (허가 CHECK · 검증 · 티켓이 같은 표)', () => {
    const window = Object.entries(OPS_STEP_UP).filter(([, mode]) => mode === 'window').map(([action]) => action);
    const once = Object.entries(OPS_STEP_UP).filter(([, mode]) => mode === 'once').map(([action]) => action).sort();
    expect(window).toEqual(['org.activate']);
    expect(IDENTITY).toContain("CONSTRAINT ops_step_up_grants_mode CHECK ((mode = 'window') = (action = 'org.activate'))");
    expect(IDENTITY).toContain("CASE WHEN v_candidate.action = 'org.activate' THEN 'window' ELSE 'once' END");
    const grantActions = /ops_step_up_grants \([\s\S]*?action\s+text NOT NULL CHECK \(action IN \(([^)]+)\)\)/.exec(IDENTITY)?.[1] ?? '';
    expect(grantActions.split(',').map((value) => value.trim().replace(/'/g, '')).sort()).toEqual([...window, ...once].sort());
  });
});

describe('래퍼 매핑(M2)', () => {
  it('grant → ActivationGrant', () => {
    expect(activationGrantOf({ grant: 'granted', from_plan: 'free', kept_plan: null, version: 2 })).toEqual({ granted: true, fromPlan: 'free', version: 2 });
    expect(activationGrantOf({ grant: 'granted', from_plan: null, kept_plan: null, version: 1 })).toEqual({ granted: true, fromPlan: null, version: 1 });
    expect(activationGrantOf({ grant: 'disabled', from_plan: null, kept_plan: null, version: null })).toEqual({ granted: false, reason: 'disabled', plan: null });
    expect(activationGrantOf({ grant: 'kept', from_plan: null, kept_plan: 'pro', version: null })).toEqual({ granted: false, reason: 'kept', plan: 'pro' });
    expect(activationGrantOf({ grant: 'none', from_plan: null, kept_plan: null, version: null })).toBeNull();
  });

  it('SQLSTATE AT4xx + DETAIL → AdminInputError(code, status) · 42883 → 마이그레이션 먼저 · 그 밖은 그대로', () => {
    const org = '00000000-0000-4000-8000-000000000000';
    const notFound = opsSqlError({ code: 'AT404', detail: 'organization_not_found' }, org);
    expect(notFound).toBeInstanceOf(AdminInputError);
    // 없는 조직은 옛 CLI 와 같게 400 · 같은 문구(파리티).
    expect(notFound).toMatchObject({ code: 'organization_not_found', status: 400, message: `조직이 없다: ${org}` });
    for (const [state, status] of Object.entries(OPS_SQLSTATE)) {
      if (state === 'AT503') continue;
      expect(opsSqlError({ code: state, detail: 'rate_limited' }, org), state).toMatchObject({ code: 'rate_limited', status });
    }
    for (const fn of FUNCTIONS.filter((candidate) => /_guard$/.test(candidate.name))) {
      // 보안 검토 Info1 — 트리거 가드 함수도 search_path 를 고정한다.
      expect(fn.header, fn.name).toMatch(/SET search_path = pg_catalog, public, pg_temp/);
    }
    expect(opsSqlError({ code: '42883' }, org)).toBeInstanceOf(OpsCoreNotMigratedError);
    expect(String((opsSqlError({ code: '42883' }, org) as Error).message)).toContain('마이그레이션 먼저');
    const other = new Error('boom');
    expect(opsSqlError(other, org)).toBe(other);
    expect(opsSqlError({ code: 'AT503', detail: 'ops_disabled' }, org)).not.toBeInstanceOf(AdminInputError);
  });
});
