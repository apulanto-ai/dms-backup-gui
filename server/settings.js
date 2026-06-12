'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const SETTINGS_FILE = path.join(BACKUP_DIR, '.settings.json');

// Eingebaute Standardquellen – per ENV SOURCES überschreibbar ("name:pfad,name:pfad").
// In der GUI gespeicherte Quellen haben Vorrang.
const DEFAULT_SOURCES = 'mail-data:/dms/mail-data,mail-state:/dms/mail-state,config:/dms/config,mail-logs:/dms/mail-logs';

function defaultSources() {
  return (process.env.SOURCES || DEFAULT_SOURCES)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      return { name: entry.slice(0, idx), path: entry.slice(idx + 1) };
    });
}

let cache;

function readSettings() {
  if (cache === undefined) {
    try {
      cache = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
      cache = {};
    }
  }
  return cache;
}

function getSources() {
  const settings = readSettings();
  return Array.isArray(settings.sources) && settings.sources.length ? settings.sources : defaultSources();
}

function isCustom() {
  const settings = readSettings();
  return Array.isArray(settings.sources) && settings.sources.length > 0;
}

// Liefert eine Fehlermeldung oder null, wenn alles in Ordnung ist.
function validateSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return 'Mindestens eine Quelle angeben';
  const names = new Set();
  for (const src of sources) {
    const name = String((src || {}).name || '').trim();
    const dir = String((src || {}).path || '').trim();
    if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) {
      return `Ungültiger Name "${name}" – erlaubt sind Buchstaben, Zahlen, Punkt, Unterstrich und Bindestrich`;
    }
    if (names.has(name)) return `Doppelter Name "${name}"`;
    names.add(name);
    if (!dir.startsWith('/') || dir === '/') return `Ungültiger Pfad "${dir}" – absoluter Pfad unterhalb von / erforderlich`;
    if (/[|\\\n\r]/.test(dir)) return `Ungültiger Pfad "${dir}" – |, \\ und Zeilenumbrüche sind nicht erlaubt`;
    const normalized = path.posix.normalize(dir).replace(/\/+$/, '');
    if (normalized === BACKUP_DIR || normalized.startsWith(`${BACKUP_DIR}/`)) {
      return `"${dir}" liegt im Backup-Ziel ${BACKUP_DIR} und kann nicht gesichert werden`;
    }
  }
  return null;
}

async function persist() {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(cache, null, 2));
}

async function saveSources(sources) {
  const cleaned = sources.map((src) => ({
    name: String(src.name).trim(),
    path: path.posix.normalize(String(src.path).trim()).replace(/\/+$/, '')
  }));
  cache = { ...readSettings(), sources: cleaned };
  await persist();
  return cleaned;
}

// Entfernt die gespeicherten Quellen, sodass wieder ENV/Standard greift.
async function resetSources() {
  cache = { ...readSettings() };
  delete cache.sources;
  await persist();
}

// ---------------------------------------------------------------------------
// DMS-Pfade für die Benutzerverwaltung (Admin-Panel)
// ---------------------------------------------------------------------------

// Reihenfolge: GUI-Einstellung > ENV > gleichnamige Backup-Quelle > Standard
function getAdminPaths() {
  const settings = readSettings();
  const bySource = (name, fallback) => {
    const src = getSources().find((s) => s.name === name);
    return src ? src.path : fallback;
  };
  return {
    configDir: settings.configDir || process.env.DMS_CONFIG_DIR || bySource('config', '/dms/config'),
    mailDataDir: settings.mailDataDir || process.env.DMS_MAIL_DIR || bySource('mail-data', '/dms/mail-data')
  };
}

function validateAdminPath(dir) {
  if (dir === '') return null; // leer = zurück auf Automatik
  if (typeof dir !== 'string' || !dir.startsWith('/') || dir === '/') {
    return `Ungültiger Pfad "${dir}" – absoluter Pfad unterhalb von / erforderlich`;
  }
  if (/[|\\\n\r]/.test(dir)) return `Ungültiger Pfad "${dir}" – |, \\ und Zeilenumbrüche sind nicht erlaubt`;
  return null;
}

async function saveAdminPaths({ configDir, mailDataDir }) {
  cache = { ...readSettings() };
  for (const [key, value] of [['configDir', configDir], ['mailDataDir', mailDataDir]]) {
    if (value === undefined) continue;
    const normalized = String(value).trim();
    if (normalized === '') delete cache[key];
    else cache[key] = path.posix.normalize(normalized).replace(/\/+$/, '');
  }
  await persist();
  return getAdminPaths();
}

module.exports = {
  BACKUP_DIR,
  defaultSources, getSources, isCustom, validateSources, saveSources, resetSources,
  getAdminPaths, validateAdminPath, saveAdminPaths
};
