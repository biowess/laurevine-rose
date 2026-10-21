/**
 * js/templates/builder.js
 * Shared helper layer for constructing native, editable slide objects for Academic Templates.
 */
(function (global) {
  'use strict';

  const RPE = global.RPE = global.RPE || {};
  RPE.templates = RPE.templates || {};

  function uid(p) {
    if (RPE.store && RPE.store.uid) return RPE.store.uid(p);
    return (p || 'o') + '_' + Math.random().toString(36).slice(2, 8);
  }

  function P(...lines) {
    return lines.map((l) => `<p>${l}</p>`).join('');
  }

  function slide(layout, objects, notes, bg) {
    const s = {
      id: uid('s'),
      layout: layout || 'titleContent',
      notes: notes || '',
      objects: Array.isArray(objects) ? objects : []
    };
    if (bg) s.bg = bg;
    return s;
  }

  function textBox(role, x, y, w, h, html, opts) {
    opts = opts || {};
    return Object.assign({
      id: uid('o'),
      type: 'text',
      role: role || 'body',
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
      html: typeof html === 'string' ? html : P(...(Array.isArray(html) ? html : [String(html || '')])),
      fontSize: opts.fontSize || 18,
      align: opts.align || 'left',
      vAlign: opts.vAlign || 'top',
      lineHeight: opts.lineHeight != null ? opts.lineHeight : 1.25,
      color: opts.color || null,
      font: opts.font || null,
      bold: opts.bold != null ? opts.bold : null,
      italic: opts.italic != null ? opts.italic : null,
      list: opts.list || null
    }, opts.extra || {});
  }

  function shape(shapeType, x, y, w, h, opts) {
    opts = opts || {};
    return Object.assign({
      id: uid('o'),
      type: 'shape',
      shape: shapeType || 'rect',
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
      fill: opts.fill != null ? opts.fill : 'transparent',
      stroke: opts.stroke != null ? opts.stroke : 'transparent',
      strokeWidth: opts.strokeWidth != null ? opts.strokeWidth : 1,
      html: opts.html != null ? (typeof opts.html === 'string' ? opts.html : P(...opts.html)) : '',
      fontSize: opts.fontSize || 16,
      align: opts.align || 'center',
      vAlign: opts.vAlign || 'middle',
      color: opts.color || null,
      font: opts.font || null,
      lineHeight: opts.lineHeight != null ? opts.lineHeight : 1.2
    }, opts.extra || {});
  }

  function table(x, y, w, h, cells, opts) {
    opts = opts || {};
    const rawCells = [];
    const cellFmt = Object.assign({}, opts.cellFmt || {});

    (cells || [['Header 1', 'Header 2'], ['Value 1', 'Value 2']]).forEach((row, r) => {
      const rawRow = [];
      (row || []).forEach((cell, c) => {
        if (cell && typeof cell === 'object') {
          rawRow.push(cell.text != null ? String(cell.text) : '');
          const fmt = Object.assign({}, cell);
          delete fmt.text;
          if (Object.keys(fmt).length > 0) {
            cellFmt[`${r},${c}`] = fmt;
          }
        } else {
          rawRow.push(cell != null ? String(cell) : '');
        }
      });
      rawCells.push(rawRow);
    });

    const obj = {
      id: uid('o'),
      type: 'table',
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
      cells: rawCells,
      headerRow: opts.headerRow != null ? opts.headerRow : true,
      banded: opts.banded != null ? opts.banded : true,
      fontSize: opts.fontSize || 16,
      caption: opts.caption || ''
    };
    if (Object.keys(cellFmt).length > 0) {
      obj.cellFmt = cellFmt;
    }
    return Object.assign(obj, opts.extra || {});
  }

  function figure(x, y, w, h, name, opts) {
    opts = opts || {};
    return Object.assign({
      id: uid('o'),
      type: 'image',
      role: 'figure',
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
      name: name || 'Scientific Figure',
      alt: opts.alt || name || '',
      src: opts.src || null,
      aspect: opts.aspect || (w / h)
    }, opts.extra || {});
  }

  function rule(x, y, w, h, color) {
    return shape('rect', x, y, w, h, {
      fill: color || 'accent',
      stroke: 'transparent',
      strokeWidth: 0
    });
  }

  function card(x, y, w, h, opts) {
    opts = opts || {};
    return shape(opts.shape || 'rect', x, y, w, h, {
      fill: opts.fill || 'surface',
      stroke: opts.stroke || 'border',
      strokeWidth: opts.strokeWidth != null ? opts.strokeWidth : 1,
      html: opts.html || '',
      fontSize: opts.fontSize || 16,
      color: opts.color || null,
      align: opts.align || 'left',
      vAlign: opts.vAlign || 'top',
      extra: opts.extra || {}
    });
  }

  function arrow(x, y, w, h, fill) {
    return shape('arrow', x, y, w, h, {
      fill: fill || 'accent',
      stroke: 'transparent',
      strokeWidth: 0
    });
  }

  function badge(x, y, w, h, text, opts) {
    opts = opts || {};
    return shape('rounded', x, y, w, h, {
      fill: opts.fill || 'surface',
      stroke: opts.stroke || 'transparent',
      strokeWidth: opts.strokeWidth != null ? opts.strokeWidth : 0,
      html: P(text),
      fontSize: opts.fontSize || 13,
      bold: opts.bold != null ? opts.bold : true,
      color: opts.color || '#FFFFFF',
      font: opts.font || null,
      align: 'center',
      vAlign: 'middle'
    });
  }

  RPE.templates.builder = {
    uid,
    P,
    slide,
    textBox,
    shape,
    table,
    figure,
    rule,
    card,
    arrow,
    badge
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RPE.templates.builder;
  }
})(typeof window !== 'undefined' ? window : global);
