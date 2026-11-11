# CrossPoint Thalia / Tolino

## Recommended: permanent Docker bridge

A CrossPoint SD plugin with native book catalog, browser setup and **Tolino Bridge** Docker
companion for Thalia.de. The recommended setup signs in through the container's
visible browser and automatically transfers the session: no copying Thalia tokens.
The plugin needs only the helper URL and API key.
Keep the bridge running for login renewal, library access, downloads and cloud
requests. Exact reader progress sync additionally uses the
[CrossPoint Sync connector](tools/crosspoint-sync/README.md); the plugin's
connection settings do not replace the reader's separate Sync server settings.

The [X4 Pro custom firmware](tools/firmware/README.md) adds native bulk downloads
through this same bridge; no direct-session file is needed.
Containerless direct access remains experimental and optional, not the default
setup. Smartphone-only QR authorization has not been verified.

The Docker browser/library path has retrieved **seven real Thalia books**.
Companion downloads, cloud-state handling and plugin integration have automated
contract tests; end-to-end testing on a physical reader is still required.
Unofficial provider APIs can change.

## Installation from GitHub builds

Follow the [Docker/GHCR deployment guide](tools/pytolino/DEPLOYMENT.md) for a
new Docker host, persistent secrets/data, browser login, plugin connection
and exact reading-position sync. One all-in-one GHCR image contains the
bridge, browser login and Sync server, with one data volume and external secrets.
It uses a prebuilt registry image rather
than requiring a local source build.

The [X4 Pro firmware workflow](.github/workflows/firmware-x4pro.yml) builds
the required custom firmware and SD plugin on relevant main pushes,
version tags and manual runs. Download them from Actions artifacts or the
generated firmware prerelease; use **only the X4 Pro application image**
and follow the [firmware installation instructions](tools/firmware/README.md).
These workflows must be committed and pushed before GitHub can run them.

## Features and limits

| Feature | Support |
|---|---|
| Thalia sign-in without copying tokens | Docker dashboard + visible browser |
| Germany / Thalia selection | Automatic on the official webreader |
| Persistent login | Encrypted tokens; optional saved credentials and automatic renewal |
| Library and personal uploads | Searchable, sortable metadata table |
| Cover images and EPUB downloads | Via authenticated helper; only supported books |
| All returned publication metadata | Expandable detail view |
| Reader connection | Helper URL + API key in plugin settings |
| Native reader plugin | Cloud book list, details, read-only progress and EPUB downloads in helper mode |
| Unprotected/watermarked EPUBs | Download to SD, preserving metadata sidecars |
| Cloud reading positions | Dashboard/plugin reference display; exact cloud writes through opt-in Sync connector |
| CrossPoint saved reading position | Exact manual **Sync Progress** through CrossPoint Sync; five-minute forward-only cloud import on server |
| Kobo, Adobe DRM/ACSM, PDF, audiobooks | **Not supported** |

The SD plugin alone does not synchronize saved reader positions; use the
linked Sync connector for bidirectional exact progress. This is not a DRM-removal tool.
Only download books you are entitled to use. Thalia/Tolino and Kobo are different
services. Native use requires firmware implementing declarative device catalogs.

## Docker helper

See [setup, LAN security and API documentation](tools/pytolino/README.md).
For server deployment see the [Unraid / Docker guide](tools/pytolino/UNRAID.md).
The [production Dockerfile](tools/pytolino/Dockerfile.login) builds independently.

1. Build/start the helper using its documented Compose configuration.
2. Open `http://127.0.0.1:8080/` on the Docker host. Sign in, and open the
   container browser if prompted to complete a security/cookie challenge.
3. Wait for the dashboard to confirm your actual library. A browser window or
   successful test fixture alone is not proof of account access.
4. Take the **helper API URL and API key** from the dashboard's CrossPoint section.
   The reader needs the Docker host's LAN IP, not its own `localhost`.
   Port **8080** is the dashboard, **6080** its visible login browser, and
   **8081** the API configured in the plugin. Do not enter the dashboard/browser
   URL as the helper API URL.
5. For actual reader progress, configure the separate
   [CrossPoint Sync connector](tools/crosspoint-sync/README.md) and the reader's
   Sync settings. Keep both services running. The server imports strictly
   advancing cloud positions every five minutes; applying them on the reader
   still requires **Sync Progress**.

In the default local setup, admin/browser remain loopback-only. A separate Bearer-authenticated API
on port 8081 serves library, covers, supported EPUBs and read-only cloud states.
Account tokens stay on the helper. Compose persists encrypted sessions across
container restarts; its secrets keep both the storage key and API key stable.

The obsolete Zen extension and standalone Chrome/native-OAuth login experiments
have been removed. Docker is the maintained sign-in path.

## Install the plugin

Use a CrossPoint build implementing the current
[SD plugin API](https://github.com/crosspoint-reader/crosspoint-reader/blob/develop/docs/sd-plugins.md),
including `relay`, `crypto`, `fetchToSd`, `writeFile` and `pluginFile`.
This targets `develop` documentation, not a guaranteed released version.

1. Copy `plugins/tolino-sync` to `/plugins/tolino-sync` on the SD card.
   `/.crosspoint/plugins/tolino-sync` and `/.plugins/tolino-sync` also work.
2. Enable **Settings > Connectivity > Plugins**.
3. Start **File Transfer** in **Join Network** mode.
4. Open `http://crosspoint.local/plugins` (or the device IP plus `/plugins`)
   in a browser on the same trusted network.
5. In **Connection settings**, select **Docker helper (recommended)**.
   Enter the helper origin, API key and absolute SD download folder.
   Acknowledge the transport/storage warning and save.
6. Leave File Transfer. Open **Home > Plugins > Thalia / Tolino** on the reader.
   Its native catalog lists all cloud books. Open a book's details and choose
   **Fetch** to download a supported EPUB directly to SD. Reopen to refresh.
   DRM/unsupported books are labelled; attempting Fetch is rejected by the helper.
7. Alternatively use **Load cloud library** and **Download EPUB to reader SD**
   in the browser, keeping File Transfer and that page open until completion.
8. **Refresh cloud reading positions** shows reference progress/locators only.

The installed `device.json` uses the firmware's native declarative catalog;
no firmware fork or browser runtime is needed for helper-mode browsing/downloads.
The browser UI remains available for setup, imported-session mode and downloads.
After upgrading, save the connection once more to share a custom download folder
with native mode. Browser, dashboard and native downloads use the book title
plus `.epub`, with Tolino identifier/publication sidecars on the reader.
Unsafe filename characters are replaced and long titles are shortened to the
firmware's 100-byte UTF-8 limit, preserving the extension.
Native details show cloud progress or explicitly missing positions, not local
reader progress. The native firmware writes the generated Tolino sidecar rather
than merging arbitrary existing sidecar fields; browser downloads keep their
existing merge behavior. Older firmware without device catalogs needs browser mode.

For the local Mac simulator use `http://127.0.0.1:8081`, not the Mac's currently
unreachable LAN-IP API URL. A physical reader requires a reachable LAN helper.

### Optional direct webreader-session mode

The original dependency-free, SD-only mode remains available:

1. Open [Tolino Webreader](https://webreader.mytolino.com/) and Developer Tools >
   Network before signing in via Thalia.de; enable Preserve log.
2. Copy `hardware_id` from a successful `registerhw` request, or the device UUID
   from the authenticated `/v1/devices/<UUID>/userid` request.
3. Copy `refresh_token` from the Thalia `/auth/oauth2/token` JSON response.
4. Choose **Imported webreader session** in plugin settings and enter these
   values, download folder and explicit consent. Save and load the library.

This reuses a registered webreader identity; the plugin never registers/deletes
devices. Token rotation may affect the originating webreader session. Do not
log out of it while reusing its token. Re-import after revocation/refresh failure.
Never post credentials, tokens, HARs or unredacted network logs.

## Security and storage

- Plugin settings store imported tokens **or the helper API key in plaintext**
  on SD, accessible through the device webserver. Tokens/API keys must be private.
- Helper HTTP traffic exposes its API key on the network. Use a trusted LAN or
  an HTTPS reverse proxy; never publish the helper directly to the Internet.
- CrossPoint's documented outbound TLS transport **does not verify peer
  certificates**. This plugin cannot fix that firmware limitation.
- Browser profiles live in temporary storage. Compose persists encrypted helper
  session tokens with a separate key; password persistence requires explicit
  opt-in. The [helper guide](tools/pytolino/README.md#persistent-login-and-token-expiry)
  documents renewal, bounded re-login, storage and recovery.
  Stopping the helper does not revoke the provider session or unregister a device.
- **Clear local session** overwrites plugin credentials, cached positions and
  response files. It does not revoke sessions, delete books or securely erase
  old SD sectors/backups. Revocation belongs in Thalia/Tolino account management.
- No analytics or external frontend assets. Cover/download requests go through
  the helper. Account/helper credentials are not forwarded to CDN URLs.
- Download validation rejects unsupported formats/protection and checks EPUB
  ZIP/mimetype; it does not decrypt or remove DRM.

## Reading positions and filenames

The open bridge dashboard refreshes cloud positions every five minutes and after
a confirmed helper push. The open browser plugin refreshes every five minutes
after its library is loaded. These displays report actual cloud values.
With the patched Sync server, matched Tolino books are also checked in the
background every five minutes: only strictly greater progress is imported,
never a lower or equal percentage. Applying remote progress on the reader still
requires manual Sync Progress; firmware remains unchanged.

Tolino bookmarks contain a whole-book fraction and EPUB chapter/point locator.
CrossPoint's native saved page/layout is different. A percentage alone cannot
be safely converted, and the SD API does not expose a native saved-position setter.
Nothing writes reader caches or uploads progress.

Only explicit publication IDs, or identifier equality as a fallback, match
bookmarks. Unknown bookmark shapes fail without advancing the saved revision.
Cloud pulls always send an empty `patches` list. Positions are references only.

The dashboard fetches cloud positions after login/library refresh and on
**Cloud-Lesestand aktualisieren**. It displays the latest bookmark by modification
time for the matching publication, not the greatest percentage. A genuine zero
is `0 %`; missing positions are **Kein Cloud-Lesestand**, not assumed zero.
An unsupported response or failed request is shown explicitly.

### Exact reader-to-Thalia synchronization prerequisite

The current CrossPoint `develop` firmware already stores EPUB spine index and
visible-text offset, and its KOReader mapper can resolve a real XHTML XPath.
However, the documented SD-plugin `reader.exit`/`sleep.enter` events expose only
`book`, `percent` and `end_percent`, not that content anchor. Thus a plugin
cannot currently obtain an exact Tolino position through those events.

For direct SD-plugin synchronization, the required firmware integration is a **generic content-location event/API**:
expose the actual EPUB spine href and resolved XHTML text-node path/offset,
with defined offset units and a stable book identity. Reuse the firmware's
`ChapterXPathResolver`/`ProgressMapper` rather than infer a chapter from percent.
The helper must then validate conversion to Tolino's `chapter#point(...)`
locator against the same EPUB. Codepoint/UTF-16 offsets, nested inline elements,
whitespace, chapter boundaries and changed editions need explicit tests.

The SD plugin itself does not upload percentages as cloud positions. It never
combines a new percentage with an old locator. Exact synchronization without a
new firmware event is available through the server connector described below.

Firmware references: [event contract](https://github.com/crosspoint-reader/crosspoint-reader/blob/develop/docs/plugin-events.md),
[native progress](https://github.com/crosspoint-reader/crosspoint-reader/blob/develop/src/activities/reader/EpubReaderUtils.h),
[content XPath resolver](https://github.com/crosspoint-reader/crosspoint-reader/blob/develop/lib/KOReaderSync/ChapterXPathResolver.h),
[progress mapper](https://github.com/crosspoint-reader/crosspoint-reader/blob/develop/lib/KOReaderSync/ProgressMapper.h).

An optional server connector for
[crosspoint-sync](https://github.com/crosspoint-reader/crosspoint-sync)
requires no new SD event.
The reader's existing KOReader synchronization sends an actual content XPath
and can receive a remote position. The supplied **Tolino server patch** implements
exact RMSDK point/XPath conversion, verified binary EPUB matching, authenticated
helper access, strict cloud pulls and conflict-checked writes. It is pinned to
a specific upstream server commit, not a firmware fork.

See [installation and first-sync setup](tools/crosspoint-sync/README.md).
The connector automatically downloads and registers supported bridge EPUBs on
link, startup and subsequent refreshes, and imports existing cloud positions.
Unread books appear without fabricated progress; DRM skips and failures are
visible in Sync Settings. Discovery never writes reading positions to Tolino.
Use **Binary** matching and **Send Document Metadata**, then use the
reader's manual **Sync Progress** action to apply the cloud position.
Normal book opening does not automatically restore it. Cloud writes require
both `HELPER_SYNC_WRITES=1` and the connector's explicit sending option.
Automatic sleep/exit sync and direct-session-first/helper-fallback remain
unimplemented.

Browser and native downloads use the same safe title filename. Before
browser downloads, the plugin checks the configured SD folder and skips existing
files without cloud requests, overwriting metadata or changing reading progress.
The browser library marks them **Already on SD** and disables Download.
Legacy `SHA256.epub` and `title-SHA256.epub` names are recognized even after a cloud-title change.
Other EPUB names are recognized by the Tolino ID in their adjacent metadata sidecar.
If the intended title filename belongs to a different Tolino ID, the browser
refuses to overwrite it.
Existing duplicates are not deleted or renamed; files moved outside the configured
folder cannot be detected. Renamed files need their matching metadata sidecar.
SD lookup errors stop the download rather than guessing that a book is absent.

The stock native catalog has no pre-download existence check: native **Fetch can
still overwrite an existing EPUB and clear its reader cache**.
The optional [X4 Pro custom firmware](tools/firmware/README.md), based on original
CrossPoint 2.0.0, adds identity-based native duplicate protection and
**Alle fehlenden EPUBs laden** directly under Home > Plugins > Thalia / Tolino.
It downloads all supported cloud EPUBs across catalog pages, skipping existing
books without changing their metadata or reading cache. DRM books are excluded.
The matching GitHub Action builds the official `x4pro-gh_release` target and
publishes firmware/plugin prereleases once committed and pushed.
Without that custom firmware, use the browser check to avoid repeat downloads.

Existing sidecar keys are preserved while adding
`tolino_identifier`, `tolino_publication_id` and `tolino_id`. Large relay responses fall back
to an SD response file; saved projected state must fit the 256 KB plugin write
limit and merged sidecars the firmware's 2 KB limit.

## Development and no-device tests

Use Node.js 20+ for local tests and packaging. Install the lockfile dependencies
first; the distributable SD plugin itself does not bundle Node dependencies:

```sh
npm ci
npm run check
npm test
npm run package
```

Packaging requires `zip`. The explicit file allowlist creates
`dist/tolino-sync-0.1.0.zip` containing only the four distributable plugin files.
Copy only those files when updating an existing SD installation, preserving settings.

### Actual firmware simulator test

Start with the [local X4 Pro simulator guide](tools/firmware/SIMULATOR.md):
it includes prerequisites, pinned firmware checkout, macOS build commands,
Linux/WSL adjustments, visible startup, persistent SD and bridge setup.
The simulator compiles host-native firmware, not the downloadable ESP32 image.

The [CrossPoint simulator](https://github.com/crosspoint-reader/crosspoint-simulator)
can run the real firmware webserver locally. Build a separate
`crosspoint-reader` checkout with its documented macOS/Linux simulator config
(enable `CROSSPOINT_SIMULATOR_PROJECT_WEBSERVER`, install SDL2 and PlatformIO).
Start this project's offline Docker fixture, then run:

```sh
node tools/pytolino/simulator-smoke.cjs /absolute/path/to/crosspoint-reader
```

The test uses `.pio/build/simulator/program` and the firmware's **unmodified**
browser plugin host. It enables/discovers our SD plugin, persists helper
settings through real firmware endpoints, relays inventory and progress,
downloads an EPUB through `/api/fetch` to the simulated SD, verifies its
metadata sidecar and reloads state. It then restarts the simulator, navigates
the native Plugins catalog, connects simulated Wi-Fi, opens book details and
downloads a second EPUB plus sidecar without File Transfer or a browser.
It uses synthetic books by default, ports
19080/19081 and a temporary isolated SD, and shuts the simulator down afterward.
Keep those ports free. The fixture uses 18080/18081, not the real helper on
8080/8081. This test passed on macOS; it does not prove physical-device behavior,
real-account DRM/download compatibility, or exact outbound progress sync.

An explicit real-account mode is available after signing into your own helper:

```sh
node tools/pytolino/simulator-smoke.cjs /absolute/path/to/crosspoint-reader \
  --real-helper http://127.0.0.1:8081 /private/path/to/helper-api-key
```

It reads the key from that file without printing it, selects one supported
book and downloads it onto an isolated temporary simulated SD, which is deleted
after verification. This mode has passed with the real seven-book library and
one actual EPUB. Six books returned validated EPUBs; one uses `ACS4` encryption
and is excluded. Both `protectionType` and `contentEncrypted` are honored.

`node test/browser-server.cjs` opens a local plugin UI fixture with synthetic
sessions, library and progress. Its **Sign in (local simulator only)** popup
never contacts Thalia. This simulator is not part of the production plugin.

The [Docker test instructions](tools/pytolino/README.md#offline-dashboardapi-integration-fixture)
provide a separate synthetic dashboard/API fixture. With it running, execute
`node tools/pytolino/plugin-smoke.cjs` to verify the actual plugin client over
HTTP, including EPUB bytes, sidecars and read-only positions, without a reader.

## References

- [CrossPoint browser APIs](https://github.com/crosspoint-reader/crosspoint-reader/blob/develop/docs/webserver-endpoints.md)
- [CrossPoint events and sidecars](https://github.com/crosspoint-reader/crosspoint-reader/blob/develop/docs/plugin-events.md)
- [pytolino upstream](https://github.com/ImamAzim/pytolino) (GPLv3; dependency, no copied source)
- [Unofficial Tolino API documentation](https://github.com/cweiske/tolino-api-docs)
- [Original research](research.md) (historical research, not a compatibility guarantee)

This is an independent, unofficial integration. Review provider terms and
dependency-license obligations before distributing Docker images.
