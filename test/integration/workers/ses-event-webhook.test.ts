/**
 * ses-events 소비자 → 발송 결과 웹훅(메일 기본기 1차 A4) — **실제 Postgres 위에서**, 소비자 진입점(`consumeSesEvent`)부터.
 *
 *   - AC-A4-1 구독자에게만 1행(옛 엔드포인트·구독 안 한 에이전트 0행) · SNS 재전달은 `duplicate` 이고 웹훅 0행 추가.
 *   - AC-A4-2 본문에 `@`·`did:`·제목 0 · `recipient_positions` = 소문자 수신자 전원을 코드포인트 순으로 정렬한 배열의 위치, 못 찾은 주소 생략.
 *   - AC-A4-4 적재 실패 주입 → `ses_events` 는 커밋 · 그 사건의 outbox 0행(savepoint 안에서 이미 적힌 행까지 되돌린다) · 메트릭 1.
 *
 * 적재 시각은 먼 미래(2999년)다 — 다른 파일의 디스패처 테스트가 이 파일의 pending 행을 집지 않는다. 정리를 하지 않는다(자기 에이전트만 본다).
 */

import { createHash, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { createPostgresSesEventStore, enqueueOutcomeWebhook } from '../../../src/db/repositories/ses-event-store';
import { insertWebhookEndpoint } from '../../../src/db/repositories/webhook-store';
import type { AgentId } from '../../../src/db/schema';
import { ATMARK_MESSAGE_ID_TAG, toMessageIdTagValue } from '../../../src/mail/events/tag';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import type { WebhookEventType } from '../../../src/webhooks/events';
import { consumeSesEvent } from '../../../src/workers/ses-event-consumer';
import { closeTestPool, DATABASE_AVAILABLE, seedFixture, seedMessage, testPool } from '../db/support/harness';

const FUTURE = new Date('2999-01-01T00:00:00.000Z');
const OUTCOMES: readonly WebhookEventType[] = ['message.delivered', 'message.bounced', 'message.complained'];

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

/** 수신자 셋 — 정렬하면 [amy, bob-x, zed] 순이다('-'(0x2d) < 'x'). 입력 순서는 일부러 섞는다. */
const RECIPIENTS = ['zed@example.net', 'bob-x@example.com', 'amy@example.org'];

async function world(options: { readonly subscribe?: readonly WebhookEventType[] | null } = {}) {
  const pool = testPool();
  const fixture = await seedFixture(pool);
  const messageId = await seedMessage(pool, fixture.agentId, { status: 'sent', recipientCount: RECIPIENTS.length });
  for (const address of RECIPIENTS) {
    await pool.query('INSERT INTO outbound_recipients (message_id, address) VALUES ($1, $2)', [messageId, address]);
  }
  const url = () => `https://hooks-${randomUUID().slice(0, 8)}.example.com/atmark`;
  const subscriber =
    options.subscribe === null
      ? null
      : await insertWebhookEndpoint(pool, { agentId: fixture.agentId, url: url(), secretKid: 'w1', eventTypes: options.subscribe ?? OUTCOMES });
  const legacy = await insertWebhookEndpoint(pool, { agentId: fixture.agentId, url: url(), secretKid: 'w1' });
  return { pool, agentId: fixture.agentId, messageId, subscriber, legacy };
}

type Detail = Record<string, unknown>;

/** SES 가 SNS 로 싣는 모양(봉투 + 문자열 본문). 수신자 주소는 `mail.destination` 에도 있다 — 본문에 새지 않는지 함께 본다. */
function sesNotification(messageId: string, eventType: 'Delivery' | 'Bounce' | 'Complaint' | 'Send', detail: Detail = {}): string {
  const key = eventType.charAt(0).toLowerCase() + eventType.slice(1);
  const body = JSON.stringify({
    eventType,
    mail: {
      timestamp: '2026-09-26T01:00:00.000Z',
      messageId: `ses-${randomUUID()}`,
      source: 'agent@atmark.ai',
      destination: RECIPIENTS,
      commonHeaders: { subject: '비밀 제목 — 3분기 정산' },
      tags: { [ATMARK_MESSAGE_ID_TAG]: [toMessageIdTagValue(messageId)] },
    },
    [key]: { timestamp: '2026-09-26T01:00:05.000Z', ...detail },
  });
  return JSON.stringify({ Type: 'Notification', MessageId: `sns-${randomUUID()}`, Message: body });
}

function sesDedupeKeyOf(notification: string): string {
  const body = (JSON.parse(notification) as { Message: string }).Message;
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function consume(pool: Pool, notification: string, store = createPostgresSesEventStore(pool)) {
  return consumeSesEvent({ events: store, now: () => FUTURE }, { receiptId: `r-${randomUUID()}`, body: notification });
}

async function outbox(pool: Pool, endpointId: string | null) {
  if (endpointId === null) return [];
  const result = await pool.query<{ event_type: string; dedupe_key: string; body: string }>(
    `SELECT event_type::text AS event_type, dedupe_key, body FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at, id`,
    [endpointId],
  );
  return result.rows;
}

async function outboxOfAgent(pool: Pool, agentId: AgentId) {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE e.agent_id = $1`,
    [agentId],
  );
  return result.rows[0]?.n ?? -1;
}

describe.skipIf(!DATABASE_AVAILABLE)('ses-events → 발송 결과 웹훅 (AC-A4-1 · AC-A4-2)', () => {
  it('Delivery → 구독자에게만 message.delivered 1행 · 옛 엔드포인트 0행 · SNS 재전달은 duplicate 이고 0행 추가', async () => {
    const { pool, messageId, subscriber, legacy } = await world();
    const notification = sesNotification(messageId, 'Delivery', { recipients: ['Amy@Example.org', 'zed@example.net'] });

    expect(await consume(pool, notification)).toBe('recorded');
    expect(await consume(pool, notification)).toBe('duplicate');
    expect(await consume(pool, notification)).toBe('duplicate');

    const rows = await outbox(pool, subscriber);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe('message.delivered');
    expect(rows[0]?.dedupe_key).toBe(`message.delivered:${sesDedupeKeyOf(notification)}`);
    const body = JSON.parse(rows[0]?.body ?? '{}') as { type: string; data: Record<string, unknown> };
    expect(body.type).toBe('message.delivered');
    expect(body.data).toEqual({ message_id: messageId, delivered_at: '2026-09-26T01:00:05.000Z', recipient_positions: [0, 2] });
    expect(await outbox(pool, legacy)).toEqual([]);
  });

  it('Bounce → bounce_type · 못 찾은 주소 생략 · Complaint → message.complained', async () => {
    const { pool, messageId, subscriber } = await world();
    const bounce = sesNotification(messageId, 'Bounce', {
      bounceType: 'Transient',
      bouncedRecipients: [{ emailAddress: 'bob-x@example.com' }, { emailAddress: 'stranger@elsewhere.test' }, { emailAddress: 'zed@example.net' }],
      bouncedRecipientsDiagnostic: 'smtp; 550 5.1.1 user unknown',
    });
    const complaint = sesNotification(messageId, 'Complaint', {
      complainedRecipients: [{ emailAddress: 'amy@example.org' }],
      complaintFeedbackType: 'abuse',
      userAgent: 'Mail/1.0',
    });
    expect(await consume(pool, bounce)).toBe('recorded');
    expect(await consume(pool, complaint)).toBe('recorded');

    const rows = await outbox(pool, subscriber);
    expect(rows.map((row) => row.event_type)).toEqual(['message.bounced', 'message.complained']);
    const [bounced, complained] = rows.map((row) => JSON.parse(row.body) as { data: Record<string, unknown> });
    expect(bounced?.data).toEqual({
      message_id: messageId,
      bounced_at: '2026-09-26T01:00:05.000Z',
      recipient_positions: [1, 2],
      bounce_type: 'transient',
    });
    expect(complained?.data).toEqual({ message_id: messageId, complained_at: '2026-09-26T01:00:05.000Z', recipient_positions: [0] });

    // AC-A4-2 — 주소·DID·제목·진단 문장·UA 가 본문 어디에도 없다.
    // 무작위 식별자(uuid · 32자 hex)는 지우고 본다 — id 에 '550' 이 우연히 들어가 떨어진 적이 있다(2026-09-29).
    for (const row of rows) {
      const text = row.body.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/g, '');
      expect(text).not.toContain('@');
      expect(text).not.toContain('did:');
      expect(text).not.toContain('정산');
      expect(text).not.toContain('550');
      expect(text).not.toContain('abuse');
    }
  });

  it('구독이 한 종류뿐이면 그 종류만 · 구독한 엔드포인트가 없는 에이전트는 0행 · Send 는 웹훅 없음', async () => {
    const only = await world({ subscribe: ['message.bounced'] });
    expect(await consume(only.pool, sesNotification(only.messageId, 'Delivery', { recipients: ['amy@example.org'] }))).toBe('recorded');
    expect(await consume(only.pool, sesNotification(only.messageId, 'Bounce', { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'amy@example.org' }] }))).toBe(
      'recorded',
    );
    expect((await outbox(only.pool, only.subscriber)).map((row) => row.event_type)).toEqual(['message.bounced']);

    const none = await world({ subscribe: null });
    expect(await consume(none.pool, sesNotification(none.messageId, 'Delivery', { recipients: ['amy@example.org'] }))).toBe('recorded');
    expect(await consume(none.pool, sesNotification(none.messageId, 'Send'))).toBe('recorded');
    expect(await outboxOfAgent(none.pool, none.agentId)).toBe(0);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('적재 실패는 기록을 막지 않는다 (AC-A4-4 · savepoint)', () => {
  it('적재가 행을 쓴 뒤 던져도 → ses_events 커밋 · 그 사건의 outbox 0행 · 결과 recorded · 메트릭 atmark.webhook.enqueue_failed 1', async () => {
    const { pool, messageId, subscriber, agentId } = await world();
    // 실제 적재를 끝까지 한 뒤(= outbox 에 행이 적힌 뒤) 던진다 — savepoint 가 이미 적힌 행까지 되돌리는지를 본다.
    const failing = createPostgresSesEventStore(pool, {
      enqueueOutcomeWebhook: async (client, event, type, webhook) => {
        const written = await enqueueOutcomeWebhook(client, event, type, webhook);
        expect(written).toBe(1);
        throw new Error('주입된 적재 실패');
      },
    });
    const notification = sesNotification(messageId, 'Bounce', { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'amy@example.org' }] });

    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const outcome = await consume(pool, notification, failing).finally(() => resetLogSink());

    expect(outcome).toBe('recorded');
    const recorded = await pool.query<{ event_type: string; message_id: string }>(
      'SELECT event_type::text AS event_type, message_id FROM ses_events WHERE dedupe_key = $1',
      [sesDedupeKeyOf(notification)],
    );
    expect(recorded.rows).toEqual([{ event_type: 'bounce', message_id: messageId }]);
    expect(await outbox(pool, subscriber)).toEqual([]);
    expect(await outboxOfAgent(pool, agentId)).toBe(0);
    expect(lines.filter((line) => line.includes('"atmark.webhook.enqueue_failed"'))).toHaveLength(1);
    expect(lines.some((line) => line.includes('ses_event.webhook_enqueue_failed'))).toBe(true);
    expect(lines.join('\n')).not.toContain('amy@example.org');

    // 같은 사건의 재전달은 duplicate 다 — 유실된 웹훅은 되살아나지 않는다(메트릭이 그 사실을 이미 보였다).
    expect(await consume(pool, notification)).toBe('duplicate');
    expect(await outbox(pool, subscriber)).toEqual([]);
  });

  it('SQL 오류 주입(L8) — 적재 안의 `SELECT 1/0` 이 트랜잭션을 aborted(25P02)로 만들어도 ROLLBACK TO SAVEPOINT 가 되살려 기록은 커밋 · 원인(error_kind·error_code)이 로그에 남는다', async () => {
    const { pool, messageId, subscriber, agentId } = await world();
    // 행을 적고 → SQL 오류(22012)를 삼키고 → 다음 문장이 25P02(in_failed_sql_transaction)로 던진다. JS throw 만으로는 볼 수 없는 상태다 —
    //   savepoint 가 없으면 이 트랜잭션은 COMMIT 이 ROLLBACK 이 되고 ses_events 까지 사라진다.
    const failing = createPostgresSesEventStore(pool, {
      enqueueOutcomeWebhook: async (client, event, type, webhook) => {
        expect(await enqueueOutcomeWebhook(client, event, type, webhook)).toBe(1);
        await client.query('SELECT 1/0').catch(() => undefined);
        await client.query('SELECT 1');
        return 1;
      },
    });
    const notification = sesNotification(messageId, 'Delivery', { recipients: ['amy@example.org'] });

    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const outcome = await consume(pool, notification, failing).finally(() => resetLogSink());

    expect(outcome).toBe('recorded');
    const recorded = await pool.query('SELECT 1 FROM ses_events WHERE dedupe_key = $1', [sesDedupeKeyOf(notification)]);
    expect(recorded.rowCount).toBe(1);
    expect(await outbox(pool, subscriber)).toEqual([]);
    expect(await outboxOfAgent(pool, agentId)).toBe(0);
    const warn = lines.find((line) => line.includes('ses_event.webhook_enqueue_failed'));
    expect(JSON.parse(warn ?? '{}')).toMatchObject({ level: 'warn', error_kind: 'error', error_code: '25P02' });
    expect(lines.filter((line) => line.includes('"atmark.webhook.enqueue_failed"'))).toHaveLength(1);
  });

  it('SQL 오류가 적재 밖으로 바로 던져져도(22012) 같은 복구 · error_code 는 SQLSTATE 그대로', async () => {
    const { pool, messageId, subscriber } = await world();
    const failing = createPostgresSesEventStore(pool, {
      enqueueOutcomeWebhook: async (client, event, type, webhook) => {
        await enqueueOutcomeWebhook(client, event, type, webhook);
        await client.query('SELECT 1/0');
        return 1;
      },
    });
    const notification = sesNotification(messageId, 'Complaint', { complainedRecipients: [{ emailAddress: 'amy@example.org' }] });
    const outcome = await failing.record(
      { messageId, eventType: 'complaint', sesMessageId: null, eventAt: new Date('2026-09-26T01:00:05.000Z'), dedupeKey: sesDedupeKeyOf(notification) },
      { recipients: { addresses: ['amy@example.org'], bounceType: null }, now: FUTURE },
    );
    expect(outcome).toEqual({ kind: 'recorded_webhook_failed', errorKind: 'error', errorCode: '22012' });
    expect(await outbox(pool, subscriber)).toEqual([]);
  });

  it('구독이 없으면 트랜잭션 없이 INSERT 한 문장(M3) — 적재 함수가 불리지 않는다', async () => {
    const { pool, messageId } = await world({ subscribe: null });
    let called = 0;
    const store = createPostgresSesEventStore(pool, {
      enqueueOutcomeWebhook: async (client, event, type, webhook) => {
        called += 1;
        return enqueueOutcomeWebhook(client, event, type, webhook);
      },
    });
    expect(await consume(pool, sesNotification(messageId, 'Delivery', { recipients: ['amy@example.org'] }), store)).toBe('recorded');
    expect(called).toBe(0);
  });

  it('bounce 종류를 기록에 남긴다(202610021104 · #13 M3) — 구독이 있든 없든 · bounce 가 아니면 NULL', async () => {
    for (const subscribe of [undefined, null] as const) {
      const { pool, messageId } = await world(subscribe === null ? { subscribe: null } : {});
      expect(await consume(pool, sesNotification(messageId, 'Bounce', { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'amy@example.org' }] }))).toBe('recorded');
      expect(await consume(pool, sesNotification(messageId, 'Bounce', { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'bob-x@example.com' }] }))).toBe('recorded');
      expect(await consume(pool, sesNotification(messageId, 'Delivery', { recipients: ['amy@example.org'] }))).toBe('recorded');
      const rows = await pool.query<{ event_type: string; bounce_type: string | null }>(
        'SELECT event_type::text AS event_type, bounce_type FROM ses_events WHERE message_id = $1 ORDER BY event_type, bounce_type',
        [messageId],
      );
      expect(rows.rows).toEqual([
        { event_type: 'bounce', bounce_type: 'permanent' },
        { event_type: 'bounce', bounce_type: 'transient' },
        { event_type: 'delivery', bounce_type: null },
      ]);
    }
  });

  it('기록 자체가 실패하면(없는 message_id — FK) 트랜잭션 전체가 롤백되고 failed 다 — 재전달이 의미 있는 유일한 실패', async () => {
    const { pool } = await world();
    const orphan = sesNotification(randomUUID(), 'Delivery', { recipients: ['amy@example.org'] });
    expect(await consume(pool, orphan)).toBe('failed');
    const row = await pool.query('SELECT 1 FROM ses_events WHERE dedupe_key = $1', [sesDedupeKeyOf(orphan)]);
    expect(row.rowCount).toBe(0);
  });
});
