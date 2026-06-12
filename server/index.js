'use strict';

const express = require('express');
const path = require('path');

const { router: authRouter, requireAdmin } = require('./auth');
const backup = require('./backup');
const mail = require('./mail');
const docker = require('./docker');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRouter);
app.use('/api/backup', requireAdmin, backup.router);
app.use('/api/mail', mail.router);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: require('../package.json').version });
});

app.get('/api/info', async (req, res) => {
  res.json({
    version: require('../package.json').version,
    webmail: mail.isConfigured(),
    dockerControl: docker.isAvailable(),
    dmsContainer: process.env.DMS_CONTAINER || null
  });
});

// Fallback für SPA
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

backup.initSchedule();

const PORT = parseInt(process.env.PORT || '80', 10);
app.listen(PORT, () => {
  console.log(`DMS Backup GUI läuft auf Port ${PORT}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('WARNUNG: ADMIN_PASSWORD ist nicht gesetzt – Standardpasswort "admin" aktiv!');
  }
});
