/**
 * 고객 도메인 계약의 DB 가드(ADR-0014 단계 0 — 202609291100 · 1120 · 1130, 보안·critic 리뷰 반영판) — 실제 Postgres 위에서.
 *
 *   ① 행 만들기: 기능 허용 목록(P0A07) · pending 으로만 · 모양(100자 · apex · atmark.ai · R-LDH · 끝 점 · 토큰) · 조직 pending 2 · 천장 20(P0A03).
 *   ② 상태 기계: 허용 전이만 · removed 종착 · 식별 칸 불변 · 지우기 거부 · 발신 가능 상태를 떠나면 정책 동기화 요청.
 *   ③ 쓰는 롤(보안 M2 · M3): admin 은 상태 칸 권한이 없고 제거 요청만(쓰기 1회 → 그 자리에서 removed, 주소는 남는다) · 틱 롤은 평판·운영자
 *      정지를 풀지 못하고 사유를 약하게 바꾸지 못한다 · 소유자 롤(운영자 CLI)은 푼다.
 *   ④ 교차 조직 apex · 겹치는 도메인(P0A02) — 옛 행이 removed 가 되면 넘어간다(양도 순서).
 *   ⑤ 주소 가드: 별칭만(P0A06) · 같은 조직의 verified 도메인과 정확히(P0A05) · 도메인별 예약(TS = SQL) · 천장 = 도메인 길이의 함수(TS = SQL) ·
 *      발급이 정책 동기화를 요청.
 *   ⑥ **증명된 소유권 상실 · 양도(D-H)**: ownership_lost 로 들어서는 전이가 같은 트랜잭션에서 옛 조직의 활성 별칭을 폐기한다 → B 는 30일 동안
 *      그 주소를 받지 못한다(보류) · A 는 더 못 만든다 · 새 주인의 신뢰 근거는 새 행부터.
 *   ⑦ 워밍업 시계(보낸 메시지만, 한 번) · 알림 집기(DEFINER, 수신자 · 임대 · 끝난 알림 불변) · 런타임 롤 권한.
 *   ⑧ 투명성 outbox — 스냅샷에 도메인 이름이 없다 · 상태가 바뀔 때만(트리거가 바꾼 제거 요청 포함).
 *   ⑨ 정책 소스의 도메인 행 고르기(M10).
 *
 * `TEST_DATABASE_URL`(앱 롤) / `TEST_MIGRATION_DATABASE_URL`(소유자 롤 — 로컬은 슈퍼유저라 `SET LOCAL ROLE` 로 틱·admin 롤을 흉내 낸다)이 없으면
 * 건너뛴다. ⑨ 만 커밋한다(새 조직만 쓴다).
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hostedEvidenceSql } from '../../../src/db/repositories/hosted-evidence';
import { createPostgresPolicySource } from '../../../src/db/repositories/policy-source';
import { customDomainAddressCeiling, DOMAIN_SQLSTATES, DOMAIN_TICK_ROLE } from '../../../src/domains/contract';
import { GLOBAL_RESERVED_LOCAL_PARTS, RESERVED_LOCAL_PARTS } from '../../../src/identity/address';
import { ADMIN_ROLE_URL, adminRolePool } from '../admin/support';
import {
  asRole,
  closeTestPool,
  DATABASE_AVAILABLE,
  hex64,
  provisioningPool,
  rolledBack,
  seedFixture,
  stateOf,
  testPool,
  type Fixture,
} from './support/harness';

const ownerUrl = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
const AVAILABLE = DATABASE_AVAILABLE && ownerUrl.trim() !== '' && ADMIN_ROLE_URL.trim() !== '';

const token = (): string => randomBytes(32).toString('base64url');
const apex = (): string => `cd${randomBytes(5).toString('hex')}.com`;

type Db = Pick<PoolClient, 'query'>;

async function poolState(pool: Pool, sql: string, params: readonly unknown[] = []): Promise<string> {
  try {
    await pool.query(sql, [...params]);
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
}

const enableFeature = (db: Db, organizationId: string): Promise<unknown> =>
  db.query(`INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, 'custom_domains', 'test') ON CONFLICT DO NOTHING`, [organizationId]);

async function insertDomain(db: Db, organizationId: string, domain: string, registrable: string): Promise<string> {
  const row = await db.query<{ id: string }>(
    `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4) RETURNING id`,
    [organizationId, domain, registrable, token()],
  );
  return row.rows[0]?.id ?? '';
}

/** pending → verifying → verified(틱이 하는 순서 그대로). */
async function verifyDomain(db: Db, id: string): Promise<void> {
  await db.query(`UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [id]);
  await db.query(`UPDATE custom_domains SET status = 'verified', verified_at = now() WHERE id = $1`, [id]);
}

async function verifiedDomain(db: Db, organizationId: string): Promise<{ id: string; domain: string; registrable: string }> {
  const registrable = apex();
  const domain = `agents.${registrable}`;
  const id = await insertDomain(db, organizationId, domain, registrable);
  await verifyDomain(db, id);
  return { id, domain, registrable };
}

/** removed + 제거 사가 끝(identity 삭제) — one-shot 이후 관리자 행은 identity 를 지워야(또는 넘겨야) 같은 도메인의 다음 행이 관리자가 된다(202610061001). */
async function removeDomain(db: Db, id: string): Promise<void> {
  await db.query(`UPDATE custom_domains SET status = 'removed', suspended_reason = NULL, removed_at = now(), identity_deleted_at = now() WHERE id = $1`, [id]);
}

const suspend = (db: Db, id: string, reason: string): Promise<unknown> =>
  db.query(`UPDATE custom_domains SET status = 'suspended', suspended_reason = $2, suspended_at = now() WHERE id = $1`, [id, reason]);

const addAlias = (client: PoolClient, agentId: string, address: string, primary = false): Promise<string> =>
  stateOf(client, `INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, split_part($2, '@', 2), $3)`, [agentId, address, primary]);

const retiredAt = async (db: Db, address: string): Promise<(Date | null)[]> =>
  (await db.query<{ at: Date | null }>('SELECT retired_at AS at FROM agent_addresses WHERE address = $1 ORDER BY created_at', [address])).rows.map((row) => row.at);

describe.skipIf(!AVAILABLE)('고객 도메인 DB 가드 (202609291100 · 1120 · 1130)', () => {
  let app: Pool;
  let admin: Pool;
  let a: Fixture;
  let b: Fixture;

  beforeAll(async () => {
    app = testPool();
    admin = adminRolePool();
    a = await seedFixture(app);
    b = await seedFixture(app);
    await enableFeature(provisioningPool(), a.organizationId);
    await enableFeature(provisioningPool(), b.organizationId);
  });

  afterAll(async () => {
    await admin.end();
    await closeTestPool();
  });

  it('① 기능 허용 목록 · pending 으로만 · 모양 CHECK(100자) · 조직 pending 2 · 천장 20', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const outsider = await seedFixture(app);
      const registrable = apex();
      expect(
        await stateOf(client, `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4)`, [
          outsider.organizationId,
          `agents.${registrable}`,
          registrable,
          token(),
        ]),
      ).toBe(DOMAIN_SQLSTATES.featureNotEnabled);
      expect(
        await stateOf(client, `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token, status) VALUES ($1, $2, $3, $4, 'verified')`, [
          a.organizationId,
          `agents.${registrable}`,
          registrable,
          token(),
        ]),
      ).toBe('23514');
      const long = `${'a'.repeat(50)}.${'b'.repeat(50)}.${registrable}`; // 100 자 초과
      expect(long.length).toBeGreaterThan(100);
      const bad: readonly (readonly [string, string, string])[] = [
        [registrable, registrable, token()], // apex
        [`agents.${registrable}.`, registrable, token()], // 끝 점
        ['agents.atmark.ai', 'atmark.ai', token()],
        [`xn--pple-43d.${registrable}`, registrable, token()],
        [`agents.${registrable}`, 'other.com', token()], // 접미 관계 아님
        [`Agents.${registrable}`, registrable, token()], // 대문자
        [`agents.${registrable}`, registrable, 'short'], // 토큰 모양
        ['agents.10.0.0.1', '0.1', token()],
        [long, registrable, token()],
      ];
      for (const [domain, reg, challenge] of bad) {
        expect(
          await stateOf(client, `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4)`, [
            a.organizationId,
            domain,
            reg,
            challenge,
          ]),
          domain,
        ).toBe('23514');
      }
      await insertDomain(client, a.organizationId, `a.${registrable}`, registrable);
      await insertDomain(client, a.organizationId, `b.${registrable}`, registrable);
      expect(
        await stateOf(client, `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4)`, [
          a.organizationId,
          `c.${registrable}`,
          registrable,
          token(),
        ]),
      ).toBe(DOMAIN_SQLSTATES.domainLimit);
    });
    await rolledBack(provisioningPool(), async (client) => {
      const registrable = apex();
      for (let index = 0; index < 20; index += 1) {
        const id = await insertDomain(client, b.organizationId, `n${String(index)}.${registrable}`, registrable);
        await verifyDomain(client, id);
      }
      expect(
        await stateOf(client, `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4)`, [
          b.organizationId,
          `n20.${registrable}`,
          registrable,
          token(),
        ]),
      ).toBe(DOMAIN_SQLSTATES.domainLimit);
    });
  });

  it('② 허용 전이만 · removed 종착 · 식별 칸 불변 · 지우기 거부 · 발신 가능 상태를 떠나면 정책 동기화 요청', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const registrable = apex();
      const id = await insertDomain(client, a.organizationId, `agents.${registrable}`, registrable);
      expect(await stateOf(client, `UPDATE custom_domains SET status = 'verified', verified_at = now(), txt_verified_at = now() WHERE id = $1`, [id])).toBe('23514');
      expect(await stateOf(client, `UPDATE custom_domains SET status = 'verifying' WHERE id = $1`, [id])).toBe('23514');
      await verifyDomain(client, id);
      expect(await stateOf(client, `UPDATE custom_domains SET status = 'pending' WHERE id = $1`, [id])).toBe('23514');
      expect(await stateOf(client, `UPDATE custom_domains SET status = 'suspended', suspended_at = now() WHERE id = $1`, [id])).toBe('23514');
      const marker = async (): Promise<Date | null | undefined> =>
        (await client.query<{ at: Date | null }>('SELECT policy_sync_requested_at AS at FROM custom_domains WHERE id = $1', [id])).rows[0]?.at;
      expect(await marker()).toBeNull();
      await suspend(client, id, 'dkim_failed');
      expect(await marker()).not.toBeNull();
      for (const [column, value] of [
        ['domain', `other.${registrable}`],
        ['registrable_domain', 'x.com'],
        ['challenge_token', token()],
        ['organization_id', b.organizationId],
      ] as const) {
        expect(await stateOf(client, `UPDATE custom_domains SET ${column} = $2 WHERE id = $1`, [id, value]), column).toBe('23514');
      }
      expect(await stateOf(client, 'DELETE FROM custom_domains WHERE id = $1', [id])).toBe('23514');
      await removeDomain(client, id);
      for (const status of ['verified', 'suspended', 'pending', 'verifying']) {
        expect(await stateOf(client, `UPDATE custom_domains SET status = $2 WHERE id = $1`, [id, status]), status).toBe('23514');
      }
      expect(await insertDomain(client, a.organizationId, `agents.${registrable}`, registrable)).not.toBe('');
    });
  });

  it('③ 쓰는 롤 — admin 은 제거 요청만(그 자리에서 removed · 주소는 남는다) · 틱은 평판·운영자 정지를 못 풀고 사유를 약하게 못 바꾼다', async () => {
    for (const column of ['status', 'txt_verified_at', 'verified_at', 'suspended_reason', 'suspended_at', 'saga_step', 'superseded_by', 'sending_started_at']) {
      expect(await poolState(admin, `UPDATE custom_domains SET ${column} = ${column} WHERE false`), column).toBe('42501');
    }
    for (const column of ['removal_requested_at', 'last_manual_check_at', 'next_check_at']) {
      expect(await poolState(admin, `UPDATE custom_domains SET ${column} = ${column} WHERE false`), column).toBe('ok');
    }
    await rolledBack(provisioningPool(), async (client) => {
      const d = await verifiedDomain(client, a.organizationId);
      expect(await addAlias(client, a.agentId, `stay@${d.domain}`)).toBe('ok');
      await asRole(client, 'atmark_admin', async () => {
        await client.query('UPDATE custom_domains SET removal_requested_at = now() WHERE id = $1', [d.id]);
        // 쓰기 1회 — 트랜잭션 안의 now() 는 같은 값이라 다른 시각으로 다시 적어 본다.
        expect(await stateOf(client, `UPDATE custom_domains SET removal_requested_at = now() + interval '1 second' WHERE id = $1`, [d.id])).toBe('23514');
      });
      const row = await client.query<{ status: string; removed: boolean }>('SELECT status, removed_at IS NOT NULL AS removed FROM custom_domains WHERE id = $1', [
        d.id,
      ]);
      expect(row.rows[0]).toEqual({ status: 'removed', removed: true });
      expect(await retiredAt(client, `stay@${d.domain}`)).toEqual([null]); // 자발적 제거는 주소를 남긴다
    });
    await rolledBack(provisioningPool(), async (client) => {
      const d = await verifiedDomain(client, a.organizationId);
      await asRole(client, DOMAIN_TICK_ROLE, async () => {
        await suspend(client, d.id, 'dkim_failed');
        expect(await stateOf(client, `UPDATE custom_domains SET suspended_reason = 'plan_limit' WHERE id = $1`, [d.id])).toBe('23514'); // 약해짐
        expect(await stateOf(client, `UPDATE custom_domains SET suspended_reason = 'reputation' WHERE id = $1`, [d.id])).toBe('ok'); // 세짐
        expect(await stateOf(client, `UPDATE custom_domains SET status = 'verified', suspended_reason = NULL WHERE id = $1`, [d.id])).toBe('42501');
      });
      // 소유자 롤(운영자 CLI)은 푼다.
      expect(await stateOf(client, `UPDATE custom_domains SET status = 'verified', suspended_reason = NULL WHERE id = $1`, [d.id])).toBe('ok');
      await asRole(client, DOMAIN_TICK_ROLE, async () => {
        await suspend(client, d.id, 'dkim_failed');
        expect(await stateOf(client, `UPDATE custom_domains SET status = 'verified', suspended_reason = NULL WHERE id = $1`, [d.id])).toBe('ok'); // 자동 복귀
      });
    });
  });

  it('④ 교차 조직 apex · 겹치는 도메인은 P0A02 · pending 은 된다 · 옛 행이 removed 가 되면 넘어간다', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const held = await verifiedDomain(client, a.organizationId);
      const sibling = await insertDomain(client, b.organizationId, `bots.${held.registrable}`, held.registrable);
      const toVerifying = (id: string): Promise<string> =>
        stateOf(client, `UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [id]);
      expect(await toVerifying(sibling)).toBe(DOMAIN_SQLSTATES.registrableTaken);
      await removeDomain(client, sibling);
      // PSL 이 바뀌어 apex 판정이 달라져도 — 하위 도메인을 다른 apex 로 적어도 겹침으로 막는다(보안 L2).
      const nested = await insertDomain(client, b.organizationId, `deep.${held.domain}`, held.domain);
      expect(await toVerifying(nested)).toBe(DOMAIN_SQLSTATES.registrableTaken);
      await removeDomain(client, nested);
      const same = await insertDomain(client, b.organizationId, held.domain, held.registrable);
      expect(await toVerifying(same)).toBe(DOMAIN_SQLSTATES.registrableTaken);
      await suspend(client, held.id, 'ownership_lost');
      // 양도 채택 불변식(202610021102) — 새 행이 먼저 TXT 를 통과해야 옛 행이 그것을 `superseded_by` 로 가리킬 수 있다.
      await client.query('UPDATE custom_domains SET txt_verified_at = now() WHERE id = $1', [same]);
      // 양도는 identity 관리권도 같은 UPDATE 에서 넘긴다(202610061000 — 놓지 않으면 새 행의 자동 클레임이 23505).
      await client.query(
        `UPDATE custom_domains SET status = 'removed', suspended_reason = NULL, removed_at = now(), superseded_by = $2, identity_released_at = now(), identity_handover_to = $2 WHERE id = $1`,
        [held.id, same],
      );
      expect(await toVerifying(same)).toBe('ok');
    });
  });

  it('⑤ 주소 = 별칭만 · 같은 조직의 verified 도메인과 정확히 · 도메인별 예약(TS = SQL) · 천장 = 도메인 길이의 함수(TS = SQL) · 정책 동기화 요청', async () => {
    const owner = provisioningPool();
    expect((await owner.query<{ parts: string[] }>(`SELECT atmark_reserved_local_parts_for('atmark.ai') AS parts`)).rows[0]?.parts).toEqual([...RESERVED_LOCAL_PARTS]);
    expect((await owner.query<{ parts: string[] }>(`SELECT atmark_reserved_local_parts_for('agents.x.com') AS parts`)).rows[0]?.parts).toEqual([
      ...GLOBAL_RESERVED_LOCAL_PARTS,
    ]);
    const lengths = Array.from({ length: 100 }, (_, index) => index + 1);
    const ceilings = await owner.query<{ n: number; ceiling: number }>(
      `SELECT n, atmark_custom_domain_address_ceiling(repeat('a', n)) AS ceiling FROM unnest($1::int[]) AS n ORDER BY n`,
      [lengths],
    );
    expect(ceilings.rows.map((row) => row.ceiling)).toEqual(lengths.map((n) => customDomainAddressCeiling('a'.repeat(n))));

    await rolledBack(provisioningPool(), async (client) => {
      const d = await verifiedDomain(client, a.organizationId);
      await client.query('UPDATE custom_domains SET policy_sync_requested_at = NULL WHERE id = $1', [d.id]);
      expect(await addAlias(client, a.agentId, `lead@${d.domain}`, true)).toBe(DOMAIN_SQLSTATES.primaryOnCustomDomain);
      expect(await addAlias(client, a.agentId, `bot@${d.domain}`)).toBe('ok');
      expect(
        (await client.query<{ at: Date | null }>('SELECT policy_sync_requested_at AS at FROM custom_domains WHERE id = $1', [d.id])).rows[0]?.at,
      ).not.toBeNull();
      for (const part of ['support', 'info', 'sales']) expect(await addAlias(client, a.agentId, `${part}@${d.domain}`), part).toBe('ok');
      for (const part of GLOBAL_RESERVED_LOCAL_PARTS) expect(await addAlias(client, a.agentId, `${part}@${d.domain}`), part).toBe('23514');
      expect(await addAlias(client, a.agentId, 'sales@atmark.ai')).toBe('23514');
      // support@atmark.ai 는 운영자 예약 주소(202609301500) — CHECK 를 지나고 허가 가드가 42501 로 막는다(이 조직에 허가 없음).
      expect(await addAlias(client, a.agentId, 'support@atmark.ai')).toBe('42501');
      // AI 에이전트 이름 예약은 atmark.ai 전용(202609301200) — 고객 도메인에서는 된다.
      for (const part of ['codex', 'claude-code']) {
        expect(await addAlias(client, a.agentId, `${part}@${d.domain}`), part).toBe('ok');
        expect(await addAlias(client, a.agentId, `${part}@atmark.ai`), part).toBe('23514');
      }
      expect(await addAlias(client, b.agentId, `other@${d.domain}`)).toBe(DOMAIN_SQLSTATES.domainNotVerified);
      expect(await addAlias(client, a.agentId, `bot@sub.${d.domain}`)).toBe(DOMAIN_SQLSTATES.domainNotVerified);
      expect(await addAlias(client, a.agentId, `bot@nowhere-${randomBytes(4).toString('hex')}.com`)).toBe(DOMAIN_SQLSTATES.domainNotVerified);
      // domain 칸을 속여도(atmark.ai) 주소에서 뽑은 도메인으로 판정한다(보안 L1) — 일치 CHECK 도 막는다.
      expect(
        await stateOf(client, `INSERT INTO agent_addresses (agent_id, address, domain) VALUES ($1, $2, 'atmark.ai')`, [a.agentId, `sneak@${d.domain}`]),
      ).not.toBe('ok');
      await suspend(client, d.id, 'plan_limit');
      expect(await addAlias(client, a.agentId, `later@${d.domain}`)).toBe(DOMAIN_SQLSTATES.domainNotVerified);
    });
  });

  it('⑥ 증명된 소유권 상실 → 같은 트랜잭션에서 옛 조직의 활성 별칭 폐기 · 양도 뒤 보류 · 옛 조직은 더 못 만든다 · 신뢰는 새 행부터', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const d = await verifiedDomain(client, a.organizationId);
      expect(await addAlias(client, a.agentId, `keep@${d.domain}`)).toBe('ok');
      expect(await addAlias(client, a.agentId, `gone@${d.domain}`)).toBe('ok');
      await client.query('UPDATE agent_addresses SET retired_at = now() WHERE address = $1', [`gone@${d.domain}`]);
      expect(await addAlias(client, a.agentId, `gone@${d.domain}`)).toBe('ok'); // 같은 조직은 곧바로(ADR-0013 개정)

      await asRole(client, DOMAIN_TICK_ROLE, () => suspend(client, d.id, 'ownership_lost'));
      for (const address of [`keep@${d.domain}`, `gone@${d.domain}`]) {
        expect((await retiredAt(client, address)).every((at) => at !== null), address).toBe(true);
      }
      const retireLeaves = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM tlog_outbox o JOIN agent_addresses x ON x.id::text = o.source_id
          WHERE o.source_table = 'agent_addresses' AND o.event = 'update' AND x.domain = $1`,
        [d.domain],
      );
      expect(retireLeaves.rows[0]?.n).toBe(3);

      const next = await insertDomain(client, b.organizationId, d.domain, d.registrable);
      await client.query('UPDATE custom_domains SET txt_verified_at = now() WHERE id = $1', [next]); // 양도 채택 불변식(202610021102)
      await client.query(
        `UPDATE custom_domains SET status = 'removed', suspended_reason = NULL, removed_at = now(), superseded_by = $2, identity_released_at = now(), identity_handover_to = $2 WHERE id = $1`,
        [d.id, next],
      );
      await verifyDomain(client, next);
      expect(await addAlias(client, b.agentId, `keep@${d.domain}`)).toBe('23505'); // 다른 조직이 30일 안에 폐기
      expect(await addAlias(client, b.agentId, `gone@${d.domain}`)).toBe('23505');
      expect(await addAlias(client, a.agentId, `again@${d.domain}`)).toBe(DOMAIN_SQLSTATES.domainNotVerified);
      expect(await addAlias(client, b.agentId, `fresh@${d.domain}`)).toBe('ok');

      const counted = async (address: string, at: string): Promise<boolean> =>
        (await client.query<{ ok: boolean }>(`SELECT ${hostedEvidenceSql('$1::text', `$2::timestamptz`)} AS ok`, [address, at])).rows[0]?.ok ?? false;
      const before = new Date(Date.now() - 24 * 3_600_000).toISOString();
      const after = new Date(Date.now() + 60_000).toISOString();
      expect(await counted(`fresh@${d.domain}`, before)).toBe(false);
      expect(await counted(`fresh@${d.domain}`, after)).toBe(true);
      expect(await counted(`keep@${d.domain}`, after)).toBe(false); // 활성 행 없음(보류)
      expect(await counted(`never@${d.domain}`, before)).toBe(true); // 행이 없던 주소는 외부 주소처럼(ADR-0013 M3)
    });
  });

  it('⑦ 워밍업 시계는 보낸 메시지에 한 번 · 알림 집기는 수신자·임대·끝난 알림 불변 · 런타임 롤 권한', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const d = await verifiedDomain(client, a.organizationId);
      const message = async (status: 'pending' | 'sent'): Promise<string> =>
        (
          await client.query<{ id: string }>(
            `WITH thread AS (INSERT INTO threads (agent_id, started_by, starter_address) VALUES ($1, 'agent', NULL) RETURNING id)
             INSERT INTO messages (agent_id, direction, from_address_hash, from_domain, status, message_id_header, idempotency_key, request_hash,
                                   recipient_count, sent_at, ses_message_id, thread_id)
             VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, 1, $8, $9, (SELECT id FROM thread)) RETURNING id`,
            [a.agentId, hex64(), d.domain, status, `<${randomUUID()}@${d.domain}>`, randomUUID(), hex64(),
              status === 'sent' ? new Date() : null, status === 'sent' ? `ses-${randomUUID()}` : null],
          )
        ).rows[0]?.id ?? '';
      const mark = async (id: string): Promise<boolean> =>
        (await client.query<{ marked: boolean }>('SELECT atmark_mark_domain_sending_started($1) AS marked', [id])).rows[0]?.marked ?? false;
      expect(await mark(await message('pending'))).toBe(false); // 아직 안 나갔다(보안 L5)
      const sent = await message('sent');
      expect(await mark(sent)).toBe(true);
      expect(await mark(sent)).toBe(false);
      expect(await stateOf(client, `UPDATE custom_domains SET sending_started_at = now() + interval '1 hour' WHERE id = $1`, [d.id])).toBe('23514');

      // 알림 — 틱이 적고, 워커가 집으면서 owner·admin 주소를 받는다.
      const owner = await client.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [`owner-${randomBytes(4).toString('hex')}@example.com`]);
      await client.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, 'owner', 'operator')`, [
        owner.rows[0]?.id,
        a.organizationId,
      ]);
      const notice = await asRole(client, DOMAIN_TICK_ROLE, async () =>
        (
          await client.query<{ id: string }>(
            `INSERT INTO domain_notices (domain_id, organization_id, kind, event_key) VALUES ($1, $2, 'suspended', 'e1') RETURNING id`,
            [d.id, a.organizationId],
          )
        ).rows[0]?.id,
      );
      const claim = async (): Promise<string[] | null> =>
        (await client.query<{ to: string[] | null }>('SELECT atmark_claim_domain_notice($1) AS to', [notice])).rows[0]?.to ?? null;
      const first = await claim();
      expect(first?.length).toBeGreaterThanOrEqual(1);
      expect(await claim()).toBeNull(); // 임대 중
      await client.query(`UPDATE domain_notices SET status = 'sent', sent_at = now(), ses_message_id = 'ses-1' WHERE id = $1`, [notice]);
      expect(await stateOf(client, `UPDATE domain_notices SET status = 'pending', sent_at = NULL, ses_message_id = NULL WHERE id = $1`, [notice])).toBe('23514');
    });

    expect(await poolState(app, 'SELECT id, organization_id, domain, status, suspended_reason, sending_started_at, removed_at, created_at FROM custom_domains WHERE false')).toBe('ok');
    expect(await poolState(app, 'SELECT challenge_token FROM custom_domains WHERE false')).toBe('42501');
    expect(await poolState(app, `UPDATE custom_domains SET status = 'verified' WHERE false`)).toBe('42501');
    expect(await poolState(app, 'SELECT atmark_mark_domain_sending_started($1)', [randomUUID()])).toBe('ok');
    expect(await poolState(app, 'SELECT atmark_claim_domain_notice($1)', [randomUUID()])).toBe('ok');
    expect(await poolState(app, 'UPDATE domain_notices SET attempt_count = 0 WHERE false')).toBe('42501');
    expect(await poolState(app, 'UPDATE domain_notices SET claimed_at = NULL WHERE false')).toBe('42501'); // 임대는 집기 함수만(재리뷰 L5)
    expect(await poolState(app, 'SELECT * FROM org_features WHERE false')).toBe('42501');
    expect(await poolState(app, 'SELECT * FROM mail_identity_claims WHERE false')).toBe('42501');
    expect(await poolState(admin, 'DELETE FROM custom_domains WHERE false')).toBe('42501');
    expect(await poolState(admin, `INSERT INTO org_features (organization_id, feature, enabled_by) SELECT id, 'custom_domains', 'x' FROM organizations WHERE false`)).toBe('42501');
    expect(await poolState(admin, `INSERT INTO domain_notices (domain_id, organization_id, kind, event_key) SELECT id, organization_id, 'removed', 'x' FROM custom_domains WHERE false`)).toBe('42501');
    expect(await poolState(admin, 'SELECT atmark_mark_domain_sending_started($1)', [randomUUID()])).toBe('42501');
    const tick = await provisioningPool().query<{ can: boolean; login: boolean }>(
      `SELECT has_column_privilege($1, 'custom_domains', 'status', 'UPDATE') AS can, rolcanlogin AS login FROM pg_roles WHERE rolname = $1`,
      [DOMAIN_TICK_ROLE],
    );
    expect(tick.rows[0]?.can).toBe(true);
  });

  it('⑧ 투명성 outbox — 스냅샷에 도메인 이름이 없다 · 상태가 바뀔 때만 · 트리거가 바꾼 제거 요청도 사건이다', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const registrable = apex();
      const id = await insertDomain(client, a.organizationId, `agents.${registrable}`, registrable);
      const rows = async (): Promise<{ event: string; rev: number; snapshot: Record<string, unknown> }[]> =>
        (
          await client.query<{ event: string; rev: number; snapshot: Record<string, unknown> }>(
            `SELECT event, rev, snapshot FROM tlog_outbox WHERE source_table = 'custom_domains' AND source_id = $1 ORDER BY event, rev`,
            [id],
          )
        ).rows;
      expect((await rows()).map((row) => [row.event, row.rev, row.snapshot['status']])).toEqual([['insert', 0, 'pending']]);
      expect(JSON.stringify(await rows())).not.toContain(registrable);
      await client.query('UPDATE custom_domains SET policy_sync_requested_at = now(), next_check_at = now() WHERE id = $1', [id]);
      expect(await rows()).toHaveLength(1);
      await verifyDomain(client, id);
      await client.query('UPDATE custom_domains SET removal_requested_at = now() WHERE id = $1', [id]);
      const after = await rows();
      expect(after.map((row) => [row.event, row.rev, row.snapshot['status']])).toEqual([
        ['insert', 0, 'pending'],
        ['update', 1, 'verifying'],
        ['update', 2, 'verified'],
        ['update', 3, 'removed'],
      ]);
      expect(Object.keys(after[2]?.snapshot ?? {}).sort()).toEqual(['at', 'inbound_mx_status', 'status', 'suspended_reason']);
    });
  });

  it('⑩ 동결 톰스톤(재리뷰 M1) — 평판·운영자 정지에서 제거하면 같은 도메인·apex 의 새 행과 verifying 진입이 42501 · 운영자만 푼다', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const d = await verifiedDomain(client, a.organizationId);
      await asRole(client, DOMAIN_TICK_ROLE, () => suspend(client, d.id, 'reputation'));
      // 소유자의 자발적 제거 요청으로 동결을 벗어나려 한다.
      await asRole(client, 'atmark_admin', () => client.query('UPDATE custom_domains SET removal_requested_at = now() WHERE id = $1', [d.id]));
      const tomb = await client.query<{ status: string; frozen: string | null }>('SELECT status, frozen_reason_at_removal AS frozen FROM custom_domains WHERE id = $1', [d.id]);
      expect(tomb.rows[0]).toEqual({ status: 'removed', frozen: 'reputation' });
      const insertAs = (role: string, organizationId: string, domain: string): Promise<string> =>
        asRole(client, role, () =>
          stateOf(client, `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4)`, [
            organizationId,
            domain,
            d.registrable,
            token(),
          ]),
        );
      expect(await insertAs('atmark_admin', a.organizationId, d.domain)).toBe('42501'); // 같은 도메인 — 다시 등록
      expect(await insertAs('atmark_admin', b.organizationId, `other.${d.registrable}`)).toBe('42501'); // 같은 apex — 다른 조직도
      // 소유자 롤로 만든 행이어도 틱은 verifying 으로 올리지 못한다.
      const pending = await insertDomain(client, a.organizationId, d.domain, d.registrable);
      expect(
        await asRole(client, DOMAIN_TICK_ROLE, () => stateOf(client, `UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [pending])),
      ).toBe('42501');
      // 톰스톤은 아무 런타임 롤도 못 지운다 · 운영자(소유자 롤)가 지우면 다시 된다.
      expect(await asRole(client, 'atmark_admin', () => stateOf(client, 'UPDATE custom_domains SET frozen_reason_at_removal = NULL WHERE id = $1', [d.id]))).toBe('42501');
      expect(await asRole(client, DOMAIN_TICK_ROLE, () => stateOf(client, 'UPDATE custom_domains SET frozen_reason_at_removal = NULL WHERE id = $1', [d.id]))).toBe('42501');
      await client.query('UPDATE custom_domains SET frozen_reason_at_removal = NULL WHERE id = $1', [d.id]);
      // 제거 사가가 identity 를 지운 뒤라야 같은 도메인의 새 행이 관리자가 된다(202610061001).
      await client.query('UPDATE custom_domains SET identity_deleted_at = now() WHERE id = $1', [d.id]);
      expect(
        await asRole(client, DOMAIN_TICK_ROLE, () => stateOf(client, `UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [pending])),
      ).toBe('ok');
    });
    await rolledBack(provisioningPool(), async (client) => {
      // 틱의 제거(operator 정지 → removed)도 같은 표시를 남긴다 · 평범한 정지(dkim_failed)에서의 제거는 남기지 않는다.
      const d = await verifiedDomain(client, a.organizationId);
      const e = await verifiedDomain(client, a.organizationId);
      await asRole(client, DOMAIN_TICK_ROLE, async () => {
        await suspend(client, d.id, 'operator');
        await suspend(client, e.id, 'dkim_failed');
        await removeDomain(client, d.id);
        await removeDomain(client, e.id);
      });
      const frozen = await client.query<{ id: string; frozen: string | null }>('SELECT id, frozen_reason_at_removal AS frozen FROM custom_domains WHERE id = ANY($1::uuid[])', [
        [d.id, e.id],
      ]);
      expect(Object.fromEntries(frozen.rows.map((row) => [row.id, row.frozen]))).toEqual({ [d.id]: 'operator', [e.id]: null });
    });
  });

  it('⑪ 주소 행의 식별 칸 불변(재리뷰 L8) — retired_at 말고는 바뀌지 않는다', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      for (const [column, value] of [
        ['is_primary', false],
        ['address', `moved-${randomBytes(3).toString('hex')}@atmark.ai`],
        ['domain', 'elsewhere.com'],
      ] as const) {
        expect(await stateOf(client, `UPDATE agent_addresses SET ${column} = $2 WHERE address = $1`, [a.address, value]), column).toBe('23514');
      }
      const d = await verifiedDomain(client, a.organizationId);
      expect(await addAlias(client, a.agentId, `bye@${d.domain}`)).toBe('ok');
      expect(await stateOf(client, 'UPDATE agent_addresses SET retired_at = now() WHERE address = $1', [`bye@${d.domain}`])).toBe('ok');
    });
  });

  it('⑨ 정책 소스 — 같은 조직의 비-removed 행(여러 removed 행 중에서) · 없으면 removed · 24시간 수신자는 조직 필터', async () => {
    const owner = provisioningPool();
    const org = await seedFixture(app);
    const other = await seedFixture(app);
    await enableFeature(owner, org.organizationId);
    const registrable = apex();
    const domain = `agents.${registrable}`;
    for (let round = 0; round < 2; round += 1) {
      const id = await insertDomain(owner, org.organizationId, domain, registrable);
      await verifyDomain(owner, id);
      await removeDomain(owner, id);
    }
    const live = await insertDomain(owner, org.organizationId, domain, registrable);
    await verifyDomain(owner, live);
    await owner.query(`INSERT INTO agent_addresses (agent_id, address, domain) VALUES ($1, $2, $3)`, [org.agentId, `bot@${domain}`, domain]);
    // 다른 도메인 하나는 verified → 주소 → 자발적 제거(주소는 남는다).
    const gone = await verifiedDomain(owner, org.organizationId);
    await owner.query(`INSERT INTO agent_addresses (agent_id, address, domain) VALUES ($1, $2, $3)`, [org.agentId, `bot@${gone.domain}`, gone.domain]);
    await owner.query('UPDATE custom_domains SET removal_requested_at = now() WHERE id = $1', [gone.id]);
    for (const [agentId, recipients] of [
      [org.agentId, 3],
      [other.agentId, 5],
    ] as const) {
      await owner.query(
        `WITH thread AS (INSERT INTO threads (agent_id, started_by, starter_address) VALUES ($1, 'agent', NULL) RETURNING id)
         INSERT INTO messages (agent_id, direction, from_address_hash, from_domain, status, message_id_header, idempotency_key, request_hash,
                               recipient_count, sent_at, ses_message_id, thread_id)
         VALUES ($1, 'outbound', $2, $3, 'sent', $4, $5, $6, $7, now(), $8, (SELECT id FROM thread))`,
        [agentId, hex64(), domain, `<${randomUUID()}@${domain}>`, randomUUID(), hex64(), recipients, `ses-${randomUUID()}`],
      );
    }

    const source = createPostgresPolicySource(app);
    const load = () => source.load({ agentId: org.agentId, recipients: [], now: new Date(), threadId: null, releaseApprovalId: null });
    const byDomain = (rows: readonly (readonly unknown[])[]): unknown[][] => [...rows].map((row) => [...row]).sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1));
    const first = await load();
    expect(byDomain(first.customDomains.map((row) => [row.domain, row.status, row.suspended_reason, row.recipients_last_day]))).toEqual(
      byDomain([
        [domain, 'verified', null, 3],
        [gone.domain, 'removed', null, 0],
      ]),
    );
    await suspend(owner, live, 'plan_limit');
    const second = await load();
    expect(second.customDomains.find((row) => row.domain === domain)).toMatchObject({ status: 'suspended', suspended_reason: 'plan_limit' });
    expect((await source.load({ agentId: other.agentId, recipients: [], now: new Date(), threadId: null, releaseApprovalId: null })).customDomains).toEqual([]);
  });
});
