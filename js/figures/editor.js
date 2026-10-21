/* editor.js — the figure editor dialog: RPE.figures.openEditor({ mode:'insert'|'edit'|'panel', record, plotType, tab, onSave }).
   The dialog works on a DRAFT (RPE.figures.cloneForEdit); the document is untouched until onSave commits it. Header = name | type |
   data-source chip; left = six plot-type tiles; right = tabs that keep their state (each tab is mounted once, then shown/hidden).
   The Preview tab = image area + settings sidebar (section 4l). Tabs come from the registry RPE.figures.tabs.<id> = { mount(ctx) -> HTMLElement, onShow(), dispose() }; a tab without a
   registered module is not shown. Ids: preview (built in here), spreadsheet, python, export. Every open gets its own instance
   (Object.create(entry)), so a module may keep per-dialog state on `this`. Contract: docs/FIGURES_CONTRACT.md section 4l. */
(function (RPE) {
  'use strict';
  const F = RPE.figures = RPE.figures || {};
  const registry = F.tabs = F.tabs || {};
  const U = RPE.ui, h = RPE.h, S = RPE.store, ic = RPE.icons.html;

  const TABS = [{ id: 'preview', label: 'Preview' }, { id: 'spreadsheet', label: 'Spreadsheet' }, { id: 'python', label: 'Python Source' }, { id: 'export', label: 'Export' }];
  const SOURCES = [{ id: 'sample', label: 'Sample data' }, { id: 'csv', label: 'CSV file' }, { id: 'sheet', label: 'Spreadsheet' }, { id: 'python', label: 'Python data' }];
  const MODES = { insert: { title: 'Insert plot', action: 'Insert' }, edit: { title: 'Edit plot', action: 'Apply' }, panel: { title: 'Edit panel plot', action: 'Save Plot' } };
  const srcLabel = (t) => (SOURCES.find((s) => s.id === t) || SOURCES[2]).label;

  /* ---------- draft ---------- */
  function openSession(o, mode) {
    const kinds = RPE.plots.KINDS;
    const rec = o.record;
    const type = kinds[o.plotType] ? o.plotType : (rec && rec.config && kinds[rec.config.plotType] ? rec.config.plotType : 'line');
    if (rec && mode === 'edit' && F.get(rec.id)) return F.cloneForEdit(rec.id);
    return F.cloneForEdit(rec || F.blank('structured', type));
  }
  const dataLabel = (rec) => { const o = (rec.dataset && rec.dataset.origin) || {}; return srcLabel(o.type) + (o.label ? ' · ' + o.label : ''); };

  /* ---------- built-in Preview tab: image + compact settings sidebar ---------- */
  const DEF = { title: '', subtitle: '', xLabel: '', yLabel: '', fontFamily: 'sans', fontSize: 10, showTitle: true, showXLabel: true, showYLabel: true, fontName: null };
  const SIZE_ROWS = [['Title', 'titleSize', 1.2], ['Axis labels', 'labelSize', 1], ['Tick labels', 'tickSize', 0.9]];   // the legend font size lives in the Legend group (controls.js)
  const FONT_SHOWN = 40;
  /* publication preset: one coherent set (small type, open axes, no grid); every value stays editable afterwards */
  const PUBLICATION = { fontSize: 8, titleSize: 9, labelSize: 8, tickSize: 7, legendSize: 7, lineWidth: 1, grid: false, gridMinor: false, despine: true, tickDirection: 'out', layout: 'tight' };

  registry.preview = {
    mount(ctx) {
      const self = this, rec = ctx.record;
      self.ctx = ctx; self.visible = false; self.stale = false; self.seq = 0; self.job = null; self.zoom = 'fit'; self.fonts = null; self.fontsNote = ''; self.sync_ = [];
      self.img = h('img', { class: 'fe__img', alt: 'Figure preview', hidden: true });
      self.empty = h('div', { class: 'fe__hint fe__empty', role: 'status', hidden: true });
      self.badge = h('span', { class: 'fe__badge', role: 'status', hidden: true }, 'Does not match current settings');
      self.canvas = h('div', { class: 'pd__canvas fe__canvas' }, self.img, self.empty);
      self.status = h('div', { class: 'pd__status', role: 'status' });
      self.busy = h('span', { class: 'chip fe__busy', hidden: true }, h('span', { class: 'fe__spin', 'aria-hidden': 'true' }), 'Rendering');
      self.btn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => self.render() });
      self.sum = h('summary', null, 'Diagnostics');
      self.details = h('details', { class: 'fe__details', hidden: true }, self.sum, h('div', { class: 'fe__log' }));
      const zoomBtn = (id, label) => { const b = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-pressed': 'false', onclick: () => { self.zoom = id; self.sync(); } }, label); b.dataset.zoom = id; return b; };
      self.zoomBtns = [zoomBtn('fit', 'Fit'), zoomBtn('100', '100%')];
      self.auto = F.debounce(() => { if (self.visible) self.render(); }, 350);
      self.hash = F.hash(rec);
      self.visualHash = (F.visualHash ? F.visualHash(rec) : F.hash(rec));
      self.pendingRender = false;
      self.offChange = ctx.onChange(() => {
        const vh = (F.visualHash ? F.visualHash(ctx.record) : F.hash(ctx.record));
        const visualMoved = vh !== self.visualHash;
        self.visualHash = vh;
        self.hash = F.hash(ctx.record);
        if (!visualMoved) return self.syncControls();
        if (!self.isAuto()) return self.syncControls();
        self.stale = true;
        self.sync();
        self.syncControls();
        self.auto();
      });
      self.offBackend = RPE.bus ? RPE.bus.on('backend:status', () => { if (self.visible) self.onShow(); }) : null;
      self.stale = !(rec.render && rec.render.status === 'ok');
      const side = self.buildSidebar(), sideId = (F.a11y ? F.a11y.id('fside') : 'fside');
      side.id = sideId; side.setAttribute('role', 'region'); side.setAttribute('aria-label', 'Figure settings');
      const wrap = h('div', { class: 'pd__pane fe__preview' });
      const drawer = (on) => { wrap.classList.toggle('is-drawer', on); self.drawerBtn.setAttribute('aria-expanded', String(on)); };
      self.drawerBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm fe__drawerbtn', 'aria-expanded': 'false', 'aria-controls': sideId, 'data-tip': 'Show or hide the figure settings', onclick: () => drawer(!wrap.classList.contains('is-drawer')) }, 'Settings');
      side.addEventListener('keydown', (e) => { if (e.key === 'Escape' && wrap.classList.contains('is-drawer')) { e.preventDefault(); drawer(false); self.drawerBtn.focus(); } });
      self.sync(); self.syncControls();
      wrap.append(
        h('div', { class: 'fe__view' },
          h('div', { class: 'fe__bar' }, h('div', { class: 'fe__zoom', role: 'group', 'aria-label': 'Zoom' }, self.zoomBtns), self.busy, self.status, self.btn, self.drawerBtn),
          h('div', { class: 'fe__frame' }, self.badge, self.canvas), self.details),
        side);
      return wrap;
    },
    isAuto() { return this.ctx.record.sourceMode === 'structured'; },

    /* ----- sidebar controls: every control edits the draft only through ctx.set ----- */
    app(k) { const a = this.ctx.record.config.appearance || {}; return a[k] === undefined ? DEF[k] : a[k]; },
    setApp(k, v) { this.ctx.set({ config: { appearance: { [k]: v } } }); },
    buildSidebar() {
      const self = this, ctx = self.ctx, reg = (fn) => { self.sync_.push(fn); fn(); };
      const group = (title, open, ...kids) => h('details', { class: 'fe__grp', open: open }, h('summary', { class: 'fe__gh' }, title), h('div', { class: 'fe__gb' }, kids));
      const field = (label, control) => h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), control);
      const text = (label, key, ph) => {
        const el = h('input', { class: 'input', type: 'text', maxlength: 500, placeholder: ph || '', 'aria-label': label });
        el.addEventListener('input', () => self.setApp(key, el.value));
        reg(() => { const v = self.app(key) || ''; if (el.value !== v) el.value = v; });
        return field(label, el);
      };
      const check = (label, key) => {
        const el = h('input', { type: 'checkbox' });
        el.addEventListener('change', () => self.setApp(key, !!el.checked));
        reg(() => { el.checked = !!self.app(key); });
        return h('label', { class: 'check' }, el, label);
      };
      /* number box: empty = automatic (null), otherwise lo..hi; an out-of-range entry is flagged and not applied */
      const num = (label, read, write, lo, hi, auto) => {
        const el = h('input', { class: 'input', type: 'number', min: lo, max: hi, step: 0.5, 'aria-label': label + ' size in points', 'aria-invalid': 'false', title: lo + ' to ' + hi + ' pt; empty = automatic' });
        el.addEventListener('input', () => {
          const t = String(el.value).trim(), v = t === '' ? null : Number(t), bad = v !== null && (!isFinite(v) || v < lo || v > hi);
          el.setAttribute('aria-invalid', String(bad)); if (!bad) write(v);
        });
        reg(() => {
          const v = read(), t = String(el.value).trim();
          if (!(v === null || v === undefined ? t === '' : Number(t) === v)) el.value = v === null || v === undefined ? '' : v;
          el.setAttribute('placeholder', String(auto()));
        });
        return field(label, el);
      };
      const base = () => Number(self.app('fontSize')) || 10, rnd = (x) => Math.round(x * 10) / 10;

      /* title block */
      const titleG = group('Title', true, text('Title', 'title'), text('Subtitle', 'subtitle'), check('Show title', 'showTitle'));
      /* axis labels */
      const axisG = group('Axis labels', true, text('X label', 'xLabel', 'Automatic'), text('Y label', 'yLabel', 'Automatic'), h('div', { class: 'pd__checks' }, check('Show X label', 'showXLabel'), check('Show Y label', 'showYLabel')));
      /* font: generic family + optional installed font (searched in a compact list) */
      const fam = h('select', { class: 'select', 'aria-label': 'Font family' }, [['sans', 'Sans-serif'], ['serif', 'Serif'], ['mono', 'Monospace']].map((o) => h('option', { value: o[0] }, o[1])));
      fam.addEventListener('change', () => self.setApp('fontFamily', fam.value));
      reg(() => { if (fam.value !== self.app('fontFamily')) fam.value = self.app('fontFamily'); });
      const search = h('input', { class: 'input', type: 'search', placeholder: 'Search installed fonts', 'aria-label': 'Search installed fonts' });
      self.cur = h('div', { class: 'fe__hint' });
      self.list = h('div', { class: 'fe__fonts', role: 'listbox', 'aria-label': 'Installed fonts' });
      self.search = search;
      search.addEventListener('focus', () => self.loadFonts());
      search.addEventListener('input', () => { self.loadFonts(); self.renderFonts(); });
      const useDefault = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => self.setApp('fontName', null) }, 'Use family default');
      reg(() => { const n = self.app('fontName'); self.cur.textContent = n ? 'Using ' + n + (self.fonts && self.fonts.indexOf(n) < 0 ? ' (not in the installed list)' : '') : 'Using the font family above.'; useDefault.disabled = !n; self.renderFonts(); });
      const fontG = group('Font', true, field('Font family', fam), search, self.list, h('div', { class: 'fe__row' }, self.cur, useDefault));
      /* sizes in points; empty = derived from the base size */
      const sizeKids = SIZE_ROWS.map((r) => num(r[0], () => { const v = self.app(r[1]); return v === undefined ? null : v; }, (v) => self.setApp(r[1], v), 4, 72, () => rnd(base() * r[2])));
      const ann = num('Annotation', () => { const v = (ctx.record.config.options || {}).annotateSize; return v === undefined ? null : v; }, (v) => ctx.set({ config: { options: { annotateSize: v } } }), 4, 48, () => rnd(base() * 0.8));
      reg(() => { ann.hidden = ctx.record.config.plotType !== 'heatmap'; });   // only heatmap cell values have their own size
      const sizeG = group('Sizes (pt)', true, h('div', { class: 'pd__row' }, sizeKids.slice(0, 2)), h('div', { class: 'pd__row' }, sizeKids.slice(2)), ann);
      /* preset */
      self.presetNote = h('div', { class: 'fe__hint', hidden: true });
      const preset = h('button', { type: 'button', class: 'btn btn--sm', title: 'Small type, open axes, no grid, thin lines', onclick: () => {
        ctx.set((r) => {
          Object.assign(r.config.appearance, PUBLICATION);
          if (r.config.plotType === 'heatmap') { r.config.appearance.despine = false; r.config.options.annotateSize = 6; }
        });
        self.presetNote.textContent = 'Applied: 8 pt text, no grid, open axes, 1 pt lines. Every value can still be changed.'; self.presetNote.hidden = false;
      } }, 'Publication style');
      const help = h('p', { class: 'fe__help' }, 'Captions are not part of the plot editor. Add a caption as a text box on the slide.');
      const more = F.controls.groups({ ctx, reg, group, field });   // Axes, Grid, Size (in), Legend
      const pp = F.plotpanels ? F.plotpanels.groups({ ctx, reg, group, field }) : [];   // contextual: Line options / Scatter options (plotpanels.js)
      self.ghost = h('div', { class: 'pd__status is-warn fe__ghost', role: 'note', hidden: true }, 'The Python script controls this figure. The settings below are kept but do not change the picture. Return to the structured plot in the Python Source tab to use them again.');
      return h('div', { class: 'fe__side' }, self.ghost, h('div', { class: 'fe__preset' }, preset, self.presetNote), titleG, pp, axisG, fontG, sizeG, more, help);
    },
    syncControls() {
      const custom = !this.isAuto(), side = this.ghost && this.ghost.parentNode;
      if (this.ghost) this.ghost.hidden = !custom;
      if (side && side.classList) side.classList.toggle('is-ghost', custom);   // dimmed: kept, but not governing the output
      this.sync_.forEach((fn) => fn());
    },
    /* The Python Source tab ran the script: show its result here (applied = it still matched the draft). */
    adopt(res, applied) {
      if (res && res.ok && applied) this.stale = false;
      if (res && !res.ok) this.log(res.diagnostics, res.stderr ? res.stderr.slice(0, 4000) : '');
      this.sync();
    },
    /* The installed-font list comes from GET /api/figures/runtime (`fonts`); it is read on first use of the search box. */
    loadFonts() {
      const self = this;
      if (self.fontsAsked) return; self.fontsAsked = true;
      F.runtime().then((rt) => {
        if (self.disposed) return;
        self.fonts = rt && Array.isArray(rt.fonts) ? rt.fonts : null;
        self.fontsNote = !rt ? 'The installed font list could not be read.' : !self.fonts || !self.fonts.length ? 'The service reported no installed fonts.' : '';
        self.syncControls();
      }, () => { self.fontsAsked = false; });
    },
    renderFonts() {
      const self = this, list = self.list; if (!list) return;
      const cur = self.app('fontName'), q = String(self.search.value || '').trim().toLowerCase(), all = self.fonts || [];
      list.textContent = '';
      if (!all.length) return list.append(h('div', { class: 'fe__hint' }, self.fontsNote || (self.fontsAsked ? 'Loading installed fonts…' : 'Click the search box to list the fonts installed on this computer.')));
      const hits = q ? all.filter((n) => n.toLowerCase().indexOf(q) >= 0) : all;
      hits.slice(0, FONT_SHOWN).forEach((n) => list.append(h('button', { type: 'button', role: 'option', class: 'fe__font' + (n === cur ? ' is-on' : ''), 'aria-selected': String(n === cur), onclick: () => self.setApp('fontName', n) }, n)));
      if (!hits.length) list.append(h('div', { class: 'fe__hint' }, 'No installed font matches.'));
      else if (hits.length > FONT_SHOWN) list.append(h('div', { class: 'fe__hint' }, (hits.length - FONT_SHOWN) + ' more. Type to narrow the list.'));
    },

    /* Structured figures draw themselves when this tab is shown or edited; a custom script runs only on the button (contract s7). */
    onShow() {
      this.visible = true;
      if (this.isAuto() && this.stale && !this.job && !F.requireBackend()) this.render(); else this.sync();
    },
    show(text, level) { this.status.textContent = text; this.status.className = 'pd__status' + (level ? ' is-' + level : ''); },
    log(diags, extra) {
      const box = this.details.lastChild, lines = (diags || []).filter((d) => d && d.message).map((d) => d.level + ': ' + d.message);
      if (extra) lines.push(extra);
      box.textContent = lines.join('\n'); this.sum.textContent = 'Diagnostics (' + lines.length + ')'; this.details.hidden = !lines.length;
    },
    /* Shows what the draft holds: last good preview (dimmed + badge when it no longer matches), status line, last error. */
    sync() {
      const r = this.ctx.record.render || {}, offline = F.requireBackend(), has = !!r.preview;
      const mismatch = has && (this.stale || r.status !== 'ok' || !!r.error);
      this.img.hidden = !has; if (has && this.img.src !== r.preview) this.img.src = r.preview;
      this.img.classList.toggle('is-dim', mismatch); this.badge.hidden = !mismatch;
      const ds = this.ctx.record.dataset, rows = (ds && ds.rows) || [];
      if (!has) {
        if (!rows.length && this.isAuto()) {
          this.empty.textContent = 'This dataset has no data rows. Add or import data in the Spreadsheet tab.';
          this.empty.hidden = false;
        } else {
          this.empty.textContent = this.isAuto() ? '' : 'Run the script to draw the preview.';
          this.empty.hidden = this.isAuto();
        }
      } else {
        this.empty.hidden = true;
      }
      this.canvas.classList.toggle('is-actual', this.zoom === '100');
      this.zoomBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.zoom === this.zoom)));
      this.busy.hidden = !this.job;
      this.btn.disabled = !!this.job; this.btn.textContent = this.isAuto() ? 'Refresh preview' : 'Run script';
      if (this.job) return this.show('Rendering preview…', 'busy');
      if (offline) { this.log(r.diagnostics); return this.show(offline, 'error'); }
      if (r.error) { const m = typeof r.error === 'string' ? r.error : r.error.message; this.log(r.diagnostics); return this.show((m || 'The figure could not be rendered.') + (r.preview ? ' The last good preview is shown.' : ''), 'error'); }
      this.log(r.diagnostics);
      if (r.preview && r.status === 'ok' && !this.stale) {
        const rt = r.runtime || {}, e = this.ctx.record.export;
        const dec = (r.diagnostics || []).find((d) => d && d.code === 'preview_decimated');
        const decNote = dec ? ' · ' + dec.message : '';
        return this.show('Preview' + (rt.widthPx ? ' ' + rt.widthPx + ' × ' + rt.heightPx + ' px' : '') + ' · export ' + e.wIn + ' × ' + e.hIn + ' in at ' + e.dpi + ' dpi.' + decNote, 'ok');
      }
      if (r.preview) return this.show('Out of date. The last good preview is shown.', 'warn');
      if (!rows.length && this.isAuto()) return this.show('This dataset has no data rows.', 'warn');
      this.show(this.isAuto() ? '' : 'Run the script to draw the preview.');
    },
    render() {
      const self = this, ctx = self.ctx;
      if (F.requireBackend()) return self.sync();
      if (self.job) {
        self.pendingRender = true;
        return;
      }
      self.pendingRender = false;
      const mine = ++self.seq, job = F.render(ctx.record, { purpose: 'preview' });
      self.job = job; self.sync();
      job.then((res) => {
        if (mine !== self.seq || self.disposed) return;
        self.job = null;
        if (res.status === 'cancelled') {
          self.sync();
        } else {
          if (ctx.session.applyRender(res)) self.stale = false;
          else if (res.ok) self.stale = true;   // edited while it was drawing: the next run follows
          self.sync();
          if (!res.ok) { if (!(ctx.record.render && ctx.record.render.error)) self.show(res.message, 'error'); self.log(res.diagnostics, res.stderr ? res.stderr.slice(0, 4000) : ''); }
        }
        if (self.pendingRender && !self.disposed && self.visible) {
          self.pendingRender = false;
          self.render();
        }
      });
    },
    dispose() { this.disposed = true; this.visible = false; if (this.auto) this.auto.cancel(); if (this.job) this.job.cancel(); if (this.offChange) this.offChange(); if (this.offBackend) this.offBackend(); }
  };

  /* ---------- data-source chooser (the data panel replaces this with F.datasource.open) ---------- */
  function openChooser(ctx, anchor) {
    if (F.datasource && typeof F.datasource.open === 'function') return F.datasource.open(ctx, anchor);
    const cur = ((ctx.record.dataset || {}).origin || {}).type, can = F.datasource && typeof F.datasource.choose === 'function';
    const list = h('div', { class: 'menu' }, h('div', { class: 'menu__head' }, 'Data source'));
    SOURCES.forEach((s) => {
      const on = s.id === cur;
      list.appendChild(h('button', { type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(on), class: 'menu__item' + (on ? ' is-checked' : ''), disabled: !on && !can,
        html: `<span class="menu__icon">${on ? ic('check') : ''}</span><span class="menu__label">${U.esc(s.label)}</span>`,
        onclick: () => { U.closeAll(); if (!on && can) F.datasource.choose(s.id, ctx); } }));
    });
    return U.popover(anchor, list, { role: 'menu', focusFirst: true });
  }

  /* ---------- the dialog ---------- */
  F.openEditor = function (o) {
    o = o || {};
    const mode = MODES[o.mode] ? o.mode : 'insert', M = MODES[mode];
    const offline = F.requireBackend();
    if (offline) return U.dialog({ title: M.title, icon: 'plug-zap', width: 460, dismiss: 'backdrop', body: h('p', { class: 'dlg__text' }, offline), buttons: [{ label: 'Close', kind: 'primary' }] });

    const session = openSession(o, mode), draft = session.draft, kinds = RPE.plots.KINDS;
    const listeners = [], insts = {}, panes = {}, btns = {};
    let active = null, saving = false, abortSave = null, forced = false, confirming = false, dlg = null, detached = false;
    const emit = () => listeners.slice().forEach((fn) => { try { fn(draft); } catch (e) { /* a tab must not break the editor */ } });
    const foot = h('span', { class: 'fe__foot', role: 'status' });
    const note = (text, level) => { foot.textContent = text || ''; foot.className = 'fe__foot' + (level ? ' is-' + level : ''); };

    const ctx = {
      mode, session, record: draft, isNew: session.isNew,
      set(spec) { session.set(spec); emit(); },
      touch: emit,
      onChange(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
      changed: () => session.changed(),
      progress: (text) => note(text, 'busy'),
      showTab: (id) => showTab(id),
      tab: (id) => insts[id] || null,
      get dialog() { return dlg; }
    };

    /* header: name | type | data source */
    const nameIn = h('input', { class: 'input fe__name', type: 'text', value: draft.name, maxlength: 200, 'aria-label': 'Figure name' });
    nameIn.addEventListener('input', () => { if (nameIn.value.trim()) ctx.set({ name: nameIn.value.slice(0, 200) }); });
    nameIn.addEventListener('blur', () => { nameIn.value = draft.name; });
    const owner = h('span', { class: 'chip fe__owner', hidden: true }, 'Python controls this figure');
    const typeLbl = h('span', { class: 'fe__type' }), chip = h('button', { type: 'button', class: 'fe__chip', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => openChooser(ctx, chip) });
    const tiles = h('div', { class: 'ptiles', role: 'radiogroup', 'aria-label': 'Plot type' });
    const tileFor = {};
    Object.keys(kinds).forEach((k) => {
      const b = h('button', { type: 'button', role: 'radio', class: 'ptile', html: `${ic(kinds[k].icon)}<span>${U.esc(kinds[k].label)}</span>`, onclick: () => setType(k) });
      tileFor[k] = b; tiles.appendChild(b);
    });
    if (F.a11y) F.a11y.radios(tiles);
    function setType(k) {
      if (draft.config.plotType === k) return;
      const base = F.blank(draft.kind, k);   // the new type's own option and appearance defaults
      let notes = [];
      ctx.set((r) => {
        if (F.plotpanels) notes = F.plotpanels.reconcile(r, k);   // keeps compatible column roles, resets the rest
        r.config.plotType = k; r.config.options = base.config.options;
        Object.keys(base.config.appearance).forEach((a) => { if (r.config.appearance[a] === undefined) r.config.appearance[a] = base.config.appearance[a]; });
      });
      if (F.plotpanels) F.plotpanels.announce(ctx, notes);   // visible message for every reset mapping
    }
    function syncHeader() {
      typeLbl.textContent = kinds[draft.config.plotType] ? kinds[draft.config.plotType].label : draft.config.plotType;
      chip.textContent = 'Data: ' + dataLabel(draft); owner.hidden = draft.sourceMode !== 'custom';
      Object.keys(tileFor).forEach((k) => { const on = k === draft.config.plotType; tileFor[k].classList.toggle('is-on', on); tileFor[k].setAttribute('aria-checked', String(on)); });
    }
    ctx.onChange(syncHeader); syncHeader();
    const strip = F.datasource && typeof F.datasource.status === 'function' ? F.datasource.status(ctx) : null;

    /* tabs: only modules that are registered get a tab; each is mounted on first show and then kept */
    const PANEL_HIDDEN = { python: 1, export: 1 };   // a panel is always a settings-controlled plot; its size comes from the composite
    const visibleTabs = TABS.filter((t) => registry[t.id] && typeof registry[t.id].mount === 'function' && !(mode === 'panel' && PANEL_HIDDEN[t.id]));
    const bar = h('div', { class: 'dtabs fe__tabs', role: 'tablist', 'aria-label': 'Figure editor sections' }), stage = h('div', { class: 'fe__stage' });
    visibleTabs.forEach((t) => {
      btns[t.id] = h('button', { type: 'button', role: 'tab', class: 'dtab', 'aria-selected': 'false', tabindex: '-1', dataset: { id: t.id }, onclick: () => showTab(t.id) }, t.label);
      panes[t.id] = h('div', { class: 'fe__tabpane', role: 'tabpanel', hidden: true }); bar.appendChild(btns[t.id]); stage.appendChild(panes[t.id]);
    });
    if (F.a11y) F.a11y.linkTabs(btns, panes);
    bar.addEventListener('keydown', (e) => {
      const i = visibleTabs.findIndex((t) => t.id === active), d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d || i < 0) return; e.preventDefault(); const t = visibleTabs[(i + d + visibleTabs.length) % visibleTabs.length]; showTab(t.id); btns[t.id].focus();
    });
    function showTab(id) {
      if (!panes[id] || saving) return;
      if (!insts[id]) {
        insts[id] = Object.create(registry[id]);
        try { const el = insts[id].mount(ctx); if (el) panes[id].appendChild(el); RPE.icons.render(panes[id]); }
        catch (e) { panes[id].appendChild(h('div', { class: 'pd__status is-error', role: 'alert' }, 'This section could not be opened: ' + ((e && e.message) || 'unknown error'))); }
      }
      active = id;
      visibleTabs.forEach((t) => { const on = t.id === id; panes[t.id].hidden = !on; btns[t.id].classList.toggle('is-active', on); btns[t.id].setAttribute('aria-selected', String(on)); btns[t.id].tabIndex = on ? 0 : -1; });
      if (typeof insts[id].onShow === 'function') { try { insts[id].onShow(); } catch (e) { note((e && e.message) || 'This section failed to update.', 'error'); } }
    }

    /* closing: Esc, the X and Cancel all end up in dlg.close, which asks first when the draft has edits */
    function finish(v) { forced = true; dlg.close(v); }
    function cancel() {
      if (saving) {
        if (!abortSave || confirming) return;
        if (mode === 'insert' && session.isNew) {   // Insert may finish in the background: the dialog closes, the progress chip stays (Cancel there stops it)
          detached = true; U.toast('Rendering the figure in the background. It is inserted when ready.'); return finish(false);
        }
        confirming = true;                           // Apply / Save Plot: closing means stopping the render, so ask first
        U.confirm({ title: 'Stop rendering?', message: 'The final image is still being drawn. Stopping leaves the plot unchanged and the dialog open.', confirmLabel: 'Stop rendering', cancelLabel: 'Keep rendering', danger: true })
          .then((yes) => { confirming = false; if (yes && abortSave) { abortSave.abort(); note('Cancelling…', 'busy'); } });
        return;
      }
      if (confirming) return;
      if (!session.changed()) return finish(false);
      confirming = true;
      U.confirm({ title: 'Discard changes?', message: 'This plot has edits that are not saved. Discard them?', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true })
        .then((yes) => { confirming = false; if (yes) finish(false); });
    }
    async function save() {
      if (saving) return;
      saving = true; abortSave = new AbortController(); setBusy(true); note('');
      let r;
      try { r = typeof o.onSave === 'function' ? await o.onSave(draft, { mode, isNew: session.isNew, session, commit: session.commit, progress: ctx.progress, signal: abortSave.signal }) : undefined; }
      catch (e) { r = (e && e.message) || 'The plot could not be saved.'; }
      saving = false; abortSave = null; setBusy(false);
      if (detached) {                                // the dialog is gone: report the outcome as a toast
        if (r === false || typeof r === 'string') U.toast(typeof r === 'string' && r ? r : 'The figure was not inserted.', { kind: 'warn', duration: 6000 });
        else U.toast('Figure inserted.', { kind: 'success' });
        return;
      }
      if (r === false || typeof r === 'string') return note(typeof r === 'string' ? r : '', 'error');
      finish(r === undefined ? true : r);
    }
    function setBusy(on) { Object.keys(footBtn).forEach((k) => { footBtn[k].disabled = on && k !== 'cancel'; }); stage.setAttribute('aria-busy', String(on)); }

    const body = h('div', { class: 'fe' },
      h('div', { class: 'fe__head' }, nameIn, h('span', { class: 'fe__sep', 'aria-hidden': 'true' }, '|'), typeLbl, h('span', { class: 'fe__sep', 'aria-hidden': 'true' }, '|'), chip, owner),
      strip,
      h('div', { class: 'pd' }, h('div', { class: 'pd__ctrl' }, h('div', { class: 'pd__h' }, 'Plot type'), tiles), h('div', { class: 'pd__main' }, bar, stage)));

    dlg = U.dialog({
      title: M.title, icon: 'chart-line', width: 1180, class: 'dlg--plot dlg--figure', body, focus: '.ptile.is-on', footerLeft: foot,
      buttons: [{ id: 'cancel', label: 'Cancel', onClick: () => { cancel(); return false; } }, { id: 'save', label: M.action, kind: 'primary', onClick: () => { save(); return false; } }],
      onClose: () => { Object.keys(insts).forEach((id) => { try { if (insts[id].dispose) insts[id].dispose(); } catch (e) { /* ignore */ } }); listeners.length = 0; }
    });
    const footBtn = dlg.buttons, rawClose = dlg.close;
    dlg.close = (v) => { if (forced) return rawClose(v); cancel(); };
    dlg.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !U.hasPopover()) { e.preventDefault(); save(); } });
    if (F.a11y) { F.a11y.keys(dlg, { save: () => { if (!saving) save(); } }); F.a11y.panes(dlg, ['.ptiles', '.fe__tabs', '.fe__tabpane:not([hidden])', '.dlg__foot']); F.a11y.tip(footBtn.save, M.action + ' the figure', 'Ctrl+Enter'); }
    dlg.draft = draft; dlg.ctx = ctx;
    if (F.datasource && typeof F.datasource.attach === 'function') F.datasource.attach(ctx);
    showTab(visibleTabs.some((t) => t.id === o.tab) ? o.tab : (visibleTabs[0] && visibleTabs[0].id));
    return dlg;
  };
})(window.RPE);
