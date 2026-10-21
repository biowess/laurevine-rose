/* app.js — boots the editor and wires the application chrome:
   title bar, status bar, notes pane, resizers, File backstage, keyboard shortcuts, file inputs.
   Public hooks for integrators are documented in README.md (RPE.store, RPE.commands, RPE.bus, RPE.backend). */
(function (RPE) {
  'use strict';
  const S = RPE.store, ui = S.ui, U = RPE.ui, h = RPE.h, ic = RPE.icons.html;
  const $ = (s) => document.querySelector(s);
  const run = (id, args, src) => RPE.commands.run(id, args || {}, src || 'app');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ---------- title bar ---------- */
  const SAVE_TEXT = { new: 'Not saved yet', dirty: 'Unsaved changes', saved: 'Saved to this browser', opened: 'Opened from file', failed: 'Not saved: download a copy' };
  function updateTitle() {
    $('#docTitleText').textContent = S.doc.title; $('#docTitle').setAttribute('aria-label', `Presentation name: ${S.doc.title}. Click to rename.`);
    document.title = `${S.doc.title} — Research Presentation Editor`;
    const st = $('#saveState'); st.dataset.state = ui.saveState; $('#saveStateText').textContent = SAVE_TEXT[ui.saveState] || '';
  }
  function renameStart() {
    const btn = $('#docTitle'), input = h('input', { class: 'doc-title-input', value: S.doc.title, 'aria-label': 'Presentation name', maxlength: '120' });
    btn.replaceWith(input); input.focus(); input.select();
    let finished = false; const done = (ok) => { if (finished || !input.isConnected) return; finished = true; const v = input.value; input.replaceWith(btn); if (ok) run('file.rename', { title: v }, 'title'); updateTitle(); btn.focus(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
    input.addEventListener('blur', () => done(true));
  }

  /* ---------- status bar ---------- */
  const KIND_NAME = { text: 'Text box', shape: 'Shape', image: 'Picture', plot: 'Plot', figure: 'Multi-panel figure', table: 'Table' };
  function updateStatus() {
    const n = S.doc.slides.length, i = S.activeIndex();
    $('#statusSlide').textContent = `Slide ${i + 1} of ${n}`;
    const sel = S.selectedObjects(); $('#statusSel').textContent = !sel.length ? '' : sel.length === 1 ? KIND_NAME[sel[0].type] + ' selected' : sel.length + ' objects selected';
    const open = S.doc.comments.filter((c) => !c.resolved).length, b = $('#commentBadge'); b.textContent = open; b.hidden = !open;
    const sorter = ui.view === 'sorter', r = $('#zoomRange'), z = sorter ? ui.sorterZoom : ui.zoom;
    r.min = sorter ? 10 : 10; r.max = sorter ? 50 : 400; r.step = sorter ? 2 : 1; r.value = z; r.setAttribute('aria-valuetext', z + ' percent');
    $('#zoomPct').textContent = z + '%'; $('#zoomPct').setAttribute('aria-label', (sorter ? 'Thumbnail size ' : 'Zoom ') + z + ' percent');
    const pct = (z - r.min) / (r.max - r.min) * 100; r.style.setProperty('--fill', pct + '%');
  }
  function updateLayout() {
    const a = $('#app');
    a.dataset.view = ui.view; a.classList.toggle('ribbon-collapsed', ui.ribbonCollapsed); a.classList.toggle('ribbon-peek', ui.ribbonCollapsed && ui.ribbonPeek);
    a.classList.toggle('notes-open', ui.notesOpen && ui.view === 'normal');
    a.style.setProperty('--pane-w', ui.paneWidth + 'px'); a.style.setProperty('--notes-h', (ui.notesOpen ? ui.notesHeight : 0) + 'px');
    $('#sorter').hidden = ui.view !== 'sorter'; $('#wsScroll').hidden = ui.view !== 'normal';
    $('#ribbonToggle').setAttribute('aria-pressed', String(ui.ribbonCollapsed)); $('#ribbonToggle').dataset.tip = ui.ribbonCollapsed ? 'Expand the ribbon' : 'Collapse the ribbon';
    $('#ribbonToggle').querySelector('svg, i').style.transform = ui.ribbonCollapsed ? 'rotate(180deg)' : '';
    $('#app').dataset.backstage = ui.backstage ? '1' : '';
    document.documentElement.classList.toggle('reduce-motion', !!S.prefs.reduceMotion);
  }

  /* ---------- notes ---------- */
  function syncNotes(force) {
    const ta = $('#notesText'), s = S.activeSlide(); if (!s) return;
    if (ta.value !== s.notes && (force || document.activeElement !== ta)) ta.value = s.notes;
  }
  function initNotes() {
    const ta = $('#notesText');
    ta.addEventListener('input', () => { const s = S.activeSlide(); S.mutate('Edit notes', () => { s.notes = ta.value; }, { coalesce: 'notes:' + s.id, window: 2500, hint: { meta: true } }); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); ta.blur(); } });
  }
  function dragResize(el, onMove, cursor) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); el.setPointerCapture(e.pointerId); document.body.style.cursor = cursor; $('#app').classList.add('is-resizing');
      const mv = (ev) => onMove(ev), up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); document.body.style.cursor = ''; $('#app').classList.remove('is-resizing'); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
    });
    el.addEventListener('keydown', (e) => { const d = { ArrowLeft: -12, ArrowUp: 12, ArrowRight: 12, ArrowDown: -12 }[e.key]; if (d) { e.preventDefault(); onMove(null, d); } });
  }
  function initResizers() {
    dragResize($('#paneResizer'), (e, key) => { const w = e ? e.clientX - $('#slidepane').getBoundingClientRect().left : ui.paneWidth + key; S.setUI({ paneWidth: clamp(Math.round(w), 150, 340) }); }, 'col-resize');
    dragResize($('#notesResizer'), (e, key) => { const bottom = $('#notes').getBoundingClientRect().bottom, hh = e ? bottom - e.clientY : ui.notesHeight + key; S.setUI({ notesHeight: clamp(Math.round(hh), 56, 360) }); }, 'row-resize');
  }

  /* ---------- File backstage ---------- */
  const PANELS = [['new', 'New', 'file-plus-2'], ['open', 'Open', 'folder-open'], ['save', 'Save', 'save'], ['export', 'Export', 'share'], ['setup', 'Setup & Components', 'settings-2'], ['prefs', 'Preferences', 'settings'], ['about', 'About', 'info']];
  const bsClean = (v) => RPE.backstageMeta.clean(v);
  function bsBtn(icon, title, desc, cmd, args, disabled) { const b = h('button', { type: 'button', class: 'bs-card', disabled, html: `${ic(icon)}<span><b>${U.esc(bsClean(title))}</b><small>${U.esc(bsClean(desc))}</small></span>` }); if (cmd) { b.dataset.command = cmd; if (args) b.dataset.args = JSON.stringify(args); } return b; }
  function bsPanel(id) {
    const saved = ui.localInfo, wrap = h('div', { class: 'bs-panel' });
    /* page title + description come from RPE.backstageMeta; append() would print a literal "null" for a null child, so only real nodes are appended */
    const meta = RPE.backstageMeta.page(id), head = () => wrap.append(...[h('h2', null, meta.title), meta.desc ? h('p', { class: 'bs-lead' }, meta.desc) : null].filter(Boolean));
    if (id === 'new') { head(); wrap.append(h('div', { class: 'bs-cards' }, bsBtn('presentation', 'Blank presentation', 'One title slide, widescreen 16:9', 'file.new', {}), bsBtn('flask-conical', 'Sample research deck', 'Eight demo slides with plots and a multi-panel figure', 'file.new', { sample: true }))); }
    else if (id === 'open') { head(); wrap.append(h('div', { class: 'bs-cards' }, bsBtn('folder-open', 'Open project file…', 'A .rpe.json file downloaded with "Download project"', 'file.openFile'), bsBtn('hard-drive', 'Copy saved in this browser', saved ? 'Saved ' + new Date(saved.savedAt).toLocaleString() : 'Nothing saved yet', 'file.openLocal', null, !saved)), h('p', { class: 'bs-note' }, 'Project files contain every figure image and keep figures linked to their data and settings.')); }
    else if (id === 'save') { head(); wrap.append(h('div', { class: 'bs-cards' }, bsBtn('save', 'Save to this browser', 'Stored in this browser (IndexedDB), figures included. Ctrl+S', 'file.save'), bsBtn('download', 'Download project (.json)', 'A real file you can open again here', 'file.exportJson'), bsBtn('cloud-upload', 'Save to server', 'Saves to local Python service', 'presentation.saveServer', null, false)), h('p', { class: 'bs-note' }, 'Current state: ' + (SAVE_TEXT[ui.saveState] || '') + '.')); }
    else if (id === 'export') { head(); wrap.append(h('div', { class: 'bs-cards' }, bsBtn('file-text', 'PowerPoint (.pptx)', 'Native editable PowerPoint presentation', 'present.export', { format: 'pptx' }), bsBtn('file-text', 'PDF (.pdf)', 'Direct PDF presentation export', 'present.export', { format: 'pdf' }), bsBtn('download', 'Project file (.json)', 'Editor state with all figure images', 'file.exportJson'))); }
    else if (id === 'setup') {
      head();
      const hasDesktop = !!(window.desktopAPI && typeof window.desktopAPI.openSetup === 'function');
      if (hasDesktop) {
        wrap.append(h('div', { class: 'bs-cards' },
          bsBtn('refresh-cw', 'Re-detect', 'Scan for LibreOffice and update the PDF export status', 'setup.openRepair', { mode: 'repair' }),
          bsBtn('settings-2', 'Install / Reinstall PDF converter', 'Download and install the managed LibreOffice copy', 'setup.openRepair', { mode: 'repair' }),
          bsBtn('trash-2', 'Remove managed converter', 'Delete only the copy Laurevine Rose downloaded', 'setup.openRepair', { mode: 'repair' }),
          bsBtn('file-text', 'View license', 'Read the software license agreement', 'setup.openRepair', { mode: 'repair' })
        ));
        wrap.append(h('p', { class: 'bs-note' }, 'Opening the Setup wizard does not restart the backend or lose unsaved work.'));
      } else {
        wrap.append(h('p', { class: 'bs-lead' }, 'Setup & Components is only available in the desktop application.'));
      }
    }
    else if (id === 'prefs') {
      head();
      const tog = (label, key, desc) => { const i = h('input', { type: 'checkbox', checked: !!S.prefs[key] }); i.addEventListener('change', () => { S.setPrefs({ [key]: i.checked }); updateLayout(); }); return h('label', { class: 'bs-row' }, h('span', null, h('b', null, label), h('small', null, desc)), i); };
      const url = h('input', { class: 'input', type: 'text', value: S.prefs.backendUrl, 'aria-label': 'Backend URL' }); url.addEventListener('change', () => S.setPrefs({ backendUrl: url.value.trim() }));
      wrap.append(h('div', { class: 'bs-list' }, tog('Reduce motion', 'reduceMotion', 'Turns off interface transitions (also follows the system setting).'), tog('Autosave to this browser', 'autosave', 'Saves shortly after each change.'), tog('Full-screen slide show', 'fullscreenPresent', 'Ask the browser for full screen when presenting.'), h('label', { class: 'bs-row bs-row--col' }, h('span', null, h('b', null, 'Backend URL'), h('small', null, 'Used by RPE.backend for local Python service.')), url)));
    } else {
      head();
      const row = (k, v) => h('div', { class: 'bs-row' }, h('span', null, h('b', null, k), h('small', null, v)));
      wrap.append(h('div', { class: 'bs-list' }, row('Version', RPE.backstageMeta.VERSION), row('Project files', '.rpe.json, with every figure image and its settings'), row('Export', 'PowerPoint (.pptx) and PDF through the local Python service'), row('Credits', 'Icons: Lucide (ISC). Typeface: Spline Sans (SIL OFL).')));
    }
    return wrap;
  }
  function renderBackstage() {
    const bs = $('#backstage'); bs.hidden = !ui.backstage; if (!ui.backstage) return;
    const nav = h('nav', { class: 'bs-nav', 'aria-label': 'File menu' }, h('button', { type: 'button', class: 'bs-back', 'aria-label': 'Back to presentation', 'data-tip': 'Back (Esc)', dataset: { command: 'file.close' }, html: ic('arrow-left') }),
      PANELS.map((p) => h('button', { type: 'button', class: 'bs-item' + (p[0] === ui.backstage ? ' is-active' : ''), 'aria-current': p[0] === ui.backstage ? 'page' : null, onclick: () => S.setUI({ backstage: p[0] }), html: `${ic(p[2])}<span>${p[1]}</span>` })));
    bs.replaceChildren(nav, h('div', { class: 'bs-main' }, bsPanel(ui.backstage))); RPE.icons.render(bs);
    const a = bs.querySelector('.bs-item.is-active'); if (a && !bs.contains(document.activeElement)) a.focus({ preventScroll: true });
    RPE.ribbon.refresh();
  }
  RPE.commands.register('presentation.saveServer', async () => {
    const res = await RPE.backend.request('presentation.save', { doc: S.prepareSave() });
    if (res && res.ok) {
      U.toast('Presentation saved to server.', { kind: 'success' });
    } else {
      U.toast('Could not save to server: backend offline.', { kind: 'warn' });
    }
  });

  /* ---------- keyboard ---------- */
  function onKey(e) {
    if (ui.presenting || e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.key === 'Escape' && ui.backstage) { e.preventDefault(); run('file.close', {}, 'key'); return; }
    if (mod && k === 'k' || (e.altKey && k === 'q')) { e.preventDefault(); run('app.search', {}, 'key'); return; }
    if (mod && k === 's') { e.preventDefault(); run('file.save', {}, 'key'); return; }
    if (e.key === 'F5') { e.preventDefault(); run('present.start', { from: e.shiftKey ? 'current' : 'beginning' }, 'key'); return; }
    if (mod && e.key === 'F1') { e.preventDefault(); run('view.collapseRibbon', {}, 'key'); return; }
    if (U.hasDialog() || ui.backstage) return;
    const field = e.target.closest && e.target.closest('input,textarea,select,[contenteditable="true"]');
    if (mod && (k === 'z' || k === 'y')) { if (field) return; e.preventDefault(); (k === 'y' || e.shiftKey) ? run('app.redo', {}, 'key') : run('app.undo', {}, 'key'); return; }
    if (mod && k === 'f') { e.preventDefault(); run('edit.find', {}, 'key'); return; }
    if (mod && k === 'h') { e.preventDefault(); run('edit.replace', {}, 'key'); return; }
    const inTextInput = e.target.closest && e.target.closest('input,textarea,select');
    if (!inTextInput) {
      if (mod && !e.shiftKey && (e.key === '=' || e.code === 'Equal')) { e.preventDefault(); run('font.subscript', {}, 'key'); return; }
      if (mod && ((e.shiftKey && (e.key === '=' || e.key === '+' || e.code === 'Equal')) || e.key === '+')) { e.preventDefault(); run('font.superscript', {}, 'key'); return; }
    }
    if (field) return;
    const one = S.selectedObjects();
    if (mod && k === 'm') { e.preventDefault(); run('slide.new', {}, 'key'); return; }
    if (mod && k === 'c' && one.length) { e.preventDefault(); run('clip.copy', {}, 'key'); return; }
    if (mod && k === 'x' && one.length) { e.preventDefault(); run('clip.cut', {}, 'key'); return; }
    if (mod && k === 'v') { e.preventDefault(); run('clip.paste', {}, 'key'); return; }
    if (mod && k === 'd') { e.preventDefault(); one.length ? run('object.duplicate', {}, 'key') : run('slide.duplicate', {}, 'key'); return; }
    if (mod && k === 'a') { e.preventDefault(); run('edit.select', { mode: 'all' }, 'key'); return; }
    if (mod && k === 'g') { e.preventDefault(); run(e.shiftKey ? 'arrange.ungroup' : 'arrange.group', {}, 'key'); return; }
    if (mod && k === 'b') { e.preventDefault(); run('font.bold', {}, 'key'); return; }
    if (mod && k === 'i') { e.preventDefault(); run('font.italic', {}, 'key'); return; }
    if (mod && k === 'u') { e.preventDefault(); run('font.underline', {}, 'key'); return; }
    if (e.key === 'Escape') { if (ui.painter) S.setUI({ painter: null }); else if (ui.ribbonPeek) S.setUI({ ribbonPeek: false }); else if (ui.selectedIds.length) S.select([]); return; }
    if ((e.key === 'Enter' || e.key === 'F2') && one.length === 1 && ['text', 'shape'].includes(one[0].type)) { e.preventDefault(); RPE.canvas.startEdit(one[0].id, { atEnd: true }); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && one.length) { e.preventDefault(); run('object.delete', {}, 'key'); return; }
    if (e.key.startsWith('Arrow') && one.length && ui.view === 'normal') { e.preventDefault(); const s = e.shiftKey ? 10 : 1; RPE.canvas.nudge({ ArrowLeft: -s, ArrowRight: s }[e.key] || 0, { ArrowUp: -s, ArrowDown: s }[e.key] || 0); return; }
    if (e.key === 'Tab' && document.activeElement === $('#wsScroll') && ui.view === 'normal') { const list = S.activeSlide().objects; if (list.length) { e.preventDefault(); const i = list.findIndex((o) => o.id === ui.selectedIds[0]); S.select([list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length].id]); } return; }
    if ((e.key === 'PageDown' || e.key === 'PageUp') && ui.view === 'normal') { e.preventDefault(); run(e.key === 'PageDown' ? 'slide.next' : 'slide.prev', {}, 'key'); }
  }

  /* ---------- file inputs ---------- */
  function initFiles() {
    $('#filePicture').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (!/^image\//.test(f.type)) { U.toast('Choose an image file (PNG, JPEG, SVG, GIF).', { kind: 'warn' }); return; }
      const rd = new FileReader();
      rd.onload = () => {
        const im = new Image();
        im.onload = () => {
          const ar = im.naturalWidth / im.naturalHeight, maxW = 760, maxH = 400; let w = maxW, hh = w / ar; if (hh > maxH) { hh = maxH; w = hh * ar; }
          w = Math.round(w); hh = Math.round(hh);
          if (e.target.dataset.mode === 'replace' && S.selectedObjects()[0] && S.selectedObjects()[0].type === 'image') { const o = S.selectedObjects()[0]; S.mutate('Replace picture', () => { o.src = rd.result; o.name = f.name; o.aspect = ar; o.h = Math.round(o.w / ar); }, { hint: { objects: [o.id] } }); }
          else RPE.commands.addObject({ id: S.uid('o'), type: 'image', role: 'figure', x: Math.round((S.doc.size.w - w) / 2), y: Math.round((S.doc.size.h - hh) / 2), w, h: hh, name: f.name, alt: '', src: rd.result, aspect: ar }, 'picture');
        };
        im.onerror = () => U.toast('That image could not be read.', { kind: 'warn' }); im.src = rd.result;
      };
      rd.readAsDataURL(f);
    });
    $('#fileOpen').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return; const rd = new FileReader();
      rd.onload = () => {
        try {
          const j = JSON.parse(rd.result);
          if (!j || typeof j !== 'object') throw new Error('File contains invalid JSON.');
          let doc = null;
          if (j.format === 'rpe-deck' && j.doc) {
            if (j.version && j.version > 1) {
              U.toast('Unsupported project schema version (' + j.version + ').', { kind: 'warn' });
              return;
            }
            doc = j.doc;
          } else if (Array.isArray(j.slides) && j.slides.length) {
            doc = j;
          } else {
            throw new Error('Project file is missing slides or has an unrecognized structure.');
          }
          if (!Array.isArray(doc.slides) || doc.slides.length === 0) {
            throw new Error('Presentation must contain at least one slide.');
          }
          doc.slides.forEach((sl) => {
            if (!sl.id) sl.id = S.uid('s');
            sl.objects = Array.isArray(sl.objects) ? sl.objects.filter((o) => o && typeof o === 'object') : [];
            sl.objects.forEach((o) => { if (!o.id) o.id = S.uid('o'); });
          });
          const notes = S.replaceDoc(doc, 'opened');   // resolves embedded images, repairs broken figure links
          S.setUI({ backstage: null });
          U.toast(['Opened ' + f.name + '.'].concat(notes).join(' '), notes.length ? { kind: 'warn', duration: 9000 } : { kind: 'success' });
        } catch (err) {
          U.toast('Could not open project: ' + err.message, { kind: 'warn' });
        }
      };
      rd.onerror = () => U.toast('That file could not be read.', { kind: 'warn' });
      rd.readAsText(f);
    });
  }

  /* ---------- boot ---------- */
  function boot() {
    S.doc = RPE.seed.createDeck({ blank: true }); S.ui.activeSlideId = S.doc.slides[0].id; S.clearHistory(); S.ui.saveState = 'new';
    U.initTooltips(); U.initDismissal();
    RPE.icons.render(document);
    RPE.canvas.init(); RPE.slidepane.init(); RPE.ribbon.init();
    if (RPE.findPanel && RPE.findPanel.init) RPE.findPanel.init();
    initNotes(); initResizers(); initFiles();
    $('#docTitle').addEventListener('click', renameStart);
    $('#zoomRange').addEventListener('input', (e) => run('view.zoom', { value: e.target.value }, 'slider'));
    $('#ribbonToggle').addEventListener('click', () => run('view.collapseRibbon', {}, 'button'));
    $('#paneResizer').setAttribute('aria-valuenow', String(ui.paneWidth));
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', (e) => { if (ui.ribbonPeek && !e.target.closest('.ribbon,.tabrow,.popover')) S.setUI({ ribbonPeek: false }); }, true);
    window.addEventListener('beforeunload', (e) => { if (ui.saveState === 'dirty' || ui.saveState === 'failed') { e.preventDefault(); e.returnValue = ''; } });
    window.addEventListener('error', (e) => console.error('[rpe] uncaught', e.message));
    const all = () => { updateTitle(); updateStatus(); updateLayout(); syncNotes(true); renderBackstage(); };
    RPE.bus.on('doc', (e) => { updateTitle(); updateStatus(); syncNotes(!!(e.hint && e.hint.history)); });
    RPE.bus.on('ui', (e) => {
      const c = e.changed; updateTitle(); updateStatus(); updateLayout();
      if (c.includes('activeSlideId')) syncNotes(true);
      if (c.includes('backstage') || (ui.backstage && (c.includes('saveState') || c.includes('localInfo')))) renderBackstage();
      if (c.includes('ribbonCollapsed') || c.includes('view')) RPE.ribbon.fit();
    });
    RPE.bus.on('prefs', updateLayout);
    all(); RPE.ribbon.refresh();
    S.migrateLegacyLocal().then(() => S.refreshLocalInfo());
    document.body.classList.add('is-ready');
    RPE.app = { version: '1.1.0' };
    RPE.bus.emit('ready', { version: '1.1.0' });
    // When the repair wizard closes, re-render the setup backstage panel if open
    if (window.ipcRenderer && typeof window.ipcRenderer.on === 'function') {
      window.ipcRenderer.on('app:setup-closed', () => { if (ui.backstage === 'setup') renderBackstage(); });
    }
  }
  (function wait() { const t0 = Date.now(); (function poll() { const st = window.__lucideState; if (st === 'loaded' || st === 'failed' || Date.now() - t0 > 1800) boot(); else setTimeout(poll, 25); })(); })();
})(window.RPE = window.RPE || {});
