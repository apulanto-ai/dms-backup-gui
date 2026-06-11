/* Theme-Verwaltung: Modus, Akzentfarbe, Design-Stil, Dichte (localStorage) */
(function () {
  'use strict';

  const DEFAULTS = { theme: 'auto', accent: '#6366f1', style: 'aurora', density: 'comfortable' };
  const STORAGE_KEY = 'dms-panel-theme';

  const ACCENTS = ['#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b', '#22c55e', '#14b8a6', '#0ea5e9'];

  function load() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
    } catch {
      return { ...DEFAULTS };
    }
  }

  let settings = load();

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function contrastColor(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return (r * 0.299 + g * 0.587 + b * 0.114) > 160 ? '#1a1d29' : '#ffffff';
  }

  function resolveTheme() {
    if (settings.theme !== 'auto') return settings.theme;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function apply() {
    const html = document.documentElement;
    html.dataset.theme = resolveTheme();
    html.dataset.style = settings.style;
    html.dataset.density = settings.density;
    html.style.setProperty('--accent', settings.accent);
    html.style.setProperty('--accent-contrast', contrastColor(settings.accent));
    updateUi();
  }

  function set(key, value) {
    settings[key] = value;
    save();
    apply();
  }

  function reset() {
    settings = { ...DEFAULTS };
    save();
    apply();
  }

  function updateUi() {
    document.querySelectorAll('#seg-theme button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings.theme));
    document.querySelectorAll('#seg-style button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings.style));
    document.querySelectorAll('#seg-density button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings.density));
    document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.color === settings.accent));
    const picker = document.getElementById('custom-accent');
    if (picker) picker.value = settings.accent;
  }

  function initPanel() {
    const swatches = document.getElementById('swatches');
    ACCENTS.forEach((color) => {
      const btn = document.createElement('button');
      btn.className = 'swatch';
      btn.style.background = color;
      btn.dataset.color = color;
      btn.title = color;
      btn.addEventListener('click', () => set('accent', color));
      swatches.appendChild(btn);
    });

    document.getElementById('custom-accent').addEventListener('input', (e) => set('accent', e.target.value));

    for (const [segId, key] of [['seg-theme', 'theme'], ['seg-style', 'style'], ['seg-density', 'density']]) {
      document.querySelectorAll(`#${segId} button`).forEach((btn) => {
        btn.addEventListener('click', () => set(key, btn.dataset.value));
      });
    }

    document.getElementById('btn-theme-reset').addEventListener('click', reset);

    const drawer = document.getElementById('settings-drawer');
    document.getElementById('btn-settings').addEventListener('click', () => drawer.classList.toggle('hidden'));
    document.getElementById('btn-settings-close').addEventListener('click', () => drawer.classList.add('hidden'));

    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', apply);
    updateUi();
  }

  apply();
  document.addEventListener('DOMContentLoaded', initPanel);

  window.Theme = { set, reset, get: () => ({ ...settings }) };
})();
