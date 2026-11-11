(function () {
  "use strict";

  const BOSH = "https://bosh.pageplace.de/bosh/rest";
  const TOKEN_URL = "https://www.thalia.de/auth/oauth2/token";
  const EPUB = "application/epub+zip";
  const MAX_FILE_BYTES = 256 * 1024;
  const encoder = new TextEncoder();

  function requireText(value, label) {
    if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(label + " must be non-empty text without control characters.");
    }
    return value.trim();
  }

  function base64(text) {
    return btoa(Array.from(encoder.encode(text), (byte) => String.fromCharCode(byte)).join(""));
  }

  function directory(value) {
    const path = requireText(value, "Download folder").replace(/\/+$/, "") || "/";
    if (!path.startsWith("/") || path.includes("\\") ||
        path.split("/").some((part) => part === "." || part === ".." || part.startsWith(".")) ||
        /[<>:"|?*]/.test(path)) {
      throw new Error("Use an absolute, non-hidden SD folder without dot segments or reserved characters.");
    }
    return path;
  }

  function settings(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid settings file.");
    }
    if (value.mode === "helper") {
      return {
        mode: "helper",
        helperUrl: helperURL(value.helperUrl),
        helperApiKey: requireText(value.helperApiKey, "Helper API key"),
        destDir: directory(value.destDir || "/Books/Tolino"),
        dest_dir: directory(value.destDir || "/Books/Tolino"),
        nativeTransportAccepted: value.transportAccepted === true ? "true" : "false",
        transportAccepted: value.transportAccepted === true
      };
    }
    return {
      hardwareId: requireText(value.hardwareId, "Hardware ID"),
      refreshToken: requireText(value.refreshToken, "Refresh token"),
      destDir: directory(value.destDir || "/Books/Tolino"),
      transportAccepted: value.transportAccepted === true
    };
  }

  function helperURL(value) {
    const url = new URL(requireText(value, "Helper URL"));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || !["", "/"].includes(url.pathname)) {
      throw new Error("Helper URL must be an HTTP(S) origin without path, credentials, query or fragment.");
    }
    return url.origin;
  }

  function parseJSON(text, label) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(label + " returned invalid or truncated JSON.");
    }
  }

  function httpError(status, label) {
    const advice = status === 401 || status === 403
      ? " Re-import a current Thalia web-reader session if refreshing does not help."
      : status === 429 ? " Rate limited; wait before trying again." : "";
    return new Error(label + " failed (HTTP " + status + ")." + advice);
  }

  function normalizeInventory(data) {
    const inventory = data && data.PublicationInventory;
    if (!inventory || !Array.isArray(inventory.ebook) || !Array.isArray(inventory.edata)) {
      throw new Error("Unrecognized Tolino inventory: expected PublicationInventory.ebook and .edata arrays.");
    }
    const books = new Map();
    for (const item of [...inventory.ebook, ...inventory.edata]) {
      const meta = item && item.epubMetaData;
      if (!meta || !Array.isArray(meta.deliverable) || !meta.deliverable.length) {
        throw new Error("A Tolino inventory entry has no EPUB metadata/deliverable.");
      }
      const id = requireText(meta.identifier, "Book identifier");
      const title = requireText(meta.title, "Book title");
      const deliverable = meta.deliverable[0];
      const protections = [item.contentProtectionType, meta.contentProtectionType, meta.protectionType,
        deliverable.contentProtectionType].map(value => String(value || "").toUpperCase());
      const protection = deliverable.contentEncrypted !== undefined && deliverable.contentEncrypted !== false
        ? "ENCRYPTED" : protections.find(value => !["", "UNPROTECTED", "WATERMARK", "WATERMARKV1", "NONE"].includes(value))
          || protections.find(Boolean) || "";
      books.set(id, {
        id,
        publicationId: requireText(item.publicationId || meta.publicationId || id, "Publication ID"),
        title,
        author: (meta.author || []).map((author) => author.name).filter(Boolean).join(", "),
        format: requireText(deliverable.contentFormat, "Book format"),
        protection
      });
    }
    return [...books.values()].sort((a, b) => a.title.localeCompare(b.title));
  }

  function downloadable(book) {
    return book.format.toLowerCase() === EPUB &&
      (!book.protection || ["UNPROTECTED", "WATERMARK", "WATERMARKV1", "NONE"].includes(book.protection));
  }

  function emptyState() {
    return { revision: null, bookmarks: {} };
  }

  function validateState(state) {
    if (!state || typeof state !== "object" ||
        !(state.revision === null || typeof state.revision === "string") ||
        !state.bookmarks || typeof state.bookmarks !== "object" || Array.isArray(state.bookmarks)) {
      throw new Error("Invalid saved cloud state. Clear the session before importing it again.");
    }
    for (const [path, value] of Object.entries(state.bookmarks)) {
      if (!/^\/publications\/[^/]+\/bookmark\/[^/]+$/.test(path)) {
        throw new Error("Invalid saved bookmark path.");
      }
      validateBookmark(value);
    }
    return state;
  }

  function validateBookmark(value) {
    if (!value || typeof value !== "object" || typeof value.progress !== "number" ||
        !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1 ||
        typeof value.position !== "string" || !Number.isFinite(value.modified) || value.modified < 0) {
      throw new Error("Unrecognized Tolino reading position; cached state was not advanced.");
    }
  }

  function applyCloudChanges(previous, response) {
    validateState(previous);
    if (!response || typeof response !== "object" ||
        (response.patches !== undefined && !Array.isArray(response.patches))) {
      throw new Error("Invalid Tolino reading-state response.");
    }
    const revision = response.revision === undefined ? previous.revision : response.revision;
    if (typeof revision !== "string" || !revision) {
      throw new Error("Tolino did not return a usable reading-state revision.");
    }
    const bookmarks = { ...previous.bookmarks };
    for (const patch of response.patches || []) {
      if (!patch || typeof patch.path !== "string" ||
          !["add", "replace", "remove"].includes(patch.op)) {
        throw new Error("Unrecognized Tolino patch; cached state was not advanced.");
      }
      const match = patch.path.match(/^\/publications\/([^/]+)\/bookmark\/([^/]+)$/);
      if (match) {
        if (patch.op === "remove") {
          delete bookmarks[patch.path];
        } else {
          validateBookmark(patch.value);
          bookmarks[patch.path] = { ...patch.value };
        }
      } else if (patch.path === "/publications" || /^\/publications\/[^/]+(?:\/bookmark)?$/.test(patch.path)) {
        if (patch.op !== "remove") {
          throw new Error("Tolino returned an unsupported bookmark snapshot. Cached state was not advanced.");
        }
        for (const path of Object.keys(bookmarks)) {
          if (path.startsWith(patch.path + "/")) delete bookmarks[path];
        }
      } else if (patch.path.includes("/bookmark")) {
        throw new Error("Unrecognized Tolino bookmark path; cached state was not advanced.");
      }
    }
    return { revision, bookmarks };
  }

  function readingState(state, publicationId) {
    const escaped = publicationId.replace(/~/g, "~0").replace(/\//g, "~1");
    const prefix = "/publications/" + escaped + "/bookmark/";
    const values = Object.entries(state.bookmarks)
      .filter(([path]) => path.startsWith(prefix)).map(([, value]) => value);
    return values.sort((a, b) => b.modified - a.modified)[0] || null;
  }

  class TolinoClient {
    constructor(api, fetchLocal = (...args) => fetch(...args)) {
      this.api = api;
      this.fetchLocal = fetchLocal;
      this.config = null;
      this.token = null;
      this.expiresAt = 0;
      this.state = emptyState();
      this.localBooks = new Map();
      this.busy = false;
    }

    async readJSON(file) {
      const response = await this.fetchLocal(this.api.pluginFile(file), { cache: "no-store" });
      if (response.status === 404) return null;
      if (!response.ok) throw httpError(response.status, "Read " + file);
      return parseJSON(await response.text(), file);
    }

    async writeJSON(file, value) {
      const text = JSON.stringify(value);
      if (encoder.encode(text).length > MAX_FILE_BYTES) {
        throw new Error(file + " exceeds CrossPoint's 256 KB plugin-file limit.");
      }
      const result = await this.api.writeFile(this.api.dir + "/" + file, base64(text));
      if (!result || result.ok !== true) throw new Error("CrossPoint did not confirm writing " + file + ".");
    }

    async load() {
      const stored = await this.readJSON("settings.json");
      if (stored !== null && stored.refreshToken !== "") this.config = settings(stored);
      const state = await this.readJSON("cloud-state.json");
      this.state = validateState(state === null ? emptyState() : state);
    }

    async exclusive(operation) {
      if (this.busy) throw new Error("Another Tolino operation is running. Please wait.");
      this.busy = true;
      try {
        return await operation();
      } finally {
        this.busy = false;
      }
    }

    async saveSession(value) {
      const next = settings(value);
      if (!next.transportAccepted) throw new Error("Acknowledge the transport/storage warning first.");
      // Reset the account-scoped revision before replacing credentials, even if a later write fails.
      await this.writeJSON("cloud-state.json", emptyState());
      this.state = emptyState();
      await this.writeJSON("response.json", {});
      await this.writeJSON("settings.json", next);
      this.config = next;
      this.localBooks.clear();
      this.token = null;
      this.expiresAt = 0;
    }

    async clearSession() {
      await this.writeJSON("settings.json", { refreshToken: "" });
      this.config = null;
      this.localBooks.clear();
      this.token = null;
      this.expiresAt = 0;
      await this.writeJSON("cloud-state.json", emptyState());
      this.state = emptyState();
      await this.writeJSON("response.json", {});
    }

    async refresh() {
      if (!this.config || !this.config.transportAccepted) {
        throw new Error("Import a Thalia session and acknowledge the transport/storage warning first.");
      }
      const response = await this.api.relay("POST", TOKEN_URL, {
        "Content-Type": "application/x-www-form-urlencoded"
      }, new URLSearchParams({
        client_id: "webreader",
        grant_type: "refresh_token",
        refresh_token: this.config.refreshToken,
        scope: "SCOPE_BOSH"
      }).toString());
      if (response.status !== 200) throw httpError(response.status, "Thalia token refresh");
      const body = parseJSON(response.body, "Thalia token refresh");
      const accessToken = requireText(body.access_token, "Access token");
      const next = { ...this.config, refreshToken: body.refresh_token === undefined
        ? this.config.refreshToken : requireText(body.refresh_token, "Rotated refresh token") };
      // Keep a rotated token in memory even if SD persistence fails; report the failure.
      this.config = next;
      await this.writeJSON("settings.json", next);
      this.token = accessToken;
      this.expiresAt = typeof body.expires_in === "number" && body.expires_in > 0
        ? Date.now() + body.expires_in * 1000 : 0;
    }

    headers() {
      return {
        t_auth_token: this.token,
        hardware_id: this.config.hardwareId,
        reseller_id: "3",
        "Content-Type": "application/json; charset=UTF-8",
        Accept: "application/json",
        client_type: "TOLINO_WEBREADER",
        client_version: "4.4.1"
      };
    }

    async requestJSON(method, url, body = "") {
      if (this.config && this.config.mode === "helper") {
        if (!this.config.transportAccepted) throw new Error("Acknowledge the helper transport/storage warning first.");
        const remote = new URL(url);
        let endpoint, helperMethod = method, helperBody = body;
        if (remote.origin !== new URL(BOSH).origin) throw new Error("Unsupported helper operation.");
        if (remote.pathname === "/bosh/rest/inventory/delta" && method === "GET") endpoint = "/api/inventory";
        else if (remote.pathname === "/bosh/rest/sync-data" && method === "PATCH") {
          const request = parseJSON(body, "Reading-state request");
          if (!Array.isArray(request.patches) || request.patches.length) throw new Error("Helper reading states are read-only.");
          endpoint = "/api/reading-state";
          helperMethod = "POST";
          helperBody = JSON.stringify({ revision: request.revision });
        } else if (remote.pathname.startsWith("/bosh/rest/cloud/downloadinfo/") && method === "GET") {
          const encoded = remote.pathname.split("/")[5];
          endpoint = "/api/download-info?id=" + encodeURIComponent(
            new TextDecoder().decode(Uint8Array.from(atob(decodeURIComponent(encoded)), char => char.charCodeAt(0))));
        } else throw new Error("Unsupported helper operation.");
        const helperHeaders = {
          Authorization: "Bearer " + this.config.helperApiKey,
          "Content-Type": "application/json"
        };
        let response;
        try {
          response = await this.api.relay(helperMethod, this.config.helperUrl + endpoint, helperHeaders, helperBody);
        } catch (error) {
          if (error.status !== 502) throw error;
          const result = await this.api.fetchToSd(this.config.helperUrl + endpoint, this.api.dir + "/response.json",
            helperHeaders, {method: helperMethod, body: helperBody});
          if (!result || result.error || result.complete !== true || result.status !== 200) {
            throw httpError(result && result.status, "Helper SD response");
          }
          return await this.readJSON("response.json");
        }
        if (response.status !== 200) {
          throw new Error("Helper request failed (HTTP " + response.status +
            "). Check the API key and sign in on the helper dashboard.");
        }
        return parseJSON(response.body, "Helper");
      }
      if (!this.token || (this.expiresAt && Date.now() >= this.expiresAt - 60000)) await this.refresh();
      for (let attempt = 0; attempt < 2; attempt++) {
        let response;
        try {
          response = await this.api.relay(method, url, this.headers(), body);
        } catch (error) {
          if (error.status !== 502) throw error;
          // Both calls are read-only: GET inventory or PATCH with an empty patches array.
          let result;
          try {
            result = await this.api.fetchToSd(url, this.api.dir + "/response.json",
              this.headers(), { method, body });
          } catch (transferError) {
            const failed = transferError.result;
            if (!failed || (failed.status !== 401 && failed.status !== 403)) throw transferError;
            result = failed;
          }
          if (result && (result.status === 401 || result.status === 403)) {
            response = { status: result.status };
          } else if (!result || result.error || result.complete !== true || result.status !== 200) {
            throw httpError(result && result.status, "Tolino SD response");
          } else {
            response = { status: 200, body: JSON.stringify(await this.readJSON("response.json")) };
          }
        }
        if ((response.status === 401 || response.status === 403) && attempt === 0) {
          await this.refresh();
          continue;
        }
        if (response.status !== 200) throw httpError(response.status, "Tolino request");
        return parseJSON(response.body, "Tolino request");
      }
      throw new Error("Tolino authentication retry failed.");
    }

    async listBooks() {
      const books = normalizeInventory(await this.requestJSON("GET", BOSH + "/inventory/delta?strip=true"));
      await this.refreshLocalBooks(books);
      return books;
    }

    bookFilename(book) {
      if (typeof book.title !== "string" || !book.title.trim()) throw new Error("Book title is missing; no filename was guessed.");
      const clean = book.title.replace(/[\\/:*?"<>|]/g, "_").replace(/[\x00-\x1f\x7f]/g, "")
        .replace(/\.{2,}/g, "_").replace(/^[ .]+|[ .]+$/g, "");
      let stem = "";
      for (const character of clean) {
        if (encoder.encode(stem + character).length > 95) break;
        stem += character;
      }
      return (stem.replace(/[ .]+$/g, "") || "book") + ".epub";
    }

    async legacyFilename(book) {
      const digest = await this.api.crypto("sha256", { data: base64(book.id) });
      const bytes = Uint8Array.from(atob(digest.data), (char) => char.charCodeAt(0));
      if (bytes.length !== 32) throw new Error("CrossPoint returned an invalid SHA-256 digest.");
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") + ".epub";
    }

    async deviceFiles() {
      if (!this.config) throw new Error("Save connection settings before checking the reader SD.");
      const response = await this.fetchLocal("/api/files?path=" + encodeURIComponent(this.config.destDir), { cache: "no-store" });
      if (!response.ok) throw httpError(response.status, "Check existing books on reader SD");
      const files = parseJSON(await response.text(), "Reader SD file list");
      if (!Array.isArray(files) || files.length > 10000 || files.some(file => !file ||
        typeof file.name !== "string" || !file.name || /[/\\\x00-\x1f]/.test(file.name) ||
        file.name === "." || file.name === ".." || typeof file.isDirectory !== "boolean" ||
        !Number.isSafeInteger(file.size) || file.size < 0)) {
        throw new Error("Invalid or oversized reader SD file list. Download stopped to avoid overwriting existing books.");
      }
      return files;
    }

    async localBookPath(files, book) {
      const filename = this.bookFilename(book).toLowerCase();
      const legacy = await this.legacyFilename(book);
      const matches = files.filter(file => file.name.toLowerCase() === filename ||
        file.name.toLowerCase() === legacy || file.name.toLowerCase().endsWith("-" + legacy));
      if (matches.some(file => file.isDirectory || file.size === 0)) {
        throw new Error("An empty file or directory already occupies this book's filename. Check the SD before downloading again.");
      }
      const folder = this.config.destDir === "/" ? "" : this.config.destDir;
      let existing = null;
      let priority = Infinity;
      for (const file of files.filter(file => !file.isDirectory && file.size > 0 && /\.epub$/i.test(file.name))) {
        const path = folder + "/" + file.name;
        const response = await this.fetchLocal("/download?path=" + encodeURIComponent(path + ".meta.json"), { cache: "no-store" });
        let identifier = null;
        if (response.ok) {
          const meta = parseJSON(await response.text(), "Existing book sidecar");
          if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Invalid existing book sidecar. Download stopped.");
          identifier = meta.tolino_id || meta.tolino_identifier || null;
        } else if (response.status !== 404) {
          throw httpError(response.status, "Check existing book sidecar");
        }
        if (matches.includes(file) && identifier && identifier !== book.id) {
          throw new Error("Another book already uses this title's filename. Download stopped to avoid overwriting it.");
        }
        const name = file.name.toLowerCase();
        const rank = name === filename ? 0 : name === legacy ? 1 : matches.includes(file) ? 2 : 3;
        if ((identifier === book.id || matches.includes(file)) && rank < priority) {
          existing = path;
          priority = rank;
        }
      }
      return existing;
    }

    async refreshLocalBooks(books) {
      const files = await this.deviceFiles();
      const local = new Map();
      for (const book of books) {
        const path = await this.localBookPath(files, book);
        if (path) local.set(book.id, path);
      }
      this.localBooks = local;
    }

    async pullReadingStates() {
      const response = await this.requestJSON("PATCH", BOSH + "/sync-data?paths=publications",
        JSON.stringify({ revision: this.state.revision, patches: [] }));
      const next = applyCloudChanges(this.state, response);
      await this.writeJSON("cloud-state.json", next);
      this.state = next;
      return next;
    }

    async download(book) {
      return (await this.ensureDownloaded(book)).path;
    }

    async ensureDownloaded(book) {
      if (!downloadable(book)) throw new Error("Only unprotected or watermarked EPUBs are supported; no Adobe DRM, ACSM, PDF or audiobooks.");
      const filename = this.bookFilename(book);
      const existing = await this.localBookPath(await this.deviceFiles(), book);
      if (existing) {
        this.localBooks.set(book.id, existing);
        return { path: existing, downloaded: false };
      }
      this.localBooks.delete(book.id);
      const id = encodeURIComponent(base64(book.id));
      const response = await this.requestJSON("GET", BOSH + "/cloud/downloadinfo/" + id + "/" + id + "/type/external-download");
      const info = response && response.DownloadInfo;
      if (!info || typeof info.format !== "string" || info.format.toLowerCase() !== EPUB) {
        throw new Error("Tolino did not offer an EPUB. Adobe DRM / ACSM files are not supported.");
      }
      const helper = this.config.mode === "helper";
      const url = helper ? new URL(requireText(info.contentUrl, "Content URL"), this.config.helperUrl)
        : new URL(requireText(info.contentUrl, "Content URL"));
      if (helper ? url.origin !== this.config.helperUrl || url.pathname !== "/api/download" || url.username || url.password
        : url.protocol !== "https:" || url.username || url.password) {
        throw new Error("Tolino returned an unsafe content URL; HTTPS without embedded credentials is required.");
      }
      const dest = (this.config.destDir === "/" ? "" : this.config.destDir) + "/" + filename;
      // Signed CDN URLs must not receive the account token.
      const headers = helper ? {Authorization: "Bearer " + this.config.helperApiKey}
        : url.origin === new URL(BOSH).origin ? this.headers() : {};
      const result = await this.api.fetchToSd(url.href, dest, headers);
      if (!result || result.error || result.complete !== true || result.status !== 200) {
        throw httpError(result && result.status, "Book download");
      }
      await this.writeSidecar(dest, book);
      this.localBooks.set(book.id, dest);
      return { path: dest, downloaded: true };
    }

    async writeSidecar(dest, book) {
      const response = await this.fetchLocal("/download?path=" + encodeURIComponent(dest + ".meta.json"), { cache: "no-store" });
      let existing = {};
      if (response.ok) {
        existing = parseJSON(await response.text(), "Existing book sidecar");
        if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
          throw new Error("Existing book sidecar is not an object. Book downloaded, metadata not changed.");
        }
      } else if (response.status !== 404) {
        throw httpError(response.status, "Read existing book sidecar (book downloaded)");
      }
      const metadata = {
        ...existing,
        tolino_identifier: book.id,
        tolino_publication_id: book.publicationId,
        tolino_id: book.id
      };
      const text = JSON.stringify(metadata);
      if (encoder.encode(text).length > 2048) throw new Error("Book downloaded, but merged sidecar exceeds the firmware's 2 KB limit.");
      const result = await this.api.writeFile(dest + ".meta.json", base64(text));
      if (!result || result.ok !== true) throw new Error("Book downloaded, but CrossPoint did not confirm saving its metadata.");
    }
  }

  async function render(container, api) {
    const client = new TolinoClient(api);
    const element = (tag, text, parent = container) => {
      const node = document.createElement(tag);
      if (text) node.textContent = text;
      parent.appendChild(node);
      return node;
    };
    element("h2", "Thalia / Tolino");
    element("p", "Download EPUB books directly to the CrossPoint SD card and view cloud reading positions. Keep this browser page and the reader's File Transfer running until the download finishes. Saved reader positions are not synchronized.");
    const details = element("details");
    const fixtureSignIn = typeof api.testOnlySignIn === "function"
      ? element("button", "Sign in (local simulator only)") : null;
    if (fixtureSignIn) fixtureSignIn.type = "button";
    element("summary", "Connection settings", details);
    element("p", "Recommended: sign in on the Docker helper dashboard, then enter its API URL and API key here. The helper manages login and token renewal; no Thalia password or tokens are copied to the reader. Imported webreader sessions remain an optional manual fallback.", details);
    const form = element("form", "", details);
    const field = (label, type) => {
      const wrapper = element("label", label + " ", form);
      const input = element("input", "", wrapper);
      input.type = type;
      input.autocomplete = "off";
      input.required = true;
      element("br", "", form);
      return input;
    };
    const modeLabel = element("label", "Connection mode ", form);
    const mode = element("select", "", modeLabel);
    for (const [value, title] of [["helper", "Docker helper (recommended)"], ["direct", "Imported webreader session"]]) {
      const option = element("option", title, mode);
      option.value = value;
    }
    const helperUrl = field("Helper URL (for example http://192.168.1.10:8081)", "url");
    const helperKey = field("Helper API key (stored on SD)", "password");
    const hardware = field("Hardware ID", "text");
    const secret = field("Refresh token (stored on SD)", "password");
    const destDir = field("Download folder", "text");
    destDir.value = "/Books/Tolino";
    const warning = element("label", "", form);
    const accepted = element("input", "", warning);
    accepted.type = "checkbox";
    accepted.required = true;
    element("span", " I accept: tokens are plaintext on the SD card and accessible over the device's web server; the device relay does not verify TLS certificates. Use only a trusted network.", warning);
    element("br", "", form);
    const updateMode = () => {
      for (const input of [helperUrl, helperKey]) {
        input.parentElement.hidden = mode.value !== "helper"; input.required = mode.value === "helper";
      }
      for (const input of [hardware, secret]) {
        input.parentElement.hidden = mode.value === "helper"; input.required = mode.value !== "helper";
      }
    };
    mode.addEventListener("change", updateMode);
    updateMode();
    element("p", "Keep the Docker bridge running for login renewal, library access and downloads. Use its LAN API URL (normally port 8081) and key from the dashboard, not the dashboard (8080) or login browser (6080) URL. Saved reader progress additionally requires the CrossPoint Sync connector and the reader's separate Sync settings. The API key is plaintext on SD; HTTP LAN traffic is unencrypted. Use a trusted network or HTTPS.", form);
    const save = element("button", "Save connection", form);
    save.type = "submit";
    const clear = element("button", "Clear local session");
    clear.type = "button";
    const list = element("button", "Load cloud library");
    list.type = "button";
    const progress = element("button", "Refresh cloud reading positions (read-only)");
    progress.type = "button";
    const search = element("input");
    search.type = "search";
    search.placeholder = "Filter title or author";
    search.setAttribute("aria-label", "Filter books by title or author");
    const status = element("p", "Loading local settings...");
    status.setAttribute("role", "status");
    const output = element("div");
    let books = [];
    let locked = false;

    function showBooks() {
      output.replaceChildren();
      const query = search.value.toLocaleLowerCase();
      const filtered = books.filter((book) => (book.title + " " + book.author).toLocaleLowerCase().includes(query));
      if (books.length && !filtered.length) element("p", "No matching books.", output);
      for (const book of filtered) {
        const row = element("div", "", output);
        element("strong", book.title, row);
        element("p", book.author || "Unknown author", row);
        const reading = readingState(client.state, book.publicationId);
        element("p", reading ? "Cloud: " + (reading.progress * 100).toFixed(1) + "%" +
          (reading.currentPosition ? " (cloud page " + reading.currentPosition + ")" : "") +
          ". Reference only; CrossPoint's saved page is unchanged."
          : "No cloud reading position matched by publication ID.", row);
        if (reading) element("p", "Cloud locator: " + reading.position, row);
        const localPath = client.localBooks.get(book.id);
        if (localPath) element("p", "Already on reader SD: " + localPath, row);
        const button = element("button", localPath ? "Already on SD" :
          downloadable(book) ? "Download EPUB to reader SD" : "Unsupported format / DRM", row);
        button.type = "button";
        button.disabled = locked || !downloadable(book) || Boolean(localPath);
        button.dataset.download = "true";
        button.dataset.supported = String(downloadable(book));
        button.dataset.onDevice = String(Boolean(localPath));
        button.addEventListener("click", () => run(async () => {
          status.textContent = "Downloading " + book.title + "... Keep this page open.";
          const result = await client.ensureDownloaded(book);
          showBooks();
          return result.downloaded ? "Saved " + result.path + ". Cloud progress was not applied to the reader."
            : "Already on reader SD: " + result.path + ". Download skipped; file and reading progress were not changed.";
        }));
      }
    }

    function setLocked(value) {
      locked = value;
      for (const node of [save, clear, list, progress, hardware, secret, destDir, accepted, mode, helperUrl, helperKey, fixtureSignIn].filter(Boolean)) {
        node.disabled = value;
      }
      for (const node of output.querySelectorAll("button[data-download]")) {
        node.disabled = value || node.dataset.supported !== "true" || node.dataset.onDevice === "true";
      }
    }

    async function run(operation) {
      if (locked) return;
      setLocked(true);
      status.textContent = "Working... Keep this page open.";
      status.style.color = "";
      try {
        status.textContent = await client.exclusive(operation);
      } catch (error) {
        status.textContent = error.message || String(error);
        status.style.color = "#b00020";
      } finally {
        setLocked(false);
      }
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      run(async () => {
        await client.saveSession(mode.value === "helper" ? {
          mode: "helper", helperUrl: helperUrl.value, helperApiKey: helperKey.value,
          destDir: destDir.value, transportAccepted: accepted.checked
        } : {
          hardwareId: hardware.value, refreshToken: secret.value,
          destDir: destDir.value, transportAccepted: accepted.checked
        });
        secret.value = "";
        helperKey.value = "";
        books = [];
        showBooks();
        return "Session saved. Load the cloud library to connect.";
      });
    });
    if (fixtureSignIn) {
      fixtureSignIn.addEventListener("click", () => run(async () => {
        const session = await api.testOnlySignIn();
        await client.saveSession({
          hardwareId: session.hardwareId,
          refreshToken: session.refreshToken,
          destDir: destDir.value,
          transportAccepted: accepted.checked
        });
        hardware.value = session.hardwareId;
        secret.value = "";
        helperKey.value = "";
        helperUrl.value = "";
        books = [];
        showBooks();
        return "Fixture sign-in complete. Synthetic credentials only; no Thalia account contacted.";
      }));
    }
    clear.addEventListener("click", () => run(async () => {
      await client.clearSession();
      secret.value = "";
      hardware.value = "";
      accepted.checked = false;
      books = [];
      showBooks();
      return "Local credentials and cloud positions cleared. This does not revoke the Thalia session or delete books.";
    }));
    list.addEventListener("click", () => run(async () => {
      books = await client.listBooks();
      showBooks();
      return books.length + " cloud books loaded. Use Refresh cloud reading positions to fetch progress.";
    }));
    progress.addEventListener("click", () => run(async () => {
      await client.pullReadingStates();
      showBooks();
      return "Cloud reading positions refreshed (read-only). No saved reader positions changed.";
    }));
    const refreshTimer = setInterval(() => {
      if (!container.isConnected) {
        clearInterval(refreshTimer);
        return;
      }
      if (!client.config || !books.length || locked) return;
      run(async () => {
        await client.pullReadingStates();
        showBooks();
        return "Cloud reading positions refreshed automatically (every 5 minutes). No saved reader positions changed.";
      });
    }, 5 * 60 * 1000);
    search.addEventListener("input", showBooks);
    await run(async () => {
      await client.load();
      if (client.config) {
        mode.value = client.config.mode === "helper" ? "helper" : "direct";
        hardware.value = client.config.hardwareId || "";
        helperUrl.value = client.config.helperUrl || "";
        helperKey.value = client.config.helperApiKey || "";
        destDir.value = client.config.destDir;
        accepted.checked = client.config.transportAccepted;
        updateMode();
      } else {
        details.open = true;
      }
      return client.config ? "Connection available. Load the cloud library to connect." : "Configure a Docker helper or import a webreader session to begin.";
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { TolinoClient, normalizeInventory, downloadable, applyCloudChanges, readingState, settings, render };
  }
  if (typeof window !== "undefined" && window.CrossPoint) {
    window.CrossPoint.registerPlugin(render);
  }
})();
