# All-in-one Tolino Bridge on Unraid

This guide uses **one container** for Thalia browser login, the library/API
and CrossPoint Sync with the exact-position Tolino connector. No separate
Sync container or Node installation on Unraid is required.

Image: `ghcr.io/artifactdev/crosspoint-tolino-bridge:main`.
The image must first be published by this repository's Docker Actions workflow.
For production, select a tested version tag or digest instead of the moving
`main` tag. The workflow targets AMD64 and ARM64; the combined runtime has
been tested locally on ARM64, not on an actual Unraid installation.

The old `compose.unraid.yaml` and `Dockerfile.login` describe the legacy
bridge-only deployment. Do not use them for this all-in-one installation.
For migrations, read the
[two-container migration instructions](DEPLOYMENT.md#migrating-an-existing-two-container-installation)
before starting. Do not point the new container at an old flat `/data` layout.

## 1. Image access and persistent paths

If GHCR requires authentication, first follow
[private image access](DEPLOYMENT.md#prepare-a-host-and-private-image-access).
Authenticate Docker on Unraid with a package-readable GitHub account; do not
put a GitHub token in the container template or its environment.

Run these commands in the Unraid terminal **as root**, replacing the appdata
location if your server uses a different path:

```sh
docker pull ghcr.io/artifactdev/crosspoint-tolino-bridge:main
mkdir -p /mnt/user/appdata/tolino-bridge/data
mkdir -p /mnt/user/appdata/tolino-bridge/secrets
chown 65534:65534 /mnt/user/appdata/tolino-bridge/data \
  /mnt/user/appdata/tolino-bridge/secrets
chmod 700 /mnt/user/appdata/tolino-bridge/data \
  /mnt/user/appdata/tolino-bridge/secrets
chmod 700 /mnt/user/appdata/tolino-bridge
chown 65534:65534 /mnt/user/appdata/tolino-bridge

docker run --rm \
  -v /mnt/user/appdata/tolino-bridge/secrets:/secrets \
  --entrypoint python ghcr.io/artifactdev/crosspoint-tolino-bridge:main \
  /app/setup_storage.py

docker run --rm \
  -v /mnt/user/appdata/tolino-bridge/secrets:/secrets \
  --entrypoint python ghcr.io/artifactdev/crosspoint-tolino-bridge:main \
  -c 'import os,secrets; fd=os.open("/secrets/sync-storage-key",os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600); f=os.fdopen(fd,"w"); f.write(secrets.token_hex(32)+"\n"); f.close()'
```

The initializer preserves existing bridge secrets. The final command creates
the fifth secret exclusively and fails if it already exists; skip that command
on subsequent starts. **Never generate replacement encryption keys for existing
data.** None of these commands prints secret values.

| Host path | Purpose |
|---|---|
| `/mnt/user/appdata/tolino-bridge/data/bridge` | Encrypted provider session and bridge data |
| `/mnt/user/appdata/tolino-bridge/data/sync` | Sync SQLite database, accounts and connector records |
| `/mnt/user/appdata/tolino-bridge/secrets/helper-api-key` | Plugin/connector API key |
| `/mnt/user/appdata/tolino-bridge/secrets/storage-key` | Bridge encryption key |
| `/mnt/user/appdata/tolino-bridge/secrets/admin-password` | Dashboard password; username `admin` |
| `/mnt/user/appdata/tolino-bridge/secrets/vnc-password` | Separate eight-character browser/VNC password |
| `/mnt/user/appdata/tolino-bridge/secrets/sync-storage-key` | Sync credential encryption key |

The container creates `data/bridge` and `data/sync` beneath the appdata root.
All application
processes run as **UID/GID 65534:65534**, not Unraid's usual 99:100.
Do not add `PUID`/`PGID` variables; the image does not implement them.
Keep appdata/secrets private and excluded from SMB exports. Do not let Unraid
permission-reset tools make the secrets world-readable. Back up the stable
keys separately from encrypted data.

## 2. Unraid Docker tab: Add Container

Enable **Advanced View** to enter Extra Parameters.

| Setting | Value |
|---|---|
| Name | `crosspoint-tolino-bridge` |
| Repository | `ghcr.io/artifactdev/crosspoint-tolino-bridge:main` |
| Network Type | `Bridge` |
| Privileged | **Off** |
| WebUI | `http://[IP]:[PORT:8080]/` |
| Console shell | `Shell` |

Do not use Host networking, override the image entrypoint, or mount the Docker
socket. Enable Unraid's **Autostart** for this container after checking setup.

### Port mappings

Add these four **TCP** port mappings. The example uses high host ports to
avoid common Unraid/container conflicts; container ports must remain unchanged.
Replace `192.168.1.10` throughout this guide with your Unraid LAN IP.

| Name | Host port | Container port | Purpose / example URL |
|---|---:|---:|---|
| Dashboard | `18080` | `8080` | `http://192.168.1.10:18080/` |
| Login browser | `16080` | `6080` | `http://192.168.1.10:16080/vnc.html` |
| Plugin API | `18081` | `8081` | Plugin origin `http://192.168.1.10:18081` |
| CrossPoint Sync | `18082` | `8082` | `http://192.168.1.10:18082/app/` |

Do **not** publish internal VNC port 5900. If a host port is occupied, choose
another and update the matching public origin and client URL. For example,
changing host dashboard port 18080 requires changing `HELPER_ADMIN_ORIGIN`;
the internal dashboard still listens on 8080.

### Single path mapping

Use **Add another Path, Port, Variable, Label or Device > Path**:

| Name | Host path | Container path | Access mode |
|---|---|---|---|
| Application configuration and data | `/mnt/user/appdata/tolino-bridge` | `/config` | Read/Write |

Only this one persistent mapping is needed. The existing host `data/` and
`secrets/` subdirectories are preserved; there is no need to move their contents.
Do not also add `/data` or `/secrets` mappings, and do not map appdata to `/app`,
which would hide the installed application. The initialization commands above
use a temporary `/secrets` mount solely to create files; this is not an
additional mapping in the running Unraid template.

**Trade-off:** with one read/write root mount, secrets are writable by the
container. File permissions still restrict host access, but this is not the
read-only mount protection of the general Compose deployment. For that stricter
layout, keep separate `/data` read/write and `/secrets` read-only mappings,
omit `ALLINONE_DATA_DIR`, and use `/secrets/...` for secret-file variables.
The [general registry deployment](DEPLOYMENT.md) retains separate secret mounts.

### Environment variables

Add each row as a **Variable**, using the key exactly as shown:

| Key | Example value |
|---|---|
| `HELPER_ADMIN_ORIGIN` | `http://192.168.1.10:18080` |
| `HELPER_BROWSER_ORIGIN` | `http://192.168.1.10:16080` |
| `HELPER_PUBLIC_URL` | `http://192.168.1.10:18081` |
| `ALLINONE_DATA_DIR` | `/config/data` |
| `HELPER_STORAGE_KEY_FILE` | `/config/secrets/storage-key` |
| `HELPER_API_KEY_FILE` | `/config/secrets/helper-api-key` |
| `HELPER_ADMIN_PASSWORD_FILE` | `/config/secrets/admin-password` |
| `HELPER_VNC_PASSWORD_FILE` | `/config/secrets/vnc-password` |
| `SYNC_STORAGE_KEY_FILE` | `/config/secrets/sync-storage-key` |
| `HELPER_SYNC_WRITES` | `0` initially; `1` only after explicit setup |
| `SYNC_ALLOW_HTTP_LOCALHOST` | `1` for the default loopback exception; **does not authorize LAN HTTP credentials** |
| `SYNC_ALLOW_INSECURE_HTTP` | `0` by default; optional `1` explicitly permits unencrypted connector credentials on a trusted LAN |
| `ALLINONE_DISABLE_WEB_AUTH` | `0` by default; optional `1` removes dashboard, noVNC and hosted Sync app login; trusted isolated LAN only |
| `SYNC_WEB_AUTH_USER` | Required when disabling web auth: exact username of an existing Sync account to open automatically |
| `SYNC_WEB_AUTH_ORIGIN` | Required when disabling web auth: exact Sync origin, e.g. `http://192.168.8.3:18082` (no path or trailing slash) |
| `SYNC_TRUST_PROXY` | `0`; use `1` only behind an isolated trusted TLS proxy |
| `SYNC_REGISTRATION_DISABLED` | `0` for first account creation; change to `1` afterward |
| `SYNC_BASE_PATH` | Empty; use a prefix only with matching proxy/client configuration |

Origins must match the browser/client-visible **scheme, hostname and host
port**, without a trailing slash or path. Do not use `localhost` for a physical
reader. Host/Origin checks intentionally reject mismatched dashboard addresses.
The secret-file variables refer to **container** paths, not Unraid host paths.

Do not set `PORT`, `DATABASE_PATH`, `TOKEN_ENC_KEY` or `TOLINO_HELPER_URL`:
the supervisor sets Sync port 8082, its database under `/config/data/sync` and the
internal helper address `http://127.0.0.1:8081`, and reads the key from its file.
It also sets `HELPER_DATA_DIR` to `/config/data/bridge`; do not override it.

### Extra Parameters

```text
--init --stop-timeout=30 --shm-size=512m --tmpfs /tmp:rw,nosuid,size=1g --cap-drop=ALL --security-opt=no-new-privileges:true --restart=unless-stopped
```

Apply the template and wait for Docker health status **healthy**. The first
startup may take up to three minutes. The supervisor stops all services if
a child exits or health checks repeatedly fail; Docker restarts the container.

## 3. First login and reader configuration

1. Open `http://192.168.1.10:18080/`. Read `admin-password` privately in the
   Unraid terminal and sign in as `admin`. Never post passwords, keys, tokens
   or unredacted logs in chat.
2. Sign in to Thalia through the dashboard. If needed, use its browser link
   and the separate `vnc-password` to complete a provider challenge.
   Verify that your actual library appears.
3. On the reader, install the matching firmware and four packaged plugin
   files. Enable Plugins, enter **File Transfer > Join Network**, and open
   the **reader's** `/plugins` page in a browser.
4. Choose **Docker helper (recommended)**. Set API origin
   `http://192.168.1.10:18081`, the API key from the dashboard, download
   folder `/Books/Tolino`, accept the transport warning, and save.
   Do not enter the dashboard, browser or Sync URL as the plugin API URL.
5. Leave File Transfer and open **Home > Plugins > Thalia / Tolino**.
   Download individual books or use **Alle fehlenden EPUBs laden**
   ("Download all missing EPUBs"). Supported EPUBs download to the reader,
   not the Unraid server. DRM/ACSM/PDF are not supported or decrypted.
6. Configure a trusted HTTPS endpoint for Sync, or explicitly accept trusted-LAN
   HTTP using `SYNC_ALLOW_INSECURE_HTTP=1` (see the next section). Open its `/app/`,
   create a Sync account, then connect **Tolino / Thalia (local helper)**
   in Settings with the helper API key. The server is already included
   in this container; do not install a second Sync container.
7. Change `SYNC_REGISTRATION_DISABLED` to `1` and apply the Unraid template
   again. Register downloaded metadata before each book's first sync, following
   the [connector instructions](../crosspoint-sync/README.md#register-downloaded-books-before-the-first-sync).
   That administrative registration tool is separate from the included server;
   it requires Node 24 and a patched Sync source checkout on the machine
   running the tool.
8. Configure the reader's separate Sync settings: external **Sync origin**,
   CrossPoint protocol profile, Binary document matching, metadata enabled,
   and Sync account credentials (not Thalia credentials). Use **Sync Progress**
   inside a book. Plugin connection settings do not configure Sync automatically.
9. After verifying matching/pulls, optionally set `HELPER_SYNC_WRITES=1` and
   enable **Send reading positions** in the connector. Both opt-ins are
   required. Cloud writes remain disabled otherwise.

The server checks cloud positions every five minutes and imports only strictly
advancing positions. Applying a position on the reader still requires manual
**Sync Progress**. The dashboard/browser plugin shows cloud references;
normally opening a book does not automatically restore its cloud position.

## 4. Network security and HTTPS

Unraid Bridge port mappings commonly expose services on all host interfaces.
Restrict them to the trusted LAN with host/network firewall rules, or use
IP-specific publications in Compose. Never forward these ports from the
Internet. Dashboard HTTP exposes passwords, and API HTTP exposes its key;
VNC's password is not encryption. Use HTTPS/WSS or a VPN for untrusted networks.

The Sync server's HTTP-localhost credential exception is **loopback only**.
Do not assume `SYNC_ALLOW_HTTP_LOCALHOST=1` makes plain LAN HTTP login work.
For a deliberately trusted-LAN-only deployment, you may instead set
`SYNC_ALLOW_INSECURE_HTTP=1` and recreate the container. This explicitly
permits connector credential submission over HTTP without trusting proxy
headers. Keep `SYNC_TRUST_PROXY=0` when no proxy is used. Your API keys,
credentials and traffic can be intercepted or modified on that network.
Never enable this on an Internet-facing or untrusted network; HTTPS remains
the default and recommended configuration. Set the option back to `0` to
restore the HTTPS requirement.
Use a trusted HTTPS reverse proxy for a physical reader. Forward Sync to
container port 8082 and preserve Host. Set `SYNC_TRUST_PROXY=1` only if clients
cannot bypass that proxy to reach Sync directly; remove/restrict the direct
host Sync port mapping in that case.

When proxying the bridge, set `HELPER_ADMIN_ORIGIN`, `HELPER_BROWSER_ORIGIN`
and `HELPER_PUBLIC_URL` to their actual external HTTPS origins. Forward Host
unchanged and support WebSockets for noVNC. The browser endpoint requires its
own root site, not a path prefix. The plugin API and Sync endpoints remain
separate even though both run in the same container.

### Optional passwordless web access (trusted isolated LAN only)

After creating your Sync account with normal authentication, set:

```text
ALLINONE_DISABLE_WEB_AUTH=1
SYNC_WEB_AUTH_USER=your-existing-sync-username
SYNC_WEB_AUTH_ORIGIN=http://192.168.8.3:18082
```

Use your actual browser-visible Sync origin. Recreate/update the container.
This opens the dashboard and noVNC without passwords and automatically opens
the selected account at Sync's `/app/`. Anyone with network access can now
control the browser, cloud login, library and Sync data (including deletion).
Do not expose these ports outside an isolated trusted LAN. Exact Host/Origin
checks remain enabled; cross-origin passwordless access is rejected.
Provider/Thalia login, reader Sync passwords, helper API keys and storage
encryption keys are **not** disabled. Existing password files may stay mounted;
Compose still requires its five secret files. No device keys are exposed to
the passwordless app, and switching the option back to `0` restores web
authentication immediately, including for previously opened passwordless tabs.
Signing out does not protect a server configured for passwordless access.
`SYNC_ALLOW_INSECURE_HTTP` is independent and still needed for HTTP connector
credential submission.

## 5. Checks, updates and recovery

- An unkeyed request to `http://192.168.1.10:18081/api/status` must return **401**.
- The Sync health endpoint is `http://192.168.1.10:18082/healthz` when using
  the direct mapping and empty `SYNC_BASE_PATH`; expect `{"status":"ok"}`.
- After restart, check that the saved library, Sync account and matches remain.
  Real account restoration can still require provider interaction after expiry.
- Back up the full appdata `data` directory and all five secret files.
  Stop the container first for a consistent SQLite copy, including WAL/journals.
- Update the image in Unraid using the **same paths and keys**. Do not run
  initializers to replace keys. Rolling back may also require restoring a
  compatible database backup after schema changes.
- Keep secrets private and do not delete appdata as an update step.
- For existing two-container data, use the
  [migration procedure](DEPLOYMENT.md#migrating-an-existing-two-container-installation);
  never run old and new copies concurrently against the same SQLite database
  or rotating provider session.

For general Compose/GHCR deployment, see [DEPLOYMENT.md](DEPLOYMENT.md).
