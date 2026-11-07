/**
 * 웹훅 outbox — enqueue 멱등성(AC-d3 "1회"), SKIP LOCKED 집기, 임대 만료 재집기, 펜싱, 종단 동결.
 *
 * `claimDue` 는 테이블 전체에서 기한이 된 행을 집는다. 테스트는 정리를 하지 않으므로(DELETE 가
 * 막혀 있다) **자기 행 id 로만 걸러서** 단언한다. 시각은 1970 년대를 쓴다 — 실제 워커가 집을
 * 일이 없고, 앞선 테스트·실행이 남긴 pending 행은 디스패처 테스트가 가짜 전송단(200)으로
 * 종단시킨다(응답은 이벤트 id 로 갈라 그 행들이 단언을 흔들지 않게 한다).
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import {
  WebhookEndpointRejectedError,
  createPostgresWebhookOutbox,
  enqueueWebhookEvent,
  insertWebhookEndpoint,
} from '../../../src/db/repositories/webhook-store';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { dispatchDueWebhooks } from '../../../src/webhooks/dispatcher';
import { approvalExpiredEvent, messageSentEvent } from '../../../src/webhooks/events';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool } from '../db/support/harness';

const RING = parseHmacKeyring(`w1:${randomBytes(32).toString('base64url')}`, 'TEST');
const LEASE_MS = 60_000;

let clock = Date.UTC(1971, 0, 1) + Math.floor(Math.random() * 1e9);
/** 테스트마다 겹치지 않는 옛 시각. */
function epoch(): Date {
  clock += 10 * 24 * 3_600_000;
  return new Date(clock);
}

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

async function setup(endpoints = 1) {
  const pool = testPool();
  const fixture = await seedFixture(pool);
  const ids: string[] = [];
  for (let i = 0; i < endpoints; i += 1) {
    ids.push(await insertWebhookEndpoint(pool, { agentId: fixture.agentId, url: `https://hooks${i}.example.com/atmark`, secretKid: 'w1' }));
  }
  return { pool, fixture, endpointIds: ids };
}

async function deliveriesOf(endpointId: string) {
  const result = await testPool().query<{ id: string; event_id: string; status: string; attempt_count: number; body: string }>(
    'SELECT id, event_id, status, attempt_count, body FROM webhook_deliveries WHERE endpoint_id = $1',
    [endpointId],
  );
  return result.rows;
}

describe.skipIf(!DATABASE_AVAILABLE)('webhook_endpoints', () => {
  it('https 가 아니거나 내부 주소면 저장소가 거부한다(라우트가 빠뜨려도 바닥)', async () => {
    const { pool, fixture } = await setup(0);
    for (const url of ['http://hooks.example.com/', 'https://169.254.169.254/', 'https://localhost/']) {
      await expect(insertWebhookEndpoint(pool, { agentId: fixture.agentId, url, secretKid: 'w1' })).rejects.toThrow(
        WebhookEndpointRejectedError,
      );
    }
  });

  it('DB CHECK 도 https 를 요구한다 — 저장소를 거치지 않은 INSERT 도 막힌다', async () => {
    const { pool, fixture } = await setup(0);
    await expect(
      pool.query(`INSERT INTO webhook_endpoints (agent_id, url, secret_kid) VALUES ($1, 'http://x.example.com/', 'w1')`, [
        fixture.agentId,
      ]),
    ).rejects.toThrow(/check constraint/);
  });

  it('agent_id 는 불변이다 — 이벤트 스트림을 다른 소유자에게 돌릴 수 없다', async () => {
    const { pool, endpointIds } = await setup(1);
    const other = await seedFixture(pool);
    // 앱 롤은 webhook_endpoints UPDATE 가 없다(202609230750). 권한을 가진 롤(소유자)은 트리거가 막는다.
    await expect(
      pool.query('UPDATE webhook_endpoints SET agent_id = $2 WHERE id = $1', [endpointIds[0], other.agentId]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      provisioningPool().query('UPDATE webhook_endpoints SET agent_id = $2 WHERE id = $1', [endpointIds[0], other.agentId]),
    ).rejects.toThrow(/immutable column/);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('webhook_deliveries — outbox', () => {
  it('같은 사건의 enqueue 3회(동시) → 엔드포인트당 1행 (AC-d3 의 "1회")', async () => {
    const { pool, fixture, endpointIds } = await setup(1);
    const input = { agentId: fixture.agentId, approvalId: randomUUID(), expiredAt: epoch(), messageIds: [] };
    const counts = await Promise.all([
      enqueueWebhookEvent(pool, approvalExpiredEvent(input), epoch()),
      enqueueWebhookEvent(pool, approvalExpiredEvent(input), epoch()),
      enqueueWebhookEvent(pool, approvalExpiredEvent(input), epoch()),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await deliveriesOf(endpointIds[0] ?? '')).toHaveLength(1);
  });

  it('엔드포인트가 둘이면 행 둘, event_id 는 같다(수신측 멱등 키) · 비활성 엔드포인트는 건너뛴다', async () => {
    const { pool, fixture, endpointIds } = await setup(3);
    await provisioningPool().query('UPDATE webhook_endpoints SET disabled_at = now() WHERE id = $1', [endpointIds[2]]);
    const event = messageSentEvent({ agentId: fixture.agentId, messageId: randomUUID(), sentAt: epoch() });
    expect(await enqueueWebhookEvent(pool, event, epoch())).toBe(2);
    const [a] = await deliveriesOf(endpointIds[0] ?? '');
    const [b] = await deliveriesOf(endpointIds[1] ?? '');
    expect(a?.event_id).toBe(event.eventId);
    expect(b?.event_id).toBe(event.eventId);
    expect(a?.body).toBe(event.body); // text 저장 — 바이트가 그대로다
    expect(await deliveriesOf(endpointIds[2] ?? '')).toHaveLength(0);
  });

  it('집기: 시도 수를 올리고 임대 동안 다시 집히지 않으며, 임대가 풀리면 다시 집힌다. 늦은 결과는 펜싱에 진다', async () => {
    const { pool, fixture, endpointIds } = await setup(1);
    const at = epoch();
    await enqueueWebhookEvent(pool, messageSentEvent({ agentId: fixture.agentId, messageId: randomUUID(), sentAt: at }), at);
    const [row] = await deliveriesOf(endpointIds[0] ?? '');
    if (row === undefined) throw new Error('행 없음');
    const outbox = createPostgresWebhookOutbox(pool);
    const mine = (claims: readonly { deliveryId: string }[]) => claims.filter((c) => c.deliveryId === row.id);

    const first = mine(await outbox.claimDue(at, 1000, LEASE_MS));
    expect(first).toMatchObject([{ attempt: 1, endpoint: { url: 'https://hooks0.example.com/atmark', secretKid: 'w1', disabled: false } }]);

    // 임대 중: 같은 시각에 다시 물어도 안 집힌다.
    expect(mine(await outbox.claimDue(at, 1000, LEASE_MS))).toEqual([]);

    // 임대 만료(워커가 죽었다): 다시 집히고 시도 2 다.
    const later = new Date(at.getTime() + LEASE_MS);
    expect(mine(await outbox.claimDue(later, 1000, LEASE_MS))).toMatchObject([{ attempt: 2 }]);

    // 시도 1 의 늦은 결과는 펜싱에 진다.
    expect(await outbox.markDelivered(row.id, 1, later, 200)).toBe(false);
    expect(await outbox.markDelivered(row.id, 2, later, 200)).toBe(true);
    expect((await deliveriesOf(endpointIds[0] ?? ''))[0]?.status).toBe('delivered');
  });

  it('종단 행은 다시 pending 이 될 수 없다', async () => {
    const { pool, fixture, endpointIds } = await setup(1);
    const at = epoch();
    await enqueueWebhookEvent(pool, messageSentEvent({ agentId: fixture.agentId, messageId: randomUUID(), sentAt: at }), at);
    const [row] = await deliveriesOf(endpointIds[0] ?? '');
    if (row === undefined) throw new Error('행 없음');
    const outbox = createPostgresWebhookOutbox(pool);
    await outbox.claimDue(at, 1000, LEASE_MS);
    expect(await outbox.markDead(row.id, 1, at, 'blocked_destination', null)).toBe(true);
    await expect(
      pool.query(`UPDATE webhook_deliveries SET status = 'pending', dead_at = NULL WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/terminal/);
    await expect(pool.query('DELETE FROM webhook_deliveries WHERE id = $1', [row.id])).rejects.toThrow(/permission denied/);
  });

  it('본문은 불변이다 — 재시도가 다른 바이트를 보낼 수 없다', async () => {
    const { pool, fixture, endpointIds } = await setup(1);
    const at = epoch();
    await enqueueWebhookEvent(pool, messageSentEvent({ agentId: fixture.agentId, messageId: randomUUID(), sentAt: at }), at);
    const [row] = await deliveriesOf(endpointIds[0] ?? '');
    // 앱 롤은 outbox 컬럼만 UPDATE 한다(202609230750 — 컬럼 단위). 권한을 가진 롤(소유자)은 트리거가 막는다.
    await expect(pool.query(`UPDATE webhook_deliveries SET body = '{}' WHERE id = $1`, [row?.id])).rejects.toThrow(/permission denied/);
    await expect(provisioningPool().query(`UPDATE webhook_deliveries SET body = '{}' WHERE id = $1`, [row?.id])).rejects.toThrow(
      /immutable column/,
    );
  });

  it('디스패처 + 실제 outbox + 가짜 전송단: 500 → 재시도 기록, 다음 기한에 200 → delivered', async () => {
    const { pool, fixture, endpointIds } = await setup(1);
    const at = epoch();
    await enqueueWebhookEvent(pool, messageSentEvent({ agentId: fixture.agentId, messageId: randomUUID(), sentAt: at }), at);
    const [row] = await deliveriesOf(endpointIds[0] ?? '');
    if (row === undefined) throw new Error('행 없음');

    // 다른 테스트가 남긴 기한 지난 행도 함께 집힌다 — 응답은 **이 행의 이벤트 id** 로만 가른다.
    let mineSeen = 0;
    const deps = {
      outbox: createPostgresWebhookOutbox(pool),
      resolve: async () => [{ address: '93.184.215.14', family: 4 as const }],
      keyring: RING,
      transport: {
        post: async (request: { headers: Readonly<Record<string, string>> }) => {
          if (request.headers['webhook-id'] !== row.event_id) return { kind: 'response' as const, status: 200 };
          mineSeen += 1;
          return { kind: 'response' as const, status: mineSeen === 1 ? 500 : 200 };
        },
      },
    };

    const firstRound = (await dispatchDueWebhooks(deps, at, { limit: 1000 })).filter((r) => r.deliveryId === row.id);
    expect(firstRound).toMatchObject([{ outcome: 'retry_scheduled', errorKind: 'http_status', httpStatus: 500 }]);
    const retry = await pool.query<{ next_attempt_at: Date; last_error: string }>(
      'SELECT next_attempt_at, last_error FROM webhook_deliveries WHERE id = $1',
      [row.id],
    );
    expect(retry.rows[0]?.next_attempt_at.getTime()).toBe(at.getTime() + 30_000);
    expect(retry.rows[0]?.last_error).toBe('http_status');

    const secondRound = (await dispatchDueWebhooks(deps, new Date(at.getTime() + 30_000), { limit: 1000 })).filter(
      (r) => r.deliveryId === row.id,
    );
    expect(secondRound).toMatchObject([{ outcome: 'delivered' }]);
    expect((await deliveriesOf(endpointIds[0] ?? ''))[0]).toMatchObject({ status: 'delivered', attempt_count: 2 });
  });
});
