# One-time local browser setup (no Docker)

This optional setup requires a computer; it is not smartphone-only QR pairing.
A supported phone-to-reader OAuth return flow has not been verified. A QR code
opening the reader's setup page alone cannot transfer the official login session.

For a manual smartphone diagnostic on a trusted LAN, run
`node scripts/phone-login-probe.cjs YOUR_PRIVATE_LAN_IP` and open the printed
temporary URL on the phone. This is only a disposable AuthApp popup test:
it checks message origin/source and reports message types and token-field
presence, never token values. No token upload endpoint or storage is provided.
The server expires after 20 minutes. The test does not install a reader session;
provider security checks and popup isolation can prevent a return message.

Requires **native Tolino-enabled firmware**, the Tolino plugin and existing
Tolino book sidecars. Stock firmware cannot use this session. No `settings.json`
changes are needed: native direct sync uses the valid fixed session file plus
the book's Tolino sidecar; native catalog checks this file only for `tolino-sync`.
Setup does not import webreader configuration into the browser plugin: doing so
could cause independent refresh-token rotation and invalidate the native session.
Use a new manual login, never a helper's saved refresh token.

From a fresh clone, with Node >=20 and installed Google Chrome:

```sh
npm ci
npm run setup
```

Optional convenience defaults (prefill only, never automatic login, consent or
write):

```sh
npm run setup -- --sd-root /absolute/path/to/reader-sd
npm run setup -- --sd-root /absolute/path/to/reader-sd --reader-origin http://192.168.1.40
```

For a simulator, pass its `fs_` directory with `--sd-root` when ready. These
options only populate editable UI fields; start login and the final
consent/install still require explicit user actions. Never pass credentials or
tokens as CLI arguments.

`npm ci` installs the exactly pinned `playwright-core` dependency from the
lockfile. No separate browser download is required: setup uses your installed
Google Chrome. No Docker, helper server, copied credentials or automatic login
are used. Setup itself installs nothing. If dependencies are missing, run
`npm ci` and restart setup.

1. The loopback UI opens in your default browser. If necessary, open the printed
   `http://127.0.0.1:PORT` address yourself.
2. Enter the reader's origin (for example `http://192.168.1.40`) and start login.
   Leave it blank if using mounted SD (the safest default). Only literal RFC1918
   private IPv4 origins or `127.0.0.1` are accepted, with optional port;
   no credentials, paths, public hosts or DNS.
   Confirm this IP really is your reader on a trusted network before uploading.
3. Sign in **manually** in the fresh installed Chrome window, starting at official
   `https://webreader.thalia.de`. No passwords belong in the setup UI or terminal.
   Provider redirects remain normal browser navigation. Automation detection,
   challenges or upstream changes may block login: inspect Chrome, then cancel
   and retry. There is no bypass or promise of successful account validation.
4. Setup waits for a successful official Thalia token exchange and a successful
   authenticated Tolino hardware request with the **same access token in that
   same disposable context**. Tokens from your other browser sessions are not
   imported. Correlated capture is not a library/account-access validation.
5. Explicitly consent to plaintext SD storage/replacement, possible local reader
   HTTP/file API exposure, and **native firmware's TLS without certificate
   verification**. Upstream SecureNet encrypts TLS but currently does not verify
   the provider certificate: network interception/impersonation is possible.
   This setup does not fix that trust posture or call it secure/verified.
   Choose:
   - **Reader API:** enable its webserver, verify the reader IP, and install.
     Confirm the displayed fixed target and explicitly accept trusting its
     unauthenticated file API. Before transmitting the session, setup checks
     `/api/status` for CrossPoint family, plugin API 1, version and device fields.
     This compatibility check is not cryptographic device authentication or
     proof of native Tolino firmware. An impostor on an untrusted LAN can fake it.
     HTTP additionally requires explicit plaintext LAN-transport consent.
     Anyone on the network may intercept HTTP; the unauthenticated reader API
     may expose this file to other clients even after HTTPS upload.
     Prefer mounted SD unless you trust the network and reader API.
     Node's HTTPS **handoff** uses normal certificate validation (no self-signed
     bypass); this does not change native firmware's unverified runtime TLS.
   - **Mounted SD (recommended default):** enter the absolute SD root you selected, e.g.
     `/Volumes/READER`, and write there. This is a local filesystem path, not a
     browser upload picker. Verify it carefully; safely eject after success.
     Directory symlinks below the selected root are refused.

The handoff is exclusively:

```text
/.crosspoint/plugins/tolino-sync/direct-session.json
```

Its JSON contains exactly `transportAccepted: true`, `hardwareId` (string) and
`refreshToken` (string). The flag records explicit consent to the disclosed
storage and transport risks, not proof of secure or verified transport.
No access token or password is stored.
Protect SD cards/backups: the refresh token grants account access. The reader
API creates directories with `POST /mkdir` (`path`, `name`) and uploads multipart
field `file` to `POST /upload?path=...&overwrite=1`; it does not invent an
`/api/files` write API. Upload must return the firmware's success confirmation.
If firmware rejects the directory/file, use SD rather than weakening protection.

The local server binds only `127.0.0.1`, rejects foreign Host/Origin requests,
requires a random pairing/CSRF header for actions/status, and never puts cloud
tokens in UI responses, logs or URLs. A fresh browser profile is created under
`scripts/.local-setup-profile-*` (including browser artifacts/download locations)
and removed when capture finishes or setup
closes. No trace/HAR or session export is kept locally. Chrome may temporarily
write cookies/tokens inside that disposable profile while running.

After successful handoff the server closes after a short UI grace period.
Cancel, Ctrl-C and a 15-minute timeout also clean up; OS force-kill/power loss
cannot guarantee cleanup. Remove any remaining `scripts/.local-setup-profile-*`
before retrying. Disable the reader webserver after handoff, then use native
Tolino sync. No helper is needed afterward. Refresh-token rotation/revocation
may require repeating setup; no background renewal service is installed.

Synthetic validation (no real account login):

```sh
node --test test/local-setup.test.cjs
```
