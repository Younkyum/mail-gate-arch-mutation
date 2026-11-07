/**
 * src/storage/s3-object-store.ts — 운영 구현. **이 리포에서 `@aws-sdk/client-s3` 를 import 하는
 * 유일한 파일이다** (`.dependency-cruiser.cjs` 의 `no-s3-sdk-outside-storage`, 그리고
 * `test/arch/network-egress.arch.test.ts` 의 허용목록이 이름으로 이 파일을 적는다).
 *
 * **SDK 클라이언트 전체가 아니라 `send` 하나를 받는다** — `ses-transport.ts` 와 같은 이유다.
 * 단위 테스트가 네트워크 없이 명령 객체(`PutObjectCommand`/`GetObjectCommand`)를 가로채
 * 그 `input` 을 단언할 수 있어야 하고, 그 요구가 인터페이스를 좁힌다.
 *
 * 요청마다 거는 것:
 *   - **`ServerSideEncryption`** — 버킷 기본 암호화(`storage-stack.ts`)와 **중복으로** 명시한다.
 *     버킷 설정이 바뀌어도 이 코드가 쓰는 객체는 암호화된다. 값은 옵션이 정한다(SSE-S3 기본).
 *   - **`IfNoneMatch: '*'`** — S3 조건부 쓰기. 키가 이미 있으면 412 로 거부된다. 포트의
 *     write-once 를 서버가 보증한다(읽고 나서 쓰는 방식은 경쟁에서 진다).
 *   - **`ExpectedBucketOwner`** — 버킷 이름이 다른 계정의 버킷으로 해석되는 사고(설정 오타,
 *     삭제된 버킷 이름의 재등록)에서 본문을 남의 버킷에 쓰지 않게 한다.
 */

import {
  CopyObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type CopyObjectCommandOutput,
  type GetObjectCommandOutput,
  type GetObjectTaggingCommandOutput,
  type HeadObjectCommandOutput,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  DOWNLOAD_RESPONSE_CONTENT_DISPOSITION,
  DOWNLOAD_RESPONSE_CONTENT_TYPE,
  DOWNLOAD_URL_TTL_SECONDS,
  MALWARE_SCAN_TAG_KEY,
  ObjectAlreadyExistsError,
  ObjectChangedError,
  ObjectKeyFormatError,
  ObjectNotFoundError,
  ObjectTooLargeError,
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

/** 이 구현이 쓰는 S3 호출면 — 명령 두 개뿐. */
export interface S3ObjectClient {
  send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
}

/** 읽기 전용 호출면 — `GetObjectCommand` 하나. 관리 콘솔의 발신 본문 읽기(`createS3ObjectReader`)가 받는다. */
export interface S3ObjectReadClient {
  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
}

/** 실제 S3 클라이언트. **이 함수를 부르는 순간 AWS 자격증명이 필요하다.** */
export function createS3Client(region: string): S3ObjectClient {
  return new S3Client({ region });
}

/** 서버측 암호화. **"없음" 선택지가 없다** — 타입이 그것을 표현할 수 없게 한다. */
export type S3ServerSideEncryption =
  | { readonly kind: 'sse-s3' }
  | { readonly kind: 'sse-kms'; readonly kmsKeyId: string };

export interface S3ObjectStoreOptions {
  readonly client: S3ObjectClient;
  /** `storage-stack.ts` 의 `MailStoreBucketName` 출력값. */
  readonly bucket: string;
  /** 버킷 소유 계정 ID(12자리). 기본값이 없다 — 있으면 안 된다. */
  readonly expectedBucketOwner: string;
  readonly encryption: S3ServerSideEncryption;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode;
}

function isNoSuchKey(error: unknown): boolean {
  return errorName(error) === 'NoSuchKey' || httpStatus(error) === 404;
}

/** 412 PreconditionFailed = 이미 있다(또는 원본 판 불일치). 409 ConditionalRequestConflict = 같은 키로 동시에 쓰는 중. */
function isConditionalWriteRejected(error: unknown): boolean {
  const name = errorName(error);
  const status = httpStatus(error);
  return name === 'PreconditionFailed' || name === 'ConditionalRequestConflict' || status === 412 || status === 409;
}

function assertBucketTarget(bucket: string, expectedBucketOwner: string, emptyBucketMessage = 'S3 버킷 이름이 비어 있다'): void {
  if (bucket.trim() === '') throw new Error(emptyBucketMessage);
  if (!/^\d{12}$/.test(expectedBucketOwner)) {
    throw new Error(`expectedBucketOwner 는 12자리 계정 ID 여야 한다: ${expectedBucketOwner}`);
  }
}

/** 거부할 본문 스트림을 닫는다. 읽지 않고 버리면 소켓이 풀로 돌아가지 않는다. */
function discard(body: unknown): void {
  const destroy = (body as { destroy?: () => void } | undefined)?.destroy;
  if (typeof destroy === 'function') destroy.call(body);
}

export function createS3ObjectStore(options: S3ObjectStoreOptions): ObjectStore {
  assertBucketTarget(options.bucket, options.expectedBucketOwner);
  const { client, bucket, expectedBucketOwner, encryption } = options;
  const sse =
    encryption.kind === 'sse-kms'
      ? { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: encryption.kmsKeyId }
      : { ServerSideEncryption: 'AES256' as const };

  return {
    kind: 's3',

    async putIfAbsent(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
      assertValidObjectKey(key);
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: bytes,
            ContentType: contentType,
            ContentLength: bytes.length,
            IfNoneMatch: '*',
            ExpectedBucketOwner: expectedBucketOwner,
            ...sse,
          }),
        );
      } catch (error) {
        // 어느 쪽이든 **이 호출은 쓰지 못했다.**
        if (isConditionalWriteRejected(error)) throw new ObjectAlreadyExistsError(key);
        throw error;
      }
    },

    get(key: string, maxBytes: number): Promise<Uint8Array> {
      return getObject(client, bucket, expectedBucketOwner, key, maxBytes);
    },
  };
}

/** `get` 의 본체 — 쓰기 저장소와 읽기 전용 리더가 같은 규칙(키 검증 · 상한 · 404 판정)을 쓴다. */
async function getObject(
  client: S3ObjectReadClient,
  bucket: string,
  expectedBucketOwner: string,
  key: string,
  maxBytes: number,
): Promise<Uint8Array> {
  assertValidObjectKey(key);
  assertValidMaxBytes(maxBytes);
  let output: GetObjectCommandOutput;
  try {
    output = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, ExpectedBucketOwner: expectedBucketOwner }));
  } catch (error) {
    if (isNoSuchKey(error)) throw new ObjectNotFoundError(key);
    throw error;
  }
  // **본문을 읽기 전에** 선언된 길이로 판정한다. 길이가 없으면 상한을 판정할 수 없으므로
  // 거부한다 — "모르면 통과" 는 상한이 없다는 뜻이다.
  const declared = output.ContentLength;
  if (declared === undefined || declared > maxBytes) {
    discard(output.Body);
    throw new ObjectTooLargeError(key, declared ?? 'unknown', maxBytes);
  }
  if (output.Body === undefined) throw new ObjectNotFoundError(key);
  const bytes = await output.Body.transformToByteArray();
  // 선언과 실제가 다르면(프록시·버그) 실제로 닫는다.
  if (bytes.length > maxBytes) throw new ObjectTooLargeError(key, bytes.length, maxBytes);
  return bytes;
}

export interface S3ObjectReaderOptions {
  readonly client: S3ObjectReadClient;
  readonly bucket: string;
  readonly expectedBucketOwner: string;
  /** 이 리더가 읽을 수 있는 **유일한** 접두사(예: `outbound/content/`). 밖의 키는 S3 에 묻기 전에 거부한다. */
  readonly prefix: string;
}

/**
 * **읽기 전용 · 접두사 하나** 리더 (US-004 — 관리 콘솔의 발신 본문 보기). 쓰기 경로(`putIfAbsent`)가 **없다** — 이 면을
 * 받은 코드는 버킷에 쓸 수 없다. 접두사 밖 키는 네트워크 전에 `ObjectKeyFormatError` 다. IAM(admin 역할 `s3:GetObject`
 * on `outbound/content/*` 하나)이 같은 선을 한 번 더 긋는다 — 이 검사는 코드 층, IAM 은 권한 층이다.
 */
export function createS3ObjectReader(options: S3ObjectReaderOptions): Pick<ObjectStore, 'get'> {
  assertBucketTarget(options.bucket, options.expectedBucketOwner);
  if (!/^[a-z]+(\/[a-z]+)*\/$/.test(options.prefix)) throw new Error(`읽기 접두사 형식이 아니다: ${options.prefix}`);
  const { client, bucket, expectedBucketOwner, prefix } = options;
  return {
    get(key: string, maxBytes: number): Promise<Uint8Array> {
      if (!key.startsWith(prefix)) return Promise.reject(new ObjectKeyFormatError(key, `접두사 ${prefix} 밖`));
      return getObject(client, bucket, expectedBucketOwner, key, maxBytes);
    },
  };
}

// ---------------------------------------------------------------------------
// 다운로드 서명기 — S3 presigned GET (P3c, 수신 첨부)
// ---------------------------------------------------------------------------

export interface S3DownloadSignerOptions {
  /**
   * **실제 `S3Client`** — presigner 는 클라이언트의 자격증명·리전·엔드포인트 설정으로 서명한다. 서명은 로컬
   * 계산이고 네트워크를 타지 않는다(단위 테스트가 가짜 자격증명으로 URL 을 만든다).
   */
  readonly client: S3Client;
  readonly bucket: string;
}

/**
 * 첨부 다운로드 URL. **왜 프록시(스트리밍)가 아니라 presigned 인가:** 첨부는 40MB 까지 온다(파서 상한).
 * API 가 Lambda 뒤에 있으면 응답 본문 상한(6MB)에 걸리고, 바이트가 우리 컴퓨트를 지나갈 이유도 없다.
 * 대가는 "URL 을 가진 누구나 5분간 받을 수 있다" 이고, 그것을 짧은 수명과 강제 헤더로 줄인다.
 *
 * - **`ResponseContentDisposition: attachment` + `ResponseContentType: application/octet-stream`** 을 서명에 넣는다
 *   (`response-content-*` 쿼리가 서명 대상이 된다 — 받는 쪽이 지우거나 바꾸면 서명이 깨진다). 호출자가 고를
 *   자리가 없다(`object-store.ts` DOWNLOAD_* 주석).
 * - `ExpectedBucketOwner` 는 싣지 않는다: presigned GET 에서는 요청 헤더로 보내야 하는 값이라 URL 만 가진
 *   클라이언트가 채울 수 없다. 버킷 오인의 방어는 쓰기 경로(`putIfAbsent`, 같은 버킷 이름)가 먼저 실패하는 것이다 —
 *   첨부 객체는 그 경로로만 생긴다.
 */
export function createS3DownloadSigner(options: S3DownloadSignerOptions): ObjectDownloadSigner {
  if (options.bucket.trim() === '') throw new Error('S3 버킷 이름이 비어 있다');
  const { client, bucket } = options;
  return {
    kind: 's3',
    async signDownload(key: string, now: Date): Promise<SignedDownload> {
      assertValidObjectKey(key);
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: DOWNLOAD_RESPONSE_CONTENT_DISPOSITION,
          ResponseContentType: DOWNLOAD_RESPONSE_CONTENT_TYPE,
        }),
        { expiresIn: DOWNLOAD_URL_TTL_SECONDS, signingDate: now },
      );
      return { url, expiresAt: new Date(now.getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000) };
    },
  };
}

// ---------------------------------------------------------------------------
// 신원 문서 버킷 — `id.atmark.ai` 의 did.json · passport.json · passport.jws (P6 PP-B)
// ---------------------------------------------------------------------------

/** 신원 문서 키 — `agents/{agentId 32hex}/{did.json|passport.json|passport.jws}`. ADR-0002 가 동결한 경로 그대로. */
export const IDENTITY_OBJECT_KEY = /^agents\/[0-9a-f]{32}\/(did\.json|passport\.json|passport\.jws)$/;

/** 공개 문서의 캐시 수명(초) — CloudFront·브라우저 공통. 상태 전이는 무효화가 즉시 반영한다(§4B.1b). */
export const IDENTITY_OBJECT_MAX_AGE_SECONDS = 300;

export interface S3IdentityDocumentWriterOptions {
  readonly client: S3ObjectClient;
  /** `identity-cdn-stack.ts` 의 `DidDocumentBucketName`. */
  readonly bucket: string;
  readonly expectedBucketOwner: string;
}

/** 신원 문서 쓰기 면 — 서명 Lambda(`src/passport/publisher.ts`)가 받는다. */
export interface IdentityDocumentWriter {
  put(key: string, body: string, contentType: string): Promise<void>;
}

/**
 * 신원 문서 쓰기. 메일 저장소(`createS3ObjectStore`)와 **규칙이 반대인 곳이 하나** 있다: **덮어쓴다**(`IfNoneMatch` 없음).
 * 같은 URL 이 언제나 최신 버전을 서빙해야 한다(재서명·정지·폐기 — §4B.1b). 과거 버전은 버킷 버저닝이 보관하고(`versioned: true`),
 * DB(`passport_documents`)에도 전부 남는다 — 삭제 경로는 여전히 없다(IAM 에 DeleteObject 없음).
 *
 * 키는 신원 문서 경로 셋만 받는다 — 이 면으로 버킷의 다른 경로(또는 메일 경로 모양)에 쓸 수 없다. SSE-S3(버킷 기본과 같게 명시).
 */
export function createS3IdentityDocumentWriter(options: S3IdentityDocumentWriterOptions): IdentityDocumentWriter {
  assertBucketTarget(options.bucket, options.expectedBucketOwner, '신원 문서 버킷 이름이 비어 있다');
  const { client, bucket, expectedBucketOwner } = options;
  return {
    async put(key: string, body: string, contentType: string): Promise<void> {
      if (!IDENTITY_OBJECT_KEY.test(key)) throw new Error(`신원 문서 경로가 아니다: ${key.slice(0, 80)}`);
      const bytes = Buffer.from(body, 'utf8');
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          ContentLength: bytes.length,
          CacheControl: `public, max-age=${String(IDENTITY_OBJECT_MAX_AGE_SECONDS)}`,
          ExpectedBucketOwner: expectedBucketOwner,
          ServerSideEncryption: 'AES256',
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 투명성 로그 공개 버킷 — `id.atmark.ai/log/*` (ADR-0008 · US-010)
// ---------------------------------------------------------------------------

/** 공개 로그 경로(`log/` 아래) — 체크포인트 · 이력 · 키 · C2SP 타일 · 앵커 영수증만. */
export const TLOG_OBJECT_KEY =
  /^log\/(checkpoint|key|checkpoints\/(0|[1-9][0-9]{0,11})|tile\/(entries|[0-9]{1,2})\/(x[0-9]{3}\/)*[0-9]{3}(\.p\/[0-9]{1,3})?|anchors\/ots\/(0|[1-9][0-9]{0,11})\/[a-z0-9.-]{1,253}\.ots|anchors\/rekor\/(0|[1-9][0-9]{0,11})\.json)$/;

export interface S3TransparencyLogWriterOptions {
  readonly client: S3ObjectClient;
  /** `transparency-stack.ts` 의 로그 버킷(Object Lock). */
  readonly bucket: string;
  readonly expectedBucketOwner: string;
}

/**
 * 공개 로그 쓰기. 버킷은 **Object Lock(보존 7년)** 이다 — 같은 키를 다시 쓰면 새 판이 생기고 옛 판은 보존 기간 동안 지워지지도
 * 덮이지도 않는다(`checkpoint` 는 매시 새 판). Object Lock 버킷의 PUT 은 무결성 체크섬이 필요하다 — SHA-256 을 명시한다.
 * 키는 로그 경로 모양만 받는다(`TLOG_OBJECT_KEY`) — 이 면으로 다른 경로에 쓸 수 없다. 삭제 경로 없음(IAM 에 DeleteObject 없음).
 */
export function createS3TransparencyLogWriter(options: S3TransparencyLogWriterOptions): {
  put(path: string, body: Buffer, contentType: string, cacheControl: string): Promise<void>;
} {
  assertBucketTarget(options.bucket, options.expectedBucketOwner, '투명성 로그 버킷 이름이 비어 있다');
  const { client, bucket, expectedBucketOwner } = options;
  return {
    async put(path: string, body: Buffer, contentType: string, cacheControl: string): Promise<void> {
      const key = `log/${path}`;
      if (!TLOG_OBJECT_KEY.test(key)) throw new Error(`투명성 로그 경로가 아니다: ${key.slice(0, 80)}`);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
          CacheControl: cacheControl,
          ChecksumAlgorithm: 'SHA256',
          ExpectedBucketOwner: expectedBucketOwner,
          ServerSideEncryption: 'AES256',
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 발신 첨부(메일 기본기 2차 A2) — 서명된 PUT · 머리 · 선두 바이트 · 복사 · GuardDuty 태그
// ---------------------------------------------------------------------------

/** 첨부 경로가 쓰는 S3 호출면 — 명령 다섯. */
export interface S3AttachmentClient {
  send(command: HeadObjectCommand): Promise<HeadObjectCommandOutput>;
  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  send(command: CopyObjectCommand): Promise<CopyObjectCommandOutput>;
  send(command: GetObjectTaggingCommand): Promise<GetObjectTaggingCommandOutput>;
}

/** 첨부 경로의 실제 S3 클라이언트(머리·범위 읽기·복사·태그). **이 함수를 부르는 순간 AWS 자격증명이 필요하다.** */
export function createS3AttachmentClient(region: string): S3AttachmentClient {
  return new S3Client({ region });
}

/**
 * 서명 전용 S3 클라이언트 — **`requestChecksumCalculation: 'WHEN_REQUIRED'`**. 기본값(`WHEN_SUPPORTED`)이면 SDK 가 서명에 자기 체크섬
 * 알고리즘(CRC32)을 끼워 넣어 우리가 고정한 `x-amz-checksum-sha256` 과 갈라진다(계획 §4 A2 presign 집행). 네트워크를 타지 않는다.
 */
export function createS3UploadSigningClient(region: string): S3Client {
  return new S3Client({ region, requestChecksumCalculation: 'WHEN_REQUIRED' });
}

/** 서명에 반드시 들어가는 헤더 넷 — 쿼리로 끌어올리지 않는다(`unhoistable`)는 것이 요점이다: 헤더로 보내야 S3 가 집행한다. */
export const UPLOAD_SIGNED_HEADERS = ['content-type', 'content-length', 'x-amz-checksum-sha256', 'if-none-match'] as const;

export interface S3OutboundAttachmentObjectsOptions {
  /** 서명 전용(`createS3UploadSigningClient`). 서명은 이 클라이언트의 자격증명으로 한다 — 운영은 발송 역할. */
  readonly signingClient: S3Client;
  readonly client: S3AttachmentClient;
  readonly bucket: string;
  readonly expectedBucketOwner: string;
}

/**
 * 운영 첨부 객체. 규칙:
 *   - **서명된 PUT** — `ContentType`·`ContentLength`·`ChecksumSHA256`·`IfNoneMatch:'*'` 넷을 서명한다. 크기가 다르면 S3 가 거부하고
 *     (서명 불일치), 바이트가 다르면 `BadDigest`, 두 번째 PUT 은 412 다(스캔이 끝난 객체를 바꿔치지 못한다). SSE 헤더는 싣지 않는다 —
 *     버킷 기본 암호화(SSE-S3)가 건다(헤더를 서명하면 클라이언트가 그 헤더도 보내야 한다).
 *   - **머리** — `ChecksumMode: 'ENABLED'` 로 저장된 SHA-256 을 받는다.
 *   - **복사** — `IfNoneMatch: '*'`(조건부 쓰기) · 태그는 옮기지 않는다(`TaggingDirective: 'REPLACE'` · 태그 없음 — 목적지에 태그 쓰기 권한이
 *     필요 없다) · 체크섬 알고리즘 SHA-256 유지 · `ExpectedBucketOwner`·`ExpectedSourceBucketOwner`.
 */
export function createS3OutboundAttachmentObjects(options: S3OutboundAttachmentObjectsOptions): OutboundAttachmentObjects {
  assertBucketTarget(options.bucket, options.expectedBucketOwner);
  const { signingClient, client, bucket, expectedBucketOwner } = options;
  return {
    kind: 's3',

    async signUpload(key: string, spec: UploadSpec, now: Date): Promise<SignedUpload> {
      assertOutboundAttachmentKey(key);
      if (!key.startsWith(OUTBOUND_UPLOADS_PREFIX)) throw new ObjectKeyFormatError(key, '업로드는 스테이징 접두사만');
      const url = await getSignedUrl(
        signingClient,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: spec.contentType,
          ContentLength: spec.contentLength,
          ChecksumSHA256: spec.sha256Base64,
          IfNoneMatch: '*',
        }),
        {
          expiresIn: UPLOAD_URL_TTL_SECONDS,
          signingDate: now,
          signableHeaders: new Set<string>(UPLOAD_SIGNED_HEADERS),
          unhoistableHeaders: new Set<string>(['x-amz-checksum-sha256', 'if-none-match']),
        },
      );
      return {
        method: 'PUT',
        url,
        headers: {
          'content-type': spec.contentType,
          'content-length': String(spec.contentLength),
          'x-amz-checksum-sha256': spec.sha256Base64,
          'if-none-match': '*',
        },
        expiresAt: new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000),
      };
    },

    async head(key: string): Promise<ObjectHead | null> {
      assertOutboundAttachmentKey(key);
      try {
        const output = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED', ExpectedBucketOwner: expectedBucketOwner }),
        );
        return { size: output.ContentLength ?? -1, sha256Base64: output.ChecksumSHA256 ?? null, etag: output.ETag ?? null };
      } catch (error) {
        if (errorName(error) === 'NotFound' || isNoSuchKey(error)) return null;
        throw error;
      }
    },

    async readPrefix(key: string, length: number): Promise<Uint8Array> {
      assertOutboundAttachmentKey(key);
      if (!Number.isSafeInteger(length) || length < 1) throw new RangeError(`length 는 1 이상 정수다: ${length}`);
      let output: GetObjectCommandOutput;
      try {
        output = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${String(length - 1)}`, ExpectedBucketOwner: expectedBucketOwner }),
        );
      } catch (error) {
        if (isNoSuchKey(error)) throw new ObjectNotFoundError(key);
        throw error;
      }
      if (output.Body === undefined) throw new ObjectNotFoundError(key);
      const bytes = await output.Body.transformToByteArray();
      return bytes.length > length ? bytes.subarray(0, length) : bytes;
    },

    get(key: string, maxBytes: number): Promise<Uint8Array> {
      assertOutboundAttachmentKey(key);
      return getObject(client, bucket, expectedBucketOwner, key, maxBytes);
    },

    async copyOnce(sourceKey: string, destinationKey: string, options: { readonly ifMatch?: string | null } = {}): Promise<'copied' | 'exists'> {
      assertOutboundAttachmentKey(sourceKey);
      assertOutboundAttachmentKey(destinationKey);
      try {
        await client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: destinationKey,
            CopySource: `${bucket}/${sourceKey}`,
            IfNoneMatch: '*',
            // 검사한 판만 옮긴다(보안 리뷰 L2) — 원본이 그 사이 바뀌면 412.
            ...(options.ifMatch === undefined || options.ifMatch === null ? {} : { CopySourceIfMatch: options.ifMatch }),
            TaggingDirective: 'REPLACE',
            ChecksumAlgorithm: 'SHA256',
            ServerSideEncryption: 'AES256',
            ExpectedBucketOwner: expectedBucketOwner,
            ExpectedSourceBucketOwner: expectedBucketOwner,
          }),
        );
        return 'copied';
      } catch (error) {
        if (isConditionalWriteRejected(error)) {
          // 412 는 둘 중 하나다 — 목적지가 이미 있다(IfNoneMatch) 또는 원본 판이 바뀌었다(CopySourceIfMatch). 목적지를 보고 가른다.
          try {
            await client.send(new HeadObjectCommand({ Bucket: bucket, Key: destinationKey, ExpectedBucketOwner: expectedBucketOwner }));
            return 'exists';
          } catch (headError) {
            if (errorName(headError) === 'NotFound' || httpStatus(headError) === 404) throw new ObjectChangedError(sourceKey);
            throw headError;
          }
        }
        if (isNoSuchKey(error)) throw new ObjectNotFoundError(sourceKey);
        throw error;
      }
    },
  };
}

/**
 * GuardDuty Malware Protection for S3 의 판정 읽기 — 객체 태그 `GuardDutyMalwareScanStatus`. 태그가 없으면 `PENDING`(스캔 중이거나 아직
 * 이벤트가 닿지 않았다), 모르는 값은 `FAILED`(좁은 쪽). 스테이징 접두사만 읽는다(보호 범위가 그 접두사다).
 */
export function createS3MalwareTagScanner(options: {
  readonly client: Pick<S3AttachmentClient, 'send'>;
  readonly bucket: string;
  readonly expectedBucketOwner: string;
}): AttachmentMalwareScanner {
  const { client, bucket, expectedBucketOwner } = options;
  return {
    kind: 'guardduty-tag',
    async status(key: string): Promise<MalwareScanStatus> {
      assertOutboundAttachmentKey(key);
      if (!key.startsWith(OUTBOUND_UPLOADS_PREFIX)) throw new ObjectKeyFormatError(key, '스캔 판정은 스테이징 접두사만');
      let output: GetObjectTaggingCommandOutput;
      try {
        output = await client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key, ExpectedBucketOwner: expectedBucketOwner }));
      } catch (error) {
        if (isNoSuchKey(error)) throw new ObjectNotFoundError(key);
        throw error;
      }
      return parseMalwareScanStatus((output.TagSet ?? []).find((tag) => tag.Key === MALWARE_SCAN_TAG_KEY)?.Value);
    },
  };
}
