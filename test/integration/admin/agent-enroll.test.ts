/**
 * **자가 등록(ADR-0016 2026-10-08 — `agents:enroll`) · 실제 Postgres 위 · admin 롤(`atmark_admin`) GRANT 안에서.** 실메일 0.
 *
 *   ① 기본 꺼짐 — 조직 설정이 꺼져 있으면 `self_enroll_disabled`(슬롯도 남지 않는다).
 *   ② 소유자만 `agents:enroll` 토큰을 준다(관리자 403) · 소유자만 조직 설정을 켠다.
 *   ③ 켜면 — 안전 기본값의 형제 에이전트(발신 allowlist_only 빈 목록 · 수신 all · 발신 승인 always(행 + 스냅샷) · 위험 hold · 토큰 셋 권한) · 감사 행 ·
 *      알림 창(kind enroll) · 새 토큰은 응답에만(해시만 저장).
 *   ④ 연쇄 금지 — 만든 에이전트에 `agents:enroll` 토큰을 붙일 수 없다(소유자도) · 만든 토큰으로 부르면 `scope_missing`.
 *   ⑤ 하루 상한(DB) — 쓸 수 없는 주소 시도도 센다 · 상한에서 `enroll_daily_cap`.
 *   ⑥ 거절 — 권한 없는 토큰 · 폐기 토큰 · 정지된 에이전트 · 소유자 정지 조직 · 예약 로컬파트 · 이름.
 *   ⑦ REST 라우트(`POST /v1/agents`)를 실제 admin 연산에 이어 — 201 모양 · 거절 매핑. 발견(`self_enroll`)이 상태를 말한다.
 *   ⑧ admin 롤도 슬롯을 끝난 상태로 넣거나 한 번 더 끝낼 수 없다(트리거).
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { enrollAgentOp } from '../../../src/admin/ops/enroll';
import { handleEnrollAgent } from '../../../src/api/routes/agents-enroll';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories/agent-token-store';
import { createPostgresSelfEnrollStatus } from '../../../src/db/repositories/self-enroll-status';
import { hashAgentToken } from '../../../src/identity/agent-token';
import { ENROLL_EVENT_ACTION, ENROLL_EVENT_SOURCE, ENROLL_EVENT_VERSION, type EnrollEvent } from '../../../src/runtime/enroll-event';
import { testKeyCustody } from '../../unit/identity/fixtures';
import { createQuarantineNotifier } from '../../../src/notify/quarantine-notifier';
import { runQuarantineNotifier } from '../../../src/workers/quarantine-notifier';
import { closeTestPool } from '../db/support/harness';
import { adminDeps, adminRolePool, appPool, authed, AVAILABLE, call, fakeSes, login, mailText, loginMailerPool, newOrganization, ownerPool, suffix, userIdOf, type Session } from './support';

interface Fixture {
  readonly orgId: string;
  readonly session: Session;
  readonly agentId: string;
  /** `agents:enroll` 이 있는 토큰. */
  readonly enrollToken: string;
}

function eventOf(token: string, name: string, localPart: string | null = null): EnrollEvent {
  return { source: ENROLL_EVENT_SOURCE, action: ENROLL_EVENT_ACTION, v: ENROLL_EVENT_VERSION, token, name, localPart, requestId: `req-${suffix()}` };
}

describe.skipIf(!AVAILABLE)('자가 등록 — agents:enroll', () => {
  let owner: Pool;
  let admin: Pool;
  let app: Pool;
  let mailer: Pool;
  let deps: AdminDependencies;
  const custody = testKeyCustody();

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    app = appPool();
    mailer = loginMailerPool();
    deps = adminDeps(admin);
  });
  afterAll(async () => {
    await owner.end();
    await admin.end();
    await app.end();
    await mailer.end();
    await closeTestPool();
  });

  const settings = (session: Session, body: Record<string, unknown>) => call(deps, 'PATCH', '/api/watch/settings', authed(session, { body }));

  async function fixture(enable = true): Promise<Fixture> {
    const org = await newOrganization(owner);
    await owner.query(`UPDATE organizations SET review_status = 'active' WHERE id = $1`, [org.id]);
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'parent', localPart: `pa-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const agentId = (created.json() as { agent: { id: string } }).agent.id;
    const issued = await call(
      deps,
      'POST',
      `/api/agents/${agentId}/tokens`,
      authed(session, { body: { label: 'enroll', capabilities: ['messages:read', 'agent:read_self', 'agents:enroll'] } }),
    );
    expect(issued.statusCode, issued.body).toBe(201);
    if (enable) expect((await settings(session, { agentSelfEnroll: true })).statusCode).toBe(200);
    return { orgId: org.id, session, agentId, enrollToken: (issued.json() as { token: string }).token };
  }

  async function asRole(f: Fixture, role: 'admin' | 'member'): Promise<Session> {
    const email = `en-${role}-${suffix()}@example.com`;
    await owner.query('INSERT INTO users (email) VALUES ($1)', [email]);
    const userId = await userIdOf(owner, email);
    await owner.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, $3, 'invite')`, [userId, f.orgId, role]);
    return login(deps, mailer, { id: f.orgId, ownerEmail: email });
  }

  const slots = async (orgId: string): Promise<{ outcome: string; child_agent_id: string | null; notice_id: string | null }[]> =>
    (
      await owner.query<{ outcome: string; child_agent_id: string | null; notice_id: string | null }>(
        'SELECT outcome, child_agent_id, notice_id FROM agent_enrollments WHERE organization_id = $1 ORDER BY created_at, id',
        [orgId],
      )
    ).rows;

  it('① 기본 꺼짐 — self_enroll_disabled · 슬롯 없음 · 설정 읽기 기본값', async () => {
    const f = await fixture(false);
    expect((await call(deps, 'GET', '/api/watch/settings', authed(f.session))).json()).toMatchObject({
      agentSelfEnroll: false,
      enrollDailyCap: 5,
      maxEnrollDailyCap: 20,
      notifyOnEnroll: true,
      notifyOnSignup: true,
    });
    expect(await enrollAgentOp(admin, custody, eventOf(f.enrollToken, 'child'))).toEqual({ ok: false, error: 'self_enroll_disabled' });
    expect(await slots(f.orgId)).toEqual([]);
  });

  it('② 소유자만 — agents:enroll 토큰 · 조직 설정(관리자 403) · 설정 검증 · 감사 watch.org.set', async () => {
    const f = await fixture(false);
    const asAdmin = await asRole(f, 'admin');
    const denied = await call(deps, 'POST', `/api/agents/${f.agentId}/tokens`, authed(asAdmin, { body: { label: 'x', capabilities: ['agents:enroll'] } }));
    expect(denied.statusCode).toBe(403);
    expect((await settings(asAdmin, { agentSelfEnroll: true })).statusCode).toBe(403);
    for (const bad of [{ enrollDailyCap: 0 }, { enrollDailyCap: 21 }, { enrollDailyCap: 2.5 }, { agentSelfEnroll: 'yes' }, { agentSelfEnroll: true, trustedSenders: [] }]) {
      expect((await settings(f.session, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const on = await settings(f.session, { agentSelfEnroll: true, enrollDailyCap: 3, notifyOnSignup: false });
    expect(on.json()).toMatchObject({ changed: true, agentSelfEnroll: true, enrollDailyCap: 3, notifyOnSignup: false, notifyOnEnroll: true });
    expect((await settings(f.session, { agentSelfEnroll: true })).json()).toMatchObject({ changed: false });
    const audit = await owner.query<{ action: string }>(`SELECT action FROM owner_actions WHERE organization_id = $1 AND action = 'watch.org.set'`, [f.orgId]);
    expect(audit.rows).toHaveLength(1);
  });

  it('③ 켜면 — 안전 기본값 · 감사 행 · 알림 창 · 토큰은 해시만', async () => {
    const f = await fixture();
    const result = await enrollAgentOp(admin, custody, eventOf(f.enrollToken, '  Research   helper ', `ch-${suffix()}`));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.agent.name).toBe('Research helper');
    expect(result.scopes).toEqual(['messages:send', 'messages:read', 'agent:read_self']);
    const child = result.agent.id;

    const policy = await owner.query<{ outbound_mode: string; inbound_mode: string; require_approval: boolean; snap: unknown; rules: number; created_by: string }>(
      `SELECT pv.outbound_mode, pv.inbound_mode, p.require_approval, pv.snapshot -> 'require_approval' AS snap,
              jsonb_array_length(pv.snapshot -> 'contact_rules') AS rules, pv.created_by
         FROM agent_policies p JOIN policy_versions pv ON pv.agent_id = p.agent_id AND pv.version = p.current_version WHERE p.agent_id = $1`,
      [child],
    );
    expect(policy.rows[0]).toEqual({ outbound_mode: 'allowlist_only', inbound_mode: 'all', require_approval: true, snap: true, rules: 0, created_by: `agent:${f.agentId}` });
    const watch = await owner.query<{ risk_handling: string }>('SELECT risk_handling FROM agent_watch_settings WHERE agent_id = $1', [child]);
    expect(watch.rows[0]?.risk_handling).toBe('hold');
    const keys = await owner.query<{ caps: string[]; token_hash: string }>('SELECT capabilities::text[] AS caps, token_hash FROM agent_api_keys WHERE agent_id = $1', [child]);
    expect(keys.rows).toHaveLength(1);
    expect(keys.rows[0]?.caps.sort()).toEqual(['agent:read_self', 'messages:read', 'messages:send']);
    expect(keys.rows[0]?.token_hash).toBe(hashAgentToken(result.token));
    const rows = await slots(f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'created', child_agent_id: child });
    const notice = await owner.query<{ kind: string; message_count: number; agent_id: string }>('SELECT kind, message_count, agent_id FROM quarantine_notices WHERE id = $1', [rows[0]?.notice_id]);
    expect(notice.rows[0]).toEqual({ kind: 'enroll', message_count: 1, agent_id: f.agentId });
    // 콘솔 감시 탭 — 새 에이전트의 발신 승인이 always 로 보인다.
    expect((await call(deps, 'GET', `/api/agents/${child}/watch`, authed(f.session))).json()).toMatchObject({ sendApproval: 'always', riskHandling: 'hold' });
    // 알림 — 기한이 되면 소유자에게 한 통(새 에이전트의 주소 · 감시 탭 — 2026-10-10 개편: 에이전트가 지은 이름 · 안전 기본값 설명은 싣지 않는다). 토큰은 없다.
    await owner.query(`UPDATE quarantine_notices SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [rows[0]?.notice_id]);
    const ses = fakeSes();
    const later = () => new Date(Date.now() + 2_000);
    const report = await runQuarantineNotifier({ db: app, notifier: createQuarantineNotifier({ pool: app, client: ses.client, now: later }), now: later }, { organizationId: f.orgId });
    expect(report.sent).toBe(1);
    const text = mailText(ses.sent[0]!);
    expect(text).not.toContain('Research helper');
    // 새 에이전트 주소 — text 는 [.] 로 끊는다(HTML 은 점마다 인라인 요소 — 2026-10-10 진윤겸 결정).
    expect(text).toContain(result.agent.address.replace(/\./g, '[.]'));
    // 소유자가 메일 언어를 고르지 않았다 — 영어 한 통(2026-10-10).
    expect(text).toContain('New agents created');
    expect(text).toContain(' created:');
    expect(text).not.toContain('새 에이전트 1개를 만들었습니다');
    expect(text).not.toContain(result.token);
  });

  it('④ 연쇄 금지 — 만든 에이전트에 agents:enroll 없음(소유자도 못 붙인다) · 만든 토큰으로 부르면 scope_missing', async () => {
    const f = await fixture();
    const result = await enrollAgentOp(admin, custody, eventOf(f.enrollToken, 'child'));
    if (!result.ok) throw new Error(JSON.stringify(result));
    const again = await call(deps, 'POST', `/api/agents/${result.agent.id}/tokens`, authed(f.session, { body: { label: 'chain', capabilities: ['agents:enroll'] } }));
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json()).toMatchObject({ error: 'enroll_chain_forbidden' });
    // DB 트리거가 같은 것을 한 번 더 막는다(콘솔 검사를 건너뛴 쓰기).
    await expect(
      admin.query(`INSERT INTO agent_api_keys (agent_id, token_hash, capabilities) VALUES ($1, $2, '{agents:enroll}')`, [result.agent.id, 'a'.repeat(64)]),
    ).rejects.toMatchObject({ code: 'P0A35' });
    expect(await enrollAgentOp(admin, custody, eventOf(result.token, 'grandchild'))).toEqual({ ok: false, error: 'scope_missing' });
  });

  it('⑤ 하루 상한 — 쓸 수 없는 주소 시도도 센다 · 상한에서 enroll_daily_cap', async () => {
    const f = await fixture();
    await settings(f.session, { enrollDailyCap: 2 });
    const first = await enrollAgentOp(admin, custody, eventOf(f.enrollToken, 'one', `cap-${suffix()}`));
    if (!first.ok) throw new Error(JSON.stringify(first));
    const taken = first.agent.address.slice(0, first.agent.address.indexOf('@'));
    expect(await enrollAgentOp(admin, custody, eventOf(f.enrollToken, 'dup', taken))).toEqual({ ok: false, error: 'address_taken' });
    expect(await enrollAgentOp(admin, custody, eventOf(f.enrollToken, 'three'))).toEqual({ ok: false, error: 'enroll_daily_cap' });
    expect((await slots(f.orgId)).map((row) => row.outcome)).toEqual(['created', 'taken']);
  });

  it('⑥ 거절 — 권한 없음 · 폐기 · 정지 에이전트 · 소유자 정지 · 예약 로컬파트 · 이름', async () => {
    const f = await fixture();
    expect(await enrollAgentOp(admin, custody, eventOf(f.enrollToken, 'x', 'postmaster'))).toEqual({ ok: false, error: 'invalid_local_part' });
    expect(await enrollAgentOp(admin, custody, eventOf(f.enrollToken, 'bad‮name'))).toEqual({ ok: false, error: 'invalid_name' });
    expect(await enrollAgentOp(admin, custody, eventOf(`atk_agent_${'A'.repeat(43)}`, 'x'))).toEqual({ ok: false, error: 'unauthorized' });
    await owner.query(`UPDATE organizations SET owner_paused = true WHERE id = $1`, [f.orgId]);
    expect(await enrollAgentOp(admin, custody, eventOf(f.enrollToken, 'x'))).toEqual({ ok: false, error: 'not_active' });
    await owner.query(`UPDATE organizations SET owner_paused = false WHERE id = $1`, [f.orgId]);
    await owner.query(`UPDATE agents SET status = 'suspended', suspended_by = 'owner' WHERE id = $1`, [f.agentId]);
    expect(await enrollAgentOp(admin, custody, eventOf(f.enrollToken, 'x'))).toEqual({ ok: false, error: 'not_active' });
    await owner.query(`UPDATE agents SET status = 'active', suspended_by = NULL WHERE id = $1`, [f.agentId]);
    await owner.query('UPDATE agent_api_keys SET revoked_at = now() WHERE token_hash = $1', [hashAgentToken(f.enrollToken)]);
    expect(await enrollAgentOp(admin, custody, eventOf(f.enrollToken, 'x'))).toEqual({ ok: false, error: 'unauthorized' });
    expect(await slots(f.orgId)).toEqual([]);
  });

  it('⑦ REST 라우트 → admin 연산 — 201 모양 · 권한 없는 토큰 403 · 발견 self_enroll', async () => {
    const f = await fixture();
    const tokens = createPostgresAgentTokenStore(app);
    const routeDeps = {
      tokens,
      enroll: async (event: EnrollEvent) => ({ ok: true as const, body: JSON.parse(JSON.stringify(await enrollAgentOp(admin, custody, event))) as unknown }),
      now: () => new Date(),
      requestId: () => `req-${suffix()}`,
      precheck: null,
    };
    const request = (token: string, body: unknown) => ({ headers: { authorization: `Bearer ${token}` }, query: {}, body });
    const created = await handleEnrollAgent(routeDeps, request(f.enrollToken, { name: 'via api' }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      token_shown_once: true,
      token_scopes: ['messages:send', 'messages:read', 'agent:read_self'],
      defaults: { outbound_mode: 'allowlist_only', outbound_allow: [], inbound_mode: 'all', send_approval: 'always', risk_handling: 'hold' },
      policy_version: 1,
    });
    expect((created.body['agent'] as { address: string }).address).toMatch(/^agent-[0-9a-f]{8}@atmark\.ai$/);
    const childToken = created.body['token'] as string;
    expect((await handleEnrollAgent(routeDeps, request(childToken, { name: 'nope' }))).status).toBe(403);
    expect((await handleEnrollAgent(routeDeps, request(f.enrollToken, { name: 'x', extra: 1 }))).status).toBe(400);
    expect((await handleEnrollAgent({ ...routeDeps, enroll: null }, request(f.enrollToken, { name: 'x' }))).status).toBe(503);
    expect(await createPostgresSelfEnrollStatus(app).load(f.agentId)).toEqual({ enabled: true, dailyCap: 5, usedLast24h: 1 });
  });

  it('⑨ 앞 거르개(admin 을 부르기 전) — 꺼짐 403 · 에이전트당 분당 3 넘으면 429 enroll_rate_limited · 하루 상한 429 · 거른 요청은 admin 을 부르지 않는다', async () => {
    const off = await fixture(false);
    const status = createPostgresSelfEnrollStatus(app);
    let invoked = 0;
    const routeDeps = {
      tokens: createPostgresAgentTokenStore(app),
      enroll: () => {
        invoked += 1;
        return Promise.resolve({ ok: true as const, body: { ok: false, error: 'agent_limit' } as unknown });
      },
      now: () => new Date(),
      requestId: () => `req-${suffix()}`,
      precheck: (agentId: string) => status.precheck(agentId),
    };
    const request = (token: string) => ({ headers: { authorization: `Bearer ${token}` }, query: {}, body: { name: 'x' } });
    expect((await handleEnrollAgent(routeDeps, request(off.enrollToken))).body).toMatchObject({ error: 'self_enroll_disabled' });
    expect(invoked).toBe(0);
    const f = await fixture();
    for (let i = 0; i < 3; i += 1) expect((await handleEnrollAgent(routeDeps, request(f.enrollToken))).status).toBe(409);
    expect(invoked).toBe(3);
    const limited = await handleEnrollAgent(routeDeps, request(f.enrollToken));
    expect([limited.status, limited.body['error']]).toEqual([429, 'enroll_rate_limited']);
    expect(invoked).toBe(3);
    // 하루 상한 — 슬롯 행이 상한만큼 있으면 admin 을 부르지 않는다.
    const g = await fixture();
    await settings(g.session, { enrollDailyCap: 1 });
    const first = await enrollAgentOp(admin, custody, eventOf(g.enrollToken, 'one'));
    expect(first.ok).toBe(true);
    const capped = await handleEnrollAgent(routeDeps, request(g.enrollToken));
    expect([capped.status, capped.body['error']]).toEqual([429, 'enroll_daily_cap']);
    expect(invoked).toBe(3);
    // 앱 롤은 계수 표에 직접 쓰거나 지우지 못한다.
    await expect(app.query('DELETE FROM agent_enroll_attempts WHERE agent_id = $1', [f.agentId])).rejects.toThrow();
    await expect(app.query('INSERT INTO agent_enroll_attempts (agent_id) VALUES ($1)', [f.agentId])).rejects.toThrow();
  });

  it('⑧ admin 롤은 슬롯을 끝난 상태로 넣거나 다시 끝낼 수 없다 · 지울 수 없다', async () => {
    const f = await fixture();
    const key = await owner.query<{ id: string }>('SELECT id FROM agent_api_keys WHERE token_hash = $1', [hashAgentToken(f.enrollToken)]);
    const tokenId = key.rows[0]?.id;
    await expect(
      admin.query(`INSERT INTO agent_enrollments (organization_id, parent_agent_id, parent_token_id, outcome) VALUES ($1, $2, $3, 'created')`, [f.orgId, f.agentId, tokenId]),
    ).rejects.toThrow();
    const result = await enrollAgentOp(admin, custody, eventOf(f.enrollToken, 'once'));
    if (!result.ok) throw new Error(JSON.stringify(result));
    await expect(admin.query(`UPDATE agent_enrollments SET outcome = 'taken', child_agent_id = NULL WHERE organization_id = $1`, [f.orgId])).rejects.toThrow();
    await expect(admin.query('DELETE FROM agent_enrollments WHERE organization_id = $1', [f.orgId])).rejects.toThrow();
    // 앱 롤은 조직 설정을 쓰지 못한다(스스로 켜지 못한다).
    await expect(app.query('UPDATE org_watch_settings SET agent_self_enroll = true WHERE organization_id = $1', [f.orgId])).rejects.toThrow();
  });
});
