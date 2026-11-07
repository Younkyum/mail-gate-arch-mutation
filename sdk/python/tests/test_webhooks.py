"""Shared vectors generated from the server's signing code (``src/webhooks/signing.ts``) by the TypeScript test."""

import json
import unittest

from _support import FIXTURES

from atmark import MemorySeenIds, verify_webhook_signature


class WebhookVectorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.vectors = json.loads((FIXTURES / "webhook-vectors.json").read_text("utf-8"))["vectors"]

    def test_vectors_cover_every_outcome(self) -> None:
        self.assertEqual({v["expected"] for v in self.vectors}, {"valid", "malformed", "timestamp_out_of_tolerance", "no_matching_signature"})

    def test_matches_the_server_reference(self) -> None:
        for vector in self.vectors:
            with self.subTest(vector["name"]):
                result = verify_webhook_signature(vector["body"], vector["headers"], vector["secret"], now=vector["now_unix"])
                self.assertEqual("valid" if result.valid else result.reason, vector["expected"])

    def test_bytes_body_and_mixed_case_headers(self) -> None:
        vector = next(v for v in self.vectors if v["name"] == "unicode body")
        headers = {"Webhook-Id": vector["headers"]["webhook-id"], "WEBHOOK-TIMESTAMP": vector["headers"]["webhook-timestamp"], "Webhook-Signature": vector["headers"]["webhook-signature"]}
        self.assertTrue(verify_webhook_signature(vector["body"].encode("utf-8"), headers, vector["secret"], now=vector["now_unix"]))

    def test_seen_ids_marks_duplicates_only_after_a_valid_signature(self) -> None:
        vector = next(v for v in self.vectors if v["name"] == "valid")
        seen = MemorySeenIds()
        first = verify_webhook_signature(vector["body"], vector["headers"], vector["secret"], now=vector["now_unix"], seen_ids=seen)
        self.assertEqual((first.valid, first.id), (True, vector["headers"]["webhook-id"]))
        again = verify_webhook_signature(vector["body"], vector["headers"], vector["secret"], now=vector["now_unix"], seen_ids=seen)
        self.assertEqual((again.valid, again.reason), (False, "duplicate"))
        calls = []
        tampered = verify_webhook_signature(vector["body"] + " ", vector["headers"], vector["secret"], now=vector["now_unix"], seen_ids=lambda i: calls.append(i) or False)
        self.assertEqual((tampered.reason, calls), ("no_matching_signature", []))
        small = MemorySeenIds(max_ids=1)
        self.assertEqual([small("a"), small("a"), small("b"), small("a")], [False, True, False, False])

    def test_missing_headers_and_bad_secret(self) -> None:
        self.assertEqual(verify_webhook_signature("{}", {}, "whsec_AAAA").reason, "malformed")
        with self.assertRaises(ValueError):
            verify_webhook_signature("{}", {}, "nope")

    def test_non_ascii_digits_are_malformed(self) -> None:
        vector = self.vectors[0]
        headers = dict(vector["headers"], **{"webhook-timestamp": "١٢٣"})
        self.assertEqual(verify_webhook_signature(vector["body"], headers, vector["secret"], now=vector["now_unix"]).reason, "malformed")


if __name__ == "__main__":
    unittest.main()
