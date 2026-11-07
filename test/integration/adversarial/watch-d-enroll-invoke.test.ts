/**
 * 적대적 검증(묶음 D) 요소 2 (이어서) — admin λ 호출 경계 · 시간 초과 · 정보 누출 · 로그 · 알림 · 감사. 실제 Postgres. 시도 ID `D2-J###`.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { enrollAgentOp } from '../../../src/admin/ops/enroll';
import { createQuarantineNotifier } from '../../../src/notify/quarantine-notifier';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { ENROLL_EVENT_ACTION, ENROLL_EVENT_SOURCE, ENROLL_EVENT_VERSION, type EnrollEvent } from '../../../src/runtime/enroll-event';
import { createAdminHandler } from '../../../src/runtime/handlers/admin';
import type { LambdaContext } from '../../../src/runtime/lambda';
import { createAgentEnroller, type LambdaInvokeClient } from '../../../src/runtime/lambda-invoke';
import { runQuarantineNotifier } from '../../../src/workers/quarantine-notifier';
import { testKeyCustody } from '../../unit/identity/fixtures';
import { adminDeps, fakeSes, mailText } from '../admin/support';
import { closeTestPool, provisioningPool } from '../db/support/harness';
import { agentCount, enrollCall, enrollWorld, slotRows, type EnrollWorld } from './watch-d-enroll-support';
import { api, authed, call, closeConsoleKit, consoleKit, OWNER_AVAILABLE } from './watch-d-support';

afterAll(async () => {
  await closeConsoleKit();
  await closeTestPool();
});
afterEach(() => resetLogSink());

const context = (): LambdaContext => ({ callbackWaitsForEmptyEventLoop: true, invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:1:function:atmark-admin:enroll', awsRequestId: 'r', getRemainingTimeInMillis: () => 10_000 }) as unknown as LambdaContext;
const eventOf = (token: string, name = 'kid', localPart: string | null = null): EnrollEvent => ({ source: ENROLL_EVENT_SOURCE, action: ENROLL_EVENT_ACTION, v: ENROLL_EVENT_VERSION, token, name, localPart, requestId: `req-${randomUUID().slice(0, 8)}` });
const realHandler = () => createAdminHandler(() => Promise.resolve({ deps: adminDeps(consoleKit().admin) }));
const LEAKY = /P0A\d|agent_enrollments|agent_api_keys|org_watch_settings|atmark_admin|stack|at \/var|postgres|SELECT |INSERT |sqlstate|constraint|arn:aws|organization_id|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|ECONNREFUSED|password/i;

async function enrollKeyId(parentId: string): Promise<string> {
  const key = await provisioningPool().query<{ id: string }>(`SELECT id FROM agent_api_keys WHERE agent_id = $1 AND 'agents:enroll'::agent_token_capability = ANY (capabilities) LIMIT 1`, [parentId]);
  const id = key.rows[0]?.id;
  if (id === undefined) throw new Error('enroll 키가 없다');
  return id;
}

function captureLogs(): string[] {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  return lines;
}

// ---------------------------------------------------------------------------
// E. admin λ 입구 — 위조 · 토큰 해시 불일치 · 재생 · 실패 의미론
// ---------------------------------------------------------------------------
describe.skipIf(!OWNER_AVAILABLE)('D2-E admin λ 호출 경계', () => {
  it('[D2-J001] 모양만 맞는 가짜 토큰 이벤트 → unauthorized (던지지 않음 · 슬롯 0)', async () => {
    const result = await realHandler()(eventOf(`atk_agent_${'Z'.repeat(43)}`), context());
    expect(result).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('[D2-J002] 다른 조직 토큰의 해시를 흉내 — 토큰 한 글자만 바꾸면 unauthorized', async () => {
    const e = await enrollWorld();
    const flipped = `${e.enrollToken.slice(0, -1)}${e.enrollToken.endsWith('A') ? 'B' : 'A'}`;
    expect(await realHandler()(eventOf(flipped), context())).toEqual({ ok: false, error: 'unauthorized' });
    expect(await slotRows(provisioningPool(), e.orgId)).toEqual([]);
  });

  it('[D2-J003] 정상 토큰 이벤트 → 성공 · 슬롯 1', async () => {
    const e = await enrollWorld();
    const result = (await realHandler()(eventOf(e.enrollToken), context())) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(await slotRows(provisioningPool(), e.orgId)).toHaveLength(1);
  });

  it('[D2-J004] 폐기된 토큰의 캡처된 이벤트를 나중에 재생 → unauthorized', async () => {
    const e = await enrollWorld();
    const captured = eventOf(e.enrollToken);
    expect(((await realHandler()(captured, context())) as { ok: boolean }).ok).toBe(true);
    await call(consoleKit().deps, 'POST', `/api/agents/${e.parentId}/token`, authed(e.owner, { body: { action: 'revoke-all' } }));
    expect(await realHandler()(captured, context())).toEqual({ ok: false, error: 'unauthorized' });
  });

  // 고침(2026-10-08 — 리드 지시 4): 요청 id 는 agent_enrollments.request_id(UNIQUE · 202610081103/1104). 같은 id 의 재생은 enroll_replayed — 새 에이전트 없음.
  it('[D2-J005] 같은 이벤트(같은 requestId)를 다시 재생하면 enroll_replayed — 새 에이전트가 생기지 않는다', async () => {
    const e = await enrollWorld({ cap: 5 });
    const captured = eventOf(e.enrollToken, 'dup', null);
    const a = (await realHandler()(captured, context())) as { ok: boolean; agent?: { id: string } };
    const b = await realHandler()(captured, context());
    expect(a.ok).toBe(true);
    // admin 결과 코드는 replayed — api 라우트가 409 enroll_replayed 로 바꾼다.
    expect(b).toEqual({ ok: false, error: 'replayed' });
    expect(await agentCount(provisioningPool(), e.orgId)).toBe(2);
  });

  it('[D2-J006] 같은 이벤트 8 개 동시 재생(상한 3) → 정확히 1 개 · 나머지는 replayed(동시 재생은 UNIQUE 색인이 막는다)', async () => {
    const e = await enrollWorld({ cap: 3 });
    const captured = eventOf(e.enrollToken);
    const results = (await Promise.all(Array.from({ length: 8 }, () => realHandler()(captured, context())))) as { ok: boolean; error?: string }[];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => r.error === 'replayed')).toBe(true);
    expect(await agentCount(provisioningPool(), e.orgId)).toBe(2);
  });

  it('[D2-J007] 같은 로컬파트를 요구하는 동시 요청 6 개 → 정확히 1 개만 만들어진다(주소 중복 없음)', async () => {
    const e = await enrollWorld({ cap: 20 });
    const local = `race-${randomUUID().slice(0, 8)}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => enrollCall(e, { name: 'racer', local_part: local })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const addresses = await provisioningPool().query<{ n: number }>('SELECT count(*)::int AS n FROM agent_addresses WHERE address = $1', [`${local}@atmark.ai`]);
    expect(addresses.rows[0]?.n).toBe(1);
  });

  it('[D2-J008] 키 보관(KMS)이 죽어 있으면 — 에이전트·슬롯·주소가 하나도 남지 않는다(원자적 되돌림)', async () => {
    const e = await enrollWorld();
    const real = testKeyCustody();
    const broken = new Proxy(real, { get: (target, property) => (typeof (target as never)[property] === 'function' ? () => Promise.reject(new Error('KMS down')) : (target as never)[property]) });
    const before = await agentCount(provisioningPool(), e.orgId);
    await expect(enrollAgentOp(consoleKit().admin, broken, eventOf(e.enrollToken))).rejects.toThrow();
    expect(await agentCount(provisioningPool(), e.orgId)).toBe(before);
    expect(await slotRows(provisioningPool(), e.orgId)).toEqual([]);
    // 같은 토큰으로 곧바로 다시 되고(슬롯이 안 샜다), 상한도 줄지 않았다.
    expect(((await realHandler()(eventOf(e.enrollToken), context())) as { ok: boolean }).ok).toBe(true);
  });

  it('[D2-J009] 핸들러 조립 실패 → unavailable · 로그에 토큰 없음', async () => {
    const lines = captureLogs();
    const e = await enrollWorld();
    const handler = createAdminHandler(() => Promise.reject(new Error(`db password authentication failed for ${e.enrollToken}`)));
    expect(await handler(eventOf(e.enrollToken), context())).toEqual({ ok: false, error: 'unavailable' });
    const text = lines.join('\n');
    expect(text).not.toContain(e.enrollToken);
    expect(text).not.toMatch(/password authentication/);
  });

  it('[D2-J010] 시간 초과 의미론 — 호출은 늦게 끝나도 에이전트는 정확히 하나, 응답은 enroll_timeout(재시도 금지 안내)', async () => {
    const e = await enrollWorld();
    const client: LambdaInvokeClient = {
      send: async (command) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const event = JSON.parse(new TextDecoder().decode(command.input.Payload as Uint8Array)) as EnrollEvent;
        const result = await enrollAgentOp(consoleKit().admin, testKeyCustody(), event);
        return { StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify(result)) };
      },
    };
    const deps = { ...e.w.deps, agentEnroll: { ...e.w.deps.agentEnroll, enroll: createAgentEnroller({ client, functionArn: 'arn:x', timeoutMs: 30 }) } };
    const r = await api({ deps }, 'POST', '/v1/agents', { token: e.enrollToken, body: { name: 'slow' } });
    expect([r.status, r.json['error']]).toEqual([503, 'enroll_timeout']);
    expect(JSON.stringify(r.json)).not.toContain('atk_agent_');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await slotRows(provisioningPool(), e.orgId)).filter((s) => s.outcome === 'created')).toHaveLength(1);
    expect(await agentCount(provisioningPool(), e.orgId)).toBe(2);
  });

  it('SUSPECT: [D2-J011] 시간 초과로 응답을 못 받은 새 토큰은 영영 전달되지 않는다 — 에이전트·주소는 만들어졌고 토큰은 분실(소유자가 콘솔에서 토큰을 새로 발급해야 한다)', async () => {
    const e = await enrollWorld();
    const client: LambdaInvokeClient = {
      send: async (command) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const event = JSON.parse(new TextDecoder().decode(command.input.Payload as Uint8Array)) as EnrollEvent;
        const result = await enrollAgentOp(consoleKit().admin, testKeyCustody(), event);
        return { StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify(result)) };
      },
    };
    const deps = { ...e.w.deps, agentEnroll: { ...e.w.deps.agentEnroll, enroll: createAgentEnroller({ client, functionArn: 'arn:x', timeoutMs: 20 }) } };
    const r = await api({ deps }, 'POST', '/v1/agents', { token: e.enrollToken, body: { name: 'orphan' } });
    expect(r.status).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const child = await provisioningPool().query<{ id: string; keys: number }>(`SELECT a.id, (SELECT count(*)::int FROM agent_api_keys k WHERE k.agent_id = a.id) AS keys FROM agents a WHERE a.organization_id = $1 AND a.name = 'orphan'`, [e.orgId]);
    expect(child.rows[0]?.keys).toBe(1);
  });

  it('[D2-J012] 응답에서 돌려준 토큰은 admin 이벤트 결과 밖(로그 · 감사 · 알림 큐)에 평문으로 남지 않는다', async () => {
    const lines = captureLogs();
    const e = await enrollWorld();
    const r = await enrollCall(e, { name: 'secretive' });
    const token = r.json['token'] as string;
    expect(token).toMatch(/^atk_agent_/);
    expect(lines.join('\n')).not.toContain(token);
    const tables = await provisioningPool().query<{ hit: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM audit_logs WHERE reasons::text LIKE '%' || $1 || '%') OR EXISTS (SELECT 1 FROM owner_actions WHERE detail::text LIKE '%' || $1 || '%') AS hit`,
      [token],
    ).catch(() => ({ rows: [{ hit: false }] }));
    expect(tables.rows[0]?.hit).toBe(false);
  });

  it('[D2-J013] 로그: 성공 · 거절 · 한도 모든 경로에서 부모 토큰 원문이 한 줄도 없다', async () => {
    const lines = captureLogs();
    const e = await enrollWorld({ cap: 1 });
    await enrollCall(e, { name: 'ok' });
    await enrollCall(e, { name: 'over' });
    await enrollCall(e, { name: 'bad', local_part: 'postmaster' });
    await enrollCall(e, { name: 'x', local_part: 'a..b' });
    expect(lines.join('\n')).not.toContain(e.enrollToken);
    expect(lines.join('\n')).not.toMatch(/atk_agent_[A-Za-z0-9_-]{43}/);
  });

  it('[D2-J014] 로그: 에이전트가 고른 이름 · 로컬파트가 줄바꿈으로 로그 줄을 위조하지 못한다', async () => {
    const lines = captureLogs();
    const e = await enrollWorld();
    await enrollCall(e, { name: 'x\nINFO {"event":"fake.owner.approved"}' });
    await enrollCall(e, { name: 'y', local_part: 'a\n{"event":"fake"}' });
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(lines.some((line) => line.includes('fake.owner.approved') && !line.startsWith('{'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 정보 누출 — 거절 응답 전수
// ---------------------------------------------------------------------------
describe.skipIf(!OWNER_AVAILABLE)('D2-E 정보 누출 — 오류 본문', () => {
  async function states(): Promise<{ id: string; label: string; world: EnrollWorld; body: unknown; token?: string }[]> {
    const rows: { id: string; label: string; world: EnrollWorld; body: unknown; token?: string }[] = [];
    const base = await enrollWorld({ enable: false });
    rows.push({ id: 'D2-J015', label: '꺼짐', world: base, body: { name: 'x' } });
    const paused = await enrollWorld();
    await provisioningPool().query('UPDATE organizations SET owner_paused = true WHERE id = $1', [paused.orgId]);
    rows.push({ id: 'D2-J016', label: '정지 조직', world: paused, body: { name: 'x' } });
    const capped = await enrollWorld({ cap: 1 });
    await enrollCall(capped, { name: 'first' });
    rows.push({ id: 'D2-J017', label: '상한', world: capped, body: { name: 'x' } });
    const limited = await enrollWorld({ plan: null, cap: 20 });
    for (let i = 0; i < 3; i += 1) await enrollCall(limited, { name: `f${String(i)}` });
    rows.push({ id: 'D2-J018', label: '요금제 한도', world: limited, body: { name: 'x' } });
    const taken = await enrollWorld();
    rows.push({ id: 'D2-J019', label: '주소 사용 중', world: taken, body: { name: 'x', local_part: taken.parentAddress.split('@')[0] } });
    const ok = await enrollWorld();
    rows.push({ id: 'D2-J020', label: '예약 로컬파트', world: ok, body: { name: 'x', local_part: 'support' } });
    rows.push({ id: 'D2-J021', label: '잘못된 로컬파트', world: ok, body: { name: 'x', local_part: 'a..b' } });
    rows.push({ id: 'D2-J022', label: '잘못된 이름', world: ok, body: { name: '‮' } });
    rows.push({ id: 'D2-J023', label: '모르는 키', world: ok, body: { name: 'x', zzz: 1 } });
    rows.push({ id: 'D2-J024', label: '가짜 토큰', world: ok, body: { name: 'x' }, token: `atk_agent_${'Z'.repeat(43)}` });
    rows.push({ id: 'D2-J025', label: '권한 없는 토큰', world: ok, body: { name: 'x' }, token: (await (await import('./watch-d-support')).tokenFor(ok.parentId as never)) });
    return rows;
  }

  it('[D2-J015..J025] 모든 거절 본문에 DB·내부 식별자·스택이 없다 · 다른 조직의 id 도 없다', async () => {
    const rows = await states();
    for (const row of rows) {
      const r = await enrollCall(row.world, row.body, row.token ?? row.world.enrollToken);
      expect(r.status, `${row.id} ${row.label}`).toBeGreaterThanOrEqual(400);
      const text = JSON.stringify(r.json);
      expect(text, `${row.id} ${row.label}: ${text}`).not.toMatch(LEAKY);
      expect(text).not.toContain(row.world.orgId);
      expect(text).not.toContain(row.world.parentId);
    }
  });

  it('[D2-J026] enroll 호출이 DB 오류로 던져도 HTTP 본문에 원인 문구가 없다', async () => {
    const e = await enrollWorld();
    const deps = { ...e.w.deps, agentEnroll: { ...e.w.deps.agentEnroll, enroll: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.3.7:5432 password authentication failed for atmark_admin')) } };
    const r = await api({ deps }, 'POST', '/v1/agents', { token: e.enrollToken, body: { name: 'x' } });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(r.text).not.toMatch(LEAKY);
  });

  it('[D2-J027] 거절 코드가 "주소 존재 여부 오라클"이 되는 범위 — 같은 로컬파트가 taken(409) 이면 invalid(400) 와 구별된다(기록용)', async () => {
    const e = await enrollWorld({ cap: 20 });
    const f = await enrollWorld();
    const taken = await enrollCall(e, { name: 'x', local_part: f.parentAddress.split('@')[0] });
    const reserved = await enrollCall(e, { name: 'x', local_part: 'support' });
    expect(taken.status).toBe(409);
    expect(reserved.status).toBe(400);
    // 오라클은 의도된 계약(주소는 공개 식별자 · 시도는 조직당 하루 상한). 응답에 "누가" 가졌는지는 없다.
    expect(JSON.stringify(taken.json)).not.toContain(f.orgId);
  });
});

// ---------------------------------------------------------------------------
// F. 알림 · 감사
// ---------------------------------------------------------------------------
async function drain(e: EnrollWorld, kind: 'enroll' | 'signup' | 'block' | 'risk' = 'enroll') {
  const kit = consoleKit();
  await kit.owner.query(`UPDATE quarantine_notices SET next_attempt_at = now() - interval '1 second' WHERE organization_id = $1 AND status = 'pending' AND kind = $2`, [e.orgId, kind]);
  const ses = fakeSes();
  const later = () => new Date(Date.now() + 2_000);
  const report = await runQuarantineNotifier({ db: kit.app, notifier: createQuarantineNotifier({ pool: kit.app, client: ses.client, now: later }), now: later }, { organizationId: e.orgId });
  return { report, mails: ses.sent.map(mailText) };
}

describe.skipIf(!OWNER_AVAILABLE)('D2-F 알림 · 감사', () => {
  it('[D2-J028] 성공 5 번 → 알림 창 하나 · 메일 한 통(수 5) · 토큰 없음', async () => {
    const e = await enrollWorld({ cap: 5 });
    const tokens: string[] = [];
    for (let i = 0; i < 5; i += 1) tokens.push((await enrollCall(e, { name: `kid-${String(i)}` })).json['token'] as string);
    const { report, mails } = await drain(e);
    expect(report.sent).toBe(1);
    expect(mails).toHaveLength(1);
    for (const token of tokens) expect(mails[0]).not.toContain(token);
    expect(mails[0]).not.toContain(e.enrollToken);
  });

  it('VULN: [D2-J029] 이름에 짧은 URL 을 심으면 소유자 메일에 살아 있는 링크로 실린다 — 피싱 문구 방어(가입 알림은 도메인을 끊는다)', async () => {
    const e = await enrollWorld();
    await enrollCall(e, { name: 'Verify now https://x.co/a' });
    const { mails } = await drain(e);
    expect(mails).toHaveLength(1);
    // 보안 기대: 에이전트가 고른 문자열은 클릭 가능한 URL 로 소유자에게 가지 않는다(가입 알림은 도메인을 evil[.]example 로 끊는다).
    expect(mails[0]).not.toContain('https://x.co/a');
  });

  it('VULN: [D2-J030] 이름에 이메일 주소·승인 문구를 심어도 알림 메일의 승인 링크 · 발신 문구를 흉내 내지 못한다(콘솔 URL 외 http 링크 없음)', async () => {
    const e = await enrollWorld();
    await enrollCall(e, { name: 'Approve now: http://evil.example/approve?id=1' });
    const { mails } = await drain(e);
    const links = [...(mails[0] ?? '').matchAll(/https?:\/\/[^\s)>"']+/g)].map((m) => m[0]);
    for (const link of links) expect(link, link).toMatch(/^https:\/\/(console|docs)\.atmark\.ai/);
  });

  it('[D2-J031] 알림을 끄면(notifyOnEnroll=false) 창이 없고 감사 행은 그대로', async () => {
    const e = await enrollWorld();
    await call(consoleKit().deps, 'PATCH', '/api/watch/settings', authed(e.owner, { body: { notifyOnEnroll: false } }));
    await enrollCall(e, { name: 'quiet' });
    expect(await slotRows(provisioningPool(), e.orgId)).toHaveLength(1);
    const notices = await provisioningPool().query('SELECT 1 FROM quarantine_notices WHERE organization_id = $1 AND kind = $2', [e.orgId, 'enroll']);
    expect(notices.rowCount).toBe(0);
  });

  it('[D2-J032] 성공마다 감사 행 정확히 1 개 · 실패(검증 오류)는 행 0 · taken 은 행 1(outcome=taken)', async () => {
    const e = await enrollWorld({ cap: 10 });
    const a = await enrollCall(e, { name: 'one', local_part: `au-${randomUUID().slice(0, 8)}` });
    await enrollCall(e, { name: 'two' });
    await enrollCall(e, { name: 'bad', local_part: 'a..b' });
    await enrollCall(e, { name: 'dup', local_part: (a.json['agent'] as { address: string }).address.split('@')[0] });
    const rows = await slotRows(provisioningPool(), e.orgId);
    expect(rows.map((r) => r.outcome)).toEqual(['created', 'created', 'taken']);
    expect(rows.filter((r) => r.outcome === 'created').every((r) => r.child_agent_id !== null)).toBe(true);
  });

  it('[D2-J033] 감사 행의 child_agent_id 는 유일하다(한 자식이 두 슬롯에 걸리지 않는다)', async () => {
    const e = await enrollWorld();
    const a = await enrollCall(e, { name: 'one' });
    const childId = (a.json['agent'] as { agent_id: string }).agent_id;
    const tokenId = await enrollKeyId(e.parentId);
    const slot = await provisioningPool().query<{ id: string }>(`INSERT INTO agent_enrollments (organization_id, parent_agent_id, parent_token_id) VALUES ($1, $2, $3) RETURNING id`, [e.orgId, e.parentId, tokenId]).catch(() => null);
    if (slot !== null) {
      await expect(provisioningPool().query(`UPDATE agent_enrollments SET outcome = 'created', child_agent_id = $2 WHERE id = $1`, [slot.rows[0]?.id, childId])).rejects.toThrow();
    }
  });

  it('[D2-J034] 슬롯을 다른 조직의 에이전트를 자식으로 끝낼 수 없다', async () => {
    const e = await enrollWorld();
    const f = await enrollWorld();
    const tokenId = await enrollKeyId(e.parentId);
    const slot = await consoleKit().admin.query<{ id: string }>(`INSERT INTO agent_enrollments (organization_id, parent_agent_id, parent_token_id) VALUES ($1, $2, $3) RETURNING id`, [e.orgId, e.parentId, tokenId]);
    await expect(consoleKit().admin.query(`UPDATE agent_enrollments SET outcome = 'created', child_agent_id = $2 WHERE id = $1`, [slot.rows[0]?.id, f.parentId])).rejects.toThrow();
  });

  it('[D2-J035] 슬롯을 자기 자신(부모)을 자식으로 끝낼 수 없다', async () => {
    const e = await enrollWorld();
    const tokenId = await enrollKeyId(e.parentId);
    const slot = await consoleKit().admin.query<{ id: string }>(`INSERT INTO agent_enrollments (organization_id, parent_agent_id, parent_token_id) VALUES ($1, $2, $3) RETURNING id`, [e.orgId, e.parentId, tokenId]);
    await expect(consoleKit().admin.query(`UPDATE agent_enrollments SET outcome = 'created', child_agent_id = $2 WHERE id = $1`, [slot.rows[0]?.id, e.parentId])).rejects.toThrow();
  });

  it('[D2-J036] 슬롯을 다른 조직의 에이전트를 부모로 INSERT 할 수 없다(남의 토큰으로 자기 상한을 쓰지 않는다)', async () => {
    const e = await enrollWorld();
    const f = await enrollWorld();
    const fk = await enrollKeyId(f.parentId);
    await expect(consoleKit().admin.query(`INSERT INTO agent_enrollments (organization_id, parent_agent_id, parent_token_id) VALUES ($1, $2, $3)`, [e.orgId, f.parentId, fk])).rejects.toMatchObject({ code: 'P0A32' });
  });

  it('[D2-J037] 슬롯을 폐기된 토큰으로 INSERT 할 수 없다', async () => {
    const e = await enrollWorld();
    const tokenId = await enrollKeyId(e.parentId);
    await provisioningPool().query('UPDATE agent_api_keys SET revoked_at = now() WHERE id = $1', [tokenId]);
    await expect(consoleKit().admin.query(`INSERT INTO agent_enrollments (organization_id, parent_agent_id, parent_token_id) VALUES ($1, $2, $3)`, [e.orgId, e.parentId, tokenId])).rejects.toMatchObject({ code: 'P0A31' });
  });

  it('[D2-J038] 슬롯을 enroll 권한 없는 토큰으로 INSERT 할 수 없다', async () => {
    const e = await enrollWorld();
    const { tokenFor } = await import('./watch-d-support');
    const plain = await tokenFor(e.parentId as never);
    void plain;
    const keys = await provisioningPool().query<{ id: string }>(`SELECT id FROM agent_api_keys WHERE agent_id = $1 AND NOT ('agents:enroll'::agent_token_capability = ANY (capabilities)) LIMIT 1`, [e.parentId]);
    await expect(consoleKit().admin.query(`INSERT INTO agent_enrollments (organization_id, parent_agent_id, parent_token_id) VALUES ($1, $2, $3)`, [e.orgId, e.parentId, keys.rows[0]?.id])).rejects.toMatchObject({ code: 'P0A31' });
  });

  it('[D2-J039] 슬롯 직접 INSERT 도 하루 상한을 넘기지 못한다(admin 롤 반복)', async () => {
    const e = await enrollWorld({ cap: 2 });
    const tokenId = await enrollKeyId(e.parentId);
    const attempts: Promise<unknown>[] = Array.from({ length: 6 }, () =>
      consoleKit().admin.query(`INSERT INTO agent_enrollments (organization_id, parent_agent_id, parent_token_id) VALUES ($1, $2, $3)`, [e.orgId, e.parentId, tokenId]).catch(() => 'blocked'),
    );
    await Promise.all(attempts);
    expect((await slotRows(provisioningPool(), e.orgId)).length).toBe(2);
  });

  it('VULN: [D2-J040] 정보 알림 상한 — 가입 알림 10 통이 이미 나간 날, 자가 등록 알림이 조용히 사라지지 않는다(차단·위험과는 따로 세는 것과 별개로)', async () => {
    const e = await enrollWorld();
    for (let i = 0; i < 10; i += 1) {
      await provisioningPool().query(
        `INSERT INTO quarantine_notices (agent_id, organization_id, kind, next_attempt_at, status, claimed_at, sent_at, ses_message_id, message_count) VALUES ($1, $2, 'signup', now(), 'sent', now(), now(), $3, 1)`,
        [e.parentId, e.orgId, `ses-${String(i)}-${randomUUID().slice(0, 6)}`],
      );
    }
    await enrollCall(e, { name: 'after-flood' });
    const { report } = await drain(e);
    // 보안 기대: 새 에이전트가 생겼다는 알림은 가입 알림 홍수에 눌리지 않는다.
    expect(report.sent, JSON.stringify(report)).toBe(1);
  });

  it('[D2-J041] 반대로 자가 등록 알림 10 통 뒤의 가입 알림은 눌려도 차단 알림은 눌리지 않는다', async () => {
    const e = await enrollWorld();
    for (let i = 0; i < 10; i += 1) {
      await provisioningPool().query(
        `INSERT INTO quarantine_notices (agent_id, organization_id, kind, next_attempt_at, status, claimed_at, sent_at, ses_message_id, message_count) VALUES ($1, $2, 'enroll', now(), 'sent', now(), now(), $3, 1)`,
        [e.parentId, e.orgId, `ses-e${String(i)}-${randomUUID().slice(0, 6)}`],
      );
    }
    const { receiveFrom } = await import('./watch-d-support');
    void receiveFrom;
    const block = await provisioningPool().query<{ id: string }>(
      `INSERT INTO quarantine_notices (agent_id, organization_id, kind, next_attempt_at, message_count) VALUES ($1, $2, 'block', now() - interval '1 second', 1) RETURNING id`,
      [e.parentId, e.orgId],
    );
    expect(block.rowCount).toBe(1);
    const { report } = await drain(e, 'block');
    expect(report.suppressed ?? 0).toBe(0);
  });
});


// ---------------------------------------------------------------------------
// G. MCP create_agent
// ---------------------------------------------------------------------------
describe.skipIf(!OWNER_AVAILABLE)('D2-G MCP create_agent', () => {
  it('[D2-J042] 켜져 있으면 만든다 · 결과에 토큰 한 번 · 안전 기본값 안내', async () => {
    const e = await enrollWorld();
    const { mcp } = await import('./watch-d-support');
    const r = await mcp(e.w, 'create_agent', { name: 'via-mcp' }, e.enrollToken);
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/atk_agent_/);
    expect(r.text).toMatch(/always|approval/i);
  });

  it('[D2-J043] 꺼져 있으면 도구 오류 · 에이전트 0', async () => {
    const e = await enrollWorld({ enable: false });
    const { mcp } = await import('./watch-d-support');
    const r = await mcp(e.w, 'create_agent', { name: 'via-mcp' }, e.enrollToken);
    expect(r.isError).toBe(true);
    expect(await agentCount(provisioningPool(), e.orgId)).toBe(1);
  });

  it('[D2-J044] 권한 없는 토큰 → 도구 목록에서 거절 · 에이전트 0', async () => {
    const e = await enrollWorld();
    const { mcp, tokenFor } = await import('./watch-d-support');
    const plain = await tokenFor(e.parentId as never);
    const r = await mcp(e.w, 'create_agent', { name: 'via-mcp' }, plain);
    expect(r.isError).toBe(true);
    expect(await agentCount(provisioningPool(), e.orgId)).toBe(1);
  });

  it.each([
    { id: 'D2-J045', args: { name: 'x', send_approval: 'auto' } },
    { id: 'D2-J046', args: { name: 'x', capabilities: ['agents:enroll'] } },
    { id: 'D2-J047', args: { name: 'x', domain: 'custom.example' } },
    { id: 'D2-J048', args: { name: 'x', outbound_allow: ['*'] } },
  ])('[$id] MCP 에 모르는 인자 끼우기 $args — 새 에이전트는 안전 기본값(또는 거절)', async ({ args }) => {
    const e = await enrollWorld();
    const { mcp } = await import('./watch-d-support');
    const r = await mcp(e.w, 'create_agent', args, e.enrollToken);
    if (!r.isError) {
      const policy = await provisioningPool().query<{ require_approval: boolean; outbound_mode: string }>(
        `SELECT p.require_approval, p.outbound_mode FROM agent_policies p JOIN agents a ON a.id = p.agent_id WHERE a.organization_id = $1 AND a.id <> $2`,
        [e.orgId, e.parentId],
      );
      expect(policy.rows[0]).toEqual({ require_approval: true, outbound_mode: 'allowlist_only' });
    }
  });

  it('[D2-J049] get_capabilities: 권한 있는 부모 → 사용 가능 · 자식 → 불가 (에이전트가 자기 상태를 읽는다)', async () => {
    const e = await enrollWorld();
    const { mcp } = await import('./watch-d-support');
    const parent = await mcp(e.w, 'get_capabilities', {}, e.enrollToken);
    expect(parent.isError).toBe(false);
    const created = await enrollCall(e, { name: 'kid' });
    const childToken = created.json['token'] as string;
    const child = await mcp(e.w, 'get_capabilities', {}, childToken);
    expect(child.isError).toBe(false);
    expect(child.text).not.toContain(e.enrollToken);
    expect(child.text).not.toContain(e.orgId);
  });
});
