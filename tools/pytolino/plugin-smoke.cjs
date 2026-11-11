"use strict";

const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const {TolinoClient, readingState} = require("../../plugins/tolino-sync/plugin.js");

async function main() {
  const origin = "http://127.0.0.1:18081";
  const files = new Map(), downloads = new Map();
  const api = {
    dir: "/plugins/tolino-sync",
    pluginFile: file => "/plugins/tolino-sync/" + file,
    writeFile: async (path, data) => {
      files.set(path, Buffer.from(data, "base64").toString("utf8"));
      return {ok: true};
    },
    relay: async (method, url, headers, body) => {
      assert.equal(new URL(url).origin, origin);
      const response = await fetch(url, {method, headers, body: body || undefined, redirect: "error"});
      return {status: response.status, body: await response.text()};
    },
    fetchToSd: async (url, path, headers) => {
      assert.equal(new URL(url).origin, origin);
      const response = await fetch(url, {headers, redirect: "error"});
      const bytes = Buffer.from(await response.arrayBuffer());
      downloads.set(path, bytes);
      return {status: response.status, complete: response.ok, bytes: bytes.length};
    },
    crypto: async (operation, {data}) => {
      assert.equal(operation, "sha256");
      return {data: createHash("sha256").update(Buffer.from(data, "base64")).digest("base64")};
    }
  };
  const client = new TolinoClient(api, async url => {
    if (url.startsWith("/api/files?")) {
      return {ok: true, status: 200, text: async () => JSON.stringify(
        [...downloads].map(([file, bytes]) => ({name: file.split("/").pop(), size: bytes.length, isDirectory: false})))};
    }
    const body = files.get(url);
    return {ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body};
  });
  await client.saveSession({
    mode: "helper", helperUrl: origin, helperApiKey: "synthetic-fixture-key-01234567890123456789",
    destDir: "/Books/Tolino", transportAccepted: true
  });
  const books = await client.listBooks();
  assert.equal(books.length, 3);
  const book = books.find(item => item.id === "fixture-book-1");
  await client.pullReadingStates();
  assert.equal(readingState(client.state, book.publicationId).progress, 0.42);
  const destination = await client.download(book);
  assert.equal(downloads.get(destination).subarray(0, 4).toString("hex"), "504b0304");
  const sidecar = JSON.parse(files.get(destination + ".meta.json"));
  assert.equal(sidecar.tolino_identifier, book.id);
  assert.equal(sidecar.tolino_publication_id, "fixture-publication-1");
  assert.equal(await client.download(book), destination);
  assert.equal(downloads.size, 1);
  await assert.rejects(client.download(books.find(item => item.id === "fixture-book-2")), /DRM/);
  const unauthorized = await fetch(origin + "/api/inventory");
  assert.equal(unauthorized.status, 401);
  console.log("PASS: plugin -> HTTP helper API -> synthetic inventory, cloud position, EPUB and SD sidecar.");
  console.log("No device, real account or remote provider request was used.");
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
