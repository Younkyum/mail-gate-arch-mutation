/**
 * `GET /v1/messages/inbound` · `GET /v1/messages/inbound/{id}` — 에이전트가 **받은 메일을 읽는 표면** (P3c, AC-3·AC-4).
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 읽기만 하며 관문을 import 하지 않는다.
 *
 * - **격리 메일은 없다.** 목록에도 상세에도 없다 — 저장소(`inbound-read-store.ts`)가 행째 거른다. 목록은 격리
 *   **개수**만 싣는다(판단: `api/inbound-view.ts` ①). 격리 id 의 상세는 없는 id 와 같은 404 다.
 * - **인가는 행을 읽은 뒤, 행이 말하는 소유자로** (`audit.ts`·`approvals.ts` 와 같은 규약). 목록은 대상 에이전트를
 *   쿼리의 `agent_id` 로 받는다 — **생략하면 토큰의 에이전트**(2026-10-11, `auth.claimedAgentOfQuery`), 적으면 그 값으로 인가한다.
 * - 본문은 S3 `inbound/parsed/{sesMessageId}.json` 에서 읽는다(Postgres 에 없다, PRD). `text` 와 `html_text` 둘 다.
 * - **목록 필터**(메일 기본기 A5 · D3): `from`|`from_domain`(정확 일치, 둘을 함께 주면 400) · `since`·`until`(반열림 `[since, until)`) ·
 *   `thread_id`. 격리 필터는 없다 — `quarantined` 를 주면 400 `unsupported_filter`(격리는 소유자 콘솔만 본다). 필터는 저장소 SQL 이
 *   `visibleToAgent` 와 **함께** 건다. 커서에는 필터 지문이 들어가고, 다른 필터로 이어 읽으면 400 이다.
 */

import { createHash } from 'node:crypto';

import type { InboundListFilters } from '../../db/repositories/inbound-read-store';
import { authenticateRequest, authorizeAgentRequest, authorizeRequest, claimedAgentOfQuery } from '../auth';
import { LABEL_PATTERN } from '../../db/repositories/message-state-store';
import { log } from '../../observability/logger';
import { codesIn, recordExposureLevels } from '../exposure';
import { errorResponse, jsonResponse, pageLimitOf, pageOf, queryOf, UUID_PATTERN, type ApiRequest, type ApiResponse } from '../http';
import {
  decodeCursor,
  decodeParsedDocument,
  detailBody,
  encodeCursor,
  riskBody,
  stateBody,
  summaryBody,
  type InboundReadDependencies,
} from '../inbound-view';

const DEFAULT_INBOUND_PAGE_SIZE = 20;
const MAX_INBOUND_PAGE_SIZE = 100;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;

function instantOf(raw: string): Date | null {
  const parsed = new Date(raw);
  return ISO_INSTANT.test(raw) && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

/**
 * 필터 쿼리 → 저장소 필터. 틀리면 400 응답. 주소·도메인은 소문자로 맞춘다(행의 CHECK 가 소문자다 — 대소문자가 다르다고 0건이 되지 않게).
 */
export function parseInboundFilters(request: ApiRequest): { readonly kind: 'ok'; readonly filters: InboundListFilters } | { readonly kind: 'error'; readonly response: ApiResponse } {
  const fail = (detail: string, error = 'invalid_request') => ({ kind: 'error' as const, response: errorResponse(400, error, detail) });
  if (queryOf(request, 'quarantined') !== null) {
    return fail('The quarantined filter is not available to agents. Only the owner can see quarantined email, in the console.', 'unsupported_filter');
  }
  const from = queryOf(request, 'from');
  const fromDomain = queryOf(request, 'from_domain');
  if (from !== null && fromDomain !== null) return fail('Use either from or from_domain, not both.');
  const filters: { -readonly [K in keyof InboundListFilters]: InboundListFilters[K] } = {};
  if (from !== null) {
    const value = from.trim().toLowerCase();
    if (value.length > 320 || !/^[^@\s]+@[^@\s]+$/.test(value)) return fail('from must be a single email address (exact match).');
    filters.fromAddress = value;
  }
  if (fromDomain !== null) {
    const value = fromDomain.trim().toLowerCase();
    if (value.length === 0 || value.length > 253 || /[@\s]/.test(value)) return fail('from_domain must be a single domain (exact match).');
    filters.fromDomain = value;
  }
  const sinceRaw = queryOf(request, 'since');
  const untilRaw = queryOf(request, 'until');
  if (sinceRaw !== null) {
    const since = instantOf(sinceRaw);
    if (since === null) return fail('since must be an ISO 8601 time.');
    filters.since = since;
  }
  if (untilRaw !== null) {
    const until = instantOf(untilRaw);
    if (until === null) return fail('until must be an ISO 8601 time.');
    filters.until = until;
  }
  if (filters.since !== undefined && filters.until !== undefined && filters.since.getTime() >= filters.until.getTime()) {
    return fail('since must be earlier than until (since is inclusive, until is exclusive).');
  }
  const threadId = queryOf(request, 'thread_id');
  if (threadId !== null) {
    if (!UUID_PATTERN.test(threadId)) return fail('thread_id must be a lowercase uuid.');
    filters.threadId = threadId;
  }
  // 묶음 B — 라벨 · 라벨 없음 · 읽음.
  const label = queryOf(request, 'label');
  const unlabeled = queryOf(request, 'unlabeled');
  if (label !== null && unlabeled !== null) return fail('Use either label or unlabeled, not both.');
  if (label !== null) {
    if (!LABEL_PATTERN.test(label)) return fail('label must be lowercase letters, digits, ".", "_" or "-" (1-64 characters, starting with a letter or digit).');
    filters.label = label;
  }
  if (unlabeled !== null) {
    if (unlabeled !== 'true') return fail('unlabeled must be "true" (or omitted).');
    filters.unlabeled = true;
  }
  const read = queryOf(request, 'read');
  if (read !== null) {
    if (read !== 'true' && read !== 'false') return fail('read must be "true" or "false".');
    filters.read = read === 'true';
  }
  return { kind: 'ok', filters };
}

/** 필터 지문 — 같은 필터면 같은 값, 필터가 없으면 빈 문자열(커서가 예전 모양 그대로). */
export function filterFingerprint(filters: InboundListFilters): string {
  const parts = [
    filters.fromAddress ?? '',
    filters.fromDomain ?? '',
    filters.since?.toISOString() ?? '',
    filters.until?.toISOString() ?? '',
    filters.threadId ?? '',
    // 묶음 B — 있을 때만 칸이 생긴다(예전 필터의 지문 · 이미 나간 커서가 그대로 맞다).
    ...(filters.label === undefined && filters.unlabeled === undefined && filters.read === undefined
      ? []
      : [filters.label ?? '', filters.unlabeled === true ? 'unlabeled' : '', filters.read === undefined ? '' : String(filters.read)]),
  ];
  if (parts.every((part) => part === '')) return '';
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex').slice(0, 16);
}

export async function handleListInboundMessages(
  deps: InboundReadDependencies,
  request: ApiRequest,
): Promise<ApiResponse> {
  // `agent_id` 생략 = 토큰의 에이전트(`auth.claimedAgentOfQuery`). 적었으면 형식 검사(400)는 인증 전, 인가는 그 값으로.
  const claimed = claimedAgentOfQuery(request);
  if (claimed.kind === 'error') return claimed.response;
  const paged = pageLimitOf(request, DEFAULT_INBOUND_PAGE_SIZE, MAX_INBOUND_PAGE_SIZE);
  if (paged.kind === 'error') return paged.response;
  const { limit } = paged;
  const parsedFilters = parseInboundFilters(request);
  if (parsedFilters.kind === 'error') return parsedFilters.response;
  const filters = parsedFilters.filters;
  const fingerprint = filterFingerprint(filters);
  const cursorRaw = queryOf(request, 'cursor');
  const cursor = cursorRaw === null ? null : decodeCursor(cursorRaw);
  if (cursorRaw !== null && cursor === null) return errorResponse(400, 'invalid_request', 'cursor is not valid.');
  if (cursor !== null && cursor.fingerprint !== fingerprint) {
    return errorResponse(400, 'invalid_request', 'A cursor only continues a listing with the same filters (from, from_domain, since, until, thread_id, label, unlabeled, read).');
  }

  const access = await authorizeAgentRequest(deps.tokens, request, deps.now(), 'messages:read', claimed.agentId);
  if (access.kind === 'error') return access.response;
  const { agentId } = access;

  const rows = await deps.inbound.listVisible(agentId, {
    limit: limit + 1,
    cursor: cursor === null ? null : { receivedAt: cursor.receivedAt, id: cursor.id },
    filters,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeCursor({ receivedAt: last.receivedAt, id: last.id }, fingerprint));
  const quarantine = await deps.inbound.quarantineSummary(agentId);

  // ADR-0016 리뷰 M1 — 목록도 발신자·제목을 보인다: 돌려주기 **전에** 노출을 기록한다(실패 503). 등급은 스레드 보기와 같다(field=subject).
  const recorded = await recordExposureLevels(
    deps.exposures,
    agentId,
    'message_list',
    page.map((summary) => ({ inboundMessageId: summary.id, part: 'subject' as const, field: 'subject' as const, content: null })),
  );
  if (recorded.kind === 'refused') return recorded.response;
  // 묶음 B — `risk` · 라벨 · 읽음(보인 메일 id 로 한 번).
  const facts = await deps.messageState.riskFacts(agentId, page.map((summary) => summary.id));

  return jsonResponse(200, {
    agent_id: agentId,
    messages: page.map((summary, index) => ({
      ...summaryBody(summary),
      ...stateBody(facts.get(summary.id)),
      risk: riskBody(facts.get(summary.id), summary.injectionRisk, recorded.levels[index] ?? null),
    })),
    next_cursor: nextCursor,
    // ★ 존재는 개수로만. 발신자·제목·id·시각 없음(`inbound-view.ts` 판단 ①).
    quarantined: {
      count: quarantine.count,
      detail: 'Quarantined email is waiting for your owner to review it, and its content is hidden from you. Check with your owner before asking a sender to resend.',
    },
  });
}

export async function handleGetInboundMessage(
  deps: InboundReadDependencies,
  request: ApiRequest,
  params: { readonly inboundMessageId: string },
): Promise<ApiResponse> {
  if (!UUID_PATTERN.test(params.inboundMessageId)) {
    return errorResponse(400, 'invalid_request', 'message id must be a lowercase uuid.');
  }
  const authentication = await authenticateRequest(deps.tokens, request, deps.now());
  if (authentication.kind === 'error') return authentication.response;

  const detail = await deps.inbound.findVisible(params.inboundMessageId);
  // 없음과 격리가 **같은 응답**이다 — 격리 사실은 목록의 개수로만 나간다.
  if (detail === null) return errorResponse(404, 'message_not_found', `No received email with message_id=${params.inboundMessageId}.`);
  const forbidden = authorizeRequest(authentication.principal, 'messages:read', detail.agentId);
  if (forbidden !== null) return forbidden;

  const body = decodeParsedDocument(await deps.artifacts.readParsed(detail.parsedStorageKey));
  // ADR-0016 A — 본문을 돌려주기 **전에** 노출을 기록한다(실패 503). 본문 속 코드 후보의 지문도(배선 계약 3).
  const recorded = await recordExposureLevels(
    deps.exposures,
    detail.agentId,
    'message_detail',
    // Reply-To 는 공격자가 고르는 값이다 — 발신자 7일 창에 함께 넣는다(리뷰 M4).
    [{ inboundMessageId: detail.id, part: 'body', field: 'body', content: null, replyTo: body.replyTo.map((a) => a.address) }],
    codesIn(detail.id, { subject: body.subject, text: body.text, htmlText: body.htmlText }),
  );
  if (recorded.kind === 'refused') return recorded.response;
  // 묶음 B — 처음 읽은 시각(최선 노력: 노출 기록과 달리 실패해도 본문을 준다 — 읽음 표시는 편의이고 판정의 입력이 아니다).
  try {
    await deps.messageState.markRead(detail.agentId, detail.id);
  } catch (error) {
    log('warn', 'inbound.mark_read_failed', {
      route_id: 'inbound_message_detail',
      agent_id: detail.agentId,
      error_kind: error instanceof Error ? error.name : typeof error,
    });
  }
  const facts = (await deps.messageState.riskFacts(detail.agentId, [detail.id])).get(detail.id);
  return jsonResponse(200, {
    ...detailBody(detail, body),
    ...stateBody(facts === undefined ? undefined : { ...facts, firstReadAt: facts.firstReadAt ?? deps.now() }),
    risk: riskBody(facts, detail.injectionRisk, recorded.levels[0] ?? null),
  });
}
