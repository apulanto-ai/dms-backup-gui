/* App-Shell: Tab-Navigation zwischen Backup und Webmail, Versionsanzeige */
(function () {
  'use strict';

  function init() {
    const tabs = document.querySelectorAll('.app-tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
        document.getElementById(`view-${tab.dataset.view}`).classList.add('active');
        localStorage.setItem('dms-panel-view', tab.dataset.view);
      });
    });

    const savedView = localStorage.getItem('dms-panel-view');
    if (savedView) {
      const tab = document.querySelector(`.app-tab[data-view="${savedView}"]`);
      if (tab) tab.click();
    }

    fetch('/api/info')
      .then((res) => res.json())
      .then((info) => {
        document.getElementById('brand-version').textContent = `v${info.version}`;
      })
      .catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', init);
})();
