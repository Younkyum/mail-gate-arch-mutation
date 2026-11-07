/**
 * 고객 도메인 **identity 관리자(steward)** DB 가드(202610061000 · 1001 · 1002 — 한 번에 설정 §2.3 · §4.1) — 실제 Postgres 위에서.
 *
 *   ① 같은 도메인 두 행의 동시 클레임 → 하나만(부분 UNIQUE 23505) · 다른 도메인은 서로 막지 않는다.
 *   ② claimed · released 쓰기 1회 · released 는 클레임 뒤 · handover 는 놓는 UPDATE 에서만 · 대상은 같은 도메인 · 다른 행 · removed 아님 · 클레임한 적 없음.
 *   ③ pending → verifying 자동 클레임(옛 틱 호환) — 다른 활성 관리자가 있으면 23505.
 *   ④ steward CHECK — verifying+ 는 활성 관리자(놓은 행은 다시 verifying 에 못 든다) · claim_shape(놓았는데 넘겨받는 행 없음 = removed 만).
 *   ⑤ 백필 술어 — 202610061000 의 UPDATE 를 그대로 다시 돌려 제거 사가 중 자기 태그 행만 관리자가 된다(verifying+ 는 자동 클레임 · CHECK VALID).
 *   ⑥ 새 행은 관리자가 아니다(INSERT 에 세 칸 거부) · removed 행은 클레임하지 못한다(틱 롤) — 소유자 롤(백필)만 예외.
 *   ⑦ admin 롤은 세 칸을 못 쓴다(42501) · 틱 롤은 쓴다.
 *   ⑧ 넘겨주기 대상(`handoverTargetFor`) · 채택 대상(`adoptableRowFor` — 사슬을 거슬러 태그 주인).
 *   ⑨ migrate status 가드 — 트리거 · CHECK 둘 · FK · 색인 정확한 술어가 있고 VALID.
 *
 * 모든 쓰기는 되돌린다(트랜잭션). `TEST_MIGRATION_DATABASE_URL`(소유자 롤 — 로컬은 슈퍼유저라 `SET LOCAL ROLE` 로 틱 · admin 롤을 흉내 낸다)이 없으면 건너뛴다.
 */

import { randomBytes } from 'node:crypto';

import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DOMAIN_TICK_ROLE } from '../../../src/domains/contract';
import { activeStewardFor, adoptableRowFor, handoverTargetFor, identitiesHeld } from '../../../src/domains/store';
import { REQUIRED_GUARDS } from '../../../src/runtime/handlers/migrate';
import { asRole, closeTestPool, DATABASE_AVAILABLE, provisioningPool, rolledBack, seedFixture, stateOf, testPool, type Fixture } from './support/harness';

const ownerUrl = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
const AVAILABLE = DATABASE_AVAILABLE && ownerUrl.trim() !== '';

const token = (): string => randomBytes(32).toString('base64url');
const apex = (): string => `cd${randomBytes(5).toString('hex')}.com`;

describe.skipIf(!AVAILABLE)('고객 도메인 identity 관리자 DB 가드 (202610061000~1002)', () => {
  let a: Fixture;
  let b: Fixture;
  let c: Fixture;

  beforeAll(async () => {
    a = await seedFixture(testPool());
    b = await seedFixture(testPool());
    c = await seedFixture(testPool());
    await provisioningPool().query(
      `INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, 'custom_domains', 'test'), ($2, 'custom_domains', 'test'), ($3, 'custom_domains', 'test')
       ON CONFLICT DO NOTHING`,
      [a.organizationId, b.organizationId, c.organizationId],
    );
  });

  afterAll(async () => {
    await closeTestPool();
  });

  const insert = async (client: PoolClient, organizationId: string, domain: string, registrable: string): Promise<string> =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
        [organizationId, domain, registrable, token()],
      )
    ).rows[0]?.id ?? '';
  const claim = (client: PoolClient, id: string): Promise<string> =>
    asRole(client, DOMAIN_TICK_ROLE, () => stateOf(client, 'UPDATE custom_domains SET identity_claimed_at = now() WHERE id = $1', [id]));
  const release = (client: PoolClient, id: string, to: string | null): Promise<string> =>
    asRole(client, DOMAIN_TICK_ROLE, () =>
      stateOf(client, 'UPDATE custom_domains SET identity_released_at = now(), identity_handover_to = $2 WHERE id = $1', [id, to]),
    );
  const toVerifying = (client: PoolClient, id: string): Promise<string> =>
    asRole(client, DOMAIN_TICK_ROLE, () => stateOf(client, `UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [id]));
  const steward = async (client: PoolClient, id: string): Promise<Record<string, unknown>> =>
    (
      await client.query(
        `SELECT identity_claimed_at IS NOT NULL AS claimed, identity_released_at IS NOT NULL AS released, identity_handover_to::text AS handover_to FROM custom_domains WHERE id = $1`,
        [id],
      )
    ).rows[0] ?? {};

  it('① 같은 도메인 두 행 → 클레임 하나만(23505) · 다른 도메인 · 같은 apex 는 서로 막지 않는다', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const registrable = apex();
      const domain = `agents.${registrable}`;
      const x = await insert(client, a.organizationId, domain, registrable);
      const y = await insert(client, b.organizationId, domain, registrable);
      const z = await insert(client, b.organizationId, `bots.${registrable}`, registrable);
      expect(await claim(client, x)).toBe('ok');
      expect(await claim(client, y)).toBe('23505');
      expect(await claim(client, z)).toBe('ok');
      expect((await activeStewardFor(client, domain))?.id).toBe(x);
      expect(await identitiesHeld(client, { organizationIds: [a.organizationId, b.organizationId] })).toBeGreaterThanOrEqual(2);
      // 놓으면(넘겨주기) 받는 행이 클레임할 수 있다.
      expect(await release(client, x, y)).toBe('ok');
      expect(await claim(client, y)).toBe('ok');
      expect((await activeStewardFor(client, domain))?.id).toBe(y);
    });
  });

  it('② 쓰기 1회 · 순서 · 넘겨받는 행의 조건', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const registrable = apex();
      const domain = `agents.${registrable}`;
      const x = await insert(client, a.organizationId, domain, registrable);
      const y = await insert(client, b.organizationId, domain, registrable);
      const other = await insert(client, b.organizationId, `other.${registrable}`, registrable);
      // 클레임 전에는 놓지 못한다.
      expect(await release(client, x, y)).toBe('23514');
      expect(await claim(client, x)).toBe('ok');
      // 다시 클레임(값 바꾸기) · 지우기 → 23514.
      expect(await asRole(client, DOMAIN_TICK_ROLE, () => stateOf(client, 'UPDATE custom_domains SET identity_claimed_at = clock_timestamp() WHERE id = $1', [x]))).toBe(
        '23514',
      );
      expect(await asRole(client, DOMAIN_TICK_ROLE, () => stateOf(client, 'UPDATE custom_domains SET identity_claimed_at = NULL WHERE id = $1', [x])))
        .toBe('23514');
      // handover 만 따로 적기 → 23514(놓는 UPDATE 에서만).
      expect(await asRole(client, DOMAIN_TICK_ROLE, () => stateOf(client, 'UPDATE custom_domains SET identity_handover_to = $2 WHERE id = $1', [x, y]))).toBe(
        '23514',
      );
      // 대상: 자기 자신 · 다른 도메인 · 클레임한 행 · removed → 23514.
      expect(await release(client, x, x)).toBe('23514');
      expect(await release(client, x, other)).toBe('23514');
      expect(await claim(client, other)).toBe('ok'); // 다른 도메인이라 된다
      const removed = await insert(client, c.organizationId, domain, registrable); // 같은 도메인 · removed
      await client.query(`UPDATE custom_domains SET status = 'removed', removed_at = now() WHERE id = $1`, [removed]);
      expect(await release(client, x, removed)).toBe('23514');
      // 올바른 넘겨주기 — 그리고 쓰기 1회.
      expect(await release(client, x, y)).toBe('ok');
      expect(await steward(client, x)).toEqual({ claimed: true, released: true, handover_to: y });
      expect(await asRole(client, DOMAIN_TICK_ROLE, () => stateOf(client, 'UPDATE custom_domains SET identity_released_at = clock_timestamp() WHERE id = $1', [x]))).toBe(
        '23514',
      );
      expect(await asRole(client, DOMAIN_TICK_ROLE, () => stateOf(client, 'UPDATE custom_domains SET identity_released_at = NULL WHERE id = $1', [x]))).toBe(
        '23514',
      );
      // 놓은 행은 다시 클레임하지 못한다(쓰기 1회) — 사슬은 앞으로만.
      expect(await claim(client, y)).toBe('ok');
      expect(await release(client, y, x)).toBe('23514'); // x 는 클레임한 적이 있다
    });
  });

  it('③ pending → verifying 자동 클레임 · 다른 활성 관리자가 있으면 23505 · 놓아 주면 된다', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const registrable = apex();
      const domain = `agents.${registrable}`;
      const x = await insert(client, a.organizationId, domain, registrable);
      expect(await toVerifying(client, x)).toBe('ok');
      expect(await steward(client, x)).toMatchObject({ claimed: true, released: false });


      const r2 = apex();
      const d2 = `agents.${r2}`;
      const holder = await insert(client, a.organizationId, d2, r2);
      const prover = await insert(client, b.organizationId, d2, r2);
      expect(await claim(client, holder)).toBe('ok');
      expect(await toVerifying(client, prover)).toBe('23505'); // 선점 관리자를 놓지 않았다
      expect(await release(client, holder, prover)).toBe('ok');
      expect(await toVerifying(client, prover)).toBe('ok');
      expect(await steward(client, prover)).toMatchObject({ claimed: true, released: false });
      // holder 의 태그 기록이 없어도(identity 를 만든 결과가 아직 행에 없다) 바로 앞 행을 채택 대상으로 돌려준다.
      expect(await adoptableRowFor(client, prover)).toBe(holder);
    });
  });

  it('④ steward CHECK · claim_shape — 놓은 행은 verifying 에 못 든다 · 넘겨받는 행 없는 놓기는 removed 만', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const registrable = apex();
      const domain = `agents.${registrable}`;
      const x = await insert(client, a.organizationId, domain, registrable);
      const y = await insert(client, b.organizationId, domain, registrable);
      expect(await claim(client, x)).toBe('ok');
      expect(await release(client, x, y)).toBe('ok');
      // x 는 놓았다 — verifying 진입은 steward CHECK(23514).
      expect(await toVerifying(client, x)).toBe('23514');
      // 넘겨받는 행 없이 놓기 — pending 이면 claim_shape(23514) · removed 면 된다(포기).
      expect(await claim(client, y)).toBe('ok');
      expect(await release(client, y, null)).toBe('23514');
      await client.query(`UPDATE custom_domains SET status = 'removed', removed_at = now() WHERE id = $1`, [y]);
      expect(await release(client, y, null)).toBe('ok');
      // verified 행은 놓을 수 없다(steward CHECK) — 양도는 removed 로 나가는 같은 UPDATE 에서만.
      const r2 = apex();
      const v = await insert(client, a.organizationId, `agents.${r2}`, r2);
      const w = await insert(client, b.organizationId, `agents.${r2}`, r2);
      expect(await toVerifying(client, v)).toBe('ok');
      expect(await release(client, v, w)).toBe('23514');
    });
  });

  it('⑤ 백필 술어 — 대체되지 않은 제거 사가 중 자기 태그 행만 · pending · 제거 끝 · 지운 행은 아니다(202610061000 의 UPDATE 를 그대로)', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const registrable = apex();
      // 옛 compute 의 행을 흉내 낸다(클레임 칸 없이 만들어진 상태) — 소유자 롤로 removed + 자기 태그.
      const removing = await insert(client, a.organizationId, `removing.${registrable}`, registrable);
      await client.query(`UPDATE custom_domains SET ses_identity_row_tag = id, status = 'removed', removed_at = now() WHERE id = $1`, [removing]);
      const finished = await insert(client, a.organizationId, `finished.${registrable}`, registrable);
      await client.query(`UPDATE custom_domains SET ses_identity_row_tag = id, status = 'removed', removed_at = now(), removal_step = 'done' WHERE id = $1`, [finished]);
      const deleted = await insert(client, a.organizationId, `deleted.${registrable}`, registrable);
      await client.query(`UPDATE custom_domains SET ses_identity_row_tag = id, status = 'removed', removed_at = now(), identity_deleted_at = now() WHERE id = $1`, [deleted]);
      const pending = await insert(client, b.organizationId, `pending.${registrable}`, registrable);
      await client.query(
        `UPDATE custom_domains
            SET identity_claimed_at = coalesce(txt_verified_at, now())
          WHERE identity_claimed_at IS NULL
            AND identity_deleted_at IS NULL
            AND (status IN ('verifying', 'verified', 'suspended')
                 OR (status = 'removed' AND removal_step <> 'done' AND superseded_by IS NULL AND ses_identity_row_tag = id))
            AND id = ANY ($1::uuid[])`,
        [[removing, finished, deleted, pending]],
      );
      expect(await steward(client, removing)).toMatchObject({ claimed: true });
      for (const id of [finished, deleted, pending]) expect(await steward(client, id), id).toMatchObject({ claimed: false });
      // verifying+ 는 백필이 필요 없다 — 진입에서 자동 클레임되고 CHECK 이 VALID 다(⑨).
    });
  });

  it('⑥ 새 행은 관리자가 아니다 · removed 행은 클레임하지 못한다(틱) — 소유자 롤만 예외', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const registrable = apex();
      const domain = `agents.${registrable}`;
      expect(
        await stateOf(
          client,
          `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token, identity_claimed_at) VALUES ($1, $2, $3, $4, now())`,
          [a.organizationId, domain, registrable, token()],
        ),
      ).toBe('23514');
      const x = await insert(client, a.organizationId, domain, registrable);
      await client.query(`UPDATE custom_domains SET status = 'removed', removed_at = now() WHERE id = $1`, [x]);
      expect(await claim(client, x)).toBe('23514');
      expect(await stateOf(client, 'UPDATE custom_domains SET identity_claimed_at = now() WHERE id = $1', [x])).toBe('ok'); // 소유자 롤(백필)
    });
  });

  it('⑦ admin 롤은 세 칸을 못 쓴다(42501) · 틱 롤은 쓴다', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const registrable = apex();
      const x = await insert(client, a.organizationId, `agents.${registrable}`, registrable);
      for (const column of ['identity_claimed_at', 'identity_released_at']) {
        expect(await asRole(client, 'atmark_admin', () => stateOf(client, `UPDATE custom_domains SET ${column} = now() WHERE id = $1`, [x])), column).toBe('42501');
      }
      expect(await asRole(client, 'atmark_admin', () => stateOf(client, 'UPDATE custom_domains SET identity_handover_to = id WHERE id = $1', [x]))).toBe('42501');
      expect(await claim(client, x)).toBe('ok');
    });
  });

  it('⑧ 넘겨주기 대상 · 채택 대상 조회 — 사슬을 거슬러 태그 주인을 고른다', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const registrable = apex();
      const domain = `agents.${registrable}`;
      const root = await insert(client, a.organizationId, domain, registrable);
      const mid = await insert(client, b.organizationId, domain, registrable);
      expect(await claim(client, root)).toBe('ok');
      await asRole(client, DOMAIN_TICK_ROLE, () => client.query('UPDATE custom_domains SET ses_identity_row_tag = id WHERE id = $1', [root]));
      await client.query(`UPDATE custom_domains SET status = 'removed', removed_at = now() WHERE id = $1`, [root]);
      expect(await release(client, root, mid)).toBe('ok');
      expect(await claim(client, mid)).toBe('ok');
      await client.query(`UPDATE custom_domains SET status = 'removed', removed_at = now() WHERE id = $1`, [mid]);
      const last = await insert(client, a.organizationId, domain, registrable);
      expect(await handoverTargetFor(client, { id: mid, domain })).toBe(last);
      expect(await release(client, mid, last)).toBe('ok');
      expect(await claim(client, last)).toBe('ok');
      // mid 는 태그를 쥔 적이 없다 → 사슬을 거슬러 root.
      expect(await adoptableRowFor(client, last)).toBe(root);
      expect(await adoptableRowFor(client, mid)).toBe(root);
      expect(await adoptableRowFor(client, root)).toBeNull();
    });
  });

  it('⑨ migrate status 가드 — 트리거 · CHECK · FK · 색인(정확한 술어)이 있고 VALID', async () => {
    const wanted = REQUIRED_GUARDS.filter((guard) =>
      [
        'trigger:custom_domains.custom_domains_identity_claim_guard',
        'constraint:custom_domains.custom_domains_steward_shape',
        'constraint:custom_domains.custom_domains_identity_claim_shape',
        'constraint:custom_domains.custom_domains_identity_handover_to_fkey',
        'index:custom_domains.custom_domains_identity_claim_key(',
      ].some((prefix) => guard.startsWith(prefix)),
    );
    expect(wanted).toHaveLength(5);
    const rows = await provisioningPool().query<{ guard: string; validated: boolean | null }>(
      `SELECT 'trigger:' || c.relname || '.' || t.tgname AS guard, NULL::boolean AS validated
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'custom_domains' AND NOT t.tgisinternal
       UNION ALL
       SELECT 'constraint:' || c.relname || '.' || k.conname, k.convalidated FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relname = 'custom_domains'
       UNION ALL
       SELECT 'index:' || t.relname || '.' || c.relname
              || '(' || (SELECT string_agg(pg_get_indexdef(i.indexrelid, n, false), ',' ORDER BY n) FROM generate_series(1, i.indnkeyatts) AS n) || ')'
              || coalesce(' WHERE ' || pg_get_expr(i.indpred, i.indrelid), ''), NULL::boolean
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
        WHERE t.relname = 'custom_domains' AND i.indisunique AND i.indisvalid`,
    );
    const present = new Map(rows.rows.map((row) => [row.guard, row.validated]));
    for (const guard of wanted) {
      expect(present.has(guard), guard).toBe(true);
      expect(present.get(guard), guard).not.toBe(false);
    }
  });
});
