/**
 * 교차 조직 · 양도 · D-H(ADR-0014 결정 2 · D-H · 계획 §3.3 ⑨ · #12 보안 리뷰) — 실제 Postgres + 실제 domain-control 로직(가짜 SES · DNS).
 *
 *   ① **동시 경합**: 두 조직이 같은 도메인의 TXT 를 동시에 통과 → 하나만 verifying(도메인 진입 잠금 · 점유 가드) · 진 쪽은 pending(registrable_taken)
 *      이고 **SES 호출 0**(진 쪽 행 id 로 간 요청은 check 뿐).
 *   ② **양도**: A 가 ownership_lost · A 토큰 부재 재확인 → A removed(`superseded_by` = B) · B verifying → B 의 사가가 identity 를 **채택**(태그 교체 ·
 *      createIdentity 0) · 옛 정책 제거. **대체된 A 에는 sync_policy · audit_policy 가 가지 않는다**(정책 동기화 표시가 남아 있어도) · A 의 제거 사가는 SES 0.
 *   ③ A 가 reputation 정지면 양도하지 않는다(B 는 pending registrable_taken).
 *   ④ **양도 채택 불변식**(202610021102): superseded_by 쓰기 1회 · 옛 행 ownership_lost → removed 에서만 · 새 행 같은 도메인 · 다른 조직 · TXT 통과 ·
 *      `supersededRowFor` 는 그 조건을 다시 본 행만.
 *   ⑤ **D-H**: A 의 자발적 제거(주소 남음) 뒤 B 가 verifying 에 들어서면 A 의 남은 별칭이 같은 트랜잭션에서 폐기 → 30일 보류(B 도 23505) ·
 *      동결된 채 제거된 행의 톰스톤은 B 의 진입을 막고(42501) 운영자 `--unfreeze` 가 푼다.
 */

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runDomainTick } from '../../../src/domains/lifecycle';
import { orphanCandidates, supersededRowFor } from '../../../src/domains/store';
import { runDomain } from '../../../scripts/admin/domain';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { adminRolePool } from '../admin/support';
import { addAlias } from '../policy/support';
import { domainState, fakeInvoker, fakeWorld, newApex, OWNER_URL, opsFor, pendingDomain, tickPool, type FakeWorld } from './support';

const AVAILABLE = DATABASE_AVAILABLE && OWNER_URL.trim() !== '';
const MINUTE = 60_000;
const io = { out: () => undefined, err: () => undefined, interactive: false, ask: () => Promise.resolve('') };

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

describe.skipIf(!AVAILABLE)('교차 조직 · 양도 · D-H', () => {
  let pools: Pool[];
  let clock = new Date();

  beforeAll(() => {
    pools = [tickPool(), tickPool()];
  });
  beforeEach(() => {
    clock = new Date();
  });
  afterAll(async () => {
    for (const pool of pools) await pool.end();
    await closeTestPool();
  });

  async function tick(world: FakeWorld, orgs: readonly string[], advanceMs = 31 * MINUTE, pool = pools[0]): Promise<void> {
    clock = new Date(clock.getTime() + advanceMs);
    await runDomainTick({ pool: pool as never, invoker: fakeInvoker(world), now: () => clock, scope: { organizationIds: orgs } });
  }

  async function verified(world: FakeWorld, f: Fixture, domain: string, apex: string): Promise<{ id: string; token: string }> {
    const row = await pendingDomain(f.organizationId, domain, apex);
    world.txt.set(apex, new Set([...((world.txt.get(apex) as Set<string> | undefined) ?? []), row.token]));
    for (let i = 0; i < 10 && (await domainState(row.id))['status'] !== 'verified'; i += 1) await tick(world, [f.organizationId]);
    expect(await domainState(row.id)).toMatchObject({ status: 'verified' });
    return row;
  }

  it('① 두 조직 동시 경합 → 하나만 verifying · 진 쪽은 pending(registrable_taken) · identity 는 하나(이긴 쪽이 채택) · 진 쪽은 그 뒤 읽기뿐', async () => {
    const world = fakeWorld();
    const b = await seedFixture(testPool());
    const c = await seedFixture(testPool());
    const apex = newApex();
    const domain = `agents.${apex}`;
    const rowB = await pendingDomain(b.organizationId, domain, apex);
    const rowC = await pendingDomain(c.organizationId, domain, apex);
    world.txt.set(apex, new Set([rowB.token, rowC.token]));
    clock = new Date(clock.getTime() + MINUTE);
    const now = clock;
    await Promise.all([
      runDomainTick({ pool: pools[0] as never, invoker: fakeInvoker(world), now: () => now, scope: { organizationIds: [b.organizationId] } }),
      runDomainTick({ pool: pools[1] as never, invoker: fakeInvoker(world), now: () => now, scope: { organizationIds: [c.organizationId] } }),
    ]);
    const states = [await domainState(rowB.id), await domainState(rowC.id)];
    expect(states.map((state) => state['status']).sort()).toEqual(['pending', 'verifying']);
    const loser = states[0]?.['status'] === 'pending' ? rowB : rowC;
    const winner = loser === rowB ? rowC : rowB;
    // 클레임은 하나(색인) — 관리자가 아니던 쪽이 먼저 증명했으면 그 자리에서 관리권을 넘겨받았다(증명이 선점을 이긴다).
    expect(await domainState(winner.id)).toMatchObject({ claimed: true, released: false });
    const mark = world.requests.length;
    // 몇 틱 더 — 이긴 쪽은 사가를 돌고(직전 관리자의 identity 를 채택), 진 쪽은 registrable_taken 으로 남아 읽기(check · peek)만.
    for (let i = 0; i < 6; i += 1) await tick(world, [b.organizationId, c.organizationId]);
    expect(await domainState(loser.id)).toMatchObject({ status: 'pending', pending_reason: 'registrable_taken' });
    // 진 쪽은 읽기만(check · 토큰이 아직 없으면 peek_identity) — 사가 · 정책 · 제거 요청 0. 어느 쪽이 먼저 클레임했는지는 경합에 달렸다.
    const loserOps = new Set(world.requests.slice(mark).filter((request) => request.rowId === loser.id).map((request) => request.op));
    expect([...loserOps].every((op) => op === 'check' || op === 'peek_identity')).toBe(true);
    expect(loserOps.has('check')).toBe(true);
    expect(await domainState(winner.id)).toMatchObject({ status: 'verified', tag: winner.id });
    expect(world.identities.get(domain)?.tags['atmark:row']).toBe(winner.id);
    expect(world.sesCalls.filter((call) => call.startsWith('createIdentity')).length).toBeLessThanOrEqual(2); // 두 번째는 AlreadyExists — identity 는 하나
    expect(world.identities.size).toBe(1);
    expect(await orphanCandidates(provisioningPool(), { organizationIds: [b.organizationId, c.organizationId] })).toBe(0);
  });

  it('② 양도 — A ownership_lost · 토큰 부재 → A removed(superseded_by B) · B 가 identity 채택(생성 0) · A 에는 정책 요청 0 · A 제거 사가 SES 0', async () => {
    const world = fakeWorld();
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const apex = newApex();
    const domain = `agents.${apex}`;
    const rowA = await verified(world, a, domain, apex);
    await addAlias(a.agentId, `old@${domain}`);
    await tick(world, [a.organizationId], MINUTE); // A 정책 동기화
    expect(Object.values(world.identities.get(domain)?.policies ?? {}).join('')).toContain(`old@${domain}`);
    // A 가 TXT 를 잃는다(두 번) → ownership_lost.
    world.txt.set(apex, new Set());
    await tick(world, [a.organizationId], 7 * 60 * MINUTE);
    await tick(world, [a.organizationId]);
    expect(await domainState(rowA.id)).toMatchObject({ status: 'suspended', suspended_reason: 'ownership_lost' });
    // 정지의 정책 삭제가 아직 밀려 있게 한 채(경합 재현) — B 가 같은 도메인을 증명한다.
    await provisioningPool().query('UPDATE custom_domains SET policy_sync_requested_at = now() WHERE id = $1', [rowA.id]);
    const rowB = await pendingDomain(b.organizationId, domain, apex);
    world.txt.set(apex, new Set([rowB.token]));
    const before = world.requests.length;
    await tick(world, [b.organizationId], MINUTE);
    expect(await domainState(rowA.id)).toMatchObject({ status: 'removed', superseded_by: rowB.id });
    expect(await domainState(rowB.id)).toMatchObject({ status: 'verifying', txt: true });
    // 양도 확인은 A 토큰의 check 하나(잠금 안).
    expect(world.requests.slice(before).filter((request) => request.rowId === rowA.id).map((request) => request.op)).toEqual(['check']);
    const created = world.sesCalls.filter((call) => call.startsWith('createIdentity')).length;
    for (let i = 0; i < 8 && (await domainState(rowB.id))['status'] !== 'verified'; i += 1) await tick(world, [a.organizationId, b.organizationId]);
    expect(await domainState(rowB.id)).toMatchObject({ status: 'verified', tag: rowB.id });
    expect(world.sesCalls.filter((call) => call.startsWith('createIdentity')).length).toBe(created); // 채택 — 새로 만들지 않는다
    expect(world.identities.get(domain)?.tags['atmark:row']).toBe(rowB.id);
    expect(Object.keys(world.identities.get(domain)?.policies ?? {}).every((name) => name.includes(rowB.id))).toBe(true);
    // ★ 대체된 A — 대체 뒤 정책 요청 0 · 제거 사가는 SES 호출 0 으로 끝.
    expect(world.requests.slice(before).filter((request) => request.rowId === rowA.id && request.op !== 'check')).toEqual([]);
    expect(await domainState(rowA.id)).toMatchObject({ status: 'removed', removal_step: 'done' });
    expect(world.identities.has(domain)).toBe(true);
    // 채택은 검증된 조회로만 — supersededRowFor 가 A 를 돌려준다(B 가 verifying 일 때).
  });

  it('③ A 가 reputation 정지면 양도하지 않는다 — B 는 pending(registrable_taken) · A 그대로', async () => {
    const world = fakeWorld();
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const apex = newApex();
    const domain = `agents.${apex}`;
    const rowA = await verified(world, a, domain, apex);
    await provisioningPool().query(`UPDATE custom_domains SET status = 'suspended', suspended_reason = 'reputation', suspended_at = now() WHERE id = $1`, [rowA.id]);
    const rowB = await pendingDomain(b.organizationId, domain, apex);
    world.txt.set(apex, new Set([rowB.token]));
    await tick(world, [b.organizationId], MINUTE);
    expect(await domainState(rowB.id)).toMatchObject({ status: 'pending', pending_reason: 'registrable_taken' });
    expect(await domainState(rowA.id)).toMatchObject({ status: 'suspended', suspended_reason: 'reputation' });
    expect(opsFor(world, rowA.id).filter((op) => op === 'check')).toHaveLength(2); // verified 까지의 확인뿐 — 양도 재확인 없음
  });

  it('④ 양도 채택 불변식 — 쓰기 1회 · ownership_lost → removed 에서만 · 같은 도메인 · 다른 조직 · TXT 통과 · supersededRowFor', async () => {
    const owner = provisioningPool();
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const apex = newApex();
    const domain = `agents.${apex}`;
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, 'custom_domains', 't'), ($2, 'custom_domains', 't') ON CONFLICT DO NOTHING`, [a.organizationId, b.organizationId]);
      const insert = async (org: string, name: string): Promise<string> =>
        (await client.query<{ id: string }>(`INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`, [org, name, apex, 'x'.repeat(43)])).rows[0]?.id ?? '';
      const old = await insert(a.organizationId, domain);
      await client.query(`UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [old]);
      await client.query(`UPDATE custom_domains SET status = 'verified', verified_at = now() WHERE id = $1`, [old]);
      const next = await insert(b.organizationId, domain);
      const sameOrg = await insert(a.organizationId, `other.${apex}`);
      const supersede = `UPDATE custom_domains SET status = 'removed', suspended_reason = NULL, removed_at = now(), superseded_by = $2 WHERE id = $1`;
      // verified 에서는 안 된다(ownership_lost 만).
      await client.query(`UPDATE custom_domains SET txt_verified_at = now() WHERE id = $1`, [next]);
      expect(await stateOf(client, supersede, [old, next])).toBe('23514');
      await client.query(`UPDATE custom_domains SET status = 'suspended', suspended_reason = 'reputation', suspended_at = now() WHERE id = $1`, [old]);
      expect(await stateOf(client, supersede, [old, next])).toBe('23514');
      // 제거 사가가 identity 를 지웠다(202610061001 — 그래야 같은 도메인의 다음 행이 관리자가 된다).
      await client.query(`UPDATE custom_domains SET status = 'removed', suspended_reason = NULL, removed_at = now(), identity_deleted_at = now() WHERE id = $1`, [old]);
      // 새 a 행으로 다시 — ownership_lost.
      const lost = await insert(a.organizationId, domain);
      await client.query(`UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [lost]);
      await client.query(`UPDATE custom_domains SET status = 'verified', verified_at = now() WHERE id = $1`, [lost]);
      await client.query(`UPDATE custom_domains SET status = 'suspended', suspended_reason = 'ownership_lost', suspended_at = now() WHERE id = $1`, [lost]);
      // TXT 를 통과하지 않은 새 행 · 같은 조직 행 · 다른 도메인 행 → 거부.
      const untested = await insert(b.organizationId, `third.${apex}`);
      expect(await stateOf(client, supersede, [lost, untested])).toBe('23514');
      await client.query(`UPDATE custom_domains SET txt_verified_at = now() WHERE id = $1`, [sameOrg]);
      expect(await stateOf(client, supersede, [lost, sameOrg])).toBe('23514'); // 같은 조직 · 다른 도메인
      await client.query(`UPDATE custom_domains SET txt_verified_at = now() WHERE id = $1`, [untested]);
      expect(await stateOf(client, supersede, [lost, untested])).toBe('23514'); // 다른 도메인
      // 상태를 바꾸지 않는 대체(removed 가 아닌 UPDATE)도 거부.
      expect(await stateOf(client, `UPDATE custom_domains SET superseded_by = $2 WHERE id = $1`, [lost, next])).toBe('23514');
      // 올바른 양도 — 그리고 쓰기 1회.
      expect(await stateOf(client, supersede, [lost, next])).toBe('ok');
      expect(await stateOf(client, `UPDATE custom_domains SET superseded_by = $2 WHERE id = $1`, [lost, untested])).toBe('23514');
      expect(await supersededRowFor(client, next)).toBe(lost);
      expect(await supersededRowFor(client, untested)).toBeNull();
      expect(await supersededRowFor(client, lost)).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('⑤ D-H — 자발적 제거 뒤 새 조직의 verifying 진입이 남은 별칭을 폐기 · 30일 보류 · 동결 톰스톤은 운영자 해제까지 진입을 막는다', async () => {
    const world = fakeWorld();
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const apex = newApex();
    const domain = `agents.${apex}`;
    const rowA = await verified(world, a, domain, apex);
    await addAlias(a.agentId, `left@${domain}`);
    await provisioningPool().query('UPDATE custom_domains SET removal_requested_at = now() WHERE id = $1', [rowA.id]);
    const live = async (): Promise<boolean> =>
      (await provisioningPool().query<{ live: boolean }>('SELECT retired_at IS NULL AS live FROM agent_addresses WHERE address = $1', [`left@${domain}`])).rows[0]?.live ?? false;
    expect(await live()).toBe(true); // 자발적 제거는 주소를 남긴다
    const rowB = await pendingDomain(b.organizationId, domain, apex);
    world.txt.set(apex, new Set([rowB.token]));
    // A 는 removed 관리자 — 정책을 먼저 지우고(제거 사가 policy) 그다음 B 가 넘겨받는다(증명 인수 · 또는 제거 사가 넘겨주기). SES identity 는 지우지 않는다.
    for (let i = 0; i < 4 && (await domainState(rowB.id))['status'] === 'pending'; i += 1) await tick(world, [a.organizationId, b.organizationId], MINUTE);
    expect(await domainState(rowB.id)).toMatchObject({ status: 'verifying', claimed: true });
    expect(await domainState(rowA.id)).toMatchObject({ released: true, handover_to: rowB.id, deleted: false });
    expect(world.sesCalls.filter((call) => call.startsWith('deleteIdentity'))).toEqual([]);
    expect(await live()).toBe(false); // D-H
    for (let i = 0; i < 8 && (await domainState(rowB.id))['status'] !== 'verified'; i += 1) await tick(world, [a.organizationId, b.organizationId]);
    expect(await domainState(rowB.id)).toMatchObject({ status: 'verified', tag: rowB.id });
    expect(world.identities.get(domain)?.tags['atmark:row']).toBe(rowB.id); // 채택 — 토큰 그대로
    expect(await domainState(rowA.id)).toMatchObject({ removal_step: 'done' });
    const reissue = await provisioningPool()
      .query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, $3, false)`, [b.agentId, `left@${domain}`, domain])
      .then(() => 'ok', (error: { code?: string }) => error.code);
    expect(reissue).toBe('23505'); // 30일 보류

    // 동결 톰스톤 — reputation 정지 상태에서 제거되면 같은 apex 의 새 진입이 42501, 운영자 해제 뒤 된다.
    const c = await seedFixture(testPool());
    const apex2 = newApex();
    const frozen = await verified(world, c, `agents.${apex2}`, apex2);
    await provisioningPool().query(`UPDATE custom_domains SET status = 'suspended', suspended_reason = 'reputation', suspended_at = now() WHERE id = $1`, [frozen.id]);
    await provisioningPool().query('UPDATE custom_domains SET removal_requested_at = now() WHERE id = $1', [frozen.id]);
    const d = await seedFixture(testPool());
    await provisioningPool().query(`INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, 'custom_domains', 'test') ON CONFLICT DO NOTHING`, [d.organizationId]);
    // 콘솔 경로(admin 롤)의 새 행 — 소유자 롤은 톰스톤 예외라 admin 으로 본다.
    const admin = adminRolePool();
    const attempt = (): Promise<string | undefined> =>
      admin
        .query(`INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4)`, [d.organizationId, `bots.${apex2}`, apex2, 'y'.repeat(43)])
        .then(() => 'ok', (error: { code?: string }) => error.code);
    try {
      expect(await attempt()).toBe('42501');
      await runDomain(provisioningPool(), { target: 'local' } as never, { kind: 'unfreeze', domainId: frozen.id, yes: true }, { env: {}, io });
      expect(await attempt()).toBe('ok');
    } finally {
      await admin.end();
    }
  });

  it('★ ⑥ 채택 전에 후속 행이 사라지면(#13 M2 재현) — 관리권을 받은 후속 행이 먼저 채택하고 정상 제거 사가로 identity 를 지운다 · 그 뒤 C 가 정상 등록된다', async () => {
    const world = fakeWorld();
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const c = await seedFixture(testPool());
    const apex = newApex();
    const domain = `agents.${apex}`;
    const rowA = await verified(world, a, domain, apex);
    world.txt.set(apex, new Set());
    await tick(world, [a.organizationId], 7 * 60 * MINUTE);
    await tick(world, [a.organizationId]);
    expect(await domainState(rowA.id)).toMatchObject({ status: 'suspended', suspended_reason: 'ownership_lost' });
    const rowB = await pendingDomain(b.organizationId, domain, apex);
    world.txt.set(apex, new Set([rowB.token]));
    await tick(world, [b.organizationId], MINUTE); // 양도 — A removed(superseded_by B) · B verifying
    expect(await domainState(rowA.id)).toMatchObject({ status: 'removed', superseded_by: rowB.id, released: true, handover_to: rowB.id });
    expect(await domainState(rowB.id)).toMatchObject({ status: 'verifying', saga_step: 'none', claimed: true });
    // B 가 사가(채택) 전에 사라진다.
    await provisioningPool().query('UPDATE custom_domains SET removal_requested_at = now() WHERE id = $1', [rowB.id]);
    expect(world.identities.get(domain)?.tags['atmark:row']).toBe(rowA.id); // 아직 옛 행 태그
    for (let i = 0; i < 4; i += 1) await tick(world, [a.organizationId, b.organizationId], MINUTE);
    expect(await domainState(rowA.id)).toMatchObject({ status: 'removed', removal_step: 'done' });
    expect(await domainState(rowB.id)).toMatchObject({ status: 'removed', removal_step: 'done' });
    expect(world.identities.has(domain)).toBe(false); // 고아 없음
    expect(await orphanCandidates(provisioningPool(), { organizationIds: [a.organizationId, b.organizationId] })).toBe(0);
    expect(opsFor(world, rowA.id).filter((op) => op === 'remove_step')).toEqual([]); // 관리권을 놓은 옛 행은 SES 0
    expect(opsFor(world, rowB.id).filter((op) => op === 'saga_step' || op === 'remove_step')).toEqual(['saga_step', 'remove_step', 'remove_step']); // 채택 → 정책 → identity
    expect(await domainState(rowB.id)).toMatchObject({ deleted: true });
    // C — 같은 도메인을 처음부터 정상 등록(새 identity · 태그 C).
    const rowC = await pendingDomain(c.organizationId, domain, apex);
    world.txt.set(apex, new Set([rowC.token]));
    for (let i = 0; i < 10 && (await domainState(rowC.id))['status'] !== 'verified'; i += 1) await tick(world, [c.organizationId]);
    expect(await domainState(rowC.id)).toMatchObject({ status: 'verified', tag: rowC.id });
    expect(world.identities.get(domain)?.tags['atmark:row']).toBe(rowC.id);
  });

  it('⑥\' 관리권을 놓은 옛 행은 곧바로 SES 호출 0 으로 정산 · 후속 행의 채택이 늦어도 옛 행에 SES 요청이 가지 않는다', async () => {
    const world = fakeWorld();
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const apex = newApex();
    const domain = `agents.${apex}`;
    const rowA = await verified(world, a, domain, apex);
    world.txt.set(apex, new Set());
    await tick(world, [a.organizationId], 7 * 60 * MINUTE);
    await tick(world, [a.organizationId]);
    const rowB = await pendingDomain(b.organizationId, domain, apex);
    world.txt.set(apex, new Set([rowB.token]));
    world.failNext.set('getIdentity', 1_000); // B 의 사가가 채택하지 못하는 동안(대기)
    await tick(world, [b.organizationId], MINUTE);
    const before = world.requests.length;
    for (let i = 0; i < 3; i += 1) await tick(world, [a.organizationId, b.organizationId], MINUTE);
    expect(world.requests.slice(before).filter((request) => request.rowId === rowA.id)).toEqual([]);
    expect(await domainState(rowA.id)).toMatchObject({ removal_step: 'done', released: true, handover_to: rowB.id });
    expect(await orphanCandidates(provisioningPool(), { organizationIds: [a.organizationId, b.organizationId] })).toBe(0); // B 가 관리자 — 사슬이 살아 있다
    world.failNext.set('getIdentity', 0);
    for (let i = 0; i < 3; i += 1) await tick(world, [a.organizationId, b.organizationId]); // 실패 뒤 30분 재시도
    expect(await domainState(rowB.id)).toMatchObject({ tag: rowB.id });
    expect(await domainState(rowA.id)).toMatchObject({ removal_step: 'done' });
    expect(world.requests.filter((request) => request.rowId === rowA.id && request.op === 'remove_step')).toEqual([]);
    expect(world.identities.get(domain)?.tags['atmark:row']).toBe(rowB.id);
  });

  it('⑦ 고아 후보 지표 — 관리자 사슬이 끊긴 도메인(놓았는데 관리자 없음 · 아무도 identity 를 지우지 않음)을 센다 · 틱이 EMF 로 낸다', async () => {
    const world = fakeWorld();
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const apex = newApex();
    const domain = `agents.${apex}`;
    const rowA = await verified(world, a, domain, apex);
    world.txt.set(apex, new Set());
    await tick(world, [a.organizationId], 7 * 60 * MINUTE);
    await tick(world, [a.organizationId]);
    const rowB = await pendingDomain(b.organizationId, domain, apex);
    world.txt.set(apex, new Set([rowB.token]));
    await tick(world, [b.organizationId], MINUTE);
    const scope = { organizationIds: [a.organizationId, b.organizationId] };
    expect(await orphanCandidates(provisioningPool(), scope)).toBe(0);
    // 사슬을 끊는다 — 후속 행이 채택 전에 사라지고 관리권을 **포기**(넘겨받을 행 없이 놓음 — 제거 사가가 남의 identity 를 만났을 때)한다(소유자 롤).
    await provisioningPool().query('UPDATE custom_domains SET removal_requested_at = now() WHERE id = $1', [rowB.id]);
    await provisioningPool().query(`UPDATE custom_domains SET identity_released_at = now(), removal_step = 'done' WHERE id = $1`, [rowB.id]);
    expect(await orphanCandidates(provisioningPool(), scope)).toBe(1);
    clock = new Date(clock.getTime() + MINUTE);
    const report = await runDomainTick({ pool: pools[0] as never, invoker: fakeInvoker(world), now: () => clock, scope });
    expect(report.orphanCandidates).toBe(1);
  });
});
