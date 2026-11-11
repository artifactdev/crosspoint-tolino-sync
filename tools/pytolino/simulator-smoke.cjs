"use strict";

const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const vm = require("node:vm");
const {setTimeout: delay} = require("node:timers/promises");
const {TolinoClient, downloadable, readingState} = require("../../plugins/tolino-sync/plugin.js");

async function main() {
  if (process.argv.length !== 3 && !(process.argv.length === 6 && process.argv[3] === "--real-helper")) {
    throw new Error("Usage: node simulator-smoke.cjs FIRMWARE_ROOT [--real-helper HELPER_URL API_KEY_FILE]");
  }
  const firmware = path.resolve(process.argv[2] || "");
  const binary = path.join(firmware, ".pio/build/simulator/program");
  const hostScript = fs.readFileSync(path.join(firmware, "src/network/html/js/plugin-host.js"), "utf8");
  assert.ok(fs.existsSync(binary), "Build the upstream firmware simulator first.");
  const realAccount = process.argv[3] === "--real-helper";
  const origin = "http://127.0.0.1:19080", helper = realAccount ? process.argv[4] : "http://127.0.0.1:18081";
  const helperKey = realAccount ? fs.readFileSync(process.argv[5], "utf8").trim()
    : "synthetic-fixture-key-01234567890123456789";
  for (const port of [19080, 19081]) {
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve()));
    });
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crosspoint-tolino-simulator-"));
  const pluginDir = "/.crosspoint/plugins/tolino-sync";
  const sd = path.join(root, "fs_"), plugin = path.join(sd, pluginDir);
  fs.mkdirSync(plugin, {recursive: true});
  fs.mkdirSync(path.join(sd, "Books/Tolino"), {recursive: true});
  fs.writeFileSync(path.join(sd, ".crosspoint/settings.json"), '{"pluginsEnabled":1,"pluginHubPromptHidden":1}');
  for (const name of ["manifest.json", "device.json", "plugin.js", "README.md"]) {
    fs.copyFileSync(path.join(__dirname, "../../plugins/tolino-sync", name), path.join(plugin, name));
  }
  const env = {...process.env};
  for (const key of Object.keys(env)) if (key.startsWith("CROSSPOINT_SIM_")) delete env[key];
  Object.assign(env, {SDL_VIDEODRIVER: "dummy", CROSSPOINT_SIM_HTTP_PORT: "19080",
    CROSSPOINT_SIM_INPUT_SCRIPT: "2500:DOWN;2800:DOWN;3100:DOWN;3400:ENTER;4300:DOWN;4600:DOWN;4900:ENTER;120000:QUIT"});
  const log = fs.openSync(path.join(root, "simulator.log"), "w");
  let simulator = spawn(binary, [], {cwd: root, env, stdio: ["ignore", log, log]});
  let spawnError;
  simulator.once("error", error => { spawnError = error; });
  async function stopSimulator() {
    simulator.kill("SIGTERM");
    if (!spawnError && simulator.exitCode === null && simulator.signalCode === null) {
      await Promise.race([new Promise(resolve => simulator.once("exit", resolve)), delay(3000)]);
    }
    if (simulator.exitCode === null && simulator.signalCode === null) {
      simulator.kill("SIGKILL");
      await new Promise(resolve => simulator.once("exit", resolve));
    }
  }
  let success = false;
  try {
    for (let attempt = 0; ; attempt++) {
      if (spawnError) throw spawnError;
      if (simulator.exitCode !== null) throw new Error("Simulator exited before HTTP became ready.");
      try {
        const status = await fetch(origin + "/api/status");
        if (status.ok) break;
      } catch (error) {
        if (attempt >= 199) throw new Error("Simulator HTTP did not start: " + error.message);
      }
      if (attempt >= 199) throw new Error("Simulator HTTP did not become ready.");
      await delay(100);
    }
    const fetchDevice = (url, options) => fetch(new URL(url, origin), options);
    const sandbox = {window: {}, fetch: fetchDevice, TextDecoder, Uint8Array, FormData, Blob, atob, btoa,
      setTimeout, clearTimeout, setInterval, console};
    vm.runInNewContext(hostScript, sandbox);
    const host = sandbox.window.CrossPoint;
    const api = {
      dir: pluginDir,
      pluginFile: file => "/plugin?name=tolino-sync&file=" + encodeURIComponent(file),
      relay: (...args) => host.relay("tolino-sync", ...args),
      crypto: (...args) => host.crypto(...args),
      writeFile: (...args) => host.writeFile("tolino-sync", ...args),
      fetchToSd: (...args) => host.fetchToSd("tolino-sync", ...args)
    };
    const plugins = await (await fetchDevice("/api/plugins")).json();
    assert.ok(plugins.some(item => item.name === "tolino-sync"), "Firmware must discover the installed plugin.");
    const client = new TolinoClient(api, fetchDevice);
    await client.saveSession({mode: "helper", helperUrl: helper,
      helperApiKey: helperKey, destDir: "/Books/Tolino", transportAccepted: true});
    const books = await client.listBooks();
    if (!realAccount) assert.equal(books.length, 3, "Default mode requires the offline three-book fixture.");
    const book = books.find(realAccount ? downloadable : item => item.id === "fixture-book-1");
    assert.ok(book, "No supported EPUB available for a download test.");
    await client.pullReadingStates();
    if (!realAccount) assert.equal(readingState(client.state, book.publicationId).progress, 0.42);
    assert.equal(typeof client.state.revision, "string");
    const destination = await client.download(book);
    const epub = fs.readFileSync(path.join(sd, destination));
    assert.equal(epub.subarray(0, 4).toString("hex"), "504b0304");
    assert.ok(epub.includes(Buffer.from("application/epub+zip")));
    const sidecar = JSON.parse(fs.readFileSync(path.join(sd, destination + ".meta.json"), "utf8"));
    assert.equal(sidecar.tolino_identifier, book.id);
    assert.equal(sidecar.tolino_publication_id, book.publicationId);
    assert.equal(sidecar.tolino_id, book.id);
    const savedFile = fs.statSync(path.join(sd, destination));
    const savedMetadata = fs.readFileSync(path.join(sd, destination + ".meta.json"));
    assert.deepEqual(await client.ensureDownloaded(book), {path: destination, downloaded: false});
    assert.equal(fs.statSync(path.join(sd, destination)).mtimeMs, savedFile.mtimeMs);
    assert.deepEqual(fs.readFileSync(path.join(sd, destination + ".meta.json")), savedMetadata);
    assert.equal(fs.readdirSync(path.join(sd, "Books/Tolino")).filter(name => name.endsWith(".epub")).length, 1);
    assert.equal((await fetchDevice("/download?path=" + encodeURIComponent(destination))).status, 200);
    if (!realAccount) await assert.rejects(client.download(books.find(item => item.id === "fixture-book-2")), /DRM/);
    const reloaded = new TolinoClient(api, fetchDevice);
    await reloaded.load();
    assert.equal(reloaded.config.mode, "helper");
    assert.deepEqual(reloaded.state, client.state);
    await stopSimulator();
    const catalogResponse = await fetch(helper + "/api/catalog", {headers: {
      Authorization: "Bearer " + helperKey, "X-Tolino-Mode": "helper", "X-Tolino-Transport-Accepted": "true"
    }});
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.books.length, books.length);
    const nativeIndex = catalog.books.findIndex(item =>
      JSON.parse(item.sidecar).tolino_identifier === book.id);
    assert.ok(nativeIndex >= 0 && nativeIndex < 8, "Test book must be on the native catalog's first page.");
    const nativeBook = catalog.books[nativeIndex];
    const nativeDestination = "/Books/Tolino/" + nativeBook.filename;
    assert.equal(destination, nativeDestination, "Browser and native downloads must share the same filename.");
    const steps = ["1500:DOWN", "1800:DOWN", "2100:ENTER", "2400:WAIT:SCREEN:.*Thalia / Tolino",
      "500:ENTER", "800:WAIT:SCREEN:.*Simulator WiFi",
      "500:ENTER", "800:WAIT:SCREEN:.*Details"];
    for (let index = 0; index < nativeIndex; index++) steps.push((500 + index * 300) + ":DOWN");
    steps.push((800 + nativeIndex * 300) + ":ENTER",
      (1100 + nativeIndex * 300) + ":WAIT:Entering activity: Details",
      "500:ENTER", "800:WAIT:SCREEN:.*Download complete", "500:QUIT");
    Object.assign(env, {CROSSPOINT_SIM_SCREEN_TEXT: "1", CROSSPOINT_SIM_INPUT_SCRIPT: steps.join(";"),
      CROSSPOINT_SIM_WAIT_TIMEOUT_MS: "60000"});
    spawnError = null;
    simulator = spawn(binary, [], {cwd: root, env, stdio: ["ignore", log, log]});
    simulator.once("error", error => { spawnError = error; });
    const nativeExit = await Promise.race([
      new Promise(resolve => { simulator.once("exit", resolve); simulator.once("error", resolve); }),
      delay(90000).then(() => "timeout")
    ]);
    if (spawnError) throw spawnError;
    assert.equal(nativeExit, 0, "Native UI navigation/download did not finish.");
    const nativeEpub = fs.readFileSync(path.join(sd, nativeDestination));
    assert.equal(nativeEpub.subarray(0, 4).toString("hex"), "504b0304");
    assert.ok(nativeEpub.includes(Buffer.from("application/epub+zip")));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sd, nativeDestination + ".meta.json"), "utf8")),
      {tolino_identifier: book.id, tolino_publication_id: book.publicationId, tolino_id: book.id});
    const nativeLog = fs.readFileSync(path.join(root, "simulator.log"), "utf8");
    assert.match(nativeLog, /SCREEN:.*Details/);
    assert.match(nativeLog, /SCREEN:.*Download complete/);
    success = true;
    console.log("PASS: actual firmware simulator discovers plugin, persists settings, relays library/progress,");
    console.log("streams EPUB through /api/fetch onto simulated SD, writes sidecar and reloads saved state.");
    console.log("Native reader UI also opens the device catalog, displays book details and downloads EPUB + sidecar without File Transfer.");
    console.log(realAccount
      ? "Real signed-in helper used with explicit --real-helper. Book contents, identifiers and API key are not printed."
      : "Upstream browser host code was used unmodified. Synthetic fixture only; no real Thalia account.");
  } finally {
    await stopSimulator();
    fs.closeSync(log);
    if (!success) console.error(fs.readFileSync(path.join(root, "simulator.log"), "utf8").slice(-8000));
    fs.rmSync(root, {recursive: true, force: true});
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
