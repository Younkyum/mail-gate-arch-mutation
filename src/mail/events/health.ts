/**
 * src/mail/events/health.ts — **소비자가 죽은 것을 "이벤트 없음" 과 구별한다.**
 *
 * ADR-0004 Consequences 가 닫지 못한 채로 남긴 두 창 중 하나:
 *
 * > **이벤트 소비자가 죽으면 조회가 항상 비어 있고, 우리는 그것을 "안 나갔다" 로 읽는다.**
 * > 소비자 정지는 조용한 실패이므로 알람이 필요하다.
 *
 * 조용한 이유는 **정지가 아무것도 만들지 않기 때문**이다. 크래시 로그도, 실패한 요청도,
 * 늘어나는 큐 깊이조차(SNS→SQS 가 아니라 SNS→Lambda 라면) 우리 평면에 안 보인다.
 * 보이는 것은 `ses_events` 가 늘지 않는다는 사실뿐이고, 그 사실은 **트래픽이 없을 때와
 * 정확히 같은 모양**이다.
 *
 * ---------------------------------------------------------------------------
 * ## 그래서 절대 시각이 아니라 **대조**로 판정한다
 * ---------------------------------------------------------------------------
 *
 * "마지막 이벤트가 10분 전이면 정지" 는 야간에 매일 울린다(트래픽이 없으니까).
 * "마지막 이벤트가 오래됐다" 가 의미를 갖는 것은 **그 사이에 메일이 나갔을 때**뿐이다.
 * 그래서 이 판정은 두 시각을 본다:
 *
 *   - `lastEventAt` — 소비자가 마지막으로 이벤트를 기록한 시각(`ses_events.received_at` 의 최대).
 *   - `lastSentAt`  — 우리가 마지막으로 발송을 확정한 시각(`messages.sent_at` 의 최대).
 *
 * `lastSentAt` 이 `lastEventAt` 보다 **유예 시간 이상** 새것이면, 나간 메일에 대한
 * 이벤트가 오지 않고 있다는 뜻이다 — 그것이 정지다. 트래픽이 없으면 `lastSentAt` 이
 * 늙으므로 판정은 저절로 `idle` 이 되고, 알람은 조용하다.
 *
 * **이 파일은 I/O 를 하지 않는다.** 두 시각을 받아 값을 돌려준다.
 */

/** 소비자 정지 판정의 유예. 이벤트 지연의 정상 범위를 넘는 눈금이어야 한다. */
export const CONSUMER_STALE_AFTER_SECONDS = 900;

export type ConsumerHealth =
  /** 이벤트가 발송을 따라오고 있다. */
  | { readonly kind: 'ok' }
  /** 판정할 근거가 없다 — 아직 아무것도 나가지 않았다. **정지가 아니다.** */
  | { readonly kind: 'idle' }
  /** 나간 메일이 있는데 그에 대한 이벤트가 유예를 넘겨 오지 않았다. */
  | { readonly kind: 'stalled'; readonly staleSeconds: number };

export interface ConsumerFreshness {
  /** `ses_events` 에 마지막으로 기록이 들어온 시각. 한 건도 없으면 `null`. */
  readonly lastEventAt: Date | null;
  /** `messages.sent_at` 의 최대. 한 통도 안 나갔으면 `null`. */
  readonly lastSentAt: Date | null;
}

export function evaluateConsumerHealth(
  freshness: ConsumerFreshness,
  now: Date,
  staleAfterSeconds: number = CONSUMER_STALE_AFTER_SECONDS,
): ConsumerHealth {
  const { lastSentAt, lastEventAt } = freshness;

  // 나간 메일이 없으면 이벤트가 없는 것이 옳다. 여기서 `stalled` 를 내면 신규 배포
  // 첫날부터 알람이 울리고, 매일 울리는 알람은 곧 아무도 안 보는 알람이 된다.
  if (lastSentAt === null) return { kind: 'idle' };

  const staleSeconds = Math.floor((now.getTime() - lastSentAt.getTime()) / 1000);

  // 방금 나간 메일이라면 이벤트가 아직 안 온 것이 정상이다 — `Send` 는 대개 초 단위지만
  // 보장이 없다(ADR-0004). 유예 안이면 판정하지 않는다.
  if (staleSeconds < staleAfterSeconds) return { kind: 'ok' };

  // 유예를 넘겼다. 그 발송보다 **뒤에** 들어온 이벤트가 하나라도 있으면 소비자는 살아 있다.
  // (그 발송 자신의 이벤트가 아니어도 좋다 — 여기서 묻는 것은 "소비자가 도는가" 이지
  //  "이 메일이 나갔는가" 가 아니다. 후자는 `SendEvidenceLookup` 의 질문이다.)
  if (lastEventAt !== null && lastEventAt.getTime() >= lastSentAt.getTime()) return { kind: 'ok' };

  return { kind: 'stalled', staleSeconds };
}
