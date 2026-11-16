"use strict";

const {createHash} = require("node:crypto");
const {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} = require("node:fs");
const {tmpdir} = require("node:os");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const {parseArgs} = require("node:util");

const FILES = ["manifest.json", "device.json", "plugin.js", "README.md"];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function packagePlugin(sourceDir, outputDir, tag) {
  const manifest = JSON.parse(readFileSync(path.join(sourceDir, "manifest.json"), "utf8"));
  if (manifest.name !== "tolino-sync" || manifest.id !== manifest.name ||
      path.basename(sourceDir) !== manifest.name + ".crosspoint-plugin") {
    throw new Error("Plugin Hub payload directory, manifest name and plugin id must identify tolino-sync.");
  }
  if (typeof manifest.version !== "string" || !VERSION.test(manifest.version)) {
    throw new Error("Plugin version must be MAJOR.MINOR.PATCH without a prerelease suffix.");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== FILES.length ||
      !FILES.every(file => manifest.files.includes(file))) {
    throw new Error("Manifest files must list exactly the four distributable plugin files.");
  }
  if (tag !== undefined && tag !== "v" + manifest.version) {
    throw new Error("Release tag must match the plugin manifest version: v" + manifest.version);
  }
  const stage = mkdtempSync(path.join(tmpdir(), "tolino-plugin-package-"));
  try {
    const pluginDir = path.join(stage, manifest.name);
    mkdirSync(pluginDir);
    for (const file of FILES) copyFileSync(path.join(sourceDir, file), path.join(pluginDir, file));
    const filename = `${manifest.name}-${manifest.version}.crosspoint-plugin.zip`;
    const archive = path.join(stage, filename);
    execFileSync("zip", ["-q", "-X", archive, ...FILES.map(file => manifest.name + "/" + file)], {cwd: stage});
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    mkdirSync(outputDir, {recursive: true});
    copyFileSync(archive, path.join(outputDir, filename));
    writeFileSync(path.join(outputDir, "SHA256SUMS"), `${digest}  ${filename}\n`);
    return {version: manifest.version, filename};
  } finally {
    rmSync(stage, {recursive: true, force: true});
  }
}

if (require.main === module) {
  const {values} = parseArgs({options: {tag: {type: "string"}}});
  const root = path.join(__dirname, "..");
  const result = packagePlugin(path.join(root, "tolino-sync.crosspoint-plugin"), path.join(root, "dist"), values.tag);
  console.log("Packaged " + result.filename + " with SHA256SUMS");
}

module.exports = {packagePlugin};
