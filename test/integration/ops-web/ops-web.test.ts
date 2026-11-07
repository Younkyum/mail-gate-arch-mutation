/**
 * 운영자 웹 화면(`pnpm admin:web`) — 실제 로컬 Postgres(소유자 롤 + 결제 운영자 롤). AWS 호출 0. **로컬 DB 에서만**(15432 는 운영 터널 — 거부).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 읽기: 검토 대기열(가입 조직 · 소유자 · 에이전트 수) · 조직 검색(요금제 근거 · 에이전트/한도) · 조직 상세(멤버 · 에이전트 · 요금제 · 결제 · 감사) · 감사 필터.
 *   - 쓰기는 확인 입력 없이는 DB 를 바꾸지 않는다 · 맞으면 CLI 와 같은 결과(활성화 = active + 베타 자동 부여 · 감사 행위자 `admin:web:<운영자>`).
 *   - 요금제 쓰기는 결제 운영자 롤로 · `billing_audit` 한 행(원인 operator · 행위자 · 사유).
 *   - 킬스위치(조직 동결 · 에이전트 운영자 정지)가 DB 에 그대로 반영된다 · 거절은 에이전트 정지.
 *   - HTTP 끝에서 끝까지: 부트스트랩 → 쿠키 → 세션(CSRF) → 검토 대기열.
 */

import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classifyTarget } from '../../../scripts/admin/common';
import { handleApi, OPS, type ApiContext } from '../../../scripts/ops-web/api';
import type { WriteRecord } from '../../../scripts/ops-web/audit-log';
import { randomSecret } from '../../../scripts/ops-web/security';
import { startOpsServer } from '../../../scripts/ops-web/server';
import { createPool } from '../../../src/db/client';
import type { AgentId } from '../../../src/db/schema';
import { APP_URL, AVAILABLE, hex64, OWNER_URL, ownerPool, suffix, uniqueEmail } from '../signup/support';
import { recordTlogCapabilities } from '../db/support/harness';

function roleUrl(explicit: string | undefined, role: string): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  if (APP_URL.trim() === '') return '';
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}
const OPERATOR_URL = roleUrl(process.env['TEST_BILLING_OPERATOR_DATABASE_URL'], 'atmark_billing_operator');
const LOCAL = AVAILABLE && new URL(OWNER_URL).port !== '15432';
const ACTOR = 'admin:web:ops-web-test';

describe.skipIf(!LOCAL)('운영자 웹 화면(로컬 DB)', () => {
  let owner: Pool;
  let operator: Pool;
  let ctx: ApiContext;
  const records: WriteRecord[] = [];

  beforeAll(async () => {
    await recordTlogCapabilities();
    owner = ownerPool();
    operator = createPool(OPERATOR_URL, { max: 2 });
    ctx = {
      owner,
      operator,
      target: classifyTarget(OWNER_URL, {}),
      actor: ACTOR,
      audit: (record) => records.push(record),
      idleMinutes: 30,
      maxHours: 8,
      ops: OPS,
      now: () => new Date(),
    };
    expect(ctx.target.target).toBe('local');
  });
  afterAll(async () => {
    await Promise.all([owner.end(), operator.end()]);
  });

  async function signupOrg(): Promise<{ id: string; name: string; email: string; agent: string }> {
    const name = `운영 웹 ${suffix()}`;
    const email = uniqueEmail();
    const org = await owner.query<{ id: string }>(
      `INSERT INTO organizations (name, owner_email, review_status, signup_source) VALUES ($1, $2, 'pending_review', 'self_signup') RETURNING id`,
      [name, email],
    );
    const id = org.rows[0]?.id ?? '';
    const agent = hex64().slice(0, 32);
    await owner.query(
      `INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, $3, 'active', 'free', 1000)`,
      [agent, id, `agent-${suffix()}`],
    );
    return { id, name, email, agent };
  }

  const get = (path: string, query = '') => handleApi(ctx, 'GET', path, new URLSearchParams(query), undefined);
  const post = (path: string, body: unknown) => handleApi(ctx, 'POST', path, new URLSearchParams(), body);
  const orgRow = (id: string) =>
    owner
      .query<{ review_status: string; abuse_freeze: boolean }>('SELECT review_status::text, abuse_freeze FROM organizations WHERE id = $1', [id])
      .then((r) => r.rows[0]);
  const agentRow = (id: string) =>
    owner.query<{ status: string; suspended_by: string | null }>('SELECT status::text, suspended_by FROM agents WHERE id = $1', [id]).then((r) => r.rows[0]);

  it('읽기 — 검토 대기열 · 검색 · 상세', async () => {
    const org = await signupOrg();
    const queue = (await get('/api/review')).body as { items: { id: string; name: string; ownerEmail: string; agents: number; signupSource: string }[] };
    expect(queue.items.find((item) => item.id === org.id)).toMatchObject({ name: org.name, ownerEmail: org.email, agents: 1, signupSource: 'self_signup' });

    const list = (await get('/api/orgs', `q=${encodeURIComponent(org.name)}`)).body as { items: Record<string, unknown>[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: org.id, reviewStatus: 'pending_review', plan: { code: 'free', basis: 'missing' }, agents: { active: 1, total: 1 } });
    expect((await get('/api/orgs', `q=${encodeURIComponent(org.name)}&status=active`)).body).toMatchObject({ items: [] });

    const detail = (await get(`/api/orgs/${org.id}`)).body as Record<string, any>;
    expect(detail['organization']).toMatchObject({ id: org.id, name: org.name, reviewStatus: 'pending_review', abuseFreeze: false });
    expect(detail['agents']).toEqual([expect.objectContaining({ id: org.agent, status: 'active' })]);
    expect(detail['plan'].plan.code).toBe('free');
    expect(detail['billing']).toEqual({ subscriptions: [], betaLocked: false });
    expect(Array.isArray(detail['members'])).toBe(true);
    expect((await get('/api/orgs/00000000-0000-4000-8000-000000000000').catch((e: { status: number }) => e)).status).toBe(404);
    await OPS.reviewOrganization(owner, org.id, 'rejected', ACTOR);
  });

  it('승인 — 확인이 틀리면 그대로 · 맞으면 active(베타 부여 꺼짐 — 202609301520: 요금제 행 없음 = Free)', async () => {
    const org = await signupOrg();
    await expect(post(`/api/orgs/${org.id}/review`, { decision: 'activate', confirm: '다른 이름' })).rejects.toMatchObject({ code: 'confirmation_required' });
    expect((await orgRow(org.id))?.review_status).toBe('pending_review');

    const result = await post(`/api/orgs/${org.id}/review`, { decision: 'activate', confirm: org.name });
    expect(result.body).toMatchObject({ outcome: { from: 'pending_review', changed: true, plan: { granted: false, reason: 'disabled' } } });
    expect((await orgRow(org.id))?.review_status).toBe('active');
    const audit = await owner.query<{ cause: string; actor: string; to_plan: string }>(
      'SELECT cause, actor, to_plan FROM billing_audit WHERE organization_id = $1 ORDER BY entitlement_version',
      [org.id],
    );
    expect(audit.rows).toEqual([]);

    // 요금제 — 결제 운영자 롤로 · billing_audit 한 행.
    await expect(post(`/api/orgs/${org.id}/plan`, { plan: 'team', overrides: { max_agents: 20 }, note: '운영 웹 테스트' })).rejects.toMatchObject({
      code: 'confirmation_required',
    });
    const changed = await post(`/api/orgs/${org.id}/plan`, { plan: 'team', overrides: { max_agents: 20 }, note: '운영 웹 테스트', confirm: org.name });
    expect(changed.body).toMatchObject({ result: { changed: true, version: 1 } });
    const ent = await owner.query<{ plan_code: string; max_agents: number; source: string }>(
      'SELECT plan_code, max_agents, source FROM org_entitlements WHERE organization_id = $1',
      [org.id],
    );
    expect(ent.rows[0]).toEqual({ plan_code: 'team', max_agents: 20, source: 'operator' });
    const last = await owner.query<{ cause: string; actor: string; note: string }>(
      'SELECT cause, actor, note FROM billing_audit WHERE organization_id = $1 AND entitlement_version = 1',
      [org.id],
    );
    expect(last.rows[0]).toEqual({ cause: 'operator', actor: ACTOR, note: '운영 웹 테스트' });

    // 감사 로그 필터.
    const log = (await get('/api/audit', `org=${org.id}&source=billing`)).body as { items: { action: string; actor: string }[] };
    expect(log.items.map((item) => [item.action, item.actor])).toEqual([['operator', ACTOR]]);
    const owners = (await get('/api/audit', `org=${org.id}&source=owner`)).body as { items: unknown[] };
    expect(owners.items).toEqual([]);
  });

  it('킬스위치 — 조직 동결(id 앞 8자리 + CONFIRM) · 에이전트 운영자 정지·해제', async () => {
    const org = await signupOrg();
    await expect(post(`/api/orgs/${org.id}/freeze`, { on: true, confirm: org.name, ack: 'CONFIRM' })).rejects.toMatchObject({ code: 'confirmation_required' });
    expect((await orgRow(org.id))?.abuse_freeze).toBe(false);
    await post(`/api/orgs/${org.id}/freeze`, { on: true, confirm: org.id.slice(0, 8), ack: 'CONFIRM' });
    expect((await orgRow(org.id))?.abuse_freeze).toBe(true);
    // 해제는 사유 필수(적대 검토 M-2) — 없으면 쓰기 0.
    await expect(post(`/api/orgs/${org.id}/freeze`, { on: false, confirm: org.name })).rejects.toMatchObject({ code: 'reason_required' });
    expect((await orgRow(org.id))?.abuse_freeze).toBe(true);
    await post(`/api/orgs/${org.id}/freeze`, { on: false, confirm: org.name, reason: 'ops-web test' });
    expect((await orgRow(org.id))?.abuse_freeze).toBe(false);
    // 감사 — 운영자 웹 행위자 · 사유가 owner_actions 에(CLI 와 같은 함수).
    const audits = await owner.query<{ action: string; operator_actor: string; operator_reason: string }>(
      `SELECT action, operator_actor, operator_reason FROM owner_actions WHERE organization_id = $1 AND operator_actor IS NOT NULL ORDER BY created_at`,
      [org.id],
    );
    expect(audits.rows.map((r) => [r.action, r.operator_actor.split(':').slice(0, 2).join(':'), r.operator_reason])).toEqual([
      ['org.abuse_freeze', 'admin:web', 'operator kill-switch'],
      ['org.abuse_unfreeze', 'admin:web', 'ops-web test'],
    ]);

    await post(`/api/agents/${org.agent}/suspend`, { on: true, confirm: org.name });
    expect(await agentRow(org.agent)).toEqual({ status: 'suspended', suspended_by: 'operator' });
    await post(`/api/agents/${org.agent}/suspend`, { on: false, confirm: org.name });
    expect(await agentRow(org.agent)).toEqual({ status: 'active', suspended_by: null });
    await OPS.reviewOrganization(owner, org.id, 'rejected', ACTOR);
  });

  it('거절 — id 앞 8자리 + CONFIRM 없이는 그대로 · 있으면 rejected + 에이전트 운영자 정지 · 기록 3줄', async () => {
    const org = await signupOrg();
    await expect(post(`/api/orgs/${org.id}/review`, { decision: 'reject', confirm: org.id.slice(0, 8) })).rejects.toMatchObject({ code: 'confirmation_required' });
    await expect(post(`/api/orgs/${org.id}/review`, { decision: 'reject', confirm: org.name, ack: 'CONFIRM' })).rejects.toMatchObject({ code: 'confirmation_required' });
    expect((await orgRow(org.id))?.review_status).toBe('pending_review');
    const result = await post(`/api/orgs/${org.id}/review`, { decision: 'reject', confirm: org.id.slice(0, 8), ack: 'CONFIRM' });
    expect(records.filter((r) => r.target === org.id).map((r) => [r.action, r.result])).toEqual([
      ['review.reject', 'confirmation_required'],
      ['review.reject', 'confirmation_required'],
      ['review.reject', 'ok'],
    ]);
    expect(result.body).toMatchObject({ outcome: { changed: true, suspended: [org.agent] } });
    expect(await agentRow(org.agent)).toEqual({ status: 'suspended', suspended_by: 'operator' });
  });

  it('읽기 집계 — 대시보드(과거 고정 시각 창의 증분) · 최근 가입 · 요금제 · 긴급 정지', async () => {
    // 과거 한 시점을 "지금" 으로 — 다른 테스트가 그 창에 행을 넣지 않는다. 증분만 본다(다시 돌려도 같은 결과).
    const at = new Date(Date.UTC(1995 + Math.floor(Math.random() * 20), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 27), 12));
    const past = (hours: number) => new Date(at.getTime() - hours * 3600_000);
    const fixed: ApiContext = { ...ctx, now: () => at };
    const dash = async () => (await handleApi(fixed, 'GET', '/api/dashboard', new URLSearchParams(), undefined)).body as Record<string, any>;
    const before = await dash();

    const org = await signupOrg();
    await owner.query('UPDATE organizations SET created_at = $2 WHERE id = $1', [org.id, past(2)]);
    const older = await signupOrg();
    await owner.query('UPDATE organizations SET created_at = $2 WHERE id = $1', [older.id, past(24 * 3)]);
    const address = `ops-${suffix()}@example.com`;
    const hash = createHash('sha256').update(address).digest('hex');
    const outbound = async (status: 'sent' | 'denied' | 'failed' | 'pending', created: Date) => {
      const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'agent') RETURNING id`, [org.agent]);
      await owner.query(
        `INSERT INTO messages (agent_id, thread_id, direction, from_address_hash, from_domain, status, message_id_header, idempotency_key, request_hash,
                               recipient_count, created_at, ses_message_id, sent_at, failure_reason, failed_at)
         VALUES ($1, $2, 'outbound', $3, 'example.com', $4::message_status, $5, $6, $7, 1, $8,
                 CASE WHEN $4 = 'sent' THEN $9 END, CASE WHEN $4 = 'sent' THEN $8::timestamptz END,
                 CASE WHEN $4 = 'failed' THEN 'ses_rejected' END, CASE WHEN $4 = 'failed' THEN $8::timestamptz END)`,
        [org.agent, thread.rows[0]?.id, hash, status, `<${randomUUID()}@atmark.test>`, `idem-${randomUUID()}`, createHash('sha256').update(randomUUID()).digest('hex'), created, `ses-${randomUUID()}`],
      );
    };
    await outbound('sent', past(1));
    await outbound('denied', past(3));
    await outbound('pending', past(5));
    await outbound('failed', past(24 * 2));
    await outbound('sent', past(24 * 8)); // 7일 밖
    await owner.query(
      `INSERT INTO messages (agent_id, direction, from_address_hash, from_domain, status, message_id_header, created_at)
       VALUES ($1, 'inbound', $2, 'example.com', 'received', $3, $4)`,
      [org.agent, hash, `<${randomUUID()}@example.com>`, past(24 * 4)],
    );

    const after = await dash();
    const delta = (path: (d: Record<string, any>) => number) => path(after) - path(before);
    expect(delta((d) => d['signups'].day)).toBe(1);
    expect(delta((d) => d['signups'].week)).toBe(2);
    expect({
      day: Object.fromEntries(['sent', 'denied', 'failed', 'queued', 'received'].map((k) => [k, delta((d) => d['sending'].day[k])])),
      week: Object.fromEntries(['sent', 'denied', 'failed', 'queued', 'received'].map((k) => [k, delta((d) => d['sending'].week[k])])),
    }).toEqual({ day: { sent: 1, denied: 1, failed: 0, queued: 1, received: 0 }, week: { sent: 1, denied: 1, failed: 1, queued: 1, received: 1 } });
    expect(after['organizations'].pendingReview).toBeGreaterThanOrEqual(2);
    expect(after['agents'].active).toBeGreaterThanOrEqual(2);

    // 최근 가입(지금 시각 기준) — 방금 만든 조직이 검토 대기로 보인다.
    const fresh = await signupOrg();
    const now = (await get('/api/dashboard')).body as { recentSignups: { id: string; reviewStatus: string; ownerEmail: string; agents: number }[] };
    expect(now.recentSignups.find((r) => r.id === fresh.id)).toMatchObject({ reviewStatus: 'pending_review', ownerEmail: fresh.email, agents: 1 });

    // 요금제 — 승인은 요금제를 주지 않는다(베타 부여 꺼짐 — 202609301520). 운영자가 정한 행만 목록에 · 분포에.
    await OPS.reviewOrganization(owner, fresh.id, 'active', ACTOR);
    const unplanned = (await get('/api/plans')).body as { items: Record<string, unknown>[] };
    expect(unplanned.items.find((i) => i['id'] === fresh.id)).toBeUndefined();
    await OPS.setOrgPlan(operator, { organizationId: fresh.id, plan: 'pro', overrides: {}, graceUntil: undefined, actor: ACTOR, note: null });
    const plans = (await get('/api/plans')).body as { counts: { plan: string; organizations: number }[]; items: Record<string, unknown>[] };
    expect(plans.counts.map((c) => c.plan)).toEqual(['free', 'beta', 'pro', 'team', 'scale', 'none']);
    expect(plans.counts.find((c) => c.plan === 'pro')?.organizations).toBeGreaterThanOrEqual(1);
    expect(plans.items.find((i) => i['id'] === fresh.id)).toMatchObject({ plan: 'pro', rowCode: 'pro', source: 'operator', cause: 'operator', version: 1, releasedToProvider: false });

    // 긴급 정지 — 동결 조직 · 운영자 정지 에이전트가 보이고, 풀면 사라진다.
    await OPS.setOrganizationFreeze(owner, { organizationId: fresh.id, on: true, actor: ACTOR, reason: null });
    await OPS.setAgentSuspended(owner, fresh.agent as AgentId, true, 'operator');
    const kill = (await get('/api/killswitch')).body as { frozenOrganizations: { id: string }[]; suspendedAgents: { id: string; organizationId: string }[] };
    expect(kill.frozenOrganizations.some((o) => o.id === fresh.id)).toBe(true);
    expect(kill.suspendedAgents.find((a) => a.id === fresh.agent)).toMatchObject({ organizationId: fresh.id });
    await OPS.setOrganizationFreeze(owner, { organizationId: fresh.id, on: false, actor: ACTOR, reason: 'ops-web test' });
    await OPS.setAgentSuspended(owner, fresh.agent as AgentId, false, 'operator');
    const cleared = (await get('/api/killswitch')).body as { frozenOrganizations: { id: string }[]; suspendedAgents: { id: string }[] };
    expect(cleared.frozenOrganizations.some((o) => o.id === fresh.id)).toBe(false);
    expect(cleared.suspendedAgents.some((a) => a.id === fresh.agent)).toBe(false);

    // 읽기는 쓰기 기록을 남기지 않는다.
    expect(records.filter((r) => [org.id, older.id, fresh.id].includes(r.target))).toEqual([]);
    await OPS.reviewOrganization(owner, org.id, 'rejected', ACTOR);
    await OPS.reviewOrganization(owner, older.id, 'rejected', ACTOR);
  });

  it('HTTP 끝에서 끝까지 — 부트스트랩 → 쿠키 → 세션 → 검토 대기열', async () => {
    const org = await signupOrg();
    const bootstrap = randomSecret();
    const token = randomSecret();
    const server = await startOpsServer({
      port: 0,
      sessionToken: token,
      bootstrap,
      bootstrapTtlMs: 60_000,
      context: { ...ctx, operator: null },
    });
    try {
      const call = (path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, unknown>; body: string }> =>
        new Promise((resolve, reject) => {
          const req = request({ host: '127.0.0.1', port: server.port, path, headers: { host: `127.0.0.1:${String(server.port)}`, ...headers } }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
          });
          req.on('error', reject);
          req.end();
        });
      const boot = await call(`/bootstrap?k=${bootstrap}`, {});
      expect(boot.status).toBe(303);
      expect(boot.headers['set-cookie']).toBeUndefined();
      const location = String(boot.headers['location']);
      expect(location).toBe(`/#t=${token}`);
      const handed = location.slice('/#t='.length);
      expect((await call('/api/session', { 'x-ops-token': handed })).status).toBe(200);
      const queue = await call('/api/review', { 'x-ops-token': handed });
      expect(queue.status).toBe(200);
      expect((JSON.parse(queue.body) as { items: { id: string }[] }).items.some((item) => item.id === org.id)).toBe(true);
      expect((await call('/api/review', { cookie: `session=${handed}` })).status).toBe(401);
      for (const path of ['/api/dashboard', '/api/plans', '/api/killswitch']) {
        expect((await call(path, {})).status, path).toBe(401);
        expect((await call(path, { 'x-ops-token': handed })).status, path).toBe(200);
      }
    } finally {
      await server.close();
    }
    // 이 조직은 대기열에 남기지 않는다(가입 상한 — 전역 정리와 같은 이유).
    await OPS.reviewOrganization(owner, org.id, 'rejected', ACTOR);
  });
});
