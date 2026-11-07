/**
 * 실시간 WebSocket(묶음 E · 202610081300) — **실제 Postgres** 위에서 운영과 같은 저장소 · 롤(앱 · admin · AI 감시)로.
 *
 *   ① `$connect`/`$disconnect` — 연결 행(앱 롤 · 정의 함수만) · 하위 프로토콜 · 쿼리 토큰 거부 · 권한 · 폐기 토큰 · 정지된 에이전트 · 조직 정지 ·
 *      에이전트당 5개(DB 트리거 — 6번째 429, 하나 닫으면 다시) · 닫기는 한 번 · 앱 롤은 표를 직접 읽거나 쓰지 못한다.
 *   ② 만료 · 핑 없음 — 스윕이 닫고(expired · stale), 7일 넘게 닫힌 행만 지운다(트리거가 그 밖의 DELETE 를 거부).
 *   ③ 푸시 대상 — 보이는 메일만: 보통 수신은 밀고 · 격리(high) · 위험 보류(hold) · AI 보류 중은 0 · 풀기(admin 롤) · AI 판정(AI 감시 롤)이 민다.
 *   ④ 에이전트 격리 — A 의 메일은 A 의 연결에만(B 의 연결은 대상이 아니다) · 남의 메일 id 를 넘겨도 그 메일의 에이전트에게만 · 폐기된 토큰의 연결은 받지 않는다.
 *   ⑤ 승인 결과 — 결정된 요청만 · 그 에이전트의 연결에만.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { releaseHeldOp } from '../../../src/admin/ops/watch';
import { createPostgresAiWatchResultStore } from '../../../src/db/repositories/ai-watch-result-store';
import { createPostgresAiWatchInboundPort } from '../../../src/db/repositories/inbound-store';
import {
  createPostgresRealtimeApprovalTargets,
  createPostgresRealtimeConnectionRetention,
  createPostgresRealtimeInboundTargets,
  createPostgresRealtimeJobTargets,
} from '../../../src/db/repositories/realtime-connection-store';
import { parseAiWatchRequest } from '../../../src/inbound/ai-watch/contract';
import type { InjectionScanInput, InjectionScanResult } from '../../../src/security/injection/scanner';
import type { InboundConsumerDependencies } from '../../../src/workers/inbound-consumer';
import {
  connectWith,
  disconnectWith,
  expireNow,
  fakeTransport,
  isSuperuser,
  issueToken,
  owner,
  pushing,
  receiveMail,
  rolePool,
  rowOf,
  staleBy,
  timeTravel,
} from '../adversarial/realtime-support';
import { closeTestPool, DATABASE_AVAILABLE, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { consumerDeps, newObjectStore } from '../inbound/support';

const OWNER_AVAILABLE = DATABASE_AVAILABLE && (process.env['TEST_MIGRATION_DATABASE_URL'] ?? '').trim() !== '';

function scanner(risk: InjectionScanResult['injectionRisk'], quarantine = risk === 'high' || risk === 'medium') {
  return (_input: InjectionScanInput): InjectionScanResult =>
    ({
      injectionRisk: risk,
      scannerVersion: 'test-realtime-1',
      quarantine,
      findings:
        risk === 'none'
          ? []
          : // 위험 등급이 되는 계열(받기 등급 — 본문 low + 행동 계열) · 격리는 high.
            [{ ruleId: 'test.override', family: 'override', field: 'text', view: 'raw', fieldIndex: 0, start: 0, end: 1, weight: 1, damped: false }],
    }) as unknown as InjectionScanResult;
}

describe.skipIf(!OWNER_AVAILABLE)('실시간 WebSocket — 연결 · 대상 · 격리 (Postgres)', () => {
  const objects = newObjectStore();
  let adminPool: Pool;
  let aiWatchPool: Pool;

  beforeAll(() => {
    adminPool = rolePool('atmark_admin');
    aiWatchPool = rolePool('atmark_ai_watch');
  });

  afterAll(async () => {
    await adminPool.end();
    await aiWatchPool.end();
    await closeTestPool();
  });

  async function receive(f: Fixture, deps: InboundConsumerDependencies): Promise<string> {
    const { id, outcome } = await receiveMail(f, deps);
    expect(outcome).toBe('stored');
    return id;
  }

  it('① 연결 · 하위 프로토콜 · 끊기 — 행은 그 에이전트 · 만료 = 연결 + 2시간(DB 가 정한다) · 닫기는 한 번', async () => {
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const header = await connectWith(plaintext);
    expect(header.result).toEqual({ statusCode: 200 });
    const browser = await connectWith(plaintext, { via: 'subprotocol' });
    expect(browser.result).toEqual({ statusCode: 200, headers: { 'Sec-WebSocket-Protocol': 'atmark.v1' } });
    const row = await rowOf(header.id);
    expect(row?.agent_id).toBe(f.agentId);
    expect((row?.expires_at.getTime() ?? 0) - (row?.connected_at.getTime() ?? 0)).toBe(2 * 3600 * 1000);
    // 같은 연결 id 로 다시 — duplicate(200), 행은 하나.
    expect((await connectWith(plaintext, { id: header.id })).result.statusCode).toBe(200);

    expect(await disconnectWith(header.id)).toEqual({ statusCode: 200 });
    const closed = await rowOf(header.id);
    expect(closed?.close_reason).toBe('disconnect');
    expect(closed?.closed_at).not.toBeNull();
    // 닫힌 행은 되살리지 못한다(소유자로도 — 트리거).
    await expect(owner().query('UPDATE realtime_connections SET closed_at = NULL, close_reason = NULL WHERE connection_id = $1', [header.id])).rejects.toThrow(
      /closed realtime connection cannot change/,
    );
    // 두 번째 끊기는 아무것도 바꾸지 않는다.
    await disconnectWith(header.id);
    expect((await rowOf(header.id))?.closed_at?.getTime()).toBe(closed?.closed_at?.getTime());
  });

  it('① 거부 — 쿼리 토큰 400(행 없음) · messages:read 없음 403 · 폐기 401 · 정지된 에이전트 · 조직 정지 403', async () => {
    const f = await seedFixture(testPool());
    const { plaintext, id: keyId } = await issueToken(f);
    const query = await connectWith(plaintext, { query: { token: plaintext } });
    expect(query.result.statusCode).toBe(400);
    expect(await rowOf(query.id)).toBeUndefined();

    const sendOnly = await issueToken(f, ['messages:send']);
    expect((await connectWith(sendOnly.plaintext)).result.statusCode).toBe(403);

    await owner().query('UPDATE organizations SET owner_paused = true WHERE id = $1', [f.organizationId]);
    expect((await connectWith(plaintext)).result.statusCode).toBe(403);
    await owner().query('UPDATE organizations SET owner_paused = false WHERE id = $1', [f.organizationId]);

    await owner().query(`UPDATE agents SET status = 'suspended', suspended_by = 'owner' WHERE id = $1`, [f.agentId]);
    expect((await connectWith(plaintext)).result.statusCode).toBe(403);
    await owner().query(`UPDATE agents SET status = 'active', suspended_by = NULL WHERE id = $1`, [f.agentId]);

    await owner().query('UPDATE agent_api_keys SET revoked_at = now() WHERE id = $1', [keyId]);
    expect((await connectWith(plaintext)).result.statusCode).toBe(401);
  });

  it('① 에이전트당 열린 연결 5 — 6번째 429 · 하나 닫으면 다시 열린다 · 다른 에이전트는 따로 센다', async () => {
    const f = await seedFixture(testPool());
    const other = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const opened = await connectWith(plaintext);
      expect(opened.result.statusCode, String(i)).toBe(200);
      ids.push(opened.id);
    }
    const sixth = await connectWith(plaintext);
    expect(sixth.result.statusCode).toBe(429);
    expect(await rowOf(sixth.id)).toBeUndefined();
    expect((await connectWith((await issueToken(other)).plaintext)).result.statusCode).toBe(200);
    await disconnectWith(ids[0] ?? '');
    expect((await connectWith(plaintext)).result.statusCode).toBe(200);
  });

  it('① 앱 롤은 연결 표를 직접 읽거나 쓰지 못한다(정의 함수로만) · admin · AI 감시 롤도', async () => {
    for (const pool of [testPool(), adminPool, aiWatchPool]) {
      await expect(pool.query('SELECT count(*) FROM realtime_connections')).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      testPool().query(`INSERT INTO realtime_connections (connection_id, agent_id, organization_id, api_key_id, expires_at) VALUES ('x', $1, $2, $3, now())`, [
        'a'.repeat(32),
        randomUUID(),
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    // admin 은 연결을 만들 수 없다(EXECUTE 없음).
    await expect(adminPool.query("SELECT public.atmark_realtime_connect('x', $1, $2)", ['a'.repeat(32), 'b'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
  });

  it('② 스윕 — 만료 · 핑 15분 없는 열린 행을 닫고 · 7일 넘게 닫힌 행만 지운다(그 밖의 DELETE 는 트리거가 거부)', async () => {
    const superuser = await isSuperuser();
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const expired = await connectWith(plaintext);
    const stale = await connectWith(plaintext);
    const fresh = await connectWith(plaintext);
    const old = await connectWith(plaintext);
    await disconnectWith(old.id);
    await expect(owner().query('DELETE FROM realtime_connections WHERE connection_id = $1', [old.id])).rejects.toThrow(/closed more than 7 days ago/);
    if (!superuser) return;
    // 시간 여행 — 트리거를 끄고 시각을 옮긴다(소유자 · 초사용자). 운영 경로에는 없다.
    await expireNow(expired.id);
    await staleBy(stale.id, 20);
    await timeTravel(
      old.id,
      `UPDATE realtime_connections SET connected_at = now() - interval '9 days', last_seen_at = now() - interval '9 days', expires_at = now() - interval '9 days' + interval '2 hours', closed_at = now() - interval '8 days' WHERE connection_id = $1`,
    );
    const swept = await createPostgresRealtimeConnectionRetention(testPool()).sweep();
    expect(swept?.closed).toBeGreaterThanOrEqual(2);
    expect(swept?.purged).toBeGreaterThanOrEqual(1);
    expect((await rowOf(expired.id))?.close_reason).toBe('expired');
    expect((await rowOf(stale.id))?.close_reason).toBe('stale');
    expect((await rowOf(fresh.id))?.closed_at).toBeNull();
    expect(await rowOf(old.id)).toBeUndefined();
  });

  it('③ ★ 보통 수신은 민다 · 격리(high) · 위험 보류(hold) 메일은 밀지 않는다 — 풀면(admin 롤 대상 함수) 그때 민다', async () => {
    const f = await seedFixture(testPool());
    const { plaintext } = await issueToken(f);
    const a = await connectWith(plaintext);
    const transport = fakeTransport();
    const base = (risk: InjectionScanResult['injectionRisk']): InboundConsumerDependencies => ({
      ...consumerDeps(testPool(), objects),
      scanner: scanner(risk),
      realtime: pushing(transport),
    });

    const normal = await receive(f, base('none'));
    expect(transport.posted.map((p) => [p.connectionId, (p.frame['data'] as { message_id: string }).message_id])).toEqual([[a.id, normal]]);
    const frame = transport.posted[0]?.frame ?? {};
    expect(frame).toMatchObject({ type: 'message.received', agent_id: f.agentId, data: { message_id: normal, risk: { level: 'none' } } });
    // 프레임에 보낸 사람 · 제목 · 본문이 없다.
    expect(JSON.stringify(frame)).not.toMatch(/partner\.example|"hi"|Tuesday/);

    const quarantined = await receive(f, base('high'));
    expect(transport.posted).toHaveLength(1);
    await owner().query('SELECT * FROM atmark_watch_set_agent($1, $2, $3, $4, $5)', [f.organizationId, f.agentId, 'hold', true, randomUUID()]);
    const riskHeld = await receive(f, base('low'));
    const level = await owner().query<{ watch_level: string | null; quarantined: boolean }>('SELECT watch_level, quarantined FROM inbound_messages WHERE id = $1', [riskHeld]);
    expect(level.rows[0]).toMatchObject({ quarantined: true });
    expect(transport.posted).toHaveLength(1);
    // 대상 함수를 직접 불러도 숨은 메일은 0행.
    expect(await createPostgresRealtimeInboundTargets(testPool()).inboundTargets?.([quarantined, riskHeld])).toEqual([]);

    // 풀기 — admin 롤로 커밋한 뒤 민다(콘솔 경로와 같은 순서).
    const userId = randomUUID();
    const adminPusher = pushing(transport, createPostgresRealtimeInboundTargets(adminPool));
    for (const id of [quarantined, riskHeld]) {
      const released = await releaseHeldOp(owner(), f.organizationId, userId, id);
      expect(released.kind).toBe('released');
      await adminPusher.messagesVisible([id]);
    }
    expect(transport.posted.map((p) => (p.frame['data'] as { message_id: string; risk: { level: string } }).message_id)).toEqual([normal, quarantined, riskHeld]);
    expect((transport.posted[2]?.frame['data'] as { risk: { level: string } }).risk.level).toBe('risk');
  });

  it('③ AI 감시 보류 중엔 밀지 않고 · 판정(AI 감시 롤)이 풀면 그 작업의 메일을 민다', async () => {
    await owner().query(
      `UPDATE ai_watch_runtime SET last_heartbeat_at = now(), draining = false, self_test_ok = true, model_version = 'laya-ml-aw-2026.10.1-int8', worker_id = 'test' WHERE id`,
    );
    const f = await seedFixture(testPool());
    await owner().query(`INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, 'ai_mail_watch', 'test')`, [f.organizationId]);
    await owner().query('UPDATE organizations SET ai_mail_watch_enabled = true WHERE id = $1', [f.organizationId]);
    const { plaintext } = await issueToken(f);
    const a = await connectWith(plaintext);
    const transport = fakeTransport();
    const bodies: string[] = [];
    const deps: InboundConsumerDependencies = {
      ...consumerDeps(testPool(), objects),
      scanner: scanner('none'),
      realtime: pushing(transport),
      aiWatch: { mode: 'on', store: createPostgresAiWatchInboundPort(testPool()), queue: { send: (body) => Promise.resolve(void bodies.push(body)) } },
    };
    const held = await receive(f, deps);
    const hold = await owner().query<{ hold: boolean; job: string | null }>(
      'SELECT (ai_hold_until IS NOT NULL AND ai_hold_until > now()) AS hold, ai_watch_job_id AS job FROM inbound_messages WHERE id = $1',
      [held],
    );
    if (hold.rows[0]?.hold !== true) return; // 다른 파일이 하트비트를 바꾼 경합 — 이 단언은 ai-watch.test.ts 가 맡는다.
    expect(transport.posted).toEqual([]);
    expect(await createPostgresRealtimeJobTargets(aiWatchPool).jobTargets?.(hold.rows[0].job ?? '')).toEqual([]);

    const request = parseAiWatchRequest(bodies[0] ?? '');
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    const recorded = await createPostgresAiWatchResultStore(aiWatchPool).recordVerdict({
      jobId: request.value.job_id,
      verdict: 'clear',
      band: null,
      modelVersion: 'laya-ml-aw-2026.10.1-int8',
    });
    expect(recorded.outcome).toBe('recorded');
    await pushing(transport, createPostgresRealtimeJobTargets(aiWatchPool)).aiWatchReleased(request.value.job_id);
    expect(transport.posted.map((p) => [p.connectionId, (p.frame['data'] as { message_id: string }).message_id])).toEqual([[a.id, held]]);
  });

  it('④ ★ 에이전트 격리 — A 의 메일은 A 의 연결에만 · 남의 id 를 넘겨도 그 메일의 에이전트에게만 · 폐기된 토큰의 연결 · 410 은 닫는다', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const tokenA = await issueToken(a);
    const tokenB = await issueToken(b);
    const connA = await connectWith(tokenA.plaintext);
    const connB = await connectWith(tokenB.plaintext);
    const transport = fakeTransport();
    const deps: InboundConsumerDependencies = { ...consumerDeps(testPool(), objects), scanner: scanner('none'), realtime: pushing(transport) };
    const mailA = await receive(a, deps);
    const mailB = await receive(b, deps);
    expect(transport.posted.map((p) => [p.connectionId, p.frame['agent_id']])).toEqual([
      [connA.id, a.agentId],
      [connB.id, b.agentId],
    ]);
    // 두 메일 id 를 한꺼번에 넘겨도 각자의 연결로만 짝이 맞는다.
    const rows = (await createPostgresRealtimeInboundTargets(testPool()).inboundTargets?.([mailA, mailB])) ?? [];
    expect(rows.map((r) => [r.inboundMessageId, r.connectionId, r.agentId]).sort()).toEqual(
      [
        [mailA, connA.id, a.agentId],
        [mailB, connB.id, b.agentId],
      ].sort(),
    );

    // 폐기된 토큰으로 연 연결은 대상이 아니다(연결은 열려 있어도).
    await owner().query('UPDATE agent_api_keys SET revoked_at = now() WHERE id = $1', [tokenB.id]);
    expect(((await createPostgresRealtimeInboundTargets(testPool()).inboundTargets?.([mailB])) ?? []).length).toBe(0);

    // 410 Gone → 행이 닫힌다(앱 롤).
    const gone = fakeTransport(new Set([connA.id]));
    await pushing(gone).messagesVisible([mailA]);
    expect((await rowOf(connA.id))?.close_reason).toBe('gone');
    expect(gone.posted).toEqual([]);
  });

  it('⑤ 승인 결과 — 결정된 요청만 · 그 에이전트의 연결에만', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const connA = await connectWith((await issueToken(a)).plaintext);
    await connectWith((await issueToken(b)).plaintext);
    const approval = await owner().query<{ id: string }>(
      `INSERT INTO approval_requests (id, agent_id, subject, created_at, expires_at) VALUES (gen_random_uuid(), $1, 'message', now(), now() + interval '1 day') RETURNING id`,
      [a.agentId],
    );
    const approvalId = approval.rows[0]?.id ?? '';
    const targets = createPostgresRealtimeApprovalTargets(testPool());
    expect(await targets.approvalTargets?.(approvalId)).toEqual([]);
    await owner().query(`UPDATE approval_requests SET status = 'rejected', decided_at = now(), decided_by = 'test' WHERE id = $1`, [approvalId]);
    const rows = (await targets.approvalTargets?.(approvalId)) ?? [];
    expect(rows.map((r) => [r.connectionId, r.agentId, r.decision])).toEqual([[connA.id, a.agentId, 'rejected']]);
    const transport = fakeTransport();
    await pushing(transport, targets).approvalResolved(approvalId);
    expect(transport.posted).toHaveLength(1);
    expect(transport.posted[0]?.frame).toMatchObject({ type: 'approval.resolved', agent_id: a.agentId, data: { approval_id: approvalId, decision: 'rejected' } });
  });
});
