/**
 * 수신 — 고객 도메인(ADR-0014 결정 6 · 계획 §3.6 · 단계 3). 실제 Postgres(앱 롤) + 로컬 객체 저장소. 도메인 행은 소유자 롤로 단계 0 트리거를 지나 만든다.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 같은 조직의 verified · suspended(reputation · operator · plan_limit) → 저장.
 *   - suspended(dkim_failed) · 자발적 제거(removed — 주소는 남는다) → `rejected` ·
 *     `inbound_rejections(reason='domain_not_active')` 한 행 · `inbound_messages` 0 · 파싱 본문 없음(원문을 읽기 전에 거른다).
 *   - suspended(ownership_lost) — 트리거가 별칭을 폐기하므로 모르는 주소와 같다(`unknown_recipient`). **다른 조직이 같은 도메인을 쥔 뒤의 옛 주소**도
 *     같다 — D-H(202610021102)가 새 조직의 verifying 진입 때 폐기한다.
 *   - EXISTS 는 행을 늘리지 않는다(같은 조직에 removed 행 여럿 + 살아 있는 행).
 *   - atmark.ai 주소는 `domainActive` 가 늘 참(고객 도메인 행 0 인 운영의 수신 결말은 이전과 같다).
 */

import { randomBytes } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { createPostgresInboundStore } from '../../../src/db/repositories/inbound-store';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool } from '../db/support/harness';
import { addAlias, enableCustomDomains, liftDomain, OWNER_URL, requestRemoval, suspendDomain, verifiedCustomDomain } from '../policy/support';
import { consumerDeps, deliver, eml, newObjectStore, newSesMessageId, objectExists, rejectionPairs, storedCount } from './support';

const AVAILABLE = DATABASE_AVAILABLE && OWNER_URL.trim() !== '';

afterAll(async () => {
  if (AVAILABLE) await closeTestPool();
});

describe.skipIf(!AVAILABLE)('수신 — 고객 도메인 상태(domain_not_active)', () => {
  it('verified · suspended(reputation · operator · plan_limit) → 저장 · dkim_failed → domain_not_active(행 0 · 파싱 본문 없음) · 풀면 다시 저장', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const { id, domain } = await verifiedCustomDomain(fixture.organizationId);
    const alias = `inbox-${randomBytes(3).toString('hex')}@${domain}`;
    await addAlias(fixture.agentId, alias);
    const objects = newObjectStore();
    const deps = consumerDeps(pool, objects);
    const receive = async (): Promise<{ outcome: string; sesMessageId: string }> => {
      const sesMessageId = newSesMessageId();
      const outcome = await deliver(deps, eml({ from: 'x@example.com', to: alias }), { sesMessageId, recipients: [alias] });
      return { outcome, sesMessageId };
    };

    expect((await receive()).outcome).toBe('stored');
    for (const reason of ['plan_limit', 'reputation', 'operator'] as const) {
      await suspendDomain(id, reason);
      const { outcome, sesMessageId } = await receive();
      expect(outcome, reason).toBe('stored');
      expect(await storedCount(fixture.agentId, sesMessageId)).toBe(1);
      await liftDomain(id);
    }

    await suspendDomain(id, 'dkim_failed');
    const { outcome, sesMessageId } = await receive();
    expect(outcome).toBe('rejected');
    expect(await rejectionPairs(sesMessageId)).toEqual([['domain_not_active', [alias]]]);
    expect(await storedCount(fixture.agentId, sesMessageId)).toBe(0);
    expect(await objectExists(objects, deps.artifacts.parsedKeyFor(sesMessageId))).toBe(false);
    // 재전달해도 결말 한 행(멱등).
    expect(await deliver(deps, null, { sesMessageId, recipients: [alias] })).toBe('rejected');
    expect(await rejectionPairs(sesMessageId)).toHaveLength(1);

    await liftDomain(id);
    expect((await receive()).outcome).toBe('stored');
  });

  it('ownership_lost → 별칭이 폐기돼 모르는 주소(unknown_recipient) · 자발적 제거 → 주소는 남지만 domain_not_active', async () => {
    const pool = testPool();
    const deps = consumerDeps(pool, newObjectStore());

    const lost = await seedFixture(pool);
    const lostDomain = await verifiedCustomDomain(lost.organizationId);
    const lostAlias = `bot@${lostDomain.domain}`;
    await addAlias(lost.agentId, lostAlias);
    await suspendDomain(lostDomain.id, 'ownership_lost');
    const first = newSesMessageId();
    expect(await deliver(deps, eml({ from: 'x@example.com', to: lostAlias }), { sesMessageId: first, recipients: [lostAlias] })).toBe('rejected');
    expect(await rejectionPairs(first)).toEqual([['unknown_recipient', [lostAlias]]]);

    const removed = await seedFixture(pool);
    const removedDomain = await verifiedCustomDomain(removed.organizationId);
    const removedAlias = `bot@${removedDomain.domain}`;
    await addAlias(removed.agentId, removedAlias);
    await requestRemoval(removedDomain.id);
    const second = newSesMessageId();
    expect(await deliver(deps, eml({ from: 'x@example.com', to: removedAlias }), { sesMessageId: second, recipients: [removedAlias] })).toBe('rejected');
    expect(await rejectionPairs(second)).toEqual([['domain_not_active', [removedAlias]]]);
  });

  it('다른 조직이 같은 도메인을 쥔 뒤 옛 조직의 남은 주소 → D-H 가 폐기했으므로 unknown_recipient · 새 조직의 주소는 저장 · 한 통에 섞이면 각자', async () => {
    const pool = testPool();
    const deps = consumerDeps(pool, newObjectStore());
    const oldOrg = await seedFixture(pool);
    const { id, domain } = await verifiedCustomDomain(oldOrg.organizationId);
    const oldAlias = `legacy@${domain}`;
    await addAlias(oldOrg.agentId, oldAlias);
    await requestRemoval(id); // 자발적 제거 — 주소는 남는다(새 조직이 verifying 에 들어서는 순간 D-H 가 폐기한다 — 202610021102).

    const newOrg = await seedFixture(pool);
    await enableCustomDomains(newOrg.organizationId);
    const owner = provisioningPool();
    const registrable = domain.slice('agents.'.length);
    const row = await owner.query<{ id: string }>(
      `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4) RETURNING id`,
      [newOrg.organizationId, domain, registrable, randomBytes(32).toString('base64url')],
    );
    const newId = row.rows[0]?.id ?? '';
    await owner.query(`UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [newId]);
    await owner.query(`UPDATE custom_domains SET status = 'verified', verified_at = now() WHERE id = $1`, [newId]);
    const newAlias = `fresh@${domain}`;
    await addAlias(newOrg.agentId, newAlias);

    const sesMessageId = newSesMessageId();
    expect(await deliver(deps, eml({ from: 'x@example.com' }), { sesMessageId, recipients: [oldAlias, newAlias] })).toBe('stored');
    expect(await storedCount(newOrg.agentId, sesMessageId)).toBe(1);
    expect(await storedCount(oldOrg.agentId, sesMessageId)).toBe(0);
    // D-H(202610021102) — 새 조직의 verifying 진입이 옛 조직의 남은 별칭을 같은 트랜잭션에서 폐기했다 → 모르는 주소와 같다(같은 조직 행만 보는
    //   EXISTS 는 그 앞의 방어선 — 자발적 제거 뒤 같은 조직의 주소는 위 domain_not_active 사례가 본다).
    expect(await rejectionPairs(sesMessageId)).toEqual([['unknown_recipient', [oldAlias]]]);
  });

  it('EXISTS 는 행을 늘리지 않는다(removed 행 여럿 + 살아 있는 행) · atmark.ai 주소는 domainActive 가 늘 참', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await enableCustomDomains(fixture.organizationId);
    const owner = provisioningPool();
    const registrable = `cd${randomBytes(5).toString('hex')}.com`;
    const domain = `agents.${registrable}`;
    const insert = async (): Promise<string> => {
      const row = await owner.query<{ id: string }>(
        `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4) RETURNING id`,
        [fixture.organizationId, domain, registrable, randomBytes(32).toString('base64url')],
      );
      const id = row.rows[0]?.id ?? '';
      await owner.query(`UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [id]);
      await owner.query(`UPDATE custom_domains SET status = 'verified', verified_at = now() WHERE id = $1`, [id]);
      return id;
    };
    // 제거 요청 + 제거 사가 끝(identity 삭제 — 같은 도메인의 다음 행이 관리자가 되려면, 202610061001).
    for (let round = 0; round < 2; round += 1) await owner.query(`UPDATE custom_domains SET removal_requested_at = now(), identity_deleted_at = now() WHERE id = $1`, [await insert()]);
    await insert();
    const alias = `bot@${domain}`;
    await addAlias(fixture.agentId, alias);
    const matches = await createPostgresInboundStore(pool).findAgentsByAddresses([alias, fixture.address]);
    expect(matches.map((match) => [match.address, match.domainActive, match.organizationActive])).toEqual(
      [
        [alias, true, true],
        [fixture.address, true, true],
      ].sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)),
    );
  });
});
