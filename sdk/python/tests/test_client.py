import hashlib
import socket
import unittest
import urllib.error
import urllib.parse

from _support import client, json_response

from atmark import AtmarkConnectionError, AtmarkError, HttpResponse, is_hostile, risk_level
from atmark._http import backoff_seconds, retry_after_seconds

AGENT = "a" * 32
SEND = {"from": "scout@atmark.ai", "to": ["partner@example.com"], "subject": "Hi", "text": "Hello"}


class RequestTest(unittest.TestCase):
    def test_token_json_default_agent_and_generated_idempotency_key(self) -> None:
        c, t, _ = client([json_response(200, {"status": "sent", "message_id": "m1"})], agent_id=AGENT)
        self.assertEqual(c.messages.send(SEND)["status"], "sent")
        request = t.requests[0]
        self.assertEqual(request.url, "https://api.atmark.ai/v1/messages")
        self.assertEqual(request.headers["Authorization"], "Bearer atk_agent_secret")
        self.assertEqual(request.headers["Content-Type"], "application/json")
        self.assertRegex(request.headers["Idempotency-Key"], r"^[0-9a-f-]{36}$")
        self.assertEqual(t.body(), dict(SEND, agent_id=AGENT))

    def test_explicit_agent_and_idempotency_key_win(self) -> None:
        c, t, _ = client([json_response(202, {"status": "pending_approval"})], agent_id=AGENT)
        c.messages.send(dict(SEND, agent_id="b" * 32), idempotency_key="weekly-1")
        self.assertEqual(t.body()["agent_id"], "b" * 32)
        self.assertEqual(t.requests[0].headers["Idempotency-Key"], "weekly-1")

    def test_no_agent_id_key_when_there_is_no_default(self) -> None:
        c, t, _ = client([json_response(200, {"status": "sent"})])
        c.messages.send(SEND)
        self.assertNotIn("agent_id", t.body())

    def test_get_has_no_idempotency_key_and_encodes_path(self) -> None:
        c, t, _ = client([json_response(200, {})])
        c.identity.lookup("scout+x@atmark.ai")
        self.assertEqual(t.requests[0].url, "https://api.atmark.ai/v1/identity/scout%2Bx%40atmark.ai")
        self.assertNotIn("Idempotency-Key", t.requests[0].headers)

    def test_base_url_trailing_v1_is_stripped(self) -> None:
        c, t, _ = client([json_response(200, {})], base_url="http://localhost:3000/v1/", allow_insecure=True)
        c.discovery.get()
        self.assertEqual(t.requests[0].url, "http://localhost:3000/.well-known/atmark.json")

    def test_query_booleans_and_none(self) -> None:
        c, t, _ = client([json_response(200, {"messages": [], "next_cursor": None})], agent_id=AGENT)
        c.messages.inbound.list(read=False, unlabeled=True, from_="x@example.com").first()
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(t.requests[0].url).query)
        self.assertEqual(query["read"], ["false"])
        self.assertEqual(query["unlabeled"], ["true"])
        self.assertEqual(query["from"], ["x@example.com"])
        self.assertNotIn("label", query)

    def test_draft_update_keeps_none_to_clear(self) -> None:
        c, t, _ = client([json_response(200, {"id": "d"})], agent_id=AGENT)
        c.drafts.update("d", {"html": None, "revision": 2})
        self.assertEqual(t.body(), {"html": None, "revision": 2, "agent_id": AGENT})

    def test_path_agent_id_falls_back_to_me(self) -> None:
        c, t, _ = client([json_response(200, {}), json_response(200, {})])
        c.policy.get()
        c.policy.get("b" * 32)
        self.assertEqual(urllib.parse.urlsplit(t.requests[0].url).path, "/v1/agents/me/policy")
        self.assertEqual(urllib.parse.urlsplit(t.requests[1].url).path, "/v1/agents/" + "b" * 32 + "/policy")
        d, u, _ = client([json_response(200, {})], agent_id=AGENT)
        d.policy.get()
        self.assertEqual(urllib.parse.urlsplit(u.requests[0].url).path, "/v1/agents/" + AGENT + "/policy")

    def test_explicit_empty_agent_id_is_an_error(self) -> None:
        with self.assertRaises(ValueError):
            client([], agent_id="")
        c, t, _ = client([])
        with self.assertRaises(ValueError):
            c.policy.get("")
        self.assertEqual(t.requests, [])

    def test_no_agent_id_query_when_there_is_no_default(self) -> None:
        c, t, _ = client([json_response(200, {"messages": [], "next_cursor": None})])
        c.messages.inbound.list().first()
        self.assertNotIn("agent_id", urllib.parse.parse_qs(urllib.parse.urlsplit(t.requests[0].url).query))


class TransportSecurityTest(unittest.TestCase):
    def test_base_url_must_be_https(self) -> None:
        from atmark import Atmark

        for bad in ("http://api.atmark.ai", "http://localhost:3000", "ftp://api.atmark.ai", "https://user:pw@api.atmark.ai", "https://api.atmark.ai/?x=1", "not a url"):
            with self.assertRaises(ValueError, msg=bad):
                Atmark(base_url=bad)
        with self.assertRaises(ValueError):
            Atmark(base_url="http://evil.example", allow_insecure=True)
        Atmark(base_url="http://127.0.0.1:8080", allow_insecure=True)

    def test_3xx_is_an_error_and_not_retried(self) -> None:
        c, t, _ = client([HttpResponse(302, {"Location": "https://evil.example/"}, b""), json_response(200, {})])
        with self.assertRaises(AtmarkError) as caught:
            c.threads.get("t")
        self.assertEqual((caught.exception.status, caught.exception.code), (302, "unexpected_redirect"))
        self.assertEqual(len(t.requests), 1)

    def test_default_transport_does_not_follow_redirects_or_leak_the_token(self) -> None:
        import http.server
        import socketserver
        import threading

        from atmark._http import HttpRequest, urllib_transport

        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                seen.append((self.path, self.headers.get("Authorization")))
                if self.path == "/start":
                    self.send_response(302)
                    self.send_header("Location", "http://localhost:%d/elsewhere" % self.server.server_address[1])
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"{}")

            def log_message(self, *args: object) -> None:
                pass

        # TCPServer, not HTTPServer: HTTPServer.server_bind does a reverse DNS lookup (getfqdn) that can take 30 s.
        server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            response = urllib_transport(HttpRequest("GET", "http://127.0.0.1:%d/start" % server.server_address[1], {"Authorization": "Bearer atk_agent_x"}, None, 5))
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(response.status, 302)
        self.assertEqual(seen, [("/start", "Bearer atk_agent_x")])


class ErrorTest(unittest.TestCase):
    def test_error_fields(self) -> None:
        c, _, _ = client([json_response(403, {"error": "policy_denied", "decision": {"reasons": ["recipient_not_allowlisted"]}}, {"apigw-requestid": "req-1"})])
        with self.assertRaises(AtmarkError) as caught:
            c.messages.send(SEND)
        e = caught.exception
        self.assertEqual((e.status, e.code, e.request_id), (403, "policy_denied", "req-1"))
        self.assertEqual(e.body["decision"]["reasons"], ["recipient_not_allowlisted"])
        self.assertIsNotNone(e.idempotency_key)

    def test_request_id_from_detail_and_non_json_body(self) -> None:
        c, _, _ = client([json_response(500, {"error": "internal_error", "detail": "x. Request id: abc-1="})], max_retries=0)
        with self.assertRaises(AtmarkError) as caught:
            c.threads.get("t")
        self.assertEqual(caught.exception.request_id, "abc-1=")
        c, _, _ = client([HttpResponse(400, {}, b"Bad")])
        with self.assertRaises(AtmarkError) as caught:
            c.threads.get("t")
        self.assertEqual((caught.exception.code, caught.exception.detail), ("unknown_error", "Bad"))


class RetryTest(unittest.TestCase):
    def test_send_retried_with_same_key_on_503_and_network_error(self) -> None:
        c, t, sleeps = client([json_response(503, {"error": "service_unavailable"}), urllib.error.URLError("refused"), json_response(200, {"status": "sent"})])
        self.assertEqual(c.messages.send(SEND)["status"], "sent")
        self.assertEqual(len(t.requests), 3)
        self.assertEqual(len({r.headers["Idempotency-Key"] for r in t.requests}), 1)
        self.assertEqual(len(sleeps), 2)

    def test_post_without_key_is_not_retried(self) -> None:
        c, t, _ = client([json_response(503, {}), json_response(201, {})])
        with self.assertRaises(AtmarkError):
            c.drafts.create({"subject": "s"})
        self.assertEqual(len(t.requests), 1)

    def test_patch_network_error_not_retried(self) -> None:
        c, t, _ = client([ConnectionResetError("reset")])
        with self.assertRaises(AtmarkConnectionError) as caught:
            c.drafts.update("d", {"subject": "x"})
        self.assertEqual(caught.exception.code, "network_error")
        self.assertEqual(len(t.requests), 1)

    def test_retry_after_is_honored(self) -> None:
        c, _, sleeps = client([json_response(429, {"message": "Too Many Requests"}, {"Retry-After": "3"}), json_response(200, {})])
        c.threads.get("t")
        self.assertEqual(sleeps, [3.0])

    def test_send_failed_502_is_not_retried(self) -> None:
        c, t, _ = client([json_response(502, {"error": "send_failed"}), json_response(200, {})])
        with self.assertRaises(AtmarkError) as caught:
            c.messages.send(SEND)
        self.assertEqual(caught.exception.code, "send_failed")
        self.assertEqual(len(t.requests), 1)

    def test_409_policy_changing_retried_but_key_reused_not(self) -> None:
        c, _, _ = client([json_response(409, {"error": "policy_changing"}), json_response(200, {"status": "sent"})])
        self.assertEqual(c.messages.send(SEND)["status"], "sent")
        c, t, _ = client([json_response(409, {"error": "idempotency_key_reused"})])
        with self.assertRaises(AtmarkError):
            c.messages.send(SEND)
        self.assertEqual(len(t.requests), 1)

    def test_4xx_never_retried(self) -> None:
        for status in (400, 401, 403, 404, 422):
            c, t, _ = client([json_response(status, {"error": "x"}), json_response(200, {})])
            with self.assertRaises(AtmarkError):
                c.threads.get("t")
            self.assertEqual(len(t.requests), 1, status)

    def test_max_retries_then_last_error(self) -> None:
        c, t, _ = client([json_response(500, {})] * 3 + [json_response(200, {})], max_retries=2)
        with self.assertRaises(AtmarkError):
            c.threads.get("t")
        self.assertEqual(len(t.requests), 3)

    def test_timeout_is_a_connection_error(self) -> None:
        c, _, _ = client([socket.timeout("timed out")], max_retries=0)
        with self.assertRaises(AtmarkConnectionError) as caught:
            c.threads.get("t")
        self.assertEqual(caught.exception.code, "timeout")
        c, _, _ = client([urllib.error.URLError(socket.timeout("timed out"))], max_retries=0)
        with self.assertRaises(AtmarkConnectionError) as caught:
            c.threads.get("t")
        self.assertEqual(caught.exception.code, "timeout")

    def test_backoff_and_retry_after_parsing(self) -> None:
        self.assertLess(backoff_seconds(0, lambda: 0.999), 0.5)
        self.assertLess(backoff_seconds(20, lambda: 0.999), 20.0)
        self.assertEqual(retry_after_seconds("3600"), 60.0)
        self.assertEqual(retry_after_seconds("Wed, 08 Oct 2026 09:00:10 GMT", now=1791450000.0), 10.0)
        self.assertIsNone(retry_after_seconds("soon"))


class EnrollTest(unittest.TestCase):
    def test_create_posts_without_key_and_returns_token(self) -> None:
        c, t, _ = client([json_response(201, {"agent": {"agent_id": "b" * 32}, "token": "atk_agent_new", "defaults": {"send_approval": "always"}})])
        enrolled = c.agents.create_agent("Helper", local_part="helper", idempotency_key="ignored")
        self.assertEqual(enrolled["token"], "atk_agent_new")
        self.assertEqual(t.requests[0].url, "https://api.atmark.ai/v1/agents")
        self.assertEqual(t.body(), {"name": "Helper", "local_part": "helper"})
        self.assertNotIn("Idempotency-Key", t.requests[0].headers)

    def test_enroll_refusals_are_never_retried(self) -> None:
        for status, code in ((503, "enroll_busy"), (503, "enroll_timeout"), (429, "enroll_daily_cap"), (503, "enroll_unavailable"), (403, "self_enroll_disabled")):
            c, t, _ = client([json_response(status, {"error": code}), json_response(201, {})])
            with self.assertRaises(AtmarkError) as caught:
                c.agents.create("Helper", idempotency_key="k")
            self.assertEqual(caught.exception.code, code)
            self.assertEqual(len(t.requests), 1, code)
        c, t, _ = client([ConnectionResetError("reset"), json_response(201, {})])
        with self.assertRaises(AtmarkConnectionError):
            c.agents.create("Helper")
        self.assertEqual(len(t.requests), 1)


class PaginationTest(unittest.TestCase):
    def test_iterates_across_pages(self) -> None:
        c, t, _ = client(
            [json_response(200, {"messages": [{"id": "1"}, {"id": "2"}], "next_cursor": "c1"}), json_response(200, {"messages": [{"id": "3"}], "next_cursor": None})],
            agent_id=AGENT,
        )
        self.assertEqual([m["id"] for m in c.messages.inbound.list(limit=2)], ["1", "2", "3"])
        second = urllib.parse.parse_qs(urllib.parse.urlsplit(t.requests[1].url).query)
        self.assertEqual((second["cursor"], second["limit"]), (["c1"], ["2"]))

    def test_deliveries_and_schedules(self) -> None:
        c, _, _ = client([json_response(200, {"deliveries": [{"id": "x"}], "next_cursor": None}), json_response(200, {"schedules": [{"id": "s"}], "next_cursor": None})], agent_id=AGENT)
        self.assertEqual(list(c.webhooks.deliveries.list(status="dead")), [{"id": "x"}])
        self.assertEqual(list(c.messages.scheduled.list()), [{"id": "s"}])


class AttachmentTest(unittest.TestCase):
    def test_upload_hashes_and_puts_without_authorization(self) -> None:
        c, t, _ = client([json_response(201, {"attachment_id": "att", "upload": {"method": "PUT", "url": "https://s3.example/put", "headers": {"content-type": "text/plain"}}}), HttpResponse(200, {}, b"")])
        result = c.attachments.upload("h.txt", "text/plain", b"hello", agent_id=AGENT)
        self.assertEqual(result["attachment_id"], "att")
        self.assertEqual(t.body()["sha256"], hashlib.sha256(b"hello").hexdigest())
        self.assertEqual(t.body()["bytes"], 5)
        put = t.requests[1]
        self.assertEqual((put.method, put.url, put.body), ("PUT", "https://s3.example/put", b"hello"))
        self.assertNotIn("Authorization", put.headers)

    def test_failed_put(self) -> None:
        c, _, _ = client([json_response(201, {"attachment_id": "att", "upload": {"url": "https://s3.example/put"}}), HttpResponse(403, {}, b"")])
        with self.assertRaises(AtmarkError) as caught:
            c.attachments.upload("h.txt", "text/plain", b"x")
        self.assertEqual(caught.exception.code, "attachment_upload_failed")


class RiskTest(unittest.TestCase):
    def test_only_none_is_safe(self) -> None:
        self.assertFalse(is_hostile({"risk": {"level": "none"}}))
        for message in ({"risk": {"level": "risk"}}, {"risk": {"level": "block"}}, {"risk": {"level": "?"}}, {}, None, {"risk": "none"}):
            self.assertTrue(is_hostile(message), message)
        self.assertEqual(risk_level({"risk": {"level": "risk"}}), "risk")


if __name__ == "__main__":
    unittest.main()
