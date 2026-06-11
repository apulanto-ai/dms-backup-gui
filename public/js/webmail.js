/* Webmail-Modul: IMAP-Login, Ordner, Nachrichtenliste, Lesen, Verfassen */
(function () {
  'use strict';

  const { request, toast, formatBytes, formatDate, escapeHtml } = window.Api;

  function $(id) { return document.getElementById(id); }

  const state = {
    folder: 'INBOX',
    page: 1,
    pageSize: 40,
    total: 0,
    search: '',
    current: null,
    replyTo: null
  };

  // ------------------------------------------------------------- Login

  async function initLogin() {
    try {
      const config = await request('/api/mail/config');
      if (!config.configured) {
        $('mail-login-host').textContent = '⚠️ Webmail ist nicht konfiguriert (Umgebungsvariable IMAP_HOST fehlt).';
        $('mail-login-form').classList.add('hidden');
        return;
      }
      $('mail-login-host').textContent = `Server: ${config.host}`;
    } catch { /* ignore */ }

    if (sessionStorage.getItem('mail-token')) {
      try {
        await loadFolders();
        showApp();
        return;
      } catch {
        sessionStorage.removeItem('mail-token');
      }
    }
  }

  function showApp() {
    $('mail-login').classList.add('hidden');
    $('mail-app').classList.remove('hidden');
    $('mail-user-label').textContent = sessionStorage.getItem('mail-user') || '';
  }

  function showLogin() {
    $('mail-login').classList.remove('hidden');
    $('mail-app').classList.add('hidden');
  }

  async function login(event) {
    event.preventDefault();
    const errorEl = $('mail-login-error');
    errorEl.classList.add('hidden');
    try {
      const result = await request('/api/mail/login', {
        method: 'POST',
        body: { user: $('mail-user').value.trim(), pass: $('mail-pass').value }
      });
      sessionStorage.setItem('mail-token', result.token);
      sessionStorage.setItem('mail-user', result.user);
      $('mail-pass').value = '';
      showApp();
      await loadFolders();
      await loadMessages();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  }

  async function logout() {
    try { await request('/api/mail/logout', { method: 'POST' }); } catch { /* ignore */ }
    sessionStorage.removeItem('mail-token');
    sessionStorage.removeItem('mail-user');
    showLogin();
  }

  // ------------------------------------------------------------- Ordner

  const FOLDER_ICONS = {
    '\\Sent': '📤', '\\Drafts': '📝', '\\Junk': '🚫', '\\Trash': '🗑️', '\\Archive': '🗃️'
  };

  async function loadFolders() {
    const folders = await request('/api/mail/folders');
    const list = $('folder-list');
    list.innerHTML = '';
    for (const folder of folders) {
      const btn = document.createElement('button');
      btn.className = 'folder-item' + (folder.path === state.folder ? ' active' : '');
      const icon = folder.path.toUpperCase() === 'INBOX' ? '📥' : FOLDER_ICONS[folder.specialUse] || '📁';
      btn.innerHTML = `<span>${icon}</span><span class="f-name">${escapeHtml(folder.name)}</span>` +
        (folder.unseen ? `<span class="f-count">${folder.unseen}</span>` : '');
      btn.addEventListener('click', () => {
        state.folder = folder.path;
        state.page = 1;
        state.search = '';
        $('mail-search').value = '';
        document.querySelectorAll('.folder-item').forEach((f) => f.classList.remove('active'));
        btn.classList.add('active');
        closeMessage();
        loadMessages();
      });
      list.appendChild(btn);
    }
  }

  // ------------------------------------------------------------- Nachrichtenliste

  async function loadMessages() {
    const list = $('message-list');
    list.innerHTML = '<p class="muted empty">Lade Nachrichten …</p>';
    let result;
    try {
      const params = new URLSearchParams({ folder: state.folder, page: state.page, pageSize: state.pageSize });
      if (state.search) params.set('search', state.search);
      result = await request(`/api/mail/messages?${params}`);
    } catch (err) {
      if (err.status === 401) return showLogin();
      list.innerHTML = `<p class="error empty">${escapeHtml(err.message)}</p>`;
      return;
    }
    state.total = result.total;
    renderPager();
    list.innerHTML = '';
    if (!result.messages.length) {
      list.innerHTML = '<p class="muted empty">📭 Keine Nachrichten</p>';
      return;
    }
    for (const msg of result.messages) {
      const item = document.createElement('div');
      item.className = 'message-item' + (msg.seen ? '' : ' unseen');
      item.dataset.uid = msg.uid;
      const from = msg.from[0] || {};
      const fromLabel = from.name || from.address || 'Unbekannt';
      item.innerHTML = `
        <span class="m-dot"></span>
        <div class="m-body">
          <div class="m-top">
            <span class="m-from">${escapeHtml(fromLabel)}</span>
            <span class="m-date">${formatShortDate(msg.date)}</span>
          </div>
          <div class="m-subject">${msg.attachments ? '📎 ' : ''}${msg.flagged ? '⭐ ' : ''}${escapeHtml(msg.subject)}</div>
        </div>`;
      item.addEventListener('click', () => openMessage(msg, item));
      list.appendChild(item);
    }
  }

  function formatShortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  function renderPager() {
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    $('pager-info').textContent = `Seite ${state.page} / ${pages} · ${state.total} Nachrichten`;
    $('pager-prev').disabled = state.page <= 1;
    $('pager-next').disabled = state.page >= pages;
  }

  // ------------------------------------------------------------- Nachricht lesen

  async function openMessage(msg, item) {
    document.querySelectorAll('.message-item').forEach((m) => m.classList.remove('active'));
    item.classList.add('active');
    item.classList.remove('unseen');

    $('read-placeholder').classList.add('hidden');
    $('message-view').classList.remove('hidden');
    document.getElementById('read-pane').classList.add('mobile-open');
    $('msg-subject').textContent = 'Lade …';
    $('msg-from').textContent = '';
    $('msg-to').textContent = '';
    $('msg-date').textContent = '';
    $('msg-attachments').classList.add('hidden');

    let message;
    try {
      message = await request(`/api/mail/message?folder=${encodeURIComponent(state.folder)}&uid=${msg.uid}`);
    } catch (err) {
      $('msg-subject').textContent = `Fehler: ${err.message}`;
      return;
    }
    state.current = message;

    const from = message.from[0] || {};
    $('msg-subject').textContent = message.subject;
    $('msg-avatar').textContent = (from.name || from.address || '?').charAt(0).toUpperCase();
    $('msg-from').textContent = from.name ? `${from.name} <${from.address}>` : from.address || '';
    $('msg-to').textContent = 'An: ' + message.to.map((a) => a.address).join(', ');
    $('msg-date').textContent = formatDate(message.date);

    const attachBox = $('msg-attachments');
    attachBox.innerHTML = '';
    if (message.attachments.length) {
      attachBox.classList.remove('hidden');
      for (const att of message.attachments) {
        const chip = document.createElement('a');
        chip.className = 'attachment-chip';
        chip.innerHTML = `📎 ${escapeHtml(att.filename)} <span class="muted">(${formatBytes(att.size)})</span>`;
        chip.addEventListener('click', () => downloadAttachment(msg.uid, att));
        attachBox.appendChild(chip);
      }
    }

    const frame = $('msg-frame');
    if (message.html) {
      frame.classList.remove('text-only');
      frame.srcdoc = `<base target="_blank"><style>body{font-family:Segoe UI,system-ui,sans-serif;font-size:14px;margin:14px;word-break:break-word}</style>${message.html}`;
    } else {
      frame.classList.add('text-only');
      const dark = document.documentElement.dataset.theme === 'dark';
      frame.srcdoc = `<style>body{font-family:Segoe UI,system-ui,sans-serif;font-size:14px;margin:14px;white-space:pre-wrap;word-break:break-word;${dark ? 'background:transparent;color:#e8eaf2' : ''}}</style>${escapeHtml(message.text)}`;
    }
  }

  function closeMessage() {
    state.current = null;
    $('message-view').classList.add('hidden');
    $('read-placeholder').classList.remove('hidden');
    document.getElementById('read-pane').classList.remove('mobile-open');
  }

  async function downloadAttachment(uid, att) {
    try {
      const res = await fetch(`/api/mail/attachment?folder=${encodeURIComponent(state.folder)}&uid=${uid}&index=${att.index}`, {
        headers: { 'X-Mail-Token': sessionStorage.getItem('mail-token') }
      });
      if (!res.ok) throw new Error('Download fehlgeschlagen');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deleteCurrent() {
    if (!state.current) return;
    if (!confirm('Nachricht in den Papierkorb verschieben?')) return;
    try {
      await request('/api/mail/delete', { method: 'POST', body: { folder: state.folder, uid: state.current.uid } });
      toast('Nachricht gelöscht', 'success');
      closeMessage();
      loadMessages();
      loadFolders();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ------------------------------------------------------------- Verfassen

  function openCompose(mode) {
    const message = state.current;
    state.replyTo = null;
    $('compose-error').classList.add('hidden');
    $('compose-to').value = '';
    $('compose-cc').value = '';
    $('compose-subject').value = '';
    $('compose-text').value = '';
    $('compose-title').textContent = '✏️ Neue E-Mail';

    if (mode === 'reply' && message) {
      const from = message.from[0] || {};
      $('compose-to').value = from.address || '';
      $('compose-subject').value = message.subject.startsWith('Re:') ? message.subject : `Re: ${message.subject}`;
      $('compose-text').value = `\n\n--- Am ${formatDate(message.date)} schrieb ${from.address || '?'}: ---\n${quote(message.text)}`;
      $('compose-title').textContent = '↩️ Antworten';
      state.replyTo = message.uid;
    } else if (mode === 'forward' && message) {
      $('compose-subject').value = message.subject.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`;
      $('compose-text').value = `\n\n--- Weitergeleitete Nachricht ---\nVon: ${(message.from[0] || {}).address || '?'}\nDatum: ${formatDate(message.date)}\nBetreff: ${message.subject}\n\n${message.text}`;
      $('compose-title').textContent = '↪️ Weiterleiten';
    }
    $('compose-modal').classList.remove('hidden');
    $('compose-to').focus();
  }

  function quote(text) {
    return (text || '').split('\n').map((line) => `> ${line}`).join('\n');
  }

  async function send(event) {
    event.preventDefault();
    const errorEl = $('compose-error');
    errorEl.classList.add('hidden');
    const btn = event.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await request('/api/mail/send', {
        method: 'POST',
        body: {
          to: $('compose-to').value.trim(),
          cc: $('compose-cc').value.trim() || undefined,
          subject: $('compose-subject').value,
          text: $('compose-text').value
        }
      });
      $('compose-modal').classList.add('hidden');
      toast('E-Mail gesendet 📤', 'success');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------- Init

  let searchTimer = null;

  function init() {
    $('mail-login-form').addEventListener('submit', login);
    $('btn-mail-logout').addEventListener('click', logout);
    $('btn-mail-refresh').addEventListener('click', () => { loadMessages(); loadFolders(); });
    $('btn-compose').addEventListener('click', () => openCompose('new'));
    $('btn-reply').addEventListener('click', () => openCompose('reply'));
    $('btn-forward').addEventListener('click', () => openCompose('forward'));
    $('btn-delete-mail').addEventListener('click', deleteCurrent);
    $('btn-close-mail').addEventListener('click', closeMessage);
    $('btn-compose-close').addEventListener('click', () => $('compose-modal').classList.add('hidden'));
    $('btn-compose-cancel').addEventListener('click', () => $('compose-modal').classList.add('hidden'));
    $('compose-form').addEventListener('submit', send);
    $('pager-prev').addEventListener('click', () => { state.page--; loadMessages(); });
    $('pager-next').addEventListener('click', () => { state.page++; loadMessages(); });
    $('mail-search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = e.target.value.trim();
        state.page = 1;
        loadMessages();
      }, 450);
    });

    initLogin().then(() => {
      if (!$('mail-app').classList.contains('hidden')) loadMessages();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
