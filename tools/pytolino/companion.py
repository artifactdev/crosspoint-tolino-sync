"""Authenticated LAN API with opt-in exact-position writes. Credentials stay in the helper."""

import base64
import hmac
import hashlib
import os
import ipaddress
import json
import math
import re
import secrets
import socket
import sys
import tempfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlsplit

import requests

BOSH = "https://bosh.pageplace.de/bosh/rest"
EPUB = "application/epub+zip"
MAX_DOWNLOAD = 256 * 1024 * 1024


class APIError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def epub_supported(book):
    meta = book.get("epubMetaData", {})
    deliverables = meta.get("deliverable", [])
    if not deliverables or not isinstance(deliverables[0], dict):
        return False
    deliverable = deliverables[0]
    protections = [book.get("contentProtectionType"), meta.get("contentProtectionType"),
                   meta.get("protectionType"), deliverable.get("contentProtectionType")]
    return (str(deliverable.get("contentFormat", "")).lower() == EPUB
            and deliverable.get("contentEncrypted", False) is False
            and all(str(value or "").upper() in ("", "UNPROTECTED", "WATERMARK", "WATERMARKV1", "NONE")
                    for value in protections))


def native_id(identifier):
    return hashlib.sha256(identifier.encode()).hexdigest()


def epub_filename(title):
    if not isinstance(title, str) or not title.strip():
        raise APIError(502, "Book title is missing; no filename was guessed.")
    stem = re.sub(r'[\\/:*?"<>|]', "_", title)
    stem = re.sub(r"[\x00-\x1f\x7f]", "", stem)
    stem = re.sub(r"\.{2,}", "_", stem).strip(" .")
    stem = stem.encode("utf-8")[:95].decode("utf-8", errors="ignore").rstrip(" .") or "book"
    return stem + ".epub"


def public_https(url):
    if not isinstance(url, str):
        raise APIError(502, "Provider returned an invalid download URL.")
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise APIError(502, "Provider returned an unsafe download URL.")
    if any(not ipaddress.ip_address(info[4][0]).is_global
           for info in socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)):
        raise APIError(502, "Provider returned a non-public download host.")
    return url


def safe_metadata(value):
    """Keep publication metadata, never operational account/session fields."""
    if isinstance(value, dict):
        return {key: safe_metadata(item) for key, item in value.items()
                if not any(secret in key.lower().replace("_", "").replace("-", "")
                           for secret in ("token", "password", "cookie", "authorization", "hardwareid"))}
    if isinstance(value, list):
        return [safe_metadata(item) for item in value]
    return value


def reading_positions(response):
    bookmarks = {}
    for patch in response.get("patches", []):
        if (not isinstance(patch, dict) or not isinstance(patch.get("path"), str)
                or patch.get("op") not in ("add", "replace", "remove")):
            raise APIError(502, "Unrecognized cloud reading-state change.")
        path = patch["path"]
        match = re.fullmatch(r"/publications/([^/]+)/bookmark/([^/]+)", path)
        if match:
            if patch["op"] == "remove":
                bookmarks.pop(path, None)
                continue
            value = patch.get("value")
            if not isinstance(value, dict):
                raise APIError(502, "Unrecognized cloud reading position.")
            for field, maximum in (("progress", 1), ("modified", None)):
                number = value.get(field)
                if (isinstance(number, bool) or not isinstance(number, (int, float))
                        or not math.isfinite(number) or number < 0
                        or (maximum is not None and number > maximum)):
                    raise APIError(502, "Invalid cloud reading progress or timestamp.")
            if not isinstance(value.get("position"), str):
                raise APIError(502, "Unrecognized cloud reading locator.")
            for field in ("currentPosition", "lastPosition"):
                if field in value and not isinstance(value[field], str):
                    raise APIError(502, "Unrecognized cloud page number.")
            publication = match[1]
            if re.search(r"~(?![01])", publication):
                raise APIError(502, "Invalid cloud publication pointer.")
            publication = publication.replace("~1", "/").replace("~0", "~")
            bookmarks[path] = (publication, {key: value[key] for key in
                                           ("progress", "modified", "position", "currentPosition", "lastPosition")
                                           if key in value})
        elif path == "/publications" or re.fullmatch(r"/publications/[^/]+(?:/bookmark)?", path):
            if patch["op"] != "remove":
                raise APIError(502, "Unsupported cloud bookmark snapshot; no progress was guessed.")
            bookmarks = {key: value for key, value in bookmarks.items() if not key.startswith(path + "/")}
        elif "/bookmark" in path:
            raise APIError(502, "Unrecognized cloud bookmark path.")
    positions = {}
    for publication, value in bookmarks.values():
        if publication not in positions or value["modified"] > positions[publication]["modified"]:
            positions[publication] = value
    return positions


def fetch_asset(url, accept, limit, headers_for_url=None):
    for _ in range(6):
        headers = {"Accept": accept}
        if headers_for_url:
            headers.update(headers_for_url(url))
        response = requests.get(public_https(url), stream=True, timeout=(15, 60),
                                allow_redirects=False, headers=headers)
        if response.status_code in (301, 302, 303, 307, 308):
            location = response.headers.get("Location")
            response.close()
            if not location:
                raise APIError(502, "Provider redirect has no destination.")
            url = urljoin(url, location)
            continue
        break
    else:
        raise APIError(502, "Too many provider redirects.")
    output = tempfile.TemporaryFile()
    try:
        with response:
            if response.status_code != 200:
                raise APIError(502, f"Provider asset failed (HTTP {response.status_code}).")
            content_type = response.headers.get("Content-Type", "").split(";")[0].lower()
            size = 0
            for chunk in response.iter_content(64 * 1024):
                size += len(chunk)
                if size > limit:
                    raise APIError(413, "Provider asset exceeds the helper size limit.")
                output.write(chunk)
        output.seek(0)
        return output, size, content_type
    except Exception:
        output.close()
        raise


class Companion:
    def __init__(self, state, api_key=None, on_token_update=None, on_expired=None):
        self.state = state
        self.key = api_key or secrets.token_urlsafe(32)
        if len(self.key) < 32 or not self.key.isascii() or any(char.isspace() for char in self.key):
            raise ValueError("Helper API key must be at least 32 ASCII characters without whitespace.")
        self.lock = threading.Lock()
        self.on_token_update = on_token_update
        self.on_expired = on_expired
        self.sync_writes = os.environ.get("HELPER_SYNC_WRITES") == "1"
        self.reading_version = 0
        self.last_sync_write = None

    def client(self):
        snapshot = self.state.snapshot()
        if snapshot["busy"]:
            raise APIError(409, "Helper is busy; wait for login/library refresh.")
        if not snapshot["connected"]:
            raise APIError(409, "Sign in on the helper dashboard first.")
        return self.state.client

    def headers(self, client):
        return {**client._get_auth_headers(), "client_type": "TOLINO_WEBREADER",
                "client_version": "4.4.1", "Accept": "application/json"}

    def refresh(self, client):
        response = requests.post(
            "https://www.thalia.de/auth/oauth2/token",
            data={"client_id": "webreader", "grant_type": "refresh_token",
                  "refresh_token": client.refresh_token, "scope": "SCOPE_BOSH"},
            timeout=30, allow_redirects=False)
        try:
            if response.status_code != 200:
                if response.status_code in (400, 401, 403):
                    if self.on_expired:
                        self.on_expired()
                    raise APIError(401, "Session expired. Automatic sign-in is attempted only with saved credentials; check the dashboard.")
                raise APIError(502, f"Session refresh temporarily unavailable (HTTP {response.status_code}).")
            try:
                client.update_token(response.json())
            except (ValueError, TypeError) as error:
                raise APIError(502, "Provider returned an invalid refresh response; sign in again.") from error
            if self.on_token_update:
                self.on_token_update(client)
        finally:
            response.close()

    def remote(self, client, method, path, body=None):
        if client.access_expiration_time <= time.time() + 60:
            self.refresh(client)
        for attempt in range(2):
            response = requests.request(method, BOSH + path, headers=self.headers(client),
                                        json=body, timeout=30, allow_redirects=False)
            try:
                if response.status_code in (401, 403) and attempt == 0:
                    self.refresh(client)
                    continue
                if response.status_code != 200:
                    raise APIError(502, f"Tolino request failed (HTTP {response.status_code}).")
                return response.json()
            finally:
                response.close()
        raise APIError(401, "Sign in again on the helper.")

    def inventory(self):
        with self.lock:
            client = self.client()
            result = self.remote(client, "GET", "/inventory/delta?strip=true")
            inventory = result.get("PublicationInventory") if isinstance(result, dict) else None
            if (not isinstance(inventory, dict) or not isinstance(inventory.get("ebook"), list)
                    or not isinstance(inventory.get("edata"), list)):
                raise APIError(502, "Unrecognized Tolino inventory response.")
            with self.state.lock:
                self.state.inventory = inventory["ebook"] + inventory["edata"]
            return safe_metadata(result)

    def reading(self, revision):
        if revision is not None and (not isinstance(revision, str) or not revision or len(revision) > 4096):
            raise APIError(400, "Invalid revision.")
        with self.lock:
            result = self.remote(self.client(), "PATCH", "/sync-data?paths=publications",
                                 {"revision": revision, "patches": []})
            if (not isinstance(result, dict) or not isinstance(result.get("revision"), str)
                    or not result["revision"] or not isinstance(result.get("patches", []), list)):
                raise APIError(502, "Unrecognized reading-state revision.")
            return safe_metadata(result)

    def reading_progress(self):
        # A full read avoids sharing a revision/cache with the reader plugin.
        return {"positions": reading_positions(self.reading(None)),
                "fetchedAt": int(time.time() * 1000)}

    def sync_position(self, identifier):
        book = self.book(identifier)
        publication = book.get("publicationId") or book["epubMetaData"].get("publicationId") or identifier
        result = self.reading(None)
        position = reading_positions(result).get(publication)
        return {"publicationId": publication, "revision": result["revision"], "position": position}

    def write_sync_position(self, body):
        try:
            result = self._write_sync_position(body)
        except (APIError, requests.RequestException) as error:
            self.last_sync_write = {
                "synced": False, "error": str(error) if isinstance(error, APIError)
                else "Tolino cloud connection failed; pull before retrying.",
            }
            raise
        self.last_sync_write = {"synced": True}
        return result

    def _write_sync_position(self, body):
        if not self.sync_writes:
            raise APIError(403, "Cloud writes disabled. Enable HELPER_SYNC_WRITES=1 explicitly.")
        if not isinstance(body, dict) or set(body) != {
                "id", "revision", "expectedModified", "position", "progress", "modified"}:
            raise APIError(400, "Exact position, revision and conflict timestamp are required.")
        identifier = body["id"]
        if not isinstance(body["revision"], str) or not body["revision"] or len(body["revision"]) > 4096:
            raise APIError(400, "A cloud revision is required.")
        book = self.book(identifier)
        if not epub_supported(book):
            raise APIError(422, "Only supported EPUBs can synchronize positions.")
        position = body["position"]
        if (not isinstance(position, str) or len(position) > 4096
                or not re.fullmatch(r"[^#\x00-\x20]+#point\(/1(?:/[1-9]\d*)+:\d+\)", position)
                or any(part in (".", "..") for part in position.split("#")[0].split("/"))):
            raise APIError(400, "A resolved, exact Tolino EPUB point is required.")
        for field in ("modified", "progress"):
            value = body[field]
            if (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                    or value < 0 or (field == "progress" and value > 1)):
                raise APIError(400, "Invalid progress or modification time.")
        expected = body["expectedModified"]
        if (expected is not None and (isinstance(expected, bool) or not isinstance(expected, (int, float))
                                     or not math.isfinite(expected) or expected < 0)):
            raise APIError(400, "Invalid expected cloud timestamp.")
        if body["modified"] > time.time() * 1000 + 60000:
            raise APIError(400, "Future reading timestamps are not accepted.")
        publication = book.get("publicationId") or book["epubMetaData"].get("publicationId") or identifier
        with self.lock:
            client = self.client()
            current = self.remote(client, "PATCH", "/sync-data?paths=publications",
                                  {"revision": None, "patches": []})
            if (not isinstance(current, dict) or not isinstance(current.get("revision"), str)
                    or not current["revision"] or not isinstance(current.get("patches"), list)):
                raise APIError(502, "Unrecognized reading-state revision.")
            latest = reading_positions(current).get(publication)
            if (current.get("revision") != body["revision"]
                    or (latest["modified"] if latest else None) != expected):
                raise APIError(409, "Cloud state changed. Pull the current position before retrying.")
            if latest and (latest["position"] == position and latest["progress"] == body["progress"]):
                self.reading_version += 1
                return {"synced": True, "unchanged": True, "revision": current["revision"]}
            if latest and latest["modified"] >= body["modified"]:
                raise APIError(409, "A newer or equally recent cloud position must not be overwritten.")
            # Preserve the provider's existing bookmark slot and per-book revision.
            matches = {}
            for change in current["patches"]:
                path = change["path"]
                if change["op"] == "remove":
                    matches = {key: value for key, value in matches.items()
                               if key != path and not key.startswith(path + "/")}
                elif (re.fullmatch(r"/publications/[^/]+/bookmark/[^/]+", path)
                      and path.split("/")[2].replace("~1", "/").replace("~0", "~") == publication):
                    matches[path] = change
            if matches:
                selected = max(matches.values(), key=lambda patch: patch["value"]["modified"])
                if not isinstance(selected["value"].get("revision"), str) or not selected["value"]["revision"]:
                    raise APIError(502, "Cloud bookmark revision is missing; no write performed.")
                value = {"revision": selected["value"]["revision"]}
                operation, path = "replace", selected["path"]
            else:
                # Like the official client, add to the collection; the server assigns the slot/revision.
                escaped = publication.replace("~", "~0").replace("/", "~1")
                operation, path, value = "add", f"/publications/{escaped}/bookmark", {}
            value.update({"position": position, "progress": body["progress"], "modified": body["modified"]})
            # Old provider page counts belong to the old position; do not attach them to a new locator.
            result = self.remote(client, "PATCH", "/sync-data?paths=publications", {
                "revision": current["revision"],
                "patches": [{"op": operation, "path": path, "value": value}]})
            if not isinstance(result, dict) or not isinstance(result.get("revision"), str):
                raise APIError(502, "Cloud write was not confirmed. Pull before retrying.")
            verified = self.remote(client, "PATCH", "/sync-data?paths=publications",
                                   {"revision": None, "patches": []})
            saved = reading_positions(verified).get(publication)
            if not saved or any(saved.get(key) != body[key] for key in ("position", "progress", "modified")):
                raise APIError(409, "Cloud position differs after the write. Pull before retrying.")
            self.reading_version += 1
            return {"synced": True, "unchanged": False, "revision": verified["revision"]}

    def catalog(self, supported_only=False):
        inventory = self.inventory()["PublicationInventory"]
        positions = self.reading_progress()["positions"]
        books = {}
        for book in inventory["ebook"] + inventory["edata"]:
            meta = book.get("epubMetaData")
            if not isinstance(meta, dict):
                raise APIError(502, "Catalog entry has no EPUB metadata.")
            identifier, title = meta.get("identifier"), meta.get("title")
            publication = book.get("publicationId") or meta.get("publicationId") or identifier
            if any(not isinstance(value, str) or not value.strip() for value in (identifier, title, publication)):
                raise APIError(502, "Catalog entry has an invalid identifier or title.")
            authors = meta.get("author") or []
            if not isinstance(authors, list) or any(not isinstance(author, dict) for author in authors):
                raise APIError(502, "Catalog entry has invalid authors.")
            author = ", ".join(item["name"] for item in authors if isinstance(item.get("name"), str))
            supported = epub_supported(book)
            if supported_only and not supported:
                continue
            position = positions.get(publication)
            progress = (f"Cloud reading progress: {position['progress'] * 100:.0f}%."
                        if position is not None else "No cloud reading position available.")
            description = ("EPUB download supported." if supported else
                           "Download blocked: unsupported format or DRM. No DRM removal.")
            sidecar = json.dumps({"tolino_identifier": identifier, "tolino_publication_id": publication,
                                  "tolino_id": identifier})
            if len(sidecar.encode()) > 2048:
                raise APIError(502, "Native book metadata exceeds the firmware's 2 KB sidecar limit.")
            books[identifier] = {
                "id": native_id(identifier),
                "filename": epub_filename(title),
                "title": epub_filename(title)[:-5] if supported else title + " [DRM / unsupported]",
                "author": author,
                "description": description + " " + progress + " Reader positions are not synchronized.",
                # Inserted as a complete JSON document, never interpolated into JSON string literals.
                "sidecar": sidecar,
            }
        return {"books": sorted(books.values(), key=lambda item: item["title"].casefold())}

    def native_identifier(self, digest):
        if not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise APIError(400, "Invalid native catalog book ID.")
        with self.state.lock:
            inventory = list(self.state.inventory)
        for book in inventory:
            identifier = book.get("epubMetaData", {}).get("identifier")
            if isinstance(identifier, str) and native_id(identifier) == digest:
                return identifier
        raise APIError(404, "Load the native catalog first; book not found.")

    def book(self, identifier):
        if not isinstance(identifier, str) or not identifier or len(identifier) > 4096:
            raise APIError(400, "Invalid book identifier.")
        with self.state.lock:
            items = list(self.state.inventory)
        book = next((item for item in items if item.get("epubMetaData", {}).get("identifier") == identifier), None)
        if book is None:
            raise APIError(404, "Load the library first; book not found.")
        return book

    def download_disposition(self, identifier):
        filename = epub_filename(self.book(identifier)["epubMetaData"].get("title"))
        fallback = filename.encode("ascii", errors="replace").decode().replace('"', "_")
        return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"

    def cover(self, identifier):
        with self.lock:
            client = self.client()
            book = self.book(identifier)
            resources = book["epubMetaData"].get("fileResource") or []
            urls = [resource["resource"] for resource in resources if isinstance(resource, dict)
                    and isinstance(resource.get("resource"), str) and resource["resource"].startswith("https://")]
            if not urls:
                raise APIError(404, "No cover supplied for this book.")
            if client.access_expiration_time <= time.time() + 60:
                self.refresh(client)

            def headers(url):
                parsed = urlsplit(url)
                return self.headers(client) if (
                    f"{parsed.scheme}://{parsed.netloc}" == "https://bosh.pageplace.de"
                    and parsed.path.startswith("/bosh/rest/cover")
                ) else {}

            output, size, content_type = fetch_asset(urls[0], "image/jpeg,image/png,image/webp,image/gif",
                                                    5 * 1024 * 1024, headers)
            if content_type not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
                output.close()
                raise APIError(422, "Provider cover is not a supported raster image.")
            return output, size, content_type

    def download_info(self, identifier):
        client = self.client()
        book = self.book(identifier)
        if not epub_supported(book):
            raise APIError(422, "Only unprotected/watermarked EPUBs are supported; no Adobe DRM/ACSM.")
        metadata = book.get("epubMetaData", {})
        deliverables = metadata.get("deliverable", [])
        deliverable = deliverables[0] if deliverables and isinstance(deliverables[0], dict) else {}

        def first_id(*values):
            return next((value for value in values
                         if isinstance(value, str) and value and len(value) <= 4096), identifier)

        publication_id = first_id(book.get("publicationId"), metadata.get("publicationId"))
        deliverable_id = first_id(book.get("deliverableId"), metadata.get("deliverableId"),
                                  deliverable.get("identifier"))
        encoded_publication = quote(base64.b64encode(publication_id.encode()).decode(), safe="")
        encoded_deliverable = quote(base64.b64encode(deliverable_id.encode()).decode(), safe="")
        data = self.remote(client, "GET",
                           f"/cloud/downloadinfo/{encoded_publication}/{encoded_deliverable}/type/external-download")
        info = data.get("DownloadInfo") if isinstance(data, dict) else None
        if not isinstance(info, dict) or str(info.get("format", "")).lower() != EPUB:
            raise APIError(422, "Provider did not offer an EPUB.")
        return public_https(info.get("contentUrl", ""))

    def download(self, identifier):
        with self.lock:
            url = self.download_info(identifier)
            # Never forward account or helper credentials to a CDN or redirect target.
            output, size, _content_type = fetch_asset(url, EPUB, MAX_DOWNLOAD)
            try:
                if output.read(4) != b"PK\x03\x04":
                    raise APIError(422, "Download is not an EPUB ZIP file.")
                output.seek(0)
                try:
                    with zipfile.ZipFile(output) as archive:
                        info = archive.getinfo("mimetype")
                        if info.file_size != len(EPUB) or archive.read(info) != EPUB.encode():
                            raise APIError(422, "Download does not declare the EPUB mimetype.")
                except (zipfile.BadZipFile, KeyError) as error:
                    raise APIError(422, "Download is not a valid EPUB archive.") from error
                output.seek(0)
                return output, size
            except Exception:
                output.close()
                raise


def create_api_server(companion, port=8081):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def log_message(self, *_):
            pass

        def answer(self, status, value):
            body = json.dumps(value, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def dispatch(self):
            authorization = self.headers.get("Authorization", "")
            if not hmac.compare_digest(authorization.encode(), ("Bearer " + companion.key).encode()):
                return self.answer(401, {"error": "Valid helper API key required."})
            try:
                url = urlsplit(self.path)
                query = parse_qs(url.query, strict_parsing=True)
                if self.command == "GET" and url.path in ("/api/status", "/api/sync-status") and not query:
                    state = companion.state.snapshot()
                    value = {"connected": state["connected"], "busy": state["busy"], "apiVersion": 1}
                    if url.path == "/api/sync-status":
                        value["syncWritesEnabled"] = companion.sync_writes
                    return self.answer(200, value)
                if self.command == "GET" and url.path == "/api/sync-position":
                    if set(query) != {"id"} or len(query["id"]) != 1:
                        raise APIError(400, "Exactly one book ID is required.")
                    return self.answer(200, companion.sync_position(query["id"][0]))
                if self.command == "PUT" and url.path == "/api/sync-position" and not query:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= 16384 or self.headers.get("Content-Type") != "application/json":
                        raise APIError(400, "Bounded JSON sync request required.")
                    return self.answer(200, companion.write_sync_position(json.loads(self.rfile.read(length))))
                if self.command == "GET" and url.path == "/api/inventory" and not query:
                    return self.answer(200, companion.inventory())
                if self.command == "GET" and url.path in ("/api/catalog", "/api/native-download"):
                    if (self.headers.get("X-Tolino-Mode") != "helper"
                            or self.headers.get("X-Tolino-Transport-Accepted") != "true"):
                        raise APIError(400, "Save helper mode and accept transport/storage warnings in browser settings first.")
                    if url.path == "/api/catalog":
                        if query not in ({}, {"supported": ["1"]}):
                            raise APIError(400, "Native catalog only accepts supported=1.")
                        return self.answer(200, companion.catalog(supported_only=bool(query)))
                if self.command == "POST" and url.path == "/api/reading-state" and not query:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= 8192 or self.headers.get("Content-Type") != "application/json":
                        raise APIError(400, "JSON reading-state request required.")
                    body = json.loads(self.rfile.read(length))
                    if not isinstance(body, dict) or set(body) != {"revision"}:
                        raise APIError(400, "Only a revision is accepted on this read-only route.")
                    return self.answer(200, companion.reading(body["revision"]))
                if self.command == "GET" and url.path in ("/api/download", "/api/download-info", "/api/cover",
                                                        "/api/native-download"):
                    if set(query) != {"id"} or len(query["id"]) != 1:
                        raise APIError(400, "Exactly one book ID is required.")
                    identifier = query["id"][0]
                    if url.path == "/api/native-download":
                        identifier = companion.native_identifier(identifier)
                    if url.path == "/api/download-info":
                        with companion.lock:
                            companion.download_info(identifier)
                        # Relative URL; the plugin pins downloads to its configured helper.
                        return self.answer(200, {"DownloadInfo": {
                            "format": EPUB, "contentUrl": "/api/download?" + urlencode({"id": identifier})}})
                    if url.path == "/api/cover":
                        output, size, content_type = companion.cover(identifier)
                    else:
                        output, size = companion.download(identifier)
                        content_type = EPUB
                    with output:
                        self.send_response(200)
                        self.send_header("Content-Type", content_type)
                        self.send_header("Content-Length", str(size))
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("X-Content-Type-Options", "nosniff")
                        if url.path == "/api/download":
                            self.send_header("Content-Disposition", companion.download_disposition(identifier))
                        self.end_headers()
                        while chunk := output.read(64 * 1024):
                            self.wfile.write(chunk)
                    return
                return self.answer(404, {"error": "Unknown helper API route."})
            except (BrokenPipeError, ConnectionResetError):
                print("Client disconnected during helper response; no further response sent.", file=sys.stderr)
            except APIError as error:
                return self.answer(error.status, {"error": str(error)})
            except (ValueError, KeyError, TypeError):
                return self.answer(502, {"error": "Invalid request or unexpected provider response."})
            except (requests.RequestException, OSError):
                return self.answer(502, {"error": "Provider connection failed. Check connectivity and helper login."})

        do_GET = dispatch
        do_POST = dispatch
        do_PUT = dispatch

    return ThreadingHTTPServer(("0.0.0.0", port), Handler)
