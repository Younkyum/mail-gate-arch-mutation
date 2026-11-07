/**
 * src/runtime/router.ts — API Gateway HTTP API(payload v2) → 기존 라우트 함수.
 *
 * `api/http.ts` 머리말의 약속을 지키는 자리다: *"어떤 어댑터가 앞에 붙든 그 어댑터가 이 두 타입(`ApiRequest`·
 * `ApiResponse`)으로 번역하면 된다. 번역이 라우트 안으로 들어오지 않는 것이 요점이다."* 그래서 이 파일은
 * **번역과 배정만** 한다 — 인증·멱등 키·인가·관문은 전부 라우트 함수 안에 그대로 있다.
 *
 * **라우터 표(`ROUTE_TABLE`)는 Layer C 의 런타임판이다.** `test/unit/runtime/router-table.test.ts` 가
 *   ① `src/api/routes/**` 가 export 하는 `handle*` 함수 **전부**가 표에 있는지(등록 안 된 라우트 함수 = 빨강),
 *   ② 표의 항목이 가리키는 함수가 정말 그 파일의 export 인지(함수 **값**으로 대조 — 문자열이 아니다),
 *   ③ 매니페스트 `OUTBOUND_ROUTES` 의 http 항목이 같은 메서드·경로로 표에 있는지
 * 를 본다. 표에 없는 경로는 404, 경로는 있는데 메서드가 없으면 405 다.
 *
 * **응답에 스택·내부 메시지를 싣지 않는다.** 던져진 예외는 로그로만 가고, 응답은 `internal_error` + 요청 id 다.
 */

import { authenticateRequest, SELF_AGENT_ALIAS } from '../api/auth';
import type { ApiRequest, ApiResponse } from '../api/http';
import { errorResponse } from '../api/http';
import { MAX_CONTENT_BYTES } from '../api/content-store';
import { decodeParsedDocument, type AttachmentRouteDependencies, type InboundReadDependencies } from '../api/inbound-view';
import { handleGetAgentPolicy, type AgentPolicyRouteDependencies } from '../api/routes/agent-policy';
import { handleApprovalLink, type ApprovalLinkRouteDependencies } from '../api/routes/approval-link';
import { approvalPageLanguage } from '../approval/magic-link';
import { handleGetApproval, type ApprovalRouteDependencies } from '../api/routes/approvals';
import { handleGetInboundAttachment, handleGetInboundAttachmentContent } from '../api/routes/attachments';
import { handleCreateAttachmentUpload, type AttachmentUploadRouteDependencies } from '../api/routes/outbound-attachments';
import { handleAuditQuery, type AuditRouteDependencies } from '../api/routes/audit';
import {
  handleCreateDraft,
  handleDiscardDraft,
  handleGetDraft,
  handleListDrafts,
  handleUpdateDraft,
  type DraftRouteDependencies,
} from '../api/routes/drafts';
import { handleSendDraft, type DraftSendRouteDependencies } from '../api/routes/draft-send';
import { handleEnrollAgent, type AgentEnrollRouteDependencies } from '../api/routes/agents-enroll';
import { handleCreatePolicyRequest, handleGetPolicyRequest, type PolicyRequestRouteDependencies } from '../api/routes/policy-requests';
import {
  handleGetCapabilities,
  handleGetDiscovery,
  handleGetOpenApi,
  handleGetRealtimeConnection,
  PUBLIC_DOCUMENT_HEADERS,
  type RealtimeUrlDependency,
} from '../api/routes/discovery';
import { handleForward, type ForwardRouteDependencies } from '../api/routes/forward';
import { handleGetInboundMessage, handleListInboundMessages } from '../api/routes/inbound-messages';
import { handleGetIdentity, IDENTITY_RESPONSE_HEADERS, type IdentityRouteDependencies } from '../api/routes/identity';
import { handleListLabels, handleSetMessageLabels, type LabelRouteDependencies } from '../api/routes/labels';
import { handleReply, type ReplyRouteDependencies } from '../api/routes/reply';
import {
  handleCreateScheduledMessage,
  type ScheduledMessageRouteDependencies,
} from '../api/routes/scheduled-messages';
import {
  handleCancelScheduledMessage,
  handleGetScheduledMessage,
  handleListScheduledMessages,
  type ScheduledQueryRouteDependencies,
} from '../api/routes/scheduled-queries';
import { handleSend, type SendRouteDependencies } from '../api/routes/send';
import { handleGetThread } from '../api/routes/threads';
import {
  handleTransitionAnnouncement,
  type TransitionAnnouncementDependencies,
} from '../api/routes/transition-announcement';
import { handleGetVerificationCode, type VerificationCodeRouteDependencies } from '../api/routes/verification-code';
import {
  handleListWebhookDeliveries,
  handleRedeliverWebhookDelivery,
  type WebhookDeliveryRouteDependencies,
} from '../api/routes/webhook-deliveries';
import {
  handleDeleteWebhookEndpoint,
  handleListWebhookEndpoints,
  handleRegisterWebhookEndpoint,
  handleRotateWebhookSecret,
  type WebhookEndpointRouteDependencies,
} from '../api/routes/webhook-endpoints';
import type { AgentId } from '../db/schema';
import { handleMcpRequest, type McpDependencies } from '../mcp/server';
import { log } from '../observability/logger';
import { createHealthProbe, type HealthProbe } from './health';

// ---------------------------------------------------------------------------
// 의존성 — 라우트마다 자기 조각
// ---------------------------------------------------------------------------

/** 라우트 함수 전부의 의존성. 조립은 `composition.ts` 의 `composeApi` 가 한다. */
export interface ApiDependencies {
  readonly send: SendRouteDependencies;
  readonly reply: ReplyRouteDependencies;
  readonly forward: ForwardRouteDependencies;
  readonly transitionAnnouncement: TransitionAnnouncementDependencies;
  readonly audit: AuditRouteDependencies;
  readonly approvalLink: ApprovalLinkRouteDependencies;
  readonly approvals: ApprovalRouteDependencies;
  /** 정책 조회 · 발견(capabilities · 실시간 안내 — 묶음 E 의 `realtimeUrl` 은 배포가 정한 접속 주소). */
  readonly agentPolicy: AgentPolicyRouteDependencies & RealtimeUrlDependency;
  /** 무인증 발견 문서(`/.well-known/atmark.json`)의 실시간 접속 주소(묶음 E). 없으면 정본 호스트 — 공개 라우트는 다른 칸을 건드리지 않는다. */
  readonly discovery?: RealtimeUrlDependency;
  readonly webhookEndpoints: WebhookEndpointRouteDependencies;
  readonly inboundRead: InboundReadDependencies;
  readonly attachments: AttachmentRouteDependencies;
  readonly scheduledMessages: ScheduledMessageRouteDependencies;
  /** 예약 조회·취소(메일 기본기 A3) — MCP `list_scheduled`·`cancel_scheduled` 도 이 칸이다. */
  readonly scheduledQueries: ScheduledQueryRouteDependencies;
  /** 인증코드 조회(메일 기본기 A1) — MCP `get_verification_code` 도 이 칸이다. */
  readonly verificationCode: VerificationCodeRouteDependencies;
  /** 웹훅 전달 목록·재전송(메일 기본기 A4) — MCP `list_webhook_deliveries`·`redeliver_webhook` 도 이 칸이다(2026-09-30). */
  readonly webhookDeliveries: WebhookDeliveryRouteDependencies;
  /** 발신 첨부 업로드 생성(메일 기본기 2차 A2 — 스위치가 꺼지면 404). MCP 도구 없음(MCP 는 첨부 id 참조만, D8). */
  readonly outboundAttachments: AttachmentUploadRouteDependencies;
  /** 초안 만들기 · 목록 · 조회 · 고치기 · 버리기(묶음 B) — MCP `create_draft` … `discard_draft` 도 이 칸이다. */
  readonly drafts: DraftRouteDependencies;
  /** 초안 보내기(묶음 B — 매니페스트 `draft_send`). MCP `send_draft` 도 이 칸이다. */
  readonly draftSend: DraftSendRouteDependencies;
  /** 라벨(묶음 B) — MCP `set_labels` · `list_labels` 도 이 칸이다. */
  readonly labels: LabelRouteDependencies;
  /** 자가 등록(묶음 D — `agents:enroll`) — admin λ 이벤트 하나. MCP `create_agent` 도 이 칸이다. */
  readonly agentEnroll: AgentEnrollRouteDependencies;
  /** 정책 변경 요청(ADR-0007 2026-10-13 — `policy:request`) — MCP `request_policy_change` · `get_policy_request` 도 이 칸이다. */
  readonly policyRequests: PolicyRequestRouteDependencies;
  /** 무인증 공개 신원 조회(PP-C) — 앱 롤 풀의 읽기 하나. */
  readonly identity: IdentityRouteDependencies;
  readonly health: HealthProbe;
}

// ---------------------------------------------------------------------------
// 표
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** 요청 본문 상한 — 발신 본문 상한(`MAX_CONTENT_BYTES`, 10 MiB)과 같다. 첨부 업로드는 없다. */
export const MAX_REQUEST_BODY_BYTES = MAX_CONTENT_BYTES;

/** 라우트에 넘기는 번역된 요청. */
export interface RoutedRequest {
  readonly method: HttpMethod;
  /** JSON 본문 경로는 파싱된 값, 원문 경로(`/approve`)는 `undefined`. */
  readonly api: ApiRequest;
  /** UTF-8 원문. 원문 경로만 읽는다. */
  readonly rawBody: string;
  readonly contentType: string | null;
  readonly params: Readonly<Record<string, string>>;
}

export interface HttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** 본문 처리: `json` 은 파싱해 `ApiRequest.body` 로, `raw` 는 원문 그대로, `none` 은 읽지 않는다. */
export type BodyMode = 'json' | 'raw' | 'none';

// 핸들러 함수의 "정체" — 교차 대조용. 인자 타입은 라우트마다 달라 `never[]` 로 받는다(모든 함수가 대입된다).
type AnyHandler = (...args: never[]) => unknown;

export interface RouteEntry {
  readonly method: HttpMethod;
  /** 경로 템플릿. 파라미터는 `{name}` — 이름이 라우트 함수의 `params` 키다. */
  readonly path: string;
  /** 핸들러가 사는 파일(리포 상대). 교차 대조 테스트가 이 파일의 export 와 `handler` 를 **값으로** 맞춘다. */
  readonly file: string;
  readonly handler: AnyHandler;
  readonly body: BodyMode;
  readonly invoke: (deps: ApiDependencies, request: RoutedRequest) => Promise<HttpResult>;
}

const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(response: ApiResponse, extra: Readonly<Record<string, string>> = {}): HttpResult {
  return { status: response.status, headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(response.body) };
}

/** 매칭이 보장한 파라미터. 없으면 표와 템플릿이 어긋난 것이다 — 조용히 빈 문자열로 넘기지 않는다. */
function param(request: RoutedRequest, name: string): string {
  const value = request.params[name];
  if (value === undefined) throw new Error(`라우터 표 결함: 경로 파라미터 ${name} 이 템플릿에 없다`);
  return value;
}

function route<H extends AnyHandler>(
  method: HttpMethod,
  path: string,
  file: string,
  handler: H,
  body: BodyMode,
  invoke: (handler: H, deps: ApiDependencies, request: RoutedRequest) => Promise<HttpResult>,
): RouteEntry {
  return { method, path, file, handler, body, invoke: (deps, request) => invoke(handler, deps, request) };
}

/**
 * 전환 공지는 대상 에이전트를 **본문**의 `agent_id` 로 받는다(라우트 머리말 — 인가는 그 값으로 한다). 경로의
 * `{agentId}` 와 본문이 다르면 audit 에 남는 대상과 호출자가 URL 로 의도한 대상이 갈라진다 — 여기서 400 으로 끊는다.
 * 경로가 별칭 `me` 면 대조할 id 가 아직 없다(인증 전) — 본문 그대로 라우트에 넘기고, 라우트가 생략을 토큰의 에이전트로 채운 뒤
 * 적은 값은 그대로 인가한다(남의 id → 403).
 */
function pathBodyAgentMismatch(request: RoutedRequest): ApiResponse | null {
  const path = param(request, 'agentId');
  if (path === SELF_AGENT_ALIAS) return null;
  const body = request.api.body;
  if (typeof body !== 'object' || body === null) return null;
  const claimed = (body as Record<string, unknown>)['agent_id'];
  if (typeof claimed !== 'string' || claimed.trim() === path) return null;
  return errorResponse(400, 'path_body_mismatch', 'The agent id in the path does not match agent_id in the body.');
}

/**
 * 경로에 id 를 적고 본문에서 `agent_id` 를 생략하면 **경로의 id 가 대상**이다 — 라우트의 기본값(토큰의 에이전트)으로 떨어지면 URL 이
 * 말한 대상과 실제 대상이 갈라진다(남의 id 를 적은 호출이 조용히 자기 공지로 성공한다). 그래서 본문에 경로 id 를 채워 넘긴다 — 인가는
 * 라우트가 그 값으로 한다. `me` 는 그대로(라우트가 토큰의 에이전트로 채운다).
 */
function withPathAgent(request: RoutedRequest): ApiRequest {
  const path = param(request, 'agentId');
  const body = request.api.body;
  if (path === SELF_AGENT_ALIAS || typeof body !== 'object' || body === null || Array.isArray(body)) return request.api;
  if (Object.prototype.hasOwnProperty.call(body, 'agent_id')) return request.api;
  return { ...request.api, body: { ...(body as Record<string, unknown>), agent_id: path } };
}

const ROUTES = 'src/api/routes';

/**
 * MCP 가 받는 의존성 — **클로저만** (`McpDependencies`, `src/mcp/tools.ts` 판단 ⑤, 적대 검증 M2).
 *
 * 의존성 객체를 넘기면 타입이 좁아도 런타임 값은 통째다 — `send.transport`(관문을 건너뛰는 전송단)·승인 저장소의 `approve`·
 * 토큰 저장소의 `insert` 가 `(x as any)` 한 번이면 닿는다. 그래서 각 칸은 **HTTP 라우트가 부르는 바로 그 함수를 바로 그 의존성
 * 칸으로** 부르는 화살표 함수이고, 의존성 객체는 이 클로저 안에만 있다.
 *
 * `test/arch/mcp-adapter.arch.test.ts` ⑤ 가 이 객체 리터럴을 본다: 키 집합 = `McpDependencies` 멤버, 모든 값이 화살표
 * 함수, 라우트 칸은 정해진 `handle*` 를 정해진 `d.<칸>` 으로 부른다. `test/unit/runtime/router-table.test.ts` 가 런타임에
 * 돌려받은 값이 함수뿐인지 본다.
 */
export function mcpDependenciesOf(d: ApiDependencies): McpDependencies {
  return Object.freeze({
    authenticate: (headers: Readonly<Record<string, string>>) =>
      authenticateRequest(d.inboundRead.tokens, { headers, query: {}, body: undefined }, d.inboundRead.now()),
    send: (request: ApiRequest) => handleSend(d.send, request),
    reply: (request: ApiRequest, params: { readonly threadId: string }) => handleReply(d.reply, request, params),
    findReplyTarget: (agentId: string, inboundMessageId: string) => d.reply.replyTargets.find(agentId, inboundMessageId),
    forward: (request: ApiRequest, params: { readonly inboundMessageId: string }) => handleForward(d.forward, request, params),
    // 전달 라우트가 기본 제목을 만들 때와 같은 읽기(`routes/forward.ts` ⑤·`forwardedSubject`): 에이전트 컨텍스트 저장소 →
    // 파싱 문서의 subject. 보이지 않거나 남의 메일이면 null — 라우트가 404·403 으로 끝낸다.
    forwardOriginal: async (agentId: string, inboundMessageId: string) => {
      const source = await d.forward.inbound.findVisible(inboundMessageId);
      if (source === null || source.agentId !== agentId) return null;
      return { subject: decodeParsedDocument(await d.forward.artifacts.readParsed(source.parsedStorageKey)).subject };
    },
    listInbox: (request: ApiRequest) => handleListInboundMessages(d.inboundRead, request),
    readEmail: (request: ApiRequest, params: { readonly inboundMessageId: string }) =>
      handleGetInboundMessage(d.inboundRead, request, params),
    getThread: (request: ApiRequest, params: { readonly threadId: string }) => handleGetThread(d.inboundRead, request, params),
    getAttachment: (request: ApiRequest, params: { readonly inboundMessageId: string; readonly index: string }) =>
      handleGetInboundAttachment(d.attachments, request, params),
    readAttachment: (request: ApiRequest, params: { readonly inboundMessageId: string; readonly index: string }) =>
      handleGetInboundAttachmentContent(d.attachments, request, params),
    getApproval: (request: ApiRequest, params: { readonly approvalId: string }) => handleGetApproval(d.approvals, request, params),
    getAgentPolicy: (request: ApiRequest, params: { readonly agentId: string }) => handleGetAgentPolicy(d.agentPolicy, request, params),
    verificationCode: (request: ApiRequest) => handleGetVerificationCode(d.verificationCode, request),
    listScheduled: (request: ApiRequest) => handleListScheduledMessages(d.scheduledQueries, request),
    // 취소 경로는 **리터럴** `'mcp'` 다 — 헤더로 받지 않는다(HTTP 클라이언트가 위조한다). HTTP 표 항목은 `'http'` 를 넘긴다(arch ⑤).
    cancelScheduled: (request: ApiRequest, params: { readonly scheduleId: string }) =>
      handleCancelScheduledMessage(d.scheduledQueries, request, params, 'mcp'),
    // 웹훅 관리(2026-09-30 확대 — ADR-0013 개정) — HTTP 표와 같은 라우트 함수 · 같은 칸. 권한(`webhooks:manage`)은 라우트가 다시 본다.
    listWebhooks: (request: ApiRequest, params: { readonly agentId: string }) => handleListWebhookEndpoints(d.webhookEndpoints, request, params),
    createWebhook: (request: ApiRequest, params: { readonly agentId: string }) => handleRegisterWebhookEndpoint(d.webhookEndpoints, request, params),
    deleteWebhook: (request: ApiRequest, params: { readonly agentId: string; readonly endpointId: string }) =>
      handleDeleteWebhookEndpoint(d.webhookEndpoints, request, params),
    listWebhookDeliveries: (request: ApiRequest, params: { readonly agentId: string }) =>
      handleListWebhookDeliveries(d.webhookDeliveries, request, params),
    redeliverWebhook: (request: ApiRequest, params: { readonly agentId: string; readonly deliveryId: string }) =>
      handleRedeliverWebhookDelivery(d.webhookDeliveries, request, params),
    // 묶음 B — 초안 · 라벨 · 발견. HTTP 표와 같은 라우트 함수 · 같은 칸.
    createDraft: (request: ApiRequest) => handleCreateDraft(d.drafts, request),
    listDrafts: (request: ApiRequest) => handleListDrafts(d.drafts, request),
    getDraft: (request: ApiRequest, params: { readonly draftId: string }) => handleGetDraft(d.drafts, request, params),
    updateDraft: (request: ApiRequest, params: { readonly draftId: string }) => handleUpdateDraft(d.drafts, request, params),
    discardDraft: (request: ApiRequest, params: { readonly draftId: string }) => handleDiscardDraft(d.drafts, request, params),
    sendDraft: (request: ApiRequest, params: { readonly draftId: string }) => handleSendDraft(d.draftSend, request, params),
    setLabels: (request: ApiRequest, params: { readonly inboundMessageId: string }) => handleSetMessageLabels(d.labels, request, params),
    listLabels: (request: ApiRequest) => handleListLabels(d.labels, request),
    getCapabilities: (request: ApiRequest, params: { readonly agentId: string }) => handleGetCapabilities(d.agentPolicy, request, params),
    // 묶음 D — 자가 등록. HTTP 표와 같은 라우트 함수 · 같은 칸(권한 · 판정은 라우트와 admin λ 가 다시 본다).
    createAgent: (request: ApiRequest) => handleEnrollAgent(d.agentEnroll, request),
    // 정책 변경 요청(2026-10-13) — HTTP 표와 같은 라우트 함수 · 같은 칸. 바꾸지 않는다(소유자가 콘솔에서 승인한다).
    requestPolicyChange: (request: ApiRequest, params: { readonly agentId: string }) => handleCreatePolicyRequest(d.policyRequests, request, params),
    getPolicyRequest: (request: ApiRequest, params: { readonly agentId: string; readonly requestId: string }) =>
      handleGetPolicyRequest(d.policyRequests, request, params),
    // 묶음 E — 실시간 연결 안내(같은 라우트 함수 · 같은 칸).
    getRealtimeConnection: (request: ApiRequest, params: { readonly agentId: string }) => handleGetRealtimeConnection(d.agentPolicy, request, params),
    sendingAddresses: async (agentId: AgentId) => {
      const loaded = await d.agentPolicy.policies.load({
        agentId,
        recipients: [],
        now: d.agentPolicy.now(),
        threadId: null,
        releaseApprovalId: null,
      });
      // `isPrimary` = **유효 대표**(ADR-0014 2026-10 개정 — 고객 도메인을 대표로 골랐으면 그 주소, 무효면 어느 것도 아니다) · `anchor` = @atmark.ai 앵커
      // 행(더한 칸). 잠든 앵커는 로더가 이미 뺐다(`usable`).
      const primary = loaded.primaryAddress !== undefined ? loaded.primaryAddress : (loaded.addresses.find((row) => row.is_primary)?.address ?? null);
      return loaded.addresses.map((row) => ({ address: row.address, isPrimary: primary !== null && row.address === primary, anchor: row.is_primary }));
    },
  });
}

/** **라우터 표.** 여기 없는 경로는 404 다. 순서는 의미가 없다 — 템플릿이 겹치지 않는다(테스트가 본다). */
export const ROUTE_TABLE: readonly RouteEntry[] = [
  // ---- 발송 경로 (OUTBOUND_ROUTES, kind: 'http') ----
  route('POST', '/v1/messages', `${ROUTES}/send.ts`, handleSend, 'json', async (h, d, r) => json(await h(d.send, r.api))),
  route('POST', '/v1/threads/{threadId}/reply', `${ROUTES}/reply.ts`, handleReply, 'json', async (h, d, r) =>
    json(await h(d.reply, r.api, { threadId: param(r, 'threadId') })),
  ),
  route('POST', '/v1/messages/{inboundMessageId}/forward', `${ROUTES}/forward.ts`, handleForward, 'json', async (h, d, r) =>
    json(await h(d.forward, r.api, { inboundMessageId: param(r, 'inboundMessageId') })),
  ),
  route(
    'POST',
    '/v1/agents/{agentId}/transition-announcement',
    `${ROUTES}/transition-announcement.ts`,
    handleTransitionAnnouncement,
    'json',
    async (h, d, r) => json(pathBodyAgentMismatch(r) ?? (await h(d.transitionAnnouncement, withPathAgent(r)))),
  ),

  // ---- 발송하지 않는 경로 (NON_SENDING_ENTRYPOINTS) ----
  route('GET', '/v1/audit', `${ROUTES}/audit.ts`, handleAuditQuery, 'none', async (h, d, r) => json(await h(d.audit, r.api))),
  ...(['GET', 'HEAD', 'POST'] as const).map((method) =>
    route(method, '/approve', `${ROUTES}/approval-link.ts`, handleApprovalLink, method === 'POST' ? 'raw' : 'none', async (h, d, r) => {
      // 페이지 언어(계약 §8) — `?lang=ko|en` 이 먼저, 없으면 Accept-Language. api 호스트에는 쿠키를 두지 않는다.
      const language = approvalPageLanguage(r.api.query['lang'], r.api.headers['accept-language']);
      const response = await h(d.approvalLink, { method: r.method, contentType: r.contentType, body: r.rawBody, language });
      // 페이지 헤더(CSP·frame-ancestors·no-store)는 매직링크 모듈이 정한다 — 여기서 덧칠하지 않는다.
      return { status: response.status, headers: response.headers, body: r.method === 'HEAD' ? '' : response.body };
    }),
  ),
  route('GET', '/v1/approvals/{approvalId}', `${ROUTES}/approvals.ts`, handleGetApproval, 'none', async (h, d, r) =>
    json(await h(d.approvals, r.api, { approvalId: param(r, 'approvalId') })),
  ),
  route('GET', '/v1/agents/{agentId}/policy', `${ROUTES}/agent-policy.ts`, handleGetAgentPolicy, 'none', async (h, d, r) =>
    json(await h(d.agentPolicy, r.api, { agentId: param(r, 'agentId') })),
  ),
  // 정책 변경 요청(ADR-0007 2026-10-13) — 요청 한 행을 남길 뿐 바꾸지 않는다(소유자가 콘솔에서 승인). NON_SENDING.
  route('POST', '/v1/agents/{agentId}/policy/requests', `${ROUTES}/policy-requests.ts`, handleCreatePolicyRequest, 'json', async (h, d, r) =>
    json(await h(d.policyRequests, r.api, { agentId: param(r, 'agentId') })),
  ),
  route(
    'GET',
    '/v1/agents/{agentId}/policy/requests/{requestId}',
    `${ROUTES}/policy-requests.ts`,
    handleGetPolicyRequest,
    'none',
    async (h, d, r) => json(await h(d.policyRequests, r.api, { agentId: param(r, 'agentId'), requestId: param(r, 'requestId') })),
  ),
  route(
    'POST',
    '/v1/agents/{agentId}/webhook-endpoints',
    `${ROUTES}/webhook-endpoints.ts`,
    handleRegisterWebhookEndpoint,
    'json',
    async (h, d, r) => json(await h(d.webhookEndpoints, r.api, { agentId: param(r, 'agentId') })),
  ),
  route(
    'GET',
    '/v1/agents/{agentId}/webhook-endpoints',
    `${ROUTES}/webhook-endpoints.ts`,
    handleListWebhookEndpoints,
    'none',
    async (h, d, r) => json(await h(d.webhookEndpoints, r.api, { agentId: param(r, 'agentId') })),
  ),
  route('GET', '/v1/messages/inbound', `${ROUTES}/inbound-messages.ts`, handleListInboundMessages, 'none', async (h, d, r) =>
    json(await h(d.inboundRead, r.api)),
  ),
  route(
    'GET',
    '/v1/messages/inbound/{inboundMessageId}',
    `${ROUTES}/inbound-messages.ts`,
    handleGetInboundMessage,
    'none',
    async (h, d, r) => json(await h(d.inboundRead, r.api, { inboundMessageId: param(r, 'inboundMessageId') })),
  ),
  route(
    'GET',
    '/v1/messages/inbound/{inboundMessageId}/attachments/{index}',
    `${ROUTES}/attachments.ts`,
    handleGetInboundAttachment,
    'none',
    async (h, d, r) =>
      json(await h(d.attachments, r.api, { inboundMessageId: param(r, 'inboundMessageId'), index: param(r, 'index') })),
  ),
  // 첨부 **내용**(텍스트 · PDF 텍스트 · 이미지) — 서버가 바이트를 읽어 풀어 준다. 같은 인증·인가·격리 규칙(같은 파일).
  route(
    'GET',
    '/v1/messages/inbound/{inboundMessageId}/attachments/{index}/content',
    `${ROUTES}/attachments.ts`,
    handleGetInboundAttachmentContent,
    'none',
    async (h, d, r) =>
      json(await h(d.attachments, r.api, { inboundMessageId: param(r, 'inboundMessageId'), index: param(r, 'index') })),
  ),
  route('GET', '/v1/threads/{threadId}', `${ROUTES}/threads.ts`, handleGetThread, 'none', async (h, d, r) =>
    json(await h(d.inboundRead, r.api, { threadId: param(r, 'threadId') })),
  ),
  route(
    'POST',
    '/v1/messages/scheduled',
    `${ROUTES}/scheduled-messages.ts`,
    handleCreateScheduledMessage,
    'json',
    async (h, d, r) => json(await h(d.scheduledMessages, r.api)),
  ),

  // ---- 메일 기본기 1차 (`.omc/plans/mail-basics.md` §4 경로표) — 전부 NON_SENDING_ENTRYPOINTS ----
  route('GET', '/v1/messages/verification-code', `${ROUTES}/verification-code.ts`, handleGetVerificationCode, 'none', async (h, d, r) =>
    json(await h(d.verificationCode, r.api)),
  ),
  route('GET', '/v1/messages/scheduled', `${ROUTES}/scheduled-queries.ts`, handleListScheduledMessages, 'none', async (h, d, r) =>
    json(await h(d.scheduledQueries, r.api)),
  ),
  route(
    'GET',
    '/v1/messages/scheduled/{scheduleId}',
    `${ROUTES}/scheduled-queries.ts`,
    handleGetScheduledMessage,
    'none',
    async (h, d, r) => json(await h(d.scheduledQueries, r.api, { scheduleId: param(r, 'scheduleId') })),
  ),
  // 취소 경로는 **리터럴** `'http'` — MCP 는 `mcpDependenciesOf` 가 `'mcp'` 를 넘긴다(헤더로 받지 않는다).
  route(
    'POST',
    '/v1/messages/scheduled/{scheduleId}/cancel',
    `${ROUTES}/scheduled-queries.ts`,
    handleCancelScheduledMessage,
    'json',
    async (h, d, r) => json(await h(d.scheduledQueries, r.api, { scheduleId: param(r, 'scheduleId') }, 'http')),
  ),
  route(
    'DELETE',
    '/v1/agents/{agentId}/webhook-endpoints/{endpointId}',
    `${ROUTES}/webhook-endpoints.ts`,
    handleDeleteWebhookEndpoint,
    'none',
    async (h, d, r) =>
      json(await h(d.webhookEndpoints, r.api, { agentId: param(r, 'agentId'), endpointId: param(r, 'endpointId') })),
  ),
  route(
    'POST',
    '/v1/agents/{agentId}/webhook-endpoints/{endpointId}/rotate-secret',
    `${ROUTES}/webhook-endpoints.ts`,
    handleRotateWebhookSecret,
    'none',
    async (h, d, r) =>
      json(await h(d.webhookEndpoints, r.api, { agentId: param(r, 'agentId'), endpointId: param(r, 'endpointId') })),
  ),
  route(
    'GET',
    '/v1/agents/{agentId}/webhook-deliveries',
    `${ROUTES}/webhook-deliveries.ts`,
    handleListWebhookDeliveries,
    'none',
    async (h, d, r) => json(await h(d.webhookDeliveries, r.api, { agentId: param(r, 'agentId') })),
  ),
  route(
    'POST',
    '/v1/agents/{agentId}/webhook-deliveries/{deliveryId}/redeliver',
    `${ROUTES}/webhook-deliveries.ts`,
    handleRedeliverWebhookDelivery,
    'none',
    async (h, d, r) =>
      json(await h(d.webhookDeliveries, r.api, { agentId: param(r, 'agentId'), deliveryId: param(r, 'deliveryId') })),
  ),

  // ---- 발신 첨부 업로드 (메일 기본기 2차 A2) — 서명된 PUT URL 을 돌려줄 뿐 발송이 아니다(NON_SENDING). ----
  route('POST', '/v1/attachments', `${ROUTES}/outbound-attachments.ts`, handleCreateAttachmentUpload, 'json', async (h, d, r) =>
    json(await h(d.outboundAttachments, r.api)),
  ),

  // ---- 개발자 표면 (묶음 B) — 초안 · 라벨 · 발견. 초안 보내기만 OUTBOUND_ROUTES(draft_send), 나머지는 NON_SENDING. ----
  route('POST', '/v1/drafts', `${ROUTES}/drafts.ts`, handleCreateDraft, 'json', async (h, d, r) => json(await h(d.drafts, r.api))),
  route('GET', '/v1/drafts', `${ROUTES}/drafts.ts`, handleListDrafts, 'none', async (h, d, r) => json(await h(d.drafts, r.api))),
  route('GET', '/v1/drafts/{draftId}', `${ROUTES}/drafts.ts`, handleGetDraft, 'none', async (h, d, r) =>
    json(await h(d.drafts, r.api, { draftId: param(r, 'draftId') })),
  ),
  route('PATCH', '/v1/drafts/{draftId}', `${ROUTES}/drafts.ts`, handleUpdateDraft, 'json', async (h, d, r) =>
    json(await h(d.drafts, r.api, { draftId: param(r, 'draftId') })),
  ),
  route('POST', '/v1/drafts/{draftId}/discard', `${ROUTES}/drafts.ts`, handleDiscardDraft, 'none', async (h, d, r) =>
    json(await h(d.drafts, r.api, { draftId: param(r, 'draftId') })),
  ),
  route('POST', '/v1/drafts/{draftId}/send', `${ROUTES}/draft-send.ts`, handleSendDraft, 'json', async (h, d, r) =>
    json(await h(d.draftSend, r.api, { draftId: param(r, 'draftId') })),
  ),
  route(
    'PUT',
    '/v1/messages/inbound/{inboundMessageId}/labels',
    `${ROUTES}/labels.ts`,
    handleSetMessageLabels,
    'json',
    async (h, d, r) => json(await h(d.labels, r.api, { inboundMessageId: param(r, 'inboundMessageId') })),
  ),
  route('GET', '/v1/labels', `${ROUTES}/labels.ts`, handleListLabels, 'none', async (h, d, r) => json(await h(d.labels, r.api))),
  route('GET', '/v1/agents/{agentId}/capabilities', `${ROUTES}/discovery.ts`, handleGetCapabilities, 'none', async (h, d, r) =>
    json(await h(d.agentPolicy, r.api, { agentId: param(r, 'agentId') })),
  ),
  // ---- 자가 등록 (묶음 D) — 보내지 않는다(NON_SENDING). admin λ 이벤트 하나. ----
  route('POST', '/v1/agents', `${ROUTES}/agents-enroll.ts`, handleEnrollAgent, 'json', async (h, d, r) => json(await h(d.agentEnroll, r.api))),
  // 무인증 공개 문서 — 상수(의존성 없음) · CORS * · 5분 캐시.
  route('GET', '/v1/openapi.json', `${ROUTES}/discovery.ts`, handleGetOpenApi, 'none', async (h) => json(await h(), PUBLIC_DOCUMENT_HEADERS)),
  // 무인증 공개 문서 — 의존성은 실시간 접속 주소 하나(없으면 정본 호스트 — 라우트는 DB · 토큰을 모른다).
  route('GET', '/.well-known/atmark.json', `${ROUTES}/discovery.ts`, handleGetDiscovery, 'none', async (h, d) =>
    json(await h(d.discovery?.realtimeUrl), PUBLIC_DOCUMENT_HEADERS),
  ),
  // 묶음 E — 실시간 WebSocket 에 붙는 법(MCP `get_realtime_connection`). 토큰 권한 `messages:read`(연결과 같다).
  route('GET', '/v1/agents/{agentId}/realtime', `${ROUTES}/discovery.ts`, handleGetRealtimeConnection, 'none', async (h, d, r) =>
    json(await h(d.agentPolicy, r.api, { agentId: param(r, 'agentId') })),
  ),

  // ---- 공개 신원 (PP-C, 계획 §4B.3) — **무인증** · CORS * · 공개 캐시. 본문은 `public-view.ts` 직렬화기만 만든다. ----
  route('GET', '/v1/identity/{address}', `${ROUTES}/identity.ts`, handleGetIdentity, 'none', async (h, d, r) =>
    json(await h(d.identity, { address: param(r, 'address') }), IDENTITY_RESPONSE_HEADERS),
  ),

  // ---- MCP (Hermes 원격 MCP) — 전송 계층이다. 도구 하나 = 위 라우트 함수 하나(`src/mcp/tools.ts`) ----
  // 넘기는 것은 **함수뿐**이다(`mcpDependenciesOf`, 아래) — 의존성 객체는 MCP 손에 들어가지 않는다.
  route('POST', '/mcp', 'src/mcp/server.ts', handleMcpRequest, 'raw', (h, d, r) =>
    h(mcpDependenciesOf(d), { headers: r.api.headers, rawBody: r.rawBody }),
  ),

  // ---- 런타임 자신 ----
  route('GET', '/healthz', 'src/runtime/health.ts', createHealthProbe, 'none', async (_h, d) => {
    const report = await d.health.check();
    return json({ status: report.ok ? 200 : 503, body: { status: report.ok ? 'ok' : 'fail', checks: report.checks } });
  }),
];

// ---------------------------------------------------------------------------
// 매칭
// ---------------------------------------------------------------------------

type Segment = { readonly kind: 'literal'; readonly value: string } | { readonly kind: 'param'; readonly name: string };

function compile(template: string): readonly Segment[] {
  return template
    .split('/')
    .slice(1)
    .map((part) => {
      const match = /^\{([A-Za-z]+)\}$/.exec(part);
      return match?.[1] !== undefined ? { kind: 'param', name: match[1] } : { kind: 'literal', value: part };
    });
}

const COMPILED = ROUTE_TABLE.map((entry) => ({ entry, segments: compile(entry.path) }));

function matchPath(segments: readonly Segment[], parts: readonly string[]): Record<string, string> | null {
  if (segments.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of segments.entries()) {
    const part = parts[index];
    if (part === undefined) return null;
    if (segment.kind === 'literal') {
      if (segment.value !== part) return null;
      continue;
    }
    if (part === '') return null;
    params[segment.name] = part;
  }
  return params;
}

/** 경로 → 매칭된 항목들(메서드 무관). 퍼센트 인코딩이 깨진 경로는 어떤 항목과도 맞지 않는다(404). */
export function resolvePath(path: string): { readonly entries: readonly RouteEntry[]; readonly params: Record<string, string> } {
  let parts: string[];
  try {
    parts = path.split('/').slice(1).map((part) => decodeURIComponent(part));
  } catch {
    return { entries: [], params: {} };
  }
  if (!path.startsWith('/')) return { entries: [], params: {} };
  const found: RouteEntry[] = [];
  let params: Record<string, string> = {};
  for (const { entry, segments } of COMPILED) {
    const matched = matchPath(segments, parts);
    if (matched === null) continue;
    found.push(entry);
    params = matched;
  }
  return { entries: found, params };
}

// ---------------------------------------------------------------------------
// API Gateway HTTP API (payload format 2.0)
// ---------------------------------------------------------------------------

/** payload v2 이벤트 중 우리가 읽는 필드. */
export interface HttpApiEvent {
  readonly rawPath: string;
  readonly rawQueryString?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext: {
    readonly requestId: string;
    readonly stage?: string;
    readonly http: { readonly method: string };
  };
}

export interface HttpApiResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly isBase64Encoded: false;
}

function toResult(result: HttpResult): HttpApiResult {
  return { statusCode: result.status, headers: result.headers, body: result.body, isBase64Encoded: false };
}

function failure(status: number, error: string, detail: string, extra: Readonly<Record<string, string>> = {}): HttpApiResult {
  return toResult(json(errorResponse(status, error, detail), extra));
}

/** 이름이 붙은 스테이지(`/prod/...`)면 그 접두사를 벗긴다. `$default` 는 접두사가 없다. */
function stripStage(event: HttpApiEvent): string {
  const stage = event.requestContext.stage;
  if (stage === undefined || stage === '$default') return event.rawPath;
  const prefix = `/${stage}`;
  if (event.rawPath === prefix) return '/';
  return event.rawPath.startsWith(`${prefix}/`) ? event.rawPath.slice(prefix.length) : event.rawPath;
}

/** 쿼리. **같은 키가 두 번이면 400** — 어느 값을 믿을지가 파서마다 다르면 인가 판단이 갈린다. */
function parseQuery(raw: string): Record<string, string> | 'duplicate' {
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    if (Object.hasOwn(query, key)) return 'duplicate';
    query[key] = value;
  }
  return query;
}

function normalizeHeaders(headers: HttpApiEvent['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * 이벤트 하나를 처리한다. **던지지 않는다** — 라우트가 던지면 500 `internal_error` 로 바꾸고 원인은 로그로만 보낸다.
 * 조립(`deps`)이 실패한 경우는 핸들러(`handlers/api.ts`)가 503 으로 바꾼다.
 */
export async function routeHttpApiEvent(deps: ApiDependencies, event: HttpApiEvent): Promise<HttpApiResult> {
  const requestId = event.requestContext.requestId;
  try {
    const method = event.requestContext.http.method.toUpperCase();
    const path = stripStage(event);
    const { entries, params } = resolvePath(path);
    if (entries.length === 0) return failure(404, 'route_not_found', 'Route not found.');

    const entry = entries.find((candidate) => candidate.method === method);
    if (entry === undefined) {
      const allow = [...new Set(entries.map((candidate) => candidate.method))].join(', ');
      return failure(405, 'method_not_allowed', `Allowed methods for this route: ${allow}`, { allow });
    }

    const encoded = event.body ?? '';
    const bytes = event.isBase64Encoded === true ? Buffer.from(encoded, 'base64') : Buffer.from(encoded, 'utf8');
    if (bytes.length > MAX_REQUEST_BODY_BYTES) {
      return failure(413, 'payload_too_large', `The request body must be at most ${String(MAX_REQUEST_BODY_BYTES)} bytes.`);
    }
    const rawBody = entry.body === 'none' ? '' : bytes.toString('utf8');

    let body: unknown;
    if (entry.body === 'json' && rawBody.trim() !== '') {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return failure(400, 'invalid_json', 'The request body is not valid JSON.');
      }
    }

    const query = parseQuery(event.rawQueryString ?? '');
    if (query === 'duplicate') return failure(400, 'invalid_request', 'A query parameter was given more than once.');

    const headers = normalizeHeaders(event.headers);
    const routed: RoutedRequest = {
      method: entry.method,
      api: { headers, query, body },
      rawBody,
      contentType: headers['content-type'] ?? null,
      params,
    };
    return toResult(await entry.invoke(deps, routed));
  } catch (error) {
    log('error', 'runtime.api_unhandled', {
      route_id: 'api',
      trace_id: requestId,
      error_kind: error instanceof Error ? error.name : typeof error,
      detail: error instanceof Error ? error.message : String(error),
    });
    return failure(500, 'internal_error', `The request could not be processed. Request id: ${requestId}`);
  }
}

/** 조립 실패(비밀·설정) — 원인은 로그로만. 응답은 503 과 요청 id 뿐이다. */
export function unavailableResult(requestId: string): HttpApiResult {
  return failure(503, 'service_unavailable', `The service is temporarily unavailable. Request id: ${requestId}`);
}
