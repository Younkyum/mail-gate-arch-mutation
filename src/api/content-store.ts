/**
 * src/api/content-store.ts — 렌더된 본문의 출처 (`MessageContentSource` 구현).
 *
 * **왜 API 층이 이걸 갖는가:** `TransportRequest`(`policy/gate.ts`)에는 제목도 본문도
 * 없다. 관문은 *누가 누구에게 보내는가*만 판정하고, *무엇을 보내는가*는 전송단이
 * `MessageContentSource.load(messageId)` 로 따로 읽는다. 그 분리 덕에 관문의
 * `EvaluationContext` 가 본문을 알 필요가 없고, 본문 저장소가 S3 로 바뀌어도
 * (PRD 제약 · P1c/P3) 관문은 한 줄도 바뀌지 않는다.
 *
 * **왜 메모리인가 (P1b 한정):** `messages` 테이블에는 본문 컬럼이 없다 — 있으면 안 된다
 * (§5.2 V5 컬럼 화이트리스트). S3 는 P1c/P3 범위다. 그 사이 구간에서 본문을 둘 곳은
 * 프로세스 메모리뿐이고, **그 한계가 곧 "P1b 는 한 프로세스 안에서만 발송한다"** 는
 * 사실을 코드로 드러낸다. 워커가 별도 프로세스가 되는 순간 이 구현은 못 쓰게 되고,
 * 그때 S3 구현이 강제된다 — 조용히 넘어갈 수 없는 형태다.
 *
 * **P2 마무리 — 영속 구현 (`createObjectContentStore`).** 승인은 몇 시간 뒤에 오고, 그때 최초
 * 시도의 프로세스는 없다. 그래서 본문은 `storage/object-store.ts` 포트(운영 S3 · 개발 로컬 FS)
 * 위에 JSON 한 개로 산다 — 키 `outbound/content/{messageId}.json`. 메모리 구현은 같은 프로세스
 * 안의 단위·통합 테스트용으로 남는다(인터페이스는 그대로다 — 호출부는 한 줄도 안 바뀐다).
 *
 * ---
 *
 * **왜 `ses-transport.ts` 의 `MessageContentSource` 를 import 하지 않는가:**
 * Layer B(전송 chokepoint)는 *"전송단의 export 를 참조하는 프로덕션 파일은 `gate.ts`
 * 하나"* 를 단언하고, 그 단언은 타입 import 에도 걸린다. 타입을 빌려 오자고 그 층에
 * 예외를 내는 것은 본말전도다. TypeScript 는 구조적이므로 **같은 모양이면 대입된다** —
 * 아래 두 타입은 `ses-transport.ts` 의 `MessageContent`·`MessageContentSource` 와
 * 필드가 일치해야 하고, 어긋나면 조립 지점에서 컴파일이 깨진다(조용히 어긋날 수 없다).
 */

import { createHash } from 'node:crypto';

import {
  OUTBOUND_ATTACHMENTS_PREFIX,
  OUTBOUND_CONTENT_PREFIX,
  ObjectAlreadyExistsError,
  ObjectNotFoundError,
  type ObjectStore,
  type OutboundAttachmentObjects,
} from '../storage/object-store';

/**
 * 회신 헤더 — `mail/mime/build.ts` 의 `MessageThreading` 과 **같은 모양**이어야 한다(아래 머리말과 같은
 * 이유로 import 하지 않는다. 어긋나면 조립 지점에서 컴파일이 깨진다).
 */
export interface MessageContentThreading {
  readonly inReplyTo: string;
  readonly references: readonly string[];
}

/**
 * 첨부 영구본 참조(메일 기본기 2차 A2) — 본문 객체에 **바이트 없이** 실린다(키 · 선언 크기 · SHA-256 · 파일명 · MIME). 전송 직전에
 * `createObjectContentStore(objects, attachments)` 의 `load` 가 영구본을 읽어 체크섬을 대조한 뒤 `data` 를 붙인다.
 */
export interface MessageContentAttachment {
  readonly position: number;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly key: string;
}

/** 전송단이 받는 첨부 — 참조 + 바이트(체크섬 대조를 지난 것). */
export interface LoadedMessageContentAttachment extends MessageContentAttachment {
  readonly data: Uint8Array;
}

/** 렌더된 한 통. `html` 이 `null` 이면 text/plain 단일 파트다. */
export interface MessageContent {
  readonly subject: string;
  readonly text: string;
  readonly html: string | null;
  /**
   * 회신이면 `In-Reply-To`·`References` (P3b). **본문과 같은 객체에 산다** — 승인은 몇 시간 뒤에 오고, 그때
   * 릴리스가 내보내는 메일이 사람이 승인한 그 회신과 같은 스레드에 붙어야 한다. 새 대화면 `null`.
   */
  readonly threading: MessageContentThreading | null;
  /** 첨부(A2) — 자리 순. 없으면 키가 없다(A2 이전 객체·첨부 없는 메일 — 저장 바이트가 예전과 같다). */
  readonly attachments?: readonly MessageContentAttachment[];
}

/** 전송단이 받는 한 통 — 첨부가 있으면 바이트가 붙었다. */
export interface LoadedMessageContent extends MessageContent {
  readonly attachments?: readonly LoadedMessageContentAttachment[];
}

/** 읽기 면(관리 콘솔 — 첨부 **메타만**, 바이트를 읽지 않는다). */
export interface MessageContentReader {
  load(messageId: string): Promise<MessageContent>;
}

/** API 층이 보는 면 — 전송 **전에** 써 둔다. `load` 는 전송단의 면(첨부 바이트 포함)이다. */
export interface MessageContentStore extends MessageContentReader {
  put(messageId: string, content: MessageContent): Promise<void>;
  load(messageId: string): Promise<LoadedMessageContent>;
}

/** 첨부 영구본이 없거나 선언과 다르다 — 보내지 않는다(관문이 `failed` 로 기록한다, AC-A2-7). */
export class MessageAttachmentIntegrityError extends Error {
  constructor(messageId: string, position: number, why: string) {
    super(`첨부 영구본을 보낼 수 없다 (messageId=${messageId}, position=${String(position)}): ${why}`);
    this.name = 'MessageAttachmentIntegrityError';
  }
}

/** 본문이 없는 messageId 로 전송을 시도했다. 조용히 빈 메일을 보내지 않는다. */
export class MessageContentNotFoundError extends Error {
  constructor(messageId: string) {
    super(`본문이 없다 (messageId=${messageId}). 전송 전에 content.put 이 호출되지 않았다.`);
    this.name = 'MessageContentNotFoundError';
  }
}

export function createInMemoryContentStore(): MessageContentStore {
  const contents = new Map<string, MessageContent>();
  return {
    put(messageId: string, content: MessageContent): Promise<void> {
      contents.set(messageId, content);
      return Promise.resolve();
    },
    load(messageId: string): Promise<LoadedMessageContent> {
      const content = contents.get(messageId);
      // 빈 문자열을 돌려주면 "제목 없는 메일이 나갔다" 가 되고, 그 메일은 스팸 판정의
      // 입력이 된다(AC-2). 없으면 던진다 — 관문이 `failed` 로 받아 audit 에 남긴다.
      if (content === undefined) return Promise.reject(new MessageContentNotFoundError(messageId));
      // 메모리 구현은 첨부 바이트를 들고 있지 않다 — 빈 바이트로 메우지 않고 던진다(첨부 경로는 객체 저장소로 시험한다).
      if ((content.attachments ?? []).length > 0) {
        return Promise.reject(new MessageAttachmentIntegrityError(messageId, 0, '메모리 본문 저장소는 첨부 바이트가 없다'));
      }
      const { attachments: _none, ...rest } = content;
      return Promise.resolve(rest);
    },
  };
}

// ---------------------------------------------------------------------------
// 영속 구현 — `ObjectStore` 위의 JSON 한 개
// ---------------------------------------------------------------------------

/**
 * 본문 한 통의 상한 — **10 MiB.** 첨부는 P3 이고 여기 들어오지 않는다(본문만). `put` 에서도
 * 같은 상한을 건다 — 쓸 때 통과하고 읽을 때 거부되면 그 메시지는 영원히 보낼 수 없다.
 */
export const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

/** 저장 포맷 버전. 바뀌면 옛 객체를 읽을 수 없으므로 값이 박혀 있어야 한다. */
export const CONTENT_FORMAT_VERSION = 1;

/** 같은 messageId 로 두 번 썼다. **본문은 한 번 쓰면 바뀌지 않는다** — 승인자가 본 것이 나간다. */
export class MessageContentAlreadyStoredError extends Error {
  constructor(messageId: string) {
    super(`본문이 이미 있다 (messageId=${messageId}). 본문은 덮어쓰지 않는다.`);
    this.name = 'MessageContentAlreadyStoredError';
  }
}

/** 저장된 객체가 본문 포맷이 아니다. 빈 메일로 메우지 않고 던진다. */
export class MessageContentCorruptError extends Error {
  constructor(messageId: string, why: string) {
    super(`본문 객체가 손상됐다 (messageId=${messageId}): ${why}`);
    this.name = 'MessageContentCorruptError';
  }
}

export function contentKeyFor(messageId: string): string {
  return `${OUTBOUND_CONTENT_PREFIX}${messageId}.json`;
}

function decodeContent(messageId: string, bytes: Uint8Array): MessageContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new MessageContentCorruptError(messageId, error instanceof Error ? error.message : String(error));
  }
  if (typeof parsed !== 'object' || parsed === null) throw new MessageContentCorruptError(messageId, '객체가 아니다');
  const record = parsed as Record<string, unknown>;
  if (record['v'] !== CONTENT_FORMAT_VERSION) {
    throw new MessageContentCorruptError(messageId, `포맷 버전 ${String(record['v'])}`);
  }
  const { subject, text, html } = record;
  if (typeof subject !== 'string' || typeof text !== 'string' || (html !== null && typeof html !== 'string')) {
    throw new MessageContentCorruptError(messageId, '필드 타입');
  }
  return {
    subject,
    text,
    html,
    threading: decodeThreading(messageId, record['threading']),
    ...(record['attachments'] === undefined ? {} : { attachments: decodeAttachments(messageId, record['attachments']) }),
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** `attachments` 키가 없으면 빈 배열(A2 이전 객체). 있으면 모양을 본다 — 키는 영구 접두사 아래만. */
function decodeAttachments(messageId: string, value: unknown): readonly MessageContentAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new MessageContentCorruptError(messageId, 'attachments 타입');
  return value.map((item, index) => {
    const record = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const { position, filename, mimeType, bytes, sha256, key } = record;
    if (
      position !== index ||
      typeof filename !== 'string' ||
      typeof mimeType !== 'string' ||
      typeof bytes !== 'number' ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      typeof sha256 !== 'string' ||
      !HEX64.test(sha256) ||
      typeof key !== 'string' ||
      !key.startsWith(OUTBOUND_ATTACHMENTS_PREFIX)
    ) {
      throw new MessageContentCorruptError(messageId, `attachments[${String(index)}] 모양`);
    }
    return { position, filename, mimeType, bytes, sha256, key };
  });
}

/**
 * `threading` 키가 **없으면** `null` — P3b 이전에 쓰인 객체다(형식 버전을 올리지 않은 이유: 키 하나가 늘었을 뿐
 * 옛 객체의 뜻은 그대로다). 키가 **있는데 모양이 틀리면** 던진다 — 헤더 없이 보내면 조용히 다른 메일이 된다.
 */
function decodeThreading(messageId: string, value: unknown): MessageContentThreading | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw new MessageContentCorruptError(messageId, 'threading 타입');
  const { inReplyTo, references } = value as Record<string, unknown>;
  if (
    typeof inReplyTo !== 'string' ||
    !Array.isArray(references) ||
    references.some((item) => typeof item !== 'string')
  ) {
    throw new MessageContentCorruptError(messageId, 'threading 필드 타입');
  }
  return { inReplyTo, references: references as readonly string[] };
}

/**
 * 영속 본문 저장소. 운영은 `createS3ObjectStore`, 개발·데모·통합 테스트는 `createLocalObjectStore`
 * 를 넘긴다. **인스턴스에 상태가 없다** — 다른 프로세스가 같은 저장소로 만든 인스턴스는 같은
 * 본문을 읽는다. 그것이 승인 릴리스가 요구하는 전부다.
 */
export function createObjectContentStore(
  objects: ObjectStore,
  attachmentObjects?: Pick<OutboundAttachmentObjects, 'get'>,
): MessageContentStore {
  const reader = createObjectContentReader(objects);
  return {
    async put(messageId: string, content: MessageContent): Promise<void> {
      const body = new TextEncoder().encode(
        JSON.stringify({
          v: CONTENT_FORMAT_VERSION,
          subject: content.subject,
          text: content.text,
          html: content.html,
          threading: content.threading,
          // 첨부가 없으면 키를 싣지 않는다 — A2 이전 객체와 바이트가 같다(옛 코드가 읽어도 뜻이 같다).
          ...((content.attachments ?? []).length === 0 ? {} : { attachments: content.attachments }),
        }),
      );
      if (body.length > MAX_CONTENT_BYTES) {
        throw new RangeError(`본문이 상한을 넘는다 (messageId=${messageId}, ${body.length} > ${MAX_CONTENT_BYTES})`);
      }
      try {
        await objects.putIfAbsent(contentKeyFor(messageId), body, 'application/json');
      } catch (error) {
        if (error instanceof ObjectAlreadyExistsError) throw new MessageContentAlreadyStoredError(messageId);
        throw error;
      }
    },

    async load(messageId: string): Promise<LoadedMessageContent> {
      const content = await reader.load(messageId);
      const { attachments: stored, ...rest } = content;
      const refs = stored ?? [];
      if (refs.length === 0) return rest;
      if (attachmentObjects === undefined) {
        throw new MessageAttachmentIntegrityError(messageId, 0, '첨부 객체 저장소가 조립되지 않았다');
      }
      // **영구본을 읽어 선언과 대조한다**(AC-A2-7 — 릴리스 직전 재확인). 없거나 다르면 보내지 않는다.
      const attachments = await Promise.all(
        refs.map(async (attachment) => {
          let data: Uint8Array;
          try {
            data = await attachmentObjects.get(attachment.key, attachment.bytes);
          } catch (error) {
            throw new MessageAttachmentIntegrityError(messageId, attachment.position, error instanceof Error ? error.name : 'read_failed');
          }
          if (data.length !== attachment.bytes || createHash('sha256').update(data).digest('hex') !== attachment.sha256) {
            throw new MessageAttachmentIntegrityError(messageId, attachment.position, '크기·체크섬 불일치');
          }
          return { ...attachment, data };
        }),
      );
      return { ...rest, attachments };
    },
  };
}

/**
 * **읽기만** 하는 본문 리더 — 관리 콘솔의 발신 로그 상세(US-004)가 받는다. `get` 하나짜리 저장소(`createS3ObjectReader`
 * — 접두사 `outbound/content/` 고정 · IAM 도 GetObject 하나)를 넘긴다. 쓰기 면이 타입에 없다.
 */
export function createObjectContentReader(objects: Pick<ObjectStore, 'get'>): MessageContentReader {
  return {
    async load(messageId: string): Promise<MessageContent> {
      let bytes: Uint8Array;
      try {
        bytes = await objects.get(contentKeyFor(messageId), MAX_CONTENT_BYTES);
      } catch (error) {
        // 호출자(전송단·관문)가 이미 아는 오류로 옮긴다 — 저장소가 바뀌어도 `failed` 경로는 같다.
        if (error instanceof ObjectNotFoundError) throw new MessageContentNotFoundError(messageId);
        throw error;
      }
      return decodeContent(messageId, bytes);
    },
  };
}
