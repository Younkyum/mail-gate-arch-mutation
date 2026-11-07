/**
 * `202609230640_exact_allow_relationships.sql` — 절단형으로 저장된 옛 `approved` 관계에 대해 **소유자가 본 주소**의
 * 관계를 하나 더 만든다(검증 V1 MINOR-2 의 기존 행 처리). 옛 행은 건드리지 않는다.
 *
 * 소유자 롤 트랜잭션 **안에서** 옛 모양의 행을 만들고 마이그레이션 SQL 을 그대로 실행한 뒤 **롤백**한다 —
 * 공유 DB 에 아무것도 남기지 않는다(승인 대기 행이 남으면 §4.3 보조 불변식의 거짓 위반이 된다).
 * `TEST_MIGRATION_DATABASE_URL`(소유자 롤)이 없으면 건너뛴다.
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

import { seedFixture, seedMessage } from '../db/support/harness';

const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
const MIGRATION = readFileSync(
  resolve(__dirname, '../../../src/db/migrations/202609230640_exact_allow_relationships.sql'),
  'utf8',
);

const owner = OWNER_URL === '' ? null : new Pool({ connectionString: OWNER_URL, max: 2 });
afterAll(async () => {
  await owner?.end();
});

async function inRolledBackTransaction(work: (client: PoolClient) => Promise<void>): Promise<void> {
  if (owner === null) throw new Error('소유자 풀이 없다');
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function relationshipsOf(client: PoolClient, agentId: string): Promise<{ address: string; trust_category: string }[]> {
  const result = await client.query<{ address: string; trust_category: string }>(
    `SELECT address, trust_category::text FROM sender_relationships WHERE agent_id = $1 ORDER BY address COLLATE "C"`,
    [agentId],
  );
  return result.rows;
}

describe.skipIf(owner === null)('202609230640 — 절단형 관계에 소유자가 본 주소의 관계를 더한다', () => {
  it('Sales+EU@ 승인이 sales@ 로 저장된 옛 행 → sales+eu@ 행이 생긴다 · 옛 행은 그대로 · 다시 돌려도 같다', async () => {
    await inRolledBackTransaction(async (client) => {
      const db = client as unknown as Pool;
      const fixture = await seedFixture(db);
      const messageId = await seedMessage(db, fixture.agentId);
      const approvalId = randomUUID();
      const now = new Date();
      await client.query(
        `INSERT INTO approval_requests (id, agent_id, subject, created_at, expires_at) VALUES ($1, $2, 'message', $3, $4)`,
        [approvalId, fixture.agentId, now, new Date(now.getTime() + 3_600_000)],
      );
      const audit = await client.query<{ id: string }>(
        `INSERT INTO audit_logs (agent_id, message_id, decision, reasons, policy_version_id, policy_version, approval_id)
         VALUES ($1, $2, 'pending_approval', ARRAY['new_recipient'], $3, 1, $4) RETURNING id`,
        [fixture.agentId, messageId, fixture.policyVersionId, approvalId],
      );
      await client.query(
        `INSERT INTO approval_request_items (approval_id, message_id, audit_id, from_address, recipients, is_thread_reply, thread_id, cost_cents)
         VALUES ($1, $2, $3, $4, $5::text[], false, NULL, 0)`,
        [approvalId, messageId, audit.rows[0]?.id, fixture.address, ['Sales+EU@Corp.com', 'bob@x.io']],
      );
      await client.query(
        `UPDATE approval_requests SET status = 'approved', decided_at = $2, decided_by = 'owner@example.com', granted_scope = 'recipient'
          WHERE id = $1`,
        [approvalId, now],
      );
      // 예전 `relationshipsFor` 가 저장한 모양 — `+tag` 절단.
      for (const address of ['sales@corp.com', 'bob@x.io']) {
        await client.query(
          `INSERT INTO sender_relationships (agent_id, scope, address, trust_category, granted_via_approval_id, granted_by)
           VALUES ($1, 'recipient', $2, 'approved', $3, 'owner@example.com')`,
          [fixture.agentId, address, approvalId],
        );
      }
      // 소유자가 적은 seed 는 원래 입력이 없다 — 마이그레이션이 손대지 않는다.
      await client.query(
        `INSERT INTO sender_relationships (agent_id, scope, address, trust_category, granted_by)
         VALUES ($1, 'recipient', 'seed@corp.com', 'seed', 'owner_provisioning')`,
        [fixture.agentId],
      );

      await client.query(MIGRATION);
      const expected = [
        { address: 'bob@x.io', trust_category: 'approved' },
        { address: 'sales+eu@corp.com', trust_category: 'approved' },
        { address: 'sales@corp.com', trust_category: 'approved' },
        { address: 'seed@corp.com', trust_category: 'seed' },
      ];
      expect(await relationshipsOf(client, fixture.agentId)).toEqual(expected);
      const added = await client.query<{ granted_via_approval_id: string; granted_by: string }>(
        `SELECT granted_via_approval_id, granted_by FROM sender_relationships WHERE agent_id = $1 AND address = 'sales+eu@corp.com'`,
        [fixture.agentId],
      );
      expect(added.rows).toEqual([{ granted_via_approval_id: approvalId, granted_by: 'owner@example.com' }]);

      await client.query(MIGRATION);
      expect(await relationshipsOf(client, fixture.agentId)).toEqual(expected);
    });
  });
});
