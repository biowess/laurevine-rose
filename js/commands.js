/* commands.js — the command registry and all demo handlers.
   Every control carries data-command="<id>" (+ optional data-args='{"json":1}').
   RPE.commands.run(id, args, source) is the single dispatch point; it emits a "command" event on the bus
   (and a DOM CustomEvent "rpe:command") before running the handler, so backend code can observe or intercept.
   Handlers that need a backend call RPE.backend.request(...) via RPE.ui.pending(...). */
(function (RPE) {
  'use strict';
  const S = RPE.store, ui = S.ui, T = RPE.themes, U = RPE.ui;
  const reg = {};
  const register = (id, def) => { reg[id] = typeof def === 'function' ? { run: def } : def; };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const sel = () => S.selectedObjects();
  const editable = () => (RPE.canvas ? RPE.canvas.editable() : null);
  const TEXT_TYPES = ['text', 'shape', 'table'];
  const targets = () => sel().filter((o) => TEXT_TYPES.includes(o.type));
  const ids = (list) => list.map((o) => o.id);
  const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96];

  /* ---------- enablement conditions referenced by ribbon items via `en` ---------- */
  const when = {
    object: () => sel().length > 0,
    text: () => !!editable() || targets().length > 0,
    shape: () => sel().some((o) => o.type === 'shape'),
    plot: () => sel().some((o) => o.type === 'plot' || o.type === 'figure'),
    table: () => sel().some((o) => o.type === 'table'),
    picture: () => sel().some((o) => o.type === 'image'),
    multi: () => sel().length > 1,
    group: () => sel().some((o) => o.groupId)
  };

  /* Which contextual tab applies to the current selection. */
  function selectionKind() {
    const list = sel(); if (!list.length) return null;
    const kinds = list.map((o) => (o.type === 'figure' ? 'plot' : o.type));
    return kinds.every((k) => k === kinds[0]) ? kinds[0] : 'mixed';
  }

  /* ---------- dispatch ---------- */
  function isEnabled(id, args) {
    const c = reg[id]; if (!c) return false;
    return c.enabled ? !!c.enabled(args || {}) : true;
  }
  /* Why a command is unavailable (user-facing text), or '' — shown as the tooltip of its ribbon button, which then stays focusable. */
  function reason(id, args) { const c = reg[id]; return c && c.reason && !isEnabled(id, args) ? String(c.reason(args || {}) || '') : ''; }
  function isChecked(id, args) { const c = reg[id]; return !!(c && c.checked && c.checked(args || {})); }
  function run(id, args, source) {
    const c = reg[id];
    if (!c) { console.warn('[rpe] unknown command', id); U.toast('That command is not available yet.', { kind: 'warn' }); return; }
    if (!isEnabled(id, args)) return;
    RPE.bus.emit('command', { id, args: args || {}, source: source || 'api' });
    try { return c.run(args || {}, { source }); } catch (err) { console.error('[rpe] command failed:', id, err); U.toast('Something went wrong running that command.', { kind: 'warn' }); }
  }

  /* ---------- helpers ---------- */
  function mod(label, objs, patch, opts) {
    if (!objs.length) return;
    S.mutate(label, () => objs.forEach((o) => Object.assign(o, typeof patch === 'function' ? patch(o) : patch)), Object.assign({ hint: { objects: ids(objs) } }, opts || {}));
  }
  const ensureNormal = () => { if (ui.view !== 'normal') S.setUI({ view: 'normal' }); };
  function place(w, h) {
    const s = S.activeSlide(), n = s.objects.length, off = (n % 6) * 18, d = S.doc.size;
    return { x: Math.round((d.w - w) / 2 + off - 40), y: Math.round((d.h - h) / 2 + off - 20) };
  }
  function addObject(o, label, opts) {
    ensureNormal();
    const s = S.activeSlide(); if (opts && opts.at) { o.x = opts.at.x; o.y = opts.at.y; }
    S.mutate('Insert ' + label, () => { s.objects.push(o); });
    S.select([o.id]);
    if (opts && opts.edit && RPE.canvas) RPE.canvas.startEdit(o.id, { selectAll: true });
    return o;
  }
  const newText = (html, o) => Object.assign({ id: S.uid('o'), type: 'text', role: 'text', x: 0, y: 0, w: 420, h: 64, html, fontSize: 24, align: 'left', lineHeight: 1.2, vAlign: 'top' }, o || {});
  const resolveColor = (c) => { const th = T.theme(S.doc), m = { accent: th.accent, accent2: th.accent2, text: th.text, muted: th.muted, bg: th.bg }; return m[c] || c; };
  const isBold = (o) => (o.bold == null ? o.role === 'title' : o.bold);
  const curSize = (o) => o.fontSize || 18;

  function tableCtx() {
    const cx = (RPE.renderer && RPE.renderer.context) ? RPE.renderer.context(S.doc) : {};
    const slide = S.activeSlide && S.activeSlide();
    const slideBg = (slide && slide.bg) || (cx.th && cx.th.bg) || '#FFFFFF';
    const dark = cx.th && cx.th.dark !== undefined ? cx.th.dark : false;
    return Object.assign({}, cx, { slideBg, dark });
  }

  function cellScope() {
    const list = sel();
    if (list.length !== 1 || list[0].type !== 'table') return null;
    const table = list[0];
    const rows = table.cells ? table.cells.length : 0;
    if (!rows) return null;
    const cols = (table.cells[0] ? table.cells[0].length : 0);
    if (!cols) return null;

    if (ui.cellSel && ui.cellSel.id === table.id) {
      return { table, rect: RPE.tables.range.rect(ui.cellSel, rows, cols) };
    }

    if (RPE.canvas && RPE.canvas.editingCell) {
      const cell = RPE.canvas.editingCell();
      if (cell && cell.dataset && cell.dataset.r !== undefined && cell.dataset.c !== undefined) {
        const r = clamp(+cell.dataset.r, 0, rows - 1);
        const c = clamp(+cell.dataset.c, 0, cols - 1);
        return { table, rect: { r1: r, c1: c, r2: r, c2: c } };
      }
    }

    return { table, rect: { r1: 0, c1: 0, r2: rows - 1, c2: cols - 1 } };
  }

  function ensureCellBlurred() {
    if (RPE.canvas && RPE.canvas.editingCell && RPE.canvas.editingCell()) {
      RPE.canvas.editingCell().blur();
    }
  }

  function cellVal(cs, prop) {
    if (!cs || !RPE.tables) return '';
    const cx = tableCtx();
    let val = null;
    for (let r = cs.rect.r1; r <= cs.rect.r2; r++) {
      for (let c = cs.rect.c1; c <= cs.rect.c2; c++) {
        const resolved = RPE.tables.resolveCell(cs.table, r, c, cx);
        const v = resolved[prop];
        if (val === null) val = v;
        else if (val !== v) return ''; // mixed
      }
    }
    return val !== null ? val : '';
  }

  function syncTableRows(o) {
    if (typeof document === 'undefined' || !o || o.type !== 'table' || !o.cells || !o.cells.length) return;
    if (!RPE.renderer || !RPE.renderer.tableEl) return;
    const cx = (RPE.renderer.context) ? RPE.renderer.context(S.doc) : {};
    const slide = S.activeSlide && S.activeSlide();
    const slideBg = (slide && slide.bg) || (cx.th && cx.th.bg) || '#FFFFFF';
    const tb = RPE.renderer.tableEl(o, cx, { slideBg });
    tb.style.position = 'absolute';
    tb.style.left = '-9999px';
    tb.style.top = '-9999px';
    tb.style.visibility = 'hidden';
    document.body.appendChild(tb);

    const rows = tb.querySelectorAll('tr');
    const geom = RPE.tables ? RPE.tables.geometry(o) : { rowH: [] };
    const curRowH = (o.rowH && o.rowH.length === rows.length) ? o.rowH.slice() : geom.rowH.slice();
    let grew = false;
    let newTotalH = 0;

    for (let i = 0; i < rows.length; i++) {
      const mh = rows[i].getBoundingClientRect().height;
      if (mh > (curRowH[i] || 0) + 0.5) {
        curRowH[i] = Math.round(mh);
        grew = true;
      }
      newTotalH += curRowH[i];
    }
    tb.remove();

    if (grew) {
      o.rowH = curRowH;
      o.h = newTotalH;
    }
  }

  function applyCellFmt(o, rect, patch) {
    if (!o || o.type !== 'table') return;
    if (!o.cellFmt) o.cellFmt = {};
    for (let r = rect.r1; r <= rect.r2; r++) {
      for (let c = rect.c1; c <= rect.c2; c++) {
        const k = `${r},${c}`;
        const cur = Object.assign({}, o.cellFmt[k] || {});
        const p = typeof patch === 'function' ? patch(cur, r, c) : patch;
        for (const prop in p) {
          if (p[prop] === undefined) {
            delete cur[prop];
          } else {
            cur[prop] = p[prop];
          }
        }
        if (Object.keys(cur).length === 0) {
          delete o.cellFmt[k];
        } else {
          o.cellFmt[k] = cur;
        }
      }
    }
    if (Object.keys(o.cellFmt).length === 0) {
      delete o.cellFmt;
    }
    syncTableRows(o);
  }

  /* wrap all text of an object in a styled span (object-level highlight, etc.) */
  function wrapHtml(html, css) {
    const d = document.createElement('div'); d.innerHTML = html || '';
    d.querySelectorAll('span[data-hl]').forEach((sp) => sp.replaceWith(...sp.childNodes));
    if (!css) return d.innerHTML;
    [].slice.call(d.children).forEach((p) => { const sp = document.createElement('span'); sp.dataset.hl = '1'; sp.style.cssText = css; while (p.firstChild) sp.appendChild(p.firstChild); p.appendChild(sp); });
    return d.innerHTML;
  }

  /* ================= application ================= */
  register('app.undo', { run() { S.undo(); }, enabled: () => S.canUndo() });
  register('app.redo', { run() { S.redo(); }, enabled: () => S.canRedo() });
  register('app.search', () => { const i = document.getElementById('cmdSearch'); if (i) { i.focus(); i.select(); } });
  register('app.shortcuts', () => RPE.dialogs.shortcuts());
  register('app.help', () => RPE.dialogs.about());

  /* ================= file ================= */
  register('file.backstage', (a) => S.setUI({ backstage: a.panel || 'new', ribbonPeek: false }));
  register('file.close', () => S.setUI({ backstage: null }));
  register('file.save', async () => {   // a failure is reported (with a download offer) by S.saveLocal
    if (await S.saveLocal()) { U.toast('Saved to this browser.', { kind: 'success' }); RPE.backend.request('presentation.save', { doc: S.serialize() }); }
  });


  register('file.new', (a) => {
    const go = () => { S.replaceDoc(RPE.seed.createDeck({ blank: !a.sample }), 'new'); S.setUI({ backstage: null }); U.toast(a.sample ? 'Sample research deck loaded.' : 'New blank presentation created.'); };
    if (ui.saveState === 'dirty') U.confirm({ title: 'Discard unsaved changes?', message: 'The current presentation has changes that were not saved. Creating a new one will replace it.', confirmLabel: 'Discard and continue', danger: true }).then((ok) => ok && go()); else go();
  });
  register('file.openFile', () => { const i = document.getElementById('fileOpen'); if (i) { i.value = ''; i.click(); } });
  register('file.openLocal', async () => {
    try {
      const saved = await S.loadLocal(); if (!saved) { U.toast('Nothing saved in this browser yet.'); return; }
      const notes = S.replaceDoc(saved.doc, 'saved'); S.setUI({ backstage: null });
      U.toast(['Opened the copy saved in this browser.'].concat(notes).join(' '), notes.length ? { kind: 'warn', duration: 9000 } : {});
    } catch (err) { U.toast('Could not open the saved copy: ' + err.message, { kind: 'warn', duration: 6000 }); }
  });
  register('file.exportJson', () => {
    const blob = new Blob([S.exportJSON()], { type: 'application/json' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = (S.doc.title || 'presentation').replace(/[^\w.-]+/g, '_') + '.rpe.json'; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    U.toast('Project file downloaded (editor state as JSON).', { kind: 'success' });
  });
  register('file.prefs', () => S.setUI({ backstage: 'prefs' }));
  register('file.about', () => S.setUI({ backstage: 'about' }));
  register('file.rename', (a) => { const t = String(a.title || '').trim(); if (t && t !== S.doc.title) S.mutate('Rename presentation', (d) => { d.title = t; }, { hint: { skipCanvas: true, meta: true } }); });

  /* ================= clipboard ================= */
  function copyObjects(cut) {
    const list = sel(); if (!list.length) return false;
    ui.clipboard = { objs: S.clone(list) };
    if (cut) deleteSelection('Cut');
    U.toast(cut ? 'Cut to the editor clipboard.' : 'Copied to the editor clipboard.', { duration: 1800 });
    return true;
  }
  function remapIds(objs) {
    const gmap = {};
    return objs.map((o) => { const c = S.clone(o); c.id = S.uid('o'); if (c.groupId) c.groupId = gmap[c.groupId] = gmap[c.groupId] || S.uid('g'); return c; });
  }
  function pasteObjects(step) {
    if (!ui.clipboard) return false;
    ensureNormal();
    const copies = remapIds(ui.clipboard.objs); copies.forEach((c) => { c.x += step; c.y += step; });
    ui.clipboard.objs.forEach((o) => { o.x += step / 2; o.y += step / 2; });
    const s = S.activeSlide(); S.mutate('Paste', () => { copies.forEach((c) => s.objects.push(c)); });
    S.select(ids(copies)); return true;
  }
  register('clip.copy', { run() { if (editable()) { document.execCommand('copy'); return; } copyObjects(false); }, enabled: when.object });
  register('clip.cut', { run() { if (editable()) { document.execCommand('cut'); return; } copyObjects(true); }, enabled: when.object });
  register('clip.paste', () => {
    if (editable()) { if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then((t) => { RPE.canvas.focusEdit(); document.execCommand('insertText', false, t); }).catch(() => U.toast('Use Ctrl+V to paste into text.')); return; }
    if (pasteObjects(24)) return;
    if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then((t) => { if (t.trim()) { const p = place(520, 64); addObject(newText(`<p>${U.esc(t.trim().split('\n')[0])}</p>`, { x: p.x, y: p.y, w: 520 }), 'text'); } else U.toast('Nothing to paste.'); }).catch(() => U.toast('Nothing to paste. Copy an object first.'));
    else U.toast('Nothing to paste. Copy an object first.');
  });
  register('clip.pastePlain', () => run('clip.paste', {}, 'menu'));
  register('clip.formatPainter', {
    run() {
      const o = sel()[0]; if (!o) return;
      if (ui.painter) { S.setUI({ painter: null }); return; }
      let props = null;
      if (editable() && RPE.canvas && RPE.canvas.captureCharFormat) {
        props = RPE.canvas.captureCharFormat();
      }
      if (!props) {
        const textKeys = ['fontSize', 'font', 'bold', 'italic', 'underline', 'strike', 'color', 'lineHeight', 'spaceAfter', 'vAlign'];
        props = { isText: true };
        textKeys.forEach((k) => { if (o[k] !== undefined) props[k] = o[k]; });
      }
      S.setUI({ painter: props });
      U.toast('Format Painter: click an object to apply the copied formatting (Esc cancels).', { duration: 3000 });
    },
    checked: () => !!ui.painter, enabled: when.object
  });

  /* ================= slides ================= */
  const slideId = (a) => (a && a.id) || ui.activeSlideId;
  /* Home > New Slide: a fresh slide (empty placeholders from the shared catalog, js/layouts.js) after the current one, ONE undo step.
     No layout given (main button / Ctrl+M) = same structure as the current slide, except opening-type slides which give Title and Content. */
  function newSlide(layout, afterId) {
    const idx = S.doc.slides.findIndex((s) => s.id === (afterId || ui.activeSlideId));
    const cur = S.doc.slides[idx], LY = RPE.layouts, cd = LY && cur ? LY.get(cur.layout) : null;
    const lay = layout || (cd && cd.category !== 'Opening' && cur.layout !== 'title' ? cd.id : 'titleContent');
    const s = LY ? LY.newSlide(lay, S.doc) : { id: S.uid('s'), layout: lay, notes: '', objects: T.layoutObjects(lay, S.doc.size) };
    S.mutate('New slide', (d) => { d.slides.splice(idx + 1, 0, s); });
    ensureNormal(); S.setActiveSlide(s.id); return s;
  }
  register('slide.new', (a) => { newSlide(a.layout, a.after); });
  /* Design > Layouts: apply a catalog layout to a slide in ONE undo step. Existing content is re-mapped into matching placeholders
     (RPE.layouts.apply) and never deleted; objects without a matching placeholder stay where they are. */
  register('slide.layout', (a) => {
    const s = S.slide(slideId(a)); if (!s || !a.layout || !RPE.layouts) return;
    let res = null;
    S.mutate('Change layout', () => { res = RPE.layouts.apply(s, a.layout, S.doc); });
    S.select([]);
    if (res && res.kept) U.toast(res.kept + (res.kept === 1 ? ' object was' : ' objects were') + ' kept in place (no matching placeholder).');
  });
  register('slide.duplicate', (a) => {
    const idx = S.doc.slides.findIndex((s) => s.id === slideId(a)); if (idx < 0) return;
    const src = S.doc.slides[idx], copy = S.clone(src); copy.id = S.uid('s'); const gm = {};
    copy.objects.forEach((o) => { o.id = S.uid('o'); if (o.groupId) o.groupId = gm[o.groupId] = gm[o.groupId] || S.uid('g'); });
    S.mutate('Duplicate slide', (d) => { d.slides.splice(idx + 1, 0, copy); });
    S.setActiveSlide(copy.id); U.toast('Slide duplicated.', { duration: 1800 });
  });
  register('slide.delete', {
    run(a) {
      const id = slideId(a), idx = S.doc.slides.findIndex((s) => s.id === id); if (idx < 0) return;
      if (S.doc.slides.length <= 1) { U.toast('A presentation needs at least one slide. Add another slide first.', { kind: 'warn' }); return; }
      const s = S.doc.slides[idx];
      const valuable = s.notes.trim() || s.objects.some((o) => (o.type === 'image' ? !!o.src : ['plot', 'figure', 'table'].includes(o.type)));
      const doIt = () => {
        const next = S.doc.slides[idx + 1] || S.doc.slides[idx - 1];
        S.mutate('Delete slide', (d) => { d.slides.splice(idx, 1); d.comments = d.comments.filter((c) => c.slideId !== id); });
        if (ui.activeSlideId === id) S.setActiveSlide(next.id);
        U.toast(`Slide ${idx + 1} deleted.`, { action: { label: 'Undo', onClick: () => S.undo() }, duration: 5200 });
      };
      if (valuable) U.confirm({ title: `Delete slide ${idx + 1}?`, message: 'This slide contains figures, tables, images or speaker notes. You can undo the deletion right after.', confirmLabel: 'Delete slide', danger: true }).then((ok) => ok && doIt()); else doIt();
    },
    enabled: () => S.doc.slides.length > 0
  });
  function moveSlide(id, to) {
    const from = S.doc.slides.findIndex((s) => s.id === id); if (from < 0) return; to = clamp(to, 0, S.doc.slides.length - 1); if (to === from) return;
    S.mutate('Move slide', (d) => { const [s] = d.slides.splice(from, 1); d.slides.splice(to, 0, s); });
  }
  register('slide.move', (a) => moveSlide(a.id, a.to));
  register('slide.moveUp', (a) => { const i = S.doc.slides.findIndex((s) => s.id === slideId(a)); moveSlide(slideId(a), i - 1); });
  register('slide.moveDown', (a) => { const i = S.doc.slides.findIndex((s) => s.id === slideId(a)); moveSlide(slideId(a), i + 1); });
  register('slide.goto', (a) => { if (S.slide(a.id)) S.setActiveSlide(a.id); });
  register('slide.next', () => { const i = S.activeIndex(); if (i < S.doc.slides.length - 1) S.setActiveSlide(S.doc.slides[i + 1].id); });
  register('slide.prev', () => { const i = S.activeIndex(); if (i > 0) S.setActiveSlide(S.doc.slides[i - 1].id); });

  /* ================= font ================= */
  register('font.family', {
    run(a) {
      if (!a.value) return;
      ensureCellBlurred();
      const cs = cellScope();
      if (cs) {
        S.mutate('Font family', () => {
          applyCellFmt(cs.table, cs.rect, { font: a.value });
        }, { hint: { objects: [cs.table.id] } });
        return;
      }
      if (editable()) {
        if (RPE.canvas.hasRange()) return RPE.canvas.char('fontName', a.value);
        const ed = RPE.canvas.editable();
        if (ed) ed.style.fontFamily = T.cssFont(a.value);
      }
      mod('Font', targets(), { font: a.value });
    },
    enabled: when.text
  });
  function setSize(pt) {
    pt = clamp(Math.round(pt * 2) / 2, 6, 200);
    ensureCellBlurred();
    const cs = cellScope();
    if (cs) {
      S.mutate('Font size', () => {
        applyCellFmt(cs.table, cs.rect, { fontSize: pt });
      }, { hint: { objects: [cs.table.id] } });
      return;
    }
    if (editable() && RPE.canvas.hasRange()) return RPE.canvas.charSize(pt);
    if (editable()) {
      const ed = RPE.canvas.editable();
      if (ed) ed.style.fontSize = pt + 'pt';
    }
    mod('Font size', targets(), { fontSize: pt });
  }
  register('font.size', { run(a) { const v = parseFloat(a.value); if (v > 0) setSize(v); }, enabled: when.text });
  const stepSize = (dir) => {
    ensureCellBlurred();
    const cs = cellScope();
    if (cs) {
      const v = cellVal(cs, 'fontSize');
      const cur = v ? parseFloat(v) : (cs.table.fontSize || 16);
      const list = SIZES; let next;
      if (dir > 0) next = list.find((s) => s > cur + .01) || cur + 8; else next = list.slice().reverse().find((s) => s < cur - .01) || Math.max(6, cur - 2);
      setSize(next);
      return;
    }
    if (editable() && RPE.canvas.hasRange()) {
      RPE.canvas.styleRange((node, { fontSizePt }) => {
        const cur = fontSizePt;
        const list = SIZES;
        let next;
        if (dir > 0) next = list.find((s) => s > cur + .01) || cur + 8;
        else next = list.slice().reverse().find((s) => s < cur - .01) || Math.max(6, cur - 2);
        return { fontSize: next + 'pt' };
      });
      return;
    }
    const cur = editable() ? (RPE.canvas.currentSize ? RPE.canvas.currentSize() : 18) : curSize(targets()[0] || { fontSize: 18 });
    const list = SIZES; let next;
    if (dir > 0) next = list.find((s) => s > cur + .01) || cur + 8; else next = list.slice().reverse().find((s) => s < cur - .01) || Math.max(6, cur - 2);
    setSize(next);
  };
  register('font.grow', { run() { stepSize(1); }, enabled: when.text });
  register('font.shrink', { run() { stepSize(-1); }, enabled: when.text });
  const toggleFmt = (key, label, domCmd, test) => register('font.' + key, {
    run() {
      ensureCellBlurred();
      const cs = cellScope();
      if (cs) {
        const cx = tableCtx();
        let allTrue = true;
        for (let r = cs.rect.r1; r <= cs.rect.r2; r++) {
          for (let c = cs.rect.c1; c <= cs.rect.c2; c++) {
            if (!RPE.tables.resolveCell(cs.table, r, c, cx)[key]) {
              allTrue = false;
              break;
            }
          }
          if (!allTrue) break;
        }
        const on = !allTrue;
        const otherKey = key === 'subscript' ? 'superscript' : (key === 'superscript' ? 'subscript' : null);
        const patch = { [key]: on };
        if (on && otherKey) patch[otherKey] = false;
        S.mutate(label, () => {
          applyCellFmt(cs.table, cs.rect, patch);
        }, { hint: { objects: [cs.table.id] } });
        return;
      }
      if (editable()) return RPE.canvas.char(domCmd, undefined, label);
      const t = targets(), on = !t.every(test);
      const otherKey = key === 'subscript' ? 'superscript' : (key === 'superscript' ? 'subscript' : null);
      const patch = { [key]: on };
      if (on && otherKey) patch[otherKey] = false;
      mod(label, t, patch);
    },
    checked() {
      const cs = cellScope();
      if (cs) {
        const cx = tableCtx();
        for (let r = cs.rect.r1; r <= cs.rect.r2; r++) {
          for (let c = cs.rect.c1; c <= cs.rect.c2; c++) {
            if (!RPE.tables.resolveCell(cs.table, r, c, cx)[key]) return false;
          }
        }
        return true;
      }
      if (editable()) { try { return document.queryCommandState(domCmd); } catch (e) { return false; } }
      const t = targets();
      return t.length > 0 && t.every(test);
    },
    enabled: when.text
  });
  toggleFmt('bold', 'Bold', 'bold', isBold); toggleFmt('italic', 'Italic', 'italic', (o) => !!o.italic);
  toggleFmt('underline', 'Underline', 'underline', (o) => !!o.underline); toggleFmt('strike', 'Strikethrough', 'strikeThrough', (o) => !!o.strike);
  toggleFmt('subscript', 'Subscript', 'subscript', (o) => !!o.subscript);
  toggleFmt('superscript', 'Superscript', 'superscript', (o) => !!o.superscript);
  register('font.color', {
    run(a) {
      const v = a.value === undefined ? ui.lastColors.font : a.value; if (a.value !== undefined && a.value !== null) ui.lastColors.font = a.value;
      ensureCellBlurred();
      const cs = cellScope();
      if (cs) {
        S.mutate('Font color', () => {
          applyCellFmt(cs.table, cs.rect, { color: v });
        }, { hint: { objects: [cs.table.id] } });
        return;
      }
      const colorVal = resolveColor(v) || RPE.themes.theme(S.doc).text;
      if (editable()) {
        if (RPE.canvas.hasRange()) return RPE.canvas.char('foreColor', colorVal);
        const ed = RPE.canvas.editable();
        if (ed) ed.style.color = colorVal;
      }
      mod('Font color', targets(), { color: v });
    }, enabled: when.text
  });
  register('font.highlight', {
    run(a) {
      const v = a.value === undefined ? ui.lastColors.highlight : a.value; if (a.value) ui.lastColors.highlight = a.value;
      const colorVal = v ? resolveColor(v) : null;
      if (editable()) {
        if (RPE.canvas.hasRange()) {
          RPE.canvas.char('hiliteColor', colorVal || 'transparent');
          return;
        }
        const ed = RPE.canvas.editable();
        if (ed) {
          ed.innerHTML = wrapHtml(ed.innerHTML, colorVal ? `background-color:${colorVal}` : '');
          const curObj = S.findObject(ui.editingId);
          if (curObj) {
            curObj.html = ed.innerHTML;
            S.mutate('Highlight', () => { curObj.html = ed.innerHTML; }, { hint: { skipCanvas: true } });
          }
          return;
        }
      }
      mod('Highlight', targets().filter((o) => o.type !== 'table'), (o) => ({ html: wrapHtml(o.html, colorVal ? `background-color:${colorVal}` : '') }));
    }, enabled: when.text
  });

  /* ================= paragraph ================= */
  const textOnly = () => sel().filter((o) => o.type === 'text' || o.type === 'shape');
  register('para.bullets', {
    run() {
      const t = textOnly(), on = !t.every((o) => o.list === 'bullet');
      if (editable()) {
        const ed = RPE.canvas.editable();
        if (ed) {
          ed.dataset.list = on ? 'bullet' : '';
          if (RPE.renderer && RPE.renderer.updateParaMarkers) RPE.renderer.updateParaMarkers(ed);
        }
        const curObj = S.findObject(ui.editingId);
        if (curObj) curObj.list = on ? 'bullet' : null;
        RPE.bus.emit('editsel');
      }
      mod('Bullets', t, { list: on ? 'bullet' : null });
    },
    checked: () => {
      if (editable()) {
        const curObj = S.findObject(ui.editingId);
        if (curObj) return curObj.list === 'bullet';
      }
      const t = textOnly();
      return t.length > 0 && t.every((o) => o.list === 'bullet');
    },
    enabled: () => textOnly().length > 0
  });
  register('para.numbering', {
    run() {
      const t = textOnly(), on = !t.every((o) => o.list === 'number');
      if (editable()) {
        const ed = RPE.canvas.editable();
        if (ed) {
          ed.dataset.list = on ? 'number' : '';
          if (RPE.renderer && RPE.renderer.updateParaMarkers) RPE.renderer.updateParaMarkers(ed);
        }
        const curObj = S.findObject(ui.editingId);
        if (curObj) curObj.list = on ? 'number' : null;
        RPE.bus.emit('editsel');
      }
      mod('Numbering', t, { list: on ? 'number' : null });
    },
    checked: () => {
      if (editable()) {
        const curObj = S.findObject(ui.editingId);
        if (curObj) return curObj.list === 'number';
      }
      const t = textOnly();
      return t.length > 0 && t.every((o) => o.list === 'number');
    },
    enabled: () => textOnly().length > 0
  });
  register('para.indent', {
    run() {
      if (editable()) {
        const curObj = S.findObject(ui.editingId);
        if (curObj) {
          const nextIndent = clamp((curObj.indent || 0) + 1, 0, 4);
          curObj.indent = nextIndent;
          const ed = RPE.canvas.editable();
          if (ed) ed.style.paddingLeft = (nextIndent * 48) + 'px';
        }
      }
      mod('Increase indent', textOnly(), (o) => ({ indent: clamp((o.indent || 0) + 1, 0, 4) }));
    },
    enabled: () => textOnly().length > 0
  });
  register('para.outdent', {
    run() {
      if (editable()) {
        const curObj = S.findObject(ui.editingId);
        if (curObj) {
          const nextIndent = clamp((curObj.indent || 0) - 1, 0, 4);
          curObj.indent = nextIndent;
          const ed = RPE.canvas.editable();
          if (ed) ed.style.paddingLeft = (nextIndent * 48) + 'px';
        }
      }
      mod('Decrease indent', textOnly(), (o) => ({ indent: clamp((o.indent || 0) - 1, 0, 4) }));
    },
    enabled: () => textOnly().length > 0
  });
  register('para.align', {
    run(a) {
      ensureCellBlurred();
      const cs = cellScope();
      if (cs) {
        S.mutate('Align', () => {
          applyCellFmt(cs.table, cs.rect, { align: a.value });
        }, { hint: { objects: [cs.table.id] } });
        return;
      }
      if (editable()) {
        const ed = RPE.canvas.editable();
        if (ed) {
          const cmd = { left: 'justifyLeft', center: 'justifyCenter', right: 'justifyRight', justify: 'justifyFull' }[a.value];
          if (cmd) {
            RPE.canvas.focusEdit();
            try {
              document.execCommand('styleWithCSS', false, true);
              document.execCommand(cmd, false, null);
            } catch (e) { /* ignore */ }
            /* execCommand fires 'input' → onInput() persists html automatically */
          }
          RPE.bus.emit('editsel');
        }
        return;
      }
      /* Not editing: set box-level align and strip per-paragraph overrides so all
         paragraphs follow the new object default cleanly. */
      mod('Align', targets(), (o) => {
        let html = o.html || '';
        if (html) {
          const d = document.createElement('div');
          d.innerHTML = html;
          d.querySelectorAll('p').forEach((p) => {
            p.style.textAlign = '';
            if (!p.getAttribute('style') || !p.getAttribute('style').trim()) p.removeAttribute('style');
            p.removeAttribute('align');
          });
          html = d.innerHTML;
        }
        return { align: a.value, html };
      });
    },
    checked: (a) => {
      const cs = cellScope();
      if (cs) {
        const cx = tableCtx();
        for (let r = cs.rect.r1; r <= cs.rect.r2; r++) {
          for (let c = cs.rect.c1; c <= cs.rect.c2; c++) {
            if (RPE.tables.resolveCell(cs.table, r, c, cx).align !== a.value) return false;
          }
        }
        return true;
      }
      if (editable()) {
        /* Reflect the paragraph under the caret, not the stale object-level o.align */
        const s = window.getSelection();
        const anchorNode = s && s.rangeCount ? s.getRangeAt(0).startContainer : null;
        const el = anchorNode ? (anchorNode.nodeType === 3 ? anchorNode.parentElement : anchorNode) : null;
        const p = el ? el.closest('p') : null;
        if (p) {
          const computed = window.getComputedStyle(p).textAlign;
          const norm = computed.startsWith('justify') ? 'justify' : computed;
          return norm === a.value;
        }
        return false;
      }
      const t = targets();
      return t.length > 0 && t.every((o) => (o.align || 'left') === a.value);
    },
    enabled: when.text
  });
  register('para.lineSpacing', {
    run(a) {
      mod('Line spacing', textOnly(), { lineHeight: a.value });
      /* Immediately reflect on the canvas host element while editing so the main
         preview updates without requiring the user to click outside the text box.
         refreshObject() bails early when ui.editingId === id, so we patch the style here. */
      if (editable()) {
        const ed = RPE.canvas.editable();
        const host = ed && ed.closest && ed.closest('.obj');
        if (host) host.style.lineHeight = String((a.value || 1.2) * 1.2);
      }
    },
    checked: (a) => { const t = textOnly(); return t.length > 0 && t.every((o) => (o.lineHeight || 1.2) === a.value); },
    enabled: () => textOnly().length > 0
  });
  register('para.spaceAfter', {
    run(a) {
      mod('Paragraph spacing', textOnly(), { spaceAfter: a.value });
      /* Same immediate-update pattern for space-after (applied to the .obj__text element). */
      if (editable()) {
        const ed = RPE.canvas.editable();
        if (ed) ed.style.setProperty('--para-gap', (a.value || 0) + 'pt');
      }
    },
    enabled: () => textOnly().length > 0
  });
  register('text.valign', {
    run(a) {
      ensureCellBlurred();
      const cs = cellScope();
      if (cs) {
        S.mutate('Vertical align', () => {
          applyCellFmt(cs.table, cs.rect, { vAlign: a.value });
        }, { hint: { objects: [cs.table.id] } });
        return;
      }
      mod('Vertical alignment', textOnly(), { vAlign: a.value });
    },
    checked: (a) => {
      const cs = cellScope();
      if (cs) {
        const cx = tableCtx();
        for (let r = cs.rect.r1; r <= cs.rect.r2; r++) {
          for (let c = cs.rect.c1; c <= cs.rect.c2; c++) {
            if (RPE.tables.resolveCell(cs.table, r, c, cx).vAlign !== a.value) return false;
          }
        }
        return true;
      }
      const t = textOnly();
      return t.length > 0 && t.every((o) => (o.vAlign || 'top') === a.value);
    },
    enabled: () => textOnly().length > 0 || !!cellScope()
  });
  register('text.edit', { run() { const o = sel()[0]; if (o && RPE.canvas) RPE.canvas.startEdit(o.id); }, enabled: () => sel().length === 1 && ['text', 'shape'].includes(sel()[0].type) });

  /* ================= drawing & arrange ================= */
  const SHAPE_DIMS = { rect: [220, 140], rounded: [220, 140], ellipse: [200, 140], triangle: [180, 150], diamond: [190, 150], arrow: [220, 80], arrow2: [260, 80], line: [260, 24], callout: [260, 140], callout2: [220, 140], brace: [64, 190], scalebar: [240, 34], pentagon: [200, 150], hexagon: [200, 150], octagon: [200, 150], chevron: [220, 100], cross: [150, 150], star4: [150, 150], star5: [160, 160], star6: [160, 160], parallelogram: [220, 120], trapezoid: [220, 120], ribbon: [220, 120] };
  register('shape.insert', (a) => {
    const kind = a.shape || 'rect';
    ensureNormal();
    if (RPE.canvas && RPE.canvas.beginDrawShape) {
      // Enter draw-to-create mode: user drags to define the shape bounds
      RPE.canvas.beginDrawShape(kind);
    } else {
      // Fallback: place at center (no canvas context)
      if (kind === 'line') {
        const d = SHAPE_DIMS.line || [260, 0];
        const p = place(d[0], d[1]);
        const o = (RPE.shapes && RPE.shapes.createLine)
          ? RPE.shapes.createLine(p.x, p.y, p.x + d[0], p.y + d[1])
          : { id: S.uid('o'), type: 'shape', shape: 'line', x: p.x, y: p.y, w: d[0], h: d[1], x1: p.x, y1: p.y, x2: p.x + d[0], y2: p.y + d[1], stroke: 'accent', strokeWidth: 3 };
        addObject(o, 'line');
        return;
      }
      const d = SHAPE_DIMS[kind] || [200, 140], p = place(d[0], d[1]), strokeOnly = ['line', 'brace', 'scalebar'].includes(kind);
      const o = { id: S.uid('o'), type: 'shape', shape: kind, x: p.x, y: p.y, w: d[0], h: d[1], fill: strokeOnly ? null : 'accent', stroke: 'accent', strokeWidth: strokeOnly ? 3 : 2, html: '', fontSize: 18, align: 'center', vAlign: 'middle', color: strokeOnly ? null : '#FFFFFF', lineHeight: 1.2, adj: 0.5 };
      addObject(o, (U.SHAPES.find((s) => s.id === kind) || { label: 'shape' }).label.toLowerCase());
    }
  });
  register('shape.change', { run(a) { mod('Change shape', sel().filter((o) => o.type === 'shape'), { shape: a.shape }); }, enabled: when.shape });
  const fillTargets = () => sel().filter((o) => o.type === 'shape' || o.type === 'text' || o.type === 'table');
  register('shape.fill', {
    run(a) {
      const v = a.value === undefined ? ui.lastColors.fill : a.value;
      if (a.value !== undefined && a.value !== null) ui.lastColors.fill = a.value;
      ensureCellBlurred();
      const cs = cellScope();
      if (cs) {
        S.mutate('Cell fill', () => {
          applyCellFmt(cs.table, cs.rect, { fill: v });
        }, { hint: { objects: [cs.table.id] } });
        return;
      }
      mod('Shape fill', fillTargets(), { fill: v });
    },
    enabled: () => fillTargets().length > 0
  });
  register('shape.outline', {
    run(a) {
      const v = a.value === undefined ? ui.lastColors.outline : a.value; if (a.value) ui.lastColors.outline = a.value;
      mod('Shape outline', sel().filter((o) => ['shape', 'text', 'image'].includes(o.type)), (o) => ({ stroke: v, strokeWidth: v ? (o.strokeWidth || 2) : 0 }));
    }, enabled: () => sel().some((o) => ['shape', 'text', 'image'].includes(o.type))
  });
  register('shape.weight', { run(a) { mod('Outline weight', sel().filter((o) => ['shape', 'text', 'image'].includes(o.type)), { strokeWidth: a.value }); }, enabled: () => sel().length > 0 });

  register('arrange.order', {
    run(a) {
      const s = S.activeSlide(), pick = new Set(ui.selectedIds);
      S.mutate('Arrange', () => {
        let arr = s.objects;
        if (a.op === 'front') arr = arr.filter((o) => !pick.has(o.id)).concat(arr.filter((o) => pick.has(o.id)));
        else if (a.op === 'back') arr = arr.filter((o) => pick.has(o.id)).concat(arr.filter((o) => !pick.has(o.id)));
        else if (a.op === 'forward') { for (let i = arr.length - 2; i >= 0; i--) if (pick.has(arr[i].id) && !pick.has(arr[i + 1].id)) { const t = arr[i]; arr[i] = arr[i + 1]; arr[i + 1] = t; } }
        else { for (let i = 1; i < arr.length; i++) if (pick.has(arr[i].id) && !pick.has(arr[i - 1].id)) { const t = arr[i]; arr[i] = arr[i - 1]; arr[i - 1] = t; } }
        s.objects = arr;
      });
    }, enabled: when.object
  });
  register('arrange.align', {
    run(a) {
      const list = sel(), d = S.doc.size, b = list.length > 1
        ? { l: Math.min(...list.map((o) => o.x)), t: Math.min(...list.map((o) => o.y)), r: Math.max(...list.map((o) => o.x + o.w)), b: Math.max(...list.map((o) => o.y + o.h)) }
        : { l: 0, t: 0, r: d.w, b: d.h };
      mod('Align', list, (o) => ({ left: { x: b.l }, right: { x: b.r - o.w }, center: { x: Math.round((b.l + b.r - o.w) / 2) }, top: { y: b.t }, bottom: { y: b.b - o.h }, middle: { y: Math.round((b.t + b.b - o.h) / 2) } }[a.op]));
    }, enabled: when.object
  });
  register('arrange.distribute', {
    run(a) {
      const list = sel().slice().sort((p, q) => (a.axis === 'x' ? p.x - q.x : p.y - q.y)); if (list.length < 3) { U.toast('Select three or more objects to distribute.'); return; }
      const k = a.axis === 'x' ? 'x' : 'y', sz = a.axis === 'x' ? 'w' : 'h', first = list[0][k], last = list[list.length - 1][k] + list[list.length - 1][sz];
      const total = list.reduce((n, o) => n + o[sz], 0), gap = (last - first - total) / (list.length - 1); let pos = first;
      S.mutate('Distribute', () => list.forEach((o) => { o[k] = Math.round(pos); pos += o[sz] + gap; }), { hint: { objects: ids(list) } });
    }, enabled: when.multi
  });
  register('arrange.group', { run() { const g = S.uid('g'); mod('Group', sel(), { groupId: g }); U.toast('Objects grouped.', { duration: 1500 }); }, enabled: when.multi });
  register('arrange.ungroup', { run() { mod('Ungroup', sel(), { groupId: null }); }, enabled: when.group });
  register('object.delete', { run() { deleteSelection('Delete'); }, enabled: when.object });
  function deleteSelection(label) {
    const s = S.activeSlide(), pick = new Set(ui.selectedIds); if (!pick.size) return;
    S.mutate(label, () => { s.objects = s.objects.filter((o) => !pick.has(o.id)); }); S.setUI({ selectedIds: [], editingId: null });
  }
  register('object.duplicate', { run() { ui.clipboard = ui.clipboard || null; const keep = ui.clipboard; ui.clipboard = { objs: S.clone(sel()) }; pasteObjects(24); ui.clipboard = keep; }, enabled: when.object });
  register('object.size', {
    run(a) { const v = Math.max(12, Math.round(parseFloat(a.value) * 96)); if (!(v > 0)) return; mod('Resize', sel(), { [a.prop]: v }); }, enabled: when.object
  });

  /* ================= editing ================= */
  register('edit.find', () => (RPE.findPanel ? RPE.findPanel.open(false) : RPE.dialogs.find(false)));
  register('edit.replace', () => (RPE.findPanel ? RPE.findPanel.open(true) : RPE.dialogs.find(true)));
  register('edit.select', (a) => {
    ensureNormal(); const s = S.activeSlide();
    S.select(a.mode === 'none' ? [] : s.objects.filter((o) => a.mode === 'all' || (a.mode === 'text' && o.type === 'text') || (a.mode === 'plots' && (o.type === 'plot' || o.type === 'figure'))).map((o) => o.id));
  });

  /* ================= insert ================= */
  register('insert.table', (a) => {
    const rows = clamp(+a.rows || 3, 1, 12), cols = clamp(+a.cols || 3, 1, 8), w = Math.min(1100, cols * 190), h = rows * 52, p = place(w, h);
    const cells = []; for (let r = 0; r < rows; r++) { cells.push([]); for (let c = 0; c < cols; c++) cells[r].push(r === 0 ? 'Column ' + (c + 1) : ''); }
    addObject({ id: S.uid('o'), type: 'table', x: p.x, y: p.y, w, h, headerRow: true, banded: true, fontSize: 18, cells }, 'table');
  });
  register('insert.tableDialog', () => RPE.dialogs.tableSize());
  register('insert.picture', (a) => {
    if (a.source === 'placeholder') { const p = place(480, 300); addObject({ id: S.uid('o'), type: 'image', role: 'figure', x: p.x, y: p.y, w: 480, h: 300, name: 'Image placeholder', alt: '', src: null }, 'image placeholder'); return; }
    const i = document.getElementById('filePicture'); if (i) { i.dataset.mode = 'insert'; i.value = ''; i.click(); }
  });
  register('picture.replace', { run() { const i = document.getElementById('filePicture'); if (i) { i.dataset.mode = 'replace'; i.value = ''; i.click(); } }, enabled: when.picture });
  register('picture.alt', { run() { RPE.dialogs.altText(); }, enabled: () => sel().length === 1 && ['image', 'plot', 'figure'].includes(sel()[0].type) });
  register('picture.fit', { run() { mod('Reset aspect', sel().filter((o) => o.type === 'image'), (o) => ({ h: Math.round(o.w / (o.aspect || 1.6)) })); }, enabled: when.picture });
  register('picture.adjust', { run() { RPE.dialogs.pictureAdjust(); }, enabled: when.picture });
  register('picture.adjustReset', {
    run() {
      mod('Reset adjustments', sel().filter((o) => o.type === 'image'), () => ({ imgAdj: null }));
    },
    enabled: () => sel().some((o) => o.type === 'image' && o.imgAdj && Object.keys(o.imgAdj).some((k) => o.imgAdj[k] != null && o.imgAdj[k] !== 0))
  });
  register('picture.crop', {
    run() {
      const imgs = sel().filter((o) => o.type === 'image' && o.src);
      if (!imgs.length) return;
      if (RPE.canvas && RPE.canvas.beginCrop) RPE.canvas.beginCrop(imgs[0].id);
    },
    enabled: () => sel().some((o) => o.type === 'image' && o.src),
    checked: () => RPE.canvas && RPE.canvas.isCropping && RPE.canvas.isCropping()
  });
  register('insert.link', () => RPE.dialogs.link());
  register('insert.textbox', () => {
    ensureNormal();
    if (RPE.canvas && RPE.canvas.beginDrawShape) {
      RPE.canvas.beginDrawShape('text');
    } else {
      const p = place(420, 64);
      addObject(newText('', { x: p.x, y: p.y, w: 420, h: 64, stroke: null }), 'text box', { edit: true });
    }
  });
  register('insert.symbol', (a) => {
    if (editable()) { RPE.canvas.focusEdit(); document.execCommand('insertText', false, a.char); return; }
    const p = place(120, 64); addObject(newText(`<p>${U.esc(a.char)}</p>`, { x: p.x, y: p.y, w: 120, fontSize: 32 }), 'symbol');
  });
  register('insert.symbolLibrary', () => { RPE.symbolLibrary.open(); });   // modal; inserts at the preserved caret (symbollib.js)
  register('insert.pythonPlot', () => { ensureNormal(); if (RPE.figures && RPE.figures.pyfigure) RPE.figures.pyfigure.open(); else RPE.dialogs.plot({ mode: 'insert' }); });
  register('insert.pgfplots', () => { ensureNormal(); RPE.figures.latex.open(); });
  register('insert.figure', () => { ensureNormal(); RPE.dialogs.figure({ mode: 'insert' }); });
  register('caption.add', {
    run(a) {
      const o = a.id ? S.findObject(a.id) : sel()[0]; if (!o) return;
      const isTable = o.type === 'table', label = isTable ? 'Table' : 'Figure';
      const n = S.doc.slides.reduce((c, sl) => c + sl.objects.filter((x) => x.role === 'caption').length, 0) + 1;
      const cap = newText(`<p><b>${label} ${n}.</b> </p>`, { role: 'caption', x: o.x, y: Math.min(o.y + o.h + 6, S.doc.size.h - 44), w: o.w, h: 38, fontSize: 14 });
      if (a.id) { const sl = S.activeSlide(); S.mutate('Add caption', () => sl.objects.push(cap)); S.select([cap.id]); } else addObject(cap, 'caption');
      if (RPE.canvas) RPE.canvas.startEdit(cap.id, { atEnd: true });
    }, enabled: () => sel().length === 1 && ['plot', 'figure', 'image', 'table'].includes(sel()[0].type)
  });
  // Row/column add/remove act on the selected cell range (n = rows/cols spanned); with no range they keep the legacy
  // behaviour (append / remove last). Added rows/cols go after the range; the selection moves onto them.
  function tableOp(label, axis) {
    return function (a) {
      const t = sel().find((o) => o.type === 'table'); if (!t || !t.cells.length) return;
      ensureCellBlurred();
      const T = RPE.tables, rows = t.cells.length, cols = t.cells[0] ? t.cells[0].length : 0;
      const hasSel = ui.cellSel && ui.cellSel.id === t.id;
      const rc = hasSel ? T.range.rect(ui.cellSel, rows, cols) : { r1: rows - 1, r2: rows - 1, c1: cols - 1, c2: cols - 1 };
      const lo = axis === 'row' ? rc.r1 : rc.c1, hi = axis === 'row' ? rc.r2 : rc.c2;
      let next = null;
      S.mutate(label, () => {
        if (a.op === 'add') {
          const n = hi - lo + 1;
          const at = axis === 'row' ? T.ops.insertRows(t, hi, n) : T.ops.insertCols(t, hi, n);
          if (hasSel) next = axis === 'row' ? { r1: at, r2: at + n - 1, c1: rc.c1, c2: rc.c2 } : { r1: rc.r1, r2: rc.r2, c1: at, c2: at + n - 1 };
        } else {
          const n = axis === 'row' ? T.ops.removeRows(t, lo, hi) : T.ops.removeCols(t, lo, hi);
          if (hasSel && n) { const k = Math.min(lo, (axis === 'row' ? rows : cols) - n - 1); next = axis === 'row' ? { r1: k, r2: k, c1: rc.c1, c2: rc.c2 } : { r1: rc.r1, r2: rc.r2, c1: k, c2: k }; }
        }
      }, { hint: { objects: [t.id] } });
      if (hasSel && next) {
        const nr = t.cells.length, nc = t.cells[0] ? t.cells[0].length : 0;
        S.setUI({ cellSel: T.range.make(t.id, { r: next.r1, c: next.c1 }, { r: next.r2, c: next.c2 }, nr, nc) });
      } else if (hasSel) S.setUI({ cellSel: null });
    };
  }
  register('table.row', { run: tableOp('Table rows', 'row'), enabled: when.table });
  register('table.col', { run: tableOp('Table columns', 'col'), enabled: when.table });
  register('table.style', { run(a) { const t = sel().filter((o) => o.type === 'table'); mod('Table style', t, (o) => ({ [a.key]: !o[a.key] })); }, checked: (a) => sel().some((o) => o.type === 'table' && o[a.key]), enabled: when.table });
  register('table.clearFormat', {
    run() {
      const cs = cellScope(); if (!cs) return;
      S.mutate('Clear cell format', () => {
        const o = cs.table;
        if (!o.cellFmt) return;
        for (let r = cs.rect.r1; r <= cs.rect.r2; r++) {
          for (let c = cs.rect.c1; c <= cs.rect.c2; c++) {
            delete o.cellFmt[`${r},${c}`];
          }
        }
        if (Object.keys(o.cellFmt).length === 0) delete o.cellFmt;
      }, { hint: { objects: [cs.table.id] } });
    },
    enabled: when.table
  });
  register('table.border', {
    run(a) {
      const t = sel().filter((o) => o.type === 'table');
      mod('Table border', t, (o) => {
        const cur = o.tableBorder ? Object.assign({}, o.tableBorder) : {};
        if (a.width !== undefined) cur.width = a.width;
        const c = a.color !== undefined ? a.color : a.value;
        if (c !== undefined) cur.color = c;
        return { tableBorder: cur };
      });
    },
    enabled: when.table
  });

  /* ================= design ================= */
  register('design.template', (a) => {
    if (a && a.id) {
      if (RPE.templates && RPE.templates.loadTemplateSafe) {
        RPE.templates.loadTemplateSafe(a.id);
      }
    } else {
      if (RPE.templates && RPE.templates.openGallery) {
        RPE.templates.openGallery();
      }
    }
  });
  register('design.templatesGallery', (a, meta) => {
    if (RPE.templates && RPE.templates.openGallery) {
      RPE.templates.openGallery(meta && meta.anchor);
    }
  });
  register('design.theme', (a) => { const th = T.THEMES.find((x) => x.id === a.id); if (!th) return; S.mutate('Apply theme', (d) => { d.themeId = th.id; d.typeId = th.type; delete d.typography; delete d.palette; d.paletteId = (RPE.palettes && RPE.palettes.get(th.id)) ? th.id : th.palette; }); }); 
  register('design.typography', (a) => { if (!RPE.typography || !RPE.typography.get(a.id)) return; S.mutate('Typography', (d) => { RPE.typography.apply(d, a.id); }); });   // typography only, one undo step
  register('design.palette', (a) => { if (!RPE.palettes || !RPE.palettes.get(a.id)) return; S.mutate('Colors', (d) => { RPE.palettes.apply(d, a.id); }); });   // colours only, by role, one undo step
  function resize(w, h, label) {
    const o = S.doc.size, fx = w / o.w, fy = h / o.h;
    S.mutate(label, (d) => { d.size = { w, h }; d.slides.forEach((s) => s.objects.forEach((x) => { x.x = Math.round(x.x * fx); x.w = Math.round(x.w * fx); x.y = Math.round(x.y * fy); x.h = Math.round(x.h * fy); })); });
    U.toast(`Slide size changed to ${w} × ${h}. Objects were rescaled proportionally.`, { duration: 2600 });
  }
  register('design.slideSize', (a) => { const s = T.SIZES.find((x) => x.id === a.id); if (!s) return; const portrait = S.doc.size.w < S.doc.size.h; resize(portrait ? s.h : s.w, portrait ? s.w : s.h, 'Slide size'); });
  register('design.orientation', (a) => { const d = S.doc.size, want = a.value === 'portrait'; if ((d.w < d.h) === want) return; resize(d.h, d.w, 'Slide orientation'); });
  register('design.pageSetup', () => RPE.dialogs.pageSetup());
  register('design.setSize', (a) => resize(clamp(Math.round(a.w), 480, 3000), clamp(Math.round(a.h), 360, 3000), 'Page setup'));

  /* ================= figures ================= */
  register('fig.create', (a) => { ensureNormal(); RPE.dialogs.plot({ mode: 'insert', kind: a && a.kind }); });   // no kind = the editor opens directly (type tiles inside)
  register('fig.pythonSource', () => {
    ensureNormal(); const p = sel().find((o) => o.type === 'plot');
    if (pyPlot(p)) RPE.figures.pyfigure.open({ obj: p }); else if (latexPlot(p)) RPE.figures.latex.open({ obj: p }); else if (p && p.engine === 'pgfplots') RPE.dialogs.pgf({ mode: 'edit', obj: p }); else if (p) RPE.dialogs.plot({ mode: 'edit', obj: p, tab: 'source' }); else RPE.dialogs.plot({ mode: 'insert', tab: 'source' });
  });
  register('fig.pgfSource', () => { ensureNormal(); const p = sel().find((o) => o.type === 'plot'); RPE.dialogs.pgf(p ? { mode: 'edit', obj: p } : { mode: 'insert' }); });
  register('fig.compose', () => { ensureNormal(); const f = sel().find((o) => o.type === 'figure'); RPE.dialogs.figure(f ? { mode: 'edit', obj: f } : { mode: 'insert' }); });
  /* Plot / figure commands that need the local service explain themselves instead of failing (tooltip via commands.reason). */
  const OFFLINE = 'Needs the local Python service, which is offline. Start it with python3 run.py.';
  const needPlot = () => (when.plot() ? '' : 'Select a plot or figure on the slide first.');
  const needBackend = () => needPlot() || (RPE.backend && !RPE.backend.connected ? OFFLINE : '');
  const recOf = (o) => { const F = RPE.figures; return o && o.figureId && F && F.get(o.figureId) || null; };
  const exportWhy = (fmt) => {
    const o = sel().find((x) => x.type === 'plot' || x.type === 'figure'), w = needBackend(); if (w) return w;
    if (!['png', 'pdf', 'py', 'tex'].includes(fmt)) return 'Figures can be exported as PNG, PDF, Python source or LaTeX source.';
    const rec = recOf(o); if (!rec) return 'This object is not linked to an editable figure (for example an imported picture), so it cannot be exported.';
    if (fmt === 'py' && rec.kind === 'latex') return 'This is a LaTeX figure. Use LaTeX Source to export its .tex file.';
    if (fmt === 'py' && rec.kind === 'composite') return 'Multi-panel figures can be exported as PNG or PDF. They have no single Python script.';
    if (fmt === 'tex' && rec.kind !== 'latex') return 'LaTeX source exists only for LaTeX / PGFPlots figures.';
    return '';
  };
  register('fig.export', {
    run(a) {
      const o = sel().find((x) => x.type === 'plot' || x.type === 'figure'), rec = recOf(o), fmt = String(a.format); if (!rec) return;   // export from the figure record, at its own size / dpi
      const big = fmt === 'py' && rec.kind === 'structured' && rec.sourceMode !== 'custom' && rec.dataset && rec.dataset.rows.length > 2000;   // data.csv + script (s4j)
      U.toast('Exporting figure…');
      RPE.backend.request('figures.export', { record: Object.assign({}, rec, { render: { status: 'none' }, originalCsv: null }), format: big ? 'bundle' : fmt, dpi: a.dpi, background: fmt === 'png' || fmt === 'pdf' ? rec.export.background : undefined })
        .then((r) => U.toast(r.ok ? `Saved ${r.filename}.` : (r.message || 'The figure could not be exported.')));
    }, enabled: (a) => !exportWhy(String(a.format)), reason: (a) => exportWhy(String(a.format))
  });
  /* a plot backed by a kind:'python' record reopens in the Python Plot window with its saved script (never run on open) */
  const latexPlot = (o) => { const F = RPE.figures, r = o && o.type === 'plot' && o.figureId && F && F.get(o.figureId); return !!(r && r.kind === 'latex' && F.latex); };
  const pyPlot = (o) => { const F = RPE.figures, r = o && o.type === 'plot' && o.figureId && F && F.get(o.figureId); return !!(r && r.kind === 'python' && F.pyfigure); };
  register('plot.edit', {
    run(a) {
      const o = sel().find((x) => x.type === 'plot' || x.type === 'figure'); if (!o) return;
      if (pyPlot(o) && !a.tab) RPE.figures.pyfigure.open({ obj: o });
      else if (latexPlot(o) && !a.tab) RPE.figures.latex.open({ obj: o });
      else if (o.type === 'figure') RPE.dialogs.figure({ mode: 'edit', obj: o }); else if (o.engine === 'pgfplots') RPE.dialogs.pgf({ mode: 'edit', obj: o }); else RPE.dialogs.plot({ mode: 'edit', obj: o, tab: a.tab });
    }, enabled: () => !needBackend(), reason: needBackend
  });
  const plots = () => sel().filter((o) => o.type === 'plot');
  const figs = () => sel().filter((o) => o.type === 'figure');
  const axesOf = (o) => Object.assign({ grid: true, despine: true, ticksIn: false }, o.axes || {});
  register('plot.axes', {
    run(a) {
      mod('Axes', plots(), (o) => ({ axes: Object.assign(axesOf(o), { [a.op]: !axesOf(o)[a.op] }) }));
      const f = figs(); if (f.length) mod('Axes', f, (o) => ({ panels: (o.panels || []).map((p) => Object.assign({}, p, { axes: Object.assign(axesOf(p), { [a.op]: !axesOf(o.panels[0] || {})[a.op] }) })) }));
    },
    checked: (a) => { const p = plots()[0] || figs().map((f) => (f.panels || [])[0]).filter(Boolean)[0]; return !!p && !!axesOf(p)[a.op]; }, enabled: when.plot
  });
  register('plot.legend', {
    run(a) {
      if (!plots().length) { U.toast('Legends for multi-panel figures are set in the Compose dialog (shared legend).', { duration: 3000 }); return; }
      mod('Legend', plots(), (o) => { const l = Object.assign({ show: true, pos: 'best' }, o.legend || {}); return { legend: a.op === 'toggle' ? Object.assign(l, { show: !l.show }) : Object.assign(l, { pos: a.value, show: true }) }; });
    },
    checked: (a) => { const p = plots()[0]; return !!p && (p.legend ? p.legend.show !== false : true); }, enabled: when.plot
  });
  register('plot.font', { run(a) { mod('Plot font', sel().filter((o) => o.type === 'plot' || o.type === 'figure'), (o) => ({ font: Object.assign({ family: 'sans', size: 12 }, o.font || {}, a.family ? { family: a.family } : {}, a.size ? { size: a.size } : {}) })); }, enabled: when.plot });
  const changeTypeWhy = () => {
    const o = plots()[0]; if (!o) return 'Select a plot on the slide first.';
    const rec = recOf(o); if (!rec) return '';   // an older plot without a figure record changes in place
    if (RPE.backend && !RPE.backend.connected) return OFFLINE;
    if (rec.kind !== 'structured' || rec.sourceMode === 'custom') return 'This figure is controlled by its Python or LaTeX source, so it has no plot type to change. Edit the source instead.';
    return '';
  };
  register('plot.changeType', {
    run(a) {
      const o = plots()[0], rec = recOf(o);
      if (rec) {   // figure-backed: the plot editor does the change (column roles are reconciled there; nothing is applied until Apply)
        RPE.dialogs.plot({ mode: 'edit', obj: o });
        const label = RPE.plots.KINDS[a.kind] && RPE.plots.KINDS[a.kind].label, tile = [].find.call(document.querySelectorAll('.ptiles .ptile'), (b) => b.textContent.trim() === label);
        if (tile) tile.click();
        return;
      }
      mod('Change plot type', plots(), (x) => {
        const prev = RPE.plots.defaultsFor(x.kind, x.dataset), next = RPE.plots.defaultsFor(a.kind);
        return { kind: a.kind, dataset: next.dataset, xLabel: x.xLabel === prev.xLabel ? next.xLabel : x.xLabel, yLabel: x.yLabel === prev.yLabel ? next.yLabel : x.yLabel };
      });
    }, enabled: () => !changeTypeWhy(), reason: changeTypeWhy
  });

  /* ================= present / review / view ================= */
  register('present.start', (a) => RPE.present.start(a.from === 'beginning' ? 0 : S.activeIndex(), { presenter: a.presenter, laser: a.laser }));
  register('present.shortcuts', () => RPE.dialogs.shortcuts('present'));
  register('present.export', async (a) => {
    const fmt = (a.format || 'pptx').toLowerCase();
    if (fmt === 'pptx' || fmt === 'pdf') {
      const label = fmt === 'pdf' ? 'PDF document' : 'PowerPoint presentation';
      // Pre-flight: figures whose record is stale or failed export their last picture, which may not match the settings.
      const figs = S.doc.figures || {}, bad = [];
      S.doc.slides.forEach((sl) => (sl.objects || []).forEach((o) => {
        const r = (o.type === 'plot' || o.type === 'figure') && o.figureId ? figs[o.figureId] : null;
        const st = r && r.render && r.render.status;
        if ((st === 'stale' || st === 'error') && !bad.some((b) => b.id === r.id)) bad.push({ id: r.id, name: r.name || o.name || 'Untitled figure', st });
      }));
      if (bad.length) {
        const list = bad.slice(0, 5).map((b) => `\u201c${b.name}\u201d (${b.st === 'error' ? 'failed' : 'out of date'})`).join(', ') + (bad.length > 5 ? ` and ${bad.length - 5} more` : '');
        const go = await U.confirm({ title: 'Some figures are not up to date', message: `${bad.length === 1 ? 'This figure does' : 'These figures do'} not match the latest settings: ${list}. The export uses the last picture on the slide. Export anyway?`, confirmLabel: 'Export anyway' });
        if (!go) return;
      }
      U.toast(`Generating ${label}...`, { duration: 2500 });
      const res = await RPE.backend.request('presentation.export', { format: fmt, doc: S.serialize() });
      if (res && res.ok) {
        const ws = res.warnings || [];
        U.toast(`Exported "${res.filename}" successfully.`, { kind: 'success', duration: 4000 });
        if (ws.length) U.toast(`Export warning: ${ws.slice(0, 3).map((w) => `slide ${w.slide}: ${w.message}`).join(' ')}${ws.length > 3 ? ` (+${ws.length - 3} more)` : ''}`, { kind: 'warn', duration: 12000 });
      } else if (res && res.code === 'PDF_CONVERTER_MISSING') {
        // PDF-specific: LibreOffice not found – offer to open the repair wizard without restarting
        U.toast('PDF export requires LibreOffice. Set it up without losing your work.', {
          kind: 'warn', duration: 10000,
          action: {
            label: 'Set up PDF export',
            onClick: () => { if (window.desktopAPI && typeof window.desktopAPI.openSetup === 'function') window.desktopAPI.openSetup('repair'); }
          }
        });
      } else {
        const msg = (res && res.message) || 'Backend export failed';
        U.toast(`${label} export failed: ${msg}`, { kind: 'warn', duration: 5000 });
      }
    } else U.toast('Export as "' + fmt + '" is not available. Use PowerPoint (.pptx) or PDF.', { kind: 'warn' });
  });

  // setup.openRepair — opens the repair wizard from any backstage card
  register('setup.openRepair', (a) => {
    if (window.desktopAPI && typeof window.desktopAPI.openSetup === 'function') {
      window.desktopAPI.openSetup((a && a.mode) || 'repair');
    }
    S.setUI({ backstage: null });
  });
  register('review.proofing', () => RPE.checks.proofing());
  register('review.accessibility', () => RPE.checks.accessibility());
  register('review.check', (a) => RPE.checks.research(a.kind));

  register('view.mode', { run(a) { S.setUI({ view: a.mode }); }, checked: (a) => ui.view === a.mode });
  register('view.ruler', { run() { S.setUI({ showRuler: !ui.showRuler }); }, checked: () => ui.showRuler });
  register('view.grid', { run() { S.setUI({ showGrid: !ui.showGrid }); }, checked: () => ui.showGrid });
  register('view.guides', { run() { S.setUI({ showGuides: !ui.showGuides }); }, checked: () => ui.showGuides });
  register('view.snap', {
    run() {
      const next = !ui.snapEnabled;
      S.setUI({ snapEnabled: next });
      U.toast(next ? 'Snapping enabled.' : 'Snapping disabled.', { duration: 1800 });
    },
    checked: () => ui.snapEnabled
  });
  register('view.snapGrid', {
    run() {
      const next = !ui.snapToGrid;
      S.setUI({ snapToGrid: next });
      U.toast(next ? 'Snap to grid enabled.' : 'Snap to grid disabled.', { duration: 1800 });
    },
    checked: () => ui.snapToGrid
  });
  register('view.collapseRibbon', { run() { S.setUI({ ribbonCollapsed: !ui.ribbonCollapsed, ribbonPeek: false }); }, checked: () => ui.ribbonCollapsed });
  register('view.notes', { run() { S.setUI({ notesOpen: !ui.notesOpen }); }, checked: () => ui.notesOpen });
  register('view.comments', () => RPE.dialogs.comments(document.getElementById('btnComments')));
  register('view.zoomDialog', () => RPE.dialogs.zoom());
  const zr = () => (ui.view === 'sorter' ? { min: 10, max: 50, step: 2, key: 'sorterZoom' } : { min: 10, max: 400, step: 10, key: 'zoom' });
  function setZoom(v) { const r = zr(); v = clamp(Math.round(v), r.min, r.max); if (r.key === 'zoom') S.setUI({ zoom: v, zoomMode: 'custom' }); else S.setUI({ sorterZoom: v }); }
  register('view.zoom', (a) => setZoom(+a.value));
  register('view.zoomIn', () => { const r = zr(); setZoom((r.key === 'zoom' ? ui.zoom : ui.sorterZoom) + r.step); });
  register('view.zoomOut', () => { const r = zr(); setZoom((r.key === 'zoom' ? ui.zoom : ui.sorterZoom) - r.step); });
  register('view.fit', { run() { if (ui.view === 'sorter') S.setUI({ sorterZoom: 20 }); else S.setUI({ zoomMode: 'fit' }); }, checked: () => ui.view === 'normal' && ui.zoomMode === 'fit' });

  /* ---------- value getters for combos / number fields / split-button swatches ---------- */
  function value(key) {
    if (key === 'font.family') {
      const cs = cellScope();
      if (cs) {
        const v = cellVal(cs, 'font');
        if (v !== '') return v;
        const cx = tableCtx();
        return RPE.tables ? RPE.tables.resolveCell(cs.table, cs.rect.r1, cs.rect.c1, cx).font : '';
      }
      if (editable() && RPE.canvas && RPE.canvas.currentFont) {
        return RPE.canvas.currentFont();
      }
      const t = targets();
      if (!t.length) return '';
      const cx = RPE.renderer.context(S.doc);
      if (t.length === 1 && (t[0].type === 'text' || t[0].type === 'shape') && RPE.canvas && RPE.canvas.objectFont) {
        return RPE.canvas.objectFont(t[0]);
      }
      const f = t.map((o) => o.font || (RPE.typography ? RPE.typography.roleStyle(cx.ty, o).font : (o.role === 'title' ? cx.ty.head : cx.ty.body)));
      return f.every((x) => x === f[0]) ? f[0] : '';
    }
    if (key === 'font.size') {
      const cs = cellScope();
      if (cs) {
        const v = cellVal(cs, 'fontSize');
        return v !== '' ? String(v) : '';
      }
      if (editable() && RPE.canvas.hasRange()) return String(RPE.canvas.currentSize());
      const t = targets(); if (!t.length) return '';
      const s = t.map(curSize); return s.every((x) => x === s[0]) ? String(s[0]) : '';
    }
    if (key === 'object.w' || key === 'object.h') { const list = sel(); if (!list.length) return ''; const k = key === 'object.w' ? 'w' : 'h', v = list.map((o) => o[k]); return v.every((x) => x === v[0]) ? String(+(v[0] / 96).toFixed(2)) : ''; }
    return '';
  }
  function swatch(key) {
    const c = ui.lastColors[key];
    return resolveColor(c) || '#999';
  }

  RPE.commands = { register, run, isEnabled, reason, isChecked, value, swatch, when, selectionKind, addObject, newSlide, deleteSelection, pasteObjects, copyObjects, SIZES, SHAPE_DIMS, syncTableRows, all: () => Object.keys(reg), has: (id) => !!reg[id] };
})(window.RPE = window.RPE || {});
