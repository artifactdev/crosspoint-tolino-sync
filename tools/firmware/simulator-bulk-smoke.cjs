"use strict";
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const {setTimeout: delay} = require("node:timers/promises");

async function main() {
  const firmware = path.resolve(process.argv[2] || "");
  const direct = process.argv.includes("--direct");
  const identity = id => id;
  const binary = process.env.CROSSPOINT_SIM_BINARY || path.join(firmware, ".pio/build/simulator/program");
  assert.ok(fs.existsSync(binary), "Build the patched simulator first.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tolino-native-bulk-"));
  const sd = path.join(root, "fs_"), folder = path.join(sd, "Books/Tolino");
  const plugin = path.join(sd, ".crosspoint/plugins/tolino-sync");
  fs.mkdirSync(folder, {recursive: true});
  fs.mkdirSync(plugin, {recursive: true});
  const ids = ["a", "b", "c", "d", "e"];
  const books = ids.map(id => ({id, title: id.toUpperCase(), author: "Synthetic",
    description: "Synthetic EPUB fixture", sidecar: JSON.stringify({tolino_id: id})}));
  const payload = Buffer.concat([Buffer.from("PK\x03\x04application/epub+zip"), Buffer.alloc(32768, 0)]);
  const calls = [];
  let failure = "", paged = false, simulator, refreshes = 0;
  const key = "synthetic-bulk-fixture-key-00000000";
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (direct) assert.notEqual(url.pathname, "/api/catalog", "Direct mode must never call a helper catalog");
    if (direct && url.pathname === "/token") {
      request.resume();
      refreshes++;
      response.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify({
        access_token: "synthetic-access", refresh_token: "synthetic-rotated-" + refreshes, expires_in: 3600,
      }));
      return;
    }
    if (direct && url.pathname === "/sync-data") {
      request.resume();
      assert.equal(request.headers.t_auth_token, "synthetic-access");
      response.writeHead(200, {"Content-Type": "application/json"}).end('{"revision":"r1","patches":[]}');
      return;
    }
    if (direct && url.pathname.startsWith("/inventory/")) {
      assert.equal(request.headers.t_auth_token, "synthetic-access");
      response.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify({
        PublicationInventory: {ebook: [...ids, "drm"].map(id => ({
          publicationId: "pub-" + id, epubMetaData: {identifier: id, title: id === "drm" ? "Unsupported" : id.toUpperCase(),
            author: [{name: "Synthetic"}], deliverable: [{
              contentFormat: "application/epub+zip", contentEncrypted: id === "drm",
            }]} })), edata: []},
      }));
      return;
    }
    if (direct && url.pathname.startsWith("/cloud/downloadinfo/")) {
      const id = Buffer.from(decodeURIComponent(url.pathname.split("/")[3]), "base64").toString();
      assert.equal(request.headers.t_auth_token, "synthetic-access");
      response.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify({
        DownloadInfo: {format: "application/epub+zip", contentUrl: "https://tolino-fixture.invalid/api/native-download?id=" + id},
      }));
      return;
    }
    if ((!direct || url.pathname !== "/api/native-download") && request.headers.authorization !== "Bearer " + key) {
      response.writeHead(401).end();
      return;
    }
    if (url.pathname === "/api/catalog") {
      let rows = url.searchParams.has("supported") ? books : [...books, {id: "drm",
        title: "Unsupported [DRM]", sidecar: '{"tolino_id":"drm"}'}];
      if (paged && url.searchParams.has("supported")) {
        const page = Number(url.searchParams.get("page") || 1);
        const size = Number(url.searchParams.get("limit") || 2);
        rows = rows.slice((page - 1) * size, page * size);
      }
      response.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify({books: rows}));
      return;
    }
    if (url.pathname !== "/api/native-download") {
      response.writeHead(404).end();
      return;
    }
    const id = url.searchParams.get("id");
    if (direct) assert.equal(request.headers.t_auth_token, undefined, "Never forward account headers to EPUB CDN");
    calls.push(id);
    if (id === failure || !ids.includes(id)) {
      response.writeHead(500).end();
      return;
    }
    response.writeHead(200, {"Content-Length": payload.length, "Content-Type": "application/epub+zip"}).end(payload);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../plugins/tolino-sync/device.json"), "utf8"));
  manifest.browse.page_size = 2;
  function writeManifest() {
    manifest.download.bulk.url = "{cfg.helperUrl}/api/catalog?supported=1" + (paged ? "&page={page}&limit={limit}" : "");
    fs.writeFileSync(path.join(plugin, "device.json"), JSON.stringify(manifest));
  }
  writeManifest();
  fs.writeFileSync(path.join(plugin, "settings.json"), JSON.stringify({
    mode: "helper", helperUrl: url, helperApiKey: key, nativeTransportAccepted: "true",
  }));
  if (direct) fs.writeFileSync(path.join(plugin, "direct-session.json"), JSON.stringify({
    hardwareId: "synthetic-device", refreshToken: "synthetic-refresh", transportAccepted: true,
  }));
  fs.writeFileSync(path.join(sd, ".crosspoint/settings.json"), '{"pluginsEnabled":1,"pluginHubPromptHidden":1}');
  const old = path.join(folder, "Legacy A.epub");
  fs.writeFileSync(old, payload);
  const oldSidecar = JSON.stringify({tolino_id: identity("a"), custom: "keep"});
  fs.writeFileSync(old + ".meta.json", oldSidecar);
  const before = fs.statSync(old).mtimeMs;
  const env = {...process.env, SDL_VIDEODRIVER: "dummy", CROSSPOINT_SIM_SCREEN_TEXT: "1",
    CROSSPOINT_SIM_WAIT_TIMEOUT_MS: "30000", CROSSPOINT_SIM_HTTP_PORT: "19086"};
  if (direct) env.TOLINO_SIM_ORIGIN = url;
  const opening = [
    "1500:DOWN", "1800:DOWN", "2100:ENTER", "2400:WAIT:SCREEN:.*Thalia / Tolino",
    "500:ENTER", "800:WAIT:SCREEN:.*Simulator WiFi",
    "500:ENTER", "800:WAIT:SCREEN:.*Alle fehlenden EPUBs",
    "300:DOWN", "600:DOWN", "900:DOWN", "1200:ENTER",
    "1500:WAIT:Entering activity: Details",
  ];
  async function run(name, expected, cancel = false) {
    const logfile = path.join(root, name + ".log");
    const log = fs.openSync(logfile, "w");
    const steps = [...opening];
    if (cancel) steps.push("300:BACK", "600:WAIT:Exiting activity: Details", "300:QUIT");
    else steps.push("300:ENTER", "600:WAIT:SCREEN:.*" + expected, "300:QUIT");
    simulator = spawn(binary, [], {cwd: root, env: {...env, CROSSPOINT_SIM_INPUT_SCRIPT: steps.join(";")},
      stdio: ["ignore", log, log]});
    let timer;
    try {
      const code = await Promise.race([
        new Promise((resolve, reject) => { simulator.once("exit", resolve); simulator.once("error", reject); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Native UI timeout: " + name)), 60000); }),
      ]);
      const text = fs.readFileSync(logfile, "utf8");
      assert.equal(code, 0, text.slice(-5000));
      assert.match(text, new RegExp(cancel ? "Exiting activity: Details" : expected));
      return text;
    } catch (error) {
      console.error(fs.readFileSync(logfile, "utf8").slice(-5000));
      throw error;
    } finally {
      clearTimeout(timer);
      if (simulator.exitCode === null) {
        simulator.kill("SIGTERM");
        await new Promise(resolve => simulator.once("exit", resolve));
      }
      fs.closeSync(log);
    }
  }
  function removeDownloaded() {
    for (const id of ids.slice(1)) {
      for (const suffix of [".epub", ".epub.meta.json", ".epub.part"]) {
        fs.rmSync(path.join(folder, id.toUpperCase() + suffix), {force: true});
      }
    }
  }
  try {
    await run("download-all", "Download complete");
    assert.deepEqual(calls, ["b", "c", "d", "e"]);
    for (const id of ids.slice(1)) {
      assert.deepEqual(fs.readFileSync(path.join(folder, id.toUpperCase() + ".epub")), payload);
      assert.equal(JSON.parse(fs.readFileSync(path.join(folder, id.toUpperCase() + ".epub.meta.json"))).tolino_id, identity(id));
    }
    const snapshots = fs.readdirSync(folder).map(name => [name, fs.statSync(path.join(folder, name)).mtimeMs]);
    calls.length = 0;
    const repeated = await run("repeat", "Download complete");
    assert.deepEqual(calls, [], "Repeated native sync must not redownload anything");
    assert.doesNotMatch(repeated, /clearBookCache|Done checking metadata cache/);
    assert.deepEqual(fs.readdirSync(folder).map(name => [name, fs.statSync(path.join(folder, name)).mtimeMs]), snapshots);
    assert.equal(fs.statSync(old).mtimeMs, before);
    assert.equal(fs.readFileSync(old + ".meta.json", "utf8"), oldSidecar);
    if (direct) {
      assert.equal(JSON.parse(fs.readFileSync(path.join(plugin, "direct-session.json"))).refreshToken, "synthetic-rotated-2");
      assert.equal(refreshes, 2, "One token refresh per simulator run, then reuse until expiry");
    }

    removeDownloaded(); paged = true; writeManifest();
    await run("server-pages", "Download complete");
    assert.deepEqual(calls, ["b", "c", "d", "e"], "Must traverse every server page");
    calls.length = 0; removeDownloaded(); paged = false; writeManifest();

    fs.writeFileSync(path.join(folder, "B.epub"), payload);
    fs.writeFileSync(path.join(folder, "B.epub.meta.json"), '{"tolino_id":"another-book"}');
    await run("collision", "Download failed");
    assert.deepEqual(calls, []);
    assert.equal(fs.readFileSync(path.join(folder, "B.epub.meta.json"), "utf8"), '{"tolino_id":"another-book"}');
    removeDownloaded();
    fs.writeFileSync(path.join(folder, "B.epub"), payload);
    await run("missing-identity", "Download failed");
    assert.deepEqual(calls, []);
    assert.deepEqual(fs.readFileSync(path.join(folder, "B.epub")), payload);
    fs.writeFileSync(path.join(folder, "B.epub.meta.json"), "{bad json");
    await run("malformed-identity", "Download failed");
    assert.deepEqual(calls, []);
    removeDownloaded();
    fs.writeFileSync(path.join(folder, "B.epub"), "");
    await run("empty-existing-file", "Download failed");
    assert.deepEqual(calls, []);
    removeDownloaded(); failure = "c";
    await run("network-failure", "Download failed");
    assert.deepEqual(calls, ["b", "c"]);
    assert.ok(!fs.existsSync(path.join(folder, "C.epub")));
    assert.ok(!fs.existsSync(path.join(folder, "C.epub.part")));
    calls.length = 0; failure = "";
    await run("cancel-confirmation", "", true);
    assert.deepEqual(calls, []);
    assert.ok(!fs.existsSync(path.join(folder, "C.epub")));
    assert.ok(!fs.existsSync(path.join(folder, "C.epub.part")));
    calls.length = 0;
    await run("resume", "Download complete");
    assert.deepEqual(calls, ["c", "d", "e"]);
    console.log("PASS: native bulk downloads all pages; skips legacy/renamed identities and DRM; repeat preserves files and sidecars; collisions fail; failed transfers clean partials; confirmation cancellation makes no writes; retry resumes.");
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, {recursive: true, force: true});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
