"""Checks that release receipts require proof of the actual public artifacts."""

import importlib.util
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


path = Path(__file__).with_name("verify-release.py")
spec = importlib.util.spec_from_file_location("verify_release", path)
verify_release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_release)

OLD = "a" * 40
NEW = "b" * 40
INDEX = b'<html><script type="module" src="/assets/index-Abc123.js"></script></html>\n'
ASSET = b"console.log('new release');\n"


class ReleaseReceiptTests(unittest.TestCase):
    def test_public_request_uses_curl_and_identifies_release_verifier(self):
        with patch.object(verify_release, "run", return_value=b"ok") as fetch:
            self.assertEqual(verify_release.public("https://example.test", "/api/health"), b"ok")
        args = fetch.call_args.args
        self.assertEqual(args[0], "curl")
        self.assertIn("--fail", args)
        self.assertIn("HitGO-release-verifier/1.0", args)
        self.assertEqual(args[-1], "https://example.test/api/health")

    def args(self):
        return SimpleNamespace(
            origin="https://example.test", ssh_target="deploy@example.test",
            app_dir="/srv/example/app", ssh_opts="-o BatchMode=yes",
            before=OLD[:7], commit=NEW, version="v1.2.3",
        )

    def test_verified_public_api_and_frontend_produce_matchable_receipt(self):
        def remote(_target, _directory, _options, command):
            if command == "cat VERSION":
                return (NEW + "\n").encode()
            if command.endswith("index.html"):
                return INDEX
            return ASSET

        def public(_origin, route):
            if route == "/api/health":
                return json.dumps({"status": "ok", "commit": NEW, "version": "v1.2.3"}).encode()
            return INDEX if route == "/" else ASSET

        with patch.object(verify_release, "remote", side_effect=remote), \
             patch.object(verify_release, "public", side_effect=public), \
             patch.object(verify_release, "resolve_commit", return_value=OLD), \
             patch.object(verify_release, "run", return_value=(OLD + "\n").encode()):
            receipt = verify_release.verify(self.args())
        self.assertTrue(receipt["verified"])
        self.assertTrue(receipt["eligibleForMatching"])
        self.assertEqual(receipt["sourceCommit"], NEW)
        self.assertEqual(receipt["evidence"]["assetSha256"], verify_release.sha256(ASSET))

    def test_stale_public_frontend_rejects_receipt(self):
        with patch.object(verify_release, "remote", side_effect=[NEW.encode(), INDEX]), \
             patch.object(verify_release, "public", side_effect=[
                 json.dumps({"status": "ok", "commit": NEW, "version": "v1.2.3"}).encode(),
                 b"old public page",
             ]):
            with self.assertRaisesRegex(ValueError, "index.html differs"):
                verify_release.verify(self.args())

    def test_unknown_previous_source_cannot_match_items(self):
        with patch.object(verify_release, "remote", side_effect=[NEW.encode(), INDEX, ASSET]), \
             patch.object(verify_release, "public", side_effect=[
                 json.dumps({"status": "ok", "commit": NEW, "version": "v1.2.3"}).encode(),
                 INDEX, ASSET,
             ]), patch.object(verify_release, "resolve_commit", return_value=None):
            receipt = verify_release.verify(self.args())
        self.assertTrue(receipt["verified"])
        self.assertFalse(receipt["eligibleForMatching"])


if __name__ == "__main__":
    unittest.main()
