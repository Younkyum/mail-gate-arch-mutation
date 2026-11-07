/**
 * `src/mail/transport/ses-transport.ts` — **실제 SES 를 부르지 않는다.**
 *
 * 이 파일이 가짜 클라이언트를 주입하는 것은 테스트 편의가 아니라 R22 그 자체다:
 * SES 계정 한도가 50,000통/일이고 남은 제동장치는 `rules/limits.ts` 의 워밍업 캡뿐인데,
 * **단위 테스트는 그 캡을 지나지 않는다**(관문 밖이다). `pnpm test` 가 메일을 한 통이라도
 * 내보내는 순간 제동장치 없는 발송 경로가 CI 안에 생긴다.
 */

import { describe, expect, it } from 'vitest';
import type { SendEmailCommand } from '@aws-sdk/client-sesv2';

import type { SendingClock } from '../../../src/db/repositories/sending-clock';
import { ATMARK_MESSAGE_ID_TAG, ATMARK_NOTIFICATION_ID_TAG, SesTagValueError } from '../../../src/mail/events/tag';
import type { TransportRequest } from '../../../src/policy/gate';
import {
  assertHeaderFromMatches,
  createSesContactForwardTransport,
  createSesNotificationTransport,
  createSesTransport,
  SES_CONFIGURATION_SET,
  type MessageContent,
  type MessageContentSource,
  type SesSendClient,
} from '../../../src/mail/transport/ses-transport';

const REQUEST: TransportRequest = {
  messageId: '11111111-1111-4111-8111-111111111111',
  messageIdHeader: '<1x.deadbeef@atmark.ai>',
  fromAddress: 'agent@atmark.ai',
  recipients: ['jinyounkyum@gmail.com'],
};

const CONTENT: MessageContent = { subject: 'hello', text: 'body', html: null, threading: null };

interface Recorder {
  readonly client: SesSendClient;
  readonly commands: SendEmailCommand[];
}

// 기본 인자를 쓰지 않는다 — `undefined` 를 명시적으로 넘기는 것이 기본값으로 되살아나면
// "MessageId 없는 응답" 케이스가 조용히 사라진다.
function recordingClient(messageId: string | undefined): Recorder {
  const commands: SendEmailCommand[] = [];
  return {
    commands,
    client: {
      send(command: SendEmailCommand) {
        commands.push(command);
        return Promise.resolve({ MessageId: messageId, $metadata: {} });
      },
    },
  };
}

function contentSource(content: MessageContent = CONTENT): MessageContentSource {
  return { load: () => Promise.resolve(content) };
}

function recordingClock(): { clock: SendingClock; calls: Array<[string, Date]> } {
  const calls: Array<[string, Date]> = [];
  return {
    calls,
    clock: {
      markFirstSend(messageId, now) {
        calls.push([messageId, now]);
        return Promise.resolve(true);
      },
    },
  };
}

const NOW = new Date('2026-10-01T00:00:00.000Z');

describe('createSesTransport', () => {
  it('Configuration Set 을 지정한다 — 빠뜨리면 bounce/complaint 이벤트가 사라진다', async () => {
    const recorder = recordingClient('ses-msg-1');
    const transport = createSesTransport({ client: recorder.client, content: contentSource() });

    await transport.send(REQUEST);

    expect(recorder.commands[0]?.input.ConfigurationSetName).toBe(SES_CONFIGURATION_SET);
    expect(SES_CONFIGURATION_SET).toBe('atmark-default');
  });

  it('**우리 message_id 를 EmailTags 로 싣는다** — SES 가 Message-ID 를 덮어써도 남는 끈 (ADR-0004)', async () => {
    const recorder = recordingClient('ses-msg-1');
    const transport = createSesTransport({ client: recorder.client, content: contentSource() });

    await transport.send(REQUEST);

    // 이 태그가 configuration set 이 발행하는 이벤트의 `mail.tags` 에 그대로 돌아온다.
    // 빠뜨리면 이벤트는 오지만 **어떤 messages 행에도 붙지 않고**, lease 만료 시점에
    // "그 메일은 나갔는가" 에 답할 방법이 다시 0이 된다.
    expect(recorder.commands[0]?.input.EmailTags).toEqual([
      { Name: ATMARK_MESSAGE_ID_TAG, Value: REQUEST.messageId },
    ]);
  });

  it('EmailTags 와 ConfigurationSetName 은 짝이다 — 하나만으로는 둘 다 무의미하다', async () => {
    const recorder = recordingClient('ses-msg-1');
    const transport = createSesTransport({ client: recorder.client, content: contentSource() });

    await transport.send(REQUEST);

    // 태그만 있고 configuration set 이 없으면 이벤트가 발행되지 않고, configuration set 만
    // 있고 태그가 없으면 발행된 이벤트를 조인할 키가 없다.
    const input = recorder.commands[0]?.input;
    expect(input?.ConfigurationSetName).toBe(SES_CONFIGURATION_SET);
    expect(input?.EmailTags).toHaveLength(1);
  });

  it('message_id 가 SES 태그 제약 밖이면 **SES 를 부르지 않는다**', async () => {
    const recorder = recordingClient('ses-msg-1');
    const transport = createSesTransport({ client: recorder.client, content: contentSource() });

    // 되돌아오지 않는 조인 키를 달고 메일이 나가면, 그 발송은 이벤트 평면에서
    // 영원히 보이지 않는다 — `messageIdHeader` 검증과 같은 이유로 전송 전에 끊는다.
    await expect(
      transport.send({ ...REQUEST, messageId: 'not a tag value' }),
    ).rejects.toBeInstanceOf(SesTagValueError);
    expect(recorder.commands).toEqual([]);
  });

  it('From 과 수신자를 그대로 넘긴다 — 정규화는 판정용이고 전송은 원본이다', async () => {
    const recorder = recordingClient('ses-msg-1');
    const transport = createSesTransport({ client: recorder.client, content: contentSource() });

    await transport.send({ ...REQUEST, recipients: ['a+tag@example.com', 'b@example.com'] });

    expect(recorder.commands[0]?.input.FromEmailAddress).toBe('agent@atmark.ai');
    expect(recorder.commands[0]?.input.Destination?.ToAddresses).toEqual([
      'a+tag@example.com',
      'b@example.com',
    ]);
  });

  it('raw MIME 에 주어진 Message-ID 를 싣는다 (§4.5-4)', async () => {
    const recorder = recordingClient('ses-msg-1');
    const transport = createSesTransport({ client: recorder.client, content: contentSource() });

    const result = await transport.send(REQUEST);

    const raw = Buffer.from(recorder.commands[0]?.input.Content?.Raw?.Data ?? new Uint8Array()).toString(
      'utf8',
    );
    expect(raw).toContain('Message-ID: <1x.deadbeef@atmark.ai>');
    // 호출자가 저장·재시도에 쓸 수 있도록 결과에도 돌려준다.
    expect(result.messageIdHeader).toBe('<1x.deadbeef@atmark.ai>');
    expect(result.sesMessageId).toBe('ses-msg-1');
  });

  it('같은 요청을 재시도하면 같은 바이트가 나간다 — 수신측 병합의 전제', async () => {
    const recorder = recordingClient('ses-msg-1');
    const transport = createSesTransport({
      client: recorder.client,
      content: contentSource(),
      now: () => NOW,
    });

    await transport.send(REQUEST);
    await transport.send(REQUEST);

    const [first, second] = recorder.commands.map((command) =>
      Buffer.from(command.input.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8'),
    );
    expect(first).toBe(second);
  });

  it('Message-ID 형식이 깨지면 SES 를 부르지 않는다', async () => {
    const recorder = recordingClient('ses-msg-1');
    const transport = createSesTransport({ client: recorder.client, content: contentSource() });

    await expect(transport.send({ ...REQUEST, messageIdHeader: 'deadbeef@atmark.ai' })).rejects.toThrow(
      /Message-ID/,
    );
    expect(recorder.commands).toEqual([]);
  });

  it('MessageId 없는 응답은 성공으로 치지 않는다', async () => {
    const recorder = recordingClient(undefined);
    const transport = createSesTransport({ client: recorder.client, content: contentSource() });

    await expect(transport.send(REQUEST)).rejects.toThrow(/MessageId/);
  });

  it('최초 성공 시 sending_started_at 세팅을 부른다 (§3.3 M7)', async () => {
    const recorder = recordingClient('ses-msg-1');
    const { clock, calls } = recordingClock();
    const transport = createSesTransport({
      client: recorder.client,
      content: contentSource(),
      sendingClock: clock,
      now: () => NOW,
    });

    await transport.send(REQUEST);

    expect(calls).toEqual([[REQUEST.messageId, NOW]]);
  });

  it('SES 가 실패하면 기준일을 세팅하지 않는다 — 한 통도 못 보낸 채 램프가 시작되면 안 된다', async () => {
    const { clock, calls } = recordingClock();
    const transport = createSesTransport({
      client: { send: () => Promise.reject(new Error('SES down')) },
      content: contentSource(),
      sendingClock: clock,
    });

    await expect(transport.send(REQUEST)).rejects.toThrow('SES down');
    expect(calls).toEqual([]);
  });

  it('기준일 기록이 실패해도 발송은 성공으로 남는다 — 여기서 던지면 같은 메일이 두 번 나간다', async () => {
    const recorder = recordingClient('ses-msg-1');
    const transport = createSesTransport({
      client: recorder.client,
      content: contentSource(),
      sendingClock: { markFirstSend: () => Promise.reject(new Error('db down')) },
    });

    await expect(transport.send(REQUEST)).resolves.toMatchObject({ sesMessageId: 'ses-msg-1' });
  });

  it('본문 출처가 실패하면 SES 를 부르지 않는다', async () => {
    const recorder = recordingClient('ses-msg-1');
    const transport = createSesTransport({
      client: recorder.client,
      content: { load: () => Promise.reject(new Error('s3 down')) },
    });

    await expect(transport.send(REQUEST)).rejects.toThrow('s3 down');
    expect(recorder.commands).toEqual([]);
  });
});

describe('createSesNotificationTransport — 소유자 승인 알림면 (P2)', () => {
  const EMAIL = {
    notificationId: '22222222-2222-4222-8222-222222222222',
    fromAddress: 'notify@atmark.ai',
    toAddress: 'owner@example.com',
    subject: '[Atmark] 발송 승인 요청 22222222',
    text: '본문',
  } as const;

  it('수신자는 정확히 1명, Configuration Set 은 에이전트 메일과 같다(TLS REQUIRE)', async () => {
    const recorder = recordingClient('ses-n-1');
    const transport = createSesNotificationTransport({ client: recorder.client, now: () => NOW });
    expect(await transport.sendOwnerNotification(EMAIL)).toEqual({ sesMessageId: 'ses-n-1' });
    const input = recorder.commands[0]?.input;
    expect(input?.Destination?.ToAddresses).toEqual(['owner@example.com']);
    expect(input?.FromEmailAddress).toBe('notify@atmark.ai');
    expect(input?.ConfigurationSetName).toBe(SES_CONFIGURATION_SET);
  });

  it('알림 태그만 싣는다 — 에이전트 조인 태그를 실으면 이벤트 소비자가 messages FK 에 걸린다', async () => {
    const recorder = recordingClient('ses-n-2');
    await createSesNotificationTransport({ client: recorder.client }).sendOwnerNotification(EMAIL);
    const tags = recorder.commands[0]?.input.EmailTags ?? [];
    expect(tags).toEqual([{ Name: ATMARK_NOTIFICATION_ID_TAG, Value: EMAIL.notificationId }]);
    expect(tags.some((tag) => tag.Name === ATMARK_MESSAGE_ID_TAG)).toBe(false);
  });

  it('text/plain 단일 파트다 — HTML 파트가 없다', async () => {
    const recorder = recordingClient('ses-n-3');
    await createSesNotificationTransport({ client: recorder.client, now: () => NOW }).sendOwnerNotification(EMAIL);
    const raw = Buffer.from(recorder.commands[0]?.input.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8');
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(raw).not.toContain('text/html');
    expect(raw).toContain('Message-ID: <notify.22222222-2222-4222-8222-222222222222@atmark.ai>');
  });

  it('html 을 주면 multipart/alternative — text/plain 이 먼저, text/html 이 뒤(로그인·가입·초대·운영 코드 메일, 2026-09-28)', async () => {
    const recorder = recordingClient('ses-n-3b');
    const html = '<!DOCTYPE html>\n<html lang="ko"><body><p>본문</p></body></html>';
    await createSesNotificationTransport({ client: recorder.client, now: () => NOW }).sendOwnerNotification({ ...EMAIL, html });
    const raw = Buffer.from(recorder.commands[0]?.input.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8');
    expect(raw).toContain('Content-Type: multipart/alternative;');
    const plainAt = raw.indexOf('Content-Type: text/plain; charset=UTF-8');
    const htmlAt = raw.indexOf('Content-Type: text/html; charset=UTF-8');
    expect(plainAt).toBeGreaterThan(0);
    expect(htmlAt).toBeGreaterThan(plainAt);
    expect(raw).toContain(Buffer.from(html, 'utf8').toString('base64').slice(0, 60));
    expect(raw).toContain(Buffer.from('본문', 'utf8').toString('base64'));
    expect(recorder.commands[0]?.input.EmailTags).toEqual([{ Name: ATMARK_NOTIFICATION_ID_TAG, Value: EMAIL.notificationId }]);
  });

  it('수신자에 CRLF 가 있으면 보내기 전에 던진다 — 헤더 인젝션', async () => {
    const recorder = recordingClient('ses-n-4');
    await expect(
      createSesNotificationTransport({ client: recorder.client }).sendOwnerNotification({
        ...EMAIL,
        toAddress: 'owner@example.com\r\nBcc: everyone@example.com',
      }),
    ).rejects.toThrow(/제어문자/);
    expect(recorder.commands).toEqual([]);
  });

  it('태그로 쓸 수 없는 notificationId 는 보내기 전에 던진다', async () => {
    const recorder = recordingClient('ses-n-5');
    await expect(
      createSesNotificationTransport({ client: recorder.client }).sendOwnerNotification({ ...EMAIL, notificationId: 'not a tag' }),
    ).rejects.toBeInstanceOf(SesTagValueError);
    expect(recorder.commands).toEqual([]);
  });

  it('MessageId 없는 응답은 성공으로 치지 않는다', async () => {
    const recorder = recordingClient(undefined);
    await expect(createSesNotificationTransport({ client: recorder.client }).sendOwnerNotification(EMAIL)).rejects.toThrow(
      /MessageId/,
    );
  });
});

// US-009(ADR-0009) — 문의 전달면. Reply-To 칸이 있는 유일한 면이다.
describe('문의 전달면 — Reply-To 헤더 안전', () => {
  function capture(): { client: { send: (c: SendEmailCommand) => Promise<{ MessageId: string; $metadata: object }> }; sent: SendEmailCommand['input'][] } {
    const sent: SendEmailCommand['input'][] = [];
    return { sent, client: { send: (command) => (sent.push(command.input), Promise.resolve({ MessageId: 'm-1', $metadata: {} })) } };
  }
  const email = {
    forwardId: '00000000-0000-4000-8000-000000000001',
    fromAddress: 'support@atmark.ai',
    toAddress: 'ops@example.test',
    replyToAddress: 'a@example.test',
    subject: '[Atmark 문의] x',
    text: 'body',
  };

  it('Reply-To 한 줄 · To 전달 주소 하나 · 알림 태그', async () => {
    const { client, sent } = capture();
    await createSesContactForwardTransport({ client }).sendContactForward(email);
    const raw = Buffer.from(sent[0]?.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8');
    expect(raw).toContain('\r\nReply-To: a@example.test\r\n');
    expect(raw).toContain('\r\nTo: ops@example.test\r\n');
    expect(sent[0]?.Destination).toEqual({ ToAddresses: ['ops@example.test'] });
    expect(sent[0]?.EmailTags).toEqual([{ Name: 'atmark_notification_id', Value: email.forwardId }]);
  });

  it('Reply-To 에 개행이 있으면 보내기 전에 던진다(헤더 인젝션)', async () => {
    const { client, sent } = capture();
    await expect(
      createSesContactForwardTransport({ client }).sendContactForward({ ...email, replyToAddress: 'a@example.test\r\nBcc: x@y.test' }),
    ).rejects.toThrow(/Reply-To/);
    expect(sent).toEqual([]);
  });
});


// 2026-09-24 최종 검증 M3b — raw MIME 의 헤더 From 과 FromEmailAddress 는 같은 값이어야 한다(IAM 은 FromEmailAddress 만 본다).
describe('헤더 From = FromEmailAddress — 세 발송면 모두 보내기 전에 확인 (M3b)', () => {
  const rawWith = (headers: string): string => `${headers}\r\nSubject: x\r\n\r\nbody\r\nFrom: login@atmark.ai\r\n`;

  it('같으면 통과 · 다르면·둘이면·없으면·표시 이름이 붙으면 던진다(본문의 From: 줄은 헤더가 아니다)', () => {
    expect(() => assertHeaderFromMatches(rawWith('From: agent@atmark.ai'), 'agent@atmark.ai')).not.toThrow();
    expect(() => assertHeaderFromMatches(rawWith('FROM:   agent@atmark.ai  '), 'agent@atmark.ai')).not.toThrow();
    expect(() => assertHeaderFromMatches(rawWith('From: login@atmark.ai'), 'agent@atmark.ai')).toThrow(/헤더 From/);
    expect(() => assertHeaderFromMatches(rawWith('From: agent@atmark.ai\r\nFrom: login@atmark.ai'), 'agent@atmark.ai')).toThrow(/2개/);
    expect(() => assertHeaderFromMatches(rawWith('To: a@example.com'), 'agent@atmark.ai')).toThrow(/0개/);
    expect(() => assertHeaderFromMatches(rawWith('From: "login@atmark.ai" <agent@atmark.ai>'), 'agent@atmark.ai')).toThrow(/헤더 From/);
    // 접힌 줄은 펼쳐서 본다.
    expect(() => assertHeaderFromMatches(rawWith('From:\r\n agent@atmark.ai'), 'agent@atmark.ai')).not.toThrow();
  });

  it('앞뒤 공백이 붙은 FromEmailAddress(` login@atmark.ai`)는 헤더에서 벗겨져 달라진다 — 세 면 모두 SES 를 부르지 않는다', async () => {
    const agent = recordingClient('ses-m3b-1');
    await expect(
      createSesTransport({ client: agent.client, content: contentSource() }).send({ ...REQUEST, fromAddress: ' agent@atmark.ai' }),
    ).rejects.toThrow(/헤더 From/);
    expect(agent.commands).toEqual([]);

    const notify = recordingClient('ses-m3b-2');
    await expect(
      createSesNotificationTransport({ client: notify.client }).sendOwnerNotification({
        notificationId: '22222222-2222-4222-8222-222222222222',
        fromAddress: ' login@atmark.ai',
        toAddress: 'owner@example.com',
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/헤더 From/);
    expect(notify.commands).toEqual([]);

    const contact = recordingClient('ses-m3b-3');
    await expect(
      createSesContactForwardTransport({ client: contact.client }).sendContactForward({
        forwardId: '00000000-0000-4000-8000-000000000001',
        fromAddress: 'support@atmark.ai ',
        toAddress: 'ops@example.test',
        replyToAddress: 'a@example.test',
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/헤더 From/);
    expect(contact.commands).toEqual([]);
  });

  it('정상 발송: 헤더 From 줄이 정확히 하나이고 FromEmailAddress 와 같다', async () => {
    const recorder = recordingClient('ses-m3b-4');
    await createSesTransport({ client: recorder.client, content: contentSource() }).send(REQUEST);
    const input = recorder.commands[0]?.input;
    const raw = Buffer.from(input?.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8');
    expect(() => assertHeaderFromMatches(raw, input?.FromEmailAddress ?? '')).not.toThrow();
  });
});

describe('알림면의 표시 이름 From(환영 메일, 202609301510) — 헤더는 그 값 글자 그대로 · 주소는 FromEmailAddress 와 같다', () => {
  const EMAIL = {
    notificationId: '33333333-3333-4333-8333-333333333333',
    fromAddress: 'onve@atmark.ai',
    fromHeader: '"Onve (Atmark)" <onve@atmark.ai>',
    toAddress: 'new@example.com',
    subject: 'Welcome to Atmark',
    text: 'hi',
  } as const;

  it('FromEmailAddress 는 주소, raw 의 헤더 From 은 표시 이름 값 한 줄 · 알림 태그 · 같은 Configuration Set', async () => {
    const recorder = recordingClient('ses-w-1');
    await createSesNotificationTransport({ client: recorder.client, now: () => NOW }).sendOwnerNotification(EMAIL);
    const input = recorder.commands[0]?.input;
    expect(input?.FromEmailAddress).toBe('onve@atmark.ai');
    expect(input?.ConfigurationSetName).toBe(SES_CONFIGURATION_SET);
    expect(input?.EmailTags).toEqual([{ Name: ATMARK_NOTIFICATION_ID_TAG, Value: EMAIL.notificationId }]);
    const raw = Buffer.from(input?.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8');
    const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
    expect(head.split('\r\n').filter((line) => /^from:/i.test(line))).toEqual(['From: "Onve (Atmark)" <onve@atmark.ai>']);
    expect(() => assertHeaderFromMatches(raw, EMAIL.fromHeader)).not.toThrow();
    expect(() => assertHeaderFromMatches(raw, 'onve@atmark.ai')).toThrow(/헤더 From/);
  });

  it.each([
    '"Onve (Atmark)" <login@atmark.ai>',
    '"Onve (Atmark)" <onve@atmark.ai> ',
    'Onve <onve@atmark.ai>',
    '"On"ve" <onve@atmark.ai>',
    '"Onve\\" <onve@atmark.ai>',
    '"Onve\r\nBcc: x@example.com" <onve@atmark.ai>',
    '"온브" <onve@atmark.ai>',
    '"" <onve@atmark.ai>',
    'onve@atmark.ai',
  ])('모양이 틀린 표시 이름 From(%j)은 SES 를 부르지 않고 던진다', async (fromHeader) => {
    const recorder = recordingClient('ses-w-2');
    await expect(createSesNotificationTransport({ client: recorder.client }).sendOwnerNotification({ ...EMAIL, fromHeader })).rejects.toThrow();
    expect(recorder.commands).toEqual([]);
  });
});
