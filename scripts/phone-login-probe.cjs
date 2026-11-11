"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { readerOrigin } = require("./local-setup.cjs");

function probeHTML() {
  const auth = new URL("https://webreader.mytolino.com/auth/index.html");
  auth.search = new URLSearchParams({
    app_id: "TOLINO_WEBREADER",
    reseller_id: "3",
    locale: "de-DE",
    theme: "theme-tolino-light",
    redirect_uri: "https://webreader.mytolino.com/library/",
  });
  return `<!doctype html>
<html lang="de"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tolino Smartphone-Login-Test</title>
<style>body{font:18px system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem}
button{font:inherit;padding:1rem}li{margin:1rem 0}pre{white-space:pre-wrap}</style>
<h1>Smartphone-Login-Test</h1>
<p>Die lokale Adresse wurde vom Anbieter als redirect_uri abgelehnt.
Dieser Test verwendet deshalb das offiziell konfigurierte Webreader-Ziel.
Ein erfolgreicher Login kann dort enden, ohne eine Nachricht an diese Seite
zurueckzugeben. Das ist noch keine funktionierende Smartphone-Kopplung.</p>
<p>Experiment, noch keine Reader-Einrichtung. Diese Seite erfasst nur
Nachrichtentypen und ob Token-Felder vorhanden sind. Keine Token-Werte werden
angezeigt, gespeichert oder an diesen Server gesendet.</p>
<p>Nur in einem vertrauenswuerdigen WLAN verwenden. Die Testseite nutzt HTTP.
Passwort ausschliesslich auf der offiziellen HTTPS-Seite von Thalia eingeben.
Keine Tokens, Callback-URLs oder Screenshots mit Zugangsdaten teilen.</p>
<ol><li>Offizielle Anmeldung mit dem Button oeffnen. Pop-ups erlauben.</li>
<li>Im neuen Tab manuell bei Thalia anmelden. Sicherheitspruefungen dort normal
abschliessen, nicht umgehen.</li>
<li>Danach zu diesem Tab zurueckkehren und den Status lesen.</li></ol>
<button id="start">Offizielle Anmeldung oeffnen</button>
<button id="stop" disabled>Test beenden</button>
<pre id="status" role="status">Bereit. Der Test installiert keine Sitzung.</pre>
<script>
"use strict";
const official = "https://webreader.mytolino.com";
const status = document.getElementById("status");
let popup, timer, expiry, lastMessage, closedReported = false;
function report(text) { status.textContent += "\\n" + text; }
function stop() {
  clearInterval(timer); clearTimeout(expiry);
  window.removeEventListener("message", receive);
  document.getElementById("stop").disabled = true;
  report("Test beendet. Keine Sitzung gespeichert. Offiziellen Login-Tab selbst schliessen.");
}
function receive(event) {
  if (event.origin !== official || event.source !== popup) return;
  let data;
  try { data = typeof event.data === "string" ? JSON.parse(event.data) : event.data; }
  catch { report("Offizielle Nachricht empfangen, aber kein lesbares JSON."); return; }
  if (!data || data.channel !== "auth") return;
  if (data.message === "init" || data.message === "remoteConfig") {
    if (lastMessage !== data.message) report("Offizielle AuthApp: " + data.message + " empfangen.");
    lastMessage = data.message;
  } else if (data.message === "token") {
    const value = data.data;
    const access = !!value && typeof value.access_token === "string" && value.access_token.length > 0;
    const refresh = !!value && typeof value.refresh_token === "string" && value.refresh_token.length > 0;
    report("Token-Nachricht von offizieller AuthApp empfangen. Access-Feld: " +
      (access ? "vorhanden" : "nicht erkannt") + "; Refresh-Feld: " +
      (refresh ? "vorhanden" : "nicht erkannt") +
      ". Werte verworfen; dies bestaetigt noch keine nutzbare Reader-Sitzung.");
    stop();
  } else {
    report("Weiterer Auth-Nachrichtentyp empfangen (Inhalt nicht angezeigt).");
  }
}
document.getElementById("start").onclick = () => {
  window.addEventListener("message", receive);
  popup = window.open(${JSON.stringify(auth.href)}, "_blank");
  if (!popup) {
    window.removeEventListener("message", receive);
    report("Pop-up blockiert. Im Browser erlauben und erneut versuchen."); return;
  }
  document.getElementById("start").disabled = true;
  document.getElementById("stop").disabled = false;
  report("Login geoeffnet. Warte auf offizielle Rueckgabe (maximal 15 Minuten).");
  timer = setInterval(() => {
    if (popup.closed) {
      if (!closedReported) report("Login-Fenster geschlossen ODER Browser-Verbindung durch COOP getrennt. Rueckgabe bisher nicht bestaetigt.");
      closedReported = true; return;
    }
    popup.postMessage({channel: "auth", message: "init"}, official);
  }, 500);
  expiry = setTimeout(stop, 15 * 60 * 1000);
};
document.getElementById("stop").onclick = stop;
window.addEventListener("pagehide", stop, {once: true});
</script></html>`;
}

function startProbe(host) {
  readerOrigin("http://" + host);
  const route = "/" + crypto.randomBytes(24).toString("hex");
  const server = http.createServer((request, response) => {
    const address = server.address();
    const allowed = [host, "127.0.0.1", "localhost"]
      .some(name => request.headers.host === name + ":" + address.port);
    const ok = allowed && request.method === "GET" && request.url === route;
    response.writeHead(ok ? 200 : 404, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
    });
    response.end(ok ? probeHTML() : "Not found");
  });
  server.requestTimeout = 10000;
  server.listen(0, host === "127.0.0.1" ? host : "0.0.0.0", () => {
    console.log("Phone login probe: http://" + host + ":" + server.address().port + route);
    console.log("No token receiver or storage. Server expires after 20 minutes.");
  });
  const expiry = setTimeout(() => server.close(), 20 * 60 * 1000);
  server.on("close", () => clearTimeout(expiry));
  return server;
}

if (require.main === module) {
  try {
    const server = startProbe(process.argv[2] || "127.0.0.1");
    server.on("error", error => { console.error(error.message); process.exitCode = 1; });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { probeHTML, startProbe };
