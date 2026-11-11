"use strict";

// Local, synthetic UI fixture only. Never forwards requests to account services.
const http = require("node:http");
const { readFileSync } = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");

const authCodes = new Map();
const config = {
  hardwareId: "fixture-hardware", refreshToken: "fixture-refresh",
  destDir: "/Books/Tolino", transportAccepted: true
};
const files = new Map([["settings.json", config]]);
const sdFiles = new Map();
const book = {
  publicationId: "fixture-publication",
  epubMetaData: {
    identifier: "fixture-book", title: "Test <script>alert('unsafe')</script>",
    author: [{ name: "Fixture Author" }], deliverable: [{ contentFormat: "application/epub+zip" }]
  }
};
const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Tolino plugin smoke test</title>
<body><main id="plugin"></main>
<script>
window.fixtureWrites = [];
window.fixtureRequests = [];
window.fixtureDownloads = [];
window.CrossPoint = {
  registerPlugin(render) {
    render(document.getElementById("plugin"), {
      dir: "/plugins/tolino-sync",
      pluginFile: (file) => "/fixture?file=" + encodeURIComponent(file),
      testOnlySignIn: () => {
        const state = window.crypto.randomUUID();
        const popup = window.open("/fixture/authorize?state=" + encodeURIComponent(state),
          "tolino-fixture-sign-in", "popup,width=480,height=640");
        if (!popup) return Promise.reject(new Error("The browser blocked the local sign-in popup."));
        return new Promise((resolve, reject) => {
          let settled = false;
          const finish = (error, value) => {
            if (settled) return;
            settled = true;
            window.removeEventListener("message", onMessage);
            clearTimeout(timeout);
            clearInterval(closeCheck);
            if (!popup.closed) popup.close();
            if (error) reject(error);
            else resolve(value);
          };
          const onMessage = async (event) => {
            if (event.origin !== window.location.origin || event.source !== popup) return;
            const message = event.data;
            if (!message || message.type !== "fixture-oauth-callback" || message.state !== state ||
                typeof message.code !== "string") return;
            try {
              const response = await fetch("/fixture/token", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: message.code, state })
              });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error || "Local token exchange failed.");
              finish(null, result);
            } catch (error) {
              finish(error);
            }
          };
          window.addEventListener("message", onMessage);
          const timeout = setTimeout(() => finish(new Error("Local sign-in timed out.")), 120000);
          const closeCheck = setInterval(() => {
            if (popup.closed) finish(new Error("The local sign-in window was closed."));
          }, 500);
        });
      },
      relay: async (method, url, headers, body) => {
        window.fixtureRequests.push({method, url, headers, body});
        return (await fetch("/relay", {method:"POST", body:JSON.stringify({method,url,body})})).json();
      },
      writeFile: async (path, data) => {
        window.fixtureWrites.push({path, data});
        return (await fetch("/write", {method:"POST", body:JSON.stringify({path,data})})).json();
      },
      crypto: async (op, fields) => (await fetch("/crypto", {method:"POST",body:JSON.stringify(fields)})).json(),
      fetchToSd: async (url, dest, headers) => {
        window.fixtureDownloads.push({url,dest,headers});
        return (await fetch("/fixture-download", {method:"POST",body:JSON.stringify({dest})})).json();
      }
    });
  }
};
</script>
<script src="/plugin.js"></script></body></html>`;

const loginHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Local sign-in simulator</title>
<body>
<main>
  <h1>Local sign-in simulator</h1>
  <p>This test page uses a synthetic account only. It never requests or sends Thalia credentials.</p>
  <button id="continue" type="button">Continue with synthetic fixture account</button>
</main>
<script>
const params = new URLSearchParams(location.search);
document.getElementById("continue").addEventListener("click", () => {
  if (!window.opener) {
    document.querySelector("main").textContent = "The test window has no opener. Close it and retry from the fixture page.";
    return;
  }
  window.opener.postMessage({
    type: "fixture-oauth-callback",
    state: params.get("state"),
    code: params.get("code")
  }, location.origin);
  window.close();
});
</script>
</body></html>`;

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "GET") {
      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(html);
      }
      if (url.pathname === "/plugin.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        return res.end(readFileSync(require.resolve("../plugins/tolino-sync/plugin.js")));
      }
      if (url.pathname === "/fixture/authorize") {
        const state = url.searchParams.get("state");
        if (!state || !/^[0-9a-f-]{36}$/i.test(state)) return json({ error: "Invalid fixture state." }, 400);
        const code = randomUUID();
        authCodes.set(code, state);
        res.writeHead(302, {
          Location: "/fixture/login?state=" + encodeURIComponent(state) + "&code=" + encodeURIComponent(code)
        });
        return res.end();
      }
      if (url.pathname === "/fixture/login") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(loginHtml);
      }
      if (url.pathname === "/fixture") {
        const file = url.searchParams.get("file");
        return files.has(file) ? json(files.get(file)) : json({}, 404);
      }
      if (url.pathname === "/api/files") {
        return json([...sdFiles].map(([name, size]) => ({name, size, isDirectory: false})));
      }
      return json({}, 404);
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    if (url.pathname === "/fixture-download") {
      sdFiles.set(input.dest.split("/").pop(), 42);
      return json({status: 200, complete: true, bytes: 42});
    }
    if (url.pathname === "/write") {
      files.set(input.path.split("/").pop(), JSON.parse(Buffer.from(input.data, "base64").toString("utf8")));
      return json({ ok: true });
    }
    if (url.pathname === "/crypto") {
      return json({ data: createHash("sha256").update(Buffer.from(input.data, "base64")).digest("base64") });
    }
    if (url.pathname === "/fixture/token") {
      if (!input || typeof input.code !== "string" || authCodes.get(input.code) !== input.state) {
        return json({ error: "Invalid, expired, or already used fixture authorization code." }, 400);
      }
      authCodes.delete(input.code);
      return json({ hardwareId: "fixture-hardware", refreshToken: "fixture-refresh" });
    }
    if (url.pathname === "/relay") {
      let response;
      if (input.url.includes("/oauth2/token")) response = { access_token: "fixture-access", refresh_token: "fixture-rotated", expires_in: 3600 };
      else if (input.url.includes("/inventory/")) response = { PublicationInventory: { ebook: [book], edata: [] } };
      else if (input.url.includes("/sync-data")) response = {
        revision: "fixture-r1", patches: [{
          op: "add", path: "/publications/fixture-publication/bookmark/42",
          value: { progress: 0.375, position: "chapter.xhtml#point(/1/2:0)", modified: 1000 }
        }]
      };
      else if (input.url.includes("/downloadinfo/")) response = {
        DownloadInfo: { contentUrl: "https://cdn.example/book.epub", format: "application/epub+zip" }
      };
      else return json({ error: "Unexpected fixture request" }, 400);
      return json({ status: 200, body: JSON.stringify(response) });
    }
    json({}, 404);
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => console.log("Smoke-test fixture: http://127.0.0.1:" + server.address().port));
}

module.exports = { createServer };
