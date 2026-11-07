/**
 * 묶음 B(202610081200) — 초안 · 받은 메일 상태의 **DB 가드**(앱 롤로). 라우트 검사가 빠져도 DB 가 막는다.
 *   - 보내기 키를 잡은 초안은 내용이 바뀌지 않는다 · 키는 다른 값으로 바뀌지 않는다 · 지우기 금지(트리거 + 권한 0).
 *   - 버린 초안은 굳는다.
 *   - 받은 메일 상태는 그 메일의 에이전트 것만 · 라벨 모양 · 처음 읽은 시각은 한 번만.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { closeTestPool, DATABASE_AVAILABLE, seedFixture, provisioningPool, testPool } from './support/harness';
import { consumerDeps, deliver, eml, newSesMessageId } from '../inbound/support';
import { createLocalObjectStore } from '../../../src/storage/local-object-store';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

async function draft(agentId: string): Promise<string> {
  const id = randomUUID();
  await testPool().query(
    `INSERT INTO drafts (id, agent_id, content_storage_key, content_bytes) VALUES ($1::uuid, $2, 'outbound/drafts/' || $1 || '/1.json', 0)`,
    [id, agentId],
  );
  return id;
}

describe.skipIf(!DATABASE_AVAILABLE)('drafts · inbound_message_state 가드', () => {
  it('키를 잡은 초안은 고칠 수 없고 키를 바꿀 수 없다 · 지울 수 없다 · 버린 초안은 굳는다', async () => {
    const fixture = await seedFixture(provisioningPool());
    const pool = testPool();
    const id = await draft(fixture.agentId);
    await pool.query(`UPDATE drafts SET send_idempotency_key = 'k1', send_claimed_at = now() WHERE id = $1`, [id]);
    await expect(pool.query(`UPDATE drafts SET subject = 'x' WHERE id = $1`, [id])).rejects.toThrow(/being sent/);
    await expect(pool.query(`UPDATE drafts SET send_idempotency_key = 'k2' WHERE id = $1`, [id])).rejects.toThrow(/keeps its idempotency key/);
    await expect(pool.query(`DELETE FROM drafts WHERE id = $1`, [id])).rejects.toThrow();
    const other = await draft(fixture.agentId);
    await pool.query(`UPDATE drafts SET discarded_at = now() WHERE id = $1`, [other]);
    await expect(pool.query(`UPDATE drafts SET subject = 'x' WHERE id = $1`, [other])).rejects.toThrow(/sent or discarded/);
    // 본문 키는 id · 판에서만.
    await expect(
      pool.query(`INSERT INTO drafts (agent_id, content_storage_key, content_bytes) VALUES ($1, 'outbound/drafts/x/1.json', 0)`, [fixture.agentId]),
    ).rejects.toThrow(/drafts_content_key_shape/);
  });

  it('받은 메일 상태 — 남의 에이전트 행 거부 · 라벨 모양 · 처음 읽은 시각은 한 번만 · 지우기 금지', async () => {
    const owner = await seedFixture(provisioningPool());
    const stranger = await seedFixture(provisioningPool());
    const pool = testPool();
    const objects = createLocalObjectStore({ directory: mkdtempSync(join(tmpdir(), 'atmark-b-')), env: {} });
    const sesMessageId = newSesMessageId();
    await deliver(consumerDeps(pool, objects), eml({ from: 'client@customer.example', subject: '안녕', text: '안녕하세요' }), { sesMessageId, recipients: [owner.address] });
    const message = (await pool.query<{ id: string }>('SELECT id::text FROM inbound_messages WHERE ses_message_id = $1', [sesMessageId])).rows[0]?.id;
    await expect(pool.query(`INSERT INTO inbound_message_state (inbound_message_id, agent_id) VALUES ($1, $2)`, [message, stranger.agentId])).rejects.toThrow(/belong to the agent/);
    await expect(pool.query(`INSERT INTO inbound_message_state (inbound_message_id, agent_id, labels) VALUES ($1, $2, '{Bad}')`, [message, owner.agentId])).rejects.toThrow(/labels_check/);
    await pool.query(`INSERT INTO inbound_message_state (inbound_message_id, agent_id, first_read_at) VALUES ($1, $2, now())`, [message, owner.agentId]);
    const first = (await pool.query<{ t: Date }>('SELECT first_read_at AS t FROM inbound_message_state WHERE inbound_message_id = $1', [message])).rows[0]?.t;
    await pool.query(`UPDATE inbound_message_state SET first_read_at = now() + interval '1 day' WHERE inbound_message_id = $1`, [message]);
    const after = (await pool.query<{ t: Date }>('SELECT first_read_at AS t FROM inbound_message_state WHERE inbound_message_id = $1', [message])).rows[0]?.t;
    expect(after?.getTime()).toBe(first?.getTime());
    await expect(pool.query(`DELETE FROM inbound_message_state WHERE inbound_message_id = $1`, [message])).rejects.toThrow();
  });
});
