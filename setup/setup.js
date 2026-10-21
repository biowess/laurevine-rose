/* setup.js — Laurevine Rose setup wizard: window chrome, step router, Welcome + License + Components steps.
   When opened in repair mode (query param ?repair=repair from main.js), only the Components step is shown
   and all IPC calls go through window.repairAPI instead of window.setupAPI. */
(function (RPE) {
  'use strict';

  // Detect repair mode: main.js passes ?repair=repair in the loadFile query.
  const IS_REPAIR = (function () {
    try { return new URLSearchParams(window.location.search).get('repair') === 'repair'; } catch (_) { return false; }
  })();

  // In repair mode use repairAPI; fall back to setupAPI for the initial wizard.
  const activeAPI = IS_REPAIR ? (window.repairAPI || {}) : (window.setupAPI || {});

  // Ordered step ids. Each id needs a <section class="step" data-step="id"> in setup.html.
  // In repair mode only 'components' is shown (license skipped if current, no ready step needed).
  const STEPS = IS_REPAIR ? ['components'] : ['welcome', 'license', 'components', 'ready'];

  const stepsEl = document.getElementById('setupSteps');
  const backBtn = document.getElementById('setupBack');
  const nextBtn = document.getElementById('setupNext');
  const declineBtn = document.getElementById('setupDecline');
  const agree = document.getElementById('licenseAgree');
  const licenseEl = document.getElementById('licenseText');
  const msgEl = document.getElementById('licenseMsg');
  let index = -1;
  let accepted = false;   // license (current version) already stored
  let busy = false;
  let checking = false;      // Components check running
  let componentsOk = false;  // all required components passed
  let readyValidating = false; // Ready step validation running
  let readyValidationOk = false; // All ready checks passed

  function setMsg(text, isError) {
    msgEl.textContent = text || '';
    msgEl.hidden = !text;
    msgEl.classList.toggle('is-error', !!isError);
  }

  // Continue is enabled everywhere except: while saving, on license until checked, on components until passed, on ready until validated.
  function syncNext() {
    const id = available()[index];
    if (id === 'ready') {
      nextBtn.textContent = 'Launch Laurevine Rose';
      nextBtn.disabled = busy || readyValidating || !readyValidationOk;
    } else {
      nextBtn.textContent = 'Continue';
      nextBtn.disabled = busy || (id === 'license' && !(agree.checked && !agree.disabled)) || (id === 'components' && (checking || !componentsOk));
    }
  }

  function available() {
    return STEPS.filter((id) => stepsEl.querySelector('[data-step="' + id + '"]'));
  }

  function go(id, opts) {
    const order = available();
    const i = order.indexOf(id);
    if (i < 0) return false;
    index = i;
    order.forEach((sid) => {
      stepsEl.querySelector('[data-step="' + sid + '"]').hidden = sid !== id;
    });
    backBtn.disabled = i === 0;
    declineBtn.hidden = id !== 'license';
    syncNext();
    if (id === 'components') runComponentsCheck();
    if (id === 'ready') runReadyValidation();
    // Focus management: move focus to the step heading so screen readers announce the new step.
    const section = stepsEl.querySelector('[data-step="' + id + '"]');
    const heading = section.querySelector('[tabindex="-1"]') || section;
    if (!opts || opts.focus !== false) heading.focus({ preventScroll: true });
    return true;
  }

  async function next() {
    const order = available();
    if (busy) return;
    if (order[index] === 'license' && !accepted) {
      if (!agree.checked) return;
      busy = true; syncNext(); setMsg('');
      let res = null;
      try { res = await window.setupAPI.acceptLicense(); } catch (e) { res = null; }
      busy = false;
      if (!res || !res.ok) {
        setMsg((res && res.error) || 'Setup could not record your acceptance. Please try again.', true);
        syncNext();
        return;
      }
      accepted = true;
    }
    if (order[index] === 'ready' && readyValidationOk) {
      busy = true; syncNext();
      try {
        if (window.setupAPI && window.setupAPI.complete) await window.setupAPI.complete();
      } catch (e) {}
      busy = false;
      return;
    }
    if (index < order.length - 1) go(order[index + 1]);
    else if (order[index] === 'license') { setMsg('License accepted.'); syncNext(); }
  }

  function back() {
    const order = available();
    if (index > 0) go(order[index - 1]);
  }

  function initChrome() {
    const api = activeAPI;
    const min = document.getElementById('setupMin');
    const close = document.getElementById('setupClose');
    min.addEventListener('click', (e) => { e.preventDefault(); if (api) api.minimize(); });
    close.addEventListener('click', (e) => { e.preventDefault(); if (api) api.close(); });
    // In repair mode Escape closes the wizard cleanly.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (IS_REPAIR) { e.preventDefault(); if (api && api.close) api.close(); }
        else e.preventDefault();
      }
    }, true);
    // No zoom / drag-drop navigation inside the wizard.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
  }

  function initWelcome() {
    const api = activeAPI;
    if (!api || typeof api.getInfo !== 'function') return;
    Promise.resolve(api.getInfo()).then((info) => {
      if (!info) return;
      const v = document.getElementById('welcomeVersion');
      if (v && info.version) v.textContent = info.version;
    }).catch(() => {});
  }

  function initLicense() {
    const api = activeAPI;
    agree.checked = false;
    agree.addEventListener('change', syncNext);
    declineBtn.addEventListener('click', () => { if (api && api.decline) api.decline(); });
    licenseEl.textContent = 'Loading\u2026';
    const fail = (msg) => { licenseEl.textContent = 'The license text could not be loaded.'; setMsg(msg, true); };
    if (!api || typeof api.getLicense !== 'function') { fail('The license text could not be loaded.'); return Promise.resolve(); }
    return Promise.resolve(api.getLicense()).then((res) => {
      if (res && res.ok) { licenseEl.textContent = res.text; agree.disabled = false; }
      else fail((res && res.error) || 'The license text could not be loaded.');
      syncNext();
    }).catch(() => { fail('The license text could not be loaded.'); syncNext(); });
  }

  // ---- Components step: rows with a status icon. Required failure => "Repair needed" (Re-check / Exit); optional items are informational.
  const compList = document.getElementById('compList');
  const compIntro = document.getElementById('compIntro');
  const compRepair = document.getElementById('compRepair');
  const compRecheck = document.getElementById('compRecheck');
  const ICONS = { ok: 'ic-ok', fail: 'ic-fail', info: 'ic-info', wait: 'ic-wait' };
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function compRow(item) {
    const status = ICONS[item.status] ? item.status : 'info';
    const li = document.createElement('li');
    li.className = 'comp is-' + status;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'comp__ic');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#' + ICONS[status]);
    svg.appendChild(use);
    const body = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'comp__label';
    label.textContent = item.label + ': ' + (item.statusText || { ok: 'OK', fail: 'Needs repair', info: 'Not available', wait: 'Checking\u2026' }[status]);
    body.appendChild(label);
    if (item.detail) {
      const d = document.createElement('p');
      d.className = 'comp__detail';
      d.textContent = item.detail;
      body.appendChild(d);
    }
    li.appendChild(svg);
    li.appendChild(body);
    return li;
  }

  // Offline PDF export card elements
  const pdfCard = document.getElementById('pdfCard');
  const pdfSize = document.getElementById('pdfSize');
  const pdfDomain = document.getElementById('pdfDomain');
  const pdfCardNote = document.getElementById('pdfCardNote');
  const pdfAvailable = document.getElementById('pdfAvailable');
  const pdfAvailDetail = document.getElementById('pdfAvailDetail');
  const pdfActions = document.getElementById('pdfActions');
  const pdfInstallBtn = document.getElementById('pdfInstallBtn');
  const pdfSkipBtn = document.getElementById('pdfSkipBtn');
  const pdfProgressArea = document.getElementById('pdfProgressArea');
  const pdfPhase = document.getElementById('pdfPhase');
  const pdfMB = document.getElementById('pdfMB');
  const pdfSpeed = document.getElementById('pdfSpeed');
  const pdfSpeedBullet = document.getElementById('pdfSpeedBullet');
  const pdfProgressWrap = document.getElementById('pdfProgressWrap');
  const pdfProgressBar = document.getElementById('pdfProgressBar');
  const pdfCancelBtn = document.getElementById('pdfCancelBtn');
  const pdfCancelConfirm = document.getElementById('pdfCancelConfirm');
  const pdfConfirmYes = document.getElementById('pdfConfirmYes');
  const pdfConfirmNo = document.getElementById('pdfConfirmNo');
  const pdfErrorArea = document.getElementById('pdfErrorArea');
  const pdfErrorText = document.getElementById('pdfErrorText');
  const pdfManualArea = document.getElementById('pdfManualArea');
  const pdfManualLink = document.getElementById('pdfManualLink');
  const pdfRetryBtn = document.getElementById('pdfRetryBtn');
  const pdfErrorSkipBtn = document.getElementById('pdfErrorSkipBtn');
  const pdfDoneArea = document.getElementById('pdfDoneArea');
  const pdfDoneText = document.getElementById('pdfDoneText');
  const pdfSkippedArea = document.getElementById('pdfSkippedArea');
  const pdfInstallSkippedBtn = document.getElementById('pdfInstallSkippedBtn');

  let manifestInfo = null;
  let currentCardState = null;

  const PHASE_NAMES = {
    downloading: 'Downloading…',
    verifying: 'Verifying…',
    extracting: 'Extracting…',
    testing: 'Testing…',
    done: 'Ready'
  };

  function setCardState(state, data) {
    currentCardState = state;
    if (!pdfCard) return;
    pdfCard.hidden = false;

    pdfAvailable.hidden = true;
    pdfActions.hidden = true;
    pdfProgressArea.hidden = true;
    pdfCancelConfirm.hidden = true;
    pdfErrorArea.hidden = true;
    pdfDoneArea.hidden = true;
    pdfSkippedArea.hidden = true;
    pdfCardNote.hidden = true;

    if (state === 'initial') {
      pdfActions.hidden = false;
      pdfCardNote.hidden = false;
      pdfCardNote.textContent = "Skipping doesn't affect PowerPoint export.";
    } else if (state === 'available') {
      pdfAvailable.hidden = false;
      if (pdfAvailDetail) pdfAvailDetail.textContent = (data && data.detail) || '';
    } else if (state === 'installing') {
      pdfProgressArea.hidden = false;
    } else if (state === 'error') {
      pdfErrorArea.hidden = false;
      pdfErrorText.textContent = (data && (data.friendlyText || data.error)) || 'The installation could not finish.';
      if (data && data.officialUrl) {
        pdfManualArea.hidden = false;
        pdfManualLink.href = data.officialUrl;
        pdfManualLink.onclick = (e) => {
          e.preventDefault();
          if (window.setupAPI && window.setupAPI.openExternal) window.setupAPI.openExternal(data.officialUrl);
        };
      } else {
        pdfManualArea.hidden = true;
      }
      pdfRetryBtn.focus({ preventScroll: true });
    } else if (state === 'done') {
      pdfDoneArea.hidden = false;
      if (pdfDoneText) pdfDoneText.textContent = 'Offline PDF export is installed and ready.';
    } else if (state === 'skipped') {
      pdfSkippedArea.hidden = false;
      pdfCardNote.hidden = false;
      pdfCardNote.textContent = "Skipping doesn't affect PowerPoint export.";
    }
  }

  function updateProgress(p) {
    if (!p) return;
    const ph = p.phase || 'downloading';
    if (pdfPhase) pdfPhase.textContent = PHASE_NAMES[ph] || (ph.charAt(0).toUpperCase() + ph.slice(1) + '…');
    const pct = Math.min(100, Math.max(0, p.percent != null ? p.percent : 0));
    if (pdfProgressBar) pdfProgressBar.style.width = pct + '%';
    if (pdfProgressWrap) pdfProgressWrap.setAttribute('aria-valuenow', String(pct));
    if (pdfMB) pdfMB.textContent = p.mbText || '';
    if (pdfSpeed) pdfSpeed.textContent = p.speedText || '';
    if (pdfSpeedBullet) pdfSpeedBullet.hidden = !p.speedText || !p.mbText;
  }

  async function startInstall() {
    setCardState('installing');
    const totalFmt = (manifestInfo && manifestInfo.formattedSize) || '';
    updateProgress({ phase: 'downloading', percent: 0, mbText: totalFmt ? '0 MB / ' + totalFmt : '0 MB', speedText: '0 MB/s' });
    let res = null;
    try {
      res = await activeAPI.installLibreOffice();
    } catch (e) {
      res = { ok: false, error: e && e.message };
    }
    if (res && res.ok) {
      setCardState('done');
    } else if (res && res.cancelled) {
      setCardState('initial');
      if (pdfCardNote) pdfCardNote.textContent = "Installation cancelled. Skipping doesn't affect PowerPoint export.";
    } else {
      setCardState('error', res || {});
    }
  }

  async function skipInstall() {
    try {
      if (activeAPI && activeAPI.skipLibreOffice) {
        await activeAPI.skipLibreOffice();
      }
    } catch (_) {}
    setCardState('skipped');
  }

  async function removeManaged() {
    if (!activeAPI || !activeAPI.removeManaged) return;
    // Confirm destructive action
    const confirmed = window.confirm('Remove the managed LibreOffice installation?\n\nOnly the copy Laurevine Rose downloaded will be deleted. Your own system LibreOffice is untouched.');
    if (!confirmed) return;
    setCardState('installing');
    if (pdfPhase) pdfPhase.textContent = 'Removing…';
    try {
      const res = await activeAPI.removeManaged();
      if (res && res.ok) {
        setCardState('skipped');
        if (pdfCardNote) pdfCardNote.textContent = 'Managed LibreOffice removed. PowerPoint export works normally.';
      } else {
        setCardState('error', { friendlyText: (res && res.error) || 'Could not remove the managed installation.' });
      }
    } catch (e) {
      setCardState('error', { friendlyText: e && e.message });
    }
  }

  function initPdfCard() {
    if (activeAPI && typeof activeAPI.onInstallProgress === 'function') {
      activeAPI.onInstallProgress(updateProgress);
    }

    if (pdfInstallBtn) pdfInstallBtn.addEventListener('click', startInstall);
    if (pdfSkipBtn) pdfSkipBtn.addEventListener('click', skipInstall);
    if (pdfRetryBtn) pdfRetryBtn.addEventListener('click', startInstall);
    if (pdfErrorSkipBtn) pdfErrorSkipBtn.addEventListener('click', skipInstall);
    if (pdfInstallSkippedBtn) pdfInstallSkippedBtn.addEventListener('click', startInstall);

    if (pdfCancelBtn) {
      pdfCancelBtn.addEventListener('click', () => {
        pdfCancelConfirm.hidden = false;
        pdfConfirmNo.focus({ preventScroll: true });
      });
    }

    if (pdfConfirmYes) {
      pdfConfirmYes.addEventListener('click', () => {
        pdfCancelConfirm.hidden = true;
        if (activeAPI && activeAPI.cancelInstall) {
          activeAPI.cancelInstall();
        }
      });
    }

    if (pdfConfirmNo) {
      pdfConfirmNo.addEventListener('click', () => {
        pdfCancelConfirm.hidden = true;
        if (pdfCancelBtn) pdfCancelBtn.focus({ preventScroll: true });
      });
    }

    // Repair-mode extra actions: Remove Managed / View License
    if (IS_REPAIR) {
      const pdfAvailSection = document.getElementById('pdfAvailable');
      if (pdfAvailSection) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn btn--sm btn--danger';
        removeBtn.id = 'pdfRemoveManagedBtn';
        removeBtn.style.marginTop = '0.5rem';
        removeBtn.textContent = 'Remove managed converter';
        removeBtn.addEventListener('click', removeManaged);
        pdfAvailSection.appendChild(removeBtn);

        const viewLicBtn = document.createElement('button');
        viewLicBtn.type = 'button';
        viewLicBtn.className = 'btn btn--sm';
        viewLicBtn.id = 'pdfViewLicenseBtn';
        viewLicBtn.style.marginTop = '0.5rem';
        viewLicBtn.textContent = 'View license';
        viewLicBtn.addEventListener('click', async () => {
          if (!activeAPI || !activeAPI.getLicense) return;
          try {
            const res = await activeAPI.getLicense();
            if (res && res.ok) {
              const text = res.text;
              const dlg = document.createElement('dialog');
              dlg.style.cssText = 'max-width:680px;width:90vw;max-height:80vh;padding:1.25rem;border:1px solid #ccc;border-radius:6px;overflow:auto;';
              const pre = document.createElement('pre');
              pre.style.cssText = 'white-space:pre-wrap;font-size:0.75rem;line-height:1.5;margin:0 0 1rem 0;';
              pre.textContent = text;
              const closeBtn = document.createElement('button');
              closeBtn.type = 'button';
              closeBtn.className = 'btn btn--primary';
              closeBtn.textContent = 'Close';
              closeBtn.addEventListener('click', () => dlg.close());
              dlg.appendChild(pre);
              dlg.appendChild(closeBtn);
              document.body.appendChild(dlg);
              dlg.showModal();
              dlg.addEventListener('close', () => dlg.remove());
            }
          } catch (_) {}
        });
        pdfAvailSection.appendChild(viewLicBtn);
      }
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pdfCancelConfirm && !pdfCancelConfirm.hidden) {
        e.stopPropagation();
        pdfCancelConfirm.hidden = true;
        if (pdfCancelBtn) pdfCancelBtn.focus({ preventScroll: true });
      }
    });
  }

  function renderComponents(items) {
    compList.textContent = '';
    items.forEach((it) => compList.appendChild(compRow(it)));
  }

  async function runComponentsCheck() {
    if (checking) return;
    checking = true; componentsOk = false;
    compList.setAttribute('aria-busy', 'true');
    compRepair.hidden = true;
    compRecheck.disabled = true;
    compIntro.textContent = 'Checking that everything Laurevine Rose needs is ready.';
    // In repair mode only show the LibreOffice row (required items are checked by the engine)
    renderComponents(IS_REPAIR ? [
      { label: 'LibreOffice (optional)', status: 'wait' }
    ] : [
      { label: 'Application engine', status: 'wait' },
      { label: 'Bundled fonts', status: 'wait' },
      { label: 'User-data folder writable', status: 'wait' },
      { label: 'LibreOffice (optional)', status: 'wait' }
    ]);
    syncNext();

    // Fetch manifest info
    if (activeAPI && typeof activeAPI.getManifestInfo === 'function') {
      try {
        manifestInfo = await activeAPI.getManifestInfo();
      } catch (_) {}
    }
    if (manifestInfo) {
      if (pdfSize) pdfSize.textContent = manifestInfo.formattedSize || '';
      if (pdfDomain) pdfDomain.textContent = manifestInfo.sourceDomain || '';
    }

    let res = null;
    try { res = await activeAPI.checkComponents(); } catch (e) { res = null; }
    if (!res || !Array.isArray(res.items)) {
      res = { requiredOk: false, items: [{ label: 'Application engine', required: true, status: 'fail', detail: 'The components could not be checked.' }] };
    }
    checking = false;
    // In repair mode all required items are already satisfied; only the optional PDF step matters.
    componentsOk = IS_REPAIR ? true : res.requiredOk === true;
    compList.setAttribute('aria-busy', 'false');

    const isDetected = !!(res.libreoffice && res.libreoffice.path);

    // In repair mode only show the LibreOffice component row
    renderComponents(IS_REPAIR
      ? (res.items || []).filter((it) => it.id === 'office' || it.label === 'LibreOffice (optional)')
      : res.items);
    compRepair.hidden = IS_REPAIR ? true : componentsOk;
    compRecheck.disabled = false;
    compIntro.textContent = componentsOk ? 'Everything required is ready.' : 'Some required components need attention.';

    // Setup card state:
    // If LibreOffice already detected → "Already available" and Install is skipped.
    // Else card: "Offline PDF export (optional)", real size from manifest, source domain, "Skipping doesn't affect PowerPoint export". Install (primary #702D3B) / Skip.
    if (isDetected) {
      setCardState('available', { detail: res.libreoffice.path + (res.libreoffice.version ? ', version ' + res.libreoffice.version : '') });
    } else if (manifestInfo && !manifestInfo.supported) {
      setCardState('error', { friendlyText: 'Automatic LibreOffice setup is not available for this computer.', officialUrl: manifestInfo.officialUrl });
    } else {
      // Get state: use repairAPI.getInfo (which re-reads disk) or setupAPI.getState
      let st = null;
      try {
        if (IS_REPAIR && activeAPI.getInfo) {
          const info = await activeAPI.getInfo();
          if (info) st = { pdfSkipped: info.pdfSkipped, libreoffice: info.libreoffice };
        } else if (window.setupAPI && window.setupAPI.getState) {
          st = await window.setupAPI.getState();
        }
      } catch (_) {}
      if (st && st.pdfSkipped) {
        setCardState('skipped');
      } else if (st && st.libreoffice && st.libreoffice.status === 'installed') {
        setCardState('done');
      } else {
        setCardState('initial');
      }
    }

    syncNext();
    if (!componentsOk) (compRecheck).focus({ preventScroll: true });
  }

  // ---- Ready step: validation before launch
  const readyIntro = document.getElementById('readyIntro');
  const readyFailure = document.getElementById('readyFailure');
  const readyFailureText = document.getElementById('readyFailureText');
  const readyRetryBtn = document.getElementById('readyRetryBtn');
  const readyLicenseRow = document.getElementById('readyLicenseRow');
  const readyLicenseDetail = document.getElementById('readyLicenseDetail');
  const readyLicenseLink = document.getElementById('readyLicenseLink');
  const readyBackendRow = document.getElementById('readyBackendRow');
  const readyBackendDetail = document.getElementById('readyBackendDetail');
  const readyBackendLink = document.getElementById('readyBackendLink');
  const readyPdfRow = document.getElementById('readyPdfRow');
  const readyPdfLabel = document.getElementById('readyPdfLabel');
  const readyPdfDetail = document.getElementById('readyPdfDetail');
  const readyPdfLink = document.getElementById('readyPdfLink');
  const readyStateRow = document.getElementById('readyStateRow');
  const readyStateDetail = document.getElementById('readyStateDetail');
  const readyStateLink = document.getElementById('readyStateLink');

  function setRowState(row, ok, isInfo) {
    if (!row) return;
    row.classList.toggle('is-ok', !!ok);
    row.classList.toggle('is-fail', !ok && !isInfo);
    row.classList.toggle('is-info', !!isInfo);
    const use = row.querySelector('use');
    if (use) {
      if (ok) use.setAttribute('href', '#ic-ok');
      else if (isInfo) use.setAttribute('href', '#ic-info');
      else use.setAttribute('href', '#ic-fail');
    }
  }

  async function runReadyValidation() {
    if (readyValidating) return;
    readyValidating = true;
    readyValidationOk = false;
    syncNext();
    if (readyIntro) readyIntro.textContent = 'Verifying that everything is ready to launch…';
    if (readyFailure) readyFailure.hidden = true;

    // Reset rows to checking/wait state
    [readyLicenseRow, readyBackendRow, readyPdfRow, readyStateRow].forEach((r) => {
      if (r) {
        r.classList.remove('is-ok', 'is-fail', 'is-info');
        const use = r.querySelector('use');
        if (use) use.setAttribute('href', '#ic-wait');
      }
    });

    let res = null;
    try {
      if (window.setupAPI && window.setupAPI.getReadyValidation) {
        res = await window.setupAPI.getReadyValidation();
      }
    } catch (e) {
      res = null;
    }

    readyValidating = false;

    if (!res) {
      readyValidationOk = false;
      syncNext();
      if (readyIntro) readyIntro.textContent = 'Validation checks could not run.';
      if (readyFailure) {
        readyFailure.hidden = false;
        readyFailureText.textContent = 'Setup could not verify the application state. Please try again.';
      }
      return;
    }

    const checks = res.checks || {};
    const pdf = res.pdfExport || {};

    // 1. License row
    const licOk = checks.license && checks.license.ok;
    setRowState(readyLicenseRow, licOk);
    if (readyLicenseDetail) readyLicenseDetail.textContent = checks.license ? checks.license.detail : (licOk ? 'Accepted' : 'Not accepted');
    if (readyLicenseLink) {
      readyLicenseLink.hidden = licOk;
      readyLicenseLink.onclick = (e) => { e.preventDefault(); go('license'); };
    }

    // 2. Backend row
    const beOk = checks.backend && checks.backend.ok;
    setRowState(readyBackendRow, beOk);
    if (readyBackendDetail) readyBackendDetail.textContent = checks.backend ? checks.backend.detail : (beOk ? 'Self-check passed' : 'Engine check failed');
    if (readyBackendLink) {
      readyBackendLink.hidden = beOk;
      readyBackendLink.onclick = (e) => { e.preventDefault(); go('components'); };
    }

    // 3. PDF export row (Summary row: Ready / Skipped (can enable later))
    const loOk = checks.libreoffice ? checks.libreoffice.ok : true;
    const isSkipped = pdf.status === 'skipped';
    if (readyPdfLabel) {
      readyPdfLabel.textContent = isSkipped ? 'PDF export: Skipped (can enable later)' : 'PDF export: Ready';
    }
    if (readyPdfDetail) {
      readyPdfDetail.textContent = isSkipped ? 'PowerPoint export works normally. Direct PDF export can be enabled later.' : (pdf.detail || 'Direct presentation PDF export enabled.');
    }
    setRowState(readyPdfRow, !isSkipped && loOk, isSkipped);
    if (readyPdfLink) {
      readyPdfLink.hidden = !isSkipped && loOk;
      readyPdfLink.textContent = isSkipped ? 'Enable' : 'Fix';
      readyPdfLink.onclick = (e) => { e.preventDefault(); go('components'); };
    }

    // 4. State storage row
    const stOk = checks.state && checks.state.ok;
    setRowState(readyStateRow, stOk);
    if (readyStateDetail) readyStateDetail.textContent = checks.state ? checks.state.detail : (stOk ? 'Writable' : 'Cannot save settings');
    if (readyStateLink) {
      readyStateLink.hidden = stOk;
      readyStateLink.onclick = (e) => { e.preventDefault(); go('components'); };
    }

    readyValidationOk = res.allPassed === true;
    syncNext();

    if (readyIntro) {
      readyIntro.textContent = readyValidationOk ? 'All checks passed. You are ready to start using Laurevine Rose.' : 'Some validation checks need attention before launch.';
    }

    if (readyFailure) {
      readyFailure.hidden = readyValidationOk;
      if (!readyValidationOk) {
        const failedChecks = [];
        if (!licOk) failedChecks.push('License agreement');
        if (!beOk) failedChecks.push('Application engine');
        if (!stOk) failedChecks.push('Settings storage');
        if (!loOk) failedChecks.push('LibreOffice');
        readyFailureText.textContent = 'Validation failed for: ' + failedChecks.join(', ') + '. Click the link beside the failing check or Re-validate below.';
      }
    }
  }

  function initReady() {
    if (readyRetryBtn) readyRetryBtn.addEventListener('click', runReadyValidation);
  }

  function initComponents() {
    compRecheck.addEventListener('click', runComponentsCheck);
    const compExit = document.getElementById('compExit');
    if (compExit) {
      if (IS_REPAIR) {
        compExit.textContent = 'Close';
        compExit.addEventListener('click', () => { if (activeAPI && activeAPI.close) activeAPI.close(); });
      } else {
        compExit.addEventListener('click', () => { if (window.setupAPI && window.setupAPI.exit) window.setupAPI.exit(); });
      }
    }
    initPdfCard();
  }

  async function init() {
    initChrome();
    backBtn.addEventListener('click', back);
    nextBtn.addEventListener('click', IS_REPAIR ? () => { if (activeAPI && activeAPI.close) activeAPI.close(); } : next);
    initWelcome();
    initLicense();
    initComponents();
    initReady();

    if (IS_REPAIR) {
      // Repair mode: hide back/decline, relabel next, set window title
      backBtn.hidden = true;
      if (declineBtn) declineBtn.hidden = true;
      nextBtn.textContent = 'Done';
      nextBtn.disabled = false;
      try {
        const titleEl = document.querySelector('.step__title, h1');
        if (titleEl) titleEl.textContent = 'Setup & Components';
      } catch (_) {}
      // Go straight to components
      go('components');
      return;
    }

    const order = available();
    let start = order[0];
    let stateError = null;
    try {
      const st = await window.setupAPI.getState();
      if (st && st.error) stateError = st.error;
      if (st && st.licenseCurrent) {
        // Resume: license already accepted for this version, so skip Welcome and the license prompt.
        accepted = true;
        agree.checked = true;
        start = order[order.indexOf('license') + 1] || 'license';
      }
    } catch (e) { /* fall back to the first step */ }
    if (start) go(start);
    if (stateError) setMsg(stateError, true);
    else if (accepted && start === 'license') setMsg('License accepted.');
    syncNext();
  }

  RPE.setup = { STEPS, go, next, back, startInstall, skipInstall, removeManaged, setCardState, runReadyValidation };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.RPE = window.RPE || {});
