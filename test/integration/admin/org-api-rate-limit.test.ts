/**
 * **ADR-0010 후속 L5 — `/org-api` 조직별 요청 상한**(마이그레이션 202609250200 · `src/admin/org-api/rate-limit.ts`·`pool-wait.ts` ·
 * `limitOrgApiAgentCreates` · 보존 `purge_org_api_request_windows()`).
 *
 * 라우터는 **`atmark_admin` 롤 풀**로 돈다(운영 admin Lambda 와 같은 롤 — GRANT 가 모자라면 빨개진다). 행 심기는 소유자 롤. 실메일 0 · AWS 0.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 두 조직 키 동시 부하: 한 조직(키 셋)이 분당 120 에 걸려 429 `rate_limited` + `Retry-After` 를 받는 동안 다른 조직 요청은 전부 200.
 *   - 키 상한: 한 키 60 뒤 429(계수는 60 에서 멈춘다) · 같은 조직의 다른 키는 여전히 200.
 *   - 쓰기 상한: 조직 키 에이전트 생성 10 뒤 11번째는 429 `rate_limited`(없으면 409 `agent_limit`).
 *   - 보존: 함수가 7일 넘은 창만 지운다(6일 행은 남는다) · 앱 롤은 함수 EXECUTE 로만(표 권한 0) · admin 은 함수 EXECUTE·DELETE 0.
 *   - 가드: admin 은 계수를 되감거나(UPDATE n) 지난·미래 창을 넣지 못한다.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { ORG_API_KEY_REQUESTS_PER_MINUTE, ORG_API_ORG_REQUESTS_PER_MINUTE } from '../../../src/admin/org-api/rate-limit';
import { ORG_API_AGENT_CREATES_PER_MINUTE } from '../../../src/admin/ops/org-keys';
import { createPool } from '../../../src/db/client';
import { createPostgresOrgApiWindowRetention } from '../../../src/db/repositories/org-api-window-retention';
import { adminDeps, ADMIN_ROLE_URL, appPool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from './support';

interface KeyItem {
  id: string;
}

type Result = Awaited<ReturnType<typeof call>>;

describe.skipIf(!AVAILABLE)('ADR-0010 L5 — /org-api 조직별 요청 상한 · 쓰기 상한 · 창 보존 — atmark_admin 롤', () => {
  let owner: Pool;
  let admin: Pool;
  let app: Pool;
  let mailer: Pool;
  let deps: AdminDependencies;

  beforeAll(() => {
    owner = ownerPool();
    // 동시 부하용 — 요청마다 커넥션을 빌린다(대기 상한 1초 안에 받도록 넉넉히).
    admin = createPool(ADMIN_ROLE_URL, { max: 16 });
    app = appPool();
    mailer = loginMailerPool();
    deps = adminDeps(admin);
  });
  afterAll(async () => {
    await owner.end();
    await admin.end();
    await app.end();
    await mailer.end();
  });

  /** 분 창 경계를 넘지 않게 — DB 시계로 50초를 넘었으면 다음 분까지 기다린다. */
  async function freshMinute(): Promise<void> {
    const now = await owner.query<{ s: number }>('SELECT extract(second FROM clock_timestamp())::float8 AS s');
    const second = now.rows[0]?.s ?? 0;
    if (second > 50) await sleep(Math.ceil((60 - second) * 1000) + 200);
  }

  async function org(): Promise<{ org: { id: string; ownerEmail: string }; session: Session }> {
    const organization = await newOrganization(owner);
    return { org: organization, session: await login(deps, mailer, organization) };
  }

  async function issue(session: Session, capabilities: string[]): Promise<{ key: string; item: KeyItem }> {
    const result = await call(deps, 'POST', '/api/org-keys', authed(session, { body: { label: `k-${suffix()}`, capabilities } }));
    expect(result.statusCode, result.body).toBe(201);
    return result.json() as { key: string; item: KeyItem };
  }

  function list(key: string): Promise<Result> {
    return call(deps, 'GET', '/org-api/v1/agents', { headers: { authorization: `Bearer ${key}` } });
  }

  function errorOf(result: Result): string {
    return (result.json() as { error: string }).error;
  }

  function expectRateLimited(result: Result): void {
    expect(result.statusCode, result.body).toBe(429);
    expect(errorOf(result)).toBe('rate_limited');
    const retryAfter = Number(result.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  }

  it('두 조직 키 동시 부하 — 한 조직이 분당 120 에 걸려도 다른 조직 요청은 전부 200', async () => {
    const noisy = await org();
    const quiet = await org();
    const noisyKeys = [await issue(noisy.session, ['agents:read']), await issue(noisy.session, ['agents:read']), await issue(noisy.session, ['agents:read'])];
    const quietKey = await issue(quiet.session, ['agents:read']);
    await freshMinute();

    // 시끄러운 조직: 키 셋 × 50 = 150(키 상한 60 아래 — 조직 합 120 만 걸린다). 조용한 조직: 30. 한꺼번에 섞어서.
    const noisyCalls = noisyKeys.flatMap((key) => Array.from({ length: 50 }, () => key.key));
    const quietCalls = Array.from({ length: 30 }, () => quietKey.key);
    const mixed = noisyCalls.map((key, index) => ({ key, quiet: false, index })).concat(quietCalls.map((key, index) => ({ key, quiet: true, index: index * 5 })));
    mixed.sort((a, b) => a.index - b.index);
    const results = await Promise.all(mixed.map(async (entry) => ({ quiet: entry.quiet, result: await list(entry.key) })));

    const quietResults = results.filter((entry) => entry.quiet).map((entry) => entry.result);
    const noisyResults = results.filter((entry) => !entry.quiet).map((entry) => entry.result);
    expect(quietResults.map((result) => result.statusCode)).toEqual(quietResults.map(() => 200));
    const noisyOk = noisyResults.filter((result) => result.statusCode === 200).length;
    const noisyLimited = noisyResults.filter((result) => result.statusCode === 429);
    expect(noisyOk + noisyLimited.length).toBe(noisyResults.length);
    // 조직 합은 문장 시작 스냅샷(느슨한 쪽) — 동시 커밋 몇 개만큼 넘을 수 있다. 상한 근처에서 멈추고 나머지는 429.
    expect(noisyOk).toBeGreaterThanOrEqual(ORG_API_ORG_REQUESTS_PER_MINUTE);
    expect(noisyOk).toBeLessThanOrEqual(ORG_API_ORG_REQUESTS_PER_MINUTE + 10);
    expect(noisyLimited.length).toBeGreaterThan(0);
    for (const result of noisyLimited) expectRateLimited(result);

    // 창 행: 키마다 한 행(이 분) · 조용한 조직 합 = 30.
    const windows = await owner.query<{ organization_id: string; total: number }>(
      'SELECT organization_id::text, sum(n)::int AS total FROM org_api_request_windows WHERE organization_id = ANY($1::uuid[]) GROUP BY 1',
      [[noisy.org.id, quiet.org.id]],
    );
    expect(windows.rows.find((row) => row.organization_id === quiet.org.id)?.total).toBe(30);

    // 조용한 조직은 그 뒤로도 200.
    expect((await list(quietKey.key)).statusCode).toBe(200);
  }, 30_000);

  it('키 상한 — 한 키 60 뒤 429(계수는 60 에서 멈춘다) · 같은 조직의 다른 키는 200', async () => {
    const { session } = await org();
    const hot = await issue(session, ['agents:read']);
    const sibling = await issue(session, ['agents:read']);
    await freshMinute();

    const results = await Promise.all(Array.from({ length: ORG_API_KEY_REQUESTS_PER_MINUTE + 5 }, () => list(hot.key)));
    expect(results.filter((result) => result.statusCode === 200)).toHaveLength(ORG_API_KEY_REQUESTS_PER_MINUTE);
    const limited = results.filter((result) => result.statusCode === 429);
    expect(limited).toHaveLength(5);
    for (const result of limited) expectRateLimited(result);
    const counted = await owner.query<{ n: number }>(
      "SELECT n FROM org_api_request_windows WHERE org_api_key_id = $1::uuid AND window_start = date_trunc('minute', now())",
      [hot.item.id],
    );
    expect(counted.rows[0]?.n).toBe(ORG_API_KEY_REQUESTS_PER_MINUTE);
    // 키 상한에 걸린 요청은 조직 몫을 먹지 않았다 — 형제 키는 그대로 통과.
    expect((await list(sibling.key)).statusCode).toBe(200);
  }, 30_000);

  it('쓰기 상한 — 조직 키 에이전트 생성 10/분 뒤 429 rate_limited + Retry-After: 60 (조직 에이전트 상한 409 보다 먼저)', async () => {
    const { org: o, session } = await org();
    const writer = await issue(session, ['agents:read', 'agents:create']);
    await freshMinute();
    const create = (index: number): Promise<Result> =>
      call(deps, 'POST', '/org-api/v1/agents', {
        headers: { authorization: `Bearer ${writer.key}` },
        body: { name: `ci ${String(index)}`, localPart: `ci-${suffix()}-${String(index)}` },
      });
    for (let index = 0; index < ORG_API_AGENT_CREATES_PER_MINUTE; index += 1) {
      const created = await create(index);
      expect(created.statusCode, created.body).toBe(201);
    }
    const over = await create(99);
    expectRateLimited(over);
    expect(over.headers['retry-after']).toBe('60');
    // 거부된 생성은 감사 행·에이전트를 남기지 않는다.
    const audit = await owner.query("SELECT 1 FROM owner_actions WHERE organization_id = $1 AND action = 'agent.create'", [o.id]);
    expect(audit.rowCount).toBe(ORG_API_AGENT_CREATES_PER_MINUTE);
  }, 60_000);

  it('보존 — 7일 넘은 창만 지운다 · 앱 롤은 함수로만(표 권한 0) · admin 은 DELETE·함수 0 · 가드가 계수 되감기·지난 창을 막는다', async () => {
    const { org: o, session } = await org();
    const key = await issue(session, ['agents:read']);
    // 소유자 롤은 가드가 서지 않는다(운영자 셸·심기).
    await owner.query(
      `INSERT INTO org_api_request_windows (org_api_key_id, organization_id, window_start, n)
       VALUES ($1::uuid, $2::uuid, date_trunc('minute', now() - interval '8 days'), 7),
              ($1::uuid, $2::uuid, date_trunc('minute', now() - interval '6 days'), 3)`,
      [key.item.id, o.id],
    );

    // admin: 표 DELETE 없음 · 함수 EXECUTE 없음 · 가드(되감기 · 지난 창 INSERT).
    await expect(admin.query('DELETE FROM org_api_request_windows WHERE org_api_key_id = $1::uuid', [key.item.id])).rejects.toMatchObject({ code: '42501' });
    await expect(admin.query('SELECT purge_org_api_request_windows()')).rejects.toMatchObject({ code: '42501' });
    expect((await list(key.key)).statusCode).toBe(200);
    await expect(
      admin.query("UPDATE org_api_request_windows SET n = 0 WHERE org_api_key_id = $1::uuid AND window_start = date_trunc('minute', now())", [key.item.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        "INSERT INTO org_api_request_windows (org_api_key_id, organization_id, window_start, n) VALUES ($1::uuid, $2::uuid, date_trunc('minute', now() + interval '1 hour'), 1)",
        [key.item.id, o.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // 앱 롤: 표는 읽기·쓰기 0 — 보존 함수만.
    await expect(app.query('SELECT count(*) FROM org_api_request_windows')).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.query("INSERT INTO org_api_request_windows (org_api_key_id, organization_id, window_start, n) VALUES ($1::uuid, $2::uuid, date_trunc('minute', now()), 1)", [
        key.item.id,
        o.id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(mailer.query('SELECT count(*) FROM org_api_request_windows')).rejects.toMatchObject({ code: '42501' });

    const purged = await createPostgresOrgApiWindowRetention(app).purge();
    expect(purged).toBeGreaterThanOrEqual(1);
    const left = await owner.query<{ age_days: number }>(
      'SELECT floor(extract(epoch FROM now() - window_start) / 86400)::int AS age_days FROM org_api_request_windows WHERE org_api_key_id = $1::uuid ORDER BY window_start',
      [key.item.id],
    );
    // 8일 행은 지워지고 6일 행 · 지금 창(인증 요청 하나)은 남는다.
    expect(left.rows.map((row) => row.age_days)).toEqual([6, 0]);
    const stale = await owner.query("SELECT 1 FROM org_api_request_windows WHERE window_start < now() - interval '7 days'");
    expect(stale.rowCount).toBe(0);
  });
});
