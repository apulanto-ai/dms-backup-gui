'use strict';
/* Smoke-Test für die Settings-/Browse-API: startet den Server zweimal
   (Persistenz-Check) und prüft Auth, Validierung und Ordner-Browser. */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_ROOT = 'C:\\tmp\\dms-gui-test';
const ENV = {
  ...process.env,
  PORT: String(PORT),
  ADMIN_PASSWORD: 'test123',
  BACKUP_DIR: '/tmp/dms-gui-test/backups'
};

let server = null;
let failures = 0;
let token = '';

function check(desc, cond, extra) {
  if (cond) console.log(`  OK: ${desc}`);
  else { console.log(`  FEHLER: ${desc}${extra ? ` (${JSON.stringify(extra)})` : ''}`); failures++; }
}

async function api(method, url, body, auth = true) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth && token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* kein JSON */ }
  return { status: res.status, data };
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn('node', ['server/index.js'], { env: ENV, cwd: path.join(__dirname, '..') });
    server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    const deadline = Date.now() + 10_000;
    (function poll() {
      fetch(`${BASE}/api/health`).then(resolve).catch(() => {
        if (Date.now() > deadline) return reject(new Error('Server startet nicht'));
        setTimeout(poll, 200);
      });
    })();
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('close', resolve);
    server.kill();
  });
}

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'data1'), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'data2', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(TEST_ROOT, 'data1', 'a.txt'), 'hello');

  await startServer();
  console.log('=== Health & Auth ===');
  let r = await api('GET', '/api/health');
  check('Health ok, Version 1.1.0', r.data.ok === true && r.data.version === '1.1.0', r.data);
  r = await api('GET', '/api/backup/settings', null, false);
  check('Settings ohne Login -> 401', r.status === 401);
  r = await api('GET', '/api/backup/browse?path=/', null, false);
  check('Browse ohne Login -> 401', r.status === 401);
  r = await api('POST', '/api/auth/login', { password: 'falsch' });
  check('Login falsches Passwort -> 401', r.status === 401);
  r = await api('POST', '/api/auth/login', { password: 'test123' });
  check('Login ok', r.status === 200 && r.data.token);
  token = r.data.token;

  console.log('=== Settings: Defaults ===');
  r = await api('GET', '/api/backup/settings');
  check('custom=false, 4 Standardquellen', r.data.custom === false && r.data.sources.length === 4, r.data);
  check('backupDir gemeldet', r.data.backupDir === '/tmp/dms-gui-test/backups', r.data.backupDir);

  console.log('=== Settings: Validierung ===');
  const bad = [
    [{ name: 'böse name!', path: '/x' }, 'ungültiger Name'],
    [{ name: 'a', path: '/x' }, { name: 'a', path: '/y' }, 'doppelter Name'],
    [{ name: 'a', path: 'relativ/pfad' }, 'relativer Pfad'],
    [{ name: 'a', path: '/' }, 'Wurzel /'],
    [{ name: 'a', path: '/tmp/dms-gui-test/backups/x' }, 'Pfad im Backup-Ziel'],
    [{ name: 'a', path: '/x|y' }, 'Pipe im Pfad']
  ];
  for (const c of bad) {
    const label = c.pop();
    r = await api('PUT', '/api/backup/settings', { sources: c });
    check(`abgelehnt: ${label} -> 400`, r.status === 400 && r.data.error, r);
  }
  r = await api('PUT', '/api/backup/settings', { sources: [] });
  check('abgelehnt: leere Liste -> 400', r.status === 400);

  console.log('=== Settings: Speichern ===');
  r = await api('PUT', '/api/backup/settings', {
    sources: [
      { name: 'data-1', path: '/tmp/dms-gui-test/data1/' },
      { name: 'data-2', path: '/tmp/dms-gui-test/data2' }
    ]
  });
  check('Speichern ok, custom=true', r.status === 200 && r.data.custom === true, r);
  check('Trailing Slash normalisiert', r.data.sources[0].path === '/tmp/dms-gui-test/data1', r.data.sources);

  r = await api('GET', '/api/backup/overview');
  check('Overview nutzt neue Quellen', r.data.sources.length === 2 && r.data.sources[0].name === 'data-1', r.data.sources);
  check('Quellen existieren, Größe ermittelt', r.data.sources.every((s) => s.exists) && r.data.sources[0].size === 5, r.data.sources);

  console.log('=== Ordner-Browser ===');
  r = await api('GET', '/api/backup/browse?path=/tmp/dms-gui-test');
  check('listet Unterordner', JSON.stringify(r.data.dirs) === JSON.stringify(['backups', 'data1', 'data2']), r.data);
  check('parent korrekt', r.data.parent === '/tmp', r.data);
  r = await api('GET', '/api/backup/browse?path=/tmp/dms-gui-test/data2');
  check('Unterordner sub sichtbar', r.data.dirs.includes('sub'), r.data);
  r = await api('GET', '/api/backup/browse?path=/gibts/nicht/wirklich');
  check('unbekannter Pfad -> 400', r.status === 400);
  r = await api('GET', '/api/backup/browse?path=/tmp/dms-gui-test/../dms-gui-test');
  check('Pfad wird normalisiert', r.status === 200 && r.data.path === '/tmp/dms-gui-test', r.data);

  console.log('=== Persistenz über Neustart ===');
  await stopServer();
  await startServer();
  token = (await api('POST', '/api/auth/login', { password: 'test123' })).data.token;
  r = await api('GET', '/api/backup/settings');
  check('Quellen nach Neustart erhalten', r.data.custom === true && r.data.sources.length === 2, r.data);

  console.log('=== Reset auf Standard ===');
  r = await api('PUT', '/api/backup/settings', { reset: true });
  check('Reset ok, custom=false', r.status === 200 && r.data.custom === false && r.data.sources.length === 4, r.data);

  console.log('=== Statisches Frontend ===');
  const html = await (await fetch(`${BASE}/`)).text();
  for (const id of ['sources-modal', 'browse-modal', 'btn-sources-config', 'sources-editor', 'btn-browse-select']) {
    check(`index.html enthält #${id}`, html.includes(`id="${id}"`));
  }

  await stopServer();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  console.log(failures === 0 ? 'ALLE API-TESTS BESTANDEN' : `${failures} TESTS FEHLGESCHLAGEN`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); stopServer().then(() => process.exit(1)); });
