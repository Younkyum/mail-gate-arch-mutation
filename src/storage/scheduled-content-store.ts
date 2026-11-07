/**
 * src/storage/scheduled-content-store.ts — **예약 발송 본문** 어댑터 (P3c). 키 `outbound/scheduled/{scheduleId}.json`.
 *
 * 예약은 몇 시간·며칠 뒤에 나간다. 그때 워커는 다른 프로세스다 — 본문이 메모리에 있으면 사라진다. 그리고
 * Postgres 에는 본문이 들어가지 않는다(`outbound/content/` 와 같은 규율). 그래서 예약 생성 시 여기 쓰고,
 * 워커가 발송 시점에 읽어 `prepareOutbound` 에 넘긴다(그 순간 `outbound/content/{messageId}.json` 에 다시 쓰인다).
 *
 * **write-once.** 예약된 본문은 바뀌지 않는다 — 같은 키의 두 번째 쓰기는 포트가 거부한다. 같은 예약의 생성
 * 재호출(멱등 키)은 DB 행이 먼저 막으므로 여기까지 오지 않는다. 경합으로 온 경우(행 INSERT 는 졌는데 본문은
 * 먼저 썼다)는 **내용이 같을 때만** 성공으로 본다 — 다르면 던진다(요청 해시가 같으면 내용도 같다).
 */

import {
  OUTBOUND_SCHEDULED_PREFIX,
  ObjectAlreadyExistsError,
  ObjectKeyFormatError,
  assertValidObjectKey,
  type ObjectStore,
} from './object-store';

export interface ScheduledContent {
  readonly subject: string;
  readonly text: string;
  readonly html: string | null;
}

/** 발송 본문 상한(`api/content-store.ts` 의 `MAX_CONTENT_BYTES`)과 같은 값. 더 크게 예약할 수 있으면 발송에서 죽는다. */
export const MAX_SCHEDULED_CONTENT_BYTES = 10 * 1024 * 1024;

const FORMAT_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ScheduledContentCorruptError extends Error {
  constructor(key: string, why: string) {
    super(`예약 본문 객체가 손상됐다 (key=${key}): ${why}`);
    this.name = 'ScheduledContentCorruptError';
  }
}

export interface ScheduledContentStore {
  keyFor(scheduleId: string): string;
  put(scheduleId: string, content: ScheduledContent): Promise<void>;
  load(scheduleId: string): Promise<ScheduledContent>;
}

function encode(content: ScheduledContent): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ v: FORMAT_VERSION, subject: content.subject, text: content.text, html: content.html }),
  );
}

function decode(key: string, bytes: Uint8Array): ScheduledContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new ScheduledContentCorruptError(key, error instanceof Error ? error.message : String(error));
  }
  if (typeof parsed !== 'object' || parsed === null) throw new ScheduledContentCorruptError(key, '객체가 아니다');
  const record = parsed as Record<string, unknown>;
  if (record['v'] !== FORMAT_VERSION) throw new ScheduledContentCorruptError(key, `포맷 버전 ${String(record['v'])}`);
  const { subject, text, html } = record;
  if (typeof subject !== 'string' || typeof text !== 'string' || (html !== null && typeof html !== 'string')) {
    throw new ScheduledContentCorruptError(key, '필드 타입');
  }
  return { subject, text, html };
}

export function createScheduledContentStore(objects: ObjectStore): ScheduledContentStore {
  function keyFor(scheduleId: string): string {
    const key = `${OUTBOUND_SCHEDULED_PREFIX}${scheduleId}.json`;
    if (!UUID.test(scheduleId)) throw new ObjectKeyFormatError(key, 'scheduleId 는 소문자 uuid');
    assertValidObjectKey(key);
    return key;
  }

  return {
    keyFor,

    async put(scheduleId: string, content: ScheduledContent): Promise<void> {
      const key = keyFor(scheduleId);
      const bytes = encode(content);
      if (bytes.length > MAX_SCHEDULED_CONTENT_BYTES) {
        throw new RangeError(`예약 본문이 상한을 넘는다 (${String(bytes.length)} > ${String(MAX_SCHEDULED_CONTENT_BYTES)})`);
      }
      try {
        await objects.putIfAbsent(key, bytes, 'application/json');
      } catch (error) {
        if (!(error instanceof ObjectAlreadyExistsError)) throw error;
        const existing = await objects.get(key, MAX_SCHEDULED_CONTENT_BYTES);
        if (Buffer.compare(existing, bytes) !== 0) throw error;
      }
    },

    async load(scheduleId: string): Promise<ScheduledContent> {
      const key = keyFor(scheduleId);
      return decode(key, await objects.get(key, MAX_SCHEDULED_CONTENT_BYTES));
    },
  };
}
