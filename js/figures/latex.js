/* latex.js — the "LaTeX / PGFPlots" window (Insert > PGFPlots, Edit Plot on a LaTeX figure): editor left, rendered page right, diagnostics below.
   Compiles only on Compile / Ctrl+Enter / Insert / Apply, through POST /api/figures/latex/{compile,render,wrapper} (contract 4u, 4v).
   No fallback renderer: without a local TeX engine the window says so. Pure helpers live on RPE.figures.latex (test 28 in tests/test_js_checks.js). */
(function (RPE) {
  'use strict';
  const F = RPE.figures = RPE.figures || {};
  const L = F.latex = {};
  const ENGINES = ['pdflatex', 'xelatex', 'lualatex'], ZOOMS = ['fit', 50, 100, 150, 200, 300, 400], MAX_IMPORT = 1048576, FINAL_DPI = 450;
  const STARTER = '\\documentclass[border=4pt]{standalone}\n\\usepackage{pgfplots}\n\\pgfplotsset{compat=newest}\n\\begin{document}\n\\begin{tikzpicture}\n' +
    '\\begin{axis}[xlabel={$x$}, ylabel={$\\sin x$}, width=8cm, height=5.5cm, grid=major]\n  \\addplot[thick, domain=0:6.28, samples=100] {sin(deg(x))};\n\\end{axis}\n\\end{tikzpicture}\n\\end{document}\n';
  const FAILED = ['compile_failed', 'render_failed', 'invalid', 'no_compiler', 'error', 'offline', 'rejected'];
  const FULLDOC = /\\documentclass|\\begin\{document\}/;
  L.STARTER = STARTER; L.ZOOMS = ZOOMS; L.ENGINES = ENGINES;

  /* ---------- pure helpers ---------- */
  L.secs = (ms) => (Math.max(0, ms) / 1000).toFixed(1) + ' s';
  L.safeName = (n) => String(n || 'figure').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'figure';
  L.dirty = (st) => st.source !== st.saved;
  L.guessMode = (src) => (/\\documentclass/.test(src || '') ? 'document' : 'fragment');
  /* chip: Idle | Compiling 3.2 s | OK 0.8 s | Failed | Timeout | No compiler */
  L.chip = function (st, now) {
    if (st.running) return { label: 'Compiling ' + L.secs((now || Date.now()) - st.t0), level: 'busy' };
    if (st.status === 'ok') return { label: 'OK ' + L.secs(st.durationMs || 0), level: 'ok' };
    if (st.status === 'timeout') return { label: 'Timeout', level: 'error' };
    if (st.status === 'no_compiler') return { label: 'No compiler', level: 'error' };
    if (FAILED.indexOf(st.status) >= 0) return { label: 'Failed', level: 'error' };
    return { label: 'Idle', level: '' };
  };
  /* the sentence that says exactly what is compiled */
  L.modeLabel = (mode) => (mode === 'fragment'
    ? 'Fragment (wrapped): your source is placed inside a standalone-class document that this app adds. Error lines refer to your source.'
    : 'Complete document: your source is compiled exactly as written. It must contain \\documentclass and \\begin{document}.');
  /* a source that cannot compile in the chosen mode: {text} or null */
  L.modeHint = function (mode, src) {
    const full = FULLDOC.test(src || '');
    if (mode === 'fragment' && full) return { text: 'This source is a complete document (it has \\documentclass or \\begin{document}). Switch Mode to Document.' };
    if (mode === 'document' && (src || '').trim() && !/\\documentclass/.test(src)) return { text: 'This source has no \\documentclass, so it will not compile as a complete document. Switch Mode to Fragment to wrap it.' };
    return null;
  };
  /* status line of the diagnostics header */
  L.statusLine = function (res) {
    if (!res) return 'Not compiled yet.';
    const t = res.durationMs != null ? ' · ' + L.secs(res.durationMs) : '', eng = res.engine ? ' · ' + res.engine : '';
    if (res.status === 'cancelled') return 'Stopped. Nothing was compiled.';
    if (res.ok) return 'Success' + t + (res.pages ? ' · ' + res.pages + (res.pages === 1 ? ' page' : ' pages') : '') + eng;
    const word = { compile_failed: 'Failed', render_failed: 'TeX finished, but the page could not be drawn', timeout: 'Timed out', no_compiler: 'No TeX compiler', invalid: 'Not compiled: invalid source' }[res.status] || 'Failed';
    return word + t + eng;
  };
  /* backend answer or transport failure -> flat result (never throws) */
  L.normalize = function (r) {
    const out = { ok: false, status: 'error', message: '', preview: null, widthPx: null, heightPx: null, dpi: null, pages: null, engine: '', log: '', errors: [], missing: [], overfull: 0,
      passes: 0, wrapped: false, wrapper: null, durationMs: null, pdf: null };
    if (!r || !r.ok) {
      const code = (r && r.code) || 'rejected';
      out.status = code === 'aborted' ? 'cancelled' : code === 'timeout' ? 'timeout' : code === 'offline' ? 'offline' : 'rejected';
      out.message = (r && r.message) || 'The LaTeX source could not be compiled.';
      return out;
    }
    const d = r.data && typeof r.data === 'object' ? r.data : {}, str = (v) => (typeof v === 'string' ? v : ''), num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    out.ok = d.ok === true && typeof d.preview === 'string' && d.preview.indexOf('data:image/') === 0;
    out.status = out.ok ? 'ok' : (typeof d.status === 'string' && d.status !== 'ok' ? d.status : 'error');
    if (out.ok) { out.preview = d.preview; out.pdf = str(d.pdfBase64) || null; }
    out.message = str(d.message); out.engine = str(d.engine); out.log = str(d.log); out.widthPx = num(d.widthPx); out.heightPx = num(d.heightPx); out.dpi = num(d.dpi);
    out.pages = num(d.pages); out.overfull = num(d.overfull) || 0; out.passes = num(d.passes) || 0; out.durationMs = num(d.durationMs); out.wrapped = d.wrapped === true;
    out.errors = Array.isArray(d.errors) ? d.errors.filter((e) => e && typeof e === 'object') : [];
    out.missing = Array.isArray(d.missing) ? d.missing.filter((e) => e && typeof e === 'object') : [];
    out.wrapper = d.wrapper && typeof d.wrapper === 'object' ? d.wrapper : null;
    if (!out.ok && !out.message) out.message = 'The LaTeX source did not produce a page.';
    return out;
  };
  /* error rows [{line|null, message, file?}]: a line is clickable only when it lies in the user's source (not in another file or the wrapper) */
  L.errorItems = function (res, src) {
    if (!res || res.ok || res.status === 'cancelled') return [];
    const n = String(src || '').split('\n').length;
    const rows = (res.errors || []).slice(0, 50).map((e) => {
      const l = Number(e.line), msg = String(e.message || 'TeX reported an error.') + (e.context ? ' — ' + String(e.context).trim() : '');
      if (e.file) return { line: null, file: String(e.file), message: String(e.file) + (Number.isInteger(l) ? ':' + l : '') + ': ' + msg };
      if (e.inWrapper) return { line: null, message: 'In the wrapper this app adds: ' + msg };
      return { line: Number.isInteger(l) && l >= 1 && l <= n ? l : null, message: msg };
    });
    if (!rows.length) rows.push({ line: null, message: res.message || 'The LaTeX source did not produce a page.' });
    return rows;
  };
  /* missing things from the log: external files (the compile runs in an empty folder), packages, fonts */
  L.missingItems = function (res) {
    const m = res && Array.isArray(res.missing) ? res.missing : [];
    return { files: m.filter((x) => x.kind === 'file'), packages: m.filter((x) => x.kind === 'package'), fonts: m.filter((x) => x.kind === 'font') };
  };
  const FILES_NOTE = 'The compile runs in an empty temporary folder, so files next to your document (\\includegraphics, \\input, \\addplot table) are not available. Put the content inline in the source.';
  L.FILES_NOTE = FILES_NOTE;
  /* compiler availability from the runtime report: {state:'unknown'|'none'|'engine_missing'|'ok', engines:[names], text} */
  L.compilerState = function (rt, engine) {
    const tex = rt && rt.tex;
    if (!tex || typeof tex !== 'object') return { state: 'unknown', engines: [], text: '' };
    const engines = ENGINES.filter((e) => tex.engines && tex.engines[e]);
    if (!engines.length) return { state: 'none', engines, text: 'No TeX compiler was found on the machine that runs this app.' };
    if (engines.indexOf(engine) < 0) return { state: 'engine_missing', engines, text: engine + ' was not found. Choose one of the detected engines.' };
    return { state: 'ok', engines, text: '' };
  };
  /* preview zoom: pixel width of the shown image, or null for Fit (100 % = the preview's own pixels) */
  L.zoomWidth = (zoom, widthPx) => (zoom === 'fit' || !(widthPx > 0) ? null : Math.round(widthPx * zoom / 100));
  L.zoomLabel = (z) => (z === 'fit' ? 'Fit' : z + '%');
  /* what Export .tex writes: the complete compilable file */
  L.texFile = function (mode, src, wrapperRes) { return mode === 'fragment' ? (wrapperRes && wrapperRes.ok ? wrapperRes.tex : null) : src; };
  /* stale detection: is the last good compile still the compile of exactly this source / mode / engine? */
  L.fresh = (g, s) => !!g && g.source === s.source && g.mode === s.mode && g.engine === s.engine;
  /* the image Export PNG / Insert make: native = the PDF page size, else width in inches with the page aspect kept */
  L.plan = (g, o) => {
    const w = g && (g.pageWIn || (g.widthPx && g.dpi ? g.widthPx / g.dpi : 0)), hh = g && (g.pageHIn || (g.heightPx && g.dpi ? g.heightPx / g.dpi : 0));
    return w > 0 && hh > 0 ? F.exportpanel.fitPage(w, hh, o.native, o.wIn, o.dpi) : null;
  };
  L.bgState = (_rt) => ({ ok: false, reason: 'Transparent PNG is not available for LaTeX figures: the rasterizer (pdftoppm) always renders on a white background. Export as PDF for a vector format.' });
  /* last compile summary kept in the record */
  L.summary = (res, at) => ({ engine: res.engine || 'pdflatex', pages: res.pages || null, passes: res.passes || 0, overfull: res.overfull || 0, durationMs: res.durationMs == null ? null : Math.round(res.durationMs), at,
    pageWIn: res.widthPx && res.dpi ? Math.round(res.widthPx / res.dpi * 1000) / 1000 : null, pageHIn: res.heightPx && res.dpi ? Math.round(res.heightPx / res.dpi * 1000) / 1000 : null });
  /* files the source refers to (listed in the record; never stored, the compile runs in an empty folder) */
  L.assets = function (src) {
    const text = String(src || '').replace(/(^|[^\\])%.*$/gm, '$1'), out = [], seen = {};
    const scan = (re, kind) => { let m; while ((m = re.exec(text))) { const n = m[1].trim(); if (n && n[0] !== '\\' && n.length <= 200 && !seen[n] && out.length < 50) { seen[n] = 1; out.push({ name: n, kind }); } } };
    scan(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g, 'image');
    scan(/\\(?:input|include|InputIfFileExists)\s*\{([^}]*)\}/g, 'tex');
    scan(/\\pgfplotstableread\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g, 'data');
    scan(/\\addplot3?\+?\s*(?:\[[^\]]*\])?\s*table\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g, 'data');
    return out;
  };
  L.bytes = (b64) => { const bin = atob(String(b64).replace(/^data:[^,]*,/, '')), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  L.newRecord = function (name, src, mode, engine) {
    const rec = F.blank('latex', 'line', { name }); rec.source = src; rec.latex = { mode, engine }; return rec;
  };

  /* ---------- the window ---------- */
  let tplCache = null;
  L.open = function (opts) {
    opts = opts || {};
    const h = RPE.h, U = RPE.ui, S = RPE.store;
    /* edit: a plot object backed by a kind:'latex' record, or an older PGFPlots object that only carries `source` (Apply upgrades it) */
    const obj0 = opts.obj || null, found = obj0 && obj0.figureId ? F.get(obj0.figureId) : null, rec0 = found && found.kind === 'latex' ? found : null;
    const legacy = !!(obj0 && !found && typeof obj0.source === 'string' && obj0.source.trim()), editing = !!rec0 || legacy;
    const autoAlt = (n) => 'LaTeX figure: ' + n + '.';
    const src0 = rec0 ? rec0.source : legacy ? obj0.source : STARTER;
    const st = { source: src0, saved: src0, name: rec0 ? rec0.name : legacy ? (obj0.name || 'LaTeX figure') : 'LaTeX figure',
      mode: rec0 ? rec0.latex.mode : legacy ? L.guessMode(src0) : 'document', engine: rec0 ? rec0.latex.engine : 'pdflatex',
      dpi: rec0 ? rec0.export.dpi : FINAL_DPI, native: rec0 ? !!rec0.latex.native : true, wIn: rec0 ? rec0.export.wIn : 6, bg: rec0 ? rec0.export.background : 'white', sizeErr: '', plan: null, rawRt: null, alt: editing && obj0.alt && obj0.alt !== autoAlt(rec0 ? rec0.name : '') ? obj0.alt : '',
      running: false, t0: 0, status: 'idle', durationMs: null, res: null, good: null, job: null, closing: false, zoom: 'fit', rt: null, wrapperOpen: false, wrapperRes: null };
    const btn = (label, fn, cls) => h('button', { type: 'button', class: 'btn btn--sm' + (cls ? ' ' + cls : ''), onclick: fn }, label);
    let timer = null, wtimer = null;

    /* ----- editor ----- */
    let errShown = false;
    const ed = F.codeEditor({ language: 'latex', value: st.source, label: 'LaTeX source', onRun: () => { compile(); return true; },
      onChange: (v) => { st.source = v; if (errShown) { ed.setErrors([]); errShown = false; } paintPreview(); paintMode(); if (st.wrapperOpen) { clearTimeout(wtimer); wtimer = setTimeout(loadWrapper, 400); } } });
    const msg = h('div', { class: 'fe__hint ltx__msg', role: 'status' });
    const say = (t, level) => { msg.textContent = t || ''; msg.className = 'fe__hint ltx__msg' + (level ? ' is-' + level : ''); };
    say('Nothing is compiled until you press Compile. Compiling runs TeX on your computer: shell escape is off, but this is not a sandbox.');

    /* ----- toolbar ----- */
    const chip = h('span', { class: 'chip ltx__chip' }, 'Idle'), ann = F.a11y ? F.a11y.announcer('LaTeX compile') : null;
    const bTpl = btn('Template ▾', () => templateMenu(bTpl));
    const modeBtns = {};
    const modeBox = h('div', { class: 'fe__zoom ltx__seg', role: 'group', 'aria-label': 'Mode' }, h('span', { class: 'ltx__lab' }, 'Mode:'));
    [['document', 'Document'], ['fragment', 'Fragment (wrapped)']].forEach(([id, label]) => {
      modeBtns[id] = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-pressed': 'false', onclick: () => { st.mode = id; if (id === 'document') st.wrapperOpen = false; paintMode(); paintPreview(); } }, label); modeBox.append(modeBtns[id]);
    });
    const engSel = h('select', { class: 'select ltx__eng', 'aria-label': 'Engine', onchange: () => { st.engine = engSel.value; paintMode(); paintPreview(); } },
      ENGINES.map((e) => h('option', { value: e }, e)));
    const bRun = btn('Compile', () => compile(), 'btn--primary'), bStop = btn('Stop', () => stop()), bSave = btn('Save Source', () => saveSource()), bTex = btn('Export .tex', () => exportTex());
    bRun.title = 'Compile (Ctrl+Enter)'; bStop.hidden = true;
    bSave.title = 'Save the source exactly as written';
    if (F.a11y) { F.a11y.tip(bRun, 'Compile the source', 'Ctrl+Enter'); F.a11y.tip(bStop, 'Stop the running compile'); F.a11y.tip(bSave, 'Save the source exactly as written', 'Ctrl+S'); } bTex.title = 'Save a complete .tex file you can compile yourself (a fragment includes the wrapper)';
    const bar = h('div', { class: 'fe__bar ltx__bar' }, bTpl, modeBox, engSel, bRun, bStop, h('span', { class: 'py__sp' }), chip, bSave);

    /* ----- mode label, hint, wrapper ----- */
    const modeText = h('span', { class: 'ltx__modetext' }), bWrap = btn('View wrapper', () => toggleWrapper());
    const hint = h('div', { class: 'fe__hint is-warn ltx__hint', role: 'status', hidden: true });
    const wrapPre = h('pre', { class: 'log ltx__wrap', hidden: true }), wrapNote = h('div', { class: 'fe__hint', hidden: true });
    const modeRow = h('div', { class: 'ltx__moderow' }, modeText, bWrap);
    function paintMode() {
      ENGINES.forEach((e, i) => { const o = engSel.children[i], ok = !st.rt || st.rt.engines.indexOf(e) >= 0 || st.rt.state === 'unknown'; if (o) { o.disabled = !ok; o.textContent = ok ? e : e + ' (not found)'; } });
      engSel.value = st.engine;
      Object.keys(modeBtns).forEach((k) => modeBtns[k].setAttribute('aria-pressed', String(st.mode === k)));
      modeText.textContent = L.modeLabel(st.mode);
      bWrap.disabled = st.mode !== 'fragment'; bWrap.title = st.mode === 'fragment' ? '' : 'Document mode adds no wrapper.';
      bWrap.textContent = st.wrapperOpen ? 'Hide wrapper' : 'View wrapper';
      const hn = L.modeHint(st.mode, st.source); hint.hidden = !hn; hint.textContent = hn ? hn.text : '';
      wrapPre.hidden = wrapNote.hidden = !(st.wrapperOpen && st.mode === 'fragment');
      paintChip();
    }
    async function loadWrapper() {
      const r = await RPE.backend.request('figures.latex.wrapper', { source: ed.getValue() });
      if (st.closing || !st.wrapperOpen) return;
      const d = r && r.ok && r.data ? r.data : null; st.wrapperRes = d;
      if (!d) { wrapPre.textContent = (r && r.message) || 'The wrapper could not be loaded.'; wrapNote.textContent = ''; return; }
      if (!d.ok || !d.wrapper) { wrapPre.textContent = d.message || 'There is no wrapper for this source.'; wrapNote.textContent = ''; return; }
      const n = ed.getValue().split('\n').length;
      wrapPre.textContent = d.wrapper.prefix + '% ---- your source: ' + n + (n === 1 ? ' line' : ' lines') + ' ----\n' + d.wrapper.suffix;
      wrapNote.textContent = 'This is the complete file that is compiled. The wrapper adds ' + d.wrapper.lineOffset + ' lines above your source; error lines already count from the first line of your source.';
    }
    function toggleWrapper() { st.wrapperOpen = !st.wrapperOpen; paintMode(); if (st.wrapperOpen) { wrapPre.textContent = 'Loading…'; loadWrapper(); } }

    /* ----- preview + zoom ----- */
    const img = h('img', { class: 'fe__img ltx__img', alt: 'Rendered first page of the LaTeX source', hidden: true });
    const empty = h('div', { class: 'fe__hint ltx__empty' }, 'Press Compile (Ctrl+Enter) to render the page.');
    const pbadge = h('div', { class: 'fe__badge', role: 'status', hidden: true });
    const pinfo = h('div', { class: 'fe__hint' });
    const frame = h('div', { class: 'fe__frame ltx__frame' }, pbadge, img, empty);
    const zoomBtns = {}, zoomBox = h('div', { class: 'fe__zoom ltx__zoom', role: 'group', 'aria-label': 'Preview zoom' });
    ZOOMS.forEach((z) => { zoomBtns[z] = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-pressed': 'false', onclick: () => { st.zoom = z; paintPreview(); } }, L.zoomLabel(z)); zoomBox.append(zoomBtns[z]); });
    const zoomRow = h('div', { class: 'ltx__zoomrow' }, h('span', { class: 'fe__hint' }, 'Preview zoom — not export resolution'), zoomBox);
    const altIn = h('input', { class: 'input', type: 'text', id: 'ltxalt', maxlength: 300, 'aria-label': 'Alt text', oninput: () => { st.alt = altIn.value; } });
    altIn.value = st.alt;
    const altRow = h('div', { class: 'ltx__alt' }, h('label', { for: 'ltxalt', class: 'fe__hint' }, 'Alt text: describe what the figure shows, for screen readers. Left empty, the figure name is used.'), altIn);
    const sameAs = (g) => L.fresh(g, st);

    /* ----- export bar: PDF / .tex / PNG; size, dpi and background are shared by Export PNG and Insert / Apply ----- */
    const DPIS = [150, 300, 450, 600], SIDE = [0.5, 30], fmtIn = (n) => String(Math.round(n * 100) / 100), lab = (t, f) => h('label', { class: 'fe__hint', for: f }, t);
    const bPdf = btn('Export compiled PDF', () => exportPdf()), bPng = btn('Export PNG', () => exportPng());
    bPdf.title = 'Save the PDF TeX produced from the current source (compiled first when the source changed)';
    const natBox = h('input', { type: 'checkbox', id: 'ltxnat', onchange: () => { st.native = natBox.checked; const p0 = st.good && L.plan(st.good, { native: true, dpi: st.dpi }); if (!st.native && p0) st.wIn = Math.round(p0.wIn * 100) / 100; st.sizeErr = ''; paintExport(); } });
    const wBox = h('input', { type: 'text', inputmode: 'decimal', class: 'input ltx__num', id: 'ltxw', 'aria-label': 'Width in inches', oninput: () => sizeInput('w') });
    const hBox = h('input', { type: 'text', inputmode: 'decimal', class: 'input ltx__num', id: 'ltxh', 'aria-label': 'Height in inches', oninput: () => sizeInput('h') });
    const dpiSel = h('select', { class: 'select ltx__dpi', id: 'ltxdpi', 'aria-label': 'DPI', onchange: () => { st.dpi = +dpiSel.value; paintExport(); } },
      (DPIS.indexOf(st.dpi) >= 0 ? DPIS : DPIS.concat(st.dpi).sort((a, b) => a - b)).map((d) => h('option', { value: String(d) }, String(d))));
    const optTransparent = h('option', { value: 'transparent' }, 'Transparent');
    const bgSel = h('select', { class: 'select ltx__bg', id: 'ltxbg', 'aria-label': 'Background', onchange: () => { st.bg = bgSel.value; paintExport(); } }, h('option', { value: 'white' }, 'White'), optTransparent);
    const expRead = h('div', { class: 'fe__hint ltx__expread', role: 'status' });
    const expBar = h('div', { class: 'ltx__export' }, h('div', { class: 'fe__bar ltx__expbtns' }, bPdf, bTex, bPng),
      h('div', { class: 'ltx__expsize' }, natBox, lab('Native size (PDF page)', 'ltxnat'), lab('Width', 'ltxw'), wBox, lab('in ×', 'ltxh'), hBox, lab('in', 'ltxh'), lab('DPI', 'ltxdpi'), dpiSel, lab('Background', 'ltxbg'), bgSel), expRead);
    const sizeBlocked = () => !!st.sizeErr || !!(st.plan && st.plan.refused);
    function paintExport(typing) {
      const bg = L.bgState(st.rawRt), g = st.good, pg = g ? L.plan(g, { native: true, dpi: st.dpi }) : null;
      optTransparent.disabled = !bg.ok; optTransparent.title = bg.ok ? '' : bg.reason;
      if (!bg.ok && st.bg === 'transparent') st.bg = 'white';
      bgSel.value = st.bg; natBox.checked = st.native; dpiSel.value = String(st.dpi);
      st.plan = pg && !st.sizeErr ? L.plan(g, { native: st.native, wIn: st.wIn, dpi: st.dpi }) : null;
      wBox.disabled = st.native; hBox.disabled = st.native || !pg;
      if (!typing) { wBox.value = st.native && pg ? fmtIn(pg.wIn) : fmtIn(st.wIn); hBox.value = st.plan ? fmtIn(st.plan.hIn) : ''; wBox.setAttribute('aria-invalid', 'false'); hBox.setAttribute('aria-invalid', 'false'); }
      const err = st.sizeErr || (st.plan && st.plan.refused ? st.plan.warning : '');
      expRead.textContent = err || (!pg ? 'Compile once to see the page size; Export PNG and Insert compile first when the source changed.' :
        (st.native ? 'Native size: ' : '') + F.exportpanel.readout(st.plan.wIn, st.plan.hIn, st.dpi).replace(' = ', st.native ? ' ≈ ' : ' = ') + (st.plan.warning ? ' · ' + st.plan.warning : '') + (st.bg === 'transparent' ? ' · transparent background' : ''));
      expRead.className = 'fe__hint ltx__expread' + (err ? ' is-error' : '');
      paintChip();
    }
    function sizeInput(which) {
      const box = which === 'w' ? wBox : hBox, raw = box.value.trim().replace(',', '.'), v = /^(\d+\.?\d*|\.\d+)$/.test(raw) ? parseFloat(raw) : NaN, pg = st.good && L.plan(st.good, { native: true, dpi: st.dpi });
      const w = which === 'w' ? v : (pg ? v * pg.aspect : NaN), hh = pg ? w / pg.aspect : v, ok = w >= SIDE[0] && w <= SIDE[1] && !(hh < SIDE[0] || hh > SIDE[1]);
      box.setAttribute('aria-invalid', String(!ok));
      if (ok) { st.sizeErr = ''; st.wIn = w; (which === 'w' ? hBox : wBox).value = which === 'w' ? (pg ? fmtIn(hh) : '') : fmtIn(w); }
      else st.sizeErr = 'Width and height must be ' + SIDE[0] + '–' + SIDE[1] + ' in; the height follows the page aspect.';
      paintExport(true);
    }
    function paintPreview() {
      const g = st.good, r = st.res, failed = !!r && !r.ok && r.status !== 'cancelled', stale = !!g && !sameAs(g);
      img.hidden = !g; empty.hidden = !!g;
      if (g) { img.src = g.preview; const w = L.zoomWidth(st.zoom, g.widthPx); img.style.width = w ? w + 'px' : ''; img.style.maxWidth = w ? 'none' : '100%'; }
      img.className = 'fe__img ltx__img' + (g && (failed || stale) ? ' is-dim' : '') + (st.zoom === 'fit' ? ' ltx__img--fit' : '');
      frame.className = 'fe__frame ltx__frame' + (st.zoom === 'fit' ? '' : ' is-zoomed');
      pbadge.hidden = !g || !(failed || stale);
      pbadge.textContent = failed ? 'Does not match source: the latest compile failed. Showing the last good image.' : stale ? 'Does not match source: the source, mode or engine changed since this image was drawn.' : '';
      pinfo.textContent = g ? g.widthPx + ' × ' + g.heightPx + ' px preview (first page' + (g.pages > 1 ? ' of ' + g.pages : '') + ')' : '';
      ZOOMS.forEach((z) => zoomBtns[z].setAttribute('aria-pressed', String(st.zoom === z)));
      paintExport();
    }

    /* ----- compiler panel ----- */
    const nocomp = h('div', { class: 'pd__status is-error ltx__nocomp', role: 'alert', hidden: true });
    function paintCompiler() {
      const cs = st.rt || { state: 'unknown', engines: [], text: '' }, r = st.res, noComp = cs.state === 'none' || (r && r.status === 'no_compiler');
      nocomp.textContent = '';
      if (noComp) {
        const list = cs.engines.length ? cs.engines.join(', ') : 'none';
        nocomp.append(h('strong', null, 'LaTeX cannot be compiled here.'), h('div', null, 'A local TeX installation is required (TeX Live, MiKTeX or MacTeX) with pdflatex, xelatex or lualatex on the PATH of the machine that runs this app. ' +
          'This app has no other way to render LaTeX and never downloads TeX.'), h('div', null, 'Detected engines (from /runtime): ' + list + '.' + (r && r.status === 'no_compiler' && r.message ? ' ' + r.message : '')),
          btn('Check again', async () => { say('Checking for TeX…'); if (F.refresh) { try { await F.refresh(); } catch (e) { /* reported below */ } } await readRuntime(); say(''); }));
      }
      nocomp.hidden = !noComp; paintChip();
    }
    async function readRuntime() {
      let rt = null; try { rt = F.runtime ? await F.runtime() : null; } catch (e) { rt = null; }
      st.rawRt = rt; st.rt = L.compilerState(rt, st.engine); paintMode(); paintCompiler(); paintExport();
    }

    /* ----- diagnostics ----- */
    const statusLine = h('span', { class: 'ltx__status' }, 'Not compiled yet.');
    const errBox = h('div', { class: 'py__errs', role: 'alert', hidden: true });
    const missBox = h('div', { class: 'fe__hint ltx__miss', hidden: true });
    const noteBox = h('div', { class: 'fe__hint ltx__notes' });
    const logPre = h('pre', { class: 'log ltx__log' }), rawSum = h('summary', null, 'Raw log'), raw = h('details', { class: 'fe__details', hidden: true }, rawSum, logPre);
    const out = h('details', { class: 'fe__details ltx__out' }, h('summary', null, 'Diagnostics: ', statusLine), errBox, missBox, noteBox, raw);
    function paintOutput() {
      const r = st.res, items = L.errorItems(r, st.source), mi = L.missingItems(r);
      statusLine.textContent = L.statusLine(r);
      errBox.textContent = '';
      items.forEach((it) => errBox.append(it.line ? h('button', { type: 'button', class: 'py__err', onclick: () => ed.jumpToLine(it.line) }, 'Line ' + it.line + ': ' + it.message) : h('span', { class: 'py__err' }, it.message)));
      errBox.hidden = !items.length;
      missBox.textContent = '';
      const rows = [];
      if (mi.files.length) rows.push(h('div', null, h('strong', null, 'Missing external files: '), mi.files.map((m) => m.file || m.message).join(', ') + '. ' + FILES_NOTE));
      mi.packages.forEach((m) => rows.push(h('div', null, h('strong', null, 'Missing package: '), m.message)));
      mi.fonts.forEach((m) => rows.push(h('div', null, h('strong', null, 'Missing font: '), m.message)));
      missBox.append(...rows); missBox.hidden = !rows.length;
      const notes = []; if (r && r.overfull) notes.push(r.overfull + ' overfull ' + (r.overfull === 1 ? 'box' : 'boxes')); if (r && r.passes > 1) notes.push(r.passes + ' TeX passes');
      noteBox.textContent = r && r.ok ? (notes.length ? 'Notes: ' + notes.join(' · ') : 'No problems found.') : r && r.status === 'cancelled' ? 'Compile stopped. The server may finish the run in the background (60 s at most).' : '';
      logPre.textContent = r ? r.log : ''; raw.hidden = !(r && r.log);
      if (r && !r.ok && r.status !== 'cancelled') out.open = true;
    }
    function jumpMarks() {
      const rows = L.errorItems(st.res, st.source).filter((i) => i.line);
      ed.setErrors(rows.map((i) => ({ line: i.line, message: i.message }))); errShown = rows.length > 0;
    }

    /* ----- chip / running ----- */
    const busy = () => st.running;
    function paintChip() {
      const c = L.chip({ running: st.running, t0: st.t0, status: st.status, durationMs: st.durationMs });
      chip.textContent = c.label; chip.className = 'chip ltx__chip' + (c.level ? ' is-' + c.level : ''); if (ann) ann.say(c.label);
      const cs = st.rt && st.rt.state, blocked = cs === 'none' || cs === 'engine_missing';
      bRun.disabled = busy() || blocked;
      if (blocked) bRun.title = cs === 'none' ? 'No TeX compiler was found.' : st.engine + ' was not found; choose another engine.'; else if (F.a11y) bRun.removeAttribute('title'); else bRun.title = 'Compile (Ctrl+Enter)';
      bStop.hidden = !st.running; const sb = sizeBlocked(), ins = dlg && dlg.buttons.insert; if (ins) ins.disabled = busy() || blocked || sb;
      bPdf.disabled = busy() || blocked; bPng.disabled = busy() || blocked || sb;
    }
    function begin(label) {
      st.running = true; st.t0 = Date.now(); st.res = null; ed.setErrors([]); errShown = false; say(label || '');
      clearInterval(timer); timer = setInterval(paintChip, 200); paintChip(); paintOutput();
    }
    function end(res, snap) {
      clearInterval(timer); st.running = false; st.job = null; st.res = res; st.durationMs = res.durationMs; st.status = res.status === 'cancelled' ? 'idle' : res.status;
      if (res.ok) st.good = { preview: res.preview, widthPx: res.widthPx, heightPx: res.heightPx, dpi: res.dpi || 150, pages: res.pages, source: snap.source, mode: snap.mode, engine: snap.engine, pdf: res.pdf,
      pageWIn: res.widthPx / (res.dpi || 150), pageHIn: res.heightPx / (res.dpi || 150), compile: L.summary(res, Date.now()) };
      jumpMarks(); paintChip(); paintPreview(); paintOutput(); paintCompiler();
    }
    const snap = () => ({ source: ed.getValue(), mode: st.mode, engine: st.engine });
    const request = (name, s, extra, ctrl) => RPE.backend.request(name, Object.assign({ source: s.source, mode: s.mode, engine: s.engine, signal: ctrl.signal }, extra)).then(L.normalize);
    async function compile() {
      if (busy() || bRun.disabled) return;
      const s = snap(), ctrl = new AbortController(); st.job = { ctrl }; begin();
      const res = await request('figures.latex.compile', s, { dpi: 150 }, ctrl);
      if (st.closing) return;
      end(res, s); if (res.status === 'cancelled') say('Stopped waiting for the compile.');
    }
    function stop() { if (st.job) { st.job.ctrl.abort(); say('Stopping…'); } }

    /* ----- templates / import ----- */
    function setSource(text, name, mode, engine, note) {
      ed.setValue(text); st.source = text; st.saved = text; st.name = name; st.mode = mode; st.engine = engine; say(note || '', note ? 'warn' : ''); paintMode(); paintPreview();
    }
    async function replaceOk(what) { return !L.dirty(st) || U.confirm({ title: 'Replace the source?', message: 'The source has changes that were not inserted or saved. ' + what + ' replaces it.', confirmLabel: 'Replace', danger: true }); }
    async function templateMenu(anchor) {
      const list = h('div', { class: 'pyw__menu' }, h('div', { class: 'fe__hint' }, 'Loading templates…'));
      U.popover(anchor, list, { role: 'menu' });
      const fill = (children) => { list.textContent = ''; list.append(...children); };
      if (!tplCache) { const r = await RPE.backend.request('figures.latex.templates', {}); if (r && r.ok && r.data && Array.isArray(r.data.templates)) tplCache = r.data.templates; else { fill([h('div', { class: 'fe__hint is-error' }, (r && r.message) || 'Templates could not be loaded.')]); return; } }
      const items = tplCache.map((t) => h('button', { type: 'button', class: 'pyw__item', role: 'menuitem', onclick: async () => {
        U.closeAll(); if (await replaceOk('The ' + t.name + ' template')) setSource(t.source, t.name, t.mode || 'document', t.engine || 'pdflatex', 'Template loaded. It has not been compiled.'); } },
        h('strong', null, t.name), h('span', { class: 'fe__hint' }, t.description || '')));
      const file = h('input', { type: 'file', accept: '.tex,.txt,text/x-tex,text/plain', hidden: true, onchange: async () => {
        const f = file.files && file.files[0]; if (!f) return;
        if (f.size > MAX_IMPORT) { say('That file is larger than 1 MB, so it was not opened.', 'error'); return; }
        const text = await f.text(); if (await replaceOk('The file ' + f.name)) setSource(text, f.name.replace(/\.[^.]*$/, '') || 'LaTeX figure', L.guessMode(text), st.engine, 'Imported ' + f.name + '. It has not been compiled.'); } });
      items.push(h('button', { type: 'button', class: 'pyw__item', role: 'menuitem', onclick: () => { U.closeAll(); file.click(); } }, h('strong', null, 'Open .tex file…'), h('span', { class: 'fe__hint' }, 'Imported files are never compiled automatically.')), file);
      fill(items);
    }

    /* ----- save / export ----- */
    function save(blob, filename) {
      const a = document.createElement('a'), url = URL.createObjectURL(blob); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    function saveSource() { const s = ed.getValue(), name = L.safeName(st.name) + '.tex'; save(new Blob([s], { type: 'application/x-tex' }), name); st.saved = s; say('Saved ' + name + ' (source as written).', 'ok'); }
    async function exportTex() {
      const s = ed.getValue(), name = L.safeName(st.name) + '.tex';
      let wr = null;
      if (st.mode === 'fragment') { const r = await RPE.backend.request('figures.latex.wrapper', { source: s }); wr = r && r.ok && r.data ? r.data : { ok: false, message: (r && r.message) || 'The wrapper could not be loaded.' }; }
      const text = L.texFile(st.mode, s, wr);
      if (text == null) { say('Nothing was exported. ' + (wr && wr.message ? wr.message : ''), 'error'); return; }
      save(new Blob([text], { type: 'application/x-tex' }), name); say('Saved ' + name + (st.mode === 'fragment' ? ' (with the wrapper, ready to compile).' : '.'), 'ok');
    }

    /* ----- shared by Export PDF / PNG and Insert / Apply: recompile only when the source, mode or engine changed since the last good compile ----- */
    async function ensureCompiled(s) {
      s = s || snap(); if (L.fresh(st.good, s) && st.good.pdf) return st.good;
      const ctrl = new AbortController(); st.job = { ctrl }; begin('Compiling the current source…');
      const res = await request('figures.latex.compile', s, { dpi: 150 }, ctrl);
      if (st.closing) return null;
      end(res, s); return res.ok ? st.good : null;
    }
    /* the final PNG comes from the compiled PDF at the chosen size: native = the page size, else width in inches with the aspect kept */
    const finalRender = (g, ctrl) => RPE.backend.request('figures.latex.render', Object.assign({ pdfBase64: g.pdf, mode: g.mode, engine: g.engine, dpi: st.dpi, background: st.bg, signal: ctrl.signal }, st.native ? {} : { wIn: st.wIn })).then(L.normalize);
    function failed(what) { const r = st.res, stopped = r && r.status === 'cancelled'; say(stopped ? 'Stopped. Nothing was ' + what + '.' : 'Nothing was ' + what + '. ' + (r && r.message ? r.message : ''), stopped ? '' : 'error'); }
    async function exportPdf() {
      if (busy() || bPdf.disabled) return;
      if (!ed.getValue().trim()) { say('The source is empty.', 'error'); return; }
      const g = await ensureCompiled(); if (!g) { failed('exported'); return; }
      const name = L.safeName(st.name) + '.pdf'; save(new Blob([L.bytes(g.pdf)], { type: 'application/pdf' }), name); say('Saved ' + name + ' (compiled from the current source).', 'ok');
    }
    async function exportPng() {
      if (busy() || bPng.disabled) return;
      if (!ed.getValue().trim()) { say('The source is empty.', 'error'); return; }
      const s = snap(), g = await ensureCompiled(s); if (!g) { failed('exported'); return; }
      const ctrl = new AbortController(); st.job = { ctrl }; begin('Drawing the PNG…');
      const res = await finalRender(g, ctrl); if (st.closing) return;
      if (!res.ok) { end(res, s); failed('exported'); return; }
      clearInterval(timer); st.running = false; st.job = null; st.status = 'ok'; st.durationMs = res.durationMs; paintChip();
      const name = L.safeName(st.name) + '.png'; save(new Blob([L.bytes(res.preview)], { type: 'image/png' }), name);
      say('Saved ' + name + ': ' + res.widthPx + ' × ' + res.heightPx + ' px at ' + (res.dpi || st.dpi) + ' dpi' + (st.bg === 'transparent' ? ', transparent background.' : '.'), 'ok');
    }

    /* ----- insert in slide / apply: recompile if stale, then the final PNG from the compiled PDF; on failure nothing changes ----- */
    async function insert() {
      if (busy() || (dlg && dlg.buttons.insert && dlg.buttons.insert.disabled)) return;
      const verb = editing ? 'changed' : 'inserted', s = snap();
      if (!s.source.trim()) { say('The source is empty.', 'error'); return; }
      if (rec0 && (!F.get(rec0.id) || !F.findObject(S.doc, rec0.id, obj0.id))) { say('This figure is no longer in the document. Nothing was changed.', 'error'); return; }
      const g = await ensureCompiled(s); if (!g) { failed(verb); return; }
      const ctrl = new AbortController(); st.job = { ctrl }; begin('Drawing the final image…');
      const res = await finalRender(g, ctrl);
      if (st.closing) return;
      if (!res.ok) { end(res, s); failed(verb); return; }
      clearInterval(timer); st.running = false; st.job = null; st.status = 'ok'; st.durationMs = res.durationMs;
      try {
        const aspect = res.widthPx / res.heightPx, alt = (st.alt || '').trim() || autoAlt(st.name);
        const draft = F.cloneForEdit(rec0 ? rec0.id : F.blank('latex', 'line', { name: st.name }));
        const rdpi = res.dpi || st.dpi, side = (px) => Math.min(30, Math.max(0.5, Math.round(px / rdpi * 1000) / 1000));
        draft.set((r) => { r.source = s.source; r.name = st.name; r.latex = { mode: s.mode, engine: s.engine, native: st.native, lastCompile: g.compile, assets: L.assets(s.source) };
          Object.assign(r.export, { wIn: side(res.widthPx), hIn: side(res.heightPx), dpi: st.dpi, format: 'png', background: st.bg }); });
        draft.draft.render = Object.assign(draft.draft.render || {}, { status: 'ok', hash: res.hash || null, at: Date.now(), durationMs: res.durationMs, error: null, diagnostics: [],
          runtime: { dpi: res.dpi || st.dpi, widthPx: res.widthPx, heightPx: res.heightPx, cached: false }, preview: g.preview });
        const phys = res.widthPx / (res.dpi || st.dpi);
        if (rec0) {
          draft.commit('Edit LaTeX figure', (doc) => F.objectsOf(doc, rec0.id).forEach((o) => {
            Object.assign(o, { src: res.preview, aspect, h: Math.round(o.w / aspect), name: st.name }); if (o.id === obj0.id) o.alt = alt;   // x, y, w stay
          }));
        } else if (legacy) {
          draft.commit('Edit PGFPlots figure', (doc) => {
            let o = null; doc.slides.forEach((sl) => (sl.objects || []).forEach((x) => { if (x.id === obj0.id) o = x; }));
            if (!o) throw new Error('This figure is no longer in the document.');
            delete o.engine; delete o.source; Object.assign(o, { figureId: draft.draft.id, src: res.preview, aspect, h: Math.round(o.w / aspect), name: st.name, alt });
          });
        } else {
          const slide = S.activeSlide(); if (!slide) throw new Error('There is no slide to insert the figure into.');
          const pl = F.exportpanel.placement(aspect, phys, S.doc.size);
          const nobj = Object.assign({ id: S.uid('o'), type: 'plot', figureId: draft.draft.id, src: res.preview, aspect }, pl, { alt, name: st.name });
          draft.commit('Insert LaTeX figure', (doc) => { doc.slides.find((x) => x.id === slide.id).objects.push(nobj); });
          S.select([nobj.id]); S.setUI({ activeTab: 'plotTools' });
        }
        st.saved = s.source; st.closing = true; dlg.close(verb);
      } catch (err) { st.status = 'error'; paintChip(); say('Nothing was ' + verb + '. ' + (err && err.message ? err.message : 'The figure could not be saved.'), 'error'); }
    }

    /* ----- dialog, close guard ----- */
    const body = h('div', { class: 'ltx' }, bar, modeRow, hint, wrapPre, wrapNote, nocomp,
      h('div', { class: 'ltx__main' }, h('div', { class: 'pyw__col' }, h('div', { class: 'py__wrap ltx__ed' }, ed.el), msg,
        h('div', { class: 'fe__hint' }, h('a', { href: (RPE.backend ? RPE.backend.getBaseUrl() : '') + '/security', target: '_blank', rel: 'noopener' }, 'Security notes: what running TeX here does and does not protect'))),
        h('div', { class: 'pyw__col' }, zoomRow, frame, pinfo, expBar, altRow)), out, ann ? ann.el : null);
    const dlg = U.dialog({ title: editing ? 'Edit LaTeX figure' : 'LaTeX / PGFPlots figure', icon: 'sigma', width: 1180, fit: true, class: 'dlg--plot dlg--ltx scroll-burgundy', body, focus: '.ce__ta',
      buttons: [{ label: 'Close' }, { label: editing ? 'Apply' : 'Insert in slide', kind: 'primary', id: 'insert', onClick: () => { insert(); return false; } }],
      onClose: () => { st.closing = true; clearInterval(timer); clearTimeout(wtimer); if (st.job) st.job.ctrl.abort(); U.closeAll(); ed.destroy(); } });
    const realClose = dlg.close;
    dlg.close = function (v) {
      if (st.closing || !L.dirty(st)) return realClose(v);
      U.dialog({ title: editing ? 'Close without applying?' : 'Close without inserting?', icon: 'triangle-alert', width: 440, dismiss: 'backdrop', focus: '.btn--primary',
        body: h('p', { class: 'dlg__text' }, editing ? 'This source has changes that were not applied to the figure or saved as .tex.' : 'This source has changes that were not inserted into a slide or saved as .tex.'),
        buttons: [{ label: 'Keep editing', kind: 'primary', value: 'keep' }, { label: 'Save Source', value: 'save', onClick: () => { save(new Blob([ed.getValue()], { type: 'application/x-tex' }), L.safeName(st.name) + '.tex'); } }, { label: 'Discard', kind: 'danger', value: 'discard' }] })
        .done.then((a) => { if (a === 'save' || a === 'discard') { st.closing = true; realClose(v); } });
    };
    dlg.el.addEventListener('keydown', (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter' && !(ev.target && ev.target.closest && ev.target.closest('.ce'))) { ev.preventDefault(); compile(); } });
    if (F.a11y) { F.a11y.keys(dlg, { save: () => saveSource() }); F.a11y.panes(dlg, ['.ltx__bar', '.ce', '.ltx__zoom', '.ltx__out', '.dlg__foot']); F.a11y.tip(dlg.buttons.insert, editing ? 'Apply to the figure' : 'Insert in the slide'); }
    const rr = rec0 && rec0.render, rt = rr && rr.runtime;
    const lc = rec0 && rec0.latex.lastCompile, lcOk = !!(lc && lc.pageWIn && lc.pageHIn);
    if (rr && rr.status === 'ok' && rr.preview && (lcOk || (rt && rt.widthPx && rt.heightPx))) {   // the saved picture is shown, never re-drawn on open (no PDF is kept: the next export compiles)
      st.good = lcOk ? { preview: rr.preview, widthPx: Math.round(lc.pageWIn * 150), heightPx: Math.round(lc.pageHIn * 150), dpi: 150, pageWIn: lc.pageWIn, pageHIn: lc.pageHIn, pages: lc.pages, source: st.source, mode: st.mode, engine: st.engine, pdf: null, compile: lc }
        : { preview: rr.preview, widthPx: rt.widthPx, heightPx: rt.heightPx, dpi: rt.dpi || 150, pages: null, source: st.source, mode: st.mode, engine: st.engine, pdf: null, compile: null };
    }
    paintMode(); paintPreview(); paintOutput(); paintCompiler(); readRuntime();
    return dlg;
  };
})(window.RPE);
