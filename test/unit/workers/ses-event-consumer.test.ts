/**
 * `src/workers/ses-event-consumer.ts` — **소비자 자신이 멱등한가, 그리고 조용히 죽지 않는가.**
 *
 * 두 명제가 이 파일의 전부다:
 *
 *   ① **같은 이벤트를 세 번 받아도 기록은 한 벌이다.** SNS/SQS 는 at-least-once 이고,
 *      §4.5 가 발송 경로에 요구한 규율이 그대로 여기 온다. 집행은 DB 유니크 인덱스이므로
 *      여기서는 "소비자가 그 결과를 올바로 **구분해 보고하는가**" 를 본다 —
 *      `recorded` 와 `duplicate` 가 한 값으로 접히면 재전달 급증이 정상으로 보인다.
 *
 *   ② **실패가 세 갈래로 갈린다.** 파싱 불가(재전달 무의미) · DB 실패(재전달 의미 있음) ·
 *      구독 안 함(정상). 한 통에 담으면 poison pill 을 영원히 재시도하거나 일시적
 *      DB 장애로 이벤트를 영영 잃는다.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { ConsumerFreshness } from '../../../src/mail/events/health';
import type { PlatformReputationResult } from '../../../src/mail/events/platform-reputation';
import type { SesEvent, SystemMailSuppression } from '../../../src/mail/events/ses-event';
import { ATMARK_MESSAGE_ID_TAG, ATMARK_NOTIFICATION_ID_TAG } from '../../../src/mail/events/tag';
import type {
  RecordOutcome,
  SesEventRecordOutcome,
  SesEventStore,
  SesEventWebhookInput,
} from '../../../src/db/repositories/ses-event-store';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import {
  consumeSesEvent,
  reportHealth,
  type SesEventConsumerDependencies,
} from '../../../src/workers/ses-event-consumer';

const MESSAGE_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
const NOW = new Date('2026-09-22T12:00:00.000Z');

function body(overrides: { readonly eventType?: string; readonly tagged?: boolean } = {}): string {
  return JSON.stringify({
    eventType: overrides.eventType ?? 'Send',
    mail: {
      timestamp: '2026-09-22T11:59:00.000Z',
      messageId: '010c01a0c8371fce-aaa',
      tags:
        overrides.tagged === false
          ? { 'ses:configuration-set': ['atmark-default'] }
          : { [ATMARK_MESSAGE_ID_TAG]: [MESSAGE_ID] },
    },
  });
}

interface FakeStore extends SesEventStore {
  readonly recorded: SesEvent[];
  readonly suppressed: SystemMailSuppression[];
  /** 평판 판정을 부른 메시지 id(순서대로). */
  readonly reputationChecks: string[];
}

/** `dedupe_key` 유니크 인덱스의 인메모리 대역. **실제 집행은 DB 다** — 여기서는 그 계약만 본다. */
function fakeStore(
  options: {
    readonly recordError?: Error;
    readonly freshnessError?: Error;
    readonly freshness?: ConsumerFreshness;
    readonly reputation?: PlatformReputationResult | null | Error;
  } = {},
): FakeStore {
  const reputationChecks: string[] = [];
  const seen = new Set<string>();
  const recorded: SesEvent[] = [];
  const suppressed: SystemMailSuppression[] = [];
  const suppressedAddresses = new Set<string>();
  return {
    recorded,
    suppressed,
    reputationChecks,
    checkPlatformReputation(messageId: string): Promise<PlatformReputationResult | null> {
      reputationChecks.push(messageId);
      if (options.reputation instanceof Error) return Promise.reject(options.reputation);
      return Promise.resolve(options.reputation ?? null);
    },
    recordSystemMailSuppression(suppression: SystemMailSuppression): Promise<RecordOutcome> {
      if (options.recordError !== undefined) return Promise.reject(options.recordError);
      suppressed.push(suppression);
      const fresh = suppression.addresses.filter((address) => !suppressedAddresses.has(address));
      for (const address of fresh) suppressedAddresses.add(address);
      return Promise.resolve(fresh.length > 0 ? 'recorded' : 'duplicate');
    },
    record(event: SesEvent): Promise<RecordOutcome> {
      if (options.recordError !== undefined) return Promise.reject(options.recordError);
      if (seen.has(event.dedupeKey)) return Promise.resolve('duplicate');
      seen.add(event.dedupeKey);
      recorded.push(event);
      return Promise.resolve('recorded');
    },
    findSendEvidence: () => Promise.resolve(null),
    freshness(): Promise<ConsumerFreshness> {
      if (options.freshnessError !== undefined) return Promise.reject(options.freshnessError);
      return Promise.resolve(options.freshness ?? { lastEventAt: NOW, lastSentAt: NOW });
    },
  };
}

function deps(events: SesEventStore): SesEventConsumerDependencies {
  return { events, now: () => NOW };
}

/** 로그 한 줄을 실제로 잡는다. 무음 기본 싱크로는 "말했는가" 를 단언할 수 없다. 싱크는 `afterEach` 가 되돌린다. */
function capturedLines(): string[] {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  return lines;
}

afterEach(() => resetLogSink());

describe('① 멱등 — 같은 이벤트를 세 번 받아도 기록은 한 벌이다 (AC-i2 와 같은 규율)', () => {
  it('SNS 3회 재전달 → recorded 1회 + duplicate 2회, 기록은 1건 — 둘을 한 값으로 접으면 재전달 급증이 정상으로 보인다', async () => {
    const store = fakeStore();
    const message = { receiptId: 'r1', body: body() };

    const outcomes = [
      await consumeSesEvent(deps(store), message),
      await consumeSesEvent(deps(store), message),
      await consumeSesEvent(deps(store), message),
    ];

    expect(outcomes).toEqual(['recorded', 'duplicate', 'duplicate']);
    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]?.messageId).toBe(MESSAGE_ID);
  });

  it('다른 사건은 각각 기록된다 — 멱등이 과잉 억제가 되지 않는다', async () => {
    const store = fakeStore();
    await consumeSesEvent(deps(store), { receiptId: null, body: body({ eventType: 'Send' }) });
    await consumeSesEvent(deps(store), { receiptId: null, body: body({ eventType: 'Delivery' }) });
    expect(store.recorded.map((event) => event.eventType)).toEqual(['send', 'delivery']);
  });
});

describe('② 실패가 세 갈래로 갈린다', () => {
  it('파싱 불가는 unparsable 이고 **던지지 않는다** — 던지면 poison pill 이 큐를 멈춘다', async () => {
    const store = fakeStore();
    const outcome = await consumeSesEvent(deps(store), { receiptId: 'r1', body: 'not json' });
    expect(outcome).toBe('unparsable');
    expect(store.recorded).toEqual([]);
  });

  it('구독하지 않은 종류는 ignored 다 — 파싱 실패와 구분된다', async () => {
    const store = fakeStore();
    const outcome = await consumeSesEvent(deps(store), {
      receiptId: 'r1',
      body: body({ eventType: 'Open' }),
    });
    expect(outcome).toBe('ignored');
    expect(store.recorded).toEqual([]);
  });

  it('DB 실패는 failed 이고 던지지 않는다 — **이것만이 재전달이 도움이 되는 실패다**(결정은 큐 배선의 몫)', async () => {
    const store = fakeStore({ recordError: new Error('db down') });
    await expect(
      consumeSesEvent(deps(store), { receiptId: 'r1', body: body() }),
    ).resolves.toBe('failed');
  });
});

describe('조인 불가능한 이벤트 — 기록하되 말한다', () => {
  it('태그가 없어도 기록하고 경고를 남긴다', async () => {
    const store = fakeStore();
    const lines = capturedLines();
    const outcome = await consumeSesEvent(deps(store), {
      receiptId: 'r1',
      body: body({ tagged: false }),
    });
    expect(outcome).toBe('recorded');
    // 버리면 `EmailTags` 배선이 끊겼다는 신호가 함께 사라진다.
    expect(store.recorded[0]?.messageId).toBeNull();
    expect(lines.some((line) => line.includes('ses_event.unjoinable'))).toBe(true);
  });
});

describe('③ 소비자 정지 감지 — 조용한 실패를 시끄럽게 만든다', () => {
  it('정지면 error 한 줄을 남긴다', async () => {
    const store = fakeStore({
      freshness: { lastEventAt: null, lastSentAt: new Date(NOW.getTime() - 3_600_000) },
    });
    const lines = capturedLines();
    const health = await reportHealth(deps(store));
    expect(health.kind).toBe('stalled');
    const stalled = lines.find((line) => line.includes('ses_event.consumer_stalled'));
    expect(stalled).toBeDefined();
    expect(stalled).toContain('"level":"error"');
  });

  it('건강하면 조용하다 — 매일 울리는 알람은 곧 꺼진다', async () => {
    const store = fakeStore({ freshness: { lastEventAt: NOW, lastSentAt: NOW } });
    const lines = capturedLines();
    expect((await reportHealth(deps(store))).kind).toBe('ok');
    expect(lines.some((line) => line.includes('consumer_stalled'))).toBe(false);
  });

  it('**조회 실패를 ok 로 읽지 않는다** — 모름을 건강으로 바꾸면 알람이 필요한 순간에 조용해진다', async () => {
    const store = fakeStore({ freshnessError: new Error('db down') });
    const lines = capturedLines();
    const health = await reportHealth(deps(store));
    expect(health.kind).toBe('idle');
    expect(lines.some((line) => line.includes('ses_event.health_unavailable'))).toBe(true);
  });
});

describe('③ 시스템 메일의 하드 바운스·불만 → 억제 목록 (보안 검증 H2)', () => {
  const notificationBody = (eventType: 'Bounce' | 'Complaint', bounceType = 'Permanent'): string =>
    JSON.stringify({
      eventType,
      mail: {
        timestamp: '2026-09-22T11:59:00.000Z',
        messageId: '010c01a0c8371fce-bbb',
        tags: { [ATMARK_NOTIFICATION_ID_TAG]: ['9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'] },
      },
      ...(eventType === 'Bounce'
        ? { bounce: { timestamp: '2026-09-22T11:59:30.000Z', bounceType, bouncedRecipients: [{ emailAddress: 'Gone@Example.com' }] } }
        : { complaint: { timestamp: '2026-09-22T11:59:30.000Z', complainedRecipients: [{ emailAddress: 'angry@example.com' }] } }),
    });

  it('하드 바운스·불만은 억제 목록에 적는다(recorded) · 재전달은 duplicate · ses_events 에는 적지 않는다 · 주소는 로그에 없다', async () => {
    const store = fakeStore();
    const lines = capturedLines();
    expect(await consumeSesEvent(deps(store), { receiptId: 'r', body: notificationBody('Bounce') })).toBe('recorded');
    expect(await consumeSesEvent(deps(store), { receiptId: 'r', body: notificationBody('Bounce') })).toBe('duplicate');
    expect(await consumeSesEvent(deps(store), { receiptId: 'r', body: notificationBody('Complaint') })).toBe('recorded');
    expect(store.suppressed).toEqual([
      { reason: 'hard_bounce', addresses: ['gone@example.com'] },
      { reason: 'hard_bounce', addresses: ['gone@example.com'] },
      { reason: 'complaint', addresses: ['angry@example.com'] },
    ]);
    expect(store.recorded).toEqual([]);
    expect(lines.join('\n')).not.toMatch(/gone@|angry@/i);
  });

  it('일시 바운스는 ignored — 억제 목록에 적지 않는다', async () => {
    const store = fakeStore();
    expect(await consumeSesEvent(deps(store), { receiptId: null, body: notificationBody('Bounce', 'Transient') })).toBe('ignored');
    expect(store.suppressed).toEqual([]);
  });

  it('DB 실패는 failed — 재전달되어야 한다(억제를 잃지 않는다)', async () => {
    const store = fakeStore({ recordError: new Error('connection terminated') });
    expect(await consumeSesEvent(deps(store), { receiptId: null, body: notificationBody('Complaint') })).toBe('failed');
  });
});

// 2026-09-24 최종 검증 M3b — 헤더 From 이 발신 주소와 다르거나 예약 주소를 담으면 메트릭(알람 10)과 error 로그. 기록은 그대로 한다.
describe('④ 헤더 From 대 발신 주소 — atmark.ses.from_mismatch (M3b)', () => {
  function sendWith(source: string, from: readonly string[], tag: string = ATMARK_MESSAGE_ID_TAG): string {
    return JSON.stringify({
      eventType: 'Send',
      mail: {
        timestamp: '2026-09-22T11:59:00.000Z',
        messageId: '010c01a0c8371fce-m3b',
        source,
        commonHeaders: { from },
        tags: { [tag]: [MESSAGE_ID] },
      },
    });
  }
  const metricLines = (lines: readonly string[]): string[] => lines.filter((line) => line.includes('"atmark.ses.from_mismatch"'));

  it('에이전트 태그 메일의 헤더 From 이 login@ 이면 메트릭 1 + error 로그 — 기록은 그대로 된다', async () => {
    const lines = capturedLines();
    const store = fakeStore();
    const outcome = await consumeSesEvent(deps(store), { receiptId: 'r-m3b-1', body: sendWith('agent@atmark.ai', ['login@atmark.ai']) });
    expect(outcome).toBe('recorded');
    expect(store.recorded).toHaveLength(1);
    expect(metricLines(lines)).toHaveLength(1);
    const errorLine = lines.find((line) => line.includes('ses_event.from_mismatch'));
    expect(errorLine).toContain('"reserved"');
    // 주소는 싣지 않는다.
    expect(lines.join('\n')).not.toContain('agent@atmark.ai');
  });

  it('알림 태그 메일(ignored 경로)의 표시 이름 사칭도 센다 · 헤더 From 이 다른 주소면 mismatch', async () => {
    const lines = capturedLines();
    await consumeSesEvent(deps(fakeStore()), { receiptId: 'r-m3b-2', body: sendWith('notify@atmark.ai', ['"support@atmark.ai" <notify@atmark.ai>'], ATMARK_NOTIFICATION_ID_TAG) });
    await consumeSesEvent(deps(fakeStore()), { receiptId: 'r-m3b-3', body: sendWith('agent@atmark.ai', ['ceo@bank.example']) });
    expect(metricLines(lines)).toHaveLength(2);
    expect(lines.some((line) => line.includes('ses_event.from_mismatch') && line.includes('"mismatch"'))).toBe(true);
  });

  it('정상 메일(로그인·문의 전달·에이전트)과 헤더 정보가 없는 이벤트는 세지 않는다', async () => {
    const lines = capturedLines();
    await consumeSesEvent(deps(fakeStore()), { receiptId: 'r-m3b-4', body: sendWith('login@atmark.ai', ['login@atmark.ai'], ATMARK_NOTIFICATION_ID_TAG) });
    await consumeSesEvent(deps(fakeStore()), { receiptId: 'r-m3b-5', body: sendWith('support@atmark.ai', ['support@atmark.ai'], ATMARK_NOTIFICATION_ID_TAG) });
    await consumeSesEvent(deps(fakeStore()), { receiptId: 'r-m3b-6', body: sendWith('agent@atmark.ai', ['agent@atmark.ai']) });
    await consumeSesEvent(deps(fakeStore()), { receiptId: 'r-m3b-7', body: body() });
    expect(metricLines(lines)).toEqual([]);
  });
});

/**
 * 메일 기본기 1차 A4 — 발송 결과 웹훅. 적재 자체(savepoint·구독·위치)는 저장소의 일이고 실제 Postgres 위에서 본다
 * (`test/integration/workers/ses-event-webhook.test.ts`). 여기서는 소비자의 두 책임만: **수신자를 저장소에 넘기는가**, 그리고 적재가 되돌려졌을 때
 * **기록은 recorded 로 두고 메트릭·경고로 드러내는가**(AC-A4-4 의 소비자 쪽).
 */
describe('⑤ 발송 결과 웹훅(A4) — 수신자 전달 · 적재 실패는 메트릭으로', () => {
  function outcomeBody(eventType: 'Delivery' | 'Bounce' | 'Send'): string {
    const detail =
      eventType === 'Delivery'
        ? { delivery: { timestamp: '2026-09-22T11:59:30.000Z', recipients: ['Bob@Example.com'] } }
        : eventType === 'Bounce'
          ? { bounce: { timestamp: '2026-09-22T11:59:30.000Z', bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'bob@example.com' }] } }
          : {};
    return JSON.stringify({
      eventType,
      mail: { timestamp: '2026-09-22T11:59:00.000Z', messageId: '010c01a0c8371fce-aaa', tags: { [ATMARK_MESSAGE_ID_TAG]: [MESSAGE_ID] } },
      ...detail,
    });
  }

  function webhookStore(result: SesEventRecordOutcome): SesEventStore & { readonly inputs: (SesEventWebhookInput | undefined)[] } {
    const inputs: (SesEventWebhookInput | undefined)[] = [];
    return {
      inputs,
      record(_event: SesEvent, webhook?: SesEventWebhookInput): Promise<SesEventRecordOutcome> {
        inputs.push(webhook);
        return Promise.resolve(result);
      },
      recordSystemMailSuppression: () => Promise.resolve('recorded' as RecordOutcome),
      findSendEvidence: () => Promise.resolve(null),
      freshness: () => Promise.resolve({ lastEventAt: NOW, lastSentAt: NOW }),
      checkPlatformReputation: () => Promise.resolve(null),
    };
  }

  it('delivery·bounce 는 수신자와 now 를 넘기고, send 는 넘기지 않는다', async () => {
    const store = webhookStore('recorded');
    await consumeSesEvent(deps(store), { receiptId: 'r1', body: outcomeBody('Delivery') });
    await consumeSesEvent(deps(store), { receiptId: 'r2', body: outcomeBody('Bounce') });
    await consumeSesEvent(deps(store), { receiptId: 'r3', body: outcomeBody('Send') });
    expect(store.inputs).toEqual([
      { recipients: { addresses: ['bob@example.com'], bounceType: null, count: 1 }, now: NOW },
      { recipients: { addresses: ['bob@example.com'], bounceType: 'permanent', bounceSubType: null, count: 1 }, now: NOW },
      undefined,
    ]);
  });

  it('AC-A4-4 적재가 되돌려지면(recorded_webhook_failed) 결과는 recorded · 메트릭 atmark.webhook.enqueue_failed 1 · 경고 1(error_kind·error_code) · 주소 0', async () => {
    const store = webhookStore({ kind: 'recorded_webhook_failed', errorKind: 'DatabaseError', errorCode: '22012' });
    const lines = capturedLines();
    const outcome = await consumeSesEvent(deps(store), { receiptId: 'r1', body: outcomeBody('Delivery') });
    expect(outcome).toBe('recorded');
    expect(lines.filter((line) => line.includes('"atmark.webhook.enqueue_failed"'))).toHaveLength(1);
    const warn = lines.find((line) => line.includes('ses_event.webhook_enqueue_failed'));
    expect(warn).toContain('"level":"warn"');
    // M9 — 원인이 기존 어휘(error_kind·error_code)로 남는다.
    expect(JSON.parse(warn ?? '{}')).toMatchObject({ error_kind: 'DatabaseError', error_code: '22012' });
    expect(lines.join('\n')).not.toContain('bob@example.com');
  });

  it('적재가 성공하면 메트릭은 없다(0 이 정상)', async () => {
    const store = webhookStore('recorded');
    const lines = capturedLines();
    expect(await consumeSesEvent(deps(store), { receiptId: 'r1', body: outcomeBody('Delivery') })).toBe('recorded');
    expect(lines.some((line) => line.includes('atmark.webhook.enqueue_failed'))).toBe(false);
  });
});

/**
 * 공유 도메인 조직 평판(202610131620) — 소비자의 책임: bounce · complaint 를 기록했으면(재전달 포함) 그 메시지로 판정을 부르고, 경고 · 동결 ·
 * 운영자 조직 예외는 메트릭 + 로그, 판정 실패는 `failed`(재전달). 판정 · 동결 자체는 실제 Postgres 위에서 본다
 * (`test/integration/adversarial/platform-reputation.test.ts`).
 */
describe('⑥ 공유 도메인 조직 평판 — 판정 호출 · 메트릭 · 실패는 재전달', () => {
  function outcomeBody(eventType: 'Delivery' | 'Bounce' | 'Complaint' | 'Send'): string {
    const detail =
      eventType === 'Delivery'
        ? { delivery: { timestamp: '2026-09-22T11:59:30.000Z', recipients: ['bob@example.com'] } }
        : eventType === 'Bounce'
          ? { bounce: { timestamp: '2026-09-22T11:59:30.000Z', bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'bob@example.com' }] } }
          : eventType === 'Complaint'
            ? { complaint: { timestamp: '2026-09-22T11:59:30.000Z', complainedRecipients: [{ emailAddress: 'bob@example.com' }] } }
            : {};
    return JSON.stringify({
      eventType,
      mail: { timestamp: '2026-09-22T11:59:00.000Z', messageId: '010c01a0c8371fce-rep', tags: { [ATMARK_MESSAGE_ID_TAG]: [MESSAGE_ID] } },
      ...detail,
    });
  }
  const flagged = (lines: readonly string[]): number => lines.filter((line) => line.includes('"atmark.reputation.platform_flagged"')).length;
  const failed = (lines: readonly string[]): number => lines.filter((line) => line.includes('"atmark.reputation.platform_check_failed"')).length;
  const result = (outcome: PlatformReputationResult['outcome']): PlatformReputationResult => ({
    organizationId: '0b6c6f1e-9f55-4b8e-9d3a-0e1f2a3b4c5d',
    outcome,
    reasons: outcome === 'ok' || outcome === 'not_platform' ? [] : ['7d:complaint_rate'],
  });

  it('bounce · complaint 만 판정을 부른다(delivery · send 는 부르지 않는다) · 재전달(duplicate)도 다시 부른다', async () => {
    const store = fakeStore({ reputation: result('ok') });
    await consumeSesEvent(deps(store), { receiptId: 'r1', body: outcomeBody('Delivery') });
    await consumeSesEvent(deps(store), { receiptId: 'r2', body: outcomeBody('Send') });
    expect(store.reputationChecks).toEqual([]);
    expect(await consumeSesEvent(deps(store), { receiptId: 'r3', body: outcomeBody('Bounce') })).toBe('recorded');
    expect(await consumeSesEvent(deps(store), { receiptId: 'r4', body: outcomeBody('Complaint') })).toBe('recorded');
    expect(await consumeSesEvent(deps(store), { receiptId: 'r5', body: outcomeBody('Complaint') })).toBe('duplicate');
    expect(store.reputationChecks).toEqual([MESSAGE_ID, MESSAGE_ID, MESSAGE_ID]);
  });

  it.each([
    ['warn', 1],
    ['frozen', 1],
    ['freeze_exempt', 1],
    ['freeze_deferred', 1],
    ['already_frozen', 0],
    ['ok', 0],
    ['not_platform', 0],
  ] as const)('판정 %s → 알람 메트릭 %i 건 · 결말은 recorded', async (outcome, count) => {
    const lines = capturedLines();
    const store = fakeStore({ reputation: result(outcome) });
    expect(await consumeSesEvent(deps(store), { receiptId: 'r1', body: outcomeBody('Complaint') })).toBe('recorded');
    expect(flagged(lines)).toBe(count);
    expect(failed(lines)).toBe(0);
    if (count > 0) {
      expect(lines.some((line) => line.includes('ses_event.platform_reputation') && line.includes('organization_id=0b6c6f1e'))).toBe(true);
      // 주소는 싣지 않는다.
      expect(lines.some((line) => line.includes('bob@example.com'))).toBe(false);
    }
  });

  it('★ 판정이 던지면 failed(재전달) · 실패 메트릭 · 기록은 이미 됐으므로 재전달은 duplicate 로 와서 판정만 다시 돈다', async () => {
    const lines = capturedLines();
    const broken = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const store = fakeStore({ reputation: broken });
    expect(await consumeSesEvent(deps(store), { receiptId: 'r1', body: outcomeBody('Bounce') })).toBe('failed');
    expect(failed(lines)).toBe(1);
    expect(lines.some((line) => line.includes('ses_event.platform_reputation_failed') && line.includes('40P01'))).toBe(true);
    expect(store.recorded).toHaveLength(1);
    expect(await consumeSesEvent(deps(store), { receiptId: 'r1', body: outcomeBody('Bounce') })).toBe('failed');
    expect(store.recorded).toHaveLength(1);
    expect(store.reputationChecks).toEqual([MESSAGE_ID, MESSAGE_ID]);
  });
});
