/* Figure editor sidebar groups Axes, Grid, Size (in) and Legend, plus the checks they share (contract s3c, s4l).
   Every control edits the draft only through ctx.set. An entry the backend would refuse (log axis with values <= 0,
   inverted or equal limits, sizes outside 0.5-30 in) is flagged inline and is NOT applied. */
(function (RPE) {
  'use strict';
  const F = RPE.figures = RPE.figures || {};
  const h = RPE.h;
  const C = F.controls = {};
  const SIDE = [0.5, 30], MAX_NAMES = 50, NONE = '(no group)';
  const round2 = (x) => Math.round(x * 100) / 100;
  const clamp = (v) => Math.min(SIDE[1], Math.max(SIDE[0], v));

  /* ---------- the draft read with the backend defaults (a fresh draft only carries what was edited) ---------- */
  const DEF = { gridMinor: false, gridStyle: 'solid', gridAlpha: 1, tickDirection: 'out', xTickRotation: 0, yTickRotation: 0, axisLines: true, showTicks: true, spineTop: null, spineRight: null, legendSize: null };
  const LEG = { show: true, pos: 'best', force: false, frame: null, labels: {} };
  C.ap = (rec, k) => {
    const a = rec.config.appearance || {};
    if (a[k] !== undefined) return a[k];
    if (k === 'grid') return rec.config.plotType !== 'heatmap';
    if (k === 'despine') return rec.config.plotType !== 'heatmap';
    return DEF[k];
  };
  C.lg = (rec, k) => { const l = (rec.config.appearance || {}).legend || {}; return l[k] !== undefined ? l[k] : LEG[k]; };
  C.op = (rec, k) => (rec.config.options || {})[k];

  /* ---------- axes: which axis takes scale/limits, which columns feed it, what would be refused ---------- */
  C.axisRoles = (rec) => {
    const t = rec.config.plotType, horizontal = C.op(rec, 'orient') === 'horizontal';
    if (t === 'heatmap') return { x: false, y: false };
    if (t === 'bar' || t === 'box') return horizontal ? { x: true, y: false } : { x: false, y: true };   // value axis only
    return { x: true, y: true };
  };
  C.axisColumns = (rec, axis) => {
    const t = rec.config.plotType, m = rec.config.mapping || {}, ys = m.y || [], ser = C.op(rec, 'series') || {};
    const vis = ys.filter((c) => !(ser[c] && ser[c].visible === false)), x = m.x ? [m.x] : [];
    if (t === 'line') return axis === 'x' ? x : vis;
    if (t === 'scatter') return axis === 'x' ? x : (m.group ? ys.slice(0, 1) : ys);
    if (t === 'hist') return axis === 'x' ? ys.slice(0, 1) : [];
    if (t === 'bar') return vis;
    if (t === 'box') return ys.slice(0, 1);
    return [];
  };
  /* number of values <= 0 in the given columns, and the first one (1-based data row) */
  C.nonPositive = (rec, cols) => {
    const ds = rec.dataset || {}, columns = ds.columns || [], rows = ds.rows || [];
    let count = 0, first = null;
    cols.forEach((name) => {
      const i = columns.findIndex((c) => c.name === name);
      if (i < 0 || columns[i].type !== 'number') return;
      for (let k = 0; k < rows.length; k++) { const v = rows[k][i]; if (typeof v === 'number' && v <= 0) { count++; if (!first) first = { column: name, row: k + 1, value: v }; } }
    });
    return { count, first };
  };
  /* null, or { code, message, canLinear } when this scale / limit pair would be refused by the backend */
  C.axisProblem = (rec, axis, scale, lim) => {
    if (scale !== 'log' || !C.axisRoles(rec)[axis]) return null;
    if (rec.config.plotType === 'bar' && C.op(rec, 'barMode') === 'stacked') return { code: 'stacked_log', canLinear: true, message: 'Stacked bars cannot use a log axis: the stacked lengths would not add up. Use a linear axis or grouped bars.' };
    const bad = C.nonPositive(rec, C.axisColumns(rec, axis));
    if (bad.count) return { code: 'log_nonpositive', canLinear: true, message: 'A log axis needs values above 0. Column “' + bad.first.column + '” has ' + bad.first.value + ' at data row ' + bad.first.row + (bad.count > 1 ? ' (and ' + (bad.count - 1) + ' more)' : '') + '.' };
    if (lim && (lim[0] <= 0 || lim[1] <= 0)) return { code: 'log_limits', canLinear: true, message: 'Limits must be above 0 on a log axis.' };
    return null;
  };
  /* bar chart whose value axis does not contain 0: bar lengths stop being proportional */
  C.truncated = (rec) => {
    if (rec.config.plotType !== 'bar') return false;
    const a = C.op(rec, 'orient') === 'horizontal' ? 'x' : 'y', lim = C.op(rec, a + 'Lim');
    return !!lim && C.op(rec, a + 'Scale') !== 'log' && !(lim[0] <= 0 && lim[1] >= 0);
  };

  /* ---------- size ---------- */
  /* keep the width, change the height to the ratio w:h; when the height would leave 0.5-30 in the width follows */
  C.ratioSize = (w, ratio) => {
    let nh = w / ratio;
    if (nh > SIDE[1] || nh < SIDE[0]) { nh = clamp(nh); w = nh * ratio; }
    return [round2(clamp(w)), round2(nh)];
  };
  /* a new width with the current shape (journal columns) */
  C.widthSize = (w, curW, curH) => [round2(w), round2(clamp(w * curH / curW))];

  /* ---------- legend: the entries a plot draws (series names are the keys of legend.labels) ---------- */
  function groupLabels(rec, col, noneLast) {
    const ds = rec.dataset || {}, i = (ds.columns || []).findIndex((c) => c.name === col), seen = new Set();
    let none = false;
    if (i < 0) return [];
    for (const r of ds.rows || []) {
      const v = r[i];
      if (v === null || v === undefined || v === '') { if (noneLast) none = true; else seen.add(NONE); } else seen.add(String(v));
      if (seen.size > MAX_NAMES) break;
    }
    const out = Array.from(seen);
    if (none) out.push(NONE);
    return out;
  }
  C.legendInfo = (rec) => {
    const t = rec.config.plotType, m = rec.config.mapping || {}, o = rec.config.options || {}, ys = m.y || [], ser = o.series || {};
    const vis = ys.filter((c) => !(ser[c] && ser[c].visible === false));
    let names = [], entries;
    if (t === 'box' || t === 'heatmap') return { applies: false, names, entries: 0 };
    if (t === 'line') names = vis;
    else if (t === 'scatter') names = m.group ? groupLabels(rec, m.group, true) : ys;
    else if (t === 'bar') names = m.group ? groupLabels(rec, m.group, false) : vis;
    else names = ys.slice(0, 1);
    names = names.slice(0, MAX_NAMES); entries = names.length;
    if (t === 'scatter' && o.fit && o.fit !== 'none') entries = names.length * (o.fitBand ? 3 : 2);
    if (t === 'hist' && o.normalFit && names.length) entries = 2;
    return { applies: true, names, entries };
  };

  /* ---------- the groups ---------- */
  const POS = [['best', 'Best'], ['upper right', 'Upper right'], ['upper left', 'Upper left'], ['lower left', 'Lower left'], ['lower right', 'Lower right'], ['center left', 'Center left'], ['center right', 'Center right'], ['lower center', 'Lower center'], ['upper center', 'Upper center'], ['center', 'Center'], ['outside', 'Outside (right)']];
  const STYLES = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted'], ['dashdot', 'Dash-dot']];
  const SUBTLE = [[0.35, 'Faint'], [0.6, 'Light'], [1, 'Normal']];
  const fmt = (v) => String(round2(v));

  /* kit = { ctx, reg, group(title, open, ...kids), field(label, control) } from the Preview tab */
  C.groups = function (kit) {
    const ctx = kit.ctx, reg = kit.reg, group = kit.group, field = kit.field, R = () => ctx.record;
    const setApp = (p) => ctx.set({ config: { appearance: p } });
    const setOpt = (p) => ctx.set({ config: { options: p } });
    const mkNote = () => h('div', { class: 'fe__note', role: 'status', hidden: true });
    const say = (el, msg, fix) => {
      el.textContent = ''; el.hidden = !msg;
      if (!msg) return;
      el.append(h('span', null, msg));
      if (fix) el.append(h('button', { type: 'button', class: 'btn btn--sm', onclick: fix.run }, fix.label));
    };
    const chk = (label, read, write) => {
      const el = h('input', { type: 'checkbox' });
      el.addEventListener('change', () => write(!!el.checked));
      reg(() => { el.checked = !!read(); });
      const box = h('label', { class: 'check' }, el, label); box.input = el;
      return box;
    };
    const sel = (label, opts, read, write) => {
      const el = h('select', { class: 'select', 'aria-label': label }, opts.map((o) => h('option', { value: String(o[0]) }, o[1])));
      el.addEventListener('change', () => write(el.value));
      reg(() => { const v = String(read()); if (el.value !== v) el.value = v; });
      const f = field(label, el); f.input = el;
      return f;
    };
    /* one number: empty = o.empty (undefined = not allowed); out of range, or refused by o.write (returns text), is flagged and not applied */
    const box = (label, o) => {
      const el = h('input', { class: 'input', type: 'number', step: o.step || 'any', min: o.lo, max: o.hi, placeholder: o.ph || '', 'aria-label': label, 'aria-invalid': 'false', title: o.title || '' });
      let bad = false;
      el.addEventListener('input', () => {
        const t = String(el.value).trim(), v = t === '' ? o.empty : Number(t);
        let msg = '';
        bad = v === undefined || (v !== null && (!isFinite(v) || v < o.lo || v > o.hi));
        if (bad) msg = o.msg;
        else { const e = o.write(v); if (e) { bad = true; msg = e; } }
        el.setAttribute('aria-invalid', String(bad));
        if (o.note) say(o.note, msg);
      });
      reg(() => {
        if (bad) return;
        const v = o.read(), t = String(el.value).trim();
        const same = t === '' ? (v === null || v === undefined || v === o.empty) : Number(t) === v;
        if (!same) el.value = v === null || v === undefined ? '' : v;
      });
      const f = field(o.text || label, el);
      f.reset = () => { bad = false; el.setAttribute('aria-invalid', 'false'); if (o.note) say(o.note, ''); };
      return f;
    };

    /* ----- Axes ----- */
    const st = { x: { scale: null, limMsg: '', limFix: false }, y: { scale: null, limMsg: '', limFix: false } };
    const recScale = (a) => C.op(R(), a + 'Scale') || 'linear', recLim = (a) => C.op(R(), a + 'Lim') || null;
    const rangeHint = h('div', { class: 'fe__hint', hidden: true });
    function axisBlock(a) {
      const s = st[a], L = a.toUpperCase(), msg = mkNote();
      const lo = h('input', { class: 'input', type: 'number', step: 'any', placeholder: 'auto', 'aria-label': L + ' min', 'aria-invalid': 'false' });
      const hi = h('input', { class: 'input', type: 'number', step: 'any', placeholder: 'auto', 'aria-label': L + ' max', 'aria-invalid': 'false' });
      const text = (el) => String(el.value).trim(), flag = (on) => { lo.setAttribute('aria-invalid', String(on)); hi.setAttribute('aria-invalid', String(on)); };
      function applyLimits() {
        const a1 = text(lo) === '' ? null : Number(text(lo)), a2 = text(hi) === '' ? null : Number(text(hi));
        s.limMsg = ''; s.limFix = false;
        if (a1 === null && a2 === null) { if (recLim(a)) setOpt({ [a + 'Lim']: null }); }
        else {
          if (a1 === null || a2 === null) s.limMsg = 'Enter both min and max, or press Auto.';
          else if (!isFinite(a1) || !isFinite(a2)) s.limMsg = 'Limits must be numbers.';
          else if (a1 >= a2) s.limMsg = a1 === a2 ? 'Min and max are equal: the axis would have no range.' : 'Min is above max: the limits are inverted.';
          else {
            const p = C.axisProblem(R(), a, s.scale || recScale(a), [a1, a2]);
            if (p && p.code === 'log_limits') { s.limMsg = p.message; s.limFix = true; }
          }
          if (!s.limMsg) { const cur = recLim(a); if (!cur || cur[0] !== a1 || cur[1] !== a2) setOpt({ [a + 'Lim']: [a1, a2] }); }
        }
        refresh();
      }
      function toLinear() { s.scale = null; setOpt({ [a + 'Scale']: 'linear' }); if (s.limMsg) applyLimits(); else refresh(); }
      const scaleF = sel(L + ' scale', [['linear', 'Linear'], ['log', 'Log']], () => s.scale || recScale(a), (v) => {
        if (v === 'log' && C.axisProblem(R(), a, 'log', recLim(a))) { s.scale = 'log'; return refresh(); }   // refused: not written
        s.scale = null; setOpt({ [a + 'Scale']: v });
        if (s.limMsg) applyLimits(); else refresh();
      });
      if (F.a11y) F.a11y.withHelp(scaleF, 'A log axis needs every value on that axis to be greater than zero, because zero and negative values cannot be placed on it.', L + ' log scale');
      const auto = h('button', { type: 'button', class: 'btn btn--sm', title: 'Let the plot choose ' + L + ' limits', 'aria-label': 'Automatic ' + L + ' limits', onclick: () => { lo.value = ''; hi.value = ''; applyLimits(); } }, 'Auto');
      lo.addEventListener('input', applyLimits); hi.addEventListener('input', applyLimits);
      function refresh() {
        const rec = R(), cur = recLim(a);
        block.hidden = !C.axisRoles(rec)[a];
        if (s.scale && !C.axisProblem(rec, a, s.scale, cur)) s.scale = null;        // the data allow it again: back to the recorded scale
        if (!s.limMsg) {                                                               // inputs follow the draft unless they hold an unapplied entry
          if (cur) { if (text(lo) === '' || Number(text(lo)) !== cur[0]) lo.value = String(cur[0]); if (text(hi) === '' || Number(text(hi)) !== cur[1]) hi.value = String(cur[1]); }
          else if (text(lo) !== '' || text(hi) !== '') { lo.value = ''; hi.value = ''; }
        }
        flag(!!s.limMsg);
        auto.disabled = !cur && text(lo) === '' && text(hi) === '';
        const prob = C.axisProblem(rec, a, s.scale || recScale(a), cur);
        const text_ = s.limMsg ? s.limMsg + ' Not applied.' : prob ? prob.message : '';
        say(msg, text_, (s.limMsg ? s.limFix : prob && prob.canLinear) ? { label: 'Switch to linear', run: toLinear } : null);
      }
      const block = h('div', { class: 'fe__g2' }, scaleF, h('div', { class: 'field' }, h('span', { class: 'field__label', 'aria-hidden': 'true' }, '\u00a0'), auto), field(L + ' min', lo), field(L + ' max', hi), msg);
      reg(refresh);
      return block;
    }
    const mark = chk('Mark on the figure', () => !!C.op(R(), 'axisNote'), (v) => setOpt({ axisNote: v }));
    const trunc = h('div', { class: 'fe__note', hidden: true, role: 'status' }, h('span', null, 'The value axis does not start at 0, so bar lengths are not proportional to the values.'), mark);
    const axesG = group('Axes', false,
      h('div', { class: 'pd__checks' },
        chk('Open axes', () => C.ap(R(), 'despine'), (v) => setApp({ despine: v, spineTop: null, spineRight: null })),
        chk('Axis lines', () => C.ap(R(), 'axisLines'), (v) => setApp({ axisLines: v })),
        chk('Show top', () => { const v = C.ap(R(), 'spineTop'); return v === null ? !C.ap(R(), 'despine') : v; }, (v) => setApp({ spineTop: v })),
        chk('Show right', () => { const v = C.ap(R(), 'spineRight'); return v === null ? !C.ap(R(), 'despine') : v; }, (v) => setApp({ spineRight: v })),
        chk('Ticks', () => C.ap(R(), 'showTicks'), (v) => setApp({ showTicks: v }))),
      h('div', { class: 'fe__g2' },
        sel('Tick direction', [['out', 'Out'], ['in', 'In'], ['inout', 'In and out']], () => C.ap(R(), 'tickDirection'), (v) => setApp({ tickDirection: v })),
        h('span'),
        ...['x', 'y'].map((a) => box(a.toUpperCase() + ' label rotation', { text: a.toUpperCase() + ' labels (°)', lo: -90, hi: 90, step: 5, empty: 0, ph: '0', title: 'Tick label rotation, -90 to 90 degrees', msg: 'Rotation must be between -90 and 90 degrees.', read: () => C.ap(R(), a + 'TickRotation'), write: (v) => { setApp({ [a + 'TickRotation']: v }); } }))),
      rangeHint, axisBlock('x'), axisBlock('y'), trunc);
    reg(() => {
      const t = R().config.plotType;
      rangeHint.hidden = !(t === 'heatmap' || t === 'bar' || t === 'box');
      rangeHint.textContent = t === 'heatmap' ? 'Scale and limits do not apply to heatmaps.' : 'Scale and limits apply to the value axis only.';
      trunc.hidden = !C.truncated(R());
    });

    /* ----- Grid ----- */
    const nearest = () => String(SUBTLE.reduce((b, o) => (Math.abs(o[0] - C.ap(R(), 'gridAlpha')) < Math.abs(b - C.ap(R(), 'gridAlpha')) ? o[0] : b), SUBTLE[2][0]));
    const gridG = group('Grid', false,
      h('div', { class: 'pd__checks' }, chk('Major', () => C.ap(R(), 'grid'), (v) => setApp({ grid: v })), chk('Minor', () => C.ap(R(), 'gridMinor'), (v) => setApp({ gridMinor: v }))),
      h('div', { class: 'fe__g2' }, sel('Grid style', STYLES, () => C.ap(R(), 'gridStyle'), (v) => setApp({ gridStyle: v })), sel('Grid subtlety', SUBTLE, nearest, (v) => setApp({ gridAlpha: Number(v) }))));
    reg(() => { gridG.hidden = R().config.plotType === 'heatmap'; });

    /* ----- Size (in): width and height in inches; resolution (DPI) lives only in the Export tab ----- */
    const lock = h('input', { type: 'checkbox' }), sizeNote = mkNote(), readout = h('div', { class: 'fe__hint' });
    const setSize = (w, hh) => { wF.reset(); hF.reset(); say(sizeNote, ''); ctx.set({ export: { wIn: w, hIn: hh } }); };
    const edit = (axis) => (v) => {      // lock ratio: the other side follows the current shape
      const e = R().export, other = axis === 'w' ? round2(v * e.hIn / e.wIn) : round2(v * e.wIn / e.hIn);
      if (lock.checked && (other < SIDE[0] || other > SIDE[1])) return 'The ' + (axis === 'w' ? 'height' : 'width') + ' would leave ' + SIDE[0] + ' to ' + SIDE[1] + ' in. Unlock the ratio or choose a smaller size.';
      ctx.set({ export: axis === 'w' ? { wIn: v, hIn: lock.checked ? other : e.hIn } : { hIn: v, wIn: lock.checked ? other : e.wIn } });
      return '';
    };
    const dim = (axis, label) => box(label + ' in inches', { text: label + ' (in)', lo: SIDE[0], hi: SIDE[1], step: 0.1, msg: label + ' must be between ' + SIDE[0] + ' and ' + SIDE[1] + ' in.', note: sizeNote, read: () => R().export[axis + 'In'], write: edit(axis) });
    const wF = dim('w', 'Width'), hF = dim('h', 'Height');
    const ratioBtn = (label, r, title) => h('button', { type: 'button', class: 'btn btn--sm', title: title, onclick: () => { const e = R().export, s = C.ratioSize(e.wIn, r); setSize(s[0], s[1]); } }, label);
    const widthBtn = (label, w) => h('button', { type: 'button', class: 'btn btn--sm', title: w + ' in wide, same shape', onclick: () => { const e = R().export, s = C.widthSize(w, e.wIn, e.hIn); setSize(s[0], s[1]); } }, label);
    reg(() => { const e = R().export; readout.textContent = fmt(e.wIn) + ' × ' + fmt(e.hIn) + ' in (' + (Math.round(e.wIn * 254) / 100) + ' × ' + (Math.round(e.hIn * 254) / 100) + ' cm). Resolution is set in the Export tab.'; });
    const sizeG = group('Size (in)', false,
      h('div', { class: 'fe__g2' }, wF, hF),
      h('label', { class: 'check' }, lock, 'Lock ratio'),
      h('div', { class: 'fe__btns', role: 'group', 'aria-label': 'Size presets' },
        ratioBtn('16:9', 16 / 9, 'Keep the width, height for 16:9'), ratioBtn('4:3', 4 / 3, 'Keep the width, height for 4:3'), ratioBtn('3:2', 3 / 2, 'Keep the width, height for 3:2'), ratioBtn('1:1 square', 1, 'Square: height = width'),
        widthBtn('Journal 1-col', 3.4), widthBtn('Journal 2-col', 7)),
      sizeNote, readout);

    /* ----- Legend ----- */
    const setLeg = (p) => ctx.set((r) => { const a = r.config.appearance; a.legend = Object.assign({}, LEG, a.legend, p); });
    const setLabel = (name, v) => ctx.set((r) => {
      const a = r.config.appearance, l = Object.assign({}, LEG, a.legend), m = Object.assign({}, l.labels);
      if (v.trim() === '') delete m[name]; else m[name] = v;
      l.labels = m; a.legend = l;
    });
    const single = h('div', { class: 'fe__hint', role: 'status', hidden: true }, 'A single series: the legend is hidden automatically. Tick “Show anyway” to draw it.');
    const force = chk('Show anyway', () => !!C.lg(R(), 'force'), (v) => setLeg({ force: v }));
    const names = h('div', { class: 'fe__labels' }), namesHead = h('div', { class: 'fe__hint' }, 'Legend text (empty = original name)');
    let inputs = {}, key = null;
    const legendG = group('Legend', false,
      h('div', { class: 'pd__checks' }, chk('Show legend', () => !!C.lg(R(), 'show'), (v) => setLeg({ show: v })), chk('Frame', () => { const f = C.lg(R(), 'frame'); return f === null ? C.lg(R(), 'pos') !== 'outside' : f; }, (v) => setLeg({ frame: v })), force),
      h('div', { class: 'fe__g2' },
        sel('Legend position', POS, () => C.lg(R(), 'pos'), (v) => setLeg({ pos: v })),
        box('Legend font size in points', { text: 'Font (pt)', lo: 4, hi: 72, step: 0.5, empty: null, ph: 'auto', title: '4 to 72 pt; empty = automatic', msg: 'Font size must be between 4 and 72 pt.', read: () => C.ap(R(), 'legendSize'), write: (v) => { setApp({ legendSize: v }); } })),
      single, namesHead, names);
    reg(() => {
      const rec = R(), info = C.legendInfo(rec), labels = C.lg(rec, 'labels') || {};
      legendG.hidden = !info.applies;
      single.hidden = !(info.applies && C.lg(rec, 'show') && info.entries <= 1 && !C.lg(rec, 'force'));
      force.hidden = info.entries > 1;
      namesHead.hidden = !info.names.length;
      const k = info.names.join('\u0001');
      if (k !== key) {
        key = k; inputs = {}; names.textContent = '';
        info.names.forEach((n) => {
          const el = h('input', { class: 'input', type: 'text', maxlength: 200, placeholder: n, 'aria-label': 'Legend label for ' + n });
          el.addEventListener('input', () => setLabel(n, el.value));
          inputs[n] = el; names.append(field(n, el));
        });
      }
      info.names.forEach((n) => { const el = inputs[n], v = labels[n] || ''; if (el && el.value !== v && !(v === '' && String(el.value).trim() === '')) el.value = v; });
    });
    return [axesG, gridG, sizeG, legendG];
  };
})(window.RPE = window.RPE || {});
