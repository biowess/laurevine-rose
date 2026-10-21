/* plotpanels.js — contextual sidebar sections "Line options", "Scatter options", "Bar options", "Histogram options", "Box plot options" and "Heatmap options" of the figure editor (contract s4l, s4m-b).
   RPE.figures.plotpanels = { groups(kit) -> [note, line, scatter, bar, hist, box, heatmap groups], reconcile(record, newType) -> messages[], announce(ctx, messages) }.
   Every control edits the draft only through ctx.set (so the editor's shared 350 ms debounce re-renders). A state the backend would refuse
   (error bars without their column or with negative values, a series that draws nothing) is explained or avoided, never written silently. */
(function (RPE) {
  'use strict';
  const F = RPE.figures = RPE.figures || {};
  const h = RPE.h;
  const P = F.plotpanels = {};

  const MARKERS = [['circle', 'Circle'], ['square', 'Square'], ['triangle_up', 'Triangle up'], ['triangle_down', 'Triangle down'], ['diamond', 'Diamond'], ['plus', 'Plus'], ['cross', 'Cross'], ['star', 'Star']];
  const STYLES = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted'], ['dashdot', 'Dash-dot']];
  const STEPS = [['none', 'None (straight)'], ['pre', 'Before (pre)'], ['mid', 'Middle (mid)'], ['post', 'After (post)']];
  const ERRS = [['none', 'None'], ['symmetric', '± one column'], ['asymmetric', 'Lower and upper columns']];
  const FITS = [['none', 'None'], ['linear', 'Linear'], ['polynomial', 'Polynomial']];
  const LEVELS = [0.9, 0.95, 0.99];
  const SER = { visible: true, line: true, color: null, width: null, style: 'solid', marker: 'none', markerSize: null, markerColor: null, step: 'none', error: 'none', errorCol: null, errorLowCol: null, errorHighCol: null, capSize: 3 };
  const PAL = {   // same lists as backend/figures/codegen/common.py PALETTES (used to show the colour a series gets automatically)
    default: ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#000000', '#7F7F7F'],
    colorblind: ['#000000', '#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7'],
    muted: ['#332288', '#88CCEE', '#44AA99', '#117733', '#999933', '#DDCC77', '#CC6677', '#882255', '#AA4499'],
    grayscale: ['#000000', '#555555', '#8C8C8C', '#B3B3B3']
  };
  const ROLES = { line: ['x', 'y'], scatter: ['x', 'y', 'group'], bar: ['x', 'y', 'group'], hist: ['y'], box: ['y', 'group'], heatmap: ['x', 'y'] };
  const NUMERIC_X = { line: 1, scatter: 1 };
  const SINGLE_Y = { hist: 1, box: 1 };
  const MAX_COLOR_ROWS = 12;

  /* ---------- dataset helpers ---------- */
  const cols = (rec) => (rec.dataset && rec.dataset.columns) || [];
  const numNames = (rec) => cols(rec).filter((c) => c.type === 'number').map((c) => c.name);
  const isNum = (rec, n) => cols(rec).some((c) => c.name === n && c.type === 'number');
  const gone = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v));
  function stats(rec, name) {   // { miss, min } of a column; min = Infinity when it has no value
    const i = cols(rec).findIndex((c) => c.name === name), rows = (rec.dataset && rec.dataset.rows) || [];
    let miss = 0, min = Infinity;
    if (i < 0) return { miss: 0, min };
    rows.forEach((r) => { const v = r[i]; if (gone(v)) miss++; else if (Number(v) < min) min = Number(v); });
    return { miss, min, rows: rows.length };
  }
  const q = (n) => '“' + n + '”';
  const sget = (rec, c, k) => { const s = ((rec.config.options || {}).series || {})[c]; return s && s[k] !== undefined ? s[k] : SER[k]; };
  const opt = (rec, k, d) => { const v = (rec.config.options || {})[k]; return v === undefined ? d : v; };
  const app = (rec, k, d) => { const v = (rec.config.appearance || {})[k]; return v === undefined ? d : v; };
  function autoColor(rec, i) {
    const a = rec.config.appearance || {}, base = a.colors && a.colors.length ? a.colors : PAL[a.palette] || PAL.default;
    return base[i % base.length];
  }

  /* ---------- type switch: keep compatible mappings, reset the rest, say so ---------- */
  /* Called by the editor BEFORE plotType / options are replaced. Mutates r.config.mapping, returns visible messages. */
  P.reconcile = function (r, type) {
    const m = r.config.mapping = Object.assign({ x: null, y: [], group: null, yErr: null }, r.config.mapping), roles = ROLES[type] || [], notes = [];
    const kinds = (RPE.plots && RPE.plots.KINDS) || {}, L = (kinds[type] && kinds[type].label) || type, o = r.config.options || {};
    if (m.group && roles.indexOf('group') < 0) { notes.push('Group column reset: ' + L + ' plots have no group (was ' + q(m.group) + ').'); m.group = null; }
    if (m.x && roles.indexOf('x') < 0) { notes.push('X column reset: ' + L + ' plots have no X column (was ' + q(m.x) + ').'); m.x = null; }
    if (m.yErr && type !== 'line' && type !== 'bar') { notes.push('Error column reset: only line and bar plots use it.'); m.yErr = null; }
    if (m.x && NUMERIC_X[type] && !isNum(r, m.x)) { notes.push('X column reset: ' + q(m.x) + ' is text.'); m.x = null; }
    const ys = m.y || [], numeric = ys.filter((c) => isNum(r, c)), text = ys.filter((c) => !isNum(r, c));
    if (text.length) notes.push('Y series reset: ' + text.map(q).join(', ') + (text.length > 1 ? ' are text.' : ' is text.'));
    m.y = numeric;
    if (SINGLE_Y[type] && m.y.length > 1) { notes.push('Y series reset: ' + L + ' plots take one column; kept ' + q(m.y[0]) + '.'); m.y = m.y.slice(0, 1); }
    if (type !== 'line' && o.series && Object.keys(o.series).length) notes.push('Line series styles reset: only line plots use them.');
    if (type !== 'scatter' && o.fit && o.fit !== 'none') notes.push('Fit settings reset: only scatter plots use them.');
    const where = type === 'line' || type === 'scatter' ? 'in ' + L + ' options' : 'with the column roles in the Spreadsheet tab';
    if (type === 'scatter' && !m.x) notes.push('X column not set: choose it ' + where + '.');
    if (roles.indexOf('y') >= 0 && !m.y.length) notes.push((SINGLE_Y[type] ? 'Value' : 'Y') + ' column not set: choose it ' + where + '.');
    return notes;
  };
  const noteState = new WeakMap();
  P.announce = function (ctx, messages) { const s = noteState.get(ctx) || {}; s.msgs = messages || []; noteState.set(ctx, s); if (s.draw) s.draw(); };

  /* ---------- the sidebar sections; kit = { ctx, reg, group, field } from the Preview tab ---------- */
  P.groups = function (kit) {
    const ctx = kit.ctx, reg = kit.reg, group = kit.group, field = kit.field, R = () => ctx.record;

    /* controls bound to a section: `local` registers a sync that runs while the section is visible */
    const fld = (label, control, input) => { const f = field(label, control); f.input = input || control; return f; };   // f.input = the control itself (to disable it)
    const controls = (local) => {
      const c = {};
      c.sel = (label, optsFn, get, set) => {
        const el = h('select', { class: 'select', 'aria-label': label }); let key = null;
        el.addEventListener('change', () => set(el.value));
        local(() => {
          const o = optsFn(), cur = get(); let list = o;
          if (cur !== null && cur !== undefined && cur !== '' && !o.some((x) => String(x[0]) === String(cur))) list = o.concat([[cur, cur + ' (not in data)']]);
          const k = JSON.stringify(list);
          if (k !== key) { key = k; el.textContent = ''; list.forEach((x) => el.append(h('option', { value: String(x[0]) }, x[1]))); }
          el.value = cur === null || cur === undefined ? '' : String(cur);
        });
        return fld(label, el);
      };
      c.chk = (label, get, set) => {
        const el = h('input', { type: 'checkbox' }); el.addEventListener('change', () => set(!!el.checked));
        local(() => { el.checked = !!get(); });
        const l = h('label', { class: 'check' }, el, label); l.input = el; return l;
      };
      /* number box; empty = null when `auto` is given (its text is the placeholder), otherwise a value is required. Out of range: flagged, not applied. */
      c.num = (label, lo, hi, step, get, set, auto) => {
        const el = h('input', { class: 'input', type: 'number', min: lo, max: hi, step, 'aria-label': label, 'aria-invalid': 'false', title: lo + ' to ' + hi + (auto ? '; empty = automatic' : '') });
        el.addEventListener('input', () => {
          const t = String(el.value).trim(), v = t === '' ? null : Number(t), bad = (v === null && !auto) || (v !== null && (!isFinite(v) || v < lo || v > hi));
          el.setAttribute('aria-invalid', String(bad)); if (!bad) set(v);
        });
        local(() => {
          const v = get(), t = String(el.value).trim();
          if (!(v === null || v === undefined ? t === '' : Number(t) === v)) el.value = v === null || v === undefined ? '' : v;
          el.setAttribute('placeholder', auto ? String(typeof auto === 'function' ? auto() : auto) : '');
        });
        return fld(label, el);
      };
      /* colour: native picker (works offline) + Auto; the picker shows the colour the series gets automatically while unset */
      c.color = (label, get, set, fallback) => {
        const el = h('input', { type: 'color', class: 'pp__color', 'aria-label': label });
        const auto = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', title: 'Use the automatic colour', onclick: () => set(null) }, 'Auto');
        el.addEventListener('input', () => set(el.value.toUpperCase()));
        local(() => { const v = get(); el.value = (v || fallback() || '#000000').toLowerCase(); el.classList.toggle('is-auto', !v); auto.disabled = !v; });
        return fld(label, h('span', { class: 'pp__colorrow' }, el, auto), el);
      };
      return c;
    };
    const section = (type, title, build) => {
      const syncs = [], local = (fn) => syncs.push(fn); local.run = () => syncs.forEach((fn) => fn());
      const kids = build(controls(local), local);
      const g = group(title, true, ...kids);
      reg(() => { const on = R().config.plotType === type; g.hidden = !on; if (on) syncs.forEach((fn) => fn()); });
      return g;
    };
    const setMap = (patch) => ctx.set((r) => { r.config.mapping = Object.assign({ x: null, y: [], group: null, yErr: null }, r.config.mapping, patch); });
    const setApp = (patch) => ctx.set((r) => { Object.assign(r.config.appearance, patch); });
    const setOpt = (patch) => ctx.set((r) => { r.config.options = Object.assign({}, r.config.options, patch); });
    const setSer = (c, patch) => ctx.set((r) => { const o = r.config.options = r.config.options || {}; o.series = Object.assign({}, o.series); o.series[c] = Object.assign({}, o.series[c], patch); });
    const ys = () => R().config.mapping.y || [];
    const numOpts = (first) => [first].concat(numNames(R()).map((n) => [n, n]));

    /* messages from the last type switch (also shown for types without a section here) */
    const note = h('div', { class: 'fe__note', role: 'status', hidden: true });
    const st = noteState.get(ctx) || {}; noteState.set(ctx, st);
    st.draw = () => {
      note.textContent = '';
      if (!(st.msgs && st.msgs.length)) { note.hidden = true; return; }
      note.hidden = false;
      st.msgs.forEach((m) => note.append(h('div', null, m)));
      note.append(h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => P.announce(ctx, []) }, 'Dismiss'));
    };
    st.draw();

    const setLabel = (n, v) => ctx.set((r) => {
      const a = r.config.appearance, l = Object.assign({ show: true, pos: 'best', force: false, frame: null, labels: {} }, a.legend), lab = Object.assign({}, l.labels);
      if (v.trim() === '') delete lab[n]; else lab[n] = v;
      l.labels = lab; a.legend = l;
    });
    const move = (i, d) => { const y = ys().slice(), j = i + d; if (j < 0 || j >= y.length) return; const t = y[i]; y[i] = y[j]; y[j] = t; setMap({ y }); };

    /* ================= Line options ================= */
    let cur = null;   // series being styled
    const pend = {};  // error mode chosen before its column(s): column -> mode
    const lineG = section('line', 'Line options', (c, local) => {
      const m = () => R().config.mapping;
      const xSel = c.sel('X column', () => numOpts(['', 'Row number (no X column)']), () => m().x || '', (v) => setMap({ x: v || null, y: ys().filter((n) => n !== v) }));

      /* Y series: ordered, rename (= legend text), visibility */
      const list = h('div', { class: 'pp__list' }), add = c.sel('Add series', () => [['', 'Add a Y series…']].concat(numNames(R()).filter((n) => n !== m().x && ys().indexOf(n) < 0).map((n) => [n, n])), () => '', (v) => { if (v) setMap({ y: ys().concat(v) }); });
      const empty = h('div', { class: 'fe__hint' }, 'No Y series yet. Add a numeric column to draw a line.');
      let key = null, rowSync = [];
      local(() => {
        const y = ys(), k = y.map((n) => n + (sget(R(), n, 'visible') ? '1' : '0')).join('\u0001');
        const rows = (R().dataset && R().dataset.rows) || [];
        empty.hidden = y.length > 0;
        empty.textContent = !rows.length ? 'This dataset has no data rows. Add or import data in the Spreadsheet tab.' : 'No Y series yet. Add a numeric column to draw a line.';
        if (k !== key) {
          key = k; rowSync = []; list.textContent = '';
          y.forEach((n, i) => {
            const vis = h('input', { type: 'checkbox', 'aria-label': 'Show series ' + n, title: 'Show or hide this series' });
            vis.addEventListener('change', () => setSer(n, { visible: !!vis.checked }));
            const nm = h('input', { class: 'input', type: 'text', maxlength: 200, placeholder: n, 'aria-label': 'Name of series ' + n, title: 'Legend text (empty = ' + n + ')' });
            nm.addEventListener('input', () => setLabel(n, nm.value));
            const btn = (txt, label, fn, off) => h('button', { type: 'button', class: 'btn btn--ghost btn--sm pp__ico', 'aria-label': label, title: label, disabled: off, onclick: fn }, txt);
            list.append(h('div', { class: 'pp__ser' }, vis, nm, btn('↑', 'Move ' + n + ' up', () => move(i, -1), i === 0), btn('↓', 'Move ' + n + ' down', () => move(i, 1), i === y.length - 1), btn('×', 'Remove ' + n, () => setMap({ y: y.filter((z) => z !== n) }))));
            rowSync.push(() => { vis.checked = !!sget(R(), n, 'visible'); const l = ((R().config.appearance || {}).legend || {}).labels || {}, v = l[n] || ''; if (nm.value !== v && !(v === '' && nm.value.trim() === '')) nm.value = v; });
          });
        }
        rowSync.forEach((fn) => fn());
      });

      /* per-series style */
      const pick = c.sel('Style for series', () => ys().map((n) => [n, n]), () => (ys().indexOf(cur) >= 0 ? cur : ys()[0]) || '', (v) => { cur = v; errMsg.textContent = ''; local.run(); });
      const name = () => (ys().indexOf(cur) >= 0 ? cur : ys()[0]);
      const idx = () => Math.max(0, ys().indexOf(name()));
      const get = (k) => sget(R(), name(), k);
      const set = (patch) => { const n = name(); if (n) setSer(n, patch); };
      const colorF = c.color('Line color', () => get('color'), (v) => set({ color: v }), () => autoColor(R(), idx()));
      const widthF = c.num('Line width (pt)', 0.1, 20, 0.25, () => get('width'), (v) => set({ width: v }), () => app(R(), 'lineWidth', 1.5));
      const styleF = c.sel('Line style', () => STYLES, () => get('style'), (v) => set({ style: v }));
      const stepF = c.sel('Step', () => STEPS, () => get('step'), (v) => set({ step: v }));
      const lineChk = c.chk('Line', () => get('line'), (v) => set(v ? { line: true } : get('marker') === 'none' ? { line: false, marker: 'circle' } : { line: false }));
      const markChk = c.chk('Markers', () => get('marker') !== 'none', (v) => set(v ? { marker: 'circle' } : get('line') ? { marker: 'none' } : { marker: 'none', line: true }));
      const mType = c.sel('Marker type', () => MARKERS, () => (get('marker') === 'none' ? 'circle' : get('marker')), (v) => set({ marker: v }));
      const mSize = c.num('Marker size (pt)', 0, 50, 0.5, () => get('markerSize'), (v) => set({ markerSize: v }), () => app(R(), 'markerSize', 5));
      const mColor = c.color('Marker color', () => get('markerColor'), (v) => set({ markerColor: v }), () => get('color') || autoColor(R(), idx()));
      const markBox = h('div', { class: 'fe__g2' }, mType, mSize, mColor);
      local(() => { markBox.hidden = get('marker') === 'none'; });

      /* error bars: the mode is written only once its column(s) exist, and never with negative values */
      const errMsg = h('div', { class: 'fe__hint', role: 'status' }), nums = () => numOpts(['', 'Choose column…']);
      const need = (mode, s) => (mode === 'symmetric' ? !!s.errorCol : mode === 'asymmetric' ? !!(s.errorLowCol && s.errorHighCol) : true);
      const curSer = () => ({ errorCol: get('errorCol'), errorLowCol: get('errorLowCol'), errorHighCol: get('errorHighCol') });
      const modeOf = () => (get('error') !== 'none' ? get('error') : pend[name()] || 'none');
      const setCol = (field_, mode) => (v) => {
        const n = name(); errMsg.textContent = '';
        if (v) { const s = stats(R(), v); if (s.min < 0) { errMsg.textContent = 'Column ' + q(v) + ' has negative values; error bars need distances ≥ 0, so it was not applied.'; return; } }
        const next = Object.assign(curSer(), { [field_]: v || null });
        if (need(mode, next)) { delete pend[n]; setSer(n, Object.assign({ error: mode }, { [field_]: v || null })); }
        else { pend[n] = mode; setSer(n, Object.assign({ error: 'none' }, { [field_]: v || null })); }
      };
      const errMode = c.sel('Error bars', () => ERRS, modeOf, (v) => {
        const n = name(); errMsg.textContent = '';
        if (v === 'none') { delete pend[n]; set({ error: 'none' }); return; }
        if (need(v, curSer())) { delete pend[n]; set({ error: v }); } else { pend[n] = v; if (get('error') === 'none') local.run(); else set({ error: 'none' }); }
      });
      const errSym = c.sel('Error column (±)', nums, () => get('errorCol') || '', (v) => setCol('errorCol', 'symmetric')(v));
      const errLo = c.sel('Lower error column', nums, () => get('errorLowCol') || '', (v) => setCol('errorLowCol', 'asymmetric')(v));
      const errHi = c.sel('Upper error column', nums, () => get('errorHighCol') || '', (v) => setCol('errorHighCol', 'asymmetric')(v));
      const cap = c.num('Cap size (pt)', 0, 20, 0.5, () => get('capSize'), (v) => set({ capSize: v }));
      const errBox = h('div', { class: 'fe__g2' }, errSym, errLo, errHi, cap);
      const errHelp = h('div', { class: 'fe__hint' });
      local(() => {
        const mode = modeOf();
        errSym.hidden = mode !== 'symmetric'; errLo.hidden = errHi.hidden = mode !== 'asymmetric'; cap.hidden = mode === 'none';
        errHelp.hidden = mode === 'none' || need(mode, curSer());
        errHelp.textContent = mode === 'symmetric' ? 'Choose the error column; the bars are drawn as soon as it is set.' : 'Choose both columns (distances below and above the value); the bars are drawn when both are set.';
      });

      /* missing values */
      const miss = h('div', { class: 'fe__hint', role: 'status' });
      local(() => {
        const rec = R(), m_ = rec.config.mapping, drawn = ys().filter((n) => sget(rec, n, 'visible')), parts = [];
        if (m_.x) { const s = stats(rec, m_.x); if (s.miss) parts.push(q(m_.x) + ' (X) ' + s.miss); }
        drawn.forEach((n) => { const s = stats(rec, n); if (s.miss) parts.push(q(n) + ' ' + s.miss); });
        miss.textContent = parts.length
          ? 'Missing values: ' + parts.join(', ') + '. They stay gaps in the line: nothing is interpolated or bridged, also in step mode.'
          : 'No missing values in the drawn columns. Missing cells would stay gaps; nothing is interpolated.';
      });

      const styleBox = h('div', { class: 'pp__style' }, pick,
        h('div', { class: 'fe__g2' }, colorF, widthF, styleF, stepF),
        h('div', { class: 'pd__checks' }, lineChk, markChk), markBox, errMode, errBox, errHelp, errMsg);
      local(() => { styleBox.hidden = !ys().length; });
      return [xSel, h('div', { class: 'fe__hint' }, 'Y series (name = legend text)'), list, empty, add, styleBox, miss];
    });

    /* ================= Scatter options ================= */
    const scatterG = section('scatter', 'Scatter options', (c, local) => {
      const m = () => R().config.mapping, rest = (n) => cols(R()).filter((k) => k.name !== m().x && ys().indexOf(k.name) < 0).map((k) => [k.name, k.name]);
      const xSel = c.sel('X column', () => numOpts(['', 'Choose column…']), () => m().x || '', (v) => setMap({ x: v || null, y: ys().filter((n) => n !== v), group: m().group === v ? null : m().group }));
      const ySel = c.sel('Y column', () => numOpts(['', 'Choose column…']).filter((o) => o[0] !== m().x), () => ys()[0] || '', (v) => setMap({ y: v ? [v].concat(ys().slice(1).filter((n) => n !== v)) : ys().slice(1), group: m().group === v ? null : m().group }));
      const grp = c.sel('Group column', () => [['', 'None']].concat(rest()), () => m().group || '', (v) => setMap({ group: v || null }));
      const empty = h('div', { class: 'fe__hint', role: 'status' });
      const extra = h('div', { class: 'fe__hint' });
      local(() => {
        const rows = (R().dataset && R().dataset.rows) || [];
        const has = numNames(R()).length > 0;
        let bad = '';
        if (!rows.length) bad = 'This dataset has no data rows. Add or import data in the Spreadsheet tab.';
        else if (!has) bad = 'This dataset has no numeric column. Add or import one in the Spreadsheet tab.';
        else if (!m().x && !ys().length) bad = 'Choose an X and Y column to draw the scatter plot.';
        empty.textContent = bad; empty.hidden = !bad;
        const y = ys(), more = y.slice(1);
        extra.hidden = !more.length || !!bad;
        extra.textContent = m().group ? 'With a group column only ' + q(y[0]) + ' is drawn; the other Y columns are ignored.' : 'Also drawn as separate series: ' + more.join(', ') + '.';
      });

      const mk = c.sel('Marker', () => MARKERS, () => opt(R(), 'marker', 'circle'), (v) => setOpt({ marker: v }));
      const size = c.num('Marker size (pt)', 0, 50, 0.5, () => app(R(), 'markerSize', 5), (v) => setApp({ markerSize: v }));
      const alpha = c.num('Opacity (0–1)', 0, 1, 0.05, () => app(R(), 'alpha', 1), (v) => setApp({ alpha: v }));
      const edgeW = c.num('Outline width (pt)', 0, 5, 0.25, () => opt(R(), 'markerEdgeWidth', 0.5), (v) => setOpt({ markerEdgeWidth: v }));
      const edgeC = c.color('Outline color', () => opt(R(), 'markerEdgeColor', null), (v) => setOpt({ markerEdgeColor: v }), () => '#808080');
      const edgeNote = h('div', { class: 'fe__hint' }, 'Plus and cross are drawn as strokes and have no outline.');
      const edgeBox = h('div', { class: 'fe__g2' }, edgeC, edgeW);
      local(() => { const stroke = ['plus', 'cross'].indexOf(opt(R(), 'marker', 'circle')) >= 0; edgeBox.hidden = stroke; edgeNote.hidden = !stroke; });

      /* colours: one picker per drawn series (first 12); writes the full appearance.colors list, other entries keep their palette colour */
      const colors = h('div', { class: 'pp__list' }); let ckey = null, cSync = [];
      const names = () => (F.controls && F.controls.legendInfo ? F.controls.legendInfo(R()).names : []);
      const setColor = (i, v, total) => ctx.set((r) => {
        const a = r.config.appearance, base = a.colors && a.colors.length ? a.colors : PAL[a.palette] || PAL.default, out = [];
        for (let k = 0; k < Math.max(total, i + 1); k++) out.push(base[k % base.length]);
        if (v === null) { a.colors = []; return; }
        out[i] = v; a.colors = out;
      });
      const colorNote = h('div', { class: 'fe__hint' });
      const resetColors = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => setColor(0, null, 0) }, 'Reset colors to palette');
      local(() => {
        const nm = names(), k = nm.join('\u0001'), total = nm.length;
        if (k !== ckey) {
          ckey = k; cSync = []; colors.textContent = '';
          nm.slice(0, MAX_COLOR_ROWS).forEach((n, i) => {
            const el = h('input', { type: 'color', class: 'pp__color', 'aria-label': 'Color of ' + n });
            el.addEventListener('input', () => setColor(i, el.value.toUpperCase(), total));
            colors.append(h('label', { class: 'pp__colorline' }, el, h('span', { class: 'pp__nm' }, n)));
            cSync.push(() => { el.value = autoColor(R(), i).toLowerCase(); });
          });
        }
        cSync.forEach((fn) => fn());
        colorNote.hidden = total <= MAX_COLOR_ROWS; colorNote.textContent = 'The other ' + (total - MAX_COLOR_ROWS) + ' groups use the palette order.';
        resetColors.disabled = !(app(R(), 'colors', []) || []).length;
      });

      /* fit */
      const fit = c.sel('Fit', () => FITS, () => opt(R(), 'fit', 'none'), (v) => setOpt({ fit: v }));
      const deg = c.num('Degree (2–5)', 2, 5, 1, () => opt(R(), 'fitDegree', 2), (v) => setOpt({ fitDegree: Math.round(v) }));
      const eq = c.chk('Equation', () => opt(R(), 'fitEquation', true), (v) => setOpt({ fitEquation: v }));
      const r2 = c.chk('R²', () => opt(R(), 'fitR2', true), (v) => setOpt({ fitR2: v }));
      const ci = c.chk('Confidence interval', () => !!opt(R(), 'fitBand', false), (v) => setOpt({ fitBand: v }));
      const lvl = c.sel('Confidence level', () => { const cu = opt(R(), 'fitLevel', 0.95), l = LEVELS.indexOf(cu) >= 0 ? LEVELS : LEVELS.concat(cu).sort(); return l.map((x) => [x, Math.round(x * 1000) / 10 + '%']); }, () => opt(R(), 'fitLevel', 0.95), (v) => setOpt({ fitLevel: Number(v) }));
      if (F.a11y) F.a11y.withHelp(lvl, 'The shaded band is a confidence interval for the fitted line: at this level it is expected to contain the true line, and it is not a range for individual points.', 'Confidence interval');
      const fitBox = h('div', { class: 'fe__g2' }, deg), partBox = h('div', { class: 'pd__checks' }, eq, r2, ci);
      const help = h('p', { class: 'pp__help' }, 'Fits are computed per series from the plotted points (least squares, numpy.polyfit); the equation and R² appear in the legend. ' +
        'The confidence interval is the pointwise interval of the fitted line (t-distribution, standard error from the fit covariance), not a prediction interval for new points. A fitted line does not imply causation.');
      local(() => { const f = opt(R(), 'fit', 'none'); fitBox.hidden = f !== 'polynomial'; partBox.hidden = f === 'none'; lvl.hidden = f === 'none' || !opt(R(), 'fitBand', false); });

      return [h('div', { class: 'fe__g2' }, xSel, ySel), grp, empty, extra,
        h('div', { class: 'fe__g2' }, mk, size, alpha), edgeBox, edgeNote,
        h('div', { class: 'fe__hint' }, 'Colors (one per series)'), colors, colorNote, resetColors,
        h('div', { class: 'fe__g2' }, fit), fitBox, partBox, lvl, help];
    });
    /* ================= Bar options ================= */
    const sub = (t) => h('div', { class: 'fe__hint pp__sub' }, t);
    const fmtN = (v) => String(Number(Number(v).toPrecision(6)));
    const FMT = /^[^{}]*\{(?::[^{}]*)?\}[^{}]*$/;   // exactly one {} / {:spec} field, like the backend's valueFormat
    const FMTS = [['', 'Custom'], ['{:g}', 'General (1234.57)'], ['{:.0f}', '0 decimals (1235)'], ['{:.1f}', '1 decimal (1234.6)'], ['{:.2f}', '2 decimals (1234.57)'], ['{:,.0f}', 'Thousands (1,235)'], ['{:.1%}', 'Percent (0.125 → 12.5%)']];
    const barG = section('bar', 'Bar options', (c, local) => {
      const m = () => R().config.mapping, long = () => !!m().group, horiz = () => opt(R(), 'orient', 'vertical') === 'horizontal';
      const colOpt = (k) => [k.name, k.name];
      const cat = c.sel('Category column', () => [['', 'Row number (no category column)']].concat(cols(R()).map(colOpt)), () => m().x || '', (v) => setMap({ x: v || null, y: ys().filter((n) => n !== v), group: m().group === v ? null : m().group }));
      const grp = c.sel('Series from group column', () => [['', 'None (one series per value column)']].concat(cols(R()).filter((k) => k.name !== m().x && ys().indexOf(k.name) < 0).map(colOpt)), () => m().group || '', (v) => setMap({ group: v || null }));

      /* bar series: wide data = one series per value column (ordered, named, hidden, coloured); long data = one value column, one series per group */
      const list = h('div', { class: 'pp__list' }), glist = h('div', { class: 'pp__list' });
      const empty = h('div', { class: 'fe__hint' }, 'No value series yet. Add a numeric column to draw bars.');
      const add = c.sel('Add value series', () => [['', 'Add a value series…']].concat(numNames(R()).filter((n) => n !== m().x && ys().indexOf(n) < 0).map((n) => [n, n])), () => '', (v) => { if (v) setMap({ y: ys().concat(v) }); });
      const one = c.sel('Value column', () => numOpts(['', 'Choose column…']).filter((o) => o[0] !== m().x), () => ys()[0] || '', (v) => setMap({ y: v ? [v] : [] }));
      const extra = h('div', { class: 'fe__hint' });
      const picker = (n, i) => {   // colour of one series, stored as options.series[n].color
        const el = h('input', { type: 'color', class: 'pp__color', 'aria-label': 'Color of ' + n, title: 'Bar color (' + n + ')' });
        el.addEventListener('input', () => setSer(n, { color: el.value.toUpperCase() }));
        return { el, sync: () => { const v = sget(R(), n, 'color'); el.value = (v || autoColor(R(), i)).toLowerCase(); el.classList.toggle('is-auto', !v); } };
      };
      let wkey = null, wSync = [], gkey = null, gSync = [];
      local(() => {
        const y = ys(), isLong = long(), rec = R();
        const rows = (rec.dataset && rec.dataset.rows) || [];
        const has = numNames(rec).length > 0;
        const k = y.map((n) => n + (sget(rec, n, 'visible') ? '1' : '0')).join('\u0001');
        list.hidden = add.hidden = isLong;
        if (!rows.length) {
          empty.textContent = 'This dataset has no data rows. Add or import data in the Spreadsheet tab.';
          empty.hidden = false;
        } else if (!has) {
          empty.textContent = 'This dataset has no numeric column. Add or import one in the Spreadsheet tab.';
          empty.hidden = false;
        } else {
          empty.textContent = 'No value series yet. Add a numeric column to draw bars.';
          empty.hidden = isLong || y.length > 0;
        }
        one.hidden = !isLong; glist.hidden = !isLong;
        extra.hidden = !(isLong && y.length > 1); extra.textContent = 'With a group column only ' + q(y[0]) + ' is drawn; the other value columns are ignored.';
        if (!isLong && k !== wkey) {
          wkey = k; wSync = []; list.textContent = '';
          y.forEach((n, i) => {
            const vis = h('input', { type: 'checkbox', 'aria-label': 'Show series ' + n, title: 'Show or hide this series' });
            vis.addEventListener('change', () => setSer(n, { visible: !!vis.checked }));
            const pk = picker(n, i);
            const nmI = h('input', { class: 'input', type: 'text', maxlength: 200, placeholder: n, 'aria-label': 'Name of series ' + n, title: 'Legend text (empty = ' + n + ')' });
            nmI.addEventListener('input', () => setLabel(n, nmI.value));
            const btn = (txt, label, fn, off) => h('button', { type: 'button', class: 'btn btn--ghost btn--sm pp__ico', 'aria-label': label, title: label, disabled: off, onclick: fn }, txt);
            list.append(h('div', { class: 'pp__ser pp__bser' }, vis, pk.el, nmI, btn('↑', 'Move ' + n + ' up', () => move(i, -1), i === 0), btn('↓', 'Move ' + n + ' down', () => move(i, 1), i === y.length - 1), btn('×', 'Remove ' + n, () => setMap({ y: y.filter((z) => z !== n) }))));
            wSync.push(() => { vis.checked = !!sget(R(), n, 'visible'); pk.sync(); const l = ((R().config.appearance || {}).legend || {}).labels || {}, v = l[n] || ''; if (nmI.value !== v && !(v === '' && nmI.value.trim() === '')) nmI.value = v; });
          });
        }
        if (isLong) {
          const names = (F.controls && F.controls.legendInfo ? F.controls.legendInfo(rec).names : []), gk = names.join('\u0001');
          if (gk !== gkey) {
            gkey = gk; gSync = []; glist.textContent = '';
            names.slice(0, MAX_COLOR_ROWS).forEach((n, i) => { const pk = picker(n, i); glist.append(h('label', { class: 'pp__colorline' }, pk.el, h('span', { class: 'pp__nm' }, n))); gSync.push(pk.sync); });
            if (names.length > MAX_COLOR_ROWS) glist.append(h('div', { class: 'fe__hint' }, 'The other ' + (names.length - MAX_COLOR_ROWS) + ' groups use the palette order.'));
          }
          gSync.forEach((fn) => fn());
        } else wSync.forEach((fn) => fn());
      });
      const resetCols = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => ctx.set((r) => { const s = Object.assign({}, (r.config.options || {}).series); Object.keys(s).forEach((n) => { if (s[n] && s[n].color) s[n] = Object.assign({}, s[n], { color: null }); }); r.config.options = Object.assign({}, r.config.options, { series: s }); }) }, 'Reset series colors');
      local(() => { const s = (R().config.options || {}).series || {}; resetCols.disabled = !Object.keys(s).some((n) => s[n] && s[n].color); });

      /* layout */
      const orient = c.sel('Orientation', () => [['vertical', 'Vertical bars'], ['horizontal', 'Horizontal bars']], () => opt(R(), 'orient', 'vertical'), (v) => setOpt({ orient: v }));
      const layMsg = h('div', { class: 'fe__hint', role: 'status' });
      const layout = c.sel('Bar layout', () => [['grouped', 'Grouped (side by side)'], ['stacked', 'Stacked']], () => opt(R(), 'barMode', 'grouped'), (v) => {
        layMsg.textContent = '';
        if (v === 'stacked' && opt(R(), horiz() ? 'xScale' : 'yScale', 'linear') === 'log') { layMsg.textContent = 'Stacked bars cannot use a log axis. Switch the value axis to linear in Axes first.'; local.run(); return; }
        setOpt({ barMode: v });
      });
      const width = c.num('Bar width (share of slot)', 0.05, 1, 0.05, () => opt(R(), 'barWidth', 0.8), (v) => setOpt({ barWidth: v === null ? 0.8 : v }), 0.8);
      const gap = h('div', { class: 'fe__hint' });
      local(() => {
        const w = opt(R(), 'barWidth', 0.8), n = long() ? 2 : ys().filter((s) => sget(R(), s, 'visible')).length;
        gap.textContent = 'Gap between categories: ' + Math.round((1 - w) * 100) + '% of each slot.' + (n > 1 && opt(R(), 'barMode', 'grouped') === 'grouped' ? ' Grouped bars share the bar width evenly.' : '');
      });
      const rotKey = () => (horiz() ? 'yTickRotation' : 'xTickRotation');
      const rot = c.num('Category label rotation (°)', -90, 90, 5, () => app(R(), rotKey(), 0), (v) => setApp({ [rotKey()]: v === null ? 0 : v }), '0');

      /* value labels + number format */
      const lbl = c.chk('Value labels', () => !!opt(R(), 'valueLabels', false), (v) => setOpt({ valueLabels: v }));
      const fmtEl = h('input', { class: 'input', type: 'text', maxlength: 40, placeholder: '{:g}', 'aria-label': 'Number format', 'aria-invalid': 'false', title: 'Python format with one {} field, e.g. {:.1f} or {:,.0f} kg' });
      const fmtMsg = h('div', { class: 'fe__hint', role: 'status' });
      fmtEl.addEventListener('input', () => {
        const ok = FMT.test(fmtEl.value);
        fmtEl.setAttribute('aria-invalid', String(!ok)); fmtMsg.textContent = ok ? '' : 'Use exactly one {} field, for example {:.1f} or {:,.0f} kg. Not applied.';
        if (ok) setOpt({ valueFormat: fmtEl.value });
      });
      const preset = c.sel('Number format examples', () => FMTS, () => { const v = opt(R(), 'valueFormat', '{:g}'); return FMTS.some((x) => x[0] === v) ? v : ''; }, (v) => { if (v) setOpt({ valueFormat: v }); });
      const fmtBox = h('div', { class: 'pp__style' }, preset, field('Number format', fmtEl), fmtMsg);
      local(() => {
        fmtBox.hidden = !opt(R(), 'valueLabels', false);
        const v = opt(R(), 'valueFormat', '{:g}');
        if (fmtEl.value !== v && (fmtEl.value === '' || FMT.test(fmtEl.value))) fmtEl.value = v;   // typed text that is not valid yet stays
      });

      /* error bars: one shared column (mapping.yErr + options.errorBars); never with negative distances */
      const errMsg = h('div', { class: 'fe__hint', role: 'status' });
      const errSel = c.sel('Error-bar column', () => [['', 'None']].concat(numNames(R()).filter((n) => n !== m().x && ys().indexOf(n) < 0).map((n) => [n, n])), () => (opt(R(), 'errorBars', false) && m().yErr) || '', (v) => {
        errMsg.textContent = '';
        if (v && stats(R(), v).min < 0) { errMsg.textContent = 'Column ' + q(v) + ' has negative numbers; error bars need distances ≥ 0, so it was not applied.'; local.run(); return; }
        ctx.set((r) => { r.config.mapping = Object.assign({ x: null, y: [], group: null, yErr: null }, r.config.mapping, { yErr: v || null }); r.config.options = Object.assign({}, r.config.options, { errorBars: !!v }); });
      });
      const errHelp = h('div', { class: 'fe__hint' }, 'Bars show the value − / + the column, as supplied. Series with their own error setting keep it. What the column means (SD, SEM, CI) is for you to state in the caption.');

      /* truncated baseline */
      const trunc = h('div', { class: 'fe__note', role: 'status', hidden: true }, h('span', null, 'The value axis does not start at 0, so bar lengths are not proportional to the values.'), c.chk('Mark on the figure', () => !!opt(R(), 'axisNote', false), (v) => setOpt({ axisNote: v })));
      local(() => { trunc.hidden = !(F.controls && F.controls.truncated && F.controls.truncated(R())); });

      return [sub('Categories'), cat, grp, sub('Bar series'), list, glist, empty, add, one, extra, resetCols,
        sub('Layout'), h('div', { class: 'fe__g2' }, orient, layout), layMsg, h('div', { class: 'fe__g2' }, width, rot), gap, trunc,
        sub('Labels'), lbl, fmtBox, sub('Error bars'), errSel, errMsg, errHelp];
    });

    /* ================= Histogram options ================= */
    const BINS_BY = [['count', 'Number of bins'], ['width', 'Bin width'], ['method', 'Automatic rule']];
    const RULES = [['auto', 'Auto (numpy default)'], ['fd', 'Freedman–Diaconis'], ['sturges', 'Sturges'], ['scott', 'Scott'], ['sqrt', 'Square root']];
    const STATS_H = [['count', 'Count — observations per bin'], ['frequency', 'Fraction — share of observations per bin'], ['density', 'Density — count ÷ (n × bin width)']];
    const STAT_TXT = { count: 'Count: how many observations fall into each bin.', frequency: 'Fraction: the share of all observations in each bin, so the bars add up to 1.', density: 'Density: count ÷ (n × bin width), so the total bar area is 1 and bin width does not change the height.' };
    const MAX_BINS = 1000;
    const histG = section('hist', 'Histogram options', (c, local) => {
      const col = () => ys()[0] || '';
      const data = () => {   // finite numbers of the chosen column
        const rec = R(), i = cols(rec).findIndex((k) => k.name === col()), rows = (rec.dataset && rec.dataset.rows) || [], out = [];
        if (i >= 0) rows.forEach((r) => { const v = r[i]; if (!gone(v) && isFinite(Number(v))) out.push(Number(v)); });
        return { n: out.length, rows: rows.length, min: out.length ? Math.min.apply(null, out) : NaN, max: out.length ? Math.max.apply(null, out) : NaN };
      };
      const dataSel = c.sel('Data column', () => numOpts(['', 'Choose a numeric column…']), col, (v) => setMap({ y: v ? [v] : [] }));
      const info = h('div', { class: 'fe__hint', role: 'status' }), problem = h('div', { class: 'fe__note', role: 'status', hidden: true });
      local(() => {
        const rows = (R().dataset && R().dataset.rows) || [];
        const d = data(), has = numNames(R()).length > 0;
        let bad = '';
        if (!rows.length) bad = 'This dataset has no data rows. Add or import data in the Spreadsheet tab.';
        else if (!has) bad = 'This dataset has no numeric column. Add or import one in the Spreadsheet tab.';
        else if (!col()) bad = 'Choose a numeric column to draw the histogram.';
        else if (!d.n) bad = 'Column ' + q(col()) + ' has no numbers, so there is nothing to draw.';
        else if (d.min === d.max) bad = 'All ' + d.n + ' observations in ' + q(col()) + ' equal ' + fmtN(d.min) + '. A narrow range around that number is drawn, and no normal curve.';
        problem.hidden = !bad; problem.textContent = bad;
        info.hidden = !(col() && d.n);
        info.textContent = d.n ? d.n + ' observations, range ' + fmtN(d.min) + ' to ' + fmtN(d.max) + (d.rows > d.n ? '; ' + (d.rows - d.n) + ' empty cells are not counted.' : '.') : '';
      });

      /* bins: number box with a 120 ms debounce; a state the backend refuses (> 1000 bins) is flagged and not written */
      const debounce = (fn, ms) => { let t = null, a; const d = (...x) => { a = x; clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); }; d.flush = () => { if (t !== null) { clearTimeout(t); t = null; fn(...a); } }; d.pending = () => t !== null; return d; };
      const live = (label, attrs, get, check, write) => {
        const el = h('input', Object.assign({ class: 'input', type: 'number', 'aria-label': label, 'aria-invalid': 'false' }, attrs)), msg = h('div', { class: 'fe__hint', role: 'status' });
        let bad = false;
        const commit = debounce(write, 120);
        el.addEventListener('input', () => {
          const t = String(el.value).trim(), err = t === '' ? 'Enter a number.' : check(Number(t));
          bad = !!err; el.setAttribute('aria-invalid', String(bad)); msg.textContent = err ? err + ' Not applied.' : '';
          if (!err) commit(Number(t));
        });
        el.addEventListener('change', () => commit.flush());
        local(() => { const v = get(); if (!bad && !commit.pending() && !(v === null || v === undefined ? String(el.value).trim() === '' : Number(el.value) === v)) el.value = v === null || v === undefined ? '' : v; });
        return { box: field(label, el), msg, el };
      };
      const mode = () => opt(R(), 'binMode', 'count');
      const bmode = c.sel('Bins by', () => BINS_BY, mode, (v) => {
        const d = data(), seed = v === 'width' && !opt(R(), 'binWidth', null) && d.n > 1 && d.max > d.min ? { binWidth: Number(((d.max - d.min) / opt(R(), 'bins', 20)).toPrecision(3)) } : {};
        setOpt(Object.assign({ binMode: v }, seed));
      });
      const cnt = live('Number of bins', { min: 1, max: MAX_BINS, step: 1, title: '1 to ' + MAX_BINS }, () => opt(R(), 'bins', 20),
        (v) => (!isFinite(v) || Math.round(v) !== v ? 'Use a whole number.' : v < 1 || v > MAX_BINS ? 'Use 1 to ' + MAX_BINS + ' bins.' : ''), (v) => setOpt({ bins: v }));
      const wid = live('Bin width', { min: 0, step: 'any', title: 'Greater than 0, in the units of the data' }, () => opt(R(), 'binWidth', null),
        (v) => { const d = data(), n = d.n > 1 && d.max > d.min ? Math.ceil((d.max - d.min) / v) : 0; return !isFinite(v) || v <= 0 ? 'The bin width must be greater than 0.' : n > MAX_BINS ? 'This width would need ' + n + ' bins; at most ' + MAX_BINS + ' are allowed.' : ''; }, (v) => setOpt({ binWidth: v }));
      const rule = c.sel('Rule', () => RULES, () => opt(R(), 'binMethod', 'auto'), (v) => setOpt({ binMethod: v }));
      const binInfo = h('div', { class: 'fe__hint' });
      local(() => {
        const md = mode(), d = data(), range = d.max - d.min, ok = d.n > 1 && range > 0;
        cnt.box.hidden = md !== 'count'; wid.box.hidden = md !== 'width'; rule.hidden = md !== 'method';
        cnt.msg.hidden = md !== 'count'; wid.msg.hidden = md !== 'width';
        const w = opt(R(), 'binWidth', null);
        binInfo.textContent = md === 'count' ? (ok ? 'Each bin is ' + fmtN(range / opt(R(), 'bins', 20)) + ' wide.' : '')
          : md === 'width' ? (!w ? 'Enter a bin width to draw the histogram.' : ok ? 'About ' + Math.ceil(range / w) + ' bins of width ' + fmtN(w) + '.' : '')
          : 'Bin edges follow numpy’s “' + opt(R(), 'binMethod', 'auto') + '” rule; all bins have equal width.';
      });

      /* height of the bars */
      const stat = () => { const s = opt(R(), 'stat', null); return s || (opt(R(), 'density', false) ? 'density' : 'count'); };
      const statSel = c.sel('Bar height shows', () => STATS_H, stat, (v) => setOpt({ stat: v }));
      const statTxt = h('p', { class: 'pp__help' });
      local(() => { statTxt.textContent = STAT_TXT[stat()] + (opt(R(), 'cumulative', false) ? ' Cumulative: each bar adds the bins before it; ' + (stat() === 'count' ? 'the last bar equals n.' : 'the last bar is 1.') : ''); });
      const cum = c.chk('Cumulative', () => !!opt(R(), 'cumulative', false), (v) => setOpt({ cumulative: v }));
      const nf = c.chk('Normal curve overlay', () => !!opt(R(), 'normalFit', false), (v) => setOpt({ normalFit: v }));
      const nfHelp = h('p', { class: 'pp__help' }, 'The curve uses the mean and standard deviation (divisor n) of the plotted data, in the same units as the bars. It is a reference curve, not a test of normality.');
      local(() => { nfHelp.hidden = !opt(R(), 'normalFit', false); });

      /* bar style */
      const fill = c.color('Fill color', () => opt(R(), 'barColor', null), (v) => setOpt({ barColor: v }), () => autoColor(R(), 0));
      const edge = c.color('Outline color', () => opt(R(), 'barEdgeColor', null), (v) => setOpt({ barEdgeColor: v }), () => '#333333');
      const edgeW = c.num('Outline width (pt)', 0, 5, 0.25, () => opt(R(), 'barEdgeWidth', 0.5), (v) => setOpt({ barEdgeWidth: v }));
      const opac = c.num('Bar opacity (0–1)', 0, 1, 0.05, () => app(R(), 'alpha', 1), (v) => setApp({ alpha: v }));

      return [sub('Data'), dataSel, info, problem,
        sub('Bins'), bmode, cnt.box, cnt.msg, wid.box, wid.msg, rule, binInfo,
        sub('Bar height'), statSel, statTxt, h('div', { class: 'pd__checks' }, cum, nf), nfHelp,
        sub('Bar style'), h('div', { class: 'fe__g2' }, fill, edge, edgeW, opac)];
    });

    /* ---------- Box plot options ---------- */
    const gate = (f, on, why) => { const e = f.input; if (e.__t === undefined) e.__t = e.title || ''; e.disabled = !on; e.title = on ? e.__t : why; };
    const pct = (s, p, method) => { const pos = (s.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos); return method === 'midpoint' ? (s[lo] + s[hi]) / 2 : s[lo] + (s[hi] - s[lo]) * (pos - lo); };   // s sorted; numpy 'linear' | 'midpoint'
    const beyondWhiskers = (vals, method, rule) => {   // observations beyond the whiskers (same rules as codegen/box.py)
      if (rule === 'minmax' || !vals.length) return 0;
      const s = vals.slice().sort((a, b) => a - b);
      let lo, hi;
      if (rule === 'percentile') { lo = pct(s, 0.05, method); hi = pct(s, 0.95, method); }
      else { const q1 = pct(s, 0.25, method), q3 = pct(s, 0.75, method); lo = q1 - 1.5 * (q3 - q1); hi = q3 + 1.5 * (q3 - q1); }
      return s.filter((v) => v < lo || v > hi).length;
    };
    const WHISKER_TXT = {
      iqr: 'Whiskers reach the most extreme observations within 1.5 × IQR (Q3 − Q1) of the box; they end on data, not on the limit itself.',
      minmax: 'Whiskers reach the smallest and largest observation, so no value lies beyond them.',
      percentile: 'Whiskers mark the 5th and 95th percentiles; the outer 5 % on each side lie beyond them. That is a percentile rule, not an outlier test.'
    };
    const boxG = section('box', 'Box plot options', (c, local) => {
      const bcol = () => ys()[0] || '', gcol = () => { const m = R().config.mapping || {}; return m.group || m.x || ''; };
      const data = () => {   // groups in order of first appearance, with their valid values
        const rec = R(), cs = cols(rec), ci = cs.findIndex((k) => k.name === bcol()), gi = gcol() ? cs.findIndex((k) => k.name === gcol()) : -1, rows = (rec.dataset && rec.dataset.rows) || [];
        const out = { groups: [], valid: 0, rows: rows.length }, byName = new Map();
        if (ci < 0) return out;
        rows.forEach((r) => {
          const g = gi < 0 ? bcol() : gone(r[gi]) ? '(no group)' : String(r[gi]);
          let e = byName.get(g); if (!e) { e = { name: g, vals: [] }; byName.set(g, e); out.groups.push(e); }
          const v = r[ci]; if (!gone(v) && isFinite(Number(v))) { e.vals.push(Number(v)); out.valid++; }
        });
        return out;
      };
      const measure = c.sel('Measurement column', () => numOpts(['', 'Choose a numeric column…']), bcol, (v) => setMap({ y: v ? [v] : [] }));
      const groupSel = c.sel('Group column', () => [['', 'None (one box)']].concat(cols(R()).filter((k) => k.name !== bcol()).map((k) => [k.name, k.name])), gcol, (v) => setMap({ group: v || null, x: null }));
      const info = h('div', { class: 'fe__hint', role: 'status' }), problem = h('div', { class: 'fe__note', role: 'status', hidden: true });
      local(() => {
        const rows = (R().dataset && R().dataset.rows) || [];
        const d = data(), has = numNames(R()).length > 0, n = d.groups.length;
        let bad = '';
        if (!rows.length) bad = 'This dataset has no data rows. Add or import data in the Spreadsheet tab.';
        else if (!has) bad = 'This dataset has no numeric column. Add or import one in the Spreadsheet tab.';
        else if (!bcol()) bad = 'Choose a numeric column to draw the box plot.';
        else if (!d.valid) bad = 'Column ' + q(bcol()) + ' has no numbers, so there is nothing to draw.';
        else if (n > 50) bad = n + ' groups are too many: at most 50 boxes are drawn. Choose a column with fewer groups.';
        problem.hidden = !bad; problem.textContent = bad;
        const ns = d.groups.map((g) => g.vals.length), small = d.groups.filter((g) => g.vals.length === 1).length;
        info.hidden = !d.valid;
        info.textContent = d.valid ? d.valid + ' values in ' + n + (n === 1 ? ' box' : ' boxes') + (n > 1 ? ' (' + Math.min.apply(null, ns) + ' to ' + Math.max.apply(null, ns) + ' per group)' : '') + (d.rows > d.valid ? '; ' + (d.rows - d.valid) + ' empty cells are left out.' : '.') + (small ? ' ' + small + ' group' + (small > 1 ? 's have' : ' has') + ' a single value.' : '') : '';
      });
      const orient = c.sel('Orientation', () => [['vertical', 'Vertical'], ['horizontal', 'Horizontal']], () => opt(R(), 'orient', 'vertical'), (v) => setOpt({ orient: v }));
      const qm = c.sel('Quartile method', () => [['linear', 'Linear (numpy default, Excel QUARTILE.INC)'], ['midpoint', 'Midpoint']], () => opt(R(), 'quartileMethod', 'linear'), (v) => setOpt({ quartileMethod: v }));
      const wk = c.sel('Whisker rule', () => [['iqr', '1.5 × IQR'], ['minmax', 'Minimum to maximum'], ['percentile', '5th to 95th percentile']], () => opt(R(), 'whisker', 'iqr'), (v) => setOpt({ whisker: v }));
      if (F.a11y) F.a11y.withHelp(wk, 'Whiskers reach the furthest values this rule counts as ordinary (1.5 × IQR by default); values beyond them are drawn as outliers.', 'Whisker definition');

      const outl = c.chk('Show outliers', () => opt(R(), 'showOutliers', true), (v) => setOpt({ showOutliers: v }));
      const pts = c.chk('Overlay points', () => !!opt(R(), 'showPoints', false), (v) => setOpt({ showPoints: v }));
      const mean = c.chk('Mean marker', () => !!opt(R(), 'showMean', false), (v) => setOpt({ showMean: v }));
      const notch = c.chk('Notches', () => !!opt(R(), 'notch', false), (v) => setOpt({ notch: v }));
      const outNote = h('div', { class: 'fe__hint', role: 'status' }), notchNote = h('div', { class: 'fe__hint', role: 'status' });
      const hiddenCount = () => data().groups.reduce((t, g) => t + beyondWhiskers(g.vals, opt(R(), 'quartileMethod', 'linear'), opt(R(), 'whisker', 'iqr')), 0);
      local(() => {   // outlier count; notches need >= 10 values in every drawn group (backend refuses otherwise)
        const d = data(), k = hiddenCount(), on = opt(R(), 'showOutliers', true);
        outNote.hidden = !d.valid;
        outNote.textContent = !d.valid ? '' : k === 0 ? 'No value lies beyond the whiskers.'
          : on ? k + (k === 1 ? ' value lies' : ' values lie') + ' beyond the whiskers and ' + (k === 1 ? 'is' : 'are') + ' drawn as open circles.'
            : k + (k === 1 ? ' value beyond the whiskers is' : ' values beyond the whiskers are') + ' hidden. ' + (k === 1 ? 'It still counts' : 'They still count') + ' in the quartiles and the mean.';
        const few = d.groups.filter((g) => g.vals.length > 0 && g.vals.length < 10), nOn = !!opt(R(), 'notch', false);
        notch.input.disabled = few.length > 0 && !nOn;   // an active notch stays clickable so it can be switched off
        notch.input.title = few.length ? 'Notches need at least 10 values in every group.' : '';
        notchNote.textContent = few.length ? 'Notches need at least 10 values in every group; ' + few.slice(0, 3).map((g) => q(g.name) + ' has ' + g.vals.length).join(', ') + (few.length > 3 ? ' and ' + (few.length - 3) + ' more' : '') + '.' + (nOn ? ' Switch notches off to draw the figure.' : '')
          : nOn ? 'Notches show an approximate 95 % interval for the median (median ± 1.57 × IQR ÷ √n). They are a rough guide, not a test.' : '';
        notchNote.hidden = !notchNote.textContent;
      });

      /* median line */
      const medC = c.color('Median line color', () => opt(R(), 'medianColor', null), (v) => setOpt({ medianColor: v }), () => '#000000');
      const medW = c.num('Median width (pt)', 0.1, 20, 0.25, () => opt(R(), 'medianWidth', null), (v) => setOpt({ medianWidth: v }), () => fmtN(2 * app(R(), 'lineWidth', 1)));

      /* colors: palette | one color | one per group (appearance.colors) */
      const base = () => { const a = R().config.appearance || {}; return PAL[a.palette] || PAL.default; };
      const cmode = () => (opt(R(), 'boxColor', null) ? 'one' : (app(R(), 'colors', []) || []).length ? 'group' : 'palette');
      const nGroups = () => Math.max(1, data().groups.length);
      const setColors = (list) => ctx.set((r) => { r.config.appearance.colors = list; });
      const setGroupColor = (i, v) => ctx.set((r) => {
        const a = r.config.appearance, b = a.colors && a.colors.length ? a.colors : base(), out = [];
        for (let k = 0; k < Math.max(nGroups(), i + 1); k++) out.push(b[k % b.length]);
        out[i] = v; a.colors = out;
      });
      const modeSel = c.sel('Box colors', () => [['palette', 'Palette'], ['one', 'One color for all boxes'], ['group', 'Choose per group']], cmode, (v) => {
        if (v === 'palette') ctx.set((r) => { r.config.options = Object.assign({}, r.config.options, { boxColor: null }); r.config.appearance.colors = []; });
        else if (v === 'one') ctx.set((r) => { r.config.options = Object.assign({}, r.config.options, { boxColor: autoColor(r, 0) }); r.config.appearance.colors = []; });
        else ctx.set((r) => { const b = base(), out = []; for (let k = 0; k < nGroups(); k++) out.push(b[k % b.length]); r.config.options = Object.assign({}, r.config.options, { boxColor: null }); r.config.appearance.colors = out; });
      });
      const palSel = c.sel('Palette', () => [['default', 'Default (Okabe-Ito)'], ['colorblind', 'Colorblind (Okabe-Ito)'], ['muted', 'Muted (Tol)'], ['grayscale', 'Grayscale']], () => app(R(), 'palette', 'default'), (v) => setApp({ palette: v }));
      const oneC = c.color('Box color', () => opt(R(), 'boxColor', null), (v) => setOpt({ boxColor: v || autoColor(R(), 0) }), () => autoColor(R(), 0));
      const glist = h('div', { class: 'pp__list' }), gnote = h('div', { class: 'fe__hint' });
      const gReset = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => setColors([]) }, 'Reset colors to palette');
      let gkey = null, gSync = [];
      local(() => {
        const m = cmode();
        modeSel.hidden = false; palSel.hidden = m !== 'palette'; oneC.hidden = m !== 'one'; glist.hidden = gnote.hidden = gReset.hidden = m !== 'group';
        if (m !== 'group') return;
        const nm = data().groups.map((g) => g.name), k = nm.join('\u0001');
        if (k !== gkey) {
          gkey = k; gSync = []; glist.textContent = '';
          nm.slice(0, MAX_COLOR_ROWS).forEach((n, i) => {
            const el = h('input', { type: 'color', class: 'pp__color', 'aria-label': 'Color of ' + n });
            el.addEventListener('input', () => setGroupColor(i, el.value.toUpperCase()));
            glist.append(h('label', { class: 'pp__colorline' }, el, h('span', { class: 'pp__nm' }, n)));
            gSync.push(() => { el.value = autoColor(R(), i).toLowerCase(); });
          });
        }
        gSync.forEach((fn) => fn());
        gnote.textContent = nm.length > MAX_COLOR_ROWS ? 'The other ' + (nm.length - MAX_COLOR_ROWS) + ' groups use the palette order.' : '';
        gnote.hidden = !gnote.textContent;
      });

      /* help text generated from the current settings */
      const helpTxt = h('div', { class: 'pp__help' });
      local(() => {
        const o = R().config.options || {}, m = opt(R(), 'quartileMethod', 'linear'), rule = opt(R(), 'whisker', 'iqr'), k = hiddenCount(), on = opt(R(), 'showOutliers', true), horiz = opt(R(), 'orient', 'vertical') === 'horizontal';
        const mc = opt(R(), 'medianColor', null), parts = [
          'Each ' + (horiz ? 'horizontal' : 'vertical') + ' box spans the first to the third quartile (Q1–Q3), the middle half of that group’s values. Quartiles use the ' + (m === 'midpoint' ? 'midpoint' : 'linear (numpy default, Excel QUARTILE.INC)') + ' method.',
          'The ' + (mc ? 'colored' : 'dark or light') + ' line inside the box is the median.',
          WHISKER_TXT[rule]
        ];
        if (rule !== 'minmax') parts.push(k === 0 ? 'No value lies beyond the whiskers now.' : on ? k + ' value' + (k === 1 ? '' : 's') + ' beyond the whiskers ' + (k === 1 ? 'is' : 'are') + ' drawn as open circles.' : k + ' value' + (k === 1 ? '' : 's') + ' beyond the whiskers ' + (k === 1 ? 'is' : 'are') + ' hidden; ' + (k === 1 ? 'it' : 'they') + ' still count in the quartiles and the mean.');
        if (o.notch) parts.push('Notches mark an approximate 95 % interval for the median; when two notches do not overlap, the medians probably differ, but this is a rough guide, not a test.');
        if (o.showMean) parts.push('The diamond is the mean of all values.');
        if (o.showPoints) parts.push('Dots are the individual observations within the whiskers, spread sideways only so they do not overlap; the sideways position carries no meaning.');
        helpTxt.textContent = parts.join(' ');
      });
      const help = h('details', { class: 'pp__details' }, h('summary', null, 'What do the box and whiskers show?'), helpTxt);

      return [sub('Data'), h('div', { class: 'fe__g2' }, measure, groupSel), info, problem,
        sub('Layout'), orient,
        sub('Statistics'), h('div', { class: 'fe__g2' }, qm, wk),
        sub('Show'), h('div', { class: 'pd__checks' }, outl, pts, mean, notch), outNote, notchNote,
        sub('Median line'), h('div', { class: 'fe__g2' }, medC, medW),
        sub('Colors'), modeSel, palSel, oneC, glist, gnote, gReset, help];
    });

    /* ---------- Heatmap options ---------- */
    const CMAPS = [['viridis', 'Viridis'], ['magma', 'Magma'], ['cividis', 'Cividis'], ['plasma', 'Plasma'], ['coolwarm', 'Coolwarm (diverging)'], ['gray', 'Gray'], ['RdBu_r', 'Red–blue (diverging)'], ['Greys', 'Greys']];
    const DIVERGING = { RdBu_r: 1, coolwarm: 1 };
    const roundOut = (v, dir) => { if (!v) return 0; const p = Math.pow(10, Math.floor(Math.log10(Math.abs(v))) - 2); return Number(((dir < 0 ? Math.floor(v / p) : Math.ceil(v / p)) * p).toPrecision(6)); };
    const heatG = section('heatmap', 'Heatmap options', (c, local) => {
      const corr = () => opt(R(), 'heatmapMode', 'matrix') === 'correlation';
      const mode = c.sel('Heatmap mode', () => [['matrix', 'Matrix'], ['correlation', 'Correlation']], () => opt(R(), 'heatmapMode', 'matrix'), (v) => setOpt({ heatmapMode: v }));
      const modeHelp = h('p', { class: 'pp__help' });
      local(() => { modeHelp.textContent = corr() ? 'Correlation: the matrix shows how strongly each pair of the chosen columns moves together. It is computed from the data; association does not imply causation.' : 'Matrix: each cell shows the number in the data, as supplied.'; });

      /* columns: mapping.y (empty = every numeric column, written out as soon as the selection changes) */
      const sel = () => { const y = ys(), all = numNames(R()); return y.length ? y.filter((n) => all.indexOf(n) >= 0) : all; };
      const colBox = h('div', { class: 'pp__list pp__scroll' }), colMsg = h('div', { class: 'fe__note', role: 'status', hidden: true });
      let ckey = null, cs = [];
      const toggle = (n, on) => {
        const b = ys().length ? ys() : numNames(R()), next = on ? (b.indexOf(n) < 0 ? b.concat([n]) : b) : b.filter((k) => k !== n);
        if (next.length < 2) { colMsg.hidden = false; colMsg.textContent = 'Keep at least two columns: a heatmap needs two or more numeric columns.'; cs.forEach((fn) => fn()); return; }
        colMsg.hidden = true; setMap({ y: next });
      };
      const allBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => { colMsg.hidden = true; setMap({ y: numNames(R()).slice() }); } }, 'Select all');
      const colInfo = h('div', { class: 'fe__hint', role: 'status' });
      local(() => {
        const all = numNames(R()), k = all.join('\u0001');
        if (k !== ckey) {
          ckey = k; cs = []; colBox.textContent = '';
          all.forEach((n) => {
            const el = h('input', { type: 'checkbox', 'aria-label': 'Use column ' + n });
            el.addEventListener('change', () => toggle(n, !!el.checked));
            colBox.append(h('label', { class: 'check' }, el, n));
            cs.push(() => { el.checked = sel().indexOf(n) >= 0; });
          });
        }
        cs.forEach((fn) => fn());
        const rows = (R().dataset && R().dataset.rows) || [];
        allBtn.disabled = sel().length === all.length;
        colInfo.textContent = !rows.length ? 'This dataset has no data rows. Add or import data in the Spreadsheet tab.' : all.length < 2 ? 'A heatmap needs at least two numeric columns. Add or import them in the Spreadsheet tab.' : sel().length + ' of ' + all.length + ' numeric columns drawn' + (corr() ? ', in this order on both axes.' : ' as the matrix columns.');
      });
      const rowSel = c.sel('Row label column', () => [['', 'Row numbers']].concat(cols(R()).map((k) => [k.name, k.name])), () => (R().config.mapping || {}).x || '', (v) => setMap({ x: v || null }));
      const rowNote = h('div', { class: 'fe__hint' });
      local(() => { gate(rowSel, !corr(), 'Correlation matrices are labelled with the column names.'); rowNote.textContent = corr() ? 'Row labels do not apply: correlation mode labels both axes with the column names.' : ''; rowNote.hidden = !rowNote.textContent; });

      /* colors and scale */
      const pal = c.sel('Palette', () => [['', corr() ? 'Automatic (red–blue, diverging)' : 'Automatic (viridis)']].concat(CMAPS), () => app(R(), 'cmap', null) || '', (v) => setApp({ cmap: v || null }));
      const effCmap = () => app(R(), 'cmap', null) || (corr() ? 'RdBu_r' : 'viridis');
      const dataRange = () => {   // range of the drawn matrix (the backend widens a constant matrix by 0.5)
        const rec = R(), cs2 = cols(rec), rows = (rec.dataset && rec.dataset.rows) || []; let lo = Infinity, hi = -Infinity;
        sel().forEach((n) => { const i = cs2.findIndex((k) => k.name === n); rows.forEach((r) => { const v = r[i]; if (!gone(v) && isFinite(Number(v))) { lo = Math.min(lo, Number(v)); hi = Math.max(hi, Number(v)); } }); });
        return !isFinite(lo) ? [0, 1] : lo === hi ? [lo - 0.5, hi + 0.5] : [lo, hi];
      };
      const auto = () => (corr() ? [-1, 1] : dataRange());
      const eff = () => { const a = auto(), lo = opt(R(), 'vmin', null), hi = opt(R(), 'vmax', null); return [lo === null ? a[0] : lo, hi === null ? a[1] : hi]; };
      const fixed = () => opt(R(), 'vmin', null) !== null || opt(R(), 'vmax', null) !== null;
      const scaleSel = c.sel('Color scale limits', () => [['auto', corr() ? 'Automatic (−1 to 1)' : 'Automatic (data range)'], ['fixed', 'Fixed limits']], () => (fixed() ? 'fixed' : 'auto'), (v) => {
        if (v === 'auto') return setOpt({ vmin: null, vmax: null });
        const a = auto(); setOpt(corr() ? { vmin: -1, vmax: 1 } : { vmin: roundOut(a[0], -1), vmax: Math.max(roundOut(a[1], 1), roundOut(a[0], -1) + (a[1] > a[0] ? 0 : 1)) });
      });
      const lim = (label, key, side) => {
        const el = h('input', { class: 'input', type: 'number', step: 'any', 'aria-label': label, 'aria-invalid': 'false' }), msg = h('div', { class: 'fe__hint', role: 'status' });
        let bad = false;
        el.addEventListener('input', () => {
          const t = String(el.value).trim(), v = t === '' ? null : Number(t), e = eff(), other = side === 0 ? e[1] : e[0];
          const err = v === null ? '' : !isFinite(v) ? 'Enter a number.' : (side === 0 ? v >= other : v <= other) ? (side === 0 ? 'The minimum must be below the maximum (' + fmtN(other) + ').' : 'The maximum must be above the minimum (' + fmtN(other) + ').') : '';
          bad = !!err; el.setAttribute('aria-invalid', String(bad)); msg.textContent = err ? err + ' Not applied.' : '';
          if (!err) setOpt({ [key]: v });
        });
        local(() => { const v = opt(R(), key, null); if (!bad && !(v === null ? String(el.value).trim() === '' : Number(el.value) === v)) el.value = v === null ? '' : v; el.setAttribute('placeholder', 'auto ' + fmtN(auto()[side])); });
        return { box: field(label, el), msg };
      };
      const vmin = lim('Minimum (vmin)', 'vmin', 0), vmax = lim('Maximum (vmax)', 'vmax', 1);
      const limBox = h('div', { class: 'fe__g2' }, vmin.box, vmax.box), clipNote = h('div', { class: 'fe__hint' });
      local(() => { const f = fixed(); limBox.hidden = !f; vmin.msg.hidden = vmax.msg.hidden = !f; clipNote.hidden = !f; clipNote.textContent = 'Values outside the limits take the end color and the colorbar gets an arrow. An empty box keeps that side automatic.'; });
      const center = c.chk('Center colors at zero', () => !!DIVERGING[effCmap()], (v) => { const cm = app(R(), 'cmap', null); setApp({ cmap: v ? (cm && DIVERGING[cm] ? cm : null) : 'viridis' }); });
      const centerNote = h('div', { class: 'fe__hint' });
      local(() => {
        gate(center, corr(), 'Zero-centering applies to correlation matrices.');
        centerNote.textContent = !corr() ? 'Centering at zero applies in Correlation mode.' : DIVERGING[effCmap()] ? 'Zero is the middle color of the diverging palette, also when the limits are not symmetric. Choosing another palette in the list keeps your choice.' : 'The palette is not diverging, so no middle color marks zero. Tick this box to switch to the diverging palette.';
      });

      /* correlation settings */
      const method = c.sel('Correlation method', () => [['pearson', 'Pearson r (linear)'], ['spearman', 'Spearman ρ (rank)']], () => opt(R(), 'corrMethod', 'pearson'), (v) => setOpt({ corrMethod: v }));
      if (F.a11y) F.a11y.withHelp(method, 'Pearson r measures straight-line association, while Spearman ρ compares ranks, so it also fits steady curved trends and resists outliers.', 'Correlation method');
      const tri = c.sel('Triangle', () => [['full', 'Full matrix'], ['lower', 'Hide upper triangle'], ['upper', 'Hide lower triangle']], () => opt(R(), 'corrTriangle', 'full'), (v) => setOpt({ corrTriangle: v }));
      const corrNote = h('div', { class: 'fe__hint' });
      local(() => { const on = corr(); gate(method, on, 'Applies in Correlation mode.'); gate(tri, on, 'Applies in Correlation mode.'); corrNote.hidden = on; corrNote.textContent = 'Method, triangle and centering apply in Correlation mode.'; });

      /* values in cells */
      const annM = c.chk('Show values in cells', () => !!opt(R(), 'annotate', false), (v) => setOpt({ annotate: v }));
      const annC = c.chk('Show coefficients in cells', () => !!opt(R(), 'annotate', false), (v) => setOpt({ annotate: v }));
      const prec = c.num('Decimals (0–6)', 0, 6, 1, () => opt(R(), 'annotatePrecision', 2), (v) => setOpt({ annotatePrecision: Math.round(v) }));
      const size = c.num('Value size (pt)', 4, 48, 0.5, () => opt(R(), 'annotateSize', null), (v) => setOpt({ annotateSize: v }), () => fmtN(0.8 * app(R(), 'fontSize', 10)));
      const annNote = h('div', { class: 'fe__hint' });
      local(() => {
        const on = !!opt(R(), 'annotate', false), n = sel().length, cells = corr() ? n * n : n * (((R().dataset || {}).rows || []).length);
        annM.hidden = corr(); annC.hidden = !corr(); gate(prec, on, 'Turn on the values first.'); gate(size, on, 'Turn on the values first.');
        annNote.textContent = !on ? 'Turn on the values to set decimals and size.' : cells > 2500 ? 'More than 2 500 cells: the values are not written because they would be unreadable.' : '';
        annNote.hidden = !annNote.textContent;
      });

      /* colorbar, borders, label rotation */
      const cb = c.chk('Colorbar', () => opt(R(), 'colorbar', true), (v) => setOpt({ colorbar: v }));
      const cbl = h('input', { class: 'input', type: 'text', maxlength: 200, 'aria-label': 'Colorbar label' });
      cbl.addEventListener('input', () => setOpt({ colorbarLabel: cbl.value }));
      const cblF = field('Colorbar label', cbl); cblF.input = cbl;
      local(() => {
        const v = opt(R(), 'colorbarLabel', ''); if (cbl.value !== v) cbl.value = v;
        cbl.setAttribute('placeholder', corr() ? (opt(R(), 'corrMethod', 'pearson') === 'spearman' ? 'Spearman ρ' : 'Pearson r') : 'no label');
        gate(cblF, !!opt(R(), 'colorbar', true), 'Turn on the colorbar first.');
      });
      const bor = c.chk('Cell borders', () => !!opt(R(), 'cellBorders', false), (v) => setOpt({ cellBorders: v }));
      const borC = c.color('Border color', () => opt(R(), 'cellBorderColor', '#FFFFFF'), (v) => setOpt({ cellBorderColor: v || '#FFFFFF' }), () => '#FFFFFF');
      const borW = c.num('Border width (pt)', 0, 5, 0.25, () => opt(R(), 'cellBorderWidth', 0.5), (v) => setOpt({ cellBorderWidth: v }));
      local(() => { const on = !!opt(R(), 'cellBorders', false); gate(borC, on, 'Turn on cell borders first.'); gate(borW, on, 'Turn on cell borders first.'); });
      const rotX = c.num('Column label rotation (°)', -90, 90, 5, () => app(R(), 'xTickRotation', 0), (v) => setApp({ xTickRotation: v }));
      const rotY = c.num('Row label rotation (°)', -90, 90, 5, () => app(R(), 'yTickRotation', 0), (v) => setApp({ yTickRotation: v }));

      /* missing values: always masked, never filled in (no other handling exists) */
      const missInfo = h('div', { class: 'fe__hint', role: 'status' });
      local(() => {
        const rec = R(), cs2 = cols(rec), rows = (rec.dataset && rec.dataset.rows) || [], chosen = sel();
        let miss = 0; const weak = [];
        chosen.forEach((n) => {
          const i = cs2.findIndex((k) => k.name === n); let cnt = 0, sum = 0, sq = 0;
          rows.forEach((r) => { const v = r[i]; if (gone(v) || !isFinite(Number(v))) miss++; else { cnt++; sum += Number(v); sq += Number(v) * Number(v); } });
          if (cnt < 3 || sq / cnt - Math.pow(sum / cnt, 2) <= 1e-12 * Math.max(1, sq / cnt)) weak.push(n);
        });
        missInfo.textContent = corr()
          ? 'Each pair uses only the rows where both columns have a value. Pairs with fewer than 3 shared rows, or a column without variation, are undefined: drawn hatched gray, never as 0.' + (weak.length ? ' ' + weak.slice(0, 5).map(q).join(', ') + (weak.length > 5 ? ' and ' + (weak.length - 5) + ' more' : '') + (weak.length === 1 ? ' has' : ' have') + ' too few values or no variation.' : '')
          : (miss ? miss + ' of ' + chosen.length * rows.length + ' cells have no value. ' : 'No cell is empty now. ') + 'Empty cells are drawn hatched light gray and explained under the plot; they are never filled in or averaged.';
      });

      return [sub('Mode'), mode, modeHelp,
        sub('Columns'), colBox, h('div', { class: 'pd__checks' }, allBtn), colMsg, colInfo, rowSel, rowNote,
        sub('Correlation'), h('div', { class: 'fe__g2' }, method, tri), center, centerNote, corrNote,
        sub('Colors'), pal, scaleSel, limBox, vmin.msg, vmax.msg, clipNote,
        sub('Values in cells'), annM, annC, h('div', { class: 'fe__g2' }, prec, size), annNote,
        sub('Colorbar and borders'), h('div', { class: 'pd__checks' }, cb, bor), cblF, h('div', { class: 'fe__g2' }, borC, borW),
        sub('Labels'), h('div', { class: 'fe__g2' }, rotX, rotY),
        sub('Missing values'), missInfo];
    });
    return [note, lineG, scatterG, barG, histG, boxG, heatG];
  };
})(window.RPE = window.RPE || {});
