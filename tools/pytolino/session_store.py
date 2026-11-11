"""Authenticated encryption for session secrets; the key lives outside the data volume."""

import json
import os
from pathlib import Path
import tempfile
import threading

from cryptography.fernet import Fernet, InvalidToken


class SessionStore:
    def __init__(self, directory, key_file):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = self.directory / "session.enc"
        self.cipher = Fernet(Path(key_file).read_bytes().strip())
        self.lock = threading.Lock()

    def load(self):
        with self.lock:
            if not self.path.exists():
                return {"session": None, "credentials": None}
            if self.path.stat().st_size > 131072:
                raise ValueError("Stored login exceeds the size limit.")
            try:
                value = json.loads(self.cipher.decrypt(self.path.read_bytes()))
            except (InvalidToken, ValueError, UnicodeError) as error:
                raise ValueError("Stored login cannot be decrypted; check the storage key or forget the saved login.") from error
            if not isinstance(value, dict) or set(value) != {"session", "credentials"}:
                raise ValueError("Invalid stored login structure.")
            return value

    def save(self, session, credentials):
        encrypted = self.cipher.encrypt(json.dumps(
            {"session": session, "credentials": credentials}, allow_nan=False).encode())
        if len(encrypted) > 131072:
            raise ValueError("Stored login exceeds the size limit.")
        with self.lock:
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=self.directory, prefix=".session-", delete=False) as output:
                    temporary = Path(output.name)
                    os.fchmod(output.fileno(), 0o600)
                    output.write(encrypted)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, self.path)
                descriptor = os.open(self.directory, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)

    def clear(self):
        self.save(None, None)
