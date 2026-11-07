/**
 * 적대적 검증 A-3 (콘솔 API) — 에이전트별 위험 처리 · 알림 설정을 잘못된 역할 · 조직 · 값으로 바꾸려는 시도.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeTestPool } from '../db/support/harness';
import { adminFixture, adminWorld, asRole, authed, call, closeAdminWorld, receiveAdmin, type AdminFixture, type AdminWorld } from './watch-admin-support';
import { fakeScanner, OWNER_AVAILABLE, RISKY } from './watch-support';

let w: AdminWorld;
beforeAll(() => {
  if (OWNER_AVAILABLE) w = adminWorld();
});
afterAll(async () => {
  if (OWNER_AVAILABLE) {
    await closeAdminWorld(w);
    await closeTestPool();
  }
});

const path = (f: AdminFixture, id = f.agentId): string => `/api/agents/${id}/watch`;
const patch = (session: AdminFixture['session'], f: AdminFixture, body: unknown, id = f.agentId) => call(w.deps, 'PATCH', path(f, id), authed(session, { body }));
const settingsOf = async (f: AdminFixture) => (await call(w.deps, 'GET', path(f), authed(f.session))).json() as { riskHandling: string; riskNotify: boolean; updatedAt: string | null };

const BAD: [id: string, name: string, body: unknown][] = [
  ['A-001', '빈 본문', {}],
  ['A-002', 'riskHandling 대문자', { riskHandling: 'HOLD' }],
  ['A-003', 'riskHandling drop', { riskHandling: 'drop' }],
  ['A-004', 'riskHandling null', { riskHandling: null }],
  ['A-005', 'riskHandling 숫자', { riskHandling: 1 }],
  ['A-006', 'riskHandling 배열', { riskHandling: ['hold'] }],
  ['A-007', 'riskHandling 불리언', { riskHandling: true }],
  ['A-008', 'riskHandling 공백', { riskHandling: ' hold ' }],
  ['A-009', 'riskHandling SQL', { riskHandling: "hold'; DROP TABLE agent_watch_settings;--" }],
  ['A-010', 'riskNotify 문자열', { riskNotify: 'false' }],
  ['A-011', 'riskNotify 0', { riskNotify: 0 }],
  ['A-012', 'riskNotify null', { riskNotify: null }],
  ['A-013', '모르는 키 trustedBypass(설정 칸 아님)', { riskHandling: 'hold', trustedBypass: true }],
  ['A-014', '모르는 키 organizationId', { riskHandling: 'hold', organizationId: randomUUID() }],
  ['A-015', '모르는 키 agentId', { riskHandling: 'hold', agentId: 'f'.repeat(32) }],
  ['A-016', '본문이 배열', [{ riskHandling: 'hold' }]],
  ['A-017', '본문이 문자열', 'hold'],
  ['A-018', '본문이 null', null],
  ['A-019', '유효 + 무효 섞임', { riskHandling: 'hold', riskNotify: 'x' }],
];

describe.skipIf(!OWNER_AVAILABLE)('A-3 에이전트 설정 API — 값 · 역할 · 조직', () => {
  it.each(BAD.map((b) => [`[${b[0]}] ${b[1]} → 400, 설정 불변`, b[2]] as const))('%s', async (_t, body) => {
    const f = await adminFixture(w);
    const r = await patch(f.session, f, body);
    expect(r.statusCode, r.body).toBe(400);
    expect(await settingsOf(f)).toMatchObject({ riskHandling: 'deliver', riskNotify: true, updatedAt: null });
  });

  it('[A-020] 대조: hold + 알림 끔이 저장되고 GET 이 같은 값을 준다', async () => {
    const f = await adminFixture(w);
    expect((await patch(f.session, f, { riskHandling: 'hold', riskNotify: false })).statusCode).toBe(200);
    expect(await settingsOf(f)).toMatchObject({ riskHandling: 'hold', riskNotify: false });
  });
  it('[A-021] 멤버는 바꿀 수 없다 → 403, 불변', async () => {
    const f = await adminFixture(w);
    expect((await patch(await asRole(w, f, 'member'), f, { riskHandling: 'hold' })).statusCode).toBe(403);
    expect(await settingsOf(f)).toMatchObject({ riskHandling: 'deliver' });
  });
  it('[A-022] 멤버는 읽을 수 있다(200)', async () => {
    const f = await adminFixture(w);
    expect((await call(w.deps, 'GET', path(f), authed(await asRole(w, f, 'member')))).statusCode).toBe(200);
  });
  it('[A-023] 관리자는 바꿀 수 있다(스펙: admin)', async () => {
    const f = await adminFixture(w);
    expect((await patch(await asRole(w, f, 'admin'), f, { riskHandling: 'hold' })).statusCode).toBe(200);
  });
  it('[A-024] 세션 없음 → 401', async () => {
    const f = await adminFixture(w);
    expect((await call(w.deps, 'PATCH', path(f), { body: { riskHandling: 'hold' } })).statusCode).toBe(401);
  });
  it('[A-025] CSRF 없음 → 403', async () => {
    const f = await adminFixture(w);
    expect((await call(w.deps, 'PATCH', path(f), { cookies: f.session.cookies, body: { riskHandling: 'hold' } })).statusCode).toBe(403);
    expect(await settingsOf(f)).toMatchObject({ riskHandling: 'deliver' });
  });
  it('[A-026] 다른 조직 에이전트에 PATCH → 404, 그 설정 불변', async () => {
    const a = await adminFixture(w);
    const b = await adminFixture(w);
    expect((await patch(a.session, a, { riskHandling: 'hold' }, b.agentId)).statusCode).toBe(404);
    expect(await settingsOf(b)).toMatchObject({ riskHandling: 'deliver', updatedAt: null });
  });
  it('[A-027] 다른 조직 에이전트 GET → 404 (존재 여부를 알리지 않는다: 없는 id 와 같은 응답)', async () => {
    const a = await adminFixture(w);
    const b = await adminFixture(w);
    const other = await call(w.deps, 'GET', path(a, b.agentId), authed(a.session));
    const missing = await call(w.deps, 'GET', path(a, '0'.repeat(32)), authed(a.session));
    expect([other.statusCode, other.json()]).toEqual([missing.statusCode, missing.json()]);
  });
  it.each([
    ['A-028', 'uuid 형태 id', randomUUID()],
    ['A-029', '대문자 hex', 'A'.repeat(32)],
    ['A-030', 'SQL 조각', "x'--"],
    ['A-031', '짧은 hex', 'ab'],
  ] as const)('[%s] 잘못된 에이전트 id(%s) → 400/404', async (_id, _name, value) => {
    const f = await adminFixture(w);
    const r = await patch(f.session, f, { riskHandling: 'hold' }, value);
    expect([400, 404]).toContain(r.statusCode);
  });
  it('[A-032] 같은 값 재설정은 changed:false · 감사 없음', async () => {
    const f = await adminFixture(w);
    await patch(f.session, f, { riskHandling: 'hold' });
    const r = await patch(f.session, f, { riskHandling: 'hold' });
    expect(r.json()).toMatchObject({ changed: false });
    const n = (await w.owner.query(`SELECT 1 FROM owner_actions WHERE organization_id = $1 AND action = 'watch.agent.set'`, [f.orgId])).rowCount;
    expect(n).toBe(1);
  });
  it('[A-033] 부분 갱신: riskNotify 만 바꿔도 riskHandling 은 유지된다', async () => {
    const f = await adminFixture(w);
    await patch(f.session, f, { riskHandling: 'hold' });
    await patch(f.session, f, { riskNotify: false });
    expect(await settingsOf(f)).toMatchObject({ riskHandling: 'hold', riskNotify: false });
  });
  it('[A-034] 경합: hold/deliver 번갈아 20번 동시에 → 최종 값은 둘 중 하나, 오류 없음', async () => {
    const f = await adminFixture(w);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => patch(f.session, f, { riskHandling: i % 2 === 0 ? 'hold' : 'deliver' })));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(['hold', 'deliver']).toContain((await settingsOf(f)).riskHandling);
  });
  it('[A-035] 설정 변경 직후 수신: hold 가 곧바로 적용된다(캐시 없음)', async () => {
    const f = await adminFixture(w);
    await patch(f.session, f, { riskHandling: 'hold' });
    const m = await receiveAdmin(f, fakeScanner('low', RISKY).scan);
    expect(m.row.quarantine_reason).toBe('risk_hold');
    await patch(f.session, f, { riskHandling: 'deliver' });
    const n = await receiveAdmin(f, fakeScanner('low', RISKY).scan);
    expect(n.row.quarantined).toBe(false);
  });
  it('[A-036] 에이전트 토큰으로 설정 읽기 → 401', async () => {
    const f = await adminFixture(w);
    expect((await call(w.deps, 'GET', path(f), { headers: { authorization: 'Bearer atk_x' } })).statusCode).toBe(401);
  });
  it('[A-037] 읽기 응답에 신뢰 발신자 · 다른 설정이 섞이지 않는다', async () => {
    const f = await adminFixture(w);
    const body = (await call(w.deps, 'GET', path(f), authed(f.session))).json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['agentId', 'riskHandling', 'riskNotify', 'sendApproval', 'updatedAt']);
  });
  it('[A-038] 감사 행의 대상은 에이전트 id', async () => {
    const f = await adminFixture(w);
    await patch(f.session, f, { riskNotify: false });
    const row = (await w.owner.query<{ target_id: string }>(`SELECT target_id FROM owner_actions WHERE organization_id = $1 AND action = 'watch.agent.set'`, [f.orgId])).rows[0];
    expect(row?.target_id).toBe(f.agentId);
  });
});
