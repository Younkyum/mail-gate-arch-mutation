/**
 * `src/mail/thread/turns.ts` — AC-0 활동 분모("3턴 이상 진행된 스레드 ≥ 3건")의 턴.
 *
 * 분모가 부풀면 AC-0 은 아무 일도 안 한 주를 통과로 센다. 그래서 여기서 단언하는 것은
 * **세지 말아야 할 것을 세지 않는다** 이다: 혼자 보낸 연속 메일, 자동 응답.
 *
 * 마지막 describe 는 AC-4 장면(시드 계정과 3턴)을 해석기와 턴 계산을 **이어서** 돌린다 —
 * 둘이 따로 초록이어도 이어 붙였을 때 3턴이 안 나오면 분모는 영원히 0이다.
 */

import { describe, expect, it } from 'vitest';

import {
  resolveThread,
  type HeaderLookupKey,
  type KnownMessage,
  type ThreadLookupPort,
} from '../../../src/mail/thread/resolve';
import { AC0_MIN_TURNS, countTurns, type TurnMessage } from '../../../src/mail/thread/turns';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');

function msg(direction: 'inbound' | 'outbound', minute: number, automated = false): TurnMessage {
  return { direction, occurredAt: new Date(T0 + minute * 60_000), automated };
}

describe('countTurns', () => {
  it('방향이 바뀔 때마다 1턴', () => {
    expect(countTurns([msg('outbound', 0), msg('inbound', 1), msg('outbound', 2)])).toBe(3);
  });

  it('같은 방향 연속은 한 턴이다 — 혼자 세 통 보낸 것은 대화가 아니다', () => {
    expect(countTurns([msg('outbound', 0), msg('outbound', 1), msg('outbound', 2)])).toBe(1);
    expect(countTurns([msg('outbound', 0), msg('outbound', 1), msg('inbound', 2), msg('outbound', 3)])).toBe(3);
  });

  it('자동 응답은 턴이 아니다 — 부재중 회신이 3턴을 만들지 못한다', () => {
    expect(countTurns([msg('outbound', 0), msg('inbound', 1, true), msg('outbound', 2)])).toBe(1);
  });

  it('입력 순서가 아니라 시각 순서로 센다', () => {
    expect(countTurns([msg('outbound', 2), msg('outbound', 0), msg('inbound', 1)])).toBe(3);
  });

  it('빈 스레드는 0턴', () => {
    expect(countTurns([])).toBe(0);
  });

  it(`기준은 ${AC0_MIN_TURNS}턴 이상`, () => {
    expect(countTurns([msg('outbound', 0), msg('inbound', 1)])).toBeLessThan(AC0_MIN_TURNS);
    expect(countTurns([msg('inbound', 0), msg('outbound', 1), msg('inbound', 2)])).toBeGreaterThanOrEqual(AC0_MIN_TURNS);
  });
});

describe('AC-4 장면 — 시드 계정과 3턴을 해석기로 잇고 턴을 센다', () => {
  interface Row extends KnownMessage {
    readonly header: string;
    readonly sesMessageId: string | null;
    readonly occurredAt: Date;
  }

  /** 해석 결과대로 저장하는 최소 저장소. 새 스레드면 새 id 를 붙인다. */
  function store() {
    const rows: Row[] = [];
    let nextThread = 1;
    const port: ThreadLookupPort = {
      findByHeaderKeys: (agentId: string, keys: readonly HeaderLookupKey[]) =>
        Promise.resolve(
          rows.flatMap((row) =>
            keys
              .filter(
                (key) =>
                  row.agentId === agentId &&
                  (key.kind === 'message_id_header' ? row.header : row.sesMessageId) === key.value,
              )
              .map((key) => ({ ...row, matchedKey: key })),
          ),
        ),
      findThreadIdsBySubject: () => Promise.resolve([]),
    };
    const newThread = (): string => `thread-${nextThread++}`;
    return { rows, port, newThread };
  }

  const AGENT = 'agent-1';
  const SEED = 'seed@partner.com';

  it('out → in → out → in 이 한 스레드 4턴이 되고, 제3자의 끼어들기는 턴을 늘리지 않는다', async () => {
    const { rows, port, newThread } = store();
    const base = { agentId: AGENT, recipients: [SEED], sender: 'agent@atmark.ai', sent: true, senderAuthenticated: true };
    const matchedKey = { kind: 'message_id_header', value: '' } as const;

    // 1턴: 에이전트가 먼저 보낸다. 수신자에게는 SES id 가 붙은 Message-ID 로 도착한다.
    const t1 = newThread();
    rows.push({ ...base, matchedKey, messageId: 'o1', threadId: t1, direction: 'outbound', header: '<o1@atmark.ai>', sesMessageId: 'ses-o1', occurredAt: new Date(T0) });

    // 2턴: 시드가 회신한다.
    const r1 = await resolveThread(
      { agentId: AGENT, messageId: '<i1@partner.com>', inReplyTo: '<ses-o1@ap-northeast-2.amazonses.com>', references: ['<ses-o1@ap-northeast-2.amazonses.com>'], from: SEED, fromAuthenticated: true, subject: 'Re: 계약서' },
      port,
    );
    expect(r1.authority).toMatchObject({ kind: 'existing', threadId: t1 });
    rows.push({ ...base, matchedKey, messageId: 'i1', threadId: t1, direction: 'inbound', recipients: [], sender: SEED, header: '<i1@partner.com>', sesMessageId: null, occurredAt: new Date(T0 + 60_000) });

    // 3턴: 에이전트가 첨부와 함께 회신.
    rows.push({ ...base, matchedKey, messageId: 'o2', threadId: t1, direction: 'outbound', header: '<o2@atmark.ai>', sesMessageId: 'ses-o2', occurredAt: new Date(T0 + 120_000) });

    // 제3자가 체인을 베껴 끼어든다 — 권한용 스레드는 새 것이어야 한다.
    const intruder = await resolveThread(
      { agentId: AGENT, messageId: '<x@evil.com>', inReplyTo: '<ses-o2@ap-northeast-2.amazonses.com>', references: ['<ses-o1@ap-northeast-2.amazonses.com> <i1@partner.com> <ses-o2@ap-northeast-2.amazonses.com>'], from: 'eve@evil.com', fromAuthenticated: true, subject: 'Re: 계약서' },
      port,
    );
    expect(intruder.authority.kind).toBe('new');
    const intruderThread = newThread();
    rows.push({ ...base, matchedKey, messageId: 'x1', threadId: intruderThread, direction: 'inbound', recipients: [], sender: 'eve@evil.com', header: '<x@evil.com>', sesMessageId: null, occurredAt: new Date(T0 + 150_000) });

    // 4턴: 시드가 다시 회신.
    const r2 = await resolveThread(
      { agentId: AGENT, messageId: '<i2@partner.com>', inReplyTo: '<ses-o2@ap-northeast-2.amazonses.com>', references: ['<ses-o1@ap-northeast-2.amazonses.com> <i1@partner.com> <ses-o2@ap-northeast-2.amazonses.com>'], from: SEED, fromAuthenticated: true, subject: 'Re: 계약서' },
      port,
    );
    expect(r2.authority).toMatchObject({ kind: 'existing', threadId: t1, matchedMessageId: 'o2' });
    rows.push({ ...base, matchedKey, messageId: 'i2', threadId: t1, direction: 'inbound', recipients: [], sender: SEED, header: '<i2@partner.com>', sesMessageId: null, occurredAt: new Date(T0 + 180_000) });

    const turnsOf = (threadId: string): number =>
      countTurns(
        rows
          .filter((row) => row.threadId === threadId)
          .map((row) => ({ direction: row.direction, occurredAt: row.occurredAt, automated: false })),
      );
    expect(turnsOf(t1)).toBe(4);
    expect(turnsOf(intruderThread)).toBe(1);
  });
});
