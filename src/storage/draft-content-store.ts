/**
 * src/storage/draft-content-store.ts — **초안 본문** 어댑터(묶음 B). 키 `outbound/drafts/{draftId}/{revision}.json`.
 *
 * Postgres 에는 본문이 들어가지 않는다(`outbound/content/` · `outbound/scheduled/` 와 같은 규율). 초안 행(`drafts`)은 받는 사람 · 제목만 갖고, 본문(text ·
 * html)은 판마다 여기 한 객체다. **write-once** — 고치면 판이 오르고 새 키에 쓴다(옛 판은 덮이지 않는다). 같은 키의 두 번째 쓰기는 내용이 같을 때만
 * 성공으로 본다(행 갱신이 경합에 진 재시도) — 다르면 던진다.
 */

import {
  OUTBOUND_DRAFTS_PREFIX,
  ObjectAlreadyExistsError,
  ObjectKeyFormatError,
  assertValidObjectKey,
  type ObjectStore,
} from './object-store';

export interface DraftContent {
  readonly text: string;
  readonly html: string | null;
}

/** 초안 본문 상한 — 발송 본문 상한(`api/content-store.ts` `MAX_CONTENT_BYTES`)과 같다. 더 큰 초안은 보낼 수 없다. */
export const MAX_DRAFT_CONTENT_BYTES = 10 * 1024 * 1024;

const FORMAT_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class DraftContentCorruptError extends Error {
  constructor(key: string, why: string) {
    super(`초안 본문 객체가 손상됐다 (key=${key}): ${why}`);
    this.name = 'DraftContentCorruptError';
  }
}

export interface DraftContentStore {
  keyFor(draftId: string, revision: number): string;
  /** 인코딩한 바이트 수(행의 `content_bytes`) — 쓰기 전에 상한을 보려고 따로 준다. */
  sizeOf(content: DraftContent): number;
  put(draftId: string, revision: number, content: DraftContent): Promise<void>;
  load(draftId: string, revision: number): Promise<DraftContent>;
}

function encode(content: DraftContent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: FORMAT_VERSION, text: content.text, html: content.html }));
}

function decode(key: string, bytes: Uint8Array): DraftContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new DraftContentCorruptError(key, error instanceof Error ? error.message : String(error));
  }
  if (typeof parsed !== 'object' || parsed === null) throw new DraftContentCorruptError(key, '객체가 아니다');
  const record = parsed as Record<string, unknown>;
  if (record['v'] !== FORMAT_VERSION) throw new DraftContentCorruptError(key, `포맷 버전 ${String(record['v'])}`);
  const { text, html } = record;
  if (typeof text !== 'string' || (html !== null && typeof html !== 'string')) throw new DraftContentCorruptError(key, '필드 타입');
  return { text, html };
}

export function createDraftContentStore(objects: ObjectStore): DraftContentStore {
  function keyFor(draftId: string, revision: number): string {
    const key = `${OUTBOUND_DRAFTS_PREFIX}${draftId}/${String(revision)}.json`;
    if (!UUID.test(draftId)) throw new ObjectKeyFormatError(key, 'draftId 는 소문자 uuid');
    if (!Number.isSafeInteger(revision) || revision < 1) throw new ObjectKeyFormatError(key, 'revision 은 1 이상의 정수');
    assertValidObjectKey(key);
    return key;
  }

  return {
    keyFor,
    sizeOf: (content) => encode(content).length,

    async put(draftId, revision, content) {
      const key = keyFor(draftId, revision);
      const bytes = encode(content);
      if (bytes.length > MAX_DRAFT_CONTENT_BYTES) {
        throw new RangeError(`초안 본문이 상한을 넘는다 (${String(bytes.length)} > ${String(MAX_DRAFT_CONTENT_BYTES)})`);
      }
      try {
        await objects.putIfAbsent(key, bytes, 'application/json');
      } catch (error) {
        if (!(error instanceof ObjectAlreadyExistsError)) throw error;
        const existing = await objects.get(key, MAX_DRAFT_CONTENT_BYTES);
        if (Buffer.compare(existing, bytes) !== 0) throw error;
      }
    },

    async load(draftId, revision) {
      const key = keyFor(draftId, revision);
      return decode(key, await objects.get(key, MAX_DRAFT_CONTENT_BYTES));
    },
  };
}
