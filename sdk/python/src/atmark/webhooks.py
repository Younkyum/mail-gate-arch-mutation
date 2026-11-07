"""Webhook signature verification (Standard Webhooks) — matches the server's reference ``verifyWebhook`` in
``src/webhooks/signing.ts`` exactly; the shared vectors in ``sdk/fixtures/webhook-vectors.json`` are generated from it.

    webhook-id:        <event id>
    webhook-timestamp: <unix seconds>
    webhook-signature: v1,<base64(HMAC-SHA256(base64decode(secret without "whsec_"), "<id>.<timestamp>.<body>"))> [...]

Several signatures appear for 24 hours after a secret rotation; any one matching is enough. Timestamps more than
5 minutes away (either direction) are refused. Pass the raw body exactly as received, before JSON parsing.
"""

import base64
import binascii
import hashlib
import hmac
import re
import time
from collections import OrderedDict
from typing import Any, Callable, Mapping, NamedTuple, Optional, Union

WEBHOOK_TOLERANCE_SECONDS = 300
_SECRET_PREFIX = "whsec_"
_TIMESTAMP = re.compile(r"[0-9]{1,12}")


class WebhookVerification(NamedTuple):
    valid: bool
    #: ``None`` when valid; else ``"malformed"`` | ``"timestamp_out_of_tolerance"`` | ``"no_matching_signature"`` | ``"duplicate"``.
    reason: Optional[str] = None
    #: The ``webhook-id`` when valid.
    id: Optional[str] = None

    def __bool__(self) -> bool:
        return self.valid


def _header(headers: Any, name: str) -> Optional[str]:
    getter = getattr(headers, "get", None)
    items = headers.items() if hasattr(headers, "items") else []
    for key, value in items:
        if isinstance(key, str) and key.lower() == name:
            if isinstance(value, (list, tuple)):
                return " ".join(str(v) for v in value)
            return str(value)
    if callable(getter):
        value = getter(name)
        if value is not None:
            return str(value)
    return None


def _b64(text: str) -> bytes:
    """Lenient base64 like Node's ``Buffer.from(s, 'base64')``: url-safe characters accepted, others ignored, padding optional."""
    cleaned = re.sub(r"[^A-Za-z0-9+/]", "", text.replace("-", "+").replace("_", "/"))
    if len(cleaned) % 4 == 1:
        cleaned = cleaned[:-1]
    try:
        return base64.b64decode(cleaned + "=" * (-len(cleaned) % 4))
    except (binascii.Error, ValueError):
        return b""


def verify_webhook_signature(
    raw_body: Union[str, bytes],
    headers: Mapping[str, Any],
    secret: str,
    tolerance_seconds: int = WEBHOOK_TOLERANCE_SECONDS,
    now: Optional[float] = None,
    seen_ids: Optional[Callable[[str], bool]] = None,
) -> WebhookVerification:
    """Verify a webhook request. ``headers`` may be any mapping (case-insensitive names). ``now`` is unix seconds.

    Retries resend the same ``webhook-id`` with a fresh signature, so process each id once: pass ``seen_ids`` — called
    only after the signature checks out, it returns True if the id was already processed (and records it otherwise);
    the result is then ``reason="duplicate"``. :class:`MemorySeenIds` is a single-process helper.
    """
    if not secret.startswith(_SECRET_PREFIX):
        raise ValueError("webhook secret must start with whsec_")
    event_id = _header(headers, "webhook-id")
    timestamp_text = _header(headers, "webhook-timestamp")
    signatures = _header(headers, "webhook-signature")
    if event_id is None or timestamp_text is None or signatures is None:
        return WebhookVerification(False, "malformed")
    if not _TIMESTAMP.fullmatch(timestamp_text):
        return WebhookVerification(False, "malformed")
    timestamp = int(timestamp_text)
    current = int(time.time() if now is None else now)
    if abs(current - timestamp) > tolerance_seconds:
        return WebhookVerification(False, "timestamp_out_of_tolerance")

    body = raw_body.encode("utf-8") if isinstance(raw_body, str) else bytes(raw_body)
    expected = hmac.new(_b64(secret[len(_SECRET_PREFIX):]), ("%s.%d." % (event_id, timestamp)).encode("utf-8") + body, hashlib.sha256).digest()
    for entry in signatures.split(" "):
        version, _, encoded = entry.partition(",")
        if version != "v1" or _ == "":
            continue
        provided = _b64(encoded.split(",")[0])
        if len(provided) == len(expected) and hmac.compare_digest(provided, expected):
            if seen_ids is not None and seen_ids(event_id):
                return WebhookVerification(False, "duplicate")
            return WebhookVerification(True, None, event_id)
    return WebhookVerification(False, "no_matching_signature")


class MemorySeenIds:
    """Single-process ``seen_ids`` helper: remembers the last ``max_ids`` ids (keep ~32 hours of traffic — retries span ~31 h 40 min).
    Use a shared store (database, cache) when several processes receive webhooks."""

    def __init__(self, max_ids: int = 10000) -> None:
        self._max = max_ids
        self._ids: "OrderedDict[str, None]" = OrderedDict()

    def __call__(self, event_id: str) -> bool:
        if event_id in self._ids:
            return True
        self._ids[event_id] = None
        if len(self._ids) > self._max:
            self._ids.popitem(last=False)
        return False
