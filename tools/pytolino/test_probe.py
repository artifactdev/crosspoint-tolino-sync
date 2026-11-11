import contextlib
import io
import json
import unittest
from unittest.mock import Mock

import requests

from probe import library_count, load_library, new_client


class ProbeTests(unittest.TestCase):
    def test_imports_token_then_loads_inventory_without_gui_or_password(self):
        client = Mock()
        client.access_token = "synthetic-access"
        client.get_inventory.return_value = [{"title": "Synthetic book"}]
        self.assertEqual(load_library(client, "synthetic-refresh", "synthetic-hardware"), 1)
        client.import_token.assert_called_once_with("synthetic-refresh", "synthetic-hardware")
        client.get_inventory.assert_called_once_with()
        client.login.assert_not_called()
        client.register.assert_not_called()
        client.upload.assert_not_called()
        client.delete_ebook.assert_not_called()

    def test_rejects_invalid_fields_without_remote_requests(self):
        for token in ("", "token with spaces", "token\n", None):
            client = Mock()
            with self.assertRaises(ValueError):
                load_library(client, token, "synthetic-hardware")
            client.import_token.assert_not_called()

    def test_library_count_requires_actual_expected_shape(self):
        self.assertEqual(library_count([]), 0)
        for value in (None, {}, {"error": "failed"}, "books"):
            with self.assertRaises(ValueError):
                library_count(value)

    def test_upstream_failures_are_not_success_shaped(self):
        client = Mock()
        client.import_token.side_effect = RuntimeError("synthetic token rejection")
        with self.assertRaises(RuntimeError):
            load_library(client, "synthetic-refresh", "synthetic-hardware")
        client.get_inventory.assert_not_called()

    def test_swallowed_upstream_refresh_failure_is_explicit(self):
        client = Mock()
        client.access_token = None
        with self.assertRaises(RuntimeError):
            load_library(client, "synthetic-refresh", "synthetic-hardware")
        client.get_inventory.assert_not_called()

    def test_installed_package_supports_thalia_without_network(self):
        client = new_client()
        self.assertEqual(client._partner_id, "2")
        self.assertEqual(client._token_url, "https://www.thalia.de/auth/oauth2/token")
        self.assertEqual(client._inventory_url, "https://bosh.pageplace.de/bosh/rest/inventory/delta")

    def test_installed_package_refreshes_and_combines_purchases_and_uploads(self):
        client = new_client()
        token_response = self.response({
            "access_token": "synthetic-access",
            "refresh_token": "synthetic-rotated",
            "expires_in": 600,
            "refresh_expires_in": 3600,
        })
        client._session_cffi = Mock()
        client._session_cffi.post.return_value = token_response
        client._session = Mock()
        client._session.get.return_value = self.response({
            "PublicationInventory": {
                "ebook": [{"epubMetaData": {"title": "Synthetic purchase"}}],
                "edata": [{"epubMetaData": {"title": "Synthetic upload"}}],
            },
        })
        self.assertEqual(load_library(client, "synthetic-refresh", "synthetic-hardware"), 2)
        token_call = client._session_cffi.post.call_args
        self.assertEqual(token_call.args[0], "https://www.thalia.de/auth/oauth2/token")
        self.assertEqual(token_call.kwargs["data"]["refresh_token"], "synthetic-refresh")
        self.assertTrue(token_call.kwargs["verify"])
        inventory_call = client._session.get.call_args
        self.assertEqual(inventory_call.args[0], "https://bosh.pageplace.de/bosh/rest/inventory/delta")
        self.assertEqual(inventory_call.kwargs["headers"], {
            "t_auth_token": "synthetic-access",
            "hardware_id": "synthetic-hardware",
            "reseller_id": "2",
        })
        self.assertEqual(client.refresh_token, "synthetic-rotated")

    def test_installed_package_refresh_rejection_is_detected(self):
        client = new_client()
        client._access_token = None
        client._session_cffi = Mock()
        client._session_cffi.post.return_value = self.response({"error": "invalid_grant"}, status=400)
        client._session = Mock()
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(RuntimeError):
                load_library(client, "synthetic-refresh", "synthetic-hardware")
        client._session.get.assert_not_called()

    @staticmethod
    def response(data, status=200):
        response = requests.Response()
        response.status_code = status
        response.url = "https://example.invalid/synthetic"
        response.request = requests.Request("GET", response.url).prepare()
        response._content = json.dumps(data).encode()
        return response


if __name__ == "__main__":
    unittest.main()
