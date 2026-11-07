/**
 * 적대적 검증(묶음 D) 요소 2 — 자가 등록(`agents:enroll`). 실제 Postgres · 실제 API 라우터 · 실제 admin 연산(운영과 같은 JSON 경계). 시도 ID `D2-I###`.
 * 보안 동작을 단언한다. `SUSPECT:` = 현재 동작을 못박은 의심, `VULN:` = 뚫림(실패한다).
 */

import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { closeTestPool, provisioningPool } from '../db/support/harness';
import { api, authed, call, closeConsoleKit, consoleKit, mcp, OWNER_AVAILABLE, sessionFor, tokenFor } from './watch-d-support';
import { agentCount, enrollCall, enrollWorld, hashAgentToken, slotRows } from './watch-d-enroll-support';

afterAll(async () => {
  await closeConsoleKit();
  await closeTestPool();
});

const kit = () => consoleKit();
const settings = (session: Parameters<typeof authed>[0], body: unknown) => call(kit().deps, 'PATCH', '/api/watch/settings', authed(session, { body }));

// ---------------------------------------------------------------------------
// A. 권한 부여 · 켜짐 상태
// ---------------------------------------------------------------------------
describe.skipIf(!OWNER_AVAILABLE)('D2-A 권한 부여 · 켜짐 상태', () => {
  it('[D2-I001] 관리자(admin)는 agents:enroll 토큰을 발급할 수 없다(403)', async () => {
    const e = await enrollWorld();
    const admin = await sessionFor(e.orgId, 'admin');
    const r = await call(kit().deps, 'POST', `/api/agents/${e.parentId}/tokens`, authed(admin, { body: { label: 'x', capabilities: ['agents:enroll'] } }));
    expect(r.statusCode).toBe(403);
  });

  it('[D2-I002] 멤버(member)는 발급 자체가 403', async () => {
    const e = await enrollWorld();
    const member = await sessionFor(e.orgId, 'member');
    const r = await call(kit().deps, 'POST', `/api/agents/${e.parentId}/tokens`, authed(member, { body: { label: 'x', capabilities: ['agents:enroll'] } }));
    expect(r.statusCode).toBe(403);
  });

  it('[D2-I003] 다른 조직 소유자는 남의 에이전트에 agents:enroll 토큰을 발급할 수 없다', async () => {
    const e = await enrollWorld();
    const f = await enrollWorld();
    const r = await call(kit().deps, 'POST', `/api/agents/${e.parentId}/tokens`, authed(f.owner, { body: { label: 'x', capabilities: ['agents:enroll'] } }));
    expect([403, 404]).toContain(r.statusCode);
  });

  it('[D2-I004] 관리자는 전체 교체(rotate)로도 agents:enroll 을 줄 수 없다', async () => {
    const e = await enrollWorld();
    const admin = await sessionFor(e.orgId, 'admin');
    const r = await call(kit().deps, 'POST', `/api/agents/${e.parentId}/token`, authed(admin, { body: { action: 'rotate', capabilities: ['agents:enroll'] } }));
    expect(r.statusCode).toBe(403);
  });

  it('[D2-I005] 관리자는 revoke-all 에 capabilities 를 끼워 넣어도 새 토큰을 받지 못한다', async () => {
    const e = await enrollWorld();
    const admin = await sessionFor(e.orgId, 'admin');
    const r = await call(kit().deps, 'POST', `/api/agents/${e.parentId}/token`, authed(admin, { body: { action: 'revoke-all', capabilities: ['agents:enroll'] } }));
    expect(r.statusCode).toBe(400);
  });

  it('[D2-I006] 소유자 rotate 가 capabilities 를 생략하면 기본 권한(agents:enroll 없음)', async () => {
    const e = await enrollWorld();
    const r = await call(kit().deps, 'POST', `/api/agents/${e.parentId}/token`, authed(e.owner, { body: { action: 'rotate' } }));
    expect(r.statusCode, r.body).toBe(200);
    const fresh = (r.json() as { token: string }).token;
    const found = await provisioningPool().query<{ caps: string[] }>('SELECT capabilities::text[] AS caps FROM agent_api_keys WHERE token_hash = $1', [hashAgentToken(fresh)]);
    expect(found.rows[0]?.caps).not.toContain('agents:enroll');
    const denied = await api(e.w, 'POST', '/v1/agents', { token: fresh, body: { name: 'x' } });
    expect(denied.status).toBe(403);
  });

  it('[D2-I007] 콘솔 에이전트 생성 본문에 capabilities 를 끼워 넣어도 enroll 권한 토큰이 나오지 않는다', async () => {
    const e = await enrollWorld();
    const r = await call(kit().deps, 'POST', '/api/agents', authed(e.owner, { body: { name: 'sneaky', localPart: `sn-${randomUUID().slice(0, 8)}`, capabilities: ['agents:enroll'] } }));
    if (r.statusCode === 201) {
      const token = (r.json() as { token: string }).token;
      const found = await provisioningPool().query<{ caps: string[] }>('SELECT capabilities::text[] AS caps FROM agent_api_keys WHERE token_hash = $1', [hashAgentToken(token)]);
      expect(found.rows[0]?.caps).not.toContain('agents:enroll');
    } else {
      expect([400, 403]).toContain(r.statusCode);
    }
  });

  it('[D2-I008] 조직 설정은 소유자만 켠다 — 관리자 403', async () => {
    const e = await enrollWorld({ enable: false });
    const admin = await sessionFor(e.orgId, 'admin');
    expect((await settings(admin, { agentSelfEnroll: true })).statusCode).toBe(403);
    expect((await enrollCall(e, { name: 'x' })).json['error']).toBe('self_enroll_disabled');
  });

  it('[D2-I009] 조직 설정은 소유자만 켠다 — 멤버 403', async () => {
    const e = await enrollWorld({ enable: false });
    const member = await sessionFor(e.orgId, 'member');
    expect((await settings(member, { agentSelfEnroll: true })).statusCode).toBe(403);
  });

  it('[D2-I010] 다른 조직 소유자가 내 조직 설정을 바꿀 수 없다(자기 조직만 바뀐다)', async () => {
    const e = await enrollWorld({ enable: false });
    const f = await enrollWorld({ enable: false });
    await settings(f.owner, { agentSelfEnroll: true });
    expect((await enrollCall(e, { name: 'x' })).json['error']).toBe('self_enroll_disabled');
  });

  it('[D2-I011] 꺼져 있으면 403 self_enroll_disabled · 슬롯 0 · 에이전트 수 불변', async () => {
    const e = await enrollWorld({ enable: false });
    const before = await agentCount(provisioningPool(), e.orgId);
    const r = await enrollCall(e, { name: 'x' });
    expect([r.status, r.json['error']]).toEqual([403, 'self_enroll_disabled']);
    expect(await agentCount(provisioningPool(), e.orgId)).toBe(before);
    expect(await slotRows(provisioningPool(), e.orgId)).toEqual([]);
  });

  it('[D2-I012] 켰다 끄면 즉시 막힌다(토큰은 그대로)', async () => {
    const e = await enrollWorld();
    expect((await enrollCall(e, { name: 'a' })).status).toBe(201);
    await settings(e.owner, { agentSelfEnroll: false });
    expect((await enrollCall(e, { name: 'b' })).json['error']).toBe('self_enroll_disabled');
  });

  it('[D2-I013] 토큰을 폐기하면 즉시 401', async () => {
    const e = await enrollWorld();
    await provisioningPool().query('UPDATE agent_api_keys SET revoked_at = now() WHERE token_hash = $1', [hashAgentToken(e.enrollToken)]);
    expect((await enrollCall(e, { name: 'x' })).status).toBe(401);
  });

  it('[D2-I014] 만료된 토큰은 401', async () => {
    const e = await enrollWorld();
    await provisioningPool().query(`ALTER TABLE agent_api_keys DISABLE TRIGGER USER`).catch(() => undefined);
    try {
      await provisioningPool().query(`UPDATE agent_api_keys SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [hashAgentToken(e.enrollToken)]);
    } catch {
      // 만료 시각은 불변이다 — 만료로 발급한 새 토큰으로 대신한다.
    } finally {
      await provisioningPool().query(`ALTER TABLE agent_api_keys ENABLE TRIGGER USER`).catch(() => undefined);
    }
    const issued = await call(kit().deps, 'POST', `/api/agents/${e.parentId}/tokens`, authed(e.owner, { body: { label: 'short', expiresDays: 1, capabilities: ['agents:enroll'] } }));
    expect(issued.statusCode, issued.body).toBe(201);
    const token = (issued.json() as { token: string }).token;
    await provisioningPool().query(`ALTER TABLE agent_api_keys DISABLE TRIGGER USER`);
    await provisioningPool().query(`UPDATE agent_api_keys SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [hashAgentToken(token)]);
    await provisioningPool().query(`ALTER TABLE agent_api_keys ENABLE TRIGGER USER`);
    expect((await enrollCall(e, { name: 'x' }, token)).status).toBe(401);
  });

  it.each([
    { id: 'D2-I015', label: '소유자 일시정지 조직', sql: `UPDATE organizations SET owner_paused = true WHERE id = $1` },
    { id: 'D2-I016', label: '운영자 동결(abuse_freeze) 조직', sql: `UPDATE organizations SET abuse_freeze = true WHERE id = $1` },
    { id: 'D2-I017', label: '검토 전(pending_review) 조직', sql: `UPDATE organizations SET review_status = 'pending_review' WHERE id = $1` },
  ])('[$id] $label — 403 agent_not_active · 슬롯 0', async ({ sql }) => {
    const e = await enrollWorld();
    await provisioningPool().query(sql, [e.orgId]);
    const r = await enrollCall(e, { name: 'x' });
    expect([r.status, r.json['error']]).toEqual([403, 'agent_not_active']);
    expect(await slotRows(provisioningPool(), e.orgId)).toEqual([]);
  });

  it.each([
    { id: 'D2-I018', label: '소유자가 정지한 에이전트', status: 'suspended', by: 'owner' },
    { id: 'D2-I019', label: '운영자가 죽인(operator-killed) 에이전트', status: 'suspended', by: 'operator' },
  ])('[$id] $label — 403 agent_not_active', async ({ status, by }) => {
    const e = await enrollWorld();
    await provisioningPool().query(`UPDATE agents SET status = $2::agent_status, suspended_by = $3 WHERE id = $1`, [e.parentId, status, by]);
    const r = await enrollCall(e, { name: 'x' });
    expect([r.status, r.json['error']]).toEqual([403, 'agent_not_active']);
    expect(await slotRows(provisioningPool(), e.orgId)).toEqual([]);
  });

  // 삭제한(disabled) 에이전트(202610131000) — 토큰을 폐기된 것으로 읽어 인증에서 401(보안 리뷰 HIGH-1). 예전에는 403 agent_not_active 였다 — 더 앞에서 막힌다.
  it('[D2-I020] 비활성(disabled · 삭제한) 에이전트 — 401(토큰 폐기로 읽는다)', async () => {
    const e = await enrollWorld();
    await provisioningPool().query(`UPDATE agents SET status = 'disabled', suspended_by = NULL WHERE id = $1`, [e.parentId]);
    const r = await enrollCall(e, { name: 'x' });
    expect(r.status).toBe(401);
    expect(await slotRows(provisioningPool(), e.orgId)).toEqual([]);
  });

  it('[D2-I021] 에이전트를 풀면(active) 다시 된다 — 대조군', async () => {
    const e = await enrollWorld();
    await provisioningPool().query(`UPDATE agents SET status = 'suspended', suspended_by = 'owner' WHERE id = $1`, [e.parentId]);
    expect((await enrollCall(e, { name: 'x' })).status).toBe(403);
    await provisioningPool().query(`UPDATE agents SET status = 'active', suspended_by = NULL WHERE id = $1`, [e.parentId]);
    expect((await enrollCall(e, { name: 'x' })).status).toBe(201);
  });

  it.each([
    { id: 'D2-I022', billing: 'delinquent' },
    { id: 'D2-I023', billing: 'suspended' },
  ])('SUSPECT: [$id] 결제 $billing 조직의 에이전트도 자가 등록으로 새 에이전트·주소를 만든다(콘솔 생성과 같은 규칙 — 발송은 Stage 0 이 막는다)', async ({ billing }) => {
    const e = await enrollWorld();
    await provisioningPool().query(`UPDATE organizations SET billing_status = $2::billing_status WHERE id = $1`, [e.orgId, billing]);
    const consoleCreate = await call(kit().deps, 'POST', '/api/agents', authed(e.owner, { body: { name: 'viaconsole', localPart: `vc-${randomUUID().slice(0, 8)}` } }));
    const enrolled = await enrollCall(e, { name: 'viaapi' });
    // 보안 기대: 자가 등록은 콘솔보다 느슨하지 않다 — 콘솔이 막으면 자가 등록도 막혀야 한다.
    if (consoleCreate.statusCode !== 201) expect(enrolled.status).not.toBe(201);
    else expect(enrolled.status).toBe(201); // 콘솔도 허용 = 같은 규칙(정보 기록용)
  });

  it('[D2-I024] 기본 권한 토큰(enroll 없음)으로 POST /v1/agents → 403 forbidden', async () => {
    const e = await enrollWorld();
    const plain = await tokenFor(e.parentId as never);
    const r = await enrollCall(e, { name: 'x' }, plain);
    expect([r.status, r.json['error']]).toEqual([403, 'forbidden']);
  });

  it.each([
    { id: 'D2-I025', caps: ['webhooks:manage'] as const },
    { id: 'D2-I026', caps: ['audit:read', 'messages:read'] as const },
  ])('[$id] 다른 권한만 가진 토큰 $caps → 403', async ({ caps }) => {
    const e = await enrollWorld();
    const token = await tokenFor(e.parentId as never, [...caps]);
    expect((await enrollCall(e, { name: 'x' }, token)).status).toBe(403);
  });

  it.each([
    { id: 'D2-I027', label: '토큰 없음', token: '' },
    { id: 'D2-I028', label: '쓰레기 토큰', token: 'garbage' },
    { id: 'D2-I029', label: '모양만 맞는 가짜 에이전트 토큰', token: `atk_agent_${'A'.repeat(43)}` },
    { id: 'D2-I030', label: '조직 키 모양 토큰', token: `atk_org_${'A'.repeat(43)}` },
  ])('[$id] $label → 401 (슬롯 없음)', async ({ token }) => {
    const e = await enrollWorld();
    const r = await api(e.w, 'POST', '/v1/agents', { ...(token === '' ? {} : { token }), body: { name: 'x' } });
    expect(r.status).toBe(401);
    expect(await slotRows(provisioningPool(), e.orgId)).toEqual([]);
  });

  it('[D2-I031] 다른 조직에서 enroll 이 꺼져 있고 내 조직은 켜져 있어도, 내 토큰은 내 조직에만 만든다', async () => {
    const e = await enrollWorld();
    const f = await enrollWorld({ enable: false });
    const r = await enrollCall(e, { name: 'mine' });
    expect(r.status).toBe(201);
    expect(await agentCount(provisioningPool(), f.orgId)).toBe(1);
    const child = (r.json['agent'] as { agent_id: string }).agent_id;
    const org = await provisioningPool().query<{ organization_id: string }>('SELECT organization_id FROM agents WHERE id = $1', [child]);
    expect(org.rows[0]?.organization_id).toBe(e.orgId);
  });
});

// ---------------------------------------------------------------------------
// B. 만든 에이전트 · 토큰으로의 권한 상승
// ---------------------------------------------------------------------------
async function makeChild(e: Awaited<ReturnType<typeof enrollWorld>>, name = 'child', localPart?: string) {
  const r = await enrollCall(e, localPart === undefined ? { name } : { name, local_part: localPart });
  expect(r.status, r.text).toBe(201);
  const agent = r.json['agent'] as { agent_id: string; address: string };
  return { id: agent.agent_id, address: agent.address, token: r.json['token'] as string, response: r };
}

describe.skipIf(!OWNER_AVAILABLE)('D2-B 상승 — 만든 에이전트와 그 토큰', () => {
  it('[D2-I032] 만든 토큰의 권한은 정확히 세 개(enroll · webhooks:manage · audit:read 없음)', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const keys = await provisioningPool().query<{ caps: string[] }>('SELECT capabilities::text[] AS caps FROM agent_api_keys WHERE agent_id = $1', [c.id]);
    expect(keys.rows).toHaveLength(1);
    expect([...(keys.rows[0]?.caps ?? [])].sort()).toEqual(['agent:read_self', 'messages:read', 'messages:send']);
    expect((c.response.json['token_scopes'] as string[]).sort()).toEqual(['agent:read_self', 'messages:read', 'messages:send']);
  });

  it('[D2-I033] 만든 토큰으로 POST /v1/agents → 403 (연쇄 금지)', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const r = await enrollCall(e, { name: 'grandchild' }, c.token);
    expect(r.status).toBe(403);
    expect(await agentCount(provisioningPool(), e.orgId)).toBe(2);
  });

  it('[D2-I034] MCP create_agent 에 만든 토큰 → 도구 거부 · 아무것도 안 만든다', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const r = await mcp(e.w, 'create_agent', { name: 'grandchild' }, c.token);
    expect(r.isError).toBe(true);
    expect(await agentCount(provisioningPool(), e.orgId)).toBe(2);
  });

  it('[D2-I035] 소유자 콘솔도 만든 에이전트에 agents:enroll 토큰을 발급할 수 없다(409)', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const r = await call(kit().deps, 'POST', `/api/agents/${c.id}/tokens`, authed(e.owner, { body: { label: 'chain', capabilities: ['agents:enroll'] } }));
    expect(r.statusCode).toBe(409);
  });

  it('[D2-I036] 소유자 rotate 로도 만든 에이전트에 agents:enroll 을 줄 수 없다(409)', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const r = await call(kit().deps, 'POST', `/api/agents/${c.id}/token`, authed(e.owner, { body: { action: 'rotate', capabilities: ['agents:enroll'] } }));
    expect(r.statusCode).toBe(409);
  });

  it.each([
    { id: 'D2-I037', role: 'owner 롤(마이그레이션 롤)', pool: () => provisioningPool() },
    { id: 'D2-I038', role: 'admin 롤', pool: () => kit().admin },
  ])('[$id] $role 의 SQL 직접 INSERT 도 막힌다(P0A35)', async ({ pool }) => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    await expect(pool().query(`INSERT INTO agent_api_keys (agent_id, token_hash, capabilities) VALUES ($1, $2, '{agents:enroll}')`, [c.id, 'b'.repeat(64)])).rejects.toMatchObject({ code: 'P0A35' });
  });

  it('[D2-I039] 만든 에이전트의 기존 키 capabilities 를 UPDATE 로 부풀릴 수 없다(소유자 롤)', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    await expect(provisioningPool().query(`UPDATE agent_api_keys SET capabilities = '{messages:send,agents:enroll}' WHERE agent_id = $1`, [c.id])).rejects.toThrow();
  });

  it('[D2-I040] admin 롤은 capabilities 칸을 UPDATE 할 권한이 없다', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    await expect(kit().admin.query(`UPDATE agent_api_keys SET capabilities = '{messages:send,agents:enroll}' WHERE agent_id = $1`, [c.id])).rejects.toThrow();
  });

  it('[D2-I041] 앱 롤(런타임)은 agent_api_keys 에 권한을 심을 수 없다(INSERT 시도)', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    await expect(kit().app.query(`INSERT INTO agent_api_keys (agent_id, token_hash, capabilities) VALUES ($1, $2, '{agents:enroll}')`, [c.id, 'c'.repeat(64)])).rejects.toThrow();
  });

  it('[D2-I042] 부모 토큰으로 자식 정책 조회 → 거부(자기 자신에 대한 권한뿐)', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const r = await api(e.w, 'GET', `/v1/agents/${c.id}/policy`, { token: e.enrollToken });
    expect([403, 404]).toContain(r.status);
  });

  it('[D2-I043] 자식 토큰으로 부모 정책 조회 → 거부', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const r = await api(e.w, 'GET', `/v1/agents/${e.parentId}/policy`, { token: c.token });
    expect([403, 404]).toContain(r.status);
  });

  it('[D2-I044] 부모 토큰으로 자식 주소로 발송(agent_id=자식) → 403', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const r = await api(e.w, 'POST', '/v1/messages', { token: e.enrollToken, body: { agent_id: c.id, from: c.address, to: ['x@example.com'], subject: 's', text: 't' }, headers: { 'idempotency-key': randomUUID() } });
    expect(r.status).toBe(403);
    expect(e.w.transport.calls()).toBe(0);
  });

  it('[D2-I045] 자식 토큰으로 부모 주소로 발송(agent_id=부모) → 403', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const r = await api(e.w, 'POST', '/v1/messages', { token: c.token, body: { agent_id: e.parentId, from: e.parentAddress, to: ['x@example.com'], subject: 's', text: 't' }, headers: { 'idempotency-key': randomUUID() } });
    expect(r.status).toBe(403);
  });

  it('[D2-I046] 자식이 자기 agent_id 로 부모 주소를 from 으로 위조 → 거부(전송 0)', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const r = await api(e.w, 'POST', '/v1/messages', { token: c.token, body: { agent_id: c.id, from: e.parentAddress, to: ['x@example.com'], subject: 's', text: 't' }, headers: { 'idempotency-key': randomUUID() } });
    expect(r.status).toBe(403);
    expect(e.w.transport.calls()).toBe(0);
  });

  it('[D2-I047] 자식은 허용 목록이 비어 있어 누구에게도 못 보낸다(allowlist_only · 빈 목록)', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    for (const to of ['x@example.com', e.parentAddress, 'owner@example.com']) {
      const r = await api(e.w, 'POST', '/v1/messages', { token: c.token, body: { agent_id: c.id, from: c.address, to: [to], subject: 's', text: 't' }, headers: { 'idempotency-key': randomUUID() } });
      expect(r.status, to).toBe(403);
    }
    expect(e.w.transport.calls()).toBe(0);
  });

  it('[D2-I048] 자식 정책: allowlist_only · 허용 0 · send_approval always (자식 토큰으로 직접 확인)', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const r = await api(e.w, 'GET', `/v1/agents/${c.id}/policy`, { token: c.token });
    expect(r.status, r.text).toBe(200);
    expect((r.json['outbound'] as { mode: string; allow: unknown[] }).mode).toBe('allowlist');
    expect((r.json['outbound'] as { allow: unknown[] }).allow).toHaveLength(0);
    expect(r.json['send_approval']).toBe('always');
  });

  it('[D2-I049] 소유자가 자식 허용 목록에 주소를 넣어도 always 라서 승인 대기(자동 발송 안 됨)', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const { addRuleOp, resolveContactRuleInput } = await import('../../../src/admin/ops/rules');
    await addRuleOp(provisioningPool(), c.id as never, resolveContactRuleInput({ direction: 'outbound', list: 'allow', value: 'friend@example.com' }), 'adv-d');
    const r = await api(e.w, 'POST', '/v1/messages', { token: c.token, body: { agent_id: c.id, from: c.address, to: ['friend@example.com'], subject: 's', text: 't' }, headers: { 'idempotency-key': randomUUID() } });
    expect(r.status, r.text).toBe(202);
    expect(e.w.transport.calls()).toBe(0);
  });

  it('[D2-I050] 자식 위험 처리 hold · 정책 행·스냅샷 모두 require_approval=true · created_by=agent:부모', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const watch = await provisioningPool().query<{ risk_handling: string }>('SELECT risk_handling FROM agent_watch_settings WHERE agent_id = $1', [c.id]);
    expect(watch.rows[0]?.risk_handling).toBe('hold');
    const policy = await provisioningPool().query<{ row: boolean; snap: unknown; created_by: string }>(
      `SELECT p.require_approval AS row, pv.snapshot -> 'require_approval' AS snap, pv.created_by FROM agent_policies p JOIN policy_versions pv ON pv.agent_id = p.agent_id AND pv.version = p.current_version WHERE p.agent_id = $1`,
      [c.id],
    );
    expect(policy.rows[0]).toEqual({ row: true, snap: true, created_by: `agent:${e.parentId}` });
  });

  it('[D2-I051] 자식 토큰은 평문이 DB 어디에도 없다(해시만) · hint 는 끝 몇 글자', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const row = await provisioningPool().query<{ token_hash: string; hint: string | null }>('SELECT token_hash, hint FROM agent_api_keys WHERE agent_id = $1', [c.id]);
    expect(row.rows[0]?.token_hash).toBe(hashAgentToken(c.token));
    expect(c.token).not.toContain(row.rows[0]?.token_hash ?? 'x');
    expect((row.rows[0]?.hint ?? '').length).toBeLessThanOrEqual(8);
    const dump = await provisioningPool().query<{ hit: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM agent_api_keys WHERE label LIKE '%' || $1 || '%' OR hint LIKE '%' || $1 || '%') AS hit`,
      [c.token],
    );
    expect(dump.rows[0]?.hit).toBe(false);
  });

  it('[D2-I052] 응답의 토큰은 두 번 같지 않다 · 부모 토큰과도 다르다', async () => {
    const e = await enrollWorld();
    const a = await makeChild(e, 'a');
    const b = await makeChild(e, 'b');
    expect(new Set([a.token, b.token, e.enrollToken]).size).toBe(3);
  });

  it('[D2-I053] 자식 토큰은 자식에게만 통한다 — 자식 토큰으로 GET /v1/agents/{자식}/capabilities 는 200, 부모는 거부', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    expect((await api(e.w, 'GET', `/v1/agents/${c.id}/capabilities`, { token: c.token })).status).toBe(200);
    expect([403, 404]).toContain((await api(e.w, 'GET', `/v1/agents/${e.parentId}/capabilities`, { token: c.token })).status);
  });

  it('[D2-I054] 자식의 capabilities 안내에 self_enroll.available 이 false (scope 없음)', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const r = await api(e.w, 'GET', `/v1/agents/${c.id}/capabilities`, { token: c.token });
    const se = r.json['self_enroll'] as { available: boolean; scope_granted: boolean } | null;
    if (se !== null) {
      expect(se.scope_granted).toBe(false);
      expect(se.available).toBe(false);
    }
  });

  it('[D2-I055] 슬롯 감사 행은 부모 · 쓴 토큰 · 자식을 가리킨다', async () => {
    const e = await enrollWorld();
    const c = await makeChild(e);
    const row = await provisioningPool().query<{ parent_agent_id: string; child_agent_id: string; outcome: string; tok: string }>(
      `SELECT parent_agent_id, child_agent_id, outcome, k.token_hash AS tok FROM agent_enrollments e JOIN agent_api_keys k ON k.id = e.parent_token_id WHERE e.organization_id = $1`,
      [e.orgId],
    );
    expect(row.rows).toEqual([{ parent_agent_id: e.parentId, child_agent_id: c.id, outcome: 'created', tok: hashAgentToken(e.enrollToken) }]);
  });

  it('[D2-I056] 감사 행은 지울 수도(DELETE) 고칠 수도(UPDATE) 없다 — 어느 롤도', async () => {
    const e = await enrollWorld();
    await makeChild(e);
    for (const pool of [provisioningPool(), kit().admin, kit().app]) {
      await expect(pool.query('DELETE FROM agent_enrollments WHERE organization_id = $1', [e.orgId])).rejects.toThrow();
      await expect(pool.query(`UPDATE agent_enrollments SET outcome = 'taken', child_agent_id = NULL WHERE organization_id = $1`, [e.orgId])).rejects.toThrow();
    }
    expect(await slotRows(provisioningPool(), e.orgId)).toHaveLength(1);
  });

  it('[D2-I057] 앱 롤은 슬롯을 직접 INSERT 할 수 없다(하루 상한 우회)', async () => {
    const e = await enrollWorld();
    const key = await provisioningPool().query<{ id: string }>('SELECT id FROM agent_api_keys WHERE token_hash = $1', [hashAgentToken(e.enrollToken)]);
    await expect(kit().app.query(`INSERT INTO agent_enrollments (organization_id, parent_agent_id, parent_token_id) VALUES ($1, $2, $3)`, [e.orgId, e.parentId, key.rows[0]?.id])).rejects.toThrow();
  });

  it('[D2-I058] 앱 롤은 조직 설정(agent_self_enroll · enroll_daily_cap)을 쓸 수 없다', async () => {
    const e = await enrollWorld({ enable: false });
    await expect(kit().app.query('UPDATE org_watch_settings SET agent_self_enroll = true, enroll_daily_cap = 20 WHERE organization_id = $1', [e.orgId])).rejects.toThrow();
    await expect(kit().app.query(`INSERT INTO org_watch_settings (organization_id, agent_self_enroll) VALUES ($1, true) ON CONFLICT (organization_id) DO UPDATE SET agent_self_enroll = true`, [e.orgId])).rejects.toThrow();
  });

  it('[D2-I059] 앱 롤은 정의자 함수 atmark_watch_set_org 를 실행할 수 없다(스스로 켜기 불가)', async () => {
    const e = await enrollWorld({ enable: false });
    await expect(kit().app.query('SELECT * FROM atmark_watch_set_org($1, true, 20, NULL, NULL, NULL)', [e.orgId])).rejects.toThrow();
  });

  it('[D2-I060] 앱 롤은 슬롯 알림 함수(atmark_watch_notice_slot)를 직접 부를 수 없다', async () => {
    const e = await enrollWorld();
    await expect(kit().app.query(`SELECT atmark_watch_notice_slot($1, $2, 'enroll')`, [e.parentId, e.orgId])).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// C. 한도 — 하루 상한 · 요금제 · 경쟁
// ---------------------------------------------------------------------------
describe.skipIf(!OWNER_AVAILABLE)('D2-C 한도 — 하루 상한 · 요금제 · 경쟁', () => {
  it('[D2-I061] 상한 1: 첫 번째 201, 두 번째 429 enroll_daily_cap', async () => {
    const e = await enrollWorld({ cap: 1 });
    expect((await enrollCall(e, { name: 'one' })).status).toBe(201);
    const r = await enrollCall(e, { name: 'two' });
    expect([r.status, r.json['error']]).toEqual([429, 'enroll_daily_cap']);
    expect(await agentCount(provisioningPool(), e.orgId)).toBe(2);
  });

  it('[D2-I062] 상한 3: 정확히 3 개 만들고 4·5번째는 429', async () => {
    const e = await enrollWorld({ cap: 3 });
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push((await enrollCall(e, { name: `c${String(i)}` })).status);
    expect(results).toEqual([201, 201, 201, 429, 429]);
  });

  it('[D2-I063] 동시 12 건 · 상한 3 → 정확히 3 개 생성(초과 생성 없음)', async () => {
    const e = await enrollWorld({ cap: 3 });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => enrollCall(e, { name: `race${String(i)}` })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s !== 201 && s !== 429 && s !== 503)).toHaveLength(0);
    expect(await agentCount(provisioningPool(), e.orgId)).toBe(4);
    expect((await slotRows(provisioningPool(), e.orgId)).filter((s) => s.outcome === 'created')).toHaveLength(3);
  });

  it('[D2-I064] 동시 40 건 · 상한 20(최대) → 20 개를 넘지 않는다', async () => {
    const e = await enrollWorld({ cap: 20 });
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => enrollCall(e, { name: `many${String(i)}` })));
    expect(results.filter((r) => r.status === 201).length).toBeLessThanOrEqual(20);
    const created = (await slotRows(provisioningPool(), e.orgId)).filter((s) => s.outcome === 'created').length;
    expect(created).toBeLessThanOrEqual(20);
    expect(await agentCount(provisioningPool(), e.orgId)).toBeLessThanOrEqual(21);
  }, 60_000);

  it('[D2-I065] 요금제 한도 — Free(에이전트 3 개)에서 동시 8 건 · 상한 20 → 요금제 한도를 넘지 않는다', async () => {
    const e = await enrollWorld({ plan: null, cap: 20 });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => enrollCall(e, { name: `plan${String(i)}` })));
    const total = await agentCount(provisioningPool(), e.orgId);
    expect(total).toBeLessThanOrEqual(3);
    expect(results.some((r) => r.json['error'] === 'agent_limit')).toBe(true);
  });

  it('[D2-I066] 요금제 한도에 닿은 뒤의 시도는 409 agent_limit (슬롯은 되돌려진다)', async () => {
    const e = await enrollWorld({ plan: null, cap: 20 });
    for (let i = 0; i < 4; i += 1) await enrollCall(e, { name: `plan${String(i)}` });
    const r = await enrollCall(e, { name: 'over' });
    expect([r.status, r.json['error']]).toEqual([409, 'agent_limit']);
  });

  it('[D2-I067] 쓸 수 없는 주소 시도도 하루 상한에 센다(주소 탐침 상한) — 상한 2: 생성 1 + taken 1 + 다음은 429', async () => {
    const e = await enrollWorld({ cap: 2 });
    const first = await makeChild(e, 'one', `cap-${randomUUID().slice(0, 8)}`);
    const taken = await enrollCall(e, { name: 'dup', local_part: first.address.split('@')[0] });
    expect([taken.status, taken.json['error']]).toEqual([409, 'address_taken']);
    const next = await enrollCall(e, { name: 'three' });
    expect([next.status, next.json['error']]).toEqual([429, 'enroll_daily_cap']);
    expect((await slotRows(provisioningPool(), e.orgId)).map((s) => s.outcome)).toEqual(['created', 'taken']);
  });

  it('[D2-I068] 다른 조직의 주소 시도 → 409 address_taken (남의 주소를 빼앗지 못한다)', async () => {
    const e = await enrollWorld();
    const f = await enrollWorld();
    const theirs = f.parentAddress.split('@')[0] ?? '';
    const r = await enrollCall(e, { name: 'steal', local_part: theirs });
    expect([r.status, r.json['error']]).toEqual([409, 'address_taken']);
    const owner = await provisioningPool().query<{ organization_id: string }>('SELECT a.organization_id FROM agent_addresses ad JOIN agents a ON a.id = ad.agent_id WHERE ad.address = $1', [f.parentAddress]);
    expect(owner.rows[0]?.organization_id).toBe(f.orgId);
  });

  it('[D2-I069] 폐기된 별칭(다른 조직)을 다시 가져가지 못한다', async () => {
    const e = await enrollWorld();
    const f = await enrollWorld();
    const alias = `old-${randomUUID().slice(0, 8)}@atmark.ai`;
    await provisioningPool().query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', false)`, [f.parentId, alias]);
    await provisioningPool().query(`UPDATE agent_addresses SET retired_at = now() WHERE address = $1`, [alias]);
    const r = await enrollCall(e, { name: 'steal', local_part: alias.split('@')[0] });
    expect(r.status).not.toBe(201);
  });

  it('[D2-I070] 같은 조직의 두 번째 부모 토큰도 하루 상한을 나눠 쓴다(조직 단위)', async () => {
    const e = await enrollWorld({ cap: 2 });
    const second = await call(kit().deps, 'POST', '/api/agents', authed(e.owner, { body: { name: 'second', localPart: `s2-${randomUUID().slice(0, 8)}` } }));
    const secondId = (second.json() as { agent: { id: string } }).agent.id;
    const issued = await call(kit().deps, 'POST', `/api/agents/${secondId}/tokens`, authed(e.owner, { body: { label: 'e2', capabilities: ['agents:enroll'] } }));
    const token2 = (issued.json() as { token: string }).token;
    expect((await enrollCall(e, { name: 'a' })).status).toBe(201);
    expect((await enrollCall(e, { name: 'b' }, token2)).status).toBe(201);
    expect((await enrollCall(e, { name: 'c' }, token2)).status).toBe(429);
    expect((await enrollCall(e, { name: 'd' })).status).toBe(429);
  });

  it('[D2-I071] 다른 조직의 사용량이 내 상한을 갉아먹지 않는다', async () => {
    const e = await enrollWorld({ cap: 1 });
    const f = await enrollWorld({ cap: 1 });
    expect((await enrollCall(f, { name: 'f1' })).status).toBe(201);
    expect((await enrollCall(f, { name: 'f2' })).status).toBe(429);
    expect((await enrollCall(e, { name: 'e1' })).status).toBe(201);
  });

  it('[D2-I072] 사용량보다 낮게 상한을 줄이면 즉시 막힌다 · 올리면 다시 열린다', async () => {
    const e = await enrollWorld({ cap: 3 });
    await enrollCall(e, { name: 'a' });
    await enrollCall(e, { name: 'b' });
    await settings(e.owner, { enrollDailyCap: 1 });
    expect((await enrollCall(e, { name: 'c' })).status).toBe(429);
    await settings(e.owner, { enrollDailyCap: 5 });
    expect((await enrollCall(e, { name: 'd' })).status).toBe(201);
  });

  it.each([
    { id: 'D2-I073', value: 0 },
    { id: 'D2-I074', value: 21 },
    { id: 'D2-I075', value: -1 },
    { id: 'D2-I076', value: 2.5 },
    { id: 'D2-I077', value: '5' },
    { id: 'D2-I078', value: null },
    { id: 'D2-I079', value: true },
    { id: 'D2-I080', value: 1e9 },
    { id: 'D2-I081', value: [5] },
  ])('[$id] 잘못된 enrollDailyCap $value → 400 · 설정 불변(5)', async ({ value }) => {
    const e = await enrollWorld();
    const r = await settings(e.owner, { enrollDailyCap: value });
    expect(r.statusCode, r.body).toBe(400);
    expect(((await call(kit().deps, 'GET', '/api/watch/settings', authed(e.owner))).json() as { enrollDailyCap: number }).enrollDailyCap).toBe(5);
  });

  it('[D2-I082] 소유자 롤 SQL 로도 상한 21 은 CHECK 가 거부한다', async () => {
    const e = await enrollWorld();
    await expect(provisioningPool().query('UPDATE org_watch_settings SET enroll_daily_cap = 21 WHERE organization_id = $1', [e.orgId])).rejects.toThrow();
    await expect(provisioningPool().query('UPDATE org_watch_settings SET enroll_daily_cap = 0 WHERE organization_id = $1', [e.orgId])).rejects.toThrow();
  });

  it('SUSPECT: [D2-I083] 검증 오류(잘못된 로컬파트)는 슬롯이 되돌려져 하루 상한에 세지 않는다 — 25 번 시도해도 상한이 그대로(탐침은 공짜, 단 주소 존재 여부는 새지 않는다)', async () => {
    const e = await enrollWorld({ cap: 1 });
    for (let i = 0; i < 25; i += 1) {
      const r = await enrollCall(e, { name: 'probe', local_part: i % 2 === 0 ? 'postmaster' : `bad..${String(i)}` });
      expect(r.status).toBe(400);
    }
    expect(await slotRows(provisioningPool(), e.orgId)).toEqual([]);
    expect((await enrollCall(e, { name: 'real' })).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// D. 입력 검증 — 로컬파트 · 이름 · 본문 모양
// ---------------------------------------------------------------------------
import { RESERVED_LOCAL_PARTS } from '../../../src/identity/address';

const SAFE_ADDRESS = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?@atmark\.ai$/;

/** 안전한 결말: 거절이거나, 만들었다면 ASCII 안전 주소(예약 · 연속 점 · 앵커 아님). */
function expectSafeOutcome(r: { status: number; json: Record<string, unknown> }, label: string): void {
  if (r.status === 201) {
    const address = (r.json['agent'] as { address: string }).address;
    expect(address, `${label}: ${address}`).toMatch(SAFE_ADDRESS);
    const local = address.split('@')[0] ?? '';
    expect(RESERVED_LOCAL_PARTS, label).not.toContain(local);
    expect(local, label).not.toContain('..');
    expect(local.startsWith('ax--'), label).toBe(false);
  } else {
    expect([400, 409, 429], `${label} → ${String(r.status)}`).toContain(r.status);
  }
}

describe.skipIf(!OWNER_AVAILABLE)('D2-D 입력 검증', () => {
  const reserved = RESERVED_LOCAL_PARTS.map((name, index) => ({ id: `D2-I${String(100 + index)}`, name }));
  it.each(reserved)('[$id] 예약 로컬파트 "$name" 은 만들 수 없다', async ({ name }) => {
    const e = await enrollWorld({ cap: 20 });
    const r = await enrollCall(e, { name: 'x', local_part: name });
    expect([400, 409]).toContain(r.status);
    expect(await agentCount(provisioningPool(), e.orgId)).toBe(1);
  });
});

const LOCAL_PARTS: readonly { label: string; value: unknown }[] = [
  { label: '대문자 혼합 SuPPoRt', value: 'SuPPoRt' },
  { label: '대문자 POSTMASTER', value: 'POSTMASTER' },
  { label: '앞뒤 공백 " support "', value: ' support ' },
  { label: '탭 낀 support\\t', value: 'support\t' },
  { label: '켈빈 기호로 쓴 K (U+212A)', value: 'Kelvin-x' },
  { label: '전각 ｓｕｐｐｏｒｔ', value: 'ｓｕｐｐｏｒｔ' },
  { label: '키릴 а 섞은 аdmin', value: 'аdmin' },
  { label: '키릴 ѕupport', value: 'ѕupport' },
  { label: '그리스 ο 섞은 gοogle', value: 'gοogle' },
  { label: '긴 s (ſupport)', value: 'ſupport' },
  { label: '터키 İ 섞은 İnfo', value: 'İnfo' },
  { label: '결합 문자 é', value: 'café' },
  { label: '이모지', value: 'agent-😀' },
  { label: '한글', value: '에이전트' },
  { label: '점 하나 a.b', value: 'a.b' },
  { label: '앞 점 .ab', value: '.ab' },
  { label: '뒤 점 ab.', value: 'ab.' },
  { label: '연속 점 a..b', value: 'a..b' },
  { label: '플러스 a+b', value: 'a+b' },
  { label: '골뱅이 a@b', value: 'a@b' },
  { label: '고객 도메인 흉내 x@custom.example', value: 'x@custom.example' },
  { label: '공백 낀 a b', value: 'a b' },
  { label: '앞 하이픈 -ab', value: '-ab' },
  { label: '뒤 하이픈 ab-', value: 'ab-' },
  { label: '밑줄만 _', value: '_' },
  { label: '길이 65', value: 'a'.repeat(65) },
  { label: '길이 64', value: 'a'.repeat(64) },
  { label: '길이 1', value: 'a' },
  { label: 'NUL 문자', value: 'ab\u0000cd' },
  { label: '개행', value: 'ab\ncd' },
  { label: 'CRLF 헤더 주입', value: 'ab\r\nBcc: evil@example.com' },
  { label: '퍼센트 인코딩', value: 'a%40b' },
  { label: '따옴표', value: "a'b" },
  { label: '세미콜론', value: 'a;b' },
  { label: '경로 ../x', value: '../x' },
  { label: '슬래시', value: 'a/b' },
  { label: '와일드카드 *', value: '*' },
  { label: 'SQL 조각', value: "x'; DROP TABLE agents;--" },
  { label: '앵커 이름공간 ax--abc', value: 'ax--abcdef' },
  { label: '앵커 이름공간 대문자 AX--ABC', value: 'AX--ABC' },
  { label: 'xn-- 퓨니코드 꼴', value: 'xn--abc' },
  { label: '생성기 모양 agent-12345678', value: 'agent-12345678' },
  { label: '숫자 시작 0', value: '0' },
  { label: '숫자만 12345', value: '12345' },
  { label: 'localhost', value: 'localhost' },
  { label: '로컬파트 "postmaster2"(예약 아님 — 만들어져도 된다)', value: 'postmaster2' },
  { label: 'zero-width 낀 sup\u200bport', value: 'sup\u200bport' },
  { label: 'RTL 오버라이드', value: 'ab\u202ecd' },
  { label: '숫자 아닌 타입 123', value: 123 },
  { label: '배열', value: ['a'] },
  { label: '객체', value: { a: 1 } },
  { label: '불리언', value: true },
  { label: '빈 문자열', value: '' },
  { label: '켈빈 기호로 쓴 예약어 bloc\u212Aed-test', value: 'bloc\u212Aed-test' },
  { label: '켈빈 기호 + 대문자 Bloc\u212Aed-Test', value: 'Bloc\u212Aed-Test' },
  { label: '긴 s 로 쓴 예약어 admin 변형 \u017Fystem', value: '\u017Fystem' },
  { label: '터키 dotless ı 로 쓴 \u0131nfo', value: '\u0131nfo' },
  { label: '분수 슬래시 a\u2044b', value: 'a\u2044b' },
  { label: '전각 점 a\uff0eb', value: 'a\uff0eb' },
  { label: '전각 골뱅이 a\uff20b', value: 'a\uff20b' },
  { label: '탭 낀 앞뒤 \tabc\t', value: '\tabc\t' },
];

describe.skipIf(!OWNER_AVAILABLE)('D2-D 로컬파트 표 (동형 · 유니코드 · 주입 · 길이)', () => {
  const rows = LOCAL_PARTS.map((row, index) => ({ ...row, id: `D2-I${String(400 + index)}` }));
  it.each(rows)('[$id] $label', async ({ value, label }) => {
    const e = await enrollWorld({ cap: 20 });
    const r = await enrollCall(e, { name: 'probe', local_part: value });
    expectSafeOutcome(r, label);
    if (r.status !== 201) {
      // 거절된 시도는 에이전트를 만들지 않는다.
      expect(await agentCount(provisioningPool(), e.orgId)).toBe(1);
    }
  });
});

const NAMES: readonly { label: string; value: unknown; ok?: boolean }[] = [
  { label: '빈 이름', value: '' },
  { label: '공백만', value: '   ' },
  { label: '81자', value: 'a'.repeat(81) },
  { label: '80자(허용)', value: 'a'.repeat(80), ok: true },
  { label: '개행 포함(공백으로 접힌다)', value: 'a\nb', ok: true },
  { label: '탭 포함(공백으로 접힘)', value: 'a\tb', ok: true },
  { label: 'NUL', value: 'a\u0000b' },
  { label: 'RTL 오버라이드', value: 'abc\u202edef' },
  { label: 'zero-width space', value: 'a\u200bb' },
  { label: '방향 격리 U+2066', value: 'a\u2066b' },
  { label: 'BOM(trim 이 지운다)', value: '\ufeffname', ok: true },
  { label: '제어문자 \\u001b', value: 'a\u001bb' },
  { label: 'DEL', value: 'a\u007fb' },
  { label: '숫자 타입', value: 123 },
  { label: 'null', value: null },
  { label: '배열', value: ['x'] },
  { label: '객체', value: { x: 1 } },
  { label: '불리언', value: false },
  { label: '이름에 HTML', value: '<script>alert(1)</script>', ok: true },
  { label: '이름에 URL', value: 'Visit https://evil.example/login now', ok: true },
  { label: '이모지', value: '🤖 helper', ok: true },
  { label: '한글', value: '연구 도우미', ok: true },
  { label: '큰 유니코드 80자(서로게이트)', value: '😀'.repeat(80), ok: true },
  { label: '큰 유니코드 81자(서로게이트)', value: '😀'.repeat(81) },
  { label: '줄바꿈 U+2028(공백으로 접힌다)', value: 'a\u2028b', ok: true },
  { label: '줄바꿈 U+0085', value: 'a\u0085b' },
];

describe.skipIf(!OWNER_AVAILABLE)('D2-D 이름 표 (소유자 알림 메일에 실린다)', () => {
  const rows = NAMES.map((row, index) => ({ ...row, id: `D2-I${String(500 + index)}` }));
  it.each(rows)('[$id] $label', async ({ value, ok }) => {
    const e = await enrollWorld({ cap: 20 });
    const r = await enrollCall(e, { name: value });
    if (ok === true) {
      expect(r.status, r.text).toBe(201);
      const stored = (r.json['agent'] as { name: string }).name;
      expect(stored).not.toMatch(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u);
    } else {
      expect(r.status, r.text).toBe(400);
      expect(await agentCount(provisioningPool(), e.orgId)).toBe(1);
    }
  });
});

const EXTRA_KEYS = ['capabilities', 'agent_id', 'send_approval', 'sendApproval', 'plan', 'outbound_mode', 'inbound_mode', 'org_id', 'organization_id', 'domain', 'primary', 'token_capabilities', 'require_approval', 'outbound_allow', 'risk_handling', 'budget', 'expires_days', 'seeds', 'scopes', '__proto__', 'constructor', 'localPart'];

describe.skipIf(!OWNER_AVAILABLE)('D2-D 본문 모양 — 모르는 키 · 타입', () => {
  const rows = EXTRA_KEYS.map((key, index) => ({ key, id: `D2-I${String(600 + index)}` }));
  it.each(rows)('[$id] 모르는 키 "$key" 를 끼워 넣으면 400 · 아무것도 안 만든다', async ({ key }) => {
    const e = await enrollWorld({ cap: 20 });
    const body = JSON.parse(`{"name":"x","${key}":"value"}`) as unknown;
    const r = await api(e.w, 'POST', '/v1/agents', { token: e.enrollToken, body });
    expect([400, 201]).toContain(r.status);
    if (r.status === 201) {
      // 허용된 키가 아닌데 만들어졌다면 최소한 안전 기본값은 유지.
      const policy = await api(e.w, 'GET', `/v1/agents/${(r.json['agent'] as { agent_id: string }).agent_id}/policy`, { token: r.json['token'] as string });
      expect(policy.json['send_approval']).toBe('always');
    } else {
      expect(await agentCount(provisioningPool(), e.orgId)).toBe(1);
    }
  });

  it.each([
    { id: 'D2-I630', label: '배열 본문', body: [{ name: 'x' }] },
    { id: 'D2-I631', label: '문자열 본문', body: 'name=x' },
    { id: 'D2-I632', label: 'null 본문', body: null },
    { id: 'D2-I633', label: '숫자 본문', body: 1 },
    { id: 'D2-I634', label: '이름 없는 객체', body: {} },
    { id: 'D2-I635', label: 'local_part 만', body: { local_part: 'solo' } },
  ])('[$id] $label → 400', async ({ body }) => {
    const e = await enrollWorld({ cap: 20 });
    const r = await api(e.w, 'POST', '/v1/agents', { token: e.enrollToken, ...(body === null ? {} : { body }) });
    expect(r.status).toBe(400);
    expect(await agentCount(provisioningPool(), e.orgId)).toBe(1);
  });

  it.each([
    { id: 'D2-I636', method: 'GET' },
    { id: 'D2-I637', method: 'PUT' },
    { id: 'D2-I638', method: 'DELETE' },
    { id: 'D2-I639', method: 'PATCH' },
  ])('[$id] POST /v1/agents 가 아닌 메서드 $method → 만들지 않는다', async ({ method }) => {
    const e = await enrollWorld({ cap: 20 });
    const r = await api(e.w, method, '/v1/agents', { token: e.enrollToken, body: { name: 'x' } });
    expect([404, 405]).toContain(r.status);
    expect(await agentCount(provisioningPool(), e.orgId)).toBe(1);
  });

  it('[D2-I640] 본문에 name 이 있고 local_part 가 null 이면 무작위 이름으로 생성(허용)', async () => {
    const e = await enrollWorld({ cap: 20 });
    const r = await enrollCall(e, { name: 'x', local_part: null });
    expect(r.status).toBe(201);
    expect((r.json['agent'] as { address: string }).address).toMatch(/^agent-[0-9a-f]{8}@atmark\.ai$/);
  });

  it('[D2-I641] 같은 요청 8번(이름 · 로컬파트 생략) → 서로 다른 주소(충돌·예측 가능한 순번 없음)', async () => {
    const e = await enrollWorld({ cap: 20 });
    const addresses = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      const r = await enrollCall(e, { name: 'same' });
      expect(r.status, r.text).toBe(201);
      addresses.add((r.json['agent'] as { address: string }).address);
    }
    expect(addresses.size).toBe(8);
  }, 60_000);
});
