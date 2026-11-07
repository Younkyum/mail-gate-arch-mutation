/**
 * 대표 주소 포인터 모델(ADR-0014 2026-10 개정 · 202610021100 · 1110) — 실제 Postgres.
 *
 *   ① 선택 가드: 대상 = 앵커 또는 같은 조직 verified 고객 별칭 · atmark.ai 별칭 · 폐기 · 남의 주소 → P0A08 · 정지 도메인 → P0A05 · 원인 `provision`·
 *      `operator` 는 소유자 롤만(admin 42501) · 운영자 예약 앵커 42501 · 주소는 트리거가 적는다 · append-only.
 *   ② 속도 상한: 에이전트 24시간 5 · 조직 24시간 50 → P0A09.
 *   ③ **TS = SQL**: 여러 상태에서 `effectivePrimaryOf(loadPrimaryFacts)` = `atmark_agent_primary_address`.
 *   ④ **ownership_lost → 대표 NULL → 여권 재서명 요청**(ⓐ 선택 · ⓑ 마지막 선택 폐기 · ⓒ 도메인 상태) · 평판 정지는 주소 유지.
 *   ⑤ **잠든 앵커**: 정책 소스 `usable`(앵커는 inactive — from_inactive) · 수신 조회(앵커는 모르는 주소) · 앵커를 다시 고르면 깬다.
 *   ⑥ 투명성: 선택 INSERT 가 outbox 원천 `agent_primary_changes`(조직 = 에이전트의 조직).
 *   ⑦ **경합**: 선택(조직 → 도메인 행 → 주소)과 소유권 상실 전이(도메인 행 → 주소)가 어느 순서로 겹쳐도 교착 없이 직렬로 끝난다.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresInboundStore } from '../../../src/db/repositories/inbound-store';
import { createPostgresPolicySource } from '../../../src/db/repositories/policy-source';
import { DOMAIN_SQLSTATES } from '../../../src/domains/contract';
import { OPERATOR_ASSIGNABLE_ADDRESSES } from '../../../src/identity/address';
import { effectivePrimaryOf, loadEffectivePrimary, loadPrimaryFacts } from '../../../src/identity/primary';
import { adminRolePool, ADMIN_ROLE_URL } from '../admin/support';
import { closeTestPool, DATABASE_AVAILABLE, newAgentId, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { addAlias, suspendDomain, verifiedCustomDomain } from '../policy/support';
import { OWNER_URL } from './support';

const AVAILABLE = DATABASE_AVAILABLE && OWNER_URL.trim() !== '' && ADMIN_ROLE_URL.trim() !== '';

async function stateOf(client: PoolClient, sql: string, params: readonly unknown[] = []): Promise<string> {
  await client.query('SAVEPOINT s');
  try {
    await client.query(sql, [...params]);
    await client.query('RELEASE SAVEPOINT s');
    return 'ok';
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT s');
    return (error as { code?: string }).code ?? 'no-code';
  }
}

async function addressId(db: Pick<Pool, 'query'>, address: string): Promise<string> {
  return (await db.query<{ id: string }>('SELECT id::text AS id FROM agent_addresses WHERE address = $1 AND retired_at IS NULL', [address])).rows[0]?.id ?? '';
}

const choose = (db: Pick<Pool, 'query'>, agentId: string, id: string, cause = 'owner'): Promise<unknown> =>
  db.query('INSERT INTO agent_primary_changes (agent_id, address_id, cause) VALUES ($1, $2, $3)', [agentId, id, cause]);

/** 게시된 여권 하나(서명 문서 포함 — 202609241200 의 지연 제약). 소유자 롤. */
async function publishPassport(agentId: string): Promise<void> {
  const owner = provisioningPool();
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    const passport = await client.query<{ id: string }>(`INSERT INTO passports (agent_id, did, controller) VALUES ($1, $2, 'did:web:id.atmark.ai') RETURNING id`, [
      agentId,
      `did:web:id.atmark.ai:agents:${agentId}`,
    ]);
    const text = '{"v":1}';
    const hash = createHash('sha256').update(text).digest('hex');
    await client.query(`UPDATE passports SET status = 'published', metadata_uri = 'https://id.atmark.ai/x', content_hash = $2 WHERE id = $1`, [passport.rows[0]?.id, hash]);
    await client.query(`INSERT INTO passport_documents (passport_id, document, jws, valid_from, valid_until) VALUES ($1, $2, $3, now(), now() + interval '90 days')`, [
      passport.rows[0]?.id,
      text,
      `${Buffer.from('{"alg":"EdDSA"}').toString('base64url')}.${Buffer.from(text).toString('base64url')}.c2ln`,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function pendingResigns(agentId: string): Promise<number> {
  return (
    await provisioningPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM passport_publish_requests WHERE agent_id = $1 AND kind = 'resign' AND requested_by = 'system:primary_address' AND status = 'pending'`,
      [agentId],
    )
  ).rows[0]?.n ?? 0;
}

/** 대기 요청을 끝낸다(다음 요청이 새로 들어올 수 있게 — 에이전트당 대기 1). */
async function settleRequests(agentId: string): Promise<void> {
  await provisioningPool().query(
    `UPDATE passport_publish_requests SET status = 'rejected', outcome = 'rejected', outcome_reason = 'test', completed_at = now() WHERE agent_id = $1 AND status = 'pending'`,
    [agentId],
  );
}

describe.skipIf(!AVAILABLE)('대표 주소 포인터 모델', () => {
  let admin: Pool;

  beforeAll(() => {
    admin = adminRolePool();
  });

  afterAll(async () => {
    await admin.end();
    await closeTestPool();
  });

  async function adminTx(run: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await run(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  it('① 선택 가드 — 대상 · 원인 · 운영자 예약 앵커 · 주소는 트리거가 · append-only', async () => {
    const f = await seedFixture(testPool());
    const other = await seedFixture(testPool());
    const { id: domainId, domain } = await verifiedCustomDomain(f.organizationId);
    await addAlias(f.agentId, `bob@${domain}`);
    await addAlias(f.agentId, `alias-${f.agentId.slice(0, 16)}@atmark.ai`);
    await addAlias(f.agentId, `gone@${domain}`);
    await provisioningPool().query('UPDATE agent_addresses SET retired_at = now() WHERE address = $1', [`gone@${domain}`]);
    const gone = (await provisioningPool().query<{ id: string }>('SELECT id::text AS id FROM agent_addresses WHERE address = $1', [`gone@${domain}`])).rows[0]?.id ?? '';
    const anchor = await addressId(provisioningPool(), f.address);
    const custom = await addressId(provisioningPool(), `bob@${domain}`);
    const atmarkAlias = await addressId(provisioningPool(), `alias-${f.agentId.slice(0, 16)}@atmark.ai`);
    const foreign = await addressId(provisioningPool(), other.address);
    await adminTx(async (client) => {
      const insert = (id: string, cause = 'owner'): Promise<string> =>
        stateOf(client, 'INSERT INTO agent_primary_changes (agent_id, address_id, cause) VALUES ($1, $2, $3)', [f.agentId, id, cause]);
      expect(await insert(custom)).toBe('ok');
      expect(await insert(anchor)).toBe('ok');
      expect(await insert(atmarkAlias)).toBe(DOMAIN_SQLSTATES.primaryNotAllowed);
      expect(await insert(gone)).toBe(DOMAIN_SQLSTATES.primaryNotAllowed);
      expect(await insert(foreign)).toBe(DOMAIN_SQLSTATES.primaryNotAllowed);
      expect(await insert(custom, 'operator')).toBe('42501');
      expect(await insert(custom, 'provision')).toBe('42501');
      // 주소 칸은 트리거가 대상 행에서 적는다 · 고칠 · 지울 수 없다.
      const rows = await client.query<{ address: string }>('SELECT address FROM agent_primary_changes WHERE agent_id = $1 ORDER BY created_at', [f.agentId]);
      expect(rows.rows.map((row) => row.address)).toEqual([`bob@${domain}`, f.address]);
      expect(await stateOf(client, 'UPDATE agent_primary_changes SET cause = cause WHERE agent_id = $1', [f.agentId])).not.toBe('ok');
      expect(await stateOf(client, 'DELETE FROM agent_primary_changes WHERE agent_id = $1', [f.agentId])).not.toBe('ok');
    });
    // 정지된 도메인의 주소는 새로 고를 수 없다(P0A05) — 이미 고른 것은 유지(④).
    await suspendDomain(domainId, 'plan_limit');
    await adminTx(async (client) => {
      expect(await stateOf(client, 'INSERT INTO agent_primary_changes (agent_id, address_id, cause) VALUES ($1, $2, $3)', [f.agentId, custom, 'owner'])).toBe(
        DOMAIN_SQLSTATES.domainNotVerified,
      );
    });
    // 소유자 롤이 address 를 거짓으로 넣어도 트리거가 덮는다.
    const owner = await provisioningPool().connect();
    try {
      await owner.query('BEGIN');
      await owner.query(`INSERT INTO agent_primary_changes (agent_id, address_id, address, cause) VALUES ($1, $2, 'lie@example.com', 'operator')`, [f.agentId, anchor]);
      expect((await owner.query<{ address: string }>('SELECT address FROM agent_primary_changes WHERE agent_id = $1', [f.agentId])).rows[0]?.address).toBe(f.address);
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
  });

  it('① 운영자 예약 앵커(support@ 등)의 에이전트는 원인 owner 로 바꾸지 않는다(42501) · operator 는 된다', async () => {
    const f = await seedFixture(testPool());
    const owner = await provisioningPool().connect();
    try {
      await owner.query('BEGIN');
      const free = await owner.query<{ address: string }>(
        `SELECT a FROM unnest($1::text[]) a WHERE NOT EXISTS (SELECT 1 FROM agent_addresses x WHERE x.address = a) LIMIT 1`,
        [OPERATOR_ASSIGNABLE_ADDRESSES.filter((address) => address !== 'abuse@atmark.ai' && address !== 'postmaster@atmark.ai')],
      );
      const reserved = (free.rows[0] as { a?: string } | undefined)?.a;
      if (reserved === undefined) return; // 로컬 DB 에 셋 다 쓰였다 — 표 판정은 마이그레이션 함수 그대로라 건너뛴다.
      const agent = newAgentId();
      await owner.query(`INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, 'ops', 'active', 'free', 0)`, [agent, f.organizationId]);
      await owner.query(`INSERT INTO operator_address_grants (address, organization_id, granted_by, reason) VALUES ($1, $2, 'test', 'test') ON CONFLICT (address) DO NOTHING`, [
        reserved,
        f.organizationId,
      ]);
      await owner.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', true)`, [agent, reserved]);
      const id = await addressId(owner, reserved);
      expect(await stateOf(owner, `INSERT INTO agent_primary_changes (agent_id, address_id, cause) VALUES ($1, $2, 'owner')`, [agent, id])).toBe('42501');
      expect(await stateOf(owner, `INSERT INTO agent_primary_changes (agent_id, address_id, cause) VALUES ($1, $2, 'operator')`, [agent, id])).toBe('ok');
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
  });

  it('② 속도 상한 — 에이전트 24시간 5 · 조직 24시간 50 → P0A09(원인 owner 만)', async () => {
    const f = await seedFixture(testPool());
    await adminTx(async (client) => {
      const anchor = await addressId(client, f.address);
      for (let i = 0; i < 5; i += 1) expect(await stateOf(client, 'INSERT INTO agent_primary_changes (agent_id, address_id, cause) VALUES ($1, $2, $3)', [f.agentId, anchor, 'owner'])).toBe('ok');
      expect(await stateOf(client, 'INSERT INTO agent_primary_changes (agent_id, address_id, cause) VALUES ($1, $2, $3)', [f.agentId, anchor, 'owner'])).toBe(
        DOMAIN_SQLSTATES.primaryRateLimited,
      );
    });
    // 조직 50 — 에이전트 열 개 × 5, 열한 번째 에이전트의 첫 선택이 걸린다(admin 롤은 에이전트·주소를 만들 수 있다).
    await adminTx(async (client) => {
      const agents: { id: string; address: string }[] = [];
      for (let i = 0; i < 11; i += 1) {
        const id = newAgentId();
        const address = `rate-${id.slice(0, 12)}@atmark.ai`;
        await client.query(`INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, $3, 'active', 'free', 0)`, [id, f.organizationId, `r${String(i)}`]);
        await client.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', true)`, [id, address]);
        agents.push({ id, address });
      }
      for (const agent of agents.slice(0, 10)) {
        const anchor = await addressId(client, agent.address);
        for (let i = 0; i < 5; i += 1) await choose(client, agent.id, anchor);
      }
      const last = agents[10] as { id: string; address: string };
      expect(await stateOf(client, 'INSERT INTO agent_primary_changes (agent_id, address_id, cause) VALUES ($1, $2, $3)', [last.id, await addressId(client, last.address), 'owner'])).toBe(
        DOMAIN_SQLSTATES.primaryRateLimited,
      );
    });
  });

  it('③ TS = SQL — 선택 없음 · 앵커 · verified · suspended(사유별) · removed · 폐기', async () => {
    const f = await seedFixture(testPool());
    const owner = provisioningPool();
    const { id: domainId, domain } = await verifiedCustomDomain(f.organizationId);
    await addAlias(f.agentId, `bob@${domain}`);
    const custom = await addressId(owner, `bob@${domain}`);
    const anchor = await addressId(owner, f.address);
    const compare = async (expected: string | null): Promise<void> => {
      const sql = await loadEffectivePrimary(testPool(), f.agentId);
      const ts = effectivePrimaryOf(await loadPrimaryFacts(owner, f.agentId));
      expect([sql, ts]).toEqual([expected, expected]);
    };
    await compare(f.address); // 선택 없음
    await choose(owner, f.agentId, custom);
    await compare(`bob@${domain}`);
    for (const reason of ['plan_limit', 'dkim_failed', 'reputation', 'operator']) {
      await owner.query(`UPDATE custom_domains SET status = 'suspended', suspended_reason = $2, suspended_at = now() WHERE id = $1`, [domainId, reason]);
      await compare(`bob@${domain}`);
      await owner.query(`UPDATE custom_domains SET status = 'verified', suspended_reason = NULL WHERE id = $1`, [domainId]);
    }
    await choose(owner, f.agentId, anchor);
    await compare(f.address);
    await choose(owner, f.agentId, custom);
    await owner.query('UPDATE custom_domains SET removal_requested_at = now() WHERE id = $1', [domainId]); // 자발적 제거 — 주소는 남는다
    await compare(null);
    // 다른 에이전트: 폐기된 선택.
    const g = await seedFixture(testPool());
    const second = await verifiedCustomDomain(g.organizationId);
    await addAlias(g.agentId, `amy@${second.domain}`);
    await choose(owner, g.agentId, await addressId(owner, `amy@${second.domain}`));
    await owner.query('UPDATE agent_addresses SET retired_at = now() WHERE address = $1', [`amy@${second.domain}`]);
    expect([await loadEffectivePrimary(testPool(), g.agentId), effectivePrimaryOf(await loadPrimaryFacts(owner, g.agentId))]).toEqual([null, null]);
  });

  it('④ ownership_lost → 대표 NULL(자동으로 앵커로 가지 않는다) · 재서명 요청 ⓐ 선택 ⓑ 폐기 ⓒ 도메인 상태 · 평판 정지는 주소 유지', async () => {
    const f = await seedFixture(testPool());
    const owner = provisioningPool();
    await publishPassport(f.agentId);
    const { id: domainId, domain } = await verifiedCustomDomain(f.organizationId);
    await addAlias(f.agentId, `bob@${domain}`);
    await choose(owner, f.agentId, await addressId(owner, `bob@${domain}`));
    expect(await pendingResigns(f.agentId)).toBe(1); // ⓐ
    await settleRequests(f.agentId);
    await owner.query(`UPDATE custom_domains SET status = 'suspended', suspended_reason = 'reputation', suspended_at = now() WHERE id = $1`, [domainId]);
    expect(await pendingResigns(f.agentId)).toBe(1); // ⓒ
    expect(await loadEffectivePrimary(testPool(), f.agentId)).toBe(`bob@${domain}`);
    await settleRequests(f.agentId);
    await owner.query(`UPDATE custom_domains SET status = 'verified', suspended_reason = NULL WHERE id = $1`, [domainId]);
    await settleRequests(f.agentId);
    // 틱 롤의 소유권 상실 전이 → 별칭 폐기(ⓑ) · 상태(ⓒ) — 대기 요청은 하나.
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE atmark_domain_tick');
      await client.query(`UPDATE custom_domains SET status = 'suspended', suspended_reason = 'ownership_lost', suspended_at = now() WHERE id = $1`, [domainId]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await pendingResigns(f.agentId)).toBe(1);
    expect(await loadEffectivePrimary(testPool(), f.agentId)).toBeNull();
    // ⓑ 만 — 자발적 폐기(도메인 상태 무변화).
    const g = await seedFixture(testPool());
    await publishPassport(g.agentId);
    const second = await verifiedCustomDomain(g.organizationId);
    await addAlias(g.agentId, `amy@${second.domain}`);
    await choose(owner, g.agentId, await addressId(owner, `amy@${second.domain}`));
    await settleRequests(g.agentId);
    await owner.query('UPDATE agent_addresses SET retired_at = now() WHERE address = $1', [`amy@${second.domain}`]);
    expect(await pendingResigns(g.agentId)).toBe(1);
    // 여권이 없는(draft 도 없는) 에이전트는 요청을 만들지 않는다.
    const h = await seedFixture(testPool());
    await choose(owner, h.agentId, await addressId(owner, h.address));
    expect(await pendingResigns(h.agentId)).toBe(0);
  });

  it('⑤ 잠든 앵커 — 정책 소스(inactive · from_inactive) · 수신(모르는 주소) · 앵커를 다시 고르면 깬다', async () => {
    const f: Fixture = await seedFixture(testPool());
    const owner = provisioningPool();
    const { domain } = await verifiedCustomDomain(f.organizationId);
    await addAlias(f.agentId, `bob@${domain}`);
    const load = () => createPostgresPolicySource(testPool()).load({ agentId: f.agentId, recipients: [], now: new Date(), threadId: null, releaseApprovalId: null });
    const inbound = createPostgresInboundStore(testPool());
    const receives = async (address: string): Promise<boolean> => (await inbound.findAgentsByAddresses([address])).some((match) => match.agentId === f.agentId);
    expect((await load()).addresses.map((row) => row.address).sort()).toEqual([`bob@${domain}`, f.address].sort());
    await choose(owner, f.agentId, await addressId(owner, `bob@${domain}`));
    const dormant = await load();
    expect(dormant.addresses.map((row) => row.address)).toEqual([`bob@${domain}`]);
    expect(dormant.inactiveAddresses).toEqual([f.address]); // from_inactive(위반 아님) — from_forgery 가 아니다
    expect([await receives(f.address), await receives(`bob@${domain}`)]).toEqual([false, true]);
    await choose(owner, f.agentId, await addressId(owner, f.address)); // "@atmark.ai 주소 켜기"
    expect((await load()).inactiveAddresses).toEqual([]);
    expect(await receives(f.address)).toBe(true);
  });

  it('⑥ 투명성 — 선택 INSERT 가 outbox(agent_primary_changes · 조직 = 에이전트의 조직 · 스냅샷 없음)', async () => {
    const f = await seedFixture(testPool());
    const owner = provisioningPool();
    await choose(owner, f.agentId, await addressId(owner, f.address));
    const change = (await owner.query<{ id: string }>('SELECT id::text AS id FROM agent_primary_changes WHERE agent_id = $1', [f.agentId])).rows[0]?.id;
    const outbox = await owner.query<{ organization_id: string; event: string; snapshot: unknown }>(
      `SELECT organization_id::text AS organization_id, event, snapshot FROM tlog_outbox WHERE source_table = 'agent_primary_changes' AND source_id = $1`,
      [change],
    );
    expect(outbox.rows).toEqual([{ organization_id: f.organizationId, event: 'insert', snapshot: null }]);
  });

  it('⑦ 경합 — 선택 ↔ 소유권 상실 전이가 어느 순서로 겹쳐도 교착 없이 직렬', async () => {
    const owner = provisioningPool();
    for (const order of ['choice-first', 'transition-first'] as const) {
      const f = await seedFixture(testPool());
      const { id: domainId, domain } = await verifiedCustomDomain(f.organizationId);
      const local = `r${randomBytes(3).toString('hex')}`;
      await addAlias(f.agentId, `${local}@${domain}`);
      const custom = await addressId(owner, `${local}@${domain}`);
      const choice = await admin.connect();
      const tick = await owner.connect();
      try {
        await choice.query('BEGIN');
        await tick.query('BEGIN');
        await tick.query('SET LOCAL ROLE atmark_domain_tick');
        await tick.query("SET LOCAL lock_timeout = '10s'");
        await choice.query("SET LOCAL lock_timeout = '10s'");
        const transition = `UPDATE custom_domains SET status = 'suspended', suspended_reason = 'ownership_lost', suspended_at = now() WHERE id = $1`;
        if (order === 'choice-first') {
          await choose(choice, f.agentId, custom);
          const pending = tick.query(transition, [domainId]);
          await choice.query('COMMIT');
          await pending;
          await tick.query('COMMIT');
          expect(await loadEffectivePrimary(testPool(), f.agentId)).toBeNull(); // 선택 뒤 상실 → 주소 없음
        } else {
          await tick.query(transition, [domainId]);
          const pending = choose(choice, f.agentId, custom).then(
            () => 'ok',
            (error: { code?: string }) => error.code,
          );
          await tick.query('COMMIT');
          // 상실 뒤 선택 → 거부 — 폐기된 주소(P0A08 — 조직 잠금 뒤에서 본다) 또는 verified 아님(P0A05 — 도메인 행 잠금 뒤에서 본다).
          expect([DOMAIN_SQLSTATES.primaryNotAllowed, DOMAIN_SQLSTATES.domainNotVerified]).toContain(await pending);
          await choice.query('ROLLBACK');
          expect(await loadEffectivePrimary(testPool(), f.agentId)).toBe(f.address);
        }
      } finally {
        await choice.query('ROLLBACK').catch(() => undefined);
        await tick.query('ROLLBACK').catch(() => undefined);
        choice.release();
        tick.release();
      }
    }
  });
});
