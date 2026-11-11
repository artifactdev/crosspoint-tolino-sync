# Local development with the X4 Pro simulator

The native simulator runs the patched CrossPoint firmware in an SDL2 window,
including touch input, the Home key, plugins, SD files and the actual firmware
webserver. It is not an ESP32 emulator: it cannot run the hardware image
(`.bin`) produced by Actions. The same source is compiled separately for
the host.

The macOS procedure below has been tested locally. Linux/WSL requires the
different compiler flags listed below; this procedure has not yet been
validated end to end there. Native Windows is not supported.

## 1. Prerequisites

- Git, Node.js >=20, Python **3.12**, a C++ compiler and SDL2.
- macOS: Xcode Command Line Tools (`xcode-select --install`) and
  `brew install python@3.12 sdl2`.
- Debian/Ubuntu/WSL with graphical output:
  `sudo apt-get install build-essential python3.12 python3.12-venv libsdl2-dev libssl-dev libexpat1-dev curl git`.
  Python 3.12 availability depends on the distribution.
- For real cloud requests: a signed-in
  [Docker bridge with Sync server](../pytolino/DEPLOYMENT.md).
  Synthetic tests do not require a Thalia login.

Do not modify the global Python installation with firmware packages. A separate
virtual environment avoids conflicts; Python 3.15 is not a tested substitute
for 3.12 here.

## 2. Prepare separate working directories

Run the following commands in the same shell. `BRIDGE` refers to this
repository checkout, not the running Docker bridge:

```sh
cd /absolute/path/to/crosspoint-tolino-sync
export BRIDGE="$PWD"
export DEV="$HOME/crosspoint-tolino-dev"
export FIRMWARE="$DEV/crosspoint-reader"
mkdir -p "$DEV"
python3.12 -m venv "$DEV/venv"
"$DEV/venv/bin/python" -m pip install pioarduino==6.1.19

git clone --recurse-submodules \
  https://github.com/crosspoint-reader/crosspoint-reader.git "$FIRMWARE"
git -C "$FIRMWARE" checkout "$(cat "$BRIDGE/tools/firmware/upstream-revision")"
git -C "$FIRMWARE" submodule update --init --recursive
git -C "$FIRMWARE" apply --check "$BRIDGE/tools/firmware/native-bulk.patch"
git -C "$FIRMWARE" apply "$BRIDGE/tools/firmware/native-bulk.patch"
cp "$BRIDGE/tools/firmware/simulator.ini" "$FIRMWARE/platformio.local.ini"
```

These steps assume a **new** checkout. Do not overwrite or reapply the patch
to an existing checkout containing your own changes. The
`platformio.local.ini` file extends the original PlatformIO configuration
locally. The simulator is pinned to a tested commit; do not switch to its
latest version without validation.

**Linux/WSL:** In the copied `platformio.local.ini`, replace the macOS
`build_flags` lines `-Wno-c++11-narrowing` and
`-D_LIBCPP_DISABLE_AVAILABILITY` with:

```ini
  -lssl
  -lcrypto
  -Wno-deprecated-declarations
  -Wno-narrowing
```

Keep the X4 Pro defines (`SIMULATOR_DEVICE_X4_PRO`, `FREEINK_DEVICE_X4PRO`,
`BOARD_HAS_PSRAM`); do not accidentally select the original buttons-only
X4 profile.

## 3. Build

```sh
cd "$FIRMWARE"
export PLATFORMIO_BUILD_DIR="$DEV/native-build"
"$DEV/venv/bin/pio" run -e simulator
```

The first build downloads additional dependencies. The executable is then
available at `$DEV/native-build/simulator/program`. The separate build path
is important: **do not share the same `.pio/build` directory between host
and Docker/ESP32 builds**. PlatformIO checksum handling can otherwise delete
or rebuild the other target's output.

## 4. Prepare the simulated SD card and start the visible simulator

```sh
mkdir -p "$DEV/runtime/fs_/plugins/tolino-sync" "$DEV/runtime/fs_/Books/Tolino"
cp "$BRIDGE/plugins/tolino-sync/manifest.json" \
  "$BRIDGE/plugins/tolino-sync/device.json" \
  "$BRIDGE/plugins/tolino-sync/plugin.js" \
  "$BRIDGE/plugins/tolino-sync/README.md" \
  "$DEV/runtime/fs_/plugins/tolino-sync/"

cd "$DEV/runtime"
CROSSPOINT_SIM_HTTP_PORT=19080 \
CROSSPOINT_SIM_SCREEN_TEXT=1 \
  "$DEV/native-build/simulator/program"
```

The terminal remains occupied; use a second terminal for tests/builds.
Close the window or press `Ctrl+C` to stop the simulator. To start it again,
repeat only the final launch command. After C++ changes, rebuild and restart
the running program: it does not automatically load a new build. After plugin
changes, copy the four files again and reload the browser plugin page.

`$DEV/runtime/fs_` is the persistent SD card. Books, sidecars, reading positions
and settings remain there. Do not recreate or delete it on each launch;
back it up before major tests. `.simulator-nvs` stores the simulated device
identity. API keys and sessions used in the simulator are still real secrets:
do not commit the runtime directory or upload it as an Actions artifact.

### Controls and plugin setup

| Input | Action |
|---|---|
| Mouse click / drag | Touch / swipe |
| Up/down arrows | Page turning / navigation |
| Enter | Confirm |
| Escape | Back |
| H | X4 Pro Home key; hold for a long press |
| P / S | Power / simulated sleep |

1. Enable **Settings > Connectivity > Plugins** in the simulator.
2. Start **File Transfer > Join Network** and choose a simulated Wi-Fi network.
3. Open `http://127.0.0.1:19080/plugins` in a browser.
   The webserver runs **only during File Transfer**, not in every reader
   activity. WebSocket uses port **19081**; keep both ports available.
4. Choose **Connection settings > Docker helper (recommended)**.
   With Docker running on the same host, enter API origin
   `http://127.0.0.1:8081` and the API key from the bridge dashboard.
   This is neither the dashboard on 8080 nor the login browser on 6080.
   Save download folder `/Books/Tolino` and accept the transport warning.
5. Leave File Transfer and open **Home > Plugins > Thalia / Tolino**.
   Library browsing, individual downloads and **Alle fehlenden EPUBs laden**
   ("Download all missing EPUBs") use the native UI.
6. For real reading-position sync, also configure the
   [CrossPoint Sync connector](../crosspoint-sync/README.md),
   register downloaded books before their first sync, and configure
   Sync server `http://127.0.0.1:8082` in the reader using a separate Sync
   account. Then use **Sync Progress** inside a book. Plugin settings do not
   automatically configure this separate server.

The host simulator can reach host loopback; a physical reader cannot and
needs reachable LAN/HTTPS addresses. If the SDL window remains invisible,
check whether `SDL_VIDEODRIVER=dummy` is still set from an automated test;
unset it for interactive use. WSL requires WSLg or another suitable graphical
environment.

The download-complete screen waits for confirmation or Back. An unchanged
screen does not necessarily mean the simulator is stuck; terminal output
prefixed with `[SIM] SCREEN:` helps diagnose its state.

## 5. Repeatable tests without desktop automation

For bridge-backed reading positions, configure **Connectivity > KOReader
Sync** with the bridge's Sync port (normally 8082; for example
`http://192.168.8.3:18082`), **CrossPoint** server type, **Binary** document
matching and **Send Document Metadata** enabled. A Sync account is required
even if the container's web login is disabled. Choose **Ask Every Time** for
the explicit remote/local action rows. The patched reader registers a Tolino
book's metadata before fetching cloud progress, without publishing its current
page. Rebuild and restart older simulator binaries to receive this fix.

```sh
cd "$BRIDGE"
npm ci
npm run check
npm test
CROSSPOINT_SIM_BINARY="$DEV/native-build/simulator/program" \
  node tools/firmware/simulator-bulk-smoke.cjs "$FIRMWARE"
```

The final test starts the actual native reader with a synthetic loopback
helper, isolated temporary SD and SDL dummy output, then shuts it down.
It checks bulk downloads, pagination, repeat runs, renamed identities,
collisions and cancellation at confirmation. Keep ports 19086/19087 free.
It needs neither a running Docker container nor real credentials.

Test the native metadata-registration/first-pull flow with a synthetic Sync
server, exact saved offset and no cloud writes:

```sh
CROSSPOINT_SIM_BINARY="$DEV/native-build/simulator/program" \
  node tools/firmware/simulator-direct-sync-smoke.cjs --bridge
CROSSPOINT_SIM_BINARY="$DEV/native-build/simulator/program" \
  node tools/firmware/simulator-direct-sync-smoke.cjs --bridge --filename
CROSSPOINT_SIM_BINARY="$DEV/native-build/simulator/program" \
  node tools/firmware/simulator-direct-sync-smoke.cjs --bridge --registration-failed
```

The last two cases verify explicit failures without uploading reader progress.

For the **browser-only plugin UI test** without firmware:

```sh
node test/browser-server.cjs
```

Use the printed local URL. Its login is a synthetic fixture, not a Thalia
login. Additional real webserver/Docker fixtures are described in the
[bridge development documentation](../pytolino/README.md).

## Limitations

The simulator does not test real radio, power-saving, flash or e-ink timings.
HTTP responses are buffered; cancellation during a real streaming transfer
must be tested on hardware. A successful native simulator build replaces
neither the separate X4 Pro hardware build in Actions nor a flash/usability
test on a physical reader.
