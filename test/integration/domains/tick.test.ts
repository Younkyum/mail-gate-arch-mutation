/**
 * 확인 틱(ADR-0014 단계 4 · 계획 §3.3 · §3.4 수용 기준) — 실제 Postgres(틱 롤 권한) + 실제 domain-control 로직(가짜 SES · DNS).
 *
 *   ① pending → TXT → verifying → 사가 4단계 → DKIM → verified. identity 는 한 번만 만든다(태그 = 행 id).
 *   ② **사가 각 단계 직후 강제 실패** → 다음 틱들에서 같은 최종 상태 · 중복 생성 0(멱등).
 *   ③ 주소 발급 → 정책 동기화(sync_policy — 그 조직의 주소) → 다이제스트 · 표시 비움.
 *   ④ TXT 부재 1회 → 카운터 1 · 2회 연속 → suspended(ownership_lost) + 별칭 폐기 + 알림 + 정책 삭제(sync []).
 *   ⑤ DNS error 100틱 → 상태 · 카운터 불변. domain-control 이 없으면 아무것도 바꾸지 않는다.
 *   ⑥ 자발적 제거 → 제거 사가(policy → identity → done) · pending 72시간 만료는 SES 호출 0.
 *   ⑦ 평판 동결 → suspended(reputation) · 틱은 풀지 못한다 · 운영자 CLI `--unfreeze` 가 푼다(톰스톤은 transfer-race ⑤).
 *   ⑧ 요금제 강등(pro 한도 1) — 나중에 verified 된 것이 plan_limit.
 * 틱은 조직 범위(`scope`)로 돈다 — 같은 DB 를 쓰는 다른 파일의 행을 건드리지 않는다.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runDomainTick, type DomainTickReport } from '../../../src/domains/lifecycle';
import { runDomain } from '../../../scripts/admin/domain';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { addAlias } from '../policy/support';
import { currentRole, domainState, fakeInvoker, fakeWorld, newApex, OWNER_URL, opsFor, pendingDomain, tickPool, type FakeWorld } from './support';

const AVAILABLE = DATABASE_AVAILABLE && OWNER_URL.trim() !== '';
const MINUTE = 60_000;

describe.skipIf(!AVAILABLE)('확인 틱 — 수명주기 · 사가 · 정책 · 평판', () => {
  let pool: Pool;
  // 틱의 시계 — 각 테스트가 지금(DB 의 created_at 과 같은 시각대)에서 시작해 앞으로만 간다.
  let clock = new Date();

  beforeAll(async () => {
    pool = tickPool();
    expect(await currentRole(pool)).toBe('atmark_domain_tick');
  });

  beforeEach(() => {
    clock = new Date();
  });

  afterAll(async () => {
    await pool.end();
    await closeTestPool();
  });

  async function tick(world: FakeWorld, org: string, advanceMs = 31 * MINUTE): Promise<DomainTickReport> {
    clock = new Date(clock.getTime() + advanceMs);
    return runDomainTick({ pool: pool as never, invoker: fakeInvoker(world), now: () => clock, scope: { organizationIds: [org] } });
  }

  async function freshOrg(plan?: 'pro' | 'team'): Promise<Fixture> {
    return seedFixture(testPool(), plan === undefined ? {} : { plan });
  }

  /** TXT·MX 를 세우고 verified 까지 틱을 돌린다. 돌린 틱 수. */
  async function toVerified(world: FakeWorld, org: string, id: string, limit = 12): Promise<number> {
    for (let i = 1; i <= limit; i += 1) {
      await tick(world, org);
      if ((await domainState(id))['status'] === 'verified') return i;
    }
    throw new Error(`verified 에 이르지 못했다: ${JSON.stringify(await domainState(id))}`);
  }

  it('① pending → verifying → 사가 → verified · identity 한 번 · 태그 = 행 id', async () => {
    const world = fakeWorld();
    const f = await freshOrg();
    const apex = newApex();
    const { id, token } = await pendingDomain(f.organizationId, `agents.${apex}`, apex);
    await tick(world, f.organizationId);
    // one-shot — TXT 전에도 클레임 + identity(DKIM 토큰 셋이 곧바로 행에) · 상태는 pending.
    expect(await domainState(id)).toMatchObject({ status: 'pending', claimed: true, saga_step: 'identity', tag: id, tokens: 3 });
    world.txt.set(apex, new Set([token]));
    const ticks = await toVerified(world, f.organizationId, id);
    expect(ticks).toBe(4); // (mail_from + 진입) 1 + config_set 1 + policy 1 + DKIM 확인 1
    expect(await domainState(id)).toMatchObject({ status: 'verified', saga_step: 'done', tag: id, failures: 0, claimed: true, released: false });
    expect(world.sesCalls.filter((call) => call.startsWith('createIdentity'))).toHaveLength(1);
    expect(world.identities.get(`agents.${apex}`)?.tags['atmark:row']).toBe(id);
    expect(opsFor(world, id).slice(0, 6)).toEqual(['saga_step', 'check', 'saga_step', 'check', 'saga_step', 'saga_step']);
    // policy 단계(발신 권한)는 한 번 — 진입(두 번째 check) 뒤에만.
    const steps = world.requests.filter((request) => request.rowId === id && request.op === 'saga_step').map((request) => (request.op === 'saga_step' ? request.step : ''));
    expect(steps).toEqual(['identity', 'mail_from', 'config_set', 'policy']);
    // 확인 완료 알림 한 건(사건 키 = verified:<에폭초>) — 다음 확인은 더 적지 않는다.
    await tick(world, f.organizationId, 7 * 60 * MINUTE);
    const notices = await provisioningPool().query<{ kind: string; event_key: string }>('SELECT kind, event_key FROM domain_notices WHERE domain_id = $1', [id]);
    expect(notices.rows.map((row) => row.kind)).toEqual(['verified']);
    expect(notices.rows[0]?.event_key).toMatch(/^verified:[0-9]+$/);
  });

  it.each(['createIdentity', 'putMailFrom', 'putConfigurationSet', 'getIdentity'] as const)(
    '② 사가 중 %s 강제 실패 → 같은 최종 상태 · 중복 생성 0',
    async (op) => {
      const world = fakeWorld();
      const f = await freshOrg();
      const apex = newApex();
      const { id, token } = await pendingDomain(f.organizationId, `agents.${apex}`, apex);
      world.txt.set(apex, new Set([token]));
      await tick(world, f.organizationId); // → verifying
      world.failNext.set(op, 2); // 두 번 연속 실패
      await toVerified(world, f.organizationId, id, 20);
      expect(await domainState(id)).toMatchObject({ status: 'verified', saga_step: 'done', tag: id });
      expect(world.sesCalls.filter((call) => call.startsWith('createIdentity')).length).toBeLessThanOrEqual(1 + (op === 'createIdentity' ? 2 : 0));
      expect(world.identities.size).toBe(1);
      const identity = world.identities.get(`agents.${apex}`);
      expect([identity?.mailFrom, identity?.configSet, identity?.tags['atmark:row']]).toEqual([true, true, id]);
    },
  );

  it('③ 주소 발급 → sync_policy(그 조직의 주소) → 다이제스트 · 표시 비움 · 정책 문서에 주소', async () => {
    const world = fakeWorld();
    const f = await freshOrg();
    const apex = newApex();
    const domain = `agents.${apex}`;
    const { id, token } = await pendingDomain(f.organizationId, domain, apex);
    world.txt.set(apex, new Set([token]));
    await toVerified(world, f.organizationId, id);
    await addAlias(f.agentId, `bot@${domain}`);
    expect(await domainState(id)).toMatchObject({ sync_requested: true });
    await tick(world, f.organizationId, MINUTE);
    expect(await domainState(id)).toMatchObject({ sync_requested: false });
    const sync = world.requests.find((request) => request.rowId === id && request.op === 'sync_policy');
    expect(sync).toMatchObject({ addresses: [`bot@${domain}`] });
    expect(Object.values(world.identities.get(domain)?.policies ?? {}).join('')).toContain(`bot@${domain}`);
  });

  it('④ TXT 부재 1회 → 카운터 1 · 2회 연속 → ownership_lost + 별칭 폐기 + 알림 + 정책 삭제', async () => {
    const world = fakeWorld();
    const f = await freshOrg();
    const apex = newApex();
    const domain = `agents.${apex}`;
    const { id, token } = await pendingDomain(f.organizationId, domain, apex);
    world.txt.set(apex, new Set([token]));
    await toVerified(world, f.organizationId, id);
    await addAlias(f.agentId, `bot@${domain}`);
    await tick(world, f.organizationId, MINUTE); // 정책 동기화
    world.txt.set(apex, new Set());
    await tick(world, f.organizationId, 7 * 60 * MINUTE);
    expect(await domainState(id)).toMatchObject({ status: 'verified', failures: 1 });
    await tick(world, f.organizationId);
    expect(await domainState(id)).toMatchObject({ status: 'suspended', suspended_reason: 'ownership_lost', failures: 2 });
    const retired = await provisioningPool().query<{ retired: boolean }>('SELECT retired_at IS NOT NULL AS retired FROM agent_addresses WHERE address = $1', [`bot@${domain}`]);
    expect(retired.rows[0]?.retired).toBe(true);
    const notices = await provisioningPool().query<{ kind: string }>('SELECT kind FROM domain_notices WHERE domain_id = $1 ORDER BY created_at', [id]);
    expect(notices.rows.map((row) => row.kind)).toEqual(['verified', 'suspended']); // 확인 완료(첫 확인) → 정지
    await tick(world, f.organizationId, MINUTE); // 정지 = 정책 삭제(sync [])
    expect(Object.keys(world.identities.get(domain)?.policies ?? {})).toEqual([]);
    expect(await domainState(id)).toMatchObject({ sync_requested: false });
    // TXT 를 되돌리면 자동 복귀 + 확인 완료 알림(사건 키 = recovered:<에폭초> — 첫 확인과 다른 회차).
    world.txt.set(apex, new Set([token]));
    await tick(world, f.organizationId, 7 * 60 * MINUTE);
    expect(await domainState(id)).toMatchObject({ status: 'verified', suspended_reason: null });
    const after = await provisioningPool().query<{ kind: string; event_key: string }>('SELECT kind, event_key FROM domain_notices WHERE domain_id = $1 ORDER BY created_at', [id]);
    expect(after.rows.map((row) => row.kind)).toEqual(['verified', 'suspended', 'verified']);
    expect(after.rows[2]?.event_key).toMatch(/^recovered:[0-9]+$/);
  });

  it('⑤ DNS error 100틱 → 상태 · 카운터 불변 · domain-control 이 없으면 아무것도 바꾸지 않는다', async () => {
    const world = fakeWorld();
    const f = await freshOrg();
    const apex = newApex();
    const { id, token } = await pendingDomain(f.organizationId, `agents.${apex}`, apex);
    world.txt.set(apex, new Set([token]));
    await toVerified(world, f.organizationId, id);
    world.txt.set(apex, 'error');
    for (let i = 0; i < 100; i += 1) await tick(world, f.organizationId, 7 * 60 * MINUTE);
    expect(await domainState(id)).toMatchObject({ status: 'verified', suspended_reason: null, failures: 0 });

    const before = await provisioningPool().query('SELECT * FROM custom_domains WHERE id = $1', [id]);
    world.unavailable = true;
    const report = await tick(world, f.organizationId, 7 * 60 * MINUTE);
    expect(report.outcome).toBe('unavailable');
    const after = await provisioningPool().query('SELECT * FROM custom_domains WHERE id = $1', [id]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  }, 60_000);

  it('⑥ 자발적 제거 → 제거 사가(policy → identity → done) · pending 72시간 만료는 SES 호출 0', async () => {
    const world = fakeWorld();
    const f = await freshOrg();
    const apex = newApex();
    const domain = `agents.${apex}`;
    const { id, token } = await pendingDomain(f.organizationId, domain, apex);
    world.txt.set(apex, new Set([token]));
    await toVerified(world, f.organizationId, id);
    await provisioningPool().query('UPDATE custom_domains SET removal_requested_at = now() WHERE id = $1', [id]);
    await tick(world, f.organizationId, MINUTE);
    await tick(world, f.organizationId, MINUTE);
    expect(await domainState(id)).toMatchObject({ status: 'removed', removal_step: 'done' });
    expect(world.identities.has(domain)).toBe(false);
    expect(opsFor(world, id).filter((op) => op === 'sync_policy' || op === 'audit_policy').length).toBeGreaterThan(0); // verified 동안만
    const lastPolicyOp = opsFor(world, id).lastIndexOf('audit_policy');
    expect(opsFor(world, id).slice(lastPolicyOp + 1)).toEqual(['remove_step', 'remove_step']);

    const g = await freshOrg();
    const apex2 = newApex();
    const expiring = await pendingDomain(g.organizationId, `agents.${apex2}`, apex2);
    const calls = world.sesCalls.length;
    await tick(world, g.organizationId, 73 * 60 * MINUTE);
    expect(await domainState(expiring.id)).toMatchObject({ status: 'removed', removal_step: 'done' });
    expect(world.sesCalls.length).toBe(calls);
    expect(opsFor(world, expiring.id).filter((op) => op !== 'check')).toEqual([]);
  });

  it('⑦ 평판 동결 → suspended(reputation) · 틱은 풀지 못한다 · 운영자 --unfreeze 가 푼다', async () => {
    const world = fakeWorld();
    const f = await freshOrg();
    const apex = newApex();
    const domain = `agents.${apex}`;
    const { id, token } = await pendingDomain(f.organizationId, domain, apex);
    world.txt.set(apex, new Set([token]));
    await toVerified(world, f.organizationId, id);
    // bounce 12 / 시도 40 → 윌슨 하한 ≈ 18% ≥ 3%(메시지를 적게 — 같은 DB 의 플래너 통계를 덜 흔든다). 처음엔 일시 bounce 로 적는다.
    const owner = provisioningPool();
    const transientOnly = true;
    for (let i = 0; i < 40; i += 1) {
      const message = await owner.query<{ id: string }>(
        `WITH thread AS (INSERT INTO threads (agent_id, started_by, starter_address) VALUES ($1, 'agent', NULL) RETURNING id)
         INSERT INTO messages (agent_id, direction, from_address_hash, from_domain, status, message_id_header, idempotency_key, request_hash,
                               recipient_count, sent_at, ses_message_id, thread_id)
         VALUES ($1, 'outbound', $2, $3, 'sent', $4, $5, $2, 1, now(), $6, (SELECT id FROM thread)) RETURNING id`,
        [f.agentId, 'a'.repeat(64), domain, `<${randomUUID()}@${domain}>`, randomUUID(), `ses-${randomUUID()}`],
      );
      await owner.query(
        `INSERT INTO ses_events (message_id, event_type, event_at, dedupe_key, bounce_type) VALUES ($1, $2, now(), encode(sha256(convert_to($3, 'UTF8')), 'hex'), $4)`,
        [message.rows[0]?.id, i < 12 ? 'bounce' : 'delivery', randomUUID(), i < 12 ? (transientOnly ? 'transient' : 'permanent') : null],
      );
    }
    // 일시(transient) bounce 만이면 얼지 않는다(#13 M3) — 같은 수를 영구로 바꾸면 언다.
    expect((await tick(world, f.organizationId, 7 * 60 * MINUTE)).reputation).toBe(0);
    expect(await domainState(id)).toMatchObject({ status: 'verified' });
    await owner.query(`UPDATE ses_events SET bounce_type = 'permanent' WHERE event_type = 'bounce' AND bounce_type = 'transient' AND message_id IN (SELECT id FROM messages WHERE from_domain = $1)`, [domain]);
    const report = await tick(world, f.organizationId, 7 * 60 * MINUTE);
    expect(report.reputation).toBe(1);
    expect(await domainState(id)).toMatchObject({ status: 'suspended', suspended_reason: 'reputation' });
    // DNS 가 멀쩡해도 틱은 풀지 못한다.
    for (let i = 0; i < 3; i += 1) await tick(world, f.organizationId, 7 * 60 * MINUTE);
    expect(await domainState(id)).toMatchObject({ status: 'suspended', suspended_reason: 'reputation' });
    // 운영자 해제(소유자 롤).
    const io = { out: () => undefined, err: () => undefined, interactive: false, ask: () => Promise.resolve('') };
    await runDomain(owner, { target: 'local' } as never, { kind: 'unfreeze', domainId: id, yes: true }, { env: {}, io });
    expect(await domainState(id)).toMatchObject({ status: 'verified', suspended_reason: null });
  });

  it('⑧ 요금제 강등 — pro(한도 1)에 verified 둘 → 나중에 verified 된 것이 plan_limit · 알림', async () => {
    const world = fakeWorld();
    const f = await freshOrg('pro');
    const ids: string[] = [];
    for (const label of ['first', 'second']) {
      const apex = newApex();
      const { id, token } = await pendingDomain(f.organizationId, `${label}.${apex}`, apex);
      world.txt.set(apex, new Set([token]));
      await toVerified(world, f.organizationId, id);
      ids.push(id);
    }
    const report = await tick(world, f.organizationId, MINUTE);
    expect(report.planLimit).toBe(1);
    expect(await domainState(ids[0] ?? '')).toMatchObject({ status: 'verified' });
    expect(await domainState(ids[1] ?? '')).toMatchObject({ status: 'suspended', suspended_reason: 'plan_limit' });
    const notices = await provisioningPool().query<{ kind: string }>('SELECT kind FROM domain_notices WHERE domain_id = $1 ORDER BY created_at', [ids[1]]);
    expect(notices.rows.map((row) => row.kind)).toEqual(['verified', 'suspended']); // 확인 완료(첫 확인) → 정지
  });

  it('⑨ 예산 — pending 8개가 기한이면 한 틱은 P(요청 8 = 행 넷 × 2)만 · 다음 틱이 잇는다 · 밀린 수 지표', async () => {
    const world = fakeWorld();
    const f = await freshOrg();
    const g = await freshOrg();
    const rows: string[] = [];
    const orgs: string[] = [];
    for (const org of [f, g]) {
      for (let i = 0; i < 2; i += 1) {
        const apex = newApex();
        rows.push((await pendingDomain(org.organizationId, `agents.${apex}`, apex)).id);
      }
    }
    // 조직당 pending 상한 2(DB) — 조직 넷으로 8개.
    for (let k = 0; k < 2; k += 1) {
      const org = await freshOrg();
      for (let i = 0; i < 2; i += 1) {
        const apex = newApex();
        rows.push((await pendingDomain(org.organizationId, `agents.${apex}`, apex)).id);
      }
      orgs.push(org.organizationId);
    }
    orgs.push(f.organizationId, g.organizationId);
    clock = new Date(clock.getTime() + MINUTE);
    const first = await runDomainTick({ pool: pool as never, invoker: fakeInvoker(world), now: () => clock, scope: { organizationIds: orgs } });
    expect(first.requests).toBe(8); // 관리자 행마다 saga_step(identity) + check
    expect(first.claims).toBe(8); // 클레임은 DB 만(예산 밖) — 도메인이 모두 달라 여덟 다 관리자
    expect(new Set(world.requests.map((request) => request.rowId)).size).toBe(4);
    const second = await runDomainTick({ pool: pool as never, invoker: fakeInvoker(world), now: () => clock, scope: { organizationIds: orgs } });
    expect(second.requests).toBe(8); // 나머지 넷(앞 넷은 사가가 나아가 next_check_at 이 이번 틱 시각 — 더 오래 기다린 행이 먼저)
    expect(new Set(world.requests.map((request) => request.rowId))).toEqual(new Set(rows));
    expect(first.dueBacklog).toBe(0);
  });

  it('⑩ 예산이 바닥나면(#13 L6) — 호출하지 않고 단계를 미룬다 · 다음 틱이 잇는다', async () => {
    const world = fakeWorld();
    const f = await freshOrg();
    const apex = newApex();
    const { id } = await pendingDomain(f.organizationId, `agents.${apex}`, apex);
    clock = new Date(clock.getTime() + MINUTE);
    const starved = await runDomainTick({ pool: pool as never, invoker: fakeInvoker(world), now: () => clock, scope: { organizationIds: [f.organizationId] }, budgetMs: 0 });
    expect(starved.deferred).toEqual(['claim', 'batch', 'reputation']);
    expect(world.requests).toEqual([]);
    expect(await domainState(id)).toMatchObject({ claimed: false });
    await tick(world, f.organizationId, MINUTE);
    expect(opsFor(world, id)).toEqual(['saga_step', 'check']);
  });
});
