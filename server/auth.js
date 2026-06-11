'use strict';

const crypto = require('crypto');
const express = require('express');

const router = express.Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SESSION_TTL = 1000 * 60 * 60 * 12; // 12 Stunden

const sessions = new Map(); // token -> expiry

function cleanup() {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (expiry < now) sessions.delete(token);
  }
}
setInterval(cleanup, 60_000).unref();

function timingSafeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || !timingSafeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  res.json({ token });
});

router.post('/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  sessions.delete(token);
  res.json({ ok: true });
});

router.get('/status', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const valid = sessions.has(token) && sessions.get(token) > Date.now();
  res.json({ authenticated: valid, defaultPassword: !process.env.ADMIN_PASSWORD });
});

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (sessions.has(token) && sessions.get(token) > Date.now()) {
    sessions.set(token, Date.now() + SESSION_TTL); // verlängern
    return next();
  }
  res.status(401).json({ error: 'Nicht angemeldet' });
}

module.exports = { router, requireAdmin };
