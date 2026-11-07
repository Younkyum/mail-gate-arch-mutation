/**
 * src/mail/events/ses-event.ts — SES 이벤트 페이로드 파싱 (ADR-0004 결정 1).
 *
 * **이 파일은 I/O 를 하지 않는다.** 문자열 하나를 받아 값 하나를 돌려준다. 그래서
 * 파싱의 모든 실패 모드가 단위 테스트로 재현 가능하고, 소비자(`src/workers/
 * ses-event-consumer.ts`)는 큐 배선만 책임진다.
 *
 * ---------------------------------------------------------------------------
 * ## 페이로드는 외부 입력이다
 * ---------------------------------------------------------------------------
 *
 * SNS 가 실어 오는 것은 **우리가 만들지 않은 JSON** 이다. AWS 가 필드를 추가하고,
 * 이벤트 종류가 늘고, 구독 설정이 바뀌면 다른 모양이 온다. 그러므로:
 *
 *   - **형태를 믿지 않는다.** 모든 접근이 `unknown` 을 좁히는 것으로 시작한다.
 *   - **던지지 않는다.** 파싱 실패는 예외가 아니라 **값**(`{kind:'unparsable'}`)이다.
 *     큐 소비자에서 던지면 메시지가 재전달되고, 파싱할 수 없는 메시지는 재전달해도
 *     영원히 파싱되지 않는다 — 그것이 poison pill 이고 큐가 멈추는 방식이다.
 *   - **모르는 이벤트 종류를 버리지 않는다.** `{kind:'ignored'}` 로 구분해 돌려준다.
 *     "파싱 실패" 와 "우리가 구독하지 않은 종류" 를 한 통에 담으면 전자의 급증이
 *     후자의 잡음에 묻힌다.
 *
 * ---------------------------------------------------------------------------
 * ## 멱등성 — SNS/SQS 는 at-least-once 다
 * ---------------------------------------------------------------------------
 *
 * §4.5 가 발송 경로에 요구한 규율이 여기도 그대로 필요하다. 같은 이벤트를 세 번 받아도
 * 기록은 한 벌이어야 한다. 그 집행은 DB 유니크 인덱스(`ses_events_dedupe_key`)가 하고,
 * 이 파일은 그 키를 만든다: **이벤트 본문 문자열의 sha256.**
 *
 * **왜 SNS `MessageId` 가 아닌가.** 그것은 봉투(envelope)의 값이다. SNS→SQS→Lambda
 * 경로에서 봉투는 한 겹 더 씌워지고 재구독·재발행 시 새 값이 붙는다. 반면 **본문은
 * SES 가 만든 것이고 재전달이 그것을 바꾸지 않는다** — 같은 사건이면 같은 바이트다.
 *
 * **왜 `(message_id, event_type)` 이 아닌가.** 한 메시지에 수신자가 여럿이면
 * `Delivery` 도 `Bounce` 도 여럿 온다. 그 조합을 키로 삼으면 두 번째 수신자의 반송이
 * 첫 번째와 같은 사건으로 접혀 사라진다 — 알람 4·5(bounce·complaint 율)의 분자가
 * 조용히 줄어든다.
 */

import { createHash } from 'node:crypto';

import { checkFromAlignment, type FromAlignment } from './from-alignment';
import { ATMARK_NOTIFICATION_ID_TAG, fromMessageIdTagValue } from './tag';

/**
 * 우리가 기록하는 이벤트 종류. `ses-stack.ts` 의 `EmailSendingEvent` 목록과 같은 집합이며,
 * DB ENUM `ses_event_type` 과도 같은 집합이다 — 세 곳이 갈라지면 소비자가 쓴 값이
 * INSERT 에서 죽는다.
 */
export const SES_EVENT_TYPES = [
  'send',
  'delivery',
  'bounce',
  'complaint',
  'reject',
  'rendering_failure',
  'delivery_delay',
] as const;

export type SesEventType = (typeof SES_EVENT_TYPES)[number];

/**
 * **"이 메일은 나갔는가" 에 `true` 로 답하는 종류.**
 *
 * `Send` 는 SES 가 발송을 수락한 시점이고 `Delivery` 는 수신측 MTA 가 받은 시점이다.
 * 둘 중 **어느 쪽이든 메일은 우리 손을 떠났다** — 그 뒤에 재전송하면 같은 사람에게
 * 두 번 간다(ADR-0004 결정 2).
 *
 * `Bounce` 와 `Complaint` 는 여기 없다. 그 둘도 "나갔다" 의 증거이긴 하지만 **언제나
 * `Send` 를 동반**하므로 따로 셀 필요가 없고, 여기 넣으면 "반송됐으니 다시 보내자" 라는
 * 반대 방향의 오해를 코드가 지지하게 된다.
 */
export const SEND_EVIDENCE_EVENT_TYPES: readonly SesEventType[] = ['send', 'delivery'];

/** SES 가 쓰는 `eventType` 문자열 → 우리 ENUM. 목록에 없으면 기록하지 않는다. */
const EVENT_TYPE_BY_SES_NAME: Readonly<Record<string, SesEventType>> = {
  Send: 'send',
  Delivery: 'delivery',
  Bounce: 'bounce',
  Complaint: 'complaint',
  Reject: 'reject',
  'Rendering Failure': 'rendering_failure',
  RenderingFailure: 'rendering_failure',
  DeliveryDelay: 'delivery_delay',
};

/** 기록 대상 이벤트 한 건. **주소도 본문도 들고 있지 않다**(PRD 제약 · PII). */
export interface SesEvent {
  readonly eventType: SesEventType;
  /** 우리 `messages.id`. 태그가 없거나 되돌릴 수 없으면 `null` — 조인할 수 없는 이벤트다. */
  readonly messageId: string | null;
  /** SES 가 부여한 id(`mail.messageId`). 우리 것이 아니다. */
  readonly sesMessageId: string | null;
  readonly eventAt: Date;
  /** 본문 sha256. 유니크 인덱스가 이 값으로 재전달을 죽인다. */
  readonly dedupeKey: string;
}

/**
 * **시스템 메일(소유자 알림 태그)의 하드 바운스·불만 수신자**(보안 검증 H2). 이 한 경우만 주소를 싣는다 — 받는 쪽이
 * `system_mail_suppressions` 에 적어 로그인·가입 메일이 그 주소로 다시 나가지 않게 한다. 에이전트 메일의 이벤트는 여전히 주소를
 * 싣지 않는다(위 `SesEvent`).
 */
export interface SystemMailSuppression {
  readonly reason: 'hard_bounce' | 'complaint';
  /** 소문자 정규화 · 모양이 주소인 것만(DB CHECK 와 같은 모양) · 중복 제거. 비어 있지 않다. */
  readonly addresses: readonly string[];
}

/** SES `bounceType` 의 닫힌 소문자 판(`webhooks/events.ts` `BounceType` 과 같은 셋). 모르는 값·누락은 `undetermined`. */
export type SesBounceType = 'permanent' | 'transient' | 'undetermined';

/**
 * **발송 결과 이벤트(delivery·bounce·complaint)의 수신자** — 웹훅 `recipient_positions` 계산의 입력(메일 기본기 1차 A4 · D4 a). `SesEvent` 와
 * **따로** 둔다: `SesEvent` 는 주소를 들고 있지 않다는 성질을 지키고(기록·로그로 흘러가는 값이다), 이 값은 소비자가 위치를 계산하는 동안만
 * 메모리에 있다 — 어디에도 저장하지 않고 로그에 싣지 않는다.
 */
export interface SesEventRecipients {
  /** 소문자·앞뒤 공백 제거·중복 제거, 모양이 주소인 것만, 최대 `MAX_EVENT_RECIPIENTS`. 비어 있을 수 있다. */
  readonly addresses: readonly string[];
  /** bounce 일 때만 값이 있다. */
  readonly bounceType: SesBounceType | null;
  /**
   * SES `bounceSubType`(bounce 일 때만 · 영문자 1~40 모양만, 아니면 `null`) — 공유 도메인 평판(202610131612)은 `OnAccountSuppressionList` 를 분자에서
   * 뺀다(계정 억제 목록 bounce 는 SES 평판에 들지 않는다).
   */
  readonly bounceSubType?: string | null;
  /** 알림이 실은 수신자 칸 수(모양과 무관 · 1~`MAX_EVENT_RECIPIENTS` — 비었으면 1). 평판의 수신자 단위 집계(`ses_events.recipient_count`). */
  readonly count?: number;
}

export type SesEventParse =
  /** `recipients` 는 delivery·bounce·complaint 일 때만 값이 있고 나머지 종류는 `null`. */
  | { readonly kind: 'event'; readonly event: SesEvent; readonly recipients: SesEventRecipients | null }
  /** 시스템 메일의 하드 바운스·불만 — 억제 목록에 적을 주소. */
  | { readonly kind: 'system_suppression'; readonly suppression: SystemMailSuppression }
  /** 구독하지 않은 종류(Open·Click·Subscription 등). 정상이다 — 버리되 세어 둔다. */
  | { readonly kind: 'ignored'; readonly eventType: string }
  /** JSON 이 아니거나 우리가 아는 어떤 모양도 아니다. **재전달해도 파싱되지 않는다.** */
  | { readonly kind: 'unparsable'; readonly detail: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * `mail.tags` 에서 태그 하나의 첫 값. SES 는 태그 값을 **배열**로 싣는다
 * (`{"atmark_message_id":["<uuid>"]}`) — 스칼라로 가정하면 조인 키가 `undefined` 가 되고,
 * 그 결과는 "이벤트 없음" 과 구별되지 않는다.
 */
function firstTagValue(tags: unknown, name: string): string | null {
  const record = asRecord(tags);
  if (record === null) return null;
  const raw = record[name];
  if (Array.isArray(raw)) return asString(raw[0]);
  return asString(raw);
}

/** ISO 문자열 → `Date`. 형식이 깨졌으면 `null` — `Invalid Date` 를 DB 로 흘리지 않는다. */
function asDate(value: unknown): Date | null {
  const text = asString(value);
  if (text === null) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * 이벤트 본문 문자열을 꺼낸다.
 *
 * SNS 알림은 본문을 `Message` 필드에 **문자열로** 담는다. 그런데 SNS→SQS 배선이냐
 * Lambda 직결이냐에 따라 봉투가 한 겹일 수도, 없을 수도 있다. 둘 다 받는 이유는
 * 관용이 아니라 **배선을 바꾸는 날 소비자가 조용히 0건을 처리하는 것을 막기 위해서**다.
 *
 * 돌려주는 것은 **문자열**이다 — 여기서 파싱한 객체를 다시 `JSON.stringify` 하면
 * 키 순서가 재배열되어 dedupe 키가 흔들린다. 재전달이 같은 바이트를 가져온다는 성질이
 * 멱등성의 근거이므로, 그 바이트를 그대로 해싱한다.
 */
function extractEventBody(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;

  const envelopeMessage = asString(record['Message']);
  if (envelopeMessage !== null && asString(record['Type']) !== null) return envelopeMessage;

  // 봉투가 아니다 — 본문 그 자체로 본다. 원본 문자열을 그대로 돌려준다.
  return raw;
}

/**
 * SNS 알림 본문(또는 SES 이벤트 JSON) 하나를 파싱한다. **던지지 않는다.**
 *
 * @param tagName 조인 키가 실린 태그 이름. 기본값을 두지 않는다 — 기본값이 있으면
 *   전송단이 쓰는 이름과 소비자가 읽는 이름이 **서로 모른 채** 갈라질 수 있고,
 *   그 갈라짐의 증상은 "조회가 항상 비어 있다" 이며 곧 중복 발송이다.
 */
export function parseSesEvent(raw: string, tagName: string): SesEventParse {
  const body = extractEventBody(raw);
  if (body === null) return { kind: 'unparsable', detail: 'JSON 이 아니거나 객체가 아니다' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: 'unparsable', detail: 'SNS Message 가 JSON 이 아니다' };
  }

  const event = asRecord(parsed);
  if (event === null) return { kind: 'unparsable', detail: '이벤트 본문이 객체가 아니다' };

  const sesEventName = asString(event['eventType']) ?? asString(event['notificationType']);
  if (sesEventName === null) return { kind: 'unparsable', detail: 'eventType 이 없다' };

  const eventType = EVENT_TYPE_BY_SES_NAME[sesEventName];
  if (eventType === undefined) return { kind: 'ignored', eventType: sesEventName };

  const mail = asRecord(event['mail']);
  if (mail === null) return { kind: 'unparsable', detail: 'mail 객체가 없다' };

  // 이벤트별 하위 객체의 시각을 우선한다 — `mail.timestamp` 는 **발송 시각**이고,
  // bounce 는 며칠 뒤에 올 수 있다. 둘을 같은 값으로 쓰면 "이벤트가 늦게 왔다" 가
  // 기록에서 사라지고, 소비자 정지 감지(아래 `health.ts`)가 그 축을 잃는다.
  const detail = asRecord(event[eventType === 'delivery_delay' ? 'deliveryDelay' : eventType]);
  const eventAt = asDate(detail?.['timestamp']) ?? asDate(mail['timestamp']);
  if (eventAt === null) return { kind: 'unparsable', detail: 'timestamp 를 읽을 수 없다' };

  const tagValue = firstTagValue(mail['tags'], tagName);

  // **소유자 승인 알림의 이벤트** (P2, `src/notify/approval-notifier.ts`). 알림은 `messages` 행이 아니므로
  // 조인 키가 없는 것이 정상이다 — `event` 로 돌려주면 소비자가 "태그 배선이 끊긴 에이전트 메일" 로 읽어
  // 알림 한 통마다 `ses_event.unjoinable` 경고를 내고, 그 소음이 진짜 배선 사고를 덮는다. 알림 태그가
  // 있고 에이전트 태그가 **없을 때만** 여기로 온다 — 둘 다 있으면 에이전트 메일로 본다(보수적인 쪽).
  if (tagValue === null && firstTagValue(mail['tags'], ATMARK_NOTIFICATION_ID_TAG) !== null) {
    // ★ 단, **하드 바운스·불만은 버리지 않는다**(보안 검증 H2). 가입 확인 메일은 임의 주소로 가므로, 없는 주소·신고하는 주소로
    //   가입 요청을 반복하면 그 결과가 SES 계정의 반송·불만 율(계정 정지 기준)에 그대로 쌓인다. 주소를 시스템 억제 목록에 적어
    //   다음 로그인·가입 메일이 그 주소로 나가지 않게 한다. 일시 바운스(Transient)·판정 불가(Undetermined)는 적지 않는다.
    const suppression = systemMailSuppressionOf(eventType, detail);
    if (suppression !== null) return { kind: 'system_suppression', suppression };
    return { kind: 'ignored', eventType: `owner_notification.${eventType}` };
  }

  return {
    kind: 'event',
    event: {
      eventType,
      // **되돌릴 수 없는 태그는 `null` 로 둔다.** 버리지 않는 이유: 조인 불가능한
      // 이벤트가 쌓이는 것 자체가 `EmailTags` 배선이 끊겼다는 신호이고, 버리면
      // 그 신호도 함께 사라진다. 역변환을 여기서 부르는 것이 요점이다 — 전송단이
      // 쓴 규칙(`toMessageIdTagValue`)과 **같은 파일의 짝**으로 되돌려야 단사성
      // 테스트가 이 경로를 실제로 덮는다.
      messageId: tagValue === null ? null : fromMessageIdTagValue(tagValue),
      sesMessageId: asString(mail['messageId']),
      eventAt,
      dedupeKey: createHash('sha256').update(body, 'utf8').digest('hex'),
    },
    recipients: eventRecipientsOf(eventType, detail),
  };
}

/** 한 이벤트에서 읽는 수신자 수 상한. SES 가 한 통에 싣는 수신자 천장(50)의 두 배 — 넘는 것은 모양이 이상한 입력이다. */
const MAX_EVENT_RECIPIENTS = 100;

/** SES `bounceType` → 닫힌 셋. */
function bounceTypeOf(value: unknown): SesBounceType {
  const text = asString(value);
  if (text === 'Permanent') return 'permanent';
  if (text === 'Transient') return 'transient';
  return 'undetermined';
}

/**
 * delivery·bounce·complaint 하위 객체 → 수신자(메일 기본기 A4). 모양: `delivery.recipients` 는 **문자열 배열**, `bounce.bouncedRecipients` ·
 * `complaint.complainedRecipients` 는 `{emailAddress}` 객체 배열이다. 주소 모양 검사는 시스템 억제와 같은 ASCII 부분집합이다 —
 * 모양이 아닌 값은 버린다(위치를 찾지 못한 주소와 같게 생략된다). **던지지 않는다.**
 */
function eventRecipientsOf(eventType: SesEventType, detail: Record<string, unknown> | null): SesEventRecipients | null {
  let raw: unknown;
  let bounceType: SesBounceType | null = null;
  let bounceSubType: string | null = null;
  if (eventType === 'delivery') {
    raw = detail?.['recipients'];
  } else if (eventType === 'bounce') {
    raw = detail?.['bouncedRecipients'];
    bounceType = bounceTypeOf(detail?.['bounceType']);
    const subType = asString(detail?.['bounceSubType']);
    bounceSubType = subType !== null && /^[A-Za-z]{1,40}$/.test(subType) ? subType : null;
  } else if (eventType === 'complaint') {
    raw = detail?.['complainedRecipients'];
  } else {
    return null;
  }
  const addresses = new Set<string>();
  if (Array.isArray(raw)) {
    for (const entry of raw.slice(0, MAX_EVENT_RECIPIENTS)) {
      const address = recipientAddress(typeof entry === 'string' ? entry : asString(asRecord(entry)?.['emailAddress']));
      if (address !== null) addresses.add(address);
    }
  }
  const count = Array.isArray(raw) ? Math.min(Math.max(raw.length, 1), MAX_EVENT_RECIPIENTS) : 1;
  return { addresses: [...addresses], bounceType, ...(eventType === 'bounce' ? { bounceSubType } : {}), count };
}

/**
 * 알림 본문 하나의 **헤더 From 대 발신 주소** 판정(M3b — `from-alignment.ts`). `parseSesEvent` 와 같은 봉투 규칙으로 `mail` 을 꺼낸다.
 * 이벤트 종류·태그와 무관하게 본다 — 사칭은 에이전트 태그로도 알림 태그로도 올 수 있다. 본문이 깨졌으면 `unknown`. **던지지 않는다.**
 */
export function sesEventFromAlignment(raw: string): FromAlignment {
  const body = extractEventBody(raw);
  if (body === null) return 'unknown';
  try {
    return checkFromAlignment(asRecord(JSON.parse(body))?.['mail']);
  } catch {
    return 'unknown';
  }
}

/** 한 이벤트가 적을 수 있는 주소 수 상한. 시스템 메일은 수신자가 정확히 1명이다 — 넘는 것은 모양이 이상한 입력이다. */
const MAX_SUPPRESSION_ADDRESSES = 50;

/**
 * `system_mail_suppressions.address` CHECK 의 **부분집합**(길이 3–254 · 소문자 · `@` 하나 · 공백 없음) — 게다가 **인쇄 가능한
 * ASCII 만**. JS `toLowerCase` 와 DB `lower()` 는 비ASCII 에서 로캘마다 다르게 접는다(inbound V2 — U+038D). 어긋나면 INSERT 가
 * CHECK 로 죽고 그 이벤트는 재전달해도 같다(poison pill). SES 가 싣는 수신 주소는 ASCII 다(IDN 은 punycode).
 */
const SUPPRESSION_ADDRESS_PATTERN = /^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+$/;

/** 이벤트 수신자 칸 하나 → 소문자·앞뒤 공백 제거한 주소. 모양(`SUPPRESSION_ADDRESS_PATTERN` · 길이 3–254)이 아니면 `null`. */
function recipientAddress(text: string | null): string | null {
  const address = text?.trim().toLowerCase();
  if (address === undefined || address.length < 3 || address.length > 254 || !SUPPRESSION_ADDRESS_PATTERN.test(address)) return null;
  return address;
}

/**
 * 알림 태그 메일의 bounce·complaint 하위 객체 → 억제할 주소. 하드 바운스(`bounceType = Permanent`)와 불만만. 주소가 하나도 없으면
 * `null`(버린다 — 적을 것이 없다).
 */
function systemMailSuppressionOf(eventType: SesEventType, detail: Record<string, unknown> | null): SystemMailSuppression | null {
  if (detail === null) return null;
  let reason: SystemMailSuppression['reason'];
  let recipients: unknown;
  if (eventType === 'bounce') {
    if (asString(detail['bounceType']) !== 'Permanent') return null;
    reason = 'hard_bounce';
    recipients = detail['bouncedRecipients'];
  } else if (eventType === 'complaint') {
    reason = 'complaint';
    recipients = detail['complainedRecipients'];
  } else {
    return null;
  }
  if (!Array.isArray(recipients)) return null;
  const addresses = new Set<string>();
  for (const recipient of recipients.slice(0, MAX_SUPPRESSION_ADDRESSES)) {
    const address = recipientAddress(asString(asRecord(recipient)?.['emailAddress']));
    if (address !== null) addresses.add(address);
  }
  return addresses.size === 0 ? null : { reason, addresses: [...addresses] };
}
