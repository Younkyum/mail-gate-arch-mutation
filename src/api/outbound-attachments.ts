/**
 * src/api/outbound-attachments.ts — **발신 첨부**의 앞단(메일 기본기 2차 A2, 진윤겸 결정 D8 · ADR-0013 2차 절). 관문 **밖**이다 —
 * 관문(Stage 6)에는 메타(파일명 · MIME · 크기)만 들어간다(원칙 R10: 관문에 바이트가 들어가지 않는다).
 *
 * 흐름: 업로드 생성(`POST /v1/attachments`) → 에이전트가 서명된 PUT 으로 스테이징에 올림 → GuardDuty 가 태그로 판정 → 발송(`send`·`reply` 의
 * `attachments`)이 **검증** → 메시지 행 INSERT → 스테이징 → 영구 **복사**·결속 → 본문 객체에 영구 키 → 관문 Stage 6(총량 `min(정책, 요금제,
 * 천장 25 MiB)` · MIME 허용목록) → 전송단이 영구본을 읽어 체크섬 대조 뒤 `multipart/mixed` 로 조립.
 *
 * 검증(발송 준비, 관문 앞) — 첨부마다 동시성 5, S3 호출마다 3초, 전체 예산 12초(api λ 타임아웃 25초 안):
 *   ① 소유·만료(행 — 남의 id·없는 id 는 404 `attachment_not_found`, 만료는 409 `attachment_expired`)
 *   ② 머리(크기 = 선언 · SHA-256 = 선언 — 올리지 않았으면 409 `attachment_not_uploaded`, 다르면 400 `attachment_integrity_mismatch`)
 *   ③ 스캔(`NO_THREATS_FOUND` 만 — 아직이면 409 `attachment_scan_pending`, 위협 400 `attachment_malicious`, 판정 불가 400 `attachment_scan_failed`)
 *   ④ 내용 모양(선두 4 KiB 매직 — pdf `%PDF-` · png 시그니처 · jpeg `FF D8 FF`; `text/plain` 은 ≤ 1 MiB 전체가 UTF-8 이고 NUL 없음 —
 *      어긋나면 400 `attachment_content_mismatch`)
 * 총량은 여기서 막지 않는다 — Stage 6 이 판정해 audit 에 `attachment_bytes_exceeded` 로 남긴다(AC-A2-5). 업로드 생성은 파일 하나가 요금제
 * 총량을 넘으면 빠르게 400 이다(어차피 못 나간다).
 *
 * 로그·오류에 파일명·키·URL 을 싣지 않는다(코드와 자리 번호만).
 */

import { createHash, randomUUID } from 'node:crypto';

import { ENTITLEMENT_CEILINGS, MIB } from '../billing/plans';
import type { Queryable } from '../db/client';
import { loadAgentEntitlements } from '../db/repositories/entitlements';
import { BILLING_STATUSES_BLOCKING_OUTBOUND } from '../db/schema';
import { ATTACHMENT_BYTES_TOTAL_CEILING, resolveContentPolicy } from '../policy/policy-loader';
import { rolloutAllows, type FeatureRollout } from '../runtime/feature-rollout';
import type {
  MessageAttachmentLink,
  MessageAttachmentMeta,
  OutboundAttachmentRow,
  OutboundAttachmentStore,
} from '../db/repositories/outbound-attachment-store';
import { MAX_LINKS_PER_ATTACHMENT } from '../db/repositories/outbound-attachment-store';
import {
  ObjectNotFoundError,
  OUTBOUND_ATTACHMENTS_PREFIX,
  OUTBOUND_UPLOADS_PREFIX,
  type AttachmentMalwareScanner,
  type MalwareScanStatus,
  type OutboundAttachmentObjects,
  type SignedUpload,
} from '../storage/object-store';

/** 에이전트 → 조직 id(발신 첨부 단계 공개의 허용목록 판정 — `enabledFor`). 없는 에이전트는 `null`. */
export async function loadAgentOrganizationId(db: Queryable, agentId: string): Promise<string | null> {
  const result = await db.query<{ organization_id: string }>('SELECT organization_id FROM agents WHERE id = $1', [agentId]);
  return result.rows[0]?.organization_id ?? null;
}

/** 한 메일의 첨부 총량 천장 — `ENTITLEMENT_CEILINGS.attachmentBytesTotalMax`(25 MiB) · 정책 로더의 `min()` 천장과 같다. */
export const ATTACHMENT_BYTES_CEILING = ENTITLEMENT_CEILINGS.attachmentBytesTotalMax;
/** 한 메일의 첨부 개수(자리 0~9 — DB CHECK). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** `text/plain` 한 파일 상한(DB CHECK 와 같다) — 전체를 읽어 UTF-8·NUL 을 본다. */
const TEXT_PLAIN_MAX_BYTES = 1 * MIB;
/** 서명표 — 이 밖의 MIME 은 업로드 생성부터 400(fail-closed). DB CHECK 와 같다. */
export const ATTACHMENT_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'] as const;
export type AttachmentMimeType = (typeof ATTACHMENT_MIME_TYPES)[number];
/** 파일명 상한(코드포인트) — DB CHECK 와 같다. */
const ATTACHMENT_FILENAME_MAX_LENGTH = 255;
/** 매직 바이트로 읽는 선두 길이. */
const MAGIC_PREFIX_BYTES = 4096;
const PREPARE_CONCURRENCY = 5;
const S3_CALL_TIMEOUT_MS = 3000;
/**
 * 검증 전체 예산 — 계획은 25초였지만 api λ 타임아웃(`API_TIMEOUT_SECONDS`)이 25초라 그 안에 관문·전송이 더 들어가야 한다. 12초로 줄였다
 * (첨부 10개 p99 목표 5초 · AC-A2-9). 넘으면 503 `attachment_check_timeout` — 같은 멱등 키로 다시 부르면 된다.
 */
const PREPARE_BUDGET_MS = 12_000;

const MAGIC: Readonly<Record<Exclude<AttachmentMimeType, 'text/plain'>, readonly number[]>> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

/** 파일명에 허용하지 않는 것 — 제어문자 · 경로 구분자 · 줄/문단 구분자 · 양방향 제어(파일명으로 확장자를 뒤집어 보이게 하는 흔한 속임수). */
const FILENAME_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}/\\‪-‮⁦-⁩‎‏]/u;

export function isAttachmentMimeType(value: unknown): value is AttachmentMimeType {
  return typeof value === 'string' && (ATTACHMENT_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * 선언 MIME ↔ 파일명 확장자(보안 리뷰 M1). 받는 쪽 메일 클라이언트는 **파일명의 확장자**로 여는 앱을 고른다 — `invoice.pdf.exe` 류나 `photo.html`
 * 을 png 로 선언해 스캔·매직 검사를 지난 뒤 다른 앱으로 열리게 하지 못한다. DB CHECK(202609270131)와 같은 표.
 */
export const ATTACHMENT_EXTENSIONS: Readonly<Record<AttachmentMimeType, readonly string[]>> = {
  'application/pdf': ['.pdf'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'text/plain': ['.txt'],
};

/** RFC 2047 encoded-word(`=?charset?B|Q?…?=`) — 받는 쪽이 파일명을 다시 풀어 다른 이름(확장자)으로 보이게 하는 길(보안 리뷰 M1). */
const ENCODED_WORD = /=\?[^?]*\?[bq]\?/i;

export type FilenameCheck = { readonly ok: true; readonly filename: string } | { readonly ok: false; readonly code: string; readonly detail: string };

/**
 * 파일명 정규화 — 모양(`isValidAttachmentFilename`) · encoded-word 금지 · 확장자 = 선언 MIME 의 것. **확장자가 없으면(점이 없으면) 서버가 붙인다**
 * (`report` → `report.pdf`). 다른 확장자가 있으면 400(`report.v2` 도 — 이름을 바꿔 올린다).
 */
export function normalizeAttachmentFilename(filename: string, mimeType: AttachmentMimeType): FilenameCheck {
  if (!isValidAttachmentFilename(filename)) {
    return { ok: false, code: 'invalid_request', detail: 'filename must be 1 to 255 characters with no control characters, path separators, or leading or trailing spaces.' };
  }
  if (ENCODED_WORD.test(filename)) return { ok: false, code: 'attachment_filename_invalid', detail: 'filename must not contain MIME encoded words (=?…?=).' };
  const lower = filename.toLowerCase();
  const allowed = ATTACHMENT_EXTENSIONS[mimeType];
  if (allowed.some((extension) => lower.endsWith(extension) && lower.length > extension.length)) return { ok: true, filename };
  if (!filename.includes('.')) {
    const withExtension = `${filename}${allowed[0] ?? ''}`;
    return isValidAttachmentFilename(withExtension) ? { ok: true, filename: withExtension } : { ok: false, code: 'invalid_request', detail: 'filename is too long.' };
  }
  return {
    ok: false,
    code: 'attachment_filename_extension_mismatch',
    detail: `The filename extension must match mime_type (${mimeType}): ${allowed.join(', ')}.`,
  };
}

function isValidAttachmentFilename(value: string): boolean {
  const length = [...value].length;
  return length >= 1 && length <= ATTACHMENT_FILENAME_MAX_LENGTH && value.trim() === value && !/^\.+$/.test(value) && !FILENAME_FORBIDDEN.test(value);
}

/** 스테이징 키 — DB CHECK `outbound_attachments_staging_key_check` 와 같은 모양. */
export function stagingKeyFor(agentId: string, attachmentId: string): string {
  return `${OUTBOUND_UPLOADS_PREFIX}${agentId}/${attachmentId}`;
}

/**
 * 영구 키 — **첨부 id 단위**(content-addressed, 보안 리뷰 M2). 한 첨부는 한 번만 복사되고 여러 메일(≤ `MAX_LINKS_PER_ATTACHMENT`)이 참조한다 —
 * 같은 첨부를 메일마다 다시 복사해 저장소를 불리지 못한다. DB CHECK(202609270131)와 같은 모양.
 */
export function permanentKeyFor(attachmentId: string): string {
  return `${OUTBOUND_ATTACHMENTS_PREFIX}${attachmentId}`;
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

/** 앞단이 멈춘 이유 — 라우트가 HTTP 로 옮긴다. */
export interface AttachmentRejection {
  readonly status: 400 | 403 | 404 | 409 | 429 | 503;
  readonly code: string;
  readonly detail: string;
}

export interface OutboundAttachmentService {
  /**
   * 단계 공개(`ATMARK_OUTBOUND_ATTACHMENTS_ENABLED` — `false` · `true` · `orgs:<uuid>,…`). 닫힌 조직은 업로드 404 · 발송의 `attachments` 400
   * (꺼짐과 같은 모양). **릴리스·전송은 스위치와 무관하다** — 이미 결속된 첨부(승인 대기)는 조직이 목록에서 빠져도 승인되면 나간다(소유자가 본
   * 그 내용이다). 멈추려면 승인을 거절하거나 킬 스위치다(런북 deploy §23-5).
   */
  readonly rollout: FeatureRollout;
  /** 이 에이전트의 조직에 열려 있나 — 허용목록 모드에서만 DB 를 본다(에이전트 → 조직). 모르는 에이전트는 닫힘. */
  enabledFor(agentId: string): Promise<boolean>;
  createUpload(input: CreateUploadInput, now: Date): Promise<CreateUploadOutcome>;
  /** 관문 앞 검증 — 순서는 요청의 순서(= 자리). */
  validate(agentId: string, ids: readonly string[], now: Date): Promise<ValidatedAttachments | AttachmentRejection>;
  /** 메시지 행이 생긴 뒤 — 영구 복사 + 결속. 이미 있는 영구본(이어받은 시도)은 머리로 대조한다. */
  persist(messageId: string, validated: ValidatedAttachments): Promise<readonly PersistedAttachment[]>;
  /** 승인 릴리스의 Stage 6 메타(자리 순). */
  metaForMessage(messageId: string): Promise<readonly MessageAttachmentMeta[]>;
}

export interface CreateUploadInput {
  readonly agentId: string;
  readonly filename: string;
  readonly mimeType: AttachmentMimeType;
  readonly bytes: number;
  /** hex 소문자 64. */
  readonly sha256: string;
  /** 선택 `Idempotency-Key`(묶음 B) — 같은 키 + 같은 요청 → 같은 첨부(`replayed`), 다른 요청 → 409 `idempotency_key_reused`. */
  readonly idempotencyKey?: string;
}

/** 업로드 생성 요청의 해시 — 같은 키의 재호출이 같은 요청인가(파일명은 정규화 **전** 값 · MIME · 크기 · SHA-256). */
function hashUploadRequest(input: Pick<CreateUploadInput, 'filename' | 'mimeType' | 'bytes' | 'sha256'>): string {
  return createHash('sha256')
    .update(JSON.stringify({ filename: input.filename, mimeType: input.mimeType, bytes: input.bytes, sha256: input.sha256 }), 'utf8')
    .digest('hex');
}

export type CreateUploadOutcome =
  | { readonly kind: 'created' | 'replayed'; readonly row: OutboundAttachmentRow; readonly upload: SignedUpload }
  | AttachmentRejection;

export interface ValidatedAttachments {
  readonly rows: readonly OutboundAttachmentRow[];
  /** 검사한 스테이징 객체의 판(ETag) — 자리 순. 복사가 이 판에 결속된다(보안 리뷰 L2). */
  readonly etags: readonly (string | null)[];
  /**
   * `text/plain` 첨부의 텍스트(UTF-8 로 검사한 바로 그 바이트) — 자리 순, 다른 종류는 `null`. 발신 DLP(ADR-0016 M1 배선 계약 1)가 본다. 없으면(옛 대역)
   * DLP 는 text/* 첨부를 "읽지 못함" 으로 읽는다(`scan_limit`).
   */
  readonly texts?: readonly (string | null)[];
}

/** 이 에이전트의 메일 한 통 첨부 한도 — Stage 6 과 같은 `min(정책, 요금제, 천장)` · 정책 MIME 허용목록(보안 리뷰 M2 — 복사 전에 본다). */
export interface AttachmentLimits {
  readonly maxBytesTotal: number;
  readonly allowedMimeTypes: readonly string[];
}

/** 본문 객체(`content-store`)에 실리는 영구본 참조. */
export interface PersistedAttachment {
  readonly position: number;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly key: string;
}

export interface OutboundAttachmentServiceDependencies {
  /** 단계 공개 값(`readFeatureRollout`). 불리언이면 모든 조직이 같다. */
  readonly enabled: FeatureRollout;
  /** 에이전트 → 조직 id(허용목록 모드에서만 부른다). 없으면 허용목록 모드는 닫힌다(fail closed). */
  readonly organizationOf?: (agentId: string) => Promise<string | null>;
  readonly store: OutboundAttachmentStore;
  readonly objects: OutboundAttachmentObjects;
  readonly scanner: AttachmentMalwareScanner;
  /** 메일 한 통 첨부 한도(`loadAttachmentLimits`) — 업로드 생성의 빠른 실패 · 복사 전 총량·MIME 판정. */
  readonly limitsFor: (agentId: string, now: Date) => Promise<AttachmentLimits>;
  /** 테스트가 시간 예산을 줄인다. */
  readonly budgetMs?: number;
  readonly callTimeoutMs?: number;
}

function reject(status: AttachmentRejection['status'], code: string, detail: string): AttachmentRejection {
  return { status, code, detail };
}

/**
 * 409 `attachment_link_limit` — 선검사(`validate`)와 DB 결속 천장 트리거(동시 발송 경합 — 보안 리뷰 N1, `outbound-service.proceed`)가 **같은**
 * 오류를 낸다. 자리를 모르면(트리거 문구에 id 가 없다) 자리 없이.
 */
export function linkLimitRejection(index: number | null): AttachmentRejection {
  const where = index === null ? 'An attachment' : `attachments[${String(index)}]`;
  return reject(409, 'attachment_link_limit', `${where} has already been used in ${String(MAX_LINKS_PER_ATTACHMENT)} emails. Upload it again.`);
}

export function isAttachmentRejection(value: unknown): value is AttachmentRejection {
  return typeof value === 'object' && value !== null && 'status' in value && 'code' in value && !('kind' in value);
}

class CallTimeoutError extends Error {
  constructor() {
    super('attachment S3 call timed out');
    this.name = 'CallTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_resolve, rejectPromise) => {
      timer = setTimeout(() => rejectPromise(new CallTimeoutError()), ms);
    }),
  ]);
}

/** 동시성 상한 `limit` 로 차례대로 — 결과는 입력 순서. 하나라도 거부면 그 거부(자리가 가장 앞선 것). */
async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 선두 바이트가 선언 MIME 의 시그니처로 시작하는가. `text/plain` 은 따로(`isPlainText`). */
export function magicMatches(mimeType: AttachmentMimeType, prefix: Uint8Array): boolean {
  if (mimeType === 'text/plain') return true;
  const signature = MAGIC[mimeType];
  return prefix.length >= signature.length && signature.every((byte, index) => prefix[index] === byte);
}

/** 전체가 UTF-8 이고 NUL 이 없다. */
export function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function createOutboundAttachmentService(deps: OutboundAttachmentServiceDependencies): OutboundAttachmentService {
  const callTimeout = deps.callTimeoutMs ?? S3_CALL_TIMEOUT_MS;
  const budget = deps.budgetMs ?? PREPARE_BUDGET_MS;
  const call = <T>(promise: Promise<T>): Promise<T> => withTimeout(promise, callTimeout);

  /**
   * 하나 검사 — **스캔 판정을 먼저** 본다(보안 리뷰 L1: 발송 역할의 스테이징 GetObject 는 `NO_THREATS_FOUND` 태그 조건이 있어 판정 전 객체를 읽지
   * 못한다). 그다음 머리(크기 · 체크섬 · 판) → 내용 모양. 판(ETag)을 돌려준다 — 복사가 그 판에 결속된다.
   */
  async function checkOne(
    row: OutboundAttachmentRow,
    index: number,
    now: Date,
  ): Promise<AttachmentRejection | { readonly etag: string | null; readonly text: string | null }> {
    const where = `attachments[${String(index)}]`;
    if (row.expiresAt.getTime() <= now.getTime()) return reject(409, 'attachment_expired', `${where} has expired (2 days after upload). Upload it again.`);
    let scan: MalwareScanStatus;
    try {
      scan = await call(deps.scanner.status(row.stagingKey));
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        return reject(409, 'attachment_not_uploaded', `${where} has not been uploaded yet. PUT the file to its upload URL, then send again.`);
      }
      throw error;
    }
    if (scan === 'PENDING') return reject(409, 'attachment_scan_pending', `${where} is still being scanned for malware. Send the same request again shortly.`);
    if (scan === 'THREATS_FOUND') return reject(400, 'attachment_malicious', `Malware was found in ${where}.`);
    if (scan !== 'NO_THREATS_FOUND') return reject(400, 'attachment_scan_failed', `${where} could not be scanned for malware.`);
    const head = await call(deps.objects.head(row.stagingKey));
    if (head === null) return reject(409, 'attachment_not_uploaded', `${where} has not been uploaded yet. PUT the file to its upload URL, then send again.`);
    // 체크섬이 없으면(서명된 업로드가 아니다) 선언과 대조할 수 없다 — 불일치로 본다(보안 리뷰 L2).
    if (head.size !== row.bytes || head.sha256Base64 === null || head.sha256Base64 !== hexToBase64(row.sha256)) {
      return reject(400, 'attachment_integrity_mismatch', `The size or checksum of ${where} does not match what was declared.`);
    }
    const mimeType = row.mimeType as AttachmentMimeType;
    if (mimeType === 'text/plain') {
      const bytes = row.bytes > TEXT_PLAIN_MAX_BYTES ? null : await call(deps.objects.get(row.stagingKey, TEXT_PLAIN_MAX_BYTES));
      if (bytes === null || !isPlainText(bytes)) {
        return reject(400, 'attachment_content_mismatch', `${where} is not plain text (UTF-8 with no NUL bytes).`);
      }
      // 발신 DLP(ADR-0016)가 같은 바이트를 본다 — 검사한 판(ETag)만 복사되므로 나가는 것도 이 텍스트다.
      return { etag: head.etag, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    }
    if (!magicMatches(mimeType, await call(deps.objects.readPrefix(row.stagingKey, MAGIC_PREFIX_BYTES)))) {
      return reject(400, 'attachment_content_mismatch', `The content of ${where} is not the declared type (${mimeType}).`);
    }
    return { etag: head.etag, text: null };
  }

  return {
    rollout: deps.enabled,

    async enabledFor(agentId: string): Promise<boolean> {
      if (typeof deps.enabled === 'boolean') return deps.enabled;
      if (deps.organizationOf === undefined) return false;
      return rolloutAllows(deps.enabled, await deps.organizationOf(agentId));
    },

    async createUpload(input: CreateUploadInput, now: Date): Promise<CreateUploadOutcome> {
      // 보안 리뷰 L3 — 발송이 막힌 에이전트·조직은 업로드도 못 한다(Stage 0 과 같은 칸 — 스캔·저장 비용을 쓰지 않게).
      const state = await deps.store.sendingState(input.agentId);
      if (state === null) return reject(404, 'agent_not_found', 'Agent not found.');
      if (state.agentStatus !== 'active') return reject(403, 'agent_not_active', 'This agent cannot send right now (stopped or inactive).');
      if (
        state.abuseFreeze ||
        state.ownerPaused ||
        state.reviewStatus !== 'active' ||
        (BILLING_STATUSES_BLOCKING_OUTBOUND as readonly string[]).includes(state.billingStatus)
      ) {
        return reject(403, 'organization_not_sending', 'Sending is blocked for this organization right now (pending review, emergency stop, account hold, or billing).');
      }
      const filename = normalizeAttachmentFilename(input.filename, input.mimeType);
      if (!filename.ok) return reject(400, filename.code, filename.detail);
      const limits = await deps.limitsFor(input.agentId, now);
      const limit = Math.min(limits.maxBytesTotal, ATTACHMENT_BYTES_CEILING);
      if (input.bytes > limit) {
        return reject(400, 'attachment_too_large', `The attachment is larger than this agent's per-email attachment limit (${String(Math.floor(limit / MIB))} MB).`);
      }
      if (input.mimeType === 'text/plain' && input.bytes > TEXT_PLAIN_MAX_BYTES) {
        return reject(400, 'attachment_too_large', 'text/plain attachments must be 1 MB or smaller.');
      }
      const id = randomUUID();
      const stagingKey = stagingKeyFor(input.agentId, id);
      const { idempotencyKey, ...uploadInput } = input;
      const inserted = await deps.store.insertUpload({
        id,
        stagingKey,
        now,
        ...uploadInput,
        filename: filename.filename,
        ...(idempotencyKey === undefined ? {} : { idempotency: { key: idempotencyKey, requestHash: hashUploadRequest(input) } }),
      });
      if (inserted.kind === 'idempotency_conflict') {
        return reject(409, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different attachment upload. Use a new key.');
      }
      if (inserted.kind === 'replayed') {
        // 같은 요청의 재호출 — 같은 첨부 id 에 업로드 URL 을 새로 서명한다(서명은 로컬 계산 · 15분). 만료된 첨부는 되살리지 않는다.
        if (inserted.row.expiresAt.getTime() <= now.getTime()) {
          return reject(409, 'attachment_expired', 'The attachment created with this Idempotency-Key has expired (2 days after creation). Use a new key.');
        }
        const resigned = await deps.objects.signUpload(
          inserted.row.stagingKey,
          { contentType: inserted.row.mimeType, contentLength: inserted.row.bytes, sha256Base64: hexToBase64(inserted.row.sha256) },
          now,
        );
        return { kind: 'replayed', row: inserted.row, upload: resigned };
      }
      if (inserted.kind === 'daily_limit') {
        return reject(429, 'attachment_daily_limit', 'This agent reached its daily attachment upload limit (100 files or 200 MB per 24 hours).');
      }
      if (inserted.kind === 'org_daily_limit') {
        return reject(429, 'attachment_org_daily_limit', 'This organization reached its daily attachment upload limit (1 GB per 24 hours).');
      }
      const upload = await deps.objects.signUpload(
        stagingKey,
        { contentType: input.mimeType, contentLength: input.bytes, sha256Base64: hexToBase64(input.sha256) },
        now,
      );
      return { kind: 'created', row: inserted.row, upload };
    },

    async validate(agentId: string, ids: readonly string[], now: Date): Promise<ValidatedAttachments | AttachmentRejection> {
      if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) return reject(400, 'invalid_request', `attachments can list at most ${String(MAX_ATTACHMENTS_PER_MESSAGE)} ids.`);
      if (new Set(ids).size !== ids.length) return reject(400, 'invalid_request', 'attachments lists the same id twice.');
      const found = await deps.store.findForAgent(agentId, ids);
      const byId = new Map(found.map((row) => [row.id, row]));
      const rows: OutboundAttachmentRow[] = [];
      for (const [index, id] of ids.entries()) {
        const row = byId.get(id);
        if (row === undefined) return reject(404, 'attachment_not_found', `attachments[${String(index)}] was not found for this agent.`);
        rows.push(row);
      }
      // 보안 리뷰 M2 — **복사 전에** 총량·MIME 을 Stage 6 과 같은 한도로 본다(관문 전 복사가 저장소를 불리지 못하게). 관문 Stage 6 은 그대로
      // 한 번 더 본다(승인 대기 중 강등 등).
      const limits = await deps.limitsFor(agentId, now);
      const total = rows.reduce((sum, row) => sum + row.bytes, 0);
      if (total > Math.min(limits.maxBytesTotal, ATTACHMENT_BYTES_CEILING)) {
        return reject(400, 'attachment_bytes_exceeded', `The attachments are larger in total than the per-email limit (${String(Math.floor(Math.min(limits.maxBytesTotal, ATTACHMENT_BYTES_CEILING) / MIB))} MB).`);
      }
      const disallowed = rows.findIndex((row) => !limits.allowedMimeTypes.includes(row.mimeType));
      if (disallowed >= 0) return reject(400, 'attachment_type_not_allowed', `This agent's policy does not allow the file type of attachments[${String(disallowed)}].`);
      const links = await deps.store.linkCounts(ids);
      const saturated = ids.findIndex((id) => (links.get(id) ?? 0) >= MAX_LINKS_PER_ATTACHMENT);
      if (saturated >= 0) return linkLimitRejection(saturated);
      const deadline = Date.now() + budget;
      let checked: (AttachmentRejection | { readonly etag: string | null; readonly text: string | null })[];
      try {
        checked = await withTimeout(
          mapLimited(rows, PREPARE_CONCURRENCY, (row, index) => checkOne(row, index, now)),
          Math.max(1, deadline - Date.now()),
        );
      } catch (error) {
        if (error instanceof CallTimeoutError) return reject(503, 'attachment_check_timeout', 'Checking the attachments took too long. Send again with the same Idempotency-Key.');
        throw error;
      }
      const first = checked.find((item): item is AttachmentRejection => isAttachmentRejection(item));
      if (first !== undefined) return first;
      return {
        rows,
        etags: checked.map((item) => ('etag' in item ? item.etag : null)),
        texts: checked.map((item) => ('text' in item ? item.text : null)),
      };
    },

    async persist(messageId: string, validated: ValidatedAttachments): Promise<readonly PersistedAttachment[]> {
      const persisted = await mapLimited(validated.rows, PREPARE_CONCURRENCY, async (row, position) => {
        const key = permanentKeyFor(row.id);
        // 검사한 판만 옮긴다(보안 리뷰 L2). 영구본이 이미 있으면(같은 첨부의 앞선 메일 · 이어받은 시도) 머리로 대조한다.
        const copied = await call(deps.objects.copyOnce(row.stagingKey, key, { ifMatch: validated.etags[position] ?? null }));
        const head = await call(deps.objects.head(key));
        // 체크섬이 없으면 대조할 수 없다 — 보내지 않는다(보안 리뷰 L2: null 을 통과로 읽지 않는다).
        if (head === null || head.size !== row.bytes || head.sha256Base64 === null || head.sha256Base64 !== hexToBase64(row.sha256)) {
          throw new Error(`첨부 영구본이 선언과 다르다 (message=${messageId}, position=${String(position)}, ${copied})`);
        }
        return { position, filename: row.filename, mimeType: row.mimeType, bytes: row.bytes, sha256: row.sha256, key };
      });
      const links: MessageAttachmentLink[] = persisted.map((item, position) => ({
        position,
        attachmentId: validated.rows[position]?.id ?? '',
        permanentKey: item.key,
      }));
      await deps.store.linkToMessage(messageId, links);
      return persisted;
    },

    metaForMessage(messageId: string): Promise<readonly MessageAttachmentMeta[]> {
      return deps.store.metaForMessage(messageId);
    },
  };
}

/**
 * 메일 한 통 첨부 한도 — `min(정책 max_attachment_bytes_total(null = 천장), 요금제, 천장)` · 정책 MIME 허용목록. 관문 Stage 6(`policy-loader`)과
 * **같은 해석**이다(정책 로더의 `resolveContentPolicy` 를 그대로 쓴다). 정책·에이전트가 없으면 0(좁은 쪽).
 */
export async function loadAttachmentLimits(db: Queryable, agentId: string, now: Date): Promise<AttachmentLimits> {
  const policy = await db.query<{ config_json: Record<string, unknown> }>('SELECT config_json FROM agent_policies WHERE agent_id = $1', [agentId]);
  const config = policy.rows[0]?.config_json;
  if (config === undefined) return { maxBytesTotal: 0, allowedMimeTypes: [] };
  let content: { maxAttachmentBytesTotal: number; allowedMimeTypes: readonly string[] };
  try {
    content = resolveContentPolicy(config as never);
  } catch {
    return { maxBytesTotal: 0, allowedMimeTypes: [] };
  }
  const entitlements = await loadAgentEntitlements(db, agentId, now);
  return {
    maxBytesTotal: Math.min(content.maxAttachmentBytesTotal, entitlements?.attachmentBytesTotalMax ?? 0, ATTACHMENT_BYTES_TOTAL_CEILING),
    allowedMimeTypes: content.allowedMimeTypes,
  };
}

/** 영구본 바이트의 체크섬 대조(전송 직전 — `content-store` 가 부른다). hex 소문자. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
