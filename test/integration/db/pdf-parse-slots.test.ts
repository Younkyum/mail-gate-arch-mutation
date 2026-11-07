/**
 * `createPostgresPdfParseSlots` — 함대 전체 PDF 해석 칸 + 조직마다 하나(advisory 잠금, `src/db/repositories/pdf-parse-slots.ts`).
 *
 *   - ★ 인스턴스 셋(풀 셋 — λ 셋과 같은 모양, 조직 셋)이 칸을 다투면 둘만 잡고 셋째는 **기다리지 않고** `null`(→ `busy`)
 *   - ★ 같은 조직의 둘째 PDF 는 함대 칸이 비어 있어도 `null` — 다른 조직은 잡는다 · 조직 칸을 잡고 함대 칸을 못 잡으면 조직 칸도 푼다
 *   - 앱 롤(`atmark_app`, API 와 같은 롤)이 `pg_try_advisory_lock` 을 부르고 `idle_session_timeout`·`tcp_keepalives_idle` 을 바꿀 수 있다
 *   - ★ 쥔 세션이 매달려도(λ 가 얼어도) 서버의 유휴 종료가 칸을 푼다 — 프로세스는 죽지 않는다
 *   - 놓으면 다른 인스턴스가 잡는다 · 두 번 놓아도 한 번 · 다 놓으면 잠금 0 · 잡은 연결은 풀로 돌아가지 않는다(버린다 — 설정이 새지 않게)
 *   - DB 가 실패해도 던지지 않고 `null`
 *   - 키는 두 int4 형식(`objsubid = 2`)이다 — bigint 한 개 형식의 다른 잠금과 키 공간이 다르다
 *
 * 운영 키(`PDF_PARSE_LOCK_CLASS`·`PDF_PARSE_ORG_LOCK_CLASS`)는 같은 DB 에서 동시에 도는 다른 통합 테스트(실제 PDF 를 푸는 첨부 조회)가
 * 쓴다 — 이 파일은 칸을 일부러 꽉 채우므로 **이 실행만의 키 공간**을 쓴다(`lockClass`·`orgLockClass`).
 *
 * **`TEST_DATABASE_URL` 이 없으면 통째로 건너뛴다.**
 */

import { randomInt } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  createPostgresPdfParseSlots,
  PDF_PARSE_LOCK_CLASS,
  PDF_PARSE_ORG_LOCK_CLASS,
  PDF_PARSE_SLOT_COUNT,
  type PdfParseSlotOptions,
} from '../../../src/db/repositories/pdf-parse-slots';
import { closeTestPool, DATABASE_AVAILABLE, newAgentId, newIndependentPool, provisioningPool, seedFixture, testPool } from './support/harness';

describe.skipIf(!DATABASE_AVAILABLE)('PDF 해석 칸 — advisory 잠금', () => {
  const pools: Pool[] = [];
  /** 조직 셋 — 첫 조직에는 에이전트가 둘. */
  let agents: { readonly orgA1: string; readonly orgA2: string; readonly orgB: string; readonly orgC: string };

  beforeAll(async () => {
    const [a, b, c] = [await seedFixture(testPool()), await seedFixture(testPool()), await seedFixture(testPool())];
    const second = newAgentId();
    await provisioningPool().query(
      `INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, $3, 'active', 'free', 100000)`,
      [second, a.organizationId, `test-agent-${second.slice(0, 8)}`],
    );
    agents = { orgA1: a.agentId, orgA2: second, orgB: b.agentId, orgC: c.agentId };
  });
  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    await closeTestPool();
  });

  /** 이 테스트만의 키 공간 — 함대·조직 분류가 서로 다르고 운영 값과도 다르다. */
  const keySpace = (): { readonly lockClass: number; readonly orgLockClass: number } => {
    const lockClass = 0x70000000 + randomInt(0, 0x07ffffff);
    return { lockClass, orgLockClass: lockClass + 0x08000000 };
  };
  const instance = (options: PdfParseSlotOptions): { readonly pool: Pool; readonly slots: ReturnType<typeof createPostgresPdfParseSlots> } => {
    const pool = newIndependentPool({ max: 2 });
    pools.push(pool);
    return { pool, slots: createPostgresPdfParseSlots(pool, options) };
  };
  const held = async (classId: number): Promise<number> => {
    const result = await testPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::bigint::oid AND objsubid = 2 AND granted`,
      [classId],
    );
    return Number(result.rows[0]?.count ?? '-1');
  };
  const checkedOut = (pool: Pool): number => pool.totalCount - pool.idleCount;

  it('운영 설정은 2 칸 · 두 분류는 서로 다르고 int4 범위', () => {
    expect(PDF_PARSE_SLOT_COUNT).toBe(2);
    expect(PDF_PARSE_ORG_LOCK_CLASS).not.toBe(PDF_PARSE_LOCK_CLASS);
    for (const classId of [PDF_PARSE_LOCK_CLASS, PDF_PARSE_ORG_LOCK_CLASS]) {
      expect(classId).toBeGreaterThan(0);
      expect(classId).toBeLessThanOrEqual(0x7fffffff);
    }
  });

  it('★ 인스턴스 셋(조직 셋)이 다투면 둘만 잡고 셋째는 null — 놓으면 잡힌다 · 다 놓으면 잠금 0 · 잡은 연결은 버린다', async () => {
    const keys = keySpace();
    const [a, b, c] = [instance(keys), instance(keys), instance(keys)];

    const first = await a.slots.tryAcquire(agents.orgA1);
    const second = await b.slots.tryAcquire(agents.orgB);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect([await held(keys.lockClass), await held(keys.orgLockClass)]).toEqual([2, 2]);

    const third = await c.slots.tryAcquire(agents.orgC);
    expect(third).toBeNull();
    // 조직 칸은 잡았다가 함대 칸을 못 잡았다 — 연결째 버려 조직 칸도 풀렸다(쥔 연결 0).
    expect(await held(keys.orgLockClass)).toBe(2);
    expect(checkedOut(c.pool)).toBe(0);

    await first?.release();
    await first?.release(); // 두 번 놓아도 한 번
    expect(await held(keys.lockClass)).toBe(1);
    const retried = await c.slots.tryAcquire(agents.orgC);
    expect(retried).not.toBeNull();
    expect(await held(keys.lockClass)).toBe(2);

    await second?.release();
    await retried?.release();
    expect([await held(keys.lockClass), await held(keys.orgLockClass)]).toEqual([0, 0]);
    // 놓은 연결은 풀로 돌아가지 않고 버려졌다(쥔 연결 0 · 남은 연결 0 — 세션 설정이 새지 않는다).
    expect([a.pool, b.pool, c.pool].map(checkedOut)).toEqual([0, 0, 0]);
    expect([a.pool, b.pool, c.pool].map((pool) => pool.totalCount)).toEqual([0, 0, 0]);
  });

  it('★ 조직마다 하나 — 같은 조직의 둘째는 함대 칸이 비어도 null(연결은 풀로) · 다른 조직은 잡는다 · 놓으면 같은 조직이 잡는다', async () => {
    const keys = keySpace();
    const [a, b, c] = [instance(keys), instance(keys), instance(keys)];

    const first = await a.slots.tryAcquire(agents.orgA1);
    expect(first).not.toBeNull();
    const sameOrg = await b.slots.tryAcquire(agents.orgA2);
    expect(sameOrg).toBeNull();
    expect(await held(keys.lockClass)).toBe(1); // 함대 칸은 건드리지 않았다
    expect(checkedOut(b.pool)).toBe(0);
    expect(b.pool.idleCount).toBe(1); // 아무것도 잡지 않은 연결은 풀로 돌아간다

    const otherOrg = await c.slots.tryAcquire(agents.orgB);
    expect(otherOrg).not.toBeNull();

    await first?.release();
    const sameOrgLater = await b.slots.tryAcquire(agents.orgA2);
    expect(sameOrgLater).not.toBeNull();
    await sameOrgLater?.release();
    await otherOrg?.release();
    expect([await held(keys.lockClass), await held(keys.orgLockClass)]).toEqual([0, 0]);
  });

  it('없는 에이전트 · DB 오류는 던지지 않고 null', async () => {
    const keys = keySpace();
    expect(await instance(keys).slots.tryAcquire('f'.repeat(32))).toBeNull();
    const closed = newIndependentPool({ max: 1 });
    await closed.end();
    expect(await createPostgresPdfParseSlots(closed, keys).tryAcquire(agents.orgA1)).toBeNull();
  });

  it('앱 롤이 두 세션 설정을 바꿀 수 있다(칸을 잡은 세션에 거는 값)', async () => {
    const client = await testPool().connect();
    try {
      const role = await client.query<{ role: string }>('SELECT current_user AS role');
      expect(role.rows[0]?.role).toBe('atmark_app');
      await client.query("SELECT set_config('idle_session_timeout', '30s', false), set_config('tcp_keepalives_idle', '10', false)");
      const shown = await client.query<{ idle: string; keepalive: string }>(
        "SELECT current_setting('idle_session_timeout') AS idle, current_setting('tcp_keepalives_idle') AS keepalive",
      );
      // 시험 DB 는 TCP(localhost)라 keepalive 도 걸린다(유닉스 소켓이면 0 으로 보인다).
      expect(shown.rows[0]).toEqual({ idle: '30s', keepalive: '10' });
    } finally {
      client.release(true);
    }
  });

  it('★ 쥔 세션이 매달리면 서버의 유휴 종료가 칸을 푼다 — 프로세스는 멀쩡하다', async () => {
    const keys = keySpace();
    const hanging = instance({ ...keys, idleSessionTimeout: '1s' });
    const slot = await hanging.slots.tryAcquire(agents.orgA1);
    expect(slot).not.toBeNull();
    expect(await held(keys.lockClass)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect([await held(keys.lockClass), await held(keys.orgLockClass)]).toEqual([0, 0]);
    await slot?.release(); // 끊긴 연결에서 놓아도 던지지 않는다
    const again = await instance(keys).slots.tryAcquire(agents.orgA1);
    expect(again).not.toBeNull();
    await again?.release();
  });
});
