"""HTTP core (standard library only): auth header, JSON, timeouts, Idempotency-Key and safe retries.

Retry rule — a request is retried only if repeating it cannot act twice: GET / PUT / DELETE, or any request carrying an
Idempotency-Key (the server replays the first result). Retried outcomes (never the codes in ``NEVER_RETRY_CODES``): network errors, timeouts, 429, 500, 502
(except ``send_failed`` — nothing went out; send again with a NEW key), 503, 504 and 409 ``policy_changing``.
Backoff: exponential with full jitter, capped; ``Retry-After`` (seconds or HTTP date) wins when present.
"""

import email.utils
import json
import random
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable, Dict, Mapping, NamedTuple, Optional

from ._operations import OPERATIONS
from .errors import AtmarkConnectionError, AtmarkError, request_id_from

RETRY_BASE = 0.5
RETRY_CAP = 20.0
RETRY_AFTER_CAP = 60.0


class HttpRequest(NamedTuple):
    method: str
    url: str
    headers: Dict[str, str]
    body: Optional[bytes]
    timeout: float


class HttpResponse(NamedTuple):
    status: int
    headers: Dict[str, str]
    body: bytes


#: A transport sends one request and returns the response (any status). It raises ``OSError``/``urllib.error.URLError``
#: (or ``TimeoutError``) for network failures. Tests inject their own.
Transport = Callable[[HttpRequest], HttpResponse]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects: urllib would carry the Authorization header to whatever host a redirect names.
    A 3xx surfaces as an ``HTTPError`` and becomes an ``unexpected_redirect`` error."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:  # noqa: D102
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def urllib_transport(request: HttpRequest) -> HttpResponse:
    req = urllib.request.Request(request.url, data=request.body, method=request.method, headers=request.headers)
    try:
        with _OPENER.open(req, timeout=request.timeout) as response:  # https API origin (checked by the client)
            return HttpResponse(response.status, dict(response.headers.items()), response.read())
    except urllib.error.HTTPError as error:
        with error:
            body = error.read() if error.fp is not None else b""
            return HttpResponse(error.code, dict(error.headers.items()) if error.headers else {}, body)


def new_idempotency_key() -> str:
    return str(uuid.uuid4())


def retry_after_seconds(value: Optional[str], now: Optional[float] = None) -> Optional[float]:
    if value is None:
        return None
    text = value.strip()
    if re.fullmatch(r"\d+(\.\d+)?", text):
        return min(RETRY_AFTER_CAP, float(text))
    try:
        parsed = email.utils.parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None
    if parsed is None:
        return None
    current = time.time() if now is None else now
    return min(RETRY_AFTER_CAP, max(0.0, parsed.timestamp() - current))


def backoff_seconds(attempt: int, rand: Callable[[], float] = random.random) -> float:
    return rand() * min(RETRY_CAP, RETRY_BASE * (2 ** attempt))


#: Never retried, whatever the status: self-enrollment counts every attempt toward a daily limit, and ``enroll_timeout``
#: means the agent may already exist (ask the owner before calling again).
NEVER_RETRY_CODES = frozenset({"send_failed", "enroll_timeout", "enroll_busy", "enroll_daily_cap", "enroll_unavailable"})


def _retryable(status: int, code: Optional[str]) -> bool:
    if code is not None and code in NEVER_RETRY_CODES:
        return False
    if status in (429, 500, 502, 503, 504):
        return True
    if status == 409:
        return code == "policy_changing"
    return False


def _build_path(template: str, params: Optional[Mapping[str, Any]]) -> str:
    def replace(match: "re.Match[str]") -> str:
        name = match.group(1)
        value = None if params is None else params.get(name)
        if value is None or value == "":
            raise TypeError("missing path parameter: %s" % name)
        return urllib.parse.quote(str(value), safe="")

    return re.sub(r"\{([A-Za-z]+)\}", replace, template)


def _query_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _build_query(query: Optional[Mapping[str, Any]]) -> str:
    if not query:
        return ""
    pairs = [(key, _query_value(value)) for key, value in query.items() if value is not None]
    return "" if not pairs else "?" + urllib.parse.urlencode(pairs)


def _parse(body: bytes) -> Any:
    if not body:
        return None
    text = body.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except ValueError:
        return text


class HttpClient:
    def __init__(
        self,
        token: Optional[str],
        origin: str,
        transport: Transport,
        timeout: float,
        max_retries: int,
        user_agent: str,
        sleep: Callable[[float], None] = time.sleep,
        rand: Callable[[], float] = random.random,
    ) -> None:
        self.token = token
        self.origin = origin
        self.transport = transport
        self.timeout = timeout
        self.max_retries = max_retries
        self.user_agent = user_agent
        self.sleep = sleep
        self.rand = rand

    def call(
        self,
        operation_id: str,
        path: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        body: Any = None,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
    ) -> Any:
        spec = OPERATIONS[operation_id]
        url = self.origin + _build_path(spec.path, path) + _build_query(query)
        # Only operations the server de-duplicates get a key — elsewhere a key would make a call look retry-safe when it is not.
        key = (idempotency_key if idempotency_key is not None else new_idempotency_key()) if spec.idempotency_key else None
        retry_safe = spec.method in ("GET", "PUT", "DELETE") or key is not None
        retries = max(0, self.max_retries if max_retries is None else max_retries) if retry_safe else 0

        headers = {"Accept": "application/json", "User-Agent": self.user_agent}
        if self.token is not None:
            headers["Authorization"] = "Bearer " + self.token
        if key is not None:
            headers["Idempotency-Key"] = key
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        request = HttpRequest(spec.method, url, headers, data, self.timeout if timeout is None else timeout)

        attempt = 0
        while True:
            hint: Optional[float] = None
            try:
                response = self.transport(request)
            except (socket.timeout, TimeoutError) as exc:
                error: AtmarkError = AtmarkConnectionError("timeout", "No response within %s s." % request.timeout, key)
                error.__cause__ = exc
            except (urllib.error.URLError, OSError) as exc:
                reason = getattr(exc, "reason", exc)
                if isinstance(reason, (socket.timeout, TimeoutError)):
                    error = AtmarkConnectionError("timeout", "No response within %s s." % request.timeout, key)
                else:
                    error = AtmarkConnectionError("network_error", str(reason), key)
                error.__cause__ = exc
            else:
                parsed = _parse(response.body)
                if 200 <= response.status < 300:
                    return parsed
                if 300 <= response.status < 400:
                    raise AtmarkError(response.status, "unexpected_redirect", "The API answered with a redirect; it was not followed.", idempotency_key=key)
                code = parsed.get("error") if isinstance(parsed, dict) and isinstance(parsed.get("error"), str) else None
                detail = None
                if isinstance(parsed, dict):
                    for field in ("detail", "message"):
                        if isinstance(parsed.get(field), str):
                            detail = parsed[field]
                            break
                elif isinstance(parsed, str) and parsed:
                    detail = parsed
                error = AtmarkError(
                    response.status,
                    code or "unknown_error",
                    detail,
                    request_id=request_id_from(response.headers, detail),
                    body=parsed,
                    idempotency_key=key,
                )
                if not _retryable(response.status, code):
                    raise error
                lowered = {name.lower(): value for name, value in response.headers.items()}
                hint = retry_after_seconds(lowered.get("retry-after"))
            if attempt >= retries:
                raise error
            self.sleep(hint if hint is not None else backoff_seconds(attempt, self.rand))
            attempt += 1
