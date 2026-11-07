/**
 * src/storage/inbound-artifact-store.ts — **수신 파생물** 어댑터 (P3a). 파싱 결과 JSON · 첨부 바이트.
 *
 * `raw-mail-store.ts` 가 SES 가 쓴 원문을 읽는 입구라면, 이 파일은 소비자(`workers/inbound-consumer`)가
 * 원문에서 만든 것을 쓰는 입구다. 둘 다 같은 포트(`ObjectStore`) 위에 서고, 키 규칙은 `object-store.ts`
 * 의 키 설계 표를 따른다:
 *   - `inbound/parsed/{sesMessageId}.json`
 *   - `inbound/attachments/{sesMessageId}/{partIndex}`
 *
 * **키에 발신자가 정한 문자열이 들어가지 않는다.** SES 메시지 ID 는 SES 가 정하고(형식 검증 후),
 * partIndex 는 파서가 센 정수다. 첨부 파일명(`../../outbound/content/x.json` 같은 값이 올 수 있다)은
 * DB 의 표시 전용 컬럼에만 간다.
 *
 * ---
 *
 * **이미 있으면 성공으로 본다 (`created: false`).** 포트는 write-once 이고 덮어쓰지 않는다. 그런데 소비자는
 * at-least-once 로 재전달을 받는다 — 첫 시도가 첨부 둘을 쓰고 DB 에서 죽으면, 재시도는 같은 키를 다시
 * 쓴다. 그것을 실패로 보면 **일시 장애 한 번이 영구 poison pill 이 된다.** 내용은 같은 원문의 결정적
 * 파생물이므로 먼저 쓴 쪽을 그대로 둔다(덮어쓰지 않는 것은 포트가 보증한다).
 *
 * **첨부의 Content-Type 은 발신자 선언을 쓰지 않는다 — 항상 `application/octet-stream`.** 선언값은
 * 공격자 입력이고, 나중에 다운로드 URL 이 이 객체를 `text/html` 로 서빙하면 우리 도메인의 저장형 XSS 다.
 * 선언된 타입은 DB(`inbound_attachments.content_type`)에 **메타로만** 남는다.
 */

import {
  INBOUND_ATTACHMENTS_PREFIX,
  INBOUND_PARSED_PREFIX,
  ObjectAlreadyExistsError,
  ObjectKeyFormatError,
  assertValidObjectKey,
  type ObjectStore,
} from './object-store';

/** SES 메시지 ID — 키의 한 세그먼트. `raw-mail-store.ts` 의 규칙보다 좁게(선두 영숫자, `/` 없음). */
const SES_MESSAGE_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._=-]{0,254}$/;

export interface PutResult {
  readonly key: string;
  /** `false` = 같은 키가 이미 있었다(재전달). 오류가 아니다. */
  readonly created: boolean;
}

export interface InboundArtifactStore {
  parsedKeyFor(sesMessageId: string): string;
  attachmentKeyFor(sesMessageId: string, partIndex: number): string;
  putParsed(sesMessageId: string, json: string): Promise<PutResult>;
  putAttachment(sesMessageId: string, partIndex: number, bytes: Uint8Array): Promise<PutResult>;
}

function assertSesMessageId(sesMessageId: string, key: string): void {
  if (!SES_MESSAGE_ID_SEGMENT.test(sesMessageId)) throw new ObjectKeyFormatError(key, 'SES 메시지 ID 형식');
}

async function putOnce(objects: ObjectStore, key: string, bytes: Uint8Array, contentType: string): Promise<PutResult> {
  try {
    await objects.putIfAbsent(key, bytes, contentType);
    return { key, created: true };
  } catch (error) {
    if (error instanceof ObjectAlreadyExistsError) return { key, created: false };
    throw error;
  }
}

export function createInboundArtifactStore(objects: ObjectStore): InboundArtifactStore {
  function parsedKeyFor(sesMessageId: string): string {
    const key = `${INBOUND_PARSED_PREFIX}${sesMessageId}.json`;
    assertSesMessageId(sesMessageId, key);
    assertValidObjectKey(key);
    return key;
  }

  function attachmentKeyFor(sesMessageId: string, partIndex: number): string {
    const key = `${INBOUND_ATTACHMENTS_PREFIX}${sesMessageId}/${String(partIndex)}`;
    assertSesMessageId(sesMessageId, key);
    if (!Number.isSafeInteger(partIndex) || partIndex < 0) throw new ObjectKeyFormatError(key, 'partIndex');
    assertValidObjectKey(key);
    return key;
  }

  return {
    parsedKeyFor,
    attachmentKeyFor,

    // `async` — 키 형식 위반(동기 throw)도 거부로 돌려준다. 실패의 모양이 하나여야 호출자가 하나로 다룬다.
    async putParsed(sesMessageId: string, json: string): Promise<PutResult> {
      return putOnce(objects, parsedKeyFor(sesMessageId), new TextEncoder().encode(json), 'application/json');
    },

    async putAttachment(sesMessageId: string, partIndex: number, bytes: Uint8Array): Promise<PutResult> {
      return putOnce(objects, attachmentKeyFor(sesMessageId, partIndex), bytes, 'application/octet-stream');
    },
  };
}

// ---------------------------------------------------------------------------
// 읽기 — 에이전트 조회 API 가 파싱 결과를 읽는 입구 (P3c)
// ---------------------------------------------------------------------------

/**
 * 파싱 결과 JSON 의 읽기 상한. 원문 상한이 40MiB(파서)이고 첨부 바이트는 이 문서에 없으므로(본문 텍스트뿐)
 * 이 값에 닿는 문서는 정상 경로에서 나오지 않는다. **상한 없는 읽기는 포트가 허용하지 않는다**(`get`).
 */
export const MAX_PARSED_DOCUMENT_BYTES = 48 * 1024 * 1024;

const PARSED_KEY_SHAPE = /^inbound\/parsed\/[A-Za-z0-9][A-Za-z0-9._=-]{0,254}\.json$/;

export interface InboundArtifactReader {
  /**
   * `inbound_messages.parsed_storage_key` 가 가리키는 문서의 **바이트**. 모양 해석은 호출자의 일이다
   * (`api/inbound-view.ts`) — 이 파일은 키가 수신 파생물 접두사 안인지만 본다: DB 에서 온 키라도 다른 접두사
   * (`outbound/content/…`)를 가리키면 거부한다 — 조회 API 가 남의 발송 본문을 읽는 통로가 되지 않게.
   */
  readParsed(parsedStorageKey: string): Promise<Uint8Array>;
}

const ATTACHMENT_KEY_SHAPE = /^inbound\/attachments\/[A-Za-z0-9][A-Za-z0-9._=-]{0,254}\/[0-9]+$/;

/**
 * 첨부 바이트 읽기 — 첨부 **내용** 조회(`GET …/attachments/{index}/content`, `api/attachment-content.ts`)의 입구.
 * `readParsed` 와 같은 규율: DB 에서 온 키라도 수신 첨부 접두사 밖이면 거부한다. 상한은 호출자가 정하고(포트가 강제한다),
 * 넘으면 다 읽기 **전에** `ObjectTooLargeError` 다.
 *
 * `InboundArtifactReader` 에 넣지 않은 이유: 그 포트는 조회·전달·MCP 가 두루 받는다 — 첨부 바이트를 읽는 능력은 첨부
 * 라우트 하나만 쥔다(`AttachmentRouteDependencies.contents`).
 */
export interface InboundAttachmentReader {
  readAttachment(storageKey: string, maxBytes: number): Promise<Uint8Array>;
}

export function createInboundAttachmentReader(objects: ObjectStore): InboundAttachmentReader {
  return {
    async readAttachment(storageKey: string, maxBytes: number): Promise<Uint8Array> {
      if (!ATTACHMENT_KEY_SHAPE.test(storageKey)) throw new ObjectKeyFormatError(storageKey, '수신 첨부 키가 아니다');
      assertValidObjectKey(storageKey);
      return objects.get(storageKey, maxBytes);
    },
  };
}

export function createInboundArtifactReader(objects: ObjectStore): InboundArtifactReader {
  return {
    async readParsed(parsedStorageKey: string): Promise<Uint8Array> {
      if (!PARSED_KEY_SHAPE.test(parsedStorageKey)) {
        throw new ObjectKeyFormatError(parsedStorageKey, '수신 파싱 결과 키가 아니다');
      }
      assertValidObjectKey(parsedStorageKey);
      return objects.get(parsedStorageKey, MAX_PARSED_DOCUMENT_BYTES);
    },
  };
}
