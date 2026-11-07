/**
 * `POST /v1/agents/:id/transition-announcement` — **주소 전환 공지** (`OUTBOUND_ROUTES.transition_announcement`,
 * 계획 §3.2 2단계 · AC-b1 · AC-b2).
 *
 * seed contacts 전원에게 "앞으로 이 건은 `<agent>@atmark.ai` 로" 1통씩. 런북은
 * `docs/runbooks/address-transition.md` 다.
 *
 * **모양 — 수신자당 시도 1건, 승인 요청 1개.**
 *   - 시도는 수신자마다 따로 관문을 지난다(`messages` 행 1 · audit 행 1). 20명이면 **시도 20건 = 20행**(§4.3).
 *   - 승인 대기가 된 시도들은 이 요청이 서버 쪽에서 만든 **공유 `approval_id`** 하나에 항목으로 붙는다
 *     (`DispatchRequest.batch` → `ApprovalRequest(subject='batch')`). 사람은 한 번 승인한다(AC-b1).
 *   - 이 경로는 **스스로 보내지 않는다.** 매니페스트의 `requiresHumanApproval` 표지 때문에 Stage 7 이
 *     여기서 `allowed` 를 내지 않는다 — 수신자가 바로 seed 라서(AC-a2 로 승인 없이 통과하는 상대) 표지가
 *     없으면 요청이 0개가 된다. 발송은 승인 뒤 `approval_release` 워커가 항목마다 관문을 재통과하며 한다.
 *     그래도 전송단은 **던지는 것**을 끼운다(`approvalOnlyTransport`) — 표지가 리팩터로 사라진 날에도 이
 *     경로에서 SES 가 불리지 않게. 표지가 1차, 전송단이 2차다.
 *
 * **부분 실패 — 배치 원자성이 아니라 수신자별 결말이다.** 한 명이 억제 목록에 있으면 그 한 명의 시도만
 * `denied` 로 끝나고(audit 1행, 요청 항목 없음), 나머지는 같은 요청으로 승인 대기가 된다. 근거:
 *   ① audit 규약이 "한 시도 = 한 행 = 한 결말" 이다. 배치 전체를 되돌리면 억제와 무관한 19명의 행이
 *      "억제 때문에 거부" 로 적혀 거짓이 된다.
 *   ② 원자성은 어차피 릴리스에서 성립하지 않는다 — 승인 뒤 각 항목은 관문을 **따로** 재통과하고
 *      (그 사이 캡·억제가 바뀔 수 있다), 나간 메일은 되돌릴 수 없다. 앞에서만 원자적인 척하면 승인 화면이
 *      약속하지 않은 것을 약속한다.
 *   ③ 거부된 상대는 사람에게 묻지 않는다(§4.2 원칙 1) — 억제된 상대가 승인 목록에 올라가지 않는다.
 * 응답은 수신자별 결과를 전부 싣는다(`results[]`). 거부가 섞여도 요청은 202 다 — 대기가 하나라도 있으면
 * 사람이 할 일이 있다.
 *
 * **멱등.** `Idempotency-Key` 필수(§4.5-1). 수신자별 시도의 키는 `(요청 키, 수신자)` 에서 파생한다 —
 * 같은 키의 재호출은 이미 시도된 상대에게 **최초 결과를 그대로** 돌려주고 새 평가도 새 요청도 없다.
 * 그 사이 seed 가 추가됐다면 그 상대만 새 시도가 된다. 한 키로 한 상대에게 가는 공지는 최대 1통이다.
 */

import { createHash, randomUUID } from 'node:crypto';

import { isAgentId, toAgentId, type AgentId } from '../../db/schema';
import { MAX_SEED_CONTACTS } from '../../identity/seed-contacts';
import { log } from '../../observability/logger';
import { countMetric, METRIC_NAMES } from '../../observability/metrics';
import { dispatch, type OutboundTransport, type TransportRequest } from '../../policy/gate';
import { isAddressShape, normalizeAddress } from '../../policy/policy-loader';
import { authenticateRequest, authorizeRequest, bodyWithDefaultAgent } from '../auth';
import { errorResponse, isJsonObject, jsonResponse, requireIdempotencyKey, type ApiRequest, type ApiResponse } from '../http';
import { decisionBody, rejectAttachmentsOn, SEND_FAILED_DETAIL } from '../outbound-http';
import {
  finalizeOutbound,
  gateDependenciesFor,
  prepareOutbound,
  type OutboundOutcome,
} from '../outbound-service';
import type { OutboundRouteDependencies } from '../route-context';
import type { SeedContactReader } from '../seed-contact-store';
import {
  ANNOUNCEMENT_LANGUAGES,
  ownerNameProblem,
  renderTransitionAnnouncement,
  type AnnouncementLanguage,
} from '../transition-announcement-template';

const TRANSITION_ANNOUNCEMENT_ROUTE_ID = 'transition_announcement';

/** 이 경로의 전송단이 던지는 사유. 이 문자열이 audit·messages 에 보이면 표지가 사라진 것이다. */
const TRANSITION_ANNOUNCEMENT_DIRECT_SEND_REFUSED = 'transition_announcement_sends_only_via_approval_release';

export interface TransitionAnnouncementDependencies extends OutboundRouteDependencies {
  readonly seeds: SeedContactReader;
}

/**
 * 이 경로의 전송단 — **항상 던진다.** 승인 전 SES 0회(AC-b1)의 2차 방어선이다(머리말).
 * 정상 경로에서는 불리지 않는다: 표지 때문에 관문이 `allowed` 를 내지 않으므로 전송단에 닿지 않는다.
 */
function approvalOnlyTransport(): OutboundTransport {
  return {
    send(_request: TransportRequest): Promise<{ readonly sesMessageId: string }> {
      return Promise.reject(new Error(TRANSITION_ANNOUNCEMENT_DIRECT_SEND_REFUSED));
    },
  };
}

// ---------------------------------------------------------------------------
// 관문 앞
// ---------------------------------------------------------------------------

interface AnnouncementBody {
  readonly agentId: AgentId;
  readonly fromAddress: string;
  readonly ownerName: string;
  readonly language: AnnouncementLanguage;
  readonly traceId: string | null;
  /** 수신자 1명당 시도의 예상 비용(센트). `send` 의 `cost_cents` 와 같은 뜻 — Stage 5 가 시도마다 더한다. */
  readonly costCents: number;
}

function badRequest(detail: string): { readonly kind: 'error'; readonly response: ApiResponse } {
  return { kind: 'error', response: errorResponse(400, 'invalid_request', detail) };
}

function trimmedString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 본문 — `agent_id`·`from`·`owner_name`·`language`(`ko` 기본)·`cost_cents`(0 기본). **`to`·`subject`·`text` 는 받지 않는다**:
 * 수신자는 seed 목록이고 문구는 고정 템플릿이다(`transition-announcement-template.ts` 머리말).
 */
function parseAnnouncementBody(
  body: unknown,
): { readonly kind: 'ok'; readonly value: AnnouncementBody } | { readonly kind: 'error'; readonly response: ApiResponse } {
  if (!isJsonObject(body)) return badRequest('The request body must be a JSON object.');
  const source = body;

  const agentIdRaw = trimmedString(source, 'agent_id');
  if (agentIdRaw === null || !isAgentId(agentIdRaw)) return badRequest('agent_id must be 32 lowercase hex characters.');

  const fromAddress = trimmedString(source, 'from');
  if (fromAddress === null || !isAddressShape(fromAddress)) return badRequest('from is not an email address.');
  // `send` 와 같은 규칙(`outbound-http.parseSendBody`) — 판정한 문자열과 보내는 문자열이 같아야 한다.
  // 여기서는 그 주소가 **공지 본문에 박히는** 값이기도 하다: 정규형이 아니면 상대가 저장할 주소가 틀린다.
  if (fromAddress !== normalizeAddress(fromAddress)) return badRequest('from must be in canonical form: lowercase and without a +tag.');

  const ownerName = trimmedString(source, 'owner_name');
  if (ownerName === null) return badRequest('owner_name is required (it signs the announcement).');
  const nameProblem = ownerNameProblem(ownerName);
  if (nameProblem !== null) return badRequest(nameProblem);

  const languageRaw = source['language'] ?? 'ko';
  const language = ANNOUNCEMENT_LANGUAGES.find((candidate) => candidate === languageRaw);
  if (language === undefined) return badRequest('language must be "ko" or "en".');

  const costRaw = source['cost_cents'] ?? 0;
  // 음수 비용 하나가 Stage 5 의 부등호를 뒤집는다 — `parseSendBody` 와 같은 검사다.
  if (typeof costRaw !== 'number' || !Number.isInteger(costRaw) || costRaw < 0) {
    return badRequest('cost_cents must be a non-negative integer.');
  }

  return {
    kind: 'ok',
    value: {
      agentId: toAgentId(agentIdRaw),
      fromAddress,
      ownerName,
      language,
      traceId: trimmedString(source, 'trace_id'),
      costCents: costRaw,
    },
  };
}

/** 관문 앞에서 죽은 요청 — `route-context.observeRejection` 과 같은 지표·로그 모양이다. */
function rejected(response: ApiResponse): ApiResponse {
  const code = response.body['error'];
  countMetric(METRIC_NAMES.preflightRejected, { route_id: TRANSITION_ANNOUNCEMENT_ROUTE_ID });
  log('warn', 'api.preflight_rejected', {
    route_id: TRANSITION_ANNOUNCEMENT_ROUTE_ID,
    http_status: response.status,
    error_code: typeof code === 'string' ? code : null,
  });
  return response;
}

/**
 * 수신자별 시도의 멱등 키. **(요청 키, 수신자)** 의 해시다 — 순서(index)를 쓰지 않는 이유는 seed 목록이
 * 호출 사이에 바뀌면 같은 index 가 다른 상대를 가리키기 때문이다. 길이는 고정(75자, 255 CHECK 안쪽).
 */
export function recipientIdempotencyKey(requestKey: string, recipient: string): string {
  const digest = createHash('sha256').update(requestKey).update('\n').update(recipient).digest('hex');
  return `transition:${digest}`;
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------

interface RecipientResult {
  readonly recipient: string;
  readonly outcome: OutboundOutcome;
}

export async function handleTransitionAnnouncement(
  deps: TransitionAnnouncementDependencies,
  request: ApiRequest,
): Promise<ApiResponse> {
  // 순서는 `route-context.preflight` 와 같다 — ① 멱등 키 ② 인증 ③ 본문 ④ 인가.
  const key = requireIdempotencyKey(request);
  if (key.kind === 'error') return rejected(key.response);

  const authentication = await authenticateRequest(deps.tokens, request, deps.service.now());
  if (authentication.kind === 'error') return rejected(authentication.response);

  // 첨부는 새 메일·답장만(D8) — 공지에 오면 400(조용히 버리지 않는다).
  const attachmentsHere = rejectAttachmentsOn('transition announcements', request.body);
  if (attachmentsHere !== null) return rejected(attachmentsHere);
  const body = parseAnnouncementBody(bodyWithDefaultAgent(request.body, authentication.principal));
  if (body.kind === 'error') return rejected(body.response);
  const announcement = body.value;

  const forbidden = authorizeRequest(authentication.principal, 'messages:send', announcement.agentId);
  if (forbidden !== null) return rejected(forbidden);

  const seeds = await deps.seeds.listSeedContacts(announcement.agentId);
  if (seeds.length === 0) {
    return rejected(
      errorResponse(409, 'no_seed_contacts', 'There are no seed contacts to announce to. Seed contacts are the contacts entered when the agent was set up.'),
    );
  }
  if (seeds.length > MAX_SEED_CONTACTS) {
    // 프로비저닝이 20개를 넘길 수 없다. 넘었다면 누군가 DB 에 손으로 넣은 것이고, 그 목록 전원에게
    // 한 번의 승인으로 보내는 것은 §3.2 가 "의도적" 이라 적은 상한을 우회하는 것이다.
    return rejected(
      errorResponse(409, 'seed_contacts_over_limit', `There are more than ${String(MAX_SEED_CONTACTS)} seed contacts (${String(seeds.length)}).`),
    );
  }

  const content = renderTransitionAnnouncement({
    agentAddress: announcement.fromAddress,
    ownerName: announcement.ownerName,
    language: announcement.language,
  });
  // **배치 전체가 같은 시계와 같은 요청 id 를 쓴다.** 시계가 같아야 항목들의 `created_at`/`expires_at` 이
  // 요청 하나의 것과 갈라지지 않는다. id 는 서버가 만든다 — 본문에서 받으면 남의 요청에 합류를 시도할 수 있다.
  const batchNow = deps.service.now();
  const batch = { approvalId: randomUUID() };
  const gateDeps = gateDependenciesFor(deps.service, approvalOnlyTransport());

  const results: RecipientResult[] = [];
  // **순차다.** 관문이 어차피 조직 단위로 직렬화하고(R22), 순서가 고정이어야 audit·응답이 결정적이다.
  for (const recipient of seeds) {
    const prepared = await prepareOutbound(deps.service, {
      routeId: TRANSITION_ANNOUNCEMENT_ROUTE_ID,
      agentId: announcement.agentId,
      idempotencyKey: recipientIdempotencyKey(key.key, recipient),
      fromAddress: announcement.fromAddress,
      recipients: [recipient],
      subject: content.subject,
      text: content.text,
      html: null,
      isThreadReply: false,
      traceId: announcement.traceId,
      costCents: announcement.costCents,
    });
    if (prepared.kind === 'settled') {
      results.push({ recipient, outcome: prepared.outcome });
      continue;
    }

    const dispatchRequest = { ...prepared.dispatchRequest, now: batchNow, batch };
    const outcome = await dispatch(gateDeps, dispatchRequest);
    results.push({ recipient, outcome: await finalizeOutbound(deps.service, { dispatchRequest }, outcome) });
  }

  return toAnnouncementResponse(results);
}

// ---------------------------------------------------------------------------
// 응답
// ---------------------------------------------------------------------------

function resultBody({ recipient, outcome }: RecipientResult): Record<string, unknown> {
  switch (outcome.kind) {
    case 'pending_approval':
      return {
        recipient,
        status: 'pending_approval',
        message_id: outcome.messageId,
        approval_id: outcome.approval?.approvalId ?? null,
        decision: decisionBody(outcome.decision),
      };
    case 'denied':
      return { recipient, status: 'denied', message_id: outcome.messageId, decision: decisionBody(outcome.decision) };
    case 'replayed':
      // 최초 판정의 내용은 audit 에 있다 — `outbound-http.replayResponse` 와 같은 한계·같은 포인터.
      return { recipient, status: outcome.message.status, replayed: true, message_id: outcome.message.id };
    case 'conflict':
      return { recipient, status: 'conflict', message_id: outcome.messageId, detail: outcome.detail };
    case 'failed':
      return { recipient, status: 'failed', message_id: outcome.messageId, detail: SEND_FAILED_DETAIL };
    case 'sent':
      return { recipient, status: 'sent', message_id: outcome.messageId };
    case 'invalid':
      return { recipient, status: 'invalid', detail: outcome.detail };
    case 'attachment_rejected':
      // 공지는 첨부를 싣지 않는다(D8) — 도달할 수 없지만 결말의 모양은 닫아 둔다.
      return { recipient, status: 'invalid', detail: outcome.detail };
  }
}

function isDenied(outcome: OutboundOutcome): boolean {
  return outcome.kind === 'denied' || (outcome.kind === 'replayed' && outcome.message.status === 'denied');
}

/**
 * 수신자별 결말 → 응답 하나.
 *
 * 우선순위: 멱등 충돌(409) → 입력 오류(400) → **대기가 하나라도 있으면 202** → 전원 거부면 403 →
 * 그 밖(이 경로에서 나오면 안 되는 `sent`·`failed`)은 502. 403 이 "전원" 일 때만인 이유는 머리말의 부분 실패
 * 판단 그대로다 — 한 명이 막혀도 나머지는 사람의 결정을 기다린다.
 */
export function toAnnouncementResponse(results: readonly RecipientResult[]): ApiResponse {
  const outcomes = results.map((result) => result.outcome);
  const body = results.map(resultBody);
  const pending = outcomes.filter((outcome) => outcome.kind === 'pending_approval');
  const counts = {
    recipients: results.length,
    pending_approval: pending.length,
    denied: outcomes.filter(isDenied).length,
    replayed: outcomes.filter((outcome) => outcome.kind === 'replayed').length,
  };

  const conflict = outcomes.find((outcome) => outcome.kind === 'conflict');
  if (conflict !== undefined) {
    return jsonResponse(409, {
      error: 'idempotency_key_reused',
      detail: 'This Idempotency-Key was already used for a different announcement (owner name, language or sending address).',
      counts,
      results: body,
    });
  }
  const invalid = outcomes.find((outcome) => outcome.kind === 'invalid');
  if (invalid?.kind === 'invalid') return errorResponse(400, 'invalid_request', invalid.detail);

  const opened = pending.find((outcome) => outcome.approval !== null);
  if (pending.length > 0 || outcomes.some((outcome) => outcome.kind === 'replayed' && !isDenied(outcome))) {
    return jsonResponse(202, {
      status: 'pending_approval',
      approval_id: opened?.approval?.approvalId ?? null,
      expires_at: opened?.approval?.expiresAt.toISOString() ?? null,
      counts,
      results: body,
    });
  }

  if (outcomes.every(isDenied)) {
    const first = outcomes.find((outcome) => outcome.kind === 'denied');
    return jsonResponse(403, {
      error: 'policy_denied',
      // 단건 발송 경로와 같은 자리에 판정을 싣는다 — Layer D 매트릭스가 경로를 가리지 않고 읽는다.
      decision: first?.kind === 'denied' ? decisionBody(first.decision) : null,
      counts,
      results: body,
    });
  }

  return jsonResponse(502, {
    error: 'transition_announcement_unexpected_outcome',
    detail: 'The announcement ended in an unexpected state. Check the result for each recipient.',
    counts,
    results: body,
  });
}
