Thalia / Tolino - SD plugin (experimental)

Helper mode supports a native book catalog and EPUB downloads directly on the
reader. A browser is needed only for initial connection setup and Thalia login.
Imported webreader-session mode remains browser-only.

For a no-device UI test, run `node test/browser-server.cjs` from the project
root and open the printed localhost URL. The local-only sign-in simulator uses
synthetic credentials and never contacts Thalia; it does not test real account
authentication. See the project README for the full test steps.

1. Enable Settings > Connectivity > Plugins.
2. Start File Transfer in Join Network mode.
3. Open http://crosspoint.local/plugins (or your device IP + /plugins).
4. Open "Connection settings". Choose "Docker helper (recommended)" to use
   the optional Tolino Bridge: sign in on its local dashboard, enter the
   helper LAN URL (for example http://192.168.1.10:8081) and API key, set the
   download folder, acknowledge the warning, and save. No Thalia tokens
   are copied to the reader. Then continue with Load cloud library.
5. Alternatively choose "Imported webreader session". In your computer
   browser, open webreader.mytolino.com and Developer Tools
   > Network before signing in through Thalia.de.
6. Copy hardware_id from a registerhw request's headers and refresh_token
   from the Thalia auth/oauth2/token response. Keep these private.
7. Save them in the plugin, then select Load cloud library.
8. For native use, leave File Transfer and open Home > Plugins > Thalia / Tolino.
   The reader fetches all cloud books from the helper. Open a book's details
   and select Fetch to download it. No browser or File Transfer is needed.
   Reopen the catalog to refresh it. Cloud progress appears in book details;
   missing progress is not assumed to be zero. DRM/unsupported books are
   labelled, and the helper refuses their download even if Fetch is selected.
   The saved download folder is shared with browser setup (save again once
   after upgrading). Native and browser filenames use the book title plus .epub.
   Unsafe characters are replaced and long names shortened to the firmware's
   100-byte UTF-8 limit. Dashboard downloads use the same title filename.
9. Alternatively, in the browser select Download EPUB to reader SD. This streams from the helper through
   CrossPoint's firmware onto its SD card, not to the computer. Keep both
   the browser page and File Transfer running until complete. The default
   destination is /Books/Tolino. Leave File Transfer, then open the book
   in the reader library. The helper dashboard's download saves to the
   computer instead.
10. Refresh cloud reading positions shows read-only cloud progress.
    While this browser plugin remains open with a loaded library, it refreshes
    these cloud references automatically every five minutes. This never changes
    the saved reader position.

The Mac simulator uses http://127.0.0.1:8081 when the helper runs on the same Mac.
A physical reader needs the helper host's reachable LAN address instead.
Include device.json when installing/upgrading; older firmware without native
device-catalog support can still use the browser interface.

Browser downloads check the configured SD folder first. Existing title.epub,
legacy SHA256.epub and title-SHA256.epub files are marked Already on SD, and their download
button is disabled. A fresh check also runs immediately before downloading.
Skipped downloads leave the EPUB, sidecar and reading progress unchanged.
Other filenames are matched by the Tolino ID in the adjacent metadata sidecar.
Conflicting title filenames belonging to another Tolino ID are never overwritten.
New browser downloads use the same title.epub name as the native catalog.
Existing duplicates are not deleted; moved files outside this folder and
renamed files without a matching sidecar cannot be reliably identified.
An unreadable SD listing or an empty existing file blocks the download.

The unmodified native catalog does not have this check: Fetch can overwrite an
existing book and clear its reader cache. Use the browser check to avoid repeat
downloads. This release intentionally does not modify firmware.

Only Thalia.de accounts (reseller 3), personal uploads, and unprotected or
watermarked EPUBs are supported. Adobe DRM/ACSM, PDFs, audiobooks and Kobo
accounts are not supported. No DRM removal is performed.

IMPORTANT: The SD plugin alone does not synchronize saved reader positions.
The optional CrossPoint Sync server connector supports exact manual progress
sync without a firmware patch; see tools/crosspoint-sync/README.md in the project
repository. Register downloaded metadata first, use binary matching, then use
Sync Progress in the reader. Normal book opening does not automatically restore
cloud progress. Cloud writes require explicit helper and connector opt-in.

SECURITY: Tokens/API keys are plaintext on the SD card and accessible over the device
web server. CrossPoint's relay does not verify TLS certificates. Use only
a trusted network and acknowledge the warning before connecting. Never
share tokens, runtime settings or unredacted network logs.
Helper HTTP traffic exposes the API key on the network; use a trusted LAN
or an HTTPS reverse proxy. The default helper admin/browser are local;
the separate Unraid configuration requires admin and VNC passwords.
Docker can keep encrypted session tokens across restarts and renew them
automatically. Optional saved Thalia credentials remain on Docker, never SD.

Clear local session overwrites local credentials and cloud-state caches;
it does not revoke the Thalia session or delete books. It is not secure
erasure of SD sectors or backups. Re-import a new web-reader session if
refresh fails. Do not log out of the web-reader session while reusing it.

The plugin targets the CrossPoint develop SD-plugin/browser API. Cloud
endpoints are unofficial and may change. The Docker browser/library path
has loaded real Thalia books. Companion downloads/cloud-state and the plugin
have automated contract tests; physical-reader validation is still required.

Project, setup details and limitations:
https://github.com/artifactdev/crosspoint-tolino-sync
