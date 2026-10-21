/* layoutpicker.js — ONE reusable slide-layout picker (Home > New Slide and Design > Layouts both mount it).
   Thumbnails are drawn from the very same generators as the real slides (RPE.layouts.build) in the deck's CURRENT theme, so they
   always match what a click creates. The 12 primary layouts show immediately; "More layouts" reveals the other 14.
   API: RPE.layoutPicker.create({ doc, current, onSelect(layoutId) }) -> { el, model, select(id), focus(), toggleMore(open) }
        RPE.layoutPicker.model(doc, current) is DOM-free (labels + thumbnail svg strings); RPE.layoutPicker.thumb(id, doc) -> svg string. */
(function (RPE) {
  'use strict';
  const L = () => RPE.layouts;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const f1 = (n) => Math.round(n * 10) / 10;

  function safeDoc(doc) {
    const d = doc && typeof doc === 'object' ? doc : {};
    return d.size && d.size.w > 0 && d.size.h > 0 ? d : Object.assign({}, d, { size: { w: 1280, h: 720 } });
  }

  /* One thumbnail: the generated objects drawn as simplified shapes (text -> bars, picture -> crossed box, table -> grid). */
  function thumb(id, doc) {
    doc = safeDoc(doc);
    const Y = L(), W = doc.size.w, H = doc.size.h, col = (c) => Y.colorOf(doc, c);
    let objs = [];
    try { objs = Y.build(id, doc); } catch (e) { objs = []; }
    const out = [`<rect width="${W}" height="${H}" fill="${col('bg') || '#fff'}"/>`];
    const st = 'vector-effect="non-scaling-stroke" stroke-width=".8"';
    objs.forEach((o) => {
      try {
        if (o.type === 'shape') {
          const fill = col(o.fill), stroke = col(o.stroke);
          out.push(o.shape === 'ellipse'
            ? `<ellipse cx="${o.x + o.w / 2}" cy="${o.y + o.h / 2}" rx="${o.w / 2}" ry="${o.h / 2}" fill="${fill || 'none'}"/>`
            : `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="${fill || 'none'}"${stroke ? ` stroke="${stroke}" ${st}` : ''}/>`);
        } else if (o.type === 'image') {
          const b = col('border') || '#bbb';
          out.push(`<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="${col('surface') || '#eee'}" stroke="${b}" ${st}/><path d="M${o.x} ${o.y}L${o.x + o.w} ${o.y + o.h}M${o.x + o.w} ${o.y}L${o.x} ${o.y + o.h}" stroke="${b}" fill="none" ${st}/>`);
        } else if (o.type === 'table') {
          const rows = (o.cells || []).length || 5, cols = ((o.cells || [])[0] || []).length || 4, rh = o.h / rows, cw = o.w / cols, b = col('border') || '#bbb';
          let s = `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${rh}" fill="${col('accent')}"/>`;
          for (let r = 1; r <= rows; r++) s += `<path d="M${o.x} ${f1(o.y + r * rh)}H${o.x + o.w}" stroke="${b}" fill="none" ${st}/>`;
          for (let k = 1; k < cols; k++) s += `<path d="M${f1(o.x + k * cw)} ${o.y}V${o.y + o.h}" stroke="${b}" fill="none" ${st}/>`;
          out.push(s);
        } else if (o.type === 'text') {
          const fs = (o.fontSize || 16) * 1.333, color = col(o.color) || col('text'), th = clamp(fs * .5, 8, 44);
          const isTitle = o.role === 'title' && fs >= 28, isKicker = o.role === 'kicker';
          const n = isTitle || isKicker || o.h < fs * 2.6 ? 1 : clamp(Math.floor(o.h / (fs * 2)), 2, 5);
          const pitch = isTitle || n === 1 ? 0 : clamp(fs * 1.9, th + 6, (o.h - th) / (n - 1));
          const total = th + pitch * (n - 1);
          const y0 = o.vAlign === 'middle' ? o.y + (o.h - total) / 2 : o.vAlign === 'bottom' ? o.y + o.h - total : o.y + 4;
          for (let i = 0; i < n; i++) {
            let w = isKicker ? Math.min(o.w * .3, 240) : isTitle ? o.w * .62 : n === 1 ? o.w * .6 : o.w * (i === n - 1 ? .55 : .94);
            if (o.slot === 'number' || o.slot === 'stat') w = Math.min(w, o.w * .4);
            const x = o.align === 'center' ? o.x + (o.w - w) / 2 : o.align === 'right' ? o.x + o.w - w : o.x;
            out.push(`<rect x="${f1(x)}" y="${f1(y0 + i * pitch)}" width="${f1(w)}" height="${f1(th)}" rx="${f1(th / 3)}" fill="${color}" opacity="${isTitle || isKicker || o.bold ? .85 : .5}"/>`);
          }
        }
      } catch (e) { /* a bad object never breaks the picker */ }
    });
    return `<svg viewBox="0 0 ${W} ${H}" class="lp lpick__svg" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid meet">${out.join('')}</svg>`;
  }

  /* DOM-free view model: 12 primary + 14 more, each with its thumbnail markup. */
  function model(doc, current) {
    doc = safeDoc(doc);
    const row = (m) => ({ id: m.id, name: m.name, category: m.category, selected: !!current && ((L().get(current) || {}).id === m.id), svg: thumb(m.id, doc) });
    return { primary: L().primary().map(row), more: L().more().map(row) };
  }

  function create(opts) {
    opts = opts || {};
    const doc = safeDoc(opts.doc || (RPE.store && RPE.store.doc));
    const mdl = model(doc, opts.current);
    const api = { model: mdl, el: null, select(id) { if (L().get(id) && typeof opts.onSelect === 'function') opts.onSelect(id); }, focus() {}, toggleMore() {} };
    if (typeof document === 'undefined' || !document.createElement) return api;

    const mk = (tag, cls, attrs) => { const e = document.createElement(tag); if (cls) e.className = cls; Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k])); return e; };
    const tile = (m) => {
      const b = mk('button', 'lpick__tile' + (m.selected ? ' is-selected' : ''), { type: 'button', 'data-layout': m.id, title: `${m.name} — ${m.category}`, 'aria-label': m.name, tabindex: '-1' });
      if (m.selected) b.setAttribute('aria-current', 'true');
      b.innerHTML = `${m.svg}<span class="lpick__label">${esc(m.name)}</span>`;
      return b;
    };
    const grid = (items) => { const g = mk('div', 'lpick__grid'); items.forEach((m) => g.appendChild(tile(m))); return g; };
    const root = mk('div', 'lpick', { role: 'group', 'aria-label': 'Slide layouts' });
    const g1 = grid(mdl.primary), g2 = grid(mdl.more);
    const extra = mk('div', 'lpick__extra', { id: 'lpick-extra-' + Math.random().toString(36).slice(2, 7) });
    extra.hidden = true; extra.appendChild(g2);
    const btn = mk('button', 'lpick__more', { type: 'button', 'aria-expanded': 'false', 'aria-controls': extra.id, tabindex: '-1' });
    const label = () => { const open = !extra.hidden; btn.innerHTML = `<span>${open ? 'Fewer layouts' : 'More layouts'}</span><span class="lpick__count">${open ? '' : mdl.more.length}</span><span class="lpick__chev" aria-hidden="true">${open ? '▴' : '▾'}</span>`; btn.setAttribute('aria-expanded', open ? 'true' : 'false'); };
    label();
    root.append(g1, btn, extra);

    const tiles = (g) => [].slice.call(g.querySelectorAll('.lpick__tile'));
    const colsOf = (g) => { try { return Math.max(1, getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length); } catch (e) { return 4; } };
    /* rows of focusable controls: primary tiles (chunked), the More button, then (when open) the extra tiles */
    const rows = () => {
      const chunk = (g) => { const t = tiles(g), n = colsOf(g), r = []; for (let i = 0; i < t.length; i += n) r.push(t.slice(i, i + n)); return r; };
      return chunk(g1).concat([[btn]], extra.hidden ? [] : chunk(g2));
    };
    const all = () => [].concat.apply([], rows());
    const focusEl = (el) => { if (!el) return; all().forEach((x) => x.setAttribute('tabindex', '-1')); el.setAttribute('tabindex', '0'); el.focus(); };
    api.focus = () => focusEl(root.querySelector('.lpick__tile.is-selected') || tiles(g1)[0]);
    api.toggleMore = (open) => { extra.hidden = open == null ? !extra.hidden : !open; label(); };
    const init = root.querySelector('.lpick__tile.is-selected') || tiles(g1)[0]; if (init) init.setAttribute('tabindex', '0');

    root.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('.lpick__tile');
      if (t) { e.preventDefault(); api.select(t.dataset.layout); return; }
      if (e.target.closest && e.target.closest('.lpick__more')) { api.toggleMore(); focusEl(btn); }
    });
    root.addEventListener('keydown', (e) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      const R = rows(); let r = -1, c = -1;
      R.forEach((row, i) => { const j = row.indexOf(e.target.closest ? e.target.closest('.lpick__tile,.lpick__more') : e.target); if (j >= 0) { r = i; c = j; } });
      if (r < 0) return;
      e.preventDefault(); e.stopPropagation();   // the surrounding popover would otherwise run its own linear arrow navigation
      let target = null;
      if (e.key === 'ArrowLeft') target = R[r][c - 1];
      else if (e.key === 'ArrowRight') target = R[r][c + 1];
      else if (e.key === 'ArrowDown' && R[r + 1]) target = R[r + 1][Math.min(c, R[r + 1].length - 1)];
      else if (e.key === 'ArrowUp' && R[r - 1]) target = R[r - 1][Math.min(c, R[r - 1].length - 1)];
      else if (e.key === 'Home') target = R[0][0];
      else if (e.key === 'End') { const a = all(); target = a[a.length - 1]; }
      focusEl(target);
    });
    api.el = root;
    return api;
  }

  /* Convenience for isolated use: create + append into a container. */
  function mount(container, opts) { const p = create(opts); if (container && p.el) container.appendChild(p.el); return p; }

  RPE.layoutPicker = { create, mount, model, thumb };
  if (typeof module !== 'undefined' && module.exports) module.exports = RPE.layoutPicker;
})(window.RPE = window.RPE || {});
