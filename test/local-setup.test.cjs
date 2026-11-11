"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  SessionCapture, readerOrigin, installReader, installSD, createSetup,
  cliDefaults, SESSION_DIR, SESSION_FILE, TOKEN_URL,
} = require("../scripts/local-setup.cjs");

const token = { access_token: "synthetic-access-secret", refresh_token: "synthetic-refresh-secret" };
const headers = { t_auth_token: token.access_token, hardware_id: "synthetic-device", reseller_id: "3" };
const inventory = "https://bosh.pageplace.de/bosh/rest/inventory/delta";
const session = { hardwareId: headers.hardware_id, refreshToken: token.refresh_token };
const expected = { transportAccepted: true, ...session };

test("correlates exact successful token/hardware exchanges in either arrival order", () => {
  for (const tokenFirst of [true, false]) {
    const capture = new SessionCapture();
    const observeToken = () => capture.observe(TOKEN_URL, "POST", 200, {}, token);
    const observeDevice = () => capture.observe(inventory, "GET", 200, headers);
    assert.equal((tokenFirst ? observeToken : observeDevice)(), null);
    assert.deepEqual((tokenFirst ? observeDevice : observeToken)(), session);
    capture.clear();
    assert.equal(capture.devices.size + capture.tokens.size, 0);
  }
});

test("rejects foreign, failed, malformed, and uncorrelated exchanges", () => {
  const capture = new SessionCapture();
  for (const url of [TOKEN_URL + "?extra=1", TOKEN_URL.replace("www.thalia.de", "evil.example")]) {
    assert.equal(capture.observe(url, "POST", 200, {}, token), null);
  }
  assert.equal(capture.observe(TOKEN_URL, "POST", 403, {}, token), null);
  assert.throws(() => capture.observe(TOKEN_URL, "POST", 200, {}, { ...token, refresh_token: "\n" }));
  capture.observe(TOKEN_URL, "POST", 200, {}, token);
  assert.equal(capture.observe(inventory, "GET", 200, { ...headers, t_auth_token: "other-context" }), null);
  assert.equal(capture.observe(inventory, "GET", 401, headers), null);
  assert.equal(capture.observe(inventory.replace("bosh.pageplace.de", "evil.example"), "GET", 200, headers), null);
  assert.equal(capture.observe(inventory, "GET", 200, { ...headers, hardware_id: undefined }), null);
  assert.equal(capture.observe(inventory, "GET", 200, {
    hardware_id: headers.hardware_id, reseller_id: "3", Authorization: "Bearer " + token.access_token,
  }), null);
});

test("CLI defaults validate options without reflecting secrets in errors", () => {
  assert.deepEqual(cliDefaults([]), { sdRoot: "", reader: "" });
  assert.deepEqual(cliDefaults(["--sd-root", "/Volumes/READER", "--reader-origin", "http://127.0.0.1:8080/"]),
    { sdRoot: "/Volumes/READER", reader: "http://127.0.0.1:8080" });
  for (const args of [
    ["--refresh-token", token.refresh_token], ["--sd-root"], ["--sd-root", "relative"],
    ["--sd-root", "/bad\npath"], ["--reader-origin", "https://public.example/" + token.refresh_token],
    ["--sd-root", "/one", "--sd-root", "/two"],
  ]) {
    assert.throws(() => cliDefaults(args), error => !error.message.includes(token.refresh_token));
  }
});

test("CLI prefill is inert, attribute-escaped, absent from scripts/status; no implicit login or consent", async () => {
  const sdRoot = '/Volumes/reader"><script>alert("x")</script>&\'';
  let launches = 0;
  const setup = await createSetup({
    defaults: cliDefaults(["--sd-root", sdRoot, "--reader-origin", "http://10.0.0.2"]),
    launch: async () => { launches++; throw new Error("Must not launch"); },
  });
  try {
    const html = await (await fetch(setup.origin)).text();
    assert.match(html, /value="\/Volumes\/reader&quot;&gt;&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;&amp;&#39;"/);
    assert.match(html, /id="reader"[^>]+value="http:\/\/10\.0\.0\.2"/);
    assert.ok(!html.includes(sdRoot));
    assert.ok(!/<input\b[^>]*\schecked(?:\s|=|>)/.test(html));
    assert.ok(!/<script[^>]*>[\s\S]*\/Volumes\/reader/.test(html));
    const csrf = /'X-Setup-CSRF':'([a-f0-9]{64})'/.exec(html)[1];
    const status = await (await fetch(setup.origin + "/status", { headers: { "X-Setup-CSRF": csrf } })).json();
    assert.equal(status.started, false);
    assert.equal(status.captured, false);
    assert.equal(status.target, "");
    assert.ok(!JSON.stringify(status).includes(sdRoot));
    assert.equal(launches, 0);
  } finally { await setup.finish(); }
});

test("supports the helper's authenticated device-userid request shape", () => {
  const capture = new SessionCapture();
  capture.observe(TOKEN_URL, "POST", 200, {}, token);
  const hardwareId = "12345678-1234-1234-1234-123456789abc";
  assert.deepEqual(capture.observe(`https://api.pageplace.de/v1/devices/${hardwareId}/userid`, "GET", 200, headers),
    { ...session, hardwareId });
});

test("a later token exchange replaces an earlier potentially rotated refresh token", () => {
  const capture = new SessionCapture();
  capture.observe(TOKEN_URL, "POST", 200, {}, token);
  capture.observe(TOKEN_URL, "POST", 200, {}, { access_token: "new-access", refresh_token: "new-refresh" });
  assert.equal(capture.observe(inventory, "GET", 200, headers), null);
  assert.deepEqual(capture.observe(inventory, "GET", 200, { ...headers, t_auth_token: "new-access" }),
    { hardwareId: headers.hardware_id, refreshToken: "new-refresh" });
});

test("reader target only accepts literal private IPv4 origins", () => {
  assert.equal(readerOrigin("http://192.168.1.20/"), "http://192.168.1.20");
  assert.equal(readerOrigin("https://10.0.0.2:8443"), "https://10.0.0.2:8443");
  assert.equal(readerOrigin("http://172.31.0.1"), "http://172.31.0.1");
  assert.equal(readerOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  for (const value of ["https://example.com", "http://127.0.0.2", "http://169.254.169.254",
    "http://192.168.1.1.evil.example", "http://10.0.0.1/a", "http://10.0.0.1/?x",
    "http://10.0.0.1/#x", "http://user:pass@10.0.0.1", "file:///etc/passwd", "http://[::1]",
    "http://0x0a000001", "http://10.1", " http://10.0.0.1", "http://172.32.0.1",
    "http://10.0.0.1/../", "http://10.0.0.1\\", "http://10.0.0.1@evil.example"]) {
    assert.throws(() => readerOrigin(value), value);
  }
});

test("reader handoff uses actual firmware mkdir and multipart upload contract", async () => {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/status")) {
      return Response.json({ firmwareFamily: "crosspoint", pluginApi: 1, version: "2.0.0-test", device: "X4 Pro" });
    }
    if (url.endsWith("/mkdir")) {
      return new Response("Folder already exists", { status: 400 });
    }
    const file = options.body.get("file");
    assert.equal(file.name, SESSION_FILE);
    assert.deepEqual(JSON.parse(await file.text()), expected);
    assert.equal(options.body.getAll("file").length, 1);
    return new Response("File uploaded successfully: " + SESSION_FILE);
  };
  await assert.rejects(installReader("http://10.0.0.2", session, false, transport), /Explicit consent/);
  assert.equal(calls.length, 0);
  await installReader("http://10.0.0.2", session, true, transport);
  assert.equal(calls.length, 5);
  assert.equal(calls[0].url, "http://10.0.0.2/api/status");
  assert.equal(calls[0].options.method, "GET");
  const parents = ["/", "/.crosspoint", "/.crosspoint/plugins"];
  calls.slice(1, 4).forEach(({ url, options }, i) => {
    assert.equal(url, "http://10.0.0.2/mkdir");
    assert.equal(options.body.get("path"), parents[i]);
    assert.equal(options.body.get("name"), SESSION_DIR.slice(1).split("/")[i]);
  });
  assert.equal(calls[4].url, "http://10.0.0.2/upload?path=" + encodeURIComponent(SESSION_DIR) + "&overwrite=1");
  for (const { url, options } of calls.slice(1)) {
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.ok(!url.includes(token.refresh_token));
    assert.ok(!url.includes(token.access_token));
  }
  await assert.rejects(installReader("https://10.0.0.2", session, false,
    async () => new Response("private upstream body", { status: 403 })), /did not identify/);
  let preflightCalls = 0;
  await assert.rejects(installReader("https://10.0.0.2", session, false, async () => {
    preflightCalls++;
    return Response.json({ firmwareFamily: "other", pluginApi: 1, version: "2", device: "X4" });
  }), /No session sent/);
  assert.equal(preflightCalls, 1);
  await assert.rejects(installReader("https://10.0.0.2", session, false,
    async () => { throw new Error(token.refresh_token); }), error => !error.message.includes(token.refresh_token));
});

test("SD writes only fixed native session shape and refuses symlink directories", async () => {
  const root = path.join(__dirname, "../scripts", ".local-setup-test-" + require("node:crypto").randomBytes(8).toString("hex"));
  await fs.mkdir(root);
  try {
    await installSD(root, session);
    const file = path.join(root, SESSION_DIR, SESSION_FILE);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), expected);
    assert.deepEqual(await fs.readdir(path.dirname(file)), [SESSION_FILE]);
    await installSD(root, { ...session, refreshToken: "rotated" });
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).refreshToken, "rotated");
    await fs.rm(path.join(root, ".crosspoint"), { recursive: true });
    await fs.mkdir(path.join(root, "other"));
    await fs.symlink(path.join(root, "other"), path.join(root, ".crosspoint"), "dir");
    await assert.rejects(installSD(root, session), /symlinks/);
    assert.deepEqual(await fs.readdir(path.join(root, "other")), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("local UI enforces Host, Origin, CSRF, explicit consent; captures only in launched context and exits", { timeout: 5000 }, async () => {
  let context, navigation;
  let ready;
  const navigated = new Promise(resolve => { ready = resolve; });
  const setup = await createSetup({
    graceMs: 40,
    launch: async options => {
      assert.equal(options.channel, "chrome");
      assert.equal(options.headless, false);
      assert.equal(options.env.TMPDIR, options.artifactsDir);
      assert.ok(options.artifactsDir.startsWith(path.resolve(__dirname, "../scripts") + path.sep));
      context = new EventEmitter();
      context.close = async () => context.emit("close");
      context.newPage = async () => ({ goto: async url => { navigation = url; ready(); } });
      return context;
    },
  });
  const sd = path.join(__dirname, "../scripts", ".local-setup-test-" + require("node:crypto").randomBytes(8).toString("hex"));
  await fs.mkdir(sd);
  const request = (route, data, extra = {}) => fetch(setup.origin + route, {
    method: "POST", headers: { Origin: setup.origin, "Content-Type": "application/json", ...extra },
    body: JSON.stringify(data),
  });
  try {
    let response = await fetch(setup.origin);
    const html = await response.text();
    assert.match(html, /native firmware required/);
    assert.match(html, /plaintext/);
    assert.match(html, /native TLS WITHOUT certificate verification/);
    assert.match(html, /Recommended default: mounted SD/);
    assert.match(html, /exits after handoff/);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const csrf = /'X-Setup-CSRF':'([a-f0-9]{64})'/.exec(html)[1];
    const paired = { "X-Setup-CSRF": csrf };
    assert.equal((await request("/start", {})).status, 403);
    assert.equal((await request("/start", {}, { ...paired, Origin: "https://evil.example" })).status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
      const req = require("node:http").request(setup.origin + "/start", {
        method: "POST", headers: { Host: "evil.example", Origin: setup.origin, ...paired },
      }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(wrongHost, 403);
    assert.equal((await request("/start", {}, { ...paired, Origin: "" })).status, 403);
    assert.equal((await request("/start", { reader: "http://10.0.0.2" }, paired)).status, 200);
    await navigated;
    assert.equal(navigation, "https://webreader.thalia.de");
    const responseEvent = (url, method, body, requestHeaders) => ({
      url: () => url, status: () => 200, json: async () => body,
      request: () => ({ method: () => method, allHeaders: async () => requestHeaders }),
    });
    context.emit("response", responseEvent(TOKEN_URL, "POST", token, {}));
    context.emit("response", responseEvent(inventory, "GET", null, headers));
    await new Promise(resolve => setImmediate(resolve));
    const status = await (await fetch(setup.origin + "/status", { headers: paired })).text();
    assert.equal(JSON.parse(status).captured, true);
    for (const secret of [token.access_token, token.refresh_token, headers.hardware_id]) {
      assert.ok(!html.includes(secret));
      assert.ok(!status.includes(secret));
    }
    response = await request("/install", {}, paired);
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /consent/);
    response = await request("/install", { consent: true }, paired);
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /Verify the displayed reader IP/);
    response = await request("/sd", { consent: true, directory: token.refresh_token }, paired);
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes(token.refresh_token));
    response = await request("/sd", { consent: true, directory: sd }, paired);
    assert.equal(response.status, 200);
    const success = await response.text();
    assert.equal(JSON.parse(success).done, true);
    assert.ok(!success.includes(token.refresh_token));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(sd, SESSION_DIR, SESSION_FILE), "utf8")), expected);
    await new Promise(resolve => setTimeout(resolve, 120));
    await assert.rejects(fetch(setup.origin));
  } finally {
    await setup.finish();
    await fs.rm(sd, { recursive: true, force: true });
  }
});

test("blocked Chrome login is reported safely and cancellation shuts down", { timeout: 5000 }, async () => {
  let closed = false, navigated;
  const ready = new Promise(resolve => { navigated = resolve; });
  const setup = await createSetup({
    graceMs: 20,
    launch: async () => {
      const context = new EventEmitter();
      context.close = async () => { closed = true; };
      context.newPage = async () => ({
        goto: async () => { navigated(); throw new Error(token.refresh_token); },
      });
      return context;
    },
  });
  try {
    const html = await (await fetch(setup.origin)).text();
    const csrf = /'X-Setup-CSRF':'([a-f0-9]{64})'/.exec(html)[1];
    const options = { method: "POST", headers: {
      Origin: setup.origin, "Content-Type": "application/json", "X-Setup-CSRF": csrf,
    }, body: "{}" };
    assert.equal((await fetch(setup.origin + "/start", options)).status, 200);
    await ready;
    await new Promise(resolve => setImmediate(resolve));
    const result = await (await fetch(setup.origin + "/status", { headers: options.headers })).text();
    assert.ok(!result.includes(token.refresh_token));
    assert.match(result, /No account validated/);
    assert.equal(closed, true);
    assert.equal((await fetch(setup.origin + "/cancel", options)).status, 200);
    await new Promise(resolve => setTimeout(resolve, 100));
    await assert.rejects(fetch(setup.origin));
  } finally { await setup.finish(); }
});
