'use strict';

// Benutzerverwaltung für docker-mailserver: arbeitet direkt auf den
// DMS-Konfigurationsdateien (postfix-accounts.cf, postfix-virtual.cf,
// dovecot-quotas.cf). Der Change-Detector des DMS übernimmt Änderungen
// automatisch – ein Docker-Socket ist dafür nicht nötig.

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const settings = require('./settings');

const router = express.Router();

// unixcrypt ist ESM-only – einmal dynamisch laden und cachen
let unixcryptPromise = null;
function unixcrypt() {
  if (!unixcryptPromise) unixcryptPromise = import('unixcrypt');
  return unixcryptPromise;
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const QUOTA_RE = /^\d+[BKMGT]?$/i;

const files = () => {
  const { configDir, mailDataDir } = settings.getAdminPaths();
  return {
    configDir,
    mailDataDir,
    accounts: path.posix.join(configDir, 'postfix-accounts.cf'),
    aliases: path.posix.join(configDir, 'postfix-virtual.cf'),
    quotas: path.posix.join(configDir, 'dovecot-quotas.cf')
  };
};

// --------------------------------------------------------------- Datei-Helfer

async function readLines(file) {
  try {
    const content = await fsp.readFile(file, 'utf8');
    return content.split(/\r?\n/).filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

// Schreiben über Temp-Datei + Rename, damit der DMS-Change-Detector nie
// eine halb geschriebene Datei sieht.
async function writeLines(file, lines) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, lines.length ? `${lines.join('\n')}\n` : '');
  await fsp.rename(tmp, file);
}

function parseAccounts(lines) {
  return lines
    .filter((line) => !line.startsWith('#') && line.includes('|'))
    .map((line) => {
      const idx = line.indexOf('|');
      return { email: line.slice(0, idx).trim(), hash: line.slice(idx + 1) };
    });
}

function parseAliases(lines) {
  return lines
    .filter((line) => !line.startsWith('#'))
    .map((line) => {
      const match = line.match(/^(\S+)\s+(.+)$/);
      if (!match) return null;
      return { alias: match[1], targets: match[2].split(',').map((t) => t.trim()).filter(Boolean) };
    })
    .filter(Boolean);
}

function parseQuotas(lines) {
  const map = {};
  for (const line of lines) {
    const idx = line.lastIndexOf(':');
    if (idx > 0) map[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return map;
}

function maildirOf(email) {
  const [local, domain] = email.split('@');
  const { mailDataDir } = files();
  const dir = path.posix.join(mailDataDir, domain, local);
  // Sicherheitsnetz: Ziel muss exakt zwei Ebenen unter dem Mail-Verzeichnis
  // liegen ("." / ".." als Bestandteile würden beim join kollabieren)
  const expectedDepth = mailDataDir.split('/').length + 2;
  if (!dir.startsWith(`${mailDataDir}/`) || dir.split('/').length !== expectedDepth) return null;
  return dir;
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

function checkEmail(email) {
  if (typeof email !== 'string' || !EMAIL_RE.test(email) || /[|,\s]/.test(email)) {
    return 'Ungültige E-Mail-Adresse';
  }
  return null;
}

// ------------------------------------------------------------------- Übersicht

router.get('/overview', async (req, res) => {
  const f = files();
  const accounts = parseAccounts(await readLines(f.accounts));
  const aliases = parseAliases(await readLines(f.aliases));
  const quotas = parseQuotas(await readLines(f.quotas));
  const mailDataFound = fs.existsSync(f.mailDataDir);

  const result = [];
  for (const account of accounts) {
    const email = account.email.toLowerCase();
    const maildir = maildirOf(email);
    result.push({
      email: account.email,
      scheme: (account.hash.match(/^\{([^}]+)\}/) || [])[1] || 'unbekannt',
      quota: quotas[email] || null,
      size: mailDataFound && maildir && fs.existsSync(maildir) ? await dirSize(maildir) : null,
      aliases: aliases.filter((a) => a.targets.some((t) => t.toLowerCase() === email)).map((a) => a.alias)
    });
  }

  res.json({
    configDir: f.configDir,
    mailDataDir: f.mailDataDir,
    configFound: fs.existsSync(f.configDir),
    accountsFileFound: fs.existsSync(f.accounts),
    mailDataFound,
    accounts: result,
    aliases
  });
});

// ---------------------------------------------------------------------- Pfade

router.put('/paths', async (req, res) => {
  const { configDir, mailDataDir } = req.body || {};
  for (const dir of [configDir, mailDataDir]) {
    if (dir === undefined) continue;
    const error = settings.validateAdminPath(String(dir).trim());
    if (error) return res.status(400).json({ error });
  }
  res.json(await settings.saveAdminPaths({ configDir, mailDataDir }));
});

// --------------------------------------------------------------------- Konten

router.post('/accounts', async (req, res) => {
  const { email, password } = req.body || {};
  const emailError = checkEmail(email);
  if (emailError) return res.status(400).json({ error: emailError });
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
  }
  const f = files();
  if (!fs.existsSync(f.configDir)) {
    return res.status(400).json({ error: `Konfigurationsverzeichnis ${f.configDir} nicht gefunden` });
  }
  const lines = await readLines(f.accounts);
  if (parseAccounts(lines).some((a) => a.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: `Konto ${email} existiert bereits` });
  }
  const { encrypt } = await unixcrypt();
  lines.push(`${email.toLowerCase()}|{SHA512-CRYPT}${encrypt(password)}`);
  await writeLines(f.accounts, lines);
  res.json({ ok: true });
});

router.put('/accounts/:email', async (req, res) => {
  const email = String(req.params.email).toLowerCase();
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
  }
  const f = files();
  const lines = await readLines(f.accounts);
  const { encrypt } = await unixcrypt();
  let found = false;
  const updated = lines.map((line) => {
    const idx = line.indexOf('|');
    if (idx > 0 && line.slice(0, idx).trim().toLowerCase() === email) {
      found = true;
      return `${line.slice(0, idx)}|{SHA512-CRYPT}${encrypt(password)}`;
    }
    return line;
  });
  if (!found) return res.status(404).json({ error: `Konto ${email} nicht gefunden` });
  await writeLines(f.accounts, updated);
  res.json({ ok: true });
});

router.put('/accounts/:email/quota', async (req, res) => {
  const email = String(req.params.email).toLowerCase();
  const quota = String((req.body || {}).quota || '').trim().toUpperCase();
  if (quota && !QUOTA_RE.test(quota)) {
    return res.status(400).json({ error: 'Ungültige Quota – erwartet z. B. 500M, 2G oder leer für unbegrenzt' });
  }
  const f = files();
  const accounts = parseAccounts(await readLines(f.accounts));
  if (!accounts.some((a) => a.email.toLowerCase() === email)) {
    return res.status(404).json({ error: `Konto ${email} nicht gefunden` });
  }
  const lines = (await readLines(f.quotas)).filter((line) => {
    const idx = line.lastIndexOf(':');
    return idx <= 0 || line.slice(0, idx).trim().toLowerCase() !== email;
  });
  if (quota) lines.push(`${email}:${quota}`);
  await writeLines(f.quotas, lines);
  res.json({ ok: true });
});

router.delete('/accounts/:email', async (req, res) => {
  const email = String(req.params.email).toLowerCase();
  const deleteMaildir = req.query.deleteMaildir === '1';
  const f = files();
  const lines = await readLines(f.accounts);
  const remaining = lines.filter((line) => {
    const idx = line.indexOf('|');
    return idx <= 0 || line.slice(0, idx).trim().toLowerCase() !== email;
  });
  if (remaining.length === lines.length) {
    return res.status(404).json({ error: `Konto ${email} nicht gefunden` });
  }
  await writeLines(f.accounts, remaining);

  // Quota-Eintrag mit entfernen
  const quotaLines = (await readLines(f.quotas)).filter((line) => {
    const idx = line.lastIndexOf(':');
    return idx <= 0 || line.slice(0, idx).trim().toLowerCase() !== email;
  });
  await writeLines(f.quotas, quotaLines).catch(() => {});

  let maildirDeleted = false;
  if (deleteMaildir && !checkEmail(email)) {
    const maildir = maildirOf(email);
    if (maildir && fs.existsSync(maildir)) {
      await fsp.rm(maildir, { recursive: true, force: true });
      maildirDeleted = true;
    }
  }
  res.json({ ok: true, maildirDeleted });
});

// -------------------------------------------------------------------- Aliasse

router.post('/aliases', async (req, res) => {
  const alias = String((req.body || {}).alias || '').trim().toLowerCase();
  const target = String((req.body || {}).target || '').trim().toLowerCase();
  if (checkEmail(alias)) return res.status(400).json({ error: 'Ungültige Alias-Adresse' });
  if (checkEmail(target)) return res.status(400).json({ error: 'Ungültige Ziel-Adresse' });
  if (alias === target) return res.status(400).json({ error: 'Alias und Ziel sind identisch' });

  const f = files();
  if (!fs.existsSync(f.configDir)) {
    return res.status(400).json({ error: `Konfigurationsverzeichnis ${f.configDir} nicht gefunden` });
  }
  const lines = await readLines(f.aliases);
  const entries = parseAliases(lines);
  const existing = entries.find((e) => e.alias.toLowerCase() === alias);
  if (existing && existing.targets.some((t) => t.toLowerCase() === target)) {
    return res.status(409).json({ error: `Alias ${alias} → ${target} existiert bereits` });
  }
  let replaced = false;
  const updated = lines.map((line) => {
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (match && match[1].toLowerCase() === alias) {
      replaced = true;
      return `${match[1]} ${match[2]},${target}`;
    }
    return line;
  });
  if (!replaced) updated.push(`${alias} ${target}`);
  await writeLines(f.aliases, updated);
  res.json({ ok: true });
});

router.delete('/aliases/:alias', async (req, res) => {
  const alias = String(req.params.alias).toLowerCase();
  const target = String(req.query.target || '').toLowerCase();
  const f = files();
  const lines = await readLines(f.aliases);
  let changed = false;
  const updated = [];
  for (const line of lines) {
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match || match[1].toLowerCase() !== alias) {
      updated.push(line);
      continue;
    }
    changed = true;
    if (target) {
      const targets = match[2].split(',').map((t) => t.trim()).filter((t) => t && t.toLowerCase() !== target);
      if (targets.length) updated.push(`${match[1]} ${targets.join(',')}`);
    }
    // ohne ?target= wird der komplette Alias entfernt
  }
  if (!changed) return res.status(404).json({ error: `Alias ${alias} nicht gefunden` });
  await writeLines(f.aliases, updated);
  res.json({ ok: true });
});

module.exports = { router };
