# Native library download: Xteink X4 Pro

Custom **2.0.0-tolino.2**, built from original
[CrossPoint 2.0.0](https://github.com/crosspoint-reader/crosspoint-reader/releases/tag/2.0.0),
commit `42d58daaabcf469a2e5e1ba871714fb9dcf51d29`, with the generic
[native catalog patch](./native-bulk.patch). No firmware fork is vendored here.

## On the reader

1. Install the matching SD plugin update; retain your settings.
2. Flash the **X4 Pro** custom application firmware through the original
   CrossPoint update procedure. Back up the SD card first.
3. Open **Home > Plugins > Thalia / Tolino > Alle fehlenden EPUBs laden**.
4. Confirm **Fetch**. Wi-Fi must reach Tolino directly or the configured helper.

## Recommended: permanent Docker bridge

Configure **Docker helper (recommended)** in the plugin with the bridge API
origin and API key. Keep Docker running for login renewal, library access and
downloads. Bulk downloads use the same bridge. For exact reader/cloud progress,
also configure the [CrossPoint Sync connector](../crosspoint-sync/README.md)
and the reader's Sync settings. No direct-session file is required.

In the reader's **Connectivity > KOReader Sync** settings, select
**CrossPoint**, **Binary** document matching and enable **Send Document
Metadata**. Choose **Ask Every Time** to show **Apply remote progress** /
**Upload local progress** instead of Smart Sync's automatic decision.
For downloaded Tolino books, the patched firmware registers the sidecar book
identity before its first progress GET, without uploading the current page.
Failed registration stops the sync; filename matching is rejected explicitly.
This fixes first-pull discovery and requires a rebuilt firmware/simulator;
updating the container alone does not update the reader executable.
The Sync app's library is separate from the bridge's cloud-library dashboard.
Opening a book alone does not restore its cloud position: use **Sync Progress**
and **Apply remote progress** first.

A native direct-session file takes precedence over helper settings. When
deliberately returning from direct mode, remove that file and any rotation
backup/temp files from SD after checking them; never copy tokens into the
helper settings.

## Experimental: without a helper container or Sync server

Smartphone-only QR login is not implemented: a supported OAuth return flow to
the reader has not been verified. The optional setup below requires a computer.

Run the [one-time local browser setup](../setup/README.md) with `npm run setup`.
It opens the official login in installed Chrome and transfers only a newly
captured refresh token and device identity to your SD card or reader.
It exits after handoff: no local process or container is needed for normal use.
Manual login is required; account access and provider anti-bot compatibility
have not been validated by synthetic tests.

The fixed `/.crosspoint/plugins/tolino-sync/direct-session.json` opts this
plugin into native direct mode. The firmware refreshes and persists rotated
tokens, fetches the account inventory and supported EPUB download URLs, and
performs individual/bulk downloads with the same identity-based protection.
No helper credentials are sent to the cloud or account headers to EPUB CDNs.

Inside a Tolino book, **Sync Progress** now talks directly to Tolino. It converts
exact XPath/RMSDK anchors against the local EPUB (including Unicode byte offsets),
verifies its binary partial-MD5 identity against a temporary cloud download
(cached for the current process, removed afterward),
checks fresh cloud revisions, creates a missing bookmark using the provider's
server-assigned slot, and only reports success after cloud readback.
No KOReader/CrossPoint Sync server credentials are required for these books.
Other books and stock sync behavior are unchanged.

This version keeps **manual Sync Progress**; it does not add background radio
wakeups or periodic reading-position application. The old helper/Sync server's
five-minute worker is not running on the reader. Cover-grid UI is also unchanged.

Runtime transport inherits upstream SecureNet's **disabled certificate
verification** and sessions are plaintext on SD, potentially exposed by the
reader's file server. Setup requires explicit acceptance, not a claim of secure
TLS identity verification. Use trusted networks, prefer mounted SD handoff, and
disable the reader file server afterward. No native password grant, embedded
browser, credential interception from other contexts or DRM removal is added.

Direct mode fails visibly on expired/invalid sessions, unsupported responses or
unresolvable exact positions. It never silently switches to the helper after
an ambiguous cloud write. To deliberately return to the existing helper path,
remove the direct session from SD (including any backup after checking it), then
configure the helper normally. Do not have the browser plugin independently
refresh the native session; its imported-session setting is a separate mode.

The reader downloads all supported EPUBs, not just the current catalog page,
with title filenames and adjacent Tolino metadata. Existing downloads, including
old hash names and renamed books, are recognized by their sidecar's `tolino_id`.
They are not downloaded again; their metadata and reading cache are untouched.
Unsupported/DRM books are excluded from the bulk feed.

A title occupied by another identity, missing/unreadable target metadata, empty
existing file, or failed download stops the operation explicitly. Fix the problem
and retry: completed books are skipped. Back/Cancel stops a transfer; incomplete
downloads use the original firmware's `.part` staging and cleanup.
The confirmation can also be cancelled without downloading anything.

This is **book download**, not automatic application of reading positions.
Use **Sync Progress** inside a book for that, directly or through the optional
Sync server; that server's monotonic five-minute cloud import remains independent.

Stock CrossPoint ignores these extra manifest fields: it still offers individual
downloads, but does not provide this native duplicate protection or bulk action.

## GitHub Actions and downloads

[The workflow](../../.github/workflows/firmware-x4pro.yml) runs on relevant pushes
to `main`, pull requests, and **Actions > Xteink X4 Pro firmware > Run workflow**.
It must first be committed and pushed to this repository to appear on GitHub.
It checks out original firmware and its exact SDK submodule, applies the patch
with a mandatory compatibility check, then builds official target
**`x4pro-gh_release`**: ESP32-S3, `esp32-s3-devkitc1-n16r8`, PSRAM.
It does not build the incompatible X3/X4/X4C image.

Successful runs produce downloadable Actions artifacts. Push/manual runs also
publish a uniquely tagged GitHub **prerelease**, containing:

- `crosspoint-tolino-x4pro.bin`: application update image, not factory/full flash;
- SD plugin ZIP and the firmware patch;
- exact source revisions in `build-info.txt`, plus `SHA256SUMS`.

Version tags matching `v*` also trigger the build. Pull requests only build/test
and upload Actions artifacts; only the separate release job receives write
permission. The workflow also runs the exact-position host C++ tests.
The [registry deployment guide](../pytolino/DEPLOYMENT.md) explains how to
install the all-in-one Docker bridge and Sync server on a different host.

The default original revision is pinned in [upstream-revision](./upstream-revision).
For a newer official release, supply its tag/commit in the manual workflow.
If the patch no longer applies or the target stops compiling, the run fails:
it never silently publishes unpatched firmware. Update and retest the patch
before changing the default pin.

Builds use the same [Docker toolchain](./Dockerfile) locally and on Actions.
Dependencies follow upstream's pioarduino 6.1.19 setup. This reproduces the source
and build procedure, but does not claim bit-for-bit reproducible binaries:
upstream has dependency ranges and downloaded toolchains.
No helper credentials, cloud tokens, SD contents, or upstream LCP release keys
are included. Self-built firmware lacks the official LCP enrollment credential;
this feature only downloads EPUBs already supported without DRM removal.

## Local hardware build

Clone original firmware recursively into a separate directory and check out the
pinned commit. Apply the patch from this repository:

```sh
git -C /path/to/crosspoint-reader apply --check /path/to/bridge/tools/firmware/native-bulk.patch
git -C /path/to/crosspoint-reader apply /path/to/bridge/tools/firmware/native-bulk.patch
docker build -t tolino-firmware-builder tools/firmware
docker run --rm -v /path/to/crosspoint-reader:/firmware \
  -v tolino_firmware_platformio:/root/.platformio tolino-firmware-builder \
  sh -ec 'pio pkg install -e x4pro-gh_release
    if [ -x /root/.platformio/penv/bin/python ]; then
      /root/.platformio/penv/bin/python -m pip install pioarduino==6.1.19
    fi
    pio run -e x4pro-gh_release -j 2'
```

The image is `.pio/build/x4pro-gh_release/firmware.bin` in that checkout.
Never flash it to a different device model.

## Simulator verification

For a complete local development setup, visible startup commands, persistent
simulated SD, X4-Pro controls and plugin/bridge configuration, see
[Local simulator development](./SIMULATOR.md).

Build the patched source with the official
[CrossPoint simulator](https://github.com/crosspoint-reader/crosspoint-simulator).
Use Python 3.12. [simulator.ini](./simulator.ini) is the macOS configuration:
copy it to the firmware checkout as `platformio.local.ini` (merge if one exists).
It selects the **X4 Pro touch/Home/frontlight profile**, not the default X4,
and shows version `2.0.0-tolino.2-simulator`.
On Linux, use the official Linux linker/compiler flags instead.
Do not share a build-output directory between a
native macOS simulator and a Linux Docker hardware build.

```sh
node tools/firmware/simulator-bulk-smoke.cjs /path/to/crosspoint-reader
node tools/firmware/simulator-bulk-smoke.cjs /path/to/crosspoint-reader --direct
CROSSPOINT_SIM_BINARY=/path/to/program node tools/firmware/simulator-direct-sync-smoke.cjs
```

For a custom output directory, set `CROSSPOINT_SIM_BINARY` to the built executable.
The test uses synthetic books and an authenticated loopback helper, never an
account. It navigates the actual native screens and verifies static/server
pagination, repeat/renamed-book skip, metadata preservation, collisions,
missing/malformed identities, empty files, failed-transfer cleanup,
confirmation cancellation and resumable retries.

`--direct` uses a simulator-only loopback Tolino fixture instead of a helper,
checking token refresh/rotation, authenticated inventory/download-info and
credential-free CDN requests. The direct sync smoke opens a valid synthetic
EPUB in the actual reader, invokes X4 Pro Home-key sync with no server
credentials and checks first-bookmark creation plus readback. The fixture
override is compiled only in the simulator, never in the hardware image.

The simulator currently buffers each HTTP response, unlike the physical SDK's
streaming downloader. In-transfer responsiveness/cancellation on real hardware
therefore remains a physical-device check, not a simulator-tested guarantee.
Successful X4 Pro compilation also does not replace a real-device flash test.
