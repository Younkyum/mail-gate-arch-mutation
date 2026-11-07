/**
 * S3 객체 저장소 — **실제 AWS 를 부르지 않는다.** 가짜 클라이언트가 SDK 명령 객체를 가로채
 * 그 `input` 을 단언한다. 여기서 잡으려는 것은 "요청에 무엇이 실리는가" 다:
 * SSE 헤더, 조건부 쓰기(`If-None-Match: *`), 버킷 소유자 고정, 그리고 상한을 **본문을 읽기 전에** 거는 것.
 */

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { GetObjectCommandOutput, PutObjectCommandOutput } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { createObjectContentStore, MessageContentAlreadyStoredError } from '../../../src/api/content-store';
import {
  ObjectAlreadyExistsError,
  ObjectKeyFormatError,
  ObjectNotFoundError,
  ObjectTooLargeError,
  parseMalwareScanStatus,
} from '../../../src/storage/object-store';
import {
  createS3ObjectStore,
  type S3ObjectClient,
  type S3ObjectStoreOptions,
} from '../../../src/storage/s3-object-store';

const ACCOUNT = '123456789012';
const BUCKET = 'atmarkstorage-mailstorebucket-test';

interface FakeObject {
  readonly body: Uint8Array;
  /** `undefined` 를 넣으면 응답에서 ContentLength 를 뺀다. */
  readonly declaredLength?: number | undefined;
}

class FakeS3 {
  readonly commands: (PutObjectCommand | GetObjectCommand)[] = [];
  readonly objects = new Map<string, FakeObject>();
  bodyReads = 0;
  bodyDestroyed = 0;
  failWith: Error | undefined;

  readonly client: S3ObjectClient = {
    send: (async (command: PutObjectCommand | GetObjectCommand): Promise<unknown> => {
      this.commands.push(command);
      if (this.failWith) throw this.failWith;
      if (command instanceof PutObjectCommand) {
        const key = command.input.Key ?? '';
        if (command.input.IfNoneMatch === '*' && this.objects.has(key)) {
          throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), {
            name: 'PreconditionFailed',
            $metadata: { httpStatusCode: 412 },
          });
        }
        this.objects.set(key, { body: command.input.Body as Uint8Array });
        return { $metadata: {} } satisfies PutObjectCommandOutput;
      }
      const found = this.objects.get(command.input.Key ?? '');
      if (!found) {
        throw Object.assign(new Error('The specified key does not exist.'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        });
      }
      const length = 'declaredLength' in found ? found.declaredLength : found.body.length;
      return {
        $metadata: {},
        ...(length === undefined ? {} : { ContentLength: length }),
        Body: {
          transformToByteArray: async () => {
            this.bodyReads += 1;
            return found.body;
          },
          destroy: () => {
            this.bodyDestroyed += 1;
          },
        },
      } as unknown as GetObjectCommandOutput;
    }) as S3ObjectClient['send'],
  };
}

function store(fake: FakeS3, overrides: Partial<S3ObjectStoreOptions> = {}) {
  return createS3ObjectStore({
    client: fake.client,
    bucket: BUCKET,
    expectedBucketOwner: ACCOUNT,
    encryption: { kind: 'sse-s3' },
    ...overrides,
  });
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('PutObject — 요청에 실리는 것', () => {
  it('SSE-S3(AES256)·If-None-Match:*·ExpectedBucketOwner·ContentType 이 실린다', async () => {
    const fake = new FakeS3();
    await store(fake).putIfAbsent('outbound/content/m.json', bytes('{}'), 'application/json');
    const [command] = fake.commands;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command?.input).toMatchObject({
      Bucket: BUCKET,
      Key: 'outbound/content/m.json',
      ContentType: 'application/json',
      ContentLength: 2,
      IfNoneMatch: '*',
      ExpectedBucketOwner: ACCOUNT,
      ServerSideEncryption: 'AES256',
    });
    expect(command?.input).not.toHaveProperty('SSEKMSKeyId');
  });

  it('SSE-KMS 를 고르면 aws:kms + 키 ID 가 실린다', async () => {
    const fake = new FakeS3();
    await store(fake, { encryption: { kind: 'sse-kms', kmsKeyId: 'alias/atmark-mail' } }).putIfAbsent(
      'k/a',
      bytes('a'),
      'text/plain',
    );
    expect(fake.commands[0]?.input).toMatchObject({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'alias/atmark-mail' });
  });

  it('이미 있는 키(412 PreconditionFailed)는 ObjectAlreadyExistsError — 덮어쓰지 않는다', async () => {
    const fake = new FakeS3();
    const s3 = store(fake);
    await s3.putIfAbsent('k/a', bytes('first'), 'text/plain');
    await expect(s3.putIfAbsent('k/a', bytes('second'), 'text/plain')).rejects.toBeInstanceOf(ObjectAlreadyExistsError);
    expect(new TextDecoder().decode(fake.objects.get('k/a')?.body)).toBe('first');
  });

  it('409 ConditionalRequestConflict(동시 쓰기)도 "쓰지 못했다" 로 옮긴다', async () => {
    const fake = new FakeS3();
    fake.failWith = Object.assign(new Error('conflict'), {
      name: 'ConditionalRequestConflict',
      $metadata: { httpStatusCode: 409 },
    });
    await expect(store(fake).putIfAbsent('k/a', bytes('a'), 'text/plain')).rejects.toBeInstanceOf(
      ObjectAlreadyExistsError,
    );
  });

  it('다른 오류는 그대로 올라간다 (AccessDenied 를 "이미 있다" 로 삼키지 않는다)', async () => {
    const fake = new FakeS3();
    fake.failWith = Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    await expect(store(fake).putIfAbsent('k/a', bytes('a'), 'text/plain')).rejects.toMatchObject({ name: 'AccessDenied' });
  });

  it('형식이 깨진 키는 **요청을 만들기 전에** 거부된다', async () => {
    const fake = new FakeS3();
    await expect(store(fake).putIfAbsent('../x', bytes('a'), 'text/plain')).rejects.toBeInstanceOf(ObjectKeyFormatError);
    expect(fake.commands).toEqual([]);
  });
});

describe('GetObject — 상한은 본문을 읽기 전에', () => {
  it('ExpectedBucketOwner 가 실리고 바이트가 돌아온다', async () => {
    const fake = new FakeS3();
    fake.objects.set('k/a', { body: bytes('hello') });
    await expect(store(fake).get('k/a', 5)).resolves.toEqual(bytes('hello'));
    expect(fake.commands[0]).toBeInstanceOf(GetObjectCommand);
    expect(fake.commands[0]?.input).toMatchObject({ Bucket: BUCKET, Key: 'k/a', ExpectedBucketOwner: ACCOUNT });
  });

  it('선언된 길이가 상한을 넘으면 본문을 **읽지 않고** 닫은 뒤 던진다', async () => {
    const fake = new FakeS3();
    fake.objects.set('k/big', { body: bytes('123456') });
    await expect(store(fake).get('k/big', 5)).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(fake.bodyReads).toBe(0);
    expect(fake.bodyDestroyed).toBe(1);
  });

  it('ContentLength 가 없으면 상한을 판정할 수 없으므로 거부한다 ("모르면 통과" 금지)', async () => {
    const fake = new FakeS3();
    fake.objects.set('k/unknown', { body: bytes('a'), declaredLength: undefined });
    await expect(store(fake).get('k/unknown', 5)).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(fake.bodyReads).toBe(0);
  });

  it('선언은 작은데 실제 바이트가 크면 실제로 닫는다', async () => {
    const fake = new FakeS3();
    fake.objects.set('k/liar', { body: bytes('123456'), declaredLength: 1 });
    await expect(store(fake).get('k/liar', 5)).rejects.toBeInstanceOf(ObjectTooLargeError);
  });

  it('NoSuchKey 는 ObjectNotFoundError', async () => {
    await expect(store(new FakeS3()).get('k/missing', 5)).rejects.toBeInstanceOf(ObjectNotFoundError);
  });
});

describe('구성 — 기본값이 없어야 하는 것', () => {
  it('빈 버킷 이름·12자리가 아닌 계정 ID 는 팩토리에서 거부된다', () => {
    const fake = new FakeS3();
    expect(() => store(fake, { bucket: ' ' })).toThrow();
    expect(() => store(fake, { expectedBucketOwner: '1234' })).toThrow();
  });
});

describe('발신 본문 어댑터가 S3 위에서도 같은 계약을 지킨다', () => {
  it('put → 새 인스턴스 load, 두 번째 put 은 거부', async () => {
    const fake = new FakeS3();
    await createObjectContentStore(store(fake)).put('m1', { subject: 's', text: 't', html: null, threading: null });
    await expect(createObjectContentStore(store(fake)).load('m1')).resolves.toEqual({ subject: 's', text: 't', html: null, threading: null });
    await expect(
      createObjectContentStore(store(fake)).put('m1', { subject: 'x', text: 't', html: null, threading: null }),
    ).rejects.toBeInstanceOf(MessageContentAlreadyStoredError);
    expect(fake.commands[0]?.input).toMatchObject({ Key: 'outbound/content/m1.json', ServerSideEncryption: 'AES256' });
  });
});

describe('악성 코드 스캔 판정 해석 — 통과는 NO_THREATS_FOUND 하나(fail-closed)', () => {
  it.each([
    [undefined, 'PENDING'],
    ['NO_THREATS_FOUND', 'NO_THREATS_FOUND'],
    ['THREATS_FOUND', 'THREATS_FOUND'],
    ['UNSUPPORTED', 'UNSUPPORTED'],
    ['PENDING', 'FAILED'],
    ['no_threats_found', 'FAILED'],
    ['', 'FAILED'],
  ] as const)('%j → %s', (value, expected) => {
    expect(parseMalwareScanStatus(value)).toBe(expected);
  });
});
