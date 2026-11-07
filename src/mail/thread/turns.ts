/**
 * src/mail/thread/turns.ts — 스레드의 턴 수 (계획 §3.2 AC-0 활동 분모: "3턴 이상 진행된 스레드 ≥ 3건").
 *
 * **턴의 정의: 발화 방향이 바뀔 때마다 1턴.** 시간순으로 놓고 같은 방향이 연달아 오면
 * 한 턴으로 접는다 — `out, out, in, out` 은 3턴, `out, out, out` 은 1턴이다.
 *
 * 왜 메시지 수가 아닌가: 활동 분모가 증명하려는 것은 "에이전트가 **상대와** 일을 진행했다"
 * 이다. 에이전트가 혼자 세 통을 보내도 대화는 진행되지 않았다. 메시지 수로 세면 독촉 메일이
 * 분모를 채우고, AC-0 은 아무 일도 안 한 주를 통과로 센다(분모 없는 분자 — §3.2 V1).
 *
 * 그래서 **자동 응답은 턴이 아니다.** 부재중 회신이 `out → in(자동) → out` 을 3턴으로
 * 만들면 상대가 한 번도 읽지 않은 스레드가 분모에 든다. 무엇이 자동인지(`Auto-Submitted`
 * ≠ `no`, RFC 3834 등)는 파서 어댑터가 정해 `automated` 로 넘긴다.
 *
 * 입력 전제: **권한용 `thread_id` 의 메시지만** 넘긴다(`resolve.ts` 머리말 — 약한 연결은
 * 다른 스레드에 있다). outbound 는 실제로 나간 것(`status='sent'`)만 넘긴다. 기간 필터
 * (8–14일차)는 호출자 몫이다.
 */

import type { MessageDirection } from './resolve';

/** AC-0 활동 분모의 기준. */
export const AC0_MIN_TURNS = 3;

export interface TurnMessage {
  readonly direction: MessageDirection;
  readonly occurredAt: Date;
  /** 자동 응답(부재중·반송 등). outbound 는 항상 `false`. */
  readonly automated: boolean;
}

/** 방향 전환 횟수 + 1. 셀 메시지가 없으면 0. 같은 시각이면 입력 순서를 따른다. */
export function countTurns(messages: readonly TurnMessage[]): number {
  const ordered = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => !message.automated)
    .sort(
      (a, b) =>
        a.message.occurredAt.getTime() - b.message.occurredAt.getTime() || a.index - b.index,
    );

  let turns = 0;
  let previous: MessageDirection | null = null;
  for (const { message } of ordered) {
    if (message.direction !== previous) {
      turns += 1;
      previous = message.direction;
    }
  }
  return turns;
}
