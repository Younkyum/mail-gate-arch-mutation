/**
 * 메일 기본기 2차 A2 — 발신 첨부의 단위 명제(네트워크 · DB 없음).
 *
 *   AC-A2-1 `multipart/mixed` 조립 — 한글 파일명(RFC 2231) · 바이트가 파서로 왕복 · 첨부 없으면 예전 바이트 그대로 · 경계는 결정적.
 *   AC-A2-2 서명된 PUT — URL 쿼리에 체크섬·조건 헤더가 **없고** `X-Amz-SignedHeaders` 에 넷(content-length·content-type·if-none-match·
 *           x-amz-checksum-sha256)이 있다 · 응답 헤더 넷.
 *   AC-A2-4 검증 — 남의 첨부 404 · 매직 불일치 400 · 스캔 전 409 · 위협(EICAR 판정) 400 · 판정 불가 400 · text/plain NUL 400 · 크기·체크섬 400 ·
 *           만료 409 · 업로드 전 409.
 *   업로드 생성 — 요금제 한도 넘는 파일 400 · 하루 상한 429 · text/plain 1 MB.
 *   AC-A2-8 첨부가 있으면 `code_only` 가 되지 않는다.
 *   보안 리뷰(2차) — M1 확장자·MIME 결속 · 인코딩된 단어 금지 · M2 복사 전 총량·MIME·링크 상한 · 첨부 id 키 · L2 ETag 결속 · 체크섬 없음 거부 ·
 *   L3 발송 불가 상태에서 업로드 생성 거부 · L7 조직 하루 상한.
 */

import { createHash } from 'node:crypto';

import { S3Client } from '@aws-sdk/client-s3';
import PostalMime from 'postal-mime';
import { describe, expect, it } from 'vitest';

import {
  createOutboundAttachmentService,
  isPlainText,
  magicMatches,
  normalizeAttachmentFilename,
  permanentKeyFor,
  stagingKeyFor,
  type AttachmentRejection,
  type OutboundAttachmentService,
} from '../../../src/api/outbound-attachments';
import { toApiResponse } from '../../../src/api/outbound-http';
import { classifyContentShape, prepareOutbound, type OutboundServiceDependencies } from '../../../src/api/outbound-service';
import type { OutboundMessageSnapshot, OutboundMessageStore } from '../../../src/api/outbound-store';
import {
  AttachmentLinkLimitError,
  linkCeilingViolation,
  type AttachmentSendingState,
  type OutboundAttachmentRow,
  type OutboundAttachmentStore,
} from '../../../src/db/repositories/outbound-attachment-store';
import { toAgentId } from '../../../src/db/schema';
import { buildRawMessage } from '../../../src/mail/mime/build';
import { ObjectChangedError, type AttachmentMalwareScanner, type MalwareScanStatus, type ObjectHead, type OutboundAttachmentObjects } from '../../../src/storage/object-store';
import { createS3OutboundAttachmentObjects, UPLOAD_SIGNED_HEADERS } from '../../../src/storage/s3-object-store';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';

const AGENT = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const NOW = new Date('2026-09-27T03:00:00.000Z');
const MIB = 1024 * 1024;
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// 가짜 저장소 · 객체 · 스캐너
// ---------------------------------------------------------------------------

interface World {
  readonly rows: Map<string, OutboundAttachmentRow>;
  readonly objects: Map<string, Uint8Array>;
  readonly scans: Map<string, MalwareScanStatus>;
  readonly links: { messageId: string; position: number; attachmentId: string; permanentKey: string }[];
  readonly linkCounts: Map<string, number>;
  /** 체크섬 없이 올라온 것으로 보일 키(보안 리뷰 L2). */
  readonly noChecksum: Set<string>;
  daily: boolean;
  orgDaily: boolean;
  state: AttachmentSendingState | null;
}

const SENDING: AttachmentSendingState = { agentStatus: 'active', billingStatus: 'active', abuseFreeze: false, ownerPaused: false, reviewStatus: 'active' };
const ALL_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'] as const;

function world(): World {
  return { rows: new Map(), objects: new Map(), scans: new Map(), links: [], linkCounts: new Map(), noChecksum: new Set(), daily: false, orgDaily: false, state: SENDING };
}

function fakeStore(w: World): OutboundAttachmentStore {
  const idempotency = new Map<string, { readonly row: OutboundAttachmentRow; readonly hash: string }>();
  return {
    insertUpload: (upload) => {
      if (w.daily) return Promise.resolve({ kind: 'daily_limit' });
      if (w.orgDaily) return Promise.resolve({ kind: 'org_daily_limit' });
      // 묶음 B — 같은 키(에이전트별) 를 먼저 찾는다(저장소의 잠금 아래 조회와 같은 뜻).
      if (upload.idempotency !== undefined) {
        const seen = idempotency.get(`${upload.agentId}|${upload.idempotency.key}`);
        if (seen !== undefined) {
          return Promise.resolve(
            seen.hash === upload.idempotency.requestHash ? { kind: 'replayed', row: seen.row } : { kind: 'idempotency_conflict', attachmentId: seen.row.id },
          );
        }
      }
      const row: OutboundAttachmentRow = {
        id: upload.id,
        agentId: upload.agentId,
        filename: upload.filename,
        mimeType: upload.mimeType,
        bytes: upload.bytes,
        sha256: upload.sha256,
        stagingKey: upload.stagingKey,
        createdAt: upload.now,
        expiresAt: new Date(upload.now.getTime() + 2 * 86_400_000),
      };
      w.rows.set(row.id, row);
      if (upload.idempotency !== undefined) idempotency.set(`${upload.agentId}|${upload.idempotency.key}`, { row, hash: upload.idempotency.requestHash });
      return Promise.resolve({ kind: 'inserted', row });
    },
    sendingState: () => Promise.resolve(w.state),
    linkCounts: (ids) => Promise.resolve(new Map(ids.map((id) => [id, w.linkCounts.get(id) ?? 0]))),
    findForAgent: (agentId, ids) => Promise.resolve(ids.map((id) => w.rows.get(id)).filter((row): row is OutboundAttachmentRow => row?.agentId === agentId)),
    linkToMessage: (messageId, links) => {
      for (const link of links) w.links.push({ messageId, ...link });
      return Promise.resolve();
    },
    metaForMessage: () => Promise.resolve([]),
  };
}

function fakeObjects(w: World): OutboundAttachmentObjects {
  const head = (key: string): Promise<ObjectHead | null> => {
    const bytes = w.objects.get(key);
    if (bytes === undefined) return Promise.resolve(null);
    return Promise.resolve({
      size: bytes.length,
      sha256Base64: w.noChecksum.has(key) ? null : createHash('sha256').update(bytes).digest('base64'),
      etag: `"${sha(bytes)}"`,
    });
  };
  return {
    kind: 'local-dev',
    signUpload: (key, spec, now) =>
      Promise.resolve({ method: 'PUT', url: `https://upload.test/${key}`, headers: { 'content-type': spec.contentType }, expiresAt: new Date(now.getTime() + 900_000) }),
    head,
    readPrefix: (key, length) => Promise.resolve((w.objects.get(key) ?? new Uint8Array()).subarray(0, length)),
    get: (key) => Promise.resolve(w.objects.get(key) ?? new Uint8Array()),
    copyOnce: (source, destination, options) => {
      if (w.objects.has(destination)) return Promise.resolve('exists');
      const bytes = w.objects.get(source) ?? new Uint8Array();
      if (options?.ifMatch != null && options.ifMatch !== `"${sha(bytes)}"`) return Promise.reject(new ObjectChangedError(source));
      w.objects.set(destination, bytes);
      return Promise.resolve('copied');
    },
  };
}

function fakeScanner(w: World): AttachmentMalwareScanner {
  return { kind: 'local-dev', status: (key) => Promise.resolve(w.scans.get(key) ?? 'PENDING') };
}

function service(w: World, planLimit = 10 * MIB, allowedMimeTypes: readonly string[] = ALL_TYPES): OutboundAttachmentService {
  return createOutboundAttachmentService({
    enabled: true,
    store: fakeStore(w),
    objects: fakeObjects(w),
    scanner: fakeScanner(w),
    limitsFor: () => Promise.resolve({ maxBytesTotal: planLimit, allowedMimeTypes }),
  });
}

const FILENAME_OF = { 'application/pdf': '보고서.pdf', 'image/png': 'shot.png', 'image/jpeg': 'photo.jpg', 'text/plain': 'notes.txt' } as const;

/** 업로드 생성 → (선택) 바이트를 스테이징에 · 스캔 판정. 첨부 id. */
async function uploaded(
  w: World,
  s: OutboundAttachmentService,
  bytes: Uint8Array,
  options: { mimeType?: 'application/pdf' | 'image/png' | 'image/jpeg' | 'text/plain'; scan?: MalwareScanStatus | null; agentId?: string; stored?: Uint8Array | null } = {},
): Promise<string> {
  const created = await s.createUpload({ agentId: options.agentId ?? AGENT, filename: FILENAME_OF[options.mimeType ?? 'application/pdf'], mimeType: options.mimeType ?? 'application/pdf', bytes: bytes.length, sha256: sha(bytes) }, NOW);
  if (!('kind' in created)) throw new Error(created.code);
  const key = created.row.stagingKey;
  if (options.stored !== null) w.objects.set(key, options.stored ?? bytes);
  if (options.scan !== null) w.scans.set(key, options.scan ?? 'NO_THREATS_FOUND');
  return created.row.id;
}

const rejection = (value: unknown): AttachmentRejection => value as AttachmentRejection;

describe('A2 발송 준비 검증(AC-A2-4)', () => {
  it('통과 — 검증 → 영구 복사 · 결속(자리 순 · 영구 키 모양)', async () => {
    const w = world();
    const s = service(w);
    const first = await uploaded(w, s, PDF);
    const second = await uploaded(w, s, new TextEncoder().encode('메모 plain text\n'), { mimeType: 'text/plain' });
    const validated = await s.validate(AGENT, [first, second], NOW);
    expect('rows' in validated).toBe(true);
    const messageId = '11111111-1111-4111-8111-111111111111';
    const persisted = await s.persist(messageId, validated as never);
    // 영구 키 = 첨부 id(내용 주소) — 같은 첨부를 여러 통이 써도 한 번만 복사된다(보안 리뷰 M2).
    expect(persisted.map((item) => item.key)).toEqual([permanentKeyFor(first), permanentKeyFor(second)]);
    expect(w.links.map((link) => [link.position, link.attachmentId])).toEqual([
      [0, first],
      [1, second],
    ]);
    expect(w.objects.get(permanentKeyFor(first))).toEqual(PDF);
    // 이어받은 시도 — 영구본이 이미 있으면 머리로 대조하고 통과(같은 바이트).
    await expect(s.persist(messageId, validated as never)).resolves.toHaveLength(2);
  });

  it('남의 첨부 · 없는 id → 404 attachment_not_found (존재가 새지 않는다)', async () => {
    const w = world();
    const s = service(w);
    const others = await uploaded(w, s, PDF, { agentId: OTHER });
    expect(rejection(await s.validate(AGENT, [others], NOW))).toMatchObject({ status: 404, code: 'attachment_not_found' });
    expect(rejection(await s.validate(AGENT, ['22222222-2222-4222-8222-222222222222'], NOW))).toMatchObject({ status: 404 });
  });

  it('업로드 전 409 · 스캔 전 409 · 위협 400 · 판정 불가 400', async () => {
    const w = world();
    const s = service(w);
    expect(rejection(await s.validate(AGENT, [await uploaded(w, s, PDF, { stored: null })], NOW))).toMatchObject({ status: 409, code: 'attachment_not_uploaded' });
    expect(rejection(await s.validate(AGENT, [await uploaded(w, s, PDF, { scan: null })], NOW))).toMatchObject({ status: 409, code: 'attachment_scan_pending' });
    expect(rejection(await s.validate(AGENT, [await uploaded(w, s, PDF, { scan: 'THREATS_FOUND' })], NOW))).toMatchObject({ status: 400, code: 'attachment_malicious' });
    for (const scan of ['UNSUPPORTED', 'ACCESS_DENIED', 'FAILED'] as const) {
      expect(rejection(await s.validate(AGENT, [await uploaded(w, s, PDF, { scan })], NOW)), scan).toMatchObject({ status: 400, code: 'attachment_scan_failed' });
    }
  });

  it('크기·체크섬이 선언과 다르면 400 · 매직 불일치 400 · text/plain 의 NUL·비 UTF-8 400', async () => {
    const w = world();
    const s = service(w);
    const tampered = await uploaded(w, s, PDF, { stored: new Uint8Array([...PDF.subarray(0, 8), 0x0b]) });
    expect(rejection(await s.validate(AGENT, [tampered], NOW))).toMatchObject({ status: 400, code: 'attachment_integrity_mismatch' });
    const notPng = await uploaded(w, s, PDF, { mimeType: 'image/png' });
    expect(rejection(await s.validate(AGENT, [notPng], NOW))).toMatchObject({ status: 400, code: 'attachment_content_mismatch' });
    const binaryText = await uploaded(w, s, new Uint8Array([0x61, 0x00, 0x62]), { mimeType: 'text/plain' });
    expect(rejection(await s.validate(AGENT, [binaryText], NOW))).toMatchObject({ status: 400, code: 'attachment_content_mismatch' });
    const latin1 = await uploaded(w, s, new Uint8Array([0x61, 0xff, 0x62]), { mimeType: 'text/plain' });
    expect(rejection(await s.validate(AGENT, [latin1], NOW))).toMatchObject({ status: 400, code: 'attachment_content_mismatch' });
  });

  it('만료(업로드 뒤 2일) 409 · 11개 400 · 중복 id 400', async () => {
    const w = world();
    const s = service(w);
    const id = await uploaded(w, s, PDF);
    const later = new Date(NOW.getTime() + 2 * 86_400_000 + 1);
    expect(rejection(await s.validate(AGENT, [id], later))).toMatchObject({ status: 409, code: 'attachment_expired' });
    expect(rejection(await s.validate(AGENT, Array.from({ length: 11 }, () => id), NOW))).toMatchObject({ status: 400 });
    expect(rejection(await s.validate(AGENT, [id, id], NOW))).toMatchObject({ status: 400 });
  });

  it('검증 시간 예산을 넘으면 503 attachment_check_timeout(같은 키로 다시)', async () => {
    const w = world();
    const slow = createOutboundAttachmentService({
      enabled: true,
      store: fakeStore(w),
      objects: { ...fakeObjects(w), head: () => new Promise(() => undefined) },
      scanner: fakeScanner(w),
      limitsFor: () => Promise.resolve({ maxBytesTotal: 10 * MIB, allowedMimeTypes: ALL_TYPES }),
      callTimeoutMs: 20,
      budgetMs: 50,
    });
    const id = await uploaded(w, slow, PDF);
    expect(rejection(await slow.validate(AGENT, [id], NOW))).toMatchObject({ status: 503, code: 'attachment_check_timeout' });
  });
});

describe('A2 업로드 생성 — 빠른 거부', () => {
  it('파일 하나가 요금제 메일당 한도를 넘으면 400 · text/plain 1 MB · 하루 상한 429', async () => {
    const w = world();
    const free = service(w, 5 * MIB);
    const tooLarge = await free.createUpload({ agentId: AGENT, filename: 'a.pdf', mimeType: 'application/pdf', bytes: 5 * MIB + 1, sha256: 'a'.repeat(64) }, NOW);
    expect(tooLarge).toMatchObject({ status: 400, code: 'attachment_too_large' });
    const bigText = await free.createUpload({ agentId: AGENT, filename: 'a.txt', mimeType: 'text/plain', bytes: MIB + 1, sha256: 'a'.repeat(64) }, NOW);
    expect(bigText).toMatchObject({ status: 400, code: 'attachment_too_large' });
    w.daily = true;
    expect(await free.createUpload({ agentId: AGENT, filename: 'a.pdf', mimeType: 'application/pdf', bytes: 10, sha256: 'a'.repeat(64) }, NOW)).toMatchObject({
      status: 429,
      code: 'attachment_daily_limit',
    });
  });

  it('스테이징 키 = 에이전트/첨부 id · 서명 헤더는 체크섬 base64', async () => {
    const w = world();
    const created = await service(w).createUpload({ agentId: AGENT, filename: 'a.pdf', mimeType: 'application/pdf', bytes: PDF.length, sha256: sha(PDF) }, NOW);
    if (!('kind' in created)) throw new Error('rejected');
    expect(created.row.stagingKey).toBe(stagingKeyFor(AGENT, created.row.id));
  });

  it('매직·text 판정 함수', () => {
    expect(magicMatches('application/pdf', PDF)).toBe(true);
    expect(magicMatches('image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true);
    expect(magicMatches('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(magicMatches('image/jpeg', PDF)).toBe(false);
    expect(isPlainText(new TextEncoder().encode('안녕'))).toBe(true);
  });
});

describe('보안 리뷰 2차 — 파일명(M1)', () => {
  it('확장자는 선언한 MIME 에 묶인다 · 없으면 붙인다 · 대소문자 무관 · 인코딩된 단어 거부', () => {
    expect(normalizeAttachmentFilename('견적서.pdf', 'application/pdf')).toEqual({ ok: true, filename: '견적서.pdf' });
    expect(normalizeAttachmentFilename('PHOTO.JPEG', 'image/jpeg')).toEqual({ ok: true, filename: 'PHOTO.JPEG' });
    expect(normalizeAttachmentFilename('photo.jpg', 'image/jpeg')).toEqual({ ok: true, filename: 'photo.jpg' });
    expect(normalizeAttachmentFilename('report', 'application/pdf')).toEqual({ ok: true, filename: 'report.pdf' });
    expect(normalizeAttachmentFilename('notes', 'text/plain')).toEqual({ ok: true, filename: 'notes.txt' });
    expect(normalizeAttachmentFilename('invoice.pdf.exe', 'application/pdf')).toMatchObject({ ok: false, code: 'attachment_filename_extension_mismatch' });
    expect(normalizeAttachmentFilename('invoice.html', 'text/plain')).toMatchObject({ ok: false, code: 'attachment_filename_extension_mismatch' });
    expect(normalizeAttachmentFilename('shot.png', 'application/pdf')).toMatchObject({ ok: false, code: 'attachment_filename_extension_mismatch' });
    expect(normalizeAttachmentFilename('=?UTF-8?B?ZXZpbC5leGU=?=.pdf', 'application/pdf')).toMatchObject({ ok: false, code: 'attachment_filename_invalid' });
    expect(normalizeAttachmentFilename('a =?utf-8?q?x?= b.pdf', 'application/pdf')).toMatchObject({ ok: false, code: 'attachment_filename_invalid' });
    expect(normalizeAttachmentFilename('a/b.pdf', 'application/pdf')).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('묶음 B — Idempotency-Key: 같은 키 + 같은 요청은 같은 첨부(새 서명) · 다른 요청은 409 · 키 없으면 매번 새 첨부', async () => {
    const w = world();
    const s = service(w);
    const input = { agentId: AGENT, filename: 'report.pdf', mimeType: 'application/pdf' as const, bytes: PDF.length, sha256: sha(PDF), idempotencyKey: 'k-1' };
    const first = await s.createUpload(input, NOW);
    expect(first).toMatchObject({ kind: 'created' });
    const again = await s.createUpload(input, NOW);
    expect(again).toMatchObject({ kind: 'replayed', row: { id: (first as { row: { id: string } }).row.id }, upload: { method: 'PUT' } });
    expect(w.rows.size).toBe(1);
    expect(await s.createUpload({ ...input, filename: 'other.pdf' }, NOW)).toMatchObject({ status: 409, code: 'idempotency_key_reused' });
    // 만료된 첨부의 키는 되살리지 않는다.
    expect(await s.createUpload(input, new Date(NOW.getTime() + 3 * 86_400_000))).toMatchObject({ status: 409, code: 'attachment_expired' });
    const { idempotencyKey: _unused, ...plain } = input;
    await s.createUpload(plain, NOW);
    await s.createUpload(plain, NOW);
    expect(w.rows.size).toBe(3);
  });

  it('업로드 생성이 정규화한 이름을 저장한다 · 어긋나면 400', async () => {
    const w = world();
    const s = service(w);
    const created = await s.createUpload({ agentId: AGENT, filename: 'report', mimeType: 'application/pdf', bytes: PDF.length, sha256: sha(PDF) }, NOW);
    expect(created).toMatchObject({ kind: 'created', row: { filename: 'report.pdf' } });
    expect(await s.createUpload({ agentId: AGENT, filename: 'x.exe', mimeType: 'application/pdf', bytes: PDF.length, sha256: sha(PDF) }, NOW)).toMatchObject({
      status: 400,
      code: 'attachment_filename_extension_mismatch',
    });
  });

  it('MIME 조립기도 인코딩된 단어 파일명을 던진다(마지막 방어)', () => {
    expect(() =>
      buildRawMessage({
        fromAddress: 'agent@atmark.ai',
        recipients: ['friend@example.com'],
        subject: 's',
        messageIdHeader: '<m.2@atmark.ai>',
        date: NOW,
        text: 't',
        html: null,
        threading: null,
        replyTo: null,
        attachments: [{ filename: '=?UTF-8?B?ZXZpbC5leGU=?=', mimeType: 'text/plain', data: new Uint8Array([0x61]) }],
      }),
    ).toThrow();
  });
});

describe('보안 리뷰 2차 — 업로드 생성 상태(L3) · 조직 하루 상한(L7)', () => {
  const request = { agentId: AGENT, filename: 'a.pdf', mimeType: 'application/pdf' as const, bytes: PDF.length, sha256: sha(PDF) };

  it('에이전트 없음 404 · 정지 403 · 조직 동결·일시정지·검토 전·결제 막힘 403', async () => {
    const w = world();
    const s = service(w);
    w.state = null;
    expect(await s.createUpload(request, NOW)).toMatchObject({ status: 404, code: 'agent_not_found' });
    w.state = { ...SENDING, agentStatus: 'suspended' };
    expect(await s.createUpload(request, NOW)).toMatchObject({ status: 403, code: 'agent_not_active' });
    for (const state of [
      { ...SENDING, abuseFreeze: true },
      { ...SENDING, ownerPaused: true },
      { ...SENDING, reviewStatus: 'pending_review' },
      { ...SENDING, billingStatus: 'delinquent' },
      { ...SENDING, billingStatus: 'suspended' },
    ]) {
      w.state = state;
      expect(await s.createUpload(request, NOW), JSON.stringify(state)).toMatchObject({ status: 403, code: 'organization_not_sending' });
    }
    expect(w.rows.size).toBe(0);
  });

  it('조직 하루 상한 → 429 attachment_org_daily_limit', async () => {
    const w = world();
    w.orgDaily = true;
    expect(await service(w).createUpload(request, NOW)).toMatchObject({ status: 429, code: 'attachment_org_daily_limit' });
  });
});

describe('보안 리뷰 2차 — 복사 전 판정(M2) · 판 결속(L2)', () => {
  it('총량이 min(정책, 요금제, 천장)을 넘으면 400 attachment_bytes_exceeded — S3 를 부르기 전에', async () => {
    const w = world();
    const s = service(w, 5 * MIB);
    const big = new Uint8Array(3 * MIB).map((_v, i) => (i < PDF.length ? (PDF[i] as number) : 0x20));
    const a = await uploaded(w, s, big);
    const b = await uploaded(w, s, big, { scan: null, stored: null });
    expect(rejection(await s.validate(AGENT, [a, b], NOW))).toMatchObject({ status: 400, code: 'attachment_bytes_exceeded' });
  });

  it('정책이 허용하지 않는 MIME → 400 attachment_type_not_allowed', async () => {
    const w = world();
    const s = service(w, 10 * MIB, ['application/pdf']);
    const text = await uploaded(w, s, new TextEncoder().encode('hi'), { mimeType: 'text/plain' });
    expect(rejection(await s.validate(AGENT, [text], NOW))).toMatchObject({ status: 400, code: 'attachment_type_not_allowed' });
  });

  it('한 첨부가 이미 50통에 실렸으면 409 attachment_link_limit', async () => {
    const w = world();
    const s = service(w);
    const id = await uploaded(w, s, PDF);
    w.linkCounts.set(id, 50);
    expect(rejection(await s.validate(AGENT, [id], NOW))).toMatchObject({ status: 409, code: 'attachment_link_limit' });
    w.linkCounts.set(id, 49);
    expect('rows' in (await s.validate(AGENT, [id], NOW))).toBe(true);
  });

  it('체크섬 없이 올라온 객체 → 400 attachment_integrity_mismatch', async () => {
    const w = world();
    const s = service(w);
    const id = await uploaded(w, s, PDF);
    w.noChecksum.add(stagingKeyFor(AGENT, id));
    expect(rejection(await s.validate(AGENT, [id], NOW))).toMatchObject({ status: 400, code: 'attachment_integrity_mismatch' });
  });

  it('검증 뒤 스테이징 객체가 바뀌면 복사가 판(ETag) 대조로 실패한다 — 검사한 판만 옮긴다', async () => {
    const w = world();
    const s = service(w);
    const id = await uploaded(w, s, PDF);
    const validated = await s.validate(AGENT, [id], NOW);
    expect('rows' in validated).toBe(true);
    w.objects.set(stagingKeyFor(AGENT, id), new Uint8Array([...PDF, 0x0a]));
    await expect(s.persist('11111111-1111-4111-8111-111111111111', validated as never)).rejects.toBeInstanceOf(ObjectChangedError);
    expect(w.objects.has(permanentKeyFor(id))).toBe(false);
    expect(w.links).toHaveLength(0);
  });

  it('영구본의 체크섬이 비면 persist 가 던진다', async () => {
    const w = world();
    const s = service(w);
    const id = await uploaded(w, s, PDF);
    const validated = await s.validate(AGENT, [id], NOW);
    w.noChecksum.add(permanentKeyFor(id));
    await expect(s.persist('11111111-1111-4111-8111-111111111111', validated as never)).rejects.toThrow();
    expect(w.links).toHaveLength(0);
  });
});

describe('보안 리뷰 N1 — 결속 천장 경합(트리거 23514)은 선검사와 같은 409 · 행은 종단', () => {
  const CEILING_MESSAGE = (id: string): string => `message_attachments: attachment ${id} already linked to 50 messages (max 50)`;
  const TRIGGER_WHERE = 'PL/pgSQL function message_attachments_link_ceiling() line 8 at RAISE';

  it('트리거 오류만 걸린다 — SQLSTATE 23514 + 트리거 문구(첨부 id) 또는 트리거 함수 문맥', () => {
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    expect(linkCeilingViolation(Object.assign(new Error(CEILING_MESSAGE(id)), { code: '23514', where: TRIGGER_WHERE }))).toEqual({ attachmentId: id });
    expect(linkCeilingViolation(Object.assign(new Error('다른 문구'), { code: '23514', where: TRIGGER_WHERE }))).toEqual({ attachmentId: null });
    // 다른 CHECK(23514) · 같은 문구의 다른 SQLSTATE · 오류 아닌 값은 걸리지 않는다.
    expect(linkCeilingViolation(Object.assign(new Error('new row violates check constraint'), { code: '23514', constraint: 'message_attachments_position_check' }))).toBeUndefined();
    expect(linkCeilingViolation(Object.assign(new Error(CEILING_MESSAGE(id)), { code: 'P0001' }))).toBeUndefined();
    expect(linkCeilingViolation('23514')).toBeUndefined();
  });

  const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';

  function harness(s: OutboundAttachmentService) {
    const calls = { inserts: 0, denied: [] as string[], contentPuts: 0, released: 0 };
    const snapshot: OutboundMessageSnapshot = {
      id: MESSAGE_ID,
      agentId: toAgentId(AGENT),
      status: 'pending',
      messageIdHeader: '<1x.deadbeef@atmark.ai>',
      idempotencyKey: 'key-1',
      requestHash: '0'.repeat(64),
      recipientCount: 1,
      sesMessageId: null,
      failureReason: null,
      gated: false,
    };
    const messages: OutboundMessageStore = {
      insertOrReplay: () => {
        calls.inserts += 1;
        return Promise.resolve({ kind: 'inserted', message: snapshot });
      },
      findById: () => Promise.resolve(snapshot),
      claimUngated: () => Promise.resolve(null),
      releaseClaim: () => {
        calls.released += 1;
        return Promise.resolve();
      },
    };
    const deps = {
      source: undefined as never,
      audit: undefined as never,
      serializer: undefined as never,
      sendEvidence: undefined as never,
      dispatchStore: {
        settleDenied: (id: string) => {
          calls.denied.push(id);
          return Promise.resolve(true);
        },
      } as never,
      messages,
      content: {
        put: () => {
          calls.contentPuts += 1;
          return Promise.resolve();
        },
      } as never,
      leaseTtlSeconds: 60,
      now: () => NOW,
      attachments: s,
      riskSignals: inertRiskSignals(),
      dlp: inertDlp(),
    } satisfies OutboundServiceDependencies;
    return { deps, calls };
  }

  const request = (ids: readonly string[]) => ({
    routeId: 'send',
    agentId: toAgentId(AGENT),
    idempotencyKey: 'key-1',
    fromAddress: 'agent@atmark.ai',
    recipients: ['jinyounkyum@gmail.com'],
    subject: '견적서',
    text: '첨부 확인 부탁드립니다.',
    html: null,
    isThreadReply: false as const,
    traceId: null,
    costCents: 0,
    attachmentIds: ids,
  });

  it('선검사를 지난 뒤 결속 INSERT 가 트리거에 막히면 409 attachment_link_limit · 행 denied · 본문 저장 없음 · 같은 키 재시도도 같은 409', async () => {
    const w = world();
    const other = await uploaded(w, service(w), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), { mimeType: 'image/png' });
    const base = service(w);
    const id = await uploaded(w, base, PDF);
    // 선검사(linkCounts)는 49 를 보고 통과 — 그 사이 경합한 발송이 50번째를 결속했다. 결속 INSERT 가 트리거(23514)에 막힌다.
    w.linkCounts.set(id, 49);
    const racing = createOutboundAttachmentService({
      enabled: true,
      store: {
        ...fakeStore(w),
        linkToMessage: () => {
          w.linkCounts.set(id, 50);
          const pgError = Object.assign(new Error(CEILING_MESSAGE(id)), { code: '23514', where: TRIGGER_WHERE });
          const ceiling = linkCeilingViolation(pgError);
          return Promise.reject(ceiling === undefined ? pgError : new AttachmentLinkLimitError(ceiling.attachmentId));
        },
      },
      objects: fakeObjects(w),
      scanner: fakeScanner(w),
      limitsFor: () => Promise.resolve({ maxBytesTotal: 10 * MIB, allowedMimeTypes: ALL_TYPES }),
    });
    const { deps, calls } = harness(racing);

    const first = await prepareOutbound(deps, request([other, id]));
    expect(first).toEqual({
      kind: 'settled',
      outcome: { kind: 'attachment_rejected', status: 409, code: 'attachment_link_limit', detail: expect.stringContaining('attachments[1]') as unknown },
    });
    expect(calls.denied).toEqual([MESSAGE_ID]);
    expect(calls.contentPuts).toBe(0);
    if (first.kind !== 'settled') throw new Error('unreachable');
    const response = toApiResponse(first.outcome);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: 'attachment_link_limit' });

    // 같은 멱등 키의 재시도 — 결속은 지워지지 않으므로(트리거) 선검사가 같은 409 를 낸다. 행에는 닿지 않는다(500 이 아니다).
    const again = await prepareOutbound(deps, request([other, id]));
    expect(again).toMatchObject({ kind: 'settled', outcome: { kind: 'attachment_rejected', status: 409, code: 'attachment_link_limit' } });
    expect(calls.inserts).toBe(1);
    expect(calls.denied).toEqual([MESSAGE_ID]);
  });

  it('다른 결속 오류는 그대로 던진다(임대를 놓는다) — 409 로 삼키지 않는다', async () => {
    const w = world();
    const base = service(w);
    const id = await uploaded(w, base, PDF);
    const broken = createOutboundAttachmentService({
      enabled: true,
      store: { ...fakeStore(w), linkToMessage: () => Promise.reject(Object.assign(new Error('boom'), { code: '23503' })) },
      objects: fakeObjects(w),
      scanner: fakeScanner(w),
      limitsFor: () => Promise.resolve({ maxBytesTotal: 10 * MIB, allowedMimeTypes: ALL_TYPES }),
    });
    const { deps, calls } = harness(broken);
    await expect(prepareOutbound(deps, request([id]))).rejects.toThrow('boom');
    expect(calls.denied).toEqual([]);
    expect(calls.released).toBe(1);
  });
});

describe('A2 서명된 PUT(AC-A2-2)', () => {
  it('쿼리에 체크섬·조건 헤더가 없고 SignedHeaders 에 넷 · 응답 헤더 넷', async () => {
    const signingClient = new S3Client({
      region: 'ap-northeast-2',
      credentials: { accessKeyId: 'AKIDEXAMPLEFAKEKEY00', secretAccessKey: 'fake-secret-for-signing-only' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
    const objects = createS3OutboundAttachmentObjects({
      signingClient,
      client: { send: () => Promise.reject(new Error('네트워크 금지')) } as never,
      bucket: 'atmark-mail',
      expectedBucketOwner: '123456789012',
    });
    const checksum = createHash('sha256').update(PDF).digest('base64');
    const key = stagingKeyFor(AGENT, '33333333-3333-4333-8333-333333333333');
    const signed = await objects.signUpload(key, { contentType: 'application/pdf', contentLength: PDF.length, sha256Base64: checksum }, NOW);
    const url = new URL(signed.url);
    const query = [...url.searchParams.keys()].map((name) => name.toLowerCase());
    expect(query.some((name) => name.includes('checksum'))).toBe(false);
    expect(query).not.toContain('if-none-match');
    expect(query.some((name) => name.includes('sdk-checksum'))).toBe(false);
    const signedHeaders = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
    for (const header of UPLOAD_SIGNED_HEADERS) expect(signedHeaders, header).toContain(header);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(signed.headers).toEqual({
      'content-type': 'application/pdf',
      'content-length': String(PDF.length),
      'x-amz-checksum-sha256': checksum,
      'if-none-match': '*',
    });
    await expect(objects.signUpload(permanentKeyFor('11111111-1111-4111-8111-111111111111'), { contentType: 'application/pdf', contentLength: 1, sha256Base64: checksum }, NOW)).rejects.toThrow();
  });
});

describe('A2 MIME 조립(AC-A2-1)', () => {
  const base = {
    fromAddress: 'agent@atmark.ai',
    recipients: ['friend@example.com'],
    subject: '첨부 보냄',
    messageIdHeader: '<m.1@atmark.ai>',
    date: NOW,
    text: '본문입니다.',
    html: null,
    threading: null,
    replyTo: null,
  } as const;

  it('multipart/mixed — 한글 파일명(RFC 2231) · 바이트가 파서로 왕복 · 경계 결정적', async () => {
    const pdf = new Uint8Array(5000).map((_v, i) => (i < PDF.length ? (PDF[i] as number) : i % 251));
    const raw = buildRawMessage({
      ...base,
      html: '<p>본문</p>',
      attachments: [
        { filename: '2026년 3분기 견적서 — 최종본(수정).pdf', mimeType: 'application/pdf', data: pdf },
        { filename: 'notes.txt', mimeType: 'text/plain', data: new TextEncoder().encode('hello') },
      ],
    });
    expect(raw).toMatch(/Content-Type: multipart\/mixed; boundary="--atmark-[0-9a-f]{24}"/);
    expect(raw).toContain("filename*0*=UTF-8''");
    expect(raw).toContain('filename="attachment-1.pdf"');
    expect(raw.split('\r\n').every((line) => line.length <= 998)).toBe(true);
    expect(buildRawMessage({ ...base, html: '<p>본문</p>', attachments: [{ filename: 'notes.txt', mimeType: 'text/plain', data: new Uint8Array([1]) }] })).toBe(
      buildRawMessage({ ...base, html: '<p>본문</p>', attachments: [{ filename: 'notes.txt', mimeType: 'text/plain', data: new Uint8Array([1]) }] }),
    );
    const parsed = await PostalMime.parse(raw);
    expect(parsed.text?.trim()).toBe('본문입니다.');
    expect(parsed.attachments.map((a) => [a.filename, a.mimeType])).toEqual([
      ['2026년 3분기 견적서 — 최종본(수정).pdf', 'application/pdf'],
      ['notes.txt', 'text/plain'],
    ]);
    const content = parsed.attachments[0]?.content;
    expect(new Uint8Array(content instanceof ArrayBuffer ? content : new TextEncoder().encode(String(content)))).toEqual(pdf);
  });

  it('첨부가 없으면 예전 바이트 그대로 · 서명표 밖 MIME·헤더 주입 파일명은 던진다', () => {
    expect(buildRawMessage({ ...base, attachments: [] })).toBe(buildRawMessage(base));
    expect(() => buildRawMessage({ ...base, attachments: [{ filename: 'a.exe', mimeType: 'application/x-msdownload', data: new Uint8Array([1]) }] })).toThrow();
    expect(() => buildRawMessage({ ...base, attachments: [{ filename: 'a\r\nBcc: x@y.z', mimeType: 'text/plain', data: new Uint8Array([1]) }] })).toThrow();
  });

  it('AC-A2-8 — 첨부가 있으면 code_only 가 아니다', () => {
    expect(classifyContentShape('123456', null)).toBe('code_only');
    expect(classifyContentShape('123456', null, 1)).toBe('other');
  });
});

describe('단계 공개 — enabledFor(에이전트 → 조직)', () => {
  const ORG = '0b6f9f8e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
  const OTHER = '7d1e2f3a-4b5c-4d6e-9f0a-1b2c3d4e5f60';
  const build = (enabled: boolean | { organizations: ReadonlySet<string> }, organizationOf?: (agentId: string) => Promise<string | null>) => {
    const w = world();
    return createOutboundAttachmentService({
      enabled,
      ...(organizationOf === undefined ? {} : { organizationOf }),
      store: fakeStore(w),
      objects: fakeObjects(w),
      scanner: fakeScanner(w),
      limitsFor: () => Promise.resolve({ maxBytesTotal: MIB, allowedMimeTypes: ALL_TYPES }),
    });
  };

  it('불리언은 조직을 보지 않는다 · 허용목록은 에이전트의 조직으로 · 모르는 에이전트·조회 없음은 닫힘', async () => {
    let lookups = 0;
    const lookup = (agentId: string) => {
      lookups += 1;
      return Promise.resolve(agentId === AGENT ? ORG : null);
    };
    expect(await build(true, lookup).enabledFor(AGENT)).toBe(true);
    expect(await build(false, lookup).enabledFor(AGENT)).toBe(false);
    expect(lookups).toBe(0);
    expect(await build({ organizations: new Set([ORG]) }, lookup).enabledFor(AGENT)).toBe(true);
    expect(await build({ organizations: new Set([OTHER]) }, lookup).enabledFor(AGENT)).toBe(false);
    expect(await build({ organizations: new Set([ORG]) }, lookup).enabledFor('b'.repeat(32))).toBe(false);
    expect(await build({ organizations: new Set([ORG]) }).enabledFor(AGENT)).toBe(false);
  });
});
