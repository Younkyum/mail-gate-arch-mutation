/**
 * `thread-store` 의 겹을 **따로** 시험한다(검증 V2 낮음). 해석기(`resolve.ts`)는 포트를 믿지 않고 다시 거르므로,
 * 소비자를 거친 시나리오로는 이 포트의 범위·매핑이 틀려도 초록이다 — 여기서는 포트만 본다. 실제 Postgres.
 *
 *   - 에이전트 범위: 다른 에이전트의 발신·수신 행은 같은 키로도 나오지 않는다. 어느 한 조회의 `agent_id = $1` 을
 *     지우면 빨갛다.
 *   - `sent` 매핑: 나가지 않은(`pending`) 발신 행은 `sent: false`, 나간 행만 `true`. 매핑을 `true` 로 되돌리면 빨갛다.
 *   - `senderAuthenticated` 매핑: DMARC fail 수신 행은 `false`.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import { createPostgresGateStores } from '../../../src/db/repositories';
import { createPostgresThreadLookup } from '../../../src/db/repositories/thread-store';
import type { InboundMessageRow } from '../../../src/db/schema';
import type { HeaderLookupKey } from '../../../src/mail/thread/resolve';
import { closeTestPool, DATABASE_AVAILABLE, hex64, seedFixture, testPool } from '../db/support/harness';
import { consumerDeps, deliver, eml, newObjectStore, newSesMessageId } from './support';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

describe.skipIf(!DATABASE_AVAILABLE)('thread-store — 포트 자신의 겹', () => {
  async function scene() {
    const pool = testPool();
    const owner = await seedFixture(pool);
    const other = await seedFixture(pool);
    const messages = createPostgresOutboundMessageStore(pool);
    const outHeader = `<${randomUUID()}@atmark.ai>`;
    const inserted = await messages.insertOrReplay({
      agentId: owner.agentId,
      fromAddress: owner.address,
      subject: '견적',
      messageIdHeader: outHeader,
      idempotencyKey: `ts-${randomUUID()}`,
      requestHash: hex64(),
      recipientCount: 1,
      recipients: ['bob@partner.example'],
      threadId: null,
    });
    const inHeader = `<${randomUUID()}@partner.example>`;
    const sesMessageId = newSesMessageId();
    await deliver(consumerDeps(pool, newObjectStore()), eml({ from: 'bob@partner.example', messageId: inHeader }), {
      sesMessageId,
      recipients: [owner.address],
      dmarc: 'FAIL',
      commonFrom: ['bob@partner.example'],
    });
    const inbound = (
      await pool.query<InboundMessageRow>('SELECT * FROM inbound_messages WHERE agent_id = $1 AND ses_message_id = $2', [
        owner.agentId,
        sesMessageId,
      ])
    ).rows[0];
    if (inbound === undefined) throw new Error('수신 행이 없다');
    const keys: HeaderLookupKey[] = [
      { kind: 'message_id_header', value: outHeader },
      { kind: 'message_id_header', value: inHeader },
    ];
    return { pool, owner, other, outboundId: inserted.message.id, inbound, keys, lookup: createPostgresThreadLookup(pool) };
  }

  it('에이전트 범위 — 같은 키여도 다른 에이전트로는 한 행도 나오지 않는다(발신·수신 둘 다)', async () => {
    const { owner, other, keys, lookup } = await scene();
    // 비공허성: 주인 에이전트로는 둘 다 나온다.
    expect((await lookup.findByHeaderKeys(owner.agentId, keys, 'bob@partner.example')).map((m) => m.direction).sort()).toEqual(['inbound', 'outbound']);
    expect(await lookup.findByHeaderKeys(other.agentId, keys, 'bob@partner.example')).toEqual([]);
  });

  it('`sent` — 나가지 않은 발신 행은 false, 나간 뒤에만 true', async () => {
    const { pool, owner, outboundId, keys, lookup } = await scene();
    const outboundOf = async () => (await lookup.findByHeaderKeys(owner.agentId, keys, 'bob@partner.example')).find((m) => m.direction === 'outbound');
    expect(await outboundOf()).toMatchObject({ messageId: outboundId, sent: false, senderAuthenticated: true });

    const leases = createPostgresGateStores(pool).leases;
    const leaseId = randomUUID();
    const now = new Date();
    expect(await leases.acquire({ messageId: outboundId, leaseId, now, ttlSeconds: 60 })).toBe(true);
    expect(await outboundOf()).toMatchObject({ sent: false }); // dispatching 도 아직 나간 것이 아니다
    expect(await leases.settleSent(outboundId, leaseId, `ses-${randomUUID()}`, now)).toBe(true);
    expect(await outboundOf()).toMatchObject({ sent: true });
  });

  it('`senderAuthenticated` — DMARC fail 수신 행은 false 로 나온다(해석기가 근거에서 뺀다)', async () => {
    const { owner, inbound, keys, lookup } = await scene();
    expect(inbound.from_authenticated).toBe(false);
    const found = (await lookup.findByHeaderKeys(owner.agentId, keys, 'bob@partner.example')).find((m) => m.direction === 'inbound');
    expect(found).toMatchObject({ messageId: inbound.id, sender: 'bob@partner.example', senderAuthenticated: false, sent: true });
  });
});
