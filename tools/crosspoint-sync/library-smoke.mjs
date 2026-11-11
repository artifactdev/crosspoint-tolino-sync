import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

// Runs inside the built image, against its production backend, migrations and UI.
const require = createRequire('/app/sync/package.json');
const { serve } = require('@hono/node-server');
const { createApp } = await import('/app/sync/dist/app.js');
const { fromEnv } = await import('/app/sync/dist/config.js');
const { openDatabase, migrate } = await import('/app/sync/dist/db/db.js');
const { registerTolinoLibraries } = await import('/app/sync/dist/connectors/fanin.js');
const { syncTolinoLibrary } = await import('/app/sync/dist/connectors/tolino-library.js');

function archive(comment) {
  const files = {
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>',
    'EPUB/package.opf': '<package><manifest><item id="a" href="../Text/ch%201.xhtml"/></manifest><spine><itemref idref="a"/></spine></package>',
    'Text/ch 1.xhtml': '<html>\n<head/>\n<body>\n<p>Grüße😀<em>bold</em> end</p>\n</body>\n</html>',
  };
  const chunks = [], directory = [];
  let offset = 0;
  for (const [path, source] of Object.entries(files)) {
    const name = Buffer.from(path), data = Buffer.from(source), header = Buffer.alloc(30), central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    chunks.push(header, name, data); directory.push(central, name); offset += header.length + name.length + data.length;
  }
  const end = Buffer.alloc(22), note = Buffer.from(comment);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(3, 8); end.writeUInt16LE(3, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12); end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(note.length, 20);
  return Buffer.concat([...chunks, ...directory, end, note]);
}

const root = mkdtempSync(join(tmpdir(), 'tolino-library-smoke-'));
const db = openDatabase(join(root, 'sync.db'));
process.env.TOKEN_ENC_KEY = 'a'.repeat(64);
process.env.WEB_APP_DIR = '/app/sync/web';
const token = 'synthetic-library-api-key-0123456789';
let downloads = 0, writes = 0;
const helper = createServer((request, response) => {
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  if (request.method !== 'GET') writes++;
  const url = new URL(request.url, 'http://fixture');
  response.setHeader('content-type', 'application/json');
  if (url.pathname === '/api/sync-status') return response.end(JSON.stringify({ connected: true }));
  if (url.pathname === '/api/inventory') {
    return response.end(JSON.stringify({ PublicationInventory: { edata: [], ebook:
      ['reading', 'unread', 'protected'].map(id => ({ epubMetaData: {
        identifier: id, title: `Fixture ${id}`, author: [{ name: 'Synthetic author' }],
        deliverable: [{ contentFormat: 'application/epub+zip', contentEncrypted: id === 'protected' }],
      } })),
    } }));
  }
  if (url.pathname === '/api/download') {
    assert.notEqual(url.searchParams.get('id'), 'protected');
    downloads++;
    response.setHeader('content-type', 'application/epub+zip');
    return response.end(archive(url.searchParams.get('id')));
  }
  assert.equal(url.pathname, '/api/sync-position');
  response.end(JSON.stringify({ revision: 'r1', position: url.searchParams.get('id') === 'reading' ? {
    progress: 0.4281437, position: 'Text/ch%201.xhtml#point(/1/4/2/1:11)', modified: 100000,
  } : null }));
});
let server;
try {
  migrate(db);
  await new Promise(resolve => helper.listen(0, '127.0.0.1', resolve));
  process.env.TOLINO_HELPER_URL = `http://127.0.0.1:${helper.address().port}`;
  let app;
  server = serve({ fetch: (request, env) => app.fetch(request, env), port: 0, hostname: '127.0.0.1' });
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = createApp(db, fromEnv({ WEB_AUTH_USER: 'fixture-reader', WEB_AUTH_ORIGIN: origin }));
  const created = await fetch(origin + '/users/create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'fixture-reader', password: 'a'.repeat(32) }),
  });
  assert.equal(created.status, 201);
  const headers = { 'x-crosspoint-web': '1', origin, 'content-type': 'application/json' };
  const linked = await fetch(origin + '/api/v1/connectors/tolino', {
    method: 'PUT', headers, body: JSON.stringify({ credential: { token } }),
  });
  assert.equal(linked.status, 200);
  const { id } = db.prepare("SELECT id FROM users WHERE username='fixture-reader'").get();
  await syncTolinoLibrary(db, id);
  // The initial-link pull may still be completing after discovery.
  await registerTolinoLibraries(db);
  const list = await (await fetch(origin + '/api/v1/progress?include_history=1', { headers })).json();
  assert.equal(list.items.length, 2);
  assert.equal(list.items.find(book => book.title === 'Fixture reading').percentage, 0.4281437);
  assert.equal(list.items.find(book => book.title === 'Fixture unread').registered_only, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress').get().n, 1);
  assert.equal(downloads, 2, 'Each supported EPUB is downloaded once during registration and first pull');
  const reopened = openDatabase(join(root, 'sync.db'));
  try {
    await registerTolinoLibraries(reopened);
    assert.equal(downloads, 2, 'Stored identities survive reopening the database');
  } finally { reopened.close(); }
  assert.equal(writes, 0, 'Discovery and cloud pulls never write to the provider');
  const browser = spawn('python', ['-c', `
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
options=webdriver.ChromeOptions()
for arg in ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-proxy-server']:
 options.add_argument(arg)
options.binary_location='/usr/bin/chromium'
driver=webdriver.Chrome(service=Service('/usr/bin/chromedriver'),options=options)
try:
 driver.get('${origin}/app/')
 WebDriverWait(driver,30).until(lambda d: 'Fixture reading' in d.find_element(By.TAG_NAME,'body').text and 'Fixture unread' in d.find_element(By.TAG_NAME,'body').text)
 assert 'Available from Tolino (1)' in driver.find_element(By.TAG_NAME,'body').text
 assert 'No cloud reading position yet' in driver.find_element(By.TAG_NAME,'body').text
 driver.get('${origin}/app/#/settings')
 WebDriverWait(driver,30).until(lambda d: '2 books registered' in d.find_element(By.TAG_NAME,'body').text)
 assert '1 skipped' in driver.find_element(By.TAG_NAME,'body').text
 assert 'Fixture protected' in driver.find_element(By.TAG_NAME,'body').text
 driver.find_element(By.XPATH,"//button[contains(.,'Refresh and register library')]").click()
 WebDriverWait(driver,30).until(lambda d: 'Tolino library registered' in d.find_element(By.TAG_NAME,'body').text)
finally:
 driver.quit()
`], { stdio: 'inherit' });
  const timer = setTimeout(() => browser.kill('SIGTERM'), 60000);
  const code = await new Promise((resolve, reject) => {
    browser.once('exit', resolve); browser.once('error', reject);
  });
  clearTimeout(timer);
  assert.equal(code, 0, 'Production web app must show registered cloud and unread books');
  assert.equal(writes, 0, 'The browser library refresh never writes to the provider');
  assert.equal(downloads, 2, 'The browser library refresh reuses verified EPUB identities');
  console.log('PASS: automatic library discovery, persistent binary identities, exact cloud import, unread books, DRM notices and Chromium UI; no provider writes.');
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  helper.closeAllConnections();
  await new Promise(resolve => helper.close(resolve));
  db.close();
  rmSync(root, { recursive: true, force: true });
}
