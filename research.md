# Executive Summary
Die Tolino/Thalia-Cloud verfügt **nicht über öffentlich dokumentierte APIs** – sämtliche Schnittstellen sind über Reverse-Engineering bekannt. Tolino-Devices synchronisieren Bibliothek und Lesezustand über REST-Endpunkte bei `bosh.pageplace.de` (BookShelf; siehe auch offene Doku). Die Authentifizierung erfolgt per OAuth2 über den Tolino-Händler (z.B. Thalia, Hugendubel) – es wird ein Access-Token in den Header `t_auth_token` übergeben. Die Hauptfunktionen sind: Hochladen/Herunterladen von Büchern, Metadaten/Cover verwalten sowie Lesestand und Notizen synchronisieren. Lesepositionen (Fortschritt als Float 0–1, aktuelle/letzte Seite) sowie Lesezeichen (Dogears) werden als JSON-Patches über den Endpunkt `/sync-data` geschickt. EPUB-Downloads laufen über einen `downloadinfo`-Aufruf gefolgt vom Abruf einer konkreten Content-URL. DRM-geschützte Bücher (Adobe-ACSM) können nur mittels Adobe Digital Editions geladen werden; Social-DRM (Watermarks) wird unterstützt. Rate-Limits sind **nicht dokumentiert** (vermutlich moderat). CORS/CSRF sind für Calibre-Plugins irrelevant (direkte HTTPS-Anfragen). Wichtige Header sind neben `t_auth_token` die `hardware_id` (Geräte-Seriennummer) und `m_id`/`Reseller-Id`. Inoffizielle Clients (z.B. *tolino-calibre-sync*) demonstrieren viele Abläufe. Rechtlich liegen keine offiziellen APIs vor, die Nutzung ist technisch möglich, aber von Tolino vermutlich nicht ausdrücklich erlaubt.

Unter diesen Rahmenbedingungen ist eine bidirektionale Lese-Positionssynchronisation technisch realisierbar. Der Ablauf ist: (1) **Download**: Auslesen der Cloud-Bibliothek via `inventory` und Abrufen der Buchdatei; (2) **Upload der Fortschritte**: Senden von JSON-Patches mit neuer Position an `/sync-data`; (3) **Konflikt-Handling**: Serverseitiges Zusammenführen von Änderungen nach Revision. Im Folgenden wird eine Zusammenstellung gefundener Endpunkte dargestellt, anschließend ein Sequenzdiagramm für die Sync-Flows, ein Architektur-/Datenmodell-Vorschlag sowie eine priorisierte Implementierungs-Checkliste.

## Endpunkte und Fähigkeiten (Vergleichstabelle)
| Endpunkt (Pfad)                                  | HTTP | Beschreibung/Kapazität                                                  | Quelle                              |
|--------------------------------------------------|------|-------------------------------------------------------------------------|-------------------------------------|
| `/bosh/rest/v2/registerhw`                       | POST | Registrierung des Lesegeräts (Hardware-ID erzeugen)                      | GitHub             |
| `/bosh/rest/handshake/devices/list`              | GET  | Auflisten registrierter Geräte                                          | GitHub             |
| `/bosh/rest/handshake/devices/delete`            | POST | Gerät deregistrieren                                                    | GitHub             |
| `/bosh/rest/upload`                              | POST | Eigenes EPUB/PDF hochladen (multipart/form-data, `{file: ...}`)         | GitHub             |
| `/bosh/rest/cover`                               | POST | Cover-Bild zu einem Buch hochladen (`deliverableId` per Parameter)      | GitHub             |
| `/bosh/rest/meta/?deliverableId=...`             | GET/PUT | Metadaten (Titel, Autor, ISBN, etc.) abfragen bzw. ändern             | GitHub |
| `/bosh/rest/deletecontent`                       | POST | Buch aus Cloud löschen (`deliverableId`)                                 | GitHub find (`deletecontent`)         |
| `/bosh/rest/inventory/count`                     | GET  | (Optionale) Gesamtanzahl der Bücher in Cloud                             | Dokumentation          |
| `/bosh/rest/inventory/delta?strip=true`          | GET  | Liste aller Bücher („PublicationInventory“) mit Metadaten (inkl. `deliverableId`, `publicationId`) | GitHub |
| `/bosh/rest/cloud/downloadinfo/{pub}/{deliv}/type/external-download` | GET  | Download-Info abrufen: liefert JSON mit `contentUrl` (echter Datei-Link) | GitHub     |
| `/bosh/rest/content/...`                         | GET  | Direkter Abruf der eBook-Datei (EPUB) von der übergebenen URL            | Dokumentation (API calls) |
| `/bosh/rest/sync-data`                           | PATCH| Lesen/Setzen von Lesepositionen, Lesezeichen, Notizen; überträgt JSON-Patches mit Feldern (siehe unten) | Dokumentation |
| `/bosh/rest/ping`                                | GET  | Einfacher Verbindungs-Check                                            | Dokumentation          |
| `/bosh/rest/time`                                | GET  | Serverzeit (für Zeitstempel)                                            | Dokumentation          |
| `/bosh/rest/reseller/countries`                  | GET  | Liste verfügbarer Länder (Initialauswahl)                                | Dokumentation          |
| `/bosh/rest/reseller/selection`                  | GET  | Liste wählbarer Buchhändler (Reseller)                                  | Dokumentation          |
| `/bosh/rest/reseller/selection/report`           | POST | Meldung der Auswahl (Shop-Auswahl an Cloud)                              | Dokumentation          |
| `/bosh/rest/v2/resellerconfig`                   | GET  | (Geräte-spez. Konfiguration je Reseller)                                | Dokumentation          |
| **Family-Sharing** (optional)                    | –    | Endpunkte für Familien-Freigabe (z.B. `/family/v1/shares`)             | Dokumentation          |

*Quelle:* Eine vollständige Liste findet sich in der inoffiziellen Tolino-API-Dokumentation (cweiske) sowie im *tolino-calibre-sync* Repository. Beispielsweise unterstützt das Python-Clienttool u.a. `list ebooks/uploads`, `upload`, `download`, `delete`, Geräte-Listing, `cover`-Upload und Metadaten-Updates.

## Authentifizierung und Sitzungsmanagement
Die Cloud verlangt für **jeden** API-Aufruf neben den genannten Endpunkten folgende Header (Tolino-Bibliothek v1 bzw. v2):
- `t_auth_token: <OAuth-Access-Token>` – der bei Thalia/Hugendubel erhaltene JWT-Token.
- `hardware_id: <Geräte-ID>` – eindeutige Seriennummer des Geräts (z.B. Teil aus `getprop ro.serialno`).
- `m_id` bzw. `Reseller-Id: <Ziffer>` – ID des Buchhändlers (z.B. `3` für Thalia.de).
- `Content-Type: application/json; charset=UTF-8` + `Accept: application/json`.
- (Tolino v2: zusätzlich `hardware_type`, `os_version`, etc. in Header).

**Login-Prozess:** Üblicher Ablauf ist OAuth2: Die Tolino-App öffnet den Reseller-Login (Thalia.de), erhält einen Autorisierungs-Code und tauscht ihn an `POST https://{reseller}/oauth2/token` gegen Token (siehe `token_url` in [53]). Das Plugin müsste dies ähnlich umsetzen – evtl. in einer WebView oder über „Device-Flow“. Alternativ kann man sich das Gerät zuerst über `registerhw` (siehe nächste Zeile) registrieren und einen frisch gewonnenen *refresh_token* wiederverwenden (Workaround des vorhandenen Clients, s.u.).

**Geräteregistrierung:** Der Endpunkt `/bosh/rest/v2/registerhw` liefert eine neue `hardware_id`, wenn das Plugin sich als „Gerät“ registriert (siehe Anleitung des Python-Scripts). Dadurch simuliert man ein Tolino-Device. Diese ID bleibt konstant für die Session.

**Sitzungspflege:** Access-Token laufen nach wenigen Stunden ab. Es gibt ein Refresh-Token (z.B. im Python-Client von `token_url` zurückgeliefert), mit dem neue Token nachgeladen werden können. Das Plugin muss also Token sicher speichern und erneuern. Ein Logout (`revoke_url`) oder einfaches Verwerfen der Token beendet die Session.

## Lesepositionen, Lesezeichen und Notizen
Der zentrale Sync-Endpunkt ist `PATCH https://bosh.pageplace.de/bosh/rest/sync-data`. Er empfängt ein JSON-Objekt mit Struktur:
```
{
  "revision": "<letzte bekannte Revision oder null>",
  "patches": [
    {
      "op": "replace",            // oder "add"/"remove"
      "path": "/publications/{PublikationsID}/bookmark/{ID}",
      "value": {
         "progress": 0.4166667,   // Lese-Fortschritt (Float 0–1)
         "currentPosition": "5",  // aktuelle Seite (String)
         "lastPosition": "12",    // letzte Seitenzahl (String)
         "position": "<ChapURL#Anchor>",
         "modified": 1612116637854
      }
    }
    // … weitere Patches (Bookmarks, Tags, Kommentare) …
  ]
}
```
Dabei bezeichnet `publicationId` eine eindeutige Buch-ID (z.B. `DT0400.9783739673417_A27522964`). Der Patch-Pfad `/…/bookmark/{ID}` steht für den aktuellen Lesestand (bookmark = Leseposition). „Dogears“ (page bookmarks), „comments“ (Markierungen/Notizen) und „tags“ (Sammlungen) werden analog behandelt. Das Feld `value` enthält für `bookmark`-Patches u.a. den Fortschritt `progress` (Float 0–1) sowie Seitenzahlen. Beispiel aus der Doku (Lesepos setzen):

```json
PATCH /bosh/rest/sync-data
{
  "revision": "Lmu7TngaxhKWH…FUFM96DOLgZMd9NVnTByM/…",
  "patches": [{
    "op": "replace",
    "path": "/publications/DT0400.9783739673417_A27522964/bookmark/606779074",
    "value": {
      "lastPosition": "12",
      "progress": 0.41666666,
      "position": "OEBPS/…relikt_0.html#point(/1/2/1/8/1:0)",
      "currentPosition": "5",
      "modified": 1612116637854,
      "revision": "Lmu7TngaxhKWH…HHCrqwpA/7bO67OjTj…"
    }
  }]
}
```
Antwort (200 OK) enthält bei Erfolg eine **neue `revision`** und spiegelt ggfs. die eigenen Patches wider oder liefert fremde Änderungen seit der letzten Sync. Bei Konflikten (wenn Cloud-Stand neuer als lokal) führt der Server Merging durch bzw. sendet die fehlenden Patch-Objekte zurück. Insgesamt ist das Verfahren ähnlich zu *Calibre SyncPoint*: Es basiert auf einer revisionsbasierten Patch-Liste.

## Dateidownload und DRM
EPUB-Dateien werden in zwei Schritten bezogen: Zuerst holt man sich über
```
GET /bosh/rest/cloud/downloadinfo/{publicationId}/{deliverableId}/type/external-download
```
die Download-URL, dann lädt man diese URL (meist `/content/…`) herunter. Die Antwort enthält JSON mit `contentUrl` (dem eigentlichen Link) und Metadaten (Dateiname, Typ). DRM-geschützte Bücher (z.B. Adobe-DRM) werden von der Tolino-Cloud oft nur als ACSM ausgeliefert. Ein direkter EPUB-Download klappt dann **nicht** – solche Dateien müssen mit Adobe Digital Editions geöffnet werden (der Tolino-Reader macht das intern, außerhalb des Plugins aber kompliziert). Social-DRM (Wasserzeichen) wird ohne Umweg akzeptiert.

## CORS, CSRF, Header und Sitzungs-Lifecycle
Da das Plugin **direkt** HTTPS-Anfragen an die Tolino-Server macht (z.B. via Python `requests`), sind Browser-Themen wie CORS/CSRF hier nicht relevant. Wichtig sind nur die oben genannten Header (`t_auth_token`, `hardware_id`, `m_id`, Content-Type). Keines der REST-API-Aufrufe erfordert ein zusätzliches CSRF-Token (alles rein REST/JSON). Übertragung erfolgt stets über HTTPS (TLS), eine Zertifikatsprüfung (`verify=True`) ist empfehlenswert.

Das Sitzungstoken (`t_auth_token`) hat eine begrenzte Lebensdauer (z.B. 1–2 Stunden); das Plugin muss bei `401 Unauthorized` per Refresh-Token erneuern. Ein manueller Logout kann über den Endpunkt `revoke` des OAuth-Servers oder über `logout_url`/`logout` (nicht dokumentiert) erfolgen.

## Community-Implementierungen und Reverse-Engineering
Wichtige Quellen sind das GitHub-Projekt *tolino-calibre-sync* (Python) sowie Dokumentationen und Blogposts (z.B. cweiske.de). Sie zeigen, wie man die versteckten Endpunkte nutzt. Beispiele: Der Python-Client listet Geräte und Bücher, lädt Dateien hoch/runter und führt Sync-Requests durch. Auch Mobilforum-Einträge und Calibre-Plugins (z.B. Shelfmark-Tolino-Integration) bestätigen diese Abläufe. Von offizieller Seite gibt es keine offenen API-Dokumente (das vorhandene BOSH-Dokument auf bosh.pageplace.de ist passwortgeschützt).

## Rechtliche/ToS-Beschränkungen
Da es keine Public-API gibt, liegt der Gebrauch dieser Schnittstellen in einer Grauzone. Laut Tolino-Nutzungsbedingungen ist automatisierte Nutzung nicht vorgesehen – es könnte technisch *harte Praxis* oder AGB-Verstoß sein (hier fehlen offizielle Aussagen). Konkrete Rechtsquellen für API-Nutzung wurden nicht gefunden. Aufgrund vorhandener Tools ist davon auszugehen, dass zumindest *tolino-calibre-sync* solche Zugriffe verwendet, aber dies geschieht auf eigenes Risiko.

## Empfohlene Architektur und Datenmodell für das CrossPoint-Plugin
Wir empfehlen eine modulare Plugin-Architektur: Ein **Backend-Modul** kapselt die Tolino-Cloud-Kommunikation (HTTP-Client mit Token-Management), ein **Datenmodell** hält Buch-Infos und Lesezustände, und ein **UI/Workflow-Modul** verbindet Calibre/CrossPoint mit diesem Backend.

- **Datenmodell:**
  - *Book*: Identifiziert durch `publicationId` (und/oder `deliverableId`). Speichert Titel/Autor zur Zuordnung.
  - *ReadingState*: Pro Buch: Felder `progress` (Float), `currentPosition` (String), `lastPosition`, `revision` (letzte bekannte Server-Revision).
  - *UserSession*: `access_token`, `refresh_token`, `hardware_id`, `reseller_id`, ggf. Ablaufzeit.

- **Komponenten:**
  - *Authenticator*: Holt OAuth-Token via Reseller-API, implementiert Token-Erneuerung. Kann optional vorab Web-Login auslösen.
  - *TolinoAPI-Client*: Methoden `registerDevice()`, `listInventory()`, `getDownloadInfo(pubId, delivId)`, `downloadContent(url)`, `uploadProgress(patchList)`, etc. Siehe Tabelle oben. Diese Klasse fügt automatisch nötige Header hinzu.
  - *Sync-Manager*: Vergleicht lokalen und Cloud-Revision, erstellt Patch-Requests für geänderte Lesezustände (oder wendet empfangene Patches an).
  - *Conflict-Resolver*: Im Falle von Konflikten (wenn lokale Revision alt) kann der Cloud-Client über `/sync-data` die fehlenden Änderungen abholen und lokal mergen (z.B. „größter Fortschritt gewinnt“ oder nach Zeit).

![Sequenzdiagramm für Lese-Sync](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cD...) *Abbildung:* Kommunikationsfluss (Mermaid-Sequenzdiagramm) für Download (links) und Upload von Leseposition (rechts). Das Plugin fragt über `/inventory/delta` die Bibliothek ab, lädt das EPUB mit `/downloadinfo` herunter, und sendet bei Fortschrittsänderungen JSON-Patches an `/sync-data`. (Im Diagramm: **CP**=CrossPoint-Plugin, **CloudAPI**=Tolino-Server.)

```mermaid
sequenceDiagram
    participant CP as CrossPoint-Plugin
    participant API as "Tolino Cloud API"
    CP->>API: GET /bosh/rest/inventory/delta (t_auth_token, hardware_id, m_id)
    API-->>CP: 200 OK (JSON: PublicationInventory mit publicationId, deliverableId etc.)
    CP->>API: GET /bosh/rest/cloud/downloadinfo/{pubId}/{delivId}/type/external-download
    API-->>CP: 200 OK (JSON: { contentUrl: "...", format: "application/epub+zip" })
    CP->>API: GET <contentUrl> (EPUB herunterladen)
    API-->>CP: 200 OK (Dateistream)
    CP->>API: PATCH /bosh/rest/sync-data { "revision": "...", "patches": [ { "op":"replace", "path":"/publications/.../bookmark/...", "value":{...} } ] }
    API-->>CP: 200 OK (neue revision; ggf. zurückgemeldete Änderungen)
    Note right of API: Bei Konflikten oder neuen Änderungen seit Revision erfolgt Datenabgleich
```

## Priorisierte Implementierungs-Checkliste (Aufwand & Risiken)
1. **OAuth-Login/Tokenverwaltung** – Mittel: Integration des OAuth-2-Flows mit dem gewählten Reseller. Risiken: Bot-Schutz/2FA bei Buchhändler (Höheres Risiko).
2. **Geräteregistrierung** – Niedrig: Aufruf von `/registerhw`; speichert `hardware_id` für nachfolgende Calls. Geringes Risiko.
3. **Bibliothek auslesen** – Niedrig: GET `/inventory/delta?strip=true`. Auswerten der JSON-Antwort (Lies Buch-IDs, Titel, Liefer-IDs).
4. **Dateidownload** – Niedrig: Aufruf `/cloud/downloadinfo/…` und anschließender Download-URL. Dateischutz/Größe beachten. Risiko: ggf. fehlschlagende URLs (auch als ACSM) – Benutzerhinweis nötig.
5. **Lesefortschritt-Patch** – Mittel: Formatierung des JSON-Patchobjekts nach aktuellem Lesezeichen. Wichtig: Nutzung letzter bekannter `revision`. Risiko: Fehlerhafte JSON führen zu 4xx.
6. **Datenkonflikte lösen** – Hoch: Wenn lokaler Stand und Serverabweichen, muss Plugin Konflikte erkennen. Strategie: z.B. „größerer Fortschritt gewinnt“. Erfordert erneuten `/sync-data`-Aufruf, um Gegenseite zu aktualisieren. Komplexitäts-Risiko hoch.
7. **Notizen/Kommentare** – Mittel: Analog zu Bookmarks (`/comments`, `/dogears`). Aufwändig, aber ähnlich zu implementieren wie Fortschritt.
8. **API-Fehler-/Timeout-Handling** – Mittel: Robustheit (z.B. bei Netzwerk-Fehlern, Rate-Limits). Nutzer-Feedback bei Fehler (Auto-Reconnect, Retry).
9. **Benutzeroberfläche** – Gering/Mittel: Konfigurationsdialog für Login-Daten, Auswahlfunktion für Reseller-ID, Anzeige des Sync-Status. (Abhängig vom CrossPoint-UI-Framework.)
10. **Dokumentation & Tests** – Mittel: Ausgiebige Tests mit echten Tolino-Konten; Absichern gegen Änderungen an API.

**Aufwands-Tiers:** *Niedrig* (Einfache API-Calls, klar definierte JSON), *Mittel* (OAuth-Flow, Standard-Sync), *Hoch* (Konfliktbehandlung, Fehlerfälle, unbekannte DRM-Szenarien). Haupt-Risiken sind Änderungen seitens Tolino/Reseller, Captchas bei Login und ungeplante API-Änderungen.

**Zusammenfassung:** Alle wichtigen Endpunkte (Download, Upload, Metadaten, Sync) sind durch Reverse-Engineering bekannt. Ein CrossPoint-Plugin könnte auf dieser Basis implementiert werden: Es führt Login (OAuth), liest die Cloud-Bibliothek aus, lädt bei Bedarf EPUBs und sendet Lesepositions-Patches an `/sync-data`. Die Stichworte `t_auth_token`, `hardware_id`, JSON-`patches` und `revision` sind dabei Schlüsselindikatoren – im Netzwerk-Log erkennt man z.B. Aufrufe zu `bosh.pageplace.de/rest/*` mit JSON-Inhalten wie in den Beispielen. Durch diese Schritte kann bidirektionaler Lese-Positionsabgleich realisiert werden.

**Quellen:** Offizielle Dokumentation gibt es nicht, die obigen Informationen stammen aus Reverse-Engineering-Dokumentationen und Community-Projekten. Diese Quellen wurden für die Analyse verwendet und belegen die beschriebenen Endpunkte und Datenformate.