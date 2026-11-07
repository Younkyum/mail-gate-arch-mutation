/**
 * src/storage/raw-mail-store.ts — **수신 원문** 어댑터. 키 → 바이트, 크기 상한.
 *
 * PRD: raw email 은 Postgres 에 들어가지 않는다 — **S3 키만** 들어간다. 운영에서 원문을 쓰는
 * 것은 우리 코드가 아니라 SES receipt rule 의 S3 액션이다(키 = `inbound/raw/{sesMessageId}`).
 * 그래서 이 어댑터의 주 경로는 `get(key)` 이고, `put` 은 개발·데모·테스트가 SES 대신 원문을
 * 넣는 입구다(운영 S3 에서도 동작은 하지만 같은 키를 SES 가 이미 썼다면 write-once 로 거부된다).
 *
 * **`get` 은 `inbound/raw/` 밖의 키를 거부한다.** 이 어댑터로 발신 본문(`outbound/content/`)을
 * 읽을 수 있으면, 수신 파서에 들어가는 입력의 출처가 "외부인이 보낸 것" 에서 "우리 저장소의
 * 아무 객체" 로 넓어진다.
 */

import {
  INBOUND_RAW_PREFIX,
  ObjectKeyFormatError,
  assertValidObjectKey,
  type ObjectStore,
} from './object-store';

/**
 * 기본 상한 — **40 MiB.** SES 수신이 받아 주는 최대 메시지 크기(헤더 포함 40MB)에 맞춘다.
 * 그보다 큰 객체가 이 접두사에 있다면 SES 가 쓴 것이 아니다.
 */
export const DEFAULT_MAX_RAW_MAIL_BYTES = 40 * 1024 * 1024;

export interface RawMailStore {
  /** SES 메시지 ID → 키. SES receipt rule 이 쓰는 키와 같은 규칙이다. */
  keyFor(sesMessageId: string): string;
  /** 개발·데모 입구. 돌려주는 값이 DB 에 들어가는 **유일한** 원문 흔적이다. */
  put(sesMessageId: string, raw: Uint8Array): Promise<string>;
  /** SES 알림의 `objectKey` 를 그대로 받는다. 상한 초과면 읽기 전에 던진다. */
  get(key: string): Promise<Uint8Array>;
}

export interface RawMailStoreOptions {
  readonly maxBytes?: number;
}

export function createRawMailStore(objects: ObjectStore, options: RawMailStoreOptions = {}): RawMailStore {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RAW_MAIL_BYTES;

  function keyFor(sesMessageId: string): string {
    const key = `${INBOUND_RAW_PREFIX}${sesMessageId}`;
    // SES 메시지 ID 에 `/` 가 섞이면 접두사 아래 다른 계층을 가리킨다 — 세그먼트는 하나여야 한다.
    if (sesMessageId.includes('/')) throw new ObjectKeyFormatError(key, 'SES 메시지 ID 에 `/`');
    assertValidObjectKey(key);
    return key;
  }

  return {
    keyFor,

    async put(sesMessageId: string, raw: Uint8Array): Promise<string> {
      const key = keyFor(sesMessageId);
      if (raw.length > maxBytes) throw new RangeError(`원문이 상한을 넘는다 (${raw.length} > ${maxBytes})`);
      await objects.putIfAbsent(key, raw, 'message/rfc822');
      return key;
    },

    async get(key: string): Promise<Uint8Array> {
      if (!key.startsWith(INBOUND_RAW_PREFIX)) throw new ObjectKeyFormatError(key, `${INBOUND_RAW_PREFIX} 밖`);
      return objects.get(key, maxBytes);
    },
  };
}
