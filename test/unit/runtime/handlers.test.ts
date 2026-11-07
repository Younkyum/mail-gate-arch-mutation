/**
 * Lambda 핸들러 — **SQS 부분 배치 실패**와 스케줄 골격. 소비자는 **실제 소비자**이고 저장소만 가짜다.
 *
 *   - ★ 결말 `failed` 만 `batchItemFailures` 에 오른다 — `unparsable`·`ignored`·`recorded`·`duplicate` 는 지운다.
 *   - ★ 한 레코드의 예외(계약 위반)는 그 레코드만 재전달한다 — 배치 전체가 아니다.
 *   - ★ 조립 실패는 던진다 — 아무것도 처리하지 않았으므로 배치 전체 재전달이 옳다.
 *   - 스케줄 핸들러는 결말별 개수만 돌려주고, 워커가 던지면 다시 던진다(호출이 실패로 기록돼야 알람이 산다).
 */

import { describe, expect, it } from 'vitest';

import type { RecordOutcome, SesEventStore } from '../../../src/db/repositories/ses-event-store';
import type { SesEvent } from '../../../src/mail/events/ses-event';
import { ATMARK_MESSAGE_ID_TAG } from '../../../src/mail/events/tag';
import { createApprovalExpiryHandler } from '../../../src/runtime/handlers/approval-expiry';
import { createInboundHandler } from '../../../src/runtime/handlers/inbound';
import { createSesEventsHandler } from '../../../src/runtime/handlers/ses-events';
import { createWebhookDispatcherHandler } from '../../../src/runtime/handlers/webhook-dispatcher';
import { consumeSqsBatch, type LambdaContext } from '../../../src/runtime/lambda';
import type { InboundConsumerDependencies } from '../../../src/workers/inbound-consumer';
import type { WebhookDispatcherDependencies } from '../../../src/workers/webhook-dispatcher';
import type { ApprovalExpiryDependencies } from '../../../src/workers/approval-expiry';
import { SNIPPET_RETENTION_BATCH } from '../../../src/db/repositories/snippet-retention';
import { newSesMessageId, notification } from '../../integration/inbound/support';
import { TEST_DLP_KEYRING } from '../../support/injection-doubles';

const NOW = new Date('2026-09-23T00:00:00.000Z');

function context(): LambdaContext {
  return {
    awsRequestId: 'req',
    invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:x',
    callbackWaitsForEmptyEventLoop: true,
  };
}

function sesEventBody(messageId: string, eventType = 'Delivery'): string {
  return JSON.stringify({
    eventType,
    mail: {
      timestamp: '2026-09-22T11:59:00.000Z',
      messageId: `010c01a0c8371fce-${messageId.slice(0, 4)}`,
      tags: { [ATMARK_MESSAGE_ID_TAG]: [messageId] },
    },
  });
}

/** `record` 가 메시지 id 로 결말을 고른다 — 특정 레코드만 DB 실패를 흉내 낸다. */
function sesStore(failFor: string): SesEventStore & { readonly recorded: SesEvent[]; freshnessCalls: number } {
  const recorded: SesEvent[] = [];
  const seen = new Set<string>();
  return {
    recorded,
    freshnessCalls: 0,
    record(event: SesEvent): Promise<RecordOutcome> {
      if (event.messageId === failFor) return Promise.reject(new Error('connection terminated'));
      if (seen.has(event.dedupeKey)) return Promise.resolve('duplicate');
      seen.add(event.dedupeKey);
      recorded.push(event);
      return Promise.resolve('recorded');
    },
    findSendEvidence: () => Promise.resolve(null),
    freshness() {
      this.freshnessCalls += 1;
      return Promise.resolve({ lastEventAt: NOW, lastSentAt: NOW });
    },
    recordSystemMailSuppression: () => Promise.resolve('recorded'),
    checkPlatformReputation: () => Promise.resolve(null),
  };
}

describe('★ SQS 부분 배치 실패 — ses-events (실제 소비자)', () => {
  it('failed 만 재전달한다: recorded·duplicate·unparsable·ignored 는 지운다', async () => {
    const ok = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
    const broken = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const handler = createSesEventsHandler(() => Promise.resolve({ deps: { events: sesStore(broken), now: () => NOW } }));
    const ctx = context();
    const response = await handler(
      {
        Records: [
          { messageId: 'm-ok', body: sesEventBody(ok) },
          { messageId: 'm-db-down', body: sesEventBody(broken) },
          { messageId: 'm-dup', body: sesEventBody(ok) },
          { messageId: 'm-garbage', body: '{"not":"an event"' },
          { messageId: 'm-ignored', body: sesEventBody(ok, 'Open') },
        ],
      },
      ctx,
    );
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm-db-down' }]);
    expect(ctx.callbackWaitsForEmptyEventLoop).toBe(false);
  });

  it.each([
    ['0개', []],
    ['1개', ['m-1']],
    ['여러 개(실패 섞임)', ['m-1', 'm-2', 'm-db-down']],
  ])('소비자 건강 판정(freshness)은 배치마다 정확히 한 번 — 레코드 %s', async (_label, ids) => {
    const broken = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const events = sesStore(broken);
    const handler = createSesEventsHandler(() => Promise.resolve({ deps: { events, now: () => NOW } }));
    const records = ids.map((id) => ({
      messageId: id,
      body: sesEventBody(id === 'm-db-down' ? broken : '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'),
    }));
    await handler({ Records: records }, context());
    expect(events.freshnessCalls).toBe(1);
  });

  it('조립이 실패하면 던진다 — 배치 전체가 재전달된다', async () => {
    const handler = createSesEventsHandler(() => Promise.reject(new Error('secret unavailable')));
    await expect(handler({ Records: [{ messageId: 'm', body: '{}' }] }, context())).rejects.toThrow('secret unavailable');
  });
});

describe('★ SQS 부분 배치 실패 — inbound (실제 소비자)', () => {
  /** 저장소가 전부 일시 장애 — 파싱은 통과한 수신 알림이 `failed` 가 된다. */
  function downDeps(): InboundConsumerDependencies {
    const down = (): Promise<never> => Promise.reject(new Error('S3/DB down'));
    return {
      receipts: new Proxy({}, { get: () => down }) as InboundConsumerDependencies['receipts'],
      threads: new Proxy({}, { get: () => down }) as InboundConsumerDependencies['threads'],
      rawMail: {
        keyFor: (sesMessageId: string) => `inbound/raw/${sesMessageId}`,
        get: down,
      } as unknown as InboundConsumerDependencies['rawMail'],
      artifacts: new Proxy({}, { get: () => down }) as InboundConsumerDependencies['artifacts'],
      trust: new Proxy({}, { get: () => down }) as InboundConsumerDependencies['trust'],
      inboundPolicy: new Proxy({}, { get: () => down }) as InboundConsumerDependencies['inboundPolicy'],
      watch: new Proxy({}, { get: () => down }) as InboundConsumerDependencies['watch'],
      signups: new Proxy({}, { get: () => down }) as InboundConsumerDependencies['signups'],
      contact: new Proxy({}, { get: () => down }) as InboundConsumerDependencies['contact'],
      dlpKeys: TEST_DLP_KEYRING,
    };
  }

  it('일시 장애(failed)만 재전달하고, 파싱 불가·수신 알림 아님은 지운다', async () => {
    const handler = createInboundHandler(() => Promise.resolve({ deps: downDeps() }));
    const sesMessageId = newSesMessageId();
    const response = await handler(
      {
        Records: [
          { messageId: 'r-valid-but-store-down', body: notification({ sesMessageId, recipients: ['agent@atmark.ai'] }) },
          { messageId: 'r-garbage', body: 'garbage' },
          {
            messageId: 'r-subscription',
            body: JSON.stringify({ Type: 'SubscriptionConfirmation', MessageId: 'x', Message: 'confirm' }),
          },
        ],
      },
      context(),
    );
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'r-valid-but-store-down' }]);
  });
});

describe('consumeSqsBatch — 계약 위반(소비자가 던짐)은 그 레코드만', () => {
  it('던진 레코드만 실패, 나머지는 계속 처리된다(순차)', async () => {
    const order: string[] = [];
    const response = await consumeSqsBatch(
      'test',
      { Records: [{ messageId: 'a', body: '' }, { messageId: 'b', body: '' }, { messageId: 'c', body: '' }] },
      (record) => {
        order.push(record.messageId);
        if (record.messageId === 'b') return Promise.reject(new Error('boom'));
        return Promise.resolve(record.messageId === 'c' ? 'failed' : 'recorded');
      },
      (outcome) => outcome === 'failed',
    );
    expect(order).toEqual(['a', 'b', 'c']);
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'b' }, { itemIdentifier: 'c' }]);
  });
});

describe('스케줄 핸들러', () => {
  it('webhook-dispatcher — 기한 된 전달이 없으면 빈 개수', async () => {
    const deps = {
      outbox: { claimDue: () => Promise.resolve([]) },
      now: () => NOW,
    } as unknown as WebhookDispatcherDependencies;
    const handler = createWebhookDispatcherHandler(() => Promise.resolve({ deps }));
    await expect(handler({}, context())).resolves.toEqual({ routeId: 'webhook_dispatcher', counts: {} });
  });

  it('approval-expiry — 워커가 던지면 다시 던진다(삼키지 않는다)', async () => {
    const deps = {
      approvals: new Proxy({}, { get: () => () => Promise.reject(new Error('db down')) }),
      now: () => NOW,
    } as unknown as ApprovalExpiryDependencies;
    const handler = createApprovalExpiryHandler(() => Promise.resolve({ deps }));
    await expect(handler({}, context())).rejects.toThrow('db down');
  });

  it('approval-expiry — 같은 호출에서 발신 스니펫 보존 스윕(검증 F3)도 돈다 · 배치 상한을 넘기지 않는다 · 개수를 보고한다', async () => {
    const limits: number[] = [];
    const deps = {
      approvals: {
        listDue: () => Promise.resolve([]),
        oldestPendingCreatedAt: () => Promise.resolve(null),
        countPendingOverdue: () => Promise.resolve(0),
      },
      snippets: {
        sweep: (limit: number) => {
          limits.push(limit);
          return Promise.resolve({ cleared: 7, stuckIds: [] });
        },
      },
      // `/org-api` 창 행 보존(ADR-0010 L5) — 같은 호출에서 돈다.
      orgApiWindows: { purge: () => Promise.resolve(3) },
      // 로그인·가입 코드 verify 시도 원장 보존(2026-09-28 L3) — 같은 호출에서 돈다.
      loginCodeAttempts: { purge: () => Promise.resolve(5) },
      // 호스팅 운영자 콘솔(202609290500) — 보존·만료·census 가 같은 호출에서 돈다.
      ops: { purge: () => Promise.resolve(2), expire: () => Promise.resolve(1), census: () => Promise.resolve(null) },
      injectionSignals: { purge: () => Promise.resolve(5) },
      complaintHashes: { purge: () => Promise.resolve(0) },
      // 실시간 연결 스윕(묶음 E) — 같은 호출에서 돈다.
      realtimeConnections: { sweep: () => Promise.resolve({ closed: 4, purged: 6 }) },
      now: () => NOW,
    } as unknown as ApprovalExpiryDependencies;
    const handler = createApprovalExpiryHandler(() => Promise.resolve({ deps }));
    const report = await handler({}, context());
    expect(report.counts['snippets_cleared']).toBe(7);
    expect(report.counts['org_api_windows_purged']).toBe(3);
    expect(report.counts['login_code_attempts_purged']).toBe(5);
    expect([report.counts['ops_records_purged'], report.counts['ops_requests_expired']]).toEqual([2, 1]);
    // 인젝션 구조 방어 신호 보존(ADR-0016) — 같은 호출에서 돈다.
    expect(report.counts['injection_signals_purged']).toBe(5);
    expect([report.counts['realtime_connections_closed'], report.counts['realtime_connections_purged']]).toEqual([4, 6]);
    expect(limits).toEqual([SNIPPET_RETENTION_BATCH]);
  });
});
