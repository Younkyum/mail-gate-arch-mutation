"""Request and response shapes (from the OpenAPI document ``GET /v1/openapi.json``). Responses are plain ``dict``s; the
server may add fields at any time. ``agent_id`` is optional in inputs: left out, the server uses the agent of your token."""

from typing import Any, Dict, List, Literal, Optional, TypedDict

RiskLevel = Literal["none", "risk", "block"]

Risk = TypedDict(
    "Risk",
    {
        "level": RiskLevel,
        "families": List[str],
        "trusted_bypass": bool,
        "released": bool,
        "untrusted_content": bool,
        "taint": Optional[str],
    },
    total=False,
)

SendRequest = TypedDict(
    "SendRequest",
    {
        "agent_id": str,
        "from": str,
        "to": List[str],
        "subject": str,
        "text": str,
        "html": Optional[str],
        "attachments": List[str],
        "trace_id": str,
    },
    total=False,
)

ScheduleRequest = TypedDict(
    "ScheduleRequest",
    {
        "agent_id": str,
        "from": str,
        "to": List[str],
        "subject": str,
        "text": str,
        "html": Optional[str],
        "attachments": List[str],
        "trace_id": str,
        "send_at": str,
        "agent_cancellable": bool,
    },
    total=False,
)

ReplyRequest = TypedDict(
    "ReplyRequest",
    {
        "agent_id": str,
        "in_reply_to": str,
        "text": str,
        "html": Optional[str],
        "to": List[str],
        "subject": str,
        "from": str,
        "attachments": List[str],
        "trace_id": str,
    },
    total=False,
)

ForwardRequest = TypedDict(
    "ForwardRequest",
    {"agent_id": str, "from": str, "to": List[str], "text": str, "subject": str, "trace_id": str},
    total=False,
)

DraftInput = TypedDict(
    "DraftInput",
    {
        "agent_id": str,
        "from": Optional[str],
        "to": Optional[List[str]],
        "subject": Optional[str],
        "text": str,
        "html": Optional[str],
        "in_reply_to": Optional[str],
        "attachments": Optional[List[str]],
        "revision": int,
    },
    total=False,
)


class LabelsInput(TypedDict, total=False):
    labels: List[str]
    add: List[str]
    remove: List[str]


class AttachmentUploadInput(TypedDict, total=False):
    agent_id: str
    filename: str
    mime_type: Literal["application/pdf", "image/png", "image/jpeg", "text/plain"]
    bytes: int
    sha256: str


class WebhookEndpointInput(TypedDict, total=False):
    url: str
    event_types: List[str]
    # Optional full Authorization header value (e.g. "Bearer <token>") sent with every delivery. Stored encrypted, never returned.
    authorization: str


JsonObject = Dict[str, Any]


SendApproval = Literal["auto", "always"]


class EnrollAgentInput(TypedDict, total=False):
    #: Display name, 1–80 visible characters (required).
    name: str
    #: Address local part; omit for a random one.
    local_part: str


class EnrolledAgentDefaults(TypedDict, total=False):
    outbound_mode: Literal["allowlist_only"]
    outbound_allow: List[str]
    inbound_mode: Literal["all"]
    send_approval: Literal["always"]
    risk_handling: Literal["hold"]


class EnrolledAgent(TypedDict, total=False):
    """201 of ``agents.create()``. ``token`` is shown only in this response — store it right away; never email it."""

    agent: Dict[str, str]
    token: str
    token_scopes: List[str]
    token_shown_once: bool
    defaults: EnrolledAgentDefaults
    policy_version: int
    how_to_change: str


class SelfEnrollStatus(TypedDict, total=False):
    """``capabilities.get()["self_enroll"]`` (``None`` when the server could not load it)."""

    available: bool
    scope_granted: bool
    enabled_by_owner: bool
    daily_cap: int
    used_last_24h: int
    endpoint: str
    mcp_tool: str
    defaults: Dict[str, Any]
