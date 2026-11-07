/**
 * src/mail/message-id.ts — RFC 5322 `Message-ID` 생성·검증 (§4.5-4).
 *
 * **전송 *전에* 생성해 `messages.message_id_header` 에 저장한다.** 재시도가 같은 값으로
 * 나가야 수신측 MUA·MTA 가 중복을 병합할 수 있고, 그것이 "전송 성공 직후 프로세스 사망"
 * 이라는 최악 케이스의 2차 방어선이다. 전송 후에 기록하면 **바로 그 케이스에서 값이 없다.**
 *
 * DB 는 같은 형태를 두 겹으로 강제한다 — 컬럼 CHECK(`^<[^<>[:space:]]+@[^<>[:space:]]+>$`)와
 * 유니크 인덱스(`messages_message_id_header_key`), 그리고 `messages_identity_immutable`
 * 트리거가 UPDATE 를 거부한다. 이 파일의 정규식은 **그 CHECK 와 같은 명제**여야 한다.
 */

import { randomBytes } from 'node:crypto';

/** `messages.message_id_header` 의 CHECK 제약과 같은 집합. */
export const MESSAGE_ID_HEADER_PATTERN = /^<[^<>\s]+@[^<>\s]+>$/;

export function isMessageIdHeader(value: string): boolean {
  return MESSAGE_ID_HEADER_PATTERN.test(value);
}

/** 형식 위반은 예외. DB 에 닿기 전에 끊는다 — 거기서 끊기면 lease 를 잡은 뒤다. */
export function assertMessageIdHeader(value: string): string {
  if (!isMessageIdHeader(value)) {
    throw new Error(
      `Message-ID 형식이 아니다: ${JSON.stringify(value)} (기대: <local@domain>, 공백·꺾쇠 불가)`,
    );
  }
  return value;
}

/**
 * `<{시각}.{난수}@{domain}>` 를 만든다.
 *
 * 시각을 앞에 두는 이유는 정렬 가능성이 아니라 **조사 가능성**이다 — 수신자가 보낸
 * 원문 헤더 한 줄만 들고 와도 언제 나간 메일인지 바로 좁혀진다. 난수 12바이트는
 * 같은 밀리초에 여러 건이 나가는 경우의 충돌을 실질적으로 없앤다(유니크 인덱스가
 * 그 충돌을 잡지만, 잡히는 시점이 lease 이후라 시도 하나가 통째로 실패한다).
 */
export function generateMessageIdHeader(
  domain: string,
  now: Date = new Date(),
  random: (bytes: number) => Buffer = randomBytes,
): string {
  const normalizedDomain = domain.trim().toLowerCase();
  if (normalizedDomain === '' || /[<>\s@]/.test(normalizedDomain)) {
    throw new Error(`Message-ID 도메인이 올바르지 않다: ${JSON.stringify(domain)}`);
  }
  return assertMessageIdHeader(
    `<${now.getTime().toString(36)}.${random(12).toString('hex')}@${normalizedDomain}>`,
  );
}

/** 주소의 도메인부. `agent@atmark.ai` → `atmark.ai`. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) {
    throw new Error(`주소에서 도메인을 뽑을 수 없다: ${JSON.stringify(address)}`);
  }
  return address.slice(at + 1).toLowerCase();
}
