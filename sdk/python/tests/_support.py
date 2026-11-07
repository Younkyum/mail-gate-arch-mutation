"""Test helpers: put ``src`` on the path (the package is not installed in CI) and a scripted transport."""

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT.parent / "fixtures"
sys.path.insert(0, str(ROOT / "src"))

from atmark import Atmark, HttpRequest, HttpResponse  # noqa: E402


def json_response(status: int, body: Any, headers: Optional[Dict[str, str]] = None) -> HttpResponse:
    return HttpResponse(status, dict({"Content-Type": "application/json"}, **(headers or {})), json.dumps(body).encode("utf-8"))


Reply = Union[HttpResponse, BaseException]


class ScriptedTransport:
    def __init__(self, replies: List[Reply]) -> None:
        self.replies = list(replies)
        self.requests: List[HttpRequest] = []

    def __call__(self, request: HttpRequest) -> HttpResponse:
        self.requests.append(request)
        if not self.replies:
            raise AssertionError("no more scripted replies")
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return reply

    def body(self, index: int = 0) -> Any:
        data = self.requests[index].body
        return None if data is None else json.loads(data.decode("utf-8"))


def client(replies: List[Reply], **kwargs: Any) -> "tuple[Atmark, ScriptedTransport, List[float]]":
    transport = ScriptedTransport(replies)
    sleeps: List[float] = []
    kwargs.setdefault("token", "atk_agent_secret")
    instance = Atmark(transport=transport, sleep=sleeps.append, **kwargs)
    instance._http.rand = lambda: 0.5
    return instance, transport, sleeps
