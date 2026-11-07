/**
 * migrate `status` 가 가드 CHECK·FK 의 **검증 여부**(`pg_constraint.convalidated`)까지 본다 — 메일 기본기 1차 재검토 N4-c.
 *
 * `NOT VALID` 로 더하고 다음 파일에서 `VALIDATE` 하는 쌍(예: 202609260105 → 0106)이 반만 적용되면 제약은 "있다" — 예전 status 는 이름만
 * 봐서 ok 였다. 이제 그런 가드는 `unvalidatedGuards` 에 이름으로 나오고 ok=false 다. 설계상 `NOT VALID` 로 남을 수 있는 가드
 * (`NOT_VALID_TOLERATED_GUARDS`)는 세지 않는다.
 *
 * 소유자 롤 트랜잭션 안에서 제약을 `NOT VALID` 로 다시 세우고 **언제나 롤백**한다(DDL 은 SAVEPOINT 안 — 잠금이 바로 풀린다).
 * `TEST_MIGRATION_DATABASE_URL` 이 없으면 건너뛴다.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../../src/db/client';
import { closeTestPool, DATABASE_AVAILABLE, seedFixture, testPool } from '../db/support/harness';
import { NOT_VALID_TOLERATED_GUARDS, REQUIRED_GUARDS } from '../../../src/runtime/handlers/migrate';
import { statusOn } from './support';

const ownerUrl = (process.env['TEST_MIGRATION_DATABASE_URL'] ?? '').trim();

describe('예외 목록은 REQUIRED_GUARDS 의 제약 줄이다', () => {
  it('허용 목록의 모든 이름이 REQUIRED_GUARDS 에 있고 constraint: 줄이다', () => {
    for (const guard of NOT_VALID_TOLERATED_GUARDS) {
      expect(REQUIRED_GUARDS as readonly string[], guard).toContain(guard);
      expect(guard.startsWith('constraint:'), guard).toBe(true);
    }
    // 메일 기본기 1차의 NOT VALID → VALIDATE 쌍은 예외가 아니다 — 검증까지 끝나야 ok.
    for (const guard of ['constraint:scheduled_sends.scheduled_sends_cancelled_via_check', 'constraint:webhook_deliveries.webhook_deliveries_redelivery_of_fkey']) {
      expect(NOT_VALID_TOLERATED_GUARDS as readonly string[], guard).not.toContain(guard);
    }
  });
});

describe.skipIf(ownerUrl === '')('migrate status — 가드 CHECK·FK 의 convalidated (N4-c, 롤백)', () => {
  let owner: Pool;
  beforeAll(() => {
    owner = createPool(ownerUrl, { max: 1 });
  });
  afterAll(async () => {
    await owner.end();
    if (DATABASE_AVAILABLE) await closeTestPool();
  });

  it('깨끗하면 unvalidatedGuards 0 · CHECK·FK 가드가 NOT VALID 로 남으면 이름으로 ok=false · 예외 목록의 가드는 세지 않는다', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      const clean = await statusOn(client);
      expect(clean.unvalidatedGuards).toEqual([]);

      await client.query('SAVEPOINT not_valid');
      // CHECK — 같은 이름으로 다시 세우되 기존 행을 검증하지 않는다(모양은 상관없다 — status 는 검증 여부만 본다).
      await client.query('ALTER TABLE billing_checkouts DROP CONSTRAINT billing_checkouts_plan_check');
      await client.query('ALTER TABLE billing_checkouts ADD CONSTRAINT billing_checkouts_plan_check CHECK (true) NOT VALID');
      // FK — 202609260115 이 NOT VALID 로 더하고 0116 이 VALIDATE 하는 제약. 반만 적용된 상태를 흉내 낸다.
      await client.query('ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_redelivery_of_fkey');
      await client.query(
        'ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_redelivery_of_fkey FOREIGN KEY (redelivery_of) REFERENCES webhook_deliveries (id) ON DELETE RESTRICT NOT VALID',
      );
      // 예외 목록의 가드 — NOT VALID 여도 세지 않는다.
      await client.query('ALTER TABLE tlog_anchors DROP CONSTRAINT tlog_anchors_state_shape');
      await client.query('ALTER TABLE tlog_anchors ADD CONSTRAINT tlog_anchors_state_shape CHECK (true) NOT VALID');
      const halfApplied = await statusOn(client);
      await client.query('ROLLBACK TO SAVEPOINT not_valid');

      expect(halfApplied.ok).toBe(false);
      expect(halfApplied.missingGuards).toEqual([]);
      expect([...halfApplied.unvalidatedGuards].sort()).toEqual(
        ['constraint:billing_checkouts.billing_checkouts_plan_check', 'constraint:webhook_deliveries.webhook_deliveries_redelivery_of_fkey'].sort(),
      );
      expect(halfApplied.unvalidatedGuards).not.toContain('constraint:tlog_anchors.tlog_anchors_state_shape');

      // VALIDATE 하면 다시 빈다(같은 트랜잭션 — 롤백된다).
      await client.query('SAVEPOINT validated');
      await client.query('ALTER TABLE billing_checkouts DROP CONSTRAINT billing_checkouts_plan_check');
      await client.query('ALTER TABLE billing_checkouts ADD CONSTRAINT billing_checkouts_plan_check CHECK (true) NOT VALID');
      await client.query('ALTER TABLE billing_checkouts VALIDATE CONSTRAINT billing_checkouts_plan_check');
      const validated = await statusOn(client);
      await client.query('ROLLBACK TO SAVEPOINT validated');
      expect(validated.unvalidatedGuards).toEqual([]);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('index: 가드(별칭 재발급 L4) — 활성 주소 부분 UNIQUE 가 없거나 술어가 다르면 missingGuards 에 이름으로 · 같으면 빈다', async () => {
    const guard = 'index:agent_addresses.agent_addresses_active_address_key(address) WHERE (retired_at IS NULL)';
    expect(REQUIRED_GUARDS as readonly string[]).toContain(guard);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      expect((await statusOn(client)).missingGuards).toEqual([]);
      // 같은 이름 · UNIQUE 지만 술어가 다른 색인 — 가드는 서지 않는다.
      await client.query('DROP INDEX agent_addresses_active_address_key');
      // 술어는 지금 행으로도 서야 한다 — 에이전트 삭제(202610131000) 뒤에는 폐기한 대표와 다시 만든 대표가 같은 주소를 가질 수 있어 `WHERE is_primary`
      // 만으로는 UNIQUE 를 만들 수 없다.
      await client.query('CREATE UNIQUE INDEX agent_addresses_active_address_key ON agent_addresses (address) WHERE is_primary AND retired_at IS NULL');
      const wrong = await statusOn(client);
      expect(wrong.ok).toBe(false);
      expect(wrong.missingGuards).toEqual([guard]);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('운영자 예약 주소(202609301500) — 허가 없이 활성으로 쥔 support@·onve@ 는 operatorAddressesWithoutGrant 에 나오고 ok=false(용인 없음 — claude@ 는 202610141200 에서 목록을 떠났다) · 허가가 있으면 빈다', async () => {
    if (!DATABASE_AVAILABLE) return;
    const a = await seedFixture(testPool());
    const client = await owner.connect();
    // 허가 없는 행의 모양 — 허가를 먼저 주고 심은 뒤 허가를 지운다(가드 트리거를 끄면 `missingGuards` 가 달라져 ok 를 흐린다).
    const insert = async (address: string): Promise<void> => {
      await client.query(`INSERT INTO operator_address_grants (address, organization_id, granted_by, reason) VALUES ($1, $2, 'test', 'test')`, [
        address,
        a.organizationId,
      ]);
      await client.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', false)`, [a.agentId, address]);
      await client.query('DELETE FROM operator_address_grants WHERE address = $1', [address]);
    };
    try {
      await client.query('BEGIN');
      const baseline = await statusOn(client);
      expect(baseline.operatorAddressesWithoutGrant).toEqual([]);
      // onve@ — 나오고 ok=false.
      await insert('onve@atmark.ai');
      const held = await statusOn(client);
      expect(held.operatorAddressesWithoutGrant).toContain('onve@atmark.ai');
      expect(held.ok).toBe(false);

      // 그 조직의 허가 행이 있으면 사라진다.
      await client.query(`INSERT INTO operator_address_grants (address, organization_id, granted_by, reason) VALUES ('onve@atmark.ai', $1, 'test', 'test')`, [
        a.organizationId,
      ]);
      const granted = await statusOn(client);
      expect(granted.operatorAddressesWithoutGrant).not.toContain('onve@atmark.ai');
      expect(granted.ok).toBe(baseline.ok);

      // 다른 조직에 허가돼 있으면 여전히 나온다.
      const b = await seedFixture(testPool());
      await client.query(`UPDATE operator_address_grants SET organization_id = $1 WHERE address = 'onve@atmark.ai'`, [b.organizationId]);
      expect((await statusOn(client)).operatorAddressesWithoutGrant).toContain('onve@atmark.ai');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
