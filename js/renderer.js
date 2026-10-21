/* renderer.js — turns document state into DOM.
   The same functions draw the editing canvas, thumbnails, the sorter and Present mode.
   A slide is rendered at its logical size (doc.size, 1280×720 by default) and scaled with CSS transform. */
(function (RPE) {
  'use strict';
  const T = RPE.themes;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function context(doc) {
    const th = T.theme(doc), pal = T.palette(doc), ty = T.type(doc);
    const tok = { accent: th.accent, accent2: th.accent2, text: th.text, muted: th.muted, bg: th.bg, title: th.title };
    ['surface', 'border', 'card', 'onAccent'].forEach((k) => { if (th[k]) tok[k] = th[k]; });   // present only with a persisted palette
    return {
      doc, th, pal, ty,
      col: (c) => (!c ? null : (tok[c] || c)),
    };
  }

  const IMG_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>';
  const figMissing = (o) => `<div class="img-ph img-ph--figure" role="note">${IMG_ICON}<strong>${esc(o.name || 'Figure')}</strong><span>Figure not rendered. Open the figure editor and apply it to render it.</span></div>`;
  /* Plots and figures are always pictures: the backend-rendered PNG in `src`, or an explicit neutral placeholder (never a chart). */
  const figPicture = (o, p) => { if (o.src) { const im = document.createElement('img'); im.src = o.src; im.alt = o.alt || ''; im.draggable = false; p.appendChild(im); } else p.innerHTML = figMissing(o); };

  function setGeom(el, o) {
    el.style.left = o.x + 'px';
    el.style.top = o.y + 'px';
    el.style.width = Math.max(0, o.w) + 'px';
    el.style.height = Math.max(0, o.h) + 'px';
    if (o.rotation) {
      el.style.transform = `rotate(${o.rotation}deg)`;
    } else {
      el.style.transform = '';
    }
    if (el.classList.contains('obj--shape')) {
      if ((o.h != null && o.h < 12) || (!o.text && !o.html)) {
        el.style.paddingTop = '0px';
        el.style.paddingBottom = '0px';
      } else {
        el.style.removeProperty('padding-top');
        el.style.removeProperty('padding-bottom');
      }
      if ((o.w != null && o.w < 20) || (!o.text && !o.html)) {
        el.style.paddingLeft = '0px';
        el.style.paddingRight = '0px';
      } else {
        el.style.removeProperty('padding-left');
        el.style.removeProperty('padding-right');
      }
      const tb = el.querySelector('.obj__text');
      if (tb && !o.text && !o.html && ((o.h != null && o.h < 12) || (o.w != null && o.w < 20))) {
        tb.style.display = 'none';
      } else if (tb && (o.text || o.html || (o.h >= 12 && o.w >= 20))) {
        tb.style.display = '';
      }
    }
    if (RPE.shapes && RPE.shapes.isLine(o)) {
      const geom = RPE.shapes.lineGeometry(o);
      const line = el.querySelector('.shape-gfx--line svg line');
      if (line) {
        line.setAttribute('x1', String(geom.x1 - geom.x));
        line.setAttribute('y1', String(geom.y1 - geom.y));
        line.setAttribute('x2', String(geom.x2 - geom.x));
        line.setAttribute('y2', String(geom.y2 - geom.y));
      }
    }
  }

  function textStyles(el, o, cx) {
    const isTitle = o.role === 'title';
    const muted = o.role === 'subtitle' || o.role === 'caption' || o.role === 'footnote';
    const rs = RPE.typography ? RPE.typography.roleStyle(cx.ty, o) : { font: isTitle ? cx.ty.head : cx.ty.body };   // role defaults of the active typography preset
    el.style.fontFamily = T.cssFont(o.font || rs.font);
    el.style.fontSize = (o.fontSize || 18) + 'pt';
    el.style.fontWeight = o.bold === true ? 700 : o.bold === false ? 400 : (rs.bold === true ? 700 : rs.bold === false ? 400 : (isTitle ? 600 : 400));
    el.style.fontStyle = (o.italic === true || (o.italic == null && rs.italic === true)) ? 'italic' : 'normal';
    el.style.textDecoration = [o.underline && 'underline', o.strike && 'line-through'].filter(Boolean).join(' ') || 'none';
    el.style.color = cx.col(o.color) || (isTitle ? cx.th.title : muted ? cx.th.muted : cx.th.text);
    el.style.textAlign = o.align || (o.type === 'shape' ? 'center' : 'left');
    if (o.subscript) el.style.verticalAlign = 'sub';
    else if (o.superscript) el.style.verticalAlign = 'super';
    el.style.lineHeight = (o.lineHeight || 1.2) * 1.2;
    el.style.justifyContent = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[o.vAlign || 'top'];
  }

  function updateParaStruts(root, baseSize) {
    baseSize = baseSize || 18;
    root.querySelectorAll('p').forEach((p) => {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let n, hasText = false, allSized = true, maxRunSize = 0;
      while ((n = walker.nextNode())) {
        if (!n.nodeValue.length) continue;
        hasText = true;
        const sp = n.parentElement.closest('span[style*="font-size"]');
        if (sp && sp.style.fontSize) {
          const sz = parseFloat(sp.style.fontSize);
          if (sz > maxRunSize) maxRunSize = sz;
        } else {
          allSized = false;
        }
      }
      if (hasText && allSized && maxRunSize > 0 && maxRunSize < baseSize) {
        p.style.fontSize = maxRunSize + 'pt';
      } else if (!allSized && p.style.fontSize && parseFloat(p.style.fontSize) < baseSize) {
        p.style.fontSize = '';
      }
    });
    updateParaMarkers(root);
  }

  function updateParaMarkers(root) {
    if (!root) return;
    root.querySelectorAll('p, li').forEach((p) => {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let n, firstText = null;
      while ((n = walker.nextNode())) {
        if (n.nodeValue && n.nodeValue.trim().length > 0) {
          firstText = n;
          break;
        }
      }
      if (!firstText) {
        const w2 = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        firstText = w2.nextNode();
      }

      let font = '', size = '', color = '';
      let cur = firstText ? firstText.parentElement : p;
      while (cur && cur !== p.parentElement) {
        if (!font) {
          if (cur.style && cur.style.fontFamily) font = cur.style.fontFamily;
          else if (cur.getAttribute && cur.getAttribute('face')) font = cur.getAttribute('face');
        }
        if (!size) {
          if (cur.style && cur.style.fontSize) size = cur.style.fontSize;
          else if (cur.getAttribute && cur.getAttribute('size')) size = cur.getAttribute('size');
        }
        if (!color) {
          if (cur.style && cur.style.color) color = cur.style.color;
          else if (cur.getAttribute && cur.getAttribute('color')) color = cur.getAttribute('color');
        }
        if (cur === p) break;
        cur = cur.parentElement;
      }

      if (font) p.style.setProperty('--mk-font', font);
      else p.style.removeProperty('--mk-font');

      if (size) p.style.setProperty('--mk-size', size);
      else p.style.removeProperty('--mk-size');

      if (color) p.style.setProperty('--mk-color', color);
      else p.style.removeProperty('--mk-color');
    });
  }

  function textBlock(o, cx, opts) {
    const t = document.createElement('div');
    t.className = 'obj__text';
    t.innerHTML = o.html || '';
    updateParaStruts(t, o.fontSize || 18);
    updateParaMarkers(t);
    t.dataset.list = o.list || '';
    t.style.textAlign = o.align || (o.type === 'shape' ? 'center' : 'left');
    if (o.indent) t.style.paddingLeft = (o.indent * 48) + 'px';
    t.style.setProperty('--para-gap', (o.spaceAfter || 0) + 'pt');
    if (opts.mode === 'edit') {
      t.dataset.prompt = T.PROMPTS[o.slot] || T.PROMPTS[o.role] || (o.type === 'shape' ? '' : 'Type here');
      if (!t.textContent.trim()) t.classList.add('is-empty');
    }
    return t;
  }

  /* Build the SVG path for a shape. Thin wrapper returning an SVG path fragment string. */
  function shapePath(k, adj) {
    const cmds = RPE.shapes.commands(k, adj);
    const d = RPE.shapes.toD(cmds);
    return `<path d="${d}"${RPE.shapes.strokeOnly(k) ? ' fill="none"' : ''}/>`;
  }

  function lineGfx(o, cx) {
    const geom = (RPE.shapes && RPE.shapes.lineGeometry)
      ? RPE.shapes.lineGeometry(o)
      : { x1: o.x, y1: o.y, x2: o.x + o.w, y2: o.y + o.h, x: o.x, y: o.y, w: o.w, h: o.h };
    const stroke = cx.col(o.stroke) || (cx.th && cx.th.accent) || '#000000';
    const sw = o.strokeWidth == null ? 3 : o.strokeWidth;
    const opacity = o.opacity != null ? o.opacity : 1;
    const lx1 = geom.x1 - geom.x;
    const ly1 = geom.y1 - geom.y;
    const lx2 = geom.x2 - geom.x;
    const ly2 = geom.y2 - geom.y;

    const d = document.createElement('div');
    d.className = 'shape-gfx shape-gfx--line';
    d.style.position = 'absolute';
    d.style.inset = '0';
    d.style.pointerEvents = 'none';
    if (opacity !== 1) d.style.opacity = String(opacity);

    d.innerHTML = `<svg style="position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible" aria-hidden="true"><line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/></svg>`;
    return d;
  }

  function shapeGfx(o, cx) {
    if (RPE.shapes && RPE.shapes.isLine(o)) {
      return lineGfx(o, cx);
    }

    const fill = cx.col(o.fill) || 'transparent';
    const stroke = cx.col(o.stroke) || 'transparent';
    const sw = o.strokeWidth == null ? 2 : o.strokeWidth;
    const k = o.shape || 'rect';

    // CSS-only shapes (rect, rounded, ellipse) with centered outlines
    if (k === 'rect' || k === 'rounded' || k === 'ellipse') {
      const d = document.createElement('div'); d.className = 'shape-gfx';
      d.style.background = fill;
      const hasStroke = stroke && stroke !== 'transparent' && sw > 0;
      if (hasStroke) {
        d.style.inset = `${-sw / 2}px`;
        d.style.border = `${sw}px solid ${stroke}`;
        if (k === 'ellipse') {
          d.style.borderRadius = '50%';
        } else if (k === 'rounded') {
          const maxR = Math.min(o.w || 0, o.h || 0) / 2;
          const r = Math.min(maxR, o.cornerRadius || 16);
          d.style.borderRadius = `${r + sw / 2}px`;
        } else {
          d.style.borderRadius = '0';
        }
      } else {
        d.style.inset = '0';
        d.style.border = 'none';
        if (k === 'ellipse') {
          d.style.borderRadius = '50%';
        } else if (k === 'rounded') {
          const maxR = Math.min(o.w || 0, o.h || 0) / 2;
          const r = Math.min(maxR, o.cornerRadius || 16);
          d.style.borderRadius = `${r}px`;
        } else {
          d.style.borderRadius = '0';
        }
      }
      return d;
    }

    const strokeOnly = RPE.shapes.strokeOnly(k);
    const effectiveStroke = (strokeOnly && stroke === 'transparent') ? cx.th.accent : stroke;
    const effectiveSw = strokeOnly ? Math.max(sw, 2) : sw;
    const w = o.w || 100;
    const h = o.h || 100;
    const cmds = RPE.shapes.commands(k, o.adj);
    const pathD = RPE.shapes.toD(cmds, w, h);

    const d = document.createElement('div'); d.className = 'shape-gfx';
    d.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" overflow="visible" aria-hidden="true"><path d="${pathD}" fill="${strokeOnly ? 'none' : fill}" stroke="${effectiveStroke}" stroke-width="${effectiveSw}" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
    return d;
  }

  function tableEl(o, cx, opts) {
    const tblCtx = Object.assign({}, cx, {
      slideBg: (opts && opts.slideBg) || (cx && cx.th && cx.th.bg) || '#FFFFFF',
      dark: cx && cx.th && cx.th.dark !== undefined ? cx.th.dark : false
    });
    const geom = RPE.tables.geometry(o);
    const borderInfo = RPE.tables.border(o, tblCtx);
    const borderCss = (borderInfo.width > 0 && borderInfo.color)
      ? `${borderInfo.width}px solid ${borderInfo.color}`
      : 'none';

    const tb = document.createElement('table');
    tb.className = 'obj-table';
    tb.style.tableLayout = 'fixed';
    tb.style.borderCollapse = 'collapse';
    tb.style.width = (o.w || 100) + 'px';
    tb.style.boxSizing = 'border-box';

    const cg = document.createElement('colgroup');
    geom.colW.forEach((cw) => {
      const col = document.createElement('col');
      col.style.width = cw + 'px';
      cg.appendChild(col);
    });
    tb.appendChild(cg);

    const body = document.createElement('tbody');
    (o.cells || []).forEach((row, r) => {
      const tr = document.createElement('tr');
      const rh = geom.rowH[r] || 40;
      row.forEach((c, ci) => {
        const head = o.headerRow && r === 0;
        const cell = document.createElement(head ? 'th' : 'td');
        const resolved = RPE.tables.resolveCell(o, r, ci, tblCtx);
        if (typeof c === 'string' && (c.includes('<sub') || c.includes('<sup') || c.includes('vertical-align'))) {
          cell.innerHTML = c;
        } else if (resolved.subscript) {
          cell.innerHTML = `<sub>${U.esc(c)}</sub>`;
        } else if (resolved.superscript) {
          cell.innerHTML = `<sup>${U.esc(c)}</sup>`;
        } else {
          cell.textContent = c;
        }
        cell.dataset.r = r;
        cell.dataset.c = ci;
        cell.style.boxSizing = 'border-box';
        cell.style.height = rh + 'px';
        cell.style.padding = '4px 10px';
        cell.style.border = borderCss;
        if (resolved.fill) {
          cell.style.backgroundColor = resolved.fill;
        } else {
          cell.style.backgroundColor = 'transparent';
        }
        cell.style.color = resolved.color;
        cell.style.fontFamily = T.cssFont(resolved.font);
        cell.style.fontSize = resolved.fontSize + 'pt';
        cell.style.fontWeight = resolved.bold ? '700' : '400';
        cell.style.fontStyle = resolved.italic ? 'italic' : 'normal';
        const dec = [resolved.underline && 'underline', resolved.strike && 'line-through'].filter(Boolean).join(' ') || 'none';
        cell.style.textDecoration = dec;
        cell.style.textAlign = resolved.align;
        cell.style.verticalAlign = resolved.vAlign;
        cell.style.lineHeight = '1.2';

        tr.appendChild(cell);
      });
      body.appendChild(tr);
    });
    tb.appendChild(body);
    return tb;
  }


  /* ---------- image adjustments (brightness, contrast, saturation, grayscale, tint, crop) ----------
     o.imgAdj = { brightness, contrast, saturation, grayscale, tintColor, tintAmount, cropL, cropR, cropT, cropB }
     All values are optional / default to 0 (no effect).
       brightness: -100..+100 (maps to CSS brightness 0..2, 0=neutral at value 0)
       contrast:   -100..+100 (CSS contrast 0..2)
       saturation: -100..+100 (CSS saturate 0..2; -100 = grayscale; separate from grayscale flag)
       grayscale:  0..1 (CSS grayscale)
       tintColor:  hex/CSS color string
       tintAmount: 0..1 (opacity of tint overlay)
       cropL/cropR/cropT/cropB: 0..1 fractions (how much to crop from each edge)
  */
  function buildImageFilter(adj) {
    if (!adj) return '';
    const parts = [];
    if (adj.brightness != null && adj.brightness !== 0) {
      parts.push(`brightness(${(1 + adj.brightness / 100).toFixed(3)})`);
    }
    if (adj.contrast != null && adj.contrast !== 0) {
      parts.push(`contrast(${(1 + adj.contrast / 100).toFixed(3)})`);
    }
    if (adj.saturation != null && adj.saturation !== 0) {
      parts.push(`saturate(${Math.max(0, 1 + adj.saturation / 100).toFixed(3)})`);
    }
    if (adj.grayscale != null && adj.grayscale > 0) {
      parts.push(`grayscale(${Math.min(1, adj.grayscale).toFixed(3)})`);
    }
    return parts.join(' ');
  }

  /* Apply (or re-apply) image adjustments to an already-constructed .obj--image element. */
  function applyImageAdj(el, o, cx) {
    const adj = o.imgAdj || {};
    const cL = Math.max(0, Math.min(0.99, adj.cropL || 0));
    const cR = Math.max(0, Math.min(0.99, adj.cropR || 0));
    const cT = Math.max(0, Math.min(0.99, adj.cropT || 0));
    const cB = Math.max(0, Math.min(0.99, adj.cropB || 0));
    const hasCrop = cL > 0 || cR > 0 || cT > 0 || cB > 0;
    const filterStr = buildImageFilter(adj);
    const hasTint = adj.tintColor && adj.tintAmount > 0;

    if (o.src) {
      if (hasCrop) {
        /* Crop: wrap in an overflow:hidden container; stretch the image beyond its natural size */
        el.style.overflow = 'hidden';
        el.style.position = 'relative';
        const im = document.createElement('img');
        im.src = o.src; im.alt = o.alt || ''; im.draggable = false;
        /* The inner img is positioned to show only the non-cropped region */
        const visW = 1 - cL - cR, visH = 1 - cT - cB;
        im.style.position = 'absolute';
        im.style.left = (-cL / visW * 100) + '%';
        im.style.top  = (-cT / visH * 100) + '%';
        im.style.width  = (100 / visW) + '%';
        im.style.height = (100 / visH) + '%';
        im.style.objectFit = 'fill';
        if (filterStr) im.style.filter = filterStr;
        el.appendChild(im);
      } else {
        const im = document.createElement('img');
        im.src = o.src; im.alt = o.alt || ''; im.draggable = false;
        if (filterStr) im.style.filter = filterStr;
        el.appendChild(im);
      }
      if (hasTint) {
        const tint = document.createElement('div');
        tint.className = 'img-tint';
        tint.setAttribute('aria-hidden', 'true');
        tint.style.cssText = `position:absolute;inset:0;background:${cx.col(adj.tintColor) || adj.tintColor};opacity:${Math.min(1, adj.tintAmount)};pointer-events:none;`;
        el.style.position = 'relative';
        el.appendChild(tint);
      }
    } else {
      const ph = document.createElement('div');
      ph.className = 'img-ph';
      ph.innerHTML = `${IMG_ICON}<strong>${esc(o.name || 'Image')}</strong><span>Image placeholder</span>`;
      el.appendChild(ph);
    }
  }

  /* Re-apply adjustments to an existing .obj--image DOM element (live preview without full rebuild). */
  function updateImageAdj(el, o, cx) {
    /* Simplest path: discard children and re-apply (element stays, so selection overlay is not affected). */
    while (el.firstChild) el.removeChild(el.firstChild);
    el.style.overflow = '';
    el.style.position = '';
    if (o.stroke && o.strokeWidth) el.style.border = `${o.strokeWidth}px solid ${cx.col(o.stroke)}`;
    applyImageAdj(el, o, cx);
  }

  /* Build one object element. opts.mode: 'edit' | 'thumb' | 'present' | 'measure' */
  function objectEl(o, cx, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = `obj obj--${o.type}`;
    el.dataset.id = o.id; el.dataset.type = o.type; if (o.role) el.dataset.role = o.role;
    setGeom(el, o);
    if (o.type === 'text') {
      textStyles(el, o, cx);
      if (o.fill) el.style.background = cx.col(o.fill);
      if (o.stroke) el.style.border = `${o.strokeWidth || 1}px solid ${cx.col(o.stroke)}`;
      el.appendChild(textBlock(o, cx, opts));
    } else if (o.type === 'shape' || o.type === 'line') {
      const isLine = RPE.shapes && RPE.shapes.isLine(o);
      if (isLine) el.classList.add('obj--line');
      textStyles(el, Object.assign({ vAlign: 'middle', align: 'center' }, o), cx);
      el.appendChild(isLine ? lineGfx(o, cx) : shapeGfx(o, cx));
      const tb = textBlock(o, cx, Object.assign({}, opts, { mode: opts.mode === 'edit' ? 'edit' : opts.mode }));
      if (!o.text && !o.html && ((o.h != null && o.h < 12) || (o.w != null && o.w < 20))) {
        tb.style.display = 'none';
      }
      el.appendChild(tb);
      if ((o.h != null && o.h < 12) || (!o.text && !o.html)) {
        el.style.paddingTop = '0px';
        el.style.paddingBottom = '0px';
      }
      if ((o.w != null && o.w < 20) || (!o.text && !o.html)) {
        el.style.paddingLeft = '0px';
        el.style.paddingRight = '0px';
      }
    } else if (o.type === 'image') {
      if (o.stroke && o.strokeWidth) el.style.border = `${o.strokeWidth}px solid ${cx.col(o.stroke)}`;
      el.setAttribute('role', 'img'); el.setAttribute('aria-label', o.alt || o.name || 'Image');
      applyImageAdj(el, o, cx);
    } else if (o.type === 'plot') {
      el.setAttribute('role', 'img'); el.setAttribute('aria-label', o.alt || ('Plot' + (o.title ? ': ' + o.title : '')));
      el.dataset.engine = o.engine || 'python';
      const p = document.createElement('div'); p.className = 'obj__plot';
      figPicture(o, p);
      el.appendChild(p);
    } else if (o.type === 'figure') {
      el.setAttribute('role', 'img'); el.setAttribute('aria-label', o.alt || 'Multi-panel figure');
      const p = document.createElement('div'); p.className = 'obj__plot';
      figPicture(o, p);
      el.appendChild(p);
    } else if (o.type === 'table') {
      el.appendChild(tableEl(o, cx, opts));
    }
    return el;
  }

  function decor(th, layoutId, size) {
    const frag = document.createDocumentFragment(), isTitle = layoutId === 'title' || layoutId === 'section';
    const add = (css) => { const d = document.createElement('div'); d.className = 'decor'; d.style.cssText = css; frag.appendChild(d); };
    if (th.decor === 'rule') {
      if (isTitle) { add(`left:0;top:0;width:30px;height:100%;background:${th.accent}`); add(`left:30px;top:0;width:6px;height:100%;background:${th.accent2}`); }
      else add(`left:${Math.round(size.w * .05)}px;top:30px;width:56px;height:4px;background:${th.accent}`);
    } else if (th.decor === 'topbar') {
      add(`left:0;top:0;width:100%;height:${isTitle ? 36 : 12}px;background:${th.accent}`);
      if (isTitle) add(`left:0;bottom:0;width:100%;height:4px;background:${th.accent2}`);
    } else if (th.decor === 'footer') {
      if (isTitle) add(`left:0;bottom:0;width:100%;height:10px;background:${th.accent}`);
      else add(`left:${Math.round(size.w * .05)}px;bottom:46px;width:${Math.round(size.w * .9)}px;height:1px;background:${th.muted};opacity:.5`);
    }
    return frag;
  }

  /* Header / footer region (see js/headerfooter.js). Not an `.obj`: it cannot be selected, moved or resized, and slide objects
     drawn on top of it keep receiving the clicks. `o` is the render object from RPE.hf.view (or the live proxy). */
  function hfEl(o, cx, opts) {
    const el = document.createElement('div');
    el.className = 'hf hf--' + o.hf; el.dataset.id = o.id; el.dataset.hf = o.hf;
    el.style.left = o.x + 'px'; el.style.top = o.y + 'px'; el.style.width = o.w + 'px'; el.style.height = o.h + 'px';
    textStyles(el, o, cx);
    el.appendChild(textBlock(o, cx, opts || {}));
    return el;
  }
  /* Rebuilds one region from the current document (editor refresh). */
  function hfElFor(doc, slide, key, opts) {
    const o = RPE.hf && RPE.hf.view(doc, slide, key, true);
    return o ? hfEl(o, context(doc), opts) : null;
  }

  /* Slide number: value = start number + position; style/geometry from doc.hf (defaults = the legacy bottom-right 12pt muted). */
  function numberEl(doc, index, cx) {
    const H = RPE.hf, st = H ? H.numberStyle(doc) : { fontSize: 12, align: 'right', color: 'muted' }, g = H ? H.numberGeom(doc) : null;
    const n = document.createElement('div'); n.className = 'slide__num';
    n.textContent = H ? H.numberValue(doc, index) : index + 1;
    const s = n.style;
    if (g) { s.left = g.x + 'px'; s.top = g.y + 'px'; s.width = g.w + 'px'; s.height = g.h + 'px'; s.right = 'auto'; s.bottom = 'auto'; }
    s.display = 'flex'; s.alignItems = 'flex-end'; s.justifyContent = st.align === 'left' ? 'flex-start' : st.align === 'center' ? 'center' : 'flex-end';
    s.fontSize = st.fontSize + 'pt'; s.color = cx.col(st.color) || cx.th.muted;
    if (st.font) s.fontFamily = T.cssFont(st.font);
    if (st.bold) s.fontWeight = 700; if (st.italic) s.fontStyle = 'italic'; if (st.underline) s.textDecoration = 'underline';
    return n;
  }

  /* Build a full slide at logical size. */
  function slideEl(slide, opts) {
    opts = opts || {};
    const doc = opts.doc || RPE.store.doc, cx = opts.cx || context(doc);
    const slideBg = slide.bg || cx.th.bg;
    const childOpts = Object.assign({}, opts, { slideBg });
    const el = document.createElement('div');
    el.className = 'slide slide--' + (opts.mode || 'edit');
    el.dataset.sid = slide.id;
    el.style.width = doc.size.w + 'px'; el.style.height = doc.size.h + 'px';
    el.style.background = slideBg; el.style.color = cx.th.text;
    el.style.fontFamily = T.cssFont(cx.ty.body);
    el.appendChild(decor(cx.th, slide.layout, doc.size));
    /* header/footer sit behind the slide objects; in the editor an empty editable region still gets a (invisible) double-click target */
    if (RPE.hf) RPE.hf.KEYS.forEach((k) => {
      const o = RPE.hf.view(doc, slide, k, opts.mode === 'edit');
      if (o) el.appendChild(hfEl(o, cx, childOpts));
    });
    slide.objects.forEach((o) => el.appendChild(objectEl(o, cx, childOpts)));
    if (opts.index != null && (RPE.hf ? RPE.hf.numberOn(doc, slide) : slide.layout !== 'title')) {
      el.appendChild(numberEl(doc, opts.index, cx));
    }
    if (opts.mode === 'edit') { const ov = document.createElement('div'); ov.className = 'slide__overlay-grid'; el.appendChild(ov); }
    return el;
  }

  /* Wrap a slide in a frame sized to the scaled slide. */
  function mountScaled(slide, scale, opts) {
    const doc = (opts && opts.doc) || RPE.store.doc;
    const frame = document.createElement('div'); frame.className = 'slide-frame';
    frame.style.width = (doc.size.w * scale) + 'px'; frame.style.height = (doc.size.h * scale) + 'px';
    const s = slideEl(slide, opts); s.style.transform = `scale(${scale})`; frame.appendChild(s);
    return frame;
  }

  /* Off-screen measurement used by Research Checks. Returns [{id, over}] for text objects whose content exceeds their box. */
  function measureOverflow(doc, slide) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-20000px;top:0;visibility:hidden;pointer-events:none';
    const s = slideEl(slide, { doc, mode: 'measure' }); host.appendChild(s); document.body.appendChild(host);
    const out = [];
    slide.objects.forEach((o) => {
      if (o.type !== 'text' && o.type !== 'shape') return;
      const el = s.querySelector(`[data-id="${o.id}"]`), t = el && el.querySelector('.obj__text');
      if (!t || !t.textContent.trim()) return;
      const cs = getComputedStyle(el), padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      const need = t.scrollHeight + padV, over = need - o.h;
      if (over > 3) out.push({ id: o.id, over: Math.round(over) });
    });
    host.remove();
    return out;
  }

  RPE.renderer = { context, objectEl, hfEl, hfElFor, slideEl, mountScaled, measureOverflow, setGeom, shapeGfx, lineGfx, shapePath, esc, tableEl, updateParaStruts, updateParaMarkers, applyImageAdj, updateImageAdj, buildImageFilter };
})(window.RPE = window.RPE || {});
