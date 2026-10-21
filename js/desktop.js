/* desktop.js — Desktop runtime integration for window chrome controls */
(function() {
  function initDesktop() {
    if (!window.desktopAPI) {
      return;
    }
    document.body.classList.add('is-desktop-app');
    const winControls = document.getElementById('winControls');
    const winMin = document.getElementById('winMin');
    const winMax = document.getElementById('winMax');
    const winClose = document.getElementById('winClose');

    if (winControls) {
      winControls.hidden = false;
    }

    if (winMin) {
      winMin.addEventListener('click', (e) => {
        e.preventDefault();
        if (window.desktopAPI && window.desktopAPI.minimize) {
          window.desktopAPI.minimize();
        }
      });
    }

    function updateMaximizeState(isMax) {
      if (!winMax) return;
      if (isMax) {
        winMax.title = 'Restore';
        winMax.setAttribute('aria-label', 'Restore');
        winMax.innerHTML = '<i data-lucide="copy" class="ic"></i>';
      } else {
        winMax.title = 'Maximize';
        winMax.setAttribute('aria-label', 'Maximize');
        winMax.innerHTML = '<i data-lucide="square" class="ic"></i>';
      }
      if (window.RPE && window.RPE.icons && window.RPE.icons.render) {
        window.RPE.icons.render(winMax);
      }
    }

    if (winMax) {
      winMax.addEventListener('click', (e) => {
        e.preventDefault();
        if (window.desktopAPI && window.desktopAPI.maximize) {
          window.desktopAPI.maximize();
        }
      });
    }

    if (winClose) {
      winClose.addEventListener('click', (e) => {
        e.preventDefault();
        if (window.desktopAPI && window.desktopAPI.close) {
          window.desktopAPI.close();
        }
      });
    }

    if (typeof window.desktopAPI.onMaximizeChange === 'function') {
      window.desktopAPI.onMaximizeChange((isMax) => {
        updateMaximizeState(isMax);
      });
    }

    if (typeof window.desktopAPI.isMaximized === 'function') {
      Promise.resolve(window.desktopAPI.isMaximized())
        .then((isMax) => updateMaximizeState(isMax))
        .catch(() => {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDesktop);
  } else {
    initDesktop();
  }
})();
