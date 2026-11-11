"""Loopback-published pytolino desktop harness with a contextual Thalia login."""

import contextlib
import base64
import hmac
import io
import json
import logging
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from probe import library_count
from companion import APIError, EPUB, Companion, create_api_server, safe_metadata
import requests

ASSET_DIR = Path(__file__).parent

def failure_message(error, client):
    from thalia_client import LOGIN_STAGES

    stage = LOGIN_STAGES.get(getattr(client, "login_stage", None), "Login/Bibliotheksabruf")
    browser_step = getattr(client, "browser_step", None)
    if getattr(client, "login_stage", None) == "browser" and isinstance(browser_step, str):
        stage += " / " + browser_step
    guidance = {
        "browser": "Die Browser-Anmeldung wurde nicht abgeschlossen. Browser ansehen; gegebenenfalls Cookies oder eine Sicherheitsabfrage bestaetigen.",
        "authorization": "Die Weiterleitung enthaelt keinen verwendbaren OAuth-Code oder die Autorisierung wurde abgelehnt.",
        "token": "Der OAuth-Tokenaustausch wurde abgelehnt oder lieferte ein unerwartetes Format.",
        "hardware": "Die Tolino-Geraeteliste fehlt oder hat ein anderes Format. Keine Geraete werden automatisch registriert.",
        "inventory": "Die Bibliotheksantwort fehlt oder hat ein unerwartetes Format.",
    }.get(getattr(client, "login_stage", None), "Browser ansehen; Zugangsdaten und Anbieter-Verfuegbarkeit pruefen.")
    return (f"{stage} fehlgeschlagen ({type(error).__name__}). {guidance} "
            "Kein erfolgreicher Bibliothekszugriff bestaetigt. "
            "Rohe Anbieterfehler werden zum Schutz deiner Zugangsdaten nicht angezeigt.")


def titles(inventory):
    library_count(inventory)
    result = []
    for book in inventory:
        if not isinstance(book, dict) or not isinstance(book.get("epubMetaData"), dict):
            raise ValueError("Unexpected book metadata.")
        title = book["epubMetaData"].get("title")
        if not isinstance(title, str):
            raise ValueError("Unexpected book title.")
        result.append(title)
    return result


class LoginState:
    def __init__(self, store=None):
        self.lock = threading.Lock()
        self.busy = False
        self.client = None
        self.diagnostic_client = None
        self.books = []
        self.inventory = []
        self.message = "Bereit. Echte Anmeldung noch nicht getestet."
        self.store = store
        self.credentials = None
        self.saved = False
        self.relogin_attempted = False
        self.persistence_error = None

    def snapshot(self):
        with self.lock:
            return dict(busy=self.busy, connected=self.client is not None,
                        message=self.message, books=list(self.books),
                        inventory=safe_metadata(self.inventory),
                        persistenceEnabled=self.store is not None, sessionSaved=self.saved,
                        credentialsSaved=self.credentials is not None)

    def begin(self, username=None, password=None, remember_credentials=False):
        companion = getattr(self, "companion", None)
        with (companion.lock if companion else contextlib.nullcontext()), self.lock:
            if self.busy or (username is None and self.client is None):
                return False
            if username is not None and self.store:
                self.store.clear()
                self.saved = False
            self.busy = True
            self.books = []
            self.inventory = []
            if username is not None:
                self.client = None
                self.credentials = None
                self.relogin_attempted = False
                if remember_credentials:
                    self.credentials = {"username": username, "password": password}
            self.message = "Anmeldung laeuft. Browserfenster bei Bedarf im zweiten Tab ansehen."
        threading.Thread(target=self.run, args=(username, password), daemon=True).start()
        return True

    def persist(self, client):
        if self.store:
            try:
                self.store.save(client.export_session(), self.credentials)
            except (OSError, ValueError) as error:
                self.persistence_error = "Anmeldung konnte nicht gespeichert werden. Datenvolume und Schreibrechte pruefen."
                self.browser_notice(self.persistence_error)
                raise APIError(503, self.persistence_error) from error
            self.saved = True
            self.persistence_error = None

    def restore(self):
        if not self.store:
            return
        try:
            from thalia_client import ThaliaClient
            value = self.store.load()
            credentials = value["credentials"]
            if credentials is not None:
                if (not isinstance(credentials, dict) or set(credentials) != {"username", "password"}
                        or not isinstance(credentials["username"], str) or not credentials["username"]
                        or not isinstance(credentials["password"], str) or not credentials["password"]):
                    raise ValueError("Invalid saved credentials.")
            self.credentials = credentials
            if value["session"] is None:
                return
            self.client = ThaliaClient.from_session(value["session"])
            self.saved = True
            self.begin()
        except (ValueError, OSError):
            self.client = None
            self.message = "Gespeicherte Anmeldung nicht lesbar. Speicherschluessel, Datenvolume und Rechte pruefen oder gespeicherte Anmeldung loeschen."

    def expired(self):
        # Called under the companion lock; never wait for the login thread here.
        with self.lock:
            if self.relogin_attempted:
                return
            self.relogin_attempted = True
            credentials = self.credentials
            if credentials is None:
                self.client = None
                self.inventory = []
                self.books = []
                self.message = "Sitzung abgelaufen oder widerrufen. Bitte erneut anmelden; kein Passwort gespeichert."
                return

        def reauthenticate():
            with self.companion.lock:
                with self.lock:
                    if self.credentials is not credentials or not self.relogin_attempted:
                        return
                    self.busy = True
                    self.client = None
                    self.message = "Gespeicherte Zugangsdaten: einmalige automatische Neuanmeldung laeuft."
            self.run(credentials["username"], credentials["password"])

        threading.Thread(target=reauthenticate, daemon=True).start()

    def forget(self):
        with self.companion.lock:
            with self.lock:
                if self.busy:
                    raise APIError(409, "Wait for the running login before forgetting it.")
                if self.store:
                    self.store.clear()
                self.credentials = None
                self.saved = False
                self.client = None
                self.inventory = []
                self.books = []
                self.message = "Lokale Anmeldung geloescht. Anbieter-Sitzung wurde nicht widerrufen."

    def maintain(self, stop):
        while not stop.wait(30):
            try:
                with self.companion.lock:
                    snapshot = self.snapshot()
                    if snapshot["busy"] or not snapshot["connected"]:
                        continue
                    if self.client.access_expiration_time <= time.time() + 120:
                        self.companion.refresh(self.client)
                    elif self.persistence_error:
                        self.persist(self.client)
            except (APIError, requests.RequestException, OSError) as error:
                self.browser_notice(str(error) if isinstance(error, APIError) else
                                    "Automatische Sitzungspflege fehlgeschlagen. Verbindung und Datenvolume pruefen; erneuter Versuch spaeter.")

    def run(self, username, password):
        client = None
        try:
            # Upstream diagnostics can include credentials, cookies and tokens.
            companion = getattr(self, "companion", None)
            with (companion.lock if companion else contextlib.nullcontext()), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                if username is not None:
                    from thalia_client import ThaliaClient
                    if self.diagnostic_client is not None:
                        self.diagnostic_client.close_browser()
                        self.diagnostic_client = None
                    client = ThaliaClient(username=username)
                    client.on_browser_notice = self.browser_notice
                    client.login(password)
                else:
                    client = self.client
                if not isinstance(client.access_token, str) or not client.access_token:
                    raise RuntimeError("No access token obtained.")
                if username is None and companion:
                    inventory_response = companion.remote(client, "GET", "/inventory/delta?strip=true")
                    inventory = (inventory_response["PublicationInventory"]["ebook"]
                                 + inventory_response["PublicationInventory"]["edata"])
                else:
                    inventory = client.get_inventory()
                books = titles(inventory)
                self.persist(client)
            with self.lock:
                self.client = client
                self.books = books
                self.inventory = inventory
                self.message = f"ERFOLG: {len(books)} echte Cloud-Buecher geladen."
                if username is not None:
                    self.relogin_attempted = False
        except Exception as error:
            with self.lock:
                retryable_session = (username is None and client is not None
                                     and not (isinstance(error, APIError) and error.status == 401))
                self.client = client if retryable_session else None
                self.diagnostic_client = client
                self.books = []
                self.inventory = []
                if username is not None and not self.saved:
                    self.credentials = None
                self.message = (str(error) if isinstance(error, APIError) else
                                "Bibliotheksabruf fehlgeschlagen. Gespeicherte Sitzung bleibt erhalten; Verbindung pruefen und Bibliothek aktualisieren."
                                if retryable_session else failure_message(error, client))
        finally:
            password = None
            with self.lock:
                self.busy = False

    def browser_notice(self, message):
        with self.lock:
            self.message = message


def create_server(port=8080):
    directory = os.environ.get("HELPER_DATA_DIR")
    storage_key = os.environ.get("HELPER_STORAGE_KEY_FILE")
    if bool(directory) != bool(storage_key):
        raise ValueError("Configure both HELPER_DATA_DIR and HELPER_STORAGE_KEY_FILE.")
    if directory:
        from session_store import SessionStore
        store = SessionStore(directory, storage_key)
    else:
        store = None
    state = LoginState(store)
    key_file = os.environ.get("HELPER_API_KEY_FILE")
    key = Path(key_file).read_text().strip() if key_file else None
    companion = Companion(state, key, on_token_update=state.persist, on_expired=state.expired)
    state.companion = companion
    session = secrets.token_hex(32)
    allowed_host = f"127.0.0.1:{port}"
    configured_origin = os.environ.get("HELPER_ADMIN_ORIGIN")
    disable_web_auth = os.environ.get("ALLINONE_DISABLE_WEB_AUTH", "0") in ("1", "true")
    admin_password_file = None if disable_web_auth else os.environ.get("HELPER_ADMIN_PASSWORD_FILE")
    admin_password = Path(admin_password_file).read_text().strip() if admin_password_file else None
    if admin_password is not None and (len(admin_password) < 16 or not admin_password.isascii()):
        raise ValueError("Admin password must contain at least 16 ASCII characters.")
    admin_origin = configured_origin or f"http://{allowed_host}"
    parsed_origin = urlsplit(admin_origin)
    if (parsed_origin.scheme not in ("http", "https") or not parsed_origin.hostname
            or parsed_origin.username or parsed_origin.password or parsed_origin.path
            or parsed_origin.query or parsed_origin.fragment):
        raise ValueError("HELPER_ADMIN_ORIGIN must be an exact HTTP(S) origin without a trailing slash.")
    if configured_origin and parsed_origin.hostname != "127.0.0.1" and not disable_web_auth:
        if not admin_password or not os.environ.get("HELPER_VNC_PASSWORD_FILE"):
            raise ValueError("Remote admin requires admin and VNC password files.")
    browser_origin = os.environ.get("HELPER_BROWSER_ORIGIN", "http://127.0.0.1:6080")
    browser_location = urlsplit(browser_origin)
    if (browser_location.scheme not in ("http", "https") or not browser_location.hostname
            or browser_location.username or browser_location.password or browser_location.path
            or browser_location.query or browser_location.fragment):
        raise ValueError("HELPER_BROWSER_ORIGIN must be an exact HTTP(S) origin.")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def authenticated(self):
            if admin_password is None:
                return True
            expected = "Basic " + base64.b64encode(("admin:" + admin_password).encode()).decode()
            if hmac.compare_digest(self.headers.get("Authorization", "").encode(), expected.encode()):
                return True
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="Tolino Bridge", charset="UTF-8"')
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return False

        def send(self, code, body, content_type="application/json", cookie=False):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy",
                             "default-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'")
            if cookie:
                secure = "; Secure" if admin_origin.startswith("https:") else ""
                self.send_header("Set-Cookie", f"session={session}; HttpOnly; SameSite=Strict; Path=/{secure}")
            self.end_headers()
            self.wfile.write(body)

        def valid_host(self):
            return self.headers.get("Host") == (parsed_origin.netloc if configured_origin else allowed_host)

        def paired(self):
            cookie = SimpleCookie()
            try:
                cookie.load(self.headers.get("Cookie", ""))
            except CookieError:
                return False
            value = cookie.get("session")
            return value is not None and hmac.compare_digest(value.value.encode(), session.encode())

        def do_GET(self):
            if not self.valid_host() or self.headers.get("Sec-Fetch-Site") == "cross-site":
                return self.send(403, b'{"error":"forbidden"}')
            if not self.authenticated():
                return
            if self.path == "/":
                return self.send(200, (ASSET_DIR / "dashboard.html").read_bytes(),
                                 "text/html; charset=utf-8", cookie=True)
            if not self.paired():
                return self.send(403, b'{"error":"unpaired"}')
            parsed = urlsplit(self.path)
            if parsed.path in ("/cover", "/download"):
                try:
                    query = parse_qs(parsed.query, strict_parsing=True)
                    if set(query) != {"id"} or len(query["id"]) != 1:
                        raise APIError(400, "Exactly one book ID required.")
                    if parsed.path == "/cover":
                        output, size, content_type = companion.cover(query["id"][0])
                    else:
                        output, size = companion.download(query["id"][0])
                        content_type = EPUB
                    with output:
                        self.send_response(200)
                        self.send_header("Content-Type", content_type)
                        self.send_header("Content-Length", str(size))
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("X-Content-Type-Options", "nosniff")
                        if parsed.path == "/download":
                            self.send_header("Content-Disposition", companion.download_disposition(query["id"][0]))
                        self.end_headers()
                        while chunk := output.read(64 * 1024):
                            self.wfile.write(chunk)
                    return
                except (BrokenPipeError, ConnectionResetError):
                    print("Client disconnected during asset transfer; no further response sent.", file=sys.stderr)
                    return
                except APIError as error:
                    return self.send(error.status, json.dumps({"error": str(error)}).encode())
                except (ValueError, KeyError, TypeError, OSError, requests.RequestException):
                    return self.send(502, b'{"error":"Provider asset unavailable or invalid request."}')
            if self.path == "/app.js":
                return self.send(200, (ASSET_DIR / "dashboard.js").read_bytes(), "text/javascript")
            if self.path == "/display.js":
                return self.send(200, (ASSET_DIR / "display.js").read_bytes(), "text/javascript")
            if self.path == "/app.css":
                return self.send(200, (ASSET_DIR / "dashboard.css").read_bytes(), "text/css")
            if self.path == "/connection":
                return self.send(200, json.dumps({
                    "apiKey": companion.key,
                    "apiPort": 8081,
                    "publicUrl": os.environ.get("HELPER_PUBLIC_URL", "http://YOUR-DOCKER-HOST:8081"),
                    "browserUrl": browser_origin + "/vnc.html?autoconnect=true&resize=scale",
                }).encode())
            if self.path == "/status":
                return self.send(200, json.dumps({
                    **state.snapshot(), "readingVersion": companion.reading_version,
                    "lastSyncWrite": companion.last_sync_write,
                }).encode())
            return self.send(404, b'{"error":"not found"}')

        def do_POST(self):
            if not self.authenticated():
                return
            if (not self.valid_host() or not self.paired()
                    or self.headers.get("Origin") != (admin_origin if configured_origin else f"http://{allowed_host}")
                    or self.headers.get("Content-Type") != "application/json"):
                return self.send(403, b'{"error":"forbidden"}')
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 16384:
                    raise ValueError("Invalid size")
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError("Expected object")
                if self.path == "/reading-progress":
                    if data:
                        raise ValueError("No reading-progress parameters accepted")
                    return self.send(200, json.dumps(companion.reading_progress(), allow_nan=False).encode())
                elif self.path == "/login":
                    username, password = data.get("username"), data.get("password")
                    if (not isinstance(username, str) or not username.strip()
                            or len(username) > 320 or "/" in username or "\\" in username
                            or not isinstance(password, str) or not password):
                        raise ValueError("Invalid credentials")
                    remember = data.get("rememberCredentials", False)
                    if not isinstance(remember, bool) or (remember and not state.store):
                        raise ValueError("Persistent storage required for saving credentials")
                    accepted = state.begin(username.strip(), password, remember) if remember else state.begin(username.strip(), password)
                elif self.path == "/reload":
                    accepted = state.begin()
                elif self.path == "/forget":
                    if data:
                        raise ValueError("No parameters accepted")
                    state.forget()
                    return self.send(200, b'{"forgotten":true}')
                else:
                    return self.send(404, b'{"error":"not found"}')
            except APIError as error:
                return self.send(error.status, json.dumps({"error": str(error)}).encode())
            except requests.RequestException:
                return self.send(502, b'{"error":"Cloud-Lesestand nicht erreichbar. Verbindung und Anmeldung pruefen."}')
            except OSError:
                return self.send(503, b'{"error":"Lokaler Speicher nicht verfuegbar. Datenvolume und Rechte pruefen."}')
            except (ValueError, UnicodeDecodeError):
                return self.send(400, b'{"error":"invalid input"}')
            return self.send(202 if accepted else 409, b'{"accepted":' + (b"true" if accepted else b"false") + b"}")

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    allowed_host = f"127.0.0.1:{server.server_port}"
    server.state = state
    server.companion = companion
    return server


def wait_for_port(port, process):
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError(f"Desktop service on port {port} exited.")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.1)
    raise TimeoutError(f"Desktop service on port {port} did not become ready.")


def main():
    logging.disable(logging.CRITICAL)
    # SeleniumBase's documented option prevents a second, invisible Xvfb display.
    sys.argv.append("--headed")
    home = Path(os.environ["HOME"])
    home.mkdir(parents=True, exist_ok=True)
    os.chdir(home)
    processes = []
    stop = threading.Event()
    try:
        processes.append(subprocess.Popen(["Xvfb", ":99", "-screen", "0", "1280x900x24", "-nolisten", "tcp"],
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        for _ in range(100):
            if Path("/tmp/.X11-unix/X99").exists():
                break
            if processes[0].poll() is not None:
                raise RuntimeError("Virtual display exited.")
            time.sleep(0.1)
        else:
            raise TimeoutError("Virtual display did not become ready.")
        password_file = (None if os.environ.get("ALLINONE_DISABLE_WEB_AUTH", "0") in ("1", "true")
                         else os.environ.get("HELPER_VNC_PASSWORD_FILE"))
        if password_file:
            password = Path(password_file).read_text().strip()
            if len(password) != 8 or not password.isascii() or any(char.isspace() for char in password):
                raise ValueError("VNC password must contain exactly 8 non-whitespace ASCII characters.")
            vnc_auth = ["-passwdfile", password_file]
            password = None
        else:
            vnc_auth = ["-nopw"]
        processes.append(subprocess.Popen(
            ["x11vnc", "-display", ":99", "-localhost", *vnc_auth, "-forever", "-shared", "-rfbport", "5900"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        wait_for_port(5900, processes[-1])
        processes.append(subprocess.Popen(
            ["websockify", "--web=/usr/share/novnc", "--file-only",
             "--auth-plugin=ExpectOrigin", "--auth-source=" + os.environ.get("HELPER_BROWSER_ORIGIN", "http://127.0.0.1:6080"),
             "6080", "127.0.0.1:5900"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        wait_for_port(6080, processes[-1])
        print("Tolino Bridge started. Use the configured admin origin; never publish without authentication.", flush=True)
        with create_server() as server:
            with create_api_server(server.companion) as api_server:
                threading.Thread(target=api_server.serve_forever, daemon=True).start()
                server.state.restore()
                maintenance = threading.Thread(target=server.state.maintain, args=(stop,), daemon=True)
                maintenance.start()
                try:
                    server.serve_forever()
                finally:
                    stop.set()
                    api_server.shutdown()
    finally:
        for process in reversed(processes):
            process.terminate()
        for process in processes:
            process.wait(timeout=10)


if __name__ == "__main__":
    main()
