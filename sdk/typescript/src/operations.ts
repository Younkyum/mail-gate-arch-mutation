/**
 * The SDK's own copy of the API operation table: operationId -> HTTP method, path template and Idempotency-Key handling.
 *
 * The contract test (`test/contract.test.ts`) compares this table with the server's OpenAPI source of truth
 * (`src/api/openapi/operations.ts`) in both directions, and checks that a client method really calls each one.
 * When the server adds a route, that test fails until a method is added here and on a resource client.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface OperationSpec {
  readonly method: HttpMethod;
  /** Path template with `{name}` parameters, relative to the API origin. */
  readonly path: string;
  /** `required` / `optional`: the SDK generates an `Idempotency-Key` unless the caller passes one. */
  readonly idempotencyKey?: 'required' | 'optional';
}

export const OPERATIONS = {
  sendMessage: { method: 'POST', path: '/v1/messages', idempotencyKey: 'required' },
  replyToThread: { method: 'POST', path: '/v1/threads/{threadId}/reply', idempotencyKey: 'required' },
  forwardMessage: { method: 'POST', path: '/v1/messages/{inboundMessageId}/forward', idempotencyKey: 'required' },
  sendTransitionAnnouncement: { method: 'POST', path: '/v1/agents/{agentId}/transition-announcement', idempotencyKey: 'required' },
  scheduleMessage: { method: 'POST', path: '/v1/messages/scheduled', idempotencyKey: 'required' },
  listScheduledMessages: { method: 'GET', path: '/v1/messages/scheduled' },
  getScheduledMessage: { method: 'GET', path: '/v1/messages/scheduled/{scheduleId}' },
  cancelScheduledMessage: { method: 'POST', path: '/v1/messages/scheduled/{scheduleId}/cancel' },
  createDraft: { method: 'POST', path: '/v1/drafts' },
  listDrafts: { method: 'GET', path: '/v1/drafts' },
  getDraft: { method: 'GET', path: '/v1/drafts/{draftId}' },
  updateDraft: { method: 'PATCH', path: '/v1/drafts/{draftId}' },
  discardDraft: { method: 'POST', path: '/v1/drafts/{draftId}/discard' },
  sendDraft: { method: 'POST', path: '/v1/drafts/{draftId}/send', idempotencyKey: 'required' },
  listInboundMessages: { method: 'GET', path: '/v1/messages/inbound' },
  getInboundMessage: { method: 'GET', path: '/v1/messages/inbound/{inboundMessageId}' },
  getInboundAttachmentUrl: { method: 'GET', path: '/v1/messages/inbound/{inboundMessageId}/attachments/{index}' },
  getInboundAttachmentContent: { method: 'GET', path: '/v1/messages/inbound/{inboundMessageId}/attachments/{index}/content' },
  getThread: { method: 'GET', path: '/v1/threads/{threadId}' },
  getVerificationCode: { method: 'GET', path: '/v1/messages/verification-code' },
  setMessageLabels: { method: 'PUT', path: '/v1/messages/inbound/{inboundMessageId}/labels' },
  listLabels: { method: 'GET', path: '/v1/labels' },
  createAttachmentUpload: { method: 'POST', path: '/v1/attachments', idempotencyKey: 'optional' },
  getApproval: { method: 'GET', path: '/v1/approvals/{approvalId}' },
  getAgentPolicy: { method: 'GET', path: '/v1/agents/{agentId}/policy' },
  requestPolicyChange: { method: 'POST', path: '/v1/agents/{agentId}/policy/requests' },
  getPolicyChangeRequest: { method: 'GET', path: '/v1/agents/{agentId}/policy/requests/{requestId}' },
  queryAudit: { method: 'GET', path: '/v1/audit' },
  registerWebhookEndpoint: { method: 'POST', path: '/v1/agents/{agentId}/webhook-endpoints' },
  listWebhookEndpoints: { method: 'GET', path: '/v1/agents/{agentId}/webhook-endpoints' },
  deleteWebhookEndpoint: { method: 'DELETE', path: '/v1/agents/{agentId}/webhook-endpoints/{endpointId}' },
  rotateWebhookSecret: { method: 'POST', path: '/v1/agents/{agentId}/webhook-endpoints/{endpointId}/rotate-secret' },
  listWebhookDeliveries: { method: 'GET', path: '/v1/agents/{agentId}/webhook-deliveries' },
  redeliverWebhookDelivery: { method: 'POST', path: '/v1/agents/{agentId}/webhook-deliveries/{deliveryId}/redeliver' },
  enrollAgent: { method: 'POST', path: '/v1/agents' },
  getIdentity: { method: 'GET', path: '/v1/identity/{address}' },
  getCapabilities: { method: 'GET', path: '/v1/agents/{agentId}/capabilities' },
  getRealtimeConnection: { method: 'GET', path: '/v1/agents/{agentId}/realtime' },
  getOpenApi: { method: 'GET', path: '/v1/openapi.json' },
  getDiscovery: { method: 'GET', path: '/.well-known/atmark.json' },
} as const satisfies Record<string, OperationSpec>;

export type OperationId = keyof typeof OPERATIONS;
