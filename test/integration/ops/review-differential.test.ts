/**
 * **차분 테스트(M3)** — 동결한 v0 TS 구현(`test/support/legacy/review-organization-v0.ts`, ops-pre-p1 = 314aded)과 SQL 코어
 * (`ops_org_activate_core` · `ops_org_reject_core` — 새 `reviewOrganizationOp` 가 부른다)를 **같은 픽스처 한 쌍**에서 돌려 결과 DB 를 대조한다.
 *
 * 대조: 반환값(`ReviewOutcome`, 에이전트 id 는 역할 이름으로) · 조직 검토 칸 · 에이전트 상태·주체 · 토큰 폐기 여부 · `org_entitlements`(시각 제외) ·
 * `billing_audit`(id·시각·조직 제외) · 투명성 outbox 의 종류와 수(요금제 · 에이전트).
 *
 * 픽스처(계획 §4 P1 목록): pending→active(행 없음) · pending→active(free/default 행) · active→active(변화 없음) · rejected→active(operator 행 유지) ·
 * active→active 재실행(버전 그대로) · pending→active(provider 행 유지) · 스위치 끔 → activate · pending→rejected(에이전트 다섯 · 토큰 살아 있음/폐기됨) ·
 * rejected→rejected(변화 없음) · 없는 조직 → organization_not_found.
 */

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AdminInputError } from '../../../src/admin/ops/errors';
import { BETA_ON_ACTIVATION, PLAN_CATALOG } from '../../../src/billing/plans';
import { withTransaction } from '../../../src/db/client';
import { writeEntitlementVersion } from '../../../src/db/repositories/entitlements-write';
import { activationGrantOf, reviewOrganizationOp } from '../../../src/ops/core/review';
import { setOrgPlanOp } from '../../../src/ops/core/plan';
import { grantPlan } from '../../support/entitlements';
import { reviewOrganizationOpV0 } from '../../support/legacy/review-organization-v0';
import { AVAILABLE, hex64, lockOpsTestXact, ownerPool, suffix } from './db-support';

type Target = 'active' | 'rejected';
type Setup = (owner: Pool, org: string) => Promise<void>;

interface Fixture {
  readonly id: string;
  readonly agents: Readonly<Record<string, string>>;
  readonly tokens: Readonly<Record<string, string>>;
}

const ACTOR = 'admin:org-review:differential';

async function makeFixture(owner: Pool, status: 'pending_review' | 'active' | 'rejected'): Promise<Fixture> {
  const org = await owner.query<{ id: string }>(
    `INSERT INTO organizations (name, owner_email, review_status, signup_source) VALUES ($1, $2, 'pending_review', 'self_signup') RETURNING id`,
    [`차분 ${suffix()}`, `ops-db-diff-${suffix()}@example.com`],
  );
  const id = org.rows[0]?.id ?? '';
  if (status !== 'pending_review') await owner.query('UPDATE organizations SET review_status = $2, reviewed_at = now() WHERE id = $1', [id, status]);
  const agents: Record<string, string> = {};
  for (const [key, agentStatus, by] of [
    ['active', 'active', null],
    ['ownerSuspended', 'suspended', 'owner'],
    ['operatorSuspended', 'suspended', 'operator'],
    ['provisioning', 'provisioning', null],
    ['disabled', 'disabled', null],
  ] as const) {
    const agentId = hex64().slice(0, 32);
    await owner.query(
      `INSERT INTO agents (id, organization_id, name, status, suspended_by, plan, monthly_budget_cents) VALUES ($1, $2, $3, $4, $5, 'free', 1000)`,
      [agentId, id, `agent-${suffix()}`, agentStatus, by],
    );
    agents[key] = agentId;
  }
  const tokens: Record<string, string> = {};
  for (const [key, agent, revoked] of [
    ['activeLive', 'active', null],
    ['activeRevoked', 'active', new Date('2026-09-01T00:00:00.000Z')],
    ['ownerSuspendedLive', 'ownerSuspended', null],
    ['provisioningLive', 'provisioning', null],
  ] as const) {
    const row = await owner.query<{ id: string }>(
      `INSERT INTO agent_api_keys (agent_id, token_hash, capabilities, revoked_at) VALUES ($1, $2, ARRAY['messages:send']::agent_token_capability[], $3) RETURNING id`,
      [agents[agent], hex64(), revoked],
    );
    tokens[key] = row.rows[0]?.id ?? '';
  }
  return { id, agents, tokens };
}

/** 결과 DB 스냅샷 — 픽스처 안의 id 는 역할 이름으로 바꾼다(두 픽스처를 맞댈 수 있게). */
async function snapshot(db: Pool | PoolClient, fixture: Fixture): Promise<unknown> {
  const rename = new Map<string, string>([...Object.entries(fixture.agents).map(([key, id]) => [id, `agent:${key}`] as const)]);
  const org = (
    await db.query<{ review_status: string; reviewed: boolean }>('SELECT review_status::text, reviewed_at IS NOT NULL AS reviewed FROM organizations WHERE id = $1', [fixture.id])
  ).rows[0];
  const agents = (
    await db.query<{ id: string; status: string; suspended_by: string | null }>(
      'SELECT id, status::text, suspended_by FROM agents WHERE organization_id = $1 ORDER BY id',
      [fixture.id],
    )
  ).rows.map((row) => ({ agent: rename.get(row.id), status: row.status, suspendedBy: row.suspended_by }));
  agents.sort((a, b) => String(a.agent).localeCompare(String(b.agent)));
  // 한 연결(트랜잭션 안의 client 포함)에 차례로 — 동시에 보내지 않는다.
  const tokens: Record<string, unknown> = {};
  for (const [key, id] of Object.entries(fixture.tokens)) {
    tokens[key] = (
      await db.query<{ revoked: boolean; old: boolean }>(
        `SELECT revoked_at IS NOT NULL AS revoked, revoked_at = '2026-09-01T00:00:00.000Z'::timestamptz AS old FROM agent_api_keys WHERE id = $1`,
        [id],
      )
    ).rows[0];
  }
  const entitlement = (
    await db.query('SELECT to_jsonb(e) - ARRAY[\'organization_id\', \'created_at\', \'updated_at\'] AS row FROM org_entitlements e WHERE organization_id = $1', [fixture.id])
  ).rows[0] ?? null;
  const audit = (
    await db.query('SELECT from_plan, to_plan, cause, actor, provider_event_id, note, entitlement_version::text FROM billing_audit WHERE organization_id = $1 ORDER BY entitlement_version', [
      fixture.id,
    ])
  ).rows;
  const outbox = (
    await db.query<{ source_table: string; event: string; n: number }>(
      `SELECT source_table, event, count(*)::int AS n FROM tlog_outbox
        WHERE (source_table = 'org_entitlements' AND source_id = $1) OR (source_table = 'agents' AND source_id = ANY ($2::text[]))
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [fixture.id, Object.values(fixture.agents)],
    )
  ).rows;
  return { org, agents, tokens, entitlement, audit, outbox };
}

function renameOutcome(outcome: { readonly suspended: readonly string[] }, fixture: Fixture): unknown {
  const rename = new Map(Object.entries(fixture.agents).map(([key, id]) => [id, key] as const));
  return { ...outcome, suspended: outcome.suspended.map((id) => rename.get(id) ?? id).sort() };
}

describe.skipIf(!AVAILABLE)('차분(M3) — 동결 v0 TS ↔ SQL 코어', () => {
  let owner: Pool;
  beforeAll(() => {
    owner = ownerPool(4);
  });
  afterAll(async () => {
    await owner.end();
  });

  const providerRow: Setup = async (pool, org) => {
    await withTransaction(pool, (client) =>
      writeEntitlementVersion(client, {
        organizationId: org,
        plan: 'pro',
        limits: PLAN_CATALOG.pro,
        graceUntil: null,
        source: 'provider',
        cause: 'provider_event',
        providerOverrideAllowed: false,
        actor: 'provider:paddle',
        providerEventId: null,
        note: null,
      }),
    );
  };
  const operatorRow: Setup = async (pool, org) => {
    await setOrgPlanOp(pool, { organizationId: org, plan: 'pro', overrides: {}, graceUntil: undefined, actor: 'admin:plan:diff', note: null });
  };
  const freeDefault: Setup = async (pool, org) => {
    await grantPlan(pool, org, 'free');
  };

  const cases: readonly { readonly name: string; readonly from: 'pending_review' | 'active' | 'rejected'; readonly target: Target; readonly setup?: Setup; readonly twice?: boolean }[] = [
    { name: 'pending → active (행 없음)', from: 'pending_review', target: 'active' },
    { name: 'pending → active (free/default 행)', from: 'pending_review', target: 'active', setup: freeDefault },
    { name: 'active → active (변화 없음)', from: 'active', target: 'active' },
    { name: 'rejected → active (operator 행 유지)', from: 'rejected', target: 'active', setup: operatorRow },
    { name: 'active → active 재실행 (버전이 늘지 않음)', from: 'pending_review', target: 'active', twice: true },
    { name: 'pending → active (provider 행 유지)', from: 'pending_review', target: 'active', setup: providerRow },
    { name: 'pending → rejected (에이전트 다섯 · 토큰 살아 있음/폐기됨)', from: 'pending_review', target: 'rejected' },
    { name: 'rejected → rejected (변화 없음)', from: 'rejected', target: 'rejected' },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const legacy = await makeFixture(owner, testCase.from);
      const current = await makeFixture(owner, testCase.from);
      if (testCase.setup !== undefined) {
        await testCase.setup(owner, legacy.id);
        await testCase.setup(owner, current.id);
      }
      let legacyOutcome = await reviewOrganizationOpV0(owner, legacy.id, testCase.target, ACTOR, BETA_ON_ACTIVATION);
      let currentOutcome = await reviewOrganizationOp(owner, current.id, testCase.target, ACTOR);
      if (testCase.twice === true) {
        legacyOutcome = await reviewOrganizationOpV0(owner, legacy.id, testCase.target, ACTOR, BETA_ON_ACTIVATION);
        currentOutcome = await reviewOrganizationOp(owner, current.id, testCase.target, ACTOR);
      }
      expect(renameOutcome(currentOutcome, current)).toEqual(renameOutcome(legacyOutcome, legacy));
      expect(await snapshot(owner, current)).toEqual(await snapshot(owner, legacy));
    });
  }

  it('스위치 끔 → activate (SQL 쪽은 트랜잭션 안에서 ops_activation_beta_enabled() = false, 롤백)', async () => {
    const legacy = await makeFixture(owner, 'pending_review');
    const current = await makeFixture(owner, 'pending_review');
    const legacyOutcome = await reviewOrganizationOpV0(owner, legacy.id, 'active', ACTOR, false);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      // ops 통합 파일(활성화를 커밋한다)과 겹치지 않게 같은 키의 잠금을 이 트랜잭션 동안 쥔다.
      await lockOpsTestXact(client);
      await client.query(
        `CREATE OR REPLACE FUNCTION ops_activation_beta_enabled() RETURNS boolean
         LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$ SELECT false $$`,
      );
      const row = (
        await client.query<{ from_status: 'pending_review'; changed: boolean; grant: 'granted' | 'disabled' | 'kept' | 'none'; from_plan: string | null; kept_plan: string | null; version: number | null }>(
          `SELECT from_status, changed, "grant", from_plan, kept_plan, version FROM ops_org_activate_core($1, $2)`,
          [current.id, ACTOR],
        )
      ).rows[0];
      expect(row).toBeDefined();
      if (row === undefined) return;
      const currentOutcome = { from: row.from_status, changed: row.changed, suspended: [], revokedTokens: 0, plan: activationGrantOf(row) };
      expect(currentOutcome).toEqual(legacyOutcome);
      expect(await snapshot(client, current)).toEqual(await snapshot(owner, legacy));
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('없는 조직 → 둘 다 organization_not_found(AdminInputError · 같은 문구)', async () => {
    const missing = '00000000-0000-4000-8000-00000000d1ff';
    for (const target of ['active', 'rejected'] as const) {
      const legacy = await reviewOrganizationOpV0(owner, missing, target, ACTOR, BETA_ON_ACTIVATION).catch((error: unknown) => error);
      const current = await reviewOrganizationOp(owner, missing, target, ACTOR).catch((error: unknown) => error);
      expect(legacy).toBeInstanceOf(AdminInputError);
      expect(current).toBeInstanceOf(AdminInputError);
      expect((current as AdminInputError).code).toBe((legacy as AdminInputError).code);
      expect((current as AdminInputError).message).toBe((legacy as AdminInputError).message);
    }
  });

  it('잘못된 id 는 DB 전에 invalid_organization(둘 다)', async () => {
    await expect(reviewOrganizationOp(owner, 'nope', 'active', ACTOR)).rejects.toMatchObject({ code: 'invalid_organization' });
    await expect(reviewOrganizationOpV0(owner, 'nope', 'active', ACTOR, true)).rejects.toMatchObject({ code: 'invalid_organization' });
  });
});
