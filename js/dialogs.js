/* dialogs.js — dialogs for the scientific workflows and the smaller utilities. The plot dialog delegates to RPE.figures.openEditor
   (js/figures/editor.js), the PGFPlots dialog to js/figures/latex.js and the multi-panel dialog to js/figures/composer.js; all of them
   render through the backend. */
(function (RPE) {
  'use strict';
  const S = RPE.store, ui = S.ui, U = RPE.ui, h = RPE.h, P = RPE.plots, T = RPE.themes, ic = RPE.icons.html;

  /* ---------- tiny form helpers ---------- */
  const field = (label, ctl, cls) => h('label', { class: 'field ' + (cls || '') }, h('span', { class: 'field__label' }, label), ctl);
  const text = (v, on, attrs) => { const i = h('input', Object.assign({ class: 'input', type: 'text', value: v || '' }, attrs || {})); i.addEventListener('input', () => on(i.value)); return i; };
  const numIn = (v, on, attrs) => { const i = h('input', Object.assign({ class: 'input', type: 'number', value: v }, attrs || {})); i.addEventListener('input', () => on(parseFloat(i.value))); return i; };
  function select(opts, val, on) { const s = h('select', { class: 'select' }, opts.map((o) => h('option', { value: o.value, selected: String(o.value) === String(val), disabled: o.disabled }, o.label))); s.addEventListener('change', () => on(s.value)); return s; }
  function check(label, val, on) { const i = h('input', { type: 'checkbox', checked: !!val }); i.addEventListener('change', () => on(i.checked)); return h('label', { class: 'check' }, i, h('span', null, label)); }
  const tabs = (items, on) => {
    const bar = h('div', { class: 'dtabs', role: 'tablist' });
    items.forEach((t, i) => { const b = h('button', { type: 'button', role: 'tab', class: 'dtab' + (i === 0 ? ' is-active' : ''), dataset: { id: t.id } }, t.label); b.addEventListener('click', () => select_(t.id)); bar.appendChild(b); });
    function select_(id) { [].forEach.call(bar.children, (b) => { const a = b.dataset.id === id; b.classList.toggle('is-active', a); b.setAttribute('aria-selected', String(a)); }); on(id); }
    bar.select = select_; return bar;
  };
  function afterInsertPlot(o) { RPE.commands.addObject(o, o.type === 'figure' ? 'figure' : 'plot'); S.setUI({ activeTab: 'plotTools' }); }

  /* ================= Plot (figure editor) ================= */
  /* Delegates to RPE.figures.openEditor. Insert/Apply render the CURRENT record at final size and DPI first; when that fails
     nothing is inserted or changed and the reason is shown in the editor (contract s8). */
  function plot(o) {
    o = o || {};
    const F = RPE.figures, obj = o.mode === 'edit' ? o.obj : null, kind0 = o.kind || (obj && obj.kind) || 'line';
    const type = P.KINDS[kind0] ? kind0 : 'line';
    let record;
    if (obj) record = obj.figureId && F.get(obj.figureId) ? F.get(obj.figureId) : F.blank('structured', type, { name: obj.name || obj.title || undefined });
    return F.openEditor({
      mode: obj ? 'edit' : 'insert', record, plotType: type, tab: o.tab === 'source' ? 'python' : o.tab === 'export' ? 'export' : undefined,
      onSave: (draft, ctx) => F.exportpanel.save(draft, ctx, obj)   // final render first; one undo step; nothing changes on failure
    });
  }

  /* ================= PGFPlots ================= */
  /* PGFPlots / LaTeX figures: the window lives in js/figures/latex.js (compiled through /api/figures/latex). */
  function pgf(o) { return RPE.figures.latex.open(o); }

  /* ================= multi-panel figure ================= */
  /* Delegates to RPE.figures.composer: the composite is rendered by the backend and panels are clickable on the preview (contract s4t). */
  function figure(o) {
    o = o || {};
    return RPE.figures.composer.open({ mode: o.mode === 'edit' ? 'edit' : 'insert', obj: o.obj });
  }

  /* ================= find & replace ================= */
  function getParagraphElements(root) {
    const blocks = root.querySelectorAll('p, li');
    if (blocks.length > 0) return Array.from(blocks);
    const divs = root.querySelectorAll('div');
    if (divs.length > 0) return Array.from(divs);
    return [root];
  }

  function replaceInParagraph(pEl, start, end, replacement) {
    const walker = document.createTreeWalker(pEl, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    let offset = 0;
    let isFirst = true;
    for (const tn of textNodes) {
      const val = tn.nodeValue;
      const len = val.length;
      const nodeStart = offset;
      const nodeEnd = offset + len;
      offset += len;

      if (nodeEnd > start && nodeStart < end) {
        const overlapStart = Math.max(0, start - nodeStart);
        const overlapEnd = Math.min(len, end - nodeStart);
        const before = val.slice(0, overlapStart);
        const after = val.slice(overlapEnd);
        if (isFirst) {
          tn.nodeValue = before + replacement + after;
          isFirst = false;
        } else {
          tn.nodeValue = before + after;
        }
      }
    }
  }

  function findMatches(query, matchCase) {
    if (!query) return [];
    const flags = matchCase ? 'g' : 'gi';
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const out = [];

    (S.doc.slides || []).forEach((s) => {
      (s.objects || []).forEach((o) => {
        if (o.type === 'table') {
          const rows = o.cells || [];
          rows.forEach((row, r) => {
            (row || []).forEach((cellStr, c) => {
              const text = String(cellStr || '');
              const re = new RegExp(escaped, flags);
              let m;
              while ((m = re.exec(text)) !== null) {
                out.push({
                  slideId: s.id,
                  objectId: o.id,
                  kind: 'cell',
                  index: [r, c],
                  paragraphIndex: null,
                  cellIndex: [r, c],
                  rowIndex: r,
                  colIndex: c,
                  row: r,
                  col: c,
                  start: m.index,
                  end: m.index + m[0].length
                });
                if (m.index === re.lastIndex) re.lastIndex++;
              }
            });
          });
        } else if (o.type === 'text' || o.type === 'shape' || o.html != null) {
          const d = document.createElement('div');
          d.innerHTML = o.html || '';
          const paras = getParagraphElements(d);
          paras.forEach((p, pIdx) => {
            const text = p.textContent || '';
            const re = new RegExp(escaped, flags);
            let m;
            while ((m = re.exec(text)) !== null) {
              out.push({
                slideId: s.id,
                objectId: o.id,
                kind: 'html',
                index: pIdx,
                paragraphIndex: pIdx,
                cellIndex: null,
                rowIndex: null,
                colIndex: null,
                start: m.index,
                end: m.index + m[0].length
              });
              if (m.index === re.lastIndex) re.lastIndex++;
            }
          });
        }
      });
    });

    return out;
  }

  function replaceRecord(rec, replacement) {
    if (RPE.canvas && RPE.canvas.stopEdit) RPE.canvas.stopEdit();
    const slide = S.slide(rec.slideId);
    const obj = slide ? (slide.objects || []).find((o) => o.id === rec.objectId) : null;
    if (!obj) return false;

    if (rec.kind === 'cell') {
      if (!obj.cells || !obj.cells[rec.rowIndex]) return false;
      const str = String(obj.cells[rec.rowIndex][rec.colIndex] || '');
      obj.cells[rec.rowIndex][rec.colIndex] = str.slice(0, rec.start) + replacement + str.slice(rec.end);
      if (RPE.commands && RPE.commands.syncTableRows) RPE.commands.syncTableRows(obj);
    } else {
      const d = document.createElement('div');
      d.innerHTML = obj.html || '';
      const paras = getParagraphElements(d);
      const p = paras[rec.paragraphIndex != null ? rec.paragraphIndex : (rec.index || 0)] || d;
      replaceInParagraph(p, rec.start, rec.end, replacement);
      obj.html = d.innerHTML;
    }
    return true;
  }

  function replaceOneRecord(rec, replacement) {
    const slide = S.slide(rec.slideId);
    const obj = slide ? (slide.objects || []).find((o) => o.id === rec.objectId) : null;
    if (!obj) return false;
    S.mutate('Replace', () => {
      replaceRecord(rec, replacement);
    }, { hint: { objects: [obj.id] } });
    return true;
  }

  function replaceAllMatches(query, replacement, matchCase) {
    if (!query) return 0;
    if (RPE.canvas && RPE.canvas.stopEdit) RPE.canvas.stopEdit();
    const allMatches = findMatches(query, matchCase);
    if (!allMatches.length) return 0;

    S.mutate('Replace all', () => {
      const objMap = new Map();
      allMatches.forEach((m) => {
        const key = `${m.slideId}:${m.objectId}`;
        if (!objMap.has(key)) objMap.set(key, { slideId: m.slideId, objectId: m.objectId, matches: [] });
        objMap.get(key).matches.push(m);
      });

      objMap.forEach(({ slideId, objectId, matches }) => {
        const slide = S.slide(slideId);
        const obj = slide ? (slide.objects || []).find((o) => o.id === objectId) : null;
        if (!obj) return;

        if (obj.type === 'table') {
          const cellMap = new Map();
          matches.forEach((m) => {
            const k = `${m.rowIndex}:${m.colIndex}`;
            if (!cellMap.has(k)) cellMap.set(k, []);
            cellMap.get(k).push(m);
          });
          cellMap.forEach((cMatches) => {
            cMatches.sort((a, b) => b.start - a.start);
            const r = cMatches[0].rowIndex, c = cMatches[0].colIndex;
            if (obj.cells && obj.cells[r]) {
              let str = String(obj.cells[r][c] || '');
              cMatches.forEach((m) => {
                str = str.slice(0, m.start) + replacement + str.slice(m.end);
              });
              obj.cells[r][c] = str;
            }
          });
          if (RPE.commands && RPE.commands.syncTableRows) RPE.commands.syncTableRows(obj);
        } else {
          const d = document.createElement('div');
          d.innerHTML = obj.html || '';
          const paras = getParagraphElements(d);
          const paraMap = new Map();
          matches.forEach((m) => {
            const pIdx = m.paragraphIndex != null ? m.paragraphIndex : (m.index || 0);
            if (!paraMap.has(pIdx)) paraMap.set(pIdx, []);
            paraMap.get(pIdx).push(m);
          });
          paraMap.forEach((pMatches, pIdx) => {
            pMatches.sort((a, b) => b.start - a.start);
            const p = paras[pIdx] || d;
            pMatches.forEach((m) => {
              replaceInParagraph(p, m.start, m.end, replacement);
            });
          });
          obj.html = d.innerHTML;
        }
      });
    });

    return allMatches.length;
  }

  function find(replaceMode) {
    let pos = -1;
    const isCase = () => !!mc.querySelector('input').checked;
    const q = text('', () => count()), r = text('', () => { }), mc = check('Match case', false, () => count());
    const info = h('div', { class: 'pd__status', role: 'status' }, 'Type to search all slides.');

    function count() {
      const v = q.value;
      if (!v) { info.textContent = 'Type to search all slides.'; pos = -1; return; }
      const hs = findMatches(v, isCase());
      const slides = new Set(hs.map((x) => x.slideId)).size;
      info.textContent = hs.length ? `${hs.length} occurrence${hs.length > 1 ? 's' : ''} on ${slides} slide${slides > 1 ? 's' : ''} match.` : 'No matches.';
      pos = -1;
    }

    function next() {
      const hs = findMatches(q.value, isCase());
      if (!hs.length) { count(); return null; }
      pos = (pos + 1) % hs.length;
      const x = hs[pos];
      if (ui.view !== 'normal') S.setUI({ view: 'normal' });
      if (ui.activeSlideId !== x.slideId) S.setActiveSlide(x.slideId);
      S.select([x.objectId]);
      info.textContent = `Match ${pos + 1} of ${hs.length}.`;
      return x;
    }

    function replaceOne() {
      const v = q.value; if (!v) return;
      let hs = findMatches(v, isCase());
      if (!hs.length) { count(); return; }
      if (pos < 0 || pos >= hs.length) {
        if (!next()) return;
        hs = findMatches(v, isCase());
      }
      const target = hs[pos];
      if (!target) return;
      replaceOneRecord(target, r.value);
      const newHs = findMatches(v, isCase());
      if (!newHs.length) { pos = -1; count(); return; }
      pos = pos % newHs.length;
      const x = newHs[pos];
      if (ui.view !== 'normal') S.setUI({ view: 'normal' });
      if (ui.activeSlideId !== x.slideId) S.setActiveSlide(x.slideId);
      S.select([x.objectId]);
      info.textContent = `Match ${pos + 1} of ${newHs.length}.`;
    }

    function replaceAll() {
      const v = q.value; if (!v) return;
      const n = replaceAllMatches(v, r.value, isCase());
      info.textContent = n ? `Replaced ${n} occurrence${n > 1 ? 's' : ''}.` : 'No matches.';
      pos = -1;
    }

    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });
    const rf = field('Replace with', r); rf.hidden = !replaceMode;
    const tg = check('Replace', replaceMode, (v) => { rf.hidden = !v; rb.hidden = ra.hidden = !v; });
    const rb = h('button', { type: 'button', class: 'btn btn--ghost', onclick: replaceOne }, 'Replace'), ra = h('button', { type: 'button', class: 'btn btn--ghost', onclick: replaceAll }, 'Replace all'); rb.hidden = ra.hidden = !replaceMode;
    const dlg = U.dialog({ title: 'Find and replace', icon: 'search', width: 440, class: 'dlg--find', focus: 'input', body: h('div', { class: 'stack' }, field('Find', q), rf, h('div', { class: 'pd__checks' }, mc, tg), info) });
    dlg.foot.hidden = false; dlg.foot.append(rb, ra, h('button', { type: 'button', class: 'btn btn--primary', onclick: next }, 'Find next'), h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => dlg.close() }, 'Close'));
    return dlg;
  }

  /* ================= small dialogs ================= */
  function link() {
    const ed = RPE.canvas.editable(); let sel = ''; if (ed && window.getSelection) sel = String(getSelection());
    const url = text('https://', () => { }), label = text(sel, () => { });
    U.dialog({ title: 'Insert link', icon: 'link', width: 440, focus: 'input', body: h('div', { class: 'stack' }, field('Text to display', label), field('Address', url)), buttons: [{ label: 'Cancel', value: false }, { label: 'Insert link', kind: 'primary', onClick: () => {
      const u = url.value.trim(); if (!/^(https?:|mailto:)/i.test(u)) { url.focus(); U.toast('Enter an address starting with http://, https:// or mailto:', { kind: 'warn' }); return false; }
      if (ed) { RPE.canvas.focusEdit(); document.execCommand('insertHTML', false, `<a href="${U.esc(u)}">${U.esc(label.value || u)}</a>`); return; }
      const pos = { x: 120, y: 300 }; RPE.commands.addObject({ id: S.uid('o'), type: 'text', role: 'text', x: pos.x, y: pos.y, w: 520, h: 56, fontSize: 22, align: 'left', lineHeight: 1.2, vAlign: 'top', html: `<p><a href="${U.esc(u)}">${U.esc(label.value || u)}</a></p>` }, 'link');
    } }] });
  }
  function altText() {
    const o = S.selectedObjects()[0]; if (!o) return; const ta = h('textarea', { class: 'input input--area', rows: 4, 'aria-label': 'Alternative text' }); ta.value = o.alt || '';
    U.dialog({ title: 'Alternative text', icon: 'accessibility', width: 460, focus: 'textarea', body: h('div', { class: 'stack' }, h('p', { class: 'dlg__text' }, 'Describe this object for people using screen readers.'), ta), buttons: [{ label: 'Cancel', value: false }, { label: 'Save', kind: 'primary', onClick: () => { S.mutate('Alt text', () => { o.alt = ta.value.trim(); }, { hint: { objects: [o.id] } }); } }] });
  }
  function tableSize() {
    const r = numIn(3, () => { }, { min: 1, max: 12 }), c = numIn(4, () => { }, { min: 1, max: 8 });
    U.dialog({ title: 'Insert table', icon: 'table', width: 340, focus: 'input', body: h('div', { class: 'pd__row' }, field('Rows', r), field('Columns', c)), buttons: [{ label: 'Cancel', value: false }, { label: 'Insert', kind: 'primary', onClick: () => RPE.commands.run('insert.table', { rows: r.value, cols: c.value }, 'dialog') }] });
  }
  function pageSetup() {
    const d = S.doc.size; let w = d.w / 96, hh = d.h / 96;
    const wi = numIn(+w.toFixed(2), (v) => { w = v; }, { min: 5, max: 31, step: 0.01 }), hi = numIn(+hh.toFixed(2), (v) => { hh = v; }, { min: 4, max: 31, step: 0.01 });
    const pre = select([{ value: '', label: 'Custom' }].concat(T.SIZES.map((s) => ({ value: s.id, label: s.name }))), '', (v) => { const s = T.SIZES.find((x) => x.id === v); if (s) { w = s.w / 96; hh = s.h / 96; wi.value = w.toFixed(2); hi.value = hh.toFixed(2); } });
    U.dialog({ title: 'Page setup', icon: 'settings-2', width: 400, focus: 'select', body: h('div', { class: 'stack' }, field('Slides sized for', pre), h('div', { class: 'pd__row' }, field('Width (in)', wi), field('Height (in)', hi)), h('p', { class: 'dlg__text dlg__text--muted' }, 'Existing objects are rescaled proportionally. Orientation follows width and height.')), buttons: [{ label: 'Cancel', value: false }, { label: 'OK', kind: 'primary', onClick: () => RPE.commands.run('design.setSize', { w: w * 96, h: hh * 96 }, 'dialog') }] });
  }
  function zoom() {
    const presets = ui.view === 'sorter' ? [10, 16, 20, 30, 40] : [50, 75, 100, 150, 200, 300];
    const cur = ui.view === 'sorter' ? ui.sorterZoom : ui.zoom; let chosen = ui.zoomMode === 'fit' && ui.view === 'normal' ? 'fit' : cur;
    const custom = numIn(cur, (v) => { chosen = v; [].forEach.call(group.querySelectorAll('input[type=radio]'), (r) => { r.checked = false; }); }, { min: 10, max: ui.view === 'sorter' ? 50 : 400 });
    const group = h('div', { class: 'radios', role: 'radiogroup', 'aria-label': 'Zoom' }, presets.map((p) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'z', checked: chosen === p, onchange: () => { chosen = p; custom.value = p; } }), h('span', null, p + '%'))).concat(ui.view === 'normal' ? [h('label', { class: 'check' }, h('input', { type: 'radio', name: 'z', checked: chosen === 'fit', onchange: () => { chosen = 'fit'; } }), h('span', null, 'Fit slide to window'))] : []));
    U.dialog({ title: 'Zoom', icon: 'zoom-in', width: 340, focus: 'input', body: h('div', { class: 'stack' }, group, field('Percent', custom)), buttons: [{ label: 'Cancel', value: false }, { label: 'OK', kind: 'primary', onClick: () => { if (chosen === 'fit') RPE.commands.run('view.fit', {}, 'dialog'); else RPE.commands.run('view.zoom', { value: chosen }, 'dialog'); } }] });
  }
  const KEYS = {
    editor: [['Undo / Redo', 'Ctrl+Z / Ctrl+Y'], ['Save', 'Ctrl+S'], ['New slide', 'Ctrl+M'], ['Duplicate object / slide', 'Ctrl+D'], ['Copy / Cut / Paste', 'Ctrl+C / X / V'], ['Bold / Italic / Underline', 'Ctrl+B / I / U'], ['Subscript / Superscript', 'Ctrl+= / Ctrl+Shift+='], ['Group / Ungroup', 'Ctrl+G / Ctrl+Shift+G'], ['Find / Replace', 'Ctrl+F / Ctrl+H'], ['Search commands', 'Ctrl+K or Alt+Q'], ['Edit text in selected object', 'Enter or F2'], ['Nudge selection', 'Arrow keys (Shift = 10×)'], ['Delete selection', 'Delete'], ['Deselect / stop editing', 'Esc'], ['Zoom', 'Ctrl + mouse wheel'], ['Slide show', 'F5 / Shift+F5'], ['Figure windows: run script / compile', 'Ctrl+Enter'], ['Figure windows: save source or figure', 'Ctrl+S'], ['Figure windows: next / previous pane', 'F6 / Shift+F6']],
    present: [['Next slide', 'Right, Down, Space, PageDown'], ['Previous slide', 'Left, Up, PageUp'], ['First / last slide', 'Home / End'], ['Toggle presenter view', 'P'], ['Toggle laser pointer', 'L'], ['End show', 'Esc']]
  };
  function shortcuts(which) {
    const rows = (KEYS[which] || KEYS.editor).map((r) => h('tr', null, h('td', null, r[0]), h('td', null, h('kbd', null, r[1]))));
    U.dialog({ title: which === 'present' ? 'Present mode shortcuts' : 'Keyboard shortcuts', icon: 'keyboard', width: 520, dismiss: 'backdrop', body: h('table', { class: 'ktable' }, h('tbody', null, rows)), buttons: [{ label: 'Close', kind: 'primary' }] });
  }
  function about() {
    U.dialog({ title: 'About', icon: 'info', width: 460, dismiss: 'backdrop', body: h('div', { class: 'stack' }, h('p', { class: 'dlg__text' }, 'Laurevine Rose - version 1.0.0.'), h('p', { class: 'dlg__text dlg__text--muted' }, 'Pure HTML, CSS and JavaScript. Figures, LaTeX/PGFPlots compilation and PPTX/PDF export run in the local Python service (python3 run.py); without it those commands tell you how to start it.'), h('p', { class: 'dlg__text dlg__text--muted' }, 'Icons: Lucide (ISC). Typeface: Spline Sans (SIL Open Font License).')), buttons: [{ label: 'Close', kind: 'primary' }] });
  }

  /* ================= comments popover ================= */
  function comments(anchor) {
    if (U.isOpenFor(anchor)) { U.closeAll(); return; }
    const wrap = h('div', { class: 'cm' }); const ta = h('textarea', { class: 'input input--area', rows: 2, placeholder: 'Add a comment to this slide…', 'aria-label': 'New comment' });
    const rel = (ts) => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
    function draw() {
      wrap.replaceChildren(); const open = S.doc.comments.filter((c) => !c.resolved).length;
      wrap.appendChild(h('div', { class: 'cm__head' }, h('strong', null, 'Comments'), h('span', { class: 'chip' }, open + ' open'), h('span', { class: 'sp' }), h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close comments', html: ic('x'), onclick: () => U.closeAll() })));
      const list = h('div', { class: 'cm__list' });
      if (!S.doc.comments.length) list.appendChild(h('p', { class: 'cm__empty' }, 'No comments yet.'));
      S.doc.comments.forEach((c) => {
        const idx = S.doc.slides.findIndex((s) => s.id === c.slideId);
        list.appendChild(h('div', { class: 'cm__item' + (c.resolved ? ' is-resolved' : '') },
          h('span', { class: 'avatar', 'aria-hidden': 'true' }, c.author.split(' ').map((w) => w[0]).join('').slice(0, 2)),
          h('div', { class: 'cm__body' }, h('div', { class: 'cm__meta' }, h('b', null, c.author), h('button', { type: 'button', class: 'chip chip--btn', onclick: () => { S.setUI({ view: 'normal' }); S.setActiveSlide(c.slideId); } }, 'Slide ' + (idx + 1)), h('span', null, rel(c.ts))), h('p', null, c.text)),
          h('div', { class: 'cm__act' }, h('button', { type: 'button', class: 'iconbtn', 'aria-label': c.resolved ? 'Reopen comment' : 'Resolve comment', 'data-tip': c.resolved ? 'Reopen' : 'Resolve', html: ic(c.resolved ? 'rotate-ccw' : 'check'), onclick: () => { S.mutate('Resolve comment', () => { c.resolved = !c.resolved; }, { hint: { meta: true } }); draw(); } }),
            h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Delete comment', 'data-tip': 'Delete', html: ic('trash-2'), onclick: () => { S.mutate('Delete comment', (d) => { d.comments = d.comments.filter((x) => x.id !== c.id); }, { hint: { meta: true } }); draw(); } }))));
      });
      const post = h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => { const t = ta.value.trim(); if (!t) { ta.focus(); return; } S.mutate('Add comment', (d) => { d.comments.push({ id: S.uid('c'), slideId: ui.activeSlideId, author: 'You', text: t, ts: Date.now(), resolved: false }); }, { hint: { meta: true } }); ta.value = ''; draw(); } }, 'Post');
      wrap.append(list, h('div', { class: 'cm__new' }, h('div', { class: 'cm__for' }, 'On slide ' + (S.activeIndex() + 1)), ta, h('div', { class: 'cm__post' }, post)));
      RPE.icons.render(wrap);
    }
    draw();
    U.popover(anchor, wrap, { placement: 'top-start', class: 'popover--comments', role: 'dialog' });
  }


  /* ================= Picture Adjust Panel ================= */
  /* Non-destructive image adjustment dialog.
     Parameters are stored in o.imgAdj and previewed live via RPE.renderer.updateImageAdj.
     Reset clears imgAdj to the pre-open state. A single undo step covers the whole session. */
  function pictureAdjust() {
    const objs = S.selectedObjects().filter((o) => o.type === 'image');
    if (!objs.length) return;
    const o = objs[0];
    const snapAdj = JSON.parse(JSON.stringify(o.imgAdj || {}));
    let snappedDoc = null;

    const adj = Object.assign({ brightness: 0, contrast: 0, saturation: 0, grayscale: 0, tintColor: '#000000', tintAmount: 0 }, o.imgAdj || {});

    function liveUpdate() {
      if (!snappedDoc) { snappedDoc = JSON.stringify(S.doc); }
      S.doc.slides.forEach((s) => {
        s.objects.forEach((obj) => { if (obj.id === o.id) obj.imgAdj = Object.assign({}, adj); });
      });
      const cx = RPE.renderer.context(S.doc);
      const el = document.querySelector('#slideFrame [data-id="' + o.id + '"]');
      if (el) RPE.renderer.updateImageAdj(el, o, cx);
      RPE.bus.emit('doc', { label: 'Image adjust', hint: { adjustLive: true } });
    }

    function updateFill(inp) {
      const min = parseFloat(inp.min), max = parseFloat(inp.max), val = parseFloat(inp.value);
      const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
      inp.style.setProperty('--fill', pct + '%');
    }

    const rangeControls = {};

    function makeRange(label, key, min, max, step) {
      const val = adj[key] != null ? adj[key] : 0;
      const isNeg = (min < 0);
      const fmt = isNeg
        ? (v) => (v >= 0 ? '+' : '') + Math.round(v)
        : (v) => Math.round(v) + '%';
      const disp = h('span', { style: 'min-width:3.5em;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:var(--text);flex:none;' }, fmt(val));
      const inp = h('input', { type: 'range', class: 'adj__range', min, max, step: step || 1, value: val, 'aria-label': label, style: 'flex:1;' });
      updateFill(inp);
      inp.addEventListener('input', () => {
        adj[key] = parseFloat(inp.value);
        disp.textContent = fmt(adj[key]);
        updateFill(inp);
        liveUpdate();
      });
      rangeControls[key] = { inp, disp, fmt, def: snapAdj[key] != null ? snapAdj[key] : 0 };
      return h('label', { style: 'display:flex;align-items:center;gap:8px;cursor:default;' },
        h('span', { style: 'width:86px;font-size:12px;color:var(--text);flex:none;' }, label),
        inp, disp);
    }

    const colorPick = h('input', { type: 'color', value: adj.tintColor || '#000000', 'aria-label': 'Tint color', style: 'width:26px;height:26px;padding:0;border:1.5px solid var(--border-2);border-radius:var(--r);cursor:pointer;flex:none;background:#fff;' });
    colorPick.addEventListener('input', () => { adj.tintColor = colorPick.value; liveUpdate(); });

    const amtVal = Math.round((adj.tintAmount || 0) * 100);
    const amtDisp = h('span', { style: 'min-width:3.5em;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:var(--text);flex:none;' }, amtVal + '%');
    const amtInp = h('input', { type: 'range', class: 'adj__range', min: 0, max: 100, step: 1, value: amtVal, 'aria-label': 'Tint amount', style: 'flex:1;' });
    updateFill(amtInp);
    amtInp.addEventListener('input', () => {
      adj.tintAmount = parseFloat(amtInp.value) / 100;
      amtDisp.textContent = amtInp.value + '%';
      updateFill(amtInp);
      liveUpdate();
    });

    /* Quick-pick palette swatches for tint color */
    const paletteColors = (() => { try { const pal = RPE.themes && RPE.themes.palette(S.doc); return pal ? (pal.colors || []).slice(0, 6) : []; } catch (e) { return []; } })();
    const swatchColors = [...new Set([...paletteColors, '#000000', '#FFFFFF', '#C00000', '#1D5FA7', '#2D5A3A'])].slice(0, 10);
    const swatches = h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;', 'aria-label': 'Palette colors' },
      swatchColors.map((c) => {
        const b = h('button', { type: 'button', title: c, style: 'width:18px;height:18px;border-radius:2px;border:1.5px solid var(--border-2);background:' + c + ';cursor:pointer;padding:0;flex:none;transition:transform 0.1s ease;' });
        b.addEventListener('mouseenter', () => { b.style.transform = 'scale(1.2)'; });
        b.addEventListener('mouseleave', () => { b.style.transform = 'none'; });
        b.addEventListener('click', () => {
          adj.tintColor = c;
          colorPick.value = c;
          if (adj.tintAmount <= 0) {
            adj.tintAmount = 0.3;
            amtInp.value = 30;
            amtDisp.textContent = '30%';
            updateFill(amtInp);
          }
          liveUpdate();
        });
        return b;
      })
    );

    const secHead = (t) => h('div', { style: 'font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-2);margin-bottom:2px;' }, t);

    const body = h('div', { class: 'stack', style: 'gap:14px;padding:2px 0;' },
      h('div', { class: 'stack', style: 'gap:6px;' },
        secHead('Tone'),
        makeRange('Brightness', 'brightness', -100, 100, 1),
        makeRange('Contrast', 'contrast', -100, 100, 1),
        makeRange('Saturation', 'saturation', -100, 100, 1),
        makeRange('Grayscale', 'grayscale', 0, 100, 1)
      ),
      h('div', { class: 'stack', style: 'gap:6px;' },
        secHead('Color Tint'),
        h('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;' },
          h('span', { style: 'width:86px;font-size:12px;color:var(--text);flex:none;' }, 'Color'),
          colorPick, swatches),
        h('label', { style: 'display:flex;align-items:center;gap:8px;cursor:default;' },
          h('span', { style: 'width:86px;font-size:12px;color:var(--text);flex:none;' }, 'Amount'),
          amtInp, amtDisp)
      )
    );

    U.dialog({
      title: 'Picture Adjustments',
      icon: 'sliders-horizontal',
      width: 380,
      body,
      buttons: [
        {
          label: 'Reset',
          onClick: () => {
            S.doc.slides.forEach((s) => {
              s.objects.forEach((obj) => {
                if (obj.id === o.id) {
                  if (Object.keys(snapAdj).length) obj.imgAdj = Object.assign({}, snapAdj);
                  else delete obj.imgAdj;
                }
              });
            });
            const cx = RPE.renderer.context(S.doc);
            const el = document.querySelector('#slideFrame [data-id="' + o.id + '"]');
            if (el) RPE.renderer.updateImageAdj(el, o, cx);
            Object.assign(adj, { brightness: 0, contrast: 0, saturation: 0, grayscale: 0, tintAmount: 0 }, snapAdj);

            // Reset UI controls
            Object.keys(rangeControls).forEach((k) => {
              const c = rangeControls[k];
              const v = snapAdj[k] != null ? snapAdj[k] : 0;
              c.inp.value = v;
              c.disp.textContent = c.fmt(v);
              updateFill(c.inp);
            });
            colorPick.value = snapAdj.tintColor || '#000000';
            const rAmt = Math.round((snapAdj.tintAmount || 0) * 100);
            amtInp.value = rAmt;
            amtDisp.textContent = rAmt + '%';
            updateFill(amtInp);

            RPE.bus.emit('doc', { label: 'Reset adjustments', hint: { objects: [o.id] } });
            return false; /* keep dialog open */
          },
          value: false
        },
        {
          label: 'Done',
          kind: 'primary',
          onClick: () => {
            S.mutate('Image adjust', (d) => {
              d.slides.forEach((s) => s.objects.forEach((obj) => { if (obj.id === o.id) obj.imgAdj = Object.assign({}, adj); }));
            });
          }
        }
      ]
    });
  }

  /* ================= Find & Replace Panel (F2) ================= */
  let findPanelEl = null, findInputEl = null, replaceInputEl = null, findCaseEl = null, findCountEl = null;
  let findMatchesList = [];
  let currentMatchIdx = -1;
  let isPanelOpen = false;
  let rafUpdateId = null;

  function createRangeForMatch(m) {
    const slideFrame = document.querySelector('#slideFrame');
    if (!slideFrame) return null;
    const objEl = slideFrame.querySelector(`.obj[data-id="${m.objectId}"]`);
    if (!objEl) return null;

    let targetRoot;
    if (m.kind === 'cell') {
      const r = m.rowIndex != null ? m.rowIndex : m.row;
      const c = m.colIndex != null ? m.colIndex : m.col;
      targetRoot = objEl.querySelector(`td[data-r="${r}"][data-c="${c}"], th[data-r="${r}"][data-c="${c}"]`);
      if (!targetRoot) return null;
    } else {
      const textEl = objEl.querySelector('.obj__text');
      if (!textEl) return null;
      const paras = getParagraphElements(textEl);
      const pIdx = m.paragraphIndex != null ? m.paragraphIndex : (m.index || 0);
      targetRoot = paras[pIdx] || textEl;
    }

    const walker = document.createTreeWalker(targetRoot, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);
    if (!textNodes.length) return null;

    let offset = 0;
    let startNode = null, startOffset = 0;
    let endNode = null, endOffset = 0;

    for (let i = 0; i < textNodes.length; i++) {
      const tn = textNodes[i];
      const len = tn.nodeValue.length;
      const nodeStart = offset;
      const nodeEnd = offset + len;

      if (!startNode && (m.start < nodeEnd || i === textNodes.length - 1)) {
        if (m.start >= nodeStart) {
          startNode = tn;
          startOffset = m.start - nodeStart;
        }
      }
      if (!endNode || m.end > nodeStart) {
        if (m.end >= nodeStart && (m.end <= nodeEnd || i === textNodes.length - 1)) {
          endNode = tn;
          endOffset = Math.min(len, m.end - nodeStart);
        }
      }
      offset += len;
    }

    if (startNode && endNode) {
      try {
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        return range;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function scheduleHighlightUpdate() {
    if (rafUpdateId) cancelAnimationFrame(rafUpdateId);
    rafUpdateId = requestAnimationFrame(() => {
      rafUpdateId = null;
      renderHighlights();
    });
  }

  function clearHighlights() {
    const supportsHighlights = typeof CSS !== 'undefined' && typeof CSS.highlights !== 'undefined' && typeof Highlight !== 'undefined';
    if (supportsHighlights) {
      try {
        CSS.highlights.delete('find-all');
        CSS.highlights.delete('find-active');
      } catch (err) {}
    }
    const findLayer = document.getElementById('findHighlightLayer');
    if (findLayer) findLayer.replaceChildren();
  }

  function renderHighlights() {
    if (!isPanelOpen || !findMatchesList.length) {
      clearHighlights();
      return;
    }

    const activeSlideId = S.ui.activeSlideId;
    const visibleMatches = findMatchesList.filter((m) => m.slideId === activeSlideId);
    const activeMatch = currentMatchIdx >= 0 ? findMatchesList[currentMatchIdx] : null;

    const supportsHighlights = typeof CSS !== 'undefined' && typeof CSS.highlights !== 'undefined' && typeof Highlight !== 'undefined';
    const allRanges = [];
    const activeRanges = [];
    const rectList = [];

    const frameEl = document.getElementById('slideFrame');
    const fr = frameEl ? frameEl.getBoundingClientRect() : null;

    visibleMatches.forEach((m) => {
      const range = createRangeForMatch(m);
      if (!range) return;
      const isCur = (m === activeMatch);

      if (supportsHighlights) {
        allRanges.push(range);
        if (isCur) activeRanges.push(range);
      } else if (fr) {
        const clientRects = range.getClientRects();
        for (let i = 0; i < clientRects.length; i++) {
          rectList.push({ r: clientRects[i], isCur });
        }
      }
    });

    if (supportsHighlights) {
      try {
        if (allRanges.length) {
          CSS.highlights.set('find-all', new Highlight(...allRanges));
        } else {
          CSS.highlights.delete('find-all');
        }
        if (activeRanges.length) {
          CSS.highlights.set('find-active', new Highlight(...activeRanges));
        } else {
          CSS.highlights.delete('find-active');
        }
      } catch (e) {
        if (fr) {
          allRanges.forEach((range) => {
            const isCur = activeRanges.includes(range);
            const clientRects = range.getClientRects();
            for (let i = 0; i < clientRects.length; i++) {
              rectList.push({ r: clientRects[i], isCur });
            }
          });
        }
      }
    }

    const findLayer = document.getElementById('findHighlightLayer');
    if (findLayer) {
      findLayer.replaceChildren();
      if (!supportsHighlights && fr) {
        rectList.forEach(({ r, isCur }) => {
          const box = document.createElement('div');
          box.className = 'find-highlight' + (isCur ? ' find-highlight--active' : '');
          box.style.left = (r.left - fr.left) + 'px';
          box.style.top = (r.top - fr.top) + 'px';
          box.style.width = r.width + 'px';
          box.style.height = r.height + 'px';
          findLayer.appendChild(box);
        });
      }
    }
  }

  function updateCountUI() {
    if (!findCountEl) return;
    const total = findMatchesList.length;
    if (total === 0) {
      findCountEl.textContent = '0 of 0';
    } else {
      findCountEl.textContent = `${currentMatchIdx + 1} of ${total}`;
    }
  }

  function navigateToMatch(idx) {
    if (idx < 0 || idx >= findMatchesList.length) {
      currentMatchIdx = -1;
      updateCountUI();
      clearHighlights();
      return;
    }
    currentMatchIdx = idx;
    const m = findMatchesList[currentMatchIdx];

    if (S.ui.activeSlideId !== m.slideId) {
      S.setActiveSlide(m.slideId);
    }
    S.select([m.objectId]);

    updateCountUI();
    scheduleHighlightUpdate();
  }

  function onSearchChange() {
    if (!findInputEl) return;
    const q = findInputEl.value;
    if (!q) {
      findMatchesList = [];
      currentMatchIdx = -1;
      updateCountUI();
      clearHighlights();
      return;
    }
    const matchCase = findCaseEl ? findCaseEl.checked : false;
    findMatchesList = findMatches(q, matchCase);
    if (!findMatchesList.length) {
      currentMatchIdx = -1;
      updateCountUI();
      clearHighlights();
      return;
    }
    if (currentMatchIdx < 0 || currentMatchIdx >= findMatchesList.length) {
      const activeSlideId = S.ui.activeSlideId;
      const idxOnSlide = findMatchesList.findIndex((m) => m.slideId === activeSlideId);
      currentMatchIdx = idxOnSlide >= 0 ? idxOnSlide : 0;
    }
    navigateToMatch(currentMatchIdx);
  }

  function nextMatch() {
    if (!findMatchesList.length) return;
    const nextIdx = (currentMatchIdx + 1) % findMatchesList.length;
    navigateToMatch(nextIdx);
  }

  function prevMatch() {
    if (!findMatchesList.length) return;
    const prevIdx = (currentMatchIdx - 1 + findMatchesList.length) % findMatchesList.length;
    navigateToMatch(prevIdx);
  }

  function firstMatch() {
    if (!findMatchesList.length) return;
    navigateToMatch(0);
  }

  function lastMatch() {
    if (!findMatchesList.length) return;
    navigateToMatch(findMatchesList.length - 1);
  }

  function replaceActive() {
    if (!findInputEl) return;
    const q = findInputEl.value;
    if (!q || !findMatchesList.length || currentMatchIdx < 0 || currentMatchIdx >= findMatchesList.length) return;
    const repVal = replaceInputEl ? replaceInputEl.value : '';
    const target = findMatchesList[currentMatchIdx];
    replaceOneRecord(target, repVal);

    const matchCase = findCaseEl ? findCaseEl.checked : false;
    findMatchesList = findMatches(q, matchCase);
    if (!findMatchesList.length) {
      currentMatchIdx = -1;
      updateCountUI();
      clearHighlights();
      return;
    }
    currentMatchIdx = currentMatchIdx % findMatchesList.length;
    navigateToMatch(currentMatchIdx);
  }

  function replaceAll() {
    if (!findInputEl) return;
    const q = findInputEl.value;
    if (!q) return;
    const repVal = replaceInputEl ? replaceInputEl.value : '';
    const matchCase = findCaseEl ? findCaseEl.checked : false;
    replaceAllMatches(q, repVal, matchCase);

    findMatchesList = findMatches(q, matchCase);
    currentMatchIdx = findMatchesList.length > 0 ? 0 : -1;
    updateCountUI();
    if (findMatchesList.length > 0) {
      navigateToMatch(0);
    } else {
      clearHighlights();
    }
  }

  function openFindPanel(replaceMode) {
    if (!findPanelEl) initFindPanel();
    if (!findPanelEl) return;
    isPanelOpen = true;
    findPanelEl.hidden = false;

    if (RPE.icons && RPE.icons.render) {
      RPE.icons.render(findPanelEl);
    }

    if (findInputEl) {
      findInputEl.focus();
      findInputEl.select();
    }

    if (findInputEl && findInputEl.value) {
      onSearchChange();
    } else {
      clearHighlights();
      updateCountUI();
    }
  }

  function closeFindPanel() {
    if (!findPanelEl) return;
    isPanelOpen = false;
    findPanelEl.hidden = true;
    clearHighlights();
  }

  function initFindPanel() {
    findPanelEl = document.getElementById('findPanel');
    if (!findPanelEl) return;
    findInputEl = document.getElementById('findInput');
    replaceInputEl = document.getElementById('findReplaceInput');
    findCaseEl = document.getElementById('findCase');
    findCountEl = document.getElementById('findCount');

    findInputEl.addEventListener('input', onSearchChange);
    findInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.shiftKey ? prevMatch() : nextMatch();
      }
    });

    if (replaceInputEl) {
      replaceInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          replaceActive();
        }
      });
    }

    if (findCaseEl) {
      findCaseEl.addEventListener('change', onSearchChange);
    }

    const btnFirst = document.getElementById('findFirst');
    if (btnFirst) btnFirst.addEventListener('click', firstMatch);

    const btnPrev = document.getElementById('findPrev');
    if (btnPrev) btnPrev.addEventListener('click', prevMatch);

    const btnNext = document.getElementById('findNext');
    if (btnNext) btnNext.addEventListener('click', nextMatch);

    const btnLast = document.getElementById('findLast');
    if (btnLast) btnLast.addEventListener('click', lastMatch);

    const btnReplace = document.getElementById('findReplaceBtn');
    if (btnReplace) btnReplace.addEventListener('click', replaceActive);

    const btnReplaceAll = document.getElementById('findReplaceAllBtn');
    if (btnReplaceAll) btnReplaceAll.addEventListener('click', replaceAll);

    const btnClose = document.getElementById('findClose');
    if (btnClose) btnClose.addEventListener('click', closeFindPanel);

    findPanelEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeFindPanel();
      }
    });

    RPE.bus.on('doc', () => {
      if (isPanelOpen) {
        if (findInputEl && findInputEl.value) {
          const matchCase = findCaseEl ? findCaseEl.checked : false;
          findMatchesList = findMatches(findInputEl.value, matchCase);
          if (currentMatchIdx >= findMatchesList.length) {
            currentMatchIdx = findMatchesList.length - 1;
          }
          updateCountUI();
        }
        scheduleHighlightUpdate();
      }
    });

    RPE.bus.on('ui', (e) => {
      if (isPanelOpen && e.changed.some((k) => ['activeSlideId', 'zoom', 'view'].includes(k))) {
        scheduleHighlightUpdate();
      }
    });

    window.addEventListener('resize', () => {
      if (isPanelOpen) scheduleHighlightUpdate();
    });
  }

  const findPanelAPI = {
    init: initFindPanel,
    open: openFindPanel,
    close: closeFindPanel,
    isOpen: () => isPanelOpen,
    next: nextMatch,
    prev: prevMatch,
    first: firstMatch,
    last: lastMatch,
    replaceActive,
    replaceAll,
    recompute: onSearchChange,
    renderHighlights,
    clearHighlights,
    createRangeForMatch,
    getMatches: () => findMatchesList,
    getCurrentIndex: () => currentMatchIdx
  };
  RPE.findPanel = findPanelAPI;

  RPE.dialogs = { plot, pgf, figure, find, link, altText, tableSize, pageSetup, zoom, shortcuts, about, comments, field, text, numIn, select, check, findMatches, replaceRecord, replaceOneRecord, replaceAllMatches, getParagraphElements, replaceInParagraph, pictureAdjust };
})(window.RPE = window.RPE || {});
