/**
 * 메일 기본기 2차 — 답장 `from` 생략의 기본값(리드 판정 2026-09-27): 받은 **봉투 주소가 이 에이전트의 활성 주소**면 그것(별칭으로 받은
 * 메일은 별칭으로 답한다), 폐기됐으면 **대표 주소**. 실제 Postgres — `createPostgresReplyTargetLookup` 의 한 문장이 정한다.
 * 수신 전용 별칭(`abuse@`·`postmaster@atmark.ai`, 202609301540)으로 받은 메일은 활성이어도 **대표 주소**다 — 그 주소로는 보낼 수 없다.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import type { Queryable } from '../../../src/db/client';
import { createPostgresReplyTargetLookup } from '../../../src/db/repositories/reply-target-store';
import { RECEIVE_ONLY_ADDRESSES } from '../../../src/identity/address';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

async function inboundTo(f: Fixture, envelope: string, owner: Queryable = provisioningPool()): Promise<string> {
  const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'external') RETURNING id`, [f.agentId]);
  const ses = `0100${randomUUID().replace(/-/g, '')}`;
  const inserted = await owner.query<{ id: string }>(
    `INSERT INTO inbound_messages
       (agent_id, envelope_recipient, ses_message_id, thread_id, new_thread_reason, from_address, from_domain, from_authenticated,
        subject, auto_submitted, spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
        raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
        scanner_version, injection_risk, quarantined, sender_trust)
     VALUES ($1, $2, $3, $4, 'no_header_ids', 'sender@partner.example', 'partner.example', true, 'hello', false, 'pass', 'pass', 'pass', 'pass',
             'pass', false, 'inbound/raw/' || $3, 'inbound/parsed/' || $3 || '.json', 'plain', false, 0, now(),
             'test-v0', 'none'::injection_risk, false, 'unknown')
     RETURNING id`,
    [f.agentId, envelope, ses, thread.rows[0]?.id],
  );
  return inserted.rows[0]?.id ?? '';
}

describe.skipIf(!DATABASE_AVAILABLE)('답장 from 기본값 — 받은 주소(활성) · 아니면 대표', () => {
  it('대표로 받은 메일 → 대표 · 별칭으로 받은 메일 → 별칭 · 별칭 폐기 뒤 → 대표', async () => {
    const f = await seedFixture(testPool());
    const alias = `alias-${f.agentId.slice(0, 16)}@atmark.ai`;
    await provisioningPool().query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', false)`, [f.agentId, alias]);
    const lookup = createPostgresReplyTargetLookup(testPool());
    const viaPrimary = await inboundTo(f, f.address);
    const viaAlias = await inboundTo(f, alias);
    expect((await lookup.find(f.agentId, viaPrimary))?.defaultFromAddress).toBe(f.address);
    expect((await lookup.find(f.agentId, viaAlias))?.defaultFromAddress).toBe(alias);
    await provisioningPool().query('UPDATE agent_addresses SET retired_at = now() WHERE address = $1', [alias]);
    expect((await lookup.find(f.agentId, viaAlias))?.defaultFromAddress).toBe(f.address);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('답장 from 기본값 — 수신 전용 별칭(abuse@·postmaster@)으로 받은 메일은 대표 주소로 (202609301540)', () => {
  it('abuse@·postmaster@ 별칭(활성)으로 받은 메일 → 대표 · 같은 에이전트의 보통 별칭은 그대로 별칭', async () => {
    const f = await seedFixture(testPool());
    // 두 주소는 전역 활성 UNIQUE 다 — 공유 테스트 DB 에 남기지 않게 소유자 트랜잭션 하나에서 만들고 읽고 되돌린다(조회도 같은 연결).
    const client = await provisioningPool().connect();
    try {
      await client.query('BEGIN');
      const alias = `alias-${f.agentId.slice(0, 16)}@atmark.ai`;
      await client.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', false)`, [f.agentId, alias]);
      for (const address of RECEIVE_ONLY_ADDRESSES) {
        await client.query(`INSERT INTO operator_address_grants (address, organization_id, granted_by, reason) VALUES ($1, $2, 'test', 'test')`, [
          address,
          f.organizationId,
        ]);
        await client.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', false)`, [f.agentId, address]);
      }
      const lookup = createPostgresReplyTargetLookup(client);
      for (const address of RECEIVE_ONLY_ADDRESSES) {
        const received = await inboundTo(f, address, client);
        expect((await lookup.find(f.agentId, received))?.defaultFromAddress, address).toBe(f.address);
      }
      expect((await lookup.find(f.agentId, await inboundTo(f, alias, client)))?.defaultFromAddress).toBe(alias);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
