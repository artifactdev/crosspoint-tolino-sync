"use strict";
const assert = require("node:assert/strict");
const {spawn, spawnSync} = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const binary = process.env.CROSSPOINT_SIM_BINARY;
  const pull = process.argv.includes("--pull"), unconfirmed = process.argv.includes("--unconfirmed");
  const mismatch = process.argv.includes("--mismatch");
  assert.ok(binary && fs.existsSync(binary), "Set CROSSPOINT_SIM_BINARY to the built native simulator.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tolino-direct-sync-"));
  const sd = path.join(root, "fs_"), config = path.join(sd, ".crosspoint");
  fs.mkdirSync(path.join(config, "plugins/tolino-sync"), {recursive: true});
  const book = path.join(sd, "Fixture.epub");
  const fixture = spawnSync("python3", ["-c", `
import sys,zipfile
with zipfile.ZipFile(sys.argv[1],"w") as z:
 z.writestr("mimetype","application/epub+zip")
 z.writestr("META-INF/container.xml",'<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
 z.writestr("OPS/content.opf",'<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">synthetic</dc:identifier><dc:title>Fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>')
 z.writestr("OPS/chapter.xhtml",'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture</title></head><body>'+''.join('<p>Paragraph %d. Reading Unicode Grüße and exact cloud positions. %s</p>'%(i,'A readable sentence. '*20) for i in range(100))+'</body></html>')
`, book], {encoding: "utf8"});
  assert.equal(fixture.status, 0, fixture.stderr);
  fs.writeFileSync(book + ".meta.json", JSON.stringify({
    tolino_identifier: "synthetic", tolino_publication_id: "pub-synthetic", tolino_id: "synthetic",
  }));
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({longPressMenuFunction: 0}));
  fs.writeFileSync(path.join(config, "state.json"), JSON.stringify({
    openEpubPath: "/Fixture.epub", lastSleepFromReader: true, showBootScreen: false,
  }));
  fs.writeFileSync(path.join(config, "plugins/tolino-sync/direct-session.json"), JSON.stringify({
    hardwareId: "synthetic-device", refreshToken: "synthetic-refresh", transportAccepted: true,
  }));
  let bookmark = pull ? {position: "OPS/chapter.xhtml#point(/1/2/80/1:0)",
    progress: 0.8, modified: Date.now() - 5000, revision: "existing-slot-revision"} : null;
  let writes = 0, syncReads = 0, refreshes = 0;
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/fixture.epub") {
      assert.equal(request.headers.t_auth_token, undefined);
      response.setHeader("Content-Type", "application/epub+zip");
      const bytes = fs.readFileSync(book);
      if (mismatch) bytes[0] ^= 1;
      response.end(bytes);
      return;
    }
    if (request.url === "/token") {
      refreshes++;
      response.end(JSON.stringify({access_token: "synthetic-access", refresh_token: "synthetic-rotated", expires_in: 3600}));
      return;
    }
    assert.equal(request.headers.t_auth_token, "synthetic-access");
    assert.equal(request.headers.hardware_id, "synthetic-device");
    if (request.url === "/inventory/delta?strip=true") {
      response.end(JSON.stringify({PublicationInventory: {ebook: [{
        publicationId: "pub-synthetic", epubMetaData: {identifier: "synthetic", title: "Fixture",
          deliverable: [{contentFormat: "application/epub+zip", contentEncrypted: false}]},
      }], edata: []}}));
      return;
    }
    if (request.url.startsWith("/cloud/downloadinfo/")) {
      response.end(JSON.stringify({DownloadInfo: {format: "application/epub+zip",
        contentUrl: "https://tolino-fixture.invalid/fixture.epub"}}));
      return;
    }
    assert.equal(request.url, "/sync-data?paths=publications");
    const body = JSON.parse(raw);
    if (body.patches.length) {
      assert.equal(body.revision, "r0");
      assert.equal(body.patches[0].op, "add");
      assert.equal(body.patches[0].path, "/publications/pub-synthetic/bookmark");
      bookmark = {...body.patches[0].value, revision: "server-revision"};
      assert.match(bookmark.position, /^OPS\/chapter.xhtml#point\(\/1\//);
      assert.ok(bookmark.progress >= 0 && bookmark.progress <= 1);
      writes++;
    } else syncReads++;
    response.end(JSON.stringify({revision: bookmark ? "r1" : "r0", patches: bookmark && !unconfirmed ? [{
      op: "add", path: "/publications/pub-synthetic/bookmark/server-slot", value: bookmark,
    }] : []}));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  let child;
  try {
    const steps = [
      "1500:RIGHT", "2000:RIGHT", "2500:HOME:1200",
      "4000:WAIT:SCREEN:.*Simulator WiFi", "300:ENTER",
    ];
    if (pull) steps.push("3000:QUIT");
    else steps.push("600:WAIT:SCREEN:.*Upload", "300:ENTER",
      "600:WAIT:SCREEN:.*" + (unconfirmed || mismatch ? "Sync failed" : "Progress uploaded"), "300:QUIT");
    let output = "";
    child = spawn(binary, [], {cwd: root, env: {...process.env, SDL_VIDEODRIVER: "dummy",
      CROSSPOINT_SIM_SCREEN_TEXT: "1", CROSSPOINT_SIM_WAIT_TIMEOUT_MS: "20000",
      TOLINO_SIM_ORIGIN: origin, CROSSPOINT_SIM_INPUT_SCRIPT: steps.join(";")}});
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 50000);
    const code = await new Promise((resolve, reject) => {child.once("exit", resolve); child.once("error", reject);});
    clearTimeout(timer);
    assert.equal(code, 0, output.slice(-6000));
    assert.doesNotMatch(output, unconfirmed || mismatch ? /WAIT timed out|Progress uploaded/ : /WAIT timed out|Sync failed|Mapping failed/, output.slice(-6000));
    assert.equal(writes, pull || mismatch ? 0 : 1, output.slice(-6000));
    if (pull) assert.match(output, /Progress saved: spine=0 offset=38147 page=61/);
    assert.equal(refreshes, 1);
    assert.ok(syncReads >= (pull || mismatch ? 1 : 3), "Pull/fresh revision checks/readback verification must happen.");
    console.log(pull ? "PASS: actual native reader pulls and applies the exact cloud position without helper or Sync server."
      : unconfirmed ? "PASS: native reader refuses success when Tolino readback does not confirm the write."
        : mismatch ? "PASS: native reader refuses cloud writes for a binary-mismatched EPUB edition."
        : "PASS: actual native reader uploads exact progress directly to cloud with no helper or Sync server; first bookmark creation and readback verified.");
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, {recursive: true, force: true});
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
