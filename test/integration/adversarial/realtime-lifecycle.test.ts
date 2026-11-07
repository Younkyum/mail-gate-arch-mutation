/**
 * 적대적 검증(실시간 WebSocket E) — 영역 1(상태별 `$connect`) · 영역 4(상한 · 경합 · 수명 · 스윕 · 삭제 금지 트리거 · DB 롤 권한).
 * 실제 Postgres 위 — 운영과 같은 저장소 · 정의 함수 · 롤(앱 · admin · AI 감시). 안전 동작을 단언한다(깨지면 `VULN:`).
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresRealtimeConnectionRetention } from '../../../src/db/repositories/realtime-connection-store';
import { closeTestPool, DATABASE_AVAILABLE, seedFixture, testPool } from '../db/support/harness';
import { numbered } from '../../unit/adversarial/realtime-support';
import {
  connectWith,
  disconnectWith,
  expireNow,
  isSuperuser,
  issueToken,
  newConnectionId,
  openCount,
  owner,
  pingWith,
  rolePool,
  rowOf,
  staleBy,
  timeTravel,
} from './realtime-support';
import { OWNER_AVAILABLE } from './watch-support';

describe.skipIf(!OWNER_AVAILABLE || !DATABASE_AVAILABLE)('실시간 적대적 검증 — 연결 수명 · 상한 · 트리거 · 롤 권한 (Postgres)', () => {
  let adminPool: Pool;
  let aiWatchPool: Pool;
  let superuser = false;

  beforeAll(async () => {
    adminPool = rolePool('atmark_admin');
    aiWatchPool = rolePool('atmark_ai_watch');
    superuser = await isSuperuser();
  });

  afterAll(async () => {
    await adminPool.end();
    await aiWatchPool.end();
    await closeTestPool();
  });

  // ------------------------------------------------------------------------------------------------------------------------------------
  // 영역 1 — 상태별 $connect (실제 DB 가 판정)
  // ------------------------------------------------------------------------------------------------------------------------------------
  const refusedStates: [string, (f: Awaited<ReturnType<typeof seedFixture>>, keyId: string) => Promise<void>, number][] = [
    ['토큰 폐기', async (_f, keyId) => void (await owner().query('UPDATE agent_api_keys SET revoked_at = now() WHERE id = $1', [keyId])), 401],
    ['에이전트 소유자 정지', async (f) => void (await owner().query(`UPDATE agents SET status = 'suspended', suspended_by = 'owner' WHERE id = $1`, [f.agentId])), 403],
    ['에이전트 운영자 정지(킬)', async (f) => void (await owner().query(`UPDATE agents SET status = 'suspended', suspended_by = 'operator' WHERE id = $1`, [f.agentId])), 403],
    ['조직 소유자 일시정지', async (f) => void (await owner().query('UPDATE organizations SET owner_paused = true WHERE id = $1', [f.organizationId])), 403],
    ['조직 남용 동결', async (f) => void (await owner().query('UPDATE organizations SET abuse_freeze = true WHERE id = $1', [f.organizationId])), 403],
    ['조직 검토 전(pending_review)', async (f) => void (await owner().query(`UPDATE organizations SET review_status = 'pending_review' WHERE id = $1`, [f.organizationId])), 403],
    ['조직 거절(rejected)', async (f) => void (await owner().query(`UPDATE organizations SET review_status = 'rejected' WHERE id = $1`, [f.organizationId])), 403],
  ];

  it.each(numbered('E1-D', refusedStates))('[%s] 상태 "%s" → $connect 거부 · 연결 행이 생기지 않는다', async (_id, _label, mutate, status) => {
    const f = await seedFixture(testPool());
    const { plaintext, id: keyId } = await issueToken(f);
    await mutate(f, keyId);
    const attempt = await connectWith(plaintext);
    expect(attempt.result.statusCode).toBe(status);
    expect(await rowOf(attempt.id)).toBeUndefined();
  });

  it('[E1-D-008] 만료된 토큰(expires_at 지남) → 401 · 행 없음', async () => {
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f, ['messages:read'], 1);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    const attempt = await connectWith(plaintext);
    expect(attempt.result.statusCode).toBe(401);
    expect(await rowOf(attempt.id)).toBeUndefined();
  });

  it('[E1-D-009] messages:read 없는 토큰(send 만) → 403 · 행 없음', async () => {
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f, ['messages:send']);
    const attempt = await connectWith(plaintext);
    expect(attempt.result.statusCode).toBe(403);
    expect(await rowOf(attempt.id)).toBeUndefined();
  });

  it('[E1-D-010] 쿼리 토큰 · 조직 키 모양 · 모르는 토큰 모두 행을 만들지 않는다', async () => {
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const ids: string[] = [];
    for (const opts of [{ query: { token: plaintext } }, { headers: { Authorization: `Bearer atk_org_${'K'.repeat(43)}` } }, { headers: { Authorization: `Bearer atk_agent_${'Z'.repeat(43)}` } }]) {
      const attempt = await connectWith(plaintext, opts);
      ids.push(attempt.id);
      expect(attempt.result.statusCode).toBeGreaterThanOrEqual(400);
    }
    for (const id of ids) expect(await rowOf(id)).toBeUndefined();
  });

  it('[E1-D-011] 정지 해제 뒤에는 다시 연결된다(상태가 바뀌면 판정도 바뀐다)', async () => {
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    await owner().query(`UPDATE agents SET status = 'suspended', suspended_by = 'owner' WHERE id = $1`, [f.agentId]);
    expect((await connectWith(plaintext)).result.statusCode).toBe(403);
    await owner().query(`UPDATE agents SET status = 'active', suspended_by = NULL WHERE id = $1`, [f.agentId]);
    expect((await connectWith(plaintext)).result.statusCode).toBe(200);
  });

  // ------------------------------------------------------------------------------------------------------------------------------------
  // 영역 2 — 연결 id 재사용 · 남의 토큰 해시
  // ------------------------------------------------------------------------------------------------------------------------------------
  it('[E2-X-001] 다른 에이전트가 남의 연결 id 로 $connect → 401 · 원래 행(에이전트 · 열림)은 그대로', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const mine = await connectWith((await issueToken(a)).plaintext);
    expect(mine.result.statusCode).toBe(200);
    const theirs = await connectWith((await issueToken(b)).plaintext, { id: mine.id });
    expect(theirs.result.statusCode).toBe(401);
    const row = await rowOf(mine.id);
    expect(row?.agent_id).toBe(a.agentId);
    expect(row?.closed_at).toBeNull();
    expect(await openCount(b.agentId)).toBe(0);
  });

  it('[E2-X-002] 같은 에이전트가 이미 닫힌 연결 id 로 다시 $connect → 401(닫힌 행은 되살아나지 않는다)', async () => {
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const first = await connectWith(plaintext);
    await disconnectWith(first.id);
    expect((await connectWith(plaintext, { id: first.id })).result.statusCode).toBe(401);
    expect((await rowOf(first.id))?.closed_at).not.toBeNull();
  });

  it('[E2-X-003] 같은 에이전트가 열린 연결 id 로 다시 $connect → 200(duplicate)이고 행은 하나', async () => {
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const first = await connectWith(plaintext);
    expect((await connectWith(plaintext, { id: first.id })).result.statusCode).toBe(200);
    expect(await openCount(f.agentId)).toBe(1);
  });

  it('[E2-X-004] SQL 직접: A 의 토큰 해시로 B 의 연결을 등록하려 하면 token_invalid', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const { hash } = await issueToken(a);
    const result = await testPool().query<{ outcome: string }>('SELECT public.atmark_realtime_connect($1, $2, $3) AS outcome', [newConnectionId(), b.agentId, hash]);
    expect(result.rows[0]?.outcome).toBe('token_invalid');
  });

  it('[E2-X-005] SQL 직접: 모르는 토큰 해시 → token_invalid', async () => {
    const f = await seedFixture(testPool());
    const result = await testPool().query<{ outcome: string }>('SELECT public.atmark_realtime_connect($1, $2, $3) AS outcome', [newConnectionId(), f.agentId, 'f'.repeat(64)]);
    expect(result.rows[0]?.outcome).toBe('token_invalid');
  });

  it('[E2-X-006] SQL 직접: 모양이 틀린 연결 id 는 표 CHECK 가 거부한다(행 없음)', async () => {
    const f = await seedFixture(testPool());
    const { hash } = await issueToken(f);
    await expect(testPool().query('SELECT public.atmark_realtime_connect($1, $2, $3)', ['bad id!;--', f.agentId, hash])).rejects.toMatchObject({ code: '23514' });
    expect(await rowOf('bad id!;--')).toBeUndefined();
  });

  it('[E2-X-007] SQL 직접: 아주 긴 연결 id(129자)도 거부', async () => {
    const f = await seedFixture(testPool());
    const { hash } = await issueToken(f);
    await expect(testPool().query('SELECT public.atmark_realtime_connect($1, $2, $3)', ['a'.repeat(129), f.agentId, hash])).rejects.toMatchObject({ code: '23514' });
  });

  it('[E2-X-008] $disconnect 는 지정한 연결 하나만 닫는다 — 같은 에이전트의 다른 연결 · 다른 에이전트의 연결은 열려 있다', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const ta = (await issueToken(a)).plaintext;
    const a1 = await connectWith(ta);
    const a2 = await connectWith(ta);
    const b1 = await connectWith((await issueToken(b)).plaintext);
    await disconnectWith(a1.id);
    expect((await rowOf(a1.id))?.close_reason).toBe('disconnect');
    expect((await rowOf(a2.id))?.closed_at).toBeNull();
    expect((await rowOf(b1.id))?.closed_at).toBeNull();
  });

  it('[E2-X-009] SQL 인젝션 모양의 연결 id 로 $disconnect(우회 호출) → 아무 행도 닫지 않는다', async () => {
    const f = await seedFixture(testPool());
    const first = await connectWith((await issueToken(f)).plaintext);
    await testPool().query('SELECT public.atmark_realtime_disconnect($1, $2)', [`x' OR '1'='1`, 'disconnect']);
    await testPool().query('SELECT public.atmark_realtime_disconnect($1, $2)', ['%', 'disconnect']);
    expect((await rowOf(first.id))?.closed_at).toBeNull();
  });

  it('[E2-X-010] 닫힌 연결에 핑을 쳐도 되살아나지 않고 행이 하나도 변하지 않는다', async () => {
    const f = await seedFixture(testPool());
    const first = await connectWith((await issueToken(f)).plaintext);
    await disconnectWith(first.id);
    const before = await rowOf(first.id);
    await pingWith(first.id);
    expect(await rowOf(first.id)).toEqual(before);
  });

  // ------------------------------------------------------------------------------------------------------------------------------------
  // 영역 4 — 상한 5 · 경합
  // ------------------------------------------------------------------------------------------------------------------------------------
  it('[E4-L-001] 동시에 12개 연결 시도(풀 12개) → 정확히 5개만 열리고 7개는 429', async () => {
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const pools = Array.from({ length: 12 }, () => rolePool('atmark_app'));
    try {
      const results = await Promise.all(pools.map((pool) => connectWith(plaintext, { pool })));
      const codes = results.map((r) => r.result.statusCode);
      expect(codes.filter((c) => c === 200)).toHaveLength(5);
      expect(codes.filter((c) => c === 429)).toHaveLength(7);
      expect(await openCount(f.agentId)).toBe(5);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it('[E4-L-002] 에이전트 둘 × 동시 8개씩 → 각자 정확히 5개', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const ta = (await issueToken(a)).plaintext;
    const tb = (await issueToken(b)).plaintext;
    const pools = Array.from({ length: 16 }, () => rolePool('atmark_app'));
    try {
      await Promise.all(pools.map((pool, i) => connectWith(i % 2 === 0 ? ta : tb, { pool })));
      expect(await openCount(a.agentId)).toBe(5);
      expect(await openCount(b.agentId)).toBe(5);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it('[E4-L-003] 같은 연결 id 로 동시에 6번 → 행은 하나 · 전부 200(duplicate 경합이 오류로 새지 않는다)', async () => {
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const id = newConnectionId();
    const pools = Array.from({ length: 6 }, () => rolePool('atmark_app'));
    try {
      const results = await Promise.all(pools.map((pool) => connectWith(plaintext, { pool, id })));
      expect(results.map((r) => r.result.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(await openCount(f.agentId)).toBe(1);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it('[E4-L-004] 한 에이전트의 토큰 둘이 상한 5 를 나눠 쓴다(토큰을 늘려도 연결은 늘지 않는다)', async () => {
    const f = await seedFixture(testPool());
    const t1 = (await issueToken(f)).plaintext;
    const t2 = (await issueToken(f)).plaintext;
    for (let i = 0; i < 3; i += 1) expect((await connectWith(t1)).result.statusCode).toBe(200);
    for (let i = 0; i < 2; i += 1) expect((await connectWith(t2)).result.statusCode).toBe(200);
    expect((await connectWith(t2)).result.statusCode).toBe(429);
    expect((await connectWith(t1)).result.statusCode).toBe(429);
  });

  it('[E4-L-005] 같은 조직의 다른 에이전트는 상한을 나누지 않는다', async () => {
    const f = await seedFixture(testPool());
    const t1 = (await issueToken(f)).plaintext;
    for (let i = 0; i < 5; i += 1) await connectWith(t1);
    expect((await connectWith(t1)).result.statusCode).toBe(429);
    const other = await seedFixture(testPool());
    expect((await connectWith((await issueToken(other)).plaintext)).result.statusCode).toBe(200);
  });

  it('[E4-L-006] 거절된 6번째 시도가 행이나 부수 효과(기존 연결 닫힘)를 남기지 않는다', async () => {
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push((await connectWith(plaintext)).id);
    const sixth = await connectWith(plaintext);
    expect(sixth.result.statusCode).toBe(429);
    expect(await rowOf(sixth.id)).toBeUndefined();
    for (const id of ids) expect((await rowOf(id))?.closed_at).toBeNull();
  });

  it('[E4-L-007] 만료됐지만 스윕 전인 행은 상한에 세지 않는다', async () => {
    if (!superuser) return;
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push((await connectWith(plaintext)).id);
    await expireNow(ids[0] ?? '');
    expect((await connectWith(plaintext)).result.statusCode).toBe(200);
  });

  it('[E4-L-008] VULN: 토큰을 폐기하면 그 토큰으로 열린 연결도 상한을 비워야 한다 — 폐기된 토큰의 연결 5개가 새 토큰의 연결을 최대 2시간 막는다', async () => {
    const f = await seedFixture(testPool());
    const leaked = await issueToken(f);
    for (let i = 0; i < 5; i += 1) expect((await connectWith(leaked.plaintext)).result.statusCode).toBe(200);
    // 소유자가 유출된 토큰을 폐기하고 새 토큰을 발급한다. 공격자는 열려 있는 연결을 5분마다 핑으로 유지한다.
    await owner().query('UPDATE agent_api_keys SET revoked_at = now() WHERE id = $1', [leaked.id]);
    const fresh = await issueToken(f);
    expect((await connectWith(fresh.plaintext)).result.statusCode).toBe(200);
  });

  it('[E4-L-009] SUSPECT: 운영자가 에이전트를 정지(킬)해도 열려 있던 WebSocket 연결 행은 그대로 열려 있다(푸시만 멈춘다) — 정지 시 연결을 닫지 않는다', async () => {
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    for (let i = 0; i < 5; i += 1) await connectWith(plaintext);
    await owner().query(`UPDATE agents SET status = 'suspended', suspended_by = 'operator' WHERE id = $1`, [f.agentId]);
    expect(await openCount(f.agentId)).toBe(5);
  });

  it('[E4-L-010] SUSPECT: $disconnect 를 잃은 유령 연결 5개(핑 14분 전)는 스윕(15분)까지 상한을 쥔다 — 에이전트 스스로 최대 15~20분 재연결이 막힌다', async () => {
    if (!superuser) return;
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push((await connectWith(plaintext)).id);
    for (const id of ids) await staleBy(id, 14);
    expect((await connectWith(plaintext)).result.statusCode).toBe(429);
  });

  // ------------------------------------------------------------------------------------------------------------------------------------
  // 영역 4 — 수명 · 스윕
  // ------------------------------------------------------------------------------------------------------------------------------------
  it('[E4-S-001] 만료 시각 = 연결 시각 + 정확히 2시간(DB 가 정한다)', async () => {
    const f = await seedFixture(testPool());
    const first = await connectWith((await issueToken(f)).plaintext);
    const row = await rowOf(first.id);
    expect((row?.expires_at.getTime() ?? 0) - (row?.connected_at.getTime() ?? 0)).toBe(2 * 3600 * 1000);
  });

  it('[E4-S-002] 스윕: 만료 행은 expired · 핑 16분 전은 stale 로 닫고 · 핑 14분 전과 새 행은 둔다', async () => {
    if (!superuser) return;
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const expired = await connectWith(plaintext);
    const stale = await connectWith(plaintext);
    const edge = await connectWith(plaintext);
    const fresh = await connectWith(plaintext);
    await expireNow(expired.id);
    await staleBy(stale.id, 16);
    await staleBy(edge.id, 14);
    const swept = await createPostgresRealtimeConnectionRetention(testPool()).sweep();
    expect(swept?.closed).toBeGreaterThanOrEqual(2);
    expect((await rowOf(expired.id))?.close_reason).toBe('expired');
    expect((await rowOf(stale.id))?.close_reason).toBe('stale');
    expect((await rowOf(edge.id))?.closed_at).toBeNull();
    expect((await rowOf(fresh.id))?.closed_at).toBeNull();
  });

  it('[E4-S-003] 스윕은 두 번째에는 새로 닫을 것이 없다(멱등) · 이미 닫힌 행의 사유를 바꾸지 않는다', async () => {
    if (!superuser) return;
    const f = await seedFixture(testPool());
    const first = await connectWith((await issueToken(f)).plaintext);
    await expireNow(first.id);
    await createPostgresRealtimeConnectionRetention(testPool()).sweep();
    const closedAt = (await rowOf(first.id))?.closed_at?.getTime();
    await createPostgresRealtimeConnectionRetention(testPool()).sweep();
    expect((await rowOf(first.id))?.closed_at?.getTime()).toBe(closedAt);
    expect((await rowOf(first.id))?.close_reason).toBe('expired');
  });

  it('[E4-S-004] 스윕 삭제: 닫힌 지 8일 지난 행만 지운다 — 6일 된 닫힌 행 · 오래된 열린 행은 남는다', async () => {
    if (!superuser) return;
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const old = await connectWith(plaintext);
    const recent = await connectWith(plaintext);
    const open = await connectWith(plaintext);
    await disconnectWith(old.id);
    await disconnectWith(recent.id);
    await timeTravel(old.id, `UPDATE realtime_connections SET connected_at = now() - interval '9 days', last_seen_at = now() - interval '9 days', expires_at = now() - interval '9 days' + interval '2 hours', closed_at = now() - interval '8 days' WHERE connection_id = $1`);
    await timeTravel(recent.id, `UPDATE realtime_connections SET connected_at = now() - interval '7 days', last_seen_at = now() - interval '7 days', expires_at = now() - interval '7 days' + interval '2 hours', closed_at = now() - interval '6 days' WHERE connection_id = $1`);
    await timeTravel(open.id, `UPDATE realtime_connections SET connected_at = now() - interval '30 days', last_seen_at = now() - interval '1 minute', expires_at = now() - interval '30 days' + interval '2 hours' WHERE connection_id = $1`);
    await createPostgresRealtimeConnectionRetention(testPool()).sweep();
    expect(await rowOf(old.id)).toBeUndefined();
    expect(await rowOf(recent.id)).toBeDefined();
    // 열린 채 만료된 행은 지우기 전에 먼저 닫힌다 — 같은 스윕에서 지워지지 않는다.
    expect(await rowOf(open.id)).toBeDefined();
  });

  it('[E4-S-005] 앱 롤만 스윕을 부를 수 있다 — admin · AI 감시 롤은 42501', async () => {
    for (const pool of [adminPool, aiWatchPool]) {
      await expect(pool.query('SELECT * FROM public.atmark_realtime_sweep()')).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('[E4-S-006] 핑은 1분 안에는 last_seen 을 다시 쓰지 않는다(코얼레싱) · 2분 지나면 갱신한다', async () => {
    if (!superuser) return;
    const f = await seedFixture(testPool());
    const first = await connectWith((await issueToken(f)).plaintext);
    const t0 = (await rowOf(first.id))?.last_seen_at.getTime();
    await pingWith(first.id);
    expect((await rowOf(first.id))?.last_seen_at.getTime()).toBe(t0);
    await staleBy(first.id, 2);
    const aged = (await rowOf(first.id))?.last_seen_at.getTime() ?? 0;
    await pingWith(first.id);
    expect((await rowOf(first.id))?.last_seen_at.getTime() ?? 0).toBeGreaterThan(aged);
  });

  it('[E4-S-007] 만료된 연결 id 로 $connect 를 다시 시도해도 새 수명을 얻지 못한다(401)', async () => {
    if (!superuser) return;
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const first = await connectWith(plaintext);
    await expireNow(first.id);
    await createPostgresRealtimeConnectionRetention(testPool()).sweep();
    expect((await connectWith(plaintext, { id: first.id })).result.statusCode).toBe(401);
  });

  it('[E4-S-008] SUSPECT: 만료 시각이 지나도 스윕 전의 열린 행에는 핑이 계속 먹는다(last_seen 이 갱신된다) — 대상 함수는 만료를 따로 거르므로 푸시는 가지 않는다', async () => {
    if (!superuser) return;
    const f = await seedFixture(testPool());
    const first = await connectWith((await issueToken(f)).plaintext);
    await expireNow(first.id);
    await pingWith(first.id);
    expect((await rowOf(first.id))?.closed_at).toBeNull();
  });

  // ------------------------------------------------------------------------------------------------------------------------------------
  // 영역 4 — 삭제 금지 · 불변 트리거(소유자도 못 한다)
  // ------------------------------------------------------------------------------------------------------------------------------------
  async function fresh() {
    const f = await seedFixture(testPool());
    const token = await issueToken(f);
    const first = await connectWith(token.plaintext);
    return { f, token, first };
  }

  const identityUpdates: [string, string][] = [
    ['connection_id', `connection_id = 'other-conn='`],
    ['agent_id', `agent_id = '${'e'.repeat(32)}'`],
    ['organization_id', `organization_id = '${randomUUID()}'`],
    ['api_key_id', `api_key_id = '${randomUUID()}'`],
    ['connected_at 앞당김', `connected_at = connected_at - interval '1 day'`],
    ['expires_at 1년 연장', `expires_at = expires_at + interval '1 year'`],
    ['expires_at 단축', `expires_at = expires_at - interval '1 hour'`],
  ];
  it.each(numbered('E4-T', identityUpdates))('[%s] 소유자 UPDATE 로 %s 를 바꾸려 하면 트리거가 거부한다', async (_id, _label, set) => {
    const { first } = await fresh();
    await expect(owner().query(`UPDATE realtime_connections SET ${set} WHERE connection_id = $1`, [first.id])).rejects.toThrow();
    const row = await rowOf(first.id);
    expect(row?.closed_at).toBeNull();
  });

  const closedUpdates: [string, string][] = [
    ['closed_at 되돌리기(NULL)', 'closed_at = NULL, close_reason = NULL'],
    ['close_reason 바꾸기', `close_reason = 'expired'`],
    ['closed_at 바꾸기', `closed_at = closed_at + interval '1 minute'`],
    ['last_seen_at 바꾸기', `last_seen_at = last_seen_at + interval '1 second'`],
  ];
  it.each(numbered('E4-C', closedUpdates))('[%s] 닫힌 행의 %s → 거부', async (_id, _label, set) => {
    const { first } = await fresh();
    await disconnectWith(first.id);
    await expect(owner().query(`UPDATE realtime_connections SET ${set} WHERE connection_id = $1`, [first.id])).rejects.toThrow();
  });

  it('[E4-T-008] 소유자가 닫는 시각을 과거로 적어도 DB 가 지금으로 덮는다', async () => {
    const { first } = await fresh();
    await owner().query(`UPDATE realtime_connections SET closed_at = '2000-01-01', close_reason = 'disconnect' WHERE connection_id = $1`, [first.id]);
    const row = await rowOf(first.id);
    expect(row?.closed_at?.getTime() ?? 0).toBeGreaterThan(Date.now() - 60_000);
  });

  it('[E4-T-009] 알 수 없는 close_reason → CHECK 거부', async () => {
    const { first } = await fresh();
    await expect(owner().query(`UPDATE realtime_connections SET closed_at = now(), close_reason = 'bogus' WHERE connection_id = $1`, [first.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('[E4-T-010] closed_at 만 있고 close_reason 이 없으면 → CHECK 거부', async () => {
    const { first } = await fresh();
    await expect(owner().query(`UPDATE realtime_connections SET closed_at = now() WHERE connection_id = $1`, [first.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('[E4-T-011] close_reason 만 있고 closed_at 이 없으면 → CHECK 거부', async () => {
    const { first } = await fresh();
    await expect(owner().query(`UPDATE realtime_connections SET close_reason = 'disconnect' WHERE connection_id = $1`, [first.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('[E4-T-012] last_seen_at 을 과거로 되돌려도 줄지 않는다 · 미래로 밀어도 지금을 넘지 않는다', async () => {
    const { first } = await fresh();
    const before = (await rowOf(first.id))?.last_seen_at.getTime() ?? 0;
    await owner().query(`UPDATE realtime_connections SET last_seen_at = connected_at WHERE connection_id = $1`, [first.id]).catch(() => undefined);
    expect((await rowOf(first.id))?.last_seen_at.getTime() ?? 0).toBeGreaterThanOrEqual(before);
    await owner().query(`UPDATE realtime_connections SET last_seen_at = now() + interval '1 year' WHERE connection_id = $1`, [first.id]);
    expect((await rowOf(first.id))?.last_seen_at.getTime() ?? 0).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it('[E4-T-013] 소유자 직접 INSERT: 만료를 100년 뒤로 적어도 연결 + 2시간으로 덮인다', async () => {
    const { f, token } = await fresh();
    const id = newConnectionId();
    await owner().query(
      `INSERT INTO realtime_connections (connection_id, agent_id, organization_id, api_key_id, expires_at, connected_at) VALUES ($1, $2, $3, $4, now() + interval '100 years', now() - interval '1 year')`,
      [id, f.agentId, f.organizationId, token.id],
    );
    const row = await rowOf(id);
    expect((row?.expires_at.getTime() ?? 0) - (row?.connected_at.getTime() ?? 0)).toBe(2 * 3600 * 1000);
    expect(row?.connected_at.getTime() ?? 0).toBeGreaterThan(Date.now() - 60_000);
  });

  it('[E4-T-014] 소유자 직접 INSERT: 이미 닫힌 채로 만들 수 없다', async () => {
    const { f, token } = await fresh();
    await expect(
      owner().query(`INSERT INTO realtime_connections (connection_id, agent_id, organization_id, api_key_id, expires_at, closed_at, close_reason) VALUES ($1, $2, $3, $4, now() + interval '1 hour', now(), 'gone')`, [newConnectionId(), f.agentId, f.organizationId, token.id]),
    ).rejects.toThrow();
  });

  it('[E4-T-015] 소유자 직접 INSERT 로도 6번째 열린 연결은 만들 수 없다(53400)', async () => {
    const { f, token } = await fresh();
    for (let i = 0; i < 4; i += 1) await connectWith(token.plaintext);
    await expect(
      owner().query(`INSERT INTO realtime_connections (connection_id, agent_id, organization_id, api_key_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [newConnectionId(), f.agentId, f.organizationId, token.id]),
    ).rejects.toMatchObject({ code: '53400' });
  });

  it('[E4-T-016] 다른 조직의 id 로 행을 만들어도(조직 컬럼 위조) FK 가 거부한다', async () => {
    const { f, token } = await fresh();
    await expect(
      owner().query(`INSERT INTO realtime_connections (connection_id, agent_id, organization_id, api_key_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [newConnectionId(), f.agentId, randomUUID(), token.id]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('[E4-T-017] SUSPECT: 소유자 직접 INSERT 는 행의 organization_id 가 에이전트의 조직과 달라도 받는다 — 복합 FK 가 없다(정의 함수는 에이전트에서 조직을 구하므로 앱 롤 경로는 안전)', async () => {
    const a = await fresh();
    const b = await fresh();
    const id = newConnectionId();
    await owner().query(`INSERT INTO realtime_connections (connection_id, agent_id, organization_id, api_key_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [id, a.f.agentId, b.f.organizationId, a.token.id]);
    expect((await rowOf(id))?.organization_id).toBe(b.f.organizationId);
  });

  it('[E4-T-018] SUSPECT: 소유자 직접 INSERT 는 연결의 에이전트와 토큰(api_key_id)의 에이전트가 달라도 받는다 — 정의 함수 경로만 일치를 검사한다(소유자 경로는 위협 모델 밖)', async () => {
    const a = await fresh();
    const b = await fresh();
    const id = newConnectionId();
    await owner().query(`INSERT INTO realtime_connections (connection_id, agent_id, organization_id, api_key_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [id, a.f.agentId, a.f.organizationId, b.token.id]);
    expect((await rowOf(id))?.api_key_id).toBe(b.token.id);
  });

  it('[E4-D-001] DELETE: 열린 행은 소유자도 못 지운다', async () => {
    const { first } = await fresh();
    await expect(owner().query('DELETE FROM realtime_connections WHERE connection_id = $1', [first.id])).rejects.toThrow(/closed more than 7 days ago/);
    expect(await rowOf(first.id)).toBeDefined();
  });

  it('[E4-D-002] DELETE: 방금 닫힌 행도 못 지운다', async () => {
    const { first } = await fresh();
    await disconnectWith(first.id);
    await expect(owner().query('DELETE FROM realtime_connections WHERE connection_id = $1', [first.id])).rejects.toThrow();
  });

  it('[E4-D-003] DELETE ... WHERE true (전체) → 거부 · 아무 행도 사라지지 않는다', async () => {
    const { first } = await fresh();
    await expect(owner().query('DELETE FROM realtime_connections')).rejects.toThrow();
    expect(await rowOf(first.id)).toBeDefined();
  });

  it('[E4-D-004] TRUNCATE → 거부', async () => {
    await fresh();
    await expect(owner().query('TRUNCATE realtime_connections')).rejects.toThrow();
  });

  it('[E4-D-005] 에이전트를 지우려 하면 연결 행이 RESTRICT 로 막는다', async () => {
    const { f } = await fresh();
    await expect(owner().query('DELETE FROM agents WHERE id = $1', [f.agentId])).rejects.toThrow();
  });

  // ------------------------------------------------------------------------------------------------------------------------------------
  // 영역 4 — DB 롤 권한(앱 롤 직접 SQL)
  // ------------------------------------------------------------------------------------------------------------------------------------
  const appStatements: [string, string][] = [
    ['SELECT', 'SELECT count(*) FROM realtime_connections'],
    ['INSERT', `INSERT INTO realtime_connections (connection_id, agent_id, organization_id, api_key_id, expires_at) VALUES ('x=', '${'a'.repeat(32)}', '${randomUUID()}', '${randomUUID()}', now())`],
    ['UPDATE', `UPDATE realtime_connections SET last_seen_at = now()`],
    ['UPDATE closed', `UPDATE realtime_connections SET closed_at = now(), close_reason = 'gone'`],
    ['DELETE', 'DELETE FROM realtime_connections'],
    ['TRUNCATE', 'TRUNCATE realtime_connections'],
    ['ALTER TABLE DISABLE TRIGGER', 'ALTER TABLE realtime_connections DISABLE TRIGGER ALL'],
    ['DROP TRIGGER', 'DROP TRIGGER realtime_connections_delete_guard ON realtime_connections'],
    ['ALTER TABLE DROP CONSTRAINT', 'ALTER TABLE realtime_connections DROP CONSTRAINT realtime_connections_ttl'],
    ['GRANT 자기에게', 'GRANT ALL ON realtime_connections TO atmark_app'],
    ['트리거 함수 직접 호출', 'SELECT public.realtime_connections_guard()'],
    ['삭제 가드 함수 직접 호출', 'SELECT public.realtime_connections_delete_guard()'],
    ['AI 감시 대상 함수', `SELECT * FROM public.atmark_realtime_job_targets('${randomUUID()}')`],
    ['session_replication_role 변경', `SET session_replication_role = replica`],
    ['SET ROLE admin', 'SET ROLE atmark_admin'],
    ['SET ROLE 소유자', 'SET ROLE postgres'],
    ['CREATE OR REPLACE 함수 덮어쓰기', `CREATE OR REPLACE FUNCTION public.atmark_realtime_inbound_targets(uuid[]) RETURNS TABLE (connection_id text, agent_id text, inbound_message_id uuid, thread_id uuid, received_at timestamptz, risk_level text) LANGUAGE sql AS 'SELECT NULL::text, NULL::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::text'`],
    ['정의 함수 소유자 변경', 'ALTER FUNCTION public.atmark_realtime_connect(text, text, text) OWNER TO atmark_app'],
    ['표 통계 우회 COPY', 'COPY realtime_connections TO STDOUT'],
  ];

  it.each(numbered('E4-R', appStatements))('[%s] 앱 롤 직접 SQL: %s → 거부(42501 또는 문법/권한 오류)', async (_id, label, sql) => {
    await expect(testPool().query(sql), label).rejects.toBeDefined();
  });

  const crossRole: [string, () => Pool, string][] = [
    ['admin → connect', () => adminPool, `SELECT public.atmark_realtime_connect('x=', '${'a'.repeat(32)}', '${'b'.repeat(64)}')`],
    ['admin → seen', () => adminPool, `SELECT public.atmark_realtime_seen('x=')`],
    ['admin → approval_targets', () => adminPool, `SELECT * FROM public.atmark_realtime_approval_targets('${randomUUID()}')`],
    ['admin → job_targets', () => adminPool, `SELECT * FROM public.atmark_realtime_job_targets('${randomUUID()}')`],
    ['ai_watch → connect', () => aiWatchPool, `SELECT public.atmark_realtime_connect('x=', '${'a'.repeat(32)}', '${'b'.repeat(64)}')`],
    ['ai_watch → seen', () => aiWatchPool, `SELECT public.atmark_realtime_seen('x=')`],
    ['ai_watch → inbound_targets', () => aiWatchPool, `SELECT * FROM public.atmark_realtime_inbound_targets(ARRAY['${randomUUID()}']::uuid[])`],
    ['ai_watch → approval_targets', () => aiWatchPool, `SELECT * FROM public.atmark_realtime_approval_targets('${randomUUID()}')`],
    ['app → job_targets (AI 감시 전용)', () => testPool(), `SELECT * FROM public.atmark_realtime_job_targets('${randomUUID()}')`],
  ];
  it.each(numbered('E4-X', crossRole))('[%s] 롤 간 함수 권한: %s → 42501', async (_id, _label, pool, sql) => {
    await expect(pool().query(sql)).rejects.toMatchObject({ code: '42501' });
  });

  it('[E4-R-021] 앱 롤이 임시 표 realtime_connections 를 만들어 이름을 가려도(shadow) 정의 함수는 진짜 표를 쓴다', async () => {
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const client = await testPool().connect();
    try {
      await client.query('CREATE TEMP TABLE realtime_connections (connection_id text, agent_id text, closed_at timestamptz)').catch(() => undefined);
      await client.query(`CREATE TEMP TABLE agents (id text, status text, organization_id uuid)`).catch(() => undefined);
      await client.query(`CREATE TEMP TABLE agent_api_keys (id uuid)`).catch(() => undefined);
      const id = newConnectionId();
      const { hash } = await issueToken(f);
      const outcome = await client.query<{ outcome: string }>('SELECT public.atmark_realtime_connect($1, $2, $3) AS outcome', [id, f.agentId, hash]);
      expect(outcome.rows[0]?.outcome).toBe('connected');
      expect((await rowOf(id))?.agent_id).toBe(f.agentId);
    } finally {
      client.release();
    }
    void plaintext;
  });

  it('[E4-R-022] 앱 롤이 pg_temp 함수로 연산자 · now() 를 가려도 정의 함수 결과가 바뀌지 않는다', async () => {
    const f = await seedFixture(testPool());
    const { hash } = await issueToken(f);
    const client = await testPool().connect();
    try {
      await client.query(`CREATE FUNCTION pg_temp.now() RETURNS timestamptz LANGUAGE sql AS $$ SELECT '2000-01-01'::timestamptz $$`).catch(() => undefined);
      await client.query(`SET search_path = pg_temp, public`);
      const id = newConnectionId();
      const outcome = await client.query<{ outcome: string }>('SELECT public.atmark_realtime_connect($1, $2, $3) AS outcome', [id, f.agentId, hash]);
      expect(outcome.rows[0]?.outcome).toBe('connected');
      expect((await rowOf(id))?.connected_at.getTime() ?? 0).toBeGreaterThan(Date.now() - 60_000);
    } finally {
      await client.query('RESET search_path').catch(() => undefined);
      client.release();
    }
  });

  const badReasons: [string, string | null][] = [
    ['expired', 'expired'],
    ['stale', 'stale'],
    ['빈 문자열', ''],
    ['NULL', null],
    ['대문자 DISCONNECT', 'DISCONNECT'],
    ['SQL 조각', `disconnect'; DROP TABLE realtime_connections;--`],
    ['gone 뒤 공백', 'gone '],
  ];
  it.each(numbered('E4-Z', badReasons))('[%s] atmark_realtime_disconnect 사유 "%s" → 거부 · 행은 열린 채', async (_id, _label, reason) => {
    const { first } = await fresh();
    await expect(testPool().query('SELECT public.atmark_realtime_disconnect($1, $2)', [first.id, reason])).rejects.toBeDefined();
    expect((await rowOf(first.id))?.closed_at).toBeNull();
  });

  it('[E4-Z-008] 다른 제한 롤(billing · tlog · passport · login_mailer · ops …)은 표도 함수도 권한이 없다(카탈로그)', async () => {
    const roles = (await owner().query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'atmark\\_%' AND rolname NOT IN ('atmark_app', 'atmark_admin', 'atmark_ai_watch')`)).rows.map((r) => r.rolname);
    expect(roles.length).toBeGreaterThan(3);
    const functions = ['atmark_realtime_connect(text,text,text)', 'atmark_realtime_disconnect(text,text)', 'atmark_realtime_seen(text)', 'atmark_realtime_inbound_targets(uuid[])', 'atmark_realtime_job_targets(uuid)', 'atmark_realtime_approval_targets(uuid)', 'atmark_realtime_sweep()'];
    const granted: string[] = [];
    for (const role of roles) {
      const table = await owner().query<{ ok: boolean }>(`SELECT has_table_privilege($1, 'public.realtime_connections', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ok`, [role]);
      if (table.rows[0]?.ok) granted.push(`${role}:table`);
      for (const fn of functions) {
        const exec = await owner().query<{ ok: boolean }>(`SELECT has_function_privilege($1, 'public.${fn}', 'EXECUTE') AS ok`, [role]);
        if (exec.rows[0]?.ok) granted.push(`${role}:${fn}`);
      }
    }
    expect(granted).toEqual([]);
  });

  it('[E4-Z-009] PUBLIC 에는 표 권한도 함수 실행도 없다', async () => {
    const result = await owner().query<{ table_ok: boolean; fn_ok: boolean }>(
      `SELECT has_table_privilege('public', 'public.realtime_connections', 'SELECT,INSERT,UPDATE,DELETE') AS table_ok,
              (SELECT bool_or(has_function_privilege('public', p.oid, 'EXECUTE')) FROM pg_proc p WHERE p.proname LIKE 'atmark\\_realtime\\_%' OR p.proname LIKE 'realtime\\_connections\\_%') AS fn_ok`,
    );
    expect(result.rows[0]).toEqual({ table_ok: false, fn_ok: false });
  });

  it('[E4-Z-010] 모든 실시간 정의 함수는 SECURITY DEFINER · search_path 고정(pg_temp 마지막)이다', async () => {
    const result = await owner().query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT proname, prosecdef, proconfig FROM pg_proc WHERE proname LIKE 'atmark\\_realtime\\_%'`,
    );
    expect(result.rows).toHaveLength(7);
    for (const row of result.rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      const config = (row.proconfig ?? []).find((c) => c.startsWith('search_path=')) ?? '';
      expect(config, row.proname).toMatch(/pg_temp$/);
      expect(config, row.proname).toMatch(/^search_path=pg_catalog/);
    }
  });
});
