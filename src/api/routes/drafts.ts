/**
 * 초안(묶음 B) — `POST /v1/drafts` · `GET /v1/drafts` · `GET /v1/drafts/{id}` · `PATCH /v1/drafts/{id}` · `POST /v1/drafts/{id}/discard`.
 * 보내기(`POST /v1/drafts/{id}/send`)는 **다른 파일**이다(`draft-send.ts` — 매니페스트 `draft_send`, 관문을 지난다).
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 초안 행 하나와 본문 객체 하나를 쓸 뿐 보내지 않는다 — 관문을 import 하지 않는다. 판정은 보낼 때
 * 한 번이다(예약 생성과 같은 규율 — 만들 때 판정을 믿고 보낼 때 빼는 사고를 막는다). 초안에는 받은 메일의 복사가 들어갈 수 있다 — 발신 DLP 는 보낼 때
 * 서버가 조립한 최종 내용을 본다(`outbound-service.ts`).
 *
 * - **권한은 `messages:send`** — 읽기 · 쓰기 모두. 초안은 나갈 메일의 앞 단계다: 읽기 전용 토큰(`messages:read` 만)은 초안을 만들지도 보지도 않는다.
 * - **에이전트 범위.** 만들기 · 목록은 대상 에이전트를 `agent_id`(본문 · 쿼리)로 받아 인가한다(생략 = 토큰의 에이전트, 2026-10-11 — 적으면 그 값으로 인가). id 로 부르는 셋은
 *   토큰의 에이전트로 묶어 찾는다 — 남의 초안 id 는 없는 것과 같다(404).
 * - **모양은 보내기와 같다.** 발신은 정규형(소문자 · `+tag` 없음) · 받는 사람은 발신 모양(ASCII dot-atom) 50 명 이하 · 제목 998자 · 본문 10 MiB ·
 *   첨부 id 10 개. 초안은 **미완성일 수 있다**(받는 사람 · 제목 · 발신 없이 저장된다) — 모자란 것은 보낼 때 400 `draft_incomplete` 다.
 * - **답장 초안**(`in_reply_to`) — 이 에이전트에게 **보이는** 받은 메일이어야 한다(격리 · 남의 메일은 없는 메일과 같은 404). 보낼 때 그 메일의 권한용
 *   스레드로 답한다(`reply` 와 같은 기본값: 받는 사람 = 인증된 From, 제목 = `Re: …`, 발신 = 받은 주소 · 대표).
 * - **고치기는 판(`revision`)으로 줄 세운다.** 본문에 `revision` 을 주면 그 판일 때만 바뀐다(아니면 409 `draft_revision_conflict`). 보내는 중 · 보낸 ·
 *   버린 초안은 바뀌지 않는다(409 — DB 트리거도 막는다).
 * - **지우지 않는다.** 버리기는 `discarded_at` 하나다.
 */

import { randomUUID } from 'node:crypto';

import type { ReplyTargetLookup } from '../../db/repositories/reply-target-store';
import type { DraftFields, DraftListStatus, DraftRow, DraftStore } from '../../db/repositories/draft-store';
import { isAgentId, toAgentId, type AgentId } from '../../db/schema';
import type { AgentTokenStore } from '../../identity/agent-token';
import { isOutboundRecipientAddress } from '../../policy/contact-rules';
import { isAddressShape, normalizeAddress } from '../../policy/policy-loader';
import { MAX_DRAFT_CONTENT_BYTES, type DraftContent, type DraftContentStore } from '../../storage/draft-content-store';
import { ObjectAlreadyExistsError, ObjectNotFoundError } from '../../storage/object-store';
import { authorizeAgentRequest, claimedAgentOfQuery, type AgentAccessOutcome } from '../auth';
import { errorResponse, isJsonObject, jsonResponse, pageLimitOf, pageOf, queryOf, UUID_PATTERN, type ApiRequest, type ApiResponse } from '../http';
import { INVALID_RECIPIENT, invalidRecipientDetail } from '../outbound-http';

export interface DraftRouteDependencies {
  readonly tokens: AgentTokenStore;
  readonly drafts: DraftStore;
  readonly content: DraftContentStore;
  /** 답장 초안의 대상 확인(보이는 · 이 에이전트의 메일인가) — 회신 라우트와 같은 조회. */
  readonly replyTargets: ReplyTargetLookup;
  readonly now: () => Date;
}

const DEFAULT_DRAFT_PAGE_SIZE = 20;
const MAX_DRAFT_PAGE_SIZE = 100;
const MAX_DRAFT_RECIPIENTS = 50;
const MAX_DRAFT_SUBJECT_LENGTH = 998;
const MAX_DRAFT_ATTACHMENTS = 10;

const FIELDS: ReadonlySet<string> = new Set(['agent_id', 'from', 'to', 'subject', 'text', 'html', 'in_reply_to', 'attachments', 'revision']);
const DRAFT_STATUSES: readonly DraftListStatus[] = ['active', 'sent', 'discarded', 'all'];

/** 초안의 상태 — 행에서 정한다. `sending` = 보내기 키를 잡았고 관문의 결과를 아직 적지 않았다. */
export function draftStatus(row: DraftRow): 'active' | 'sending' | 'sent' | 'discarded' {
  if (row.sentMessageId !== null) return 'sent';
  if (row.discardedAt !== null) return 'discarded';
  if (row.sendIdempotencyKey !== null) return 'sending';
  return 'active';
}

/** 목록 항목(본문 없음). */
function draftSummaryBody(row: DraftRow): Record<string, unknown> {
  return {
    id: row.id,
    agent_id: row.agentId,
    revision: row.revision,
    status: draftStatus(row),
    from: row.fromAddress,
    to: [...row.recipients],
    subject: row.subject,
    in_reply_to: row.inReplyTo,
    attachments: [...row.attachmentIds],
    size_bytes: row.contentBytes,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    discarded_at: row.discardedAt?.toISOString() ?? null,
    sent_at: row.sentAt?.toISOString() ?? null,
    message_id: row.sentMessageId,
  };
}

function draftBody(row: DraftRow, content: DraftContent): Record<string, unknown> {
  return { ...draftSummaryBody(row), text: content.text, html: content.html };
}

// ---------------------------------------------------------------------------
// 본문 파싱
// ---------------------------------------------------------------------------

type Parsed<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'error'; readonly response: ApiResponse };

function bad(detail: string, code = 'invalid_request'): { readonly kind: 'error'; readonly response: ApiResponse } {
  return { kind: 'error', response: errorResponse(400, code, detail) };
}

/** 본문에서 읽은 초안 칸 — 없는 키는 `undefined`(고치기에서 "그대로"), `null` 은 "비운다". */
interface DraftPatch {
  readonly fromAddress?: string | null;
  readonly recipients?: readonly string[];
  readonly subject?: string | null;
  readonly text?: string;
  readonly html?: string | null;
  readonly inReplyTo?: string | null;
  readonly attachmentIds?: readonly string[];
  readonly revision?: number;
}

function parseDraftPatch(source: Record<string, unknown>): Parsed<DraftPatch> {
  const unknown = Object.keys(source).find((key) => !FIELDS.has(key));
  if (unknown !== undefined) return bad(`Unknown field: ${unknown.slice(0, 40)}`);
  const patch: { -readonly [K in keyof DraftPatch]: DraftPatch[K] } = {};

  if ('from' in source) {
    const from = source['from'];
    if (from === null) patch.fromAddress = null;
    else if (typeof from !== 'string' || !isAddressShape(from.trim())) return bad('from must be an email address or null.');
    else if (from.trim() !== normalizeAddress(from)) return bad('from must be in canonical form: lowercase and without a +tag. Use your registered sending address exactly.');
    else patch.fromAddress = from.trim();
  }
  if ('to' in source) {
    const to = source['to'];
    if (to === null) patch.recipients = [];
    else if (!Array.isArray(to) || to.some((item) => typeof item !== 'string')) return bad('to must be an array of email addresses.');
    else {
      const recipients = (to as string[]).map((item) => item.trim());
      if (recipients.length > MAX_DRAFT_RECIPIENTS) return bad(`to can list at most ${String(MAX_DRAFT_RECIPIENTS)} addresses.`);
      if (recipients.some((item) => item === '')) return bad('to contains an empty address.');
      const malformed = recipients.filter((address) => !isOutboundRecipientAddress(address));
      if (malformed.length > 0) return bad(invalidRecipientDetail(malformed), INVALID_RECIPIENT);
      patch.recipients = recipients;
    }
  }
  if ('subject' in source) {
    const subject = source['subject'];
    if (subject === null) patch.subject = null;
    else if (typeof subject !== 'string') return bad('subject must be a string or null.');
    else if (subject.length > MAX_DRAFT_SUBJECT_LENGTH) return bad(`subject must be at most ${String(MAX_DRAFT_SUBJECT_LENGTH)} characters.`);
    else patch.subject = subject;
  }
  if ('text' in source) {
    const text = source['text'];
    if (text === null) patch.text = '';
    else if (typeof text !== 'string') return bad('text must be a string.');
    else patch.text = text;
  }
  if ('html' in source) {
    const html = source['html'];
    if (html !== null && typeof html !== 'string') return bad('html must be a string or null.');
    patch.html = html as string | null;
  }
  if ('in_reply_to' in source) {
    const raw = source['in_reply_to'];
    if (raw === null) patch.inReplyTo = null;
    else if (typeof raw !== 'string' || !UUID_PATTERN.test(raw.trim().toLowerCase())) return bad('in_reply_to must be the id (uuid) of a received email, or null.');
    else patch.inReplyTo = raw.trim().toLowerCase();
  }
  if ('attachments' in source) {
    const raw = source['attachments'];
    if (raw === null) patch.attachmentIds = [];
    else if (
      !Array.isArray(raw) ||
      raw.length > MAX_DRAFT_ATTACHMENTS ||
      raw.some((item) => typeof item !== 'string' || !UUID_PATTERN.test(item)) ||
      new Set(raw).size !== raw.length
    ) {
      return bad(`attachments must be an array of at most ${String(MAX_DRAFT_ATTACHMENTS)} attachment ids (lowercase uuids) with no duplicates.`);
    } else patch.attachmentIds = raw as string[];
  }
  if ('revision' in source && source['revision'] !== null && source['revision'] !== undefined) {
    const revision = source['revision'];
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return bad('revision must be a positive integer.');
    patch.revision = revision;
  }
  return { kind: 'ok', value: patch };
}

function bodyObject(request: ApiRequest): Record<string, unknown> | null {
  const body = request.body;
  return isJsonObject(body) ? body : null;
}

/** 답장 대상이 이 에이전트에게 보이는 메일인가 — 없거나 격리면 404(없는 메일과 같다). */
async function replyTargetMissing(deps: DraftRouteDependencies, agentId: AgentId, inReplyTo: string | null | undefined): Promise<ApiResponse | null> {
  if (inReplyTo === null || inReplyTo === undefined) return null;
  const target = await deps.replyTargets.find(agentId, inReplyTo);
  if (target === null || target.quarantined) return errorResponse(404, 'message_not_found', `No received email matches in_reply_to=${inReplyTo}.`);
  return null;
}

/**
 * 본문 객체 읽기 — 없으면 `null`. 초안 본문은 메일 본문과 같은 보존(365일 — S3 수명주기 `ExpireOutboundDrafts`)을 받는다(배포 전 보안 리뷰: 버린 초안 · 오래된 판이
 * 끝없이 쌓이지 않게). 1년 넘게 고치지 않은 초안의 본문은 사라진다 — 410 `draft_content_expired`(새로 만든다).
 */
export async function loadContent(store: DraftContentStore, row: DraftRow): Promise<DraftContent | null> {
  try {
    return await store.load(row.id, row.revision);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) return null;
    throw error;
  }
}

export function draftContentExpired(): ApiResponse {
  return errorResponse(410, 'draft_content_expired', 'This draft’s body is older than the one-year retention and is gone. Create a new draft.');
}

function tooLarge(): ApiResponse {
  return errorResponse(413, 'draft_too_large', `The draft body (text + html) must be at most ${String(MAX_DRAFT_CONTENT_BYTES)} bytes.`);
}

function storageLimit(): ApiResponse {
  return errorResponse(429, 'draft_storage_limit', 'This agent’s open drafts already use 100 MiB. Send or discard some before saving more.');
}

/** 새 판 번호를 고를 때 건너뛸 수 있는 참조되지 않은 객체 수 상한. */
const MAX_REVISION_SKIPS = 8;

/**
 * 다음 판의 본문을 쓴다. 판 번호는 행의 판 + 1 부터 — 그 키에 **참조되지 않은 다른 내용**의 객체가 이미 있으면(앞선 고치기가 객체를 쓴 뒤 행을 갱신하지 못하고
 * 죽었다 · 같은 판을 다투던 다른 요청이 썼다) 행이 아직 그 판인지 확인하고 다음 번호로 넘어간다(배포 전 보안 리뷰 — 초안이 영영 `draft_revision_conflict` 에
 * 묶이지 않게). 행이 그새 바뀌었으면 그때가 진짜 충돌이다. 행 갱신은 `expectedRevision` 으로 줄 세우므로 둘 중 하나만 이긴다.
 */
async function writeNextRevision(
  deps: DraftRouteDependencies,
  agentId: AgentId,
  row: DraftRow,
  content: DraftContent,
): Promise<{ readonly kind: 'ok'; readonly key: string; readonly bytes: number; readonly revision: number } | { readonly kind: 'error'; readonly response: ApiResponse }> {
  const bytes = deps.content.sizeOf(content);
  if (bytes > MAX_DRAFT_CONTENT_BYTES) return { kind: 'error', response: tooLarge() };
  for (let revision = row.revision + 1; revision <= row.revision + MAX_REVISION_SKIPS; revision += 1) {
    try {
      await deps.content.put(row.id, revision, content);
      return { kind: 'ok', key: deps.content.keyFor(row.id, revision), bytes, revision };
    } catch (error) {
      if (!(error instanceof ObjectAlreadyExistsError)) throw error;
      const current = await deps.drafts.find(agentId, row.id);
      if (current === null || current.revision !== row.revision) return { kind: 'error', response: revisionConflict() };
    }
  }
  return { kind: 'error', response: revisionConflict() };
}

function revisionConflict(): ApiResponse {
  return errorResponse(409, 'draft_revision_conflict', 'The draft was changed by another request. Read it again (GET /v1/drafts/{id}) and retry with its revision.');
}

/** 굳은 초안(보내는 중 · 보냄 · 버림)을 고치거나 버리려 했다. */
function frozen(row: DraftRow): ApiResponse {
  const status = draftStatus(row);
  if (status === 'sent') return { status: 409, body: { error: 'draft_already_sent', detail: 'This draft was already sent and cannot change.', message_id: row.sentMessageId } };
  if (status === 'discarded') return errorResponse(409, 'draft_discarded', 'This draft was discarded and cannot change.');
  return errorResponse(409, 'draft_send_in_progress', 'This draft is being sent and cannot change. Retry the send with the same Idempotency-Key to get its result.');
}

function principalAgent(deps: DraftRouteDependencies, request: ApiRequest): Promise<AgentAccessOutcome> {
  return authorizeAgentRequest(deps.tokens, request, deps.now(), 'messages:send', null);
}

// ---------------------------------------------------------------------------
// 라우트
// ---------------------------------------------------------------------------

export async function handleCreateDraft(deps: DraftRouteDependencies, request: ApiRequest): Promise<ApiResponse> {
  const source = bodyObject(request);
  if (source === null) return errorResponse(400, 'invalid_request', 'The request body must be a JSON object.');
  // `agent_id` 생략 = 토큰의 에이전트. 적었으면 형식 검사(400)는 인증 전, 인가는 그 값으로 — 오늘과 같다.
  const agentIdRaw = source['agent_id'];
  if (agentIdRaw !== undefined && (typeof agentIdRaw !== 'string' || !isAgentId(agentIdRaw))) return errorResponse(400, 'invalid_request', 'agent_id must be 32 lowercase hex characters.');

  const access = await authorizeAgentRequest(deps.tokens, request, deps.now(), 'messages:send', agentIdRaw === undefined ? null : toAgentId(agentIdRaw));
  if (access.kind === 'error') return access.response;
  const { agentId } = access;

  const parsed = parseDraftPatch(source);
  if (parsed.kind === 'error') return parsed.response;
  const patch = parsed.value;
  if (patch.revision !== undefined) return errorResponse(400, 'invalid_request', 'revision is only for PATCH /v1/drafts/{id}.');
  const missing = await replyTargetMissing(deps, agentId, patch.inReplyTo);
  if (missing !== null) return missing;

  const id = randomUUID();
  const content: DraftContent = { text: patch.text ?? '', html: patch.html ?? null };
  const bytes = deps.content.sizeOf(content);
  if (bytes > MAX_DRAFT_CONTENT_BYTES) return tooLarge();
  const fields: DraftFields = {
    fromAddress: patch.fromAddress ?? null,
    recipients: patch.recipients ?? [],
    subject: patch.subject ?? null,
    inReplyTo: patch.inReplyTo ?? null,
    attachmentIds: patch.attachmentIds ?? [],
    contentStorageKey: deps.content.keyFor(id, 1),
    contentBytes: bytes,
  };
  // 행이 먼저다(배포 전 보안 리뷰): 상한(500 · 100 MiB) · 오류로 행이 못 들어가면 본문 객체를 쓰지 않는다. 객체 쓰기는 행을 넣은 트랜잭션 안에서 커밋 전에 —
  //   쓰기가 실패하면 행도 되돌린다(새 uuid 라 같은 키 경합은 없다).
  const inserted = await deps.drafts.insert(agentId, id, fields, () => deps.content.put(id, 1, content));
  if (inserted.kind === 'limit') {
    return errorResponse(429, 'draft_limit', 'This agent has 500 open drafts. Send or discard some before creating more.');
  }
  if (inserted.kind === 'storage_limit') return storageLimit();
  return jsonResponse(201, draftBody(inserted.row, { text: patch.text ?? '', html: patch.html ?? null }));
}

export async function handleListDrafts(deps: DraftRouteDependencies, request: ApiRequest): Promise<ApiResponse> {
  // `agent_id` 생략 = 토큰의 에이전트(`auth.claimedAgentOfQuery`). 적었으면 형식 검사(400)는 인증 전, 인가는 그 값으로.
  const claimed = claimedAgentOfQuery(request);
  if (claimed.kind === 'error') return claimed.response;
  const paged = pageLimitOf(request, DEFAULT_DRAFT_PAGE_SIZE, MAX_DRAFT_PAGE_SIZE);
  if (paged.kind === 'error') return paged.response;
  const { limit } = paged;
  const statusRaw = queryOf(request, 'status') ?? 'active';
  if (!(DRAFT_STATUSES as readonly string[]).includes(statusRaw)) {
    return errorResponse(400, 'invalid_request', `status must be one of: ${DRAFT_STATUSES.join(', ')}.`);
  }
  const status = statusRaw as DraftListStatus;
  const cursorRaw = queryOf(request, 'cursor');
  const cursor = cursorRaw === null ? null : decodeDraftCursor(cursorRaw, status);
  if (cursorRaw !== null && cursor === null) return errorResponse(400, 'invalid_request', 'cursor is not valid (it continues a listing with the same status).');

  const access = await authorizeAgentRequest(deps.tokens, request, deps.now(), 'messages:send', claimed.agentId);
  if (access.kind === 'error') return access.response;
  const { agentId } = access;

  const rows = await deps.drafts.list(agentId, { limit: limit + 1, cursor, status });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeDraftCursor(last, status));
  return jsonResponse(200, {
    agent_id: agentId,
    drafts: page.map(draftSummaryBody),
    next_cursor: nextCursor,
  });
}

export async function handleGetDraft(deps: DraftRouteDependencies, request: ApiRequest, params: { readonly draftId: string }): Promise<ApiResponse> {
  if (!UUID_PATTERN.test(params.draftId)) return errorResponse(400, 'invalid_request', 'draft id must be a lowercase uuid.');
  const principal = await principalAgent(deps, request);
  if (principal.kind === 'error') return principal.response;
  const row = await deps.drafts.find(principal.agentId, params.draftId);
  if (row === null) return draftNotFound(params.draftId);
  const content = await loadContent(deps.content, row);
  if (content === null) return draftContentExpired();
  return jsonResponse(200, draftBody(row, content));
}

export async function handleUpdateDraft(deps: DraftRouteDependencies, request: ApiRequest, params: { readonly draftId: string }): Promise<ApiResponse> {
  if (!UUID_PATTERN.test(params.draftId)) return errorResponse(400, 'invalid_request', 'draft id must be a lowercase uuid.');
  const source = bodyObject(request);
  if (source === null) return errorResponse(400, 'invalid_request', 'The request body must be a JSON object.');
  const principal = await principalAgent(deps, request);
  if (principal.kind === 'error') return principal.response;
  const agentId = principal.agentId;
  if (source['agent_id'] !== undefined && source['agent_id'] !== agentId) {
    return errorResponse(400, 'path_body_mismatch', 'agent_id in the body does not match the agent of your token.');
  }
  const parsed = parseDraftPatch(source);
  if (parsed.kind === 'error') return parsed.response;
  const patch = parsed.value;

  const row = await deps.drafts.find(agentId, params.draftId);
  if (row === null) return draftNotFound(params.draftId);
  if (draftStatus(row) !== 'active') return frozen(row);
  if (patch.revision !== undefined && patch.revision !== row.revision) return revisionConflict();
  const missing = await replyTargetMissing(deps, agentId, patch.inReplyTo);
  if (missing !== null) return missing;

  const previous = await loadContent(deps.content, row);
  if (previous === null) return draftContentExpired();
  const content: DraftContent = { text: patch.text ?? previous.text, html: patch.html === undefined ? previous.html : patch.html };
  const written = await writeNextRevision(deps, agentId, row, content);
  if (written.kind === 'error') return written.response;
  const updated = await deps.drafts.update(agentId, row.id, row.revision, {
    fromAddress: patch.fromAddress === undefined ? row.fromAddress : patch.fromAddress,
    recipients: patch.recipients ?? row.recipients,
    subject: patch.subject === undefined ? row.subject : patch.subject,
    inReplyTo: patch.inReplyTo === undefined ? row.inReplyTo : patch.inReplyTo,
    attachmentIds: patch.attachmentIds ?? row.attachmentIds,
    contentStorageKey: written.key,
    contentBytes: written.bytes,
  }, written.revision);
  if (updated.kind === 'not_found') return draftNotFound(params.draftId);
  if (updated.kind === 'storage_limit') return storageLimit();
  if (updated.kind === 'conflict') return draftStatus(updated.row) === 'active' ? revisionConflict() : frozen(updated.row);
  return jsonResponse(200, draftBody(updated.row, content));
}

export async function handleDiscardDraft(deps: DraftRouteDependencies, request: ApiRequest, params: { readonly draftId: string }): Promise<ApiResponse> {
  if (!UUID_PATTERN.test(params.draftId)) return errorResponse(400, 'invalid_request', 'draft id must be a lowercase uuid.');
  const principal = await principalAgent(deps, request);
  if (principal.kind === 'error') return principal.response;
  const discarded = await deps.drafts.discard(principal.agentId, params.draftId);
  if (discarded.kind === 'not_found') return draftNotFound(params.draftId);
  if (discarded.kind === 'storage_limit') throw new Error('버리기는 저장 상한에 걸리지 않는다');
  if (discarded.kind === 'conflict') {
    // 이미 버린 초안을 다시 버리는 것은 같은 결과다(멱등).
    if (draftStatus(discarded.row) === 'discarded') return jsonResponse(200, draftSummaryBody(discarded.row));
    return frozen(discarded.row);
  }
  return jsonResponse(200, draftSummaryBody(discarded.row));
}

export function draftNotFound(draftId: string): ApiResponse {
  return errorResponse(404, 'draft_not_found', `No draft with draft_id=${draftId}.`);
}

// ---------------------------------------------------------------------------
// 커서 — (updated_at, id, 상태)
// ---------------------------------------------------------------------------

function encodeDraftCursor(row: Pick<DraftRow, 'updatedAt' | 'id'>, status: DraftListStatus): string {
  return Buffer.from(`${row.updatedAt.toISOString()}|${row.id}|${status}`, 'utf8').toString('base64url');
}

function decodeDraftCursor(value: string, status: DraftListStatus): { readonly updatedAt: Date; readonly id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) return null;
  const [at, id, cursorStatus, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (at === undefined || id === undefined || rest.length > 0 || !UUID_PATTERN.test(id) || cursorStatus !== status) return null;
  const updatedAt = new Date(at);
  if (Number.isNaN(updatedAt.getTime()) || updatedAt.toISOString() !== at) return null;
  return { updatedAt, id };
}
