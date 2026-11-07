/**
 * src/storage/local-object-store.ts — **개발 전용** 구현. 운영에서 선택되면 던진다.
 *
 * 데모와 통합 테스트가 "다른 프로세스가 같은 본문을 읽는다" 를 AWS 없이 실연하려면 디스크가
 * 필요하다. 이 파일이 지켜야 하는 것은 둘이다:
 *   ① **운영에서 여기로 떨어지지 않는다.** `assertNotProduction()` 을 팩토리·`putIfAbsent`·`get`
 *      **각각에서** 부른다. 팩토리에서만 부르면 개발로 떠서 나중에 운영 설정을 받는 장기 실행
 *      프로세스가 통과한다(`passport/custody-local.ts` 와 같은 이유).
 *   ② **루트 밖으로 나가지 않는다.** 키 형식 검증(`assertValidObjectKey`)이 `..` 세그먼트를
 *      이미 막지만, 그 검증 하나에 경로 안전성을 걸지 않는다 — 해석된 절대 경로가 루트 아래인지
 *      **따로** 확인한다(`resolveInsideRoot`). 두 층이 각자 테스트된다.
 *
 * **쓰기는 `wx`** — 이미 있으면 EEXIST 로 실패한다. S3 구현의 `If-None-Match: *` 와 같은 성질이다.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, constants as fsConstants, mkdirSync, openSync, readFileSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DOWNLOAD_RESPONSE_CONTENT_DISPOSITION,
  DOWNLOAD_RESPONSE_CONTENT_TYPE,
  DOWNLOAD_URL_TTL_SECONDS,
  ObjectAlreadyExistsError,
  ObjectChangedError,
  ObjectKeyFormatError,
  ObjectNotFoundError,
  ObjectTooLargeError,
  assertNotProduction,
  assertValidMaxBytes,
  assertOutboundAttachmentKey,
  assertValidObjectKey,
  parseMalwareScanStatus,
  OUTBOUND_UPLOADS_PREFIX,
  UPLOAD_URL_TTL_SECONDS,
  type AttachmentMalwareScanner,
  type MalwareScanStatus,
  type ObjectDownloadSigner,
  type ObjectHead,
  type ObjectStore,
  type OutboundAttachmentObjects,
  type SignedDownload,
  type SignedUpload,
  type UploadSpec,
} from './object-store';

export const DEV_STORAGE_DIR_ENV = 'ATMARK_DEV_STORAGE_DIR';

/** 기본 디렉터리(리포 상대). `.gitignore` 에 등재돼 있다. */
export const DEFAULT_DEV_STORAGE_DIR = '.atmark-dev-storage';

export interface LocalObjectStoreOptions {
  /** 명시하지 않으면 `ATMARK_DEV_STORAGE_DIR` → `DEFAULT_DEV_STORAGE_DIR` 순. */
  readonly directory?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function resolveDevStorageDirectory(options: LocalObjectStoreOptions = {}): string {
  if (options.directory !== undefined && options.directory.trim() !== '') return options.directory;
  const fromEnv = (options.env ?? process.env)[DEV_STORAGE_DIR_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
  return DEFAULT_DEV_STORAGE_DIR;
}

/**
 * 키 → 루트 아래의 절대 경로. **루트 밖이면 던진다.**
 *
 * 키 형식 검증과 독립이다 — 이 함수는 검증되지 않은 문자열을 받아도 안전해야 한다.
 * `relative(root, target)` 이 `..` 로 시작하거나 절대 경로면(다른 드라이브) 탈출이다.
 * 루트 자신(빈 상대 경로)도 거부한다 — 디렉터리에 파일을 쓸 수는 없다.
 */
export function resolveInsideRoot(root: string, key: string): string {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, key);
  const rel = relative(absoluteRoot, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ObjectKeyFormatError(key, '저장소 루트 밖');
  }
  return target;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

/** 상한을 **읽기 전에**(크기로) 한 번, 읽은 뒤(stat 과 read 사이에 자랐을 수 있다) 실제 바이트로 한 번 판정한다. */
function readCapped(path: string, key: string, maxBytes: number): Uint8Array {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new ObjectNotFoundError(key);
    throw error;
  }
  if (size > maxBytes) throw new ObjectTooLargeError(key, size, maxBytes);
  const bytes = readFileSync(path);
  if (bytes.length > maxBytes) throw new ObjectTooLargeError(key, bytes.length, maxBytes);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}

/** 로컬 ETag — 내용의 SHA-256 hex(S3 처럼 따옴표 포함). */
function etagOf(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('hex')}"`;
}

export function createLocalObjectStore(options: LocalObjectStoreOptions = {}): ObjectStore {
  const env = options.env ?? process.env;
  assertNotProduction('createLocalObjectStore', env);
  const root = resolveDevStorageDirectory(options);

  function pathFor(key: string): string {
    assertValidObjectKey(key);
    return resolveInsideRoot(root, key);
  }

  return {
    kind: 'local-dev',

    // `async` — 동기 throw 와 거부(rejection)를 섞지 않는다. 실패는 전부 거부다.
    async putIfAbsent(key: string, bytes: Uint8Array): Promise<void> {
      // 팩토리에서 봤어도 다시 본다 — 팩토리 시점의 판정은 장기 실행 프로세스에서 이미 낡았다.
      assertNotProduction('createLocalObjectStore().putIfAbsent', env);
      const path = pathFor(key);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (isErrno(error, 'EEXIST')) throw new ObjectAlreadyExistsError(key);
        throw error;
      }
    },

    async get(key: string, maxBytes: number): Promise<Uint8Array> {
      assertNotProduction('createLocalObjectStore().get', env);
      assertValidMaxBytes(maxBytes);
      return readCapped(pathFor(key), key, maxBytes);
    },
  };
}

// ---------------------------------------------------------------------------
// 다운로드 서명기 — 개발 전용 (P3c)
// ---------------------------------------------------------------------------

/** 로컬 URL 의 만료 쿼리(에포크 초). S3 의 `X-Amz-Expires` 자리. */
export const LOCAL_DOWNLOAD_EXPIRES_PARAM = 'X-Atmark-Expires';

/**
 * S3 presigned GET 과 **같은 모양의 계약**을 로컬 파일로 흉내 낸다 — 만료 쿼리와 강제 응답 헤더 두 개가 URL 에
 * 실린다. 서명은 없다(개발 전용; 같은 기계의 파일이다). 운영에서 선택되면 던진다.
 *
 * URL 을 여는 쪽은 `openLocalSignedDownload` — 만료를 **여는 시점에** 판정한다(S3 가 하는 일).
 */
export function createLocalDownloadSigner(options: LocalObjectStoreOptions = {}): ObjectDownloadSigner {
  const env = options.env ?? process.env;
  assertNotProduction('createLocalDownloadSigner', env);
  const root = resolveDevStorageDirectory(options);
  return {
    kind: 'local-dev',
    async signDownload(key: string, now: Date): Promise<SignedDownload> {
      assertNotProduction('createLocalDownloadSigner().signDownload', env);
      assertValidObjectKey(key);
      const path = resolveInsideRoot(root, key);
      const expiresAt = new Date(now.getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000);
      const url = pathToFileURL(path);
      url.searchParams.set(LOCAL_DOWNLOAD_EXPIRES_PARAM, String(Math.floor(expiresAt.getTime() / 1000)));
      url.searchParams.set('response-content-disposition', DOWNLOAD_RESPONSE_CONTENT_DISPOSITION);
      url.searchParams.set('response-content-type', DOWNLOAD_RESPONSE_CONTENT_TYPE);
      return { url: url.href, expiresAt };
    },
  };
}

export class SignedDownloadExpiredError extends Error {
  constructor() {
    super('다운로드 URL 이 만료됐다');
    this.name = 'SignedDownloadExpiredError';
  }
}

/** 개발 전용 URL 을 연다. 만료·강제 헤더를 확인하고 바이트를 돌려준다(데모·테스트의 "다운로드"). */
export function openLocalSignedDownload(
  href: string,
  now: Date,
  maxBytes: number,
  env: NodeJS.ProcessEnv = process.env,
): { readonly bytes: Uint8Array; readonly contentDisposition: string | null; readonly contentType: string | null } {
  assertNotProduction('openLocalSignedDownload', env);
  assertValidMaxBytes(maxBytes);
  const url = new URL(href);
  if (url.protocol !== 'file:') throw new Error('로컬 다운로드 URL 이 아니다');
  const expires = Number(url.searchParams.get(LOCAL_DOWNLOAD_EXPIRES_PARAM));
  if (!Number.isFinite(expires) || now.getTime() >= expires * 1000) throw new SignedDownloadExpiredError();
  const path = fileURLToPath(new URL(url.pathname, 'file://'));
  const size = statSync(path).size;
  if (size > maxBytes) throw new ObjectTooLargeError(path, size, maxBytes);
  const bytes = readFileSync(path);
  return {
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length),
    contentDisposition: url.searchParams.get('response-content-disposition'),
    contentType: url.searchParams.get('response-content-type'),
  };
}

// ---------------------------------------------------------------------------
// 발신 첨부 — 개발 전용(메일 기본기 2차 A2). S3 의 서명·체크섬·조건부 쓰기·태그를 **흉내만** 낸다.
// ---------------------------------------------------------------------------

/**
 * 로컬 스캔 판정 파일 — 객체 옆 `<키>.scan`(값 = `MalwareScanStatus`). GuardDuty 태그의 자리다. 없으면 `PENDING`. 데모·테스트가
 * `markLocalMalwareScan` 으로 적는다(자동으로 "깨끗함" 을 주는 개발 편의는 두지 않는다 — 스캔을 건너뛴 경로를 테스트가 보게).
 */
function scanPathFor(root: string, key: string): string {
  return `${resolveInsideRoot(root, key)}.scan`;
}

export function markLocalMalwareScan(key: string, status: MalwareScanStatus, options: LocalObjectStoreOptions = {}): void {
  const env = options.env ?? process.env;
  assertNotProduction('markLocalMalwareScan', env);
  assertOutboundAttachmentKey(key);
  const root = resolveDevStorageDirectory(options);
  const path = scanPathFor(root, key);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, status, { mode: 0o600 });
}

/** 개발 전용 첨부 객체 — 업로드 URL 은 `file://`(헤더는 S3 와 같은 넷), 머리의 체크섬은 **실제 바이트에서** 계산한다. */
export function createLocalOutboundAttachmentObjects(options: LocalObjectStoreOptions = {}): OutboundAttachmentObjects {
  const env = options.env ?? process.env;
  assertNotProduction('createLocalOutboundAttachmentObjects', env);
  const root = resolveDevStorageDirectory(options);
  const pathFor = (key: string): string => {
    assertOutboundAttachmentKey(key);
    return resolveInsideRoot(root, key);
  };
  return {
    kind: 'local-dev',
    async signUpload(key: string, spec: UploadSpec, now: Date): Promise<SignedUpload> {
      assertNotProduction('createLocalOutboundAttachmentObjects().signUpload', env);
      if (!key.startsWith(OUTBOUND_UPLOADS_PREFIX)) throw new ObjectKeyFormatError(key, '업로드는 스테이징 접두사만');
      const expiresAt = new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000);
      const url = pathToFileURL(pathFor(key));
      url.searchParams.set(LOCAL_DOWNLOAD_EXPIRES_PARAM, String(Math.floor(expiresAt.getTime() / 1000)));
      return {
        method: 'PUT',
        url: url.href,
        headers: {
          'content-type': spec.contentType,
          'content-length': String(spec.contentLength),
          'x-amz-checksum-sha256': spec.sha256Base64,
          'if-none-match': '*',
        },
        expiresAt,
      };
    },
    async head(key: string): Promise<ObjectHead | null> {
      assertNotProduction('createLocalOutboundAttachmentObjects().head', env);
      const path = pathFor(key);
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return null;
        throw error;
      }
      const digest = createHash('sha256').update(bytes).digest();
      return { size: bytes.length, sha256Base64: digest.toString('base64'), etag: `"${digest.toString('hex')}"` };
    },
    async readPrefix(key: string, length: number): Promise<Uint8Array> {
      assertNotProduction('createLocalOutboundAttachmentObjects().readPrefix', env);
      const path = pathFor(key);
      let fd: number;
      try {
        fd = openSync(path, 'r');
      } catch (error) {
        if (isErrno(error, 'ENOENT')) throw new ObjectNotFoundError(key);
        throw error;
      }
      try {
        const buffer = Buffer.alloc(length);
        const read = readSync(fd, buffer, 0, length, 0);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, read);
      } finally {
        closeSync(fd);
      }
    },
    async get(key: string, maxBytes: number): Promise<Uint8Array> {
      assertNotProduction('createLocalOutboundAttachmentObjects().get', env);
      assertValidMaxBytes(maxBytes);
      return readCapped(pathFor(key), key, maxBytes);
    },
    async copyOnce(sourceKey: string, destinationKey: string, options: { readonly ifMatch?: string | null } = {}): Promise<'copied' | 'exists'> {
      assertNotProduction('createLocalOutboundAttachmentObjects().copyOnce', env);
      const source = pathFor(sourceKey);
      const destination = pathFor(destinationKey);
      if (options.ifMatch !== undefined && options.ifMatch !== null) {
        let current: string;
        try {
          current = etagOf(readFileSync(source));
        } catch (error) {
          if (isErrno(error, 'ENOENT')) throw new ObjectNotFoundError(sourceKey);
          throw error;
        }
        if (current !== options.ifMatch) {
          try {
            statSync(destination);
            return 'exists';
          } catch {
            throw new ObjectChangedError(sourceKey);
          }
        }
      }
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      try {
        copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
        return 'copied';
      } catch (error) {
        if (isErrno(error, 'EEXIST')) return 'exists';
        if (isErrno(error, 'ENOENT')) throw new ObjectNotFoundError(sourceKey);
        throw error;
      }
    },
  };
}

/** 개발 전용 스캔 판정 — `markLocalMalwareScan` 이 적은 값. 없으면 `PENDING`, 모르는 값은 `FAILED`. */
export function createLocalMalwareScanner(options: LocalObjectStoreOptions = {}): AttachmentMalwareScanner {
  const env = options.env ?? process.env;
  assertNotProduction('createLocalMalwareScanner', env);
  const root = resolveDevStorageDirectory(options);
  return {
    kind: 'local-dev',
    async status(key: string): Promise<MalwareScanStatus> {
      assertNotProduction('createLocalMalwareScanner().status', env);
      assertOutboundAttachmentKey(key);
      if (statSafe(resolveInsideRoot(root, key)) === null) throw new ObjectNotFoundError(key);
      const scanPath = scanPathFor(root, key);
      return parseMalwareScanStatus(statSafe(scanPath) === null ? undefined : readFileSync(scanPath, 'utf8').trim());
    },
  };
}

function statSafe(path: string): number | null {
  try {
    return statSync(path).size;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}
