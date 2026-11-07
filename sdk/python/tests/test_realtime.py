import asyncio
import json
import unittest
from typing import Any, Dict, List, Optional

from _support import client, json_response

from atmark import EventDeduper, RealtimeEvent, check_realtime_url, parse_realtime_frame
from atmark.realtime import RealtimeClient

TOKEN = "atk_agent_realtimesecret"
AGENT = "a" * 32
MESSAGE_ID = "11111111-2222-4333-8444-555555555555"


def envelope(event_type: str, data: Dict[str, Any], event_id: str = "e1") -> str:
    return json.dumps({"id": event_id, "type": event_type, "api_version": "2026-10-08", "created_at": "2026-10-08T09:00:00.000Z", "agent_id": AGENT, "data": data})


class FakeSocket:
    def __init__(self, frames: List[Any]) -> None:
        self.frames: "asyncio.Queue[Any]" = asyncio.Queue()
        for frame in frames:
            self.frames.put_nowait(frame)
        self.sent: List[str] = []
        self.closed = False

    async def recv(self) -> Any:
        frame = await self.frames.get()
        if isinstance(frame, BaseException):
            raise frame
        return frame

    async def send(self, data: str) -> None:
        self.sent.append(data)

    async def close(self) -> None:
        self.closed = True


class FakeConnector:
    def __init__(self, sockets: List[Any]) -> None:
        self.sockets = sockets
        self.calls: List[Dict[str, Any]] = []

    async def __call__(self, url: str, headers: Dict[str, str], subprotocols: List[str]) -> Any:
        self.calls.append({"url": url, "headers": headers, "subprotocols": subprotocols})
        if not self.sockets:
            await asyncio.sleep(3600)
        socket = self.sockets.pop(0)
        if isinstance(socket, BaseException):
            raise socket
        return socket


def run(coro: Any) -> Any:
    return asyncio.run(asyncio.wait_for(coro, timeout=5))


class ParseTest(unittest.TestCase):
    def test_envelope_flat_control_and_garbage(self) -> None:
        event = parse_realtime_frame(envelope("message.received", {"message_id": MESSAGE_ID, "thread_id": "t", "received_at": "x", "risk": {"level": "risk"}}))
        assert event is not None
        self.assertTrue(event.known)
        self.assertEqual((event.event_id, event["message_id"], event.risk), ("e1", MESSAGE_ID, {"level": "risk"}))
        flat = parse_realtime_frame(json.dumps({"event_id": "f", "type": "message.received", "agent_id": AGENT, "message_id": MESSAGE_ID, "risk": {"level": "??"}}))
        assert flat is not None
        self.assertEqual((flat.id, flat["message_id"], flat.risk), ("f", MESSAGE_ID, {"level": "block"}))
        self.assertIsNone(parse_realtime_frame('{"type":"pong"}'))
        self.assertIsNone(parse_realtime_frame("nope"))
        unknown = parse_realtime_frame(envelope("agent.enrolled", {}))
        assert unknown is not None
        self.assertFalse(unknown.known)


class EnvelopeTest(unittest.TestCase):
    def test_dedupe_key_and_truncated_approvals(self) -> None:
        frame = json.loads(envelope("approval.resolved", {"approval_id": "ap", "decision": "approved", "resolved_at": "x", "message_ids": [MESSAGE_ID], "message_count": 120, "truncated": True}, "id-3"))
        frame["dedupe_key"] = "approval.resolved:ap"
        event = parse_realtime_frame(json.dumps(frame))
        assert event is not None
        self.assertEqual((event.dedupe_key, event.message_count, event.truncated, len(event["message_ids"])), ("approval.resolved:ap", 120, True, 1))
        plain = parse_realtime_frame(envelope("message.sent", {"message_id": MESSAGE_ID, "sent_at": "x"}, "only-id"))
        assert plain is not None
        self.assertEqual((plain.dedupe_key, plain.message_count, plain.truncated), ("only-id", None, False))

    def test_deduper(self) -> None:
        is_new = EventDeduper(window=2)
        self.assertEqual([is_new({"dedupe_key": "a"}), is_new({"dedupe_key": "a"}), is_new({"id": "b"}), is_new({"id": "c"}), is_new({"dedupe_key": "a"}), is_new({})], [True, False, True, True, True, True])

    def test_stream_drops_same_fact_with_different_ids(self) -> None:
        async def scenario() -> None:
            stop = asyncio.Event()
            data = {"message_id": MESSAGE_ID, "thread_id": "t", "received_at": "x", "risk": {"level": "none"}}
            frames = []
            for event_id in ("id-1", "id-2"):
                frame = json.loads(envelope("message.received", data, event_id))
                frame["dedupe_key"] = "message.received:" + MESSAGE_ID
                frames.append(json.dumps(frame))
            frames.append(envelope("message.sent", {"message_id": MESSAGE_ID, "sent_at": "x"}, "id-3"))
            realtime = RealtimeClient(TOKEN, lambda: "wss://r.test", FakeConnector([FakeSocket(frames)]), allowed_hosts=["r.test"])
            ids: List[Optional[str]] = []
            async for event in realtime.events(stop=stop):
                ids.append(event.id)
                if len(ids) == 2:
                    stop.set()
            self.assertEqual(ids, ["id-1", "id-3"])

        run(scenario())

    def test_url_from_agent_connection_info_then_discovery(self) -> None:
        instance, transport, _ = client([json_response(200, {"url": "wss://agent.example"})], token=TOKEN, agent_id=AGENT, realtime_hosts=["agent.example"])
        self.assertEqual(instance._realtime_url(), "wss://agent.example")
        self.assertEqual(transport.requests[0].url, "https://api.atmark.ai/v1/agents/%s/realtime" % AGENT)
        instance, _, _ = client([json_response(403, {"error": "forbidden"}), json_response(200, {"realtime": {"url": "wss://discovery.example"}})], token=TOKEN, agent_id=AGENT, realtime_hosts=["discovery.example"])
        self.assertEqual(instance._realtime_url(), "wss://discovery.example")


class UrlCheckTest(unittest.TestCase):
    def test_api_urls_must_be_atmark_wss_hosts(self) -> None:
        check_realtime_url("wss://realtime.atmark.ai", "api")
        check_realtime_url("wss://a1b2c3.execute-api.ap-northeast-2.amazonaws.com/prod", "api")
        check_realtime_url("wss://mine.example", "api", ["mine.example"])
        for bad in ("wss://evil.example", "ws://realtime.atmark.ai", "https://realtime.atmark.ai", "wss://realtime.atmark.ai.evil.example", "wss://abc.execute-api.us-east-1.amazonaws.com", "wss://u:p@realtime.atmark.ai"):
            with self.assertRaises(ValueError, msg=bad):
                check_realtime_url(bad, "api")
        check_realtime_url("wss://anything.example", "caller")
        check_realtime_url("ws://127.0.0.1:9000", "caller")
        with self.assertRaises(ValueError):
            check_realtime_url("ws://anything.example", "caller")

    def test_stream_refuses_untrusted_api_url_without_connecting(self) -> None:
        async def scenario() -> None:
            stop = asyncio.Event()
            errors: List[BaseException] = []

            def on_error(error: BaseException) -> None:
                errors.append(error)
                stop.set()

            connector = FakeConnector([])
            async for _ in RealtimeClient(TOKEN, lambda: "wss://evil.example", connector, rand=lambda: 0.0).events(stop=stop, on_error=on_error):
                pass
            self.assertEqual(connector.calls, [])
            self.assertIn("refusing to send the token", str(errors[0]))

        run(scenario())


class ConnectionTest(unittest.TestCase):
    def test_discovery_url_header_auth_dedupe_and_unknown_filtering(self) -> None:
        async def scenario() -> None:
            stop = asyncio.Event()
            socket = FakeSocket(
                [
                    envelope("message.received", {"message_id": MESSAGE_ID, "thread_id": "t", "received_at": "x", "risk": {"level": "none"}}),
                    envelope("message.received", {"message_id": MESSAGE_ID}),  # duplicate id
                    '{"type":"pong"}',
                    envelope("agent.enrolled", {}, "e2"),
                    envelope("approval.resolved", {"approval_id": "ap", "decision": "approved", "resolved_at": "x", "message_ids": []}, "e3"),
                ]
            )
            connector = FakeConnector([socket])
            instance, transport, _ = client([json_response(200, {"realtime": {"url": "wss://realtime.atmark.ai"}})], token=TOKEN, realtime_connector=connector)
            seen: List[RealtimeEvent] = []
            async for event in instance.realtime.events(stop=stop):
                seen.append(event)
                if len(seen) == 2:
                    stop.set()
            self.assertEqual([e.type for e in seen], ["message.received", "approval.resolved"])
            self.assertEqual(transport.requests[0].url, "https://api.atmark.ai/.well-known/atmark.json")
            call = connector.calls[0]
            self.assertEqual(call["url"], "wss://realtime.atmark.ai")
            self.assertNotIn(TOKEN, call["url"])
            self.assertEqual(call["headers"], {"Authorization": "Bearer " + TOKEN})
            self.assertEqual(call["subprotocols"], ["atmark.v1"])
            self.assertTrue(socket.closed)

        run(scenario())

    def test_reconnects_after_a_drop_and_reports_reconnected(self) -> None:
        async def scenario() -> None:
            stop = asyncio.Event()
            first = FakeSocket([envelope("message.sent", {"message_id": MESSAGE_ID, "sent_at": "x"}, "a"), ConnectionError("dropped")])
            second = FakeSocket([envelope("message.sent", {"message_id": MESSAGE_ID, "sent_at": "x"}, "b")])
            connector = FakeConnector([OSError("refused"), first, second])
            opens: List[bool] = []
            errors: List[BaseException] = []
            realtime = RealtimeClient(TOKEN, lambda: "wss://r.test", connector, rand=lambda: 0.0, allowed_hosts=["r.test"])
            ids: List[Optional[str]] = []
            async for event in realtime.events(stop=stop, on_open=opens.append, on_error=errors.append):
                ids.append(event.id)
                if len(ids) == 2:
                    stop.set()
            self.assertEqual(ids, ["a", "b"])
            self.assertEqual(opens, [False, True])
            self.assertEqual([type(e).__name__ for e in errors], ["OSError", "ConnectionError"])

        run(scenario())

    def test_pings_and_rotates_before_the_age_limit(self) -> None:
        async def scenario() -> None:
            stop = asyncio.Event()
            first = FakeSocket([])
            second = FakeSocket([envelope("message.sent", {"message_id": MESSAGE_ID, "sent_at": "x"}, "z")])
            connector = FakeConnector([first, second])
            realtime = RealtimeClient(TOKEN, lambda: "wss://r.test", connector, rand=lambda: 0.0, allowed_hosts=["r.test"])
            async for event in realtime.events(stop=stop, ping_interval=0.02, max_connection_age=0.1):
                self.assertEqual(event.id, "z")
                stop.set()
            self.assertTrue(first.closed)
            self.assertIn(json.dumps({"action": "ping"}), first.sent)
            self.assertEqual(len(connector.calls), 2)

        run(scenario())

    def test_run_calls_sync_and_async_handlers_and_survives_handler_errors(self) -> None:
        async def scenario() -> None:
            stop = asyncio.Event()
            socket = FakeSocket([envelope("message.sent", {"message_id": MESSAGE_ID, "sent_at": "x"}, "1"), envelope("agent.enrolled", {}, "2"), envelope("message.sent", {"message_id": MESSAGE_ID, "sent_at": "x"}, "3")])
            realtime = RealtimeClient(TOKEN, lambda: "wss://r.test", FakeConnector([socket]), allowed_hosts=["r.test"])
            handled: List[str] = []
            unknown: List[str] = []
            errors: List[BaseException] = []

            async def on_event(event: RealtimeEvent) -> None:
                handled.append(event.id or "")
                if event.id == "1":
                    raise RuntimeError("handler bug")
                stop.set()

            await realtime.run(on_event, on_unknown_event=lambda e: unknown.append(e.type), on_error=errors.append, stop=stop)
            self.assertEqual(handled, ["1", "3"])
            self.assertEqual(unknown, ["agent.enrolled"])
            self.assertEqual([str(e) for e in errors], ["handler bug"])

        run(scenario())

    def test_refuses_token_in_url_and_requires_token(self) -> None:
        async def scenario() -> None:
            stop = asyncio.Event()
            errors: List[BaseException] = []

            def on_error(error: BaseException) -> None:
                errors.append(error)
                stop.set()

            realtime = RealtimeClient(TOKEN, lambda: "wss://r.test/?token=" + TOKEN, FakeConnector([]), rand=lambda: 0.0)
            async for _ in realtime.events(stop=stop, on_error=on_error):
                pass
            self.assertIn("token in the realtime URL", str(errors[0]))
            with self.assertRaises(ValueError):
                async for _ in RealtimeClient(None, lambda: "wss://r.test").events():
                    pass

        run(scenario())


if __name__ == "__main__":
    unittest.main()
