/* headerfooter.js — header / footer / slide-number model. Pure data + helpers, no DOM (mirrored in backend/headerfooter.py).

   Storage (see DEV_NOTES.md): the deck has no master/layout objects, only a document-level theme, so the shared "master"
   is `doc.hf`, with an optional sparse per-slide override in `slide.hf`. Both are absent until something is set.
     doc.hf   = { header?: Item, footer?: Item, number?: false, onTitle?: true }
     slide.hf = { header?: Item, footer?: Item, number?: boolean }
     Item     = { html, font, fontSize, bold, italic, underline, strike, subscript, superscript, color, align, lineHeight, enabled }
   An item is kept only when it has text, or (master) enabled === true, or (slide override) enabled === false (hides the master item).
   Geometry is never stored: it is derived from doc.size by region(), so changing the slide size keeps working.
   The slide number keeps its legacy behaviour (shown on every slide except layout "title") unless number === false.
   Slide-number extras (doc.hf only, both optional, absent = defaults): startAt = number of the first slide (integer 0..9999, default 1;
   a hidden slide still counts), numberItem = { font, fontSize (pt), bold, italic, underline, color, align: left|center|right, x, y, w, h }. */
(function (RPE) {
  'use strict';

  const KEYS = ['header', 'footer'];
  const STYLE_BOOL = ['bold', 'italic', 'underline', 'strike', 'subscript', 'superscript'];
  const ALIGNS = ['left', 'center', 'right', 'justify'];
  const DEFAULTS = { fontSize: 12, align: 'left', lineHeight: 1, color: 'muted' };
  const MAX_HTML = 4000;

  const plain = (html) => String(html == null ? '' : html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;|\u00a0/g, ' ').trim();
  const hasText = (it) => !!(it && typeof it.html === 'string' && plain(it.html));
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  /* Conservative allow-list: the file is data, so tags/attributes that could run script are dropped. */
  const ALLOWED = /^(p|br|b|i|u|s|strong|em|span|font|sub|sup|a|div)$/i;
  function safeHtml(html) {
    let h = String(html).slice(0, MAX_HTML * 4);
    h = h.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|iframe|object|embed)\b[\s\S]*?(<\/\1>|$)/gi, '');
    h = h.replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (m, tag) => {
      if (!ALLOWED.test(tag)) return '';
      return m.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
    });
    return h.slice(0, MAX_HTML);
  }

  /* -> cleaned copy of a stored item, or null when it is not an object */
  function cleanItem(it) {
    if (!isObj(it)) return null;
    const o = {};
    if (typeof it.html === 'string') o.html = safeHtml(it.html);
    if (typeof it.enabled === 'boolean') o.enabled = it.enabled;
    if (typeof it.font === 'string' && it.font && it.font.length <= 120) o.font = it.font;
    if (typeof it.fontSize === 'number' && isFinite(it.fontSize) && it.fontSize >= 1 && it.fontSize <= 400) o.fontSize = it.fontSize;
    if (typeof it.lineHeight === 'number' && isFinite(it.lineHeight) && it.lineHeight >= 0.5 && it.lineHeight <= 5) o.lineHeight = it.lineHeight;
    STYLE_BOOL.forEach((k) => { if (typeof it[k] === 'boolean') o[k] = it[k]; });
    if (typeof it.color === 'string' && /^[#\w(),.%\s-]{1,40}$/.test(it.color)) o.color = it.color;
    if (ALIGNS.includes(it.align)) o.align = it.align;
    return o;
  }
  const num = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
  /* style / geometry of the slide number; unknown or invalid keys are dropped */
  function cleanNumberItem(it) {
    if (!isObj(it)) return null;
    const o = {};
    if (typeof it.font === 'string' && it.font && it.font.length <= 120) o.font = it.font;
    if (num(it.fontSize, 1, 400)) o.fontSize = it.fontSize;
    ['bold', 'italic', 'underline'].forEach((k) => { if (typeof it[k] === 'boolean') o[k] = it[k]; });
    if (typeof it.color === 'string' && /^[#\w(),.%\s-]{1,40}$/.test(it.color)) o.color = it.color;
    if (['left', 'center', 'right'].includes(it.align)) o.align = it.align;
    ['x', 'y'].forEach((k) => { if (num(it[k], -10000, 100000)) o[k] = it[k]; });
    ['w', 'h'].forEach((k) => { if (num(it[k], 1, 100000)) o[k] = it[k]; });
    return Object.keys(o).length ? o : null;
  }
  const keepMaster = (o) => !!o && (hasText(o) || o.enabled === true);
  const keepSlide = (o) => !!o && (hasText(o) || o.enabled === false);

  function cleanMaster(hf) {
    if (!isObj(hf)) return null;
    const out = {};
    KEYS.forEach((k) => { const it = cleanItem(hf[k]); if (keepMaster(it)) out[k] = it; });
    if (hf.number === false) out.number = false;
    if (hf.onTitle === true) out.onTitle = true;
    if (typeof hf.startAt === 'number' && Number.isInteger(hf.startAt) && hf.startAt >= 0 && hf.startAt <= 9999 && hf.startAt !== 1) out.startAt = hf.startAt;
    const ni = cleanNumberItem(hf.numberItem); if (ni) out.numberItem = ni;
    return Object.keys(out).length ? out : null;
  }
  function cleanSlide(hf) {
    if (!isObj(hf)) return null;
    const out = {};
    KEYS.forEach((k) => { const it = cleanItem(hf[k]); if (keepSlide(it)) out[k] = it; });
    if (typeof hf.number === 'boolean') out.number = hf.number;
    return Object.keys(out).length ? out : null;
  }

  /* In place, idempotent. Repairs malformed data and removes empty objects. Never creates anything. Returns doc. */
  function normalize(doc) {
    if (!isObj(doc)) return doc;
    if (doc.hf !== undefined) { const m = cleanMaster(doc.hf); if (m) doc.hf = m; else delete doc.hf; }
    if (Array.isArray(doc.slides)) {
      doc.slides.forEach((s) => {
        if (!isObj(s) || s.hf === undefined) return;
        const o = cleanSlide(s.hf); if (o) s.hf = o; else delete s.hf;
      });
    }
    return doc;
  }
  /* Same as normalize but only the empty-object removal, for use after an edit. Returns true when something was removed. */
  function prune(doc) {
    const before = JSON.stringify([doc.hf, (doc.slides || []).map((s) => s.hf)]);
    normalize(doc);
    return before !== JSON.stringify([doc.hf, (doc.slides || []).map((s) => s.hf)]);
  }

  /* ---------- geometry (logical px, derived from the slide size; matches the 5% margin of the theme decor) ---------- */
  function region(key, size) {
    const w = (size && size.w) || 1280, h = (size && size.h) || 720, m = Math.round(w * 0.05);
    if (key === 'header') return { x: m, y: Math.round(h * 0.05), w: w - 2 * m, h: Math.round(h * 0.036) };
    if (key === 'footer') return { x: m, y: h - Math.round(h * 0.061), w: w - 2 * m - 70, h: Math.round(h * 0.04) };
    return numberRegion(size);
  }
  function numberRegion(size, item) {
    const w = (size && size.w) || 1280, h = (size && size.h) || 720;
    const g = { x: w - 28 - 64, y: h - 16 - 24, w: 64, h: 24 };
    if (item) ['x', 'y', 'w', 'h'].forEach((k) => { if (typeof item[k] === 'number') g[k] = item[k]; });
    return g;
  }
  /* ---------- slide number: value, style, geometry (all derived from doc.hf, defaults when absent) ---------- */
  const NUM_DEFAULTS = { fontSize: 12, align: 'right', color: 'muted', bold: false, italic: false, underline: false };
  const numberStart = (doc) => { const v = doc && doc.hf && doc.hf.startAt; return Number.isInteger(v) ? v : 1; };
  /* number shown on the slide at 0-based position `index` (hidden slides still count, like PowerPoint) */
  const numberValue = (doc, index) => numberStart(doc) + index;
  const numberStyle = (doc) => Object.assign({}, NUM_DEFAULTS, (doc && doc.hf && doc.hf.numberItem) || {});
  const numberGeom = (doc) => numberRegion(doc && doc.size, doc && doc.hf && doc.hf.numberItem);

  /* ---------- resolution ---------- */
  const isTitle = (slide) => !!slide && slide.layout === 'title';
  /* -> { item, source: 'slide'|'master'|null, visible, editable }.
     visible = the item should be drawn (has text and is not hidden); editable = the region accepts editing on this slide. */
  function state(doc, slide, key) {
    const so = slide && slide.hf && slide.hf[key], mo = doc && doc.hf && doc.hf[key];
    const masterShown = !isTitle(slide) || !!(doc && doc.hf && doc.hf.onTitle);
    if (so && so.enabled === false) return { item: null, source: 'slide', visible: false, editable: false, hidden: true };
    if (so && hasText(so)) return { item: so, source: 'slide', visible: true, editable: true };
    if (mo && mo.enabled === false) return { item: mo, source: 'master', visible: false, editable: masterShown, hidden: true };
    if (mo && masterShown && (hasText(mo) || mo.enabled === true)) return { item: mo, source: 'master', visible: hasText(mo), editable: true };
    return { item: null, source: null, visible: false, editable: masterShown };
  }
  function numberOn(doc, slide) {
    const s = slide && slide.hf && slide.hf.number;
    if (typeof s === 'boolean') return s;
    if (doc && doc.hf && doc.hf.number === false) return false;
    return !isTitle(slide);
  }

  /* Plain render object (type "text") for one region, or null when nothing should be drawn. `force` also returns an empty
     object for an editable region (used for the invisible double-click target in the editor). */
  function view(doc, slide, key, force) {
    const st = state(doc, slide, key);
    if (!st.visible && !(force && st.editable)) return null;
    const g = region(key, doc.size);
    return Object.assign({ id: 'hf:' + key, type: 'text', role: 'hf-' + key, vAlign: 'middle', hf: key, html: '' }, DEFAULTS, st.item || {}, g);
  }

  /* ---------- editing: a live object for the editor's text engine ---------- */
  const GEO = ['x', 'y', 'w', 'h'];
  const RESERVED = ['id', 'type', 'role', 'vAlign', 'hf'].concat(GEO);
  const isId = (id) => typeof id === 'string' && id.indexOf('hf:') === 0 && KEYS.includes(id.slice(3));

  /* where an edit of `key` on this slide lands: the slide override when one with text exists, else the shared master item */
  function holder(doc, slide, key, create) {
    const so = slide && slide.hf && slide.hf[key];
    if (so && so.enabled !== false) return so;   // a live per-slide override (kept while mid-edit even if momentarily empty)
    if (create) {
      doc.hf = doc.hf || {};
      const it = doc.hf[key] = doc.hf[key] || {};
      if (it.enabled === false) delete it.enabled;   // editing a hidden item shows it again
      return it;
    }
    return doc.hf && doc.hf[key] ? doc.hf[key] : null;
  }
  /* Behaves like the text object the engine expects (reads fall back to the defaults, writes go to the stored item, created on
     first write so nothing exists until there is something to store). Call within S.mutate for undoable writes. */
  function proxy(doc, slide, key) {
    const g = region(key, doc.size), cur = () => holder(doc, slide, key, false);
    const read = (p) => {
      if (GEO.includes(p)) return g[p];
      if (p === 'id') return 'hf:' + key;
      if (p === 'type') return 'text';
      if (p === 'role') return 'hf-' + key;
      if (p === 'vAlign') return 'middle';
      if (p === 'hf') return key;
      const it = cur();
      if (it && it[p] !== undefined) return it[p];
      return p === 'html' ? '' : DEFAULTS[p];
    };
    const keys = () => RESERVED.concat(Object.keys(cur() || {}).filter((k) => !RESERVED.includes(k)));
    return new Proxy({}, {
      get: (_, p) => (typeof p === 'string' ? read(p) : undefined),
      set: (_, p, v) => { if (typeof p === 'string' && !RESERVED.includes(p)) holder(doc, slide, key, true)[p] = v; return true; },
      deleteProperty: (_, p) => { const it = cur(); if (it && typeof p === 'string') delete it[p]; return true; },
      has: (_, p) => typeof p === 'string' && (RESERVED.includes(p) || !!(cur() && p in cur())),
      ownKeys: keys,
      getOwnPropertyDescriptor: (_, p) => (typeof p === 'string' && (keys().includes(p)) ? { value: read(p), enumerable: true, configurable: true, writable: true } : undefined)
    });
  }
  /* Region id -> proxy for the active slide, or null (unknown id / no such slide / region not editable here). */
  function resolveId(doc, slide, id) {
    if (!isId(id) || !doc || !slide) return null;
    const key = id.slice(3);
    return state(doc, slide, key).editable ? proxy(doc, slide, key) : null;
  }

  RPE.hf = { numberStart, numberValue, numberStyle, numberGeom, NUM_DEFAULTS, cleanNumberItem, KEYS, DEFAULTS, plain, hasText, safeHtml, cleanItem, normalize, prune, region, numberRegion, state, numberOn, view, proxy, resolveId, isId, holder };
  if (typeof module !== 'undefined' && module.exports) module.exports = RPE.hf;
})(typeof window !== 'undefined' ? (window.RPE = window.RPE || {}) : (globalThis.RPE = globalThis.RPE || {}));
