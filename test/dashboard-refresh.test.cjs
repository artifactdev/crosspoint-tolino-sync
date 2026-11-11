"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const display = require("../tools/pytolino/display.js");

function harness() {
  const nodes = new Map(), timers = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", type: "", textContent: "", disabled: false,
      classList: {remove() {}, add() {}, toggle() {}},
      replaceChildren() {}, querySelector: () => node(id + "/p"),
    });
    return nodes.get(id);
  }
  let now = 0, version = 0, reads = 0, fail = false, pending, lastSyncWrite;
  const context = vm.createContext({
    TolinoDisplay: display, Date: {now: () => now},
    document: {getElementById: node, querySelectorAll: () => []},
    setTimeout: fn => timers.push(fn),
    fetch: async path => {
      if (path === "/reading-progress") {
        reads++;
        if (pending) await pending;
        if (fail) throw new Error("Cloud unavailable");
        return {ok: true, json: async () => ({positions: {}})};
      }
      return {ok: true, json: async () => path === "/status"
        ? {connected: true, busy: false, inventory: [], message: "", readingVersion: version, lastSyncWrite}
        : {apiKey: "", publicUrl: ""}};
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve("../tools/pytolino/dashboard.js"), "utf8"), context);
  return {
    context, nodes, timers, reads: () => reads,
    time: value => { now = value; }, push: () => { version++; },
    fail: value => { fail = value; }, hold: value => { pending = value; },
    write: value => { lastSyncWrite = value; },
    poll: () => vm.runInContext("poll(false)", context),
    flush: () => new Promise(resolve => setImmediate(resolve)),
  };
}

test("dashboard refreshes at exactly five minutes and after a confirmed push without overlapping reads", async () => {
  const h = harness();
  await h.flush();
  assert.equal(h.reads(), 1);
  h.time(299999); await h.poll(); await h.flush();
  assert.equal(h.reads(), 1);
  h.time(300000); await h.poll(); await h.flush();
  assert.equal(h.reads(), 2);
  h.push(); await h.poll(); await h.flush();
  assert.equal(h.reads(), 3);
  let release;
  h.hold(new Promise(resolve => { release = resolve; }));
  h.push(); await h.poll(); await h.poll();
  assert.equal(h.reads(), 4);
  h.push(); await h.poll();
  assert.equal(h.reads(), 4);
  release(); await h.flush();
  assert.equal(h.reads(), 5);
});

test("failed automatic reads show errors and wait five minutes before retrying", async () => {
  const h = harness();
  await h.flush();
  h.fail(true); h.time(300000); await h.poll(); await h.flush();
  assert.match(h.nodes.get("reading-status").textContent, /Cloud unavailable/);
  await h.poll(); await h.flush();
  assert.equal(h.reads(), 2);
  h.time(600000); h.fail(false); await h.poll(); await h.flush();
  assert.equal(h.reads(), 3);
});

test("dashboard distinguishes failed cloud delivery from confirmed cloud writes", async () => {
  const h = harness();
  await h.flush();
  h.write({synced: false, error: "Cloud state changed."});
  await h.poll();
  assert.match(h.nodes.get("sync-write-status").textContent, /Cloud-Push fehlgeschlagen: Cloud state changed/);
  assert.match(h.nodes.get("sync-write-status").textContent, /allein bestätigt noch keine/);
  assert.equal(h.reads(), 1);
  h.write({synced: true}); h.push();
  await h.poll(); await h.flush();
  assert.equal(h.nodes.get("sync-write-status").textContent, "Letzter Cloud-Push von Tolino bestätigt.");
  assert.equal(h.reads(), 2);
});
