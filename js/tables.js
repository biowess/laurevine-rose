/**
 * tables.js - Single source of truth for table geometry, cell formatting resolution,
 * border styling, and color blending. Pure module (no DOM).
 */
(function (global) {
  'use strict';

  const NAMED_COLORS = {
    black: [0, 0, 0],
    white: [255, 255, 255],
    red: [255, 0, 0],
    green: [0, 128, 0],
    blue: [0, 0, 255],
    yellow: [255, 255, 0],
    orange: [255, 165, 0],
    purple: [128, 0, 128],
    cyan: [0, 255, 255],
    magenta: [255, 0, 255],
    gray: [128, 128, 128],
    grey: [128, 128, 128]
  };

  function blendChannel(fg, a, bg) {
    return Math.floor(fg * a + bg * (1.0 - a) + 0.5);
  }

  function blend(fg, a, bg) {
    return [
      blendChannel(fg[0], a, bg[0]),
      blendChannel(fg[1], a, bg[1]),
      blendChannel(fg[2], a, bg[2])
    ];
  }

  function parseColorToRgb(color, ctx) {
    if (!color) return null;
    if (Array.isArray(color) && color.length >= 3) return [color[0], color[1], color[2]];
    if (typeof color !== 'string') return null;

    let s = color.trim().toLowerCase();
    if (s === 'none' || s === 'transparent' || s === '') return null;

    // Check theme tokens
    const th = (ctx && (ctx.th || ctx.theme)) || {};
    const tokens = {
      accent: th.accent,
      accent2: th.accent2,
      text: th.text,
      muted: th.muted,
      bg: th.bg,
      title: th.title
    };
    if (tokens[s]) {
      s = tokens[s].trim().toLowerCase();
    } else if (ctx && typeof ctx.col === 'function') {
      const resolved = ctx.col(s);
      if (resolved && resolved !== s) {
        return parseColorToRgb(resolved, null);
      }
    }

    if (NAMED_COLORS[s]) return NAMED_COLORS[s].slice();

    // rgb / rgba
    const mRgb = s.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (mRgb) {
      return [+mRgb[1], +mRgb[2], +mRgb[3]];
    }

    // hex
    if (s.startsWith('#')) s = s.slice(1);
    if (s.length === 3) {
      s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    }
    if (s.length >= 6) {
      const r = parseInt(s.slice(0, 2), 16);
      const g = parseInt(s.slice(2, 4), 16);
      const b = parseInt(s.slice(4, 6), 16);
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r, g, b];
    }

    return null;
  }

  function rgbToHex(rgb) {
    if (!rgb) return null;
    const r = Math.min(255, Math.max(0, Math.round(rgb[0])));
    const g = Math.min(255, Math.max(0, Math.round(rgb[1])));
    const b = Math.min(255, Math.max(0, Math.round(rgb[2])));
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
  }

  function computeTints(ctx) {
    const th = (ctx && (ctx.th || ctx.theme)) || {};
    const isDark = ctx && ctx.dark !== undefined ? !!ctx.dark : !!th.dark;
    const slideBgStr = (ctx && ctx.slideBg) || th.bg || '#FFFFFF';
    const bgRgb = parseColorToRgb(slideBgStr, ctx) || (isDark ? [30, 33, 40] : [255, 255, 255]);

    const bandFg = isDark ? [255, 255, 255] : [112, 45, 59];
    const bandAlpha = 0.05;

    const lineFg = isDark ? [255, 255, 255] : [0, 0, 0];
    const lineAlpha = isDark ? 0.18 : 0.14;

    const bandTint = rgbToHex(blend(bandFg, bandAlpha, bgRgb));
    const lineColor = rgbToHex(blend(lineFg, lineAlpha, bgRgb));

    return { bandTint, lineColor, isDark, slideBg: rgbToHex(bgRgb) };
  }

  function border(o, ctx) {
    const tints = computeTints(ctx);
    const tb = (o && o.tableBorder) || {};
    const width = tb.width !== undefined ? tb.width : 1;
    if (width === 0 || tb.color === null || tb.color === 'none' || tb.color === 'transparent') {
      return { width: 0, color: null };
    }
    let color = null;
    if (tb.color) {
      const rgb = parseColorToRgb(tb.color, ctx);
      color = rgb ? rgbToHex(rgb) : tints.lineColor;
    } else {
      color = tints.lineColor;
    }
    return { width, color };
  }

  function geometry(o) {
    const cells = (o && o.cells) || [];
    const rows = cells.length;
    const cols = rows ? Math.max(...cells.map((r) => (r ? r.length : 0))) : 0;
    if (rows === 0 || cols === 0) {
      return { rows: 0, cols: 0, colW: [], rowH: [] };
    }

    const ow = (o && typeof o.w === 'number' && o.w > 0) ? o.w : cols * 100;
    const oh = (o && typeof o.h === 'number' && o.h > 0) ? o.h : rows * 40;

    let colW;
    if (Array.isArray(o.colW) && o.colW.length === cols && o.colW.every((v) => typeof v === 'number' && v > 0)) {
      colW = o.colW.slice();
    } else {
      colW = Array(cols).fill(ow / cols);
    }
    const sumW = colW.reduce((a, b) => a + b, 0);
    if (sumW > 0 && Math.abs(sumW - ow) > 1e-4) {
      colW = colW.map((w) => (w * ow) / sumW);
    }

    let rowH;
    if (Array.isArray(o.rowH) && o.rowH.length === rows && o.rowH.every((v) => typeof v === 'number' && v > 0)) {
      rowH = o.rowH.slice();
    } else {
      rowH = Array(rows).fill(oh / rows);
    }
    const sumH = rowH.reduce((a, b) => a + b, 0);
    if (sumH > 0 && Math.abs(sumH - oh) > 1e-4) {
      rowH = rowH.map((h) => (h * oh) / sumH);
    }

    return { rows, cols, colW, rowH };
  }

  function resolveCell(o, r, c, ctx) {
    const th = (ctx && (ctx.th || ctx.theme)) || {};
    const ty = (ctx && (ctx.ty || ctx.type)) || {};
    const key = r + ',' + c;
    const fmt = (o && o.cellFmt && o.cellFmt[key]) || {};

    const isHeader = !!(o && o.headerRow && r === 0);
    const isBand = !!(o && o.banded && r > 0 && r % 2 === 0);
    const tints = computeTints(ctx);

    const themeAccent = rgbToHex(parseColorToRgb(th.accent || 'accent', ctx)) || '#702D3B';
    const themeText = rgbToHex(parseColorToRgb(th.text || 'text', ctx)) || '#292A2D';
    const themeBodyFont = ty.body || th.bodyFont || 'Outfit';

    // 1. Fill: cellFmt > header default > band default > table-level / theme default (none)
    let fill = null;
    if ('fill' in fmt && fmt.fill !== undefined) {
      if (fmt.fill === null || fmt.fill === 'none' || fmt.fill === 'transparent') {
        fill = null;
      } else {
        const rgb = parseColorToRgb(fmt.fill, ctx);
        fill = rgb ? rgbToHex(rgb) : null;
      }
    } else if (isHeader) {
      fill = themeAccent;
    } else if (isBand) {
      fill = tints.bandTint;
    } else {
      fill = null;
    }

    // 2. Color: cellFmt > header default > table-level key > theme default
    let color = null;
    if ('color' in fmt && fmt.color !== undefined && fmt.color !== null) {
      const rgb = parseColorToRgb(fmt.color, ctx);
      color = rgb ? rgbToHex(rgb) : themeText;
    } else if (isHeader) {
      color = th.onAccent || '#FFFFFF';   // palette on-accent text (white without a persisted palette)
    } else if (o && o.color) {
      const rgb = parseColorToRgb(o.color, ctx);
      color = rgb ? rgbToHex(rgb) : themeText;
    } else {
      color = themeText;
    }

    // 3. Font: cellFmt > table-level > theme body font
    let font = null;
    if ('font' in fmt && fmt.font) {
      font = fmt.font;
    } else if (o && o.font) {
      font = o.font;
    } else {
      font = themeBodyFont;
    }

    // 4. FontSize: cellFmt > table-level > 16
    let fontSize = 16;
    if ('fontSize' in fmt && typeof fmt.fontSize === 'number' && fmt.fontSize > 0) {
      fontSize = fmt.fontSize;
    } else if (o && typeof o.fontSize === 'number' && o.fontSize > 0) {
      fontSize = o.fontSize;
    } else {
      fontSize = 16;
    }

    // 5. Bold: cellFmt > header default (true) > table-level > false
    let bold = false;
    if ('bold' in fmt && fmt.bold !== undefined && fmt.bold !== null) {
      bold = !!fmt.bold;
    } else if (isHeader) {
      bold = true;
    } else if (o && o.bold !== undefined && o.bold !== null) {
      bold = !!o.bold;
    } else {
      bold = false;
    }

    // 6. Italic: cellFmt > table-level > false
    let italic = false;
    if ('italic' in fmt && fmt.italic !== undefined && fmt.italic !== null) {
      italic = !!fmt.italic;
    } else if (o && o.italic !== undefined && o.italic !== null) {
      italic = !!o.italic;
    } else {
      italic = false;
    }

    // 7. Underline: cellFmt > table-level > false
    let underline = false;
    if ('underline' in fmt && fmt.underline !== undefined && fmt.underline !== null) {
      underline = !!fmt.underline;
    } else if (o && o.underline !== undefined && o.underline !== null) {
      underline = !!o.underline;
    } else {
      underline = false;
    }

    // 8. Strike: cellFmt > table-level > false
    let strike = false;
    if ('strike' in fmt && fmt.strike !== undefined && fmt.strike !== null) {
      strike = !!fmt.strike;
    } else if (o && o.strike !== undefined && o.strike !== null) {
      strike = !!o.strike;
    } else {
      strike = false;
    }

    // 9. Align: cellFmt > table-level > left
    let align = 'left';
    if ('align' in fmt && fmt.align) {
      align = fmt.align;
    } else if (o && o.align) {
      align = o.align;
    } else {
      align = 'left';
    }

    // 10. vAlign: cellFmt > 'middle' (never read o.vAlign)
    let vAlign = 'middle';
    if ('vAlign' in fmt && fmt.vAlign) {
      vAlign = fmt.vAlign;
    } else {
      vAlign = 'middle';
    }

    // 11. Subscript & Superscript
    let subscript = false;
    let superscript = false;
    if ('subscript' in fmt && fmt.subscript !== undefined && fmt.subscript !== null) {
      subscript = !!fmt.subscript;
    } else if (o && o.subscript !== undefined && o.subscript !== null) {
      subscript = !!o.subscript;
    }
    if ('superscript' in fmt && fmt.superscript !== undefined && fmt.superscript !== null) {
      superscript = !!fmt.superscript;
    } else if (o && o.superscript !== undefined && o.superscript !== null) {
      superscript = !!o.superscript;
    }
    if (subscript && superscript) {
      if (fmt.subscript) superscript = false;
      else subscript = false;
    }
    const baseline = subscript ? -25000 : (superscript ? 30000 : 0);

    return {
      fill,
      color,
      font,
      fontSize,
      bold,
      italic,
      underline,
      strike,
      subscript,
      superscript,
      baseline,
      align,
      vAlign
    };
  }


  /* ---------- rectangular range model (editor selection; pure, no DOM) ----------
   * The table model has no merged cells (no span fields), so a range is always a plain rectangle.
   * A range is stored as ui.cellSel = {id, r1,c1,r2,c2 (normalized), anchorR,anchorC, focusR,focusC}. */
  const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));
  const range = {
    // anchor/focus {r,c} in any drag direction -> normalized rect clamped to the grid
    normalize(anchor, focus, rows, cols) {
      const ar = clampI(anchor.r, 0, rows - 1), ac = clampI(anchor.c, 0, cols - 1);
      const fr = clampI(focus.r, 0, rows - 1), fc = clampI(focus.c, 0, cols - 1);
      return { r1: Math.min(ar, fr), c1: Math.min(ac, fc), r2: Math.max(ar, fr), c2: Math.max(ac, fc) };
    },
    // full selection record (rect + remembered anchor/focus so a drag/shift-click can reverse direction)
    make(id, anchor, focus, rows, cols) {
      const rc = range.normalize(anchor, focus, rows, cols);
      return Object.assign({ id }, rc, {
        anchorR: clampI(anchor.r, 0, rows - 1), anchorC: clampI(anchor.c, 0, cols - 1),
        focusR: clampI(focus.r, 0, rows - 1), focusC: clampI(focus.c, 0, cols - 1)
      });
    },
    // normalized rect of a stored selection (tolerates legacy records and swapped corners)
    rect(sel, rows, cols) {
      if (!sel || !rows || !cols) return null;
      return range.normalize({ r: Math.min(sel.r1, sel.r2), c: Math.min(sel.c1, sel.c2) }, { r: Math.max(sel.r1, sel.r2), c: Math.max(sel.c1, sel.c2) }, rows, cols);
    },
    anchorOf(sel) { return { r: sel.anchorR !== undefined ? sel.anchorR : sel.r1, c: sel.anchorC !== undefined ? sel.anchorC : sel.c1 }; },
    row(id, r, rows, cols) { return range.make(id, { r, c: 0 }, { r, c: cols - 1 }, rows, cols); },
    col(id, c, rows, cols) { return range.make(id, { r: 0, c }, { r: rows - 1, c }, rows, cols); },
    all(id, rows, cols) { return range.make(id, { r: 0, c: 0 }, { r: rows - 1, c: cols - 1 }, rows, cols); },
    isSingle(rc) { return rc.r1 === rc.r2 && rc.c1 === rc.c2; },
    contains(rc, r, c) { return r >= rc.r1 && r <= rc.r2 && c >= rc.c1 && c <= rc.c2; },
    // pointer -> cell using ascending boundary arrays (n+1 values for n cells); clamps outside the grid
    cellAt(x, y, colEdges, rowEdges) {
      const idx = (v, e) => { let i = 0; for (let k = 1; k < e.length - 1; k++) if (v >= e[k]) i = k; return i; };
      return { r: idx(y, rowEdges), c: idx(x, colEdges) };
    }
  };

  /* ---------- row/column ops on a rect (mutate `o` in place, call inside S.mutate) ---------- */
  function remapFmt(o, fn) {
    if (!o.cellFmt) return;
    const out = {};
    for (const k of Object.keys(o.cellFmt)) {
      const [r, c] = k.split(',').map(Number);
      const nk = fn(r, c);
      if (nk) out[nk[0] + ',' + nk[1]] = o.cellFmt[k];
    }
    if (Object.keys(out).length) o.cellFmt = out; else delete o.cellFmt;
  }
  const ops = {
    // insert n rows after row `after` (same width, empty text); returns first new index
    insertRows(o, after, n, defH) {
      const cols = o.cells[0] ? o.cells[0].length : 0, at = after + 1, h = defH || 52;
      for (let i = 0; i < n; i++) o.cells.splice(at, 0, Array(cols).fill(''));
      if (Array.isArray(o.rowH)) o.rowH.splice(at, 0, ...Array(n).fill(h));
      o.h += n * h;
      remapFmt(o, (r, c) => [r >= at ? r + n : r, c]);
      return at;
    },
    // delete rows r1..r2 (never the last remaining row); returns number removed
    removeRows(o, r1, r2) {
      const n = Math.min(r2 - r1 + 1, o.cells.length - 1);
      if (n <= 0) return 0;
      const hd = (Array.isArray(o.rowH) ? o.rowH.slice(r1, r1 + n).reduce((a, b) => a + b, 0) : 0) || n * 52;
      o.cells.splice(r1, n);
      if (Array.isArray(o.rowH)) o.rowH.splice(r1, n);
      o.h -= hd;
      remapFmt(o, (r, c) => (r >= r1 + n ? [r - n, c] : (r >= r1 ? null : [r, c])));
      return n;
    },
    insertCols(o, after, n) {
      const cols = o.cells[0] ? o.cells[0].length : 0, at = after + 1;
      o.cells.forEach((row, i) => { for (let k = 0; k < n; k++) row.splice(at, 0, i === 0 ? 'Column ' + (cols + k + 1) : ''); });
      if (Array.isArray(o.colW)) o.colW.splice(at, 0, ...Array(n).fill(o.w / (cols + n)));   // geometry() renormalises to o.w
      remapFmt(o, (r, c) => [r, c >= at ? c + n : c]);
      return at;
    },
    removeCols(o, c1, c2) {
      const cols = o.cells[0] ? o.cells[0].length : 0, n = Math.min(c2 - c1 + 1, cols - 1);
      if (n <= 0) return 0;
      o.cells.forEach((row) => row.splice(c1, n));
      if (Array.isArray(o.colW)) o.colW.splice(c1, n);
      remapFmt(o, (r, c) => (c >= c1 + n ? [r, c - n] : (c >= c1 ? null : [r, c])));
      return n;
    }
  };

  const tablesAPI = {
    range,
    ops,
    blend,
    blendChannel,
    parseColorToRgb,
    rgbToHex,
    computeTints,
    border,
    geometry,
    resolveCell
  };

  const RPE = global.RPE = global.RPE || {};
  RPE.tables = tablesAPI;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = tablesAPI;
  }
})(typeof window !== 'undefined' ? window : global);
