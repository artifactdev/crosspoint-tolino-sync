import http.client
import io
import json
import threading
import time
import unittest
import zipfile
from unittest.mock import Mock, patch

from companion import APIError, Companion, create_api_server, epub_filename, native_id, public_https, reading_positions, safe_metadata


BOOK = {"publicationId": "publication-test", "epubMetaData": {
    "identifier": "synthetic-book", "title": "Synthetic book", "publisher": "Fixture Press",
    "author": [{"name": "Fixture Author"}], "deliverable": [{"contentFormat": "application/epub+zip"}],
}}
INVENTORY = {"PublicationInventory": {"ebook": [BOOK], "edata": []}}


def fixture():
    state = Mock()
    state.lock = threading.Lock()
    state.inventory = [BOOK]
    state.snapshot.return_value = {"busy": False, "connected": True}
    state.client._get_auth_headers.return_value = {
        "t_auth_token": "synthetic-access", "hardware_id": "synthetic-hardware", "reseller_id": "3",
    }
    state.client.access_expiration_time = time.time() + 3600
    return Companion(state, "synthetic-helper-key-01234567890123456789")


class CompanionTests(unittest.TestCase):
    def test_title_filenames_preserve_unicode_and_fit_native_utf8_limit(self):
        for title, expected in (("Das Netz", "Das Netz.epub"), ("Über Grenzen", "Über Grenzen.epub"),
                                (' ../A:B/"C"?*<>|. ', "__A_B__C______.epub"),
                                ("...", "_.epub")):
            with self.subTest(title=title):
                self.assertEqual(epub_filename(title), expected)
        name = epub_filename("😀" * 100)
        self.assertEqual(name, "😀" * 23 + ".epub")
        self.assertLessEqual(len(name.encode()), 100)
        helper = fixture()
        self.assertIn("filename*=UTF-8''Synthetic%20book.epub", helper.download_disposition("synthetic-book"))

    def test_inventory_preserves_metadata_but_excludes_credentials(self):
        helper = fixture()
        with patch.object(helper, "remote", return_value=INVENTORY):
            self.assertEqual(helper.inventory(), INVENTORY)
        self.assertEqual(safe_metadata({"title": "Book", "access_token": "secret", "nested": {
            "Authorization": "secret", "publisher": "Press"}}),
            {"title": "Book", "nested": {"publisher": "Press"}})

    def test_disconnected_or_busy_is_explicit(self):
        helper = fixture()
        for value in ({"busy": True, "connected": True}, {"busy": False, "connected": False}):
            helper.state.snapshot.return_value = value
            with self.assertRaises(APIError):
                helper.inventory()

    def test_native_catalog_contains_all_books_progress_and_safe_sidecars(self):
        helper = fixture()
        identifier = 'book/"quoted"\nidentifier'
        supported = {**BOOK, "epubMetaData": {**BOOK["epubMetaData"], "identifier": identifier}}
        protected = {**BOOK, "epubMetaData": {**BOOK["epubMetaData"], "identifier": "drm",
                                           "protectionType": "ACS4"}}
        inventory = {"PublicationInventory": {"ebook": [supported, protected], "edata": [supported]}}
        with patch.object(helper, "inventory", return_value=inventory), \
                patch.object(helper, "reading_progress", return_value={
                    "positions": {"publication-test": {"progress": 0}}}):
            books = helper.catalog()["books"]
            supported_books = helper.catalog(supported_only=True)["books"]
        self.assertEqual(len(books), 2)
        self.assertEqual(len(supported_books), 1)
        self.assertEqual(supported_books[0]["id"], native_id(identifier))
        book = next(book for book in books if book["id"] == native_id(identifier))
        self.assertEqual(len(book["id"]), 64)
        self.assertEqual(json.loads(book["sidecar"]), {
            "tolino_identifier": identifier, "tolino_publication_id": "publication-test", "tolino_id": identifier})
        self.assertIn("0%", book["description"])
        self.assertEqual(book["author"], "Fixture Author")
        self.assertEqual(book["filename"], "Synthetic book.epub")
        drm = next(book for book in books if book["id"] == native_id("drm"))
        self.assertIn("[DRM / unsupported]", drm["title"])
        self.assertIn("Download blocked", drm["description"])
        with patch.object(helper, "inventory", return_value=INVENTORY), \
                patch.object(helper, "reading_progress", return_value={"positions": {}}):
            self.assertIn("No cloud reading position", helper.catalog()["books"][0]["description"])

    def test_native_catalog_rejects_bad_metadata_and_propagates_provider_errors(self):
        helper = fixture()
        for meta in (None, {}, {**BOOK["epubMetaData"], "author": ["not-an-author"]},
                     {**BOOK["epubMetaData"], "identifier": "x" * 2048}):
            with self.subTest(meta=meta), patch.object(helper, "inventory", return_value={
                    "PublicationInventory": {"ebook": [{"epubMetaData": meta}], "edata": []}}), \
                    patch.object(helper, "reading_progress", return_value={"positions": {}}), \
                    self.assertRaises(APIError):
                helper.catalog()
        with patch.object(helper, "inventory", side_effect=APIError(502, "Provider unavailable")), \
                self.assertRaises(APIError):
            helper.catalog()

    def test_native_download_ids_only_resolve_current_library_books(self):
        helper = fixture()
        self.assertEqual(helper.native_identifier(native_id("synthetic-book")), "synthetic-book")
        for value, status in (("../anything", 400), ("a" * 64, 404)):
            with self.subTest(value=value), self.assertRaises(APIError) as error:
                helper.native_identifier(value)
            self.assertEqual(error.exception.status, status)

    def test_connector_position_read_is_exact_and_missing_is_not_zero(self):
        helper = fixture()
        value = {"progress": 0.35, "modified": 1000, "position": "Text/ch1.xhtml#point(/1/4/2:0)"}
        with patch.object(helper, "reading", return_value={"revision": "r1", "patches": [
                {"op": "add", "path": "/publications/publication-test/bookmark/123", "value": value}]}):
            self.assertEqual(helper.sync_position("synthetic-book"), {
                "publicationId": "publication-test", "revision": "r1", "position": value})
        with patch.object(helper, "reading", return_value={"revision": "r2", "patches": []}):
            self.assertIsNone(helper.sync_position("synthetic-book")["position"])

    def test_connector_cloud_write_requires_opt_in_and_exact_bounded_input(self):
        helper = fixture()
        body = {"id": "synthetic-book", "revision": "r1", "expectedModified": 1000,
                "position": "Text/ch1.xhtml#point(/1/4/2/1:8)", "progress": 0.42, "modified": 2000}
        with self.assertRaises(APIError) as error:
            helper.write_sync_position(body)
        self.assertEqual(error.exception.status, 403)
        helper.sync_writes = True
        for update in ({"progress": True}, {"modified": float("inf")}, {"expectedModified": "1000"},
                       {"position": "35%"}, {"position": "../chapter#point(/1/4:0)"},
                       {"modified": time.time() * 1000 + 120000}, {"patches": []}):
            with self.subTest(update=update), patch.object(helper, "remote") as remote, self.assertRaises(APIError):
                helper.write_sync_position({**body, **update})
            remote.assert_not_called()

    def test_connector_writes_use_fresh_revision_preserve_slot_and_confirm_saved_position(self):
        helper = fixture()
        helper.sync_writes = True
        old = {"revision": "book-r1", "modified": 1000, "position": "chapter.xhtml#point(/1/4/2:0)",
               "progress": 0.1, "currentPosition": "10", "lastPosition": "100"}
        cloud = {"revision": "r1", "patches": [{
            "op": "add", "path": "/publications/publication-test/bookmark/123", "value": old}]}
        body = {"id": "synthetic-book", "revision": "r1", "expectedModified": 1000,
                "position": "chapter.xhtml#point(/1/4/2/1:8)", "progress": 0.42, "modified": 2000}
        new = {key: body[key] for key in ("position", "progress", "modified")}
        verified = {"revision": "r3", "patches": [{
            "op": "replace", "path": "/publications/publication-test/bookmark/123", "value": new}]}
        with patch.object(helper, "remote", side_effect=[cloud, {"revision": "r2"}, verified]) as remote:
            self.assertEqual(helper.write_sync_position(body),
                             {"synced": True, "unchanged": False, "revision": "r3"})
        self.assertEqual(helper.reading_version, 1)
        patch_body = remote.call_args_list[1].args[3]
        self.assertEqual(patch_body, {"revision": "r1", "patches": [{
            "op": "replace", "path": "/publications/publication-test/bookmark/123",
            "value": {"revision": "book-r1", **new}}]})
        for change in ({"revision": "different"}, {"expectedModified": 999}, {"modified": 500}):
            with self.subTest(change=change), patch.object(helper, "remote", return_value=cloud) as remote, \
                    self.assertRaises(APIError) as error:
                helper.write_sync_position({**body, **change})
            self.assertEqual(error.exception.status, 409)
            self.assertEqual(remote.call_count, 1)
            self.assertEqual(helper.reading_version, 1)
        with patch.object(helper, "remote", return_value=cloud) as remote:
            result = helper.write_sync_position({**body, "position": old["position"], "progress": old["progress"]})
            self.assertTrue(result["unchanged"])
            self.assertEqual(remote.call_count, 1)
        self.assertEqual(helper.reading_version, 2)
        with patch.object(helper, "remote", side_effect=[cloud, {"revision": "r2"}, cloud]), self.assertRaises(APIError):
            helper.write_sync_position(body)
        self.assertEqual(helper.reading_version, 2)

    def test_first_push_creates_server_assigned_bookmark_and_verifies_it(self):
        helper = fixture()
        helper.sync_writes = True
        body = {"id": "synthetic-book", "revision": "r1", "expectedModified": None,
                "position": "chapter.xhtml#point(/1/4/2/1:8)", "progress": 0.42, "modified": 2000}
        value = {key: body[key] for key in ("position", "progress", "modified")}
        empty = {"revision": "r1", "patches": []}
        saved = {"revision": "r3", "patches": [{
            "op": "add", "path": "/publications/publication-test/bookmark/server-slot",
            "value": {**value, "revision": "server-revision"}}]}
        with patch.object(helper, "remote", side_effect=[empty, {"revision": "r2"}, saved]) as remote:
            self.assertTrue(helper.write_sync_position(body)["synced"])
            self.assertEqual(remote.call_args_list[1].args[3], {"revision": "r1", "patches": [{
                "op": "add", "path": "/publications/publication-test/bookmark", "value": value}]})
        self.assertEqual(helper.reading_version, 1)
        self.assertEqual(helper.last_sync_write, {"synced": True})
        with patch.object(helper, "remote", side_effect=[empty, {"revision": "r2"}, empty]), \
                self.assertRaises(APIError):
            helper.write_sync_position(body)
        self.assertFalse(helper.last_sync_write["synced"])
        self.assertEqual(helper.reading_version, 1)
        with patch.object(helper, "remote", return_value={**empty, "revision": "changed"}) as remote, \
                self.assertRaises(APIError):
            helper.write_sync_position(body)
        self.assertEqual(remote.call_count, 1)

    def test_reading_state_always_sends_empty_patches(self):
        helper = fixture()
        with patch.object(helper, "remote", return_value={"revision": "next", "patches": []}) as remote:
            self.assertEqual(helper.reading("previous")["revision"], "next")
        self.assertEqual(remote.call_args.args[1:], ("PATCH", "/sync-data?paths=publications",
                                                   {"revision": "previous", "patches": []}))

    def test_dashboard_progress_reads_full_state_and_keeps_real_zero(self):
        helper = fixture()
        value = {"progress": 0, "position": "chapter.xhtml#point(/1/2:0)", "modified": 1000,
                 "currentPosition": "1", "lastPosition": "100", "revision": "not-needed"}
        response = {"revision": "current", "patches": [
            {"op": "add", "path": "/publications/publication-test/bookmark/one", "value": value}]}
        with patch.object(helper, "reading", return_value=response) as reading:
            result = helper.reading_progress()
        reading.assert_called_once_with(None)
        self.assertEqual(result["positions"]["publication-test"]["progress"], 0)
        self.assertEqual(result["positions"]["publication-test"]["currentPosition"], "1")
        self.assertNotIn("revision", result["positions"]["publication-test"])
        self.assertIsInstance(result["fetchedAt"], int)
        self.assertEqual(reading_positions({"revision": "empty"}), {})

    def test_progress_uses_latest_bookmark_and_applies_removals_and_pointer_escaping(self):
        def change(path, progress, modified):
            return {"op": "add", "path": path, "value": {
                "progress": progress, "modified": modified, "position": "chapter.xhtml#point(/1:0)"}}
        prefix = "/publications/pub~1one~0two/bookmark/"
        changes = [change(prefix + "old", 0.9, 1000), change(prefix + "new", 0.25, 2000),
                   change("/publications/other/bookmark/one", 0.1, 1500),
                   {"op": "add", "path": "/publications/other/comments/one", "value": {"text": "note"}}]
        self.assertEqual(reading_positions({"patches": changes})["pub/one~two"]["progress"], 0.25)
        changes.append({"op": "remove", "path": prefix + "new"})
        self.assertEqual(reading_positions({"patches": changes})["pub/one~two"]["progress"], 0.9)
        changes.append({"op": "remove", "path": "/publications/pub~1one~0two/bookmark"})
        self.assertEqual(set(reading_positions({"patches": changes})), {"other"})
        changes.append({"op": "remove", "path": "/publications"})
        self.assertEqual(reading_positions({"patches": changes}), {})

    def test_invalid_or_unsupported_cloud_progress_is_explicit_not_zero(self):
        value = {"progress": 0.42, "modified": 1000, "position": "chapter.xhtml#point(/1:0)"}
        invalid = [{"progress": item} for item in (-0.1, 1.1, float("nan"), float("inf"), True, "0.5")]
        invalid += [{"modified": item} for item in (-1, float("inf"), True, None)]
        invalid += [{"position": None}, {"currentPosition": 10}]
        for update in invalid:
            with self.subTest(update=update), self.assertRaises(APIError):
                reading_positions({"patches": [{"op": "add", "path": "/publications/pub/bookmark/one",
                                                "value": {**value, **update}}]})
        for change in (None, {"op": "copy", "path": "/publications/pub/bookmark/one"},
                       {"op": "add", "path": "/publications/pub/bookmark", "value": {}},
                       {"op": "add", "path": "/publications/pub/bookmark/one/nested", "value": {}},
                       {"op": "add", "path": "/publications/pub~2/bookmark/one", "value": value}):
            with self.subTest(change=change), self.assertRaises(APIError):
                reading_positions({"patches": [change]})

    def test_refresh_and_single_auth_retry_without_persisting_tokens(self):
        helper = fixture()
        first = Mock(status_code=401)
        second = Mock(status_code=200)
        second.json.return_value = INVENTORY
        refresh_response = Mock(status_code=200)
        refresh_response.json.return_value = {"access_token": "synthetic-next"}
        with patch("companion.requests.request", side_effect=[first, second]) as request, \
                patch("companion.requests.post", return_value=refresh_response):
            self.assertEqual(helper.remote(helper.state.client, "GET", "/inventory/delta?strip=true"), INVENTORY)
        self.assertEqual(request.call_count, 2)
        helper.state.client.update_token.assert_called_once_with({"access_token": "synthetic-next"})
        helper.state.client._store_current_token.assert_not_called()
        self.assertFalse(request.call_args.kwargs["allow_redirects"])
        self.assertEqual(request.call_args.kwargs["timeout"], 30)

    def test_download_rejects_unknown_books_and_drm_before_remote_call(self):
        helper = fixture()
        with self.assertRaises(APIError):
            helper.download_info("not-in-library")
        helper.state.inventory = [{**BOOK, "contentProtectionType": "ADOBE_DRM"}]
        with patch.object(helper, "remote") as remote:
            with self.assertRaises(APIError):
                helper.download_info("synthetic-book")
            remote.assert_not_called()

    def test_real_inventory_protection_and_encryption_flags(self):
        helper = fixture()
        meta = {**BOOK["epubMetaData"], "protectionType": "WatermarkV1",
                "deliverable": [{"contentFormat": "application/epub+zip", "contentEncrypted": False}]}
        helper.state.inventory = [{**BOOK, "epubMetaData": meta}]
        with patch.object(helper, "remote", return_value={"DownloadInfo": {
                "format": "application/epub+zip", "contentUrl": "https://cdn.example/book"}}), \
                patch("companion.public_https", side_effect=lambda url: url):
            self.assertEqual(helper.download_info("synthetic-book"), "https://cdn.example/book")
        for protection, encrypted in (("ACS4", False), ("WatermarkV1", True), ("Unprotected", "false")):
            meta["protectionType"] = protection
            meta["deliverable"][0]["contentEncrypted"] = encrypted
            with patch.object(helper, "remote") as remote, self.assertRaises(APIError):
                helper.download_info("synthetic-book")
            remote.assert_not_called()

    def test_download_info_uses_inventory_publication_and_deliverable_ids(self):
        helper = fixture()
        helper.state.inventory = [{
            **BOOK,
            "publicationId": "publication-upload",
            "deliverableId": "deliverable-upload",
            "epubMetaData": {
                **BOOK["epubMetaData"],
                "deliverable": [{"identifier": "nested-deliverable",
                                 "contentFormat": "application/epub+zip"}],
            },
        }]
        response = {"DownloadInfo": {"format": "application/epub+zip", "contentUrl": "https://cdn.example/book"}}
        with patch.object(helper, "remote", return_value=response) as remote, \
                patch("companion.public_https", side_effect=lambda url: url):
            helper.download_info("synthetic-book")
        self.assertEqual(
            remote.call_args.args[2],
            "/cloud/downloadinfo/cHVibGljYXRpb24tdXBsb2Fk/ZGVsaXZlcmFibGUtdXBsb2Fk/type/external-download",
        )

    def test_download_info_uses_nested_deliverable_id_and_identifier_fallback(self):
        helper = fixture()
        helper.state.inventory = [{
            **BOOK,
            "publicationId": None,
            "epubMetaData": {
                **BOOK["epubMetaData"],
                "deliverable": [{"identifier": "nested-deliverable",
                                 "contentFormat": "application/epub+zip"}],
            },
        }]
        response = {"DownloadInfo": {"format": "application/epub+zip", "contentUrl": "https://cdn.example/book"}}
        with patch.object(helper, "remote", return_value=response) as remote, \
                patch("companion.public_https", side_effect=lambda url: url):
            helper.download_info("synthetic-book")
        self.assertEqual(
            remote.call_args.args[2],
            "/cloud/downloadinfo/c3ludGhldGljLWJvb2s%3D/bmVzdGVkLWRlbGl2ZXJhYmxl/type/external-download",
        )

    def test_download_stream_uses_no_credentials_and_validates_zip(self):
        helper = fixture()
        response = Mock(status_code=200)
        response.headers = {"Content-Type": "application/epub+zip"}
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as epub:
            epub.writestr("mimetype", "application/epub+zip")
        content = archive.getvalue()
        response.iter_content.return_value = [content]
        with patch.object(helper, "download_info", return_value="https://cdn.example/book"), \
                patch("companion.public_https", side_effect=lambda url: url), \
                patch("companion.requests.get", return_value=response) as get:
            output, size = helper.download("synthetic-book")
            with output:
                self.assertEqual(output.read(), content)
            self.assertEqual(size, len(content))
            self.assertEqual(get.call_args.kwargs["headers"], {"Accept": "application/epub+zip"})
            self.assertFalse(get.call_args.kwargs["allow_redirects"])

    def test_cover_is_selected_from_library_and_rejects_non_raster_content(self):
        helper = fixture()
        helper.state.inventory = [{"epubMetaData": {
            **BOOK["epubMetaData"], "fileResource": [{"resource": "https://cdn.example/cover.png"}]}}]
        with patch("companion.fetch_asset", return_value=(io.BytesIO(b"image"), 5, "image/png")) as asset:
            output, size, content_type = helper.cover("synthetic-book")
            output.close()
            self.assertEqual((size, content_type), (5, "image/png"))
            headers_for_url = asset.call_args.args[3]
            self.assertEqual(headers_for_url("https://cdn.example/cover.png"), {})
            self.assertEqual(headers_for_url("https://cdn.example/redirect"), {})
            self.assertIn("t_auth_token", headers_for_url("https://bosh.pageplace.de/bosh/rest/cover/test"))
        with patch("companion.fetch_asset", return_value=(io.BytesIO(b"<svg/>"), 6, "image/svg+xml")):
            with self.assertRaises(APIError):
                helper.cover("synthetic-book")
        with self.assertRaises(APIError):
            helper.cover("not-in-library")

    def test_signed_download_hosts_must_be_public_https(self):
        for url in ("http://cdn.example/book", "https://user:pass@cdn.example/book"):
            with self.assertRaises(APIError):
                public_https(url)
        with patch("companion.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 443))]):
            with self.assertRaises(APIError):
                public_https("https://cdn.example/book")

    def test_client_abort_during_epub_stream_never_attempts_a_second_http_response(self):
        helper = fixture()
        with create_api_server(helper, 0) as server:
            handler = object.__new__(server.RequestHandlerClass)
            handler.command = "GET"
            handler.path = "/api/download?id=synthetic-book"
            handler.headers = {"Authorization": "Bearer " + helper.key}
            handler.send_response = Mock()
            handler.send_header = Mock()
            handler.end_headers = Mock()
            handler.answer = Mock()
            handler.wfile = Mock()
            handler.wfile.write.side_effect = BrokenPipeError()
            output = io.BytesIO(b"synthetic-bytes")
            with patch.object(helper, "download", return_value=(output, 15)), patch("companion.sys.stderr", new=io.StringIO()):
                handler.dispatch()
            handler.send_response.assert_called_once_with(200)
            handler.answer.assert_not_called()
            self.assertTrue(output.closed)

    def test_http_api_requires_key_and_cannot_accept_cloud_writes_or_arbitrary_urls(self):
        helper = fixture()
        with create_api_server(helper, 0) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
            try:
                connection.request("GET", "/api/status")
                response = connection.getresponse()
                self.assertEqual(response.status, 401)
                response.read()
                headers = {"Authorization": "Bearer " + helper.key, "Content-Type": "application/json"}
                connection.request("GET", "/api/status", headers=headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read()), {"connected": True, "busy": False, "apiVersion": 1})
                connection.request("GET", "/api/sync-status", headers=headers)
                response = connection.getresponse()
                self.assertEqual(json.loads(response.read()), {
                    "connected": True, "busy": False, "apiVersion": 1, "syncWritesEnabled": False})
                connection.request("PUT", "/api/sync-position", "{}", headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                with patch.object(helper, "sync_position", return_value={"revision": "r1", "position": None}) as sync:
                    connection.request("GET", "/api/sync-position?id=synthetic-book", headers=headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read()), {"revision": "r1", "position": None})
                    sync.assert_called_once_with("synthetic-book")
                with patch.object(helper, "inventory", return_value=INVENTORY):
                    connection.request("GET", "/api/inventory", headers=headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read()), INVENTORY)
                native_headers = {**headers, "X-Tolino-Mode": "helper", "X-Tolino-Transport-Accepted": "true"}
                for path in ("/api/catalog", "/api/native-download?id=" + native_id("synthetic-book")):
                    connection.request("GET", path, headers=headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 400)
                    response.read()
                with patch.object(helper, "catalog", return_value={"books": []}) as catalog:
                    connection.request("GET", "/api/catalog", headers=native_headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read()), {"books": []})
                    catalog.assert_called_once_with(supported_only=False)
                    connection.request("GET", "/api/catalog?supported=1", headers=native_headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read()), {"books": []})
                    catalog.assert_called_with(supported_only=True)
                    connection.request("GET", "/api/catalog?url=anything", headers=native_headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 400)
                    response.read()
                with patch.object(helper, "download", return_value=(io.BytesIO(b"EPUB"), 4)) as download:
                    connection.request("GET", "/api/native-download?id=" + native_id("synthetic-book"),
                                       headers=native_headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.read(), b"EPUB")
                    download.assert_called_once_with("synthetic-book")
                with patch.object(helper, "reading", return_value={"revision": "next", "patches": []}) as reading:
                    connection.request("POST", "/api/reading-state", json.dumps({"revision": None}), headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    response.read()
                    reading.assert_called_once_with(None)
                    connection.request("POST", "/api/reading-state", '{"revision":null,"patches":[{}]}', headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 400)
                    response.read()
                connection.request("GET", "/api/download?url=https://evil.invalid", headers=headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 400)
                response.read()
                connection.request("POST", "/login", "{}", headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 404)
                response.read()
                with patch.object(helper, "cover", return_value=(io.BytesIO(b"image"), 5, "image/png")):
                    connection.request("GET", "/api/cover?id=synthetic-book", headers=headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.getheader("Content-Type"), "image/png")
                    self.assertEqual(response.read(), b"image")
                with patch.object(helper, "download", return_value=(io.BytesIO(b"EPUB"), 4)):
                    connection.request("GET", "/api/download?id=synthetic-book", headers=headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertIn("attachment", response.getheader("Content-Disposition"))
                    self.assertIn("Synthetic%20book.epub", response.getheader("Content-Disposition"))
                    self.assertEqual(response.read(), b"EPUB")
            finally:
                connection.close()
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()
