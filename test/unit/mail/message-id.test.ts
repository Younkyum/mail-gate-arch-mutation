/**
 * `src/mail/message-id.ts` — §4.5-4 의 "전송 전에 생성한다" 가 성립하려면 생성된 값이
 * DB CHECK 를 통과하는 형태여야 한다. 그 두 명제가 갈라지는 순간, 실패는 **lease 를
 * 잡은 뒤에** 드러난다 — 시도 하나가 통째로 죽는 자리다.
 */

import { describe, expect, it } from 'vitest';

import {
  assertMessageIdHeader,
  domainOf,
  generateMessageIdHeader,
  isMessageIdHeader,
  MESSAGE_ID_HEADER_PATTERN,
} from '../../../src/mail/message-id';

/** `messages.message_id_header` 의 CHECK 제약 원문(Postgres 정규식). 같은 집합이어야 한다. */
const DB_CHECK = /^<[^<>\s]+@[^<>\s]+>$/;

describe('generateMessageIdHeader', () => {
  it('DB CHECK 와 같은 형태를 낸다', () => {
    const header = generateMessageIdHeader('atmark.ai');
    expect(header).toMatch(MESSAGE_ID_HEADER_PATTERN);
    expect(header).toMatch(DB_CHECK);
    expect(header.endsWith('@atmark.ai>')).toBe(true);
  });

  it('같은 밀리초에 만들어도 값이 다르다 — 유니크 인덱스는 lease 이후에 터진다', () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    const headers = new Set(
      Array.from({ length: 200 }, () => generateMessageIdHeader('atmark.ai', now)),
    );
    expect(headers.size).toBe(200);
  });

  it('도메인을 소문자로 정규화한다', () => {
    expect(generateMessageIdHeader('  ATMARK.ai ')).toMatch(/@atmark\.ai>$/);
  });

  it('난수원을 주입하면 값이 결정론적이다 — 재시도 동일성 검증의 전제', () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    const fixed = (bytes: number): Buffer => Buffer.alloc(bytes, 0xab);
    expect(generateMessageIdHeader('atmark.ai', now, fixed)).toBe(
      generateMessageIdHeader('atmark.ai', now, fixed),
    );
  });

  it.each(['', '   ', 'at mark.ai', 'a@b', '<atmark.ai>'])(
    '도메인이 %j 면 던진다',
    (domain) => {
      expect(() => generateMessageIdHeader(domain)).toThrow();
    },
  );
});

describe('isMessageIdHeader / assertMessageIdHeader', () => {
  it.each(['<a@b>', '<1x.deadbeef@atmark.ai>'])('%s 는 유효하다', (value) => {
    expect(isMessageIdHeader(value)).toBe(true);
    expect(assertMessageIdHeader(value)).toBe(value);
  });

  it.each(['a@b', '<a@b', 'a@b>', '<a b@c>', '<@b>', '<a@>', '<a@b><c@d>', ''])(
    '%j 는 무효다',
    (value) => {
      expect(isMessageIdHeader(value)).toBe(false);
      expect(() => assertMessageIdHeader(value)).toThrow(/Message-ID/);
    },
  );
});

describe('domainOf', () => {
  it('마지막 @ 뒤를 소문자로 돌려준다', () => {
    expect(domainOf('Agent@Atmark.AI')).toBe('atmark.ai');
  });

  it.each(['atmark.ai', '@atmark.ai', 'agent@', ''])('%j 는 던진다', (address) => {
    expect(() => domainOf(address)).toThrow();
  });
});
