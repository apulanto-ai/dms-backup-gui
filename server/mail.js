'use strict';

const express = require('express');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const sanitizeHtml = require('sanitize-html');

const router = express.Router();

const IMAP_HOST = process.env.IMAP_HOST || '';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);
const IMAP_SECURE = (process.env.IMAP_SECURE || 'true') !== 'false';
const SMTP_HOST = process.env.SMTP_HOST || IMAP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_SECURE = (process.env.SMTP_SECURE || 'true') !== 'false';
const TLS_REJECT = (process.env.TLS_REJECT_UNAUTHORIZED || 'true') !== 'false';

const SESSION_TTL = 1000 * 60 * 60 * 8;
const sessions = new Map(); // token -> { user, pass, expires }

setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) if (s.expires < now) sessions.delete(token);
}, 60_000).unref();

function isConfigured() {
  return Boolean(IMAP_HOST);
}

function imapClient(creds) {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: IMAP_SECURE,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    tls: { rejectUnauthorized: TLS_REJECT }
  });
}

async function withImap(creds, fn) {
  const client = imapClient(creds);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

function requireMail(req, res, next) {
  const token = (req.headers['x-mail-token'] || '').toString();
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) {
    return res.status(401).json({ error: 'Nicht angemeldet' });
  }
  session.expires = Date.now() + SESSION_TTL;
  req.mailSession = session;
  next();
}

function addressList(addr) {
  if (!addr || !addr.value) return [];
  return addr.value.map((a) => ({ name: a.name || '', address: a.address || '' }));
}

function envelopeAddress(list) {
  if (!list || !list.length) return [];
  return list.map((a) => ({ name: a.name || '', address: a.address || '' }));
}

// ---------------------------------------------------------------------------

router.get('/config', (req, res) => {
  res.json({ configured: isConfigured(), host: IMAP_HOST });
});

router.post('/login', async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Webmail nicht konfiguriert (IMAP_HOST fehlt)' });
  const { user, pass } = req.body || {};
  if (!user || !pass) return res.status(400).json({ error: 'Benutzer und Passwort erforderlich' });
  try {
    await withImap({ user, pass }, async () => {});
  } catch (err) {
    return res.status(401).json({ error: 'Anmeldung fehlgeschlagen: ' + err.message });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, pass, expires: Date.now() + SESSION_TTL });
  res.json({ token, user });
});

router.post('/logout', requireMail, (req, res) => {
  sessions.delete((req.headers['x-mail-token'] || '').toString());
  res.json({ ok: true });
});

router.get('/folders', requireMail, async (req, res, next) => {
  try {
    const folders = await withImap(req.mailSession, async (client) => {
      const list = await client.list({ statusQuery: { messages: true, unseen: true } });
      return list
        .filter((f) => !f.flags || !f.flags.has('\\Noselect'))
        .map((f) => ({
          path: f.path,
          name: f.name,
          delimiter: f.delimiter,
          specialUse: f.specialUse || null,
          messages: f.status ? f.status.messages : 0,
          unseen: f.status ? f.status.unseen : 0
        }));
    });
    // Sinnvolle Reihenfolge: Inbox, Sent, Drafts, Junk, Trash, Rest alphabetisch
    const order = { '\\Inbox': 0, '\\Sent': 1, '\\Drafts': 2, '\\Junk': 3, '\\Trash': 4, '\\Archive': 5 };
    folders.sort((a, b) => {
      const oa = a.path.toUpperCase() === 'INBOX' ? -1 : order[a.specialUse] ?? 9;
      const ob = b.path.toUpperCase() === 'INBOX' ? -1 : order[b.specialUse] ?? 9;
      return oa - ob || a.path.localeCompare(b.path);
    });
    res.json(folders);
  } catch (err) {
    next(err);
  }
});

router.get('/messages', requireMail, async (req, res, next) => {
  const folder = req.query.folder || 'INBOX';
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(100, parseInt(req.query.pageSize || '40', 10));
  const search = (req.query.search || '').toString().trim();
  try {
    const result = await withImap(req.mailSession, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const total = client.mailbox.exists;
        let uids;
        if (search) {
          uids = await client.search({ or: [{ subject: search }, { from: search }, { to: search }] }, { uid: true });
          uids = (uids || []).sort((a, b) => b - a);
        } else {
          if (total === 0) return { total: 0, page, pageSize, messages: [] };
          // Neueste zuerst über Sequenznummern
          const end = total - (page - 1) * pageSize;
          const start = Math.max(1, end - pageSize + 1);
          if (end < 1) return { total, page, pageSize, messages: [] };
          const messages = [];
          for await (const msg of client.fetch(`${start}:${end}`, { uid: true, envelope: true, flags: true, size: true, bodyStructure: true })) {
            messages.push(msg);
          }
          messages.sort((a, b) => b.uid - a.uid);
          return { total, page, pageSize, messages: messages.map(mapListItem) };
        }
        // Suchergebnis paginieren
        const slice = uids.slice((page - 1) * pageSize, page * pageSize);
        const messages = [];
        if (slice.length) {
          for await (const msg of client.fetch(slice, { uid: true, envelope: true, flags: true, size: true, bodyStructure: true }, { uid: true })) {
            messages.push(msg);
          }
        }
        messages.sort((a, b) => b.uid - a.uid);
        return { total: uids.length, page, pageSize, messages: messages.map(mapListItem) };
      } finally {
        lock.release();
      }
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

function hasAttachments(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  if (node.childNodes) return node.childNodes.some(hasAttachments);
  return false;
}

function mapListItem(msg) {
  const env = msg.envelope || {};
  return {
    uid: msg.uid,
    subject: env.subject || '(kein Betreff)',
    from: envelopeAddress(env.from),
    to: envelopeAddress(env.to),
    date: env.date || null,
    size: msg.size || 0,
    seen: msg.flags ? msg.flags.has('\\Seen') : false,
    flagged: msg.flags ? msg.flags.has('\\Flagged') : false,
    answered: msg.flags ? msg.flags.has('\\Answered') : false,
    attachments: hasAttachments(msg.bodyStructure)
  };
}

router.get('/message', requireMail, async (req, res, next) => {
  const folder = req.query.folder || 'INBOX';
  const uid = parseInt(req.query.uid, 10);
  if (!uid) return res.status(400).json({ error: 'uid fehlt' });
  try {
    const message = await withImap(req.mailSession, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const { content } = await client.download(String(uid), null, { uid: true });
        const chunks = [];
        for await (const chunk of content) chunks.push(chunk);
        const parsed = await simpleParser(Buffer.concat(chunks));
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        const html = parsed.html
          ? sanitizeHtml(parsed.html, {
              allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'style', 'center', 'font']),
              allowedAttributes: { '*': ['style', 'align', 'width', 'height', 'cellpadding', 'cellspacing', 'border', 'bgcolor', 'color'], a: ['href', 'target'], img: ['src', 'alt', 'width', 'height'] },
              allowedSchemes: ['http', 'https', 'data', 'cid', 'mailto'],
              transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) }
            })
          : null;
        return {
          uid,
          subject: parsed.subject || '(kein Betreff)',
          from: addressList(parsed.from),
          to: addressList(parsed.to),
          cc: addressList(parsed.cc),
          date: parsed.date || null,
          html,
          text: parsed.text || '',
          attachments: (parsed.attachments || []).map((a, i) => ({
            index: i,
            filename: a.filename || `anhang-${i}`,
            contentType: a.contentType,
            size: a.size
          }))
        };
      } finally {
        lock.release();
      }
    });
    res.json(message);
  } catch (err) {
    next(err);
  }
});

router.get('/attachment', requireMail, async (req, res, next) => {
  const folder = req.query.folder || 'INBOX';
  const uid = parseInt(req.query.uid, 10);
  const index = parseInt(req.query.index, 10);
  if (!uid || Number.isNaN(index)) return res.status(400).json({ error: 'uid/index fehlt' });
  try {
    await withImap(req.mailSession, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const { content } = await client.download(String(uid), null, { uid: true });
        const chunks = [];
        for await (const chunk of content) chunks.push(chunk);
        const parsed = await simpleParser(Buffer.concat(chunks));
        const att = (parsed.attachments || [])[index];
        if (!att) throw new Error('Anhang nicht gefunden');
        res.setHeader('Content-Type', att.contentType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(att.filename || 'anhang')}"`);
        res.send(att.content);
      } finally {
        lock.release();
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/send', requireMail, async (req, res, next) => {
  const { to, cc, bcc, subject, text, inReplyTo } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Empfänger fehlt' });
  try {
    const transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: req.mailSession.user, pass: req.mailSession.pass },
      tls: { rejectUnauthorized: TLS_REJECT }
    });
    const message = {
      from: req.mailSession.user,
      to,
      cc: cc || undefined,
      bcc: bcc || undefined,
      subject: subject || '',
      text: text || '',
      inReplyTo: inReplyTo || undefined,
      references: inReplyTo || undefined
    };
    const info = await transport.sendMail(message);

    // In "Gesendet" ablegen
    try {
      const MailComposer = require('nodemailer/lib/mail-composer');
      const raw = await new MailComposer(message).compile().build();
      await withImap(req.mailSession, async (client) => {
        const list = await client.list();
        const sent = list.find((f) => f.specialUse === '\\Sent') || list.find((f) => /^sent/i.test(f.name));
        if (sent) await client.append(sent.path, raw, ['\\Seen']);
      });
    } catch (err) {
      console.warn('[mail] Konnte Mail nicht in Gesendet ablegen:', err.message);
    }

    res.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    next(err);
  }
});

router.post('/flag', requireMail, async (req, res, next) => {
  const { folder, uid, flag, value } = req.body || {};
  const flags = { seen: '\\Seen', flagged: '\\Flagged' };
  if (!uid || !flags[flag]) return res.status(400).json({ error: 'Ungültige Anfrage' });
  try {
    await withImap(req.mailSession, async (client) => {
      const lock = await client.getMailboxLock(folder || 'INBOX');
      try {
        if (value) await client.messageFlagsAdd(String(uid), [flags[flag]], { uid: true });
        else await client.messageFlagsRemove(String(uid), [flags[flag]], { uid: true });
      } finally {
        lock.release();
      }
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/delete', requireMail, async (req, res, next) => {
  const { folder, uid } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid fehlt' });
  try {
    await withImap(req.mailSession, async (client) => {
      const list = await client.list();
      const trash = list.find((f) => f.specialUse === '\\Trash') || list.find((f) => /trash|papierkorb|deleted/i.test(f.name));
      const lock = await client.getMailboxLock(folder || 'INBOX');
      try {
        if (trash && trash.path !== folder) {
          await client.messageMove(String(uid), trash.path, { uid: true });
        } else {
          await client.messageDelete(String(uid), { uid: true });
        }
      } finally {
        lock.release();
      }
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/move', requireMail, async (req, res, next) => {
  const { folder, uid, target } = req.body || {};
  if (!uid || !target) return res.status(400).json({ error: 'uid/target fehlt' });
  try {
    await withImap(req.mailSession, async (client) => {
      const lock = await client.getMailboxLock(folder || 'INBOX');
      try {
        await client.messageMove(String(uid), target, { uid: true });
      } finally {
        lock.release();
      }
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, isConfigured };
