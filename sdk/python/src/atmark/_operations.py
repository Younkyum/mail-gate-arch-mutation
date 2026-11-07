"""The SDK's copy of the API operation table: operationId -> (HTTP method, path template, Idempotency-Key handling).

``tests/test_contract.py`` compares it with ``sdk/fixtures/openapi.json`` (a snapshot of the server's OpenAPI document
that the TypeScript contract test keeps current), so a new server route fails the tests until it is added here.
"""

from typing import Dict, NamedTuple, Optional


class Operation(NamedTuple):
    method: str
    path: str
    #: ``"required"`` / ``"optional"``: the SDK generates an ``Idempotency-Key`` unless the caller passes one.
    idempotency_key: Optional[str] = None


OPERATIONS: Dict[str, Operation] = {
    "sendMessage": Operation("POST", "/v1/messages", "required"),
    "replyToThread": Operation("POST", "/v1/threads/{threadId}/reply", "required"),
    "forwardMessage": Operation("POST", "/v1/messages/{inboundMessageId}/forward", "required"),
    "sendTransitionAnnouncement": Operation("POST", "/v1/agents/{agentId}/transition-announcement", "required"),
    "scheduleMessage": Operation("POST", "/v1/messages/scheduled", "required"),
    "listScheduledMessages": Operation("GET", "/v1/messages/scheduled"),
    "getScheduledMessage": Operation("GET", "/v1/messages/scheduled/{scheduleId}"),
    "cancelScheduledMessage": Operation("POST", "/v1/messages/scheduled/{scheduleId}/cancel"),
    "createDraft": Operation("POST", "/v1/drafts"),
    "listDrafts": Operation("GET", "/v1/drafts"),
    "getDraft": Operation("GET", "/v1/drafts/{draftId}"),
    "updateDraft": Operation("PATCH", "/v1/drafts/{draftId}"),
    "discardDraft": Operation("POST", "/v1/drafts/{draftId}/discard"),
    "sendDraft": Operation("POST", "/v1/drafts/{draftId}/send", "required"),
    "listInboundMessages": Operation("GET", "/v1/messages/inbound"),
    "getInboundMessage": Operation("GET", "/v1/messages/inbound/{inboundMessageId}"),
    "getInboundAttachmentUrl": Operation("GET", "/v1/messages/inbound/{inboundMessageId}/attachments/{index}"),
    "getInboundAttachmentContent": Operation("GET", "/v1/messages/inbound/{inboundMessageId}/attachments/{index}/content"),
    "getThread": Operation("GET", "/v1/threads/{threadId}"),
    "getVerificationCode": Operation("GET", "/v1/messages/verification-code"),
    "setMessageLabels": Operation("PUT", "/v1/messages/inbound/{inboundMessageId}/labels"),
    "listLabels": Operation("GET", "/v1/labels"),
    "createAttachmentUpload": Operation("POST", "/v1/attachments", "optional"),
    "getApproval": Operation("GET", "/v1/approvals/{approvalId}"),
    "getAgentPolicy": Operation("GET", "/v1/agents/{agentId}/policy"),
    "requestPolicyChange": Operation("POST", "/v1/agents/{agentId}/policy/requests"),
    "getPolicyChangeRequest": Operation("GET", "/v1/agents/{agentId}/policy/requests/{requestId}"),
    "queryAudit": Operation("GET", "/v1/audit"),
    "registerWebhookEndpoint": Operation("POST", "/v1/agents/{agentId}/webhook-endpoints"),
    "listWebhookEndpoints": Operation("GET", "/v1/agents/{agentId}/webhook-endpoints"),
    "deleteWebhookEndpoint": Operation("DELETE", "/v1/agents/{agentId}/webhook-endpoints/{endpointId}"),
    "rotateWebhookSecret": Operation("POST", "/v1/agents/{agentId}/webhook-endpoints/{endpointId}/rotate-secret"),
    "listWebhookDeliveries": Operation("GET", "/v1/agents/{agentId}/webhook-deliveries"),
    "redeliverWebhookDelivery": Operation("POST", "/v1/agents/{agentId}/webhook-deliveries/{deliveryId}/redeliver"),
    "enrollAgent": Operation("POST", "/v1/agents"),
    "getIdentity": Operation("GET", "/v1/identity/{address}"),
    "getCapabilities": Operation("GET", "/v1/agents/{agentId}/capabilities"),
    "getRealtimeConnection": Operation("GET", "/v1/agents/{agentId}/realtime"),
    "getOpenApi": Operation("GET", "/v1/openapi.json"),
    "getDiscovery": Operation("GET", "/.well-known/atmark.json"),
}
