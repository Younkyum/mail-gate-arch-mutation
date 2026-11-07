/**
 * src/inbound/receipt.ts — SES **수신** 알림 파싱 (P3a). SNS 봉투 → SES receipt 알림 JSON → 값 하나.
 *
 * **이 파일은 I/O 를 하지 않는다.** 문자열을 받아 값을 돌려준다(`mail/events/ses-event.ts` 와 같은 규율).
 * SES receipt rule 의 S3 액션이 원문을 `inbound/raw/{messageId}` 에 쓴 **뒤에** SNS 로 이 알림을 보내고,
 * SQS 가 그것을 `workers/inbound-consumer` 에 넘긴다.
 *
 * ---------------------------------------------------------------------------
 * ## 이 알림에서만 얻을 수 있는 것
 * ---------------------------------------------------------------------------
 *
 *   - **봉투 수신자(`receipt.recipients`).** 이 메일을 **어느 에이전트가 받았는가** 의 유일한 근거다.
 *     헤더 `To` 는 발신자가 마음대로 쓰고, Bcc 수신이면 에이전트 주소가 아예 없다(resolve.ts 머리말).
 *   - **판정(`spfVerdict`·`dkimVerdict`·`dmarcVerdict`·`spamVerdict`·`virusVerdict`).** 원문에는 없다
 *     — SES 가 수신 시점에 계산한 값이다. `fromAuthenticated` 는 **DMARC 하나에서만** 온다: SPF 는
 *     봉투 발신자를, DKIM 은 서명 도메인을 인증할 뿐 헤더 `From` 과의 정렬은 DMARC 의 일이다.
 *   - **봉투 발신자(`mail.source`, Return-Path).** GATE B2③ `forwarded_from_human_mailbox` 의 원자료.
 *     Gmail 자동 전달은 이것을 전달자 주소로 재작성하고 헤더 `From` 은 보존한다.
 *
 * ---------------------------------------------------------------------------
 * ## 외부 입력이다 — 형태를 믿지 않는다, 던지지 않는다
 * ---------------------------------------------------------------------------
 *
 * 파싱 실패는 예외가 아니라 값(`{kind:'unparsable'}`)이다. 큐 소비자에서 던지면 재전달되고, 파싱할 수
 * 없는 알림은 재전달해도 파싱되지 않는다(poison pill). **판정 필드가 없거나 모르는 값이면 `unknown`** —
 * 통과로 읽지 않는다. `mail.headers` 는 발신자가 쓴 헤더이므로 여기서 뽑는 헤더 신호는 전부 **보조**다.
 */

import { isAddressShape } from '../policy/policy-loader';

/** SES 판정의 소문자형. DB ENUM `ses_verdict` 와 같은 집합. */
export type ReceiptVerdict = 'pass' | 'fail' | 'gray' | 'processing_failed' | 'disabled' | 'unknown';

const VERDICT_BY_SES_STATUS: Readonly<Record<string, ReceiptVerdict>> = {
  PASS: 'pass',
  FAIL: 'fail',
  GRAY: 'gray',
  PROCESSING_FAILED: 'processing_failed',
  DISABLED: 'disabled',
};

export interface ReceiptVerdicts {
  readonly spf: ReceiptVerdict;
  readonly dkim: ReceiptVerdict;
  readonly dmarc: ReceiptVerdict;
  readonly spam: ReceiptVerdict;
  readonly virus: ReceiptVerdict;
}

/** `mail.headers` 에서 뽑은 보조 신호. **발신자가 쓴 값이다.** */
export interface ReceiptHeaderSignals {
  /** RFC 3834 `Auto-Submitted` ≠ `no`, `X-Autoreply`/`X-Autorespond`, `Precedence: bulk|junk|list|auto_reply`. */
  readonly autoSubmitted: boolean;
  /** Gmail 전달 흔적 `X-Forwarded-For` 의 첫 값(정리됨). */
  readonly forwardedFor: string | null;
  /** Gmail 전달 흔적 `X-Forwarded-To` 의 첫 값(정리됨). */
  readonly forwardedTo: string | null;
  /** SES 가 헤더를 다 싣지 못했다 — 위 신호가 빠졌을 수 있다. */
  readonly truncated: boolean;
}

export interface InboundReceipt {
  /** SES 메시지 ID(`mail.messageId`). 원문 키의 마지막 세그먼트이자 멱등성 키. */
  readonly sesMessageId: string;
  /** S3 액션이 원문을 쓴 키(`receipt.action.objectKey`). 소비자가 `keyFor(sesMessageId)` 와 대조한다. */
  readonly objectKey: string;
  readonly receivedAt: Date;
  /** 봉투 수신자 — 소문자·중복 제거·주소 모양만. 비어 있으면 파싱 실패다. */
  readonly envelopeRecipients: readonly string[];
  /** 봉투 발신자(`mail.source`). 널 발신자(`<>`·빈 값)·제어문자·998자 초과는 `null`. **정규화하지 않는다.** */
  readonly envelopeSender: string | null;
  readonly verdicts: ReceiptVerdicts;
  /**
   * SES 가 DMARC 를 판정한 헤더 `From` 의 도메인들(`mail.commonHeaders.from`, 소문자). 소비자가 자기
   * 파서의 `From` 과 대조한다 — 둘이 다른 `From` 을 봤다면 DMARC 통과는 우리 `From` 의 인증이 아니다.
   */
  readonly dmarcFromDomains: readonly string[];
  readonly headers: ReceiptHeaderSignals;
}

export type ReceiptParse =
  | { readonly kind: 'receipt'; readonly receipt: InboundReceipt }
  /** 수신 알림이 아닌 것(SNS 구독 확인 등). 정상이다. */
  | { readonly kind: 'ignored'; readonly notificationType: string }
  /** **재전달해도 파싱되지 않는다.** detail 에 메일 내용을 싣지 않는다. */
  | { readonly kind: 'unparsable'; readonly detail: string };

/** SES 메시지 ID — S3 키 세그먼트로 안전한 모양. DB CHECK 와 같은 정규식. */
export const SES_MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._=-]{0,254}$/;

/** 헤더 값 상한 — DB 컬럼 CHECK(998, SMTP 한 줄)와 같다. */
const MAX_HEADER_VALUE = 998;
const CONTROL_RUNS = /[\x00-\x1f\x7f-\x9f]+/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

const AUTOMATED_PRECEDENCE = new Set(['bulk', 'junk', 'list', 'auto_reply']);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asDate(value: unknown): Date | null {
  const text = asString(value);
  if (text === null) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function verdictOf(receipt: Record<string, unknown>, field: string): ReceiptVerdict {
  const status = asString(asRecord(receipt[field])?.['status']);
  return (status === null ? undefined : VERDICT_BY_SES_STATUS[status.toUpperCase()]) ?? 'unknown';
}

/** 헤더 값 정리: 제어문자 → 공백, 한 줄, 998자. 비면 `null`. */
function cleanHeaderValue(value: string): string | null {
  const cleaned = value.replace(CONTROL_RUNS, ' ').trim().slice(0, MAX_HEADER_VALUE);
  return cleaned === '' ? null : cleaned;
}

/** `"Name" <a@b.com>` · `a@b.com` → `b.com`. 모양이 아니면 `null`. */
export function domainOfHeaderAddress(value: string): string | null {
  const match = /@([^@\s<>"]+)\s*>?\s*$/.exec(value.trim());
  const domain = match?.[1]?.toLowerCase().replace(/\.$/, '');
  return domain === undefined || domain === '' ? null : domain;
}

function headerSignals(mail: Record<string, unknown>): ReceiptHeaderSignals {
  const raw = Array.isArray(mail['headers']) ? mail['headers'] : [];
  let autoSubmitted = false;
  let forwardedFor: string | null = null;
  let forwardedTo: string | null = null;
  for (const entry of raw) {
    const record = asRecord(entry);
    const name = asString(record?.['name'])?.trim().toLowerCase();
    const value = typeof record?.['value'] === 'string' ? record['value'] : '';
    if (name === undefined) continue;
    const token = value.split(';')[0]?.trim().toLowerCase() ?? '';
    if (name === 'auto-submitted' && token !== 'no') autoSubmitted = true;
    if (name === 'x-autoreply' || name === 'x-autorespond') autoSubmitted = true;
    if (name === 'precedence' && AUTOMATED_PRECEDENCE.has(token)) autoSubmitted = true;
    if (name === 'x-forwarded-for' && forwardedFor === null) forwardedFor = cleanHeaderValue(value);
    if (name === 'x-forwarded-to' && forwardedTo === null) forwardedTo = cleanHeaderValue(value);
  }
  return { autoSubmitted, forwardedFor, forwardedTo, truncated: mail['headersTruncated'] === true };
}

/** 널 발신자·제어문자·과길이는 `null`. 대소문자·`+태그` 는 그대로 둔다(판정식의 일). */
function envelopeSenderOf(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || text === '<>') return null;
  if (CONTROL.test(text) || text.length > MAX_HEADER_VALUE) return null;
  return text;
}

function envelopeRecipientsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const address = item.trim().toLowerCase();
    if (isAddressShape(address) && !CONTROL.test(address)) out.add(address);
  }
  return [...out];
}

function dmarcFromDomainsOf(mail: Record<string, unknown>): string[] {
  const from = asRecord(mail['commonHeaders'])?.['from'];
  if (!Array.isArray(from)) return [];
  return from
    .map((value) => (typeof value === 'string' ? domainOfHeaderAddress(value) : null))
    .filter((domain): domain is string => domain !== null);
}

/**
 * SNS 봉투를 벗긴다. SNS→SQS(원문 전달 꺼짐)면 한 겹, 원문 전달·직결이면 없다 — 둘 다 받는다
 * (`ses-event.ts` 와 같은 이유: 배선을 바꾸는 날 소비자가 조용히 0건을 처리하지 않게).
 */
function unwrap(raw: string): { readonly body: unknown } | { readonly ignored: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  const type = asString(record['Type']);
  if (type === null) return { body: record };
  if (type !== 'Notification') return { ignored: `sns:${type}` };
  const message = asString(record['Message']);
  if (message === null) return null;
  try {
    return { body: JSON.parse(message) as unknown };
  } catch {
    return null;
  }
}

/** SQS 본문 하나를 파싱한다. **던지지 않는다.** */
export function parseInboundReceipt(raw: string): ReceiptParse {
  const unwrapped = unwrap(raw);
  if (unwrapped === null) return { kind: 'unparsable', detail: 'JSON 이 아니거나 SNS Message 가 JSON 이 아니다' };
  if ('ignored' in unwrapped) return { kind: 'ignored', notificationType: unwrapped.ignored };

  const notification = asRecord(unwrapped.body);
  if (notification === null) return { kind: 'unparsable', detail: '알림 본문이 객체가 아니다' };

  const notificationType = asString(notification['notificationType']);
  if (notificationType === null) return { kind: 'unparsable', detail: 'notificationType 이 없다' };
  if (notificationType !== 'Received') return { kind: 'ignored', notificationType };

  const mail = asRecord(notification['mail']);
  const receipt = asRecord(notification['receipt']);
  if (mail === null || receipt === null) return { kind: 'unparsable', detail: 'mail 또는 receipt 객체가 없다' };

  const sesMessageId = asString(mail['messageId']);
  if (sesMessageId === null || !SES_MESSAGE_ID_PATTERN.test(sesMessageId)) {
    return { kind: 'unparsable', detail: 'mail.messageId 가 없거나 키 세그먼트 모양이 아니다' };
  }

  const action = asRecord(receipt['action']);
  if (asString(action?.['type']) !== 'S3') {
    return { kind: 'unparsable', detail: 'receipt.action 이 S3 가 아니다 — 원문을 읽을 곳이 없다' };
  }
  const objectKey = asString(action?.['objectKey']);
  if (objectKey === null) return { kind: 'unparsable', detail: 'receipt.action.objectKey 가 없다' };

  const receivedAt = asDate(receipt['timestamp']) ?? asDate(mail['timestamp']);
  if (receivedAt === null) return { kind: 'unparsable', detail: 'timestamp 를 읽을 수 없다' };

  const envelopeRecipients = envelopeRecipientsOf(receipt['recipients']);
  if (envelopeRecipients.length === 0) {
    return { kind: 'unparsable', detail: 'receipt.recipients 에 주소 모양의 값이 없다' };
  }

  return {
    kind: 'receipt',
    receipt: {
      sesMessageId,
      objectKey,
      receivedAt,
      envelopeRecipients,
      envelopeSender: envelopeSenderOf(mail['source']),
      verdicts: {
        spf: verdictOf(receipt, 'spfVerdict'),
        dkim: verdictOf(receipt, 'dkimVerdict'),
        dmarc: verdictOf(receipt, 'dmarcVerdict'),
        spam: verdictOf(receipt, 'spamVerdict'),
        virus: verdictOf(receipt, 'virusVerdict'),
      },
      dmarcFromDomains: dmarcFromDomainsOf(mail),
      headers: headerSignals(mail),
    },
  };
}

/**
 * **`From` 이 인증됐는가** — resolve.ts 의 `fromAuthenticated`, DB CHECK
 * `inbound_messages_authentication_is_dmarc` 와 같은 문장.
 *
 * 조건 셋: ① DMARC 가 `pass`(SPF·DKIM 단독 통과는 인증이 아니다), ② SES 가 판정한 헤더 `From` 이
 * **정확히 하나**, ③ 그 도메인이 **우리 파서가 뽑은 `From` 의 도메인과 같다**. ③이 없으면 SES 와 우리
 * 파서가 서로 다른 `From` 을 본 메일(인코딩 워드·접힘·중복 헤더의 해석 차이)에서 SES 의 통과가
 * 우리가 저장한 `From` 의 인증으로 둔갑한다.
 */
export function isFromAuthenticated(receipt: InboundReceipt, parsedFromAddress: string): boolean {
  if (receipt.verdicts.dmarc !== 'pass') return false;
  if (receipt.dmarcFromDomains.length !== 1) return false;
  const parsedDomain = domainOfHeaderAddress(parsedFromAddress);
  return parsedDomain !== null && parsedDomain === receipt.dmarcFromDomains[0];
}
