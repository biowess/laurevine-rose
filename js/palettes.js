/* palettes.js — ONE colour-palette registry + the "apply palette by semantic role" operation.
   Palettes = the 5 legacy RPE.themes.PALETTES (accent lists; neutrals are inherited from the open deck) + 10 template-linked palettes
   (id = template id) whose colours are the template's own tpl.colors plus roles DERIVED from the slides tpl.buildSlides() really draws
   (card fill, on-accent text, title colour, extra accents); nothing is duplicated as constants here.
   Roles: background {bg, card} · text {text, title, muted, onAccent} · accent {accent, accent2} · supporting {surface, border}
          + table {headerFill, headerText} + chart[6] (series accents).
   Persisted doc field: doc.palette = { id, roles, chart, table, dark } (resolved snapshot; the backend reads it, no template knowledge needed).
   Old docs without it keep today's behaviour (theme colours); doc.paletteId (legacy id or template id) is the fallback for "which palette is this". */
(function (RPE) {
  'use strict';
  const T = RPE.themes;
  const GROUPS = { background: ['bg', 'card'], text: ['text', 'title', 'muted', 'onAccent'], accent: ['accent', 'accent2'], supporting: ['surface', 'border'] };
  const ROLES = [].concat(GROUPS.background, GROUPS.text, GROUPS.accent, GROUPS.supporting);
  const clone = (x) => JSON.parse(JSON.stringify(x));

  /* ---------- colour maths ---------- */
  function hex(c) {
    if (typeof c !== 'string') return null;
    const s = c.trim();
    let m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) return '#' + m[1].split('').map((x) => x + x).join('').toUpperCase();
    m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) return '#' + m[1].toUpperCase();
    m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(s);
    return m ? T.rgbToHex(+m[1], +m[2], +m[3]) : null;
  }
  function lum(h) {
    const c = T.hexToRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function mix(a, b, f) { const x = T.hexToRgb(a), y = T.hexToRgb(b); return T.rgbToHex(x[0] + (y[0] - x[0]) * f, x[1] + (y[1] - x[1]) * f, x[2] + (y[2] - x[2]) * f); }
  const spread = (h) => { const c = T.hexToRgb(h); return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]); };
  const dist = (a, b) => { const x = T.hexToRgb(a), y = T.hexToRgb(b); return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]); };
  /* first candidate readable on `on`, else the most readable one */
  function pickOn(on, cands, floor) {
    const list = cands.filter(Boolean);
    const ok = list.find((c) => contrast(c, on) >= (floor || 4.5));
    return ok || list.slice().sort((p, q) => contrast(q, on) - contrast(p, on))[0];
  }
  function modal(tally, prefer) {
    let best = null, n = -1;
    Object.keys(tally).forEach((k) => {
      const c = tally[k] + (prefer && prefer.indexOf(k) >= 0 ? 0.5 : 0);
      if (c > n) { n = c; best = k; }
    });
    return best;
  }
  const tableOf = (r) => ({ headerFill: r.accent, headerText: r.onAccent });
  function padChart(list, r) {
    const out = [];
    list.concat([T.tintColor(r.accent, 0.35), T.tintColor(r.accent2, 0.35), T.shadeColor(r.accent, 0.25), T.shadeColor(r.accent2, 0.25)]).forEach((c) => { c = hex(c); if (c && out.indexOf(c) < 0 && out.length < 6) out.push(c); });
    return out;
  }

  /* every colour a template object carries: text (own + inline html + table cells) and fills */
  function textColorsOf(o, withTables) {
    const out = [];
    if (o.color) out.push(o.color);
    String(o.html || '').replace(/(?:^|[;"'\s])color\s*[:=]\s*["']?(#[0-9a-fA-F]{3,6})/g, (m, c) => { out.push(c); return m; });
    if (withTables && o.type === 'table') Object.keys(o.cellFmt || {}).forEach((k) => { if (o.cellFmt[k].color) out.push(o.cellFmt[k].color); });
    return out.map(hex).filter(Boolean);
  }

  /* ---------- registry ---------- */
  function templatePalette(tpl) {
    const c = tpl.colors || {};
    const roles = { bg: hex(c.bg), text: hex(c.text), accent: hex(c.accent), accent2: hex(c.accent2), surface: hex(c.surface), border: hex(c.border), muted: hex(c.muted) };
    const baseSet = new Set(Object.keys(roles).map((k) => roles[k]));
    const tally = { title: {}, fill: {}, text: {}, chroma: {} };   // fill = neutral shape fills (bg included, counted apart below)
    const inc = (m, k) => { if (k) m[k] = (m[k] || 0) + 1; };
    let slides = [];
    try { slides = tpl.buildSlides(); } catch (e) { slides = []; }
    slides.forEach((s) => (s.objects || []).forEach((o) => {
      if (!o) return;
      const tc = textColorsOf(o);   // text on shapes / text boxes (table cells sit on their own fills: they feed only the extra accents)
      if (o.type === 'text' && o.role === 'title') inc(tally.title, hex(o.color));
      tc.forEach((x) => inc(tally.text, x));
      const f = o.type === 'shape' ? hex(o.fill) : null;
      if (f && spread(f) <= 40 && (!baseSet.has(f) || f === roles.bg)) inc(tally.fill, f);
      tc.concat(textColorsOf(o, true), f ? [f] : []).forEach((x) => { if (spread(x) > 40) inc(tally.chroma, x); });
    }));
    /* card = the raised neutral fill templates really draw (white on tinted pages, a lighter navy on the dark one); the page colour itself when no such fill is used */
    const raised = Object.keys(tally.fill).filter((k) => k !== roles.bg && tally.fill[k] >= 8).reduce((a, k) => { a[k] = tally.fill[k]; return a; }, {});
    roles.card = modal(raised) || roles.bg;
    const t = modal(Object.keys(tally.title).filter((k) => contrast(k, roles.bg) >= 4.5).reduce((a, k) => { a[k] = tally.title[k]; return a; }, {}));
    roles.title = t || roles.text;
    const onCands = Object.keys(tally.text).filter((k) => [roles.text, roles.muted, roles.accent, roles.accent2, roles.title].indexOf(k) < 0 && contrast(k, roles.accent) >= 4.5)
      .reduce((a, k) => { a[k] = tally.text[k]; return a; }, {});
    roles.onAccent = modal(onCands) || pickOn(roles.accent, [roles.card, roles.bg, roles.text]);
    const extras = [], taken = [roles.bg, roles.card, roles.surface, roles.border, roles.text, roles.muted, roles.accent, roles.accent2];
    Object.keys(tally.chroma).sort((a, b) => tally.chroma[b] - tally.chroma[a]).forEach((x) => {
      if (extras.length < 4 && contrast(x, roles.bg) >= 3 && taken.concat(extras).every((y) => dist(x, y) >= 40)) extras.push(x);
    });
    const chart = padChart([roles.accent, roles.accent2].concat(extras), roles);
    return { id: tpl.id, name: tpl.name, kind: 'template', templateId: tpl.id, dark: !!tpl.dark || lum(roles.bg) < 0.18, roles, table: tableOf(roles), chart };
  }

  function legacyPalette(p) {
    const cols = p.colors.map(hex).filter(Boolean);
    const roles = { accent: cols[0], accent2: cols[1] || cols[0] };
    return { id: p.id, name: p.name, kind: 'legacy', templateId: null, partial: true, roles, chart: padChart(cols, roles) };
  }

  let cache = null;
  function all() {
    if (cache) return cache;
    const tpls = (RPE.templates && RPE.templates.list) ? RPE.templates.list().map(templatePalette) : [];
    cache = T.PALETTES.map(legacyPalette).concat(tpls);
    return cache;
  }
  const list = () => all().slice();
  const listLegacy = () => all().filter((p) => p.kind === 'legacy');
  const listTemplates = () => all().filter((p) => p.kind === 'template');
  const get = (id) => all().find((p) => p.id === id) || null;
  const swatches = (p) => p.kind === 'template' ? [p.roles.bg, p.roles.surface, p.roles.text, p.roles.accent, p.roles.accent2, p.chart[2] || p.roles.border] : p.chart.slice(0, 6);
  /* roles with no value (a palette must have none missing; legacy ones are partial by design) */
  const missingRoles = (p) => ROLES.filter((r) => !hex(p.roles[r])).concat(p.chart && p.chart.length === 6 && p.chart.every(hex) ? [] : ['chart']);

  /* ---------- persistence ---------- */
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.roles || typeof raw.roles !== 'object') return null;
    const r = {};
    for (const k of ['bg', 'text', 'accent', 'accent2']) { r[k] = hex(raw.roles[k]); if (!r[k]) return null; }
    const opt = (k, dflt) => hex(raw.roles[k]) || dflt;
    r.card = opt('card', r.bg); r.title = opt('title', r.text);
    r.muted = opt('muted', mix(r.text, r.bg, 0.4)); r.surface = opt('surface', mix(r.bg, r.text, 0.06)); r.border = opt('border', mix(r.bg, r.text, 0.2));
    r.onAccent = opt('onAccent', pickOn(r.accent, [r.card, r.bg, r.text]));
    const ch = Array.isArray(raw.chart) ? raw.chart.map(hex).filter(Boolean).slice(0, 12) : [];
    const roles = {}; ROLES.forEach((k) => { roles[k] = r[k]; });
    return { id: typeof raw.id === 'string' ? raw.id.slice(0, 80) : 'custom', roles, chart: ch.length ? ch : [r.accent, r.accent2], table: tableOf(r), dark: typeof raw.dark === 'boolean' ? raw.dark : lum(r.bg) < 0.18 };
  }
  const snapshot = (p) => sanitize({ id: p.id, roles: p.roles, chart: p.chart, dark: p.dark });
  const snapshotOf = (doc) => (doc && doc.palette ? sanitize(doc.palette) : null);
  /* Called from migrateDoc: repairs/drops an invalid persisted field, never creates one. */
  function normalize(doc) {
    if (!doc || typeof doc !== 'object' || doc.palette === undefined) return doc;
    const s = sanitize(doc.palette);
    if (s) doc.palette = s; else delete doc.palette;
    return doc;
  }

  /* ---------- the active palette of a document ---------- */
  const baseTheme = T.theme;
  function fromTheme(doc, lp) {
    const tp = get(doc && doc.themeId);
    if (tp && tp.kind === 'template') return Object.assign({}, clone(tp), { id: lp ? lp.id : tp.id, kind: lp ? 'legacy' : 'template', chart: lp ? lp.chart.slice() : tp.chart.slice() });
    const th = baseTheme(doc), bg = hex(th.bg) || '#FFFFFF', text = hex(th.text) || '#292A2D';
    const roles = { bg, card: bg, surface: mix(bg, text, 0.06), border: mix(bg, text, 0.2), text, title: hex(th.title) || text, muted: hex(th.muted) || mix(text, bg, 0.4), accent: hex(th.accent) || '#702D3B', accent2: hex(th.accent2) || '#A65C68' };
    roles.onAccent = pickOn(roles.accent, ['#FFFFFF', bg, text]);
    return { id: lp ? lp.id : 'custom', name: lp ? lp.name : 'Custom', kind: 'legacy', templateId: null, dark: !!th.dark, roles, table: tableOf(roles), chart: lp ? lp.chart.slice() : padChart([roles.accent, roles.accent2], roles) };
  }
  function forDoc(doc) {
    const snap = snapshotOf(doc);
    if (snap) {
      const b = get(snap.id);
      return { id: snap.id, name: b ? b.name : 'Custom', kind: b ? b.kind : 'custom', templateId: b ? b.templateId : null, dark: snap.dark, roles: snap.roles, table: snap.table, chart: snap.chart };
    }
    const p = get(doc && doc.paletteId);
    return (p && p.kind === 'template') ? p : fromTheme(doc, p);
  }

  /* RPE.themes.theme(doc) = base theme + the persisted palette's colours (only when the doc has a palette snapshot) */
  const themeCache = new WeakMap();
  function effectiveTheme(doc) {
    const base = baseTheme(doc);
    const raw = doc && doc.palette;
    if (!raw || typeof raw !== 'object') return base;
    const hit = themeCache.get(raw);
    if (hit && hit.base === base) return hit.th;
    const sp = sanitize(raw);
    if (!sp) return base;
    const r = sp.roles;
    const th = Object.assign({}, base, { bg: r.bg, text: r.text, title: r.title, muted: r.muted, accent: r.accent, accent2: r.accent2, surface: r.surface, border: r.border, card: r.card, onAccent: r.onAccent, dark: sp.dark });
    themeCache.set(raw, { base, th });
    return th;
  }

  /* ---------- apply ---------- */
  const ORDER = {
    bg: ['bg', 'card', 'surface', 'accent', 'accent2', 'text', 'border', 'muted'],
    fill: ['card', 'surface', 'accent', 'accent2', 'border', 'bg', 'text', 'muted', 'onAccent'],
    stroke: ['border', 'accent', 'accent2', 'surface', 'muted', 'text', 'card', 'bg'],
    text: ['text', 'title', 'muted', 'accent', 'accent2', 'onAccent', 'bg', 'card', 'surface', 'border'],
    title: ['title', 'text', 'muted', 'accent', 'accent2', 'onAccent', 'bg', 'card', 'surface', 'border']
  };

  /* Target palette as a full role set: template palettes as-is; a legacy palette only swaps the accents of the open deck. */
  function resolveTarget(src, id) {
    const p = get(id);
    if (!p) return null;
    if (p.kind === 'template') return p;
    const roles = Object.assign({}, src.roles, { accent: p.chart[0], accent2: p.chart[1] || p.chart[0] });
    roles.onAccent = pickOn(roles.accent, [src.roles.onAccent, roles.card, roles.bg, roles.text]);
    return { id: p.id, name: p.name, kind: 'legacy', templateId: null, dark: src.dark, roles, table: tableOf(roles), chart: p.chart.slice() };
  }

  /* Presentation-wide, colours only. Call inside ONE S.mutate (single undo step). Works on empty decks.
     Each stored colour is classified by the ROLE it plays in the palette(s) the deck was built from (looked up per property kind:
     bg/fill/stroke/text), then replaced by the same role of the target. Colours that play no role stay as they are; tokens
     ('accent', 'muted'…) follow the persisted palette by themselves. Text that would become unreadable on its new backdrop falls
     back to a safe role (text, on-accent, bg, card), never demanding more contrast than the source pair had. */
  function apply(doc, id) {
    const src = forDoc(doc), target = resolveTarget(src, id);
    if (!target) return false;
    const srcs = [src];
    [doc.templateId, doc.themeId].forEach((tid) => { const p = get(tid); if (p && p.kind === 'template' && !srcs.some((x) => x.id === p.id)) srcs.push(p); });
    const oldTh = T.theme(doc), tr = target.roles;

    const roleValue = (role) => { const m = /^chart(\d+)$/.exec(role); return m ? target.chart[+m[1] % target.chart.length] : tr[role]; };
    function classify(h, kind) {
      for (const p of srcs) { for (const role of ORDER[kind]) if (p.roles[role] === h) return role; }
      if (kind !== 'bg') for (const p of srcs) { const i = (p.chart || []).indexOf(h); if (i >= 0) return 'chart' + i; }
      return null;
    }
    const mapColor = (v, kind) => { const h = hex(v); if (!h) return v; const role = classify(h, kind); return role ? roleValue(role) : v; };
    const tokHex = (v, th) => hex(v) || hex(th[v]) || null;

    (doc.slides || []).forEach((s) => {
      const objs = s.objects || [];
      const oldBg = tokHex(s.bg, oldTh) || hex(oldTh.bg) || '#FFFFFF';
      let newBg = tr.bg;
      if (s.bg) { s.bg = mapColor(s.bg, 'bg'); newBg = tokHex(s.bg, { accent: tr.accent, accent2: tr.accent2, text: tr.text, muted: tr.muted, bg: tr.bg, title: tr.title }) || tr.bg; }

      /* pass 1: fills / strokes / borders (old + new opaque fill of every object, for the backdrop lookups) */
      const oldFill = [], newFill = [];
      objs.forEach((o, i) => {
        oldFill[i] = newFill[i] = null;
        if (!o) return;
        if (typeof o.fill === 'string') { oldFill[i] = hex(o.fill); o.fill = mapColor(o.fill, 'fill'); newFill[i] = hex(o.fill); }
        if (typeof o.stroke === 'string') o.stroke = mapColor(o.stroke, 'stroke');
        if (o.tableBorder && typeof o.tableBorder.color === 'string') o.tableBorder.color = mapColor(o.tableBorder.color, 'stroke');
      });
      const backdrop = (i, fills, bg) => {
        if (fills[i]) return fills[i];
        const o = objs[i], px = o.x + o.w / 2, py = o.y + o.h / 2;
        for (let j = i - 1; j >= 0; j--) {
          const p = objs[j];
          if (p && p.type === 'shape' && fills[j] && px >= p.x && px <= p.x + p.w && py >= p.y && py <= p.y + p.h) return fills[j];
        }
        return bg;
      };
      /* one text colour: role-mapped, then contrast-checked against the new backdrop */
      const mapText = (v, o, bOld, bNew, kind) => {
        const h = hex(v);
        if (!h) return v;
        const role = classify(h, kind || 'text');
        if (!role) return v;
        const cand = roleValue(role), fs = o.fontSize || 16, floor = (fs >= 18 || (fs >= 14 && o.bold)) ? 3 : 4.5;
        const need = Math.min(floor, contrast(h, bOld));
        if (contrast(cand, bNew) >= need - 1e-6) return cand;
        const pool = [tr.text, tr.onAccent, tr.title, tr.bg, tr.card];
        return pool.find((c) => contrast(c, bNew) >= floor) || pool.slice().sort((a, b) => contrast(b, bNew) - contrast(a, bNew))[0];
      };

      /* pass 2: text colours (object colour, inline html colours, table cells) */
      objs.forEach((o, i) => {
        if (!o) return;
        const bOld = backdrop(i, oldFill, oldBg), bNew = backdrop(i, newFill, newBg), kind = o.role === 'title' ? 'title' : 'text';
        if (typeof o.color === 'string') o.color = mapText(o.color, o, bOld, bNew, kind);
        if ((o.type === 'text' || o.type === 'shape') && typeof o.html === 'string' && /color\s*[:=]/i.test(o.html)) {
          o.html = o.html.replace(/((?:^|[;"'\s])color\s*[:=]\s*["']?)(#[0-9a-fA-F]{3,6}|rgb\([^)]*\))/gi, (m, pre, c) => pre + mapText(c, o, bOld, bNew, kind));
        }
        if (o.type === 'table' && o.cellFmt) {
          Object.keys(o.cellFmt).forEach((key) => {
            const f = o.cellFmt[key], rr = +key.split(',')[0];
            if (!f || typeof f !== 'object') return;
            const header = !!(o.headerRow && rr === 0);
            let cOld = bOld, cNew = bNew;
            if (typeof f.fill === 'string') { cOld = hex(f.fill) || cOld; f.fill = mapColor(f.fill, 'fill'); cNew = hex(f.fill) || cNew; }
            else if (!('fill' in f) && header) { cOld = hex(oldTh.accent) || cOld; cNew = tr.accent; }
            if (typeof f.color === 'string') f.color = mapText(f.color, { fontSize: f.fontSize || o.fontSize, bold: f.bold }, cOld, cNew);
          });
        }
      });
    });

    /* header / footer / slide-number colours (hex only; tokens follow the palette) */
    const hfItems = (hf) => hf && ['header', 'footer', 'numberItem', 'number'].forEach((k) => {
      const it = hf[k];
      if (it && typeof it === 'object' && typeof it.color === 'string') it.color = mapText0(it.color);
    });
    const mapText0 = (v) => { const h = hex(v); if (!h) return v; const role = classify(h, 'text'); if (!role) return v; const c = roleValue(role); return contrast(c, tr.bg) >= 3 ? c : pickOn(tr.bg, [tr.text, tr.muted]); };
    hfItems(doc.hf);
    (doc.slides || []).forEach((s) => hfItems(s.hf));

    doc.paletteId = target.id;
    doc.palette = snapshot(target);
    return true;
  }

  RPE.palettes = { ROLES, GROUPS, list, listLegacy, listTemplates, get, swatches, missingRoles, forDoc, snapshot, snapshotOf, sanitize, normalize, effectiveTheme, apply, hex, contrast, lum };
  T.theme = effectiveTheme;   // renderer/canvas/commands/exporter-parity read colours through RPE.themes.theme(doc)
})(window.RPE = window.RPE || {});
