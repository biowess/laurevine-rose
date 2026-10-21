/* figures/datasource.js — where a figure's data comes from (namespace RPE.figures.datasource; contract section 3d).
   open(ctx, anchor)  chooser behind the editor's header chip: Sample data | Import CSV | Enter/edit spreadsheet | Define data in Python.
   attach(ctx)        called by the editor: new empty figures start on the sample for their plot type; an UNEDITED sample follows plot-type changes.
   status(ctx)        element for the editor header: "Sample data" badge + Reset, or the Python-controlled banner.
   Pure helpers (tested): roles, guess, sameData, applyData. All edits go through ctx.set (the draft only). */
(function (RPE) {
  'use strict';
  const F = RPE.figures = RPE.figures || {};
  const U = RPE.ui, h = U.h;
  const ic = (n) => (RPE.icons && RPE.icons.html ? RPE.icons.html(n) : '');

  const ROLES = {
    line: [['x', 'X axis', 0, 0], ['y', 'Y series', 1, 1], ['yErr', 'Error bars (±)', 0, 0]],
    scatter: [['x', 'X axis', 0, 1], ['y', 'Y values', 0, 1], ['group', 'Group', 0, 0]],
    bar: [['x', 'Categories', 0, 0], ['y', 'Bar values', 1, 1], ['group', 'Group', 0, 0], ['yErr', 'Error bars (±)', 0, 0]],
    hist: [['y', 'Values', 0, 1]],
    box: [['y', 'Values', 0, 1], ['group', 'Group', 0, 0]],
    heatmap: [['x', 'Row labels', 0, 0], ['y', 'Value columns (none = all numeric)', 1, 0]]
  };   // [key, label, multi, required]
  const SOURCES = [['sample', 'Sample data'], ['csv', 'Import CSV…'], ['sheet', 'Enter / edit spreadsheet'], ['python', 'Define data in Python…']];
  const EMPTY_MAP = () => ({ x: null, y: [], group: null, yErr: null });
  const roles = (plotType) => (ROLES[plotType] || ROLES.line).map((r) => ({ key: r[0], label: r[1], multi: !!r[2], required: !!r[3] }));
  const hasRows = (rec) => !!(rec.dataset && rec.dataset.columns && rec.dataset.columns.length && rec.dataset.rows && rec.dataset.rows.length);
  const originOf = (rec) => (rec.dataset && rec.dataset.origin) || {};
  const sameData = (a, b) => !!a && !!b && a.rows.length === b.rows.length && JSON.stringify([a.columns, a.rows]) === JSON.stringify([b.columns, b.rows]);

  /* Editable first guess: only the FIRST column is suggested for X / categories (or Group for a text first column of a box plot);
     Y = the numeric columns after it (one for scatter, histogram and box). Nothing else is guessed. */
  function guess(plotType, columns) {
    const m = EMPTY_MAP(), spec = roles(plotType), has = (k) => spec.some((r) => r.key === k);
    const first = columns[0];
    if (first && has('x') && (first.type === 'number' || plotType === 'bar' || plotType === 'heatmap')) m.x = first.name;
    else if (first && plotType === 'box' && first.type === 'text') m.group = first.name;
    const nums = columns.filter((c) => c.type === 'number' && c.name !== m.x && c.name !== m.group).map((c) => c.name);
    if (has('y')) m.y = spec.find((r) => r.key === 'y').multi ? nums : nums.slice(0, 1);
    return m;
  }

  /* Replaces the draft's data. mapping/options come from the caller; stale per-column settings never survive. */
  function applyData(ctx, d) {
    ctx.set((r) => {
      r.dataset = r.dataset || {};
      r.dataset.columns = d.columns; r.dataset.rows = d.rows; r.dataset.origin = d.origin;
      r.originalCsv = d.originalCsv || null;
      r.config.mapping = Object.assign(EMPTY_MAP(), d.mapping || {});
      const o = r.config.options = r.config.options || {}, extra = d.options || {};
      o.series = extra.series || {}; o.xLim = null; o.yLim = null;
      o.xScale = extra.xScale || 'linear'; o.yScale = extra.yScale || 'linear';
      Object.keys(extra).forEach((k) => { if (k !== 'series') o[k] = extra[k]; });
      if (r.config.appearance && r.config.appearance.legend) r.config.appearance.legend.labels = {};
    });
  }

  const stateOf = new WeakMap();   // ctx -> { base: sample payload for base.plotType, gen }
  const st = (ctx) => { let s = stateOf.get(ctx); if (!s) { s = { base: null, gen: 0, plotType: ctx.record.config.plotType, subs: [] }; stateOf.set(ctx, s); } return s; };

  function fetchSample(plotType) {
    return RPE.backend.request('figures.sample', { plotType }).then((res) => {
      if (res && res.ok && res.data && res.data.dataset) return res.data;
      throw new Error((res && res.message) || 'The sample data could not be loaded.');
    });
  }
  const sampleOrigin = (s) => ({ type: 'sample', label: s.label, sampleId: s.sampleId, fileName: null });
  function useSample(ctx, s) {
    st(ctx).base = s;
    const copy = JSON.parse(JSON.stringify(s.dataset));   // the baseline must not share arrays with the editable draft
    applyData(ctx, { columns: copy.columns, rows: copy.rows, origin: sampleOrigin(s), mapping: s.mapping, options: s.options });
  }
  const failed = (e) => U.toast((e && e.message) || 'The sample data could not be loaded.', { kind: 'warn' });
  const isEdited = (ctx) => { const s = st(ctx).base; return !s || !sameData(ctx.record.dataset, s.dataset); };

  async function loadSample(ctx) {
    const mine = ++st(ctx).gen;
    try { const s = await fetchSample(ctx.record.config.plotType); if (mine === st(ctx).gen) useSample(ctx, s); } catch (e) { failed(e); }
  }
  async function resetSample(ctx) {
    const rec = ctx.record, s = st(ctx);
    if (!s.base || s.base.plotType !== rec.config.plotType) { try { s.base = await fetchSample(rec.config.plotType); } catch (e) { return failed(e); } }
    if (isEdited(ctx) && !(await U.confirm({ title: 'Reset to sample data?', message: 'The data of this figure has been changed or replaced. Resetting restores the sample data and its column settings.', confirmLabel: 'Reset', danger: true }))) return;
    useSample(ctx, s.base);
  }

  F.datasource = {
    roles, guess, sameData, applyData, SOURCES,
    attach(ctx) {
      const rec = ctx.record, s = st(ctx);
      if (rec.kind === 'structured' && ctx.isNew && !hasRows(rec) && (rec.dataset.columns || []).length === 0) loadSample(ctx);
      else if (originOf(rec).type === 'sample') fetchSample(rec.config.plotType).then((b) => { s.base = b; s.subs.forEach((fn) => fn()); }).catch(() => {});
      ctx.onChange(async () => {
        const type = ctx.record.config.plotType;
        if (type === s.plotType) return;
        const prev = s.plotType; s.plotType = type;
        if (originOf(ctx.record).type !== 'sample' || !s.base || s.base.plotType !== prev || isEdited(ctx)) return;
        loadSample(ctx);
      });
    },
    status(ctx) {
      const box = h('div', { class: 'ds__strip', hidden: true });
      const sync = () => {
        const rec = ctx.record, o = originOf(rec);
        box.textContent = '';
        if (o.type === 'sample') {
          const edited = st(ctx).base && st(ctx).base.plotType === rec.config.plotType && isEdited(ctx);
          box.append(h('span', { class: 'chip ds__badge', role: 'status' }, edited ? 'Sample data · edited' : 'Sample data'),
            h('span', { class: 'fe__hint' }, o.label ? o.label + ' — example values, replace them with your own.' : 'Example values, replace them with your own.'),
            h('button', { type: 'button', class: 'btn btn--sm', onclick: () => resetSample(ctx) }, 'Reset to sample data'));
        } else if (o.type === 'python' && o.code) {
          box.append(h('span', { class: 'chip ds__badge ds__badge--py', role: 'status' }, 'Python'),
            h('span', { class: 'fe__hint' }, 'Python-controlled; spreadsheet shows a snapshot only. Edits in the spreadsheet are replaced when the script runs again.'),
            h('button', { type: 'button', class: 'btn btn--sm', onclick: () => pythonDialog(ctx) }, 'Edit data script…'));
        }
        box.hidden = !box.childNodes.length;
      };
      ctx.onChange(sync); st(ctx).subs.push(sync); sync();
      return box;
    },
    open(ctx, anchor) {
      const cur = originOf(ctx.record).type, list = h('div', { class: 'menu' }, h('div', { class: 'menu__head' }, 'Data source'));
      SOURCES.forEach(([id, label]) => {
        const on = id === cur, text = id === 'sample' && on ? 'Reset to sample data' : label;
        list.appendChild(h('button', { type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(on), class: 'menu__item' + (on ? ' is-checked' : ''),
          html: `<span class="menu__icon">${on ? ic('check') : ''}</span><span class="menu__label">${U.esc(text)}</span>`, onclick: () => { U.closeAll(); F.datasource.choose(id, ctx); } }));
      });
      return U.popover(anchor, list, { role: 'menu', focusFirst: true });
    },
    async choose(id, ctx) {
      const rec = ctx.record, o = originOf(rec);
      if (id === 'csv') return csvWizard(ctx);
      if (id === 'python') return pythonDialog(ctx);
      if (id === 'sample') {
        if (o.type === 'sample') return resetSample(ctx);
        if (hasRows(rec) && !(await U.confirm({ title: 'Replace the data with sample data?', message: 'The current data of this figure will be replaced by the sample data for this plot type.', confirmLabel: 'Use sample data', danger: true }))) return;
        return loadSample(ctx);
      }
      if (o.type === 'sample' || o.type === 'python') {      // the table becomes hand-owned: detach the badge / script
        if (o.type === 'python' && !(await U.confirm({ title: 'Edit the table by hand?', message: 'The data script will no longer be linked to this figure; the table keeps its current values.', confirmLabel: 'Use spreadsheet' }))) return;
        ctx.set((r) => { r.dataset.origin = { type: 'sheet', label: '', sampleId: null, fileName: null }; });
      }
      ctx.showTab('spreadsheet');
    }
  };

  /* ---------- shared bits ---------- */
  const field = (label, ...kids) => h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), ...kids);
  const select = (opts, value, onchange) => {
    const el = h('select', { class: 'select' }, ...opts.map(([v, l, dis, tip]) => h('option', { value: v, disabled: !!dis, title: tip || '' }, l)));
    el.value = value; el.addEventListener('change', () => onchange(el.value)); return el;
  };
  const tag = (c) => (c.type === 'number' ? '123' : 'Aa');

  /* ---------- CSV wizard ---------- */
  function csvWizard(ctx) {
    const plotType = ctx.record.config.plotType, spec = roles(plotType);
    const S = { parsed: null, file: null, delim: 'auto', header: 'auto', map: EMPTY_MAP(), busy: false };
    const msg = h('div', { class: 'ds__msg', role: 'status' });
    const pick = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain', hidden: true });
    const drop = h('div', { class: 'ds__drop', tabindex: '0', role: 'button', 'aria-label': 'Choose a CSV file or drop one here' },
      h('strong', {}, 'Drop a CSV file here'), h('span', { class: 'fe__hint' }, 'or choose one from your computer (up to 5 MB). Comma, semicolon, tab and pipe separated files are recognised.'),
      h('button', { type: 'button', class: 'btn btn--sm', onclick: () => pick.click() }, 'Choose file…'));
    const detail = h('div', { class: 'ds__detail', hidden: true });
    const body = h('div', { class: 'ds' }, drop, pick, msg, detail);
    let dlg;
    const setMsg = (t, kind) => { msg.textContent = t || ''; msg.className = 'ds__msg' + (kind ? ' is-' + kind : ''); };

    async function parse(extra) {
      if (S.busy) return; S.busy = true; setMsg('Reading the file…');
      const p = Object.assign({ plotType, delimiter: S.delim === 'auto' ? undefined : S.delim, hasHeader: S.header === 'auto' ? undefined : S.header === 'yes', fileName: S.file.name }, extra);
      const res = await RPE.backend.request('figures.dataset.parse', p);
      S.busy = false;
      if (!res || !res.ok) return setMsg((res && res.message) || 'The file could not be read.', 'error');
      const d = res.data;
      if (!d.ok) { S.parsed = null; detail.hidden = true; return setMsg((d.errors || []).map((e) => e.message).join(' ') || 'This file cannot be used.', 'error'); }
      S.parsed = d; setMsg('');
      S.map = guess(plotType, d.columns);
      render(); validate();
    }
    function load(file) {
      if (!file) return; S.file = file; S.delim = 'auto'; S.header = 'auto';
      parse({ file });
    }
    pick.addEventListener('change', () => load(pick.files[0]));
    ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('is-over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); load(e.dataTransfer && e.dataTransfer.files[0]); });
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick.click(); } });

    const notes = () => (S.parsed && S.parsed.columnNotes) || {};
    const blocked = (col, role) => (notes()[col] || {})[role] || '';
    function render() {
      const d = S.parsed, DEL = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };
      detail.hidden = false; detail.textContent = '';
      const reparse = (k, v) => { S[k] = v; parse({ text: d.originalText }); };
      detail.appendChild(h('div', { class: 'ds__opts' },
        field('Separator', select([['auto', 'Auto (found: ' + (DEL[d.delimiter] || d.delimiter) + ')'], [',', 'Comma'], [';', 'Semicolon'], ['tab', 'Tab'], ['|', 'Pipe']], S.delim, (v) => reparse('delim', v))),
        field('First row', select([['auto', 'Auto (found: ' + (d.hasHeader ? 'column names' : 'data') + ')'], ['yes', 'Column names'], ['no', 'Data (no header)']], S.header, (v) => reparse('header', v))),
        h('span', { class: 'fe__hint' }, `${d.report.rowCount} rows, ${d.report.columnCount} columns` + (d.report.truncated ? ' (truncated to the import limit)' : '') + (d.encoding ? ', ' + d.encoding : ''))));
      const warn = (d.warnings || []).filter((w) => w.level !== 'info').concat(d.report.emptyColumns && d.report.emptyColumns.length && !(d.warnings || []).some((w) => w.code === 'empty_column') ? [{ message: 'Empty columns: ' + d.report.emptyColumns.join(', ') + '.' }] : []);
      if (warn.length) detail.appendChild(h('ul', { class: 'ds__warn' }, ...warn.slice(0, 6).map((w) => h('li', {}, w.message)), warn.length > 6 ? h('li', {}, `…and ${warn.length - 6} more.`) : null));
      const rep = d.report.columns || [];
      const head = d.columns.map((c, i) => `<th><span class="ds__tag">${tag(c)}</span> ${U.esc(c.name)}${rep[i] && (rep[i].missing || rep[i].invalid) ? `<small>${rep[i].missing ? rep[i].missing + ' empty' : ''}${rep[i].missing && rep[i].invalid ? ', ' : ''}${rep[i].invalid ? rep[i].invalid + ' invalid' : ''}</small>` : ''}</th>`).join('');
      const rows = d.rows.slice(0, 20).map((r) => '<tr>' + r.map((v) => `<td${v === null ? ' class="is-na"' : ''}>${v === null ? '—' : U.esc(String(v))}</td>`).join('') + '</tr>').join('');
      detail.appendChild(h('div', { class: 'ds__preview', html: `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` }));
      detail.appendChild(h('div', { class: 'ds__sub' }, 'Use columns for ' + (RPE.plots && RPE.plots.KINDS[plotType] ? RPE.plots.KINDS[plotType].label.toLowerCase() : plotType) + ' (suggested; change as needed)'));
      detail.appendChild(h('div', { class: 'ds__roles' }, ...spec.map(roleControl)));
    }
    function roleControl(r) {
      const d = S.parsed, wrap = h('div', { class: 'ds__role' }), why = h('div', { class: 'ds__why' });
      const blockedList = d.columns.filter((c) => blocked(c.name, r.key));
      const taken = (c) => [S.map.x, S.map.group, S.map.yErr].includes(c.name);   // a column holds one role
      if (r.multi) {
        wrap.appendChild(h('div', { class: 'field__label' }, r.label + (r.required ? ' *' : '')));
        wrap.appendChild(h('div', { class: 'ds__checks' }, ...d.columns.map((c) => {
          const why1 = blocked(c.name, r.key), off = !!why1 || taken(c);
          const cb = h('input', { type: 'checkbox', disabled: off, checked: !off && S.map[r.key].includes(c.name) });
          cb.addEventListener('change', () => { S.map[r.key] = cb.checked ? S.map[r.key].concat(c.name) : S.map[r.key].filter((n) => n !== c.name); validate(); });
          return h('label', { class: 'ds__chk' + (off ? ' is-off' : ''), title: why1 }, cb, h('span', { class: 'ds__tag' }, tag(c)), c.name);
        })));
      } else {
        const opts = [['', r.required ? '— choose a column —' : '— none —']].concat(d.columns.map((c) => [c.name, c.name + (blocked(c.name, r.key) ? ' (unavailable)' : ''), !!blocked(c.name, r.key), blocked(c.name, r.key)]));
        wrap.appendChild(field(r.label + (r.required ? ' *' : ''), select(opts, S.map[r.key] || '', (v) => { S.map[r.key] = v || null; if (v) { S.map.y = S.map.y.filter((n) => n !== v); ['x', 'group', 'yErr'].forEach((k) => { if (k !== r.key && S.map[k] === v) S.map[k] = null; }); } render(); validate(); })));
      }
      if (blockedList.length) {
        const first = blockedList.slice(0, 3);
        first.forEach((c) => why.appendChild(h('div', {}, blocked(c.name, r.key))));
        if (blockedList.length > 3) why.appendChild(h('div', {}, `…and ${blockedList.length - 3} more columns cannot be used here.`));
        wrap.appendChild(why);
      }
      return wrap;
    }
    function validate() {
      let problem = '';
      if (S.parsed) {
        const m = S.map, numeric = S.parsed.columns.filter((c) => c.type === 'number' && !blocked(c.name, 'y'));
        for (const r of spec) if (r.required && !(r.multi ? m[r.key].length : m[r.key])) { problem = `Choose a column for ${r.label.toLowerCase()}.`; break; }
        if (!problem && plotType === 'heatmap' && (m.y.length ? m.y.length : numeric.length) < 2) problem = 'A heatmap needs at least two numeric columns.';
      } else problem = 'Choose a file first.';
      if (dlg) dlg.buttons.import.disabled = !!problem;
      if (S.parsed) setMsg(problem, problem ? 'warn' : '');
    }
    function commit() {
      const d = S.parsed; if (!d) return false;
      const fname = (S.file && S.file.name) || d.fileName || 'data.csv';
      applyData(ctx, { columns: d.columns, rows: d.rows, origin: { type: 'csv', label: fname, sampleId: null, fileName: fname }, originalCsv: d.originalText, mapping: S.map });
    }
    dlg = U.dialog({ title: 'Import CSV', icon: 'file-up', width: 760, dismiss: 'backdrop', body,
      buttons: [{ label: 'Cancel', value: false }, { id: 'import', label: 'Import data', kind: 'primary', value: true, onClick: commit }] });
    dlg.buttons.import.disabled = true;
    return dlg;
  }

  /* ---------- Define data in Python ---------- */
  const STARTER = '# Define a variable named `data`: a dict of equal-length lists, one per column.\n# NumPy arrays and pandas DataFrames work too.\ndata = {\n    "x": [1, 2, 3, 4],\n    "y": [2.1, 3.9, 6.2, 7.8],\n}\n';
  function pythonDialog(ctx) {
    const o = originOf(ctx.record), plotType = ctx.record.config.plotType;
    const ta = h('textarea', { class: 'input input--area code ds__code', rows: 12, spellcheck: false, 'aria-label': 'Python data script' });
    ta.value = (o.type === 'python' && o.code) || STARTER;
    const out = h('div', { class: 'ds__out', role: 'status' });
    const help = h('p', { class: 'fe__hint' }, 'Runs in a data-only Python run (5 s limit, no figure). A plain data = {…} assignment is copied into the spreadsheet; anything else stays Python-controlled and the spreadsheet shows a snapshot. This is not a sandbox: only run code you trust.');
    let result = null, dlg, busy = false;
    const setOut = (kind, ...kids) => { out.textContent = ''; out.className = 'ds__out' + (kind ? ' is-' + kind : ''); out.append(...kids); };
    ta.addEventListener('input', () => { result = null; dlg.buttons.use.disabled = true; setOut(''); });
    async function run() {
      if (busy) return; busy = true; dlg.buttons.run.disabled = true; setOut('', 'Running…');
      const res = await RPE.backend.request('figures.python.data', { source: ta.value });
      busy = false; dlg.buttons.run.disabled = false;
      if (!res || !res.ok) return setOut('error', (res && res.message) || 'The script could not be run.');
      const d = res.data;
      if (!d.ok) {
        const line = d.traceback && d.traceback.line ? ` (line ${d.traceback.line})` : '';
        return setOut('error', h('div', {}, (d.message || 'The script failed.') + line), d.stderr ? h('pre', { class: 'ds__pre' }, d.stderr.slice(-1200)) : null);
      }
      result = d; dlg.buttons.use.disabled = false;
      const show = d.rows.slice(0, 5).map((r) => '<tr>' + r.map((v) => `<td>${v === null ? '—' : U.esc(String(v))}</td>`).join('') + '</tr>').join('');
      setOut('ok', h('div', {}, `${d.rows.length} rows, ${d.columns.length} columns: ${d.columns.map((c) => c.name).join(', ')}. ` + (d.literal ? 'It will be copied into the spreadsheet.' : 'It will stay Python-controlled.')),
        h('div', { class: 'ds__preview', html: `<table><thead><tr>${d.columns.map((c) => `<th><span class="ds__tag">${tag(c)}</span> ${U.esc(c.name)}</th>`).join('')}</tr></thead><tbody>${show}</tbody></table>` }),
        d.stdout ? h('pre', { class: 'ds__pre' }, d.stdout.slice(-600)) : null);
    }
    function use() {
      const d = result; if (!d) return false;
      const keep = ctx.record.config.mapping, names = new Set(d.columns.map((c) => c.name));
      const same = originOf(ctx.record).type === 'python' && [keep.x, keep.group, keep.yErr].concat(keep.y).filter(Boolean).every((n) => names.has(n)) && keep.y.length;
      const origin = d.literal ? { type: 'sheet', label: 'From Python literal', sampleId: null, fileName: null } : { type: 'python', label: 'Python script', sampleId: null, fileName: null, code: ta.value };
      applyData(ctx, { columns: d.columns, rows: d.rows, origin, mapping: same ? keep : guess(plotType, d.columns) });
    }
    dlg = U.dialog({ title: 'Define data in Python', icon: 'code', width: 680, body: h('div', { class: 'ds' }, help, ta, out),
      buttons: [{ label: 'Cancel', value: false }, { id: 'run', label: 'Run', onClick: () => { run(); return false; } }, { id: 'use', label: 'Use data', kind: 'primary', value: true, onClick: use }] });
    dlg.buttons.use.disabled = true;
    return dlg;
  }
})(window.RPE);
