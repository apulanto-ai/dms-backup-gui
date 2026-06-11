/* Backup-Modul: Anmeldung, Übersicht, Backup/Restore-Jobs, Zeitplan */
(function () {
  'use strict';

  const { request, toast, formatBytes, formatDate, escapeHtml } = window.Api;

  const els = {};
  let overview = null;
  let pendingRestore = null;

  function $(id) { return document.getElementById(id); }

  async function checkAuth() {
    try {
      const status = await request('/api/auth/status');
      return status.authenticated;
    } catch {
      return false;
    }
  }

  function showLogin() {
    $('backup-login').classList.remove('hidden');
    $('backup-app').classList.add('hidden');
  }

  function showApp() {
    $('backup-login').classList.add('hidden');
    $('backup-app').classList.remove('hidden');
    refresh();
  }

  async function login(event) {
    event.preventDefault();
    const errorEl = $('backup-login-error');
    errorEl.classList.add('hidden');
    try {
      const result = await request('/api/auth/login', { method: 'POST', body: { password: $('admin-password').value } });
      sessionStorage.setItem('admin-token', result.token);
      $('admin-password').value = '';
      showApp();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  }

  // ------------------------------------------------------------- Übersicht

  async function refresh() {
    try {
      overview = await request('/api/backup/overview');
    } catch (err) {
      if (err.status === 401) return showLogin();
      return toast(`Fehler: ${err.message}`, 'error');
    }
    renderStats();
    renderSources();
    renderBackups();
    renderSchedule();
  }

  function renderStats() {
    const last = overview.backups[0];
    $('stat-last').textContent = last ? formatDate(last.createdAt) : 'Noch keins';
    $('stat-count').textContent = `${overview.backups.length} (${formatBytes(overview.backups.reduce((sum, b) => sum + b.size, 0))})`;
    $('stat-schedule').textContent = overview.schedule.enabled ? `Aktiv (${overview.schedule.cron})` : 'Deaktiviert';
    const c = overview.container;
    $('stat-container').textContent = !c ? 'Nicht verbunden'
      : c.error ? `Fehler: ${c.error}`
      : c.running ? `${c.name} läuft 🟢` : `${c.name} gestoppt 🔴`;
  }

  function renderSources() {
    const list = $('source-list');
    list.innerHTML = '';
    for (const src of overview.sources) {
      const item = document.createElement('div');
      item.className = 'source-item';
      item.innerHTML = `
        <span class="dot ${src.exists ? 'ok' : 'missing'}"></span>
        <div style="min-width:0">
          <div>${escapeHtml(src.name)}</div>
          <div class="s-path">${escapeHtml(src.path)}${src.exists ? '' : ' – nicht gemountet'}</div>
        </div>
        <span class="s-size">${src.exists ? formatBytes(src.size) : '–'}</span>`;
      list.appendChild(item);
    }
  }

  function renderBackups() {
    const list = $('backup-list');
    list.innerHTML = '';
    if (!overview.backups.length) {
      list.innerHTML = '<p class="muted empty">📭 Noch keine Backups vorhanden</p>';
      return;
    }
    for (const backup of overview.backups) {
      const item = document.createElement('div');
      item.className = 'backup-item';
      const sources = backup.sources.map((s) => s.name).join(', ');
      item.innerHTML = `
        <span class="b-icon">📦</span>
        <div class="b-info">
          <strong>${escapeHtml(backup.name)}</strong>
          <small>${formatDate(backup.createdAt)} · ${formatBytes(backup.size)}${sources ? ' · ' + escapeHtml(sources) : ''}${backup.note ? ' · ' + escapeHtml(backup.note) : ''}</small>
        </div>
        <div class="b-actions">
          <button class="icon-btn" title="Wiederherstellen" data-action="restore">♻️</button>
          <button class="icon-btn" title="Herunterladen" data-action="download">⬇️</button>
          <button class="icon-btn" title="Löschen" data-action="delete">🗑️</button>
        </div>`;
      item.querySelector('[data-action="restore"]').addEventListener('click', () => openRestore(backup));
      item.querySelector('[data-action="download"]').addEventListener('click', () => download(backup));
      item.querySelector('[data-action="delete"]').addEventListener('click', () => remove(backup));
      list.appendChild(item);
    }
  }

  function renderSchedule() {
    $('schedule-enabled').checked = overview.schedule.enabled;
    $('schedule-cron').value = overview.schedule.cron;
    $('schedule-retention').value = overview.schedule.retention || 0;
  }

  // ------------------------------------------------------------- Jobs

  async function pollJob(jobId, title) {
    const modal = $('job-modal');
    const log = $('job-log');
    const closeBtn = $('btn-job-close');
    $('job-title').textContent = title;
    $('job-spinner').classList.remove('hidden');
    closeBtn.classList.add('hidden');
    log.textContent = '';
    modal.classList.remove('hidden');

    return new Promise((resolve) => {
      const interval = setInterval(async () => {
        let job;
        try {
          job = await request(`/api/backup/jobs/${jobId}`);
        } catch {
          return;
        }
        log.textContent = job.log.join('\n');
        log.scrollTop = log.scrollHeight;
        if (job.status !== 'running') {
          clearInterval(interval);
          $('job-spinner').classList.add('hidden');
          closeBtn.classList.remove('hidden');
          $('job-title').textContent = job.status === 'done' ? '✅ Fertig' : '❌ Fehlgeschlagen';
          toast(job.status === 'done' ? `${title} abgeschlossen` : `Fehler: ${job.error}`, job.status === 'done' ? 'success' : 'error');
          refresh();
          resolve(job);
        }
      }, 800);
    });
  }

  async function backupNow() {
    try {
      const { jobId } = await request('/api/backup/create', { method: 'POST', body: { note: 'Manuelles Backup' } });
      pollJob(jobId, '⏳ Backup läuft …');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ------------------------------------------------------------- Restore

  function openRestore(backup) {
    pendingRestore = backup;
    $('restore-name').textContent = backup.name;
    $('restore-stop-row').classList.toggle('hidden', !overview.dockerControl);
    $('restore-modal').classList.remove('hidden');
  }

  async function confirmRestore() {
    const backup = pendingRestore;
    $('restore-modal').classList.add('hidden');
    if (!backup) return;
    try {
      const { jobId } = await request('/api/backup/restore', {
        method: 'POST',
        body: { name: backup.name, stopContainer: $('restore-stop').checked }
      });
      pollJob(jobId, '⏳ Wiederherstellung läuft …');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ------------------------------------------------------------- Aktionen

  async function download(backup) {
    const token = sessionStorage.getItem('admin-token');
    const res = await fetch(`/api/backup/download/${encodeURIComponent(backup.name)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return toast('Download fehlgeschlagen', 'error');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = backup.file;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function remove(backup) {
    if (!confirm(`Backup "${backup.name}" wirklich löschen?`)) return;
    try {
      await request(`/api/backup/${encodeURIComponent(backup.name)}`, { method: 'DELETE' });
      toast('Backup gelöscht', 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function upload(file) {
    if (!file) return;
    if (!file.name.endsWith('.tar.gz')) return toast('Bitte eine .tar.gz-Datei wählen', 'error');
    toast('Lade hoch …');
    try {
      await request('/api/backup/upload', {
        method: 'POST',
        body: file,
        headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' }
      });
      toast('Backup hochgeladen', 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function saveSchedule(event) {
    event.preventDefault();
    try {
      await request('/api/backup/schedule', {
        method: 'PUT',
        body: {
          enabled: $('schedule-enabled').checked,
          cron: $('schedule-cron').value.trim(),
          retention: parseInt($('schedule-retention').value, 10) || 0
        }
      });
      toast('Zeitplan gespeichert', 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ------------------------------------------------------------- Init

  async function init() {
    $('backup-login-form').addEventListener('submit', login);
    $('btn-backup-now').addEventListener('click', backupNow);
    $('schedule-form').addEventListener('submit', saveSchedule);
    $('btn-job-close').addEventListener('click', () => $('job-modal').classList.add('hidden'));
    $('btn-restore-close').addEventListener('click', () => $('restore-modal').classList.add('hidden'));
    $('btn-restore-cancel').addEventListener('click', () => $('restore-modal').classList.add('hidden'));
    $('btn-restore-confirm').addEventListener('click', confirmRestore);
    $('btn-upload').addEventListener('click', () => $('upload-file').click());
    $('upload-file').addEventListener('change', (e) => { upload(e.target.files[0]); e.target.value = ''; });

    if (await checkAuth()) showApp();
    else showLogin();
  }

  document.addEventListener('DOMContentLoaded', init);
  window.BackupView = { refresh };
})();
