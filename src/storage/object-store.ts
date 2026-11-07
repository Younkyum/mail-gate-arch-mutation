/**
 * src/storage/object-store.ts — 영속 객체 저장소 **포트**. 구현은 둘이다
 * (`s3-object-store.ts` 운영, `local-object-store.ts` 개발 전용).
 *
 * **왜 필요한가.** 발신 본문이 프로세스 메모리에 있으면(`createInMemoryContentStore`) 승인
 * 릴리스는 최초 시도와 **같은 프로세스**에서만 본문을 찾는다. 승인은 몇 시간 뒤에 오고
 * Lambda 에서 그 프로세스는 이미 없다. 그리고 수신 원문은 PRD 상 Postgres 에 들어갈 수 없다
 * (S3 키만). 두 요구가 같은 계층을 쓴다 — 이 포트 위에 어댑터가 둘 선다:
 *   - 발신 본문: `api/content-store.ts` 의 `createObjectContentStore` (messageId → JSON)
 *   - 수신 원문: `storage/raw-mail-store.ts` 의 `createRawMailStore` (키 → 바이트, 크기 상한)
 *
 * **포트가 바이트와 키만 아는 이유:** 본문의 모양(제목·text·html)과 원문의 모양(RFC 5322)은
 * 어댑터의 일이다. 포트가 그 모양을 알면 저장소 구현이 둘에서 넷이 된다.
 *
 * ---
 *
 * **쓰기는 한 번뿐이다 (write-once).** `putIfAbsent` 는 키가 이미 있으면 던진다.
 * 덮어쓰기 경로가 없는 것이 설계다 — 승인자가 본 본문과 릴리스가 보내는 본문이 같다는
 * 명제는 "그 사이에 본문을 바꿀 수 없다" 로만 성립한다(`approval_request_items` 가 수정
 * 불가인 것과 같은 성질을 본문 쪽에서 얻는다). 수신 원문도 증거물이므로 같다.
 *
 * **읽기는 크기 상한을 요구한다.** 상한 없는 `get` 은 "외부인이 보낸 40MB 가 메모리에
 * 통째로 올라온다" 를 기본값으로 만든다. 상한을 인자로 강제해 호출자가 매번 정하게 한다.
 *
 * ---
 *
 * ## 키 설계
 *
 * | 접두사 | 내용 | 키를 정하는 쪽 |
 * |---|---|---|
 * | `outbound/content/{messageId}.json` | 발신 본문 | 우리 (`messages.id` 에서 유도) |
 * | `inbound/raw/{sesMessageId}` | 수신 원문 | **SES receipt rule** (`ObjectKeyPrefix` + SES 메시지 ID) |
 * | `inbound/parsed/{sesMessageId}.json` | 수신 파싱 결과(본문 텍스트 포함) | 우리 (`inbound-consumer`, P3a) |
 * | `inbound/attachments/{sesMessageId}/{partIndex}` | 수신 첨부 바이트 | 우리 (`inbound-consumer`, P3a) — **파일명은 키가 아니다** |
 * | `outbound/scheduled/{scheduleId}.json` | 예약 발송 본문 | 우리 (`scheduled_sends.id` 에서 유도, P3c) |
 *
 * - **최상위 접두사 = 보존 단위.** 보존 기간(retention)이 정해지면 S3 수명주기 규칙을 이
 *   두 접두사에 **따로** 건다. 발신 본문과 수신 원문은 보존 근거가 다르다(전자는 승인 대기
 *   창 + 분쟁 대응, 후자는 증거·법적 요구).
 * - **에이전트별 접두사를 두지 않는다.** 전송단의 `load(messageId)` 는 messageId 하나로 키를
 *   유도해야 하고, SES 는 원문을 쓰는 시점에 수신 에이전트를 모른다(receipt rule 의 접두사는
 *   정적이다). 에이전트 단위 삭제는 접두사 나열이 아니라 **DB 의 행 → 키** 로 한다.
 * - **날짜 접두사를 두지 않는다.** S3 수명주기의 만료는 키의 날짜가 아니라 **객체 생성
 *   시각**으로 판정한다 — 날짜 접두사는 보존 규칙에 아무것도 보태지 않고, messageId 만으로
 *   키를 유도하는 성질만 잃는다.
 * - 두 접두사는 `infra/cdk/stacks/storage-stack.ts` 와 **같은 값이어야 한다**(SES 쓰기 권한의
 *   범위가 `inbound/raw/*` 다). 테스트가 두 값의 일치를 단언한다.
 */

import { isProductionEnvironment } from '../passport/custody';

/** 발신 본문 접두사 — 보존 단위 ①. */
export const OUTBOUND_CONTENT_PREFIX = 'outbound/content/';

/** 수신 원문 접두사 — 보존 단위 ②. SES receipt rule 의 `ObjectKeyPrefix` 와 같은 값. */
export const INBOUND_RAW_PREFIX = 'inbound/raw/';

/**
 * 수신 파싱 결과 접두사 (P3a). 본문 텍스트는 Postgres 에 들어갈 수 없으므로(PRD) 에이전트에게 돌려줄
 * 본문은 여기 JSON 으로 둔다. **SES 는 이 접두사에 쓰지 않는다** — 쓰는 것은 소비자뿐이다.
 * 원문에서 결정적으로 다시 만들 수 있는 파생물이지만, 파서 버전이 바뀌면 같은 원문이 다른 결과를
 * 낼 수 있으므로 "에이전트가 본 것" 의 기록으로서 write-once 로 둔다.
 */
export const INBOUND_PARSED_PREFIX = 'inbound/parsed/';

/** 수신 첨부 접두사 (P3a). 키 = `{sesMessageId}/{partIndex}` — 발신자가 정한 파일명은 키에 들어가지 않는다. */
export const INBOUND_ATTACHMENTS_PREFIX = 'inbound/attachments/';

/**
 * 예약 발송 본문 접두사 (P3c). 발송 시점까지 본문을 들고 있어야 하는데 Postgres 에는 본문이 들어가지 않는다
 * (`outbound/content/` 와 같은 규율). 키 = `{scheduled_sends.id}.json` — DB CHECK 가 같은 모양을 강제한다.
 * `outbound/content/` 와 따로 두는 이유: 그쪽은 `messages.id` 로 키를 유도하는 전송단의 계약이고, 예약 본문은
 * 발송 전에는 `messages` 행이 없다. 보존 단위도 다르다(발송되면 본문은 `outbound/content/` 에 다시 쓰인다).
 */
export const OUTBOUND_SCHEDULED_PREFIX = 'outbound/scheduled/';

/**
 * 발신 첨부 **스테이징** 접두사(메일 기본기 2차 A2). 에이전트가 서명된 PUT 으로 직접 올린다 — 키 = `{agentId}/{attachmentId}`
 * (`outbound_attachments.staging_key` CHECK 와 같은 모양). **GuardDuty Malware Protection for S3 의 보호 범위가 이 접두사다** —
 * 스캔 결과는 객체 태그 `GuardDutyMalwareScanStatus` 로 붙는다. 수명주기 2일(`storage-stack.ts`).
 */
export const OUTBOUND_UPLOADS_PREFIX = 'outbound/uploads/';

/**
 * 발신 첨부 **영구본** 접두사(A2). 발송 준비가 스캔을 통과한 스테이징 객체를 `{attachmentId}` 로 복사한다(write-once · 내용 주소 — 같은 첨부를
 * 여러 통이 써도 한 번만, 보안 리뷰 M2. 0130 시절 개발 DB 의 `{messageId}/{position}` 키도 읽기는 그대로 된다). 승인 릴리스는
 * 몇 시간 뒤 이 키를 읽는다 — 스테이징(2일)이 사라져도 승인자가 본 메일이 그대로 나간다. 수명주기 1년(발신 본문과 같은 보존).
 */
export const OUTBOUND_ATTACHMENTS_PREFIX = 'outbound/attachments/';

/**
 * 초안 본문 접두사(묶음 B — `drafts`, 202610081200). 키 = `{drafts.id}/{revision}.json` — DB CHECK 가 같은 모양을 강제한다. 고칠 때마다 새 판의 객체를
 * 쓴다(write-once — 옛 판은 덮이지 않는다). 보낼 때 그 판의 본문이 `outbound/content/` 에 다시 쓰인다. 지우지 않는다(수명주기 없음).
 */
export const OUTBOUND_DRAFTS_PREFIX = 'outbound/drafts/';

export interface ObjectStore {
  /** 어떤 구현인가. 데모 출력이 "무엇이 본문을 들고 있는가" 를 말할 수 있게 한다. */
  readonly kind: 's3' | 'local-dev';
  /** 키가 이미 있으면 `ObjectAlreadyExistsError`. 덮어쓰지 않는다. */
  putIfAbsent(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** 없으면 `ObjectNotFoundError`, `maxBytes` 초과면 `ObjectTooLargeError` — 본문을 다 읽기 **전에**. */
  get(key: string, maxBytes: number): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// 다운로드 URL — 수신 첨부 (P3c)
// ---------------------------------------------------------------------------

/**
 * 첨부 다운로드 URL 의 수명(초). **짧게** — URL 자체가 인증이다(누구든 그 URL 을 가진 사람은 받는다).
 * 에이전트는 받자마자 쓴다. 5분은 느린 네트워크에서 40MB 를 시작하기에 충분하고, 로그·프록시에 남은 URL 이
 * 쓸모를 잃기에 충분히 짧다.
 */
export const DOWNLOAD_URL_TTL_SECONDS = 300;

/**
 * 다운로드 응답에 **강제로** 거는 헤더 두 개. 호출자가 고르지 않는다 — 서명기 구현이 스스로 건다.
 *
 * 첨부 바이트와 선언된 Content-Type 은 **외부인이 정한 것**이다. `text/html` 로 서빙되면 우리(버킷) 도메인의
 * 저장형 XSS 이고, `inline` 이면 브라우저가 렌더한다. 저장 시에도 `application/octet-stream` 으로 썼지만
 * (`inbound-artifact-store.ts`), 저장 메타는 버킷 설정·복사 도구가 바꿀 수 있다 — **응답 시점에 한 번 더** 덮는다.
 * 파일명은 싣지 않는다(`attachment` 만): 파일명은 공격자 문자열이고 헤더 인코딩(RFC 6266) 실수 하나가 헤더
 * 주입이다. 에이전트는 파일명을 API 응답(JSON)에서 읽는다.
 */
export const DOWNLOAD_RESPONSE_CONTENT_DISPOSITION = 'attachment';
export const DOWNLOAD_RESPONSE_CONTENT_TYPE = 'application/octet-stream';

export interface SignedDownload {
  readonly url: string;
  readonly expiresAt: Date;
}

/**
 * 객체 하나의 **단기 서명 다운로드 URL** 을 만든다. 네트워크 호출이 아니다(서명은 로컬 계산).
 *
 * 포트를 `ObjectStore` 에 넣지 않은 이유: 읽기·쓰기 포트를 구현하는 가짜들(테스트)이 이 능력까지 흉내 낼
 * 이유가 없고, 이 능력을 쓰는 곳은 첨부 라우트 하나다. 구현은 둘 — S3 presigned GET(`s3-object-store.ts`),
 * 개발 전용 `file://`(`local-object-store.ts`). 두 구현 다 위 두 응답 헤더를 **스스로** 건다.
 */
export interface ObjectDownloadSigner {
  readonly kind: 's3' | 'local-dev';
  signDownload(key: string, now: Date): Promise<SignedDownload>;
}

// ---------------------------------------------------------------------------
// 발신 첨부 객체(메일 기본기 2차 A2) — 서명된 업로드 · 머리 · 스캔 판정 · 선두 바이트 · 복사
// ---------------------------------------------------------------------------

/** 서명된 업로드 URL 의 수명(초) — 15분. 업로드 **행**의 수명(2일)과 다르다: URL 이 새도 짧게 끝나고, 행은 발송을 기다린다. */
export const UPLOAD_URL_TTL_SECONDS = 900;

/** 업로드가 반드시 싣는 요청 헤더 넷 — 서명에 들어가므로 하나라도 빠지거나 다르면 S3 가 403(서명 불일치)이다. */
export interface UploadSpec {
  readonly contentType: string;
  readonly contentLength: number;
  /** SHA-256 의 base64(표준, 패딩 포함) — `x-amz-checksum-sha256`. 다른 바이트는 S3 가 `BadDigest` 로 거부한다. */
  readonly sha256Base64: string;
}

export interface SignedUpload {
  readonly method: 'PUT';
  readonly url: string;
  /** 클라이언트가 그대로 보낼 헤더(`content-type` · `content-length` · `x-amz-checksum-sha256` · `if-none-match: *`). */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

/** 객체 머리 — 크기와 저장된 SHA-256(업로드 때 서명 헤더로 강제한 값). 체크섬이 없으면 `null`(서명된 업로드가 아니다). */
export interface ObjectHead {
  readonly size: number;
  readonly sha256Base64: string | null;
  /** 객체 판(ETag) — 복사가 검사한 바로 그 판을 옮기게 결속한다(`copyOnce` 의 `ifMatch`, 보안 리뷰 L2). */
  readonly etag: string | null;
}

/** 복사 원본이 검사 뒤에 바뀌었다(`ifMatch` 불일치) — 검사하지 않은 바이트를 옮기지 않는다. */
export class ObjectChangedError extends Error {
  constructor(key: string) {
    super(`객체가 검사 뒤에 바뀌었다 (key=${key})`);
    this.name = 'ObjectChangedError';
  }
}

/**
 * 악성 코드 스캔 판정 — GuardDuty Malware Protection for S3 의 객체 태그 `GuardDutyMalwareScanStatus` 값 그대로(태그가 아직 없으면
 * `PENDING`). **통과는 `NO_THREATS_FOUND` 하나뿐이다**(fail-closed) — `UNSUPPORTED`(암호화 아카이브 등)·`ACCESS_DENIED`·`FAILED` 도 거부.
 */
export const MALWARE_SCAN_STATUSES = ['NO_THREATS_FOUND', 'THREATS_FOUND', 'UNSUPPORTED', 'ACCESS_DENIED', 'FAILED', 'PENDING'] as const;
export type MalwareScanStatus = (typeof MALWARE_SCAN_STATUSES)[number];

/** GuardDuty 가 붙이는 태그 키(AWS 고정값). */
export const MALWARE_SCAN_TAG_KEY = 'GuardDutyMalwareScanStatus';

/** 판정 값 해석 — 값이 없으면 `PENDING`, 모르는 값(그리고 명시적 `PENDING` 문자열)은 `FAILED`(좁은 쪽). 두 구현이 같은 규칙을 쓴다. */
export function parseMalwareScanStatus(value: string | undefined): MalwareScanStatus {
  if (value === undefined) return 'PENDING';
  return (MALWARE_SCAN_STATUSES as readonly string[]).includes(value) && value !== 'PENDING' ? (value as MalwareScanStatus) : 'FAILED';
}

/**
 * 스캔 판정 포트 — **갈아 끼울 수 있다**. 운영 구현은 GuardDuty 태그 읽기(`createS3MalwareTagScanner`)이고, 다른 스캐너(예: 자체 ClamAV
 * λ 가 같은 태그를 쓰는 방식)로 바꿔도 발송 준비 코드는 그대로다. 판정은 **객체 단위**이고 네트워크 호출이다.
 */
export interface AttachmentMalwareScanner {
  readonly kind: 'guardduty-tag' | 'local-dev';
  status(key: string): Promise<MalwareScanStatus>;
}

/** 발신 첨부 객체 포트 — 발송 준비(`api/outbound-attachments.ts`)와 업로드 생성이 받는다. 접두사 둘 밖의 키는 거부한다. */
export interface OutboundAttachmentObjects {
  readonly kind: 's3' | 'local-dev';
  /** 스테이징 키에 대한 서명된 PUT(네트워크 없음). */
  signUpload(key: string, spec: UploadSpec, now: Date): Promise<SignedUpload>;
  /** 없으면 `null`. */
  head(key: string): Promise<ObjectHead | null>;
  /** 선두 `length` 바이트(객체가 더 짧으면 전부). 매직 바이트 검사용. */
  readPrefix(key: string, length: number): Promise<Uint8Array>;
  /** 전부(상한 `maxBytes`). 릴리스·전송이 영구본을 읽는다 · `text/plain` 검사. */
  get(key: string, maxBytes: number): Promise<Uint8Array>;
  /**
   * 스테이징 → 영구 **한 번만** 복사한다. 목적지가 이미 있으면 `exists`(덮어쓰지 않는다 — 호출자가 머리를 대조한다). `ifMatch` 를 주면 원본의
   * 판(ETag)이 그 값일 때만 옮긴다 — 다르면 `ObjectChangedError`(검사한 판만 옮긴다, 보안 리뷰 L2).
   */
  copyOnce(sourceKey: string, destinationKey: string, options?: { readonly ifMatch?: string | null }): Promise<'copied' | 'exists'>;
}

/** 첨부 키 검증 — 두 접두사 중 하나 아래여야 한다. */
export function assertOutboundAttachmentKey(key: string): void {
  assertValidObjectKey(key);
  if (!key.startsWith(OUTBOUND_UPLOADS_PREFIX) && !key.startsWith(OUTBOUND_ATTACHMENTS_PREFIX)) {
    throw new ObjectKeyFormatError(key, '첨부 접두사 밖');
  }
}

export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`객체가 없다 (key=${key})`);
    this.name = 'ObjectNotFoundError';
  }
}

export class ObjectAlreadyExistsError extends Error {
  constructor(key: string) {
    super(`객체가 이미 있다 (key=${key}). 이 저장소는 덮어쓰지 않는다.`);
    this.name = 'ObjectAlreadyExistsError';
  }
}

export class ObjectTooLargeError extends Error {
  constructor(key: string, size: number | 'unknown', maxBytes: number) {
    super(`객체가 상한을 넘는다 (key=${key}, size=${size}, max=${maxBytes})`);
    this.name = 'ObjectTooLargeError';
  }
}

export class ObjectKeyFormatError extends Error {
  constructor(key: string, why: string) {
    super(`객체 키 형식 위반 (${why}): ${JSON.stringify(key)}`);
    this.name = 'ObjectKeyFormatError';
  }
}

/** 세그먼트 하나. **첫 글자는 영숫자** — `.`·`..`·숨김 파일·`-` 로 시작하는 이름이 여기서 끝난다. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._=-]*$/;
const MAX_KEY_LENGTH = 1024;

/**
 * 키 형식 검증 — 두 구현이 **입구에서** 부른다. fail closed.
 *
 * 로컬 구현에서 `../` 는 경로 탈출이고, S3 에서도 `a/../b` 는 보존 접두사를 흐리는 키다.
 * 허용 집합을 좁게 잡는다: 영숫자로 시작하는 세그먼트를 `/` 로 이은 것뿐. 빈 세그먼트
 * (`a//b`, 선행 `/`, 후행 `/`)·역슬래시·제어 문자는 전부 거부된다.
 */
export function assertValidObjectKey(key: string): void {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) throw new ObjectKeyFormatError(key, '길이');
  for (const segment of key.split('/')) {
    if (!SEGMENT.test(segment)) throw new ObjectKeyFormatError(key, `세그먼트 ${JSON.stringify(segment)}`);
  }
}

/** 음이 아닌 정수 상한만 받는다 — `NaN`·`Infinity` 는 "상한 없음" 으로 읽히는 값이다. */
export function assertValidMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes 는 음이 아닌 정수여야 한다: ${maxBytes}`);
  }
}

// ---------------------------------------------------------------------------
// 운영 가드 — 개발 전용 구현(`local-object-store.ts`)의 진입점
// ---------------------------------------------------------------------------

/** 운영 환경에서 개발 전용 저장소가 선택됨. **복구하지 말고 죽어야 한다.** */
export class ProductionStorageGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionStorageGuardError';
  }
}

/**
 * **운영이면 던진다.** 운영 판정은 `passport/custody.ts` 의 `isProductionEnvironment` 하나를
 * 쓴다 — 판정이 둘이면 둘이 갈라진 날 느슨한 쪽이 이긴다(`ATMARK_ENV` 우선, `NODE_ENV` 폴백).
 *
 * 로컬 파일시스템이 운영에서 선택되면 Lambda 의 `/tmp` 에 본문이 쓰이고, 그 본문은
 * 인스턴스와 함께 사라진다 — **승인 릴리스가 조용히 전부 `failed` 가 되는** 형태의 사고다.
 */
export function assertNotProduction(what: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isProductionEnvironment(env)) return;
  throw new ProductionStorageGuardError(
    `${what} 은(는) 개발 전용이다. 운영에서는 createS3ObjectStore 를 써라. ` +
      '로컬 디스크로 조용히 떨어지는 폴백은 존재하지 않는다.',
  );
}
