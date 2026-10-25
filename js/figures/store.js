/* figures/store.js — client side of the Scientific Figure Studio (namespace RPE.figures).
   runtime()        Promise of the GET /api/figures/runtime report, cached 60 s; null when it cannot be read.
   refresh()        same, but asks the service to probe again.
   summary(report)  multi-line text for the status-bar tooltip.
   requireBackend() null when the Python service is connected, otherwise a user-facing message for dialogs.
   Records (doc.figures): blank/create/get/update/duplicate/delete/referencesOf/cloneForEdit/markStale/hash/gc,
   attach/detach (raw doc helpers for callers that insert a record and its slide object in ONE mutate).
   Rendering: render(record, {purpose, dpi, signal, latest}) -> Promise<normalized result> with .cancel(),
   applyRender(id, result), debounce(fn, ms). Contract: docs/FIGURES_CONTRACT.md section 4k. */
(function (RPE) {
  'use strict';
  const F = RPE.figures = RPE.figures || {};
  const TTL = 60000;
  let cached = null;   // { at, report }
  let pending = null;  // in-flight request shared by concurrent callers
  let gen = 0;         // bumped on every request/reset so a late answer never overwrites a newer state

  function load(force) {
    if (pending && !force) return pending;
    const mine = ++gen;
    const p = RPE.backend.request('figures.runtime', { refresh: !!force })
      .then((res) => (res && res.ok ? res.data : null))
      .then((rep) => (rep && typeof rep === 'object' && typeof rep.python === 'string' ? rep : null))
      .catch(() => null)
      .then((report) => {
        if (pending === p) pending = null;
        if (mine === gen) cached = report ? { at: Date.now(), report } : null;
        return report;
      });
    pending = p;
    return p;
  }

  F.runtime = () => (cached && Date.now() - cached.at < TTL ? Promise.resolve(cached.report) : load(false));
  F.refresh = () => load(true);

  const LABELS = [['python', 'Python'], ['matplotlib', 'Matplotlib'], ['numpy', 'NumPy'], ['pandas', 'pandas'], ['scipy', 'SciPy']];
  F.summary = function (rt) {
    if (!rt) return 'Figure runtime details are unavailable.';
    const have = LABELS.filter(([k]) => rt[k]).map(([k, n]) => n + ' ' + rt[k]);
    const lack = LABELS.filter(([k]) => !rt[k]).map(([, n]) => n);
    const tex = rt.tex || {}, engines = Object.keys(tex.engines || {});
    const pgf = tex.pgfplots ? 'pgfplots available' : tex.kpsewhich ? 'pgfplots not found' : 'pgfplots not checked';
    return [have.slice(0, 2).join(' · '), have.slice(2, 4).join(' · '), have.slice(4).join(' · '),
      lack.length ? 'Not installed: ' + lack.join(', ') : '',
      engines.length ? 'LaTeX: ' + engines.join(', ') + ' · ' + pgf : 'LaTeX: no engine found']
      .filter(Boolean).join('\n');
  };

  F.requireBackend = function () {
    if (RPE.backend && RPE.backend.connected) return null;
    const base = RPE.backend ? RPE.backend.getBaseUrl() : 'http://127.0.0.1:8000';
    return 'Figures are made by the local Python service, which is not reachable at ' + base +
      '. Start it with python3 run.py, then try again.';
  };

  /* ---------- records ---------- */
  const MAX_FIGURES = 500, MAX_NAME = 200;
  const NAMES = { structured: 'Untitled plot', python: 'Python figure', latex: 'LaTeX figure', composite: 'Composite figure' };
  /* Per-plot-type overrides of the backend defaults (models.py _PLOT_DEFAULTS); every other field is filled by the server. */
  const PLOT_DEFAULTS = {
    line: {}, scatter: { appearance: { markerSize: 6 } }, bar: { options: { errorBars: true } },
    hist: { appearance: { alpha: 0.8 }, options: { bins: 20 } }, box: { options: { showPoints: true } },
    heatmap: { appearance: { grid: false, despine: false }, options: { colorbar: true } }
  };
  const S = () => RPE.store;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const hint = (ids) => ({ skipCanvas: true, meta: true, figures: ids });

  function newId(doc) {
    let id;
    do { id = 'fig_' + Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4); } while (doc && doc.figures && doc.figures[id]);
    return id;
  }
  function stable(v) {      // JSON with sorted keys, so equal content always gives equal text
    if (v === null || typeof v !== 'object') { const t = JSON.stringify(v); return t === undefined ? 'null' : t; }
    if (Array.isArray(v)) return v.every((x) => x === null || typeof x !== 'object') ? JSON.stringify(v) : '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  function cyrb53(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }
  function merge(dst, patch) {   // plain objects merge, arrays and scalars replace, undefined is skipped
    Object.keys(patch).forEach((k) => {
      const v = patch[k];
      if (v === undefined || k === '__proto__' || k === 'constructor' || k === 'prototype') return;
      if (isPlain(v) && isPlain(dst[k])) merge(dst[k], v); else dst[k] = v !== null && typeof v === 'object' ? clone(v) : v;
    });
  }
  function replaceContents(rec, src) { Object.keys(rec).forEach((k) => { delete rec[k]; }); Object.assign(rec, src); }

  /* Fields that change the picture, as in the server's cache key (contract 4i); the key is for change detection only. */
  F.hash = function (rec) {
    const ex = rec.export || {}, bg = ex.background || 'white';
    let key;
    if (rec.kind === 'composite') key = { kind: rec.kind, name: rec.name, composite: rec.composite, w: ex.wIn, h: ex.hIn, bg };
    else if (rec.kind === 'latex') key = { kind: rec.kind, source: rec.source, latex: rec.latex, bg };
    else if (rec.kind === 'python' || rec.sourceMode === 'custom') key = { source: rec.source, bg };
    else key = { kind: rec.kind, name: rec.name, dataset: rec.dataset, config: rec.config, w: ex.wIn, h: ex.hIn, bg };
    const text = stable(key);
    return 'c' + cyrb53(text) + '.' + text.length.toString(36);
  };

  /* Visual hash: fields that change the rendered picture only.
     Omits non-visual fields: name, id, originalCsv, dataset.origin, export.format, export.dpi, render. */
  F.visualHash = function (rec) {
    if (!rec || typeof rec !== 'object') return '';
    const ex = rec.export || {}, bg = ex.background || 'white';
    let key;
    if (rec.kind === 'composite') {
      const panels = (rec.composite && rec.composite.panels || []).map((p) => {
        if (!p || !p.record) return { slot: p.slot, record: null };
        const pr = p.record, pex = pr.export || {};
        return {
          slot: p.slot,
          kind: pr.kind,
          sourceMode: pr.sourceMode,
          source: pr.sourceMode === 'custom' ? pr.source : undefined,
          dataset: pr.sourceMode !== 'custom' ? { columns: (pr.dataset && pr.dataset.columns) || [], rows: (pr.dataset && pr.dataset.rows) || [] } : undefined,
          config: pr.sourceMode !== 'custom' ? pr.config : undefined,
          size: [pex.wIn, pex.hIn],
          bg: pex.background || 'white'
        };
      });
      key = { kind: rec.kind, composite: Object.assign({}, rec.composite, { panels }), w: ex.wIn, h: ex.hIn, bg };
    } else if (rec.kind === 'latex') {
      key = { kind: rec.kind, source: rec.source, latex: rec.latex, bg };
    } else if (rec.kind === 'python' || rec.sourceMode === 'custom') {
      key = { source: rec.source, bg };
    } else {
      const ds = rec.dataset || {};
      key = {
        kind: rec.kind,
        plotType: (rec.config && rec.config.plotType) || '',
        data: { columns: ds.columns || [], rows: ds.rows || [] },
        config: rec.config,
        w: ex.wIn,
        h: ex.hIn,
        bg
      };
    }
    const text = stable(key);
    return 'vh' + cyrb53(text) + '.' + text.length.toString(36);
  };

  /* Editing a rendered record's content makes its preview stale (it is kept: a failed render never destroys it, s8). */
  function change(rec, fn) {
    const before = rec.render && rec.render.status === 'ok' ? F.hash(rec) : null;
    const id = rec.id;
    fn(rec);
    rec.id = id;
    if (before !== null && rec.render && rec.render.status === 'ok' && F.hash(rec) !== before) rec.render.status = 'stale';
  }
  function checkRoom(doc) {
    if (doc && doc.figures && Object.keys(doc.figures).length >= MAX_FIGURES) throw new Error('A presentation can hold at most ' + MAX_FIGURES + ' figures.');
  }

  /* A valid, unsaved record. kind: structured|python|latex|composite; plotType: line|scatter|bar|hist|box|heatmap. */
  F.blank = function (kind, plotType, opts) {
    kind = kind || 'structured'; plotType = plotType || 'line'; opts = opts || {};
    if (!NAMES[kind]) throw new Error("Unknown figure kind '" + kind + "'.");
    if (!PLOT_DEFAULTS[plotType]) throw new Error("Unknown plot type '" + plotType + "'.");
    const ov = PLOT_DEFAULTS[plotType], custom = kind === 'python' || kind === 'latex';
    const rec = {
      id: opts.id || newId(S() && S().doc), kind, name: String(opts.name || NAMES[kind]).slice(0, MAX_NAME),
      dataset: { columns: [], rows: [], origin: { type: 'sheet', label: '', sampleId: null, fileName: null } },
      originalCsv: null,
      config: { plotType, mapping: { x: null, y: [], group: null, yErr: null }, appearance: clone(ov.appearance || {}), options: clone(ov.options || {}) },
      sourceMode: custom ? 'custom' : 'structured', source: '',
      export: { wIn: 6, hIn: 4, dpi: 450, format: 'png', background: 'white' },
      render: { status: 'none', hash: null, preview: null, at: null, durationMs: null, error: null, diagnostics: [], runtime: null }
    };
    if (kind === 'latex') rec.latex = { mode: 'document', engine: 'pdflatex' };
    if (kind === 'composite') {
      rec.composite = { layout: '2x2', labels: 'A', spacing: 'normal', legend: 'none', fontSize: 10, fontApplyAll: false, alignH: 'center', alignV: 'top',
        labelStyle: { family: 'sans', size: 12, weight: 'bold', placement: 'top-left', offset: 0 },
        panels: [0, 1, 2, 3].map((slot) => ({ slot, record: null })) };
    }
    return rec;
  };

  F.get = function (id) {
    const d = S().doc, figs = d && d.figures;
    return figs && typeof id === 'string' && Object.prototype.hasOwnProperty.call(figs, id) ? figs[id] : null;
  };
  /* Raw document edits (no history): for a caller that wraps record + slide object in one S.mutate. */
  F.attach = function (doc, rec) {
    doc.figures = doc.figures || {};
    if (doc.figures[rec.id]) throw new Error('A figure with id ' + rec.id + ' already exists.');
    checkRoom(doc);
    doc.figures[rec.id] = rec;
    return rec;
  };
  F.detach = function (doc, id) { if (doc.figures) delete doc.figures[id]; };
  /* Slide objects that show record `id` (all slides); findObject returns the one with objId (or the first), else null. */
  F.objectsOf = function (doc, id) { const out = []; ((doc && doc.slides) || []).forEach((sl) => (sl.objects || []).forEach((o) => { if (o && o.figureId === id) out.push(o); })); return out; };
  F.findObject = function (doc, id, objId) { const o = F.objectsOf(doc, id).find((x) => !objId || x.id === objId); return o || null; };

  /* The returned records are live objects of the current document; Undo/Redo replace the document, so call get(id) again later. */
  F.create = function (kind, plotType, opts) {
    const rec = F.blank(kind, plotType, opts);
    checkRoom(S().doc);
    S().mutate((opts && opts.label) || 'New figure', (doc) => F.attach(doc, rec), { hint: hint([rec.id]) });
    return F.get(rec.id);
  };

  /* update(id, patch | fn(record), label, {coalesce, window}); patch deep-merges, fn edits the record in place. */
  F.update = function (id, changeSpec, label, opts) {
    if (!F.get(id)) throw new Error('Figure not found: ' + id);
    return S().mutate(label || 'Edit figure', (doc) => {
      const rec = doc.figures[id];
      change(rec, (r) => { if (typeof changeSpec === 'function') changeSpec(r); else merge(r, changeSpec || {}); });
      return rec;
    }, Object.assign({ hint: hint([id]) }, opts));
  };

  F.duplicate = function (id, label) {
    const src = F.get(id);
    if (!src) throw new Error('Figure not found: ' + id);
    checkRoom(S().doc);
    const copy = clone(src);
    copy.id = newId(S().doc);
    copy.name = (src.name + ' copy').slice(0, MAX_NAME);
    if (copy.composite) copy.composite.panels.forEach((p) => { if (p.record) p.record.id = newId(); });
    S().mutate(label || 'Duplicate figure', (doc) => F.attach(doc, copy), { hint: hint([copy.id]) });
    return F.get(copy.id);
  };

  /* Slide objects that point at the record: [{slideId, slideIndex, objectId}]. */
  F.referencesOf = function (id) {
    const out = [];
    ((S().doc && S().doc.slides) || []).forEach((s, i) => (s.objects || []).forEach((o) => { if (o && o.figureId === id) out.push({ slideId: s.id, slideIndex: i, objectId: o.id }); }));
    return out;
  };

  /* Deletes only an unreferenced record: { ok:true } | { ok:false, reason:'missing'|'referenced', refs }. */
  F.delete = function (id, label) {
    if (!F.get(id)) return { ok: false, reason: 'missing', refs: [] };
    const refs = F.referencesOf(id);
    if (refs.length) return { ok: false, reason: 'referenced', refs };
    S().mutate(label || 'Delete figure', (doc) => F.detach(doc, id), { hint: hint([id]) });
    return { ok: true, refs: [] };
  };

  /* Orphan collection, run by state.js on save only: removes records no slide object (or `keep` id) refers to; returns the ids. */
  F.gc = function (doc, keep) {
    const figs = doc && doc.figures;
    if (!figs) return [];
    const used = new Set(keep || []);
    (doc.slides || []).forEach((s) => (s.objects || []).forEach((o) => { if (o && o.figureId) used.add(o.figureId); }));
    const gone = Object.keys(figs).filter((id) => !used.has(id));
    gone.forEach((id) => { delete figs[id]; });
    return gone;
  };

  /* Render state of a record (or draft) after a result: a failure keeps source, config and the last good preview (s8). */
  function writeRender(rec, res) {
    const r = rec.render = rec.render || {};
    r.at = Date.now(); r.durationMs = res.durationMs; r.diagnostics = res.diagnostics;
    if (res.ok) Object.assign(r, { status: 'ok', hash: res.hash, preview: res.preview, error: null, runtime: { dpi: res.dpi, widthPx: res.widthPx, heightPx: res.heightPx, cached: res.cached } });
    else { r.error = res.message; r.status = r.preview ? 'stale' : 'error'; }
  }
  const storable = (res) => !!res && res.purpose !== 'final' && res.status !== 'cancelled';

  /* Stores a preview result in the record without an undo step. False when it was ignored: cancelled, a final render
     (never stored as render.preview), record gone, or the record changed since the request (clientHash differs). */
  F.applyRender = function (id, res) {
    const rec = F.get(id);
    if (!storable(res) || !rec || (res.clientHash && res.clientHash !== F.hash(rec))) return false;
    S().mutate('Render figure', (doc) => writeRender(doc.figures[id], res), { history: false, hint: hint([id]) });
    return true;
  };

  /* markStale(id | undefined = every record | record object): ok -> stale, without an undo step. Returns how many changed. */
  F.markStale = function (target) {
    if (target && typeof target === 'object') { if (target.render && target.render.status === 'ok') { target.render.status = 'stale'; return 1; } return 0; }
    const ids = (target === undefined ? Object.keys((S().doc && S().doc.figures) || {}) : [target]).filter((id) => { const r = F.get(id); return r && r.render && r.render.status === 'ok'; });
    if (ids.length) S().mutate('Mark figures stale', (doc) => ids.forEach((id) => { doc.figures[id].render.status = 'stale'; }), { history: false, hint: hint(ids) });
    return ids.length;
  };

  /* Draft for a dialog: cloneForEdit(id) edits a copy of a record, cloneForEdit(F.blank(...)) a new one. Nothing touches the
     document until commit(), which is one undo step; the optional `also(doc, record)` runs inside it (e.g. add the slide object). */
  F.cloneForEdit = function (source) {
    const isNew = !!source && typeof source === 'object';
    const base = isNew ? source : F.get(source);
    if (!base) throw new Error('Figure not found: ' + source);
    const draft = clone(base), start = stable(draft);
    return {
      draft, isNew,
      changed: () => stable(draft) !== start,
      set: (spec) => change(draft, (r) => { if (typeof spec === 'function') spec(r); else merge(r, spec || {}); }),
      applyRender: (res) => { if (!storable(res) || (res.clientHash && res.clientHash !== F.hash(draft))) return false; writeRender(draft, res); return true; },
      commit(label, also) {
        const id = draft.id;
        if (isNew) checkRoom(S().doc); else if (!F.get(id)) throw new Error('Figure not found: ' + id);
        return S().mutate(label || (isNew ? 'New figure' : 'Edit figure'), (doc) => {
          let rec;
          if (isNew) rec = F.attach(doc, clone(draft)); else { rec = doc.figures[id]; replaceContents(rec, clone(draft)); }
          if (also) also(doc, rec);
          return rec;
        }, { hint: also ? { full: true } : hint([id]) });
      }
    };
  };

  /* ---------- running jobs: queue state, progress chip, cancel ----------
     js/backend.js registers every job-backed request here (render, export, Python run, LaTeX). A job that runs longer than 600 ms (a
     preview: waits in the server queue, or runs > 2.5 s) gets a non-modal chip with its state ("Queued (#2)" / "… 4 s") and a Cancel
     button; the state comes from GET /api/figures/jobs/{id}, polled while the job is active. Nothing here blocks the editor. */
  const SHOW_MS = 600, SLOW_PREVIEW_MS = 2500, FIRST_POLL_MS = 350, POLL_MS = 700;
  const jobTable = new Map();   // id -> { id, label, cancel, quiet, state, position, t0, chip, timer, ended }
  F.jobs = {
    track(info) {
      const e = { id: info.id, label: info.label || 'Working', cancel: info.cancel, quiet: !!info.quiet, state: 'starting', position: null, t0: Date.now(), chip: null, timer: 0, shows: [], ended: false };
      jobTable.set(e.id, e);
      const text = () => (e.state === 'queued' ? 'Queued' + (e.position ? ' (#' + e.position + ')' : '') + ' · ' + e.label : e.label + '… ' + Math.round((Date.now() - e.t0) / 1000) + ' s');
      const maybeShow = () => {
        const age = Date.now() - e.t0;
        if (e.ended || e.chip || age < SHOW_MS - 20 || !(!e.quiet || e.state === 'queued' || age >= SLOW_PREVIEW_MS - 20)) return;
        if (typeof document !== 'undefined' && RPE.ui && RPE.ui.progressChip) e.chip = RPE.ui.progressChip({ text: text(), onCancel: () => { if (e.cancel) e.cancel(); } });
      };
      const tick = () => {
        if (e.ended) return;
        maybeShow();
        if (e.chip) e.chip.update(text());
        Promise.resolve(RPE.backend.request('figures.job', { jobId: e.id })).then((r) => {
          if (e.ended) return;
          const j = r && r.ok && r.data && r.data.job;
          if (j) { e.state = j.state; e.position = j.queuePosition || null; }
          e.timer = setTimeout(tick, POLL_MS);
        }, () => { if (!e.ended) e.timer = setTimeout(tick, POLL_MS); });
      };
      e.timer = setTimeout(tick, FIRST_POLL_MS);
      e.shows = [SHOW_MS, SLOW_PREVIEW_MS].map((ms) => setTimeout(maybeShow, ms));
      return { end() { e.ended = true; clearTimeout(e.timer); e.shows.forEach(clearTimeout); if (e.chip) e.chip.remove(); jobTable.delete(e.id); } };
    },
    /* [{ id, label, state: 'starting'|'queued'|'running'|..., position, elapsedMs }] of the jobs in flight */
    list() { return Array.from(jobTable.values()).map((e) => ({ id: e.id, label: e.label, state: e.state, position: e.position, elapsedMs: Date.now() - e.t0 })); },
    cancelAll() { Array.from(jobTable.values()).forEach((e) => { if (e.cancel) e.cancel(); }); }
  };

  /* ---------- render client ---------- */
  const inflight = new Map();   // key -> { id, purpose, key, ctrl, refs, superseded, promise }

  const FAIL_TEXT = {
    cancelled: 'The render was cancelled.', timeout: 'The figure took too long to draw.', invalid: 'The figure cannot be drawn as it is set up.',
    no_figure: 'The script did not leave a figure to draw.', missing_dependency: 'The script needs a Python package that is not installed.', error: 'The figure could not be rendered.'
  };
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  /* Server answer or transport failure -> { ok, status, message, preview, widthPx, heightPx, hash, source, diagnostics, stdout,
     stderr, durationMs, cached, dpi, purpose, clientHash, deduped }. Client-only statuses: offline, rejected (HTTP error). */
  function normalize(r, ctx) {
    const out = { ok: false, status: 'error', message: '', purpose: ctx.purpose, dpi: ctx.dpi || null, preview: null, widthPx: null, heightPx: null,
      hash: null, source: '', diagnostics: [], stdout: '', stderr: '', durationMs: null, cached: false, jobId: null, clientHash: ctx.hash, deduped: false };
    if (!r || !r.ok) {
      const code = (r && r.code) || 'rejected';
      out.status = code === 'aborted' ? 'cancelled' : code === 'timeout' ? 'timeout' : code === 'offline' ? 'offline' : 'rejected';
      out.message = (r && r.message) || FAIL_TEXT.error;
      out.diagnostics = [{ level: 'error', code: out.status, message: out.message }];
      return out;
    }
    const d = isPlain(r.data) ? r.data : {};
    out.diagnostics = Array.isArray(d.diagnostics) ? d.diagnostics : [];
    out.ok = d.ok === true && typeof d.preview === 'string' && d.preview.indexOf('data:image/') === 0;
    out.status = out.ok ? 'ok' : (typeof d.status === 'string' && d.status !== 'ok' ? d.status : 'error');
    if (out.ok) out.preview = d.preview;
    out.dpi = num(d.dpi) || out.dpi; out.widthPx = num(d.widthPx); out.heightPx = num(d.heightPx); out.durationMs = num(d.durationMs);
    out.hash = typeof d.hash === 'string' ? d.hash : null; out.source = typeof d.source === 'string' ? d.source : '';
    out.stdout = typeof d.stdout === 'string' ? d.stdout : ''; out.stderr = typeof d.stderr === 'string' ? d.stderr : '';
    out.cached = d.cached === true; out.jobId = typeof d.jobId === 'string' ? d.jobId : null;
    if (!out.ok) {
      const err = out.diagnostics.find((x) => x && x.level === 'error' && x.message);
      out.message = err ? String(err.message) : FAIL_TEXT[out.status] || FAIL_TEXT.error;
    }
    return out;
  }
  const cancelledResult = (ctx) => normalize({ ok: false, code: 'aborted', message: FAIL_TEXT.cancelled }, ctx);

  /* Renders `record` as sent (never touches the document; see applyRender). purpose 'preview' (default; the server caps it at
     150 dpi) or 'final'. Identical requests in flight share one job. A newer preview of the same record id cancels the older
     one (latest:true, default for previews). Returns a promise that always resolves, with .cancel(). */
  F.render = function (record, opts) {
    opts = opts || {};
    const purpose = opts.purpose === 'final' ? 'final' : 'preview';
    const ctx = { purpose, dpi: opts.dpi, hash: null };
    let cancel = () => {};
    let promise;
    if (!record || typeof record !== 'object') promise = Promise.resolve(Object.assign(normalize({ ok: false, code: 'rejected', message: 'There is no figure to render.' }, ctx), { status: 'invalid' }));
    else {
      ctx.hash = F.hash(record);
      const key = [record.id || '', ctx.hash, purpose, opts.dpi || ''].join('|');
      if ((opts.latest !== undefined ? opts.latest : purpose === 'preview') && record.id) {
        inflight.forEach((e) => { if (e.id === record.id && e.purpose === purpose && e.key !== key) { e.superseded = true; e.ctrl.abort(); inflight.delete(e.key); } });
      }
      let e = inflight.get(key);
      const joined = !!e;
      if (!e) {
        const ctrl = new AbortController();
        e = { id: record.id, purpose, key, ctrl, refs: 0, superseded: false };
        // the server ignores the stored preview and the raw CSV, so they are not uploaded
        const body = Object.assign({}, record, { render: { status: 'none' }, originalCsv: null });
        e.promise = RPE.backend.request('figures.render', { record: body, purpose, dpi: opts.dpi, signal: ctrl.signal, timeoutMs: opts.timeoutMs })
          .then((r) => normalize(r, ctx))
          .then((res) => { if (inflight.get(key) === e) inflight.delete(key); return res; });
        inflight.set(key, e);
      }
      e.refs++;
      promise = new Promise((resolve) => {
        let done = false;
        const finish = (res) => { if (!done) { done = true; if (opts.signal) opts.signal.removeEventListener('abort', onAbort); resolve(res); } };
        function onAbort() { cancel(); }
        cancel = () => { if (done) return; finish(cancelledResult(ctx)); if (--e.refs <= 0) { if (inflight.get(key) === e) inflight.delete(key); e.ctrl.abort(); } };
        e.promise.then((res) => finish(Object.assign({}, res, e.superseded ? { status: 'cancelled', message: 'A newer render replaced this one.' } : {}, { deduped: joined })));
        if (opts.signal) { if (opts.signal.aborted) cancel(); else opts.signal.addEventListener('abort', onAbort, { once: true }); }
      });
    }
    promise.cancel = () => cancel();
    return promise;
  };

  F.debounce = function (fn, ms) {
    let t = null, last = null;
    const run = () => { t = null; const a = last; last = null; return fn.apply(null, a); };
    const d = function () { last = arguments; clearTimeout(t); t = setTimeout(run, ms); };
    d.cancel = () => { clearTimeout(t); t = null; last = null; };
    d.flush = () => { if (t === null) return undefined; clearTimeout(t); return run(); };
    d.pending = () => t !== null;
    return d;
  };

  if (RPE.bus) RPE.bus.on('backend:status', (e) => { if (e && !e.connected) { cached = null; pending = null; gen++; } });
})(window.RPE = window.RPE || {});
