#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [checkout, booksDirectory, helperUrl, helperKeyFile, syncUrl, username, passwordFile] = process.argv.slice(2);
if (!checkout || !booksDirectory || !helperUrl || !helperKeyFile ||
    (syncUrl && (!username || !passwordFile))) {
  throw new Error("Usage: node register-books.mjs CHECKOUT BOOKS_DIR HELPER_URL HELPER_KEY_FILE [SYNC_URL USERNAME PASSWORD_FILE]");
}
const { tolinoDocumentHash } = await import(pathToFileURL(path.resolve(checkout, "dist/connectors/tolino.js")));
const { tolinoXPath, tolinoPoint } = await import(pathToFileURL(path.resolve(checkout, "dist/connectors/tolino-epub.js")));
const { epubPosition } = await import(pathToFileURL(path.resolve(checkout, "dist/connectors/bookfusion-epub.js")));
const key = (await readFile(helperKeyFile, "utf8")).trim();
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

function origin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/") throw new Error("Use a helper/sync server origin, not a path or credential URL");
  return url.origin;
}
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Request failed (HTTP ${response.status}); no position was uploaded`);
  return response;
}
async function* books(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* books(file);
    else if (entry.isFile() && entry.name.endsWith(".epub")) yield file;
  }
}
const helper = origin(helperUrl), rows = [];
for await (const file of books(path.resolve(booksDirectory))) {
  let sidecar;
  try { sidecar = JSON.parse(await readFile(file + ".meta.json", "utf8")); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  const id = sidecar.tolino_id ?? sidecar.tolino_identifier;
  if (typeof id !== "string" || !id) continue;
  if ((await stat(file)).size > 200 * 1024 * 1024) throw new Error("EPUB exceeds 200 MiB");
  const bytes = await readFile(file), document = tolinoDocumentHash(bytes);
  const downloaded = await request(`${helper}/api/download?id=${encodeURIComponent(id)}`, { headers });
  const chunks = [];
  let size = 0;
  for await (const chunk of downloaded.body) {
    size += chunk.length;
    if (size > 200 * 1024 * 1024) throw new Error("Helper EPUB exceeds 200 MiB");
    chunks.push(chunk);
  }
  if (tolinoDocumentHash(Buffer.concat(chunks)) !== document) {
    throw new Error("Local and helper EPUB editions differ. Re-download instead of guessing positions.");
  }
  const cloud = await (await request(`${helper}/api/sync-position?id=${encodeURIComponent(id)}`, { headers })).json();
  if (cloud.position) {
    const xpath = await tolinoXPath(bytes, cloud.position.position);
    const roundtrip = await tolinoPoint(bytes, xpath);
    const initial = await epubPosition(bytes, xpath);
    const restored = await epubPosition(bytes, await tolinoXPath(bytes, roundtrip));
    if (initial.cfi !== restored.cfi) throw new Error("Exact cloud position roundtrip failed");
    console.log(`Verified exact cloud position (${(cloud.position.progress * 100).toFixed(1)}%); no cloud writes.`);
  }
  rows.push({ document, filename: path.basename(file), tolino_id: id, filesize: bytes.length });
}
if (!rows.length) throw new Error("No downloaded Tolino EPUBs with sidecars found");
if (!syncUrl) {
  console.log(`Checked ${rows.length} EPUB(s). Registration skipped; provide sync account arguments to register metadata only.`);
} else {
  const password = (await readFile(passwordFile, "utf8")).trim();
  const auth = { "x-auth-user": username, "x-auth-key": createHash("md5").update(password).digest("hex"),
    "content-type": "application/json" };
  const sync = origin(syncUrl);
  for (let offset = 0; offset < rows.length; offset += 50) {
    await request(`${sync}/api/v1/documents`, { method: "PUT", headers: auth,
      body: JSON.stringify({ items: rows.slice(offset, offset + 50) }) });
  }
  console.log(`Registered ${rows.length} EPUB(s), metadata only. No local or cloud reading position was uploaded.`);
}
