/**
 * 과금 P0 — 요금제 적용 지점(ADR-0011 B4) · 운영자 CLI(`pnpm admin:plan`) · 콘솔 `GET /api/plan` — 실제 Postgres · 실제 롤.
 *
 * 되돌림 방지: 각 적용 지점에서 요금제 조회(`loadEntitlements`)나 `min()` 을 지우면 아래 단언 하나가 빨개진다 —
 * 행이 없는 조직(= Free)에서 Free 한도 바로 위가 409 여야 한다.
 *
 *   ① 행 없음 = Free: 에이전트 3(비활성 제외) → 4번째 409 agent_limit · 토큰 2 → 3번째 409 token_limit · 조직 키 1 → 2번째 409 org_key_limit ·
 *      per_minute 6 → 409 plan_per_minute_limit(5 는 된다).
 *   ② 비활성은 요금제 한도에서 빠지고, 비활성 포함 총합은 요금제 × 3 에서 409 agent_total_limit.
 *   ③ CLI: 행 없음 → pro(v1) → team(v2) · 같은 값이면 쓰지 않는다 · 감사 행(행위자·사유) · 천장 넘는 덮어쓰기 거부 · 행위 뒤 적용 지점이 새 한도를 본다.
 *   ④ 강등: 이미 가진 것은 지우지 않고 `overLimit` 으로 보인다 · /api/me 요약 · 유예 끝 → Free.
 *   ⑤ CLI 는 결제 운영자 롤(`DATABASE_BILLING_OPERATOR_URL`)로만 — 소유자 URL 만 있으면 입력 오류, 그 변수에 소유자 URL 을 넣어도 거부(폴백 없음).
 *   ⑥ `--release-to-provider`(같은 요금제·한도 · 표시 true · v+1 · note) · `--list-sandbox-provider` · `--revert-sandbox-provider`(목록의 조직만 ·
 *      operator 행 v+1 · note `sandbox_revert`).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { randomBytes } from 'node:crypto';

import type { AdminIo } from '../../../scripts/admin/common';
import { parseOverrides, plan, setOrgPlanOp } from '../../../scripts/admin/plan';
import { DatabaseConfigError, createPool, withTransaction } from '../../../src/db/client';
import { bindSubscription, insertCheckout } from '../../../src/db/repositories/billing';
import { writeEntitlementVersion } from '../../../src/db/repositories/entitlements-write';
import { AdminInputError } from '../../../src/admin/ops/errors';
import { PLAN_CATALOG } from '../../../src/billing/plans';
import {
  adminDeps,
  adminRolePool,
  authed,
  AVAILABLE,
  call,
  login,
  loginMailerPool,
  APP_URL,
  newOrganization,
  OWNER_URL,
  ownerPool,
  suffix,
  userIdOf,
  type Session,
} from './support';

const keyDir = mkdtempSync(resolve(tmpdir(), 'atmark-plan-keys-'));
/** 결제 운영자 롤 URL — 앱 URL 의 사용자만 바꾼다(로컬 trust). `TEST_BILLING_OPERATOR_DATABASE_URL` 이 있으면 그것. */
function roleUrl(explicit: string | undefined, role: string): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  if (APP_URL.trim() === '') return '';
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}
const OPERATOR_URL = roleUrl(process.env['TEST_BILLING_OPERATOR_DATABASE_URL'], 'atmark_billing_operator');
const BILLING_URL = roleUrl(process.env['TEST_BILLING_DATABASE_URL'], 'atmark_billing');
const cliEnv = (): NodeJS.ProcessEnv => ({ DATABASE_BILLING_OPERATOR_URL: OPERATOR_URL, ATMARK_DEV_KEY_DIR: keyDir, USER: 'plan-test' });
const id26 = (): string => randomBytes(13).toString('hex');
function cliIo(lines: string[] = []): AdminIo {
  return { out: (line) => lines.push(line), err: () => undefined, interactive: false, ask: async () => '' };
}

describe.skipIf(!AVAILABLE)('요금제 적용 지점 · admin:plan · /api/plan', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), mailer.end()]);
  });

  /** 콘솔은 admin 롤로 돈다(운영 admin Lambda 와 같은 롤) — 적용 지점이 그 롤로 요금제를 읽을 수 있어야 한다. */
  async function consoleOrg(planCode: Parameters<typeof newOrganization>[1]): Promise<{ id: string; session: Session }> {
    const org = await newOrganization(owner, planCode);
    return { id: org.id, session: await login(adminDeps(admin), mailer, org) };
  }

  async function createAgent(session: Session): Promise<{ status: number; json: unknown }> {
    const created = await call(adminDeps(admin), 'POST', '/api/agents', authed(session, { body: { name: 'plan', localPart: `plan-${suffix()}` } }));
    return { status: created.statusCode, json: created.json() };
  }

  async function agentId(session: Session): Promise<string> {
    const created = await createAgent(session);
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return (created.json as { agent: { id: string } }).agent.id;
  }

  it('① 행 없음 = Free — 에이전트 · 토큰 · 조직 키 · per_minute 가 Free 한도 바로 위에서 409', async () => {
    const { session } = await consoleOrg(null);
    const deps = adminDeps(admin);
    const first = await agentId(session);
    for (let i = 1; i < PLAN_CATALOG.free.maxAgents; i += 1) await agentId(session);
    expect(await createAgent(session)).toMatchObject({ status: 409, json: { error: 'agent_limit' } });
    // 토큰 — 프로비저닝 토큰 1 + 1 = Free 2, 3번째 409.
    const token = await call(deps, 'POST', `/api/agents/${first}/tokens`, authed(session, { body: { label: 'second' } }));
    expect(token.statusCode, token.body).toBe(201);
    const third = await call(deps, 'POST', `/api/agents/${first}/tokens`, authed(session, { body: { label: 'third' } }));
    expect([third.statusCode, (third.json() as { error: string }).error]).toEqual([409, 'token_limit']);
    const listed = (await call(deps, 'GET', `/api/agents/${first}/tokens`, authed(session))).json() as { maxActive: number };
    expect(listed.maxActive).toBe(PLAN_CATALOG.free.tokensPerAgentMax);
    // 조직 키 — Free 1.
    const key = { label: 'ci', capabilities: ['agents:read'] };
    expect((await call(deps, 'POST', '/api/org-keys', authed(session, { body: key }))).statusCode).toBe(201);
    const second = await call(deps, 'POST', '/api/org-keys', authed(session, { body: { ...key, label: 'ci2' } }));
    expect([second.statusCode, (second.json() as { error: string }).error]).toEqual([409, 'org_key_limit']);
    // per_minute — Free 5. 넘으면 409, 5 는 된다.
    const over = await call(deps, 'PATCH', `/api/agents/${first}/policy`, authed(session, { body: { limits: { perMinute: 6 } } }));
    expect([over.statusCode, (over.json() as { error: string }).error]).toEqual([409, 'plan_per_minute_limit']);
    expect((await call(deps, 'PATCH', `/api/agents/${first}/policy`, authed(session, { body: { limits: { perMinute: 5 } } }))).statusCode).toBe(200);
  });

  it('② 비활성은 요금제 한도에서 빠진다 · 비활성 포함 총합은 요금제 × 3 에서 409 agent_total_limit', async () => {
    const org = await consoleOrg(null);
    await setOrgPlanOp(owner, { organizationId: org.id, plan: 'free', overrides: { max_agents: 1 }, graceUntil: undefined, actor: 'test', note: null });
    const disable = (id: string) => owner.query(`UPDATE agents SET status = 'disabled' WHERE id = $1`, [id]);
    await disable(await agentId(org.session));
    await disable(await agentId(org.session));
    await agentId(org.session); // 비활성 둘 + 살아 있는 하나 = 총합 3 = 1 × 3
    expect(await createAgent(org.session)).toMatchObject({ status: 409, json: { error: 'agent_limit' } });
    const [live] = (await owner.query<{ id: string }>(`SELECT id FROM agents WHERE organization_id = $1 AND status <> 'disabled'`, [org.id])).rows;
    await disable(live?.id ?? '');
    expect(await createAgent(org.session)).toMatchObject({ status: 409, json: { error: 'agent_total_limit' } });
  });

  it('③ CLI — 행 없음 → pro(v1) → team(v2) · 같은 값이면 쓰지 않는다 · 감사 행 · 천장 넘는 덮어쓰기 거부 · 적용 지점이 새 한도를 본다', async () => {
    const org = await consoleOrg(null);
    const lines: string[] = [];
    expect(await plan(['--org', org.id, '--plan', 'pro', '--note', '베타 테스터', '--by', 'jin', '--yes'], { env: cliEnv(), io: cliIo(lines) })).toBe(0);
    expect(lines[0]).toBe(`organization ${org.id} plan=pro version=1 changed=true`);
    expect(await plan(['--org', org.id, '--plan', 'pro', '--yes'], { env: cliEnv(), io: cliIo() })).toBe(0);
    expect(
      await setOrgPlanOp(owner, { organizationId: org.id, plan: 'team', overrides: { max_agents: 20 }, graceUntil: undefined, actor: 'admin:plan:jin', note: null }),
    ).toEqual({ changed: true, fromPlan: 'pro', version: 2 });
    const audit = await owner.query(
      `SELECT from_plan, to_plan, cause, actor, note, entitlement_version::int AS v FROM billing_audit WHERE organization_id = $1 ORDER BY entitlement_version`,
      [org.id],
    );
    expect(audit.rows).toEqual([
      { from_plan: null, to_plan: 'pro', cause: 'operator', actor: 'admin:plan:jin', note: '베타 테스터', v: 1 },
      { from_plan: 'pro', to_plan: 'team', cause: 'operator', actor: 'admin:plan:jin', note: null, v: 2 },
    ]);
    const row = await owner.query('SELECT plan_code, source, cause, max_agents, version::int AS version FROM org_entitlements WHERE organization_id = $1', [org.id]);
    expect(row.rows).toEqual([{ plan_code: 'team', source: 'operator', cause: 'operator', max_agents: 20, version: 2 }]);
    expect(() => parseOverrides(['recipients_per_message_max=51'])).toThrow(AdminInputError);
    expect(() => parseOverrides(['price_cents=100'])).toThrow(AdminInputError);
    // 적용 지점이 새 행을 본다 — /api/plan 과 /api/me 요약.
    const view = (await call(adminDeps(admin), 'GET', '/api/plan', authed(org.session))).json() as {
      plan: { code: string; basis: string; version: number };
      limits: { maxAgents: number; agentsTotalMax: number; tokensPerAgentMax: number };
      upgradeAvailable: boolean;
    };
    expect(view).toMatchObject({ plan: { code: 'team', basis: 'row', version: 2 }, limits: { maxAgents: 20, agentsTotalMax: 60, tokensPerAgentMax: 5 }, upgradeAvailable: false });
    const me = (await call(adminDeps(admin), 'GET', '/api/me', authed(org.session))).json() as { plan: unknown };
    expect(me.plan).toEqual({ code: 'team', basis: 'row', maxAgents: 20, overLimit: [] });
  });

  it('④ 강등 — 이미 가진 것은 지우지 않고 overLimit 으로 보인다 · 유예가 끝나면 Free', async () => {
    const org = await consoleOrg('beta');
    for (let i = 0; i < 4; i += 1) await agentId(org.session);
    await setOrgPlanOp(owner, { organizationId: org.id, plan: 'free', overrides: {}, graceUntil: undefined, actor: 'test', note: null });
    const view = (await call(adminDeps(admin), 'GET', '/api/plan', authed(org.session))).json() as { usage: { agents: number }; overLimit: string[] };
    expect(view.usage.agents).toBe(4);
    expect(view.overLimit).toContain('agents');
    expect((await owner.query(`SELECT count(*)::int AS n FROM agents WHERE organization_id = $1 AND status = 'active'`, [org.id])).rows[0]).toEqual({ n: 4 });
    // 유예가 끝난 team 행 → 로더·콘솔은 Free 로 읽는다(동기화가 늦어도 강등은 제시각).
    await setOrgPlanOp(owner, { organizationId: org.id, plan: 'team', overrides: {}, graceUntil: new Date(Date.now() - 1000), actor: 'test', note: null });
    const expired = (await call(adminDeps(admin), 'GET', '/api/plan', authed(org.session))).json() as { plan: { code: string; basis: string; rowCode: string } };
    expect(expired.plan).toMatchObject({ code: 'free', basis: 'grace_expired', rowCode: 'team' });
    expect(await createAgent(org.session)).toMatchObject({ status: 409, json: { error: 'agent_limit' } });
  });

  it('⑤ CLI 는 결제 운영자 롤로만 — 소유자 URL 만 있으면 입력 오류 · 그 변수에 소유자 URL 을 넣어도 거부', async () => {
    const org = await newOrganization(owner, null);
    await expect(plan(['--org', org.id], { env: { DATABASE_MIGRATION_URL: OWNER_URL }, io: cliIo() })).rejects.toThrow(DatabaseConfigError);
    await expect(plan(['--org', org.id, '--plan', 'pro', '--yes'], { env: { DATABASE_BILLING_OPERATOR_URL: OWNER_URL }, io: cliIo() })).rejects.toThrow(
      /atmark_billing_operator/,
    );
    expect((await owner.query('SELECT count(*)::int AS n FROM org_entitlements WHERE organization_id = $1', [org.id])).rows).toEqual([{ n: 0 }]);
    // 운영자 롤로 보기 — planUsageOp 의 칸이 그 롤의 GRANT 안에 있다.
    const lines: string[] = [];
    expect(await plan(['--org', org.id], { env: cliEnv(), io: cliIo(lines) })).toBe(0);
    expect(lines[0]).toMatch(/^plan free \(basis=missing/);
  });

  it('⑥ --release-to-provider · --list-sandbox-provider · --revert-sandbox-provider', async () => {
    // 넘기기 — 같은 요금제·한도 · 표시 true · v+1 · 감사 note. 두 번째는 바꾸지 않는다.
    const kept = await newOrganization(owner, null);
    expect(await plan(['--org', kept.id, '--plan', 'beta', '--yes'], { env: cliEnv(), io: cliIo() })).toBe(0);
    const released: string[] = [];
    expect(await plan(['--org', kept.id, '--release-to-provider', '--by', 'jin', '--yes'], { env: cliEnv(), io: cliIo(released) })).toBe(0);
    expect(released[0]).toBe(`organization ${kept.id} released_to_provider version=2 changed=true`);
    expect(await plan(['--org', kept.id, '--release-to-provider', '--yes'], { env: cliEnv(), io: cliIo() })).toBe(0);
    const row = await owner.query('SELECT plan_code, source, provider_override_allowed, version::int AS v FROM org_entitlements WHERE organization_id = $1', [kept.id]);
    expect(row.rows).toEqual([{ plan_code: 'beta', source: 'operator', provider_override_allowed: true, v: 2 }]);
    const audit = await owner.query('SELECT from_plan, to_plan, note FROM billing_audit WHERE organization_id = $1 AND entitlement_version = 2', [kept.id]);
    expect(audit.rows).toEqual([{ from_plan: 'beta', to_plan: 'beta', note: 'release_to_provider' }]);
    // --plan 을 다시 주면 넘김이 풀린다.
    await plan(['--org', kept.id, '--plan', 'beta', '--yes'], { env: cliEnv(), io: cliIo() });
    expect((await owner.query('SELECT provider_override_allowed FROM org_entitlements WHERE organization_id = $1', [kept.id])).rows).toEqual([
      { provider_override_allowed: false },
    ]);
    // 행이 없으면 넘길 것이 없다.
    await expect(plan(['--org', (await newOrganization(owner, null)).id, '--release-to-provider', '--yes'], { env: cliEnv(), io: cliIo() })).rejects.toThrow(/넘길/);

    // 샌드박스 결제로 올라간 provider 행 하나를 만든다(admin 이 거래 기록 → billing 이 결속·요금제 쓰기).
    const sandbox = await newOrganization(owner, null);
    const admin = adminRolePool();
    const billing = createPool(BILLING_URL, { max: 1 });
    try {
      const transactionId = `txn_${id26()}`;
      await insertCheckout(admin, {
        organizationId: sandbox.id,
        provider: 'paddle',
        environment: 'sandbox',
        transactionId,
        plan: 'pro',
        createdByUserId: await userIdOf(owner, sandbox.ownerEmail),
      });
      await withTransaction(billing, async (client) => {
        await bindSubscription(
          client,
          {
            provider: 'paddle',
            providerSubscriptionId: `sub_${id26()}`,
            environment: 'sandbox',
            providerCustomerId: `ctm_${id26()}`,
            status: 'active',
            planCode: 'pro',
            priceId: `pri_${id26()}`,
            currentPeriodEnd: null,
            scheduledChangeAction: null,
            scheduledChangeAt: null,
            pastDueSince: null,
            providerUpdatedAt: new Date(),
          },
          sandbox.id,
          transactionId,
        );
        await writeEntitlementVersion(client, {
          organizationId: sandbox.id,
          plan: 'pro',
          limits: PLAN_CATALOG.pro,
          graceUntil: null,
          source: 'provider',
          cause: 'provider_event',
          providerOverrideAllowed: false,
          actor: 'provider:paddle',
          providerEventId: `evt_${id26()}`,
          note: null,
        });
      });
    } finally {
      await Promise.all([admin.end(), billing.end()]);
    }
    const listed: string[] = [];
    expect(await plan(['--list-sandbox-provider'], { env: cliEnv(), io: cliIo(listed) })).toBe(0);
    expect(listed).toContain(`${sandbox.id}\tpro`);
    expect(listed).not.toContain(`${kept.id}\tbeta`);
    // 목록 밖 조직 · --by 없음 · free|beta 밖 요금제는 거부.
    await expect(plan(['--org', kept.id, '--revert-sandbox-provider', '--plan', 'free', '--by', 'jin', '--yes'], { env: cliEnv(), io: cliIo() })).rejects.toThrow(
      /샌드박스/,
    );
    await expect(plan(['--org', sandbox.id, '--revert-sandbox-provider', '--plan', 'free', '--yes'], { env: cliEnv(), io: cliIo() })).rejects.toThrow(/--by/);
    await expect(plan(['--org', sandbox.id, '--revert-sandbox-provider', '--plan', 'pro', '--by', 'jin', '--yes'], { env: cliEnv(), io: cliIo() })).rejects.toThrow(
      /free\|beta/,
    );
    const reverted: string[] = [];
    expect(await plan(['--org', sandbox.id, '--revert-sandbox-provider', '--plan', 'beta', '--by', 'jin', '--yes'], { env: cliEnv(), io: cliIo(reverted) })).toBe(0);
    expect(reverted[0]).toBe(`organization ${sandbox.id} plan=beta version=2 changed=true note=sandbox_revert`);
    const after = await owner.query(
      `SELECT e.plan_code, e.source, e.cause, a.actor, a.note FROM org_entitlements e
         JOIN billing_audit a ON a.organization_id = e.organization_id AND a.entitlement_version = e.version
        WHERE e.organization_id = $1`,
      [sandbox.id],
    );
    expect(after.rows).toEqual([{ plan_code: 'beta', source: 'operator', cause: 'operator', actor: 'admin:plan:jin', note: 'sandbox_revert' }]);
    const again: string[] = [];
    await plan(['--list-sandbox-provider'], { env: cliEnv(), io: cliIo(again) });
    expect(again).not.toContain(`${sandbox.id}\tpro`);
  });
});
