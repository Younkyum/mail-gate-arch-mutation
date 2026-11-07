/**
 * `src/storage/inbound-artifact-store.ts` — 수신 파생물 키는 **SES 메시지 ID 와 파트 번호로만** 만든다.
 * 재전달(이미 있음)은 성공이고, 첨부의 저장 Content-Type 은 발신자 선언과 무관하게 octet-stream 이다.
 */

import { describe, expect, it } from 'vitest';

import { createInboundArtifactStore, createInboundAttachmentReader } from '../../../src/storage/inbound-artifact-store';
import {
  INBOUND_ATTACHMENTS_PREFIX,
  INBOUND_PARSED_PREFIX,
  ObjectAlreadyExistsError,
  ObjectKeyFormatError,
  type ObjectStore,
} from '../../../src/storage/object-store';

interface Put {
  readonly key: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

function memoryStore(): { store: ObjectStore; puts: Put[] } {
  const objects = new Map<string, Uint8Array>();
  const puts: Put[] = [];
  return {
    puts,
    store: {
      kind: 'local-dev',
      putIfAbsent(key, bytes, contentType) {
        if (objects.has(key)) return Promise.reject(new ObjectAlreadyExistsError(key));
        objects.set(key, bytes);
        puts.push({ key, contentType, bytes });
        return Promise.resolve();
      },
      get(key) {
        const bytes = objects.get(key);
        return bytes === undefined ? Promise.reject(new Error('missing')) : Promise.resolve(bytes);
      },
    },
  };
}

const SES = '0100019a1b2c3d4e-000000';

describe('수신 파생물 키', () => {
  it('파싱 결과 = inbound/parsed/{ses}.json, 첨부 = inbound/attachments/{ses}/{index}', () => {
    const artifacts = createInboundArtifactStore(memoryStore().store);
    expect(artifacts.parsedKeyFor(SES)).toBe(`${INBOUND_PARSED_PREFIX}${SES}.json`);
    expect(artifacts.attachmentKeyFor(SES, 3)).toBe(`${INBOUND_ATTACHMENTS_PREFIX}${SES}/3`);
  });

  it.each(['', '../x', 'a/b', '.hidden', 'a b'])('SES 메시지 ID %j 는 키가 되지 못한다', (bad) => {
    const artifacts = createInboundArtifactStore(memoryStore().store);
    expect(() => artifacts.parsedKeyFor(bad)).toThrow(ObjectKeyFormatError);
    expect(() => artifacts.attachmentKeyFor(bad, 0)).toThrow(ObjectKeyFormatError);
  });

  it.each([-1, 1.5, Number.NaN])('partIndex %s 는 거부', async (index) => {
    const artifacts = createInboundArtifactStore(memoryStore().store);
    await expect(artifacts.putAttachment(SES, index, new Uint8Array(1))).rejects.toThrow(ObjectKeyFormatError);
  });
});

describe('쓰기', () => {
  it('첨부의 Content-Type 은 항상 application/octet-stream, 파싱 결과는 application/json', async () => {
    const { store, puts } = memoryStore();
    const artifacts = createInboundArtifactStore(store);
    await artifacts.putAttachment(SES, 0, new Uint8Array([1, 2]));
    await artifacts.putParsed(SES, '{"a":1}');
    expect(puts.map((put) => put.contentType)).toEqual(['application/octet-stream', 'application/json']);
    expect(new TextDecoder().decode(puts[1]?.bytes)).toBe('{"a":1}');
  });

  it('이미 있으면 created:false 로 성공한다 — 재전달이 poison pill 이 되지 않는다', async () => {
    const artifacts = createInboundArtifactStore(memoryStore().store);
    expect(await artifacts.putAttachment(SES, 0, new Uint8Array([1]))).toMatchObject({ created: true });
    expect(await artifacts.putAttachment(SES, 0, new Uint8Array([1]))).toMatchObject({ created: false });
    expect(await artifacts.putParsed(SES, '{}')).toMatchObject({ created: true });
    expect(await artifacts.putParsed(SES, '{}')).toMatchObject({ created: false });
  });

  it('이미 있음 외의 실패(일시 장애)는 그대로 올라간다 — 재시도 대상', async () => {
    const failing: ObjectStore = {
      kind: 's3',
      putIfAbsent: () => Promise.reject(new Error('S3 503')),
      get: () => Promise.reject(new Error('unused')),
    };
    await expect(createInboundArtifactStore(failing).putParsed(SES, '{}')).rejects.toThrow('S3 503');
  });
});

describe('첨부 바이트 읽기(첨부 내용 조회)', () => {
  it('수신 첨부 키만 읽고, 상한을 저장소에 그대로 넘긴다', async () => {
    const asked: string[] = [];
    const objects: ObjectStore = {
      kind: 'local-dev',
      putIfAbsent: () => Promise.reject(new Error('unused')),
      get: (key, maxBytes) => {
        asked.push(`${key}@${String(maxBytes)}`);
        return Promise.resolve(new Uint8Array([7]));
      },
    };
    const reader = createInboundAttachmentReader(objects);
    expect(await reader.readAttachment(`${INBOUND_ATTACHMENTS_PREFIX}${SES}/3`, 1234)).toEqual(new Uint8Array([7]));
    expect(asked).toEqual([`${INBOUND_ATTACHMENTS_PREFIX}${SES}/3@1234`]);
    for (const key of [
      `${INBOUND_PARSED_PREFIX}${SES}.json`,
      'outbound/content/x.json',
      `${INBOUND_ATTACHMENTS_PREFIX}../outbound/0`,
      `${INBOUND_ATTACHMENTS_PREFIX}${SES}/x`,
      `${INBOUND_ATTACHMENTS_PREFIX}${SES}/0/1`,
    ]) {
      await expect(reader.readAttachment(key, 10)).rejects.toBeInstanceOf(ObjectKeyFormatError);
    }
    expect(asked).toHaveLength(1);
  });
});
