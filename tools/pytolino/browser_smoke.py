"""Exercise upstream browser credential entry against a local synthetic form only."""

import concurrent.futures
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import sys
import threading
from unittest.mock import patch

class Fixture(BaseHTTPRequestHandler):
    steps = []
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.steps.append(self.path)
        if self.path == "/":
            return self.respond(b"""<button onclick="location.href='/reseller'">Deutschland</button>""", "text/html")
        if self.path == "/reseller":
            return self.respond(b"""<button onclick="location.href='/signin'"><div data-test-id="ftu-resellerLogo-3">Thalia DE</div></button>""", "text/html")
        if self.path == "/signin":
            return self.respond(b"""<button data-test-id="library-drawer-buttonLogin" onclick="location.href='/form'">Anmelden</button>""", "text/html")
        if self.path == "/token":
            body = json.dumps({"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"}).encode()
            return self.respond(body, "application/json")
        if self.path == "/v1/devices/12345678-1234-1234-1234-123456789abc/userid":
            return self.respond(b'{"PublicationInventory":{"ebook":[],"edata":[]}}', "application/json")
        body = b"""<!doctype html><title>Synthetic login only</title>
<form onsubmit="event.preventDefault();setTimeout(async () => {
const token=await (await fetch('/token')).json();
await fetch('/v1/devices/12345678-1234-1234-1234-123456789abc/userid', {headers:{
t_auth_token:token.access_token,reseller_id:'3'}});
},300)">
<input id="email-input" name="username"><input id="password-input" name="password" type="password">
<button type="submit">Synthetic submit</button></form>"""
        self.respond(body, "text/html")

    def respond(self, body, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    home = Path(os.environ["HOME"])
    home.mkdir(parents=True, exist_ok=True)
    os.chdir(home)
    from thalia_client import ThaliaClient, WebreaderSession

    sys.argv.append("--headed")
    with ThreadingHTTPServer(("127.0.0.1", 0), Fixture) as server:
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        try:
            client = ThaliaClient(username="synthetic@example.invalid")
            origin = f"http://127.0.0.1:{server.server_port}"
            client.webreader_url = origin + "/"
            client.login_origin = origin
            with patch.object(WebreaderSession, "token_url", origin + "/token"), \
                    patch.object(WebreaderSession, "api_origin", origin), \
                    patch.object(ThaliaClient, "is_webreader_return", side_effect=lambda url: url.startswith(origin + "/")):
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    pool.submit(client.login, "synthetic-password").result(timeout=90)
            assert client.access_token == "synthetic-access"
            assert client.refresh_token == "synthetic-refresh"
            assert client.hardware_id == "12345678-1234-1234-1234-123456789abc"
            assert client._partner_id == "3"
            assert all(path in Fixture.steps for path in ("/reseller", "/signin", "/form", "/token"))
            print("PASS: real browser network events transfer tokens and matching successful hardware headers.")
            print("PASS: Germany, Thalia and provider login are selected automatically on the synthetic pages.")
            print("Synthetic local form only; no Thalia account or remote OAuth tested.")
        finally:
            server.shutdown()
            worker.join()


if __name__ == "__main__":
    main()
