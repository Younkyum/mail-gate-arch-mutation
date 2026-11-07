/**
 * src/api/outbound-http.ts — HTTP 본문 ↔ 도메인 요청/결과 번역. **라우트 4종이 공유한다.**
 *
 * 번역을 한곳에 모으는 이유는 **네 경로가 같은 계약(같은 본문 검증)을 갖게 하기 위해서**다.
 */

import type { AgentId } from '../db/schema';
import { isAgentId, toAgentId } from '../db/schema';
import { isOutboundRecipientAddress } from '../policy/contact-rules';
import { isAddressShape, normalizeAddress } from '../policy/policy-loader';
import type { Decision } from '../policy/types';
import { errorResponse, isJsonObject, jsonResponse, UUID_PATTERN, type ApiResponse } from './http';
import type { OutboundMessageSnapshot } from './outbound-store';
import { publicReasons } from './public-codes';
import type { OutboundOutcome, OutboundSendRequest } from './outbound-service';

/** 본문 파싱 결과. 실패는 **응답 그 자체**다 — 예외로 만들면 라우트마다 catch 가 생긴다. */
export type SendBodyOutcome =
  | { readonly kind: 'ok'; readonly value: ParsedSendBody }
  | { readonly kind: 'error'; readonly response: ApiResponse };

/** `routeId`·`idempotencyKey` 를 제외한 발송 요청 — 그 둘은 라우트와 헤더가 준다. */
export interface ParsedSendBody {
  readonly agentId: AgentId;
  readonly fromAddress: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string | null;
  readonly traceId: string | null;
  readonly costCents: number;
  /** 첨부 id(A2, 자리 순 · ≤ 10 · 중복 없음). 없으면 빈 배열. `send`·`reply` 만 쓴다 — 다른 경로는 있으면 400(`rejectAttachmentsOn`). */
  readonly attachmentIds: readonly string[];
}

/** 첨부를 받지 않는 경로(D8 — 전달·초안·예약·전환 공지)가 `attachments` 를 받았을 때의 오류 코드. */
const ATTACHMENTS_NOT_SUPPORTED = 'attachments_not_supported';

/** 한 메일의 첨부 id 상한 — `src/api/outbound-attachments.ts` `MAX_ATTACHMENTS_PER_MESSAGE` 와 같다(DB 자리 0~9). */
const MAX_ATTACHMENT_IDS = 10;

/** 원 본문에 `attachments` 키가 있으면(값과 무관하게) 400 — 조용히 버리면 에이전트는 첨부가 나갔다고 믿는다. */
export function rejectAttachmentsOn(routeLabel: string, body: unknown): ApiResponse | null {
  if (!isJsonObject(body)) return null;
  const value = body['attachments'];
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return null;
  return errorResponse(400, ATTACHMENTS_NOT_SUPPORTED, `Attachments are not supported for ${routeLabel}. Only new emails (POST /v1/messages) and replies can carry attachments.`);
}

function badRequest(detail: string, code: string = 'invalid_request'): { readonly kind: 'error'; readonly response: ApiResponse } {
  return { kind: 'error', response: errorResponse(400, code, detail) };
}

/**
 * 502 `send_failed` 의 공개 `detail`. 전송단이 던진 원인 문장(공급자 SDK 오류·저장소 오류)은 `messages.failure_reason` 과 로그에만 남기고
 * 응답에는 싣지 않는다 — 공급자 이름·내부 키가 에이전트 컨텍스트와 MCP 결과로 새지 않게. 재시도 안내는 MCP 도구가 따로 준다.
 */
export const SEND_FAILED_DETAIL = 'Sending failed. The email was not sent.';

/** 수신자 모양 거부의 오류 코드(400). MCP 도구는 같은 검사를 인자 단계에서 `invalid_arguments` 로 한다(`mcp/tools.ts`). */
export const INVALID_RECIPIENT = 'invalid_recipient';

/** 수신자 모양 거부의 안내 — 라우트(`reply.ts` 기본 수신자)와 MCP 도구가 같은 문장을 쓴다. */
export function invalidRecipientDetail(malformed: readonly string[]): string {
  return (
    `to has address(es) that cannot be emailed: ${JSON.stringify(malformed)}. ` +
    'Use plain ASCII addresses like name@example.com (no quoted local parts, trailing dots, backslashes, IP literals or non-ASCII).'
  );
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 발송 본문 파싱.
 *
 * **모르는 필드는 무시하지만 잘못된 필드는 거부한다.** 관대함의 방향이 중요하다 —
 * 미래의 필드(`attachments` 등)를 거부하면 클라이언트가 못 올라오고, 타입이 틀린 현재
 * 필드를 통과시키면 그 값이 정책 판정의 입력이 된다.
 */
export function parseSendBody(body: unknown): SendBodyOutcome {
  const common = parseCommon(body);
  if (common.kind === 'error') return common;
  const source = common.source;
  const fromAddress = common.value.fromAddress;
  if (fromAddress === null) return badRequest('from is required.');

  const recipients = parseRecipients(source['to']);
  if ('code' in recipients) return badRequest(recipients.detail, recipients.code);

  const subject = typeof source['subject'] === 'string' ? source['subject'] : null;
  if (subject === null) return badRequest('subject is required.');

  return { kind: 'ok', value: { ...common.value, fromAddress, recipients, subject } };
}

/**
 * 두 본문(send·reply)이 공유하는 필드. 수신자·제목은 경로마다 규칙이 달라 여기 없다. `from` 은 여기서 **선택**이다 — `send` 는 필수로 되묻고
 * (`parseSendBody`), `reply` 는 생략하면 라우트가 기본값을 정한다(받은 봉투 주소가 활성 주소면 그것, 아니면 대표 — 리드 판정 2026-09-27).
 */
type CommonFields = Omit<ParsedSendBody, 'recipients' | 'subject' | 'fromAddress'> & { readonly fromAddress: string | null };

type CommonOutcome =
  | { readonly kind: 'ok'; readonly source: Record<string, unknown>; readonly value: CommonFields }
  | { readonly kind: 'error'; readonly response: ApiResponse };

function parseCommon(body: unknown): CommonOutcome {
  if (!isJsonObject(body)) {
    return badRequest('The request body must be a JSON object.');
  }
  const source = body;

  const agentIdRaw = readString(source, 'agent_id');
  if (agentIdRaw === null || !isAgentId(agentIdRaw)) {
    return badRequest('agent_id must be 32 lowercase hex characters.');
  }

  const fromAddress = readString(source, 'from');
  if (fromAddress !== null && !isAddressShape(fromAddress)) {
    return badRequest('from is not an email address (exactly one @, no spaces or line breaks).');
  }
  // **정책이 판정한 문자열과 SES 로 나가는 문자열이 갈라지지 않게 `from` 은 정규형만 받는다**(P1b 리뷰 MAJOR 4).
  // `normalizeAddress` 는 소문자화 + `+tag` 절단을 한다 — `from: "demo-x+anything@…"` 을 받으면 정규형으로 Stage 1 을 지나
  // SES 는 `+anything` 주소로 보낸다(주소 전역 UNIQUE 가 서브어드레싱 축에서 열리고 `from_address_hash` 조인도 깨진다).
  // 정규형으로 바꿔 보내면 요청하지 않은 주소로 나가므로 거부한다. `+tag` 를 정체성으로 쓰려면 그 주소를 등록한다.
  if (fromAddress !== null && fromAddress !== normalizeAddress(fromAddress)) {
    return badRequest(
      'from must be in canonical form: lowercase and without a +tag. Use your registered sending address exactly.',
    );
  }

  const text = typeof source['text'] === 'string' ? source['text'] : null;
  if (text === null) return badRequest('text is required (every email has a plain-text part).');

  const htmlRaw = source['html'];
  if (htmlRaw !== undefined && htmlRaw !== null && typeof htmlRaw !== 'string') {
    return badRequest('html must be a string or null.');
  }
  const html = typeof htmlRaw === 'string' ? htmlRaw : null;

  // 첨부 id(A2) — 모양만 본다(소유·스캔은 발송 준비가 본다). 빈 배열은 "없음" 이다.
  const attachmentsRaw = source['attachments'];
  let attachmentIds: readonly string[] = [];
  if (attachmentsRaw !== undefined && attachmentsRaw !== null) {
    if (
      !Array.isArray(attachmentsRaw) ||
      attachmentsRaw.length > MAX_ATTACHMENT_IDS ||
      attachmentsRaw.some((item) => typeof item !== 'string' || !UUID_PATTERN.test(item)) ||
      new Set(attachmentsRaw).size !== attachmentsRaw.length
    ) {
      return badRequest(`attachments must be an array of at most ${String(MAX_ATTACHMENT_IDS)} attachment ids (lowercase uuids) with no duplicates.`);
    }
    attachmentIds = attachmentsRaw as string[];
  }

  const costRaw = source['cost_cents'];
  if (costRaw !== undefined && (typeof costRaw !== 'number' || !Number.isInteger(costRaw) || costRaw < 0)) {
    // 음수 비용 하나가 Stage 5 의 부등호를 뒤집어 예산을 무제한으로 연다
    // (`policy-loader.ts` 의 `requireNonNegativeInt` 가 같은 이유로 존재한다).
    return badRequest('cost_cents must be a non-negative integer.');
  }

  return {
    kind: 'ok',
    source,
    value: {
      agentId: toAgentId(agentIdRaw),
      fromAddress,
      text,
      html,
      traceId: readString(source, 'trace_id'),
      costCents: typeof costRaw === 'number' ? costRaw : 0,
      attachmentIds,
    },
  };
}

/** `to` 배열 → 수신자. 실패는 오류 코드와 사유. */
function parseRecipients(toRaw: unknown): readonly string[] | { readonly code: string; readonly detail: string } {
  if (!Array.isArray(toRaw) || toRaw.length === 0 || toRaw.some((item) => typeof item !== 'string')) {
    return { code: 'invalid_request', detail: 'to must be a non-empty array of strings.' };
  }
  const recipients = (toRaw as readonly string[]).map((item) => item.trim()).filter((item) => item !== '');
  if (recipients.length !== toRaw.length) return { code: 'invalid_request', detail: 'to contains an empty address.' };
  // **수신자는 정규형(소문자·`+tag` 절단)을 요구하지 않는다** — `+tag` 는 수신자가 자기 메일함을 분류하려고
  // 붙인 것이고, 우리가 지워서 보낼 이유가 없다(`normalizeAddress` 주석). 대신 **모양은 좁게 요구한다**(202609241040 — 검증 M2):
  // ASCII dot-atom `로컬@도메인` 만(`contact-rules.ts` `isOutboundRecipientAddress`). 따옴표 로컬파트(`"bad"@x.com`)·끝 점
  // 도메인(`bad@x.com.`)·역슬래시는 같은 메일함의 다른 철자라 차단·억제 비교를 비껴갔다. 공백·개행(`\r\nBcc: …`)도 여기서 죽는다.
  const malformed = recipients.filter((address) => !isOutboundRecipientAddress(address));
  if (malformed.length > 0) return { code: INVALID_RECIPIENT, detail: invalidRecipientDetail(malformed) };
  return recipients;
}

// ---------------------------------------------------------------------------
// reply 본문 (P3b)
// ---------------------------------------------------------------------------


/**
 * `POST /v1/threads/:id/reply` 의 본문. `send` 와 다른 것:
 *   - `in_reply_to` (필수) — **답하는 수신 메일의 id**(`inbound_messages.id`). 그 메일의 권한용 스레드가 경로의
 *     `:id` 와 같아야 한다(라우트가 확인한다).
 *   - `to` (선택) — 없으면 **답하는 메일의 인증된 `From`**. `Reply-To` 는 쓰지 않는다(`routes/reply.ts` 머리말).
 *   - `subject` (선택) — 없으면 `Re: <받은 제목>`.
 */
export interface ParsedReplyBody extends CommonFields {
  readonly inReplyTo: string;
  readonly recipients: readonly string[] | null;
  readonly subject: string | null;
}

export type ReplyBodyOutcome =
  | { readonly kind: 'ok'; readonly value: ParsedReplyBody }
  | { readonly kind: 'error'; readonly response: ApiResponse };

export function parseReplyBody(body: unknown): ReplyBodyOutcome {
  const common = parseCommon(body);
  if (common.kind === 'error') return common;
  const source = common.source;

  const inReplyTo = readString(source, 'in_reply_to')?.toLowerCase() ?? null;
  if (inReplyTo === null || !UUID_PATTERN.test(inReplyTo)) {
    return badRequest('in_reply_to must be the id (uuid) of the received email you are replying to.');
  }
  let recipients: readonly string[] | null = null;
  if (source['to'] !== undefined && source['to'] !== null) {
    const parsed = parseRecipients(source['to']);
    if ('code' in parsed) return badRequest(parsed.detail, parsed.code);
    recipients = parsed;
  }

  const subjectRaw = source['subject'];
  if (subjectRaw !== undefined && subjectRaw !== null && typeof subjectRaw !== 'string') {
    return badRequest('subject must be a string or omitted.');
  }

  return {
    kind: 'ok',
    value: {
      ...common.value,
      inReplyTo,
      recipients,
      subject: typeof subjectRaw === 'string' ? subjectRaw : null,
    },
  };
}

/** 파싱된 본문 + 라우트 문맥 → 서비스 요청. */
export function toSendRequest(
  parsed: ParsedSendBody,
  routeId: string,
  idempotencyKey: string,
  isThreadReply: false,
): OutboundSendRequest {
  return {
    routeId,
    agentId: parsed.agentId,
    idempotencyKey,
    fromAddress: parsed.fromAddress,
    recipients: parsed.recipients,
    subject: parsed.subject,
    text: parsed.text,
    html: parsed.html,
    isThreadReply,
    traceId: parsed.traceId,
    costCents: parsed.costCents,
    ...(parsed.attachmentIds.length === 0 ? {} : { attachmentIds: parsed.attachmentIds }),
  };
}

/**
 * audit 와 같은 세 축을 응답에도 싣는다 — AC-9 가 API 쪽에서도 답할 수 있어야 한다.
 * 사유는 **공개 이름**으로 나간다(`public-codes.ts`) — audit 행은 내부 이름 그대로다.
 */
export function decisionBody(decision: Decision): Record<string, unknown> {
  return {
    verdict: decision.verdict,
    reasons: publicReasons(decision.reasons),
    policy_version: decision.policyVersion,
    policy_version_id: decision.policyVersionId,
    evaluated_at: decision.evaluatedAt.toISOString(),
    retry_after_seconds: decision.retryAfterSeconds,
    // AC-a4 — "API 와 audit 양쪽에서 같은 수". audit 의 `bootstrap_grace_remaining` 과 같은 값이다.
    bootstrap_grace_remaining: decision.bootstrapGraceRemaining,
  };
}

/**
 * 재호출 응답 — **상태코드가 `messages` 행의 상태를 따른다.**
 *
 * 전부 200 으로 돌려주면 "보냈다" 와 "보내지 않았다" 가 같은 코드로 나간다. 그런데
 * 멱등 키를 소비한 시도 중에는 **정책이 막은 것**도 있다. 그 재호출에 200 을 주면
 * 클라이언트는 자기 메일이 나갔다고 믿는다 — 이 프로젝트가 막으려는 사고의 거울상이다.
 *
 * `denied` 는 최초 응답과 같은 403 이다(§4.5-1 — 동일 키 재호출은 최초 결과를 그대로). 판정의 *내용*(`reasons` 등)은
 * 재현하지 않고 audit 로의 포인터를 싣는다. `pending`·`dispatching` 은 202 — 둘 다 "아직 나가지 않았다" 로 참이다.
 */
function replayResponse(message: OutboundMessageSnapshot): ApiResponse {
  const base = {
    status: message.status,
    replayed: true,
    message_id: message.id,
    message_id_header: message.messageIdHeader,
    // 전송단이 매긴 id. 공개 이름은 공급자를 말하지 않는다(가림 정책) — 저장 컬럼 이름과 다르다.
    provider_message_id: message.sesMessageId,
  };

  const auditPointer = `The decision and its reasons are at GET /v1/audit?message_id=${message.id}.`;

  if (message.status === 'sent') return jsonResponse(200, base);
  if (message.status === 'failed') {
    return jsonResponse(502, { ...base, error: 'send_failed', detail: SEND_FAILED_DETAIL });
  }
  if (message.status === 'denied') {
    // **최초 응답과 같은 상태코드·같은 오류 코드다.** 이것이 §4.5-1 이 요구하는 재현이다.
    return jsonResponse(403, { ...base, error: 'policy_denied', detail: auditPointer });
  }
  // `pending` · `dispatching` — 아직 나가지 않았다(승인 대기 포함).
  return jsonResponse(202, {
    ...base,
    detail: `This email has not been sent yet. ${auditPointer}`,
  });
}

/**
 * 도메인 결과 → HTTP 응답.
 *
 * **거부는 403 이고 500 이 아니다.** 정책이 막은 것은 장애가 아니라 정상 동작이며,
 * 5xx 로 돌려주면 클라이언트 SDK 가 자동 재시도해 같은 거부를 반복 생성한다 —
 * audit 행이 그만큼 늘고, "왜 이 메일이 막혔는가" 의 신호 대 잡음비가 나빠진다.
 */
export function toApiResponse(outcome: OutboundOutcome): ApiResponse {
  switch (outcome.kind) {
    case 'sent':
      return jsonResponse(200, {
        status: 'sent',
        message_id: outcome.messageId,
        message_id_header: outcome.messageIdHeader,
        provider_message_id: outcome.sesMessageId,
        // `false` 는 "보냈는데 행 확정에 실패했다" — lease 를 잃은 뒤 돌아온 경우다.
        // 감추면 `messages` 와 실제 발송이 갈라진 상태를 아무도 모른다.
        settled: outcome.settled,
        decision: decisionBody(outcome.decision),
      });

    case 'replayed':
      return replayResponse(outcome.message);

    case 'denied':
      return jsonResponse(403, {
        error: 'policy_denied',
        message_id: outcome.messageId,
        decision: decisionBody(outcome.decision),
      });

    case 'pending_approval':
      // §3.4 1조 — **API 는 절대 블로킹하지 않는다.** 202 와 함께 요청 id·만료 시각을 돌려주고,
      // 에이전트는 폴링 대신 `approval.resolved` webhook(또는 `GET /v1/approvals/{id}`)을 기다린다.
      return jsonResponse(202, {
        status: 'pending_approval',
        message_id: outcome.messageId,
        approval_id: outcome.approval?.approvalId ?? null,
        expires_at: outcome.approval?.expiresAt.toISOString() ?? null,
        decision: decisionBody(outcome.decision),
      });

    case 'failed':
      return jsonResponse(502, {
        error: 'send_failed',
        detail: SEND_FAILED_DETAIL,
        message_id: outcome.messageId,
        decision: decisionBody(outcome.decision),
      });

    case 'conflict':
      return jsonResponse(409, {
        error: 'idempotency_key_reused',
        detail: outcome.detail,
        message_id: outcome.messageId,
      });

    case 'invalid':
      return errorResponse(400, 'invalid_request', outcome.detail);

    case 'attachment_rejected':
      return errorResponse(outcome.status, outcome.code, outcome.detail);
  }
}
