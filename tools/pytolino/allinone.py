"""Supervise the browser bridge and Sync together, without logging credentials."""

import base64
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from urllib.parse import urlsplit


def healthcheck():
    key = Path(os.environ["HELPER_API_KEY_FILE"]).read_text().strip()
    password = Path(os.environ["HELPER_ADMIN_PASSWORD_FILE"]).read_text().strip()
    for port, endpoint, origin, authorization in (
        (8080, "/", os.environ["HELPER_ADMIN_ORIGIN"],
         "Basic " + base64.b64encode(("admin:" + password).encode()).decode()),
        (8081, "/api/status", os.environ["HELPER_PUBLIC_URL"], "Bearer " + key),
        (8082, os.environ.get("SYNC_BASE_PATH", "").rstrip("/") + "/healthz", "", ""),
    ):
        headers = {}
        if origin:
            headers["Host"] = urlsplit(origin).netloc
        if authorization:
            headers["Authorization"] = authorization
        request = urllib.request.Request(f"http://127.0.0.1:{port}{endpoint}", headers=headers)
        with urllib.request.urlopen(request, timeout=2) as response:
            if response.status != 200:
                raise RuntimeError(f"Service on port {port} is not healthy.")
            if port == 8082 and json.load(response).get("status") != "ok":
                raise RuntimeError("Sync health response is invalid.")
    for port in (5900, 6080):
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass


def supervise(services, check, startup_timeout=180, interval=5, stop=None):
    stop = stop or threading.Event()
    processes = []
    healthy = False
    failures = 0
    deadline = time.monotonic() + startup_timeout
    try:
        for name, command, cwd, env in services:
            processes.append((name, subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True)))
        while not stop.is_set():
            for name, process in processes:
                if process.poll() is not None:
                    raise RuntimeError(f"{name} exited unexpectedly (code {process.returncode}).")
            try:
                check()
            except (OSError, ValueError, RuntimeError) as error:
                failures += 1
                if (healthy and failures >= 3) or time.monotonic() >= deadline:
                    raise RuntimeError("Combined service health checks failed; stopping all services.") from error
            else:
                if not healthy:
                    print("All-in-one bridge and Sync are ready.", flush=True)
                healthy = True
                failures = 0
            stop.wait(interval)
    finally:
        for _, process in processes:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 10
        for _, process in processes:
            try:
                process.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                pass
        # A terminated parent can leave browser/display descendants in its group.
        for _, process in processes:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def main():
    if sys.argv[1:] == ["--healthcheck"]:
        healthcheck()
        return
    key = Path(os.environ["SYNC_STORAGE_KEY_FILE"]).read_text().strip()
    if not re.fullmatch(r"[0-9a-fA-F]{64}", key):
        raise ValueError("Sync storage key must be 64 hexadecimal characters.")
    for folder in ("/data/bridge", "/data/sync"):
        Path(folder).mkdir(mode=0o700, parents=True, exist_ok=True)
    bridge_env = dict(os.environ, HELPER_DATA_DIR="/data/bridge")
    sync_env = dict(
        os.environ, TOKEN_ENC_KEY=key, DATABASE_PATH="/data/sync/crosspoint.db",
        PORT="8082", WEB_APP_DIR="/app/sync/web", LISTEN_ADDRESS="::",
        TOLINO_HELPER_URL="http://127.0.0.1:8081",
        ALLOW_HTTP_LOCALHOST=os.environ.get("SYNC_ALLOW_HTTP_LOCALHOST", "1"),
        TRUST_PROXY=os.environ.get("SYNC_TRUST_PROXY", "0"),
        REGISTRATION_DISABLED=os.environ.get("SYNC_REGISTRATION_DISABLED", "0"),
        BASE_PATH=os.environ.get("SYNC_BASE_PATH", ""),
    )
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    supervise([
        ("Browser bridge", [sys.executable, "/app/login_server.py"], "/app", bridge_env),
        ("Sync", ["node", "dist/index.js"], "/app/sync", sync_env),
    ], healthcheck, stop=stop)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError):
        print("All-in-one startup/health failure. Check service logs and mounted configuration/secrets.", file=sys.stderr)
        sys.exit(1)
