/**
 * `src/mail/events/tag.ts` — **조인 키가 되돌아온다는 것의 증명** (ADR-0004).
 *
 * 이 테스트가 없으면 ADR-0004 전체가 가정 위에 선다. 결정은 *"우리 `message_id` 를 SES
 * 이메일 태그로 실어 보내면 이벤트가 우리 행으로 되돌아온다"* 인데, 그 문장은
 * **변환이 단사(injective)일 때만** 참이다. 두 메시지가 같은 태그 값이 되는 순간
 * lease 만료 재전송 직전의 조회는 **다른 메일의 증거**를 보고 "나갔다" 고 답한다 —
 * 그리고 진짜로 안 나간 메일은 영영 나가지 않는다.
 *
 * 그래서 여기서 단언하는 것은 세 가지다:
 *   ① uuid 는 SES 태그 문자 제약의 **진부분집합**이다 (그래서 인코딩이 필요 없다).
 *   ② 변환은 **가역**이다 — `decode(encode(x)) === x`.
 *   ③ 변환은 **단사**다 — 서로 다른 입력은 서로 다른 태그 값이 된다.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  ATMARK_MESSAGE_ID_TAG,
  fromMessageIdTagValue,
  isSesTagValue,
  SES_TAG_PATTERN,
  SesTagValueError,
  toMessageIdTagValue,
} from '../../../src/mail/events/tag';

/** 표본 크기. 통계가 아니라 **충돌 탐지**이므로 크면 클수록 정직하다. */
const SAMPLE = 2000;

describe('SES 태그 문자 제약', () => {
  it('제약은 AWS 가 정한 것 그대로다 — 영숫자·밑줄·하이픈, 1~256자', () => {
    // SDK `MessageTag` 의 주석과 같은 명제다. 이 한 줄이 바뀌면 아래 단언 전부가
    // 다른 이야기를 하게 되므로 값을 고정해 둔다.
    expect(SES_TAG_PATTERN.source).toBe('^[A-Za-z0-9_-]{1,256}$');
  });

  it.each([
    ['빈 문자열', ''],
    ['공백', 'a b'],
    ['콜론 — SES 자신의 태그가 쓰는 문자다', 'ses:configuration-set'],
    ['골뱅이 — Message-ID 를 그대로 실으려는 시도', '<abc@atmark.ai>'],
    ['점', '1a2b.3c4d'],
    ['비ASCII', '메시지'],
    ['257자', 'a'.repeat(257)],
  ])('%s 은 태그 값이 아니다', (_label, value) => {
    expect(isSesTagValue(value)).toBe(false);
    expect(() => toMessageIdTagValue(value)).toThrow(SesTagValueError);
  });

  it('256자는 통과하고 257자는 막힌다 — 경계가 닫혀 있다', () => {
    expect(isSesTagValue('a'.repeat(256))).toBe(true);
    expect(isSesTagValue('a'.repeat(257))).toBe(false);
  });

  it('태그 **이름** 도 제약을 만족하고(거부되면 발송 전체가 실패) `atmark_` 접두다(SES 자신의 태그와 부딪히지 않게)', () => {
    expect(isSesTagValue(ATMARK_MESSAGE_ID_TAG)).toBe(true);
    expect(ATMARK_MESSAGE_ID_TAG.startsWith('atmark_')).toBe(true);
  });
});

describe('①②③ uuid ⊂ 태그 문자 집합 · 가역 · 단사', () => {
  it(`무작위 uuid ${String(SAMPLE)}개가 전부 제약을 만족하고, 원값으로 돌아오고, 태그 값이 서로 다르다(충돌 0)`, () => {
    // **충돌이 하나라도 있으면 ADR-0004 는 무의미하다.** 한쪽의 `Send` 이벤트가 다른 쪽의 "나갔다" 증거가 된다.
    const ids = new Set(Array.from({ length: SAMPLE }, () => randomUUID()));
    expect([...ids].filter((id) => !isSesTagValue(id))).toEqual([]);
    expect([...ids].filter((id) => fromMessageIdTagValue(toMessageIdTagValue(id)) !== id)).toEqual([]);
    expect(new Set([...ids].map(toMessageIdTagValue)).size).toBe(ids.size);
  });

  it('되돌릴 수 없는 값은 `null` 이다 — 던지지 않는다(이벤트는 외부 입력이다)', () => {
    expect(fromMessageIdTagValue('ses:configuration-set')).toBeNull();
    expect(fromMessageIdTagValue('')).toBeNull();
  });

  it('항등이므로 단사는 구조적으로 성립한다 — 그 사실을 값으로 고정한다', () => {
    // 인코딩 규칙이 생기는 날 이 단언이 먼저 깨진다. 그때 위 ①②③ 을
    // 새 규칙에 맞게 다시 써야 하고, 그 다시 쓰는 일이 이 테스트의 목적이다.
    const id = randomUUID();
    expect(toMessageIdTagValue(id)).toBe(id);
  });
});
