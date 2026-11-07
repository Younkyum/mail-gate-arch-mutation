/**
 * `src/inbound/receipt.ts` — SES 수신 알림은 **외부 입력**이다.
 *
 * 단언의 축 셋: ① 봉투 수신자·판정을 정확히 뽑는다, ② `fromAuthenticated` 는 DMARC 에서만 온다
 * (SPF·DKIM 단독 통과, SES 와 우리 파서의 `From` 불일치는 인증이 아니다), ③ 어떤 모양이 와도 던지지 않는다.
 */

import { describe, expect, it } from 'vitest';

import {
  domainOfHeaderAddress,
  isFromAuthenticated,
  parseInboundReceipt,
  type InboundReceipt,
} from '../../../src/inbound/receipt';

const SES_ID = '0100019a1b2c3d4e-ffc5f9ef-7fee-4110-b053-f8ad189121f6-000000';

interface NotificationOptions {
  readonly notificationType?: string;
  readonly recipients?: unknown;
  readonly source?: unknown;
  readonly verdicts?: Partial<Record<'spf' | 'dkim' | 'dmarc' | 'spam' | 'virus', string | null>>;
  readonly headers?: readonly { name: string; value: string }[];
  readonly headersTruncated?: boolean;
  readonly commonFrom?: unknown;
  readonly action?: unknown;
  readonly messageId?: unknown;
  readonly timestamp?: unknown;
}

function notification(options: NotificationOptions = {}): Record<string, unknown> {
  const verdict = (key: 'spf' | 'dkim' | 'dmarc' | 'spam' | 'virus', fallback: string): unknown => {
    const value = options.verdicts?.[key];
    if (value === null) return undefined;
    return { status: value ?? fallback };
  };
  return {
    notificationType: options.notificationType ?? 'Received',
    mail: {
      timestamp: '2026-09-23T01:02:03.000Z',
      source: 'source' in options ? options.source : 'sender@example.com',
      messageId: 'messageId' in options ? options.messageId : SES_ID,
      destination: ['agent@atmark.ai'],
      headersTruncated: options.headersTruncated ?? false,
      headers: options.headers ?? [],
      commonHeaders: { from: 'commonFrom' in options ? options.commonFrom : ['Sender <sender@example.com>'] },
    },
    receipt: {
      timestamp: 'timestamp' in options ? options.timestamp : '2026-09-23T01:02:04.000Z',
      recipients: 'recipients' in options ? options.recipients : ['agent@atmark.ai'],
      spfVerdict: verdict('spf', 'PASS'),
      dkimVerdict: verdict('dkim', 'PASS'),
      dmarcVerdict: verdict('dmarc', 'PASS'),
      spamVerdict: verdict('spam', 'PASS'),
      virusVerdict: verdict('virus', 'PASS'),
      action:
        'action' in options
          ? options.action
          : { type: 'S3', bucketName: 'bucket', objectKeyPrefix: 'inbound/raw/', objectKey: `inbound/raw/${SES_ID}` },
    },
  };
}

/** SNS→SQS(원문 전달 꺼짐) 봉투. */
function envelope(body: unknown, type = 'Notification'): string {
  return JSON.stringify({ Type: type, MessageId: 'sns-1', Message: JSON.stringify(body) });
}

function parseOk(raw: string): InboundReceipt {
  const result = parseInboundReceipt(raw);
  if (result.kind !== 'receipt') throw new Error(`receipt 가 아니다: ${JSON.stringify(result)}`);
  return result.receipt;
}

describe('봉투와 판정을 뽑는다', () => {
  it('SNS 봉투 안의 SES 수신 알림 → 메시지 ID · 객체 키 · 봉투 수신자 · 판정 · 봉투 발신자', () => {
    const receipt = parseOk(envelope(notification({ verdicts: { spam: 'FAIL', virus: 'GRAY' } })));
    expect(receipt.sesMessageId).toBe(SES_ID);
    expect(receipt.objectKey).toBe(`inbound/raw/${SES_ID}`);
    expect(receipt.envelopeRecipients).toEqual(['agent@atmark.ai']);
    expect(receipt.envelopeSender).toBe('sender@example.com');
    expect(receipt.verdicts).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass', spam: 'fail', virus: 'gray' });
    // receipt.timestamp 가 우선이다(mail.timestamp 는 발신 시각일 수 있다).
    expect(receipt.receivedAt.toISOString()).toBe('2026-09-23T01:02:04.000Z');
  });

  it('봉투가 없는(원문 전달·직결) 본문도 받는다 — 배선을 바꾸는 날 조용히 0건이 되지 않게', () => {
    expect(parseOk(JSON.stringify(notification())).sesMessageId).toBe(SES_ID);
  });

  it('봉투 수신자는 소문자·중복 제거·주소 모양만 — 헤더 To 는 보지 않는다', () => {
    const receipt = parseOk(
      envelope(notification({ recipients: ['Agent@Atmark.AI', 'agent@atmark.ai', 'not-an-address', 7, 'b@atmark.ai'] })),
    );
    expect(receipt.envelopeRecipients).toEqual(['agent@atmark.ai', 'b@atmark.ai']);
  });

  it('모르는·없는 판정은 unknown 이다 — 통과로 읽지 않는다', () => {
    const receipt = parseOk(envelope(notification({ verdicts: { dmarc: null, spf: 'MAYBE' } })));
    expect(receipt.verdicts.dmarc).toBe('unknown');
    expect(receipt.verdicts.spf).toBe('unknown');
  });

  it('PROCESSING_FAILED · DISABLED 를 구분해 보존한다', () => {
    const receipt = parseOk(envelope(notification({ verdicts: { virus: 'PROCESSING_FAILED', spam: 'DISABLED' } })));
    expect(receipt.verdicts.virus).toBe('processing_failed');
    expect(receipt.verdicts.spam).toBe('disabled');
  });

  it('receipt.timestamp 가 없으면 mail.timestamp', () => {
    expect(parseOk(envelope(notification({ timestamp: undefined }))).receivedAt.toISOString()).toBe(
      '2026-09-23T01:02:03.000Z',
    );
  });
});

describe('GATE B2③ 원자료 — 봉투 발신자와 전달 흔적', () => {
  it('Gmail 전달이 재작성한 봉투 발신자를 **정규화하지 않고** 그대로 남긴다', () => {
    const receipt = parseOk(envelope(notification({ source: 'Founder+caf_=agent=atmark.ai@gmail.com' })));
    expect(receipt.envelopeSender).toBe('Founder+caf_=agent=atmark.ai@gmail.com');
  });

  it('널 발신자(<>·빈 값)·제어문자·과길이는 null', () => {
    expect(parseOk(envelope(notification({ source: '<>' }))).envelopeSender).toBeNull();
    expect(parseOk(envelope(notification({ source: '' }))).envelopeSender).toBeNull();
    expect(parseOk(envelope(notification({ source: 'a\u0000b@x.com' }))).envelopeSender).toBeNull();
    expect(parseOk(envelope(notification({ source: `${'a'.repeat(1000)}@x.com` }))).envelopeSender).toBeNull();
    expect(parseOk(envelope(notification({ source: 42 }))).envelopeSender).toBeNull();
  });

  it('X-Forwarded-For · X-Forwarded-To 첫 값 — 제어문자는 공백, 998자 상한', () => {
    const receipt = parseOk(
      envelope(
        notification({
          headers: [
            { name: 'X-Forwarded-For', value: 'founder@gmail.com agent@atmark.ai' },
            { name: 'x-forwarded-for', value: 'second@gmail.com' },
            { name: 'X-Forwarded-To', value: `agent@atmark.ai\r\n${'x'.repeat(2000)}` },
          ],
        }),
      ),
    );
    expect(receipt.headers.forwardedFor).toBe('founder@gmail.com agent@atmark.ai');
    expect(receipt.headers.forwardedTo?.startsWith('agent@atmark.ai x')).toBe(true);
    expect(receipt.headers.forwardedTo?.length).toBe(998);
  });

  it('헤더가 잘렸다는 SES 의 표시를 보존한다', () => {
    expect(parseOk(envelope(notification({ headersTruncated: true }))).headers.truncated).toBe(true);
  });
});

describe('자동 응답 판정 (턴에서 빠진다)', () => {
  const auto = (headers: { name: string; value: string }[]): boolean =>
    parseOk(envelope(notification({ headers }))).headers.autoSubmitted;

  it.each([
    [[{ name: 'Auto-Submitted', value: 'auto-replied' }], true],
    [[{ name: 'Auto-Submitted', value: 'auto-generated; owner-email="x@y"' }], true],
    [[{ name: 'Auto-Submitted', value: 'No' }], false],
    [[{ name: 'X-Autoreply', value: 'yes' }], true],
    [[{ name: 'Precedence', value: 'bulk' }], true],
    [[{ name: 'Precedence', value: 'first-class' }], false],
    [[], false],
  ])('%j → %s', (headers, expected) => {
    expect(auto(headers)).toBe(expected);
  });

  it('헤더 항목이 이상한 모양이어도 던지지 않는다', () => {
    const receipt = parseOk(
      JSON.stringify({ ...notification(), mail: { ...(notification()['mail'] as object), headers: [null, 3, { name: 5 }] } }),
    );
    expect(receipt.headers.autoSubmitted).toBe(false);
  });
});

describe('fromAuthenticated 는 DMARC 에서만 온다', () => {
  const receipt = (options: NotificationOptions): InboundReceipt => parseOk(envelope(notification(options)));

  it('DMARC pass + SES 가 본 From 도메인 == 우리 파서의 From 도메인 → true', () => {
    expect(isFromAuthenticated(receipt({}), 'sender@example.com')).toBe(true);
    expect(isFromAuthenticated(receipt({ commonFrom: ['"S" <x@EXAMPLE.com>'] }), 'sender@example.com')).toBe(true);
  });

  it('SPF·DKIM 이 통과해도 DMARC 가 fail·gray·unknown 이면 false', () => {
    for (const dmarc of ['FAIL', 'GRAY', 'PROCESSING_FAILED', null] as const) {
      expect(isFromAuthenticated(receipt({ verdicts: { spf: 'PASS', dkim: 'PASS', dmarc } }), 'sender@example.com')).toBe(
        false,
      );
    }
  });

  it('SPF·DKIM 이 fail 이어도 DMARC 가 pass 면 true — 판정은 DMARC 하나다', () => {
    expect(isFromAuthenticated(receipt({ verdicts: { spf: 'FAIL', dkim: 'FAIL' } }), 'sender@example.com')).toBe(true);
  });

  it('SES 가 본 From 과 우리 파서의 From 이 다른 도메인이면 false — SES 의 통과가 우리 From 의 인증으로 둔갑하지 않는다', () => {
    expect(isFromAuthenticated(receipt({ commonFrom: ['attacker@evil.example'] }), 'ceo@bank.example')).toBe(false);
  });

  it('SES 가 본 From 이 0개·2개 이상이면 false', () => {
    expect(isFromAuthenticated(receipt({ commonFrom: [] }), 'sender@example.com')).toBe(false);
    expect(isFromAuthenticated(receipt({ commonFrom: undefined }), 'sender@example.com')).toBe(false);
    expect(
      isFromAuthenticated(receipt({ commonFrom: ['a@example.com', 'b@example.com'] }), 'sender@example.com'),
    ).toBe(false);
  });

  it('domainOfHeaderAddress', () => {
    expect(domainOfHeaderAddress('"Kim, A" <a@Example.COM>')).toBe('example.com');
    expect(domainOfHeaderAddress('a@example.com.')).toBe('example.com');
    expect(domainOfHeaderAddress('no address')).toBeNull();
    expect(domainOfHeaderAddress('a@')).toBeNull();
  });
});

describe('던지지 않는다 — 형태를 믿지 않는다', () => {
  it.each([
    ['JSON 이 아님', 'not json'],
    ['배열', '[]'],
    ['SNS Message 가 JSON 이 아님', JSON.stringify({ Type: 'Notification', Message: 'nope' })],
    ['SNS Message 가 없음', JSON.stringify({ Type: 'Notification' })],
    ['Message 가 JSON 배열', envelope([1, 2])],
    ['notificationType 없음', envelope({ mail: {} })],
    ['mail 없음', envelope({ notificationType: 'Received', receipt: {} })],
    ['messageId 없음', envelope(notification({ messageId: undefined }))],
    ['messageId 에 슬래시', envelope(notification({ messageId: '../outbound/content/x' }))],
    ['action 이 S3 가 아님', envelope(notification({ action: { type: 'Lambda' } }))],
    ['objectKey 없음', envelope(notification({ action: { type: 'S3' } }))],
    ['timestamp 없음', envelope({ ...notification(), mail: { ...(notification()['mail'] as object), timestamp: 'x' }, receipt: { ...(notification()['receipt'] as object), timestamp: undefined } })],
    ['봉투 수신자 없음', envelope(notification({ recipients: [] }))],
    ['봉투 수신자가 배열이 아님', envelope(notification({ recipients: 'agent@atmark.ai' }))],
  ])('%s → unparsable', (_label, raw) => {
    expect(parseInboundReceipt(raw).kind).toBe('unparsable');
  });

  it('SNS 구독 확인 등 알림이 아닌 봉투 → ignored', () => {
    expect(parseInboundReceipt(JSON.stringify({ Type: 'SubscriptionConfirmation', Message: 'hi' }))).toEqual({
      kind: 'ignored',
      notificationType: 'sns:SubscriptionConfirmation',
    });
  });

  it('수신 알림이 아닌 SES 알림(Bounce 등) → ignored', () => {
    expect(parseInboundReceipt(envelope(notification({ notificationType: 'Bounce' })))).toEqual({
      kind: 'ignored',
      notificationType: 'Bounce',
    });
  });
});
