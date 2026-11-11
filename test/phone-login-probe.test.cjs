"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { probeHTML, startProbe } = require("../scripts/phone-login-probe.cjs");
const { once } = require("node:events");

test("phone probe accepts only official popup messages and never displays token values", () => {
  const html = probeHTML("http://192.168.1.40:8080/pair");
  assert.match(html, /redirect_uri=https%3A%2F%2Fwebreader\.mytolino\.com%2Flibrary%2F/);
  assert.doesNotMatch(html, /redirect_uri=http%3A/);
  const elements = new Map(["status", "start", "stop"].map(id => [id, { textContent: "" }]));
  const handlers = new Map();
  const popup = { closed: false, postMessage() {} };
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) },
    window: {
      open: () => popup,
      addEventListener: (type, handler) => handlers.set(type, handler),
      removeEventListener: type => handlers.delete(type),
    },
    setInterval: () => 1, setTimeout: () => 2,
    clearInterval() {}, clearTimeout() {},
  });
  vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], context);
  elements.get("start").onclick();
  const receive = handlers.get("message");
  const data = { channel: "auth", message: "token", data: {
    access_token: "PRIVATE-ACCESS", refresh_token: "PRIVATE-REFRESH",
  } };
  receive({ origin: "https://attacker.invalid", source: popup, data });
  receive({ origin: "https://webreader.mytolino.com", source: {}, data });
  assert.doesNotMatch(elements.get("status").textContent, /Token-Nachricht/);
  receive({ origin: "https://webreader.mytolino.com", source: popup, data });
  assert.match(elements.get("status").textContent, /Access-Feld: vorhanden; Refresh-Feld: vorhanden/);
  assert.doesNotMatch(elements.get("status").textContent, /PRIVATE/);
  assert.equal(handlers.has("message"), false);
  assert.doesNotMatch(html, /\bfetch\s*\(|localStorage|sessionStorage|XMLHttpRequest/);
});

test("phone probe exposes only the random page and no token upload endpoint", async t => {
  const server = startProbe("127.0.0.1");
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(origin)).status, 404);
  assert.equal((await fetch(origin + "/token", { method: "POST", body: "fake-token" })).status, 404);
  assert.equal((await fetch(origin, { headers: { Host: "attacker.invalid" } })).status, 404);
});
