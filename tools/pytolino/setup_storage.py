"""Initialize mounted secret files without overwriting existing keys or printing them."""

import os
from pathlib import Path
import secrets

from cryptography.fernet import Fernet


def main():
    directory = Path("/secrets")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    values = {"helper-api-key": secrets.token_hex(32), "storage-key": Fernet.generate_key().decode(),
              "admin-password": secrets.token_urlsafe(32), "vnc-password": secrets.token_hex(4)}
    for name, value in values.items():
        path = directory / name
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            print(f"Preserved existing {name}.")
            continue
        with os.fdopen(descriptor, "w") as output:
            output.write(value + "\n")
        print(f"Created {name}; value is not printed.")
    print("Initialization complete. Keep secrets separate from encrypted data backups.")


if __name__ == "__main__":
    main()
