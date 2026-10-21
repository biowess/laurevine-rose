/* composer.js — the multi-panel figure composer (Insert > Multi-panel Figure, Plot Tools > Compose).
   Left: layout tiles + figure settings. Center: the REAL backend render of the composite with a clickable numbered panel overlay
   (slot rectangles come from GET /api/figures/layouts, so frontend and backend never disagree) + panel action bar + panel strip.
   Panel plots are edited in the figure editor (mode 'panel'; structured plots only). Nothing touches the document until Insert / Apply (one undo step).
   Cleared panels and panels a smaller layout would remove go to the parked tray of the dialog session ("Recover" chips; never stored).
   Contract: docs/FIGURES_CONTRACT.md section 4t. Pure helpers on RPE.figures.composer are tested in tests/test_js_checks.js (27). */
(function (RPE) {
  'use strict';
  const F = RPE.figures = RPE.figures || {};
  const Cm = F.composer = {};
  const h = (...a) => RPE.h(...a);
  const LABELS = [['A', 'A  B  C'], ['a', 'a  b  c'], ['none', 'None']];
  const PLACES = [['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']];
  const SPACINGS = [['tight', 'Tight'], ['normal', 'Normal'], ['wide', 'Wide']];
  const ALIGN_H = [['left', 'Left'], ['center', 'Center'], ['right', 'Right']];
  const ALIGN_V = [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']];
  const PANEL_IN = [3.5, 2.6];   // size (in) of a NEW panel: a normal journal-column plot; every panel keeps its own size, the canvas grows
  const FAMILIES = [['sans', 'Sans-serif'], ['serif', 'Serif'], ['mono', 'Monospace']];
  const WEIGHTS = [['bold', 'Bold'], ['normal', 'Regular']];
  const FONT_SCOPES = [['respect', 'Respect local overrides'], ['all', 'Apply to all panels']];
  const LEGENDS = [['none', 'None (each panel keeps its own)'], ['bottom', 'Bottom'], ['right', 'Right']];
  const NO_RENDER = () => ({ status: 'none', hash: null, preview: null, at: null, durationMs: null, error: null, diagnostics: [], runtime: null });
  const clone = (v) => JSON.parse(JSON.stringify(v));
  /* Sorted-key JSON; `top` leaves out the record's own `render` (a preview that arrives by itself is not an edit). */
  const canon = (v, top) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map((x) => canon(x)).join(',') + ']'
    : '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined && !(top && k === 'render')).map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}');
  const kindLabel = (k) => ((RPE.plots && RPE.plots.KINDS && RPE.plots.KINDS[k]) || {}).label || k || 'Plot';

  /* ---------- pure helpers ---------- */
  /* Panel letter as the backend draws it: A..Z, AA.. (lower case for 'a'); '' for 'none'. */
  Cm.letter = function (i, mode) {
    if (mode === 'none') return '';
    let t = '', n = i;
    do { t = String.fromCharCode(65 + (n % 26)) + t; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return mode === 'a' ? t.toLowerCase() : t;
  };
  /* Letters follow the DRAWN panels in slot order; an empty slot has none (contract s4s). */
  Cm.letters = (panels, mode) => { let k = 0; return panels.map((p) => (p.record ? Cm.letter(k++, mode) : '')); };

  /* The real canvas and panel rectangles of the last render: the `composite_layout` diagnostic the script prints
     ({wIn, hIn, slots:[{slot, x, y, w, h}]} as fractions of the canvas, y from the top), or null. */
  Cm.layoutInfo = function (diags) {
    const d = (diags || []).find((x) => x && x.code === 'composite_layout' && x.wIn > 0 && x.hIn > 0 && Array.isArray(x.slots));
    return d || null;
  };

  /* One entry per slot: {slot, n (1-based), letter, state:'empty'|'ok'|'error', kind, name, message}. Errors come from the
     `panel_failed` diagnostics of the last preview render (`panel` = 0-based slot) and only when `showErrors` (render matches settings). */
  Cm.slotStates = function (rec, diags, showErrors) {
    const c = rec.composite, panels = c.panels.slice().sort((a, b) => a.slot - b.slot), bad = {};
    if (showErrors !== false) (diags || []).forEach((d) => { if (d && d.code === 'panel_failed' && Number.isInteger(d.panel) && bad[d.panel] === undefined) bad[d.panel] = d.message || 'This panel could not be drawn.'; });
    const L = Cm.letters(panels, c.labels);
    return panels.map((p, i) => ({ slot: p.slot, n: p.slot + 1, letter: L[i], state: !p.record ? 'empty' : bad[p.slot] !== undefined ? 'error' : 'ok',
      kind: p.record ? p.record.config.plotType : null, name: p.record ? p.record.name : '', message: bad[p.slot] || '' }));
  };

  /* Parked tray (dialog session only, never stored): [{pid, from (slot), record}]. */
  let pkSeq = 0;
  const newId = () => 'fig_' + Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
  Cm.parkEntry = (rec, slot) => ({ pid: 'pk' + (++pkSeq), from: slot, record: rec });
  const panelAt = (comp, slot) => comp.panels.find((p) => p.slot === slot) || null;
  /* Slots (ascending) whose plot a switch to layout `item` would remove. */
  Cm.removedBy = (comp, item) => comp.panels.filter((p) => p.slot >= item.slots.length && p.record).map((p) => p.slot).sort((a, b) => a - b);
  /* Switches `comp` (draft.composite) to layout `item`: panels are carried over by slot index; plots of slots that no longer exist go to
     `parked` when `keep`, else are dropped. Returns {parked:[slots], dropped:[slots]}. */
  Cm.applyLayout = function (comp, item, parked, keep) {
    const n = item.slots.length, gone = Cm.removedBy(comp, item), kept = [];
    for (let i = 0; i < n; i++) kept.push(panelAt(comp, i) || { slot: i, record: null });
    gone.forEach((slot) => { if (keep) parked.push(Cm.parkEntry(panelAt(comp, slot).record, slot)); });
    comp.layout = item.id; comp.panels = kept;
    return keep ? { parked: gone, dropped: [] } : { parked: [], dropped: gone };
  };
  /* Clear panel: the plot moves to `parked` (returns the entry, or null when the slot is empty). */
  Cm.clearPanel = function (comp, slot, parked) {
    const P = panelAt(comp, slot); if (!P || !P.record) return null;
    const e = Cm.parkEntry(P.record, slot); parked.push(e); P.record = null; return e;
  };
  /* Re-place a parked plot into `slot` as a fresh copy; a plot already there is parked in its place (nothing is lost).
     Returns {name, displaced} or null. */
  Cm.placeParked = function (comp, parked, pid, slot) {
    const i = parked.findIndex((e) => e.pid === pid), P = panelAt(comp, slot); if (i < 0 || !P) return null;
    const e = parked.splice(i, 1)[0], old = P.record;
    P.record = Cm.cleanPanel(e.record); if (old) parked.push(Cm.parkEntry(old, slot));
    return { name: e.record.name, displaced: !!old };
  };
  /* Duplicate Plot: a deep copy with a new record id goes into slot `to`; a plot already there is parked. Returns {copy, displaced} or null. */
  Cm.duplicateInto = function (comp, from, to, parked) {
    const A = panelAt(comp, from), B = panelAt(comp, to); if (!A || !A.record || !B || from === to) return null;
    const copy = Cm.cleanPanel(A.record); copy.id = newId();
    const displaced = B.record ? Cm.parkEntry(B.record, to) : null; if (displaced) parked.push(displaced);
    B.record = copy; return { copy, displaced };
  };
  Cm.emptySlots = (panels) => panels.filter((p) => !p.record).map((p) => p.slot).sort((a, b) => a - b);

  /* A panel record as stored: a deep copy whose render state is reset (previews of panels never live in the document and
     must not change the composite's hash). */
  Cm.cleanPanel = function (rec) { const c = clone(rec); c.render = NO_RENDER(); return c; };
  /* The next empty slot after `slot` (wrapping), or -1. */
  Cm.duplicateTarget = function (panels, slot) {
    const by = {}; panels.forEach((p) => { by[p.slot] = p; });
    const n = panels.length;
    for (let i = 1; i < n; i++) { const idx = (slot + i) % n; if (by[idx] && !by[idx].record) return idx; }
    return -1;
  };
  Cm.filled = (rec) => rec.composite.panels.filter((p) => p.record).length;
  /* `bad` = panel_failed diagnostics of the final render; the picture then shows an error note inside those panels. */
  Cm.failedSlots = (diags) => [...new Set((diags || []).filter((d) => d && d.code === 'panel_failed' && Number.isInteger(d.panel)).map((d) => d.panel))].sort((a, b) => a - b);
  Cm.altText = (rec, bad) => {
    const n = Cm.filled(rec), f = bad || [];
    return `Multi-panel figure: ${rec.name} (${n} plot${n === 1 ? '' : 's'}).` + (f.length ? ` Panel${f.length > 1 ? 's' : ''} ${f.map((i) => i + 1).join(', ')} could not be drawn; an error note is shown there.` : '');
  };
  /* Why a shared legend is not drawn: the `legend_not_shared` diagnostic of the last matching preview ('' when sharing works or is off). */
  Cm.legendReason = function (rec, diags, showErrors) {
    if (rec.composite.legend === 'none' || showErrors === false) return '';
    const d = (diags || []).find((x) => x && x.code === 'legend_not_shared'); if (!d) return '';
    const t = String(d.message || 'legend not shared'); return t.charAt(0).toUpperCase() + t.slice(1) + '. Each panel keeps its own legend.';
  };
  Cm.slotName = (st) => `Panel ${st.n}${st.letter ? ' (' + st.letter + ')' : ''}`;
  Cm.slotLabel = (st, selected) => `${Cm.slotName(st)}, ${st.state === 'empty' ? 'empty' : st.state === 'error' ? 'error: ' + st.message : kindLabel(st.kind) + ' plot'}${selected ? ', selected' : ''}`;

  /* Insert / Apply: final render of the CURRENT draft first; on any failure nothing in the document changes. Insert = record + slide
     object in ONE undo step; Apply = record + every object showing it (src, aspect, name, h; x, y, w kept) in ONE undo step.
     `ctx = {session, signal, progress, panelFailed(slot)}`; `obj` = the object being edited. Resolves true | message. */
  Cm.save = async function (draft, ctx, obj) {
    const off = F.requireBackend(); if (off) return off;
    if (!Cm.filled(draft)) return 'Add a plot to at least one panel first.';
    const r = await F.exportpanel.renderFinal(draft, { signal: ctx.signal, progress: ctx.progress });
    if (!r.ok) return r.cancelled ? `Cancelled. Nothing was ${obj ? 'changed' : 'inserted'}.` : r.message;
    const res = r.res, bad = (res.diagnostics || []).filter((d) => d && d.code === 'panel_failed'), failed = Cm.failedSlots(bad);
    if (bad.length) {   // the composite itself rendered; only some panels failed (each shows a dashed red note): the person decides
      const go = ctx.confirmPartial ? await ctx.confirmPartial(failed, !!obj) : false;
      if (ctx.signal && ctx.signal.aborted) return `Cancelled. Nothing was ${obj ? 'changed' : 'inserted'}.`;
      if (!go) {
        if (ctx.panelFailed) ctx.panelFailed(bad[0].panel);
        return `${bad[0].message}${bad.length > 1 ? ` (${bad.length} panels failed)` : ''} Fix or clear the panel, then try again.`;
      }
    }
    const aspect = res.widthPx && res.heightPx ? res.widthPx / res.heightPx : draft.export.wIn / draft.export.hIn;
    const store = RPE.store, find = (doc, id) => doc.slides.reduce((f, s) => f || s.objects.find((x) => x.id === id) || null, null);
    if (obj) {
      if (!find(store.doc, obj.id)) return 'The figure is no longer on a slide, so nothing was changed.';
      const old = F.get(draft.id), prevAuto = old ? Cm.altText(old) : null;   // an automatic alt starts with this text
      ctx.session.commit('Edit figure', (doc) => {
        const target = find(doc, obj.id), all = F.objectsOf(doc, draft.id);
        if (all.indexOf(target) < 0) all.push(target);
        ['layout', 'labels', 'sharedLegend', 'align', 'gap', 'panels', 'font'].forEach((k) => { delete target[k]; });   // fields of the retired client-side composer
        all.forEach((o) => {
          Object.assign(o, { type: 'figure', figureId: draft.id, src: res.preview, aspect, name: draft.name, h: Math.max(1, Math.round(o.w / aspect)) });
          if (o === target) o.alt = o.alt && !(prevAuto && o.alt.indexOf(prevAuto) === 0) ? o.alt : Cm.altText(draft, failed);
        });
      });
      return true;
    }
    const slide = store.activeSlide(); if (!slide) return 'There is no slide to insert the figure into.';
    const pl = F.exportpanel.placement(aspect, res.widthPx / (res.dpi || draft.export.dpi), store.doc.size);
    const nobj = Object.assign({ id: store.uid('o'), type: 'figure', figureId: draft.id, src: res.preview, aspect }, pl, { alt: Cm.altText(draft, failed), name: draft.name });
    ctx.session.commit('Insert figure', (doc) => { doc.slides.find((s) => s.id === slide.id).objects.push(nobj); });
    store.select([nobj.id]); store.setUI({ activeTab: 'plotTools' });
    return true;
  };

  /* ---------- the dialog ---------- */
  Cm.open = function (o) {
    o = o || {};
    const U = RPE.ui, ic = RPE.icons.html, store = RPE.store;
    const obj = o.mode === 'edit' ? o.obj : null, title = obj ? 'Edit multi-panel figure' : 'Compose multi-panel figure';
    const offline = F.requireBackend();
    if (offline) return U.dialog({ title, icon: 'plug-zap', width: 460, dismiss: 'backdrop', body: h('p', { class: 'dlg__text' }, offline), buttons: [{ label: 'Close', kind: 'primary' }] });

    const existing = obj && obj.figureId ? F.get(obj.figureId) : null, legacy = !!obj && !(existing && existing.kind === 'composite');
    let source;
    if (existing && existing.kind === 'composite') source = existing.id;
    else { const b = F.blank('composite', 'line', { name: (obj && obj.name) || undefined }); b.export.wIn = 7; b.export.hIn = 5; source = b; }
    const session = F.cloneForEdit(source), draft = session.draft, parked = [], start = canon(draft, true), dirty = () => canon(draft, true) !== start;
    let table = null, tableErr = '', sel = null, stale = !(draft.render && draft.render.status === 'ok'), job = null, seq = 0, hash = F.hash(draft), visualHash = (F.visualHash ? F.visualHash(draft) : F.hash(draft)), pendingRender = false;
    let saving = false, abortSave = null, forced = false, confirming = false, disposed = false, dlg = null, ro = null, layoutNote = '', asking = false, dragging = null;

    /* --- small controls (same markup as the other dialogs) --- */
    const fld = (label, ctl) => h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), ctl);
    const sel_ = (opts, val, on, label) => { const s = h('select', { class: 'select', 'aria-label': label }, opts.map((p) => h('option', { value: p[0], selected: String(p[0]) === String(val) }, p[1]))); s.addEventListener('change', () => on(s.value)); return s; };
    const num = (label, val, lo, hi, on, step) => {
      const i = h('input', { class: 'input', type: 'number', min: lo, max: hi, step: step || 'any', value: val, 'aria-label': label, 'aria-invalid': 'false' });
      i.addEventListener('input', () => { const v = parseFloat(i.value), ok = isFinite(v) && v >= lo && v <= hi; i.setAttribute('aria-invalid', String(!ok)); if (ok) on(v); });
      i.addEventListener('blur', () => { i.setAttribute('aria-invalid', 'false'); i.value = val_(label); });
      return i;
    };
    const val_ = (label) => String(label === 'Offset (pt)' ? draft.composite.labelStyle.offset : label === 'Font size (pt)' ? draft.composite.fontSize : draft.composite.labelStyle.size);
    const set = (spec) => { layoutNote = ''; session.set(spec); touch(); };

    /* --- header + left column --- */
    const nameIn = h('input', { class: 'input fe__name', type: 'text', value: draft.name, maxlength: 200, 'aria-label': 'Figure name' });
    nameIn.addEventListener('input', () => { if (nameIn.value.trim()) set({ name: nameIn.value.slice(0, 200) }); });
    nameIn.addEventListener('blur', () => { nameIn.value = draft.name; });
    const tiles = h('div', { class: 'ltiles cmp__tiles', role: 'radiogroup', 'aria-label': 'Panel layout' }), tileNote = h('div', { class: 'fe__hint cmp__note', role: 'status' });
    if (F.a11y) F.a11y.radios(tiles);
    const comp = () => draft.composite, layoutItem = () => (table || []).find((l) => l.id === comp().layout) || null;
    function buildTiles() {
      tiles.textContent = '';
      if (!table) { tiles.appendChild(h('div', { class: 'fe__hint' }, tableErr || 'Loading layouts…')); if (tableErr) tiles.appendChild(h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: loadLayouts }, 'Retry')); return; }
      table.forEach((L) => {
        const rects = L.slots.map((s) => `<rect x="${s.x * 60 + 1.5}" y="${s.y * 36 + 1.5}" width="${s.w * 60 - 3}" height="${s.h * 36 - 3}" rx="1.5"/><text x="${s.x * 60 + 4}" y="${s.y * 36 + 9}">${s.slot + 1}</text>`).join('');
        tiles.appendChild(h('button', { type: 'button', role: 'radio', class: 'ltile', 'aria-checked': 'false', 'aria-label': 'Layout ' + L.label, dataset: { id: L.id }, onclick: () => chooseLayout(L),
          html: `<svg viewBox="0 0 60 36" aria-hidden="true">${rects}</svg><span>${U.esc(L.label)}</span>` }));
      });
      syncTiles();
    }
    function syncTiles() {
      [].forEach.call(tiles.children, (t) => { if (!t.dataset || !t.dataset.id) return; const on = t.dataset.id === comp().layout; t.classList.toggle('is-on', on); t.setAttribute('aria-checked', String(on)); });
      tileNote.textContent = layoutNote || (table && !layoutItem() ? `The layout "${comp().layout}" is not in the layout list. Choose one of the layouts above.` : '');
    }
    const nm = (a) => a.map((i) => i + 1).join(', ');
    /* Three-way prompt (U.confirm has two answers); resolves 'keep' | 'discard' | 'cancel' (Esc / backdrop = cancel). */
    const askKeep = (slots) => U.dialog({ title: `Keep ${slots.length} panel${slots.length > 1 ? 's' : ''} in the parked tray?`, icon: 'triangle-alert', width: 440, dismiss: 'backdrop', focus: '.btn--primary',
      body: h('p', { class: 'dlg__text' }, `This layout has no panel ${nm(slots)}. Keep moves ${slots.length > 1 ? 'their plots' : 'its plot'} to the parked tray, from where ${slots.length > 1 ? 'they' : 'it'} can be placed into an empty panel again. Discard removes ${slots.length > 1 ? 'them' : 'it'} from this figure.`),
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Discard', kind: 'danger', value: 'discard' }, { label: 'Keep', kind: 'primary', value: 'keep' }] }).done.then((v) => v || 'cancel');
    async function chooseLayout(L) {
      if (L.id === comp().layout || saving || asking) return;
      const gone = Cm.removedBy(comp(), L); let keep = false;
      if (gone.length) {
        asking = true; const ans = await askKeep(gone); asking = false;
        if (ans === 'cancel' || disposed) return;
        keep = ans === 'keep';
      }
      let r = { parked: [], dropped: [] };
      session.set((rec) => { r = Cm.applyLayout(rec.composite, L, parked, keep); });
      if (sel !== null && sel >= L.slots.length) sel = null;
      const many = (r.parked.length || r.dropped.length) > 1;
      layoutNote = r.parked.length ? `The plot${many ? 's' : ''} of panel ${nm(r.parked)} ${many ? 'are' : 'is'} in the parked tray. Recover ${many ? 'them' : 'it'} into an empty panel.`
        : r.dropped.length ? `Removed the plot${many ? 's' : ''} of panel ${nm(r.dropped)}.` : '';
      touch();
    }
    const legendNote = h('div', { class: 'ss__msg is-warn', role: 'status', hidden: true }), listeners = [];
    const xp = F.tabs && F.tabs.export ? Object.create(F.tabs.export) : null;   // the figure editor's Export tab: size, DPI, format, background, Export file…
    const exportEl = xp ? xp.mount({ record: draft, set: (spec) => set(spec), onChange: (fn) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; } }) : h('div', { class: 'fe__hint' }, 'Export is not available.');
    /* size of the selected panel's plot (record.export.wIn / hIn): the panel is drawn at exactly this size */
    const psizeIn = (label, key) => {
      const i = h('input', { class: 'input', type: 'number', min: 0.5, max: 30, step: 0.1, 'aria-label': label, 'aria-invalid': 'false' });
      i.addEventListener('input', () => {
        const v = parseFloat(i.value), ok = isFinite(v) && v >= 0.5 && v <= 30; i.setAttribute('aria-invalid', String(!ok));
        if (!ok || sel === null) return;
        session.set((r) => { const P = r.composite.panels.find((p) => p.slot === sel); if (P && P.record) P.record.export[key] = v; }); layoutNote = ''; touch();
      });
      i.addEventListener('blur', () => { i.setAttribute('aria-invalid', 'false'); syncPsize(); });
      return i;
    };
    const pwIn = psizeIn('Panel width (in)', 'wIn'), phIn = psizeIn('Panel height (in)', 'hIn');
    const psizeTitle = h('div', { class: 'pd__h' }, 'Panel size');
    const psizeBox = h('div', { class: 'cmp__psize', hidden: true }, psizeTitle, h('div', { class: 'pd__row' }, fld('Width (in)', pwIn), fld('Height (in)', phIn)),
      h('div', { class: 'fe__hint' }, 'The size this plot has on its own. It is placed at exactly this size.'));
    function syncPsize() {
      const P = sel === null ? null : draft.composite.panels.find((p) => p.slot === sel), rec = P && P.record;
      psizeBox.hidden = !rec; if (!rec) return;
      psizeTitle.textContent = `Panel ${sel + 1} size`;
      [[pwIn, rec.export.wIn], [phIn, rec.export.hIn]].forEach((p) => { if (document.activeElement !== p[0]) p[0].value = String(Math.round(p[1] * 100) / 100); });
    }
    const left = h('div', { class: 'pd__ctrl cmp__ctrl' },
      h('div', { class: 'pd__h' }, 'Layout'), tiles, tileNote, psizeBox,
      h('div', { class: 'pd__h' }, 'Panel labels'),
      h('div', { class: 'pd__row' }, fld('Letters', sel_(LABELS, comp().labels, (v) => set({ composite: { labels: v } }), 'Panel letters')), fld('Position', sel_(PLACES, comp().labelStyle.placement, (v) => set({ composite: { labelStyle: { placement: v } } }), 'Label position'))),
      h('div', { class: 'pd__row' }, fld('Label font', sel_(FAMILIES, comp().labelStyle.family, (v) => set({ composite: { labelStyle: { family: v } } }), 'Label font')), fld('Weight', sel_(WEIGHTS, comp().labelStyle.weight, (v) => set({ composite: { labelStyle: { weight: v } } }), 'Label weight'))),
      h('div', { class: 'pd__row' }, fld('Label size (pt)', num('Label size (pt)', comp().labelStyle.size, 4, 48, (v) => set({ composite: { labelStyle: { size: v } } }))), fld('Offset (pt)', num('Offset (pt)', comp().labelStyle.offset, -100, 100, (v) => set({ composite: { labelStyle: { offset: v } } })))),
      h('div', { class: 'pd__h' }, 'Fonts'),
      h('div', { class: 'pd__row' }, fld('Font size (pt)', num('Font size (pt)', comp().fontSize, 4, 48, (v) => set({ composite: { fontSize: v } }))), fld('Font size applies to', sel_(FONT_SCOPES, comp().fontApplyAll ? 'all' : 'respect', (v) => set({ composite: { fontApplyAll: v === 'all' } }), 'Font size scope'))),
      h('div', { class: 'fe__hint' }, 'Respect local overrides keeps the fonts a panel plot sets itself; Apply to all panels replaces its sizes.'),
      h('div', { class: 'pd__h' }, 'Figure'),
      h('div', { class: 'pd__row' }, fld('Gap between panels', sel_(SPACINGS, comp().spacing, (v) => set({ composite: { spacing: v } }), 'Spacing')), fld('Shared legend', sel_(LEGENDS, comp().legend, (v) => set({ composite: { legend: v } }), 'Shared legend'))),
      h('div', { class: 'pd__row' }, fld('Align panels', sel_(ALIGN_H, comp().alignH || 'center', (v) => set({ composite: { alignH: v } }), 'Align panels horizontally')), fld('Vertically', sel_(ALIGN_V, comp().alignV || 'top', (v) => set({ composite: { alignV: v } }), 'Align panels vertically'))),
      h('div', { class: 'fe__hint' }, 'Every panel keeps its own size, fonts and whitespace: nothing is shrunk. The canvas grows to hold the panels; a smaller panel sits in its row / column at the alignment above and is never stretched.'),
      legendNote,
      h('div', { class: 'pd__h' }, 'Size and export'), exportEl,
      h('div', { class: 'fe__hint' }, 'Width and height are the MINIMUM canvas: it grows when the panels need more room. The size of the last preview is shown under it.'),
      h('div', { class: 'fe__hint' }, 'The picture is drawn by the Python service from your panel plots. The slide gets a PNG picture: its text is part of the image and is not editable text there. Export… as PDF keeps text and lines as vectors; it does not change the slide.'));

    /* --- center: preview + overlay --- */
    const img = h('img', { class: 'fe__img cmp__img', alt: 'Composite figure preview', hidden: true });
    const overlay = h('div', { class: 'cmp__overlay', role: 'group', 'aria-label': 'Panels' });
    const badge = h('span', { class: 'fe__badge', role: 'status', hidden: true }, 'Does not match current settings');
    const frame = h('div', { class: 'cmp__frame' }, img, overlay, badge), stage = h('div', { class: 'cmp__stage' }, frame);
    const status = h('div', { class: 'pd__status', role: 'status' }), busy = h('span', { class: 'chip fe__busy', hidden: true }, h('span', { class: 'fe__spin', 'aria-hidden': 'true' }), 'Rendering');
    const refreshBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => render() }, 'Refresh preview');
    const dsum = h('summary', null, 'Diagnostics'), details = h('details', { class: 'fe__details', hidden: true }, dsum, h('div', { class: 'fe__log' }));
    const foot = h('span', { class: 'fe__foot', role: 'status' });
    const note = (text, level) => { foot.textContent = text || ''; foot.className = 'fe__foot' + (level ? ' is-' + level : ''); };
    const liveLayout = () => Cm.layoutInfo(draft.render && draft.render.diagnostics);   // the canvas the shown picture really has
    const aspect = () => { const li = liveLayout(); return Math.max(0.05, li ? li.wIn / li.hIn : draft.export.wIn / draft.export.hIn); };
    function fit() {
      if (!stage.getBoundingClientRect || !frame.style) return;
      const r = stage.getBoundingClientRect(), W = r.width - 16, H = r.height - 16;
      if (!(W > 0 && H > 0)) return;
      const w = Math.floor(Math.min(W, H * aspect())); frame.style.width = w + 'px'; frame.style.height = Math.floor(w / aspect()) + 'px';
    }

    /* --- action bar + panel strip --- */
    const barTitle = h('strong', { class: 'cmp__bartitle' }), barHint = h('span', { class: 'fe__hint' }, 'Select a panel on the preview to create, edit, replace, duplicate or clear its plot.');
    const act = (label, icon, fn) => h('button', { type: 'button', class: 'btn btn--ghost btn--sm', html: ic(icon) + '<span>' + label + '</span>', onclick: () => { if (!saving) fn(); } });
    const bCreate = act('Create Plot', 'plus', () => openPanel(sel, false)), bEdit = act('Edit Plot', 'pencil', () => openPanel(sel, true)), bReplace = act('Replace Plot', 'refresh-cw', () => openPanel(sel, false));
    const bDup = act('Duplicate Plot', 'copy', () => duplicate(sel)), bClear = act('Clear Panel', 'trash-2', () => clearPanel(sel));
    bCreate.classList.replace('btn--ghost', 'btn--primary');
    const bar = h('div', { class: 'cmp__bar', role: 'toolbar', 'aria-label': 'Panel actions' }, barTitle, h('span', { class: 'sp' }), bCreate, bEdit, bReplace, bDup, bClear), strip = h('div', { class: 'cmp__strip', role: 'group', 'aria-label': 'Panel list' }), tray = h('div', { class: 'cmp__tray', role: 'group', 'aria-label': 'Parked plots', hidden: true });
    const states = () => Cm.slotStates(draft, draft.render && draft.render.diagnostics, !stale && !job);
    function select(slot) { sel = slot; syncPanels(); }
    function primary(slot) { sel = slot; syncPanels(); const st = states().find((s) => s.slot === slot); if (st && !saving) openPanel(slot, st.state !== 'empty'); }

    function syncPanels() {
      syncPsize();
      const L = layoutItem(), sts = states(), fa = document.activeElement, fcls = fa && fa.classList && (fa.classList.contains('cmp__card') ? 'cmp__card' : fa.classList.contains('cmp__slot') ? 'cmp__slot' : ''), fslot = fcls ? fa.dataset.slot : null;
      const rov = sts.some((x) => x.slot === sel) ? sel : (sts[0] && sts[0].slot);   // one tab stop in the panel list; arrows move inside it
      overlay.textContent = ''; strip.textContent = '';
      sts.forEach((st) => {
        const on = sel === st.slot, name = Cm.slotName(st), what = st.state === 'empty' ? 'Empty' : st.state === 'error' ? 'Cannot be drawn' : kindLabel(st.kind);
        const li = liveLayout(), geo = (li && li.slots.find((s) => s.slot === st.slot)) || (L && L.slots.find((s) => s.slot === st.slot));   // real rectangles of the last render, else the plain grid
        if (geo) overlay.appendChild(h('button', { type: 'button', class: `cmp__slot is-${st.state}${on ? ' is-sel' : ''}`, tabindex: '-1', dataset: { slot: st.slot }, 'aria-pressed': String(on), 'aria-label': Cm.slotLabel(st, on), title: st.state === 'error' ? st.message : undefined,
          style: { left: geo.x * 100 + '%', top: geo.y * 100 + '%', width: geo.w * 100 + '%', height: geo.h * 100 + '%' }, onclick: () => select(st.slot), ondblclick: () => primary(st.slot), ...dropOn(st.slot) },
          h('span', { class: 'cmp__num', 'aria-hidden': 'true' }, String(st.n)),
          h('span', { class: 'cmp__tag', 'aria-hidden': 'true' }, st.state === 'empty' ? name + ' · Empty' : st.state === 'error' ? st.message : what)));
        strip.appendChild(h('button', { type: 'button', class: `cmp__card is-${st.state}${on ? ' is-sel' : ''}`, tabindex: st.slot === rov ? '0' : '-1', dataset: { slot: st.slot }, 'aria-pressed': String(on), 'aria-label': Cm.slotLabel(st, on), onclick: () => select(st.slot), ondblclick: () => primary(st.slot), ...dropOn(st.slot) },
          h('span', { class: 'cmp__num', 'aria-hidden': 'true' }, String(st.n)), h('span', { class: 'cmp__cardtext' }, h('b', null, st.state === 'empty' ? 'Empty' : what), h('span', null, st.state === 'empty' ? 'No plot yet' : st.state === 'error' ? st.message : st.name))));
      });
      const cur = sts.find((s) => s.slot === sel) || null;
      bar.classList.toggle('is-idle', !cur); barHint.hidden = !!cur;
      [bCreate, bEdit, bReplace, bDup, bClear].forEach((b) => { b.hidden = !cur; }); barTitle.hidden = !cur;
      if (cur) {
        const empty = cur.state === 'empty', others = draft.composite.panels.length > 1;
        barTitle.textContent = `${Cm.slotName(cur)} · ${empty ? 'Empty' : kindLabel(cur.kind)}`;
        const gate = (b, off, why) => { b.disabled = off; b.title = off ? why : ''; };
        gate(bCreate, !empty, 'This panel already has a plot. Use Edit Plot or Replace Plot.');
        gate(bEdit, empty, 'This panel is empty. Use Create Plot.'); gate(bReplace, empty, 'This panel is empty. Use Create Plot.'); gate(bClear, empty, 'This panel is already empty.');
        gate(bDup, empty || !others, empty ? 'This panel is empty.' : 'This layout has only one panel.');
      }
      syncTray();
      if (fcls) { const back = (fcls === 'cmp__card' ? strip : overlay).querySelector('[data-slot="' + fslot + '"]'); if (back) back.focus({ preventScroll: true }); }   // the lists are rebuilt on every change: keep keyboard focus
    }
    [[strip, 'cmp__card'], [overlay, 'cmp__slot']].forEach((pr) => pr[0].addEventListener('keydown', (e) => {
      const all = [].slice.call(pr[0].querySelectorAll('.' + pr[1])), i = all.indexOf(document.activeElement); if (i < 0) return;
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (d || e.key === 'Home' || e.key === 'End') { e.preventDefault(); all[e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + d + all.length) % all.length].focus(); if (pr[1] === 'cmp__card') all.forEach((b) => { b.tabIndex = b === document.activeElement ? 0 : -1; }); }
      else if (e.key === 'Enter') { e.preventDefault(); primary(+all[i].dataset.slot); }   // Enter = Create / Edit plot, like a double-click; Space selects
    }));

    /* --- panel actions (all edit the draft only) --- */
    function openPanel(slot, editing) {
      const P = draft.composite.panels.find((p) => p.slot === slot); if (!P) return;
      const base = editing && P.record ? clone(P.record) : F.blank('structured', 'line');
      if (!editing) { base.export.wIn = P.record ? P.record.export.wIn : PANEL_IN[0]; base.export.hIn = P.record ? P.record.export.hIn : PANEL_IN[1]; }   // Replace keeps the panel's size
      F.openEditor({ mode: 'panel', record: base, plotType: base.config.plotType, onSave: (d) => {
        if (d.kind !== 'structured' || d.sourceMode !== 'structured') return 'A panel needs a plot controlled by its settings. Use "Return to structured plot" in the Python tab first.';
        const rec = Cm.cleanPanel(d); session.set((r) => { r.composite.panels.find((p) => p.slot === slot).record = rec; }); sel = slot; touch(); return true;
      } });
    }
    /* Duplicate: one empty panel = copy there; several = ask which (default: the next empty one); none = ask which plot to replace (it is parked). */
    async function duplicate(slot) {
      const P = draft.composite.panels.find((p) => p.slot === slot); if (!P || !P.record) return;
      const empties = Cm.emptySlots(draft.composite.panels), full = !empties.length;
      let tgt = Cm.duplicateTarget(draft.composite.panels, slot);
      if (full || empties.length > 1) {
        const opts = (full ? draft.composite.panels.map((p) => p.slot).filter((i) => i !== slot) : empties), def = full ? opts[0] : tgt;
        const pick = h('select', { class: 'select', 'aria-label': 'Copy into panel' }, opts.map((i) => h('option', { value: i, selected: i === def }, `Panel ${i + 1}${full ? ' (its plot is parked)' : ''}`)));
        asking = true;
        const ok = await U.dialog({ title: 'Duplicate plot', icon: 'copy', width: 400, dismiss: 'backdrop', body: h('div', null, h('p', { class: 'dlg__text' }, full ? `Every panel has a plot. Choose the panel to copy panel ${slot + 1} into; the plot there moves to the parked tray.` : `Copy the plot of panel ${slot + 1} into which empty panel?`), fld('Copy into', pick)),
          buttons: [{ label: 'Cancel', value: false }, { label: 'Duplicate', kind: 'primary', value: true }] }).done;
        asking = false; if (ok !== true || disposed) return;
        tgt = parseInt(pick.value, 10);
      }
      let r = null; session.set((rec) => { r = Cm.duplicateInto(rec.composite, slot, tgt, parked); });
      if (!r) return; sel = tgt;
      note(`Copied the plot of panel ${slot + 1} into panel ${tgt + 1}.` + (r.displaced ? ` The plot there is in the parked tray.` : '')); touch();
    }
    function clearPanel(slot) {
      const P = draft.composite.panels.find((p) => p.slot === slot); if (!P || !P.record) return;
      U.confirm({ title: `Clear panel ${slot + 1}?`, message: 'Its plot moves to the parked tray under the preview. Use Recover there to put it back.', confirmLabel: 'Clear panel', danger: true }).then((yes) => {
        if (!yes || disposed) return; session.set((r) => { Cm.clearPanel(r.composite, slot, parked); }); note(`Panel ${slot + 1} cleared. Its plot is in the parked tray: Recover puts it back.`); touch();
      });
    }

    /* --- parked tray: Recover chips; a chip is placed by click (selected empty panel, else first empty, else the selected panel swaps) or dragged onto any panel --- */
    function place(pid, slot) {
      if (saving) return;
      let r = null; session.set((rec) => { r = Cm.placeParked(rec.composite, parked, pid, slot); });
      if (!r) return; sel = slot;
      note(`Placed "${r.name}" into panel ${slot + 1}.` + (r.displaced ? ' The plot that was there is in the parked tray.' : '')); touch();
    }
    function recover(pid) {
      const empties = Cm.emptySlots(draft.composite.panels), cur = sel !== null && draft.composite.panels.find((p) => p.slot === sel);
      const tgt = cur && !cur.record ? sel : empties.length ? empties[0] : cur ? sel : -1;
      if (tgt < 0) return note('Every panel has a plot. Select the panel to swap with, or drag the plot onto a panel.', 'error');
      place(pid, tgt);
    }
    function dropOn(slot) {
      return {
        ondragover: (e) => { if (dragging && e.preventDefault) { e.preventDefault(); if (e.currentTarget && e.currentTarget.classList) e.currentTarget.classList.add('is-drop'); } },
        ondragleave: (e) => { if (e.currentTarget && e.currentTarget.classList) e.currentTarget.classList.remove('is-drop'); },
        ondrop: (e) => { if (!dragging) return; if (e.preventDefault) e.preventDefault(); const pid = dragging; dragging = null; if (e.currentTarget && e.currentTarget.classList) e.currentTarget.classList.remove('is-drop'); place(pid, slot); }
      };
    }
    function syncTray() {
      tray.textContent = ''; tray.hidden = !parked.length; if (!parked.length) return;
      tray.appendChild(h('span', { class: 'cmp__trayh' }, 'Parked plots'));
      parked.forEach((e) => {
        const nmx = e.record.name, kind = kindLabel(e.record.config.plotType);
        tray.appendChild(h('span', { class: 'cmp__chip', draggable: 'true', title: 'Drag onto a panel, or click Recover', ondragstart: (ev) => { dragging = e.pid; if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', e.pid); } }, ondragend: () => { dragging = null; } },
          h('button', { type: 'button', class: 'cmp__chipbtn', 'aria-label': `Recover ${nmx} (${kind} plot, from panel ${e.from + 1})`, onclick: () => recover(e.pid) }, h('b', null, 'Recover'), h('span', null, `${nmx} · ${kind}`)),
          h('button', { type: 'button', class: 'cmp__chipx', 'aria-label': `Discard parked plot ${nmx}`, title: 'Discard this plot', html: ic('x'), onclick: () => { const i = parked.findIndex((x) => x.pid === e.pid); if (i >= 0) parked.splice(i, 1); note(`Discarded "${nmx}".`); syncTray(); } })));
      });
    }

    /* --- live preview: 350 ms after the last edit; an edit aborts the request in flight; superseded results are dropped --- */
    const auto = F.debounce(() => render(), 350);
    function touch() {
      const vh = (F.visualHash ? F.visualHash(draft) : F.hash(draft));
      const visualMoved = vh !== visualHash;
      visualHash = vh;
      hash = F.hash(draft);
      if (!visualMoved) return syncAll();
      stale = true;
      syncAll();
      auto();
    }
    function render() {
      if (F.requireBackend()) return sync();
      if (job) {
        pendingRender = true;
        return;
      }
      pendingRender = false;
      const mine = ++seq, j = F.render(draft, { purpose: 'preview' }); job = j; syncAll();
      j.then((res) => {
        if (mine !== seq || disposed) return;
        job = null;
        if (res.status === 'cancelled') {
          syncAll();
        } else {
          if (session.applyRender(res)) stale = false; else if (res.ok) stale = true;
          syncAll();
          if (!res.ok) { if (!(draft.render && draft.render.error)) show(res.message, 'error'); log(res.diagnostics, res.stderr ? res.stderr.slice(0, 4000) : ''); }
        }
        if (pendingRender && !disposed) {
          pendingRender = false;
          render();
        }
      });
    }
    function show(text, level) { status.textContent = text; status.className = 'pd__status' + (level ? ' is-' + level : ''); }
    function log(diags, extra) {
      const lines = (diags || []).filter((d) => d && d.message).map((d) => d.level + ': ' + d.message); if (extra) lines.push(extra);
      details.lastChild.textContent = lines.join('\n'); dsum.textContent = 'Diagnostics (' + lines.length + ')'; details.hidden = !lines.length;
    }
    function sync() {
      const r = draft.render || {}, off = F.requireBackend(), has = !!r.preview, mismatch = has && (stale || r.status !== 'ok' || !!r.error);
      img.hidden = !has; if (has && img.src !== r.preview) img.src = r.preview;
      img.classList.toggle('is-dim', mismatch); badge.hidden = !mismatch; busy.hidden = !job; refreshBtn.disabled = !!job;
      if (job) return show('Rendering preview…', 'busy');
      log(r.diagnostics);
      if (off) return show(off, 'error');
      if (r.error) return show((typeof r.error === 'string' ? r.error : r.error.message || 'The figure could not be rendered.') + (has ? ' The last good preview is shown.' : ''), 'error');
      if (has && r.status === 'ok' && !stale) {
        const rt = r.runtime || {}, e = draft.export, li = liveLayout(), bad = states().filter((s) => s.state === 'error').length;
        return show('Preview' + (rt.widthPx ? ' ' + rt.widthPx + ' × ' + rt.heightPx + ' px' : '') + ' · canvas ' + (li ? Math.round(li.wIn * 100) / 100 + ' × ' + Math.round(li.hIn * 100) / 100 : e.wIn + ' × ' + e.hIn) + ' in at ' + e.dpi + ' dpi.' + (bad ? ` ${bad} panel${bad > 1 ? 's' : ''} could not be drawn; they are marked in red.` : ''), bad ? 'warn' : 'ok');
      }
      show(has ? 'Out of date. The last good preview is shown.' : '', has ? 'warn' : '');
    }
    function syncAll() {
      sync(); syncPanels(); syncTiles(); fit();
      const why = Cm.legendReason(draft, draft.render && draft.render.diagnostics, !stale && !job); legendNote.textContent = why; legendNote.hidden = !why;
      listeners.forEach((fn) => fn());
    }
    function loadLayouts() {
      tableErr = ''; table = null; buildTiles();
      RPE.backend.request('figures.layouts').then((res) => {
        if (disposed) return;
        const list = res && res.ok && res.data && res.data.layouts;
        if (Array.isArray(list) && list.length) table = list; else tableErr = (res && res.message) || 'The layout list could not be read from the Python service.';
        buildTiles(); syncAll();
      });
    }

    /* --- closing and saving (as the figure editor: guard on unsaved edits, Cancel aborts a running Insert / Apply) --- */
    function finish(v) { forced = true; dlg.close(v); }
    function cancel() {
      if (saving) { if (abortSave) { abortSave.abort(); note('Cancelling…', 'busy'); } return; }
      if (confirming) return;
      if (!dirty()) return finish(false);
      confirming = true;
      U.confirm({ title: 'Discard changes?', message: 'This figure has edits that are not saved. Discard them?', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true }).then((yes) => { confirming = false; if (yes) finish(false); });
    }
    async function save() {
      if (saving) return;
      saving = true; abortSave = new AbortController(); setBusy(true); note('');
      let r;
      try { r = await Cm.save(draft, { session, signal: abortSave.signal, progress: (t) => note(t, 'busy'), panelFailed: (slot) => { sel = slot; render(); },
        confirmPartial: (slots, editing) => U.confirm({ title: (editing ? 'Apply' : 'Insert') + ' anyway with error note?', message: `Panel${slots.length > 1 ? 's' : ''} ${slots.map((i) => i + 1).join(', ')} could not be drawn. The figure will show an error note in ${slots.length > 1 ? 'those panels' : 'that panel'}.`, confirmLabel: editing ? 'Apply anyway' : 'Insert anyway', cancelLabel: 'Go back' }) }, obj); }
      catch (e) { r = (e && e.message) || 'The figure could not be saved.'; }
      saving = false; abortSave = null; setBusy(false);
      if (r !== true) return note(typeof r === 'string' ? r : '', 'error');
      finish(true);
    }
    function setBusy(on) { Object.keys(foot_).forEach((k) => { foot_[k].disabled = on && k !== 'cancel'; }); [bCreate, bEdit, bReplace, bDup, bClear].forEach((b) => { b.disabled = b.disabled || on; }); if (!on) syncPanels(); }

    const notice = legacy ? h('div', { class: 'pd__status is-warn' }, 'This figure was made with the earlier composer. It opens as a new figure; Apply replaces its picture.') : null;
    const body = h('div', { class: 'cmp' },
      h('div', { class: 'fe__head' }, nameIn, h('span', { class: 'fe__sep', 'aria-hidden': 'true' }, '|'), h('span', { class: 'fe__type' }, 'Multi-panel figure')), notice,
      h('div', { class: 'pd cmp__pd' }, left, h('div', { class: 'pd__main cmp__main' }, stage,
        h('div', { class: 'fe__bar' }, status, busy, refreshBtn), details, h('div', { class: 'cmp__barwrap' }, barHint, bar), strip, tray)));
    dlg = U.dialog({
      title, icon: 'layout-grid', width: 1180, fit: true, class: 'dlg--plot dlg--composer scroll-burgundy', body, focus: '.ltile.is-on', footerLeft: foot,
      buttons: [{ id: 'cancel', label: 'Cancel', onClick: () => { cancel(); return false; } }, { id: 'save', label: obj ? 'Apply' : 'Insert figure', kind: 'primary', onClick: () => { save(); return false; } }],
      onClose: () => { disposed = true; if (xp && xp.dispose) xp.dispose(); auto.cancel(); if (job) job.cancel(); if (ro) ro.disconnect(); }
    });
    const foot_ = dlg.buttons, rawClose = dlg.close;
    dlg.close = (v) => { if (forced) return rawClose(v); cancel(); };
    dlg.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !U.hasPopover()) { e.preventDefault(); save(); } });
    dlg.draft = draft; dlg.session = session;
    if (F.a11y) { F.a11y.keys(dlg, { save: () => { if (!saving) save(); } }); F.a11y.panes(dlg, ['.cmp__tiles', '.cmp__stage', '.cmp__barwrap', '.cmp__strip', '.dlg__foot']); F.a11y.tip(foot_.save, obj ? 'Apply to the figure' : 'Insert the figure in the slide', 'Ctrl+Enter'); }
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(fit); ro.observe(stage); }
    buildTiles(); syncAll(); loadLayouts();
    if (stale) render();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fit);
    return dlg;
  };
})(window.RPE);
