"""Every operation in the OpenAPI snapshot (``sdk/fixtures/openapi.json``, kept current by the TypeScript contract test)
has a Python method calling it with the right HTTP method, path and Idempotency-Key handling."""

import json
import re
import unittest
import urllib.parse
from typing import Any, Callable, Dict

from _support import FIXTURES, client, json_response

from atmark import OPERATIONS, Atmark

AGENT = "a" * 32

CALLS: Dict[str, Callable[[Atmark], Any]] = {
    "sendMessage": lambda c: c.messages.send({"from": "a@atmark.ai", "to": ["b@example.com"], "subject": "s", "text": "t"}),
    "replyToThread": lambda c: c.messages.reply("th1", {"in_reply_to": "m1", "text": "t"}),
    "forwardMessage": lambda c: c.messages.forward("m1", {"from": "a@atmark.ai", "to": ["b@example.com"]}),
    "sendTransitionAnnouncement": lambda c: c.agents.send_transition_announcement({}),
    "scheduleMessage": lambda c: c.messages.scheduled.create({"from": "a@atmark.ai", "to": ["b@example.com"], "subject": "s", "text": "t", "send_at": "2026-10-09T00:00:00Z"}),
    "listScheduledMessages": lambda c: c.messages.scheduled.list().first(),
    "getScheduledMessage": lambda c: c.messages.scheduled.get("s1"),
    "cancelScheduledMessage": lambda c: c.messages.scheduled.cancel("s1", "duplicate"),
    "createDraft": lambda c: c.drafts.create({"subject": "s"}),
    "listDrafts": lambda c: c.drafts.list().first(),
    "getDraft": lambda c: c.drafts.get("d1"),
    "updateDraft": lambda c: c.drafts.update("d1", {"subject": "s2", "revision": 1}),
    "discardDraft": lambda c: c.drafts.discard("d1"),
    "sendDraft": lambda c: c.drafts.send("d1"),
    "listInboundMessages": lambda c: c.messages.inbound.list().first(),
    "getInboundMessage": lambda c: c.messages.inbound.get("m1"),
    "getInboundAttachmentUrl": lambda c: c.messages.inbound.attachment_url("m1", 0),
    "getInboundAttachmentContent": lambda c: c.messages.inbound.attachment_content("m1", 0),
    "getThread": lambda c: c.threads.get("th1"),
    "getVerificationCode": lambda c: c.messages.verification_code(sender_domain="example.com"),
    "setMessageLabels": lambda c: c.labels.set("m1", {"add": ["x"]}),
    "listLabels": lambda c: c.labels.list(),
    "createAttachmentUpload": lambda c: c.attachments.create_upload({"filename": "a.txt", "mime_type": "text/plain", "bytes": 1, "sha256": "0" * 64}),
    "getApproval": lambda c: c.approvals.get("ap1"),
    "getAgentPolicy": lambda c: c.policy.get(),
    "requestPolicyChange": lambda c: c.policy.request_change({"action": "add_rule", "direction": "outbound", "list": "allow", "value": "b@example.com", "reason": "owner asked"}),
    "getPolicyChangeRequest": lambda c: c.policy.get_request("pr1"),
    "queryAudit": lambda c: c.audit.query(message_id="m1"),
    "registerWebhookEndpoint": lambda c: c.webhooks.endpoints.create({"url": "https://example.com/h"}),
    "listWebhookEndpoints": lambda c: c.webhooks.endpoints.list(),
    "deleteWebhookEndpoint": lambda c: c.webhooks.endpoints.delete("e1"),
    "rotateWebhookSecret": lambda c: c.webhooks.endpoints.rotate_secret("e1"),
    "listWebhookDeliveries": lambda c: c.webhooks.deliveries.list().first(),
    "redeliverWebhookDelivery": lambda c: c.webhooks.deliveries.redeliver("dl1"),
    "enrollAgent": lambda c: c.agents.create("Helper"),
    "getIdentity": lambda c: c.identity.lookup("a@atmark.ai"),
    "getCapabilities": lambda c: c.capabilities.get(),
    "getRealtimeConnection": lambda c: c.agents.realtime(),
    "getOpenApi": lambda c: c.discovery.openapi(),
    "getDiscovery": lambda c: c.discovery.get(),
}


def spec_operations() -> Dict[str, Dict[str, Any]]:
    document = json.loads((FIXTURES / "openapi.json").read_text("utf-8"))
    operations: Dict[str, Dict[str, Any]] = {}
    for path, item in document["paths"].items():
        for method, operation in item.items():
            header = [p for p in operation.get("parameters", []) if p.get("in") == "header" and p.get("name") == "Idempotency-Key"]
            idempotency = None if not header else ("required" if header[0].get("required") else "optional")
            required_query = [p["name"] for p in operation.get("parameters", []) if p.get("in") == "query" and p.get("required")]
            operations[operation["operationId"]] = {"method": method.upper(), "path": path, "idempotency": idempotency, "required_query": required_query}
    return operations


class ContractTest(unittest.TestCase):
    def test_operation_table_matches_the_openapi_snapshot(self) -> None:
        spec = spec_operations()
        self.assertEqual(sorted(set(spec) - set(OPERATIONS)), [], "operations missing in the Python SDK")
        self.assertEqual(sorted(set(OPERATIONS) - set(spec)), [], "operations unknown to the server")
        for operation_id, expected in spec.items():
            ours = OPERATIONS[operation_id]
            self.assertEqual((ours.method, ours.path, ours.idempotency_key), (expected["method"], expected["path"], expected["idempotency"]), operation_id)

    def test_every_operation_has_a_method_that_calls_it(self) -> None:
        spec = spec_operations()
        self.assertEqual(sorted(CALLS), sorted(spec))
        for operation_id, expected in spec.items():
            instance, transport, _ = client([json_response(200, {"next_cursor": None})], agent_id=AGENT, max_retries=0)
            CALLS[operation_id](instance)
            self.assertEqual(len(transport.requests), 1, operation_id)
            request = transport.requests[0]
            url = urllib.parse.urlsplit(request.url)
            self.assertEqual(request.method, expected["method"], operation_id)
            self.assertEqual("%s://%s" % (url.scheme, url.netloc), "https://api.atmark.ai")
            pattern = "^" + re.sub(r"\\\{[A-Za-z]+\\\}", "[^/]+", re.escape(expected["path"])) + "$"
            self.assertRegex(url.path, pattern, operation_id)
            self.assertEqual("Idempotency-Key" in request.headers, expected["idempotency"] is not None, operation_id)
            query = urllib.parse.parse_qs(url.query)
            for name in expected["required_query"]:
                self.assertIn(name, query, "%s ?%s" % (operation_id, name))


if __name__ == "__main__":
    unittest.main()
