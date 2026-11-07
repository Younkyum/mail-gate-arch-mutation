/**
 * 한 번에 설정(2026-10 one-shot · `docs/internal/plans/custom-domains-oneshot.md` §1 · §2 · §5) — 실제 Postgres(틱 롤 권한) + 실제 domain-control 로직
 * (가짜 SES · DNS).
 *
 *   Ⓐ 추가 → `provisionDomainNow` → 클레임 + identity · DKIM 토큰 셋이 곧바로 행에(TXT 전) → TXT → verified 를 틱 4번 안에 · identity 한 번.
 *   Ⓑ 즉시 실행의 닫힌 결말 — 연결 상한(53300) `busy` · domain-control 없음 `unavailable`(행 불변) · 없는 행 · pending 아님 `skipped`.
 *   Ⓒ **증명이 선점을 이긴다** — 조직 A 의 pending 관리자(identity 를 먼저 만듦) · 조직 B 가 TXT 를 증명 → B verifying · A 는 놓음(handover = B) ·
 *      B 가 **채택**(createIdentity 1 · 토큰 그대로 · 태그 B) · A 에는 변형 0 · A 의 만료는 SES 0.
 *   Ⓓ 제거 사가의 **넘겨주기** — 관리자 pending 을 지우면 같은 도메인의 대기 행이 받는다(SES 0 · 토큰 그대로) · 대기 행이 없으면 identity 를 지운다.
 *   Ⓔ 같은 apex 를 다른 조직이 쥐면 TXT 전에도 `registrable_taken` · 클레임 0 · SES 변형 0.
 *   Ⓕ 지표 — 틱 보고에 활성 관리자 수 · 클레임 · 넘겨주기.
 *   Ⓖ (보안 리뷰 M2) 즉시 실행이 틱 롤 연결(상한 1)을 쥔 동안의 예약 틱 → `busy`(warn) · 던지지 않음 · error 로그 0 · 행 불변.
 *   Ⓗ (보안 리뷰 M2) 즉시 실행은 domain-control 호출을 기다리는 동안 연결을 쥐지 않는다(유휴 반납 — 풀의 연결 0).
 */

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { provisionDomainNow, runDomainTick, type DomainTickReport } from '../../../src/domains/lifecycle';
import { orphanCandidates } from '../../../src/domains/store';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { runDomainRecheckTask } from '../../../src/runtime/handlers/admin';
import { PROVISION_IDLE_RELEASE_MS } from '../../../src/runtime/admin-composition';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool } from '../db/support/harness';
import { domainState, fakeInvoker, fakeWorld, newApex, OWNER_URL, opsFor, pendingDomain, tickPool, type FakeWorld } from './support';

const AVAILABLE = DATABASE_AVAILABLE && OWNER_URL.trim() !== '';
const MINUTE = 60_000;
const MUTATIONS = ['createIdentity', 'tagIdentity', 'putMailFrom', 'putConfigurationSet', 'createPolicy', 'updatePolicy', 'deletePolicy', 'deleteIdentity'];

describe.skipIf(!AVAILABLE)('한 번에 설정 — identity 관리자 · 즉시 실행', () => {
  let pool: Pool;
  let clock = new Date();

  beforeAll(() => {
    pool = tickPool();
  });
  beforeEach(() => {
    clock = new Date();
  });
  afterAll(async () => {
    await pool.end();
    await closeTestPool();
  });

  async function tick(world: FakeWorld, orgs: readonly string[], advanceMs = 31 * MINUTE): Promise<DomainTickReport> {
    clock = new Date(clock.getTime() + advanceMs);
    return runDomainTick({ pool: pool as never, invoker: fakeInvoker(world), now: () => clock, scope: { organizationIds: orgs } });
  }

  const provision = (world: FakeWorld, id: string): ReturnType<typeof provisionDomainNow> =>
    provisionDomainNow({ pool: pool as never, invoker: fakeInvoker(world), now: () => clock }, id);

  const tokensOf = async (id: string): Promise<string[]> =>
    (await provisioningPool().query<{ t: string[] }>('SELECT dkim_tokens AS t FROM custom_domains WHERE id = $1', [id])).rows[0]?.t ?? [];

  it('Ⓐ 추가 → 즉시 실행 → 토큰 셋(TXT 전) → TXT → verified 를 틱 4번 안에 · identity 한 번', async () => {
    const world = fakeWorld();
    const f = await seedFixture(testPool());
    const apex = newApex();
    const domain = `agents.${apex}`;
    const { id, token } = await pendingDomain(f.organizationId, domain, apex);
    expect(await provision(world, id)).toBe('provisioned');
    expect(await domainState(id)).toMatchObject({ status: 'pending', claimed: true, saga_step: 'identity', tag: id, tokens: 3 });
    expect(world.identities.get(domain)?.tags['atmark:row']).toBe(id);
    // 다시 불러도 SES 를 더 건드리지 않는다(토큰이 이미 있다).
    const calls = world.sesCalls.length;
    expect(await provision(world, id)).toBe('provisioned');
    expect(world.sesCalls.length).toBe(calls);
    // 서브도메인 TXT 로 증명(apex 아님 — OR 판정의 기본 이름).
    world.txt.set(domain, new Set([token]));
    let ticks = 0;
    while ((await domainState(id))['status'] !== 'verified' && ticks < 6) {
      await tick(world, [f.organizationId]);
      ticks += 1;
    }
    expect(ticks).toBeLessThanOrEqual(4);
    expect(await domainState(id)).toMatchObject({ status: 'verified', saga_step: 'done', tag: id });
    expect(world.sesCalls.filter((call) => call.startsWith('createIdentity'))).toHaveLength(1);
  });

  it('Ⓑ 즉시 실행의 닫힌 결말 — busy(53300) · unavailable(행 불변) · skipped', async () => {
    const world = fakeWorld();
    const f = await seedFixture(testPool());
    const apex = newApex();
    const { id } = await pendingDomain(f.organizationId, `agents.${apex}`, apex);
    const limited = {
      query: () => Promise.reject(Object.assign(new Error('too many connections for role'), { code: '53300' })),
      connect: () => Promise.reject(Object.assign(new Error('too many connections for role'), { code: '53300' })),
    };
    expect(await provisionDomainNow({ pool: limited as never, invoker: fakeInvoker(world), now: () => clock }, id)).toBe('busy');
    world.unavailable = true;
    expect(await provision(world, id)).toBe('unavailable');
    // 클레임은 DB 만이라 남아도 된다(예약 틱이 잇는다) — SES · 토큰은 없다.
    expect(await domainState(id)).toMatchObject({ status: 'pending', tokens: 0, saga_step: 'none' });
    expect(world.sesCalls).toEqual([]);
    world.unavailable = false;
    expect(await provision(world, '00000000-0000-4000-8000-000000000000')).toBe('skipped');
    await provisioningPool().query('UPDATE custom_domains SET removal_requested_at = now() WHERE id = $1', [id]);
    expect(await provision(world, id)).toBe('skipped');
  });

  it('Ⓒ 증명이 선점을 이긴다 — A(pending 관리자) · B 가 TXT 증명 → B verifying · A 놓음 · B 채택(토큰 그대로) · A 변형 0', async () => {
    const world = fakeWorld();
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const apex = newApex();
    const domain = `agents.${apex}`;
    const rowA = await pendingDomain(a.organizationId, domain, apex);
    expect(await provision(world, rowA.id)).toBe('provisioned'); // 증명 없이 identity 를 먼저 만든다(선점)
    const tokens = await tokensOf(rowA.id);
    const rowB = await pendingDomain(b.organizationId, domain, apex);
    expect(await provision(world, rowB.id)).toBe('peeked'); // 관리자 아님 — 토큰만
    expect(await domainState(rowB.id)).toMatchObject({ claimed: false, tokens: 3, dkim_status: 'unknown' });
    expect(await tokensOf(rowB.id)).toEqual(tokens);
    world.txt.set(domain, new Set([rowB.token])); // B 만 증명
    const markA = world.sesCalls.length;
    await tick(world, [a.organizationId, b.organizationId], MINUTE);
    expect(await domainState(rowB.id)).toMatchObject({ status: 'verifying', claimed: true, released: false });
    expect(await domainState(rowA.id)).toMatchObject({ status: 'pending', released: true, handover_to: rowB.id });
    for (let i = 0; i < 6 && (await domainState(rowB.id))['status'] !== 'verified'; i += 1) await tick(world, [a.organizationId, b.organizationId]);
    expect(await domainState(rowB.id)).toMatchObject({ status: 'verified', tag: rowB.id });
    expect(await tokensOf(rowB.id)).toEqual(tokens); // 채택 — DKIM 토큰이 바뀌지 않는다
    expect(world.sesCalls.filter((call) => call.startsWith('createIdentity'))).toHaveLength(1);
    expect(world.identities.get(domain)?.tags['atmark:row']).toBe(rowB.id);
    // A 는 그 뒤로 읽기(check · peek)만 — 변형 요청 0.
    expect(new Set(opsFor(world, rowA.id).slice(2))).toEqual(new Set(['check']));
    expect(world.sesCalls.slice(markA).filter((call) => MUTATIONS.some((op) => call.startsWith(op)) && call.includes(domain)).length).toBeGreaterThan(0); // B 의 사가
    // A 가 증명해도 verifying 에 들지 못한다(관리권을 놓았다 · B 가 쥠) — registrable_taken.
    world.txt.set(domain, new Set([rowA.token, rowB.token]));
    await tick(world, [a.organizationId, b.organizationId], 7 * 60 * MINUTE);
    expect(await domainState(rowA.id)).toMatchObject({ status: 'pending', pending_reason: 'registrable_taken' });
    // A 만료 — 놓은 행이라 SES 0 으로 끝(B 의 identity 를 지우지 않는다).
    await tick(world, [a.organizationId], 73 * 60 * MINUTE);
    expect(await domainState(rowA.id)).toMatchObject({ status: 'removed', removal_step: 'done' });
    expect(world.identities.has(domain)).toBe(true);
    expect(await orphanCandidates(provisioningPool(), { organizationIds: [a.organizationId, b.organizationId] })).toBe(0);
  });

  it('Ⓓ 제거 사가 — 대기 행이 있으면 넘겨주기(SES 0 · 토큰 그대로) · 없으면 identity 삭제', async () => {
    const world = fakeWorld();
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const apex = newApex();
    const domain = `agents.${apex}`;
    const rowA = await pendingDomain(a.organizationId, domain, apex);
    expect(await provision(world, rowA.id)).toBe('provisioned');
    const tokens = await tokensOf(rowA.id);
    const rowB = await pendingDomain(b.organizationId, domain, apex);
    await provisioningPool().query('UPDATE custom_domains SET removal_requested_at = now() WHERE id = $1', [rowA.id]);
    const before = world.sesCalls.length;
    const report = await tick(world, [a.organizationId, b.organizationId], MINUTE);
    expect(report.handovers).toBe(1);
    expect(await domainState(rowA.id)).toMatchObject({ status: 'removed', removal_step: 'done', released: true, handover_to: rowB.id, deleted: false });
    expect(await domainState(rowB.id)).toMatchObject({ status: 'pending', claimed: true });
    expect(world.sesCalls.slice(before).filter((call) => call.startsWith('deleteIdentity') || call.startsWith('deletePolicy'))).toEqual([]);
    // B 가 (pending 에서) 채택 — 태그 B · 토큰 그대로.
    for (let i = 0; i < 3 && (await domainState(rowB.id))['tag'] !== rowB.id; i += 1) await tick(world, [a.organizationId, b.organizationId], MINUTE);
    expect(world.identities.get(domain)?.tags['atmark:row']).toBe(rowB.id);
    expect(await tokensOf(rowB.id)).toEqual(tokens);
    expect(world.sesCalls.filter((call) => call.startsWith('createIdentity'))).toHaveLength(1);

    // 대기 행 없음 — 관리자 pending 만료 → 제거 사가(policy → identity)가 identity 를 지운다.
    const c = await seedFixture(testPool());
    const apex2 = newApex();
    const lone = await pendingDomain(c.organizationId, `agents.${apex2}`, apex2);
    expect(await provision(world, lone.id)).toBe('provisioned');
    await tick(world, [c.organizationId], 73 * 60 * MINUTE);
    for (let i = 0; i < 3 && (await domainState(lone.id))['removal_step'] !== 'done'; i += 1) await tick(world, [c.organizationId], MINUTE);
    expect(await domainState(lone.id)).toMatchObject({ status: 'removed', removal_step: 'done', deleted: true });
    expect(world.identities.has(`agents.${apex2}`)).toBe(false);
  });

  it('Ⓔ 같은 apex 를 다른 조직이 쥐면 TXT 전에도 registrable_taken · 클레임 0 · SES 변형 0', async () => {
    const world = fakeWorld();
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const apex = newApex();
    const held = await pendingDomain(a.organizationId, `agents.${apex}`, apex);
    world.txt.set(apex, new Set([held.token]));
    for (let i = 0; i < 6 && (await domainState(held.id))['status'] !== 'verified'; i += 1) await tick(world, [a.organizationId]);
    expect(await domainState(held.id)).toMatchObject({ status: 'verified' });
    const other = await pendingDomain(b.organizationId, `bots.${apex}`, apex);
    expect(await provision(world, other.id)).toBe('waiting');
    expect(await domainState(other.id)).toMatchObject({ status: 'pending', pending_reason: 'registrable_taken', claimed: false });
    const mark = world.sesCalls.length;
    await tick(world, [b.organizationId], MINUTE);
    expect(await domainState(other.id)).toMatchObject({ pending_reason: 'registrable_taken', claimed: false });
    expect(world.sesCalls.slice(mark).filter((call) => MUTATIONS.some((op) => call.startsWith(op)))).toEqual([]);
    expect(new Set(opsFor(world, other.id))).toEqual(new Set(['check', 'peek_identity']));
  });

  it('Ⓕ 틱 보고 — 활성 관리자 수 · 클레임 수', async () => {
    const world = fakeWorld();
    const f = await seedFixture(testPool());
    const apex = newApex();
    await pendingDomain(f.organizationId, `agents.${apex}`, apex);
    const report = await tick(world, [f.organizationId], MINUTE);
    expect(report.claims).toBe(1);
    expect(report.identitiesHeld).toBe(1);
  });

  it('Ⓖ 즉시 실행이 연결을 쥔 동안의 예약 틱(53300) → busy · 던지지 않음 · error 로그 0 · 행 불변', async () => {
    const world = fakeWorld();
    const f = await seedFixture(testPool());
    const apex = newApex();
    const { id } = await pendingDomain(f.organizationId, `agents.${apex}`, apex);
    const before = await provisioningPool().query('SELECT * FROM custom_domains WHERE id = $1', [id]);
    // 틱 롤 CONNECTION LIMIT 1 을 다른 쪽(즉시 실행)이 쥐고 있다 — 새 연결은 53300.
    const limitReached = (): Promise<never> => Promise.reject(Object.assign(new Error('too many connections for role "atmark_domain_tick"'), { code: '53300' }));
    const held = { query: limitReached, connect: limitReached, end: () => Promise.resolve() };
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      const direct = await runDomainTick({ pool: held as never, invoker: fakeInvoker(world), now: () => clock, scope: { organizationIds: [f.organizationId] } });
      expect(direct.outcome).toBe('busy');
      // 핸들러 경로(`{task:'domain-recheck'}`)도 던지지 않는다 — `domain.tick_failed` 가 없다.
      const viaHandler = await runDomainRecheckTask(() => Promise.resolve({ pool: held as never, invoker: fakeInvoker(world) }), () => clock);
      expect(viaHandler.outcome).toBe('busy');
    } finally {
      resetLogSink();
    }
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.filter((entry) => entry['level'] === 'error')).toEqual([]);
    expect(entries.filter((entry) => entry['event'] === 'domain.backlog' && entry['outcome'] === 'busy')).toHaveLength(2);
    expect(world.requests).toEqual([]);
    const after = await provisioningPool().query('SELECT * FROM custom_domains WHERE id = $1', [id]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('Ⓗ 즉시 실행은 domain-control 호출을 기다리는 동안 틱 롤 연결을 쥐지 않는다(유휴 반납)', async () => {
    const world = fakeWorld();
    const f = await seedFixture(testPool());
    const apex = newApex();
    const { id } = await pendingDomain(f.organizationId, `agents.${apex}`, apex);
    // 운영 조립과 같은 풀 설정(max 1 · 유휴 반납) — 연결마다 틱 롤.
    const provisionPool = new Pool({ connectionString: OWNER_URL, max: 1, idleTimeoutMillis: PROVISION_IDLE_RELEASE_MS });
    provisionPool.on('connect', (client: PoolClient) => {
      void client.query('SET ROLE atmark_domain_tick');
    });
    const inner = fakeInvoker(world);
    const openDuringInvoke: number[] = [];
    const slow = {
      async invoke(batch: Parameters<typeof inner.invoke>[0]) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        openDuringInvoke.push(provisionPool.totalCount);
        return inner.invoke(batch);
      },
    };
    try {
      expect(await provisionDomainNow({ pool: provisionPool as never, invoker: slow, now: () => clock }, id)).toBe('provisioned');
    } finally {
      await provisionPool.end();
    }
    expect(openDuringInvoke).toEqual([0]); // 호출을 기다리는 동안 열린 연결 0 — 예약 틱이 연결을 얻는다
    expect(await domainState(id)).toMatchObject({ claimed: true, tokens: 3, tag: id });
  });
});
