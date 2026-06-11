'use strict';

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const cron = require('node-cron');

const docker = require('./docker');

const router = express.Router();

const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const SCHEDULE_FILE = path.join(BACKUP_DIR, '.schedule.json');

// Quellen: "name:pfad,name:pfad" – Standard entspricht den empfohlenen Mounts
const DEFAULT_SOURCES = 'mail-data:/dms/mail-data,mail-state:/dms/mail-state,config:/dms/config,mail-logs:/dms/mail-logs';

function parseSources() {
  const raw = process.env.SOURCES || DEFAULT_SOURCES;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      const name = entry.slice(0, idx);
      const dir = entry.slice(idx + 1);
      return { name, path: dir, exists: fs.existsSync(dir) };
    });
}

async function dirSize(dir) {
  let total = 0;
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) total += await dirSize(full);
        else if (entry.isFile()) total += (await fsp.stat(full)).size;
      } catch { /* nicht lesbare Einträge überspringen */ }
    }
  } catch { /* ignore */ }
  return total;
}

// ---------------------------------------------------------------------------
// Jobs (Backup / Restore laufen asynchron, Frontend pollt den Status)
// ---------------------------------------------------------------------------

const jobs = new Map();
let busy = false;

function createJob(type) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, type, status: 'running', log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null };
  jobs.set(id, job);
  if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
  return job;
}

function jobLog(job, line) {
  job.log.push(`[${new Date().toLocaleTimeString('de-DE')}] ${line}`);
  console.log(`[${job.type}] ${line}`);
}

function finishJob(job, error) {
  job.status = error ? 'error' : 'done';
  job.error = error ? error.message : null;
  job.finishedAt = new Date().toISOString();
  if (error) jobLog(job, `FEHLER: ${error.message}`);
  busy = false;
}

function runTar(args, job) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar beendet mit Code ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Backup erstellen
// ---------------------------------------------------------------------------

async function doBackup(job, note) {
  const sources = parseSources().filter((s) => s.exists);
  if (sources.length === 0) throw new Error('Keine Backup-Quellen gefunden – sind die Volumes gemountet?');

  await fsp.mkdir(BACKUP_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const baseName = `dms-backup-${stamp}`;
  const archive = path.join(BACKUP_DIR, `${baseName}.tar.gz`);

  jobLog(job, `Sichere ${sources.length} Quellen: ${sources.map((s) => s.name).join(', ')}`);

  // Jede Quelle landet unter ihrem Namen als Top-Level-Verzeichnis im Archiv
  const args = ['czf', archive];
  for (const src of sources) {
    args.push('--transform', `s,^${path.basename(src.path)},${src.name},`, '-C', path.dirname(src.path), path.basename(src.path));
  }
  await runTar(args, job);

  const size = (await fsp.stat(archive)).size;
  const meta = {
    name: baseName,
    file: `${baseName}.tar.gz`,
    createdAt: new Date().toISOString(),
    note: note || '',
    size,
    sources: sources.map((s) => ({ name: s.name, path: s.path }))
  };
  await fsp.writeFile(path.join(BACKUP_DIR, `${baseName}.json`), JSON.stringify(meta, null, 2));

  jobLog(job, `Backup fertig: ${meta.file} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  await applyRetention(job);
  return meta;
}

async function applyRetention(job) {
  const schedule = await readSchedule();
  const keep = parseInt(schedule.retention || process.env.RETENTION || '0', 10);
  if (!keep || keep < 1) return;
  const backups = await listBackups();
  const excess = backups.slice(keep);
  for (const b of excess) {
    await deleteBackup(b.name);
    if (job) jobLog(job, `Aufbewahrung (${keep}): altes Backup ${b.name} gelöscht`);
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

async function doRestore(job, name, options) {
  const meta = await readMeta(name);
  if (!meta) throw new Error(`Backup ${name} nicht gefunden`);
  const archive = path.join(BACKUP_DIR, meta.file);
  if (!fs.existsSync(archive)) throw new Error(`Archivdatei ${meta.file} fehlt`);

  const currentSources = parseSources();
  const stopDms = options.stopContainer && docker.isAvailable();
  let restarted = false;

  if (stopDms) {
    jobLog(job, `Stoppe Container "${process.env.DMS_CONTAINER}" ...`);
    await docker.stop();
    jobLog(job, 'Container gestoppt');
  }

  try {
    for (const src of meta.sources) {
      const target = currentSources.find((s) => s.name === src.name);
      if (!target || !target.exists) {
        jobLog(job, `Überspringe "${src.name}" – Ziel nicht gemountet`);
        continue;
      }
      jobLog(job, `Stelle "${src.name}" nach ${target.path} wieder her ...`);
      // Inhalt des Archiv-Ordners <name>/ in das Zielverzeichnis entpacken
      await runTar(['xzf', archive, '-C', target.path, '--strip-components=1', '--overwrite', src.name], job);
    }
    jobLog(job, 'Wiederherstellung abgeschlossen');
  } finally {
    if (stopDms) {
      jobLog(job, 'Starte Container wieder ...');
      try {
        await docker.start();
        restarted = true;
        jobLog(job, 'Container gestartet');
      } catch (err) {
        jobLog(job, `Container-Start fehlgeschlagen: ${err.message}`);
      }
    }
  }
  return { restarted };
}

// ---------------------------------------------------------------------------
// Backup-Verwaltung
// ---------------------------------------------------------------------------

async function readMeta(name) {
  try {
    return JSON.parse(await fsp.readFile(path.join(BACKUP_DIR, `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function listBackups() {
  let files = [];
  try {
    files = await fsp.readdir(BACKUP_DIR);
  } catch {
    return [];
  }
  const result = [];
  for (const file of files.filter((f) => f.endsWith('.tar.gz'))) {
    const name = file.replace(/\.tar\.gz$/, '');
    const meta = await readMeta(name);
    const stat = await fsp.stat(path.join(BACKUP_DIR, file)).catch(() => null);
    if (!stat) continue;
    result.push(
      meta || { name, file, createdAt: stat.mtime.toISOString(), note: '', size: stat.size, sources: [] }
    );
  }
  result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return result;
}

async function deleteBackup(name) {
  if (!/^[\w.-]+$/.test(name)) throw new Error('Ungültiger Name');
  await fsp.rm(path.join(BACKUP_DIR, `${name}.tar.gz`), { force: true });
  await fsp.rm(path.join(BACKUP_DIR, `${name}.json`), { force: true });
}

// ---------------------------------------------------------------------------
// Zeitplan
// ---------------------------------------------------------------------------

let cronTask = null;

async function readSchedule() {
  try {
    return JSON.parse(await fsp.readFile(SCHEDULE_FILE, 'utf8'));
  } catch {
    return { enabled: false, cron: process.env.BACKUP_CRON || '0 3 * * *', retention: parseInt(process.env.RETENTION || '14', 10) };
  }
}

async function writeSchedule(schedule) {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  await fsp.writeFile(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
}

async function registerCron() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  const schedule = await readSchedule();
  if (!schedule.enabled || !cron.validate(schedule.cron)) return;
  cronTask = cron.schedule(schedule.cron, () => {
    if (busy) return console.warn('[cron] Backup übersprungen – bereits ein Job aktiv');
    busy = true;
    const job = createJob('backup');
    jobLog(job, 'Geplantes Backup gestartet');
    doBackup(job, 'Automatisches Backup')
      .then(() => finishJob(job))
      .catch((err) => finishJob(job, err));
  });
  console.log(`[cron] Automatische Backups aktiv: ${schedule.cron}`);
}

function initSchedule() {
  registerCron().catch((err) => console.error('[cron]', err.message));
}

// ---------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------

router.get('/overview', async (req, res) => {
  const sources = parseSources();
  for (const src of sources) {
    src.size = src.exists ? await dirSize(src.path) : 0;
  }
  const backups = await listBackups();
  res.json({
    sources,
    backups,
    schedule: await readSchedule(),
    container: await docker.inspect(),
    dockerControl: docker.isAvailable(),
    busy
  });
});

router.post('/create', (req, res) => {
  if (busy) return res.status(409).json({ error: 'Es läuft bereits ein Backup oder Restore' });
  busy = true;
  const job = createJob('backup');
  doBackup(job, (req.body || {}).note)
    .then(() => finishJob(job))
    .catch((err) => finishJob(job, err));
  res.json({ jobId: job.id });
});

router.post('/restore', (req, res) => {
  const { name, stopContainer } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Kein Backup angegeben' });
  if (busy) return res.status(409).json({ error: 'Es läuft bereits ein Backup oder Restore' });
  busy = true;
  const job = createJob('restore');
  doRestore(job, name, { stopContainer: Boolean(stopContainer) })
    .then(() => finishJob(job))
    .catch((err) => finishJob(job, err));
  res.json({ jobId: job.id });
});

router.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });
  res.json(job);
});

router.get('/download/:name', async (req, res) => {
  const meta = await readMeta(req.params.name);
  const file = meta ? meta.file : `${req.params.name}.tar.gz`;
  if (!/^[\w.-]+$/.test(req.params.name)) return res.status(400).json({ error: 'Ungültiger Name' });
  res.download(path.join(BACKUP_DIR, file));
});

router.delete('/:name', async (req, res) => {
  try {
    await deleteBackup(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Hochladen eines Backup-Archivs (roher Stream, Dateiname im Header)
router.post('/upload', (req, res) => {
  const rawName = decodeURIComponent(req.headers['x-filename'] || '');
  if (!/^[\w.-]+\.tar\.gz$/.test(rawName)) {
    return res.status(400).json({ error: 'Ungültiger Dateiname (erwartet *.tar.gz)' });
  }
  const target = path.join(BACKUP_DIR, rawName);
  const stream = fs.createWriteStream(target);
  req.pipe(stream);
  stream.on('finish', async () => {
    const name = rawName.replace(/\.tar\.gz$/, '');
    if (!(await readMeta(name))) {
      const stat = await fsp.stat(target);
      // Quellen unbekannt – Standardquellen annehmen, damit Restore möglich ist
      const meta = {
        name,
        file: rawName,
        createdAt: stat.mtime.toISOString(),
        note: 'Hochgeladenes Backup',
        size: stat.size,
        sources: parseSources().map((s) => ({ name: s.name, path: s.path }))
      };
      await fsp.writeFile(path.join(BACKUP_DIR, `${name}.json`), JSON.stringify(meta, null, 2));
    }
    res.json({ ok: true });
  });
  stream.on('error', (err) => res.status(500).json({ error: err.message }));
});

router.put('/schedule', async (req, res) => {
  const { enabled, cron: expr, retention } = req.body || {};
  if (enabled && !cron.validate(expr || '')) {
    return res.status(400).json({ error: 'Ungültiger Cron-Ausdruck' });
  }
  const schedule = { enabled: Boolean(enabled), cron: expr || '0 3 * * *', retention: parseInt(retention, 10) || 0 };
  await writeSchedule(schedule);
  await registerCron();
  res.json(schedule);
});

module.exports = { router, initSchedule };
