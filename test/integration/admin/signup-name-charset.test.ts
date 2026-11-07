/**
 * **가입 조직 이름 — 앱 검사 ⊇ 실제 DB CHECK, 그리고 두 갈래(새 주소 · 이미 소유자인 주소)가 같은 응답** (검증 H3).
 *
 * H3 재현: `Acme\u2065`(U+2065, 미할당)는 예전 앱 검사를 통과하고 `signup_links.organization_name` CHECK 에 걸렸다. 새 주소는 가입
 * 링크 INSERT 가 23514 → 500 · 전부 롤백(원장 행도 없어 요청자 상한도 안 탔다), 소유자 주소는 그 INSERT 가 0행 → 202. 응답이
 * 주소의 존재를 갈랐고, 상한도 없이 무한히 캘 수 있었다.
 *
 * 되돌리면 빨개지는 것:
 *   - ⓗ-1 앱 금지 정규식을 예전 것(`[\p{Cc}\p{Cf}\u2028\u2029]`)으로 → DB 가 거부하는 U+2065 등을 앱이 통과시킨다.
 *   - ⓗ-2 앱 금지 정규식을 예전 것으로(탐침은 둠) → 두 갈래 모두 400 이지만 원장 행이 생긴다 / 탐침까지 빼면 소유자 202 · 새 주소 500.
 *   - ⓗ-3 행 모양 탐침(`SAVEPOINT signup_row_shape` …)을 빼면 → DB 만 거부하는 이름(어긋남 모의)에서 소유자 202 · 새 주소 500.
 */

import { createHmac } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isValidOrganizationName } from '../../../src/admin/session';
import { activeKey } from '../../../src/security/hmac-keyring';
import { adminDeps, adminRolePool, AVAILABLE, call, LOGIN_KEYS, newOrganization, ownerPool, suffix } from './support';

const uniqueIp = (): string => `198.51.100.${String(Math.floor(Math.random() * 250))}-${suffix()}${suffix()}`;
const newEmail = (): string => `charset-${suffix()}${suffix()}@example.com`;
const clientKeyOf = (ip: string): string => createHmac('sha256', activeKey(LOGIN_KEYS).key).update(`ip:${ip}`, 'utf8').digest('hex');

/**
 * 앱과 DB 가 **어긋난 날**의 모의: `signup_links` 로 가는 INSERT 의 조직 이름(\$2)만 DB 가 거부하는 값으로 바꾼다. 앱 검사는 원래
 * 이름(정상)을 보고 통과시켰으므로, 이 뒤는 "앱 ⊉ DB" 인 상태와 같다. 문장도 적는다(두 갈래의 문장·순서 비교용).
 */
function driftedNameCheck(pool: Pool, statements: string[]): Pool {
  const rewrite = (text: string, values?: unknown[]): unknown[] | undefined => {
    statements.push(text.replace(/\s+/g, ' ').trim());
    if (!text.trimStart().startsWith('INSERT INTO signup_links') || values === undefined) return values;
    const next = [...values];
    next[1] = 'Acme\u2065';
    return next;
  };
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'connect') {
        return async (): Promise<PoolClient> => {
          const client = await target.connect();
          const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<unknown>;
          return Object.assign(Object.create(client) as PoolClient, {
            query: (text: string, values?: unknown[]) => query(text, rewrite(text, values)),
            release: () => client.release(),
          });
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe.skipIf(!AVAILABLE)('가입 조직 이름 — 앱 검사 ⊇ DB CHECK · 두 갈래 같은 응답 (검증 H3)', () => {
  let owner: Pool;
  let admin: Pool;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end()]);
  });

  it('ⓗ-1 전 코드 포인트(1..0x10FFFF, 대리 제외): 실제 CHECK(가입 링크 이름 · 가입 조직 이름)가 거부하는 글자는 앱도 전부 거부한다(→ SQL 전에 400)', async () => {
    // CHECK 식을 카탈로그에서 그대로 가져와 평가한다 — 문자 집합을 테스트에 다시 적지 않는다(마이그레이션이 바뀌어도 따라간다).
    //   가입 조직 이름 CHECK(`organizations_self_signup_name_shape`)는 verify 때 링크의 이름이 그대로 옮겨지는 곳이다 — 있으면 같이 본다.
    const defs = await owner.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE (conrelid = 'signup_links'::regclass AND conname = 'signup_links_organization_name_check')
           OR (conrelid = 'organizations'::regclass AND conname = 'organizations_self_signup_name_shape')`,
    );
    const expressionOf = (name: string): string | undefined =>
      /^CHECK \((.*)\)( NOT VALID)?$/s.exec(defs.rows.find((row) => row.conname === name)?.def ?? '')?.[1];
    const linkExpression = expressionOf('signup_links_organization_name_check');
    expect(linkExpression, 'signup_links_organization_name_check 가 없다').toBeDefined();
    const orgExpression = expressionOf('organizations_self_signup_name_shape');
    // 앞뒤를 보통 글자로 감싼다 — btrim·길이 조건이 아니라 **문자 집합**을 본다. chr(0) 은 text 가 될 수 없어 1 부터.
    const rejected = await owner.query<{ cp: number }>(
      `SELECT cp FROM (
         SELECT cp, 'a' || chr(cp) || 'b' AS organization_name, 'a' || chr(cp) || 'b' AS name, 'self_signup'::text AS signup_source
           FROM generate_series(1, 1114111) AS cp
          WHERE cp NOT BETWEEN 55296 AND 57343) v
        WHERE NOT (${linkExpression ?? 'true'}) OR NOT (${orgExpression ?? 'true'})`,
    );
    const dbRejected = rejected.rows.map((row) => row.cp);
    expect(dbRejected).toContain(0x2065); // 검증이 실증한 글자
    expect(dbRejected.length).toBeGreaterThan(50); // 식을 잘못 읽어 아무것도 거부하지 않는 식이 되면 빨갛게
    const leaked = dbRejected.filter((cp) => isValidOrganizationName(`a${String.fromCodePoint(cp)}b`));
    expect(leaked.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`)).toEqual([]);

    // 길이 규칙도 같은 방향: DB 가 거부하는 길이(81)를 앱도 거부한다.
    const long = await owner.query<{ ok: boolean }>(`SELECT (${linkExpression ?? 'true'}) AS ok FROM (SELECT repeat('가', 81) AS organization_name) v`);
    expect(long.rows[0]?.ok).toBe(false);
    expect(isValidOrganizationName('가'.repeat(81))).toBe(false);
  }, 60_000);

  it('ⓗ-2 검증 재현 `Acme\u2065`(U+2065): 소유자 주소 · 새 주소 → 같은 400 · 같은 본문 · 쿠키 없음 · SQL 전(원장 행 0 · 링크 0)', async () => {
    const existing = await newOrganization(owner);
    const fresh = newEmail();
    const ips = [uniqueIp(), uniqueIp()];
    const results = [];
    for (const [index, email] of [existing.ownerEmail, fresh].entries()) {
      results.push(
        await call(adminDeps(admin), 'POST', '/api/signup', { body: { email, organizationName: 'Acme\u2065', consent: true }, ip: ips[index] ?? '' }),
      );
    }
    const [ownerResult, freshResult] = results;
    expect(ownerResult?.statusCode).toBe(400);
    expect(freshResult?.statusCode).toBe(ownerResult?.statusCode);
    expect(freshResult?.body).toBe(ownerResult?.body);
    expect(ownerResult?.json()).toMatchObject({ error: 'invalid_organization_name' });
    expect(ownerResult?.cookies ?? []).toEqual([]);
    expect(freshResult?.cookies ?? []).toEqual([]);
    for (const ip of ips) {
      expect((await owner.query('SELECT 1 FROM signup_requests WHERE client_key = $1', [clientKeyOf(ip)])).rowCount).toBe(0);
    }
    expect((await owner.query('SELECT 1 FROM signup_links WHERE email = ANY($1::text[])', [[existing.ownerEmail, fresh]])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM owner_login_links WHERE organization_id = $1', [existing.id])).rowCount).toBe(0);
  });

  it('ⓗ-3 두 번째 층 — 앱 ⊉ DB 로 어긋난 날(모의): 두 갈래 모두 같은 400 · 같은 본문 · 원장 행 1(상한을 태운다) · 링크 0 · 같은 문장과 순서', async () => {
    const existing = await newOrganization(owner);
    const fresh = newEmail();
    const ips = [uniqueIp(), uniqueIp()];
    const statements: string[][] = [[], []];
    const results = [];
    for (const [index, email] of [existing.ownerEmail, fresh].entries()) {
      results.push(
        await call(adminDeps(driftedNameCheck(admin, statements[index] ?? [])), 'POST', '/api/signup', {
          body: { email, organizationName: 'Acme', consent: true },
          ip: ips[index] ?? '',
        }),
      );
    }
    const [ownerResult, freshResult] = results;
    expect([ownerResult?.statusCode, freshResult?.statusCode]).toEqual([400, 400]);
    expect(freshResult?.body).toBe(ownerResult?.body);
    expect(ownerResult?.json()).toMatchObject({ error: 'invalid_organization_name' });
    // 앱 검사의 400 과 같은 문구(두 층 중 어디서 걸렸는지도 새지 않는다).
    const appLayer = await call(adminDeps(admin), 'POST', '/api/signup', {
      body: { email: fresh, organizationName: 'Acme\u2065', consent: true },
      ip: uniqueIp(),
    });
    expect(ownerResult?.body).toBe(appLayer.body);
    expect(statements[1]).toEqual(statements[0]);
    expect(statements[0]).toContain('SAVEPOINT signup_row_shape');
    for (const ip of ips) {
      expect((await owner.query('SELECT 1 FROM signup_requests WHERE client_key = $1', [clientKeyOf(ip)])).rowCount).toBe(1);
    }
    expect((await owner.query('SELECT 1 FROM signup_links WHERE email = ANY($1::text[])', [[existing.ownerEmail, fresh]])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM owner_login_links WHERE organization_id = $1', [existing.id])).rowCount).toBe(0);
  });
});
