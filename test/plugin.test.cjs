"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const {
  TolinoClient, normalizeInventory, downloadable, applyCloudChanges, readingState, settings
} = require("../plugins/tolino-sync/plugin.js");

const config = {
  hardwareId: "test-hardware",
  refreshToken: "test-refresh",
  destDir: "/Books/Tolino",
  transportAccepted: true
};
const book = {
  id: "bosh_3_test-book", publicationId: "publication-1",
  title: "Test Book", author: "Test Author", format: "application/epub+zip", protection: ""
};
const path = "/publications/publication-1/bookmark/42";
const bookmark = { progress: 0.25, position: "chapter.xhtml#point(/1/2:0)", modified: 1000, currentPosition: "3" };
const initial = () => ({ revision: null, bookmarks: {} });
const tokenReply = () => ({ status: 200, body: JSON.stringify({ access_token: "test-access", refresh_token: "test-rotated", expires_in: 3600 }) });
const reply = (value) => ({ status: 200, body: JSON.stringify(value) });
const local = (value, status = 200) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(value) });
const inventory = () => ({
  PublicationInventory: {
    ebook: [{
      publicationId: book.publicationId,
      epubMetaData: {
        identifier: book.id, title: book.title, author: [{ name: book.author }],
        deliverable: [{ contentFormat: book.format }]
      }
    }],
    edata: []
  }
});

function harness() {
  const writes = [];
  const calls = [];
  const downloads = [];
  const replies = [];
  const files = new Map();
  const sdFiles = [];
  const api = {
    dir: "/.crosspoint/plugins/tolino-sync",
    pluginFile: (file) => "/plugin?file=" + file,
    relay: async (...args) => {
      calls.push(args);
      assert.ok(replies.length, "Unexpected relay request");
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    writeFile: async (path, data) => {
      writes.push({ path, value: JSON.parse(Buffer.from(data, "base64").toString("utf8")) });
      return { ok: true };
    },
    fetchToSd: async (...args) => {
      downloads.push(args);
      if (args[1].endsWith(".epub")) sdFiles.push({name: args[1].split("/").pop(), size: 42, isDirectory: false});
      return { status: 200, complete: true, bytes: 42 };
    },
    crypto: async (op, { data }) => {
      assert.equal(op, "sha256");
      return { data: createHash("sha256").update(Buffer.from(data, "base64")).digest("base64") };
    }
  };
  const client = new TolinoClient(api, async (url) => files.get(url) ||
    (url.startsWith("/api/files?") ? local(sdFiles) : local(null, 404)));
  client.config = { ...config };
  return { client, api, writes, calls, downloads, replies, files, sdFiles };
}

test("registers synchronously through the real browser-side plugin contract", () => {
  let registered;
  vm.runInNewContext(readFileSync(require.resolve("../plugins/tolino-sync/plugin.js"), "utf8"), {
    TextEncoder, window: { CrossPoint: { registerPlugin: (fn) => { registered = fn; } } }
  });
  assert.equal(typeof registered, "function");
});

test("browser plugin refreshes every five minutes and stops when its panel is removed", async () => {
  const h = harness();
  const nodes = [], timers = [], cleared = [];
  function node() {
    const item = {textContent: "", value: "", dataset: {}, style: {}, isConnected: true,
      listeners: {}, appendChild(child) { child.parentElement = item; },
      setAttribute() {}, replaceChildren() {}, querySelectorAll: () => [],
      addEventListener(event, fn) { item.listeners[event] = fn; }};
    nodes.push(item);
    return item;
  }
  const root = node();
  const sandbox = {TextEncoder, module: {exports: {}}, document: {createElement: node},
    fetch: async url => h.files.get(url) || (url.startsWith("/api/files?") ? local(h.sdFiles) : local(null, 404)),
    setInterval(fn, ms) { timers.push({fn, ms}); return timers.length; },
    clearInterval(id) { cleared.push(id); }, Uint8Array, atob, btoa, URL, URLSearchParams};
  vm.runInNewContext(readFileSync(require.resolve("../plugins/tolino-sync/plugin.js"), "utf8"), sandbox);
  h.files.set(h.api.pluginFile("settings.json"), local(config));
  await sandbox.module.exports.render(root, h.api);
  assert.equal(timers[0].ms, 300000);
  timers[0].fn();
  assert.equal(h.calls.length, 0, "No automatic requests until a library has been loaded");
  h.replies.push(tokenReply(), reply(inventory()));
  await nodes.find(node => node.textContent === "Load cloud library").listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  const before = h.calls.length;
  h.replies.push(reply({revision: "next", patches: [{op: "add", path, value: bookmark}]}));
  timers[0].fn(); timers[0].fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, before + 1, "Overlapping timer ticks must not issue parallel pulls");
  assert.equal(h.calls.at(-1)[0], "PATCH");
  root.isConnected = false;
  timers[0].fn();
  assert.deepEqual(cleared, [1]);
});

test("does not bind native browser fetch to the client instance", async () => {
  const sandbox = { TextEncoder, module: { exports: {} } };
  let client;
  sandbox.fetch = async function () {
    assert.notEqual(this, client, "Native fetch must not receive the client as its Window receiver");
    return local(null, 404);
  };
  vm.runInNewContext(readFileSync(require.resolve("../plugins/tolino-sync/plugin.js"), "utf8"), sandbox);
  client = new sandbox.module.exports.TolinoClient({ pluginFile: (file) => file });
  await client.load();
  assert.equal(client.config, null);
});

test("loads fresh SD installations without contacting the cloud", async () => {
  const h = harness();
  h.client.config = null;
  await h.client.load();
  assert.equal(h.client.config, null);
  assert.deepEqual(h.client.state, initial());
  assert.equal(h.calls.length, 0);
});

test("validates credentials, folders, and explicit transport consent", async () => {
  for (const destDir of ["relative", "/Books/../wifi", "/.crosspoint", "/Books\\bad", "/Books\nbad", "/Books/./bad"]) {
    assert.throws(() => settings({ ...config, destDir }));
  }
  assert.equal(settings({ ...config, destDir: "/" }).destDir, "/");
  assert.throws(() => settings({ ...config, refreshToken: "" }));
  const h = harness();
  await assert.rejects(h.client.saveSession({ ...config, transportAccepted: false }), /Acknowledge/);
  assert.equal(h.writes.length, 0);
});

test("helper settings persist without Thalia credentials and reject unsafe origins", async () => {
  const h = harness();
  const helper = {mode: "helper", helperUrl: "http://192.168.1.10:8081/",
    helperApiKey: "synthetic-helper-key", destDir: "/Books/Tolino", transportAccepted: true};
  await h.client.saveSession(helper);
  assert.equal(h.client.config.helperUrl, "http://192.168.1.10:8081");
  assert.equal(h.client.config.refreshToken, undefined);
  assert.equal(h.client.config.hardwareId, undefined);
  assert.equal(h.client.config.dest_dir, "/Books/Tolino");
  assert.equal(h.client.config.nativeTransportAccepted, "true");
  assert.equal(h.writes.find(write => write.path.endsWith("/settings.json")).value.dest_dir, "/Books/Tolino");
  for (const helperUrl of ["file:///tmp", "https://user:pass@example.com", "http://host/path", "http://host?key=test"]) {
    assert.throws(() => settings({...helper, helperUrl}));
  }
});

test("native device catalog shares browser connection settings and authenticates all helper requests", () => {
  const manifest = JSON.parse(readFileSync(require.resolve("../plugins/tolino-sync/device.json"), "utf8"));
  assert.equal(manifest.config.file, "settings.json");
  assert.equal(manifest.browse.url, "{cfg.helperUrl}/api/catalog");
  assert.equal(manifest.browse.items, "books");
  assert.equal(manifest.browse.fields.description, "description");
  assert.equal(manifest.download.url, "{cfg.helperUrl}/api/native-download?id={id}");
  for (const request of [manifest.browse, manifest.download]) {
    assert.equal(request.headers.Authorization, "Bearer {cfg.helperApiKey}");
    assert.equal(request.headers["X-Tolino-Mode"], "{cfg.mode}");
    assert.equal(request.headers["X-Tolino-Transport-Accepted"], "{cfg.nativeTransportAccepted}");
  }
  assert.equal(manifest.download.filename, "{title}.epub");
  assert.equal(manifest.download.skip_existing, true);
  assert.equal(manifest.download.identity_key, "tolino_id");
  assert.equal(manifest.download.bulk.url, "{cfg.helperUrl}/api/catalog?supported=1");
  assert.deepEqual(manifest.download.sidecar, {path: "{dest}.meta.json", body: "{url}"});
});

test("helper mode loads inventory and reading state through authenticated relay without token refresh", async () => {
  const h = harness();
  h.client.config = {mode: "helper", helperUrl: "http://192.168.1.10:8081",
    helperApiKey: "synthetic-helper-key", destDir: "/Books/Tolino", transportAccepted: true};
  h.replies.push(reply(inventory()), reply({revision: "helper-revision", patches: []}));
  assert.deepEqual(await h.client.listBooks(), [book]);
  await h.client.pullReadingStates();
  assert.equal(h.calls[0][1], "http://192.168.1.10:8081/api/inventory");
  assert.equal(h.calls[0][2].Authorization, "Bearer synthetic-helper-key");
  assert.equal(h.calls[1][0], "POST");
  assert.equal(h.calls[1][1], "http://192.168.1.10:8081/api/reading-state");
  assert.deepEqual(JSON.parse(h.calls[1][3]), {revision: null});
  assert.equal(h.calls.some(call => call[1].includes("thalia.de")), false);
});

test("helper download streams only from configured helper and preserves EPUB sidecars", async () => {
  const h = harness();
  h.client.config = {mode: "helper", helperUrl: "http://192.168.1.10:8081",
    helperApiKey: "synthetic-helper-key", destDir: "/Books/Tolino", transportAccepted: true};
  h.replies.push(reply({DownloadInfo: {format: "application/epub+zip",
    contentUrl: "/api/download?id=" + encodeURIComponent(book.id)}}));
  const dest = await h.client.download(book);
  assert.equal(h.calls[0][1], "http://192.168.1.10:8081/api/download-info?id=" + encodeURIComponent(book.id));
  assert.equal(h.downloads[0][0], "http://192.168.1.10:8081/api/download?id=" + encodeURIComponent(book.id));
  assert.deepEqual(h.downloads[0][2], {Authorization: "Bearer synthetic-helper-key"});
  assert.ok(dest.endsWith(".epub"));
  assert.equal(h.writes.at(-1).value.tolino_identifier, book.id);
  h.sdFiles.length = 0;
  h.replies.push(reply({DownloadInfo: {format: "application/epub+zip", contentUrl: "https://evil.invalid/api/download"}}));
  await assert.rejects(h.client.download(book), /unsafe content URL/);
});

test("helper failures are explicit and never fall back to direct-account authentication", async () => {
  const h = harness();
  h.client.config = {mode: "helper", helperUrl: "http://192.168.1.10:8081",
    helperApiKey: "synthetic-helper-key", destDir: "/Books/Tolino", transportAccepted: true};
  h.replies.push({status: 401});
  await assert.rejects(h.client.listBooks(), /API key/);
  assert.equal(h.calls.length, 1);
});

test("refreshes with Thalia's documented form fields and persists token rotation first", async () => {
  const h = harness();
  h.replies.push(tokenReply(), reply(inventory()));
  const books = await h.client.listBooks();
  assert.deepEqual(books, [book]);
  const [method, url, headers, body] = h.calls[0];
  assert.equal(method, "POST");
  assert.equal(url, "https://www.thalia.de/auth/oauth2/token");
  assert.equal(headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(body)), {
    client_id: "webreader", grant_type: "refresh_token", refresh_token: "test-refresh", scope: "SCOPE_BOSH"
  });
  assert.equal(h.writes[0].value.refreshToken, "test-rotated");
  assert.equal(h.calls[1][2].t_auth_token, "test-access");
  assert.equal(h.calls[1][2].reseller_id, "3");
  assert.equal(h.calls[1][2].hardware_id, config.hardwareId);
  assert.equal(h.writes.some((entry) => JSON.stringify(entry.value).includes("test-access")), false);
});

test("retries authentication once, never loops on rejected credentials", async () => {
  const h = harness();
  h.replies.push(tokenReply(), { status: 401 }, tokenReply(), { status: 403 });
  await assert.rejects(h.client.listBooks(), /HTTP 403/);
  assert.equal(h.calls.length, 4);
});

test("surfaces rate limits without retrying", async () => {
  const h = harness();
  h.replies.push(tokenReply(), { status: 429 });
  await assert.rejects(h.client.listBooks(), /Rate limited/);
  assert.equal(h.calls.length, 2);
});

test("does not use a new access token when saving its rotated refresh token fails", async () => {
  const h = harness();
  h.api.writeFile = async () => { throw new Error("SD full"); };
  h.replies.push(tokenReply());
  await assert.rejects(h.client.listBooks(), /SD full/);
  assert.equal(h.client.config.refreshToken, "test-rotated");
  assert.equal(h.client.token, null);
  assert.equal(h.calls.length, 1);
});

test("rejects malformed, truncated and changed inventory responses", async () => {
  assert.throws(() => normalizeInventory({ page: { content: [] } }), /Unrecognized/);
  const data = inventory();
  data.PublicationInventory.ebook[0].epubMetaData = null;
  assert.throws(() => normalizeInventory(data), /metadata/);
  const h = harness();
  h.replies.push(tokenReply(), { status: 200, body: '{"PublicationInventory":' });
  await assert.rejects(h.client.listBooks(), /invalid or truncated JSON/);
});

test("real provider DRM flags refuse encrypted ACS4 and allow WatermarkV1 EPUBs", () => {
  const data = inventory();
  const item = data.PublicationInventory.ebook[0];
  item.epubMetaData.protectionType = "WatermarkV1";
  item.epubMetaData.deliverable[0].contentEncrypted = false;
  assert.equal(downloadable(normalizeInventory(data)[0]), true);
  item.epubMetaData.protectionType = "ACS4";
  item.contentProtectionType = "NONE";
  assert.equal(downloadable(normalizeInventory(data)[0]), false);
  item.epubMetaData.protectionType = "Unprotected";
  for (const encrypted of [true, "false", 0]) {
    item.epubMetaData.deliverable[0].contentEncrypted = encrypted;
    assert.equal(downloadable(normalizeInventory(data)[0]), false);
  }
});

test("includes uploads, deduplicates identifiers, and retains explicit publication IDs", () => {
  const data = inventory();
  data.PublicationInventory.edata.push(data.PublicationInventory.ebook[0]);
  assert.equal(normalizeInventory(data).length, 1);
  assert.equal(normalizeInventory(data)[0].publicationId, "publication-1");
});

test("falls back to SD for large inventory responses", async () => {
  const h = harness();
  h.replies.push(tokenReply(), Object.assign(new Error("relay too large"), { status: 502 }));
  h.files.set("/plugin?file=response.json", local(inventory()));
  assert.deepEqual(await h.client.listBooks(), [book]);
  assert.equal(h.downloads[0][1], h.api.dir + "/response.json");
  assert.equal(h.downloads[0][3].method, "GET");
});

test("refreshes authentication when a large-response fallback receives 401", async () => {
  const h = harness();
  h.replies.push(tokenReply(), Object.assign(new Error("relay too large"), { status: 502 }), tokenReply(), reply(inventory()));
  h.api.fetchToSd = async () => {
    throw Object.assign(new Error("fetch failed"), { result: { status: 401, complete: false } });
  };
  assert.deepEqual(await h.client.listBooks(), [book]);
  assert.equal(h.calls.length, 4);
});

test("large progress responses retain the empty-patch read-only request", async () => {
  const h = harness();
  h.replies.push(tokenReply(), Object.assign(new Error("relay too large"), { status: 502 }));
  h.files.set("/plugin?file=response.json", local({ revision: "large-r1", patches: [{ op: "add", path, value: bookmark }] }));
  await h.client.pullReadingStates();
  assert.equal(h.downloads[0][3].method, "PATCH");
  assert.deepEqual(JSON.parse(h.downloads[0][3].body), { revision: null, patches: [] });
  assert.equal(h.client.state.revision, "large-r1");
});

test("rejects malformed saved files rather than treating them as a fresh installation", async () => {
  const h = harness();
  h.files.set("/plugin?file=settings.json", local({ bad: true }));
  await assert.rejects(h.client.load(), /Hardware ID/);
  h.files.set("/plugin?file=settings.json", local({ refreshToken: "" }));
  h.files.set("/plugin?file=cloud-state.json", local(false));
  await assert.rejects(h.client.load(), /Invalid saved cloud state/);
});

test("never mistakes a failed or incomplete SD transfer for a successful book download", async () => {
  for (const result of [{ status: 500, complete: true, error: "sd write failed" }, { status: 200, complete: false }]) {
    const h = harness();
    h.replies.push(tokenReply(), reply({ DownloadInfo: { contentUrl: "https://cdn.example/book.epub", format: book.format } }));
    h.api.fetchToSd = async () => result;
    await assert.rejects(h.client.download(book), /Book download failed/);
    assert.equal(h.writes.some((entry) => entry.path.endsWith(".meta.json")), false);
  }
});

test("base64-encodes identifiers in both download-info segments and preserves sidecar keys", async () => {
  const h = harness();
  const unusualBook = { ...book, id: "bosh_/unicode-\u00fc", title: "../../\u00dcber <script>" };
  h.replies.push(tokenReply(), reply({ DownloadInfo: { contentUrl: "https://cdn.example/book.epub?signature=abc", format: book.format } }));
  h.client.fetchLocal = async url => local(url.startsWith("/api/files?") ? [] : { other_plugin_id: "keep-me" });
  const dest = await h.client.download(unusualBook);
  const encoded = encodeURIComponent(Buffer.from(unusualBook.id).toString("base64"));
  assert.ok(h.calls[1][1].endsWith("/" + encoded + "/" + encoded + "/type/external-download"));
  assert.equal(dest, "/Books/Tolino/____Über _script_.epub");
  assert.deepEqual(h.downloads[0][2], {});
  const meta = h.writes.find((entry) => entry.path.endsWith(".meta.json"));
  assert.equal(meta.value.other_plugin_id, "keep-me");
  assert.equal(meta.value.tolino_identifier, unusualBook.id);
  assert.equal(meta.value.tolino_publication_id, book.publicationId);
  assert.equal(meta.value.tolino_id, unusualBook.id);
});

test("existing native and legacy browser filenames skip all cloud requests, downloads and writes", async () => {
  const filename = createHash("sha256").update(book.id).digest("hex") + ".epub";
  for (const name of [filename, "Old-Title-" + filename, filename.toUpperCase()]) {
    const h = harness();
    h.sdFiles.push({name, size: 1234, isDirectory: false});
    const result = await h.client.ensureDownloaded({...book, title: "A changed cloud title"});
    assert.deepEqual(result, {path: "/Books/Tolino/" + name, downloaded: false});
    assert.equal(h.client.localBooks.get(book.id), result.path);
    assert.equal(h.calls.length, 0);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.writes.length, 0);
  }
});

test("a native download appearing after library loading is detected immediately without touching existing duplicates", async () => {
  const h = harness(), filename = createHash("sha256").update(book.id).digest("hex") + ".epub";
  await h.client.refreshLocalBooks([book]);
  assert.equal(h.client.localBooks.size, 0);
  h.sdFiles.push({name: "Old-Title-" + filename, size: 1234, isDirectory: false},
    {name: filename, size: 1234, isDirectory: false});
  assert.deepEqual(await h.client.ensureDownloaded(book), {path: "/Books/Tolino/" + filename, downloaded: false});
  assert.equal(h.sdFiles.length, 2);
  assert.equal(h.calls.length, 0);
  assert.equal(h.downloads.length, 0);
  assert.equal(h.writes.length, 0);
});

test("repeated browser downloads reuse the canonical native path and preserve the existing sidecar", async () => {
  const h = harness();
  h.replies.push(tokenReply(), reply({DownloadInfo: {contentUrl: "https://cdn.example/book.epub", format: book.format}}));
  const first = await h.client.ensureDownloaded(book);
  const writes = h.writes.length, calls = h.calls.length;
  assert.equal(first.downloaded, true);
  assert.equal(first.path, "/Books/Tolino/Test Book.epub");
  assert.deepEqual(await h.client.ensureDownloaded(book), {path: first.path, downloaded: false});
  assert.equal(h.downloads.length, 1);
  assert.equal(h.writes.length, writes);
  assert.equal(h.calls.length, calls);
});

test("library loading marks existing books and download checks re-read SD instead of trusting stale state", async () => {
  const h = harness(), filename = createHash("sha256").update(book.id).digest("hex") + ".epub";
  h.sdFiles.push({name: filename, size: 1234, isDirectory: false});
  h.replies.push(tokenReply(), reply(inventory()));
  await h.client.listBooks();
  assert.equal(h.client.localBooks.get(book.id), "/Books/Tolino/" + filename);
  h.sdFiles.length = 0;
  h.replies.push(reply({DownloadInfo: {contentUrl: "https://cdn.example/book.epub", format: book.format}}));
  assert.equal((await h.client.ensureDownloaded(book)).downloaded, true);
  assert.equal(h.downloads.length, 1);
});

test("same title and unrelated EPUB filenames do not hide a different Tolino book", async () => {
  const h = harness();
  h.sdFiles.push({name: "Test-Book-" + "0".repeat(64) + ".epub", size: 1234, isDirectory: false});
  h.replies.push(tokenReply(), reply({DownloadInfo: {contentUrl: "https://cdn.example/book.epub", format: book.format}}));
  assert.equal((await h.client.ensureDownloaded(book)).downloaded, true);
});

test("title filenames preserve Unicode and match the native 100-byte filename limit", () => {
  const {client} = harness();
  for (const [title, expected] of [["Das Netz", "Das Netz.epub"], ["Über Grenzen", "Über Grenzen.epub"],
    [' ../A:B/"C"?*<>|. ', "__A_B__C______.epub"], ["...", "_.epub"]]) {
    assert.equal(client.bookFilename({...book, title}), expected);
  }
  assert.equal(client.bookFilename({...book, title: "😀".repeat(100)}), "😀".repeat(23) + ".epub");
});

test("renamed title files are found through sidecar identity and colliding title files are not overwritten", async () => {
  const h = harness();
  h.sdFiles.push({name: "Previous Title.epub", size: 100, isDirectory: false});
  h.files.set("/download?path=" + encodeURIComponent("/Books/Tolino/Previous Title.epub.meta.json"),
    local({tolino_id: book.id}));
  assert.deepEqual(await h.client.ensureDownloaded({...book, title: "Changed title"}),
    {path: "/Books/Tolino/Previous Title.epub", downloaded: false});
  assert.equal(h.calls.length, 0);
  const other = harness();
  other.sdFiles.push({name: "Test Book.epub", size: 100, isDirectory: false});
  other.files.set("/download?path=" + encodeURIComponent("/Books/Tolino/Test Book.epub.meta.json"),
    local({tolino_id: "another-book"}));
  await assert.rejects(other.client.download(book), /Another book already uses/);
  assert.equal(other.downloads.length, 0);
  assert.equal(other.calls.length, 0);
});

test("SD lookup failures, invalid listings and empty existing files stop before any cloud request", async () => {
  const lookup = "/api/files?path=" + encodeURIComponent(config.destDir);
  const filename = createHash("sha256").update(book.id).digest("hex") + ".epub";
  const oversized = Array.from({length: 10001}, () => ({name: "other.epub", size: 1, isDirectory: false}));
  for (const response of [
    local(null, 500), local({}), {ok: true, status: 200, text: async () => "["},
    local([{name: "../escape.epub", size: 1, isDirectory: false}]),
    local([{name: filename, size: 0, isDirectory: false}]),
    local([{name: filename, size: 1, isDirectory: true}]), local(oversized),
  ]) {
    const h = harness();
    h.files.set(lookup, response);
    await assert.rejects(h.client.download(book));
    assert.equal(h.calls.length, 0);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.writes.length, 0);
  }
  const h = harness();
  h.files.set(lookup, local(oversized.slice(0, 10000)));
  assert.equal((await h.client.deviceFiles()).length, 10000);
});

test("sends account headers only to the BOSH origin", async () => {
  const h = harness();
  h.replies.push(tokenReply(), reply({ DownloadInfo: { contentUrl: "https://bosh.pageplace.de/bosh/rest/content/test.epub", format: book.format } }));
  await h.client.download(book);
  assert.equal(h.downloads[0][2].t_auth_token, "test-access");
});

test("rejects DRM, ACSM, PDF and unsafe content URLs", async () => {
  assert.equal(downloadable({ ...book, protection: "ADOBE_DRM" }), false);
  assert.equal(downloadable({ ...book, protection: "UNKNOWN" }), false);
  assert.equal(downloadable({ ...book, protection: "WATERMARK" }), true);
  assert.equal(downloadable({ ...book, format: "application/pdf" }), false);
  for (const info of [
    { contentUrl: "https://cdn.example/book.acsm", format: "application/vnd.adobe.adept+xml" },
    { contentUrl: "http://cdn.example/book.epub", format: book.format },
    { contentUrl: "https://user:password@cdn.example/book.epub", format: book.format }
  ]) {
    const h = harness();
    h.replies.push(tokenReply(), reply({ DownloadInfo: info }));
    await assert.rejects(h.client.download(book));
    assert.equal(h.downloads.length, 0);
  }
});

test("cloud progress pull is read-only and persists revisions only after validation", async () => {
  const h = harness();
  h.replies.push(tokenReply(), reply({ revision: "r1", patches: [{ op: "add", path, value: bookmark }] }));
  await h.client.pullReadingStates();
  assert.equal(h.calls[1][0], "PATCH");
  assert.deepEqual(JSON.parse(h.calls[1][3]), { revision: null, patches: [] });
  assert.equal(h.client.state.revision, "r1");
  assert.equal(readingState(h.client.state, book.publicationId).progress, 0.25);
  h.replies.push(reply({ revision: "r2", patches: [{ op: "remove", path }] }));
  await h.client.pullReadingStates();
  assert.deepEqual(JSON.parse(h.calls[2][3]), { revision: "r1", patches: [] });
  assert.equal(readingState(h.client.state, book.publicationId), null);
});

test("supports incremental, unchanged, irrelevant and parent-removal patches", () => {
  let state = applyCloudChanges(initial(), { revision: "r1", patches: [{ op: "add", path, value: bookmark }] });
  state = applyCloudChanges(state, { revision: "r2", patches: [{ op: "replace", path, value: { ...bookmark, progress: 0.5 } }] });
  assert.equal(readingState(state, book.publicationId).progress, 0.5);
  assert.equal(readingState(state, "different-publication"), null);
  state = applyCloudChanges(state, {});
  assert.equal(state.revision, "r2");
  state = applyCloudChanges(state, { patches: [{ op: "add", path: "/publications/publication-1/comments/5", value: {} }] });
  assert.equal(Object.keys(state.bookmarks).length, 1);
  state = applyCloudChanges(state, { patches: [{ op: "remove", path: "/publications/publication-1" }] });
  assert.equal(Object.keys(state.bookmarks).length, 0);
});

test("uses newest modification, not greatest progress, for a publication", () => {
  const state = { revision: "r1", bookmarks: {
    [path]: bookmark,
    [path + "2"]: { ...bookmark, progress: 0.1, modified: 2000 }
  } };
  assert.equal(readingState(state, book.publicationId).progress, 0.1);
});

test("rejects unknown bookmark shapes without mutating the previous state", () => {
  const state = { revision: "r1", bookmarks: { [path]: bookmark } };
  for (const patch of [
    { op: "replace", path, value: { ...bookmark, progress: 50 } },
    { op: "replace", path: "/publications/publication-1/bookmark", value: {} },
    { op: "replace", path: path + "/progress", value: 0.5 },
    { op: "move", path }
  ]) {
    assert.throws(() => applyCloudChanges(state, { revision: "r2", patches: [patch] }));
    assert.equal(state.revision, "r1");
    assert.equal(state.bookmarks[path].progress, 0.25);
  }
});

test("keeps the previous revision when SD persistence fails", async () => {
  const h = harness();
  h.client.token = "already-authenticated";
  h.api.writeFile = async () => { throw new Error("SD failed"); };
  h.replies.push(reply({ revision: "r1", patches: [{ op: "add", path, value: bookmark }] }));
  await assert.rejects(h.client.pullReadingStates(), /SD failed/);
  assert.equal(h.client.state.revision, null);
});

test("writes UTF-8 metadata intact and fails visibly on oversized cache files", async () => {
  const h = harness();
  await h.client.writeJSON("test.json", { title: "\u00dcber den Wolken" });
  assert.equal(h.writes[0].value.title, "\u00dcber den Wolken");
  await assert.rejects(h.client.writeJSON("cloud-state.json", { large: "x".repeat(256 * 1024) }), /256 KB/);
});

test("saving another session resets the account-scoped state before replacing credentials", async () => {
  const h = harness();
  h.client.state = { revision: "old-account", bookmarks: { [path]: bookmark } };
  await h.client.saveSession({ ...config, refreshToken: "another-account" });
  assert.deepEqual(h.writes[0].value, initial());
  assert.equal(h.client.state.revision, null);
  assert.equal(h.client.config.refreshToken, "another-account");
  assert.equal(h.client.token, null);
});

test("clears local secrets and progress without remote revocation or book deletion", async () => {
  const h = harness();
  await h.client.clearSession();
  assert.equal(h.client.config, null);
  assert.equal(h.client.token, null);
  assert.deepEqual(h.writes[0].value, { refreshToken: "" });
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.client.state, initial());
  assert.deepEqual(h.writes.find((entry) => entry.path.endsWith("/response.json")).value, {});
});

test("prevents overlapping operations and releases the lock on failure", async () => {
  const h = harness();
  await assert.rejects(h.client.exclusive(async () => {
    await h.client.exclusive(async () => {});
  }), /Another Tolino operation/);
  assert.equal(h.client.busy, false);
  assert.equal(await h.client.exclusive(async () => 42), 42);
});
