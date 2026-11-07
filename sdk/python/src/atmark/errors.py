"""Errors. API errors look like ``{"error": "<code>", "detail": "..."}`` — branch on ``code``, never on ``detail``."""

import re
from typing import Any, Mapping, Optional

_REQUEST_ID_IN_DETAIL = re.compile(r"Request id: ([A-Za-z0-9=._-]+)")


class AtmarkError(Exception):
    """An API error. ``status`` is 0 for network errors and timeouts (see :class:`AtmarkConnectionError`)."""

    def __init__(
        self,
        status: int,
        code: str,
        detail: Optional[str],
        request_id: Optional[str] = None,
        body: Any = None,
        idempotency_key: Optional[str] = None,
    ) -> None:
        prefix = "request failed" if status == 0 else "HTTP %d" % status
        super().__init__("%s: %s%s" % (prefix, code, "" if detail is None else " — " + detail))
        self.status = status
        self.code = code
        self.detail = detail
        self.request_id = request_id
        #: The parsed response body (for example ``decision`` on ``policy_denied``).
        self.body = body
        #: The Idempotency-Key that was sent. Retry with the same key after a network error or a 5xx.
        self.idempotency_key = idempotency_key


class AtmarkConnectionError(AtmarkError):
    """A network failure or timeout — nothing is known about whether the server acted. Retrying with the same key is safe."""

    def __init__(self, code: str, detail: str, idempotency_key: Optional[str] = None) -> None:
        super().__init__(0, code, detail, idempotency_key=idempotency_key)


def request_id_from(headers: Mapping[str, str], detail: Optional[str]) -> Optional[str]:
    lowered = {key.lower(): value for key, value in headers.items()}
    for name in ("apigw-requestid", "x-request-id", "x-amzn-requestid"):
        value = lowered.get(name)
        if value:
            return value
    if detail:
        match = _REQUEST_ID_IN_DETAIL.search(detail)
        if match:
            return match.group(1)
    return None
