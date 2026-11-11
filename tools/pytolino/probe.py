"""Read-only, interactive pytolino token probe; never uses GUI auto-login."""

import argparse
import contextlib
import getpass
import importlib.metadata
import io
import logging
import os
import signal
import sys
from pathlib import Path


def new_client():
    from pytolino.tolino_cloud import Client

    return Client(username="local-token-probe", server_name="thalia")


def library_count(inventory):
    if not isinstance(inventory, list):
        raise ValueError("Unexpected pytolino inventory shape; expected a book list.")
    return len(inventory)


def request_timeout(_signal, _frame):
    raise TimeoutError("Cloud request exceeded the probe deadline.")


def load_library(client, refresh_token, hardware_id):
    if not all(
        isinstance(value, str)
        and value
        and len(value) <= 32768
        and not any(ord(char) <= 32 or ord(char) == 127 for char in value)
        for value in (refresh_token, hardware_id)
    ):
        raise ValueError("Session fields must be nonempty and contain no whitespace.")
    client.import_token(refresh_token, hardware_id)
    if not isinstance(client.access_token, str) or not client.access_token:
        raise RuntimeError("pytolino did not obtain an access token.")
    return library_count(client.get_inventory())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Offline package/configuration check; no account requests.")
    args = parser.parse_args()
    logging.disable(logging.CRITICAL)
    Path(os.environ.get("HOME", "/tmp/pytolino")).mkdir(parents=True, exist_ok=True)
    print("pytolino", importlib.metadata.version("pytolino"), "- Thalia read-only token probe")
    if not args.check and not sys.stdin.isatty():
        print("Error: an interactive terminal is required for hidden token entry.", file=sys.stderr)
        return 2
    try:
        # Upstream prints cache errors and may log request bodies; do not retain them.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            client = new_client()
        print("Installed upstream Thalia reseller ID:", client._partner_id, "(unchanged)")
        if args.check:
            print("Thalia client initialized. Offline check only; no login or library access verified.")
            return 0
        print("Use a fresh webreader session. Never paste tokens into chat or command arguments.")
        print("Refresh-token rotation can affect that webreader session. No password is requested.")
        refresh_token = getpass.getpass("Refresh token (hidden): ").strip()
        hardware_id = getpass.getpass("Hardware ID (hidden): ").strip()
        print("Refreshing session and requesting library (120-second limit)...")
        signal.signal(signal.SIGALRM, request_timeout)
        signal.alarm(120)
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                count = load_library(client, refresh_token, hardware_id)
        finally:
            signal.alarm(0)
        print(f"SUCCESS: {count} real cloud books returned by pytolino. Titles and tokens are not printed.")
        return 0
    except KeyboardInterrupt:
        print("\nProbe cancelled.", file=sys.stderr)
        return 130
    except Exception as error:
        print(
            f"FAILED ({type(error).__name__}): no successful library access confirmed. "
            "Upstream error text is suppressed because it may contain tokens or request data. "
            "Check session validity, network connectivity and provider availability.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
