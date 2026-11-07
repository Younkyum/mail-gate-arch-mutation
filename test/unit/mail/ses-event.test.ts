/**
 * `src/mail/events/ses-event.ts` — **페이로드는 외부 입력이다.**
 *
 * 여기서 단언하는 것은 "정상 페이로드를 잘 읽는다" 가 아니라 **깨진 페이로드에 어떻게
 * 실패하는가**다. 소비자가 던지면 메시지가 재전달되고, 파싱할 수 없는 메시지는
 * 재전달해도 영원히 파싱되지 않는다 — 그것이 poison pill 이다.
 *
 * 그리고 dedupe 키: SNS/SQS 는 at-least-once 이므로 **같은 바이트가 같은 키가 되어야**
 * 유니크 인덱스가 재전달을 죽인다. 동시에 **다른 사건은 다른 키여야** 두 수신자의
 * 반송이 하나로 접히지 않는다.
 */

import { describe, expect, it } from 'vitest';

import { parseSesEvent, SEND_EVIDENCE_EVENT_TYPES, SES_EVENT_TYPES } from '../../../src/mail/events/ses-event';
import { ATMARK_MESSAGE_ID_TAG, ATMARK_NOTIFICATION_ID_TAG } from '../../../src/mail/events/tag';

const MESSAGE_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
const SES_MESSAGE_ID = '010c01a0c8371fce-1a2b3c4d-000000';

interface EventOverrides {
  readonly eventType?: string;
  readonly tags?: Record<string, unknown> | undefined;
  readonly mailTimestamp?: string;
  readonly detailTimestamp?: string | undefined;
  readonly sesMessageId?: string | null;
}

/** SES 가 실제로 보내는 모양. 필드 이름·중첩을 임의로 단순화하지 않는다. */
function eventBody(overrides: EventOverrides = {}): string {
  const eventType = overrides.eventType ?? 'Send';
  const detailKey = eventType.charAt(0).toLowerCase() + eventType.slice(1).replace(/\s/g, '');
  const body: Record<string, unknown> = {
    eventType,
    mail: {
      timestamp: overrides.mailTimestamp ?? '2026-09-22T10:00:00.000Z',
      messageId: overrides.sesMessageId === undefined ? SES_MESSAGE_ID : overrides.sesMessageId,
      source: 'agent@atmark.ai',
      tags:
        overrides.tags === undefined
          ? {
              'ses:configuration-set': ['atmark-default'],
              [ATMARK_MESSAGE_ID_TAG]: [MESSAGE_ID],
            }
          : overrides.tags,
    },
  };
  if (overrides.detailTimestamp !== undefined) {
    body[detailKey] = { timestamp: overrides.detailTimestamp };
  }
  return JSON.stringify(body);
}

/** SNS 알림 봉투. 본문은 **문자열**로 들어간다 — 객체로 넣으면 실물과 달라진다. */
function snsEnvelope(body: string): string {
  return JSON.stringify({
    Type: 'Notification',
    MessageId: 'sns-1',
    TopicArn: 'arn:aws:sns:ap-northeast-2:000000000000:atmark-ses-events',
    Message: body,
    Timestamp: '2026-09-22T10:00:01.000Z',
  });
}

describe('어휘가 세 곳에서 같은 집합이다', () => {
  it('SES_EVENT_TYPES 는 마이그레이션의 ses_event_type ENUM 과 같은 목록이다', () => {
    // DB ENUM 과 갈라지면 증상이 INSERT 실패로 나타난다 — 소비자가 죽고, 조회가 비고,
    // 우리는 그것을 "안 나갔다" 로 읽는다. 목록을 리터럴로 고정해 리뷰 대상으로 둔다.
    expect([...SES_EVENT_TYPES]).toEqual([
      'send',
      'delivery',
      'bounce',
      'complaint',
      'reject',
      'rendering_failure',
      'delivery_delay',
    ]);
  });

  it('전송 증거는 send·delivery 둘뿐이다 — bounce 는 증거 목록에 없다', () => {
    // bounce 도 "나갔다" 의 증거이긴 하지만 언제나 Send 를 동반한다. 여기 넣으면
    // "반송됐으니 다시 보내자" 라는 반대 방향의 오해를 코드가 지지하게 된다.
    expect([...SEND_EVIDENCE_EVENT_TYPES]).toEqual(['send', 'delivery']);
  });
});

describe('정상 경로', () => {
  it('SNS 봉투 안의 Send 이벤트에서 우리 message_id 를 되찾는다 (ADR-0004 결정 1)', () => {
    const parsed = parseSesEvent(snsEnvelope(eventBody()), ATMARK_MESSAGE_ID_TAG);

    expect(parsed.kind).toBe('event');
    if (parsed.kind !== 'event') return;
    expect(parsed.event.messageId).toBe(MESSAGE_ID);
    expect(parsed.event.sesMessageId).toBe(SES_MESSAGE_ID);
    expect(parsed.event.eventType).toBe('send');
  });

  it('봉투 없이 온 본문도 읽는다 — 배선을 바꾸는 날 조용히 0건이 되지 않게', () => {
    const parsed = parseSesEvent(eventBody(), ATMARK_MESSAGE_ID_TAG);
    expect(parsed.kind).toBe('event');
    if (parsed.kind !== 'event') return;
    expect(parsed.event.messageId).toBe(MESSAGE_ID);
  });

  it.each([
    ['Delivery', 'delivery'],
    ['Bounce', 'bounce'],
    ['Complaint', 'complaint'],
    ['Reject', 'reject'],
    ['Rendering Failure', 'rendering_failure'],
    ['DeliveryDelay', 'delivery_delay'],
  ])('%s → %s', (sesName, expected) => {
    const parsed = parseSesEvent(snsEnvelope(eventBody({ eventType: sesName })), ATMARK_MESSAGE_ID_TAG);
    expect(parsed.kind).toBe('event');
    if (parsed.kind !== 'event') return;
    expect(parsed.event.eventType).toBe(expected);
  });

  it('SES 자신의 태그가 섞여 와도 우리 태그만 읽는다', () => {
    const parsed = parseSesEvent(
      eventBody({
        tags: {
          'ses:configuration-set': ['atmark-default'],
          'ses:from-domain': ['atmark.ai'],
          [ATMARK_MESSAGE_ID_TAG]: [MESSAGE_ID],
        },
      }),
      ATMARK_MESSAGE_ID_TAG,
    );
    expect(parsed.kind).toBe('event');
    if (parsed.kind !== 'event') return;
    expect(parsed.event.messageId).toBe(MESSAGE_ID);
  });

  it('이벤트별 시각을 mail.timestamp 보다 우선한다 — bounce 는 며칠 뒤에 온다', () => {
    const parsed = parseSesEvent(
      eventBody({
        eventType: 'Bounce',
        mailTimestamp: '2026-09-22T10:00:00.000Z',
        detailTimestamp: '2026-09-25T04:00:00.000Z',
      }),
      ATMARK_MESSAGE_ID_TAG,
    );
    expect(parsed.kind).toBe('event');
    if (parsed.kind !== 'event') return;
    expect(parsed.event.eventAt.toISOString()).toBe('2026-09-25T04:00:00.000Z');
  });
});

describe('조인 불가능한 이벤트 — 버리지 않고 message_id 만 null 로 둔다', () => {
  it('우리 태그가 없으면 messageId 는 null 이지만 이벤트는 살아 있다', () => {
    const parsed = parseSesEvent(
      eventBody({ tags: { 'ses:configuration-set': ['atmark-default'] } }),
      ATMARK_MESSAGE_ID_TAG,
    );
    expect(parsed.kind).toBe('event');
    if (parsed.kind !== 'event') return;
    // 버리면 `EmailTags` 배선이 끊겼다는 신호가 함께 사라진다.
    expect(parsed.event.messageId).toBeNull();
    expect(parsed.event.sesMessageId).toBe(SES_MESSAGE_ID);
  });

  it('태그 값이 SES 제약 밖이면 messageId 는 null 이다 — 되돌릴 수 없는 값을 믿지 않는다', () => {
    const parsed = parseSesEvent(
      eventBody({ tags: { [ATMARK_MESSAGE_ID_TAG]: ['<not a tag@value>'] } }),
      ATMARK_MESSAGE_ID_TAG,
    );
    expect(parsed.kind).toBe('event');
    if (parsed.kind !== 'event') return;
    expect(parsed.event.messageId).toBeNull();
  });

  it('태그 값이 배열이 아니라 스칼라로 와도 읽는다', () => {
    const parsed = parseSesEvent(
      eventBody({ tags: { [ATMARK_MESSAGE_ID_TAG]: MESSAGE_ID } }),
      ATMARK_MESSAGE_ID_TAG,
    );
    expect(parsed.kind).toBe('event');
    if (parsed.kind !== 'event') return;
    expect(parsed.event.messageId).toBe(MESSAGE_ID);
  });
});

describe('파싱 실패 — 던지지 않고 값으로 답한다', () => {
  it.each([
    ['JSON 이 아니다', 'not json at all'],
    ['배열이다', '[]'],
    ['스칼라다', '42'],
    ['eventType 이 없다', JSON.stringify({ mail: { timestamp: '2026-09-22T10:00:00Z' } })],
    ['mail 이 없다', JSON.stringify({ eventType: 'Send' })],
    ['timestamp 가 깨졌다', JSON.stringify({ eventType: 'Send', mail: { timestamp: 'yesterday' } })],
    ['봉투 안이 JSON 이 아니다', JSON.stringify({ Type: 'Notification', Message: 'nope' })],
  ])('%s → unparsable', (_label, raw) => {
    const parsed = parseSesEvent(raw, ATMARK_MESSAGE_ID_TAG);
    expect(parsed.kind).toBe('unparsable');
  });

  it('구독하지 않은 종류는 unparsable 이 아니라 ignored 다', () => {
    // 둘을 한 통에 담으면 "파싱 실패 급증"(배선 사고)이 "Open 이벤트 잡음"에 묻힌다.
    const parsed = parseSesEvent(eventBody({ eventType: 'Open' }), ATMARK_MESSAGE_ID_TAG);
    expect(parsed).toEqual({ kind: 'ignored', eventType: 'Open' });
  });
});

describe('dedupe 키 — at-least-once 를 이기는 값', () => {
  it('같은 바이트는 같은 키다 — 재전달이 여기서 죽는다', () => {
    const body = eventBody();
    const first = parseSesEvent(snsEnvelope(body), ATMARK_MESSAGE_ID_TAG);
    const second = parseSesEvent(snsEnvelope(body), ATMARK_MESSAGE_ID_TAG);
    expect(first.kind).toBe('event');
    expect(second.kind).toBe('event');
    if (first.kind !== 'event' || second.kind !== 'event') return;
    expect(first.event.dedupeKey).toBe(second.event.dedupeKey);
  });

  it('다른 사건은 다른 키다 — 두 수신자의 반송이 하나로 접히지 않는다', () => {
    const a = parseSesEvent(
      eventBody({ eventType: 'Bounce', detailTimestamp: '2026-09-22T11:00:00.000Z' }),
      ATMARK_MESSAGE_ID_TAG,
    );
    const b = parseSesEvent(
      eventBody({ eventType: 'Bounce', detailTimestamp: '2026-09-22T11:00:01.000Z' }),
      ATMARK_MESSAGE_ID_TAG,
    );
    expect(a.kind).toBe('event');
    expect(b.kind).toBe('event');
    if (a.kind !== 'event' || b.kind !== 'event') return;
    expect(a.event.dedupeKey).not.toBe(b.event.dedupeKey);
  });

  it('봉투가 달라도 본문이 같으면 같은 키다 — 봉투의 값에 기대지 않는다', () => {
    // SNS `MessageId` 를 키로 삼았다면 이 단언이 깨진다. 봉투는 재구독·재발행 시
    // 새 값이 붙지만 본문은 SES 가 만든 것이고 재전달이 그것을 바꾸지 않는다.
    const body = eventBody();
    const first = parseSesEvent(snsEnvelope(body), ATMARK_MESSAGE_ID_TAG);
    const second = parseSesEvent(
      JSON.stringify({ Type: 'Notification', MessageId: 'sns-2', Message: body }),
      ATMARK_MESSAGE_ID_TAG,
    );
    if (first.kind !== 'event' || second.kind !== 'event') throw new Error('둘 다 event 여야 한다');
    expect(first.event.dedupeKey).toBe(second.event.dedupeKey);
  });

  it('키는 sha256 hex 64자다 — DB CHECK 와 같은 형태', () => {
    const parsed = parseSesEvent(eventBody(), ATMARK_MESSAGE_ID_TAG);
    if (parsed.kind !== 'event') throw new Error('event 여야 한다');
    expect(parsed.event.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('소유자 승인 알림의 이벤트 (P2) — 배선 사고와 구별한다', () => {
  const NOTIFICATION_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

  it('알림 태그만 있으면 ignored — `event` 가 아니므로 unjoinable 경고도 ses_events 행도 없다', () => {
    const parsed = parseSesEvent(
      snsEnvelope(eventBody({ eventType: 'Bounce', tags: { [ATMARK_NOTIFICATION_ID_TAG]: [NOTIFICATION_ID] } })),
      ATMARK_MESSAGE_ID_TAG,
    );
    expect(parsed).toEqual({ kind: 'ignored', eventType: 'owner_notification.bounce' });
  });

  it('두 태그가 다 있으면 에이전트 메일로 본다 — 알림 태그가 에이전트 이벤트를 숨기지 못한다', () => {
    const parsed = parseSesEvent(
      snsEnvelope(
        eventBody({ tags: { [ATMARK_MESSAGE_ID_TAG]: [MESSAGE_ID], [ATMARK_NOTIFICATION_ID_TAG]: [NOTIFICATION_ID] } }),
      ),
      ATMARK_MESSAGE_ID_TAG,
    );
    expect(parsed.kind).toBe('event');
    if (parsed.kind === 'event') expect(parsed.event.messageId).toBe(MESSAGE_ID);
  });

  it('태그가 하나도 없으면 여전히 조인 불가 event 다 — 배선 사고 신호는 그대로 산다', () => {
    const parsed = parseSesEvent(snsEnvelope(eventBody({ tags: {} })), ATMARK_MESSAGE_ID_TAG);
    expect(parsed.kind).toBe('event');
    if (parsed.kind === 'event') expect(parsed.event.messageId).toBeNull();
  });
});

describe('시스템 메일의 하드 바운스·불만 → 억제 주소 (보안 검증 H2)', () => {
  const NOTIFICATION_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
  const notificationTags = { [ATMARK_NOTIFICATION_ID_TAG]: [NOTIFICATION_ID] };

  function withDetail(eventType: string, detail: Record<string, unknown>, tags: Record<string, unknown> = notificationTags): string {
    const body = JSON.parse(eventBody({ eventType, tags })) as Record<string, unknown>;
    body[eventType.charAt(0).toLowerCase() + eventType.slice(1)] = { timestamp: '2026-09-22T10:05:00.000Z', ...detail };
    return snsEnvelope(JSON.stringify(body));
  }

  it('하드 바운스(Permanent) → system_suppression(hard_bounce) · 주소는 소문자 · 중복 제거', () => {
    const parsed = parseSesEvent(
      withDetail('Bounce', {
        bounceType: 'Permanent',
        bouncedRecipients: [{ emailAddress: 'Nobody@Example.COM' }, { emailAddress: 'nobody@example.com' }],
      }),
      ATMARK_MESSAGE_ID_TAG,
    );
    expect(parsed).toEqual({ kind: 'system_suppression', suppression: { reason: 'hard_bounce', addresses: ['nobody@example.com'] } });
  });

  it('불만 → system_suppression(complaint)', () => {
    const parsed = parseSesEvent(
      withDetail('Complaint', { complainedRecipients: [{ emailAddress: 'angry@example.com' }], complaintFeedbackType: 'abuse' }),
      ATMARK_MESSAGE_ID_TAG,
    );
    expect(parsed).toEqual({ kind: 'system_suppression', suppression: { reason: 'complaint', addresses: ['angry@example.com'] } });
  });

  it('일시 바운스(Transient)·판정 불가·배달·주소 없음·주소 모양 아님(비ASCII 포함) → 여전히 ignored', () => {
    for (const raw of [
      withDetail('Bounce', { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'full@example.com' }] }),
      withDetail('Bounce', { bounceType: 'Undetermined', bouncedRecipients: [{ emailAddress: 'x@example.com' }] }),
      withDetail('Delivery', { recipients: ['x@example.com'] }),
      withDetail('Bounce', { bounceType: 'Permanent', bouncedRecipients: [] }),
      withDetail('Bounce', { bounceType: 'Permanent', bouncedRecipients: 'x@example.com' }),
      withDetail('Complaint', { complainedRecipients: [{ emailAddress: 'no-at-sign' }, { emailAddress: 'a b@example.com' }, { emailAddress: 'ΐ@example.com' }] }),
    ]) {
      expect(parseSesEvent(raw, ATMARK_MESSAGE_ID_TAG).kind, raw).toBe('ignored');
    }
  });

  it('에이전트 메일(메시지 태그)의 바운스는 여전히 event — 기록 값(`SesEvent`)은 주소를 싣지 않는다', () => {
    const parsed = parseSesEvent(
      withDetail('Bounce', { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'x@example.com' }] }, { [ATMARK_MESSAGE_ID_TAG]: [MESSAGE_ID] }),
      ATMARK_MESSAGE_ID_TAG,
    );
    expect(parsed.kind).toBe('event');
    if (parsed.kind !== 'event') return;
    // 기록·로그로 흘러가는 값에는 주소가 없다. 수신자는 웹훅 위치 계산용으로 **따로** 온다(메일 기본기 A4 — 아래 절).
    expect(JSON.stringify(parsed.event)).not.toContain('x@example.com');
    expect(parsed.recipients).toEqual({ addresses: ['x@example.com'], bounceType: 'permanent', bounceSubType: null, count: 1 });
  });
});

/**
 * 메일 기본기 1차 A4 — 발송 결과 웹훅(`recipient_positions`)의 입력. SES 모양: `delivery.recipients` 는 문자열 배열, `bounce.bouncedRecipients` ·
 * `complaint.complainedRecipients` 는 `{emailAddress}` 배열. 주소는 `SesEvent` 가 아니라 `recipients` 로 온다.
 */
describe('발송 결과 수신자(A4) — delivery · bounce · complaint', () => {
  const agentTags = { [ATMARK_MESSAGE_ID_TAG]: [MESSAGE_ID] };

  function agentEvent(eventType: string, detail: Record<string, unknown>): string {
    const body = JSON.parse(eventBody({ eventType, tags: agentTags })) as Record<string, unknown>;
    body[eventType.charAt(0).toLowerCase() + eventType.slice(1)] = { timestamp: '2026-09-22T10:05:00.000Z', ...detail };
    return snsEnvelope(JSON.stringify(body));
  }

  it('delivery.recipients(문자열 배열) → 소문자·공백 제거·중복 제거, bounceType 없음', () => {
    const parsed = parseSesEvent(agentEvent('Delivery', { recipients: [' Bob@Example.com ', 'bob@example.com', 'amy@example.com'] }), ATMARK_MESSAGE_ID_TAG);
    if (parsed.kind !== 'event') throw new Error('event 여야 한다');
    expect(parsed.recipients).toEqual({ addresses: ['bob@example.com', 'amy@example.com'], bounceType: null, count: 3 });
    expect(JSON.stringify(parsed.event)).not.toContain('@example.com');
  });

  it.each([
    ['Permanent', 'permanent'],
    ['Transient', 'transient'],
    ['Undetermined', 'undetermined'],
    ['Weird', 'undetermined'],
    [undefined, 'undetermined'],
  ] as const)('bounceType %s → %s(닫힌 셋)', (sesType, expected) => {
    const parsed = parseSesEvent(
      agentEvent('Bounce', { ...(sesType === undefined ? {} : { bounceType: sesType }), bouncedRecipients: [{ emailAddress: 'x@example.com' }] }),
      ATMARK_MESSAGE_ID_TAG,
    );
    if (parsed.kind !== 'event') throw new Error('event 여야 한다');
    expect(parsed.recipients).toEqual({ addresses: ['x@example.com'], bounceType: expected, bounceSubType: null, count: 1 });
  });

  it('complaint.complainedRecipients → 주소, 모양이 아닌 값·비ASCII 는 버린다', () => {
    const parsed = parseSesEvent(
      agentEvent('Complaint', {
        complainedRecipients: [{ emailAddress: 'Angry@Example.com' }, { emailAddress: 'no-at-sign' }, { emailAddress: 'ΐ@example.com' }, 7, null],
      }),
      ATMARK_MESSAGE_ID_TAG,
    );
    if (parsed.kind !== 'event') throw new Error('event 여야 한다');
    expect(parsed.recipients).toEqual({ addresses: ['angry@example.com'], bounceType: null, count: 5 });
  });

  it('하위 객체·배열이 없으면 빈 수신자(던지지 않는다) · 그 밖의 종류는 null', () => {
    const noDetail = parseSesEvent(snsEnvelope(eventBody({ eventType: 'Delivery', tags: agentTags })), ATMARK_MESSAGE_ID_TAG);
    if (noDetail.kind !== 'event') throw new Error('event 여야 한다');
    expect(noDetail.recipients).toEqual({ addresses: [], bounceType: null, count: 1 });

    const send = parseSesEvent(snsEnvelope(eventBody({ eventType: 'Send', tags: agentTags })), ATMARK_MESSAGE_ID_TAG);
    if (send.kind !== 'event') throw new Error('event 여야 한다');
    expect(send.recipients).toBeNull();
  });

  it.each([
    ['OnAccountSuppressionList', 'OnAccountSuppressionList'],
    ['General', 'General'],
    ['Bad Value!', null],
    [7, null],
    [undefined, null],
  ] as const)('bounceSubType %s → %s(영문자 모양만 — 공유 도메인 평판이 계정 억제 목록을 뺀다, 202610131612)', (raw, expected) => {
    const parsed = parseSesEvent(
      agentEvent('Bounce', { bounceType: 'Permanent', ...(raw === undefined ? {} : { bounceSubType: raw }), bouncedRecipients: [{ emailAddress: 'x@example.com' }, { emailAddress: 'y@example.com' }] }),
      ATMARK_MESSAGE_ID_TAG,
    );
    if (parsed.kind !== 'event') throw new Error('event 여야 한다');
    expect(parsed.recipients?.bounceSubType).toBe(expected);
    expect(parsed.recipients?.count).toBe(2);
  });

  it('수신자 칸 수(count)는 모양과 무관하게 세고 1~100 으로 자른다', () => {
    const many = parseSesEvent(agentEvent('Delivery', { recipients: Array.from({ length: 150 }, (_v, i) => `u${String(i)}@example.com`) }), ATMARK_MESSAGE_ID_TAG);
    if (many.kind !== 'event') throw new Error('event 여야 한다');
    expect(many.recipients?.count).toBe(100);
    const empty = parseSesEvent(agentEvent('Delivery', { recipients: [] }), ATMARK_MESSAGE_ID_TAG);
    if (empty.kind !== 'event') throw new Error('event 여야 한다');
    expect(empty.recipients?.count).toBe(1);
  });

  it('한 이벤트에서 최대 100 주소만 읽는다', () => {
    const recipients = Array.from({ length: 150 }, (_v, i) => `u${String(i)}@example.com`);
    const parsed = parseSesEvent(agentEvent('Delivery', { recipients }), ATMARK_MESSAGE_ID_TAG);
    if (parsed.kind !== 'event') throw new Error('event 여야 한다');
    expect(parsed.recipients?.addresses).toHaveLength(100);
  });
});
