/* pysource.js — the "Python Source" tab of the figure editor (contract section 4o, ownership rules in section 6).
   structured: shows the script generated from the settings (read-only). "Edit as Python" hands the figure to the script (sourceMode 'custom').
   custom: editable script (RPE.figures.codeEditor: highlighting, line numbers, error markers), Run (only on click / Ctrl+Enter, never on tab switch), state indicator, error panel with
   click-to-jump, "Regenerate from settings" and "Return to structured plot" (both guarded: Copy / snapshot offered before edits are replaced).
   `config` and `dataset` are never touched by a mode change. Pure helpers live on RPE.figures.pysource (tested in tests/test_js_checks.js, 24). */
(function (RPE) {
  'use strict';
  const F = RPE.figures = RPE.figures || {};
  const P = F.pysource = F.pysource || {};
  const INLINE_ROWS = 2000;   // as in exportpanel.js / backend export

  /* ---------- pure helpers ---------- */
  P.isCustom = (rec) => !!rec && rec.sourceMode === 'custom';
  P.canReturn = (rec) => !!rec && rec.kind === 'structured';   // python / latex records have no settings to go back to
  P.lineCount = (s) => String(s == null ? '' : s).split('\n').length;
  /* structured -> custom: the script takes over; config, dataset, export stay exactly as they are */
  P.toCustom = (rec, script) => { rec.sourceMode = 'custom'; rec.source = String(script == null ? '' : script); return rec; };
  /* custom -> structured: the settings own the figure again; the stored script is dropped (the caller has offered copy / snapshot) */
  P.toStructured = (rec) => { rec.sourceMode = 'structured'; rec.source = ''; return rec; };
  /* true when going back / regenerating would lose text the user has not got elsewhere (unknown base counts as edited) */
  P.edited = (rec, base) => P.isCustom(rec) && (base == null || rec.source !== base);
  /* idle | running | ok | error. An error only counts for the script it came from (errHash); editing makes the state idle again. */
  P.execState = (s) => (s.running ? 'running' : s.error && s.hash === s.errHash ? 'error' : s.status === 'ok' ? 'ok' : 'idle');
  /* diagnostics -> [{line|null, message}] for the error panel; a line outside the script is not clickable */
  P.errorLines = (diags, src) => {
    const n = P.lineCount(src), out = [];
    (diags || []).forEach((d) => {
      if (!d || d.level !== 'error' || !d.message) return;
      const l = Number(d.line);
      out.push({ line: Number.isInteger(l) && l >= 1 && l <= n ? l : null, message: String(d.message) });
    });
    return out.slice(0, 20);
  };
  /* character range of line `line` (1-based) in `src`, for selecting it after a click-to-jump */
  P.lineRange = (src, line) => {
    const lines = String(src || '').split('\n'), i = Math.min(Math.max(1, line | 0), lines.length) - 1;
    let s = 0; for (let k = 0; k < i; k++) s += lines[k].length + 1;
    return [s, s + lines[i].length];
  };
  P.snapshotName = (name, d) => {
    d = d || new Date(); const p = (n) => String(n).padStart(2, '0');
    const stem = String(name || 'figure').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'figure';
    return stem + '_snapshot_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.py';
  };
  const STATE_TEXT = { idle: 'Not run', running: 'Running…', ok: 'Ran without errors', error: 'Error' };

  /* ---------- the tab ---------- */
  F.tabs = F.tabs || {};
  F.tabs.python = {
    mount(ctx) {
      const self = this, h = RPE.h;
      self.ctx = ctx; self.gen = ''; self.genHash = null; self.genNote = ''; self.seq = 0; self.job = null; self.base = null;
      self.errHash = null; self.errors = []; self.stderr = ''; self.visible = false; self.disposed = false;
      const btn = (label, fn, cls) => h('button', { type: 'button', class: 'btn btn--sm' + (cls ? ' ' + cls : ''), onclick: fn }, label);
      self.state = h('span', { class: 'chip py__state', role: 'status' });
      self.bCopy = btn('Copy', () => self.copy(self.text()));
      self.bExport = btn('Export .py', () => self.exportPy());
      self.bEdit = btn('Edit as Python', () => self.editAsPython());
      self.bRun = btn('Run', () => self.run(), 'btn--primary');
      self.bRegen = btn('Regenerate from settings', () => self.guarded('regenerate'));
      self.bBack = btn('Return to structured plot', () => self.guarded('return'));
      self.banner = h('div', { class: 'pd__status py__banner', role: 'note' });
      self.msg = h('div', { class: 'fe__hint py__msg', role: 'status' });
      self.ed = F.codeEditor({ language: 'python', value: '', label: 'Python script', readOnly: true,
        onChange: (v) => self.ctx.set({ source: v }),
        onRun: () => (P.isCustom(self.ctx.record) ? (self.run(), true) : false) });   // Run, not the dialog's Save (structured: Ctrl+Enter is left to the dialog)
      self.errBox = h('div', { class: 'py__errs', role: 'alert', hidden: true });
      self.offChange = ctx.onChange(() => { self.sync(); if (self.visible && !P.isCustom(ctx.record)) self.refreshSoon(); });
      self.refreshSoon = F.debounce(() => self.refresh(), 350);
      self.sync();
      return h('div', { class: 'pd__pane py' },
        h('div', { class: 'fe__bar py__bar' }, self.state, h('span', { class: 'py__sp' }), self.bCopy, self.bExport, self.bEdit, self.bRegen, self.bBack, self.bRun),
        self.banner, h('div', { class: 'py__wrap' }, self.ed.el), self.errBox, self.msg);
    },
    rec() { return this.ctx.record; },
    custom() { return P.isCustom(this.ctx.record); },
    text() { return this.custom() ? this.ctx.record.source : this.gen; },
    say(text, level) { this.msg.textContent = text || ''; this.msg.className = 'fe__hint py__msg' + (level ? ' is-' + level : ''); },
    execState() {
      const r = this.ctx.record, rr = r.render || {};
      return P.execState({ running: !!this.job, error: !!rr.error, hash: F.hash(r), errHash: this.errHash, status: rr.status });
    },

    /* repaint everything from the draft; cheap, called on every change */
    sync() {
      const r = this.ctx.record, custom = P.isCustom(r), back = P.canReturn(r), st = this.execState();
      const text = custom ? r.source : this.gen;
      this.ed.setReadOnly(!custom); this.ed.setValue(text);
      this.state.hidden = !custom; this.state.textContent = STATE_TEXT[st]; this.state.className = 'chip py__state is-' + st;
      this.bEdit.hidden = custom; this.bRun.hidden = !custom; this.bRegen.hidden = !(custom && back); this.bBack.hidden = !(custom && back);
      this.bRun.disabled = !!this.job; this.bRun.textContent = this.job ? 'Running…' : 'Run (Ctrl+Enter)';
      this.bEdit.disabled = !!this.genBusy; this.bCopy.disabled = !text; this.bExport.disabled = !text && !custom;
      this.banner.className = 'pd__status py__banner' + (custom ? ' is-warn' : '');
      this.banner.textContent = custom
        ? 'Python controls this figure. The settings are kept but do not change the picture' + (back ? '; return to the structured plot to use them again.' : '.') + ' The script runs only when you click Run.'
        : (this.genBusy ? 'Generating the script…' : this.genNote || 'This script is generated from the settings and is read-only. Choose “Edit as Python” to take over the figure.');
      this.showErrors(st);
    },
    showErrors(st) {
      const h = RPE.h, box = this.errBox, r = this.ctx.record;
      box.textContent = '';
      const show = this.custom() && st === 'error' && (this.errors.length || this.stderr);
      box.hidden = !show; this.ed.setErrors(show ? this.errors : []); if (!show) return;
      this.errors.forEach((e) => box.append(e.line
        ? h('button', { type: 'button', class: 'py__err', title: 'Jump to line ' + e.line, onclick: () => this.jump(e.line) }, h('b', null, 'Line ' + e.line), ' ' + e.message)
        : h('div', { class: 'py__err' }, e.message)));
      if (!this.errors.length) box.append(h('div', { class: 'py__err' }, (r.render && r.render.error) || 'The script failed.'));
      if (this.stderr) box.append(h('details', { class: 'fe__details' }, h('summary', null, 'Output from Python'), h('div', { class: 'fe__log' }, this.stderr)));
    },
    jump(line) {
      this.ed.jumpToLine(line);
    },

    /* ----- generated script (structured): taken from the render answer, which returns the script it ran (contract 4i) ----- */
    generate(rec) {
      const copy = Object.assign({}, rec, { sourceMode: 'structured', source: '' });
      return F.render(copy, { purpose: 'preview', latest: false }).then((res) => (res.source ? { ok: true, source: res.source } : { ok: false, message: res.message || 'The settings cannot produce a script yet.' }));
    },
    refresh() {
      const self = this, r = self.ctx.record;
      if (self.disposed || P.isCustom(r)) return;
      const off = F.requireBackend(); if (off) { self.genNote = off; return self.sync(); }
      const hash = F.hash(r); if (hash === self.genHash && self.gen) return self.sync();
      const mine = ++self.seq; self.genBusy = true; self.sync();
      self.generate(r).then((g) => {
        if (mine !== self.seq || self.disposed) return;
        self.genBusy = false;
        if (g.ok) { self.gen = g.source; self.genHash = hash; self.genNote = ''; } else { self.gen = ''; self.genHash = null; self.genNote = g.message; }
        self.sync();
      });
    },
    onShow() { this.visible = true; if (!this.custom()) this.refresh(); else this.sync(); },

    /* ----- ownership changes ----- */
    async editAsPython() {
      const self = this, ctx = self.ctx, U = RPE.ui;
      if (self.custom() || self.genBusy) return;
      if (!self.gen) { self.say('The script is not ready yet. ' + (self.genNote || 'Wait a moment and try again.'), 'warn'); return self.refresh(); }
      const ok = await U.confirm({ title: 'Edit as Python?', message: 'The script will control this figure. Your settings are kept, but they stop changing the picture until you return to the structured plot.', confirmLabel: 'Edit as Python' });
      if (!ok || self.disposed || self.custom()) return;
      self.base = self.gen; self.errors = []; self.stderr = ''; self.errHash = null;
      ctx.set((r) => P.toCustom(r, self.base));
      self.say('Python now controls this figure. Click Run to draw it.', '');
      self.ed.focus();
    },
    /* Regenerate / Return replace the script: when it was edited, say so and offer Copy and a snapshot file first. */
    async guarded(kind) {
      const self = this, ctx = self.ctx, U = RPE.ui, h = RPE.h, back = kind === 'return';
      if (!self.custom() || !P.canReturn(ctx.record) || self.job) return;
      const gen = back ? null : await self.generate(ctx.record);
      if (!back && !gen.ok) return self.say('Cannot regenerate: ' + gen.message, 'error');
      if (self.disposed || !self.custom()) return;
      if (P.edited(ctx.record, self.base)) {
        const script = ctx.record.source, note = h('span', { class: 'fe__hint', role: 'status' });
        const body = h('div', null,
          h('p', { class: 'dlg__text' }, (back ? 'Returning to the structured plot' : 'Regenerating the script') + ' replaces your edits with the script made from the settings. Your settings are not changed.'),
          h('div', { class: 'fe__row' }, h('span', { class: 'fe__row' },
            h('button', { type: 'button', class: 'btn btn--sm', onclick: () => self.copy(script).then((m) => { note.textContent = m; }) }, 'Copy script'),
            h('button', { type: 'button', class: 'btn btn--sm', onclick: () => { note.textContent = self.snapshot(script); } }, 'Save as snapshot (.py)')), note));
        const ok = await U.dialog({ title: back ? 'Return to structured plot?' : 'Regenerate from settings?', icon: 'triangle-alert', width: 460, dismiss: 'backdrop', body,
          buttons: [{ label: 'Keep my script', value: false }, { label: back ? 'Return and replace' : 'Replace script', kind: 'danger', value: true }] }).done.then((v) => v === true);
        if (!ok || self.disposed || !self.custom()) return;
      }
      self.errors = []; self.stderr = ''; self.errHash = null;
      if (back) { ctx.set((r) => P.toStructured(r)); self.gen = ''; self.genHash = null; self.say('Back to the structured plot.', ''); self.refresh(); }
      else { self.base = gen.source; ctx.set({ source: gen.source }); self.say('The script was regenerated from the settings. Click Run to draw it.', ''); }
    },

    /* ----- run: explicit click / Ctrl+Enter only ----- */
    run() {
      const self = this, ctx = self.ctx, r = ctx.record;
      if (!self.custom() || self.job) return;
      const off = F.requireBackend(); if (off) return self.say(off, 'error');
      if (!String(r.source).trim()) return self.say('The script is empty.', 'warn');
      self.say(''); self.errors = []; self.stderr = ''; self.errHash = null;
      const mine = ++self.seq, job = F.render(r, { purpose: 'preview' }); self.job = job; self.sync();
      job.then((res) => {
        if (mine !== self.seq || self.disposed) return;
        self.job = null;
        if (res.status !== 'cancelled') {
          const applied = ctx.session.applyRender(res);   // false when the script was edited while it ran: the result no longer matches
          if (!res.ok) { self.errHash = res.clientHash; self.errors = P.errorLines(res.diagnostics, ctx.record.source); self.stderr = String(res.stderr || '').slice(0, 4000); }
          else if (!applied) self.say('The script changed while it ran, so that result was dropped. Run again.', 'warn');
          const pv = ctx.tab && ctx.tab('preview'); if (pv && pv.adopt) pv.adopt(res, applied);
        }
        self.sync();
      });
    },

    /* ----- copy / export ----- */
    copy(text) {
      const self = this;
      const fallback = () => { try { const ta = self.ed.textarea, a = [ta.selectionStart, ta.selectionEnd]; ta.focus(); ta.select(); const ok = document.execCommand('copy'); ta.setSelectionRange(a[0], a[1]); return ok; } catch (e) { return false; } };
      const done = (ok) => { const m = ok ? 'Script copied.' : 'The browser blocked copying. Select the text and press Ctrl+C.'; self.say(m, ok ? 'ok' : 'warn'); return m; };
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => done(true), () => done(fallback()));
      return Promise.resolve(done(text === self.ed.getValue() && fallback()));
    },
    snapshot(text) {
      const name = P.snapshotName(this.ctx.record.name);
      try {
        const a = document.createElement('a'), url = URL.createObjectURL(new Blob([text], { type: 'text/x-python;charset=utf-8' }));
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
      } catch (e) { return 'The snapshot could not be saved. Use Copy script instead.'; }
      return 'Saved ' + name + '.';
    },
    async exportPy() {
      const self = this, r = self.ctx.record, off = F.requireBackend();
      if (off) return self.say(off, 'error');
      const bundle = !P.isCustom(r) && ((r.dataset && r.dataset.rows) || []).length > INLINE_ROWS;   // big data: script + data.csv in a .zip
      self.say('Writing the Python file…', 'busy');
      const send = Object.assign({}, r, { render: { status: 'none' }, originalCsv: null });
      const res = await RPE.backend.request('figures.export', { record: send, format: bundle ? 'bundle' : 'py', dpi: r.export.dpi, save: true });
      if (self.disposed) return;
      if (res.ok) self.say('Saved ' + res.filename + ' (' + Math.max(1, Math.round(res.size / 1024)) + ' KB).', 'ok'); else self.say(res.message || 'The file could not be exported.', 'error');
    },
    dispose() { this.disposed = true; this.visible = false; if (this.job) this.job.cancel(); if (this.refreshSoon) this.refreshSoon.cancel(); if (this.offChange) this.offChange(); }
  };
})(window.RPE);
