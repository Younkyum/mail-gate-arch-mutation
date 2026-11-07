/**
 * `src/mail/thread/resolve.ts` — 스레드 소속은 **권한 판단의 입력**이다.
 *
 * 여기서 단언하는 것의 절반은 "회신을 잘 잇는다" 이고, 나머지 절반은 **잇지 말아야 할 것을
 * 잇지 않는다** 이다: id 를 아는 제3자, `From` 을 사칭한 메일, 다른 에이전트의 메시지,
 * 나간 적 없는 메시지의 id, 같은 제목. 뒤쪽 절반이 빨개지지 않는 해석기는 승인 우회 장치다.
 */

import { describe, expect, it } from 'vitest';

import {
  candidateIds,
  extractMessageIds,
  MAX_CANDIDATE_IDS,
  normalizeMessageId,
  normalizeSubject,
  resolveThread,
  sesMessageIdOf,
  type HeaderLookupKey,
  type InboundThreadHeaders,
  type KnownMessage,
  type ThreadLookupPort,
} from '../../../src/mail/thread/resolve';

const AGENT = 'agent-1';
const OTHER_AGENT = 'agent-2';

/** 2026-09-22 실발송에서 관측된 SES id 형태. */
const SES_ID = '010c01a0c8371fce-ffc5f9ef-7fee-4110-b053-f8ad189121f6-000000';
const SES_HEADER = `<${SES_ID}@ap-northeast-2.amazonses.com>`;
const OUR_HEADER = '<mucer1q5.8bdf04e123491e7212171815@atmark.ai>';

interface StoredMessage {
  readonly messageId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly recipients: readonly string[];
  readonly sender: string;
  readonly sent: boolean;
  /** inbound 의 `From` 이 인증됐는가(DMARC). 기본 `true`. */
  readonly senderAuthenticated?: boolean;
  readonly messageIdHeader: string;
  readonly sesMessageId: string | null;
  readonly subject: string;
}

function outbound(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    messageId: 'msg-out-1',
    agentId: AGENT,
    threadId: 'thread-1',
    direction: 'outbound',
    recipients: ['bob@partner.com'],
    sender: 'agent@atmark.ai',
    sent: true,
    messageIdHeader: OUR_HEADER,
    sesMessageId: SES_ID,
    subject: '견적 요청',
    ...overrides,
  };
}

function inbound(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    messageId: 'msg-in-1',
    agentId: AGENT,
    threadId: 'thread-1',
    direction: 'inbound',
    recipients: [],
    sender: 'bob@partner.com',
    sent: true,
    messageIdHeader: '<CAbob1@mail.gmail.com>',
    sesMessageId: null,
    subject: 'Re: 견적 요청',
    ...overrides,
  };
}

/** 정직한 포트 — 에이전트 범위와 키를 지킨다. 다음 워커의 SQL 이 할 일과 같다. */
function memoryPort(rows: readonly StoredMessage[]): ThreadLookupPort & { subjectCalls: number } {
  const port = {
    subjectCalls: 0,
    findByHeaderKeys(agentId: string, keys: readonly HeaderLookupKey[]): Promise<readonly KnownMessage[]> {
      const out: KnownMessage[] = [];
      for (const row of rows) {
        if (row.agentId !== agentId) continue;
        for (const key of keys) {
          const column = key.kind === 'message_id_header' ? row.messageIdHeader : row.sesMessageId;
          if (column === key.value) out.push(toKnown(row, key));
        }
      }
      return Promise.resolve(out);
    },
    findThreadIdsBySubject(agentId: string, normalized: string, counterpart: string): Promise<readonly string[]> {
      port.subjectCalls += 1;
      const ids = new Set<string>();
      for (const row of rows) {
        if (row.agentId !== agentId) continue;
        if (normalizeSubject(row.subject).normalized !== normalized) continue;
        const participants = row.direction === 'outbound' ? row.recipients : [row.sender];
        if (participants.includes(counterpart)) ids.add(row.threadId);
      }
      return Promise.resolve([...ids]);
    },
  };
  return port;
}

function toKnown(row: StoredMessage, key: HeaderLookupKey): KnownMessage {
  return {
    messageId: row.messageId,
    agentId: row.agentId,
    threadId: row.threadId,
    direction: row.direction,
    recipients: row.recipients,
    sender: row.sender,
    sent: row.sent,
    senderAuthenticated: row.senderAuthenticated ?? true,
    matchedKey: key,
  };
}

function reply(overrides: Partial<InboundThreadHeaders> = {}): InboundThreadHeaders {
  return {
    agentId: AGENT,
    messageId: '<CAbob2@mail.gmail.com>',
    inReplyTo: SES_HEADER,
    references: [SES_HEADER],
    from: 'bob@partner.com',
    fromAuthenticated: true,
    subject: 'Re: 견적 요청',
    ...overrides,
  };
}

describe('resolveThread — 우리가 보낸 메일에 대한 회신', () => {
  it('SES 가 덮어쓴 Message-ID 로 온 회신을 ses_message_id 로 잇는다 (B9 실측 형태)', async () => {
    const result = await resolveThread(reply(), memoryPort([outbound()]));
    expect(result.authority).toEqual({
      kind: 'existing',
      threadId: 'thread-1',
      matchedBy: 'ses_message_id',
      via: 'in_reply_to',
      matchedMessageId: 'msg-out-1',
      confidence: 'verified',
    });
    expect(result.display).toMatchObject({ threadId: 'thread-1', confidence: 'verified' });
  });

  it('우리 Message-ID 원형으로 온 회신도 message_id_header 로 잇는다 (도메인 대소문자 무관)', async () => {
    const header = OUR_HEADER.replace('atmark.ai', 'ATMARK.AI');
    const result = await resolveThread(
      reply({ inReplyTo: header, references: [header] }),
      memoryPort([outbound()]),
    );
    expect(result.authority).toMatchObject({ kind: 'existing', matchedBy: 'message_id_header' });
  });

  it('In-Reply-To 가 외부인끼리의 메시지여도 References 체인에서 우리 메시지를 찾는다', async () => {
    const result = await resolveThread(
      reply({
        inReplyTo: '<carol-internal@partner.com>',
        references: [`${SES_HEADER} <carol-internal@partner.com>`],
      }),
      memoryPort([outbound()]),
    );
    expect(result.authority).toMatchObject({ kind: 'existing', threadId: 'thread-1', via: 'references' });
  });

  it('수신자 주소 대소문자가 달라도 같은 사람이다', async () => {
    const result = await resolveThread(reply({ from: 'Bob@Partner.com' }), memoryPort([outbound()]));
    expect(result.authority.kind).toBe('existing');
  });
});

describe('resolveThread — 스레드 탈취를 막는다 (권한용 판정)', () => {
  it('id 를 아는 제3자는 들어오지 못한다 — 발신자가 그 메시지의 수신자가 아니다', async () => {
    const result = await resolveThread(reply({ from: 'eve@evil.com' }), memoryPort([outbound()]));
    expect(result.authority).toEqual({ kind: 'new', reason: 'sender_not_participant' });
    // 보여 주기는 한다 — 하지만 권한 없는 표시다.
    expect(result.display).toEqual({
      threadId: 'thread-1',
      matchedBy: 'ses_message_id',
      confidence: 'header_unverified',
    });
  });

  it('From 을 수신자로 사칭해도 인증이 없으면 들어오지 못한다', async () => {
    const result = await resolveThread(reply({ fromAuthenticated: false }), memoryPort([outbound()]));
    expect(result.authority).toEqual({ kind: 'new', reason: 'sender_unauthenticated' });
    expect(result.display?.confidence).toBe('header_unverified');
  });

  it('표시명이 붙은 From 은 주소로 보지 않는다 — 어댑터가 주소만 넘겨야 한다', async () => {
    const result = await resolveThread(
      reply({ from: '"bob@partner.com" <eve@evil.com>' }),
      memoryPort([outbound()]),
    );
    expect(result.authority).toEqual({ kind: 'new', reason: 'sender_unparseable' });
  });

  it('나간 적 없는 outbound 의 id 는 근거가 되지 못한다 (denied·pending)', async () => {
    const result = await resolveThread(
      reply({ inReplyTo: OUR_HEADER, references: [] }),
      memoryPort([outbound({ sent: false, sesMessageId: null })]),
    );
    expect(result.authority.kind).toBe('new');
  });

  it('여러 스레드의 id 를 섞어 넣어도 발신자가 참여한 스레드로만 간다', async () => {
    // eve 는 thread-2 의 정당한 수신자다. thread-1(bob 의 스레드) id 를 In-Reply-To 에 넣어도
    // thread-1 으로 가지 않는다.
    const eveOutbound = outbound({
      messageId: 'msg-out-2',
      threadId: 'thread-2',
      recipients: ['eve@evil.com'],
      messageIdHeader: '<other@atmark.ai>',
      sesMessageId: 'ses-for-eve',
    });
    const result = await resolveThread(
      reply({
        from: 'eve@evil.com',
        inReplyTo: SES_HEADER,
        references: ['<ses-for-eve@ap-northeast-2.amazonses.com>', SES_HEADER],
      }),
      memoryPort([outbound(), eveOutbound]),
    );
    expect(result.authority).toMatchObject({ kind: 'existing', threadId: 'thread-2' });
  });

  it('다른 에이전트의 메시지로는 잇지 않는다 — 포트가 범위를 빠뜨려도', async () => {
    const leaky: ThreadLookupPort = {
      // 에이전트 필터를 잊은 구현. 결과를 그대로 믿으면 에이전트 간 스레드가 섞인다.
      findByHeaderKeys: (_agentId, keys) =>
        Promise.resolve(keys.map((key) => toKnown(outbound({ agentId: OTHER_AGENT }), key))),
      findThreadIdsBySubject: () => Promise.resolve([]),
    };
    const result = await resolveThread(reply(), leaky);
    expect(result.authority).toEqual({ kind: 'new', reason: 'no_known_message' });
    expect(result.display).toBeNull();
  });

  it('요청하지 않은 키로 돌아온 행은 버린다 — 전 행을 돌려주는 포트', async () => {
    const leaky: ThreadLookupPort = {
      findByHeaderKeys: () =>
        Promise.resolve([toKnown(outbound(), { kind: 'ses_message_id', value: 'not-requested' })]),
      findThreadIdsBySubject: () => Promise.resolve([]),
    };
    const result = await resolveThread(reply(), leaky);
    expect(result.authority.kind).toBe('new');
  });
});

describe('resolveThread — 들어온 메일에 이어 쓰기', () => {
  const bobInbound = inbound();

  it('같은 발신자가 자기 이전 메일에 이어 쓰면 그 스레드다', async () => {
    const result = await resolveThread(
      reply({ inReplyTo: '<CAbob1@mail.gmail.com>', references: ['<CAbob1@mail.gmail.com>'] }),
      memoryPort([bobInbound]),
    );
    expect(result.authority).toMatchObject({
      kind: 'existing',
      threadId: 'thread-1',
      matchedBy: 'message_id_header',
      matchedMessageId: 'msg-in-1',
    });
  });

  it('그 메일의 Cc 였던 사람은 이어 쓸 수 없다 — 소유자가 승인한 상대가 아니다', async () => {
    const result = await resolveThread(
      reply({
        from: 'carol@partner.com',
        inReplyTo: '<CAbob1@mail.gmail.com>',
        references: ['<CAbob1@mail.gmail.com>'],
      }),
      memoryPort([bobInbound]),
    );
    expect(result.authority).toEqual({ kind: 'new', reason: 'sender_not_participant' });
  });

  it('같은 외부 id 를 가진 행이 여럿이면 발신자가 맞는 행을 고른다 (inbound id 는 유니크가 아니다)', async () => {
    // eve 가 bob 메일의 Message-ID 를 베껴 자기 메일에 달아 먼저 보냈다.
    const forged = inbound({ messageId: 'msg-in-forged', threadId: 'thread-eve', sender: 'eve@evil.com' });
    const result = await resolveThread(
      reply({ inReplyTo: '<CAbob1@mail.gmail.com>', references: [] }),
      memoryPort([forged, bobInbound]),
    );
    expect(result.authority).toMatchObject({ kind: 'existing', threadId: 'thread-1' });
  });

  it('★ 인증 안 된 수신(사칭)은 근거가 아니다 — 같은 주소의 인증 회신이어도 새 스레드, 표시만 묶는다 (V2-4)', async () => {
    // eve 가 bob 을 사칭(DMARC fail)해 스레드를 열었다. 진짜 bob 의 인증 메일이 그 Message-ID 로 답한다.
    const spoofed = inbound({ threadId: 'thread-spoofed', senderAuthenticated: false });
    const result = await resolveThread(
      reply({ inReplyTo: '<CAbob1@mail.gmail.com>', references: ['<CAbob1@mail.gmail.com>'] }),
      memoryPort([spoofed]),
    );
    expect(result.authority).toEqual({ kind: 'new', reason: 'sender_not_participant' });
    expect(result.display).toMatchObject({ threadId: 'thread-spoofed', confidence: 'header_unverified' });
  });

  it('같은 id 에 사칭 행과 인증 행이 함께 있으면 인증 행으로만 잇는다', async () => {
    const spoofed = inbound({ messageId: 'msg-in-spoofed', threadId: 'thread-spoofed', senderAuthenticated: false });
    const result = await resolveThread(
      reply({ inReplyTo: '<CAbob1@mail.gmail.com>', references: [] }),
      memoryPort([spoofed, bobInbound]),
    );
    expect(result.authority).toMatchObject({ kind: 'existing', threadId: 'thread-1', matchedMessageId: 'msg-in-1' });
  });
});

describe('resolveThread — 제목 폴백은 표시용이다', () => {
  const rows = [outbound()];

  it('헤더가 없는 회신은 제목으로 묶어 보여 주지만 권한은 새 스레드다', async () => {
    const port = memoryPort(rows);
    const result = await resolveThread(reply({ inReplyTo: null, references: [] }), port);
    expect(result.authority).toEqual({ kind: 'new', reason: 'no_header_ids' });
    expect(result.display).toEqual({
      threadId: 'thread-1',
      matchedBy: 'subject',
      confidence: 'subject_heuristic',
    });
  });

  it('제목이 같고 발신자가 참여자여도, 인증돼 있어도, 권한은 주지 않는다', async () => {
    // 가장 그럴듯한 경우조차 권한은 없다 — 제목은 누구나 쓸 수 있다.
    const result = await resolveThread(
      reply({ inReplyTo: null, references: [], from: 'bob@partner.com', fromAuthenticated: true }),
      memoryPort(rows),
    );
    expect(result.authority.kind).toBe('new');
  });

  it('제3자가 같은 제목으로 보내면 묶지도 않는다 — 그 사람이 참여한 스레드가 아니다', async () => {
    const result = await resolveThread(
      reply({ inReplyTo: null, references: [], from: 'eve@evil.com' }),
      memoryPort(rows),
    );
    expect(result.display).toBeNull();
  });

  it('회신 접두사가 없으면 제목으로 묶지 않는다', async () => {
    const port = memoryPort(rows);
    const result = await resolveThread(reply({ inReplyTo: null, references: [], subject: '견적 요청' }), port);
    expect(result.display).toBeNull();
    expect(port.subjectCalls).toBe(0);
  });

  it('후보가 둘 이상이면 묶지 않는다', async () => {
    const result = await resolveThread(
      reply({ inReplyTo: null, references: [] }),
      memoryPort([...rows, outbound({ messageId: 'msg-out-9', threadId: 'thread-9', sesMessageId: 'x' })]),
    );
    expect(result.display).toBeNull();
  });

  it('헤더 매칭이 있으면 제목을 보지 않는다', async () => {
    const port = memoryPort(rows);
    await resolveThread(reply({ from: 'eve@evil.com' }), port);
    expect(port.subjectCalls).toBe(0);
  });
});

describe('헤더 id 추출·정규화', () => {
  it('SES 도메인 id 의 로컬파트를 ses_message_id 로 본다', () => {
    expect(sesMessageIdOf(SES_HEADER)).toBe(SES_ID);
    expect(sesMessageIdOf(`<${SES_ID}@email.amazonses.com>`)).toBe(SES_ID);
    // 접미사 흉내는 SES 가 아니다.
    expect(sesMessageIdOf(`<${SES_ID}@amazonses.com.evil.com>`)).toBeNull();
    expect(sesMessageIdOf(`<${SES_ID}@notamazonses.com>`)).toBeNull();
    expect(sesMessageIdOf(OUR_HEADER)).toBeNull();
  });

  it('References 원문 한 줄에서 id 를 순서대로 전부 뽑는다', () => {
    expect(extractMessageIds(`${OUR_HEADER}\r\n ${SES_HEADER}  <x@Y.COM>`)).toEqual([
      OUR_HEADER,
      SES_HEADER,
      '<x@y.com>',
    ]);
  });

  it('꺾쇠 없는 id 하나도 받는다. 모양이 아니면 버린다', () => {
    expect(normalizeMessageId('abc@Host.Example')).toBe('<abc@host.example>');
    expect(normalizeMessageId('no-at-sign')).toBeNull();
    expect(normalizeMessageId('<a b@c>')).toBeNull();
  });

  it('In-Reply-To 가 먼저, References 는 끝(최근)부터, 자기 자신은 빠진다', () => {
    const ids = candidateIds(
      reply({
        messageId: '<self@x.com>',
        inReplyTo: '<parent@x.com>',
        references: ['<root@x.com> <mid@x.com> <parent@x.com> <self@x.com>'],
      }),
    ).map((candidate) => [candidate.id, candidate.source]);
    expect(ids).toEqual([
      ['<parent@x.com>', 'in_reply_to'],
      ['<mid@x.com>', 'references'],
      ['<root@x.com>', 'references'],
    ]);
  });

  it(`References 가 아무리 길어도 후보는 ${MAX_CANDIDATE_IDS}개 — 최근 것을 남긴다`, () => {
    const many = Array.from({ length: 500 }, (_, index) => `<r${index}@x.com>`);
    const ids = candidateIds(reply({ inReplyTo: null, references: many }));
    expect(ids).toHaveLength(MAX_CANDIDATE_IDS);
    expect(ids[0]?.id).toBe('<r499@x.com>');
  });

  it('조회 키는 후보 수의 두 배를 넘지 않는다', async () => {
    let requested = 0;
    const port: ThreadLookupPort = {
      findByHeaderKeys: (_agent, keys) => {
        requested = keys.length;
        return Promise.resolve([]);
      },
      findThreadIdsBySubject: () => Promise.resolve([]),
    };
    const many = Array.from({ length: 500 }, (_, index) => `<r${index}@us-east-1.amazonses.com>`);
    await resolveThread(reply({ inReplyTo: null, references: many }), port);
    expect(requested).toBe(MAX_CANDIDATE_IDS * 2);
  });
});

describe('normalizeSubject', () => {
  it.each([
    ['Re: 견적', '견적', true],
    ['RE: Fwd: 회신: 견적', '견적', true],
    ['Re[2]: 견적', '견적', true],
    ['답장：  견적   요청', '견적 요청', true],
    ['견적', '견적', false],
    ['Regarding 견적', 'regarding 견적', false],
  ])('%s → %s', (input, normalized, hadReplyPrefix) => {
    expect(normalizeSubject(input)).toEqual({ normalized, hadReplyPrefix });
  });
});
