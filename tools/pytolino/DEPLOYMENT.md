# Permanent Tolino Bridge deployment (GHCR)

This deployment runs the browser/login/library bridge and the exact-position
CrossPoint Sync connector in **one container and one image**. It works on a
Docker Engine/Compose host without building firmware or running the old local
source-build setup. The helper uses Chromium/noVNC; Sync is built from the
pinned upstream source plus this repository's checked patch. A small supervisor
starts both services, checks readiness, stops the whole container on a child
failure or repeated unhealthy checks, and shuts down their process groups
on container stop. Docker's restart policy restarts the complete application.

**Unraid Docker tab:** use the dedicated
[Unraid setup guide](UNRAID.md) for exact Add Container fields, appdata/secrets
path mappings, all four TCP ports, environment variables and Extra Parameters.
That guide offers a single appdata-root mount using `ALLINONE_DATA_DIR`;
the Compose layout below retains separate read-only secret mounts.

## Image, platforms, and updates

The GitHub Actions workflow publishes:

| Image | Purpose | Registry |
|---|---|---|
| `crosspoint-tolino-bridge` | Thalia login, library, keyed API, browser and exact-position Sync server | `ghcr.io/artifactdev/crosspoint-tolino-bridge` |

Actions builds the combined image for `linux/amd64` and `linux/arm64`, and
requires no-push builds on both platforms before publication. The runtime
uses Debian with Python, Chromium and Node 24, all running as UID/GID 65534.
The combined ARM64 image has been built and runtime-tested locally, including
authenticated health checks, the Sync web app, graceful stop, restart and
persistent data. Actions repeats the runtime test on AMD64 before publication.
These are CPU
architecture checks, not validation of every Docker host, kernel, browser
login provider, or reader model.

On pushes to `main`, Actions publishes `:main`, `:latest`, and a commit-derived
`:sha-<short-commit>` tag. A pushed `v*` Git tag publishes that
version tag (for example `:v1.2.3`) and its commit tag. Manual runs publish
`:manual-<run-number>` and an optional validated version tag; they do not
replace `:latest`. Pull requests build the multi-architecture image and test
the patched Sync source, process supervision and the combined service lifecycle
without logging in to GHCR or pushing images.

For production, pin `BRIDGE_IMAGE` in the environment file to a
version or commit tag. `main`/`latest` are convenient moving tags, not update
pins. After publishing, update the image tag and run `docker compose pull`
then `docker compose up -d`. The old source-build files
(`tools/pytolino/compose.yaml`, `tools/crosspoint-sync/compose.yaml`) are
unchanged and remain available as the legacy separate-service development setup.
`SYNC_IMAGE` is no longer used by the registry deployment.

## Optional passwordless web access

Authentication is enabled by default. For an isolated trusted LAN only, set
`ALLINONE_DISABLE_WEB_AUTH=1`, `SYNC_WEB_AUTH_USER` to an **existing** Sync
username and `SYNC_WEB_AUTH_ORIGIN` to the exact browser-visible Sync origin
(for example `http://192.168.8.3:18082`, without a path/trailing slash).
Create the account before enabling this and recreate the container afterward.
This removes dashboard/noVNC passwords and auto-opens that account in `/app/`.
Anyone on the network can control your browser/cloud account and read,
modify or delete library/Sync data. Never publish these ports to the Internet.
Keep all API/encryption keys and existing secret mounts; reader credentials
and provider login remain required. Host/Origin checks remain enforced.
Cross-origin passwordless access is rejected. Set the switch back to `0` and recreate to
restore web authentication, including for already-open passwordless tabs.
HTTP connector submission separately requires `SYNC_ALLOW_INSECURE_HTTP=1`.

## Prepare a host and private image access

These example paths are deliberately **outside the repository**:

```text
/opt/crosspoint-tolino/deploy.env
/opt/crosspoint-tolino/secrets/helper-api-key
/opt/crosspoint-tolino/secrets/storage-key
/opt/crosspoint-tolino/secrets/admin-password
/opt/crosspoint-tolino/secrets/vnc-password
/opt/crosspoint-tolino/secrets/sync-storage-key
```

Copy `tools/pytolino/registry-env.example` to
`/opt/crosspoint-tolino/deploy.env` and edit it privately. Copy
`tools/pytolino/compose.registry.yaml` to
`/opt/crosspoint-tolino/compose.registry.yaml`. The example's loopback origins
and binds agree; keep dashboard/browser loopback-only unless an authenticated
proxy is configured. For a reader on the LAN, change `HELPER_PUBLIC_URL` and
`HELPER_BIND_ADDRESS` to the same host LAN IP (or a LAN DNS name/address as
appropriate), and set `SYNC_BIND_ADDRESS` to the LAN IP so the reader can reach
Sync. Use the exact external HTTPS origins if serving the helper UI/API through
a trusted reverse proxy. Do not add local credentials or generated secrets to
the source tree.

If the repository/package is private, authenticate Docker on the deployment
host with a GitHub account that can read the packages. A classic PAT needs
`read:packages` (and `repo` when required for a private linked repository);
keep it in the host credential store, never in Compose or the env file:

```sh
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io \
  --username YOUR_GITHUB_LOGIN --password-stdin
```

Grant the repository's Actions workflow package-write access if GitHub prompts
for it. CI publication uses only the workflow `GITHUB_TOKEN` with
`packages: write`; no registry password or private credential is stored in
this repository or passed as a build argument.

Create the private secret directory with host access restricted. The bridge
container runs as UID/GID `65534`; its generated files and `/data` must be
usable by that identity. Adjust ownership for rootless Docker/user-namespace
remapping where applicable:

```sh
sudo install -d -o 65534 -g 65534 -m 0700 /opt/crosspoint-tolino/secrets
docker pull ghcr.io/artifactdev/crosspoint-tolino-bridge:main
docker run --rm --user 65534:65534 \
  -v /opt/crosspoint-tolino/secrets:/secrets \
  --entrypoint python ghcr.io/artifactdev/crosspoint-tolino-bridge:main \
  /app/setup_storage.py
docker run --rm --user 65534:65534 \
  -v /opt/crosspoint-tolino/secrets:/secrets \
  --entrypoint python ghcr.io/artifactdev/crosspoint-tolino-bridge:main \
  -c 'import os,secrets; fd=os.open("/secrets/sync-storage-key",os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600); f=os.fdopen(fd,"w"); f.write(secrets.token_hex(32)+"\n"); f.close()'
```

The initializer creates the four bridge files once, never overwrites existing
files, and does not print their contents. The Sync key is readable by its
unprivileged Node process; its parent directory is host-private. Do not rotate
either encryption key for an existing data volume. Back up these files
separately from the data volumes. Never share or publish the admin/VNC
passwords or helper API key. Read the generated admin/VNC password locally
with appropriate host privileges; do not put it in shell history, chat, or logs:

```sh
sudo cat /opt/crosspoint-tolino/secrets/admin-password
```

The separate Sync-key command refuses to overwrite an existing file; run it
only on first installation. Existing deployments must retain their original
keys and data. A commit-derived image tag identifies a build source, but tags
can technically be overwritten; pin image digests for registry-level immutability.

Set `BRIDGE_SECRETS_DIR` in `deploy.env` to the absolute secret directory.
Keep the env file private (`chmod 600`) and use its absolute path for Compose.

## Network, ports, and first start

The single container publishes these **host ports**; internal ports stay fixed.
The plugin API and reader Sync URLs remain separate; combining processes does
not merge their protocols or configuration.

| Host port | Container | Purpose | Default host bind |
|---:|---:|---|---|
| 8080 | helper:8080 | Admin/login dashboard (Basic auth) | `127.0.0.1` |
| 6080 | helper:6080 | Authenticated noVNC browser | `127.0.0.1` |
| 8081 | helper:8081 | API used by CrossPoint and Sync (API key on every route) | `127.0.0.1` |
| 8082 | helper:8082 | Sync website and reader protocol | `127.0.0.1` |

Loopback defaults are intentional. Set each needed `*_BIND_ADDRESS` to the
Docker host's **specific trusted LAN address** for direct LAN clients; do not
publish all ports on `0.0.0.0` by default. The dashboard and browser ports are
for administration only. The reader needs the helper API on 8081 and the Sync
server on 8082. Set `HELPER_PUBLIC_URL` to the API origin the reader can reach;
configure the reader's Sync URL as `http(s)://HOST:8082/`, not the helper URL.
`HELPER_ADMIN_ORIGIN` and `HELPER_BROWSER_ORIGIN` must exactly match the
origins used in the administrator's browser. The helper API and Sync host
bindings must include the reader's reachable LAN interface; their Compose
container ports do not change.

For remote access, prefer a VPN or HTTPS reverse proxy. Restrict direct
container-port access to the proxy, preserve `Host`, support WebSockets for
noVNC, and set all three helper origins to their actual external HTTPS origins.
The browser/noVNC origin needs its own root site rather than a path prefix.
Set `SYNC_TRUST_PROXY=1` only when Sync cannot be reached around the TLS proxy.
The HTTP-localhost credential exception is for loopback testing only; it is
not a substitute for TLS on a LAN or the Internet. Never port-forward these
services or expose the unauthenticated browser/dashboard to an untrusted
network.

Direct HTTP on a trusted LAN still exposes the helper API key, Sync account
credentials and traffic in transit. Prefer HTTPS or a VPN for untrusted Wi-Fi
or remote readers. The legacy VNC password is not encryption or a substitute
for network isolation.

If you explicitly accept this risk, set `SYNC_ALLOW_INSECURE_HTTP=1` in
the deployment environment and recreate the container to permit HTTP connector
credential submission. It defaults to `0` and does not enable proxy trust.
Keep `SYNC_TRUST_PROXY=0` without a proxy. Never use this opt-in on an
Internet-facing or untrusted network; HTTPS is recommended.

Start with the separately stored env file:

```sh
docker compose --env-file /opt/crosspoint-tolino/deploy.env \
  -f /opt/crosspoint-tolino/compose.registry.yaml pull
docker compose --env-file /opt/crosspoint-tolino/deploy.env \
  -f /opt/crosspoint-tolino/compose.registry.yaml up -d
docker compose --env-file /opt/crosspoint-tolino/deploy.env \
  -f /opt/crosspoint-tolino/compose.registry.yaml ps
```

In the configured dashboard, sign in as `admin` using the private
`admin-password`, then complete the Thalia login. Confirm the real library
loads and use the local browser only for provider challenges. In CrossPoint,
configure the Docker helper URL and API key for library/download functions.
Unkeyed requests to the helper API should return 401.

Open Sync at `http://HOST:8082/app/` from a trusted local browser, create the
Sync account, then add **Tolino / Thalia (local helper)** in Settings using the
helper API key. The helper must already be signed in. After the initial
account is created, set `SYNC_REGISTRATION_DISABLED=1` in the private env file
and recreate the container. Keep account credentials separate from Thalia
credentials.

### Book registration and progress behavior

Use the existing metadata-only book registration command in
[`../crosspoint-sync/README.md`](../crosspoint-sync/README.md) before the
reader's first sync of each downloaded book. Registration identifies the book
without sending or changing reading progress, preventing an initial book-start
position from replacing an existing cloud position.

The reader still controls when positions are applied: open the book, choose
**Sync Progress**, then confirm the cloud position. Normal book opening does
not restore progress automatically. The server refreshes matched cloud
positions every five minutes and on reader progress requests; only strictly
advancing Tolino positions are imported. Exact locators are retained. The
dashboard and browser plugin show cloud state but are read-only.

Cloud writes are opt-in and disabled by default. Enabling outbound writes
requires **both** `HELPER_SYNC_WRITES=1` in this deployment env and the
connector's **Send reading positions** option in Sync Settings. Keep writes
off until the account, registration and matching have been checked. Use
synthetic books for write testing rather than altering a real reading history.

## Persistence, updates, and recovery

Compose creates one persistent named volume with the Compose project prefix
(`*_allinone_data`); do not use `docker compose down -v`.
`/data/bridge` holds encrypted login state and `/data/sync` holds the SQLite
database, Sync accounts and linked connector records. All processes run as
UID/GID 65534. The helper storage key and Sync `TOKEN_ENC_KEY` must remain
stable and be backed up with access restricted. Losing a key may require
sign-in again or make saved connector credentials unreadable.

Back up the volume and all five secret files before upgrades. For consistent
SQLite backups, stop the container before copying volume contents; restore the
same volume data and keys together. To update, pull the selected image tags
and recreate with `up -d`; the named volumes and external secrets stay in
place. Inspect logs/status after upgrades and keep a known-good version tag
available for rollback. Never remove the data volumes as an update step.

For local source builds and Unraid-specific instructions, see
[`README.md`](README.md) and [`UNRAID.md`](UNRAID.md). For Sync connector
details and safeguards, see [`../crosspoint-sync/README.md`](../crosspoint-sync/README.md).

## Migrating an existing two-container installation

This is not an in-place volume-layout change. Stop both old services first,
back up their volumes and retain all five original secrets. Do not initialize
new encryption keys. Create a fresh all-in-one volume: copy the **contents**
of the old bridge data volume into its `bridge/` subdirectory, and the contents
of the old Sync data volume into `sync/`. Preserve the SQLite database together
with any journal/WAL files from the stopped service. Set ownership of the copied
data to UID/GID 65534 (the old Sync image used UID 1000).

Use the new registry Compose file and existing secrets, then start the combined
container. Keep the externally configured API/Sync URLs unchanged where possible.
Existing connector records can still contain the former internal helper origin
`http://helper:8081`; reconnect/update that connector in Sync Settings so new
records use `http://127.0.0.1:8081`. The Compose service retains the name `helper`
for compatibility with old internal addresses, but there is no second service.
Verify the real library, Sync login and registered matches before enabling
writes. Do not run old and new deployments concurrently against the same
database or rotating provider session. Keep the old backups for rollback;
do not delete either old volume during migration.

## Local combined-image development

From the repository root:

```sh
docker build -f tools/pytolino/Dockerfile.allinone -t crosspoint-tolino-bridge:dev .
python3 -m unittest discover -s tools/pytolino -p test_allinone.py -v
python3 tools/pytolino/allinone_smoke.py crosspoint-tolino-bridge:dev
python3 tools/pytolino/allinone_smoke.py crosspoint-tolino-bridge:dev --single-path
```

The runtime smoke uses isolated temporary secrets and a temporary Docker volume;
`--single-path` instead tests the Unraid-style single appdata bind mount.
On Linux, this smoke removes only its disposable `data/` subtree using the
container's owning UID before the runner deletes its temporary directory;
production data permissions are not relaxed.
It never logs into Thalia, touches an existing deployment or uses real books.
The simulator remains a separate native development program; see the
[simulator guide](../firmware/SIMULATOR.md).
