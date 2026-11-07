/**
 * test/integration/policy/support.ts — 고객 도메인 관문 통합 테스트(ADR-0014 단계 3)의 지반. 도메인 행은 **소유자 롤**(마이그레이션 롤 — 로컬은
 * 슈퍼유저)로 단계 0 트리거를 지나 만든다(`test/integration/db/custom-domains-triggers.test.ts` 와 같은 순서: 기능 허용 → pending → verifying →
 * verified). 주소는 verified 뒤에만 생긴다(`agent_addresses_verified_domain_guard`).
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { hex64, provisioningPool } from '../db/support/harness';

export const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';

type Db = Pick<Pool, 'query'>;

export async function enableCustomDomains(organizationId: string): Promise<void> {
  await provisioningPool().query(
    `INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, 'custom_domains', 'test') ON CONFLICT DO NOTHING`,
    [organizationId],
  );
}

/** 기능 허용 → pending → verifying → verified. 도메인 이름 · 행 id. */
export async function verifiedCustomDomain(organizationId: string): Promise<{ readonly id: string; readonly domain: string }> {
  const owner = provisioningPool();
  await enableCustomDomains(organizationId);
  const registrable = `cd${randomBytes(5).toString('hex')}.com`;
  const domain = `agents.${registrable}`;
  const row = await owner.query<{ id: string }>(
    `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4) RETURNING id`,
    [organizationId, domain, registrable, randomBytes(32).toString('base64url')],
  );
  const id = row.rows[0]?.id ?? '';
  await owner.query(`UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [id]);
  await owner.query(`UPDATE custom_domains SET status = 'verified', verified_at = now() WHERE id = $1`, [id]);
  return { id, domain };
}

export async function addAlias(agentId: string, address: string): Promise<void> {
  await provisioningPool().query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, split_part($2, '@', 2), false)`, [
    agentId,
    address,
  ]);
}

export async function suspendDomain(id: string, reason: string): Promise<void> {
  await provisioningPool().query(`UPDATE custom_domains SET status = 'suspended', suspended_reason = $2, suspended_at = now() WHERE id = $1`, [id, reason]);
}

/** 정지 해제(suspended → verified) — 소유자 롤은 어떤 사유든 푼다(틱 롤은 평판·운영자 정지를 못 푼다). */
export async function liftDomain(id: string): Promise<void> {
  await provisioningPool().query(`UPDATE custom_domains SET status = 'verified', suspended_reason = NULL, suspended_at = NULL WHERE id = $1`, [id]);
}

/**
 * 자발적 제거 요청(admin 의 쓰기 — 트리거가 그 자리에서 removed 로 바꾼다, 주소는 남는다) + **제거 사가 끝**(identity 삭제 — 202610061001 이후 같은
 * 도메인의 다음 행이 identity 관리자가 되려면 앞 행이 지웠거나 넘겨야 한다. 틱이 하는 일을 소유자 롤로 흉내 낸다).
 */
export async function requestRemoval(id: string): Promise<void> {
  await provisioningPool().query('UPDATE custom_domains SET removal_requested_at = now() WHERE id = $1', [id]);
  await provisioningPool().query('UPDATE custom_domains SET identity_deleted_at = now() WHERE id = $1', [id]);
}

export async function retireAddress(address: string): Promise<void> {
  await provisioningPool().query('UPDATE agent_addresses SET retired_at = now() WHERE address = $1', [address]);
}

/** 이 조직이 고객 도메인으로 보낸 `sent` 메시지 하나(수신자 수 `recipients`). */
export async function seedDomainMessage(db: Db, agentId: string, domain: string, recipients: number, sentAt = new Date()): Promise<void> {
  await db.query(
    `WITH thread AS (INSERT INTO threads (agent_id, started_by, starter_address) VALUES ($1, 'agent', NULL) RETURNING id)
     INSERT INTO messages (agent_id, direction, from_address_hash, from_domain, status, message_id_header, idempotency_key, request_hash,
                           recipient_count, sent_at, ses_message_id, thread_id)
     VALUES ($1, 'outbound', $2, $3, 'sent', $4, $5, $6, $7, $8, $9, (SELECT id FROM thread))`,
    [agentId, hex64(), domain, `<${randomUUID()}@${domain}>`, randomUUID(), hex64(), recipients, sentAt, `ses-${randomUUID()}`],
  );
}
