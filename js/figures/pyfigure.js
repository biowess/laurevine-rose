/* pyfigure.js — the "Python Plot" window (Insert > Python Plot): code editor left, preview right, collapsible output below.
   Runs only on Run / Ctrl+Enter / Export file / Insert (after the one-time trust notice); never on open, paste or import.
   Runs go through POST /api/figures/python/run (contract section 4r). Pure helpers live on RPE.figures.pyfigure (tested in tests/test_js_checks.js, 26). */
(function (RPE) {
  'use strict';
  const F = RPE.figures = RPE.figures || {};
  const P = F.pyfigure = {};
  const MIN_IN = 0.5, MAX_IN = 30, MIN_DPI = 72, MAX_DPI = 1200, DPIS = [150, 300, 450, 600], MAX_IMPORT = 1048576;
  const STARTER = "import numpy as np\nimport matplotlib.pyplot as plt\n\nx = np.linspace(0, 2 * np.pi, 200)\nfig, ax = plt.subplots(figsize=(6, 4))\nax.plot(x, np.sin(x))\nax.set_xlabel('x')\nax.set_ylabel('sin(x)')\n";
  const TRUST = 'Scripts run on your computer with your permissions; this is not a sandbox.';
  const FAILED = ['error', 'invalid', 'no_figure', 'offline', 'rejected'];
  const session = P.session = { ack: false, quiet: false };   // trust notice: once per page session

  /* ---------- pure helpers ---------- */
  P.STARTER = STARTER; P.TRUST = TRUST;
  P.secs = (ms) => (Math.max(0, ms) / 1000).toFixed(1) + 's';
  P.needsNotice = () => !session.ack && !session.quiet;
  /* status chip: Idle | Running 3.2s | OK 0.8s | Error | Timeout | Missing dependency */
  P.chip = function (st, now) {
    if (st.running) return { label: 'Running ' + P.secs((now || Date.now()) - st.t0), level: 'busy' };
    if (st.status === 'ok') return { label: 'OK ' + P.secs(st.durationMs || 0), level: 'ok' };
    if (st.status === 'timeout') return { label: 'Timeout', level: 'error' };
    if (st.status === 'missing_dependency') return { label: 'Missing dependency', level: 'error' };
    if (FAILED.indexOf(st.status) >= 0) return { label: 'Error', level: 'error' };
    return { label: 'Idle', level: '' };
  };
  P.dirty = (st) => st.source !== st.saved;
  P.safeName = (n) => String(n || 'figure').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'figure';
  const runId = () => 'py' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const inchText = (n) => { const s = (+n).toFixed(2); return s.replace(/0$/, '').replace(/\.0$/, '.0'); };

  /* backend answer or transport failure -> flat result (never throws) */
  P.normalize = function (r) {
    const out = { ok: false, status: 'error', message: '', preview: null, widthPx: null, heightPx: null, dpi: null, hash: null, stdout: '', stderr: '', diagnostics: [],
      warnings: [], figuresFound: 0, traceback: null, missingModule: null, durationMs: null };
    if (!r || !r.ok) {
      const code = (r && r.code) || 'rejected';
      out.status = code === 'aborted' ? 'cancelled' : code === 'timeout' ? 'timeout' : code === 'offline' ? 'offline' : 'rejected';
      out.message = (r && r.message) || 'The script could not be run.';
      return out;
    }
    const d = r.data && typeof r.data === 'object' ? r.data : {}, str = (v) => (typeof v === 'string' ? v : ''), num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    out.diagnostics = Array.isArray(d.diagnostics) ? d.diagnostics : []; out.warnings = Array.isArray(d.warnings) ? d.warnings.map(String) : [];
    out.ok = d.ok === true && typeof d.preview === 'string' && d.preview.indexOf('data:image/') === 0;
    out.status = out.ok ? 'ok' : (typeof d.status === 'string' && d.status !== 'ok' ? d.status : 'error');
    if (out.ok) out.preview = d.preview;
    out.widthPx = num(d.widthPx); out.heightPx = num(d.heightPx); out.dpi = num(d.dpi); out.hash = str(d.hash) || null; out.durationMs = num(d.durationMs);
    out.stdout = str(d.stdout); out.stderr = str(d.stderr); out.figuresFound = num(d.figuresFound) || 0;
    out.traceback = d.traceback && typeof d.traceback === 'object' ? d.traceback : null;
    out.missingModule = d.missingModule && typeof d.missingModule === 'object' ? d.missingModule : null;
    if (!out.ok) {
      const err = out.diagnostics.find((x) => x && x.level === 'error' && x.message);
      out.message = (out.missingModule && out.missingModule.message) || (err && String(err.message)) || 'The script did not produce a figure.';
    }
    return out;
  };
  /* error panel rows: [{line|null, message}] (a line is only kept when it lies inside the script) */
  P.errorItems = function (res, src) {
    if (!res || res.ok || res.status === 'cancelled') return [];
    const n = String(src || '').split('\n').length, tb = res.traceback, l = tb ? Number(tb.line) : NaN;
    const line = Number.isInteger(l) && l >= 1 && l <= n ? l : null;
    if (res.missingModule) return [{ line, message: res.missingModule.message }];
    if (tb && tb.message) return [{ line, message: String(tb.message) }];
    return [{ line: null, message: res.message || 'The script did not produce a figure.' }];
  };
  /* Export popover rules. exp {override,wIn,hIn,dpi,format,background}; scriptSize = [w,h] inches read from the last run, or null.
     via 'export' = POST /export (the script keeps its size); via 'run' = a final python/run with sizeIn (PNG only). */
  P.exportPlan = function (exp, scriptSize) {
    const X = F.exportpanel, bad = (reason) => ({ ok: false, reason, via: exp.override ? 'run' : 'export', size: null, text: '' });
    if (!(exp.dpi >= MIN_DPI && exp.dpi <= MAX_DPI) || exp.dpi !== Math.round(exp.dpi)) return bad('DPI must be a whole number from ' + MIN_DPI + ' to ' + MAX_DPI + '.');
    let size = scriptSize || null;
    if (exp.override) {
      if (!(exp.wIn >= MIN_IN && exp.wIn <= MAX_IN && exp.hIn >= MIN_IN && exp.hIn <= MAX_IN)) return bad('Width and height must be between ' + MIN_IN + ' and ' + MAX_IN + ' in.');
      size = [exp.wIn, exp.hIn];
      if (exp.format === 'pdf') return bad('PDF export keeps the size set in the script. Turn off the size override or export PNG.');
    }
    if (!size) return { ok: true, reason: '', via: 'export', size: null, text: 'Run the script once to read its figure size.' };
    const px = X.pixels(size[0], size[1], exp.dpi), text = X.readout(size[0], size[1], exp.dpi);
    if (px.refused) return { ok: false, reason: px.warning, via: exp.override ? 'run' : 'export', size, text, warning: px.warning };
    return { ok: true, reason: '', via: exp.override ? 'run' : 'export', size, text, warning: px.warning || '' };
  };
  P.newRecord = function (name, src, exp) {
    const rec = F.blank('python', 'line', { name }); rec.source = src;
    Object.assign(rec.export, { dpi: exp.dpi, format: exp.format, background: exp.background }); return rec;
  };

  /* ---------- the window ---------- */
  let tplCache = null;
  P.open = function (opts) {
    opts = opts || {};
    const h = RPE.h, U = RPE.ui, S = RPE.store;
    /* edit mode (opts.obj = a plot object backed by a kind:'python' record): the saved script opens as is, nothing runs */
    const obj0 = opts.obj || null, rec0 = obj0 && obj0.figureId ? F.get(obj0.figureId) : null, editing = !!(rec0 && rec0.kind === 'python');
    const autoAlt = (n) => 'Python figure: ' + n + '.';
    const st = { source: editing ? rec0.source : STARTER, saved: editing ? rec0.source : STARTER, name: editing ? rec0.name : 'Python figure',
      alt: editing && obj0.alt && obj0.alt !== autoAlt(rec0.name) ? obj0.alt : '', running: false, t0: 0, status: 'idle', durationMs: null, res: null, good: null, job: null,
      seq: 0, xjob: null, scriptSize: null, afterNotice: null, closing: false,
      exp: { override: false, wIn: 6, hIn: 4, dpi: editing ? rec0.export.dpi : 450, format: editing ? rec0.export.format : 'png', background: editing ? rec0.export.background : 'white' } };
    const btn = (label, fn, cls) => h('button', { type: 'button', class: 'btn btn--sm' + (cls ? ' ' + cls : ''), onclick: fn }, label);
    let timer = null, xtimer = null;

    /* ----- editor ----- */
    let errShown = false;
    const ed = F.codeEditor({ language: 'python', value: st.source, label: 'Python script', onRun: () => { gate(run); return true; },
      onChange: (v) => { st.source = v; if (errShown) { ed.setErrors([]); errShown = false; } paintPreview(); } });
    const msg = h('div', { class: 'fe__hint pyw__msg', role: 'status' });
    const say = (t, level) => { msg.textContent = t || ''; msg.className = 'fe__hint pyw__msg' + (level ? ' is-' + level : ''); };
    ed.textarea.addEventListener('paste', () => say('Pasted code has not been run. Read it first, then press Run.', 'warn'));

    /* ----- toolbar ----- */
    const chip = h('span', { class: 'chip pyw__chip' }, 'Idle'), ann = F.a11y ? F.a11y.announcer('Python run') : null, badge = h('span', { class: 'chip', title: 'Python runtime used for runs' }, 'Matplotlib …');
    const bTpl = btn('Template ▾', () => templateMenu(bTpl)), bRun = btn('Run', () => gate(run), 'btn--primary'), bStop = btn('Stop', () => stop());
    const bClear = btn('Clear Output', () => { st.res = null; st.status = 'idle'; ed.setErrors([]); errShown = false; paintOutput(); paintPreview(); paintChip(); say(''); }), bReset = btn('Reset Preview', () => resetPreview());
    const bExp = btn('Export ▾', () => exportPopover(bExp));
    bRun.title = 'Run (Ctrl+Enter)'; bStop.hidden = true;
    if (F.a11y) { F.a11y.tip(bRun, 'Run the script', 'Ctrl+Enter'); F.a11y.tip(bStop, 'Stop the running script'); }
    const bar = h('div', { class: 'fe__bar pyw__bar' }, bTpl, bRun, bStop, bClear, bReset, h('span', { class: 'py__sp' }), chip, badge, bExp);
    if (F.runtime) F.runtime().then((rt) => { badge.textContent = rt ? (rt.matplotlib ? 'Matplotlib ' + rt.matplotlib : 'Matplotlib not installed') : 'Runtime unknown'; }).catch(() => {});

    /* ----- trust notice (once per session) ----- */
    const quietBox = h('input', { type: 'checkbox', id: 'pywq' });
    const notice = h('div', { class: 'pd__status is-warn pyw__notice', role: 'alertdialog', 'aria-label': 'Before the first run', hidden: true },
      h('span', { class: 'pyw__ntext' }, TRUST + ' ', h('a', { href: (RPE.backend ? RPE.backend.getBaseUrl() : '') + '/security', target: '_blank', rel: 'noopener' }, 'Security notes')), h('label', { class: 'pyw__nq', for: 'pywq' }, quietBox, " Don't show again this session"),
      btn('Cancel', () => { if (quietBox.checked) session.quiet = true; st.afterNotice = null; notice.hidden = true; ed.focus(); }),
      btn('Run', () => { session.ack = true; if (quietBox.checked) session.quiet = true; notice.hidden = true; const f = st.afterNotice; st.afterNotice = null; if (f) f(); }, 'btn--primary'));
    function gate(fn) {
      if (busy()) return;
      if (P.needsNotice()) { st.afterNotice = fn; notice.hidden = false; const b = notice.querySelector && notice.querySelector('.btn--primary'); if (b) b.focus(); return; }
      fn();
    }
    const busy = () => st.running || !!st.xjob;

    /* ----- preview ----- */
    const img = h('img', { class: 'fe__img pyw__img', alt: 'Preview of the figure the script draws', hidden: true });
    const empty = h('div', { class: 'fe__hint pyw__empty' }, 'Press Run (Ctrl+Enter) to draw the figure.');
    const pbadge = h('div', { class: 'fe__badge', role: 'status', hidden: true });
    const pinfo = h('div', { class: 'fe__hint' });
    const multi = h('div', { class: 'fe__hint pyw__multi' });
    const altIn = h('input', { class: 'input', type: 'text', id: 'pywalt', maxlength: 300, 'aria-label': 'Alt text', oninput: () => { st.alt = altIn.value; } });
    altIn.value = st.alt;
    const altRow = h('div', { class: 'pyw__alt' }, h('label', { for: 'pywalt', class: 'fe__hint' }, 'Alt text: describe what the figure shows, for screen readers. Left empty, the figure name is used.'), altIn);
    const frame = h('div', { class: 'fe__frame pyw__frame' }, pbadge, img, empty);
    function paintPreview() {
      const g = st.good, r = st.res, failed = !!r && !r.ok && r.status !== 'cancelled', stale = !!g && (g.sig !== sig() || g.source !== st.source);
      img.hidden = !g; empty.hidden = !!g;
      if (g) {
        img.src = g.preview; img.alt = 'Preview of the figure the script draws';
      } else {
        empty.textContent = (r && r.status === 'no_figure') ? 'The script did not leave a figure to draw. Create a figure with plt.subplots() or plt.figure().'
          : (r && !r.ok) ? (r.message || 'The script could not produce a figure.')
          : 'Press Run (Ctrl+Enter) to draw the figure.';
      }
      img.className = 'fe__img pyw__img' + (g && (failed || stale) ? ' is-dim' : '');
      pbadge.hidden = !g || !(failed || stale);
      pbadge.textContent = failed ? 'Last good image: the latest run failed' : stale ? 'Script or settings changed since this image was drawn' : '';
      pinfo.textContent = g ? g.widthPx + ' × ' + g.heightPx + ' px preview · ' + inchText(g.widthPx / g.dpi) + ' × ' + inchText(g.heightPx / g.dpi) + ' in' : '';
      const n = r && r.figuresFound > 1 ? r.warnings.find((w) => /figures created/.test(w)) : '';
      multi.textContent = (n ? n + '. ' : '') + 'Only one figure is used: the lowest-numbered open pyplot figure. Build panels with plt.subplots(); extra figures are ignored.';
      multi.className = 'fe__hint pyw__multi' + (n ? ' is-warn' : '');
    }
    function resetPreview() {
      if (busy()) return;
      st.good = null; st.res = null; st.status = 'idle'; st.durationMs = null; st.scriptSize = null; ed.setErrors([]); errShown = false;
      paintPreview(); paintOutput(); paintChip(); say('Preview cleared. The script is unchanged.'); syncExport();
    }

    /* ----- output ----- */
    const errBox = h('div', { class: 'py__errs', role: 'alert', hidden: true });
    const diagBox = h('div', { class: 'fe__hint pyw__diag' });
    const outPre = h('pre', { class: 'log pyw__log' }), errPre = h('pre', { class: 'log pyw__log' });
    const outLab = h('div', { class: 'pd__h' }, 'Standard output'), rawSum = h('summary', null, 'Raw traceback / standard error'), raw = h('details', { class: 'fe__details' }, rawSum, errPre);
    const out = h('details', { class: 'fe__details pyw__out' }, h('summary', null, 'Output'), errBox, diagBox, outLab, outPre, raw);
    function paintOutput() {
      const r = st.res, items = P.errorItems(r, st.source), ok = !!r && r.ok;
      errBox.textContent = '';
      items.forEach((it) => errBox.append(it.line
        ? h('button', { type: 'button', class: 'py__err', onclick: () => ed.jumpToLine(it.line) }, 'Line ' + it.line + ': ' + it.message)
        : h('span', { class: 'py__err' }, it.message)));
      errBox.hidden = !items.length;
      const notes = r ? r.diagnostics.filter((d) => d && d.level !== 'error' && d.message).map((d) => d.message) : [];
      diagBox.textContent = notes.length ? 'Notes: ' + notes.join(' · ') : (r && r.status === 'cancelled' ? 'The run was stopped.' : !r ? 'No output yet.' : ok ? 'No problems found.' : '');
      outPre.textContent = r ? r.stdout : ''; outLab.hidden = outPre.hidden = !(r && r.stdout);
      errPre.textContent = r ? r.stderr : ''; raw.hidden = !(r && r.stderr);
      if (r && (items.length || r.stdout || notes.length)) out.open = true;
      if (items.length && r.stderr) raw.open = false;
    }
    function jumpMarks() {
      const items = P.errorItems(st.res, st.source).filter((i) => i.line);
      ed.setErrors(items.map((i) => ({ line: i.line, message: i.message }))); errShown = items.length > 0;
    }

    /* ----- chip ----- */
    function paintChip() {
      const c = P.chip({ running: st.running, t0: st.t0, status: st.status, durationMs: st.durationMs });
      chip.textContent = c.label; chip.className = 'chip pyw__chip' + (c.level ? ' is-' + c.level : ''); if (ann) ann.say(c.label);
      bRun.disabled = busy(); bStop.hidden = !st.running; bReset.disabled = busy(); const ins = dlg && dlg.buttons.insert; if (ins) ins.disabled = busy();
    }

    /* ----- running ----- */
    const sig = () => JSON.stringify([st.exp.override ? [st.exp.wIn, st.exp.hIn] : null, st.exp.background]);
    const sizeIn = () => { const e = st.exp; return e.override && e.wIn >= MIN_IN && e.wIn <= MAX_IN && e.hIn >= MIN_IN && e.hIn <= MAX_IN ? [e.wIn, e.hIn] : null; };
    function request(purpose, source, dpi, ctrl, jobId) {
      return RPE.backend.request('figures.python.run', { source, purpose, dpi, background: st.exp.background, sizeIn: sizeIn(), jobId, signal: ctrl.signal }).then(P.normalize);
    }
    function begin(label) {
      st.running = true; st.t0 = Date.now(); st.res = null; ed.setErrors([]); errShown = false; say(label || '');
      clearInterval(timer); timer = setInterval(paintChip, 200); paintChip(); paintOutput();
    }
    function end(res, source) {
      clearInterval(timer); st.running = false; st.job = null; st.res = res; st.durationMs = res.durationMs;
      st.status = res.status === 'cancelled' ? 'idle' : res.status;
      if (res.ok) {
        st.good = { preview: res.preview, widthPx: res.widthPx, heightPx: res.heightPx, dpi: res.dpi || 150, hash: res.hash, source, sig: sig(), durationMs: res.durationMs };
        st.scriptSize = sizeIn() ? st.scriptSize : [res.widthPx / (res.dpi || 150), res.heightPx / (res.dpi || 150)];
      }
      jumpMarks(); paintChip(); paintPreview(); paintOutput(); syncExport();
    }
    async function run() {
      if (busy()) return;
      const source = ed.getValue(), jobId = runId(), ctrl = new AbortController();
      st.job = { id: jobId, ctrl }; begin();
      const res = await request('preview', source, 150, ctrl, jobId);
      if (st.closing) return;
      end(res, source); if (res.status === 'cancelled') say('Run stopped.');
    }
    function stop() {
      const j = st.job; if (!j) return;
      RPE.backend.request('figures.python.cancel', { jobId: j.id }).then(() => setTimeout(() => j.ctrl.abort(), 1500));
      say('Stopping…');
    }

    /* ----- templates / import ----- */
    function setScript(text, name, note) {
      ed.setValue(text); st.source = text; st.saved = text; st.name = name; say(note || '', note ? 'warn' : ''); paintPreview();
    }
    async function replaceOk(what) { return !P.dirty(st) || U.confirm({ title: 'Replace the script?', message: 'The script has changes that were not inserted or saved. ' + what + ' replaces it.', confirmLabel: 'Replace', danger: true }); }
    async function templateMenu(anchor) {
      const list = h('div', { class: 'pyw__menu' }, h('div', { class: 'fe__hint' }, 'Loading templates…'));
      U.popover(anchor, list, { role: 'menu' });
      const fill = (children) => { list.textContent = ''; list.append(...children); };
      if (!tplCache) { const r = await RPE.backend.request('figures.python.templates', {}); if (r && r.ok && r.data && Array.isArray(r.data.templates)) tplCache = r.data.templates; else { fill([h('div', { class: 'fe__hint is-error' }, (r && r.message) || 'Templates could not be loaded.')]); return; } }
      const items = tplCache.map((t) => h('button', { type: 'button', class: 'pyw__item', role: 'menuitem', onclick: async () => {
        U.closeAll(); if (await replaceOk('The ' + t.name + ' template')) setScript(t.source, t.name, 'Template loaded. It has not been run.'); } },
        h('strong', null, t.name), h('span', { class: 'fe__hint' }, t.description || '')));
      const file = h('input', { type: 'file', accept: '.py,.txt,text/x-python,text/plain', hidden: true, onchange: async () => {
        const f = file.files && file.files[0]; if (!f) return;
        if (f.size > MAX_IMPORT) { say('That file is larger than 1 MB, so it was not opened.', 'error'); return; }
        const text = await f.text(); if (await replaceOk('The file ' + f.name)) setScript(text, f.name.replace(/\.[^.]*$/, '') || 'Python figure', 'Imported ' + f.name + '. It has not been run: read it, then press Run.'); } });
      items.push(h('button', { type: 'button', class: 'pyw__item', role: 'menuitem', onclick: () => { U.closeAll(); file.click(); } }, h('strong', null, 'Open .py file…'), h('span', { class: 'fe__hint' }, 'Imported scripts are never run automatically.')), file);
      fill(items);
    }

    /* ----- export popover ----- */
    const xs = { status: h('div', { class: 'pd__status', role: 'status' }), readout: h('div', { class: 'pd__status', role: 'status' }), warn: h('div', { class: 'pd__status is-warn', role: 'alert', hidden: true }) };
    const seg = (items, get, set, label) => {
      const box = h('div', { class: 'fe__zoom xp__seg', role: 'group', 'aria-label': label }), bs = {};
      items.forEach((it) => { bs[it.id] = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-pressed': 'false', onclick: () => set(it.id) }, it.label); box.append(bs[it.id]); });
      box.sync = () => items.forEach((it) => bs[it.id].setAttribute('aria-pressed', String(get() === it.id)));
      return box;
    };
    const num = (label, step) => h('input', { class: 'input', type: 'number', step, 'aria-label': label });
    const wI = num('Width (in)', 'any'), hI = num('Height (in)', 'any'), dI = num('Custom DPI', 1), ovr = h('input', { type: 'checkbox', id: 'pywo' });
    const sizeNote = h('div', { class: 'fe__hint' });
    const segs = [seg([{ id: 'png', label: 'PNG' }, { id: 'pdf', label: 'PDF' }], () => st.exp.format, (v) => { st.exp.format = v; syncExport(); }, 'File format'),
      seg(DPIS.map((d) => ({ id: d, label: String(d) })), () => st.exp.dpi, (v) => { st.exp.dpi = v; syncExport(); }, 'DPI preset'),
      seg([{ id: 'white', label: 'White' }, { id: 'transparent', label: 'Transparent' }], () => st.exp.background, (v) => { st.exp.background = v; syncExport(); paintPreview(); }, 'Background')];
    const bFile = btn('Export file…', () => { U.closeAll(); gate(exportFile); }, 'btn--primary'), bPy = btn('Export .py', () => exportPy()), bXc = btn('Cancel', () => { if (st.xjob) { RPE.backend.request('figures.python.cancel', { jobId: st.xjob.id }); st.xjob.ctrl.abort(); } });
    bXc.hidden = true;
    const bindNum = (el, key) => el.addEventListener('change', () => { const v = el.value.trim() === '' ? NaN : Number(el.value); st.exp[key] = v; syncExport(); paintPreview(); });
    bindNum(wI, 'wIn'); bindNum(hI, 'hIn'); bindNum(dI, 'dpi');
    ovr.addEventListener('change', () => { st.exp.override = ovr.checked; if (ovr.checked && st.scriptSize) { st.exp.wIn = +st.scriptSize[0].toFixed(2); st.exp.hIn = +st.scriptSize[1].toFixed(2); } syncExport(); paintPreview(); });
    const field = (label, el) => h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), el);
    const xpanel = h('div', { class: 'xp pyw__xp' },
      h('div', { class: 'pd__h' }, 'Size'), sizeNote, h('label', { class: 'pyw__nq', for: 'pywo' }, ovr, ' Override script size'), h('div', { class: 'pd__row' }, field('Width (in)', wI), field('Height (in)', hI)),
      h('div', { class: 'pd__h' }, 'Format'), segs[0], h('div', { class: 'pd__h' }, 'Resolution'), segs[1], h('div', { class: 'pd__row' }, field('Custom DPI (72–1200)', dI)),
      h('div', { class: 'pd__h' }, 'Background'), segs[2], xs.readout, xs.warn,
      h('div', { class: 'xp__actions' }, bFile, bPy, bXc), xs.status,
      h('div', { class: 'fe__hint' }, 'Export file runs the script again. Export .py saves the script as written; a size override is not part of the .py file.'));
    function syncExport() {
      const e = st.exp, plan = P.exportPlan(e, st.scriptSize), act = typeof document !== 'undefined' ? document.activeElement : null;
      [[wI, e.wIn], [hI, e.hIn], [dI, e.dpi]].forEach(([el, v]) => { if (el !== act) el.value = isFinite(v) ? v : ''; });
      ovr.checked = e.override; wI.disabled = hI.disabled = !e.override;
      wI.title = hI.title = e.override ? '' : 'The figsize in your script sets the size.';
      sizeNote.textContent = e.override ? 'The figure is resized after the script runs; the script text is not changed.' : st.scriptSize ? 'Set by the script (figsize): ' + inchText(st.scriptSize[0]) + ' × ' + inchText(st.scriptSize[1]) + ' in. Read-only.' : 'The script sets the size with figsize. Run it once to see the size here.';
      segs.forEach((s) => s.sync());
      xs.readout.textContent = plan.text || plan.reason; xs.warn.hidden = !(plan.reason || plan.warning); xs.warn.textContent = plan.reason || plan.warning || '';
      xs.warn.className = 'pd__status ' + (plan.ok ? 'is-warn' : 'is-error');
      const b = busy(); bFile.disabled = b || !plan.ok; bPy.disabled = b; bXc.hidden = !st.xjob; bRun.disabled = b; paintChip();
    }
    function exportPopover(anchor) { syncExport(); U.popover(anchor, xpanel, { role: 'dialog', class: 'pyw__pop', nested: false }); }
    const xsay = (t, level) => { xs.status.textContent = t || ''; xs.status.className = 'pd__status' + (level ? ' is-' + level : ''); };
    function save(blob, filename) {
      const a = document.createElement('a'), url = URL.createObjectURL(blob); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
    async function withX(label, fn) {
      const job = { id: runId(), ctrl: new AbortController() }, t0 = Date.now(); st.xjob = job;
      const tick = () => xsay(label + '… ' + Math.round((Date.now() - t0) / 1000) + ' s', 'busy'); tick(); clearInterval(xtimer); xtimer = setInterval(tick, 1000); syncExport();
      try { await fn(job); } finally { clearInterval(xtimer); st.xjob = null; syncExport(); }
    }
    async function exportFile() {
      const plan = P.exportPlan(st.exp, st.scriptSize), src = ed.getValue(), e = st.exp;
      if (!plan.ok) { xsay(plan.reason, 'error'); return; }
      await withX('Rendering ' + e.format.toUpperCase(), async (job) => {
        if (plan.via === 'run') {
          const res = await request('final', src, e.dpi, job.ctrl, job.id);
          if (!res.ok) { xsay(res.status === 'cancelled' ? 'Cancelled. No file was saved.' : res.message, res.status === 'cancelled' ? '' : 'error'); return; }
          const blob = await (await fetch(res.preview)).blob(), name = P.safeName(st.name) + '.png'; save(blob, name); xsay('Saved ' + name + ' (' + kb(blob.size) + ').', 'ok'); return;
        }
        const rec = P.newRecord(st.name, src, e), r = await RPE.backend.request('figures.export', { record: Object.assign({}, rec, { render: { status: 'none' }, originalCsv: null }), format: e.format, dpi: e.dpi, background: e.background, save: true, signal: job.ctrl.signal });
        if (r.ok) xsay('Saved ' + r.filename + ' (' + kb(r.size) + ').', 'ok'); else xsay(r.code === 'aborted' ? 'Cancelled. No file was saved.' : r.message, r.code === 'aborted' ? '' : 'error');
      });
    }
    async function exportPy() {
      const src = ed.getValue(), e = st.exp;
      await withX('Writing the Python file', async (job) => {
        const rec = P.newRecord(st.name, src, e), r = await RPE.backend.request('figures.export', { record: Object.assign({}, rec, { render: { status: 'none' }, originalCsv: null }), format: 'py', dpi: e.dpi, save: true, signal: job.ctrl.signal });
        if (r.ok) { st.saved = src; xsay('Saved ' + r.filename + ' (' + kb(r.size) + ').', 'ok'); } else xsay(r.code === 'aborted' ? 'Cancelled. No file was saved.' : r.message, r.code === 'aborted' ? '' : 'error');
      });
    }

    /* ----- insert in slide / apply to the figure: final render of the CURRENT script; on failure nothing changes ----- */
    async function insert() {
      if (busy()) return;
      const verb = editing ? 'changed' : 'inserted';
      const source = ed.getValue(), e = st.exp, plan = P.exportPlan(Object.assign({}, e, { format: 'png' }), st.scriptSize), jobId = runId(), ctrl = new AbortController();
      if (!source.trim()) { say('The script is empty.', 'error'); return; }
      if (!plan.ok && plan.reason) { say(plan.reason, 'error'); return; }
      if (editing && (!F.get(rec0.id) || !F.findObject(S.doc, rec0.id, obj0.id))) { say('This figure is no longer in the document. Nothing was changed.', 'error'); return; }
      st.job = { id: jobId, ctrl }; begin('Drawing the final image…');
      const res = await request('final', source, e.dpi, ctrl, jobId);
      if (st.closing) return;
      if (!res.ok) { end(res, source); say(res.status === 'cancelled' ? 'Stopped. Nothing was ' + verb + '.' : 'Nothing was ' + verb + '. ' + res.message, res.status === 'cancelled' ? '' : 'error'); return; }
      clearInterval(timer); st.running = false; st.job = null; st.status = 'ok'; st.durationMs = res.durationMs;
      try {
        const g = st.good, reuse = !!g && g.source === source && g.sig === sig(), aspect = res.widthPx / res.heightPx, alt = (st.alt || '').trim() || autoAlt(st.name);
        const draft = F.cloneForEdit(editing ? rec0.id : F.blank('python', 'line', { name: st.name }));
        draft.set((r) => { r.source = source; r.name = st.name; Object.assign(r.export, { dpi: e.dpi, format: e.format, background: e.background }); });
        /* render summary of the FINAL image; the stored preview is the preview run of this exact script, else none (final images are never render.preview) */
        draft.draft.render = Object.assign(draft.draft.render || {}, { status: 'ok', hash: res.hash, at: Date.now(), durationMs: res.durationMs, error: null, diagnostics: res.diagnostics || [],
          runtime: { dpi: res.dpi || e.dpi, widthPx: res.widthPx, heightPx: res.heightPx, cached: !!res.cached }, preview: reuse ? g.preview : null });
        if (editing) {
          draft.commit('Edit Python plot', (doc) => F.objectsOf(doc, rec0.id).forEach((o) => {
            Object.assign(o, { src: res.preview, aspect, h: Math.round(o.w / aspect), name: st.name }); if (o.id === obj0.id) o.alt = alt;   // x, y, w stay
          }));
        } else {
          const slide = S.activeSlide(); if (!slide) throw new Error('There is no slide to insert the plot into.');
          const pl = F.exportpanel.placement(aspect, res.widthPx / (res.dpi || e.dpi), S.doc.size);
          const nobj = Object.assign({ id: S.uid('o'), type: 'plot', figureId: draft.draft.id, src: res.preview, aspect }, pl, { alt, name: st.name });
          draft.commit('Insert Python plot', (doc) => { doc.slides.find((s) => s.id === slide.id).objects.push(nobj); });
          S.select([nobj.id]); S.setUI({ activeTab: 'plotTools' });
        }
        st.saved = source; st.closing = true; dlg.close(verb);
      } catch (err) { st.status = 'error'; paintChip(); say('Nothing was ' + verb + '. ' + (err && err.message ? err.message : 'The figure could not be saved.'), 'error'); }
    }

    /* ----- dialog, close guard ----- */
    const body = h('div', { class: 'pyw' }, bar, notice,
      h('div', { class: 'pyw__main' }, h('div', { class: 'pyw__col' }, h('div', { class: 'py__wrap pyw__ed' }, ed.el), msg),
        h('div', { class: 'pyw__col' }, frame, pinfo, multi, altRow)), out, ann ? ann.el : null);
    const dlg = U.dialog({ title: editing ? 'Edit Python plot' : 'Python plot', icon: 'terminal', width: 1180, fit: true, class: 'dlg--plot dlg--pyw scroll-burgundy', body, focus: '.ce__ta',
      buttons: [{ label: 'Close' }, { label: editing ? 'Apply' : 'Insert in slide', kind: 'primary', id: 'insert', onClick: () => { gate(insert); return false; } }],
      onClose: () => { st.closing = true; clearInterval(timer); clearInterval(xtimer); if (st.job) { RPE.backend.request('figures.python.cancel', { jobId: st.job.id }); st.job.ctrl.abort(); } if (st.xjob) st.xjob.ctrl.abort(); U.closeAll(); ed.destroy(); } });
    const realClose = dlg.close;
    dlg.close = function (v) {
      if (st.closing || !P.dirty(st)) return realClose(v);
      U.dialog({ title: editing ? 'Close without applying?' : 'Close without inserting?', icon: 'triangle-alert', width: 440, dismiss: 'backdrop', focus: '.btn--primary',
        body: h('p', { class: 'dlg__text' }, (editing ? 'This script has changes that were not applied to the figure or exported as .py.' : 'This script has changes that were not inserted into a slide or exported as .py.')),
        buttons: [{ label: 'Keep editing', kind: 'primary', value: 'keep' }, { label: 'Save .py', value: 'save', onClick: () => { save(new Blob([ed.getValue()], { type: 'text/x-python' }), P.safeName(st.name) + '.py'); } }, { label: 'Discard', kind: 'danger', value: 'discard' }] })
        .done.then((a) => { if (a === 'save' || a === 'discard') { st.closing = true; realClose(v); } });
    };
    dlg.el.addEventListener('keydown', (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter' && !(ev.target && ev.target.closest && ev.target.closest('.ce'))) { ev.preventDefault(); gate(run); } });
    if (F.a11y) {
      F.a11y.keys(dlg, { save: () => { save(new Blob([ed.getValue()], { type: 'text/x-python' }), P.safeName(st.name) + '.py'); say('Saved ' + P.safeName(st.name) + '.py (source as written).'); } });
      F.a11y.panes(dlg, ['.pyw__bar', '.ce', '.pyw__frame', '.pyw__out', '.dlg__foot']);
      F.a11y.tip(dlg.buttons.insert, editing ? 'Apply to the figure' : 'Insert in the slide');
    }
    const rr = editing && rec0.render, rt = rr && rr.runtime;
    if (rr && rr.status === 'ok' && rr.preview && rt && rt.widthPx && rt.heightPx && rt.dpi) {   // the saved picture is shown, never re-drawn on open
      st.good = { preview: rr.preview, widthPx: rt.widthPx, heightPx: rt.heightPx, dpi: rt.dpi, hash: rr.hash, source: st.source, sig: sig(), durationMs: rr.durationMs };
      st.scriptSize = [rt.widthPx / rt.dpi, rt.heightPx / rt.dpi];
    }
    paintPreview(); paintOutput(); paintChip(); syncExport();
    return dlg;
  };
})(window.RPE);
