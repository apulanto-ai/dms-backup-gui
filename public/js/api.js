/* Gemeinsame API-Helfer und Toasts */
(function () {
  'use strict';

  async function request(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData) && typeof options.body !== 'string' && !(options.body instanceof Blob) && !(options.body instanceof File)) {
      headers['Content-Type'] = 'application/json';
      options = { ...options, body: JSON.stringify(options.body) };
    }
    const adminToken = sessionStorage.getItem('admin-token');
    if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
    const mailToken = sessionStorage.getItem('mail-token');
    if (mailToken) headers['X-Mail-Token'] = mailToken;

    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try { message = (await res.json()).error || message; } catch { /* ignore */ }
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    const type = res.headers.get('content-type') || '';
    return type.includes('application/json') ? res.json() : res;
  }

  function toast(message, kind = 'info', duration = 4500) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 0.3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 320);
    }, duration);
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDate(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  window.Api = { request, toast, formatBytes, formatDate, escapeHtml };
})();
