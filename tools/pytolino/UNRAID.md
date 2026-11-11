# Tolino Bridge on Unraid / a Linux Docker host

The production image builds independently: no previously built probe image,
Node server or desktop browser on the host is required. Chromium, its virtual
desktop, the dashboard and the keyed plugin API run inside the container.
Unraid hardware itself has not been tested; the image and LAN-auth configuration
have automated Docker tests. Use current source containing these files, not
an older published checkout.

## 1. Build the image

From the project checkout on the Docker host:

```sh
docker build -f tools/pytolino/Dockerfile.login \
  -t crosspoint-pytolino-login:local tools/pytolino
```

Alternatively build on another machine and transfer the image with
`docker save` / `docker load` (the CPU architecture must match Unraid, usually
`linux/amd64`). Do not export a running, logged-in container.

## 2. Create private persistent storage and secrets

Run on Unraid as root, using the actual appdata location on your system:

```sh
mkdir -p /mnt/user/appdata/tolino-bridge/data
mkdir -p /mnt/user/appdata/tolino-bridge/secrets
chown 65534:65534 /mnt/user/appdata/tolino-bridge/data
chown 65534:65534 /mnt/user/appdata/tolino-bridge/secrets
chmod 700 /mnt/user/appdata/tolino-bridge/data
chmod 700 /mnt/user/appdata/tolino-bridge/secrets

docker run --rm \
  -v /mnt/user/appdata/tolino-bridge/secrets:/secrets \
  --entrypoint python crosspoint-pytolino-login:local /app/setup_storage.py
```

The initializer creates four random files, does not print their contents and
**never overwrites existing files**:

| Secret file | Purpose |
|---|---|
| `helper-api-key` | Stable Bearer key for the CrossPoint plugin |
| `storage-key` | Fernet encryption key for saved login data |
| `admin-password` | Dashboard HTTP Basic password; username is `admin` |
| `vnc-password` | Separate eight-character VNC password for the browser desktop |

Use the Unraid host's local terminal/file tooling to read your admin and VNC
passwords privately when needed; never paste them into chat or public logs.
Keep this directory private, not SMB-exported. Store backups of the encryption
key separately from encrypted data. Unraid's permission-reset tools must not
make these files public. The container runs as UID/GID `65534:65534`; files
must remain readable/writable by that identity as appropriate.

## 3a. Run with Docker Compose

The Compose Manager plugin is optional; ordinary Docker Compose works too.
From this project's checkout:

```sh
export BRIDGE_HOST=192.168.1.10
export BRIDGE_BIND_ADDRESS=192.168.1.10
export BRIDGE_ROOT=/mnt/user/appdata/tolino-bridge
docker compose -f tools/pytolino/compose.unraid.yaml up -d --no-build
```

Replace the IP with Unraid's LAN IP (or a stable DNS name in `BRIDGE_HOST`;
`BRIDGE_BIND_ADDRESS` must be a local IP). Persist those variables in your
Compose Manager configuration or a private environment file passed with
`--env-file`; shell exports do not survive a new terminal.
Do not use host networking. If any host port is occupied, edit its publication
and the matching public origin together; container ports remain unchanged.

## 3b. Unraid "Add Container" without Compose

Use repository/image `crosspoint-pytolino-login:local`, Bridge network, and:

| Mapping | Host | Container |
|---|---|---|
| Dashboard TCP | `8080` | `8080` |
| Browser TCP | `6080` | `6080` |
| Plugin API TCP | `8081` | `8081` |
| Read/write path | `/mnt/user/appdata/tolino-bridge/data` | `/data` |
| Read-only path | `/mnt/user/appdata/tolino-bridge/secrets` | `/secrets` |

Set these environment variables, replacing the IP:

```text
HELPER_ADMIN_ORIGIN=http://192.168.1.10:8080
HELPER_BROWSER_ORIGIN=http://192.168.1.10:6080
HELPER_PUBLIC_URL=http://192.168.1.10:8081
HELPER_DATA_DIR=/data
HELPER_STORAGE_KEY_FILE=/secrets/storage-key
HELPER_API_KEY_FILE=/secrets/helper-api-key
HELPER_ADMIN_PASSWORD_FILE=/secrets/admin-password
HELPER_VNC_PASSWORD_FILE=/secrets/vnc-password
```

Extra Parameters:

```text
--init --shm-size=512m --tmpfs /tmp:rw,nosuid,size=1g --cap-drop=ALL --security-opt=no-new-privileges:true --restart=unless-stopped
```

Set WebUI to `http://[IP]:[PORT:8080]/`. Leave privileged mode **off**. Do not
mount the Docker socket. All origins must be exact, without trailing `/`;
Host/Origin checks intentionally reject other names.

## 4. Login and download to CrossPoint

1. Open `http://UNRAID-IP:8080/`; sign in as `admin` with `admin-password`.
2. Enter Thalia credentials. Germany and Thalia.de are selected automatically.
   If a security/cookie prompt requires confirmation, open the container browser
   through the dashboard and enter `vnc-password`. It is not the admin password.
3. Session tokens are encrypted on the data volume and automatically refreshed.
   Optionally check **Zusätzlich Zugangsdaten verschlüsselt speichern** before
   submitting to permit one automatic password login when refresh is rejected.
   Challenges can still require manual interaction.
4. On CrossPoint enable Plugins and keep **File Transfer** running. Open the
   **reader's** `/plugins` page in a browser. Install this project's four
   packaged plugin files into `/.crosspoint/plugins/tolino-sync/` on SD first.
5. In the plugin select Docker helper, set `http://UNRAID-IP:8081` and the API
   key revealed in the helper dashboard, save, then **Load cloud library**.
6. For native use, leave File Transfer and open **Home > Plugins > Thalia / Tolino**.
   Open a book's details and choose **Fetch**. Books download directly to
   `/Books/Tolino` (or your configured folder), without a browser or File Transfer.
   `device.json` must be installed; save the connection again after upgrading.
   Alternatively **Download EPUB to reader SD** in the browser writes via the
   firmware. For that browser path, keep File Transfer and the page open until completion.
   The helper dashboard's **EPUB laden** downloads to the computer instead.
   Adobe DRM/ACSM/PDF are not supported; no DRM is removed.

An unkeyed request to `http://UNRAID-IP:8081/api/status` must return **401**.
After container restart, the dashboard should restore the saved session and
reload books without password entry. Startup network/provider failures are
visible; use **Bibliothek aktualisieren** to retry a restored session.
The dashboard/plugin remain read-only for cloud positions. For exact manual
reader sync, use the [optional CrossPoint Sync server connector](../crosspoint-sync/README.md),
including its supplemental Docker Compose file. Cloud writes default to disabled
and require explicit helper/connector opt-in; normal book opening does not
automatically import a position.

## Security, maintenance and recovery

- **Trusted LAN only.** HTTP exposes admin credentials, Thalia credentials and
  API keys in transit. VNC's legacy eight-character password is not encryption
  and is not sufficient protection for an untrusted network. Never port-forward
  these ports; use a VPN or HTTPS/WSS reverse proxy for other networks.
- For a TLS proxy, configure `HELPER_ADMIN_ORIGIN`, `HELPER_BROWSER_ORIGIN` and
  `HELPER_PUBLIC_URL` to their actual external origins, forward Host unchanged,
  support WebSockets, and expose container ports only to the proxy. The browser
  origin needs its own root noVNC site, not a path prefix.
- The data record is encrypted, but administrators with both data and key can
  decrypt tokens/passwords. Never include secrets or live profiles in an image.
- Update by rebuilding and recreating the container with the **same data and
  secrets**. Do not regenerate the storage key or helper API key during updates.
- Invalid/wrong keys produce an explicit dashboard error. Restore the original
  key or use **Gespeicherte Anmeldung löschen** and sign in again.
- Revoked refresh tokens require a fresh login unless credential storage was
  explicitly enabled. Auto-login is bounded; it never repeatedly submits a
  failing password. Forgetting the login does not revoke Thalia sessions.
- `docker compose -f tools/pytolino/compose.unraid.yaml down` stops the service
  without deleting the bind-mounted appdata. Never remove appdata merely to
  update the image.
