"use strict";
const $ = id => document.getElementById(id);
let inventory = [], previous = "", sort = "title", direction = 1, connected = false, apiKey = "";
let positions = {}, readingLoaded = false, readingBusy = false, readingGeneration = 0;
const READING_REFRESH_MS = 5 * 60 * 1000;
let readingAttemptedAt = -Infinity, readingVersion;
const {text, date: formatDate, language: formatLanguage, progress: formatProgress, protection, downloadable} = TolinoDisplay;
const normalized = item => {
  const meta = item.epubMetaData || {};
  const deliverable = Array.isArray(meta.deliverable) ? meta.deliverable[0] || {} : {};
  return {
    item, meta, title: text(meta.title), author: Array.isArray(meta.author)
      ? meta.author.map(author => author && typeof author === "object" ? author.name || "" : text(author)).join(", ") : text(meta.author),
    publisher: text(meta.publisher), issued: text(meta.issued),
    language: Array.isArray(meta.language) ? meta.language.map(text).join(", ") : text(meta.language),
    format: text(deliverable.contentFormat).replace("application/epub+zip", "EPUB"),
    protection: protection(item) || "—"
  };
};
function cell(row, value) { const node = document.createElement("td"); node.textContent = value || "—"; row.append(node); return node; }
function render() {
  const query = $("search").value.toLocaleLowerCase();
  const books = inventory.map(normalized).filter(book => JSON.stringify(book.item).toLocaleLowerCase().includes(query))
    .sort((a, b) => direction * a[sort].localeCompare(b[sort], "de", {numeric: true}));
  $("books").replaceChildren();
  $("count").textContent = inventory.length;
  $("visible-count").textContent = books.length;
  $("empty").hidden = books.length > 0;
  $("empty").querySelector("p").textContent = inventory.length ? "Keine passenden Bücher gefunden." :
    connected ? "Die Cloud hat keine Bücher zurückgegeben." : "Melde dich an, um deine Cloud-Bibliothek zu laden.";
  for (const book of books) {
    const row = document.createElement("tr");
    const cover = cell(row, ""); cover.className = "cover-cell"; cover.textContent = "";
    const frame = document.createElement("div"); frame.className = "cover-frame"; cover.append(frame);
    const placeholder = document.createElement("span"); placeholder.className = "cover-placeholder";
    placeholder.textContent = book.title.slice(0, 1).toLocaleUpperCase() || "B";
    placeholder.setAttribute("aria-label", "Kein Cover verfügbar"); frame.append(placeholder);
    if (Array.isArray(book.meta.fileResource) && book.meta.fileResource.some(resource =>
      resource && typeof resource.resource === "string" && resource.resource.startsWith("https://"))) {
      const image = document.createElement("img"); image.alt = "Cover: " + book.title; image.loading = "lazy";
      image.className = "cover"; image.src = "/cover?id=" + encodeURIComponent(book.meta.identifier);
      image.onload = () => { placeholder.hidden = true; };
      image.onerror = () => { image.hidden = true; placeholder.hidden = false; };
      frame.append(image);
    }
    const title = cell(row, "");
    title.textContent = "";
    const strong = document.createElement("strong"); strong.textContent = book.title; title.append(strong);
    const isbn = document.createElement("small"); isbn.textContent = book.meta.isbn ? "ISBN " + text(book.meta.isbn) : text(book.meta.identifier); title.append(isbn);
    cell(row, book.author);
    const readingCell = cell(row, ""), publicationId = book.item.publicationId || book.meta.publicationId || book.meta.identifier;
    const reading = Object.hasOwn(positions, publicationId) ? positions[publicationId] : null;
    readingCell.className = "reading-cell";
    readingCell.textContent = reading ? formatProgress(reading.progress) :
      readingBusy ? "Wird geladen …" : readingLoaded ? "Kein Cloud-Lesestand" : "Nicht abgerufen";
    if (reading) {
      const bar = document.createElement("progress"); bar.max = 1; bar.value = reading.progress;
      bar.setAttribute("aria-label", "Cloud-Lesefortschritt: " + formatProgress(reading.progress));
      readingCell.append(bar);
      if (reading.currentPosition) {
        const page = document.createElement("small");
        page.textContent = "Cloud-Seite " + reading.currentPosition + (reading.lastPosition ? " / " + reading.lastPosition : "");
        readingCell.append(page);
      }
      if (reading.modified > 0) {
        const updated = document.createElement("small"); updated.textContent = "Stand: " + formatDate(reading.modified);
        readingCell.append(updated);
      }
      readingCell.title = reading.position;
    }
    cell(row, book.publisher); cell(row, formatDate(book.meta.issued));
    cell(row, formatLanguage(book.meta.language));
    const format = cell(row, ""); format.textContent = "";
    const pill = document.createElement("span"); pill.className = "pill"; pill.textContent = book.format || "Unbekannt"; format.append(pill);
    const protection = document.createElement("small"); protection.textContent = book.protection; format.append(protection);
    const detail = cell(row, ""); detail.textContent = "";
    const details = document.createElement("details"), summary = document.createElement("summary"), pre = document.createElement("pre");
    summary.textContent = "Alle Metadaten"; pre.className = "metadata"; pre.textContent = JSON.stringify(book.item, null, 2);
    details.append(summary, pre); detail.append(details);
    if (downloadable(book.item)) {
      const download = document.createElement("a"); download.className = "download-link";
      download.href = "/download?id=" + encodeURIComponent(book.meta.identifier);
      download.textContent = "EPUB laden ↓";
      download.download = "";
      detail.append(download);
    } else {
      const unsupported = document.createElement("small"); unsupported.textContent = "Kein freier EPUB-Download"; detail.append(unsupported);
    }
    $("books").append(row);
  }
}
async function request(path, data) {
  const response = await fetch(path, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)});
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Anfrage abgelehnt: HTTP " + response.status);
  return result;
}
async function refreshProgress() {
  if (!connected || readingBusy) return;
  readingAttemptedAt = Date.now();
  const requestedVersion = readingVersion;
  const generation = ++readingGeneration;
  readingBusy = true; positions = {}; readingLoaded = false;
  $("refresh-progress").disabled = true;
  $("reading-status").classList.remove("error");
  $("reading-status").textContent = "Cloud-Lesestände werden abgerufen …";
  render();
  try {
    const result = await request("/reading-progress", {});
    if (generation !== readingGeneration) return;
    if (!result.positions || typeof result.positions !== "object" || Array.isArray(result.positions)) {
      throw new Error("Unerwartete Antwort für Cloud-Lesestände.");
    }
    positions = result.positions; readingLoaded = true;
    $("reading-status").textContent = "Cloud-Lesestände abgerufen. Automatisch alle 5 Minuten und nach erfolgreichem Push. Nur lesend; keine Übertragung zu Thalia.";
  } catch (error) {
    if (generation !== readingGeneration) return;
    $("reading-status").textContent = "Cloud-Lesestand fehlgeschlagen: " + error.message;
    $("reading-status").classList.add("error");
  } finally {
    if (generation === readingGeneration) {
      readingBusy = false; $("refresh-progress").disabled = !connected; render();
      if (requestedVersion !== readingVersion) void refreshProgress();
    }
  }
}
function failure(error) { $("status").textContent = error.message; $("status").classList.add("error"); }
$("login").onsubmit = async event => {
  event.preventDefault();
  const password = $("password").value; $("password").value = "";
  try { await request("/login", {username: $("username").value, password,
    rememberCredentials: $("remember-credentials").checked}); await poll(false); } catch (error) { failure(error); }
};
$("forget").onclick = async () => {
  try { await request("/forget", {}); $("remember-credentials").checked = false; await poll(false); }
  catch (error) { failure(error); }
};
$("reload").onclick = async () => { try { await request("/reload", {}); await poll(false); } catch (error) { failure(error); } };
$("refresh-progress").onclick = refreshProgress;
$("search").oninput = render;
for (const button of document.querySelectorAll("[data-sort]")) button.onclick = () => {
  direction = sort === button.dataset.sort ? -direction : 1; sort = button.dataset.sort; render();
};
$("show-key").onclick = () => {
  const visible = $("api-key").type === "password"; $("api-key").type = visible ? "text" : "password";
  $("api-key").value = visible ? apiKey : "";
  $("show-key").textContent = visible ? "Schlüssel verbergen" : "Schlüssel anzeigen";
};
async function poll(schedule = true) {
  try {
    let response = await fetch("/status");
    if (response.status === 403) {
      // Re-pair only with this same local admin origin after a helper restart.
      const paired = await fetch("/");
      if (!paired.ok) throw new Error("Lokale Sitzung erneuern: Seite neu laden.");
      await connection();
      response = await fetch("/status");
    }
    if (!response.ok) throw new Error("Status nicht erreichbar: HTTP " + response.status);
    const state = await response.json(), wasConnected = connected; connected = state.connected;
    const pushed = readingVersion !== undefined && readingVersion !== state.readingVersion;
    readingVersion = state.readingVersion;
    $("status").textContent = state.message; $("status").classList.toggle("error", !state.busy && !state.connected && state.message.includes("fehlgeschlagen"));
    $("submit").disabled = state.busy || state.testOnly === true;
    $("username").disabled = state.testOnly === true; $("password").disabled = state.testOnly === true;
    $("remember-credentials").disabled = !state.persistenceEnabled || state.busy || state.testOnly === true;
    $("forget").disabled = state.busy || (!state.connected && !state.sessionSaved && !state.credentialsSaved && !state.persistenceEnabled);
    $("persistence-status").textContent = state.persistenceEnabled
      ? state.sessionSaved ? "Sitzung verschlüsselt gespeichert. " + (state.credentialsSaved
        ? "Automatische Neuanmeldung mit gespeicherten Zugangsdaten aktiviert."
        : "Kein Passwort gespeichert. Token-Erneuerung erfolgt automatisch.")
      : "Persistenter Sitzungsspeicher bereit. Zugangsdaten werden nur bei aktivierter Option gespeichert."
      : "Kein persistenter Speicher konfiguriert: Anmeldung geht beim Neustart verloren.";
    $("reload").disabled = state.busy || !state.connected;
    $("refresh-progress").disabled = state.busy || !state.connected || readingBusy;
    $("connection-state").textContent = state.connected ? "Verbunden" : state.busy ? "Verbinden …" : "Offline";
    const next = JSON.stringify(state.inventory || []);
    const changed = next !== previous;
    if (changed) { previous = next; inventory = state.inventory || []; }
    if (!connected || state.busy) {
      ++readingGeneration; positions = {}; readingLoaded = false; readingBusy = false;
      $("reading-status").textContent = "Cloud-Lesestände werden nach der Anmeldung automatisch abgerufen. Nur lesend, keine Übertragung zu Thalia.";
      $("reading-status").classList.remove("error");
    }
    if (changed || wasConnected !== connected) render();
    if (connected && !state.busy && (changed || !wasConnected || pushed ||
        Date.now() - readingAttemptedAt >= READING_REFRESH_MS)) void refreshProgress();
  } catch (error) { failure(error); }
  if (schedule) setTimeout(poll, 1500);
}
async function connection() {
  const response = await fetch("/connection");
  if (!response.ok) throw new Error("API-Konfiguration nicht erreichbar: HTTP " + response.status);
  const config = await response.json(); apiKey = config.apiKey; $("helper-url").value = config.publicUrl;
  if (config.browserUrl) $("browser-link").href = config.browserUrl;
  $("api-key").value = ""; $("api-key").type = "password";
  $("api-key").placeholder = "Zum Anzeigen auf den Button klicken";
  $("show-key").textContent = "Schlüssel anzeigen";
}
render();
poll();
connection().catch(failure);
