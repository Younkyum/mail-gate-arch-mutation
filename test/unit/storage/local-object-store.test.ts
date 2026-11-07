/**
 * 로컬 파일시스템 객체 저장소 — **운영 가드**(팩토리·쓰기·읽기 각각)와 **경로 탈출**.
 *
 * 이 구현은 개발·데모 전용이다. 운영에서 선택되면 본문이 Lambda `/tmp` 에 쓰이고 인스턴스와 함께
 * 사라진다 — 승인 릴리스가 조용히 전부 `failed` 가 된다. 그래서 가드 셋을 **각각 따로** 확인한다:
 * 하나를 지우면 그 하나를 겨냥한 단언이 빨개져야 한다.
 */

import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONTENT_FORMAT_VERSION,
  MAX_CONTENT_BYTES,
  MessageContentAlreadyStoredError,
  MessageContentCorruptError,
  MessageContentNotFoundError,
  contentKeyFor,
  createObjectContentStore,
} from '../../../src/api/content-store';
import {
  createLocalObjectStore,
  resolveDevStorageDirectory,
  resolveInsideRoot,
} from '../../../src/storage/local-object-store';
import {
  INBOUND_RAW_PREFIX,
  ObjectAlreadyExistsError,
  ObjectKeyFormatError,
  ObjectNotFoundError,
  ObjectTooLargeError,
  OUTBOUND_CONTENT_PREFIX,
  ProductionStorageGuardError,
  assertValidObjectKey,
} from '../../../src/storage/object-store';
import { DEFAULT_MAX_RAW_MAIL_BYTES, createRawMailStore } from '../../../src/storage/raw-mail-store';

const MESSAGE_ID = '6f1c2a4e-9b3d-4c8e-a1f0-2d7b5e9c3a10';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'atmark-storage-'));
}

function devEnv(): NodeJS.ProcessEnv {
  return { ATMARK_ENV: 'development' };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('운영 가드 — 팩토리·쓰기·읽기 각각에서 던진다', () => {
  // NODE_ENV 만 production 이어도 던진다(fail closed).
  it.each([{ ATMARK_ENV: 'production' }, { NODE_ENV: 'production' }])('팩토리: %j 이면 만들어지지 않는다', (env) => {
    expect(() => createLocalObjectStore({ directory: tempRoot(), env })).toThrow(ProductionStorageGuardError);
  });

  it('쓰기: 개발로 만들어진 뒤 운영 설정을 받은 프로세스에서 putIfAbsent 가 던지고 **아무것도 쓰지 않는다**', async () => {
    const root = tempRoot();
    const env = devEnv();
    const store = createLocalObjectStore({ directory: root, env });
    env['ATMARK_ENV'] = 'production';
    await expect(store.putIfAbsent('outbound/content/x.json', bytes('{}'), 'application/json')).rejects.toBeInstanceOf(
      ProductionStorageGuardError,
    );
    expect(readdirSync(root)).toEqual([]);
  });

  it('읽기: 같은 조건에서 get 도 던진다', async () => {
    const root = tempRoot();
    const env = devEnv();
    const store = createLocalObjectStore({ directory: root, env });
    await store.putIfAbsent('outbound/content/x.json', bytes('{}'), 'application/json');
    env['ATMARK_ENV'] = 'production';
    await expect(store.get('outbound/content/x.json', 100)).rejects.toBeInstanceOf(ProductionStorageGuardError);
  });

  it('로컬 구현을 아는 프로덕션 코드가 없다 — 운영 배선에 등장하려면 누군가 명시적으로 바꿔야 한다', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('local-object-store.ts')) {
          // 주석의 언급은 세지 않는다 — 모듈 지정자(정적·동적 import, require)만 본다.
          if (/(from|import\(|require\()\s*['"][^'"]*local-object-store['"]/.test(readFileSync(full, 'utf8'))) {
            offenders.push(full);
          }
        }
      }
    };
    walk(fileURLToPath(new URL('../../../src', import.meta.url)));
    expect(offenders).toEqual([]);
  });

  it('디렉터리 결정: 명시 → ATMARK_DEV_STORAGE_DIR → 기본값', () => {
    expect(resolveDevStorageDirectory({ directory: '/a', env: { ATMARK_DEV_STORAGE_DIR: '/b' } })).toBe('/a');
    expect(resolveDevStorageDirectory({ env: { ATMARK_DEV_STORAGE_DIR: '/b' } })).toBe('/b');
    expect(resolveDevStorageDirectory({ env: {} })).toBe('.atmark-dev-storage');
  });
});

describe('경로 탈출 — 두 층이 각자 막는다', () => {
  it.each([
    '../escape',
    'outbound/../../escape',
    'a/../b',
    '/etc/passwd',
    'a//b',
    'a/',
    '.hidden',
    'a\\..\\b',
    'a/b\u0000c',
    '',
    'x'.repeat(1025),
  ])('키 형식 검증이 %j 를 거부한다', (key) => {
    expect(() => assertValidObjectKey(key)).toThrow(ObjectKeyFormatError);
  });

  it.each(['outbound/content/6f1c2a4e-9b3d.json', `${INBOUND_RAW_PREFIX}0000014a-abc_DEF=1`])(
    '키 형식 검증이 %j 를 받는다',
    (key) => {
      expect(() => assertValidObjectKey(key)).not.toThrow();
    },
  );

  it.each(['../escape', 'a/../../escape', '/etc/passwd', '.', 'a/..'])(
    '루트 포함 검사가 **검증되지 않은** %j 를 독립적으로 거부한다',
    (key) => {
      expect(() => resolveInsideRoot('/srv/store', key)).toThrow(ObjectKeyFormatError);
    },
  );

  it('루트 포함 검사는 루트 아래 경로를 그대로 돌려준다', () => {
    expect(resolveInsideRoot('/srv/store', 'a/b.json')).toBe('/srv/store/a/b.json');
  });

  it('저장소 입구에서 `../` 키로 쓰기·읽기가 거부되고 루트 밖에 파일이 생기지 않는다', async () => {
    const parent = tempRoot();
    const root = join(parent, 'root');
    const store = createLocalObjectStore({ directory: root, env: devEnv() });
    await expect(store.putIfAbsent('../escaped', bytes('x'), 'text/plain')).rejects.toBeInstanceOf(ObjectKeyFormatError);
    await expect(store.get('../escaped', 10)).rejects.toBeInstanceOf(ObjectKeyFormatError);
    expect(readdirSync(parent)).toEqual([]);
  });
});

describe('write-once · 크기 상한 · 없음', () => {
  it('같은 키로 두 번 쓰면 두 번째가 거부되고 처음 내용이 남는다', async () => {
    const store = createLocalObjectStore({ directory: tempRoot(), env: devEnv() });
    await store.putIfAbsent('k/one', bytes('first'), 'text/plain');
    await expect(store.putIfAbsent('k/one', bytes('second'), 'text/plain')).rejects.toBeInstanceOf(
      ObjectAlreadyExistsError,
    );
    expect(new TextDecoder().decode(await store.get('k/one', 100))).toBe('first');
  });

  it('상한 초과는 던지고, 경계값(= 상한)은 통과한다', async () => {
    const store = createLocalObjectStore({ directory: tempRoot(), env: devEnv() });
    await store.putIfAbsent('k/five', bytes('12345'), 'text/plain');
    await expect(store.get('k/five', 4)).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect((await store.get('k/five', 5)).length).toBe(5);
  });

  it('상한이 NaN·음수면 "상한 없음" 으로 읽지 않고 던진다', async () => {
    const store = createLocalObjectStore({ directory: tempRoot(), env: devEnv() });
    await store.putIfAbsent('k/a', bytes('a'), 'text/plain');
    await expect(store.get('k/a', Number.NaN)).rejects.toBeInstanceOf(RangeError);
    await expect(store.get('k/a', -1)).rejects.toBeInstanceOf(RangeError);
  });

  it('없는 키는 ObjectNotFoundError', async () => {
    const store = createLocalObjectStore({ directory: tempRoot(), env: devEnv() });
    await expect(store.get('k/missing', 10)).rejects.toBeInstanceOf(ObjectNotFoundError);
  });
});

describe('발신 본문 — 다른 프로세스가 읽는다 (승인 릴리스의 전제)', () => {
  it('한 인스턴스가 쓴 본문을 **새로 만든 인스턴스**가 읽는다 — 인스턴스에 상태가 없다', async () => {
    const root = tempRoot();
    const writer = createObjectContentStore(createLocalObjectStore({ directory: root, env: devEnv() }));
    await writer.put(MESSAGE_ID, { subject: '제목', text: '본문', html: '<p>본문</p>', threading: null });

    // 최초 시도의 프로세스는 없다 — 릴리스 워커는 같은 디렉터리로 저장소를 새로 만든다.
    const reader = createObjectContentStore(createLocalObjectStore({ directory: root, env: devEnv() }));
    await expect(reader.load(MESSAGE_ID)).resolves.toEqual({ subject: '제목', text: '본문', html: '<p>본문</p>', threading: null });
    expect(readdirSync(join(root, 'outbound', 'content'))).toEqual([`${MESSAGE_ID}.json`]);
  });

  it('html=null (text/plain 단일 파트) 이 그대로 돌아온다', async () => {
    const store = createObjectContentStore(createLocalObjectStore({ directory: tempRoot(), env: devEnv() }));
    await store.put(MESSAGE_ID, { subject: 's', text: 't', html: null, threading: null });
    await expect(store.load(MESSAGE_ID)).resolves.toEqual({ subject: 's', text: 't', html: null, threading: null });
  });

  it('없는 본문은 호출자가 이미 아는 MessageContentNotFoundError 로 옮겨진다', async () => {
    const store = createObjectContentStore(createLocalObjectStore({ directory: tempRoot(), env: devEnv() }));
    await expect(store.load(MESSAGE_ID)).rejects.toBeInstanceOf(MessageContentNotFoundError);
  });

  it('본문은 덮어쓰지 않는다 — 승인자가 본 본문이 나간다', async () => {
    const store = createObjectContentStore(createLocalObjectStore({ directory: tempRoot(), env: devEnv() }));
    await store.put(MESSAGE_ID, { subject: '승인된 것', text: 'a', html: null, threading: null });
    await expect(store.put(MESSAGE_ID, { subject: '바꿔치기', text: 'b', html: null, threading: null })).rejects.toBeInstanceOf(
      MessageContentAlreadyStoredError,
    );
    await expect(store.load(MESSAGE_ID)).resolves.toMatchObject({ subject: '승인된 것' });
  });

  it('상한을 넘는 본문은 **쓸 때** 거부된다 — 읽을 때 거부되면 영원히 보낼 수 없다', async () => {
    const root = tempRoot();
    const store = createObjectContentStore(createLocalObjectStore({ directory: root, env: devEnv() }));
    await expect(store.put(MESSAGE_ID, { subject: 's', text: 'x'.repeat(MAX_CONTENT_BYTES), html: null, threading: null })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([
    ['JSON 아님', 'not json'],
    ['버전 다름', JSON.stringify({ v: 99, subject: 's', text: 't', html: null })],
    ['필드 타입', JSON.stringify({ v: CONTENT_FORMAT_VERSION, subject: 1, text: 't', html: null })],
    ['html 누락', JSON.stringify({ v: CONTENT_FORMAT_VERSION, subject: 's', text: 't' })],
    ['배열', '[]'],
  ])('손상된 객체(%s)는 빈 메일로 메우지 않고 던진다', async (_label, raw) => {
    const objects = createLocalObjectStore({ directory: tempRoot(), env: devEnv() });
    await objects.putIfAbsent(contentKeyFor(MESSAGE_ID), bytes(raw), 'application/json');
    await expect(createObjectContentStore(objects).load(MESSAGE_ID)).rejects.toBeInstanceOf(MessageContentCorruptError);
  });

  it('키는 outbound/content/{messageId}.json 이다', () => {
    expect(contentKeyFor(MESSAGE_ID)).toBe(`${OUTBOUND_CONTENT_PREFIX}${MESSAGE_ID}.json`);
  });
});

describe('수신 원문 — 키 → 바이트, 크기 상한', () => {
  it('SES 키 규칙(inbound/raw/{sesMessageId})으로 쓰고 읽는다', async () => {
    const raw = createRawMailStore(createLocalObjectStore({ directory: tempRoot(), env: devEnv() }));
    const key = await raw.put('0000014a-f896-4c47-b2e1-EXAMPLE', bytes('From: a@b\r\n\r\nhi'));
    expect(key).toBe('inbound/raw/0000014a-f896-4c47-b2e1-EXAMPLE');
    expect(new TextDecoder().decode(await raw.get(key))).toBe('From: a@b\r\n\r\nhi');
  });

  it('상한을 넘는 원문은 읽기 전에 거부된다', async () => {
    const objects = createLocalObjectStore({ directory: tempRoot(), env: devEnv() });
    await objects.putIfAbsent('inbound/raw/big', new Uint8Array(11), 'message/rfc822');
    await expect(createRawMailStore(objects, { maxBytes: 10 }).get('inbound/raw/big')).rejects.toBeInstanceOf(
      ObjectTooLargeError,
    );
    expect(DEFAULT_MAX_RAW_MAIL_BYTES).toBe(40 * 1024 * 1024);
  });

  it('inbound/raw/ 밖의 키(발신 본문)는 이 어댑터로 읽을 수 없다', async () => {
    const raw = createRawMailStore(createLocalObjectStore({ directory: tempRoot(), env: devEnv() }));
    await expect(raw.get(contentKeyFor(MESSAGE_ID))).rejects.toBeInstanceOf(ObjectKeyFormatError);
  });

  it('SES 메시지 ID 에 `/`·`..` 가 섞이면 거부된다', () => {
    const raw = createRawMailStore(createLocalObjectStore({ directory: tempRoot(), env: devEnv() }));
    expect(() => raw.keyFor('a/b')).toThrow(ObjectKeyFormatError);
    expect(() => raw.keyFor('..')).toThrow(ObjectKeyFormatError);
  });
});
