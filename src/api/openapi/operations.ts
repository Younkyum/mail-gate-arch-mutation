/**
 * src/api/openapi/operations.ts — **공개 에이전트 API 의 단일 정본 표**(묶음 B). `GET /v1/openapi.json` 은 이 표에서 만든다(`document.ts`).
 *
 * `test/unit/api/openapi.test.ts` 가 라우터 표(`ROUTE_TABLE`)의 `/v1/**` · `/.well-known/**` 항목과 **양방향으로** 맞춘다 — 라우트를 더하고 여기 적지
 * 않으면(또는 그 반대) 빨갛다. 값 파일이다(라우트 · DB 를 import 하지 않는다 — 문서 번들 · SDK 생성기가 가볍게 읽게).
 */

export type OperationMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** 인증 — `bearer` 는 에이전트 토큰(`Authorization: Bearer atk_agent_…`), `none` 은 공개. */
export type OperationAuth = { readonly kind: 'bearer'; readonly scope: 'messages:send' | 'messages:read' | 'audit:read' | 'agent:read_self' | 'webhooks:manage' | 'agents:enroll' | 'policy:request' | 'messages:read or webhooks:manage' } | { readonly kind: 'none' };

export interface OperationQuery {
  readonly name: string;
  readonly required?: boolean;
  readonly description: string;
  readonly schema?: Readonly<Record<string, unknown>>;
}

export interface ApiOperation {
  readonly method: OperationMethod;
  /** 라우터 표와 같은 템플릿(`{name}`). */
  readonly path: string;
  readonly operationId: string;
  readonly tag: 'send' | 'inbox' | 'drafts' | 'labels' | 'scheduled' | 'webhooks' | 'policy' | 'identity' | 'attachments' | 'discovery' | 'agents';
  readonly summary: string;
  readonly auth: OperationAuth;
  /** `Idempotency-Key` — `required`(없으면 400 idempotency_key_required) · `optional`. */
  readonly idempotencyKey?: 'required' | 'optional';
  readonly query?: readonly OperationQuery[];
  /** 요청 본문 스키마 이름(`schemas.ts`). */
  readonly requestBody?: string;
  /** 성공 상태 → 스키마 이름. */
  readonly responses: Readonly<Record<string, string>>;
}

const SEND = { kind: 'bearer', scope: 'messages:send' } as const;
const READ = { kind: 'bearer', scope: 'messages:read' } as const;
const PUBLIC = { kind: 'none' } as const;
/** 생략 = 토큰의 에이전트(2026-10-11). 적으면 자기 id 여야 한다(남의 id → 403). */
const AGENT_ID_QUERY: OperationQuery = { name: 'agent_id', description: "Optional. Defaults to the token's agent. If given, it must be your agent id (32 lowercase hex)." };
const PAGE: readonly OperationQuery[] = [
  { name: 'limit', description: 'Page size.', schema: { type: 'integer', minimum: 1, maximum: 100 } },
  { name: 'cursor', description: 'next_cursor from the previous page (same filters).' },
];
const SENT = { '200': 'SendResult', '202': 'SendResult' } as const;

export const API_OPERATIONS: readonly ApiOperation[] = [
  // ---- 보내기 ----
  { method: 'POST', path: '/v1/messages', operationId: 'sendMessage', tag: 'send', summary: 'Send a new email.', auth: SEND, idempotencyKey: 'required', requestBody: 'SendRequest', responses: SENT },
  { method: 'POST', path: '/v1/threads/{threadId}/reply', operationId: 'replyToThread', tag: 'send', summary: 'Reply to a received email (in_reply_to) in its thread.', auth: SEND, idempotencyKey: 'required', requestBody: 'GenericObject', responses: SENT },
  { method: 'POST', path: '/v1/messages/{inboundMessageId}/forward', operationId: 'forwardMessage', tag: 'send', summary: 'Forward a received email (text only).', auth: SEND, idempotencyKey: 'required', requestBody: 'GenericObject', responses: SENT },
  { method: 'POST', path: '/v1/agents/{agentId}/transition-announcement', operationId: 'sendTransitionAnnouncement', tag: 'send', summary: 'Announce an address change to seed contacts (always needs owner approval).', auth: SEND, idempotencyKey: 'required', requestBody: 'GenericObject', responses: { '202': 'GenericObject' } },
  { method: 'POST', path: '/v1/messages/scheduled', operationId: 'scheduleMessage', tag: 'scheduled', summary: 'Schedule an email for later (evaluated when it is sent).', auth: SEND, idempotencyKey: 'required', requestBody: 'SendRequest', responses: { '201': 'GenericObject', '200': 'GenericObject' } },
  { method: 'GET', path: '/v1/messages/scheduled', operationId: 'listScheduledMessages', tag: 'scheduled', summary: 'List scheduled emails.', auth: READ, query: [AGENT_ID_QUERY, { name: 'status', description: 'scheduled | dispatched | cancelled' }, ...PAGE], responses: { '200': 'GenericObject' } },
  { method: 'GET', path: '/v1/messages/scheduled/{scheduleId}', operationId: 'getScheduledMessage', tag: 'scheduled', summary: 'Get one scheduled email.', auth: READ, responses: { '200': 'GenericObject' } },
  { method: 'POST', path: '/v1/messages/scheduled/{scheduleId}/cancel', operationId: 'cancelScheduledMessage', tag: 'scheduled', summary: 'Cancel a scheduled email (reason required).', auth: SEND, requestBody: 'GenericObject', responses: { '200': 'GenericObject' } },
  // ---- 초안 ----
  { method: 'POST', path: '/v1/drafts', operationId: 'createDraft', tag: 'drafts', summary: 'Create a draft (may be incomplete). The body is stored outside the database.', auth: SEND, requestBody: 'DraftInput', responses: { '201': 'Draft' } },
  { method: 'GET', path: '/v1/drafts', operationId: 'listDrafts', tag: 'drafts', summary: 'List drafts, most recently changed first (no bodies).', auth: SEND, query: [AGENT_ID_QUERY, { name: 'status', description: 'active (default) | sent | discarded | all' }, ...PAGE], responses: { '200': 'DraftList' } },
  { method: 'GET', path: '/v1/drafts/{draftId}', operationId: 'getDraft', tag: 'drafts', summary: 'Get one draft with its body.', auth: SEND, responses: { '200': 'Draft' } },
  { method: 'PATCH', path: '/v1/drafts/{draftId}', operationId: 'updateDraft', tag: 'drafts', summary: 'Change a draft. Absent fields stay; null clears. Pass revision for optimistic concurrency.', auth: SEND, requestBody: 'DraftInput', responses: { '200': 'Draft' } },
  { method: 'POST', path: '/v1/drafts/{draftId}/discard', operationId: 'discardDraft', tag: 'drafts', summary: 'Discard a draft (soft; it is kept but can no longer change or be sent).', auth: SEND, responses: { '200': 'Draft' } },
  { method: 'POST', path: '/v1/drafts/{draftId}/send', operationId: 'sendDraft', tag: 'drafts', summary: 'Send a draft through the same policy gate as POST /v1/messages. A sent draft never changes.', auth: SEND, idempotencyKey: 'required', requestBody: 'GenericObject', responses: SENT },
  // ---- 받은편지함 ----
  {
    method: 'GET',
    path: '/v1/messages/inbound',
    operationId: 'listInboundMessages',
    tag: 'inbox',
    summary: 'List received emails, newest first. Quarantined emails are hidden (count only). Each item has risk, labels and read.',
    auth: READ,
    query: [
      AGENT_ID_QUERY,
      ...PAGE,
      { name: 'from', description: 'Exact sender address.' },
      { name: 'from_domain', description: 'Exact sender domain (not with from).' },
      { name: 'since', description: 'ISO 8601, inclusive.' },
      { name: 'until', description: 'ISO 8601, exclusive.' },
      { name: 'thread_id', description: 'Only this thread.' },
      { name: 'label', description: 'Only emails with this label.' },
      { name: 'unlabeled', description: '"true": only emails without labels (not with label).' },
      { name: 'read', description: '"true": only emails already read (GET of the email); "false": only unread.' },
    ],
    responses: { '200': 'InboundMessageList' },
  },
  { method: 'GET', path: '/v1/messages/inbound/{inboundMessageId}', operationId: 'getInboundMessage', tag: 'inbox', summary: 'Read one received email (marks it read).', auth: READ, responses: { '200': 'InboundMessage' } },
  { method: 'GET', path: '/v1/messages/inbound/{inboundMessageId}/attachments/{index}', operationId: 'getInboundAttachmentUrl', tag: 'inbox', summary: 'Short-lived download URL for an attachment.', auth: READ, responses: { '200': 'GenericObject' } },
  { method: 'GET', path: '/v1/messages/inbound/{inboundMessageId}/attachments/{index}/content', operationId: 'getInboundAttachmentContent', tag: 'inbox', summary: 'Attachment content as text, PDF text or image.', auth: READ, responses: { '200': 'GenericObject' } },
  { method: 'GET', path: '/v1/threads/{threadId}', operationId: 'getThread', tag: 'inbox', summary: 'A thread: sent and received emails, oldest first.', auth: READ, responses: { '200': 'Thread' } },
  { method: 'GET', path: '/v1/messages/verification-code', operationId: 'getVerificationCode', tag: 'inbox', summary: 'Latest sign-up / login code from verified senders.', auth: READ, query: [AGENT_ID_QUERY, { name: 'sender_domain', description: 'Domain of the site that sent the code. Strongly recommended.' }, { name: 'include_subdomains', description: 'true | false' }, { name: 'since', description: 'ISO 8601.' }], responses: { '200': 'GenericObject' } },
  // ---- 라벨 ----
  { method: 'PUT', path: '/v1/messages/inbound/{inboundMessageId}/labels', operationId: 'setMessageLabels', tag: 'labels', summary: 'Set (labels) or change (add/remove) the labels of a received email.', auth: READ, requestBody: 'LabelsInput', responses: { '200': 'MessageLabels' } },
  { method: 'GET', path: '/v1/labels', operationId: 'listLabels', tag: 'labels', summary: 'Labels in use with email and unread counts (visible emails only).', auth: READ, query: [AGENT_ID_QUERY], responses: { '200': 'LabelList' } },
  // ---- 첨부 ----
  { method: 'POST', path: '/v1/attachments', operationId: 'createAttachmentUpload', tag: 'attachments', summary: 'Create an outbound attachment and get a signed PUT URL. Same Idempotency-Key + same request returns the same attachment.', auth: SEND, idempotencyKey: 'optional', requestBody: 'AttachmentUploadInput', responses: { '201': 'AttachmentUpload', '200': 'AttachmentUpload' } },
  // ---- 승인 · 정책 · 감사 ----
  { method: 'GET', path: '/v1/approvals/{approvalId}', operationId: 'getApproval', tag: 'policy', summary: 'Status of an approval returned by a send.', auth: READ, responses: { '200': 'GenericObject' } },
  { method: 'GET', path: '/v1/agents/{agentId}/policy', operationId: 'getAgentPolicy', tag: 'policy', summary: 'Your outbound/inbound policy and limits (read-only).', auth: { kind: 'bearer', scope: 'agent:read_self' }, responses: { '200': 'GenericObject' } },
  {
    method: 'POST',
    path: '/v1/agents/{agentId}/policy/requests',
    operationId: 'requestPolicyChange',
    tag: 'policy',
    summary:
      'Ask your owner for one change to your own policy (add/remove one allow or block list entry, or switch a mode), with a reason. Nothing changes until your owner approves it in the console (202 pending_approval). The same pending change returns the same request (replayed).',
    auth: { kind: 'bearer', scope: 'policy:request' },
    requestBody: 'PolicyChangeRequestInput',
    responses: { '202': 'PolicyChangeRequest' },
  },
  { method: 'GET', path: '/v1/agents/{agentId}/policy/requests/{requestId}', operationId: 'getPolicyChangeRequest', tag: 'policy', summary: 'Status of a policy change request: pending_approval, approved, rejected, stale or expired.', auth: { kind: 'bearer', scope: 'agent:read_self' }, responses: { '200': 'PolicyChangeRequest' } },
  { method: 'GET', path: '/v1/audit', operationId: 'queryAudit', tag: 'policy', summary: 'Why an email was sent or blocked.', auth: { kind: 'bearer', scope: 'audit:read' }, query: [{ name: 'message_id', description: 'Outbound message id.' }], responses: { '200': 'GenericObject' } },
  // ---- 웹훅 ----
  { method: 'POST', path: '/v1/agents/{agentId}/webhook-endpoints', operationId: 'registerWebhookEndpoint', tag: 'webhooks', summary: 'Register a webhook endpoint (optionally with an Authorization header sent on every delivery).', auth: { kind: 'bearer', scope: 'webhooks:manage' }, requestBody: 'WebhookEndpointInput', responses: { '201': 'GenericObject' } },
  { method: 'GET', path: '/v1/agents/{agentId}/webhook-endpoints', operationId: 'listWebhookEndpoints', tag: 'webhooks', summary: 'List webhook endpoints.', auth: { kind: 'bearer', scope: 'messages:read or webhooks:manage' }, responses: { '200': 'GenericObject' } },
  { method: 'DELETE', path: '/v1/agents/{agentId}/webhook-endpoints/{endpointId}', operationId: 'deleteWebhookEndpoint', tag: 'webhooks', summary: 'Delete a webhook endpoint.', auth: { kind: 'bearer', scope: 'webhooks:manage' }, responses: { '200': 'GenericObject' } },
  { method: 'POST', path: '/v1/agents/{agentId}/webhook-endpoints/{endpointId}/rotate-secret', operationId: 'rotateWebhookSecret', tag: 'webhooks', summary: 'Rotate a webhook signing secret.', auth: { kind: 'bearer', scope: 'webhooks:manage' }, responses: { '200': 'GenericObject' } },
  { method: 'GET', path: '/v1/agents/{agentId}/webhook-deliveries', operationId: 'listWebhookDeliveries', tag: 'webhooks', summary: 'List webhook deliveries.', auth: READ, query: PAGE, responses: { '200': 'GenericObject' } },
  { method: 'POST', path: '/v1/agents/{agentId}/webhook-deliveries/{deliveryId}/redeliver', operationId: 'redeliverWebhookDelivery', tag: 'webhooks', summary: 'Redeliver a dead webhook delivery.', auth: { kind: 'bearer', scope: 'webhooks:manage' }, responses: { '201': 'GenericObject' } },
  // ---- 자가 등록(묶음 D) ----
  {
    method: 'POST',
    path: '/v1/agents',
    operationId: 'enrollAgent',
    tag: 'agents',
    summary:
      'Create a sibling agent in your organization (only if your owner turned on self-enrollment and granted agents:enroll). Safe defaults are fixed; the token is returned once. Counts toward a daily limit — do not retry on enroll_timeout.',
    auth: { kind: 'bearer', scope: 'agents:enroll' },
    requestBody: 'EnrollAgentInput',
    responses: { '201': 'EnrolledAgent' },
  },
  // ---- 신원 ----
  { method: 'GET', path: '/v1/identity/{address}', operationId: 'getIdentity', tag: 'identity', summary: 'Public identity (did:web passport) of an atmark address.', auth: PUBLIC, responses: { '200': 'GenericObject' } },
  // ---- 발견 ----
  { method: 'GET', path: '/v1/agents/{agentId}/realtime', operationId: 'getRealtimeConnection', tag: 'discovery', summary: 'How to connect to the realtime WebSocket (wss URL, auth, event schemas, limits, reconnect). Never returns your token. Events: see x-atmark-realtime.', auth: READ, responses: { '200': 'RealtimeConnection' } },
  { method: 'GET', path: '/v1/agents/{agentId}/capabilities', operationId: 'getCapabilities', tag: 'discovery', summary: 'Discovery document plus your address, scopes and policy summary.', auth: { kind: 'bearer', scope: 'agent:read_self' }, responses: { '200': 'Capabilities' } },
  { method: 'GET', path: '/v1/openapi.json', operationId: 'getOpenApi', tag: 'discovery', summary: 'This OpenAPI 3.1 document.', auth: PUBLIC, responses: { '200': 'GenericObject' } },
  { method: 'GET', path: '/.well-known/atmark.json', operationId: 'getDiscovery', tag: 'discovery', summary: 'Service discovery: REST base, MCP URL, OpenAPI URL, realtime, SDKs, auth and idempotency.', auth: PUBLIC, responses: { '200': 'Discovery' } },
];
