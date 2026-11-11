"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SESSION_DIR = "/.crosspoint/plugins/tolino-sync";
const SESSION_FILE = "direct-session.json";
const TOKEN_URL = "https://www.thalia.de/auth/oauth2/token";
const WEBREADER = "https://webreader.thalia.de";
class SetupError extends Error {}
const text = value => typeof value === "string" && value.length > 0 &&
  value.length <= 32768 && !/[\s\x00-\x1f\x7f]/u.test(value);

function readerOrigin(input) {
  if (typeof input !== "string" || input !== input.trim()) throw new SetupError("Enter a reader origin.");
  let url;
  try { url = new URL(input); } catch { throw new SetupError("Invalid reader origin."); }
  const octets = url.hostname.split(".").map(Number);
  const privateIP = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) &&
    octets.every(n => n >= 0 && n <= 255) &&
    (url.hostname === "127.0.0.1" || octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
  const literal = /^https?:\/\/(\d+\.\d+\.\d+\.\d+)(?::\d+)?\/?$/.exec(input);
  if (!["http:", "https:"].includes(url.protocol) || !privateIP || !literal || literal[1] !== url.hostname ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      url.port === "0") {
    throw new SetupError("Use only an HTTP(S) private or 127.0.0.1 IPv4 reader origin, e.g. http://192.168.1.40 (no path).");
  }
  return url.origin;
}

function hardwareURL(url) {
  return (url.origin === "https://bosh.pageplace.de" &&
    ["/bosh/rest/v2/registerhw", "/bosh/rest/registerhw", "/bosh/rest/inventory/delta"].includes(url.pathname)) ||
    (url.origin === "https://api.pageplace.de" &&
      /^\/v1\/devices\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/userid$/i.test(url.pathname));
}

// Correlate successful authenticated requests with the exact access token from
// the observed exchange, never with an arbitrary hardware ID seen nearby.
class SessionCapture {
  constructor() {
    this.tokens = new Map();
    this.devices = new Map();
  }
  observe(urlString, method, status, headers = {}, body) {
    if (status < 200 || status >= 300) return null;
    let url;
    try { url = new URL(urlString); } catch { return null; }
    if (urlString === TOKEN_URL && method === "POST") {
      if (!body || !text(body.access_token) || !text(body.refresh_token)) {
        throw new Error("The official token exchange returned no usable session.");
      }
      this.tokens.clear();
      this.tokens.set(body.access_token, body.refresh_token);
    } else {
      let hardwareId;
      const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      if (url.origin === "https://bosh.pageplace.de" &&
          ["/bosh/rest/v2/registerhw", "/bosh/rest/registerhw", "/bosh/rest/inventory/delta"].includes(url.pathname)) {
        hardwareId = lower.hardware_id;
      } else if (url.origin === "https://api.pageplace.de") {
        hardwareId = /^\/v1\/devices\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/userid$/i.exec(url.pathname)?.[1];
      }
      if (text(hardwareId) && text(lower.t_auth_token) && text(lower.reseller_id)) {
        this.devices.set(lower.t_auth_token, hardwareId);
      }
    }
    if (this.tokens.size > 32 || this.devices.size > 32) throw new Error("Too many authentication attempts; restart setup.");
    for (const [access, refreshToken] of this.tokens) {
      const hardwareId = this.devices.get(access);
      if (hardwareId) return { hardwareId, refreshToken };
    }
    return null;
  }
  clear() { this.tokens.clear(); this.devices.clear(); }
}

function sessionJSON(session) {
  if (!session || !text(session.hardwareId) || !text(session.refreshToken)) throw new Error("No correlated session captured.");
  return JSON.stringify({ transportAccepted: true, hardwareId: session.hardwareId, refreshToken: session.refreshToken }) + "\n";
}

async function installReader(origin, session, insecureConsent, fetchImpl = fetch) {
  origin = readerOrigin(origin);
  if (origin.startsWith("http:") && insecureConsent !== true) {
    throw new SetupError("HTTP exposes the session on the network. Explicit consent required; prefer SD.");
  }
  const send = async (endpoint, options) => {
    try {
      return await fetchImpl(origin + endpoint, {
        ...options, redirect: "error", signal: AbortSignal.timeout(15000),
      });
    } catch { throw new SetupError("Reader unavailable or TLS/redirect rejected. Check its address or use SD."); }
  };
  const statusResponse = await send("/api/status", { method: "GET" });
  let status;
  try { status = statusResponse.ok ? await statusResponse.json() : null; } catch { status = null; }
  if (!status || status.firmwareFamily !== "crosspoint" || status.pluginApi !== 1 ||
      typeof status.version !== "string" || !status.version ||
      typeof status.device !== "string" || !status.device) {
    throw new SetupError("Target did not identify as a compatible CrossPoint reader. No session sent; use SD.");
  }
  let parent = "/";
  for (const name of SESSION_DIR.slice(1).split("/")) {
    const response = await send("/mkdir", {
      method: "POST", body: new URLSearchParams({ path: parent, name }),
    });
    if (!response.ok && !(response.status === 400 && (await response.text()) === "Folder already exists")) {
      throw new SetupError("Reader could not create the session directory. Use the mounted SD option.");
    }
    parent = (parent === "/" ? "" : parent) + "/" + name;
  }
  const form = new FormData();
  form.append("file", new Blob([sessionJSON(session)], { type: "application/json" }), SESSION_FILE);
  const response = await send("/upload?path=" + encodeURIComponent(SESSION_DIR) + "&overwrite=1", {
    method: "POST", body: form,
  });
  if (!response.ok || (await response.text()) !== "File uploaded successfully: " + SESSION_FILE) {
    throw new SetupError("Reader did not confirm the session upload. Use SD or retry.");
  }
}

async function installSD(directory, session) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("Select an absolute mounted SD directory.");
  const root = await fs.realpath(directory).catch(() => { throw new Error("SD directory not found."); });
  if (!(await fs.stat(root)).isDirectory() || root === path.parse(root).root) throw new Error("Select the mounted SD root, not the system root.");
  let folder = root;
  for (const component of SESSION_DIR.slice(1).split("/")) {
    folder = path.join(folder, component);
    await fs.mkdir(folder, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await fs.lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("SD session directories must not be symlinks.");
  }
  const destination = path.join(folder, SESSION_FILE);
  const pending = path.join(folder, ".session-" + crypto.randomBytes(12).toString("hex"));
  try {
    const handle = await fs.open(pending, "wx", 0o600);
    try { await handle.writeFile(sessionJSON(session)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(pending, destination);
  } finally { await fs.rm(pending, { force: true }); }
}

function cliDefaults(args) {
  const defaults = { sdRoot: "", reader: "" };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i], value = args[i + 1];
    if (!["--sd-root", "--reader-origin"].includes(option) || seen.has(option) ||
        typeof value !== "string" || value.startsWith("--")) {
      throw new SetupError("Usage: npm run setup -- [--sd-root /absolute/path] [--reader-origin http://192.168.1.40]");
    }
    seen.add(option);
    if (option === "--reader-origin") defaults.reader = readerOrigin(value);
    else {
      if (!path.isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/u.test(value)) {
        throw new SetupError("--sd-root requires an absolute directory path without control characters.");
      }
      defaults.sdRoot = value;
    }
  }
  return defaults;
}

function htmlAttribute(value) {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function setupHTML(csrf, defaults) {
  return `<!doctype html><meta charset="utf-8"><title>Tolino setup — native firmware required</title>
<h1>Tolino one-time setup (native firmware required, no Docker)</h1>
<p>Requires native Tolino-enabled firmware and existing Tolino book sidecars.
No settings.json modification is needed. This local setup exits after handoff.</p>
<p>Sign in manually in a fresh installed Chrome window on the official Thalia webreader.
No passwords are requested here. Use Cancel or Ctrl-C to cancel; it expires after 15 minutes.</p>
<label>Reader origin (optional; mounted SD is safest): <input id="reader" placeholder="http://192.168.1.40" value="${htmlAttribute(defaults.reader)}"></label>
<button id="login">Start official browser login</button>
<p id="status">Ready. No account login has been validated.</p>
<p id="target">Reader target not set.</p>
<p>The refresh token grants account access. The reader stores it in plaintext at
${SESSION_DIR}/${SESSION_FILE}. Backups and anyone with SD/webserver access may expose it.
Use mounted SD instead of an untrusted or unencrypted reader API.</p>
<p>Native firmware currently uses upstream SecureNet: TLS is encrypted but server
certificate verification is disabled. A network attacker could impersonate the
provider. This setup does not make native transport certificate-verified.</p>
<label><input id="consent" type="checkbox">I explicitly accept plaintext SD storage/replacement, possible local reader HTTP/file API exposure, and native TLS WITHOUT certificate verification.</label><br>
<p><strong>Recommended default: mounted SD (no reader API exposure during handoff).</strong><br>
<label>Mounted SD root (absolute path): <input id="sd" placeholder="/Volumes/READER" value="${htmlAttribute(defaults.sdRoot)}"></label>
<button id="write" disabled>Write to this SD directory</button></p>
<details><summary>Optional reader API handoff (trusted network only)</summary>
<label><input id="insecure" type="checkbox">I additionally accept sending this session over unencrypted HTTP on my trusted network.</label><br>
<label><input id="verified" type="checkbox">I verified the displayed IP is my reader and trust everyone with access to its unauthenticated file API.</label><br>
<button id="install" disabled>Install via reader file API</button>
</details>
<button id="cancel">Cancel and clean up</button>
<script nonce="${csrf}">
const $ = id => document.getElementById(id);
let busy = false;
async function call(route, data = {}) {
 const r = await fetch(route, {method:'POST', headers:{'Content-Type':'application/json','X-Setup-CSRF':'${csrf}'}, body:JSON.stringify(data)});
 const value = await r.json(); if (!r.ok) throw new Error(value.message); return value;
}
async function action(route, data) {
 if (busy) return; busy = true;
 try { const s = await call(route, data); $('status').textContent = s.message; }
 catch(e) { $('status').textContent = e.message; } finally { busy = false; }
}
$('login').onclick = () => action('/start', {reader:$('reader').value});
$('install').onclick = () => action('/install', {consent:$('consent').checked, insecureConsent:$('insecure').checked, readerVerified:$('verified').checked});
$('write').onclick = () => action('/sd', {consent:$('consent').checked, directory:$('sd').value});
$('cancel').onclick = () => action('/cancel');
const poll = setInterval(async () => {
 try {
 const r = await fetch('/status', {headers:{'X-Setup-CSRF':'${csrf}'}});
 if (!r.ok) return;
 const s = await r.json(); if (!busy) $('status').textContent = s.message;
 $('target').textContent = s.target ? 'Fixed reader target: ' + s.target : 'SD-only setup';
 if (s.started) $('reader').disabled = true;
 $('install').disabled = !s.captured || !s.reader; $('write').disabled = !s.captured;
 if(s.done) clearInterval(poll);
 } catch { clearInterval(poll); }
}, 1000);
</script>`;
}

function openUI(origin) {
  const [command, args] = process.platform === "darwin" ? ["open", [origin]] :
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", origin]] : ["xdg-open", [origin]];
  const child = spawn(command, args, { stdio: "ignore" });
  child.on("error", () => {});
}

async function createSetup({ launch, graceMs = 1800, lifetimeMs = 15 * 60 * 1000, defaults = cliDefaults([]) } = {}) {
  defaults = cliDefaults([
    ...(defaults.sdRoot ? ["--sd-root", defaults.sdRoot] : []),
    ...(defaults.reader ? ["--reader-origin", defaults.reader] : []),
  ]);
  const csrf = crypto.randomBytes(32).toString("hex");
  const capture = new SessionCapture();
  let origin, reader = "", session, browser, profile, timer, finishing, closingBrowser, active = false;
  let done = false, message = "Ready. No account login has been validated.";
  let browserTask = Promise.resolve();
  async function closeBrowser() {
    if (closingBrowser) return closingBrowser;
    closingBrowser = (async () => {
      if (browser) {
        await browser.close();
        browser = undefined;
      }
      if (profile) {
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        profile = undefined;
      }
    })();
    try { await closingBrowser; } finally { closingBrowser = undefined; }
  }
  async function finish() {
    if (finishing) return finishing;
    done = true;
    finishing = (async () => {
      clearTimeout(timer);
      try {
        await browserTask;
        await closeBrowser();
      } finally {
        capture.clear(); session = undefined;
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    })();
    return finishing;
  }
  function laterFinish() {
    clearTimeout(timer);
    timer = setTimeout(() => finish().catch(() => {
      console.error("Cleanup failed. Remove scripts/.local-setup-profile-* before retrying.");
      process.exitCode = 1;
    }), graceMs);
  }
  async function startBrowser() {
    profile = path.join(__dirname, ".local-setup-profile-" + crypto.randomBytes(12).toString("hex"));
    await fs.mkdir(profile, { mode: 0o700 });
    let launcher = launch;
    if (!launcher) {
      try {
        const { chromium } = require("playwright-core");
        launcher = options => chromium.launchPersistentContext(profile, options);
      } catch {
        message = "playwright-core is missing. Run npm ci in the repository, then restart npm run setup. No browser downloads or installs were attempted.";
        await closeBrowser();
        return;
      }
    }
    try {
      browser = await launcher({ channel: "chrome", headless: false, acceptDownloads: false,
        artifactsDir: profile, downloadsPath: path.join(profile, "downloads"), tracesDir: path.join(profile, "traces"),
        env: { ...process.env, TMPDIR: profile, TMP: profile, TEMP: profile },
        args: ["--disable-breakpad", "--disable-crash-reporter"], timeout: 30000 });
      if (done) return;
      browser.on("response", async response => {
        if (done || session) return;
        const request = response.request();
        const url = response.url();
        // Avoid inspecting unrelated response bodies, cookies or credentials.
        if (url !== TOKEN_URL && !hardwareURL(new URL(url))) return;
        try {
          if (url === TOKEN_URL && (response.status() < 200 || response.status() >= 300)) {
            message = "Official token exchange rejected. Check Chrome; no usable session captured.";
            return;
          }
          const value = capture.observe(url, request.method(), response.status(),
            await request.allHeaders(), url === TOKEN_URL ? await response.json() : undefined);
          if (value && !done && !session) {
            session = value;
            capture.clear();
            message = "Matched session captured (not a library/account validation). Choose reader upload or mounted SD.";
            await closeBrowser();
          }
        } catch {
          message = "Could not capture a matching official session. Check Chrome or cancel and retry; no account validated.";
        }
      });
      browser.on("close", () => {
        if (!session && !done) message = "Chrome closed before capture. Cancel setup and run npm run setup again.";
      });
      const page = await browser.newPage();
      await page.goto(WEBREADER, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch {
      if (!session) {
        message = "Chrome could not open the official webreader. Install Chrome/check the network; cancel and retry. No account validated.";
        await closeBrowser();
      }
    }
  }
  const snapshot = () => ({ message, captured: !!session, reader: !!reader, target: reader, started: !!profile || !!session || done, done });
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${csrf}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    const reply = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"]))) {
      return reply(403, { message: "Local Host/Origin rejected." });
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(setupHTML(csrf, defaults));
    }
    if (req.headers["x-setup-csrf"] !== csrf ||
        (req.method === "POST" && req.headers.origin !== origin)) {
      return reply(403, { message: "Pairing/CSRF check failed." });
    }
    if (req.method === "GET" && req.url === "/status") return reply(200, snapshot());
    if (req.method !== "POST" || !["/start", "/install", "/sd", "/cancel"].includes(req.url)) {
      return reply(404, { message: "Unknown setup action." });
    }
    if (active || done) return reply(409, { message: "Setup is busy or finished." });
    if (req.headers["content-type"] !== "application/json") return reply(415, { message: "JSON required." });
    active = true;
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 8192) throw new SetupError("Request too large.");
      }
      let input;
      try { input = JSON.parse(raw); } catch { throw new SetupError("Invalid setup JSON."); }
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new SetupError("Invalid setup request.");
      if (req.url === "/start") {
        if (profile || session) throw new SetupError("Login already started. Cancel and restart setup to try again.");
        reader = input.reader ? readerOrigin(input.reader) : "";
        message = "Sign in manually in Chrome. If upstream blocks login, cancel; no account has been validated.";
        browserTask = startBrowser().catch(() => {
          message = "Browser setup failed. Cancel and retry; no account validated.";
        });
      } else if (req.url === "/cancel") {
        done = true; message = "Cancelled. Closing setup and deleting the disposable browser profile.";
        laterFinish();
      } else {
        if (!session) throw new SetupError("Complete the official browser login first.");
        if (input.consent !== true) throw new SetupError("Explicit consent to plaintext SD, local HTTP/file API exposure and native TLS without certificate verification is required.");
        if (req.url === "/install") {
          if (input.readerVerified !== true) throw new SetupError("Verify the displayed reader IP and consent to its unauthenticated file API first.");
          await installReader(reader, session, input.insecureConsent);
        }
        else {
          try { await installSD(input.directory, session); }
          catch { throw new SetupError("Could not write SD. Check the absolute mount path, permissions and symlinks."); }
        }
        done = true;
        session = undefined; capture.clear();
        let cleanupFailed = false;
        try { await closeBrowser(); } catch { cleanupFailed = true; }
        message = "Session installed. Safely eject SD if used, disable the reader webserver, then use native Tolino sync. Setup is closing." +
          (cleanupFailed ? " Browser cleanup failed: remove scripts/.local-setup-profile-*." : "");
        laterFinish();
      }
      reply(200, snapshot());
    } catch (error) {
      // Only our fixed messages reach the UI; filesystem/browser/upstream errors
      // can contain tokens, URLs or private paths.
      reply(400, { message: error instanceof SetupError ? error.message : "Setup action failed. Check the reader/network or SD permissions and retry." });
    } finally { active = false; }
  });
  server.requestTimeout = 20000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  timer = setTimeout(() => finish().catch(() => {
    console.error("Setup cleanup failed; remove scripts/.local-setup-profile-*.");
    process.exitCode = 1;
  }), lifetimeMs);
  return { origin, finish };
}

if (require.main === module) {
  Promise.resolve().then(() => createSetup({ defaults: cliDefaults(process.argv.slice(2)) })).then(setup => {
    console.log("One-time local setup: " + setup.origin);
    console.log("No account has been validated. Sign in manually; never share session files.");
    openUI(setup.origin);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
      setup.finish().catch(() => {
        console.error("Cleanup failed; remove scripts/.local-setup-profile-*.");
        process.exitCode = 1;
      });
    });
  }).catch(error => {
    console.error(error instanceof SetupError ? error.message :
      "Could not start local setup. Check Node >=20 and local port permissions.");
    process.exitCode = 1;
  });
}

module.exports = { SessionCapture, readerOrigin, installReader, installSD, createSetup, cliDefaults, SESSION_DIR, SESSION_FILE, TOKEN_URL };
