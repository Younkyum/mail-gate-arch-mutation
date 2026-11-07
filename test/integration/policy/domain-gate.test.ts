/**
 * 고객 도메인 관문 — 실제 Postgres 의 정책 소스 → 로더 → 엔진(ADR-0014 결정 7 · 계획 §3.7 · 단계 3).
 *
 *   ① **회귀**: 고객 도메인 행이 0 인 조직(= 지금 운영 전부)은 바인딩 = `atmark.ai`(platform) · 발신 도메인 입력 없음 · 도메인 카운터 0 이고, 판정이
 *      도메인 축을 지운 같은 입력과 **같다**(허용 · 위조 · 워밍업 · 한도).
 *   ② Stage 0 — 같은 조직의 verified 별칭은 통과, 정지(dkim_failed · reputation · operator)·제거 요청 → `domain_suspended`, plan_limit →
 *      `domain_plan_limit`. 같은 에이전트의 atmark.ai 대표는 영향 없음. ownership_lost 는 트리거가 별칭을 폐기하므로 Stage 1 `from_inactive`.
 *   ③ Stage 4 — 도메인 워밍업 캡(첫 발송 전 = 20 수신자), 조직 필터. 정책 소스의 도메인 수신자 질의가 부분 색인을 쓴다(EXPLAIN, L7).
 *   ⑤ 고객 도메인 대표 에이전트의 별칭(@atmark.ai · 다른 도메인) — 대표가 있을 때도 "대표 주소 없음" 일 때도 보내고 받는다 · 앵커는 잠든 채.
 *   ④ Stage 1 — 폐기한 자기 별칭은 `from_inactive`, 여권 위반 질의(`publisher.ts` 와 같은 문장)에 세지 않는다 · 모르는 주소는 `from_forgery`(센다).
 */

import { randomBytes } from 'node:crypto';

import { toAgentId } from '../../../src/db/schema';

import type { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { createPostgresInboundStore } from '../../../src/db/repositories/inbound-store';
import { BOUND_CUSTOM_DOMAINS_SQL, createPostgresPolicySource } from '../../../src/db/repositories/policy-source';
import { POLICY_VIOLATION_REASONS } from '../../../src/passport/attestations';
import { evaluate } from '../../../src/policy/engine';
import { loadEvaluationInput } from '../../../src/policy/policy-loader';
import type { Decision, EvaluationContext } from '../../../src/policy/types';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, seedMessage, testPool, type Fixture } from '../db/support/harness';
import { addAlias, enableCustomDomains, liftDomain, OWNER_URL, requestRemoval, retireAddress, seedDomainMessage, suspendDomain, verifiedCustomDomain } from './support';

const AVAILABLE = DATABASE_AVAILABLE && OWNER_URL.trim() !== '';
const FRIEND = 'friend@example.com';
const OLD_START = new Date('2026-01-01T00:00:00Z');

afterAll(async () => {
  if (AVAILABLE) await closeTestPool();
});

async function decide(pool: Pool, fixture: Fixture, from: string, recipients: readonly string[] = [FRIEND]): Promise<{ decision: Decision; ctx: EvaluationContext }> {
  const input = await loadEvaluationInput(createPostgresPolicySource(pool), {
    agentId: fixture.agentId,
    now: new Date(),
    traceId: null,
    thisAttemptCostCents: 0,
    release: null,
    attempt: { routeId: 'send', fromAddress: from, recipients: [...recipients], attachments: [], threadId: null, contentShape: 'other', dlp: [], pinnedTaint: false },
  });
  return { decision: evaluate(input.ctx, input.policy), ctx: input.ctx };
}

const reasonsOf = (decision: Decision): readonly string[] => decision.reasons;

describe.skipIf(!AVAILABLE)('① 회귀 — 고객 도메인 행 0 이면 판정이 단계 3 전과 같다', () => {
  it('바인딩 atmark.ai(platform) · sendingDomain null · 도메인 카운터 0 · 판정 = 도메인 축을 지운 입력의 판정(허용 · 위조 · 워밍업 · 일 한도)', async () => {
    const pool = testPool();
    const fresh = await seedFixture(pool, { allowlist: [FRIEND] }); // 첫 발송 전(워밍업 Day 0 = 20)
    const old = await seedFixture(pool, { allowlist: [FRIEND], sendingStartedAt: OLD_START });
    for (let i = 0; i < 20; i += 1) await seedMessage(pool, fresh.agentId, { status: 'sent', sentAt: new Date() });
    const cases: readonly (readonly [Fixture, string, string])[] = [
      [old, old.address, 'allowed'],
      [old, 'someone-else@atmark.ai', 'denied'],
      [fresh, fresh.address, 'denied'],
    ];
    for (const [fixture, from, verdict] of cases) {
      const { decision, ctx } = await decide(pool, fixture, from);
      expect([...ctx.agent.boundDomains]).toEqual([['atmark.ai', 'platform']]);
      expect(ctx.sendingDomain).toBeNull();
      expect(ctx.counters.domainRecipientsLastDay).toBe(0);
      expect(ctx.agent.inactiveAddresses).toEqual([]);
      expect(decision.verdict).toBe(verdict);
      expect(reasonsOf(decision).filter((reason) => reason.startsWith('domain_') || reason === 'from_inactive')).toEqual([]);
      const bare = evaluate({ ...ctx, agent: { ...ctx.agent, boundDomains: new Map() } }, (await loadPolicy(pool, fixture, from)).policy);
      expect(bare).toEqual(decision);
    }
    const source = await createPostgresPolicySource(pool).load({ agentId: old.agentId, recipients: [FRIEND], now: new Date(), threadId: null, releaseApprovalId: null });
    expect(source.customDomains).toEqual([]);
  });
});

async function loadPolicy(pool: Pool, fixture: Fixture, from: string): ReturnType<typeof loadEvaluationInput> {
  return loadEvaluationInput(createPostgresPolicySource(pool), {
    agentId: fixture.agentId,
    now: new Date(),
    traceId: null,
    thisAttemptCostCents: 0,
    release: null,
    attempt: { routeId: 'send', fromAddress: from, recipients: [FRIEND], attachments: [], threadId: null, contentShape: 'other', dlp: [], pinnedTaint: false },
  });
}

describe.skipIf(!AVAILABLE)('② Stage 0 — 발신 고객 도메인의 상태', () => {
  async function setup(): Promise<{ pool: Pool; fixture: Fixture; alias: string; domainId: string; domain: string }> {
    const pool = testPool();
    const fixture = await seedFixture(pool, { allowlist: [FRIEND], sendingStartedAt: OLD_START });
    const { id, domain } = await verifiedCustomDomain(fixture.organizationId);
    const alias = `bot-${randomBytes(3).toString('hex')}@${domain}`;
    await addAlias(fixture.agentId, alias);
    return { pool, fixture, alias, domainId: id, domain };
  }

  it('verified 별칭 → 허용 · 스냅샷에 도메인 상태 · 발신 도메인 입력', async () => {
    const { pool, fixture, alias, domain } = await setup();
    const { decision, ctx } = await decide(pool, fixture, alias);
    expect(decision.verdict).toBe('allowed');
    expect(ctx.agent.boundDomains.get(domain)).toBe('verified');
    expect(ctx.sendingDomain).toEqual({ domain, sendingStartedAt: null });
  });

  it.each([
    ['dkim_failed', 'domain_suspended'],
    ['reputation', 'domain_suspended'],
    ['operator', 'domain_suspended'],
    ['plan_limit', 'domain_plan_limit'],
  ] as const)('suspended(%s) → %s · 같은 에이전트의 atmark.ai 대표는 허용 · 풀면 다시 허용', async (reason, expected) => {
    const { pool, fixture, alias, domainId } = await setup();
    await suspendDomain(domainId, reason);
    expect(reasonsOf((await decide(pool, fixture, alias)).decision)).toEqual([expected]);
    expect((await decide(pool, fixture, fixture.address)).decision.verdict).toBe('allowed');
    await liftDomain(domainId);
    expect((await decide(pool, fixture, alias)).decision.verdict).toBe('allowed');
  });

  it('자발적 제거 요청(removed — 주소는 남는다) → domain_suspended', async () => {
    const { pool, fixture, alias, domainId } = await setup();
    await requestRemoval(domainId);
    const { decision, ctx } = await decide(pool, fixture, alias);
    expect(reasonsOf(decision)).toEqual(['domain_suspended']);
    expect(ctx.agent.boundAddresses).toContain(alias);
  });

  it('ownership_lost → 같은 트랜잭션에서 별칭이 폐기된다(D-H) → 그 From 은 Stage 1 from_inactive', async () => {
    const { pool, fixture, alias, domainId } = await setup();
    await suspendDomain(domainId, 'ownership_lost');
    const { decision, ctx } = await decide(pool, fixture, alias);
    expect(ctx.agent.inactiveAddresses).toContain(alias);
    expect(reasonsOf(decision)).toEqual(['from_inactive']);
  });
});

describe.skipIf(!AVAILABLE)('③ Stage 4 — 도메인 워밍업 캡 · 부분 색인', () => {
  it('첫 발송 전 도메인 캡 20 — 19 명까지 허용 · 20 명이면 다음 1 명이 domain_warmup_daily_cap · 조직 캡(1000)·atmark.ai 발신은 영향 없음', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, { allowlist: [FRIEND], sendingStartedAt: OLD_START });
    const { domain } = await verifiedCustomDomain(fixture.organizationId);
    const alias = `bot@${domain}`;
    await addAlias(fixture.agentId, alias);
    await seedDomainMessage(provisioningPool(), fixture.agentId, domain, 19);
    expect((await decide(pool, fixture, alias)).decision.verdict).toBe('allowed');
    await seedDomainMessage(provisioningPool(), fixture.agentId, domain, 1);
    const { decision, ctx } = await decide(pool, fixture, alias);
    expect(ctx.counters.domainRecipientsLastDay).toBe(20);
    expect(reasonsOf(decision)).toEqual(['domain_warmup_daily_cap']);
    expect(decision.verdict === 'denied' ? decision.retryAfterSeconds : null).toBeGreaterThan(0);
    // 같은 에이전트의 atmark.ai 대표 — 도메인 캡이 없다.
    expect((await decide(pool, fixture, fixture.address)).decision.verdict).toBe('allowed');
  });

  it('정책 소스의 도메인 수신자 질의(조직 필터 + from_domain)가 부분 색인 messages_custom_from_domain_created_idx 를 쓴다(L7)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, { allowlist: [FRIEND] });
    const { domain } = await verifiedCustomDomain(fixture.organizationId);
    // 표가 작으면 플래너가 어떤 색인이든 훑기로 고른다 — 운영처럼 atmark.ai 발신이 대부분인 표(2만 행 · 통계)를 한 트랜잭션 안에 만들고 되돌린다.
    const client = await provisioningPool().connect();
    try {
      await client.query('BEGIN');
      const thread = await client.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by, starter_address) VALUES ($1, 'agent', NULL) RETURNING id`, [fixture.agentId]);
      await client.query(
        `INSERT INTO messages (agent_id, direction, from_address_hash, from_domain, status, message_id_header, idempotency_key, request_hash,
                               recipient_count, sent_at, ses_message_id, thread_id)
         SELECT $1, 'outbound', md5(g::text) || md5(g::text), 'atmark.ai', 'sent', '<explain-' || g || '-' || $2 || '@atmark.ai>', gen_random_uuid()::text,
                md5(g::text) || md5(g::text), 1, now() - (g % 48) * interval '1 hour', 'ses-explain-' || $2 || '-' || g, $3
           FROM generate_series(1, 20000) g`,
        [fixture.agentId, randomBytes(4).toString('hex'), thread.rows[0]?.id],
      );
      await client.query('ANALYZE messages');
      const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${BOUND_CUSTOM_DOMAINS_SQL}`, [fixture.organizationId, [domain], new Date()]);
      const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
      // 부분 색인을 쓴다 — 바로(Index Scan) 또는 비트맵으로(Bitmap Index Scan — 같은 DB 의 다른 테스트가 고객 도메인 메시지를 쌓으면 플래너가 고른다).
      expect(text).toMatch(
        /(Index (Only )?Scan using messages_custom_from_domain_created_idx on messages m|Bitmap Index Scan on messages_custom_from_domain_created_idx)[\s\S]*Index Cond: \(from_domain = d\.domain\)/,
      );
      expect(text).not.toMatch(/Seq Scan on messages/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe.skipIf(!AVAILABLE)('④ Stage 1 — from_inactive 는 위반이 아니다', () => {
  it('폐기한 자기 별칭 → from_inactive(여권 위반 질의 0) · 모르는 주소 → from_forgery(1)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, { allowlist: [FRIEND], sendingStartedAt: OLD_START });
    const alias = `old-${randomBytes(3).toString('hex')}@atmark.ai`;
    await addAlias(fixture.agentId, alias);
    await retireAddress(alias);
    const { decision } = await decide(pool, fixture, alias);
    expect(reasonsOf(decision)).toEqual(['from_inactive']);
    // 감사 행으로 남겼을 때 여권 위반 질의(publisher.ts 와 같은 문장)가 세는지.
    const violations = async (reasons: readonly string[]): Promise<number> => {
      await provisioningPool().query(
        `INSERT INTO audit_logs (agent_id, decision, reasons, policy_version, policy_version_id, evaluated_at)
         VALUES ($1, 'denied', $2, 1, $3, now())`,
        [fixture.agentId, reasons, fixture.policyVersionId],
      );
      const counted = await provisioningPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_logs
          WHERE agent_id = $1 AND decision = 'denied' AND reasons && $2::text[] AND created_at > now() - make_interval(days => 90)`,
        [fixture.agentId, [...POLICY_VIOLATION_REASONS]],
      );
      return Number(counted.rows[0]?.n);
    };
    expect(await violations(['from_inactive'])).toBe(0);
    expect(reasonsOf((await decide(pool, fixture, 'nobody@atmark.ai')).decision)).toEqual(['from_forgery']);
    expect(await violations(['from_forgery'])).toBe(1);
  });
});

/** 폐기 시각을 31일 전으로 민다(재발급 30일 보류를 지난 상태 — 테스트 전용, 소유자 롤이 트리거를 잠시 끄고). */
async function backdateRetirement(address: string): Promise<void> {
  const client = await provisioningPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = replica`);
    await client.query(`UPDATE agent_addresses SET retired_at = now() - interval '31 days' WHERE address = $1 AND retired_at IS NOT NULL`, [address]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(!AVAILABLE)('⑤ 재발급된 주소를 옛 에이전트가 쓰면 from_forgery(보안 리뷰 M1)', () => {
  it('같은 조직 — 폐기 뒤 다른 에이전트에게 재발급되면 옛 에이전트의 From 은 from_inactive 가 아니라 from_forgery', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, { allowlist: [FRIEND], sendingStartedAt: OLD_START });
    const address = `shared-${randomBytes(3).toString('hex')}@atmark.ai`;
    await addAlias(fixture.agentId, address);
    await retireAddress(address);
    expect(reasonsOf((await decide(pool, fixture, address)).decision)).toEqual(['from_inactive']);
    await backdateRetirement(address);
    const other = toAgentId(randomBytes(16).toString('hex'));
    await provisioningPool().query(`INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, $3, 'active', 'free', 1000)`, [
      other,
      fixture.organizationId,
      `reissue-${other.slice(0, 8)}`,
    ]);
    await addAlias(other, address);
    const { decision, ctx } = await decide(pool, fixture, address);
    expect(ctx.agent.inactiveAddresses).not.toContain(address);
    expect(reasonsOf(decision)).toEqual(['from_forgery']);
  });

  it('다른 조직 — ownership_lost(별칭 폐기) → 30일 → 새 조직이 같은 주소를 받으면 옛 에이전트의 From 은 from_forgery', async () => {
    const pool = testPool();
    const oldOrg = await seedFixture(pool, { allowlist: [FRIEND], sendingStartedAt: OLD_START });
    const { id, domain } = await verifiedCustomDomain(oldOrg.organizationId);
    const address = `bot@${domain}`;
    await addAlias(oldOrg.agentId, address);
    await suspendDomain(id, 'ownership_lost');
    expect(reasonsOf((await decide(pool, oldOrg, address)).decision)).toEqual(['from_inactive']);
    await backdateRetirement(address);
    // 제거 사가가 identity 를 지운 뒤(202610061001 — 같은 도메인의 다음 행이 관리자가 되려면).
    await provisioningPool().query(`UPDATE custom_domains SET status = 'removed', suspended_reason = NULL, removed_at = now(), identity_deleted_at = now() WHERE id = $1`, [id]);
    const newOrg = await seedFixture(pool, { allowlist: [FRIEND] });
    await enableCustomDomains(newOrg.organizationId);
    const owner = provisioningPool();
    const row = await owner.query<{ id: string }>(
      `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4) RETURNING id`,
      [newOrg.organizationId, domain, domain.slice('agents.'.length), randomBytes(32).toString('base64url')],
    );
    await owner.query(`UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [row.rows[0]?.id]);
    await owner.query(`UPDATE custom_domains SET status = 'verified', verified_at = now() WHERE id = $1`, [row.rows[0]?.id]);
    await addAlias(newOrg.agentId, address);
    expect(reasonsOf((await decide(pool, oldOrg, address)).decision)).toEqual(['from_forgery']);
    expect((await decide(pool, newOrg, address)).decision.verdict).toBe('allowed');
  });
});

/**
 * ⑤ 고객 도메인을 대표로 고른 에이전트의 **별칭**(진윤겸 결정 2026-10 — @atmark.ai 별칭 허용). 잠든 앵커는 계속 막히고(`from_inactive` · 수신
 * 모르는 주소), @atmark.ai 별칭 · 다른 verified 도메인 별칭은 대표가 살아 있을 때도, 대표를 잃어 "주소 없음" 일 때도 보내고 받는다.
 */
describe.skipIf(!AVAILABLE)('⑤ 고객 도메인 대표 에이전트의 별칭 — 관문 · 수신 조회', () => {
  it('@atmark.ai 별칭 · 다른 도메인 별칭은 보내고 받는다 · 앵커는 잠듦 · 대표를 잃어도 별칭은 그대로', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, { allowlist: [FRIEND], sendingStartedAt: OLD_START });
    const owner = provisioningPool();
    const first = await verifiedCustomDomain(fixture.organizationId);
    const second = await verifiedCustomDomain(fixture.organizationId);
    const tag = randomBytes(3).toString('hex');
    const primary = `bot-${tag}@${first.domain}`;
    const atmarkAlias = `desk-${tag}@atmark.ai`;
    const otherAlias = `ops-${tag}@${second.domain}`;
    for (const address of [primary, atmarkAlias, otherAlias]) await addAlias(fixture.agentId, address);
    const primaryId = (await owner.query<{ id: string }>('SELECT id::text AS id FROM agent_addresses WHERE address = $1', [primary])).rows[0]?.id;
    await owner.query(`INSERT INTO agent_primary_changes (agent_id, address_id, cause) VALUES ($1, $2, 'owner')`, [fixture.agentId, primaryId]);
    const inbound = createPostgresInboundStore(pool);
    const found = async (address: string): Promise<string[]> => (await inbound.findAgentsByAddresses([address])).map((match) => match.agentId);

    // 대표가 살아 있을 때: 대표 · 두 별칭은 허용, 잠든 앵커는 from_inactive · 수신에서 모르는 주소.
    for (const from of [primary, atmarkAlias, otherAlias]) expect((await decide(pool, fixture, from)).decision.verdict, from).toBe('allowed');
    expect(reasonsOf((await decide(pool, fixture, fixture.address)).decision)).toEqual(['from_inactive']);
    for (const address of [primary, atmarkAlias, otherAlias]) expect(await found(address), address).toEqual([fixture.agentId]);
    expect(await found(fixture.address)).toEqual([]);

    // 대표의 도메인을 잃는다(ownership_lost → 그 도메인 별칭 폐기 → 유효 대표 NULL = "대표 주소 없음").
    await suspendDomain(first.id, 'ownership_lost');
    const loaded = await createPostgresPolicySource(pool).load({ agentId: fixture.agentId, recipients: [], now: new Date(), threadId: null, releaseApprovalId: null });
    expect(loaded.primaryAddress).toBeNull();
    expect(reasonsOf((await decide(pool, fixture, primary)).decision)).toEqual(['from_inactive']);
    for (const from of [atmarkAlias, otherAlias]) expect((await decide(pool, fixture, from)).decision.verdict, from).toBe('allowed');
    for (const address of [atmarkAlias, otherAlias]) expect(await found(address), address).toEqual([fixture.agentId]);
    expect(await found(primary)).toEqual([]);
    // 앵커는 여전히 잠들어 있다(소유자가 "@atmark.ai 주소 켜기" 를 하기 전까지).
    expect(reasonsOf((await decide(pool, fixture, fixture.address)).decision)).toEqual(['from_inactive']);
    expect(await found(fixture.address)).toEqual([]);
  });
});
