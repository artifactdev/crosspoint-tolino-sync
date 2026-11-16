"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const {execFileSync} = require("node:child_process");
const {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} = require("node:fs");
const {tmpdir} = require("node:os");
const path = require("node:path");
const {packagePlugin} = require("../scripts/package.cjs");

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "tolino-package-test-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, "tolino-sync.crosspoint-plugin");
  const output = path.join(root, "dist");
  mkdirSync(source);
  const manifest = JSON.parse(readFileSync(path.join(__dirname, "../tolino-sync.crosspoint-plugin/manifest.json")));
  for (const file of manifest.files) {
    copyFileSync(path.join(__dirname, "../tolino-sync.crosspoint-plugin", file), path.join(source, file));
  }
  return {source, output, manifest, save() {
    writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest));
  }};
}

test("packages a Hub-compatible versioned payload without runtime secrets and verifies its checksum", t => {
  const f = fixture(t);
  f.manifest.version = "1.2.3";
  f.save();
  for (const file of ["settings.json", "cloud-state.json", "direct-session.json", "response.json", "response.json.part"]) {
    writeFileSync(path.join(f.source, file), "synthetic-private-data");
  }
  const result = packagePlugin(f.source, f.output, "v1.2.3");
  assert.equal(result.filename, "tolino-sync-1.2.3.crosspoint-plugin.zip");
  const archive = path.join(f.output, result.filename);
  const members = execFileSync("unzip", ["-Z1", archive], {encoding: "utf8"}).trim().split("\n");
  assert.deepEqual(members.sort(), f.manifest.files.map(file => "tolino-sync/" + file).sort());
  const installed = JSON.parse(execFileSync("unzip", ["-p", archive, "tolino-sync/manifest.json"], {encoding: "utf8"}));
  assert.equal(installed.version, "1.2.3");
  assert.equal(installed.name, "tolino-sync");
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  assert.equal(readFileSync(path.join(f.output, "SHA256SUMS"), "utf8"), `${digest}  ${result.filename}\n`);
  assert.equal(readFileSync(path.join(f.source, "settings.json"), "utf8"), "synthetic-private-data");
});

test("refuses mismatched tags, non-stable versions and unsafe or incomplete Hub file lists", t => {
  const f = fixture(t);
  assert.throws(() => packagePlugin(f.source, f.output, "v999.0.0"), /Release tag must match/);
  for (const version of ["1.2.3-rc.1", "01.2.3", "../1.2.3", "1.2", 123]) {
    f.manifest.version = version;
    f.save();
    assert.throws(() => packagePlugin(f.source, f.output), /MAJOR.MINOR.PATCH/);
  }
  f.manifest.version = "1.2.3";
  for (const files of [["manifest.json", "../settings.json", "plugin.js", "README.md"],
    ["manifest.json", "device.json", "plugin.js", "settings.json"], ["manifest.json"]]) {
    f.manifest.files = files;
    f.save();
    assert.throws(() => packagePlugin(f.source, f.output), /four distributable/);
  }
});

test("rebuilds the archive without retaining obsolete members and fails for missing payload files", t => {
  const f = fixture(t);
  const first = packagePlugin(f.source, f.output);
  writeFileSync(path.join(f.output, "stale.json"), "obsolete file");
  execFileSync("zip", ["-q", first.filename, "stale.json"], {cwd: f.output});
  rmSync(path.join(f.source, "plugin.js"));
  assert.throws(() => packagePlugin(f.source, f.output), /ENOENT/);
  writeFileSync(path.join(f.source, "plugin.js"), "replacement plugin");
  const result = packagePlugin(f.source, f.output);
  assert.ok(!execFileSync("unzip", ["-Z1", path.join(f.output, result.filename)],
    {encoding: "utf8"}).includes("stale.json"));
  assert.equal(execFileSync("unzip", ["-p", path.join(f.output, result.filename), "tolino-sync/plugin.js"],
    {encoding: "utf8"}), "replacement plugin");
});
