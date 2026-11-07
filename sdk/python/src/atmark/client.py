import urllib.parse
from typing import Any, Callable, Optional, Sequence

from ._http import HttpClient, Transport, urllib_transport
from .errors import AtmarkError
from .realtime import Connector, RealtimeClient
from .resources import (
    Agents,
    Approvals,
    Attachments,
    Audit,
    Capabilities,
    Discovery,
    Drafts,
    Identity,
    Labels,
    Messages,
    Policy,
    Threads,
    Webhooks,
    _Context,
)

SDK_VERSION = "0.1.1"
DEFAULT_ORIGIN = "https://api.atmark.ai"


_LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")


def _normalize_origin(base_url: str, allow_insecure: bool = False) -> str:
    """``https://`` only; ``http://`` is accepted for loopback hosts with ``allow_insecure=True`` (local tests)."""
    parts = urllib.parse.urlsplit(base_url)
    insecure_ok = parts.scheme == "http" and allow_insecure and parts.hostname in _LOOPBACK_HOSTS
    if parts.scheme != "https" and not insecure_ok:
        raise ValueError("base_url must be https:// (http://localhost or 127.0.0.1 only with allow_insecure=True)")
    if not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("base_url must be a plain origin without credentials, a query or a fragment")
    origin = (parts.scheme + "://" + parts.netloc + parts.path).rstrip("/")
    return origin[: -len("/v1")] if origin.endswith("/v1") else origin


class Atmark:
    """Atmark API client.

    ``token`` is the agent token (``atk_agent_…``) your owner created in the console; it is optional only for public
    calls (identity lookup, discovery). ``agent_id`` is optional: an agent token is bound to one agent, and left out the
    server uses that agent (path calls use ``/v1/agents/me/…``). ``base_url`` must be
    ``https://`` (``allow_insecure=True`` permits ``http://localhost`` for tests). ``realtime_hosts`` adds hosts the
    realtime client may send the token to (built in: ``realtime.atmark.ai``, ``*.execute-api.ap-northeast-2.amazonaws.com``).
    """

    def __init__(
        self,
        token: Optional[str] = None,
        base_url: str = DEFAULT_ORIGIN,
        agent_id: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 2,
        transport: Optional[Transport] = None,
        realtime_connector: Optional[Connector] = None,
        sleep: Optional[Callable[[float], None]] = None,
        allow_insecure: bool = False,
        realtime_hosts: Sequence[str] = (),
    ) -> None:
        chosen = transport or urllib_transport
        http = HttpClient(token, _normalize_origin(base_url, allow_insecure), chosen, timeout, max_retries, "atmark-sdk-python/" + SDK_VERSION)
        if sleep is not None:
            http.sleep = sleep
        self._http = http
        if agent_id == "":
            raise ValueError("agent_id must not be empty — omit it to use the agent of your token")
        context = _Context(http, agent_id, chosen)
        self.messages = Messages(context)
        self.threads = Threads(context)
        self.drafts = Drafts(context)
        self.labels = Labels(context)
        self.attachments = Attachments(context)
        self.approvals = Approvals(context)
        self.policy = Policy(context)
        self.capabilities = Capabilities(context)
        self.agents = Agents(context)
        self.identity = Identity(context)
        self.webhooks = Webhooks(context)
        self.audit = Audit(context)
        self.discovery = Discovery(context)
        self._agent_id = agent_id
        self.realtime = RealtimeClient(token, self._realtime_url, realtime_connector, allowed_hosts=realtime_hosts)

    def _realtime_url(self) -> str:
        """The agent's connection info (``GET /v1/agents/{id}/realtime``) when an agent_id is known, else the public discovery document."""
        if self._agent_id is not None:
            try:
                info = self.agents.realtime(self._agent_id)
                if isinstance(info, dict) and isinstance(info.get("url"), str) and info["url"]:
                    return info["url"]
            except AtmarkError:
                pass
        document: Any = self.discovery.get()
        realtime = document.get("realtime") if isinstance(document, dict) else None
        url = realtime.get("url") if isinstance(realtime, dict) else None
        if not isinstance(url, str) or not url:
            raise ValueError("discovery document has no realtime.url")
        return url
