/**
 * src/mail/events/tag.ts — **SES 이벤트를 우리 행으로 되돌리는 조인 키** (ADR-0004).
 *
 * SES 는 `Message-ID` 헤더를 덮어쓴다(2026-09-22 실발송으로 확정). 그래서 §4.5-4 의
 * 2차 방어선(수신측 중복 병합)은 작동하지 않고, **전송이 성공한 뒤 우리 손에 남는 것이
 * 하나도 없다.** 남은 건 *보내기 전에* 정한 것뿐이다 — 그것이 `messages.id` 이고,
 * 이 파일은 그 값을 SES 이메일 태그로 싣고 되찾는 규칙 전부다.
 *
 * ---------------------------------------------------------------------------
 * ## 왜 인코딩이 없는가 — 그리고 왜 그것을 검사로 증명하는가
 * ---------------------------------------------------------------------------
 *
 * SES v2 `MessageTag` 의 이름·값 제약은 SDK 타입 주석에 그대로 적혀 있다:
 * *"ASCII letters (a–z, A–Z), numbers (0–9), underscores (_), or dashes (-)"*,
 * *"no more than 256 characters"*. 즉 `^[A-Za-z0-9_-]{1,256}$` 다.
 *
 * 우리 `message_id` 는 `messages.id uuid` 이고, uuid 의 정규 표기는 **16진수와 하이픈
 * 36자**다 — 위 집합의 **진부분집합**이다. 그러므로 인코딩이 필요 없고, 변환은 항등이며,
 * **항등은 단사(injective)다.** 조인 키가 충돌하면 ADR-0004 전체가 무의미해지므로,
 * 그 성질을 주석이 아니라 `test/unit/mail/ses-tag.test.ts` 가 단언한다(임의 uuid 다수와
 * 경계값 전수에 대해 `decode(encode(x)) === x` 이고 서로 다른 입력은 서로 다른 태그).
 *
 * **그래서 이 파일이 하는 일은 변환이 아니라 거절이다.** `messageId` 의 정적 타입은
 * `string` 이므로 uuid 가 아닌 값이 흘러들 수 있고, 그때 조용히 인코딩해 넘기면
 * "되돌릴 수 있다고 믿는 키" 가 생긴다. 되돌아오지 않는 조인 키는 없는 것보다 나쁘다 —
 * 조회가 항상 비고, 우리는 그것을 "안 나갔다" 로 읽는다(ADR-0004 Consequences).
 * **전송 전에 던진다.** 그 시점이면 아직 메일은 나가지 않았다.
 */

/** SES 태그 이름·값에 허용된 문자 집합 그대로. SDK 주석(`MessageTag`)과 같은 명제다. */
export const SES_TAG_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * 우리 `message_id` 를 싣는 태그의 이름.
 *
 * 밑줄은 허용 문자다. 이름을 `atmark_` 로 접두하는 이유는 SES 가 발행하는 이벤트의
 * `mail.tags` 에 **SES 자신의 태그(`ses:configuration-set` 등)가 섞여 오기** 때문이다.
 * 접두 없는 `message_id` 는 언젠가 남의 것과 부딪히고, 그 충돌은 조인이 틀린 행을
 * 가리키는 형태로 나타난다 — 조용하고, 결과는 중복 발송이다.
 */
export const ATMARK_MESSAGE_ID_TAG = 'atmark_message_id';

/**
 * **소유자 승인 알림**(`src/notify/approval-notifier.ts`)이 싣는 태그의 이름 — 값은 `approval_notifications.id`.
 *
 * 알림은 `messages` 행이 아니다. 그래서 `ATMARK_MESSAGE_ID_TAG` 를 싣지 **않는다** — 실으면 소비자가
 * `ses_events.message_id` FK 에 걸려 기록에 실패하고 그 이벤트가 영원히 재전달된다. 대신 이 태그를 실어
 * 소비자가 "우리 알림의 이벤트" 를 "태그 배선이 끊긴 에이전트 메일" 과 **구별**하게 한다
 * (`src/mail/events/ses-event.ts`). 구별하지 못하면 알림 한 통마다 `ses_event.unjoinable` 경고가 뜨고,
 * 그 경고가 진짜 배선 사고를 덮는다.
 */
export const ATMARK_NOTIFICATION_ID_TAG = 'atmark_notification_id';

/** 태그로 쓸 수 없는 값. **전송 전에** 던진다 — 그 시점이면 메일은 아직 안 나갔다. */
export class SesTagValueError extends Error {
  constructor(value: string) {
    super(
      `SES 태그 값으로 쓸 수 없다: ${JSON.stringify(value)} ` +
        '(허용: ASCII 영숫자·밑줄·하이픈 1~256자). 이 값을 실어 보내면 이벤트가 우리 행으로 ' +
        '되돌아오지 못하고, 조회는 영원히 "이벤트 없음" 을 반환한다 (ADR-0004).',
    );
    this.name = 'SesTagValueError';
  }
}

export function isSesTagValue(value: string): boolean {
  return SES_TAG_PATTERN.test(value);
}

/**
 * `message_id` → 태그 값. **항등이다.**
 *
 * 항등을 함수로 감싸는 이유는 두 가지다: ① 제약 검사가 호출부마다 흩어지지 않는다,
 * ② 언젠가 `messages.id` 가 uuid 가 아니게 되는 날 **고칠 자리가 한 곳**이고 그날
 * 단사성 테스트가 함께 갱신을 요구한다.
 */
export function toMessageIdTagValue(messageId: string): string {
  if (!isSesTagValue(messageId)) throw new SesTagValueError(messageId);
  return messageId;
}

/**
 * 태그 값 → `message_id`. `toMessageIdTagValue` 의 역함수.
 *
 * 되돌릴 수 없는 값은 `null` 이다 — 이벤트 페이로드는 **외부 입력**이므로 던지는 대신
 * 호출자가 "조인 불가능한 이벤트" 로 다룰 수 있어야 한다(소비자는 그런 이벤트를
 * 버리지 않고 `message_id` 없이 기록한다).
 */
export function fromMessageIdTagValue(value: string): string | null {
  return isSesTagValue(value) ? value : null;
}
