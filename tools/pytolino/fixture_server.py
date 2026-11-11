"""Explicit offline dashboard/API fixture. Never signs in or contacts a provider."""

import tempfile
import threading
import zipfile
import io
import struct
import zlib

from companion import APIError, EPUB, create_api_server
from login_server import create_server


BOOKS = [
    {"publicationId": "fixture-publication-1", "epubMetaData": {
        "identifier": "fixture-book-1", "title": "The Quiet Atlas", "author": [{"name": "Ada Rivers"}],
        "publisher": "Northlight Press", "issued": "2025-03-12", "language": ["en"],
        "isbn": "9780000000001", "description": "A synthetic book for local testing.",
        "fileResource": [{"resource": "https://example.com/synthetic-cover.png"}],
        "deliverable": [{"contentFormat": EPUB, "contentProtectionType": "WATERMARK", "size": 1234567}],
    }},
    {"publicationId": "fixture-publication-2", "contentProtectionType": "ADOBE_DRM", "epubMetaData": {
        "identifier": "fixture-book-2", "title": "Gärten am Meer", "author": [{"name": "Mara Sommer"}],
        "publisher": "Grünblatt", "issued": "2024-06-01", "language": ["de"], "isbn": "9780000000002",
        "deliverable": [{"contentFormat": EPUB}],
    }},
    {"epubMetaData": {"identifier": "fixture-upload-1", "title": "<script>Not executable</script>",
                     "author": [{"name": "Synthetic Upload"}], "language": ["de"],
                     "deliverable": [{"contentFormat": EPUB}]}},
]


def main():
    with create_server(18080) as admin:
        state = admin.state
        state.client = object()
        state.books = [item["epubMetaData"]["title"] for item in BOOKS]
        state.inventory = BOOKS
        state.message = "OFFLINE-TEST: 3 synthetische Bücher. Kein echtes Konto verbunden."
        admin.companion.key = "synthetic-fixture-key-01234567890123456789"
        original_snapshot = state.snapshot
        state.snapshot = lambda: {**original_snapshot(), "testOnly": True}

        def begin(username=None, password=None):
            if username is not None:
                state.message = "OFFLINE-TEST: Anmeldung deaktiviert. Fuer echte Konten Port 8080 verwenden."
                return False
            state.message = "OFFLINE-TEST: 3 synthetische Bücher. Kein echtes Konto verbunden."
            return True

        state.begin = begin

        def remote(_client, method, path, body=None):
            if method == "GET" and path.startswith("/inventory/delta"):
                return {"PublicationInventory": {"ebook": BOOKS[:2], "edata": BOOKS[2:]}}
            if method == "PATCH" and path == "/sync-data?paths=publications" and body["patches"] == []:
                return {"revision": "fixture-revision", "patches": [{
                    "op": "add", "path": "/publications/fixture-publication-1/bookmark/test",
                    "value": {"progress": 0.42, "position": "chapter.xhtml#point(/1/2:0)", "modified": 1000},
                }]}
            if method == "GET" and path.startswith("/cloud/downloadinfo/"):
                return {"DownloadInfo": {"format": EPUB, "contentUrl": "https://example.com/fixture.epub"}}
            raise APIError(404, "Unsupported synthetic fixture request.")

        def download(identifier):
            if identifier != "fixture-book-1":
                raise APIError(422, "Only the first synthetic book is downloadable.")
            output = tempfile.TemporaryFile()
            with zipfile.ZipFile(output, "w") as archive:
                archive.writestr("mimetype", EPUB)
                archive.writestr("META-INF/container.xml", "<container/>")
            size = output.tell()
            output.seek(0)
            return output, size

        admin.companion.remote = remote
        admin.companion.download = download

        def cover(identifier):
            if identifier != "fixture-book-1":
                raise APIError(404, "No synthetic cover.")

            def chunk(kind, data):
                return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

            pixels = b"".join(b"\0" + bytes((48, 77, 64)) * 48 for _ in range(72))
            png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 48, 72, 8, 2, 0, 0, 0))
                   + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))
            return io.BytesIO(png), len(png), "image/png"

        admin.companion.cover = cover
        # The fixture has a static public example URL, never a provider URL.
        import companion
        companion.public_https = lambda url: url
        with create_api_server(admin.companion, 18081) as api:
            worker = threading.Thread(target=api.serve_forever)
            worker.start()
            try:
                print("OFFLINE fixture: http://127.0.0.1:18080/", flush=True)
                admin.serve_forever()
            finally:
                api.shutdown()
                worker.join()


if __name__ == "__main__":
    main()
