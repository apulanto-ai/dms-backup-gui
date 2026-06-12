/* Verwaltungs-Modul: E-Mail-Konten, Aliasse, Quotas und DMS-Pfade */
(function () {
  'use strict';

  const { request, toast, formatBytes, escapeHtml } = window.Api;

  let overview = null;
  let pendingDelete = null;
  let quotaEmail = null;
  let passwordEmail = null; // null = neues Konto, sonst Passwort ändern

  function $(id) { return document.getElementById(id); }

  async function checkAuth() {
    try {
      return (await request('/api/auth/status')).authenticated;
    } catch {
      return false;
    }
  }

  function showLogin() {
    $('admin-login').classList.remove('hidden');
    $('admin-app').classList.add('hidden');
  }

  function showApp() {
    $('admin-login').classList.add('hidden');
    $('admin-app').classList.remove('hidden');
    refresh();
  }

  async function login(event) {
    event.preventDefault();
    const errorEl = $('admin-login-error');
    errorEl.classList.add('hidden');
    try {
      const result = await request('/api/auth/login', { method: 'POST', body: { password: $('admin-login-password').value } });
      sessionStorage.setItem('admin-token', result.token);
      $('admin-login-password').value = '';
      showApp();
      if (window.BackupView) window.BackupView.authChanged();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  }

  // ------------------------------------------------------------- Übersicht

  async function refresh() {
    try {
      overview = await request('/api/admin/overview');
    } catch (err) {
      if (err.status === 401) return showLogin();
      return toast(`Fehler: ${err.message}`, 'error');
    }
    renderStats();
    renderAccounts();
    renderAliases();
    renderPaths();
  }

  function renderStats() {
    $('adm-stat-accounts').textContent = overview.accounts.length;
    $('adm-stat-aliases').textContent = overview.aliases.length;
    const total = overview.accounts.reduce((sum, a) => sum + (a.size || 0), 0);
    $('adm-stat-size').textContent = overview.mailDataFound ? formatBytes(total) : 'nicht gefunden';
    $('adm-stat-config').textContent = overview.configFound
      ? (overview.accountsFileFound ? 'Gefunden 🟢' : 'Noch keine Konten-Datei')
      : 'Nicht gefunden 🔴';
  }

  function renderAccounts() {
    const list = $('account-list');
    list.innerHTML = '';
    if (!overview.configFound) {
      list.innerHTML = `<p class="muted empty">📂 Konfigurationsverzeichnis <strong>${escapeHtml(overview.configDir)}</strong> nicht gefunden –<br/>Pfad rechts unter „DMS-Pfade“ anpassen.</p>`;
      return;
    }
    if (!overview.accounts.length) {
      list.innerHTML = '<p class="muted empty">👤 Noch keine E-Mail-Konten – lege das erste an!</p>';
      return;
    }
    for (const account of overview.accounts) {
      const item = document.createElement('div');
      item.className = 'backup-item';
      const details = [
        account.size !== null ? formatBytes(account.size) : null,
        account.quota ? `Quota ${account.quota}` : null,
        account.aliases.length ? `Aliasse: ${account.aliases.join(', ')}` : null
      ].filter(Boolean).join(' · ');
      item.innerHTML = `
        <span class="b-icon">📧</span>
        <div class="b-info">
          <strong>${escapeHtml(account.email)}</strong>
          <small>${escapeHtml(details || '–')}</small>
        </div>
        <div class="b-actions">
          <button class="icon-btn" title="Passwort ändern" data-action="password">🔑</button>
          <button class="icon-btn" title="Quota festlegen" data-action="quota">📐</button>
          <button class="icon-btn" title="Konto löschen" data-action="delete">🗑️</button>
        </div>`;
      item.querySelector('[data-action="password"]').addEventListener('click', () => openPasswordModal(account));
      item.querySelector('[data-action="quota"]').addEventListener('click', () => openQuotaModal(account));
      item.querySelector('[data-action="delete"]').addEventListener('click', () => openDeleteModal(account));
      list.appendChild(item);
    }
  }

  function renderAliases() {
    const list = $('alias-list');
    list.innerHTML = '';
    if (!overview.aliases.length) {
      list.innerHTML = '<p class="muted empty small">Keine Aliasse definiert</p>';
      return;
    }
    for (const entry of overview.aliases) {
      for (const target of entry.targets) {
        const row = document.createElement('div');
        row.className = 'alias-item';
        row.innerHTML = `
          <span class="alias-text"><strong>${escapeHtml(entry.alias)}</strong> → ${escapeHtml(target)}</span>
          <button class="icon-btn" title="Alias-Ziel entfernen">✕</button>`;
        row.querySelector('button').addEventListener('click', () => removeAlias(entry.alias, target));
        list.appendChild(row);
      }
    }
  }

  function renderPaths() {
    $('admin-config-dir').value = overview.configDir;
    $('admin-maildata-dir').value = overview.mailDataDir;
  }

  // ------------------------------------------------------- Konto anlegen / Passwort

  function generatePassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!#%+-';
    const rand = new Uint32Array(16);
    crypto.getRandomValues(rand);
    return Array.from(rand, (v) => chars[v % chars.length]).join('');
  }

  function openAccountModal() {
    passwordEmail = null;
    $('account-modal-title').textContent = '➕ Neues E-Mail-Konto';
    $('account-email-label').classList.remove('hidden');
    $('account-email').value = '';
    $('account-email').required = true;
    $('account-password').value = generatePassword();
    $('account-error').classList.add('hidden');
    $('account-modal').classList.remove('hidden');
  }

  function openPasswordModal(account) {
    passwordEmail = account.email;
    $('account-modal-title').textContent = `🔑 Passwort für ${account.email}`;
    $('account-email-label').classList.add('hidden');
    $('account-email').required = false;
    $('account-password').value = generatePassword();
    $('account-error').classList.add('hidden');
    $('account-modal').classList.remove('hidden');
  }

  async function submitAccount(event) {
    event.preventDefault();
    const errorEl = $('account-error');
    errorEl.classList.add('hidden');
    const password = $('account-password').value;
    try {
      if (passwordEmail) {
        await request(`/api/admin/accounts/${encodeURIComponent(passwordEmail)}`, { method: 'PUT', body: { password } });
        toast(`Passwort für ${passwordEmail} geändert`, 'success');
      } else {
        const email = $('account-email').value.trim();
        await request('/api/admin/accounts', { method: 'POST', body: { email, password } });
        toast(`Konto ${email} angelegt`, 'success');
      }
      $('account-modal').classList.add('hidden');
      refresh();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  }

  // ------------------------------------------------------------------ Quota

  function openQuotaModal(account) {
    quotaEmail = account.email;
    $('quota-email').textContent = account.email;
    $('quota-value').value = account.quota || '';
    $('quota-error').classList.add('hidden');
    $('quota-modal').classList.remove('hidden');
  }

  async function submitQuota(event) {
    event.preventDefault();
    const errorEl = $('quota-error');
    errorEl.classList.add('hidden');
    try {
      await request(`/api/admin/accounts/${encodeURIComponent(quotaEmail)}/quota`, {
        method: 'PUT',
        body: { quota: $('quota-value').value.trim() }
      });
      $('quota-modal').classList.add('hidden');
      toast('Quota gespeichert', 'success');
      refresh();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  }

  // ----------------------------------------------------------------- Löschen

  function openDeleteModal(account) {
    pendingDelete = account;
    $('accdel-email').textContent = account.email;
    $('accdel-maildir').checked = false;
    $('account-delete-modal').classList.remove('hidden');
  }

  async function confirmDelete() {
    const account = pendingDelete;
    $('account-delete-modal').classList.add('hidden');
    if (!account) return;
    try {
      const withMaildir = $('accdel-maildir').checked ? '?deleteMaildir=1' : '';
      const result = await request(`/api/admin/accounts/${encodeURIComponent(account.email)}${withMaildir}`, { method: 'DELETE' });
      toast(`Konto ${account.email} gelöscht${result.maildirDeleted ? ' (inkl. Mail-Daten)' : ''}`, 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ----------------------------------------------------------------- Aliasse

  async function addAlias(event) {
    event.preventDefault();
    try {
      await request('/api/admin/aliases', {
        method: 'POST',
        body: { alias: $('alias-alias').value.trim(), target: $('alias-target').value.trim() }
      });
      $('alias-alias').value = '';
      $('alias-target').value = '';
      toast('Alias angelegt', 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function removeAlias(alias, target) {
    try {
      await request(`/api/admin/aliases/${encodeURIComponent(alias)}?target=${encodeURIComponent(target)}`, { method: 'DELETE' });
      toast('Alias entfernt', 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ------------------------------------------------------------------- Pfade

  async function savePaths(event) {
    event.preventDefault();
    try {
      await request('/api/admin/paths', {
        method: 'PUT',
        body: {
          configDir: $('admin-config-dir').value.trim(),
          mailDataDir: $('admin-maildata-dir').value.trim()
        }
      });
      toast('Pfade gespeichert', 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // -------------------------------------------------------------------- Init

  async function init() {
    $('admin-login-form').addEventListener('submit', login);
    $('btn-account-add').addEventListener('click', openAccountModal);
    $('account-form').addEventListener('submit', submitAccount);
    $('btn-account-close').addEventListener('click', () => $('account-modal').classList.add('hidden'));
    $('btn-account-cancel').addEventListener('click', () => $('account-modal').classList.add('hidden'));
    $('btn-account-genpw').addEventListener('click', () => { $('account-password').value = generatePassword(); });
    $('quota-form').addEventListener('submit', submitQuota);
    $('btn-quota-close').addEventListener('click', () => $('quota-modal').classList.add('hidden'));
    $('btn-quota-cancel').addEventListener('click', () => $('quota-modal').classList.add('hidden'));
    $('btn-accdel-close').addEventListener('click', () => $('account-delete-modal').classList.add('hidden'));
    $('btn-accdel-cancel').addEventListener('click', () => $('account-delete-modal').classList.add('hidden'));
    $('btn-accdel-confirm').addEventListener('click', confirmDelete);
    $('alias-form').addEventListener('submit', addAlias);
    $('admin-paths-form').addEventListener('submit', savePaths);
    $('btn-browse-config').addEventListener('click', () =>
      window.BackupView.openBrowse($('admin-config-dir').value, (picked) => { $('admin-config-dir').value = picked; }));
    $('btn-browse-maildata').addEventListener('click', () =>
      window.BackupView.openBrowse($('admin-maildata-dir').value, (picked) => { $('admin-maildata-dir').value = picked; }));

    if (await checkAuth()) showApp();
    else showLogin();
  }

  async function authChanged() {
    if (await checkAuth()) showApp();
    else showLogin();
  }

  document.addEventListener('DOMContentLoaded', init);
  window.AdminView = { refresh, authChanged };
})();
