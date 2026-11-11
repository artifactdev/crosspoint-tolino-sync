# Exact Tolino positions through CrossPoint Sync

This is a **server connector**, not a firmware patch. The reader's existing
manual **Sync Progress** action exchanges actual EPUB XPath positions:

`CrossPoint <-> CrossPoint Sync <-> local Tolino helper <-> Tolino`

Downloading or normally opening a book alone does **not** import cloud progress.
Open the book, run Sync Progress, and choose the cloud position. Keep the
reader's sync behaviour at **Ask every time**, not Smart/furthest-progress,
when intentionally moving backwards in a book.

## Install the pinned server connector

Requires Git and Node 24. Use a separate checkout outside this plugin repository:

```sh
git clone https://github.com/crosspoint-reader/crosspoint-sync.git /your/path/crosspoint-sync
git -C /your/path/crosspoint-sync checkout 626e33f01399adefc77ad10db529926bb06d00d8
git -C /your/path/crosspoint-sync apply --check /absolute/path/to/this/repository/tools/crosspoint-sync/tolino.patch
git -C /your/path/crosspoint-sync apply /absolute/path/to/this/repository/tools/crosspoint-sync/tolino.patch
cd /your/path/crosspoint-sync
npm ci
npm run build
npx vitest run test/tolino.test.ts test/bookfusion-position.test.ts
```

Do not apply the patch to an arbitrary upstream revision. The patch also adds
the connector to Settings and to strict, per-book refresh on KOSync reads.
The server operator sets `TOLINO_HELPER_URL` to the helper's origin. The
connector's API-key field is the existing helper API key, **not** your Thalia
password. Accounts use the server's existing encrypted credential storage.

### Docker / Unraid

Create a separate persistent encryption key outside the repository:

```sh
umask 077
openssl rand -hex 32 > /your/private/path/sync-storage-key
export SYNC_STORAGE_KEY_PATH=/your/private/path/sync-storage-key
export CROSSPOINT_SYNC_CHECKOUT=/your/path/crosspoint-sync
# Also set HELPER_API_KEY_PATH and HELPER_STORAGE_KEY_PATH as in the helper guide.
docker compose -f tools/pytolino/compose.yaml -f tools/crosspoint-sync/compose.yaml up -d --build
```

Open `http://127.0.0.1:8082/app/`, create/sign into a CrossPoint Sync account,
and connect **Tolino / Thalia (local helper)** in Settings. The helper must already
be signed into Thalia. Keep both data volumes and encryption keys across upgrades.
Never use `down -v`. Do not regenerate keys for an existing installation.

The supplemental Compose file shares the helper's private Docker network.
For Unraid, use the same two-file deployment with persistent Docker volumes.
For access from a physical reader, configure TLS through your trusted reverse
proxy, set `SYNC_BIND_ADDRESS` appropriately, `SYNC_ALLOW_HTTP_LOCALHOST=0`,
and `SYNC_TRUST_PROXY=1` only behind that proxy. Do not expose registration,
the helper dashboard, or unencrypted credential APIs to the Internet.
Disable new sync-account registration after setup with
`SYNC_REGISTRATION_DISABLED=1`.

## Register downloaded books before the first sync

This prevents a first upload from replacing an existing cloud position with the
reader's book-start position. It sends **metadata only**, never reading progress.
Mount the reader's SD card (or use the simulator's books directory). Put your
CrossPoint Sync password in a private file, outside the repository:

```sh
node tools/crosspoint-sync/register-books.mjs \
  /your/path/crosspoint-sync /mounted/sd/Books/Tolino \
  http://127.0.0.1:8081 /your/private/path/helper-api-key \
  http://127.0.0.1:8082 YOUR_SYNC_USERNAME /your/private/path/sync-password
```

Without the last three arguments the command only verifies editions and exact
cloud-locator roundtrips. It never writes to Tolino. Older plugin sidecars with
`tolino_identifier` are accepted; new downloads include the native
CrossPoint Sync routing field `tolino_id`.

Configure the reader's sync settings:

- Server: your CrossPoint Sync URL, **not** the helper API URL.
- Protocol profile: **CrossPoint**.
- Document matching: **Binary** (filename matching is intentionally refused).
- Metadata: enabled.
- Sync behaviour: **Ask every time**.
- Credentials: the CrossPoint Sync account, **not** the Thalia account.

Then open the downloaded book and use **Sync Progress** to apply the cloud
position. Register newly downloaded books before their first sync as well.

## Explicitly enabling reader-to-cloud writes

The server checks matched Tolino books every five minutes, even without an open
browser. Progress requests from the reader also perform a fresh cloud check.
Inbound Tolino positions are imported only when **strictly further**
than stored progress; equal or lower percentages cannot move the reader back.
Tolino sometimes retains its modification timestamp while advancing. Accepted
advances use the server's observation time for local sync ordering.
The exact locator is retained, not estimated from the percentage. Applying it
on the stock reader still requires manual **Sync Progress**.

The bridge table refreshes every five minutes while open and after a confirmed
helper push (detected by its local status poll). The open browser plugin refreshes
its reference display every five minutes after loading the library. Those displays
show actual cloud values, even when a lower cloud value is not imported.

Pulls work without write access. Sending progress requires **both**:

1. `HELPER_SYNC_WRITES=1` on the helper, followed by container recreation.
2. Enable the connector's **Send reading positions** option (and optionally
   **Send finished reading positions**) in CrossPoint Sync Settings.

The helper re-fetches the current cloud revision/bookmark and refuses changed
or newer state. It preserves the provider bookmark slot/revision, writes an
exact point, omits stale page numbers, and reads back the result. Uncertain
writes are not blindly retried. For books without a cloud bookmark, the helper
uses the official client's collection-level `add` operation; Tolino assigns the
bookmark slot and revision. The first write is also read back and confirmed.
No prior opening in the official webreader is required.
The helper dashboard separately displays the last cloud-write outcome: the
reader's "Progress uploaded!" only acknowledges acceptance by the Sync server,
not completion of its asynchronous Tolino delivery.

Conversion uses one-based RMSDK DOM indices and UTF-8 byte offsets, with
CrossPoint's codepoint XPath offsets. Unknown locators, split Unicode characters,
DRM, mismatched editions, and missing metadata fail explicitly; percentages
are never used to invent a chapter or locator.

## Scope

- No firmware changes; no automatic restore on normal book opening.
- No automatic background sync on sleep/exit.
- No direct-session/helper fallback inside the plugin.
- The native catalog remains a list; a cover grid is deferred.
- Cloud writes are disabled by default. Test writes with synthetic books, not
  by changing a real account's reading history.
