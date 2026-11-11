# pytolino Docker login and token probe

For multi-host registry deployment of the permanent bridge and exact-position
Sync connector, see the [GHCR deployment guide](DEPLOYMENT.md). The existing
local source-build Compose setup below remains supported.

## Login without copying tokens

The browser-enabled image uses a pytolino client with an adapted browser login.
Enter your Thalia email and password on the protected login page. The official
webreader completes OAuth; the adapter observes its successful token exchange
and matching hardware identity, then uses pytolino to retrieve your library.
No authorization code or token needs to be copied. This is not a simulated login.
Successful sign-in is confirmed only when your real books appear.

**Verified with a real Thalia account:** browser sign-in, automatic session
handoff after reload, seven library books, six valid EPUB responses and one
actual EPUB download onto the CrossPoint firmware simulator's SD. One book has
Adobe `ACS4` protection and is excluded, not decrypted. Encrypted session
restoration after container recreation has also reloaded all seven books with
no password saved or entered. The companion API,
download transport and read-only cloud-state routes have additional automated
contract tests; those do not prove EPUB/reading-state compatibility with every
real account or a physical CrossPoint reader.

## Dashboard and CrossPoint companion

The dashboard at **http://127.0.0.1:8080/** includes searchable/sortable metadata
columns and an expandable JSON view of every publication field returned by
inventory (including uploads). Session/credential fields are excluded. It
auto-refreshes status, recovers its cookie after a restart, and exposes the
companion URL/key to the local administrator only.
Publication dates use `DD.MM.YYYY`; language codes are displayed as German
language names (for example `Deutsch` and `Englisch`). Unknown date/language
values remain visible rather than being guessed.

The **Cloud-Lesefortschritt** column loads automatically after login/library
refresh. **Cloud-Lesestand aktualisieren** pulls it again on demand. It shows
the latest available bookmark's percentage, optional cloud page and modification
date, matched by publication ID. No matching cloud position is displayed as
**Kein Cloud-Lesestand**, never as an invented `0 %`. Failures are explicit and
do not hide the library or invent progress. This is a separate full-state,
read-only fetch and does not change the plugin's incremental revision cache.

Cover images are shown when inventory provides a usable HTTPS file resource.
They are fetched through the authenticated helper, with a placeholder if no
supported image is available. The **EPUB laden** link downloads through the
local admin session; it contains neither API keys nor signed provider URLs.
Unsupported/DRM books have no active download link. All original metadata remains
available in the detail view.
Actual provider flags `epubMetaData.protectionType` (including `WatermarkV1`
and `ACS4`) and deliverable `contentEncrypted` are checked consistently in
the helper, table and plugin; unknown/conflicting encryption flags are rejected.

The browser handoff now performs **one normal reload**, only if the webreader
library is open for ten seconds without a matched session. No logout, background
retry loop or CAPTCHA bypass is used. It still requires a successful token
exchange and matching successful device response before accepting the session.

### Start for the trusted home network

The default desktop configuration keeps admin port 8080 and browser port 6080
**loopback-only**. For authenticated remote access on Unraid use the separate
[Unraid deployment guide](UNRAID.md) and `compose.unraid.yaml`, not this local
port configuration. The separate
API on 8081 requires a Bearer key on every route, including status. It has no
login, arbitrary proxy, upload, deletion or progress-write route, and sends no
CORS permission headers: the plugin uses the reader's HTTP(S) relay.

Use the Compose configuration for a stable API key across container restarts:

```sh
docker build -f tools/pytolino/Dockerfile.login \
  -t crosspoint-pytolino-login:local tools/pytolino

# Store the key OUTSIDE the repository; never paste its contents into chat.
mkdir -p "$HOME/.config/crosspoint-tolino"
chmod 700 "$HOME/.config/crosspoint-tolino"
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$HOME/.config/crosspoint-tolino:/secrets" \
  --entrypoint python crosspoint-pytolino-login:local /app/setup_storage.py
# These individual files are mounted read-only for the unprivileged container.
# The host parent stays mode 700; never make the directory public.
chmod 644 "$HOME/.config/crosspoint-tolino/helper-api-key"
chmod 644 "$HOME/.config/crosspoint-tolino/storage-key"

export HELPER_API_KEY_PATH="$HOME/.config/crosspoint-tolino/helper-api-key"
export HELPER_STORAGE_KEY_PATH="$HOME/.config/crosspoint-tolino/storage-key"
export HELPER_BIND_ADDRESS=192.168.1.10
export HELPER_PUBLIC_URL=http://192.168.1.10:8081
docker compose -f tools/pytolino/compose.yaml up --build
```

Replace `192.168.1.10` with the Docker host's actual LAN IP. Bind to a specific
trusted interface; do not port-forward it from the Internet. On Docker Desktop,
ensure the host firewall permits only your trusted LAN/devices. On a remote
Docker server, access admin/browser ports through SSH local port forwarding.
Do not regenerate an existing key unless intentionally rotating it.

If Docker Desktop cannot serve a port bound to a specific LAN address, you can
explicitly use `HELPER_BIND_ADDRESS=0.0.0.0`. This publishes **only the keyed API**
on all host interfaces; admin/browser remain loopback-only. Limit access using
host firewall rules and never configure router port forwarding. A published
Docker port is not proof of LAN reachability: verify `/api/status` from another
trusted device (401 without a key is expected). macOS/Docker local-network
permissions, VPN filtering or firewall rules may prevent access even while
`http://127.0.0.1:8081/api/status` works. Do not disable these protections broadly.

In the CrossPoint plugin's **Connection settings**:

1. Select **Docker helper (recommended)**.
2. Enter that LAN API origin and the API key shown on the local dashboard.
3. Set the SD download folder and acknowledge the transport/storage warning.
4. Save, load the library, then download supported EPUBs or pull cloud positions.

Thalia refresh/access tokens remain on the helper. The API key is stored
plaintext in the plugin's SD settings; **HTTP transmits it unencrypted**.
Use only a trusted LAN or a properly configured HTTPS reverse proxy. Firmware's
documented lack of TLS certificate verification remains a device limitation.
An API key grants read/download access to this account: keep it private.

### Persistent login and token expiry

Local Compose mounts a private named Docker volume at `/data` and a separate
Fernet encryption-key secret; Unraid uses an appdata bind mount. Successful
logins and refreshed/rotated tokens are atomically saved to `/data/session.enc`
(mode `0600`, authenticated encryption). Chromium cookies and profile remain
temporary; legacy pytolino token files are not used. At startup the helper
restores tokens, refreshes them as needed and reloads the actual inventory
without opening a browser. Keep the encryption key stable and back it up
separately from encrypted data. Losing it requires a new sign-in.

Token expiry is checked before provider requests and every 30 seconds in the
background; the latter refreshes within two minutes of expiry. A provider
401/403 is retried once after refresh. Rotated refresh tokens are saved before
the operation is reported as successful. Network/rate-limit/provider outages
are explicit and do not trigger repeated password logins.

**Additionally save credentials** is an unchecked, explicit opt-in in the login
form. It stores the email/password inside the encrypted record only after
successful login. When the refresh token is rejected, the helper attempts one
browser sign-in using those credentials. It does not loop after failure or
bypass CAPTCHA/2FA/cookie challenges; use the protected browser to confirm.
Without that option, an invalid/revoked refresh token requires manual sign-in.
Passwords/tokens are never returned by status or rendered back into inputs.
Host/container administrators with the key can decrypt the record; encryption
is not protection against a compromised host or running container.

**Gespeicherte Anmeldung löschen** clears saved tokens and credentials and
disconnects locally; it does not revoke the provider session. A new manual
login clears the previous account's saved record before attempting sign-in.
Storage/decryption failures are visible, not treated as an empty successful
session. A manual `docker run` without data/key configuration remains ephemeral.
The helper API key is separate from the encryption key and must also stay stable.
Do not use `docker compose down -v` during updates: `-v` deletes the saved-login
volume. Back up the volume and storage key privately, separately.

### API v1

All routes require `Authorization: Bearer <helper-api-key>`.

| Route | Request / response |
|---|---|
| `GET /api/status` | `connected`, `busy`, `apiVersion: 1`; no account secrets |
| `GET /api/sync-status` | Same status plus `syncWritesEnabled` for the optional server connector |
| `GET /api/sync-position?id=…` | Exact cloud position and current revision for a library book; missing position is `null` |
| `PUT /api/sync-position` | Opt-in exact-point write with fresh revision/timestamp conflict checks and read-back verification; creates a missing bookmark via Tolino's server-assigned collection add |
| `GET /api/inventory` | Original `PublicationInventory.ebook` and `.edata`; all returned metadata |
| `POST /api/reading-state` | JSON `{"revision":null}` or previous revision; forwards only an empty cloud `patches` array |
| `GET /api/download-info?id=…` | Validates library membership and EPUB/DRM; looks up the provider download with inventory publication/deliverable IDs (falling back to the book identifier when absent), then returns a relative helper URL |
| `GET /api/download?id=…` | Streams validated EPUB bytes, maximum 256 MB; account headers are sent only to Tolino's BOSH content endpoint, never to external download hosts |
| `GET /api/cover?id=…` | Cover from that library entry; PNG/JPEG/WebP/GIF only, maximum 5 MB |
| `GET /api/catalog` | Compact native `books` catalog, read-only cloud progress in details, labelled DRM entries and JSON-safe sidecars |
| `GET /api/catalog?supported=1` | Same authenticated catalog, restricted to supported EPUBs for native bulk downloads; no DRM entries |
| `GET /api/native-download?id=…` | Validated EPUB for a SHA-256 catalog ID, resolved only against the loaded account library |

The dashboard reports the last cloud-write outcome separately from cloud progress.
Successful reader upload to the Sync server is not itself confirmation of Tolino
delivery. A first push no longer requires opening the book in the webreader.
Failed or unconfirmed writes remain errors and never advance `readingVersion`.

Native routes additionally require `X-Tolino-Mode: helper` and
`X-Tolino-Transport-Accepted: true`. The installed `device.json` reads those
values, the helper URL and API key from the same `settings.json` saved by the
browser setup. Consent is also saved as the string `nativeTransportAccepted`
because the firmware config loader does not substitute JSON booleans. Native
browsing/downloads need neither File Transfer nor an open
browser. All books remain visible, but unsupported/DRM downloads are rejected.
Progress-fetch failures fail the catalog request explicitly rather than
displaying invented positions. Native downloads perform the same EPUB/DRM
validation as browser downloads. Native catalog/download routes do not write
cloud positions.

Inventory/token requests have verified HTTPS, timeouts and at most one auth
refresh/retry. Signed download URLs must use public HTTPS hosts; redirects are
bounded and receive neither account tokens nor helper keys. EPUB ZIP/mimetype
is validated before responding. Adobe DRM/ACSM/PDF/audiobooks are rejected.
Cover requests send account headers only to the exact official BOSH cover
endpoint, never to CDN/other redirect hosts. SVG and HTML covers are rejected.
Provider errors are explicit but sensitive upstream response bodies are not
returned. Library requests and downloads serialize access to the account session.
Cloud positions in the dashboard and SD plugin remain **read-only reference
data**. The optional CrossPoint Sync connector can import exact positions through
the reader's manual sync action and explicitly upload them through the new
write-gated route. It does not automatically restore progress on normal opening.
The local dashboard uses paired, exact-Origin `POST /reading-progress` with an
empty JSON object. This admin-only route returns normalized `positions` and
`fetchedAt`; it cannot accept cloud patches and is not exposed on the LAN API.
See the [server connector installation and first-sync safeguards](../crosspoint-sync/README.md)
before enabling cloud writes. `HELPER_SYNC_WRITES` defaults to `0`; enabling it
alone does not enable sending in the connector.

### Offline dashboard/API integration fixture

```sh
docker run --rm --name crosspoint-tolino-fixture \
  -p 127.0.0.1:18080:18080 -p 127.0.0.1:18081:18081 \
  --tmpfs /tmp:rw,nosuid,size=256m --entrypoint python \
  crosspoint-pytolino-login:local /app/fixture_server.py
```

Open `http://127.0.0.1:18080/`. This separate executable uses **synthetic books,
tokens and EPUBs only**, never provider requests. Its fixed public test key is
`synthetic-fixture-key-01234567890123456789`; never use this key for a real account.
For no-device integration tests point the plugin fixture at
`http://127.0.0.1:18081`.

While the fixture is running, `node tools/pytolino/plugin-smoke.cjs` exercises
the actual plugin client through the HTTP API, checking inventory, read-only
positions, streamed EPUB bytes, SD sidecars, DRM refusal and missing-key rejection.

Run Python regression tests in the built image with:

```sh
docker run --rm --tmpfs /tmp:rw,nosuid,size=256m --network none \
  --entrypoint python crosspoint-pytolino-login:local \
  -c 'from pathlib import Path; Path("/tmp/pytolino").mkdir(); import unittest; result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromNames(["test_companion","test_login_server","test_session_store"])); raise SystemExit(not result.wasSuccessful())'
```

Build and run from the repository root:

```sh
docker build -f tools/pytolino/Dockerfile.login \
  -t crosspoint-pytolino-login:local tools/pytolino
docker run --rm --name crosspoint-pytolino-login \
  --tmpfs /tmp:rw,nosuid,size=1g --shm-size=512m \
  --cap-drop=ALL --security-opt=no-new-privileges \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:6080:6080 \
  crosspoint-pytolino-login:local
```

Open **http://127.0.0.1:8080/** and submit your credentials. The password field
is immediately cleared and request bodies are not logged. Never send credentials
in chat. Use **Browser im Container ansehen** to view the Chromium window via
noVNC; no separate VNC password or token copying is needed. The desktop WebSocket
accepts only the local noVNC origin. Ports must remain bound to loopback exactly
as shown. Other local users/processes may still access them: use a trusted machine.

The browser adapter starts at the official webreader, selects the visible
**Deutschland** button and the Thalia reseller control (`ftu-resellerLogo-3`),
then clicks its login button. These selectors were verified against the public
webreader. The official site supplies the contextual OAuth navigation.
Credentials are filled only at the exact HTTPS Thalia origin using the current
`username` / `password` input names. Other countries/providers and arbitrary
origins are never clicked or filled. Unknown UI/challenges remain visible for
manual confirmation; no brittle cookie/local-storage selection is injected.
The adapter retains upstream SeleniumBase UC browser mode;
no custom challenge solver is added. SeleniumBase's
standard `--headed` option keeps its browser on the noVNC display.
The browser step waits up to three minutes for a successful response from the
exact `https://www.thalia.de/auth/oauth2/token` endpoint and a successful BOSH
registration/inventory response with the **same access token**, hardware ID and
reseller ID. Network events and token bodies are processed in memory via CDP.
The modern webreader is also supported through successful requests to the exact
HTTPS `api.pageplace.de/v1/devices/<UUID>/userid` endpoint: the UUID identifies
the hardware and the access token/reseller come from that request's headers.
The same token-matching and successful-response requirements apply; configuration
or unrelated API requests cannot authenticate a session.
No HAR or browser-network log is saved. Password requests are not parsed.
Country and provider selection is automatic; security prompts remain manual.

This replaces upstream's cookie handoff followed by a second authorization
request, which failed with a missing OAuth code even after the real books were
visible in the browser. The adapter does not request another code, exchange a
code twice, register a device itself, or choose an arbitrary device from the
account. The official webreader may register its own browser device.
It uses the reseller ID actually observed in that authenticated request rather
than assuming upstream's configured ID 2. The helper owns encrypted token
persistence when configured; no pytolino token-cache write is performed.
Library requests still use pytolino's inventory implementation.
Errors identify the failing step without exposing provider bodies or tokens.
Form filling waits for clickable username/password fields and submits with Enter.
If automatic filling fails, the UI asks you to sign in directly in the noVNC
browser, without copying tokens. After a browser-step failure, the window stays
open for inspection until the next login attempt or container shutdown. It is
closed after successful session transfer. A black desktop before starting a
login, or after a successful browser step, is therefore expected; it is not a
running browser window.
Provider challenges, changed form selectors or obsolete OAuth endpoints may
still prevent login. A visible browser alone is not evidence of successful login.
If it hangs, stop and restart the container; there is no login cancellation or
overall login timeout in this experimental harness. Only browser navigation and
the form/session waits have explicit time limits.

Chromium and token caches live under the memory-backed temporary directory.
The image's SeleniumBase driver directory remains writable because upstream
patches its driver at runtime. In this ephemeral `docker run` example there are no host mounts or persistent
volumes. Compose uses the encrypted data volume described above.
Do not commit/export a running container or publish its secrets.
The local dashboard/browser ports are separate from the authenticated LAN
companion API on port 8081 described above.

Offline login-route and orchestration tests:

```sh
docker run --rm --tmpfs /tmp:rw,nosuid,size=256m --network none \
  --entrypoint python crosspoint-pytolino-login:local \
  -c 'from pathlib import Path; Path("/tmp/pytolino").mkdir(); import unittest; result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromName("test_login_server")); raise SystemExit(not result.wasSuccessful())'
```

The browser fixture also verifies form submission, actual CDP response-body
capture and authenticated-header matching against local synthetic endpoints.
Only in that test are the expected token/BOSH origins redirected to the local
fixture; production uses the fixed provider origins.
This does not prove a successful real-account token exchange or library response:

```sh
docker run --rm --init --tmpfs /tmp:rw,nosuid,size=1g --shm-size=512m \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --entrypoint xvfb-run crosspoint-pytolino-login:local \
  -a python /app/browser_smoke.py
```

## Optional token-only diagnostic

This optional Docker CLI tests **pytolino 3.6** with an existing Thalia webreader
refresh token and matching hardware ID. It is not a password-login flow, HTTP
server, or plugin integration. Offline tests do not prove account compatibility.

## Run

From the repository root:

```sh
docker build -t crosspoint-pytolino-probe:local tools/pytolino

# No network or credentials: check installed package and run regression tests.
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --cap-drop=ALL --security-opt=no-new-privileges --network none \
  crosspoint-pytolino-probe:local --check
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --cap-drop=ALL --security-opt=no-new-privileges --network none \
  --entrypoint python crosspoint-pytolino-probe:local -m unittest -v test_probe

# Real account: requires an interactive terminal and outbound HTTPS.
docker run --rm -it --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --cap-drop=ALL --security-opt=no-new-privileges \
  crosspoint-pytolino-probe:local
```

Obtain a **fresh** refresh token and hardware ID from your webreader session
using the [existing import instructions](../../README.md#get-a-session-without-entering-your-password-in-the-plugin).
Enter them only at the two hidden terminal prompts. Never put credentials into
chat, environment variables, command arguments, Docker build arguments or files.
Do not reuse previously exposed sessions. No password is requested.

The probe imports the token (which immediately refreshes it), then calls
`get_inventory()`. It prints the actual book count, not titles or tokens.
A real-account success is only confirmed by `SUCCESS: N real cloud books ...`
and exit status zero. Token rotation may affect the originating webreader session.
An empty inventory is a successful response with zero books, not proof of purchases.

The container runs as an unprivileged user without host mounts or published
ports. Upstream writes its token cache into the container's temporary memory
filesystem. `--rm` removes the container; stop it when finished. There is a
120-second cloud-request deadline. Upstream diagnostic text is suppressed to
avoid leaking token request data; failures print an exception type and exit
nonzero, and are never treated as successful library access.

## Findings and limitations

- [Upstream](https://github.com/ImamAzim/pytolino) supports `server_name="thalia"`.
  The installed **3.6** package configures reseller ID **2**, unlike this plugin's
  **3**. The probe leaves this unchanged to test upstream behavior; compatibility
  with the plugin must not be assumed.
- Its token refresh uses the same Thalia `/auth/oauth2/token` endpoint as our
  webreader implementation. This is not a new native OAuth client configuration.
- `import_token()` catches some refresh failures internally. The probe checks
  that an access token was actually obtained before requesting inventory.
- Initial password login uses SeleniumBase `SB(uc=True)` (Undetected mode),
  browser cookies and older webshop authorization URLs. The token-only probe
  never calls that path and installs no browser.
  Upstream token HTTP requests still use its own curl-cffi browser impersonation.
- The login image adds a local dashboard and a separate authenticated companion
  API. Docker provides isolation, a browser desktop and dependency hosting.
  Account/provider changes may still require adapting the browser handoff.
- pytolino is GPLv3; its source has not been copied into this repository.
  Distribution of an image containing it requires reviewing its license obligations.
