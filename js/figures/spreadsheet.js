/* spreadsheet.js — the "Spreadsheet" tab of the figure editor (RPE.figures.tabs.spreadsheet). Contract: docs/FIGURES_CONTRACT.md section 4m.
   A compact virtualized grid (only the visible rows and columns are in the DOM; fine up to ~50k rows) that edits record.dataset directly.
   Data edits mutate the draft in place and are undone by a local stack of 100 ops (Ctrl+Z / Ctrl+Y while the grid has focus). Number columns hold
   finite numbers or null (contract 3a): text that is not a number is kept as null in the record and shown highlighted for this session only. */
(function (RPE) {
  'use strict';
  const F = RPE.figures = RPE.figures || {};
  const registry = F.tabs = F.tabs || {};
  const U = RPE.ui, h = RPE.h, ic = RPE.icons.html, esc = U.esc;

  const RH = 24, HEAD_H = 54, GUT = 48, CW = 132, BUF = 3;
  const BIG = 20000, UNDO_MAX = 100, MAX_ROWS = 200000, MAX_COLS = 256, MAX_CELLS = 2000000;
  const ROLES = { line: [['x', 'X'], ['y', 'Y']], scatter: [['x', 'X'], ['y', 'Y'], ['group', 'Group']], bar: [['x', 'X'], ['y', 'Y'], ['group', 'Group']],
    hist: [['y', 'Value']], box: [['y', 'Value'], ['group', 'Group']], heatmap: [['x', 'X'], ['y', 'Value']] };
  const SINGLE_Y = { hist: 1, box: 1 };
  const BANNER = 'This figure is drawn by a custom Python script and holds no data table, so there is nothing to edit here. Change its data in the Python Source tab, or switch the figure back to structured mode to work in a spreadsheet.';

  /* ---------- pure helpers (also exported for tests) ---------- */
  const NUM_RE = /^[+-]?((0|[1-9]\d*)(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;   // plain numbers only (contract 3b): not 007, 1,234, 5%
  function parseNumber(s) { const t = String(s).trim(); if (!NUM_RE.test(t)) return null; const v = Number(t); return isFinite(v) ? v : null; }
  /* Quote-aware split of pasted text. Tabs win; otherwise ; or , (only for multi-line text, so a lone "1,5" stays one cell). Rows are padded to a rectangle. */
  function parseTable(text) {
    text = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const first = (text.split(/\r\n|\n|\r/).find((l) => l.trim() !== '') || '');
    const multi = /\r\n|\n|\r/.test(text.replace(/(\r\n|\n|\r)+$/, ''));
    const sep = first.indexOf('\t') >= 0 ? '\t' : (multi ? ((first.split(';').length > first.split(',').length) ? ';' : (first.indexOf(',') >= 0 ? ',' : null)) : null);
    const rows = []; let row = [], cell = '', q = false, i = 0, any = false;
    const endCell = () => { row.push(cell); cell = ''; }, endRow = () => { endCell(); rows.push(row); row = []; };
    for (; i < text.length; i++) {
      const ch = text[i]; any = true;
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
      if (ch === '"' && cell === '' && sep) q = true;
      else if (sep && ch === sep) endCell();
      else if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); }
      else if (ch === '\n') endRow();
      else cell += ch;
    }
    if (any && (cell !== '' || row.length)) endRow();
    const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
    rows.forEach((r) => { while (r.length < w) r.push(''); });
    return { rows, width: w, delimiter: sep || '' };
  }
  function inferType(strings) {
    let n = 0, num = 0;
    strings.forEach((s) => { if (String(s).trim() === '') return; n++; if (parseNumber(s) !== null) num++; });
    return n > 0 && num / n >= 0.9 ? 'number' : 'text';
  }
  /* text -> {v, bad}: v = stored value, bad = the raw text when a number column was given something that is not a number */
  function cellFrom(type, s) {
    if (s == null) return { v: null, bad: null };
    if (type === 'number') { if (String(s).trim() === '') return { v: null, bad: null }; const v = parseNumber(s); return v === null ? { v: null, bad: String(s) } : { v, bad: null }; }
    return { v: s === '' ? null : String(s), bad: null };
  }
  const tsvCell = (t) => (/[\t\r\n"]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t);
  F.spreadsheet = { parseNumber, parseTable, inferType, cellFrom };

  /* ---------- the tab ---------- */
  registry.spreadsheet = {
    mount(ctx) {
      const self = this, rec = ctx.record;
      Object.assign(self, { ctx, rec, ver: 0, stats: {}, bad: new WeakMap(), badN: new Map(), undoS: [], redoS: [], sel: null, editor: null, renaming: false,
        pending: 0, timer: 0, own: false, key: '', selVer: 0, raf: 0, down: false, rowsRef: null, colsRef: null });
      const btn = (label, icon, title, fn) => h('button', { type: 'button', class: 'btn btn--sm', title, onclick: fn, html: (icon ? ic(icon) : '') + '<span>' + esc(label) + '</span>' });
      self.bUndo = btn('Undo', 'undo-2', 'Undo the last data edit (Ctrl+Z)', () => self.step(-1));
      self.bRedo = btn('Redo', 'redo-2', 'Redo (Ctrl+Y)', () => self.step(1));
      self.bApply = btn('Apply to preview', 'check', 'Redraw the figure with the edited data', () => self.flush());
      self.info = h('span', { class: 'ss__info' }); self.msg = h('span', { class: 'ss__msg', role: 'status' });
      self.bar = h('div', { class: 'ss__bar', role: 'toolbar', 'aria-label': 'Spreadsheet tools' },
        btn('Row', 'plus', 'Insert a row below the selection', () => self.addRow(1)), btn('Column', 'plus', 'Insert a column right of the selection', () => self.addCol(1)),
        btn('Delete row', 'trash-2', 'Delete the selected rows', () => self.delRows()), btn('Delete column', 'trash-2', 'Delete the selected columns', () => self.delCols()),
        h('span', { class: 'ss__sep' }), btn('Paste', 'clipboard-paste', 'Paste a table from the clipboard (Ctrl+V)', () => self.pasteButton()),
        h('span', { class: 'ss__sep' }), self.bUndo, self.bRedo, self.bApply, h('span', { class: 'ss__grow' }), self.msg, self.info);
      self.hl = h('div', { class: 'ss__hl', role: 'row', 'aria-rowindex': '1' }); self.rl = h('div', { class: 'ss__rl' }); self.sizer = h('div', { class: 'ss__sizer' }, self.hl, self.rl);
      self.grid = h('div', { class: 'ss__grid', tabindex: '0', role: 'grid', 'aria-label': 'Figure data', 'aria-multiselectable': 'true' }, self.sizer);
      self.banner = h('div', { class: 'pd__status is-warn ss__banner', role: 'note' }, BANNER);
      self.custom = h('div', { class: 'pd__status ss__note' }, 'This figure is drawn by its Python script. Edits here change the stored table and column roles only.');
      self.wrap = h('div', { class: 'ss' }, self.banner, self.custom, self.bar, self.grid);
      const g = self.grid;
      g.addEventListener('scroll', () => { if (!self.raf) self.raf = requestAnimationFrame(() => { self.raf = 0; self.draw(); }); });
      g.addEventListener('mousedown', (e) => self.onDown(e));
      g.addEventListener('mouseover', (e) => { if (!self.down) return; const c = e.target.closest && e.target.closest('.ss__c'); if (c) self.extendTo(+c.dataset.r, +c.dataset.c); });
      g.addEventListener('dblclick', (e) => self.onDbl(e));
      g.addEventListener('click', (e) => self.onClick(e));
      g.addEventListener('contextmenu', (e) => self.onMenu(e));
      g.addEventListener('keydown', (e) => self.onKey(e));
      g.addEventListener('paste', (e) => { if (e.target.tagName === 'INPUT') return; e.preventDefault(); self.pasteText(e.clipboardData ? e.clipboardData.getData('text/plain') : ''); });
      g.addEventListener('copy', (e) => { if (e.target.tagName === 'INPUT') return; const t = self.copyText(); if (t != null && e.clipboardData) { e.preventDefault(); e.clipboardData.setData('text/plain', t); self.say('Copied ' + self.rangeLabel() + '.'); } });
      self.onUp = () => { self.down = false; };
      window.addEventListener('mouseup', self.onUp);
      if (typeof ResizeObserver === 'function') { self.ro = new ResizeObserver(() => self.draw(true)); self.ro.observe(g); }
      self.off = ctx.onChange(() => { if (self.own) return; self.syncExternal(); });
      self.syncExternal();
      return self.wrap;
    },
    onShow() { this.syncExternal(); },
    dispose() {
      window.removeEventListener('mouseup', this.onUp); if (this.ro) this.ro.disconnect(); if (this.off) this.off();
      clearTimeout(this.timer); if (this.raf) cancelAnimationFrame(this.raf);
    },

    /* ----- data access ----- */
    ds() { return this.rec.dataset; },
    cols() { return this.rec.dataset.columns; },
    rows() { return this.rec.dataset.rows; },
    ok() { const d = this.rec.dataset; return !!(d && Array.isArray(d.columns) && Array.isArray(d.rows)); },
    extractable() { return this.ok() && (this.rec.sourceMode !== 'custom' || this.cols().length > 0); },
    say(text, level) { this.msg.textContent = text || ''; this.msg.className = 'ss__msg' + (level ? ' is-' + level : ''); },
    getBad(ri, col) { const m = this.bad.get(this.rows()[ri]); return (m && m.get(col)) || null; },
    setBad(row, col, text) {
      let m = this.bad.get(row); const had = m && m.get(col);
      if (text == null) { if (!had) return; m.delete(col); this.badN.set(col, (this.badN.get(col) || 1) - 1); return; }
      if (!m) this.bad.set(row, m = new Map()); if (!had) this.badN.set(col, (this.badN.get(col) || 0) + 1); m.set(col, text);
    },
    badCount(col) { return this.badN.get(col) || 0; },

    /* The record can be replaced by another tab (data source, import): drop the local history and repaint. */
    syncExternal() {
      const same = this.ok() && this.rowsRef === this.rows() && this.colsRef === this.cols();
      if (!same) { this.undoS.length = 0; this.redoS.length = 0; this.sel = null; this.closeEditor(true); this.ver++; this.rowsRef = this.ok() ? this.rows() : null; this.colsRef = this.ok() ? this.cols() : null; }
      const show = this.extractable();
      this.banner.hidden = this.rec.sourceMode !== 'custom' || show; this.custom.hidden = !(this.rec.sourceMode === 'custom' && show);
      this.bar.hidden = this.grid.hidden = !show;
      this.stats = {}; if (show) { this.clampSel(); this.draw(true); } this.updateBar();
    },
    changed() {   // after any data/config edit made here
      this.ver++; this.stats = {};
      const r = this.rec.render; if (this.rec.sourceMode === 'structured' && r && r.status === 'ok') r.status = 'stale';
      if (this.rows().length > BIG) { this.pending++; } else { clearTimeout(this.timer); this.pending = 0; this.timer = setTimeout(() => this.notify(), 300); }
      this.clampSel(); this.draw(true); this.updateBar();
    },
    notify() { this.own = true; try { this.ctx.touch(); } finally { this.own = false; } },
    flush() { clearTimeout(this.timer); this.pending = 0; this.notify(); this.updateBar(); this.say('Preview updated.'); },
    updateBar() {
      if (!this.ok()) return;
      const n = this.rows().length, m = this.cols().length, big = n > BIG;
      this.bUndo.disabled = !this.undoS.length; this.bRedo.disabled = !this.redoS.length;
      this.bApply.hidden = !big; this.bApply.disabled = !this.pending;
      this.info.textContent = n.toLocaleString() + ' rows × ' + m + ' columns' + (big && this.pending ? ' · ' + this.pending + ' edit' + (this.pending > 1 ? 's' : '') + ' not applied' : '');
    },

    /* ----- undo stack: each op = { do(), undo() }, run in LIFO order so stored indexes stay valid ----- */
    run(op) { op.do(); this.undoS.push(op); if (this.undoS.length > UNDO_MAX) this.undoS.shift(); this.redoS.length = 0; this.changed(); },
    step(dir) {
      const from = dir < 0 ? this.undoS : this.redoS, to = dir < 0 ? this.redoS : this.undoS, op = from.pop();
      if (!op) return;
      if (dir < 0) op.undo(); else op.do();
      to.push(op); this.changed(); this.say((dir < 0 ? 'Undid ' : 'Redid ') + op.label + '.');
    },
    cfgSnap() {
      const c = this.rec.config, cl = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))), lg = (c.appearance || {}).legend;
      return { mapping: cl(c.mapping), series: cl((c.options || {}).series), labels: cl(lg && lg.labels) };
    },
    cfgRestore(s) {
      const c = this.rec.config, put = (o, k, v) => { if (v === undefined) delete o[k]; else o[k] = JSON.parse(JSON.stringify(v)); };
      c.mapping = JSON.parse(JSON.stringify(s.mapping)); if (c.options) put(c.options, 'series', s.series);
      if (c.appearance && c.appearance.legend) put(c.appearance.legend, 'labels', s.labels);
    },
    /* rename or drop a column name everywhere config refers to it (to = null drops) */
    refs(from, to) {
      const c = this.rec.config, m = c.mapping, o = c.options || {}, lg = (c.appearance || {}).legend, fix = (v) => (v === from ? to : v);
      m.x = fix(m.x); m.group = fix(m.group); m.yErr = fix(m.yErr); m.y = (m.y || []).map(fix).filter((v) => v != null);
      const mv = (obj) => { if (obj && Object.prototype.hasOwnProperty.call(obj, from)) { if (to != null && !(to in obj)) obj[to] = obj[from]; delete obj[from]; } };
      mv(o.series); mv(lg && lg.labels);
      Object.keys(o.series || {}).forEach((k) => { const s = o.series[k]; ['errorCol', 'errorLowCol', 'errorHighCol'].forEach((f) => { if (s && s[f] === from) s[f] = to; }); });
    },

    /* ----- ranges and selection ----- */
    rng() {
      const s = this.sel, n = this.rows().length, m = this.cols().length; if (!s || !n && s.mode !== 'col' || !m) return null;
      let r0 = Math.min(s.pr, s.ar), r1 = Math.max(s.pr, s.ar), c0 = Math.min(s.pc, s.ac), c1 = Math.max(s.pc, s.ac);
      if (s.mode === 'col') { r0 = 0; r1 = n - 1; } if (s.mode === 'row') { c0 = 0; c1 = m - 1; }
      return { r0, c0, r1, c1 };
    },
    rangeLabel() { const r = this.rng(); return r ? (r.r1 - r.r0 + 1) + ' × ' + (r.c1 - r.c0 + 1) + ' cells' : 'nothing'; },
    clampSel() {
      const s = this.sel, n = this.rows().length, m = this.cols().length; if (!s) return;
      if (!m || (!n && s.mode !== 'col')) { this.sel = null; return; }
      const cr = (v) => Math.max(0, Math.min(n - 1, v)), cc = (v) => Math.max(0, Math.min(m - 1, v));
      s.ar = cr(s.ar); s.pr = cr(s.pr); s.ac = cc(s.ac); s.pc = cc(s.pc);
    },
    select(r, c, mode, keep) {
      const n = this.rows().length, m = this.cols().length; if (!m) return; if (mode !== 'col' && !n) return;
      r = Math.max(0, Math.min(n - 1, r)); c = Math.max(0, Math.min(m - 1, c));
      this.sel = keep && this.sel ? Object.assign(this.sel, { ar: r, ac: c, mode: mode || this.sel.mode }) : { ar: r, ac: c, pr: r, pc: c, mode: mode || 'cell' };
      this.selVer++; this.reveal(r, c); this.draw(true);
    },
    extendTo(r, c) { if (!this.sel) return; this.sel.ar = r; this.sel.ac = c; this.selVer++; this.draw(true); },
    reveal(r, c) {
      const g = this.grid, top = g.scrollTop, left = g.scrollLeft, vh = g.clientHeight, vw = g.clientWidth; if (!vh) return;
      const y0 = r * RH, y1 = y0 + RH + HEAD_H, x0 = c * CW, x1 = x0 + CW + GUT;
      if (y0 < top) g.scrollTop = y0; else if (y1 > top + vh) g.scrollTop = y1 - vh;
      if (x0 < left) g.scrollLeft = x0; else if (x1 > left + vw) g.scrollLeft = x1 - vw;
    },

    /* ----- rendering (virtualized) ----- */
    draw(force) {
      if (!this.ok() || this.grid.hidden) return;
      const g = this.grid, n = this.rows().length, m = this.cols().length, cols = this.cols(), rows = this.rows();
      const top = g.scrollTop, left = g.scrollLeft, vh = g.clientHeight || 400, vw = g.clientWidth || 600;
      const r0 = Math.max(0, Math.floor(top / RH) - BUF), r1 = Math.min(n - 1, Math.floor((top + vh) / RH) + BUF);
      const c0 = Math.max(0, Math.floor(left / CW) - 1), c1 = Math.min(m - 1, Math.ceil((left + vw) / CW) + 1);
      const key = [r0, r1, c0, c1, this.ver, this.selVer, n, m].join(':');
      if (!force && key === this.key) return; this.key = key;
      const W = GUT + m * CW; this.sizer.style.width = W + 'px'; this.sizer.style.height = HEAD_H + n * RH + (n ? 0 : 60) + 'px'; this.hl.style.width = W + 'px';
      const R = this.rng(), s = this.sel, pt = this.rec.config.plotType, rl = ROLES[pt] || [], map = this.rec.config.mapping || {};
      let html = '';
      if (!this.renaming) {   // header row (sticky): type button, name, badges, role chips
        let hh = '<div class="ss__corner" title="Use each column as a role in the plot">Use as</div><i style="width:' + c0 * CW + 'px;flex:none"></i>';
        for (let c = c0; c <= c1; c++) {
          const col = cols[c], on = R && c >= R.c0 && c <= R.c1 && (s.mode === 'col'), isNum = col.type === 'number', st = this.colStats(c), bn = this.badCount(col);
          hh += '<div class="ss__h' + (on ? ' is-sel' : '') + '" data-c="' + c + '" role="columnheader" aria-colindex="' + (c + 1) + '" title="' + esc(col.name) + '">' +
            '<div class="ss__hn"><button type="button" class="ss__ty" data-act="type" title="' + (isNum ? 'Number' : 'Text') + ' column. Click to change the type." aria-label="Column type: ' + (isNum ? 'number' : 'text') + '">' + (isNum ? '123' : 'Aa') + '</button>' +
            '<span class="ss__nm" data-act="name">' + esc(col.name) + '</span>' +
            (st.empty ? '<span class="ss__bd is-warn" title="This column has no values yet.">Empty</span>' : '') +
            (bn ? '<span class="ss__bd is-bad" title="' + bn + ' cell' + (bn > 1 ? 's' : '') + ' in this column are not numbers. The plot treats them as missing.">' + bn + ' invalid</span>' : '') + '</div>' +
            '<div class="ss__roles">' + rl.map((r) => {
              const isOn = r[0] === 'y' ? (map.y || []).indexOf(col.name) >= 0 : map[r[0]] === col.name, needNum = r[0] === 'y' && !isNum, off = needNum && !isOn;
              return '<button type="button" class="ss__rl' + (isOn ? ' is-on' : '') + (isOn && needNum ? ' is-warn' : '') + '" data-act="role" data-role="' + r[0] + '" aria-pressed="' + isOn + '"' + (off ? ' disabled' : '') +
                ' title="' + (off ? 'Needs a number column. Change the column type first.' : isOn && needNum ? 'This column is text; plots need numbers here.' : (isOn ? 'Stop using' : 'Use') + ' this column as ' + r[1] + (pt === 'heatmap' && r[0] === 'y' ? ' (with none chosen, all number columns are drawn)' : '')) + '">' + r[1] + '</button>';
            }).join('') + '</div></div>';
        }
        this.hl.innerHTML = hh;
      }
      for (let r = r0; r <= r1; r++) {
        const row = rows[r], rowSel = R && r >= R.r0 && r <= R.r1 && s.mode === 'row';
        html += '<div class="ss__r" role="row" aria-rowindex="' + (r + 1) + '" style="top:' + (HEAD_H + r * RH) + 'px;width:' + W + 'px"><div class="ss__rn' + (rowSel ? ' is-sel' : '') + '" data-r="' + r + '">' + (r + 1) + '</div><i style="width:' + c0 * CW + 'px;flex:none"></i>';
        for (let c = c0; c <= c1; c++) {
          const col = cols[c], v = row[c], bad = v == null && col.type === 'number' ? this.getBadFast(row, col) : null;
          const inR = R && r >= R.r0 && r <= R.r1 && c >= R.c0 && c <= R.c1, act = s && r === s.ar && c === s.ac;
          html += '<div class="ss__c' + (col.type === 'number' ? ' is-num' : '') + (v == null && bad == null ? ' is-na' : '') + (bad != null ? ' is-bad' : '') + (inR ? ' is-sel' : '') + (act ? ' is-act' : '') + '" data-r="' + r + '" data-c="' + c + '" id="ssc-' + r + '-' + c + '" role="gridcell" aria-colindex="' + (c + 1) + '" aria-selected="' + !!inR + '"' +
            (bad != null ? ' title="' + esc('Not a number: “' + bad + '”. The plot treats this cell as missing. Change the column type to Text to keep it.') + '"' : '') + '>' + (bad != null ? esc(bad) : v == null ? '—' : esc(String(v))) + '</div>';
        }
        html += '</div>';
      }
      const empty = !m ? 'No data yet. Paste a table (Ctrl+V) or add a column.' : (!n ? 'No rows yet. Add a row or paste data.' : '');
      this.rl.innerHTML = html + (empty ? '<div class="ss__empty" style="top:' + (HEAD_H + 12) + 'px">' + empty + '</div>' : '');
      const ac = this.rl.querySelector ? this.rl.querySelector('.is-act') : null; if (ac && ac.id) this.grid.setAttribute('aria-activedescendant', ac.id); else if (this.grid.removeAttribute) this.grid.removeAttribute('aria-activedescendant');   // the focused cell is announced although focus stays on the grid
      this.grid.setAttribute('aria-rowcount', String(n + 1)); this.grid.setAttribute('aria-colcount', String(m));
    },
    getBadFast(row, col) { const m = this.bad.get(row); return (m && m.get(col)) || null; },
    colStats(c) {
      const k = this.stats[c]; if (k) return k;
      const rows = this.rows(); let empty = true;
      for (let i = 0; i < rows.length; i++) if (rows[i][c] != null || this.getBadFast(rows[i], this.cols()[c])) { empty = false; break; }
      return (this.stats[c] = { empty: empty && rows.length > 0 });
    },

    /* ----- mouse ----- */
    onDown(e) {
      const t = e.target; if (t.tagName === 'INPUT' || e.button === 2 && t.closest('.ss__c,.ss__h,.ss__rn') && this.inSel(t)) return;
      const cell = t.closest('.ss__c'), hd = t.closest('.ss__h'), rn = t.closest('.ss__rn');
      if (t.closest('[data-act="type"],[data-act="role"]')) return;   // buttons act on click
      if (this.editor) this.commitEditor(false);
      if (cell) { const r = +cell.dataset.r, c = +cell.dataset.c; this.select(r, c, 'cell', e.shiftKey && !!this.sel); this.down = e.button === 0; this.grid.focus(); e.preventDefault(); }
      else if (hd) { const c = +hd.dataset.c; if (e.shiftKey && this.sel && this.sel.mode === 'col') { this.sel.ac = c; this.selVer++; this.draw(true); } else this.select(0, c, 'col'); this.grid.focus(); }
      else if (rn) { const r = +rn.dataset.r; if (e.shiftKey && this.sel && this.sel.mode === 'row') { this.sel.ar = r; this.selVer++; this.draw(true); } else this.select(r, 0, 'row'); this.grid.focus(); e.preventDefault(); }
    },
    inSel(t) { const c = t.closest('.ss__c'), hd = t.closest('.ss__h'), rn = t.closest('.ss__rn'), R = this.rng(); if (!R) return false; if (c) return +c.dataset.r >= R.r0 && +c.dataset.r <= R.r1 && +c.dataset.c >= R.c0 && +c.dataset.c <= R.c1; if (hd) return this.sel.mode === 'col' && +hd.dataset.c >= R.c0 && +hd.dataset.c <= R.c1; if (rn) return this.sel.mode === 'row' && +rn.dataset.r >= R.r0 && +rn.dataset.r <= R.r1; return false; },
    onClick(e) {
      const b = e.target.closest('[data-act]'); if (!b) return; const hd = b.closest('.ss__h'); if (!hd) return;
      const c = +hd.dataset.c, act = b.dataset.act;
      if (act === 'type') this.typeMenu(c, b); else if (act === 'role') this.setRole(c, b.dataset.role);
    },
    onDbl(e) {
      const t = e.target; if (t.tagName === 'INPUT') return;
      const c = t.closest('.ss__c'); if (c) return this.startEdit(+c.dataset.r, +c.dataset.c, null);
      const hd = t.closest('.ss__h'); if (hd && !t.closest('[data-act="role"],[data-act="type"]')) this.startRename(+hd.dataset.c);
    },

    /* ----- roles: mapping chips (exclusive per column; X / Group single, Y multi except hist and box = one Value) ----- */
    setRole(ci, role) {
      const name = this.cols()[ci].name, pt = this.rec.config.plotType;
      this.ctx.set((r) => {
        const m = r.config.mapping; m.y = m.y || [];
        const on = role === 'y' ? m.y.indexOf(name) >= 0 : m[role] === name;
        if (on) { if (role === 'y') m.y = m.y.filter((v) => v !== name); else m[role] = null; return; }
        if (m.x === name) m.x = null; if (m.group === name) m.group = null; if (m.yErr === name) m.yErr = null; m.y = m.y.filter((v) => v !== name);
        if (role === 'y') m.y = SINGLE_Y[pt] ? [name] : m.y.concat(name); else m[role] = name;
      });
      this.draw(true);
    },

    /* ----- editing ----- */
    startEdit(r, c, first) {
      if (!this.cols()[c] || r >= this.rows().length) return;
      this.closeEditor(true); this.select(r, c, 'cell');
      const col = this.cols()[c], v = this.rows()[r][c], bad = this.getBad(r, col);
      const text = first != null ? first : (bad != null ? bad : v == null ? '' : String(v));
      const inp = h('input', { class: 'ss__edit', type: 'text', value: text, 'aria-label': 'Edit cell, row ' + (r + 1) + ', ' + col.name, style: { left: (GUT + c * CW) + 'px', top: (HEAD_H + r * RH) + 'px', width: CW + 'px', height: RH + 'px' } });
      this.editor = { el: inp, r, c };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.commitEditor(true); this.move(e.shiftKey ? -1 : 1, 0, false); }
        else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); this.commitEditor(true); this.move(0, e.shiftKey ? -1 : 1, false, true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeEditor(true); }
        else e.stopPropagation();
      });
      inp.addEventListener('blur', () => { if (this.editor && this.editor.el === inp) this.commitEditor(false); });
      this.sizer.appendChild(inp); inp.focus(); if (first == null) inp.select(); else inp.setSelectionRange(text.length, text.length);
    },
    closeEditor(refocus) { const e = this.editor; if (!e) return; this.editor = null; if (e.el.parentNode) e.el.parentNode.removeChild(e.el); if (refocus) this.grid.focus(); },
    commitEditor(refocus) {
      const e = this.editor; if (!e) return; const text = e.el.value; this.editor = null; if (e.el.parentNode) e.el.parentNode.removeChild(e.el);
      if (e.r < this.rows().length && this.cols()[e.c]) this.setCells([{ r: e.r, c: e.c, text }], 'cell edit');
      if (refocus) this.grid.focus();
    },
    /* items: [{r, c, text}] -> parsed with the column's CURRENT type; one undo step */
    setCells(items, label) {
      const cols = this.cols(), rows = this.rows(), ch = [];
      items.forEach((it) => {
        const col = cols[it.c], row = rows[it.r], p = cellFrom(col.type, it.text), ov = row[it.c], ob = this.getBadFast(row, col);
        if (ov === p.v && ob === p.bad) return; ch.push({ r: it.r, c: it.c, ov, ob, nv: p.v, nb: p.bad });
      });
      if (!ch.length) return 0;
      const put = (k) => ch.forEach((x) => { const row = this.rows()[x.r], col = this.cols()[x.c]; row[x.c] = k ? x.nv : x.ov; this.setBad(row, col, k ? x.nb : x.ob); });
      this.run({ label, do: () => put(true), undo: () => put(false) });
      const nb = ch.filter((x) => x.nb != null).length; if (nb) this.say(nb + ' cell' + (nb > 1 ? 's are' : ' is') + ' not a number: highlighted and drawn as missing.', 'warn');
      return ch.length;
    },
    clearRange() {
      const R = this.rng(); if (!R) return; const rows = this.rows(), cols = this.cols(), items = [];
      for (let r = R.r0; r <= R.r1; r++) for (let c = R.c0; c <= R.c1; c++) if (rows[r][c] != null || this.getBadFast(rows[r], cols[c])) items.push({ r, c, text: '' });
      this.setCells(items, 'clear'); this.say(items.length ? 'Cleared ' + items.length + ' cell' + (items.length > 1 ? 's' : '') + '.' : 'Nothing to clear.');
    },

    /* ----- structure: rows ----- */
    insertMany(arr, at, items) { const tail = arr.splice(at); items.forEach((x) => arr.push(x)); tail.forEach((x) => arr.push(x)); },
    capFail(addRows, addCols) {
      const n = this.rows().length + addRows, m = this.cols().length + addCols;
      if (n > MAX_ROWS) return 'A figure can hold at most ' + MAX_ROWS.toLocaleString() + ' rows.';
      if (m > MAX_COLS) return 'A figure can hold at most ' + MAX_COLS + ' columns.';
      if (n * m > MAX_CELLS) return 'A figure can hold at most ' + MAX_CELLS.toLocaleString() + ' cells.';
      return '';
    },
    addRow(dir, at, count) {
      if (!this.cols().length) return this.say('Add a column first.', 'warn');
      const R = this.rng(), k = count || 1, pos = at != null ? at : (R ? (dir > 0 ? R.r1 + 1 : R.r0) : this.rows().length), why = this.capFail(k, 0);
      if (why) return this.say(why, 'warn');
      const made = []; for (let i = 0; i < k; i++) made.push(this.cols().map(() => null));
      this.run({ label: 'row insert', do: () => this.insertMany(this.rows(), pos, made), undo: () => this.rows().splice(pos, k) });
      this.select(pos, this.sel ? Math.min(this.sel.ac, this.cols().length - 1) : 0, 'cell'); this.grid.focus();
    },
    delRows() {
      const R = this.rng(); if (!R || (this.sel.mode === 'col')) return this.say('Select the rows to delete first (click a row number).', 'warn');
      const at = R.r0, k = R.r1 - R.r0 + 1; let gone = [];
      const adj = (sign) => gone.forEach((row) => { const bm = this.bad.get(row); if (bm) bm.forEach((_, col) => this.badN.set(col, (this.badN.get(col) || 0) + sign)); });
      this.run({ label: 'row delete', do: () => { gone = this.rows().splice(at, k); adj(-1); }, undo: () => { this.insertMany(this.rows(), at, gone); adj(1); } });
      this.sel = this.rows().length ? { ar: Math.min(at, this.rows().length - 1), ac: R.c0, pr: Math.min(at, this.rows().length - 1), pc: R.c0, mode: 'cell' } : null; this.selVer++; this.draw(true);
      this.say('Deleted ' + k + ' row' + (k > 1 ? 's' : '') + '.');
    },

    /* ----- structure: columns ----- */
    uniqueName(base, taken) { let i = 1, nm; const set = new Set(taken || this.cols().map((c) => c.name)); do { nm = base + ' ' + (this.cols().length + i++); } while (set.has(nm)); return nm; },
    addCol(dir, at) {
      const R = this.rng(), pos = at != null ? at : (R ? (dir > 0 ? R.c1 + 1 : R.c0) : this.cols().length), why = this.capFail(0, 1);
      if (why) return this.say(why, 'warn');
      const col = { name: this.uniqueName('Column'), type: 'number' };
      this.run({ label: 'column insert', do: () => { this.cols().splice(pos, 0, col); this.rows().forEach((r) => r.splice(pos, 0, null)); }, undo: () => { this.cols().splice(pos, 1); this.rows().forEach((r) => r.splice(pos, 1)); } });
      this.select(this.rows().length ? (R ? Math.min(R.r0, this.rows().length - 1) : 0) : 0, pos, this.rows().length ? 'cell' : 'col'); this.grid.focus();
    },
    delCols() {
      const R = this.rng(); if (!R) return this.say('Select the columns to delete first (click a column header).', 'warn');
      const at = R.c0, k = R.c1 - R.c0 + 1; let gone = [], vals = [], snap = null;
      this.run({ label: 'column delete',
        do: () => {
          snap = snap || this.cfgSnap(); gone = this.cols().splice(at, k); vals = this.rows().map((r) => r.splice(at, k));
          gone.forEach((c) => this.refs(c.name, null));
        },
        undo: () => { this.insertMany(this.cols(), at, gone); this.rows().forEach((r, i) => { const t = r.splice(at); vals[i].forEach((x) => r.push(x)); t.forEach((x) => r.push(x)); }); this.cfgRestore(snap); } });
      const m = this.cols().length; this.sel = m ? { ar: 0, ac: Math.min(at, m - 1), pr: 0, pc: Math.min(at, m - 1), mode: 'col' } : null; this.selVer++; this.draw(true);
      this.say('Deleted ' + k + ' column' + (k > 1 ? 's' : '') + '.');
    },
    startRename(ci) {
      this.closeEditor(false); const col = this.cols()[ci]; if (!col) return;
      this.reveal(0, ci); this.draw(true);
      const hd = this.hl.querySelector('.ss__h[data-c="' + ci + '"]'); if (!hd) return;
      const inp = h('input', { class: 'ss__ren', type: 'text', value: col.name, maxlength: 80, 'aria-label': 'Column name' }); let done = false;
      this.renaming = true; const nm = hd.querySelector('.ss__nm'); nm.replaceWith(inp); inp.focus(); inp.select();
      const finish = (ok) => {
        if (done) return; done = true; this.renaming = false; const v = inp.value.trim();
        this.draw(true);
        if (ok && v && v !== col.name) this.rename(ci, v); else if (ok && !v) this.say('A column needs a name.', 'warn');
        this.grid.focus();
      };
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
      inp.addEventListener('blur', () => finish(true));
    },
    rename(ci, name) {
      if (this.cols().some((c, i) => i !== ci && c.name === name)) return this.say('Another column is already called “' + name + '”. Names must be unique.', 'warn');
      const old = this.cols()[ci].name; let snap = null;
      this.run({ label: 'rename', do: () => { snap = snap || this.cfgSnap(); this.cols()[ci].name = name; this.refs(old, name); }, undo: () => { this.cols()[ci].name = old; this.cfgRestore(snap); } });
    },

    /* ----- column type override (never automatic) ----- */
    typeMenu(ci, anchor) {
      const col = this.cols()[ci], list = h('div', { class: 'menu' }, h('div', { class: 'menu__head' }, 'Column type'));
      [['number', 'Number'], ['text', 'Text']].forEach(([id, label]) => {
        const on = col.type === id;
        list.appendChild(h('button', { type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(on), class: 'menu__item' + (on ? ' is-checked' : ''), html: '<span class="menu__icon">' + (on ? ic('check') : '') + '</span><span class="menu__label">' + label + '</span>', onclick: () => { U.closeAll(); this.setType(ci, id); } }));
      });
      U.popover(anchor, list, { role: 'menu', focusFirst: true });
    },
    async setType(ci, type) {
      const col = this.cols()[ci]; if (!col || col.type === type) return;
      const rows = this.rows(); let lost = 0;
      if (type === 'number') rows.forEach((r) => { const v = r[ci]; if (v != null && parseNumber(v) === null) lost++; });
      if (lost) {
        const ok = await U.confirm({ title: 'Change column to Number?', message: lost.toLocaleString() + ' value' + (lost > 1 ? 's in “' : ' in “') + col.name + '” ' + (lost > 1 ? 'are' : 'is') + ' not a number. They stay visible here, highlighted, but the plot treats them as missing. Undo restores them.', confirmLabel: 'Change to Number' });
        if (!ok) return;
      }
      const idx = this.cols().indexOf(col); if (idx < 0) return;
      const before = this.rows().map((r) => [r[idx], this.getBadFast(r, col)]), after = before.map(([v, b]) => {
        if (type === 'text') return [b != null ? b : (v == null ? null : String(v)), null];
        if (v == null) return [null, null]; const n = parseNumber(v); return n === null ? [null, String(v)] : [n, null];
      });
      const put = (list, t) => { col.type = t; const c = this.cols().indexOf(col); this.rows().forEach((r, i) => { r[c] = list[i][0]; this.setBad(r, col, list[i][1]); }); };
      const prev = col.type; this.run({ label: 'type change', do: () => put(after, type), undo: () => put(before, prev) });
      this.say('“' + col.name + '” is now a ' + type + ' column.' + (type === 'number' && lost ? ' ' + lost + ' value' + (lost > 1 ? 's are' : ' is') + ' marked invalid.' : ''), type === 'number' && lost ? 'warn' : '');
    },

    /* ----- clipboard ----- */
    copyText() {
      const R = this.rng(); if (!R) return null; const rows = this.rows(), cols = this.cols(), out = [];
      for (let r = R.r0; r <= R.r1; r++) { const line = []; for (let c = R.c0; c <= R.c1; c++) { const v = rows[r][c], b = this.getBadFast(rows[r], cols[c]); line.push(tsvCell(b != null ? b : v == null ? '' : String(v))); } out.push(line.join('\t')); }
      return out.join('\n');
    },
    async pasteButton() {
      let t = ''; try { t = await navigator.clipboard.readText(); } catch (e) { return this.say('The browser blocked clipboard access. Click a cell and press Ctrl+V instead.', 'warn'); }
      this.pasteText(t);
    },
    async pasteText(text) {
      const T = parseTable(text); if (!T.rows.length || !T.width) return this.say('The clipboard holds no table.', 'warn');
      const cols = this.cols(), m0 = cols.length, n0 = this.rows().length; let data = T.rows, names = null, usedHeader = false;
      if (!m0 && data.length >= 2 && data[0].every((x) => x.trim() !== '') && data[0].every((x) => parseNumber(x) === null) && data.slice(1).some((r) => r.some((x) => parseNumber(x) !== null))) { names = data[0].map((x) => x.trim()); data = data.slice(1); usedHeader = true; }
      const R = this.rng(), r0 = R && !(this.sel.mode === 'col') ? R.r0 : 0, c0 = R ? R.c0 : 0, w = T.width, hgt = data.length;
      const newCols = Math.max(0, c0 + w - m0), newRows = Math.max(0, r0 + hgt - n0), why = this.capFail(newRows, newCols);
      if (why) return this.say(why + ' Nothing was pasted.', 'warn');
      let over = 0; const rows = this.rows();
      for (let r = r0; r < Math.min(n0, r0 + hgt); r++) for (let c = c0; c < Math.min(m0, c0 + w); c++) if (rows[r][c] != null || this.getBadFast(rows[r], cols[c])) over++;
      if (over) { const ok = await U.confirm({ title: 'Overwrite existing cells?', message: 'Pasting replaces ' + over.toLocaleString() + ' cell' + (over > 1 ? 's' : '') + ' that already hold data. Undo brings them back.', confirmLabel: 'Overwrite', danger: true }); if (!ok) return; }
      if (this.cols() !== cols || this.rows() !== rows) return;   // the table was replaced while the confirmation was open
      const taken = cols.map((c) => c.name), made = [];
      for (let j = 0; j < newCols; j++) {
        const base = ((names && names[j]) || '').slice(0, 120); let nm = base;
        if (!nm || taken.indexOf(nm) >= 0) { let k = base ? 2 : m0 + j + 1; do { nm = base ? base + ' (' + k + ')' : 'Column ' + k; k++; } while (taken.indexOf(nm) >= 0); }
        taken.push(nm); made.push({ name: nm, type: inferType(data.map((r) => r[m0 + j - c0] === undefined ? '' : r[m0 + j - c0])) });
      }
      const grow = { label: 'paste', do() {}, undo() {} }, self = this, items = [];
      // the grow step runs first so setCells sees the final shape; both are one undo step
      const colsAdd = () => { made.forEach((c) => { this.cols().push(c); this.rows().forEach((r) => r.push(null)); }); };
      const colsDel = () => { this.cols().splice(m0, newCols); this.rows().forEach((r) => r.splice(m0, newCols)); };
      const rowsAdd = () => { for (let i = 0; i < newRows; i++) this.rows().push(this.cols().map(() => null)); };
      const rowsDel = () => { this.rows().splice(n0, newRows); };
      colsAdd(); rowsAdd();
      data.forEach((row, i) => row.forEach((s, j) => items.push({ r: r0 + i, c: c0 + j, text: s })));
      const ch = []; let invalid = 0;
      items.forEach((it) => { const col = this.cols()[it.c], row = this.rows()[it.r], p = cellFrom(col.type, it.text), ov = row[it.c], ob = this.getBadFast(row, col); if (p.bad != null) invalid++; if (ov === p.v && ob === p.bad) return; ch.push({ r: it.r, c: it.c, ov, ob, nv: p.v, nb: p.bad }); });
      const put = (k) => ch.forEach((x) => { const row = self.rows()[x.r], col = self.cols()[x.c]; row[x.c] = k ? x.nv : x.ov; self.setBad(row, col, k ? x.nb : x.ob); });
      put(true);
      grow.do = () => { colsAdd(); rowsAdd(); put(true); };
      grow.undo = () => { put(false); rowsDel(); colsDel(); };
      this.undoS.push(grow); if (this.undoS.length > UNDO_MAX) this.undoS.shift(); this.redoS.length = 0; this.changed();
      this.sel = { ar: r0 + hgt - 1, ac: c0 + w - 1, pr: r0, pc: c0, mode: 'cell' }; this.selVer++; this.draw(true); this.grid.focus();
      this.say('Pasted ' + hgt + ' × ' + w + ' cells' + (newCols || newRows ? ' (grid grew by ' + [newRows ? newRows + ' row' + (newRows > 1 ? 's' : '') : '', newCols ? newCols + ' column' + (newCols > 1 ? 's' : '') : ''].filter(Boolean).join(' and ') + ')' : '') + '.' + (usedHeader ? ' The first row became the column names.' : '') + (invalid ? ' ' + invalid + ' not a number: highlighted.' : ''), invalid ? 'warn' : '');
    },

    /* ----- keyboard ----- */
    move(dr, dc, extend, wrap) {
      const s = this.sel, n = this.rows().length, m = this.cols().length; if (!m || !n) return;
      if (!s) return this.select(0, 0, 'cell');
      let r = s.ar + dr, c = s.ac + dc;
      if (dc && !dr && !extend && wrap) { if (c >= m) { c = 0; r = s.ar + 1; } else if (c < 0) { c = m - 1; r = s.ar - 1; } }
      r = Math.max(0, Math.min(n - 1, r)); c = Math.max(0, Math.min(m - 1, c));
      if (extend) { s.ar = r; s.ac = c; this.selVer++; this.reveal(r, c); this.draw(true); }
      else this.select(r, c, 'cell');
    },
    onKey(e) {
      if (e.target.tagName === 'INPUT') return;
      const k = e.key, mod = e.ctrlKey || e.metaKey, n = this.rows().length, m = this.cols().length, s = this.sel, page = Math.max(1, Math.floor((this.grid.clientHeight - HEAD_H) / RH) - 1);
      const eat = () => { e.preventDefault(); e.stopPropagation(); };
      if (mod && (k === 'z' || k === 'Z')) { eat(); return this.step(e.shiftKey ? 1 : -1); }
      if (mod && (k === 'y' || k === 'Y')) { eat(); return this.step(1); }
      if (mod && (k === 'a' || k === 'A')) { eat(); if (n && m) { this.select(0, 0, 'cell'); this.sel.ar = n - 1; this.sel.ac = m - 1; this.selVer++; this.draw(true); } return; }
      if (mod) return;   // copy / paste arrive as clipboard events
      const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (arrows[k]) { eat(); const d = arrows[k]; return this.move(d[0], d[1], e.shiftKey); }
      if (k === 'PageDown' || k === 'PageUp') { eat(); return this.move(k === 'PageDown' ? page : -page, 0, e.shiftKey); }
      if (k === 'Home' || k === 'End') { eat(); return this.move(0, k === 'Home' ? -m : m, e.shiftKey); }
      if (k === 'Tab') {   // Tab walks the cells; at the very first / last cell it leaves the grid
        if (!s || !n || !m) return; const last = s.ar === n - 1 && s.ac === m - 1, first = s.ar === 0 && s.ac === 0;
        if ((e.shiftKey && first) || (!e.shiftKey && last)) return; eat(); return this.move(0, e.shiftKey ? -1 : 1, false, true);
      }
      if (k === 'Enter' || k === 'F2') { eat(); if (s && n && m) { if (e.shiftKey && k === 'Enter') this.move(-1, 0, false); else this.startEdit(s.ar, s.ac, null); } return; }
      if (k === 'Delete' || k === 'Backspace') { eat(); return this.clearRange(); }
      if (k === 'Escape' && s && s.mode === 'cell' && (s.pr !== s.ar || s.pc !== s.ac)) { eat(); s.pr = s.ar; s.pc = s.ac; this.selVer++; return this.draw(true); }
      if (k.length === 1 && !e.altKey && s && n && m) { eat(); this.startEdit(s.ar, s.ac, k); }
    },

    /* ----- context menu ----- */
    onMenu(e) {
      const t = e.target; if (t.tagName === 'INPUT') return;
      const cell = t.closest('.ss__c'), hd = t.closest('.ss__h'), rn = t.closest('.ss__rn'); if (!cell && !hd && !rn) return;
      e.preventDefault(); if (this.editor) this.commitEditor(false);
      if (!this.inSel(t)) { if (cell) this.select(+cell.dataset.r, +cell.dataset.c, 'cell'); else if (hd) this.select(0, +hd.dataset.c, 'col'); else this.select(+rn.dataset.r, 0, 'row'); }
      const R = this.rng(), nR = R ? R.r1 - R.r0 + 1 : 0, nC = R ? R.c1 - R.c0 + 1 : 0, ci = R ? R.c0 : 0, col = this.cols()[ci], list = h('div', { class: 'menu' });
      const add = (label, fn, o) => list.appendChild(h('button', { type: 'button', role: 'menuitem', class: 'menu__item', disabled: !!(o && o.off), html: '<span class="menu__icon">' + (o && o.icon ? ic(o.icon) : '') + '</span><span class="menu__label">' + esc(label) + '</span>', onclick: () => { U.closeAll(); fn(); } }));
      const sep = () => list.appendChild(h('div', { class: 'menu__sep', role: 'separator' }));
      add('Insert row above', () => this.addRow(-1), { off: !R || !this.cols().length }); add('Insert row below', () => this.addRow(1), { off: !R || !this.cols().length });
      add(nR > 1 && this.sel.mode !== 'col' ? 'Delete ' + nR + ' rows' : 'Delete row', () => this.delRows(), { off: !R || this.sel.mode === 'col', icon: 'trash-2' }); sep();
      add('Insert column left', () => this.addCol(-1), { off: !R }); add('Insert column right', () => this.addCol(1), { off: !R });
      add(nC > 1 && this.sel.mode !== 'row' ? 'Delete ' + nC + ' columns' : 'Delete column', () => this.delCols(), { off: !R, icon: 'trash-2' });
      add('Rename column', () => this.startRename(ci), { off: !col });
      add(col && col.type === 'number' ? 'Make column Text' : 'Make column Number', () => this.setType(ci, col.type === 'number' ? 'text' : 'number'), { off: !col }); sep();
      add('Clear cells', () => this.clearRange(), { off: !R }); add('Copy', () => { const tx = this.copyText(); if (tx != null && navigator.clipboard) navigator.clipboard.writeText(tx).then(() => this.say('Copied ' + this.rangeLabel() + '.'), () => this.say('The browser blocked clipboard access. Use Ctrl+C.', 'warn')); }, { off: !R });
      add('Paste', () => this.pasteButton());
      U.popover({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY - 2, width: 0, height: 0 }, list, { role: 'menu', class: 'popover--context', focusFirst: false });
    }
  };
})(window.RPE);
