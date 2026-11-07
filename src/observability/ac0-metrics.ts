/**
 * src/observability/ac0-metrics.ts — AC-0 지표의 **순수 계산** (계획 §3.2 V1 "자동 산출 활동 분모", AC-b3~b5).
 *
 * **DB 를 읽지 않는다.** `src/observability/**` 는 저장소 import 가 두 겹으로 금지돼 있다
 * (`.dependency-cruiser.cjs` `no-storage-in-observability` + `test/arch/observability-pii.arch.test.ts`).
 * 조회는 `src/gate/ac0-store.ts`, 조립은 `src/gate/ac0-report.ts` 에 있고 여기에는 행 → 숫자 함수만 있다.
 *
 * ## 일차 경계는 KST 00:00 (= 15:00 UTC)
 * - "하루" 는 대표의 업무일이다. UTC 자정(KST 09:00)으로 자르면 한 업무일이 두 일차에 걸쳐
 *   AC-b3 의 "1일차 vs 7일차" 와 AC-b4 의 "7일 연속 0건" 이 체감하는 하루와 어긋난다.
 * - KST 는 서머타임이 없어 고정 +09:00 — 시간대 라이브러리 없이, 실행 기계 TZ 와 무관하게 계산한다.
 * - DB CHECK(`ac0_gate_events_kst_midnight`)가 한 번 더 집행한다. 런북(`ac0-shadow-log.md` ·
 *   `address-transition.md`)도 같은 경계를 쓴다(`src/gate/ac0-verdict.ts` `ac0ProofStartForOff`).
 */

import { AC0_MIN_TURNS, countTurns, type TurnMessage } from '../mail/thread/turns';

export const DAY_MS = 86_400_000;
export const KST_OFFSET_MS = 9 * 3_600_000;

// ---------------------------------------------------------------------------
// KST 달력
// ---------------------------------------------------------------------------

/** `at` 이 속한 KST 날의 00:00. */
export function kstDayStart(at: Date): Date {
  const shifted = at.getTime() + KST_OFFSET_MS;
  return new Date(shifted - (((shifted % DAY_MS) + DAY_MS) % DAY_MS) - KST_OFFSET_MS);
}

/** `at` 이후(같거나 뒤) 첫 KST 00:00. `at` 이 자정이면 그 자신. */
export function kstMidnightAtOrAfter(at: Date): Date {
  const start = kstDayStart(at);
  return start.getTime() === at.getTime() ? start : new Date(start.getTime() + DAY_MS);
}

/** `at` 보다 **뒤**의 첫 KST 00:00. */
export function kstMidnightAfter(at: Date): Date {
  return new Date(kstDayStart(at).getTime() + DAY_MS);
}

/** `YYYY-MM-DD`(KST 날짜) → 그날 00:00 KST. 모양이 아니면 `null`. */
export function kstMidnightOf(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  const [, y, m, d] = match;
  const utc = Date.UTC(Number(y), Number(m) - 1, Number(d));
  const probe = new Date(utc);
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() !== Number(m) - 1 || probe.getUTCDate() !== Number(d)) {
    return null;
  }
  return new Date(utc - KST_OFFSET_MS);
}

/** `2026-10-01 23:40 KST`. */
export function formatKst(at: Date): string {
  const shifted = new Date(at.getTime() + KST_OFFSET_MS).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 16)} KST`;
}

/** `2026-10-01`(KST 날짜). */
export function formatKstDate(at: Date): string {
  return new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** `anchor` 부터 센 0-기반 일 번호. `anchor` 이전이면 음수. */
export function dayIndexFrom(anchor: Date, at: Date): number {
  return Math.floor((at.getTime() - anchor.getTime()) / DAY_MS);
}

/** 끝난(complete) 날의 수. `asOf` 가 `anchor` 이전이면 0. */
export function completeDaysSince(anchor: Date, asOf: Date): number {
  return Math.max(0, dayIndexFrom(anchor, asOf));
}

/**
 * `anchor` 부터 `days` 개의 날(0-기반)마다 `times` 를 센다. 범위 밖은 버린다.
 * 반환 길이는 항상 `days` — 빈 날은 0 이지 "없음" 이 아니다(0 이 판정 입력이다).
 */
export function countPerDay(anchor: Date, times: readonly Date[], days: number): number[] {
  const counts = new Array<number>(Math.max(0, days)).fill(0);
  for (const at of times) {
    const index = dayIndexFrom(anchor, at);
    if (index >= 0 && index < counts.length) counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// AC-b5 활동 분모
// ---------------------------------------------------------------------------

/** 계획 §3.2 V1 의 세 문턱. 셋 다 충족해야 green. */
export const AC0_ACTIVITY_THRESHOLDS = {
  newExternalContacts: 5,
  outboundSuccess: 30,
  multiTurnThreads: 3,
} as const;

export interface Ac0Window {
  readonly start: Date;
  /** 배타. */
  readonly end: Date;
}

/** 실제로 나간(`status='sent'`) 발송 1건과 그 수신자 전원(`outbound_recipients`). */
export interface SentMessageFact {
  readonly sentAt: Date;
  readonly recipients: readonly string[];
}

/** 범위 전체 이력에서 그 (원) 주소로 처음 성공 발송한 시각. 정규화 키로 접는 것은 `computeAc0Activity` 몫. */
export interface RecipientFirstSentFact {
  readonly address: string;
  readonly firstSentAt: Date;
}

/** 스레드 한 메시지. inbound 는 발신자(From)를 싣는다 — 내부(대표·에이전트) 발화를 턴에서 빼기 위해. */
export interface ThreadMessageFact extends TurnMessage {
  readonly threadId: string;
  readonly inboundFrom: string | null;
}

export interface ActivityFacts {
  readonly window: Ac0Window;
  readonly sentMessages: readonly SentMessageFact[];
  readonly recipientFirstSent: readonly RecipientFirstSentFact[];
  readonly threadMessages: readonly ThreadMessageFact[];
  /**
   * "외부 상대가 아니다" 판정 — 대표의 사람 메일함, 에이전트 도메인(`atmark.ai`) 등.
   * **활동 분모는 거래 상대와의 일을 증명한다.** 에이전트가 대표에게 보고 메일 30통을 보내도
   * 분모는 차지 않아야 한다(분모 없는 분자 — §3.2 V1).
   */
  readonly isInternal: (address: string) => boolean;
  /**
   * 상대 식별 키(`src/gate/forwarded.ts` 의 `contactKey` — `+태그`·Gmail 점 무시). "신규 외부 상대" 는 이 키
   * 단위로 센다 — 원 주소로 세면 `bob+1`~`bob+5` 가 신규 상대 5명이 된다(V3 H2②). 이 파일은 저장소·정책
   * 모듈을 import 하지 않으므로 함수로 받는다.
   */
  readonly contactKey: (address: string) => string;
}

export interface Ac0Activity {
  readonly window: Ac0Window;
  /** 그 창에서 **처음** 성공 발송한 외부 상대 수(정규화 키 단위). */
  readonly newExternalContacts: number;
  /** 외부 수신자가 1명 이상인 성공 발송 수. */
  readonly outboundSuccess: number;
  /** 창 안의 메시지만으로 센 턴이 `AC0_MIN_TURNS` 이상인 스레드 수. */
  readonly multiTurnThreads: number;
  readonly satisfied: boolean;
  /** 미달 항목(사람이 읽는 한 줄씩). 충족이면 빈 배열. */
  readonly shortfalls: readonly string[];
}

function inWindow(window: Ac0Window, at: Date): boolean {
  return at.getTime() >= window.start.getTime() && at.getTime() < window.end.getTime();
}

/**
 * 활동 분모 3종 (AC-b5). 입력은 조회 결과 그대로 — **창 필터는 여기서 한 번 더 건다**
 * (조회가 넓게 가져와도 결과가 달라지지 않게).
 *
 * - 신규 외부 상대: 정규화 키별 첫 발송(원 주소들의 최솟값)이 창 안이고 내부가 아닌 상대. "처음" 은 범위
 *   (에이전트/조직) 전체 이력 기준 — `bob@x` 에게 지난달 보냈으면 이번 주의 `bob+1@x` 는 신규가 아니다.
 * - outbound 성공: `sentAt ∈ 창` 이고 외부 수신자가 1명 이상. 수신자 기록이 없는 발송(P3a 이전 행)은
 *   외부임을 증명할 수 없으므로 세지 않는다.
 * - 3턴 스레드: 창 안의 메시지만으로 턴을 센다(`turns.ts` — 기간 필터는 호출자 몫). 창 이전에 3턴이던
 *   스레드에 메일 한 통이 더해진 것은 "이 주에 진행된 대화" 가 아니다. 내부 발신 inbound 는 뺀다.
 */
export function computeAc0Activity(facts: ActivityFacts): Ac0Activity {
  const { window, isInternal } = facts;

  const firstSentByContact = new Map<string, Date>();
  for (const fact of facts.recipientFirstSent) {
    if (isInternal(fact.address)) continue;
    const key = facts.contactKey(fact.address);
    const known = firstSentByContact.get(key);
    if (known === undefined || fact.firstSentAt.getTime() < known.getTime()) firstSentByContact.set(key, fact.firstSentAt);
  }
  const newExternalContacts = [...firstSentByContact.values()].filter((firstSentAt) => inWindow(window, firstSentAt)).length;

  const outboundSuccess = facts.sentMessages.filter(
    (message) => inWindow(window, message.sentAt) && message.recipients.some((address) => !isInternal(address)),
  ).length;

  const byThread = new Map<string, TurnMessage[]>();
  for (const message of facts.threadMessages) {
    if (!inWindow(window, message.occurredAt)) continue;
    if (message.direction === 'inbound' && (message.inboundFrom === null || isInternal(message.inboundFrom))) continue;
    const list = byThread.get(message.threadId) ?? [];
    list.push({ direction: message.direction, occurredAt: message.occurredAt, automated: message.automated });
    byThread.set(message.threadId, list);
  }
  let multiTurnThreads = 0;
  for (const messages of byThread.values()) if (countTurns(messages) >= AC0_MIN_TURNS) multiTurnThreads += 1;

  const shortfalls: string[] = [];
  const t = AC0_ACTIVITY_THRESHOLDS;
  if (newExternalContacts < t.newExternalContacts) {
    shortfalls.push(`신규 외부 상대 ${String(newExternalContacts)}/${String(t.newExternalContacts)}`);
  }
  if (outboundSuccess < t.outboundSuccess) {
    shortfalls.push(`outbound 성공 ${String(outboundSuccess)}/${String(t.outboundSuccess)}`);
  }
  if (multiTurnThreads < t.multiTurnThreads) {
    shortfalls.push(`${String(AC0_MIN_TURNS)}턴 이상 스레드 ${String(multiTurnThreads)}/${String(t.multiTurnThreads)}`);
  }

  return { window, newExternalContacts, outboundSuccess, multiTurnThreads, satisfied: shortfalls.length === 0, shortfalls };
}
