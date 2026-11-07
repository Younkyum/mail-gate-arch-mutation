/**
 * `createPostgresPolicySource` — 실제 Postgres 위에서.
 *
 * 여기서 증명하려는 것은 SQL 이 도는가가 아니라 **카운터의 눈금**이다.
 * `orgRecipientsLastDay` 가 메시지 수로 채워지면 워밍업 캡이 최대 50배 느슨해지고,
 * 그것이 R22 가 지목한 유일한 제동장치다 — 단위 테스트로는 재현되지 않는 종류의 오류다.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { createPostgresPolicySource } from '../../../src/db/repositories/policy-source';
import { loadEvaluationInput, PolicySourceUnavailableError } from '../../../src/policy/policy-loader';
import { closeTestPool, DATABASE_AVAILABLE, newAgentId, provisioningPool, removeContactRules, seedContactRules, seedFixture, seedMessage, testPool } from './support/harness';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe.skipIf(!DATABASE_AVAILABLE)('PostgresPolicySource', () => {
  afterAll(closeTestPool);

  it('조직·에이전트·주소·정책·버전을 한 번에 읽는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const source = createPostgresPolicySource(pool);

    const result = await source.load({
      agentId: fixture.agentId,
      recipients: ['jinyounkyum@gmail.com'],
      now: new Date(),
      threadId: null,
      releaseApprovalId: null,
    });

    expect(result.agent.id).toBe(fixture.agentId);
    expect(result.organization.id).toBe(fixture.organizationId);
    expect(result.organization.billing_status).toBe('active');
    expect(result.addresses.map((row) => row.address)).toEqual([fixture.address]);
    expect(result.policy.current_version).toBe(1);
    expect(result.policyVersion.id).toBe(fixture.policyVersionId);
    expect(result.policyVersion.version).toBe(1);
  });

  it('nullable 컬럼은 `null` 로 온다 — `undefined` 가 섞이면 규약이 깨진다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);

    const result = await createPostgresPolicySource(pool).load({
      agentId: fixture.agentId,
      recipients: [],
      now: new Date(),
      threadId: null,
      releaseApprovalId: null,
    });

    expect(result.organization.sending_started_at).toBeNull();
    expect(result.organization.ses_tenant_id).toBeNull();
    expect(result.policyVersion.created_by).toBeNull();
  });

  it('에이전트가 없으면 빈 결과가 아니라 예외다 — 빈 정책은 "제약 없음"으로 읽힌다', async () => {
    const pool = testPool();
    await expect(
      createPostgresPolicySource(pool).load({ agentId: newAgentId(), recipients: [], now: new Date(), threadId: null, releaseApprovalId: null }),
    ).rejects.toBeInstanceOf(PolicySourceUnavailableError);
  });

  it('jsonb 는 객체로 온다 — 문자열로 오면 로더의 좁히기가 전부 실패한다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);

    const result = await createPostgresPolicySource(pool).load({
      agentId: fixture.agentId,
      recipients: [],
      now: new Date(),
      threadId: null,
      releaseApprovalId: null,
    });

    expect(result.policy.limits['per_minute']).toBe(10);
    expect(result.policy.config_json['max_attachment_bytes_total']).toBe(10_000_000);
  });

  it('정책 v2 — 목록은 현재 버전 스냅샷이 싣는다: 지운 규칙은 빠지고, 수신 규칙은 발신 판정에 들어오지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await seedContactRules(fixture.agentId, 'inbound', 'allow', ['inbound.only@example.com']);
    await seedContactRules(fixture.agentId, 'outbound', 'block', ['removed.example']);
    await removeContactRules(fixture.agentId, ['removed.example']);
    const input = await loadEvaluationInput(createPostgresPolicySource(pool), {
      agentId: fixture.agentId,
      now: new Date(),
      traceId: null,
      thisAttemptCostCents: 0,
      release: null,
      attempt: { routeId: 'send', fromAddress: fixture.address, recipients: ['jinyounkyum@gmail.com'], attachments: [], threadId: null, contentShape: 'other', dlp: [], pinnedTaint: false },
    });
    expect(input.policy.version).toBe(4);
    expect(input.policy.allowlist).toEqual(['jinyounkyum@gmail.com']);
    expect(input.policy.blocklist).toEqual([]);
  });

  describe('카운터', () => {
    it('에이전트 카운터는 **메시지 수**이고 윈도로 갈린다', async () => {
      const pool = testPool();
      const fixture = await seedFixture(pool);
      const now = new Date();

      // 방금 1건 · 30분 전 1건 · 10시간 전 1건.
      await seedMessage(pool, fixture.agentId, { status: 'sent', sentAt: now });
      await seedMessage(pool, fixture.agentId, {
        status: 'sent',
        sentAt: new Date(now.getTime() - 30 * MINUTE),
      });
      await seedMessage(pool, fixture.agentId, {
        status: 'sent',
        sentAt: new Date(now.getTime() - 10 * HOUR),
      });

      const result = await createPostgresPolicySource(pool).load({
        agentId: fixture.agentId,
        recipients: [],
        now,
        threadId: null,
        releaseApprovalId: null,
      });

      expect(result.counters.agentLastMinute).toBe(1);
      expect(result.counters.agentLastHour).toBe(2);
      expect(result.counters.agentLastDay).toBe(3);
    });

    it('`dispatching` 도 센다 — 전송 중인 건이 한도 밖에 있으면 동시성이 곧 한도 완화다', async () => {
      const pool = testPool();
      const fixture = await seedFixture(pool);
      await seedMessage(pool, fixture.agentId, { status: 'dispatching' });

      const result = await createPostgresPolicySource(pool).load({
        agentId: fixture.agentId,
        recipients: [],
        now: new Date(),
        threadId: null,
        releaseApprovalId: null,
      });

      expect(result.counters.agentLastMinute).toBe(1);
    });

    it('`pending` 은 세지 않는다 — 아직 보내기로 확정되지 않았다', async () => {
      const pool = testPool();
      const fixture = await seedFixture(pool);
      await seedMessage(pool, fixture.agentId, { status: 'pending' });

      const result = await createPostgresPolicySource(pool).load({
        agentId: fixture.agentId,
        recipients: [],
        now: new Date(),
        threadId: null,
        releaseApprovalId: null,
      });

      expect(result.counters.agentLastDay).toBe(0);
    });

    it('**orgRecipientsLastDay 의 눈금은 수신자 수다** (§3.3 · R22)', async () => {
      const pool = testPool();
      const fixture = await seedFixture(pool);
      const now = new Date();

      // 메시지 2건인데 수신자는 7명이다. 메시지 수를 채우는 구현이라면 2가 나온다.
      await seedMessage(pool, fixture.agentId, { status: 'sent', sentAt: now, recipientCount: 5 });
      await seedMessage(pool, fixture.agentId, { status: 'sent', sentAt: now, recipientCount: 2 });

      const result = await createPostgresPolicySource(pool).load({
        agentId: fixture.agentId,
        recipients: [],
        now,
        threadId: null,
        releaseApprovalId: null,
      });

      expect(result.counters.agentLastDay).toBe(2);
      expect(result.counters.orgRecipientsLastDay).toBe(7);
    });

    it('조직 캡은 **에이전트를 가로지른다** — 에이전트를 나눠도 평판은 조직 단위다', async () => {
      const pool = testPool();
      const first = await seedFixture(pool);
      const now = new Date();

      // 같은 조직에 두 번째 에이전트를 붙인다.
      const secondAgent = newAgentId();
      await provisioningPool().query(
        `INSERT INTO agents (id, organization_id, name, status) VALUES ($1, $2, $3, 'active')`,
        [secondAgent, first.organizationId, 'second'],
      );

      await seedMessage(pool, first.agentId, { status: 'sent', sentAt: now, recipientCount: 3 });
      await seedMessage(pool, secondAgent, { status: 'sent', sentAt: now, recipientCount: 4 });

      const result = await createPostgresPolicySource(pool).load({
        agentId: first.agentId,
        recipients: [],
        now,
        threadId: null,
        releaseApprovalId: null,
      });

      expect(result.counters.agentLastDay).toBe(1);
      expect(result.counters.orgRecipientsLastDay).toBe(7);
    });
  });

  describe('억제 목록', () => {
    it('요청 수신자와의 교집합만, 그리고 만료되지 않은 것만 돌려준다', async () => {
      const pool = testPool();
      const fixture = await seedFixture(pool);
      const now = new Date();

      await provisioningPool().query(
        `INSERT INTO suppression_entries (organization_id, address, domain, source, expires_at)
         VALUES ($1, 'bounced@example.com', 'example.com', 'bounce', NULL),
                ($1, 'expired@example.com', 'example.com', 'bounce', $2),
                ($1, 'other@example.com',   'example.com', 'manual', NULL)`,
        [fixture.organizationId, new Date(now.getTime() - HOUR)],
      );

      const result = await createPostgresPolicySource(pool).load({
        agentId: fixture.agentId,
        recipients: ['bounced@example.com', 'expired@example.com'],
        now,
        threadId: null,
        releaseApprovalId: null,
      });

      expect(result.suppressions.map((row) => row.address)).toEqual(['bounced@example.com']);
    });

    it('수신자가 없으면 조회하지 않는다', async () => {
      const pool = testPool();
      const fixture = await seedFixture(pool);
      const result = await createPostgresPolicySource(pool).load({
        agentId: fixture.agentId,
        recipients: [],
        now: new Date(),
        threadId: null,
        releaseApprovalId: null,
      });
      expect(result.suppressions).toEqual([]);
    });
  });
});
