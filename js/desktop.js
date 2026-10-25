/* desktop.js — Desktop runtime integration for window chrome controls */
(function() {
  'use strict';

  function hasUnsavedChanges() {
    const S = window.RPE && window.RPE.store;
    if (!S) return false;
    const saveState = S.ui && S.ui.saveState;
    if (saveState === 'dirty' || saveState === 'failed') {
      return true;
    }
    if (saveState === 'new') {
      const isPristine = window.RPE && window.RPE.templates && window.RPE.templates.isPristineBlankDoc;
      if (isPristine && isPristine(S.doc)) {
        return false;
      }
      return true;
    }
    return false;
  }

  let closeDialogActive = false;
  let activeCloseDialog = null;

  function doCloseNow() {
    window.__isClosing = true;
    if (window.desktopAPI) {
      if (typeof window.desktopAPI.forceClose === 'function') {
        window.desktopAPI.forceClose();
      } else if (typeof window.desktopAPI.close === 'function') {
        window.desktopAPI.close(true);
      }
    }
  }

  async function performSaveAndClose(dlg) {
    const S = window.RPE && window.RPE.store;
    const U = window.RPE && window.RPE.ui;

    if (dlg && dlg.buttons) {
      if (dlg.buttons.save) {
        dlg.buttons.save.disabled = true;
        dlg.buttons.save.textContent = 'Saving…';
      }
      if (dlg.buttons.discard) dlg.buttons.discard.disabled = true;
      if (dlg.buttons.cancel) dlg.buttons.cancel.disabled = true;
    }

    try {
      let saved = false;
      if (S && S.saveLocal) {
        saved = await S.saveLocal();
      }
      if (saved) {
        if (window.RPE && window.RPE.backend && window.RPE.backend.request) {
          try {
            await window.RPE.backend.request('presentation.save', { doc: S.serialize() });
          } catch (_) {}
        }
        if (dlg) dlg.close('save');
        doCloseNow();
        return true;
      } else {
        // Save failed: abort close to prevent data loss
        if (dlg) dlg.close('save-failed');
        if (U && U.toast) {
          U.toast('Save failed. Application closing was cancelled to prevent data loss.', { kind: 'warn', duration: 8000 });
        }
        return false;
      }
    } catch (err) {
      if (dlg) dlg.close('save-failed');
      if (U && U.toast) {
        U.toast('Save failed: ' + (err.message || 'unknown error') + '. Application closing cancelled.', { kind: 'warn', duration: 8000 });
      }
      return false;
    }
  }

  function handleCloseRequest() {
    // Prevent duplicate dialogs
    if (closeDialogActive) {
      if (activeCloseDialog && activeCloseDialog.el) {
        const btn = activeCloseDialog.el.querySelector('.btn--primary') || activeCloseDialog.el;
        if (btn && btn.focus) btn.focus();
      }
      return;
    }

    // Clean closing
    if (!hasUnsavedChanges()) {
      doCloseNow();
      return;
    }

    const U = window.RPE && window.RPE.ui;
    if (!U || !U.dialog) {
      doCloseNow();
      return;
    }

    closeDialogActive = true;
    activeCloseDialog = U.dialog({
      title: 'You have unsaved changes',
      icon: 'triangle-alert',
      width: 480,
      dismiss: 'backdrop',
      body: U.h('p', { class: 'dlg__text' }, 'Your presentation has unsaved changes. If you close now, those changes will be lost.'),
      focus: '.btn--primary',
      buttons: [
        {
          label: 'Cancel',
          kind: 'ghost',
          id: 'cancel',
          value: 'cancel'
        },
        {
          label: 'Discard changes',
          kind: 'danger',
          id: 'discard',
          value: 'discard'
        },
        {
          label: 'Save',
          kind: 'primary',
          id: 'save',
          value: 'save',
          onClick: () => {
            performSaveAndClose(activeCloseDialog);
            return false;
          }
        }
      ],
      onClose: () => {
        closeDialogActive = false;
        activeCloseDialog = null;
      }
    });

    activeCloseDialog.done.then((action) => {
      closeDialogActive = false;
      activeCloseDialog = null;
      if (action === 'discard') {
        doCloseNow();
      }
    });
  }

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
        handleCloseRequest();
      });
    }

    if (typeof window.desktopAPI.onRequestClose === 'function') {
      window.desktopAPI.onRequestClose(() => {
        handleCloseRequest();
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

  window.RPE = window.RPE || {};
  window.RPE.desktopClose = {
    hasUnsavedChanges,
    handleCloseRequest,
    performSaveAndClose,
    doCloseNow,
    isCloseDialogOpen: () => closeDialogActive,
    getActiveCloseDialog: () => activeCloseDialog
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDesktop);
  } else {
    initDesktop();
  }
})();
