/**
 * `pnpm admin:org-review` — 실제 Postgres(소유자 롤). AWS 호출 0.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - `--list` 는 검토 대기 조직만(id · 정화된 이름 · 소유자 · 시각 · 에이전트 수) — 활성 조직은 나오지 않는다.
 *   - `--activate` → `review_status=active`·`reviewed_at` · 관문 소스가 그 값을 읽는다.
 *   - `--reject` → `rejected` + 그 조직 에이전트 전부 **운영자 정지**(소유자 정지는 넘겨받는다 · provisioning 은 그대로) —
 *     admin 롤(콘솔)은 그 정지를 풀지 못한다.
 *   - 같은 상태로의 전이는 변경 없음 · 입력 오류는 exit 2.
 *   - **베타 자동 부여는 꺼졌다**(202609301520 — `BETA_ON_ACTIVATION = false` · SQL 스위치 false): `--activate` 는 검토 상태만 바꾸고 요금제 행을
 *     만들지 않는다(= Free) · 백필 Free · 운영자가 정한 행은 그대로. 부여 코어는 남아 있다 — 롤백되는 트랜잭션에서 스위치를 켜면 같은 트랜잭션에서
 *     `beta` v1 + 감사 + outbox · 요금제 쓰기가 실패하면 활성화도 되돌아간다.
 *   - 요금제 잠금을 쥔 다른 쓰기와 겹쳐도 교착하지 않는다(조직 행 FOR NO KEY UPDATE, 코드 검토 L-2).
 */

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AdminInputError, type AdminIo } from '../../../scripts/admin/common';
import { orgReview } from '../../../scripts/admin/org-review';
import { setOrgPlanOp } from '../../../scripts/admin/plan';
import { activationGrantOf } from '../../../src/ops/core/review';
import { PLAN_CATALOG } from '../../../src/billing/plans';
import { loadEntitlements } from '../../../src/db/repositories/entitlements';
import { lockOrgEntitlements, writeEntitlementVersion } from '../../../src/db/repositories/entitlements-write';
import { createPostgresPolicySource } from '../../../src/db/repositories/policy-source';
import { toAgentId } from '../../../src/db/schema';
import { grantPlan } from '../../support/entitlements';
import { closeTestPool, seedFixture, testPool } from '../db/support/harness';
import { adminPool, AVAILABLE, hex64, OWNER_URL, ownerPool, sqlState, suffix, uniqueEmail } from './support';

interface Io extends AdminIo {
  readonly outLines: string[];
  readonly errLines: string[];
}

function io(): Io {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return { outLines, errLines, out: (line) => outLines.push(line), err: (line) => errLines.push(line), interactive: false, ask: async () => '' };
}

const env = (): NodeJS.ProcessEnv => ({ DATABASE_MIGRATION_URL: OWNER_URL, USER: 'org-review-test' });

describe.skipIf(!AVAILABLE)('admin:org-review (소유자 롤, 로컬 DB)', () => {
  let owner: Pool;
  let admin: Pool;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminPool();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), closeTestPool()]);
  });

  /**
   * 가입 조직(pending_review) + 에이전트 셋: active · 소유자 정지 · provisioning. `source` 는 기본 `self_signup` — 가입 조직의 이름은
   * DB 가 보이지 않는 문자를 거부하므로(202609240900 `organizations_self_signup_name_shape`), 정화 검사처럼 이름에 제어문자를 넣는
   * 시나리오는 `operator` 로 만든다(검토 대기는 출처와 무관하게 목록에 나온다).
   */
  async function signupOrg(
    name = `가입 조직 ${suffix()}`,
    source: 'self_signup' | 'operator' = 'self_signup',
  ): Promise<{ id: string; agents: { active: string; ownerSuspended: string; provisioning: string } }> {
    const org = await owner.query<{ id: string }>(
      `INSERT INTO organizations (name, owner_email, review_status, signup_source) VALUES ($1, $2, 'pending_review', $3) RETURNING id`,
      [name, uniqueEmail(), source],
    );
    const id = org.rows[0]?.id ?? '';
    const agent = async (status: string, suspendedBy: string | null): Promise<string> => {
      const agentId = hex64().slice(0, 32);
      await owner.query(
        `INSERT INTO agents (id, organization_id, name, status, suspended_by, plan, monthly_budget_cents) VALUES ($1, $2, $3, $4, $5, 'free', 1000)`,
        [agentId, id, `agent-${suffix()}`, status, suspendedBy],
      );
      return agentId;
    };
    return { id, agents: { active: await agent('active', null), ownerSuspended: await agent('suspended', 'owner'), provisioning: await agent('provisioning', null) } };
  }

  const reviewOf = (id: string) =>
    owner.query<{ review_status: string; reviewed_at: Date | null }>('SELECT review_status::text, reviewed_at FROM organizations WHERE id = $1', [id]).then((r) => r.rows[0]);
  const agentState = (id: string) =>
    owner.query<{ status: string; suspended_by: string | null }>('SELECT status::text, suspended_by FROM agents WHERE id = $1', [id]).then((r) => r.rows[0]);

  it('--list: 검토 대기만 · 이름의 제어문자·줄바꿈은 정화된다 · 에이전트 수', async () => {
    const pending = await signupOrg(`악성\u001b[31m이름\n가짜 줄`, 'operator');
    const active = await owner.query<{ id: string }>(`INSERT INTO organizations (name, owner_email) VALUES ('운영자 조직', $1) RETURNING id`, [uniqueEmail()]);
    const out = io();
    expect(await orgReview(['--list'], { env: env(), io: out })).toBe(0);
    const line = out.outLines.find((candidate) => candidate.startsWith(pending.id));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f]/u);
    expect(line?.split('\t')[1]).toBe('악성 [31m이름 가짜 줄');
    expect(line?.endsWith('agents=3')).toBe(true);
    expect(out.outLines.some((candidate) => candidate.startsWith(active.rows[0]?.id ?? '-'))).toBe(false);
  });

  it('--activate: pending_review → active · reviewed_at · 두 번째는 변경 없음 · 에이전트는 그대로', async () => {
    const org = await signupOrg();
    const out = io();
    expect(await orgReview(['--org', org.id, '--activate'], { env: env(), io: out })).toBe(0);
    expect(out.outLines).toEqual([`organization ${org.id} review_status=active`]);
    const review = await reviewOf(org.id);
    expect(review?.review_status).toBe('active');
    expect(review?.reviewed_at).not.toBeNull();
    const again = io();
    expect(await orgReview(['--org', org.id, '--activate'], { env: env(), io: again })).toBe(0);
    expect(again.errLines.join('\n')).toContain('이미 그 상태다');
    // 에이전트는 건드리지 않는다.
    expect(await agentState(org.agents.active)).toEqual({ status: 'active', suspended_by: null });
  });

  it('--reject: rejected + 활성·소유자 정지 에이전트를 운영자 정지로 · provisioning 은 그대로 · admin 롤은 그 정지를 못 푼다', async () => {
    const org = await signupOrg();
    const out = io();
    expect(await orgReview(['--org', org.id, '--reject'], { env: env(), io: out })).toBe(0);
    expect((await reviewOf(org.id))?.review_status).toBe('rejected');
    expect(await agentState(org.agents.active)).toEqual({ status: 'suspended', suspended_by: 'operator' });
    expect(await agentState(org.agents.ownerSuspended)).toEqual({ status: 'suspended', suspended_by: 'operator' });
    expect(await agentState(org.agents.provisioning)).toEqual({ status: 'provisioning', suspended_by: null });
    expect(out.outLines).toEqual(
      expect.arrayContaining([
        `organization ${org.id} review_status=rejected`,
        `agent ${org.agents.active} status=suspended suspended_by=operator`,
        `agent ${org.agents.ownerSuspended} status=suspended suspended_by=operator`,
      ]),
    );
    // 콘솔(admin 롤)은 운영자 정지를 풀지 못한다(202609230750 가드).
    expect(await sqlState(() => admin.query(`UPDATE agents SET status = 'active', suspended_by = NULL WHERE id = $1`, [org.agents.active]))).toBe('42501');
    // 되살려도 에이전트 운영자 정지는 그대로(따로 푼다).
    const revive = io();
    expect(await orgReview(['--org', org.id, '--activate'], { env: env(), io: revive })).toBe(0);
    expect((await reviewOf(org.id))?.review_status).toBe('active');
    expect(await agentState(org.agents.active)).toEqual({ status: 'suspended', suspended_by: 'operator' });
    expect(revive.errLines.join('\n')).toContain('admin:kill-switch --agent');
  });

  it('--reject: 그 조직 에이전트의 살아 있는 API 토큰을 같은 트랜잭션에서 전부 폐기 · 이미 폐기된 토큰의 시각은 그대로 · 다른 조직은 무관', async () => {
    const org = await signupOrg();
    const other = await signupOrg();
    const token = async (agentId: string, revokedAt: Date | null = null): Promise<string> => {
      const row = await owner.query<{ id: string }>(
        `INSERT INTO agent_api_keys (agent_id, token_hash, capabilities, revoked_at) VALUES ($1, $2, ARRAY['messages:send']::agent_token_capability[], $3) RETURNING id`,
        [agentId, hex64(), revokedAt],
      );
      return row.rows[0]?.id ?? '';
    };
    const oldRevokedAt = new Date('2026-09-01T00:00:00.000Z');
    const live = [await token(org.agents.active), await token(org.agents.active), await token(org.agents.ownerSuspended), await token(org.agents.provisioning)];
    const alreadyRevoked = await token(org.agents.active, oldRevokedAt);
    const untouched = await token(other.agents.active);
    const revokedAt = (id: string) =>
      owner.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM agent_api_keys WHERE id = $1', [id]).then((r) => r.rows[0]?.revoked_at ?? null);

    const out = io();
    expect(await orgReview(['--org', org.id, '--reject'], { env: env(), io: out })).toBe(0);
    for (const id of live) expect(await revokedAt(id), id).not.toBeNull();
    expect(await revokedAt(alreadyRevoked)).toEqual(oldRevokedAt);
    expect(await revokedAt(untouched)).toBeNull();
    expect(out.outLines).toContain(`agent_api_keys revoked=${String(live.length)}`);
    // 같은 상태로 다시 거절하면 아무것도 바꾸지 않는다.
    const again = io();
    expect(await orgReview(['--org', org.id, '--reject'], { env: env(), io: again })).toBe(0);
    expect(again.errLines.join('\n')).toContain('이미 그 상태다');
  });

  it('관문 소스(앱 롤)가 review_status 를 싣는다 — CLI 가 바꾼 값이 Stage 0 입력이 된다', async () => {
    const fixture = await seedFixture(testPool());
    const source = createPostgresPolicySource(testPool());
    const load = () =>
      source.load({ agentId: toAgentId(fixture.agentId), recipients: [], now: new Date(), threadId: null, releaseApprovalId: null });
    expect((await load()).organization.review_status).toBe('active');
    await owner.query(`UPDATE organizations SET review_status = 'pending_review' WHERE id = $1`, [fixture.organizationId]);
    expect((await load()).organization.review_status).toBe('pending_review');
    expect(await orgReview(['--org', fixture.organizationId, '--reject'], { env: env(), io: io() })).toBe(0);
    expect((await load()).organization.review_status).toBe('rejected');
  });

  it('입력 오류는 AdminInputError(exit 2) — 둘 다 · 둘 다 없음 · uuid 아님 · 없는 조직 · --list 와 섞기', async () => {
    for (const argv of [
      ['--org', '00000000-0000-4000-8000-000000000000', '--activate', '--reject'],
      ['--org', '00000000-0000-4000-8000-000000000000'],
      ['--org', 'nope', '--activate'],
      ['--org', '00000000-0000-4000-8000-000000000000', '--activate'],
      ['--list', '--activate'],
    ]) {
      await expect(orgReview(argv, { env: env(), io: io() }), argv.join(' ')).rejects.toBeInstanceOf(AdminInputError);
    }
  });
  describe('베타 기간 자동 부여(BETA_ON_ACTIVATION · ADR-0011 §10)', () => {
    const entitlementOf = (id: string) =>
      owner
        .query<{ plan_code: string; source: string; cause: string; version: string; max_agents: number; org_daily_recipients: number; grace_until: Date | null }>(
          'SELECT plan_code, source, cause, version::text, max_agents, org_daily_recipients, grace_until FROM org_entitlements WHERE organization_id = $1',
          [id],
        )
        .then((r) => r.rows[0] ?? null);
    const auditOf = (id: string) =>
      owner
        .query<{ from_plan: string | null; to_plan: string; cause: string; actor: string; entitlement_version: string }>(
          'SELECT from_plan, to_plan, cause, actor, entitlement_version::text FROM billing_audit WHERE organization_id = $1 ORDER BY entitlement_version',
          [id],
        )
        .then((r) => r.rows);
    const outboxOf = (id: string) =>
      owner
        .query<{ event: string; rev: number; snapshot: Record<string, unknown> }>(
          `SELECT event, rev, snapshot FROM tlog_outbox WHERE source_table = 'org_entitlements' AND source_id = $1 ORDER BY id`,
          [id],
        )
        .then((r) => r.rows);

    /**
     * 베타 자동 부여는 **꺼졌다**(202609301520 — TS `BETA_ON_ACTIVATION = false` · SQL `ops_activation_beta_enabled()` = false). 부여 코어 자체는
     * 스위치가 다시 켜지는 날을 위해 남아 있으므로, 켠 상태는 롤백되는 트랜잭션 안에서 SQL 스위치를 true 로 바꾸고 코어를 직접 불러 본다.
     */
    async function withBetaSwitchOn<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        // ops 통합 파일과 겹치지 않게 같은 키의 잠금(`test/integration/ops/db-support.ts` OPS_TEST_LOCK)을 이 트랜잭션 동안 쥔다.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['atmark.test.ops-settings']);
        await client.query(
          `CREATE OR REPLACE FUNCTION ops_activation_beta_enabled() RETURNS boolean
           LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$ SELECT true $$`,
        );
        return await run(client);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
    const activateCore = (client: PoolClient, org: string) =>
      client
        .query<{ from_status: string; changed: boolean; grant: string; from_plan: string | null; kept_plan: string | null; version: number | null }>(
          `SELECT from_status, changed, "grant", from_plan, kept_plan, version FROM ops_org_activate_core($1, 'admin:org-review:org-review-test')`,
          [org],
        )
        .then((r) => r.rows[0]);

    it('스위치 꺼짐(기본) — pending → active 만 · 요금제 행 없음(= Free) · 감사 0 · outbox 0 · 출력이 "BETA_ON_ACTIVATION 꺼짐" 을 말한다', async () => {
      const org = await signupOrg();
      const out = io();
      expect(await orgReview(['--org', org.id, '--activate'], { env: env(), io: out })).toBe(0);
      expect((await reviewOf(org.id))?.review_status).toBe('active');
      expect(await entitlementOf(org.id)).toBeNull();
      expect(await auditOf(org.id)).toEqual([]);
      expect(await outboxOf(org.id)).toEqual([]);
      expect((await loadEntitlements(admin, org.id, new Date())).planCode).toBe('free');
      expect(out.errLines.join('\n')).toContain('BETA_ON_ACTIVATION 꺼짐');
      // 다시 활성화 · 거절 뒤 되살림도 요금제를 건드리지 않는다.
      expect(await orgReview(['--org', org.id, '--activate'], { env: env(), io: io() })).toBe(0);
      expect(await orgReview(['--org', org.id, '--reject'], { env: env(), io: io() })).toBe(0);
      expect(await orgReview(['--org', org.id, '--activate'], { env: env(), io: io() })).toBe(0);
      expect(await entitlementOf(org.id)).toBeNull();
    });

    it('스위치 꺼짐 — 백필이 준 Free 는 그대로(v1) · 운영자가 정한 행(pro)도 그대로', async () => {
      const backfilled = await signupOrg();
      await grantPlan(owner, backfilled.id, 'free');
      expect(await orgReview(['--org', backfilled.id, '--activate'], { env: env(), io: io() })).toBe(0);
      expect(await entitlementOf(backfilled.id)).toMatchObject({ plan_code: 'free', version: '1' });
      const decided = await signupOrg();
      await setOrgPlanOp(owner, { organizationId: decided.id, plan: 'pro', overrides: {}, graceUntil: undefined, actor: 'admin:plan:test', note: null });
      expect(await orgReview(['--org', decided.id, '--activate'], { env: env(), io: io() })).toBe(0);
      expect(await entitlementOf(decided.id)).toMatchObject({ plan_code: 'pro', cause: 'operator', version: '1' });
      expect(await auditOf(decided.id)).toHaveLength(1);
    });

    it('거절·대기는 요금제 행이 없다(= Free)', async () => {
      const pending = await signupOrg();
      const rejected = await signupOrg();
      expect(await orgReview(['--org', rejected.id, '--reject'], { env: env(), io: io() })).toBe(0);
      for (const id of [pending.id, rejected.id]) {
        expect(await entitlementOf(id)).toBeNull();
        expect(await auditOf(id)).toEqual([]);
        expect((await loadEntitlements(admin, id, new Date())).planCode).toBe('free');
      }
    });

    it('스위치를 켜면(롤백되는 트랜잭션) 코어가 같은 트랜잭션에서 beta v1 + 감사 + outbox · 다시 활성화는 변경 없음 · 요금제 쓰기가 실패하면 활성화도 되돌아간다', async () => {
      const org = await signupOrg();
      const failing = await signupOrg();
      await withBetaSwitchOn(async (client) => {
        expect(await activateCore(client, org.id)).toEqual({ from_status: 'pending_review', changed: true, grant: 'granted', from_plan: null, kept_plan: null, version: 1 });
        const row = (await client.query<{ plan_code: string; source: string; cause: string; max_agents: number }>(
          'SELECT plan_code, source, cause, max_agents FROM org_entitlements WHERE organization_id = $1',
          [org.id],
        )).rows[0];
        expect(row).toEqual({ plan_code: 'beta', source: 'operator', cause: 'review', max_agents: PLAN_CATALOG.beta.maxAgents });
        expect((await client.query('SELECT 1 FROM billing_audit WHERE organization_id = $1', [org.id])).rowCount).toBe(1);
        expect((await client.query(`SELECT 1 FROM tlog_outbox WHERE source_table = 'org_entitlements' AND source_id = $1`, [org.id])).rowCount).toBe(1);
        expect(await activateCore(client, org.id)).toMatchObject({ from_status: 'active', changed: false, grant: 'none' });
        // 버전 1 의 감사 행을 미리 두면 부여의 감사 INSERT 가 UNIQUE 로 실패한다 — 활성화도 함께 되돌아간다.
        await client.query(
          `INSERT INTO billing_audit (organization_id, from_plan, to_plan, cause, actor, entitlement_version) VALUES ($1, NULL, 'free', 'operator', 'test', 1)`,
          [failing.id],
        );
        await client.query('SAVEPOINT f');
        expect(await sqlState(() => activateCore(client, failing.id))).not.toBe('ok');
        await client.query('ROLLBACK TO SAVEPOINT f');
        expect((await client.query<{ s: string }>('SELECT review_status::text AS s FROM organizations WHERE id = $1', [failing.id])).rows[0]?.s).toBe('pending_review');
      });
      // 트랜잭션 밖에서는 아무것도 남지 않았다.
      expect(await entitlementOf(org.id)).toBeNull();
    });

    it('교착 없음(코드 검토 L-2) — 요금제 잠금을 쥔 쓰기(sync·admin:plan 경로)가 조직 행을 잡은 활성화(스위치 켬)와 겹쳐도 둘 다 끝난다', async () => {
      const org = await signupOrg();
      const holder = await owner.connect();
      try {
        await holder.query('BEGIN');
        await lockOrgEntitlements(holder, org.id);
        const activation = withBetaSwitchOn((client) => activateCore(client, org.id));
        activation.catch(() => undefined); // 실패는 아래 await 가 드러낸다.
        // 활성화가 조직 행을 잠그고 이 조직의 요금제 잠금을 기다릴 때까지(키 = hashtextextended('org_entitlements:<조직>', 0)).
        const deadline = Date.now() + 10_000;
        for (;;) {
          const waiting = await owner.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_locks l
              WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
                AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('org_entitlements:' || $1::text, 0)`,
            [org.id],
          );
          if ((waiting.rows[0]?.n ?? 0) > 0) break;
          if (Date.now() > deadline) throw new Error('활성화가 요금제 잠금을 기다리지 않는다');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // 요금제 잠금을 쥔 채 org_entitlements·billing_audit INSERT — FK 검사가 조직 행에 KEY SHARE 를 건다. 조직 행이 FOR UPDATE 였다면
        //   여기서 서로 기다리다 40P01(교착)로 한쪽이 죽는다.
        await writeEntitlementVersion(holder, {
          organizationId: org.id,
          plan: 'pro',
          limits: PLAN_CATALOG.pro,
          graceUntil: null,
          source: 'operator',
          cause: 'operator',
          providerOverrideAllowed: false,
          actor: 'admin:plan:test',
          providerEventId: null,
          note: null,
        });
        await holder.query('COMMIT');
        // 운영자가 먼저 정한 행 — 활성화의 베타 부여는 그대로 둔다.
        expect(await activation).toMatchObject({ from_status: 'pending_review', changed: true, grant: 'kept', kept_plan: 'pro' });
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
      expect(await entitlementOf(org.id)).toMatchObject({ plan_code: 'pro', source: 'operator' });
    });

    it('스위치를 끄면(SQL ops_activation_beta_enabled() = false — TS 스위치의 짝) 아무것도 쓰지 않는다 — 활성화는 요금제를 건드리지 않고 행 없음 = Free', async () => {
      // 202609290510 부터 전이는 SQL 코어다. 스위치는 TS BETA_ON_ACTIVATION 과 SQL 함수 한 쌍 — 테스트 트랜잭션 안에서 SQL 쪽을 끄고 롤백한다(M3).
      const org = await signupOrg();
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        // ops 통합 파일과 겹치지 않게 같은 키의 잠금(`test/integration/ops/db-support.ts` OPS_TEST_LOCK)을 이 트랜잭션 동안 쥔다.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['atmark.test.ops-settings']);
        await client.query(
          `CREATE OR REPLACE FUNCTION ops_activation_beta_enabled() RETURNS boolean
           LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$ SELECT false $$`,
        );
        const row = (
          await client.query<{ from_status: string; changed: boolean; grant: 'granted' | 'disabled' | 'kept' | 'none'; from_plan: string | null; kept_plan: string | null; version: number | null }>(
            `SELECT from_status, changed, "grant", from_plan, kept_plan, version FROM ops_org_activate_core($1, 'admin:org-review:test')`,
            [org.id],
          )
        ).rows[0];
        expect(row).toEqual({ from_status: 'pending_review', changed: true, grant: 'disabled', from_plan: null, kept_plan: null, version: null });
        expect(row === undefined ? undefined : activationGrantOf(row)).toEqual({ granted: false, reason: 'disabled', plan: null });
        expect((await client.query('SELECT 1 FROM org_entitlements WHERE organization_id = $1', [org.id])).rowCount).toBe(0);
        expect((await client.query('SELECT 1 FROM billing_audit WHERE organization_id = $1', [org.id])).rowCount).toBe(0);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      expect(await entitlementOf(org.id)).toBeNull();
      expect(await auditOf(org.id)).toEqual([]);
    });
  });
});
