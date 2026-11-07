/**
 * P3b — 회신 헤더(`In-Reply-To`·`References`). **값은 전부 상대가 정한 문자열에서 왔다.**
 *
 * `replyThreading` 은 받은 메일의 id 를 거르고 조립하고, `buildRawMessage` 는 조립된 값을 전송 직전에 한 번 더
 * 검사한다(`assertHeaderSafe` + `Message-ID` 모양). 두 층이 서로 다른 시점에 같은 명제를 세운다.
 */

import { describe, expect, it } from 'vitest';

import { buildRawMessage, MAX_REFERENCES, replyThreading, type RawMessageInput } from '../../../src/mail/mime/build';

const BASE: RawMessageInput = {
  fromAddress: 'agent@atmark.ai',
  recipients: ['bob@partner.example'],
  subject: 'Re: 견적',
  messageIdHeader: '<reply.1@atmark.ai>',
  date: new Date('2026-10-01T00:00:00.000Z'),
  text: 'body',
  html: null,
  threading: null,
  replyTo: null,
};

function headerBlock(raw: string): string {
  return raw.slice(0, raw.indexOf('\r\n\r\n'));
}

describe('replyThreading — 받은 메일 → 회신 헤더', () => {
  it('부모 id 가 In-Reply-To, 조상 + 부모가 References(부모가 마지막)', () => {
    expect(replyThreading('<p@x.example>', ['<g@atmark.ai>'])).toEqual({
      inReplyTo: '<p@x.example>',
      references: ['<g@atmark.ai>', '<p@x.example>'],
    });
  });

  it('부모 id 가 없거나 모양이 아니면 null — 잇는 헤더 없이 보낸다', () => {
    expect(replyThreading(null, [])).toBeNull();
    expect(replyThreading('not-an-id', [])).toBeNull();
    expect(replyThreading('<a\x07b@x.example>', [])).toBeNull();
  });

  it('조상 중 모양이 아닌 것·제어문자·중복·부모 자신은 버린다', () => {
    expect(
      replyThreading('<p@x.example>', ['junk', '<g@atmark.ai>', '<g@atmark.ai>', '<p@x.example>', '<e\x00@x.example>']),
    ).toEqual({ inReplyTo: '<p@x.example>', references: ['<g@atmark.ai>', '<p@x.example>'] });
  });

  it(`References 는 최근 ${String(MAX_REFERENCES)}개 — 상대가 헤더 길이를 정하지 못한다`, () => {
    const ancestors = Array.from({ length: 100 }, (_, i) => `<a${String(i)}@x.example>`);
    const threading = replyThreading('<p@x.example>', ancestors);
    expect(threading?.references).toHaveLength(MAX_REFERENCES);
    expect(threading?.references.at(-1)).toBe('<p@x.example>');
    expect(threading?.references[0]).toBe('<a81@x.example>');
  });
});

describe('buildRawMessage — 회신 헤더', () => {
  it('threading 이 null 이면 두 헤더가 없다', () => {
    const head = headerBlock(buildRawMessage(BASE));
    expect(head).not.toMatch(/^In-Reply-To:/m);
    expect(head).not.toMatch(/^References:/m);
  });

  it('In-Reply-To 한 줄 + References 는 id 마다 접는다(CRLF + 공백)', () => {
    const head = headerBlock(
      buildRawMessage({ ...BASE, threading: { inReplyTo: '<p@x.example>', references: ['<g@atmark.ai>', '<p@x.example>'] } }),
    );
    expect(head).toContain('\r\nIn-Reply-To: <p@x.example>\r\n');
    expect(head).toContain('\r\nReferences: <g@atmark.ai>\r\n <p@x.example>\r\n');
  });

  it('★ In-Reply-To 에 CRLF 가 있으면 던진다 — 헤더 인젝션', () => {
    expect(() =>
      buildRawMessage({ ...BASE, threading: { inReplyTo: '<p@x.example>\r\nBcc: z@y.example', references: [] } }),
    ).toThrow(/In-Reply-To/);
  });

  it('★ References 원소 하나라도 제어문자면 던진다 — 어느 원소인지 말한다', () => {
    expect(() =>
      buildRawMessage({
        ...BASE,
        threading: { inReplyTo: '<p@x.example>', references: ['<g@atmark.ai>', '<p@x.example>\nBcc: z@y.example'] },
      }),
    ).toThrow(/References\[1\]/);
  });

  it('`Message-ID` 모양이 아니면 던진다(`<…@…>`)', () => {
    expect(() => buildRawMessage({ ...BASE, threading: { inReplyTo: 'p@x.example', references: [] } })).toThrow();
  });

  it('References 상한을 넘기면 던진다 — 거르기는 replyThreading 에서 끝났어야 한다', () => {
    const references = Array.from({ length: MAX_REFERENCES + 1 }, (_, i) => `<a${String(i)}@x.example>`);
    expect(() => buildRawMessage({ ...BASE, threading: { inReplyTo: '<p@x.example>', references } })).toThrow(/References/);
  });

  it('References 가 비어 있으면 In-Reply-To 만 쓴다', () => {
    const head = headerBlock(buildRawMessage({ ...BASE, threading: { inReplyTo: '<p@x.example>', references: [] } }));
    expect(head).toContain('In-Reply-To: <p@x.example>');
    expect(head).not.toMatch(/^References:/m);
  });
});
