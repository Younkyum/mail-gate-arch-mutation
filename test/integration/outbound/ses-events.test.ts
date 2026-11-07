/**
 * `ses_events` — **멱등성의 집행은 DB 다** (ADR-0004).
 *
 * `test/unit/workers/ses-event-consumer.test.ts` 는 소비자가 `recorded`/`duplicate` 를
 * 올바로 **구분해 보고하는가**를 본다. 그 위에서 도는 가짜 저장소는 `Set` 하나이고,
 * `Set` 은 경합하지 않는다. 진짜 명제 — *"같은 이벤트가 동시에 세 번 들어와도 행은
 * 하나"* — 는 `ses_events_dedupe_key` 유니크 인덱스가 참으로 만들고, 그것은 실제
 * Postgres 위에서만 확인된다.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { createPostgresSesEventStore } from '../../../src/db/repositories/ses-event-store';
import { evaluateConsumerHealth } from '../../../src/mail/events/health';
import type { SesEvent } from '../../../src/mail/events/ses-event';
import {
  closeTestPool,
  DATABASE_AVAILABLE,
  seedFixture,
  seedMessage,
  testPool,
} from '../db/support/harness';

/** `dedupe_key` CHECK 는 sha256 hex 64자를 요구한다. */
function dedupeKey(): string {
  return `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
}

function event(overrides: Partial<SesEvent> = {}): SesEvent {
  return {
    eventType: 'send',
    messageId: null,
    sesMessageId: `ses-${randomUUID()}`,
    eventAt: new Date(),
    dedupeKey: dedupeKey(),
    ...overrides,
  };
}

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

describe.skipIf(!DATABASE_AVAILABLE)('ses_events — at-least-once 를 유니크 인덱스가 죽인다', () => {
  it('같은 dedupe_key 의 3회 재전달 → 행 1개', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'dispatching' });
    const store = createPostgresSesEventStore(pool);
    const incoming = event({ messageId, dedupeKey: dedupeKey() });

    const outcomes = [
      await store.record(incoming),
      await store.record(incoming),
      await store.record(incoming),
    ];

    expect(outcomes).toEqual(['recorded', 'duplicate', 'duplicate']);
    const rows = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ses_events WHERE message_id = $1',
      [messageId],
    );
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('**동시** 3회도 행 1개다 — 선조회였다면 여기서 셋 다 들어간다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'dispatching' });
    const store = createPostgresSesEventStore(pool);
    const incoming = event({ messageId, dedupeKey: dedupeKey() });

    const outcomes = await Promise.all([
      store.record(incoming),
      store.record(incoming),
      store.record(incoming),
    ]);

    expect(outcomes.filter((outcome) => outcome === 'recorded')).toHaveLength(1);
  });

  it('조인할 수 없는 이벤트(message_id 없음)도 기록된다 — 배선 사고의 신호가 남는다', async () => {
    const pool = testPool();
    const store = createPostgresSesEventStore(pool);
    expect(await store.record(event({ messageId: null }))).toBe('recorded');
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('findSendEvidence — "그 메일은 나갔는가"', () => {
  it('이벤트가 없으면 null 이다 — **예외가 아니다**', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'dispatching' });
    expect(await createPostgresSesEventStore(pool).findSendEvidence(messageId)).toBeNull();
  });

  it('Send 가 있으면 sesMessageId 와 함께 돌려준다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'dispatching' });
    const store = createPostgresSesEventStore(pool);

    await store.record(event({ messageId, eventType: 'send', sesMessageId: 'ses-send-1' }));

    expect(await store.findSendEvidence(messageId)).toEqual({
      eventType: 'send',
      sesMessageId: 'ses-send-1',
    });
  });

  it('Send 와 Delivery 가 모두 있으면 **Delivery 를 고른다** — 더 강한 사실이다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'dispatching' });
    const store = createPostgresSesEventStore(pool);

    await store.record(event({ messageId, eventType: 'send', sesMessageId: 'ses-send-1' }));
    await store.record(event({ messageId, eventType: 'delivery', sesMessageId: 'ses-send-1' }));

    expect((await store.findSendEvidence(messageId))?.eventType).toBe('delivery');
  });

  it('Bounce·Complaint 만 있으면 증거가 아니다 — 목록은 send·delivery 뿐이다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId, { status: 'dispatching' });
    const store = createPostgresSesEventStore(pool);

    await store.record(event({ messageId, eventType: 'bounce' }));
    await store.record(event({ messageId, eventType: 'complaint' }));

    expect(await store.findSendEvidence(messageId)).toBeNull();
  });

  it('다른 메시지의 증거를 가져오지 않는다 — 조인 키가 섞이면 ADR-0004 이 무의미하다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const mine = await seedMessage(pool, fixture.agentId, { status: 'dispatching' });
    const other = await seedMessage(pool, fixture.agentId, { status: 'dispatching' });
    const store = createPostgresSesEventStore(pool);

    await store.record(event({ messageId: other, eventType: 'send', sesMessageId: 'ses-other' }));

    expect(await store.findSendEvidence(mine)).toBeNull();
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('freshness — 소비자 정지 감지의 입력', () => {
  it('두 시각을 한 왕복으로 읽는다 — 나눠 읽으면 정상 동작이 정지로 오판된다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const sentAt = new Date();
    await seedMessage(pool, fixture.agentId, { status: 'sent', sentAt });

    const freshness = await createPostgresSesEventStore(pool).freshness();

    // 이 테스트 DB 는 다른 테스트와 행을 공유하므로 **절대값이 아니라 성질**을 본다.
    expect(freshness.lastSentAt).not.toBeNull();
    expect((freshness.lastSentAt as Date).getTime()).toBeGreaterThanOrEqual(sentAt.getTime());

    // 그리고 그 두 값이 판정 함수에 그대로 먹힌다 — 판정 자체는 I/O 없는 단위 테스트의 몫이다.
    expect(['ok', 'idle', 'stalled']).toContain(evaluateConsumerHealth(freshness, new Date()).kind);
  });
});
