/* checks.js — Review tab: Proofing, Accessibility and Research Checks.
   These run real heuristics over the document model (text overflow is measured in the DOM), so results
   reflect the actual slides. Figure checks read the figure records and the picture each slide shows. */
(function (RPE) {
  'use strict';
  const S = RPE.store, ui = S.ui, U = RPE.ui, h = RPE.h, R = RPE.renderer, ic = RPE.icons.html;
  const plain = (html) => { const d = document.createElement('div'); d.innerHTML = html || ''; return d.textContent.replace(/\s+/g, ' ').trim(); };
  const nameOf = (o) => ({ text: () => `“${plain(o.html).slice(0, 38)}${plain(o.html).length > 38 ? '…' : ''}”`, shape: () => 'Shape' + (plain(o.html) ? ` “${plain(o.html).slice(0, 24)}”` : ''), plot: () => 'Plot' + (o.name || o.title ? ': ' + (o.name || o.title) : o.kind ? ` (${o.kind})` : ''), figure: () => 'Multi-panel figure' + (o.name ? ': ' + o.name : ''), image: () => o.name || 'Image', table: () => 'Table' }[o.type] || (() => o.type))();
  const hasText = (o) => (o.type === 'text' || o.type === 'shape') && plain(o.html);

  /* ---------- check implementations ---------- */
  /* Geometry / contrast / reading-order logic lives in js/checks_core.js (DOM-free, unit-tested); only text measurement needs the DOM. */
  const core = () => RPE.checksCore;
  const coreCtx = () => { const cx = R.context(S.doc); return { col: cx.col, th: cx.th, nameOf, isLine: (o) => !!(RPE.shapes && RPE.shapes.isLine(o)), lineGeom: (o) => RPE.shapes.lineGeometry(o) }; };
  function overflow() { return core().overflowFindings(S.doc, (sl) => R.measureOverflow(S.doc, sl), coreCtx()); }
  function smalltext() {
    const out = [], MIN = 14;
    S.doc.slides.forEach((s, i) => s.objects.forEach((o) => {
      if ((hasText(o) || o.type === 'table') && (o.fontSize || 18) < MIN) out.push({ slide: i, id: s.id, obj: o.id, text: `${nameOf(o)} is ${o.fontSize || 18} pt — below the ${MIN} pt minimum for projected slides.` });
    }));
    return out;
  }
  function hasCaption(slide, o) {
    return slide.objects.some((c) => {
      if (c === o || c.type !== 'text' || !plain(c.html)) return false;
      if (!(c.role === 'caption' || /^(fig(ure)?\.?|table|tab\.)\s*\d*/i.test(plain(c.html)))) return false;
      const ov = Math.min(o.x + o.w, c.x + c.w) - Math.max(o.x, c.x); if (ov < Math.min(o.w, c.w) * 0.4) return false;
      const below = c.y - (o.y + o.h), above = o.y - (c.y + c.h);
      return (below > -24 && below < 140) || (above > -24 && above < 90);
    });
  }
  function captions() {
    const out = [];
    S.doc.slides.forEach((s, i) => s.objects.forEach((o) => {
      if (!['image', 'table'].includes(o.type) || o.caption) return;
      if (o.type === 'image' && !o.src && /placeholder/i.test(o.name || '') && !/schematic/i.test(o.name || '')) return;
      if (!hasCaption(s, o)) out.push({ slide: i, id: s.id, obj: o.id, text: `${nameOf(o)} has no caption.`, fix: 'caption' });
    }));
    return out;
  }
  /* ---------- figures (plot / figure objects: backend-rendered pictures backed by records in doc.figures) ---------- */
  const PX_PER_IN = 96, MIN_PT = 8, MIN_DPI = 200;   // slide pixels are 1/96 in (the exporter writes 9525 EMU per pixel)
  const recordOf = (o) => (o.figureId && S.doc.figures && S.doc.figures[o.figureId]) || null;
  /* Pixel size of a PNG data URL, read from its IHDR chunk; null for anything else. */
  function pngSize(src) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/]{32})/.exec(src || ''); if (!m) return null;
    try {
      const b = atob(m[1]), u = (i) => ((b.charCodeAt(i) << 24) | (b.charCodeAt(i + 1) << 16) | (b.charCodeAt(i + 2) << 8) | b.charCodeAt(i + 3)) >>> 0;
      return b.slice(1, 4) === 'PNG' && b.slice(12, 16) === 'IHDR' ? { w: u(16), h: u(20) } : null;
    } catch (e) { return null; }
  }
  const hasLocalFont = (a) => a.fontSize != null && a.fontSize !== 10 || !!a.fontName || ['titleSize', 'labelSize', 'tickSize', 'legendSize'].some((k) => a[k] != null);
  /* Smallest text size (pt, at the figure's own export size) that a structured record draws; null when a script or LaTeX source controls the text. */
  function ownMinPt(rec, base) {
    if (!rec || rec.sourceMode === 'custom' || !rec.config) return null;
    const a = rec.config.appearance || {}, op = rec.config.options || {}, f = base != null ? base : (a.fontSize != null ? a.fontSize : 10), t = rec.config.plotType;
    const own = (k, k2) => (base == null && a[k] != null ? a[k] : f * k2);
    const out = [own('tickSize', 0.9)];
    if (a.showTitle !== false && a.title) out.push(own('titleSize', 1.2));
    if (a.showXLabel !== false || a.showYLabel !== false) out.push(own('labelSize', 1));
    if (t !== 'box' && t !== 'heatmap' && !(a.legend && a.legend.show === false)) out.push(own('legendSize', 0.9));
    if (t === 'heatmap' && op.annotate) out.push(op.annotateSize != null ? op.annotateSize : f * 0.8);
    return Math.min.apply(null, out);
  }
  function minFontPt(rec) {
    if (!rec || rec.kind === 'latex' || rec.kind === 'python') return null;
    if (rec.kind !== 'composite') return ownMinPt(rec);
    const c = rec.composite || {}, v = (c.panels || []).filter((p) => p && p.record).map((p) => {
      const a = (p.record.config && p.record.config.appearance) || {};
      return !c.fontApplyAll && hasLocalFont(a) ? ownMinPt(p.record) : ownMinPt(Object.assign({}, p.record, { config: Object.assign({}, p.record.config, { appearance: Object.assign({}, a, { titleSize: null, labelSize: null, tickSize: null, legendSize: null }) }) }), c.fontSize != null ? c.fontSize : 10);
    }).filter((x) => x != null);
    return v.length ? Math.min.apply(null, v) : null;
  }
  function figures() {
    const out = [];
    S.doc.slides.forEach((s, i) => s.objects.forEach((o) => {
      if (o.type !== 'plot' && o.type !== 'figure') return;
      const add = (cat, text, fix) => out.push({ slide: i, id: s.id, obj: o.id, cat, text, fix });
      const rec = recordOf(o), placedIn = o.w / PX_PER_IN;
      if (!(o.alt || '').trim()) add('Missing alt text', `${nameOf(o)} has no alternative text.`, 'alt');
      if (!hasCaption(s, o) && !o.caption) add('Missing caption', `${nameOf(o)} has no caption.`, 'caption');
      if (!o.src) add('Not rendered', `${nameOf(o)} has no picture. Open the figure editor and apply it to render it.`);
      else {
        const px = pngSize(o.src);
        if (px && placedIn > 0) { const dpi = px.w / placedIn; if (dpi < MIN_DPI) add('Low resolution', `${nameOf(o)} is ${Math.round(dpi)} dpi at its size on the slide (${px.w} px over ${placedIn.toFixed(1)} in); below ${MIN_DPI} dpi it prints soft. Raise the DPI in the figure's Export tab or place it smaller.`); }
      }
      const pt = minFontPt(rec), wIn = rec && rec.export && rec.export.wIn;
      if (pt != null && wIn > 0 && placedIn > 0) { const eff = pt * placedIn / wIn; if (eff < MIN_PT) add('Small text', `Text in ${nameOf(o)} is about ${eff.toFixed(1)} pt at its size on the slide (${pt} pt drawn at ${wIn} in wide, shown ${placedIn.toFixed(1)} in wide); the minimum is ${MIN_PT} pt. Make the text larger in the figure or place it bigger.`); }
      const st = rec && rec.render && rec.render.status;
      if (st === 'stale') add('Out of date', `${nameOf(o)} was changed after its picture was made. Open the figure editor and apply it to update the slide.`);
      else if (st === 'error') { const e = rec.render.error, msg = String((e && e.message) || e || '').trim().slice(0, 140); add('Failed render', `The last render of ${nameOf(o)} failed${msg ? ': ' + msg : ''}. The slide still shows the last picture.`); }
    }));
    return out;
  }
  function accessibility() { return core().accessibilityFindings(S.doc, coreCtx()); }
  const MISSPELL = { teh: 'the', recieve: 'receive', seperate: 'separate', occured: 'occurred', definately: 'definitely', wich: 'which', adress: 'address', enviroment: 'environment', significent: 'significant', concetration: 'concentration', comparision: 'comparison', measurment: 'measurement' };
  function proofing() {
    const out = [];
    S.doc.slides.forEach((s, i) => s.objects.forEach((o) => {
      const t = o.type === 'table' ? (o.cells || []).map((r) => r.join('  ')).join('  ') : hasText(o) ? plain(o.html) : ''; if (!t) return;
      const add = (msg) => out.push({ slide: i, id: s.id, obj: o.id, text: msg });
      const rep = t.match(/\b([A-Za-z]{2,})\s+\1\b/i); if (rep) add(`Repeated word “${rep[1]}” in ${nameOf(o)}.`);
      if (/\S {2,}\S/.test(t) && o.type !== 'table') add(`Extra spaces in ${nameOf(o)}.`);
      (t.toLowerCase().match(/[a-z]+/g) || []).forEach((w) => { if (MISSPELL[w]) add(`“${w}” may be a misspelling of “${MISSPELL[w]}” in ${nameOf(o)}.`); });
    }));
    return out;
  }

  /* ---------- results UI ---------- */
  function goTo(it, dlg) { dlg.close(); S.setUI({ view: 'normal' }); S.setActiveSlide(it.id); if (it.obj) S.select([it.obj]); }
  function list(items, dlg, okMsg, okNote) {
    if (!items.length) return h('div', { class: 'res res--ok' }, h('span', { html: ic('circle-check') }), h('div', null, h('strong', null, okMsg || 'No issues found'), h('p', null, okNote || 'Everything checked passed.')));
    const ul = h('ul', { class: 'res__list' });
    items.forEach((it) => ul.appendChild(h('li', { class: 'res__item' }, h('button', { type: 'button', class: 'chip chip--btn', onclick: () => goTo(it, dlg) }, 'Slide ' + (it.slide + 1)), h('span', { class: 'res__text' }, (it.cat ? h('b', null, it.cat + ': ') : null), it.text),
      h('span', { class: 'res__act' }, it.fix === 'caption' ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => { goTo(it, dlg); setTimeout(() => RPE.commands.run('caption.add', { id: it.obj }, 'checks'), 30); } }, 'Add caption') : null,
        it.fix === 'alt' ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => { goTo(it, dlg); setTimeout(() => RPE.commands.run('picture.alt', {}, 'checks'), 30); } }, 'Add alt text') : null,
        it.obj ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => goTo(it, dlg) }, 'Go to') : null))));
    return ul;
  }

  function research(kind) {
    const defs = { overflow: ['Overflowing content', overflow, 'No overflowing content found', 'Checked: text taller than its box (measured on the rendered slide) and objects extending past the slide edges, including rotation and outline width (2 px tolerance). Full-width or full-height bands and bleed backgrounds are ignored. Not checked: text inside tables, headers and footers, and the content of pictures.'], smalltext: ['Very small text', smalltext, 'No very small text'], captions: ['Missing captions', captions, 'All images and tables are captioned'], figures: ['Figures', figures, 'All figures pass the checks'] };
    const results = {}; Object.keys(defs).forEach((k) => { results[k] = defs[k][1](); });
    const pane = h('div', { class: 'res__pane' }); let dlg; let cur = kind || 'overflow';
    const bar = h('div', { class: 'dtabs', role: 'tablist' });
    Object.keys(defs).forEach((k) => bar.appendChild(h('button', { type: 'button', role: 'tab', class: 'dtab', dataset: { k }, onclick: () => show(k) }, defs[k][0], h('span', { class: 'count' + (results[k].length ? ' count--warn' : '') }, String(results[k].length)))));
    function show(k) { cur = k; [].forEach.call(bar.children, (b) => { const a = b.dataset.k === k; b.classList.toggle('is-active', a); b.setAttribute('aria-selected', String(a)); }); pane.replaceChildren(...(defs[k][3] ? [h('p', { class: 'dlg__text dlg__text--muted' }, defs[k][3])] : []), list(results[k], dlg, defs[k][2])); }
    const total = Object.keys(results).reduce((n, k) => n + results[k].length, 0);
    dlg = U.dialog({ title: 'Research checks', icon: 'microscope', width: 700, dismiss: 'backdrop', body: h('div', { class: 'stack' }, h('p', { class: 'dlg__text dlg__text--muted' }, `${total ? total + ' issue' + (total > 1 ? 's' : '') + ' found across ' + S.doc.slides.length + ' slides.' : 'No issues found.'} Checks run on the current document.`), bar, pane), buttons: [{ label: 'Re-run', icon: 'refresh-cw', onClick: () => { dlg.close(); research(cur); return false; } }, { label: 'Close', kind: 'primary' }] });
    show(cur); return dlg;
  }
  function accessibilityDialog() {
    const items = accessibility(), un = items.unchecked || []; let dlg;
    const scope = h('div', { class: 'res__scope' },
      h('p', null, h('b', null, 'Checks performed')),
      h('ul', null, ['Every slide has a non-empty title.', 'Images, plots and figures have alternative text.', 'Text contrast (WCAG 2.x AA): the text colour against its own fill, filled shapes behind it, or the slide background, sampled at the centre of the text box. Needs 4.5:1, or 3:1 for large text (18 pt, or 14 pt bold).', 'Reading order: the title comes before pictures, tables and body text in stacking order.'].map((t) => h('li', null, t))),
      h('p', null, h('b', null, 'Not checked: '), 'text over pictures, gradients or irregular shapes; text inside tables; text drawn inside pictures or charts; whether alt text is accurate; colour-only meaning, language and motion. Passing these checks does not make a deck accessible; review those points manually.'));
    dlg = U.dialog({ title: 'Accessibility check', icon: 'accessibility', width: 680, dismiss: 'backdrop', body: h('div', { class: 'stack' }, scope, h('p', { class: 'dlg__text dlg__text--muted' }, (items.length ? `${items.length} item${items.length > 1 ? 's' : ''} to review.` : 'No issues found by the checks above.') + (un.length ? ` ${un.length} text object${un.length > 1 ? 's' : ''} could not be checked for contrast (over a picture, table or irregular shape).` : '')), list(items, { close: () => dlg.close() }, 'No issues found by these checks', 'This is not a guarantee that the deck is accessible.')), buttons: [{ label: 'Close', kind: 'primary' }] });
    return dlg;
  }
  function proofingDialog() {
    const items = proofing(); let dlg;
    dlg = U.dialog({ title: 'Proofing', icon: 'spell-check', width: 680, dismiss: 'backdrop', body: h('div', { class: 'stack' }, h('div', { class: 'pd__status' }, 'Basic offline checks only: repeated words, extra spaces and a short list of common misspellings. This is not a full spelling or grammar check.'), list(items, { close: () => dlg.close() }, 'No problems found by the basic checks')), buttons: [{ label: 'Close', kind: 'primary' }] });
    return dlg;
  }

  RPE.checks = { research, accessibility: accessibilityDialog, proofing: proofingDialog, run: { overflow, smalltext, captions, figures, accessibility, proofing }, figureTools: { pngSize, minFontPt } };
})(window.RPE = window.RPE || {});
