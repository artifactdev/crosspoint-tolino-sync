# Native library download: Xteink X4 Pro

Custom **2.0.0-tolino.1**, built from original
[CrossPoint 2.0.0](https://github.com/crosspoint-reader/crosspoint-reader/releases/tag/2.0.0),
commit `42d58daaabcf469a2e5e1ba871714fb9dcf51d29`, with the generic
[native catalog patch](./native-bulk.patch). No firmware fork is vendored here.

## On the reader

1. Install the matching helper and SD plugin update; retain your settings.
2. Flash the **X4 Pro** custom application firmware through the original
   CrossPoint update procedure. Back up the SD card first.
3. Open **Home > Plugins > Thalia / Tolino > Alle fehlenden EPUBs laden**.
4. Confirm **Fetch**. Wi-Fi must reach the helper.

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
Use **Sync Progress** inside a book for that; the Sync server's monotonic
five-minute cloud import remains independent.

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

Build the patched source with the official
[CrossPoint simulator](https://github.com/crosspoint-reader/crosspoint-simulator).
Use Python 3.12. [simulator.ini](./simulator.ini) is the macOS configuration:
copy it to the firmware checkout as `platformio.local.ini` (merge if one exists).
It selects the **X4 Pro touch/Home/frontlight profile**, not the default X4,
and shows version `2.0.0-tolino.1-simulator`.
On Linux, use the official Linux linker/compiler flags instead.
Do not share a build-output directory between a
native macOS simulator and a Linux Docker hardware build.

```sh
node tools/firmware/simulator-bulk-smoke.cjs /path/to/crosspoint-reader
```

For a custom output directory, set `CROSSPOINT_SIM_BINARY` to the built executable.
The test uses synthetic books and an authenticated loopback helper, never an
account. It navigates the actual native screens and verifies static/server
pagination, repeat/renamed-book skip, metadata preservation, collisions,
missing/malformed identities, empty files, failed-transfer cleanup,
confirmation cancellation and resumable retries.

The simulator currently buffers each HTTP response, unlike the physical SDK's
streaming downloader. In-transfer responsiveness/cancellation on real hardware
therefore remains a physical-device check, not a simulator-tested guarantee.
Successful X4 Pro compilation also does not replace a real-device flash test.
