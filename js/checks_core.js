/* checks_core.js — DOM-free logic behind Review > Check Accessibility and Check for Overflowing Content.
   Pure functions over the document model (no document/window access) so they can be unit-tested in node.
   Contrast: WCAG 2.x ratio of the ACTUAL text colour vs the effective backdrop (own fill, filled shapes beneath, else slide background).
   Overflow: rotated object extents (+ half the outline width) vs the slide, and text taller than its box (measured by the caller). */
(function (g) {
  'use strict';
  const C = {};
  const TOL = 2;            // px: sub-pixel / rounding tolerance for geometry
  const TEXT_TOL = 3;       // px: text taller than its box by less than this is not reported
  C.TOL = TOL; C.TEXT_TOL = TEXT_TOL;

  /* ---------- colour ---------- */
  function parseColor(c) {   // -> [r,g,b,a] or null (hex 3/4/6/8, rgb(), rgba(), 'transparent'/'none')
    if (c == null) return null; c = String(c).trim().toLowerCase();
    if (c === 'transparent' || c === 'none') return [0, 0, 0, 0];
    let m = /^#([0-9a-f]{3,8})$/.exec(c);
    if (m) {
      let x = m[1]; if (x.length === 3 || x.length === 4) x = x.split('').map((d) => d + d).join('');
      if (x.length !== 6 && x.length !== 8) return null;
      return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16), x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1];
    }
    m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map((v) => (v.endsWith('%') ? parseFloat(v) * 2.55 : parseFloat(v)));
      if (p.length < 3 || p.slice(0, 3).some((v) => !isFinite(v))) return null;
      let a = 1; if (p.length > 3) { a = /%/.test(m[1].split(/[\s,/]+/).filter(Boolean)[3]) ? p[3] / 2.55 / 100 : p[3]; }
      return [p[0], p[1], p[2], Math.max(0, Math.min(1, isFinite(a) ? a : 1))];
    }
    return null;
  }
  const over = (top, bottom) => { const a = top[3] == null ? 1 : top[3]; return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)); };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  function ratio(a, b) { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
  /* WCAG AA: large text (>= 18 pt, or >= 14 pt bold) needs 3:1, everything else 4.5:1. */
  const needed = (pt, bold) => (pt >= 18 || (bold && pt >= 14) ? 3 : 4.5);
  const hex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  Object.assign(C, { parseColor, composite: over, luminance: lum, ratio, needed, hex });

  /* ---------- text runs (DOM-free tiny HTML walker: colour / size / bold / highlight per text run) ---------- */
  const dec = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const plain = (html) => dec(String(html == null ? '' : html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  function runsOf(html) {
    const out = [], stack = [{}], re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g; let m;
    while ((m = re.exec(html || ''))) {
      if (m[4] !== undefined) { const t = dec(m[4]); if (t.trim()) out.push(Object.assign({ text: t }, stack[stack.length - 1])); continue; }
      const tag = m[2].toLowerCase(), at = m[3];
      if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
      if (/^(br|img|hr|wbr)$/.test(tag) || /\/\s*$/.test(at)) continue;
      const top = Object.assign({}, stack[stack.length - 1]);
      if (tag === 'b' || tag === 'strong') top.bold = true;
      const fc = tag === 'font' && /color\s*=\s*["']?([^"'\s>]+)/i.exec(at); if (fc) top.color = fc[1];
      const st = /style\s*=\s*"([^"]*)"|style\s*=\s*'([^']*)'/i.exec(at), css = st ? (st[1] || st[2] || '') : '';
      if (css) {
        let k = /(?:^|[;\s])color\s*:\s*([^;]+)/i.exec(css); if (k) top.color = k[1].trim();
        k = /background(?:-color)?\s*:\s*([^;]+)/i.exec(css); if (k) top.bg = k[1].trim();
        k = /font-size\s*:\s*([\d.]+)\s*(pt|px)/i.exec(css); if (k) top.size = k[2].toLowerCase() === 'pt' ? parseFloat(k[1]) : parseFloat(k[1]) * 0.75;
        k = /font-weight\s*:\s*(bold|[6-9]00)/i.exec(css); if (k) top.bold = true;
      }
      stack.push(top);
    }
    return out;
  }
  C.runsOf = runsOf; C.plain = plain;

  /* ---------- geometry ---------- */
  const isLine = (o, ctx) => o.type === 'line' || !!(ctx && ctx.isLine && ctx.isLine(o));
  const finite = (o) => ['x', 'y', 'w', 'h'].every((k) => typeof o[k] === 'number' && isFinite(o[k]));
  function corners(o) {
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2, a = (o.rotation || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [[-o.w / 2, -o.h / 2], [o.w / 2, -o.h / 2], [o.w / 2, o.h / 2], [-o.w / 2, o.h / 2]].map((p) => [cx + p[0] * c - p[1] * s, cy + p[0] * s + p[1] * c]);
  }
  /* Axis-aligned extent actually painted: rotation applied, plus half the outline width (outlines are centred on the edge). */
  function extent(o, ctx) {
    let pts, pad = 0;
    const sw = o.strokeWidth;
    if (isLine(o, ctx)) {
      const lg = ctx && ctx.lineGeom ? ctx.lineGeom(o) : { x1: o.x, y1: o.y + o.h / 2, x2: o.x + o.w, y2: o.y + o.h / 2 };
      pts = [[lg.x1, lg.y1], [lg.x2, lg.y2]];
      if (o.rotation) { const cx = o.x + o.w / 2, cy = o.y + o.h / 2, a = o.rotation * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); pts = pts.map((p) => [cx + (p[0] - cx) * c - (p[1] - cy) * s, cy + (p[0] - cx) * s + (p[1] - cy) * c]); }
      pad = (sw == null ? 3 : sw) / 2;
    } else {
      pts = corners(o);
      if (o.type === 'shape' && o.stroke) pad = (sw == null ? 2 : sw) / 2;   // text/image borders are drawn inside the box; shape outlines are centred on the edge
    }
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return { l: Math.min.apply(null, xs) - pad, r: Math.max.apply(null, xs) + pad, t: Math.min.apply(null, ys) - pad, b: Math.max.apply(null, ys) + pad };
  }
  /* Intentional bleed: a text-free shape/picture/decoration spanning the slide's full width or height (backgrounds, edge bands). */
  function isBleed(o, e, size, ctx) {
    if (isLine(o, ctx)) return false;
    if (!(o.type === 'shape' || o.type === 'image')) return false;
    if (o.type === 'shape' && plain(o.html)) return false;
    const spanW = e.l <= TOL && e.r >= size.w - TOL, spanH = e.t <= TOL && e.b >= size.h - TOL;
    return spanW || spanH || (o.slot === 'deco' && o.type === 'shape');
  }
  function offSlide(o, size, ctx) {
    if (!finite(o) && !isLine(o, ctx)) return null;
    const e = extent(o, ctx); if (![e.l, e.r, e.t, e.b].every(isFinite)) return null;
    if (isBleed(o, e, size, ctx)) return null;
    const r = { left: -e.l, right: e.r - size.w, top: -e.t, bottom: e.b - size.h };
    const sides = Object.keys(r).filter((k) => r[k] > TOL).map((k) => ({ side: k, px: Math.round(r[k]) }));
    const outside = e.r <= 0 || e.l >= size.w || e.b <= 0 || e.t >= size.h;
    return sides.length ? { sides, outside } : null;
  }
  Object.assign(C, { corners, extent, offSlide, isBleed });

  const defaultNameOf = (o) => (o.name || o.type);
  function overflowFindings(doc, measure, ctx) {
    ctx = ctx || {}; const nameOf = ctx.nameOf || defaultNameOf, out = [];
    doc.slides.forEach((s, i) => {
      s.objects.forEach((o) => {
        const r = offSlide(o, doc.size, ctx); if (!r) return;
        const where = r.outside ? 'lies completely outside the slide' : 'extends past the ' + r.sides.map((x) => `${x.side} edge by ${x.px} px`).join(' and ');
        out.push({ slide: i, id: s.id, obj: o.id, cat: 'Off the slide', text: `${nameOf(o)} ${where}${o.rotation ? ` (rotated ${Math.round(o.rotation)}°)` : ''}. Move or resize it inside the slide.` });
      });
      (measure ? measure(s) : []).forEach((m) => {
        const o = s.objects.find((x) => x.id === m.id); if (!o || m.over <= TEXT_TOL) return;
        out.push({ slide: i, id: s.id, obj: o.id, cat: 'Text overflow', text: `${nameOf(o)} runs about ${m.over} px past the bottom of its box. Shorten the text, enlarge the box or reduce the font size.` });
      });
    });
    return out;
  }
  C.overflowFindings = overflowFindings;

  /* ---------- effective backdrop ---------- */
  const SIMPLE = { rect: 1, rounded: 1, ellipse: 1 };
  function contains(o, px, py) {
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2, a = -(o.rotation || 0) * Math.PI / 180, dx = px - cx, dy = py - cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) > o.w / 2 || Math.abs(ly) > o.h / 2) return false;
    return o.shape === 'ellipse' ? (lx * lx) / ((o.w / 2) * (o.w / 2) || 1) + (ly * ly) / ((o.h / 2) * (o.h / 2) || 1) <= 1 : true;
  }
  /* Colour behind the text of slide.objects[idx], sampled at the box centre. Returns {rgb|null, source}; rgb null = cannot be determined. */
  function backdrop(slide, idx, ctx) {
    const bgc = parseColor(ctx.col(slide.bg) || ctx.th.bg);
    if (!bgc) return { rgb: null, source: 'slide background' };
    let cur = over(bgc, [255, 255, 255]), source = 'the slide background';
    const t = slide.objects[idx], px = t.x + t.w / 2, py = t.y + t.h / 2;
    for (let j = 0; j <= idx; j++) {
      const o = slide.objects[j]; if (!finite(o) || isLine(o, ctx) || !contains(o, px, py)) continue;
      if (['image', 'plot', 'figure', 'table'].includes(o.type)) { cur = null; source = 'a picture or table'; continue; }
      if ((o.type !== 'text' && o.type !== 'shape') || !o.fill) continue;
      const f = parseColor(ctx.col(o.fill)); if (!f) { cur = null; source = 'an unrecognised fill'; continue; }
      if (f[3] === 0) continue;
      if (j < idx && o.type === 'shape' && !SIMPLE[o.shape || 'rect']) { cur = null; source = 'an irregular shape'; continue; }
      if (cur === null && f[3] < 1) continue;
      cur = cur === null ? f.slice(0, 3) : over(f, cur); source = j === idx ? 'its own fill' : 'the fill of a shape behind it';
    }
    return { rgb: cur, source };
  }

  function contrastFor(slide, idx, ctx) {
    const o = slide.objects[idx], runs = runsOf(o.html); if (!runs.length) return null;
    const th = ctx.th, role = o.role, base = ctx.col(o.color) || (role === 'title' ? th.title : (role === 'caption' || role === 'subtitle' || role === 'footnote') ? th.muted : th.text);
    const bd = backdrop(slide, idx, ctx); if (!bd.rgb) return { unchecked: true, source: bd.source };
    let worst = null;
    runs.forEach((r) => {
      let bg = bd.rgb, src = bd.source;
      if (r.bg) { const hb = parseColor(ctx.col(r.bg)); if (hb && hb[3] > 0) { bg = over(hb, bg); src = 'its highlight'; } }
      const fc = parseColor(ctx.col(r.color) || base); if (!fc) return;
      const fg = over(fc, bg), pt = r.size || o.fontSize || 18, bold = !!(r.bold || o.bold === true), need = needed(pt, bold), rt = ratio(fg, bg);
      if (!worst || rt / need < worst.ratio / worst.need) worst = { ratio: rt, need, pt, fg, bg, src, large: need === 3 };
    });
    return worst;
  }

  /* ---------- accessibility ---------- */
  const BODYISH = (o) => ['image', 'plot', 'figure', 'table'].includes(o.type) || (o.type === 'text' && o.role === 'body' && plain(o.html));
  function accessibilityFindings(doc, ctx) {
    const nameOf = ctx.nameOf || defaultNameOf, out = []; out.unchecked = [];
    doc.slides.forEach((s, i) => {
      const add = (o, cat, text, fix) => out.push({ slide: i, id: s.id, obj: o && o.id, cat, text, fix });
      const ti = s.objects.findIndex((o) => o.role === 'title'), title = ti >= 0 ? s.objects[ti] : null;
      if (!title || !plain(title.html)) add(title, 'Missing title', 'Slide has no title. Screen readers use titles to navigate.');
      else { const first = s.objects.findIndex((o, k) => k < ti && BODYISH(o)); if (first >= 0) add(title, 'Reading order', `The title is read after ${nameOf(s.objects[first])}. Screen readers follow stacking order, so change the order so the title comes first.`); }
      s.objects.forEach((o, k) => {
        if ((o.type === 'plot' || o.type === 'figure' || (o.type === 'image' && o.src)) && !(o.alt || '').trim()) add(o, 'Missing alt text', `${nameOf(o)} has no alternative text.`, 'alt');
        if ((o.type !== 'text' && o.type !== 'shape') || isLine(o, ctx) || !plain(o.html) || !finite(o)) return;
        const r = contrastFor(s, k, ctx); if (!r) return;
        if (r.unchecked) { out.unchecked.push({ slide: i, id: s.id, obj: o.id, text: `${nameOf(o)} sits over ${r.source}.` }); return; }
        if (r.ratio < r.need - 0.005) add(o, 'Low contrast', `${nameOf(o)}: text ${hex(r.fg)} on ${hex(r.bg)} (${r.src}) is ${r.ratio.toFixed(2)}:1; ${r.large ? 'large text' : 'normal text'} (${Math.round(r.pt * 10) / 10} pt) needs ${r.need}:1.`);
      });
    });
    return out;
  }
  C.accessibilityFindings = accessibilityFindings;

  g.RPE = g.RPE || {}; g.RPE.checksCore = C;
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
})(typeof window !== 'undefined' ? window : global);
