"""Realtime client (WebSocket, asyncio). Needs the optional extra: ``pip install 'atmark-sdk[realtime]'`` (``websockets``).

Events are hints — "go and read" — delivered best-effort, at most once. Events missed while disconnected are not
replayed: when ``on_open(reconnected=True)`` fires, catch up with ``messages.inbound.list(since=...)``. Use webhooks
when you need guaranteed delivery.

The token goes in the ``Authorization`` header (subprotocol ``atmark.v1``) — never in the URL. The client pings
(``{"action":"ping"}``) every 5 minutes, opens a fresh connection before the server's 2-hour limit, and reconnects with
exponential backoff and full jitter (1 s → 60 s).
"""

import asyncio
import json
import random
import re
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional, Sequence, Set

REALTIME_SUBPROTOCOL = "atmark.v1"
KNOWN_EVENT_TYPES = frozenset({"message.received", "approval.resolved", "message.sent", "message.bounced"})
_CONTROL_TYPES = frozenset({"pong", "subscribed", "error"})
_ENVELOPE_KEYS = frozenset({"id", "event_id", "type", "api_version", "created_at", "agent_id", "dedupe_key"})
_DEDUPE_WINDOW = 1024
_STABLE_AFTER = 60.0


@dataclass(frozen=True)
class RealtimeEvent:
    id: Optional[str]
    type: str
    agent_id: Optional[str]
    data: Dict[str, Any]
    api_version: Optional[str] = None
    created_at: Optional[str] = None
    #: False for event types this SDK version does not know.
    known: bool = True
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)
    #: Stable key for the underlying fact (``<type>:<entity id>``); falls back to ``id``. The same mail pushed twice has the same key.
    dedupe_key: Optional[str] = None

    @property
    def message_count(self) -> Optional[int]:
        """``approval.resolved``: total messages covered. ``message_ids`` holds at most 50; when ``truncated``, use ``approvals.get``."""
        value = self.data.get("message_count")
        return value if isinstance(value, int) else None

    @property
    def truncated(self) -> bool:
        return self.data.get("truncated") is True

    @property
    def event_id(self) -> Optional[str]:
        return self.id

    @property
    def risk(self) -> Optional[Dict[str, Any]]:
        """``message.received`` only: ``{"level": "none" | "risk" | "block"}``. Not ``none``: treat the email as hostile."""
        value = self.data.get("risk")
        return value if isinstance(value, dict) else None

    def __getitem__(self, key: str) -> Any:
        return self.data[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)


class EventDeduper:
    """Drop duplicate events (redeliveries, late verdicts, events merged from realtime + webhooks + a catch-up list).

    ``deduper.is_new(event)`` (or ``deduper(event)``) is True the first time an event's ``dedupe_key`` (or ``id``) is seen.
    Works with :class:`RealtimeEvent` and plain dicts. Remembers the last ``window`` keys.
    """

    def __init__(self, window: int = _DEDUPE_WINDOW) -> None:
        self._window = window
        self._order: List[str] = []
        self._seen: Set[str] = set()

    def is_new(self, event: Any) -> bool:
        if isinstance(event, dict):
            key = event.get("dedupe_key") or event.get("id")
        else:
            key = getattr(event, "dedupe_key", None) or getattr(event, "id", None)
        if not isinstance(key, str):
            return True
        if key in self._seen:
            return False
        self._seen.add(key)
        self._order.append(key)
        if len(self._order) > self._window:
            self._seen.discard(self._order.pop(0))
        return True

    __call__ = is_new


def parse_realtime_frame(text: str) -> Optional[RealtimeEvent]:
    """Parse one frame (envelope ``{id, type, …, data}`` or a flat shape). ``None`` for control frames and garbage."""
    try:
        record = json.loads(text)
    except ValueError:
        return None
    if not isinstance(record, dict) or not isinstance(record.get("type"), str):
        return None
    event_type = record["type"]
    if event_type in _CONTROL_TYPES:
        return None
    event_id = record.get("id") if isinstance(record.get("id"), str) else record.get("event_id")
    event_id = event_id if isinstance(event_id, str) else None
    nested = record.get("data")
    data = dict(nested) if isinstance(nested, dict) else {k: v for k, v in record.items() if k not in _ENVELOPE_KEYS}
    known = event_type in KNOWN_EVENT_TYPES and event_id is not None
    if known and event_type == "message.received":
        risk = data.get("risk") if isinstance(data.get("risk"), dict) else {}
        level = risk.get("level")
        data["risk"] = dict(risk, level=level if level in ("none", "risk", "block") else "block")
    agent_id = record.get("agent_id")
    dedupe_key = record.get("dedupe_key") if isinstance(record.get("dedupe_key"), str) else event_id
    return RealtimeEvent(
        id=event_id,
        type=event_type,
        agent_id=agent_id if isinstance(agent_id, str) else None,
        data=data,
        api_version=record.get("api_version") if isinstance(record.get("api_version"), str) else None,
        created_at=record.get("created_at") if isinstance(record.get("created_at"), str) else None,
        known=known,
        raw=record,
        dedupe_key=dedupe_key,
    )


_BUILTIN_HOST = "realtime.atmark.ai"
_EXECUTE_API_HOST = re.compile(r"[a-z0-9]+\.execute-api\.ap-northeast-2\.amazonaws\.com")
_LOOPBACK = ("localhost", "127.0.0.1", "::1")


def check_realtime_url(url: str, source: str, extra_hosts: Sequence[str] = ()) -> None:
    """Where the token may go. ``source="api"`` (connection info / discovery): ``wss://`` on ``realtime.atmark.ai``,
    ``*.execute-api.ap-northeast-2.amazonaws.com`` or a host in ``extra_hosts``. ``source="caller"`` (an explicit
    ``url=``): any host, but ``wss://`` (``ws://`` only on loopback, for tests). Raises ``ValueError`` otherwise."""
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower()
    loopback_ws = source == "caller" and parts.scheme == "ws" and host in _LOOPBACK
    if parts.scheme != "wss" and not loopback_ws:
        raise ValueError("refusing to send the token: realtime URL must be wss:// (got %r)" % parts.scheme)
    if parts.username or parts.password:
        raise ValueError("refusing to send the token: realtime URL carries credentials")
    if source == "caller":
        return
    if host == _BUILTIN_HOST or _EXECUTE_API_HOST.fullmatch(host) or host in {h.lower() for h in extra_hosts}:
        return
    raise ValueError("refusing to send the token: realtime host %r is not an Atmark host (pass realtime_hosts to allow it)" % host)


#: ``connect(url, headers, subprotocols)`` -> an object with ``async send(str)``, ``async recv() -> str|bytes`` and ``async close()``.
Connector = Callable[[str, Dict[str, str], List[str]], Awaitable[Any]]


async def websockets_connect(url: str, headers: Dict[str, str], subprotocols: List[str]) -> Any:
    try:
        import websockets  # noqa: F401
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise ImportError("The realtime client needs the 'websockets' package: pip install 'atmark-sdk[realtime]'") from exc
    try:
        from websockets.asyncio.client import connect as modern_connect  # websockets >= 13
    except ImportError:  # pragma: no cover - older websockets
        import websockets.legacy.client as legacy  # type: ignore[import-not-found]

        return await legacy.connect(url, extra_headers=headers, subprotocols=subprotocols)
    return await modern_connect(url, additional_headers=headers, subprotocols=subprotocols)  # type: ignore[arg-type]


class RealtimeClient:
    def __init__(
        self,
        token: Optional[str],
        resolve_url: Callable[[], str],
        connector: Optional[Connector] = None,
        rand: Callable[[], float] = random.random,
        allowed_hosts: Sequence[str] = (),
    ) -> None:
        self._allowed_hosts = tuple(allowed_hosts)
        self._token = token
        self._resolve_url = resolve_url
        self._connector = connector or websockets_connect
        self._rand = rand

    async def events(
        self,
        url: Optional[str] = None,
        stop: Optional[asyncio.Event] = None,
        include_unknown: bool = False,
        on_open: Optional[Callable[[bool], Any]] = None,
        on_error: Optional[Callable[[BaseException], Any]] = None,
        ping_interval: float = 300.0,
        max_connection_age: float = 115 * 60.0,
        initial_delay: float = 1.0,
        max_delay: float = 60.0,
    ) -> AsyncIterator[RealtimeEvent]:
        """Yield events until ``stop`` is set (or the consumer stops iterating). Reconnects on its own."""
        if not self._token:
            raise ValueError("A token is required for realtime connections.")
        stop = stop or asyncio.Event()
        loop = asyncio.get_running_loop()
        deduper = EventDeduper()
        failures = 0
        opens = 0

        def report(error: BaseException) -> None:
            if on_error is not None:
                on_error(error)

        while not stop.is_set():
            try:
                target = url if url is not None else await loop.run_in_executor(None, self._resolve_url)
                if self._token in target:
                    raise ValueError("refusing to put the token in the realtime URL")
                check_realtime_url(target, "api" if url is None else "caller", self._allowed_hosts)
                socket = await self._connector(target, {"Authorization": "Bearer " + self._token}, [REALTIME_SUBPROTOCOL])
            except Exception as error:  # noqa: BLE001 — reported, then retried
                report(error)
                failures = await self._backoff(failures, initial_delay, max_delay, stop)
                continue

            opened_at = loop.time()
            if on_open is not None:
                on_open(opens > 0)
            opens += 1
            pinger = asyncio.ensure_future(self._ping(socket, ping_interval))
            stopper = asyncio.ensure_future(stop.wait())
            rotate = False
            try:
                while True:
                    remaining = max_connection_age - (loop.time() - opened_at)
                    if remaining <= 0:
                        rotate = True
                        break
                    receiver = asyncio.ensure_future(socket.recv())
                    done, _ = await asyncio.wait({receiver, stopper}, timeout=remaining, return_when=asyncio.FIRST_COMPLETED)
                    if receiver not in done:
                        receiver.cancel()
                        if stopper in done:
                            break
                        rotate = True
                        break
                    frame = receiver.result()
                    text = frame.decode("utf-8", errors="replace") if isinstance(frame, (bytes, bytearray)) else str(frame)
                    event = parse_realtime_frame(text)
                    if event is None or (not event.known and not include_unknown):
                        continue
                    if not deduper.is_new(event):
                        continue
                    yield event
            except Exception as error:  # noqa: BLE001 — connection dropped
                report(error)
            finally:
                pinger.cancel()
                stopper.cancel()
                try:
                    await socket.close()
                except Exception:  # noqa: BLE001
                    pass
            if loop.time() - opened_at >= _STABLE_AFTER:
                failures = 0
            if stop.is_set():
                return
            if not rotate:
                failures = await self._backoff(failures, initial_delay, max_delay, stop)

    async def run(
        self,
        on_event: Callable[[RealtimeEvent], Any],
        on_unknown_event: Optional[Callable[[RealtimeEvent], Any]] = None,
        on_error: Optional[Callable[[BaseException], Any]] = None,
        **options: Any,
    ) -> None:
        """Call ``on_event`` (sync or async) for each event until ``stop`` (an ``asyncio.Event`` in options) is set."""
        async for event in self.events(include_unknown=on_unknown_event is not None, on_error=on_error, **options):
            handler = on_event if event.known else on_unknown_event
            if handler is None:
                continue
            try:
                result = handler(event)
                if asyncio.iscoroutine(result):
                    await result
            except Exception as error:  # noqa: BLE001 — a handler bug must not drop the connection
                if on_error is not None:
                    on_error(error)

    async def _ping(self, socket: Any, interval: float) -> None:
        while True:
            await asyncio.sleep(interval)
            await socket.send(json.dumps({"action": "ping"}))

    async def _backoff(self, failures: int, initial: float, maximum: float, stop: asyncio.Event) -> int:
        delay = self._rand() * min(maximum, initial * (2 ** min(failures, 16)))
        try:
            await asyncio.wait_for(stop.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass
        return failures + 1
