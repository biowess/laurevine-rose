/* exportpanel.js — the figure editor's Export tab (RPE.figures.tabs.export) plus the final-render step behind Insert / Apply
   (RPE.figures.exportpanel.save). Pixel math mirrors backend/figures/export.py `pixels` (same limits, same wording).
   Contract: docs/FIGURES_CONTRACT.md section 4n. */
(function (RPE) {
  'use strict';
  const F = RPE.figures = RPE.figures || {};
  const h = RPE.h, S = () => RPE.store;
  const MAX_SIDE = 16384, MAX_MP = 120, LARGE_MP = 50, PX_PER_IN = 96, DPIS = [150, 300, 450, 600];
  const MIN_IN = 0.5, MAX_IN = 30, MIN_DPI = 72, MAX_DPI = 1200, INLINE_ROWS = 2000;
  const X = F.exportpanel = {};

  const pyRound = (x) => { const f = Math.floor(x), d = x - f; return d < 0.5 ? f : d > 0.5 ? f + 1 : (f % 2 === 0 ? f : f + 1); };   // Python's round(): halves to even
  const inch = (n) => { const s = (+n).toFixed(2); return s.endsWith('0') ? s.slice(0, -1) : s; };
  const mpText = (mp) => (mp < 0.1 ? mp.toFixed(2) : mp.toFixed(1));

  /* ---------- pure helpers (also used by tests) ---------- */
  X.pixels = function (w, hh, dpi) {
    const wPx = pyRound(w * dpi), hPx = pyRound(hh * dpi), mp = Math.round(wPx * hPx / 1e4) / 100, out = { wPx, hPx, megapixels: mp, refused: false };
    if (wPx > MAX_SIDE || hPx > MAX_SIDE) { out.refused = true; out.warning = `${wPx} x ${hPx} px is more than the ${MAX_SIDE} px per-side limit; export is refused. Lower the DPI or the size.`; }
    else if (wPx * hPx > MAX_MP * 1e6) { out.refused = true; out.warning = `${+mp.toFixed(2)} megapixels is more than the ${MAX_MP} MP limit; export is refused. Lower the DPI or the size.`; }
    else if (wPx * hPx > LARGE_MP * 1e6) out.warning = `${+mp.toFixed(2)} megapixels makes a very large file that can take a while to render.`;
    return out;
  };
  X.readout = (w, hh, dpi) => { const p = X.pixels(w, hh, dpi); return `${inch(w)} × ${inch(hh)} in @ ${dpi} dpi = ${p.wPx} × ${p.hPx} px, ${mpText(p.megapixels)} MP`; };

  /* LaTeX page -> image (pure): native = the PDF page size, else width `wIn` with the page aspect kept (height follows, never stretched). */
  X.fitPage = function (pageW, pageH, native, wIn, dpi) {
    const w = native ? pageW : wIn, hh = w * pageH / pageW;
    return Object.assign({ wIn: w, hIn: hh, aspect: pageW / pageH, native: !!native }, X.pixels(w, hh, dpi));
  };

  /* Size of a new slide object: the physical size (96 px per inch) when it fits below the title area, else scaled down with the aspect kept. */
  X.placement = function (aspect, physWIn, slideSize) {
    const maxW = Math.max(80, slideSize.w - 80), maxH = Math.max(80, slideSize.h - 170);
    let w = Math.max(24, Math.round(physWIn * PX_PER_IN)), hh = Math.round(w / aspect);
    if (w > maxW || hh > maxH) { const k = Math.min(maxW / w, maxH / hh); w = Math.max(24, Math.round(w * k)); hh = Math.round(w / aspect); }
    return { w, h: hh, x: Math.round((slideSize.w - w) / 2), y: Math.max(150, Math.round((slideSize.h - hh) / 2) + 20) };
  };
  X.altText = (rec) => { const k = RPE.plots && RPE.plots.KINDS && RPE.plots.KINDS[rec.config.plotType]; return `${k ? k.label : 'Plot'} plot${rec.name ? ': ' + rec.name : ''}.`; };

  /* Final render of the CURRENT draft. The image is only accepted when the draft did not change while it was drawn (a result whose
     clientHash differs from the draft is stale and is drawn again). Resolves {ok, res} or {ok:false, cancelled, message}. */
  X.renderFinal = async function (draft, o) {
    o = o || {};
    for (let attempt = 0; attempt < 3; attempt++) {
      const sent = F.hash(draft), t0 = Date.now(), p = draft.sourceMode === 'custom' ? null : X.pixels(draft.export.wIn, draft.export.hIn, draft.export.dpi);
      const label = p ? `Rendering the final image (${p.wPx} × ${p.hPx} px)` : 'Rendering the final image';
      const tick = () => { if (o.progress) o.progress(`${label}… ${Math.round((Date.now() - t0) / 1000)} s`); };
      tick(); const timer = o.progress ? setInterval(tick, 1000) : null;
      let res;
      try { res = await F.render(draft, { purpose: 'final', signal: o.signal, latest: false }); } finally { if (timer) clearInterval(timer); }
      if (!res.ok) return { ok: false, cancelled: res.status === 'cancelled', message: res.message || 'The figure could not be rendered.' };
      if (res.clientHash && res.clientHash === sent && F.hash(draft) === sent) return { ok: true, res };
    }
    return { ok: false, message: 'The figure changed while it was being drawn. Try again.' };
  };

  /* Insert / Apply (used by RPE.dialogs.plot). Renders first; on any failure nothing in the document changes. Insert = record + slide
     object in ONE undo step; Apply = record + object (src, aspect, name, h; x, y, w kept) in ONE undo step. Returns true | message. */
  X.save = async function (draft, ctx, obj) {
    const off = F.requireBackend(); if (off) return off;
    const r = await X.renderFinal(draft, { signal: ctx.signal, progress: ctx.progress });
    if (!r.ok) return r.cancelled ? `Cancelled. Nothing was ${obj ? 'changed' : 'inserted'}.` : r.message;
    const res = r.res, aspect = res.widthPx && res.heightPx ? res.widthPx / res.heightPx : draft.export.wIn / draft.export.hIn;
    const store = S(), find = (id) => { for (const s of store.doc.slides) { const o = s.objects.find((x) => x.id === id); if (o) return o; } return null; };
    if (obj) {
      if (!find(obj.id)) return 'The plot is no longer on a slide, so nothing was changed.';
      const old = F.get(draft.id), prevAuto = old ? X.altText(old) : null;
      ctx.commit('Edit plot', (doc) => {
        const o = doc.slides.reduce((f, s) => f || s.objects.find((x) => x.id === obj.id), null);
        Object.assign(o, { figureId: draft.id, src: res.preview, aspect, name: draft.name, alt: o.alt && o.alt !== prevAuto ? o.alt : X.altText(draft), h: Math.max(1, Math.round(o.w / aspect)) });
      });
      return true;
    }
    const slide = store.activeSlide(); if (!slide) return 'There is no slide to insert the plot into.';
    const phys = res.widthPx / (res.dpi || draft.export.dpi), pl = X.placement(aspect, phys, store.doc.size);
    const nobj = Object.assign({ id: store.uid('o'), type: 'plot', figureId: draft.id, src: res.preview, aspect }, pl, { alt: X.altText(draft), name: draft.name });
    ctx.commit('Insert plot', (doc) => { doc.slides.find((s) => s.id === slide.id).objects.push(nobj); });
    store.select([nobj.id]); store.setUI({ activeTab: 'plotTools' });
    return true;
  };

  /* ---------- the Export tab ---------- */
  F.tabs = F.tabs || {};
  F.tabs.export = {
    mount(ctx) {
      const self = this, rec = ctx.record;
      self.busy = null;
      const seg = (items, get, set, label) => {
        const box = h('div', { class: 'fe__zoom xp__seg', role: 'group', 'aria-label': label }), btns = {};
        items.forEach((it) => { btns[it.id] = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-pressed': 'false', onclick: () => { if (!btns[it.id].disabled) set(it.id); } }, it.label); box.appendChild(btns[it.id]); });
        box.sync = () => items.forEach((it) => { const b = btns[it.id], dis = it.disabled ? it.disabled() : ''; b.disabled = !!dis; b.title = dis || ''; b.setAttribute('aria-pressed', String(get() === it.id)); });
        return box;
      };
      const num = (label, lo, hi, step) => {
        const el = h('input', { class: 'input', type: 'number', min: lo, max: hi, step, 'aria-label': label, 'aria-invalid': 'false' });
        return el;
      };
      const exp = () => rec.export, custom = () => rec.sourceMode === 'custom';
      const fmtSeg = seg([{ id: 'png', label: 'PNG' }, { id: 'pdf', label: 'PDF' }], () => exp().format, (v) => ctx.set({ export: { format: v } }), 'File format');
      const bgNo = () => (rec.kind === 'latex' || rec.kind === 'composite' ? 'A transparent background needs a Matplotlib figure.' : '');
      const bgSeg = seg([{ id: 'white', label: 'White' }, { id: 'transparent', label: 'Transparent', disabled: bgNo }], () => exp().background, (v) => ctx.set({ export: { background: v } }), 'Background');
      const dpiSeg = seg(DPIS.map((d) => ({ id: d, label: String(d) })), () => exp().dpi, (v) => ctx.set({ export: { dpi: v } }), 'DPI preset');
      const wIn = num('Width (in)', MIN_IN, MAX_IN, 'any'), hIn = num('Height (in)', MIN_IN, MAX_IN, 'any'), dpiIn = num('Custom DPI', MIN_DPI, MAX_DPI, 1);
      const sizeMsg = h('div', { class: 'ss__msg', role: 'status' }), readout = h('div', { class: 'pd__status', role: 'status' }), warn = h('div', { class: 'pd__status is-warn', role: 'alert', hidden: true });
      const status = h('div', { class: 'pd__status', role: 'status' }), note = h('div', { class: 'ss__msg' });
      const bExport = h('button', { type: 'button', class: 'btn btn--primary', onclick: () => run(exp().format) }, 'Export file…');
      const bPy = h('button', { type: 'button', class: 'btn', onclick: () => run('py') }, 'Export Python…');
      const bCancel = h('button', { type: 'button', class: 'btn btn--ghost', hidden: true, onclick: () => { if (self.busy) self.busy.job.abort(); } }, 'Cancel');

      function bind(el, key, lo, hi, what, unit) {
        el.addEventListener('change', () => {
          const v = el.value.trim() === '' ? NaN : Number(el.value);
          if (!isFinite(v) || v < lo || v > hi) { el.setAttribute('aria-invalid', 'true'); sizeMsg.textContent = `${what} must be between ${lo} and ${hi} ${unit}; the value was not applied.`; sizeMsg.className = 'ss__msg is-warn'; return; }
          el.setAttribute('aria-invalid', 'false'); sizeMsg.textContent = ''; ctx.set({ export: { [key]: key === 'dpi' ? Math.round(v) : v } });
        });
      }
      bind(wIn, 'wIn', MIN_IN, MAX_IN, 'Width', 'in'); bind(hIn, 'hIn', MIN_IN, MAX_IN, 'Height', 'in'); bind(dpiIn, 'dpi', MIN_DPI, MAX_DPI, 'DPI', '');

      function sync() {
        const e = exp(), c = custom(), p = X.pixels(e.wIn, e.hIn, e.dpi), act = document.activeElement;
        [[wIn, e.wIn], [hIn, e.hIn], [dpiIn, e.dpi]].forEach(([el, v]) => { if (el !== act) el.value = v; });
        wIn.title = hIn.title = c ? 'Your Python script sets the figure size.' : '';
        [fmtSeg, bgSeg, dpiSeg].forEach((s) => s.sync());
        readout.textContent = c ? `Your script sets the size · ${e.dpi} dpi` : X.readout(e.wIn, e.hIn, e.dpi);
        const refused = !c && p.refused;
        warn.hidden = c || !p.warning; warn.textContent = c ? '' : p.warning || ''; warn.className = 'pd__status ' + (refused ? 'is-error' : 'is-warn');
        const many = rec.sourceMode !== 'custom' && ((rec.dataset && rec.dataset.rows) || []).length > INLINE_ROWS;
        note.textContent = `Insert in slide always draws a PNG with these settings.${many ? ' This figure has more than 2000 data rows, so Export Python saves a .zip with figure.py and data.csv.' : ''}${e.background === 'transparent' ? ' Python files are always written with a white background.' : ''}`;
        const b = !!self.busy;
        bPy.hidden = rec.kind === 'composite'; bExport.disabled = b || refused; bPy.disabled = b; bCancel.hidden = !b; wIn.disabled = hIn.disabled = c || b; dpiIn.disabled = b;
      }
      function setStatus(text, level) { status.textContent = text || ''; status.className = 'pd__status' + (level ? ' is-' + level : ''); }

      async function run(format) {
        if (self.busy) return;
        const e = exp(), asPy = format === 'py', bundle = asPy && !custom() && ((rec.dataset && rec.dataset.rows) || []).length > INLINE_ROWS;
        const job = new AbortController(), t0 = Date.now(); self.busy = { job };
        const send = Object.assign({}, rec, { render: { status: 'none' }, originalCsv: null });
        const req = { record: send, format: bundle ? 'bundle' : format, dpi: e.dpi, save: true, signal: job.signal };
        if (!asPy) req.background = e.background;
        const p = custom() ? null : X.pixels(e.wIn, e.hIn, e.dpi);
        const tick = () => setStatus(asPy ? 'Writing the Python file…' : `Rendering ${format.toUpperCase()}${p ? ` (${p.wPx} × ${p.hPx} px)` : ''}… ${Math.round((Date.now() - t0) / 1000)} s`, 'busy');
        tick(); const timer = setInterval(tick, 1000); sync();
        let r; try { r = await RPE.backend.request('figures.export', req); } finally { clearInterval(timer); self.busy = null; }
        if (self.disposed) return;
        if (r.ok) setStatus(`Saved ${r.filename} (${r.size >= 1048576 ? (r.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(r.size / 1024)) + ' KB'}).`, 'ok');
        else setStatus(r.code === 'aborted' ? 'Cancelled. No file was saved.' : (r.message || 'The file could not be exported.'), r.code === 'aborted' ? '' : 'error');
        sync();
      }

      const field = (label, el) => h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), el);
      self.off = ctx.onChange(sync); self.sync = sync; sync();
      return h('div', { class: 'xp' },
        h('div', { class: 'pd__h' }, 'Format'), fmtSeg,
        h('div', { class: 'pd__h' }, 'Size'), h('div', { class: 'pd__row' }, field('Width (in)', wIn), field('Height (in)', hIn)), sizeMsg,
        h('div', { class: 'pd__h' }, 'Resolution', ' ', F.a11y ? F.a11y.help('Size in inches sets how large the figure is on the slide, while DPI only sets how many pixels are saved per inch: more DPI is sharper, not bigger.', 'DPI versus size') : null), dpiSeg, h('div', { class: 'pd__row' }, field('Custom DPI (72–1200)', dpiIn)),
        h('div', { class: 'pd__h' }, 'Background'), bgSeg,
        readout, warn, note,
        h('div', { class: 'xp__actions' }, bExport, bPy, bCancel), status);
    },
    onShow() { if (this.sync) this.sync(); },
    dispose() { this.disposed = true; if (this.busy) this.busy.job.abort(); if (this.off) this.off(); }
  };
})(window.RPE);
